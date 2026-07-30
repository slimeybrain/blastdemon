#include "cfd_solver_3d_cuda.hpp"
#include <cuda_runtime.h>
#include "ImmersedBoundary.hpp"

extern void remap_1d_to_3d(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d,
    CFDSolver3D& solver_3d, double x_expl, double y_expl, double z_expl, double R_remap);
extern void remap_2d_to_3d(int nr, int nz, double dr, double dz, const std::vector<State2D>& states_2d,
    CFDSolver3D& solver_3d, double x_expl, double y_expl, double z_expl, double R_remap, double source_explosive_z = 0.0);
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
        states[t_idx].alpha1[c_idx] = 0.0;
        states[t_idx].alpha2[c_idx] = 0.0;
        states[t_idx].arho1[c_idx] = 0.0;
        states[t_idx].arho2[c_idx] = 0.0;

        U[t_idx].alpha1[c_idx] = 0.0;
        U[t_idx].alpha2[c_idx] = 0.0;
        U[t_idx].arho1[c_idx] = 0.0;
        U[t_idx].arho2[c_idx] = 0.0;

        E = amb_p / (gamma - (RealType)1.0);
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
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) reset_inactive_tiles_kernel(
    PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    ConservativeTile3D<RealType, IsMultiMaterial>* U,
    const uint8_t* active_tiles,
    RealType amb_rho, RealType amb_p, RealType gamma,
    int total_tiles,
    MultiMat::JWLParams products, MultiMat::JWLParams unreacted
) {
    int t_idx = blockIdx.x;
    if (t_idx >= total_tiles) return;
    if (active_tiles[t_idx]) return;

    int c_idx = threadIdx.x;

    states[t_idx].rho[c_idx] = amb_rho;
    states[t_idx].ux[c_idx] = 0;
    states[t_idx].uy[c_idx] = 0;
    states[t_idx].uz[c_idx] = 0;
    states[t_idx].p[c_idx] = amb_p;
    
    RealType E;
    if constexpr (IsMultiMaterial) {
        states[t_idx].alpha1[c_idx] = 0.0;
        states[t_idx].alpha2[c_idx] = 0.0;
        states[t_idx].arho1[c_idx] = 0.0;
        states[t_idx].arho2[c_idx] = 0.0;

        U[t_idx].alpha1[c_idx] = 0.0;
        U[t_idx].alpha2[c_idx] = 0.0;
        U[t_idx].arho1[c_idx] = 0.0;
        U[t_idx].arho2[c_idx] = 0.0;

        E = amb_p / (gamma - (RealType)1.0);
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
        total_E = MultiMat::getMixtureEnergy<RealType>(s.p[c_idx], s.rho[c_idx], s.alpha1[c_idx], s.alpha2[c_idx], s.arho1[c_idx], s.arho2[c_idx], (RealType)d_gamma, d_products, d_unreacted) + ke;
    } else {
        total_E = s.p[c_idx] / ((RealType)d_gamma - (RealType)1.0) + ke;
    }
    u.E[c_idx] = total_E;

    if constexpr (IsMultiMaterial) {
        u.alpha1[c_idx] = s.alpha1[c_idx];
        u.alpha2[c_idx] = s.alpha2[c_idx];
        u.arho1[c_idx] = s.arho1[c_idx];
        u.arho2[c_idx] = s.arho2[c_idx];
    }
}

template <typename RealType, bool IsMultiMaterial>
struct GPUCellStateT;

template <typename RealType>
struct GPUCellStateT<RealType, false> {
    RealType rho, ux, uy, uz, p, E;
    RealType peak_overpressure, peak_impulse;
};

