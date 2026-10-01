#pragma once
#include "cfd_solver_3d_cuda.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include "fem_solver_3d_cuda.hpp"
#include "fem_fsi_coupler_3d_cuda.hpp"
#include <cuda_runtime.h>
#include "ImmersedBoundary.hpp"

extern void remap_1d_to_3d(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d,
    CFDSolver3D& solver_3d, double x_expl, double y_expl, double z_expl, double R_remap);
extern void remap_2d_to_3d(int nr, int nz, double dr, double dz, const std::vector<State2D>& states_2d,
    CFDSolver3D& solver_3d, double x_expl, double y_expl, double z_expl, double R_remap, double source_explosive_z = 0.0);
#include <device_launch_parameters.h>
#include <string>
#include <stdexcept>

#define CHECK_CUDA(call) { \
    cudaError_t err = call; \
    if (err != cudaSuccess) { \
        std::string err_msg = std::string("CUDA Error: ") + cudaGetErrorString(err) + " at " + __FILE__ + ":" + std::to_string(__LINE__); \
        std::cerr << err_msg << std::endl; \
        throw std::runtime_error(err_msg); \
    } \
}

static __global__ void init_active_indices_kernel(int* indices, int N) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i < N) indices[i] = i;
}

// Global constants for GPU
static __constant__ double d_gamma;
static __constant__ double d_cellSize;
static __constant__ int d_nx, d_ny, d_nz;
static __constant__ int d_ntx, d_nty, d_ntz;
static __constant__ bool d_useAUSM;
static __constant__ double d_xmin, d_ymin, d_zmin;
static __constant__ int d_bcXmin, d_bcXmax, d_bcYmin, d_bcYmax, d_bcZmin, d_bcZmax;
static __constant__ int d_spatialOrder;
static __constant__ int d_temporalOrder;
static __constant__ double d_ambient_rho;
static __constant__ double d_ambient_p;
static __constant__ MultiMat::JWLParams d_products;
static __constant__ MultiMat::JWLParams d_unreacted;
static __constant__ double d_det_vel;
static __constant__ double d_detonation_energy;
static __constant__ MultiMat::AfterburnParams d_afterburn;
static __constant__ double d_charge_radius;
static __constant__ double d_detX;
static __constant__ double d_detY;
static __constant__ double d_detZ;
static __constant__ double d_gravity_x;
static __constant__ double d_gravity_y;
static __constant__ double d_gravity_z;
static __constant__ bool d_has_gravity;

// Global pointers for dynamic fallback in zero-copy prediction
static __constant__ unsigned long long d_states_orig_global;
static __constant__ unsigned long long d_active_tiles_global;

static __constant__ bool d_isWater;
static __constant__ Blast::TaitEOSParams d_taitParams;
static __constant__ Blast::Stratified3DParams d_stratParams;

template <typename T1, typename T2 = T1, typename T3 = T1>
__device__ inline bool is_cell_water(T1 rho, T2 z_c, T3 alpha_he = static_cast<T3>(0.0)) {
    if (d_stratParams.enabled) {
        if (z_c < static_cast<T2>(d_stratParams.seabed_surface_z)) {
            return false; // Below mudline is seabed geotechnical foundation / sediment
        }
        if (z_c <= static_cast<T2>(d_stratParams.water_surface_z)) {
            return true; // Water column domain: phase 0 background fluid is always water (including immersed HE charge)
        }
        // Above water free surface: water splash / plume droplets
        if (alpha_he > static_cast<T3>(0.02)) {
            return false;
        }
        return (rho >= static_cast<T1>(800.0));
    }
    if (alpha_he > static_cast<T3>(0.02)) {
        return false; // Energetic material / detonation gas is never liquid water
    }
    if (d_isWater) {
        return (rho > static_cast<T1>(100.0));
    }
    return false;
}

template <typename T1, typename T2 = T1, typename T3 = T1>
__device__ inline bool is_cell_soil(T1 rho, T2 z_c, T3 alpha_he = static_cast<T3>(0.0)) {
    if (alpha_he > static_cast<T3>(0.02)) {
        return false;
    }
    if (d_stratParams.enabled) {
        return (z_c < static_cast<T2>(d_stratParams.seabed_surface_z));
    }
    return false;
}

template <typename RealType>
__device__ inline RealType computeFluidEnergyGPU(RealType p, RealType rho, RealType gamma, RealType z_c) {
    if (is_cell_soil(rho, z_c)) {
        RealType gamma_soil = (RealType)(d_stratParams.soil_gamma > 0.0 ? d_stratParams.soil_gamma : 4.0);
        RealType rho0_soil = (RealType)(d_stratParams.soil_density > 0.0 ? d_stratParams.soil_density : 2000.0);
        RealType c0_soil = (RealType)(d_stratParams.soil_c0 > 0.0 ? d_stratParams.soil_c0 : 2500.0);
        RealType B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
        RealType p0_soil = (RealType)d_stratParams.p_atm;
        RealType r = (rho > (RealType)100.0) ? rho : (RealType)Blast::TaitEOSWater::compute_density_isentropic((double)p, (double)B_soil, (double)gamma_soil, (double)rho0_soil, (double)p0_soil);
        RealType e_soil = (RealType)Blast::TaitEOSWater::compute_energy_isentropic((double)r, (double)B_soil, (double)gamma_soil, (double)rho0_soil);
        return r * e_soil;
    } else if (is_cell_water(rho, z_c)) {
        return rho * (RealType)Blast::TaitEOSWater::compute_energy_dispatcher(rho, p, d_taitParams);
    } else {
        return p / (gamma - (RealType)1.0);
    }
}




struct GPUTriangle {
    float3 v0, v1, v2;
    float3 normal;
};

static __device__ inline void atomicStore16(uint16_t* address, uint16_t val) {
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

static __device__ inline float dist_to_segment_gpu(float3 pt, float3 a, float3 b) {
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

static __device__ inline bool is_cell_intersected_gpu(
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


static __global__ void voxelize_triangles_kernel(
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

    int c_idx = threadIdx.x + threadIdx.y * 8 + threadIdx.z * 64;

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
    
    int tz = t_idx / (d_ntx * d_nty);
    int k = c_idx / (TILE_SIZE_3D * TILE_SIZE_3D);
    int gz = tz * TILE_SIZE_3D + k;
    RealType z_c = (RealType)d_zmin + ((RealType)gz + (RealType)0.5) * (RealType)d_cellSize;

    if constexpr (IsMultiMaterial) {
        RealType total_E;
        if (is_cell_water(s.rho[c_idx], z_c)) {
            total_E = MultiMat::getMixtureEnergyTait<RealType>(s.p[c_idx], s.rho[c_idx], s.alpha1[c_idx], s.alpha2[c_idx], s.arho1[c_idx], s.arho2[c_idx], d_taitParams, d_products, d_unreacted) + ke;
        } else if (is_cell_soil(s.rho[c_idx], z_c)) {
            total_E = computeFluidEnergyGPU<RealType>(s.p[c_idx], s.rho[c_idx], (RealType)d_gamma, z_c) + ke;
        } else {
            total_E = MultiMat::getMixtureEnergy<RealType>(s.p[c_idx], s.rho[c_idx], s.alpha1[c_idx], s.alpha2[c_idx], s.arho1[c_idx], s.arho2[c_idx], (RealType)d_gamma, d_products, d_unreacted) + ke;
        }
        u.E[c_idx] = total_E;
    } else {
        RealType total_E = computeFluidEnergyGPU<RealType>(s.p[c_idx], s.rho[c_idx], (RealType)d_gamma, z_c) + ke;
        u.E[c_idx] = total_E;
    }

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

template <typename RealType, bool IsMultiMaterial>
__device__ inline RealType computeCellSoundSpeedGPU(
    const GPUCellStateT<RealType, IsMultiMaterial>& s,
    RealType z_c, RealType gamma) {
    if (is_cell_soil(s.rho, z_c)) {
        RealType gamma_soil = (RealType)(d_stratParams.soil_gamma > 0.0 ? d_stratParams.soil_gamma : 4.0);
        RealType rho0_soil = (RealType)(d_stratParams.soil_density > 0.0 ? d_stratParams.soil_density : 2000.0);
        RealType c0_soil = (RealType)(d_stratParams.soil_c0 > 0.0 ? d_stratParams.soil_c0 : 2500.0);
        RealType B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
        if (d_stratParams.soil_eos_variant == 1) { // Caloric Gruneisen
            RealType gruneisen_soil = (RealType)(d_stratParams.soil_gruneisen > 0.0 ? d_stratParams.soil_gruneisen : 1.45);
            RealType e_spec = s.E / fmax((RealType)1e-6, s.rho);
            return (RealType)Blast::TaitEOSWater::compute_sound_speed_caloric(
                (double)s.rho, (double)s.p, (double)e_spec, (double)B_soil, (double)gamma_soil, (double)rho0_soil, (double)gruneisen_soil
            );
        } else if (d_stratParams.soil_eos_variant == 2) { // Shock Hugoniot
            RealType s_soil = (RealType)(d_stratParams.soil_s > 0.0 ? d_stratParams.soil_s : 1.35);
            RealType gruneisen_soil = (RealType)(d_stratParams.soil_gruneisen > 0.0 ? d_stratParams.soil_gruneisen : 1.45);
            return (RealType)Blast::TaitEOSWater::compute_sound_speed_hugoniot(
                (double)s.rho, (double)s.p, (double)c0_soil, (double)s_soil, (double)rho0_soil, (double)gruneisen_soil
            );
        } else {
            return (RealType)Blast::TaitEOSWater::compute_sound_speed_isentropic((double)s.rho, (double)B_soil, (double)gamma_soil, (double)rho0_soil);
        }
    }
    bool is_water = is_cell_water(s.rho, z_c);
    if constexpr (IsMultiMaterial) {
        if (is_water) {
            return MultiMat::getMixtureSoundSpeedTait<RealType>(
                s.p, s.rho, s.alpha1, s.alpha2, s.arho1, s.arho2,
                d_taitParams, d_products, d_unreacted
            );
        } else {
            return MultiMat::getMixtureSoundSpeed<RealType>(
                s.p, s.rho, s.alpha1, s.alpha2, s.arho1, s.arho2,
                gamma, d_products, d_unreacted
            );
        }
    } else {
        if (is_water) {
            return Blast::TaitEOSWater::compute_sound_speed_dispatcher(s.rho, s.p, d_taitParams);
        } else {
            return sqrt(gamma * s.p / fmax((RealType)1e-6, s.rho));
        }
    }
}

static __device__ inline bool is_solid_cell_gpu(const GeometryTile3D* geom, int i, int j, int k) {
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

template <typename RealType, bool IsMultiMaterial, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ __forceinline__ GPUCellStateT<RealType, IsMultiMaterial> sample_gpu_interior(
    const TileType* states,
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

    GPUCellStateT<RealType, IsMultiMaterial> s;
    if constexpr (std::is_same_v<TileType, PrimitiveTile3D<RealType, IsMultiMaterial>>) {
        const auto* active_tiles = (const uint8_t*)d_active_tiles_global;
        const auto* states_orig = (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states_orig_global;
        const auto& tile = (active_tiles && states_orig && active_tiles[t_idx] == 0) ? states_orig[t_idx] : states[t_idx];
        s.rho = __ldg(&tile.rho[c_idx]);
        s.ux = __ldg(&tile.ux[c_idx]);
        s.uy = __ldg(&tile.uy[c_idx]);
        s.uz = __ldg(&tile.uz[c_idx]);
        s.p = __ldg(&tile.p[c_idx]);
        s.E = (RealType)0.0;
        s.peak_overpressure = __ldg(&tile.peak_overpressure[c_idx]);
        s.peak_impulse = __ldg(&tile.peak_impulse[c_idx]);
        if constexpr (IsMultiMaterial) {
            s.alpha1 = __ldg(&tile.alpha1[c_idx]);
            s.alpha2 = __ldg(&tile.alpha2[c_idx]);
            s.arho1 = __ldg(&tile.arho1[c_idx]);
            s.arho2 = __ldg(&tile.arho2[c_idx]);
        }
    } else {
        const auto& tile = states[t_idx];
        s.rho = __ldg(&tile.rho[c_idx]);
        s.ux = __ldg(&tile.ux[c_idx]);
        s.uy = __ldg(&tile.uy[c_idx]);
        s.uz = __ldg(&tile.uz[c_idx]);
        s.p = __ldg(&tile.p[c_idx]);
        s.E = (RealType)0.0;
        s.peak_overpressure = (RealType)0.0;
        s.peak_impulse = (RealType)0.0;
        if constexpr (IsMultiMaterial) {
            s.alpha1 = __ldg(&tile.alpha1[c_idx]);
            s.alpha2 = __ldg(&tile.alpha2[c_idx]);
            s.arho1 = __ldg(&tile.arho1[c_idx]);
            s.arho2 = __ldg(&tile.arho2[c_idx]);
        }
    }
    return s;
}

template <typename RealType, bool IsMultiMaterial, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ __forceinline__ GPUCellStateT<RealType, IsMultiMaterial> sample_gpu_raw(const TileType* states, int gx, int gy, int gz) {
    bool rx = false, ry = false, rz = false;
    int orig_gx = gx, orig_gy = gy, orig_gz = gz;

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

    GPUCellStateT<RealType, IsMultiMaterial> s;
    if constexpr (std::is_same_v<TileType, PrimitiveTile3D<RealType, IsMultiMaterial>>) {
        const auto* active_tiles = (const uint8_t*)d_active_tiles_global;
        const auto* states_orig = (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states_orig_global;
        const auto& tile = (active_tiles && states_orig && active_tiles[t_idx] == 0) ? states_orig[t_idx] : states[t_idx];
        s.rho = __ldg(&tile.rho[c_idx]);
        s.ux = rx ? -__ldg(&tile.ux[c_idx]) : __ldg(&tile.ux[c_idx]);
        s.uy = ry ? -__ldg(&tile.uy[c_idx]) : __ldg(&tile.uy[c_idx]);
        s.uz = rz ? -__ldg(&tile.uz[c_idx]) : __ldg(&tile.uz[c_idx]);
        s.p = __ldg(&tile.p[c_idx]);
        s.E = (RealType)0.0;
        s.peak_overpressure = __ldg(&tile.peak_overpressure[c_idx]);
        s.peak_impulse = __ldg(&tile.peak_impulse[c_idx]);
        if constexpr (IsMultiMaterial) {
            s.alpha1 = __ldg(&tile.alpha1[c_idx]);
            s.alpha2 = __ldg(&tile.alpha2[c_idx]);
            s.arho1 = __ldg(&tile.arho1[c_idx]);
            s.arho2 = __ldg(&tile.arho2[c_idx]);
        }
    } else {
        const auto& tile = states[t_idx];
        s.rho = __ldg(&tile.rho[c_idx]);
        s.ux = rx ? -__ldg(&tile.ux[c_idx]) : __ldg(&tile.ux[c_idx]);
        s.uy = ry ? -__ldg(&tile.uy[c_idx]) : __ldg(&tile.uy[c_idx]);
        s.uz = rz ? -__ldg(&tile.uz[c_idx]) : __ldg(&tile.uz[c_idx]);
        s.p = __ldg(&tile.p[c_idx]);
        s.E = (RealType)0.0;
        s.peak_overpressure = (RealType)0.0;
        s.peak_impulse = (RealType)0.0;
        if constexpr (IsMultiMaterial) {
            s.alpha1 = __ldg(&tile.alpha1[c_idx]);
            s.alpha2 = __ldg(&tile.alpha2[c_idx]);
            s.arho1 = __ldg(&tile.arho1[c_idx]);
            s.arho2 = __ldg(&tile.arho2[c_idx]);
        }
    }

    // Bottom floor hydrostatic well-balancing under gravity
    if (orig_gz < 0 && d_stratParams.enabled) {
        RealType g_mag = (RealType)fabs((double)d_stratParams.gravity_z);
        if (g_mag > (RealType)1e-6) {
            RealType dist_z = (RealType)(gz - orig_gz) * (RealType)d_cellSize;
            s.p += s.rho * g_mag * dist_z;
            RealType z_c = (RealType)d_zmin + ((RealType)orig_gz + (RealType)0.5) * (RealType)d_cellSize;
            if (is_cell_soil(s.rho, z_c)) {
                RealType gamma_soil = (RealType)(d_stratParams.soil_gamma > 0.0 ? d_stratParams.soil_gamma : 4.0);
                RealType rho0_soil = (RealType)(d_stratParams.soil_density > 0.0 ? d_stratParams.soil_density : 2000.0);
                RealType c0_soil = (RealType)(d_stratParams.soil_c0 > 0.0 ? d_stratParams.soil_c0 : 2500.0);
                RealType B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
                RealType p0_soil = (RealType)d_stratParams.p_atm;
                s.rho = (RealType)Blast::TaitEOSWater::compute_density_isentropic(
                    (double)s.p, (double)B_soil, (double)gamma_soil, (double)rho0_soil, (double)p0_soil);
                RealType e_soil = (RealType)Blast::TaitEOSWater::compute_energy_isentropic(
                    (double)s.rho, (double)B_soil, (double)gamma_soil, (double)rho0_soil);
                RealType ke_r = (RealType)0.5 * s.rho * (s.ux * s.ux + s.uy * s.uy + s.uz * s.uz);
                s.E = s.rho * e_soil + ke_r;
            } else if (d_isWater || d_stratParams.enabled) {
                s.rho = (RealType)Blast::TaitEOSWater::compute_density_isentropic(
                    (double)s.p, d_taitParams.B, d_taitParams.gamma,
                    (double)s.rho, d_taitParams.p0);
                RealType e_w = (RealType)Blast::TaitEOSWater::compute_energy_dispatcher((double)s.rho, (double)s.p, d_taitParams);
                RealType ke_r = (RealType)0.5 * s.rho * (s.ux * s.ux + s.uy * s.uy + s.uz * s.uz);
                s.E = s.rho * e_w + ke_r;
            } else {
                RealType gm1 = (RealType)d_gamma - (RealType)1.0;
                RealType ke_r = (RealType)0.5 * s.rho * (s.ux * s.ux + s.uy * s.uy + s.uz * s.uz);
                s.E = s.p / gm1 + ke_r;
            }
        }
    }

    // Top boundary hydrostatic pressure profile under gravity
    if (orig_gz >= d_nz && d_stratParams.enabled) {
        RealType dist_z = (RealType)(orig_gz - gz) * (RealType)d_cellSize;
        s.p = fmax((RealType)100.0, s.p + s.rho * (RealType)d_gravity_z * dist_z);
        RealType z_c = (RealType)d_zmin + ((RealType)orig_gz + (RealType)0.5) * (RealType)d_cellSize;
        RealType ke_r = (RealType)0.5 * s.rho * (s.ux * s.ux + s.uy * s.uy + s.uz * s.uz);
        if (is_cell_soil(s.rho, z_c)) {
            RealType gamma_soil = (RealType)(d_stratParams.soil_gamma > 0.0 ? d_stratParams.soil_gamma : 4.0);
            RealType rho0_soil = (RealType)(d_stratParams.soil_density > 0.0 ? d_stratParams.soil_density : 2000.0);
            RealType c0_soil = (RealType)(d_stratParams.soil_c0 > 0.0 ? d_stratParams.soil_c0 : 2500.0);
            RealType B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
            RealType p0_soil = (RealType)d_stratParams.p_atm;
            s.rho = (RealType)Blast::TaitEOSWater::compute_density_isentropic(
                (double)s.p, (double)B_soil, (double)gamma_soil, (double)rho0_soil, (double)p0_soil);
            RealType e_soil = (RealType)Blast::TaitEOSWater::compute_energy_isentropic(
                (double)s.rho, (double)B_soil, (double)gamma_soil, (double)rho0_soil);
            s.E = s.rho * e_soil + ke_r;
        } else if (d_isWater || (d_stratParams.enabled && z_c <= (RealType)d_stratParams.water_surface_z)) {
            s.rho = (RealType)Blast::TaitEOSWater::compute_density_isentropic(
                (double)s.p, d_taitParams.B, d_taitParams.gamma,
                (double)s.rho, d_taitParams.p0);
            RealType e_w = (RealType)Blast::TaitEOSWater::compute_energy_dispatcher((double)s.rho, (double)s.p, d_taitParams);
            s.E = s.rho * e_w + ke_r;
        } else {
            RealType gm1 = (RealType)d_gamma - (RealType)1.0;
            s.E = s.p / gm1 + ke_r;
        }
    }

    // Non-reflecting characteristic Riemann boundary condition (OUTFLOW_RIEMANN)
    bool is_riemann = (orig_gx < 0 && d_bcXmin == 2) ||
                      (orig_gx >= d_nx && d_bcXmax == 2) ||
                      (orig_gy < 0 && d_bcYmin == 2) ||
                      (orig_gy >= d_ny && d_bcYmax == 2) ||
                      (orig_gz < 0 && d_bcZmin == 2) ||
                      (orig_gz >= d_nz && d_bcZmax == 2);

    if (is_riemann) {
        RealType nx_out = (RealType)0.0, ny_out = (RealType)0.0, nz_out = (RealType)0.0;
        if (orig_gx < 0 && d_bcXmin == 2) nx_out = (RealType)-1.0;
        else if (orig_gx >= d_nx && d_bcXmax == 2) nx_out = (RealType)1.0;
        else if (orig_gy < 0 && d_bcYmin == 2) ny_out = (RealType)-1.0;
        else if (orig_gy >= d_ny && d_bcYmax == 2) ny_out = (RealType)1.0;
        else if (orig_gz < 0 && d_bcZmin == 2) nz_out = (RealType)-1.0;
        else if (orig_gz >= d_nz && d_bcZmax == 2) nz_out = (RealType)1.0;

        RealType un_int = s.ux * nx_out + s.uy * ny_out + s.uz * nz_out;

        RealType p_target = (RealType)d_ambient_p;
        RealType rho_target = (RealType)d_ambient_rho;
        RealType p_hydro_int = (RealType)d_ambient_p;
        bool is_water_target = d_isWater;
        bool is_soil_target = false;

        if (d_stratParams.enabled) {
            RealType z_c = (RealType)d_zmin + ((RealType)orig_gz + (RealType)0.5) * (RealType)d_cellSize;
            RealType z_int = (RealType)d_zmin + ((RealType)gz + (RealType)0.5) * (RealType)d_cellSize;
            double g_mag = fabs((double)d_stratParams.gravity_z);
            if (g_mag < 1e-6) g_mag = 9.81;

            auto eval_hydro = [&](RealType z_eval, RealType& p_out, RealType& rho_out, bool& is_w, bool& is_s) {
                if (z_eval > (RealType)d_stratParams.water_surface_z) {
                    double z_air_depth = (double)(z_eval - (RealType)d_stratParams.water_surface_z);
                    p_out = (RealType)(d_stratParams.p_atm - d_stratParams.air_rho * g_mag * z_air_depth);
                    rho_out = (RealType)d_stratParams.air_rho;
                    is_w = false; is_s = false;
                } else if (z_eval >= (RealType)d_stratParams.seabed_surface_z) {
                    double p_h = 0.0, rho_h = 0.0, e_h = 0.0;
                    Blast::TaitEOSWater::compute_hydrostatic_state(
                        (double)z_eval, (double)d_stratParams.water_surface_z, g_mag, (double)d_stratParams.p_atm,
                        p_h, rho_h, e_h, (double)d_stratParams.tait_B, (double)d_stratParams.tait_gamma, (double)d_stratParams.tait_rho0
                    );
                    p_out = (RealType)p_h;
                    rho_out = (RealType)rho_h;
                    is_w = true; is_s = false;
                } else {
                    double p_bed = 0.0, rho_bed = 0.0, e_bed = 0.0;
                    Blast::TaitEOSWater::compute_hydrostatic_state(
                        (double)d_stratParams.seabed_surface_z, (double)d_stratParams.water_surface_z, g_mag, (double)d_stratParams.p_atm,
                        p_bed, rho_bed, e_bed, (double)d_stratParams.tait_B, (double)d_stratParams.tait_gamma, (double)d_stratParams.tait_rho0
                    );
                    double sig_v = 0.0, u_p = 0.0, sig_h = 0.0;
                    Blast::TaitEOSWater::compute_geostatic_stress(
                        (double)z_eval, (double)d_stratParams.seabed_surface_z, p_bed, (double)d_stratParams.soil_density, (double)d_stratParams.tait_rho0, g_mag, (double)d_stratParams.k0_earth_pressure,
                        sig_v, u_p, sig_h
                    );
                    p_out = (RealType)sig_v;
                    double gamma_soil = d_stratParams.soil_gamma > 0.0 ? d_stratParams.soil_gamma : 4.0;
                    double rho0_soil = d_stratParams.soil_density > 0.0 ? d_stratParams.soil_density : 2000.0;
                    double c0_soil = d_stratParams.soil_c0 > 0.0 ? d_stratParams.soil_c0 : 2500.0;
                    double B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
                    double p0_soil = d_stratParams.p_atm;
                    rho_out = (RealType)Blast::TaitEOSWater::compute_density_isentropic(
                        (double)sig_v, B_soil, gamma_soil, rho0_soil, p0_soil);
                    is_s = true; is_w = false;
                }
            };

            bool dummy_w, dummy_s;
            eval_hydro(z_c, p_target, rho_target, is_water_target, is_soil_target);
            eval_hydro(z_int, p_hydro_int, rho_target, dummy_w, dummy_s);
        }

        if (is_soil_target) {
            RealType gamma_soil = (RealType)(d_stratParams.soil_gamma > 0.0 ? d_stratParams.soil_gamma : 4.0);
            RealType rho0_soil = (RealType)(d_stratParams.soil_density > 0.0 ? d_stratParams.soil_density : 2000.0);
            RealType c0_soil = (RealType)(d_stratParams.soil_c0 > 0.0 ? d_stratParams.soil_c0 : 2500.0);
            RealType B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
            RealType p0_soil = (RealType)d_stratParams.p_atm;
            RealType p_cav_soil = (RealType)(d_stratParams.soil_p_cav != 0.0 ? d_stratParams.soil_p_cav : -1.0e5);

            RealType c_soil = (RealType)Blast::TaitEOSWater::compute_sound_speed_isentropic(
                (double)s.rho, (double)B_soil, (double)gamma_soil, (double)rho0_soil);
            RealType Z = s.rho * c_soil;
            if (Z < (RealType)1.0e-3) Z = (RealType)(rho0_soil * c0_soil);

            RealType p_pert_int = s.p - p_hydro_int;
            RealType un_ghost;
            RealType p_ghost;
            if (fabs(un_int) < (RealType)0.05 && fabs(p_pert_int) < (RealType)1.0e4) {
                un_ghost = (RealType)0.0;
                p_ghost = p_target;
            } else {
                un_ghost = (RealType)0.5 * (un_int + p_pert_int / Z);
                p_ghost = p_target + (RealType)0.5 * (p_pert_int + Z * un_int);
                if (p_ghost < p_cav_soil) p_ghost = p_cav_soil;
            }

            RealType rho_ghost = (RealType)Blast::TaitEOSWater::compute_density_isentropic(
                (double)p_ghost, (double)B_soil, (double)gamma_soil, (double)rho0_soil, (double)p0_soil);

            s.ux += (un_ghost - un_int) * nx_out;
            s.uy += (un_ghost - un_int) * ny_out;
            s.uz += (un_ghost - un_int) * nz_out;
            s.p = p_ghost;
            s.rho = rho_ghost;

            RealType e_soil = (RealType)Blast::TaitEOSWater::compute_energy_isentropic(
                (double)rho_ghost, (double)B_soil, (double)gamma_soil, (double)rho0_soil);
            RealType ke_r = (RealType)0.5 * s.rho * (s.ux * s.ux + s.uy * s.uy + s.uz * s.uz);
            s.E = rho_ghost * e_soil + ke_r;
        } else if (is_water_target || d_isWater) {
            RealType c_w = (RealType)Blast::TaitEOSWater::compute_sound_speed_dispatcher(
                (double)s.rho, (double)s.p, d_taitParams, 0.0);
            RealType Z = s.rho * c_w;
            if (Z < (RealType)1.0e-3) Z = (RealType)(1.0e3 * 1482.0);

            RealType p_pert_int = s.p - p_hydro_int;
            RealType un_ghost = (RealType)0.5 * (un_int + p_pert_int / Z);
            RealType p_ghost = p_target + (RealType)0.5 * (p_pert_int + Z * un_int);
            if (p_ghost < (RealType)d_taitParams.p_cav) p_ghost = (RealType)d_taitParams.p_cav;

            RealType rho_ghost = (RealType)Blast::TaitEOSWater::compute_density_isentropic(
                (double)p_ghost, d_taitParams.B, d_taitParams.gamma,
                (double)rho_target, d_taitParams.p0);

            s.ux += (un_ghost - un_int) * nx_out;
            s.uy += (un_ghost - un_int) * ny_out;
            s.uz += (un_ghost - un_int) * nz_out;
            s.p = p_ghost;
            s.rho = rho_ghost;

            RealType e_w = (RealType)Blast::TaitEOSWater::compute_energy_dispatcher((double)rho_ghost, (double)p_ghost, d_taitParams);
            RealType ke_r = (RealType)0.5 * s.rho * (s.ux * s.ux + s.uy * s.uy + s.uz * s.uz);
            s.E = rho_ghost * e_w + ke_r;
        } else {
            RealType gm1 = (RealType)d_gamma - (RealType)1.0;
            RealType c_int = sqrt((RealType)d_gamma * s.p / fmax((RealType)1e-6, s.rho));
            RealType c_atm = sqrt((RealType)d_gamma * p_target / fmax((RealType)1e-6, rho_target));

            RealType R_plus = un_int + (RealType)2.0 * c_int / gm1;
            RealType R_minus = -(RealType)2.0 * c_atm / gm1;
            RealType un_ghost = (RealType)0.5 * (R_plus + R_minus);
            RealType c_ghost = max((RealType)0.1, (RealType)0.25 * gm1 * (R_plus - R_minus));

            RealType c_ratio = c_ghost / c_atm;
            RealType rho_ghost = rho_target * pow(c_ratio, (RealType)2.0 / gm1);
            RealType p_ghost = p_target * pow(c_ratio, (RealType)2.0 * (RealType)d_gamma / gm1);

            s.ux += (un_ghost - un_int) * nx_out;
            s.uy += (un_ghost - un_int) * ny_out;
            s.uz += (un_ghost - un_int) * nz_out;
            s.p = p_ghost;
            s.rho = rho_ghost;

            RealType ke_r = (RealType)0.5 * s.rho * (s.ux * s.ux + s.uy * s.uy + s.uz * s.uz);
            s.E = p_ghost / gm1 + ke_r;
        }
    }
    return s;
}


static __device__ inline bool get_solid_normal_gpu(const GeometryTile3D* geom, int i, int j, int k, float& nx_b, float& ny_b, float& nz_b) {
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
__device__ void getRusanovFluxGPU(const GPUCellStateT<RealType, IsMultiMaterial>& sL, const GPUCellStateT<RealType, IsMultiMaterial>& sR, RealType* flux, int dir, RealType gamma, RealType z_cL = (RealType)0.0, RealType z_cR = (RealType)0.0) {
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

    RealType cL = computeCellSoundSpeedGPU<RealType, IsMultiMaterial>(sL, z_cL, gamma);
    RealType cR = computeCellSoundSpeedGPU<RealType, IsMultiMaterial>(sR, z_cR, gamma);
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
__device__ void getAUSMPlusFluxGPU(const GPUCellStateT<RealType, IsMultiMaterial>& sL, const GPUCellStateT<RealType, IsMultiMaterial>& sR, RealType* flux, int dir, RealType gamma, RealType z_cL = (RealType)0.0, RealType z_cR = (RealType)0.0) {
    RealType aL = computeCellSoundSpeedGPU<RealType, IsMultiMaterial>(sL, z_cL, gamma);
    RealType aR = computeCellSoundSpeedGPU<RealType, IsMultiMaterial>(sR, z_cR, gamma);
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
    
    // AUSM+-up stabilization terms to prevent carbuncle/cube artifacts with Liou (2006) shock cutoff
    RealType M_bar_sq = (sL.ux*sL.ux + sL.uy*sL.uy + sL.uz*sL.uz + sR.ux*sR.ux + sR.uy*sR.uy + sR.uz*sR.uz) / ((RealType)2.0 * a_half * a_half);
    RealType fa = (M_bar_sq < (RealType)1.0) ? ((RealType)1.0 - M_bar_sq) : (RealType)0.0;
    RealType rho_half = (RealType)0.5 * (sL.rho + sR.rho);

    // If large density gradient exists across face, use acoustic impedance weighting for pressure
    // to avoid transmitting hundreds of MPa into light fluids (e.g. air or cavitation bubbles)
    // 1.5 ratio captures seabed soil-to-water (2000 / 1025 = 1.95) and water-to-air (1025 / 1.225 = 837)
    bool is_large_density_jump = (sL.rho > (RealType)1.5 * sR.rho || sR.rho > (RealType)1.5 * sL.rho);
    if (is_large_density_jump) {
        RealType zL_ausm = fmax((RealType)1e-3, sL.rho * aL);
        RealType zR_ausm = fmax((RealType)1e-3, sR.rho * aR);
        rho_half = (RealType)2.0 * sL.rho * sR.rho / (sL.rho + sR.rho);
        p_half_unmod = (zR_ausm * sL.p + zL_ausm * sR.p) / (zL_ausm + zR_ausm);
    }

    // In spatial reconstruction (Order >= 2), sL and sR are reconstructed to the cell face.
    // In hydrostatic equilibrium, sL.p == sR.p == p_face, so sR.p - sL.p == 0.
    RealType dp_wave = sR.p - sL.p;

    RealType p_scale = d_isWater ? (RealType)fmax((RealType)1e5, (RealType)d_taitParams.B) : (d_stratParams.enabled ? (RealType)3.0e8 : fmin(sL.p, sR.p));
    RealType dp_rel = (p_scale > (RealType)1e-6) ? (fabs(dp_wave) / p_scale) : (RealType)0.0;
    RealType shock_sense = (dp_rel > (RealType)0.2) ? ((RealType)1.0 / ((RealType)1.0 + dp_rel * dp_rel)) : (RealType)1.0;
    RealType Kp = (RealType)0.25 * fa * shock_sense;
    RealType Ku = (RealType)0.75 * shock_sense;
    if (is_large_density_jump || (dir == 2 && d_has_gravity && fabs(uL) < (RealType)1.0e-3 && fabs(uR) < (RealType)1.0e-3)) {
        Kp = (RealType)0.0;
        if (is_large_density_jump) Ku = (RealType)0.0;
    }
    
    RealType M_half = M_half_unmod - Kp * dp_wave / max((RealType)1e-6, rho_half * a_half * a_half);
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

template <typename RealType, bool IsMultiMaterial>
__device__ void getMaterialInterfaceFluxGPU(
    const GPUCellStateT<RealType, IsMultiMaterial>& sL,
    const GPUCellStateT<RealType, IsMultiMaterial>& sR,
    RealType* flux, int dir, RealType gamma,
    RealType z_cL = (RealType)0.0, RealType z_cR = (RealType)0.0
) {
    RealType unL = (dir == 0) ? sL.ux : (dir == 1 ? sL.uy : sL.uz);
    RealType unR = (dir == 0) ? sR.ux : (dir == 1 ? sR.uy : sR.uz);

    RealType cL = computeCellSoundSpeedGPU<RealType, IsMultiMaterial>(sL, z_cL, gamma);
    RealType cR = computeCellSoundSpeedGPU<RealType, IsMultiMaterial>(sR, z_cR, gamma);

    RealType zL = fmax((RealType)1e-3, sL.rho * cL);
    RealType zR = fmax((RealType)1e-3, sR.rho * cR);

    bool sL_soil = is_cell_soil(sL.rho, z_cL);
    bool sR_soil = is_cell_soil(sR.rho, z_cR);

    // In reconstruct_channel (MUSCL/WENO), sL.p and sR.p are already reconstructed to the cell face.
    RealType pL_face = sL.p;
    RealType pR_face = sR.p;

    // Exact acoustic Riemann contact solution for interface normal velocity & pressure
    RealType u_star = (zL * unL + zR * unR + (pL_face - pR_face)) / (zL + zR);
    RealType p_star = (zR * pL_face + zL * pR_face - zL * zR * (unR - unL)) / (zL + zR);

    bool is_water_L = false;
    bool is_water_R = false;
    if constexpr (IsMultiMaterial) {
        is_water_L = is_cell_water(sL.rho, z_cL, sL.alpha1 + sL.alpha2);
        is_water_R = is_cell_water(sR.rho, z_cR, sR.alpha1 + sR.alpha2);
    } else {
        is_water_L = is_cell_water(sL.rho, z_cL);
        is_water_R = is_cell_water(sR.rho, z_cR);
    }

    RealType p_floor = (sL_soil && sR_soil) ? (RealType)(d_stratParams.soil_p_cav != 0.0 ? d_stratParams.soil_p_cav : -1.0e5) :
                       ((is_water_L && is_water_R) ? (RealType)d_taitParams.p_cav : (RealType)1e-4);
    p_star = fmax(p_floor, p_star);

    // Deadband for tiny numerical noise in hydrostatic equilibrium
    if (fabs(u_star) < (RealType)1e-5) {
        u_star = (RealType)0.0;
    }

    // Upwind state selection based on contact wave velocity u_star
    const auto& s_up = (u_star >= (RealType)0.0) ? sL : sR;

    flux[0] = s_up.rho * u_star;
    flux[1] = s_up.rho * u_star * s_up.ux + (dir == 0 ? p_star : (RealType)0.0);
    flux[2] = s_up.rho * u_star * s_up.uy + (dir == 1 ? p_star : (RealType)0.0);
    flux[3] = s_up.rho * u_star * s_up.uz + (dir == 2 ? p_star : (RealType)0.0);
    flux[4] = u_star * (s_up.E + p_star);

    if constexpr (IsMultiMaterial) {
        flux[5] = s_up.alpha1 * u_star;
        flux[6] = s_up.alpha2 * u_star;
        flux[7] = s_up.arho1 * u_star;
        flux[8] = s_up.arho2 * u_star;
    }
    flux[9] = u_star;
}

template <typename RealType>
__device__ __forceinline__ RealType minmod_gpu(RealType a, RealType b) {
    RealType min_val = (fabs(a) < fabs(b)) ? a : b;
    return (a * b > (RealType)0.0) ? min_val : (RealType)0.0;
}


template <typename RealType>
__device__ RealType weno3_gpu(RealType vM1, RealType v0, RealType vP1) {
    RealType d0 = v0 - vM1;
    RealType d1 = vP1 - v0;
    
    RealType beta0 = d0 * d0;
    RealType beta1 = d1 * d1;

    RealType beta_scale = fmax(beta0, beta1);
    if (beta_scale > (RealType)1e-12) {
        RealType inv_scale = (RealType)1.0 / beta_scale;
        beta0 *= inv_scale;
        beta1 *= inv_scale;
    }
    
    RealType eps = (RealType)1e-6;
    RealType alpha0 = ((RealType)1.0 / (RealType)3.0) / ((eps + beta0) * (eps + beta0));
    RealType alpha1 = ((RealType)2.0 / (RealType)3.0) / ((eps + beta1) * (eps + beta1));
    
    RealType sum_alpha = alpha0 + alpha1;
    RealType w0 = (RealType)0.5;
    RealType w1 = (RealType)0.5;
    if (sum_alpha > (RealType)1e-20) {
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
template <typename RealType, bool IsMultiMaterial, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ __forceinline__ GPUCellStateT<RealType, IsMultiMaterial> sample_gpu(
    const TileType* states,
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
        return sample_gpu_raw<RealType, IsMultiMaterial, TileType>(states, target_x, target_y, target_z);
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

    // Topological Corner Detection (Thin-Shell & Coplanar Invariant):
    // Count solid cells and coplanar neighbors in 3x3x3 neighborhood of boundary cell bx, by, bz
    int solid_count = 0;
    int coplanar_count = 0;
    for (int sz = -1; sz <= 1; ++sz) {
        int nz_val = bz + sz;
        for (int sy = -1; sy <= 1; ++sy) {
            int ny_val = by + sy;
            for (int sx = -1; sx <= 1; ++sx) {
                if (sx == 0 && sy == 0 && sz == 0) continue;
                int nx_val = bx + sx;
                bool is_solid = false;
                if (nx_val >= 0 && nx_val < d_nx && ny_val >= 0 && ny_val < d_ny && nz_val >= 0 && nz_val < d_nz) {
                    is_solid = is_solid_cell_gpu(geom, nx_val, ny_val, nz_val);
                } else {
                    is_solid = true; // Treat out of bounds as solid
                }
                if (is_solid) {
                    solid_count++;
                    float dot_n = (float)sx * nx_true + (float)sy * ny_true + (float)sz * nz_true;
                    if (fabsf(dot_n) <= 0.707f) {
                        coplanar_count++;
                    }
                }
            }
        }
    }
    bool is_convex_corner;
    if (solid_count <= 10) {
        // Thin-shell regime: flat 3x3 sheet has ~8 coplanar solid neighbors. A true corner/tip has < 4.
        is_convex_corner = (coplanar_count < 4);
    } else {
        // Volumetric solid regime:
        is_convex_corner = (solid_count <= 14);
    }

    // Decouple normal for velocity reflection and corner clipping at convex corners:
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
    float n_len_dec = sqrtf(nx_dec * nx_dec + ny_dec * ny_dec + nz_dec * nz_dec);
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

    // Adaptive normal selection for projection (sampling):
    // Use true normal for flat/diagonal walls; use decoupled normal for convex corners/edges
    float nx_reflect = is_convex_corner ? nx_dec : nx_true;
    float ny_reflect = is_convex_corner ? ny_dec : ny_true;
    float nz_reflect = is_convex_corner ? nz_dec : nz_true;

    float nx_proj = nx_reflect;
    float ny_proj = ny_reflect;
    float nz_proj = nz_reflect;
    
    // Gap-adaptive projection distance:
    // Determine clearance in the fluid direction to prevent the image point from hitting opposing walls
    float d_clearance = 1.5f;
    for (int step = 1; step <= 2; ++step) {
        int step_x = qx + (int)roundf(nx_proj * (float)step);
        int step_y = qy + (int)roundf(ny_proj * (float)step);
        int step_z = qz + (int)roundf(nz_proj * (float)step);
        if (step_x >= 0 && step_x < d_nx && step_y >= 0 && step_y < d_ny && step_z >= 0 && step_z < d_nz) {
            if (is_solid_cell_gpu(geom, step_x, step_y, step_z)) {
                d_clearance = fminf(d_clearance, (float)step * 0.5f);
                break;
            }
        }
    }
    float proj_dist = is_convex_corner ? 0.5f : fmaxf(0.5f, d_clearance);
    
    // Project along the adaptive normal:
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

                // Topological Line-of-Sight Barrier: prevent diagonal cross-wall tunneling
                int tc_dist = (i != 0 ? 1 : 0) + (j != 0 ? 1 : 0) + (k != 0 ? 1 : 0);
                if (tc_dist == 2) {
                    if (i != 0 && j != 0) {
                        if (is_solid_cell_gpu(geom, qx + i, qy, qz) && is_solid_cell_gpu(geom, qx, qy + j, qz)) continue;
                    } else if (i != 0 && k != 0) {
                        if (is_solid_cell_gpu(geom, qx + i, qy, qz) && is_solid_cell_gpu(geom, qx, qy, qz + k)) continue;
                    } else if (j != 0 && k != 0) {
                        if (is_solid_cell_gpu(geom, qx, qy + j, qz) && is_solid_cell_gpu(geom, qx, qy, qz + k)) continue;
                    }
                } else if (tc_dist == 3) {
                    bool b_x = is_solid_cell_gpu(geom, qx + i, qy, qz);
                    bool b_y = is_solid_cell_gpu(geom, qx, qy + j, qz);
                    bool b_z = is_solid_cell_gpu(geom, qx, qy, qz + k);
                    if ((b_x && b_y) || (b_x && b_z) || (b_y && b_z)) continue;
                }
                
                // Visibility Half-Space Clipping using the true surface normal
                float dx_plane = (float)nx_val - (float)target_x;
                float dy_plane = (float)ny_val - (float)target_y;
                float dz_plane = (float)nz_val - (float)target_z;
                float dot_plane = dx_plane * nx_proj + dy_plane * ny_proj + dz_plane * nz_proj;
                if (dot_plane < -1e-4f) continue;

                float dx_n = (float)nx_val - p_img_x;
                float dy_n = (float)ny_val - p_img_y;
                float dz_n = (float)nz_val - p_img_z;
                float dist2 = dx_n*dx_n + dy_n*dy_n + dz_n*dz_n;
                float w = 1.0f / (dist2 + 1e-6f);
                
                auto s_neighbor = sample_gpu_raw<RealType, IsMultiMaterial, TileType>(states, nx_val, ny_val, nz_val);
                
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
        s_ghost = sample_gpu_raw<RealType, IsMultiMaterial, TileType>(states, qx, qy, qz);
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
    
    // ALWAYS reflect velocity across the TRUE surface normal to ensure smooth slip flow
    float vw_x = 0.0f, vw_y = 0.0f, vw_z = 0.0f;
    if (geom) {
        auto s_solid = sample_gpu_raw<RealType, IsMultiMaterial, TileType>(states, target_x, target_y, target_z);
        vw_x = (float)s_solid.ux;
        vw_y = (float)s_solid.uy;
        vw_z = (float)s_solid.uz;
    }

    float solid_frac = 1.0f;
    if (geom) {
        int cx = target_x < 0 ? 0 : (target_x >= d_nx ? d_nx - 1 : target_x);
        int cy = target_y < 0 ? 0 : (target_y >= d_ny ? d_ny - 1 : target_y);
        int cz = target_z < 0 ? 0 : (target_z >= d_nz ? d_nz - 1 : target_z);
        int ntx_dim = (d_nx + 7) >> 3;
        int nty_dim = (d_ny + 7) >> 3;
        int t_b = (cx >> 3) + (cy >> 3) * ntx_dim + (cz >> 3) * ntx_dim * nty_dim;
        int c_b = (cx & 7) + (cy & 7) * 8 + (cz & 7) * 64;
        bool b_flag; float nx_d, ny_d, nz_d;
        unpack_geometry_payload(geom[t_b].cells[c_b], b_flag, nx_d, ny_d, nz_d, solid_frac);
        if (!b_flag) solid_frac = 0.0f;
    }

    float u_rel_x = (float)s_ghost.ux - vw_x;
    float u_rel_y = (float)s_ghost.uy - vw_y;
    float u_rel_z = (float)s_ghost.uz - vw_z;

    float u_dot_n = u_rel_x * nx_proj + u_rel_y * ny_proj + u_rel_z * nz_proj;
    float u_refl_x = vw_x + u_rel_x - 2.0f * u_dot_n * nx_proj;
    float u_refl_y = vw_y + u_rel_y - 2.0f * u_dot_n * ny_proj;
    float u_refl_z = vw_z + u_rel_z - 2.0f * u_dot_n * nz_proj;

    // Smoothly blend wall reflection with ambient/neighbor fluid velocity by solid_frac
    s_ghost.ux = (RealType)(solid_frac * u_refl_x + (1.0f - solid_frac) * (float)s_ghost.ux);
    s_ghost.uy = (RealType)(solid_frac * u_refl_y + (1.0f - solid_frac) * (float)s_ghost.uy);
    s_ghost.uz = (RealType)(solid_frac * u_refl_z + (1.0f - solid_frac) * (float)s_ghost.uz);
    
    RealType ke = (RealType)0.5 * s_ghost.rho * (s_ghost.ux * s_ghost.ux + s_ghost.uy * s_ghost.uy + s_ghost.uz * s_ghost.uz);
    RealType z_c = (RealType)d_zmin + ((RealType)target_z + (RealType)0.5) * (RealType)d_cellSize;
    if constexpr (IsMultiMaterial) {
        if (is_cell_water(s_ghost.rho, z_c, s_ghost.alpha1 + s_ghost.alpha2)) {
            s_ghost.E = MultiMat::getMixtureEnergyTait<RealType>(s_ghost.p, s_ghost.rho, s_ghost.alpha1, s_ghost.alpha2, s_ghost.arho1, s_ghost.arho2, d_taitParams, d_products, d_unreacted) + ke;
        } else if (is_cell_soil(s_ghost.rho, z_c)) {
            s_ghost.E = computeFluidEnergyGPU<RealType>(s_ghost.p, s_ghost.rho, (RealType)d_gamma, z_c) + ke;
        } else {
            s_ghost.E = MultiMat::getMixtureEnergy<RealType>(s_ghost.p, s_ghost.rho, s_ghost.alpha1, s_ghost.alpha2, s_ghost.arho1, s_ghost.arho2, (RealType)d_gamma, d_products, d_unreacted) + ke;
        }
    } else {
        s_ghost.E = computeFluidEnergyGPU<RealType>(s_ghost.p, s_ghost.rho, (RealType)d_gamma, z_c) + ke;
    }
    
    return s_ghost;
}

template <typename RealType, bool IsMultiMaterial, int SpatialOrder, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ __noinline__ void reconstruct_gpu(
    const TileType* states,
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

    GPUCellStateT<RealType, IsMultiMaterial> sM1 = sample_gpu<RealType, IsMultiMaterial, TileType>(states, geom, gx - dx, gy - dy, gz - dz, qx, qy, qz, dir, is_near_boundary);
    GPUCellStateT<RealType, IsMultiMaterial> sP0 = sample_gpu<RealType, IsMultiMaterial, TileType>(states, geom, gx, gy, gz, qx, qy, qz, dir, is_near_boundary);

    GPUCellStateT<RealType, IsMultiMaterial> sM2 = sample_gpu<RealType, IsMultiMaterial, TileType>(states, geom, gx - 2*dx, gy - 2*dy, gz - 2*dz, qx, qy, qz, dir, is_near_boundary);
    GPUCellStateT<RealType, IsMultiMaterial> sP1 = sample_gpu<RealType, IsMultiMaterial, TileType>(states, geom, gx + dx, gy + dy, gz + dz, qx, qy, qz, dir, is_near_boundary);

    RealType z_cM2 = (RealType)d_zmin + ((RealType)(gz - 2*dz) + (RealType)0.5) * (RealType)d_cellSize;
    RealType z_cL  = (RealType)d_zmin + ((RealType)(gz - dz)   + (RealType)0.5) * (RealType)d_cellSize;
    RealType z_cR  = (RealType)d_zmin + ((RealType)gz          + (RealType)0.5) * (RealType)d_cellSize;
    RealType z_cP1 = (RealType)d_zmin + ((RealType)(gz + dz)   + (RealType)0.5) * (RealType)d_cellSize;

    auto get_mat = [&](RealType rho, RealType z, RealType alpha) -> int {
        if (!d_stratParams.enabled) return 0;
        if (alpha > (RealType)0.02) return 3; // Energetic detonation products / gas plume
        if (is_cell_soil(rho, z)) return 2;
        if (is_cell_water(rho, z, alpha)) return 1;
        return 0; // Air
    };

    int matM2 = 0, matM1 = 0, matP0 = 0, matP1 = 0;
    if constexpr (IsMultiMaterial) {
        matM2 = get_mat(sM2.rho, z_cM2, sM2.alpha1 + sM2.alpha2);
        matM1 = get_mat(sM1.rho, z_cL,  sM1.alpha1 + sM1.alpha2);
        matP0 = get_mat(sP0.rho, z_cR,  sP0.alpha1 + sP0.alpha2);
        matP1 = get_mat(sP1.rho, z_cP1, sP1.alpha1 + sP1.alpha2);
    } else {
        matM2 = get_mat(sM2.rho, z_cM2, (RealType)0.0);
        matM1 = get_mat(sM1.rho, z_cL,  (RealType)0.0);
        matP0 = get_mat(sP0.rho, z_cR,  (RealType)0.0);
        matP1 = get_mat(sP1.rho, z_cP1, (RealType)0.0);
    }

    bool is_mat_interface = (matM1 != matP0);
    bool same_mat_L = (matM2 == matM1);
    bool same_mat_R = (matP1 == matP0);

    auto reconstruct_channel = [&](RealType vM2, RealType vM1, RealType vP0, RealType vP1, RealType& vL, RealType& vR, bool is_pressure = false) {
        if (is_mat_interface) {
            if (is_pressure && dir == 2 && d_has_gravity) {
                vL = vM1 + (RealType)0.5 * sM1.rho * (RealType)d_gravity_z * (RealType)d_cellSize;
                vR = vP0 - (RealType)0.5 * sP0.rho * (RealType)d_gravity_z * (RealType)d_cellSize;
            } else {
                RealType dL = vM1 - vM2;
                vL = (same_mat_L && SpatialOrder > 1 && !force_first_order_L) ? (vM1 + (RealType)0.5 * minmod_gpu(dL, dL)) : vM1;
                RealType dR = vP1 - vP0;
                vR = (same_mat_R && SpatialOrder > 1 && !force_first_order_R) ? (vP0 - (RealType)0.5 * minmod_gpu(dR, dR)) : vP0;
            }
        } else if (force_first_order_L || force_first_order_R) {
            vL = vM1;
            vR = vP0;
        } else if constexpr (SpatialOrder == 1) {
            vL = vM1;
            vR = vP0;
        } else {
            RealType dC = vP0 - vM1;
            RealType dL = same_mat_L ? (vM1 - vM2) : dC;
            RealType dR = same_mat_R ? (vP1 - vP0) : dC;

            if constexpr (SpatialOrder == 3) {
                vL = same_mat_L ? weno3_gpu(vM2, vM1, vP0) : (vM1 + (RealType)0.5 * minmod_gpu(dL, dC));
                vR = same_mat_R ? weno3_gpu(vP1, vP0, vM1) : (vP0 - (RealType)0.5 * minmod_gpu(dC, dR));
            } else { // Order 2 or default
                vL = vM1 + (RealType)0.5 * minmod_gpu(dL, dC);
                vR = vP0 - (RealType)0.5 * minmod_gpu(dC, dR);
            }
        }
    };

    reconstruct_channel(sM2.rho, sM1.rho, sP0.rho, sP1.rho, sL.rho, sR.rho);
    sL.rho = fmax((RealType)1e-7, sL.rho);
    sR.rho = fmax((RealType)1e-7, sR.rho);
    reconstruct_channel(sM2.ux, sM1.ux, sP0.ux, sP1.ux, sL.ux, sR.ux);
    reconstruct_channel(sM2.uy, sM1.uy, sP0.uy, sP1.uy, sL.uy, sR.uy);
    reconstruct_channel(sM2.uz, sM1.uz, sP0.uz, sP1.uz, sL.uz, sR.uz);
    reconstruct_channel(sM2.p, sM1.p, sP0.p, sP1.p, sL.p, sR.p, true);
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

        RealType max_arho1_L = fmin(sL.rho, sL.alpha1 * (RealType)d_products.rho0);
        RealType max_arho2_L = fmin(sL.rho, sL.alpha2 * (RealType)d_unreacted.rho0);
        sL.arho1 = fmax((RealType)0.0, fmin(max_arho1_L, sL.arho1));
        sL.arho2 = fmax((RealType)0.0, fmin(max_arho2_L, sL.arho2));
        if (sL.alpha1 == (RealType)0.0) sL.arho1 = (RealType)0.0;
        if (sL.alpha2 == (RealType)0.0) sL.arho2 = (RealType)0.0;

        RealType max_arho1_R = fmin(sR.rho, sR.alpha1 * (RealType)d_products.rho0);
        RealType max_arho2_R = fmin(sR.rho, sR.alpha2 * (RealType)d_unreacted.rho0);
        sR.arho1 = fmax((RealType)0.0, fmin(max_arho1_R, sR.arho1));
        sR.arho2 = fmax((RealType)0.0, fmin(max_arho2_R, sR.arho2));
        if (sR.alpha1 == (RealType)0.0) sR.arho1 = (RealType)0.0;
        if (sR.alpha2 == (RealType)0.0) sR.arho2 = (RealType)0.0;
    }

    RealType keL = (RealType)0.5 * sL.rho * (sL.ux*sL.ux + sL.uy*sL.uy + sL.uz*sL.uz);
    RealType keR = (RealType)0.5 * sR.rho * (sR.ux*sR.ux + sR.uy*sR.uy + sR.uz*sR.uz);

    if constexpr (IsMultiMaterial) {
        if (is_cell_water(sL.rho, z_cL, sL.alpha1 + sL.alpha2)) {
            sL.E = MultiMat::getMixtureEnergyTait<RealType>(sL.p, sL.rho, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, d_taitParams, d_products, d_unreacted) + keL;
        } else if (is_cell_soil(sL.rho, z_cL)) {
            sL.E = computeFluidEnergyGPU<RealType>(sL.p, sL.rho, (RealType)d_gamma, z_cL) + keL;
        } else {
            sL.E = MultiMat::getMixtureEnergy<RealType>(sL.p, sL.rho, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, (RealType)d_gamma, d_products, d_unreacted) + keL;
        }
        if (is_cell_water(sR.rho, z_cR, sR.alpha1 + sR.alpha2)) {
            sR.E = MultiMat::getMixtureEnergyTait<RealType>(sR.p, sR.rho, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, d_taitParams, d_products, d_unreacted) + keR;
        } else if (is_cell_soil(sR.rho, z_cR)) {
            sR.E = computeFluidEnergyGPU<RealType>(sR.p, sR.rho, (RealType)d_gamma, z_cR) + keR;
        } else {
            sR.E = MultiMat::getMixtureEnergy<RealType>(sR.p, sR.rho, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, (RealType)d_gamma, d_products, d_unreacted) + keR;
        }
    } else {
        sL.E = computeFluidEnergyGPU<RealType>(sL.p, sL.rho, (RealType)d_gamma, z_cL) + keL;
        sR.E = computeFluidEnergyGPU<RealType>(sR.p, sR.rho, (RealType)d_gamma, z_cR) + keR;
    }
}

template <typename RealType, bool IsMultiMaterial, int SpatialOrder, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ __noinline__ void get_face_flux_gpu(
    const TileType* states,
    const GeometryTile3D* geom_pool,
    int gx_L, int gy_L, int gz_L,
    int gx_R, int gy_R, int gz_R,
    int dir, RealType* flx,
    int qx, int qy, int qz,
    bool is_near_boundary
) {
    bool solid_L = false;
    bool solid_R = false;
    if (is_near_boundary && geom_pool) {
        solid_L = is_solid_cell_gpu(geom_pool, gx_L, gy_L, gz_L);
        solid_R = is_solid_cell_gpu(geom_pool, gx_R, gy_R, gz_R);
    }

    if (solid_L && solid_R) {
        #pragma unroll
        for (int v = 0; v < 10; ++v) flx[v] = (RealType)0.0;
        return;
    }

    if (solid_L || solid_R) {
        // Physically correct inviscid slip-wall boundary flux.
        // For a stationary wall: zero mass/energy flux, pure pressure thrust in normal direction.
        // This eliminates the energy pump that occurred when ghost-state residual velocities
        // multiplied huge E_fluid values at shock fronts.
        GPUCellStateT<RealType, IsMultiMaterial> sL, sR;
        reconstruct_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(
            states, geom_pool, gx_R, gy_R, gz_R, dir, sL, sR, qx, qy, qz, is_near_boundary, true, true
        );

        const auto& s_fluid = solid_L ? sR : sL;
        RealType p_wall = s_fluid.p;

        // Static wall: vn_wall = 0 => mass flux = 0, energy flux = 0
        // Moving wall (FSI): sample raw solid velocity (identically zero for static walls)
        auto s_solid_raw = sample_gpu_raw<RealType, IsMultiMaterial, TileType>(
            states, solid_L ? gx_L : gx_R, solid_L ? gy_L : gy_R, solid_L ? gz_L : gz_R
        );
        RealType vn_wall = (dir == 0) ? s_solid_raw.ux : ((dir == 1) ? s_solid_raw.uy : s_solid_raw.uz);

        flx[0] = (RealType)0.0;                           // mass flux
        flx[1] = (dir == 0) ? p_wall : (RealType)0.0;     // x-momentum: pressure if x-face
        flx[2] = (dir == 1) ? p_wall : (RealType)0.0;     // y-momentum: pressure if y-face
        flx[3] = (dir == 2) ? p_wall : (RealType)0.0;     // z-momentum: pressure if z-face
        flx[4] = p_wall * vn_wall;                       // energy flux: p * vn_wall (work done by moving wall)

        flx[5] = (RealType)0.0;  // alpha1 transport
        flx[6] = (RealType)0.0;  // alpha2 transport
        flx[7] = (RealType)0.0;  // arho1 transport
        flx[8] = (RealType)0.0;  // arho2 transport
        flx[9] = (RealType)0.0;  // velocity divergence
        return;
    }

    bool force_first = false;
    if (is_near_boundary && geom_pool) {
        int dx = (dir == 0 ? 1 : 0);
        int dy = (dir == 1 ? 1 : 0);
        int dz = (dir == 2 ? 1 : 0);
        bool m2 = is_solid_cell_gpu(geom_pool, gx_L - dx, gy_L - dy, gz_L - dz);
        bool p1 = is_solid_cell_gpu(geom_pool, gx_R + dx, gy_R + dy, gz_R + dz);
        force_first = m2 || p1;
    }

    GPUCellStateT<RealType, IsMultiMaterial> sL, sR;
    reconstruct_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, geom_pool, gx_R, gy_R, gz_R, dir, sL, sR, qx, qy, qz, is_near_boundary, force_first, force_first);
    RealType z_cL = (RealType)d_zmin + ((RealType)gz_L + (RealType)0.5) * (RealType)d_cellSize;
    RealType z_cR = (RealType)d_zmin + ((RealType)gz_R + (RealType)0.5) * (RealType)d_cellSize;
    if (d_stratParams.enabled && dir == 2) {
        bool sL_soil = is_cell_soil(sL.rho, z_cL);
        bool sR_soil = is_cell_soil(sR.rho, z_cR);
        if (sL_soil != sR_soil) {
            getMaterialInterfaceFluxGPU<RealType, IsMultiMaterial>(sL, sR, flx, dir, (RealType)d_gamma, z_cL, z_cR);
            return;
        }
    }
    if (d_useAUSM) getAUSMPlusFluxGPU<RealType, IsMultiMaterial>(sL, sR, flx, dir, (RealType)d_gamma, z_cL, z_cR);
    else getRusanovFluxGPU<RealType, IsMultiMaterial>(sL, sR, flx, dir, (RealType)d_gamma, z_cL, z_cR);
}

template <typename RealType, bool IsMultiMaterial, int SpatialOrder, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ __noinline__ void reconstruct_interior_gpu(
    const TileType* states,
    int gx, int gy, int gz,
    int dir,
    GPUCellStateT<RealType, IsMultiMaterial>& sL, GPUCellStateT<RealType, IsMultiMaterial>& sR
) {
    int dx = (dir == 0 ? 1 : 0);
    int dy = (dir == 1 ? 1 : 0);
    int dz = (dir == 2 ? 1 : 0);

    GPUCellStateT<RealType, IsMultiMaterial> sM2 = sample_gpu_interior<RealType, IsMultiMaterial, TileType>(states, gx - 2*dx, gy - 2*dy, gz - 2*dz);
    GPUCellStateT<RealType, IsMultiMaterial> sM1 = sample_gpu_interior<RealType, IsMultiMaterial, TileType>(states, gx - dx, gy - dy, gz - dz);
    GPUCellStateT<RealType, IsMultiMaterial> sP0 = sample_gpu_interior<RealType, IsMultiMaterial, TileType>(states, gx, gy, gz);
    GPUCellStateT<RealType, IsMultiMaterial> sP1 = sample_gpu_interior<RealType, IsMultiMaterial, TileType>(states, gx + dx, gy + dy, gz + dz);

    RealType z_cM2 = (RealType)d_zmin + ((RealType)(gz - 2*dz) + (RealType)0.5) * (RealType)d_cellSize;
    RealType z_cL  = (RealType)d_zmin + ((RealType)(gz - dz)   + (RealType)0.5) * (RealType)d_cellSize;
    RealType z_cR  = (RealType)d_zmin + ((RealType)gz          + (RealType)0.5) * (RealType)d_cellSize;
    RealType z_cP1 = (RealType)d_zmin + ((RealType)(gz + dz)   + (RealType)0.5) * (RealType)d_cellSize;

    auto get_mat = [&](RealType rho, RealType z, RealType alpha) -> int {
        if (!d_stratParams.enabled) return 0;
        if (alpha > (RealType)0.02) return 3; // Energetic detonation products / gas plume
        if (is_cell_soil(rho, z)) return 2;
        if (is_cell_water(rho, z, alpha)) return 1;
        return 0; // Air
    };

    int matM2 = 0, matM1 = 0, matP0 = 0, matP1 = 0;
    if constexpr (IsMultiMaterial) {
        matM2 = get_mat(sM2.rho, z_cM2, sM2.alpha1 + sM2.alpha2);
        matM1 = get_mat(sM1.rho, z_cL,  sM1.alpha1 + sM1.alpha2);
        matP0 = get_mat(sP0.rho, z_cR,  sP0.alpha1 + sP0.alpha2);
        matP1 = get_mat(sP1.rho, z_cP1, sP1.alpha1 + sP1.alpha2);
    } else {
        matM2 = get_mat(sM2.rho, z_cM2, (RealType)0.0);
        matM1 = get_mat(sM1.rho, z_cL,  (RealType)0.0);
        matP0 = get_mat(sP0.rho, z_cR,  (RealType)0.0);
        matP1 = get_mat(sP1.rho, z_cP1, (RealType)0.0);
    }

    bool is_mat_interface = (matM1 != matP0);
    bool same_mat_L = (matM2 == matM1);
    bool same_mat_R = (matP1 == matP0);

    auto reconstruct_channel = [&](RealType vM2, RealType vM1, RealType vP0, RealType vP1, RealType& vL, RealType& vR, bool is_pressure = false) {
        if (is_mat_interface) {
            if (is_pressure && dir == 2 && d_has_gravity) {
                vL = vM1 + (RealType)0.5 * sM1.rho * (RealType)d_gravity_z * (RealType)d_cellSize;
                vR = vP0 - (RealType)0.5 * sP0.rho * (RealType)d_gravity_z * (RealType)d_cellSize;
            } else {
                RealType dL = vM1 - vM2;
                vL = (same_mat_L && SpatialOrder > 1) ? (vM1 + (RealType)0.5 * minmod_gpu(dL, dL)) : vM1;
                RealType dR = vP1 - vP0;
                vR = (same_mat_R && SpatialOrder > 1) ? (vP0 - (RealType)0.5 * minmod_gpu(dR, dR)) : vP0;
            }
        } else if constexpr (SpatialOrder == 1) {
            vL = vM1;
            vR = vP0;
        } else {
            RealType dC = vP0 - vM1;
            RealType dL = same_mat_L ? (vM1 - vM2) : dC;
            RealType dR = same_mat_R ? (vP1 - vP0) : dC;

            if constexpr (SpatialOrder == 3) {
                vL = same_mat_L ? weno3_gpu(vM2, vM1, vP0) : (vM1 + (RealType)0.5 * minmod_gpu(dL, dC));
                vR = same_mat_R ? weno3_gpu(vP1, vP0, vM1) : (vP0 - (RealType)0.5 * minmod_gpu(dC, dR));
            } else { // Order 2 or default
                vL = vM1 + (RealType)0.5 * minmod_gpu(dL, dC);
                vR = vP0 - (RealType)0.5 * minmod_gpu(dC, dR);
            }
        }
    };

    reconstruct_channel(sM2.rho, sM1.rho, sP0.rho, sP1.rho, sL.rho, sR.rho);
    sL.rho = fmax((RealType)1e-7, sL.rho);
    sR.rho = fmax((RealType)1e-7, sR.rho);
    reconstruct_channel(sM2.ux, sM1.ux, sP0.ux, sP1.ux, sL.ux, sR.ux);
    reconstruct_channel(sM2.uy, sM1.uy, sP0.uy, sP1.uy, sL.uy, sR.uy);
    reconstruct_channel(sM2.uz, sM1.uz, sP0.uz, sP1.uz, sL.uz, sR.uz);
    reconstruct_channel(sM2.p, sM1.p, sP0.p, sP1.p, sL.p, sR.p, true);
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

        RealType max_arho1_L = fmin(sL.rho, sL.alpha1 * (RealType)d_products.rho0);
        RealType max_arho2_L = fmin(sL.rho, sL.alpha2 * (RealType)d_unreacted.rho0);
        sL.arho1 = fmax((RealType)0.0, fmin(max_arho1_L, sL.arho1));
        sL.arho2 = fmax((RealType)0.0, fmin(max_arho2_L, sL.arho2));
        if (sL.alpha1 == (RealType)0.0) sL.arho1 = (RealType)0.0;
        if (sL.alpha2 == (RealType)0.0) sL.arho2 = (RealType)0.0;

        RealType max_arho1_R = fmin(sR.rho, sR.alpha1 * (RealType)d_products.rho0);
        RealType max_arho2_R = fmin(sR.rho, sR.alpha2 * (RealType)d_unreacted.rho0);
        sR.arho1 = fmax((RealType)0.0, fmin(max_arho1_R, sR.arho1));
        sR.arho2 = fmax((RealType)0.0, fmin(max_arho2_R, sR.arho2));
        if (sR.alpha1 == (RealType)0.0) sR.arho1 = (RealType)0.0;
        if (sR.alpha2 == (RealType)0.0) sR.arho2 = (RealType)0.0;
    }

    RealType keL = (RealType)0.5 * sL.rho * (sL.ux*sL.ux + sL.uy*sL.uy + sL.uz*sL.uz);
    RealType keR = (RealType)0.5 * sR.rho * (sR.ux*sR.ux + sR.uy*sR.uy + sR.uz*sR.uz);

    if constexpr (IsMultiMaterial) {
        if (is_cell_water(sL.rho, z_cL, sL.alpha1 + sL.alpha2)) {
            sL.E = MultiMat::getMixtureEnergyTait<RealType>(sL.p, sL.rho, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, d_taitParams, d_products, d_unreacted) + keL;
        } else if (is_cell_soil(sL.rho, z_cL)) {
            sL.E = computeFluidEnergyGPU<RealType>(sL.p, sL.rho, (RealType)d_gamma, z_cL) + keL;
        } else {
            sL.E = MultiMat::getMixtureEnergy<RealType>(sL.p, sL.rho, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, (RealType)d_gamma, d_products, d_unreacted) + keL;
        }
        if (is_cell_water(sR.rho, z_cR, sR.alpha1 + sR.alpha2)) {
            sR.E = MultiMat::getMixtureEnergyTait<RealType>(sR.p, sR.rho, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, d_taitParams, d_products, d_unreacted) + keR;
        } else if (is_cell_soil(sR.rho, z_cR)) {
            sR.E = computeFluidEnergyGPU<RealType>(sR.p, sR.rho, (RealType)d_gamma, z_cR) + keR;
        } else {
            sR.E = MultiMat::getMixtureEnergy<RealType>(sR.p, sR.rho, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, (RealType)d_gamma, d_products, d_unreacted) + keR;
        }
    } else {
        sL.E = computeFluidEnergyGPU<RealType>(sL.p, sL.rho, (RealType)d_gamma, z_cL) + keL;
        sR.E = computeFluidEnergyGPU<RealType>(sR.p, sR.rho, (RealType)d_gamma, z_cR) + keR;
    }
}

template <typename RealType, bool IsMultiMaterial, int SpatialOrder, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ __noinline__ void get_face_flux_interior_gpu(
    const TileType* states,
    int gx_R, int gy_R, int gz_R,
    int dir, RealType* flx
) {
    int dz = (dir == 2 ? 1 : 0);
    RealType z_cL = (RealType)d_zmin + ((RealType)(gz_R - dz) + (RealType)0.5) * (RealType)d_cellSize;
    RealType z_cR = (RealType)d_zmin + ((RealType)gz_R + (RealType)0.5) * (RealType)d_cellSize;
    GPUCellStateT<RealType, IsMultiMaterial> sL, sR;
    reconstruct_interior_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, gx_R, gy_R, gz_R, dir, sL, sR);
    if (d_stratParams.enabled && dir == 2) {
        bool sL_soil = is_cell_soil(sL.rho, z_cL);
        bool sR_soil = is_cell_soil(sR.rho, z_cR);
        if (sL_soil != sR_soil) {
            getMaterialInterfaceFluxGPU<RealType, IsMultiMaterial>(sL, sR, flx, dir, (RealType)d_gamma, z_cL, z_cR);
            return;
        }
    }
    if (d_useAUSM) getAUSMPlusFluxGPU<RealType, IsMultiMaterial>(sL, sR, flx, dir, (RealType)d_gamma, z_cL, z_cR);
    else getRusanovFluxGPU<RealType, IsMultiMaterial>(sL, sR, flx, dir, (RealType)d_gamma, z_cL, z_cR);
}

template <typename RealType, int Dir, int SpatialOrder>
__device__ __forceinline__ void reconstruct_fluxes_fused_dir_shared(
    const RealType sh_rho[12][12][13],
    const RealType sh_ux[12][12][13],
    const RealType sh_uy[12][12][13],
    const RealType sh_uz[12][12][13],
    const RealType sh_p[12][12][13],
    int lx, int ly, int lz,
    int gz,
    RealType* flxL, RealType* flxR
) {
    constexpr int dx = (Dir == 0 ? 1 : 0);
    constexpr int dy = (Dir == 1 ? 1 : 0);
    constexpr int dz = (Dir == 2 ? 1 : 0);

    int cx = lx + 2;
    int cy = ly + 2;
    int cz = lz + 2;

    #define GET_SH(arr, idx) arr[cz + (idx)*dz][cy + (idx)*dy][cx + (idx)*dx]

    RealType rho0 = GET_SH(sh_rho, -2);
    RealType rho1 = GET_SH(sh_rho, -1);
    RealType rho2 = GET_SH(sh_rho, 0);
    RealType rho3 = GET_SH(sh_rho, 1);
    RealType rho4 = GET_SH(sh_rho, 2);

    RealType ux0 = GET_SH(sh_ux, -2);
    RealType ux1 = GET_SH(sh_ux, -1);
    RealType ux2 = GET_SH(sh_ux, 0);
    RealType ux3 = GET_SH(sh_ux, 1);
    RealType ux4 = GET_SH(sh_ux, 2);

    RealType uy0 = GET_SH(sh_uy, -2);
    RealType uy1 = GET_SH(sh_uy, -1);
    RealType uy2 = GET_SH(sh_uy, 0);
    RealType uy3 = GET_SH(sh_uy, 1);
    RealType uy4 = GET_SH(sh_uy, 2);

    RealType uz0 = GET_SH(sh_uz, -2);
    RealType uz1 = GET_SH(sh_uz, -1);
    RealType uz2 = GET_SH(sh_uz, 0);
    RealType uz3 = GET_SH(sh_uz, 1);
    RealType uz4 = GET_SH(sh_uz, 2);

    RealType p0 = GET_SH(sh_p, -2);
    RealType p1 = GET_SH(sh_p, -1);
    RealType p2 = GET_SH(sh_p, 0);
    RealType p3 = GET_SH(sh_p, 1);
    RealType p4 = GET_SH(sh_p, 2);

    #undef GET_SH

    GPUCellStateT<RealType, false> sL_L, sR_L;
    GPUCellStateT<RealType, false> sL_R, sR_R;

    auto reconstruct_fused_channel = [&](
        RealType v0, RealType v1, RealType v2, RealType v3, RealType v4,
        RealType& vL_L, RealType& vR_L, RealType& vL_R, RealType& vR_R
    ) {
        if constexpr (SpatialOrder == 1) {
            vL_L = v1;
            vR_L = v2;
            vL_R = v2;
            vR_R = v3;
        } else if constexpr (SpatialOrder == 3) {
            vL_L = weno3_gpu(v0, v1, v2);
            vR_L = weno3_gpu(v3, v2, v1);
            vL_R = weno3_gpu(v1, v2, v3);
            vR_R = weno3_gpu(v4, v3, v2);
        } else { // Order 2
            RealType d0 = v1 - v0;
            RealType d1 = v2 - v1;
            RealType d2 = v3 - v2;
            RealType d3 = v4 - v3;
            RealType m1 = minmod_gpu(d0, d1);
            RealType m2 = minmod_gpu(d1, d2);
            RealType m3 = minmod_gpu(d2, d3);
            vL_L = v1 + (RealType)0.5 * m1;
            vR_L = v2 - (RealType)0.5 * m2;
            vL_R = v2 + (RealType)0.5 * m2;
            vR_R = v3 - (RealType)0.5 * m3;
        }
    };

    reconstruct_fused_channel(rho0, rho1, rho2, rho3, rho4, sL_L.rho, sR_L.rho, sL_R.rho, sR_R.rho);
    sL_L.rho = fmax((RealType)1e-7, sL_L.rho);
    sR_L.rho = fmax((RealType)1e-7, sR_L.rho);
    sL_R.rho = fmax((RealType)1e-7, sL_R.rho);
    sR_R.rho = fmax((RealType)1e-7, sR_R.rho);

    reconstruct_fused_channel(ux0, ux1, ux2, ux3, ux4, sL_L.ux, sR_L.ux, sL_R.ux, sR_R.ux);
    reconstruct_fused_channel(uy0, uy1, uy2, uy3, uy4, sL_L.uy, sR_L.uy, sL_R.uy, sR_R.uy);
    reconstruct_fused_channel(uz0, uz1, uz2, uz3, uz4, sL_L.uz, sR_L.uz, sL_R.uz, sR_R.uz);

    reconstruct_fused_channel(p0, p1, p2, p3, p4, sL_L.p, sR_L.p, sL_R.p, sR_R.p);
    sL_L.p = fmax((RealType)1e-7, sL_L.p);
    sR_L.p = fmax((RealType)1e-7, sR_L.p);
    sL_R.p = fmax((RealType)1e-7, sL_R.p);
    sR_R.p = fmax((RealType)1e-7, sR_R.p);

    RealType z_cL_L, z_cR_L, z_cL_R, z_cR_R;
    if constexpr (Dir == 2) {
        z_cL_L = (RealType)(d_zmin + ((RealType)(gz - 1) + (RealType)0.5) * (RealType)d_cellSize);
        z_cR_L = (RealType)(d_zmin + ((RealType)gz + (RealType)0.5) * (RealType)d_cellSize);
        z_cL_R = (RealType)(d_zmin + ((RealType)gz + (RealType)0.5) * (RealType)d_cellSize);
        z_cR_R = (RealType)(d_zmin + ((RealType)(gz + 1) + (RealType)0.5) * (RealType)d_cellSize);
    } else {
        RealType z_cell = (RealType)(d_zmin + ((RealType)gz + (RealType)0.5) * (RealType)d_cellSize);
        z_cL_L = z_cell;
        z_cR_L = z_cell;
        z_cL_R = z_cell;
        z_cR_R = z_cell;
    }

    RealType keL_L = (RealType)0.5 * sL_L.rho * (sL_L.ux*sL_L.ux + sL_L.uy*sL_L.uy + sL_L.uz*sL_L.uz);
    RealType keR_L = (RealType)0.5 * sR_L.rho * (sR_L.ux*sR_L.ux + sR_L.uy*sR_L.uy + sR_L.uz*sR_L.uz);
    sL_L.E = computeFluidEnergyGPU<RealType>(sL_L.p, sL_L.rho, (RealType)d_gamma, z_cL_L) + keL_L;
    sR_L.E = computeFluidEnergyGPU<RealType>(sR_L.p, sR_L.rho, (RealType)d_gamma, z_cR_L) + keR_L;

    RealType keL_R = (RealType)0.5 * sL_R.rho * (sL_R.ux*sL_R.ux + sL_R.uy*sL_R.uy + sL_R.uz*sL_R.uz);
    RealType keR_R = (RealType)0.5 * sR_R.rho * (sR_R.ux*sR_R.ux + sR_R.uy*sR_R.uy + sR_R.uz*sR_R.uz);
    sL_R.E = computeFluidEnergyGPU<RealType>(sL_R.p, sL_R.rho, (RealType)d_gamma, z_cL_R) + keL_R;
    sR_R.E = computeFluidEnergyGPU<RealType>(sR_R.p, sR_R.rho, (RealType)d_gamma, z_cR_R) + keR_R;

    if (d_useAUSM) {
        getAUSMPlusFluxGPU<RealType, false>(sL_L, sR_L, flxL, Dir, (RealType)d_gamma);
        getAUSMPlusFluxGPU<RealType, false>(sL_R, sR_R, flxR, Dir, (RealType)d_gamma);
    } else {
        getRusanovFluxGPU<RealType, false>(sL_L, sR_L, flxL, Dir, (RealType)d_gamma);
        getRusanovFluxGPU<RealType, false>(sL_R, sR_R, flxR, Dir, (RealType)d_gamma);
    }
}

template <typename RealType, int Dir, int SpatialOrder>
__device__ __forceinline__ void reconstruct_interior_shared(
    const RealType sh_rho[12][12][13],
    const RealType sh_ux[12][12][13],
    const RealType sh_uy[12][12][13],
    const RealType sh_uz[12][12][13],
    const RealType sh_p[12][12][13],
    int lx, int ly, int lz,
    int offset,
    int gz,
    RealType* flx
) {
    constexpr int dx = (Dir == 0 ? 1 : 0);
    constexpr int dy = (Dir == 1 ? 1 : 0);
    constexpr int dz = (Dir == 2 ? 1 : 0);

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
        if constexpr (SpatialOrder == 1) {
            vL = vM1;
            vR = vP0;
        } else if constexpr (SpatialOrder == 3) {
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

    RealType z_cL, z_cR;
    if constexpr (Dir == 2) {
        z_cL = (RealType)(d_zmin + ((RealType)(gz + offset) + (RealType)0.5) * (RealType)d_cellSize);
        z_cR = (RealType)(d_zmin + ((RealType)(gz + offset + 1) + (RealType)0.5) * (RealType)d_cellSize);
    } else {
        z_cL = (RealType)(d_zmin + ((RealType)gz + (RealType)0.5) * (RealType)d_cellSize);
        z_cR = z_cL;
    }

    RealType keL = (RealType)0.5 * sL.rho * (sL.ux*sL.ux + sL.uy*sL.uy + sL.uz*sL.uz);
    RealType keR = (RealType)0.5 * sR.rho * (sR.ux*sR.ux + sR.uy*sR.uy + sR.uz*sR.uz);
    sL.E = computeFluidEnergyGPU<RealType>(sL.p, sL.rho, (RealType)d_gamma, z_cL) + keL;
    sR.E = computeFluidEnergyGPU<RealType>(sR.p, sR.rho, (RealType)d_gamma, z_cR) + keR;

    if (d_useAUSM) getAUSMPlusFluxGPU<RealType, false>(sL, sR, flx, Dir, (RealType)d_gamma);
    else getRusanovFluxGPU<RealType, false>(sL, sR, flx, Dir, (RealType)d_gamma);
}

template <typename RealType, bool IsMultiMaterial, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ __noinline__ void convert_conservative_to_primitive_gpu(
    ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U,
    TileType* __restrict__ states,
    const GeometryTile3D* __restrict__ geom,
    int t_idx, int c_idx,
    RealType dt,
    const SolidVelocityTile3D* d_solid_vel = nullptr
);

template <typename RealType, bool IsMultiMaterial, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ __noinline__ void apply_flux_update_gpu(
    ConservativeTile3D<RealType, IsMultiMaterial>* U,
    ConservativeTile3D<RealType, IsMultiMaterial>* U_prev,
    int t_idx, int c_idx, RealType dt_dx,
    const RealType* fL_x, const RealType* fR_x,
    const RealType* fL_y, const RealType* fR_y,
    const RealType* fL_z, const RealType* fR_z,
    TileType* states,
    int rk_stage,
    const GeometryTile3D* geom = nullptr,
    bool perform_primitive_update = false,
    RealType dt_for_peaks = 0.0,
    const SolidVelocityTile3D* d_solid_vel = nullptr
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
        if (d_has_gravity) {
            RealType dt_val = dt_dx * (RealType)d_cellSize;
            U[t_idx].rhoux[c_idx] += dt_val * U[t_idx].rho[c_idx] * (RealType)d_gravity_x;
            U[t_idx].rhouy[c_idx] += dt_val * U[t_idx].rho[c_idx] * (RealType)d_gravity_y;
            U[t_idx].rhouz[c_idx] += dt_val * U[t_idx].rho[c_idx] * (RealType)d_gravity_z;
            U[t_idx].E[c_idx]     += dt_val * (U[t_idx].rhoux[c_idx] * (RealType)d_gravity_x + U[t_idx].rhouy[c_idx] * (RealType)d_gravity_y + U[t_idx].rhouz[c_idx] * (RealType)d_gravity_z);
        }
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

    if (perform_primitive_update) {
        ConservativeTile3D<RealType, IsMultiMaterial>* target_U = (rk_stage == 2) ? U_prev : U;
        convert_conservative_to_primitive_gpu<RealType, IsMultiMaterial>(target_U, states, geom, t_idx, c_idx, dt_for_peaks, d_solid_vel);
    }
}

template <typename RealType, bool IsMultiMaterial, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ __noinline__ void apply_flux_update_gpu_accumulated(
    ConservativeTile3D<RealType, IsMultiMaterial>* U,
    ConservativeTile3D<RealType, IsMultiMaterial>* U_prev,
    int t_idx, int c_idx, RealType dt_dx,
    const RealType* du,
    TileType* states,
    int rk_stage,
    const GeometryTile3D* geom = nullptr,
    bool perform_primitive_update = false,
    RealType dt_for_peaks = 0.0,
    const SolidVelocityTile3D* d_solid_vel = nullptr
) {
    RealType du_rho   = du[0];
    RealType du_rhoux = du[1];
    RealType du_rhouy = du[2];
    RealType du_rhouz = du[3];
    RealType du_E     = du[4];

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
        if (d_has_gravity) {
            RealType dt_val = dt_dx * (RealType)d_cellSize;
            U[t_idx].rhoux[c_idx] += dt_val * U[t_idx].rho[c_idx] * (RealType)d_gravity_x;
            U[t_idx].rhouy[c_idx] += dt_val * U[t_idx].rho[c_idx] * (RealType)d_gravity_y;
            U[t_idx].rhouz[c_idx] += dt_val * U[t_idx].rho[c_idx] * (RealType)d_gravity_z;
            U[t_idx].E[c_idx]     += dt_val * (U[t_idx].rhoux[c_idx] * (RealType)d_gravity_x + U[t_idx].rhouy[c_idx] * (RealType)d_gravity_y + U[t_idx].rhouz[c_idx] * (RealType)d_gravity_z);
        }
    }

    if constexpr (IsMultiMaterial) {
        RealType du_a1  = du[5];
        RealType du_a2  = du[6];
        RealType du_ar1 = du[7];
        RealType du_ar2 = du[8];
        RealType div_u  = du[9];
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

    if (perform_primitive_update) {
        ConservativeTile3D<RealType, IsMultiMaterial>* target_U = (rk_stage == 2) ? U_prev : U;
        convert_conservative_to_primitive_gpu<RealType, IsMultiMaterial>(target_U, states, geom, t_idx, c_idx, dt_for_peaks, d_solid_vel);
    }
}

template <typename RealType, bool IsMultiMaterial, int SpatialOrder, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__global__ void __launch_bounds__(512) compute_flux_fused_3d(
    TileType* __restrict__ states,
    ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U,
    const int* __restrict__ active_tile_indices,
    const uint8_t* __restrict__ tile_is_near_boundary,
    const GeometryTile3D* __restrict__ geom,
    RealType dt,
    int rk_stage = 0,
    ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U_prev = nullptr,
    bool perform_primitive_update = false,
    RealType dt_for_peaks = 0.0,
    const SolidVelocityTile3D* d_solid_vel = nullptr
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
            if (!d_stratParams.enabled) {
                // Shared memory path (optimized for uniform single-material ideal gas)
                __shared__ RealType sh_rho[12][12][13];
                __shared__ RealType sh_ux[12][12][13];
                __shared__ RealType sh_uy[12][12][13];
                __shared__ RealType sh_uz[12][12][13];
                __shared__ RealType sh_p[12][12][13];

                // 1. Perfectly coalesced load of the 512 interior cells
                sh_rho[lz + 2][ly + 2][lx + 2] = __ldg(&states[t_idx].rho[c_idx]);
                sh_ux[lz + 2][ly + 2][lx + 2]  = __ldg(&states[t_idx].ux[c_idx]);
                sh_uy[lz + 2][ly + 2][lx + 2]  = __ldg(&states[t_idx].uy[c_idx]);
                sh_uz[lz + 2][ly + 2][lx + 2]  = __ldg(&states[t_idx].uz[c_idx]);
                sh_p[lz + 2][ly + 2][lx + 2]   = __ldg(&states[t_idx].p[c_idx]);

                // 2. Load the remaining 1216 halo cells
                #pragma unroll 4
                for (int idx = tid; idx < 1728; idx += 512) {
                    int lz_sh = idx / 144;
                    int ly_sh = (idx % 144) / 12;
                    int lx_sh = idx % 12;

                    // Skip the central 8x8x8 block because it was already loaded
                    if (lz_sh >= 2 && lz_sh < 10 && ly_sh >= 2 && ly_sh < 10 && lx_sh >= 2 && lx_sh < 10) {
                        continue;
                    }

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
                    RealType du[10] = {};
                    RealType fL[10], fR[10];

                    // --- X Direction ---
                    reconstruct_fluxes_fused_dir_shared<RealType, 0, SpatialOrder>(sh_rho, sh_ux, sh_uy, sh_uz, sh_p, lx, ly, lz, gz, fL, fR);
                    #pragma unroll
                    for (int c = 0; c < 5; ++c) {
                        du[c] += (fR[c] - fL[c]);
                    }

                    // --- Y Direction ---
                    reconstruct_fluxes_fused_dir_shared<RealType, 1, SpatialOrder>(sh_rho, sh_ux, sh_uy, sh_uz, sh_p, lx, ly, lz, gz, fL, fR);
                    #pragma unroll
                    for (int c = 0; c < 5; ++c) {
                        du[c] += (fR[c] - fL[c]);
                    }

                    // --- Z Direction ---
                    reconstruct_fluxes_fused_dir_shared<RealType, 2, SpatialOrder>(sh_rho, sh_ux, sh_uy, sh_uz, sh_p, lx, ly, lz, gz, fL, fR);
                    #pragma unroll
                    for (int c = 0; c < 5; ++c) {
                        du[c] += (fR[c] - fL[c]);
                    }

                    apply_flux_update_gpu_accumulated<RealType, IsMultiMaterial, TileType>(U, U_prev, t_idx, c_idx, dt_dx, du, states, rk_stage, geom, perform_primitive_update, dt_for_peaks, d_solid_vel);
                }
            } else {
                // Stratified medium: use global memory path with get_face_flux_interior_gpu
                // which applies exact material interface fluxes and hydrostatic projections
                if (gx < d_nx && gy < d_ny && gz < d_nz) {
                    RealType fL_x[10], fR_x[10];
                    RealType fL_y[10], fR_y[10];
                    RealType fL_z[10], fR_z[10];

                    // --- X Direction ---
                    get_face_flux_interior_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, gx, gy, gz, 0, fL_x);
                    get_face_flux_interior_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, gx + 1, gy, gz, 0, fR_x);

                    // --- Y Direction ---
                    get_face_flux_interior_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, gx, gy, gz, 1, fL_y);
                    get_face_flux_interior_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, gx, gy + 1, gz, 1, fR_y);

                    // --- Z Direction ---
                    get_face_flux_interior_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, gx, gy, gz, 2, fL_z);
                    get_face_flux_interior_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, gx, gy, gz + 1, 2, fR_z);

                    apply_flux_update_gpu<RealType, IsMultiMaterial, TileType>(U, U_prev, t_idx, c_idx, dt_dx, fL_x, fR_x, fL_y, fR_y, fL_z, fR_z, states, rk_stage, geom, perform_primitive_update, dt_for_peaks, d_solid_vel);
                }
            }
        } else {
            // Default global memory path
            if (gx < d_nx && gy < d_ny && gz < d_nz) {
                RealType fL_x[10], fR_x[10];
                RealType fL_y[10], fR_y[10];
                RealType fL_z[10], fR_z[10];

                // --- X Direction ---
                get_face_flux_interior_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, gx, gy, gz, 0, fL_x);
                get_face_flux_interior_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, gx + 1, gy, gz, 0, fR_x);

                // --- Y Direction ---
                get_face_flux_interior_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, gx, gy, gz, 1, fL_y);
                get_face_flux_interior_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, gx, gy + 1, gz, 1, fR_y);

                // --- Z Direction ---
                get_face_flux_interior_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, gx, gy, gz, 2, fL_z);
                get_face_flux_interior_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, gx, gy, gz + 1, 2, fR_z);

                apply_flux_update_gpu<RealType, IsMultiMaterial, TileType>(U, U_prev, t_idx, c_idx, dt_dx, fL_x, fR_x, fL_y, fR_y, fL_z, fR_z, states, rk_stage, geom, perform_primitive_update, dt_for_peaks, d_solid_vel);
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
                get_face_flux_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, geom, gx - 1, gy, gz, gx, gy, gz, 0, fL_x, gx, gy, gz, s_is_near_boundary);
                get_face_flux_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, geom, gx, gy, gz, gx + 1, gy, gz, 0, fR_x, gx, gy, gz, s_is_near_boundary);

                // --- Y Direction ---
                get_face_flux_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, geom, gx, gy - 1, gz, gx, gy, gz, 1, fL_y, gx, gy, gz, s_is_near_boundary);
                get_face_flux_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, geom, gx, gy, gz, gx, gy + 1, gz, 1, fR_y, gx, gy, gz, s_is_near_boundary);

                // --- Z Direction ---
                get_face_flux_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, geom, gx, gy, gz - 1, gx, gy, gz, 2, fL_z, gx, gy, gz, s_is_near_boundary);
                get_face_flux_gpu<RealType, IsMultiMaterial, SpatialOrder, TileType>(states, geom, gx, gy, gz, gx, gy, gz + 1, 2, fR_z, gx, gy, gz, s_is_near_boundary);

                apply_flux_update_gpu<RealType, IsMultiMaterial, TileType>(U, U_prev, t_idx, c_idx, dt_dx, fL_x, fR_x, fL_y, fR_y, fL_z, fR_z, states, rk_stage, geom, perform_primitive_update, dt_for_peaks, d_solid_vel);
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
    states[t_idx].peak_overpressure[c_idx] = 0.0;
    states[t_idx].running_impulse[c_idx] = 0.0;
    states[t_idx].peak_impulse[c_idx] = 0.0;
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

template <typename RealType, bool IsMultiMaterial, typename TileType>
__device__ __noinline__ void convert_conservative_to_primitive_gpu(
    ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U,
    TileType* __restrict__ states,
    const GeometryTile3D* __restrict__ geom,
    int t_idx, int c_idx,
    RealType dt,
    const SolidVelocityTile3D* d_solid_vel
) {
    RealType u_rho = U[t_idx].rho[c_idx];
    RealType u_rhoux = U[t_idx].rhoux[c_idx];
    RealType u_rhouy = U[t_idx].rhouy[c_idx];
    RealType u_rhouz = U[t_idx].rhouz[c_idx];
    RealType u_E = U[t_idx].E[c_idx];

    int tz = t_idx / (d_ntx * d_nty);
    int k = c_idx / (TILE_SIZE_3D * TILE_SIZE_3D);
    int gz = tz * TILE_SIZE_3D + k;
    RealType z_c = (RealType)d_zmin + ((RealType)gz + (RealType)0.5) * (RealType)d_cellSize;

    bool bad = false;
    if (isnan(u_rho) || isinf(u_rho) || isnan(u_E) || isinf(u_E)) {
        bad = true;
    }

    RealType rho = 0.0;
    RealType ux = 0.0;
    RealType uy = 0.0;
    RealType uz = 0.0;
    RealType p = 0.0;
    RealType E = 0.0;

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
    }
    RealType alpha1 = 0.0;
    RealType alpha2 = 0.0;
    RealType arho1 = 0.0;
    RealType arho2 = 0.0;

    if (!bad) {
        RealType rho_min = (RealType)1e-4;
        RealType alpha_he = (RealType)0.0;
        if constexpr (IsMultiMaterial) {
            alpha_he = fmax((RealType)0.0, U[t_idx].alpha1[c_idx]) + fmax((RealType)0.0, U[t_idx].alpha2[c_idx]);
        }
        if (alpha_he < (RealType)0.05) {
            if (d_stratParams.enabled) {
                if (z_c < (RealType)d_stratParams.seabed_surface_z) rho_min = (RealType)500.0;
                else if (z_c <= (RealType)d_stratParams.water_surface_z) rho_min = (RealType)250.0;
            } else if (d_isWater) {
                rho_min = (RealType)250.0;
            }
        }
        rho = fmax(u_rho, rho_min);
        U[t_idx].rho[c_idx] = rho;
        RealType inv_rho = (RealType)1.0 / rho;
        ux = u_rhoux * inv_rho;
        uy = u_rhouy * inv_rho;
        uz = u_rhouz * inv_rho;
        
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

        if (geom && geom[t_idx].cells[c_idx].is_boundary) {
            ux = states[t_idx].ux[c_idx];
            uy = states[t_idx].uy[c_idx];
            uz = states[t_idx].uz[c_idx];
        }

        const RealType MAX_SPECIFIC_EINT = 1e10;
        RealType e_int_floor;
        bool is_cell_water_or_soil = is_cell_soil(rho, z_c) || (rho > (RealType)300.0 && z_c <= (RealType)d_stratParams.water_surface_z);
        if (d_isWater || (d_stratParams.enabled && is_cell_water_or_soil)) {
            // For water and soil under Tait EOS, zero is the reference energy at 1 atm.
            // Minimum internal energy allows expansion down to physical cavitation pressure.
            e_int_floor = (RealType)-1.0e6 * rho;
        } else {
            // Ideal gas: internal energy must be positive.
            RealType gm1 = fmax((RealType)0.1, (RealType)d_gamma - (RealType)1.0);
            e_int_floor = (RealType)100.0 / gm1;
        }

        if (e_int * inv_rho > MAX_SPECIFIC_EINT) {
            e_int = rho * MAX_SPECIFIC_EINT;
            U[t_idx].E[c_idx] = e_int + ke;
        } else if (e_int < e_int_floor) {
            e_int = e_int_floor;
            U[t_idx].E[c_idx] = e_int + ke;
        }

        if constexpr (IsMultiMaterial) {
            alpha1 = fmax((RealType)0.0, fmin((RealType)1.0, U[t_idx].alpha1[c_idx]));
            alpha2 = fmax((RealType)0.0, fmin((RealType)1.0, U[t_idx].alpha2[c_idx]));
            if (alpha1 < (RealType)1e-6) alpha1 = (RealType)0.0;
            if (alpha2 < (RealType)1e-6) alpha2 = (RealType)0.0;
            if (alpha1 + alpha2 > (RealType)1.0) {
                RealType sum = alpha1 + alpha2;
                alpha1 /= sum;
                alpha2 /= sum;
            }
            RealType max_arho1 = fmin(rho, alpha1 * (RealType)d_products.rho0);
            RealType max_arho2 = fmin(rho, alpha2 * (RealType)d_unreacted.rho0);
            arho1 = fmax((RealType)0.0, fmin(max_arho1, U[t_idx].arho1[c_idx]));
            arho2 = fmax((RealType)0.0, fmin(max_arho2, U[t_idx].arho2[c_idx]));
            if (alpha1 == (RealType)0.0) arho1 = (RealType)0.0;
            if (alpha2 == (RealType)0.0) arho2 = (RealType)0.0;
            if (arho1 + arho2 > rho) {
                RealType sum = arho1 + arho2;
                arho1 = (arho1 / sum) * rho;
                arho2 = (arho2 / sum) * rho;
            }

            bool is_water = is_cell_water(rho, z_c, alpha1 + alpha2);
            bool is_soil = is_cell_soil(rho, z_c);

            RealType p_val;
            if (is_water) {
                p_val = MultiMat::getMixturePressureTait<RealType>(
                    e_int, rho, alpha1, alpha2, arho1, arho2,
                    d_taitParams, d_products, d_unreacted
                );
            } else if (is_soil) {
                RealType gamma_soil = (RealType)(d_stratParams.soil_gamma > 0.0 ? d_stratParams.soil_gamma : 4.0);
                RealType rho0_soil = (RealType)(d_stratParams.soil_density > 0.0 ? d_stratParams.soil_density : 2000.0);
                RealType c0_soil = (RealType)(d_stratParams.soil_c0 > 0.0 ? d_stratParams.soil_c0 : 2500.0);
                RealType B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
                RealType p0_soil = (RealType)d_stratParams.p_atm;
                RealType p_cav_soil = (RealType)(d_stratParams.soil_p_cav != 0.0 ? d_stratParams.soil_p_cav : -1.0e5);
                if (d_stratParams.soil_eos_variant == 1) { // Caloric Gruneisen
                    RealType gruneisen_soil = (RealType)(d_stratParams.soil_gruneisen > 0.0 ? d_stratParams.soil_gruneisen : 1.45);
                    RealType spec_e = e_int / fmax((RealType)1e-6, rho);
                    p_val = (RealType)Blast::TaitEOSWater::compute_pressure_caloric(
                        (double)rho, (double)spec_e, (double)B_soil, (double)gamma_soil, (double)rho0_soil,
                        (double)gruneisen_soil, (double)p_cav_soil, (double)p0_soil
                    );
                } else if (d_stratParams.soil_eos_variant == 2) { // Shock Hugoniot
                    RealType s_soil = (RealType)(d_stratParams.soil_s > 0.0 ? d_stratParams.soil_s : 1.35);
                    RealType gruneisen_soil = (RealType)(d_stratParams.soil_gruneisen > 0.0 ? d_stratParams.soil_gruneisen : 1.45);
                    RealType spec_e = e_int / fmax((RealType)1e-6, rho);
                    p_val = (RealType)Blast::TaitEOSWater::compute_pressure_hugoniot(
                        (double)rho, (double)spec_e, (double)c0_soil, (double)s_soil, (double)rho0_soil,
                        (double)gruneisen_soil, (double)p_cav_soil, (double)p0_soil
                    );
                } else {
                    p_val = (RealType)Blast::TaitEOSWater::compute_pressure_isentropic((double)rho, (double)B_soil, (double)gamma_soil, (double)rho0_soil, (double)p_cav_soil, (double)p0_soil);
                }
            } else {
                p_val = MultiMat::getMixturePressure<RealType>(
                    e_int, rho, alpha1, alpha2, arho1, arho2,
                    (RealType)d_gamma, d_products, d_unreacted
                );
            }
            if (isnan(p_val) || isinf(p_val)) {
                bad = true;
            } else {
                RealType p_floor = is_soil ? (RealType)(d_stratParams.soil_p_cav != 0.0 ? d_stratParams.soil_p_cav : -1.0e5) : (is_water ? (RealType)d_taitParams.p_cav : (RealType)100.0);
                p = fmax(p_val, p_floor);
                E = u_E;
                U[t_idx].alpha1[c_idx] = alpha1;
                U[t_idx].alpha2[c_idx] = alpha2;
                U[t_idx].arho1[c_idx] = arho1;
                U[t_idx].arho2[c_idx] = arho2;
            }
        } else {
            bool is_water = is_cell_water(rho, z_c);
            bool is_soil = is_cell_soil(rho, z_c);
            RealType p_val;
            if (is_water) {
                RealType spec_e = e_int / fmax((RealType)1e-6, rho);
                p_val = (RealType)Blast::TaitEOSWater::compute_pressure_dispatcher(rho, spec_e, d_taitParams);
            } else if (is_soil) {
                RealType gamma_soil = (RealType)(d_stratParams.soil_gamma > 0.0 ? d_stratParams.soil_gamma : 4.0);
                RealType rho0_soil = (RealType)(d_stratParams.soil_density > 0.0 ? d_stratParams.soil_density : 2000.0);
                RealType c0_soil = (RealType)(d_stratParams.soil_c0 > 0.0 ? d_stratParams.soil_c0 : 2500.0);
                RealType B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
                RealType p0_soil = (RealType)d_stratParams.p_atm;
                RealType p_cav_soil = (RealType)(d_stratParams.soil_p_cav != 0.0 ? d_stratParams.soil_p_cav : -1.0e5);
                if (d_stratParams.soil_eos_variant == 1) { // Caloric Gruneisen
                    RealType gruneisen_soil = (RealType)(d_stratParams.soil_gruneisen > 0.0 ? d_stratParams.soil_gruneisen : 1.45);
                    RealType spec_e = e_int / fmax((RealType)1e-6, rho);
                    p_val = (RealType)Blast::TaitEOSWater::compute_pressure_caloric(
                        (double)rho, (double)spec_e, (double)B_soil, (double)gamma_soil, (double)rho0_soil,
                        (double)gruneisen_soil, (double)p_cav_soil, (double)p0_soil
                    );
                } else if (d_stratParams.soil_eos_variant == 2) { // Shock Hugoniot
                    RealType s_soil = (RealType)(d_stratParams.soil_s > 0.0 ? d_stratParams.soil_s : 1.35);
                    RealType gruneisen_soil = (RealType)(d_stratParams.soil_gruneisen > 0.0 ? d_stratParams.soil_gruneisen : 1.45);
                    RealType spec_e = e_int / fmax((RealType)1e-6, rho);
                    p_val = (RealType)Blast::TaitEOSWater::compute_pressure_hugoniot(
                        (double)rho, (double)spec_e, (double)c0_soil, (double)s_soil, (double)rho0_soil,
                        (double)gruneisen_soil, (double)p_cav_soil, (double)p0_soil
                    );
                } else {
                    p_val = (RealType)Blast::TaitEOSWater::compute_pressure_isentropic((double)rho, (double)B_soil, (double)gamma_soil, (double)rho0_soil, (double)p_cav_soil, (double)p0_soil);
                }
            } else {
                p_val = e_int * ((RealType)d_gamma - (RealType)1.0);
            }
            if (isnan(p_val) || isinf(p_val)) {
                bad = true;
            } else {
                RealType p_floor = is_soil ? (RealType)(d_stratParams.soil_p_cav != 0.0 ? d_stratParams.soil_p_cav : -1.0e5) : (is_water ? (RealType)d_taitParams.p_cav : (RealType)1e-8);
                p = fmax(p_val, p_floor);
                E = u_E;
            }
        }
    }

    if (bad) {
        bool bad_is_water = is_cell_water(u_rho, z_c);
        bool bad_is_soil = is_cell_soil(u_rho, z_c);
        if (d_stratParams.enabled) {
            double g_mag = sqrt(d_gravity_x*d_gravity_x + d_gravity_y*d_gravity_y + d_gravity_z*d_gravity_z);
            if (g_mag < 1.0e-6) g_mag = 9.80665;
            if (bad_is_water) {
                double p_h = 0.0, rho_h = 0.0, e_h = 0.0;
                Blast::TaitEOSWater::compute_hydrostatic_state(
                    (double)z_c, (double)d_stratParams.water_surface_z, g_mag, (double)d_stratParams.p_atm,
                    p_h, rho_h, e_h, (double)d_stratParams.tait_B, (double)d_stratParams.tait_gamma, (double)d_stratParams.tait_rho0
                );
                p = (RealType)p_h;
                rho = (RealType)rho_h;
            } else if (bad_is_soil) {
                double p_bed = 0.0, rho_bed = 0.0, e_bed = 0.0;
                Blast::TaitEOSWater::compute_hydrostatic_state(
                    (double)d_stratParams.seabed_surface_z, (double)d_stratParams.water_surface_z, g_mag, (double)d_stratParams.p_atm,
                    p_bed, rho_bed, e_bed, (double)d_stratParams.tait_B, (double)d_stratParams.tait_gamma, (double)d_stratParams.tait_rho0
                );
                double sig_v = 0.0, u_p = 0.0, sig_h = 0.0;
                Blast::TaitEOSWater::compute_geostatic_stress(
                    (double)z_c, (double)d_stratParams.seabed_surface_z, p_bed, (double)d_stratParams.soil_density, (double)d_stratParams.tait_rho0, g_mag, (double)d_stratParams.k0_earth_pressure,
                    sig_v, u_p, sig_h
                );
                p = (RealType)sig_v;
                double gamma_soil = d_stratParams.soil_gamma > 0.0 ? d_stratParams.soil_gamma : 4.0;
                double rho0_soil = d_stratParams.soil_density > 0.0 ? d_stratParams.soil_density : 2000.0;
                double c0_soil = d_stratParams.soil_c0 > 0.0 ? d_stratParams.soil_c0 : 2500.0;
                double B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
                double p0_soil = d_stratParams.p_atm;
                rho = (RealType)Blast::TaitEOSWater::compute_density_isentropic((double)sig_v, B_soil, gamma_soil, rho0_soil, p0_soil);
            } else {
                p = (RealType)d_ambient_p;
                rho = (RealType)d_ambient_rho;
            }
        } else {
            rho = bad_is_water ? (RealType)d_taitParams.rho0 : (bad_is_soil ? (RealType)d_stratParams.soil_density : (RealType)d_ambient_rho);
            p = (RealType)d_ambient_p;
        }
        ux = 0.0;
        uy = 0.0;
        uz = 0.0;
        if constexpr (IsMultiMaterial) {
            if (bad_is_water) {
                E = MultiMat::getMixtureEnergyTait<RealType>(p, rho, (RealType)0.0, (RealType)0.0, (RealType)0.0, (RealType)0.0, d_taitParams, d_products, d_unreacted);
            } else if (bad_is_soil) {
                E = computeFluidEnergyGPU<RealType>(p, rho, (RealType)d_gamma, z_c);
            } else {
                E = MultiMat::getMixtureEnergy<RealType>(p, (RealType)d_ambient_rho, (RealType)0.0, (RealType)0.0, (RealType)0.0, (RealType)0.0, (RealType)d_gamma, d_products, d_unreacted);
            }
        } else {
            E = computeFluidEnergyGPU<RealType>(p, rho, (RealType)d_gamma, z_c);
        }
        alpha1 = 0.0;
        alpha2 = 0.0;
        arho1 = 0.0;
        arho2 = 0.0;

        U[t_idx].rho[c_idx] = rho;
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
        is_solid = geom[t_idx].cells[c_idx].is_boundary;
    }

    if (is_solid) {
        rho = (RealType)d_ambient_rho;
        RealType sv_x = 0.0;
        RealType sv_y = 0.0;
        RealType sv_z = 0.0;
        if (d_solid_vel) {
            sv_x = (RealType)d_solid_vel[t_idx].vx[c_idx];
            sv_y = (RealType)d_solid_vel[t_idx].vy[c_idx];
            sv_z = (RealType)d_solid_vel[t_idx].vz[c_idx];
        }
        ux = sv_x;
        uy = sv_y;
        uz = sv_z;
        p = (RealType)d_ambient_p;
        RealType ke = (RealType)0.5 * (ux * ux + uy * uy + uz * uz);
        if constexpr (IsMultiMaterial) {
            E = MultiMat::getMixtureEnergy<RealType>((RealType)d_ambient_p, (RealType)d_ambient_rho, (RealType)0.0, (RealType)0.0, (RealType)0.0, (RealType)0.0, (RealType)d_gamma, d_products, d_unreacted) + rho * ke;
        } else {
            E = (RealType)d_ambient_p / ((RealType)d_gamma - (RealType)1.0) + rho * ke;
        }
        alpha1 = 0.0;
        alpha2 = 0.0;
        arho1 = 0.0;
        arho2 = 0.0;

        U[t_idx].rho[c_idx] = rho;
        U[t_idx].rhoux[c_idx] = rho * ux;
        U[t_idx].rhouy[c_idx] = rho * uy;
        U[t_idx].rhouz[c_idx] = rho * uz;
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
    if constexpr (std::is_same_v<TileType, PrimitiveTile3D<RealType, IsMultiMaterial>>) {
        states[t_idx].floor_status[c_idx] = (states[t_idx].floor_status[c_idx] & 2) | (bad ? 1 : 0);
    }
    if constexpr (IsMultiMaterial) {
        states[t_idx].alpha1[c_idx] = alpha1;
        states[t_idx].alpha2[c_idx] = alpha2;
        states[t_idx].arho1[c_idx] = arho1;
        states[t_idx].arho2[c_idx] = arho2;
    }

    if (dt > (RealType)0.0) {
        if constexpr (std::is_same_v<TileType, PrimitiveTile3D<RealType, IsMultiMaterial>>) {
            RealType op = p - (RealType)d_ambient_p;
            if (op < (RealType)0.0) op = (RealType)0.0;
            if (op > states[t_idx].peak_overpressure[c_idx]) {
                states[t_idx].peak_overpressure[c_idx] = op;
            }
            states[t_idx].running_impulse[c_idx] += op * dt;
            if (states[t_idx].running_impulse[c_idx] > states[t_idx].peak_impulse[c_idx]) {
                states[t_idx].peak_impulse[c_idx] = states[t_idx].running_impulse[c_idx];
            }
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) update_primitive_kernel_3d(
    PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states,
    ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U,
    const int* __restrict__ active_tile_indices,
    const GeometryTile3D* __restrict__ geom,
    RealType dt = 0.0,
    const SolidVelocityTile3D* d_solid_vel = nullptr
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

    convert_conservative_to_primitive_gpu<RealType, IsMultiMaterial>(U, states, geom, t_idx, c_idx, dt, d_solid_vel);
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
    }

    if (d_afterburn.enabled) {
        RealType arho0 = U[t_idx].rho[c_idx] - tmp_arho1 - tmp_arho2;
        RealType ke = (RealType)0.5 * (U[t_idx].rhoux[c_idx] * U[t_idx].rhoux[c_idx] +
                                       U[t_idx].rhouy[c_idx] * U[t_idx].rhouy[c_idx] +
                                       U[t_idx].rhouz[c_idx] * U[t_idx].rhouz[c_idx]) / U[t_idx].rho[c_idx];

        RealType vort_mag = (RealType)0.0;
        if (lx > 0 && lx < TILE_SIZE_3D - 1 && ly > 0 && ly < TILE_SIZE_3D - 1 && lz > 0 && lz < TILE_SIZE_3D - 1) {
            int c_px = c_idx + 1;
            int c_mx = c_idx - 1;
            int c_py = c_idx + TILE_SIZE_3D;
            int c_my = c_idx - TILE_SIZE_3D;
            int c_pz = c_idx + TILE_SIZE_3D * TILE_SIZE_3D;
            int c_mz = c_idx - TILE_SIZE_3D * TILE_SIZE_3D;

            RealType inv_rho_py = (RealType)1.0 / U[t_idx].rho[c_py];
            RealType inv_rho_my = (RealType)1.0 / U[t_idx].rho[c_my];
            RealType inv_rho_pz = (RealType)1.0 / U[t_idx].rho[c_pz];
            RealType inv_rho_mz = (RealType)1.0 / U[t_idx].rho[c_mz];
            RealType inv_rho_px = (RealType)1.0 / U[t_idx].rho[c_px];
            RealType inv_rho_mx = (RealType)1.0 / U[t_idx].rho[c_mx];

            RealType ux_py = U[t_idx].rhoux[c_py] * inv_rho_py;
            RealType ux_my = U[t_idx].rhoux[c_my] * inv_rho_my;
            RealType ux_pz = U[t_idx].rhoux[c_pz] * inv_rho_pz;
            RealType ux_mz = U[t_idx].rhoux[c_mz] * inv_rho_mz;

            RealType uy_px = U[t_idx].rhouy[c_px] * inv_rho_px;
            RealType uy_mx = U[t_idx].rhouy[c_mx] * inv_rho_mx;
            RealType uy_pz = U[t_idx].rhouy[c_pz] * inv_rho_pz;
            RealType uy_mz = U[t_idx].rhouy[c_mz] * inv_rho_mz;

            RealType uz_px = U[t_idx].rhouz[c_px] * inv_rho_px;
            RealType uz_mx = U[t_idx].rhouz[c_mx] * inv_rho_mx;
            RealType uz_py = U[t_idx].rhouz[c_py] * inv_rho_py;
            RealType uz_my = U[t_idx].rhouz[c_my] * inv_rho_my;

            RealType inv_2dx = (RealType)0.5 / (RealType)d_cellSize;
            RealType wx = (uz_py - uz_my - (uy_pz - uy_mz)) * inv_2dx;
            RealType wy = (ux_pz - ux_mz - (uz_px - uz_mx)) * inv_2dx;
            RealType wz = (uy_px - uy_mx - (ux_py - ux_my)) * inv_2dx;
            using std::sqrt;
            vort_mag = sqrt(wx * wx + wy * wy + wz * wz);
        }

        MultiMat::computeAfterburn<RealType>(
            dt, (RealType)currentTime, (RealType)d_charge_radius, (RealType)d_det_vel,
            d_afterburn,
            U[t_idx].rho[c_idx], tmp_alpha1, tmp_arho1, arho0, U[t_idx].E[c_idx], ke,
            vort_mag
        );
    }

    if (dF > (RealType)0.0 || d_afterburn.enabled) {
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

    const double deg2rad = 3.14159265358979323846 / 180.0;
    const double ax = charge.rot_x * deg2rad;
    const double ay = charge.rot_y * deg2rad;
    const double az = charge.rot_z * deg2rad;
    const double cx_rot = cos(ax), sx_rot = sin(ax);
    const double cy_rot = cos(ay), sy_rot = sin(ay);
    const double cz_rot = cos(az), sz_rot = sin(az);
    const bool has_rot = (charge.rot_x != 0.0 || charge.rot_y != 0.0 || charge.rot_z != 0.0);

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
                double x_loc = dx_p;
                double y_loc = dy_p;
                double z_loc = dz_p;
                if (has_rot) {
                    double x1 = cz_rot * dx_p + sz_rot * dy_p;
                    double y1 = -sz_rot * dx_p + cz_rot * dy_p;
                    double z1 = dz_p;

                    double x2 = cy_rot * x1 - sy_rot * z1;
                    double y2 = y1;
                    double z2 = sy_rot * x1 + cy_rot * z1;

                    x_loc = x2;
                    y_loc = cx_rot * y2 + sx_rot * z2;
                    z_loc = -sx_rot * y2 + cx_rot * z2;
                }
                bool inside = false;
                if (charge.shape_type == 0) { // Sphere
                    double dist_sq_p = dx_p*dx_p + dy_p*dy_p + dz_p*dz_p;
                    if (dist_sq_p <= charge.radius * charge.radius) inside = true;
                } else if (charge.shape_type == 1) { // Block
                    if (fabs(x_loc) <= charge.lx*0.5 && fabs(y_loc) <= charge.ly*0.5 && fabs(z_loc) <= charge.lz*0.5) inside = true;
                } else if (charge.shape_type == 2) { // Cylinder
                    double dr_sq_p = x_loc*x_loc + y_loc*y_loc;
                    if (dr_sq_p <= charge.radius*charge.radius && fabs(z_loc) <= charge.height*0.5) inside = true;
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
__global__ void __launch_bounds__(512) set_stratified_initial_condition_kernel(
    PrimitiveTile3D<RealType, IsMultiMaterial>* states, ConservativeTile3D<RealType, IsMultiMaterial>* U, uint8_t* active_tiles,
    int nx, int ny, int nz, RealType cellSize, RealType xmin, RealType ymin, RealType zmin,
    RealType gamma,
    Charge3DParams charge, RealType high_rho, RealType det_energy, RealType det_vel,
    Blast::Stratified3DParams strat) {
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
    double z_c = (double)zmin + ((double)gz + 0.5) * (double)cellSize;
    RealType h_micro = cellSize / (RealType)4.0;

    double cell_p = strat.p_atm;
    double cell_rho = strat.air_rho;
    double cell_E = 0.0;
    double g_mag = fabs(strat.gravity_z);
    if (g_mag < 1e-6) g_mag = 9.81;

    if (z_c > strat.water_surface_z) {
        // Zone 1: Atmosphere (Hydrostatic Air Column)
        double z_air_depth = z_c - strat.water_surface_z;
        cell_p = strat.p_atm - strat.air_rho * g_mag * z_air_depth;
        cell_rho = strat.air_rho;
        if constexpr (IsMultiMaterial) {
            cell_E = MultiMat::getMixtureEnergy<RealType>((RealType)cell_p, (RealType)cell_rho, (RealType)0.0, (RealType)0.0, (RealType)0.0, (RealType)0.0, gamma, d_products, d_unreacted);
            if (gz == 80 && gx == 0 && gy == 0) {
                printf("[Zone 1 Air gz=80] cell_p=%.4e gamma=%.4e cell_E=%.4e\n", (double)cell_p, (double)gamma, (double)cell_E);
            }
        } else {
            cell_E = cell_p / ((double)gamma - 1.0);
        }
    } else if (z_c >= strat.seabed_surface_z) {
        // Zone 2: Seawater column (Modified Tait EOS)
        double p_h = 0.0, rho_h = 0.0, e_h = 0.0;
        Blast::TaitEOSWater::compute_hydrostatic_state(
            z_c, strat.water_surface_z, g_mag, strat.p_atm,
            p_h, rho_h, e_h, strat.tait_B, strat.tait_gamma, strat.tait_rho0
        );
        cell_p = p_h;
        cell_rho = rho_h;
        cell_E = cell_rho * e_h;
    } else {
        // Zone 3: Geotechnical Seabed
        double p_bed = 0.0, rho_bed = 0.0, e_bed = 0.0;
        Blast::TaitEOSWater::compute_hydrostatic_state(
            strat.seabed_surface_z, strat.water_surface_z, g_mag, strat.p_atm,
            p_bed, rho_bed, e_bed, strat.tait_B, strat.tait_gamma, strat.tait_rho0
        );
        double sig_v = 0.0, u_p = 0.0, sig_h = 0.0;
        Blast::TaitEOSWater::compute_geostatic_stress(
            z_c, strat.seabed_surface_z, p_bed, strat.soil_density, strat.tait_rho0, g_mag, strat.k0_earth_pressure,
            sig_v, u_p, sig_h
        );
        cell_p = sig_v;
        double gamma_soil = strat.soil_gamma > 0.0 ? strat.soil_gamma : 4.0;
        double rho0_soil = strat.soil_density > 0.0 ? strat.soil_density : 2000.0;
        double c0_soil = strat.soil_c0 > 0.0 ? strat.soil_c0 : 2500.0;
        double B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
        double p0_soil = strat.p_atm;
        cell_rho = Blast::TaitEOSWater::compute_density_isentropic(
            cell_p, B_soil, gamma_soil, rho0_soil, p0_soil
        );
        double e_soil = Blast::TaitEOSWater::compute_energy_isentropic(cell_rho, B_soil, gamma_soil, rho0_soil);
        cell_E = cell_rho * e_soil;
    }

    const double deg2rad = 3.14159265358979323846 / 180.0;
    const double ax = charge.rot_x * deg2rad;
    const double ay = charge.rot_y * deg2rad;
    const double az = charge.rot_z * deg2rad;
    const double cx_rot = cos(ax), sx_rot = sin(ax);
    const double cy_rot = cos(ay), sy_rot = sin(ay);
    const double cz_rot = cos(az), sz_rot = sin(az);
    const bool has_rot = (charge.rot_x != 0.0 || charge.rot_y != 0.0 || charge.rot_z != 0.0);

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
                double x_loc = dx_p;
                double y_loc = dy_p;
                double z_loc = dz_p;
                if (has_rot) {
                    double x1 = cz_rot * dx_p + sz_rot * dy_p;
                    double y1 = -sz_rot * dx_p + cz_rot * dy_p;
                    double z1 = dz_p;

                    double x2 = cy_rot * x1 - sy_rot * z1;
                    double y2 = y1;
                    double z2 = sy_rot * x1 + cy_rot * z1;

                    x_loc = x2;
                    y_loc = cx_rot * y2 + sx_rot * z2;
                    z_loc = -sx_rot * y2 + cx_rot * z2;
                }
                bool inside = false;
                if (charge.shape_type == 0) { // Sphere
                    double dist_sq_p = dx_p*dx_p + dy_p*dy_p + dz_p*dz_p;
                    if (dist_sq_p <= charge.radius * charge.radius) inside = true;
                } else if (charge.shape_type == 1) { // Block
                    if (fabs(x_loc) <= charge.lx*0.5 && fabs(y_loc) <= charge.ly*0.5 && fabs(z_loc) <= charge.lz*0.5) inside = true;
                } else if (charge.shape_type == 2) { // Cylinder
                    double dr_sq_p = x_loc*x_loc + y_loc*y_loc;
                    if (dr_sq_p <= charge.radius*charge.radius && fabs(z_loc) <= charge.height*0.5) inside = true;
                }
                if (inside) points_inside++;
            }
        }
    }
    RealType f_vol = (RealType)(points_inside / 64.0);

    RealType rho = (RealType)cell_rho;
    RealType p = (RealType)cell_p;
    RealType alpha1 = 0.0;
    RealType alpha2 = 0.0;
    RealType arho1 = 0.0;
    RealType arho2 = 0.0;
    RealType init_E = (RealType)cell_E;

    if (f_vol > (RealType)0.0) {
        if constexpr (IsMultiMaterial) {
            alpha1 = 0.0;
            alpha2 = f_vol;
            arho1 = 0.0;
            arho2 = alpha2 * high_rho;
            rho = arho2 + ((RealType)1.0 - f_vol) * (RealType)cell_rho;

            RealType p_solid = (RealType)MultiMat::getReferencePressure_Unreacted<RealType>(d_unreacted);
            p = ((RealType)1.0 - f_vol) * (RealType)cell_p + f_vol * (RealType)fmax((double)cell_p, (double)p_solid);
            if (is_cell_water(cell_rho, (RealType)z_c)) {
                init_E = MultiMat::getMixtureEnergyTait<RealType>(p, rho, alpha1, alpha2, arho1, arho2, d_taitParams, d_products, d_unreacted);
            } else if (is_cell_soil(cell_rho, (RealType)z_c)) {
                init_E = computeFluidEnergyGPU<RealType>(p, rho, gamma, (RealType)z_c);
            } else {
                init_E = MultiMat::getMixtureEnergy<RealType>(p, rho, alpha1, alpha2, arho1, arho2, gamma, d_products, d_unreacted);
            }
        } else {
            rho = f_vol * high_rho + ((RealType)1.0 - f_vol) * (RealType)cell_rho;
            RealType p_high = (gamma - (RealType)1.0) * high_rho * det_energy;
            p = f_vol * p_high + ((RealType)1.0 - f_vol) * (RealType)cell_p;
            RealType det_E = high_rho * det_energy;
            init_E = f_vol * det_E + ((RealType)1.0 - f_vol) * (RealType)cell_E;
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
    if ((gz == 79 || gz == 80) && gx == 0 && gy == 0) {
        printf("[set_stratified gz=%d] cell_p=%.4e gamma=%.4e cell_rho=%.4e cell_E=%.4e init_E=%.4e\n",
               gz, (double)cell_p, (double)gamma, (double)cell_rho, (double)cell_E, (double)init_E);
    }
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
    if (qty_id == 13) {
        if constexpr (IsMultiMaterial) {
            if (tile.alpha2[c_idx] > 0.05f && tile.alpha2[c_idx] >= tile.alpha1[c_idx]) return 3.0f; // Solid HE
            if (tile.alpha1[c_idx] > 0.05f) return 4.0f; // Detonation products
        }
        if (d_stratParams.enabled && tile.rho[c_idx] > 1800.0) return 2.0f; // Seabed Soil (nominal ~2000)
        if (tile.rho[c_idx] > 300.0) return 1.0f;  // Water
        return 0.0f; // Air
    }
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
    if (qty_id == 10) {
        RealType ke = (RealType)0.5 * tile.rho * (tile.ux * tile.ux + tile.uy * tile.uy + tile.uz * tile.uz);
        RealType total_E;
        if constexpr (IsMultiMaterial) {
            total_E = MultiMat::getMixtureEnergy<RealType>(tile.p, tile.rho, tile.alpha1, tile.alpha2, tile.arho1, tile.arho2, (RealType)d_gamma, d_products, d_unreacted) + ke;
        } else {
            total_E = tile.p / ((RealType)d_gamma - (RealType)1.0) + ke;
        }
        RealType e_int = (total_E - ke) / fmax((RealType)1e-6, tile.rho);
        RealType T_val = e_int / (RealType)718.0;
        return (float)fmax((RealType)200.0, T_val);
    }
    if (qty_id == 11) {
        if constexpr (!IsMultiMaterial) return 0.0f;
        else {
            if (!d_afterburn.enabled || d_afterburn.ambient_o2_fraction <= 0.0) return 0.0f;
            RealType ke = (RealType)0.5 * tile.rho * (tile.ux * tile.ux + tile.uy * tile.uy + tile.uz * tile.uz);
            RealType total_E = MultiMat::getMixtureEnergy<RealType>(tile.p, tile.rho, tile.alpha1, tile.alpha2, tile.arho1, tile.arho2, (RealType)d_gamma, d_products, d_unreacted) + ke;
            RealType e_int = (total_E - ke) / fmax((RealType)1e-6, tile.rho);
            if (e_int / (RealType)718.0 < (RealType)d_afterburn.T_ign) return 0.0f;
            RealType arho0 = fmax((RealType)0.0, tile.rho - tile.arho1 - tile.arho2);
            RealType rho_fuel = (RealType)d_afterburn.f_fuel * tile.arho1;
            RealType rho_O2 = (RealType)d_afterburn.ambient_o2_fraction * arho0;
            RealType tau_exp = (d_afterburn.tau_expansion > (RealType)1e-4) ? (RealType)d_afterburn.tau_expansion : (RealType)0.0;
            if (tau_exp <= (RealType)0.0) {
                if (d_charge_radius > (RealType)1e-4) {
                    RealType Q_scale = (d_afterburn.Q_ab > (RealType)1e5) ? (RealType)d_afterburn.Q_ab : (RealType)4.29e6;
                    RealType rho_exp = (tile.rho > (RealType)100.0) ? (RealType)tile.rho : (RealType)1630.0;
                    constexpr RealType P_amb = (RealType)101325.0;
                    constexpr RealType c_amb = (RealType)340.0;
                    constexpr RealType k_fireball = (RealType)0.16;
                    RealType sedov_ratio = pow((RealType)(4.0 / 3.0 * M_PI) * rho_exp * Q_scale / P_amb, (RealType)(1.0 / 3.0));
                    tau_exp = (k_fireball * sedov_ratio * (RealType)d_charge_radius) / c_amb;
                } else {
                    tau_exp = (RealType)0.005;
                }
            }
            RealType k_mix = (RealType)1.0 / fmax(tau_exp, (RealType)1e-5);
            RealType f_fuel_safe = fmax((RealType)d_afterburn.f_fuel, (RealType)0.01);
            RealType r_fuel = k_mix * fmin(rho_fuel, rho_O2 / (RealType)d_afterburn.s_ratio);
            RealType r_expl = r_fuel / f_fuel_safe;
            return (float)(r_expl * (RealType)d_afterburn.Q_ab);
        }
    }
    if (qty_id == 12) {
        if constexpr (!IsMultiMaterial) return 0.0f;
        else {
            RealType rho_fuel = (RealType)d_afterburn.f_fuel * tile.arho1;
            return (float)fmax((RealType)0.0, rho_fuel);
        }
    }
    if (qty_id == 13) {
        if constexpr (IsMultiMaterial) {
            if (tile.alpha2 > 0.05f && tile.alpha2 >= tile.alpha1) return 3.0f; // Solid HE
            if (tile.alpha1 > 0.05f) return 4.0f; // Detonation products
        }
        if (d_stratParams.enabled && tile.rho > 1800.0) return 2.0f; // Seabed Soil (nominal ~2000)
        if (tile.rho > 300.0) return 1.0f;  // Water
        return 0.0f; // Air
    }
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
        } else {
            // Deep interior solid cell
            sC.rho = (RealType)d_ambient_rho;
            sC.p = (RealType)d_ambient_p;
            sC.ux = 0.0;
            sC.uy = 0.0;
            sC.uz = 0.0;
            sC.peak_overpressure = 0.0;
            sC.peak_impulse = 0.0;
            if constexpr (IsMultiMaterial) {
                sC.alpha1 = 0.0;
                sC.alpha2 = 0.0;
                sC.arho1 = 0.0;
                sC.arho2 = 0.0;
                sC.E = MultiMat::getMixtureEnergy<RealType>(sC.p, sC.rho, (RealType)0, (RealType)0, (RealType)0, (RealType)0, (RealType)d_gamma, d_products, d_unreacted);
            } else {
                sC.E = sC.p / ((RealType)d_gamma - (RealType)1.0);
            }
        }
    }
    return sC;
}

template <typename RealType, bool IsMultiMaterial>
static __global__ void extract_obstacles_kernel(
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
static __global__ void sample_surface_points_kernel(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states,
    const GeometryTile3D* __restrict__ geom,
    const Point3D* __restrict__ points,
    float* __restrict__ out_buf,
    int num_points,
    int qty_id,
    double dom_xmin, double dom_xmax,
    double dom_ymin, double dom_ymax,
    double dom_zmin, double dom_zmax,
    float outside_val,
    int nx, int ny, int nz,
    double xmin, double ymin, double zmin,
    double dx, int ntx, int nty) {

    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_points) return;

    Point3D pt = points[idx];
    const double tol = 1e-4 * dx;
    if (pt.x < dom_xmin - tol || pt.x > dom_xmax + tol ||
        pt.y < dom_ymin - tol || pt.y > dom_ymax + tol ||
        pt.z < dom_zmin - tol || pt.z > dom_zmax + tol) {
        out_buf[idx] = outside_val;
        return;
    }

    int gx = max(0, min(nx - 1, (int)floor((pt.x - xmin) / dx)));
    int gy = max(0, min(ny - 1, (int)floor((pt.y - ymin) / dx)));
    int gz = max(0, min(nz - 1, (int)floor((pt.z - zmin) / dx)));

    int tx = gx / 8;
    int ty = gy / 8;
    int tz = gz / 8;
    int t_idx = tx + ty * ntx + tz * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

    if (qty_id == 7) {
        out_buf[idx] = (geom && geom[t_idx].cells[c_idx].is_boundary) ? 1.0f : 0.0f;
        return;
    }

    bool is_solid = (geom != nullptr && geom[t_idx].cells[c_idx].is_boundary != 0);
    if (is_solid) {
        double best_dist2 = 1e30;
        int best_gx = gx, best_gy = gy, best_gz = gz;
        bool found = false;

        // Search radius 1 (26 neighbors)
        #pragma unroll
        for (int dz = -1; dz <= 1; ++dz) {
            int cz = gz + dz;
            if (cz < 0 || cz >= nz) continue;
            int ctz = cz / 8;
            int ccz = (cz & 7) * 64;

            #pragma unroll
            for (int dy = -1; dy <= 1; ++dy) {
                int cy = gy + dy;
                if (cy < 0 || cy >= ny) continue;
                int cty = cy / 8;
                int ccy = (cy & 7) * 8;

                #pragma unroll
                for (int ddx = -1; ddx <= 1; ++ddx) {
                    if (ddx == 0 && dy == 0 && dz == 0) continue;
                    int cx = gx + ddx;
                    if (cx < 0 || cx >= nx) continue;

                    int nt_idx = (cx / 8) + cty * ntx + ctz * ntx * nty;
                    int nc_idx = (cx & 7) + ccy + ccz;

                    if (geom[nt_idx].cells[nc_idx].is_boundary == 0) {
                        double ccx = xmin + (cx + 0.5) * dx;
                        double ccy_pos = ymin + (cy + 0.5) * dx;
                        double ccz_pos = zmin + (cz + 0.5) * dx;
                        double dist2 = (pt.x - ccx)*(pt.x - ccx) + (pt.y - ccy_pos)*(pt.y - ccy_pos) + (pt.z - ccz_pos)*(pt.z - ccz_pos);
                        if (dist2 < best_dist2) {
                            best_dist2 = dist2;
                            best_gx = cx; best_gy = cy; best_gz = cz;
                            found = true;
                        }
                    }
                }
            }
        }

        // Search radius 2 if entirely surrounded in radius 1
        if (!found) {
            for (int dz = -2; dz <= 2; ++dz) {
                int cz = gz + dz;
                if (cz < 0 || cz >= nz) continue;
                int ctz = cz / 8;
                int ccz = (cz & 7) * 64;

                for (int dy = -2; dy <= 2; ++dy) {
                    int cy = gy + dy;
                    if (cy < 0 || cy >= ny) continue;
                    int cty = cy / 8;
                    int ccy = (cy & 7) * 8;

                    for (int ddx = -2; ddx <= 2; ++ddx) {
                        int abs_x = (ddx < 0 ? -ddx : ddx);
                        int abs_y = (dy < 0 ? -dy : dy);
                        int abs_z = (dz < 0 ? -dz : dz);
                        if (abs_x <= 1 && abs_y <= 1 && abs_z <= 1) continue;
                        int cx = gx + ddx;
                        if (cx < 0 || cx >= nx) continue;

                        int nt_idx = (cx / 8) + cty * ntx + ctz * ntx * nty;
                        int nc_idx = (cx & 7) + ccy + ccz;

                        if (geom[nt_idx].cells[nc_idx].is_boundary == 0) {
                            double ccx = xmin + (cx + 0.5) * dx;
                            double ccy_pos = ymin + (cy + 0.5) * dx;
                            double ccz_pos = zmin + (cz + 0.5) * dx;
                            double dist2 = (pt.x - ccx)*(pt.x - ccx) + (pt.y - ccy_pos)*(pt.y - ccy_pos) + (pt.z - ccz_pos)*(pt.z - ccz_pos);
                            if (dist2 < best_dist2) {
                                best_dist2 = dist2;
                                best_gx = cx; best_gy = cy; best_gz = cz;
                                found = true;
                            }
                        }
                    }
                }
            }
        }

        if (found) {
            gx = best_gx; gy = best_gy; gz = best_gz;
            tx = gx / 8; ty = gy / 8; tz = gz / 8;
            t_idx = tx + ty * ntx + tz * ntx * nty;
            c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;
        }
    }

    RealType val = get_value_by_qty<RealType, IsMultiMaterial>(states[t_idx], c_idx, qty_id);
    out_buf[idx] = (float)val;
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(256) extract_slice_kernel(const PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states, const GeometryTile3D* __restrict__ geom, float* __restrict__ data, int nx, int ny, int nz, int axis, double offset, double xmin, double ymin, double zmin, double dx, int qty_id, int stride) {
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
    } else if (qty_id == 13) {
        bool is_solid = false;
        if (geom != nullptr) {
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
            if (geom[t_idx].cells[c_idx].is_boundary) is_solid = true;
        }
        if (is_solid) {
            data[i + j * w] = 5.0f; // FEM Solid / Obstacle
        } else {
            GPUCellStateT<RealType, IsMultiMaterial> sC = sample_state_with_mirror_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz, xmin, ymin, zmin, dx);
            double z_c = zmin + ((double)gz + 0.5) * dx;
            float mat_id = 0.0f; // Air
            if constexpr (IsMultiMaterial) {
                if (sC.alpha2 > 0.05f && sC.alpha2 >= sC.alpha1) mat_id = 3.0f; // Solid HE
                else if (sC.alpha1 > 0.05f) mat_id = 4.0f; // Detonation Products
                else if (is_cell_soil(sC.rho, z_c)) mat_id = 2.0f; // Seabed Soil
                else if (is_cell_water(sC.rho, z_c, sC.alpha1 + sC.alpha2)) mat_id = 1.0f; // Water
                else mat_id = 0.0f;
            } else {
                if (is_cell_soil(sC.rho, z_c)) mat_id = 2.0f;
                else if (is_cell_water(sC.rho, z_c)) mat_id = 1.0f;
                else mat_id = 0.0f;
            }
            data[i + j * w] = mat_id;
        }
    } else if (qty_id == 14) {
        bool is_solid = false;
        if (geom != nullptr) {
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
            if (geom[t_idx].cells[c_idx].is_boundary) is_solid = true;
        }
        if (is_solid) {
            data[i + j * w] = 0.0f;
        } else {
            GPUCellStateT<RealType, IsMultiMaterial> sC = sample_state_with_mirror_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz, xmin, ymin, zmin, dx);
            double z_c = zmin + ((double)gz + 0.5) * dx;
            data[i + j * w] = is_cell_water(sC.rho, z_c) ? 1.0f : 0.0f;
        }
    } else if (qty_id == 15) {
        bool is_solid = false;
        if (geom != nullptr) {
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
            if (geom[t_idx].cells[c_idx].is_boundary) is_solid = true;
        }
        if (is_solid) {
            data[i + j * w] = 0.0f;
        } else {
            GPUCellStateT<RealType, IsMultiMaterial> sC = sample_state_with_mirror_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz, xmin, ymin, zmin, dx);
            double z_c = zmin + ((double)gz + 0.5) * dx;
            data[i + j * w] = is_cell_soil(sC.rho, z_c) ? 1.0f : 0.0f;
        }
    } else {
        GPUCellStateT<RealType, IsMultiMaterial> sC = sample_state_with_mirror_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz, xmin, ymin, zmin, dx);
        data[i + j * w] = get_value_by_qty_struct<RealType, IsMultiMaterial>(sC, qty_id);
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(256) extract_volume_kernel(const PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states, const GeometryTile3D* __restrict__ geom, float* __restrict__ data, int nx, int ny, int nz, int out_nx, int out_ny, int out_nz, double xmin, double ymin, double zmin, double dx, int qty_id, int stride, int factor = 1, int i_start = 0, int j_start = 0, int k_start = 0) {
    int gx = blockIdx.x * blockDim.x + threadIdx.x;
    int gy = blockIdx.y * blockDim.y + threadIdx.y;
    int gz = blockIdx.z * blockDim.z + threadIdx.z;

    if (gx >= out_nx || gy >= out_ny || gz >= out_nz) return;

    int orig_x = i_start + (gx * stride) / factor;
    int orig_y = j_start + (gy * stride) / factor;
    int orig_z = k_start + (gz * stride) / factor;

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
    } else if (qty_id == 13) {
        bool is_solid = false;
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
            if (geom[t_idx].cells[c_idx].is_boundary) is_solid = true;
        }
        if (is_solid) {
            data[out_idx] = 5.0f;
        } else {
            GPUCellStateT<RealType, IsMultiMaterial> sC = sample_state_with_mirror_gpu<RealType, IsMultiMaterial>(states, geom, orig_x, orig_y, orig_z, xmin, ymin, zmin, dx);
            double z_c = zmin + ((double)orig_z + 0.5) * dx;
            float mat_id = 0.0f;
            if constexpr (IsMultiMaterial) {
                if (sC.alpha2 > 0.05f && sC.alpha2 >= sC.alpha1) mat_id = 3.0f;
                else if (sC.alpha1 > 0.05f) mat_id = 4.0f;
                else if (is_cell_soil(sC.rho, z_c)) mat_id = 2.0f;
                else if (is_cell_water(sC.rho, z_c, sC.alpha1 + sC.alpha2)) mat_id = 1.0f;
                else mat_id = 0.0f;
            } else {
                if (is_cell_soil(sC.rho, z_c)) mat_id = 2.0f;
                else if (is_cell_water(sC.rho, z_c)) mat_id = 1.0f;
                else mat_id = 0.0f;
            }
            data[out_idx] = mat_id;
        }
    } else if (qty_id == 14) {
        bool is_solid = false;
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
            if (geom[t_idx].cells[c_idx].is_boundary) is_solid = true;
        }
        if (is_solid) {
            data[out_idx] = 0.0f;
        } else {
            GPUCellStateT<RealType, IsMultiMaterial> sC = sample_state_with_mirror_gpu<RealType, IsMultiMaterial>(states, geom, orig_x, orig_y, orig_z, xmin, ymin, zmin, dx);
            double z_c = zmin + ((double)orig_z + 0.5) * dx;
            data[out_idx] = is_cell_water(sC.rho, z_c) ? 1.0f : 0.0f;
        }
    } else if (qty_id == 15) {
        bool is_solid = false;
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
            if (geom[t_idx].cells[c_idx].is_boundary) is_solid = true;
        }
        if (is_solid) {
            data[out_idx] = 0.0f;
        } else {
            GPUCellStateT<RealType, IsMultiMaterial> sC = sample_state_with_mirror_gpu<RealType, IsMultiMaterial>(states, geom, orig_x, orig_y, orig_z, xmin, ymin, zmin, dx);
            double z_c = zmin + ((double)orig_z + 0.5) * dx;
            data[out_idx] = is_cell_soil(sC.rho, z_c) ? 1.0f : 0.0f;
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
                float nx_b, ny_b, nz_b;
                if (get_solid_normal_gpu(geom, orig_x, orig_y, orig_z, nx_b, ny_b, nz_b)) {
                    float n_len = sqrtf(nx_b*nx_b + ny_b*ny_b + nz_b*nz_b);
                    if (n_len > 1e-3f) {
                        GPUCellStateT<RealType, IsMultiMaterial> sC = sample_state_with_mirror_gpu<RealType, IsMultiMaterial>(states, geom, orig_x, orig_y, orig_z, xmin, ymin, zmin, dx);
                        data[out_idx] = get_value_by_qty_struct<RealType, IsMultiMaterial>(sC, qty_id);
                        return;
                    }
                }
                GPUCellStateT<RealType, IsMultiMaterial> sC = sample_gpu_raw<RealType, IsMultiMaterial>(states, orig_x, orig_y, orig_z);
                data[out_idx] = get_value_by_qty_struct<RealType, IsMultiMaterial>(sC, qty_id);
                return;
            }
        }
        GPUCellStateT<RealType, IsMultiMaterial> sC = sample_state_with_mirror_gpu<RealType, IsMultiMaterial>(states, geom, target_x, target_y, target_z, xmin, ymin, zmin, dx);
        data[out_idx] = get_value_by_qty_struct<RealType, IsMultiMaterial>(sC, qty_id);
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void extract_bulk_snapshot_kernel(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states,
    const GeometryTile3D* __restrict__ geom,
    float* __restrict__ out_p,
    float* __restrict__ out_rho,
    float* __restrict__ out_overp,
    float* __restrict__ out_imp,
    float* __restrict__ out_solid,
    float* __restrict__ out_vel,
    float* __restrict__ out_E,
    float* __restrict__ out_alpha1,
    float* __restrict__ out_alpha2,
    float* __restrict__ out_air,
    int nx, int ny, int nz,
    RealType gamma,
    bool need_vel,
    bool need_E,
    bool need_species)
{
    int gx = blockIdx.x * blockDim.x + threadIdx.x;
    int gy = blockIdx.y * blockDim.y + threadIdx.y;
    int gz = blockIdx.z * blockDim.z + threadIdx.z;

    if (gx >= nx || gy >= ny || gz >= nz) return;

    int ttx = (nx + 7) / 8;
    int tty = (ny + 7) / 8;
    int tx = gx / 8;
    int ty = gy / 8;
    int tz = gz / 8;
    int t_idx = tx + ty * ttx + tz * ttx * tty;
    int cx = gx % 8;
    int cy = gy % 8;
    int cz = gz % 8;
    int c_idx = cx + cy * 8 + cz * 64;
    size_t lin_idx = (size_t)gx + (size_t)gy * nx + (size_t)gz * nx * ny;

    const auto& tile = states[t_idx];

    out_p[lin_idx] = (float)tile.p[c_idx];
    out_rho[lin_idx] = (float)tile.rho[c_idx];
    out_overp[lin_idx] = (float)tile.peak_overpressure[c_idx];
    out_imp[lin_idx] = (float)tile.peak_impulse[c_idx];

    if (out_solid != nullptr) {
        if (geom != nullptr) {
            out_solid[lin_idx] = geom[t_idx].cells[c_idx].is_boundary ? 1.0f : 0.0f;
        } else {
            out_solid[lin_idx] = 0.0f;
        }
    }

    if (need_vel && out_vel != nullptr) {
        RealType ux = tile.ux[c_idx];
        RealType uy = tile.uy[c_idx];
        RealType uz = tile.uz[c_idx];
        out_vel[lin_idx] = (float)sqrt((double)(ux * ux + uy * uy + uz * uz));
    }

    if (need_E && out_E != nullptr) {
        RealType ux = tile.ux[c_idx];
        RealType uy = tile.uy[c_idx];
        RealType uz = tile.uz[c_idx];
        RealType ke = (RealType)0.5 * tile.rho[c_idx] * (ux * ux + uy * uy + uz * uz);
        RealType total_E;
        if constexpr (IsMultiMaterial) {
            total_E = MultiMat::getMixtureEnergy<RealType>(tile.p[c_idx], tile.rho[c_idx], tile.alpha1[c_idx], tile.alpha2[c_idx], tile.arho1[c_idx], tile.arho2[c_idx], gamma, d_products, d_unreacted) + ke;
        } else {
            total_E = tile.p[c_idx] / (gamma - (RealType)1.0) + ke;
        }
        out_E[lin_idx] = (float)(total_E / max((RealType)1e-6, tile.rho[c_idx]));
    }

    if (need_species) {
        if constexpr (IsMultiMaterial) {
            if (out_alpha1 != nullptr) out_alpha1[lin_idx] = (float)tile.alpha1[c_idx];
            if (out_alpha2 != nullptr) out_alpha2[lin_idx] = (float)tile.alpha2[c_idx];
            if (out_air != nullptr) out_air[lin_idx] = (float)(1.0 - tile.alpha1[c_idx] - tile.alpha2[c_idx]);
        } else {
            if (out_alpha1 != nullptr) out_alpha1[lin_idx] = 0.0f;
            if (out_alpha2 != nullptr) out_alpha2[lin_idx] = 0.0f;
            if (out_air != nullptr) out_air[lin_idx] = 1.0f;
        }
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
    CHECK_CUDA(cudaMemset(d_states, 0, total_tiles * sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>)));
    CHECK_CUDA(cudaMalloc(&d_U, total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>)));
    CHECK_CUDA(cudaMemset(d_U, 0, total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>)));
    CHECK_CUDA(cudaMalloc(&d_geom, total_tiles * sizeof(GeometryTile3D)));
    CHECK_CUDA(cudaMemset(d_geom, 0, total_tiles * sizeof(GeometryTile3D)));
    CHECK_CUDA(cudaMalloc(&d_active_tiles, total_tiles * sizeof(uint8_t)));
    CHECK_CUDA(cudaMalloc(&d_tile_active_temp, total_tiles * sizeof(uint8_t)));
    CHECK_CUDA(cudaMalloc(&d_active_tile_indices, total_tiles * sizeof(int)));
    CHECK_CUDA(cudaMalloc(&d_active_count, sizeof(int)));

    // Lazy-allocate space-time schemes predictor/derivative buffers (allocated only if ADER-3/MUSCL is used)
    d_states_pred = nullptr;
    d_dW_dt = nullptr;

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
    bool is_water_flag = this->is_water_tait_val;
    CHECK_CUDA(cudaMemcpyToSymbol(d_isWater, &is_water_flag, sizeof(bool)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_taitParams, &this->tait_water_params, sizeof(Blast::TaitEOSParams)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_stratParams, &this->stratified_params, sizeof(Blast::Stratified3DParams)));

    is_ideal_gas_val = !IsMultiMaterial;
    updateBoundaryConditions();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::updateBoundaryConditions() {
    constants_dirty = true;
}

template <typename RealType, bool IsMultiMaterial>
CFDSolver3DCuda<RealType, IsMultiMaterial>::~CFDSolver3DCuda() {
    if (d_states) cudaFree(d_states);
    if (d_states_pred) cudaFree(d_states_pred);
    if (d_dW_dt) cudaFree(d_dW_dt);
    if (d_U) cudaFree(d_U);
    if (d_geom) cudaFree(d_geom);
    if (d_prev_mask) { cudaFree(d_prev_mask); d_prev_mask = nullptr; }
    if (d_active_tiles) cudaFree(d_active_tiles);
    if (d_tile_active_temp) cudaFree(d_tile_active_temp);
    if (d_active_tile_indices) cudaFree(d_active_tile_indices);
    if (d_active_count) cudaFree(d_active_count);
    if (d_max_s_buf) cudaFree(d_max_s_buf);
    if (d_slice_buf) { cudaFree(d_slice_buf); d_slice_buf_capacity = 0; }
    if (d_sample_coords) { cudaFree(d_sample_coords); d_sample_coords = nullptr; d_sample_coords_capacity = 0; }
    if (d_tile_mass) cudaFree(d_tile_mass);
    if (d_tile_energy) cudaFree(d_tile_energy);
    if (d_tile_is_near_boundary) cudaFree(d_tile_is_near_boundary);
    if (d_solid_mask_fsi) { cudaFree(d_solid_mask_fsi); d_solid_mask_fsi = nullptr; }
    if (d_solid_vel_fsi) { cudaFree(d_solid_vel_fsi); d_solid_vel_fsi = nullptr; }
    if (d_tile_has_boundary_buf) { cudaFree(d_tile_has_boundary_buf); d_tile_has_boundary_buf = nullptr; }

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

    if (d_prev_mask) {
        paged_prev_mask.resize(total_tiles);
        CHECK_CUDA(cudaMemcpy(paged_prev_mask.data(), d_prev_mask, total_tiles * sizeof(UncoveringMaskTile3D), cudaMemcpyDeviceToHost));
        has_paged_prev_mask = true;
    } else {
        has_paged_prev_mask = false;
    }

    size_t mask_bytes = static_cast<size_t>(nx) * ny * nz * sizeof(uint8_t);
    if (d_solid_mask_fsi) {
        paged_solid_mask.resize(nx * ny * nz);
        CHECK_CUDA(cudaMemcpy(paged_solid_mask.data(), d_solid_mask_fsi, mask_bytes, cudaMemcpyDeviceToHost));
        has_paged_solid_mask = true;
    } else {
        has_paged_solid_mask = false;
    }

    if (d_solid_vel_fsi) {
        size_t vel_bytes = total_tiles * sizeof(SolidVelocityTile3D);
        paged_solid_vel.resize(total_tiles);
        CHECK_CUDA(cudaMemcpy(paged_solid_vel.data(), d_solid_vel_fsi, vel_bytes, cudaMemcpyDeviceToHost));
        has_paged_solid_vel = true;
    } else {
        has_paged_solid_vel = false;
    }

    if (d_tile_has_boundary_buf) {
        paged_tile_boundary.resize(total_tiles);
        CHECK_CUDA(cudaMemcpy(paged_tile_boundary.data(), d_tile_has_boundary_buf, total_tiles * sizeof(uint8_t), cudaMemcpyDeviceToHost));
        has_paged_tile_boundary = true;
    } else {
        has_paged_tile_boundary = false;
    }

    if (d_states) { cudaFree(d_states); d_states = nullptr; }
    if (d_states_pred) { cudaFree(d_states_pred); d_states_pred = nullptr; }
    if (d_dW_dt) { cudaFree(d_dW_dt); d_dW_dt = nullptr; }
    if (d_U) { cudaFree(d_U); d_U = nullptr; }
    if (d_geom) { cudaFree(d_geom); d_geom = nullptr; }
    if (d_prev_mask) { cudaFree(d_prev_mask); d_prev_mask = nullptr; }
    if (d_active_tiles) { cudaFree(d_active_tiles); d_active_tiles = nullptr; }
    if (d_tile_active_temp) { cudaFree(d_tile_active_temp); d_tile_active_temp = nullptr; }
    if (d_active_tile_indices) { cudaFree(d_active_tile_indices); d_active_tile_indices = nullptr; }
    if (d_active_count) { cudaFree(d_active_count); d_active_count = nullptr; }
    if (d_max_s_buf) { cudaFree(d_max_s_buf); d_max_s_buf = nullptr; }
    if (d_slice_buf) { cudaFree(d_slice_buf); d_slice_buf = nullptr; d_slice_buf_capacity = 0; }
    if (d_sample_coords) { cudaFree(d_sample_coords); d_sample_coords = nullptr; d_sample_coords_capacity = 0; }
    if (d_tile_mass) { cudaFree(d_tile_mass); d_tile_mass = nullptr; }
    if (d_tile_energy) { cudaFree(d_tile_energy); d_tile_energy = nullptr; }
    if (d_tile_is_near_boundary) { cudaFree(d_tile_is_near_boundary); d_tile_is_near_boundary = nullptr; }
    if (d_solid_mask_fsi) { cudaFree(d_solid_mask_fsi); d_solid_mask_fsi = nullptr; d_solid_mask_fsi_capacity = 0; }
    if (d_solid_vel_fsi) { cudaFree(d_solid_vel_fsi); d_solid_vel_fsi = nullptr; d_solid_vel_fsi_capacity = 0; }
    if (d_tile_has_boundary_buf) { cudaFree(d_tile_has_boundary_buf); d_tile_has_boundary_buf = nullptr; d_tile_has_boundary_capacity = 0; }
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

    if (has_paged_prev_mask) {
        CHECK_CUDA(cudaMalloc(&d_prev_mask, total_tiles * sizeof(UncoveringMaskTile3D)));
        CHECK_CUDA(cudaMemcpy(d_prev_mask, paged_prev_mask.data(), total_tiles * sizeof(UncoveringMaskTile3D), cudaMemcpyHostToDevice));
    }
    if (has_paged_solid_mask) {
        size_t mask_bytes = static_cast<size_t>(nx) * ny * nz * sizeof(uint8_t);
        CHECK_CUDA(cudaMalloc(&d_solid_mask_fsi, mask_bytes));
        CHECK_CUDA(cudaMemcpy(d_solid_mask_fsi, paged_solid_mask.data(), mask_bytes, cudaMemcpyHostToDevice));
        d_solid_mask_fsi_capacity = mask_bytes;
    }
    if (has_paged_solid_vel) {
        size_t vel_bytes = total_tiles * sizeof(SolidVelocityTile3D);
        CHECK_CUDA(cudaMalloc(&d_solid_vel_fsi, vel_bytes));
        CHECK_CUDA(cudaMemcpy(d_solid_vel_fsi, paged_solid_vel.data(), vel_bytes, cudaMemcpyHostToDevice));
        d_solid_vel_fsi_capacity = vel_bytes;
    }
    if (has_paged_tile_boundary) {
        CHECK_CUDA(cudaMalloc(&d_tile_has_boundary_buf, total_tiles * sizeof(uint8_t)));
        CHECK_CUDA(cudaMemcpy(d_tile_has_boundary_buf, paged_tile_boundary.data(), total_tiles * sizeof(uint8_t), cudaMemcpyHostToDevice));
        d_tile_has_boundary_capacity = total_tiles * sizeof(uint8_t);
    }

    paged_states.clear(); paged_states.shrink_to_fit();
    paged_U.clear(); paged_U.shrink_to_fit();
    paged_geom.clear(); paged_geom.shrink_to_fit();
    paged_active_tiles.clear(); paged_active_tiles.shrink_to_fit();
    paged_tile_active_temp.clear(); paged_tile_active_temp.shrink_to_fit();
    paged_tile_is_near_boundary.clear(); paged_tile_is_near_boundary.shrink_to_fit();
    paged_gauge_coords.clear(); paged_gauge_coords.shrink_to_fit();
    paged_obstacle_faces.clear(); paged_obstacle_faces.shrink_to_fit();
    paged_prev_mask.clear(); paged_prev_mask.shrink_to_fit();
    paged_solid_mask.clear(); paged_solid_mask.shrink_to_fit();
    paged_solid_vel.clear(); paged_solid_vel.shrink_to_fit();
    paged_tile_boundary.clear(); paged_tile_boundary.shrink_to_fit();

    // Rebuild compact active tile index after paging in
    const_cast<CFDSolver3DCuda*>(this)->rebuildActiveIndex();

    is_paged_out = false;
    constants_dirty = true;
    bind_constants();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::bind_constants() const {
    static thread_local const void* active_solver_instance = nullptr;
    if (!constants_dirty && active_solver_instance == this) return;
    active_solver_instance = this;
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
    bool is_water_flag = this->is_water_tait_val;
    CHECK_CUDA(cudaMemcpyToSymbol(d_isWater, &is_water_flag, sizeof(bool)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_taitParams, &this->tait_water_params, sizeof(Blast::TaitEOSParams)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_stratParams, &this->stratified_params, sizeof(Blast::Stratified3DParams)));
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
        CHECK_CUDA(cudaMemcpyToSymbol(d_detonation_energy, &currentMaterials.detonation_energy, sizeof(double)));
        CHECK_CUDA(cudaMemcpyToSymbol(d_afterburn, &currentMaterials.afterburn, sizeof(MultiMat::AfterburnParams)));
    }
    CHECK_CUDA(cudaMemcpyToSymbol(d_charge_radius, &charge_radius, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_detX, &detX, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_detY, &detY, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_detZ, &detZ, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_gravity_x, &this->gravity_x, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_gravity_y, &this->gravity_y, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_gravity_z, &this->gravity_z, sizeof(double)));
    bool has_grav = (this->gravity_x != 0.0 || this->gravity_y != 0.0 || this->gravity_z != 0.0);
    CHECK_CUDA(cudaMemcpyToSymbol(d_has_gravity, &has_grav, sizeof(bool)));
    unsigned long long states_orig_val = (unsigned long long)d_states;
    unsigned long long active_tiles_val = (unsigned long long)d_active_tiles;
    CHECK_CUDA(cudaMemcpyToSymbol(d_states_orig_global, &states_orig_val, sizeof(unsigned long long)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_active_tiles_global, &active_tiles_val, sizeof(unsigned long long)));
    CHECK_CUDA(cudaDeviceSynchronize());
    constants_dirty = false;
}

template <typename RealType, bool IsMultiMaterial>
__global__ void copy_active_primitive_tiles_kernel_3d(
    PrimitivePredictorTile3D<RealType, IsMultiMaterial>* __restrict__ dst,
    const PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ src,
    const int* __restrict__ active_tile_indices
) {
    int t_idx = active_tile_indices[blockIdx.x];
    int tid = threadIdx.x; // 0..511 (8x8x8)
    
    dst[t_idx].rho[tid] = src[t_idx].rho[tid];
    dst[t_idx].ux[tid]  = src[t_idx].ux[tid];
    dst[t_idx].uy[tid]  = src[t_idx].uy[tid];
    dst[t_idx].uz[tid]  = src[t_idx].uz[tid];
    dst[t_idx].p[tid]   = src[t_idx].p[tid];
    if constexpr (IsMultiMaterial) {
        dst[t_idx].alpha1[tid] = src[t_idx].alpha1[tid];
        dst[t_idx].alpha2[tid] = src[t_idx].alpha2[tid];
        dst[t_idx].arho1[tid]  = src[t_idx].arho1[tid];
        dst[t_idx].arho2[tid]  = src[t_idx].arho2[tid];
    }
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
        CHECK_CUDA(cudaMemcpyToSymbol(d_afterburn, &materials.afterburn, sizeof(MultiMat::AfterburnParams)));
    }
    double ch_rad = charge.radius;
    CHECK_CUDA(cudaMemcpyToSymbol(d_charge_radius, &ch_rad, sizeof(double)));
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
    last_cached_tile_idx = -1;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setStratifiedInitialCondition(
    const Charge3DParams& charge, const MultiMat::MaterialSet& materials, const Blast::Stratified3DParams& strat) {
    this->stratified_params = strat;
    this->stratified_params.enabled = true;
    this->stratified_params.charge_x = charge.x;
    this->stratified_params.charge_y = charge.y;
    this->stratified_params.charge_z = charge.z;
    this->stratified_params.charge_radius = charge.radius;
    int gz_seabed = max(1, (int)round((strat.seabed_surface_z - zmin) / cellSize));
    this->stratified_params.seabed_surface_z = zmin + (double)gz_seabed * (double)cellSize;
    this->tait_water_params.B = strat.tait_B;
    this->tait_water_params.gamma = strat.tait_gamma;
    this->tait_water_params.rho0 = strat.tait_rho0;
    this->tait_water_params.p0 = strat.p_atm;
    this->tait_water_params.gruneisen = 0.28;
    this->is_water_tait_val = true;
    if (strat.gravity_z != 0.0) {
        this->setGravity(0.0, 0.0, strat.gravity_z);
    }
    ambient_rho = strat.air_rho;
    ambient_p = strat.p_atm;
    constants_dirty = true;
    bind_constants();
    CHECK_CUDA(cudaMemcpyToSymbol(d_stratParams, &this->stratified_params, sizeof(Blast::Stratified3DParams)));
    currentMaterials = materials;
    CHECK_CUDA(cudaMemcpyToSymbol(d_ambient_rho, &strat.air_rho, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_ambient_p, &strat.p_atm, sizeof(double)));
    if constexpr (IsMultiMaterial) {
        CHECK_CUDA(cudaMemcpyToSymbol(d_products, &materials.products, sizeof(MultiMat::JWLParams)));
        CHECK_CUDA(cudaMemcpyToSymbol(d_unreacted, &materials.unreacted, sizeof(MultiMat::JWLParams)));
        CHECK_CUDA(cudaMemcpyToSymbol(d_det_vel, &materials.det_vel, sizeof(double)));
        CHECK_CUDA(cudaMemcpyToSymbol(d_detonation_energy, &materials.detonation_energy, sizeof(double)));
        CHECK_CUDA(cudaMemcpyToSymbol(d_afterburn, &materials.afterburn, sizeof(MultiMat::AfterburnParams)));
    }
    double ch_rad = charge.radius;
    CHECK_CUDA(cudaMemcpyToSymbol(d_charge_radius, &ch_rad, sizeof(double)));
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

    set_stratified_initial_condition_kernel<RealType, IsMultiMaterial><<<blocks, threads>>>(
        (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U, (uint8_t*)d_active_tiles,
        nx, ny, nz, (RealType)cellSize, (RealType)xmin, (RealType)ymin, (RealType)zmin,
        (RealType)gamma, charge,
        (RealType)materials.unreacted.rho0, (RealType)materials.detonation_energy, (RealType)materials.det_vel,
        this->stratified_params
    );
    CHECK_CUDA(cudaDeviceSynchronize());
    updateActiveRegions();
    last_cached_tile_idx = -1;
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

    int tx = t_idx % d_ntx;
    int ty = (t_idx / d_ntx) % d_nty;
    int tz = t_idx / (d_ntx * d_nty);
    int gz = tz * TILE_SIZE_3D + lz;
    RealType z_c = (RealType)d_zmin + ((RealType)gz + (RealType)0.5) * (RealType)d_cellSize;
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
        bool is_water = is_cell_water(rho, z_c, a1 + a2);
        bool is_soil = is_cell_soil(rho, z_c);
        if (is_water) {
            total_E = MultiMat::getMixtureEnergyTait<RealType>(p, rho, a1, a2, ar1, ar2, d_taitParams, products, unreacted) + ke;
        } else if (is_soil) {
            total_E = computeFluidEnergyGPU<RealType>(p, rho, (RealType)gamma, z_c) + ke;
        } else {
            total_E = MultiMat::getMixtureEnergy<RealType>(p, rho, a1, a2, ar1, ar2, (RealType)gamma, products, unreacted) + ke;
        }
    } else {
        total_E = computeFluidEnergyGPU<RealType>(p, rho, (RealType)gamma, z_c) + ke;
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
__device__ __noinline__ void computeTimeDerivativeGPU(
    const GPUCellStateT<RealType, IsMultiMaterial>& sC,
    const GPUCellStateT<RealType, IsMultiMaterial>& d_x,
    const GPUCellStateT<RealType, IsMultiMaterial>& d_y,
    const GPUCellStateT<RealType, IsMultiMaterial>& d_z,
    RealType gamma_r,
    GPUCellStateT<RealType, IsMultiMaterial>& dW_dt,
    RealType z_c = (RealType)0.0) {
    
    dW_dt.rho = -(sC.ux * d_x.rho + sC.rho * d_x.ux +
                  sC.uy * d_y.rho + sC.rho * d_y.uy +
                  sC.uz * d_z.rho + sC.rho * d_z.uz);
                  
    dW_dt.ux = -(sC.ux * d_x.ux + sC.uy * d_y.ux + sC.uz * d_z.ux + (RealType)1.0 / sC.rho * d_x.p);
    dW_dt.uy = -(sC.ux * d_x.uy + sC.uy * d_y.uy + sC.uz * d_z.uy + (RealType)1.0 / sC.rho * d_y.p);
    dW_dt.uz = -(sC.ux * d_x.uz + sC.uy * d_y.uz + sC.uz * d_z.uz + (RealType)1.0 / sC.rho * d_z.p);
    if (d_has_gravity) {
        dW_dt.ux += (RealType)d_gravity_x;
        dW_dt.uy += (RealType)d_gravity_y;
        dW_dt.uz += (RealType)d_gravity_z;
    }
    
    RealType c_sound = computeCellSoundSpeedGPU<RealType, IsMultiMaterial>(sC, z_c, gamma_r);
    RealType bulk_k = sC.rho * c_sound * c_sound;
    dW_dt.p = -(sC.ux * d_x.p + sC.uy * d_y.p + sC.uz * d_z.p + bulk_k * (d_x.ux + d_y.uy + d_z.uz));
    
    if constexpr (IsMultiMaterial) {
        dW_dt.alpha1 = -(sC.ux * d_x.alpha1 + sC.uy * d_y.alpha1 + sC.uz * d_z.alpha1) + sC.alpha1 * (d_x.ux + d_y.uy + d_z.uz);
        dW_dt.alpha2 = -(sC.ux * d_x.alpha2 + sC.uy * d_y.alpha2 + sC.uz * d_z.alpha2) + sC.alpha2 * (d_x.ux + d_y.uy + d_z.uz);
        
        dW_dt.arho1 = -(sC.ux * d_x.arho1 + sC.arho1 * d_x.ux +
                        sC.uy * d_y.arho1 + sC.arho1 * d_y.uy +
                        sC.uz * d_z.arho1 + sC.arho1 * d_z.uz);
        dW_dt.arho2 = dW_dt.rho - dW_dt.arho1;
    }
}

template <typename RealType, bool IsMultiMaterial, int SpatialOrder>
__global__ void __launch_bounds__(512) predict_states_gpu_kernel_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states,
    PrimitivePredictorTile3D<RealType, IsMultiMaterial>* __restrict__ states_pred,
    PrimitivePredictorTile3D<RealType, IsMultiMaterial>* __restrict__ dW_dt_pool,
    const int* __restrict__ active_tile_indices,
    const uint8_t* __restrict__ tile_is_near_boundary,
    const GeometryTile3D* __restrict__ geom,
    RealType dt,
    RealType gamma_r,
    int temporalOrder
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

    bool is_near_boundary = tile_is_near_boundary ? (tile_is_near_boundary[t_idx] != 0) : false;
    if (geom && geom[t_idx].cells[c_idx].is_boundary) return;

    GPUCellStateT<RealType, IsMultiMaterial> sC;
    {
        const auto& tile = states[t_idx];
        sC.rho = tile.rho[c_idx];
        sC.ux = tile.ux[c_idx];
        sC.uy = tile.uy[c_idx];
        sC.uz = tile.uz[c_idx];
        sC.p = tile.p[c_idx];
        sC.E = (RealType)0.0;
        sC.peak_overpressure = tile.peak_overpressure[c_idx];
        sC.peak_impulse = tile.peak_impulse[c_idx];
        if constexpr (IsMultiMaterial) {
            sC.alpha1 = tile.alpha1[c_idx];
            sC.alpha2 = tile.alpha2[c_idx];
            sC.arho1 = tile.arho1[c_idx];
            sC.arho2 = tile.arho2[c_idx];
        }
    }

    GPUCellStateT<RealType, IsMultiMaterial> d_x, d_y, d_z;
    RealType invDx = (RealType)1.0 / (RealType)d_cellSize;

    if (temporalOrder == 4) {
        GPUCellStateT<RealType, IsMultiMaterial> sL_x, sR_x;
        reconstruct_gpu<RealType, IsMultiMaterial, SpatialOrder>(states, geom, gx, gy, gz, 0, sL_x, sR_x, gx, gy, gz, is_near_boundary);
        GPUCellStateT<RealType, IsMultiMaterial> sL_xP1, sR_xP1;
        reconstruct_gpu<RealType, IsMultiMaterial, SpatialOrder>(states, geom, gx + 1, gy, gz, 0, sL_xP1, sR_xP1, gx, gy, gz, is_near_boundary);

        GPUCellStateT<RealType, IsMultiMaterial> sL_y, sR_y;
        reconstruct_gpu<RealType, IsMultiMaterial, SpatialOrder>(states, geom, gx, gy, gz, 1, sL_y, sR_y, gx, gy, gz, is_near_boundary);
        GPUCellStateT<RealType, IsMultiMaterial> sL_yP1, sR_yP1;
        reconstruct_gpu<RealType, IsMultiMaterial, SpatialOrder>(states, geom, gx, gy + 1, gz, 1, sL_yP1, sR_yP1, gx, gy, gz, is_near_boundary);

        GPUCellStateT<RealType, IsMultiMaterial> sL_z, sR_z;
        reconstruct_gpu<RealType, IsMultiMaterial, SpatialOrder>(states, geom, gx, gy, gz, 2, sL_z, sR_z, gx, gy, gz, is_near_boundary);
        GPUCellStateT<RealType, IsMultiMaterial> sL_zP1, sR_zP1;
        reconstruct_gpu<RealType, IsMultiMaterial, SpatialOrder>(states, geom, gx, gy, gz + 1, 2, sL_zP1, sR_zP1, gx, gy, gz, is_near_boundary);

        d_x.rho = (sL_xP1.rho - sR_x.rho) * invDx;
        d_x.ux = (sL_xP1.ux - sR_x.ux) * invDx;
        d_x.uy = (sL_xP1.uy - sR_x.uy) * invDx;
        d_x.uz = (sL_xP1.uz - sR_x.uz) * invDx;
        d_x.p = (sL_xP1.p - sR_x.p) * invDx;
        if constexpr (IsMultiMaterial) {
            d_x.alpha1 = (sL_xP1.alpha1 - sR_x.alpha1) * invDx;
            d_x.alpha2 = (sL_xP1.alpha2 - sR_x.alpha2) * invDx;
            d_x.arho1 = (sL_xP1.arho1 - sR_x.arho1) * invDx;
        }

        d_y.rho = (sL_yP1.rho - sR_y.rho) * invDx;
        d_y.ux = (sL_yP1.ux - sR_y.ux) * invDx;
        d_y.uy = (sL_yP1.uy - sR_y.uy) * invDx;
        d_y.uz = (sL_yP1.uz - sR_y.uz) * invDx;
        d_y.p = (sL_yP1.p - sR_y.p) * invDx;
        if constexpr (IsMultiMaterial) {
            d_y.alpha1 = (sL_yP1.alpha1 - sR_y.alpha1) * invDx;
            d_y.alpha2 = (sL_yP1.alpha2 - sR_y.alpha2) * invDx;
            d_y.arho1 = (sL_yP1.arho1 - sR_y.arho1) * invDx;
        }

        d_z.rho = (sL_zP1.rho - sR_z.rho) * invDx;
        d_z.ux = (sL_zP1.ux - sR_z.ux) * invDx;
        d_z.uy = (sL_zP1.uy - sR_z.uy) * invDx;
        d_z.uz = (sL_zP1.uz - sR_z.uz) * invDx;
        d_z.p = (sL_zP1.p - sR_z.p) * invDx;
        if constexpr (IsMultiMaterial) {
            d_z.alpha1 = (sL_zP1.alpha1 - sR_z.alpha1) * invDx;
            d_z.alpha2 = (sL_zP1.alpha2 - sR_z.alpha2) * invDx;
            d_z.arho1 = (sL_zP1.arho1 - sR_z.arho1) * invDx;
        }
        if (is_near_boundary && geom) {
            // Suppress ALL slopes in each direction near solid boundaries
            // to prevent predictor overshoot at shock-wall interactions
            if (is_solid_cell_gpu(geom, gx - 1, gy, gz) || is_solid_cell_gpu(geom, gx + 1, gy, gz)) {
                d_x.rho = (RealType)0.0; d_x.ux = (RealType)0.0; d_x.uy = (RealType)0.0;
                d_x.uz = (RealType)0.0; d_x.p = (RealType)0.0;
                if constexpr (IsMultiMaterial) { d_x.alpha1 = (RealType)0.0; d_x.alpha2 = (RealType)0.0; d_x.arho1 = (RealType)0.0; }
            }
            if (is_solid_cell_gpu(geom, gx, gy - 1, gz) || is_solid_cell_gpu(geom, gx, gy + 1, gz)) {
                d_y.rho = (RealType)0.0; d_y.ux = (RealType)0.0; d_y.uy = (RealType)0.0;
                d_y.uz = (RealType)0.0; d_y.p = (RealType)0.0;
                if constexpr (IsMultiMaterial) { d_y.alpha1 = (RealType)0.0; d_y.alpha2 = (RealType)0.0; d_y.arho1 = (RealType)0.0; }
            }
            if (is_solid_cell_gpu(geom, gx, gy, gz - 1) || is_solid_cell_gpu(geom, gx, gy, gz + 1)) {
                d_z.rho = (RealType)0.0; d_z.ux = (RealType)0.0; d_z.uy = (RealType)0.0;
                d_z.uz = (RealType)0.0; d_z.p = (RealType)0.0;
                if constexpr (IsMultiMaterial) { d_z.alpha1 = (RealType)0.0; d_z.alpha2 = (RealType)0.0; d_z.arho1 = (RealType)0.0; }
            }
        }
        if (d_stratParams.enabled) {
            RealType z_C = (RealType)d_zmin + ((RealType)gz + (RealType)0.5) * (RealType)d_cellSize;
            RealType z_D = z_C - (RealType)d_cellSize;
            RealType z_U = z_C + (RealType)d_cellSize;
            GPUCellStateT<RealType, IsMultiMaterial> sZ_D, sZ_U;
            if (is_near_boundary) {
                sZ_D = sample_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz - 1, gx, gy, gz, 2, true);
                sZ_U = sample_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz + 1, gx, gy, gz, 2, true);
            } else {
                sZ_D = sample_gpu_raw<RealType, IsMultiMaterial>(states, gx, gy, gz - 1);
                sZ_U = sample_gpu_raw<RealType, IsMultiMaterial>(states, gx, gy, gz + 1);
            }
            bool soil_C = is_cell_soil(sC.rho, z_C);
            bool soil_D = is_cell_soil(sZ_D.rho, z_D);
            bool soil_U = is_cell_soil(sZ_U.rho, z_U);
            bool water_C = false, water_D = false, water_U = false;
            if constexpr (IsMultiMaterial) {
                water_C = is_cell_water(sC.rho, z_C, sC.alpha1 + sC.alpha2);
                water_D = is_cell_water(sZ_D.rho, z_D, sZ_D.alpha1 + sZ_D.alpha2);
                water_U = is_cell_water(sZ_U.rho, z_U, sZ_U.alpha1 + sZ_U.alpha2);
            } else {
                water_C = is_cell_water(sC.rho, z_C);
                water_D = is_cell_water(sZ_D.rho, z_D);
                water_U = is_cell_water(sZ_U.rho, z_U);
            }
            bool mat_diff_D = (soil_C != soil_D || water_C != water_D);
            bool mat_diff_U = (soil_C != soil_U || water_C != water_U);

            if (mat_diff_D && !mat_diff_U) {
                RealType dp_hydro = d_has_gravity ? (sC.rho * (RealType)d_gravity_z) : (RealType)0.0;
                RealType dp_pert_U = (sZ_U.p - sC.p) * invDx - dp_hydro;
                d_z.p = dp_hydro + dp_pert_U;
                d_z.rho = (sZ_U.rho - sC.rho) * invDx;
                d_z.ux  = (sZ_U.ux - sC.ux) * invDx;
                d_z.uy  = (sZ_U.uy - sC.uy) * invDx;
                d_z.uz  = (sZ_U.uz - sC.uz) * invDx;
                if constexpr (IsMultiMaterial) {
                    d_z.alpha1 = (sZ_U.alpha1 - sC.alpha1) * invDx;
                    d_z.alpha2 = (sZ_U.alpha2 - sC.alpha2) * invDx;
                    d_z.arho1  = (sZ_U.arho1 - sC.arho1) * invDx;
                }
            } else if (mat_diff_U && !mat_diff_D) {
                RealType dp_hydro = d_has_gravity ? (sC.rho * (RealType)d_gravity_z) : (RealType)0.0;
                RealType dp_pert_D = (sC.p - sZ_D.p) * invDx - dp_hydro;
                d_z.p = dp_hydro + dp_pert_D;
                d_z.rho = (sC.rho - sZ_D.rho) * invDx;
                d_z.ux  = (sC.ux - sZ_D.ux) * invDx;
                d_z.uy  = (sC.uy - sZ_D.uy) * invDx;
                d_z.uz  = (sC.uz - sZ_D.uz) * invDx;
                if constexpr (IsMultiMaterial) {
                    d_z.alpha1 = (sC.alpha1 - sZ_D.alpha1) * invDx;
                    d_z.alpha2 = (sC.alpha2 - sZ_D.alpha2) * invDx;
                    d_z.arho1  = (sC.arho1 - sZ_D.arho1) * invDx;
                }
            } else if (mat_diff_D && mat_diff_U) {
                d_z.rho = minmod_gpu(sC.rho - sZ_D.rho, sZ_U.rho - sC.rho) * invDx;
                d_z.ux  = minmod_gpu(sC.ux - sZ_D.ux, sZ_U.ux - sC.ux) * invDx;
                d_z.uy  = minmod_gpu(sC.uy - sZ_D.uy, sZ_U.uy - sC.uy) * invDx;
                d_z.uz  = minmod_gpu(sC.uz - sZ_D.uz, sZ_U.uz - sC.uz) * invDx;
                d_z.p   = minmod_gpu(sC.p - sZ_D.p, sZ_U.p - sC.p) * invDx;
                if constexpr (IsMultiMaterial) {
                    d_z.alpha1 = minmod_gpu(sC.alpha1 - sZ_D.alpha1, sZ_U.alpha1 - sC.alpha1) * invDx;
                    d_z.alpha2 = minmod_gpu(sC.alpha2 - sZ_D.alpha2, sZ_U.alpha2 - sC.alpha2) * invDx;
                    d_z.arho1  = minmod_gpu(sC.arho1 - sZ_D.arho1, sZ_U.arho1 - sC.arho1) * invDx;
                }
            }
        }
    } else {
        GPUCellStateT<RealType, IsMultiMaterial> sX_L, sX_R, sY_B, sY_T, sZ_D, sZ_U;
        if (is_near_boundary) {
            sX_L = sample_gpu<RealType, IsMultiMaterial>(states, geom, gx - 1, gy, gz, gx, gy, gz, 0, true);
            sX_R = sample_gpu<RealType, IsMultiMaterial>(states, geom, gx + 1, gy, gz, gx, gy, gz, 0, true);
            sY_B = sample_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy - 1, gz, gx, gy, gz, 1, true);
            sY_T = sample_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy + 1, gz, gx, gy, gz, 1, true);
            sZ_D = sample_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz - 1, gx, gy, gz, 2, true);
            sZ_U = sample_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz + 1, gx, gy, gz, 2, true);
        } else {
            sX_L = sample_gpu_raw<RealType, IsMultiMaterial>(states, gx - 1, gy, gz);
            sX_R = sample_gpu_raw<RealType, IsMultiMaterial>(states, gx + 1, gy, gz);
            sY_B = sample_gpu_raw<RealType, IsMultiMaterial>(states, gx, gy - 1, gz);
            sY_T = sample_gpu_raw<RealType, IsMultiMaterial>(states, gx, gy + 1, gz);
            sZ_D = sample_gpu_raw<RealType, IsMultiMaterial>(states, gx, gy, gz - 1);
            sZ_U = sample_gpu_raw<RealType, IsMultiMaterial>(states, gx, gy, gz + 1);
        }

        bool solid_x_L = is_near_boundary && is_solid_cell_gpu(geom, gx - 1, gy, gz);
        bool solid_x_R = is_near_boundary && is_solid_cell_gpu(geom, gx + 1, gy, gz);
        bool is_confined_x = solid_x_L && solid_x_R;

        bool solid_y_B = is_near_boundary && is_solid_cell_gpu(geom, gx, gy - 1, gz);
        bool solid_y_T = is_near_boundary && is_solid_cell_gpu(geom, gx, gy + 1, gz);
        bool is_confined_y = solid_y_B && solid_y_T;

        bool solid_z_D = is_near_boundary && is_solid_cell_gpu(geom, gx, gy, gz - 1);
        bool solid_z_U = is_near_boundary && is_solid_cell_gpu(geom, gx, gy, gz + 1);
        bool is_confined_z = solid_z_D && solid_z_U;

        auto slope = [=](RealType L, RealType C, RealType R) {
            return minmod_gpu(C - L, R - C) * invDx;
        };

        if (is_confined_x) {
            d_x.rho = (RealType)0.0;
            d_x.ux  = (RealType)0.0;
            d_x.uy  = (RealType)0.0;
            d_x.uz  = (RealType)0.0;
            d_x.p   = (RealType)0.0;
            if constexpr (IsMultiMaterial) {
                d_x.alpha1 = (RealType)0.0;
                d_x.alpha2 = (RealType)0.0;
                d_x.arho1  = (RealType)0.0;
            }
        } else if (solid_x_L || solid_x_R) {
            // Suppress ALL slopes near solid boundaries to prevent predictor overshoot
            d_x.rho = (RealType)0.0;
            d_x.ux  = (RealType)0.0;
            d_x.uy  = (RealType)0.0;
            d_x.uz  = (RealType)0.0;
            d_x.p   = (RealType)0.0;
            if constexpr (IsMultiMaterial) {
                d_x.alpha1 = (RealType)0.0;
                d_x.alpha2 = (RealType)0.0;
                d_x.arho1  = (RealType)0.0;
            }
        } else {
            d_x.rho = slope(sX_L.rho, sC.rho, sX_R.rho);
            d_x.ux = slope(sX_L.ux, sC.ux, sX_R.ux);
            d_x.uy = slope(sX_L.uy, sC.uy, sX_R.uy);
            d_x.uz = slope(sX_L.uz, sC.uz, sX_R.uz);
            d_x.p = slope(sX_L.p, sC.p, sX_R.p);
            if constexpr (IsMultiMaterial) {
                d_x.alpha1 = slope(sX_L.alpha1, sC.alpha1, sX_R.alpha1);
                d_x.alpha2 = slope(sX_L.alpha2, sC.alpha2, sX_R.alpha2);
                d_x.arho1 = slope(sX_L.arho1, sC.arho1, sX_R.arho1);
            }
        }

        if (is_confined_y) {
            d_y.rho = (RealType)0.0;
            d_y.ux  = (RealType)0.0;
            d_y.uy  = (RealType)0.0;
            d_y.uz  = (RealType)0.0;
            d_y.p   = (RealType)0.0;
            if constexpr (IsMultiMaterial) {
                d_y.alpha1 = (RealType)0.0;
                d_y.alpha2 = (RealType)0.0;
                d_y.arho1  = (RealType)0.0;
            }
        } else if (solid_y_B || solid_y_T) {
            // Suppress ALL slopes near solid boundaries to prevent predictor overshoot
            d_y.rho = (RealType)0.0;
            d_y.ux  = (RealType)0.0;
            d_y.uy  = (RealType)0.0;
            d_y.uz  = (RealType)0.0;
            d_y.p   = (RealType)0.0;
            if constexpr (IsMultiMaterial) {
                d_y.alpha1 = (RealType)0.0;
                d_y.alpha2 = (RealType)0.0;
                d_y.arho1  = (RealType)0.0;
            }
        } else {
            d_y.rho = slope(sY_B.rho, sC.rho, sY_T.rho);
            d_y.ux = slope(sY_B.ux, sC.ux, sY_T.ux);
            d_y.uy = slope(sY_B.uy, sC.uy, sY_T.uy);
            d_y.uz = slope(sY_B.uz, sC.uz, sY_T.uz);
            d_y.p = slope(sY_B.p, sC.p, sY_T.p);
            if constexpr (IsMultiMaterial) {
                d_y.alpha1 = slope(sY_B.alpha1, sC.alpha1, sY_T.alpha1);
                d_y.alpha2 = slope(sY_B.alpha2, sC.alpha2, sY_T.alpha2);
                d_y.arho1 = slope(sY_B.arho1, sC.arho1, sY_T.arho1);
            }
        }

        if (is_confined_z) {
            d_z.rho = (RealType)0.0;
            d_z.ux  = (RealType)0.0;
            d_z.uy  = (RealType)0.0;
            d_z.uz  = (RealType)0.0;
            d_z.p   = (RealType)0.0;
            if constexpr (IsMultiMaterial) {
                d_z.alpha1 = (RealType)0.0;
                d_z.alpha2 = (RealType)0.0;
                d_z.arho1  = (RealType)0.0;
            }
        } else if (solid_z_D || solid_z_U) {
            // Suppress ALL slopes near solid boundaries to prevent predictor overshoot
            d_z.rho = (RealType)0.0;
            d_z.ux  = (RealType)0.0;
            d_z.uy  = (RealType)0.0;
            d_z.uz  = (RealType)0.0;
            d_z.p   = (RealType)0.0;
            if constexpr (IsMultiMaterial) {
                d_z.alpha1 = (RealType)0.0;
                d_z.alpha2 = (RealType)0.0;
                d_z.arho1  = (RealType)0.0;
            }
        } else {
            bool mat_diff_D = false;
            bool mat_diff_U = false;
            if (d_stratParams.enabled) {
                RealType z_C = (RealType)d_zmin + ((RealType)gz + (RealType)0.5) * (RealType)d_cellSize;
                RealType z_D = z_C - (RealType)d_cellSize;
                RealType z_U = z_C + (RealType)d_cellSize;
                bool soil_C = is_cell_soil(sC.rho, z_C);
                bool soil_D = is_cell_soil(sZ_D.rho, z_D);
                bool soil_U = is_cell_soil(sZ_U.rho, z_U);
                bool water_C = false, water_D = false, water_U = false;
                if constexpr (IsMultiMaterial) {
                    water_C = is_cell_water(sC.rho, z_C, sC.alpha1 + sC.alpha2);
                    water_D = is_cell_water(sZ_D.rho, z_D, sZ_D.alpha1 + sZ_D.alpha2);
                    water_U = is_cell_water(sZ_U.rho, z_U, sZ_U.alpha1 + sZ_U.alpha2);
                } else {
                    water_C = is_cell_water(sC.rho, z_C);
                    water_D = is_cell_water(sZ_D.rho, z_D);
                    water_U = is_cell_water(sZ_U.rho, z_U);
                }
                mat_diff_D = (soil_C != soil_D || water_C != water_D);
                mat_diff_U = (soil_C != soil_U || water_C != water_U);
            }
            if (mat_diff_D && !mat_diff_U) {
                RealType dp_hydro = d_has_gravity ? (sC.rho * (RealType)d_gravity_z) : (RealType)0.0;
                RealType dp_pert_U = (sZ_U.p - sC.p) * invDx - dp_hydro;
                d_z.p = dp_hydro + dp_pert_U;
                d_z.rho = (sZ_U.rho - sC.rho) * invDx;
                d_z.ux  = (sZ_U.ux - sC.ux) * invDx;
                d_z.uy  = (sZ_U.uy - sC.uy) * invDx;
                d_z.uz  = (sZ_U.uz - sC.uz) * invDx;
                if constexpr (IsMultiMaterial) {
                    d_z.alpha1 = (sZ_U.alpha1 - sC.alpha1) * invDx;
                    d_z.alpha2 = (sZ_U.alpha2 - sC.alpha2) * invDx;
                    d_z.arho1  = (sZ_U.arho1 - sC.arho1) * invDx;
                }
            } else if (mat_diff_U && !mat_diff_D) {
                RealType dp_hydro = d_has_gravity ? (sC.rho * (RealType)d_gravity_z) : (RealType)0.0;
                RealType dp_pert_D = (sC.p - sZ_D.p) * invDx - dp_hydro;
                d_z.p = dp_hydro + dp_pert_D;
                d_z.rho = (sC.rho - sZ_D.rho) * invDx;
                d_z.ux  = (sC.ux - sZ_D.ux) * invDx;
                d_z.uy  = (sC.uy - sZ_D.uy) * invDx;
                d_z.uz  = (sC.uz - sZ_D.uz) * invDx;
                if constexpr (IsMultiMaterial) {
                    d_z.alpha1 = (sC.alpha1 - sZ_D.alpha1) * invDx;
                    d_z.alpha2 = (sC.alpha2 - sZ_D.alpha2) * invDx;
                    d_z.arho1  = (sC.arho1 - sZ_D.arho1) * invDx;
                }
            } else if (mat_diff_D && mat_diff_U) {
                d_z.rho = slope(sZ_D.rho, sC.rho, sZ_U.rho);
                d_z.ux  = slope(sZ_D.ux, sC.ux, sZ_U.ux);
                d_z.uy  = slope(sZ_D.uy, sC.uy, sZ_U.uy);
                d_z.uz  = slope(sZ_D.uz, sC.uz, sZ_U.uz);
                d_z.p   = slope(sZ_D.p, sC.p, sZ_U.p);
                if constexpr (IsMultiMaterial) {
                    d_z.alpha1 = slope(sZ_D.alpha1, sC.alpha1, sZ_U.alpha1);
                    d_z.alpha2 = slope(sZ_D.alpha2, sC.alpha2, sZ_U.alpha2);
                    d_z.arho1  = slope(sZ_D.arho1, sC.arho1, sZ_U.arho1);
                }
            } else {
                d_z.rho = slope(sZ_D.rho, sC.rho, sZ_U.rho);
                d_z.ux = slope(sZ_D.ux, sC.ux, sZ_U.ux);
                d_z.uy = slope(sZ_D.uy, sC.uy, sZ_U.uy);
                d_z.uz = slope(sZ_D.uz, sC.uz, sZ_U.uz);
                d_z.p = slope(sZ_D.p, sC.p, sZ_U.p);
                if constexpr (IsMultiMaterial) {
                    d_z.alpha1 = slope(sZ_D.alpha1, sC.alpha1, sZ_U.alpha1);
                    d_z.alpha2 = slope(sZ_D.alpha2, sC.alpha2, sZ_U.alpha2);
                    d_z.arho1 = slope(sZ_D.arho1, sC.arho1, sZ_U.arho1);
                }
            }
        }
    }

    GPUCellStateT<RealType, IsMultiMaterial> dW_dt;
    RealType z_c = (RealType)d_zmin + ((RealType)gz + (RealType)0.5) * (RealType)d_cellSize;
    computeTimeDerivativeGPU<RealType, IsMultiMaterial>(sC, d_x, d_y, d_z, gamma_r, dW_dt, z_c);

    if (dW_dt_pool) {
        auto& dW_dt_tile = dW_dt_pool[t_idx];
        dW_dt_tile.rho[c_idx] = dW_dt.rho;
        dW_dt_tile.ux[c_idx] = dW_dt.ux;
        dW_dt_tile.uy[c_idx] = dW_dt.uy;
        dW_dt_tile.uz[c_idx] = dW_dt.uz;
        dW_dt_tile.p[c_idx] = dW_dt.p;
        if constexpr (IsMultiMaterial) {
            dW_dt_tile.alpha1[c_idx] = dW_dt.alpha1;
            dW_dt_tile.alpha2[c_idx] = dW_dt.alpha2;
            dW_dt_tile.arho1[c_idx] = dW_dt.arho1;
            dW_dt_tile.arho2[c_idx] = dW_dt.arho2;
        }
    }

    auto& s_pred_tile = states_pred[t_idx];
    RealType rho_pred = sC.rho + (RealType)0.5 * dt * dW_dt.rho;
    RealType p_pred = sC.p + (RealType)0.5 * dt * dW_dt.p;
    s_pred_tile.rho[c_idx] = fmax((RealType)1e-7, rho_pred);
    s_pred_tile.ux[c_idx] = sC.ux + (RealType)0.5 * dt * dW_dt.ux;
    s_pred_tile.uy[c_idx] = sC.uy + (RealType)0.5 * dt * dW_dt.uy;
    s_pred_tile.uz[c_idx] = sC.uz + (RealType)0.5 * dt * dW_dt.uz;
    s_pred_tile.p[c_idx] = fmax((RealType)1e-7, p_pred);
    if constexpr (IsMultiMaterial) {
        s_pred_tile.alpha1[c_idx] = fmax((RealType)0.0, fmin((RealType)1.0, sC.alpha1 + (RealType)0.5 * dt * dW_dt.alpha1));
        s_pred_tile.alpha2[c_idx] = fmax((RealType)0.0, fmin((RealType)1.0, sC.alpha2 + (RealType)0.5 * dt * dW_dt.alpha2));
        s_pred_tile.arho1[c_idx] = fmax((RealType)0.0, fmin(s_pred_tile.rho[c_idx], sC.arho1 + (RealType)0.5 * dt * dW_dt.arho1));
        s_pred_tile.arho2[c_idx] = fmax((RealType)0.0, fmin(s_pred_tile.rho[c_idx], sC.arho2 + (RealType)0.5 * dt * dW_dt.arho2));
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) predict_states_ader3_gpu_kernel_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states_orig,
    const PrimitivePredictorTile3D<RealType, IsMultiMaterial>* states_mid,
    const PrimitivePredictorTile3D<RealType, IsMultiMaterial>* __restrict__ dW_dt_orig_pool,
    PrimitivePredictorTile3D<RealType, IsMultiMaterial>* states_int,
    const int* __restrict__ active_tile_indices,
    const uint8_t* __restrict__ tile_is_near_boundary,
    const GeometryTile3D* __restrict__ geom,
    RealType dt,
    RealType gamma_r
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

    bool is_near_boundary = tile_is_near_boundary ? (tile_is_near_boundary[t_idx] != 0) : false;
    if (geom && geom[t_idx].cells[c_idx].is_boundary) return;

    GPUCellStateT<RealType, IsMultiMaterial> sC;
    {
        const auto& tile = states_mid[t_idx];
        sC.rho = tile.rho[c_idx];
        sC.ux = tile.ux[c_idx];
        sC.uy = tile.uy[c_idx];
        sC.uz = tile.uz[c_idx];
        sC.p = tile.p[c_idx];
        sC.E = (RealType)0.0;
        sC.peak_overpressure = (RealType)0.0;
        sC.peak_impulse = (RealType)0.0;
        if constexpr (IsMultiMaterial) {
            sC.alpha1 = tile.alpha1[c_idx];
            sC.alpha2 = tile.alpha2[c_idx];
            sC.arho1 = tile.arho1[c_idx];
            sC.arho2 = tile.arho2[c_idx];
        }
    }

    GPUCellStateT<RealType, IsMultiMaterial> sX_L, sX_R, sY_B, sY_T, sZ_D, sZ_U;
    if (is_near_boundary) {
        sX_L = sample_gpu<RealType, IsMultiMaterial, PrimitivePredictorTile3D<RealType, IsMultiMaterial>>(states_mid, geom, gx - 1, gy, gz, gx, gy, gz, 0, true);
        sX_R = sample_gpu<RealType, IsMultiMaterial, PrimitivePredictorTile3D<RealType, IsMultiMaterial>>(states_mid, geom, gx + 1, gy, gz, gx, gy, gz, 0, true);
        sY_B = sample_gpu<RealType, IsMultiMaterial, PrimitivePredictorTile3D<RealType, IsMultiMaterial>>(states_mid, geom, gx, gy - 1, gz, gx, gy, gz, 1, true);
        sY_T = sample_gpu<RealType, IsMultiMaterial, PrimitivePredictorTile3D<RealType, IsMultiMaterial>>(states_mid, geom, gx, gy + 1, gz, gx, gy, gz, 1, true);
        sZ_D = sample_gpu<RealType, IsMultiMaterial, PrimitivePredictorTile3D<RealType, IsMultiMaterial>>(states_mid, geom, gx, gy, gz - 1, gx, gy, gz, 2, true);
        sZ_U = sample_gpu<RealType, IsMultiMaterial, PrimitivePredictorTile3D<RealType, IsMultiMaterial>>(states_mid, geom, gx, gy, gz + 1, gx, gy, gz, 2, true);
    } else {
        sX_L = sample_gpu_raw<RealType, IsMultiMaterial, PrimitivePredictorTile3D<RealType, IsMultiMaterial>>(states_mid, gx - 1, gy, gz);
        sX_R = sample_gpu_raw<RealType, IsMultiMaterial, PrimitivePredictorTile3D<RealType, IsMultiMaterial>>(states_mid, gx + 1, gy, gz);
        sY_B = sample_gpu_raw<RealType, IsMultiMaterial, PrimitivePredictorTile3D<RealType, IsMultiMaterial>>(states_mid, gx, gy - 1, gz);
        sY_T = sample_gpu_raw<RealType, IsMultiMaterial, PrimitivePredictorTile3D<RealType, IsMultiMaterial>>(states_mid, gx, gy + 1, gz);
        sZ_D = sample_gpu_raw<RealType, IsMultiMaterial, PrimitivePredictorTile3D<RealType, IsMultiMaterial>>(states_mid, gx, gy, gz - 1);
        sZ_U = sample_gpu_raw<RealType, IsMultiMaterial, PrimitivePredictorTile3D<RealType, IsMultiMaterial>>(states_mid, gx, gy, gz + 1);
    }

    RealType invDx = (RealType)1.0 / (RealType)d_cellSize;
    auto slope = [=](RealType L, RealType C, RealType R) {
        return minmod_gpu(C - L, R - C) * invDx;
    };

    bool solid_x_L = is_near_boundary && is_solid_cell_gpu(geom, gx - 1, gy, gz);
    bool solid_x_R = is_near_boundary && is_solid_cell_gpu(geom, gx + 1, gy, gz);
    bool is_confined_x = solid_x_L && solid_x_R;

    bool solid_y_B = is_near_boundary && is_solid_cell_gpu(geom, gx, gy - 1, gz);
    bool solid_y_T = is_near_boundary && is_solid_cell_gpu(geom, gx, gy + 1, gz);
    bool is_confined_y = solid_y_B && solid_y_T;

    bool solid_z_D = is_near_boundary && is_solid_cell_gpu(geom, gx, gy, gz - 1);
    bool solid_z_U = is_near_boundary && is_solid_cell_gpu(geom, gx, gy, gz + 1);
    bool is_confined_z = solid_z_D && solid_z_U;

    GPUCellStateT<RealType, IsMultiMaterial> d_x, d_y, d_z;
    if (is_confined_x) {
        d_x.rho = (RealType)0.0;
        d_x.ux  = (RealType)0.0;
        d_x.uy  = (RealType)0.0;
        d_x.uz  = (RealType)0.0;
        d_x.p   = (RealType)0.0;
        if constexpr (IsMultiMaterial) {
            d_x.alpha1 = (RealType)0.0;
            d_x.alpha2 = (RealType)0.0;
            d_x.arho1  = (RealType)0.0;
        }
    } else if (solid_x_L || solid_x_R) {
        // Suppress ALL slopes near solid boundaries to prevent predictor overshoot
        d_x.rho = (RealType)0.0;
        d_x.ux  = (RealType)0.0;
        d_x.uy  = (RealType)0.0;
        d_x.uz  = (RealType)0.0;
        d_x.p   = (RealType)0.0;
        if constexpr (IsMultiMaterial) {
            d_x.alpha1 = (RealType)0.0;
            d_x.alpha2 = (RealType)0.0;
            d_x.arho1  = (RealType)0.0;
        }
    } else {
        d_x.rho = slope(sX_L.rho, sC.rho, sX_R.rho);
        d_x.ux = slope(sX_L.ux, sC.ux, sX_R.ux);
        d_x.uy = slope(sX_L.uy, sC.uy, sX_R.uy);
        d_x.uz = slope(sX_L.uz, sC.uz, sX_R.uz);
        d_x.p = slope(sX_L.p, sC.p, sX_R.p);
        if constexpr (IsMultiMaterial) {
            d_x.alpha1 = slope(sX_L.alpha1, sC.alpha1, sX_R.alpha1);
            d_x.alpha2 = slope(sX_L.alpha2, sC.alpha2, sX_R.alpha2);
            d_x.arho1 = slope(sX_L.arho1, sC.arho1, sX_R.arho1);
        }
    }

    if (is_confined_y) {
        d_y.rho = (RealType)0.0;
        d_y.ux  = (RealType)0.0;
        d_y.uy  = (RealType)0.0;
        d_y.uz  = (RealType)0.0;
        d_y.p   = (RealType)0.0;
        if constexpr (IsMultiMaterial) {
            d_y.alpha1 = (RealType)0.0;
            d_y.alpha2 = (RealType)0.0;
            d_y.arho1  = (RealType)0.0;
        }
    } else if (solid_y_B || solid_y_T) {
        // Suppress ALL slopes near solid boundaries to prevent predictor overshoot
        d_y.rho = (RealType)0.0;
        d_y.ux  = (RealType)0.0;
        d_y.uy  = (RealType)0.0;
        d_y.uz  = (RealType)0.0;
        d_y.p   = (RealType)0.0;
        if constexpr (IsMultiMaterial) {
            d_y.alpha1 = (RealType)0.0;
            d_y.alpha2 = (RealType)0.0;
            d_y.arho1  = (RealType)0.0;
        }
    } else {
        d_y.rho = slope(sY_B.rho, sC.rho, sY_T.rho);
        d_y.ux = slope(sY_B.ux, sC.ux, sY_T.ux);
        d_y.uy = slope(sY_B.uy, sC.uy, sY_T.uy);
        d_y.uz = slope(sY_B.uz, sC.uz, sY_T.uz);
        d_y.p = slope(sY_B.p, sC.p, sY_T.p);
        if constexpr (IsMultiMaterial) {
            d_y.alpha1 = slope(sY_B.alpha1, sC.alpha1, sY_T.alpha1);
            d_y.alpha2 = slope(sY_B.alpha2, sC.alpha2, sY_T.alpha2);
            d_y.arho1 = slope(sY_B.arho1, sC.arho1, sY_T.arho1);
        }
    }

    if (is_confined_z) {
        d_z.rho = (RealType)0.0;
        d_z.ux  = (RealType)0.0;
        d_z.uy  = (RealType)0.0;
        d_z.uz  = (RealType)0.0;
        d_z.p   = (RealType)0.0;
        if constexpr (IsMultiMaterial) {
            d_z.alpha1 = (RealType)0.0;
            d_z.alpha2 = (RealType)0.0;
            d_z.arho1  = (RealType)0.0;
        }
    } else if (solid_z_D || solid_z_U) {
        // Suppress ALL slopes near solid boundaries to prevent predictor overshoot
        d_z.rho = (RealType)0.0;
        d_z.ux  = (RealType)0.0;
        d_z.uy  = (RealType)0.0;
        d_z.uz  = (RealType)0.0;
        d_z.p   = (RealType)0.0;
        if constexpr (IsMultiMaterial) {
            d_z.alpha1 = (RealType)0.0;
            d_z.alpha2 = (RealType)0.0;
            d_z.arho1  = (RealType)0.0;
        }
    } else {
        bool mat_diff_D = false;
        bool mat_diff_U = false;
        if (d_stratParams.enabled) {
            RealType z_C = (RealType)d_zmin + ((RealType)gz + (RealType)0.5) * (RealType)d_cellSize;
            RealType z_D = z_C - (RealType)d_cellSize;
            RealType z_U = z_C + (RealType)d_cellSize;
            bool soil_C = is_cell_soil(sC.rho, z_C);
            bool soil_D = is_cell_soil(sZ_D.rho, z_D);
            bool soil_U = is_cell_soil(sZ_U.rho, z_U);
            bool water_C = false, water_D = false, water_U = false;
            if constexpr (IsMultiMaterial) {
                water_C = is_cell_water(sC.rho, z_C, sC.alpha1 + sC.alpha2);
                water_D = is_cell_water(sZ_D.rho, z_D, sZ_D.alpha1 + sZ_D.alpha2);
                water_U = is_cell_water(sZ_U.rho, z_U, sZ_U.alpha1 + sZ_U.alpha2);
            } else {
                water_C = is_cell_water(sC.rho, z_C);
                water_D = is_cell_water(sZ_D.rho, z_D);
                water_U = is_cell_water(sZ_U.rho, z_U);
            }
            mat_diff_D = (soil_C != soil_D || water_C != water_D);
            mat_diff_U = (soil_C != soil_U || water_C != water_U);
        }
        if (mat_diff_D && !mat_diff_U) {
            RealType dp_hydro = d_has_gravity ? (sC.rho * (RealType)d_gravity_z) : (RealType)0.0;
            RealType dp_pert_U = (sZ_U.p - sC.p) * invDx - dp_hydro;
            d_z.p = dp_hydro + dp_pert_U;
            d_z.rho = (sZ_U.rho - sC.rho) * invDx;
            d_z.ux  = (sZ_U.ux - sC.ux) * invDx;
            d_z.uy  = (sZ_U.uy - sC.uy) * invDx;
            d_z.uz  = (sZ_U.uz - sC.uz) * invDx;
            if constexpr (IsMultiMaterial) {
                d_z.alpha1 = (sZ_U.alpha1 - sC.alpha1) * invDx;
                d_z.alpha2 = (sZ_U.alpha2 - sC.alpha2) * invDx;
                d_z.arho1  = (sZ_U.arho1 - sC.arho1) * invDx;
            }
        } else if (mat_diff_U && !mat_diff_D) {
            RealType dp_hydro = d_has_gravity ? (sC.rho * (RealType)d_gravity_z) : (RealType)0.0;
            RealType dp_pert_D = (sC.p - sZ_D.p) * invDx - dp_hydro;
            d_z.p = dp_hydro + dp_pert_D;
            d_z.rho = (sC.rho - sZ_D.rho) * invDx;
            d_z.ux  = (sC.ux - sZ_D.ux) * invDx;
            d_z.uy  = (sC.uy - sZ_D.uy) * invDx;
            d_z.uz  = (sC.uz - sZ_D.uz) * invDx;
            if constexpr (IsMultiMaterial) {
                d_z.alpha1 = (sC.alpha1 - sZ_D.alpha1) * invDx;
                d_z.alpha2 = (sC.alpha2 - sZ_D.alpha2) * invDx;
                d_z.arho1  = (sC.arho1 - sZ_D.arho1) * invDx;
            }
        } else if (mat_diff_D && mat_diff_U) {
            d_z.rho = slope(sZ_D.rho, sC.rho, sZ_U.rho);
            d_z.ux  = slope(sZ_D.ux, sC.ux, sZ_U.ux);
            d_z.uy  = slope(sZ_D.uy, sC.uy, sZ_U.uy);
            d_z.uz  = slope(sZ_D.uz, sC.uz, sZ_U.uz);
            d_z.p   = slope(sZ_D.p, sC.p, sZ_U.p);
            if constexpr (IsMultiMaterial) {
                d_z.alpha1 = slope(sZ_D.alpha1, sC.alpha1, sZ_U.alpha1);
                d_z.alpha2 = slope(sZ_D.alpha2, sC.alpha2, sZ_U.alpha2);
                d_z.arho1  = slope(sZ_D.arho1, sC.arho1, sZ_U.arho1);
            }
        } else {
            d_z.rho = slope(sZ_D.rho, sC.rho, sZ_U.rho);
            d_z.ux = slope(sZ_D.ux, sC.ux, sZ_U.ux);
            d_z.uy = slope(sZ_D.uy, sC.uy, sZ_U.uy);
            d_z.uz = slope(sZ_D.uz, sC.uz, sZ_U.uz);
            d_z.p = slope(sZ_D.p, sC.p, sZ_U.p);
            if constexpr (IsMultiMaterial) {
                d_z.alpha1 = slope(sZ_D.alpha1, sC.alpha1, sZ_U.alpha1);
                d_z.alpha2 = slope(sZ_D.alpha2, sC.alpha2, sZ_U.alpha2);
                d_z.arho1 = slope(sZ_D.arho1, sC.arho1, sZ_U.arho1);
            }
        }
    }

    GPUCellStateT<RealType, IsMultiMaterial> dW_dt_mid;
    RealType z_c = (RealType)d_zmin + ((RealType)gz + (RealType)0.5) * (RealType)d_cellSize;
    computeTimeDerivativeGPU<RealType, IsMultiMaterial>(sC, d_x, d_y, d_z, gamma_r, dW_dt_mid, z_c);

    const auto& s_orig = states_orig[t_idx];
    const auto& dW_dt_orig = dW_dt_orig_pool[t_idx];
    auto& s_int_tile = states_int[t_idx];

    RealType rho_int = s_orig.rho[c_idx] + dt * ((RealType)(1.0/6.0) * dW_dt_orig.rho[c_idx] + (RealType)(2.0/3.0) * dW_dt_mid.rho);
    RealType p_int = s_orig.p[c_idx] + dt * ((RealType)(1.0/6.0) * dW_dt_orig.p[c_idx] + (RealType)(2.0/3.0) * dW_dt_mid.p);
    s_int_tile.rho[c_idx] = fmax((RealType)1e-7, rho_int);
    s_int_tile.ux[c_idx] = s_orig.ux[c_idx] + dt * ((RealType)(1.0/6.0) * dW_dt_orig.ux[c_idx] + (RealType)(2.0/3.0) * dW_dt_mid.ux);
    s_int_tile.uy[c_idx] = s_orig.uy[c_idx] + dt * ((RealType)(1.0/6.0) * dW_dt_orig.uy[c_idx] + (RealType)(2.0/3.0) * dW_dt_mid.uy);
    s_int_tile.uz[c_idx] = s_orig.uz[c_idx] + dt * ((RealType)(1.0/6.0) * dW_dt_orig.uz[c_idx] + (RealType)(2.0/3.0) * dW_dt_mid.uz);
    s_int_tile.p[c_idx] = fmax((RealType)1e-7, p_int);
    if constexpr (IsMultiMaterial) {
        s_int_tile.alpha1[c_idx] = fmax((RealType)0.0, fmin((RealType)1.0, s_orig.alpha1[c_idx] + dt * ((RealType)(1.0/6.0) * dW_dt_orig.alpha1[c_idx] + (RealType)(2.0/3.0) * dW_dt_mid.alpha1)));
        s_int_tile.alpha2[c_idx] = fmax((RealType)0.0, fmin((RealType)1.0, s_orig.alpha2[c_idx] + dt * ((RealType)(1.0/6.0) * dW_dt_orig.alpha2[c_idx] + (RealType)(2.0/3.0) * dW_dt_mid.alpha2)));
        s_int_tile.arho1[c_idx] = fmax((RealType)0.0, fmin(s_int_tile.rho[c_idx], s_orig.arho1[c_idx] + dt * ((RealType)(1.0/6.0) * dW_dt_orig.arho1[c_idx] + (RealType)(2.0/3.0) * dW_dt_mid.arho1)));
        s_int_tile.arho2[c_idx] = fmax((RealType)0.0, fmin(s_int_tile.rho[c_idx], s_orig.arho2[c_idx] + dt * ((RealType)(1.0/6.0) * dW_dt_orig.arho2[c_idx] + (RealType)(2.0/3.0) * dW_dt_mid.arho2)));
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setBoundaryConditions(BCType3D xmin, BCType3D xmax, BCType3D ymin, BCType3D ymax, BCType3D zmin, BCType3D zmax) {
    CFDSolver3DImplBase::setBoundaryConditions(xmin, xmax, ymin, ymax, zmin, zmax);
}

template <typename RealType, bool IsMultiMaterial>
__global__ void kernel_fsi_apply_penalty_gpu(
    PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    ConservativeTile3D<RealType, IsMultiMaterial>* d_U,
    const Blast::MPMGridNode3D* d_grid,
    int nx, int ny, int nz,
    int ntx, int nty,
    float dx, float dy, float dz,
    float gamma
);

template <typename RealType, bool IsMultiMaterial>
__global__ void kernel_enforce_passive_velocities(
    PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    const GeometryTile3D* geom,
    const SolidVelocityTile3D* d_solid_vel,
    const int* active_tile_indices,
    int nx, int ny, int nz, int ntx, int nty, int n_active
) {
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= n_active * 512) return;
    
    int t_idx = active_tile_indices[tid / 512];
    int c_idx = tid % 512;
    
    if (geom && d_solid_vel) {
        if (geom[t_idx].cells[c_idx].is_boundary) {
            states[t_idx].ux[c_idx] = d_solid_vel[t_idx].vx[c_idx];
            states[t_idx].uy[c_idx] = d_solid_vel[t_idx].vy[c_idx];
            states[t_idx].uz[c_idx] = d_solid_vel[t_idx].vz[c_idx];
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
    (void)ntx; (void)nty; (void)ntz;

    if (d_solid_vel_fsi && d_geom) {
        int n_active = h_num_active_tiles;
        dim3 threads_enf(512);
        dim3 blocks_enf((n_active * 512 + 511) / 512);
        kernel_enforce_passive_velocities<RealType, IsMultiMaterial><<<blocks_enf, threads_enf>>>(
            (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (const GeometryTile3D*)d_geom,
            (const SolidVelocityTile3D*)d_solid_vel_fsi,
            (const int*)d_active_tile_indices,
            nx, ny, nz, ntx, nty, n_active
        );
        CHECK_CUDA(cudaGetLastError());
    }

    int n_active = h_num_active_tiles;
    dim3 threads(TILE_SIZE_3D, TILE_SIZE_3D, TILE_SIZE_3D);

    auto launch_fused_kernel_with_states = [&](auto states_ptr, auto U_dest, int stage, auto U_prev_ptr, bool prim_upd, RealType peak_dt) {
        using TileT = typename std::remove_pointer<typename std::decay<decltype(states_ptr)>::type>::type;
        if (spatialOrder == 3) {
            compute_flux_fused_3d<RealType, IsMultiMaterial, 3, TileT><<<n_active, threads>>>(
                states_ptr,
                (ConservativeTile3D<RealType, IsMultiMaterial>*)U_dest,
                (const int*)d_active_tile_indices,
                (const uint8_t*)d_tile_is_near_boundary,
                (const GeometryTile3D*)d_geom,
                dt_r, stage,
                (ConservativeTile3D<RealType, IsMultiMaterial>*)U_prev_ptr,
                prim_upd, peak_dt,
                (const SolidVelocityTile3D*)d_solid_vel_fsi
            );
        } else if (spatialOrder == 2) {
            compute_flux_fused_3d<RealType, IsMultiMaterial, 2, TileT><<<n_active, threads>>>(
                states_ptr,
                (ConservativeTile3D<RealType, IsMultiMaterial>*)U_dest,
                (const int*)d_active_tile_indices,
                (const uint8_t*)d_tile_is_near_boundary,
                (const GeometryTile3D*)d_geom,
                dt_r, stage,
                (ConservativeTile3D<RealType, IsMultiMaterial>*)U_prev_ptr,
                prim_upd, peak_dt,
                (const SolidVelocityTile3D*)d_solid_vel_fsi
            );
        } else {
            compute_flux_fused_3d<RealType, IsMultiMaterial, 1, TileT><<<n_active, threads>>>(
                states_ptr,
                (ConservativeTile3D<RealType, IsMultiMaterial>*)U_dest,
                (const int*)d_active_tile_indices,
                (const uint8_t*)d_tile_is_near_boundary,
                (const GeometryTile3D*)d_geom,
                dt_r, stage,
                (ConservativeTile3D<RealType, IsMultiMaterial>*)U_prev_ptr,
                prim_upd, peak_dt,
                (const SolidVelocityTile3D*)d_solid_vel_fsi
            );
        }
    };

    // MUSCL-Hancock (4), ADER-2 (5), ADER-3 (6) on GPU
    int total_tiles = ntx * nty * ntz;
    if (!d_states_pred) {
        CHECK_CUDA(cudaMalloc(&d_states_pred, total_tiles * sizeof(PrimitivePredictorTile3D<RealType, IsMultiMaterial>)));
        CHECK_CUDA(cudaMemset(d_states_pred, 0, total_tiles * sizeof(PrimitivePredictorTile3D<RealType, IsMultiMaterial>)));
    }
    if (temporalOrder == 6 && !d_dW_dt) {
        CHECK_CUDA(cudaMalloc(&d_dW_dt, total_tiles * sizeof(PrimitivePredictorTile3D<RealType, IsMultiMaterial>)));
        CHECK_CUDA(cudaMemset(d_dW_dt, 0, total_tiles * sizeof(PrimitivePredictorTile3D<RealType, IsMultiMaterial>)));
    }
    auto states_pred_ptr = (PrimitivePredictorTile3D<RealType, IsMultiMaterial>*)d_states_pred;
    auto dW_dt_ptr = (temporalOrder == 6) ? (PrimitivePredictorTile3D<RealType, IsMultiMaterial>*)d_dW_dt : nullptr;

    copy_active_primitive_tiles_kernel_3d<RealType, IsMultiMaterial><<<n_active, 512>>>(
        states_pred_ptr, (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (const int*)d_active_tile_indices
    );
    CHECK_CUDA(cudaGetLastError());
    
    RealType gamma_r = (RealType)gamma;

        // Launch pass 1 prediction kernel
        if (spatialOrder == 3) {
            predict_states_gpu_kernel_3d<RealType, IsMultiMaterial, 3><<<n_active, threads>>>(
                (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
                states_pred_ptr,
                dW_dt_ptr,
                (const int*)d_active_tile_indices,
                (const uint8_t*)d_tile_is_near_boundary,
                (const GeometryTile3D*)d_geom,
                dt_r,
                gamma_r,
                temporalOrder
            );
        } else if (spatialOrder == 2) {
            predict_states_gpu_kernel_3d<RealType, IsMultiMaterial, 2><<<n_active, threads>>>(
                (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
                states_pred_ptr,
                dW_dt_ptr,
                (const int*)d_active_tile_indices,
                (const uint8_t*)d_tile_is_near_boundary,
                (const GeometryTile3D*)d_geom,
                dt_r,
                gamma_r,
                temporalOrder
            );
        } else {
            predict_states_gpu_kernel_3d<RealType, IsMultiMaterial, 1><<<n_active, threads>>>(
                (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
                states_pred_ptr,
                dW_dt_ptr,
                (const int*)d_active_tile_indices,
                (const uint8_t*)d_tile_is_near_boundary,
                (const GeometryTile3D*)d_geom,
                dt_r,
                gamma_r,
                temporalOrder
            );
        }

        if (temporalOrder == 6) {
            // ADER-3 Second Pass: compute integrated states
            predict_states_ader3_gpu_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>(
                (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, // orig W^n
                states_pred_ptr, // mid W^{n+1/2}
                dW_dt_ptr, // dW_dt at t^n
                states_pred_ptr, // output: integrated states W^{int}
                (const int*)d_active_tile_indices,
                (const uint8_t*)d_tile_is_near_boundary,
                (const GeometryTile3D*)d_geom,
                dt_r,
                gamma_r
            );
        }

        // Perform flux update using predicted states directly without pointer swap
        launch_fused_kernel_with_states(states_pred_ptr, d_U, 0, nullptr, false, (RealType)0.0);

        if constexpr (IsMultiMaterial) {
            applyProgrammedBurn_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>(
                (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
                (const int*)d_active_tile_indices,
                (RealType)currentTime,
                dt_r
            );
        }

        // Update primitive variables and peaks
        update_primitive_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>(
            (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
            (const int*)d_active_tile_indices,
            (const GeometryTile3D*)d_geom,
            dt_r,
            (const SolidVelocityTile3D*)d_solid_vel_fsi
        );

    if (this->d_fsi_mpm_grid) {
        dim3 penalty_threads(8, 8, 4);
        dim3 penalty_grid((nx + 7) / 8, (ny + 7) / 8, (nz + 3) / 4);
        kernel_fsi_apply_penalty_gpu<RealType, IsMultiMaterial><<<penalty_grid, penalty_threads>>>(
            (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
            (const Blast::MPMGridNode3D*)this->d_fsi_mpm_grid,
            nx, ny, nz, ntx, nty,
            (float)cellSize, (float)cellSize, (float)cellSize,
            (float)gamma
        );
        CHECK_CUDA(cudaGetLastError());
        CHECK_CUDA(cudaDeviceSynchronize());
    }


    currentTime += dt;
    updateActiveRegions();
    last_cached_tile_idx = -1;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setFluxScheme(const std::string& name) {
    currentFluxScheme = name;
    constants_dirty = true;
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) compute_max_speed_kernel_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    const GeometryTile3D* geom,
    const int* active_tile_indices,
    RealType gamma,
    RealType* max_s_block) {

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

        RealType z_c = (RealType)d_zmin + ((RealType)gz + (RealType)0.5) * (RealType)d_cellSize;
        GPUCellStateT<RealType, IsMultiMaterial> s_tmp;
        s_tmp.rho = rho; s_tmp.p = p; s_tmp.ux = ux; s_tmp.uy = uy; s_tmp.uz = uz;
        if constexpr (IsMultiMaterial) {
            s_tmp.alpha1 = states[t_idx].alpha1[c_idx];
            s_tmp.alpha2 = states[t_idx].alpha2[c_idx];
            s_tmp.arho1 = states[t_idx].arho1[c_idx];
            s_tmp.arho2 = states[t_idx].arho2[c_idx];
        }

        RealType c = computeCellSoundSpeedGPU<RealType, IsMultiMaterial>(s_tmp, z_c, gamma);
        if constexpr (IsMultiMaterial) {
            RealType a2 = states[t_idx].alpha2[c_idx];
            RealType ar2 = states[t_idx].arho2[c_idx];
            if (a2 > (RealType)1e-4 && ar2 > (RealType)10.0 && d_det_vel > (RealType)0.0) {
                c = fmax(c, (RealType)d_det_vel);
            }
        }

        RealType acoustic_mult = (RealType)1.0;
        if (geom) {
            int solid_faces = 0;
            if (is_solid_cell_gpu(geom, gx - 1, gy, gz)) solid_faces++;
            if (is_solid_cell_gpu(geom, gx + 1, gy, gz)) solid_faces++;
            if (is_solid_cell_gpu(geom, gx, gy - 1, gz)) solid_faces++;
            if (is_solid_cell_gpu(geom, gx, gy + 1, gz)) solid_faces++;
            if (is_solid_cell_gpu(geom, gx, gy, gz - 1)) solid_faces++;
            if (is_solid_cell_gpu(geom, gx, gy, gz + 1)) solid_faces++;
            if (solid_faces >= 2) {
                acoustic_mult = (RealType)1.5;
            }
        }

        max_s = abs(ux) + abs(uy) + abs(uz) + (RealType)3.0 * c * acoustic_mult;
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
static __global__ void reduce_max_kernel(const RealType* data, int n, RealType* result) {
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
static __global__ void compute_submesh_max_speed_kernel_3d(
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
    compute_max_speed_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>(
        (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
        (const GeometryTile3D*)d_geom,
        (const int*)d_active_tile_indices,
        (RealType)gamma,
        (RealType*)d_max_s_buf);

    // GPU-side second-pass reduction to a single scalar
    reduce_max_kernel<RealType><<<1, 256>>>((const RealType*)d_max_s_buf, n_active, (RealType*)d_max_s_buf);

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
        if (!global_geometry_tiles.empty() && t_idx >= 0 && t_idx < (int)global_geometry_tiles.size()) {
            vals[7] = global_geometry_tiles[t_idx].cells[c_idx].is_boundary ? 1.0f : 0.0f;
        } else {
            GeometryTile3D cached_geom_tile;
            CHECK_CUDA(cudaMemcpy(&cached_geom_tile, (const GeometryTile3D*)d_geom + t_idx, sizeof(GeometryTile3D), cudaMemcpyDeviceToHost));
            vals[7] = cached_geom_tile.cells[c_idx].is_boundary ? 1.0f : 0.0f;
        }
    }
    vals[8] = (float)cached_tile.peak_overpressure[c_idx];
    vals[9] = (float)cached_tile.peak_impulse[c_idx];
    return vals;
}

template <typename RealType, bool IsMultiMaterial>
bool CFDSolver3DCuda<RealType, IsMultiMaterial>::getFluidVelocity(int gx, int gy, int gz, float& u, float& v, float& w, float& rho, float& p) const {
    ensure_paged_in();
    bind_constants();
    if (gx < 0 || gx >= nx || gy < 0 || gy >= ny || gz < 0 || gz >= nz) return false;

    int tx = gx / TILE_SIZE_3D, ty = gy / TILE_SIZE_3D, tz = gz / TILE_SIZE_3D;
    int t_idx = tx + ty * ((nx+7)/8) + tz * ((nx+7)/8) * ((ny+7)/8);
    int lx = gx % TILE_SIZE_3D, ly = gy % TILE_SIZE_3D, lz = gz % TILE_SIZE_3D;
    int c_idx = lx + ly * 8 + lz * 64;

    if (t_idx != last_cached_tile_idx) {
        CHECK_CUDA(cudaMemcpy(&cached_tile, (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states + t_idx, sizeof(PrimitiveTile3D<RealType, IsMultiMaterial>), cudaMemcpyDeviceToHost));
        last_cached_tile_idx = t_idx;
    }

    p = static_cast<float>(cached_tile.p[c_idx]);
    rho = static_cast<float>(cached_tile.rho[c_idx]);
    u = static_cast<float>(cached_tile.ux[c_idx]);
    v = static_cast<float>(cached_tile.uy[c_idx]);
    w = static_cast<float>(cached_tile.uz[c_idx]);
    return true;
}

template <typename RealType, bool IsMultiMaterial>
std::vector<float> CFDSolver3DCuda<RealType, IsMultiMaterial>::extractSlice(const Slice3D& slice) const {
    ensure_paged_in();
    bind_constants();
    std::vector<float> h_data;
    bool is_obstacles = (slice.axis == "obstacles");

    std::string qty = (slice.quantities.empty()) ? "pressure" : slice.quantities[0];
    std::transform(qty.begin(), qty.end(), qty.begin(), [](unsigned char c) { return std::tolower(c); });
    int qty_id = 0;
    if (qty == "density" || qty == "rho") qty_id = 1;
    else if (qty == "velocity" || qty == "speed") qty_id = 2;
    else if (qty == "energy" || qty == "internal_energy") qty_id = 3;
    else if (qty == "species1" || qty == "alpha1" || qty == "species_1" || qty == "species" || qty == "products" || qty == "detonation_products" || qty == "detonation" || qty == "reacted" || qty == "reacted_gas" || qty == "he_products" || qty == "alpha_1") qty_id = 4;
    else if (qty == "species2" || qty == "alpha2" || qty == "species_2" || qty == "unreacted" || qty == "unreacted_solid" || qty == "solid_he" || qty == "solid_explosive" || qty == "he_solid" || qty == "alpha_2") qty_id = 5;
    else if (qty == "species3" || qty == "species_3" || qty == "air" || qty == "ambient_air" || qty == "alpha3" || qty == "alpha_3") qty_id = 6;
    else if (qty == "solid" || qty == "solid_cells") qty_id = 7;
    else if (qty == "overpressure" || qty == "peak_overpressure") qty_id = 8;
    else if (qty == "impulse" || qty == "peak_impulse") qty_id = 9;
    else if (qty == "temperature" || qty == "temp" || qty == "T") qty_id = 10;
    else if (qty == "afterburn_rate" || qty == "ab_rate" || qty == "combustion_rate") qty_id = 11;
    else if (qty == "materials" || qty == "material" || qty == "material_id" || qty == "phase") qty_id = 13;
    else if (qty == "water" || qty == "phase_water") qty_id = 14;
    else if (qty == "soil" || qty == "phase_soil" || qty == "sediment") qty_id = 15;

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
            CHECK_CUDA(cudaMemcpy(h_data.data(), d_slice_buf, required_size, cudaMemcpyDeviceToHost));
        }

        return h_data;
    }

    if (slice.axis == "volume") {
        int stride = slice.stride > 0 ? slice.stride : 1;
        int factor = 1;

        int i_start = slice.roi_enabled ? slice.roi_i_start : 0;
        int j_start = slice.roi_enabled ? slice.roi_j_start : 0;
        int k_start = slice.roi_enabled ? slice.roi_k_start : 0;
        int i_end   = slice.roi_enabled ? slice.roi_i_end   : nx;
        int j_end   = slice.roi_enabled ? slice.roi_j_end   : ny;
        int k_end   = slice.roi_enabled ? slice.roi_k_end   : nz;

        int out_nx = ((i_end - i_start + stride - 1) / stride) * factor;
        int out_ny = ((j_end - j_start + stride - 1) / stride) * factor;
        int out_nz = ((k_end - k_start + stride - 1) / stride) * factor;
        size_t total_voxels = (size_t)out_nx * out_ny * out_nz;
        h_data.resize(total_voxels, 0.0f);
        size_t required_size = total_voxels * sizeof(float);
        if (d_slice_buf_capacity < required_size) {
            if (d_slice_buf) cudaFree(d_slice_buf);
            d_slice_buf_capacity = required_size;
            CHECK_CUDA(cudaMalloc(&d_slice_buf, d_slice_buf_capacity));
        }
        dim3 threads(8, 8, 4);
        dim3 blocks((out_nx + 7) / 8, (out_ny + 7) / 8, (out_nz + 3) / 4);
        extract_volume_kernel<RealType, IsMultiMaterial><<<blocks, threads>>>(
            (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (const GeometryTile3D*)d_geom,
            (float*)d_slice_buf,
            nx, ny, nz,
            out_nx, out_ny, out_nz,
            xmin, ymin, zmin, cellSize,
            qty_id, stride, factor,
            i_start, j_start, k_start
        );
        CHECK_CUDA(cudaMemcpy(h_data.data(), d_slice_buf, required_size, cudaMemcpyDeviceToHost));
        return h_data;
    }

    int axis = (slice.axis == "xy" ? 0 : (slice.axis == "xz" ? 1 : 2));
    int stride = slice.stride > 0 ? slice.stride : 1;
    int scale = 1;
    int base_w = 0, base_h = 0;
    if (axis == 0) { base_w = (nx + stride - 1) / stride; base_h = (ny + stride - 1) / stride; }
    else if (axis == 1) { base_w = (nx + stride - 1) / stride; base_h = (nz + stride - 1) / stride; }
    else { base_w = (ny + stride - 1) / stride; base_h = (nz + stride - 1) / stride; }

    int w = base_w * scale;
    int h = base_h * scale;

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
    return results;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::sampleSurfacePoints(
    const std::vector<Point3D>& points,
    const std::vector<std::string>& quantities,
    double dom_xmin, double dom_xmax,
    double dom_ymin, double dom_ymax,
    double dom_zmin, double dom_zmax,
    float outside_val,
    std::vector<std::vector<float>>& out_quantities
) const {
    ensure_paged_in();
    bind_constants();

    size_t num_points = points.size();
    size_t num_qtys = quantities.size();
    out_quantities.resize(num_qtys);
    for (size_t q = 0; q < num_qtys; ++q) {
        out_quantities[q].resize(num_points, outside_val);
    }
    if (num_points == 0 || num_qtys == 0) return;

    size_t required_points_bytes = num_points * sizeof(Point3D);
    if (d_sample_coords_capacity < required_points_bytes) {
        if (d_sample_coords) cudaFree(d_sample_coords);
        d_sample_coords_capacity = required_points_bytes;
        CHECK_CUDA(cudaMalloc(&d_sample_coords, d_sample_coords_capacity));
    }
    CHECK_CUDA(cudaMemcpy(d_sample_coords, points.data(), required_points_bytes, cudaMemcpyHostToDevice));

    size_t required_slice_bytes = num_points * sizeof(float);
    if (d_slice_buf_capacity < required_slice_bytes) {
        if (d_slice_buf) cudaFree(d_slice_buf);
        d_slice_buf_capacity = required_slice_bytes;
        CHECK_CUDA(cudaMalloc(&d_slice_buf, d_slice_buf_capacity));
    }

    int ntx = (nx + 7) / 8;
    int nty = (ny + 7) / 8;
    dim3 threads(256);
    dim3 blocks((static_cast<int>(num_points) + 255) / 256);

    for (size_t q = 0; q < num_qtys; ++q) {
        std::string qty = quantities[q];
        std::transform(qty.begin(), qty.end(), qty.begin(), [](unsigned char c) { return std::tolower(c); });
        int qty_id = 0;
        if (qty == "density" || qty == "rho") qty_id = 1;
        else if (qty == "velocity" || qty == "speed") qty_id = 2;
        else if (qty == "energy" || qty == "internal_energy") qty_id = 3;
        else if (qty == "species1" || qty == "alpha1" || qty == "reacted" || qty == "reacted_gas") qty_id = 4;
        else if (qty == "species2" || qty == "alpha2" || qty == "unreacted" || qty == "unreacted_solid") qty_id = 5;
        else if (qty == "species3" || qty == "air" || qty == "ambient_air") qty_id = 6;
        else if (qty == "solid" || qty == "solid_cells") qty_id = 7;
        else if (qty == "overpressure" || qty == "peak_overpressure") qty_id = 8;
        else if (qty == "impulse" || qty == "peak_impulse") qty_id = 9;
        else if (qty == "materials" || qty == "material" || qty == "phase") qty_id = 13;

        sample_surface_points_kernel<RealType, IsMultiMaterial><<<blocks, threads>>>(
            (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (const GeometryTile3D*)d_geom,
            (const Point3D*)d_sample_coords,
            (float*)d_slice_buf,
            static_cast<int>(num_points),
            qty_id,
            dom_xmin, dom_xmax,
            dom_ymin, dom_ymax,
            dom_zmin, dom_zmax,
            outside_val,
            nx, ny, nz,
            xmin, ymin, zmin,
            cellSize, ntx, nty
        );
        CHECK_CUDA(cudaMemcpy(out_quantities[q].data(), d_slice_buf, required_slice_bytes, cudaMemcpyDeviceToHost));
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::captureBulkSnapshot(CFDBulkSnapshot3D& /*out_snap*/, bool /*need_vel*/, bool /*need_E*/, bool /*need_species*/) const {
    // Deprecated: VTK outputs now use direct GPU surface and ROI sampling with zero bulk allocations.
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
        if (slice.roi_enabled) {
            w = ((slice.roi_i_end - slice.roi_i_start + stride - 1) / stride) * scale;
            h = ((slice.roi_j_end - slice.roi_j_start + stride - 1) / stride) * scale;
            depth = ((slice.roi_k_end - slice.roi_k_start + stride - 1) / stride) * scale;
        } else {
            w = ((nx + stride - 1) / stride) * scale;
            h = ((ny + stride - 1) / stride) * scale;
            depth = ((nz + stride - 1) / stride) * scale;
        }
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
        s_active = d_stratParams.enabled ? 1 : 0;
    }
    __syncthreads();

    if (d_stratParams.enabled) {
        if (threadIdx.x == 0) {
            temp_active[t_idx] = 1;
        }
        return;
    }

    if (gx < nx && gy < ny && gz < nz) {
        RealType p_val = states[t_idx].p[c_idx];
        RealType ux = states[t_idx].ux[c_idx];
        RealType uy = states[t_idx].uy[c_idx];
        RealType uz = states[t_idx].uz[c_idx];
        RealType alpha1 = (RealType)0.0;
        RealType alpha2 = (RealType)0.0;
        if constexpr (IsMultiMaterial) {
            alpha1 = states[t_idx].alpha1[c_idx];
            alpha2 = states[t_idx].alpha2[c_idx];
        }

        double u2 = (double)(ux * ux + uy * uy + uz * uz);
        double dp = fabs((double)p_val - d_ambient_p);
        double a1 = (double)alpha1;
        double a2 = (double)alpha2;

        if (a1 > 1e-4 || a2 > 1e-4 || dp > 1e-3 * d_ambient_p || u2 > 1e-2) {
            s_active = 1;
        }
    }
    __syncthreads();

    if (threadIdx.x == 0) {
        temp_active[t_idx] = s_active;
    }
}

static __global__ void dilate_active_tiles_kernel(
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
static __global__ void compact_active_tiles_kernel(
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

    dim3 c_threads_unc(8, 8, 8);
    update_conservative_from_primitive_kernel_3d<RealType, IsMultiMaterial><<<total_tiles, c_threads_unc>>>(
        (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
        (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
        total_tiles, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted
    );
    CHECK_CUDA(cudaDeviceSynchronize());

    updateActiveRegions();

    double cut_r = (R_remap > 0.0) ? R_remap : (r_1d.empty() ? 0.0 : r_1d.back());
    if (cut_r > 0.0) {
        std::vector<uint8_t> h_active_tiles(total_tiles, 0);
        CHECK_CUDA(cudaMemcpy(h_active_tiles.data(), d_active_tiles, total_tiles * sizeof(uint8_t), cudaMemcpyDeviceToHost));
        for (int t = 0; t < total_tiles; ++t) {
            int tx = t % ntx;
            int ty = (t / ntx) % nty;
            int tz = t / (ntx * nty);
            double t_min_x = xmin + tx * TILE_SIZE_3D * cellSize;
            double t_max_x = t_min_x + TILE_SIZE_3D * cellSize;
            double t_min_y = ymin + ty * TILE_SIZE_3D * cellSize;
            double t_max_y = t_min_y + TILE_SIZE_3D * cellSize;
            double t_min_z = zmin + tz * TILE_SIZE_3D * cellSize;
            double t_max_z = t_min_z + TILE_SIZE_3D * cellSize;

            double cl_x = std::clamp(x_expl, t_min_x, t_max_x);
            double cl_y = std::clamp(y_expl, t_min_y, t_max_y);
            double cl_z = std::clamp(z_expl, t_min_z, t_max_z);
            double min_dist = std::sqrt((x_expl - cl_x)*(x_expl - cl_x) + (y_expl - cl_y)*(y_expl - cl_y) + (z_expl - cl_z)*(z_expl - cl_z));
            double max_dist = std::sqrt(
                std::max((x_expl - t_min_x)*(x_expl - t_min_x), (x_expl - t_max_x)*(x_expl - t_max_x)) +
                std::max((y_expl - t_min_y)*(y_expl - t_min_y), (y_expl - t_max_y)*(y_expl - t_max_y)) +
                std::max((z_expl - t_min_z)*(z_expl - t_min_z), (z_expl - t_max_z)*(z_expl - t_max_z))
            );

            // Mark tile active if any cell inside tile intersects the remap radius
            if (min_dist <= cut_r + 2.0 * cellSize || (min_dist <= cut_r && max_dist >= cut_r - 2.0 * cellSize)) {
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
    last_cached_tile_idx = -1;
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
            double t_min_x = xmin + tx * TILE_SIZE_3D * cellSize;
            double t_max_x = t_min_x + TILE_SIZE_3D * cellSize;
            double t_min_y = ymin + ty * TILE_SIZE_3D * cellSize;
            double t_max_y = t_min_y + TILE_SIZE_3D * cellSize;
            double t_min_z = zmin + tz * TILE_SIZE_3D * cellSize;
            double t_max_z = t_min_z + TILE_SIZE_3D * cellSize;

            double cl_x = std::clamp(x_expl, t_min_x, t_max_x);
            double cl_y = std::clamp(y_expl, t_min_y, t_max_y);
            double cl_z = std::clamp(z_expl, t_min_z, t_max_z);
            double min_dist = std::sqrt((x_expl - cl_x)*(x_expl - cl_x) + (y_expl - cl_y)*(y_expl - cl_y) + (z_expl - cl_z)*(z_expl - cl_z));
            double max_dist = std::sqrt(
                std::max((x_expl - t_min_x)*(x_expl - t_min_x), (x_expl - t_max_x)*(x_expl - t_max_x)) +
                std::max((y_expl - t_min_y)*(y_expl - t_min_y), (y_expl - t_max_y)*(y_expl - t_max_y)) +
                std::max((z_expl - t_min_z)*(z_expl - t_min_z), (z_expl - t_max_z)*(z_expl - t_max_z))
            );

            // Mark tile active if any cell inside tile intersects the remap radius
            if (min_dist <= R_remap + 2.0 * cellSize || (min_dist <= R_remap && max_dist >= R_remap - 2.0 * cellSize)) {
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
        last_cached_tile_idx = -1;
    }
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
static __global__ void batch_sample_gauges_kernel_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    const GeometryTile3D* geom,
    const GPUGauge3D* gauges,
    float* out_data,
    int num_gauges,
    int nx, int ny, int nz,
    int ntx, int nty
) {
    int g = blockIdx.x * blockDim.x + threadIdx.x;
    if (g >= num_gauges) return;

    int t_idx = gauges[g].t_idx;
    int c_idx = gauges[g].c_idx;

    if (geom != nullptr) {
        int total_tiles = ntx * nty * ((nz + 7) / 8);
        if (t_idx >= 0 && t_idx < total_tiles && geom[t_idx].cells[c_idx].is_boundary != 0) {
            int tx = t_idx % ntx;
            int ty = (t_idx / ntx) % nty;
            int tz = t_idx / (ntx * nty);
            int lx = c_idx & 7;
            int ly = (c_idx >> 3) & 7;
            int lz = (c_idx >> 6) & 7;
            int gx = tx * 8 + lx;
            int gy = ty * 8 + ly;
            int gz = tz * 8 + lz;

            // Read the face outward normal stored by the rasteriser (points fluid-ward).
            // Stored as int8_t in [-127,127]; normalise to float direction.
            const GeometryPayload& bp = geom[t_idx].cells[c_idx];
            float fnx = static_cast<float>(bp.nx);
            float fny = static_cast<float>(bp.ny);
            float fnz = static_cast<float>(bp.nz);
            float fn_len = sqrtf(fnx*fnx + fny*fny + fnz*fnz);
            bool has_normal = (fn_len > 0.5f); // valid packed normal

            int best_t = t_idx;
            int best_c = c_idx;
            float best_dist_sq = 1e9f;

            // Phase 1: directional search — only consider candidates on the fluid side
            // of the boundary (dot product with outward normal > 0).
            if (has_normal) {
                for (int r = 1; r <= 3; ++r) {
                    for (int dz = -r; dz <= r; ++dz) {
                        for (int dy = -r; dy <= r; ++dy) {
                            for (int dx = -r; dx <= r; ++dx) {
                                if (dx == 0 && dy == 0 && dz == 0) continue;
                                // Only check cells on the fluid-facing side of the facet
                                float dot = fnx * (float)dx + fny * (float)dy + fnz * (float)dz;
                                if (dot <= 0.0f) continue;

                                int nx_c = gx + dx;
                                int ny_c = gy + dy;
                                int nz_c = gz + dz;
                                if (nx_c < 0 || nx_c >= nx || ny_c < 0 || ny_c >= ny || nz_c < 0 || nz_c >= nz) continue;

                                int n_tx = nx_c / 8;
                                int n_ty = ny_c / 8;
                                int n_tz = nz_c / 8;
                                int n_t_idx = n_tx + n_ty * ntx + n_tz * ntx * nty;
                                int n_c_idx = (nx_c & 7) + ((ny_c & 7) << 3) + ((nz_c & 7) << 6);

                                if (n_t_idx >= 0 && n_t_idx < total_tiles && geom[n_t_idx].cells[n_c_idx].is_boundary == 0) {
                                    float dist_sq = (float)(dx * dx + dy * dy + dz * dz);
                                    if (dist_sq < best_dist_sq) {
                                        best_dist_sq = dist_sq;
                                        best_t = n_t_idx;
                                        best_c = n_c_idx;
                                    }
                                }
                            }
                        }
                    }
                    if (best_dist_sq < 1e8f) break;
                }
            }

            // Phase 2: un-directional fallback if directional search found nothing
            // (e.g. probe exactly on a corner where all fluid-ward cells are out-of-bounds).
            if (best_dist_sq >= 1e8f) {
                for (int r = 1; r <= 3; ++r) {
                    for (int dz = -r; dz <= r; ++dz) {
                        for (int dy = -r; dy <= r; ++dy) {
                            for (int dx = -r; dx <= r; ++dx) {
                                if (dx == 0 && dy == 0 && dz == 0) continue;
                                int nx_c = gx + dx;
                                int ny_c = gy + dy;
                                int nz_c = gz + dz;
                                if (nx_c < 0 || nx_c >= nx || ny_c < 0 || ny_c >= ny || nz_c < 0 || nz_c >= nz) continue;

                                int n_tx = nx_c / 8;
                                int n_ty = ny_c / 8;
                                int n_tz = nz_c / 8;
                                int n_t_idx = n_tx + n_ty * ntx + n_tz * ntx * nty;
                                int n_c_idx = (nx_c & 7) + ((ny_c & 7) << 3) + ((nz_c & 7) << 6);

                                if (n_t_idx >= 0 && n_t_idx < total_tiles && geom[n_t_idx].cells[n_c_idx].is_boundary == 0) {
                                    float dist_sq = (float)(dx * dx + dy * dy + dz * dz);
                                    if (dist_sq < best_dist_sq) {
                                        best_dist_sq = dist_sq;
                                        best_t = n_t_idx;
                                        best_c = n_c_idx;
                                    }
                                }
                            }
                        }
                    }
                    if (best_dist_sq < 1e8f) break;
                }
            }

            t_idx = best_t;
            c_idx = best_c;
        }
    }

    // Active-tile guard: if the resolved tile has never been activated (i.e. the
    // blast front hasn't reached it yet) fall back to the original/ambient state
    // rather than reading uninitialised memory.
    const auto* active_tiles = (const uint8_t*)d_active_tiles_global;
    const auto* states_orig  = (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states_orig_global;
    const PrimitiveTile3D<RealType, IsMultiMaterial>& tile =
        (active_tiles && states_orig && active_tiles[t_idx] == 0)
            ? states_orig[t_idx]
            : states[t_idx];

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

    std::vector<GeometryTile3D> temp_geom;
    const GeometryTile3D* geom_ptr = nullptr;
    if (!global_geometry_tiles.empty()
        && (int)global_geometry_tiles.size() == ntx * ((ny + 7) / 8) * ((nz + 7) / 8)) {
        geom_ptr = global_geometry_tiles.data();
    } else if (d_geom) {
        int ntz = (nz + 7) / 8;
        size_t total_tiles = (size_t)ntx * ((ny + 7) / 8) * ntz;
        temp_geom.resize(total_tiles);
        cudaMemcpy(temp_geom.data(), d_geom, total_tiles * sizeof(GeometryTile3D), cudaMemcpyDeviceToHost);
        geom_ptr = temp_geom.data();
    }
    const bool has_geom = (geom_ptr != nullptr);

    auto cell_is_solid = [&](int i, int j, int k) -> bool {
        if (!has_geom) return false;
        if (i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k >= nz) return false;
        int ti = i / TILE_SIZE_3D, tj = j / TILE_SIZE_3D, tk = k / TILE_SIZE_3D;
        int nty_local = (ny + 7) / 8;
        int t = ti + tj * ntx + tk * ntx * nty_local;
        int c = (i & 7) + (j & 7) * 8 + (k & 7) * 64;
        return geom_ptr[t].cells[c].is_boundary != 0;
    };

    auto get_boundary_info = [&](int i, int j, int k, float& fnx, float& fny, float& fnz) -> bool {
        if (!has_geom) return false;
        if (i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k >= nz) return false;
        int ti = i / TILE_SIZE_3D, tj = j / TILE_SIZE_3D, tk = k / TILE_SIZE_3D;
        int nty_local = (ny + 7) / 8;
        int t = ti + tj * ntx + tk * ntx * nty_local;
        int c = (i & 7) + (j & 7) * 8 + (k & 7) * 64;
        if (geom_ptr[t].cells[c].is_boundary != 0) {
            fnx = static_cast<float>(geom_ptr[t].cells[c].nx);
            fny = static_cast<float>(geom_ptr[t].cells[c].ny);
            fnz = static_cast<float>(geom_ptr[t].cells[c].nz);
            float len = std::sqrt(fnx * fnx + fny * fny + fnz * fnz);
            if (len > 0.5f) {
                fnx /= len;
                fny /= len;
                fnz /= len;
            } else {
                fnx = 0.0f; fny = 0.0f; fnz = 0.0f;
            }
            return true;
        }
        return false;
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

        int gx = std::clamp((int)((gauges[g].x - xmin) / cellSize), 0, nx - 1);
        int gy = std::clamp((int)((gauges[g].y - ymin) / cellSize), 0, ny - 1);
        int gz = std::clamp((int)((gauges[g].z - zmin) / cellSize), 0, nz - 1);

        if (has_geom) {
            float b_nx = 0.0f, b_ny = 0.0f, b_nz = 0.0f;
            bool gauge_is_boundary = get_boundary_info(gx, gy, gz, b_nx, b_ny, b_nz);

            // Find the closest boundary cell within search radius (up to 3 cells)
            int closest_bx = -1, closest_by = -1, closest_bz = -1;
            float min_b_dist_sq = 1e9f;
            float closest_nx = 0.0f, closest_ny = 0.0f, closest_nz = 0.0f;

            if (gauge_is_boundary) {
                closest_bx = gx; closest_by = gy; closest_bz = gz;
                closest_nx = b_nx; closest_ny = b_ny; closest_nz = b_nz;
                min_b_dist_sq = 0.0f;
            } else {
                const int SEARCH_R = 3;
                for (int dz = -SEARCH_R; dz <= SEARCH_R; ++dz) {
                    for (int dy = -SEARCH_R; dy <= SEARCH_R; ++dy) {
                        for (int dx = -SEARCH_R; dx <= SEARCH_R; ++dx) {
                            float cur_nx = 0.0f, cur_ny = 0.0f, cur_nz = 0.0f;
                            if (get_boundary_info(gx + dx, gy + dy, gz + dz, cur_nx, cur_ny, cur_nz)) {
                                float d_sq = static_cast<float>(dx * dx + dy * dy + dz * dz);
                                if (d_sq < min_b_dist_sq) {
                                    min_b_dist_sq = d_sq;
                                    closest_bx = gx + dx;
                                    closest_by = gy + dy;
                                    closest_bz = gz + dz;
                                    closest_nx = cur_nx;
                                    closest_ny = cur_ny;
                                    closest_nz = cur_nz;
                                }
                            }
                        }
                    }
                }
            }

            // Determine if the gauge is inside/on a solid or needs snapping to fluid
            bool needs_snap = false;
            float norm_len = std::sqrt(closest_nx * closest_nx + closest_ny * closest_ny + closest_nz * closest_nz);
            bool has_normal = (norm_len > 0.5f);

            if (gauge_is_boundary) {
                needs_snap = true;
            } else if (closest_bx >= 0 && min_b_dist_sq <= 9.001f) {
                if (has_normal) {
                    float vx = static_cast<float>(gx - closest_bx);
                    float vy = static_cast<float>(gy - closest_by);
                    float vz = static_cast<float>(gz - closest_bz);
                    float dot = vx * closest_nx + vy * closest_ny + vz * closest_nz;
                    // If dot < 0.01, probe is on the solid interior side of the facet shell!
                    if (dot < 0.01f) {
                        needs_snap = true;
                    }
                }
            }

            if (needs_snap) {
                int snap_x = gx, snap_y = gy, snap_z = gz;
                float best_fluid_dist_sq = 1e9f;

                int anchor_x = (closest_bx >= 0) ? closest_bx : gx;
                int anchor_y = (closest_by >= 0) ? closest_by : gy;
                int anchor_z = (closest_bz >= 0) ? closest_bz : gz;

                const int CAND_RADIUS = 3;
                for (int dz = -CAND_RADIUS; dz <= CAND_RADIUS; ++dz) {
                    for (int dy = -CAND_RADIUS; dy <= CAND_RADIUS; ++dy) {
                        for (int dx = -CAND_RADIUS; dx <= CAND_RADIUS; ++dx) {
                            if (dx == 0 && dy == 0 && dz == 0) continue;
                            int cx = anchor_x + dx;
                            int cy = anchor_y + dy;
                            int cz = anchor_z + dz;
                            if (cx < 0 || cx >= nx || cy < 0 || cy >= ny || cz < 0 || cz >= nz) continue;
                            if (cell_is_solid(cx, cy, cz)) continue; // Must be fluid (not on boundary)

                            if (has_normal) {
                                float dot = static_cast<float>(cx - closest_bx) * closest_nx +
                                            static_cast<float>(cy - closest_by) * closest_ny +
                                            static_cast<float>(cz - closest_bz) * closest_nz;
                                if (dot <= 0.0f) continue; // MUST be on the outward/fluid side!
                            }

                            // Distance from actual requested probe physical coordinates
                            double cell_cx = xmin + (cx + 0.5) * cellSize;
                            double cell_cy = ymin + (cy + 0.5) * cellSize;
                            double cell_cz = zmin + (cz + 0.5) * cellSize;
                            float phys_d_sq = static_cast<float>(
                                (cell_cx - gauges[g].x) * (cell_cx - gauges[g].x) +
                                (cell_cy - gauges[g].y) * (cell_cy - gauges[g].y) +
                                (cell_cz - gauges[g].z) * (cell_cz - gauges[g].z)
                            );

                            // Bonus preference for boundary-contact cells (so wall pressure gauges stay on the wall fluid cell)
                            if (cell_is_boundary_contact(cx, cy, cz)) {
                                phys_d_sq *= 0.8f;
                            }

                            if (phys_d_sq < best_fluid_dist_sq) {
                                best_fluid_dist_sq = phys_d_sq;
                                snap_x = cx; snap_y = cy; snap_z = cz;
                            }
                        }
                    }
                }

                if (snap_x != gx || snap_y != gy || snap_z != gz) {
                    std::cout << "[GAUGE SNAP] Gauge '" << gauges[g].name
                              << "' adjusted from cell (" << gx << "," << gy << "," << gz << ")"
                              << " to fluid-facing cell (" << snap_x << "," << snap_y << "," << snap_z << ")"
                              << " (normal: " << closest_nx << "," << closest_ny << "," << closest_nz << ")\n";
                    gx = snap_x; gy = snap_y; gz = snap_z;
                }
            }
        }

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

    int ntx = (nx + 7) / 8;
    int nty = (ny + 7) / 8;
    int threads_per_block = 256;
    int blocks_gauge = (num_gauges + threads_per_block - 1) / threads_per_block;
    batch_sample_gauges_kernel_3d<RealType, IsMultiMaterial><<<blocks_gauge, threads_per_block, 0, (cudaStream_t)gauge_stream>>>(
        (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
        (const GeometryTile3D*)d_geom,
        (const GPUGauge3D*)d_gauge_coords,
        (float*)d_gauge_results,
        num_gauges,
        nx, ny, nz,
        ntx, nty
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
    if (d_states_pred) {
        total += total_tiles * sizeof(PrimitivePredictorTile3D<RealType, IsMultiMaterial>);
    }
    if (d_dW_dt) {
        total += total_tiles * sizeof(PrimitivePredictorTile3D<RealType, IsMultiMaterial>);
    }
    if (d_solid_vel_fsi) {
        total += d_solid_vel_fsi_capacity;
    }
    if (d_slice_buf) {
        total += d_slice_buf_capacity;
    }
    if (d_sample_coords) {
        total += d_sample_coords_capacity;
    }
    if (d_obstacle_faces && num_obstacle_faces > 0) {
        total += (size_t)num_obstacle_faces * sizeof(GPUObstacleFace);
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

    num_obstacle_faces = (int)faces.size();
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

// GPU kernel: extract 1-bit solid boundary mask per cell (64 bytes/tile vs 2048 bytes/tile)
static __global__ void kernel_extract_uncovering_mask_3d(
    UncoveringMaskTile3D* d_mask,
    const GeometryTile3D* d_geom,
    int total_tiles
) {
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= total_tiles) return;

    const GeometryTile3D& gt = d_geom[tid];
    UncoveringMaskTile3D& mt = d_mask[tid];

    #pragma unroll
    for (int w = 0; w < 8; ++w) {
        uint64_t word = 0;
        int base = w * 64;
        #pragma unroll
        for (int b = 0; b < 64; ++b) {
            if (gt.cells[base + b].is_boundary) {
                word |= (1ULL << b);
            }
        }
        mt.words[w] = word;
    }
}

// GPU kernel: smooth Inverse Distance Weighted (IDW) state extrapolation for freshly uncovered fluid cells
template <typename RealType, bool IsMultiMaterial>
__global__ void kernel_extrapolate_uncovered_cells_3d(
    PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    ConservativeTile3D<RealType, IsMultiMaterial>* d_U,
    const GeometryTile3D* d_geom,
    const UncoveringMaskTile3D* d_prev_mask,
    int nx, int ny, int nz,
    int ntx, int nty,
    RealType gamma,
    int imin = 0, int imax = -1,
    int jmin = 0, int jmax = -1,
    int kmin = 0, int kmax = -1
) {
    if (imax < 0) imax = nx - 1;
    if (jmax < 0) jmax = ny - 1;
    if (kmax < 0) kmax = nz - 1;

    int gx = imin + blockIdx.x * blockDim.x + threadIdx.x;
    int gy = jmin + blockIdx.y * blockDim.y + threadIdx.y;
    int gz = kmin + blockIdx.z * blockDim.z + threadIdx.z;
    if (gx > imax || gy > jmax || gz > kmax || gx >= nx || gy >= ny || gz >= nz) return;

    int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

    bool prev_is_solid = d_prev_mask && ((d_prev_mask[t_idx].words[c_idx >> 6] & (1ULL << (c_idx & 63))) != 0);
    bool curr_is_solid = d_geom && d_geom[t_idx].cells[c_idx].is_boundary;

    // Freshly uncovered cell: WAS solid in prev_geom, NOW fluid in current geom
    if (prev_is_solid && !curr_is_solid) {
        RealType sum_w = (RealType)0.0;
        RealType sum_rho = (RealType)0.0;
        RealType sum_ux = (RealType)0.0;
        RealType sum_uy = (RealType)0.0;
        RealType sum_uz = (RealType)0.0;
        RealType sum_p = (RealType)0.0;
        RealType sum_a1 = (RealType)0.0;
        RealType sum_a2 = (RealType)0.0;
        RealType sum_arho1 = (RealType)0.0;
        RealType sum_arho2 = (RealType)0.0;

        for (int dz_n = -1; dz_n <= 1; ++dz_n) {
            for (int dy_n = -1; dy_n <= 1; ++dy_n) {
                for (int dx_n = -1; dx_n <= 1; ++dx_n) {
                    if (dx_n == 0 && dy_n == 0 && dz_n == 0) continue;
                    int nx_c = gx + dx_n;
                    int ny_c = gy + dy_n;
                    int nz_c = gz + dz_n;
                    if (nx_c >= 0 && nx_c < nx && ny_c >= 0 && ny_c < ny && nz_c >= 0 && nz_c < nz) {
                        int nt_idx = (nx_c >> 3) + (ny_c >> 3) * ntx + (nz_c >> 3) * ntx * nty;
                        int nc_idx = (nx_c & 7) + (ny_c & 7) * 8 + (nz_c & 7) * 64;
                        bool n_prev_solid = d_prev_mask && ((d_prev_mask[nt_idx].words[nc_idx >> 6] & (1ULL << (nc_idx & 63))) != 0);
                        if (!n_prev_solid) {
                            RealType dist_sq = (RealType)(dx_n * dx_n + dy_n * dy_n + dz_n * dz_n);
                            RealType w = (RealType)1.0 / dist_sq;
                            
                            sum_w += w;
                            sum_rho += w * d_states[nt_idx].rho[nc_idx];
                            sum_ux += w * d_states[nt_idx].ux[nc_idx];
                            sum_uy += w * d_states[nt_idx].uy[nc_idx];
                            sum_uz += w * d_states[nt_idx].uz[nc_idx];
                            sum_p  += w * d_states[nt_idx].p[nc_idx];
                            if constexpr (IsMultiMaterial) {
                                sum_a1    += w * d_states[nt_idx].alpha1[nc_idx];
                                sum_a2    += w * d_states[nt_idx].alpha2[nc_idx];
                                sum_arho1 += w * d_states[nt_idx].arho1[nc_idx];
                                sum_arho2 += w * d_states[nt_idx].arho2[nc_idx];
                            }
                        }
                    }
                }
            }
        }

        if (sum_w > (RealType)1e-8) {
            RealType inv_w = (RealType)1.0 / sum_w;
            RealType ext_rho = sum_rho * inv_w;
            RealType ext_ux  = sum_ux * inv_w;
            RealType ext_uy  = sum_uy * inv_w;
            RealType ext_uz  = sum_uz * inv_w;
            RealType ext_p   = sum_p * inv_w;

            d_states[t_idx].rho[c_idx] = ext_rho;
            d_states[t_idx].ux[c_idx]  = ext_ux;
            d_states[t_idx].uy[c_idx]  = ext_uy;
            d_states[t_idx].uz[c_idx]  = ext_uz;
            d_states[t_idx].p[c_idx]   = ext_p;

            if constexpr (IsMultiMaterial) {
                d_states[t_idx].alpha1[c_idx] = sum_a1 * inv_w;
                d_states[t_idx].alpha2[c_idx] = sum_a2 * inv_w;
                d_states[t_idx].arho1[c_idx]  = sum_arho1 * inv_w;
                d_states[t_idx].arho2[c_idx]  = sum_arho2 * inv_w;
            }

            if (d_U) {
                d_U[t_idx].rho[c_idx]   = ext_rho;
                d_U[t_idx].rhoux[c_idx] = ext_rho * ext_ux;
                d_U[t_idx].rhouy[c_idx] = ext_rho * ext_uy;
                d_U[t_idx].rhouz[c_idx] = ext_rho * ext_uz;

                RealType ke = (RealType)0.5 * ext_rho * (ext_ux * ext_ux + ext_uy * ext_uy + ext_uz * ext_uz);
                if constexpr (IsMultiMaterial) {
                    RealType a1 = sum_a1 * inv_w;
                    RealType a2 = sum_a2 * inv_w;
                    RealType ar1 = sum_arho1 * inv_w;
                    RealType ar2 = sum_arho2 * inv_w;
                    d_U[t_idx].E[c_idx] = MultiMat::getMixtureEnergy<RealType>(ext_p, ext_rho, a1, a2, ar1, ar2, gamma, d_products, d_unreacted) + ke;
                    d_U[t_idx].alpha1[c_idx] = a1;
                    d_U[t_idx].alpha2[c_idx] = a2;
                    d_U[t_idx].arho1[c_idx]  = ar1;
                    d_U[t_idx].arho2[c_idx]  = ar2;
                } else {
                    d_U[t_idx].E[c_idx]     = ext_p / (gamma - (RealType)1.0) + ke;
                }
            }
        }
    }
}

// Lightweight GPU kernel: writes solid mask directly into d_geom, no round-trip to host
static __global__ void kernel_apply_solid_mask(GeometryTile3D* d_geom,
                                        const uint8_t* d_mask,
                                        int nx, int ny, int nz, int ntx, int nty) {
    int gx = blockIdx.x * blockDim.x + threadIdx.x;
    int gy = blockIdx.y * blockDim.y + threadIdx.y;
    int gz = blockIdx.z * blockDim.z + threadIdx.z;
    if (gx >= nx || gy >= ny || gz >= nz) return;

    int cfd_idx = gx + gy * nx + gz * nx * ny;
    int t_idx   = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx   = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

    d_geom[t_idx].cells[c_idx].is_boundary = (d_mask[cfd_idx] != 0);
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setSolidMask(const uint8_t* mask) {
    if (!mask) return;
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    // Allocate geometry buffer if needed (first FSI call)
    if (!d_geom) {
        CHECK_CUDA(cudaMalloc(&d_geom, total_tiles * sizeof(GeometryTile3D)));
        CHECK_CUDA(cudaMemset(d_geom, 0, total_tiles * sizeof(GeometryTile3D)));
    }
    if (!d_prev_mask) {
        CHECK_CUDA(cudaMalloc(&d_prev_mask, total_tiles * sizeof(UncoveringMaskTile3D)));
        CHECK_CUDA(cudaMemset(d_prev_mask, 0, total_tiles * sizeof(UncoveringMaskTile3D)));
    }
    if (!d_tile_is_near_boundary) {
        CHECK_CUDA(cudaMalloc(&d_tile_is_near_boundary, total_tiles * sizeof(uint8_t)));
        CHECK_CUDA(cudaMemset(d_tile_is_near_boundary, 1, total_tiles * sizeof(uint8_t)));
    }

    size_t mask_bytes = static_cast<size_t>(nx) * ny * nz * sizeof(uint8_t);
    if (!d_solid_mask_fsi || d_solid_mask_fsi_capacity < mask_bytes) {
        if (d_solid_mask_fsi) cudaFree(d_solid_mask_fsi);
        CHECK_CUDA(cudaMalloc(&d_solid_mask_fsi, mask_bytes));
        d_solid_mask_fsi_capacity = mask_bytes;
    }

    // Upload mask to GPU (asynchronously using default stream)
    CHECK_CUDA(cudaMemcpy(d_solid_mask_fsi, mask, mask_bytes, cudaMemcpyHostToDevice));

    dim3 block(8, 8, 4);
    dim3 grid((nx + 7) / 8, (ny + 7) / 8, (nz + 3) / 4);

    // Write solid mask into d_geom on GPU
    kernel_apply_solid_mask<<<grid, block>>>(
        (GeometryTile3D*)d_geom, (const uint8_t*)d_solid_mask_fsi, nx, ny, nz, ntx, nty);
    CHECK_CUDA(cudaGetLastError());

    // Extrapolate freshly uncovered fluid cells if previous geometry snapshot exists
    if (has_prev_mask && d_states) {
        kernel_extrapolate_uncovered_cells_3d<RealType, IsMultiMaterial><<<grid, block>>>(
            (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
            (const GeometryTile3D*)d_geom,
            (const UncoveringMaskTile3D*)d_prev_mask,
            nx, ny, nz, ntx, nty, (RealType)gamma
        );
        CHECK_CUDA(cudaGetLastError());
    }

    // Update d_prev_mask snapshot for next step
    int threads_mask = 256;
    int blocks_mask = (total_tiles + threads_mask - 1) / threads_mask;
    kernel_extract_uncovering_mask_3d<<<blocks_mask, threads_mask>>>(d_prev_mask, (const GeometryTile3D*)d_geom, total_tiles);
    CHECK_CUDA(cudaGetLastError());
    has_prev_mask = true;

    // Update near-boundary flags on GPU
    CHECK_CUDA(cudaMemset(d_tile_is_near_boundary, 1, total_tiles * sizeof(uint8_t)));
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setSolidVelocities(const double* v) {
    if (!v) {
        if (d_solid_vel_fsi) { cudaFree(d_solid_vel_fsi); d_solid_vel_fsi = nullptr; d_solid_vel_fsi_capacity = 0; }
        return;
    }
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    if (!d_geom) {
        CHECK_CUDA(cudaMalloc(&d_geom, total_tiles * sizeof(GeometryTile3D)));
        CHECK_CUDA(cudaMemset(d_geom, 0, total_tiles * sizeof(GeometryTile3D)));
    }

    size_t vel_bytes = total_tiles * sizeof(SolidVelocityTile3D);
    if (!d_solid_vel_fsi || d_solid_vel_fsi_capacity < vel_bytes) {
        if (d_solid_vel_fsi) cudaFree(d_solid_vel_fsi);
        CHECK_CUDA(cudaMalloc(&d_solid_vel_fsi, vel_bytes));
        d_solid_vel_fsi_capacity = vel_bytes;
    }

    std::vector<SolidVelocityTile3D> host_vel(total_tiles);
    #pragma omp parallel for collapse(3) schedule(static)
    for (int k = 0; k < nz; ++k) {
        for (int j = 0; j < ny; ++j) {
            for (int i = 0; i < nx; ++i) {
                int t_idx = (i >> 3) + (j >> 3) * ntx + (k >> 3) * ntx * nty;
                int c_idx = (i & 7) + (j & 7) * 8 + (k & 7) * 64;
                size_t cfd_flat = static_cast<size_t>(i) + static_cast<size_t>(j) * nx + static_cast<size_t>(k) * nx * ny;
                host_vel[t_idx].vx[c_idx] = static_cast<float>(v[3 * cfd_flat + 0]);
                host_vel[t_idx].vy[c_idx] = static_cast<float>(v[3 * cfd_flat + 1]);
                host_vel[t_idx].vz[c_idx] = static_cast<float>(v[3 * cfd_flat + 2]);
            }
        }
    }
    CHECK_CUDA(cudaMemcpy(d_solid_vel_fsi, host_vel.data(), vel_bytes, cudaMemcpyHostToDevice));
}

// Bulk pressure extraction for FSI — one cudaMemcpy per tile array, not per cell
template <typename RealType, bool IsMultiMaterial>
std::vector<float> CFDSolver3DCuda<RealType, IsMultiMaterial>::extractPressureField() const {
    ensure_paged_in();
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    // Download all primitive tiles in one transfer
    using Tile = PrimitiveTile3D<RealType, IsMultiMaterial>;
    std::vector<Tile> host_tiles(total_tiles);
    CHECK_CUDA(cudaMemcpy(host_tiles.data(), (const Tile*)d_states,
                          total_tiles * sizeof(Tile), cudaMemcpyDeviceToHost));

    // Unpack tiled pressure into flat [gx + gy*nx + gz*nx*ny] layout
    std::vector<float> pfield(static_cast<size_t>(nx) * ny * nz, 0.0f);
    for (int gz = 0; gz < nz; ++gz) {
        for (int gy = 0; gy < ny; ++gy) {
            for (int gx = 0; gx < nx; ++gx) {
                int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
                int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;
                pfield[gx + gy * nx + gz * nx * ny] = static_cast<float>(host_tiles[t_idx].p[c_idx]);
            }
        }
    }
    return pfield;
}

template <typename RealType, bool IsMultiMaterial>
static __device__ inline float get_fsi_pressure_at(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    int x, int y, int z,
    int nx, int ny, int nz,
    int ntx, int nty
) {
    x = x < 0 ? 0 : (x >= nx ? nx - 1 : x);
    y = y < 0 ? 0 : (y >= ny ? ny - 1 : y);
    z = z < 0 ? 0 : (z >= nz ? nz - 1 : z);
    int tx = x >> 3;
    int ty = y >> 3;
    int tz = z >> 3;
    int t_idx = tx + ty * ntx + tz * ntx * nty;
    int lx = x & 7;
    int ly = y & 7;
    int lz = z & 7;
    int c_idx = lx + ly * 8 + lz * 64;
    return static_cast<float>(d_states[t_idx].p[c_idx]);
}

static __device__ inline float get_mpm_mass_at(const Blast::MPMGridNode3D* grid, int x, int y, int z, int nx, int ny, int nz) {
    x = x < 0 ? 0 : (x >= nx ? nx - 1 : x);
    y = y < 0 ? 0 : (y >= ny ? ny - 1 : y);
    z = z < 0 ? 0 : (z >= nz ? nz - 1 : z);
    int mpm_idx = (x * ny + y) * nz + z;
    return grid[mpm_idx].m_solid;
}

static __device__ inline bool is_fsi_fluid_cell(const Blast::MPMGridNode3D* d_grid, int gx, int gy, int gz, int nx, int ny, int nz) {
    if (gx < 0 || gx >= nx || gy < 0 || gy >= ny || gz < 0 || gz >= nz) return false;
    int idx = (gx * ny + gy) * nz + gz;
    return d_grid[idx].m_solid <= 1.0e-8f;
}

static __global__ void kernel_zero_fsi_grid_ext_forces(Blast::MPMGridNode3D* d_grid, const int* d_active_nodes, int num_active) {
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= num_active) return;
    int idx = d_active_nodes[tid];
    d_grid[idx].f_ext[0] = 0.0f;
    d_grid[idx].f_ext[1] = 0.0f;
    d_grid[idx].f_ext[2] = 0.0f;
}

static __global__ void kernel_zero_all_fsi_grid_ext_forces(Blast::MPMGridNode3D* d_grid, int num_nodes) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_nodes) return;
    d_grid[idx].f_ext[0] = 0.0f;
    d_grid[idx].f_ext[1] = 0.0f;
    d_grid[idx].f_ext[2] = 0.0f;
}

template <typename RealType, bool IsMultiMaterial>
static __global__ void kernel_fsi_couple_gpu(
    PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    GeometryTile3D* d_geom,
    Blast::MPMGridNode3D* d_grid,
    SolidVelocityTile3D* d_solid_vel,
    int nx, int ny, int nz,
    int ntx, int nty,
    float dx, float dy, float dz
) {
    int gx = blockIdx.x * blockDim.x + threadIdx.x;
    int gy = blockIdx.y * blockDim.y + threadIdx.y;
    int gz = blockIdx.z * blockDim.z + threadIdx.z;

    if (gx >= nx || gy >= ny || gz >= nz) return;

    int mpm_idx = (gx * ny + gy) * nz + gz;
    float mass = d_grid[mpm_idx].m;
    if (mass <= 1.0e-8f) {
        d_grid[mpm_idx].f_ext[0] = 0.0f;
        d_grid[mpm_idx].f_ext[1] = 0.0f;
        d_grid[mpm_idx].f_ext[2] = 0.0f;
        return;
    }
    float solid_mass = d_grid[mpm_idx].m_solid;
    bool is_solid = (solid_mass > 1.0e-8f);

    int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

    float vx = d_grid[mpm_idx].p[0] / mass;
    float vy = d_grid[mpm_idx].p[1] / mass;
    float vz = d_grid[mpm_idx].p[2] / mass;

    float z_node = static_cast<float>(d_zmin) + (static_cast<float>(gz) + 0.5f) * dz;
    bool is_structural_solid = is_solid && (!d_stratParams.enabled || z_node >= static_cast<float>(d_stratParams.seabed_surface_z));

    if (d_solid_vel && is_structural_solid) {
        d_solid_vel[t_idx].vx[c_idx] = vx;
        d_solid_vel[t_idx].vy[c_idx] = vy;
        d_solid_vel[t_idx].vz[c_idx] = vz;
    }

    float m_L = get_mpm_mass_at(d_grid, gx - 1, gy, gz, nx, ny, nz);
    float m_R = get_mpm_mass_at(d_grid, gx + 1, gy, gz, nx, ny, nz);
    float m_B = get_mpm_mass_at(d_grid, gx, gy - 1, gz, nx, ny, nz);
    float m_T = get_mpm_mass_at(d_grid, gx, gy + 1, gz, nx, ny, nz);
    float m_D = get_mpm_mass_at(d_grid, gx, gy, gz - 1, nx, ny, nz);
    float m_U = get_mpm_mass_at(d_grid, gx, gy, gz + 1, nx, ny, nz);

    float grad_x = m_R - m_L;
    float grad_y = m_T - m_B;
    float grad_z = m_U - m_D;
    float grad_mag = sqrtf(grad_x * grad_x + grad_y * grad_y + grad_z * grad_z);

    int n_solid_neighbors = 0;
    if (m_L > 1.0e-8f) n_solid_neighbors++;
    if (m_R > 1.0e-8f) n_solid_neighbors++;
    if (m_B > 1.0e-8f) n_solid_neighbors++;
    if (m_T > 1.0e-8f) n_solid_neighbors++;
    if (m_D > 1.0e-8f) n_solid_neighbors++;
    if (m_U > 1.0e-8f) n_solid_neighbors++;

    if (d_geom) {
        if (is_structural_solid && n_solid_neighbors >= 4) {
            float nx_normal = 0.0f, ny_normal = 0.0f, nz_normal = 0.0f;
            if (grad_mag > 1.0e-8f) {
                nx_normal = -grad_x / grad_mag;
                ny_normal = -grad_y / grad_mag;
                nz_normal = -grad_z / grad_mag;
            }
            d_geom[t_idx].cells[c_idx] = pack_geometry_payload(true, nx_normal, ny_normal, nz_normal, 1.0f);
        } else {
            d_geom[t_idx].cells[c_idx] = pack_geometry_payload(false, 0.0f, 0.0f, 0.0f, 0.0f);
        }
    }

    float f_x = 0.0f;
    float f_y = 0.0f;
    float f_z = 0.0f;

    if (is_structural_solid && n_solid_neighbors >= 4) {
        if (gx > 0 && is_fsi_fluid_cell(d_grid, gx - 1, gy, gz, nx, ny, nz)) {
            f_x += get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx - 1, gy, gz, nx, ny, nz, ntx, nty);
        }
        if (is_fsi_fluid_cell(d_grid, gx + 1, gy, gz, nx, ny, nz)) {
            f_x -= get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx + 1, gy, gz, nx, ny, nz, ntx, nty);
        }

        if (gy > 0 && is_fsi_fluid_cell(d_grid, gx, gy - 1, gz, nx, ny, nz)) {
            f_y += get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy - 1, gz, nx, ny, nz, ntx, nty);
        }
        if (is_fsi_fluid_cell(d_grid, gx, gy + 1, gz, nx, ny, nz)) {
            f_y -= get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy + 1, gz, nx, ny, nz, ntx, nty);
        }

        if (is_fsi_fluid_cell(d_grid, gx, gy, gz - 1, nx, ny, nz)) {
            f_z += get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy, gz - 1, nx, ny, nz, ntx, nty);
        }
        if (is_fsi_fluid_cell(d_grid, gx, gy, gz + 1, nx, ny, nz)) {
            f_z -= get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy, gz + 1, nx, ny, nz, ntx, nty);
        }
        if (gx <= 0) f_x = 0.0f;
        if (gy <= 0) f_y = 0.0f;
    } else {
        float p_L = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx - 1, gy, gz, nx, ny, nz, ntx, nty);
        float p_R = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx + 1, gy, gz, nx, ny, nz, ntx, nty);
        float p_B = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy - 1, gz, nx, ny, nz, ntx, nty);
        float p_T = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy + 1, gz, nx, ny, nz, ntx, nty);
        float p_D = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy, gz - 1, nx, ny, nz, ntx, nty);
        float p_U = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy, gz + 1, nx, ny, nz, ntx, nty);
        f_x = (gx <= 0) ? 0.0f : (p_L - p_R);
        f_y = (gy <= 0) ? 0.0f : (p_B - p_T);
        f_z = p_D - p_U;
    }

    float cell_vol = dx * dy * dz;
    float density_ref = is_solid ? 2400.0f : 1000.0f;
    float body_vol = mass / density_ref;

    float F_x = 0.0f, F_y = 0.0f, F_z = 0.0f;

    if (is_structural_solid && n_solid_neighbors >= 4) {
        F_x = f_x * dy * dz;
        F_y = f_y * dx * dz;
        F_z = f_z * dx * dy;
    } else {
        float V_eff = fminf(cell_vol, body_vol);
        float grad_px = f_x / (2.0f * dx);
        float grad_py = f_y / (2.0f * dy);
        float grad_pz = f_z / (2.0f * dz);
        F_x = grad_px * V_eff;
        F_y = grad_py * V_eff;
        F_z = grad_pz * V_eff;
    }

    // Sample surrounding fluid velocity and density to evaluate sub-grid aerodynamic/hydrodynamic drag
    float u_f_sum = 0.0f, v_f_sum = 0.0f, w_f_sum = 0.0f, rho_f_sum = 0.0f, p_f_sum = 0.0f;
    int n_fluid_neighbors = 0;

    auto sample_fsi_fluid_state = [&](int n_gx, int n_gy, int n_gz) {
        if (n_gx >= 0 && n_gx < nx && n_gy >= 0 && n_gy < ny && n_gz >= 0 && n_gz < nz) {
            int n_t = (n_gx >> 3) + (n_gy >> 3) * ntx + (n_gz >> 3) * ntx * nty;
            int n_c = (n_gx & 7) + (n_gy & 7) * 8 + (n_gz & 7) * 64;
            if (!d_geom || !d_geom[n_t].cells[n_c].is_boundary) {
                u_f_sum += static_cast<float>(d_states[n_t].ux[n_c]);
                v_f_sum += static_cast<float>(d_states[n_t].uy[n_c]);
                w_f_sum += static_cast<float>(d_states[n_t].uz[n_c]);
                rho_f_sum += static_cast<float>(d_states[n_t].rho[n_c]);
                p_f_sum += static_cast<float>(d_states[n_t].p[n_c]);
                n_fluid_neighbors++;
            }
        }
    };

    sample_fsi_fluid_state(gx - 1, gy, gz);
    sample_fsi_fluid_state(gx + 1, gy, gz);
    sample_fsi_fluid_state(gx, gy - 1, gz);
    sample_fsi_fluid_state(gx, gy + 1, gz);
    sample_fsi_fluid_state(gx, gy, gz - 1);
    sample_fsi_fluid_state(gx, gy, gz + 1);
    sample_fsi_fluid_state(gx, gy, gz);

    if (n_fluid_neighbors > 0) {
        float inv_n = 1.0f / static_cast<float>(n_fluid_neighbors);
        float u_f = u_f_sum * inv_n;
        float v_f = v_f_sum * inv_n;
        float w_f = w_f_sum * inv_n;
        float rho_f = rho_f_sum * inv_n;
        float p_f = p_f_sum * inv_n;

        float rel_vx = u_f - vx;
        float rel_vy = v_f - vy;
        float rel_vz = w_f - vz;
        float rel_v_mag = sqrtf(rel_vx * rel_vx + rel_vy * rel_vy + rel_vz * rel_vz);

        float exposure = fmaxf(0.5f, static_cast<float>(n_fluid_neighbors) / 7.0f);
        float gamma = 1.4f;
        float c_s = sqrtf(fmaxf(100.0f, gamma * fmaxf(101325.0f, p_f) / fmaxf(0.1f, rho_f)));
        float M_rel = rel_v_mag / c_s;
        float Cd = (M_rel > 1.0f) ? fminf(1.8f, 1.2f + 0.4f * (M_rel - 1.0f)) : 1.0f;

        float A_x = dy * dz;
        float A_y = dx * dz;
        float A_z = dx * dy;

        if (!is_structural_solid || n_solid_neighbors < 4) {
            float A_proj = 1.21f * powf(fmaxf(1.0e-12f, body_vol), 0.6666667f);
            A_x = fminf(A_x, A_proj);
            A_y = fminf(A_y, A_proj);
            A_z = fminf(A_z, A_proj);
        }

        float F_drag_x = 0.5f * Cd * rho_f * A_x * rel_v_mag * rel_vx * exposure;
        float F_drag_y = 0.5f * Cd * rho_f * A_y * rel_v_mag * rel_vy * exposure;
        float F_drag_z = 0.5f * Cd * rho_f * A_z * rel_v_mag * rel_vz * exposure;

        F_x += F_drag_x;
        F_y += F_drag_y;
        F_z += F_drag_z;
    }

    if (!is_structural_solid || n_fluid_neighbors >= 2) {
        if (fabsf(F_x) > 1.0e-12f) atomicAdd(&d_grid[mpm_idx].f_ext[0], F_x);
        if (fabsf(F_y) > 1.0e-12f) atomicAdd(&d_grid[mpm_idx].f_ext[1], F_y);
        if (fabsf(F_z) > 1.0e-12f) atomicAdd(&d_grid[mpm_idx].f_ext[2], F_z);
    } else {
        // Continuous structural solid: mass-weighted distribution across local solid column stencil
        if (fabsf(F_z) > 1.0e-12f) {
            float mass_z_stencil = 0.0f;
            for (int dk = -2; dk <= 2; ++dk) {
                int k_c = gz + dk;
                if (k_c >= 0 && k_c < nz) {
                    int k_idx = (gx * ny + gy) * nz + k_c;
                    if (d_grid[k_idx].m > 1.0e-8f) mass_z_stencil += d_grid[k_idx].m;
                }
            }
            if (mass_z_stencil > 1.0e-12f) {
                for (int dk = -2; dk <= 2; ++dk) {
                    int k_c = gz + dk;
                    if (k_c >= 0 && k_c < nz) {
                        int k_idx = (gx * ny + gy) * nz + k_c;
                        if (d_grid[k_idx].m > 1.0e-8f) {
                            atomicAdd(&d_grid[k_idx].f_ext[2], F_z * (d_grid[k_idx].m / mass_z_stencil));
                        }
                    }
                }
            } else {
                atomicAdd(&d_grid[mpm_idx].f_ext[2], F_z);
            }
        }

        if (fabsf(F_x) > 1.0e-12f) {
            float mass_x_stencil = 0.0f;
            for (int di = -2; di <= 2; ++di) {
                int i_c = gx + di;
                if (i_c >= 0 && i_c < nx) {
                    int i_idx = (i_c * ny + gy) * nz + gz;
                    if (d_grid[i_idx].m > 1.0e-8f) mass_x_stencil += d_grid[i_idx].m;
                }
            }
            if (mass_x_stencil > 1.0e-12f) {
                for (int di = -2; di <= 2; ++di) {
                    int i_c = gx + di;
                    if (i_c >= 0 && i_c < nx) {
                        int i_idx = (i_c * ny + gy) * nz + gz;
                        if (d_grid[i_idx].m > 1.0e-8f) {
                            atomicAdd(&d_grid[i_idx].f_ext[0], F_x * (d_grid[i_idx].m / mass_x_stencil));
                        }
                    }
                }
            } else {
                atomicAdd(&d_grid[mpm_idx].f_ext[0], F_x);
            }
        }

        if (fabsf(F_y) > 1.0e-12f) {
            float mass_y_stencil = 0.0f;
            for (int dj = -2; dj <= 2; ++dj) {
                int j_c = gy + dj;
                if (j_c >= 0 && j_c < ny) {
                    int j_idx = (gx * ny + j_c) * nz + gz;
                    if (d_grid[j_idx].m > 1.0e-8f) mass_y_stencil += d_grid[j_idx].m;
                }
            }
            if (mass_y_stencil > 1.0e-12f) {
                for (int dj = -2; dj <= 2; ++dj) {
                    int j_c = gy + dj;
                    if (j_c >= 0 && j_c < ny) {
                        int j_idx = (gx * ny + j_c) * nz + gz;
                        if (d_grid[j_idx].m > 1.0e-8f) {
                            atomicAdd(&d_grid[j_idx].f_ext[1], F_y * (d_grid[j_idx].m / mass_y_stencil));
                        }
                    }
                }
            } else {
                atomicAdd(&d_grid[mpm_idx].f_ext[1], F_y);
            }
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
static __global__ void kernel_fsi_couple_active_gpu(
    PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    GeometryTile3D* d_geom,
    Blast::MPMGridNode3D* d_grid,
    const int* d_active_nodes,
    int num_active_nodes,
    SolidVelocityTile3D* d_solid_vel,
    int nx_cfd, int ny_cfd, int nz_cfd,
    int ntx, int nty,
    float dx_cfd, float dy_cfd, float dz_cfd,
    float xmin_cfd, float ymin_cfd, float zmin_cfd,
    int nx_mpm, int ny_mpm, int nz_mpm,
    float dx_mpm, float dy_mpm, float dz_mpm,
    float xmin_mpm, float ymin_mpm, float zmin_mpm
) {
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= num_active_nodes) return;

    int mpm_idx = d_active_nodes[tid];
    float mass = d_grid[mpm_idx].m;
    if (mass <= 1.0e-8f) {
        d_grid[mpm_idx].f_ext[0] = 0.0f;
        d_grid[mpm_idx].f_ext[1] = 0.0f;
        d_grid[mpm_idx].f_ext[2] = 0.0f;
        return;
    }
    float solid_mass = d_grid[mpm_idx].m_solid;
    bool is_solid = (solid_mass > 1.0e-8f);

    int k_mpm = mpm_idx % nz_mpm;
    int j_mpm = (mpm_idx / nz_mpm) % ny_mpm;
    int i_mpm = mpm_idx / (ny_mpm * nz_mpm);

    float x_node = xmin_mpm + (static_cast<float>(i_mpm) + 0.5f) * dx_mpm;
    float y_node = ymin_mpm + (static_cast<float>(j_mpm) + 0.5f) * dy_mpm;
    float z_node = zmin_mpm + (static_cast<float>(k_mpm) + 0.5f) * dz_mpm;

    int gx = static_cast<int>(floorf((x_node - xmin_cfd) / dx_cfd));
    int gy = static_cast<int>(floorf((y_node - ymin_cfd) / dy_cfd));
    int gz = static_cast<int>(floorf((z_node - zmin_cfd) / dz_cfd));

    if (gx < 0 || gx >= nx_cfd || gy < 0 || gy >= ny_cfd || gz < 0 || gz >= nz_cfd) return;

    int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

    float vx = d_grid[mpm_idx].p[0] / mass;
    float vy = d_grid[mpm_idx].p[1] / mass;
    float vz = d_grid[mpm_idx].p[2] / mass;

    bool is_structural_solid = is_solid && (!d_stratParams.enabled || z_node >= static_cast<float>(d_stratParams.seabed_surface_z));

    if (d_solid_vel && is_structural_solid) {
        d_solid_vel[t_idx].vx[c_idx] = vx;
        d_solid_vel[t_idx].vy[c_idx] = vy;
        d_solid_vel[t_idx].vz[c_idx] = vz;
    }

    float m_L = get_mpm_mass_at(d_grid, i_mpm - 1, j_mpm, k_mpm, nx_mpm, ny_mpm, nz_mpm);
    float m_R = get_mpm_mass_at(d_grid, i_mpm + 1, j_mpm, k_mpm, nx_mpm, ny_mpm, nz_mpm);
    float m_B = get_mpm_mass_at(d_grid, i_mpm, j_mpm - 1, k_mpm, nx_mpm, ny_mpm, nz_mpm);
    float m_T = get_mpm_mass_at(d_grid, i_mpm, j_mpm + 1, k_mpm, nx_mpm, ny_mpm, nz_mpm);
    float m_D = get_mpm_mass_at(d_grid, i_mpm, j_mpm, k_mpm - 1, nx_mpm, ny_mpm, nz_mpm);
    float m_U = get_mpm_mass_at(d_grid, i_mpm, j_mpm, k_mpm + 1, nx_mpm, ny_mpm, nz_mpm);

    float grad_x = m_R - m_L;
    float grad_y = m_T - m_B;
    float grad_z = m_U - m_D;
    float grad_mag = sqrtf(grad_x * grad_x + grad_y * grad_y + grad_z * grad_z);

    int n_solid_neighbors = 0;
    if (m_L > 1.0e-8f) n_solid_neighbors++;
    if (m_R > 1.0e-8f) n_solid_neighbors++;
    if (m_B > 1.0e-8f) n_solid_neighbors++;
    if (m_T > 1.0e-8f) n_solid_neighbors++;
    if (m_D > 1.0e-8f) n_solid_neighbors++;
    if (m_U > 1.0e-8f) n_solid_neighbors++;

    // Only continuum structural solid bodies mark impermeable wall boundaries in CFD;
    // seabed soil foundation and eroded sub-grid debris fragments allow fluid to flow past with full hydrodynamic drag and pressure gradients
    if (d_geom && is_structural_solid && n_solid_neighbors >= 4) {
        float nx_normal = 0.0f, ny_normal = 0.0f, nz_normal = 0.0f;
        if (grad_mag > 1.0e-8f) {
            nx_normal = -grad_x / grad_mag;
            ny_normal = -grad_y / grad_mag;
            nz_normal = -grad_z / grad_mag;
        }
        d_geom[t_idx].cells[c_idx] = pack_geometry_payload(true, nx_normal, ny_normal, nz_normal, 1.0f);
    }

    float f_x = 0.0f;
    float f_y = 0.0f;
    float f_z = 0.0f;

    if (is_structural_solid && n_solid_neighbors >= 4) {
        if (i_mpm > 0 && gx > 0 && is_fsi_fluid_cell(d_grid, i_mpm - 1, j_mpm, k_mpm, nx_mpm, ny_mpm, nz_mpm)) {
            f_x += get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx - 1, gy, gz, nx_cfd, ny_cfd, nz_cfd, ntx, nty);
        }
        if (is_fsi_fluid_cell(d_grid, i_mpm + 1, j_mpm, k_mpm, nx_mpm, ny_mpm, nz_mpm)) {
            f_x -= get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx + 1, gy, gz, nx_cfd, ny_cfd, nz_cfd, ntx, nty);
        }

        if (j_mpm > 0 && gy > 0 && is_fsi_fluid_cell(d_grid, i_mpm, j_mpm - 1, k_mpm, nx_mpm, ny_mpm, nz_mpm)) {
            f_y += get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy - 1, gz, nx_cfd, ny_cfd, nz_cfd, ntx, nty);
        }
        if (is_fsi_fluid_cell(d_grid, i_mpm, j_mpm + 1, k_mpm, nx_mpm, ny_mpm, nz_mpm)) {
            f_y -= get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy + 1, gz, nx_cfd, ny_cfd, nz_cfd, ntx, nty);
        }

        if (is_fsi_fluid_cell(d_grid, i_mpm, j_mpm, k_mpm - 1, nx_mpm, ny_mpm, nz_mpm)) {
            f_z += get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy, gz - 1, nx_cfd, ny_cfd, nz_cfd, ntx, nty);
        }
        if (is_fsi_fluid_cell(d_grid, i_mpm, j_mpm, k_mpm + 1, nx_mpm, ny_mpm, nz_mpm)) {
            f_z -= get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy, gz + 1, nx_cfd, ny_cfd, nz_cfd, ntx, nty);
        }
        if (i_mpm <= 0 || gx <= 0) f_x = 0.0f;
        if (j_mpm <= 0 || gy <= 0) f_y = 0.0f;
    } else {
        float p_L = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx - 1, gy, gz, nx_cfd, ny_cfd, nz_cfd, ntx, nty);
        float p_R = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx + 1, gy, gz, nx_cfd, ny_cfd, nz_cfd, ntx, nty);
        float p_B = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy - 1, gz, nx_cfd, ny_cfd, nz_cfd, ntx, nty);
        float p_T = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy + 1, gz, nx_cfd, ny_cfd, nz_cfd, ntx, nty);
        float p_D = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy, gz - 1, nx_cfd, ny_cfd, nz_cfd, ntx, nty);
        float p_U = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy, gz + 1, nx_cfd, ny_cfd, nz_cfd, ntx, nty);
        f_x = (i_mpm <= 0 || gx <= 0) ? 0.0f : (p_L - p_R);
        f_y = (j_mpm <= 0 || gy <= 0) ? 0.0f : (p_B - p_T);
        f_z = p_D - p_U;
    }

    float cell_vol_mpm = dx_mpm * dy_mpm * dz_mpm;
    float density_ref = is_solid ? 2400.0f : 1000.0f;
    float body_vol = mass / density_ref;

    float F_x = 0.0f, F_y = 0.0f, F_z = 0.0f;

    if (is_structural_solid && n_solid_neighbors >= 4) {
        // Continuum solid boundary: full macroscopic cell face pressure
        F_x = f_x * dy_cfd * dz_cfd;
        F_y = f_y * dx_cfd * dz_cfd;
        F_z = f_z * dx_cfd * dy_cfd;
    } else {
        // Sub-grid debris or fluid sleeve: volumetric pressure gradient force F = -V_eff * grad(P)
        float V_eff = fminf(cell_vol_mpm, body_vol);
        float grad_px = f_x / (2.0f * dx_cfd);
        float grad_py = f_y / (2.0f * dy_cfd);
        float grad_pz = f_z / (2.0f * dz_cfd);
        F_x = grad_px * V_eff;
        F_y = grad_py * V_eff;
        F_z = grad_pz * V_eff;
    }

    // Sample surrounding fluid velocity, density and pressure to evaluate aerodynamic drag and pressure forces
    float u_f_sum = 0.0f, v_f_sum = 0.0f, w_f_sum = 0.0f, rho_f_sum = 0.0f, p_f_sum = 0.0f;
    int n_fluid_neighbors = 0;

    auto sample_fsi_fluid_state = [&](int n_gx, int n_gy, int n_gz) {
        if (n_gx >= 0 && n_gx < nx_cfd && n_gy >= 0 && n_gy < ny_cfd && n_gz >= 0 && n_gz < nz_cfd) {
            int n_t = (n_gx >> 3) + (n_gy >> 3) * ntx + (n_gz >> 3) * ntx * nty;
            int n_c = (n_gx & 7) + (n_gy & 7) * 8 + (n_gz & 7) * 64;
            if (!d_geom || !d_geom[n_t].cells[n_c].is_boundary) {
                u_f_sum += static_cast<float>(d_states[n_t].ux[n_c]);
                v_f_sum += static_cast<float>(d_states[n_t].uy[n_c]);
                w_f_sum += static_cast<float>(d_states[n_t].uz[n_c]);
                rho_f_sum += static_cast<float>(d_states[n_t].rho[n_c]);
                p_f_sum += static_cast<float>(d_states[n_t].p[n_c]);
                n_fluid_neighbors++;
            }
        }
    };

    sample_fsi_fluid_state(gx - 1, gy, gz);
    sample_fsi_fluid_state(gx + 1, gy, gz);
    sample_fsi_fluid_state(gx, gy - 1, gz);
    sample_fsi_fluid_state(gx, gy + 1, gz);
    sample_fsi_fluid_state(gx, gy, gz - 1);
    sample_fsi_fluid_state(gx, gy, gz + 1);
    sample_fsi_fluid_state(gx, gy, gz);

    if (n_fluid_neighbors > 0) {
        float inv_n = 1.0f / static_cast<float>(n_fluid_neighbors);
        float u_f = u_f_sum * inv_n;
        float v_f = v_f_sum * inv_n;
        float w_f = w_f_sum * inv_n;
        float rho_f = rho_f_sum * inv_n;
        float p_f = p_f_sum * inv_n;

        float rel_vx = u_f - vx;
        float rel_vy = v_f - vy;
        float rel_vz = w_f - vz;
        float rel_v_mag = sqrtf(rel_vx * rel_vx + rel_vy * rel_vy + rel_vz * rel_vz);

        float exposure = fmaxf(0.5f, static_cast<float>(n_fluid_neighbors) / 7.0f);
        float gamma = 1.4f;
        float c_s = sqrtf(fmaxf(100.0f, gamma * fmaxf(101325.0f, p_f) / fmaxf(0.1f, rho_f)));
        float M_rel = rel_v_mag / c_s;
        float Cd = (M_rel > 1.0f) ? fminf(1.8f, 1.2f + 0.4f * (M_rel - 1.0f)) : 1.0f;

        float A_x = dy_cfd * dz_cfd;
        float A_y = dx_cfd * dz_cfd;
        float A_z = dx_cfd * dy_cfd;

        if (!is_structural_solid || n_solid_neighbors < 4) {
            float A_proj = 1.21f * powf(fmaxf(1.0e-12f, body_vol), 0.6666667f);
            A_x = fminf(A_x, A_proj);
            A_y = fminf(A_y, A_proj);
            A_z = fminf(A_z, A_proj);
        }

        float F_drag_x = 0.5f * Cd * rho_f * A_x * rel_v_mag * rel_vx * exposure;
        float F_drag_y = 0.5f * Cd * rho_f * A_y * rel_v_mag * rel_vy * exposure;
        float F_drag_z = 0.5f * Cd * rho_f * A_z * rel_v_mag * rel_vz * exposure;

        F_x += F_drag_x;
        F_y += F_drag_y;
        F_z += F_drag_z;
    }

    // Physical acceleration limiter: prevent divide-by-small-mass numerical runaway on debris
    if (mass > 1.0e-8f && (!is_structural_solid || n_solid_neighbors < 4)) {
        float max_a = 500000.0f; // 500,000 m/s^2 upper physical bound (e.g., 5 m/s per 10us step)
        float a_mag = sqrtf((F_x * F_x + F_y * F_y + F_z * F_z) / (mass * mass));
        if (a_mag > max_a) {
            float scale_a = max_a / a_mag;
            F_x *= scale_a;
            F_y *= scale_a;
            F_z *= scale_a;
        }
    }

    // Direct force application for fluid particles and exposed debris fragments; mass-weighted stencil for continuous solids
    if (!is_structural_solid || n_fluid_neighbors >= 2) {
        if (fabsf(F_x) > 1.0e-12f) atomicAdd(&d_grid[mpm_idx].f_ext[0], F_x);
        if (fabsf(F_y) > 1.0e-12f) atomicAdd(&d_grid[mpm_idx].f_ext[1], F_y);
        if (fabsf(F_z) > 1.0e-12f) atomicAdd(&d_grid[mpm_idx].f_ext[2], F_z);
    } else {
        if (fabsf(F_z) > 1.0e-12f) {
            float mass_z_stencil = 0.0f;
            for (int dk = -2; dk <= 2; ++dk) {
                int k_c = k_mpm + dk;
                if (k_c >= 0 && k_c < nz_mpm) {
                    int k_idx = (i_mpm * ny_mpm + j_mpm) * nz_mpm + k_c;
                    if (d_grid[k_idx].m > 1.0e-8f) mass_z_stencil += d_grid[k_idx].m;
                }
            }
            if (mass_z_stencil > 1.0e-12f) {
                for (int dk = -2; dk <= 2; ++dk) {
                    int k_c = k_mpm + dk;
                    if (k_c >= 0 && k_c < nz_mpm) {
                        int k_idx = (i_mpm * ny_mpm + j_mpm) * nz_mpm + k_c;
                        if (d_grid[k_idx].m > 1.0e-8f) {
                            atomicAdd(&d_grid[k_idx].f_ext[2], F_z * (d_grid[k_idx].m / mass_z_stencil));
                        }
                    }
                }
            } else {
                atomicAdd(&d_grid[mpm_idx].f_ext[2], F_z);
            }
        }

        if (fabsf(F_x) > 1.0e-12f) {
            float mass_x_stencil = 0.0f;
            for (int di = -2; di <= 2; ++di) {
                int i_c = i_mpm + di;
                if (i_c >= 0 && i_c < nx_mpm) {
                    int i_idx = (i_c * ny_mpm + j_mpm) * nz_mpm + k_mpm;
                    if (d_grid[i_idx].m > 1.0e-8f) mass_x_stencil += d_grid[i_idx].m;
                }
            }
            if (mass_x_stencil > 1.0e-12f) {
                for (int di = -2; di <= 2; ++di) {
                    int i_c = i_mpm + di;
                    if (i_c >= 0 && i_c < nx_mpm) {
                        int i_idx = (i_c * ny_mpm + j_mpm) * nz_mpm + k_mpm;
                        if (d_grid[i_idx].m > 1.0e-8f) {
                            atomicAdd(&d_grid[i_idx].f_ext[0], F_x * (d_grid[i_idx].m / mass_x_stencil));
                        }
                    }
                }
            } else {
                atomicAdd(&d_grid[mpm_idx].f_ext[0], F_x);
            }
        }

        if (fabsf(F_y) > 1.0e-12f) {
            float mass_y_stencil = 0.0f;
            for (int dj = -2; dj <= 2; ++dj) {
                int j_c = j_mpm + dj;
                if (j_c >= 0 && j_c < ny_mpm) {
                    int j_idx = (i_mpm * ny_mpm + j_c) * nz_mpm + k_mpm;
                    if (d_grid[j_idx].m > 1.0e-8f) mass_y_stencil += d_grid[j_idx].m;
                }
            }
            if (mass_y_stencil > 1.0e-12f) {
                for (int dj = -2; dj <= 2; ++dj) {
                    int j_c = j_mpm + dj;
                    if (j_c >= 0 && j_c < ny_mpm) {
                        int j_idx = (i_mpm * ny_mpm + j_c) * nz_mpm + k_mpm;
                        if (d_grid[j_idx].m > 1.0e-8f) {
                            atomicAdd(&d_grid[j_idx].f_ext[1], F_y * (d_grid[j_idx].m / mass_y_stencil));
                        }
                    }
                }
            } else {
                atomicAdd(&d_grid[mpm_idx].f_ext[1], F_y);
            }
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
__device__ inline RealType get_fsi_neighbor_fluid_pressure(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    const Blast::MPMGridNode3D* d_grid,
    int gx, int gy, int gz,
    int nx, int ny, int nz,
    int ntx, int nty
) {
    int t_idx_self = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx_self = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;
    RealType self_p = d_states[t_idx_self].p[c_idx_self];
    RealType sum_p = 0.0;
    int count = 0;

    const int dxs[6] = {-1, 1, 0, 0, 0, 0};
    const int dys[6] = {0, 0, -1, 1, 0, 0};
    const int dzs[6] = {0, 0, 0, 0, -1, 1};

    for (int i = 0; i < 6; ++i) {
        int nx_i = gx + dxs[i];
        int ny_i = gy + dys[i];
        int nz_i = gz + dzs[i];
        if (nx_i >= 0 && nx_i < nx && ny_i >= 0 && ny_i < ny && nz_i >= 0 && nz_i < nz) {
            int mpm_idx = (nx_i * ny + ny_i) * nz + nz_i;
            if (d_grid[mpm_idx].m_solid <= 1.0e-8f) {
                int t_idx = (nx_i >> 3) + (ny_i >> 3) * ntx + (nz_i >> 3) * ntx * nty;
                int c_idx = (nx_i & 7) + (ny_i & 7) * 8 + (nz_i & 7) * 64;
                sum_p += d_states[t_idx].p[c_idx];
                count++;
            }
        }
    }
    if (count > 0) {
        return sum_p / (RealType)count;
    }
    return self_p;
}

template <typename RealType, bool IsMultiMaterial>
__global__ void kernel_fsi_apply_penalty_gpu(
    PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    ConservativeTile3D<RealType, IsMultiMaterial>* d_U,
    const Blast::MPMGridNode3D* d_grid,
    int nx, int ny, int nz,
    int ntx, int nty,
    float dx, float dy, float dz,
    float gamma
) {
    int gx = blockIdx.x * blockDim.x + threadIdx.x;
    int gy = blockIdx.y * blockDim.y + threadIdx.y;
    int gz = blockIdx.z * blockDim.z + threadIdx.z;

    if (gx >= nx || gy >= ny || gz >= nz) return;

    int mpm_idx = (gx * ny + gy) * nz + gz;
    float solid_mass = d_grid[mpm_idx].m_solid;

    if (solid_mass <= 1.0e-8f) return;
    float z_cell = static_cast<float>(d_zmin) + (static_cast<float>(gz) + 0.5f) * dz;
    if (d_stratParams.enabled && z_cell < static_cast<float>(d_stratParams.seabed_surface_z) + 2.0f * dz) {
        return; // Do not apply rigid solid penalty velocity clamping to seabed geotechnical foundation or mudline halo
    }
    float mass = d_grid[mpm_idx].m;

    float vx = d_grid[mpm_idx].p[0] / mass;
    float vy = d_grid[mpm_idx].p[1] / mass;
    float vz = d_grid[mpm_idx].p[2] / mass;

    int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

    RealType new_ux = (RealType)vx;
    RealType new_uy = (RealType)vy;
    RealType new_uz = (RealType)vz;

    // Mirror fluid pressure from neighboring fluid cells to prevent unphysical pressure suppression
    RealType mirrored_p = get_fsi_neighbor_fluid_pressure<RealType, IsMultiMaterial>(d_states, d_grid, gx, gy, gz, nx, ny, nz, ntx, nty);

    // Update Primitive tile velocity and mirrored pressure
    d_states[t_idx].ux[c_idx] = new_ux;
    d_states[t_idx].uy[c_idx] = new_uy;
    d_states[t_idx].uz[c_idx] = new_uz;
    d_states[t_idx].p[c_idx]  = mirrored_p;

    // Update Conservative tile (d_U) — SSOT for CFD solver!
    if (d_U) {
        RealType rho = d_U[t_idx].rho[c_idx];
        if (rho < (RealType)1e-6) rho = (RealType)1e-6;

        RealType new_rhoux = rho * new_ux;
        RealType new_rhouy = rho * new_uy;
        RealType new_rhouz = rho * new_uz;
        RealType new_ke = (RealType)0.5 * rho * (new_ux * new_ux + new_uy * new_uy + new_uz * new_uz);

        d_U[t_idx].rhoux[c_idx] = new_rhoux;
        d_U[t_idx].rhouy[c_idx] = new_rhouy;
        d_U[t_idx].rhouz[c_idx] = new_rhouz;
        if constexpr (IsMultiMaterial) {
            RealType a1 = d_U[t_idx].alpha1[c_idx];
            RealType a2 = d_U[t_idx].alpha2[c_idx];
            RealType ar1 = d_U[t_idx].arho1[c_idx];
            RealType ar2 = d_U[t_idx].arho2[c_idx];
            if (is_cell_water(rho, (RealType)z_cell)) {
                d_U[t_idx].E[c_idx] = MultiMat::getMixtureEnergyTait<RealType>(mirrored_p, rho, a1, a2, ar1, ar2, d_taitParams, d_products, d_unreacted) + new_ke;
            } else if (is_cell_soil(rho, (RealType)z_cell)) {
                d_U[t_idx].E[c_idx] = computeFluidEnergyGPU<RealType>(mirrored_p, rho, (RealType)gamma, (RealType)z_cell) + new_ke;
            } else {
                d_U[t_idx].E[c_idx] = MultiMat::getMixtureEnergy<RealType>(mirrored_p, rho, a1, a2, ar1, ar2, (RealType)gamma, d_products, d_unreacted) + new_ke;
            }
        } else {
            d_U[t_idx].E[c_idx] = computeFluidEnergyGPU<RealType>(mirrored_p, rho, (RealType)gamma, (RealType)z_cell) + new_ke;
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void kernel_fsi_apply_penalty_active_gpu(
    PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    ConservativeTile3D<RealType, IsMultiMaterial>* d_U,
    const Blast::MPMGridNode3D* d_grid,
    const int* d_active_nodes,
    int num_active_nodes,
    int nx, int ny, int nz,
    int ntx, int nty,
    float dx, float dy, float dz,
    float gamma
) {
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= num_active_nodes) return;

    int mpm_idx = d_active_nodes[tid];
    float solid_mass = d_grid[mpm_idx].m_solid;

    if (solid_mass <= 1.0e-8f) return;
    int gx = mpm_idx / (ny * nz);
    int gy = (mpm_idx / nz) % ny;
    int gz = mpm_idx % nz;

    float z_cell = static_cast<float>(d_zmin) + (static_cast<float>(gz) + 0.5f) * dz;
    if (d_stratParams.enabled && z_cell < static_cast<float>(d_stratParams.seabed_surface_z) + 2.0f * dz) {
        return; // Do not apply rigid solid penalty velocity clamping to seabed geotechnical foundation or mudline halo
    }
    float mass = d_grid[mpm_idx].m;

    float vx = d_grid[mpm_idx].p[0] / mass;
    float vy = d_grid[mpm_idx].p[1] / mass;
    float vz = d_grid[mpm_idx].p[2] / mass;

    int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

    RealType new_ux = (RealType)vx;
    RealType new_uy = (RealType)vy;
    RealType new_uz = (RealType)vz;

    RealType mirrored_p = get_fsi_neighbor_fluid_pressure<RealType, IsMultiMaterial>(d_states, d_grid, gx, gy, gz, nx, ny, nz, ntx, nty);

    d_states[t_idx].ux[c_idx] = new_ux;
    d_states[t_idx].uy[c_idx] = new_uy;
    d_states[t_idx].uz[c_idx] = new_uz;
    d_states[t_idx].p[c_idx]  = mirrored_p;

    if (d_U) {
        RealType rho = d_U[t_idx].rho[c_idx];
        if (rho < (RealType)1e-6) rho = (RealType)1e-6;

        RealType new_rhoux = rho * new_ux;
        RealType new_rhouy = rho * new_uy;
        RealType new_rhouz = rho * new_uz;
        RealType new_ke = (RealType)0.5 * rho * (new_ux * new_ux + new_uy * new_uy + new_uz * new_uz);

        d_U[t_idx].rhoux[c_idx] = new_rhoux;
        d_U[t_idx].rhouy[c_idx] = new_rhouy;
        d_U[t_idx].rhouz[c_idx] = new_rhouz;
        if constexpr (IsMultiMaterial) {
            RealType a1 = d_U[t_idx].alpha1[c_idx];
            RealType a2 = d_U[t_idx].alpha2[c_idx];
            RealType ar1 = d_U[t_idx].arho1[c_idx];
            RealType ar2 = d_U[t_idx].arho2[c_idx];
            if (is_cell_water(rho, (RealType)z_cell)) {
                d_U[t_idx].E[c_idx] = MultiMat::getMixtureEnergyTait<RealType>(mirrored_p, rho, a1, a2, ar1, ar2, d_taitParams, d_products, d_unreacted) + new_ke;
            } else if (is_cell_soil(rho, (RealType)z_cell)) {
                d_U[t_idx].E[c_idx] = computeFluidEnergyGPU<RealType>(mirrored_p, rho, (RealType)gamma, (RealType)z_cell) + new_ke;
            } else {
                d_U[t_idx].E[c_idx] = MultiMat::getMixtureEnergy<RealType>(mirrored_p, rho, a1, a2, ar1, ar2, (RealType)gamma, d_products, d_unreacted) + new_ke;
            }
        } else {
            d_U[t_idx].E[c_idx] = computeFluidEnergyGPU<RealType>(mirrored_p, rho, (RealType)gamma, (RealType)z_cell) + new_ke;
        }
    }
}

static __global__ void kernel_mark_tile_has_boundary_3d(
    const GeometryTile3D* d_geom,
    uint8_t* d_tile_has_boundary,
    int total_tiles
) {
    int t_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (t_idx >= total_tiles) return;

    bool has_b = false;
    for (int c = 0; c < TILE_CELLS_3D; ++c) {
        if (d_geom[t_idx].cells[c].is_boundary) {
            has_b = true;
            break;
        }
    }
    d_tile_has_boundary[t_idx] = has_b ? 1 : 0;
}

static __global__ void kernel_update_fsi_tile_boundary_flags(
    const uint8_t* d_tile_has_boundary,
    uint8_t* d_tile_is_near_boundary,
    int ntx, int nty, int ntz
) {
    int t_idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total_tiles = ntx * nty * ntz;
    if (t_idx >= total_tiles) return;

    int tz = t_idx / (ntx * nty);
    int ty = (t_idx / ntx) % nty;
    int tx = t_idx % ntx;

    bool near = false;
    for (int dz = -1; dz <= 1 && !near; ++dz) {
        for (int dy = -1; dy <= 1 && !near; ++dy) {
            for (int dx = -1; dx <= 1 && !near; ++dx) {
                int nx_t = tx + dx;
                int ny_t = ty + dy;
                int nz_t = tz + dz;
                if (nx_t >= 0 && nx_t < ntx && ny_t >= 0 && ny_t < nty && nz_t >= 0 && nz_t < ntz) {
                    int n_idx = nx_t + ny_t * ntx + nz_t * ntx * nty;
                    if (d_tile_has_boundary[n_idx]) {
                        near = true;
                        break;
                    }
                }
            }
        }
    }
    d_tile_is_near_boundary[t_idx] = near ? 1 : 0;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::coupleFSIWithMPMGPU(void* mpm_solver_void) {
    ensure_paged_in();
    if (!mpm_solver_void) return;
    Blast::MPMSolver3DCUDA* mpm_solver = static_cast<Blast::MPMSolver3DCUDA*>(mpm_solver_void);
    Blast::MPMGridNode3D* d_grid = mpm_solver->getDeviceGrid();
    if (!d_grid) return;
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    float mpm_dx = mpm_solver->getDx();
    float mpm_dy = mpm_solver->getDy();
    float mpm_dz = mpm_solver->getDz();

    dim3 block(8, 8, 4);
    dim3 grid((nx + 7) / 8, (ny + 7) / 8, (nz + 3) / 4);

    // Save MPM grid pointer for CFD penalty step
    this->d_fsi_mpm_grid = d_grid;

    // Allocate geometry buffers and tile proximity flags if needed (first FSI call)
    if (!d_geom) {
        CHECK_CUDA(cudaMalloc(&d_geom, total_tiles * sizeof(GeometryTile3D)));
        CHECK_CUDA(cudaMemset(d_geom, 0, total_tiles * sizeof(GeometryTile3D)));
    }
    if (!d_prev_mask) {
        CHECK_CUDA(cudaMalloc(&d_prev_mask, total_tiles * sizeof(UncoveringMaskTile3D)));
        CHECK_CUDA(cudaMemset(d_prev_mask, 0, total_tiles * sizeof(UncoveringMaskTile3D)));
    }
    if (!d_tile_is_near_boundary) {
        CHECK_CUDA(cudaMalloc(&d_tile_is_near_boundary, total_tiles * sizeof(uint8_t)));
        CHECK_CUDA(cudaMemset(d_tile_is_near_boundary, 1, total_tiles * sizeof(uint8_t)));
    }

    size_t vel_bytes = total_tiles * sizeof(SolidVelocityTile3D);
    if (!d_solid_vel_fsi || d_solid_vel_fsi_capacity < vel_bytes) {
        if (d_solid_vel_fsi) cudaFree(d_solid_vel_fsi);
        CHECK_CUDA(cudaMalloc(&d_solid_vel_fsi, vel_bytes));
        d_solid_vel_fsi_capacity = vel_bytes;
    }
    CHECK_CUDA(cudaMemsetAsync(d_solid_vel_fsi, 0, vel_bytes));

    int* d_active_nodes = mpm_solver->getDeviceActiveNodes();
    int num_active_nodes = mpm_solver->getNumActiveNodes();

    // Reset geometry tile mask so old solid cells from previous steps do not persist
    CHECK_CUDA(cudaMemsetAsync(d_geom, 0, total_tiles * sizeof(GeometryTile3D)));

    if (num_active_nodes > 0 && d_active_nodes) {
        int threads_active = 256;
        int blocks_active = (num_active_nodes + threads_active - 1) / threads_active;

        kernel_zero_fsi_grid_ext_forces<<<blocks_active, threads_active>>>(d_grid, d_active_nodes, num_active_nodes);
        CHECK_CUDA(cudaGetLastError());

        kernel_fsi_couple_active_gpu<RealType, IsMultiMaterial><<<blocks_active, threads_active>>>(
            (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (GeometryTile3D*)d_geom,
            d_grid,
            d_active_nodes,
            num_active_nodes,
            (SolidVelocityTile3D*)d_solid_vel_fsi,
            nx, ny, nz,
            ntx, nty,
            (float)cellSize, (float)cellSize, (float)cellSize,
            (float)xmin, (float)ymin, (float)zmin,
            mpm_solver->getNx(), mpm_solver->getNy(), mpm_solver->getNz(),
            mpm_solver->getDx(), mpm_solver->getDy(), mpm_solver->getDz(),
            mpm_solver->getXMin(), mpm_solver->getYMin(), mpm_solver->getZMin()
        );
        CHECK_CUDA(cudaGetLastError());

        if (has_prev_mask && d_states) {
            kernel_extrapolate_uncovered_cells_3d<RealType, IsMultiMaterial><<<grid, block>>>(
                (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
                (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
                (const GeometryTile3D*)d_geom,
                (const UncoveringMaskTile3D*)d_prev_mask,
                nx, ny, nz, ntx, nty, (RealType)gamma
            );
            CHECK_CUDA(cudaGetLastError());
        }

        int threads_mask = 256;
        int blocks_mask = (total_tiles + threads_mask - 1) / threads_mask;
        kernel_extract_uncovering_mask_3d<<<blocks_mask, threads_mask>>>(d_prev_mask, (const GeometryTile3D*)d_geom, total_tiles);
        CHECK_CUDA(cudaGetLastError());
        has_prev_mask = true;

        kernel_fsi_apply_penalty_active_gpu<RealType, IsMultiMaterial><<<blocks_active, threads_active>>>(
            (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
            d_grid,
            d_active_nodes,
            num_active_nodes,
            nx, ny, nz,
            ntx, nty,
            (float)mpm_dx, (float)mpm_dy, (float)mpm_dz,
            (float)gamma
        );
        CHECK_CUDA(cudaGetLastError());
    } else {
        int total_nodes = nx * ny * nz;
        int threads_all = 256;
        int blocks_all = (total_nodes + threads_all - 1) / threads_all;
        kernel_zero_all_fsi_grid_ext_forces<<<blocks_all, threads_all>>>(d_grid, total_nodes);
        CHECK_CUDA(cudaGetLastError());

        kernel_fsi_couple_gpu<RealType, IsMultiMaterial><<<grid, block>>>(
            (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (GeometryTile3D*)d_geom,
            d_grid,
            (SolidVelocityTile3D*)d_solid_vel_fsi,
            nx, ny, nz,
            ntx, nty,
            mpm_dx, mpm_dy, mpm_dz
        );
        CHECK_CUDA(cudaGetLastError());

        if (has_prev_mask && d_states) {
            kernel_extrapolate_uncovered_cells_3d<RealType, IsMultiMaterial><<<grid, block>>>(
                (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
                (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
                (const GeometryTile3D*)d_geom,
                (const UncoveringMaskTile3D*)d_prev_mask,
                nx, ny, nz, ntx, nty, (RealType)gamma
            );
            CHECK_CUDA(cudaGetLastError());
        }

        int threads_mask = 256;
        int blocks_mask = (total_tiles + threads_mask - 1) / threads_mask;
        kernel_extract_uncovering_mask_3d<<<blocks_mask, threads_mask>>>(d_prev_mask, (const GeometryTile3D*)d_geom, total_tiles);
        CHECK_CUDA(cudaGetLastError());
        has_prev_mask = true;

        kernel_fsi_apply_penalty_gpu<RealType, IsMultiMaterial><<<grid, block>>>(
            (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
            d_grid,
            nx, ny, nz,
            ntx, nty,
            (float)mpm_dx, (float)mpm_dy, (float)mpm_dz,
            (float)gamma
        );
        CHECK_CUDA(cudaGetLastError());
    }

    // Automatically cache FSI forces on the device so RK2 corrector step can restore them
    mpm_solver->storeFSIForces();

    // Mark active boundary tile proximity flags on GPU using 2-pass fast tile reduction
    int threads_tile = 256;
    int blocks_tile = (total_tiles + threads_tile - 1) / threads_tile;
    
    if (!d_tile_has_boundary_buf || d_tile_has_boundary_capacity < total_tiles * sizeof(uint8_t)) {
        if (d_tile_has_boundary_buf) cudaFree(d_tile_has_boundary_buf);
        CHECK_CUDA(cudaMalloc(&d_tile_has_boundary_buf, total_tiles * sizeof(uint8_t)));
        d_tile_has_boundary_capacity = total_tiles * sizeof(uint8_t);
    }

    kernel_mark_tile_has_boundary_3d<<<blocks_tile, threads_tile>>>(
        (const GeometryTile3D*)d_geom,
        (uint8_t*)d_tile_has_boundary_buf,
        total_tiles
    );
    CHECK_CUDA(cudaGetLastError());

    kernel_update_fsi_tile_boundary_flags<<<blocks_tile, threads_tile>>>(
        (const uint8_t*)d_tile_has_boundary_buf,
        (uint8_t*)d_tile_is_near_boundary,
        ntx, nty, ntz
    );
    CHECK_CUDA(cudaGetLastError());
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::coupleFSIWithFEMGPU(void* fem_solver_void) {
    ensure_paged_in();
    if (!fem_solver_void) return;

    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    dim3 block(8, 8, 4);
    dim3 grid((nx + 7) / 8, (ny + 7) / 8, (nz + 3) / 4);

    if (!d_geom) {
        CHECK_CUDA(cudaMalloc(&d_geom, total_tiles * sizeof(GeometryTile3D)));
        CHECK_CUDA(cudaMemset(d_geom, 0, total_tiles * sizeof(GeometryTile3D)));
    }
    if (!d_prev_mask) {
        CHECK_CUDA(cudaMalloc(&d_prev_mask, total_tiles * sizeof(UncoveringMaskTile3D)));
        CHECK_CUDA(cudaMemset(d_prev_mask, 0, total_tiles * sizeof(UncoveringMaskTile3D)));
    }
    if (!d_tile_is_near_boundary) {
        CHECK_CUDA(cudaMalloc(&d_tile_is_near_boundary, total_tiles * sizeof(uint8_t)));
        CHECK_CUDA(cudaMemset(d_tile_is_near_boundary, 1, total_tiles * sizeof(uint8_t)));
    }

    size_t vel_bytes = total_tiles * sizeof(SolidVelocityTile3D);
    if (!d_solid_vel_fsi || d_solid_vel_fsi_capacity < vel_bytes) {
        if (d_solid_vel_fsi) cudaFree(d_solid_vel_fsi);
        CHECK_CUDA(cudaMalloc(&d_solid_vel_fsi, vel_bytes));
        d_solid_vel_fsi_capacity = vel_bytes;
    }
    CHECK_CUDA(cudaMemsetAsync(d_solid_vel_fsi, 0, vel_bytes));

    CHECK_CUDA(cudaMemsetAsync(d_geom, 0, total_tiles * sizeof(GeometryTile3D)));

    if constexpr (std::is_same_v<RealType, double>) {
        Blast::FEMSolver3DCUDA<double>* fem_double = reinterpret_cast<Blast::FEMSolver3DCUDA<double>*>(fem_solver_void);
        int num_elements = static_cast<int>(fem_double->getElementCount());
        if (num_elements > 0) {
            Blast::launch_rasterize_fem_elements_to_geom_3d<double>(
                fem_double->getNodesDevice(),
                fem_double->getElementsDevice(),
                num_elements,
                (GeometryTile3D*)d_geom,
                (SolidVelocityTile3D*)d_solid_vel_fsi,
                nx, ny, nz,
                ntx, nty,
                static_cast<float>(cellSize), static_cast<float>(cellSize), static_cast<float>(cellSize),
                static_cast<float>(xmin), static_cast<float>(ymin), static_cast<float>(zmin)
            );
            CHECK_CUDA(cudaGetLastError());
        }

        int num_facets = static_cast<int>(fem_double->getSurfaceFacetCount());
        if (num_facets > 0) {
            Blast::launch_rasterize_fem_facets_to_geom_3d<double>(
                fem_double->getNodesDevice(),
                fem_double->getSurfaceFacetsDevice(),
                num_facets,
                (GeometryTile3D*)d_geom,
                (SolidVelocityTile3D*)d_solid_vel_fsi,
                nx, ny, nz,
                ntx, nty,
                static_cast<float>(cellSize), static_cast<float>(cellSize), static_cast<float>(cellSize),
                static_cast<float>(xmin), static_cast<float>(ymin), static_cast<float>(zmin)
            );
            CHECK_CUDA(cudaGetLastError());

            if (has_prev_mask && d_states) {
                double fmin_x = xmin, fmax_x = xmin + nx * cellSize;
                double fmin_y = ymin, fmax_y = ymin + ny * cellSize;
                double fmin_z = zmin, fmax_z = zmin + nz * cellSize;
                fem_double->getMeshBoundingBox(fmin_x, fmax_x, fmin_y, fmax_y, fmin_z, fmax_z);
                double margin = 6.0 * cellSize;
                int imin = std::clamp(static_cast<int>(std::floor((fmin_x - margin - xmin) / cellSize)), 0, nx - 1);
                int imax = std::clamp(static_cast<int>(std::ceil((fmax_x + margin - xmin) / cellSize)), 0, nx - 1);
                int jmin = std::clamp(static_cast<int>(std::floor((fmin_y - margin - ymin) / cellSize)), 0, ny - 1);
                int jmax = std::clamp(static_cast<int>(std::ceil((fmax_y + margin - ymin) / cellSize)), 0, ny - 1);
                int kmin = std::clamp(static_cast<int>(std::floor((fmin_z - margin - zmin) / cellSize)), 0, nz - 1);
                int kmax = std::clamp(static_cast<int>(std::ceil((fmax_z + margin - zmin) / cellSize)), 0, nz - 1);

                dim3 b_grid((imax - imin + 1 + 7) / 8, (jmax - jmin + 1 + 7) / 8, (kmax - kmin + 1 + 3) / 4);
                dim3 b_block(8, 8, 4);

                kernel_extrapolate_uncovered_cells_3d<RealType, IsMultiMaterial><<<b_grid, b_block>>>(
                    (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
                    (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
                    (const GeometryTile3D*)d_geom,
                    (const UncoveringMaskTile3D*)d_prev_mask,
                    nx, ny, nz, ntx, nty, (RealType)gamma,
                    imin, imax, jmin, jmax, kmin, kmax
                );
                CHECK_CUDA(cudaGetLastError());
            }

            int threads_mask = 256;
            int blocks_mask = (total_tiles + threads_mask - 1) / threads_mask;
            kernel_extract_uncovering_mask_3d<<<blocks_mask, threads_mask>>>(d_prev_mask, (const GeometryTile3D*)d_geom, total_tiles);
            CHECK_CUDA(cudaGetLastError());
            has_prev_mask = true;

            Blast::launch_integrate_cfd_pressure_to_fem_nodes_3d<double, RealType, IsMultiMaterial>(
                (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
                (const GeometryTile3D*)d_geom,
                fem_double->getNodesDevice(),
                fem_double->getSurfaceFacetsDevice(),
                num_facets,
                nx, ny, nz,
                ntx, nty,
                static_cast<float>(cellSize), static_cast<float>(cellSize), static_cast<float>(cellSize),
                static_cast<float>(xmin), static_cast<float>(ymin), static_cast<float>(zmin),
                static_cast<float>(this->ambient_p)
            );
            CHECK_CUDA(cudaGetLastError());
        }
    } else {
        Blast::FEMSolver3DCUDA<float>* fem_float = reinterpret_cast<Blast::FEMSolver3DCUDA<float>*>(fem_solver_void);
        int num_elements = static_cast<int>(fem_float->getElementCount());
        if (num_elements > 0) {
            Blast::launch_rasterize_fem_elements_to_geom_3d<float>(
                fem_float->getNodesDevice(),
                fem_float->getElementsDevice(),
                num_elements,
                (GeometryTile3D*)d_geom,
                (SolidVelocityTile3D*)d_solid_vel_fsi,
                nx, ny, nz,
                ntx, nty,
                static_cast<float>(cellSize), static_cast<float>(cellSize), static_cast<float>(cellSize),
                static_cast<float>(xmin), static_cast<float>(ymin), static_cast<float>(zmin)
            );
            CHECK_CUDA(cudaGetLastError());
        }

        int num_facets = static_cast<int>(fem_float->getSurfaceFacetCount());
        if (num_facets > 0) {
            Blast::launch_rasterize_fem_facets_to_geom_3d<float>(
                fem_float->getNodesDevice(),
                fem_float->getSurfaceFacetsDevice(),
                num_facets,
                (GeometryTile3D*)d_geom,
                (SolidVelocityTile3D*)d_solid_vel_fsi,
                nx, ny, nz,
                ntx, nty,
                static_cast<float>(cellSize), static_cast<float>(cellSize), static_cast<float>(cellSize),
                static_cast<float>(xmin), static_cast<float>(ymin), static_cast<float>(zmin)
            );
            CHECK_CUDA(cudaGetLastError());

            if (has_prev_mask && d_states) {
                float fmin_x = static_cast<float>(xmin), fmax_x = static_cast<float>(xmin + nx * cellSize);
                float fmin_y = static_cast<float>(ymin), fmax_y = static_cast<float>(ymin + ny * cellSize);
                float fmin_z = static_cast<float>(zmin), fmax_z = static_cast<float>(zmin + nz * cellSize);
                fem_float->getMeshBoundingBox(fmin_x, fmax_x, fmin_y, fmax_y, fmin_z, fmax_z);
                float margin = 6.0f * static_cast<float>(cellSize);
                int imin = std::clamp(static_cast<int>(std::floor((fmin_x - margin - static_cast<float>(xmin)) / static_cast<float>(cellSize))), 0, nx - 1);
                int imax = std::clamp(static_cast<int>(std::ceil((fmax_x + margin - static_cast<float>(xmin)) / static_cast<float>(cellSize))), 0, nx - 1);
                int jmin = std::clamp(static_cast<int>(std::floor((fmin_y - margin - static_cast<float>(ymin)) / static_cast<float>(cellSize))), 0, ny - 1);
                int jmax = std::clamp(static_cast<int>(std::ceil((fmax_y + margin - static_cast<float>(ymin)) / static_cast<float>(cellSize))), 0, ny - 1);
                int kmin = std::clamp(static_cast<int>(std::floor((fmin_z - margin - static_cast<float>(zmin)) / static_cast<float>(cellSize))), 0, nz - 1);
                int kmax = std::clamp(static_cast<int>(std::ceil((fmax_z + margin - static_cast<float>(zmin)) / static_cast<float>(cellSize))), 0, nz - 1);

                dim3 b_grid((imax - imin + 1 + 7) / 8, (jmax - jmin + 1 + 7) / 8, (kmax - kmin + 1 + 3) / 4);
                dim3 b_block(8, 8, 4);

                kernel_extrapolate_uncovered_cells_3d<RealType, IsMultiMaterial><<<b_grid, b_block>>>(
                    (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
                    (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
                    (const GeometryTile3D*)d_geom,
                    (const UncoveringMaskTile3D*)d_prev_mask,
                    nx, ny, nz, ntx, nty, (RealType)gamma,
                    imin, imax, jmin, jmax, kmin, kmax
                );
                CHECK_CUDA(cudaGetLastError());
            }

            int threads_mask = 256;
            int blocks_mask = (total_tiles + threads_mask - 1) / threads_mask;
            kernel_extract_uncovering_mask_3d<<<blocks_mask, threads_mask>>>(d_prev_mask, (const GeometryTile3D*)d_geom, total_tiles);
            CHECK_CUDA(cudaGetLastError());
            has_prev_mask = true;

            Blast::launch_integrate_cfd_pressure_to_fem_nodes_3d<float, RealType, IsMultiMaterial>(
                (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
                (const GeometryTile3D*)d_geom,
                fem_float->getNodesDevice(),
                fem_float->getSurfaceFacetsDevice(),
                num_facets,
                nx, ny, nz,
                ntx, nty,
                static_cast<float>(cellSize), static_cast<float>(cellSize), static_cast<float>(cellSize),
                static_cast<float>(xmin), static_cast<float>(ymin), static_cast<float>(zmin),
                static_cast<float>(this->ambient_p)
            );
        }
    }

    // Couple MPM debris particles with CFD grid as well (solid obstacle rasterization + FSI forces)
    Blast::MPMSolver3DCUDA* mpm_cuda = nullptr;
    if constexpr (std::is_same_v<RealType, double>) {
        Blast::FEMSolver3DCUDA<double>* fem_double = reinterpret_cast<Blast::FEMSolver3DCUDA<double>*>(fem_solver_void);
        mpm_cuda = fem_double->getCUDAMPMSolver();
    } else {
        Blast::FEMSolver3DCUDA<float>* fem_float = reinterpret_cast<Blast::FEMSolver3DCUDA<float>*>(fem_solver_void);
        mpm_cuda = fem_float->getCUDAMPMSolver();
    }

    if (mpm_cuda && mpm_cuda->getParticleCount() > 0) {
        Blast::MPMGridNode3D* d_grid = mpm_cuda->getDeviceGrid();
        int* d_active_nodes = mpm_cuda->getDeviceActiveNodes();
        int num_active_nodes = mpm_cuda->getNumActiveNodes();
        if (d_grid && num_active_nodes > 0 && d_active_nodes) {
            int threads_active = 256;
            int blocks_active = (num_active_nodes + threads_active - 1) / threads_active;

            kernel_zero_fsi_grid_ext_forces<<<blocks_active, threads_active>>>(d_grid, d_active_nodes, num_active_nodes);
            CHECK_CUDA(cudaGetLastError());

            kernel_fsi_couple_active_gpu<RealType, IsMultiMaterial><<<blocks_active, threads_active>>>(
                (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
                (GeometryTile3D*)d_geom,
                d_grid,
                d_active_nodes,
                num_active_nodes,
                (SolidVelocityTile3D*)d_solid_vel_fsi,
                nx, ny, nz,
                ntx, nty,
                (float)cellSize, (float)cellSize, (float)cellSize,
                (float)xmin, (float)ymin, (float)zmin,
                mpm_cuda->getNx(), mpm_cuda->getNy(), mpm_cuda->getNz(),
                mpm_cuda->getDx(), mpm_cuda->getDy(), mpm_cuda->getDz(),
                mpm_cuda->getXMin(), mpm_cuda->getYMin(), mpm_cuda->getZMin()
            );
            CHECK_CUDA(cudaGetLastError());
            mpm_cuda->storeFSIForces();
        }
    }

    int threads_tile = 256;
    int blocks_tile = (total_tiles + threads_tile - 1) / threads_tile;

    if (!d_tile_has_boundary_buf || d_tile_has_boundary_capacity < total_tiles * sizeof(uint8_t)) {
        if (d_tile_has_boundary_buf) cudaFree(d_tile_has_boundary_buf);
        CHECK_CUDA(cudaMalloc(&d_tile_has_boundary_buf, total_tiles * sizeof(uint8_t)));
        d_tile_has_boundary_capacity = total_tiles * sizeof(uint8_t);
    }

    kernel_mark_tile_has_boundary_3d<<<blocks_tile, threads_tile>>>(
        (const GeometryTile3D*)d_geom,
        (uint8_t*)d_tile_has_boundary_buf,
        total_tiles
    );
    CHECK_CUDA(cudaGetLastError());

    kernel_update_fsi_tile_boundary_flags<<<blocks_tile, threads_tile>>>(
        (const uint8_t*)d_tile_has_boundary_buf,
        (uint8_t*)d_tile_is_near_boundary,
        ntx, nty, ntz
    );
    CHECK_CUDA(cudaGetLastError());
    last_cached_tile_idx = -1;
}
