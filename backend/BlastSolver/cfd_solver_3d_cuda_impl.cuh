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
extern void remap_3d_to_3d(const CFDBulkSnapshot3D& src, CFDSolver3D& solver_3d,
    double x_expl, double y_expl, double z_expl, double R_remap,
    double src_x_expl, double src_y_expl, double src_z_expl);
#include <device_launch_parameters.h>
#include <string>
#include <stdexcept>
#include "services/ErrorDiagnostics.hpp"

#define CHECK_CUDA(call) { \
    cudaError_t err = call; \
    if (err != cudaSuccess) { \
        std::string phase = BlastDiagnostics::get_kernel_phase(); \
        std::string err_msg = std::string("CUDA Error: ") + cudaGetErrorString(err) + " at " + __FILE__ + ":" + std::to_string(__LINE__); \
        if (!phase.empty()) err_msg += " [phase: " + phase + "]"; \
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
static __constant__ int d_fluxScheme;
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
static __constant__ double d_detStartTime;
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
static __constant__ Blast::ZonalHandoff3DParams d_zonalParams;

__device__ __forceinline__ int load_const_i32(const int* ptr) {
    int val;
    size_t c_addr = __cvta_generic_to_constant(ptr);
    asm volatile("ld.const.s32 %0, [%1];" : "=r"(val) : "l"(c_addr));
    return val;
}

__device__ __forceinline__ unsigned long long load_const_u64(const unsigned long long* ptr) {
    unsigned long long val;
    size_t c_addr = __cvta_generic_to_constant(ptr);
    asm volatile("ld.const.u64 %0, [%1];" : "=l"(val) : "l"(c_addr));
    return val;
}

template <typename T1, typename T2 = T1, typename T3 = T1>
__device__ inline bool is_cell_water(T1 rho, T2 z_c = static_cast<T2>(0.0), T3 alpha_he = static_cast<T3>(0.0)) {
    if (alpha_he > static_cast<T3>(0.05) || rho < static_cast<T1>(300.0)) {
        return false;
    }
    if (d_stratParams.enabled) {
        if (z_c > static_cast<T2>(0.0) && z_c <= static_cast<T2>(d_stratParams.seabed_surface_z) && rho > static_cast<T1>(500.0)) {
            return false; // Below mudline is seabed geotechnical foundation / sediment
        }
        if (z_c > static_cast<T2>(0.0) && z_c <= static_cast<T2>(d_stratParams.water_surface_z)) {
            return true;
        }
        return (rho >= static_cast<T1>(300.0)); // Plume / splash liquid water above water surface
    }
    if (d_isWater) {
        return true;
    }
    return false;
}

template <typename T1, typename T2 = T1, typename T3 = T1>
__device__ inline bool is_cell_soil(T1 rho, T2 z_c = static_cast<T2>(0.0), T3 alpha_he = static_cast<T3>(0.0)) {
    if (alpha_he > static_cast<T3>(0.5)) {
        return false;
    }
    if (d_stratParams.enabled) {
        if (z_c > static_cast<T2>(0.0) && z_c <= static_cast<T2>(d_stratParams.seabed_surface_z) && rho > static_cast<T1>(500.0)) {
            return true;
        }
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
        if (is_cell_water(s.rho[c_idx], z_c, s.alpha1[c_idx] + s.alpha2[c_idx])) {
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
    RealType c_res = (RealType)1482.0;
    if (is_cell_soil(s.rho, z_c)) {
        RealType gamma_soil = (RealType)(d_stratParams.soil_gamma > 0.0 ? d_stratParams.soil_gamma : 4.0);
        RealType rho0_soil = (RealType)(d_stratParams.soil_density > 0.0 ? d_stratParams.soil_density : 2000.0);
        RealType c0_soil = (RealType)(d_stratParams.soil_c0 > 0.0 ? d_stratParams.soil_c0 : 2500.0);
        RealType B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
        if (d_stratParams.soil_eos_variant == 1) { // Caloric Gruneisen
            RealType gruneisen_soil = (RealType)(d_stratParams.soil_gruneisen > 0.0 ? d_stratParams.soil_gruneisen : 1.45);
            RealType e_spec = s.E / fmax((RealType)1e-6, s.rho);
            c_res = (RealType)Blast::TaitEOSWater::compute_sound_speed_caloric(
                (double)s.rho, (double)s.p, (double)e_spec, (double)B_soil, (double)gamma_soil, (double)rho0_soil, (double)gruneisen_soil
            );
        } else if (d_stratParams.soil_eos_variant == 2) { // Shock Hugoniot
            RealType s_soil = (RealType)(d_stratParams.soil_s > 0.0 ? d_stratParams.soil_s : 1.35);
            RealType gruneisen_soil = (RealType)(d_stratParams.soil_gruneisen > 0.0 ? d_stratParams.soil_gruneisen : 1.45);
            c_res = (RealType)Blast::TaitEOSWater::compute_sound_speed_hugoniot(
                (double)s.rho, (double)s.p, (double)c0_soil, (double)s_soil, (double)rho0_soil, (double)gruneisen_soil
            );
        } else {
            c_res = (RealType)Blast::TaitEOSWater::compute_sound_speed_isentropic((double)s.rho, (double)B_soil, (double)gamma_soil, (double)rho0_soil);
        }
    } else {
        bool is_water = false;
        if constexpr (IsMultiMaterial) is_water = is_cell_water(s.rho, z_c, s.alpha1 + s.alpha2);
        else is_water = is_cell_water(s.rho, z_c);
        if constexpr (IsMultiMaterial) {
            if (is_water) {
                c_res = MultiMat::getMixtureSoundSpeedTait<RealType>(
                    s.p, s.rho, s.alpha1, s.alpha2, s.arho1, s.arho2,
                    d_taitParams, d_products, d_unreacted
                );
            } else {
                c_res = MultiMat::getMixtureSoundSpeed<RealType>(
                    s.p, s.rho, s.alpha1, s.alpha2, s.arho1, s.arho2,
                    gamma, d_products, d_unreacted
                );
            }
        } else {
            if (is_water) {
                c_res = Blast::TaitEOSWater::compute_sound_speed_dispatcher(s.rho, s.p, d_taitParams);
            } else {
                c_res = sqrt(gamma * s.p / fmax((RealType)1e-6, s.rho));
            }
        }
    }
    if (isnan(c_res) || isinf(c_res)) c_res = (RealType)1482.0;
    return fmin((RealType)50000.0, fmax((RealType)10.0, c_res));
}

static __device__ inline bool is_solid_cell_gpu(const GeometryTile3D* geom, int i, int j, int k) {
    if (!geom) return false;
    int max_nx = load_const_i32(&d_nx);
    int max_ny = load_const_i32(&d_ny);
    int max_nz = load_const_i32(&d_nz);
    int ntx_v = load_const_i32(&d_ntx);
    int nty_v = load_const_i32(&d_nty);
    int ntz_v = load_const_i32(&d_ntz);
    if (max_nx <= 0 || max_ny <= 0 || max_nz <= 0 || ntx_v <= 0 || nty_v <= 0 || ntz_v <= 0) return false;
    int clamped_i = i < 0 ? 0 : (i >= max_nx ? max_nx - 1 : i);
    int clamped_j = j < 0 ? 0 : (j >= max_ny ? max_ny - 1 : j);
    int clamped_k = k < 0 ? 0 : (k >= max_nz ? max_nz - 1 : k);
    int tx = clamped_i >> 3;
    int ty = clamped_j >> 3;
    int tz = clamped_k >> 3;
    int t_idx = tx + ty * ntx_v + tz * ntx_v * nty_v;
    if (t_idx < 0 || t_idx >= ntx_v * nty_v * ntz_v) return false;
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
    const int nx_v = load_const_i32(&d_nx);
    const int ny_v = load_const_i32(&d_ny);
    const int nz_v = load_const_i32(&d_nz);
    const int ntx_v = load_const_i32(&d_ntx);
    const int nty_v = load_const_i32(&d_nty);
    const int ntz_v = load_const_i32(&d_ntz);
    int clamped_gx = gx < 0 ? 0 : (gx >= nx_v ? nx_v - 1 : gx);
    int clamped_gy = gy < 0 ? 0 : (gy >= ny_v ? ny_v - 1 : gy);
    int clamped_gz = gz < 0 ? 0 : (gz >= nz_v ? nz_v - 1 : gz);
    int tx = clamped_gx >> 3;
    int ty = clamped_gy >> 3;
    int tz = clamped_gz >> 3;
    int t_idx = tx + ty * ntx_v + tz * ntx_v * nty_v;
    int max_tiles = ntx_v * nty_v * ntz_v;
    if (t_idx < 0 || t_idx >= max_tiles) t_idx = 0;

    int lx = clamped_gx & 7;
    int ly = clamped_gy & 7;
    int lz = clamped_gz & 7;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    GPUCellStateT<RealType, IsMultiMaterial> s;
    if constexpr (std::is_same_v<TileType, PrimitiveTile3D<RealType, IsMultiMaterial>>) {
        const auto* active_tiles = (const uint8_t*)load_const_u64(&d_active_tiles_global);
        const auto* states_orig = (const PrimitiveTile3D<RealType, IsMultiMaterial>*)load_const_u64(&d_states_orig_global);
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
__device__ inline GPUCellStateT<RealType, IsMultiMaterial> sample_gpu_raw_oob_slow(const TileType* states, int gx, int gy, int gz) {
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
    int max_tiles = d_ntx * d_nty * d_ntz;
    if (t_idx < 0 || t_idx >= max_tiles) t_idx = 0;

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

    // Bottom floor hydrostatic well-balancing under gravity (non-Riemann boundaries)
    if (orig_gz < 0 && d_stratParams.enabled && d_bcZmin != 2 && d_bcZmin != 3) {
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

    // Top boundary hydrostatic pressure profile under gravity (non-Riemann boundaries)
    if (orig_gz >= d_nz && d_stratParams.enabled && d_bcZmax != 2 && d_bcZmax != 3) {
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
        } else if (d_isWater || (d_stratParams.enabled && is_cell_water(s.rho, z_c))) {
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

    // Non-reflecting characteristic Riemann boundary condition (OUTFLOW_RIEMANN / TERMINATE)
    bool is_riemann = (orig_gx < 0 && (d_bcXmin == 2 || d_bcXmin == 3)) ||
                      (orig_gx >= d_nx && (d_bcXmax == 2 || d_bcXmax == 3)) ||
                      (orig_gy < 0 && (d_bcYmin == 2 || d_bcYmin == 3)) ||
                      (orig_gy >= d_ny && (d_bcYmax == 2 || d_bcYmax == 3)) ||
                      (orig_gz < 0 && (d_bcZmin == 2 || d_bcZmin == 3)) ||
                      (orig_gz >= d_nz && (d_bcZmax == 2 || d_bcZmax == 3));

    if (is_riemann) {
        RealType nx_out = (RealType)0.0, ny_out = (RealType)0.0, nz_out = (RealType)0.0;
        if (orig_gx < 0 && (d_bcXmin == 2 || d_bcXmin == 3)) nx_out = (RealType)-1.0;
        else if (orig_gx >= d_nx && (d_bcXmax == 2 || d_bcXmax == 3)) nx_out = (RealType)1.0;
        else if (orig_gy < 0 && (d_bcYmin == 2 || d_bcYmin == 3)) ny_out = (RealType)-1.0;
        else if (orig_gy >= d_ny && (d_bcYmax == 2 || d_bcYmax == 3)) ny_out = (RealType)1.0;
        else if (orig_gz < 0 && (d_bcZmin == 2 || d_bcZmin == 3)) nz_out = (RealType)-1.0;
        else if (orig_gz >= d_nz && (d_bcZmax == 2 || d_bcZmax == 3)) nz_out = (RealType)1.0;

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

            RealType rho_int_hydro = rho_target;
            bool is_w_int = false, is_s_int = false;
            eval_hydro(z_int, p_hydro_int, rho_int_hydro, is_w_int, is_s_int);
            eval_hydro(z_c, p_target, rho_target, is_water_target, is_soil_target);
            if (is_w_int) {
                is_water_target = true;
                is_soil_target = false;
                if (z_c > (RealType)d_stratParams.water_surface_z) {
                    p_target = (RealType)d_stratParams.p_atm;
                    rho_target = (RealType)d_stratParams.tait_rho0;
                }
            } else if (is_s_int) {
                is_soil_target = true;
                is_water_target = false;
            }
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
            if (un_int >= c_soil) {
                un_ghost = un_int;
                p_ghost = s.p;
            } else {
                // Non-reflecting characteristic Riemann impedance condition
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
        } else if (is_water_target || (!d_stratParams.enabled && d_isWater)) {
            RealType c_w = (RealType)Blast::TaitEOSWater::compute_sound_speed_dispatcher(
                (double)s.rho, (double)s.p, d_taitParams, 0.0);
            RealType Z = s.rho * c_w;
            if (Z < (RealType)1.0e-3) Z = (RealType)(1.0e3 * 1482.0);

            RealType p_pert_int = s.p - p_hydro_int;
            RealType un_ghost;
            RealType p_ghost;
            if (un_int >= c_w) {
                un_ghost = un_int;
                p_ghost = s.p;
            } else {
                // Non-reflecting characteristic Riemann impedance condition
                un_ghost = (RealType)0.5 * (un_int + p_pert_int / Z);
                p_ghost = p_target + (RealType)0.5 * (p_pert_int + Z * un_int);
                if (p_ghost < (RealType)d_taitParams.p_cav) p_ghost = (RealType)d_taitParams.p_cav;
            }

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

            if (un_int >= c_int) {
                // Supersonic gas outflow: strictly transmissive
                RealType ke_r = (RealType)0.5 * s.rho * (s.ux * s.ux + s.uy * s.uy + s.uz * s.uz);
                s.E = s.p / gm1 + ke_r;
            } else if (un_int > (RealType)0.0) {
                // Subsonic gas outflow:
                RealType un_ghost = un_int + (s.p - p_target) / fmax((RealType)1e-6, s.rho * c_int);
                RealType p_ghost = p_target;
                RealType rho_ghost = rho_target;

                s.ux += (un_ghost - un_int) * nx_out;
                s.uy += (un_ghost - un_int) * ny_out;
                s.uz += (un_ghost - un_int) * nz_out;
                s.p = p_ghost;
                s.rho = rho_ghost;

                RealType ke_r = (RealType)0.5 * s.rho * (s.ux * s.ux + s.uy * s.uy + s.uz * s.uz);
                s.E = p_ghost / gm1 + ke_r;
            } else {
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
    }
    return s;
}

template <typename RealType, bool IsMultiMaterial, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ __forceinline__ GPUCellStateT<RealType, IsMultiMaterial> sample_gpu_raw(const TileType* states, int gx, int gy, int gz) {
    const int nx_v = load_const_i32(&d_nx);
    const int ny_v = load_const_i32(&d_ny);
    const int nz_v = load_const_i32(&d_nz);
    if ((unsigned)gx >= (unsigned)nx_v || (unsigned)gy >= (unsigned)ny_v || (unsigned)gz >= (unsigned)nz_v) {
        return sample_gpu_raw_oob_slow<RealType, IsMultiMaterial, TileType>(states, gx, gy, gz);
    }
    const int ntx_v = load_const_i32(&d_ntx);
    const int nty_v = load_const_i32(&d_nty);
    int t_idx = (gx >> 3) + (gy >> 3) * ntx_v + (gz >> 3) * ntx_v * nty_v;
    int c_idx = (gx & 7) + (gy & 7) * TILE_SIZE_3D + (gz & 7) * TILE_SIZE_3D * TILE_SIZE_3D;

    GPUCellStateT<RealType, IsMultiMaterial> s;
    if constexpr (std::is_same_v<TileType, PrimitiveTile3D<RealType, IsMultiMaterial>>) {
        const auto* active_tiles = (const uint8_t*)load_const_u64(&d_active_tiles_global);
        const auto* states_orig = (const PrimitiveTile3D<RealType, IsMultiMaterial>*)load_const_u64(&d_states_orig_global);
        const auto& tile = (active_tiles && states_orig && active_tiles[t_idx] == 0) ? states_orig[t_idx] : states[t_idx];
        s.rho = __ldg(&tile.rho[c_idx]);
        s.ux  = __ldg(&tile.ux[c_idx]);
        s.uy  = __ldg(&tile.uy[c_idx]);
        s.uz  = __ldg(&tile.uz[c_idx]);
        s.p   = __ldg(&tile.p[c_idx]);
        s.E   = (RealType)0.0;
        s.peak_overpressure = __ldg(&tile.peak_overpressure[c_idx]);
        s.peak_impulse      = __ldg(&tile.peak_impulse[c_idx]);
        if constexpr (IsMultiMaterial) {
            s.alpha1 = __ldg(&tile.alpha1[c_idx]);
            s.alpha2 = __ldg(&tile.alpha2[c_idx]);
            s.arho1  = __ldg(&tile.arho1[c_idx]);
            s.arho2  = __ldg(&tile.arho2[c_idx]);
        }
    } else {
        const auto& tile = states[t_idx];
        s.rho = __ldg(&tile.rho[c_idx]);
        s.ux  = __ldg(&tile.ux[c_idx]);
        s.uy  = __ldg(&tile.uy[c_idx]);
        s.uz  = __ldg(&tile.uz[c_idx]);
        s.p   = __ldg(&tile.p[c_idx]);
        s.E   = (RealType)0.0;
        s.peak_overpressure = (RealType)0.0;
        s.peak_impulse      = (RealType)0.0;
        if constexpr (IsMultiMaterial) {
            s.alpha1 = __ldg(&tile.alpha1[c_idx]);
            s.alpha2 = __ldg(&tile.alpha2[c_idx]);
            s.arho1  = __ldg(&tile.arho1[c_idx]);
            s.arho2  = __ldg(&tile.arho2[c_idx]);
        }
    }
    return s;
}


static __device__ inline bool get_solid_normal_gpu(const GeometryTile3D* geom, int i, int j, int k, float& nx_b, float& ny_b, float& nz_b) {
    if (!geom) return false;
    const int nx_v = load_const_i32(&d_nx);
    const int ny_v = load_const_i32(&d_ny);
    const int nz_v = load_const_i32(&d_nz);
    const int ntx_v = load_const_i32(&d_ntx);
    const int nty_v = load_const_i32(&d_nty);
    const int ntz_v = load_const_i32(&d_ntz);
    if (nx_v <= 0 || ny_v <= 0 || nz_v <= 0 || ntx_v <= 0 || nty_v <= 0 || ntz_v <= 0) return false;
    int ci = i < 0 ? 0 : (i >= nx_v ? nx_v - 1 : i);
    int cj = j < 0 ? 0 : (j >= ny_v ? ny_v - 1 : j);
    int ck = k < 0 ? 0 : (k >= nz_v ? nz_v - 1 : k);
    int tx = ci >> 3;
    int ty = cj >> 3;
    int tz = ck >> 3;
    int t_idx = tx + ty * ntx_v + tz * ntx_v * nty_v;
    if (t_idx < 0 || t_idx >= ntx_v * nty_v * ntz_v) return false;
    int lx = ci & 7;
    int ly = cj & 7;
    int lz = ck & 7;
    int c_idx = lx + ly * 8 + lz * 64;
    bool is_b = false;
    unpack_geometry_payload(geom[t_idx].cells[c_idx], is_b, nx_b, ny_b, nz_b);
    return is_b;
}

constexpr float FSI_ALPHA_DEAD = 1.0e-3f;
constexpr float FSI_ALPHA_CUT  = 0.50f;
constexpr float FSI_DILUTE_MAX_ALPHA = 0.25f;

template <typename RealType>
__device__ inline RealType get_alpha_f_gpu(
    const FluidFractionTile3D<RealType>* ff,
    const GeometryTile3D* geom,
    int i, int j, int k
) {
    const int nx_v = load_const_i32(&d_nx);
    const int ny_v = load_const_i32(&d_ny);
    const int nz_v = load_const_i32(&d_nz);
    const int ntx_v = load_const_i32(&d_ntx);
    const int nty_v = load_const_i32(&d_nty);
    if (nx_v <= 0 || ny_v <= 0 || nz_v <= 0 || ntx_v <= 0 || nty_v <= 0) return (RealType)1.0;
    if (i < 0 || i >= nx_v || j < 0 || j >= ny_v || k < 0 || k >= nz_v) return (RealType)1.0;
    const int t_idx = (i >> 3) + (j >> 3) * ntx_v + (k >> 3) * ntx_v * nty_v;
    const int c_idx = (i & 7) + (j & 7) * 8 + (k & 7) * 64;
    if (ff) {
        RealType a = ff[t_idx].alpha_f[c_idx];
        return (a <= (RealType)FSI_ALPHA_DEAD) ? (RealType)0.0 : fmin((RealType)1.0, a);
    }
    return (geom && geom[t_idx].cells[c_idx].is_boundary) ? (RealType)0.0 : (RealType)1.0;
}

template <typename RealType, bool IsMultiMaterial, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ inline RealType get_solid_vel_comp_gpu(
    const SolidVelocityTile3D* sv,
    const TileType* states,
    int i, int j, int k, int dir
) {
    const int nx_v = load_const_i32(&d_nx);
    const int ny_v = load_const_i32(&d_ny);
    const int nz_v = load_const_i32(&d_nz);
    const int ntx_v = load_const_i32(&d_ntx);
    const int nty_v = load_const_i32(&d_nty);
    if (nx_v <= 0 || ny_v <= 0 || nz_v <= 0 || ntx_v <= 0 || nty_v <= 0) return (RealType)0.0;
    int ci = i < 0 ? 0 : (i >= nx_v ? nx_v - 1 : i);
    int cj = j < 0 ? 0 : (j >= ny_v ? ny_v - 1 : j);
    int ck = k < 0 ? 0 : (k >= nz_v ? nz_v - 1 : k);
    int t_idx = (ci >> 3) + (cj >> 3) * ntx_v + (ck >> 3) * ntx_v * nty_v;
    int c_idx = (ci & 7) + (cj & 7) * 8 + (ck & 7) * 64;
    if (sv) {
        return (dir == 0) ? (RealType)sv[t_idx].vx[c_idx]
             : ((dir == 1) ? (RealType)sv[t_idx].vy[c_idx] : (RealType)sv[t_idx].vz[c_idx]);
    }
    if (!states) return (RealType)0.0;
    return (dir == 0) ? states[t_idx].ux[c_idx]
         : ((dir == 1) ? states[t_idx].uy[c_idx] : states[t_idx].uz[c_idx]);
}

template <typename RealType, bool IsMultiMaterial>
__device__ inline RealType compute_fsi_wall_pressure_gpu(
    const GPUCellStateT<RealType, IsMultiMaterial>& s_f,
    RealType vn_fluid,
    RealType vn_wall,
    RealType n_out, // +1 if solid is +dir from fluid, -1 if solid is -dir from fluid
    RealType z_c
) {
    RealType v_rel = n_out * (vn_fluid - vn_wall);
    RealType rho_f = fmax((RealType)1e-6, s_f.rho);
    RealType p_f = fmax((RealType)1.0, s_f.p);
    RealType g_eff = (RealType)d_gamma;
    RealType c_f = computeCellSoundSpeedGPU<RealType, IsMultiMaterial>(s_f, z_c, g_eff);
    if constexpr (IsMultiMaterial) {
        if (d_isWater || is_cell_water(rho_f, z_c, s_f.alpha1 + s_f.alpha2)) {
            g_eff = fmax((RealType)1.4, (RealType)d_taitParams.gamma);
        }
    } else if (d_isWater || is_cell_water(rho_f, z_c)) {
        g_eff = fmax((RealType)1.4, (RealType)d_taitParams.gamma);
    }
    if (v_rel >= (RealType)0.0) {
        RealType b_sh = (RealType)0.25 * (g_eff + (RealType)1.0) * v_rel;
        RealType w_s = b_sh + sqrt(b_sh * b_sh + c_f * c_f);
        return s_f.p + rho_f * w_s * v_rel;
    }
    RealType ratio = (RealType)1.0 + (RealType)0.5 * (g_eff - (RealType)1.0) * (v_rel / fmax((RealType)10.0, c_f));
    if (ratio <= (RealType)0.0) return (RealType)0.0;
    RealType expo = ((RealType)2.0 * g_eff) / fmax((RealType)0.05, g_eff - (RealType)1.0);
    return fmax((RealType)0.0, s_f.p * pow(ratio, expo));
}

template <typename RealType, bool IsMultiMaterial>
__device__ inline RealType compute_fsi_wall_pressure_normal_gpu(
    const GPUCellStateT<RealType, IsMultiMaterial>& s_f,
    RealType vw_x, RealType vw_y, RealType vw_z,
    const GeometryTile3D* geom_pool,
    int ox, int oy, int oz,
    int dir,
    RealType n_out, // +1 if solid is +dir from fluid, -1 if solid is -dir from fluid
    RealType z_c
) {
    RealType ns_x = (RealType)0.0, ns_y = (RealType)0.0, ns_z = (RealType)0.0;
    if (geom_pool) {
        int ot = (ox >> 3) + (oy >> 3) * d_ntx + (oz >> 3) * d_ntx * d_nty;
        int oc = (ox & 7) + (oy & 7) * 8 + (oz & 7) * 64;
        GeometryPayload gp = geom_pool[ot].cells[oc];
        ns_x = static_cast<RealType>(gp.nx);
        ns_y = static_cast<RealType>(gp.ny);
        ns_z = static_cast<RealType>(gp.nz);
    }
    RealType ns_len = sqrt(ns_x * ns_x + ns_y * ns_y + ns_z * ns_z);
    RealType v_rel;
    if (ns_len > (RealType)1.0) {
        RealType inv_l = (RealType)1.0 / ns_len;
        ns_x *= inv_l; ns_y *= inv_l; ns_z *= inv_l;
        RealType ns_face = (dir == 0) ? (ns_x * (-n_out)) : ((dir == 1) ? (ns_y * (-n_out)) : (ns_z * (-n_out)));
        if (ns_face > (RealType)0.0) {
            v_rel = (vw_x - s_f.ux) * ns_x + (vw_y - s_f.uy) * ns_y + (vw_z - s_f.uz) * ns_z;
        } else {
            RealType vn_f = (dir == 0) ? s_f.ux : ((dir == 1) ? s_f.uy : s_f.uz);
            RealType vn_w = (dir == 0) ? vw_x : ((dir == 1) ? vw_y : vw_z);
            v_rel = n_out * (vn_f - vn_w);
        }
    } else {
        RealType vn_f = (dir == 0) ? s_f.ux : ((dir == 1) ? s_f.uy : s_f.uz);
        RealType vn_w = (dir == 0) ? vw_x : ((dir == 1) ? vw_y : vw_z);
        v_rel = n_out * (vn_f - vn_w);
    }

    return compute_fsi_wall_pressure_gpu<RealType, IsMultiMaterial>(s_f, v_rel, (RealType)0.0, (RealType)1.0, z_c);
}

template <typename RealType, bool IsMultiMaterial>
__device__ inline void getRusanovFluxGPU(const GPUCellStateT<RealType, IsMultiMaterial>& sL, const GPUCellStateT<RealType, IsMultiMaterial>& sR, RealType* flux, int dir, RealType gamma, RealType z_cL = (RealType)0.0, RealType z_cR = (RealType)0.0) {
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
__device__ inline void getAUSMPlusFluxGPU(const GPUCellStateT<RealType, IsMultiMaterial>& sL, const GPUCellStateT<RealType, IsMultiMaterial>& sR, RealType* flux, int dir, RealType gamma, RealType z_cL = (RealType)0.0, RealType z_cR = (RealType)0.0) {
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
    RealType Mo_sq = fmin((RealType)1.0, fmax(M_bar_sq, (RealType)1.0e-6));
    RealType Mo = sqrt(Mo_sq);
    RealType fa_Mo = Mo * ((RealType)2.0 - Mo);
    RealType fa = (M_bar_sq < (RealType)1.0) ? ((RealType)1.0 - M_bar_sq) : (RealType)0.0;
    RealType rho_half = (RealType)0.5 * (sL.rho + sR.rho);

    // In spatial reconstruction (Order >= 2), sL and sR are reconstructed to the cell face.
    // In hydrostatic equilibrium, sL.p == sR.p == p_face, so sR.p - sL.p == 0.
    RealType dp_wave = sR.p - sL.p;
    if (dir == 2 && d_has_gravity && (sL.rho > (RealType)300.0 && sR.rho > (RealType)300.0)) {
        RealType dp_hydro = rho_half * (RealType)d_gravity_z * (RealType)d_cellSize;
        if (fabs(dp_wave - dp_hydro) < fabs(dp_wave)) {
            dp_wave -= dp_hydro;
        }
    }

    RealType p_scale = d_isWater ? (RealType)fmax((RealType)1e5, (RealType)d_taitParams.B) : (d_stratParams.enabled ? (RealType)3.0e8 : fmin(sL.p, sR.p));
    RealType dp_rel = (p_scale > (RealType)1e-6) ? (fabs(dp_wave) / p_scale) : (RealType)0.0;
    RealType shock_sense = (dp_rel > (RealType)0.2) ? ((RealType)1.0 / ((RealType)1.0 + dp_rel * dp_rel)) : (RealType)1.0;
    RealType Kp = (RealType)0.25 * fa * shock_sense;
    RealType Ku = (RealType)0.75 * fa_Mo * shock_sense;
    
    RealType M_half = M_half_unmod - Kp * dp_wave / max((RealType)1e-6, rho_half * a_half * a_half);
    RealType p_half = p_half_unmod - Ku * P_plus_L * P_minus_R * rho_half * a_half * (uR - uL);
    p_half = fmax((RealType)0.0, p_half);

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
__device__ inline void getHLLCFluxGPU(const GPUCellStateT<RealType, IsMultiMaterial>& sL, const GPUCellStateT<RealType, IsMultiMaterial>& sR, RealType* flux, int dir, RealType gamma, RealType z_cL = (RealType)0.0, RealType z_cR = (RealType)0.0) {
    RealType aL = computeCellSoundSpeedGPU<RealType, IsMultiMaterial>(sL, z_cL, gamma);
    RealType aR = computeCellSoundSpeedGPU<RealType, IsMultiMaterial>(sR, z_cR, gamma);
    RealType uL = (dir == 0) ? sL.ux : (dir == 1 ? sL.uy : sL.uz);
    RealType uR = (dir == 0) ? sR.ux : (dir == 1 ? sR.uy : sR.uz);

    RealType SL, SR;
    if (!IsMultiMaterial && !d_isWater && !d_stratParams.enabled) {
        RealType srL = sqrt(fmax((RealType)1e-12, sL.rho));
        RealType srR = sqrt(fmax((RealType)1e-12, sR.rho));
        RealType inv_sr = (RealType)1.0 / (srL + srR);
        RealType HL = (sL.E + sL.p) / fmax((RealType)1e-12, sL.rho);
        RealType HR = (sR.E + sR.p) / fmax((RealType)1e-12, sR.rho);
        RealType H_roe = (srL * HL + srR * HR) * inv_sr;
        RealType ux_roe = (srL * sL.ux + srR * sR.ux) * inv_sr;
        RealType uy_roe = (srL * sL.uy + srR * sR.uy) * inv_sr;
        RealType uz_roe = (srL * sL.uz + srR * sR.uz) * inv_sr;
        RealType u_roe = (dir == 0) ? ux_roe : (dir == 1 ? uy_roe : uz_roe);
        RealType a_roe = sqrt(fmax((RealType)1e-12, (gamma - (RealType)1.0) * (H_roe - (RealType)0.5 * (ux_roe*ux_roe + uy_roe*uy_roe + uz_roe*uz_roe))));
        SL = fmin(uL - aL, u_roe - a_roe);
        SR = fmax(uR + aR, u_roe + a_roe);
    } else {
        SL = fmin(uL - aL, uR - aR);
        SR = fmax(uL + aL, uR + aR);
    }

    if (SL >= (RealType)0.0) {
        flux[0] = sL.rho * uL;
        flux[1] = sL.rho * uL * sL.ux + (dir == 0 ? sL.p : (RealType)0.0);
        flux[2] = sL.rho * uL * sL.uy + (dir == 1 ? sL.p : (RealType)0.0);
        flux[3] = sL.rho * uL * sL.uz + (dir == 2 ? sL.p : (RealType)0.0);
        flux[4] = uL * (sL.E + sL.p);
        if constexpr (IsMultiMaterial) {
            flux[5] = uL * sL.alpha1;
            flux[6] = uL * sL.alpha2;
            flux[7] = uL * sL.arho1;
            flux[8] = uL * sL.arho2;
        }
        flux[9] = uL;
        return;
    }
    if (SR <= (RealType)0.0) {
        flux[0] = sR.rho * uR;
        flux[1] = sR.rho * uR * sR.ux + (dir == 0 ? sR.p : (RealType)0.0);
        flux[2] = sR.rho * uR * sR.uy + (dir == 1 ? sR.p : (RealType)0.0);
        flux[3] = sR.rho * uR * sR.uz + (dir == 2 ? sR.p : (RealType)0.0);
        flux[4] = uR * (sR.E + sR.p);
        if constexpr (IsMultiMaterial) {
            flux[5] = uR * sR.alpha1;
            flux[6] = uR * sR.alpha2;
            flux[7] = uR * sR.arho1;
            flux[8] = uR * sR.arho2;
        }
        flux[9] = uR;
        return;
    }

    RealType rL_sL = sL.rho * (SL - uL);
    RealType rR_sR = sR.rho * (SR - uR);
    RealType denom = rL_sL - rR_sR;
    RealType S_star = (fabs(denom) > (RealType)1e-12) ? ((sR.p - sL.p + uL * rL_sL - uR * rR_sR) / denom) : ((RealType)0.5 * (uL + uR));

    if (S_star >= (RealType)0.0) {
        RealType dSL = SL - S_star;
        if (fabs(dSL) < (RealType)1e-12) dSL = (dSL >= (RealType)0.0) ? (RealType)1e-12 : (RealType)(-1e-12);
        RealType fac = rL_sL / dSL;
        RealType uL_vx = (dir == 0) ? S_star : sL.ux;
        RealType uL_vy = (dir == 1) ? S_star : sL.uy;
        RealType uL_vz = (dir == 2) ? S_star : sL.uz;
        RealType du_sl = (fabs(rL_sL) > (RealType)1e-12) ? (sL.p / rL_sL) : (RealType)0.0;
        RealType u_star_E = fac * (sL.E / fmax((RealType)1e-12, sL.rho) + (S_star - uL) * (S_star + du_sl));
        flux[0] = sL.rho * uL + SL * (fac - sL.rho);
        flux[1] = (sL.rho * uL * sL.ux + (dir == 0 ? sL.p : (RealType)0.0)) + SL * (fac * uL_vx - sL.rho * sL.ux);
        flux[2] = (sL.rho * uL * sL.uy + (dir == 1 ? sL.p : (RealType)0.0)) + SL * (fac * uL_vy - sL.rho * sL.uy);
        flux[3] = (sL.rho * uL * sL.uz + (dir == 2 ? sL.p : (RealType)0.0)) + SL * (fac * uL_vz - sL.rho * sL.uz);
        flux[4] = uL * (sL.E + sL.p) + SL * (u_star_E - sL.E);
        if constexpr (IsMultiMaterial) {
            RealType inv_rL = (RealType)1.0 / fmax((RealType)1e-12, sL.rho);
            flux[5] = S_star * sL.alpha1;
            flux[6] = S_star * sL.alpha2;
            flux[7] = uL * sL.arho1 + SL * (fac * (sL.arho1 * inv_rL) - sL.arho1);
            flux[8] = uL * sL.arho2 + SL * (fac * (sL.arho2 * inv_rL) - sL.arho2);
        }
    } else {
        RealType dSR = SR - S_star;
        if (fabs(dSR) < (RealType)1e-12) dSR = (dSR >= (RealType)0.0) ? (RealType)1e-12 : (RealType)(-1e-12);
        RealType fac = rR_sR / dSR;
        RealType uR_vx = (dir == 0) ? S_star : sR.ux;
        RealType uR_vy = (dir == 1) ? S_star : sR.uy;
        RealType uR_vz = (dir == 2) ? S_star : sR.uz;
        RealType du_sr = (fabs(rR_sR) > (RealType)1e-12) ? (sR.p / rR_sR) : (RealType)0.0;
        RealType u_star_E = fac * (sR.E / fmax((RealType)1e-12, sR.rho) + (S_star - uR) * (S_star + du_sr));
        flux[0] = sR.rho * uR + SR * (fac - sR.rho);
        flux[1] = (sR.rho * uR * sR.ux + (dir == 0 ? sR.p : (RealType)0.0)) + SR * (fac * uR_vx - sR.rho * sR.ux);
        flux[2] = (sR.rho * uR * sR.uy + (dir == 1 ? sR.p : (RealType)0.0)) + SR * (fac * uR_vy - sR.rho * sR.uy);
        flux[3] = (sR.rho * uR * sR.uz + (dir == 2 ? sR.p : (RealType)0.0)) + SR * (fac * uR_vz - sR.rho * sR.uz);
        flux[4] = uR * (sR.E + sR.p) + SR * (u_star_E - sR.E);
        if constexpr (IsMultiMaterial) {
            RealType inv_rR = (RealType)1.0 / fmax((RealType)1e-12, sR.rho);
            flux[5] = S_star * sR.alpha1;
            flux[6] = S_star * sR.alpha2;
            flux[7] = uR * sR.arho1 + SR * (fac * (sR.arho1 * inv_rR) - sR.arho1);
            flux[8] = uR * sR.arho2 + SR * (fac * (sR.arho2 * inv_rR) - sR.arho2);
        }
    }
    flux[9] = S_star;
}

template <typename RealType, bool IsMultiMaterial>
__device__ inline void getMaterialInterfaceFluxGPU(
    const GPUCellStateT<RealType, IsMultiMaterial>& sL,
    const GPUCellStateT<RealType, IsMultiMaterial>& sR,
    RealType* flux, int dir, RealType gamma,
    RealType z_cL = (RealType)0.0, RealType z_cR = (RealType)0.0,
    int side = 0
) {
    RealType unL = (dir == 0) ? sL.ux : (dir == 1 ? sL.uy : sL.uz);
    RealType unR = (dir == 0) ? sR.ux : (dir == 1 ? sR.uy : sR.uz);

    RealType cL = computeCellSoundSpeedGPU<RealType, IsMultiMaterial>(sL, z_cL, gamma);
    RealType cR = computeCellSoundSpeedGPU<RealType, IsMultiMaterial>(sR, z_cR, gamma);

    RealType zL = fmax((RealType)1e-3, sL.rho * cL);
    RealType zR = fmax((RealType)1e-3, sR.rho * cR);

    RealType pL_face = fmax((RealType)0.0, sL.p);
    RealType pR_face = fmax((RealType)0.0, sR.p);

    // Exact acoustic Riemann contact solution (impedance weighted with velocity jump)
    RealType u_star = (zL * unL + zR * unR + (pL_face - pR_face)) / (zL + zR);
    RealType p_acoustic = (zR * pL_face + zL * pR_face - zL * zR * (unR - unL)) / (zL + zR);

    // Unilateral contact law: an unbonded interface cannot sustain tensile suction.
    // If acoustic contact solution drops below zero, the interface separates under cavitation.
    RealType p_star = fmax((RealType)0.0, p_acoustic);

    // Deadband for tiny numerical noise in hydrostatic equilibrium
    if (fabs(u_star) < (RealType)1e-5) {
        u_star = (RealType)0.0;
    }

    // Material-consistent Ghost Fluid Method (GFM) state selection:
    // If side == -1, flux is evaluated for the cell on the left (L).
    // If side == +1, flux is evaluated for the cell on the right (R).
    // If side == 0 (unspecified), default to standard upwind.
    const auto& s_mat = (side == -1) ? sL : ((side == 1) ? sR : ((u_star >= (RealType)0.0) ? sL : sR));

    flux[0] = s_mat.rho * u_star;
    flux[1] = s_mat.rho * u_star * s_mat.ux + (dir == 0 ? p_star : (RealType)0.0);
    flux[2] = s_mat.rho * u_star * s_mat.uy + (dir == 1 ? p_star : (RealType)0.0);
    flux[3] = s_mat.rho * u_star * s_mat.uz + (dir == 2 ? p_star : (RealType)0.0);
    flux[4] = u_star * (s_mat.E + p_star);

    if constexpr (IsMultiMaterial) {
        flux[5] = s_mat.alpha1 * u_star;
        flux[6] = s_mat.alpha2 * u_star;
        flux[7] = s_mat.arho1 * u_star;
        flux[8] = s_mat.arho2 * u_star;
    }
    flux[9] = u_star;
}

template <typename RealType>
__device__ inline RealType minmod_gpu(RealType a, RealType b) {
    RealType min_val = (fabs(a) < fabs(b)) ? a : b;
    return (a * b > (RealType)0.0) ? min_val : (RealType)0.0;
}

template <typename RealType>
__device__ inline RealType vanleer_gpu(RealType a, RealType b) {
    if (a * b <= (RealType)0.0) return (RealType)0.0;
    RealType aa = fabs(a), ab = fabs(b);
    RealType m = fmin((RealType)0.5 * (aa + ab), (RealType)2.0 * fmin(aa, ab));
    return (a > (RealType)0.0) ? m : -m;
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
__device__ __noinline__ GPUCellStateT<RealType, IsMultiMaterial> sample_gpu_solid_ghost_slow(
    const TileType* states,
    const GeometryTile3D* geom,
    int target_x, int target_y, int target_z,
    int qx, int qy, int qz,
    int dir
) {
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
                
                auto s_neighbor = sample_gpu_interior<RealType, IsMultiMaterial, TileType>(states, nx_val, ny_val, nz_val);
                
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
        int max_tiles = d_ntx * d_nty * d_ntz;
        if (t_b >= 0 && t_b < max_tiles) {
            bool b_flag; float nx_d, ny_d, nz_d;
            unpack_geometry_payload(geom[t_b].cells[c_b], b_flag, nx_d, ny_d, nz_d, solid_frac);
            if (!b_flag) solid_frac = 0.0f;
        } else {
            solid_frac = 0.0f;
        }
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

template <typename RealType, bool IsMultiMaterial, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ inline GPUCellStateT<RealType, IsMultiMaterial> sample_gpu(
    const TileType* states,
    const GeometryTile3D* geom,
    int target_x, int target_y, int target_z,
    int qx, int qy, int qz,
    int dir,
    bool is_near_boundary
) {
    if (!is_near_boundary || !is_solid_cell_gpu(geom, target_x, target_y, target_z)) {
        return sample_gpu_raw<RealType, IsMultiMaterial, TileType>(states, target_x, target_y, target_z);
    }
    return sample_gpu_solid_ghost_slow<RealType, IsMultiMaterial, TileType>(states, geom, target_x, target_y, target_z, qx, qy, qz, dir);
}

template <typename RealType>
__device__ inline bool thinc_reconstruct_cell_gpu(
    RealType vM, RealType vC, RealType vP,
    RealType& vFaceL, RealType& vFaceR,
    RealType beta = (RealType)1.6
) {
    if (vC <= (RealType)1e-5) {
        vFaceL = (RealType)0.0;
        vFaceR = (RealType)0.0;
        return true;
    }
    if (vC >= (RealType)(1.0 - 1e-5)) {
        vFaceL = (RealType)1.0;
        vFaceR = (RealType)1.0;
        return true;
    }

    RealType dL = vC - vM;
    RealType dR = vP - vC;

    // Strict monotonicity check: do not steepen local extrema
    if (dL * dR <= (RealType)0.0) {
        return false;
    }

    RealType theta = (dR > (RealType)0.0) ? (RealType)1.0 : (RealType)-1.0;
    RealType q = (theta > (RealType)0.0) ? vC : ((RealType)1.0 - vC);
    q = fmax((RealType)1e-5, fmin((RealType)(1.0 - 1e-5), q));

    // Analytical THINC integration for normalized monotonic jump
    // q = \int_0^1 0.5 * (1 + tanh(beta * (xi - x0))) dxi
    // tanh(beta * x0) = (cosh(beta) - exp(beta * (2*q - 1))) / sinh(beta)
    RealType exp_term = exp(beta * ((RealType)2.0 * q - (RealType)1.0));
    RealType cosh_b = cosh(beta);
    RealType sinh_b = sinh(beta);
    RealType tanh_b = tanh(beta);

    RealType y = (cosh_b - exp_term) / sinh_b;
    y = fmax((RealType)-0.999999, fmin((RealType)0.999999, y));

    RealType a0 = (RealType)0.5 * ((RealType)1.0 - y);
    RealType denom = (RealType)1.0 - y * tanh_b;
    RealType tanh_1_minus_x0 = (fabs(denom) > (RealType)1e-7) ? ((tanh_b - y) / denom) : (RealType)1.0;
    RealType a1 = (RealType)0.5 * ((RealType)1.0 + tanh_1_minus_x0);

    a0 = fmax((RealType)0.0, fmin((RealType)1.0, a0));
    a1 = fmax((RealType)0.0, fmin((RealType)1.0, a1));

    if (theta > (RealType)0.0) {
        vFaceL = a0;
        vFaceR = a1;
    } else {
        vFaceL = (RealType)1.0 - a0;
        vFaceR = (RealType)1.0 - a1;
    }

    return true;
}

template <typename RealType>
__device__ inline RealType bvd_thinc_pick_gpu(
    RealType dm1, RealType d0, RealType dp1,
    RealType beta, RealType cosh_b, RealType tanh_b, RealType inv_tanh_b,
    bool pick_left
) {
    RealType dL_mc = vanleer_gpu(dm1, d0);
    RealType dR_mc = vanleer_gpu(d0, dp1);

    if (d0 == (RealType)0.0 || dm1 * d0 <= (RealType)0.0 || d0 * dp1 <= (RealType)0.0) {
        return pick_left ? dL_mc : dR_mc;
    }

    auto eval_beta = [&](RealType b, RealType cb, RealType tb, RealType itb, RealType& dL_th, RealType& dR_th) -> bool {
        RealType cL = fmin(fmax(dm1 / (dm1 + d0), (RealType)1e-4), (RealType)1.0 - (RealType)1e-4);
        RealType BL = exp(b * ((RealType)2.0 * cL - (RealType)1.0));
        RealType AL = (BL / cb - (RealType)1.0) * itb;
        RealType phi1 = (RealType)0.5 * ((RealType)1.0 + (tb + AL) / ((RealType)1.0 + tb * AL));

        RealType cR = fmin(fmax(d0 / (d0 + dp1), (RealType)1e-4), (RealType)1.0 - (RealType)1e-4);
        RealType BR = exp(b * ((RealType)2.0 * cR - (RealType)1.0));
        RealType AR = (BR / cb - (RealType)1.0) * itb;
        RealType phi0 = (RealType)0.5 * ((RealType)1.0 + AR);

        RealType wL_th_rel = -dm1 + (dm1 + d0) * phi1;
        RealType wR_th_rel = (d0 + dp1) * phi0;

        RealType wL_mc_rel = (RealType)0.5 * dL_mc;
        RealType wR_mc_rel = d0 - (RealType)0.5 * dR_mc;

        RealType jump_th = wR_th_rel - wL_th_rel;
        RealType jump_mc = wR_mc_rel - wL_mc_rel;

        if (jump_th * d0 >= (RealType)0.0 && fabs(jump_th) < fabs(jump_mc)) {
            dL_th = (RealType)2.0 * wL_th_rel;
            dR_th = (RealType)2.0 * (d0 - wR_th_rel);
            return true;
        }
        return false;
    };

    RealType dL_th = dL_mc, dR_th = dR_mc;
    if (eval_beta(beta, cosh_b, tanh_b, inv_tanh_b, dL_th, dR_th)) {
        return pick_left ? dL_th : dR_th;
    }
    const RealType b2 = (RealType)1.4;
    const RealType cb2 = (RealType)2.1508984653931445;  // cosh(1.4)
    const RealType tb2 = (RealType)0.8853516482022625;  // tanh(1.4)
    const RealType itb2 = (RealType)1.1294947078279120; // 1/tanh(1.4)
    if (eval_beta(b2, cb2, tb2, itb2, dL_th, dR_th)) {
        return pick_left ? dL_th : dR_th;
    }
    return pick_left ? dL_mc : dR_mc;
}

template <typename RealType>
__device__ inline void reconstruct_char_ideal_gpu(
    const GPUCellStateT<RealType, false>& sM2,
    const GPUCellStateT<RealType, false>& sM1,
    const GPUCellStateT<RealType, false>& sP0,
    const GPUCellStateT<RealType, false>& sP1,
    int dir, RealType gamma,
    bool forceL, bool forceR,
    GPUCellStateT<RealType, false>& sL,
    GPUCellStateT<RealType, false>& sR
) {
    RealType unM2 = (dir == 0) ? sM2.ux : (dir == 1 ? sM2.uy : sM2.uz);
    RealType unM1 = (dir == 0) ? sM1.ux : (dir == 1 ? sM1.uy : sM1.uz);
    RealType unP0 = (dir == 0) ? sP0.ux : (dir == 1 ? sP0.uy : sP0.uz);
    RealType unP1 = (dir == 0) ? sP1.ux : (dir == 1 ? sP1.uy : sP1.uz);

    RealType ut1M2 = (dir == 0) ? sM2.uy : sM2.ux;
    RealType ut1M1 = (dir == 0) ? sM1.uy : sM1.ux;
    RealType ut1P0 = (dir == 0) ? sP0.uy : sP0.ux;
    RealType ut1P1 = (dir == 0) ? sP1.uy : sP1.ux;

    RealType ut2M2 = (dir == 2) ? sM2.uy : sM2.uz;
    RealType ut2M1 = (dir == 2) ? sM1.uy : sM1.uz;
    RealType ut2P0 = (dir == 2) ? sP0.uy : sP0.uz;
    RealType ut2P1 = (dir == 2) ? sP1.uy : sP1.uz;

    RealType unL = unM1, ut1L = ut1M1, ut2L = ut2M1;
    RealType unR = unP0, ut1R = ut1P0, ut2R = ut2P0;

    const RealType beta = (RealType)2.0;
    const RealType cosh_b = (RealType)3.7621956910836314;     // cosh(2.0)
    const RealType tanh_b = (RealType)0.9640275800758169;     // tanh(2.0)
    const RealType inv_tanh_b = (RealType)1.0373147207275482; // 1/tanh(2.0)

    if (!forceL) {
        RealType rhoL = fmax((RealType)1e-7, sM1.rho);
        RealType pL_c = fmax((RealType)1e-7, sM1.p);
        RealType cL = sqrt(gamma * pL_c / rhoL);
        RealType rcL = rhoL * cL;
        RealType inv_c2 = (RealType)1.0 / (cL * cL);

        RealType dr1 = sM1.rho - sM2.rho, dr2 = sP0.rho - sM1.rho;
        RealType du1 = unM1 - unM2,       du2 = unP0 - unM1;
        RealType dp1 = sM1.p - sM2.p,     dp2 = sP0.p - sM1.p;

        RealType dw1, dw2, dw3;
        RealType w1_1 = (RealType)0.5 * (dp1 - rcL * du1);
        RealType w1_2 = (RealType)0.5 * (dp2 - rcL * du2);
        RealType w2_1 = dr1 - dp1 * inv_c2;
        RealType w2_2 = dr2 - dp2 * inv_c2;
        RealType w3_1 = (RealType)0.5 * (dp1 + rcL * du1);
        RealType w3_2 = (RealType)0.5 * (dp2 + rcL * du2);
        if (!forceR) {
            RealType dr3 = sP1.rho - sP0.rho;
            RealType du3 = unP1 - unP0;
            RealType dp3 = sP1.p - sP0.p;
            dw1 = bvd_thinc_pick_gpu(w1_1, w1_2, (RealType)0.5 * (dp3 - rcL * du3), beta, cosh_b, tanh_b, inv_tanh_b, true);
            dw2 = bvd_thinc_pick_gpu(w2_1, w2_2, dr3 - dp3 * inv_c2,                beta, cosh_b, tanh_b, inv_tanh_b, true);
            dw3 = bvd_thinc_pick_gpu(w3_1, w3_2, (RealType)0.5 * (dp3 + rcL * du3), beta, cosh_b, tanh_b, inv_tanh_b, true);
        } else {
            dw1 = vanleer_gpu(w1_1, w1_2);
            dw2 = vanleer_gpu(w2_1, w2_2);
            dw3 = vanleer_gpu(w3_1, w3_2);
        }

        RealType dpp = dw1 + dw3;
        RealType dun = (dw3 - dw1) / rcL;
        RealType drh = dw2 + dpp * inv_c2;

        sL.p   = fmax((RealType)1e-7, sM1.p   + (RealType)0.5 * dpp);
        sL.rho = fmax((RealType)1e-7, sM1.rho + (RealType)0.5 * drh);
        unL    = unM1 + (RealType)0.5 * dun;
        ut1L   = ut1M1 + (RealType)0.5 * vanleer_gpu(ut1M1 - ut1M2, ut1P0 - ut1M1);
        ut2L   = ut2M1 + (RealType)0.5 * vanleer_gpu(ut2M1 - ut2M2, ut2P0 - ut2M1);
    } else {
        sL.p   = fmax((RealType)1e-7, sM1.p);
        sL.rho = fmax((RealType)1e-7, sM1.rho);
    }

    if (!forceR) {
        RealType rhoR = fmax((RealType)1e-7, sP0.rho);
        RealType pR_c = fmax((RealType)1e-7, sP0.p);
        RealType cR = sqrt(gamma * pR_c / rhoR);
        RealType rcR = rhoR * cR;
        RealType inv_c2 = (RealType)1.0 / (cR * cR);

        RealType dr1 = sP0.rho - sM1.rho, dr2 = sP1.rho - sP0.rho;
        RealType du1 = unP0 - unM1,       du2 = unP1 - unP0;
        RealType dp1 = sP0.p - sM1.p,     dp2 = sP1.p - sP0.p;

        RealType dw1, dw2, dw3;
        RealType w1_2 = (RealType)0.5 * (dp1 - rcR * du1);
        RealType w1_3 = (RealType)0.5 * (dp2 - rcR * du2);
        RealType w2_2 = dr1 - dp1 * inv_c2;
        RealType w2_3 = dr2 - dp2 * inv_c2;
        RealType w3_2 = (RealType)0.5 * (dp1 + rcR * du1);
        RealType w3_3 = (RealType)0.5 * (dp2 + rcR * du2);
        if (!forceL) {
            RealType dr0 = sM1.rho - sM2.rho;
            RealType du0 = unM1 - unM2;
            RealType dp0 = sM1.p - sM2.p;
            dw1 = bvd_thinc_pick_gpu((RealType)0.5 * (dp0 - rcR * du0), w1_2, w1_3, beta, cosh_b, tanh_b, inv_tanh_b, false);
            dw2 = bvd_thinc_pick_gpu(dr0 - dp0 * inv_c2,                w2_2, w2_3, beta, cosh_b, tanh_b, inv_tanh_b, false);
            dw3 = bvd_thinc_pick_gpu((RealType)0.5 * (dp0 + rcR * du0), w3_2, w3_3, beta, cosh_b, tanh_b, inv_tanh_b, false);
        } else {
            dw1 = vanleer_gpu(w1_2, w1_3);
            dw2 = vanleer_gpu(w2_2, w2_3);
            dw3 = vanleer_gpu(w3_2, w3_3);
        }

        RealType dpp = dw1 + dw3;
        RealType dun = (dw3 - dw1) / rcR;
        RealType drh = dw2 + dpp * inv_c2;

        sR.p   = fmax((RealType)1e-7, sP0.p   - (RealType)0.5 * dpp);
        sR.rho = fmax((RealType)1e-7, sP0.rho - (RealType)0.5 * drh);
        unR    = unP0 - (RealType)0.5 * dun;
        ut1R   = ut1P0 - (RealType)0.5 * vanleer_gpu(ut1P0 - ut1M1, ut1P1 - ut1P0);
        ut2R   = ut2P0 - (RealType)0.5 * vanleer_gpu(ut2P0 - ut2M1, ut2P1 - ut2P0);
    } else {
        sR.p   = fmax((RealType)1e-7, sP0.p);
        sR.rho = fmax((RealType)1e-7, sP0.rho);
    }

    if (dir == 0) {
        sL.ux = unL; sL.uy = ut1L; sL.uz = ut2L;
        sR.ux = unR; sR.uy = ut1R; sR.uz = ut2R;
    } else if (dir == 1) {
        sL.ux = ut1L; sL.uy = unL; sL.uz = ut2L;
        sR.ux = ut1R; sR.uy = unR; sR.uz = ut2R;
    } else {
        sL.ux = ut1L; sL.uy = ut2L; sL.uz = unL;
        sR.ux = ut1R; sR.uy = ut2R; sR.uz = unR;
    }
}

template <typename RealType, bool IsMultiMaterial, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ __noinline__ void reconstruct_gpu(
    const TileType* states,
    const GeometryTile3D* geom,
    int gx, int gy, int gz,
    int dir,
    GPUCellStateT<RealType, IsMultiMaterial>& sL, GPUCellStateT<RealType, IsMultiMaterial>& sR,
    int qx, int qy, int qz,
    bool is_near_boundary,
    bool force_first_order_L = false,
    bool force_first_order_R = false,
    int spatial_order = 2
) {
    int dx = (dir == 0 ? 1 : 0);
    int dy = (dir == 1 ? 1 : 0);
    int dz = (dir == 2 ? 1 : 0);

    bool l_fluid = is_near_boundary && geom && !is_solid_cell_gpu(geom, gx - dx, gy - dy, gz - dz);
    bool r_fluid = is_near_boundary && geom && !is_solid_cell_gpu(geom, gx, gy, gz);
    int ax_L = l_fluid ? (gx - dx) : qx, ay_L = l_fluid ? (gy - dy) : qy, az_L = l_fluid ? (gz - dz) : qz;
    int ax_R = r_fluid ? gx : qx,        ay_R = r_fluid ? gy : qy,        az_R = r_fluid ? gz : qz;

    GPUCellStateT<RealType, IsMultiMaterial> sM1 = sample_gpu<RealType, IsMultiMaterial, TileType>(states, geom, gx - dx, gy - dy, gz - dz, ax_R, ay_R, az_R, dir, is_near_boundary);
    GPUCellStateT<RealType, IsMultiMaterial> sP0 = sample_gpu<RealType, IsMultiMaterial, TileType>(states, geom, gx, gy, gz, ax_L, ay_L, az_L, dir, is_near_boundary);

    GPUCellStateT<RealType, IsMultiMaterial> sM2 = sample_gpu<RealType, IsMultiMaterial, TileType>(states, geom, gx - 2*dx, gy - 2*dy, gz - 2*dz, ax_L, ay_L, az_L, dir, is_near_boundary);
    GPUCellStateT<RealType, IsMultiMaterial> sP1 = sample_gpu<RealType, IsMultiMaterial, TileType>(states, geom, gx + dx, gy + dy, gz + dz, ax_R, ay_R, az_R, dir, is_near_boundary);

    RealType z_cM2 = (RealType)d_zmin + ((RealType)(gz - 2*dz) + (RealType)0.5) * (RealType)d_cellSize;
    RealType z_cL  = (RealType)d_zmin + ((RealType)(gz - dz)   + (RealType)0.5) * (RealType)d_cellSize;
    RealType z_cR  = (RealType)d_zmin + ((RealType)gz          + (RealType)0.5) * (RealType)d_cellSize;
    RealType z_cP1 = (RealType)d_zmin + ((RealType)(gz + dz)   + (RealType)0.5) * (RealType)d_cellSize;

    auto get_mat = [&](RealType rho, RealType z, RealType alpha) -> int {
        if (!d_stratParams.enabled) return 0;
        if (alpha > (RealType)0.05) return 3; // Dominant energetic material
        if (is_cell_soil(rho, z, alpha)) return 2;
        if (is_cell_water(rho, z, alpha)) return 1;
        return 0; // Gas (Air / Detonation Products)
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

    bool is_mat_interface = d_stratParams.enabled && (
        (matM1 == 2 || matP0 == 2) ? (matM1 != matP0) :
        (matM1 != matP0 && matM1 != 3 && matP0 != 3)
    );
    bool same_mat_L = (matM2 == matM1);
    bool same_mat_R = (matP1 == matP0);

    auto reconstruct_channel = [&](RealType vM2, RealType vM1, RealType vP0, RealType vP1, RealType& vL, RealType& vR, bool is_pressure = false) {
        if (is_mat_interface) {
            if (is_pressure && dir == 2 && d_has_gravity) {
                vL = vM1 + (RealType)0.5 * sM1.rho * (RealType)d_gravity_z * (RealType)d_cellSize;
                vR = vP0 - (RealType)0.5 * sP0.rho * (RealType)d_gravity_z * (RealType)d_cellSize;
            } else {
                vL = vM1;
                vR = vP0;
            }
        } else if (spatial_order == 1 || (force_first_order_L && force_first_order_R)) {
            vL = vM1;
            vR = vP0;
        } else {
            RealType dC = vP0 - vM1;
            RealType dL = same_mat_L ? (vM1 - vM2) : (RealType)0.0;
            RealType dR = same_mat_R ? (vP1 - vP0) : (RealType)0.0;

            if (force_first_order_L) {
                vL = vM1;
            } else if (spatial_order == 3) {
                vL = same_mat_L ? weno3_gpu(vM2, vM1, vP0) : (vM1 + (RealType)0.5 * minmod_gpu(dL, dC));
            } else {
                vL = vM1 + (RealType)0.5 * vanleer_gpu(dL, dC);
            }

            if (force_first_order_R) {
                vR = vP0;
            } else if (spatial_order == 3) {
                vR = same_mat_R ? weno3_gpu(vP1, vP0, vM1) : (vP0 - (RealType)0.5 * minmod_gpu(dC, dR));
            } else {
                vR = vP0 - (RealType)0.5 * vanleer_gpu(dC, dR);
            }
        }
    };

    GPUCellStateT<RealType, IsMultiMaterial> lL{}, lR{};

    if constexpr (!IsMultiMaterial) {
        if (!d_stratParams.enabled && !d_isWater && spatial_order == 2) {
            reconstruct_char_ideal_gpu<RealType>(sM2, sM1, sP0, sP1, dir, (RealType)d_gamma, force_first_order_L, force_first_order_R, lL, lR);
        } else {
            reconstruct_channel(sM2.ux, sM1.ux, sP0.ux, sP1.ux, lL.ux, lR.ux);
            reconstruct_channel(sM2.uy, sM1.uy, sP0.uy, sP1.uy, lL.uy, lR.uy);
            reconstruct_channel(sM2.uz, sM1.uz, sP0.uz, sP1.uz, lL.uz, lR.uz);
            reconstruct_channel(sM2.p, sM1.p, sP0.p, sP1.p, lL.p, lR.p, true);
            lL.p = fmax((RealType)1e-7, lL.p);
            lR.p = fmax((RealType)1e-7, lR.p);
        }
    } else {
        reconstruct_channel(sM2.ux, sM1.ux, sP0.ux, sP1.ux, lL.ux, lR.ux);
        reconstruct_channel(sM2.uy, sM1.uy, sP0.uy, sP1.uy, lL.uy, lR.uy);
        reconstruct_channel(sM2.uz, sM1.uz, sP0.uz, sP1.uz, lL.uz, lR.uz);
        reconstruct_channel(sM2.p, sM1.p, sP0.p, sP1.p, lL.p, lR.p, true);
        lL.p = fmax((RealType)1e-7, lL.p);
        lR.p = fmax((RealType)1e-7, lR.p);
    }

    if constexpr (IsMultiMaterial) {
        // --- 1. Reconstruct Volume Fractions with THINC-BVD ---
        RealType poly_M1_R_a1 = sM1.alpha1 + (RealType)0.5 * minmod_gpu(sM1.alpha1 - sM2.alpha1, sP0.alpha1 - sM1.alpha1);
        RealType poly_P0_L_a1 = sP0.alpha1 - (RealType)0.5 * minmod_gpu(sP0.alpha1 - sM1.alpha1, sP1.alpha1 - sP0.alpha1);
        poly_M1_R_a1 = fmax((RealType)0.0, fmin((RealType)1.0, poly_M1_R_a1));
        poly_P0_L_a1 = fmax((RealType)0.0, fmin((RealType)1.0, poly_P0_L_a1));

        RealType thinc_M1_L_a1, thinc_M1_R_a1;
        bool ok_M1_a1 = thinc_reconstruct_cell_gpu(sM2.alpha1, sM1.alpha1, sP0.alpha1, thinc_M1_L_a1, thinc_M1_R_a1, (RealType)1.6);
        RealType thinc_P0_L_a1, thinc_P0_R_a1;
        bool ok_P0_a1 = thinc_reconstruct_cell_gpu(sM1.alpha1, sP0.alpha1, sP1.alpha1, thinc_P0_L_a1, thinc_P0_R_a1, (RealType)1.6);

        RealType jump_poly_a1 = fabs(poly_P0_L_a1 - poly_M1_R_a1);
        RealType cand_P0_a1 = ok_P0_a1 ? thinc_P0_L_a1 : poly_P0_L_a1;
        RealType cand_M1_a1 = ok_M1_a1 ? thinc_M1_R_a1 : poly_M1_R_a1;
        RealType jump_thinc_a1 = fabs(cand_P0_a1 - cand_M1_a1);

        lL.alpha1 = (ok_M1_a1 && jump_thinc_a1 < jump_poly_a1) ? thinc_M1_R_a1 : poly_M1_R_a1;
        lR.alpha1 = (ok_P0_a1 && jump_thinc_a1 < jump_poly_a1) ? thinc_P0_L_a1 : poly_P0_L_a1;

        RealType poly_M1_R_a2 = sM1.alpha2 + (RealType)0.5 * minmod_gpu(sM1.alpha2 - sM2.alpha2, sP0.alpha2 - sM1.alpha2);
        RealType poly_P0_L_a2 = sP0.alpha2 - (RealType)0.5 * minmod_gpu(sP0.alpha2 - sM1.alpha2, sP1.alpha2 - sP0.alpha2);
        poly_M1_R_a2 = fmax((RealType)0.0, fmin((RealType)1.0, poly_M1_R_a2));
        poly_P0_L_a2 = fmax((RealType)0.0, fmin((RealType)1.0, poly_P0_L_a2));

        RealType thinc_M1_L_a2, thinc_M1_R_a2;
        bool ok_M1_a2 = thinc_reconstruct_cell_gpu(sM2.alpha2, sM1.alpha2, sP0.alpha2, thinc_M1_L_a2, thinc_M1_R_a2, (RealType)1.6);
        RealType thinc_P0_L_a2, thinc_P0_R_a2;
        bool ok_P0_a2 = thinc_reconstruct_cell_gpu(sM1.alpha2, sP0.alpha2, sP1.alpha2, thinc_P0_L_a2, thinc_P0_R_a2, (RealType)1.6);

        RealType jump_poly_a2 = fabs(poly_P0_L_a2 - poly_M1_R_a2);
        RealType cand_P0_a2 = ok_P0_a2 ? thinc_P0_L_a2 : poly_P0_L_a2;
        RealType cand_M1_a2 = ok_M1_a2 ? thinc_M1_R_a2 : poly_M1_R_a2;
        RealType jump_thinc_a2 = fabs(cand_P0_a2 - cand_M1_a2);

        lL.alpha2 = (ok_M1_a2 && jump_thinc_a2 < jump_poly_a2) ? thinc_M1_R_a2 : poly_M1_R_a2;
        lR.alpha2 = (ok_P0_a2 && jump_thinc_a2 < jump_poly_a2) ? thinc_P0_L_a2 : poly_P0_L_a2;

        if (force_first_order_L) {
            lL.alpha1 = sM1.alpha1;
            lL.alpha2 = sM1.alpha2;
        }
        if (force_first_order_R) {
            lR.alpha1 = sP0.alpha1;
            lR.alpha2 = sP0.alpha2;
        }

        lL.alpha1 = fmax((RealType)0.0, fmin((RealType)1.0, lL.alpha1));
        lL.alpha2 = fmax((RealType)0.0, fmin((RealType)(1.0 - lL.alpha1), lL.alpha2));
        lR.alpha1 = fmax((RealType)0.0, fmin((RealType)1.0, lR.alpha1));
        lR.alpha2 = fmax((RealType)0.0, fmin((RealType)(1.0 - lR.alpha1), lR.alpha2));

        // --- 2. Intrinsic Phase Densities & Abgrall Invariance ---
        auto get_phase_densities = [&](const GPUCellStateT<RealType, IsMultiMaterial>& cell, RealType z_c, RealType& r1, RealType& r2, RealType& r0) {
            r1 = (cell.alpha1 > (RealType)1e-5) ? (cell.arho1 / cell.alpha1) : (RealType)d_products.rho0;
            r2 = (cell.alpha2 > (RealType)1e-5) ? (cell.arho2 / cell.alpha2) : (RealType)d_unreacted.rho0;
            RealType a0 = (RealType)1.0 - cell.alpha1 - cell.alpha2;
            if (a0 > (RealType)1e-5) {
                r0 = fmax((RealType)1e-7, (cell.rho - cell.arho1 - cell.arho2) / a0);
            } else {
                r0 = is_cell_water(cell.rho, z_c) ? (RealType)d_taitParams.rho0 : (RealType)d_ambient_rho;
            }
        };

        RealType r1_M2, r2_M2, r0_M2;
        RealType r1_M1, r2_M1, r0_M1;
        RealType r1_P0, r2_P0, r0_P0;
        RealType r1_P1, r2_P1, r0_P1;

        get_phase_densities(sM2, z_cM2, r1_M2, r2_M2, r0_M2);
        get_phase_densities(sM1, z_cL,  r1_M1, r2_M1, r0_M1);
        get_phase_densities(sP0, z_cR,  r1_P0, r2_P0, r0_P0);
        get_phase_densities(sP1, z_cP1, r1_P1, r2_P1, r0_P1);

        RealType r0_L, r0_R;
        reconstruct_channel(r0_M2, r0_M1, r0_P0, r0_P1, r0_L, r0_R);
        r0_L = fmax((RealType)1e-7, r0_L);
        r0_R = fmax((RealType)1e-7, r0_R);

        RealType r1_L, r1_R;
        reconstruct_channel(r1_M2, r1_M1, r1_P0, r1_P1, r1_L, r1_R);
        r1_L = fmax((RealType)1e-7, r1_L);
        r1_R = fmax((RealType)1e-7, r1_R);

        RealType r2_L, r2_R;
        reconstruct_channel(r2_M2, r2_M1, r2_P0, r2_P1, r2_L, r2_R);
        r2_L = fmax((RealType)1e-7, r2_L);
        r2_R = fmax((RealType)1e-7, r2_R);

        lL.arho1 = lL.alpha1 * r1_L;
        lL.arho2 = lL.alpha2 * r2_L;
        RealType a0_L = fmax((RealType)0.0, (RealType)1.0 - lL.alpha1 - lL.alpha2);
        lL.rho = lL.arho1 + lL.arho2 + a0_L * r0_L;
        lL.rho = fmax((RealType)1e-7, lL.rho);

        lR.arho1 = lR.alpha1 * r1_R;
        lR.arho2 = lR.alpha2 * r2_R;
        RealType a0_R = fmax((RealType)0.0, (RealType)1.0 - lR.alpha1 - lR.alpha2);
        lR.rho = lR.arho1 + lR.arho2 + a0_R * r0_R;
        lR.rho = fmax((RealType)1e-7, lR.rho);
    } else {
        if (d_stratParams.enabled || d_isWater || spatial_order != 2) {
            reconstruct_channel(sM2.rho, sM1.rho, sP0.rho, sP1.rho, lL.rho, lR.rho);
            lL.rho = fmax((RealType)1e-7, lL.rho);
            lR.rho = fmax((RealType)1e-7, lR.rho);
        }
    }

    RealType keL = (RealType)0.5 * lL.rho * (lL.ux*lL.ux + lL.uy*lL.uy + lL.uz*lL.uz);
    RealType keR = (RealType)0.5 * lR.rho * (lR.ux*lR.ux + lR.uy*lR.uy + lR.uz*lR.uz);

    if constexpr (IsMultiMaterial) {
        if (is_cell_water(lL.rho, z_cL, lL.alpha1 + lL.alpha2)) {
            lL.E = MultiMat::getMixtureEnergyTait<RealType>(lL.p, lL.rho, lL.alpha1, lL.alpha2, lL.arho1, lL.arho2, d_taitParams, d_products, d_unreacted) + keL;
        } else if (is_cell_soil(lL.rho, z_cL)) {
            lL.E = computeFluidEnergyGPU<RealType>(lL.p, lL.rho, (RealType)d_gamma, z_cL) + keL;
        } else {
            lL.E = MultiMat::getMixtureEnergy<RealType>(lL.p, lL.rho, lL.alpha1, lL.alpha2, lL.arho1, lL.arho2, (RealType)d_gamma, d_products, d_unreacted) + keL;
        }
        if (is_cell_water(lR.rho, z_cR, lR.alpha1 + lR.alpha2)) {
            lR.E = MultiMat::getMixtureEnergyTait<RealType>(lR.p, lR.rho, lR.alpha1, lR.alpha2, lR.arho1, lR.arho2, d_taitParams, d_products, d_unreacted) + keR;
        } else if (is_cell_soil(lR.rho, z_cR)) {
            lR.E = computeFluidEnergyGPU<RealType>(lR.p, lR.rho, (RealType)d_gamma, z_cR) + keR;
        } else {
            lR.E = MultiMat::getMixtureEnergy<RealType>(lR.p, lR.rho, lR.alpha1, lR.alpha2, lR.arho1, lR.arho2, (RealType)d_gamma, d_products, d_unreacted) + keR;
        }
    } else {
        lL.E = computeFluidEnergyGPU<RealType>(lL.p, lL.rho, (RealType)d_gamma, z_cL) + keL;
        lR.E = computeFluidEnergyGPU<RealType>(lR.p, lR.rho, (RealType)d_gamma, z_cR) + keR;
    }

    sL = lL;
    sR = lR;
}

template <typename RealType, bool IsMultiMaterial>
__device__ __noinline__ void dispatch_riemann_flux_gpu(
    const GPUCellStateT<RealType, IsMultiMaterial>& sL,
    const GPUCellStateT<RealType, IsMultiMaterial>& sR,
    RealType* flx, int dir, RealType z_cL, RealType z_cR, int eff_side
) {
    RealType lf[10] = {};
    bool handled_strat = false;
    if (d_stratParams.enabled && dir == 2) {
        RealType a_he_L = (RealType)0.0, a_he_R = (RealType)0.0;
        if constexpr (IsMultiMaterial) {
            a_he_L = sL.alpha1 + sL.alpha2;
            a_he_R = sR.alpha1 + sR.alpha2;
        }
        bool sL_soil = is_cell_soil(sL.rho, z_cL, a_he_L);
        bool sR_soil = is_cell_soil(sR.rho, z_cR, a_he_R);
        bool sL_water = is_cell_water(sL.rho, z_cL, a_he_L);
        bool sR_water = is_cell_water(sR.rho, z_cR, a_he_R);
        bool is_stratified_interface = (sL_soil != sR_soil) || (a_he_L <= (RealType)0.05 && a_he_R <= (RealType)0.05 && (sL_water != sR_water));
        if (is_stratified_interface) {
            getMaterialInterfaceFluxGPU<RealType, IsMultiMaterial>(sL, sR, lf, dir, (RealType)d_gamma, z_cL, z_cR, eff_side);
            handled_strat = true;
        }
    }
    if (!handled_strat) {
        if (d_fluxScheme == 2) getHLLCFluxGPU<RealType, IsMultiMaterial>(sL, sR, lf, dir, (RealType)d_gamma, z_cL, z_cR);
        else if (d_useAUSM) getAUSMPlusFluxGPU<RealType, IsMultiMaterial>(sL, sR, lf, dir, (RealType)d_gamma, z_cL, z_cR);
        else getRusanovFluxGPU<RealType, IsMultiMaterial>(sL, sR, lf, dir, (RealType)d_gamma, z_cL, z_cR);
    }
    constexpr int n_flx = IsMultiMaterial ? 10 : 5;
    #pragma unroll
    for (int v = 0; v < n_flx; ++v) flx[v] = lf[v];
}

template <typename RealType, bool IsMultiMaterial, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ __noinline__ void get_face_flux_gpu(
    const TileType* states,
    const GeometryTile3D* geom_pool,
    int gx_L, int gy_L, int gz_L,
    int gx_R, int gy_R, int gz_R,
    int dir, RealType* flx,
    int qx, int qy, int qz,
    bool is_near_boundary,
    int spatial_order = 2,
    const FluidFractionTile3D<RealType>* fluid_frac = nullptr,
    const SolidVelocityTile3D* d_solid_vel = nullptr
) {
    RealType lf[10] = {};
    constexpr int n_flx = IsMultiMaterial ? 10 : 5;

    if (fluid_frac) {
        bool cell_is_R = (qx == gx_R && qy == gy_R && qz == gz_R);
        int ox = cell_is_R ? gx_L : gx_R;
        int oy = cell_is_R ? gy_L : gy_R;
        int oz = cell_is_R ? gz_L : gz_R;
        bool other_oob = (ox < 0 || ox >= d_nx || oy < 0 || oy >= d_ny || oz < 0 || oz >= d_nz);

        RealType a_self = get_alpha_f_gpu(fluid_frac, geom_pool, qx, qy, qz);
        if (a_self > (RealType)0.0) {
            RealType a_other = other_oob ? a_self : get_alpha_f_gpu(fluid_frac, geom_pool, ox, oy, oz);
            RealType A_open = other_oob ? a_self : fmin(a_self, a_other);
            RealType A_wall = (!other_oob && a_self > a_other) ? (a_self - a_other) : (RealType)0.0;

            if (A_open > (RealType)0.0) {
                RealType a_L_face = get_alpha_f_gpu(fluid_frac, geom_pool, gx_L, gy_L, gz_L);
                RealType a_R_face = get_alpha_f_gpu(fluid_frac, geom_pool, gx_R, gy_R, gz_R);
                bool force_L = (a_L_face < (RealType)FSI_ALPHA_CUT);
                bool force_R = (a_R_face < (RealType)FSI_ALPHA_CUT);

                GPUCellStateT<RealType, IsMultiMaterial> sL, sR;
                reconstruct_gpu<RealType, IsMultiMaterial, TileType>(states, geom_pool, gx_R, gy_R, gz_R, dir, sL, sR, qx, qy, qz, is_near_boundary, force_L, force_R, spatial_order);
                RealType z_cL = (RealType)d_zmin + ((RealType)gz_L + (RealType)0.5) * (RealType)d_cellSize;
                RealType z_cR = (RealType)d_zmin + ((RealType)gz_R + (RealType)0.5) * (RealType)d_cellSize;
                int q = (dir == 0 ? qx : (dir == 1 ? qy : qz));
                int g_R = (dir == 0 ? gx_R : (dir == 1 ? gy_R : gz_R));
                int eff_side = (q < g_R) ? -1 : 1;
                dispatch_riemann_flux_gpu<RealType, IsMultiMaterial>(sL, sR, lf, dir, z_cL, z_cR, eff_side);
                #pragma unroll
                for (int v = 0; v < n_flx; ++v) lf[v] *= A_open;
            }

            if (A_wall > (RealType)0.0) {
                GPUCellStateT<RealType, IsMultiMaterial> s_self = sample_gpu_raw<RealType, IsMultiMaterial, TileType>(states, qx, qy, qz);
                RealType n_out = cell_is_R ? (RealType)(-1.0) : (RealType)1.0;
                if (d_has_gravity) {
                    RealType g_comp = (dir == 0) ? (RealType)d_gravity_x
                                    : ((dir == 1) ? (RealType)d_gravity_y : (RealType)d_gravity_z);
                    s_self.p += (RealType)0.5 * s_self.rho * g_comp * (RealType)d_cellSize * n_out;
                }
                RealType vw_x = get_solid_vel_comp_gpu<RealType, IsMultiMaterial, TileType>(d_solid_vel, states, ox, oy, oz, 0);
                RealType vw_y = get_solid_vel_comp_gpu<RealType, IsMultiMaterial, TileType>(d_solid_vel, states, ox, oy, oz, 1);
                RealType vw_z = get_solid_vel_comp_gpu<RealType, IsMultiMaterial, TileType>(d_solid_vel, states, ox, oy, oz, 2);
                RealType vn_wall = (dir == 0) ? vw_x : ((dir == 1) ? vw_y : vw_z);
                RealType z_c_self = (RealType)d_zmin + ((RealType)qz + (RealType)0.5) * (RealType)d_cellSize;
                RealType p_wall = compute_fsi_wall_pressure_normal_gpu<RealType, IsMultiMaterial>(s_self, vw_x, vw_y, vw_z, geom_pool, ox, oy, oz, dir, n_out, z_c_self);
                lf[1 + dir] += A_wall * p_wall;
                lf[4]       += A_wall * p_wall * vn_wall;
                if constexpr (IsMultiMaterial) {
                    lf[5] += A_wall * s_self.alpha1 * vn_wall;
                    lf[6] += A_wall * s_self.alpha2 * vn_wall;
                    lf[9] += A_wall * vn_wall;
                }
            }
        }
    } else {
        bool solid_L = false;
        bool solid_R = false;
        if (is_near_boundary && geom_pool) {
            solid_L = is_solid_cell_gpu(geom_pool, gx_L, gy_L, gz_L);
            solid_R = is_solid_cell_gpu(geom_pool, gx_R, gy_R, gz_R);
        }

        if (solid_L && solid_R) {
            // Keep zero flux lf[0..9] = 0
        } else if (solid_L || solid_R) {
            // Strictly impermeable, Galilean-invariant, Discrete-GCL-preserving moving slip-wall flux
            // with one-sided Rankine-Hugoniot compressive shock impedance:
            // - Zero mass and species flux (flx[0] = 0, flx[5..9] = 0) prevents density drainage into solid cells.
            // - Exact Cartesian wall velocity vn_wall = v_s[dir] with mechanical work p_wall * vn_wall preserves
            //   Discrete GCL on co-moving cavities and eliminates cross-axis tangential jet feedback.
            // - When v_rel > 0 (advancing wall / fluid approaching wall): exact 1D Rankine-Hugoniot piston shock
            //   pressure p_wall = p_f + rho_f * w_s * v_rel produces physical supersonic bow shocks and blast waves.
            // - When v_rel <= 0 (receding wall / wake): p_wall = s_fluid.p avoids artificial vacuum suction against
            //   flx[0] = 0 while p_wall * vn_wall performs physical expansion work in the wake.
            int gx_f = solid_L ? gx_R : gx_L;
            int gy_f = solid_L ? gy_R : gy_L;
            int gz_f = solid_L ? gz_R : gz_L;
            int gx_s = solid_L ? gx_L : gx_R;
            int gy_s = solid_L ? gy_L : gy_R;
            int gz_s = solid_L ? gz_L : gz_R;
            auto s_fluid = sample_gpu_raw<RealType, IsMultiMaterial, TileType>(states, gx_f, gy_f, gz_f);
            auto s_solid_raw = sample_gpu_raw<RealType, IsMultiMaterial, TileType>(states, gx_s, gy_s, gz_s);

            RealType vn_wall = (dir == 0) ? s_solid_raw.ux
                             : ((dir == 1) ? s_solid_raw.uy : s_solid_raw.uz);
            RealType vn_fluid = (dir == 0) ? s_fluid.ux
                              : ((dir == 1) ? s_fluid.uy : s_fluid.uz);
            RealType n_out = solid_R ? (RealType)1.0 : (RealType)(-1.0);
            RealType v_rel = n_out * (vn_fluid - vn_wall);

            RealType p_wall = s_fluid.p;
            if (v_rel > (RealType)0.0) {
                RealType rho_f = fmax((RealType)1e-6, s_fluid.rho);
                RealType p_f = fmax((RealType)1.0, s_fluid.p);
                RealType g_eff = (RealType)d_gamma;
                RealType c_f = sqrt(g_eff * p_f / rho_f);
                if constexpr (IsMultiMaterial) {
                    if (d_isWater) {
                        c_f = MultiMat::getMixtureSoundSpeedTait<RealType>(
                            s_fluid.p, rho_f, s_fluid.alpha1, s_fluid.alpha2, s_fluid.arho1, s_fluid.arho2,
                            d_taitParams, d_products, d_unreacted);
                    } else {
                        c_f = MultiMat::getMixtureSoundSpeed<RealType>(
                            s_fluid.p, rho_f, s_fluid.alpha1, s_fluid.alpha2, s_fluid.arho1, s_fluid.arho2,
                            g_eff, d_products, d_unreacted);
                    }
                    c_f = fmax((RealType)1.0, c_f);
                }
                RealType b_sh = (RealType)0.25 * (g_eff + (RealType)1.0) * v_rel;
                RealType w_s = b_sh + sqrt(b_sh * b_sh + c_f * c_f);
                p_wall = s_fluid.p + rho_f * w_s * v_rel;
            }

            lf[1 + dir] = p_wall;
            lf[4]       = p_wall * vn_wall;
        } else {
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
            reconstruct_gpu<RealType, IsMultiMaterial, TileType>(states, geom_pool, gx_R, gy_R, gz_R, dir, sL, sR, qx, qy, qz, is_near_boundary, force_first, force_first, spatial_order);
            RealType z_cL = (RealType)d_zmin + ((RealType)gz_L + (RealType)0.5) * (RealType)d_cellSize;
            RealType z_cR = (RealType)d_zmin + ((RealType)gz_R + (RealType)0.5) * (RealType)d_cellSize;
            int q = (dir == 0 ? qx : (dir == 1 ? qy : qz));
            int g_R = (dir == 0 ? gx_R : (dir == 1 ? gy_R : gz_R));
            int eff_side = (q < g_R) ? -1 : 1;
            dispatch_riemann_flux_gpu<RealType, IsMultiMaterial>(sL, sR, lf, dir, z_cL, z_cR, eff_side);
        }
    }

    #pragma unroll
    for (int v = 0; v < n_flx; ++v) flx[v] = lf[v];
}

template <typename RealType, bool IsMultiMaterial, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ __noinline__ void reconstruct_interior_gpu(
    const TileType* states,
    int gx, int gy, int gz,
    int dir,
    GPUCellStateT<RealType, IsMultiMaterial>& sL, GPUCellStateT<RealType, IsMultiMaterial>& sR,
    int spatial_order = 2
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
        if (alpha > (RealType)0.05) return 3; // Dominant energetic material
        if (is_cell_soil(rho, z, alpha)) return 2;
        if (is_cell_water(rho, z, alpha)) return 1;
        return 0; // Gas (Air / Detonation Products)
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

    bool is_mat_interface = d_stratParams.enabled && (
        (matM1 == 2 || matP0 == 2) ? (matM1 != matP0) :
        (matM1 != matP0 && matM1 != 3 && matP0 != 3)
    );
    bool same_mat_L = (matM2 == matM1);
    bool same_mat_R = (matP1 == matP0);

    auto reconstruct_channel = [&](RealType vM2, RealType vM1, RealType vP0, RealType vP1, RealType& vL, RealType& vR, bool is_pressure = false) {
        if (is_mat_interface) {
            if (is_pressure && dir == 2 && d_has_gravity) {
                vL = vM1 + (RealType)0.5 * sM1.rho * (RealType)d_gravity_z * (RealType)d_cellSize;
                vR = vP0 - (RealType)0.5 * sP0.rho * (RealType)d_gravity_z * (RealType)d_cellSize;
            } else {
                vL = vM1;
                vR = vP0;
            }
        } else if (spatial_order == 1) {
            vL = vM1;
            vR = vP0;
        } else {
            RealType dC = vP0 - vM1;
            RealType dL = same_mat_L ? (vM1 - vM2) : (RealType)0.0;
            RealType dR = same_mat_R ? (vP1 - vP0) : (RealType)0.0;

            if (spatial_order == 3) {
                vL = same_mat_L ? weno3_gpu(vM2, vM1, vP0) : (vM1 + (RealType)0.5 * minmod_gpu(dL, dC));
                vR = same_mat_R ? weno3_gpu(vP1, vP0, vM1) : (vP0 - (RealType)0.5 * minmod_gpu(dC, dR));
            } else { // Order 2 or default
                vL = vM1 + (RealType)0.5 * vanleer_gpu(dL, dC);
                vR = vP0 - (RealType)0.5 * vanleer_gpu(dC, dR);
            }
        }
    };

    if constexpr (!IsMultiMaterial) {
        if (!d_stratParams.enabled && !d_isWater && spatial_order == 2) {
            reconstruct_char_ideal_gpu<RealType>(sM2, sM1, sP0, sP1, dir, (RealType)d_gamma, false, false, sL, sR);
        } else {
            reconstruct_channel(sM2.ux, sM1.ux, sP0.ux, sP1.ux, sL.ux, sR.ux);
            reconstruct_channel(sM2.uy, sM1.uy, sP0.uy, sP1.uy, sL.uy, sR.uy);
            reconstruct_channel(sM2.uz, sM1.uz, sP0.uz, sP1.uz, sL.uz, sR.uz);
            reconstruct_channel(sM2.p, sM1.p, sP0.p, sP1.p, sL.p, sR.p, true);
            sL.p = fmax((RealType)1e-7, sL.p);
            sR.p = fmax((RealType)1e-7, sR.p);
        }
    } else {
        reconstruct_channel(sM2.ux, sM1.ux, sP0.ux, sP1.ux, sL.ux, sR.ux);
        reconstruct_channel(sM2.uy, sM1.uy, sP0.uy, sP1.uy, sL.uy, sR.uy);
        reconstruct_channel(sM2.uz, sM1.uz, sP0.uz, sP1.uz, sL.uz, sR.uz);
        reconstruct_channel(sM2.p, sM1.p, sP0.p, sP1.p, sL.p, sR.p, true);
        sL.p = fmax((RealType)1e-7, sL.p);
        sR.p = fmax((RealType)1e-7, sR.p);
    }

    if constexpr (IsMultiMaterial) {
        // --- 1. Reconstruct Volume Fractions with THINC-BVD ---
        RealType poly_M1_R_a1 = sM1.alpha1 + (RealType)0.5 * minmod_gpu(sM1.alpha1 - sM2.alpha1, sP0.alpha1 - sM1.alpha1);
        RealType poly_P0_L_a1 = sP0.alpha1 - (RealType)0.5 * minmod_gpu(sP0.alpha1 - sM1.alpha1, sP1.alpha1 - sP0.alpha1);
        poly_M1_R_a1 = fmax((RealType)0.0, fmin((RealType)1.0, poly_M1_R_a1));
        poly_P0_L_a1 = fmax((RealType)0.0, fmin((RealType)1.0, poly_P0_L_a1));

        RealType thinc_M1_L_a1, thinc_M1_R_a1;
        bool ok_M1_a1 = thinc_reconstruct_cell_gpu(sM2.alpha1, sM1.alpha1, sP0.alpha1, thinc_M1_L_a1, thinc_M1_R_a1, (RealType)1.6);
        RealType thinc_P0_L_a1, thinc_P0_R_a1;
        bool ok_P0_a1 = thinc_reconstruct_cell_gpu(sM1.alpha1, sP0.alpha1, sP1.alpha1, thinc_P0_L_a1, thinc_P0_R_a1, (RealType)1.6);

        RealType jump_poly_a1 = fabs(poly_P0_L_a1 - poly_M1_R_a1);
        RealType cand_P0_a1 = ok_P0_a1 ? thinc_P0_L_a1 : poly_P0_L_a1;
        RealType cand_M1_a1 = ok_M1_a1 ? thinc_M1_R_a1 : poly_M1_R_a1;
        RealType jump_thinc_a1 = fabs(cand_P0_a1 - cand_M1_a1);

        sL.alpha1 = (ok_M1_a1 && jump_thinc_a1 < jump_poly_a1) ? thinc_M1_R_a1 : poly_M1_R_a1;
        sR.alpha1 = (ok_P0_a1 && jump_thinc_a1 < jump_poly_a1) ? thinc_P0_L_a1 : poly_P0_L_a1;

        RealType poly_M1_R_a2 = sM1.alpha2 + (RealType)0.5 * minmod_gpu(sM1.alpha2 - sM2.alpha2, sP0.alpha2 - sM1.alpha2);
        RealType poly_P0_L_a2 = sP0.alpha2 - (RealType)0.5 * minmod_gpu(sP0.alpha2 - sM1.alpha2, sP1.alpha2 - sP0.alpha2);
        poly_M1_R_a2 = fmax((RealType)0.0, fmin((RealType)1.0, poly_M1_R_a2));
        poly_P0_L_a2 = fmax((RealType)0.0, fmin((RealType)1.0, poly_P0_L_a2));

        RealType thinc_M1_L_a2, thinc_M1_R_a2;
        bool ok_M1_a2 = thinc_reconstruct_cell_gpu(sM2.alpha2, sM1.alpha2, sP0.alpha2, thinc_M1_L_a2, thinc_M1_R_a2, (RealType)1.6);
        RealType thinc_P0_L_a2, thinc_P0_R_a2;
        bool ok_P0_a2 = thinc_reconstruct_cell_gpu(sM1.alpha2, sP0.alpha2, sP1.alpha2, thinc_P0_L_a2, thinc_P0_R_a2, (RealType)1.6);

        RealType jump_poly_a2 = fabs(poly_P0_L_a2 - poly_M1_R_a2);
        RealType cand_P0_a2 = ok_P0_a2 ? thinc_P0_L_a2 : poly_P0_L_a2;
        RealType cand_M1_a2 = ok_M1_a2 ? thinc_M1_R_a2 : poly_M1_R_a2;
        RealType jump_thinc_a2 = fabs(cand_P0_a2 - cand_M1_a2);

        sL.alpha2 = (ok_M1_a2 && jump_thinc_a2 < jump_poly_a2) ? thinc_M1_R_a2 : poly_M1_R_a2;
        sR.alpha2 = (ok_P0_a2 && jump_thinc_a2 < jump_poly_a2) ? thinc_P0_L_a2 : poly_P0_L_a2;

        sL.alpha1 = fmax((RealType)0.0, fmin((RealType)1.0, sL.alpha1));
        sL.alpha2 = fmax((RealType)0.0, fmin((RealType)(1.0 - sL.alpha1), sL.alpha2));
        sR.alpha1 = fmax((RealType)0.0, fmin((RealType)1.0, sR.alpha1));
        sR.alpha2 = fmax((RealType)0.0, fmin((RealType)(1.0 - sR.alpha1), sR.alpha2));

        // --- 2. Intrinsic Phase Densities & Abgrall Invariance ---
        auto get_phase_densities = [&](const GPUCellStateT<RealType, IsMultiMaterial>& cell, RealType z_c, RealType& r1, RealType& r2, RealType& r0) {
            r1 = (cell.alpha1 > (RealType)1e-5) ? (cell.arho1 / cell.alpha1) : (RealType)d_products.rho0;
            r2 = (cell.alpha2 > (RealType)1e-5) ? (cell.arho2 / cell.alpha2) : (RealType)d_unreacted.rho0;
            RealType a0 = (RealType)1.0 - cell.alpha1 - cell.alpha2;
            if (a0 > (RealType)1e-5) {
                r0 = fmax((RealType)1e-7, (cell.rho - cell.arho1 - cell.arho2) / a0);
            } else {
                r0 = is_cell_water(cell.rho, z_c) ? (RealType)d_taitParams.rho0 : (RealType)d_ambient_rho;
            }
        };

        RealType r1_M2, r2_M2, r0_M2;
        RealType r1_M1, r2_M1, r0_M1;
        RealType r1_P0, r2_P0, r0_P0;
        RealType r1_P1, r2_P1, r0_P1;

        get_phase_densities(sM2, z_cM2, r1_M2, r2_M2, r0_M2);
        get_phase_densities(sM1, z_cL,  r1_M1, r2_M1, r0_M1);
        get_phase_densities(sP0, z_cR,  r1_P0, r2_P0, r0_P0);
        get_phase_densities(sP1, z_cP1, r1_P1, r2_P1, r0_P1);

        RealType r0_L, r0_R;
        reconstruct_channel(r0_M2, r0_M1, r0_P0, r0_P1, r0_L, r0_R);
        r0_L = fmax((RealType)1e-7, r0_L);
        r0_R = fmax((RealType)1e-7, r0_R);

        RealType r1_L, r1_R;
        reconstruct_channel(r1_M2, r1_M1, r1_P0, r1_P1, r1_L, r1_R);
        r1_L = fmax((RealType)1e-7, r1_L);
        r1_R = fmax((RealType)1e-7, r1_R);

        RealType r2_L, r2_R;
        reconstruct_channel(r2_M2, r2_M1, r2_P0, r2_P1, r2_L, r2_R);
        r2_L = fmax((RealType)1e-7, r2_L);
        r2_R = fmax((RealType)1e-7, r2_R);

        sL.arho1 = sL.alpha1 * r1_L;
        sL.arho2 = sL.alpha2 * r2_L;
        RealType a0_L = fmax((RealType)0.0, (RealType)1.0 - sL.alpha1 - sL.alpha2);
        sL.rho = sL.arho1 + sL.arho2 + a0_L * r0_L;
        sL.rho = fmax((RealType)1e-7, sL.rho);

        sR.arho1 = sR.alpha1 * r1_R;
        sR.arho2 = sR.alpha2 * r2_R;
        RealType a0_R = fmax((RealType)0.0, (RealType)1.0 - sR.alpha1 - sR.alpha2);
        sR.rho = sR.arho1 + sR.arho2 + a0_R * r0_R;
        sR.rho = fmax((RealType)1e-7, sR.rho);
    } else {
        if (d_stratParams.enabled || d_isWater || spatial_order != 2) {
            reconstruct_channel(sM2.rho, sM1.rho, sP0.rho, sP1.rho, sL.rho, sR.rho);
            sL.rho = fmax((RealType)1e-7, sL.rho);
            sR.rho = fmax((RealType)1e-7, sR.rho);
        }
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

template <typename RealType, bool IsMultiMaterial, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ __noinline__ void get_face_flux_interior_gpu(
    const TileType* states,
    int gx_R, int gy_R, int gz_R,
    int dir, RealType* flx,
    int side = 0,
    int spatial_order = 2
) {
    int dz = (dir == 2 ? 1 : 0);
    int gz_L = gz_R - dz;
    RealType z_cL = (RealType)d_zmin + ((RealType)gz_L + (RealType)0.5) * (RealType)d_cellSize;
    RealType z_cR = (RealType)d_zmin + ((RealType)gz_R + (RealType)0.5) * (RealType)d_cellSize;
    GPUCellStateT<RealType, IsMultiMaterial> sL, sR;
    reconstruct_interior_gpu<RealType, IsMultiMaterial, TileType>(states, gx_R, gy_R, gz_R, dir, sL, sR, spatial_order);
    dispatch_riemann_flux_gpu<RealType, IsMultiMaterial>(sL, sR, flx, dir, z_cL, z_cR, side);
}

template <typename RealType, int Dir>
__device__ inline void reconstruct_fluxes_fused_dir_shared(
    const RealType sh_rho[12][12][13],
    const RealType sh_ux[12][12][13],
    const RealType sh_uy[12][12][13],
    const RealType sh_uz[12][12][13],
    const RealType sh_p[12][12][13],
    int lx, int ly, int lz,
    int gz,
    RealType* flxL, RealType* flxR,
    int spatial_order = 2
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
        if (spatial_order == 1) {
            vL_L = v1;
            vR_L = v2;
            vL_R = v2;
            vR_R = v3;
        } else if (spatial_order == 3) {
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

    if (d_fluxScheme == 2) {
        getHLLCFluxGPU<RealType, false>(sL_L, sR_L, flxL, Dir, (RealType)d_gamma);
        getHLLCFluxGPU<RealType, false>(sL_R, sR_R, flxR, Dir, (RealType)d_gamma);
    } else if (d_useAUSM) {
        getAUSMPlusFluxGPU<RealType, false>(sL_L, sR_L, flxL, Dir, (RealType)d_gamma);
        getAUSMPlusFluxGPU<RealType, false>(sL_R, sR_R, flxR, Dir, (RealType)d_gamma);
    } else {
        getRusanovFluxGPU<RealType, false>(sL_L, sR_L, flxL, Dir, (RealType)d_gamma);
        getRusanovFluxGPU<RealType, false>(sL_R, sR_R, flxR, Dir, (RealType)d_gamma);
    }
}

template <typename RealType, int Dir>
__device__ inline void reconstruct_interior_shared(
    const RealType sh_rho[12][12][13],
    const RealType sh_ux[12][12][13],
    const RealType sh_uy[12][12][13],
    const RealType sh_uz[12][12][13],
    const RealType sh_p[12][12][13],
    int lx, int ly, int lz,
    int offset,
    int gz,
    RealType* flx,
    int spatial_order = 2
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
        if (spatial_order == 1) {
            vL = vM1;
            vR = vP0;
        } else if (spatial_order == 3) {
            vL = weno3_gpu(vM2, vM1, vP0);
            vR = weno3_gpu(vP1, vP0, vM1);
        } else { // Order 2
            RealType dL = vM1 - vM2;
            RealType dC = vP0 - vM1;
            RealType dR = vP1 - vP0;
            vL = vM1 + (RealType)0.5 * vanleer_gpu(dL, dC);
            vR = vP0 - (RealType)0.5 * vanleer_gpu(dC, dR);
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

    if (d_fluxScheme == 2) getHLLCFluxGPU<RealType, false>(sL, sR, flx, Dir, (RealType)d_gamma);
    else if (d_useAUSM) getAUSMPlusFluxGPU<RealType, false>(sL, sR, flx, Dir, (RealType)d_gamma);
    else getRusanovFluxGPU<RealType, false>(sL, sR, flx, Dir, (RealType)d_gamma);
}

template <typename RealType, bool IsMultiMaterial, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ inline void convert_conservative_to_primitive_gpu(
    ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U,
    TileType* __restrict__ states,
    const GeometryTile3D* __restrict__ geom,
    int t_idx, int c_idx,
    RealType dt,
    const SolidVelocityTile3D* d_solid_vel = nullptr
);

template <typename RealType, bool IsMultiMaterial, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
__device__ inline void apply_flux_update_gpu(
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
__device__ inline void apply_flux_update_gpu_accumulated(
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

template <typename RealType, bool IsMultiMaterial, typename TileType = PrimitiveTile3D<RealType, IsMultiMaterial>>
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
    const SolidVelocityTile3D* d_solid_vel = nullptr,
    int spatial_order = 2,
    const FluidFractionTile3D<RealType>* __restrict__ fluid_frac = nullptr,
    ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ fsi_Q_tmp = nullptr
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

        bool used_shared_path = false;
        if constexpr (!IsMultiMaterial && sizeof(RealType) == 4) {
            if (!d_stratParams.enabled) {
                used_shared_path = true;
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
                    reconstruct_fluxes_fused_dir_shared<RealType, 0>(sh_rho, sh_ux, sh_uy, sh_uz, sh_p, lx, ly, lz, gz, fL, fR, spatial_order);
                    #pragma unroll
                    for (int c = 0; c < 5; ++c) {
                        du[c] += (fR[c] - fL[c]);
                    }

                    // --- Y Direction ---
                    reconstruct_fluxes_fused_dir_shared<RealType, 1>(sh_rho, sh_ux, sh_uy, sh_uz, sh_p, lx, ly, lz, gz, fL, fR, spatial_order);
                    #pragma unroll
                    for (int c = 0; c < 5; ++c) {
                        du[c] += (fR[c] - fL[c]);
                    }

                    // --- Z Direction ---
                    reconstruct_fluxes_fused_dir_shared<RealType, 2>(sh_rho, sh_ux, sh_uy, sh_uz, sh_p, lx, ly, lz, gz, fL, fR, spatial_order);
                    #pragma unroll
                    for (int c = 0; c < 5; ++c) {
                        du[c] += (fR[c] - fL[c]);
                    }

                    apply_flux_update_gpu_accumulated<RealType, IsMultiMaterial, TileType>(U, U_prev, t_idx, c_idx, dt_dx, du, states, rk_stage, geom, perform_primitive_update, dt_for_peaks, d_solid_vel);
                }
            }
        }
        if (!used_shared_path) {
            if (gx < d_nx && gy < d_ny && gz < d_nz) {
                RealType fL_x[10], fR_x[10];
                RealType fL_y[10], fR_y[10];
                RealType fL_z[10], fR_z[10];

                // --- X Direction ---
                get_face_flux_interior_gpu<RealType, IsMultiMaterial, TileType>(states, gx, gy, gz, 0, fL_x, 1, spatial_order);
                get_face_flux_interior_gpu<RealType, IsMultiMaterial, TileType>(states, gx + 1, gy, gz, 0, fR_x, -1, spatial_order);

                // --- Y Direction ---
                get_face_flux_interior_gpu<RealType, IsMultiMaterial, TileType>(states, gx, gy, gz, 1, fL_y, 1, spatial_order);
                get_face_flux_interior_gpu<RealType, IsMultiMaterial, TileType>(states, gx, gy + 1, gz, 1, fR_y, -1, spatial_order);

                // --- Z Direction ---
                get_face_flux_interior_gpu<RealType, IsMultiMaterial, TileType>(states, gx, gy, gz, 2, fL_z, 1, spatial_order);
                get_face_flux_interior_gpu<RealType, IsMultiMaterial, TileType>(states, gx, gy, gz + 1, 2, fR_z, -1, spatial_order);

                apply_flux_update_gpu<RealType, IsMultiMaterial, TileType>(U, U_prev, t_idx, c_idx, dt_dx, fL_x, fR_x, fL_y, fR_y, fL_z, fR_z, states, rk_stage, geom, perform_primitive_update, dt_for_peaks, d_solid_vel);
            }
        }
    } else {
        if (gx < d_nx && gy < d_ny && gz < d_nz) {
            if (fsi_Q_tmp) {
                fsi_Q_tmp[t_idx].rho[c_idx]   = (RealType)0.0;
                fsi_Q_tmp[t_idx].rhoux[c_idx] = (RealType)0.0;
                fsi_Q_tmp[t_idx].rhouy[c_idx] = (RealType)0.0;
                fsi_Q_tmp[t_idx].rhouz[c_idx] = (RealType)0.0;
                fsi_Q_tmp[t_idx].E[c_idx]     = (RealType)0.0;
                if constexpr (IsMultiMaterial) {
                    fsi_Q_tmp[t_idx].alpha1[c_idx] = (RealType)0.0;
                    fsi_Q_tmp[t_idx].alpha2[c_idx] = (RealType)0.0;
                    fsi_Q_tmp[t_idx].arho1[c_idx]  = (RealType)0.0;
                    fsi_Q_tmp[t_idx].arho2[c_idx]  = (RealType)0.0;
                }
            }

            RealType a_self = fluid_frac ? get_alpha_f_gpu(fluid_frac, geom, gx, gy, gz) : (RealType)1.0;
            bool is_boundary = (fluid_frac && a_self <= (RealType)0.0) ||
                               (s_is_near_boundary && is_solid_cell_gpu(geom, gx, gy, gz));

            if (!is_boundary) {
                RealType invDx = (RealType)1.0 / (RealType)d_cellSize;
                RealType dt_dx = dt * invDx;

                RealType fL_x[10], fR_x[10];
                RealType fL_y[10], fR_y[10];
                RealType fL_z[10], fR_z[10];

                // --- X Direction ---
                get_face_flux_gpu<RealType, IsMultiMaterial, TileType>(states, geom, gx - 1, gy, gz, gx, gy, gz, 0, fL_x, gx, gy, gz, s_is_near_boundary, spatial_order, fluid_frac, d_solid_vel);
                get_face_flux_gpu<RealType, IsMultiMaterial, TileType>(states, geom, gx, gy, gz, gx + 1, gy, gz, 0, fR_x, gx, gy, gz, s_is_near_boundary, spatial_order, fluid_frac, d_solid_vel);

                // --- Y Direction ---
                get_face_flux_gpu<RealType, IsMultiMaterial, TileType>(states, geom, gx, gy - 1, gz, gx, gy, gz, 1, fL_y, gx, gy, gz, s_is_near_boundary, spatial_order, fluid_frac, d_solid_vel);
                get_face_flux_gpu<RealType, IsMultiMaterial, TileType>(states, geom, gx, gy, gz, gx, gy + 1, gz, 1, fR_y, gx, gy, gz, s_is_near_boundary, spatial_order, fluid_frac, d_solid_vel);

                // --- Z Direction ---
                get_face_flux_gpu<RealType, IsMultiMaterial, TileType>(states, geom, gx, gy, gz - 1, gx, gy, gz, 2, fL_z, gx, gy, gz, s_is_near_boundary, spatial_order, fluid_frac, d_solid_vel);
                get_face_flux_gpu<RealType, IsMultiMaterial, TileType>(states, geom, gx, gy, gz, gx, gy, gz + 1, 2, fR_z, gx, gy, gz, s_is_near_boundary, spatial_order, fluid_frac, d_solid_vel);

                if (!fluid_frac) {
                    apply_flux_update_gpu<RealType, IsMultiMaterial, TileType>(U, U_prev, t_idx, c_idx, dt_dx, fL_x, fR_x, fL_y, fR_y, fL_z, fR_z, states, rk_stage, geom, perform_primitive_update, dt_for_peaks, d_solid_vel);
                } else {
                    RealType dQ_rho   = -dt_dx * ((fR_x[0] - fL_x[0]) + (fR_y[0] - fL_y[0]) + (fR_z[0] - fL_z[0]));
                    RealType dQ_rhoux = -dt_dx * ((fR_x[1] - fL_x[1]) + (fR_y[1] - fL_y[1]) + (fR_z[1] - fL_z[1]));
                    RealType dQ_rhouy = -dt_dx * ((fR_x[2] - fL_x[2]) + (fR_y[2] - fL_y[2]) + (fR_z[2] - fL_z[2]));
                    RealType dQ_rhouz = -dt_dx * ((fR_x[3] - fL_x[3]) + (fR_y[3] - fL_y[3]) + (fR_z[3] - fL_z[3]));
                    RealType dQ_E     = -dt_dx * ((fR_x[4] - fL_x[4]) + (fR_y[4] - fL_y[4]) + (fR_z[4] - fL_z[4]));

                    RealType w_self = (a_self < (RealType)FSI_ALPHA_CUT) ? (a_self / (RealType)FSI_ALPHA_CUT) : (RealType)1.0;
                    RealType scale_self = w_self / a_self;
                    RealType w_spill = (RealType)1.0 - w_self;

                    U[t_idx].rho[c_idx]   += scale_self * dQ_rho;
                    U[t_idx].rhoux[c_idx] += scale_self * dQ_rhoux;
                    U[t_idx].rhouy[c_idx] += scale_self * dQ_rhouy;
                    U[t_idx].rhouz[c_idx] += scale_self * dQ_rhouz;
                    U[t_idx].E[c_idx]     += scale_self * dQ_E;

                    if (d_has_gravity) {
                        U[t_idx].rhoux[c_idx] += dt * U[t_idx].rho[c_idx] * (RealType)d_gravity_x;
                        U[t_idx].rhouy[c_idx] += dt * U[t_idx].rho[c_idx] * (RealType)d_gravity_y;
                        U[t_idx].rhouz[c_idx] += dt * U[t_idx].rho[c_idx] * (RealType)d_gravity_z;
                        U[t_idx].E[c_idx]     += dt * (U[t_idx].rhoux[c_idx] * (RealType)d_gravity_x +
                                                       U[t_idx].rhouy[c_idx] * (RealType)d_gravity_y +
                                                       U[t_idx].rhouz[c_idx] * (RealType)d_gravity_z);
                    }

                    if (fsi_Q_tmp && w_spill > (RealType)0.0) {
                        fsi_Q_tmp[t_idx].rho[c_idx]   = w_spill * dQ_rho;
                        fsi_Q_tmp[t_idx].rhoux[c_idx] = w_spill * dQ_rhoux;
                        fsi_Q_tmp[t_idx].rhouy[c_idx] = w_spill * dQ_rhouy;
                        fsi_Q_tmp[t_idx].rhouz[c_idx] = w_spill * dQ_rhouz;
                        fsi_Q_tmp[t_idx].E[c_idx]     = w_spill * dQ_E;
                    }

                    if constexpr (IsMultiMaterial) {
                        RealType du_a1  = (fR_x[5] - fL_x[5]) + (fR_y[5] - fL_y[5]) + (fR_z[5] - fL_z[5]);
                        RealType du_a2  = (fR_x[6] - fL_x[6]) + (fR_y[6] - fL_y[6]) + (fR_z[6] - fL_z[6]);
                        RealType du_ar1 = (fR_x[7] - fL_x[7]) + (fR_y[7] - fL_y[7]) + (fR_z[7] - fL_z[7]);
                        RealType du_ar2 = (fR_x[8] - fL_x[8]) + (fR_y[8] - fL_y[8]) + (fR_z[8] - fL_z[8]);
                        RealType div_u  = (fR_x[9] - fL_x[9]) + (fR_y[9] - fL_y[9]) + (fR_z[9] - fL_z[9]);

                        RealType dQ_a1  = -dt_dx * (du_a1 - states[t_idx].alpha1[c_idx] * div_u);
                        RealType dQ_a2  = -dt_dx * (du_a2 - states[t_idx].alpha2[c_idx] * div_u);
                        RealType dQ_ar1 = -dt_dx * du_ar1;
                        RealType dQ_ar2 = -dt_dx * du_ar2;

                        U[t_idx].alpha1[c_idx] += scale_self * dQ_a1;
                        U[t_idx].alpha2[c_idx] += scale_self * dQ_a2;
                        U[t_idx].arho1[c_idx]  += scale_self * dQ_ar1;
                        U[t_idx].arho2[c_idx]  += scale_self * dQ_ar2;

                        if (fsi_Q_tmp && w_spill > (RealType)0.0) {
                            fsi_Q_tmp[t_idx].alpha1[c_idx] = w_spill * dQ_a1;
                            fsi_Q_tmp[t_idx].alpha2[c_idx] = w_spill * dQ_a2;
                            fsi_Q_tmp[t_idx].arho1[c_idx]  = w_spill * dQ_ar1;
                            fsi_Q_tmp[t_idx].arho2[c_idx]  = w_spill * dQ_ar2;
                        }
                    }

                    if (perform_primitive_update) {
                        ConservativeTile3D<RealType, IsMultiMaterial>* target_U = (rk_stage == 2) ? U_prev : U;
                        convert_conservative_to_primitive_gpu<RealType, IsMultiMaterial>(target_U, states, geom, t_idx, c_idx, dt_for_peaks, d_solid_vel);
                    }
                }
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
__device__ inline void convert_conservative_to_primitive_gpu(
    ConservativeTile3D<RealType, IsMultiMaterial>* __restrict__ U,
    TileType* __restrict__ states,
    const GeometryTile3D* __restrict__ geom,
    int t_idx, int c_idx,
    RealType dt,
    const SolidVelocityTile3D* d_solid_vel
) {
    if (geom && geom[t_idx].cells[c_idx].is_boundary) {
        if (d_solid_vel) {
            states[t_idx].ux[c_idx] = (RealType)d_solid_vel[t_idx].vx[c_idx];
            states[t_idx].uy[c_idx] = (RealType)d_solid_vel[t_idx].vy[c_idx];
            states[t_idx].uz[c_idx] = (RealType)d_solid_vel[t_idx].vz[c_idx];
        }
        return;
    }

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
        rho = fmax(u_rho, rho_min);
        U[t_idx].rho[c_idx] = rho;
        RealType inv_rho = (RealType)1.0 / rho;
        RealType vac_scale = (u_rho < rho_min) ? fmax((RealType)0.0, u_rho * ((RealType)1.0 / rho_min)) : (RealType)1.0;
        ux = (u_rhoux * inv_rho) * vac_scale;
        uy = (u_rhouy * inv_rho) * vac_scale;
        uz = (u_rhouz * inv_rho) * vac_scale;
        if (u_rho < rho_min) {
            U[t_idx].rhoux[c_idx] = rho * ux;
            U[t_idx].rhouy[c_idx] = rho * uy;
            U[t_idx].rhouz[c_idx] = rho * uz;
        }
        
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

        const RealType MAX_SPECIFIC_EINT = 1e10;
        RealType e_int_floor;
        RealType a_he_chk = (RealType)0.0;
        if constexpr (IsMultiMaterial) {
            a_he_chk = U[t_idx].alpha1[c_idx] + U[t_idx].alpha2[c_idx];
        }
        bool is_cell_water_or_soil = is_cell_soil(rho, z_c, a_he_chk) || is_cell_water(rho, z_c, a_he_chk);
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
            if (alpha1 < (RealType)1e-12) alpha1 = (RealType)0.0;
            if (alpha2 < (RealType)1e-12) alpha2 = (RealType)0.0;
            if (alpha1 + alpha2 > (RealType)1.0) {
                RealType sum = alpha1 + alpha2;
                alpha1 /= sum;
                alpha2 /= sum;
            }
            arho1 = fmax((RealType)0.0, fmin(rho, U[t_idx].arho1[c_idx]));
            arho2 = fmax((RealType)0.0, fmin(rho, U[t_idx].arho2[c_idx]));
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
                RealType p_cav_soil = (p0_soil > (RealType)0.0) ? (RealType)fmax((RealType)0.0, (RealType)d_stratParams.soil_p_cav) : (RealType)(d_stratParams.soil_p_cav != 0.0 ? d_stratParams.soil_p_cav : -1.0e5);
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
                RealType p_water_floor = (d_stratParams.enabled && d_stratParams.p_atm > 0.0) ? (RealType)fmax((RealType)0.0, (RealType)d_taitParams.p_cav) : (RealType)d_taitParams.p_cav;
                RealType p_floor = is_soil ? ((d_stratParams.p_atm > (RealType)0.0) ? (RealType)fmax((RealType)0.0, (RealType)d_stratParams.soil_p_cav) : (RealType)(d_stratParams.soil_p_cav != 0.0 ? d_stratParams.soil_p_cav : -1.0e5)) :
                                   (is_water ? p_water_floor : (RealType)100.0);
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
                RealType p_cav_soil = (p0_soil > (RealType)0.0) ? (RealType)fmax((RealType)0.0, (RealType)d_stratParams.soil_p_cav) : (RealType)(d_stratParams.soil_p_cav != 0.0 ? d_stratParams.soil_p_cav : -1.0e5);
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
                RealType p_water_floor = (d_stratParams.enabled && d_stratParams.p_atm > 0.0) ? (RealType)fmax((RealType)0.0, (RealType)d_taitParams.p_cav) : (RealType)d_taitParams.p_cav;
                RealType p_floor = is_soil ? ((d_stratParams.p_atm > (RealType)0.0) ? (RealType)fmax((RealType)0.0, (RealType)d_stratParams.soil_p_cav) : (RealType)(d_stratParams.soil_p_cav != 0.0 ? d_stratParams.soil_p_cav : -1.0e5)) :
                                   (is_water ? p_water_floor : (RealType)1e-8);
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

    if (d_zonalParams.enabled) {
        float dx_rel = static_cast<float>(x_c - d_zonalParams.center_x);
        float dy_rel = static_cast<float>(y_c - d_zonalParams.center_y);
        float dz_rel = static_cast<float>(z_c - d_zonalParams.center_z);
        float r = d_zonalParams.is_cylinder ? sqrtf(dx_rel * dx_rel + dy_rel * dy_rel) : sqrtf(dx_rel * dx_rel + dy_rel * dy_rel + dz_rel * dz_rel);
        if (r < static_cast<float>(d_zonalParams.sleeve_radius)) {
            return;
        }
    }

    RealType tmp_alpha1 = U[t_idx].alpha1[c_idx];
    RealType tmp_alpha2 = U[t_idx].alpha2[c_idx];
    RealType tmp_arho1 = U[t_idx].arho1[c_idx];
    RealType tmp_arho2 = U[t_idx].arho2[c_idx];

    RealType dF = MultiMat::computeProgrammedBurn<RealType>(
        (RealType)currentTime, dt, x_c, y_c, z_c,
        (RealType)d_det_vel, (RealType)d_detStartTime, (RealType)d_detX, (RealType)d_detY, (RealType)d_detZ,
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
        RealType arho0 = (RealType)0.0;
        if (d_stratParams.enabled) {
            // Atmospheric oxidizer (O2) only exists in gaseous air above the water surface
            if (z_c > (RealType)d_stratParams.water_surface_z && U[t_idx].rho[c_idx] < (RealType)300.0) {
                arho0 = fmax((RealType)0.0, U[t_idx].rho[c_idx] - tmp_arho1 - tmp_arho2);
            }
        } else if (!d_isWater) {
            // Free-air blast: ambient background fluid is atmospheric air
            arho0 = fmax((RealType)0.0, U[t_idx].rho[c_idx] - tmp_arho1 - tmp_arho2);
        }
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
    if constexpr (IsMultiMaterial) {
        U[t_idx].alpha1[c_idx] = alpha1;
        U[t_idx].alpha2[c_idx] = alpha2;
        U[t_idx].arho1[c_idx] = arho1;
        U[t_idx].arho2[c_idx] = arho2;
    }
}

template <typename RealType, bool IsMultiMaterial>
__device__ float get_value_by_qty(const PrimitiveTile3D<RealType, IsMultiMaterial>& tile, int c_idx, int qty_id, double z_c = 0.0) {
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
        if (d_stratParams.enabled) {
            if ((z_c > 0.0 && z_c <= (double)d_stratParams.water_surface_z) || tile.rho[c_idx] >= (RealType)300.0) {
                return 0.0f;
            }
            if constexpr (IsMultiMaterial) return (float)fmax((RealType)0.0, (RealType)1.0 - tile.alpha1[c_idx] - tile.alpha2[c_idx]);
            return 1.0f;
        }
        if (d_isWater && tile.rho[c_idx] >= (RealType)300.0) {
            return 0.0f;
        }
        if constexpr (IsMultiMaterial) return (float)fmax((RealType)0.0, (RealType)1.0 - tile.alpha1[c_idx] - tile.alpha2[c_idx]);
        return 1.0f;
    }
    if (qty_id == 8) return (float)tile.peak_overpressure[c_idx];
    if (qty_id == 9) return (float)tile.peak_impulse[c_idx];
    if (qty_id == 10) {
        RealType ke = (RealType)0.5 * tile.rho[c_idx] * (tile.ux[c_idx]*tile.ux[c_idx] + tile.uy[c_idx]*tile.uy[c_idx] + tile.uz[c_idx]*tile.uz[c_idx]);
        RealType total_E;
        if constexpr (IsMultiMaterial) {
            total_E = MultiMat::getMixtureEnergy<RealType>(tile.p[c_idx], tile.rho[c_idx], tile.alpha1[c_idx], tile.alpha2[c_idx], tile.arho1[c_idx], tile.arho2[c_idx], (RealType)d_gamma, d_products, d_unreacted) + ke;
        } else {
            total_E = tile.p[c_idx] / ((RealType)d_gamma - (RealType)1.0) + ke;
        }
        RealType e_int = (total_E - ke) / fmax((RealType)1e-6, tile.rho[c_idx]);
        if (d_stratParams.enabled) {
            RealType a_he = (RealType)0.0;
            if constexpr (IsMultiMaterial) a_he = tile.alpha1[c_idx] + tile.alpha2[c_idx];
            if (is_cell_soil(tile.rho[c_idx], z_c, a_he)) {
                return (float)d_stratParams.soil_temperature;
            }
            if (is_cell_water(tile.rho[c_idx], z_c, a_he)) {
                return (float)d_stratParams.water_temperature;
            }
            if constexpr (IsMultiMaterial) {
                if (tile.alpha1[c_idx] >= (RealType)0.02) {
                    return (float)fmax((RealType)200.0, e_int / (RealType)1000.0);
                }
            }
            return (float)fmax((RealType)200.0, e_int / (RealType)718.0);
        }
        if (d_isWater) {
            return (float)288.15;
        }
        RealType T_val = e_int / (RealType)718.0;
        return (float)fmax((RealType)200.0, T_val);
    }
    if (qty_id == 13) {
        if constexpr (IsMultiMaterial) {
            float a1 = (float)tile.alpha1[c_idx];
            float a2 = (float)tile.alpha2[c_idx];
            if (a2 >= 0.5f || (a2 >= 0.05f && a2 >= a1)) return 3.0f; // Solid HE
            if (a1 >= 0.02f || (tile.rho[c_idx] > 0.0f && tile.arho1[c_idx] / tile.rho[c_idx] >= 0.02f)) return 4.0f; // Detonation products
        }
        if (d_stratParams.enabled && tile.rho[c_idx] > 1600.0) return 2.0f; // Seabed Soil (nominal ~2000)
        if (tile.rho[c_idx] >= 300.0) return 1.0f;  // Water
        return 0.0f; // Air
    }
    return (float)tile.p[c_idx];
}

template <typename RealType, bool IsMultiMaterial>
__device__ float get_value_by_qty_struct(const GPUCellStateT<RealType, IsMultiMaterial>& tile, int qty_id, double z_c = 0.0) {
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
        if (d_stratParams.enabled) {
            if ((z_c > 0.0 && z_c <= (double)d_stratParams.water_surface_z) || tile.rho >= (RealType)300.0) {
                return 0.0f;
            }
            if constexpr (IsMultiMaterial) return (float)fmax((RealType)0.0, (RealType)1.0 - tile.alpha1 - tile.alpha2);
            return 1.0f;
        }
        if (d_isWater && tile.rho >= (RealType)300.0) {
            return 0.0f;
        }
        if constexpr (IsMultiMaterial) return (float)fmax((RealType)0.0, (RealType)1.0 - tile.alpha1 - tile.alpha2);
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
        if (d_stratParams.enabled) {
            RealType a_he = (RealType)0.0;
            if constexpr (IsMultiMaterial) a_he = tile.alpha1 + tile.alpha2;
            if (is_cell_soil(tile.rho, z_c, a_he)) {
                return (float)d_stratParams.soil_temperature;
            }
            if (is_cell_water(tile.rho, z_c, a_he)) {
                return (float)d_stratParams.water_temperature;
            }
            if constexpr (IsMultiMaterial) {
                if (tile.alpha1 >= (RealType)0.02) {
                    return (float)fmax((RealType)200.0, e_int / (RealType)1000.0);
                }
            }
            return (float)fmax((RealType)200.0, e_int / (RealType)718.0);
        }
        if (d_isWater) {
            return (float)288.15;
        }
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
            RealType arho0 = (RealType)0.0;
            if (d_stratParams.enabled) {
                if (z_c > (double)d_stratParams.water_surface_z && tile.rho < (RealType)300.0) {
                    arho0 = fmax((RealType)0.0, tile.rho - tile.arho1 - tile.arho2);
                }
            } else if (!d_isWater) {
                arho0 = fmax((RealType)0.0, tile.rho - tile.arho1 - tile.arho2);
            }
            if (arho0 <= (RealType)1e-5) return 0.0f;
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
            float a1 = (float)tile.alpha1;
            float a2 = (float)tile.alpha2;
            if (a2 >= 0.5f || (a2 >= 0.05f && a2 >= a1)) return 3.0f; // Solid HE
            if (a1 >= 0.02f || (tile.rho > 0.0f && tile.arho1 / tile.rho >= 0.02f)) return 4.0f; // Detonation products
        }
        if (d_stratParams.enabled && tile.rho > 1600.0) return 2.0f; // Seabed Soil (nominal ~2000)
        if (tile.rho >= 300.0) return 1.0f;  // Water
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
        int tz = t_idx / (d_ntx * d_nty);
        int lz = c_idx / 64;
        int gz = tz * 8 + lz;
        double z_c = (double)d_zmin + ((double)gz + 0.5) * (double)d_cellSize;
        val = get_value_by_qty<RealType, IsMultiMaterial>(states[t_idx], c_idx, qty_id, z_c);
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

    double z_c = zmin + ((double)gz + 0.5) * dx;
    RealType val = get_value_by_qty<RealType, IsMultiMaterial>(states[t_idx], c_idx, qty_id, z_c);
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
                if (sC.alpha2 >= 0.5f || (sC.alpha2 >= 0.05f && sC.alpha2 >= sC.alpha1)) {
                    mat_id = 3.0f; // Solid HE
                } else if (sC.alpha1 >= 0.02f || (sC.rho > 0.0f && sC.arho1 / sC.rho >= 0.02f)) {
                    mat_id = 4.0f; // Detonation Products
                } else if (is_cell_soil(sC.rho, z_c, sC.alpha1 + sC.alpha2)) {
                    mat_id = 2.0f; // Seabed Soil
                } else if (is_cell_water(sC.rho, z_c, sC.alpha1 + sC.alpha2)) {
                    mat_id = 1.0f; // Water
                } else {
                    mat_id = 0.0f; // Air
                }
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
            RealType a_he = (RealType)0.0;
            if constexpr (IsMultiMaterial) a_he = sC.alpha1 + sC.alpha2;
            data[i + j * w] = is_cell_water(sC.rho, z_c, a_he) ? 1.0f : 0.0f;
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
        double z_c = zmin + ((double)gz + 0.5) * dx;
        data[i + j * w] = get_value_by_qty_struct<RealType, IsMultiMaterial>(sC, qty_id, z_c);
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
                if (sC.alpha2 >= 0.5f || (sC.alpha2 >= 0.05f && sC.alpha2 >= sC.alpha1)) {
                    mat_id = 3.0f;
                } else if (sC.alpha1 >= 0.02f || (sC.rho > 0.0f && sC.arho1 / sC.rho >= 0.02f)) {
                    mat_id = 4.0f;
                } else if (is_cell_soil(sC.rho, z_c, sC.alpha1 + sC.alpha2)) {
                    mat_id = 2.0f;
                } else if (is_cell_water(sC.rho, z_c, sC.alpha1 + sC.alpha2)) {
                    mat_id = 1.0f;
                } else {
                    mat_id = 0.0f;
                }
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
            RealType a_he = (RealType)0.0;
            if constexpr (IsMultiMaterial) a_he = sC.alpha1 + sC.alpha2;
            data[out_idx] = is_cell_water(sC.rho, z_c, a_he) ? 1.0f : 0.0f;
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
                        double z_c = zmin + ((double)orig_z + 0.5) * dx;
                        GPUCellStateT<RealType, IsMultiMaterial> sC = sample_state_with_mirror_gpu<RealType, IsMultiMaterial>(states, geom, orig_x, orig_y, orig_z, xmin, ymin, zmin, dx);
                        data[out_idx] = get_value_by_qty_struct<RealType, IsMultiMaterial>(sC, qty_id, z_c);
                        return;
                    }
                }
                double z_c = zmin + ((double)orig_z + 0.5) * dx;
                GPUCellStateT<RealType, IsMultiMaterial> sC = sample_gpu_raw<RealType, IsMultiMaterial>(states, orig_x, orig_y, orig_z);
                data[out_idx] = get_value_by_qty_struct<RealType, IsMultiMaterial>(sC, qty_id, z_c);
                return;
            }
        }
        double z_c = zmin + ((double)target_z + 0.5) * dx;
        GPUCellStateT<RealType, IsMultiMaterial> sC = sample_state_with_mirror_gpu<RealType, IsMultiMaterial>(states, geom, target_x, target_y, target_z, xmin, ymin, zmin, dx);
        data[out_idx] = get_value_by_qty_struct<RealType, IsMultiMaterial>(sC, qty_id, z_c);
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

    // Eagerly allocate space-time predictor buffer so VRAM budgeting is deterministic at init time
    CHECK_CUDA(cudaMalloc(&d_states_pred, total_tiles * sizeof(PrimitivePredictorTile3D<RealType, IsMultiMaterial>)));
    CHECK_CUDA(cudaMemset(d_states_pred, 0, total_tiles * sizeof(PrimitivePredictorTile3D<RealType, IsMultiMaterial>)));
    d_dW_dt = nullptr;
    states_pred_synced = false;

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
    int fluxSchemeId = 0;
    CHECK_CUDA(cudaMemcpyToSymbol(d_useAUSM, &useAUSM, sizeof(bool)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_fluxScheme, &fluxSchemeId, sizeof(int)));
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
    if (d_fluid_frac_fsi) { cudaFree(d_fluid_frac_fsi); d_fluid_frac_fsi = nullptr; d_fluid_frac_fsi_capacity = 0; }
    if (d_fsi_Q_tmp) { cudaFree(d_fsi_Q_tmp); d_fsi_Q_tmp = nullptr; d_fsi_Q_tmp_capacity = 0; }
    if (d_fsi_drag_fsi) { cudaFree(d_fsi_drag_fsi); d_fsi_drag_fsi = nullptr; d_fsi_drag_fsi_capacity = 0; }
    if (d_fsi_part_forces) { cudaFree(d_fsi_part_forces); d_fsi_part_forces = nullptr; d_fsi_part_forces_capacity = 0; }
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

    if (d_fluid_frac_fsi) {
        size_t ff_bytes = total_tiles * sizeof(FluidFractionTile3D<RealType>);
        paged_fluid_frac.resize(total_tiles);
        CHECK_CUDA(cudaMemcpy(paged_fluid_frac.data(), d_fluid_frac_fsi, ff_bytes, cudaMemcpyDeviceToHost));
        has_paged_fluid_frac = true;
    } else {
        has_paged_fluid_frac = false;
    }

    if (d_fsi_drag_fsi) {
        size_t drag_bytes = total_tiles * sizeof(FluidDragTile3D);
        paged_fsi_drag.resize(total_tiles);
        CHECK_CUDA(cudaMemcpy(paged_fsi_drag.data(), d_fsi_drag_fsi, drag_bytes, cudaMemcpyDeviceToHost));
        has_paged_fsi_drag = true;
    } else {
        has_paged_fsi_drag = false;
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
    if (d_fluid_frac_fsi) { cudaFree(d_fluid_frac_fsi); d_fluid_frac_fsi = nullptr; d_fluid_frac_fsi_capacity = 0; }
    if (d_fsi_Q_tmp) { cudaFree(d_fsi_Q_tmp); d_fsi_Q_tmp = nullptr; d_fsi_Q_tmp_capacity = 0; }
    if (d_fsi_drag_fsi) { cudaFree(d_fsi_drag_fsi); d_fsi_drag_fsi = nullptr; d_fsi_drag_fsi_capacity = 0; }
    if (d_fsi_part_forces) { cudaFree(d_fsi_part_forces); d_fsi_part_forces = nullptr; d_fsi_part_forces_capacity = 0; }
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
    CHECK_CUDA(cudaMalloc(&d_states_pred, total_tiles * sizeof(PrimitivePredictorTile3D<RealType, IsMultiMaterial>)));
    if (spaceTimeScheme == SpaceTimeScheme3D::ADER_3) {
        CHECK_CUDA(cudaMalloc(&d_dW_dt, total_tiles * sizeof(PrimitivePredictorTile3D<RealType, IsMultiMaterial>)));
        CHECK_CUDA(cudaMemset(d_dW_dt, 0, total_tiles * sizeof(PrimitivePredictorTile3D<RealType, IsMultiMaterial>)));
    }

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
    if (has_paged_fluid_frac) {
        size_t ff_bytes = total_tiles * sizeof(FluidFractionTile3D<RealType>);
        CHECK_CUDA(cudaMalloc(&d_fluid_frac_fsi, ff_bytes));
        CHECK_CUDA(cudaMemcpy(d_fluid_frac_fsi, paged_fluid_frac.data(), ff_bytes, cudaMemcpyHostToDevice));
        d_fluid_frac_fsi_capacity = ff_bytes;
        size_t q_bytes = total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>);
        CHECK_CUDA(cudaMalloc(&d_fsi_Q_tmp, q_bytes));
        CHECK_CUDA(cudaMemset(d_fsi_Q_tmp, 0, q_bytes));
        d_fsi_Q_tmp_capacity = q_bytes;
    }
    if (has_paged_fsi_drag) {
        size_t drag_bytes = total_tiles * sizeof(FluidDragTile3D);
        CHECK_CUDA(cudaMalloc(&d_fsi_drag_fsi, drag_bytes));
        CHECK_CUDA(cudaMemcpy(d_fsi_drag_fsi, paged_fsi_drag.data(), drag_bytes, cudaMemcpyHostToDevice));
        d_fsi_drag_fsi_capacity = drag_bytes;
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
    paged_fluid_frac.clear(); paged_fluid_frac.shrink_to_fit();
    paged_fsi_drag.clear(); paged_fsi_drag.shrink_to_fit();
    paged_tile_boundary.clear(); paged_tile_boundary.shrink_to_fit();

    // Rebuild compact active tile index after paging in
    const_cast<CFDSolver3DCuda*>(this)->rebuildActiveIndex();

    is_paged_out = false;
    states_pred_synced = false;
    constants_dirty = true;
    bind_constants();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::bind_constants() const {
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
    int fluxSchemeId = useAUSM ? 1 : ((currentFluxScheme == "HLLC") ? 2 : 0);
    CHECK_CUDA(cudaMemcpyToSymbol(d_useAUSM, &useAUSM, sizeof(bool)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_fluxScheme, &fluxSchemeId, sizeof(int)));
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
    CHECK_CUDA(cudaMemcpyToSymbol(d_detStartTime, &detStartTime, sizeof(double)));
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
    int t_idx = active_tile_indices ? active_tile_indices[blockIdx.x] : static_cast<int>(blockIdx.x);
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
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setDetonatorLocation(double x, double y, double z, double start_time) {
    detX = x; detY = y; detZ = z; detStartTime = start_time;
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
    this->charge_radius = charge.radius;
    if (detX == 0.0 && detY == 0.0 && detZ == 0.0) {
        detX = charge.x; detY = charge.y; detZ = charge.z;
    }
    double ch_rad = charge.radius;
    CHECK_CUDA(cudaMemcpyToSymbol(d_charge_radius, &ch_rad, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_detX, &detX, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_detY, &detY, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_detZ, &detZ, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_detStartTime, &detStartTime, sizeof(double)));

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
    states_pred_synced = false;
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
    this->charge_radius = charge.radius;
    if (detX == 0.0 && detY == 0.0 && detZ == 0.0) {
        detX = charge.x; detY = charge.y; detZ = charge.z;
    }
    double ch_rad = charge.radius;
    CHECK_CUDA(cudaMemcpyToSymbol(d_charge_radius, &ch_rad, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_detX, &detX, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_detY, &detY, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_detZ, &detZ, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_detStartTime, &detStartTime, sizeof(double)));

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
    states_pred_synced = false;
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
__device__ inline void computeTimeDerivativeGPU(
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
        dW_dt.alpha1 = -(sC.ux * d_x.alpha1 + sC.uy * d_y.alpha1 + sC.uz * d_z.alpha1);
        dW_dt.alpha2 = -(sC.ux * d_x.alpha2 + sC.uy * d_y.alpha2 + sC.uz * d_z.alpha2);
        
        dW_dt.arho1 = -(sC.ux * d_x.arho1 + sC.arho1 * d_x.ux +
                        sC.uy * d_y.arho1 + sC.arho1 * d_y.uy +
                        sC.uz * d_z.arho1 + sC.arho1 * d_z.uz);
        dW_dt.arho2 = -(sC.ux * d_x.arho2 + sC.arho2 * d_x.ux +
                        sC.uy * d_y.arho2 + sC.arho2 * d_y.uy +
                        sC.uz * d_z.arho2 + sC.arho2 * d_z.uz);
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) predict_states_gpu_kernel_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* __restrict__ states,
    PrimitivePredictorTile3D<RealType, IsMultiMaterial>* __restrict__ states_pred,
    PrimitivePredictorTile3D<RealType, IsMultiMaterial>* __restrict__ dW_dt_pool,
    const int* __restrict__ active_tile_indices,
    const uint8_t* __restrict__ tile_is_near_boundary,
    const GeometryTile3D* __restrict__ geom,
    RealType dt,
    RealType gamma_r,
    int scheme_id,
    int spatial_order = 2,
    const FluidFractionTile3D<RealType>* __restrict__ fluid_frac = nullptr
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

    RealType a_self = fluid_frac ? get_alpha_f_gpu(fluid_frac, geom, gx, gy, gz) : (RealType)1.0;
    if (a_self <= (RealType)0.0) return;
    if (a_self < (RealType)(1.0 - 1.0e-6)) {
        if (dW_dt_pool) {
            auto& dW_dt_tile = dW_dt_pool[t_idx];
            dW_dt_tile.rho[c_idx] = (RealType)0.0;
            dW_dt_tile.ux[c_idx] = (RealType)0.0;
            dW_dt_tile.uy[c_idx] = (RealType)0.0;
            dW_dt_tile.uz[c_idx] = (RealType)0.0;
            dW_dt_tile.p[c_idx] = (RealType)0.0;
            if constexpr (IsMultiMaterial) {
                dW_dt_tile.alpha1[c_idx] = (RealType)0.0;
                dW_dt_tile.alpha2[c_idx] = (RealType)0.0;
                dW_dt_tile.arho1[c_idx] = (RealType)0.0;
                dW_dt_tile.arho2[c_idx] = (RealType)0.0;
            }
        }
        return;
    }

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

    if (scheme_id == 0) { // MUSCL-Hancock
        GPUCellStateT<RealType, IsMultiMaterial> sL_x, sR_x;
        reconstruct_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz, 0, sL_x, sR_x, gx, gy, gz, is_near_boundary, false, false, spatial_order);
        GPUCellStateT<RealType, IsMultiMaterial> sL_xP1, sR_xP1;
        reconstruct_gpu<RealType, IsMultiMaterial>(states, geom, gx + 1, gy, gz, 0, sL_xP1, sR_xP1, gx, gy, gz, is_near_boundary, false, false, spatial_order);

        GPUCellStateT<RealType, IsMultiMaterial> sL_y, sR_y;
        reconstruct_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz, 1, sL_y, sR_y, gx, gy, gz, is_near_boundary, false, false, spatial_order);
        GPUCellStateT<RealType, IsMultiMaterial> sL_yP1, sR_yP1;
        reconstruct_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy + 1, gz, 1, sL_yP1, sR_yP1, gx, gy, gz, is_near_boundary, false, false, spatial_order);

        GPUCellStateT<RealType, IsMultiMaterial> sL_z, sR_z;
        reconstruct_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz, 2, sL_z, sR_z, gx, gy, gz, is_near_boundary, false, false, spatial_order);
        GPUCellStateT<RealType, IsMultiMaterial> sL_zP1, sR_zP1;
        reconstruct_gpu<RealType, IsMultiMaterial>(states, geom, gx, gy, gz + 1, 2, sL_zP1, sR_zP1, gx, gy, gz, is_near_boundary, false, false, spatial_order);

        d_x.rho = (sL_xP1.rho - sR_x.rho) * invDx;
        d_x.ux = (sL_xP1.ux - sR_x.ux) * invDx;
        d_x.uy = (sL_xP1.uy - sR_x.uy) * invDx;
        d_x.uz = (sL_xP1.uz - sR_x.uz) * invDx;
        d_x.p = (sL_xP1.p - sR_x.p) * invDx;
        if constexpr (IsMultiMaterial) {
            d_x.alpha1 = (sL_xP1.alpha1 - sR_x.alpha1) * invDx;
            d_x.alpha2 = (sL_xP1.alpha2 - sR_x.alpha2) * invDx;
            d_x.arho1 = (sL_xP1.arho1 - sR_x.arho1) * invDx;
            d_x.arho2 = (sL_xP1.arho2 - sR_x.arho2) * invDx;
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
            d_y.arho2 = (sL_yP1.arho2 - sR_y.arho2) * invDx;
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
            d_z.arho2 = (sL_zP1.arho2 - sR_z.arho2) * invDx;
        }
        if (is_near_boundary && (geom || fluid_frac)) {
            // Suppress ALL slopes in each direction near solid/cut boundaries
            // to prevent predictor overshoot at shock-wall interactions
            bool touch_x = (geom && (is_solid_cell_gpu(geom, gx - 1, gy, gz) || is_solid_cell_gpu(geom, gx + 1, gy, gz))) ||
                           (fluid_frac && (get_alpha_f_gpu(fluid_frac, geom, gx - 1, gy, gz) <= (RealType)FSI_ALPHA_DEAD ||
                                           get_alpha_f_gpu(fluid_frac, geom, gx + 1, gy, gz) <= (RealType)FSI_ALPHA_DEAD));
            bool touch_y = (geom && (is_solid_cell_gpu(geom, gx, gy - 1, gz) || is_solid_cell_gpu(geom, gx, gy + 1, gz))) ||
                           (fluid_frac && (get_alpha_f_gpu(fluid_frac, geom, gx, gy - 1, gz) <= (RealType)FSI_ALPHA_DEAD ||
                                           get_alpha_f_gpu(fluid_frac, geom, gx, gy + 1, gz) <= (RealType)FSI_ALPHA_DEAD));
            bool touch_z = (geom && (is_solid_cell_gpu(geom, gx, gy, gz - 1) || is_solid_cell_gpu(geom, gx, gy, gz + 1))) ||
                           (fluid_frac && (get_alpha_f_gpu(fluid_frac, geom, gx, gy, gz - 1) <= (RealType)FSI_ALPHA_DEAD ||
                                           get_alpha_f_gpu(fluid_frac, geom, gx, gy, gz + 1) <= (RealType)FSI_ALPHA_DEAD));
            if (touch_x) {
                d_x.rho = (RealType)0.0; d_x.ux = (RealType)0.0; d_x.uy = (RealType)0.0;
                d_x.uz = (RealType)0.0; d_x.p = (RealType)0.0;
                if constexpr (IsMultiMaterial) { d_x.alpha1 = (RealType)0.0; d_x.alpha2 = (RealType)0.0; d_x.arho1 = (RealType)0.0; d_x.arho2 = (RealType)0.0; }
            }
            if (touch_y) {
                d_y.rho = (RealType)0.0; d_y.ux = (RealType)0.0; d_y.uy = (RealType)0.0;
                d_y.uz = (RealType)0.0; d_y.p = (RealType)0.0;
                if constexpr (IsMultiMaterial) { d_y.alpha1 = (RealType)0.0; d_y.alpha2 = (RealType)0.0; d_y.arho1 = (RealType)0.0; d_y.arho2 = (RealType)0.0; }
            }
            if (touch_z) {
                d_z.rho = (RealType)0.0; d_z.ux = (RealType)0.0; d_z.uy = (RealType)0.0;
                d_z.uz = (RealType)0.0; d_z.p = (RealType)0.0;
                if constexpr (IsMultiMaterial) { d_z.alpha1 = (RealType)0.0; d_z.alpha2 = (RealType)0.0; d_z.arho1 = (RealType)0.0; d_z.arho2 = (RealType)0.0; }
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

        bool solid_x_L = is_near_boundary && (is_solid_cell_gpu(geom, gx - 1, gy, gz) || (fluid_frac && get_alpha_f_gpu(fluid_frac, geom, gx - 1, gy, gz) <= (RealType)FSI_ALPHA_DEAD));
        bool solid_x_R = is_near_boundary && (is_solid_cell_gpu(geom, gx + 1, gy, gz) || (fluid_frac && get_alpha_f_gpu(fluid_frac, geom, gx + 1, gy, gz) <= (RealType)FSI_ALPHA_DEAD));
        bool is_confined_x = solid_x_L && solid_x_R;

        bool solid_y_B = is_near_boundary && (is_solid_cell_gpu(geom, gx, gy - 1, gz) || (fluid_frac && get_alpha_f_gpu(fluid_frac, geom, gx, gy - 1, gz) <= (RealType)FSI_ALPHA_DEAD));
        bool solid_y_T = is_near_boundary && (is_solid_cell_gpu(geom, gx, gy + 1, gz) || (fluid_frac && get_alpha_f_gpu(fluid_frac, geom, gx, gy + 1, gz) <= (RealType)FSI_ALPHA_DEAD));
        bool is_confined_y = solid_y_B && solid_y_T;

        bool solid_z_D = is_near_boundary && (is_solid_cell_gpu(geom, gx, gy, gz - 1) || (fluid_frac && get_alpha_f_gpu(fluid_frac, geom, gx, gy, gz - 1) <= (RealType)FSI_ALPHA_DEAD));
        bool solid_z_U = is_near_boundary && (is_solid_cell_gpu(geom, gx, gy, gz + 1) || (fluid_frac && get_alpha_f_gpu(fluid_frac, geom, gx, gy, gz + 1) <= (RealType)FSI_ALPHA_DEAD));
        bool is_confined_z = solid_z_D && solid_z_U;

        auto slope = [=](RealType L, RealType C, RealType R) {
            return vanleer_gpu(C - L, R - C) * invDx;
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
                d_x.arho2  = (RealType)0.0;
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
                d_x.arho2  = (RealType)0.0;
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
                d_x.arho2 = slope(sX_L.arho2, sC.arho2, sX_R.arho2);
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
                d_y.arho2  = (RealType)0.0;
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
                d_y.arho2  = (RealType)0.0;
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
                d_y.arho2 = slope(sY_B.arho2, sC.arho2, sY_T.arho2);
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
                d_z.arho2  = (RealType)0.0;
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
                d_z.arho2  = (RealType)0.0;
            }
        } else {
            RealType dp_hydro = d_has_gravity ? (sC.rho * (RealType)d_gravity_z) : (RealType)0.0;
            RealType dp_L = (sC.p - sZ_D.p) * invDx - dp_hydro;
            RealType dp_R = (sZ_U.p - sC.p) * invDx - dp_hydro;
            d_z.rho = slope(sZ_D.rho, sC.rho, sZ_U.rho);
            d_z.ux = slope(sZ_D.ux, sC.ux, sZ_U.ux);
            d_z.uy = slope(sZ_D.uy, sC.uy, sZ_U.uy);
            d_z.uz = slope(sZ_D.uz, sC.uz, sZ_U.uz);
            d_z.p = dp_hydro + vanleer_gpu(dp_L, dp_R);
            if constexpr (IsMultiMaterial) {
                d_z.alpha1 = slope(sZ_D.alpha1, sC.alpha1, sZ_U.alpha1);
                d_z.alpha2 = slope(sZ_D.alpha2, sC.alpha2, sZ_U.alpha2);
                d_z.arho1 = slope(sZ_D.arho1, sC.arho1, sZ_U.arho1);
                d_z.arho2 = slope(sZ_D.arho2, sC.arho2, sZ_U.arho2);
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
            d_x.arho2  = (RealType)0.0;
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
            d_x.arho2  = (RealType)0.0;
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
            d_x.arho2 = slope(sX_L.arho2, sC.arho2, sX_R.arho2);
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
            d_y.arho2  = (RealType)0.0;
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
            d_y.arho2  = (RealType)0.0;
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
            d_y.arho2 = slope(sY_B.arho2, sC.arho2, sY_T.arho2);
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
            d_z.arho2  = (RealType)0.0;
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
            d_z.arho2  = (RealType)0.0;
        }
    } else {
        RealType dp_hydro = d_has_gravity ? (sC.rho * (RealType)d_gravity_z) : (RealType)0.0;
        RealType dp_L = (sC.p - sZ_D.p) * invDx - dp_hydro;
        RealType dp_R = (sZ_U.p - sC.p) * invDx - dp_hydro;
        d_z.rho = slope(sZ_D.rho, sC.rho, sZ_U.rho);
        d_z.ux = slope(sZ_D.ux, sC.ux, sZ_U.ux);
        d_z.uy = slope(sZ_D.uy, sC.uy, sZ_U.uy);
        d_z.uz = slope(sZ_D.uz, sC.uz, sZ_U.uz);
        d_z.p = dp_hydro + minmod_gpu(dp_L, dp_R);
        if constexpr (IsMultiMaterial) {
            d_z.alpha1 = slope(sZ_D.alpha1, sC.alpha1, sZ_U.alpha1);
            d_z.alpha2 = slope(sZ_D.alpha2, sC.alpha2, sZ_U.alpha2);
            d_z.arho1 = slope(sZ_D.arho1, sC.arho1, sZ_U.arho1);
            d_z.arho2 = slope(sZ_D.arho2, sC.arho2, sZ_U.arho2);
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
    constants_dirty = true;
}

template <typename RealType, bool IsMultiMaterial>
__global__ void kernel_fsi_apply_penalty_gpu(
    PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    ConservativeTile3D<RealType, IsMultiMaterial>* d_U,
    const Blast::MPMGridNode3D* d_grid,
    const GeometryTile3D* d_geom,
    int nx, int ny, int nz,
    int ntx, int nty,
    float dx, float dy, float dz,
    float gamma,
    Blast::MPMGridView3D gv = {}
);

template <typename RealType, bool IsMultiMaterial>
__global__ void kernel_fsi_apply_penalty_active_gpu(
    PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    ConservativeTile3D<RealType, IsMultiMaterial>* d_U,
    const Blast::MPMGridNode3D* d_grid,
    const GeometryTile3D* d_geom,
    const int* d_active_nodes,
    int num_active_nodes,
    int nx_cfd, int ny_cfd, int nz_cfd,
    int ntx, int nty,
    float dx_cfd, float dy_cfd, float dz_cfd,
    float xmin_cfd, float ymin_cfd, float zmin_cfd,
    int nx_mpm, int ny_mpm, int nz_mpm,
    float dx_mpm, float dy_mpm, float dz_mpm,
    float xmin_mpm, float ymin_mpm, float zmin_mpm,
    float gamma,
    Blast::MPMGridView3D gv = {}
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

template <typename RealType>
__device__ inline RealType fsi_flux_recipient_weight(
    const FluidFractionTile3D<RealType>* fluid_frac,
    const GeometryTile3D* geom,
    int mx, int my, int mz,
    int nx_i, int ny_i, int nz_i,
    int nx_v, int ny_v, int nz_v
) {
    RealType a_m = get_alpha_f_gpu(fluid_frac, geom, mx, my, mz);
    if (a_m <= (RealType)0.0) return (RealType)0.0;

    RealType ns_x = (RealType)0.0, ns_y = (RealType)0.0, ns_z = (RealType)0.0;
    bool has_n = false;
    if (geom) {
        int ntx_v = load_const_i32(&d_ntx);
        int nty_v = load_const_i32(&d_nty);
        int mt = (mx >> 3) + (my >> 3) * ntx_v + (mz >> 3) * ntx_v * nty_v;
        int mc = (mx & 7) + (my & 7) * 8 + (mz & 7) * 64;
        GeometryPayload gp = geom[mt].cells[mc];
        ns_x = static_cast<RealType>(gp.nx);
        ns_y = static_cast<RealType>(gp.ny);
        ns_z = static_cast<RealType>(gp.nz);
        RealType ns_len = sqrt(ns_x * ns_x + ns_y * ns_y + ns_z * ns_z);
        if (ns_len > (RealType)1.0) {
            RealType inv_l = (RealType)1.0 / ns_len;
            ns_x *= inv_l; ns_y *= inv_l; ns_z *= inv_l;
            has_n = true;
        }
    }

    RealType w_sum = (RealType)0.0;
    RealType w_target = (RealType)0.0;
    for (int tier = 0; tier < 6 && w_sum <= (RealType)0.0; ++tier) {
        bool six_only = (tier == 0 || tier == 1);
        RealType acc = (RealType)0.0;
        RealType tgt = (RealType)0.0;
        for (int dk = -1; dk <= 1; ++dk) {
            int oz = mz + dk;
            if (oz < 0 || oz >= nz_v) continue;
            for (int dj = -1; dj <= 1; ++dj) {
                int oy = my + dj;
                if (oy < 0 || oy >= ny_v) continue;
                for (int di = -1; di <= 1; ++di) {
                    int man = abs(di) + abs(dj) + abs(dk);
                    if (man == 0 || (six_only && man != 1)) continue;
                    int ox = mx + di;
                    if (ox < 0 || ox >= nx_v) continue;
                    RealType ao = get_alpha_f_gpu(fluid_frac, geom, ox, oy, oz);
                    bool ok = false;
                    if (tier == 0 || tier == 2) ok = (ao >= (RealType)(1.0 - 1.0e-6));
                    else if (tier == 1 || tier == 3) ok = (ao >= (RealType)FSI_ALPHA_CUT);
                    else if (tier == 4) ok = (ao > a_m);
                    else ok = (ao > (RealType)0.0);
                    if (ok) {
                        RealType d2 = (RealType)(di * di + dj * dj + dk * dk);
                        RealType dir_bias = (RealType)1.0;
                        if (has_n) {
                            RealType dot_n = ((RealType)di * ns_x + (RealType)dj * ns_y + (RealType)dk * ns_z) / sqrt(d2);
                            dir_bias = (RealType)1.0e-6 + fmax((RealType)0.0, dot_n);
                        }
                        RealType w = (ao * dir_bias) / d2;
                        acc += w;
                        if (ox == nx_i && oy == ny_i && oz == nz_i) tgt = w;
                    }
                }
            }
        }
        if (acc > (RealType)0.0) {
            w_sum = acc;
            w_target = tgt;
        }
    }
    if (w_sum > (RealType)0.0) {
        return (w_target > (RealType)0.0) ? (w_target / w_sum) : (RealType)0.0;
    }
    return (mx == nx_i && my == ny_i && mz == nz_i) ? (RealType)1.0 : (RealType)0.0;
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) kernel_redistribute_cut_flux_3d(
    ConservativeTile3D<RealType, IsMultiMaterial>* U_dest,
    const ConservativeTile3D<RealType, IsMultiMaterial>* fsi_Q_tmp,
    const FluidFractionTile3D<RealType>* fluid_frac,
    const GeometryTile3D* geom,
    const int* active_tile_indices,
    const uint8_t* tile_is_near_boundary
) {
    if (!fsi_Q_tmp || !fluid_frac) return;
    int t_idx = active_tile_indices ? active_tile_indices[blockIdx.x] : blockIdx.x;
    int ntx_v = load_const_i32(&d_ntx);
    int nty_v = load_const_i32(&d_nty);
    int nx_v = load_const_i32(&d_nx);
    int ny_v = load_const_i32(&d_ny);
    int nz_v = load_const_i32(&d_nz);

    int tx = t_idx % ntx_v;
    int ty = (t_idx / ntx_v) % nty_v;
    int tz = t_idx / (ntx_v * nty_v);

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    int gx = tx * TILE_SIZE_3D + lx;
    int gy = ty * TILE_SIZE_3D + ly;
    int gz = tz * TILE_SIZE_3D + lz;
    if (gx >= nx_v || gy >= ny_v || gz >= nz_v) return;

    RealType a_self = get_alpha_f_gpu(fluid_frac, geom, gx, gy, gz);
    if (a_self <= (RealType)0.0) return;

    RealType add_rho = (RealType)0.0;
    RealType add_rx  = (RealType)0.0;
    RealType add_ry  = (RealType)0.0;
    RealType add_rz  = (RealType)0.0;
    RealType add_E   = (RealType)0.0;
    RealType add_a1  = (RealType)0.0;
    RealType add_a2  = (RealType)0.0;
    RealType add_ar1 = (RealType)0.0;
    RealType add_ar2 = (RealType)0.0;

    for (int dk = -1; dk <= 1; ++dk) {
        int mz = gz + dk;
        if (mz < 0 || mz >= nz_v) continue;
        for (int dj = -1; dj <= 1; ++dj) {
            int my = gy + dj;
            if (my < 0 || my >= ny_v) continue;
            for (int di = -1; di <= 1; ++di) {
                int mx = gx + di;
                if (mx < 0 || mx >= nx_v) continue;
                int mt = (mx >> 3) + (my >> 3) * ntx_v + (mz >> 3) * ntx_v * nty_v;
                if (tile_is_near_boundary && !tile_is_near_boundary[mt]) continue;
                RealType a_m = get_alpha_f_gpu(fluid_frac, geom, mx, my, mz);
                if (a_m <= (RealType)0.0 || a_m >= (RealType)FSI_ALPHA_CUT) continue;
                RealType frac = fsi_flux_recipient_weight<RealType>(fluid_frac, geom, mx, my, mz, gx, gy, gz, nx_v, ny_v, nz_v);
                if (frac <= (RealType)0.0) continue;
                int mc = (mx & 7) + (my & 7) * 8 + (mz & 7) * 64;
                add_rho += frac * fsi_Q_tmp[mt].rho[mc];
                add_rx  += frac * fsi_Q_tmp[mt].rhoux[mc];
                add_ry  += frac * fsi_Q_tmp[mt].rhouy[mc];
                add_rz  += frac * fsi_Q_tmp[mt].rhouz[mc];
                add_E   += frac * fsi_Q_tmp[mt].E[mc];
                if constexpr (IsMultiMaterial) {
                    add_a1  += frac * fsi_Q_tmp[mt].alpha1[mc];
                    add_a2  += frac * fsi_Q_tmp[mt].alpha2[mc];
                    add_ar1 += frac * fsi_Q_tmp[mt].arho1[mc];
                    add_ar2 += frac * fsi_Q_tmp[mt].arho2[mc];
                }
            }
        }
    }

    if (add_rho != (RealType)0.0 || add_rx != (RealType)0.0 || add_ry != (RealType)0.0 ||
        add_rz != (RealType)0.0 || add_E != (RealType)0.0) {
        RealType inv_a = (RealType)1.0 / a_self;
        RealType rho_raw = U_dest[t_idx].rho[c_idx] + add_rho * inv_a;
        RealType rho_new = fmax((RealType)1.0e-4, rho_raw);
        U_dest[t_idx].rho[c_idx] = rho_new;
        if (rho_raw > (RealType)1.0e-4) {
            U_dest[t_idx].rhoux[c_idx] += add_rx * inv_a;
            U_dest[t_idx].rhouy[c_idx] += add_ry * inv_a;
            U_dest[t_idx].rhouz[c_idx] += add_rz * inv_a;
        } else {
            RealType damp = (rho_raw > (RealType)0.0) ? (rho_raw / rho_new) : (RealType)0.0;
            U_dest[t_idx].rhoux[c_idx] = damp * (U_dest[t_idx].rhoux[c_idx] + add_rx * inv_a);
            U_dest[t_idx].rhouy[c_idx] = damp * (U_dest[t_idx].rhouy[c_idx] + add_ry * inv_a);
            U_dest[t_idx].rhouz[c_idx] = damp * (U_dest[t_idx].rhouz[c_idx] + add_rz * inv_a);
        }
        U_dest[t_idx].E[c_idx]     = fmax((RealType)1.0e-5, U_dest[t_idx].E[c_idx] + add_E * inv_a);
        if constexpr (IsMultiMaterial) {
            RealType a1 = fmax((RealType)0.0, fmin((RealType)1.0, U_dest[t_idx].alpha1[c_idx] + add_a1 * inv_a));
            RealType a2 = fmax((RealType)0.0, fmin((RealType)1.0, U_dest[t_idx].alpha2[c_idx] + add_a2 * inv_a));
            RealType asum = a1 + a2;
            if (asum > (RealType)1.0) {
                RealType s = (RealType)1.0 / asum;
                a1 *= s; a2 *= s;
            }
            U_dest[t_idx].alpha1[c_idx] = a1;
            U_dest[t_idx].alpha2[c_idx] = a2;
            RealType ar1 = U_dest[t_idx].arho1[c_idx] + add_ar1 * inv_a;
            RealType ar2 = U_dest[t_idx].arho2[c_idx] + add_ar2 * inv_a;
            if (ar1 < (RealType)0.0 || ar2 < (RealType)0.0) {
                ar1 = fmax((RealType)0.0, ar1);
                ar2 = fmax((RealType)0.0, ar2);
                RealType ar_sum = ar1 + ar2;
                if (ar_sum > (RealType)1.0e-12) {
                    RealType s = rho_new / ar_sum;
                    ar1 *= s; ar2 *= s;
                }
            }
            U_dest[t_idx].arho1[c_idx] = ar1;
            U_dest[t_idx].arho2[c_idx] = ar2;
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) kernel_apply_fsi_dilute_drag_source_gpu(
    ConservativeTile3D<RealType, IsMultiMaterial>* U_dest,
    const FluidFractionTile3D<RealType>* fluid_frac,
    const GeometryTile3D* geom,
    FluidDragTile3D* d_drag,
    const int* active_tile_indices,
    RealType dt_r
) {
    if (!fluid_frac || !d_drag) return;
    int t_idx = active_tile_indices ? active_tile_indices[blockIdx.x] : blockIdx.x;
    int ntx_v = load_const_i32(&d_ntx);
    int nty_v = load_const_i32(&d_nty);
    int nx_v = load_const_i32(&d_nx);
    int ny_v = load_const_i32(&d_ny);
    int nz_v = load_const_i32(&d_nz);

    int tx = t_idx % ntx_v;
    int ty = (t_idx / ntx_v) % nty_v;
    int tz = t_idx / (ntx_v * nty_v);

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    int gx = tx * TILE_SIZE_3D + lx;
    int gy = ty * TILE_SIZE_3D + ly;
    int gz = tz * TILE_SIZE_3D + lz;
    if (gx >= nx_v || gy >= ny_v || gz >= nz_v) return;

    float fx = d_drag[t_idx].fx[c_idx];
    float fy = d_drag[t_idx].fy[c_idx];
    float fz = d_drag[t_idx].fz[c_idx];
    float pw = d_drag[t_idx].power[c_idx];
    if (fx == 0.0f && fy == 0.0f && fz == 0.0f && pw == 0.0f) return;

    RealType a_self = get_alpha_f_gpu(fluid_frac, geom, gx, gy, gz);
    if (a_self > (RealType)FSI_ALPHA_DEAD) {
        RealType scale = dt_r / a_self;
        U_dest[t_idx].rhoux[c_idx] += (RealType)fx * scale;
        U_dest[t_idx].rhouy[c_idx] += (RealType)fy * scale;
        U_dest[t_idx].rhouz[c_idx] += (RealType)fz * scale;
        RealType E_new = U_dest[t_idx].E[c_idx] + (RealType)pw * scale;
        RealType rho_c = fmax((RealType)1.0e-7, U_dest[t_idx].rho[c_idx]);
        RealType rx = U_dest[t_idx].rhoux[c_idx];
        RealType ry = U_dest[t_idx].rhouy[c_idx];
        RealType rz = U_dest[t_idx].rhouz[c_idx];
        RealType ke_min = (RealType)0.5 * (rx * rx + ry * ry + rz * rz) / rho_c + (RealType)1.0e-5;
        U_dest[t_idx].E[c_idx] = fmax(ke_min, E_new);
    }

    d_drag[t_idx].fx[c_idx] = 0.0f;
    d_drag[t_idx].fy[c_idx] = 0.0f;
    d_drag[t_idx].fz[c_idx] = 0.0f;
    d_drag[t_idx].power[c_idx] = 0.0f;
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
        compute_flux_fused_3d<RealType, IsMultiMaterial, TileT><<<n_active, threads>>>(
            states_ptr,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)U_dest,
            (const int*)d_active_tile_indices,
            (const uint8_t*)d_tile_is_near_boundary,
            (const GeometryTile3D*)d_geom,
            dt_r, stage,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)U_prev_ptr,
            prim_upd, peak_dt,
            (const SolidVelocityTile3D*)d_solid_vel_fsi,
            spatialOrder,
            (const FluidFractionTile3D<RealType>*)d_fluid_frac_fsi,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_fsi_Q_tmp
        );
    };

    // MUSCL-Hancock (0), ADER-2 (1), ADER-3 (2) on GPU
    int total_tiles = ntx * nty * ntz;
    if (!d_states_pred) {
        CHECK_CUDA(cudaMalloc(&d_states_pred, total_tiles * sizeof(PrimitivePredictorTile3D<RealType, IsMultiMaterial>)));
        states_pred_synced = false;
    }
    if (!states_pred_synced) {
        copy_active_primitive_tiles_kernel_3d<RealType, IsMultiMaterial><<<total_tiles, 512>>>(
            (PrimitivePredictorTile3D<RealType, IsMultiMaterial>*)d_states_pred,
            (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            nullptr
        );
        CHECK_CUDA(cudaGetLastError());
        states_pred_synced = true;
    }
    bool is_ader3 = (spaceTimeScheme == SpaceTimeScheme3D::ADER_3);
    if (is_ader3 && !d_dW_dt) {
        CHECK_CUDA(cudaMalloc(&d_dW_dt, total_tiles * sizeof(PrimitivePredictorTile3D<RealType, IsMultiMaterial>)));
        CHECK_CUDA(cudaMemset(d_dW_dt, 0, total_tiles * sizeof(PrimitivePredictorTile3D<RealType, IsMultiMaterial>)));
    }
    auto states_pred_ptr = (PrimitivePredictorTile3D<RealType, IsMultiMaterial>*)d_states_pred;
    auto dW_dt_ptr = is_ader3 ? (PrimitivePredictorTile3D<RealType, IsMultiMaterial>*)d_dW_dt : nullptr;

    copy_active_primitive_tiles_kernel_3d<RealType, IsMultiMaterial><<<n_active, 512>>>(
        states_pred_ptr, (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, (const int*)d_active_tile_indices
    );
    CHECK_CUDA(cudaGetLastError());
    
    RealType gamma_r = (RealType)gamma;
    int scheme_id = static_cast<int>(spaceTimeScheme);

        // Launch pass 1 prediction kernel
        BlastDiagnostics::set_last_dt(dt);
        BlastDiagnostics::set_kernel_phase("predict_states_gpu_kernel_3d");
        predict_states_gpu_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>(
            (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            states_pred_ptr,
            dW_dt_ptr,
            (const int*)d_active_tile_indices,
            (const uint8_t*)d_tile_is_near_boundary,
            (const GeometryTile3D*)d_geom,
            dt_r,
            gamma_r,
            scheme_id,
            spatialOrder,
            (const FluidFractionTile3D<RealType>*)d_fluid_frac_fsi
        );
        CHECK_CUDA(cudaGetLastError());

        if (is_ader3) {
            // ADER-3 Second Pass: compute integrated states
            BlastDiagnostics::set_kernel_phase("predict_states_ader3_gpu_kernel_3d");
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
            CHECK_CUDA(cudaGetLastError());
        }

        // Perform flux update using predicted states directly without pointer swap
        BlastDiagnostics::set_kernel_phase("compute_flux_fused_3d");
        launch_fused_kernel_with_states(states_pred_ptr, d_U, 0, nullptr, false, (RealType)0.0);
        CHECK_CUDA(cudaGetLastError());

        if (d_fluid_frac_fsi && d_fsi_Q_tmp) {
            BlastDiagnostics::set_kernel_phase("kernel_redistribute_cut_flux_3d");
            kernel_redistribute_cut_flux_3d<RealType, IsMultiMaterial><<<n_active, threads>>>(
                (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
                (const ConservativeTile3D<RealType, IsMultiMaterial>*)d_fsi_Q_tmp,
                (const FluidFractionTile3D<RealType>*)d_fluid_frac_fsi,
                (const GeometryTile3D*)d_geom,
                (const int*)d_active_tile_indices,
                (const uint8_t*)d_tile_is_near_boundary
            );
            CHECK_CUDA(cudaGetLastError());
        }

        if (d_fluid_frac_fsi && d_fsi_drag_fsi) {
            BlastDiagnostics::set_kernel_phase("kernel_apply_fsi_dilute_drag_source_gpu");
            kernel_apply_fsi_dilute_drag_source_gpu<RealType, IsMultiMaterial><<<n_active, threads>>>(
                (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
                (const FluidFractionTile3D<RealType>*)d_fluid_frac_fsi,
                (const GeometryTile3D*)d_geom,
                (FluidDragTile3D*)d_fsi_drag_fsi,
                (const int*)d_active_tile_indices,
                dt_r
            );
            CHECK_CUDA(cudaGetLastError());
        }

        if constexpr (IsMultiMaterial) {
            BlastDiagnostics::set_kernel_phase("applyProgrammedBurn_kernel_3d");
            applyProgrammedBurn_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>(
                (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
                (const int*)d_active_tile_indices,
                (RealType)currentTime,
                dt_r
            );
            CHECK_CUDA(cudaGetLastError());
        }

        // Update primitive variables and peaks
        BlastDiagnostics::set_kernel_phase("update_primitive_kernel_3d");
        update_primitive_kernel_3d<RealType, IsMultiMaterial><<<n_active, threads>>>(
            (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
            (const int*)d_active_tile_indices,
            (const GeometryTile3D*)d_geom,
            dt_r,
            (const SolidVelocityTile3D*)d_solid_vel_fsi
        );
        CHECK_CUDA(cudaGetLastError());

    if (this->m_fsi_mpm_solver) {
        auto* mpm_s = static_cast<Blast::MPMSolver3DCUDA*>(this->m_fsi_mpm_solver);
        this->d_fsi_mpm_grid = mpm_s->getDeviceGrid();
    }
    if (this->d_fsi_mpm_grid && !this->d_fluid_frac_fsi) {
        auto* mpm_s = static_cast<Blast::MPMSolver3DCUDA*>(this->m_fsi_mpm_solver);
        Blast::MPMGridView3D fsi_gv = mpm_s ? mpm_s->getDeviceGridView() : Blast::MPMGridView3D{};
        if (mpm_s && mpm_s->getNumActiveNodes() > 0 && mpm_s->getDeviceActiveNodes()) {
            int num_act = mpm_s->getNumActiveNodes();
            int threads_act = 256;
            int blocks_act = (num_act + threads_act - 1) / threads_act;
            BlastDiagnostics::set_kernel_phase("kernel_fsi_apply_penalty_active_gpu");
            kernel_fsi_apply_penalty_active_gpu<RealType, IsMultiMaterial><<<blocks_act, threads_act>>>(
                (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
                (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
                (const Blast::MPMGridNode3D*)this->d_fsi_mpm_grid,
                (const GeometryTile3D*)d_geom,
                mpm_s->getDeviceActiveNodes(),
                num_act,
                nx, ny, nz, ntx, nty,
                (float)cellSize, (float)cellSize, (float)cellSize,
                (float)xmin, (float)ymin, (float)zmin,
                mpm_s->getNx(), mpm_s->getNy(), mpm_s->getNz(),
                mpm_s->getDx(), mpm_s->getDy(), mpm_s->getDz(),
                mpm_s->getXMin(), mpm_s->getYMin(), mpm_s->getZMin(),
                (float)gamma,
                fsi_gv
            );
            CHECK_CUDA(cudaGetLastError());
            CHECK_CUDA(cudaDeviceSynchronize());
        } else if (!mpm_s || (mpm_s->getNx() == nx && mpm_s->getNy() == ny && mpm_s->getNz() == nz)) {
            dim3 penalty_threads(8, 8, 4);
            dim3 penalty_grid((nx + 7) / 8, (ny + 7) / 8, (nz + 3) / 4);
            BlastDiagnostics::set_kernel_phase("kernel_fsi_apply_penalty_gpu");
            kernel_fsi_apply_penalty_gpu<RealType, IsMultiMaterial><<<penalty_grid, penalty_threads>>>(
                (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
                (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
                (const Blast::MPMGridNode3D*)this->d_fsi_mpm_grid,
                (const GeometryTile3D*)d_geom,
                nx, ny, nz, ntx, nty,
                (float)cellSize, (float)cellSize, (float)cellSize,
                (float)gamma,
                fsi_gv
            );
            CHECK_CUDA(cudaGetLastError());
            CHECK_CUDA(cudaDeviceSynchronize());
        }
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
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setSpaceTimeScheme(SpaceTimeScheme3D scheme) {
    CFDSolver3DImplBase::setSpaceTimeScheme(scheme);
    if (scheme == SpaceTimeScheme3D::ADER_3 && !is_paged_out && !d_dW_dt) {
        int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
        int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
        int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
        int total_tiles = ntx * nty * ntz;
        CHECK_CUDA(cudaMalloc(&d_dW_dt, total_tiles * sizeof(PrimitivePredictorTile3D<RealType, IsMultiMaterial>)));
        CHECK_CUDA(cudaMemset(d_dW_dt, 0, total_tiles * sizeof(PrimitivePredictorTile3D<RealType, IsMultiMaterial>)));
    }
    constants_dirty = true;
}

template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) compute_max_speed_kernel_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    const GeometryTile3D* geom,
    const int* active_tile_indices,
    RealType gamma,
    RealType* max_s_block,
    const FluidFractionTile3D<RealType>* fluid_frac = nullptr,
    const SolidVelocityTile3D* d_solid_vel = nullptr) {

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
        bool in_lagrangian_core = false;
        if (d_zonalParams.enabled) {
            RealType dx_rel = (RealType)d_xmin + ((RealType)gx + (RealType)0.5) * (RealType)d_cellSize - (RealType)d_zonalParams.center_x;
            RealType dy_rel = (RealType)d_ymin + ((RealType)gy + (RealType)0.5) * (RealType)d_cellSize - (RealType)d_zonalParams.center_y;
            RealType dz_rel = (RealType)d_zmin + ((RealType)gz + (RealType)0.5) * (RealType)d_cellSize - (RealType)d_zonalParams.center_z;
            RealType z_c = (RealType)d_zmin + ((RealType)gz + (RealType)0.5) * (RealType)d_cellSize;
            RealType eff_czmin = fmax((RealType)d_zonalParams.clip_z_min, (RealType)d_zmin);
            RealType eff_czmax = fmin((RealType)d_zonalParams.clip_z_max, (RealType)d_zmin + (RealType)d_nz * (RealType)d_cellSize);
            RealType r_cell = d_zonalParams.is_cylinder ? sqrt(dx_rel * dx_rel + dy_rel * dy_rel) : sqrt(dx_rel * dx_rel + dy_rel * dy_rel + dz_rel * dz_rel);
            RealType ovl = (RealType)d_zonalParams.overlap_thickness;
            if (ovl < (RealType)1.0e-4) ovl = (RealType)2.0 * (RealType)d_cellSize;
            RealType R_inner_c = (RealType)d_zonalParams.sleeve_radius - ovl;
            RealType Z_inner_top = eff_czmax - ovl;
            RealType Z_inner_bot = eff_czmin + ovl;
            bool inside_z_core = (z_c >= Z_inner_bot && z_c <= Z_inner_top);
            if (inside_z_core && r_cell < R_inner_c) {
                in_lagrangian_core = true;
            }
        }

        RealType a_self = fluid_frac ? get_alpha_f_gpu(fluid_frac, geom, gx, gy, gz)
                                     : ((geom && geom[t_idx].cells[c_idx].is_boundary) ? (RealType)0.0 : (RealType)1.0);
        if (!in_lagrangian_core && a_self > (RealType)0.0) {
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

            RealType u_bound_x = abs(ux);
            RealType u_bound_y = abs(uy);
            RealType u_bound_z = abs(uz);
            RealType acoustic_mult = (RealType)1.0;
            if (geom || fluid_frac) {
                int solid_faces = 0;
                RealType gp1_half = (RealType)0.5 * (gamma + (RealType)1.0);
                const int dirs[6][3] = {{-1,0,0},{1,0,0},{0,-1,0},{0,1,0},{0,0,-1},{0,0,1}};
                RealType u_cell[3] = {ux, uy, uz};
                RealType u_bnd[3]  = {u_bound_x, u_bound_y, u_bound_z};
                for (int f = 0; f < 6; ++f) {
                    int nx_i = gx + dirs[f][0], ny_i = gy + dirs[f][1], nz_i = gz + dirs[f][2];
                    int ax = f >> 1;
                    bool has_solid_n = fluid_frac
                        ? (get_alpha_f_gpu(fluid_frac, geom, nx_i, ny_i, nz_i) < (RealType)(1.0 - 1.0e-6))
                        : is_solid_cell_gpu(geom, nx_i, ny_i, nz_i);
                    if (has_solid_n) {
                        solid_faces++;
                        RealType vw = get_solid_vel_comp_gpu<RealType, IsMultiMaterial>(d_solid_vel, states, nx_i, ny_i, nz_i, ax);
                        u_bnd[ax] = fmax(u_bnd[ax], fmax(abs(vw), gp1_half * abs(u_cell[ax] - vw)));
                    }
                }
                u_bound_x = u_bnd[0];
                u_bound_y = u_bnd[1];
                u_bound_z = u_bnd[2];
                if (solid_faces >= 2) {
                    acoustic_mult = (RealType)1.5;
                }
            }

            max_s = u_bound_x + u_bound_y + u_bound_z + (RealType)3.0 * c * acoustic_mult;
            if (fluid_frac && a_self < (RealType)(1.0 - 1.0e-6)) {
                max_s *= (RealType)(1.0f / FSI_ALPHA_CUT);
            }
        }
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
        (RealType*)d_max_s_buf,
        (const FluidFractionTile3D<RealType>*)d_fluid_frac_fsi,
        (const SolidVelocityTile3D*)d_solid_vel_fsi);

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
    vals.resize(12, 0.0f);
    if constexpr (IsMultiMaterial) {
        vals[10] = (float)cached_tile.arho1[c_idx];
        vals[11] = (float)cached_tile.arho2[c_idx];
    }
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
    int nx, int ny, int nz,
    const FluidFractionTile3D<RealType>* fluid_frac = nullptr) {

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
        bool has_cut_solid = fluid_frac && (fluid_frac[t_idx].alpha_f[c_idx] < (RealType)(1.0 - 1.0e-6));

        if (has_cut_solid || a1 > 1e-4 || a2 > 1e-4 || dp > 1e-3 * d_ambient_p || u2 > 1e-2) {
            atomicOr(&s_active, has_cut_solid ? 5 : 1);
            if (dp > 0.05 * d_ambient_p || u2 > 1.0) {
                if ((gx == 0 && d_bcXmin == 3) ||
                    (gx == nx - 1 && d_bcXmax == 3) ||
                    (gy == 0 && d_bcYmin == 3) ||
                    (gy == ny - 1 && d_bcYmax == 3) ||
                    (gz == 0 && d_bcZmin == 3) ||
                    (gz == nz - 1 && d_bcZmax == 3)) {
                    atomicOr(&s_active, 2);
                }
            }
        }
    }
    __syncthreads();

    if (threadIdx.x == 0) {
        temp_active[t_idx] = (uint8_t)s_active;
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
    if (!(act & 1)) {
        if (tx > 0 && temp_active[idx - 1]) act |= 1;
        if (tx < ntx - 1 && temp_active[idx + 1]) act |= 1;
        if (ty > 0 && temp_active[idx - ntx]) act |= 1;
        if (ty < nty - 1 && temp_active[idx + ntx]) act |= 1;
        if (tz > 0 && temp_active[idx - ntx * nty]) act |= 1;
        if (tz < ntz - 1 && temp_active[idx + ntx * nty]) act |= 1;
        if (!(act & 1)) {
            for (int dk = -1; dk <= 1 && !(act & 1); ++dk) {
                int nz_t = tz + dk;
                if (nz_t < 0 || nz_t >= ntz) continue;
                for (int dj = -1; dj <= 1 && !(act & 1); ++dj) {
                    int ny_t = ty + dj;
                    if (ny_t < 0 || ny_t >= nty) continue;
                    for (int di = -1; di <= 1; ++di) {
                        int nx_t = tx + di;
                        if (nx_t < 0 || nx_t >= ntx) continue;
                        if (temp_active[nx_t + ny_t * ntx + nz_t * ntx * nty] & 4) {
                            act |= 1;
                            break;
                        }
                    }
                }
            }
        }
    }
    active_tiles[idx] = (act & 3);
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
        nx, ny, nz,
        (const FluidFractionTile3D<RealType>*)d_fluid_frac_fsi
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
    uint8_t act = active_tiles[idx];
    if (act) {
        int pos = atomicAdd(active_count, 1) & 0x3FFFFFFF;
        active_tile_indices[pos] = idx;
        if (act & 2) {
            atomicOr(active_count, 0x40000000);
        }
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
    if (h_num_active_tiles & 0x40000000) {
        this->terminated = true;
        h_num_active_tiles &= 0x3FFFFFFF;
    }
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
    states_pred_synced = false;
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
    states_pred_synced = false;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::initializeFrom3D(const CFDBulkSnapshot3D& src, double x_expl, double y_expl, double z_expl, double R_remap, double src_x_expl, double src_y_expl, double src_z_expl) {
    ensure_paged_in();
    currentTime = 0.0;
    if (src.p.empty() || src.rho.empty()) return;
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (this->nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    double amb_rho = (this->ambient_rho > 0.0) ? this->ambient_rho : 1.225;
    double amb_p = (this->ambient_p > 0.0) ? this->ambient_p : 101325.0;
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

    remap_3d_to_3d(src, *this, x_expl, y_expl, z_expl, R_remap, src_x_expl, src_y_expl, src_z_expl);

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
    states_pred_synced = false;
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
        states_pred_synced = false;
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
        states_pred_synced = false;
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
    states_pred_synced = false;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setSpatialOrder(int order) { 
    spatialOrder = order; 
    constants_dirty = true;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setTemporalOrder(int order) { 
    if (order == 5) {
        spaceTimeScheme = SpaceTimeScheme3D::ADER_2;
        temporalOrder = 2;
    } else if (order == 6) {
        spaceTimeScheme = SpaceTimeScheme3D::ADER_3;
        temporalOrder = 3;
        if (!is_paged_out && !d_dW_dt) {
            int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
            int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
            int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
            int total_tiles = ntx * nty * ntz;
            CHECK_CUDA(cudaMalloc(&d_dW_dt, total_tiles * sizeof(PrimitivePredictorTile3D<RealType, IsMultiMaterial>)));
            CHECK_CUDA(cudaMemset(d_dW_dt, 0, total_tiles * sizeof(PrimitivePredictorTile3D<RealType, IsMultiMaterial>)));
        }
    } else {
        spaceTimeScheme = SpaceTimeScheme3D::MUSCL_HANCOCK;
        temporalOrder = (order == 1) ? 1 : 2;
    }
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

// Fluid-only ledger reduction. One block per 8x8x8 tile. Cells outside the domain (tile padding) and
// cells flagged solid by the FSI mask are excluded, so the result tracks only real fluid content.
// out layout per tile: [mass, mom_x, mom_y, mom_z, energy, jwl_mass, n_cells]
template <typename RealType, bool IsMultiMaterial>
__global__ void __launch_bounds__(512) reduce_fluid_ledger_kernel(
    const ConservativeTile3D<RealType, IsMultiMaterial>* U,
    const GeometryTile3D* geom,
    const FluidFractionTile3D<RealType>* fluid_frac,
    int nx, int ny, int nz, int ntx, int nty,
    int total_tiles,
    double* out
) {
    int t_idx = blockIdx.x;
    if (t_idx >= total_tiles) return;

    __shared__ double s[7][512];
    int tid = threadIdx.x;

    int tx = t_idx % ntx;
    int ty = (t_idx / ntx) % nty;
    int tz = t_idx / (ntx * nty);
    int gx = tx * 8 + (tid & 7);
    int gy = ty * 8 + ((tid >> 3) & 7);
    int gz = tz * 8 + (tid >> 6);

    double af = 0.0;
    if (gx < nx && gy < ny && gz < nz) {
        if (fluid_frac) {
            double raw = (double)fluid_frac[t_idx].alpha_f[tid];
            af = (raw <= (double)FSI_ALPHA_DEAD) ? 0.0 : (raw > 1.0 ? 1.0 : raw);
        } else {
            af = (geom && geom[t_idx].cells[tid].is_boundary) ? 0.0 : 1.0;
        }
    }

    double v[7] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
    if (af > 0.0) {
        v[0] = af * (double)U[t_idx].rho[tid];
        v[1] = af * (double)U[t_idx].rhoux[tid];
        v[2] = af * (double)U[t_idx].rhouy[tid];
        v[3] = af * (double)U[t_idx].rhouz[tid];
        v[4] = af * (double)U[t_idx].E[tid];
        if constexpr (IsMultiMaterial) v[5] = af * (double)U[t_idx].arho1[tid];
        v[6] = af;
    }
    for (int q = 0; q < 7; ++q) s[q][tid] = v[q];
    __syncthreads();

    for (unsigned int stride = 256; stride > 0; stride >>= 1) {
        if (tid < stride) {
            for (int q = 0; q < 7; ++q) s[q][tid] += s[q][tid + stride];
        }
        __syncthreads();
    }
    if (tid == 0) {
        for (int q = 0; q < 7; ++q) out[(size_t)t_idx * 7 + q] = s[q][0];
    }
}

template <typename RealType, bool IsMultiMaterial>
CFDFluidLedger3D CFDSolver3DCuda<RealType, IsMultiMaterial>::getFluidLedger() const {
    CFDFluidLedger3D led;
    // Paged-out state lives in host staging buffers with a different layout; the ledger is a
    // diagnostic so we report "unsupported" rather than silently returning a wrong number.
    if (is_paged_out || !d_U) return led;

    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;
    const double cell_vol = cellSize * cellSize * cellSize;

    double* d_out = nullptr;
    CHECK_CUDA(cudaMalloc(&d_out, (size_t)total_tiles * 7 * sizeof(double)));
    reduce_fluid_ledger_kernel<RealType, IsMultiMaterial><<<total_tiles, 512>>>(
        (const ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
        (const GeometryTile3D*)d_geom,
        d_fluid_frac_fsi,
        nx, ny, nz, ntx, nty, total_tiles, d_out);
    CHECK_CUDA(cudaGetLastError());
    CHECK_CUDA(cudaDeviceSynchronize());

    std::vector<double> h((size_t)total_tiles * 7);
    CHECK_CUDA(cudaMemcpy(h.data(), d_out, h.size() * sizeof(double), cudaMemcpyDeviceToHost));
    CHECK_CUDA(cudaFree(d_out));

    double acc[7] = {0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
    for (int t = 0; t < total_tiles; ++t)
        for (int q = 0; q < 7; ++q) acc[q] += h[(size_t)t * 7 + q];

    led.valid = true;
    led.mass = acc[0] * cell_vol;
    led.momentum[0] = acc[1] * cell_vol;
    led.momentum[1] = acc[2] * cell_vol;
    led.momentum[2] = acc[3] * cell_vol;
    led.energy = acc[4] * cell_vol;
    led.jwl_mass = acc[5] * cell_vol;
    led.fluid_cells = (long long)(acc[6] + 0.5);
    led.fluid_volume = acc[6] * cell_vol;
    return led;
}

template <typename RealType, bool IsMultiMaterial>
bool CFDSolver3DCuda<RealType, IsMultiMaterial>::downloadFluidDiagnostics(std::vector<uint8_t>& solid, std::vector<double>& rho) const {
    if (is_paged_out || !d_U) return false;
    const int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    const int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    const int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    const int total_tiles = ntx * nty * ntz;

    std::vector<ConservativeTile3D<RealType, IsMultiMaterial>> hU(total_tiles);
    CHECK_CUDA(cudaDeviceSynchronize());
    CHECK_CUDA(cudaMemcpy(hU.data(), d_U, (size_t)total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>), cudaMemcpyDeviceToHost));
    std::vector<GeometryTile3D> hG;
    if (d_geom) {
        hG.resize(total_tiles);
        CHECK_CUDA(cudaMemcpy(hG.data(), d_geom, (size_t)total_tiles * sizeof(GeometryTile3D), cudaMemcpyDeviceToHost));
    }
    std::vector<FluidFractionTile3D<RealType>> hF;
    if (d_fluid_frac_fsi) {
        hF.resize(total_tiles);
        CHECK_CUDA(cudaMemcpy(hF.data(), d_fluid_frac_fsi, (size_t)total_tiles * sizeof(FluidFractionTile3D<RealType>), cudaMemcpyDeviceToHost));
    }

    solid.assign((size_t)nx * ny * nz, 0);
    rho.assign((size_t)nx * ny * nz, 0.0);
    for (int k = 0; k < nz; ++k)
        for (int j = 0; j < ny; ++j)
            for (int i = 0; i < nx; ++i) {
                const int t = (i >> 3) + (j >> 3) * ntx + (k >> 3) * ntx * nty;
                const int c = (i & 7) + (j & 7) * 8 + (k & 7) * 64;
                const size_t idx = (size_t)i + (size_t)j * nx + (size_t)k * nx * ny;
                if (!hF.empty()) {
                    const double af = std::max(0.0, std::min(1.0, (double)hF[t].alpha_f[c]));
                    solid[idx] = (af <= (double)FSI_ALPHA_DEAD) ? 1 : 0;
                    rho[idx] = (double)hU[t].rho[c] * af;
                } else {
                    solid[idx] = (!hG.empty() && hG[t].cells[c].is_boundary) ? 1 : 0;
                    rho[idx] = solid[idx] ? 0.0 : (double)hU[t].rho[c];
                }
            }
    return true;
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
                        bool n_curr_solid = d_geom && d_geom[nt_idx].cells[nc_idx].is_boundary;
                        if (!n_prev_solid && !n_curr_solid) {
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

        RealType ext_rho = (RealType)d_ambient_rho;
        RealType ext_ux  = (RealType)0.0;
        RealType ext_uy  = (RealType)0.0;
        RealType ext_uz  = (RealType)0.0;
        RealType ext_p   = (RealType)d_ambient_p;
        RealType ext_a1  = (RealType)0.0;
        RealType ext_a2  = (RealType)0.0;
        RealType ext_ar1 = (RealType)0.0;
        RealType ext_ar2 = (RealType)0.0;

        if (sum_w > (RealType)1e-8) {
            RealType inv_w = (RealType)1.0 / sum_w;
            ext_rho = sum_rho * inv_w;
            ext_ux  = sum_ux * inv_w;
            ext_uy  = sum_uy * inv_w;
            ext_uz  = sum_uz * inv_w;
            ext_p   = sum_p * inv_w;
            if constexpr (IsMultiMaterial) {
                ext_a1  = sum_a1 * inv_w;
                ext_a2  = sum_a2 * inv_w;
                ext_ar1 = sum_arho1 * inv_w;
                ext_ar2 = sum_arho2 * inv_w;
            }
        }

        d_states[t_idx].rho[c_idx] = ext_rho;
        d_states[t_idx].ux[c_idx]  = ext_ux;
        d_states[t_idx].uy[c_idx]  = ext_uy;
        d_states[t_idx].uz[c_idx]  = ext_uz;
        d_states[t_idx].p[c_idx]   = ext_p;

        if constexpr (IsMultiMaterial) {
            d_states[t_idx].alpha1[c_idx] = ext_a1;
            d_states[t_idx].alpha2[c_idx] = ext_a2;
            d_states[t_idx].arho1[c_idx]  = ext_ar1;
            d_states[t_idx].arho2[c_idx]  = ext_ar2;
        }

        if (d_U) {
            d_U[t_idx].rho[c_idx]   = ext_rho;
            d_U[t_idx].rhoux[c_idx] = ext_rho * ext_ux;
            d_U[t_idx].rhouy[c_idx] = ext_rho * ext_uy;
            d_U[t_idx].rhouz[c_idx] = ext_rho * ext_uz;

            RealType ke = (RealType)0.5 * ext_rho * (ext_ux * ext_ux + ext_uy * ext_uy + ext_uz * ext_uz);
            RealType z_c = (RealType)d_zmin + ((RealType)gz + (RealType)0.5) * (RealType)d_cellSize;
            if constexpr (IsMultiMaterial) {
                if (is_cell_water(ext_rho, z_c, ext_a1 + ext_a2)) {
                    d_U[t_idx].E[c_idx] = MultiMat::getMixtureEnergyTait<RealType>(ext_p, ext_rho, ext_a1, ext_a2, ext_ar1, ext_ar2, d_taitParams, d_products, d_unreacted) + ke;
                } else {
                    d_U[t_idx].E[c_idx] = MultiMat::getMixtureEnergy<RealType>(ext_p, ext_rho, ext_a1, ext_a2, ext_ar1, ext_ar2, gamma, d_products, d_unreacted) + ke;
                }
                d_U[t_idx].alpha1[c_idx] = ext_a1;
                d_U[t_idx].alpha2[c_idx] = ext_a2;
                d_U[t_idx].arho1[c_idx]  = ext_ar1;
                d_U[t_idx].arho2[c_idx]  = ext_ar2;
            } else {
                d_U[t_idx].E[c_idx] = computeFluidEnergyGPU<RealType>(ext_p, ext_rho, gamma, z_c) + ke;
            }
        }
    }
}

// Lightweight GPU kernel: writes solid mask and 3x3x3 smooth normal directly into d_geom
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

    if (d_mask[cfd_idx] == 0) {
        d_geom[t_idx].cells[c_idx] = pack_geometry_payload(false, 0.0f, 0.0f, 0.0f, 0.0f);
        return;
    }
    float gx_sum = 0.0f, gy_sum = 0.0f, gz_sum = 0.0f;
    for (int dk = -1; dk <= 1; ++dk) {
        int nk = min(max(gz + dk, 0), nz - 1);
        for (int dj = -1; dj <= 1; ++dj) {
            int nj = min(max(gy + dj, 0), ny - 1);
            for (int di = -1; di <= 1; ++di) {
                if (di == 0 && dj == 0 && dk == 0) continue;
                int ni = min(max(gx + di, 0), nx - 1);
                float val = (d_mask[ni + nj * nx + nk * nx * ny] != 0) ? 1.0f : 0.0f;
                float w = 1.0f / static_cast<float>(di * di + dj * dj + dk * dk);
                gx_sum += w * static_cast<float>(di) * val;
                gy_sum += w * static_cast<float>(dj) * val;
                gz_sum += w * static_cast<float>(dk) * val;
            }
        }
    }
    float g_len = sqrtf(gx_sum * gx_sum + gy_sum * gy_sum + gz_sum * gz_sum);
    float nx_n = (g_len > 1.0e-6f) ? (-gx_sum / g_len) : 0.0f;
    float ny_n = (g_len > 1.0e-6f) ? (-gy_sum / g_len) : 0.0f;
    float nz_n = (g_len > 1.0e-6f) ? (-gz_sum / g_len) : 0.0f;
    d_geom[t_idx].cells[c_idx] = pack_geometry_payload(true, nx_n, ny_n, nz_n, 1.0f);
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

static __device__ inline long long resolve_fsi_mpm_slot(int x, int y, int z, int nx, int ny, int nz, const Blast::MPMGridView3D& gv) {
    if (x < 0 || x >= nx || y < 0 || y >= ny || z < 0 || z >= nz) return -1;
    if (gv.nx > 0) return gv.slotIndex(x, y, z);
    return static_cast<long long>((static_cast<size_t>(x) * ny + y) * nz + z);
}

static __device__ inline float get_mpm_total_mass_at(const Blast::MPMGridNode3D* grid, int x, int y, int z, int nx, int ny, int nz, const Blast::MPMGridView3D& gv = {}) {
    const long long slot = resolve_fsi_mpm_slot(x, y, z, nx, ny, nz, gv);
    return (slot >= 0) ? grid[slot].m : 0.0f;
}

#ifndef BLAST_FSI_WALL_ALPHA_OVERRIDE
constexpr float FSI_SOLID_WALL_ALPHA_THRESH = 0.14f;
#else
// Sensitivity-study build only (-DBLAST_FSI_WALL_ALPHA_OVERRIDE=<value>). Not for production.
constexpr float FSI_SOLID_WALL_ALPHA_THRESH = BLAST_FSI_WALL_ALPHA_OVERRIDE;
#endif

static __device__ inline float get_mpm_solid_mass_at(const Blast::MPMGridNode3D* grid, int x, int y, int z, int nx, int ny, int nz, const Blast::MPMGridView3D& gv = {}) {
    const long long slot = resolve_fsi_mpm_slot(x, y, z, nx, ny, nz, gv);
    return (slot >= 0) ? grid[slot].m_solid : 0.0f;
}

static __device__ inline float get_mpm_solid_vol_at(const Blast::MPMGridNode3D* grid, int x, int y, int z, int nx, int ny, int nz, const Blast::MPMGridView3D& gv = {}) {
    const long long slot = resolve_fsi_mpm_slot(x, y, z, nx, ny, nz, gv);
    return (slot >= 0) ? grid[slot].v_solid : 0.0f;
}

static __device__ inline float get_mpm_mass_at(const Blast::MPMGridNode3D* grid, int x, int y, int z, int nx, int ny, int nz, const Blast::MPMGridView3D& gv = {}) {
    return get_mpm_solid_mass_at(grid, x, y, z, nx, ny, nz, gv);
}

static __device__ inline bool is_fsi_fluid_cell(const Blast::MPMGridNode3D* d_grid, int gx, int gy, int gz, int nx, int ny, int nz, float cell_vol, const Blast::MPMGridView3D& gv = {}) {
    if (gx < 0 || gx >= nx || gy < 0 || gy >= ny || gz < 0 || gz >= nz) return false;
    const long long slot = resolve_fsi_mpm_slot(gx, gy, gz, nx, ny, nz, gv);
    return (slot < 0) ? true : (d_grid[slot].v_solid < FSI_SOLID_WALL_ALPHA_THRESH * cell_vol);
}

static __device__ inline void compute_fsi_smooth_normal_3x3x3(
    const Blast::MPMGridNode3D* d_grid,
    int cx, int cy, int cz,
    int nx, int ny, int nz,
    const Blast::MPMGridView3D& gv,
    float& nx_out, float& ny_out, float& nz_out)
{
    float gx_sum = 0.0f, gy_sum = 0.0f, gz_sum = 0.0f;
    for (int dk = -1; dk <= 1; ++dk) {
        int nk = min(max(cz + dk, 0), nz - 1);
        for (int dj = -1; dj <= 1; ++dj) {
            int nj = min(max(cy + dj, 0), ny - 1);
            for (int di = -1; di <= 1; ++di) {
                if (di == 0 && dj == 0 && dk == 0) continue;
                int ni = min(max(cx + di, 0), nx - 1);
                float vs = get_mpm_solid_vol_at(d_grid, ni, nj, nk, nx, ny, nz, gv);
                float w = 1.0f / static_cast<float>(di * di + dj * dj + dk * dk);
                gx_sum += w * static_cast<float>(di) * vs;
                gy_sum += w * static_cast<float>(dj) * vs;
                gz_sum += w * static_cast<float>(dk) * vs;
            }
        }
    }
    float g_len = sqrtf(gx_sum * gx_sum + gy_sum * gy_sum + gz_sum * gz_sum);
    if (g_len > 1.0e-20f) {
        float inv_g = 1.0f / g_len;
        nx_out = -gx_sum * inv_g;
        ny_out = -gy_sum * inv_g;
        nz_out = -gz_sum * inv_g;
    } else {
        nx_out = 0.0f;
        ny_out = 0.0f;
        nz_out = 0.0f;
    }
}

static __global__ void kernel_zero_fsi_grid_ext_forces(Blast::MPMGridNode3D* d_grid, const int* d_active_nodes, int num_active, Blast::MPMGridView3D gv = {}) {
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= num_active) return;
    int idx = d_active_nodes[tid];
    const long long slot = (gv.nx > 0) ? gv.slotIndexFromLogical(idx) : static_cast<long long>(idx);
    if (slot < 0) return;
    d_grid[slot].f_ext[0] = 0.0f;
    d_grid[slot].f_ext[1] = 0.0f;
    d_grid[slot].f_ext[2] = 0.0f;
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
    float dx, float dy, float dz,
    Blast::MPMGridView3D gv = {}
) {
    int gx = blockIdx.x * blockDim.x + threadIdx.x;
    int gy = blockIdx.y * blockDim.y + threadIdx.y;
    int gz = blockIdx.z * blockDim.z + threadIdx.z;

    if (gx >= nx || gy >= ny || gz >= nz) return;

    const long long mpm_slot = resolve_fsi_mpm_slot(gx, gy, gz, nx, ny, nz, gv);
    if (mpm_slot < 0) return;
    float mass = d_grid[mpm_slot].m;
    if (mass <= 1.0e-8f) {
        d_grid[mpm_slot].f_ext[0] = 0.0f;
        d_grid[mpm_slot].f_ext[1] = 0.0f;
        d_grid[mpm_slot].f_ext[2] = 0.0f;
        return;
    }
    float cell_vol = fmaxf(dx * dy * dz, 1.0e-30f);
    float solid_mass = d_grid[mpm_slot].m_solid;
    float v_solid_self = d_grid[mpm_slot].v_solid;
    float alpha_s = v_solid_self / cell_vol;
    bool is_solid = (solid_mass > 1.0e-8f) || (v_solid_self > 1.0e-20f);

    int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

    float vx = d_grid[mpm_slot].p[0] / mass;
    float vy = d_grid[mpm_slot].p[1] / mass;
    float vz = d_grid[mpm_slot].p[2] / mass;

    float z_node = static_cast<float>(d_zmin) + (static_cast<float>(gz) + 0.5f) * dz;
    bool is_wall_cell = (alpha_s >= FSI_SOLID_WALL_ALPHA_THRESH) &&
                        (!d_stratParams.enabled || z_node >= static_cast<float>(d_stratParams.seabed_surface_z));

    if (d_zonalParams.enabled) {
        float x_node = static_cast<float>(d_xmin) + (static_cast<float>(gx) + 0.5f) * dx;
        float y_node = static_cast<float>(d_ymin) + (static_cast<float>(gy) + 0.5f) * dy;
        float dx_rel = x_node - static_cast<float>(d_zonalParams.center_x);
        float dy_rel = y_node - static_cast<float>(d_zonalParams.center_y);
        float dz_rel = z_node - static_cast<float>(d_zonalParams.center_z);
        float r = d_zonalParams.is_cylinder ? sqrtf(dx_rel * dx_rel + dy_rel * dy_rel) : sqrtf(dx_rel * dx_rel + dy_rel * dy_rel + dz_rel * dz_rel);
        if (r < static_cast<float>(d_zonalParams.sleeve_radius)) {
            is_wall_cell = false;
        }
    }

    if (d_solid_vel && is_wall_cell) {
        d_solid_vel[t_idx].vx[c_idx] = vx;
        d_solid_vel[t_idx].vy[c_idx] = vy;
        d_solid_vel[t_idx].vz[c_idx] = vz;
    }

    if (d_geom) {
        if (is_wall_cell) {
            float nx_normal = 0.0f, ny_normal = 0.0f, nz_normal = 0.0f;
            compute_fsi_smooth_normal_3x3x3(d_grid, gx, gy, gz, nx, ny, nz, gv, nx_normal, ny_normal, nz_normal);
            d_geom[t_idx].cells[c_idx] = pack_geometry_payload(true, nx_normal, ny_normal, nz_normal, fminf(1.0f, alpha_s));
        } else {
            d_geom[t_idx].cells[c_idx] = pack_geometry_payload(false, 0.0f, 0.0f, 0.0f, 0.0f);
        }
    }

    float f_x = 0.0f;
    float f_y = 0.0f;
    float f_z = 0.0f;

    float p_L = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx - 1, gy, gz, nx, ny, nz, ntx, nty);
    float p_R = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx + 1, gy, gz, nx, ny, nz, ntx, nty);
    float p_B = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy - 1, gz, nx, ny, nz, ntx, nty);
    float p_T = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy + 1, gz, nx, ny, nz, ntx, nty);
    float p_D = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy, gz - 1, nx, ny, nz, ntx, nty);
    float p_U = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy, gz + 1, nx, ny, nz, ntx, nty);

    float m_L = get_mpm_total_mass_at(d_grid, gx - 1, gy, gz, nx, ny, nz, gv);
    float m_R = get_mpm_total_mass_at(d_grid, gx + 1, gy, gz, nx, ny, nz, gv);
    float m_B = get_mpm_total_mass_at(d_grid, gx, gy - 1, gz, nx, ny, nz, gv);
    float m_T = get_mpm_total_mass_at(d_grid, gx, gy + 1, gz, nx, ny, nz, gv);
    float m_D = get_mpm_total_mass_at(d_grid, gx, gy, gz - 1, nx, ny, nz, gv);
    float m_U = get_mpm_total_mass_at(d_grid, gx, gy, gz + 1, nx, ny, nz, gv);

    int n_fluid_faces = 0;
    if (is_wall_cell) {
        if (gx > 0 && is_fsi_fluid_cell(d_grid, gx - 1, gy, gz, nx, ny, nz, cell_vol, gv)) {
            f_x += p_L; n_fluid_faces++;
        }
        if (is_fsi_fluid_cell(d_grid, gx + 1, gy, gz, nx, ny, nz, cell_vol, gv)) {
            f_x -= p_R; n_fluid_faces++;
        }

        if (gy > 0 && is_fsi_fluid_cell(d_grid, gx, gy - 1, gz, nx, ny, nz, cell_vol, gv)) {
            f_y += p_B; n_fluid_faces++;
        }
        if (is_fsi_fluid_cell(d_grid, gx, gy + 1, gz, nx, ny, nz, cell_vol, gv)) {
            f_y -= p_T; n_fluid_faces++;
        }

        if (is_fsi_fluid_cell(d_grid, gx, gy, gz - 1, nx, ny, nz, cell_vol, gv)) {
            f_z += p_D; n_fluid_faces++;
        }
        if (is_fsi_fluid_cell(d_grid, gx, gy, gz + 1, nx, ny, nz, cell_vol, gv)) {
            f_z -= p_U; n_fluid_faces++;
        }
        if (gx <= 0) f_x = 0.0f;
        if (gy <= 0) f_y = 0.0f;
    } else {
        f_x = (gx <= 0) ? 0.0f : (p_L - p_R);
        f_y = (gy <= 0) ? 0.0f : (p_B - p_T);
        f_z = p_D - p_U;
    }

    float density_ref = is_solid ? 2400.0f : 1000.0f;
    float body_vol = (v_solid_self > 1.0e-20f) ? v_solid_self : (mass / density_ref);

    float F_x = 0.0f, F_y = 0.0f, F_z = 0.0f;

    if (is_wall_cell) {
        F_x = f_x * dy * dz;
        F_y = f_y * dx * dz;
        F_z = f_z * dx * dy;
    } else if (is_solid) {
        float V_eff = fminf(cell_vol, body_vol);
        float grad_px = f_x / (2.0f * dx);
        float grad_py = f_y / (2.0f * dy);
        float grad_pz = f_z / (2.0f * dz);
        F_x = grad_px * V_eff;
        F_y = grad_py * V_eff;
        F_z = grad_pz * V_eff;
    } else {
        F_x = 0.0f;
        F_y = 0.0f;
        F_z = 0.0f;
        if (m_L <= 1.0e-8f) F_x += p_L * dy * dz;
        if (m_R <= 1.0e-8f) F_x -= p_R * dy * dz;
        if (m_B <= 1.0e-8f) F_y += p_B * dx * dz;
        if (m_T <= 1.0e-8f) F_y -= p_T * dx * dz;
        if (m_D <= 1.0e-8f) F_z += p_D * dx * dy;
        if (m_U <= 1.0e-8f) F_z -= p_U * dx * dy;

        if (m_L > 1.0e-8f && m_R > 1.0e-8f) {
            float grad_px = f_x / (2.0f * dx);
            F_x += grad_px * cell_vol;
        }
        if (m_B > 1.0e-8f && m_T > 1.0e-8f) {
            float grad_py = f_y / (2.0f * dy);
            F_y += grad_py * cell_vol;
        }
        if (m_D > 1.0e-8f && m_U > 1.0e-8f) {
            float grad_pz = f_z / (2.0f * dz);
            F_z += grad_pz * cell_vol;
        }
    }

    // Sub-grid aerodynamic/hydrodynamic drag strictly on permeable particles (!is_wall_cell),
    // evaluated race-free from read-only d_grid volume fractions.
    int n_fluid_neighbors = n_fluid_faces;
    if (!is_wall_cell && is_solid) {
        float u_f_sum = 0.0f, v_f_sum = 0.0f, w_f_sum = 0.0f, rho_f_sum = 0.0f, p_f_sum = 0.0f;
        n_fluid_neighbors = 0;

        auto sample_fsi_fluid_state = [&](int n_gx, int n_gy, int n_gz) {
            if (is_fsi_fluid_cell(d_grid, n_gx, n_gy, n_gz, nx, ny, nz, cell_vol, gv)) {
                int n_t = (n_gx >> 3) + (n_gy >> 3) * ntx + (n_gz >> 3) * ntx * nty;
                int n_c = (n_gx & 7) + (n_gy & 7) * 8 + (n_gz & 7) * 64;
                u_f_sum += static_cast<float>(d_states[n_t].ux[n_c]);
                v_f_sum += static_cast<float>(d_states[n_t].uy[n_c]);
                w_f_sum += static_cast<float>(d_states[n_t].uz[n_c]);
                rho_f_sum += static_cast<float>(d_states[n_t].rho[n_c]);
                p_f_sum += static_cast<float>(d_states[n_t].p[n_c]);
                n_fluid_neighbors++;
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

            float A_proj = 1.21f * powf(fmaxf(1.0e-12f, body_vol), 0.6666667f);
            float A_x = fminf(dy * dz, A_proj);
            float A_y = fminf(dx * dz, A_proj);
            float A_z = fminf(dx * dy, A_proj);

            F_x += 0.5f * Cd * rho_f * A_x * rel_v_mag * rel_vx * exposure;
            F_y += 0.5f * Cd * rho_f * A_y * rel_v_mag * rel_vy * exposure;
            F_z += 0.5f * Cd * rho_f * A_z * rel_v_mag * rel_vz * exposure;
        }
    }

    if (!is_wall_cell || n_fluid_neighbors >= 2) {
        if (fabsf(F_x) > 1.0e-12f) atomicAdd(&d_grid[mpm_slot].f_ext[0], F_x);
        if (fabsf(F_y) > 1.0e-12f) atomicAdd(&d_grid[mpm_slot].f_ext[1], F_y);
        if (fabsf(F_z) > 1.0e-12f) atomicAdd(&d_grid[mpm_slot].f_ext[2], F_z);
    } else {
        // Continuous structural solid: mass-weighted distribution across local solid column stencil
        if (fabsf(F_z) > 1.0e-12f) {
            float mass_z_stencil = 0.0f;
            for (int dk = -2; dk <= 2; ++dk) {
                int k_c = gz + dk;
                const long long k_slot = resolve_fsi_mpm_slot(gx, gy, k_c, nx, ny, nz, gv);
                if (k_slot >= 0 && d_grid[k_slot].m > 1.0e-8f) mass_z_stencil += d_grid[k_slot].m;
            }
            if (mass_z_stencil > 1.0e-12f) {
                for (int dk = -2; dk <= 2; ++dk) {
                    int k_c = gz + dk;
                    const long long k_slot = resolve_fsi_mpm_slot(gx, gy, k_c, nx, ny, nz, gv);
                    if (k_slot >= 0 && d_grid[k_slot].m > 1.0e-8f) {
                        atomicAdd(&d_grid[k_slot].f_ext[2], F_z * (d_grid[k_slot].m / mass_z_stencil));
                    }
                }
            } else {
                atomicAdd(&d_grid[mpm_slot].f_ext[2], F_z);
            }
        }

        if (fabsf(F_x) > 1.0e-12f) {
            float mass_x_stencil = 0.0f;
            for (int di = -2; di <= 2; ++di) {
                int i_c = gx + di;
                const long long i_slot = resolve_fsi_mpm_slot(i_c, gy, gz, nx, ny, nz, gv);
                if (i_slot >= 0 && d_grid[i_slot].m > 1.0e-8f) mass_x_stencil += d_grid[i_slot].m;
            }
            if (mass_x_stencil > 1.0e-12f) {
                for (int di = -2; di <= 2; ++di) {
                    int i_c = gx + di;
                    const long long i_slot = resolve_fsi_mpm_slot(i_c, gy, gz, nx, ny, nz, gv);
                    if (i_slot >= 0 && d_grid[i_slot].m > 1.0e-8f) {
                        atomicAdd(&d_grid[i_slot].f_ext[0], F_x * (d_grid[i_slot].m / mass_x_stencil));
                    }
                }
            } else {
                atomicAdd(&d_grid[mpm_slot].f_ext[0], F_x);
            }
        }

        if (fabsf(F_y) > 1.0e-12f) {
            float mass_y_stencil = 0.0f;
            for (int dj = -2; dj <= 2; ++dj) {
                int j_c = gy + dj;
                const long long j_slot = resolve_fsi_mpm_slot(gx, j_c, gz, nx, ny, nz, gv);
                if (j_slot >= 0 && d_grid[j_slot].m > 1.0e-8f) mass_y_stencil += d_grid[j_slot].m;
            }
            if (mass_y_stencil > 1.0e-12f) {
                for (int dj = -2; dj <= 2; ++dj) {
                    int j_c = gy + dj;
                    const long long j_slot = resolve_fsi_mpm_slot(gx, j_c, gz, nx, ny, nz, gv);
                    if (j_slot >= 0 && d_grid[j_slot].m > 1.0e-8f) {
                        atomicAdd(&d_grid[j_slot].f_ext[1], F_y * (d_grid[j_slot].m / mass_y_stencil));
                    }
                }
            } else {
                atomicAdd(&d_grid[mpm_slot].f_ext[1], F_y);
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
    float xmin_mpm, float ymin_mpm, float zmin_mpm,
    Blast::MPMGridView3D gv = {}
) {
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= num_active_nodes) return;

    int mpm_idx = d_active_nodes[tid];
    const long long mpm_slot = (gv.nx > 0) ? gv.slotIndexFromLogical(mpm_idx) : static_cast<long long>(mpm_idx);
    if (mpm_slot < 0) return;

    float mass = d_grid[mpm_slot].m;
    if (mass <= 1.0e-8f) {
        d_grid[mpm_slot].f_ext[0] = 0.0f;
        d_grid[mpm_slot].f_ext[1] = 0.0f;
        d_grid[mpm_slot].f_ext[2] = 0.0f;
        return;
    }
    float cell_vol_mpm = fmaxf(dx_mpm * dy_mpm * dz_mpm, 1.0e-30f);
    float solid_mass = d_grid[mpm_slot].m_solid;
    float v_solid_self = d_grid[mpm_slot].v_solid;
    float alpha_s = v_solid_self / cell_vol_mpm;
    bool is_solid = (solid_mass > 1.0e-8f) || (v_solid_self > 1.0e-20f);

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

    float vx = d_grid[mpm_slot].p[0] / mass;
    float vy = d_grid[mpm_slot].p[1] / mass;
    float vz = d_grid[mpm_slot].p[2] / mass;
    bool is_wall_cell = (alpha_s >= FSI_SOLID_WALL_ALPHA_THRESH) &&
                        (!d_stratParams.enabled || z_node >= static_cast<float>(d_stratParams.seabed_surface_z));

    if (d_zonalParams.enabled) {
        float dx_rel = x_node - static_cast<float>(d_zonalParams.center_x);
        float dy_rel = y_node - static_cast<float>(d_zonalParams.center_y);
        float dz_rel = z_node - static_cast<float>(d_zonalParams.center_z);
        float r = d_zonalParams.is_cylinder ? sqrtf(dx_rel * dx_rel + dy_rel * dy_rel) : sqrtf(dx_rel * dx_rel + dy_rel * dy_rel + dz_rel * dz_rel);
        if (r < static_cast<float>(d_zonalParams.sleeve_radius)) {
            is_wall_cell = false;
        }
    }

    if (d_solid_vel && is_wall_cell) {
        d_solid_vel[t_idx].vx[c_idx] = vx;
        d_solid_vel[t_idx].vy[c_idx] = vy;
        d_solid_vel[t_idx].vz[c_idx] = vz;
    }

    // Only intact continuum solid & unreacted energetic bodies (alpha_s >= 0.22) mark impermeable wall boundaries in CFD;
    // seabed soil foundation, B-spline fringe tails, and detached failed spall fragments remain permeable sub-grid media.
    if (d_geom && is_wall_cell) {
        float nx_normal = 0.0f, ny_normal = 0.0f, nz_normal = 0.0f;
        compute_fsi_smooth_normal_3x3x3(d_grid, i_mpm, j_mpm, k_mpm, nx_mpm, ny_mpm, nz_mpm, gv, nx_normal, ny_normal, nz_normal);
        d_geom[t_idx].cells[c_idx] = pack_geometry_payload(true, nx_normal, ny_normal, nz_normal, fminf(1.0f, alpha_s));
    }

    float f_x = 0.0f;
    float f_y = 0.0f;
    float f_z = 0.0f;

    float p_L = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx - 1, gy, gz, nx_cfd, ny_cfd, nz_cfd, ntx, nty);
    float p_R = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx + 1, gy, gz, nx_cfd, ny_cfd, nz_cfd, ntx, nty);
    float p_B = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy - 1, gz, nx_cfd, ny_cfd, nz_cfd, ntx, nty);
    float p_T = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy + 1, gz, nx_cfd, ny_cfd, nz_cfd, ntx, nty);
    float p_D = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy, gz - 1, nx_cfd, ny_cfd, nz_cfd, ntx, nty);
    float p_U = get_fsi_pressure_at<RealType, IsMultiMaterial>(d_states, gx, gy, gz + 1, nx_cfd, ny_cfd, nz_cfd, ntx, nty);

    int n_fluid_faces = 0;
    if (is_wall_cell) {
        if (i_mpm > 0 && gx > 0 && is_fsi_fluid_cell(d_grid, i_mpm - 1, j_mpm, k_mpm, nx_mpm, ny_mpm, nz_mpm, cell_vol_mpm, gv)) {
            f_x += p_L; n_fluid_faces++;
        }
        if (is_fsi_fluid_cell(d_grid, i_mpm + 1, j_mpm, k_mpm, nx_mpm, ny_mpm, nz_mpm, cell_vol_mpm, gv)) {
            f_x -= p_R; n_fluid_faces++;
        }

        if (j_mpm > 0 && gy > 0 && is_fsi_fluid_cell(d_grid, i_mpm, j_mpm - 1, k_mpm, nx_mpm, ny_mpm, nz_mpm, cell_vol_mpm, gv)) {
            f_y += p_B; n_fluid_faces++;
        }
        if (is_fsi_fluid_cell(d_grid, i_mpm, j_mpm + 1, k_mpm, nx_mpm, ny_mpm, nz_mpm, cell_vol_mpm, gv)) {
            f_y -= p_T; n_fluid_faces++;
        }

        if (is_fsi_fluid_cell(d_grid, i_mpm, j_mpm, k_mpm - 1, nx_mpm, ny_mpm, nz_mpm, cell_vol_mpm, gv)) {
            f_z += p_D; n_fluid_faces++;
        }
        if (is_fsi_fluid_cell(d_grid, i_mpm, j_mpm, k_mpm + 1, nx_mpm, ny_mpm, nz_mpm, cell_vol_mpm, gv)) {
            f_z -= p_U; n_fluid_faces++;
        }
        if (i_mpm <= 0 || gx <= 0) f_x = 0.0f;
        if (j_mpm <= 0 || gy <= 0) f_y = 0.0f;
    } else {
        f_x = (i_mpm <= 0 || gx <= 0) ? 0.0f : (p_L - p_R);
        f_y = (j_mpm <= 0 || gy <= 0) ? 0.0f : (p_B - p_T);
        f_z = p_D - p_U;
    }

    float density_ref = is_solid ? 2400.0f : 1000.0f;
    float body_vol = (v_solid_self > 1.0e-20f) ? v_solid_self : (mass / density_ref);

    float F_x = 0.0f, F_y = 0.0f, F_z = 0.0f;

    if (is_wall_cell) {
        // Continuum solid boundary: full macroscopic cell face pressure
        F_x = f_x * dy_cfd * dz_cfd;
        F_y = f_y * dx_cfd * dz_cfd;
        F_z = f_z * dx_cfd * dy_cfd;
    } else if (is_solid) {
        // Sub-grid solid debris: volumetric pressure gradient force F = -V_eff * grad(P) (buoyancy)
        float V_eff = fminf(cell_vol_mpm, body_vol);
        float grad_px = f_x / (2.0f * dx_cfd);
        float grad_py = f_y / (2.0f * dy_cfd);
        float grad_pz = f_z / (2.0f * dz_cfd);
        F_x = grad_px * V_eff;
        F_y = grad_py * V_eff;
        F_z = grad_pz * V_eff;
    } else {
        // Fluid sleeve (water particles embedded in Eulerian CFD)
        F_x = 0.0f;
        F_y = 0.0f;
        F_z = 0.0f;
    }

    // Sub-grid aerodynamic drag strictly on permeable solid debris/soil (!is_wall_cell),
    // evaluated race-free from read-only d_grid volume fractions.
    int n_fluid_neighbors = n_fluid_faces;
    if (!is_wall_cell && is_solid) {
        float u_f_sum = 0.0f, v_f_sum = 0.0f, w_f_sum = 0.0f, rho_f_sum = 0.0f, p_f_sum = 0.0f;
        n_fluid_neighbors = 0;

        auto sample_fsi_fluid_state = [&](int n_gx, int n_gy, int n_gz, int n_im, int n_jm, int n_km) {
            if (n_gx >= 0 && n_gx < nx_cfd && n_gy >= 0 && n_gy < ny_cfd && n_gz >= 0 && n_gz < nz_cfd &&
                is_fsi_fluid_cell(d_grid, n_im, n_jm, n_km, nx_mpm, ny_mpm, nz_mpm, cell_vol_mpm, gv)) {
                int n_t = (n_gx >> 3) + (n_gy >> 3) * ntx + (n_gz >> 3) * ntx * nty;
                int n_c = (n_gx & 7) + (n_gy & 7) * 8 + (n_gz & 7) * 64;
                u_f_sum += static_cast<float>(d_states[n_t].ux[n_c]);
                v_f_sum += static_cast<float>(d_states[n_t].uy[n_c]);
                w_f_sum += static_cast<float>(d_states[n_t].uz[n_c]);
                rho_f_sum += static_cast<float>(d_states[n_t].rho[n_c]);
                p_f_sum += static_cast<float>(d_states[n_t].p[n_c]);
                n_fluid_neighbors++;
            }
        };

        sample_fsi_fluid_state(gx - 1, gy, gz, i_mpm - 1, j_mpm, k_mpm);
        sample_fsi_fluid_state(gx + 1, gy, gz, i_mpm + 1, j_mpm, k_mpm);
        sample_fsi_fluid_state(gx, gy - 1, gz, i_mpm, j_mpm - 1, k_mpm);
        sample_fsi_fluid_state(gx, gy + 1, gz, i_mpm, j_mpm + 1, k_mpm);
        sample_fsi_fluid_state(gx, gy, gz - 1, i_mpm, j_mpm, k_mpm - 1);
        sample_fsi_fluid_state(gx, gy, gz + 1, i_mpm, j_mpm, k_mpm + 1);
        sample_fsi_fluid_state(gx, gy, gz,     i_mpm, j_mpm, k_mpm);

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

            float A_proj = 1.21f * powf(fmaxf(1.0e-12f, body_vol), 0.6666667f);
            float A_x = fminf(dy_cfd * dz_cfd, A_proj);
            float A_y = fminf(dx_cfd * dz_cfd, A_proj);
            float A_z = fminf(dx_cfd * dy_cfd, A_proj);

            F_x += 0.5f * Cd * rho_f * A_x * rel_v_mag * rel_vx * exposure;
            F_y += 0.5f * Cd * rho_f * A_y * rel_v_mag * rel_vy * exposure;
            F_z += 0.5f * Cd * rho_f * A_z * rel_v_mag * rel_vz * exposure;
        }
    }

    // Physical acceleration limiter: prevent divide-by-small-mass numerical runaway on sub-grid debris
    if (mass > 1.0e-8f && !is_wall_cell) {
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
    if (!is_wall_cell || n_fluid_neighbors >= 2) {
        if (fabsf(F_x) > 1.0e-12f) atomicAdd(&d_grid[mpm_slot].f_ext[0], F_x);
        if (fabsf(F_y) > 1.0e-12f) atomicAdd(&d_grid[mpm_slot].f_ext[1], F_y);
        if (fabsf(F_z) > 1.0e-12f) atomicAdd(&d_grid[mpm_slot].f_ext[2], F_z);
    } else {
        if (fabsf(F_z) > 1.0e-12f) {
            float mass_z_stencil = 0.0f;
            for (int dk = -2; dk <= 2; ++dk) {
                int k_c = k_mpm + dk;
                const long long k_slot = resolve_fsi_mpm_slot(i_mpm, j_mpm, k_c, nx_mpm, ny_mpm, nz_mpm, gv);
                if (k_slot >= 0 && d_grid[k_slot].m > 1.0e-8f) mass_z_stencil += d_grid[k_slot].m;
            }
            if (mass_z_stencil > 1.0e-12f) {
                for (int dk = -2; dk <= 2; ++dk) {
                    int k_c = k_mpm + dk;
                    const long long k_slot = resolve_fsi_mpm_slot(i_mpm, j_mpm, k_c, nx_mpm, ny_mpm, nz_mpm, gv);
                    if (k_slot >= 0 && d_grid[k_slot].m > 1.0e-8f) {
                        atomicAdd(&d_grid[k_slot].f_ext[2], F_z * (d_grid[k_slot].m / mass_z_stencil));
                    }
                }
            } else {
                atomicAdd(&d_grid[mpm_slot].f_ext[2], F_z);
            }
        }

        if (fabsf(F_x) > 1.0e-12f) {
            float mass_x_stencil = 0.0f;
            for (int di = -2; di <= 2; ++di) {
                int i_c = i_mpm + di;
                const long long i_slot = resolve_fsi_mpm_slot(i_c, j_mpm, k_mpm, nx_mpm, ny_mpm, nz_mpm, gv);
                if (i_slot >= 0 && d_grid[i_slot].m > 1.0e-8f) mass_x_stencil += d_grid[i_slot].m;
            }
            if (mass_x_stencil > 1.0e-12f) {
                for (int di = -2; di <= 2; ++di) {
                    int i_c = i_mpm + di;
                    const long long i_slot = resolve_fsi_mpm_slot(i_c, j_mpm, k_mpm, nx_mpm, ny_mpm, nz_mpm, gv);
                    if (i_slot >= 0 && d_grid[i_slot].m > 1.0e-8f) {
                        atomicAdd(&d_grid[i_slot].f_ext[0], F_x * (d_grid[i_slot].m / mass_x_stencil));
                    }
                }
            } else {
                atomicAdd(&d_grid[mpm_slot].f_ext[0], F_x);
            }
        }

        if (fabsf(F_y) > 1.0e-12f) {
            float mass_y_stencil = 0.0f;
            for (int dj = -2; dj <= 2; ++dj) {
                int j_c = j_mpm + dj;
                const long long j_slot = resolve_fsi_mpm_slot(i_mpm, j_c, k_mpm, nx_mpm, ny_mpm, nz_mpm, gv);
                if (j_slot >= 0 && d_grid[j_slot].m > 1.0e-8f) mass_y_stencil += d_grid[j_slot].m;
            }
            if (mass_y_stencil > 1.0e-12f) {
                for (int dj = -2; dj <= 2; ++dj) {
                    int j_c = j_mpm + dj;
                    const long long j_slot = resolve_fsi_mpm_slot(i_mpm, j_c, k_mpm, nx_mpm, ny_mpm, nz_mpm, gv);
                    if (j_slot >= 0 && d_grid[j_slot].m > 1.0e-8f) {
                        atomicAdd(&d_grid[j_slot].f_ext[1], F_y * (d_grid[j_slot].m / mass_y_stencil));
                    }
                }
            } else {
                atomicAdd(&d_grid[mpm_slot].f_ext[1], F_y);
            }
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
__device__ inline RealType get_fsi_neighbor_fluid_pressure(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    const Blast::MPMGridNode3D* d_grid,
    const GeometryTile3D* d_geom,
    int gx, int gy, int gz,
    int nx, int ny, int nz,
    int ntx, int nty,
    const Blast::MPMGridView3D& gv = {},
    RealType* out_rho = nullptr
) {
    int t_idx_self = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx_self = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;
    RealType self_p   = d_states[t_idx_self].p[c_idx_self];
    RealType self_rho = d_states[t_idx_self].rho[c_idx_self];
    RealType sum_p   = 0.0;
    RealType sum_rho = 0.0;
    int count = 0;

    const int dxs[6] = {-1, 1, 0, 0, 0, 0};
    const int dys[6] = {0, 0, -1, 1, 0, 0};
    const int dzs[6] = {0, 0, 0, 0, -1, 1};

    for (int i = 0; i < 6; ++i) {
        int nx_i = gx + dxs[i];
        int ny_i = gy + dys[i];
        int nz_i = gz + dzs[i];
        if (nx_i >= 0 && nx_i < nx && ny_i >= 0 && ny_i < ny && nz_i >= 0 && nz_i < nz) {
            int t_idx = (nx_i >> 3) + (ny_i >> 3) * ntx + (nz_i >> 3) * ntx * nty;
            int c_idx = (nx_i & 7) + (ny_i & 7) * 8 + (nz_i & 7) * 64;
            bool is_fluid_n = d_geom ? (!d_geom[t_idx].cells[c_idx].is_boundary) : false;
            if (!d_geom) {
                const long long n_slot = resolve_fsi_mpm_slot(nx_i, ny_i, nz_i, nx, ny, nz, gv);
                is_fluid_n = (n_slot < 0 || d_grid[n_slot].v_solid <= 1.0e-20f);
            }
            if (is_fluid_n) {
                sum_p   += d_states[t_idx].p[c_idx];
                sum_rho += d_states[t_idx].rho[c_idx];
                count++;
            }
        }
    }
    if (count > 0) {
        if (out_rho) *out_rho = fmax((RealType)1.0e-6, sum_rho / (RealType)count);
        return sum_p / (RealType)count;
    }
    if (out_rho) *out_rho = fmax((RealType)1.0e-6, self_rho);
    return self_p;
}

template <typename RealType, bool IsMultiMaterial>
__global__ void kernel_fsi_apply_penalty_gpu(
    PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    ConservativeTile3D<RealType, IsMultiMaterial>* d_U,
    const Blast::MPMGridNode3D* d_grid,
    const GeometryTile3D* d_geom,
    int nx, int ny, int nz,
    int ntx, int nty,
    float dx, float dy, float dz,
    float gamma,
    Blast::MPMGridView3D gv
) {
    int gx = blockIdx.x * blockDim.x + threadIdx.x;
    int gy = blockIdx.y * blockDim.y + threadIdx.y;
    int gz = blockIdx.z * blockDim.z + threadIdx.z;

    if (gx >= nx || gy >= ny || gz >= nz) return;

    int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;
    if (d_geom && !d_geom[t_idx].cells[c_idx].is_boundary) return;

    const long long mpm_slot = resolve_fsi_mpm_slot(gx, gy, gz, nx, ny, nz, gv);
    if (mpm_slot < 0) return;
    const float cell_vol_mpm = fmaxf(dx * dy * dz, 1.0e-20f);
    if (d_grid[mpm_slot].v_solid < FSI_SOLID_WALL_ALPHA_THRESH * cell_vol_mpm) return;
    float z_cell = static_cast<float>(d_zmin) + (static_cast<float>(gz) + 0.5f) * dz;
    if (d_stratParams.enabled && z_cell < static_cast<float>(d_stratParams.seabed_surface_z) + 2.0f * dz) {
        return; // Do not apply rigid solid penalty velocity clamping to seabed geotechnical foundation or mudline halo
    }

    if (d_zonalParams.enabled) {
        float x_cell = static_cast<float>(d_xmin) + (static_cast<float>(gx) + 0.5f) * dx;
        float y_cell = static_cast<float>(d_ymin) + (static_cast<float>(gy) + 0.5f) * dy;
        float dx_rel = x_cell - static_cast<float>(d_zonalParams.center_x);
        float dy_rel = y_cell - static_cast<float>(d_zonalParams.center_y);
        float dz_rel = z_cell - static_cast<float>(d_zonalParams.center_z);
        float r = d_zonalParams.is_cylinder ? sqrtf(dx_rel * dx_rel + dy_rel * dy_rel) : sqrtf(dx_rel * dx_rel + dy_rel * dy_rel + dz_rel * dz_rel);
        if (r < static_cast<float>(d_zonalParams.sleeve_radius)) {
            return; // Zonal sleeve region evolves under MPM; do not apply rigid solid penalty
        }
    }
    float mass = d_grid[mpm_slot].m;
    if (mass <= 1.0e-8f) return;

    float vx = d_grid[mpm_slot].p[0] / mass;
    float vy = d_grid[mpm_slot].p[1] / mass;
    float vz = d_grid[mpm_slot].p[2] / mass;

    RealType new_ux = (RealType)vx;
    RealType new_uy = (RealType)vy;
    RealType new_uz = (RealType)vz;

    // Mirror fluid pressure and density from neighboring fluid cells for thermodynamic consistency
    RealType mirrored_rho = fmax((RealType)1.0e-6, d_states[t_idx].rho[c_idx]);
    RealType mirrored_p   = get_fsi_neighbor_fluid_pressure<RealType, IsMultiMaterial>(d_states, d_grid, d_geom, gx, gy, gz, nx, ny, nz, ntx, nty, gv, &mirrored_rho);

    // Update Primitive tile velocity, mirrored pressure, and mirrored density
    d_states[t_idx].ux[c_idx]  = new_ux;
    d_states[t_idx].uy[c_idx]  = new_uy;
    d_states[t_idx].uz[c_idx]  = new_uz;
    d_states[t_idx].p[c_idx]   = mirrored_p;
    d_states[t_idx].rho[c_idx] = mirrored_rho;

    // Update Conservative tile (d_U) — SSOT for CFD solver!
    if (d_U) {
        RealType old_rho = fmax((RealType)1.0e-6, d_U[t_idx].rho[c_idx]);
        RealType rho = mirrored_rho;
        d_U[t_idx].rho[c_idx] = rho;

        RealType new_rhoux = rho * new_ux;
        RealType new_rhouy = rho * new_uy;
        RealType new_rhouz = rho * new_uz;
        RealType new_ke = (RealType)0.5 * rho * (new_ux * new_ux + new_uy * new_uy + new_uz * new_uz);

        d_U[t_idx].rhoux[c_idx] = new_rhoux;
        d_U[t_idx].rhouy[c_idx] = new_rhouy;
        d_U[t_idx].rhouz[c_idx] = new_rhouz;
        if constexpr (IsMultiMaterial) {
            RealType scale_r = rho / old_rho;
            RealType a1  = d_U[t_idx].alpha1[c_idx];
            RealType a2  = d_U[t_idx].alpha2[c_idx];
            RealType ar1 = d_U[t_idx].arho1[c_idx] * scale_r;
            RealType ar2 = d_U[t_idx].arho2[c_idx] * scale_r;
            d_U[t_idx].arho1[c_idx]  = ar1;
            d_U[t_idx].arho2[c_idx]  = ar2;
            d_states[t_idx].arho1[c_idx] = ar1;
            d_states[t_idx].arho2[c_idx] = ar2;
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
    const GeometryTile3D* d_geom,
    const int* d_active_nodes,
    int num_active_nodes,
    int nx_cfd, int ny_cfd, int nz_cfd,
    int ntx, int nty,
    float dx_cfd, float dy_cfd, float dz_cfd,
    float xmin_cfd, float ymin_cfd, float zmin_cfd,
    int nx_mpm, int ny_mpm, int nz_mpm,
    float dx_mpm, float dy_mpm, float dz_mpm,
    float xmin_mpm, float ymin_mpm, float zmin_mpm,
    float gamma,
    Blast::MPMGridView3D gv
) {
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= num_active_nodes) return;

    int mpm_idx = d_active_nodes[tid];
    const long long mpm_slot = (gv.nx > 0) ? gv.slotIndexFromLogical(mpm_idx) : static_cast<long long>(mpm_idx);
    if (mpm_slot < 0) return;

    float v_solid_self = d_grid[mpm_slot].v_solid;
    float mass = d_grid[mpm_slot].m;
    const float cell_vol_mpm = fmaxf(dx_mpm * dy_mpm * dz_mpm, 1.0e-20f);

    bool is_solid = (v_solid_self >= FSI_SOLID_WALL_ALPHA_THRESH * cell_vol_mpm);
    if (!is_solid || mass <= 1.0e-8f) return;

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
    if (d_geom && !d_geom[t_idx].cells[c_idx].is_boundary) return;

    float z_cell = zmin_cfd + (static_cast<float>(gz) + 0.5f) * dz_cfd;
    if (d_stratParams.enabled && z_cell < static_cast<float>(d_stratParams.seabed_surface_z) + 2.0f * dz_cfd) {
        return; // Do not apply rigid solid penalty velocity clamping to seabed geotechnical foundation or mudline halo
    }

    if (d_zonalParams.enabled) {
        float x_cell = xmin_cfd + (static_cast<float>(gx) + 0.5f) * dx_cfd;
        float y_cell = ymin_cfd + (static_cast<float>(gy) + 0.5f) * dy_cfd;
        float dx_rel = x_cell - static_cast<float>(d_zonalParams.center_x);
        float dy_rel = y_cell - static_cast<float>(d_zonalParams.center_y);
        float dz_rel = z_cell - static_cast<float>(d_zonalParams.center_z);
        float r = d_zonalParams.is_cylinder ? sqrtf(dx_rel * dx_rel + dy_rel * dy_rel) : sqrtf(dx_rel * dx_rel + dy_rel * dy_rel + dz_rel * dz_rel);
        if (r < static_cast<float>(d_zonalParams.sleeve_radius)) {
            return; // Zonal sleeve region evolves under MPM; do not apply rigid solid penalty
        }
    }

    float vx = d_grid[mpm_slot].p[0] / mass;
    float vy = d_grid[mpm_slot].p[1] / mass;
    float vz = d_grid[mpm_slot].p[2] / mass;

    RealType new_ux = (RealType)vx;
    RealType new_uy = (RealType)vy;
    RealType new_uz = (RealType)vz;

    RealType rho_target = fmax((RealType)1.0e-6, d_states[t_idx].rho[c_idx]);
    RealType p_target = (is_solid && nx_cfd == nx_mpm && ny_cfd == ny_mpm && nz_cfd == nz_mpm)
        ? get_fsi_neighbor_fluid_pressure<RealType, IsMultiMaterial>(d_states, d_grid, d_geom, gx, gy, gz, nx_cfd, ny_cfd, nz_cfd, ntx, nty, gv, &rho_target)
        : d_states[t_idx].p[c_idx];

    d_states[t_idx].ux[c_idx] = new_ux;
    d_states[t_idx].uy[c_idx] = new_uy;
    d_states[t_idx].uz[c_idx] = new_uz;
    if (is_solid) {
        d_states[t_idx].p[c_idx]   = p_target;
        d_states[t_idx].rho[c_idx] = rho_target;
    }

    if (d_U) {
        RealType old_rho = fmax((RealType)1.0e-6, d_U[t_idx].rho[c_idx]);
        RealType rho = is_solid ? rho_target : old_rho;
        d_U[t_idx].rho[c_idx] = rho;

        RealType new_rhoux = rho * new_ux;
        RealType new_rhouy = rho * new_uy;
        RealType new_rhouz = rho * new_uz;
        RealType new_ke = (RealType)0.5 * rho * (new_ux * new_ux + new_uy * new_uy + new_uz * new_uz);

        d_U[t_idx].rhoux[c_idx] = new_rhoux;
        d_U[t_idx].rhouy[c_idx] = new_rhouy;
        d_U[t_idx].rhouz[c_idx] = new_rhouz;
        if constexpr (IsMultiMaterial) {
            RealType scale_r = rho / old_rho;
            RealType a1  = d_U[t_idx].alpha1[c_idx];
            RealType a2  = d_U[t_idx].alpha2[c_idx];
            RealType ar1 = d_U[t_idx].arho1[c_idx] * scale_r;
            RealType ar2 = d_U[t_idx].arho2[c_idx] * scale_r;
            d_U[t_idx].arho1[c_idx]  = ar1;
            d_U[t_idx].arho2[c_idx]  = ar2;
            d_states[t_idx].arho1[c_idx] = ar1;
            d_states[t_idx].arho2[c_idx] = ar2;
            if (is_cell_water(rho, (RealType)z_cell)) {
                d_U[t_idx].E[c_idx] = MultiMat::getMixtureEnergyTait<RealType>(p_target, rho, a1, a2, ar1, ar2, d_taitParams, d_products, d_unreacted) + new_ke;
            } else if (is_cell_soil(rho, (RealType)z_cell)) {
                d_U[t_idx].E[c_idx] = computeFluidEnergyGPU<RealType>(p_target, rho, (RealType)gamma, (RealType)z_cell) + new_ke;
            } else {
                d_U[t_idx].E[c_idx] = MultiMat::getMixtureEnergy<RealType>(p_target, rho, a1, a2, ar1, ar2, (RealType)gamma, d_products, d_unreacted) + new_ke;
            }
        } else {
            d_U[t_idx].E[c_idx] = computeFluidEnergyGPU<RealType>(p_target, rho, (RealType)gamma, (RealType)z_cell) + new_ke;
        }
    }
}

// Zonal FV -> MPM exterior traction: export FV pressure in the band just outside the sleeve.
// Output uses the MPM node layout [(i * ny + j) * nz + k] (grids are co-located, cell-centred).
// Cells outside the band, or occupied by MPM solid material (soil / structures, which are
// coupled through their own contact laws), receive the sentinel value (no ghost traction).
// The MPM kernel performs the exact sub-point inside/outside test; this band only needs to
// cover the kernel support (<= 2.5 dx) on both sides of the sleeve surface.
template <typename RealType, bool IsMultiMaterial>
static __global__ void kernel_zonal_fill_ghost_pressure_gpu(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    const Blast::MPMGridNode3D* d_grid,
    float* ghost_p,
    int nx, int ny, int nz, int ntx, int nty,
    float dx, float xmin, float ymin, float zmin,
    Blast::MPMGridView3D gv = {})
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int num = nx * ny * nz;
    if (idx >= num) return;
    const float kNone = -1.0e30f;
    ghost_p[idx] = kNone;
    if (!d_zonalParams.enabled) return;

    int gx = idx / (ny * nz);
    int gy = (idx / nz) % ny;
    int gz = idx % nz;
    float x_c = xmin + (static_cast<float>(gx) + 0.5f) * dx;
    float y_c = ymin + (static_cast<float>(gy) + 0.5f) * dx;
    float z_c = zmin + (static_cast<float>(gz) + 0.5f) * dx;

    float rx = x_c - static_cast<float>(d_zonalParams.center_x);
    float ry = y_c - static_cast<float>(d_zonalParams.center_y);
    float rz = z_c - static_cast<float>(d_zonalParams.center_z);
    float r = d_zonalParams.is_cylinder ? sqrtf(rx * rx + ry * ry) : sqrtf(rx * rx + ry * ry + rz * rz);
    float R_outer = static_cast<float>(d_zonalParams.sleeve_radius);
    float czmin = fmaxf(static_cast<float>(d_zonalParams.clip_z_min), zmin);
    float czmax = fminf(static_cast<float>(d_zonalParams.clip_z_max), zmin + static_cast<float>(nz) * dx);

    const float band = 3.0f * dx;
    if (r > R_outer + band) return;
    if (z_c < czmin - dx || z_c > czmax + band) return;
    bool near_radial = (r >= R_outer - dx);
    bool near_top = (z_c >= czmax - dx);
    if (!near_radial && !near_top) return;

    if (d_grid) {
        const long long slot = resolve_fsi_mpm_slot(gx, gy, gz, nx, ny, nz, gv);
        if (slot >= 0 && d_grid[slot].m_solid > 1.0e-8f) return;
    }

    int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;
    // 5-plane SoA ghost state: [p | rho | ux | uy | uz]. Planes 1-4 are only
    // read by the MPM scatter kernel when plane 0 holds a valid pressure.
    ghost_p[idx]           = static_cast<float>(d_states[t_idx].p[c_idx]);
    ghost_p[idx + 1 * num] = static_cast<float>(d_states[t_idx].rho[c_idx]);
    ghost_p[idx + 2 * num] = static_cast<float>(d_states[t_idx].ux[c_idx]);
    ghost_p[idx + 3 * num] = static_cast<float>(d_states[t_idx].uy[c_idx]);
    ghost_p[idx + 4 * num] = static_cast<float>(d_states[t_idx].uz[c_idx]);
}

template <typename RealType, bool IsMultiMaterial>
static __global__ void kernel_zonal_handoff_active_gpu(
    PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    ConservativeTile3D<RealType, IsMultiMaterial>* d_U,
    const Blast::MPMGridNode3D* d_grid,
    const int* d_active_nodes,
    int num_active_nodes,
    int nx, int ny, int nz,
    int ntx, int nty,
    float dx, float dy, float dz,
    float xmin, float ymin, float zmin,
    float gamma,
    Blast::MPMGridView3D gv = {}
) {
    if (!d_zonalParams.enabled) return;

    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= num_active_nodes) return;

    int mpm_idx = d_active_nodes[tid];
    const long long mpm_slot = (gv.nx > 0) ? gv.slotIndexFromLogical(mpm_idx) : static_cast<long long>(mpm_idx);
    if (mpm_slot < 0) return;

    float solid_mass = d_grid[mpm_slot].m_solid;
    if (solid_mass > 1.0e-8f) return; // Structural solids handled by solid penalty kernel

    float mass = d_grid[mpm_slot].m;
    float cell_vol = dx * dy * dz;
    if (mass < 1.0e-5f * cell_vol) return;

    int gx = mpm_idx / (ny * nz);
    int gy = (mpm_idx / nz) % ny;
    int gz = mpm_idx % nz;

    float x_c = xmin + (static_cast<float>(gx) + 0.5f) * dx;
    float y_c = ymin + (static_cast<float>(gy) + 0.5f) * dy;
    float z_c = zmin + (static_cast<float>(gz) + 0.5f) * dz;

    float eff_clip_z_min = fmaxf(static_cast<float>(d_zonalParams.clip_z_min), zmin);
    float eff_clip_z_max = fminf(static_cast<float>(d_zonalParams.clip_z_max), zmin + static_cast<float>(nz) * dz);

    // Do not apply water handoff below seabed surface elevation
    if (d_stratParams.enabled && z_c < static_cast<float>(d_stratParams.seabed_surface_z)) {
        return;
    }
    // Do not apply water handoff above water surface elevation (air layer)
    if (d_stratParams.enabled && z_c > static_cast<float>(d_stratParams.water_surface_z)) {
        return;
    }
    // Do not apply handoff outside sleeve vertical clipping limits
    if (z_c <= eff_clip_z_min || z_c >= eff_clip_z_max) {
        return;
    }

    float dx_rel = x_c - static_cast<float>(d_zonalParams.center_x);
    float dy_rel = y_c - static_cast<float>(d_zonalParams.center_y);
    float dz_rel = z_c - static_cast<float>(d_zonalParams.center_z);

    float r = d_zonalParams.is_cylinder ? sqrtf(dx_rel * dx_rel + dy_rel * dy_rel)
                                        : sqrtf(dx_rel * dx_rel + dy_rel * dy_rel + dz_rel * dz_rel);

    float sleeve_radius = static_cast<float>(d_zonalParams.sleeve_radius);
    float overlap_thickness = static_cast<float>(d_zonalParams.overlap_thickness);
    if (overlap_thickness < 1.0e-4f) overlap_thickness = 2.0f * dz;

    float R_outer = sleeve_radius;
    float R_inner = fmaxf(0.0f, R_outer - overlap_thickness);

    // Overlapping Schwarz partition:
    //   r <  R_inner           : FV cell is a Dirichlet mirror of the MPM grid state (MPM owns)
    //   R_inner <= r < R_outer : FV state relaxed toward MPM with smoothstep weight (shared band)
    //   r >= R_outer           : FV owns the solution; MPM receives it as ghost traction instead
    if (r >= R_outer) return;

    // Skip solid nodes (structures / boundaries / soil); energetic + fluid nodes are handed off
    if (d_grid[mpm_slot].m_solid > 1.0e-8f) return;

    float ux_mpm = d_grid[mpm_slot].p[0] / mass;
    float uy_mpm = d_grid[mpm_slot].p[1] / mass;
    float uz_mpm = d_grid[mpm_slot].p[2] / mass;

    // Mass-weighted continuum pressure transferred from MPM particles during P2G
    // (P2G only at this point in the step: not yet normalised by the grid update)
    float p_mpm = d_grid[mpm_slot].pressure / mass;
    // Realizability floor only: pressure cannot fall below the cavitation limit (Directive 19)
    if (p_mpm < static_cast<float>(d_taitParams.p_cav)) {
        p_mpm = static_cast<float>(d_taitParams.p_cav);
    }

    float energetic_mass = d_grid[mpm_slot].m_energetic;
    float reacted_mass   = fminf(energetic_mass, d_grid[mpm_slot].m_reacted);

    // Thermodynamically consistent multi-material state of the MPM node.
    // Every phase k carries a conserved partial density  arho_k = m_k / V_tot  and a volume fraction
    // alpha_k = V_k / V_tot  (V_tot = sum of phase volumes), so that the intrinsic density rho_k = arho_k / alpha_k
    // equals the true particle density of the phase. Mass fractions are NEVER used as volume fractions.
    //   reacted JWL gas : m_g, V_g  (shape-weighted particle masses / volumes accumulated during P2G)
    //   unreacted solid : m_s, V_s
    //   water           : m_w, with V_w = m_w / rho_w(p) from the barotropic Tait inversion of the MPM pressure
    float rho_mpm = 0.0f;
    float a1_mpm = 0.0f, a2_mpm = 0.0f, ar1_mpm = 0.0f, ar2_mpm = 0.0f;
    const float m_w = fmaxf(0.0f, mass - energetic_mass);
    const float rho_w_mpm = Blast::TaitEOSWater::compute_density_isentropic(
        p_mpm,
        static_cast<float>(d_taitParams.B),
        static_cast<float>(d_taitParams.gamma),
        static_cast<float>(d_taitParams.rho0),
        static_cast<float>(d_taitParams.p0)
    );
    if (energetic_mass > 1.0e-8f * mass && d_grid[mpm_slot].v_energetic > 1.0e-20f) {
        const float m_g = reacted_mass;
        const float m_s = energetic_mass - reacted_mass;
        const float v_g = fminf(d_grid[mpm_slot].v_energetic, d_grid[mpm_slot].v_reacted);
        const float v_s = fmaxf(0.0f, d_grid[mpm_slot].v_energetic - v_g);
        const float v_w = (m_w > 0.0f) ? m_w / fmaxf(rho_w_mpm, 1.0f) : 0.0f;
        const float v_tot = fmaxf(v_g + v_s + v_w, 1.0e-20f);
        rho_mpm = fmaxf(mass / v_tot, 1.0e-3f);
        a1_mpm  = fminf(1.0f, fmaxf(0.0f, v_g / v_tot));
        a2_mpm  = fminf(1.0f - a1_mpm, fmaxf(0.0f, v_s / v_tot));
        ar1_mpm = fmaxf(0.0f, m_g / v_tot);
        ar2_mpm = fmaxf(0.0f, m_s / v_tot);
    } else {
        // Barotropic Tait inversion so the FV cell reproduces the MPM pressure exactly
        // (pressure equality across the interface is the coupling invariant)
        rho_mpm = rho_w_mpm;
    }

    // weight = share of the FV solution: 0 in the MPM core, smoothstep 0 -> 1 across the overlap
    float weight_r = 0.0f;
    if (r > R_inner) {
        float s = (r - R_inner) / fmaxf(1.0e-5f, R_outer - R_inner);
        s = fminf(1.0f, fmaxf(0.0f, s));
        weight_r = s * s * (3.0f - 2.0f * s);
    }

    float weight_z = 0.0f;
    float Z_inner_top = eff_clip_z_max - overlap_thickness;
    if (z_c > Z_inner_top) {
        float s = (z_c - Z_inner_top) / fmaxf(1.0e-5f, overlap_thickness);
        s = fminf(1.0f, fmaxf(0.0f, s));
        weight_z = fmaxf(weight_z, s * s * (3.0f - 2.0f * s));
    }
    float Z_inner_bot = eff_clip_z_min + overlap_thickness;
    if (z_c < Z_inner_bot) {
        float s = (Z_inner_bot - z_c) / fmaxf(1.0e-5f, overlap_thickness);
        s = fminf(1.0f, fmaxf(0.0f, s));
        weight_z = fmaxf(weight_z, s * s * (3.0f - 2.0f * s));
    }

    float weight = fmaxf(weight_r, weight_z);
    if (weight >= 1.0f) return;

    int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

    float rho_cfd = static_cast<float>(d_states[t_idx].rho[c_idx]);
    float ux_cfd  = static_cast<float>(d_states[t_idx].ux[c_idx]);
    float uy_cfd  = static_cast<float>(d_states[t_idx].uy[c_idx]);
    float uz_cfd  = static_cast<float>(d_states[t_idx].uz[c_idx]);
    float p_cfd   = static_cast<float>(d_states[t_idx].p[c_idx]);

    // Blended thermodynamic state
    RealType new_rho = static_cast<RealType>((1.0f - weight) * rho_mpm + weight * rho_cfd);
    RealType new_ux  = static_cast<RealType>((1.0f - weight) * ux_mpm  + weight * ux_cfd);
    RealType new_uy  = static_cast<RealType>((1.0f - weight) * uy_mpm  + weight * uy_cfd);
    RealType new_uz  = static_cast<RealType>((1.0f - weight) * uz_mpm  + weight * uz_cfd);
    RealType new_p   = static_cast<RealType>((1.0f - weight) * p_mpm   + weight * p_cfd);

    d_states[t_idx].rho[c_idx] = new_rho;
    d_states[t_idx].ux[c_idx]  = new_ux;
    d_states[t_idx].uy[c_idx]  = new_uy;
    d_states[t_idx].uz[c_idx]  = new_uz;
    d_states[t_idx].p[c_idx]   = new_p;

    if (d_U) {
        RealType new_rhoux = new_rho * new_ux;
        RealType new_rhouy = new_rho * new_uy;
        RealType new_rhouz = new_rho * new_uz;
        RealType new_ke = (RealType)0.5 * new_rho * (new_ux * new_ux + new_uy * new_uy + new_uz * new_uz);

        d_U[t_idx].rho[c_idx]   = new_rho;
        d_U[t_idx].rhoux[c_idx] = new_rhoux;
        d_U[t_idx].rhouy[c_idx] = new_rhouy;
        d_U[t_idx].rhouz[c_idx] = new_rhouz;

        if constexpr (IsMultiMaterial) {
            RealType a1_cfd = d_U[t_idx].alpha1[c_idx];
            RealType a2_cfd = d_U[t_idx].alpha2[c_idx];
            RealType ar1_cfd = d_U[t_idx].arho1[c_idx];
            RealType ar2_cfd = d_U[t_idx].arho2[c_idx];

            // Linear Schwarz blend of conserved partial densities and volume fractions (both ends are
            // self-consistent: arho_k = alpha_k * rho_k with sum(alpha_k) <= 1)
            RealType a1 = (RealType)(1.0f - weight) * (RealType)a1_mpm + (RealType)weight * a1_cfd;
            RealType a2 = (RealType)(1.0f - weight) * (RealType)a2_mpm + (RealType)weight * a2_cfd;
            RealType ar1 = (RealType)(1.0f - weight) * (RealType)ar1_mpm + (RealType)weight * ar1_cfd;
            RealType ar2 = (RealType)(1.0f - weight) * (RealType)ar2_mpm + (RealType)weight * ar2_cfd;

            d_U[t_idx].alpha1[c_idx] = a1;
            d_U[t_idx].alpha2[c_idx] = a2;
            d_U[t_idx].arho1[c_idx]  = ar1;
            d_U[t_idx].arho2[c_idx]  = ar2;

            d_states[t_idx].alpha1[c_idx] = a1;
            d_states[t_idx].alpha2[c_idx] = a2;
            d_states[t_idx].arho1[c_idx]  = ar1;
            d_states[t_idx].arho2[c_idx]  = ar2;

            if (is_cell_water(new_rho, (RealType)z_c)) {
                d_U[t_idx].E[c_idx] = MultiMat::getMixtureEnergyTait<RealType>(new_p, new_rho, a1, a2, ar1, ar2, d_taitParams, d_products, d_unreacted) + new_ke;
            } else if (is_cell_soil(new_rho, (RealType)z_c)) {
                d_U[t_idx].E[c_idx] = computeFluidEnergyGPU<RealType>(new_p, new_rho, (RealType)gamma, (RealType)z_c) + new_ke;
            } else {
                d_U[t_idx].E[c_idx] = MultiMat::getMixtureEnergy<RealType>(new_p, new_rho, a1, a2, ar1, ar2, (RealType)gamma, d_products, d_unreacted) + new_ke;
            }
        } else {
            d_U[t_idx].E[c_idx] = computeFluidEnergyGPU<RealType>(new_p, new_rho, (RealType)gamma, (RealType)z_c) + new_ke;
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
static __global__ void kernel_synchronize_fluid_sleeve_particles_gpu(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    Blast::MPMParticle3DSoA soa,
    int num_particles,
    const Blast::MaterialTable3D* d_mat_tables,
    int nx, int ny, int nz,
    int ntx, int nty,
    float dx, float dy, float dz,
    float xmin, float ymin, float zmin
) {
    int p_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (p_idx >= num_particles || (soa.state && soa.state[p_idx] == 2) || soa.m[p_idx] <= 0.0f) return;

    int obj_id = soa.object_id[p_idx];
    const Blast::MaterialTable3D& mat = d_mat_tables[obj_id];
    const bool is_fluid = (mat.material_model == Blast::MPMMaterialModel::TaitWater);
    if (!is_fluid) return;

    float px = soa.x[0][p_idx];
    float py = soa.x[1][p_idx];
    float pz = soa.x[2][p_idx];

    float w_blend = 1.0f; // Default if zonal coupling is not active

    if (d_zonalParams.enabled) {
        float dx_rel = px - static_cast<float>(d_zonalParams.center_x);
        float dy_rel = py - static_cast<float>(d_zonalParams.center_y);
        float dz_rel = pz - static_cast<float>(d_zonalParams.center_z);
        float r = d_zonalParams.is_cylinder ? sqrtf(dx_rel * dx_rel + dy_rel * dy_rel) : sqrtf(dx_rel * dx_rel + dy_rel * dy_rel + dz_rel * dz_rel);
        float R_outer = static_cast<float>(d_zonalParams.sleeve_radius);
        float overlap_thickness = static_cast<float>(d_zonalParams.overlap_thickness);
        if (overlap_thickness < 1.0e-4f) overlap_thickness = 2.0f * dz;
        float R_inner = fmaxf(0.0f, R_outer - overlap_thickness);

        float eff_clip_z_min = fmaxf(static_cast<float>(d_zonalParams.clip_z_min), zmin);
        float eff_clip_z_max = fminf(static_cast<float>(d_zonalParams.clip_z_max), zmin + static_cast<float>(nz) * dz);

        bool out_of_z = (pz <= eff_clip_z_min || pz >= eff_clip_z_max);
        if (d_stratParams.enabled && pz > static_cast<float>(d_stratParams.water_surface_z)) {
            out_of_z = true;
        }

        bool out_of_domain = (px < xmin || px >= xmin + static_cast<float>(nx) * dx ||
                              py < ymin || py >= ymin + static_cast<float>(ny) * dy);

        if (out_of_z || out_of_domain) {
            if (soa.state) soa.state[p_idx] = 2;
            soa.v[0][p_idx] = 0.0f;
            soa.v[1][p_idx] = 0.0f;
            soa.v[2][p_idx] = 0.0f;
            soa.m[p_idx] = 0.0f;
            return;
        }

        // Overlap band blending:
        float w_blend_r = 0.0f;
        if (r > R_inner) {
            float s = (r - R_inner) / fmaxf(1.0e-5f, R_outer - R_inner);
            s = fminf(1.0f, fmaxf(0.0f, s));
            w_blend_r = s * s * (3.0f - 2.0f * s);
        }

        float w_blend_z = 0.0f;
        float Z_inner_top = eff_clip_z_max - overlap_thickness;
        if (pz > Z_inner_top) {
            float s = (pz - Z_inner_top) / fmaxf(1.0e-5f, overlap_thickness);
            s = fminf(1.0f, fmaxf(0.0f, s));
            w_blend_z = fmaxf(w_blend_z, s * s * (3.0f - 2.0f * s));
        }
        float Z_inner_bot = eff_clip_z_min + overlap_thickness;
        if (pz < Z_inner_bot) {
            float s = (Z_inner_bot - pz) / fmaxf(1.0e-5f, overlap_thickness);
            s = fminf(1.0f, fmaxf(0.0f, s));
            w_blend_z = fmaxf(w_blend_z, s * s * (3.0f - 2.0f * s));
        }

        w_blend = fmaxf(w_blend_r, w_blend_z);
        // Note: Do NOT return early here if w_blend <= 0.0f. Core particles (w_blend == 0)
        // must still undergo scale-isolated thermodynamic relaxation (w_thermo) if post-shock
        // residual strain drift decouples MPM particle pressure from the background CFD cell.
    }

    int gx = static_cast<int>(floorf((px - xmin) / dx));
    int gy = static_cast<int>(floorf((py - ymin) / dy));
    int gz = static_cast<int>(floorf((pz - zmin) / dz));

    if (gx < 0 || gx >= nx || gy < 0 || gy >= ny || gz < 0 || gz >= nz) return;

    int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

    float u_cfd   = static_cast<float>(d_states[t_idx].ux[c_idx]);
    float v_cfd   = static_cast<float>(d_states[t_idx].uy[c_idx]);
    float w_vel   = static_cast<float>(d_states[t_idx].uz[c_idx]);
    float p_cfd   = static_cast<float>(d_states[t_idx].p[c_idx]);
    float rho_cfd = static_cast<float>(d_states[t_idx].rho[c_idx]);

    // 1. Kinematic Velocity Blending:
    // In the overlap band (w_blend > 0), blend particle velocity with Eulerian fluid velocity.
    // In the pure MPM core (w_blend == 0), particles evolve under 100% pure Lagrangian MPM.
    if (w_blend > 0.0f) {
        float v0 = soa.v[0][p_idx];
        float v1 = soa.v[1][p_idx];
        float v2 = soa.v[2][p_idx];
        soa.v[0][p_idx] = (1.0f - w_blend) * v0 + w_blend * u_cfd;
        soa.v[1][p_idx] = (1.0f - w_blend) * v1 + w_blend * v_cfd;
        soa.v[2][p_idx] = (1.0f - w_blend) * v2 + w_blend * w_vel;

        if (soa.B[0][0]) {
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    soa.B[r][c][p_idx] *= (1.0f - w_blend);
                }
            }
        }
    }

    // 2. Thermodynamic Volume & Pressure Relaxation:
    // In the overlap band (r > R_inner), w_thermo = w_blend smoothly transitions state to farfield CFD.
    // In the pure MPM core (r <= R_inner), w_blend == 0.0f, so core particles evolve purely under Lagrangian MPM.
    float w_thermo = w_blend;
    if (w_thermo <= 0.0f) return;

    float rho_w_cfd = rho_cfd;
    if constexpr (IsMultiMaterial) {
        const float a_w = 1.0f - static_cast<float>(d_states[t_idx].alpha1[c_idx]) - static_cast<float>(d_states[t_idx].alpha2[c_idx]);
        const float ar_w = rho_cfd - static_cast<float>(d_states[t_idx].arho1[c_idx]) - static_cast<float>(d_states[t_idx].arho2[c_idx]);
        rho_w_cfd = (a_w > 1.0e-3f && ar_w > 0.0f) ? ar_w / a_w : 0.0f;
    }
    if (rho_w_cfd <= 10.0f) {
        rho_w_cfd = Blast::TaitEOSWater::compute_density_isentropic(
            fmaxf(p_cfd, static_cast<float>(d_taitParams.p_cav)),
            static_cast<float>(d_taitParams.B),
            static_cast<float>(d_taitParams.gamma),
            static_cast<float>(d_taitParams.rho0),
            static_cast<float>(d_taitParams.p0)
        );
    }

    if (rho_w_cfd > 10.0f && is_fluid) {
        float V_cfd = soa.m[p_idx] / rho_w_cfd;
        float V_old = soa.V[p_idx];
        float V_new = (1.0f - w_thermo) * V_old + w_thermo * V_cfd;
        soa.V[p_idx] = V_new;
        float lp_val = 0.5f * cbrtf(V_new);
        soa.lp[0][p_idx] = lp_val;
        soa.lp[1][p_idx] = lp_val;
        soa.lp[2][p_idx] = lp_val;
    }

    // Blend isotropic fluid stress tensor: sigma = -p_blend * I
    float p_old = 0.0f;
    if (soa.sigma_voigt[0]) {
        p_old = - (soa.sigma_voigt[0][p_idx] + soa.sigma_voigt[1][p_idx] + soa.sigma_voigt[2][p_idx]) / 3.0f;
    } else if (soa.sigma[0][0]) {
        p_old = - (soa.sigma[0][0][p_idx] + soa.sigma[1][1][p_idx] + soa.sigma[2][2][p_idx]) / 3.0f;
    }
    float p_blended = (1.0f - w_thermo) * p_old + w_thermo * p_cfd;

    if (soa.sigma_voigt[0]) {
        soa.sigma_voigt[0][p_idx] = -p_blended;
        soa.sigma_voigt[1][p_idx] = -p_blended;
        soa.sigma_voigt[2][p_idx] = -p_blended;
        soa.sigma_voigt[3][p_idx] = (1.0f - w_thermo) * soa.sigma_voigt[3][p_idx];
        soa.sigma_voigt[4][p_idx] = (1.0f - w_thermo) * soa.sigma_voigt[4][p_idx];
        soa.sigma_voigt[5][p_idx] = (1.0f - w_thermo) * soa.sigma_voigt[5][p_idx];
    } else if (soa.sigma[0][0]) {
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                float s_old = soa.sigma[r][c][p_idx];
                float s_cfd = (r == c) ? -p_cfd : 0.0f;
                soa.sigma[r][c][p_idx] = (1.0f - w_thermo) * s_old + w_thermo * s_cfd;
            }
        }
    }

    if (is_fluid) {
        float p0 = mat.tait_p0;
        float gamma = (mat.tait_gamma > 1.0f) ? mat.tait_gamma : 7.15f;
        if (rho_cfd > 10.0f) {
            float e_cfd = fmaxf(0.0f, (p_cfd - p0) / (gamma * rho_cfd));
            soa.e_int[p_idx] = (1.0f - w_thermo) * soa.e_int[p_idx] + w_thermo * e_cfd;
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

template <typename RealType>
static __global__ void kernel_mark_tile_has_boundary_fsi_3d(
    const GeometryTile3D* d_geom,
    const FluidFractionTile3D<RealType>* d_fluid_frac,
    uint8_t* d_tile_has_boundary,
    int total_tiles
) {
    int t_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (t_idx >= total_tiles) return;

    bool has_b = false;
    for (int c = 0; c < TILE_CELLS_3D; ++c) {
        if ((d_geom && d_geom[t_idx].cells[c].is_boundary) ||
            (d_fluid_frac && d_fluid_frac[t_idx].alpha_f[c] < (RealType)(1.0 - 1.0e-6))) {
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

// =====================================================================================
// Unified Continuous Fluid-Volume-Fraction (alpha_f) MPM <-> FV Coupling Kernels
// =====================================================================================

__device__ __forceinline__ bool fsi_prepare_particle_voxel(
    const Blast::MPMParticle3DSoA& soa,
    int p_idx,
    int num_particles,
    const Blast::MaterialTable3D* d_mat_tables,
    int nx_cfd, int ny_cfd, int nz_cfd,
    float dx_cfd, float dy_cfd, float dz_cfd,
    float xmin_cfd, float ymin_cfd, float zmin_cfd,
    float& out_pm, float& out_pV,
    float& out_px, float& out_py, float& out_pz,
    float& out_hx, float& out_hy, float& out_hz,
    int& out_i0, int& out_i1, int& out_j0, int& out_j1, int& out_k0, int& out_k1
) {
    if (p_idx >= num_particles) return false;
    if ((soa.state && soa.state[p_idx] == 2) || soa.m[p_idx] <= 0.0f) return false;

    int obj_id = soa.object_id[p_idx];
    const Blast::MaterialTable3D& mat = d_mat_tables[obj_id];
    if (mat.material_model == Blast::MPMMaterialModel::TaitWater ||
        mat.material_model == Blast::MPMMaterialModel::DruckerPragerSoil) {
        return false;
    }

    float px = soa.x[0][p_idx];
    float py = soa.x[1][p_idx];
    float pz = soa.x[2][p_idx];
    if (d_stratParams.enabled && pz < static_cast<float>(d_stratParams.seabed_surface_z)) return false;
    if (d_zonalParams.enabled) {
        float dx_rel = px - static_cast<float>(d_zonalParams.center_x);
        float dy_rel = py - static_cast<float>(d_zonalParams.center_y);
        float dz_rel = pz - static_cast<float>(d_zonalParams.center_z);
        float r = d_zonalParams.is_cylinder ? sqrtf(dx_rel * dx_rel + dy_rel * dy_rel)
                                            : sqrtf(dx_rel * dx_rel + dy_rel * dy_rel + dz_rel * dz_rel);
        if (r < static_cast<float>(d_zonalParams.sleeve_radius)) return false;
    }

    float p_m = soa.m[p_idx];
    float p_V = soa.V[p_idx];
    float p_V_eff = (p_V > 1.0e-30f) ? p_V : (p_m / fmaxf(mat.density, 1000.0f));
    if (p_V_eff <= 1.0e-30f) return false;

    float hx = 0.5f * cbrtf(p_V_eff), hy = hx, hz = hx;
    if (soa.lp[0] && soa.lp[0][p_idx] > 1.0e-12f && soa.lp[1][p_idx] > 1.0e-12f && soa.lp[2][p_idx] > 1.0e-12f) {
        float v_lp = 8.0f * soa.lp[0][p_idx] * soa.lp[1][p_idx] * soa.lp[2][p_idx];
        float s_lp = cbrtf(p_V_eff / fmaxf(v_lp, 1.0e-30f));
        hx = soa.lp[0][p_idx] * s_lp;
        hy = soa.lp[1][p_idx] * s_lp;
        hz = soa.lp[2][p_idx] * s_lp;
    }
    hx = fminf(hx, 0.75f * dx_cfd);
    hy = fminf(hy, 0.75f * dy_cfd);
    hz = fminf(hz, 0.75f * dz_cfd);

    int i0 = max(0, static_cast<int>(floorf((px - hx - xmin_cfd) / dx_cfd)));
    int i1 = min(nx_cfd - 1, static_cast<int>(floorf((px + hx - xmin_cfd) / dx_cfd)));
    int j0 = max(0, static_cast<int>(floorf((py - hy - ymin_cfd) / dy_cfd)));
    int j1 = min(ny_cfd - 1, static_cast<int>(floorf((py + hy - ymin_cfd) / dy_cfd)));
    int k0 = max(0, static_cast<int>(floorf((pz - hz - zmin_cfd) / dz_cfd)));
    int k1 = min(nz_cfd - 1, static_cast<int>(floorf((pz + hz - zmin_cfd) / dz_cfd)));
    if (i0 > i1 || j0 > j1 || k0 > k1) return false;

    out_pm = p_m; out_pV = 8.0f * hx * hy * hz;
    out_px = px; out_py = py; out_pz = pz;
    out_hx = hx; out_hy = hy; out_hz = hz;
    out_i0 = i0; out_i1 = i1; out_j0 = j0; out_j1 = j1; out_k0 = k0; out_k1 = k1;
    return true;
}

static __global__ void kernel_fsi_clear_mpm_fext_gpu(
    Blast::MPMGridNode3D* d_grid,
    const int* d_active_nodes,
    int num_active_nodes,
    Blast::MPMGridView3D gv
) {
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= num_active_nodes) return;
    int mpm_idx = d_active_nodes[tid];
    const long long mpm_slot = (gv.nx > 0) ? gv.slotIndexFromLogical(mpm_idx) : static_cast<long long>(mpm_idx);
    if (mpm_slot < 0) return;
    d_grid[mpm_slot].f_ext[0] = 0.0f;
    d_grid[mpm_slot].f_ext[1] = 0.0f;
    d_grid[mpm_slot].f_ext[2] = 0.0f;
}

template <typename RealType, bool IsMultiMaterial>
static __global__ void kernel_fsi_accum_mpm_occupancy_gpu(
    FluidFractionTile3D<RealType>* fluid_frac,
    ConservativeTile3D<RealType, IsMultiMaterial>* Q_tmp,
    Blast::MPMParticle3DSoA soa,
    int num_particles,
    const Blast::MaterialTable3D* d_mat_tables,
    int nx_cfd, int ny_cfd, int nz_cfd, int ntx, int nty,
    float dx_cfd, float dy_cfd, float dz_cfd,
    float xmin_cfd, float ymin_cfd, float zmin_cfd
) {
    int p_idx = blockIdx.x * blockDim.x + threadIdx.x;
    float p_m, p_V_eff, px, py, pz, hx, hy, hz;
    int i0, i1, j0, j1, k0, k1;
    if (!fsi_prepare_particle_voxel(soa, p_idx, num_particles, d_mat_tables,
                                    nx_cfd, ny_cfd, nz_cfd, dx_cfd, dy_cfd, dz_cfd, xmin_cfd, ymin_cfd, zmin_cfd,
                                    p_m, p_V_eff, px, py, pz, hx, hy, hz, i0, i1, j0, j1, k0, k1)) {
        return;
    }

    float vx = soa.v[0][p_idx];
    float vy = soa.v[1][p_idx];
    float vz = soa.v[2][p_idx];
    RealType inv_cell_vol = (RealType)1.0 / fmax((RealType)(dx_cfd * dy_cfd * dz_cfd), (RealType)1.0e-30);
    float inv_pV = 1.0f / p_V_eff;

    for (int gz = k0; gz <= k1; ++gz) {
        float cz0 = zmin_cfd + static_cast<float>(gz) * dz_cfd;
        float oz = fminf(pz + hz, cz0 + dz_cfd) - fmaxf(pz - hz, cz0);
        if (oz <= 1.0e-12f) continue;
        for (int gy = j0; gy <= j1; ++gy) {
            float cy0 = ymin_cfd + static_cast<float>(gy) * dy_cfd;
            float oy = fminf(py + hy, cy0 + dy_cfd) - fmaxf(py - hy, cy0);
            if (oy <= 1.0e-12f) continue;
            for (int gx = i0; gx <= i1; ++gx) {
                float cx0 = xmin_cfd + static_cast<float>(gx) * dx_cfd;
                float ox = fminf(px + hx, cx0 + dx_cfd) - fmaxf(px - hx, cx0);
                if (ox <= 1.0e-12f) continue;
                float vol_ov = ox * oy * oz;
                float m_ov = p_m * (vol_ov * inv_pV);
                int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
                int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;
                atomicAdd(&fluid_frac[t_idx].alpha_tmp[c_idx], static_cast<RealType>(vol_ov) * inv_cell_vol);
                atomicAdd(&Q_tmp[t_idx].rho[c_idx], static_cast<RealType>(m_ov));
                atomicAdd(&Q_tmp[t_idx].rhoux[c_idx], static_cast<RealType>(m_ov * vx));
                atomicAdd(&Q_tmp[t_idx].rhouy[c_idx], static_cast<RealType>(m_ov * vy));
                atomicAdd(&Q_tmp[t_idx].rhouz[c_idx], static_cast<RealType>(m_ov * vz));
            }
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
static __global__ void __launch_bounds__(256) kernel_fsi_finalize_occupancy_gpu(
    FluidFractionTile3D<RealType>* fluid_frac,
    ConservativeTile3D<RealType, IsMultiMaterial>* Q_tmp,
    SolidVelocityTile3D* d_solid_vel,
    int nx, int ny, int nz, int ntx, int nty,
    bool has_prev
) {
    int gx = blockIdx.x * blockDim.x + threadIdx.x;
    int gy = blockIdx.y * blockDim.y + threadIdx.y;
    int gz = blockIdx.z * blockDim.z + threadIdx.z;
    if (gx >= nx || gy >= ny || gz >= nz) return;

    int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

    RealType a_s_raw = fmax((RealType)0.0, fmin((RealType)1.0, fluid_frac[t_idx].alpha_tmp[c_idx]));
    RealType a_f_new;
    if (a_s_raw <= (RealType)FSI_ALPHA_DEAD) {
        a_f_new = (RealType)1.0;
    } else if (a_s_raw >= (RealType)(1.0 - FSI_ALPHA_DEAD)) {
        a_f_new = (RealType)0.0;
    } else {
        a_f_new = (RealType)1.0 - a_s_raw;
    }

    if (has_prev) {
        fluid_frac[t_idx].alpha_f_prev[c_idx] = fluid_frac[t_idx].alpha_f[c_idx];
        fluid_frac[t_idx].alpha_f[c_idx] = a_f_new;
    } else {
        fluid_frac[t_idx].alpha_f_prev[c_idx] = a_f_new;
        fluid_frac[t_idx].alpha_f[c_idx] = a_f_new;
    }

    RealType m_s = Q_tmp[t_idx].rho[c_idx];
    if (m_s > (RealType)1.0e-12) {
        RealType inv_m = (RealType)1.0 / m_s;
        d_solid_vel[t_idx].vx[c_idx] = static_cast<float>(Q_tmp[t_idx].rhoux[c_idx] * inv_m);
        d_solid_vel[t_idx].vy[c_idx] = static_cast<float>(Q_tmp[t_idx].rhouy[c_idx] * inv_m);
        d_solid_vel[t_idx].vz[c_idx] = static_cast<float>(Q_tmp[t_idx].rhouz[c_idx] * inv_m);
    } else {
        d_solid_vel[t_idx].vx[c_idx] = 0.0f;
        d_solid_vel[t_idx].vy[c_idx] = 0.0f;
        d_solid_vel[t_idx].vz[c_idx] = 0.0f;
    }

    fluid_frac[t_idx].alpha_tmp[c_idx] = (RealType)0.0;
    Q_tmp[t_idx].rho[c_idx]   = (RealType)0.0;
    Q_tmp[t_idx].rhoux[c_idx] = (RealType)0.0;
    Q_tmp[t_idx].rhouy[c_idx] = (RealType)0.0;
    Q_tmp[t_idx].rhouz[c_idx] = (RealType)0.0;
}

// Unresolved-sliver occupancy rule (topological, invariant in space/time/material):
// a cut cell (0 < alpha_f < FSI_ALPHA_CUT) is a representable fluid cell only if it borders at least one
// resolved fluid cell (alpha_f >= FSI_ALPHA_CUT) across a face (6-neighbourhood), the only path along which
// the finite-volume flux can exchange mass with it. A fluid fraction that is nowhere
// connected to a resolved cell is sub-cell occupancy-lattice noise inside a solid body and cannot be
// advanced stably, so it is classed as solid. The predicate only reads cells with alpha_f >= FSI_ALPHA_CUT,
// which this kernel never modifies, so it is race-free.
template <typename RealType>
static __global__ void __launch_bounds__(256) kernel_fsi_classify_unresolved_slivers_gpu(
    FluidFractionTile3D<RealType>* fluid_frac,
    int nx, int ny, int nz, int ntx, int nty
) {
    int gx = blockIdx.x * blockDim.x + threadIdx.x;
    int gy = blockIdx.y * blockDim.y + threadIdx.y;
    int gz = blockIdx.z * blockDim.z + threadIdx.z;
    if (gx >= nx || gy >= ny || gz >= nz) return;
    int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;
    RealType a = fluid_frac[t_idx].alpha_f[c_idx];
    if (!(a > (RealType)0.0) || a >= (RealType)FSI_ALPHA_CUT) return;
    for (int dk = -1; dk <= 1; ++dk) {
        int nk = gz + dk;
        if (nk < 0 || nk >= nz) continue;
        for (int dj = -1; dj <= 1; ++dj) {
            int nj = gy + dj;
            if (nj < 0 || nj >= ny) continue;
            for (int di = -1; di <= 1; ++di) {
                if ((di != 0) + (dj != 0) + (dk != 0) != 1) continue; // face neighbours only
                int ni = gx + di;
                if (ni < 0 || ni >= nx) continue;
                int nt = (ni >> 3) + (nj >> 3) * ntx + (nk >> 3) * ntx * nty;
                int nc = (ni & 7) + (nj & 7) * 8 + (nk & 7) * 64;
                if (fluid_frac[nt].alpha_f[nc] >= (RealType)FSI_ALPHA_CUT) return;
            }
        }
    }
    fluid_frac[t_idx].alpha_f[c_idx] = (RealType)0.0;
}

template <typename RealType>
static __global__ void __launch_bounds__(256) kernel_fsi_write_geom_and_seal_gpu(
    FluidFractionTile3D<RealType>* fluid_frac,
    GeometryTile3D* d_geom,
    int nx, int ny, int nz, int ntx, int nty,
    bool check_sealed
) {
    int gx = blockIdx.x * blockDim.x + threadIdx.x;
    int gy = blockIdx.y * blockDim.y + threadIdx.y;
    int gz = blockIdx.z * blockDim.z + threadIdx.z;
    if (gx >= nx || gy >= ny || gz >= nz) return;

    int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

    RealType a_old = fluid_frac[t_idx].alpha_f_prev[c_idx];
    RealType a_new = fluid_frac[t_idx].alpha_f[c_idx];

    // Sealed-pocket retention was removed deliberately: re-seeding a 1% fluid sliver in a cell that the
    // solid has fully overrun produced a sub-cell gas pocket whose remap divides momentum/energy by
    // alpha_f = 0.01. That drove 20+ km/s pocket velocities and GPa pressure and collapsed the CFD dt at
    // contact. A cell fully covered by solid now carries no fluid; its former content is handled by the
    // cover-push remap like any other covered cell.
    float a_s = static_cast<float>(fmax((RealType)0.0, fmin((RealType)1.0, (RealType)1.0 - a_new)));
    float nx_sum = 0.0f, ny_sum = 0.0f, nz_sum = 0.0f;
    float g_len = 0.0f;
    if (a_s > FSI_ALPHA_DEAD) {
        for (int dk = -1; dk <= 1; ++dk) {
            int nk = min(max(gz + dk, 0), nz - 1);
            for (int dj = -1; dj <= 1; ++dj) {
                int nj = min(max(gy + dj, 0), ny - 1);
                for (int di = -1; di <= 1; ++di) {
                    if (di == 0 && dj == 0 && dk == 0) continue;
                    int ni = min(max(gx + di, 0), nx - 1);
                    int nt = (ni >> 3) + (nj >> 3) * ntx + (nk >> 3) * ntx * nty;
                    int nc = (ni & 7) + (nj & 7) * 8 + (nk & 7) * 64;
                    float ns = 1.0f - static_cast<float>(fluid_frac[nt].alpha_f[nc]);
                    float w = 1.0f / static_cast<float>(di * di + dj * dj + dk * dk);
                    nx_sum += w * static_cast<float>(di) * ns;
                    ny_sum += w * static_cast<float>(dj) * ns;
                    nz_sum += w * static_cast<float>(dk) * ns;
                }
            }
        }
        g_len = sqrtf(nx_sum * nx_sum + ny_sum * ny_sum + nz_sum * nz_sum);
        if (g_len > 0.05f) {
            float inv_g = 1.0f / g_len;
            nx_sum = -nx_sum * inv_g;
            ny_sum = -ny_sum * inv_g;
            nz_sum = -nz_sum * inv_g;
        } else {
            nx_sum = ny_sum = nz_sum = 0.0f;
        }
    }
    GeometryPayload gp_cell = pack_geometry_payload(g_len > 0.05f, nx_sum, ny_sum, nz_sum, a_s);
    gp_cell.is_boundary = (a_new <= (RealType)0.0) ? 1 : 0;
    if (a_s > FSI_ALPHA_DEAD && g_len <= 0.05f) {
        float s_scaled = a_s * 127.0f;
        gp_cell.solid_fraction = static_cast<uint8_t>(s_scaled > 127.0f ? 127.0f : (s_scaled < 0.0f ? 0.0f : s_scaled));
    }
    d_geom[t_idx].cells[c_idx] = gp_cell;
}

// Pass B1: Convert extensive U*alpha_old into Q_tmp and push covered / small-cell overflow into open neighbors
template <typename RealType, bool IsMultiMaterial>
static __global__ void __launch_bounds__(256) kernel_fsi_remap_cover_push_3d(
    const ConservativeTile3D<RealType, IsMultiMaterial>* U_old,
    FluidFractionTile3D<RealType>* fluid_frac,
    ConservativeTile3D<RealType, IsMultiMaterial>* Q_tmp,
    const GeometryTile3D* d_geom,
    int nx, int ny, int nz, int ntx, int nty
) {
    int gx = blockIdx.x * blockDim.x + threadIdx.x;
    int gy = blockIdx.y * blockDim.y + threadIdx.y;
    int gz = blockIdx.z * blockDim.z + threadIdx.z;
    if (gx >= nx || gy >= ny || gz >= nz) return;

    int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

    RealType a_old = fluid_frac[t_idx].alpha_f_prev[c_idx];
    if (a_old <= (RealType)0.0) return;

    RealType a_new = fluid_frac[t_idx].alpha_f[c_idx];
    RealType u_rho = U_old[t_idx].rho[c_idx];
    RealType u_rx  = U_old[t_idx].rhoux[c_idx];
    RealType u_ry  = U_old[t_idx].rhouy[c_idx];
    RealType u_rz  = U_old[t_idx].rhouz[c_idx];
    RealType u_E   = U_old[t_idx].E[c_idx];
    RealType u_a1 = (RealType)0.0, u_a2 = (RealType)0.0, u_ar1 = (RealType)0.0, u_ar2 = (RealType)0.0;
    if constexpr (IsMultiMaterial) {
        u_a1  = U_old[t_idx].alpha1[c_idx];
        u_a2  = U_old[t_idx].alpha2[c_idx];
        u_ar1 = U_old[t_idx].arho1[c_idx];
        u_ar2 = U_old[t_idx].arho2[c_idx];
    }

    RealType a_push = (RealType)0.0;
    RealType a_keep = a_old;
    RealType sp_vol_keep = a_keep; // Keep species phase proportions locked to a_keep matching arho1/arho2
    if (a_new <= (RealType)0.0) {
        a_push = a_old;
        a_keep = (RealType)0.0;
        sp_vol_keep = (RealType)0.0;
    } else if (a_new < a_old) {
        RealType da = a_old - a_new;
        RealType keep_comp = a_new * da;
        a_keep = a_new + keep_comp;
        a_push = da - keep_comp;
        sp_vol_keep = a_keep;
    }

    if (a_keep > (RealType)0.0) {
        atomicAdd(&Q_tmp[t_idx].rho[c_idx],   a_keep * u_rho);
        atomicAdd(&Q_tmp[t_idx].rhoux[c_idx], a_keep * u_rx);
        atomicAdd(&Q_tmp[t_idx].rhouy[c_idx], a_keep * u_ry);
        atomicAdd(&Q_tmp[t_idx].rhouz[c_idx], a_keep * u_rz);
        atomicAdd(&Q_tmp[t_idx].E[c_idx],     a_keep * u_E);
        if constexpr (IsMultiMaterial) {
            atomicAdd(&Q_tmp[t_idx].arho1[c_idx],  a_keep * u_ar1);
            atomicAdd(&Q_tmp[t_idx].arho2[c_idx],  a_keep * u_ar2);
            atomicAdd(&Q_tmp[t_idx].alpha1[c_idx], sp_vol_keep * u_a1);
            atomicAdd(&Q_tmp[t_idx].alpha2[c_idx], sp_vol_keep * u_a2);
        }
        atomicAdd(&fluid_frac[t_idx].alpha_tmp[c_idx], sp_vol_keep);
    }

    if (a_push > (RealType)0.0) {
        RealType ns_x = (RealType)0.0, ns_y = (RealType)0.0, ns_z = (RealType)0.0;
        bool has_n = false;
        if (d_geom) {
            GeometryPayload gp = d_geom[t_idx].cells[c_idx];
            ns_x = static_cast<RealType>(gp.nx);
            ns_y = static_cast<RealType>(gp.ny);
            ns_z = static_cast<RealType>(gp.nz);
            RealType ns_len = sqrt(ns_x * ns_x + ns_y * ns_y + ns_z * ns_z);
            if (ns_len > (RealType)1.0) {
                RealType inv_l = (RealType)1.0 / ns_len;
                ns_x *= inv_l; ns_y *= inv_l; ns_z *= inv_l;
                has_n = true;
            }
        }
        auto nbr_weight = [&](int di, int dj, int dk, RealType an) -> RealType {
            RealType d2 = (RealType)(di * di + dj * dj + dk * dk);
            RealType dir_bias = (RealType)1.0;
            if (has_n) {
                RealType dot_n = ((RealType)di * ns_x + (RealType)dj * ns_y + (RealType)dk * ns_z) / sqrt(d2);
                dir_bias = (RealType)1.0e-6 + fmax((RealType)0.0, dot_n);
            }
            return (an * dir_bias) / d2;
        };
        auto tier_ok = [&](int tier, RealType an) -> bool {
            if (tier == 0 || tier == 2) return an >= (RealType)(1.0 - 1.0e-6);
            if (tier == 1 || tier == 3 || tier == 4) return an >= (RealType)FSI_ALPHA_CUT;
            return an > (RealType)0.0;
        };

        // Prefer face-adjacent open/cut fluid (6-nbr >= 1.0 -> 6-nbr >= FSI_ALPHA_CUT) before diagonal 26-nbr
        RealType w_sum = (RealType)0.0;
        int pass_tier = 0;
        for (int tier = 0; tier < 8 && w_sum <= (RealType)0.0; ++tier) {
            int rad = (tier == 4 || tier == 7) ? 2 : 1;
            bool six_only = (tier == 0 || tier == 1 || tier == 5);
            RealType w_acc = (RealType)0.0;
            for (int dk = -rad; dk <= rad; ++dk) {
                int nz_i = gz + dk;
                if (nz_i < 0 || nz_i >= nz) continue;
                for (int dj = -rad; dj <= rad; ++dj) {
                    int ny_i = gy + dj;
                    if (ny_i < 0 || ny_i >= ny) continue;
                    for (int di = -rad; di <= rad; ++di) {
                        int man = abs(di) + abs(dj) + abs(dk);
                        if (man == 0 || (six_only && man != 1)) continue;
                        int nx_i = gx + di;
                        if (nx_i < 0 || nx_i >= nx) continue;
                        int nt = (nx_i >> 3) + (ny_i >> 3) * ntx + (nz_i >> 3) * ntx * nty;
                        int nc = (nx_i & 7) + (ny_i & 7) * 8 + (nz_i & 7) * 64;
                        RealType an = fluid_frac[nt].alpha_f[nc];
                        if (tier_ok(tier, an)) {
                            w_acc += nbr_weight(di, dj, dk, an);
                        }
                    }
                }
            }
            if (w_acc > (RealType)0.0) {
                w_sum = w_acc;
                pass_tier = tier;
            }
        }

        if (w_sum > (RealType)0.0) {
            int rad = (pass_tier == 4 || pass_tier == 7) ? 2 : 1;
            bool six_only = (pass_tier == 0 || pass_tier == 1 || pass_tier == 5);
            RealType inv_w = (RealType)1.0 / w_sum;
            for (int dk = -rad; dk <= rad; ++dk) {
                int nz_i = gz + dk;
                if (nz_i < 0 || nz_i >= nz) continue;
                for (int dj = -rad; dj <= rad; ++dj) {
                    int ny_i = gy + dj;
                    if (ny_i < 0 || ny_i >= ny) continue;
                    for (int di = -rad; di <= rad; ++di) {
                        int man = abs(di) + abs(dj) + abs(dk);
                        if (man == 0 || (six_only && man != 1)) continue;
                        int nx_i = gx + di;
                        if (nx_i < 0 || nx_i >= nx) continue;
                        int nt = (nx_i >> 3) + (ny_i >> 3) * ntx + (nz_i >> 3) * ntx * nty;
                        int nc = (nx_i & 7) + (ny_i & 7) * 8 + (nz_i & 7) * 64;
                        RealType an = fluid_frac[nt].alpha_f[nc];
                        if (tier_ok(pass_tier, an)) {
                            RealType frac = nbr_weight(di, dj, dk, an) * inv_w;
                            RealType v_share = a_push * frac;
                            atomicAdd(&Q_tmp[nt].rho[nc],   v_share * u_rho);
                            atomicAdd(&Q_tmp[nt].rhoux[nc], v_share * u_rx);
                            atomicAdd(&Q_tmp[nt].rhouy[nc], v_share * u_ry);
                            atomicAdd(&Q_tmp[nt].rhouz[nc], v_share * u_rz);
                            atomicAdd(&Q_tmp[nt].E[nc],     v_share * u_E);
                            if constexpr (IsMultiMaterial) {
                                atomicAdd(&Q_tmp[nt].arho1[nc],  v_share * u_ar1);
                                atomicAdd(&Q_tmp[nt].arho2[nc],  v_share * u_ar2);
                                atomicAdd(&Q_tmp[nt].alpha1[nc], v_share * u_a1);
                                atomicAdd(&Q_tmp[nt].alpha2[nc], v_share * u_a2);
                            }
                            atomicAdd(&fluid_frac[nt].alpha_tmp[nc], v_share);
                        }
                    }
                }
            }
        } else if (a_new > (RealType)0.0) {
            atomicAdd(&Q_tmp[t_idx].rho[c_idx],   a_push * u_rho);
            atomicAdd(&Q_tmp[t_idx].rhoux[c_idx], a_push * u_rx);
            atomicAdd(&Q_tmp[t_idx].rhouy[c_idx], a_push * u_ry);
            atomicAdd(&Q_tmp[t_idx].rhouz[c_idx], a_push * u_rz);
            atomicAdd(&Q_tmp[t_idx].E[c_idx],     a_push * u_E);
            if constexpr (IsMultiMaterial) {
                atomicAdd(&Q_tmp[t_idx].arho1[c_idx],  a_push * u_ar1);
                atomicAdd(&Q_tmp[t_idx].arho2[c_idx],  a_push * u_ar2);
                atomicAdd(&Q_tmp[t_idx].alpha1[c_idx], a_push * u_a1);
                atomicAdd(&Q_tmp[t_idx].alpha2[c_idx], a_push * u_a2);
            }
            atomicAdd(&fluid_frac[t_idx].alpha_tmp[c_idx], a_push);
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
__device__ inline RealType compute_uncover_need_and_donors(
    const FluidFractionTile3D<RealType>* fluid_frac,
    const ConservativeTile3D<RealType, IsMultiMaterial>* Q_curr,
    int mx, int my, int mz, int nx, int ny, int nz, int ntx, int nty,
    int& out_donors, bool& out_six_only
) {
    int mt = (mx >> 3) + (my >> 3) * ntx + (mz >> 3) * ntx * nty;
    int mc = (mx & 7) + (my & 7) * 8 + (mz & 7) * 64;
    RealType a_old = fluid_frac[mt].alpha_f_prev[mc];
    RealType a_new = fluid_frac[mt].alpha_f[mc];
    RealType q_rho = Q_curr[mt].rho[mc];
    RealType need = (a_old <= (RealType)0.0 && a_new > (RealType)0.0 && q_rho <= (RealType)1.0e-12)
                  ? a_new
                  : ((a_old < (RealType)FSI_ALPHA_CUT && a_new > a_old) ? (a_new - a_old) : (RealType)0.0);
    out_donors = 0;
    out_six_only = true;
    if (need <= (RealType)0.0) return (RealType)0.0;

    int d6 = 0;
    for (int f = 0; f < 6; ++f) {
        int ox = mx + (f == 0 ? -1 : (f == 1 ? 1 : 0));
        int oy = my + (f == 2 ? -1 : (f == 3 ? 1 : 0));
        int oz = mz + (f == 4 ? -1 : (f == 5 ? 1 : 0));
        if (ox < 0 || ox >= nx || oy < 0 || oy >= ny || oz < 0 || oz >= nz) continue;
        int nt = (ox >> 3) + (oy >> 3) * ntx + (oz >> 3) * ntx * nty;
        int nc = (ox & 7) + (oy & 7) * 8 + (oz & 7) * 64;
        if (fluid_frac[nt].alpha_f[nc] > (RealType)0.0 && Q_curr[nt].rho[nc] > (RealType)1.0e-12) ++d6;
    }
    if (d6 > 0) {
        out_donors = d6;
        out_six_only = true;
        return need;
    }
    int d26 = 0;
    for (int dk = -1; dk <= 1; ++dk) {
        int oz = mz + dk;
        if (oz < 0 || oz >= nz) continue;
        for (int dj = -1; dj <= 1; ++dj) {
            int oy = my + dj;
            if (oy < 0 || oy >= ny) continue;
            for (int di = -1; di <= 1; ++di) {
                if (di == 0 && dj == 0 && dk == 0) continue;
                int ox = mx + di;
                if (ox < 0 || ox >= nx) continue;
                int nt = (ox >> 3) + (oy >> 3) * ntx + (oz >> 3) * ntx * nty;
                int nc = (ox & 7) + (oy & 7) * 8 + (oz & 7) * 64;
                if (fluid_frac[nt].alpha_f[nc] > (RealType)0.0 && Q_curr[nt].rho[nc] > (RealType)1.0e-12) ++d26;
            }
        }
    }
    out_donors = d26;
    out_six_only = false;
    return (d26 > 0) ? need : (RealType)0.0;
}

// Pass B2: Donor-normalized conservative expansion into newly uncovering cells
// U_accum is initialized from Q_curr (= Q_tmp); Q_tmp is read-only.
template <typename RealType, bool IsMultiMaterial>
static __global__ void __launch_bounds__(256) kernel_fsi_remap_uncover_pull_3d(
    ConservativeTile3D<RealType, IsMultiMaterial>* U_accum,
    FluidFractionTile3D<RealType>* fluid_frac,
    const ConservativeTile3D<RealType, IsMultiMaterial>* Q_curr,
    int nx, int ny, int nz, int ntx, int nty
) {
    int gx = blockIdx.x * blockDim.x + threadIdx.x;
    int gy = blockIdx.y * blockDim.y + threadIdx.y;
    int gz = blockIdx.z * blockDim.z + threadIdx.z;
    if (gx >= nx || gy >= ny || gz >= nz) return;

    int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

    RealType a_self = fluid_frac[t_idx].alpha_f[c_idx];
    if (a_self <= (RealType)0.0 || Q_curr[t_idx].rho[c_idx] <= (RealType)1.0e-12) return;

    RealType demand_sum = (RealType)0.0;
    for (int dk = -1; dk <= 1; ++dk) {
        int mz = gz + dk;
        if (mz < 0 || mz >= nz) continue;
        for (int dj = -1; dj <= 1; ++dj) {
            int my = gy + dj;
            if (my < 0 || my >= ny) continue;
            for (int di = -1; di <= 1; ++di) {
                int man = abs(di) + abs(dj) + abs(dk);
                if (man == 0) continue;
                int mx = gx + di;
                if (mx < 0 || mx >= nx) continue;
                int n_don = 0;
                bool six_only = true;
                RealType need = compute_uncover_need_and_donors(fluid_frac, Q_curr, mx, my, mz, nx, ny, nz, ntx, nty, n_don, six_only);
                if (need > (RealType)0.0 && n_don > 0 && (!six_only || man == 1)) {
                    demand_sum += need / (RealType)n_don;
                }
            }
        }
    }

    if (demand_sum <= (RealType)0.0) return;

    RealType inv_tot = (RealType)1.0 / (a_self + demand_sum);
    RealType export_tot = demand_sum * inv_tot;

    RealType q_rho = Q_curr[t_idx].rho[c_idx];
    RealType q_rx  = Q_curr[t_idx].rhoux[c_idx];
    RealType q_ry  = Q_curr[t_idx].rhouy[c_idx];
    RealType q_rz  = Q_curr[t_idx].rhouz[c_idx];
    RealType q_E   = Q_curr[t_idx].E[c_idx];
    RealType q_a1 = (RealType)0.0, q_a2 = (RealType)0.0, q_ar1 = (RealType)0.0, q_ar2 = (RealType)0.0;
    RealType q_vsp = fluid_frac[t_idx].alpha_tmp[c_idx];
    if constexpr (IsMultiMaterial) {
        q_a1  = Q_curr[t_idx].alpha1[c_idx];
        q_a2  = Q_curr[t_idx].alpha2[c_idx];
        q_ar1 = Q_curr[t_idx].arho1[c_idx];
        q_ar2 = Q_curr[t_idx].arho2[c_idx];
    }

    atomicAdd(&U_accum[t_idx].rho[c_idx],   -export_tot * q_rho);
    atomicAdd(&U_accum[t_idx].rhoux[c_idx], -export_tot * q_rx);
    atomicAdd(&U_accum[t_idx].rhouy[c_idx], -export_tot * q_ry);
    atomicAdd(&U_accum[t_idx].rhouz[c_idx], -export_tot * q_rz);
    atomicAdd(&U_accum[t_idx].E[c_idx],     -export_tot * q_E);
    if constexpr (IsMultiMaterial) {
        atomicAdd(&U_accum[t_idx].arho1[c_idx],  -export_tot * q_ar1);
        atomicAdd(&U_accum[t_idx].arho2[c_idx],  -export_tot * q_ar2);
        atomicAdd(&U_accum[t_idx].alpha1[c_idx], -export_tot * q_a1);
        atomicAdd(&U_accum[t_idx].alpha2[c_idx], -export_tot * q_a2);
    }
    atomicAdd(&fluid_frac[t_idx].alpha_tmp[c_idx], -export_tot * q_vsp);

    for (int dk = -1; dk <= 1; ++dk) {
        int mz = gz + dk;
        if (mz < 0 || mz >= nz) continue;
        for (int dj = -1; dj <= 1; ++dj) {
            int my = gy + dj;
            if (my < 0 || my >= ny) continue;
            for (int di = -1; di <= 1; ++di) {
                int man = abs(di) + abs(dj) + abs(dk);
                if (man == 0) continue;
                int mx = gx + di;
                if (mx < 0 || mx >= nx) continue;
                int n_don = 0;
                bool six_only = true;
                RealType need = compute_uncover_need_and_donors(fluid_frac, Q_curr, mx, my, mz, nx, ny, nz, ntx, nty, n_don, six_only);
                if (need > (RealType)0.0 && n_don > 0 && (!six_only || man == 1)) {
                    RealType share = (need / (RealType)n_don) * inv_tot;
                    int mt = (mx >> 3) + (my >> 3) * ntx + (mz >> 3) * ntx * nty;
                    int mc = (mx & 7) + (my & 7) * 8 + (mz & 7) * 64;
                    atomicAdd(&U_accum[mt].rho[mc],   share * q_rho);
                    atomicAdd(&U_accum[mt].rhoux[mc], share * q_rx);
                    atomicAdd(&U_accum[mt].rhouy[mc], share * q_ry);
                    atomicAdd(&U_accum[mt].rhouz[mc], share * q_rz);
                    atomicAdd(&U_accum[mt].E[mc],     share * q_E);
                    if constexpr (IsMultiMaterial) {
                        atomicAdd(&U_accum[mt].arho1[mc],  share * q_ar1);
                        atomicAdd(&U_accum[mt].arho2[mc],  share * q_ar2);
                        atomicAdd(&U_accum[mt].alpha1[mc], share * q_a1);
                        atomicAdd(&U_accum[mt].alpha2[mc], share * q_a2);
                    }
                    atomicAdd(&fluid_frac[mt].alpha_tmp[mc], share * q_vsp);
                }
            }
        }
    }
}

// Pass B3: Divide extensive Q_final by alpha_f, update states, sync alpha_f_prev, clear Q_tmp & alpha_tmp
template <typename RealType, bool IsMultiMaterial>
static __global__ void __launch_bounds__(256) kernel_fsi_finalize_remap_3d(
    PrimitiveTile3D<RealType, IsMultiMaterial>* states,
    ConservativeTile3D<RealType, IsMultiMaterial>* U,
    FluidFractionTile3D<RealType>* fluid_frac,
    ConservativeTile3D<RealType, IsMultiMaterial>* Q_tmp,
    const GeometryTile3D* geom,
    const SolidVelocityTile3D* d_solid_vel,
    int nx, int ny, int nz, int ntx, int nty
) {
    int gx = blockIdx.x * blockDim.x + threadIdx.x;
    int gy = blockIdx.y * blockDim.y + threadIdx.y;
    int gz = blockIdx.z * blockDim.z + threadIdx.z;
    if (gx >= nx || gy >= ny || gz >= nz) return;

    int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

    RealType a_f = fluid_frac[t_idx].alpha_f[c_idx];
    if (a_f > (RealType)0.0) {
        RealType inv_a = (RealType)1.0 / a_f;
        U[t_idx].rho[c_idx]   = fmax((RealType)0.0, U[t_idx].rho[c_idx]) * inv_a;
        U[t_idx].rhoux[c_idx] *= inv_a;
        U[t_idx].rhouy[c_idx] *= inv_a;
        U[t_idx].rhouz[c_idx] *= inv_a;
        U[t_idx].E[c_idx]     *= inv_a;
        if constexpr (IsMultiMaterial) {
            U[t_idx].arho1[c_idx] = fmax((RealType)0.0, U[t_idx].arho1[c_idx]) * inv_a;
            U[t_idx].arho2[c_idx] = fmax((RealType)0.0, U[t_idx].arho2[c_idx]) * inv_a;
            RealType vsp = fluid_frac[t_idx].alpha_tmp[c_idx];
            if (vsp > (RealType)1.0e-12) {
                RealType inv_vsp = (RealType)1.0 / vsp;
                U[t_idx].alpha1[c_idx] = fmax((RealType)0.0, fmin((RealType)1.0, U[t_idx].alpha1[c_idx] * inv_vsp));
                U[t_idx].alpha2[c_idx] = fmax((RealType)0.0, fmin((RealType)(1.0 - U[t_idx].alpha1[c_idx]), U[t_idx].alpha2[c_idx] * inv_vsp));
            } else {
                U[t_idx].alpha1[c_idx] = (RealType)0.0;
                U[t_idx].alpha2[c_idx] = (RealType)0.0;
            }
        }
        convert_conservative_to_primitive_gpu<RealType, IsMultiMaterial>(U, states, geom, t_idx, c_idx, (RealType)0.0, d_solid_vel);
    } else {
        U[t_idx].rho[c_idx] = (RealType)0.0;
        U[t_idx].rhoux[c_idx] = (RealType)0.0;
        U[t_idx].rhouy[c_idx] = (RealType)0.0;
        U[t_idx].rhouz[c_idx] = (RealType)0.0;
        U[t_idx].E[c_idx] = (RealType)0.0;
        if constexpr (IsMultiMaterial) {
            U[t_idx].alpha1[c_idx] = (RealType)0.0;
            U[t_idx].alpha2[c_idx] = (RealType)0.0;
            U[t_idx].arho1[c_idx] = (RealType)0.0;
            U[t_idx].arho2[c_idx] = (RealType)0.0;
        }
        states[t_idx].ux[c_idx] = (RealType)d_solid_vel[t_idx].vx[c_idx];
        states[t_idx].uy[c_idx] = (RealType)d_solid_vel[t_idx].vy[c_idx];
        states[t_idx].uz[c_idx] = (RealType)d_solid_vel[t_idx].vz[c_idx];
    }

    fluid_frac[t_idx].alpha_f_prev[c_idx] = a_f;
    fluid_frac[t_idx].alpha_tmp[c_idx] = (RealType)0.0;
    Q_tmp[t_idx].rho[c_idx] = (RealType)0.0;
    Q_tmp[t_idx].rhoux[c_idx] = (RealType)0.0;
    Q_tmp[t_idx].rhouy[c_idx] = (RealType)0.0;
    Q_tmp[t_idx].rhouz[c_idx] = (RealType)0.0;
    Q_tmp[t_idx].E[c_idx] = (RealType)0.0;
    if constexpr (IsMultiMaterial) {
        Q_tmp[t_idx].alpha1[c_idx] = (RealType)0.0;
        Q_tmp[t_idx].alpha2[c_idx] = (RealType)0.0;
        Q_tmp[t_idx].arho1[c_idx] = (RealType)0.0;
        Q_tmp[t_idx].arho2[c_idx] = (RealType)0.0;
    }
}

// Pass C0: Accumulate overlapping MPM particle mass M_cell into Q_tmp.rho per CFD cell
template <typename RealType, bool IsMultiMaterial>
static __global__ void kernel_fsi_accum_particle_cell_mass_gpu(
    ConservativeTile3D<RealType, IsMultiMaterial>* Q_tmp,
    Blast::MPMParticle3DSoA soa,
    int num_particles,
    const Blast::MaterialTable3D* d_mat_tables,
    int nx_cfd, int ny_cfd, int nz_cfd, int ntx, int nty,
    float dx_cfd, float dy_cfd, float dz_cfd,
    float xmin_cfd, float ymin_cfd, float zmin_cfd
) {
    int p_idx = blockIdx.x * blockDim.x + threadIdx.x;
    float p_m, p_V_eff, px, py, pz, hx, hy, hz;
    int i0, i1, j0, j1, k0, k1;
    if (!fsi_prepare_particle_voxel(soa, p_idx, num_particles, d_mat_tables,
                                    nx_cfd, ny_cfd, nz_cfd, dx_cfd, dy_cfd, dz_cfd, xmin_cfd, ymin_cfd, zmin_cfd,
                                    p_m, p_V_eff, px, py, pz, hx, hy, hz, i0, i1, j0, j1, k0, k1)) {
        return;
    }

    float inv_pV = 1.0f / p_V_eff;
    for (int gz = k0; gz <= k1; ++gz) {
        float cz0 = zmin_cfd + static_cast<float>(gz) * dz_cfd;
        float oz = fminf(pz + hz, cz0 + dz_cfd) - fmaxf(pz - hz, cz0);
        if (oz <= 1.0e-12f) continue;
        for (int gy = j0; gy <= j1; ++gy) {
            float cy0 = ymin_cfd + static_cast<float>(gy) * dy_cfd;
            float oy = fminf(py + hy, cy0 + dy_cfd) - fmaxf(py - hy, cy0);
            if (oy <= 1.0e-12f) continue;
            for (int gx = i0; gx <= i1; ++gx) {
                float cx0 = xmin_cfd + static_cast<float>(gx) * dx_cfd;
                float ox = fminf(px + hx, cx0 + dx_cfd) - fmaxf(px - hx, cx0);
                if (ox <= 1.0e-12f) continue;
                float m_ov = p_m * ((ox * oy * oz) * inv_pV);
                int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
                int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;
                atomicAdd(&Q_tmp[t_idx].rho[c_idx], static_cast<RealType>(m_ov));
            }
        }
    }
}

// Pass C1: Compute exact matched Riemann wall pressure + dilute drag force per CFD cell, store F_cell / M_cell in Q_tmp.rhou
template <typename RealType, bool IsMultiMaterial>
static __global__ void kernel_fsi_compute_cfd_cell_forces_gpu(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    const FluidFractionTile3D<RealType>* fluid_frac,
    const GeometryTile3D* d_geom,
    const SolidVelocityTile3D* d_solid_vel,
    FluidDragTile3D* d_drag,
    ConservativeTile3D<RealType, IsMultiMaterial>* Q_tmp,
    int nx_cfd, int ny_cfd, int nz_cfd, int ntx, int nty,
    float dx_cfd, float dy_cfd, float dz_cfd
) {
    int gx = blockIdx.x * blockDim.x + threadIdx.x;
    int gy = blockIdx.y * blockDim.y + threadIdx.y;
    int gz = blockIdx.z * blockDim.z + threadIdx.z;
    if (gx >= nx_cfd || gy >= ny_cfd || gz >= nz_cfd) return;

    int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

    RealType M_cell = Q_tmp[t_idx].rho[c_idx];
    if (M_cell <= (RealType)1.0e-15) return;

    RealType a_self = get_alpha_f_gpu(fluid_frac, d_geom, gx, gy, gz);
    float vx_w = d_solid_vel[t_idx].vx[c_idx];
    float vy_w = d_solid_vel[t_idx].vy[c_idx];
    float vz_w = d_solid_vel[t_idx].vz[c_idx];
    RealType vn_w[3] = { (RealType)vx_w, (RealType)vy_w, (RealType)vz_w };
    RealType areas[3] = { (RealType)(dy_cfd * dz_cfd), (RealType)(dx_cfd * dz_cfd), (RealType)(dx_cfd * dy_cfd) };

    RealType F_mpm[3] = { (RealType)0.0, (RealType)0.0, (RealType)0.0 };

    // 1. Exact action-reaction against neighboring more-open CFD cells across all 6 faces
    for (int f = 0; f < 6; ++f) {
        int dir = f >> 1;
        int dir_sign = (f & 1) ? 1 : -1;
        int ox = gx + (dir == 0 ? dir_sign : 0);
        int oy = gy + (dir == 1 ? dir_sign : 0);
        int oz = gz + (dir == 2 ? dir_sign : 0);
        if (ox < 0 || ox >= nx_cfd || oy < 0 || oy >= ny_cfd || oz < 0 || oz >= nz_cfd) continue;

        RealType a_nb = get_alpha_f_gpu(fluid_frac, d_geom, ox, oy, oz);
        if (a_nb > a_self) {
            RealType A_wall = a_nb - a_self;
            GPUCellStateT<RealType, IsMultiMaterial> s_nb = sample_gpu_raw<RealType, IsMultiMaterial>(d_states, ox, oy, oz);
            RealType n_out = (RealType)(-dir_sign);
            if (d_has_gravity) {
                RealType g_comp = (dir == 0) ? (RealType)d_gravity_x
                                : ((dir == 1) ? (RealType)d_gravity_y : (RealType)d_gravity_z);
                s_nb.p += (RealType)0.5 * s_nb.rho * g_comp * (RealType)d_cellSize * n_out;
            }
            RealType z_c = (RealType)d_zmin + ((RealType)oz + (RealType)0.5) * (RealType)d_cellSize;
            RealType p_wall = compute_fsi_wall_pressure_normal_gpu<RealType, IsMultiMaterial>(s_nb, vn_w[0], vn_w[1], vn_w[2], d_geom, gx, gy, gz, dir, n_out, z_c);
            F_mpm[dir] += (RealType)(-dir_sign) * A_wall * p_wall * areas[dir];
        }
    }

    // 2. Dispersed sub-grid two-way drag strictly when NO resolved solid exists in 3x3x3 neighborhood
    float max_alpha_s_local = 0.0f;
    for (int dk = -1; dk <= 1; ++dk) {
        int nk = gz + dk;
        if (nk < 0 || nk >= nz_cfd) continue;
        for (int dj = -1; dj <= 1; ++dj) {
            int nj = gy + dj;
            if (nj < 0 || nj >= ny_cfd) continue;
            for (int di = -1; di <= 1; ++di) {
                int ni = gx + di;
                if (ni < 0 || ni >= nx_cfd) continue;
                float as_n = 1.0f - static_cast<float>(get_alpha_f_gpu(fluid_frac, d_geom, ni, nj, nk));
                max_alpha_s_local = fmaxf(max_alpha_s_local, as_n);
            }
        }
    }

    if (max_alpha_s_local < FSI_DILUTE_MAX_ALPHA && a_self > (RealType)FSI_ALPHA_DEAD) {
        float V_cell_cfd = fmaxf(1.0e-30f, dx_cfd * dy_cfd * dz_cfd);
        float v_solid_cell = static_cast<float>(fmax((RealType)0.0, (RealType)1.0 - a_self)) * V_cell_cfd;
        GPUCellStateT<RealType, IsMultiMaterial> s_c = sample_gpu_raw<RealType, IsMultiMaterial>(d_states, gx, gy, gz);
        float rel_vx = static_cast<float>(s_c.ux) - vx_w;
        float rel_vy = static_cast<float>(s_c.uy) - vy_w;
        float rel_vz = static_cast<float>(s_c.uz) - vz_w;
        float rel_mag = sqrtf(rel_vx * rel_vx + rel_vy * rel_vy + rel_vz * rel_vz);
        if (rel_mag > 1.0e-6f && v_solid_cell > 1.0e-20f) {
            float rho_f = fmaxf(1.0e-4f, static_cast<float>(s_c.rho));
            float p_f = fmaxf(100.0f, static_cast<float>(s_c.p));
            float c_s = sqrtf(fmaxf(100.0f, static_cast<float>(d_gamma) * p_f / rho_f));
            float M_rel = rel_mag / c_s;
            float Cd = (M_rel > 1.0f) ? fminf(1.8f, 1.2f + 0.4f * (M_rel - 1.0f)) : 1.0f;
            float A_proj = fminf(dx_cfd * dy_cfd, 1.21f * powf(fmaxf(1.0e-12f, v_solid_cell), 0.6666667f));
            float k_d = 0.5f * Cd * rho_f * A_proj * rel_mag;
            float Fx_d = k_d * rel_vx;
            float Fy_d = k_d * rel_vy;
            float Fz_d = k_d * rel_vz;

            float m_f_cell = static_cast<float>(a_self) * rho_f * V_cell_cfd;
            float dt_est = fminf(dx_cfd, fminf(dy_cfd, dz_cfd)) / fmaxf(100.0f, c_s + rel_mag);
            float F_cap = 0.25f * fminf(static_cast<float>(M_cell), fmaxf(1.0e-8f, m_f_cell)) * rel_mag / fmaxf(1.0e-8f, dt_est);
            float F_mag = sqrtf(Fx_d * Fx_d + Fy_d * Fy_d + Fz_d * Fz_d);
            if (F_mag > F_cap && F_mag > 1.0e-12f) {
                float sc = F_cap / F_mag;
                Fx_d *= sc; Fy_d *= sc; Fz_d *= sc;
            }
            F_mpm[0] += (RealType)Fx_d;
            F_mpm[1] += (RealType)Fy_d;
            F_mpm[2] += (RealType)Fz_d;

            if (d_drag) {
                float inv_V = 1.0f / V_cell_cfd;
                float P_drag = (Fx_d * vx_w + Fy_d * vy_w + Fz_d * vz_w);
                d_drag[t_idx].fx[c_idx]    = -Fx_d * inv_V;
                d_drag[t_idx].fy[c_idx]    = -Fy_d * inv_V;
                d_drag[t_idx].fz[c_idx]    = -Fz_d * inv_V;
                d_drag[t_idx].power[c_idx] = -P_drag * inv_V;
            }
        }
    }

    RealType inv_M = (RealType)1.0 / M_cell;
    Q_tmp[t_idx].rhoux[c_idx] = F_mpm[0] * inv_M;
    Q_tmp[t_idx].rhouy[c_idx] = F_mpm[1] * inv_M;
    Q_tmp[t_idx].rhouz[c_idx] = F_mpm[2] * inv_M;
}

// Pass C2_gather: Integrate conservative cell accelerations onto overlapping MPM particles
template <typename RealType, bool IsMultiMaterial>
static __global__ void kernel_fsi_gather_particle_forces_gpu(
    float* d_part_forces_xyz,
    const ConservativeTile3D<RealType, IsMultiMaterial>* Q_tmp,
    Blast::MPMParticle3DSoA soa,
    int num_particles,
    const Blast::MaterialTable3D* d_mat_tables,
    int nx_cfd, int ny_cfd, int nz_cfd, int ntx, int nty,
    float dx_cfd, float dy_cfd, float dz_cfd,
    float xmin_cfd, float ymin_cfd, float zmin_cfd
) {
    int p_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (p_idx >= num_particles) return;

    d_part_forces_xyz[p_idx * 3 + 0] = 0.0f;
    d_part_forces_xyz[p_idx * 3 + 1] = 0.0f;
    d_part_forces_xyz[p_idx * 3 + 2] = 0.0f;

    float p_m, p_V_eff, px, py, pz, hx, hy, hz;
    int i0, i1, j0, j1, k0, k1;
    if (!fsi_prepare_particle_voxel(soa, p_idx, num_particles, d_mat_tables,
                                    nx_cfd, ny_cfd, nz_cfd, dx_cfd, dy_cfd, dz_cfd, xmin_cfd, ymin_cfd, zmin_cfd,
                                    p_m, p_V_eff, px, py, pz, hx, hy, hz, i0, i1, j0, j1, k0, k1)) {
        return;
    }

    float F_p0 = 0.0f, F_p1 = 0.0f, F_p2 = 0.0f;
    float inv_pV = 1.0f / p_V_eff;
    for (int gz = k0; gz <= k1; ++gz) {
        float cz0 = zmin_cfd + static_cast<float>(gz) * dz_cfd;
        float oz = fminf(pz + hz, cz0 + dz_cfd) - fmaxf(pz - hz, cz0);
        if (oz <= 1.0e-12f) continue;
        for (int gy = j0; gy <= j1; ++gy) {
            float cy0 = ymin_cfd + static_cast<float>(gy) * dy_cfd;
            float oy = fminf(py + hy, cy0 + dy_cfd) - fmaxf(py - hy, cy0);
            if (oy <= 1.0e-12f) continue;
            for (int gx = i0; gx <= i1; ++gx) {
                float cx0 = xmin_cfd + static_cast<float>(gx) * dx_cfd;
                float ox = fminf(px + hx, cx0 + dx_cfd) - fmaxf(px - hx, cx0);
                if (ox <= 1.0e-12f) continue;
                float m_ov = p_m * ((ox * oy * oz) * inv_pV);
                int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
                int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;
                F_p0 += m_ov * static_cast<float>(Q_tmp[t_idx].rhoux[c_idx]);
                F_p1 += m_ov * static_cast<float>(Q_tmp[t_idx].rhouy[c_idx]);
                F_p2 += m_ov * static_cast<float>(Q_tmp[t_idx].rhouz[c_idx]);
            }
        }
    }

    d_part_forces_xyz[p_idx * 3 + 0] = F_p0;
    d_part_forces_xyz[p_idx * 3 + 1] = F_p1;
    d_part_forces_xyz[p_idx * 3 + 2] = F_p2;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::coupleFSIWithMPMGPU(void* mpm_solver_void) {
    ensure_paged_in();
    bind_constants();
    if (!mpm_solver_void) return;
    Blast::MPMSolver3DCUDA* mpm_solver = static_cast<Blast::MPMSolver3DCUDA*>(mpm_solver_void);
    Blast::MPMGridNode3D* d_grid = mpm_solver->getDeviceGrid();
    if (!d_grid) return;
    Blast::MPMGridView3D gv = mpm_solver->getDeviceGridView();

    // Coupling active: ensure MPM defers density-erosion cleanup to erodeMPMParticlesToCFDGPU
    mpm_solver->setDeferFVErosionToCoupler(true);

    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    dim3 block(8, 8, 4);
    dim3 grid((nx + 7) / 8, (ny + 7) / 8, (nz + 3) / 4);

    this->d_fsi_mpm_grid = d_grid;
    this->m_fsi_mpm_solver = mpm_solver_void;

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

    size_t ff_bytes = total_tiles * sizeof(FluidFractionTile3D<RealType>);
    if (!d_fluid_frac_fsi || d_fluid_frac_fsi_capacity < ff_bytes) {
        if (d_fluid_frac_fsi) cudaFree(d_fluid_frac_fsi);
        CHECK_CUDA(cudaMalloc(&d_fluid_frac_fsi, ff_bytes));
        CHECK_CUDA(cudaMemset(d_fluid_frac_fsi, 0, ff_bytes));
        d_fluid_frac_fsi_capacity = ff_bytes;
        has_prev_alpha_f = false;
    }

    size_t q_tmp_bytes = total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>);
    if (!d_fsi_Q_tmp || d_fsi_Q_tmp_capacity < q_tmp_bytes) {
        if (d_fsi_Q_tmp) cudaFree(d_fsi_Q_tmp);
        CHECK_CUDA(cudaMalloc(&d_fsi_Q_tmp, q_tmp_bytes));
        d_fsi_Q_tmp_capacity = q_tmp_bytes;
    }

    size_t drag_bytes = total_tiles * sizeof(FluidDragTile3D);
    if (!d_fsi_drag_fsi || d_fsi_drag_fsi_capacity < drag_bytes) {
        if (d_fsi_drag_fsi) cudaFree(d_fsi_drag_fsi);
        CHECK_CUDA(cudaMalloc(&d_fsi_drag_fsi, drag_bytes));
        d_fsi_drag_fsi_capacity = drag_bytes;
    }
    CHECK_CUDA(cudaMemsetAsync(d_fsi_drag_fsi, 0, drag_bytes));
    CHECK_CUDA(cudaMemsetAsync(d_fsi_Q_tmp, 0, q_tmp_bytes));

    int* d_active_nodes = mpm_solver->getDeviceActiveNodes();
    int num_active_nodes = mpm_solver->getNumActiveNodes();
    size_t num_particles_sz = mpm_solver->getParticleCount();
    int num_particles = static_cast<int>(num_particles_sz);
    Blast::MPMParticle3DSoA mpm_soa = mpm_solver->getDeviceParticlesSoA();
    const Blast::MaterialTable3D* mpm_mats = mpm_solver->getDeviceMaterialTables();

    if (num_active_nodes > 0 && d_active_nodes) {
        int threads_active = 256;
        int blocks_active = (num_active_nodes + threads_active - 1) / threads_active;
        kernel_fsi_clear_mpm_fext_gpu<<<blocks_active, threads_active>>>(
            d_grid, d_active_nodes, num_active_nodes, gv
        );
        CHECK_CUDA(cudaGetLastError());
    }

    // Pass A: Exact particle-voxel MPM volume occupancy and solid velocities onto CFD tiles
    if (num_particles > 0 && mpm_mats) {
        int threads_p = 256;
        int blocks_p = (num_particles + threads_p - 1) / threads_p;
        kernel_fsi_accum_mpm_occupancy_gpu<RealType, IsMultiMaterial><<<blocks_p, threads_p>>>(
            d_fluid_frac_fsi,
            d_fsi_Q_tmp,
            mpm_soa,
            num_particles,
            mpm_mats,
            nx, ny, nz, ntx, nty,
            (float)cellSize, (float)cellSize, (float)cellSize,
            (float)xmin, (float)ymin, (float)zmin
        );
        CHECK_CUDA(cudaGetLastError());
    }

    kernel_fsi_finalize_occupancy_gpu<RealType, IsMultiMaterial><<<grid, block>>>(
        d_fluid_frac_fsi,
        d_fsi_Q_tmp,
        d_solid_vel_fsi,
        nx, ny, nz, ntx, nty,
        has_prev_alpha_f
    );
    CHECK_CUDA(cudaGetLastError());

    kernel_fsi_classify_unresolved_slivers_gpu<RealType><<<grid, block>>>(
        d_fluid_frac_fsi,
        nx, ny, nz, ntx, nty
    );
    CHECK_CUDA(cudaGetLastError());

    kernel_fsi_write_geom_and_seal_gpu<RealType><<<grid, block>>>(
        d_fluid_frac_fsi,
        (GeometryTile3D*)d_geom,
        nx, ny, nz, ntx, nty,
        has_prev_alpha_f
    );
    CHECK_CUDA(cudaGetLastError());

    // Pass B: Conservative alpha_f_prev -> alpha_f cell volume-fraction remap
    if (has_prev_alpha_f && d_states && d_U) {
        kernel_fsi_remap_cover_push_3d<RealType, IsMultiMaterial><<<grid, block>>>(
            (const ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
            d_fluid_frac_fsi,
            d_fsi_Q_tmp,
            (const GeometryTile3D*)d_geom,
            nx, ny, nz, ntx, nty
        );
        CHECK_CUDA(cudaGetLastError());

        CHECK_CUDA(cudaMemcpyAsync(d_U, d_fsi_Q_tmp, q_tmp_bytes, cudaMemcpyDeviceToDevice));

        kernel_fsi_remap_uncover_pull_3d<RealType, IsMultiMaterial><<<grid, block>>>(
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
            d_fluid_frac_fsi,
            (const ConservativeTile3D<RealType, IsMultiMaterial>*)d_fsi_Q_tmp,
            nx, ny, nz, ntx, nty
        );
        CHECK_CUDA(cudaGetLastError());

        kernel_fsi_finalize_remap_3d<RealType, IsMultiMaterial><<<grid, block>>>(
            (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
            d_fluid_frac_fsi,
            d_fsi_Q_tmp,
            (const GeometryTile3D*)d_geom,
            (const SolidVelocityTile3D*)d_solid_vel_fsi,
            nx, ny, nz, ntx, nty
        );
        CHECK_CUDA(cudaGetLastError());
    }
    has_prev_alpha_f = true;

    int threads_mask = 256;
    int blocks_mask = (total_tiles + threads_mask - 1) / threads_mask;
    kernel_extract_uncovering_mask_3d<<<blocks_mask, threads_mask>>>(d_prev_mask, (const GeometryTile3D*)d_geom, total_tiles);
    CHECK_CUDA(cudaGetLastError());
    has_prev_mask = true;

    // Pass C: Matched FV->MPM Riemann wall pressure reaction + dilute two-way drag via conservative particle-voxel gather
    if (num_particles > 0 && mpm_mats && d_states) {
        size_t pf_bytes = num_particles_sz * 3 * sizeof(float);
        if (!d_fsi_part_forces || d_fsi_part_forces_capacity < pf_bytes) {
            if (d_fsi_part_forces) cudaFree(d_fsi_part_forces);
            CHECK_CUDA(cudaMalloc(&d_fsi_part_forces, pf_bytes));
            d_fsi_part_forces_capacity = pf_bytes;
        }
        int threads_p = 256;
        int blocks_p = (num_particles + threads_p - 1) / threads_p;

        kernel_fsi_accum_particle_cell_mass_gpu<RealType, IsMultiMaterial><<<blocks_p, threads_p>>>(
            d_fsi_Q_tmp,
            mpm_soa,
            num_particles,
            mpm_mats,
            nx, ny, nz, ntx, nty,
            (float)cellSize, (float)cellSize, (float)cellSize,
            (float)xmin, (float)ymin, (float)zmin
        );
        CHECK_CUDA(cudaGetLastError());

        kernel_fsi_compute_cfd_cell_forces_gpu<RealType, IsMultiMaterial><<<grid, block>>>(
            (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            d_fluid_frac_fsi,
            (const GeometryTile3D*)d_geom,
            (const SolidVelocityTile3D*)d_solid_vel_fsi,
            d_fsi_drag_fsi,
            d_fsi_Q_tmp,
            nx, ny, nz, ntx, nty,
            (float)cellSize, (float)cellSize, (float)cellSize
        );
        CHECK_CUDA(cudaGetLastError());

        kernel_fsi_gather_particle_forces_gpu<RealType, IsMultiMaterial><<<blocks_p, threads_p>>>(
            d_fsi_part_forces,
            (const ConservativeTile3D<RealType, IsMultiMaterial>*)d_fsi_Q_tmp,
            mpm_soa,
            num_particles,
            mpm_mats,
            nx, ny, nz, ntx, nty,
            (float)cellSize, (float)cellSize, (float)cellSize,
            (float)xmin, (float)ymin, (float)zmin
        );
        CHECK_CUDA(cudaGetLastError());

        mpm_solver->scatterParticleForcesToGridGPU(d_fsi_part_forces, num_particles_sz);
        CHECK_CUDA(cudaMemsetAsync(d_fsi_Q_tmp, 0, q_tmp_bytes));
    }

    if (m_zonal_handoff_params.enabled) {
        coupleZonalHandoffWithMPMGPU(mpm_solver_void);
    }

    if (mpm_solver->getTimeScheme() == Blast::MPMTimeIntegrationScheme::RK2) {
        mpm_solver->storeFSIForces();
    }

    int threads_tile = 256;
    int blocks_tile = (total_tiles + threads_tile - 1) / threads_tile;
    if (!d_tile_has_boundary_buf || d_tile_has_boundary_capacity < total_tiles * sizeof(uint8_t)) {
        if (d_tile_has_boundary_buf) cudaFree(d_tile_has_boundary_buf);
        CHECK_CUDA(cudaMalloc(&d_tile_has_boundary_buf, total_tiles * sizeof(uint8_t)));
        d_tile_has_boundary_capacity = total_tiles * sizeof(uint8_t);
    }
    kernel_mark_tile_has_boundary_fsi_3d<RealType><<<blocks_tile, threads_tile>>>(
        (const GeometryTile3D*)d_geom,
        d_fluid_frac_fsi,
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

    updateActiveRegions();
    last_cached_tile_idx = -1;
}

template <typename RealType, bool IsMultiMaterial>
static __global__ void kernel_erode_mpm_particles_to_cfd_gpu(
    ConservativeTile3D<RealType, IsMultiMaterial>* Q_erode,
    FluidFractionTile3D<RealType>* fluid_frac,
    const GeometryTile3D* d_geom,
    uint8_t* d_active_tiles,
    Blast::MPMParticle3DSoA soa,
    int num_particles,
    const Blast::MaterialTable3D* d_mat_tables,
    const Blast::MPMGridNode3D* d_grid,
    int nx_mpm, int ny_mpm, int nz_mpm,
    Blast::MPMGridView3D gv,
    int nx_cfd, int ny_cfd, int nz_cfd,
    int ntx, int nty,
    float dx_cfd, float dy_cfd, float dz_cfd,
    float xmin_cfd, float ymin_cfd, float zmin_cfd,
    int* d_boundary_flags,
    int* d_eroded_count,
    float dx_mpm, float dy_mpm, float dz_mpm,
    int mpm_transfer_scheme, int mpm_velocity_scheme
) {
    int p_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (p_idx >= num_particles) return;
    if ((soa.state && soa.state[p_idx] == 2) || soa.m[p_idx] <= 0.0f) return;

    int obj_id = soa.object_id[p_idx];
    const Blast::MaterialTable3D& mat = d_mat_tables[obj_id];
    if (!mat.enable_density_erosion || !mat.erode_to_fv_grid) return;

    const bool is_fluid = (mat.material_model == Blast::MPMMaterialModel::TaitWater);
    const bool is_energetic = (mat.material_model == Blast::MPMMaterialModel::CRESTReactiveBurn) ||
                              (mat.material_model == Blast::MPMMaterialModel::JWLProgrammedBurn) ||
                              (mat.material_model == Blast::MPMMaterialModel::LeeTarverIgnitionGrowth);
    if (!is_fluid && !is_energetic) return;

    const float m_p = soa.m[p_idx];
    const float V_p = fmaxf(soa.V[p_idx], 1.0e-30f);
    const float V0_p = fmaxf(soa.V0[p_idx], 1.0e-30f);
    const float rho_p = m_p / V_p;
    const float rho0 = (is_fluid && mat.tait_rho0 > 0.0f) ? mat.tait_rho0 : mat.density;
    const float rho_thresh = fmaxf(mat.erosion_min_density, mat.erosion_min_density_ratio * rho0);
    const float lam_p = soa.lambda ? soa.lambda[p_idx] : 0.0f;
    const bool burn_ready = !is_energetic || (lam_p >= 0.5f || V_p > 1.05f * V0_p);

    if (rho_thresh <= 0.0f || !burn_ready || rho_p >= rho_thresh) return;

    const float px = soa.x[0][p_idx];
    const float py = soa.x[1][p_idx];
    const float pz = soa.x[2][p_idx];

    float xg = (px - xmin_cfd) / dx_cfd - 0.5f;
    float yg = (py - ymin_cfd) / dy_cfd - 0.5f;
    float zg = (pz - zmin_cfd) / dz_cfd - 0.5f;
    int ix = static_cast<int>(floorf(xg + 0.5f));
    int iy = static_cast<int>(floorf(yg + 0.5f));
    int iz = static_cast<int>(floorf(zg + 0.5f));
    float fx = xg - static_cast<float>(ix);
    float fy = yg - static_cast<float>(iy);
    float fz = zg - static_cast<float>(iz);

    float wx[3] = { 0.5f * (0.5f - fx) * (0.5f - fx), 0.75f - fx * fx, 0.5f * (0.5f + fx) * (0.5f + fx) };
    float wy[3] = { 0.5f * (0.5f - fy) * (0.5f - fy), 0.75f - fy * fy, 0.5f * (0.5f + fy) * (0.5f + fy) };
    float wz[3] = { 0.5f * (0.5f - fz) * (0.5f - fz), 0.75f - fz * fz, 0.5f * (0.5f + fz) * (0.5f + fz) };

    auto is_cell_eligible = [&](int cx, int cy, int cz) -> bool {
        if (cx < 0 || cx >= nx_cfd || cy < 0 || cy >= ny_cfd || cz < 0 || cz >= nz_cfd) return false;
        int nt = (cx >> 3) + (cy >> 3) * ntx + (cz >> 3) * ntx * nty;
        int nc = (cx & 7) + (cy & 7) * 8 + (cz & 7) * 64;
        RealType af = fluid_frac ? fluid_frac[nt].alpha_f[nc]
                                 : ((!d_geom || !d_geom[nt].cells[nc].is_boundary) ? (RealType)1.0 : (RealType)0.0);
        if (af > (RealType)FSI_ALPHA_DEAD) return true;
        if (is_energetic && d_grid && nx_mpm == nx_cfd && ny_mpm == ny_cfd && nz_mpm == nz_cfd) {
            const long long mslot = resolve_fsi_mpm_slot(cx, cy, cz, nx_mpm, ny_mpm, nz_mpm, gv);
            if (mslot >= 0 && d_grid[mslot].v_energetic > 1.0e-20f) return true;
        }
        return false;
    };

    float w_sum = 0.0f;
    for (int dk = -1; dk <= 1; ++dk) {
        for (int dj = -1; dj <= 1; ++dj) {
            for (int di = -1; di <= 1; ++di) {
                if (is_cell_eligible(ix + di, iy + dj, iz + dk)) {
                    w_sum += wx[di + 1] * wy[dj + 1] * wz[dk + 1];
                }
            }
        }
    }
    if (w_sum <= 1.0e-12f || !Q_erode) {
        return; // Enclosed inside un-eroded structural solid; retain particle until a cell opens
    }

    const float V_cell = fmaxf(dx_cfd * dy_cfd * dz_cfd, 1.0e-30f);
    const float vx = soa.v[0][p_idx];
    const float vy = soa.v[1][p_idx];
    const float vz = soa.v[2][p_idx];
    float ke_spec = 0.5f * (vx * vx + vy * vy + vz * vz);
    if (mpm_velocity_scheme == 0 && soa.B[0][0]) {
        int eff_scheme = (mat.transfer_scheme >= 0) ? mat.transfer_scheme : mpm_transfer_scheme;
        float d_scale = (eff_scheme == 2) ? 4.0f : ((eff_scheme == 0) ? 6.0f : ((eff_scheme == 4) ? 3.0f : 0.0f));
        if (d_scale > 0.0f) {
            float Dx = (dx_mpm * dx_mpm) / d_scale;
            float Dy = (dy_mpm * dy_mpm) / d_scale;
            float Dz = (dz_mpm * dz_mpm) / d_scale;
            float b2_sum = 0.0f;
            for (int r = 0; r < 3; ++r) {
                float br0 = soa.B[r][0][p_idx];
                float br1 = soa.B[r][1][p_idx];
                float br2 = soa.B[r][2][p_idx];
                b2_sum += Dx * br0 * br0 + Dy * br1 * br1 + Dz * br2 * br2;
            }
            ke_spec += 0.5f * b2_sum;
        }
    }
    const float e_int_p = soa.e_int ? fmaxf(0.0f, soa.e_int[p_idx]) : 0.0f;
    const float inv_w_V = 1.0f / (w_sum * V_cell);
    const float alpha_vol = V_p * inv_w_V;

    for (int dk = -1; dk <= 1; ++dk) {
        int cz = iz + dk;
        for (int dj = -1; dj <= 1; ++dj) {
            int cy = iy + dj;
            for (int di = -1; di <= 1; ++di) {
                int cx = ix + di;
                if (!is_cell_eligible(cx, cy, cz)) continue;
                float w_raw = wx[di + 1] * wy[dj + 1] * wz[dk + 1];
                if (w_raw <= 1.0e-9f) continue;

                int nt = (cx >> 3) + (cy >> 3) * ntx + (cz >> 3) * ntx * nty;
                int nc = (cx & 7) + (cy & 7) * 8 + (cz & 7) * 64;
                float drho = w_raw * m_p * inv_w_V;
                float dE = drho * (e_int_p + ke_spec);
                float d_vf = w_raw * alpha_vol;

                atomicAdd(&Q_erode[nt].rho[nc],   static_cast<RealType>(drho));
                atomicAdd(&Q_erode[nt].rhoux[nc], static_cast<RealType>(drho * vx));
                atomicAdd(&Q_erode[nt].rhouy[nc], static_cast<RealType>(drho * vy));
                atomicAdd(&Q_erode[nt].rhouz[nc], static_cast<RealType>(drho * vz));
                atomicAdd(&Q_erode[nt].E[nc],     static_cast<RealType>(dE));
                if constexpr (IsMultiMaterial) {
                    if (is_energetic) {
                        atomicAdd(&Q_erode[nt].arho1[nc],  static_cast<RealType>(drho));
                        atomicAdd(&Q_erode[nt].alpha1[nc], static_cast<RealType>(d_vf));
                    }
                }
                if (fluid_frac) {
                    atomicAdd(&fluid_frac[nt].alpha_tmp[nc], static_cast<RealType>(d_vf));
                }
                if (d_active_tiles) {
                    d_active_tiles[nt] = 2;
                }
            }
        }
    }

    if (soa.state) soa.state[p_idx] = 2;
    soa.m[p_idx] = 0.0f;
    soa.v[0][p_idx] = 0.0f;
    soa.v[1][p_idx] = 0.0f;
    soa.v[2][p_idx] = 0.0f;
    if (soa.B[0][0]) {
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                soa.B[r][c][p_idx] = 0.0f;
    }
    if (soa.sigma_voigt[0]) {
        for (int k = 0; k < 6; ++k) soa.sigma_voigt[k][p_idx] = 0.0f;
    } else if (soa.sigma[0][0]) {
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                soa.sigma[r][c][p_idx] = 0.0f;
    }
    if (d_boundary_flags) d_boundary_flags[1] = 1;
    if (d_eroded_count) atomicAdd(d_eroded_count, 1);
}

template <typename RealType, bool IsMultiMaterial>
static __global__ void __launch_bounds__(512) kernel_sync_eroded_cfd_tiles_gpu(
    PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    ConservativeTile3D<RealType, IsMultiMaterial>* d_U,
    ConservativeTile3D<RealType, IsMultiMaterial>* Q_erode,
    FluidFractionTile3D<RealType>* fluid_frac,
    uint8_t* d_active_tiles,
    GeometryTile3D* d_geom,
    const SolidVelocityTile3D* d_solid_vel,
    int nx, int ny, int nz, int ntx, int nty
) {
    int t_idx = blockIdx.x;
    if (!d_active_tiles || d_active_tiles[t_idx] != 2) return;

    int tx = t_idx % ntx;
    int ty = (t_idx / ntx) % nty;
    int tz = t_idx / (ntx * nty);
    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;
    int gx = tx * TILE_SIZE_3D + lx;
    int gy = ty * TILE_SIZE_3D + ly;
    int gz = tz * TILE_SIZE_3D + lz;

    if (gx < nx && gy < ny && gz < nz) {
        RealType q_add_rho = Q_erode[t_idx].rho[c_idx];
        RealType d_vf = fluid_frac ? fluid_frac[t_idx].alpha_tmp[c_idx] : (RealType)0.0;
        if (q_add_rho > (RealType)0.0 || d_vf > (RealType)0.0) {
            RealType a_old = fluid_frac ? fluid_frac[t_idx].alpha_f[c_idx]
                                        : ((!d_geom || !d_geom[t_idx].cells[c_idx].is_boundary) ? (RealType)1.0 : (RealType)0.0);
            RealType a_new = fluid_frac ? fmin((RealType)1.0, a_old + d_vf) : (RealType)1.0;
            if (fluid_frac && q_add_rho > (RealType)0.0 && a_new <= (RealType)FSI_ALPHA_DEAD) {
                a_new = (RealType)(1.5f * FSI_ALPHA_DEAD);
            }
            RealType q_old_rho  = (a_old > (RealType)0.0) ? a_old * d_U[t_idx].rho[c_idx] : (RealType)0.0;
            RealType q_old_rx   = (a_old > (RealType)0.0) ? a_old * d_U[t_idx].rhoux[c_idx] : (RealType)0.0;
            RealType q_old_ry   = (a_old > (RealType)0.0) ? a_old * d_U[t_idx].rhouy[c_idx] : (RealType)0.0;
            RealType q_old_rz   = (a_old > (RealType)0.0) ? a_old * d_U[t_idx].rhouz[c_idx] : (RealType)0.0;
            RealType q_old_E    = (a_old > (RealType)0.0) ? a_old * d_U[t_idx].E[c_idx] : (RealType)0.0;

            RealType inv_a = (RealType)1.0 / fmax((RealType)1.0e-12, a_new);
            d_U[t_idx].rho[c_idx]   = (q_old_rho + q_add_rho) * inv_a;
            d_U[t_idx].rhoux[c_idx] = (q_old_rx  + Q_erode[t_idx].rhoux[c_idx]) * inv_a;
            d_U[t_idx].rhouy[c_idx] = (q_old_ry  + Q_erode[t_idx].rhouy[c_idx]) * inv_a;
            d_U[t_idx].rhouz[c_idx] = (q_old_rz  + Q_erode[t_idx].rhouz[c_idx]) * inv_a;
            d_U[t_idx].E[c_idx]     = (q_old_E   + Q_erode[t_idx].E[c_idx]) * inv_a;

            if constexpr (IsMultiMaterial) {
                RealType q_old_ar1 = (a_old > (RealType)0.0) ? a_old * d_U[t_idx].arho1[c_idx] : (RealType)0.0;
                RealType q_old_ar2 = (a_old > (RealType)0.0) ? a_old * d_U[t_idx].arho2[c_idx] : (RealType)0.0;
                RealType v_old_a1  = (a_old > (RealType)0.0) ? a_old * d_U[t_idx].alpha1[c_idx] : (RealType)0.0;
                RealType v_old_a2  = (a_old > (RealType)0.0) ? a_old * d_U[t_idx].alpha2[c_idx] : (RealType)0.0;
                RealType d_jwl_v   = Q_erode[t_idx].alpha1[c_idx];
                RealType v_tot     = fmax((RealType)1.0e-12, a_old + fmax(d_vf, d_jwl_v));
                d_U[t_idx].arho1[c_idx]  = (q_old_ar1 + Q_erode[t_idx].arho1[c_idx]) * inv_a;
                d_U[t_idx].arho2[c_idx]  = (q_old_ar2 + Q_erode[t_idx].arho2[c_idx]) * inv_a;
                RealType a1_n = fmin((RealType)1.0, (v_old_a1 + d_jwl_v) / v_tot);
                RealType a2_n = fmin((RealType)(1.0 - a1_n), v_old_a2 / v_tot);
                d_U[t_idx].alpha1[c_idx] = a1_n;
                d_U[t_idx].alpha2[c_idx] = a2_n;
                Q_erode[t_idx].alpha1[c_idx] = (RealType)0.0;
                Q_erode[t_idx].alpha2[c_idx] = (RealType)0.0;
                Q_erode[t_idx].arho1[c_idx]  = (RealType)0.0;
                Q_erode[t_idx].arho2[c_idx]  = (RealType)0.0;
            }
            Q_erode[t_idx].rho[c_idx]   = (RealType)0.0;
            Q_erode[t_idx].rhoux[c_idx] = (RealType)0.0;
            Q_erode[t_idx].rhouy[c_idx] = (RealType)0.0;
            Q_erode[t_idx].rhouz[c_idx] = (RealType)0.0;
            Q_erode[t_idx].E[c_idx]     = (RealType)0.0;

            if (fluid_frac) {
                fluid_frac[t_idx].alpha_f[c_idx]      = a_new;
                fluid_frac[t_idx].alpha_f_prev[c_idx] = a_new;
                fluid_frac[t_idx].alpha_tmp[c_idx]    = (RealType)0.0;
            }
            if (d_geom) {
                float a_s = fluid_frac ? static_cast<float>(fmax((RealType)0.0, (RealType)1.0 - a_new)) : 0.0f;
                d_geom[t_idx].cells[c_idx] = pack_geometry_payload(a_new <= (RealType)0.0, 0.0f, 0.0f, 0.0f, a_s);
            }
            convert_conservative_to_primitive_gpu<RealType, IsMultiMaterial, PrimitiveTile3D<RealType, IsMultiMaterial>>(
                d_U, d_states, d_geom, t_idx, c_idx, (RealType)0.0, d_solid_vel
            );
        }
    }
    __syncthreads();
    if (c_idx == 0) {
        d_active_tiles[t_idx] = 1;
    }
}

template <typename RealType, bool IsMultiMaterial>
int CFDSolver3DCuda<RealType, IsMultiMaterial>::erodeMPMParticlesToCFDGPU(void* mpm_solver_void) {
    ensure_paged_in();
    bind_constants();
    if (!mpm_solver_void) return 0;
    Blast::MPMSolver3DCUDA* mpm_solver = static_cast<Blast::MPMSolver3DCUDA*>(mpm_solver_void);
    size_t num_particles = mpm_solver->getParticleCount();
    if (num_particles == 0) return 0;

    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    size_t q_tmp_bytes = total_tiles * sizeof(ConservativeTile3D<RealType, IsMultiMaterial>);
    if (!d_fsi_Q_tmp || d_fsi_Q_tmp_capacity < q_tmp_bytes) {
        if (d_fsi_Q_tmp) cudaFree(d_fsi_Q_tmp);
        CHECK_CUDA(cudaMalloc(&d_fsi_Q_tmp, q_tmp_bytes));
        d_fsi_Q_tmp_capacity = q_tmp_bytes;
    }
    CHECK_CUDA(cudaMemsetAsync(d_fsi_Q_tmp, 0, q_tmp_bytes));
    CHECK_CUDA(cudaMemsetAsync(d_active_count, 0, sizeof(int)));

    int threads = 256;
    int blocks = (static_cast<int>(num_particles) + threads - 1) / threads;

    kernel_erode_mpm_particles_to_cfd_gpu<RealType, IsMultiMaterial><<<blocks, threads>>>(
        d_fsi_Q_tmp,
        d_fluid_frac_fsi,
        (const GeometryTile3D*)d_geom,
        (uint8_t*)d_active_tiles,
        mpm_solver->getDeviceParticlesSoA(),
        static_cast<int>(num_particles),
        mpm_solver->getDeviceMaterialTables(),
        mpm_solver->getDeviceGrid(),
        mpm_solver->getNx(), mpm_solver->getNy(), mpm_solver->getNz(),
        mpm_solver->getDeviceGridView(),
        nx, ny, nz,
        ntx, nty,
        static_cast<float>(cellSize), static_cast<float>(cellSize), static_cast<float>(cellSize),
        static_cast<float>(xmin), static_cast<float>(ymin), static_cast<float>(zmin),
        mpm_solver->getDeviceBoundaryFlags(),
        (int*)d_active_count,
        mpm_solver->getDx(), mpm_solver->getDy(), mpm_solver->getDz(),
        static_cast<int>(mpm_solver->getTransferScheme()),
        static_cast<int>(mpm_solver->getVelocityScheme())
    );
    CHECK_CUDA(cudaGetLastError());

    int h_eroded_count = 0;
    CHECK_CUDA(cudaMemcpy(&h_eroded_count, d_active_count, sizeof(int), cudaMemcpyDeviceToHost));

    if (h_eroded_count > 0) {
        dim3 tile_threads(TILE_SIZE_3D, TILE_SIZE_3D, TILE_SIZE_3D);
        kernel_sync_eroded_cfd_tiles_gpu<RealType, IsMultiMaterial><<<total_tiles, tile_threads>>>(
            (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
            (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
            d_fsi_Q_tmp,
            d_fluid_frac_fsi,
            (uint8_t*)d_active_tiles,
            (GeometryTile3D*)d_geom,
            (const SolidVelocityTile3D*)d_solid_vel_fsi,
            nx, ny, nz, ntx, nty
        );
        CHECK_CUDA(cudaGetLastError());

        if (d_fluid_frac_fsi && d_tile_has_boundary_buf && d_tile_is_near_boundary) {
            int threads_tile = 256;
            int blocks_tile = (total_tiles + threads_tile - 1) / threads_tile;
            kernel_mark_tile_has_boundary_fsi_3d<RealType><<<blocks_tile, threads_tile>>>(
                (const GeometryTile3D*)d_geom,
                d_fluid_frac_fsi,
                (uint8_t*)d_tile_has_boundary_buf,
                total_tiles
            );
            kernel_update_fsi_tile_boundary_flags<<<blocks_tile, threads_tile>>>(
                (const uint8_t*)d_tile_has_boundary_buf,
                (uint8_t*)d_tile_is_near_boundary,
                ntx, nty, ntz
            );
            CHECK_CUDA(cudaGetLastError());
        }

        updateActiveRegions();
        mpm_solver->compactTerminatedParticlesDevice();
        last_cached_tile_idx = -1;
    }

    return h_eroded_count;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::coupleZonalHandoffWithMPMGPU(void* mpm_solver_void) {
    ensure_paged_in();
    if (!mpm_solver_void || !m_zonal_handoff_params.enabled) return;
    Blast::MPMSolver3DCUDA* mpm_solver = static_cast<Blast::MPMSolver3DCUDA*>(mpm_solver_void);
    Blast::MPMGridNode3D* d_grid = mpm_solver->getDeviceGrid();
    int* d_active_nodes = mpm_solver->getDeviceActiveNodes();
    int num_active_nodes = mpm_solver->getNumActiveNodes();
    if (!d_grid || !d_active_nodes || num_active_nodes <= 0) return;
    Blast::MPMGridView3D gv = mpm_solver->getDeviceGridView();

    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;

    // (1) FV -> MPM: exterior FV pressure applied as ghost traction on the sleeve boundary nodes.
    //     Sampled before the MPM -> FV blend so it reflects the FV-owned solution only.
    if (mpm_solver->getNx() == nx && mpm_solver->getNy() == ny && mpm_solver->getNz() == nz) {
        float* d_ghost_p = mpm_solver->getZonalGhostPressureBuffer();
        int n_cells = nx * ny * nz;
        int threads_g = 256;
        int blocks_g = (n_cells + threads_g - 1) / threads_g;
        kernel_zonal_fill_ghost_pressure_gpu<RealType, IsMultiMaterial><<<blocks_g, threads_g>>>(
            (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states, d_grid, d_ghost_p,
            nx, ny, nz, ntx, nty,
            static_cast<float>(cellSize), static_cast<float>(xmin), static_cast<float>(ymin), static_cast<float>(zmin),
            gv);
        CHECK_CUDA(cudaGetLastError());
        mpm_solver->applyZonalGhostPressureTraction();
    } else {
        throw std::runtime_error("[CFDSolver3DCuda] Zonal coupling requires co-located MPM and FV grids (dimension mismatch).");
    }

    // (2) MPM -> FV: mirror / blend MPM grid state into FV cells inside the sleeve
    int threads = 256;
    int blocks = (num_active_nodes + threads - 1) / threads;

    kernel_zonal_handoff_active_gpu<RealType, IsMultiMaterial><<<blocks, threads>>>(
        (PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
        (ConservativeTile3D<RealType, IsMultiMaterial>*)d_U,
        d_grid,
        d_active_nodes,
        num_active_nodes,
        nx, ny, nz,
        ntx, nty,
        static_cast<float>(cellSize), static_cast<float>(cellSize), static_cast<float>(cellSize),
        static_cast<float>(xmin), static_cast<float>(ymin), static_cast<float>(zmin),
        static_cast<float>(gamma),
        gv
    );
    CHECK_CUDA(cudaGetLastError());
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::setZonalHandoffParams(const Blast::ZonalHandoff3DParams& params) {
    m_zonal_handoff_params = params;
    CHECK_CUDA(cudaMemcpyToSymbol(d_zonalParams, &params, sizeof(Blast::ZonalHandoff3DParams)));
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::synchronizeFluidSleeveWithMPMGPU(void* mpm_solver_void) {
    ensure_paged_in();
    if (!mpm_solver_void || !m_zonal_handoff_params.enabled) return;
    Blast::MPMSolver3DCUDA* mpm_solver = static_cast<Blast::MPMSolver3DCUDA*>(mpm_solver_void);
    size_t num_particles = mpm_solver->getParticleCount();
    if (num_particles == 0) return;

    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;

    int threads = 256;
    int blocks = (static_cast<int>(num_particles) + threads - 1) / threads;

    kernel_synchronize_fluid_sleeve_particles_gpu<RealType, IsMultiMaterial><<<blocks, threads>>>(
        (const PrimitiveTile3D<RealType, IsMultiMaterial>*)d_states,
        mpm_solver->getDeviceParticlesSoA(),
        static_cast<int>(num_particles),
        mpm_solver->getDeviceMaterialTables(),
        nx, ny, nz,
        ntx, nty,
        static_cast<float>(cellSize), static_cast<float>(cellSize), static_cast<float>(cellSize),
        static_cast<float>(xmin), static_cast<float>(ymin), static_cast<float>(zmin)
    );
    CHECK_CUDA(cudaGetLastError());
    last_cached_tile_idx = -1;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DCuda<RealType, IsMultiMaterial>::coupleFSIWithFEMGPU(void* fem_solver_void) {
    ensure_paged_in();
    bind_constants();
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
        Blast::MPMGridView3D gv_debris = mpm_cuda->getDeviceGridView();
        if (d_grid && num_active_nodes > 0 && d_active_nodes) {
            int threads_active = 256;
            int blocks_active = (num_active_nodes + threads_active - 1) / threads_active;

            kernel_zero_fsi_grid_ext_forces<<<blocks_active, threads_active>>>(d_grid, d_active_nodes, num_active_nodes, gv_debris);
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
                mpm_cuda->getXMin(), mpm_cuda->getYMin(), mpm_cuda->getZMin(),
                gv_debris
            );
            CHECK_CUDA(cudaGetLastError());
            if (mpm_cuda->getTimeScheme() == Blast::MPMTimeIntegrationScheme::RK2) {
                mpm_cuda->storeFSIForces();
            }
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
