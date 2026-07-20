#include "cfd_solver_3d_cuda.hpp"
#include <cuda_runtime.h>
#include "ImmersedBoundary.hpp"

extern void remap_1d_to_3d(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d,
    CFDSolver3D& solver_3d, double x_expl, double y_expl, double z_expl, double R_remap);
#include <device_launch_parameters.h>
#include <iostream>

#define CHECK_CUDA(call) { \
    cudaError_t err = call; \
    if (err != cudaSuccess) { \
        std::cerr << "CUDA Error: " << cudaGetErrorString(err) << " at " << __FILE__ << ":" << __LINE__ << std::endl; \
    } \
}

// Global constants for GPU
__constant__ double d_gamma;
__constant__ double d_cellSize;
__constant__ int d_nx, d_ny, d_nz;
__constant__ int d_ntx, d_nty, d_ntz;
__constant__ bool d_useAUSM;
__constant__ double d_xmin, d_ymin, d_zmin;
__constant__ int d_bcXmin, d_bcXmax, d_bcYmin, d_bcYmax, d_bcZmin, d_bcZmax;
__constant__ int d_spatialOrder;
__constant__ int d_temporalOrder;
__constant__ double d_ambient_rho;
__constant__ double d_ambient_p;
__constant__ MultiMat::JWLParams d_products;
__constant__ MultiMat::JWLParams d_unreacted;
__constant__ double d_det_vel;
__constant__ double d_detonation_energy;
__constant__ double d_detX;
__constant__ double d_detY;
__constant__ double d_detZ;

struct GPUTriangle {
    float3 v0, v1, v2;
    float3 normal;
};

__device__ void atomicStore16(uint16_t* address, uint16_t val) {
    size_t address_val = reinterpret_cast<size_t>(address);
    bool is_high = (address_val & 2) != 0;
    uint32_t* address32 = reinterpret_cast<uint32_t*>(address_val & ~2);
    
    uint32_t old_val = *address32;
    uint32_t assumed;
    do {
        assumed = old_val;
        uint32_t new_val;
        if (is_high) {
            new_val = (assumed & 0x0000FFFF) | (static_cast<uint32_t>(val) << 16);
        } else {
            new_val = (assumed & 0xFFFF0000) | static_cast<uint32_t>(val);
        }
        old_val = atomicCAS(address32, assumed, new_val);
    } while (assumed != old_val);
}

__device__ float dist_to_segment_gpu(float3 pt, float3 a, float3 b) {
    float3 ab = { b.x - a.x, b.y - a.y, b.z - a.z };
    float3 ap = { pt.x - a.x, pt.y - a.y, pt.z - a.z };
    float ab2 = ab.x*ab.x + ab.y*ab.y + ab.z*ab.z;
    if (ab2 < 1e-8f) return sqrtf(ap.x*ap.x + ap.y*ap.y + ap.z*ap.z);
    float t = (ap.x*ab.x + ap.y*ab.y + ap.z*ab.z) / ab2;
    t = (t < 0.0f) ? 0.0f : ((t > 1.0f) ? 1.0f : t);
    float3 closest = { a.x + t * ab.x, a.y + t * ab.y, a.z + t * ab.z };
    float3 diff = { pt.x - closest.x, pt.y - closest.y, pt.z - closest.z };
    return sqrtf(diff.x*diff.x + diff.y*diff.y + diff.z*diff.z);
}

__device__ bool is_cell_intersected_gpu(
    float3 P, float3 V0, float3 V1, float3 V2, float3 N, float threshold
) {
    float d_perp = (P.x - V0.x)*N.x + (P.y - V0.y)*N.y + (P.z - V0.z)*N.z;
    float abs_d = (d_perp < 0.0f) ? -d_perp : d_perp;
    if (abs_d > threshold) return false;

    float3 P_proj = { P.x - d_perp * N.x, P.y - d_perp * N.y, P.z - d_perp * N.z };

    float3 e0 = { V1.x - V0.x, V1.y - V0.y, V1.z - V0.z };
    float3 e1 = { V2.x - V0.x, V2.y - V0.y, V2.z - V0.z };
    float3 v2_p = { P_proj.x - V0.x, P_proj.y - V0.y, P_proj.z - V0.z };

    float dot00 = e0.x*e0.x + e0.y*e0.y + e0.z*e0.z;
    float dot01 = e0.x*e1.x + e0.y*e1.y + e0.z*e1.z;
    float dot02 = e0.x*v2_p.x + e0.y*v2_p.y + e0.z*v2_p.z;
    float dot11 = e1.x*e1.x + e1.y*e1.y + e1.z*e1.z;
    float dot12 = e1.x*v2_p.x + e1.y*v2_p.y + e1.z*v2_p.z;

    float denom = dot00 * dot11 - dot01 * dot01;
    float abs_denom = (denom < 0.0f) ? -denom : denom;
    if (abs_denom > 1e-8f) {
        float u = (dot11 * dot02 - dot01 * dot12) / denom;
        float v = (dot00 * dot12 - dot01 * dot02) / denom;
        if (u >= -0.05f && v >= -0.05f && u + v <= 1.05f) {
            return true;
        }
    }

    if (dist_to_segment_gpu(P, V0, V1) <= threshold) return true;
    if (dist_to_segment_gpu(P, V1, V2) <= threshold) return true;
    if (dist_to_segment_gpu(P, V2, V0) <= threshold) return true;

    return false;
}