template <typename RealType>
struct GPUCellStateT<RealType, true> {
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
__device__ __forceinline__ GPUCellStateT<RealType, IsMultiMaterial> sample_gpu_interior(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    int gx, int gy, int gz
) {
    int tx = gx >> 3;
    int ty = gy >> 3;
    int tz = gz >> 3;
    int t_idx = tx + ty * d_ntx + tz * d_ntx * d_nty;

    int lx = gx & 7;
    int ly = gy & 7;
    int lz = gz & 7;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    const auto& tile = states[t_idx];
    GPUCellStateT<RealType, IsMultiMaterial> s;
    s.rho = tile.rho[c_idx];
    s.ux = tile.ux[c_idx];
    s.uy = tile.uy[c_idx];
    s.uz = tile.uz[c_idx];
    s.p = tile.p[c_idx];
    s.E = (RealType)0.0;
    s.peak_overpressure = tile.peak_overpressure[c_idx];
    s.peak_impulse = tile.peak_impulse[c_idx];
    if constexpr (IsMultiMaterial) {
        s.alpha1 = tile.alpha1[c_idx];
        s.alpha2 = tile.alpha2[c_idx];
        s.arho1 = tile.arho1[c_idx];
        s.arho2 = tile.arho2[c_idx];
    }
    return s;
}

template <typename RealType, bool IsMultiMaterial>
__device__ __forceinline__ GPUCellStateT<RealType, IsMultiMaterial> sample_gpu_raw(const PrimitiveTile3D<RealType, IsMultiMaterial>* states, int gx, int gy, int gz) {
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

    gx = gx < 0 ? 0 : (gx >= d_nx ? d_nx - 1 : gx);
    gy = gy < 0 ? 0 : (gy >= d_ny ? d_ny - 1 : gy);
    gz = gz < 0 ? 0 : (gz >= d_nz ? d_nz - 1 : gz);

    int tx = gx >> 3;
    int ty = gy >> 3;
    int tz = gz >> 3;
    int t_idx = tx + ty * d_ntx + tz * d_ntx * d_nty;

    int lx = gx & 7;
    int ly = gy & 7;
    int lz = gz & 7;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    const auto& tile = states[t_idx];
    GPUCellStateT<RealType, IsMultiMaterial> s;
    s.rho = tile.rho[c_idx];
    s.ux = rx ? -tile.ux[c_idx] : tile.ux[c_idx];
    s.uy = ry ? -tile.uy[c_idx] : tile.uy[c_idx];
    s.uz = rz ? -tile.uz[c_idx] : tile.uz[c_idx];
    s.p = tile.p[c_idx];
    s.E = (RealType)0.0;
    s.peak_overpressure = tile.peak_overpressure[c_idx];
    s.peak_impulse = tile.peak_impulse[c_idx];
    if constexpr (IsMultiMaterial) {
        s.alpha1 = tile.alpha1[c_idx];
        s.alpha2 = tile.alpha2[c_idx];
        s.arho1 = tile.arho1[c_idx];
        s.arho2 = tile.arho2[c_idx];
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
__device__ void getRusanovFluxGPU(const GPUCellStateT<RealType, IsMultiMaterial>& sL, const GPUCellStateT<RealType, IsMultiMaterial>& sR, RealType* flux, int dir, RealType gamma) {
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

    RealType cL, cR;
    if constexpr (IsMultiMaterial) {
        cL = MultiMat::getMixtureSoundSpeed<RealType>(sL.p, sL.rho, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, (RealType)gamma, d_products, d_unreacted);
        cR = MultiMat::getMixtureSoundSpeed<RealType>(sR.p, sR.rho, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, (RealType)gamma, d_products, d_unreacted);
    } else {
        cL = sqrt(gamma * sL.p / fmax((RealType)1e-6, sL.rho));
        cR = sqrt(gamma * sR.p / fmax((RealType)1e-6, sR.rho));
    }
    RealType s_max = fmax(abs(unL) + cL, abs(unR) + cR);

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
__device__ void getAUSMPlusFluxGPU(const GPUCellStateT<RealType, IsMultiMaterial>& sL, const GPUCellStateT<RealType, IsMultiMaterial>& sR, RealType* flux, int dir, RealType gamma) {
    RealType aL, aR;
    if constexpr (IsMultiMaterial) {
        aL = MultiMat::getMixtureSoundSpeed<RealType>(sL.p, sL.rho, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, (RealType)gamma, d_products, d_unreacted);
        aR = MultiMat::getMixtureSoundSpeed<RealType>(sR.p, sR.rho, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, (RealType)gamma, d_products, d_unreacted);
    } else {
        aL = sqrt(gamma * sL.p / fmax((RealType)1e-6, sL.rho));
        aR = sqrt(gamma * sR.p / fmax((RealType)1e-6, sR.rho));
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
    RealType d0 = v0 - vM1;
    RealType d1 = vP1 - v0;
    
    RealType beta0 = d0 * d0;
    RealType beta1 = d1 * d1;
    
    RealType eps = (RealType)1e-6;
    RealType alpha0 = ((RealType)1.0 / (RealType)3.0) / ((eps + beta0) * (eps + beta0));
    RealType alpha1 = ((RealType)2.0 / (RealType)3.0) / ((eps + beta1) * (eps + beta1));
    
    RealType sum_alpha = alpha0 + alpha1;
    RealType w0, w1;
    if (sum_alpha < (RealType)1e-30) {
        w0 = (RealType)1.0 / (RealType)3.0;
        w1 = (RealType)2.0 / (RealType)3.0;
    } else {
        w0 = alpha0 / sum_alpha;
        w1 = alpha1 / sum_alpha;
    }
    
    RealType p0 = v0 + (RealType)0.5 * d0;
    RealType p1 = v0 + (RealType)0.5 * d1;
    return w0 * p0 + w1 * p1;
}

// Why this works:
// By projecting the Image Point from the deep solid target, but restricting the IDW sampling strictly to the verified fluid neighborhood of the querying cell, we generate a perfectly continuous, anti-aliased gradient for the WENO3 stencil. This eliminates all lumps and carbuncles. Furthermore, this topology mathematically guarantees that the ray cannot pierce a 1-cell thick wall or sample the wrong side of an urban gap, providing indestructible geometric stability.
// Specifying the reconstruction direction (dir) decouples normal reflection components at sharp convex corners, eliminating artificial stagnation pressure artifacts on the GPU.
template <typename RealType, bool IsMultiMaterial>
__device__ __forceinline__ GPUCellStateT<RealType, IsMultiMaterial> sample_gpu(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    const GeometryTile3D* geom,
    int target_x, int target_y, int target_z,
    int qx, int qy, int qz,
    int dir,
    bool is_near_boundary
) {
    bool is_solid = false;
    if (is_near_boundary) {
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
    
    GPUCellStateT<RealType, IsMultiMaterial> s_ghost;
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
        }
    }
    
    // ALWAYS reflect velocity across the TRUE STL normal to ensure smooth slip flow
    // over stair-stepped voxelization artifacts, sacrificing strict mass conservation for flow quality.
    float u_dot_n = (float)s_ghost.ux * nx_true + (float)s_ghost.uy * ny_true + (float)s_ghost.uz * nz_true;
    s_ghost.ux = (RealType)((float)s_ghost.ux - 2.0f * u_dot_n * nx_true);
    s_ghost.uy = (RealType)((float)s_ghost.uy - 2.0f * u_dot_n * ny_true);
    s_ghost.uz = (RealType)((float)s_ghost.uz - 2.0f * u_dot_n * nz_true);
    
    s_ghost.E = (RealType)0.0;
    
    return s_ghost;
}

template <typename RealType, bool IsMultiMaterial>
__device__ __forceinline__ void reconstruct_gpu(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    const GeometryTile3D* geom,
    int gx, int gy, int gz,
    int dir,
    GPUCellStateT<RealType, IsMultiMaterial>& sL, GPUCellStateT<RealType, IsMultiMaterial>& sR,
    int qx, int qy, int qz,
    bool is_near_boundary,
    bool force_first_order_L = false,
    bool force_first_order_R = false
) {
    int dx = (dir == 0 ? 1 : 0);
    int dy = (dir == 1 ? 1 : 0);
    int dz = (dir == 2 ? 1 : 0);

    GPUCellStateT<RealType, IsMultiMaterial> sM1 = sample_gpu<RealType, IsMultiMaterial>(states, geom, gx - dx, gy - dy, gz - dz, qx, qy, qz, dir, is_near_boundary);
    GPUCellStateT<RealType, IsMultiMaterial> sP0 = sample_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz, qx, qy, qz, dir, is_near_boundary);

    GPUCellStateT<RealType, IsMultiMaterial> sM2 = sample_gpu<RealType, IsMultiMaterial>(states, geom, gx - 2*dx, gy - 2*dy, gz - 2*dz, qx, qy, qz, dir, is_near_boundary);
    GPUCellStateT<RealType, IsMultiMaterial> sP1 = sample_gpu<RealType, IsMultiMaterial>(states, geom, gx + dx, gy + dy, gz + dz, qx, qy, qz, dir, is_near_boundary);

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
        sL.E = MultiMat::getMixtureEnergy<RealType>(sL.p, sL.rho, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, (RealType)d_gamma, d_products, d_unreacted) + keL;
        sR.E = MultiMat::getMixtureEnergy<RealType>(sR.p, sR.rho, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, (RealType)d_gamma, d_products, d_unreacted) + keR;
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

    GPUCellStateT<RealType, IsMultiMaterial> sL, sR;
    reconstruct_gpu<RealType, IsMultiMaterial>(states, geom_pool, gx_R, gy_R, gz_R, dir, sL, sR, qx, qy, qz, is_near_boundary, force_first, force_first);
    if (d_useAUSM) getAUSMPlusFluxGPU<RealType, IsMultiMaterial>(sL, sR, flx, dir, (RealType)d_gamma);
    else getRusanovFluxGPU<RealType, IsMultiMaterial>(sL, sR, flx, dir, (RealType)d_gamma);
}

template <typename RealType, bool IsMultiMaterial>
__device__ __forceinline__ void reconstruct_interior_gpu(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    int gx, int gy, int gz,
    int dir,
    GPUCellStateT<RealType, IsMultiMaterial>& sL, GPUCellStateT<RealType, IsMultiMaterial>& sR
) {
    int dx = (dir == 0 ? 1 : 0);
    int dy = (dir == 1 ? 1 : 0);
    int dz = (dir == 2 ? 1 : 0);

    GPUCellStateT<RealType, IsMultiMaterial> sM2 = sample_gpu_interior<RealType, IsMultiMaterial>(states, gx - 2*dx, gy - 2*dy, gz - 2*dz);
    GPUCellStateT<RealType, IsMultiMaterial> sM1 = sample_gpu_interior<RealType, IsMultiMaterial>(states, gx - dx, gy - dy, gz - dz);
    GPUCellStateT<RealType, IsMultiMaterial> sP0 = sample_gpu_interior<RealType, IsMultiMaterial>(states, gx, gy, gz);
    GPUCellStateT<RealType, IsMultiMaterial> sP1 = sample_gpu_interior<RealType, IsMultiMaterial>(states, gx + dx, gy + dy, gz + dz);

    auto reconstruct_channel = [&](RealType vM2, RealType vM1, RealType vP0, RealType vP1, RealType& vL, RealType& vR) {
        if (d_spatialOrder == 1) {
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
        sL.E = MultiMat::getMixtureEnergy<RealType>(sL.p, sL.rho, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, (RealType)d_gamma, d_products, d_unreacted) + keL;
        sR.E = MultiMat::getMixtureEnergy<RealType>(sR.p, sR.rho, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, (RealType)d_gamma, d_products, d_unreacted) + keR;
    } else {
        sL.E = sL.p / ((RealType)d_gamma - (RealType)1.0) + keL;
        sR.E = sR.p / ((RealType)d_gamma - (RealType)1.0) + keR;
    }
}

template <typename RealType, bool IsMultiMaterial>
__device__ __forceinline__ void get_face_flux_interior_gpu(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    int gx_R, int gy_R, int gz_R,
    int dir, RealType* flx
) {
    GPUCellStateT<RealType, IsMultiMaterial> sL, sR;
    reconstruct_interior_gpu<RealType, IsMultiMaterial>(states, gx_R, gy_R, gz_R, dir, sL, sR);
    if (d_useAUSM) getAUSMPlusFluxGPU<RealType, IsMultiMaterial>(sL, sR, flx, dir, (RealType)d_gamma);
    else getRusanovFluxGPU<RealType, IsMultiMaterial>(sL, sR, flx, dir, (RealType)d_gamma);
}

template <typename RealType>
__device__ __forceinline__ void reconstruct_interior_shared(
    const RealType sh_rho[12][12][13],
    const RealType sh_ux[12][12][13],
    const RealType sh_uy[12][12][13],
    const RealType sh_uz[12][12][13],
    const RealType sh_p[12][12][13],
    int lx, int ly, int lz,
    int dir, int offset,
    RealType* flx
) {
    int dx = (dir == 0 ? 1 : 0);
    int dy = (dir == 1 ? 1 : 0);
    int dz = (dir == 2 ? 1 : 0);

    int cx = lx + 2 + (offset + 1) * dx;
    int cy = ly + 2 + (offset + 1) * dy;
    int cz = lz + 2 + (offset + 1) * dz;

    RealType rhoM2 = sh_rho[cz - 2*dz][cy - 2*dy][cx - 2*dx];
    RealType rhoM1 = sh_rho[cz - dz][cy - dy][cx - dx];
    RealType rhoP0 = sh_rho[cz][cy][cx];
    RealType rhoP1 = sh_rho[cz + dz][cy + dy][cx + dx];

    RealType uxM2 = sh_ux[cz - 2*dz][cy - 2*dy][cx - 2*dx];
    RealType uxM1 = sh_ux[cz - dz][cy - dy][cx - dx];
    RealType uxP0 = sh_ux[cz][cy][cx];
    RealType uxP1 = sh_ux[cz + dz][cy + dy][cx + dx];

    RealType uyM2 = sh_uy[cz - 2*dz][cy - 2*dy][cx - 2*dx];
    RealType uyM1 = sh_uy[cz - dz][cy - dy][cx - dx];
    RealType uyP0 = sh_uy[cz][cy][cx];
    RealType uyP1 = sh_uy[cz + dz][cy + dy][cx + dx];

    RealType uzM2 = sh_uz[cz - 2*dz][cy - 2*dy][cx - 2*dx];
    RealType uzM1 = sh_uz[cz - dz][cy - dy][cx - dx];
    RealType uzP0 = sh_uz[cz][cy][cx];
    RealType uzP1 = sh_uz[cz + dz][cy + dy][cx + dx];

    RealType pM2 = sh_p[cz - 2*dz][cy - 2*dy][cx - 2*dx];
    RealType pM1 = sh_p[cz - dz][cy - dy][cx - dx];
    RealType pP0 = sh_p[cz][cy][cx];
    RealType pP1 = sh_p[cz + dz][cy + dy][cx + dx];

    GPUCellStateT<RealType, false> sL, sR;

    auto reconstruct_channel = [&](RealType vM2, RealType vM1, RealType vP0, RealType vP1, RealType& vL, RealType& vR) {
        if (d_spatialOrder == 1) {
            vL = vM1;
            vR = vP0;
        } else if (d_spatialOrder == 3) {
            vL = weno3_gpu(vM2, vM1, vP0);
            vR = weno3_gpu(vP1, vP0, vM1);
        } else { // Order 2
            RealType dL = vM1 - vM2;
            RealType dC = vP0 - vM1;
            RealType dR = vP1 - vP0;
            vL = vM1 + (RealType)0.5 * minmod_gpu(dL, dC);
            vR = vP0 - (RealType)0.5 * minmod_gpu(dC, dR);
        }
    };

    reconstruct_channel(rhoM2, rhoM1, rhoP0, rhoP1, sL.rho, sR.rho);
    sL.rho = fmax((RealType)1e-7, sL.rho);
    sR.rho = fmax((RealType)1e-7, sR.rho);
    reconstruct_channel(uxM2, uxM1, uxP0, uxP1, sL.ux, sR.ux);
    reconstruct_channel(uyM2, uyM1, uyP0, uyP1, sL.uy, sR.uy);
    reconstruct_channel(uzM2, uzM1, uzP0, uzP1, sL.uz, sR.uz);
    reconstruct_channel(pM2, pM1, pP0, pP1, sL.p, sR.p);
    sL.p = fmax((RealType)1e-7, sL.p);
    sR.p = fmax((RealType)1e-7, sR.p);

    RealType keL = (RealType)0.5 * sL.rho * (sL.ux*sL.ux + sL.uy*sL.uy + sL.uz*sL.uz);
    RealType keR = (RealType)0.5 * sR.rho * (sR.ux*sR.ux + sR.uy*sR.uy + sR.uz*sR.uz);
    sL.E = sL.p / ((RealType)d_gamma - (RealType)1.0) + keL;
    sR.E = sR.p / ((RealType)d_gamma - (RealType)1.0) + keR;

    if (d_useAUSM) getAUSMPlusFluxGPU<RealType, false>(sL, sR, flx, dir, (RealType)d_gamma);
    else getRusanovFluxGPU<RealType, false>(sL, sR, flx, dir, (RealType)d_gamma);
}

template <typename RealType, bool IsMultiMaterial>
__device__ __forceinline__ void apply_flux_update_gpu(
    ConservativeTile3D<RealType, IsMultiMaterial>* U,
    ConservativeTile3D<RealType, IsMultiMaterial>* U_prev,
    int t_idx, int c_idx, RealType dt_dx,
    const RealType* fL_x, const RealType* fR_x,
    const RealType* fL_y, const RealType* fR_y,
    const RealType* fL_z, const RealType* fR_z,
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    int rk_stage
) {
    RealType du_rho   = (fR_x[0] - fL_x[0]) + (fR_y[0] - fL_y[0]) + (fR_z[0] - fL_z[0]);
    RealType du_rhoux = (fR_x[1] - fL_x[1]) + (fR_y[1] - fL_y[1]) + (fR_z[1] - fL_z[1]);
    RealType du_rhouy = (fR_x[2] - fL_x[2]) + (fR_y[2] - fL_y[2]) + (fR_z[2] - fL_z[2]);
    RealType du_rhouz = (fR_x[3] - fL_x[3]) + (fR_y[3] - fL_y[3]) + (fR_z[3] - fL_z[3]);
    RealType du_E     = (fR_x[4] - fL_x[4]) + (fR_y[4] - fL_y[4]) + (fR_z[4] - fL_z[4]);

    if (rk_stage == 1) {
        U[t_idx].rho[c_idx]   = U_prev[t_idx].rho[c_idx]   - dt_dx * du_rho;
        U[t_idx].rhoux[c_idx] = U_prev[t_idx].rhoux[c_idx] - dt_dx * du_rhoux;
        U[t_idx].rhouy[c_idx] = U_prev[t_idx].rhouy[c_idx] - dt_dx * du_rhouy;
        U[t_idx].rhouz[c_idx] = U_prev[t_idx].rhouz[c_idx] - dt_dx * du_rhouz;
        U[t_idx].E[c_idx]     = U_prev[t_idx].E[c_idx]     - dt_dx * du_E;
    } else if (rk_stage == 2) {
        U_prev[t_idx].rho[c_idx]   = (RealType)0.5 * U_prev[t_idx].rho[c_idx]   + (RealType)0.5 * (U[t_idx].rho[c_idx]   - dt_dx * du_rho);
        U_prev[t_idx].rhoux[c_idx] = (RealType)0.5 * U_prev[t_idx].rhoux[c_idx] + (RealType)0.5 * (U[t_idx].rhoux[c_idx] - dt_dx * du_rhoux);
        U_prev[t_idx].rhouy[c_idx] = (RealType)0.5 * U_prev[t_idx].rhouy[c_idx] + (RealType)0.5 * (U[t_idx].rhouy[c_idx] - dt_dx * du_rhouy);
        U_prev[t_idx].rhouz[c_idx] = (RealType)0.5 * U_prev[t_idx].rhouz[c_idx] + (RealType)0.5 * (U[t_idx].rhouz[c_idx] - dt_dx * du_rhouz);
        U_prev[t_idx].E[c_idx]     = (RealType)0.5 * U_prev[t_idx].E[c_idx]     + (RealType)0.5 * (U[t_idx].E[c_idx]     - dt_dx * du_E);
    } else {
        U[t_idx].rho[c_idx]   -= dt_dx * du_rho;
        U[t_idx].rhoux[c_idx] -= dt_dx * du_rhoux;
        U[t_idx].rhouy[c_idx] -= dt_dx * du_rhouy;
        U[t_idx].rhouz[c_idx] -= dt_dx * du_rhouz;
        U[t_idx].E[c_idx]     -= dt_dx * du_E;
    }

    if constexpr (IsMultiMaterial) {
        RealType du_a1  = (fR_x[5] - fL_x[5]) + (fR_y[5] - fL_y[5]) + (fR_z[5] - fL_z[5]);
        RealType du_a2  = (fR_x[6] - fL_x[6]) + (fR_y[6] - fL_y[6]) + (fR_z[6] - fL_z[6]);
        RealType du_ar1 = (fR_x[7] - fL_x[7]) + (fR_y[7] - fL_y[7]) + (fR_z[7] - fL_z[7]);
        RealType du_ar2 = (fR_x[8] - fL_x[8]) + (fR_y[8] - fL_y[8]) + (fR_z[8] - fL_z[8]);
        RealType div_u  = (fR_x[9] - fL_x[9]) + (fR_y[9] - fL_y[9]) + (fR_z[9] - fL_z[9]);
        RealType term_a1 = states[t_idx].alpha1[c_idx] * div_u;
        RealType term_a2 = states[t_idx].alpha2[c_idx] * div_u;

        if (rk_stage == 1) {
            U[t_idx].alpha1[c_idx] = U_prev[t_idx].alpha1[c_idx] - dt_dx * du_a1 + dt_dx * term_a1;
            U[t_idx].alpha2[c_idx] = U_prev[t_idx].alpha2[c_idx] - dt_dx * du_a2 + dt_dx * term_a2;
            U[t_idx].arho1[c_idx]  = U_prev[t_idx].arho1[c_idx]  - dt_dx * du_ar1;
            U[t_idx].arho2[c_idx]  = U_prev[t_idx].arho2[c_idx]  - dt_dx * du_ar2;
        } else if (rk_stage == 2) {
            U_prev[t_idx].alpha1[c_idx] = (RealType)0.5 * U_prev[t_idx].alpha1[c_idx] + (RealType)0.5 * (U[t_idx].alpha1[c_idx] - dt_dx * du_a1 + dt_dx * term_a1);
            U_prev[t_idx].alpha2[c_idx] = (RealType)0.5 * U_prev[t_idx].alpha2[c_idx] + (RealType)0.5 * (U[t_idx].alpha2[c_idx] - dt_dx * du_a2 + dt_dx * term_a2);
            U_prev[t_idx].arho1[c_idx]  = (RealType)0.5 * U_prev[t_idx].arho1[c_idx]  + (RealType)0.5 * (U[t_idx].arho1[c_idx]  - dt_dx * du_ar1);
            U_prev[t_idx].arho2[c_idx]  = (RealType)0.5 * U_prev[t_idx].arho2[c_idx]  + (RealType)0.5 * (U[t_idx].arho2[c_idx]  - dt_dx * du_ar2);
        } else {
            U[t_idx].alpha1[c_idx] -= dt_dx * du_a1;
            U[t_idx].alpha2[c_idx] -= dt_dx * du_a2;
            U[t_idx].alpha1[c_idx] += dt_dx * term_a1;
            U[t_idx].alpha2[c_idx] += dt_dx * term_a2;
            U[t_idx].arho1[c_idx]  -= dt_dx * du_ar1;
            U[t_idx].arho2[c_idx]  -= dt_dx * du_ar2;
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) compute_flux_fused_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states,
    ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U,
    const int* __restrict__ active_tile_indices,
    const uint8_t* __restrict__ tile_is_near_boundary,
    const GeometryTile3D* __restrict__ geom,
    RealType dt,
    int rk_stage = 0,
    ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U_prev = nullptr
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

    bool is_domain_boundary = (tx == 0 || tx == d_ntx - 1 || ty == 0 || ty == d_nty - 1 || tz == 0 || tz == d_ntz - 1);

    if (!s_is_near_boundary && !is_domain_boundary) {
        RealType invDx = (RealType)1.0 / (RealType)d_cellSize;
        RealType dt_dx = dt * invDx;

        if constexpr (!IsMultiMaterial && sizeof(RealType) == 4) {
            // Shared memory path
            __shared__ RealType sh_rho[12][12][13];
            __shared__ RealType sh_ux[12][12][13];
            __shared__ RealType sh_uy[12][12][13];
            __shared__ RealType sh_uz[12][12][13];
            __shared__ RealType sh_p[12][12][13];

            for (int idx = tid; idx < 1728; idx += 512) {
                int lz_sh = idx / 144;
                int ly_sh = (idx % 144) / 12;
                int lx_sh = idx % 12;

                int gx_sh = tx * 8 - 2 + lx_sh;
                int gy_sh = ty * 8 - 2 + ly_sh;
                int gz_sh = tz * 8 - 2 + lz_sh;

                GPUCellStateT<RealType, false> s = sample_gpu_interior<RealType, false>(states, gx_sh, gy_sh, gz_sh);
                sh_rho[lz_sh][ly_sh][lx_sh] = s.rho;
                sh_ux[lz_sh][ly_sh][lx_sh]  = s.ux;
                sh_uy[lz_sh][ly_sh][lx_sh]  = s.uy;
                sh_uz[lz_sh][ly_sh][lx_sh]  = s.uz;
                sh_p[lz_sh][ly_sh][lx_sh]   = s.p;
            }
            __syncthreads();

            if (gx < d_nx && gy < d_ny && gz < d_nz) {
                RealType fL_x[10], fR_x[10];
                RealType fL_y[10], fR_y[10];
                RealType fL_z[10], fR_z[10];

                reconstruct_interior_shared<RealType>(sh_rho, sh_ux, sh_uy, sh_uz, sh_p, lx, ly, lz, 0, -1, fL_x);
                reconstruct_interior_shared<RealType>(sh_rho, sh_ux, sh_uy, sh_uz, sh_p, lx, ly, lz, 0, 0, fR_x);

                reconstruct_interior_shared<RealType>(sh_rho, sh_ux, sh_uy, sh_uz, sh_p, lx, ly, lz, 1, -1, fL_y);
                reconstruct_interior_shared<RealType>(sh_rho, sh_ux, sh_uy, sh_uz, sh_p, lx, ly, lz, 1, 0, fR_y);

                reconstruct_interior_shared<RealType>(sh_rho, sh_ux, sh_uy, sh_uz, sh_p, lx, ly, lz, 2, -1, fL_z);
                reconstruct_interior_shared<RealType>(sh_rho, sh_ux, sh_uy, sh_uz, sh_p, lx, ly, lz, 2, 0, fR_z);

                apply_flux_update_gpu<RealType, IsMultiMaterial>(U, U_prev, t_idx, c_idx, dt_dx, fL_x, fR_x, fL_y, fR_y, fL_z, fR_z, states, rk_stage);
            }
        } else {
            // Default global memory path
            if (gx < d_nx && gy < d_ny && gz < d_nz) {
                RealType fL_x[10], fR_x[10];
                RealType fL_y[10], fR_y[10];
                RealType fL_z[10], fR_z[10];

                // --- X Direction ---
                get_face_flux_interior_gpu<RealType, IsMultiMaterial>(states, gx, gy, gz, 0, fL_x);
                get_face_flux_interior_gpu<RealType, IsMultiMaterial>(states, gx + 1, gy, gz, 0, fR_x);

                // --- Y Direction ---
                get_face_flux_interior_gpu<RealType, IsMultiMaterial>(states, gx, gy, gz, 1, fL_y);
                get_face_flux_interior_gpu<RealType, IsMultiMaterial>(states, gx, gy + 1, gz, 1, fR_y);

                // --- Z Direction ---
                get_face_flux_interior_gpu<RealType, IsMultiMaterial>(states, gx, gy, gz, 2, fL_z);
                get_face_flux_interior_gpu<RealType, IsMultiMaterial>(states, gx, gy + 1, gz, 2, fR_z);

                apply_flux_update_gpu<RealType, IsMultiMaterial>(U, U_prev, t_idx, c_idx, dt_dx, fL_x, fR_x, fL_y, fR_y, fL_z, fR_z, states, rk_stage);
            }
        }
    } else {
        if (gx < d_nx && gy < d_ny && gz < d_nz) {
            bool is_boundary = false;
            if (s_is_near_boundary) {
                is_boundary = is_solid_cell_gpu(geom, gx, gy, gz);
            }

            if (!is_boundary) {
                RealType invDx = (RealType)1.0 / (RealType)d_cellSize;
                RealType dt_dx = dt * invDx;

                RealType fL_x[10], fR_x[10];
                RealType fL_y[10], fR_y[10];
                RealType fL_z[10], fR_z[10];

                // --- X Direction ---
                get_face_flux_gpu<RealType, IsMultiMaterial>(states, geom, gx - 1, gy, gz, gx, gy, gz, 0, fL_x, gx, gy, gz, s_is_near_boundary);
                get_face_flux_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz, gx + 1, gy, gz, 0, fR_x, gx, gy, gz, s_is_near_boundary);

                // --- Y Direction ---
                get_face_flux_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy - 1, gz, gx, gy, gz, 1, fL_y, gx, gy, gz, s_is_near_boundary);
                get_face_flux_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz, gx, gy + 1, gz, 1, fR_y, gx, gy, gz, s_is_near_boundary);

                // --- Z Direction ---
                get_face_flux_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz - 1, gx, gy, gz, 2, fL_z, gx, gy, gz, s_is_near_boundary);
                get_face_flux_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz, gx, gy, gz + 1, 2, fR_z, gx, gy, gz, s_is_near_boundary);

                apply_flux_update_gpu<RealType, IsMultiMaterial>(U, U_prev, t_idx, c_idx, dt_dx, fL_x, fR_x, fL_y, fR_y, fL_z, fR_z, states, rk_stage);
            }
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) compute_flux_x_kernel_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states,
    ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U,
    const int* __restrict__ active_tile_indices,
    const uint8_t* __restrict__ tile_is_near_boundary,
    const GeometryTile3D* __restrict__ geom,
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
        RealType invDx = (RealType)1.0 / (RealType)d_cellSize;
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
    const PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states,
    ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U,
    const int* __restrict__ active_tile_indices,
    const uint8_t* __restrict__ tile_is_near_boundary,
    const GeometryTile3D* __restrict__ geom,
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
        RealType invDx = (RealType)1.0 / (RealType)d_cellSize;
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
    const PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states,
    ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U,
    const int* __restrict__ active_tile_indices,
    const uint8_t* __restrict__ tile_is_near_boundary,
    const GeometryTile3D* __restrict__ geom,
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
        RealType invDx = (RealType)1.0 / (RealType)d_cellSize;
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
__global__ void __launch_bounds__(512) init_states_kernel_3d(
    PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states,
    ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U,
    const GeometryTile3D* __restrict__ geom,
    const uint8_t* __restrict__ submesh_mask = nullptr
) {
    int t_idx = blockIdx.x;
    if (t_idx >= d_ntx * d_nty * d_ntz) return;

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    states[t_idx].rho[c_idx] = (RealType)d_ambient_rho;
    states[t_idx].ux[c_idx] = 0.0;
    states[t_idx].uy[c_idx] = 0.0;
    states[t_idx].uz[c_idx] = 0.0;
    states[t_idx].p[c_idx] = (RealType)d_ambient_p;
    states[t_idx].floor_status[c_idx] = 0;
    if constexpr (IsMultiMaterial) {
        states[t_idx].alpha1[c_idx] = 0.0;
        states[t_idx].alpha2[c_idx] = 0.0;
        states[t_idx].arho1[c_idx] = 0.0;
        states[t_idx].arho2[c_idx] = 0.0;
    }
    
    RealType E;
    if constexpr (IsMultiMaterial) {
        E = MultiMat::getMixtureEnergy<RealType>((RealType)d_ambient_p, (RealType)d_ambient_rho, (RealType)0.0, (RealType)0.0, (RealType)0.0, (RealType)0.0, (RealType)d_gamma, d_products, d_unreacted);
    } else {
        E = (RealType)d_ambient_p / ((RealType)d_gamma - (RealType)1.0);
    }

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

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) update_primitive_kernel_3d(
    PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states,
    ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U,
    const int* __restrict__ active_tile_indices,
    const GeometryTile3D* __restrict__ geom
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
        E = MultiMat::getMixtureEnergy<RealType>((RealType)d_ambient_p, (RealType)d_ambient_rho, (RealType)0.0, (RealType)0.0, (RealType)0.0, (RealType)0.0, (RealType)d_gamma, d_products, d_unreacted);
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

            RealType p_val = MultiMat::getMixturePressure<RealType>(e_int, rho, alpha1, alpha2, arho1, arho2, (RealType)d_gamma, d_products, d_unreacted);
            if (isnan(p_val) || isinf(p_val)) {
                bad = true;
            } else {
                p = fmax(p_val, (RealType)1e-8);
                E = u_E;
                U[t_idx].alpha1[c_idx] = alpha1;
                U[t_idx].alpha2[c_idx] = alpha2;
                U[t_idx].arho1[c_idx] = arho1;
                U[t_idx].arho2[c_idx] = arho2;
            }
        } else {
            RealType p_val = e_int * ((RealType)d_gamma - (RealType)1.0);
            if (isnan(p_val) || isinf(p_val)) {
                bad = true;
            } else {
                p = fmax(p_val, (RealType)1e-8);
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
            E = MultiMat::getMixtureEnergy<RealType>((RealType)d_ambient_p, (RealType)d_ambient_rho, (RealType)0.0, (RealType)0.0, (RealType)0.0, (RealType)0.0, (RealType)d_gamma, d_products, d_unreacted);
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
            E = MultiMat::getMixtureEnergy<RealType>((RealType)d_ambient_p, (RealType)d_ambient_rho, (RealType)0.0, (RealType)0.0, (RealType)0.0, (RealType)0.0, (RealType)d_gamma, d_products, d_unreacted);
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

    RealType tmp_alpha1 = U[t_idx].alpha1[c_idx];
    RealType tmp_alpha2 = U[t_idx].alpha2[c_idx];
    RealType tmp_arho1 = U[t_idx].arho1[c_idx];
    RealType tmp_arho2 = U[t_idx].arho2[c_idx];

    RealType dF = MultiMat::computeProgrammedBurn<RealType>(
        (RealType)currentTime, dt, x_c, y_c, z_c,
        (RealType)d_det_vel, (RealType)0.0, (RealType)d_detX, (RealType)d_detY, (RealType)d_detZ,
        (RealType)d_cellSize, (RealType)d_products.rho0,
        tmp_alpha1, tmp_alpha2, tmp_arho1, tmp_arho2
    );

    if (dF > (RealType)0.0) {
        if (d_detonation_energy > 0.0) {
            RealType rho_expl = tmp_arho1 + tmp_arho2;
            U[t_idx].E[c_idx] += dF * rho_expl * (RealType)d_detonation_energy;
        }
        U[t_idx].alpha1[c_idx] = tmp_alpha1;
        U[t_idx].alpha2[c_idx] = tmp_alpha2;
        U[t_idx].arho1[c_idx] = tmp_arho1;
        U[t_idx].arho2[c_idx] = tmp_arho2;
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

    RealType x0_cell = xmin + (RealType)gx * cellSize;
    RealType y0_cell = ymin + (RealType)gy * cellSize;
    RealType z0_cell = zmin + (RealType)gz * cellSize;
    RealType h_micro = cellSize / (RealType)4.0;

    int points_inside = 0;
    for (int sk = 0; sk < 4; ++sk) {
        double pz = (double)z0_cell + (sk + 0.5) * (double)h_micro;
        double dz_p = pz - charge.z;
        for (int sj = 0; sj < 4; ++sj) {
            double py = (double)y0_cell + (sj + 0.5) * (double)h_micro;
            double dy_p = py - charge.y;
            for (int si = 0; si < 4; ++si) {
                double px = (double)x0_cell + (si + 0.5) * (double)h_micro;
                double dx_p = px - charge.x;
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
    RealType f_vol = (RealType)(points_inside / 64.0);

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
    }
    active_tiles[t_idx] = 1;

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
        init_E = MultiMat::getMixtureEnergy<RealType>(p, rho, alpha1, alpha2, arho1, arho2, (RealType)gamma, d_products, d_unreacted);
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
            total_E = MultiMat::getMixtureEnergy<RealType>(tile.p[c_idx], tile.rho[c_idx], tile.alpha1[c_idx], tile.alpha2[c_idx], tile.arho1[c_idx], tile.arho2[c_idx], (RealType)d_gamma, d_products, d_unreacted) + ke;
        } else {
            total_E = tile.p[c_idx] / ((RealType)d_gamma - (RealType)1.0) + ke;
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
__device__ float get_value_by_qty_struct(const GPUCellStateT<RealType, IsMultiMaterial>& tile, int qty_id) {
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
            total_E = MultiMat::getMixtureEnergy<RealType>(tile.p, tile.rho, tile.alpha1, tile.alpha2, tile.arho1, tile.arho2, (RealType)d_gamma, d_products, d_unreacted) + ke;
        } else {
            total_E = tile.p / ((RealType)d_gamma - (RealType)1.0) + ke;
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
__device__ GPUCellStateT<RealType, IsMultiMaterial> sample_state_with_mirror_gpu(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    const GeometryTile3D* geom,
    int gx, int gy, int gz,
    double xmin, double ymin, double zmin, double cellSize
) {
    GPUCellStateT<RealType, IsMultiMaterial> sC = sample_gpu_raw<RealType, IsMultiMaterial>(states, gx, gy, gz);

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
                }

                double ke = 0.5 * sC.rho * (sC.ux*sC.ux + sC.uy*sC.uy + sC.uz*sC.uz);
                if constexpr (IsMultiMaterial) {
                    sC.E = MultiMat::getMixtureEnergy<RealType>(sC.p, sC.rho, sC.alpha1, sC.alpha2, sC.arho1, sC.arho2, (RealType)d_gamma, d_products, d_unreacted) + ke;
                } else {
                    sC.E = sC.p / ((RealType)d_gamma - (RealType)1.0) + ke;
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
                        sC.E = MultiMat::getMixtureEnergy<RealType>(sC.p, sC.rho, sC.alpha1, sC.alpha2, sC.arho1, sC.arho2, (RealType)d_gamma, d_products, d_unreacted) + ke;
                    } else {
                        sC.E = sC.p / ((RealType)d_gamma - (RealType)1.0) + ke;
                    }
                }
            }
        }
    }
    return sC;
}

template <typename RealType, bool IsMultiMaterial>
__global__ void extract_obstacles_kernel(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states,
    const GeometryTile3D* __restrict__ geom,
    const GPUObstacleFace* __restrict__ faces,
    float* __restrict__ out_buf,
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
__global__ void extract_slice_kernel(const PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states, const GeometryTile3D* __restrict__ geom, float* __restrict__ data, int nx, int ny, int nz, int axis, double offset, double xmin, double ymin, double zmin, double dx, int qty_id, int stride) {
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
        GPUCellStateT<RealType, IsMultiMaterial> sC = sample_state_with_mirror_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz, xmin, ymin, zmin, dx);
        data[i + j * w] = get_value_by_qty_struct<RealType, IsMultiMaterial>(sC, qty_id);
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void extract_volume_kernel(const PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states, const GeometryTile3D* __restrict__ geom, float* __restrict__ data, int nx, int ny, int nz, int out_nx, int out_ny, int out_nz, double xmin, double ymin, double zmin, double dx, int qty_id, int stride, int factor = 1) {
    int gx = blockIdx.x * blockDim.x + threadIdx.x;
    int gy = blockIdx.y * blockDim.y + threadIdx.y;
    int gz = blockIdx.z * blockDim.z + threadIdx.z;

    if (gx >= out_nx || gy >= out_ny || gz >= out_nz) return;

    int orig_x = (gx * stride) / factor;
    int orig_y = (gy * stride) / factor;
    int orig_z = (gz * stride) / factor;

    if (orig_x >= nx || orig_y >= ny || orig_z >= nz) return;

    size_t out_idx = (size_t)gx + (size_t)gy * out_nx + (size_t)gz * out_nx * out_ny;

    if (qty_id == 7) {
        if (geom == nullptr) {
            data[out_idx] = 0.0f;
        } else {
            int tx = orig_x / 8;
            int ty = orig_y / 8;
            int tz = orig_z / 8;
            int ttx = (nx + 7) / 8;
            int tty = (ny + 7) / 8;
            int t_idx = tx + ty * ttx + tz * ttx * tty;
            int cx = orig_x % 8;
            int cy = orig_y % 8;
            int cz = orig_z % 8;
            int c_idx = cx + cy * 8 + cz * 64;
            data[out_idx] = geom[t_idx].cells[c_idx].is_boundary ? 1.0f : 0.0f;
        }
    } else {
        int target_x = orig_x;
        int target_y = orig_y;
        int target_z = orig_z;
        if (geom != nullptr) {
            int tx = orig_x / 8;
            int ty = orig_y / 8;
            int tz = orig_z / 8;
            int ttx = (nx + 7) / 8;
            int tty = (ny + 7) / 8;
            int t_idx = tx + ty * ttx + tz * ttx * tty;
            int cx = orig_x % 8;
            int cy = orig_y % 8;
            int cz = orig_z % 8;
            int c_idx = cx + cy * 8 + cz * 64;
            if (geom[t_idx].cells[c_idx].is_boundary) {
                bool found = false;
                for (int r = 1; r <= 2 && !found; ++r) {
                    for (int dz = -r; dz <= r && !found; ++dz) {
                        for (int dy = -r; dy <= r && !found; ++dy) {
                            for (int dx_c = -r; dx_c <= r && !found; ++dx_c) {
                                int nx_c = orig_x + dx_c;
                                int ny_c = orig_y + dy;
                                int nz_c = orig_z + dz;
                                if (nx_c >= 0 && nx_c < nx && ny_c >= 0 && ny_c < ny && nz_c >= 0 && nz_c < nz) {
                                    int n_tx = nx_c / 8;
                                    int n_ty = ny_c / 8;
                                    int n_tz = nz_c / 8;
                                    int n_t_idx = n_tx + n_ty * ttx + n_tz * ttx * tty;
                                    int n_cx = nx_c % 8;
                                    int n_cy = ny_c % 8;
                                    int n_cz = nz_c % 8;
                                    int n_c_idx = n_cx + n_cy * 8 + n_cz * 64;
                                    if (!geom[n_t_idx].cells[n_c_idx].is_boundary) {
                                        target_x = nx_c;
                                        target_y = ny_c;
                                        target_z = nz_c;
                                        found = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        GPUCellStateT<RealType, IsMultiMaterial> sC = sample_state_with_mirror_gpu<RealType, IsMultiMaterial>(states, geom, target_x, target_y, target_z, xmin, ymin, zmin, dx);
        data[out_idx] = get_value_by_qty_struct<RealType, IsMultiMaterial>(sC, qty_id);
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
    constants_dirty = true;
}

template <typename RealType, bool IsMultiMaterial>
CFDSolver3DCuda<RealType, IsMultiMaterial>::~CFDSolver3DCuda() {
    freeGPUSubMeshes();
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
    if (d_submesh_buffers_gauge) cudaFree(d_submesh_buffers_gauge);
    if (host_pinned_gauge_data) cudaFreeHost(host_pinned_gauge_data);
    if (gauge_stream) cudaStreamDestroy((cudaStream_t)gauge_stream);
    if (step_done) cudaEventDestroy((cudaEvent_t)step_done);
    if (d_obstacle_faces) cudaFree(d_obstacle_faces);
    if (d_states_old) { cudaFree(d_states_old); d_states_old = nullptr; }
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
    if (!is_paged_out && d_states != nullptr && d_U != nullptr) return;

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

    if (paged_states.size() == (size_t)total_tiles) {
        CHECK_CUDA(cudaMemcpy(d_states, paged_states.data(), total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyHostToDevice));
    }
    if (paged_U.size() == (size_t)total_tiles) {
        CHECK_CUDA(cudaMemcpy(d_U, paged_U.data(), total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>), cudaMemcpyHostToDevice));
    }
    if (has_paged_dU && paged_dU.size() == (size_t)total_tiles) {
        CHECK_CUDA(cudaMemcpy(d_dU, paged_dU.data(), total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>), cudaMemcpyHostToDevice));
    }
    if (has_paged_geom && paged_geom.size() == (size_t)total_tiles) {
        CHECK_CUDA(cudaMemcpy(d_geom, paged_geom.data(), total_tiles * sizeof(GeometryTile3D), cudaMemcpyHostToDevice));
    }
    if (paged_active_tiles.size() == (size_t)total_tiles) {
        CHECK_CUDA(cudaMemcpy(d_active_tiles, paged_active_tiles.data(), total_tiles * sizeof(uint8_t), cudaMemcpyHostToDevice));
    }
    if (paged_tile_active_temp.size() == (size_t)total_tiles) {
        CHECK_CUDA(cudaMemcpy(d_tile_active_temp, paged_tile_active_temp.data(), total_tiles * sizeof(uint8_t), cudaMemcpyHostToDevice));
    }

    if (has_paged_tile_is_near_boundary && paged_tile_is_near_boundary.size() == (size_t)total_tiles) {
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
    constants_dirty = true;
    bind_constants();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::bind_constants() const {
    if (!constants_dirty) return;
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
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
    CHECK_CUDA(cudaMemcpyToSymbol(d_gamma, &gamma, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_ambient_rho, &ambient_rho, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_ambient_p, &ambient_p, sizeof(double)));
    bool useAUSM = (currentFluxScheme == "AUSM+");
    CHECK_CUDA(cudaMemcpyToSymbol(d_useAUSM, &useAUSM, sizeof(bool)));
    int b1 = (int)bcXmin, b2 = (int)bcXmax, b3 = (int)bcYmin, b4 = (int)bcYmax, b5 = (int)bcZmin, b6 = (int)bcZmax;
    CHECK_CUDA(cudaMemcpyToSymbol(d_bcXmin, &b1, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_bcXmax, &b2, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_bcYmin, &b3, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_bcYmax, &b4, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_bcZmin, &b5, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_bcZmax, &b6, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_spatialOrder, &spatialOrder, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_temporalOrder, &temporalOrder, sizeof(int)));
    if constexpr (IsMultiMaterial) {
        CHECK_CUDA(cudaMemcpyToSymbol(d_products, &currentMaterials.products, sizeof(MultiMat::JWLParams)));
        CHECK_CUDA(cudaMemcpyToSymbol(d_unreacted, &currentMaterials.unreacted, sizeof(MultiMat::JWLParams)));
        CHECK_CUDA(cudaMemcpyToSymbol(d_det_vel, &currentMaterials.det_vel, sizeof(double)));
    }
    CHECK_CUDA(cudaMemcpyToSymbol(d_detX, &detX, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_detY, &detY, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_detZ, &detZ, sizeof(double)));
    CHECK_CUDA(cudaDeviceSynchronize());
    constants_dirty = false;
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
    constants_dirty = true;
}

template <typename RealType, bool IsMultiMaterial>
__global__ void update_conservative_from_primitive_kernel_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states,
    ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U,
    int total_tiles,
    RealType gamma,
    MultiMat::JWLParams products,
    MultiMat::JWLParams unreacted
);

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setInitialCondition(const Charge3DParams& charge, const MultiMat::MaterialSet& materials, double amb_rho, double amb_p) {
    ambient_rho = amb_rho;
    ambient_p = amb_p;
    bind_constants();
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

    init_states_kernel_3d<RealType, IsMultiMaterial><<<total_tiles, 512>>>(
        (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
        (GeometryTile3D*)d_geom
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
    if (grid_manager && grid_manager->getSubMeshCount() > 0) {
        temp_h_tiles.resize(total_tiles);
        CHECK_CUDA(cudaMemcpy(temp_h_tiles.data(), d_states, total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyDeviceToHost));
        grid_manager->syncRootFromTiles(temp_h_tiles, nx, ny, nz, ntx, nty, (RealType)gamma, &currentMaterials);
        
        RealType p_exp = (RealType)materials.unreacted.rho0 * (RealType)materials.detonation_energy * ((RealType)gamma - (RealType)1.0);
        if constexpr (!IsMultiMaterial) {
            p_exp = (RealType)materials.unreacted.rho0 * (RealType)materials.detonation_energy * ((RealType)gamma - (RealType)1.0);
        }
        grid_manager->initializeExplosiveSuperSampled(charge, (RealType)materials.unreacted.rho0, p_exp, (RealType)gamma);
        grid_manager->syncRootToTiles(temp_h_tiles, nx, ny, nz, ntx, nty);
        CHECK_CUDA(cudaMemcpy(d_states, temp_h_tiles.data(), total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyHostToDevice));

        // Synchronize GPU d_U (conservative states) from updated d_states
        dim3 c_threads(8, 8, 8);
        update_conservative_from_primitive_kernel_3d<RealType, IsMultiMaterial><<<total_tiles, c_threads>>>(
            (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
            total_tiles, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted
        );
        CHECK_CUDA(cudaDeviceSynchronize());
        syncSubMeshesToGPU();

        allocateGPUSubMeshes();
        syncSubMeshesToGPU();
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) average_U_kernel_3d(ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U, const ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U_prev, const int* __restrict__ active_tile_indices, RealType w0, RealType w1) {
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
__global__ void __launch_bounds__(512) williamson_stage_A_kernel_3d(ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ dU, const int* __restrict__ active_tile_indices, RealType a) {
    int t_idx = active_tile_indices[blockIdx.x];

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    if (a == (RealType)0.0) {
        dU[t_idx].rho[c_idx] = (RealType)0.0;
        dU[t_idx].rhoux[c_idx] = (RealType)0.0;
        dU[t_idx].rhouy[c_idx] = (RealType)0.0;
        dU[t_idx].rhouz[c_idx] = (RealType)0.0;
        dU[t_idx].E[c_idx] = (RealType)0.0;
        if constexpr (IsMultiMaterial) {
            dU[t_idx].alpha1[c_idx] = (RealType)0.0;
            dU[t_idx].alpha2[c_idx] = (RealType)0.0;
            dU[t_idx].arho1[c_idx] = (RealType)0.0;
            dU[t_idx].arho2[c_idx] = (RealType)0.0;
        }
    } else {
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
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) williamson_stage_B_kernel_3d(ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U, const ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ dU, const int* __restrict__ active_tile_indices, RealType b) {
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
__global__ void __launch_bounds__(512) update_conservative_from_primitive_kernel_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states,
    ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U,
    int total_tiles,
    RealType gamma,
    MultiMat::JWLParams products,
    MultiMat::JWLParams unreacted
) {
    int t_idx = blockIdx.x;
    if (t_idx >= total_tiles) return;

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    RealType rho = states[t_idx].rho[c_idx];
    RealType ux = states[t_idx].ux[c_idx];
    RealType uy = states[t_idx].uy[c_idx];
    RealType uz = states[t_idx].uz[c_idx];
    RealType p = states[t_idx].p[c_idx];

    U[t_idx].rho[c_idx] = rho;
    U[t_idx].rhoux[c_idx] = rho * ux;
    U[t_idx].rhouy[c_idx] = rho * uy;
    U[t_idx].rhouz[c_idx] = rho * uz;

    RealType ke = (RealType)0.5 * rho * (ux*ux + uy*uy + uz*uz);
    RealType total_E;
    if constexpr (IsMultiMaterial) {
        RealType a1 = states[t_idx].alpha1[c_idx];
        RealType a2 = states[t_idx].alpha2[c_idx];
        RealType ar1 = states[t_idx].arho1[c_idx];
        RealType ar2 = states[t_idx].arho2[c_idx];
        U[t_idx].alpha1[c_idx] = a1;
        U[t_idx].alpha2[c_idx] = a2;
        U[t_idx].arho1[c_idx] = ar1;
        U[t_idx].arho2[c_idx] = ar2;
        total_E = MultiMat::getMixtureEnergy<RealType>(p, rho, a1, a2, ar1, ar2, (RealType)gamma, products, unreacted) + ke;
    } else {
        total_E = p / max((RealType)1e-6, gamma - (RealType)1.0) + ke;
    }
    U[t_idx].E[c_idx] = total_E;
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) update_peak_quantities_kernel_3d(
    PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states,
    const int* __restrict__ active_tile_indices,
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
void CFDSolver3DCuda<RealType, IsMultiMaterial>::allocateGPUSubMeshes() const {
    if (!grid_manager || grid_manager->getSubMeshCount() == 0) return;

    // Allocate parent-grid snapshot buffer for temporal prolongation interpolation.
    // This must exist before any step() call that uses submeshes.
    if (!d_states_old) {
        int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
        int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
        int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
        int total_tiles = ntx * nty * ntz;
        CHECK_CUDA(cudaMalloc(&d_states_old, total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>)));
        // Initialise to current d_states so first-step prolongation is stable
        CHECK_CUDA(cudaMemcpy(d_states_old, d_states, total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyDeviceToDevice));
    }

    const auto& host_submeshes = grid_manager->getSubMeshes();
    gpu_submeshes.resize(host_submeshes.size());

    for (size_t idx = 0; idx < host_submeshes.size(); ++idx) {
        const auto& sm = host_submeshes[idx];
        auto& gpu_sm = gpu_submeshes[idx];

        if (gpu_sm.is_allocated) continue;

        gpu_sm.id = sm->id;
        gpu_sm.parent_id = sm->parent_id;
        gpu_sm.level = sm->level;
        gpu_sm.parent_idx = -1;
        if (gpu_sm.parent_id != "root" && !gpu_sm.parent_id.empty()) {
            for (size_t p = 0; p < host_submeshes.size(); ++p) {
                if (host_submeshes[p]->id == gpu_sm.parent_id) {
                    gpu_sm.parent_idx = (int)p;
                    break;
                }
            }
        }
        gpu_sm.nx = sm->nx;
        gpu_sm.ny = sm->ny;
        gpu_sm.nz = sm->nz;
        gpu_sm.xmin = sm->xmin;
        gpu_sm.xmax = sm->xmax;
        gpu_sm.ymin = sm->ymin;
        gpu_sm.ymax = sm->ymax;
        gpu_sm.zmin = sm->zmin;
        gpu_sm.zmax = sm->zmax;
        gpu_sm.cellSize = sm->cellSize;

        size_t total_cells = (size_t)sm->nx * sm->ny * sm->nz;
        size_t bytes = total_cells * sizeof(RealType);

        CHECK_CUDA(cudaMalloc(&gpu_sm.d_rho, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_ux, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_uy, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_uz, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_p, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_E, bytes));

        CHECK_CUDA(cudaMalloc(&gpu_sm.d_rho_old, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_ux_old, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_uy_old, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_uz_old, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_p_old, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_E_old, bytes));

        CHECK_CUDA(cudaMalloc(&gpu_sm.d_new_rho, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_new_ux, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_new_uy, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_new_uz, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_new_p, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_new_E, bytes));

        CHECK_CUDA(cudaMalloc(&gpu_sm.d_rk_rho, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_rk_ux, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_rk_uy, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_rk_uz, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_rk_p, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_rk_E, bytes));

        CHECK_CUDA(cudaMalloc(&gpu_sm.d_peak_overpressure, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_peak_impulse, bytes));
        CHECK_CUDA(cudaMalloc(&gpu_sm.d_is_boundary, total_cells * sizeof(uint8_t)));
        CHECK_CUDA(cudaMemset(gpu_sm.d_is_boundary, 0, total_cells * sizeof(uint8_t)));

        if constexpr (IsMultiMaterial) {
            CHECK_CUDA(cudaMalloc(&gpu_sm.d_alpha1, bytes));
            CHECK_CUDA(cudaMalloc(&gpu_sm.d_alpha2, bytes));
            CHECK_CUDA(cudaMalloc(&gpu_sm.d_arho1, bytes));
            CHECK_CUDA(cudaMalloc(&gpu_sm.d_arho2, bytes));

            CHECK_CUDA(cudaMalloc(&gpu_sm.d_alpha1_old, bytes));
            CHECK_CUDA(cudaMalloc(&gpu_sm.d_alpha2_old, bytes));
            CHECK_CUDA(cudaMalloc(&gpu_sm.d_arho1_old, bytes));
            CHECK_CUDA(cudaMalloc(&gpu_sm.d_arho2_old, bytes));

            CHECK_CUDA(cudaMalloc(&gpu_sm.d_new_alpha1, bytes));
            CHECK_CUDA(cudaMalloc(&gpu_sm.d_new_alpha2, bytes));
            CHECK_CUDA(cudaMalloc(&gpu_sm.d_new_arho1, bytes));
            CHECK_CUDA(cudaMalloc(&gpu_sm.d_new_arho2, bytes));

            CHECK_CUDA(cudaMalloc(&gpu_sm.d_rk_alpha1, bytes));
            CHECK_CUDA(cudaMalloc(&gpu_sm.d_rk_alpha2, bytes));
            CHECK_CUDA(cudaMalloc(&gpu_sm.d_rk_arho1, bytes));
            CHECK_CUDA(cudaMalloc(&gpu_sm.d_rk_arho2, bytes));
        }

        gpu_sm.is_allocated = true;
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::freeGPUSubMeshes() const {
    for (auto& gpu_sm : gpu_submeshes) {
        if (!gpu_sm.is_allocated) continue;
        if (gpu_sm.d_rho) cudaFree(gpu_sm.d_rho);
        if (gpu_sm.d_ux) cudaFree(gpu_sm.d_ux);
        if (gpu_sm.d_uy) cudaFree(gpu_sm.d_uy);
        if (gpu_sm.d_uz) cudaFree(gpu_sm.d_uz);
        if (gpu_sm.d_p) cudaFree(gpu_sm.d_p);
        if (gpu_sm.d_E) cudaFree(gpu_sm.d_E);

        if (gpu_sm.d_rho_old) cudaFree(gpu_sm.d_rho_old);
        if (gpu_sm.d_ux_old) cudaFree(gpu_sm.d_ux_old);
        if (gpu_sm.d_uy_old) cudaFree(gpu_sm.d_uy_old);
        if (gpu_sm.d_uz_old) cudaFree(gpu_sm.d_uz_old);
        if (gpu_sm.d_p_old) cudaFree(gpu_sm.d_p_old);
        if (gpu_sm.d_E_old) cudaFree(gpu_sm.d_E_old);

        if (gpu_sm.d_new_rho) cudaFree(gpu_sm.d_new_rho);
        if (gpu_sm.d_new_ux) cudaFree(gpu_sm.d_new_ux);
        if (gpu_sm.d_new_uy) cudaFree(gpu_sm.d_new_uy);
        if (gpu_sm.d_new_uz) cudaFree(gpu_sm.d_new_uz);
        if (gpu_sm.d_new_p) cudaFree(gpu_sm.d_new_p);
        if (gpu_sm.d_new_E) cudaFree(gpu_sm.d_new_E);

        if (gpu_sm.d_rk_rho) cudaFree(gpu_sm.d_rk_rho);
        if (gpu_sm.d_rk_ux) cudaFree(gpu_sm.d_rk_ux);
        if (gpu_sm.d_rk_uy) cudaFree(gpu_sm.d_rk_uy);
        if (gpu_sm.d_rk_uz) cudaFree(gpu_sm.d_rk_uz);
        if (gpu_sm.d_rk_p) cudaFree(gpu_sm.d_rk_p);
        if (gpu_sm.d_rk_E) cudaFree(gpu_sm.d_rk_E);

        if (gpu_sm.d_peak_overpressure) cudaFree(gpu_sm.d_peak_overpressure);
        if (gpu_sm.d_peak_impulse) cudaFree(gpu_sm.d_peak_impulse);
        if (gpu_sm.d_is_boundary) cudaFree(gpu_sm.d_is_boundary);

        if constexpr (IsMultiMaterial) {
            if (gpu_sm.d_alpha1) cudaFree(gpu_sm.d_alpha1);
            if (gpu_sm.d_alpha2) cudaFree(gpu_sm.d_alpha2);
            if (gpu_sm.d_arho1) cudaFree(gpu_sm.d_arho1);
            if (gpu_sm.d_arho2) cudaFree(gpu_sm.d_arho2);

            if (gpu_sm.d_alpha1_old) cudaFree(gpu_sm.d_alpha1_old);
            if (gpu_sm.d_alpha2_old) cudaFree(gpu_sm.d_alpha2_old);
            if (gpu_sm.d_arho1_old) cudaFree(gpu_sm.d_arho1_old);
            if (gpu_sm.d_arho2_old) cudaFree(gpu_sm.d_arho2_old);

            if (gpu_sm.d_new_alpha1) cudaFree(gpu_sm.d_new_alpha1);
            if (gpu_sm.d_new_alpha2) cudaFree(gpu_sm.d_new_alpha2);
            if (gpu_sm.d_new_arho1) cudaFree(gpu_sm.d_new_arho1);
            if (gpu_sm.d_new_arho2) cudaFree(gpu_sm.d_new_arho2);

            if (gpu_sm.d_rk_alpha1) cudaFree(gpu_sm.d_rk_alpha1);
            if (gpu_sm.d_rk_alpha2) cudaFree(gpu_sm.d_rk_alpha2);
            if (gpu_sm.d_rk_arho1) cudaFree(gpu_sm.d_rk_arho1);
            if (gpu_sm.d_rk_arho2) cudaFree(gpu_sm.d_rk_arho2);
        }
        gpu_sm.is_allocated = false;
    }
    gpu_submeshes.clear();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::syncSubMeshesToGPU() const {
    if (!grid_manager || grid_manager->getSubMeshCount() == 0) return;
    allocateGPUSubMeshes();

    const auto& host_submeshes = grid_manager->getSubMeshes();
    for (size_t idx = 0; idx < host_submeshes.size(); ++idx) {
        const auto& sm = host_submeshes[idx];
        auto& gpu_sm = gpu_submeshes[idx];
        size_t total_cells = (size_t)sm->nx * sm->ny * sm->nz;
        size_t bytes = total_cells * sizeof(RealType);

        CHECK_CUDA(cudaMemcpy(gpu_sm.d_rho, sm->rho.data(), bytes, cudaMemcpyHostToDevice));
        CHECK_CUDA(cudaMemcpy(gpu_sm.d_ux, sm->ux.data(), bytes, cudaMemcpyHostToDevice));
        CHECK_CUDA(cudaMemcpy(gpu_sm.d_uy, sm->uy.data(), bytes, cudaMemcpyHostToDevice));
        CHECK_CUDA(cudaMemcpy(gpu_sm.d_uz, sm->uz.data(), bytes, cudaMemcpyHostToDevice));
        CHECK_CUDA(cudaMemcpy(gpu_sm.d_p, sm->p.data(), bytes, cudaMemcpyHostToDevice));
        CHECK_CUDA(cudaMemcpy(gpu_sm.d_E, sm->E.data(), bytes, cudaMemcpyHostToDevice));

        CHECK_CUDA(cudaMemcpy(gpu_sm.d_rho_old, sm->rho.data(), bytes, cudaMemcpyHostToDevice));
        CHECK_CUDA(cudaMemcpy(gpu_sm.d_ux_old, sm->ux.data(), bytes, cudaMemcpyHostToDevice));
        CHECK_CUDA(cudaMemcpy(gpu_sm.d_uy_old, sm->uy.data(), bytes, cudaMemcpyHostToDevice));
        CHECK_CUDA(cudaMemcpy(gpu_sm.d_uz_old, sm->uz.data(), bytes, cudaMemcpyHostToDevice));
        CHECK_CUDA(cudaMemcpy(gpu_sm.d_p_old, sm->p.data(), bytes, cudaMemcpyHostToDevice));
        CHECK_CUDA(cudaMemcpy(gpu_sm.d_E_old, sm->E.data(), bytes, cudaMemcpyHostToDevice));

        CHECK_CUDA(cudaMemcpy(gpu_sm.d_peak_overpressure, sm->peak_overpressure.data(), bytes, cudaMemcpyHostToDevice));
        CHECK_CUDA(cudaMemcpy(gpu_sm.d_peak_impulse, sm->peak_impulse.data(), bytes, cudaMemcpyHostToDevice));

        if (!sm->is_boundary.empty() && gpu_sm.d_is_boundary) {
            CHECK_CUDA(cudaMemcpy(gpu_sm.d_is_boundary, sm->is_boundary.data(), total_cells * sizeof(uint8_t), cudaMemcpyHostToDevice));
        } else if (gpu_sm.d_is_boundary) {
            CHECK_CUDA(cudaMemset(gpu_sm.d_is_boundary, 0, total_cells * sizeof(uint8_t)));
        }

        if constexpr (IsMultiMaterial) {
            if (!sm->alpha1.empty() && gpu_sm.d_alpha1) {
                CHECK_CUDA(cudaMemcpy(gpu_sm.d_alpha1, sm->alpha1.data(), bytes, cudaMemcpyHostToDevice));
                CHECK_CUDA(cudaMemcpy(gpu_sm.d_alpha2, sm->alpha2.data(), bytes, cudaMemcpyHostToDevice));
                CHECK_CUDA(cudaMemcpy(gpu_sm.d_arho1, sm->arho1.data(), bytes, cudaMemcpyHostToDevice));
                CHECK_CUDA(cudaMemcpy(gpu_sm.d_arho2, sm->arho2.data(), bytes, cudaMemcpyHostToDevice));

                CHECK_CUDA(cudaMemcpy(gpu_sm.d_alpha1_old, sm->alpha1.data(), bytes, cudaMemcpyHostToDevice));
                CHECK_CUDA(cudaMemcpy(gpu_sm.d_alpha2_old, sm->alpha2.data(), bytes, cudaMemcpyHostToDevice));
                CHECK_CUDA(cudaMemcpy(gpu_sm.d_arho1_old, sm->arho1.data(), bytes, cudaMemcpyHostToDevice));
                CHECK_CUDA(cudaMemcpy(gpu_sm.d_arho2_old, sm->arho2.data(), bytes, cudaMemcpyHostToDevice));
            }
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::syncSubMeshesToHost() const {
    if (!grid_manager || grid_manager->getSubMeshCount() == 0 || gpu_submeshes.empty()) return;

    const auto& host_submeshes = grid_manager->getSubMeshes();
    for (size_t idx = 0; idx < host_submeshes.size(); ++idx) {
        auto& sm = host_submeshes[idx];
        const auto& gpu_sm = gpu_submeshes[idx];
        if (!gpu_sm.is_allocated) continue;

        size_t total_cells = (size_t)sm->nx * sm->ny * sm->nz;
        size_t bytes = total_cells * sizeof(RealType);

        CHECK_CUDA(cudaMemcpy(sm->rho.data(), gpu_sm.d_rho, bytes, cudaMemcpyDeviceToHost));
        CHECK_CUDA(cudaMemcpy(sm->ux.data(), gpu_sm.d_ux, bytes, cudaMemcpyDeviceToHost));
        CHECK_CUDA(cudaMemcpy(sm->uy.data(), gpu_sm.d_uy, bytes, cudaMemcpyDeviceToHost));
        CHECK_CUDA(cudaMemcpy(sm->uz.data(), gpu_sm.d_uz, bytes, cudaMemcpyDeviceToHost));
        CHECK_CUDA(cudaMemcpy(sm->p.data(), gpu_sm.d_p, bytes, cudaMemcpyDeviceToHost));
        CHECK_CUDA(cudaMemcpy(sm->E.data(), gpu_sm.d_E, bytes, cudaMemcpyDeviceToHost));
        CHECK_CUDA(cudaMemcpy(sm->peak_overpressure.data(), gpu_sm.d_peak_overpressure, bytes, cudaMemcpyDeviceToHost));
        CHECK_CUDA(cudaMemcpy(sm->peak_impulse.data(), gpu_sm.d_peak_impulse, bytes, cudaMemcpyDeviceToHost));

        if constexpr (IsMultiMaterial) {
            if (!sm->alpha1.empty() && gpu_sm.d_alpha1) {
                CHECK_CUDA(cudaMemcpy(sm->alpha1.data(), gpu_sm.d_alpha1, bytes, cudaMemcpyDeviceToHost));
                CHECK_CUDA(cudaMemcpy(sm->alpha2.data(), gpu_sm.d_alpha2, bytes, cudaMemcpyDeviceToHost));
                CHECK_CUDA(cudaMemcpy(sm->arho1.data(), gpu_sm.d_arho1, bytes, cudaMemcpyDeviceToHost));
                CHECK_CUDA(cudaMemcpy(sm->arho2.data(), gpu_sm.d_arho2, bytes, cudaMemcpyDeviceToHost));
            }
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void prolongate_ghosts_kernel_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* d_states_old,
    const PrimitiveTile3D<RealType, IsMultiMaterial>* d_states_new,
    RealType tau,
    int ntx, int nty, int ntz, RealType gamma,
    int nx_c, int ny_c, int nz_c,
    RealType xmin_c, RealType ymin_c, RealType zmin_c, RealType h_c,
    RealType xmin_p, RealType ymin_p, RealType zmin_p, RealType h_p,
    int nx_p, int ny_p, int nz_p,
    RealType* d_rho, RealType* d_ux, RealType* d_uy, RealType* d_uz, RealType* d_p, RealType* d_E,
    RealType* d_alpha1, RealType* d_alpha2, RealType* d_arho1, RealType* d_arho2,
    const GeometryTile3D* d_geom,
    int bcXmin, int bcXmax, int bcYmin, int bcYmax, int bcZmin, int bcZmax,
    int n_ghost
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    int j = blockIdx.y * blockDim.y + threadIdx.y;
    int k = blockIdx.z * blockDim.z + threadIdx.z;

    if (i >= nx_c || j >= ny_c || k >= nz_c) return;

    bool is_ghost = (i < n_ghost || i >= nx_c - n_ghost || j < n_ghost || j >= ny_c - n_ghost || k < n_ghost || k >= nz_c - n_ghost);
    if (!is_ghost) return;

    RealType x_child = xmin_c + (i + static_cast<RealType>(0.5)) * h_c;
    RealType y_child = ymin_c + (j + static_cast<RealType>(0.5)) * h_c;
    RealType z_child = zmin_c + (k + static_cast<RealType>(0.5)) * h_c;

    RealType eps_h = static_cast<RealType>(1e-4) * h_p;

    RealType xmax_p = xmin_p + nx_p * h_p;
    RealType ymax_p = ymin_p + ny_p * h_p;
    RealType zmax_p = zmin_p + nz_p * h_p;

    bool out_x_min = (x_child < xmin_p - eps_h);
    bool out_x_max = (x_child > xmax_p + eps_h);
    bool out_y_min = (y_child < ymin_p - eps_h);
    bool out_y_max = (y_child > ymax_p + eps_h);
    bool out_z_min = (z_child < zmin_p - eps_h);
    bool out_z_max = (z_child > zmax_p + eps_h);

    bool is_outside_domain = (out_x_min || out_x_max || out_y_min || out_y_max || out_z_min || out_z_max);
    size_t child_idx = i + j * nx_c + k * nx_c * ny_c;

    if (is_outside_domain) {
        int i_src = i;
        int j_src = j;
        int k_src = k;

        bool flip_ux = false;
        bool flip_uy = false;
        bool flip_uz = false;

        if (out_x_min) {
            if (bcXmin == 0) {
                i_src = 2 * n_ghost - 1 - i;
                flip_ux = true;
            } else {
                i_src = n_ghost;
            }
        } else if (out_x_max) {
            if (bcXmax == 0) {
                i_src = 2 * (nx_c - n_ghost) - 1 - i;
                flip_ux = true;
            } else {
                i_src = nx_c - n_ghost - 1;
            }
        }

        if (out_y_min) {
            if (bcYmin == 0) {
                j_src = 2 * n_ghost - 1 - j;
                flip_uy = true;
            } else {
                j_src = n_ghost;
            }
        } else if (out_y_max) {
            if (bcYmax == 0) {
                j_src = 2 * (ny_c - n_ghost) - 1 - j;
                flip_uy = true;
            } else {
                j_src = ny_c - n_ghost - 1;
            }
        }

        if (out_z_min) {
            if (bcZmin == 0) {
                k_src = 2 * n_ghost - 1 - k;
                flip_uz = true;
            } else {
                k_src = n_ghost;
            }
        } else if (out_z_max) {
            if (bcZmax == 0) {
                k_src = 2 * (nz_c - n_ghost) - 1 - k;
                flip_uz = true;
            } else {
                k_src = nz_c - n_ghost - 1;
            }
        }

        i_src = min(max(i_src, 0), nx_c - 1);
        j_src = min(max(j_src, 0), ny_c - 1);
        k_src = min(max(k_src, 0), nz_c - 1);

        size_t src_idx = i_src + j_src * nx_c + k_src * nx_c * ny_c;

        RealType r_val = d_rho[src_idx];
        RealType u_val = flip_ux ? -d_ux[src_idx] : d_ux[src_idx];
        RealType v_val = flip_uy ? -d_uy[src_idx] : d_uy[src_idx];
        RealType w_val = flip_uz ? -d_uz[src_idx] : d_uz[src_idx];
        RealType p_val = d_p[src_idx];

        d_rho[child_idx] = r_val;
        d_ux[child_idx]  = u_val;
        d_uy[child_idx]  = v_val;
        d_uz[child_idx]  = w_val;
        d_p[child_idx]   = p_val;

        RealType gm1 = max(static_cast<RealType>(1e-4), gamma - static_cast<RealType>(1.0));
        RealType ke = static_cast<RealType>(0.5) * r_val * (u_val*u_val + v_val*v_val + w_val*w_val);

        if constexpr (IsMultiMaterial) {
            RealType a1 = d_alpha1 ? d_alpha1[src_idx] : static_cast<RealType>(0.0);
            RealType a2 = d_alpha2 ? d_alpha2[src_idx] : static_cast<RealType>(0.0);
            RealType ar1 = d_arho1 ? d_arho1[src_idx] : static_cast<RealType>(0.0);
            RealType ar2 = d_arho2 ? d_arho2[src_idx] : static_cast<RealType>(0.0);

            if (d_alpha1) d_alpha1[child_idx] = a1;
            if (d_alpha2) d_alpha2[child_idx] = a2;
            if (d_arho1)  d_arho1[child_idx]  = ar1;
            if (d_arho2)  d_arho2[child_idx]  = ar2;

            d_E[child_idx] = MultiMat::getMixtureEnergy<RealType>(p_val, r_val, a1, a2, ar1, ar2, (RealType)gamma, d_products, d_unreacted) + ke;
        } else {
            d_E[child_idx] = p_val / gm1 + ke;
        }
        return;
    }

    RealType parent_i_f = (x_child - xmin_p) / h_p - static_cast<RealType>(0.5);
    RealType parent_j_f = (y_child - ymin_p) / h_p - static_cast<RealType>(0.5);
    RealType parent_k_f = (z_child - zmin_p) / h_p - static_cast<RealType>(0.5);

    int i0 = min(max((int)floor(parent_i_f), 0), nx_p - 1);
    int j0 = min(max((int)floor(parent_j_f), 0), ny_p - 1);
    int k0 = min(max((int)floor(parent_k_f), 0), nz_p - 1);
    int i1 = min(i0 + 1, nx_p - 1);
    int j1 = min(j0 + 1, ny_p - 1);
    int k1 = min(k0 + 1, nz_p - 1);

    RealType wx = min(max(parent_i_f - i0, static_cast<RealType>(0.0)), static_cast<RealType>(1.0));
    RealType wy = min(max(parent_j_f - j0, static_cast<RealType>(0.0)), static_cast<RealType>(1.0));
    RealType wz = min(max(parent_k_f - k0, static_cast<RealType>(0.0)), static_cast<RealType>(1.0));

    RealType w000 = (1 - wx) * (1 - wy) * (1 - wz);
    RealType w100 = wx * (1 - wy) * (1 - wz);
    RealType w010 = (1 - wx) * wy * (1 - wz);
    RealType w110 = wx * wy * (1 - wz);
    RealType w001 = (1 - wx) * (1 - wy) * wz;
    RealType w101 = wx * (1 - wy) * wz;
    RealType w011 = (1 - wx) * wy * wz;
    RealType w111 = wx * wy * wz;

    auto get_parent_val = [&](const PrimitiveTile3D<RealType, IsMultiMaterial>* p_states, int pi, int pj, int pk, int field_id) -> RealType {
        int tx = pi / 8;
        int ty = pj / 8;
        int tz = pk / 8;
        int t_idx = tx + ty * ntx + tz * ntx * nty;
        int c_idx = (pi % 8) + (pj % 8) * 8 + (pk % 8) * 64;
        const auto& tile = p_states[t_idx];
        if (field_id == 0) return tile.rho[c_idx];
        if (field_id == 1) return tile.ux[c_idx];
        if (field_id == 2) return tile.uy[c_idx];
        if (field_id == 3) return tile.uz[c_idx];
        if (field_id == 4) return tile.p[c_idx];
        if constexpr (IsMultiMaterial) {
            if (field_id == 6) return tile.alpha1[c_idx];
            if (field_id == 7) return tile.alpha2[c_idx];
            if (field_id == 8) return tile.arho1[c_idx];
            if (field_id == 9) return tile.arho2[c_idx];
        }
        return static_cast<RealType>(0.0);
    };

    auto trilinear_interp = [&](const PrimitiveTile3D<RealType, IsMultiMaterial>* p_states, int field_id) -> RealType {
        return w000 * get_parent_val(p_states, i0, j0, k0, field_id) +
               w100 * get_parent_val(p_states, i1, j0, k0, field_id) +
               w010 * get_parent_val(p_states, i0, j1, k0, field_id) +
               w110 * get_parent_val(p_states, i1, j1, k0, field_id) +
               w001 * get_parent_val(p_states, i0, j0, k1, field_id) +
               w101 * get_parent_val(p_states, i1, j0, k1, field_id) +
               w011 * get_parent_val(p_states, i0, j1, k1, field_id) +
               w111 * get_parent_val(p_states, i1, j1, k1, field_id);
    };

    auto interp_temporal = [&](int field_id) -> RealType {
        if (!d_states_old) return trilinear_interp(d_states_new, field_id);
        RealType val_old = trilinear_interp(d_states_old, field_id);
        RealType val_new = trilinear_interp(d_states_new, field_id);
        return (static_cast<RealType>(1.0) - tau) * val_old + tau * val_new;
    };

    RealType r_interp = max(static_cast<RealType>(1e-8), interp_temporal(0));
    RealType u_interp = interp_temporal(1);
    RealType v_interp = interp_temporal(2);
    RealType w_interp = interp_temporal(3);
    RealType p_interp = max(static_cast<RealType>(1e-8), interp_temporal(4));

    d_rho[child_idx] = r_interp;
    d_ux[child_idx] = u_interp;
    d_uy[child_idx] = v_interp;
    d_uz[child_idx] = w_interp;
    d_p[child_idx] = p_interp;

    RealType gm1 = max(static_cast<RealType>(1e-4), gamma - static_cast<RealType>(1.0));
    RealType ke = static_cast<RealType>(0.5) * r_interp * (u_interp*u_interp + v_interp*v_interp + w_interp*w_interp);

    if constexpr (IsMultiMaterial) {
        RealType a1 = (d_alpha1) ? max(static_cast<RealType>(0.0), min(static_cast<RealType>(1.0), interp_temporal(6))) : static_cast<RealType>(0.0);
        RealType a2 = (d_alpha2) ? max(static_cast<RealType>(0.0), min(static_cast<RealType>(1.0), interp_temporal(7))) : static_cast<RealType>(0.0);
        RealType ar1 = (d_arho1) ? max(static_cast<RealType>(0.0), interp_temporal(8)) : static_cast<RealType>(0.0);
        RealType ar2 = (d_arho2) ? max(static_cast<RealType>(0.0), interp_temporal(9)) : static_cast<RealType>(0.0);

        if (d_alpha1) d_alpha1[child_idx] = a1;
        if (d_alpha2) d_alpha2[child_idx] = a2;
        if (d_arho1) d_arho1[child_idx] = ar1;
        if (d_arho2) d_arho2[child_idx] = ar2;

        d_E[child_idx] = MultiMat::getMixtureEnergy<RealType>(p_interp, r_interp, a1, a2, ar1, ar2, (RealType)gamma, d_products, d_unreacted) + ke;
    } else {
        d_E[child_idx] = p_interp / gm1 + ke;
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void prolongate_ghosts_submesh_kernel_3d(
    const RealType* p_rho_old, const RealType* p_ux_old, const RealType* p_uy_old, const RealType* p_uz_old, const RealType* p_p_old, const RealType* p_E_old,
    const RealType* p_alpha1_old, const RealType* p_alpha2_old, const RealType* p_arho1_old, const RealType* p_arho2_old,
    const RealType* p_rho_new, const RealType* p_ux_new, const RealType* p_uy_new, const RealType* p_uz_new, const RealType* p_p_new, const RealType* p_E_new,
    const RealType* p_alpha1_new, const RealType* p_alpha2_new, const RealType* p_arho1_new, const RealType* p_arho2_new,
    RealType tau,
    int nx_p, int ny_p, int nz_p,
    RealType xmin_p, RealType ymin_p, RealType zmin_p, RealType h_p,
    RealType gamma,
    int nx_c, int ny_c, int nz_c,
    RealType xmin_c, RealType ymin_c, RealType zmin_c, RealType h_c,
    RealType xmin_domain, RealType ymin_domain, RealType zmin_domain, RealType h_domain,
    int nx_domain, int ny_domain, int nz_domain,
    RealType* d_rho, RealType* d_ux, RealType* d_uy, RealType* d_uz, RealType* d_p, RealType* d_E,
    RealType* d_alpha1, RealType* d_alpha2, RealType* d_arho1, RealType* d_arho2,
    const GeometryTile3D* d_geom,
    int bcXmin, int bcXmax, int bcYmin, int bcYmax, int bcZmin, int bcZmax,
    int n_ghost
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    int j = blockIdx.y * blockDim.y + threadIdx.y;
    int k = blockIdx.z * blockDim.z + threadIdx.z;

    if (i >= nx_c || j >= ny_c || k >= nz_c) return;

    bool is_ghost = (i < n_ghost || i >= nx_c - n_ghost || j < n_ghost || j >= ny_c - n_ghost || k < n_ghost || k >= nz_c - n_ghost);
    if (!is_ghost) return;

    RealType x_child = xmin_c + (i + static_cast<RealType>(0.5)) * h_c;
    RealType y_child = ymin_c + (j + static_cast<RealType>(0.5)) * h_c;
    RealType z_child = zmin_c + (k + static_cast<RealType>(0.5)) * h_c;

    RealType eps_h = static_cast<RealType>(1e-4) * h_domain;

    RealType xmax_dom = xmin_domain + nx_domain * h_domain;
    RealType ymax_dom = ymin_domain + ny_domain * h_domain;
    RealType zmax_dom = zmin_domain + nz_domain * h_domain;

    bool out_x_min = (x_child < xmin_domain - eps_h);
    bool out_x_max = (x_child > xmax_dom + eps_h);
    bool out_y_min = (y_child < ymin_domain - eps_h);
    bool out_y_max = (y_child > ymax_dom + eps_h);
    bool out_z_min = (z_child < zmin_domain - eps_h);
    bool out_z_max = (z_child > zmax_dom + eps_h);

    bool is_outside_domain = (out_x_min || out_x_max || out_y_min || out_y_max || out_z_min || out_z_max);
    size_t child_idx = i + j * nx_c + k * nx_c * ny_c;

    if (is_outside_domain) {
        int i_src = i;
        int j_src = j;
        int k_src = k;

        bool flip_ux = false;
        bool flip_uy = false;
        bool flip_uz = false;

        if (out_x_min) {
            if (bcXmin == 0) {
                i_src = 2 * n_ghost - 1 - i;
                flip_ux = true;
            } else {
                i_src = n_ghost;
            }
        } else if (out_x_max) {
            if (bcXmax == 0) {
                i_src = 2 * (nx_c - n_ghost) - 1 - i;
                flip_ux = true;
            } else {
                i_src = nx_c - n_ghost - 1;
            }
        }

        if (out_y_min) {
            if (bcYmin == 0) {
                j_src = 2 * n_ghost - 1 - j;
                flip_uy = true;
            } else {
                j_src = n_ghost;
            }
        } else if (out_y_max) {
            if (bcYmax == 0) {
                j_src = 2 * (ny_c - n_ghost) - 1 - j;
                flip_uy = true;
            } else {
                j_src = ny_c - n_ghost - 1;
            }
        }

        if (out_z_min) {
            if (bcZmin == 0) {
                k_src = 2 * n_ghost - 1 - k;
                flip_uz = true;
            } else {
                k_src = n_ghost;
            }
        } else if (out_z_max) {
            if (bcZmax == 0) {
                k_src = 2 * (nz_c - n_ghost) - 1 - k;
                flip_uz = true;
            } else {
                k_src = nz_c - n_ghost - 1;
            }
        }

        i_src = min(max(i_src, 0), nx_c - 1);
        j_src = min(max(j_src, 0), ny_c - 1);
        k_src = min(max(k_src, 0), nz_c - 1);

        size_t src_idx = i_src + j_src * nx_c + k_src * nx_c * ny_c;

        RealType r_val = d_rho[src_idx];
        RealType u_val = flip_ux ? -d_ux[src_idx] : d_ux[src_idx];
        RealType v_val = flip_uy ? -d_uy[src_idx] : d_uy[src_idx];
        RealType w_val = flip_uz ? -d_uz[src_idx] : d_uz[src_idx];
        RealType p_val = d_p[src_idx];

        d_rho[child_idx] = r_val;
        d_ux[child_idx]  = u_val;
        d_uy[child_idx]  = v_val;
        d_uz[child_idx]  = w_val;
        d_p[child_idx]   = p_val;

        RealType gm1 = max(static_cast<RealType>(1e-4), gamma - static_cast<RealType>(1.0));
        RealType ke = static_cast<RealType>(0.5) * r_val * (u_val*u_val + v_val*v_val + w_val*w_val);

        if constexpr (IsMultiMaterial) {
            RealType a1 = d_alpha1 ? d_alpha1[src_idx] : static_cast<RealType>(0.0);
            RealType a2 = d_alpha2 ? d_alpha2[src_idx] : static_cast<RealType>(0.0);
            RealType ar1 = d_arho1 ? d_arho1[src_idx] : static_cast<RealType>(0.0);
            RealType ar2 = d_arho2 ? d_arho2[src_idx] : static_cast<RealType>(0.0);

            if (d_alpha1) d_alpha1[child_idx] = a1;
            if (d_alpha2) d_alpha2[child_idx] = a2;
            if (d_arho1)  d_arho1[child_idx]  = ar1;
            if (d_arho2)  d_arho2[child_idx]  = ar2;

            d_E[child_idx] = MultiMat::getMixtureEnergy<RealType>(p_val, r_val, a1, a2, ar1, ar2, (RealType)gamma, d_products, d_unreacted) + ke;
        } else {
            d_E[child_idx] = p_val / gm1 + ke;
        }
        return;
    }

    RealType parent_i_f = (x_child - xmin_p) / h_p - static_cast<RealType>(0.5);
    RealType parent_j_f = (y_child - ymin_p) / h_p - static_cast<RealType>(0.5);
    RealType parent_k_f = (z_child - zmin_p) / h_p - static_cast<RealType>(0.5);

    int i0 = min(max((int)floor(parent_i_f), 0), nx_p - 1);
    int j0 = min(max((int)floor(parent_j_f), 0), ny_p - 1);
    int k0 = min(max((int)floor(parent_k_f), 0), nz_p - 1);
    int i1 = min(i0 + 1, nx_p - 1);
    int j1 = min(j0 + 1, ny_p - 1);
    int k1 = min(k0 + 1, nz_p - 1);

    RealType wx = min(max(parent_i_f - i0, static_cast<RealType>(0.0)), static_cast<RealType>(1.0));
    RealType wy = min(max(parent_j_f - j0, static_cast<RealType>(0.0)), static_cast<RealType>(1.0));
    RealType wz = min(max(parent_k_f - k0, static_cast<RealType>(0.0)), static_cast<RealType>(1.0));

    RealType w000 = (1 - wx) * (1 - wy) * (1 - wz);
    RealType w100 = wx * (1 - wy) * (1 - wz);
    RealType w010 = (1 - wx) * wy * (1 - wz);
    RealType w110 = wx * wy * (1 - wz);
    RealType w001 = (1 - wx) * (1 - wy) * wz;
    RealType w101 = wx * (1 - wy) * wz;
    RealType w011 = (1 - wx) * wy * wz;
    RealType w111 = wx * wy * wz;

    auto interpolate_p = [&](const RealType* p_buf) -> RealType {
        if (!p_buf) return static_cast<RealType>(0.0);
        size_t idx000 = i0 + j0 * nx_p + k0 * nx_p * ny_p;
        size_t idx100 = i1 + j0 * nx_p + k0 * nx_p * ny_p;
        size_t idx010 = i0 + j1 * nx_p + k0 * nx_p * ny_p;
        size_t idx110 = i1 + j1 * nx_p + k0 * nx_p * ny_p;
        size_t idx001 = i0 + j0 * nx_p + k1 * nx_p * ny_p;
        size_t idx101 = i1 + j0 * nx_p + k1 * nx_p * ny_p;
        size_t idx011 = i0 + j1 * nx_p + k1 * nx_p * ny_p;
        size_t idx111 = i1 + j1 * nx_p + k1 * nx_p * ny_p;

        return w000 * p_buf[idx000] + w100 * p_buf[idx100] +
               w010 * p_buf[idx010] + w110 * p_buf[idx110] +
               w001 * p_buf[idx001] + w101 * p_buf[idx101] +
               w011 * p_buf[idx011] + w111 * p_buf[idx111];
    };

    auto interp_temporal = [&](const RealType* old_buf, const RealType* new_buf) -> RealType {
        if (!old_buf) return interpolate_p(new_buf);
        RealType val_old = interpolate_p(old_buf);
        RealType val_new = interpolate_p(new_buf);
        return (static_cast<RealType>(1.0) - tau) * val_old + tau * val_new;
    };

    RealType r_val = max(static_cast<RealType>(1e-8), interp_temporal(p_rho_old, p_rho_new));
    RealType u_val = interp_temporal(p_ux_old, p_ux_new);
    RealType v_val = interp_temporal(p_uy_old, p_uy_new);
    RealType w_val = interp_temporal(p_uz_old, p_uz_new);
    RealType p_val = max(static_cast<RealType>(1e-8), interp_temporal(p_p_old, p_p_new));

    d_rho[child_idx] = r_val;
    d_ux[child_idx]  = u_val;
    d_uy[child_idx]  = v_val;
    d_uz[child_idx]  = w_val;
    d_p[child_idx]   = p_val;

    RealType gm1 = max(static_cast<RealType>(1e-4), gamma - static_cast<RealType>(1.0));
    RealType ke = static_cast<RealType>(0.5) * r_val * (u_val*u_val + v_val*v_val + w_val*w_val);

    if constexpr (IsMultiMaterial) {
        RealType a1  = min(max(interp_temporal(p_alpha1_old, p_alpha1_new), static_cast<RealType>(0.0)), static_cast<RealType>(1.0));
        RealType a2  = min(max(interp_temporal(p_alpha2_old, p_alpha2_new), static_cast<RealType>(0.0)), static_cast<RealType>(1.0));
        RealType ar1 = min(max(interp_temporal(p_arho1_old, p_arho1_new),   static_cast<RealType>(0.0)), r_val);
        RealType ar2 = min(max(interp_temporal(p_arho2_old, p_arho2_new),   static_cast<RealType>(0.0)), r_val);

        if (d_alpha1) d_alpha1[child_idx] = a1;
        if (d_alpha2) d_alpha2[child_idx] = a2;
        if (d_arho1)  d_arho1[child_idx]  = ar1;
        if (d_arho2)  d_arho2[child_idx]  = ar2;

        d_E[child_idx] = MultiMat::getMixtureEnergy<RealType>(p_val, r_val, a1, a2, ar1, ar2, (RealType)gamma, d_products, d_unreacted) + ke;
    } else {
        d_E[child_idx] = p_val / gm1 + ke;
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void submesh_rk2_average_kernel_3d(
    int nx, int ny, int nz,
    RealType* d_rho, RealType* d_ux, RealType* d_uy, RealType* d_uz, RealType* d_p, RealType* d_E,
    RealType* d_alpha1, RealType* d_alpha2, RealType* d_arho1, RealType* d_arho2,
    const RealType* d_rk_rho, const RealType* d_rk_ux, const RealType* d_rk_uy, const RealType* d_rk_uz, const RealType* d_rk_p, const RealType* d_rk_E,
    const RealType* d_rk_alpha1, const RealType* d_rk_alpha2, const RealType* d_rk_arho1, const RealType* d_rk_arho2
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    int j = blockIdx.y * blockDim.y + threadIdx.y;
    int k = blockIdx.z * blockDim.z + threadIdx.z;

    if (i >= nx || j >= ny || k >= nz) return;
    size_t c_idx = i + j * nx + k * nx * ny;

    d_rho[c_idx] = static_cast<RealType>(0.5) * d_rk_rho[c_idx] + static_cast<RealType>(0.5) * d_rho[c_idx];
    d_ux[c_idx]  = static_cast<RealType>(0.5) * d_rk_ux[c_idx]  + static_cast<RealType>(0.5) * d_ux[c_idx];
    d_uy[c_idx]  = static_cast<RealType>(0.5) * d_rk_uy[c_idx]  + static_cast<RealType>(0.5) * d_uy[c_idx];
    d_uz[c_idx]  = static_cast<RealType>(0.5) * d_rk_uz[c_idx]  + static_cast<RealType>(0.5) * d_uz[c_idx];
    d_p[c_idx]   = static_cast<RealType>(0.5) * d_rk_p[c_idx]   + static_cast<RealType>(0.5) * d_p[c_idx];
    d_E[c_idx]   = static_cast<RealType>(0.5) * d_rk_E[c_idx]   + static_cast<RealType>(0.5) * d_E[c_idx];

    if constexpr (IsMultiMaterial) {
        if (d_alpha1) d_alpha1[c_idx] = static_cast<RealType>(0.5) * d_rk_alpha1[c_idx] + static_cast<RealType>(0.5) * d_alpha1[c_idx];
        if (d_alpha2) d_alpha2[c_idx] = static_cast<RealType>(0.5) * d_rk_alpha2[c_idx] + static_cast<RealType>(0.5) * d_alpha2[c_idx];
        if (d_arho1)  d_arho1[c_idx]  = static_cast<RealType>(0.5) * d_rk_arho1[c_idx]  + static_cast<RealType>(0.5) * d_arho1[c_idx];
        if (d_arho2)  d_arho2[c_idx]  = static_cast<RealType>(0.5) * d_rk_arho2[c_idx]  + static_cast<RealType>(0.5) * d_arho2[c_idx];
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void submesh_step_kernel_3d(
    int nx, int ny, int nz, RealType h, RealType dt_sub, RealType gamma,
    const RealType* d_rho, const RealType* d_ux, const RealType* d_uy, const RealType* d_uz, const RealType* d_p, const RealType* d_E,
    const RealType* d_alpha1, const RealType* d_alpha2, const RealType* d_arho1, const RealType* d_arho2,
    RealType* d_new_rho, RealType* d_new_ux, RealType* d_new_uy, RealType* d_new_uz, RealType* d_new_p, RealType* d_new_E,
    RealType* d_new_alpha1, RealType* d_new_alpha2, RealType* d_new_arho1, RealType* d_new_arho2,
    RealType* d_peak_overpressure, RealType* d_peak_impulse,
    const uint8_t* d_is_boundary,
    const GeometryTile3D* d_geom, RealType xmin_c, RealType ymin_c, RealType zmin_c,
    RealType xmin_p, RealType ymin_p, RealType zmin_p, RealType h_p,
    int n_ghost, int spatial_order
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    int j = blockIdx.y * blockDim.y + threadIdx.y;
    int k = blockIdx.z * blockDim.z + threadIdx.z;

    if (i >= nx || j >= ny || k >= nz) return;

    size_t c_idx = i + j * nx + k * nx * ny;

    if (i < n_ghost || i >= nx - n_ghost || j < n_ghost || j >= ny - n_ghost || k < n_ghost || k >= nz - n_ghost) {
        d_new_rho[c_idx] = d_rho[c_idx];
        d_new_ux[c_idx]  = d_ux[c_idx];
        d_new_uy[c_idx]  = d_uy[c_idx];
        d_new_uz[c_idx]  = d_uz[c_idx];
        d_new_p[c_idx]   = d_p[c_idx];
        d_new_E[c_idx]   = d_E[c_idx];
        if constexpr (IsMultiMaterial) {
            if (d_new_alpha1) d_new_alpha1[c_idx] = d_alpha1[c_idx];
            if (d_new_alpha2) d_new_alpha2[c_idx] = d_alpha2[c_idx];
            if (d_new_arho1)  d_new_arho1[c_idx]  = d_arho1[c_idx];
            if (d_new_arho2)  d_new_arho2[c_idx]  = d_arho2[c_idx];
        }
        return;
    }
    RealType dt_h = dt_sub / h;
    RealType gm1 = max(static_cast<RealType>(1e-4), gamma - static_cast<RealType>(1.0));

    size_t base_c_idx = c_idx;
    int base_i = i, base_j = j, base_k = k;

    auto get_state_at = [&](int ci, int cj, int ck) -> GPUCellStateT<RealType, IsMultiMaterial> {
        int clamped_ci = min(max(ci, 0), nx - 1);
        int clamped_cj = min(max(cj, 0), ny - 1);
        int clamped_ck = min(max(ck, 0), nz - 1);
        size_t idx = clamped_ci + clamped_cj * nx + clamped_ck * nx * ny;

        GPUCellStateT<RealType, IsMultiMaterial> s;
        s.rho = max(static_cast<RealType>(1e-8), d_rho[idx]);
        s.ux = d_ux[idx];
        s.uy = d_uy[idx];
        s.uz = d_uz[idx];
        s.p = max(static_cast<RealType>(1e-8), d_p[idx]);
        s.E = d_E[idx];
        if constexpr (IsMultiMaterial) {
            s.alpha1 = (d_alpha1) ? d_alpha1[idx] : (RealType)0.0;
            s.alpha2 = (d_alpha2) ? d_alpha2[idx] : (RealType)0.0;
            s.arho1 = (d_arho1) ? d_arho1[idx] : (RealType)0.0;
            s.arho2 = (d_arho2) ? d_arho2[idx] : (RealType)0.0;
        }

        if (d_is_boundary && d_is_boundary[idx]) {
            s.rho = max(static_cast<RealType>(1e-8), d_rho[base_c_idx]);
            s.p = max(static_cast<RealType>(1e-8), d_p[base_c_idx]);
            s.E = d_E[base_c_idx];

            int di = ci - base_i;
            int dj = cj - base_j;
            int dk = ck - base_k;

            RealType xc = xmin_c + (clamped_ci + static_cast<RealType>(0.5)) * h;
            RealType yc = ymin_c + (clamped_cj + static_cast<RealType>(0.5)) * h;
            RealType zc = zmin_c + (clamped_ck + static_cast<RealType>(0.5)) * h;

            int pi = min(max(static_cast<int>(floor((xc - xmin_p) / h_p)), 0), d_nx - 1);
            int pj = min(max(static_cast<int>(floor((yc - ymin_p) / h_p)), 0), d_ny - 1);
            int pk = min(max(static_cast<int>(floor((zc - zmin_p) / h_p)), 0), d_nz - 1);

            float nx_b = 0.0f, ny_b = 0.0f, nz_b = 0.0f;
            get_solid_normal_gpu(d_geom, pi, pj, pk, nx_b, ny_b, nz_b);

            RealType nx_r = nx_b;
            RealType ny_r = ny_b;
            RealType nz_r = nz_b;
            RealType nlen = sqrt(nx_r*nx_r + ny_r*ny_r + nz_r*nz_r);
            if (nlen > static_cast<RealType>(1e-3)) {
                nx_r /= nlen;
                ny_r /= nlen;
                nz_r /= nlen;
            } else {
                nx_r = -di;
                ny_r = -dj;
                nz_r = -dk;
            }

            RealType u_fluid = d_ux[base_c_idx];
            RealType v_fluid = d_uy[base_c_idx];
            RealType w_fluid = d_uz[base_c_idx];
            RealType u_dot_n = u_fluid * nx_r + v_fluid * ny_r + w_fluid * nz_r;

            s.ux = u_fluid - static_cast<RealType>(2.0) * u_dot_n * nx_r;
            s.uy = v_fluid - static_cast<RealType>(2.0) * u_dot_n * ny_r;
            s.uz = w_fluid - static_cast<RealType>(2.0) * u_dot_n * nz_r;
        }
        return s;
    };

    auto reconstruct_interface = [&](int bi, int bj, int bk, int di, int dj, int dk, GPUCellStateT<RealType, IsMultiMaterial>& sL, GPUCellStateT<RealType, IsMultiMaterial>& sR) {
        GPUCellStateT<RealType, IsMultiMaterial> sM2 = get_state_at(bi - 2*di, bj - 2*dj, bk - 2*dk);
        GPUCellStateT<RealType, IsMultiMaterial> sM1 = get_state_at(bi - di, bj - dj, bk - dk);
        GPUCellStateT<RealType, IsMultiMaterial> sP0 = get_state_at(bi, bj, bk);
        GPUCellStateT<RealType, IsMultiMaterial> sP1 = get_state_at(bi + di, bj + dj, bk + dk);

        if (spatial_order == 1) {
            sL = sM1;
            sR = sP0;
        } else if (spatial_order == 3) {
            auto reconstruct_var = [&](RealType vM2, RealType vM1, RealType vP0, RealType vP1, RealType& vL, RealType& vR) {
                vL = weno3_gpu(vM2, vM1, vP0);
                vR = weno3_gpu(vP1, vP0, vM1);
            };

            reconstruct_var(sM2.rho, sM1.rho, sP0.rho, sP1.rho, sL.rho, sR.rho);
            sL.rho = max(static_cast<RealType>(1e-8), sL.rho);
            sR.rho = max(static_cast<RealType>(1e-8), sR.rho);

            reconstruct_var(sM2.ux, sM1.ux, sP0.ux, sP1.ux, sL.ux, sR.ux);
            reconstruct_var(sM2.uy, sM1.uy, sP0.uy, sP1.uy, sL.uy, sR.uy);
            reconstruct_var(sM2.uz, sM1.uz, sP0.uz, sP1.uz, sL.uz, sR.uz);

            reconstruct_var(sM2.p, sM1.p, sP0.p, sP1.p, sL.p, sR.p);
            sL.p = max(static_cast<RealType>(1e-8), sL.p);
            sR.p = max(static_cast<RealType>(1e-8), sR.p);

            RealType keL = static_cast<RealType>(0.5) * sL.rho * (sL.ux*sL.ux + sL.uy*sL.uy + sL.uz*sL.uz);
            RealType keR = static_cast<RealType>(0.5) * sR.rho * (sR.ux*sR.ux + sR.uy*sR.uy + sR.uz*sR.uz);
            sL.E = sL.p / gm1 + keL;
            sR.E = sR.p / gm1 + keR;

            if constexpr (IsMultiMaterial) {
                reconstruct_var(sM2.alpha1, sM1.alpha1, sP0.alpha1, sP1.alpha1, sL.alpha1, sR.alpha1);
                reconstruct_var(sM2.alpha2, sM1.alpha2, sP0.alpha2, sP1.alpha2, sL.alpha2, sR.alpha2);
                reconstruct_var(sM2.arho1, sM1.arho1, sP0.arho1, sP1.arho1, sL.arho1, sR.arho1);
                reconstruct_var(sM2.arho2, sM1.arho2, sP0.arho2, sP1.arho2, sL.arho2, sR.arho2);

                sL.alpha1 = min(max(sL.alpha1, static_cast<RealType>(0.0)), static_cast<RealType>(1.0));
                sL.alpha2 = min(max(sL.alpha2, static_cast<RealType>(0.0)), static_cast<RealType>(1.0));
                sR.alpha1 = min(max(sR.alpha1, static_cast<RealType>(0.0)), static_cast<RealType>(1.0));
                sR.alpha2 = min(max(sR.alpha2, static_cast<RealType>(0.0)), static_cast<RealType>(1.0));

                sL.E = MultiMat::getMixtureEnergy<RealType>(sL.p, sL.rho, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, (RealType)gamma, d_products, d_unreacted) + keL;
                sR.E = MultiMat::getMixtureEnergy<RealType>(sR.p, sR.rho, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, (RealType)gamma, d_products, d_unreacted) + keR;
            }
        } else {
            auto reconstruct_var = [&](RealType vM2, RealType vM1, RealType vP0, RealType vP1, RealType& vL, RealType& vR) {
                RealType dL = vM1 - vM2;
                RealType dC = vP0 - vM1;
                RealType dR = vP1 - vP0;
                vL = vM1 + static_cast<RealType>(0.5) * minmod_gpu(dL, dC);
                vR = vP0 - static_cast<RealType>(0.5) * minmod_gpu(dC, dR);
            };

            reconstruct_var(sM2.rho, sM1.rho, sP0.rho, sP1.rho, sL.rho, sR.rho);
            sL.rho = max(static_cast<RealType>(1e-8), sL.rho);
            sR.rho = max(static_cast<RealType>(1e-8), sR.rho);

            reconstruct_var(sM2.ux, sM1.ux, sP0.ux, sP1.ux, sL.ux, sR.ux);
            reconstruct_var(sM2.uy, sM1.uy, sP0.uy, sP1.uy, sL.uy, sR.uy);
            reconstruct_var(sM2.uz, sM1.uz, sP0.uz, sP1.uz, sL.uz, sR.uz);

            reconstruct_var(sM2.p, sM1.p, sP0.p, sP1.p, sL.p, sR.p);
            sL.p = max(static_cast<RealType>(1e-8), sL.p);
            sR.p = max(static_cast<RealType>(1e-8), sR.p);

            RealType keL = static_cast<RealType>(0.5) * sL.rho * (sL.ux*sL.ux + sL.uy*sL.uy + sL.uz*sL.uz);
            RealType keR = static_cast<RealType>(0.5) * sR.rho * (sR.ux*sR.ux + sR.uy*sR.uy + sR.uz*sR.uz);
            sL.E = sL.p / gm1 + keL;
            sR.E = sR.p / gm1 + keR;

            if constexpr (IsMultiMaterial) {
                reconstruct_var(sM2.alpha1, sM1.alpha1, sP0.alpha1, sP1.alpha1, sL.alpha1, sR.alpha1);
                reconstruct_var(sM2.alpha2, sM1.alpha2, sP0.alpha2, sP1.alpha2, sL.alpha2, sR.alpha2);
                reconstruct_var(sM2.arho1, sM1.arho1, sP0.arho1, sP1.arho1, sL.arho1, sR.arho1);
                reconstruct_var(sM2.arho2, sM1.arho2, sP0.arho2, sP1.arho2, sL.arho2, sR.arho2);

                sL.alpha1 = min(max(sL.alpha1, static_cast<RealType>(0.0)), static_cast<RealType>(1.0));
                sL.alpha2 = min(max(sL.alpha2, static_cast<RealType>(0.0)), static_cast<RealType>(1.0));
                sR.alpha1 = min(max(sR.alpha1, static_cast<RealType>(0.0)), static_cast<RealType>(1.0));
                sR.alpha2 = min(max(sR.alpha2, static_cast<RealType>(0.0)), static_cast<RealType>(1.0));

                sL.E = MultiMat::getMixtureEnergy<RealType>(sL.p, sL.rho, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, (RealType)gamma, d_products, d_unreacted) + keL;
                sR.E = MultiMat::getMixtureEnergy<RealType>(sR.p, sR.rho, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, (RealType)gamma, d_products, d_unreacted) + keR;
            }
        }
    };

    GPUCellStateT<RealType, IsMultiMaterial> sLx_L, sLx_R, sRx_L, sRx_R;
    GPUCellStateT<RealType, IsMultiMaterial> sLy_L, sLy_R, sRy_L, sRy_R;
    GPUCellStateT<RealType, IsMultiMaterial> sLz_L, sLz_R, sRz_L, sRz_R;

    reconstruct_interface(i, j, k, 1, 0, 0, sLx_L, sLx_R);
    reconstruct_interface(i + 1, j, k, 1, 0, 0, sRx_L, sRx_R);

    reconstruct_interface(i, j, k, 0, 1, 0, sLy_L, sLy_R);
    reconstruct_interface(i, j + 1, k, 0, 1, 0, sRy_L, sRy_R);

    reconstruct_interface(i, j, k, 0, 0, 1, sLz_L, sLz_R);
    reconstruct_interface(i, j, k + 1, 0, 0, 1, sRz_L, sRz_R);

    RealType fX_L[10], fX_R[10];
    RealType fY_L[10], fY_R[10];
    RealType fZ_L[10], fZ_R[10];

    if (d_useAUSM) {
        getAUSMPlusFluxGPU<RealType, IsMultiMaterial>(sLx_L, sLx_R, fX_L, 0, gamma);
        getAUSMPlusFluxGPU<RealType, IsMultiMaterial>(sRx_L, sRx_R, fX_R, 0, gamma);

        getAUSMPlusFluxGPU<RealType, IsMultiMaterial>(sLy_L, sLy_R, fY_L, 1, gamma);
        getAUSMPlusFluxGPU<RealType, IsMultiMaterial>(sRy_L, sRy_R, fY_R, 1, gamma);

        getAUSMPlusFluxGPU<RealType, IsMultiMaterial>(sLz_L, sLz_R, fZ_L, 2, gamma);
        getAUSMPlusFluxGPU<RealType, IsMultiMaterial>(sRz_L, sRz_R, fZ_R, 2, gamma);
    } else {
        getRusanovFluxGPU<RealType, IsMultiMaterial>(sLx_L, sLx_R, fX_L, 0, gamma);
        getRusanovFluxGPU<RealType, IsMultiMaterial>(sRx_L, sRx_R, fX_R, 0, gamma);

        getRusanovFluxGPU<RealType, IsMultiMaterial>(sLy_L, sLy_R, fY_L, 1, gamma);
        getRusanovFluxGPU<RealType, IsMultiMaterial>(sRy_L, sRy_R, fY_R, 1, gamma);

        getRusanovFluxGPU<RealType, IsMultiMaterial>(sLz_L, sLz_R, fZ_L, 2, gamma);
        getRusanovFluxGPU<RealType, IsMultiMaterial>(sRz_L, sRz_R, fZ_R, 2, gamma);
    }

    GPUCellStateT<RealType, IsMultiMaterial> sC = get_state_at(i, j, k);

    RealType rho_n   = sC.rho - dt_h * (fX_R[0] - fX_L[0] + fY_R[0] - fY_L[0] + fZ_R[0] - fZ_L[0]);
    RealType rhoux_n = sC.rho*sC.ux - dt_h * (fX_R[1] - fX_L[1] + fY_R[1] - fY_L[1] + fZ_R[1] - fZ_L[1]);
    RealType rhouy_n = sC.rho*sC.uy - dt_h * (fX_R[2] - fX_L[2] + fY_R[2] - fY_L[2] + fZ_R[2] - fZ_L[2]);
    RealType rhouz_n = sC.rho*sC.uz - dt_h * (fX_R[3] - fX_L[3] + fY_R[3] - fY_L[3] + fZ_R[3] - fZ_L[3]);
    RealType E_n     = sC.E - dt_h * (fX_R[4] - fX_L[4] + fY_R[4] - fY_L[4] + fZ_R[4] - fZ_L[4]);

    if (d_is_boundary && d_is_boundary[c_idx]) {
        d_new_rho[c_idx] = static_cast<RealType>(1.225);
        d_new_ux[c_idx] = static_cast<RealType>(0.0);
        d_new_uy[c_idx] = static_cast<RealType>(0.0);
        d_new_uz[c_idx] = static_cast<RealType>(0.0);
        d_new_p[c_idx] = static_cast<RealType>(101325.0);
        d_new_E[c_idx] = static_cast<RealType>(101325.0) / gm1;
        if constexpr (IsMultiMaterial) {
            if (d_new_alpha1) {
                d_new_alpha1[c_idx] = static_cast<RealType>(0.0);
                d_new_alpha2[c_idx] = static_cast<RealType>(1.0);
                d_new_arho1[c_idx] = static_cast<RealType>(0.0);
                d_new_arho2[c_idx] = static_cast<RealType>(1.225);
            }
        }
    } else {
        RealType rho_clamped = max(static_cast<RealType>(1e-8), rho_n);
        d_new_rho[c_idx] = rho_clamped;
        d_new_ux[c_idx] = rhoux_n / rho_clamped;
        d_new_uy[c_idx] = rhouy_n / rho_clamped;
        d_new_uz[c_idx] = rhouz_n / rho_clamped;

        RealType ke_n = static_cast<RealType>(0.5) * rho_clamped * (d_new_ux[c_idx]*d_new_ux[c_idx] + d_new_uy[c_idx]*d_new_uy[c_idx] + d_new_uz[c_idx]*d_new_uz[c_idx]);
        RealType e_int = E_n - ke_n;

        const RealType MAX_SPECIFIC_EINT = static_cast<RealType>(1e10);
        if (e_int / rho_clamped > MAX_SPECIFIC_EINT) {
            e_int = rho_clamped * MAX_SPECIFIC_EINT;
            E_n = e_int + ke_n;
        } else if (e_int < static_cast<RealType>(0.0)) {
            e_int = static_cast<RealType>(0.0);
            E_n = ke_n;
        }

        if constexpr (IsMultiMaterial) {
            if (d_alpha1 && d_new_alpha1) {
                RealType div_u = (fX_R[9] - fX_L[9]) + (fY_R[9] - fY_L[9]) + (fZ_R[9] - fZ_L[9]);
                RealType a1_n = sC.alpha1 - dt_h * (fX_R[5] - fX_L[5] + fY_R[5] - fY_L[5] + fZ_R[5] - fZ_L[5]) + dt_h * sC.alpha1 * div_u;
                RealType a2_n = sC.alpha2 - dt_h * (fX_R[6] - fX_L[6] + fY_R[6] - fY_L[6] + fZ_R[6] - fZ_L[6]) + dt_h * sC.alpha2 * div_u;
                d_new_alpha1[c_idx] = min(max(a1_n, static_cast<RealType>(0.0)), static_cast<RealType>(1.0));
                d_new_alpha2[c_idx] = min(max(a2_n, static_cast<RealType>(0.0)), static_cast<RealType>(1.0));

                RealType sum_a = d_new_alpha1[c_idx] + d_new_alpha2[c_idx];
                if (sum_a > static_cast<RealType>(1.0)) {
                    d_new_alpha1[c_idx] /= sum_a;
                    d_new_alpha2[c_idx] /= sum_a;
                }

                d_new_arho1[c_idx] = d_new_alpha1[c_idx] * rho_clamped;
                d_new_arho2[c_idx] = d_new_alpha2[c_idx] * rho_clamped;

                RealType p_n = MultiMat::getMixturePressure<RealType>(e_int, rho_clamped, d_new_alpha1[c_idx], d_new_alpha2[c_idx], d_new_arho1[c_idx], d_new_arho2[c_idx], (RealType)gamma, d_products, d_unreacted);
                if (isnan(p_n) || isinf(p_n)) {
                    p_n = static_cast<RealType>(101325.0);
                    d_new_rho[c_idx] = static_cast<RealType>(1.225);
                    d_new_ux[c_idx] = static_cast<RealType>(0.0);
                    d_new_uy[c_idx] = static_cast<RealType>(0.0);
                    d_new_uz[c_idx] = static_cast<RealType>(0.0);
                    ke_n = static_cast<RealType>(0.0);
                    d_new_alpha1[c_idx] = static_cast<RealType>(0.0);
                    d_new_alpha2[c_idx] = static_cast<RealType>(1.0);
                    d_new_arho1[c_idx] = static_cast<RealType>(0.0);
                    d_new_arho2[c_idx] = static_cast<RealType>(1.225);
                    e_int = p_n / gm1;
                } else {
                    p_n = fmax(p_n, static_cast<RealType>(1e-8));
                }
                d_new_p[c_idx] = p_n;
                d_new_E[c_idx] = fmax(static_cast<RealType>(1e-8), e_int) + ke_n;
            }
        } else {
            RealType p_n = e_int * gm1;
            if (isnan(p_n) || isinf(p_n)) {
                p_n = static_cast<RealType>(101325.0);
                d_new_rho[c_idx] = static_cast<RealType>(1.225);
                d_new_ux[c_idx] = static_cast<RealType>(0.0);
                d_new_uy[c_idx] = static_cast<RealType>(0.0);
                d_new_uz[c_idx] = static_cast<RealType>(0.0);
                ke_n = static_cast<RealType>(0.0);
                e_int = p_n / gm1;
            } else {
                p_n = fmax(p_n, static_cast<RealType>(1e-8));
                e_int = p_n / gm1;
            }
            d_new_p[c_idx] = p_n;
            d_new_E[c_idx] = e_int + ke_n;
        }
    }

    if (d_peak_overpressure) {
        RealType op = d_new_p[c_idx] - static_cast<RealType>(101325.0);
        if (op < (RealType)0.0) op = (RealType)0.0;
        if (op > d_peak_overpressure[c_idx]) {
            d_peak_overpressure[c_idx] = op;
        }
        if (d_peak_impulse) {
            d_peak_impulse[c_idx] += op * dt_sub;
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void restrict_to_parent_kernel_3d(
    PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    ConservativeTile3D<RealType, IsMultiMaterial>* d_U,
    int ntx, int nty, int ntz,
    int nx_c, int ny_c, int nz_c,
    RealType xmin_c, RealType ymin_c, RealType zmin_c, RealType h_c,
    RealType xmin_p, RealType ymin_p, RealType zmin_p, RealType h_p,
    int nx_p, int ny_p, int nz_p,
    const RealType* d_rho, const RealType* d_ux, const RealType* d_uy, const RealType* d_uz, const RealType* d_p, const RealType* d_E,
    const RealType* d_alpha1, const RealType* d_alpha2, const RealType* d_arho1, const RealType* d_arho2,
    const RealType* d_peak_overpressure, const RealType* d_peak_impulse,
    const uint8_t* d_is_boundary,
    const GeometryTile3D* d_geom,
    int n_ghost
) {
    int k_idx = blockIdx.z * blockDim.z + threadIdx.z;
    int j_idx = blockIdx.y * blockDim.y + threadIdx.y;
    int i_idx = blockIdx.x * blockDim.x + threadIdx.x;

    int ck = k_idx * 2;
    int cj = j_idx * 2;
    int ci = i_idx * 2;

    if (ck >= nz_c || cj >= ny_c || ci >= nx_c) return;

    if (ci < n_ghost || ci + 1 >= nx_c - n_ghost ||
        cj < n_ghost || cj + 1 >= ny_c - n_ghost ||
        ck < n_ghost || ck + 1 >= nz_c - n_ghost) {
        return;
    }

    RealType z_child = zmin_c + (ck + static_cast<RealType>(0.5)) * h_c;
    RealType y_child = ymin_c + (cj + static_cast<RealType>(0.5)) * h_c;
    RealType x_child = xmin_c + (ci + static_cast<RealType>(0.5)) * h_c;

    int pk = min(max((int)floor((z_child - zmin_p) / h_p), 0), nz_p - 1);
    int pj = min(max((int)floor((y_child - ymin_p) / h_p), 0), ny_p - 1);
    int pi = min(max((int)floor((x_child - xmin_p) / h_p), 0), nx_p - 1);

    if (d_geom) {
        float dummy1, dummy2, dummy3;
        if (get_solid_normal_gpu(d_geom, pi, pj, pk, dummy1, dummy2, dummy3)) return;
    }

    RealType sum_rho = 0, sum_rhoux = 0, sum_rhouy = 0, sum_rhouz = 0, sum_p = 0, sum_E = 0;
    RealType sum_alpha1 = 0, sum_alpha2 = 0, sum_arho1 = 0, sum_arho2 = 0;
    RealType max_peak_op = static_cast<RealType>(0.0);
    RealType max_peak_imp = static_cast<RealType>(0.0);
    int valid_cells = 0;

    for (int dk = 0; dk < 2 && (ck + dk) < nz_c; ++dk) {
        for (int dj = 0; dj < 2 && (cj + dj) < ny_c; ++dj) {
            for (int di = 0; di < 2 && (ci + di) < nx_c; ++di) {
                size_t c_idx = (ci + di) + (cj + dj) * nx_c + (ck + dk) * nx_c * ny_c;
                if (d_is_boundary && d_is_boundary[c_idx]) continue;

                RealType r = d_rho[c_idx];
                sum_rho += r;
                sum_rhoux += r * d_ux[c_idx];
                sum_rhouy += r * d_uy[c_idx];
                sum_rhouz += r * d_uz[c_idx];
                sum_p += d_p[c_idx];
                sum_E += d_E[c_idx];
                valid_cells++;

                if (d_peak_overpressure) {
                    RealType op = d_peak_overpressure[c_idx];
                    if (op > max_peak_op) max_peak_op = op;
                }
                if (d_peak_impulse) {
                    RealType imp = d_peak_impulse[c_idx];
                    if (imp > max_peak_imp) max_peak_imp = imp;
                }

                if constexpr (IsMultiMaterial) {
                    if (d_alpha1) {
                        sum_alpha1 += d_alpha1[c_idx];
                        sum_alpha2 += d_alpha2[c_idx];
                        sum_arho1 += d_arho1[c_idx];
                        sum_arho2 += d_arho2[c_idx];
                    }
                }
            }
        }
    }

    if (valid_cells > 0) {
        int tx_p = pi / 8;
        int ty_p = pj / 8;
        int tz_p = pk / 8;
        int t_idx_p = tx_p + ty_p * ntx + tz_p * ntx * nty;
        int cell_idx_p = (pi % 8) + (pj % 8) * 8 + (pk % 8) * 64;

        RealType inv_vc = static_cast<RealType>(1.0) / static_cast<RealType>(valid_cells);
        RealType avg_rho = max(static_cast<RealType>(1e-8), sum_rho * inv_vc);
        RealType avg_rhoux = sum_rhoux * inv_vc;
        RealType avg_rhouy = sum_rhouy * inv_vc;
        RealType avg_rhouz = sum_rhouz * inv_vc;
        RealType avg_p = max(static_cast<RealType>(1e-8), sum_p * inv_vc);
        RealType avg_E = sum_E * inv_vc;

        d_states[t_idx_p].rho[cell_idx_p] = avg_rho;
        d_states[t_idx_p].ux[cell_idx_p] = avg_rhoux / avg_rho;
        d_states[t_idx_p].uy[cell_idx_p] = avg_rhouy / avg_rho;
        d_states[t_idx_p].uz[cell_idx_p] = avg_rhouz / avg_rho;
        d_states[t_idx_p].p[cell_idx_p] = avg_p;

        if (d_U) {
            d_U[t_idx_p].rho[cell_idx_p] = avg_rho;
            d_U[t_idx_p].rhoux[cell_idx_p] = avg_rhoux;
            d_U[t_idx_p].rhouy[cell_idx_p] = avg_rhouy;
            d_U[t_idx_p].rhouz[cell_idx_p] = avg_rhouz;
            d_U[t_idx_p].E[cell_idx_p] = avg_E;
        }

        if (d_peak_overpressure && max_peak_op > d_states[t_idx_p].peak_overpressure[cell_idx_p]) {
            d_states[t_idx_p].peak_overpressure[cell_idx_p] = max_peak_op;
        }
        if (d_peak_impulse && max_peak_imp > d_states[t_idx_p].peak_impulse[cell_idx_p]) {
            d_states[t_idx_p].peak_impulse[cell_idx_p] = max_peak_imp;
        }

        if constexpr (IsMultiMaterial) {
            if (d_alpha1) {
                RealType a1 = sum_alpha1 * inv_vc;
                RealType a2 = sum_alpha2 * inv_vc;
                RealType ar1 = sum_arho1 * inv_vc;
                RealType ar2 = sum_arho2 * inv_vc;

                d_states[t_idx_p].alpha1[cell_idx_p] = a1;
                d_states[t_idx_p].alpha2[cell_idx_p] = a2;
                d_states[t_idx_p].arho1[cell_idx_p] = ar1;
                d_states[t_idx_p].arho2[cell_idx_p] = ar2;

                if (d_U) {
                    d_U[t_idx_p].alpha1[cell_idx_p] = a1;
                    d_U[t_idx_p].alpha2[cell_idx_p] = a2;
                    d_U[t_idx_p].arho1[cell_idx_p] = ar1;
                    d_U[t_idx_p].arho2[cell_idx_p] = ar2;
                }
            }
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void restrict_to_parent_submesh_kernel_3d(
    RealType* p_rho, RealType* p_ux, RealType* p_uy, RealType* p_uz, RealType* p_p, RealType* p_E,
    RealType* p_alpha1, RealType* p_alpha2, RealType* p_arho1, RealType* p_arho2,
    RealType* p_peak_overpressure, RealType* p_peak_impulse,
    int nx_p, int ny_p, int nz_p,
    RealType xmin_p, RealType ymin_p, RealType zmin_p, RealType h_p,
    int nx_c, int ny_c, int nz_c,
    RealType xmin_c, RealType ymin_c, RealType zmin_c, RealType h_c,
    const RealType* d_rho, const RealType* d_ux, const RealType* d_uy, const RealType* d_uz, const RealType* d_p, const RealType* d_E,
    const RealType* d_alpha1, const RealType* d_alpha2, const RealType* d_arho1, const RealType* d_arho2,
    const RealType* d_peak_overpressure, const RealType* d_peak_impulse,
    const uint8_t* d_is_boundary,
    const GeometryTile3D* d_geom,
    int n_ghost
) {
    int k_idx = blockIdx.z * blockDim.z + threadIdx.z;
    int j_idx = blockIdx.y * blockDim.y + threadIdx.y;
    int i_idx = blockIdx.x * blockDim.x + threadIdx.x;

    int ck = k_idx * 2;
    int cj = j_idx * 2;
    int ci = i_idx * 2;

    if (ck >= nz_c || cj >= ny_c || ci >= nx_c) return;

    if (ci < n_ghost || ci + 1 >= nx_c - n_ghost ||
        cj < n_ghost || cj + 1 >= ny_c - n_ghost ||
        ck < n_ghost || ck + 1 >= nz_c - n_ghost) {
        return;
    }

    RealType z_child = zmin_c + (ck + static_cast<RealType>(0.5)) * h_c;
    RealType y_child = ymin_c + (cj + static_cast<RealType>(0.5)) * h_c;
    RealType x_child = xmin_c + (ci + static_cast<RealType>(0.5)) * h_c;

    int pk = min(max((int)floor((z_child - zmin_p) / h_p), 0), nz_p - 1);
    int pj = min(max((int)floor((y_child - ymin_p) / h_p), 0), ny_p - 1);
    int pi = min(max((int)floor((x_child - xmin_p) / h_p), 0), nx_p - 1);

    RealType sum_rho = 0, sum_rhoux = 0, sum_rhouy = 0, sum_rhouz = 0, sum_p = 0, sum_E = 0;
    RealType sum_alpha1 = 0, sum_alpha2 = 0, sum_arho1 = 0, sum_arho2 = 0;
    RealType max_peak_op = static_cast<RealType>(0.0);
    RealType max_peak_imp = static_cast<RealType>(0.0);
    int valid_cells = 0;

    for (int dk = 0; dk < 2 && (ck + dk) < nz_c; ++dk) {
        for (int dj = 0; dj < 2 && (cj + dj) < ny_c; ++dj) {
            for (int di = 0; di < 2 && (ci + di) < nx_c; ++di) {
                size_t c_idx = (ci + di) + (cj + dj) * nx_c + (ck + dk) * nx_c * ny_c;
                if (d_is_boundary && d_is_boundary[c_idx]) continue;

                RealType r = d_rho[c_idx];
                sum_rho += r;
                sum_rhoux += r * d_ux[c_idx];
                sum_rhouy += r * d_uy[c_idx];
                sum_rhouz += r * d_uz[c_idx];
                sum_p += d_p[c_idx];
                sum_E += d_E[c_idx];
                valid_cells++;

                if (d_peak_overpressure) {
                    RealType op = d_peak_overpressure[c_idx];
                    if (op > max_peak_op) max_peak_op = op;
                }
                if (d_peak_impulse) {
                    RealType imp = d_peak_impulse[c_idx];
                    if (imp > max_peak_imp) max_peak_imp = imp;
                }

                if constexpr (IsMultiMaterial) {
                    if (d_alpha1) {
                        sum_alpha1 += d_alpha1[c_idx];
                        sum_alpha2 += d_alpha2[c_idx];
                        sum_arho1 += d_arho1[c_idx];
                        sum_arho2 += d_arho2[c_idx];
                    }
                }
            }
        }
    }

    if (valid_cells > 0) {
        size_t p_idx = pi + pj * nx_p + pk * nx_p * ny_p;

        RealType inv_vc = static_cast<RealType>(1.0) / static_cast<RealType>(valid_cells);
        RealType avg_rho = max(static_cast<RealType>(1e-8), sum_rho * inv_vc);

        p_rho[p_idx] = avg_rho;
        p_ux[p_idx]  = (sum_rhoux * inv_vc) / avg_rho;
        p_uy[p_idx]  = (sum_rhouy * inv_vc) / avg_rho;
        p_uz[p_idx]  = (sum_rhouz * inv_vc) / avg_rho;
        p_p[p_idx]   = max(static_cast<RealType>(1e-8), sum_p * inv_vc);
        if (p_E) {
            p_E[p_idx] = sum_E * inv_vc;
        }

        if (p_peak_overpressure && max_peak_op > p_peak_overpressure[p_idx]) {
            p_peak_overpressure[p_idx] = max_peak_op;
        }
        if (p_peak_impulse && max_peak_imp > p_peak_impulse[p_idx]) {
            p_peak_impulse[p_idx] = max_peak_imp;
        }

        if constexpr (IsMultiMaterial) {
            if (p_alpha1) {
                p_alpha1[p_idx] = sum_alpha1 * inv_vc;
                p_alpha2[p_idx] = sum_alpha2 * inv_vc;
                p_arho1[p_idx]  = sum_arho1 * inv_vc;
                p_arho2[p_idx]  = sum_arho2 * inv_vc;
            }
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::step(double dt) {
    ensure_paged_in();
    bind_constants();
    if (h_num_active_tiles == 0) {
        currentTime += dt;
        return;
    }

    RealType dt_r = (RealType)dt;
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    if (grid_manager && grid_manager->getSubMeshCount() > 0 && d_states_old) {
        CHECK_CUDA(cudaMemcpy(d_states_old, d_states, total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyDeviceToDevice));
    }

    int n_active = h_num_active_tiles;
    dim3 threads(TILE_SIZE_3D, TILE_SIZE_3D, TILE_SIZE_3D);

    if (temporalOrder == 1) {
        compute_flux_fused_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const int*)d_active_tile_indices, (const uint8_t*)d_tile_is_near_boundary, (const GeometryTile3D*)d_geom, dt_r);
    } else if (temporalOrder == 2) {
        // RK2 (Copy-free restructuring)
        // Stage 1: compute flux using d_U as source, writing update U_1 to d_dU
        compute_flux_fused_3d<RealType, IsMultiMaterial><<<n_active, threads>>>(
            (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_dU,
            (const int*)d_active_tile_indices,
            (const uint8_t*)d_tile_is_near_boundary,
            (const GeometryTile3D*)d_geom,
            dt_r,
            1, // rk_stage = 1 (Stage 1)
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U // U_prev (source U_0)
        );
        
        // Update intermediate primitive states from intermediate conservative states d_dU
        update_primitive_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>(
            (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_dU,
            (const int*)d_active_tile_indices,
            (const GeometryTile3D*)d_geom
        );
 
        // Stage 2: compute flux using d_dU (U_1) as source, averaging and writing U_next to d_U
        compute_flux_fused_3d<RealType, IsMultiMaterial><<<n_active, threads>>>(
            (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_dU,
            (const int*)d_active_tile_indices,
            (const uint8_t*)d_tile_is_near_boundary,
            (const GeometryTile3D*)d_geom,
            dt_r,
            2, // rk_stage = 2 (Stage 2)
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U // U_prev (source U_0 and destination U_next)
        );
    } else { // Williamson Low-Storage RK3
        const RealType A[3] = { (RealType)0.0, (RealType)(-5.0/9.0), (RealType)(-153.0/128.0) };
        const RealType B[3] = { (RealType)(1.0/3.0), (RealType)(15.0/16.0), (RealType)(8.0/15.0) };

        // No cudaMemset is needed because williamson_stage_A_kernel_3d with A[0] = 0 already resets active tiles.

        for (int st = 0; st < 3; ++st) {
            williamson_stage_A_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((ConservativeTile3D<RealType, IsMultiMaterial>*)d_dU, (const int*)d_active_tile_indices, A[st]);

            compute_flux_fused_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_dU, (const int*)d_active_tile_indices, (const uint8_t*)d_tile_is_near_boundary, (const GeometryTile3D*)d_geom, dt_r);

            williamson_stage_B_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const ConservativeTile3D<RealType, IsMultiMaterial>*)d_dU, (const int*)d_active_tile_indices, B[st]);

            update_primitive_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const int*)d_active_tile_indices, (const GeometryTile3D*)d_geom);
        }
    }

    if constexpr (IsMultiMaterial) {
        applyProgrammedBurn_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const int*)d_active_tile_indices, (RealType)currentTime, dt_r);
    }

    update_primitive_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (const int*)d_active_tile_indices, (const GeometryTile3D*)d_geom);
    update_peak_quantities_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (const int*)d_active_tile_indices, (RealType)ambient_p, dt_r);
    
    CHECK_CUDA(cudaDeviceSynchronize());

    if (grid_manager && grid_manager->getSubMeshCount() > 0) {
        if (gpu_submeshes.empty()) {
            allocateGPUSubMeshes();
            syncSubMeshesToGPU();
        }

        int b1 = (int)bcXmin, b2 = (int)bcXmax, b3 = (int)bcYmin, b4 = (int)bcYmax, b5 = (int)bcZmin, b6 = (int)bcZmax;
        int n_ghost = (spatialOrder >= 2) ? 2 : 1;

        int max_level = 0;
        for (const auto& sm : gpu_submeshes) {
            if (sm.level > max_level) max_level = sm.level;
        }

        std::function<void(int, double, double, double)> stepLevelRecursive =
            [&](int level, double dt_level, double tau_start, double tau_step) {

            if (level > max_level) return;

            RealType dt_sub = (RealType)(dt_level * 0.5);

            for (int substep = 0; substep < 2; ++substep) {
                double tau = tau_start + (substep + 0.5) * tau_step * 0.5;

                for (size_t sm_idx = 0; sm_idx < gpu_submeshes.size(); ++sm_idx) {
                    auto& gpu_sm = gpu_submeshes[sm_idx];
                    if (gpu_sm.level != level) continue;

                    size_t cells_sm = (size_t)gpu_sm.nx * gpu_sm.ny * gpu_sm.nz;
                    size_t bytes_sm = cells_sm * sizeof(RealType);
                    CHECK_CUDA(cudaMemcpy(gpu_sm.d_rho_old, gpu_sm.d_rho, bytes_sm, cudaMemcpyDeviceToDevice));
                    CHECK_CUDA(cudaMemcpy(gpu_sm.d_ux_old, gpu_sm.d_ux, bytes_sm, cudaMemcpyDeviceToDevice));
                    CHECK_CUDA(cudaMemcpy(gpu_sm.d_uy_old, gpu_sm.d_uy, bytes_sm, cudaMemcpyDeviceToDevice));
                    CHECK_CUDA(cudaMemcpy(gpu_sm.d_uz_old, gpu_sm.d_uz, bytes_sm, cudaMemcpyDeviceToDevice));
                    CHECK_CUDA(cudaMemcpy(gpu_sm.d_p_old, gpu_sm.d_p, bytes_sm, cudaMemcpyDeviceToDevice));
                    CHECK_CUDA(cudaMemcpy(gpu_sm.d_E_old, gpu_sm.d_E, bytes_sm, cudaMemcpyDeviceToDevice));
                    if constexpr (IsMultiMaterial) {
                        CHECK_CUDA(cudaMemcpy(gpu_sm.d_alpha1_old, gpu_sm.d_alpha1, bytes_sm, cudaMemcpyDeviceToDevice));
                        CHECK_CUDA(cudaMemcpy(gpu_sm.d_alpha2_old, gpu_sm.d_alpha2, bytes_sm, cudaMemcpyDeviceToDevice));
                        CHECK_CUDA(cudaMemcpy(gpu_sm.d_arho1_old, gpu_sm.d_arho1, bytes_sm, cudaMemcpyDeviceToDevice));
                        CHECK_CUDA(cudaMemcpy(gpu_sm.d_arho2_old, gpu_sm.d_arho2, bytes_sm, cudaMemcpyDeviceToDevice));
                    }

                    // Stage 1 (Euler step, or first stage of RK2)
                    dim3 p_threads(8, 8, 4);
                    dim3 p_blocks((gpu_sm.nx + 7) / 8, (gpu_sm.ny + 7) / 8, (gpu_sm.nz + 3) / 4);
                    dim3 s_threads(8, 8, 4);
                    dim3 s_blocks((gpu_sm.nx + 7) / 8, (gpu_sm.ny + 7) / 8, (gpu_sm.nz + 3) / 4);

                    auto prolongate_ghosts = [&](RealType current_tau) {
                        if (gpu_sm.parent_idx < 0) {
                            prolongate_ghosts_kernel_3d<RealType, IsMultiMaterial><<<p_blocks, p_threads>>>(
                                (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states_old,
                                (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
                                current_tau,
                                ntx, nty, ntz, (RealType)gamma,
                                gpu_sm.nx, gpu_sm.ny, gpu_sm.nz,
                                gpu_sm.xmin, gpu_sm.ymin, gpu_sm.zmin, gpu_sm.cellSize,
                                (RealType)xmin, (RealType)ymin, (RealType)zmin, (RealType)cellSize,
                                nx, ny, nz,
                                gpu_sm.d_rho, gpu_sm.d_ux, gpu_sm.d_uy, gpu_sm.d_uz, gpu_sm.d_p, gpu_sm.d_E,
                                gpu_sm.d_alpha1, gpu_sm.d_alpha2, gpu_sm.d_arho1, gpu_sm.d_arho2,
                                (const GeometryTile3D*)d_geom, b1, b2, b3, b4, b5, b6,
                                n_ghost
                            );
                        } else {
                            const auto& parent_sm = gpu_submeshes[gpu_sm.parent_idx];
                            RealType theta = (RealType)((substep + 0.5) * 0.5);
                            prolongate_ghosts_submesh_kernel_3d<RealType, IsMultiMaterial><<<p_blocks, p_threads>>>(
                                parent_sm.d_rho_old, parent_sm.d_ux_old, parent_sm.d_uy_old, parent_sm.d_uz_old, parent_sm.d_p_old, parent_sm.d_E_old,
                                parent_sm.d_alpha1_old, parent_sm.d_alpha2_old, parent_sm.d_arho1_old, parent_sm.d_arho2_old,
                                parent_sm.d_rho, parent_sm.d_ux, parent_sm.d_uy, parent_sm.d_uz, parent_sm.d_p, parent_sm.d_E,
                                parent_sm.d_alpha1, parent_sm.d_alpha2, parent_sm.d_arho1, parent_sm.d_arho2,
                                theta,
                                parent_sm.nx, parent_sm.ny, parent_sm.nz,
                                parent_sm.xmin, parent_sm.ymin, parent_sm.zmin, parent_sm.cellSize,
                                (RealType)gamma,
                                gpu_sm.nx, gpu_sm.ny, gpu_sm.nz,
                                gpu_sm.xmin, gpu_sm.ymin, gpu_sm.zmin, gpu_sm.cellSize,
                                (RealType)xmin, (RealType)ymin, (RealType)zmin, (RealType)cellSize,
                                nx, ny, nz,
                                gpu_sm.d_rho, gpu_sm.d_ux, gpu_sm.d_uy, gpu_sm.d_uz, gpu_sm.d_p, gpu_sm.d_E,
                                gpu_sm.d_alpha1, gpu_sm.d_alpha2, gpu_sm.d_arho1, gpu_sm.d_arho2,
                                (const GeometryTile3D*)d_geom, b1, b2, b3, b4, b5, b6,
                                n_ghost
                            );
                        }
                        CHECK_CUDA(cudaGetLastError());
                    };

                    auto do_step = [&]() {
                        submesh_step_kernel_3d<RealType, IsMultiMaterial><<<s_blocks, s_threads>>>(
                            gpu_sm.nx, gpu_sm.ny, gpu_sm.nz, gpu_sm.cellSize, dt_sub, (RealType)gamma,
                            gpu_sm.d_rho, gpu_sm.d_ux, gpu_sm.d_uy, gpu_sm.d_uz, gpu_sm.d_p, gpu_sm.d_E,
                            gpu_sm.d_alpha1, gpu_sm.d_alpha2, gpu_sm.d_arho1, gpu_sm.d_arho2,
                            gpu_sm.d_new_rho, gpu_sm.d_new_ux, gpu_sm.d_new_uy, gpu_sm.d_new_uz, gpu_sm.d_new_p, gpu_sm.d_new_E,
                            gpu_sm.d_new_alpha1, gpu_sm.d_new_alpha2, gpu_sm.d_new_arho1, gpu_sm.d_new_arho2,
                            gpu_sm.d_peak_overpressure, gpu_sm.d_peak_impulse,
                            gpu_sm.d_is_boundary,
                            (const GeometryTile3D*)d_geom, gpu_sm.xmin, gpu_sm.ymin, gpu_sm.zmin,
                            (RealType)xmin, (RealType)ymin, (RealType)zmin, (RealType)cellSize,
                            n_ghost, spatialOrder
                        );
                        CHECK_CUDA(cudaGetLastError());
                    };

                    auto swap_states = [&]() {
                        std::swap(gpu_sm.d_rho, gpu_sm.d_new_rho);
                        std::swap(gpu_sm.d_ux, gpu_sm.d_new_ux);
                        std::swap(gpu_sm.d_uy, gpu_sm.d_new_uy);
                        std::swap(gpu_sm.d_uz, gpu_sm.d_new_uz);
                        std::swap(gpu_sm.d_p, gpu_sm.d_new_p);
                        std::swap(gpu_sm.d_E, gpu_sm.d_new_E);
                        if constexpr (IsMultiMaterial) {
                            std::swap(gpu_sm.d_alpha1, gpu_sm.d_new_alpha1);
                            std::swap(gpu_sm.d_alpha2, gpu_sm.d_new_alpha2);
                            std::swap(gpu_sm.d_arho1, gpu_sm.d_new_arho1);
                            std::swap(gpu_sm.d_arho2, gpu_sm.d_new_arho2);
                        }
                    };

                    prolongate_ghosts((RealType)tau);
                    do_step();
                    swap_states();

                    if (temporalOrder >= 2) {
                        // Stage 2
                        prolongate_ghosts((RealType)tau);
                        do_step(); // Output is in d_new_*
                        swap_states(); // d_rho is now U_temp
                        
                        submesh_rk2_average_kernel_3d<RealType, IsMultiMaterial><<<s_blocks, s_threads>>>(
                            gpu_sm.nx, gpu_sm.ny, gpu_sm.nz,
                            gpu_sm.d_rho, gpu_sm.d_ux, gpu_sm.d_uy, gpu_sm.d_uz, gpu_sm.d_p, gpu_sm.d_E,
                            gpu_sm.d_alpha1, gpu_sm.d_alpha2, gpu_sm.d_arho1, gpu_sm.d_arho2,
                            gpu_sm.d_rho_old, gpu_sm.d_ux_old, gpu_sm.d_uy_old, gpu_sm.d_uz_old, gpu_sm.d_p_old, gpu_sm.d_E_old,
                            gpu_sm.d_alpha1_old, gpu_sm.d_alpha2_old, gpu_sm.d_arho1_old, gpu_sm.d_arho2_old
                        );
                        CHECK_CUDA(cudaGetLastError());
                    }
                }

                stepLevelRecursive(level + 1, dt_sub, tau_start + substep * tau_step * 0.5, tau_step * 0.5);

                for (size_t sm_idx = 0; sm_idx < gpu_submeshes.size(); ++sm_idx) {
                    const auto& child_sm = gpu_submeshes[sm_idx];
                    if (child_sm.level != level + 1 || child_sm.parent_idx < 0) continue;
                    auto& parent_sm = gpu_submeshes[child_sm.parent_idx];

                    int n_rx = child_sm.nx / 2;
                    int n_ry = child_sm.ny / 2;
                    int n_rz = child_sm.nz / 2;
                    dim3 r_threads(8, 8, 4);
                    dim3 r_blocks((n_rx + 7) / 8, (n_ry + 7) / 8, (n_rz + 3) / 4);

                    restrict_to_parent_submesh_kernel_3d<RealType, IsMultiMaterial><<<r_blocks, r_threads>>>(
                        parent_sm.d_rho, parent_sm.d_ux, parent_sm.d_uy, parent_sm.d_uz, parent_sm.d_p, parent_sm.d_E,
                        parent_sm.d_alpha1, parent_sm.d_alpha2, parent_sm.d_arho1, parent_sm.d_arho2,
                        parent_sm.d_peak_overpressure, parent_sm.d_peak_impulse,
                        parent_sm.nx, parent_sm.ny, parent_sm.nz,
                        parent_sm.xmin, parent_sm.ymin, parent_sm.zmin, parent_sm.cellSize,
                        child_sm.nx, child_sm.ny, child_sm.nz,
                        child_sm.xmin, child_sm.ymin, child_sm.zmin, child_sm.cellSize,
                        child_sm.d_rho, child_sm.d_ux, child_sm.d_uy, child_sm.d_uz, child_sm.d_p, child_sm.d_E,
                        child_sm.d_alpha1, child_sm.d_alpha2, child_sm.d_arho1, child_sm.d_arho2,
                        child_sm.d_peak_overpressure, child_sm.d_peak_impulse,
                        child_sm.d_is_boundary,
                        (const GeometryTile3D*)d_geom,
                        n_ghost
                    );
                    CHECK_CUDA(cudaGetLastError());
                }
            }
        };

        stepLevelRecursive(1, dt, 0.0, 1.0);

        for (size_t sm_idx = 0; sm_idx < gpu_submeshes.size(); ++sm_idx) {
            auto& gpu_sm = gpu_submeshes[sm_idx];
            if (gpu_sm.level != 1) continue;

            int n_rx = gpu_sm.nx / 2;
            int n_ry = gpu_sm.ny / 2;
            int n_rz = gpu_sm.nz / 2;
            dim3 r_threads(8, 8, 4);
            dim3 r_blocks((n_rx + 7) / 8, (n_ry + 7) / 8, (n_rz + 3) / 4);

            restrict_to_parent_kernel_3d<RealType, IsMultiMaterial><<<r_blocks, r_threads>>>(
                (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
                (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
                ntx, nty, ntz,
                gpu_sm.nx, gpu_sm.ny, gpu_sm.nz,
                gpu_sm.xmin, gpu_sm.ymin, gpu_sm.zmin, gpu_sm.cellSize,
                (RealType)xmin, (RealType)ymin, (RealType)zmin, (RealType)cellSize,
                nx, ny, nz,
                gpu_sm.d_rho, gpu_sm.d_ux, gpu_sm.d_uy, gpu_sm.d_uz, gpu_sm.d_p, gpu_sm.d_E,
                gpu_sm.d_alpha1, gpu_sm.d_alpha2, gpu_sm.d_arho1, gpu_sm.d_arho2,
                gpu_sm.d_peak_overpressure, gpu_sm.d_peak_impulse,
                gpu_sm.d_is_boundary,
                (const GeometryTile3D*)d_geom,
                n_ghost
            );
            CHECK_CUDA(cudaGetLastError());
        }

        dim3 c_threads(8, 8, 8);
        update_conservative_from_primitive_kernel_3d<RealType, IsMultiMaterial><<<total_tiles, c_threads>>>(
            (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
            total_tiles, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted
        );
        CHECK_CUDA(cudaGetLastError());
        CHECK_CUDA(cudaDeviceSynchronize());
    }

    currentTime += dt;
    updateActiveRegions();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setFluxScheme(const std::string& name) {
    currentFluxScheme = name;
    constants_dirty = true;
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

        RealType c;
        if constexpr (IsMultiMaterial) {
            c = MultiMat::getMixtureSoundSpeed<RealType>(p, rho, states[t_idx].alpha1[c_idx], states[t_idx].alpha2[c_idx], states[t_idx].arho1[c_idx], states[t_idx].arho2[c_idx], (RealType)gamma, d_products, d_unreacted);
            RealType a2 = states[t_idx].alpha2[c_idx];
            RealType ar2 = states[t_idx].arho2[c_idx];
            if (a2 > (RealType)1e-4 && ar2 > (RealType)10.0 && d_det_vel > (RealType)0.0) {
                c = fmax(c, (RealType)d_det_vel);
            }
        } else {
            c = sqrt(gamma * p / max((RealType)1e-6, rho));
        }
        max_s = abs(ux) + abs(uy) + abs(uz) + (RealType)3.0 * c;
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

template <typename RealType>
__global__ void compute_submesh_max_speed_kernel_3d(
    int nx, int ny, int nz, RealType gamma, RealType level_scale,
    const RealType* d_rho, const RealType* d_ux, const RealType* d_uy, const RealType* d_uz, const RealType* d_p,
    RealType* d_max_s_buf
) {
    __shared__ RealType sdata[256];
    int tid = threadIdx.x;
    int total_cells = nx * ny * nz;

    RealType max_s = (RealType)1e-6;
    for (int i = blockIdx.x * blockDim.x + threadIdx.x; i < total_cells; i += blockDim.x * gridDim.x) {
        RealType r = fmax((RealType)1e-8, d_rho[i]);
        RealType u = d_ux[i];
        RealType v = d_uy[i];
        RealType w = d_uz[i];
        RealType pr = fmax((RealType)1e-8, d_p[i]);
        RealType cs = sqrt(gamma * pr / r);
        RealType speed = (abs(u) + abs(v) + abs(w) + (RealType)3.0 * cs) * level_scale;
        if (!isnan(speed) && !isinf(speed)) {
            max_s = fmax(max_s, speed);
        }
    }
    sdata[tid] = max_s;
    __syncthreads();

    for (unsigned int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s) sdata[tid] = fmax(sdata[tid], sdata[tid + s]);
        __syncthreads();
    }

    if (tid == 0) {
        if constexpr (sizeof(RealType) == sizeof(float)) {
            int* val_as_int = (int*)&d_max_s_buf[0];
            int old = *val_as_int, assumed;
            do {
                assumed = old;
                float old_val = __int_as_float(assumed);
                if (old_val >= (float)sdata[0]) break;
                old = atomicCAS(val_as_int, assumed, __float_as_int((float)sdata[0]));
            } while (assumed != old);
        } else {
            unsigned long long int* val_as_ull = (unsigned long long int*)&d_max_s_buf[0];
            unsigned long long int old = *val_as_ull, assumed;
            do {
                assumed = old;
                double old_val = __longlong_as_double(assumed);
                if (old_val >= (double)sdata[0]) break;
                old = atomicCAS(val_as_ull, assumed, __double_as_longlong((double)sdata[0]));
            } while (assumed != old);
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
double CFDSolver3DCuda<RealType, IsMultiMaterial>::computeStepSize(double cfl) const {
    ensure_paged_in();
    bind_constants();
    if (h_num_active_tiles == 0) return 1e-6;

    int n_active = h_num_active_tiles;
    dim3 threads(8, 8, 8);
    compute_max_speed_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>((const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (const int*)d_active_tile_indices, (RealType)gamma, (RealType*)d_max_s_buf);

    // GPU-side second-pass reduction to a single scalar
    reduce_max_kernel<RealType><<<1, 256>>>((const RealType*)d_max_s_buf, n_active, (RealType*)d_max_s_buf);

    if (grid_manager && grid_manager->getSubMeshCount() > 0 && !gpu_submeshes.empty()) {
        for (const auto& gpu_sm : gpu_submeshes) {
            if (!gpu_sm.is_allocated) continue;
            int total_cells = gpu_sm.nx * gpu_sm.ny * gpu_sm.nz;
            int blocks = (total_cells + 255) / 256;
            if (blocks > 64) blocks = 64;
            int level_shift = (gpu_sm.level >= 1) ? (gpu_sm.level - 1) : 0;
            RealType level_scale = (RealType)(1 << level_shift);
            compute_submesh_max_speed_kernel_3d<RealType><<<blocks, 256>>>(
                gpu_sm.nx, gpu_sm.ny, gpu_sm.nz, (RealType)gamma, level_scale,
                gpu_sm.d_rho, gpu_sm.d_ux, gpu_sm.d_uy, gpu_sm.d_uz, gpu_sm.d_p,
                (RealType*)d_max_s_buf
            );
        }
    }

    RealType h_max_s;
    CHECK_CUDA(cudaMemcpy(&h_max_s, d_max_s_buf, sizeof(RealType), cudaMemcpyDeviceToHost));

    double max_s = fmax(1e-6, (double)h_max_s);
    if (std::isnan(max_s) || std::isinf(max_s) || max_s <= 0.0) {
        max_s = 1e-6;
    }

    max_s = std::clamp(max_s, 1e-6, 1e9);
    return cfl * cellSize / max_s;
}

template <typename RealType, bool IsMultiMaterial>
std::vector<float> CFDSolver3DCuda<RealType, IsMultiMaterial>::sampleGauge(const Gauge3D& gauge) const {
    ensure_paged_in();
    bind_constants();

    if (grid_manager && grid_manager->getSubMeshCount() > 0) {
        syncSubMeshesToHost();
        RealType px = (RealType)gauge.x;
        RealType py = (RealType)gauge.y;
        RealType pz = (RealType)gauge.z;
        std::shared_ptr<SubMesh3D<RealType, IsMultiMaterial>> finest_sm = nullptr;
        for (const auto& sm : grid_manager->getSubMeshes()) {
            if (sm->containsInteriorPoint(px, py, pz)) {
                if (!finest_sm || sm->level > finest_sm->level) {
                    finest_sm = sm;
                }
            }
        }

        if (finest_sm) {
            int si = std::clamp((int)std::floor((px - finest_sm->xmin) / finest_sm->cellSize), 0, finest_sm->nx - 1);
            int sj = std::clamp((int)std::floor((py - finest_sm->ymin) / finest_sm->cellSize), 0, finest_sm->ny - 1);
            int sk = std::clamp((int)std::floor((pz - finest_sm->zmin) / finest_sm->cellSize), 0, finest_sm->nz - 1);
            size_t s_idx = finest_sm->getIndex(si, sj, sk);

            std::vector<float> vals(7, 0.0f);
            vals[0] = (float)finest_sm->getValue("pressure", s_idx);
            vals[1] = (float)finest_sm->getValue("density", s_idx);
            vals[2] = (float)finest_sm->getValue("velocity", s_idx);
            vals[3] = (float)finest_sm->getValue("energy", s_idx);
            if constexpr (IsMultiMaterial) {
                vals[4] = (float)finest_sm->getValue("species1", s_idx);
                vals[5] = (float)finest_sm->getValue("species2", s_idx);
                vals[6] = (float)finest_sm->getValue("species3", s_idx);
            } else {
                vals[6] = 1.0f;
            }
            return vals;
        }
    }
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
        total_E = MultiMat::getMixtureEnergy<RealType>(h_tile.p[c_idx], h_tile.rho[c_idx], h_tile.alpha1[c_idx], h_tile.alpha2[c_idx], h_tile.arho1[c_idx], h_tile.arho2[c_idx], (RealType)gamma, d_products, d_unreacted) + ke;
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
    bind_constants();
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
        total_E = MultiMat::getMixtureEnergy<RealType>(cached_tile.p[c_idx], cached_tile.rho[c_idx], cached_tile.alpha1[c_idx], cached_tile.alpha2[c_idx], cached_tile.arho1[c_idx], cached_tile.arho2[c_idx], (RealType)gamma, d_products, d_unreacted) + ke;
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
    bind_constants();
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
        if (obstacle_faces.empty()) {
            return h_data;
        }
        h_data.resize(obstacle_faces.size(), 0.0f);

        if (num_obstacle_faces > 0 && d_obstacle_faces != nullptr) {
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
        }

        if (grid_manager && grid_manager->getSubMeshCount() > 0) {
            syncSubMeshesToHost();
            const auto& submeshes = grid_manager->getSubMeshes();
            for (size_t f = 0; f < obstacle_faces.size() && f < h_data.size(); ++f) {
                const auto& face = obstacle_faces[f];

                double px = 0.0, py = 0.0, pz = 0.0;
                if (face.submesh_index >= 0 && face.submesh_index < (int)submeshes.size()) {
                    const auto& sm_orig = submeshes[face.submesh_index];
                    px = sm_orig->xmin + (face.gx_fluid + 0.5) * sm_orig->cellSize;
                    py = sm_orig->ymin + (face.gy_fluid + 0.5) * sm_orig->cellSize;
                    pz = sm_orig->zmin + (face.gz_fluid + 0.5) * sm_orig->cellSize;
                } else {
                    px = xmin + (face.gx_fluid + 0.5) * cellSize;
                    py = ymin + (face.gy_fluid + 0.5) * cellSize;
                    pz = zmin + (face.gz_fluid + 0.5) * cellSize;
                }

                std::shared_ptr<SubMesh3D<RealType, IsMultiMaterial>> finest_sm = nullptr;
                for (const auto& sm : submeshes) {
                    if (sm->containsInteriorPoint(px, py, pz)) {
                        if (!finest_sm || sm->level > finest_sm->level) {
                            finest_sm = sm;
                        }
                    }
                }

                if (finest_sm) {
                    int si = std::clamp((int)std::floor((px - finest_sm->xmin) / finest_sm->cellSize), 0, finest_sm->nx - 1);
                    int sj = std::clamp((int)std::floor((py - finest_sm->ymin) / finest_sm->cellSize), 0, finest_sm->ny - 1);
                    int sk = std::clamp((int)std::floor((pz - finest_sm->zmin) / finest_sm->cellSize), 0, finest_sm->nz - 1);

                    int target_si = si;
                    int target_sj = sj;
                    int target_sk = sk;

                    size_t s_idx = finest_sm->getIndex(si, sj, sk);
                    if (finest_sm->is_boundary[s_idx]) {
                        bool found = false;
                        for (int r = 1; r <= 2 && !found; ++r) {
                            for (int dz = -r; dz <= r && !found; ++dz) {
                                for (int dy = -r; dy <= r && !found; ++dy) {
                                    for (int dx = -r; dx <= r && !found; ++dx) {
                                        int n_si = si + dx;
                                        int n_sj = sj + dy;
                                        int n_sk = sk + dz;
                                        if (n_si >= 0 && n_si < finest_sm->nx && n_sj >= 0 && n_sj < finest_sm->ny && n_sk >= 0 && n_sk < finest_sm->nz) {
                                            size_t n_idx = finest_sm->getIndex(n_si, n_sj, n_sk);
                                            if (!finest_sm->is_boundary[n_idx]) {
                                                target_si = n_si;
                                                target_sj = n_sj;
                                                target_sk = n_sk;
                                                found = true;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    size_t target_idx = finest_sm->getIndex(target_si, target_sj, target_sk);
                    h_data[f] = (float)finest_sm->getValue(qty, target_idx);
                } else if (face.submesh_index >= 0 && face.submesh_index < (int)submeshes.size()) {
                    const auto& sm = submeshes[face.submesh_index];
                    int si = face.gx_fluid;
                    int sj = face.gy_fluid;
                    int sk = face.gz_fluid;

                    int target_si = si;
                    int target_sj = sj;
                    int target_sk = sk;

                    size_t s_idx = sm->getIndex(si, sj, sk);
                    if (sm->is_boundary[s_idx]) {
                        bool found = false;
                        for (int r = 1; r <= 2 && !found; ++r) {
                            for (int dz = -r; dz <= r && !found; ++dz) {
                                for (int dy = -r; dy <= r && !found; ++dy) {
                                    for (int dx = -r; dx <= r && !found; ++dx) {
                                        int n_si = si + dx;
                                        int n_sj = sj + dy;
                                        int n_sk = sk + dz;
                                        if (n_si >= 0 && n_si < sm->nx && n_sj >= 0 && n_sj < sm->ny && n_sk >= 0 && n_sk < sm->nz) {
                                            size_t n_idx = sm->getIndex(n_si, n_sj, n_sk);
                                            if (!sm->is_boundary[n_idx]) {
                                                target_si = n_si;
                                                target_sj = n_sj;
                                                target_sk = n_sk;
                                                found = true;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    size_t target_idx = sm->getIndex(target_si, target_sj, target_sk);
                    h_data[f] = (float)sm->getValue(qty, target_idx);
                }
            }
        }
        return h_data;
    }

    if (slice.axis == "volume") {
        int stride = slice.stride > 0 ? slice.stride : 1;
        int max_level = 0;
        if (grid_manager && grid_manager->getSubMeshCount() > 0) {
            for (const auto& sm : grid_manager->getSubMeshes()) {
                if (sm->level > max_level) max_level = sm->level;
            }
        }
        int desired_factor = (max_level > 0) ? (1 << max_level) : 1;
        int factor = desired_factor;
        while (factor > 1) {
            int test_w = ((nx + stride - 1) / stride) * factor;
            int test_h = ((ny + stride - 1) / stride) * factor;
            int test_d = ((nz + stride - 1) / stride) * factor;
            size_t test_voxels = (size_t)test_w * test_h * test_d;
            if (test_voxels <= 100000000ULL) break;
            factor /= 2;
        }
        if (factor < 1) factor = 1;

        int out_nx = ((nx + stride - 1) / stride) * factor;
        int out_ny = ((ny + stride - 1) / stride) * factor;
        int out_nz = ((nz + stride - 1) / stride) * factor;
        size_t total_voxels = (size_t)out_nx * out_ny * out_nz;
        h_data.resize(total_voxels, 0.0f);
        size_t required_size = total_voxels * sizeof(float);
        if (d_slice_buf_capacity < required_size) {
            if (d_slice_buf) cudaFree(d_slice_buf);
            d_slice_buf_capacity = required_size;
            CHECK_CUDA(cudaMalloc(&d_slice_buf, d_slice_buf_capacity));
        }
        dim3 threads(8, 8, 8);
        dim3 blocks((out_nx + 7) / 8, (out_ny + 7) / 8, (out_nz + 7) / 8);
        extract_volume_kernel<RealType, IsMultiMaterial><<<blocks, threads>>>(
            (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (const GeometryTile3D*)d_geom,
            (float*)d_slice_buf,
            nx, ny, nz,
            out_nx, out_ny, out_nz,
            xmin, ymin, zmin, cellSize,
            qty_id, stride, factor
        );
        CHECK_CUDA(cudaDeviceSynchronize());
        CHECK_CUDA(cudaMemcpy(h_data.data(), d_slice_buf, required_size, cudaMemcpyDeviceToHost));

        if (grid_manager && grid_manager->getSubMeshCount() > 0) {
            syncSubMeshesToHost();
            double h_ref = (cellSize * stride) / factor;

            auto submeshes = grid_manager->getSubMeshes();
            std::sort(submeshes.begin(), submeshes.end(), [](const auto& a, const auto& b) {
                return a->level < b->level;
            });

            for (const auto& sm : submeshes) {
                int min_gx = std::clamp((int)std::floor((sm->xmin - xmin) / h_ref), 0, out_nx - 1);
                int max_gx = std::clamp((int)std::ceil((sm->xmax - xmin) / h_ref), 0, out_nx - 1);

                int min_gy = std::clamp((int)std::floor((sm->ymin - ymin) / h_ref), 0, out_ny - 1);
                int max_gy = std::clamp((int)std::ceil((sm->ymax - ymin) / h_ref), 0, out_ny - 1);

                int min_gz = std::clamp((int)std::floor((sm->zmin - zmin) / h_ref), 0, out_nz - 1);
                int max_gz = std::clamp((int)std::ceil((sm->zmax - zmin) / h_ref), 0, out_nz - 1);

                for (int gz = min_gz; gz <= max_gz; ++gz) {
                    RealType pz = (RealType)(zmin + (gz + 0.5) * h_ref);
                    for (int gy = min_gy; gy <= max_gy; ++gy) {
                        RealType py = (RealType)(ymin + (gy + 0.5) * h_ref);
                        for (int gx = min_gx; gx <= max_gx; ++gx) {
                            RealType px = (RealType)(xmin + (gx + 0.5) * h_ref);

                            if (sm->containsPoint(px, py, pz)) {
                                int si = std::clamp((int)std::floor((px - sm->xmin) / sm->cellSize), 0, sm->nx - 1);
                                int sj = std::clamp((int)std::floor((py - sm->ymin) / sm->cellSize), 0, sm->ny - 1);
                                int sk = std::clamp((int)std::floor((pz - sm->zmin) / sm->cellSize), 0, sm->nz - 1);

                                int target_si = si;
                                int target_sj = sj;
                                int target_sk = sk;

                                size_t s_idx = sm->getIndex(si, sj, sk);
                                if (sm->is_boundary[s_idx]) {
                                    bool found_sm = false;
                                    for (int r = 1; r <= 2 && !found_sm; ++r) {
                                        for (int dz = -r; dz <= r && !found_sm; ++dz) {
                                            for (int dy = -r; dy <= r && !found_sm; ++dy) {
                                                for (int dx = -r; dx <= r && !found_sm; ++dx) {
                                                    int n_si = si + dx;
                                                    int n_sj = sj + dy;
                                                    int n_sk = sk + dz;
                                                    if (n_si >= 0 && n_si < sm->nx && n_sj >= 0 && n_sj < sm->ny && n_sk >= 0 && n_sk < sm->nz) {
                                                        size_t n_idx = sm->getIndex(n_si, n_sj, n_sk);
                                                        if (!sm->is_boundary[n_idx]) {
                                                            target_si = n_si;
                                                            target_sj = n_sj;
                                                            target_sk = n_sk;
                                                            found_sm = true;
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                size_t target_idx = sm->getIndex(target_si, target_sj, target_sk);
                                h_data[(size_t)gx + (size_t)gy * out_nx + (size_t)gz * out_nx * out_ny] = (float)sm->getValue(qty, target_idx);
                            }
                        }
                    }
                }
            }
        }
        return h_data;
    }

    int axis = (slice.axis == "xy" ? 0 : (slice.axis == "xz" ? 1 : 2));
    int stride = slice.stride > 0 ? slice.stride : 1;
    int scale = 1;
    std::cout << "[DEBUG] extractSlice axis=" << slice.axis << " stride=" << stride << " scale=" << scale << " nx=" << nx << " ny=" << ny << " nz=" << nz << std::endl;
    int base_w = 0, base_h = 0;
    if (axis == 0) { base_w = (nx + stride - 1) / stride; base_h = (ny + stride - 1) / stride; }
    else if (axis == 1) { base_w = (nx + stride - 1) / stride; base_h = (nz + stride - 1) / stride; }
    else { base_w = (ny + stride - 1) / stride; base_h = (nz + stride - 1) / stride; }

    int w = base_w * scale;
    int h = base_h * scale;
    std::cout << "[DEBUG] extractSlice w=" << w << " h=" << h << " base_w=" << base_w << " base_h=" << base_h << std::endl;

    h_data.resize(w * h, 0.0f);

    // Extract coarse slice
    std::vector<float> coarse_slice(base_w * base_h, 0.0f);
    dim3 blocks((base_w+15)/16, (base_h+15)/16);
    dim3 threads(16, 16);

    size_t required_size = (size_t)base_w * (size_t)base_h * sizeof(float);
    if (d_slice_buf_capacity < required_size) {
        if (d_slice_buf) cudaFree(d_slice_buf);
        d_slice_buf_capacity = required_size;
        CHECK_CUDA(cudaMalloc(&d_slice_buf, d_slice_buf_capacity));
    }

    extract_slice_kernel<RealType, IsMultiMaterial><<<blocks, threads>>>((const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (const GeometryTile3D*)d_geom, (float*)d_slice_buf, nx, ny, nz, axis, slice.offset, xmin, ymin, zmin, cellSize, qty_id, stride);
    CHECK_CUDA(cudaDeviceSynchronize());
    CHECK_CUDA(cudaMemcpy(coarse_slice.data(), d_slice_buf, required_size, cudaMemcpyDeviceToHost));

    for (int j = 0; j < h; ++j) {
        for (int i = 0; i < w; ++i) {
            h_data[i + j * w] = coarse_slice[i + j * base_w];
        }
    }

    return h_data;
}

template <typename RealType, bool IsMultiMaterial>
std::vector<SlicePayload3D> CFDSolver3DCuda<RealType, IsMultiMaterial>::extractAllSlices(const Slice3D& slice) const {
    std::vector<SlicePayload3D> results;

    // 1. Parent slice
    SlicePayload3D parent_sp;
    parent_sp.axis = slice.axis;
    parent_sp.offset = slice.offset;
    parent_sp.stride = slice.stride;
    parent_sp.is_submesh = false;
    parent_sp.level = 0;
    parent_sp.xmin = xmin; parent_sp.xmax = xmin + nx * cellSize;
    parent_sp.ymin = ymin; parent_sp.ymax = ymin + ny * cellSize;
    parent_sp.zmin = zmin; parent_sp.zmax = zmin + nz * cellSize;

    int base_w = 0, base_h = 0, depth = 1;
    getSliceDimensions(slice, base_w, base_h, depth);
    parent_sp.w = base_w;
    parent_sp.h = base_h;
    parent_sp.data = extractSlice(slice);

    results.push_back(std::move(parent_sp));

    // 2. Submesh slices
    if (grid_manager && grid_manager->getSubMeshCount() > 0) {
        int axis = (slice.axis == "xy" ? 0 : (slice.axis == "xz" ? 1 : 2));
        std::string qty = (slice.quantities.empty()) ? "pressure" : slice.quantities[0];
        syncSubMeshesToHost();
        
        for (const auto& sm : grid_manager->getSubMeshes()) {
            int n_ghost = 2;
            if (sm->nx > 2 * n_ghost && sm->ny > 2 * n_ghost && sm->nz > 2 * n_ghost) {
                bool intersects = false;
                double margin = n_ghost * sm->cellSize;
                if (axis == 0) { // XY
                    intersects = (slice.offset >= sm->zmin + margin && slice.offset <= sm->zmax - margin);
                } else if (axis == 1) { // XZ
                    intersects = (slice.offset >= sm->ymin + margin && slice.offset <= sm->ymax - margin);
                } else { // YZ
                    intersects = (slice.offset >= sm->xmin + margin && slice.offset <= sm->xmax - margin);
                }

                if (intersects) {
                    SlicePayload3D sub_sp;
                    sub_sp.axis = slice.axis;
                    sub_sp.offset = slice.offset;
                    sub_sp.stride = slice.stride;
                    sub_sp.is_submesh = true;
                    sub_sp.level = sm->level;
                    sub_sp.xmin = sm->xmin + margin; sub_sp.xmax = sm->xmax - margin;
                    sub_sp.ymin = sm->ymin + margin; sub_sp.ymax = sm->ymax - margin;
                    sub_sp.zmin = sm->zmin + margin; sub_sp.zmax = sm->zmax - margin;

                    int sk = 0;
                    if (axis == 0) {
                        sk = std::clamp((int)std::floor((slice.offset - sm->zmin) / sm->cellSize), 0, sm->nz - 1);
                        sub_sp.w = sm->nx - 2 * n_ghost;
                        sub_sp.h = sm->ny - 2 * n_ghost;
                    } else if (axis == 1) {
                        sk = std::clamp((int)std::floor((slice.offset - sm->ymin) / sm->cellSize), 0, sm->ny - 1);
                        sub_sp.w = sm->nx - 2 * n_ghost;
                        sub_sp.h = sm->nz - 2 * n_ghost;
                    } else {
                        sk = std::clamp((int)std::floor((slice.offset - sm->xmin) / sm->cellSize), 0, sm->nx - 1);
                        sub_sp.w = sm->ny - 2 * n_ghost;
                        sub_sp.h = sm->nz - 2 * n_ghost;
                    }

                    sub_sp.data.resize(sub_sp.w * sub_sp.h, 0.0f);
                    for (int j = 0; j < sub_sp.h; ++j) {
                        for (int i = 0; i < sub_sp.w; ++i) {
                            int si = i + n_ghost;
                            int sj = j + n_ghost;
                            size_t s_idx = 0;
                            if (axis == 0) {
                                s_idx = sm->getIndex(si, sj, sk);
                            } else if (axis == 1) {
                                s_idx = sm->getIndex(si, sk, sj);
                            } else {
                                s_idx = sm->getIndex(sk, si, sj);
                            }
                            sub_sp.data[i + j * sub_sp.w] = (float)sm->getValue(qty, s_idx);
                        }
                    }
                    results.push_back(std::move(sub_sp));
                }
            }
        }
    }

    return results;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::getSliceDimensions(const Slice3D& slice, int& w, int& h, int& depth) const {
    int stride = slice.stride > 0 ? slice.stride : 1;
    depth = 1;
    int scale = 1;
    if (slice.axis == "xy" || slice.axis == "obstacles") {
        w = ((nx + stride - 1) / stride) * scale;
        h = ((ny + stride - 1) / stride) * scale;
    } else if (slice.axis == "xz") {
        w = ((nx + stride - 1) / stride) * scale;
        h = ((nz + stride - 1) / stride) * scale;
    } else if (slice.axis == "yz") {
        w = ((ny + stride - 1) / stride) * scale;
        h = ((nz + stride - 1) / stride) * scale;
    } else if (slice.axis == "volume") {
        int max_level = 0;
        if (grid_manager && grid_manager->getSubMeshCount() > 0) {
            for (const auto& sm : grid_manager->getSubMeshes()) {
                if (sm->level > max_level) max_level = sm->level;
            }
        }
        int desired_factor = (max_level > 0) ? (1 << max_level) : 1;
        int factor = desired_factor;
        while (factor > 1) {
            int test_w = ((nx + stride - 1) / stride) * factor;
            int test_h = ((ny + stride - 1) / stride) * factor;
            int test_d = ((nz + stride - 1) / stride) * factor;
            size_t test_voxels = (size_t)test_w * test_h * test_d;
            if (test_voxels <= 100000000ULL) break;
            factor /= 2;
        }
        if (factor < 1) factor = 1;
        w = ((nx + stride - 1) / stride) * factor;
        h = ((ny + stride - 1) / stride) * factor;
        depth = ((nz + stride - 1) / stride) * factor;
    } else {
        w = 0; h = 0; depth = 0;
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) check_active_tiles_kernel(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    const uint8_t* active_tiles,
    uint8_t* temp_active,
    int nx, int ny, int nz) {

    int t_idx = blockIdx.x;

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
    currentTime = 0.0;
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    const auto& outer_state_1d = states_1d.back();
    double amb_rho = (this->ambient_rho > 0.0) ? this->ambient_rho : outer_state_1d.rho;
    double amb_p = (this->ambient_p > 0.0) ? this->ambient_p : outer_state_1d.p;
    ambient_rho = amb_rho;
    ambient_p = amb_p;

    bind_constants();

    if (!d_states || !d_U || !d_active_tiles) {
        CHECK_CUDA(cudaMalloc(&d_states, total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>)));
        CHECK_CUDA(cudaMalloc(&d_U, total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>)));
        CHECK_CUDA(cudaMalloc(&d_active_tiles, total_tiles * sizeof(uint8_t)));
        CHECK_CUDA(cudaMalloc(&d_tile_active_temp, total_tiles * sizeof(uint8_t)));
        CHECK_CUDA(cudaMalloc(&d_active_tile_indices, total_tiles * sizeof(int)));
        CHECK_CUDA(cudaMalloc(&d_active_count, sizeof(int)));
        CHECK_CUDA(cudaMalloc(&d_max_s_buf, total_tiles * sizeof(RealType)));
        CHECK_CUDA(cudaMalloc(&d_tile_mass, total_tiles * sizeof(double)));
        CHECK_CUDA(cudaMalloc(&d_tile_energy, total_tiles * sizeof(double)));
    }
    if (!d_dU) {
        CHECK_CUDA(cudaMalloc(&d_dU, total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>)));
        CHECK_CUDA(cudaMemset(d_dU, 0, total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>)));
    }
    if (!d_geom) {
        CHECK_CUDA(cudaMalloc(&d_geom, total_tiles * sizeof(GeometryTile3D)));
        CHECK_CUDA(cudaMemset(d_geom, 0, total_tiles * sizeof(GeometryTile3D)));
    }
    if (!d_tile_is_near_boundary) {
        CHECK_CUDA(cudaMalloc(&d_tile_is_near_boundary, total_tiles * sizeof(uint8_t)));
        CHECK_CUDA(cudaMemset(d_tile_is_near_boundary, 0, total_tiles * sizeof(uint8_t)));
    }

    // 1. Initialize d_states and d_U to ambient on the device
    initialize_ambient_kernel<RealType, IsMultiMaterial><<<total_tiles, 512>>>(
        (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
        (RealType)amb_rho, (RealType)amb_p, (RealType)gamma, total_tiles
    );
    CHECK_CUDA(cudaDeviceSynchronize());
    CHECK_CUDA(cudaMemset(d_active_tiles, 0, total_tiles * sizeof(uint8_t)));

    // 2. Prepare host tile vector pre-populated with ambient state
    std::vector<PrimitiveTile3D<RealType, IsMultiMaterial>*> h_tiles(total_tiles, nullptr);
    for (int t = 0; t < total_tiles; ++t) {
        auto* tile = new PrimitiveTile3D<RealType, IsMultiMaterial>();
        for (int c = 0; c < TILE_CELLS_3D; ++c) {
            tile->rho[c] = (RealType)amb_rho;
            tile->ux[c] = 0.0; tile->uy[c] = 0.0; tile->uz[c] = 0.0;
            tile->p[c] = (RealType)amb_p;
            if constexpr (IsMultiMaterial) {
                tile->alpha1[c] = 0.0; tile->alpha2[c] = 0.0;
                tile->arho1[c] = 0.0; tile->arho2[c] = 0.0;
            }
            tile->floor_status[c] = 0;
            tile->peak_overpressure[c] = 0.0; tile->running_impulse[c] = 0.0; tile->peak_impulse[c] = 0.0;
        }
        h_tiles[t] = tile;
    }
    temp_h_tiles_ptr = &h_tiles;

    // 3. Remap onto the host tile vector
    remap_1d_to_3d(r_1d, states_1d, *this, x_expl, y_expl, z_expl, R_remap);

    commitStates();

    for (auto* ptr : h_tiles) {
        delete ptr;
    }
    temp_h_tiles_ptr = nullptr;

    if (grid_manager && grid_manager->getSubMeshCount() > 0) {
        temp_h_tiles.resize(total_tiles);
        CHECK_CUDA(cudaMemcpy(temp_h_tiles.data(), d_states, total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyDeviceToHost));
        grid_manager->syncRootFromTiles(temp_h_tiles, nx, ny, nz, ntx, nty, (RealType)gamma, &currentMaterials);

        for (auto& sm : grid_manager->getSubMeshes()) {
            remap_1d_to_submesh(r_1d, states_1d, *sm, x_expl, y_expl, z_expl, R_remap, (double)gamma, currentMaterials, is_ideal_gas_val);
        }

        int n_ghost = (spatialOrder >= 2) ? 2 : 1;
        grid_manager->restrictAllToRoot(n_ghost);

        grid_manager->syncRootToTiles(temp_h_tiles, nx, ny, nz, ntx, nty);
        CHECK_CUDA(cudaMemcpy(d_states, temp_h_tiles.data(), total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyHostToDevice));

        dim3 c_threads(8, 8, 8);
        update_conservative_from_primitive_kernel_3d<RealType, IsMultiMaterial><<<total_tiles, c_threads>>>(
            (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
            total_tiles, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted
        );
        CHECK_CUDA(cudaDeviceSynchronize());

        allocateGPUSubMeshes();
        syncSubMeshesToGPU();

        for (size_t sm_idx = 0; sm_idx < gpu_submeshes.size(); ++sm_idx) {
            auto& gpu_sm = gpu_submeshes[sm_idx];
            if (gpu_sm.level != 1) continue;

            int n_rx = gpu_sm.nx / 2;
            int n_ry = gpu_sm.ny / 2;
            int n_rz = gpu_sm.nz / 2;
            dim3 r_threads(8, 8, 4);
            dim3 r_blocks((n_rx + 7) / 8, (n_ry + 7) / 8, (n_rz + 3) / 4);

            restrict_to_parent_kernel_3d<RealType, IsMultiMaterial><<<r_blocks, r_threads>>>(
                (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
                (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
                ntx, nty, ntz,
                gpu_sm.nx, gpu_sm.ny, gpu_sm.nz,
                gpu_sm.xmin, gpu_sm.ymin, gpu_sm.zmin, gpu_sm.cellSize,
                (RealType)xmin, (RealType)ymin, (RealType)zmin, (RealType)cellSize,
                nx, ny, nz,
                gpu_sm.d_rho, gpu_sm.d_ux, gpu_sm.d_uy, gpu_sm.d_uz, gpu_sm.d_p, gpu_sm.d_E,
                gpu_sm.d_alpha1, gpu_sm.d_alpha2, gpu_sm.d_arho1, gpu_sm.d_arho2,
                gpu_sm.d_peak_overpressure, gpu_sm.d_peak_impulse,
                gpu_sm.d_is_boundary,
                (const GeometryTile3D*)d_geom,
                n_ghost
            );
        }

        update_conservative_from_primitive_kernel_3d<RealType, IsMultiMaterial><<<total_tiles, c_threads>>>(
            (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
            total_tiles, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted
        );
        CHECK_CUDA(cudaDeviceSynchronize());
    }

    dim3 c_threads_unc(8, 8, 8);
    update_conservative_from_primitive_kernel_3d<RealType, IsMultiMaterial><<<total_tiles, c_threads_unc>>>(
        (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
        (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
        total_tiles, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted
    );
    CHECK_CUDA(cudaDeviceSynchronize());

    updateActiveRegions();

    {
        std::vector<uint8_t> h_active_tiles(total_tiles, 0);
        CHECK_CUDA(cudaMemcpy(h_active_tiles.data(), d_active_tiles, total_tiles * sizeof(uint8_t), cudaMemcpyDeviceToHost));
        for (int t = 0; t < total_tiles; ++t) {
            int tx = t % ntx;
            int ty = (t / ntx) % nty;
            int tz = t / (ntx * nty);
            double t_x = xmin + (tx + 0.5) * TILE_SIZE_3D * cellSize;
            double t_y = ymin + (ty + 0.5) * TILE_SIZE_3D * cellSize;
            double t_z = zmin + (tz + 0.5) * TILE_SIZE_3D * cellSize;
            double dist = std::sqrt((t_x - x_expl)*(t_x - x_expl) + (t_y - y_expl)*(t_y - y_expl) + (t_z - z_expl)*(t_z - z_expl));
            if (dist <= R_remap + TILE_SIZE_3D * cellSize * 1.5) {
                h_active_tiles[t] = 1;
            }
        }
        CHECK_CUDA(cudaMemcpy(d_active_tiles, h_active_tiles.data(), total_tiles * sizeof(uint8_t), cudaMemcpyHostToDevice));
        rebuildActiveIndex();
    }

    dim3 r_threads(TILE_SIZE_3D, TILE_SIZE_3D, TILE_SIZE_3D);
    reset_inactive_tiles_kernel<RealType, IsMultiMaterial><<<total_tiles, r_threads>>>(
        (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
        (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
        (const uint8_t*)d_active_tiles,
        (RealType)ambient_rho, (RealType)ambient_p, (RealType)gamma,
        total_tiles,
        currentMaterials.products, currentMaterials.unreacted
    );
    CHECK_CUDA(cudaDeviceSynchronize());

    if (!d_states_old) {
        CHECK_CUDA(cudaMalloc(&d_states_old, total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>)));
    }
    CHECK_CUDA(cudaMemcpy(d_states_old, d_states, total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyDeviceToDevice));
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::initializeFrom2D(int nr, int nz, double dr, double dz, const std::vector<State2D>& states_2d, double x_expl, double y_expl, double z_expl, double R_remap, double source_explosive_z) {
    ensure_paged_in();
    currentTime = 0.0;
    if (states_2d.empty()) return;
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (this->nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    const auto& outer_state_2d = states_2d.back();
    double amb_rho = (this->ambient_rho > 0.0) ? this->ambient_rho : outer_state_2d.rho;
    double amb_p = (this->ambient_p > 0.0) ? this->ambient_p : outer_state_2d.p;
    ambient_rho = amb_rho;
    ambient_p = amb_p;

    bind_constants();

    if (!d_states || !d_U || !d_active_tiles) {
        CHECK_CUDA(cudaMalloc(&d_states, total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>)));
        CHECK_CUDA(cudaMalloc(&d_U, total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>)));
        CHECK_CUDA(cudaMalloc(&d_active_tiles, total_tiles * sizeof(uint8_t)));
        CHECK_CUDA(cudaMalloc(&d_tile_active_temp, total_tiles * sizeof(uint8_t)));
        CHECK_CUDA(cudaMalloc(&d_active_tile_indices, total_tiles * sizeof(int)));
        CHECK_CUDA(cudaMalloc(&d_active_count, sizeof(int)));
        CHECK_CUDA(cudaMalloc(&d_max_s_buf, total_tiles * sizeof(RealType)));
        CHECK_CUDA(cudaMalloc(&d_tile_mass, total_tiles * sizeof(double)));
        CHECK_CUDA(cudaMalloc(&d_tile_energy, total_tiles * sizeof(double)));
    }
    if (!d_dU) {
        CHECK_CUDA(cudaMalloc(&d_dU, total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>)));
        CHECK_CUDA(cudaMemset(d_dU, 0, total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>)));
    }
    if (!d_geom) {
        CHECK_CUDA(cudaMalloc(&d_geom, total_tiles * sizeof(GeometryTile3D)));
        CHECK_CUDA(cudaMemset(d_geom, 0, total_tiles * sizeof(GeometryTile3D)));
    }
    if (!d_tile_is_near_boundary) {
        CHECK_CUDA(cudaMalloc(&d_tile_is_near_boundary, total_tiles * sizeof(uint8_t)));
        CHECK_CUDA(cudaMemset(d_tile_is_near_boundary, 0, total_tiles * sizeof(uint8_t)));
    }

    initialize_ambient_kernel<RealType, IsMultiMaterial><<<total_tiles, 512>>>(
        (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
        (RealType)amb_rho, (RealType)amb_p, (RealType)gamma, total_tiles
    );
    CHECK_CUDA(cudaDeviceSynchronize());
    CHECK_CUDA(cudaMemset(d_active_tiles, 0, total_tiles * sizeof(uint8_t)));

    std::vector<PrimitiveTile3D<RealType, IsMultiMaterial>*> h_tiles(total_tiles, nullptr);
    for (int t = 0; t < total_tiles; ++t) {
        auto* tile = new PrimitiveTile3D<RealType, IsMultiMaterial>();
        for (int c = 0; c < TILE_CELLS_3D; ++c) {
            tile->rho[c] = (RealType)amb_rho;
            tile->ux[c] = 0.0; tile->uy[c] = 0.0; tile->uz[c] = 0.0;
            tile->p[c] = (RealType)amb_p;
            if constexpr (IsMultiMaterial) {
                tile->alpha1[c] = 0.0; tile->alpha2[c] = 0.0;
                tile->arho1[c] = 0.0; tile->arho2[c] = 0.0;
            }
            tile->floor_status[c] = 0;
            tile->peak_overpressure[c] = 0.0; tile->running_impulse[c] = 0.0; tile->peak_impulse[c] = 0.0;
        }
        h_tiles[t] = tile;
    }
    temp_h_tiles_ptr = &h_tiles;

    remap_2d_to_3d(nr, nz, dr, dz, states_2d, *this, x_expl, y_expl, z_expl, R_remap, source_explosive_z);

    commitStates();

    for (auto* ptr : h_tiles) {
        delete ptr;
    }
    temp_h_tiles_ptr = nullptr;

    if (grid_manager && grid_manager->getSubMeshCount() > 0) {
        temp_h_tiles.resize(total_tiles);
        CHECK_CUDA(cudaMemcpy(temp_h_tiles.data(), d_states, total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyDeviceToHost));
        grid_manager->syncRootFromTiles(temp_h_tiles, nx, ny, this->nz, ntx, nty, (RealType)gamma, &currentMaterials);

        for (auto& sm : grid_manager->getSubMeshes()) {
            remap_2d_to_submesh(nr, nz, dr, dz, states_2d, *sm, x_expl, y_expl, z_expl, R_remap, (double)gamma, currentMaterials, is_ideal_gas_val, source_explosive_z);
        }

        int n_ghost = (spatialOrder >= 2) ? 2 : 1;
        grid_manager->restrictAllToRoot(n_ghost);

        grid_manager->syncRootToTiles(temp_h_tiles, nx, ny, this->nz, ntx, nty);
        CHECK_CUDA(cudaMemcpy(d_states, temp_h_tiles.data(), total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyHostToDevice));

        dim3 c_threads(8, 8, 8);
        update_conservative_from_primitive_kernel_3d<RealType, IsMultiMaterial><<<total_tiles, c_threads>>>(
            (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
            total_tiles, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted
        );
        CHECK_CUDA(cudaDeviceSynchronize());

        allocateGPUSubMeshes();
        syncSubMeshesToGPU();

        for (size_t sm_idx = 0; sm_idx < gpu_submeshes.size(); ++sm_idx) {
            auto& gpu_sm = gpu_submeshes[sm_idx];
            if (gpu_sm.level != 1) continue;

            int n_rx = gpu_sm.nx / 2;
            int n_ry = gpu_sm.ny / 2;
            int n_rz = gpu_sm.nz / 2;
            dim3 r_threads(8, 8, 4);
            dim3 r_blocks((n_rx + 7) / 8, (n_ry + 7) / 8, (n_rz + 3) / 4);

            restrict_to_parent_kernel_3d<RealType, IsMultiMaterial><<<r_blocks, r_threads>>>(
                (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
                (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
                ntx, nty, ntz,
                gpu_sm.nx, gpu_sm.ny, gpu_sm.nz,
                gpu_sm.xmin, gpu_sm.ymin, gpu_sm.zmin, gpu_sm.cellSize,
                (RealType)xmin, (RealType)ymin, (RealType)zmin, (RealType)cellSize,
                nx, ny, this->nz,
                gpu_sm.d_rho, gpu_sm.d_ux, gpu_sm.d_uy, gpu_sm.d_uz, gpu_sm.d_p, gpu_sm.d_E,
                gpu_sm.d_alpha1, gpu_sm.d_alpha2, gpu_sm.d_arho1, gpu_sm.d_arho2,
                gpu_sm.d_peak_overpressure, gpu_sm.d_peak_impulse,
                gpu_sm.d_is_boundary,
                (const GeometryTile3D*)d_geom,
                n_ghost
            );
        }

        update_conservative_from_primitive_kernel_3d<RealType, IsMultiMaterial><<<total_tiles, c_threads>>>(
            (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
            total_tiles, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted
        );
        CHECK_CUDA(cudaDeviceSynchronize());
    }

    dim3 c_threads_unc(8, 8, 8);
    update_conservative_from_primitive_kernel_3d<RealType, IsMultiMaterial><<<total_tiles, c_threads_unc>>>(
        (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
        (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
        total_tiles, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted
    );
    CHECK_CUDA(cudaDeviceSynchronize());

    updateActiveRegions();

    if (R_remap > 0.0) {
        std::vector<uint8_t> h_active_tiles(total_tiles, 0);
        CHECK_CUDA(cudaMemcpy(h_active_tiles.data(), d_active_tiles, total_tiles * sizeof(uint8_t), cudaMemcpyDeviceToHost));
        for (int t = 0; t < total_tiles; ++t) {
            int tx = t % ntx;
            int ty = (t / ntx) % nty;
            int tz = t / (ntx * nty);
            double t_x = xmin + (tx + 0.5) * TILE_SIZE_3D * cellSize;
            double t_y = ymin + (ty + 0.5) * TILE_SIZE_3D * cellSize;
            double t_z = zmin + (tz + 0.5) * TILE_SIZE_3D * cellSize;
            double dist = std::sqrt((t_x - x_expl)*(t_x - x_expl) + (t_y - y_expl)*(t_y - y_expl) + (t_z - z_expl)*(t_z - z_expl));
            if (dist <= R_remap + TILE_SIZE_3D * cellSize * 1.5) {
                h_active_tiles[t] = 1;
            }
        }
        CHECK_CUDA(cudaMemcpy(d_active_tiles, h_active_tiles.data(), total_tiles * sizeof(uint8_t), cudaMemcpyHostToDevice));
        rebuildActiveIndex();

        dim3 r_threads(TILE_SIZE_3D, TILE_SIZE_3D, TILE_SIZE_3D);
        reset_inactive_tiles_kernel<RealType, IsMultiMaterial><<<total_tiles, r_threads>>>(
            (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
            (const uint8_t*)d_active_tiles,
            (RealType)ambient_rho, (RealType)ambient_p, (RealType)gamma,
            total_tiles,
            currentMaterials.products, currentMaterials.unreacted
        );
        CHECK_CUDA(cudaDeviceSynchronize());
    }

    if (!d_states_old) {
        CHECK_CUDA(cudaMalloc(&d_states_old, total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>)));
    }
    CHECK_CUDA(cudaMemcpy(d_states_old, d_states, total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyDeviceToDevice));
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
        std::vector<uint8_t> h_active_tiles(total_tiles, 1);
        for (int t = 0; t < total_tiles; ++t) {
            if (h_tiles[t]) {
                CHECK_CUDA(cudaMemcpy((PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states + t, h_tiles[t], sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyHostToDevice));
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
    constants_dirty = true;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setTemporalOrder(int order) { 
    temporalOrder = order; 
    constants_dirty = true;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::addSubMesh(const SubMeshParams3D& submesh) {
    CFDSolver3DImplBase::addSubMesh(submesh);
    if (!grid_manager) {
        auto root = std::make_shared<SubMesh3D<RealType, IsMultiMaterial>>("root", 0, (RealType)xmin, (RealType)ymin, (RealType)zmin, (RealType)lx, (RealType)ly, (RealType)lz, (RealType)cellSize);
        grid_manager = std::make_unique<GridManager3D<RealType, IsMultiMaterial>>(root);
        grid_manager->setBoundaryConditions(bcXmin, bcXmax, bcYmin, bcYmax, bcZmin, bcZmax);
    }

    double p_xmin = xmin, p_ymin = ymin, p_zmin = zmin;
    double p_cellSize = cellSize;
    int parent_level = 0;

    if (submesh.parent_id != "root" && grid_manager) {
        auto p_sm = grid_manager->resolveParentPublic(submesh.parent_id);
        if (p_sm && p_sm != grid_manager->getRootMesh()) {
            double p_margin = 2.0 * p_sm->cellSize;
            p_xmin = p_sm->xmin + p_margin;
            p_ymin = p_sm->ymin + p_margin;
            p_zmin = p_sm->zmin + p_margin;
            p_cellSize = p_sm->cellSize;
            parent_level = p_sm->level;
        }
    }

    int ix0 = (int)std::round((submesh.xmin - p_xmin) / p_cellSize);
    int ix1 = (int)std::round((submesh.xmin + submesh.size_x - p_xmin) / p_cellSize);
    double snapped_xmin = p_xmin + ix0 * p_cellSize;
    double snapped_xmax = p_xmin + std::max(ix0 + 1, ix1) * p_cellSize;
    double snapped_size_x = snapped_xmax - snapped_xmin;

    int jy0 = (int)std::round((submesh.ymin - p_ymin) / p_cellSize);
    int jy1 = (int)std::round((submesh.ymin + submesh.size_y - p_ymin) / p_cellSize);
    double snapped_ymin = p_ymin + jy0 * p_cellSize;
    double snapped_ymax = p_ymin + std::max(jy0 + 1, jy1) * p_cellSize;
    double snapped_size_y = snapped_ymax - snapped_ymin;

    int kz0 = (int)std::round((submesh.zmin - p_zmin) / p_cellSize);
    int kz1 = (int)std::round((submesh.zmin + submesh.size_z - p_zmin) / p_cellSize);
    double snapped_zmin = p_zmin + kz0 * p_cellSize;
    double snapped_zmax = p_zmin + std::max(kz0 + 1, kz1) * p_cellSize;
    double snapped_size_z = snapped_zmax - snapped_zmin;

    int level_diff = std::max(1, submesh.level - parent_level);
    double submeshCellSize = p_cellSize / (double)(1 << level_diff);
    double margin = 2.0 * submeshCellSize;
    auto sm = std::make_shared<SubMesh3D<RealType, IsMultiMaterial>>(
        submesh.id, submesh.level,
        (RealType)(snapped_xmin - margin), (RealType)(snapped_ymin - margin), (RealType)(snapped_zmin - margin),
        (RealType)(snapped_size_x + 2.0 * margin), (RealType)(snapped_size_y + 2.0 * margin), (RealType)(snapped_size_z + 2.0 * margin),
        (RealType)submeshCellSize,
        submesh.parent_id
    );
    grid_manager->addSubMesh(sm);

    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    if (!global_geometry_tiles.empty()) {
        grid_manager->updateSubMeshGeometry(global_geometry_tiles, nx, ny, nz, (RealType)cellSize, (RealType)xmin, (RealType)ymin, (RealType)zmin, ntx, nty);
    }
    allocateGPUSubMeshes();
    syncSubMeshesToGPU();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setBoundaryConditions(BCType3D xmin, BCType3D xmax, BCType3D ymin, BCType3D ymax, BCType3D zmin, BCType3D zmax) {
    CFDSolver3DImplBase::setBoundaryConditions(xmin, xmax, ymin, ymax, zmin, zmax);
    if (grid_manager) {
        grid_manager->setBoundaryConditions(xmin, xmax, ymin, ymax, zmin, zmax);
    }
    updateBoundaryConditions();
}
template <typename RealType, bool IsMultiMaterial>
__global__ void batch_sample_gauges_kernel_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    const GPUSubMeshDevicePointer3D<RealType>* submesh_ptrs,
    const GPUGauge3D* gauges,
    float* out_data,
    int num_gauges
) {
    int g = blockIdx.x * blockDim.x + threadIdx.x;
    if (g >= num_gauges) return;

    int sm_idx = gauges[g].submesh_idx;
    if (sm_idx >= 0 && submesh_ptrs) {
        const auto& sm = submesh_ptrs[sm_idx];
        int idx = gauges[g].sm_idx;

        out_data[g * 7 + 0] = (float)sm.p[idx];
        out_data[g * 7 + 1] = (float)sm.rho[idx];
        RealType ux = sm.ux[idx];
        RealType uy = sm.uy[idx];
        RealType uz = sm.uz[idx];
        out_data[g * 7 + 2] = (float)sqrt((double)(ux * ux + uy * uy + uz * uz));

        RealType ke = (RealType)0.5 * sm.rho[idx] * (ux*ux + uy*uy + uz*uz);
        RealType total_E;
        if constexpr (IsMultiMaterial) {
            total_E = MultiMat::getMixtureEnergy<RealType>(sm.p[idx], sm.rho[idx], sm.alpha1[idx], sm.alpha2[idx], sm.alpha1[idx]*sm.rho[idx], sm.alpha2[idx]*sm.rho[idx], (RealType)d_gamma, d_products, d_unreacted) + ke;
        } else {
            total_E = sm.p[idx] / ((RealType)d_gamma - (RealType)1.0) + ke;
        }
        out_data[g * 7 + 3] = (float)(total_E / fmax((RealType)1e-6, sm.rho[idx]));

        if constexpr (IsMultiMaterial) {
            out_data[g * 7 + 4] = (float)sm.alpha1[idx];
            out_data[g * 7 + 5] = (float)sm.alpha2[idx];
            out_data[g * 7 + 6] = (float)(1.0 - sm.alpha1[idx] - sm.alpha2[idx]);
        } else {
            out_data[g * 7 + 4] = 0.0f;
            out_data[g * 7 + 5] = 0.0f;
            out_data[g * 7 + 6] = 1.0f;
        }
    } else {
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
            total_E = MultiMat::getMixtureEnergy<RealType>(tile.p[c_idx], tile.rho[c_idx], tile.alpha1[c_idx], tile.alpha2[c_idx], tile.arho1[c_idx], tile.arho2[c_idx], (RealType)d_gamma, d_products, d_unreacted) + ke;
        } else {
            total_E = tile.p[c_idx] / ((RealType)d_gamma - (RealType)1.0) + ke;
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
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setGauges(const std::vector<Gauge3D>& gauges) {
    ensure_paged_in();
    if (d_gauge_coords) { cudaFree(d_gauge_coords); d_gauge_coords = nullptr; }
    if (d_gauge_results) { cudaFree(d_gauge_results); d_gauge_results = nullptr; }
    if (d_submesh_buffers_gauge) { cudaFree(d_submesh_buffers_gauge); d_submesh_buffers_gauge = nullptr; }
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
        int submesh_idx = -1;
        int sm_idx = -1;

        if (grid_manager && grid_manager->getSubMeshCount() > 0) {
            RealType px = (RealType)gauges[g].x;
            RealType py = (RealType)gauges[g].y;
            RealType pz = (RealType)gauges[g].z;
            const auto& host_submeshes = grid_manager->getSubMeshes();
            std::shared_ptr<SubMesh3D<RealType, IsMultiMaterial>> finest_sm = nullptr;
            int finest_sm_i = -1;
            for (size_t sm_i = 0; sm_i < host_submeshes.size(); ++sm_i) {
                const auto& sm = host_submeshes[sm_i];
                if (sm->containsInteriorPoint(px, py, pz)) {
                    if (!finest_sm || sm->level > finest_sm->level) {
                        finest_sm = sm;
                        finest_sm_i = (int)sm_i;
                    }
                }
            }

            if (finest_sm) {
                submesh_idx = finest_sm_i;
                const auto& sm = finest_sm;
                int si = std::clamp((int)std::floor((px - sm->xmin) / sm->cellSize), 0, sm->nx - 1);
                int sj = std::clamp((int)std::floor((py - sm->ymin) / sm->cellSize), 0, sm->ny - 1);
                int sk = std::clamp((int)std::floor((pz - sm->zmin) / sm->cellSize), 0, sm->nz - 1);

                if (has_geom) {
                    auto cell_is_solid_sub = [&](int i, int j, int k) -> bool {
                        if (i < 0 || i >= sm->nx || j < 0 || j >= sm->ny || k < 0 || k >= sm->nz) return false;
                        size_t idx = sm->getIndex(i, j, k);
                        return sm->is_boundary[idx] != 0;
                    };
                    auto cell_is_boundary_contact_sub = [&](int i, int j, int k) -> bool {
                        const int face_dirs[6][3] = {
                            {1,0,0},{-1,0,0},{0,1,0},{0,-1,0},{0,0,1},{0,0,-1}
                        };
                        for (auto& d : face_dirs) {
                            if (cell_is_solid_sub(i + d[0], j + d[1], k + d[2])) return true;
                        }
                        return false;
                    };

                    const int SNAP_RADIUS = 2;
                    bool gauge_is_solid = cell_is_solid_sub(si, sj, sk);
                    bool near_solid = gauge_is_solid;
                    if (!near_solid) {
                        for (int dz = -SNAP_RADIUS; dz <= SNAP_RADIUS && !near_solid; ++dz)
                        for (int dy = -SNAP_RADIUS; dy <= SNAP_RADIUS && !near_solid; ++dy)
                        for (int dx = -SNAP_RADIUS; dx <= SNAP_RADIUS && !near_solid; ++dx) {
                            float dist = std::sqrt((float)(dx*dx + dy*dy + dz*dz));
                            if (dist <= 1.999f && cell_is_solid_sub(si+dx, sj+dy, sk+dz))
                                near_solid = true;
                        }
                    }

                    if (near_solid) {
                        int best_x = -1, best_y = -1, best_z = -1;
                        float best_dist_contact = 1e9f;
                        float best_dist_fluid = 1e9f;
                        int bf_x = -1, bf_y = -1, bf_z = -1;

                        const int SEARCH_RADIUS = SNAP_RADIUS + 1;
                        for (int dz = -SEARCH_RADIUS; dz <= SEARCH_RADIUS; ++dz)
                        for (int dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; ++dy)
                        for (int dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; ++dx) {
                            int cx = si + dx, cy = sj + dy, cz = sk + dz;
                            if (cx < 0 || cx >= sm->nx || cy < 0 || cy >= sm->ny || cz < 0 || cz >= sm->nz) continue;
                            if (cell_is_solid_sub(cx, cy, cz)) continue;

                            float dist = std::sqrt((float)(dx*dx + dy*dy + dz*dz));
                            if (cell_is_boundary_contact_sub(cx, cy, cz)) {
                                if (dist < best_dist_contact) {
                                    best_dist_contact = dist;
                                    best_x = cx; best_y = cy; best_z = cz;
                                }
                            }
                            if (dist < best_dist_fluid) {
                                best_dist_fluid = dist;
                                bf_x = cx; bf_y = cy; bf_z = cz;
                            }
                        }

                        int snap_x, snap_y, snap_z;
                        if (best_x >= 0) {
                            snap_x = best_x; snap_y = best_y; snap_z = best_z;
                        } else if (bf_x >= 0) {
                            snap_x = bf_x; snap_y = bf_y; snap_z = bf_z;
                        } else {
                            snap_x = si; snap_y = sj; snap_z = sk;
                        }

                        if (snap_x != si || snap_y != sj || snap_z != sk) {
                            std::cout << "[SUBMESH GAUGE SNAP] Gauge '" << gauges[g].name
                                      << "' adjusted from submesh cell (" << si << "," << sj << "," << sk << ")"
                                      << " to submesh boundary-contact cell (" << snap_x << "," << snap_y << "," << snap_z << ")"
                                      << " (dist=" << best_dist_contact << " cells)\n";
                            si = snap_x; sj = snap_y; sk = snap_z;
                        }
                    }
                }

                sm_idx = (int)sm->getIndex(si, sj, sk);
            }
        }

        int gx = std::clamp((int)((gauges[g].x - xmin) / cellSize), 0, nx - 1);
        int gy = std::clamp((int)((gauges[g].y - ymin) / cellSize), 0, ny - 1);
        int gz = std::clamp((int)((gauges[g].z - zmin) / cellSize), 0, nz - 1);

        if (submesh_idx == -1) {
            if (has_geom) {
                const int SNAP_RADIUS = 2;
                bool gauge_is_solid = cell_is_solid(gx, gy, gz);

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
                    int best_x = -1, best_y = -1, best_z = -1;
                    float best_dist_contact = 1e9f;
                    float best_dist_fluid   = 1e9f;
                    int   bf_x = -1, bf_y = -1, bf_z = -1;

                    const int SEARCH_RADIUS = SNAP_RADIUS + 1;
                    for (int dz = -SEARCH_RADIUS; dz <= SEARCH_RADIUS; ++dz)
                    for (int dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; ++dy)
                    for (int dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; ++dx) {
                        int cx = gx + dx, cy = gy + dy, cz = gz + dz;
                        if (cx < 0 || cx >= nx || cy < 0 || cy >= ny || cz < 0 || cz >= nz) continue;
                        if (cell_is_solid(cx, cy, cz)) continue;

                        float dist = std::sqrt((float)(dx*dx + dy*dy + dz*dz));

                        if (cell_is_boundary_contact(cx, cy, cz)) {
                            if (dist < best_dist_contact) {
                                best_dist_contact = dist;
                                best_x = cx; best_y = cy; best_z = cz;
                            }
                        }
                        if (dist < best_dist_fluid) {
                            best_dist_fluid = dist;
                            bf_x = cx; bf_y = cy; bf_z = cz;
                        }
                    }

                    int snap_x, snap_y, snap_z;
                    if (best_x >= 0) {
                        snap_x = best_x; snap_y = best_y; snap_z = best_z;
                    } else if (bf_x >= 0) {
                        snap_x = bf_x; snap_y = bf_y; snap_z = bf_z;
                    } else {
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
        }

        int tx = gx / TILE_SIZE_3D, ty = gy / TILE_SIZE_3D, tz = gz / TILE_SIZE_3D;
        int t_idx = tx + ty * ntx + tz * ntx * nty;
        int lx = gx % TILE_SIZE_3D, ly = gy % TILE_SIZE_3D, lz = gz % TILE_SIZE_3D;
        int c_idx = lx + ly * 8 + lz * 64;

        local_gauge_coords[g].t_idx = t_idx;
        local_gauge_coords[g].c_idx = c_idx;
        local_gauge_coords[g].submesh_idx = submesh_idx;
        local_gauge_coords[g].sm_idx = sm_idx;
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

    // Synchronise submesh device pointers to the GPU array for sampling
    if (grid_manager && grid_manager->getSubMeshCount() > 0 && !gpu_submeshes.empty()) {
        size_t n_sub = gpu_submeshes.size();
        std::vector<GPUSubMeshDevicePointer3D<RealType>> temp_ptrs(n_sub);
        for (size_t i = 0; i < n_sub; ++i) {
            temp_ptrs[i].rho = gpu_submeshes[i].d_rho;
            temp_ptrs[i].ux = gpu_submeshes[i].d_ux;
            temp_ptrs[i].uy = gpu_submeshes[i].d_uy;
            temp_ptrs[i].uz = gpu_submeshes[i].d_uz;
            temp_ptrs[i].p = gpu_submeshes[i].d_p;
            temp_ptrs[i].E = gpu_submeshes[i].d_E;
            temp_ptrs[i].alpha1 = gpu_submeshes[i].d_alpha1;
            temp_ptrs[i].alpha2 = gpu_submeshes[i].d_alpha2;
        }

        if (!d_submesh_buffers_gauge) {
            CHECK_CUDA(cudaMalloc(&d_submesh_buffers_gauge, n_sub * sizeof(GPUSubMeshDevicePointer3D<RealType>)));
        }
        CHECK_CUDA(cudaMemcpy(d_submesh_buffers_gauge, temp_ptrs.data(), n_sub * sizeof(GPUSubMeshDevicePointer3D<RealType>), cudaMemcpyHostToDevice));
    }

    int threads_per_block = 256;
    int blocks_gauge = (num_gauges + threads_per_block - 1) / threads_per_block;
    batch_sample_gauges_kernel_3d<RealType, IsMultiMaterial><<<blocks_gauge, threads_per_block, 0, (cudaStream_t)gauge_stream>>>(
        (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
        (const GPUSubMeshDevicePointer3D<RealType>*)d_submesh_buffers_gauge,
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

    if (grid_manager && grid_manager->getSubMeshCount() > 0) {
        if (!stl_filepath.empty()) {
            std::vector<Triangle> triangles = read_stl(stl_filepath);
            grid_manager->voxelizeSubMeshGeometry(triangles, voxelization_method);
        }
        syncSubMeshesToGPU();
    }
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

    if (grid_manager && grid_manager->getSubMeshCount() > 0) {
        grid_manager->voxelizeSubMeshGeometry(triangles, voxelization_method);
        syncSubMeshesToGPU();
    }
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

    if (grid_manager && grid_manager->getSubMeshCount() > 0) {
        std::vector<Triangle> triangles = generate_primitives_triangles(primitives);
        grid_manager->voxelizeSubMeshGeometry(triangles, voxelization_method);
        syncSubMeshesToGPU();
    }
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

    if (grid_manager && grid_manager->getSubMeshCount() > 0) {
        grid_manager->updateSubMeshGeometry(host_geom, nx, ny, nz, (RealType)cellSize, (RealType)xmin, (RealType)ymin, (RealType)zmin, ntx, nty);
        syncSubMeshesToGPU();
    }
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
    obstacle_faces = faces;
    if (d_obstacle_faces) {
        cudaFree(d_obstacle_faces);
        d_obstacle_faces = nullptr;
    }

    num_obstacle_faces = 0;
    for (const auto& f : faces) {
        if (f.submesh_index == -1) {
            num_obstacle_faces++;
        }
    }
    if (num_obstacle_faces == 0) return;

    std::vector<GPUObstacleFace> local_faces(num_obstacle_faces);
    int ntx = (nx + 7) / 8;
    int nty = (ny + 7) / 8;

    int current_f = 0;
    for (size_t f = 0; f < faces.size(); ++f) {
        const auto& face = faces[f];
        if (face.submesh_index != -1) continue;

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

        local_faces[current_f].t_idx = t;
        local_faces[current_f].c_idx = c;
        current_f++;
    }

    CHECK_CUDA(cudaMalloc(&d_obstacle_faces, num_obstacle_faces * sizeof(GPUObstacleFace)));
    CHECK_CUDA(cudaMemcpy(d_obstacle_faces, local_faces.data(), num_obstacle_faces * sizeof(GPUObstacleFace), cudaMemcpyHostToDevice));
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::appendSubMeshObstacleFaces(std::vector<ObstacleFace>& faces) {
    if (!grid_manager || grid_manager->getSubMeshCount() == 0) return;

    const auto& submeshes = grid_manager->getSubMeshes();
    for (int sm_idx = 0; sm_idx < (int)submeshes.size(); ++sm_idx) {
        const auto& sm = submeshes[sm_idx];
        if (sm->is_boundary.empty()) continue;

        RealType h = sm->cellSize;
        int snx = sm->nx, sny = sm->ny, snz = sm->nz;

        auto is_solid = [&](int i, int j, int k) -> bool {
            if (i < 0 || i >= snx || j < 0 || j >= sny || k < 0 || k >= snz) return false;
            return sm->is_boundary[sm->getIndex(i, j, k)] != 0;
        };

        for (int gz = 0; gz < snz; ++gz) {
            for (int gy = 0; gy < sny; ++gy) {
                for (int gx = 0; gx < snx; ++gx) {
                    if (is_solid(gx, gy, gz)) continue;

                    float x0 = (float)(sm->xmin + gx * h);
                    float x1 = (float)(sm->xmin + (gx + 1) * h);
                    float y0 = (float)(sm->ymin + gy * h);
                    float y1 = (float)(sm->ymin + (gy + 1) * h);
                    float z0 = (float)(sm->zmin + gz * h);
                    float z1 = (float)(sm->zmin + (gz + 1) * h);

                    // -x
                    if (is_solid(gx - 1, gy, gz)) {
                        ObstacleFace f; f.submesh_index = sm_idx;
                        f.gx_fluid = gx; f.gy_fluid = gy; f.gz_fluid = gz;
                        f.px[0]=x0; f.px[1]=x0; f.px[2]=x0; f.px[3]=x0;
                        f.py[0]=y0; f.py[1]=y0; f.py[2]=y1; f.py[3]=y1;
                        f.pz[0]=z0; f.pz[1]=z1; f.pz[2]=z1; f.pz[3]=z0;
                        faces.push_back(f);
                    }
                    // +x
                    if (is_solid(gx + 1, gy, gz)) {
                        ObstacleFace f; f.submesh_index = sm_idx;
                        f.gx_fluid = gx; f.gy_fluid = gy; f.gz_fluid = gz;
                        f.px[0]=x1; f.px[1]=x1; f.px[2]=x1; f.px[3]=x1;
                        f.py[0]=y0; f.py[1]=y1; f.py[2]=y1; f.py[3]=y0;
                        f.pz[0]=z0; f.pz[1]=z0; f.pz[2]=z1; f.pz[3]=z1;
                        faces.push_back(f);
                    }
                    // -y
                    if (is_solid(gx, gy - 1, gz)) {
                        ObstacleFace f; f.submesh_index = sm_idx;
                        f.gx_fluid = gx; f.gy_fluid = gy; f.gz_fluid = gz;
                        f.px[0]=x0; f.px[1]=x1; f.px[2]=x1; f.px[3]=x0;
                        f.py[0]=y0; f.py[1]=y0; f.py[2]=y0; f.py[3]=y0;
                        f.pz[0]=z0; f.pz[1]=z0; f.pz[2]=z1; f.pz[3]=z1;
                        faces.push_back(f);
                    }
                    // +y
                    if (is_solid(gx, gy + 1, gz)) {
                        ObstacleFace f; f.submesh_index = sm_idx;
                        f.gx_fluid = gx; f.gy_fluid = gy; f.gz_fluid = gz;
                        f.px[0]=x0; f.px[1]=x0; f.px[2]=x1; f.px[3]=x1;
                        f.py[0]=y1; f.py[1]=y1; f.py[2]=y1; f.py[3]=y1;
                        f.pz[0]=z0; f.pz[1]=z1; f.pz[2]=z1; f.pz[3]=z0;
                        faces.push_back(f);
                    }
                    // -z
                    if (is_solid(gx, gy, gz - 1)) {
                        ObstacleFace f; f.submesh_index = sm_idx;
                        f.gx_fluid = gx; f.gy_fluid = gy; f.gz_fluid = gz;
                        f.px[0]=x0; f.px[1]=x0; f.px[2]=x1; f.px[3]=x1;
                        f.py[0]=y0; f.py[1]=y1; f.py[2]=y1; f.py[3]=y0;
                        f.pz[0]=z0; f.pz[1]=z0; f.pz[2]=z0; f.pz[3]=z0;
                        faces.push_back(f);
                    }
                    // +z
                    if (is_solid(gx, gy, gz + 1)) {
                        ObstacleFace f; f.submesh_index = sm_idx;
                        f.gx_fluid = gx; f.gy_fluid = gy; f.gz_fluid = gz;
                        f.px[0]=x0; f.px[1]=x1; f.px[2]=x1; f.px[3]=x0;
                        f.py[0]=y0; f.py[1]=y0; f.py[2]=y1; f.py[3]=y1;
                        f.pz[0]=z1; f.pz[1]=z1; f.pz[2]=z1; f.pz[3]=z1;
                        faces.push_back(f);
                    }
                }
            }
        }
    }
}

template class CFDSolver3DCuda<float, true>;
template class CFDSolver3DCuda<float, false>;
template class CFDSolver3DCuda<double, true>;
template class CFDSolver3DCuda<double, false>;