__global__ void voxelize_triangles_kernel(
    const GPUTriangle* triangles,
    int num_triangles,
    GeometryPayload* d_geom_cells,
    int nx, int ny, int nz,
    float cellSize, float xmin, float ymin, float zmin,
    float threshold,
    int ntx, int nty
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= num_triangles) return;

    GPUTriangle tri = triangles[i];
    float min_x = fminf(tri.v0.x, fminf(tri.v1.x, tri.v2.x));
    float max_x = fmaxf(tri.v0.x, fmaxf(tri.v1.x, tri.v2.x));
    float min_y = fminf(tri.v0.y, fminf(tri.v1.y, tri.v2.y));
    float max_y = fmaxf(tri.v0.y, fmaxf(tri.v1.y, tri.v2.y));
    float min_z = fminf(tri.v0.z, fminf(tri.v1.z, tri.v2.z));
    float max_z = fmaxf(tri.v0.z, fmaxf(tri.v1.z, tri.v2.z));

    int gx_min = (int)fmaxf(0.0f, floorf((min_x - threshold - xmin) / cellSize));
    int gx_max = (int)fminf((float)(nx - 1), floorf((max_x + threshold - xmin) / cellSize));
    int gy_min = (int)fmaxf(0.0f, floorf((min_y - threshold - ymin) / cellSize));
    int gy_max = (int)fminf((float)(ny - 1), floorf((max_y + threshold - ymin) / cellSize));
    int gz_min = (int)fmaxf(0.0f, floorf((min_z - threshold - zmin) / cellSize));
    int gz_max = (int)fminf((float)(nz - 1), floorf((max_z + threshold - zmin) / cellSize));

    float3 N_unit = tri.normal;
    float nlen2 = sqrtf(N_unit.x*N_unit.x + N_unit.y*N_unit.y + N_unit.z*N_unit.z);
    if (nlen2 > 1e-6f) {
        N_unit.x /= nlen2; N_unit.y /= nlen2; N_unit.z /= nlen2;
    } else {
        N_unit = {1.0f, 0.0f, 0.0f};
    }
    GeometryPayload payload = pack_geometry_payload(true, N_unit.x, N_unit.y, N_unit.z);

    for (int gz = gz_min; gz <= gz_max; ++gz) {
        float z_c = zmin + (gz + 0.5f) * cellSize;
        for (int gy = gy_min; gy <= gy_max; ++gy) {
            float y_c = ymin + (gy + 0.5f) * cellSize;
            for (int gx = gx_min; gx <= gx_max; ++gx) {
                float x_c = xmin + (gx + 0.5f) * cellSize;
                float3 P = {x_c, y_c, z_c};
                if (is_cell_intersected_gpu(P, tri.v0, tri.v1, tri.v2, N_unit, threshold)) {
                    int tx = gx / TILE_SIZE_3D;
                    int ty = gy / TILE_SIZE_3D;
                    int tz = gz / TILE_SIZE_3D;
                    int t_idx = tx + ty * ntx + tz * ntx * nty;
                    int cx = gx % TILE_SIZE_3D;
                    int cy = gy % TILE_SIZE_3D;
                    int cz = gz % TILE_SIZE_3D;
                    int idx = cx + cy * TILE_SIZE_3D + cz * TILE_SIZE_3D * TILE_SIZE_3D;
                    
                    int linear_idx = t_idx * TILE_CELLS_3D + idx;
                    d_geom_cells[linear_idx] = payload;
                }
            }
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) initialize_ambient_kernel(PrimitiveTile3D<RealType, IsMultiMaterial>* states, ConservativeTile3D<RealType, IsMultiMaterial>* U,
                                           RealType amb_rho, RealType amb_p, RealType gamma, int total_tiles) {
    int t_idx = blockIdx.x;
    if (t_idx >= total_tiles) return;
    int c_idx = threadIdx.x;

    states[t_idx].rho[c_idx] = amb_rho;
    states[t_idx].ux[c_idx] = 0;
    states[t_idx].uy[c_idx] = 0;
    states[t_idx].uz[c_idx] = 0;
    states[t_idx].p[c_idx] = amb_p;
    
    RealType E;
    if constexpr (IsMultiMaterial) {
        E = (RealType)MultiMat::getMixtureEnergy((double)amb_p, (double)amb_rho, 0.0, 0.0, 0.0, 0.0, (double)gamma, d_products, d_unreacted);
    } else {
        E = amb_p / (gamma - (RealType)1.0);
    }
    
    states[t_idx].floor_status[c_idx] = 0;
    states[t_idx].peak_overpressure[c_idx] = 0.0;
    states[t_idx].running_impulse[c_idx] = 0.0;
    states[t_idx].peak_impulse[c_idx] = 0.0;

    U[t_idx].rho[c_idx] = amb_rho;
    U[t_idx].rhoux[c_idx] = 0;
    U[t_idx].rhouy[c_idx] = 0;
    U[t_idx].rhouz[c_idx] = 0;
    U[t_idx].E[c_idx] = E;

    if constexpr (IsMultiMaterial) {
        states[t_idx].alpha1[c_idx] = 0.0;
        states[t_idx].alpha2[c_idx] = 0.0;
        states[t_idx].arho1[c_idx] = 0.0;
        states[t_idx].arho2[c_idx] = 0.0;

        U[t_idx].alpha1[c_idx] = 0.0;
        U[t_idx].alpha2[c_idx] = 0.0;
        U[t_idx].arho1[c_idx] = 0.0;
        U[t_idx].arho2[c_idx] = 0.0;
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) commit_states_kernel(PrimitiveTile3D<RealType, IsMultiMaterial>* states, ConservativeTile3D<RealType, IsMultiMaterial>* U, const int* active_tile_indices) {
    int t_idx = active_tile_indices[blockIdx.x];

    int c_idx = threadIdx.x;
    const auto& s = states[t_idx];
    auto& u = U[t_idx];

    u.rho[c_idx] = s.rho[c_idx];
    u.rhoux[c_idx] = s.rho[c_idx] * s.ux[c_idx];
    u.rhouy[c_idx] = s.rho[c_idx] * s.uy[c_idx];
    u.rhouz[c_idx] = s.rho[c_idx] * s.uz[c_idx];
    RealType ke = (RealType)0.5 * s.rho[c_idx] * (s.ux[c_idx]*s.ux[c_idx] + s.uy[c_idx]*s.uy[c_idx] + s.uz[c_idx]*s.uz[c_idx]);
    RealType total_E;
    if constexpr (IsMultiMaterial) {
        total_E = (RealType)MultiMat::getMixtureEnergy((double)s.p[c_idx], (double)s.rho[c_idx], (double)s.alpha1[c_idx], (double)s.alpha2[c_idx], (double)s.arho1[c_idx], (double)s.arho2[c_idx], d_gamma, d_products, d_unreacted) + ke;
    } else {
        total_E = s.p[c_idx] / (d_gamma - (RealType)1.0) + ke;
    }
    u.E[c_idx] = total_E;

    if constexpr (IsMultiMaterial) {
        u.alpha1[c_idx] = s.alpha1[c_idx];
        u.alpha2[c_idx] = s.alpha2[c_idx];
        u.arho1[c_idx] = s.arho1[c_idx];
        u.arho2[c_idx] = s.arho2[c_idx];
    }
}

template <typename RealType>
struct GPUCellStateT {
    RealType rho, ux, uy, uz, p, E, alpha1, alpha2, arho1, arho2;
    RealType peak_overpressure, peak_impulse;
};

__device__ inline bool is_solid_cell_gpu(const GeometryTile3D* geom, int i, int j, int k) {
    if (!geom) return false;
    int clamped_i = i < 0 ? 0 : (i >= d_nx ? d_nx - 1 : i);
    int clamped_j = j < 0 ? 0 : (j >= d_ny ? d_ny - 1 : j);
    int clamped_k = k < 0 ? 0 : (k >= d_nz ? d_nz - 1 : k);
    int tx = clamped_i >> 3;
    int ty = clamped_j >> 3;
    int tz = clamped_k >> 3;
    int t_idx = tx + ty * d_ntx + tz * d_ntx * d_nty;
    int lx = clamped_i & 7;
    int ly = clamped_j & 7;
    int lz = clamped_k & 7;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;
    
    return geom[t_idx].cells[c_idx].is_boundary;
}

template <typename RealType, bool IsMultiMaterial>
__device__ __forceinline__ GPUCellStateT<RealType> sample_gpu_raw(const PrimitiveTile3D<RealType, IsMultiMaterial>* states, int gx, int gy, int gz) {
    bool rx = false, ry = false, rz = false;

    if (gx < 0) {
        if (d_bcXmin == 0) { gx = -gx - 1; rx = true; }
        else { gx = 0; }
    } else if (gx >= d_nx) {
        if (d_bcXmax == 0) { gx = 2 * d_nx - 1 - gx; rx = true; }
        else { gx = d_nx - 1; }
    }

    if (gy < 0) {
        if (d_bcYmin == 0) { gy = -gy - 1; ry = true; }
        else { gy = 0; }
    } else if (gy >= d_ny) {
        if (d_bcYmax == 0) { gy = 2 * d_ny - 1 - gy; ry = true; }
        else { gy = d_ny - 1; }
    }

    if (gz < 0) {
        if (d_bcZmin == 0) { gz = -gz - 1; rz = true; }
        else { gz = 0; }
    } else if (gz >= d_nz) {
        if (d_bcZmax == 0) { gz = 2 * d_nz - 1 - gz; rz = true; }
        else { gz = d_nz - 1; }
    }

    int tx = gx >> 3;
    int ty = gy >> 3;
    int tz = gz >> 3;
    int t_idx = tx + ty * d_ntx + tz * d_ntx * d_nty;

    int lx = gx & 7;
    int ly = gy & 7;
    int lz = gz & 7;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    const auto& tile = states[t_idx];
    GPUCellStateT<RealType> s;
    s.rho = tile.rho[c_idx];
    s.ux = rx ? -tile.ux[c_idx] : tile.ux[c_idx];
    s.uy = ry ? -tile.uy[c_idx] : tile.uy[c_idx];
    s.uz = rz ? -tile.uz[c_idx] : tile.uz[c_idx];
    s.p = tile.p[c_idx];
    s.E = 0.0;
    s.peak_overpressure = tile.peak_overpressure[c_idx];
    s.peak_impulse = tile.peak_impulse[c_idx];
    if constexpr (IsMultiMaterial) {
        s.alpha1 = tile.alpha1[c_idx];
        s.alpha2 = tile.alpha2[c_idx];
        s.arho1 = tile.arho1[c_idx];
        s.arho2 = tile.arho2[c_idx];
    } else {
        s.alpha1 = 0.0; s.alpha2 = 0.0; s.arho1 = 0.0; s.arho2 = 0.0;
    }
    return s;
}

__device__ inline bool get_solid_normal_gpu(const GeometryTile3D* geom, int i, int j, int k, float& nx_b, float& ny_b, float& nz_b) {
    if (!geom) return false;
    int ci = i < 0 ? 0 : (i >= d_nx ? d_nx - 1 : i);
    int cj = j < 0 ? 0 : (j >= d_ny ? d_ny - 1 : j);
    int ck = k < 0 ? 0 : (k >= d_nz ? d_nz - 1 : k);
    int tx = ci >> 3;
    int ty = cj >> 3;
    int tz = ck >> 3;
    int t_idx = tx + ty * d_ntx + tz * d_ntx * d_nty;
    int lx = ci & 7;
    int ly = cj & 7;
    int lz = ck & 7;
    int c_idx = lx + ly * 8 + lz * 64;
    bool is_b = false;
    unpack_geometry_payload(geom[t_idx].cells[c_idx], is_b, nx_b, ny_b, nz_b);
    return is_b;
}

template <typename RealType, bool IsMultiMaterial>
__device__ void getRusanovFluxGPU(const GPUCellStateT<RealType>& sL, const GPUCellStateT<RealType>& sR, RealType* flux, int dir, RealType gamma) {
    RealType unL = (dir == 0) ? sL.ux : (dir == 1 ? sL.uy : sL.uz);
    RealType unR = (dir == 0) ? sR.ux : (dir == 1 ? sR.uy : sR.uz);

    RealType fL[9], fR[9];
    fL[0] = sL.rho * unL;
    fL[1] = sL.rho * unL * sL.ux + (dir == 0 ? sL.p : (RealType)0.0);
    fL[2] = sL.rho * unL * sL.uy + (dir == 1 ? sL.p : (RealType)0.0);
    fL[3] = sL.rho * unL * sL.uz + (dir == 2 ? sL.p : (RealType)0.0);
    fL[4] = unL * (sL.E + sL.p);

    fR[0] = sR.rho * unR;
    fR[1] = sR.rho * unR * sR.ux + (dir == 0 ? sR.p : (RealType)0.0);
    fR[2] = sR.rho * unR * sR.uy + (dir == 1 ? sR.p : (RealType)0.0);
    fR[3] = sR.rho * unR * sR.uz + (dir == 2 ? sR.p : (RealType)0.0);
    fR[4] = unR * (sR.E + sR.p);

    if constexpr (IsMultiMaterial) {
        fL[5] = sL.alpha1 * unL; fL[6] = sL.alpha2 * unL;
        fL[7] = sL.arho1 * unL;  fL[8] = sL.arho2 * unL;

        fR[5] = sR.alpha1 * unR; fR[6] = sR.alpha2 * unR;
        fR[7] = sR.arho1 * unR;  fR[8] = sR.arho2 * unR;
    }

    double cL, cR;
    if constexpr (IsMultiMaterial) {
        cL = MultiMat::getMixtureSoundSpeed((double)sL.p, (double)sL.rho, (double)sL.alpha1, (double)sL.alpha2, (double)sL.arho1, (double)sL.arho2, (double)gamma, d_products, d_unreacted);
        cR = MultiMat::getMixtureSoundSpeed((double)sR.p, (double)sR.rho, (double)sR.alpha1, (double)sR.alpha2, (double)sR.arho1, (double)sR.arho2, (double)gamma, d_products, d_unreacted);
    } else {
        cL = sqrt((double)gamma * (double)sL.p / max((double)1e-6, (double)sL.rho));
        cR = sqrt((double)gamma * (double)sR.p / max((double)1e-6, (double)sR.rho));
    }
    double s_max = fmax(fabs((double)unL) + cL, fabs((double)unR) + cR);

    RealType UL[9] = {sL.rho, sL.rho*sL.ux, sL.rho*sL.uy, sL.rho*sL.uz, sL.E};
    RealType UR[9] = {sR.rho, sR.rho*sR.ux, sR.rho*sR.uy, sR.rho*sR.uz, sR.E};
    if constexpr (IsMultiMaterial) {
        UL[5] = sL.alpha1; UL[6] = sL.alpha2; UL[7] = sL.arho1; UL[8] = sL.arho2;
        UR[5] = sR.alpha1; UR[6] = sR.alpha2; UR[7] = sR.arho1; UR[8] = sR.arho2;
    }

    int n_eq = IsMultiMaterial ? 9 : 5;
    for(int i=0; i<n_eq; ++i) {
        flux[i] = (RealType)0.5 * (fL[i] + fR[i]) - (RealType)0.5 * s_max * (UR[i] - UL[i]);
    }
    flux[9] = (RealType)0.5 * (unL + unR);
}

template <typename RealType, bool IsMultiMaterial>
__device__ void getAUSMPlusFluxGPU(const GPUCellStateT<RealType>& sL, const GPUCellStateT<RealType>& sR, RealType* flux, int dir, RealType gamma) {
    RealType aL, aR;
    if constexpr (IsMultiMaterial) {
        aL = (RealType)MultiMat::getMixtureSoundSpeed((double)sL.p, (double)sL.rho, (double)sL.alpha1, (double)sL.alpha2, (double)sL.arho1, (double)sL.arho2, (double)gamma, d_products, d_unreacted);
        aR = (RealType)MultiMat::getMixtureSoundSpeed((double)sR.p, (double)sR.rho, (double)sR.alpha1, (double)sR.alpha2, (double)sR.arho1, (double)sR.arho2, (double)gamma, d_products, d_unreacted);
    } else {
        aL = sqrt(gamma * sL.p / max((RealType)1e-6, sL.rho));
        aR = sqrt(gamma * sR.p / max((RealType)1e-6, sR.rho));
    }
    RealType a_half = (RealType)0.5 * (aL + aR);

    RealType uL = (dir == 0) ? sL.ux : (dir == 1 ? sL.uy : sL.uz);
    RealType uR = (dir == 0) ? sR.ux : (dir == 1 ? sR.uy : sR.uz);
    RealType ML = uL / a_half;
    RealType MR = uR / a_half;

    RealType alpha = (RealType)(3.0 / 16.0);
    RealType beta = (RealType)(1.0 / 8.0);

    RealType M_plus_L;
    if (fabs(ML) <= (RealType)1.0) {
        RealType term = (RealType)0.25 * (ML + (RealType)1.0) * (ML + (RealType)1.0);
        M_plus_L = term + beta * (ML * ML - (RealType)1.0) * (ML * ML - (RealType)1.0);
    } else {
        M_plus_L = (RealType)0.5 * (ML + fabs(ML));
    }

    RealType M_minus_R;
    if (fabs(MR) <= (RealType)1.0) {
        RealType term = (RealType)-0.25 * (MR - (RealType)1.0) * (MR - (RealType)1.0);
        M_minus_R = term - beta * (MR * MR - (RealType)1.0) * (MR * MR - (RealType)1.0);
    } else {
        M_minus_R = (RealType)0.5 * (MR - fabs(MR));
    }

    RealType P_plus_L;
    if (fabs(ML) <= (RealType)1.0) {
        RealType term = (RealType)0.25 * (ML + (RealType)1.0) * (ML + (RealType)1.0) * ((RealType)2.0 - ML);
        P_plus_L = term + alpha * ML * (ML * ML - (RealType)1.0) * (ML * ML - (RealType)1.0);
    } else {
        P_plus_L = (ML >= (RealType)0.0) ? (RealType)1.0 : (RealType)0.0;
    }

    RealType P_minus_R;
    if (fabs(MR) <= (RealType)1.0) {
        RealType term = (RealType)0.25 * (MR - (RealType)1.0) * (MR - (RealType)1.0) * ((RealType)2.0 + MR);
        P_minus_R = term - alpha * MR * (MR * MR - (RealType)1.0) * (MR * MR - (RealType)1.0);
    } else {
        P_minus_R = (MR < (RealType)0.0) ? (RealType)1.0 : (RealType)0.0;
    }

    RealType M_half_unmod = M_plus_L + M_minus_R;
    RealType p_half_unmod = P_plus_L * sL.p + P_minus_R * sR.p;
    
    // AUSM+-up stabilization terms to prevent carbuncle/cube artifacts
    RealType Kp = (RealType)0.25;
    RealType Ku = (RealType)0.75;
    RealType rho_half = (RealType)0.5 * (sL.rho + sR.rho);
    
    RealType M_half = M_half_unmod - Kp * (sR.p - sL.p) / max((RealType)1e-6, rho_half * a_half * a_half);
    RealType p_half = p_half_unmod - Ku * P_plus_L * P_minus_R * rho_half * a_half * (uR - uL);

    if (M_half >= (RealType)0.0) {
        flux[0] = M_half * a_half * sL.rho;
        flux[1] = M_half * a_half * sL.rho * sL.ux + (dir == 0 ? p_half : (RealType)0.0);
        flux[2] = M_half * a_half * sL.rho * sL.uy + (dir == 1 ? p_half : (RealType)0.0);
        flux[3] = M_half * a_half * sL.rho * sL.uz + (dir == 2 ? p_half : (RealType)0.0);
        flux[4] = M_half * a_half * (sL.E + sL.p);
        if constexpr (IsMultiMaterial) {
            flux[5] = M_half * a_half * sL.alpha1;
            flux[6] = M_half * a_half * sL.alpha2;
            flux[7] = M_half * a_half * sL.arho1;
            flux[8] = M_half * a_half * sL.arho2;
        }
    } else {
        flux[0] = M_half * a_half * sR.rho;
        flux[1] = M_half * a_half * sR.rho * sR.ux + (dir == 0 ? p_half : (RealType)0.0);
        flux[2] = M_half * a_half * sR.rho * sR.uy + (dir == 1 ? p_half : (RealType)0.0);
        flux[3] = M_half * a_half * sR.rho * sR.uz + (dir == 2 ? p_half : (RealType)0.0);
        flux[4] = M_half * a_half * (sR.E + sR.p);
        if constexpr (IsMultiMaterial) {
            flux[5] = M_half * a_half * sR.alpha1;
            flux[6] = M_half * a_half * sR.alpha2;
            flux[7] = M_half * a_half * sR.arho1;
            flux[8] = M_half * a_half * sR.arho2;
        }
    }
    flux[9] = M_half * a_half;
}

template <typename RealType>
__device__ RealType minmod_gpu(RealType a, RealType b) {
    if (a * b <= (RealType)0.0) return 0.0;
    return (fabs(a) < fabs(b)) ? a : b;
}

template <typename RealType>
__device__ RealType weno3_gpu(RealType vM1, RealType v0, RealType vP1) {
    double d0 = (double)v0 - (double)vM1;
    double d1 = (double)vP1 - (double)v0;
    
    double beta0 = d0 * d0;
    double beta1 = d1 * d1;
    
    double eps = 1e-6;
    double alpha0 = (1.0 / 3.0) / ((eps + beta0) * (eps + beta0));
    double alpha1 = (2.0 / 3.0) / ((eps + beta1) * (eps + beta1));
    
    double sum_alpha = alpha0 + alpha1;
    double w0, w1;
    if (sum_alpha < 1e-300) {
        w0 = 1.0 / 3.0;
        w1 = 2.0 / 3.0;
    } else {
        w0 = alpha0 / sum_alpha;
        w1 = alpha1 / sum_alpha;
    }
    
    double p0 = (double)v0 + 0.5 * d0;
    double p1 = (double)v0 + 0.5 * d1;
    return (RealType)(w0 * p0 + w1 * p1);
}

// Why this works:
// By projecting the Image Point from the deep solid target, but restricting the IDW sampling strictly to the verified fluid neighborhood of the querying cell, we generate a perfectly continuous, anti-aliased gradient for the WENO3 stencil. This eliminates all lumps and carbuncles. Furthermore, this topology mathematically guarantees that the ray cannot pierce a 1-cell thick wall or sample the wrong side of an urban gap, providing indestructible geometric stability.
// Specifying the reconstruction direction (dir) decouples normal reflection components at sharp convex corners, eliminating artificial stagnation pressure artifacts on the GPU.
template <typename RealType, bool IsMultiMaterial>
__device__ __forceinline__ GPUCellStateT<RealType> sample_gpu(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    const GeometryTile3D* geom,
    int target_x, int target_y, int target_z,
    int qx, int qy, int qz,
    int dir,
    bool is_near_boundary
) {
    bool is_solid = false;
    if (is_near_boundary && target_x >= 0 && target_x < d_nx && target_y >= 0 && target_y < d_ny && target_z >= 0 && target_z < d_nz) {
        is_solid = is_solid_cell_gpu(geom, target_x, target_y, target_z);
    }
    
    if (!is_solid) {
        return sample_gpu_raw<RealType, IsMultiMaterial>(states, target_x, target_y, target_z);
    }
    
    int sign_x = (target_x > qx) - (target_x < qx);
    int sign_y = (target_y > qy) - (target_y < qy);
    int sign_z = (target_z > qz) - (target_z < qz);
    
    int bx = qx + sign_x;
    int by = qy + sign_y;
    int bz = qz + sign_z;
    
    float nx = 0.0f, ny = 0.0f, nz = 0.0f;
    get_solid_normal_gpu(geom, bx, by, bz, nx, ny, nz);
    
    // Auto-Orient the True Normal first:
    float dx_f = (float)(qx - bx);
    float dy_f = (float)(qy - by);
    float dz_f = (float)(qz - bz);
    float dot_d = nx * dx_f + ny * dy_f + nz * dz_f;
    if (dot_d < 0.0f) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
    }
    
    // Keep true oriented normal for image point projection and visibility check:
    float nx_true = nx;
    float ny_true = ny;
    float nz_true = nz;
    float n_len_true = sqrt(nx_true*nx_true + ny_true*ny_true + nz_true*nz_true);
    if (n_len_true > 1e-3f) {
        nx_true /= n_len_true;
        ny_true /= n_len_true;
        nz_true /= n_len_true;
    } else {
        float dx_dir = (float)(qx - target_x);
        float dy_dir = (float)(qy - target_y);
        float dz_dir = (float)(qz - target_z);
        float len_dir = sqrt(dx_dir*dx_dir + dy_dir*dy_dir + dz_dir*dz_dir);
        if (len_dir > 1e-3f) {
            nx_true = dx_dir / len_dir;
            ny_true = dy_dir / len_dir;
            nz_true = dz_dir / len_dir;
        }
    }

    // Option B: Decouple boundary normal components at domain boundaries
    bool decoupled = false;
    if (bx == 0 || bx == d_nx - 1) { nx_true = 0.0f; decoupled = true; }
    if (by == 0 || by == d_ny - 1) { ny_true = 0.0f; decoupled = true; }
    if (bz == 0 || bz == d_nz - 1) { nz_true = 0.0f; decoupled = true; }
    if (decoupled) {
        float n_len_dec = sqrt(nx_true*nx_true + ny_true*ny_true + nz_true*nz_true);
        if (n_len_dec > 1e-3f) {
            nx_true /= n_len_dec;
            ny_true /= n_len_dec;
            nz_true /= n_len_dec;
        }
    }
    
    // Decouple normal for velocity reflection:
    float nx_dec = nx_true;
    float ny_dec = ny_true;
    float nz_dec = nz_true;
    if (dir == 0) {
        ny_dec = 0.0f;
        nz_dec = 0.0f;
    } else if (dir == 1) {
        nx_dec = 0.0f;
        nz_dec = 0.0f;
    } else if (dir == 2) {
        nx_dec = 0.0f;
        ny_dec = 0.0f;
    }
    float n_len_dec = sqrt(nx_dec*nx_dec + ny_dec*ny_dec + nz_dec*nz_dec);
    if (n_len_dec > 1e-3f) {
        nx_dec /= n_len_dec;
        ny_dec /= n_len_dec;
        nz_dec /= n_len_dec;
    } else {
        float sign_dir = 0.0f;
        if (dir == 0) sign_dir = (qx >= target_x) ? 1.0f : -1.0f;
        else if (dir == 1) sign_dir = (qy >= target_y) ? 1.0f : -1.0f;
        else if (dir == 2) sign_dir = (qz >= target_z) ? 1.0f : -1.0f;
        nx_dec = (dir == 0) ? sign_dir : 0.0f;
        ny_dec = (dir == 1) ? sign_dir : 0.0f;
        nz_dec = (dir == 2) ? sign_dir : 0.0f;
    }

    // Topological Corner Detection:
    // Count solid cells in 3x3x3 neighborhood of the surface boundary cell bx, by, bz
    int solid_count = 0;
    for (int sz = -1; sz <= 1; ++sz) {
        int nz_val = bz + sz;
        for (int sy = -1; sy <= 1; ++sy) {
            int ny_val = by + sy;
            for (int sx = -1; sx <= 1; ++sx) {
                int nx_val = bx + sx;
                if (nx_val >= 0 && nx_val < d_nx && ny_val >= 0 && ny_val < d_ny && nz_val >= 0 && nz_val < d_nz) {
                    if (is_solid_cell_gpu(geom, nx_val, ny_val, nz_val)) {
                        solid_count++;
                    }
                } else {
                    solid_count++; // Treat out of bounds as solid
                }
            }
        }
    }
    bool is_convex_corner = (solid_count <= 14);

    // Adaptive normal selection for projection (sampling):
    // Always use the true normal for projecting the sample point into the fluid
    float nx_proj = nx_true;
    float ny_proj = ny_true;
    float nz_proj = nz_true;
    
    // Adaptive projection distance:
    // 0.5 for corners to minimize extrapolation error near the singularity, 1.5 for flat/diagonal walls
    float proj_dist = is_convex_corner ? 0.5f : 1.5f;
    
    // Project along the true normal:
    float p_img_x = (float)target_x + nx_proj * proj_dist;
    float p_img_y = (float)target_y + ny_proj * proj_dist;
    float p_img_z = (float)target_z + nz_proj * proj_dist;
    
    // Query-Centered IDW Gathering (Thin-Wall Fix #2 & Gap Fix)
    float sum_rho = 0.0f;
    float sum_ux = 0.0f;
    float sum_uy = 0.0f;
    float sum_uz = 0.0f;
    float sum_p = 0.0f;
    float sum_alpha1 = 0.0f;
    float sum_alpha2 = 0.0f;
    float sum_arho1 = 0.0f;
    float sum_arho2 = 0.0f;
    float W_total = 0.0f;
    
    for (int k = -1; k <= 1; ++k) {
        int nz_val = qz + k;
        if (nz_val < 0 || nz_val >= d_nz) continue;
        for (int j = -1; j <= 1; ++j) {
            int ny_val = qy + j;
            if (ny_val < 0 || ny_val >= d_ny) continue;
            for (int i = -1; i <= 1; ++i) {
                int nx_val = qx + i;
                if (nx_val < 0 || nx_val >= d_nx) continue;
                
                if (is_solid_cell_gpu(geom, nx_val, ny_val, nz_val)) continue;
                
                // Visibility Half-Space Clipping using the decoupled normal to prevent gathering from behind walls
                float dx_plane = (float)nx_val - (float)target_x;
                float dy_plane = (float)ny_val - (float)target_y;
                float dz_plane = (float)nz_val - (float)target_z;
                float dot_plane = dx_plane * nx_dec + dy_plane * ny_dec + dz_plane * nz_dec;
                if (dot_plane <= 0.0f) continue;

                float dx_n = (float)nx_val - p_img_x;
                float dy_n = (float)ny_val - p_img_y;
                float dz_n = (float)nz_val - p_img_z;
                float dist2 = dx_n*dx_n + dy_n*dy_n + dz_n*dz_n;
                float w = 1.0f / (dist2 + 1e-6f);
                
                auto s_neighbor = sample_gpu_raw<RealType, IsMultiMaterial>(states, nx_val, ny_val, nz_val);
                
                sum_rho += w * (float)s_neighbor.rho;
                sum_ux += w * (float)s_neighbor.ux;
                sum_uy += w * (float)s_neighbor.uy;
                sum_uz += w * (float)s_neighbor.uz;
                sum_p += w * (float)s_neighbor.p;
                if constexpr (IsMultiMaterial) {
                    sum_alpha1 += w * (float)s_neighbor.alpha1;
                    sum_alpha2 += w * (float)s_neighbor.alpha2;
                    sum_arho1 += w * (float)s_neighbor.arho1;
                    sum_arho2 += w * (float)s_neighbor.arho2;
                }
                W_total += w;
            }
        }
    }
    
    GPUCellStateT<RealType> s_ghost;
    if (W_total == 0.0f) {
        s_ghost = sample_gpu_raw<RealType, IsMultiMaterial>(states, qx, qy, qz);
    } else {
        float inv_W = 1.0f / W_total;
        s_ghost.rho = (RealType)(sum_rho * inv_W);
        s_ghost.ux = (RealType)(sum_ux * inv_W);
        s_ghost.uy = (RealType)(sum_uy * inv_W);
        s_ghost.uz = (RealType)(sum_uz * inv_W);
        s_ghost.p = (RealType)(sum_p * inv_W);
        if constexpr (IsMultiMaterial) {
            s_ghost.alpha1 = (RealType)(sum_alpha1 * inv_W);
            s_ghost.alpha2 = (RealType)(sum_alpha2 * inv_W);
            s_ghost.arho1 = (RealType)(sum_arho1 * inv_W);
            s_ghost.arho2 = (RealType)(sum_arho2 * inv_W);
        } else {
            s_ghost.alpha1 = 0.0; s_ghost.alpha2 = 0.0; s_ghost.arho1 = 0.0; s_ghost.arho2 = 0.0;
        }
    }
    
    // ALWAYS reflect velocity across the TRUE STL normal to ensure smooth slip flow
    // over stair-stepped voxelization artifacts, sacrificing strict mass conservation for flow quality.
    float u_dot_n = (float)s_ghost.ux * nx_true + (float)s_ghost.uy * ny_true + (float)s_ghost.uz * nz_true;
    s_ghost.ux = (RealType)((float)s_ghost.ux - 2.0f * u_dot_n * nx_true);
    s_ghost.uy = (RealType)((float)s_ghost.uy - 2.0f * u_dot_n * ny_true);
    s_ghost.uz = (RealType)((float)s_ghost.uz - 2.0f * u_dot_n * nz_true);
    
    s_ghost.E = 0.0;
    
    return s_ghost;
}

template <typename RealType, bool IsMultiMaterial>
__device__ __forceinline__ void reconstruct_gpu(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    const GeometryTile3D* geom,
    int gx, int gy, int gz,
    int dir,
    GPUCellStateT<RealType>& sL, GPUCellStateT<RealType>& sR,
    int qx, int qy, int qz,
    bool is_near_boundary,
    bool force_first_order_L = false,
    bool force_first_order_R = false
) {
    int dx = (dir == 0 ? 1 : 0);
    int dy = (dir == 1 ? 1 : 0);
    int dz = (dir == 2 ? 1 : 0);

    GPUCellStateT<RealType> sM1 = sample_gpu<RealType, IsMultiMaterial>(states, geom, gx - dx, gy - dy, gz - dz, qx, qy, qz, dir, is_near_boundary);
    GPUCellStateT<RealType> sP0 = sample_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz, qx, qy, qz, dir, is_near_boundary);

    GPUCellStateT<RealType> sM2 = sample_gpu<RealType, IsMultiMaterial>(states, geom, gx - 2*dx, gy - 2*dy, gz - 2*dz, qx, qy, qz, dir, is_near_boundary);
    GPUCellStateT<RealType> sP1 = sample_gpu<RealType, IsMultiMaterial>(states, geom, gx + dx, gy + dy, gz + dz, qx, qy, qz, dir, is_near_boundary);

    auto reconstruct_channel = [&](RealType vM2, RealType vM1, RealType vP0, RealType vP1, RealType& vL, RealType& vR) {
        if (d_spatialOrder == 1 || force_first_order_L || force_first_order_R) {
            vL = vM1;
            vR = vP0;
        } else if (d_spatialOrder == 3) {
            vL = weno3_gpu(vM2, vM1, vP0);
            vR = weno3_gpu(vP1, vP0, vM1);
        } else { // Order 2 or default
            RealType dL = vM1 - vM2;
            RealType dC = vP0 - vM1;
            RealType dR = vP1 - vP0;
            vL = vM1 + (RealType)0.5 * minmod_gpu(dL, dC);
            vR = vP0 - (RealType)0.5 * minmod_gpu(dC, dR);
        }
    };

    reconstruct_channel(sM2.rho, sM1.rho, sP0.rho, sP1.rho, sL.rho, sR.rho);
    sL.rho = fmax((RealType)1e-7, sL.rho);
    sR.rho = fmax((RealType)1e-7, sR.rho);
    reconstruct_channel(sM2.ux, sM1.ux, sP0.ux, sP1.ux, sL.ux, sR.ux);
    reconstruct_channel(sM2.uy, sM1.uy, sP0.uy, sP1.uy, sL.uy, sR.uy);
    reconstruct_channel(sM2.uz, sM1.uz, sP0.uz, sP1.uz, sL.uz, sR.uz);
    reconstruct_channel(sM2.p, sM1.p, sP0.p, sP1.p, sL.p, sR.p);
    sL.p = fmax((RealType)1e-7, sL.p);
    sR.p = fmax((RealType)1e-7, sR.p);

    if constexpr (IsMultiMaterial) {
        reconstruct_channel(sM2.alpha1, sM1.alpha1, sP0.alpha1, sP1.alpha1, sL.alpha1, sR.alpha1);
        reconstruct_channel(sM2.alpha2, sM1.alpha2, sP0.alpha2, sP1.alpha2, sL.alpha2, sR.alpha2);
        reconstruct_channel(sM2.arho1, sM1.arho1, sP0.arho1, sP1.arho1, sL.arho1, sR.arho1);
        reconstruct_channel(sM2.arho2, sM1.arho2, sP0.arho2, sP1.arho2, sL.arho2, sR.arho2);

        sL.alpha1 = fmax((RealType)0.0, fmin((RealType)1.0, sL.alpha1));
        sL.alpha2 = fmax((RealType)0.0, fmin((RealType)1.0, sL.alpha2));
        sR.alpha1 = fmax((RealType)0.0, fmin((RealType)1.0, sR.alpha1));
        sR.alpha2 = fmax((RealType)0.0, fmin((RealType)1.0, sR.alpha2));

        sL.arho1 = fmax((RealType)0.0, fmin(sL.rho, sL.arho1));
        sL.arho2 = fmax((RealType)0.0, fmin(sL.rho, sL.arho2));
        sR.arho1 = fmax((RealType)0.0, fmin(sR.rho, sR.arho1));
        sR.arho2 = fmax((RealType)0.0, fmin(sR.rho, sR.arho2));
    }

    RealType keL = (RealType)0.5 * sL.rho * (sL.ux*sL.ux + sL.uy*sL.uy + sL.uz*sL.uz);
    RealType keR = (RealType)0.5 * sR.rho * (sR.ux*sR.ux + sR.uy*sR.uy + sR.uz*sR.uz);

    if constexpr (IsMultiMaterial) {
        sL.E = (RealType)MultiMat::getMixtureEnergy((double)sL.p, (double)sL.rho, (double)sL.alpha1, (double)sL.alpha2, (double)sL.arho1, (double)sL.arho2, d_gamma, d_products, d_unreacted) + keL;
        sR.E = (RealType)MultiMat::getMixtureEnergy((double)sR.p, (double)sR.rho, (double)sR.alpha1, (double)sR.alpha2, (double)sR.arho1, (double)sR.arho2, d_gamma, d_products, d_unreacted) + keR;
    } else {
        sL.E = sL.p / ((RealType)d_gamma - (RealType)1.0) + keL;
        sR.E = sR.p / ((RealType)d_gamma - (RealType)1.0) + keR;
    }
}

__device__ void get_geom_payload_gpu(
    const GeometryTile3D* geom_pool,
    int gx, int gy, int gz,
    int nx, int ny, int nz,
    int ntx, int nty,
    bool& is_b, float& nx_b, float& ny_b, float& nz_b
) {
    is_b = false;
    nx_b = 0.0f; ny_b = 0.0f; nz_b = 0.0f;
    if (gx < 0 || gx >= nx || gy < 0 || gy >= ny || gz < 0 || gz >= nz) return;
    int tx = gx / TILE_SIZE_3D;
    int ty = gy / TILE_SIZE_3D;
    int tz = gz / TILE_SIZE_3D;
    int t_idx = tx + ty * ntx + tz * ntx * nty;
    int cx = gx % TILE_SIZE_3D;
    int cy = gy % TILE_SIZE_3D;
    int cz = gz % TILE_SIZE_3D;
    int idx = cx + cy * TILE_SIZE_3D + cz * TILE_SIZE_3D * TILE_SIZE_3D;
    GeometryPayload payload = geom_pool[t_idx].cells[idx];
    unpack_geometry_payload(payload, is_b, nx_b, ny_b, nz_b);
}

template <typename RealType, bool IsMultiMaterial>
__device__ __forceinline__ void get_face_flux_gpu(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    const GeometryTile3D* geom_pool,
    int gx_L, int gy_L, int gz_L,
    int gx_R, int gy_R, int gz_R,
    int dir, RealType* flx,
    int qx, int qy, int qz,
    bool is_near_boundary
) {
    bool force_first = false;
    if (is_near_boundary && geom_pool) {
        int dx = (dir == 0 ? 1 : 0);
        int dy = (dir == 1 ? 1 : 0);
        int dz = (dir == 2 ? 1 : 0);
        bool m2 = is_solid_cell_gpu(geom_pool, gx_L - dx, gy_L - dy, gz_L - dz);
        bool m1 = is_solid_cell_gpu(geom_pool, gx_L, gy_L, gz_L);
        bool p0 = is_solid_cell_gpu(geom_pool, gx_R, gy_R, gz_R);
        bool p1 = is_solid_cell_gpu(geom_pool, gx_R + dx, gy_R + dy, gz_R + dz);
        force_first = m2 || m1 || p0 || p1;
    }

    GPUCellStateT<RealType> sL, sR;
    reconstruct_gpu<RealType, IsMultiMaterial>(states, geom_pool, gx_R, gy_R, gz_R, dir, sL, sR, qx, qy, qz, is_near_boundary, force_first, force_first);
    if (d_useAUSM) getAUSMPlusFluxGPU<RealType, IsMultiMaterial>(sL, sR, flx, dir, (RealType)d_gamma);
    else getRusanovFluxGPU<RealType, IsMultiMaterial>(sL, sR, flx, dir, (RealType)d_gamma);
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) compute_flux_x_kernel_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    ConservativeTile3D<RealType, IsMultiMaterial>* U,
    const int* active_tile_indices,
    const uint8_t* tile_is_near_boundary,
    const GeometryTile3D* geom,
    RealType dt
) {
    int t_idx = active_tile_indices[blockIdx.x];
    int tx = t_idx % d_ntx;
    int ty = (t_idx / d_ntx) % d_nty;
    int tz = t_idx / (d_ntx * d_nty);

    __shared__ bool s_is_near_boundary;
    int tid = threadIdx.x + threadIdx.y * 8 + threadIdx.z * 64;
    if (tid == 0) {
        s_is_near_boundary = tile_is_near_boundary ? (tile_is_near_boundary[t_idx] != 0) : false;
    }
    __syncthreads();

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    int gx = tx * TILE_SIZE_3D + lx;
    int gy = ty * TILE_SIZE_3D + ly;
    int gz = tz * TILE_SIZE_3D + lz;

    if (gx >= d_nx || gy >= d_ny || gz >= d_nz) return;

    bool is_boundary = false;
    if (s_is_near_boundary) {
        is_boundary = is_solid_cell_gpu(geom, gx, gy, gz);
    }

    if (!is_boundary) {
        RealType invDx = (RealType)(1.0 / d_cellSize);
        RealType dt_dx = dt * invDx;

        RealType fL[10], fR[10];

        // --- X Direction ---
        get_face_flux_gpu<RealType, IsMultiMaterial>(states, geom, gx - 1, gy, gz, gx, gy, gz, 0, fL, gx, gy, gz, s_is_near_boundary);
        get_face_flux_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz, gx + 1, gy, gz, 0, fR, gx, gy, gz, s_is_near_boundary);

        // Apply X fluxes
        U[t_idx].rho[c_idx]   -= dt_dx * (fR[0] - fL[0]);
        U[t_idx].rhoux[c_idx] -= dt_dx * (fR[1] - fL[1]);
        U[t_idx].rhouy[c_idx] -= dt_dx * (fR[2] - fL[2]);
        U[t_idx].rhouz[c_idx] -= dt_dx * (fR[3] - fL[3]);
        U[t_idx].E[c_idx]     -= dt_dx * (fR[4] - fL[4]);
        if constexpr (IsMultiMaterial) {
            U[t_idx].alpha1[c_idx] -= dt_dx * (fR[5] - fL[5]);
            U[t_idx].alpha2[c_idx] -= dt_dx * (fR[6] - fL[6]);
            U[t_idx].arho1[c_idx]  -= dt_dx * (fR[7] - fL[7]);
            U[t_idx].arho2[c_idx]  -= dt_dx * (fR[8] - fL[8]);
            RealType div_u = fR[9] - fL[9];
            U[t_idx].alpha1[c_idx] += dt_dx * states[t_idx].alpha1[c_idx] * div_u;
            U[t_idx].alpha2[c_idx] += dt_dx * states[t_idx].alpha2[c_idx] * div_u;
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) compute_flux_y_kernel_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    ConservativeTile3D<RealType, IsMultiMaterial>* U,
    const int* active_tile_indices,
    const uint8_t* tile_is_near_boundary,
    const GeometryTile3D* geom,
    RealType dt
) {
    int t_idx = active_tile_indices[blockIdx.x];
    int tx = t_idx % d_ntx;
    int ty = (t_idx / d_ntx) % d_nty;
    int tz = t_idx / (d_ntx * d_nty);

    __shared__ bool s_is_near_boundary;
    int tid = threadIdx.x + threadIdx.y * 8 + threadIdx.z * 64;
    if (tid == 0) {
        s_is_near_boundary = tile_is_near_boundary ? (tile_is_near_boundary[t_idx] != 0) : false;
    }
    __syncthreads();

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    int gx = tx * TILE_SIZE_3D + lx;
    int gy = ty * TILE_SIZE_3D + ly;
    int gz = tz * TILE_SIZE_3D + lz;

    if (gx >= d_nx || gy >= d_ny || gz >= d_nz) return;

    bool is_boundary = false;
    if (s_is_near_boundary) {
        is_boundary = is_solid_cell_gpu(geom, gx, gy, gz);
    }

    if (!is_boundary) {
        RealType invDx = (RealType)(1.0 / d_cellSize);
        RealType dt_dx = dt * invDx;

        RealType fL[10], fR[10];

        // --- Y Direction ---
        get_face_flux_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy - 1, gz, gx, gy, gz, 1, fL, gx, gy, gz, s_is_near_boundary);
        get_face_flux_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz, gx, gy + 1, gz, 1, fR, gx, gy, gz, s_is_near_boundary);

        // Apply Y fluxes
        U[t_idx].rho[c_idx]   -= dt_dx * (fR[0] - fL[0]);
        U[t_idx].rhoux[c_idx] -= dt_dx * (fR[1] - fL[1]);
        U[t_idx].rhouy[c_idx] -= dt_dx * (fR[2] - fL[2]);
        U[t_idx].rhouz[c_idx] -= dt_dx * (fR[3] - fL[3]);
        U[t_idx].E[c_idx]     -= dt_dx * (fR[4] - fL[4]);
        if constexpr (IsMultiMaterial) {
            U[t_idx].alpha1[c_idx] -= dt_dx * (fR[5] - fL[5]);
            U[t_idx].alpha2[c_idx] -= dt_dx * (fR[6] - fL[6]);
            U[t_idx].arho1[c_idx]  -= dt_dx * (fR[7] - fL[7]);
            U[t_idx].arho2[c_idx]  -= dt_dx * (fR[8] - fL[8]);
            RealType div_u = fR[9] - fL[9];
            U[t_idx].alpha1[c_idx] += dt_dx * states[t_idx].alpha1[c_idx] * div_u;
            U[t_idx].alpha2[c_idx] += dt_dx * states[t_idx].alpha2[c_idx] * div_u;
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) compute_flux_z_kernel_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    ConservativeTile3D<RealType, IsMultiMaterial>* U,
    const int* active_tile_indices,
    const uint8_t* tile_is_near_boundary,
    const GeometryTile3D* geom,
    RealType dt
) {
    int t_idx = active_tile_indices[blockIdx.x];
    int tx = t_idx % d_ntx;
    int ty = (t_idx / d_ntx) % d_nty;
    int tz = t_idx / (d_ntx * d_nty);

    __shared__ bool s_is_near_boundary;
    int tid = threadIdx.x + threadIdx.y * 8 + threadIdx.z * 64;
    if (tid == 0) {
        s_is_near_boundary = tile_is_near_boundary ? (tile_is_near_boundary[t_idx] != 0) : false;
    }
    __syncthreads();

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    int gx = tx * TILE_SIZE_3D + lx;
    int gy = ty * TILE_SIZE_3D + ly;
    int gz = tz * TILE_SIZE_3D + lz;

    if (gx >= d_nx || gy >= d_ny || gz >= d_nz) return;

    bool is_boundary = false;
    if (s_is_near_boundary) {
        is_boundary = is_solid_cell_gpu(geom, gx, gy, gz);
    }

    if (!is_boundary) {
        RealType invDx = (RealType)(1.0 / d_cellSize);
        RealType dt_dx = dt * invDx;

        RealType fL[10], fR[10];

        // --- Z Direction ---
        get_face_flux_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz - 1, gx, gy, gz, 2, fL, gx, gy, gz, s_is_near_boundary);
        get_face_flux_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz, gx, gy, gz + 1, 2, fR, gx, gy, gz, s_is_near_boundary);

        // Apply Z fluxes
        U[t_idx].rho[c_idx]   -= dt_dx * (fR[0] - fL[0]);
        U[t_idx].rhoux[c_idx] -= dt_dx * (fR[1] - fL[1]);
        U[t_idx].rhouy[c_idx] -= dt_dx * (fR[2] - fL[2]);
        U[t_idx].rhouz[c_idx] -= dt_dx * (fR[3] - fL[3]);
        U[t_idx].E[c_idx]     -= dt_dx * (fR[4] - fL[4]);
        if constexpr (IsMultiMaterial) {
            U[t_idx].alpha1[c_idx] -= dt_dx * (fR[5] - fL[5]);
            U[t_idx].alpha2[c_idx] -= dt_dx * (fR[6] - fL[6]);
            U[t_idx].arho1[c_idx]  -= dt_dx * (fR[7] - fL[7]);
            U[t_idx].arho2[c_idx]  -= dt_dx * (fR[8] - fL[8]);
            RealType div_u = fR[9] - fL[9];
            U[t_idx].alpha1[c_idx] += dt_dx * states[t_idx].alpha1[c_idx] * div_u;
            U[t_idx].alpha2[c_idx] += dt_dx * states[t_idx].alpha2[c_idx] * div_u;
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) update_primitive_kernel_3d(
    PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    ConservativeTile3D<RealType, IsMultiMaterial>* U,
    const int* active_tile_indices,
    const GeometryTile3D* geom
) {
    int t_idx = active_tile_indices[blockIdx.x];
    int tx = t_idx % d_ntx;
    int ty = (t_idx / d_ntx) % d_nty;
    int tz = t_idx / (d_ntx * d_nty);

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    int gx = tx * TILE_SIZE_3D + lx;
    int gy = ty * TILE_SIZE_3D + ly;
    int gz = tz * TILE_SIZE_3D + lz;

    if (gx >= d_nx || gy >= d_ny || gz >= d_nz) return;

    RealType u_rho = U[t_idx].rho[c_idx];
    RealType u_rhoux = U[t_idx].rhoux[c_idx];
    RealType u_rhouy = U[t_idx].rhouy[c_idx];
    RealType u_rhouz = U[t_idx].rhouz[c_idx];
    RealType u_E = U[t_idx].E[c_idx];

    bool bad = isnan(u_rho) || isinf(u_rho) || u_rho < (RealType)1e-8 ||
               isnan(u_rhoux) || isinf(u_rhoux) ||
               isnan(u_rhouy) || isinf(u_rhouy) ||
               isnan(u_rhouz) || isinf(u_rhouz) ||
               isnan(u_E) || isinf(u_E);

    if constexpr (IsMultiMaterial) {
        bad = bad || isnan(U[t_idx].alpha1[c_idx]) || isinf(U[t_idx].alpha1[c_idx]) ||
                    isnan(U[t_idx].alpha2[c_idx]) || isinf(U[t_idx].alpha2[c_idx]) ||
                    isnan(U[t_idx].arho1[c_idx]) || isinf(U[t_idx].arho1[c_idx]) ||
                    isnan(U[t_idx].arho2[c_idx]) || isinf(U[t_idx].arho2[c_idx]);
    }

    RealType rho = (RealType)d_ambient_rho;
    RealType ux = 0.0;
    RealType uy = 0.0;
    RealType uz = 0.0;
    RealType p = (RealType)d_ambient_p;
    RealType E;
    if constexpr (IsMultiMaterial) {
        E = (RealType)MultiMat::getMixtureEnergy((double)d_ambient_p, (double)d_ambient_rho, 0.0, 0.0, 0.0, 0.0, d_gamma, d_products, d_unreacted);
    } else {
        E = (RealType)d_ambient_p / ((RealType)d_gamma - (RealType)1.0);
    }
    RealType alpha1 = 0.0;
    RealType alpha2 = 0.0;
    RealType arho1 = 0.0;
    RealType arho2 = 0.0;

    if (!bad) {
        rho = fmax(u_rho, (RealType)1e-4); // Vacuum density floor
        U[t_idx].rho[c_idx] = rho;         // Enforce in conservative vars
        
        ux = u_rhoux / rho;
        uy = u_rhouy / rho;
        uz = u_rhouz / rho;
        
        RealType u_mag = sqrt(ux*ux + uy*uy + uz*uz);
        const RealType MAX_VEL = 25000.0;
        if (u_mag > MAX_VEL) {
            RealType scale = MAX_VEL / u_mag;
            ux *= scale;
            uy *= scale;
            uz *= scale;
            U[t_idx].rhoux[c_idx] = rho * ux;
            U[t_idx].rhouy[c_idx] = rho * uy;
            U[t_idx].rhouz[c_idx] = rho * uz;
        }
        
        RealType ke = (RealType)0.5 * rho * (ux*ux + uy*uy + uz*uz);
        RealType e_int = u_E - ke;
        
        // Temperature/Energy cap to prevent speed of sound explosion
        // Assuming c^2 ~ p/rho, and p ~ e_int. If e_int/rho is too large, cap it.
        const RealType MAX_SPECIFIC_EINT = 1e10; 
        if (e_int / rho > MAX_SPECIFIC_EINT) {
            e_int = rho * MAX_SPECIFIC_EINT;
            U[t_idx].E[c_idx] = e_int + ke;
        } else if (e_int < 0.0) {
            e_int = 0.0;
            U[t_idx].E[c_idx] = ke;
        }

        if constexpr (IsMultiMaterial) {
            alpha1 = fmax((RealType)0.0, fmin((RealType)1.0, U[t_idx].alpha1[c_idx]));
            alpha2 = fmax((RealType)0.0, fmin((RealType)1.0, U[t_idx].alpha2[c_idx]));
            if (alpha1 + alpha2 > (RealType)1.0) {
                RealType sum = alpha1 + alpha2;
                alpha1 /= sum;
                alpha2 /= sum;
            }
            arho1 = fmax((RealType)0.0, fmin(rho, U[t_idx].arho1[c_idx]));
            arho2 = fmax((RealType)0.0, fmin(rho, U[t_idx].arho2[c_idx]));
            if (arho1 + arho2 > rho) {
                RealType sum = arho1 + arho2;
                arho1 = (arho1 / sum) * rho;
                arho2 = (arho2 / sum) * rho;
            }

            double p_val = MultiMat::getMixturePressure((double)e_int, (double)rho, (double)alpha1, (double)alpha2, (double)arho1, (double)arho2, d_gamma, d_products, d_unreacted);
            if (isnan(p_val) || isinf(p_val) || p_val < (RealType)1e-8) {
                bad = true;
            } else {
                p = (RealType)p_val;
                E = u_E;
                U[t_idx].alpha1[c_idx] = alpha1;
                U[t_idx].alpha2[c_idx] = alpha2;
                U[t_idx].arho1[c_idx] = arho1;
                U[t_idx].arho2[c_idx] = arho2;
            }
        } else {
            RealType p_val = e_int * ((RealType)d_gamma - (RealType)1.0);
            if (isnan(p_val) || isinf(p_val) || p_val < (RealType)1e-8) {
                bad = true;
            } else {
                p = p_val;
                E = u_E;
            }
        }
    }

    if (bad) {
        rho = (RealType)d_ambient_rho;
        ux = 0.0;
        uy = 0.0;
        uz = 0.0;
        p = (RealType)d_ambient_p;
        if constexpr (IsMultiMaterial) {
            E = (RealType)MultiMat::getMixtureEnergy((double)d_ambient_p, (double)d_ambient_rho, 0.0, 0.0, 0.0, 0.0, d_gamma, d_products, d_unreacted);
        } else {
            E = (RealType)d_ambient_p / ((RealType)d_gamma - (RealType)1.0);
        }
        alpha1 = 0.0;
        alpha2 = 0.0;
        arho1 = 0.0;
        arho2 = 0.0;

        U[t_idx].rho[c_idx] = (RealType)d_ambient_rho;
        U[t_idx].rhoux[c_idx] = 0.0;
        U[t_idx].rhouy[c_idx] = 0.0;
        U[t_idx].rhouz[c_idx] = 0.0;
        U[t_idx].E[c_idx] = E;
        if constexpr (IsMultiMaterial) {
            U[t_idx].alpha1[c_idx] = 0.0;
            U[t_idx].alpha2[c_idx] = 0.0;
            U[t_idx].arho1[c_idx] = 0.0;
            U[t_idx].arho2[c_idx] = 0.0;
        }
    }

    bool is_solid = false;
    if (geom) {
        GeometryPayload payload = geom[t_idx].cells[c_idx];
        is_solid = payload.is_boundary;
    }

    if (is_solid) {
        rho = (RealType)d_ambient_rho;
        ux = 0.0;
        uy = 0.0;
        uz = 0.0;
        p = (RealType)d_ambient_p;
        if constexpr (IsMultiMaterial) {
            E = (RealType)MultiMat::getMixtureEnergy((double)d_ambient_p, (double)d_ambient_rho, 0.0, 0.0, 0.0, 0.0, d_gamma, d_products, d_unreacted);
        } else {
            E = (RealType)d_ambient_p / ((RealType)d_gamma - (RealType)1.0);
        }
        alpha1 = 0.0;
        alpha2 = 0.0;
        arho1 = 0.0;
        arho2 = 0.0;

        U[t_idx].rho[c_idx] = (RealType)d_ambient_rho;
        U[t_idx].rhoux[c_idx] = 0.0;
        U[t_idx].rhouy[c_idx] = 0.0;
        U[t_idx].rhouz[c_idx] = 0.0;
        U[t_idx].E[c_idx] = E;
        if constexpr (IsMultiMaterial) {
            U[t_idx].alpha1[c_idx] = 0.0;
            U[t_idx].alpha2[c_idx] = 0.0;
            U[t_idx].arho1[c_idx] = 0.0;
            U[t_idx].arho2[c_idx] = 0.0;
        }
    }

    states[t_idx].rho[c_idx] = rho;
    states[t_idx].ux[c_idx] = ux;
    states[t_idx].uy[c_idx] = uy;
    states[t_idx].uz[c_idx] = uz;
    states[t_idx].p[c_idx] = p;
    states[t_idx].floor_status[c_idx] = bad ? 1 : 0;
    if constexpr (IsMultiMaterial) {
        states[t_idx].alpha1[c_idx] = alpha1;
        states[t_idx].alpha2[c_idx] = alpha2;
        states[t_idx].arho1[c_idx] = arho1;
        states[t_idx].arho2[c_idx] = arho2;
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) apply_bc_kernel_3d(PrimitiveTile3D<RealType, IsMultiMaterial>* states, int nx, int ny, int nz) {
    // Boundary conditions handled in sample_gpu dynamically
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) applyProgrammedBurn_kernel_3d(
    ConservativeTile3D<RealType, IsMultiMaterial>* U,
    const int* active_tile_indices,
    RealType currentTime, RealType dt) {
    
    int t_idx = active_tile_indices[blockIdx.x];
    int tx = t_idx % d_ntx;
    int ty = (t_idx / d_ntx) % d_nty;
    int tz = t_idx / (d_ntx * d_nty);

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    int gx = tx * TILE_SIZE_3D + lx;
    int gy = ty * TILE_SIZE_3D + ly;
    int gz = tz * TILE_SIZE_3D + lz;

    if (gx >= d_nx || gy >= d_ny || gz >= d_nz) return;

    RealType x_c = d_xmin + (gx + (RealType)0.5) * d_cellSize;
    RealType y_c = d_ymin + (gy + (RealType)0.5) * d_cellSize;
    RealType z_c = d_zmin + (gz + (RealType)0.5) * d_cellSize;

    double tmp_alpha1 = (double)U[t_idx].alpha1[c_idx];
    double tmp_alpha2 = (double)U[t_idx].alpha2[c_idx];
    double tmp_arho1 = (double)U[t_idx].arho1[c_idx];
    double tmp_arho2 = (double)U[t_idx].arho2[c_idx];

    double dF = MultiMat::computeProgrammedBurn(
        (double)currentTime, (double)dt, (double)x_c, (double)y_c, (double)z_c,
        d_det_vel, 0.0, d_detX, d_detY, d_detZ,
        (double)d_cellSize, d_products.rho0,
        tmp_alpha1, tmp_alpha2, tmp_arho1, tmp_arho2
    );

    if (dF > 0.0) {
        if (d_detonation_energy > 0.0) {
            double rho_expl = tmp_arho1 + tmp_arho2;
            U[t_idx].E[c_idx] += (RealType)(dF * rho_expl * d_detonation_energy);
        }
        U[t_idx].alpha1[c_idx] = (RealType)tmp_alpha1;
        U[t_idx].alpha2[c_idx] = (RealType)tmp_alpha2;
        U[t_idx].arho1[c_idx] = (RealType)tmp_arho1;
        U[t_idx].arho2[c_idx] = (RealType)tmp_arho2;
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) set_initial_condition_kernel(PrimitiveTile3D<RealType, IsMultiMaterial>* states, ConservativeTile3D<RealType, IsMultiMaterial>* U, uint8_t* active_tiles,
                                            int nx, int ny, int nz, RealType cellSize, RealType xmin, RealType ymin, RealType zmin,
                                            RealType amb_rho, RealType amb_p, RealType gamma,
                                            Charge3DParams charge, RealType high_rho, RealType det_energy, RealType det_vel) {
    int tx = blockIdx.x;
    int ty = blockIdx.y;
    int tz = blockIdx.z;
    int t_idx = tx + ty * d_ntx + tz * d_ntx * d_nty;

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    int gx = tx * TILE_SIZE_3D + lx;
    int gy = ty * TILE_SIZE_3D + ly;
    int gz = tz * TILE_SIZE_3D + lz;

    if (gx >= nx || gy >= ny || gz >= nz) return;

    RealType x_c = xmin + (gx + (RealType)0.5) * cellSize;
    RealType y_c = ymin + (gy + (RealType)0.5) * cellSize;
    RealType z_c = zmin + (gz + (RealType)0.5) * cellSize;

    int points_inside = 0;
    for (double ox : {-0.25, 0.25}) {
        for (double oy : {-0.25, 0.25}) {
            for (double oz : {-0.25, 0.25}) {
                double px = (double)x_c + ox * (double)cellSize;
                double py = (double)y_c + oy * (double)cellSize;
                double pz = (double)z_c + oz * (double)cellSize;
                double dx_p = px - charge.x;
                double dy_p = py - charge.y;
                double dz_p = pz - charge.z;
                double dist_sq_p = dx_p*dx_p + dy_p*dy_p + dz_p*dz_p;
                bool inside = false;
                if (charge.shape_type == 0) { // Sphere
                    if (dist_sq_p <= charge.radius * charge.radius) inside = true;
                } else if (charge.shape_type == 1) { // Block
                    if (fabs(dx_p) <= charge.lx*0.5 && fabs(dy_p) <= charge.ly*0.5 && fabs(dz_p) <= charge.lz*0.5) inside = true;
                } else if (charge.shape_type == 2) { // Cylinder
                    double dr_sq_p = dx_p*dx_p + dy_p*dy_p;
                    if (dr_sq_p <= charge.radius*charge.radius && fabs(dz_p) <= charge.height*0.5) inside = true;
                }
                if (inside) points_inside++;
            }
        }
    }
    RealType f_vol = (RealType)(points_inside / 8.0);

    RealType rho = amb_rho;
    RealType p = amb_p;
    RealType alpha1 = 0.0;
    RealType alpha2 = 0.0;
    RealType arho1 = 0.0;
    RealType arho2 = 0.0;

    if (f_vol > (RealType)0.0) {
        if constexpr (IsMultiMaterial) {
            alpha1 = 0.0;
            alpha2 = f_vol;
            arho1 = 0.0;
            arho2 = alpha2 * high_rho;
            rho = arho2 + ((RealType)1.0 - f_vol) * amb_rho;

            // Set pressure to the thermodynamically consistent mixture equilibrium.
            // The unreacted solid JWL has a large reference pressure at V=1; using
            // amb_p for interface cells would give a negative internal energy via
            // getMixtureEnergy, causing bad-cell resets after the first flux step.
            RealType p_solid = (RealType)MultiMat::getReferencePressure_Unreacted<RealType>(d_unreacted);
            // Blend: pure-air cells stay at amb_p, pure-solid cells at p_solid,
            // interface cells interpolate. The smooth ramp S(alpha) in the EoS
            // ensures this pressure is recovered exactly by getMixturePressure.
            p = ((RealType)1.0 - f_vol) * amb_p + f_vol * (RealType)fmax((double)amb_p, (double)p_solid);
        } else {
            rho = f_vol * high_rho + ((RealType)1.0 - f_vol) * amb_rho;
            RealType p_high = (gamma - (RealType)1.0) * high_rho * det_energy;
            p = f_vol * p_high + ((RealType)1.0 - f_vol) * amb_p;
        }
        active_tiles[t_idx] = 1;
    }

    states[t_idx].rho[c_idx] = rho;
    states[t_idx].ux[c_idx] = 0;
    states[t_idx].uy[c_idx] = 0;
    states[t_idx].uz[c_idx] = 0;
    states[t_idx].p[c_idx] = p;
    states[t_idx].peak_overpressure[c_idx] = 0.0;
    states[t_idx].running_impulse[c_idx] = 0.0;
    states[t_idx].peak_impulse[c_idx] = 0.0;
    
    RealType init_E;
    if constexpr (IsMultiMaterial) {
        init_E = (RealType)MultiMat::getMixtureEnergy((double)p, (double)rho, (double)alpha1, (double)alpha2, (double)arho1, (double)arho2, (double)gamma, d_products, d_unreacted);
    } else {
        init_E = p / (gamma - (RealType)1.0);
    }
    if constexpr (IsMultiMaterial) {
        states[t_idx].alpha1[c_idx] = alpha1;
        states[t_idx].alpha2[c_idx] = alpha2;
        states[t_idx].arho1[c_idx] = arho1;
        states[t_idx].arho2[c_idx] = arho2;
    }

    U[t_idx].rho[c_idx] = rho;
    U[t_idx].rhoux[c_idx] = 0;
    U[t_idx].rhouy[c_idx] = 0;
    U[t_idx].rhouz[c_idx] = 0;
    U[t_idx].E[c_idx] = init_E;
    if constexpr (IsMultiMaterial) {
        U[t_idx].alpha1[c_idx] = alpha1;
        U[t_idx].alpha2[c_idx] = alpha2;
        U[t_idx].arho1[c_idx] = arho1;
        U[t_idx].arho2[c_idx] = arho2;
    }
}

template <typename RealType, bool IsMultiMaterial>
__device__ float get_value_by_qty(const PrimitiveTile3D<RealType, IsMultiMaterial>& tile, int c_idx, int qty_id) {
    if (qty_id == 1) return (float)tile.rho[c_idx];
    if (qty_id == 2) {
        RealType ux = tile.ux[c_idx];
        RealType uy = tile.uy[c_idx];
        RealType uz = tile.uz[c_idx];
        return (float)sqrt((double)(ux*ux + uy*uy + uz*uz));
    }
    if (qty_id == 3) {
        RealType ke = (RealType)0.5 * tile.rho[c_idx] * (tile.ux[c_idx]*tile.ux[c_idx] + tile.uy[c_idx]*tile.uy[c_idx] + tile.uz[c_idx]*tile.uz[c_idx]);
        RealType total_E;
        if constexpr (IsMultiMaterial) {
            total_E = (RealType)MultiMat::getMixtureEnergy((double)tile.p[c_idx], (double)tile.rho[c_idx], (double)tile.alpha1[c_idx], (double)tile.alpha2[c_idx], (double)tile.arho1[c_idx], (double)tile.arho2[c_idx], d_gamma, d_products, d_unreacted) + ke;
        } else {
            total_E = tile.p[c_idx] / (d_gamma - (RealType)1.0) + ke;
        }
        return (float)(total_E / fmax((RealType)1e-6, tile.rho[c_idx]));
    }
    if (qty_id == 4) {
        if constexpr (IsMultiMaterial) return (float)tile.alpha1[c_idx];
        return 0.0f;
    }
    if (qty_id == 5) {
        if constexpr (IsMultiMaterial) return (float)tile.alpha2[c_idx];
        return 0.0f;
    }
    if (qty_id == 6) {
        if constexpr (IsMultiMaterial) return (float)(1.0 - tile.alpha1[c_idx] - tile.alpha2[c_idx]);
        return 1.0f;
    }
    if (qty_id == 8) return (float)tile.peak_overpressure[c_idx];
    if (qty_id == 9) return (float)tile.peak_impulse[c_idx];
    return (float)tile.p[c_idx];
}

template <typename RealType, bool IsMultiMaterial>
__device__ float get_value_by_qty_struct(const GPUCellStateT<RealType>& tile, int qty_id) {
    if (qty_id == 1) return (float)tile.rho;
    if (qty_id == 2) {
        RealType ux = tile.ux;
        RealType uy = tile.uy;
        RealType uz = tile.uz;
        return (float)sqrt((double)(ux*ux + uy*uy + uz*uz));
    }
    if (qty_id == 3) {
        RealType ke = (RealType)0.5 * tile.rho * (tile.ux*tile.ux + tile.uy*tile.uy + tile.uz*tile.uz);
        RealType total_E;
        if constexpr (IsMultiMaterial) {
            total_E = (RealType)MultiMat::getMixtureEnergy((double)tile.p, (double)tile.rho, (double)tile.alpha1, (double)tile.alpha2, (double)tile.arho1, (double)tile.arho2, d_gamma, d_products, d_unreacted) + ke;
        } else {
            total_E = tile.p / (d_gamma - (RealType)1.0) + ke;
        }
        return (float)(total_E / fmax((RealType)1e-6, tile.rho));
    }
    if (qty_id == 4) {
        if constexpr (IsMultiMaterial) return (float)tile.alpha1;
        return 0.0f;
    }
    if (qty_id == 5) {
        if constexpr (IsMultiMaterial) return (float)tile.alpha2;
        return 0.0f;
    }
    if (qty_id == 6) {
        if constexpr (IsMultiMaterial) return (float)(1.0 - tile.alpha1 - tile.alpha2);
        return 1.0f;
    }
    if (qty_id == 8) return (float)tile.peak_overpressure;
    if (qty_id == 9) return (float)tile.peak_impulse;
    return (float)tile.p;
}

template <typename RealType, bool IsMultiMaterial>
__device__ GPUCellStateT<RealType> sample_state_with_mirror_gpu(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    const GeometryTile3D* geom,
    int gx, int gy, int gz,
    double xmin, double ymin, double zmin, double cellSize
) {
    GPUCellStateT<RealType> sC = sample_gpu_raw<RealType, IsMultiMaterial>(states, gx, gy, gz);

    float nx_b, ny_b, nz_b;
    if (get_solid_normal_gpu(geom, gx, gy, gz, nx_b, ny_b, nz_b)) {
        float n_len = sqrt(nx_b*nx_b + ny_b*ny_b + nz_b*nz_b);
        if (n_len > 1e-3f) {
            float nx_u = nx_b / n_len;
            float ny_u = ny_b / n_len;
            float nz_u = nz_b / n_len;

            int clamped_gx = gx < 0 ? 0 : (gx >= d_nx ? d_nx - 1 : gx);
            int clamped_gy = gy < 0 ? 0 : (gy >= d_ny ? d_ny - 1 : gy);
            int clamped_gz = gz < 0 ? 0 : (gz >= d_nz ? d_nz - 1 : gz);

            // Option B: Decouple boundary normal components at domain boundaries
            bool decoupled = false;
            if (clamped_gx == 0 || clamped_gx == d_nx - 1) { nx_u = 0.0f; decoupled = true; }
            if (clamped_gy == 0 || clamped_gy == d_ny - 1) { ny_u = 0.0f; decoupled = true; }
            if (clamped_gz == 0 || clamped_gz == d_nz - 1) { nz_u = 0.0f; decoupled = true; }
            if (decoupled) {
                float n_len_dec = sqrt(nx_u*nx_u + ny_u*ny_u + nz_u*nz_u);
                if (n_len_dec > 1e-3f) {
                    nx_u /= n_len_dec;
                    ny_u /= n_len_dec;
                    nz_u /= n_len_dec;
                }
            }

            double x_G = xmin + (gx + 0.5) * cellSize;
            double y_G = ymin + (gy + 0.5) * cellSize;
            double z_G = zmin + (gz + 0.5) * cellSize;

            double x_IP = x_G + 1.5 * cellSize * nx_u;
            double y_IP = y_G + 1.5 * cellSize * ny_u;
            double z_IP = z_G + 1.5 * cellSize * nz_u;

            double x_nd = (x_IP - xmin) / cellSize - 0.5;
            double y_nd = (y_IP - ymin) / cellSize - 0.5;
            double z_nd = (z_IP - zmin) / cellSize - 0.5;

            int i0 = (int)floor(x_nd);
            int j0 = (int)floor(y_nd);
            int k0 = (int)floor(z_nd);
            int i1 = i0 + 1;
            int j1 = j0 + 1;
            int k1 = k0 + 1;

            double wx = x_nd - i0;
            double wy = y_nd - j0;
            double wz = z_nd - k0;

            double w[8];
            w[0] = (1.0 - wx) * (1.0 - wy) * (1.0 - wz);
            w[1] = wx * (1.0 - wy) * (1.0 - wz);
            w[2] = (1.0 - wx) * wy * (1.0 - wz);
            w[3] = wx * wy * (1.0 - wz);
            w[4] = (1.0 - wx) * (1.0 - wy) * wz;
            w[5] = wx * (1.0 - wy) * wz;
            w[6] = (1.0 - wx) * wy * wz;
            w[7] = wx * wy * wz;

            bool solid_mask[8];
            float dummy1, dummy2, dummy3;
            solid_mask[0] = get_solid_normal_gpu(geom, i0, j0, k0, dummy1, dummy2, dummy3);
            solid_mask[1] = get_solid_normal_gpu(geom, i1, j0, k0, dummy1, dummy2, dummy3);
            solid_mask[2] = get_solid_normal_gpu(geom, i0, j1, k0, dummy1, dummy2, dummy3);
            solid_mask[3] = get_solid_normal_gpu(geom, i1, j1, k0, dummy1, dummy2, dummy3);
            solid_mask[4] = get_solid_normal_gpu(geom, i0, j0, k1, dummy1, dummy2, dummy3);
            solid_mask[5] = get_solid_normal_gpu(geom, i1, j0, k1, dummy1, dummy2, dummy3);
            solid_mask[6] = get_solid_normal_gpu(geom, i0, j1, k1, dummy1, dummy2, dummy3);
            solid_mask[7] = get_solid_normal_gpu(geom, i1, j1, k1, dummy1, dummy2, dummy3);

            double sum_w = 0.0;
            for (int c = 0; c < 8; ++c) {
                if (solid_mask[c]) w[c] = 0.0;
                else sum_w += w[c];
            }

            if (sum_w > 1e-6) {
                double inv_sum = 1.0 / sum_w;
                for (int c = 0; c < 8; ++c) w[c] *= inv_sum;

                auto s000 = sample_gpu_raw<RealType, IsMultiMaterial>(states, i0, j0, k0);
                auto s100 = sample_gpu_raw<RealType, IsMultiMaterial>(states, i1, j0, k0);
                auto s010 = sample_gpu_raw<RealType, IsMultiMaterial>(states, i0, j1, k0);
                auto s110 = sample_gpu_raw<RealType, IsMultiMaterial>(states, i1, j1, k0);
                auto s001 = sample_gpu_raw<RealType, IsMultiMaterial>(states, i0, j0, k1);
                auto s101 = sample_gpu_raw<RealType, IsMultiMaterial>(states, i1, j0, k1);
                auto s011 = sample_gpu_raw<RealType, IsMultiMaterial>(states, i0, j1, k1);
                auto s111 = sample_gpu_raw<RealType, IsMultiMaterial>(states, i1, j1, k1);

                double rho_i = w[0]*s000.rho + w[1]*s100.rho + w[2]*s010.rho + w[3]*s110.rho +
                               w[4]*s001.rho + w[5]*s101.rho + w[6]*s011.rho + w[7]*s111.rho;
                double ux_i = w[0]*s000.ux + w[1]*s100.ux + w[2]*s010.ux + w[3]*s110.ux +
                              w[4]*s001.ux + w[5]*s101.ux + w[6]*s011.ux + w[7]*s111.ux;
                double uy_i = w[0]*s000.uy + w[1]*s100.uy + w[2]*s010.uy + w[3]*s110.uy +
                              w[4]*s001.uy + w[5]*s101.uy + w[6]*s011.uy + w[7]*s111.uy;
                double uz_i = w[0]*s000.uz + w[1]*s100.uz + w[2]*s010.uz + w[3]*s110.uz +
                              w[4]*s001.uz + w[5]*s101.uz + w[6]*s011.uz + w[7]*s111.uz;
                double p_i = w[0]*s000.p + w[1]*s100.p + w[2]*s010.p + w[3]*s110.p +
                             w[4]*s001.p + w[5]*s101.p + w[6]*s011.p + w[7]*s111.p;

                sC.rho = rho_i;
                sC.p = p_i;

                double u_dot_n = ux_i * nx_u + uy_i * ny_u + uz_i * nz_u;
                sC.ux = ux_i - 2.0 * u_dot_n * nx_u;
                sC.uy = uy_i - 2.0 * u_dot_n * ny_u;
                sC.uz = uz_i - 2.0 * u_dot_n * nz_u;

                sC.peak_overpressure = w[0]*s000.peak_overpressure + w[1]*s100.peak_overpressure + w[2]*s010.peak_overpressure + w[3]*s110.peak_overpressure +
                                       w[4]*s001.peak_overpressure + w[5]*s101.peak_overpressure + w[6]*s011.peak_overpressure + w[7]*s111.peak_overpressure;
                sC.peak_impulse = w[0]*s000.peak_impulse + w[1]*s100.peak_impulse + w[2]*s010.peak_impulse + w[3]*s110.peak_impulse +
                                  w[4]*s001.peak_impulse + w[5]*s101.peak_impulse + w[6]*s011.peak_impulse + w[7]*s111.peak_impulse;

                if constexpr (IsMultiMaterial) {
                    sC.alpha1 = w[0]*s000.alpha1 + w[1]*s100.alpha1 + w[2]*s010.alpha1 + w[3]*s110.alpha1 +
                                w[4]*s001.alpha1 + w[5]*s101.alpha1 + w[6]*s011.alpha1 + w[7]*s111.alpha1;
                    sC.alpha2 = w[0]*s000.alpha2 + w[1]*s100.alpha2 + w[2]*s010.alpha2 + w[3]*s110.alpha2 +
                                w[4]*s001.alpha2 + w[5]*s101.alpha2 + w[6]*s011.alpha2 + w[7]*s111.alpha2;
                    sC.arho1 = w[0]*s000.arho1 + w[1]*s100.arho1 + w[2]*s010.arho1 + w[3]*s110.arho1 +
                               w[4]*s001.arho1 + w[5]*s101.arho1 + w[6]*s011.arho1 + w[7]*s111.arho1;
                    sC.arho2 = w[0]*s000.arho2 + w[1]*s100.arho2 + w[2]*s010.arho2 + w[3]*s110.arho2 +
                               w[4]*s001.arho2 + w[5]*s101.arho2 + w[6]*s011.arho2 + w[7]*s111.arho2;
                } else {
                    sC.alpha1 = 0.0; sC.alpha2 = 0.0; sC.arho1 = 0.0; sC.arho2 = 0.0;
                }

                double ke = 0.5 * sC.rho * (sC.ux*sC.ux + sC.uy*sC.uy + sC.uz*sC.uz);
                if constexpr (IsMultiMaterial) {
                    sC.E = MultiMat::getMixtureEnergy((double)sC.p, (double)sC.rho, (double)sC.alpha1, (double)sC.alpha2, (double)sC.arho1, (double)sC.arho2, d_gamma, d_products, d_unreacted) + ke;
                } else {
                    sC.E = sC.p / (d_gamma - 1.0) + ke;
                }
            } else {
                int dirs[6][3] = {{1,0,0}, {-1,0,0}, {0,1,0}, {0,-1,0}, {0,0,1}, {0,0,-1}};
                int best_dx = 0, best_dy = 0, best_dz = 0;
                float max_dot = -1e9f;
                for(int d=0; d<6; ++d) {
                    int ngx = gx + dirs[d][0];
                    int ngy = gy + dirs[d][1];
                    int ngz = gz + dirs[d][2];
                    if (!get_solid_normal_gpu(geom, ngx, ngy, ngz, dummy1, dummy2, dummy3)) {
                        float dot = dirs[d][0]*nx_u + dirs[d][1]*ny_u + dirs[d][2]*nz_u;
                        if (dot > max_dot) {
                            max_dot = dot; best_dx = dirs[d][0]; best_dy = dirs[d][1]; best_dz = dirs[d][2];
                        }
                    }
                }
                if (max_dot > -1e8f) {
                    auto sn = sample_gpu_raw<RealType, IsMultiMaterial>(states, gx+best_dx, gy+best_dy, gz+best_dz);
                    sC.rho = sn.rho; sC.p = sn.p;
                    sC.peak_overpressure = sn.peak_overpressure;
                    sC.peak_impulse = sn.peak_impulse;
                    if constexpr (IsMultiMaterial) {
                        sC.alpha1=sn.alpha1; sC.alpha2=sn.alpha2; sC.arho1=sn.arho1; sC.arho2=sn.arho2;
                    }
                    double u_dot_n = sn.ux * nx_u + sn.uy * ny_u + sn.uz * nz_u;
                    sC.ux = sn.ux - 2.0 * u_dot_n * nx_u;
                    sC.uy = sn.uy - 2.0 * u_dot_n * ny_u;
                    sC.uz = sn.uz - 2.0 * u_dot_n * nz_u;
                    double ke = 0.5 * sC.rho * (sC.ux*sC.ux + sC.uy*sC.uy + sC.uz*sC.uz);
                    if constexpr (IsMultiMaterial) {
                        sC.E = MultiMat::getMixtureEnergy((double)sC.p, (double)sC.rho, (double)sC.alpha1, (double)sC.alpha2, (double)sC.arho1, (double)sC.arho2, d_gamma, d_products, d_unreacted) + ke;
                    } else {
                        sC.E = sC.p / (d_gamma - 1.0) + ke;
                    }
                }
            }
        }
    }
    return sC;
}

template <typename RealType, bool IsMultiMaterial>
__global__ void extract_obstacles_kernel(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    const GeometryTile3D* geom,
    const GPUObstacleFace* faces,
    float* out_buf,
    int num_faces,
    int qty_id) {

    int f = blockIdx.x * blockDim.x + threadIdx.x;
    if (f >= num_faces) return;

    GPUObstacleFace face = faces[f];
    int t_idx = face.t_idx;
    int c_idx = face.c_idx;

    RealType val = 0.0;
    if (qty_id == 7) { // solid
        val = (geom && geom[t_idx].cells[c_idx].is_boundary) ? 1.0 : 0.0;
    } else {
        val = get_value_by_qty<RealType, IsMultiMaterial>(states[t_idx], c_idx, qty_id);
    }

    out_buf[f] = (float)val;
}

template <typename RealType, bool IsMultiMaterial>
__global__ void extract_slice_kernel(const PrimitiveTile3D<RealType, IsMultiMaterial>* states, const GeometryTile3D* geom, float* data, int nx, int ny, int nz, int axis, double offset, double xmin, double ymin, double zmin, double dx, int qty_id, int stride) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    int j = blockIdx.y * blockDim.y + threadIdx.y;

    int w = 0, h = 0;
    if (axis == 0) { w = (nx + stride - 1) / stride; h = (ny + stride - 1) / stride; }
    else if (axis == 1) { w = (nx + stride - 1) / stride; h = (nz + stride - 1) / stride; }
    else { w = (ny + stride - 1) / stride; h = (nz + stride - 1) / stride; }

    if (i >= w || j >= h) return;

    int gx = i * stride;
    int gy = j * stride;
    int gz = 0;

    if (axis == 0) {
        gz = round((offset - zmin) / dx - 0.5);
        gz = max(0, min(nz - 1, gz));
    } else if (axis == 1) {
        gz = j * stride;
        gy = round((offset - ymin) / dx - 0.5);
        gy = max(0, min(ny - 1, gy));
    } else {
        gz = j * stride;
        gy = i * stride;
        gx = round((offset - xmin) / dx - 0.5);
        gx = max(0, min(nx - 1, gx));
    }

    if (qty_id == 7) {
        if (geom == nullptr) {
            data[i + j * w] = 0.0f;
        } else {
            int tx = gx / 8;
            int ty = gy / 8;
            int tz = gz / 8;
            int ttx = (nx + 7) / 8;
            int tty = (ny + 7) / 8;
            int t_idx = tx + ty * ttx + tz * ttx * tty;
            int cx = gx % 8;
            int cy = gy % 8;
            int cz = gz % 8;
            int c_idx = cx + cy * 8 + cz * 64;
            data[i + j * w] = geom[t_idx].cells[c_idx].is_boundary ? 1.0f : 0.0f;
        }
    } else {
        GPUCellStateT<RealType> sC = sample_state_with_mirror_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz, xmin, ymin, zmin, dx);
        data[i + j * w] = get_value_by_qty_struct<RealType, IsMultiMaterial>(sC, qty_id);
    }
}

template <typename RealType, bool IsMultiMaterial>
CFDSolver3DCuda<RealType, IsMultiMaterial>::CFDSolver3DCuda(int nx, int ny, int nz, double cellSize, double xmin, double ymin, double zmin)
    : CFDSolver3DImplBase(nx, ny, nz, cellSize, xmin, ymin, zmin) {

    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    CHECK_CUDA(cudaMalloc(&d_states, total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>)));
    CHECK_CUDA(cudaMalloc(&d_U, total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>)));
    CHECK_CUDA(cudaMalloc(&d_dU, total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>)));
    CHECK_CUDA(cudaMalloc(&d_geom, total_tiles * sizeof(GeometryTile3D)));
    CHECK_CUDA(cudaMemset(d_geom, 0, total_tiles * sizeof(GeometryTile3D)));
    CHECK_CUDA(cudaMalloc(&d_active_tiles, total_tiles * sizeof(uint8_t)));
    CHECK_CUDA(cudaMalloc(&d_tile_active_temp, total_tiles * sizeof(uint8_t)));
    CHECK_CUDA(cudaMalloc(&d_active_tile_indices, total_tiles * sizeof(int)));
    CHECK_CUDA(cudaMalloc(&d_active_count, sizeof(int)));

    // Pre-allocate auxiliary buffers
    CHECK_CUDA(cudaMalloc(&d_max_s_buf, total_tiles * sizeof(RealType)));
    CHECK_CUDA(cudaMalloc(&d_tile_mass, total_tiles * sizeof(double)));
    CHECK_CUDA(cudaMalloc(&d_tile_energy, total_tiles * sizeof(double)));
    CHECK_CUDA(cudaMalloc(&d_tile_is_near_boundary, total_tiles * sizeof(uint8_t)));
    CHECK_CUDA(cudaMemset(d_tile_is_near_boundary, 0, total_tiles * sizeof(uint8_t)));
    
    size_t max_slice_size = std::max({ (size_t)nx * ny, (size_t)nx * nz, (size_t)ny * nz }) * sizeof(float);
    CHECK_CUDA(cudaMalloc(&d_slice_buf, max_slice_size));
    d_slice_buf_capacity = max_slice_size;

    CHECK_CUDA(cudaMemcpyToSymbol(d_nx, &nx, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_ny, &ny, sizeof(int)));

    CHECK_CUDA(cudaMemcpyToSymbol(d_nz, &nz, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_ntx, &ntx, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_nty, &nty, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_ntz, &ntz, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_cellSize, &cellSize, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_xmin, &xmin, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_ymin, &ymin, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_zmin, &zmin, sizeof(double)));
    double g = gamma;
    CHECK_CUDA(cudaMemcpyToSymbol(d_gamma, &g, sizeof(double)));
    bool useAUSM = false;
    CHECK_CUDA(cudaMemcpyToSymbol(d_useAUSM, &useAUSM, sizeof(bool)));

    is_ideal_gas_val = !IsMultiMaterial;
    updateBoundaryConditions();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::updateBoundaryConditions() {
    int b1 = (int)bcXmin, b2 = (int)bcXmax, b3 = (int)bcYmin, b4 = (int)bcYmax, b5 = (int)bcZmin, b6 = (int)bcZmax;
    CHECK_CUDA(cudaMemcpyToSymbol(d_bcXmin, &b1, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_bcXmax, &b2, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_bcYmin, &b3, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_bcYmax, &b4, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_bcZmin, &b5, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_bcZmax, &b6, sizeof(int)));
}

template <typename RealType, bool IsMultiMaterial>
CFDSolver3DCuda<RealType, IsMultiMaterial>::~CFDSolver3DCuda() {
    if (d_states) cudaFree(d_states);
    if (d_U) cudaFree(d_U);
    if (d_dU) cudaFree(d_dU);
    if (d_geom) cudaFree(d_geom);
    if (d_active_tiles) cudaFree(d_active_tiles);
    if (d_tile_active_temp) cudaFree(d_tile_active_temp);
    if (d_active_tile_indices) cudaFree(d_active_tile_indices);
    if (d_active_count) cudaFree(d_active_count);
    if (d_max_s_buf) cudaFree(d_max_s_buf);
    if (d_slice_buf) { cudaFree(d_slice_buf); d_slice_buf_capacity = 0; }
    if (d_tile_mass) cudaFree(d_tile_mass);
    if (d_tile_energy) cudaFree(d_tile_energy);
    if (d_tile_is_near_boundary) cudaFree(d_tile_is_near_boundary);

    if (d_gauge_coords) cudaFree(d_gauge_coords);
    if (d_gauge_results) cudaFree(d_gauge_results);
    if (host_pinned_gauge_data) cudaFreeHost(host_pinned_gauge_data);
    if (gauge_stream) cudaStreamDestroy((cudaStream_t)gauge_stream);
    if (step_done) cudaEventDestroy((cudaEvent_t)step_done);
    if (d_obstacle_faces) cudaFree(d_obstacle_faces);
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::ensure_paged_out() const {
    if (is_paged_out) return;

    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    paged_states.resize(total_tiles);
    CHECK_CUDA(cudaMemcpy(paged_states.data(), d_states, total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyDeviceToHost));

    paged_U.resize(total_tiles);
    CHECK_CUDA(cudaMemcpy(paged_U.data(), d_U, total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>), cudaMemcpyDeviceToHost));

    if (d_dU) {
        paged_dU.resize(total_tiles);
        CHECK_CUDA(cudaMemcpy(paged_dU.data(), d_dU, total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>), cudaMemcpyDeviceToHost));
        has_paged_dU = true;
    } else {
        has_paged_dU = false;
    }

    if (d_geom) {
        paged_geom.resize(total_tiles);
        CHECK_CUDA(cudaMemcpy(paged_geom.data(), d_geom, total_tiles * sizeof(GeometryTile3D), cudaMemcpyDeviceToHost));
        has_paged_geom = true;
    } else {
        has_paged_geom = false;
    }

    paged_active_tiles.resize(total_tiles);
    CHECK_CUDA(cudaMemcpy(paged_active_tiles.data(), d_active_tiles, total_tiles * sizeof(uint8_t), cudaMemcpyDeviceToHost));

    paged_tile_active_temp.resize(total_tiles);
    CHECK_CUDA(cudaMemcpy(paged_tile_active_temp.data(), d_tile_active_temp, total_tiles * sizeof(uint8_t), cudaMemcpyDeviceToHost));

    if (d_gauge_coords && num_gauges > 0) {
        paged_gauge_coords.resize(num_gauges);
        CHECK_CUDA(cudaMemcpy(paged_gauge_coords.data(), d_gauge_coords, num_gauges * sizeof(GPUGauge3D), cudaMemcpyDeviceToHost));
        has_paged_gauges = true;
    } else {
        has_paged_gauges = false;
    }

    if (d_tile_is_near_boundary) {
        paged_tile_is_near_boundary.resize(total_tiles);
        CHECK_CUDA(cudaMemcpy(paged_tile_is_near_boundary.data(), d_tile_is_near_boundary, total_tiles * sizeof(uint8_t), cudaMemcpyDeviceToHost));
        has_paged_tile_is_near_boundary = true;
    } else {
        has_paged_tile_is_near_boundary = false;
    }

    if (d_obstacle_faces && num_obstacle_faces > 0) {
        paged_obstacle_faces.resize(num_obstacle_faces);
        CHECK_CUDA(cudaMemcpy(paged_obstacle_faces.data(), d_obstacle_faces, num_obstacle_faces * sizeof(GPUObstacleFace), cudaMemcpyDeviceToHost));
        has_paged_obstacle_faces = true;
    } else {
        has_paged_obstacle_faces = false;
    }

    if (d_states) { cudaFree(d_states); d_states = nullptr; }
    if (d_U) { cudaFree(d_U); d_U = nullptr; }
    if (d_dU) { cudaFree(d_dU); d_dU = nullptr; }
    if (d_geom) { cudaFree(d_geom); d_geom = nullptr; }
    if (d_active_tiles) { cudaFree(d_active_tiles); d_active_tiles = nullptr; }
    if (d_tile_active_temp) { cudaFree(d_tile_active_temp); d_tile_active_temp = nullptr; }
    if (d_active_tile_indices) { cudaFree(d_active_tile_indices); d_active_tile_indices = nullptr; }
    if (d_active_count) { cudaFree(d_active_count); d_active_count = nullptr; }
    if (d_max_s_buf) { cudaFree(d_max_s_buf); d_max_s_buf = nullptr; }
    if (d_slice_buf) { cudaFree(d_slice_buf); d_slice_buf = nullptr; d_slice_buf_capacity = 0; }
    if (d_tile_mass) { cudaFree(d_tile_mass); d_tile_mass = nullptr; }
    if (d_tile_energy) { cudaFree(d_tile_energy); d_tile_energy = nullptr; }
    if (d_tile_is_near_boundary) { cudaFree(d_tile_is_near_boundary); d_tile_is_near_boundary = nullptr; }
    if (d_gauge_coords) { cudaFree(d_gauge_coords); d_gauge_coords = nullptr; }
    if (d_gauge_results) { cudaFree(d_gauge_results); d_gauge_results = nullptr; }
    if (d_obstacle_faces) { cudaFree(d_obstacle_faces); d_obstacle_faces = nullptr; }

    is_paged_out = true;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::ensure_paged_in() const {
    if (!is_paged_out) return;

    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    CHECK_CUDA(cudaMalloc(&d_states, total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>)));
    CHECK_CUDA(cudaMalloc(&d_U, total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>)));
    if (has_paged_dU) {
        CHECK_CUDA(cudaMalloc(&d_dU, total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>)));
    } else {
        d_dU = nullptr;
    }
    if (has_paged_geom) {
        CHECK_CUDA(cudaMalloc(&d_geom, total_tiles * sizeof(GeometryTile3D)));
    } else {
        d_geom = nullptr;
    }
    CHECK_CUDA(cudaMalloc(&d_active_tiles, total_tiles * sizeof(uint8_t)));
    CHECK_CUDA(cudaMalloc(&d_tile_active_temp, total_tiles * sizeof(uint8_t)));
    CHECK_CUDA(cudaMalloc(&d_active_tile_indices, total_tiles * sizeof(int)));
    CHECK_CUDA(cudaMalloc(&d_active_count, sizeof(int)));

    CHECK_CUDA(cudaMalloc(&d_max_s_buf, total_tiles * sizeof(RealType)));
    CHECK_CUDA(cudaMalloc(&d_tile_mass, total_tiles * sizeof(double)));
    CHECK_CUDA(cudaMalloc(&d_tile_energy, total_tiles * sizeof(double)));
    CHECK_CUDA(cudaMalloc(&d_tile_is_near_boundary, total_tiles * sizeof(uint8_t)));

    if (has_paged_gauges && num_gauges > 0) {
        CHECK_CUDA(cudaMalloc(&d_gauge_coords, num_gauges * sizeof(GPUGauge3D)));
        CHECK_CUDA(cudaMalloc(&d_gauge_results, num_gauges * 7 * sizeof(float)));
    }

    if (has_paged_obstacle_faces && num_obstacle_faces > 0) {
        CHECK_CUDA(cudaMalloc(&d_obstacle_faces, num_obstacle_faces * sizeof(GPUObstacleFace)));
    }

    CHECK_CUDA(cudaMemcpy(d_states, paged_states.data(), total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyHostToDevice));
    CHECK_CUDA(cudaMemcpy(d_U, paged_U.data(), total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>), cudaMemcpyHostToDevice));
    if (has_paged_dU) {
        CHECK_CUDA(cudaMemcpy(d_dU, paged_dU.data(), total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>), cudaMemcpyHostToDevice));
    }
    if (has_paged_geom) {
        CHECK_CUDA(cudaMemcpy(d_geom, paged_geom.data(), total_tiles * sizeof(GeometryTile3D), cudaMemcpyHostToDevice));
    }
    CHECK_CUDA(cudaMemcpy(d_active_tiles, paged_active_tiles.data(), total_tiles * sizeof(uint8_t), cudaMemcpyHostToDevice));
    CHECK_CUDA(cudaMemcpy(d_tile_active_temp, paged_tile_active_temp.data(), total_tiles * sizeof(uint8_t), cudaMemcpyHostToDevice));

    if (has_paged_tile_is_near_boundary) {
        CHECK_CUDA(cudaMemcpy(d_tile_is_near_boundary, paged_tile_is_near_boundary.data(), total_tiles * sizeof(uint8_t), cudaMemcpyHostToDevice));
    } else {
        CHECK_CUDA(cudaMemset(d_tile_is_near_boundary, 0, total_tiles * sizeof(uint8_t)));
    }

    if (has_paged_gauges && num_gauges > 0) {
        CHECK_CUDA(cudaMemcpy(d_gauge_coords, paged_gauge_coords.data(), num_gauges * sizeof(GPUGauge3D), cudaMemcpyHostToDevice));
    }

    if (has_paged_obstacle_faces && num_obstacle_faces > 0) {
        CHECK_CUDA(cudaMemcpy(d_obstacle_faces, paged_obstacle_faces.data(), num_obstacle_faces * sizeof(GPUObstacleFace), cudaMemcpyHostToDevice));
    }

    paged_states.clear(); paged_states.shrink_to_fit();
    paged_U.clear(); paged_U.shrink_to_fit();
    paged_dU.clear(); paged_dU.shrink_to_fit();
    paged_geom.clear(); paged_geom.shrink_to_fit();
    paged_active_tiles.clear(); paged_active_tiles.shrink_to_fit();
    paged_tile_active_temp.clear(); paged_tile_active_temp.shrink_to_fit();
    paged_tile_is_near_boundary.clear(); paged_tile_is_near_boundary.shrink_to_fit();
    paged_gauge_coords.clear(); paged_gauge_coords.shrink_to_fit();
    paged_obstacle_faces.clear(); paged_obstacle_faces.shrink_to_fit();

    // Rebuild compact active tile index after paging in
    const_cast<CFDSolver3DCuda*>(this)->rebuildActiveIndex();

    is_paged_out = false;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::pause() {
    ensure_paged_out();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::resume() {
    ensure_paged_in();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setDetonatorLocation(double x, double y, double z) {
    detX = x; detY = y; detZ = z;
    CHECK_CUDA(cudaMemcpyToSymbol(d_detX, &x, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_detY, &y, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_detZ, &z, sizeof(double)));
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setInitialCondition(const Charge3DParams& charge, const MultiMat::MaterialSet& materials, double amb_rho, double amb_p) {
    currentMaterials = materials;
    CHECK_CUDA(cudaMemcpyToSymbol(d_ambient_rho, &amb_rho, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_ambient_p, &amb_p, sizeof(double)));
    if constexpr (IsMultiMaterial) {
        CHECK_CUDA(cudaMemcpyToSymbol(d_products, &materials.products, sizeof(MultiMat::JWLParams)));
        CHECK_CUDA(cudaMemcpyToSymbol(d_unreacted, &materials.unreacted, sizeof(MultiMat::JWLParams)));
        CHECK_CUDA(cudaMemcpyToSymbol(d_det_vel, &materials.det_vel, sizeof(double)));
        CHECK_CUDA(cudaMemcpyToSymbol(d_detonation_energy, &materials.detonation_energy, sizeof(double)));
    }
    CHECK_CUDA(cudaMemcpyToSymbol(d_detX, &detX, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_detY, &detY, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_detZ, &detZ, sizeof(double)));

    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    CHECK_CUDA(cudaMemset(d_active_tiles, 0, total_tiles * sizeof(uint8_t)));

    initialize_ambient_kernel<RealType, IsMultiMaterial><<<total_tiles, 512>>>(
        (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
        (RealType)amb_rho, (RealType)amb_p, (RealType)gamma, total_tiles
    );
    CHECK_CUDA(cudaDeviceSynchronize());

    dim3 blocks(ntx, nty, ntz);
    dim3 threads(TILE_SIZE_3D, TILE_SIZE_3D, TILE_SIZE_3D);

    set_initial_condition_kernel<RealType, IsMultiMaterial><<<blocks, threads>>>(
        (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (uint8_t*)d_active_tiles,
        nx, ny, nz, (RealType)cellSize, (RealType)xmin, (RealType)ymin, (RealType)zmin,
        (RealType)amb_rho, (RealType)amb_p, (RealType)gamma, charge,
        (RealType)materials.unreacted.rho0, (RealType)materials.detonation_energy, (RealType)materials.det_vel
    );
    CHECK_CUDA(cudaDeviceSynchronize());
    updateActiveRegions();
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) average_U_kernel_3d(ConservativeTile3D<RealType, IsMultiMaterial>* U, const ConservativeTile3D<RealType, IsMultiMaterial>* U_prev, const int* active_tile_indices, RealType w0, RealType w1) {
    int t_idx = active_tile_indices[blockIdx.x];

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    U[t_idx].rho[c_idx] = w0 * U_prev[t_idx].rho[c_idx] + w1 * U[t_idx].rho[c_idx];
    U[t_idx].rhoux[c_idx] = w0 * U_prev[t_idx].rhoux[c_idx] + w1 * U[t_idx].rhoux[c_idx];
    U[t_idx].rhouy[c_idx] = w0 * U_prev[t_idx].rhouy[c_idx] + w1 * U[t_idx].rhouy[c_idx];
    U[t_idx].rhouz[c_idx] = w0 * U_prev[t_idx].rhouz[c_idx] + w1 * U[t_idx].rhouz[c_idx];
    U[t_idx].E[c_idx] = w0 * U_prev[t_idx].E[c_idx] + w1 * U[t_idx].E[c_idx];
    if constexpr (IsMultiMaterial) {
        U[t_idx].alpha1[c_idx] = w0 * U_prev[t_idx].alpha1[c_idx] + w1 * U[t_idx].alpha1[c_idx];
        U[t_idx].alpha2[c_idx] = w0 * U_prev[t_idx].alpha2[c_idx] + w1 * U[t_idx].alpha2[c_idx];
        U[t_idx].arho1[c_idx] = w0 * U_prev[t_idx].arho1[c_idx] + w1 * U[t_idx].arho1[c_idx];
        U[t_idx].arho2[c_idx] = w0 * U_prev[t_idx].arho2[c_idx] + w1 * U[t_idx].arho2[c_idx];
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) williamson_stage_A_kernel_3d(ConservativeTile3D<RealType, IsMultiMaterial>* dU, const int* active_tile_indices, RealType a) {
    int t_idx = active_tile_indices[blockIdx.x];

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    dU[t_idx].rho[c_idx] = a * dU[t_idx].rho[c_idx];
    dU[t_idx].rhoux[c_idx] = a * dU[t_idx].rhoux[c_idx];
    dU[t_idx].rhouy[c_idx] = a * dU[t_idx].rhouy[c_idx];
    dU[t_idx].rhouz[c_idx] = a * dU[t_idx].rhouz[c_idx];
    dU[t_idx].E[c_idx] = a * dU[t_idx].E[c_idx];
    if constexpr (IsMultiMaterial) {
        dU[t_idx].alpha1[c_idx] = a * dU[t_idx].alpha1[c_idx];
        dU[t_idx].alpha2[c_idx] = a * dU[t_idx].alpha2[c_idx];
        dU[t_idx].arho1[c_idx] = a * dU[t_idx].arho1[c_idx];
        dU[t_idx].arho2[c_idx] = a * dU[t_idx].arho2[c_idx];
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) williamson_stage_B_kernel_3d(ConservativeTile3D<RealType, IsMultiMaterial>* U, const ConservativeTile3D<RealType, IsMultiMaterial>* dU, const int* active_tile_indices, RealType b) {
    int t_idx = active_tile_indices[blockIdx.x];

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    U[t_idx].rho[c_idx] += b * dU[t_idx].rho[c_idx];
    U[t_idx].rhoux[c_idx] += b * dU[t_idx].rhoux[c_idx];
    U[t_idx].rhouy[c_idx] += b * dU[t_idx].rhouy[c_idx];
    U[t_idx].rhouz[c_idx] += b * dU[t_idx].rhouz[c_idx];
    U[t_idx].E[c_idx] += b * dU[t_idx].E[c_idx];
    if constexpr (IsMultiMaterial) {
        U[t_idx].alpha1[c_idx] += b * dU[t_idx].alpha1[c_idx];
        U[t_idx].alpha2[c_idx] += b * dU[t_idx].alpha2[c_idx];
        U[t_idx].arho1[c_idx] += b * dU[t_idx].arho1[c_idx];
        U[t_idx].arho2[c_idx] += b * dU[t_idx].arho2[c_idx];
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) update_peak_quantities_kernel_3d(
    PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    const int* active_tile_indices,
    RealType ambient_p,
    RealType dt
) {
    int t_idx = active_tile_indices[blockIdx.x];
    int tx = t_idx % d_ntx;
    int ty = (t_idx / d_ntx) % d_nty;
    int tz = t_idx / (d_ntx * d_nty);

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    int gx = tx * TILE_SIZE_3D + lx;
    int gy = ty * TILE_SIZE_3D + ly;
    int gz = tz * TILE_SIZE_3D + lz;

    if (gx >= d_nx || gy >= d_ny || gz >= d_nz) return;

    RealType op = states[t_idx].p[c_idx] - ambient_p;
    if (op < (RealType)0.0) op = (RealType)0.0;
    if (op > states[t_idx].peak_overpressure[c_idx]) {
        states[t_idx].peak_overpressure[c_idx] = op;
    }
    states[t_idx].running_impulse[c_idx] += op * dt;
    if (states[t_idx].running_impulse[c_idx] > states[t_idx].peak_impulse[c_idx]) {
        states[t_idx].peak_impulse[c_idx] = states[t_idx].running_impulse[c_idx];
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::step(double dt) {
    ensure_paged_in();
    if (h_num_active_tiles == 0) {
        currentTime += dt;
        return;
    }

    RealType dt_r = (RealType)dt;
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    int n_active = h_num_active_tiles;
    dim3 threads(TILE_SIZE_3D, TILE_SIZE_3D, TILE_SIZE_3D);

    if (temporalOrder == 1) {
        compute_flux_x_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const int*)d_active_tile_indices, (const uint8_t*)d_tile_is_near_boundary, (const GeometryTile3D*)d_geom, dt_r);
        compute_flux_y_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const int*)d_active_tile_indices, (const uint8_t*)d_tile_is_near_boundary, (const GeometryTile3D*)d_geom, dt_r);
        compute_flux_z_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const int*)d_active_tile_indices, (const uint8_t*)d_tile_is_near_boundary, (const GeometryTile3D*)d_geom, dt_r);
    } else if (temporalOrder == 2) {
        // RK2
        CHECK_CUDA(cudaMemcpy(d_dU, d_U, total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>), cudaMemcpyDeviceToDevice));
        compute_flux_x_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const int*)d_active_tile_indices, (const uint8_t*)d_tile_is_near_boundary, (const GeometryTile3D*)d_geom, dt_r);
        compute_flux_y_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const int*)d_active_tile_indices, (const uint8_t*)d_tile_is_near_boundary, (const GeometryTile3D*)d_geom, dt_r);
        compute_flux_z_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const int*)d_active_tile_indices, (const uint8_t*)d_tile_is_near_boundary, (const GeometryTile3D*)d_geom, dt_r);
        
        update_primitive_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const int*)d_active_tile_indices, (const GeometryTile3D*)d_geom);
 
        compute_flux_x_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const int*)d_active_tile_indices, (const uint8_t*)d_tile_is_near_boundary, (const GeometryTile3D*)d_geom, dt_r);
        compute_flux_y_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const int*)d_active_tile_indices, (const uint8_t*)d_tile_is_near_boundary, (const GeometryTile3D*)d_geom, dt_r);
        compute_flux_z_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const int*)d_active_tile_indices, (const uint8_t*)d_tile_is_near_boundary, (const GeometryTile3D*)d_geom, dt_r);
        average_U_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const ConservativeTile3D<RealType, IsMultiMaterial>*)d_dU, (const int*)d_active_tile_indices, (RealType)0.5, (RealType)0.5);
    } else { // Williamson Low-Storage RK3
        const RealType A[3] = { (RealType)0.0, (RealType)(-5.0/9.0), (RealType)(-153.0/128.0) };
        const RealType B[3] = { (RealType)(1.0/3.0), (RealType)(15.0/16.0), (RealType)(8.0/15.0) };
 
        for (int stage = 0; stage < 3; ++stage) {
            williamson_stage_A_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((ConservativeTile3D<RealType, IsMultiMaterial>*)d_dU, (const int*)d_active_tile_indices, A[stage]);
            compute_flux_x_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_dU, (const int*)d_active_tile_indices, (const uint8_t*)d_tile_is_near_boundary, (const GeometryTile3D*)d_geom, dt_r);
            compute_flux_y_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_dU, (const int*)d_active_tile_indices, (const uint8_t*)d_tile_is_near_boundary, (const GeometryTile3D*)d_geom, dt_r);
            compute_flux_z_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_dU, (const int*)d_active_tile_indices, (const uint8_t*)d_tile_is_near_boundary, (const GeometryTile3D*)d_geom, dt_r);
            williamson_stage_B_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const ConservativeTile3D<RealType, IsMultiMaterial>*)d_dU, (const int*)d_active_tile_indices, B[stage]);
 
            update_primitive_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const int*)d_active_tile_indices, (const GeometryTile3D*)d_geom);
        }
    }

    if constexpr (IsMultiMaterial) {
        applyProgrammedBurn_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const int*)d_active_tile_indices, (RealType)currentTime, dt_r);
    }

    update_primitive_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const int*)d_active_tile_indices, (const GeometryTile3D*)d_geom);
    update_peak_quantities_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (const int*)d_active_tile_indices, (RealType)ambient_p, dt_r);
    
    CHECK_CUDA(cudaDeviceSynchronize());
    currentTime += dt;
    updateActiveRegions();
}


template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setFluxScheme(const std::string& name) {
    currentFluxScheme = name;
    bool useAUSM = (name == "AUSM+");
    CHECK_CUDA(cudaMemcpyToSymbol(d_useAUSM, &useAUSM, sizeof(bool)));
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) compute_max_speed_kernel_3d(const PrimitiveTile3D<RealType, IsMultiMaterial>* states, const int* active_tile_indices, RealType gamma, RealType* max_s_block) {
    int t_idx = active_tile_indices[blockIdx.x];
    int tx = t_idx % d_ntx;
    int ty = (t_idx / d_ntx) % d_nty;
    int tz = t_idx / (d_ntx * d_nty);

    __shared__ RealType sdata[512];
    int tid = threadIdx.x + threadIdx.y * blockDim.x + threadIdx.z * blockDim.x * blockDim.y;

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    int gx = tx * TILE_SIZE_3D + lx;
    int gy = ty * TILE_SIZE_3D + ly;
    int gz = tz * TILE_SIZE_3D + lz;

    RealType max_s = (RealType)1e-6;
    if (gx < d_nx && gy < d_ny && gz < d_nz) {
        RealType rho = states[t_idx].rho[c_idx];
        RealType ux = states[t_idx].ux[c_idx];
        RealType uy = states[t_idx].uy[c_idx];
        RealType uz = states[t_idx].uz[c_idx];
        RealType p = states[t_idx].p[c_idx];

        RealType u_mag = sqrt(ux*ux + uy*uy + uz*uz);
        RealType c;
        if constexpr (IsMultiMaterial) {
            c = (RealType)MultiMat::getMixtureSoundSpeed((double)p, (double)rho, (double)states[t_idx].alpha1[c_idx], (double)states[t_idx].alpha2[c_idx], (double)states[t_idx].arho1[c_idx], (double)states[t_idx].arho2[c_idx], (double)gamma, d_products, d_unreacted);
        } else {
            c = sqrt(gamma * p / max((RealType)1e-6, rho));
        }
        max_s = u_mag + c;
    }

    sdata[tid] = max_s;
    __syncthreads();

    for (unsigned int s = blockDim.x * blockDim.y * blockDim.z / 2; s > 0; s >>= 1) {
        if (tid < s) {
            sdata[tid] = fmax(sdata[tid], sdata[tid + s]);
        }
        __syncthreads();
    }

    if (tid == 0) max_s_block[blockIdx.x] = sdata[tid];
}

// Second-pass GPU reduction: reduces n_active per-tile max values to a single scalar
template <typename RealType>
__global__ void reduce_max_kernel(const RealType* data, int n, RealType* result) {
    __shared__ RealType sdata[256];
    int tid = threadIdx.x;
    RealType val = (RealType)1e-6;
    for (int i = tid; i < n; i += blockDim.x) {
        val = fmax(val, data[i]);
    }
    sdata[tid] = val;
    __syncthreads();
    for (unsigned int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s) sdata[tid] = fmax(sdata[tid], sdata[tid + s]);
        __syncthreads();
    }
    if (tid == 0) result[0] = sdata[0];
}

template <typename RealType, bool IsMultiMaterial>
double CFDSolver3DCuda<RealType, IsMultiMaterial>::computeStepSize(double cfl) const {
    ensure_paged_in();
    if (h_num_active_tiles == 0) return 1e-6;

    int n_active = h_num_active_tiles;
    dim3 threads(8, 8, 8);
    compute_max_speed_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (const int*)d_active_tile_indices, (RealType)gamma, (RealType*)d_max_s_buf);

    // GPU-side second-pass reduction to a single scalar
    reduce_max_kernel<RealType><<<1, 256>>>((const RealType*)d_max_s_buf, n_active, (RealType*)d_max_s_buf);

    RealType h_max_s;
    CHECK_CUDA(cudaMemcpy(&h_max_s, d_max_s_buf, sizeof(RealType), cudaMemcpyDeviceToHost));

    double max_s = fmax(1e-6, (double)h_max_s);
    return cfl * cellSize / max_s;
}

template <typename RealType, bool IsMultiMaterial>
std::vector<float> CFDSolver3DCuda<RealType, IsMultiMaterial>::sampleGauge(const Gauge3D& gauge) const {
    ensure_paged_in();
    int gx = std::clamp((int)((gauge.x - xmin) / cellSize), 0, nx - 1);
    int gy = std::clamp((int)((gauge.y - ymin) / cellSize), 0, ny - 1);
    int gz = std::clamp((int)((gauge.z - zmin) / cellSize), 0, nz - 1);

    // Apply the same obstacle-snapping logic as setGauges so one-off samples are consistent.
    {
        int ntx_sg = (nx + 7) / 8;
        const bool has_geom_sg = !global_geometry_tiles.empty()
                               && (int)global_geometry_tiles.size() == ntx_sg * ((ny+7)/8) * ((nz+7)/8);
        auto sg_is_solid = [&](int i, int j, int k) -> bool {
            if (!has_geom_sg) return false;
            if (i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k >= nz) return false;
            int ti = i/TILE_SIZE_3D, tj = j/TILE_SIZE_3D, tk = k/TILE_SIZE_3D;
            int t = ti + tj*ntx_sg + tk*ntx_sg*((ny+7)/8);
            int c = (i&7) + (j&7)*8 + (k&7)*64;
            return global_geometry_tiles[t].cells[c].is_boundary;
        };
        auto sg_is_contact = [&](int i, int j, int k) -> bool {
            const int fd[6][3]={{1,0,0},{-1,0,0},{0,1,0},{0,-1,0},{0,0,1},{0,0,-1}};
            for (auto& d : fd) if (sg_is_solid(i+d[0],j+d[1],k+d[2])) return true;
            return false;
        };
        if (has_geom_sg) {
            bool near = sg_is_solid(gx, gy, gz);
            if (!near) {
                for (int dz=-2; dz<=2 && !near; ++dz)
                for (int dy=-2; dy<=2 && !near; ++dy)
                for (int dx=-2; dx<=2 && !near; ++dx)
                    if (std::sqrt((float)(dx*dx+dy*dy+dz*dz)) <= 1.999f && sg_is_solid(gx+dx,gy+dy,gz+dz)) near = true;
            }
            if (near) {
                int bx=-1,by=-1,bz=-1; float bd=1e9f;
                int fx=-1,fy=-1,fz=-1; float fd2=1e9f;
                for (int dz=-3;dz<=3;++dz) for (int dy=-3;dy<=3;++dy) for (int dx=-3;dx<=3;++dx) {
                    int cx=gx+dx,cy=gy+dy,cz=gz+dz;
                    if (cx<0||cx>=nx||cy<0||cy>=ny||cz<0||cz>=nz) continue;
                    if (sg_is_solid(cx,cy,cz)) continue;
                    float d2=std::sqrt((float)(dx*dx+dy*dy+dz*dz));
                    if (sg_is_contact(cx,cy,cz) && d2<bd) { bd=d2; bx=cx; by=cy; bz=cz; }
                    if (d2<fd2) { fd2=d2; fx=cx; fy=cy; fz=cz; }
                }
                if (bx>=0) { gx=bx; gy=by; gz=bz; }
                else if (fx>=0) { gx=fx; gy=fy; gz=fz; }
            }
        }
    }

    int tx = gx / TILE_SIZE_3D, ty = gy / TILE_SIZE_3D, tz = gz / TILE_SIZE_3D;
    int t_idx = tx + ty * ((nx+7)/8) + tz * ((nx+7)/8) * ((ny+7)/8);
    int lx = gx % TILE_SIZE_3D, ly = gy % TILE_SIZE_3D, lz = gz % TILE_SIZE_3D;
    int c_idx = lx + ly * 8 + lz * 64;

    PrimitiveTile3D<RealType, IsMultiMaterial> h_tile;
    CHECK_CUDA(cudaMemcpy(&h_tile, (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states + t_idx, sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyDeviceToHost));

    std::vector<float> vals(7, 0.0f);
    vals[0] = (float)h_tile.p[c_idx]; vals[1] = (float)h_tile.rho[c_idx];
    vals[2] = (float)sqrt((double)(h_tile.ux[c_idx]*h_tile.ux[c_idx] + h_tile.uy[c_idx]*h_tile.uy[c_idx] + h_tile.uz[c_idx]*h_tile.uz[c_idx]));

    RealType ke = (RealType)0.5 * h_tile.rho[c_idx] * (h_tile.ux[c_idx]*h_tile.ux[c_idx] + h_tile.uy[c_idx]*h_tile.uy[c_idx] + h_tile.uz[c_idx]*h_tile.uz[c_idx]);
    RealType total_E;
    if constexpr (IsMultiMaterial) {
        total_E = (RealType)MultiMat::getMixtureEnergy((double)h_tile.p[c_idx], (double)h_tile.rho[c_idx], (double)h_tile.alpha1[c_idx], (double)h_tile.alpha2[c_idx], (double)h_tile.arho1[c_idx], (double)h_tile.arho2[c_idx], gamma, d_products, d_unreacted) + ke;
    } else {
        total_E = h_tile.p[c_idx] / (gamma - (RealType)1.0) + ke;
    }
    vals[3] = (float)(total_E / max((RealType)1e-6, h_tile.rho[c_idx]));

    if constexpr (IsMultiMaterial) {
        vals[4] = (float)h_tile.alpha1[c_idx];
        vals[5] = (float)h_tile.alpha2[c_idx];
        vals[6] = (float)(1.0 - h_tile.alpha1[c_idx] - h_tile.alpha2[c_idx]);
    } else {
        vals[6] = 1.0f;
    }
    return vals;
}

template <typename RealType, bool IsMultiMaterial>
std::vector<float> CFDSolver3DCuda<RealType, IsMultiMaterial>::getCellValues(int gx, int gy, int gz) const {
    ensure_paged_in();
    gx = std::clamp(gx, 0, nx - 1);
    gy = std::clamp(gy, 0, ny - 1);
    gz = std::clamp(gz, 0, nz - 1);

    int tx = gx / TILE_SIZE_3D, ty = gy / TILE_SIZE_3D, tz = gz / TILE_SIZE_3D;
    int t_idx = tx + ty * ((nx+7)/8) + tz * ((nx+7)/8) * ((ny+7)/8);
    int lx = gx % TILE_SIZE_3D, ly = gy % TILE_SIZE_3D, lz = gz % TILE_SIZE_3D;
    int c_idx = lx + ly * 8 + lz * 64;

    if (t_idx != last_cached_tile_idx) {
        CHECK_CUDA(cudaMemcpy(&cached_tile, (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states + t_idx, sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyDeviceToHost));
        last_cached_tile_idx = t_idx;
    }

    std::vector<float> vals(10, 0.0f);
    vals[0] = (float)cached_tile.p[c_idx]; vals[1] = (float)cached_tile.rho[c_idx];
    vals[2] = (float)sqrt((double)(cached_tile.ux[c_idx]*cached_tile.ux[c_idx] + cached_tile.uy[c_idx]*cached_tile.uy[c_idx] + cached_tile.uz[c_idx]*cached_tile.uz[c_idx]));

    RealType ke = (RealType)0.5 * cached_tile.rho[c_idx] * (cached_tile.ux[c_idx]*cached_tile.ux[c_idx] + cached_tile.uy[c_idx]*cached_tile.uy[c_idx] + cached_tile.uz[c_idx]*cached_tile.uz[c_idx]);
    RealType total_E;
    if constexpr (IsMultiMaterial) {
        total_E = (RealType)MultiMat::getMixtureEnergy((double)cached_tile.p[c_idx], (double)cached_tile.rho[c_idx], (double)cached_tile.alpha1[c_idx], (double)cached_tile.alpha2[c_idx], (double)cached_tile.arho1[c_idx], (double)cached_tile.arho2[c_idx], gamma, d_products, d_unreacted) + ke;
    } else {
        total_E = cached_tile.p[c_idx] / (gamma - (RealType)1.0) + ke;
    }
    vals[3] = (float)(total_E / max((RealType)1e-6, cached_tile.rho[c_idx]));
    if constexpr (IsMultiMaterial) {
        vals[4] = (float)cached_tile.alpha1[c_idx];
        vals[5] = (float)cached_tile.alpha2[c_idx];
        vals[6] = (float)(1.0 - cached_tile.alpha1[c_idx] - cached_tile.alpha2[c_idx]);
    } else {
        vals[6] = 1.0f;
    }

    if (d_geom != nullptr) {
        GeometryTile3D cached_geom_tile;
        CHECK_CUDA(cudaMemcpy(&cached_geom_tile, (const GeometryTile3D*)d_geom + t_idx, sizeof(GeometryTile3D), cudaMemcpyDeviceToHost));
        vals[7] = cached_geom_tile.cells[c_idx].is_boundary ? 1.0f : 0.0f;
    }
    vals[8] = (float)cached_tile.peak_overpressure[c_idx];
    vals[9] = (float)cached_tile.peak_impulse[c_idx];
    return vals;
}

template <typename RealType, bool IsMultiMaterial>
std::vector<float> CFDSolver3DCuda<RealType, IsMultiMaterial>::extractSlice(const Slice3D& slice) const {
    ensure_paged_in();
    std::vector<float> h_data;
    bool is_obstacles = (slice.axis == "obstacles");

    std::string qty = (slice.quantities.empty()) ? "pressure" : slice.quantities[0];
    int qty_id = 0;
    if (qty == "density" || qty == "rho") qty_id = 1;
    else if (qty == "velocity" || qty == "speed") qty_id = 2;
    else if (qty == "energy" || qty == "internal_energy") qty_id = 3;
    else if (qty == "species1" || qty == "alpha1") qty_id = 4;
    else if (qty == "species2" || qty == "alpha2") qty_id = 5;
    else if (qty == "species3") qty_id = 6;
    else if (qty == "solid") qty_id = 7;
    else if (qty == "overpressure" || qty == "peak_overpressure") qty_id = 8;
    else if (qty == "impulse" || qty == "peak_impulse") qty_id = 9;

    if (is_obstacles) {
        if (num_obstacle_faces == 0 || d_obstacle_faces == nullptr) {
            return h_data;
        }
        h_data.resize(num_obstacle_faces, 0.0f);
        size_t required_size = (size_t)num_obstacle_faces * sizeof(float);
        if (d_slice_buf_capacity < required_size) {
            if (d_slice_buf) cudaFree(d_slice_buf);
            d_slice_buf_capacity = required_size;
            CHECK_CUDA(cudaMalloc(&d_slice_buf, d_slice_buf_capacity));
        }

        dim3 threads(256);
        dim3 blocks((num_obstacle_faces + 255) / 256);
        extract_obstacles_kernel<RealType, IsMultiMaterial><<<blocks, threads>>>(
            (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (const GeometryTile3D*)d_geom,
            (const GPUObstacleFace*)d_obstacle_faces,
            (float*)d_slice_buf,
            num_obstacle_faces,
            qty_id
        );
        CHECK_CUDA(cudaDeviceSynchronize());
        CHECK_CUDA(cudaMemcpy(h_data.data(), d_slice_buf, required_size, cudaMemcpyDeviceToHost));
        return h_data;
    }

    int axis = (slice.axis == "xy" ? 0 : (slice.axis == "xz" ? 1 : 2));
    int stride = slice.stride > 0 ? slice.stride : 1;
    int w = 0, h = 0;
    if (axis == 0) { w = (nx + stride - 1) / stride; h = (ny + stride - 1) / stride; }
    else if (axis == 1) { w = (nx + stride - 1) / stride; h = (nz + stride - 1) / stride; }
    else { w = (ny + stride - 1) / stride; h = (nz + stride - 1) / stride; }

    h_data.resize(w * h, 0.0f);
    dim3 blocks((w+15)/16, (h+15)/16);
    dim3 threads(16, 16);

    size_t required_size = (size_t)w * (size_t)h * sizeof(float);
    if (d_slice_buf_capacity < required_size) {
        if (d_slice_buf) cudaFree(d_slice_buf);
        d_slice_buf_capacity = required_size;
        CHECK_CUDA(cudaMalloc(&d_slice_buf, d_slice_buf_capacity));
    }

    extract_slice_kernel<RealType, IsMultiMaterial><<<blocks, threads>>>((const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (const GeometryTile3D*)d_geom, (float*)d_slice_buf, nx, ny, nz, axis, slice.offset, xmin, ymin, zmin, cellSize, qty_id, stride);
    CHECK_CUDA(cudaDeviceSynchronize());
    CHECK_CUDA(cudaMemcpy(h_data.data(), d_slice_buf, required_size, cudaMemcpyDeviceToHost));

    return h_data;
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) check_active_tiles_kernel(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    const uint8_t* active_tiles,
    uint8_t* temp_active,
    int nx, int ny, int nz) {

    int t_idx = blockIdx.x;
    if (!active_tiles[t_idx]) {
        if (threadIdx.x == 0) {
            temp_active[t_idx] = 0;
        }
        return;
    }

    int tx = blockIdx.x % d_ntx;
    int ty = (blockIdx.x / d_ntx) % d_nty;
    int tz = blockIdx.x / (d_ntx * d_nty);

    int lx = threadIdx.x % TILE_SIZE_3D;
    int ly = (threadIdx.x / TILE_SIZE_3D) % TILE_SIZE_3D;
    int lz = threadIdx.x / (TILE_SIZE_3D * TILE_SIZE_3D);
    int c_idx = threadIdx.x;

    int gx = tx * TILE_SIZE_3D + lx;
    int gy = ty * TILE_SIZE_3D + ly;
    int gz = tz * TILE_SIZE_3D + lz;

    __shared__ int s_active;
    if (threadIdx.x == 0) {
        s_active = 0;
    }
    __syncthreads();

    if (gx < nx && gy < ny && gz < nz) {
        RealType p_val = states[t_idx].p[c_idx];
        RealType ux = states[t_idx].ux[c_idx];
        RealType uy = states[t_idx].uy[c_idx];
        RealType uz = states[t_idx].uz[c_idx];
        RealType alpha2 = (RealType)0.0;
        if constexpr (IsMultiMaterial) {
            alpha2 = states[t_idx].alpha2[c_idx];
        }

        double u2 = (double)(ux * ux + uy * uy + uz * uz);
        double dp = fabs((double)p_val - d_ambient_p);
        double a2 = (double)alpha2;

        if (a2 > 1e-4 || dp > 1e-3 * d_ambient_p || u2 > 1e-2) {
            s_active = 1;
        }
    }
    __syncthreads();

    if (threadIdx.x == 0) {
        temp_active[t_idx] = s_active;
    }
}

__global__ void dilate_active_tiles_kernel(
    const uint8_t* temp_active,
    uint8_t* active_tiles,
    int ntx, int nty, int ntz) {

    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total_tiles = ntx * nty * ntz;
    if (idx >= total_tiles) return;

    int tx = idx % ntx;
    int ty = (idx / ntx) % nty;
    int tz = idx / (ntx * nty);

    uint8_t act = temp_active[idx];
    if (!act) {
        if (tx > 0) act |= temp_active[idx - 1];
        if (tx < ntx - 1) act |= temp_active[idx + 1];
        if (ty > 0) act |= temp_active[idx - ntx];
        if (ty < nty - 1) act |= temp_active[idx + ntx];
        if (tz > 0) act |= temp_active[idx - ntx * nty];
        if (tz < ntz - 1) act |= temp_active[idx + ntx * nty];
    }
    active_tiles[idx] = act;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::updateActiveRegions() {
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    check_active_tiles_kernel<RealType, IsMultiMaterial><<<total_tiles, 512>>>(
        (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
        (const uint8_t*)d_active_tiles,
        (uint8_t*)d_tile_active_temp,
        nx, ny, nz
    );

    int threads = 256;
    int blocks = (total_tiles + threads - 1) / threads;
    dilate_active_tiles_kernel<<<blocks, threads>>>(
        (const uint8_t*)d_tile_active_temp,
        (uint8_t*)d_active_tiles,
        ntx, nty, ntz
    );

    rebuildActiveIndex();
}

// Stream-compaction kernel: builds a compact list of active tile indices
__global__ void compact_active_tiles_kernel(
    const uint8_t* active_tiles,
    int* active_tile_indices,
    int* active_count,
    int total_tiles
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= total_tiles) return;
    if (active_tiles[idx]) {
        int pos = atomicAdd(active_count, 1);
        active_tile_indices[pos] = idx;
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::rebuildActiveIndex() {
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    // Reset the device counter to 0
    CHECK_CUDA(cudaMemset(d_active_count, 0, sizeof(int)));

    int threads = 256;
    int blocks = (total_tiles + threads - 1) / threads;
    compact_active_tiles_kernel<<<blocks, threads>>>(
        (const uint8_t*)d_active_tiles,
        (int*)d_active_tile_indices,
        (int*)d_active_count,
        total_tiles
    );

    // Copy the count back to the host
    CHECK_CUDA(cudaMemcpy(&h_num_active_tiles, d_active_count, sizeof(int), cudaMemcpyDeviceToHost));
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::initializeFrom1D(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d, double x_expl, double y_expl, double z_expl, double R_remap) {
    ensure_paged_in();
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    double amb_rho = states_1d.back().rho;
    double amb_p = states_1d.back().p;
    ambient_rho = amb_rho;
    ambient_p = amb_p;

    // 1. Initialize d_states and d_U to ambient on the device
    initialize_ambient_kernel<RealType, IsMultiMaterial><<<total_tiles, 512>>>(
        (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
        (RealType)amb_rho, (RealType)amb_p, (RealType)gamma, total_tiles
    );
    CHECK_CUDA(cudaDeviceSynchronize());
    CHECK_CUDA(cudaMemset(d_active_tiles, 0, total_tiles * sizeof(uint8_t)));

    // 2. Prepare host sparse pointer vector
    std::vector<PrimitiveTile3D<RealType, IsMultiMaterial>*> h_tiles(total_tiles, nullptr);
    temp_h_tiles_ptr = &h_tiles;

    // 3. Remap onto the host sparse pointer vector
    remap_1d_to_3d(r_1d, states_1d, *this, x_expl, y_expl, z_expl, R_remap);

    commitStates();

    for (auto* ptr : h_tiles) {
        delete ptr;
    }
    temp_h_tiles_ptr = nullptr;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setCellStateMulti(int i, int j, int k, const CellState3D<true>& s) {
    int ntx = (nx + 7) / 8;
    int nty = (ny + 7) / 8;
    int tx = i / TILE_SIZE_3D, ty = j / TILE_SIZE_3D, tz = k / TILE_SIZE_3D;
    int t_idx = tx + ty * ntx + tz * ntx * nty;
    int lx = i % TILE_SIZE_3D, ly = j % TILE_SIZE_3D, lz = k % TILE_SIZE_3D;
    int c_idx = lx + ly * 8 + lz * 64;

    if (temp_h_tiles_ptr) {
        auto& h_tiles = *temp_h_tiles_ptr;
        if (!h_tiles[t_idx]) {
            #pragma omp critical
            {
                if (!h_tiles[t_idx]) {
                    auto* tile = new PrimitiveTile3D<RealType, IsMultiMaterial>();
                    for (int c = 0; c < TILE_CELLS_3D; ++c) {
                        tile->rho[c] = (RealType)ambient_rho;
                        tile->ux[c] = 0.0;
                        tile->uy[c] = 0.0;
                        tile->uz[c] = 0.0;
                        tile->p[c] = (RealType)ambient_p;
                        if constexpr (IsMultiMaterial) {
                            tile->alpha1[c] = 0.0;
                            tile->alpha2[c] = 0.0;
                            tile->arho1[c] = 0.0;
                            tile->arho2[c] = 0.0;
                        }
                        tile->floor_status[c] = 0;
                        tile->peak_overpressure[c] = 0.0;
                        tile->running_impulse[c] = 0.0;
                        tile->peak_impulse[c] = 0.0;
                    }
                    h_tiles[t_idx] = tile;
                    std::cout << "[CUDA TILE ACTIVE] " << t_idx << " (tx=" << tx << ", ty=" << ty << ", tz=" << tz << ")\n";
                }
            }
        }
        auto* tile = h_tiles[t_idx];
        tile->rho[c_idx] = (RealType)s.rho;
        tile->ux[c_idx] = (RealType)s.ux;
        tile->uy[c_idx] = (RealType)s.uy;
        tile->uz[c_idx] = (RealType)s.uz;
        tile->p[c_idx] = (RealType)s.p;
        if constexpr (IsMultiMaterial) {
            tile->alpha1[c_idx] = (RealType)s.alpha1;
            tile->alpha2[c_idx] = (RealType)s.alpha2;
            tile->arho1[c_idx] = (RealType)s.arho1;
            tile->arho2[c_idx] = (RealType)s.arho2;
        }
    } else {
        PrimitiveTile3D<RealType, IsMultiMaterial> h_tile;
        CHECK_CUDA(cudaMemcpy(&h_tile, (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states + t_idx, sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyDeviceToHost));
        h_tile.rho[c_idx] = (RealType)s.rho; h_tile.ux[c_idx] = (RealType)s.ux; h_tile.uy[c_idx] = (RealType)s.uy; h_tile.uz[c_idx] = (RealType)s.uz;
        h_tile.p[c_idx] = (RealType)s.p;
        if constexpr (IsMultiMaterial) {
            h_tile.alpha1[c_idx] = (RealType)s.alpha1;
            h_tile.alpha2[c_idx] = (RealType)s.alpha2;
            h_tile.arho1[c_idx] = (RealType)s.arho1;
            h_tile.arho2[c_idx] = (RealType)s.arho2;
        }
        CHECK_CUDA(cudaMemcpy((PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states + t_idx, &h_tile, sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyHostToDevice));

        uint8_t active = 1;
        CHECK_CUDA(cudaMemcpy((uint8_t*)d_active_tiles + t_idx, &active, 1, cudaMemcpyHostToDevice));
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setCellStateIdeal(int i, int j, int k, const CellState3D<false>& s) {
    int tx = i / TILE_SIZE_3D;
    int ty = j / TILE_SIZE_3D;
    int tz = k / TILE_SIZE_3D;
    int ntx = (nx + 7) / 8;
    int nty = (ny + 7) / 8;
    int t_idx = tx + ty * ntx + tz * ntx * nty;
    int lx = i % TILE_SIZE_3D, ly = j % TILE_SIZE_3D, lz = k % TILE_SIZE_3D;
    int c_idx = lx + ly * 8 + lz * 64;

    if (temp_h_tiles_ptr) {
        auto& h_tiles = *temp_h_tiles_ptr;
        if (!h_tiles[t_idx]) {
            #pragma omp critical
            {
                if (!h_tiles[t_idx]) {
                    auto* tile = new PrimitiveTile3D<RealType, IsMultiMaterial>();
                    for (int c = 0; c < TILE_CELLS_3D; ++c) {
                        tile->rho[c] = (RealType)ambient_rho;
                        tile->ux[c] = 0.0;
                        tile->uy[c] = 0.0;
                        tile->uz[c] = 0.0;
                        tile->p[c] = (RealType)ambient_p;
                        if constexpr (IsMultiMaterial) {
                            tile->alpha1[c] = 0.0;
                            tile->alpha2[c] = 0.0;
                            tile->arho1[c] = 0.0;
                            tile->arho2[c] = 0.0;
                        }
                        tile->floor_status[c] = 0;
                        tile->peak_overpressure[c] = 0.0;
                        tile->running_impulse[c] = 0.0;
                        tile->peak_impulse[c] = 0.0;
                    }
                    h_tiles[t_idx] = tile;
                    std::cout << "[CUDA TILE ACTIVE] " << t_idx << " (tx=" << tx << ", ty=" << ty << ", tz=" << tz << ")\n";
                }
            }
        }
        auto* tile = h_tiles[t_idx];
        tile->rho[c_idx] = (RealType)s.rho;
        tile->ux[c_idx] = (RealType)s.ux;
        tile->uy[c_idx] = (RealType)s.uy;
        tile->uz[c_idx] = (RealType)s.uz;
        tile->p[c_idx] = (RealType)s.p;
    } else {
        PrimitiveTile3D<RealType, IsMultiMaterial> h_tile;
        CHECK_CUDA(cudaMemcpy(&h_tile, (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states + t_idx, sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyDeviceToHost));
        h_tile.rho[c_idx] = (RealType)s.rho; h_tile.ux[c_idx] = (RealType)s.ux; h_tile.uy[c_idx] = (RealType)s.uy; h_tile.uz[c_idx] = (RealType)s.uz;
        h_tile.p[c_idx] = (RealType)s.p;
        CHECK_CUDA(cudaMemcpy((PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states + t_idx, &h_tile, sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyHostToDevice));

        uint8_t active = 1;
        CHECK_CUDA(cudaMemcpy((uint8_t*)d_active_tiles + t_idx, &active, 1, cudaMemcpyHostToDevice));
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::commitStates() {
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    if (temp_h_tiles_ptr) {
        const auto& h_tiles = *temp_h_tiles_ptr;
        std::vector<uint8_t> h_active_tiles(total_tiles, 0);
        for (int t = 0; t < total_tiles; ++t) {
            if (h_tiles[t]) {
                CHECK_CUDA(cudaMemcpy((PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states + t, h_tiles[t], sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyHostToDevice));
                h_active_tiles[t] = 1;
            }
        }
        CHECK_CUDA(cudaMemcpy(d_active_tiles, h_active_tiles.data(), total_tiles * sizeof(uint8_t), cudaMemcpyHostToDevice));
    }

    updateActiveRegions();

    commit_states_kernel<RealType, IsMultiMaterial><<<h_num_active_tiles, 512>>>((PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const int*)d_active_tile_indices);
    CHECK_CUDA(cudaDeviceSynchronize());
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setSpatialOrder(int order) { 
    spatialOrder = order; 
    CHECK_CUDA(cudaMemcpyToSymbol(d_spatialOrder, &order, sizeof(int)));
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setTemporalOrder(int order) { temporalOrder = order; }

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setBoundaryConditions(BCType3D xmin, BCType3D xmax, BCType3D ymin, BCType3D ymax, BCType3D zmin, BCType3D zmax) {
    CFDSolver3DImplBase::setBoundaryConditions(xmin, xmax, ymin, ymax, zmin, zmax);
    updateBoundaryConditions();
}
template <typename RealType, bool IsMultiMaterial>
__global__ void batch_sample_gauges_kernel_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    const GPUGauge3D* gauges,
    float* out_data,
    int num_gauges
) {
    int g = blockIdx.x * blockDim.x + threadIdx.x;
    if (g >= num_gauges) return;

    int t_idx = gauges[g].t_idx;
    int c_idx = gauges[g].c_idx;

    const PrimitiveTile3D<RealType, IsMultiMaterial>& tile = states[t_idx];

    out_data[g * 7 + 0] = (float)tile.p[c_idx];
    out_data[g * 7 + 1] = (float)tile.rho[c_idx];
    RealType ux = tile.ux[c_idx];
    RealType uy = tile.uy[c_idx];
    RealType uz = tile.uz[c_idx];
    out_data[g * 7 + 2] = (float)sqrt((double)(ux * ux + uy * uy + uz * uz));

    RealType ke = (RealType)0.5 * tile.rho[c_idx] * (ux*ux + uy*uy + uz*uz);
    RealType total_E;
    if constexpr (IsMultiMaterial) {
        total_E = (RealType)MultiMat::getMixtureEnergy((double)tile.p[c_idx], (double)tile.rho[c_idx], (double)tile.alpha1[c_idx], (double)tile.alpha2[c_idx], (double)tile.arho1[c_idx], (double)tile.arho2[c_idx], d_gamma, d_products, d_unreacted) + ke;
    } else {
        total_E = tile.p[c_idx] / (d_gamma - (RealType)1.0) + ke;
    }
    out_data[g * 7 + 3] = (float)(total_E / fmax((RealType)1e-6, tile.rho[c_idx]));

    if constexpr (IsMultiMaterial) {
        out_data[g * 7 + 4] = (float)tile.alpha1[c_idx];
        out_data[g * 7 + 5] = (float)tile.alpha2[c_idx];
        out_data[g * 7 + 6] = (float)(1.0 - tile.alpha1[c_idx] - tile.alpha2[c_idx]);
    } else {
        out_data[g * 7 + 4] = 0.0f;
        out_data[g * 7 + 5] = 0.0f;
        out_data[g * 7 + 6] = 1.0f;
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setGauges(const std::vector<Gauge3D>& gauges) {
    ensure_paged_in();
    if (d_gauge_coords) { cudaFree(d_gauge_coords); d_gauge_coords = nullptr; }
    if (d_gauge_results) { cudaFree(d_gauge_results); d_gauge_results = nullptr; }
    if (host_pinned_gauge_data) { cudaFreeHost(host_pinned_gauge_data); host_pinned_gauge_data = nullptr; }

    num_gauges = gauges.size();
    write_idx = 0;
    host_pinned_times.clear();
    buffered_times.clear();
    buffered_values.clear();

    if (num_gauges == 0) return;

    std::vector<GPUGauge3D> local_gauge_coords(num_gauges);
    int ntx = (nx + 7) / 8;
    int nty = (ny + 7) / 8;

    // Helper: look up is_boundary for a cell (i,j,k) using the global host geometry cache.
    // Returns false if no geometry is loaded or coords are out of range.
    const bool has_geom = !global_geometry_tiles.empty()
                          && (int)global_geometry_tiles.size() == ntx * ((ny + 7) / 8) * ((nz + 7) / 8);

    auto cell_is_solid = [&](int i, int j, int k) -> bool {
        if (!has_geom) return false;
        if (i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k >= nz) return false;
        int ti = i / TILE_SIZE_3D, tj = j / TILE_SIZE_3D, tk = k / TILE_SIZE_3D;
        int nty_local = (ny + 7) / 8;
        int t = ti + tj * ntx + tk * ntx * nty_local;
        int c = (i & 7) + (j & 7) * 8 + (k & 7) * 64;
        return global_geometry_tiles[t].cells[c].is_boundary;
    };

    // Returns true if the fluid cell (i,j,k) has at least one solid face-neighbour,
    // i.e., it is directly in contact with the obstacle surface.
    auto cell_is_boundary_contact = [&](int i, int j, int k) -> bool {
        const int face_dirs[6][3] = {
            {1,0,0},{-1,0,0},{0,1,0},{0,-1,0},{0,0,1},{0,0,-1}
        };
        for (auto& d : face_dirs) {
            if (cell_is_solid(i + d[0], j + d[1], k + d[2])) return true;
        }
        return false;
    };

    for (size_t g = 0; g < gauges.size(); ++g) {
        int gx = std::clamp((int)((gauges[g].x - xmin) / cellSize), 0, nx - 1);
        int gy = std::clamp((int)((gauges[g].y - ymin) / cellSize), 0, ny - 1);
        int gz = std::clamp((int)((gauges[g].z - zmin) / cellSize), 0, nz - 1);

        // --- Automatic gauge snapping (internal only; user coordinates are unchanged) ---
        // If geometry is loaded, check whether the gauge is inside a solid or within
        // 1.999 cells of one.  If so, snap the internal extraction cell to the nearest
        // fluid cell that is in direct contact with the obstacle, so that pressure
        // readings on building facades etc. are physically correct.
        if (has_geom) {
            const int SNAP_RADIUS = 2;   // covers the 1.999-cell threshold
            bool gauge_is_solid = cell_is_solid(gx, gy, gz);

            // Check whether the gauge is within SNAP_RADIUS cells of any solid.
            bool near_solid = gauge_is_solid;
            if (!near_solid) {
                for (int dz = -SNAP_RADIUS; dz <= SNAP_RADIUS && !near_solid; ++dz)
                for (int dy = -SNAP_RADIUS; dy <= SNAP_RADIUS && !near_solid; ++dy)
                for (int dx = -SNAP_RADIUS; dx <= SNAP_RADIUS && !near_solid; ++dx) {
                    float dist = std::sqrt((float)(dx*dx + dy*dy + dz*dz));
                    if (dist <= 1.999f && cell_is_solid(gx+dx, gy+dy, gz+dz))
                        near_solid = true;
                }
            }

            if (near_solid) {
                // Search within SNAP_RADIUS+1 cells for the nearest boundary-contact
                // fluid cell, then fall back to any fluid cell if none is found.
                int best_x = -1, best_y = -1, best_z = -1;
                float best_dist_contact = 1e9f;
                float best_dist_fluid   = 1e9f;
                int   bf_x = -1, bf_y = -1, bf_z = -1;  // nearest plain fluid fallback

                const int SEARCH_RADIUS = SNAP_RADIUS + 1;
                for (int dz = -SEARCH_RADIUS; dz <= SEARCH_RADIUS; ++dz)
                for (int dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; ++dy)
                for (int dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; ++dx) {
                    int cx = gx + dx, cy = gy + dy, cz = gz + dz;
                    if (cx < 0 || cx >= nx || cy < 0 || cy >= ny || cz < 0 || cz >= nz) continue;
                    if (cell_is_solid(cx, cy, cz)) continue;

                    float dist = std::sqrt((float)(dx*dx + dy*dy + dz*dz));

                    // Track nearest boundary-contact cell.
                    if (cell_is_boundary_contact(cx, cy, cz)) {
                        if (dist < best_dist_contact) {
                            best_dist_contact = dist;
                            best_x = cx; best_y = cy; best_z = cz;
                        }
                    }
                    // Also track nearest any-fluid as a fallback.
                    if (dist < best_dist_fluid) {
                        best_dist_fluid = dist;
                        bf_x = cx; bf_y = cy; bf_z = cz;
                    }
                }

                int snap_x, snap_y, snap_z;
                if (best_x >= 0) {
                    // Found a boundary-contact fluid cell — use it.
                    snap_x = best_x; snap_y = best_y; snap_z = best_z;
                } else if (bf_x >= 0) {
                    // No boundary-contact cell found; fall back to nearest fluid cell.
                    snap_x = bf_x; snap_y = bf_y; snap_z = bf_z;
                } else {
                    // No fluid cell in range at all — keep original (degenerate grid).
                    snap_x = gx; snap_y = gy; snap_z = gz;
                }

                if (snap_x != gx || snap_y != gy || snap_z != gz) {
                    std::cout << "[GAUGE SNAP] Gauge '" << gauges[g].name
                              << "' adjusted from cell (" << gx << "," << gy << "," << gz << ")"
                              << " to boundary-contact cell (" << snap_x << "," << snap_y << "," << snap_z << ")"
                              << " (dist=" << best_dist_contact << " cells)\n";
                    gx = snap_x; gy = snap_y; gz = snap_z;
                }
            }
        }
        // -------------------------------------------------------------------------

        int tx = gx / TILE_SIZE_3D, ty = gy / TILE_SIZE_3D, tz = gz / TILE_SIZE_3D;
        int t_idx = tx + ty * ntx + tz * ntx * nty;
        int lx = gx % TILE_SIZE_3D, ly = gy % TILE_SIZE_3D, lz = gz % TILE_SIZE_3D;
        int c_idx = lx + ly * 8 + lz * 64;

        local_gauge_coords[g].t_idx = t_idx;
        local_gauge_coords[g].c_idx = c_idx;
    }

    CHECK_CUDA(cudaMalloc(&d_gauge_coords, num_gauges * sizeof(GPUGauge3D)));
    CHECK_CUDA(cudaMemcpy(d_gauge_coords, local_gauge_coords.data(), num_gauges * sizeof(GPUGauge3D), cudaMemcpyHostToDevice));

    CHECK_CUDA(cudaMalloc(&d_gauge_results, num_gauges * 7 * sizeof(float)));
    CHECK_CUDA(cudaHostAlloc(&host_pinned_gauge_data, host_pinned_capacity * num_gauges * 7 * sizeof(float), cudaHostAllocDefault));

    if (!gauge_stream) {
        CHECK_CUDA(cudaStreamCreate((cudaStream_t*)&gauge_stream));
    }
    if (!step_done) {
        CHECK_CUDA(cudaEventCreate((cudaEvent_t*)&step_done));
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::recordGaugesAsync(double t) {
    ensure_paged_in();
    if (num_gauges == 0) return;

    if (write_idx >= host_pinned_capacity) {
        std::vector<double> dummy_times;
        std::vector<float> dummy_vals;
        retrieveNewGaugeSamples(dummy_times, dummy_vals);
        buffered_times.insert(buffered_times.end(), dummy_times.begin(), dummy_times.end());
        buffered_values.insert(buffered_values.end(), dummy_vals.begin(), dummy_vals.end());
    }

    CHECK_CUDA(cudaEventRecord((cudaEvent_t)step_done, 0));
    CHECK_CUDA(cudaStreamWaitEvent((cudaStream_t)gauge_stream, (cudaEvent_t)step_done, 0));

    int threads_per_block = 256;
    int blocks_gauge = (num_gauges + threads_per_block - 1) / threads_per_block;
    batch_sample_gauges_kernel_3d<RealType, IsMultiMaterial><<<blocks_gauge, threads_per_block, 0, (cudaStream_t)gauge_stream>>>(
        (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
        (const GPUGauge3D*)d_gauge_coords,
        (float*)d_gauge_results,
        num_gauges
    );

    float* dest_ptr = host_pinned_gauge_data + (write_idx * num_gauges * 7);
    CHECK_CUDA(cudaMemcpyAsync(dest_ptr, d_gauge_results, num_gauges * 7 * sizeof(float), cudaMemcpyDeviceToHost, (cudaStream_t)gauge_stream));

    host_pinned_times.push_back(t);
    write_idx++;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::retrieveNewGaugeSamples(std::vector<double>& times, std::vector<float>& values) {
    if (num_gauges == 0) {
        times.clear();
        values.clear();
        return;
    }

    CHECK_CUDA(cudaStreamSynchronize((cudaStream_t)gauge_stream));

    times = std::move(buffered_times);
    values = std::move(buffered_values);
    buffered_times.clear();
    buffered_values.clear();

    if (write_idx > 0) {
        times.insert(times.end(), host_pinned_times.begin(), host_pinned_times.end());
        size_t total_floats = write_idx * num_gauges * 7;
        values.insert(values.end(), host_pinned_gauge_data, host_pinned_gauge_data + total_floats);
    }

    write_idx = 0;
    host_pinned_times.clear();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setGeometry(const std::string& stl_filepath, const std::string& geometry_hash, const std::string& voxelization_method,
                                                             const std::atomic<bool>* terminate_flag,
                                                             std::function<void(double)> progress_callback) {
    ensure_paged_in();

    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    std::vector<GeometryTile3D> host_geom(total_tiles);
    voxelize_stl(
        stl_filepath,
        geometry_hash,
        voxelization_method,
        host_geom,
        nx, ny, nz,
        cellSize,
        xmin, ymin, zmin,
        ntx, nty, ntz,
        terminate_flag,
        progress_callback
    );

    loadGeometryToGPU(host_geom, terminate_flag);
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setGeometryTriangles(const std::vector<Triangle>& triangles, const std::string& geometry_hash, const std::string& voxelization_method,
                                                                     const std::atomic<bool>* terminate_flag,
                                                                     std::function<void(double)> progress_callback) {
    ensure_paged_in();

    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    std::vector<GeometryTile3D> host_geom(total_tiles);
    voxelize_geometry(
        triangles,
        geometry_hash,
        voxelization_method,
        host_geom,
        nx, ny, nz,
        cellSize,
        xmin, ymin, zmin,
        ntx, nty, ntz,
        terminate_flag,
        progress_callback
    );

    loadGeometryToGPU(host_geom, terminate_flag);
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setGeometryPrimitives(const nlohmann::json& primitives, const std::string& geometry_hash, const std::string& voxelization_method,
                                                                      const std::atomic<bool>* terminate_flag,
                                                                      std::function<void(double)> progress_callback) {
    ensure_paged_in();

    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    std::vector<GeometryTile3D> host_geom(total_tiles);
    voxelize_primitives(
        primitives,
        geometry_hash,
        voxelization_method,
        host_geom,
        nx, ny, nz,
        cellSize,
        xmin, ymin, zmin,
        ntx, nty, ntz,
        terminate_flag,
        progress_callback
    );

    loadGeometryToGPU(host_geom, terminate_flag);
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::loadGeometryToGPU(const std::vector<GeometryTile3D>& host_geom, const std::atomic<bool>* terminate_flag) {
    if (terminate_flag && terminate_flag->load()) return;

    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    // Copy to GPU
    CHECK_CUDA(cudaMemcpy(d_geom, host_geom.data(), total_tiles * sizeof(GeometryTile3D), cudaMemcpyHostToDevice));
    std::cout << "[INFO] 3D geometry loaded onto GPU." << std::endl;

    // Compute tiles near boundary
    std::vector<uint8_t> host_tile_has_boundary(total_tiles, 0);
    for (int t = 0; t < total_tiles; ++t) {
        for (int c = 0; c < TILE_CELLS_3D; ++c) {
            if (host_geom[t].cells[c].is_boundary) {
                host_tile_has_boundary[t] = 1;
                break;
            }
        }
    }

    std::vector<uint8_t> host_tile_is_near_boundary(total_tiles, 0);
    for (int tz = 0; tz < ntz; ++tz) {
        for (int ty = 0; ty < nty; ++ty) {
            for (int tx = 0; tx < ntx; ++tx) {
                int t = tx + ty * ntx + tz * ntx * nty;
                bool near = false;
                for (int dz = -1; dz <= 1; ++dz) {
                    for (int dy = -1; dy <= 1; ++dy) {
                        for (int dx = -1; dx <= 1; ++dx) {
                            int nx_t = tx + dx;
                            int ny_t = ty + dy;
                            int nz_t = tz + dz;
                            if (nx_t >= 0 && nx_t < ntx && ny_t >= 0 && ny_t < nty && nz_t >= 0 && nz_t < ntz) {
                                int n_idx = nx_t + ny_t * ntx + nz_t * ntx * nty;
                                if (host_tile_has_boundary[n_idx]) {
                                    near = true;
                                    break;
                                }
                            }
                        }
                        if (near) break;
                    }
                    if (near) break;
                }
                host_tile_is_near_boundary[t] = near ? 1 : 0;
            }
        }
    }

    CHECK_CUDA(cudaMemcpy(d_tile_is_near_boundary, host_tile_is_near_boundary.data(), total_tiles * sizeof(uint8_t), cudaMemcpyHostToDevice));
    std::cout << "[INFO] Tile boundary proximity flags loaded onto GPU." << std::endl;

    // Diagnostic check
    int boundary_count = 0;
    for (int t = 0; t < total_tiles; ++t) {
        for (int c = 0; c < TILE_CELLS_3D; ++c) {
            if (host_geom[t].cells[c].is_boundary) {
                boundary_count++;
            }
        }
    }
    std::cout << "[DIAGNOSTIC] Host geometry has " << boundary_count << " boundary cells." << std::endl;

    std::vector<GeometryTile3D> diag_geom(total_tiles);
    CHECK_CUDA(cudaMemcpy(diag_geom.data(), d_geom, total_tiles * sizeof(GeometryTile3D), cudaMemcpyDeviceToHost));
    int gpu_boundary_count = 0;
    for (int t = 0; t < total_tiles; ++t) {
        for (int c = 0; c < TILE_CELLS_3D; ++c) {
            if (diag_geom[t].cells[c].is_boundary) {
                gpu_boundary_count++;
            }
        }
    }
    std::cout << "[DIAGNOSTIC] Device geometry has " << gpu_boundary_count << " boundary cells." << std::endl;
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) reduce_conservation_totals_kernel(
    const ConservativeTile3D<RealType, IsMultiMaterial>* U,
    int total_tiles,
    double* tile_mass,
    double* tile_energy,
    double cell_vol
) {
    int t_idx = blockIdx.x;
    if (t_idx >= total_tiles) return;

    __shared__ double s_mass[512];
    __shared__ double s_energy[512];

    int tid = threadIdx.x;
    
    // Read cell values
    double m = (double)U[t_idx].rho[tid] * cell_vol;
    double e = (double)U[t_idx].E[tid] * cell_vol;
    
    s_mass[tid] = m;
    s_energy[tid] = e;
    __syncthreads();

    // Parallel reduction in shared memory
    for (unsigned int s = 256; s > 0; s >>= 1) {
        if (tid < s) {
            s_mass[tid] += s_mass[tid + s];
            s_energy[tid] += s_energy[tid + s];
        }
        __syncthreads();
    }

    // Write block's result to global memory
    if (tid == 0) {
        tile_mass[t_idx] = s_mass[0];
        tile_energy[t_idx] = s_energy[0];
    }
}

template <typename RealType, bool IsMultiMaterial>
std::pair<double, double> CFDSolver3DCuda<RealType, IsMultiMaterial>::getConservationTotals() const {
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;
    double cell_vol = cellSize * cellSize * cellSize;

    if (is_paged_out) {
        double total_mass = 0.0;
        double total_energy = 0.0;
        for (int t = 0; t < total_tiles; ++t) {
            const auto& tile = paged_U[t];
            for (int c = 0; c < TILE_CELLS_3D; ++c) {
                total_mass += tile.rho[c] * cell_vol;
                total_energy += tile.E[c] * cell_vol;
            }
        }
        return {total_mass, total_energy};
    }

    reduce_conservation_totals_kernel<RealType, IsMultiMaterial><<<total_tiles, 512>>>(
        (const ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
        total_tiles,
        (double*)d_tile_mass,
        (double*)d_tile_energy,
        cell_vol
    );
    CHECK_CUDA(cudaDeviceSynchronize());

    std::vector<double> h_tile_mass(total_tiles);
    std::vector<double> h_tile_energy(total_tiles);
    CHECK_CUDA(cudaMemcpy(h_tile_mass.data(), d_tile_mass, total_tiles * sizeof(double), cudaMemcpyDeviceToHost));
    CHECK_CUDA(cudaMemcpy(h_tile_energy.data(), d_tile_energy, total_tiles * sizeof(double), cudaMemcpyDeviceToHost));

    double total_mass = 0.0;
    double total_energy = 0.0;
    for (int t = 0; t < total_tiles; ++t) {
        total_mass += h_tile_mass[t];
        total_energy += h_tile_energy[t];
    }

    return {total_mass, total_energy};
}

template <typename RealType, bool IsMultiMaterial>
size_t CFDSolver3DCuda<RealType, IsMultiMaterial>::getAllocatedVRAM() const {
    if (is_paged_out || !d_states) return 0;
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    size_t total = 0;
    total += total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>);
    total += total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>);
    if (d_dU) {
        total += total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>);
    }
    if (d_geom) {
        total += total_tiles * sizeof(GeometryTile3D);
    }
    total += total_tiles * sizeof(uint8_t); // d_active_tiles
    total += total_tiles * sizeof(uint8_t); // d_tile_active_temp
    total += total_tiles * sizeof(RealType); // d_max_s_buf

    if (d_gauge_coords && num_gauges > 0) {
        total += num_gauges * sizeof(GPUGauge3D);
        total += num_gauges * 7 * sizeof(float);
    }
    return total;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::uploadObstacleFaces(const std::vector<ObstacleFace>& faces) {
    ensure_paged_in();
    if (d_obstacle_faces) {
        cudaFree(d_obstacle_faces);
        d_obstacle_faces = nullptr;
    }

    num_obstacle_faces = faces.size();
    if (num_obstacle_faces == 0) return;

    std::vector<GPUObstacleFace> local_faces(num_obstacle_faces);
    int ntx = (nx + 7) / 8;
    int nty = (ny + 7) / 8;

    for (size_t f = 0; f < faces.size(); ++f) {
        const auto& face = faces[f];
        int i = face.gx_fluid;
        int j = face.gy_fluid;
        int k = face.gz_fluid;

        if (i < 0) i = 0; if (i >= nx) i = nx - 1;
        if (j < 0) j = 0; if (j >= ny) j = ny - 1;
        if (k < 0) k = 0; if (k >= nz) k = nz - 1;

        int ti = i / 8;
        int tj = j / 8;
        int tk = k / 8;
        int t = ti + tj * ntx + tk * ntx * nty;
        int c = (i & 7) + (j & 7) * 8 + (k & 7) * 64;

        local_faces[f].t_idx = t;
        local_faces[f].c_idx = c;
    }

    CHECK_CUDA(cudaMalloc(&d_obstacle_faces, num_obstacle_faces * sizeof(GPUObstacleFace)));
    CHECK_CUDA(cudaMemcpy(d_obstacle_faces, local_faces.data(), num_obstacle_faces * sizeof(GPUObstacleFace), cudaMemcpyHostToDevice));
}

template class CFDSolver3DCuda<float, true>;
template class CFDSolver3DCuda<float, false>;
template class CFDSolver3DCuda<double, true>;
template class CFDSolver3DCuda<double, false>;
