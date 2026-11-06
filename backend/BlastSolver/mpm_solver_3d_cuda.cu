#include "mpm_solver_3d_cuda.hpp"
#include "constitutive_concrete_models.hpp"
#include "constitutive_crest_davis.hpp"
#include "constitutive_jwl.hpp"
#include "constitutive_lee_tarver.hpp"
#include "materials/ConstitutiveSolids.hpp"
#include "materials/ConstitutiveGeomaterials.hpp"
#include <cuda_runtime.h>
#include <device_launch_parameters.h>
#include <algorithm>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>

#ifndef CUDA_CHECK_ALLOC
#define CUDA_CHECK_ALLOC(call, msg) do { \
    cudaError_t err = (call); \
    if (err != cudaSuccess) { \
        std::string err_str = std::string("[CUDA ALLOC FAILED] ") + (msg) + ": " + cudaGetErrorString(err); \
        std::cerr << err_str << std::endl; \
        throw std::runtime_error(err_str); \
    } \
} while (0)
#endif

namespace Blast {

__constant__ float d_current_sim_time;

__device__ inline float computeWeibullFactor_dev(float x, float y, float z, float V0, float weibull_modulus, float weibull_scale, float weibull_ref_volume = 1.0e-6f) {
    if (weibull_modulus <= 0.001f) return 1.0f;
    uint32_t ix = __float_as_uint(x);
    uint32_t iy = __float_as_uint(y);
    uint32_t iz = __float_as_uint(z);
    uint32_t seed = (ix * 73856093u) ^ (iy * 19349663u) ^ (iz * 83492791u);
    seed = (seed ^ 61u) ^ (seed >> 16);
    seed *= 9u;
    seed = seed ^ (seed >> 4);
    seed *= 0x27d4eb2du;
    seed = seed ^ (seed >> 15);
    float u = fminf(fmaxf(static_cast<float>(seed & 0xFFFFu) / 65535.0f, 0.001f), 0.999f);
    float m_w = weibull_modulus;
    float eta_w = (weibull_scale > 0.001f) ? weibull_scale : 1.0f;
    float gamma_mean = tgammaf(1.0f + 1.0f / m_w);

    // Physically-consistent Weibull volume scaling: (V_ref / V0)^(1 / m_w)
    float v_ref = (weibull_ref_volume > 1.0e-18f) ? weibull_ref_volume : 1.0e-6f;
    float v_eff = (V0 > 1.0e-18f) ? V0 : v_ref;
    float size_scale = powf(v_ref / v_eff, 1.0f / m_w);

    float w = (powf(-logf(1.0f - u), 1.0f / m_w) / gamma_mean) * eta_w * size_scale;
    return fminf(fmaxf(w, 0.10f), 3.00f);
}

// CUDA Device Helper Functions
__device__ inline float evalLinear_S_dev(float x_p, float x_i, float h) {
    float r = fabsf(x_p - x_i);
    if (r >= h) return 0.0f;
    return 1.0f - (r / h);
}

__device__ inline float evalLinear_dS_dev(float x_p, float x_i, float h) {
    float diff = x_p - x_i;
    float r = fabsf(diff);
    if (r >= h || r < 1.0e-12f) return 0.0f;
    return (diff > 0.0f) ? (-1.0f / h) : (1.0f / h);
}

__device__ inline float evalGIMP_S_dev(float x_p, float x_i, float h, float l_p) {
    float r = fabsf(x_p - x_i);
    if (r >= h + l_p) return 0.0f;
    if (r < l_p) {
        return 1.0f - (r * r + l_p * l_p) / (2.0f * h * l_p);
    } else if (r <= h - l_p) {
        return 1.0f - (r / h);
    } else {
        float term = h + l_p - r;
        return (term * term) / (4.0f * h * l_p);
    }
}

__device__ inline float evalGIMP_dS_dev(float x_p, float x_i, float h, float l_p) {
    float diff = x_p - x_i;
    float r = fabsf(diff);
    if (r >= h + l_p) return 0.0f;
    float sign = (diff > 0.0f) ? 1.0f : ((diff < 0.0f) ? -1.0f : 0.0f);
    if (r < l_p) {
        return -sign * r / (h * l_p);
    } else if (r <= h - l_p) {
        return -sign / h;
    } else {
        float term = h + l_p - r;
        return -sign * term / (2.0f * h * l_p);
    }
}

__device__ inline float evalBSpline_S_dev(float x_p, float x_i, float h) {
    float q = fabsf(x_p - x_i) / h;
    if (q < 0.5f) {
        return 0.75f - q * q;
    } else if (q < 1.5f) {
        return 0.5f * (1.5f - q) * (1.5f - q);
    }
    return 0.0f;
}

__device__ inline float evalBSpline_dS_dev(float x_p, float x_i, float h) {
    float diff = x_p - x_i;
    float q = fabsf(diff) / h;
    float sign = (diff > 0.0f) ? 1.0f : ((diff < 0.0f) ? -1.0f : 0.0f);
    if (q < 0.5f) {
        return -2.0f * diff / (h * h);
    } else if (q < 1.5f) {
        return -sign * (1.5f - q) / h;
    }
    return 0.0f;
}

__device__ inline float evalCubicBSpline_S_dev(float x_p, float x_i, float h) {
    float q = fabsf(x_p - x_i) / h;
    if (q < 1.0f) {
        return (2.0f / 3.0f) - q * q + 0.5f * q * q * q;
    } else if (q < 2.0f) {
        float term = 2.0f - q;
        return (1.0f / 6.0f) * term * term * term;
    }
    return 0.0f;
}

__device__ inline float evalCubicBSpline_dS_dev(float x_p, float x_i, float h) {
    float diff = x_p - x_i;
    float q = fabsf(diff) / h;
    float sign = (diff > 0.0f) ? 1.0f : ((diff < 0.0f) ? -1.0f : 0.0f);
    if (q < 1.0f) {
        return (-2.0f * q + 1.5f * q * q) * sign / h;
    } else if (q < 2.0f) {
        float term = 2.0f - q;
        return -3.0f * term * term * sign / (6.0f * h);
    }
    return 0.0f;
}

__device__ inline float evalWendland_C2_dev(float r, float R_supp) {
    if (r >= R_supp) return 0.0f;
    float q = r / R_supp;
    float term = 1.0f - q;
    return (term * term * term * term) * (1.0f + 4.0f * q);
}

// Cell-centered grid ghost node resolution for Method of Images (Symmetry / Reflecting / FreeSlip / Sticky)
__device__ __forceinline__ bool resolve_ghost_node_3d(
    int& i, float& sign_v,
    int nx, int bc_min, int bc_max)
{
    sign_v = 1.0f;
    if (i < 0) {
        if (bc_min == 1 || bc_min == 2 || bc_min == 0) { // FreeSlip (1), Reflecting (2), Sticky (0)
            i = -1 - i;
            sign_v = -1.0f;
            return (i >= 0 && i < nx);
        }
        return false; // Outflow / Terminate / Lysmer
    } else if (i >= nx) {
        if (bc_max == 1 || bc_max == 2 || bc_max == 0) { // FreeSlip (1), Reflecting (2), Sticky (0)
            i = 2 * nx - 1 - i;
            sign_v = -1.0f;
            return (i >= 0 && i < nx);
        }
        return false;
    }
    return true;
}

// Direct 6-component Voigt stress memory accessors (xx, yy, zz, xy, yz, zx)
__device__ __forceinline__ void load_particle_stress_matrix(const MPMParticle3DSoA& soa, int p_idx, float sigma[3][3]) {
    float s0 = soa.sigma_voigt[0][p_idx]; // xx
    float s1 = soa.sigma_voigt[1][p_idx]; // yy
    float s2 = soa.sigma_voigt[2][p_idx]; // zz
    float s3 = soa.sigma_voigt[3][p_idx]; // xy
    float s4 = soa.sigma_voigt[4][p_idx]; // yz
    float s5 = soa.sigma_voigt[5][p_idx]; // zx
    sigma[0][0] = s0; sigma[0][1] = s3; sigma[0][2] = s5;
    sigma[1][0] = s3; sigma[1][1] = s1; sigma[1][2] = s4;
    sigma[2][0] = s5; sigma[2][1] = s4; sigma[2][2] = s2;
}

__device__ __forceinline__ void store_particle_stress_matrix(MPMParticle3DSoA& soa, int p_idx, const float sigma[3][3]) {
    soa.sigma_voigt[0][p_idx] = sigma[0][0];
    soa.sigma_voigt[1][p_idx] = sigma[1][1];
    soa.sigma_voigt[2][p_idx] = sigma[2][2];
    soa.sigma_voigt[3][p_idx] = 0.5f * (sigma[0][1] + sigma[1][0]);
    soa.sigma_voigt[4][p_idx] = 0.5f * (sigma[1][2] + sigma[2][1]);
    soa.sigma_voigt[5][p_idx] = 0.5f * (sigma[2][0] + sigma[0][2]);
}

__device__ __forceinline__ void store_particle_stress_isotropic(MPMParticle3DSoA& soa, int p_idx, float p_hydro) {
    soa.sigma_voigt[0][p_idx] = -p_hydro;
    soa.sigma_voigt[1][p_idx] = -p_hydro;
    soa.sigma_voigt[2][p_idx] = -p_hydro;
    soa.sigma_voigt[3][p_idx] = 0.0f;
    soa.sigma_voigt[4][p_idx] = 0.0f;
    soa.sigma_voigt[5][p_idx] = 0.0f;
}

// Clear previously active grid nodes kernel
__global__ void kernel_clear_active_nodes_3d(MPMGridNode3D* grid, const int* active_nodes, int num_active) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_active) return;
    int node_idx = active_nodes[idx];
    MPMGridNode3D& node = grid[node_idx];
    node.m = 0.0f;
    node.p[0] = 0.0f; node.p[1] = 0.0f; node.p[2] = 0.0f;
    node.f_ext[0] = 0.0f; node.f_ext[1] = 0.0f; node.f_ext[2] = 0.0f;
    node.f_int[0] = 0.0f; node.f_int[1] = 0.0f; node.f_int[2] = 0.0f;
    node.plastic_strain = 0.0f;
    node.pressure = 0.0f;
    node.m_solid = 0.0f;
    node.m_energetic = 0.0f;
    node.m_reacted = 0.0f;
    node.v_energetic = 0.0f;
    node.v_reacted = 0.0f;
    node.temperature = 0.0f;
    node.dT_cond = 0.0f;
    node.t_star = 0.0f;
    node.q_fric = 0.0f;
}

// Sparse multi-material active node clearing kernel (Bardenhagen contact)
__global__ void kernel_clear_active_mat_nodes_3d(
    float* d_mat_m, float* d_mat_p, float* d_mat_f,
    float* d_mat_dv,
    const int* active_nodes, int num_active,
    size_t num_nodes, int num_materials)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_active) return;
    int node_idx = active_nodes[idx];

    for (int m = 0; m < num_materials; ++m) {
        size_t mn_idx = static_cast<size_t>(m) * num_nodes + node_idx;
        d_mat_m[mn_idx] = 0.0f;
        d_mat_p[mn_idx * 3 + 0] = 0.0f;
        d_mat_p[mn_idx * 3 + 1] = 0.0f;
        d_mat_p[mn_idx * 3 + 2] = 0.0f;
        d_mat_f[mn_idx * 3 + 0] = 0.0f;
        d_mat_f[mn_idx * 3 + 1] = 0.0f;
        d_mat_f[mn_idx * 3 + 2] = 0.0f;
        if (d_mat_dv) {
            d_mat_dv[mn_idx * 3 + 0] = 0.0f;
            d_mat_dv[mn_idx * 3 + 1] = 0.0f;
            d_mat_dv[mn_idx * 3 + 2] = 0.0f;
        }
    }
}

// ---------------------------------------------------------------------------
// Compact multi-material (Bardenhagen) storage
// ---------------------------------------------------------------------------
// Dense layout: every material owns a full-grid field, row = mat * N + node.
// Compact layout: one int tag per node.
//   tag == MPM_MAT_TAG_EMPTY (-1): node untouched this step
//   tag == MPM_MAT_TAG_MULTI (-2): >= 2 materials, slot not yet assigned (transient)
//   0 <= tag < M               : exactly one material contributes; its fields are
//                                 identical to the global node (m, p, f_int), so no
//                                 separate storage is required
//   tag >= M                   : multi-material node, slot s = tag - M, row = s * M + mat
// Only true contact-interface nodes consume material-field memory.
constexpr int MPM_MAT_TAG_EMPTY = -1;
constexpr int MPM_MAT_TAG_MULTI = -2;
constexpr int MPM_P2G_SCATTER = 0;
constexpr int MPM_P2G_TAG = 1;

// Stencil weight thresholds for compact multi-material P2G:
// SCATTER ignores contributions below 1.0e-7f.
// TAG uses a conservative inclusion threshold (1.0e-8f) so that any particle contribution
// that could pass the scatter threshold (despite minor compiler FMA/rounding differences)
// is guaranteed to have its node tagged and material storage allocated.
constexpr float MPM_P2G_SCATTER_CUTOFF = 1.0e-7f;
constexpr float MPM_P2G_TAG_CUTOFF = 1.0e-8f;

// Records that material `mat` touches `node_idx`. Returns true exactly once per node
// (first touch), which is used to build the active-node list without duplicates.
__device__ __forceinline__ bool mpm_tag_node_material(int* d_mat_tag, size_t node_idx, int mat) {
    int old = atomicCAS(&d_mat_tag[node_idx], MPM_MAT_TAG_EMPTY, mat);
    if (old == MPM_MAT_TAG_EMPTY) return true;
    if (old != mat && old != MPM_MAT_TAG_MULTI) {
        atomicExch(&d_mat_tag[node_idx], MPM_MAT_TAG_MULTI);
    }
    return false;
}

// Row of (mat, node) in the material field buffers, or -1 when the material has no
// separate storage at this node (compact single-material node or absent material).
__device__ __forceinline__ long long mpm_mat_row(const int* d_mat_tag, int num_materials,
                                                 size_t num_nodes, int mat, size_t node_idx) {
    if (!d_mat_tag) return static_cast<long long>(static_cast<size_t>(mat) * num_nodes + node_idx);
    int t = d_mat_tag[node_idx];
    if (t >= num_materials) {
        return static_cast<long long>(t - num_materials) * num_materials + mat;
    }
    return -1;
}

// Mass of material `mat` at `node_idx` for either layout.
__device__ __forceinline__ float mpm_mat_mass_at(const MPMGridNode3D* grid, const int* d_mat_tag,
                                                 const float* d_mat_m, int num_materials,
                                                 size_t num_nodes, int mat, size_t node_idx) {
    if (!d_mat_tag) return d_mat_m[static_cast<size_t>(mat) * num_nodes + node_idx];
    int t = d_mat_tag[node_idx];
    if (t == mat) return grid[node_idx].m;
    if (t >= num_materials) return d_mat_m[static_cast<size_t>(t - num_materials) * num_materials + mat];
    return 0.0f;
}

// Post-update kinematics of material `mat` at `node_idx` for either layout.
// Returns the material mass; v / dv are only written when mass > 1e-20.
// Compact single-material nodes store v = p / m in the global node and the
// velocity increment dv in node.f_int (written by the Bardenhagen grid update).
__device__ __forceinline__ float mpm_mat_node_kinematics(
    const MPMGridNode3D* grid, const int* d_mat_tag,
    const float* d_mat_m, const float* d_mat_v, const float* d_mat_dv,
    int num_materials, size_t num_nodes, int mat, size_t node_idx,
    float v_prev_x, float v_prev_y, float v_prev_z,
    float& vx, float& vy, float& vz, float& dvx, float& dvy, float& dvz)
{
    size_t mn_idx;
    if (d_mat_tag) {
        int t = d_mat_tag[node_idx];
        if (t == mat) {
            const MPMGridNode3D& g = grid[node_idx];
            if (g.m > 1.0e-20f) {
                float inv_m = 1.0f / g.m;
                vx = g.p[0] * inv_m; vy = g.p[1] * inv_m; vz = g.p[2] * inv_m;
                dvx = g.f_int[0]; dvy = g.f_int[1]; dvz = g.f_int[2];
            }
            return g.m;
        }
        if (t < num_materials) return 0.0f;
        mn_idx = static_cast<size_t>(t - num_materials) * num_materials + mat;
    } else {
        mn_idx = static_cast<size_t>(mat) * num_nodes + node_idx;
    }
    float m = d_mat_m[mn_idx];
    if (m > 1.0e-20f) {
        vx = d_mat_v[mn_idx * 3 + 0];
        vy = d_mat_v[mn_idx * 3 + 1];
        vz = d_mat_v[mn_idx * 3 + 2];
        dvx = d_mat_dv ? d_mat_dv[mn_idx * 3 + 0] : (vx - v_prev_x);
        dvy = d_mat_dv ? d_mat_dv[mn_idx * 3 + 1] : (vy - v_prev_y);
        dvz = d_mat_dv ? d_mat_dv[mn_idx * 3 + 2] : (vz - v_prev_z);
    }
    return m;
}

// Assigns a compact slot to every multi-material node in the active list.
// counters[0] = slots handed out; on overflow the tag stays MULTI and the host regrows.
__global__ void kernel_assign_mat_slots_3d(int* d_mat_tag, const int* active_nodes, int num_active,
                                           int num_materials, int* counters, int slot_capacity) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_active) return;
    int node_idx = active_nodes[idx];
    int t = d_mat_tag[node_idx];
    if (t == MPM_MAT_TAG_MULTI || t >= num_materials) {
        int s = atomicAdd(&counters[0], 1);
        d_mat_tag[node_idx] = (s < slot_capacity) ? (num_materials + s) : MPM_MAT_TAG_MULTI;
    }
}

// Resets tags of previously active nodes to EMPTY.
__global__ void kernel_reset_mat_tags_3d(int* d_mat_tag, const int* active_nodes, int num_active) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_active) return;
    d_mat_tag[active_nodes[idx]] = MPM_MAT_TAG_EMPTY;
}

// SoA Pack/Unpack Kernels
__global__ void kernel_pack_aos_to_soa(const MPMParticle3D* aos, MPMParticle3DSoA soa, int chunk_size, int offset = 0) {
    int local_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (local_idx >= chunk_size) return;
    int idx = offset + local_idx;
    const MPMParticle3D& p = aos[local_idx];

    soa.x[0][idx] = p.x[0]; soa.x[1][idx] = p.x[1]; soa.x[2][idx] = p.x[2];
    soa.v[0][idx] = p.v[0]; soa.v[1][idx] = p.v[1]; soa.v[2][idx] = p.v[2];

    if (soa.sigma_voigt[0]) {
        #pragma unroll
        for (int k = 0; k < 6; ++k) {
            soa.sigma_voigt[k][idx] = p.sigma.data[k];
        }
    } else {
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                soa.sigma[r][c][idx] = p.sigma[r][c];
            }
        }
    }

    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            soa.B[r][c][idx] = p.B[r][c];
            if (soa.L_grad[r][c] && soa.L_grad[r][c] != soa.B[r][c]) {
                soa.L_grad[r][c][idx] = p.L_grad[r][c];
            }
        }
    }

    soa.lp[0][idx] = p.lp[0];
    soa.m[idx] = p.m;
    soa.V0[idx] = p.V0;
    soa.V[idx] = p.V;
    soa.e_int[idx] = p.e_int;
    soa.temperature[idx] = p.temperature;
    soa.ep_bar[idx] = p.ep_bar;
    soa.damage[idx] = p.damage;
    if (soa.lambda) soa.lambda[idx] = p.lambda;
    if (soa.t_arrival) soa.t_arrival[idx] = p.t_arrival;
    if (soa.v_min) soa.v_min[idx] = p.v_min;
    if (soa.s_shock) soa.s_shock[idx] = p.s_shock;
    if (soa.weibull_factor) soa.weibull_factor[idx] = p.weibull_factor;
    if (soa.contact_radius) soa.contact_radius[idx] = p.contact_radius;
    soa.has_failed[idx] = p.has_failed ? 1 : 0;
    soa.object_id[idx] = p.object_id;
    if (soa.state) soa.state[idx] = static_cast<int>(p.state);
    if (soa.cluster_id) soa.cluster_id[idx] = p.cluster_id;
    if (soa.material_id) soa.material_id[idx] = p.material_id;
}

__global__ void kernel_unpack_soa_to_aos(MPMParticle3D* aos, MPMParticle3DSoA soa, int chunk_size, int offset = 0) {
    int local_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (local_idx >= chunk_size) return;
    int idx = offset + local_idx;
    MPMParticle3D& p = aos[local_idx];

    p.x[0] = soa.x[0][idx]; p.x[1] = soa.x[1][idx]; p.x[2] = soa.x[2][idx];
    p.v[0] = soa.v[0][idx]; p.v[1] = soa.v[1][idx]; p.v[2] = soa.v[2][idx];

    if (soa.sigma_voigt[0]) {
        #pragma unroll
        for (int k = 0; k < 6; ++k) {
            p.sigma.data[k] = soa.sigma_voigt[k][idx];
        }
    } else {
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                p.sigma[r][c] = soa.sigma[r][c][idx];
            }
        }
    }

    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            p.B[r][c] = soa.B[r][c][idx];
            p.L_grad[r][c] = (soa.L_grad[r][c] && soa.L_grad[r][c] != soa.B[r][c]) ? soa.L_grad[r][c][idx] : soa.B[r][c][idx];
        }
    }

    p.lp[0] = soa.lp[0][idx]; p.lp[1] = soa.lp[0][idx]; p.lp[2] = soa.lp[0][idx];
    p.m = soa.m[idx];
    p.V0 = soa.V0[idx];
    p.V = soa.V[idx];
    p.J = (p.V0 > 1.0e-20f) ? (p.V / p.V0) : 1.0f;
    p.e_int = soa.e_int[idx];
    p.temperature = soa.temperature[idx];
    p.ep_bar = soa.ep_bar[idx];
    p.damage = soa.damage[idx];
    if (soa.lambda) p.lambda = soa.lambda[idx];
    if (soa.t_arrival) p.t_arrival = soa.t_arrival[idx];
    if (soa.v_min) p.v_min = soa.v_min[idx];
    if (soa.s_shock) p.s_shock = soa.s_shock[idx];
    if (soa.weibull_factor) p.weibull_factor = soa.weibull_factor[idx];
    if (soa.contact_radius) p.contact_radius = soa.contact_radius[idx];
    p.has_failed = (soa.has_failed[idx] != 0);
    p.object_id = soa.object_id[idx];
    if (soa.state) p.state = static_cast<uint8_t>(soa.state[idx]);
    if (soa.cluster_id) p.cluster_id = soa.cluster_id[idx];
    if (soa.material_id) p.material_id = soa.material_id[idx];
}

__host__ __device__ inline int* mpm_cell_slot_ptr(MPMGridNode3D& node, int slot) {
    switch (slot) {
        case 0: return reinterpret_cast<int*>(&node.dT_cond);
        case 1: return reinterpret_cast<int*>(&node.q_fric);
        case 2: return reinterpret_cast<int*>(&node.t_star);
        case 3: return reinterpret_cast<int*>(&node.v_energetic);
        case 4: return reinterpret_cast<int*>(&node.v_reacted);
        case 5: return reinterpret_cast<int*>(&node.f_int[0]);
        case 6: return reinterpret_cast<int*>(&node.f_int[1]);
        default: return reinterpret_cast<int*>(&node.f_int[2]);
    }
}

__host__ __device__ inline int mpm_cell_slot_read(const MPMGridNode3D& node, int slot) {
    switch (slot) {
        case 0: return *reinterpret_cast<const int*>(&node.dT_cond);
        case 1: return *reinterpret_cast<const int*>(&node.q_fric);
        case 2: return *reinterpret_cast<const int*>(&node.t_star);
        case 3: return *reinterpret_cast<const int*>(&node.v_energetic);
        case 4: return *reinterpret_cast<const int*>(&node.v_reacted);
        case 5: return *reinterpret_cast<const int*>(&node.f_int[0]);
        case 6: return *reinterpret_cast<const int*>(&node.f_int[1]);
        default: return *reinterpret_cast<const int*>(&node.f_int[2]);
    }
}

__global__ void kernel_clear_grid_cell_counts_3d(MPMGridNode3D* grid, int num_nodes, int init_val) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_nodes) return;
    MPMGridNode3D& g = grid[idx];
    if (init_val == 0) {
        g.dT_cond = 0.0f;
        g.q_fric = 0.0f;
        g.t_star = 0.0f;
        g.v_energetic = 0.0f;
        g.v_reacted = 0.0f;
        g.f_int[0] = 0.0f;
        g.f_int[1] = 0.0f;
        g.f_int[2] = 0.0f;
    } else {
        for (int s = 0; s < 8; ++s) {
            *mpm_cell_slot_ptr(g, s) = init_val;
        }
    }
}

__global__ void kernel_count_particles_per_cell_3d(
    MPMParticle3DSoA soa, int num_particles,
    MPMGridNode3D* grid, int nx, int ny, int nz,
    float inv_dx, float inv_dy, float inv_dz,
    float xmin, float ymin, float zmin)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_particles) return;

    int cx = static_cast<int>(floorf((soa.x[0][idx] - xmin) * inv_dx));
    int cy = static_cast<int>(floorf((soa.x[1][idx] - ymin) * inv_dy));
    int cz = static_cast<int>(floorf((soa.x[2][idx] - zmin) * inv_dz));
    cx = cx < 0 ? 0 : (cx >= nx ? nx - 1 : cx);
    cy = cy < 0 ? 0 : (cy >= ny ? ny - 1 : cy);
    cz = cz < 0 ? 0 : (cz >= nz ? nz - 1 : cz);

    size_t c_idx = (static_cast<size_t>(cx) * ny + cy) * nz + cz;
    MPMGridNode3D& cell = grid[c_idx];
    for (int s = 0; s < 8; ++s) {
        int* slot_ptr = mpm_cell_slot_ptr(cell, s);
        if (*slot_ptr == -1) {
            if (atomicCAS(slot_ptr, -1, idx) == -1) {
                break;
            }
        }
    }
}

__global__ void kernel_extract_mpm_vtk_snapshot_3d(
    MPMParticle3DSoA soa, int particle_offset, int chunk_particles,
    float* d_points, float* d_vel,
    float* d_von_mises, float* d_pressure,
    float* d_ep_bar, float* d_damage,
    float* d_temp, uint8_t* d_obj_id, uint8_t* d_mat_id,
    uint8_t* d_particle_density,
    const MPMGridNode3D* grid, int nx, int ny, int nz,
    float inv_dx, float inv_dy, float inv_dz,
    float xmin, float ymin, float zmin,
    bool has_vel, bool has_stress, bool has_strain, bool has_damage, bool has_temp,
    bool has_pressure, bool has_material_id, bool has_object_id, bool has_particle_density)
{
    int local_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (local_idx >= chunk_particles) return;
    int idx = particle_offset + local_idx;

    float px = soa.x[0][idx];
    float py = soa.x[1][idx];
    float pz = soa.x[2][idx];

    if (d_points) {
        d_points[local_idx * 3 + 0] = px;
        d_points[local_idx * 3 + 1] = py;
        d_points[local_idx * 3 + 2] = pz;
    }
    if (has_vel && d_vel) {
        d_vel[local_idx * 3 + 0] = soa.v[0][idx];
        d_vel[local_idx * 3 + 1] = soa.v[1][idx];
        d_vel[local_idx * 3 + 2] = soa.v[2][idx];
    }
    if (has_stress || has_pressure) {
        float s00 = soa.sigma_voigt[0] ? soa.sigma_voigt[0][idx] : soa.sigma[0][0][idx];
        float s11 = soa.sigma_voigt[1] ? soa.sigma_voigt[1][idx] : soa.sigma[1][1][idx];
        float s22 = soa.sigma_voigt[2] ? soa.sigma_voigt[2][idx] : soa.sigma[2][2][idx];
        float mean_s = (s00 + s11 + s22) * (1.0f / 3.0f);
        if (has_stress && d_von_mises) {
            float s01 = soa.sigma_voigt[3] ? soa.sigma_voigt[3][idx] : soa.sigma[0][1][idx];
            float s12 = soa.sigma_voigt[4] ? soa.sigma_voigt[4][idx] : soa.sigma[1][2][idx];
            float s20 = soa.sigma_voigt[5] ? soa.sigma_voigt[5][idx] : soa.sigma[2][0][idx];
            float dev00 = s00 - mean_s;
            float dev11 = s11 - mean_s;
            float dev22 = s22 - mean_s;
            d_von_mises[local_idx] = sqrtf(1.5f * (dev00*dev00 + dev11*dev11 + dev22*dev22 + 2.0f*(s01*s01 + s12*s12 + s20*s20)));
        }
        if (has_pressure && d_pressure) d_pressure[local_idx] = -mean_s;
    }
    if (has_strain && d_ep_bar) d_ep_bar[local_idx] = soa.ep_bar[idx];
    if (has_damage && d_damage) d_damage[local_idx] = soa.damage[idx];
    if (has_temp && d_temp) d_temp[local_idx] = soa.temperature[idx];
    if (has_object_id && d_obj_id) {
        int oid = soa.object_id[idx];
        d_obj_id[local_idx] = static_cast<uint8_t>(oid < 0 ? 0 : (oid > 255 ? 255 : oid));
    }
    if (has_material_id && d_mat_id) {
        int mid = soa.material_id ? soa.material_id[idx] : 0;
        d_mat_id[local_idx] = static_cast<uint8_t>(mid < 0 ? 0 : (mid > 255 ? 255 : mid));
    }
    if (has_particle_density && d_particle_density) {
        if (grid && nx > 0 && ny > 0 && nz > 0) {
            int cx = static_cast<int>(floorf((px - xmin) * inv_dx));
            int cy = static_cast<int>(floorf((py - ymin) * inv_dy));
            int cz = static_cast<int>(floorf((pz - zmin) * inv_dz));
            cx = cx < 0 ? 0 : (cx >= nx ? nx - 1 : cx);
            cy = cy < 0 ? 0 : (cy >= ny ? ny - 1 : cy);
            cz = cz < 0 ? 0 : (cz >= nz ? nz - 1 : cz);

            int ix_lo = (cx > 0) ? (cx - 1) : 0;
            int ix_hi = (cx + 1 < nx) ? (cx + 1) : (nx - 1);
            int iy_lo = (cy > 0) ? (cy - 1) : 0;
            int iy_hi = (cy + 1 < ny) ? (cy + 1) : (ny - 1);
            int iz_lo = (cz > 0) ? (cz - 1) : 0;
            int iz_hi = (cz + 1 < nz) ? (cz + 1) : (nz - 1);

            const int my_obj = soa.object_id ? soa.object_id[idx] : 0;
            const bool my_failed = (soa.has_failed && soa.has_failed[idx] != 0) ||
                                   (soa.damage && soa.damage[idx] >= 0.99f);

            const float cell_min_dx = 1.0f / fmaxf(inv_dx, fmaxf(inv_dy, inv_dz));
            float dp_i = (soa.lp[0] && soa.lp[0][idx] > 1.0e-9f) ? (2.0f * soa.lp[0][idx]) : (0.5f * cell_min_dx);

            int neighbor_count = 1; // Always count self
            for (int ix = ix_lo; ix <= ix_hi; ++ix) {
                for (int iy = iy_lo; iy <= iy_hi; ++iy) {
                    size_t row_base = (static_cast<size_t>(ix) * ny + iy) * nz;
                    for (int iz = iz_lo; iz <= iz_hi; ++iz) {
                        const MPMGridNode3D& cell = grid[row_base + iz];
                        for (int s = 0; s < 8; ++s) {
                            int q = mpm_cell_slot_read(cell, s);
                            if (q < 0) break;
                            if (q == idx) continue;

                            // 1. Same-object filter: prevents particles smeared onto a foreign solid surface
                            // from inheriting the solid body's bulk particle density.
                            int q_obj = soa.object_id ? soa.object_id[q] : 0;
                            if (q_obj != my_obj) continue;

                            // 2. Failure-state isolation: failed/eroded spall particles smeared across an intact
                            // surface of the same object do not count intact core particles (and vice versa).
                            bool q_failed = (soa.has_failed && soa.has_failed[q] != 0) ||
                                            (soa.damage && soa.damage[q] >= 0.99f);
                            if (my_failed != q_failed) continue;

                            // 3. Exact Euclidean sub-cell cutoff radius r_cut = 1.80 * d_p:
                            // Includes 1st-shell face/edge/corner neighbors (up to sqrt(3)*d_p = 1.732*d_p)
                            // while excluding deeper 2nd-shell layers (2.0*d_p).
                            float dp_q = (soa.lp[0] && soa.lp[0][q] > 1.0e-9f) ? (2.0f * soa.lp[0][q]) : dp_i;
                            float r_cut = 1.80f * 0.5f * (dp_i + dp_q);
                            float dx_pq = px - soa.x[0][q];
                            float dy_pq = py - soa.x[1][q];
                            float dz_pq = pz - soa.x[2][q];
                            if (dx_pq * dx_pq + dy_pq * dy_pq + dz_pq * dz_pq <= r_cut * r_cut) {
                                ++neighbor_count;
                            }
                        }
                    }
                }
            }
            d_particle_density[local_idx] = static_cast<uint8_t>(neighbor_count > 255 ? 255 : neighbor_count);
        } else {
            d_particle_density[local_idx] = 1;
        }
    }
}

// 1. P2G Scatter Kernel (Coalesced SoA)
// P2G_MODE == MPM_P2G_SCATTER: normal scatter. Material fields go to the dense rows when
//   d_mat_tag == nullptr, or to compact slots (multi-material nodes only) when d_mat_tag is set.
// P2G_MODE == MPM_P2G_TAG: compact-storage pre-pass. Visits exactly the same stencil nodes
//   with the same filters as the scatter pass, but only records per-node material tags and
//   builds the active-node list. No mass/momentum/force is written.
template <int P2G_MODE>
__global__ void kernel_p2g_3d(MPMParticle3DSoA soa, int num_particles,
                              MPMGridNode3D* grid, int nx, int ny, int nz,
                              float dx, float dy, float dz, int transfer_scheme,
                              float xmin, float ymin, float zmin,
                              int* d_active_nodes, int* d_num_active_nodes,
                              const MaterialTable3D* d_mat_tables,
                              float* d_mat_m = nullptr, float* d_mat_p = nullptr,
                              float* d_mat_f = nullptr,
                              int num_materials = 1,
                              int bc_x_min = 1, int bc_x_max = 1,
                              int bc_y_min = 1, int bc_y_max = 1,
                              int bc_z_min = 1, int bc_z_max = 1,
                              int* d_mat_tag = nullptr, int* d_mat_counters = nullptr) {
    int p_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (p_idx >= num_particles || (soa.state && soa.state[p_idx] == 2) || soa.m[p_idx] <= 0.0f) return;

    int p_mat_id = (soa.material_id ? soa.material_id[p_idx] : 0);
    if (p_mat_id < 0 || p_mat_id >= num_materials) p_mat_id = 0;
    size_t num_nodes_total = static_cast<size_t>(nx) * ny * nz;
    constexpr float s_cutoff = (P2G_MODE == MPM_P2G_TAG) ? MPM_P2G_TAG_CUTOFF : MPM_P2G_SCATTER_CUTOFF;

    int obj_id = soa.object_id[p_idx];
    const MaterialTable3D& mat = d_mat_tables[obj_id];
    int eff_transfer_scheme = (mat.transfer_scheme >= 0) ? mat.transfer_scheme : transfer_scheme;
    const bool is_fluid_water = (mat.material_model == MPMMaterialModel::TaitWater);
    const bool is_energetic = (mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
                               mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
                               mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);
    const bool is_solid_mat = !is_fluid_water && !is_energetic && (mat.material_model != MPMMaterialModel::DruckerPragerSoil);

    float px = soa.x[0][p_idx] - xmin;
    float py = soa.x[1][p_idx] - ymin;
    float pz = soa.x[2][p_idx] - zmin;

    float p_m = soa.m[p_idx];
    float p_V = soa.V[p_idx];
    float p_ep_bar = soa.ep_bar[p_idx];
    float p_damage = soa.damage[p_idx];
    float p_temp = soa.temperature ? soa.temperature[p_idx] : mat.T_room;
    float t_star_p = (is_solid_mat && mat.T_melt > mat.T_room)
        ? fminf(fmaxf((p_temp - mat.T_room) / (mat.T_melt - mat.T_room), 0.0f), 1.5f)
        : 0.0f;
    float lp_x = soa.lp[0][p_idx], lp_y = soa.lp[1][p_idx], lp_z = soa.lp[2][p_idx];
    float v_x = soa.v[0][p_idx], v_y = soa.v[1][p_idx], v_z = soa.v[2][p_idx];
    float p_lambda = (soa.lambda ? soa.lambda[p_idx] : 0.0f);

    float s_xx = soa.sigma_voigt[0][p_idx]; float s_yy = soa.sigma_voigt[1][p_idx]; float s_zz = soa.sigma_voigt[2][p_idx];
    float s_xy = soa.sigma_voigt[3][p_idx]; float s_yz = soa.sigma_voigt[4][p_idx]; float s_zx = soa.sigma_voigt[5][p_idx];

    float B_00 = soa.B[0][0][p_idx], B_01 = soa.B[0][1][p_idx], B_02 = soa.B[0][2][p_idx];
    float B_10 = soa.B[1][0][p_idx], B_11 = soa.B[1][1][p_idx], B_12 = soa.B[1][2][p_idx];
    float B_20 = soa.B[2][0][p_idx], B_21 = soa.B[2][1][p_idx], B_22 = soa.B[2][2][p_idx];

    int base_i = static_cast<int>(floorf(px / dx));
    int base_j = static_cast<int>(floorf(py / dy));
    int base_k = static_cast<int>(floorf(pz / dz));

    float press = - (s_xx + s_yy + s_zz) / 3.0f;
    float diff_xy = s_xx - s_yy;
    float diff_yz = s_yy - s_zz;
    float diff_zx = s_zz - s_xx;
    float vm_stress = sqrtf(0.5f * (diff_xy * diff_xy + diff_yz * diff_yz + diff_zx * diff_zx) +
                            3.0f * (s_xy * s_xy + s_yz * s_yz + s_zx * s_zx));

    if (eff_transfer_scheme == 3) {
        // Radial Moving Least Squares MPM (Wendland C2 radial kernel with Centroid-Centered Linear Completeness)
        float R_supp = 2.0f * fmaxf(fmaxf(dx, dy), dz);

        // Pass 1: Local partition of unity sum, centroid displacement, and 2nd-moment tensor via Parallel-Axis Theorem
        float local_w_sum = 0.0f;
        float sum_wx = 0.0f, sum_wy = 0.0f, sum_wz = 0.0f;
        float sum_wxx = 0.0f, sum_wxy = 0.0f, sum_wxz = 0.0f;
        float sum_wyy = 0.0f, sum_wyz = 0.0f, sum_wzz = 0.0f;

        for (int offset_i = -2; offset_i <= 2; ++offset_i) {
            int i = base_i + offset_i;
            if (i < 0 || i >= nx) continue;
            float node_x = (static_cast<float>(i) + 0.5f) * dx;

            for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                int j = base_j + offset_j;
                if (j < 0 || j >= ny) continue;
                float node_y = (static_cast<float>(j) + 0.5f) * dy;

                for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                    int k = base_k + offset_k;
                    if (k < 0 || k >= nz) continue;
                    float node_z = (static_cast<float>(k) + 0.5f) * dz;

                    float dist_x = node_x - px;
                    float dist_y = node_y - py;
                    float dist_z = node_z - pz;
                    float r = sqrtf(dist_x * dist_x + dist_y * dist_y + dist_z * dist_z);
                    if (r >= R_supp) continue;

                    float w = evalWendland_C2_dev(r, R_supp);
                    if (w < 1.0e-7f) continue;

                    local_w_sum += w;
                    sum_wx += w * dist_x;
                    sum_wy += w * dist_y;
                    sum_wz += w * dist_z;

                    sum_wxx += w * dist_x * dist_x;
                    sum_wxy += w * dist_x * dist_y;
                    sum_wxz += w * dist_x * dist_z;
                    sum_wyy += w * dist_y * dist_y;
                    sum_wyz += w * dist_y * dist_z;
                    sum_wzz += w * dist_z * dist_z;
                }
            }
        }

        if (local_w_sum > 1.0e-7f) {
            float inv_w_sum = 1.0f / local_w_sum;
            float delta_x = sum_wx * inv_w_sum;
            float delta_y = sum_wy * inv_w_sum;
            float delta_z = sum_wz * inv_w_sum;
            float xc = px + delta_x;
            float yc = py + delta_y;
            float zc = pz + delta_z;

            // Parallel-Axis Moment Tensor: D = sum(w * (x - xc)(x - xc)^T) / w_sum
            //                                = sum(w * (x - p)(x - p)^T) / w_sum - delta * delta^T
            float D[3][3];
            D[0][0] = sum_wxx * inv_w_sum - delta_x * delta_x;
            D[0][1] = sum_wxy * inv_w_sum - delta_x * delta_y;
            D[0][2] = sum_wxz * inv_w_sum - delta_x * delta_z;
            D[1][0] = D[0][1];
            D[1][1] = sum_wyy * inv_w_sum - delta_y * delta_y;
            D[1][2] = sum_wyz * inv_w_sum - delta_y * delta_z;
            D[2][0] = D[0][2];
            D[2][1] = D[1][2];
            D[2][2] = sum_wzz * inv_w_sum - delta_z * delta_z;

            float h2 = (dx * dx + dy * dy + dz * dz) / 3.0f;
            float inv_h2 = 1.0f / fmaxf(h2, 1.0e-16f);
            float D00 = D[0][0] * inv_h2, D01 = D[0][1] * inv_h2, D02 = D[0][2] * inv_h2;
            float D11 = D[1][1] * inv_h2, D12 = D[1][2] * inv_h2, D22 = D[2][2] * inv_h2;

            float D_inv[3][3];
            float det_norm = D00 * (D11 * D22 - D12 * D12) -
                             D01 * (D01 * D22 - D12 * D02) +
                             D02 * (D01 * D12 - D11 * D02);

            if (det_norm > 1.0e-5f) {
                float inv_det = inv_h2 / det_norm;
                D_inv[0][0] =  (D11 * D22 - D12 * D12) * inv_det;
                D_inv[0][1] = -(D01 * D22 - D12 * D02) * inv_det;
                D_inv[0][2] =  (D01 * D12 - D11 * D02) * inv_det;
                D_inv[1][0] = D_inv[0][1];
                D_inv[1][1] =  (D00 * D22 - D02 * D02) * inv_det;
                D_inv[1][2] = -(D00 * D12 - D01 * D02) * inv_det;
                D_inv[2][0] = D_inv[0][2];
                D_inv[2][1] = D_inv[1][2];
                D_inv[2][2] =  (D00 * D11 - D01 * D01) * inv_det;
            } else {
                float d_iso = 5.5f * inv_h2;
                D_inv[0][0] = d_iso; D_inv[0][1] = 0.0f;  D_inv[0][2] = 0.0f;
                D_inv[1][0] = 0.0f;  D_inv[1][1] = d_iso; D_inv[1][2] = 0.0f;
                D_inv[2][0] = 0.0f;  D_inv[2][1] = 0.0f;  D_inv[2][2] = d_iso;
            }

            float s_Dinv[3][3];
            s_Dinv[0][0] = s_xx * D_inv[0][0] + s_xy * D_inv[1][0] + s_zx * D_inv[2][0];
            s_Dinv[0][1] = s_xx * D_inv[0][1] + s_xy * D_inv[1][1] + s_zx * D_inv[2][1];
            s_Dinv[0][2] = s_xx * D_inv[0][2] + s_xy * D_inv[1][2] + s_zx * D_inv[2][2];

            s_Dinv[1][0] = s_xy * D_inv[0][0] + s_yy * D_inv[1][0] + s_yz * D_inv[2][0];
            s_Dinv[1][1] = s_xy * D_inv[0][1] + s_yy * D_inv[1][1] + s_yz * D_inv[2][1];
            s_Dinv[1][2] = s_xy * D_inv[0][2] + s_yy * D_inv[1][2] + s_yz * D_inv[2][2];

            s_Dinv[2][0] = s_zx * D_inv[0][0] + s_yz * D_inv[1][0] + s_zz * D_inv[2][0];
            s_Dinv[2][1] = s_zx * D_inv[0][1] + s_yz * D_inv[1][1] + s_zz * D_inv[2][1];
            s_Dinv[2][2] = s_zx * D_inv[0][2] + s_yz * D_inv[1][2] + s_zz * D_inv[2][2];

            for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= nx) continue;
                float node_x = (static_cast<float>(i) + 0.5f) * dx;

                for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= ny) continue;
                    float node_y = (static_cast<float>(j) + 0.5f) * dy;

                    for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                        int k = base_k + offset_k;
                        if (k < 0 || k >= nz) continue;
                        float node_z = (static_cast<float>(k) + 0.5f) * dz;

                        float dist_x = node_x - px;
                        float dist_y = node_y - py;
                        float dist_z = node_z - pz;
                        float r = sqrtf(dist_x * dist_x + dist_y * dist_y + dist_z * dist_z);
                        if (r >= R_supp) continue;

                        float w = evalWendland_C2_dev(r, R_supp);
                        if (w < s_cutoff) continue;

                        float weight = w * inv_w_sum;

                        size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                        if constexpr (P2G_MODE == MPM_P2G_TAG) {
                            if (mpm_tag_node_material(d_mat_tag, node_idx, p_mat_id) && d_active_nodes && d_num_active_nodes) {
                                int pos = atomicAdd(d_num_active_nodes, 1);
                                d_active_nodes[pos] = static_cast<int>(node_idx);
                            }
                            continue;
                        }
                        MPMGridNode3D* node = &grid[node_idx];

                        float old_m = atomicAdd(&node->m, p_m * weight);
                        if (is_solid_mat) atomicAdd(&node->m_solid, p_m * weight);
                        if (is_energetic) {
                            atomicAdd(&node->m_energetic, p_m * weight);
                            atomicAdd(&node->m_reacted, p_m * weight * p_lambda);
                            atomicAdd(&node->v_energetic, p_V * weight);
                            atomicAdd(&node->v_reacted, p_V * weight * p_lambda);
                        }
                        if (old_m == 0.0f && d_active_nodes && d_num_active_nodes) {
                            int pos = atomicAdd(d_num_active_nodes, 1);
                            d_active_nodes[pos] = static_cast<int>(node_idx);
                        }

                        float dc_x = node_x - xc;
                        float dc_y = node_y - yc;
                        float dc_z = node_z - zc;

                        float v_apic_x = v_x + (B_00 * dc_x + B_01 * dc_y + B_02 * dc_z);
                        float v_apic_y = v_y + (B_10 * dc_x + B_11 * dc_y + B_12 * dc_z);
                        float v_apic_z = v_z + (B_20 * dc_x + B_21 * dc_y + B_22 * dc_z);

                        atomicAdd(&node->p[0], p_m * weight * v_apic_x);
                        atomicAdd(&node->p[1], p_m * weight * v_apic_y);
                        atomicAdd(&node->p[2], p_m * weight * v_apic_z);

                        float f_stress_x = -p_V * weight * (s_Dinv[0][0] * dc_x + s_Dinv[0][1] * dc_y + s_Dinv[0][2] * dc_z);
                        float f_stress_y = -p_V * weight * (s_Dinv[1][0] * dc_x + s_Dinv[1][1] * dc_y + s_Dinv[1][2] * dc_z);
                        float f_stress_z = -p_V * weight * (s_Dinv[2][0] * dc_x + s_Dinv[2][1] * dc_y + s_Dinv[2][2] * dc_z);

                        atomicAdd(&node->f_int[0], f_stress_x);
                        atomicAdd(&node->f_int[1], f_stress_y);
                        atomicAdd(&node->f_int[2], f_stress_z);

                        atomicAdd(&node->pressure, p_m * weight * press);
                        atomicAdd(&node->temperature, p_m * weight * p_temp);
                        if (is_solid_mat && p_ep_bar > 0.0f) {
                            atomicAdd(&node->plastic_strain, p_m * weight * p_ep_bar);
                        }
                        if (is_solid_mat && t_star_p > 0.0f) {
                            atomicAdd(&node->t_star, p_m * weight * t_star_p);
                        }

                        long long mn_row = d_mat_m ? mpm_mat_row(d_mat_tag, num_materials, num_nodes_total, p_mat_id, node_idx) : -1;
                        if (d_mat_m && mn_row < 0 && d_mat_counters && d_mat_tag[node_idx] != p_mat_id) {
                            // Tag pass and scatter pass disagree: fail loudly on the host (never silently drop mass)
                            atomicAdd(&d_mat_counters[1], 1);
                        }
                        if (mn_row >= 0) {
                            size_t mn_idx = static_cast<size_t>(mn_row);
                            atomicAdd(&d_mat_m[mn_idx], p_m * weight);
                            atomicAdd(&d_mat_p[mn_idx * 3 + 0], p_m * weight * v_apic_x);
                            atomicAdd(&d_mat_p[mn_idx * 3 + 1], p_m * weight * v_apic_y);
                            atomicAdd(&d_mat_p[mn_idx * 3 + 2], p_m * weight * v_apic_z);
                            atomicAdd(&d_mat_f[mn_idx * 3 + 0], f_stress_x);
                            atomicAdd(&d_mat_f[mn_idx * 3 + 1], f_stress_y);
                            atomicAdd(&d_mat_f[mn_idx * 3 + 2], f_stress_z);
                        }
                    }
                }
            }
        }
    } else if (eff_transfer_scheme == 4) {
        // Cubic B-Spline (5-node stencil [-2, 2] per axis / 125 nodes in 3D, C2 continuous)
        float D_inv_x_c = 3.0f / (dx * dx);
        float D_inv_y_c = 3.0f / (dy * dy);
        float D_inv_z_c = 3.0f / (dz * dz);
        float Sx_arr[5], dSx_arr[5], Sy_arr[5], dSy_arr[5], Sz_arr[5], dSz_arr[5];
        for (int offset = -2; offset <= 2; ++offset) {
            int idx = offset + 2;
            float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * dx;
            Sx_arr[idx] = evalCubicBSpline_S_dev(px, nx_val, dx);
            dSx_arr[idx] = Sx_arr[idx] * D_inv_x_c * (nx_val - px);

            float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * dy;
            Sy_arr[idx] = evalCubicBSpline_S_dev(py, ny_val, dy);
            dSy_arr[idx] = Sy_arr[idx] * D_inv_y_c * (ny_val - py);

            float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * dz;
            Sz_arr[idx] = evalCubicBSpline_S_dev(pz, nz_val, dz);
            dSz_arr[idx] = Sz_arr[idx] * D_inv_z_c * (nz_val - pz);
        }

        for (int offset_i = -2; offset_i <= 2; ++offset_i) {
            int raw_i = base_i + offset_i;
            int i = raw_i;
            float sign_x = 1.0f;
            if (!resolve_ghost_node_3d(i, sign_x, nx, bc_x_min, bc_x_max)) continue;
            int i_idx = offset_i + 2;
            float Sx = Sx_arr[i_idx];
            if (fabsf(Sx) < s_cutoff) continue;
            float dSx = dSx_arr[i_idx];
            float node_x = (static_cast<float>(raw_i) + 0.5f) * dx;

            for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                int raw_j = base_j + offset_j;
                int j = raw_j;
                float sign_y = 1.0f;
                if (!resolve_ghost_node_3d(j, sign_y, ny, bc_y_min, bc_y_max)) continue;
                int j_idx = offset_j + 2;
                float Sy = Sy_arr[j_idx];
                if (fabsf(Sy) < s_cutoff) continue;
                float dSy = dSy_arr[j_idx];
                float node_y = (static_cast<float>(raw_j) + 0.5f) * dy;

                for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                    int raw_k = base_k + offset_k;
                    int k = raw_k;
                    float sign_z = 1.0f;
                    if (!resolve_ghost_node_3d(k, sign_z, nz, bc_z_min, bc_z_max)) continue;
                    int k_idx = offset_k + 2;
                    float Sz = Sz_arr[k_idx];
                    if (fabsf(Sz) < s_cutoff) continue;
                    float dSz = dSz_arr[k_idx];
                    float node_z = (static_cast<float>(raw_k) + 0.5f) * dz;

                    float weight = Sx * Sy * Sz;
                    if (weight < s_cutoff) continue;
                    float dN_dx = dSx * Sy * Sz;
                    float dN_dy = Sx * dSy * Sz;
                    float dN_dz = Sx * Sy * dSz;

                    size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                    if constexpr (P2G_MODE == MPM_P2G_TAG) {
                        if (mpm_tag_node_material(d_mat_tag, node_idx, p_mat_id) && d_active_nodes && d_num_active_nodes) {
                            int pos = atomicAdd(d_num_active_nodes, 1);
                            d_active_nodes[pos] = static_cast<int>(node_idx);
                        }
                        continue;
                    }
                    long long mn_row = d_mat_m ? mpm_mat_row(d_mat_tag, num_materials, num_nodes_total, p_mat_id, node_idx) : -1;
                    if (d_mat_m && d_mat_tag) {
                        int tag = d_mat_tag[node_idx];
                        if (tag == MPM_MAT_TAG_EMPTY || (mn_row < 0 && tag != p_mat_id)) {
                            if (weight < 1.0e-5f) continue;
                            if (d_mat_counters) atomicAdd(&d_mat_counters[1], 1);
                            continue;
                        }
                    }

                    MPMGridNode3D* node = &grid[node_idx];

                    float old_m = atomicAdd(&node->m, p_m * weight);
                    if (is_solid_mat) atomicAdd(&node->m_solid, p_m * weight);
                    if (is_energetic) {
                        atomicAdd(&node->m_energetic, p_m * weight);
                        atomicAdd(&node->m_reacted, p_m * weight * p_lambda);
                        atomicAdd(&node->v_energetic, p_V * weight);
                        atomicAdd(&node->v_reacted, p_V * weight * p_lambda);
                    }
                    if (old_m == 0.0f && d_active_nodes && d_num_active_nodes) {
                        int pos = atomicAdd(d_num_active_nodes, 1);
                        d_active_nodes[pos] = static_cast<int>(node_idx);
                    }

                    float dist_x = node_x - px;
                    float dist_y = node_y - py;
                    float dist_z = node_z - pz;

                    float w_apic = 1.0f;
                    float v_apic_x = v_x + w_apic * (B_00 * dist_x + B_01 * dist_y + B_02 * dist_z);
                    float v_apic_y = v_y + w_apic * (B_10 * dist_x + B_11 * dist_y + B_12 * dist_z);
                    float v_apic_z = v_z + w_apic * (B_20 * dist_x + B_21 * dist_y + B_22 * dist_z);

                    atomicAdd(&node->p[0], sign_x * p_m * weight * v_apic_x);
                    atomicAdd(&node->p[1], sign_y * p_m * weight * v_apic_y);
                    atomicAdd(&node->p[2], sign_z * p_m * weight * v_apic_z);

                    float f_stress_x = -p_V * (s_xx * dN_dx + s_xy * dN_dy + s_zx * dN_dz);
                    float f_stress_y = -p_V * (s_xy * dN_dx + s_yy * dN_dy + s_yz * dN_dz);
                    float f_stress_z = -p_V * (s_zx * dN_dx + s_yz * dN_dy + s_zz * dN_dz);

                    atomicAdd(&node->f_int[0], sign_x * f_stress_x);
                    atomicAdd(&node->f_int[1], sign_y * f_stress_y);
                    atomicAdd(&node->f_int[2], sign_z * f_stress_z);

                    atomicAdd(&node->pressure, p_m * weight * press);
                    atomicAdd(&node->temperature, p_m * weight * p_temp);
                    if (is_solid_mat && p_ep_bar > 0.0f) {
                        atomicAdd(&node->plastic_strain, p_m * weight * p_ep_bar);
                    }
                    if (is_solid_mat && t_star_p > 0.0f) {
                        atomicAdd(&node->t_star, p_m * weight * t_star_p);
                    }

                    if (mn_row >= 0) {
                        size_t mn_idx = static_cast<size_t>(mn_row);
                        atomicAdd(&d_mat_m[mn_idx], p_m * weight);
                        atomicAdd(&d_mat_p[mn_idx * 3 + 0], sign_x * p_m * weight * v_apic_x);
                        atomicAdd(&d_mat_p[mn_idx * 3 + 1], sign_y * p_m * weight * v_apic_y);
                        atomicAdd(&d_mat_p[mn_idx * 3 + 2], sign_z * p_m * weight * v_apic_z);
                        atomicAdd(&d_mat_f[mn_idx * 3 + 0], sign_x * f_stress_x);
                        atomicAdd(&d_mat_f[mn_idx * 3 + 1], sign_y * f_stress_y);
                        atomicAdd(&d_mat_f[mn_idx * 3 + 2], sign_z * f_stress_z);
                    }
                }
            }
        }
    } else {
        float Sx_arr[4], dSx_arr[4], Sy_arr[4], dSy_arr[4], Sz_arr[4], dSz_arr[4];
        if (eff_transfer_scheme == 1) {
            #pragma unroll
            for (int offset = -1; offset <= 2; ++offset) {
                int idx = offset + 1;
                float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * dx;
                Sx_arr[idx] = evalGIMP_S_dev(px, nx_val, dx, lp_x);
                dSx_arr[idx] = evalGIMP_dS_dev(px, nx_val, dx, lp_x);

                float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * dy;
                Sy_arr[idx] = evalGIMP_S_dev(py, ny_val, dy, lp_y);
                dSy_arr[idx] = evalGIMP_dS_dev(py, ny_val, dy, lp_y);

                float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * dz;
                Sz_arr[idx] = evalGIMP_S_dev(pz, nz_val, dz, lp_z);
                dSz_arr[idx] = evalGIMP_dS_dev(pz, nz_val, dz, lp_z);
            }
        } else if (eff_transfer_scheme == 2) {
            float D_inv_x_b = 4.0f / (dx * dx);
            float D_inv_y_b = 4.0f / (dy * dy);
            float D_inv_z_b = 4.0f / (dz * dz);
            #pragma unroll
            for (int offset = -1; offset <= 2; ++offset) {
                int idx = offset + 1;
                float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * dx;
                Sx_arr[idx] = evalBSpline_S_dev(px, nx_val, dx);
                dSx_arr[idx] = Sx_arr[idx] * D_inv_x_b * (nx_val - px);

                float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * dy;
                Sy_arr[idx] = evalBSpline_S_dev(py, ny_val, dy);
                dSy_arr[idx] = Sy_arr[idx] * D_inv_y_b * (ny_val - py);

                float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * dz;
                Sz_arr[idx] = evalBSpline_S_dev(pz, nz_val, dz);
                dSz_arr[idx] = Sz_arr[idx] * D_inv_z_b * (nz_val - pz);
            }
        } else {
            #pragma unroll
            for (int offset = -1; offset <= 2; ++offset) {
                int idx = offset + 1;
                float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * dx;
                Sx_arr[idx] = evalLinear_S_dev(px, nx_val, dx);
                dSx_arr[idx] = evalLinear_dS_dev(px, nx_val, dx);

                float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * dy;
                Sy_arr[idx] = evalLinear_S_dev(py, ny_val, dy);
                dSy_arr[idx] = evalLinear_dS_dev(py, ny_val, dy);

                float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * dz;
                Sz_arr[idx] = evalLinear_S_dev(pz, nz_val, dz);
                dSz_arr[idx] = evalLinear_dS_dev(pz, nz_val, dz);
            }
        }

        for (int offset_i = -1; offset_i <= 2; ++offset_i) {
            int raw_i = base_i + offset_i;
            int i = raw_i;
            float sign_x = 1.0f;
            if (!resolve_ghost_node_3d(i, sign_x, nx, bc_x_min, bc_x_max)) continue;
            int i_idx = offset_i + 1;
            float Sx = Sx_arr[i_idx];
            if (fabsf(Sx) < s_cutoff) continue;
            float dSx = dSx_arr[i_idx];
            float node_x = (static_cast<float>(raw_i) + 0.5f) * dx;

            for (int offset_j = -1; offset_j <= 2; ++offset_j) {
                int raw_j = base_j + offset_j;
                int j = raw_j;
                float sign_y = 1.0f;
                if (!resolve_ghost_node_3d(j, sign_y, ny, bc_y_min, bc_y_max)) continue;
                int j_idx = offset_j + 1;
                float Sy = Sy_arr[j_idx];
                if (fabsf(Sy) < s_cutoff) continue;
                float dSy = dSy_arr[j_idx];
                float node_y = (static_cast<float>(raw_j) + 0.5f) * dy;

                for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                    int raw_k = base_k + offset_k;
                    int k = raw_k;
                    float sign_z = 1.0f;
                    if (!resolve_ghost_node_3d(k, sign_z, nz, bc_z_min, bc_z_max)) continue;
                    int k_idx = offset_k + 1;
                    float Sz = Sz_arr[k_idx];
                    if (fabsf(Sz) < s_cutoff) continue;
                    float dSz = dSz_arr[k_idx];
                    float node_z = (static_cast<float>(raw_k) + 0.5f) * dz;

                    float weight = Sx * Sy * Sz;
                    size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                    if (weight < s_cutoff) continue;
                    float dN_dx = dSx * Sy * Sz;
                    float dN_dy = Sx * dSy * Sz;
                    float dN_dz = Sx * Sy * dSz;
                    if constexpr (P2G_MODE == MPM_P2G_TAG) {
                        if (mpm_tag_node_material(d_mat_tag, node_idx, p_mat_id) && d_active_nodes && d_num_active_nodes) {
                            int pos = atomicAdd(d_num_active_nodes, 1);
                            d_active_nodes[pos] = static_cast<int>(node_idx);
                        }
                        continue;
                    }

                    long long mn_row = d_mat_m ? mpm_mat_row(d_mat_tag, num_materials, num_nodes_total, p_mat_id, node_idx) : -1;
                    if (d_mat_m && d_mat_tag) {
                        int tag = d_mat_tag[node_idx];
                        if (tag == MPM_MAT_TAG_EMPTY || (mn_row < 0 && tag != p_mat_id)) {
                            if (weight < 1.0e-5f) continue;
                            if (d_mat_counters) atomicAdd(&d_mat_counters[1], 1);
                            continue;
                        }
                    }

                    MPMGridNode3D* node = &grid[node_idx];

                    float old_m = atomicAdd(&node->m, p_m * weight);
                    if (is_solid_mat) atomicAdd(&node->m_solid, p_m * weight);
                    if (is_energetic) {
                        atomicAdd(&node->m_energetic, p_m * weight);
                        atomicAdd(&node->m_reacted, p_m * weight * p_lambda);
                        atomicAdd(&node->v_energetic, p_V * weight);
                        atomicAdd(&node->v_reacted, p_V * weight * p_lambda);
                    }
                    if (old_m == 0.0f && d_active_nodes && d_num_active_nodes) {
                        int pos = atomicAdd(d_num_active_nodes, 1);
                        d_active_nodes[pos] = static_cast<int>(node_idx);
                    }

                    float dist_x = node_x - px;
                    float dist_y = node_y - py;
                    float dist_z = node_z - pz;

                    float w_apic = 1.0f;
                    float v_apic_x = v_x + w_apic * (B_00 * dist_x + B_01 * dist_y + B_02 * dist_z);
                    float v_apic_y = v_y + w_apic * (B_10 * dist_x + B_11 * dist_y + B_12 * dist_z);
                    float v_apic_z = v_z + w_apic * (B_20 * dist_x + B_21 * dist_y + B_22 * dist_z);

                    atomicAdd(&node->p[0], sign_x * p_m * weight * v_apic_x);
                    atomicAdd(&node->p[1], sign_y * p_m * weight * v_apic_y);
                    atomicAdd(&node->p[2], sign_z * p_m * weight * v_apic_z);

                    float f_stress_x = -p_V * (s_xx * dN_dx + s_xy * dN_dy + s_zx * dN_dz);
                    float f_stress_y = -p_V * (s_xy * dN_dx + s_yy * dN_dy + s_yz * dN_dz);
                    float f_stress_z = -p_V * (s_zx * dN_dx + s_yz * dN_dy + s_zz * dN_dz);

                    atomicAdd(&node->f_int[0], sign_x * f_stress_x);
                    atomicAdd(&node->f_int[1], sign_y * f_stress_y);
                    atomicAdd(&node->f_int[2], sign_z * f_stress_z);

                    atomicAdd(&node->pressure, p_m * weight * press);
                    atomicAdd(&node->temperature, p_m * weight * p_temp);
                    if (is_solid_mat && p_ep_bar > 0.0f) {
                        atomicAdd(&node->plastic_strain, p_m * weight * p_ep_bar);
                    }
                    if (is_solid_mat && t_star_p > 0.0f) {
                        atomicAdd(&node->t_star, p_m * weight * t_star_p);
                    }

                    if (mn_row >= 0) {
                        size_t mn_idx = static_cast<size_t>(mn_row);
                        atomicAdd(&d_mat_m[mn_idx], p_m * weight);
                        atomicAdd(&d_mat_p[mn_idx * 3 + 0], sign_x * p_m * weight * v_apic_x);
                        atomicAdd(&d_mat_p[mn_idx * 3 + 1], sign_y * p_m * weight * v_apic_y);
                        atomicAdd(&d_mat_p[mn_idx * 3 + 2], sign_z * p_m * weight * v_apic_z);
                        atomicAdd(&d_mat_f[mn_idx * 3 + 0], sign_x * f_stress_x);
                        atomicAdd(&d_mat_f[mn_idx * 3 + 1], sign_y * f_stress_y);
                        atomicAdd(&d_mat_f[mn_idx * 3 + 2], sign_z * f_stress_z);
                    }
                }
            }
        }
    }
}

// 2. Grid Kinematics Kernel
__global__ void kernel_grid_update_3d(MPMGridNode3D* grid, int num_nodes, int nx, int ny, int nz,
                                     float dt, float avg_p_mass,
                                     int bc_x_min, int bc_x_max,
                                     int bc_y_min, int bc_y_max,
                                     int bc_z_min, int bc_z_max,
                                     const int* active_nodes, int num_active,
                                     float dx = 0.0f, float dy = 0.0f, float dz = 0.0f,
                                     float lysmer_rho = 2000.0f, float lysmer_cp = 2000.0f, float lysmer_cs = 1000.0f,
                                     float lysmer_n_rel = 1.0f, float lysmer_s_rel = 1.0f) {
    int idx;
    if (active_nodes && num_active > 0) {
        int t_idx = blockIdx.x * blockDim.x + threadIdx.x;
        if (t_idx >= num_active) return;
        idx = active_nodes[t_idx];
    } else {
        idx = blockIdx.x * blockDim.x + threadIdx.x;
        if (idx >= num_nodes) return;
    }

    MPMGridNode3D& node = grid[idx];
    if (node.m <= 1.0e-20f) return;

    node.plastic_strain = (node.m_solid > 1.0e-20f) ? (node.plastic_strain / node.m_solid) : 0.0f;
    node.t_star = (node.m_solid > 1.0e-20f) ? (node.t_star / node.m_solid) : 0.0f;
    node.pressure /= node.m;
    node.temperature /= node.m;
    node.dT_cond = 0.0f;
    node.q_fric = 0.0f;

    // Asymptotic mass regularization (Directive 19): only active when m_node < 1.0e-8 * m_ref
    float m_ref = fmaxf(avg_p_mass, 1.0e-12f);
    float m_tol = 1.0e-8f * m_ref;
    float reg = (node.m * node.m) / (node.m * node.m + m_tol * m_tol);

    node.p[0] += dt * (node.f_ext[0] + reg * node.f_int[0]);
    node.p[1] += dt * (node.f_ext[1] + reg * node.f_int[1]);
    node.p[2] += dt * (node.f_ext[2] + reg * node.f_int[2]);

    // Unpack 3D indices
    int k = idx % nz;
    int j = (idx / nz) % ny;
    int i = idx / (ny * nz);

    if ((i == 0 && bc_x_min == 0) || (i == nx - 1 && bc_x_max == 0)) { node.p[0] = 0.0f; node.p[1] = 0.0f; node.p[2] = 0.0f; }
    else if ((i == 0 && bc_x_min == 4) || (i == nx - 1 && bc_x_max == 4)) {
        float A_trib = dy * dz;
        float C_n = A_trib * lysmer_rho * lysmer_cp * lysmer_n_rel;
        float C_s = A_trib * lysmer_rho * lysmer_cs * lysmer_s_rel;
        node.p[0] *= expf(- (C_n / node.m) * dt);
        node.p[1] *= expf(- (C_s / node.m) * dt);
        node.p[2] *= expf(- (C_s / node.m) * dt);
    }

    if ((j == 0 && bc_y_min == 0) || (j == ny - 1 && bc_y_max == 0)) { node.p[0] = 0.0f; node.p[1] = 0.0f; node.p[2] = 0.0f; }
    else if ((j == 0 && bc_y_min == 4) || (j == ny - 1 && bc_y_max == 4)) {
        float A_trib = dx * dz;
        float C_n = A_trib * lysmer_rho * lysmer_cp * lysmer_n_rel;
        float C_s = A_trib * lysmer_rho * lysmer_cs * lysmer_s_rel;
        node.p[1] *= expf(- (C_n / node.m) * dt);
        node.p[0] *= expf(- (C_s / node.m) * dt);
        node.p[2] *= expf(- (C_s / node.m) * dt);
    }

    if ((k == 0 && bc_z_min == 0) || (k == nz - 1 && bc_z_max == 0)) { node.p[0] = 0.0f; node.p[1] = 0.0f; node.p[2] = 0.0f; }
    else if ((k == 0 && bc_z_min == 4) || (k == nz - 1 && bc_z_max == 4)) {
        float A_trib = dx * dy;
        float C_n = A_trib * lysmer_rho * lysmer_cp * lysmer_n_rel;
        float C_s = A_trib * lysmer_rho * lysmer_cs * lysmer_s_rel;
        node.p[2] *= expf(- (C_n / node.m) * dt);
        node.p[0] *= expf(- (C_s / node.m) * dt);
        node.p[1] *= expf(- (C_s / node.m) * dt);
    }
}

// 2b. Bardenhagen Multi-Velocity Field Contact Grid Kinematics Kernel
// d_mat_tag == nullptr: dense material layout (row = mat * N + node).
// d_mat_tag != nullptr: compact material layout (see "Compact multi-material storage").
//   Single-material nodes (0 <= tag < M) carry their material fields in the global node.
//   They are advanced in place: afterwards node.p holds the BC-applied momentum
//   (so v = node.p / node.m) and node.f_int holds the velocity increment dv used by G2P.
//   This is algebraically identical to the dense sig_count == 1 branch.
__global__ void kernel_bardenhagen_grid_update_3d(
    MPMGridNode3D* grid, int num_nodes, int nx, int ny, int nz,
    float dt, float avg_p_mass,
    int bc_x_min, int bc_x_max,
    int bc_y_min, int bc_y_max,
    int bc_z_min, int bc_z_max,
    const int* active_nodes, int num_active,
    int num_materials,
    float* d_mat_m, float* d_mat_p, float* d_mat_f,
    float* d_mat_v, float* d_mat_dv,
    float friction, float restitution,
    float dx,
    const MaterialTable3D* d_mat_tables = nullptr,
    const int* d_mat_to_obj = nullptr,
    float dy = 0.0f, float dz = 0.0f,
    float lysmer_rho = 2000.0f, float lysmer_cp = 2000.0f, float lysmer_cs = 1000.0f,
    float lysmer_n_rel = 1.0f, float lysmer_s_rel = 1.0f,
    const int* d_mat_tag = nullptr,
    bool enable_impact_welding = false,
    bool enable_frictional_heating = false)
{
    int idx;
    if (active_nodes && num_active > 0) {
        int t_idx = blockIdx.x * blockDim.x + threadIdx.x;
        if (t_idx >= num_active) return;
        idx = active_nodes[t_idx];
    } else {
        idx = blockIdx.x * blockDim.x + threadIdx.x;
        if (idx >= num_nodes) return;
    }

    MPMGridNode3D& node = grid[idx];
    if (node.m <= 1.0e-20f) return;

    node.plastic_strain = (node.m_solid > 1.0e-20f) ? (node.plastic_strain / node.m_solid) : 0.0f;
    node.t_star = (node.m_solid > 1.0e-20f) ? (node.t_star / node.m_solid) : 0.0f;
    node.pressure /= node.m;
    node.temperature /= node.m;
    node.dT_cond = 0.0f;
    node.q_fric = 0.0f;

    int k = idx % nz;
    int j = (idx / nz) % ny;
    int i = idx / (ny * nz);

    float m_cm = 0.0f;
    float p_cm[3] = {0.0f, 0.0f, 0.0f};

    auto applyBC = [&](float& vx, float& vy, float& vz, float mass = 0.0f) {
        if (mass <= 1.0e-20f) mass = (m_cm > 1.0e-20f ? m_cm : 1.0f);
        if ((i == 0 && bc_x_min == 0) || (i == nx - 1 && bc_x_max == 0)) { vx = 0.0f; vy = 0.0f; vz = 0.0f; }
        else if ((i == 0 && bc_x_min == 4) || (i == nx - 1 && bc_x_max == 4)) {
            float A_trib = dy * dz;
            float C_n = A_trib * lysmer_rho * lysmer_cp * lysmer_n_rel;
            float C_s = A_trib * lysmer_rho * lysmer_cs * lysmer_s_rel;
            vx *= expf(- (C_n / mass) * dt);
            vy *= expf(- (C_s / mass) * dt);
            vz *= expf(- (C_s / mass) * dt);
        }

        if ((j == 0 && bc_y_min == 0) || (j == ny - 1 && bc_y_max == 0)) { vx = 0.0f; vy = 0.0f; vz = 0.0f; }
        else if ((j == 0 && bc_y_min == 4) || (j == ny - 1 && bc_y_max == 4)) {
            float A_trib = dx * dz;
            float C_n = A_trib * lysmer_rho * lysmer_cp * lysmer_n_rel;
            float C_s = A_trib * lysmer_rho * lysmer_cs * lysmer_s_rel;
            vy *= expf(- (C_n / mass) * dt);
            vx *= expf(- (C_s / mass) * dt);
            vz *= expf(- (C_s / mass) * dt);
        }

        if ((k == 0 && bc_z_min == 0) || (k == nz - 1 && bc_z_max == 0)) { vx = 0.0f; vy = 0.0f; vz = 0.0f; }
        else if ((k == 0 && bc_z_min == 4) || (k == nz - 1 && bc_z_max == 4)) {
            float A_trib = dx * dy;
            float C_n = A_trib * lysmer_rho * lysmer_cp * lysmer_n_rel;
            float C_s = A_trib * lysmer_rho * lysmer_cs * lysmer_s_rel;
            vz *= expf(- (C_n / mass) * dt);
            vx *= expf(- (C_s / mass) * dt);
            vy *= expf(- (C_s / mass) * dt);
        }
    };

    const size_t N = static_cast<size_t>(num_nodes);
    long long slot_base = -1;  // compact layout: first row of this node's slot

    if (d_mat_tag) {
        const int tag = d_mat_tag[idx];
        if (tag < 0) return;  // unreachable: host verifies tag/scatter consistency after P2G

        if (tag < num_materials) {
            // Compact single-material node: material fields == global node fields.
            const float mat_mass = node.m;
            const float inv_m = 1.0f / mat_mass;
            const float v_old[3] = {node.p[0] * inv_m, node.p[1] * inv_m, node.p[2] * inv_m};

            float m_ref = fmaxf(avg_p_mass, 1.0e-12f);
            float m_tol = 1.0e-8f * m_ref;
            float reg = (mat_mass * mat_mass) / (mat_mass * mat_mass + m_tol * m_tol);

            float p0 = node.p[0] + dt * (reg * node.f_int[0] + node.f_ext[0]);
            float p1 = node.p[1] + dt * (reg * node.f_int[1] + node.f_ext[1]);
            float p2 = node.p[2] + dt * (reg * node.f_int[2] + node.f_ext[2]);

            m_cm = mat_mass;
            float vx = p0 * inv_m, vy = p1 * inv_m, vz = p2 * inv_m;
            applyBC(vx, vy, vz);
            applyBC(p0, p1, p2);

            node.p[0] = p0; node.p[1] = p1; node.p[2] = p2;
            // f_int is consumed above; reuse it to carry dv to G2P (no extra storage)
            node.f_int[0] = vx - v_old[0];
            node.f_int[1] = vy - v_old[1];
            node.f_int[2] = vz - v_old[2];
            return;
        }
        slot_base = static_cast<long long>(tag - num_materials) * num_materials;
    }

    auto row = [&](int m) -> size_t {
        return (slot_base >= 0) ? (static_cast<size_t>(slot_base) + m)
                                : (static_cast<size_t>(m) * N + idx);
    };

    for (int m = 0; m < num_materials; ++m) {
        size_t mn_idx = row(m);
        float mat_mass = d_mat_m[mn_idx];
        if (mat_mass > 1.0e-20f) {
            m_cm += mat_mass;

            // Cache pre-update velocity v_old in d_mat_dv
            float inv_m = 1.0f / mat_mass;
            if (d_mat_dv) {
                d_mat_dv[mn_idx * 3 + 0] = d_mat_p[mn_idx * 3 + 0] * inv_m;
                d_mat_dv[mn_idx * 3 + 1] = d_mat_p[mn_idx * 3 + 1] * inv_m;
                d_mat_dv[mn_idx * 3 + 2] = d_mat_p[mn_idx * 3 + 2] * inv_m;
            }

            float m_ref = fmaxf(avg_p_mass, 1.0e-12f);
            float m_tol = 1.0e-8f * m_ref;
            float reg = (mat_mass * mat_mass) / (mat_mass * mat_mass + m_tol * m_tol);

            float f_ext_x = node.f_ext[0] * (mat_mass / node.m);
            float f_ext_y = node.f_ext[1] * (mat_mass / node.m);
            float f_ext_z = node.f_ext[2] * (mat_mass / node.m);

            d_mat_p[mn_idx * 3 + 0] += dt * (reg * d_mat_f[mn_idx * 3 + 0] + f_ext_x);
            d_mat_p[mn_idx * 3 + 1] += dt * (reg * d_mat_f[mn_idx * 3 + 1] + f_ext_y);
            d_mat_p[mn_idx * 3 + 2] += dt * (reg * d_mat_f[mn_idx * 3 + 2] + f_ext_z);

            p_cm[0] += d_mat_p[mn_idx * 3 + 0];
            p_cm[1] += d_mat_p[mn_idx * 3 + 1];
            p_cm[2] += d_mat_p[mn_idx * 3 + 2];
        } else if (d_mat_dv) {
            d_mat_dv[mn_idx * 3 + 0] = 0.0f;
            d_mat_dv[mn_idx * 3 + 1] = 0.0f;
            d_mat_dv[mn_idx * 3 + 2] = 0.0f;
        }
    }

    if (m_cm <= 1.0e-20f) {
        node.p[0] = 0.0f; node.p[1] = 0.0f; node.p[2] = 0.0f;
        return;
    }

    float inv_m_cm = 1.0f / m_cm;
    float v_cm[3] = {p_cm[0] * inv_m_cm, p_cm[1] * inv_m_cm, p_cm[2] * inv_m_cm};

    // Identify materials with physical mass presence on this node
    int sig_count = 0;
    bool any_fluid = false;
    const float eff_dy = (dy > 0.0f) ? dy : dx;
    const float eff_dz = (dz > 0.0f) ? dz : dx;
    const float cell_vol = fmaxf(dx * eff_dy * eff_dz, 1.0e-20f);
    float phi_max1 = 0.0f;
    float phi_max2 = 0.0f;

    for (int m = 0; m < num_materials; ++m) {
        float mat_mass = d_mat_m[row(m)];
        if (mat_mass > 1.0e-20f) {
            sig_count++;

            int obj_id = d_mat_to_obj ? d_mat_to_obj[m] : (m + 1);
            float rho_m = 7850.0f;
            if (d_mat_tables) {
                if (d_mat_tables[obj_id].density > 1.0e-6f) {
                    rho_m = d_mat_tables[obj_id].density;
                }
                auto m_model = d_mat_tables[obj_id].material_model;
                if (m_model == MPMMaterialModel::CRESTReactiveBurn ||
                    m_model == MPMMaterialModel::JWLProgrammedBurn ||
                    m_model == MPMMaterialModel::LeeTarverIgnitionGrowth) {
                    any_fluid = true;
                }
            }
            float phi_m = mat_mass / fmaxf(rho_m * cell_vol, 1.0e-20f);
            if (phi_m > phi_max1) {
                phi_max2 = phi_max1;
                phi_max1 = phi_m;
            } else if (phi_m > phi_max2) {
                phi_max2 = phi_m;
            }
        }
    }

    // Scale-isolated Bardenhagen vacuum-gap contact engagement factor:
    // Suppresses premature contact across empty vacuum gaps where NEITHER material occupies the cell core
    // (both materials only touch the node via outer B-spline fringe tails: phi_max1 + phi_max2 < 0.25 and phi_max2 < 0.05).
    // When at least one material occupies the cell core (phi_total >= 0.25), any minority spline tail of a
    // second body reaching into that occupied cell receives full Bardenhagen contact velocity (beta_contact = 1),
    // preserving a monotonic contact velocity profile across the stencil and full impact strain rate L_new in G2P.
    const float phi_total = phi_max1 + phi_max2;
    const float beta_fringe = fminf(fmaxf((phi_max2 - 0.05f) / 0.05f, 0.0f), 1.0f);
    const float beta_core   = fminf(fmaxf((phi_total - 0.40f) / 0.15f, 0.0f), 1.0f) *
                              fminf(fmaxf((phi_max2 - 1.0e-3f) / 4.0e-3f, 0.0f), 1.0f);
    const float beta_contact = fmaxf(beta_fringe, beta_core);

    if (sig_count <= 1 || beta_contact <= 0.0f) {
        for (int m = 0; m < num_materials; ++m) {
            size_t mn_idx = row(m);
            float mat_mass = d_mat_m[mn_idx];
            if (mat_mass > 1.0e-20f) {
                float inv_m = 1.0f / mat_mass;
                float vx = d_mat_p[mn_idx * 3 + 0] * inv_m;
                float vy = d_mat_p[mn_idx * 3 + 1] * inv_m;
                float vz = d_mat_p[mn_idx * 3 + 2] * inv_m;
                applyBC(vx, vy, vz);
                d_mat_v[mn_idx * 3 + 0] = vx;
                d_mat_v[mn_idx * 3 + 1] = vy;
                d_mat_v[mn_idx * 3 + 2] = vz;
                if (d_mat_dv) {
                    d_mat_dv[mn_idx * 3 + 0] = vx - d_mat_dv[mn_idx * 3 + 0];
                    d_mat_dv[mn_idx * 3 + 1] = vy - d_mat_dv[mn_idx * 3 + 1];
                    d_mat_dv[mn_idx * 3 + 2] = vz - d_mat_dv[mn_idx * 3 + 2];
                }
            } else {
                d_mat_v[mn_idx * 3 + 0] = 0.0f;
                d_mat_v[mn_idx * 3 + 1] = 0.0f;
                d_mat_v[mn_idx * 3 + 2] = 0.0f;
                if (d_mat_dv) {
                    d_mat_dv[mn_idx * 3 + 0] = 0.0f;
                    d_mat_dv[mn_idx * 3 + 1] = 0.0f;
                    d_mat_dv[mn_idx * 3 + 2] = 0.0f;
                }
            }
        }
        float p0 = p_cm[0], p1 = p_cm[1], p2 = p_cm[2];
        applyBC(p0, p1, p2);
        node.p[0] = p0; node.p[1] = p1; node.p[2] = p2;
        return;
    }

    // Face-neighbour node indices (clamped to self at domain boundaries)
    const size_t n_ip = (i + 1 < nx) ? ((static_cast<size_t>(i + 1) * ny + j) * nz + k) : static_cast<size_t>(idx);
    const size_t n_im = (i > 0)      ? ((static_cast<size_t>(i - 1) * ny + j) * nz + k) : static_cast<size_t>(idx);
    const size_t n_jp = (j + 1 < ny) ? ((static_cast<size_t>(i) * ny + (j + 1)) * nz + k) : static_cast<size_t>(idx);
    const size_t n_jm = (j > 0)      ? ((static_cast<size_t>(i) * ny + (j - 1)) * nz + k) : static_cast<size_t>(idx);
    const size_t n_kp = (k + 1 < nz) ? ((static_cast<size_t>(i) * ny + j) * nz + (k + 1)) : static_cast<size_t>(idx);
    const size_t n_km = (k > 0)      ? ((static_cast<size_t>(i) * ny + j) * nz + (k - 1)) : static_cast<size_t>(idx);

    // On-the-fly 2nd-order finite difference normals (evaluated strictly on multi-material interface cells)
    // Normalize each material's mass gradient to a unit vector g_hat_m and weight by nodal mass m_m
    // so that a trace 3rd material (m_k << m_cm) cannot hijack the contact normal between primary bodies.
    float inv_2dx = 0.5f / dx;
    float G_weighted_total[3] = {0.0f, 0.0f, 0.0f};
    float G_unit_sum[3] = {0.0f, 0.0f, 0.0f};
    for (int m = 0; m < num_materials; ++m) {
        float mat_mass = d_mat_m[row(m)];
        if (mat_mass > 1.0e-20f) {
            float gm_x = (mpm_mat_mass_at(grid, d_mat_tag, d_mat_m, num_materials, N, m, n_im) -
                          mpm_mat_mass_at(grid, d_mat_tag, d_mat_m, num_materials, N, m, n_ip)) * inv_2dx;
            float gm_y = (mpm_mat_mass_at(grid, d_mat_tag, d_mat_m, num_materials, N, m, n_jm) -
                          mpm_mat_mass_at(grid, d_mat_tag, d_mat_m, num_materials, N, m, n_jp)) * inv_2dx;
            float gm_z = (mpm_mat_mass_at(grid, d_mat_tag, d_mat_m, num_materials, N, m, n_km) -
                          mpm_mat_mass_at(grid, d_mat_tag, d_mat_m, num_materials, N, m, n_kp)) * inv_2dx;

            float gm_len = sqrtf(gm_x * gm_x + gm_y * gm_y + gm_z * gm_z);
            if (gm_len > 1.0e-20f) {
                float inv_gm = 1.0f / gm_len;
                float gh_x = gm_x * inv_gm;
                float gh_y = gm_y * inv_gm;
                float gh_z = gm_z * inv_gm;
                G_weighted_total[0] += mat_mass * gh_x;
                G_weighted_total[1] += mat_mass * gh_y;
                G_weighted_total[2] += mat_mass * gh_z;
                G_unit_sum[0] += gh_x;
                G_unit_sum[1] += gh_y;
                G_unit_sum[2] += gh_z;
            }
        }
    }

    float rest = fminf(fmaxf(restitution, 0.0f), 1.0f);

    // Thermo-mechanical impact welding bond strength (0 = unbonded Bardenhagen, 1 = fully fused v_cm):
    // Requires simultaneous genuine thermal activation (alpha_temp from homologous temperature node.t_star),
    // plastic surface film disruption (alpha_ep), and intimate multi-material nodal volume fill (weld_fill)
    // under positive compressive pressure. Cold ballistic impactors (node.t_star < 0.25) do not artificially
    // flash-weld on initial contact before genuine plastic/frictional heating raises interface temperature.
    float alpha_weld = 0.0f;
    if (enable_impact_welding && !any_fluid && node.m_solid > 0.5f * node.m &&
        (node.pressure > 0.0f || (node.t_star > 0.35f && node.plastic_strain > 0.15f))) {
        float E_rel_avail = 0.0f;
        for (int m = 0; m < num_materials; ++m) {
            size_t mn_idx = row(m);
            float mat_mass = d_mat_m[mn_idx];
            if (mat_mass > 1.0e-20f) {
                float inv_m = 1.0f / mat_mass;
                float dvx = d_mat_p[mn_idx * 3 + 0] * inv_m - v_cm[0];
                float dvy = d_mat_p[mn_idx * 3 + 1] * inv_m - v_cm[1];
                float dvz = d_mat_p[mn_idx * 3 + 2] * inv_m - v_cm[2];
                E_rel_avail += 0.5f * mat_mass * (dvx * dvx + dvy * dvy + dvz * dvz);
            }
        }
        // Only count flash kinetic energy when there is pre-existing thermal/plastic activation or oblique jetting
        float t_star_flash = (m_cm > 1.0e-20f && (node.t_star > 0.02f || node.plastic_strain > 0.01f))
            ? ((E_rel_avail / m_cm) / (400.0f * 1000.0f))
            : 0.0f;
        float t_star_eff = node.t_star + t_star_flash;
        const float alpha_temp = fminf(fmaxf((t_star_eff - 0.05f) / 0.35f, 0.0f), 1.0f);
        const float alpha_ep = fminf(fmaxf((node.plastic_strain - 0.005f) / 0.05f, 0.0f), 1.0f);
        const float weld_fill = fminf(fmaxf((phi_max1 - 0.05f) / 0.10f, 0.0f), 1.0f);
        alpha_weld = beta_contact * alpha_temp * alpha_ep * weld_fill;
    }

    float E_fric_node = 0.0f;

    for (int m = 0; m < num_materials; ++m) {
        size_t mn_idx = row(m);
        float mat_mass = d_mat_m[mn_idx];
        if (mat_mass <= 1.0e-20f) {
            d_mat_v[mn_idx * 3 + 0] = 0.0f;
            d_mat_v[mn_idx * 3 + 1] = 0.0f;
            d_mat_v[mn_idx * 3 + 2] = 0.0f;
            if (d_mat_dv) {
                d_mat_dv[mn_idx * 3 + 0] = 0.0f;
                d_mat_dv[mn_idx * 3 + 1] = 0.0f;
                d_mat_dv[mn_idx * 3 + 2] = 0.0f;
            }
            continue;
        }

        // Fluid/gas interfaces experience zero Coulomb friction along boundaries
        float eff_friction = any_fluid ? 0.0f : friction;

        float inv_m = 1.0f / mat_mass;
        float v_star[3] = {d_mat_p[mn_idx * 3 + 0] * inv_m,
                           d_mat_p[mn_idx * 3 + 1] * inv_m,
                           d_mat_p[mn_idx * 3 + 2] * inv_m};

        float v_corr[3] = {v_star[0], v_star[1], v_star[2]};

        float gm_x = (mpm_mat_mass_at(grid, d_mat_tag, d_mat_m, num_materials, N, m, n_im) -
                      mpm_mat_mass_at(grid, d_mat_tag, d_mat_m, num_materials, N, m, n_ip)) * inv_2dx;
        float gm_y = (mpm_mat_mass_at(grid, d_mat_tag, d_mat_m, num_materials, N, m, n_jm) -
                      mpm_mat_mass_at(grid, d_mat_tag, d_mat_m, num_materials, N, m, n_jp)) * inv_2dx;
        float gm_z = (mpm_mat_mass_at(grid, d_mat_tag, d_mat_m, num_materials, N, m, n_km) -
                      mpm_mat_mass_at(grid, d_mat_tag, d_mat_m, num_materials, N, m, n_kp)) * inv_2dx;

        float gm_len = sqrtf(gm_x * gm_x + gm_y * gm_y + gm_z * gm_z);
        float inv_gm = (gm_len > 1.0e-20f) ? (1.0f / gm_len) : 0.0f;
        float g_hat[3] = {
            gm_x * inv_gm,
            gm_y * inv_gm,
            gm_z * inv_gm
        };
        float m_other = m_cm - mat_mass;
        float G_m[3];
        if (m_other > 1.0e-20f) {
            float inv_m_other = 1.0f / m_other;
            G_m[0] = g_hat[0] - (G_weighted_total[0] - mat_mass * g_hat[0]) * inv_m_other;
            G_m[1] = g_hat[1] - (G_weighted_total[1] - mat_mass * g_hat[1]) * inv_m_other;
            G_m[2] = g_hat[2] - (G_weighted_total[2] - mat_mass * g_hat[2]) * inv_m_other;
        } else {
            float inv_other = 1.0f / static_cast<float>(sig_count - 1);
            float factor_self = static_cast<float>(sig_count) * inv_other;
            G_m[0] = factor_self * g_hat[0] - inv_other * G_unit_sum[0];
            G_m[1] = factor_self * g_hat[1] - inv_other * G_unit_sum[1];
            G_m[2] = factor_self * g_hat[2] - inv_other * G_unit_sum[2];
        }
        float glen = sqrtf(G_m[0] * G_m[0] + G_m[1] * G_m[1] + G_m[2] * G_m[2]);

        if (glen > 1.0e-4f) {
            float inv_g = 1.0f / glen;
            float n[3] = {G_m[0] * inv_g, G_m[1] * inv_g, G_m[2] * inv_g};

            float v_rel[3] = {v_star[0] - v_cm[0], v_star[1] - v_cm[1], v_star[2] - v_cm[2]};
            float v_approach = v_rel[0] * n[0] + v_rel[1] * n[1] + v_rel[2] * n[2];

            if (v_approach > 0.0f && beta_contact > 0.0f) {
                float v_cm_n = v_cm[0] * n[0] + v_cm[1] * n[1] + v_cm[2] * n[2];
                float eff_rest = rest * (1.0f - alpha_weld);
                float v_norm = v_cm_n - eff_rest * v_approach;

                float v_star_n = v_star[0] * n[0] + v_star[1] * n[1] + v_star[2] * n[2];
                float v_tang[3] = {v_star[0] - v_star_n * n[0],
                                   v_star[1] - v_star_n * n[1],
                                   v_star[2] - v_star_n * n[2]};
                float v_cm_tang[3] = {v_cm[0] - v_cm_n * n[0],
                                      v_cm[1] - v_cm_n * n[1],
                                      v_cm[2] - v_cm_n * n[2]};

                float v_slip[3] = {v_tang[0] - v_cm_tang[0],
                                   v_tang[1] - v_cm_tang[1],
                                   v_tang[2] - v_cm_tang[2]};
                float slip_speed = sqrtf(v_slip[0] * v_slip[0] + v_slip[1] * v_slip[1] + v_slip[2] * v_slip[2]);

                float max_friction_dv = eff_friction * v_approach;
                float v_tang_corr[3];
                if (slip_speed <= max_friction_dv || slip_speed < 1.0e-7f) {
                    v_tang_corr[0] = v_cm_tang[0];
                    v_tang_corr[1] = v_cm_tang[1];
                    v_tang_corr[2] = v_cm_tang[2];
                } else {
                    float factor = (eff_friction > 0.0f) ? (1.0f - max_friction_dv / slip_speed) : 1.0f;
                    v_tang_corr[0] = v_cm_tang[0] + factor * v_slip[0];
                    v_tang_corr[1] = v_cm_tang[1] + factor * v_slip[1];
                    v_tang_corr[2] = v_cm_tang[2] + factor * v_slip[2];
                }

                if (alpha_weld > 0.0f) {
                    v_tang_corr[0] = (1.0f - alpha_weld) * v_tang_corr[0] + alpha_weld * v_cm_tang[0];
                    v_tang_corr[1] = (1.0f - alpha_weld) * v_tang_corr[1] + alpha_weld * v_cm_tang[1];
                    v_tang_corr[2] = (1.0f - alpha_weld) * v_tang_corr[2] + alpha_weld * v_cm_tang[2];
                }

                float v_bard[3] = {v_norm * n[0] + v_tang_corr[0],
                                   v_norm * n[1] + v_tang_corr[1],
                                   v_norm * n[2] + v_tang_corr[2]};
                v_corr[0] = v_star[0] + beta_contact * (v_bard[0] - v_star[0]);
                v_corr[1] = v_star[1] + beta_contact * (v_bard[1] - v_star[1]);
                v_corr[2] = v_star[2] + beta_contact * (v_bard[2] - v_star[2]);
            }
            if (alpha_weld > 0.0f) {
                v_corr[0] += alpha_weld * (v_cm[0] - v_corr[0]);
                v_corr[1] += alpha_weld * (v_cm[1] - v_corr[1]);
                v_corr[2] += alpha_weld * (v_cm[2] - v_corr[2]);
            }
        } else {
            if (beta_contact > 0.0f) {
                // Degenerate surface normal: materials are co-located in cell.
                // Move together at center of mass velocity to conserve total momentum
                v_corr[0] = v_star[0] + beta_contact * (v_cm[0] - v_star[0]);
                v_corr[1] = v_star[1] + beta_contact * (v_cm[1] - v_star[1]);
                v_corr[2] = v_star[2] + beta_contact * (v_cm[2] - v_star[2]);
            }
            if (alpha_weld > 0.0f) {
                v_corr[0] += alpha_weld * (v_cm[0] - v_corr[0]);
                v_corr[1] += alpha_weld * (v_cm[1] - v_corr[1]);
                v_corr[2] += alpha_weld * (v_cm[2] - v_corr[2]);
            }
        }

        if (enable_frictional_heating) {
            float v_rel_before_sq = (v_star[0] - v_cm[0]) * (v_star[0] - v_cm[0]) +
                                    (v_star[1] - v_cm[1]) * (v_star[1] - v_cm[1]) +
                                    (v_star[2] - v_cm[2]) * (v_star[2] - v_cm[2]);
            float v_rel_after_sq = (v_corr[0] - v_cm[0]) * (v_corr[0] - v_cm[0]) +
                                   (v_corr[1] - v_cm[1]) * (v_corr[1] - v_cm[1]) +
                                   (v_corr[2] - v_cm[2]) * (v_corr[2] - v_cm[2]);
            if (v_rel_before_sq > v_rel_after_sq) {
                E_fric_node += 0.5f * mat_mass * (v_rel_before_sq - v_rel_after_sq);
            }
        }

        applyBC(v_corr[0], v_corr[1], v_corr[2]);

        d_mat_v[mn_idx * 3 + 0] = v_corr[0];
        d_mat_v[mn_idx * 3 + 1] = v_corr[1];
        d_mat_v[mn_idx * 3 + 2] = v_corr[2];
        if (d_mat_dv) {
            d_mat_dv[mn_idx * 3 + 0] = v_corr[0] - d_mat_dv[mn_idx * 3 + 0];
            d_mat_dv[mn_idx * 3 + 1] = v_corr[1] - d_mat_dv[mn_idx * 3 + 1];
            d_mat_dv[mn_idx * 3 + 2] = v_corr[2] - d_mat_dv[mn_idx * 3 + 2];
        }
    }

    if (enable_frictional_heating && E_fric_node > 0.0f && node.m > 1.0e-20f) {
        node.q_fric = E_fric_node / node.m;
    }

    float p0 = p_cm[0], p1 = p_cm[1], p2 = p_cm[2];
    applyBC(p0, p1, p2);
    node.p[0] = p0;
    node.p[1] = p1;
    node.p[2] = p2;
}

__global__ void kernel_smooth_plastic_strain_3d(const MPMGridNode3D* grid_in, float* plastic_strain_out, int nx, int ny, int nz, const int* active_nodes, int num_active) {
    int idx;
    if (active_nodes && num_active > 0) {
        int t_idx = blockIdx.x * blockDim.x + threadIdx.x;
        if (t_idx >= num_active) return;
        idx = active_nodes[t_idx];
    } else {
        idx = blockIdx.x * blockDim.x + threadIdx.x;
        if (idx >= nx * ny * nz) return;
    }

    plastic_strain_out[idx] = grid_in[idx].plastic_strain;
    if (grid_in[idx].m_solid <= 1.0e-20f || grid_in[idx].plastic_strain <= 0.0f) return;

    int k = idx % nz;
    int j = (idx / nz) % ny;
    int i = idx / (ny * nz);

    float sum_ep = 2.0f * grid_in[idx].plastic_strain;
    float weight_sum = 2.0f;

    for (int di = -1; di <= 1; ++di) {
        for (int dj = -1; dj <= 1; ++dj) {
            for (int dk = -1; dk <= 1; ++dk) {
                if (di == 0 && dj == 0 && dk == 0) continue;
                int ni = i + di; int nj = j + dj; int nk = k + dk;
                if (ni >= 0 && ni < nx && nj >= 0 && nj < ny && nk >= 0 && nk < nz) {
                    size_t n_idx = (static_cast<size_t>(ni) * ny + nj) * nz + nk;
                    if (grid_in[n_idx].m_solid > 1.0e-20f) {
                        float w = 1.0f / static_cast<float>(abs(di) + abs(dj) + abs(dk));
                        sum_ep += w * grid_in[n_idx].plastic_strain;
                        weight_sum += w;
                    }
                }
            }
        }
    }
    plastic_strain_out[idx] = sum_ep / weight_sum;
}

__global__ void kernel_copy_smoothed_plastic_strain_3d(MPMGridNode3D* grid_in, const float* plastic_strain_out, int num_nodes, const int* active_nodes, int num_active) {
    int idx;
    if (active_nodes && num_active > 0) {
        int t_idx = blockIdx.x * blockDim.x + threadIdx.x;
        if (t_idx >= num_active) return;
        idx = active_nodes[t_idx];
    } else {
        idx = blockIdx.x * blockDim.x + threadIdx.x;
        if (idx >= num_nodes) return;
    }
    if (grid_in[idx].m_solid > 1.0e-20f) {
        grid_in[idx].plastic_strain = plastic_strain_out[idx];
    }
}

__global__ void kernel_thermal_conduction_3d(MPMGridNode3D* grid, int nx, int ny, int nz, float dx, float dy, float dz, float dt, const int* active_nodes, int num_active) {
    (void)dx; (void)dy; (void)dz; (void)dt;
    int idx;
    if (active_nodes && num_active > 0) {
        int t_idx = blockIdx.x * blockDim.x + threadIdx.x;
        if (t_idx >= num_active) return;
        idx = active_nodes[t_idx];
    } else {
        idx = blockIdx.x * blockDim.x + threadIdx.x;
        if (idx >= nx * ny * nz) return;
    }

    MPMGridNode3D& node = grid[idx];
    node.dT_cond = 0.0f;
    if (node.m <= 1.0e-20f) return;

    int k = idx % nz;
    int j = (idx / nz) % ny;
    int i = idx / (ny * nz);

    constexpr float Fo_step = 0.05f;
    const float T_i = node.temperature;
    const float m_i = node.m;
    float flux_sum = 0.0f;
    const int di[6] = {-1, 1, 0, 0, 0, 0};
    const int dj[6] = {0, 0, -1, 1, 0, 0};
    const int dk[6] = {0, 0, 0, 0, -1, 1};
    for (int d = 0; d < 6; ++d) {
        int ni = i + di[d];
        int nj = j + dj[d];
        int nk = k + dk[d];
        if (ni >= 0 && ni < nx && nj >= 0 && nj < ny && nk >= 0 && nk < nz) {
            size_t n_idx = (static_cast<size_t>(ni) * ny + nj) * nz + nk;
            const MPMGridNode3D& nb = grid[n_idx];
            if (nb.m > 1.0e-20f) {
                float m_harm = (2.0f * m_i * nb.m) / (m_i + nb.m);
                flux_sum += m_harm * (nb.temperature - T_i);
            }
        }
    }
    node.dT_cond = (Fo_step / m_i) * flux_sum;
}

// Forward declaration of constitutive stress update
__device__ inline void update_particle_stress_constitutive(int p_idx, float dt, const float L[3][3], MPMParticle3DSoA soa, const MaterialTable3D& mat, float ep_smoothed = 0.0f, bool enable_impact_welding = false);

// Device helper: integrate particle position and enforce domain boundary conditions
__device__ inline void integrate_particle_position_and_bc(
    int p_idx, float dt, float final_vx, float final_vy, float final_vz,
    MPMParticle3DSoA soa, int nx, int ny, int nz,
    float dx, float dy, float dz, float xmin, float ymin, float zmin,
    int bc_x_min, int bc_x_max, int bc_y_min, int bc_y_max, int bc_z_min, int bc_z_max,
    bool is_fluid = false,
    bool is_energetic = false,
    const Blast::ZonalHandoff3DParams& zonal_params = {},
    int* d_boundary_flags = nullptr) {

    float new_x = soa.x[0][p_idx] + dt * final_vx;
    float new_y = soa.x[1][p_idx] + dt * final_vy;
    float new_z = soa.x[2][p_idx] + dt * final_vz;

    if (zonal_params.enabled && (is_fluid || is_energetic)) {
        float dx_rel = new_x - static_cast<float>(zonal_params.center_x);
        float dy_rel = new_y - static_cast<float>(zonal_params.center_y);
        float dz_rel = new_z - static_cast<float>(zonal_params.center_z);
        float r = zonal_params.is_cylinder ? sqrtf(dx_rel * dx_rel + dy_rel * dy_rel)
                                           : sqrtf(dx_rel * dx_rel + dy_rel * dy_rel + dz_rel * dz_rel);
        float R_sleeve = static_cast<float>(zonal_params.sleeve_radius);
        float eff_clip_z_min = fmaxf(static_cast<float>(zonal_params.clip_z_min), zmin);
        float eff_clip_z_max = fminf(static_cast<float>(zonal_params.clip_z_max), zmin + static_cast<float>(nz) * dz);
        bool out_of_z = (new_z <= eff_clip_z_min || new_z >= eff_clip_z_max);
        if (r >= R_sleeve || out_of_z) {
            if (d_boundary_flags) d_boundary_flags[1] = 1;
            if (soa.state) soa.state[p_idx] = 2; // STATE_TERMINATED / Clean absorption into Eulerian domain
            soa.m[p_idx] = 0.0f;
            soa.v[0][p_idx] = 0.0f; soa.v[1][p_idx] = 0.0f; soa.v[2][p_idx] = 0.0f;
            for (int r_i = 0; r_i < 3; ++r_i) {
                for (int c_i = 0; c_i < 3; ++c_i) {
                    soa.B[r_i][c_i][p_idx] = 0.0f;
                }
            }
            for (int k_i = 0; k_i < 6; ++k_i) {
                soa.sigma_voigt[k_i][p_idx] = 0.0f;
            }
            return;
        }
    }

    float min_x = xmin;
    float max_x = xmin + static_cast<float>(nx) * dx;
    float min_y = ymin;
    float max_y = ymin + static_cast<float>(ny) * dy;
    float min_z = zmin;
    float max_z = zmin + static_cast<float>(nz) * dz;

    // Detect if particle hits a Terminate boundary (bc == 3), which terminates the entire simulation
    bool hit_terminate_bc = ((new_x < min_x && bc_x_min == 3) || (new_x > max_x && bc_x_max == 3) ||
                             (new_y < min_y && bc_y_min == 3) || (new_y > max_y && bc_y_max == 3) ||
                             (new_z < min_z && bc_z_min == 3) || (new_z > max_z && bc_z_max == 3));
    if (hit_terminate_bc && d_boundary_flags) {
        d_boundary_flags[0] = 1;
    }

    // Detect if particle passes out of the domain under Terminate (3), LysmerDashpot (4), or Transmitting (5) boundary,
    // or escapes far beyond the grid envelope
    bool passed_out = hit_terminate_bc ||
                      ((new_x < min_x && (bc_x_min == 4 || bc_x_min == 5)) || (new_x > max_x && (bc_x_max == 4 || bc_x_max == 5)) ||
                       (new_y < min_y && (bc_y_min == 4 || bc_y_min == 5)) || (new_y > max_y && (bc_y_max == 4 || bc_y_max == 5)) ||
                       (new_z < min_z && (bc_z_min == 4 || bc_z_min == 5)) || (new_z > max_z && (bc_z_max == 4 || bc_z_max == 5))) ||
                      (new_x < min_x - 2.0f * dx || new_x > max_x + 2.0f * dx ||
                       new_y < min_y - 2.0f * dy || new_y > max_y + 2.0f * dy ||
                       new_z < min_z - 2.0f * dz || new_z > max_z + 2.0f * dz);

    if (passed_out) {
        if (d_boundary_flags) d_boundary_flags[1] = 1;
        if (soa.state) soa.state[p_idx] = 2; // STATE_TERMINATED / Passed out of domain
        soa.m[p_idx] = 0.0f;
        soa.v[0][p_idx] = 0.0f; soa.v[1][p_idx] = 0.0f; soa.v[2][p_idx] = 0.0f;
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                soa.B[r][c][p_idx] = 0.0f;
            }
        }
        for (int k = 0; k < 6; ++k) {
            soa.sigma_voigt[k][p_idx] = 0.0f;
        }
        return;
    }

    if (new_x < min_x) {
        if (bc_x_min == 2) {
            new_x = 2.0f * min_x - new_x;
            if (new_x < min_x) new_x = min_x;
            final_vx = fabsf(final_vx);
            soa.v[0][p_idx] = final_vx;
        } else {
            new_x = min_x;
            if (final_vx < 0.0f) final_vx = 0.0f;
            soa.v[0][p_idx] = 0.0f;
        }
    } else if (new_x > max_x) {
        if (bc_x_max == 2) {
            new_x = 2.0f * max_x - new_x;
            if (new_x > max_x) new_x = max_x;
            final_vx = -fabsf(final_vx);
            soa.v[0][p_idx] = final_vx;
        } else {
            new_x = max_x;
            if (final_vx > 0.0f) final_vx = 0.0f;
            soa.v[0][p_idx] = 0.0f;
        }
    }

    if (new_y < min_y) {
        if (bc_y_min == 2) {
            new_y = 2.0f * min_y - new_y;
            if (new_y < min_y) new_y = min_y;
            final_vy = fabsf(final_vy);
            soa.v[1][p_idx] = final_vy;
        } else {
            new_y = min_y;
            if (final_vy < 0.0f) final_vy = 0.0f;
            soa.v[1][p_idx] = 0.0f;
        }
    } else if (new_y > max_y) {
        if (bc_y_max == 2) {
            new_y = 2.0f * max_y - new_y;
            if (new_y > max_y) new_y = max_y;
            final_vy = -fabsf(final_vy);
            soa.v[1][p_idx] = final_vy;
        } else {
            new_y = max_y;
            if (final_vy > 0.0f) final_vy = 0.0f;
            soa.v[1][p_idx] = 0.0f;
        }
    }

    if (new_z < min_z) {
        if (bc_z_min == 2) {
            new_z = 2.0f * min_z - new_z;
            if (new_z < min_z) new_z = min_z;
            final_vz = fabsf(final_vz);
            soa.v[2][p_idx] = final_vz;
        } else {
            new_z = min_z;
            if (final_vz < 0.0f) final_vz = 0.0f;
            soa.v[2][p_idx] = 0.0f;
        }
    } else if (new_z > max_z) {
        if (bc_z_max == 2) {
            new_z = 2.0f * max_z - new_z;
            if (new_z > max_z) new_z = max_z;
            final_vz = -fabsf(final_vz);
            soa.v[2][p_idx] = final_vz;
        } else {
            new_z = max_z;
            if (final_vz > 0.0f) final_vz = 0.0f;
            soa.v[2][p_idx] = 0.0f;
        }
    }

    soa.x[0][p_idx] = new_x;
    soa.x[1][p_idx] = new_y;
    soa.x[2][p_idx] = new_z;
}

// Unified G2P Device Implementation (FUSE_STRESS = true: eliminates L_grad global memory round-trip)
template <bool FUSE_STRESS>
__device__ inline void g2p_device_impl(MPMParticle3DSoA soa, int num_particles,
                                       MPMGridNode3D* grid, int nx, int ny, int nz,
                                       float dx, float dy, float dz, float dt, int transfer_scheme,
                                       int velocity_scheme, float flip_blend,
                                       float xmin, float ymin, float zmin,
                                       int bc_x_min, int bc_x_max,
                                       int bc_y_min, int bc_y_max,
                                       int bc_z_min, int bc_z_max,
                                       const MaterialTable3D* d_mat_tables,
                                       const float* d_mat_grid_m = nullptr,
                                       const float* d_mat_grid_v = nullptr,
                                       const float* d_mat_grid_dv = nullptr,
                                       int num_materials = 1,
                                       Blast::ZonalHandoff3DParams zonal_params = {},
                                       int* d_boundary_flags = nullptr,
                                       const int* d_mat_tag = nullptr,
                                       bool enable_frictional_heating = false,
                                       bool enable_thermal_conduction = false,
                                       bool enable_impact_welding = false) {
    int p_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (p_idx >= num_particles) return;

    if ((soa.state && soa.state[p_idx] == 2) || soa.m[p_idx] <= 0.0f) return;

    size_t num_nodes_total = static_cast<size_t>(nx) * ny * nz;
    int p_mat = (soa.material_id && num_materials > 0) ? min(max(soa.material_id[p_idx], 0), num_materials - 1) : 0;
    bool is_multi_mat = (d_mat_grid_m != nullptr && d_mat_grid_v != nullptr);

    int obj_id = soa.object_id[p_idx];
    const MaterialTable3D& mat = d_mat_tables[obj_id];
    bool has_failed_p = (soa.has_failed[p_idx] != 0);
    bool is_melted = (mat.T_melt > mat.T_room && soa.temperature && soa.temperature[p_idx] >= mat.T_melt);
    bool is_energetic_p = (mat.material_model == MPMMaterialModel::CRESTReactiveBurn) ||
                          (mat.material_model == MPMMaterialModel::JWLProgrammedBurn) ||
                          (mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);
    bool is_fluid_water = (mat.material_model == MPMMaterialModel::TaitWater);
    bool is_fluid_p = is_melted || (soa.lambda && soa.lambda[p_idx] >= 0.1f) ||
                      is_energetic_p || is_fluid_water;

    int eff_transfer_scheme = (mat.transfer_scheme >= 0) ? mat.transfer_scheme : transfer_scheme;

    float px = soa.x[0][p_idx] - xmin;
    float py = soa.x[1][p_idx] - ymin;
    float pz = soa.x[2][p_idx] - zmin;

    float lp_0 = soa.lp[0][p_idx];
    float lp_1 = soa.lp[1][p_idx];
    float lp_2 = soa.lp[2][p_idx];

    int base_i = static_cast<int>(floorf(px / dx));
    int base_j = static_cast<int>(floorf(py / dy));
    int base_k = static_cast<int>(floorf(pz / dz));

    float v_prev_x = soa.v[0][p_idx];
    float v_prev_y = soa.v[1][p_idx];
    float v_prev_z = soa.v[2][p_idx];

    float v_pic_x = 0.0f; float v_pic_y = 0.0f; float v_pic_z = 0.0f;
    float v_grad_x = 0.0f; float v_grad_y = 0.0f; float v_grad_z = 0.0f;
    float delta_v_grid_x = 0.0f; float delta_v_grid_y = 0.0f; float delta_v_grid_z = 0.0f;
    float weight_sum = 0.0f;
    float weight_grad_sum = 0.0f;
    float contact_weight_sum = 0.0f;
    float ep_grid = 0.0f;
    float q_fric_grid = 0.0f;
    float t_interp_grid = 0.0f;
    float dt_cond_grid = 0.0f;

    // APIC B_p & L_grad computation setup (bounded by physical asymptotic velocity limit 25000 m/s)
    float max_B = 25000.0f / fminf(fminf(dx, dy), dz);
    float B_new[3][3] = {{0,0,0},{0,0,0},{0,0,0}};
    float L_new[3][3] = {{0,0,0},{0,0,0},{0,0,0}};
    float A_mat[3][3] = {{0,0,0},{0,0,0},{0,0,0}};
    float sum_wd_x = 0.0f, sum_wd_y = 0.0f, sum_wd_z = 0.0f;
    float sum_wxx = 0.0f, sum_wxy = 0.0f, sum_wxz = 0.0f;
    float sum_wyy = 0.0f, sum_wyz = 0.0f, sum_wzz = 0.0f;
    float sum_b_grad_x = 0.0f, sum_b_grad_y = 0.0f, sum_b_grad_z = 0.0f;
    float sum_l_grad_x = 0.0f, sum_l_grad_y = 0.0f, sum_l_grad_z = 0.0f;
    bool truncated_open_bc = false;

    if (eff_transfer_scheme == 3) {
        // Radial Moving Least Squares MPM (Wendland C2 radial kernel with Centroid-Centered Linear Completeness)
        float R_supp = 2.0f * fmaxf(fmaxf(dx, dy), dz);

        // Pass 1: Local partition of unity sum, centroid displacement, and 2nd-moment tensor via Parallel-Axis Theorem
        float local_w_sum = 0.0f;
        float sum_wx = 0.0f, sum_wy = 0.0f, sum_wz = 0.0f;
        float r_wxx = 0.0f, r_wxy = 0.0f, r_wxz = 0.0f;
        float r_wyy = 0.0f, r_wyz = 0.0f, r_wzz = 0.0f;

        for (int offset_i = -2; offset_i <= 2; ++offset_i) {
            int raw_i = base_i + offset_i;
            int i = raw_i;
            float sign_x = 1.0f;
            if (!resolve_ghost_node_3d(i, sign_x, nx, bc_x_min, bc_x_max)) { truncated_open_bc = true; continue; }
            float node_x = (static_cast<float>(raw_i) + 0.5f) * dx;

            for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                int raw_j = base_j + offset_j;
                int j = raw_j;
                float sign_y = 1.0f;
                if (!resolve_ghost_node_3d(j, sign_y, ny, bc_y_min, bc_y_max)) { truncated_open_bc = true; continue; }
                float node_y = (static_cast<float>(raw_j) + 0.5f) * dy;

                for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                    int raw_k = base_k + offset_k;
                    int k = raw_k;
                    float sign_z = 1.0f;
                    if (!resolve_ghost_node_3d(k, sign_z, nz, bc_z_min, bc_z_max)) { truncated_open_bc = true; continue; }
                    float node_z = (static_cast<float>(raw_k) + 0.5f) * dz;

                    float dist_x = node_x - px;
                    float dist_y = node_y - py;
                    float dist_z = node_z - pz;
                    float r = sqrtf(dist_x * dist_x + dist_y * dist_y + dist_z * dist_z);
                    if (r >= R_supp) continue;

                    float w = evalWendland_C2_dev(r, R_supp);
                    if (w < 1.0e-7f) continue;

                    local_w_sum += w;
                    sum_wx += w * dist_x;
                    sum_wy += w * dist_y;
                    sum_wz += w * dist_z;

                    r_wxx += w * dist_x * dist_x;
                    r_wxy += w * dist_x * dist_y;
                    r_wxz += w * dist_x * dist_z;
                    r_wyy += w * dist_y * dist_y;
                    r_wyz += w * dist_y * dist_z;
                    r_wzz += w * dist_z * dist_z;
                }
            }
        }

        if (local_w_sum > 1.0e-7f) {
            float inv_w_sum = 1.0f / local_w_sum;
            float delta_x = sum_wx * inv_w_sum;
            float delta_y = sum_wy * inv_w_sum;
            float delta_z = sum_wz * inv_w_sum;
            float xc = px + delta_x;
            float yc = py + delta_y;
            float zc = pz + delta_z;

            // Parallel-Axis Moment Tensor: D = sum(w * (x - xc)(x - xc)^T) / w_sum
            //                                = sum(w * (x - p)(x - p)^T) / w_sum - delta * delta^T
            float D[3][3];
            D[0][0] = r_wxx * inv_w_sum - delta_x * delta_x;
            D[0][1] = r_wxy * inv_w_sum - delta_x * delta_y;
            D[0][2] = r_wxz * inv_w_sum - delta_x * delta_z;
            D[1][0] = D[0][1];
            D[1][1] = r_wyy * inv_w_sum - delta_y * delta_y;
            D[1][2] = r_wyz * inv_w_sum - delta_y * delta_z;
            D[2][0] = D[0][2];
            D[2][1] = D[1][2];
            D[2][2] = r_wzz * inv_w_sum - delta_z * delta_z;

            float h2 = (dx * dx + dy * dy + dz * dz) / 3.0f;
            float inv_h2 = 1.0f / fmaxf(h2, 1.0e-16f);
            float D00 = D[0][0] * inv_h2, D01 = D[0][1] * inv_h2, D02 = D[0][2] * inv_h2;
            float D11 = D[1][1] * inv_h2, D12 = D[1][2] * inv_h2, D22 = D[2][2] * inv_h2;

            float D_inv[3][3];
            float det_norm = D00 * (D11 * D22 - D12 * D12) -
                             D01 * (D01 * D22 - D12 * D02) +
                             D02 * (D01 * D12 - D11 * D02);

            if (det_norm > 1.0e-5f) {
                float inv_det = inv_h2 / det_norm;
                D_inv[0][0] =  (D11 * D22 - D12 * D12) * inv_det;
                D_inv[0][1] = -(D01 * D22 - D12 * D02) * inv_det;
                D_inv[0][2] =  (D01 * D12 - D11 * D02) * inv_det;
                D_inv[1][0] = D_inv[0][1];
                D_inv[1][1] =  (D00 * D22 - D02 * D02) * inv_det;
                D_inv[1][2] = -(D00 * D12 - D01 * D02) * inv_det;
                D_inv[2][0] = D_inv[0][2];
                D_inv[2][1] = D_inv[1][2];
                D_inv[2][2] =  (D00 * D11 - D01 * D01) * inv_det;
            } else {
                float d_iso = 5.5f * inv_h2;
                D_inv[0][0] = d_iso; D_inv[0][1] = 0.0f;  D_inv[0][2] = 0.0f;
                D_inv[1][0] = 0.0f;  D_inv[1][1] = d_iso; D_inv[1][2] = 0.0f;
                D_inv[2][0] = 0.0f;  D_inv[2][1] = 0.0f;  D_inv[2][2] = d_iso;
            }

            for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                int raw_i = base_i + offset_i;
                int i = raw_i;
                float sign_x = 1.0f;
                if (!resolve_ghost_node_3d(i, sign_x, nx, bc_x_min, bc_x_max)) continue;
                float node_x = (static_cast<float>(raw_i) + 0.5f) * dx;

                for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                    int raw_j = base_j + offset_j;
                    int j = raw_j;
                    float sign_y = 1.0f;
                    if (!resolve_ghost_node_3d(j, sign_y, ny, bc_y_min, bc_y_max)) continue;
                    float node_y = (static_cast<float>(raw_j) + 0.5f) * dy;

                    for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                        int raw_k = base_k + offset_k;
                        int k = raw_k;
                        float sign_z = 1.0f;
                        if (!resolve_ghost_node_3d(k, sign_z, nz, bc_z_min, bc_z_max)) continue;
                        float node_z = (static_cast<float>(raw_k) + 0.5f) * dz;

                        float dist_x = node_x - px;
                        float dist_y = node_y - py;
                        float dist_z = node_z - pz;
                        float r = sqrtf(dist_x * dist_x + dist_y * dist_y + dist_z * dist_z);
                        if (r >= R_supp) continue;

                        float w = evalWendland_C2_dev(r, R_supp);
                        if (w < 1.0e-7f) continue;

                        float weight = w * inv_w_sum;

                        size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                        const MPMGridNode3D& node = grid[node_idx];

                        if (is_multi_mat) {
                            float n_vx = 0.0f, n_vy = 0.0f, n_vz = 0.0f;
                            float delta_vx = 0.0f, delta_vy = 0.0f, delta_vz = 0.0f;
                            float mat_m = mpm_mat_node_kinematics(grid, d_mat_tag, d_mat_grid_m, d_mat_grid_v, d_mat_grid_dv, num_materials, num_nodes_total, p_mat, node_idx, v_prev_x, v_prev_y, v_prev_z, n_vx, n_vy, n_vz, delta_vx, delta_vy, delta_vz);
                            if (mat_m > 1.0e-20f) {
                                float eff_vx = sign_x * n_vx;
                                float eff_vy = sign_y * n_vy;
                                float eff_vz = sign_z * n_vz;
                                float eff_dvx = sign_x * delta_vx;
                                float eff_dvy = sign_y * delta_vy;
                                float eff_dvz = sign_z * delta_vz;

                                bool is_contact_node = ((node.m - mat_m) > 1.0e-5f * node.m);
                                float w_sym = 1.0f;
                                float w_grad = 1.0f;

                                v_pic_x += weight * eff_vx;
                                v_pic_y += weight * eff_vy;
                                v_pic_z += weight * eff_vz;

                                v_grad_x += (weight * w_grad) * eff_vx;
                                v_grad_y += (weight * w_grad) * eff_vy;
                                v_grad_z += (weight * w_grad) * eff_vz;

                                delta_v_grid_x += weight * eff_dvx;
                                delta_v_grid_y += weight * eff_dvy;
                                delta_v_grid_z += weight * eff_dvz;

                                weight_sum += weight;
                                weight_grad_sum += weight * w_grad;
                                if (!is_contact_node && node.m_solid > 1.0e-20f) {
                                    ep_grid += weight * node.plastic_strain;
                                } else if (is_contact_node && soa.ep_bar) {
                                    ep_grid += weight * soa.ep_bar[p_idx];
                                }
                                q_fric_grid += (weight * w_sym) * node.q_fric;
                                t_interp_grid += weight * node.temperature;
                                dt_cond_grid += weight * node.dT_cond;

                                float dc_x = node_x - xc;
                                float dc_y = node_y - yc;
                                float dc_z = node_z - zc;

                                float d_dinv_x = D_inv[0][0] * dc_x + D_inv[0][1] * dc_y + D_inv[0][2] * dc_z;
                                float d_dinv_y = D_inv[1][0] * dc_x + D_inv[1][1] * dc_y + D_inv[1][2] * dc_z;
                                float d_dinv_z = D_inv[2][0] * dc_x + D_inv[2][1] * dc_y + D_inv[2][2] * dc_z;

                                sum_wd_x += weight * dist_x;
                                sum_wd_y += weight * dist_y;
                                sum_wd_z += weight * dist_z;
                                sum_wxx += weight * dist_x * dist_x;
                                sum_wxy += weight * dist_x * dist_y;
                                sum_wxz += weight * dist_x * dist_z;
                                sum_wyy += weight * dist_y * dist_y;
                                sum_wyz += weight * dist_y * dist_z;
                                sum_wzz += weight * dist_z * dist_z;
                                sum_b_grad_x += w_grad * weight * d_dinv_x;
                                sum_b_grad_y += w_grad * weight * d_dinv_y;
                                sum_b_grad_z += w_grad * weight * d_dinv_z;
                                sum_l_grad_x += w_grad * weight * d_dinv_x;
                                sum_l_grad_y += w_grad * weight * d_dinv_y;
                                sum_l_grad_z += w_grad * weight * d_dinv_z;

                                float rel_vx = w_grad * (eff_vx - v_prev_x);
                                float rel_vy = w_grad * (eff_vy - v_prev_y);
                                float rel_vz = w_grad * (eff_vz - v_prev_z);

                                A_mat[0][0] += weight * rel_vx * dist_x;
                                A_mat[0][1] += weight * rel_vx * dist_y;
                                A_mat[0][2] += weight * rel_vx * dist_z;

                                A_mat[1][0] += weight * rel_vy * dist_x;
                                A_mat[1][1] += weight * rel_vy * dist_y;
                                A_mat[1][2] += weight * rel_vy * dist_z;

                                A_mat[2][0] += weight * rel_vz * dist_x;
                                A_mat[2][1] += weight * rel_vz * dist_y;
                                A_mat[2][2] += weight * rel_vz * dist_z;

                                B_new[0][0] += weight * rel_vx * d_dinv_x;
                                B_new[0][1] += weight * rel_vx * d_dinv_y;
                                B_new[0][2] += weight * rel_vx * d_dinv_z;

                                B_new[1][0] += weight * rel_vy * d_dinv_x;
                                B_new[1][1] += weight * rel_vy * d_dinv_y;
                                B_new[1][2] += weight * rel_vy * d_dinv_z;

                                B_new[2][0] += weight * rel_vz * d_dinv_x;
                                B_new[2][1] += weight * rel_vz * d_dinv_y;
                                B_new[2][2] += weight * rel_vz * d_dinv_z;

                                L_new[0][0] += rel_vx * weight * d_dinv_x;
                                L_new[0][1] += rel_vx * weight * d_dinv_y;
                                L_new[0][2] += rel_vx * weight * d_dinv_z;

                                L_new[1][0] += rel_vy * weight * d_dinv_x;
                                L_new[1][1] += rel_vy * weight * d_dinv_y;
                                L_new[1][2] += rel_vy * weight * d_dinv_z;

                                L_new[2][0] += rel_vz * weight * d_dinv_x;
                                L_new[2][1] += rel_vz * weight * d_dinv_y;
                                L_new[2][2] += rel_vz * weight * d_dinv_z;
                            }
                            if ((node.m - mat_m) > 1.0e-5f * node.m) {
                                contact_weight_sum += weight;
                            }
                        } else if (node.m > 1.0e-20f) {
                            float m_tol = 1.0e-8f * fmaxf(soa.m[p_idx], 1.0e-12f);
                            float inv_m = 1.0f / node.m;
                            float reg = (node.m * node.m) / (node.m * node.m + m_tol * m_tol);
                            float eff_vx = sign_x * (node.p[0] * inv_m);
                            float eff_vy = sign_y * (node.p[1] * inv_m);
                            float eff_vz = sign_z * (node.p[2] * inv_m);

                            float eff_dvx = sign_x * (dt * (node.f_ext[0] + reg * node.f_int[0]) * inv_m);
                            float eff_dvy = sign_y * (dt * (node.f_ext[1] + reg * node.f_int[1]) * inv_m);
                            float eff_dvz = sign_z * (dt * (node.f_ext[2] + reg * node.f_int[2]) * inv_m);

                            v_pic_x += weight * eff_vx;
                            v_pic_y += weight * eff_vy;
                            v_pic_z += weight * eff_vz;

                            v_grad_x += weight * eff_vx;
                            v_grad_y += weight * eff_vy;
                            v_grad_z += weight * eff_vz;

                            delta_v_grid_x += weight * eff_dvx;
                            delta_v_grid_y += weight * eff_dvy;
                            delta_v_grid_z += weight * eff_dvz;

                            weight_sum += weight;
                            weight_grad_sum += weight;
                            if (node.m_solid > 1.0e-20f) {
                                ep_grid += weight * node.plastic_strain;
                            }
                            q_fric_grid += weight * node.q_fric;
                            t_interp_grid += weight * node.temperature;
                            dt_cond_grid += weight * node.dT_cond;

                            float dc_x = node_x - xc;
                            float dc_y = node_y - yc;
                            float dc_z = node_z - zc;

                            float d_dinv_x = D_inv[0][0] * dc_x + D_inv[0][1] * dc_y + D_inv[0][2] * dc_z;
                            float d_dinv_y = D_inv[1][0] * dc_x + D_inv[1][1] * dc_y + D_inv[1][2] * dc_z;
                            float d_dinv_z = D_inv[2][0] * dc_x + D_inv[2][1] * dc_y + D_inv[2][2] * dc_z;

                            sum_wd_x += weight * dist_x;
                            sum_wd_y += weight * dist_y;
                            sum_wd_z += weight * dist_z;
                            sum_wxx += weight * dist_x * dist_x;
                            sum_wxy += weight * dist_x * dist_y;
                            sum_wxz += weight * dist_x * dist_z;
                            sum_wyy += weight * dist_y * dist_y;
                            sum_wyz += weight * dist_y * dist_z;
                            sum_wzz += weight * dist_z * dist_z;
                            sum_b_grad_x += weight * d_dinv_x;
                            sum_b_grad_y += weight * d_dinv_y;
                            sum_b_grad_z += weight * d_dinv_z;
                            sum_l_grad_x += weight * d_dinv_x;
                            sum_l_grad_y += weight * d_dinv_y;
                            sum_l_grad_z += weight * d_dinv_z;

                            float rel_vx = eff_vx - v_prev_x;
                            float rel_vy = eff_vy - v_prev_y;
                            float rel_vz = eff_vz - v_prev_z;

                            A_mat[0][0] += weight * rel_vx * dist_x;
                            A_mat[0][1] += weight * rel_vx * dist_y;
                            A_mat[0][2] += weight * rel_vx * dist_z;

                            A_mat[1][0] += weight * rel_vy * dist_x;
                            A_mat[1][1] += weight * rel_vy * dist_y;
                            A_mat[1][2] += weight * rel_vy * dist_z;

                            A_mat[2][0] += weight * rel_vz * dist_x;
                            A_mat[2][1] += weight * rel_vz * dist_y;
                            A_mat[2][2] += weight * rel_vz * dist_z;

                            B_new[0][0] += weight * rel_vx * d_dinv_x;
                            B_new[0][1] += weight * rel_vx * d_dinv_y;
                            B_new[0][2] += weight * rel_vx * d_dinv_z;

                            B_new[1][0] += weight * rel_vy * d_dinv_x;
                            B_new[1][1] += weight * rel_vy * d_dinv_y;
                            B_new[1][2] += weight * rel_vy * d_dinv_z;

                            B_new[2][0] += weight * rel_vz * d_dinv_x;
                            B_new[2][1] += weight * rel_vz * d_dinv_y;
                            B_new[2][2] += weight * rel_vz * d_dinv_z;

                            L_new[0][0] += rel_vx * weight * d_dinv_x;
                            L_new[0][1] += rel_vx * weight * d_dinv_y;
                            L_new[0][2] += rel_vx * weight * d_dinv_z;

                            L_new[1][0] += rel_vy * weight * d_dinv_x;
                            L_new[1][1] += rel_vy * weight * d_dinv_y;
                            L_new[1][2] += rel_vy * weight * d_dinv_z;

                            L_new[2][0] += rel_vz * weight * d_dinv_x;
                            L_new[2][1] += rel_vz * weight * d_dinv_y;
                            L_new[2][2] += rel_vz * weight * d_dinv_z;
                        }
                    }
                }
            }
        }
    } else if (eff_transfer_scheme == 4) {
        // Cubic B-Spline (5-node stencil [-2, 2] per axis / 125 nodes in 3D, C2 continuous, d_scale = 3.0)
        // Single-pass exact B-spline gather matching kernel_p2g_3d for strict linear & angular momentum conservation.
        float d_scale = 3.0f;
        float D_inv_x = d_scale / (dx * dx);
        float D_inv_y = d_scale / (dy * dy);
        float D_inv_z = d_scale / (dz * dz);

        float Sx_arr[5], dSx_arr[5], Sy_arr[5], dSy_arr[5], Sz_arr[5], dSz_arr[5];
        for (int offset = -2; offset <= 2; ++offset) {
            int idx = offset + 2;
            float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * dx;
            Sx_arr[idx] = evalCubicBSpline_S_dev(px, nx_val, dx);
            dSx_arr[idx] = Sx_arr[idx] * D_inv_x * (nx_val - px);

            float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * dy;
            Sy_arr[idx] = evalCubicBSpline_S_dev(py, ny_val, dy);
            dSy_arr[idx] = Sy_arr[idx] * D_inv_y * (ny_val - py);

            float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * dz;
            Sz_arr[idx] = evalCubicBSpline_S_dev(pz, nz_val, dz);
            dSz_arr[idx] = Sz_arr[idx] * D_inv_z * (nz_val - pz);
        }

        for (int offset_i = -2; offset_i <= 2; ++offset_i) {
            int i_idx = offset_i + 2;
            float Sx = Sx_arr[i_idx];
            if (fabsf(Sx) < 1.0e-7f) continue;
            int raw_i = base_i + offset_i;
            int i = raw_i;
            float sign_x = 1.0f;
            if (!resolve_ghost_node_3d(i, sign_x, nx, bc_x_min, bc_x_max)) { truncated_open_bc = true; continue; }
            float dSx = dSx_arr[i_idx];
            float node_x = (static_cast<float>(raw_i) + 0.5f) * dx;

            for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                int j_idx = offset_j + 2;
                float Sy = Sy_arr[j_idx];
                if (fabsf(Sy) < 1.0e-7f) continue;
                int raw_j = base_j + offset_j;
                int j = raw_j;
                float sign_y = 1.0f;
                if (!resolve_ghost_node_3d(j, sign_y, ny, bc_y_min, bc_y_max)) { truncated_open_bc = true; continue; }
                float dSy = dSy_arr[j_idx];
                float node_y = (static_cast<float>(raw_j) + 0.5f) * dy;

                for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                    int k_idx = offset_k + 2;
                    float Sz = Sz_arr[k_idx];
                    if (fabsf(Sz) < 1.0e-7f) continue;
                    int raw_k = base_k + offset_k;
                    int k = raw_k;
                    float sign_z = 1.0f;
                    if (!resolve_ghost_node_3d(k, sign_z, nz, bc_z_min, bc_z_max)) { truncated_open_bc = true; continue; }
                    float dSz = dSz_arr[k_idx];
                    float node_z = (static_cast<float>(raw_k) + 0.5f) * dz;

                    float weight = Sx * Sy * Sz;
                    if (weight < 1.0e-7f) continue;
                    float dN_dx = dSx * Sy * Sz;
                    float dN_dy = Sx * dSy * Sz;
                    float dN_dz = Sx * Sy * dSz;

                    size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                    const MPMGridNode3D& node = grid[node_idx];

                    float n_vx = 0.0f, n_vy = 0.0f, n_vz = 0.0f;
                    float delta_vx = 0.0f, delta_vy = 0.0f, delta_vz = 0.0f;
                    float m_val = 0.0f;
                    bool node_valid = false;

                    if (is_multi_mat) {
                        m_val = mpm_mat_node_kinematics(grid, d_mat_tag, d_mat_grid_m, d_mat_grid_v, d_mat_grid_dv, num_materials, num_nodes_total, p_mat, node_idx, v_prev_x, v_prev_y, v_prev_z, n_vx, n_vy, n_vz, delta_vx, delta_vy, delta_vz);
                        if (m_val > 1.0e-20f) {
                            node_valid = true;
                        }
                        if ((node.m - m_val) > 1.0e-5f * node.m) {
                            contact_weight_sum += weight;
                        }
                    } else if (node.m > 1.0e-20f) {
                        float m_tol = 1.0e-8f * fmaxf(soa.m[p_idx], 1.0e-12f);
                        float inv_m = 1.0f / node.m;
                        float reg = (node.m * node.m) / (node.m * node.m + m_tol * m_tol);
                        n_vx = node.p[0] * inv_m;
                        n_vy = node.p[1] * inv_m;
                        n_vz = node.p[2] * inv_m;
                        delta_vx = dt * (node.f_ext[0] + reg * node.f_int[0]) * inv_m;
                        delta_vy = dt * (node.f_ext[1] + reg * node.f_int[1]) * inv_m;
                        delta_vz = dt * (node.f_ext[2] + reg * node.f_int[2]) * inv_m;
                        node_valid = true;
                    }

                    if (node_valid) {
                        float eff_vx = sign_x * n_vx;
                        float eff_vy = sign_y * n_vy;
                        float eff_vz = sign_z * n_vz;
                        float eff_dvx = sign_x * delta_vx;
                        float eff_dvy = sign_y * delta_vy;
                        float eff_dvz = sign_z * delta_vz;

                        float dist_x = node_x - px;
                        float dist_y = node_y - py;
                        float dist_z = node_z - pz;

                        bool is_contact_node = is_multi_mat && ((node.m - m_val) > 1.0e-5f * node.m);
                        float w_sym = 1.0f;
                        float w_grad = 1.0f;
                        if (is_contact_node) {
                            float rx_n = fabsf(dist_x) / dx;
                            float ry_n = fabsf(dist_y) / dy;
                            float rz_n = fabsf(dist_z) / dz;
                            float r_max_n = fmaxf(rx_n, fmaxf(ry_n, rz_n));
                            w_sym = fminf(fmaxf(1.0f - r_max_n, 0.0f) * 2.0f, 1.0f);
                            w_grad = 1.0f;
                        }

                        v_pic_x += weight * eff_vx;
                        v_pic_y += weight * eff_vy;
                        v_pic_z += weight * eff_vz;

                        v_grad_x += (weight * w_grad) * eff_vx;
                        v_grad_y += (weight * w_grad) * eff_vy;
                        v_grad_z += (weight * w_grad) * eff_vz;

                        delta_v_grid_x += weight * eff_dvx;
                        delta_v_grid_y += weight * eff_dvy;
                        delta_v_grid_z += weight * eff_dvz;

                        weight_sum += weight;
                        weight_grad_sum += weight * w_grad;
                        if (!is_contact_node && node.m_solid > 1.0e-20f) {
                            ep_grid += weight * node.plastic_strain;
                        } else if (is_contact_node && soa.ep_bar) {
                            ep_grid += weight * soa.ep_bar[p_idx];
                        }
                        q_fric_grid += (weight * w_sym) * node.q_fric;
                        t_interp_grid += weight * node.temperature;
                        dt_cond_grid += weight * node.dT_cond;

                        sum_wd_x += weight * dist_x;
                        sum_wd_y += weight * dist_y;
                        sum_wd_z += weight * dist_z;

                        sum_wxx += weight * dist_x * dist_x;
                        sum_wxy += weight * dist_x * dist_y;
                        sum_wxz += weight * dist_x * dist_z;
                        sum_wyy += weight * dist_y * dist_y;
                        sum_wyz += weight * dist_y * dist_z;
                        sum_wzz += weight * dist_z * dist_z;

                        sum_b_grad_x += w_grad * weight * dist_x * D_inv_x;
                        sum_b_grad_y += w_grad * weight * dist_y * D_inv_y;
                        sum_b_grad_z += w_grad * weight * dist_z * D_inv_z;
                        sum_l_grad_x += w_grad * dN_dx;
                        sum_l_grad_y += w_grad * dN_dy;
                        sum_l_grad_z += w_grad * dN_dz;

                        float rel_vx = w_grad * (eff_vx - v_prev_x);
                        float rel_vy = w_grad * (eff_vy - v_prev_y);
                        float rel_vz = w_grad * (eff_vz - v_prev_z);

                        A_mat[0][0] += weight * rel_vx * dist_x;
                        A_mat[0][1] += weight * rel_vx * dist_y;
                        A_mat[0][2] += weight * rel_vx * dist_z;

                        A_mat[1][0] += weight * rel_vy * dist_x;
                        A_mat[1][1] += weight * rel_vy * dist_y;
                        A_mat[1][2] += weight * rel_vy * dist_z;

                        A_mat[2][0] += weight * rel_vz * dist_x;
                        A_mat[2][1] += weight * rel_vz * dist_y;
                        A_mat[2][2] += weight * rel_vz * dist_z;

                        B_new[0][0] += weight * rel_vx * dist_x * D_inv_x;
                        B_new[0][1] += weight * rel_vx * dist_y * D_inv_y;
                        B_new[0][2] += weight * rel_vx * dist_z * D_inv_z;

                        B_new[1][0] += weight * rel_vy * dist_x * D_inv_x;
                        B_new[1][1] += weight * rel_vy * dist_y * D_inv_y;
                        B_new[1][2] += weight * rel_vy * dist_z * D_inv_z;

                        B_new[2][0] += weight * rel_vz * dist_x * D_inv_x;
                        B_new[2][1] += weight * rel_vz * dist_y * D_inv_y;
                        B_new[2][2] += weight * rel_vz * dist_z * D_inv_z;

                        L_new[0][0] += rel_vx * dN_dx;
                        L_new[0][1] += rel_vx * dN_dy;
                        L_new[0][2] += rel_vx * dN_dz;

                        L_new[1][0] += rel_vy * dN_dx;
                        L_new[1][1] += rel_vy * dN_dy;
                        L_new[1][2] += rel_vy * dN_dz;

                        L_new[2][0] += rel_vz * dN_dx;
                        L_new[2][1] += rel_vz * dN_dy;
                        L_new[2][2] += rel_vz * dN_dz;
                    }
                }
            }
        }
    } else {
        const bool is_standard = (eff_transfer_scheme == 0);
        float d_scale = (eff_transfer_scheme == 2) ? 4.0f : 3.0f;
        float D_inv_x = d_scale / (dx * dx);
        float D_inv_y = d_scale / (dy * dy);
        float D_inv_z = d_scale / (dz * dz);

        float Sx_arr[4], dSx_arr[4], Sy_arr[4], dSy_arr[4], Sz_arr[4], dSz_arr[4];
        if (eff_transfer_scheme == 1) {
            #pragma unroll
            for (int offset = -1; offset <= 2; ++offset) {
                int idx = offset + 1;
                float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * dx;
                Sx_arr[idx] = evalGIMP_S_dev(px, nx_val, dx, lp_0);
                dSx_arr[idx] = evalGIMP_dS_dev(px, nx_val, dx, lp_0);

                float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * dy;
                Sy_arr[idx] = evalGIMP_S_dev(py, ny_val, dy, lp_1);
                dSy_arr[idx] = evalGIMP_dS_dev(py, ny_val, dy, lp_1);

                float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * dz;
                Sz_arr[idx] = evalGIMP_S_dev(pz, nz_val, dz, lp_2);
                dSz_arr[idx] = evalGIMP_dS_dev(pz, nz_val, dz, lp_2);
            }
        } else if (eff_transfer_scheme == 2) {
            #pragma unroll
            for (int offset = -1; offset <= 2; ++offset) {
                int idx = offset + 1;
                float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * dx;
                Sx_arr[idx] = evalBSpline_S_dev(px, nx_val, dx);
                dSx_arr[idx] = Sx_arr[idx] * D_inv_x * (nx_val - px);

                float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * dy;
                Sy_arr[idx] = evalBSpline_S_dev(py, ny_val, dy);
                dSy_arr[idx] = Sy_arr[idx] * D_inv_y * (ny_val - py);

                float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * dz;
                Sz_arr[idx] = evalBSpline_S_dev(pz, nz_val, dz);
                dSz_arr[idx] = Sz_arr[idx] * D_inv_z * (nz_val - pz);
            }
        } else {
            #pragma unroll
            for (int offset = -1; offset <= 2; ++offset) {
                int idx = offset + 1;
                float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * dx;
                Sx_arr[idx] = evalLinear_S_dev(px, nx_val, dx);
                dSx_arr[idx] = evalLinear_dS_dev(px, nx_val, dx);

                float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * dy;
                Sy_arr[idx] = evalLinear_S_dev(py, ny_val, dy);
                dSy_arr[idx] = evalLinear_dS_dev(py, ny_val, dy);

                float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * dz;
                Sz_arr[idx] = evalLinear_S_dev(pz, nz_val, dz);
                dSz_arr[idx] = evalLinear_dS_dev(pz, nz_val, dz);
            }
        }

        for (int offset_i = -1; offset_i <= 2; ++offset_i) {
            int i_idx = offset_i + 1;
            float Sx = Sx_arr[i_idx];
            if (fabsf(Sx) < 1.0e-7f) continue;
            int raw_i = base_i + offset_i;
            int i = raw_i;
            float sign_x = 1.0f;
            if (!resolve_ghost_node_3d(i, sign_x, nx, bc_x_min, bc_x_max)) { truncated_open_bc = true; continue; }
            float dSx = dSx_arr[i_idx];
            float node_x = (static_cast<float>(raw_i) + 0.5f) * dx;

            for (int offset_j = -1; offset_j <= 2; ++offset_j) {
                int j_idx = offset_j + 1;
                float Sy = Sy_arr[j_idx];
                if (fabsf(Sy) < 1.0e-7f) continue;
                int raw_j = base_j + offset_j;
                int j = raw_j;
                float sign_y = 1.0f;
                if (!resolve_ghost_node_3d(j, sign_y, ny, bc_y_min, bc_y_max)) { truncated_open_bc = true; continue; }
                float dSy = dSy_arr[j_idx];
                float node_y = (static_cast<float>(raw_j) + 0.5f) * dy;

                for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                    int k_idx = offset_k + 1;
                    float Sz = Sz_arr[k_idx];
                    if (fabsf(Sz) < 1.0e-7f) continue;
                    int raw_k = base_k + offset_k;
                    int k = raw_k;
                    float sign_z = 1.0f;
                    if (!resolve_ghost_node_3d(k, sign_z, nz, bc_z_min, bc_z_max)) { truncated_open_bc = true; continue; }
                    float dSz = dSz_arr[k_idx];
                    float node_z = (static_cast<float>(raw_k) + 0.5f) * dz;

                    float weight = Sx * Sy * Sz;
                    if (weight < 1.0e-7f) continue;
                    float dN_dx = dSx * Sy * Sz;
                    float dN_dy = Sx * dSy * Sz;
                    float dN_dz = Sx * Sy * dSz;

                    size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                    const MPMGridNode3D& node = grid[node_idx];

                    float n_vx = 0.0f, n_vy = 0.0f, n_vz = 0.0f;
                    float delta_vx = 0.0f, delta_vy = 0.0f, delta_vz = 0.0f;
                    float m_val = 0.0f;
                    bool node_valid = false;

                    if (is_multi_mat) {
                        m_val = mpm_mat_node_kinematics(grid, d_mat_tag, d_mat_grid_m, d_mat_grid_v, d_mat_grid_dv, num_materials, num_nodes_total, p_mat, node_idx, v_prev_x, v_prev_y, v_prev_z, n_vx, n_vy, n_vz, delta_vx, delta_vy, delta_vz);
                        if (m_val > 1.0e-20f) {
                            node_valid = true;
                        }
                        if ((node.m - m_val) > 1.0e-5f * node.m) {
                            contact_weight_sum += weight;
                        }
                    } else if (node.m > 1.0e-20f) {
                        float m_tol = 1.0e-8f * fmaxf(soa.m[p_idx], 1.0e-12f);
                        float inv_m = 1.0f / node.m;
                        float reg = (node.m * node.m) / (node.m * node.m + m_tol * m_tol);
                        n_vx = node.p[0] * inv_m;
                        n_vy = node.p[1] * inv_m;
                        n_vz = node.p[2] * inv_m;
                        delta_vx = dt * (node.f_ext[0] + reg * node.f_int[0]) * inv_m;
                        delta_vy = dt * (node.f_ext[1] + reg * node.f_int[1]) * inv_m;
                        delta_vz = dt * (node.f_ext[2] + reg * node.f_int[2]) * inv_m;
                        node_valid = true;
                    }

                    if (node_valid) {
                        float eff_vx = sign_x * n_vx;
                        float eff_vy = sign_y * n_vy;
                        float eff_vz = sign_z * n_vz;
                        float eff_dvx = sign_x * delta_vx;
                        float eff_dvy = sign_y * delta_vy;
                        float eff_dvz = sign_z * delta_vz;

                        float dist_x = node_x - px;
                        float dist_y = node_y - py;
                        float dist_z = node_z - pz;

                        bool is_contact_node = is_multi_mat && ((node.m - m_val) > 1.0e-5f * node.m);
                        float w_sym = 1.0f;
                        float w_grad = 1.0f;
                        if (is_contact_node) {
                            float rx_n = fabsf(dist_x) / dx;
                            float ry_n = fabsf(dist_y) / dy;
                            float rz_n = fabsf(dist_z) / dz;
                            float r_max_n = fmaxf(rx_n, fmaxf(ry_n, rz_n));
                            w_sym = fminf(fmaxf(1.0f - r_max_n, 0.0f) * 2.0f, 1.0f);
                            // Material velocity eff_v from Bardenhagen contact is already the material's
                            // own velocity field. Do not scale rel_v by f_mat or w_sym, which destroys gradient linearity.
                            w_grad = 1.0f;
                        }

                        v_pic_x += weight * eff_vx;
                        v_pic_y += weight * eff_vy;
                        v_pic_z += weight * eff_vz;

                        v_grad_x += (weight * w_grad) * eff_vx;
                        v_grad_y += (weight * w_grad) * eff_vy;
                        v_grad_z += (weight * w_grad) * eff_vz;

                        delta_v_grid_x += weight * eff_dvx;
                        delta_v_grid_y += weight * eff_dvy;
                        delta_v_grid_z += weight * eff_dvz;

                        weight_sum += weight;
                        weight_grad_sum += weight * w_grad;
                        if (!is_contact_node && node.m_solid > 1.0e-20f) {
                            ep_grid += weight * node.plastic_strain;
                        } else if (is_contact_node && soa.ep_bar) {
                            ep_grid += weight * soa.ep_bar[p_idx];
                        }
                        q_fric_grid += (weight * w_sym) * node.q_fric;
                        t_interp_grid += weight * node.temperature;
                        dt_cond_grid += weight * node.dT_cond;

                        sum_wd_x += weight * dist_x;
                        sum_wd_y += weight * dist_y;
                        sum_wd_z += weight * dist_z;

                        sum_wxx += weight * dist_x * dist_x;
                        sum_wxy += weight * dist_x * dist_y;
                        sum_wxz += weight * dist_x * dist_z;
                        sum_wyy += weight * dist_y * dist_y;
                        sum_wyz += weight * dist_y * dist_z;
                        sum_wzz += weight * dist_z * dist_z;

                        // For Standard (linear tent), D_xx = xi*(1-xi)*dx^2 cancels identically in
                        // B_p * D_p^{-1} = sum v_i * dN_i on interior 2x2x2 stencils, avoiding 0/0 near nodes.
                        float b_grad_x = is_standard ? dN_dx : (weight * dist_x * D_inv_x);
                        float b_grad_y = is_standard ? dN_dy : (weight * dist_y * D_inv_y);
                        float b_grad_z = is_standard ? dN_dz : (weight * dist_z * D_inv_z);

                        sum_b_grad_x += w_grad * b_grad_x;
                        sum_b_grad_y += w_grad * b_grad_y;
                        sum_b_grad_z += w_grad * b_grad_z;
                        sum_l_grad_x += w_grad * dN_dx;
                        sum_l_grad_y += w_grad * dN_dy;
                        sum_l_grad_z += w_grad * dN_dz;

                        float rel_vx = w_grad * (eff_vx - v_prev_x);
                        float rel_vy = w_grad * (eff_vy - v_prev_y);
                        float rel_vz = w_grad * (eff_vz - v_prev_z);

                        A_mat[0][0] += weight * rel_vx * dist_x;
                        A_mat[0][1] += weight * rel_vx * dist_y;
                        A_mat[0][2] += weight * rel_vx * dist_z;

                        A_mat[1][0] += weight * rel_vy * dist_x;
                        A_mat[1][1] += weight * rel_vy * dist_y;
                        A_mat[1][2] += weight * rel_vy * dist_z;

                        A_mat[2][0] += weight * rel_vz * dist_x;
                        A_mat[2][1] += weight * rel_vz * dist_y;
                        A_mat[2][2] += weight * rel_vz * dist_z;

                        B_new[0][0] += rel_vx * b_grad_x;
                        B_new[0][1] += rel_vx * b_grad_y;
                        B_new[0][2] += rel_vx * b_grad_z;

                        B_new[1][0] += rel_vy * b_grad_x;
                        B_new[1][1] += rel_vy * b_grad_y;
                        B_new[1][2] += rel_vy * b_grad_z;

                        B_new[2][0] += rel_vz * b_grad_x;
                        B_new[2][1] += rel_vz * b_grad_y;
                        B_new[2][2] += rel_vz * b_grad_z;

                        L_new[0][0] += rel_vx * dN_dx;
                        L_new[0][1] += rel_vx * dN_dy;
                        L_new[0][2] += rel_vx * dN_dz;

                        L_new[1][0] += rel_vy * dN_dx;
                        L_new[1][1] += rel_vy * dN_dy;
                        L_new[1][2] += rel_vy * dN_dz;

                        L_new[2][0] += rel_vz * dN_dx;
                        L_new[2][1] += rel_vz * dN_dy;
                        L_new[2][2] += rel_vz * dN_dz;
                    }
                }
            }
        }
    }

    float ep_smoothed = (weight_sum > 1.0e-7f) ? (ep_grid / weight_sum) : 0.0f;
    float q_fric_p = (weight_sum > 1.0e-7f) ? (q_fric_grid / weight_sum) : 0.0f;
    float t_interp_p = (weight_sum > 1.0e-7f) ? (t_interp_grid / weight_sum) : (soa.temperature ? soa.temperature[p_idx] : mat.T_room);
    float dt_cond_p = (weight_sum > 1.0e-7f) ? (dt_cond_grid / weight_sum) : 0.0f;

    if (weight_sum <= 1.0e-7f) {
        v_pic_x = v_prev_x; v_pic_y = v_prev_y; v_pic_z = v_prev_z;
        delta_v_grid_x = 0.0f; delta_v_grid_y = 0.0f; delta_v_grid_z = 0.0f;
    } else {
        float inv_w = 1.0f / weight_sum;
        v_pic_x *= inv_w;
        v_pic_y *= inv_w;
        v_pic_z *= inv_w;
        delta_v_grid_x *= inv_w;
        delta_v_grid_y *= inv_w;
        delta_v_grid_z *= inv_w;

        float delta_x = sum_wd_x * inv_w;
        float delta_y = sum_wd_y * inv_w;
        float delta_z = sum_wd_z * inv_w;

        if (truncated_open_bc) {
            // Stencil overhangs an open (Transmitting / Lysmer / Terminate) boundary:
            // shift v_pic back from the truncated stencil centroid to the particle position x_p
            // using the particle's affine gradient B_p, and preserve B_p with zero artificial boundary strain.
            if (velocity_scheme == 0) {
                v_pic_x -= soa.B[0][0][p_idx] * delta_x + soa.B[0][1][p_idx] * delta_y + soa.B[0][2][p_idx] * delta_z;
                v_pic_y -= soa.B[1][0][p_idx] * delta_x + soa.B[1][1][p_idx] * delta_y + soa.B[1][2][p_idx] * delta_z;
                v_pic_z -= soa.B[2][0][p_idx] * delta_x + soa.B[2][1][p_idx] * delta_y + soa.B[2][2][p_idx] * delta_z;
            }
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    B_new[r][c] = soa.B[r][c][p_idx];
                    L_new[r][c] = 0.5f * (soa.B[r][c][p_idx] - soa.B[c][r][p_idx]);
                }
            }
        } else {
            // Remove single-pass (v_ref - v_prev) offset so B_new and L_new are strictly centered around v_ref
            float v_ref_x = (weight_grad_sum > 1.0e-7f) ? (v_grad_x / weight_grad_sum) : v_pic_x;
            float v_ref_y = (weight_grad_sum > 1.0e-7f) ? (v_grad_y / weight_grad_sum) : v_pic_y;
            float v_ref_z = (weight_grad_sum > 1.0e-7f) ? (v_grad_z / weight_grad_sum) : v_pic_z;
            float dv_p[3] = {v_ref_x - v_prev_x, v_ref_y - v_prev_y, v_ref_z - v_prev_z};
            float bg[3] = {sum_b_grad_x, sum_b_grad_y, sum_b_grad_z};
            float lg[3] = {sum_l_grad_x, sum_l_grad_y, sum_l_grad_z};
            float sum_wd[3] = {sum_wd_x, sum_wd_y, sum_wd_z};
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    B_new[r][c] -= dv_p[r] * bg[c];
                    L_new[r][c] -= dv_p[r] * lg[c];
                    A_mat[r][c] -= dv_p[r] * sum_wd[c];
                }
            }

            // Detect boundary stencil truncation where centroid is offset from particle position,
            // or GIMP transfer scheme where D is non-constant across cell.
            // Note: Standard trilinear already evaluates exact B_new = L_new = sum v_i * dN_i on interior 2x2x2 stencils.
            bool is_boundary_stencil = (weight_sum < 0.999f ||
                                        fabsf(delta_x) > 1.0e-4f * dx ||
                                        fabsf(delta_y) > 1.0e-4f * dy ||
                                        fabsf(delta_z) > 1.0e-4f * dz);
            if (is_boundary_stencil || eff_transfer_scheme == 1) {
                float D00 = sum_wxx - weight_sum * delta_x * delta_x;
                float D01 = sum_wxy - weight_sum * delta_x * delta_y;
                float D02 = sum_wxz - weight_sum * delta_x * delta_z;
                float D11 = sum_wyy - weight_sum * delta_y * delta_y;
                float D12 = sum_wyz - weight_sum * delta_y * delta_z;
                float D22 = sum_wzz - weight_sum * delta_z * delta_z;

                float det_D = D00 * (D11 * D22 - D12 * D12) - D01 * (D01 * D22 - D12 * D02) + D02 * (D01 * D12 - D11 * D02);
                float det_ref_abs = (1.0f / 64.0f) * (dx * dx) * (dy * dy) * (dz * dz);
                float diag_ref_abs = 0.25f * (dx * dx);
                float D_min_diag = fminf(D00, fminf(D11, D22));
                float D_max_diag = fmaxf(D00, fmaxf(D11, D22));
                bool is_well_conditioned = (weight_sum > 0.25f) &&
                                           (det_D > 1.0e-3f * det_ref_abs) &&
                                           (D_min_diag > 0.05f * diag_ref_abs) &&
                                           (D_min_diag > 0.12f * D_max_diag);

                if (is_well_conditioned) {
                    float inv_det = 1.0f / det_D;
                    float D_inv_mat[3][3];
                    D_inv_mat[0][0] =  (D11 * D22 - D12 * D12) * inv_det;
                    D_inv_mat[0][1] = -(D01 * D22 - D12 * D02) * inv_det;
                    D_inv_mat[0][2] =  (D01 * D12 - D11 * D02) * inv_det;
                    D_inv_mat[1][0] = D_inv_mat[0][1];
                    D_inv_mat[1][1] =  (D00 * D22 - D02 * D02) * inv_det;
                    D_inv_mat[1][2] = -(D00 * D12 - D01 * D02) * inv_det;
                    D_inv_mat[2][0] = D_inv_mat[0][2];
                    D_inv_mat[2][1] = D_inv_mat[1][2];
                    D_inv_mat[2][2] =  (D00 * D11 - D01 * D01) * inv_det;

                    for (int r = 0; r < 3; ++r) {
                        for (int c = 0; c < 3; ++c) {
                            float val = A_mat[r][0] * D_inv_mat[0][c] + A_mat[r][1] * D_inv_mat[1][c] + A_mat[r][2] * D_inv_mat[2][c];
                            L_new[r][c] = val;
                            B_new[r][c] = val;
                        }
                    }
                } else {
                    // Under-resolved boundary stencil (rank < 3, e.g. sharp corner or single node):
                    // insufficient spatial dimensions to invert covariance matrix D.
                    // Preserve particle's existing affine spin tensor B_p and zero spurious artificial strain rate.
                    for (int r = 0; r < 3; ++r) {
                        for (int c = 0; c < 3; ++c) {
                            B_new[r][c] = soa.B[r][c][p_idx];
                            L_new[r][c] = 0.5f * (soa.B[r][c][p_idx] - soa.B[c][r][p_idx]);
                        }
                    }
                }
            }

            // Shift v_pic from stencil centroid back to particle position x_p to eliminate boundary centroid velocity error
            if (velocity_scheme == 0) {
                v_pic_x -= (B_new[0][0] * delta_x + B_new[0][1] * delta_y + B_new[0][2] * delta_z);
                v_pic_y -= (B_new[1][0] * delta_x + B_new[1][1] * delta_y + B_new[1][2] * delta_z);
                v_pic_z -= (B_new[2][0] * delta_x + B_new[2][1] * delta_y + B_new[2][2] * delta_z);
            }
        }
    }

    float target_vx = v_pic_x;
    float target_vy = v_pic_y;
    float target_vz = v_pic_z;

    float contact_fraction = (is_multi_mat && weight_sum > 1.0e-7f) ? (contact_weight_sum / weight_sum) : 0.0f;
    (void)contact_fraction;

    // True APIC (Jiang et al. 2015): target_v = v_pic and B_p = B_new uniformly across both intact and
    // failed/damaged particles when velocity_scheme == 0. Uniform velocity transfer across intact/failed
    // interfaces strictly conserves linear and angular momentum and eliminates hybrid APIC/FLIP ratcheting.
    if (velocity_scheme == 0) {
        target_vx = v_pic_x;
        target_vy = v_pic_y;
        target_vz = v_pic_z;
    } else if (velocity_scheme == 2) {
        float alpha = fminf(fmaxf(flip_blend, 0.0f), 1.0f);
        float v_flip_x = v_prev_x + delta_v_grid_x;
        float v_flip_y = v_prev_y + delta_v_grid_y;
        float v_flip_z = v_prev_z + delta_v_grid_z;
        target_vx = alpha * v_flip_x + (1.0f - alpha) * v_pic_x;
        target_vy = alpha * v_flip_y + (1.0f - alpha) * v_pic_y;
        target_vz = alpha * v_flip_z + (1.0f - alpha) * v_pic_z;
    }

    float v_max_limit = 25000.0f;
    float final_vx = fminf(fmaxf(target_vx, -v_max_limit), v_max_limit);
    float final_vy = fminf(fmaxf(target_vy, -v_max_limit), v_max_limit);
    float final_vz = fminf(fmaxf(target_vz, -v_max_limit), v_max_limit);

    soa.v[0][p_idx] = final_vx;
    soa.v[1][p_idx] = final_vy;
    soa.v[2][p_idx] = final_vz;

    // Store particle velocity gradient B_p for APIC P2G transfer, and use true velocity gradient L_new for constitutive stress update
    float L_eff[3][3];
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            float b_val = fminf(fmaxf(B_new[r][c], -max_B), max_B);
            soa.B[r][c][p_idx] = (velocity_scheme == 0) ? b_val : 0.0f;
            float l_val = fminf(fmaxf(L_new[r][c], -max_B), max_B);
            if constexpr (!FUSE_STRESS) {
                soa.L_grad[r][c][p_idx] = l_val;
            } else {
                L_eff[r][c] = l_val;
            }
        }
    }

    integrate_particle_position_and_bc(p_idx, dt, final_vx, final_vy, final_vz,
                                       soa, nx, ny, nz, dx, dy, dz, xmin, ymin, zmin,
                                       bc_x_min, bc_x_max, bc_y_min, bc_y_max, bc_z_min, bc_z_max,
                                       is_fluid_water, is_energetic_p, zonal_params, d_boundary_flags);

    // Apply interfacial frictional heating and grid-mediated thermal conduction before stress update
    if ((enable_frictional_heating || enable_thermal_conduction) && !is_fluid_water && !is_energetic_p && mat.Cp > 0.0f && soa.e_int && soa.temperature) {
        bool thermal_updated = false;
        float e_int_cur = soa.e_int[p_idx];
        float temp_cur = soa.temperature[p_idx];
        if (enable_frictional_heating && q_fric_p > 0.0f) {
            e_int_cur += q_fric_p;
            temp_cur = mat.T_room + e_int_cur / mat.Cp;
            thermal_updated = true;
        }
        if (enable_thermal_conduction) {
            float dT_total = dt_cond_p;
            if (fabsf(dT_total) > 1.0e-6f) {
                e_int_cur = fmaxf(0.0f, e_int_cur + mat.Cp * dT_total);
                temp_cur = mat.T_room + e_int_cur / mat.Cp;
                thermal_updated = true;
            }
        }
        if (thermal_updated) {
            soa.e_int[p_idx] = e_int_cur;
            soa.temperature[p_idx] = temp_cur;
        }
    }

    if constexpr (FUSE_STRESS) {
        update_particle_stress_constitutive(p_idx, dt, L_eff, soa, mat, ep_smoothed, enable_impact_welding);
    }
}

// 3a. Standalone G2P Kernel
__global__ void kernel_g2p_3d(MPMParticle3DSoA soa, int num_particles,
                              MPMGridNode3D* grid, int nx, int ny, int nz,
                              float dx, float dy, float dz, float dt, int transfer_scheme,
                              int velocity_scheme, float flip_blend,
                              float xmin, float ymin, float zmin,
                              int bc_x_min, int bc_x_max,
                              int bc_y_min, int bc_y_max,
                              int bc_z_min, int bc_z_max,
                              const MaterialTable3D* d_mat_tables,
                              const float* d_mat_grid_m = nullptr,
                              const float* d_mat_grid_v = nullptr,
                              const float* d_mat_grid_dv = nullptr,
                              int num_materials = 1,
                              Blast::ZonalHandoff3DParams zonal_params = {},
                              int* d_boundary_flags = nullptr,
                              const int* d_mat_tag = nullptr,
                              bool enable_frictional_heating = false,
                              bool enable_thermal_conduction = false,
                              bool enable_impact_welding = false) {
    g2p_device_impl<false>(soa, num_particles, grid, nx, ny, nz, dx, dy, dz, dt, transfer_scheme,
                           velocity_scheme, flip_blend, xmin, ymin, zmin,
                           bc_x_min, bc_x_max, bc_y_min, bc_y_max, bc_z_min, bc_z_max, d_mat_tables,
                           d_mat_grid_m, d_mat_grid_v, d_mat_grid_dv, num_materials, zonal_params, d_boundary_flags, d_mat_tag,
                           enable_frictional_heating, enable_thermal_conduction, enable_impact_welding);
}

// 3b. Fused G2P + Constitutive Stress Update Kernel (Single-Pass Leapfrog / Zero L_grad VRAM Traffic)
__global__ void kernel_g2p_stress_update_3d(MPMParticle3DSoA soa, int num_particles,
                                            MPMGridNode3D* grid, int nx, int ny, int nz,
                                            float dx, float dy, float dz, float dt, int transfer_scheme,
                                            int velocity_scheme, float flip_blend,
                                            float xmin, float ymin, float zmin,
                                            int bc_x_min, int bc_x_max,
                                            int bc_y_min, int bc_y_max,
                                            int bc_z_min, int bc_z_max,
                                            const MaterialTable3D* d_mat_tables,
                                            const float* d_mat_grid_m = nullptr,
                                            const float* d_mat_grid_v = nullptr,
                                            const float* d_mat_grid_dv = nullptr,
                                            int num_materials = 1,
                                            Blast::ZonalHandoff3DParams zonal_params = {},
                                            int* d_boundary_flags = nullptr,
                                            const int* d_mat_tag = nullptr,
                                            bool enable_frictional_heating = false,
                                            bool enable_thermal_conduction = false,
                                            bool enable_impact_welding = false) {
    g2p_device_impl<true>(soa, num_particles, grid, nx, ny, nz, dx, dy, dz, dt, transfer_scheme,
                          velocity_scheme, flip_blend, xmin, ymin, zmin,
                          bc_x_min, bc_x_max, bc_y_min, bc_y_max, bc_z_min, bc_z_max, d_mat_tables,
                          d_mat_grid_m, d_mat_grid_v, d_mat_grid_dv, num_materials, zonal_params, d_boundary_flags, d_mat_tag,
                          enable_frictional_heating, enable_thermal_conduction, enable_impact_welding);
}

// 4. Stress Update Constitutive Routine (Shared by Fused G2P-Stress and Standalone Stress Update)
__device__ inline void update_particle_stress_constitutive(int p_idx, float dt, const float L[3][3], MPMParticle3DSoA soa, const MaterialTable3D& mat, float ep_smoothed, bool enable_impact_welding) {
    if ((soa.state && soa.state[p_idx] == 2) || soa.m[p_idx] <= 0.0f) return;

    float deps[3][3], W[3][3];
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            deps[r][c] = 0.5f * (L[r][c] + L[c][r]) * dt;
            W[r][c]    = 0.5f * (L[r][c] - L[c][r]);
        }
    }
    const float tr_deps = deps[0][0] + deps[1][1] + deps[2][2];

    float V0_p = soa.V0[p_idx];
    float V_p = soa.V[p_idx];
    // Physical logarithmic strain volume evolution with scale-isolated realizability bounds (Directive 19)
    const bool is_fluid_water = (mat.material_model == MPMMaterialModel::TaitWater);
    const bool is_energetic_p = (mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
                                 mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
                                 mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);
    const bool is_solid_mat = (!is_fluid_water && !is_energetic_p);
    // Physical minimum volume: solids 0.25 (P ~ 100 GPa), water 0.45 (P ~ 60 GPa), gas 0.02 (P ~ 50 GPa)
    const float V_min_limit = is_solid_mat ? (0.25f * V0_p) : (is_fluid_water ? (0.45f * V0_p) : (0.02f * V0_p));
    const float V_max_limit = is_solid_mat ? (3.0f * V0_p)  : (1.0e4f * V0_p);
    V_p = fminf(fmaxf(V_p * expf(fmaxf(fminf(tr_deps, 0.5f), -0.5f)), V_min_limit), V_max_limit);
    soa.V[p_idx] = V_p;

    float lp_val = 0.5f * cbrtf(V_p);
    soa.lp[0][p_idx] = lp_val; soa.lp[1][p_idx] = lp_val; soa.lp[2][p_idx] = lp_val;

    float sigma_p[3][3];
    load_particle_stress_matrix(soa, p_idx, sigma_p);

    bool has_failed_p = (soa.has_failed[p_idx] != 0);
    float damage_p = soa.damage[p_idx];
    float ep_bar_p = soa.ep_bar[p_idx];
    float temperature_p = soa.temperature[p_idx];
    float e_int_p = soa.e_int[p_idx];

    // Thermal sintering / solid-state forge healing when impact welding is enabled:
    // Only heals under volumetric compression (V_p < V0_p and tr_deps <= 0) at elevated homologous temperature
    // (0.75 * T_melt <= T < T_melt) when local deviatoric tearing per step is moderate (deps_eq_step < 0.025).
    // Prevents infinite self-healing of actively perforating ballistic shear bands.
    if (enable_impact_welding && is_solid_mat && mat.T_melt > mat.T_room &&
        temperature_p >= 0.75f * mat.T_melt && temperature_p < mat.T_melt &&
        V_p < V0_p && tr_deps <= 1.0e-4f) {
        float d_dev00 = deps[0][0] - tr_deps / 3.0f;
        float d_dev11 = deps[1][1] - tr_deps / 3.0f;
        float d_dev22 = deps[2][2] - tr_deps / 3.0f;
        float deps_eq_sinter = sqrtf(fmaxf(0.0f, (2.0f / 3.0f) * (
            d_dev00 * d_dev00 + d_dev11 * d_dev11 + d_dev22 * d_dev22 +
            2.0f * (deps[0][1] * deps[0][1] + deps[0][2] * deps[0][2] + deps[1][2] * deps[1][2]))));
        if (deps_eq_sinter < 0.025f) {
            damage_p = fmaxf(0.0f, damage_p - 0.15f);
            if (damage_p < 0.50f) {
                has_failed_p = false;
                soa.has_failed[p_idx] = 0;
            }
            soa.damage[p_idx] = damage_p;
        }
    }

    // --- Unified Parent Material Response for Eroded / Failed / Fractured Particles ---
    if (has_failed_p || damage_p >= 1.0f) {
        soa.has_failed[p_idx] = 1;
        soa.damage[p_idx] = 1.0f;

        bool is_concrete_model = (mat.material_model == MPMMaterialModel::RHTConcrete ||
                                  mat.material_model == MPMMaterialModel::KCConcrete ||
                                  mat.material_model == MPMMaterialModel::CSCMConcrete);

        // Preserve kinematic volume V_p > V0_p so J = V_p / V0_p > 1.0 tracks macroscopic crack/void opening
        // (bulking), requiring open voids to re-close back to J <= 1.0 before solid grain compression engages.
        // Only cap the GIMP support half-length lp at V0_p so separated fragments do not inflate stencil size.
        if (is_solid_mat && !is_concrete_model && V_p > V0_p) {
            float lp_f = 0.5f * cbrtf(V0_p);
            soa.lp[0][p_idx] = lp_f; soa.lp[1][p_idx] = lp_f; soa.lp[2][p_idx] = lp_f;
        }

        // 1. Bulk Pressure from Volumetric Compression J = V / V0 using Parent EOS
        const float J = V_p / (V0_p > 1.0e-20f ? V0_p : 1.0e-20f);
        float p_comp = 0.0f;

        float c_residual = 0.0f;
        float sigma_t_rubble = 0.0f;
        if (is_concrete_model) {
            // Aggregate interlocking and unbroken mortar cohesion with post-failure plastic strain softening
            float c0 = fmaxf(0.04f * mat.fc, 0.8e6f);
            float ep_debris = fmaxf(0.0f, ep_bar_p - 0.01f);
            c_residual = c0 * expf(-ep_debris / 0.08f);
            sigma_t_rubble = fminf(c_residual * 0.20f, 0.10f * mat.ft);
        }

        if (J < 1.0f) {
            if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen && mat.mg_c0 > 0.0f) {
                const float mu_vol = (1.0f - J) / fmaxf(0.25f, J);
                p_comp = fmaxf(0.0f, Blast::Materials::mie_gruneisen_compression_pressure<float>(
                    mat.density, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mu_vol, 0.0f));
            } else {
                const float E_mod    = mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f;
                const float nu       = fminf(fmaxf(mat.poissons_ratio, 0.01f), 0.49f);
                const float K_parent = E_mod / (3.0f * (1.0f - 2.0f * nu));
                p_comp = K_parent * (1.0f - J) / fmaxf(0.01f, J);
            }
        } else if (is_concrete_model && sigma_t_rubble > 0.0f) {
            // Softened tensile resistance for cohesive rubble chunks
            const float E_mod    = mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 30.0e9f;
            const float nu       = fminf(fmaxf(mat.poissons_ratio, 0.01f), 0.49f);
            const float K_parent = E_mod / (3.0f * (1.0f - 2.0f * nu));
            float p_unconfined   = K_parent * (1.0f - J) / fmaxf(0.01f, J);
            p_comp = fmaxf(p_unconfined, -sigma_t_rubble);
        }

        // 2. Frictional Shear Resistance under Confinement (Mohr-Coulomb / Drucker-Prager: q <= c_res + M * p_comp)
        //    Concrete rubble: aggregate friction M = 0.6 plus decaying cohesion.
        //    Fractured metals: intergranular Coulomb friction under compression, capped by the intact
        //    quasi-static yield; zero shear in tension (open cracks) and zero shear once molten.
        float q_max = c_residual;
        if (is_concrete_model) {
            q_max = c_residual + 0.60f * fmaxf(0.0f, p_comp);
        } else if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen ||
                   mat.material_model == MPMMaterialModel::Hypoelastic ||
                   mat.material_model == MPMMaterialModel::LinearElastic) {
            const bool is_jc = (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen);
            const float sigma_y_intact = is_jc ? mat.jc_A : mat.yield_stress;
            const bool melted = is_jc && (mat.T_melt > mat.T_room) && (temperature_p >= mat.T_melt);
            q_max = Blast::Materials::fractured_metal_residual_strength<float>(p_comp, sigma_y_intact, melted);
        }

        if (q_max <= 1.0e-5f) {
            store_particle_stress_isotropic(soa, p_idx, p_comp);
            return;
        }

        const float E_mod = mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f;
        const float nu = fminf(fmaxf(mat.poissons_ratio, 0.01f), 0.49f);
        const float mu_parent = E_mod / (2.0f * (1.0f + nu));

        float deps_dev[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c) {
                deps_dev[r][c] = deps[r][c];
                if (r == c) deps_dev[r][c] -= tr_deps / 3.0f;
            }

        float sig_rot_f[3][3];
        rotate_stress_cayley_3d(sigma_p, W, dt, sig_rot_f);

        float s_trial[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                s_trial[r][c] = sig_rot_f[r][c] + 2.0f * mu_parent * deps_dev[r][c];

        float press_s = -(s_trial[0][0] + s_trial[1][1] + s_trial[2][2]) / 3.0f;
        for (int r = 0; r < 3; ++r)
            s_trial[r][r] += press_s;

        float s_s = 0.0f;
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                s_s += s_trial[r][c] * s_trial[r][c];
        float q_trial = sqrtf(1.5f * s_s);

        if (q_trial > q_max && q_trial > 1.0e-7f) {
            float scale = q_max / q_trial;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_trial[r][c] *= scale;
        }

        for (int r = 0; r < 3; ++r)
            s_trial[r][r] -= p_comp;
        store_particle_stress_matrix(soa, p_idx, s_trial);

        return;
    }

    // --- Linear Elastic Model (Hooke's Law with Orthogonal Cayley Stress Rotation) ---
    if (mat.material_model == MPMMaterialModel::LinearElastic) {
        const float J = V_p / (V0_p > 1.0e-20f ? V0_p : 1.0e-20f);

        float sig_base[3][3];
        rotate_stress_cayley_3d(sigma_p, W, dt, sig_base);

        const float E_mod    = mat.youngs_modulus;
        const float nu_val   = mat.poissons_ratio;
        const float mu_shear = E_mod / (2.0f * (1.0f + nu_val));
        const float K_bulk   = E_mod / (3.0f * fmaxf(0.01f, 1.0f - 2.0f * nu_val));

        float deps_dev[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c) {
                deps_dev[r][c] = deps[r][c];
                if (r == c) deps_dev[r][c] -= tr_deps / 3.0f;
            }

        float s_trial[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                s_trial[r][c] = sig_base[r][c] + 2.0f * mu_shear * deps_dev[r][c];

        float p_s = -(s_trial[0][0] + s_trial[1][1] + s_trial[2][2]) / 3.0f;
        for (int r = 0; r < 3; ++r)
            s_trial[r][r] += p_s;

        float p_hydro = K_bulk * (1.0f - J) / fmaxf(0.01f, J);
        for (int r = 0; r < 3; ++r)
            s_trial[r][r] -= p_hydro;
        store_particle_stress_matrix(soa, p_idx, s_trial);
        return;
    }

    // --- Tait Fluid Model (Weakly Compressible & Shock Water) ---
    if (mat.material_model == MPMMaterialModel::TaitWater) {
        const float J = soa.V[p_idx] / (soa.V0[p_idx] > 1.0e-20f ? soa.V0[p_idx] : 1.0e-20f);
        float h_elem = cbrtf(soa.V[p_idx]);
        float p_hydro = 0.0f;
        float sig_tait[3][3] = {};

        Blast::Materials::update_constitutive_tait_fluid(
            mat.tait_B, mat.tait_gamma, mat.tait_rho0, mat.tait_viscosity, mat.tait_p_cav,
            mat.tait_gruneisen, mat.tait_variant,
            J, dt, h_elem, soa.e_int[p_idx], deps, sig_tait, p_hydro,
            mat.bulk_viscosity_b1 > 0.0f ? mat.bulk_viscosity_b1 : 0.06f,
            mat.bulk_viscosity_b2 > 0.0f ? mat.bulk_viscosity_b2 : 1.20f,
            mat.tait_p0
        );

        float rho_p = mat.tait_rho0 / fmaxf(0.05f, J);
        float work_rate = 0.0f;
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                work_rate += sig_tait[r][c] * (deps[r][c] / fmaxf(1e-12f, dt));
            }
        }
        soa.e_int[p_idx] += (work_rate / rho_p) * dt;
        if (soa.e_int[p_idx] < 0.0f) soa.e_int[p_idx] = 0.0f;

        store_particle_stress_matrix(soa, p_idx, sig_tait);
        return;
    }

    // --- Hyperelastic Model: Yeoh Strain Energy Function ---
    if (mat.material_model == MPMMaterialModel::HyperelasticYeoh) {
        float sig_base[3][3];
        rotate_stress_cayley_3d(sigma_p, W, dt, sig_base);

        float F_inc[3][3] = {
            {1.0f + deps[0][0], deps[0][1], deps[0][2]},
            {deps[1][0], 1.0f + deps[1][1], deps[1][2]},
            {deps[2][0], deps[2][1], 1.0f + deps[2][2]}
        };
        float s_yeoh[3][3] = {};
        Blast::Materials::update_constitutive_yeoh(
            mat.yeoh_c10, mat.yeoh_c20, mat.yeoh_c30, mat.k_bulk, F_inc, s_yeoh
        );

        float s_updated[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                s_updated[r][c] = sig_base[r][c] + s_yeoh[r][c];

        store_particle_stress_matrix(soa, p_idx, s_updated);
        return;
    }

    // --- Hyperelastic Model: Mooney-Rivlin Strain Energy Function ---
    if (mat.material_model == MPMMaterialModel::HyperelasticMooneyRivlin) {
        float sig_base[3][3];
        rotate_stress_cayley_3d(sigma_p, W, dt, sig_base);

        float F_inc[3][3] = {
            {1.0f + deps[0][0], deps[0][1], deps[0][2]},
            {deps[1][0], 1.0f + deps[1][1], deps[1][2]},
            {deps[2][0], deps[2][1], 1.0f + deps[2][2]}
        };
        float s_mr[3][3] = {};
        Blast::Materials::update_constitutive_mooney_rivlin(
            mat.mr_c10, mat.mr_c01, mat.k_bulk, F_inc, s_mr
        );

        float s_updated[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                s_updated[r][c] = sig_base[r][c] + s_mr[r][c];

        store_particle_stress_matrix(soa, p_idx, s_updated);
        return;
    }

    // --- Concrete Damage Plasticity (CDP) Model ---
    if (mat.material_model == MPMMaterialModel::ConcreteDamagePlasticity) {
        rotate_stress_cayley_3d(sigma_p, W, dt, sigma_p);
        float d_t = soa.damage[p_idx];
        float d_c = 0.0f;
        float ep_t = soa.ep_bar[p_idx];
        float ep_c = 0.0f;

        Blast::Materials::update_constitutive_cdp(
            mat.youngs_modulus, mat.poissons_ratio, mat.cdp_f_t0, mat.cdp_f_c0, mat.cdp_g_f, mat.cdp_l_ch,
            deps, sigma_p, d_t, d_c, ep_t, ep_c
        );

        soa.damage[p_idx] = fmaxf(d_t, d_c);
        soa.ep_bar[p_idx] = ep_t + ep_c;
        store_particle_stress_matrix(soa, p_idx, sigma_p);
        return;
    }

    // --- Hill48 Orthotropic Plasticity Model ---
    if (mat.material_model == MPMMaterialModel::Hill48Orthotropic) {
        rotate_stress_cayley_3d(sigma_p, W, dt, sigma_p);

        float s_dev[3][3];
        float p_mean = (sigma_p[0][0] + sigma_p[1][1] + sigma_p[2][2]) / 3.0f;
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                s_dev[r][c] = sigma_p[r][c] - (r == c ? p_mean : 0.0f);

        float ep_bar_prev_h = ep_bar_p;
        Blast::Materials::update_constitutive_hill48(
            mat.hill_F, mat.hill_G, mat.hill_H, mat.hill_L, mat.hill_M, mat.hill_N,
            mat.hill_sigma_y0, deps, s_dev, ep_bar_p
        );

        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                sigma_p[r][c] = s_dev[r][c] + (r == c ? p_mean : 0.0f);

        if (ep_smoothed > 0.0f && ep_bar_p > ep_bar_prev_h) {
            ep_bar_p = fmaxf(ep_bar_prev_h, 0.90f * ep_bar_p + 0.10f * ep_smoothed);
        }
        soa.ep_bar[p_idx] = ep_bar_p;
        store_particle_stress_matrix(soa, p_idx, sigma_p);
        return;
    }

    // --- Drucker-Prager Soil Mechanics with Conical Return Mapping ---
    if (mat.material_model == MPMMaterialModel::DruckerPragerSoil) {
        float sig_base[3][3];
        rotate_stress_cayley_3d(sigma_p, W, dt, sig_base);

        float p_hydro = -(sig_base[0][0] + sig_base[1][1] + sig_base[2][2]) / 3.0f;
        float s_dev[3][3];
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                s_dev[r][c] = sig_base[r][c] + (r == c ? p_hydro : 0.0f);
            }
        }

        Blast::Materials::DruckerPragerParams<float> dp_p;
        dp_p.cohesion = mat.dp_cohesion;
        dp_p.friction_angle = mat.dp_friction_angle * 3.14159265f / 180.0f;
        dp_p.dilatancy_angle = mat.dp_dilatancy_angle * 3.14159265f / 180.0f;
        dp_p.tensile_cutoff = mat.dp_tensile_cutoff;
        dp_p.H_plastic = mat.dp_hardening_modulus;

        float ep_bar_val = ep_bar_p;
        Blast::Materials::update_constitutive_drucker_prager<float>(
            mat.youngs_modulus, mat.poissons_ratio, dp_p,
            deps, s_dev, p_hydro, ep_bar_val
        );
        soa.ep_bar[p_idx] = ep_bar_val;
        soa.damage[p_idx] = fminf(1.0f, ep_bar_val / 0.05f);

        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                sigma_p[r][c] = s_dev[r][c] - (r == c ? p_hydro : 0.0f);
            }
        }
        store_particle_stress_matrix(soa, p_idx, sigma_p);
        return;
    }

    // --- Three-Pillar Energetic Material Architecture ---
    // Pillar 1: Solid Reactant EOS (Mie-Grüneisen / Davis Solid)
    // Pillar 2: Reaction Kinetics (Programmed Wavefront / Lee-Tarver 3-Stage ODE / CREST Entropy)
    // Pillar 3: Detonation Products EOS (JWL Product Gas / Davis Detonation Product)
    if (mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
        mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
        mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth) {

        const float v_rel = fmaxf(V_p / (V0_p > 1.0e-20f ? V0_p : 1.0e-20f), 0.02f);
        float lam_curr = soa.lambda ? soa.lambda[p_idx] : 0.0f;
        float lam_new = lam_curr;

        // Pillar 2: Reaction Kinetics Rate Law
        bool is_crest_kinetics = (mat.burn_model == ReactionKinetics::CRESTEntropy) ||
                                 (mat.material_model == MPMMaterialModel::CRESTReactiveBurn && mat.burn_model != ReactionKinetics::LeeTarverODE);
        bool is_lt_kinetics = (mat.burn_model == ReactionKinetics::LeeTarverODE) ||
                              (mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth && mat.burn_model != ReactionKinetics::CRESTEntropy);

        bool use_davis_solid = (mat.solid_model == SolidReactantEOS::DavisSolid) ||
                               (mat.material_model == MPMMaterialModel::CRESTReactiveBurn);
        bool use_davis_prod = (mat.product_model == DetonationProductEOS::DavisProduct) ||
                              (mat.material_model == MPMMaterialModel::CRESTReactiveBurn);

        if (is_crest_kinetics) {
            float v_min_val = soa.v_min ? soa.v_min[p_idx] : 1.0f;
            v_min_val = fminf(v_min_val, v_rel);
            if (soa.v_min) soa.v_min[p_idx] = v_min_val;

            float s_calc = CrestDavis::computeDavisShockEntropy(v_min_val, mat.davis_c0, mat.davis_s1, mat.davis_gamma0, mat.davis_cv, mat.davis_t0, mat.davis_rho0);
            float s_shock_val = soa.s_shock ? soa.s_shock[p_idx] : 0.0f;
            s_shock_val = fmaxf(s_shock_val, s_calc);

            float q_heat_trial = use_davis_prod ? mat.davis_q_det : mat.detonation_energy;
            float e_th_trial = fmaxf(0.0f, e_int_p - lam_curr * q_heat_trial);
            float p_curr_comp = -(sigma_p[0][0] + sigma_p[1][1] + sigma_p[2][2]) / 3.0f;
            float p_react_trial = use_davis_solid
                ? CrestDavis::computeDavisReactantPressure(v_rel, e_th_trial, mat.davis_c0, mat.davis_s1, mat.davis_gamma0, mat.davis_cv, mat.davis_t0, mat.davis_rho0)
                : JWL::computeSolidReactantPressure(v_rel, e_th_trial, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mat.density);
            float p_eff_comp = (lam_curr <= 1.0e-5f) ? fmaxf(p_curr_comp, p_react_trial) : p_react_trial;
            if (p_eff_comp > 1.0e6f) {
                float s_p = CrestDavis::computeDavisShockEntropyFromPressure(p_eff_comp, mat.davis_c0, mat.davis_s1, mat.davis_cv, mat.davis_t0, mat.davis_rho0);
                s_shock_val = fmaxf(s_shock_val, s_p);
            }

            if (soa.s_shock) soa.s_shock[p_idx] = s_shock_val;

            lam_new = CrestDavis::advanceCRESTProgress(dt, s_shock_val, lam_curr, mat.crest_b1, mat.crest_c1, mat.crest_m1, mat.crest_b2, mat.crest_c2, mat.crest_c3, mat.crest_m2, mat.crest_s0, mat.crest_s_threshold);
        } else if (is_lt_kinetics) {
            float p_curr = -(sigma_p[0][0] + sigma_p[1][1] + sigma_p[2][2]) / 3.0f;
            if (p_curr < 0.0f) p_curr = 0.0f;

            lam_new = LeeTarver::advanceLeeTarver(dt, lam_curr, v_rel, p_curr,
                mat.lt_I, mat.lt_a, mat.lt_b, mat.lt_x, mat.lt_ig_max,
                mat.lt_G1, mat.lt_c, mat.lt_d, mat.lt_y, mat.lt_growth_max,
                mat.lt_G2, mat.lt_e, mat.lt_g, mat.lt_z, mat.lt_comp_min);
        } else {
            // Programmed Wavefront Burn
            float t_arr = soa.t_arrival ? soa.t_arrival[p_idx] : 1.0e10f;
            float eff_dx = (mat.cell_dx > 0.0f) ? mat.cell_dx : fmaxf(2.0f * cbrtf(V0_p), 0.01f);
            float tau_burn = fmaxf(static_cast<float>(mat.burn_zone_cells) * eff_dx / fmaxf(mat.det_vel, 100.0f), mat.tau_burn_min);
            float lam_prog = JWL::computeProgrammedProgress(d_current_sim_time, t_arr, tau_burn);
            lam_new = fmaxf(lam_curr, lam_prog);
        }

        if (soa.lambda) soa.lambda[p_idx] = lam_new;
        float d_lam = fmaxf(0.0f, lam_new - lam_curr);

        // Energy bookkeeping: e_int holds the TOTAL specific internal energy, i.e. the thermal /
        // compression part plus the chemical energy already released, e_int = e_th + lambda * q.
        // Each phase EOS must therefore see:
        //   solid reactant:      e_th          = e_int - lambda * q
        //   detonation products: e_th + q      = e_int + (1 - lambda) * q
        // (passing e_int + q to the products EOS would count the released chemical energy twice).
        float q_heat = use_davis_prod ? mat.davis_q_det : mat.detonation_energy;
        float e_th = e_int_p - lam_curr * q_heat;
        float e_prod = e_th + q_heat;

        // Pillar 1: Solid Reactant EOS (Mie-Grüneisen / Davis). The ambient confining pressure is
        // carried by the reference compression set at initialisation (v_rel < 1), so the EOS is
        // evaluated directly from (v_rel, e_th) without any stress-history offset.
        float p_solid = use_davis_solid
            ? CrestDavis::computeDavisReactantPressure(v_rel, e_th, mat.davis_c0, mat.davis_s1, mat.davis_gamma0, mat.davis_cv, mat.davis_t0, mat.davis_rho0)
            : JWL::computeSolidReactantPressure(v_rel, e_th, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mat.density);

        // Pillar 3: Detonation Products EOS
        float p_prod = use_davis_prod
            ? CrestDavis::computeDavisProductPressure(v_rel, e_prod, mat.davis_a, mat.davis_b, mat.davis_k, mat.davis_vc, mat.davis_pc, mat.davis_q_det, mat.davis_rho0)
            : JWL::computeJWLProductPressure(v_rel, e_prod, mat.jwl_A, mat.jwl_B, mat.jwl_R1, mat.jwl_R2, mat.jwl_omega, mat.density);

        // Two-phase pressure blend
        float p_mix = (1.0f - lam_new) * p_solid + lam_new * p_prod;
        if (p_mix < 1.0e-6f) p_mix = 1.0e-6f;

        float rho_ref = (mat.density > 10.0f) ? mat.density : (use_davis_solid ? mat.davis_rho0 : 1630.0f);
        float rho_cur = rho_ref / v_rel;

        // Artificial bulk viscosity (von Neumann-Richtmyer + Landshoff linear term), identical in form
        // and coefficients to the Tait water branch, active only under compression:
        //   q = rho * ( b1 * c * h * |tr D| + b2 * h^2 * (tr D)^2 ),  h = V_p^(1/3)
        // Without it, shocks reflecting inside the products bubble ring at the particle scale.
        float q_visc = 0.0f;
        {
            float tr_D = tr_deps / fmaxf(1.0e-12f, dt);
            if (tr_D < 0.0f) {
                float h_elem = cbrtf(V_p);
                float c_solid = use_davis_solid ? mat.davis_c0 : mat.mg_c0;
                float c_prod = JWL::computeJWLSoundSpeed(v_rel, fmaxf(p_prod, 1.0f), mat.jwl_A, mat.jwl_B, mat.jwl_R1, mat.jwl_R2, mat.jwl_omega, rho_ref);
                float c_mix = (1.0f - lam_new) * fmaxf(c_solid, 0.0f) + lam_new * c_prod;
                float b1 = mat.bulk_viscosity_b1 > 0.0f ? mat.bulk_viscosity_b1 : 0.06f;
                float b2 = mat.bulk_viscosity_b2 > 0.0f ? mat.bulk_viscosity_b2 : 1.20f;
                float M_comp = h_elem * fabsf(tr_D) / fmaxf(1.0f, c_mix);
                float b1_eff = (M_comp > 0.02f) ? b1 : (b1 * 50.0f * M_comp);
                float b2_eff = (M_comp > 0.05f) ? b2 : (b2 * 20.0f * M_comp);
                q_visc = rho_cur * (b1_eff * c_mix * h_elem * fabsf(tr_D) + b2_eff * h_elem * h_elem * tr_D * tr_D);
                float q_max = 1.5f * rho_cur * c_mix * fminf(2500.0f, h_elem * fabsf(tr_D));
                q_visc = fminf(q_max, q_visc);
            }
        }
        const float p_total = p_mix + q_visc;

        // Energy conservation: p dV work in BOTH compression and expansion, plus chemical heat release.
        //   de = -((p + q) / rho) * tr(d_eps),  rho = rho0 / v_rel  (current density, not reference density)
        // Expansion work (tr(d_eps) > 0) is what cools the products along the JWL isentrope.
        float de_comp = -(p_total / rho_cur) * tr_deps;
        if (v_rel > 2.0f && tr_deps < 0.0f) {
            // For highly expanded detonation product gas, limit unphysical numerical compression shock heating
            de_comp = fminf(de_comp, 0.05f * e_int_p);
        }
        float de_chem = d_lam * q_heat;
        e_int_p += de_comp + de_chem;
        // Realizability limiter (Directive 19): total specific internal energy cannot be negative.
        if (e_int_p < 0.0f) e_int_p = 0.0f;
        if (soa.e_int) soa.e_int[p_idx] = e_int_p;

        float cv_eff = use_davis_solid ? (mat.davis_cv > 1.0f ? mat.davis_cv : 1000.0f) : (mat.Cp > 1.0f ? mat.Cp : 1000.0f);
        float t0_eff = use_davis_solid ? mat.davis_t0 : mat.T_room;
        temperature_p = t0_eff + e_int_p / cv_eff;
        if (soa.temperature) soa.temperature[p_idx] = temperature_p;


        // Solid shear stress relaxation with radial return plasticity
        float sig_base[3][3];
        rotate_stress_cayley_3d(sigma_p, W, dt, sig_base);

        const float E_mod    = mat.youngs_modulus;
        const float nu_val   = mat.poissons_ratio;
        const float mu_shear = (1.0f - lam_new) * (E_mod / (2.0f * (1.0f + nu_val)));

        float deps_dev[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c) {
                deps_dev[r][c] = deps[r][c];
                if (r == c) deps_dev[r][c] -= tr_deps / 3.0f;
            }

        float s_trial[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                s_trial[r][c] = (1.0f - lam_new) * (sig_base[r][c] + 2.0f * mu_shear * deps_dev[r][c]);

        float p_s = -(s_trial[0][0] + s_trial[1][1] + s_trial[2][2]) / 3.0f;
        for (int r = 0; r < 3; ++r)
            s_trial[r][r] += p_s;

        // Radial return plasticity for solid phase
        float s_mag_sq = 0.0f;
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                s_mag_sq += s_trial[r][c] * s_trial[r][c];
        float q_trial = sqrtf(1.5f * s_mag_sq);
        float q_yield = (1.0f - lam_new) * (mat.yield_stress > 1.0e5f ? mat.yield_stress : 100.0e6f);
        if (q_trial > q_yield && q_trial > 1.0e-6f) {
            float scale = q_yield / q_trial;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_trial[r][c] *= scale;
        }

        for (int r = 0; r < 3; ++r)
            s_trial[r][r] -= p_total;
        store_particle_stress_matrix(soa, p_idx, s_trial);
        return;
    }

    // --- Johnson-Cook Plasticity + Mie-Grüneisen Shock EOS Model ---
    if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen) {
        float w_factor = (mat.enable_heterogeneity && soa.weibull_factor && soa.weibull_factor[p_idx] > 0.001f) ? soa.weibull_factor[p_idx] : 1.0f;

        const float J = fmaxf(0.25f, V_p / (V0_p > 1.0e-20f ? V0_p : 1.0e-20f));
        const float mu_vol = (1.0f - J) / J;

        float p_hydro = 0.0f;
        if (mu_vol > 0.0f) {
            p_hydro = Blast::Materials::mie_gruneisen_compression_pressure<float>(
                mat.density, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mu_vol, e_int_p);
        } else {
            p_hydro = mat.density * mat.mg_c0 * mat.mg_c0 * mu_vol;
        }

        float sig_base[3][3];
        rotate_stress_cayley_3d(sigma_p, W, dt, sig_base);

        const float E_mod    = mat.youngs_modulus;
        const float nu_val   = mat.poissons_ratio;
        const float mu_shear = E_mod / (2.0f * (1.0f + nu_val));

        float deps_dev[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c) {
                deps_dev[r][c] = deps[r][c];
                if (r == c) deps_dev[r][c] -= tr_deps / 3.0f;
            }

        float s_trial[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                s_trial[r][c] = sig_base[r][c] + 2.0f * mu_shear * deps_dev[r][c];

        float p_s = -(s_trial[0][0] + s_trial[1][1] + s_trial[2][2]) / 3.0f;
        for (int r = 0; r < 3; ++r)
            s_trial[r][r] += p_s;

        float s_s = 0.0f;
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                s_s += s_trial[r][c] * s_trial[r][c];
        const float q_trial = sqrtf(1.5f * s_s);

        float deps_eq = sqrtf(fmaxf(0.0f, (2.0f / 3.0f) * (deps_dev[0][0]*deps_dev[0][0] + deps_dev[1][1]*deps_dev[1][1] + deps_dev[2][2]*deps_dev[2][2] +
                              2.0f * (deps_dev[0][1]*deps_dev[0][1] + deps_dev[0][2]*deps_dev[0][2] + deps_dev[1][2]*deps_dev[1][2]))));
        float ep_dot_star = fmaxf(1.0f, deps_eq / (dt > 1e-12f ? dt : 1e-12f));
        float T_star = fminf(fmaxf((temperature_p - mat.T_room) / (mat.T_melt > mat.T_room ? mat.T_melt - mat.T_room : 1.0f), 0.0f), 1.0f);

        float term_strain = mat.jc_A + mat.jc_B * powf(fmaxf(0.0f, ep_bar_p), mat.jc_n);
        float term_rate   = 1.0f + mat.jc_C * logf(ep_dot_star);
        float term_temp   = 1.0f - powf(T_star, mat.jc_m);
        if (term_temp < 0.0f) term_temp = 0.0f;

        float aniso_factor = 1.0f;
        if (mat.enable_anisotropy && fabsf(mat.anisotropy_ratio - 1.0f) > 0.001f) {
            float ax = mat.anisotropy_dir[0], ay = mat.anisotropy_dir[1], az = mat.anisotropy_dir[2];
            float sigma_a = ax * (s_trial[0][0]*ax + s_trial[0][1]*ay + s_trial[0][2]*az) +
                            ay * (s_trial[1][0]*ax + s_trial[1][1]*ay + s_trial[1][2]*az) +
                            az * (s_trial[2][0]*ax + s_trial[2][1]*ay + s_trial[2][2]*az);
            float q_norm = (q_trial > 1e-12f) ? q_trial : 1.0f;
            float xi = fminf(fmaxf(fabsf(sigma_a) / q_norm, 0.0f), 1.0f);
            aniso_factor = 1.0f + (mat.anisotropy_ratio - 1.0f) * (1.0f - xi * xi);
        }

        const float fail_strain_base = ((mat.enable_strain_erosion && mat.erosion_strain > 0.0f) ? mat.erosion_strain : mat.failure_strain) * w_factor * aniso_factor;
        const float tensile_fail_base = ((mat.enable_stress_erosion && mat.erosion_stress > 0.0f) ? mat.erosion_stress : mat.tensile_failure_stress) * w_factor * aniso_factor;
        const float p_spall_limit = fmaxf(tensile_fail_base, 1.5f * mat.jc_A * w_factor * aniso_factor);
        const float p_hydro_raw = p_hydro;
        if (p_spall_limit > 0.0f && p_hydro < 0.0f) {
            p_hydro = fmaxf(p_hydro, -p_spall_limit * fmaxf(0.0f, 1.0f - damage_p));
        }

        // Johnson-Cook flow stress. Damage is UNCOUPLED from strength until fracture (D = 1), per the
        // original JC formulation; Weibull flaw statistics govern fracture thresholds only (failure
        // strain, spall strength) and never the ductile plastic flow stress.
        float jc_yield = term_strain * term_rate * term_temp * aniso_factor;
        if (T_star >= 1.0f) {
            // Melted metal behaves hydrodynamically: zero deviatoric shear stress while preserving affine B_p
            store_particle_stress_isotropic(soa, p_idx, p_hydro);
            return;
        }

        float H_jc = (mat.jc_n > 0.0f && ep_bar_p > 1.0e-6f)
            ? (mat.jc_n * mat.jc_B * powf(ep_bar_p, mat.jc_n - 1.0f) * term_rate * term_temp)
            : mat.hardening_modulus;
        float ep_bar_prev_jc = ep_bar_p;
        float delta_ep = 0.0f;
        if (q_trial > 1.0e-5f && q_trial > jc_yield) {
            delta_ep = (q_trial - jc_yield) / (3.0f * mu_shear + H_jc);
            float scale = (q_trial > 1e-12f) ? (jc_yield / q_trial) : 0.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_trial[r][c] *= scale;
            ep_bar_p += delta_ep;
            soa.ep_bar[p_idx] = ep_bar_p;
        }
        if (ep_smoothed > 0.0f && delta_ep > 0.0f) {
            ep_bar_p = fmaxf(ep_bar_prev_jc, 0.90f * ep_bar_p + 0.10f * ep_smoothed);
            soa.ep_bar[p_idx] = ep_bar_p;
        }

        if (delta_ep > 0.0f && mat.density > 0.0f && mat.Cp > 0.0f) {
            float dw_p = jc_yield * delta_ep;
            float de_p = (0.90f * dw_p) / mat.density;
            e_int_p += de_p;
            temperature_p = mat.T_room + e_int_p / mat.Cp;
            soa.e_int[p_idx] = e_int_p;
            soa.temperature[p_idx] = temperature_p;
        }

        // Johnson-Cook triaxiality, strain-rate, and temperature fracture criterion
        const float jc_flow_undamaged = fmaxf(term_strain * term_rate * term_temp * aniso_factor, 1.0e6f);
        const float sigma_star = fminf(fmaxf(-p_hydro_raw / jc_flow_undamaged, -2.5f), 2.5f);
        const float jc_triax = fmaxf(0.02f, mat.jc_d1 + mat.jc_d2 * expf(mat.jc_d3 * sigma_star));
        const float triax_ratio = Blast::Materials::jc_fracture_triaxiality_ratio<float>(mat.jc_d1, mat.jc_d2, mat.jc_d3, sigma_star);
        const float jc_rate_f = fmaxf(0.1f, 1.0f + mat.jc_d4 * logf(ep_dot_star));
        const float jc_temp_f = fmaxf(0.1f, 1.0f + mat.jc_d5 * T_star);
        const float eps_f = (fail_strain_base > 0.0f && mat.jc_d1 <= 0.20f)
            ? fmaxf(0.01f, fail_strain_base * triax_ratio * jc_rate_f * jc_temp_f)
            : fmaxf(0.01f, jc_triax * jc_rate_f * jc_temp_f * w_factor * aniso_factor);

        if (delta_ep > 0.0f && eps_f > 0.0f) {
            damage_p = fminf(1.0f, damage_p + delta_ep / eps_f);
        }
        if (mat.enable_strain_erosion && fail_strain_base > 0.0f) {
            damage_p = fmaxf(damage_p, fminf(fmaxf(ep_bar_p / fail_strain_base, 0.0f), 1.0f));
        }

        if (p_spall_limit > 0.0f && (-p_hydro_raw) > p_spall_limit) {
            if (mat.enable_stress_erosion) {
                damage_p = fmaxf(damage_p, fminf((-p_hydro_raw) / p_spall_limit, 1.0f));
            } else if (J > 1.025f && tr_deps > 0.0f) {
                float spall_over = ((-p_hydro_raw) - p_spall_limit) / p_spall_limit;
                damage_p = fminf(1.0f, damage_p + 0.5f * spall_over);
            }
        }

        soa.damage[p_idx] = damage_p;
        if (p_spall_limit > 0.0f && p_hydro < 0.0f) {
            p_hydro = fmaxf(p_hydro, -p_spall_limit * fmaxf(0.0f, 1.0f - damage_p));
        }

        if (damage_p >= 1.0f) {
            soa.has_failed[p_idx] = 1;
            soa.damage[p_idx] = 1.0f;
            if (V_p > V0_p) {
                float lp_f = 0.5f * cbrtf(V0_p);
                soa.lp[0][p_idx] = lp_f; soa.lp[1][p_idx] = lp_f; soa.lp[2][p_idx] = lp_f;
            }

            const float J_eff = V_p / (V0_p > 1.0e-20f ? V0_p : 1.0e-20f);
            float p_comp = 0.0f;
            if (J_eff < 1.0f) {
                if (mat.mg_c0 > 0.0f) {
                    const float mu_vol_c = (1.0f - J_eff) / fmaxf(0.25f, J_eff);
                    p_comp = fmaxf(0.0f, Blast::Materials::mie_gruneisen_compression_pressure<float>(
                        mat.density, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mu_vol_c, 0.0f));
                } else {
                    const float E_mod_d  = mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f;
                    const float nu_d     = fminf(fmaxf(mat.poissons_ratio, 0.01f), 0.49f);
                    const float K_parent = E_mod_d / (3.0f * (1.0f - 2.0f * nu_d));
                    p_comp = K_parent * (1.0f - J_eff) / fmaxf(0.01f, J_eff);
                }
            }
            // Fractured metal keeps confined Coulomb shear (s_trial is deviatoric and already returned to jc_yield)
            const float q_res = Blast::Materials::fractured_metal_residual_strength<float>(p_comp, mat.jc_A, false);
            float s_s_f = 0.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_s_f += s_trial[r][c] * s_trial[r][c];
            const float q_cur = sqrtf(1.5f * s_s_f);
            const float s_scale = (q_cur > q_res && q_cur > 1.0e-7f) ? (q_res / q_cur) : 1.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_trial[r][c] *= s_scale;
            for (int r = 0; r < 3; ++r)
                s_trial[r][r] -= p_comp;
            store_particle_stress_matrix(soa, p_idx, s_trial);
            return;
        }

        for (int r = 0; r < 3; ++r)
            s_trial[r][r] -= p_hydro;
        store_particle_stress_matrix(soa, p_idx, s_trial);
        return;
    }

    // --- Standard Hypoelastic Model ---
    float sig_base[3][3];
    rotate_stress_cayley_3d(sigma_p, W, dt, sig_base);

    const float E_mod  = mat.youngs_modulus;
    const float nu     = mat.poissons_ratio;
    const float mu     = E_mod / (2.0f * (1.0f + nu));
    const float lambda = (E_mod * nu) / ((1.0f + nu) * (1.0f - 2.0f * nu));
    const float K_bulk = E_mod / (3.0f * (1.0f - 2.0f * nu));

    float sig_trial[3][3];
    for (int r = 0; r < 3; ++r)
        for (int c = 0; c < 3; ++c) {
            sig_trial[r][c] = sig_base[r][c] + 2.0f * mu * deps[r][c];
            if (r == c) sig_trial[r][c] += lambda * tr_deps;
        }

    float press = -(sig_trial[0][0] + sig_trial[1][1] + sig_trial[2][2]) / 3.0f;
    float s[3][3];
    for (int r = 0; r < 3; ++r)
        for (int c = 0; c < 3; ++c) {
            s[r][c] = sig_trial[r][c];
            if (r == c) s[r][c] += press;
        }

    float char_len_p = fmaxf(cbrtf(V_p > 1.0e-20f ? V_p : 1.0e-6f), 1.25f * cbrtf(V0_p > 1.0e-20f ? V0_p : 1.0e-6f));
    float deps_norm = 0.0f;
    for (int r = 0; r < 3; ++r)
        for (int c = 0; c < 3; ++c)
            deps_norm += deps[r][c] * deps[r][c];
    float ep_dot = sqrtf((2.0f / 3.0f) * deps_norm) / (dt > 1.0e-12f ? dt : 1.0e-12f);
    float lambda_p = soa.lambda ? soa.lambda[p_idx] : 0.0f;
    float w_factor = (mat.enable_heterogeneity && soa.weibull_factor && soa.weibull_factor[p_idx] > 0.001f) ? soa.weibull_factor[p_idx] : 1.0f;

    if (mat.material_model == MPMMaterialModel::RHTConcrete) {
        RHTStateVariables<float> rht_state;
        rht_state.damage = damage_p;
        rht_state.ep_bar = ep_bar_p;
        rht_state.p_hydro = press;
        updateRHTStress<float>(
            s, press, tr_deps, dt, char_len_p, ep_dot,
            mat.fc * w_factor, mat.ft * w_factor, mu, K_bulk,
            mat.G_f, mat.moisture_content,
            mat.rht_A, mat.rht_N,
            mat.rht_B, mat.rht_M,
            mat.rht_Q0, mat.rht_BQ,
            mat.rht_D1, mat.rht_D2,
            mat.rht_p_crush, mat.rht_p_lock,
            mat.rht_alpha0, mat.rht_n_comp,
            mat.rht_betac, mat.rht_deltat,
            mat.dif_cap_compression, mat.dif_cap_tension,
            rht_state
        );
        damage_p = rht_state.damage;
        ep_bar_p = rht_state.ep_bar;
        press = rht_state.p_hydro;
        soa.damage[p_idx] = damage_p;
        soa.ep_bar[p_idx] = ep_bar_p;
        for (int r = 0; r < 3; ++r)
            s[r][r] -= press;
        store_particle_stress_matrix(soa, p_idx, s);
        return;
    } else if (mat.material_model == MPMMaterialModel::KCConcrete) {
        KCStateVariables<float> kc_state;
        kc_state.damage = damage_p;
        kc_state.lambda = lambda_p;
        kc_state.ep_bar = ep_bar_p;
        kc_state.p_hydro = press;
        updateKCStress<float>(
            s, press, tr_deps, dt, char_len_p, ep_dot,
            mat.fc * w_factor, mat.ft * w_factor, mu, K_bulk,
            mat.G_f, mat.moisture_content,
            mat.kc_auto_generate,
            mat.kc_a0, mat.kc_a1, mat.kc_a2,
            mat.kc_a0y, mat.kc_a1y, mat.kc_a2y,
            mat.kc_a1r, mat.kc_a2r,
            mat.kc_b1, mat.kc_omega,
            mat.dif_cap_compression, mat.dif_cap_tension,
            kc_state
        );
        damage_p = kc_state.damage;
        lambda_p = kc_state.lambda;
        ep_bar_p = kc_state.ep_bar;
        press = kc_state.p_hydro;
        soa.damage[p_idx] = damage_p;
        if (soa.lambda) soa.lambda[p_idx] = lambda_p;
        soa.ep_bar[p_idx] = ep_bar_p;
        for (int r = 0; r < 3; ++r)
            s[r][r] -= press;
        store_particle_stress_matrix(soa, p_idx, s);
        return;
    } else if (mat.material_model == MPMMaterialModel::CSCMConcrete) {
        CSCMStateVariables<float> cscm_state;
        cscm_state.damage = damage_p;
        cscm_state.kappa = lambda_p;
        cscm_state.ep_bar = ep_bar_p;
        cscm_state.p_hydro = press;
        updateCSCMStress<float>(
            s, press, tr_deps, dt, char_len_p, ep_dot,
            mat.fc * w_factor, mat.ft * w_factor, mu, K_bulk,
            mat.G_f,
            mat.cscm_alpha * w_factor, mat.cscm_theta,
            mat.cscm_lambda * w_factor, mat.cscm_beta,
            mat.cscm_R, mat.cscm_X0,
            mat.cscm_W, mat.cscm_D1,
            mat.cscm_D2,
            mat.dif_cap_compression, mat.dif_cap_tension,
            cscm_state
        );
        damage_p = cscm_state.damage;
        lambda_p = cscm_state.kappa;
        ep_bar_p = cscm_state.ep_bar;
        press = cscm_state.p_hydro;
        soa.damage[p_idx] = damage_p;
        if (soa.lambda) soa.lambda[p_idx] = lambda_p;
        soa.ep_bar[p_idx] = ep_bar_p;
        for (int r = 0; r < 3; ++r)
            s[r][r] -= press;
        store_particle_stress_matrix(soa, p_idx, s);
        return;
    } else {
        // Default Hypoelastic J2 Elastoplasticity with Weibull flaw scatter & plastic damage softening
        float w_factor = (mat.enable_heterogeneity && soa.weibull_factor && soa.weibull_factor[p_idx] > 0.001f) ? soa.weibull_factor[p_idx] : 1.0f;
        if (mat.enable_heterogeneity && w_factor <= 0.001f && mat.weibull_modulus > 0.001f) {
            float v0_val = (soa.V0) ? soa.V0[p_idx] : mat.weibull_ref_volume;
            w_factor = computeWeibullFactor_dev(soa.x[0][p_idx], soa.x[1][p_idx], soa.x[2][p_idx], v0_val, mat.weibull_modulus, mat.weibull_scale, mat.weibull_ref_volume);
            soa.weibull_factor[p_idx] = w_factor;
        }

        float s_s = 0.0f;
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                s_s += s[r][c] * s[r][c];
        const float q_trial = sqrtf(1.5f * s_s);

        float aniso_factor = 1.0f;
        if (mat.enable_anisotropy && fabsf(mat.anisotropy_ratio - 1.0f) > 0.001f) {
            float ax = mat.anisotropy_dir[0], ay = mat.anisotropy_dir[1], az = mat.anisotropy_dir[2];
            float sigma_a = ax * (s[0][0]*ax + s[0][1]*ay + s[0][2]*az) +
                            ay * (s[1][0]*ax + s[1][1]*ay + s[1][2]*az) +
                            az * (s[2][0]*ax + s[2][1]*ay + s[2][2]*az);
            float q_norm = (q_trial > 1e-12f) ? q_trial : 1.0f;
            float xi = fminf(fmaxf(fabsf(sigma_a) / q_norm, 0.0f), 1.0f);
            aniso_factor = 1.0f + (mat.anisotropy_ratio - 1.0f) * (1.0f - xi * xi);
        }
        const float yield_base = mat.yield_stress * w_factor;
        const float fail_strain_base = ((mat.enable_strain_erosion && mat.erosion_strain > 0.0f) ? mat.erosion_strain : mat.failure_strain) * w_factor * aniso_factor;
        const float fail_stress = ((mat.enable_stress_erosion && mat.erosion_stress > 0.0f) ? mat.erosion_stress : mat.tensile_failure_stress) * w_factor * aniso_factor;
        const float p_spall_hypo = fmaxf(fail_stress, 1.5f * yield_base * aniso_factor);
        const float press_raw = press;
        if (p_spall_hypo > 0.0f && press < 0.0f) {
            press = fmaxf(press, -p_spall_hypo * fmaxf(0.0f, 1.0f - damage_p));
        }

        const float soft_factor = fminf(fmaxf(1.0f - 0.70f * damage_p, 0.10f), 1.0f);
        const float yield_eff = (yield_base * soft_factor + mat.hardening_modulus * ep_bar_p) * aniso_factor;
        const float yield_surf = q_trial - yield_eff;

        float delta_ep = 0.0f;
        if (q_trial > 1.0e-5f && yield_surf > 0.0f) {
            delta_ep = yield_surf / (3.0f * mu + mat.hardening_modulus);
            float scale = 1.0f - (3.0f * mu * delta_ep) / q_trial;
            if (scale < 0.0f) scale = 0.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s[r][c] *= scale;
            ep_bar_p += delta_ep;
            soa.ep_bar[p_idx] = ep_bar_p;
            if (mat.density > 0.0f && mat.Cp > 0.0f) {
                float dw_p = yield_eff * delta_ep;
                float de_p = (0.90f * dw_p) / mat.density;
                e_int_p += de_p;
                temperature_p = mat.T_room + e_int_p / mat.Cp;
                soa.e_int[p_idx] = e_int_p;
                soa.temperature[p_idx] = temperature_p;
            }
        }
        for (int r = 0; r < 3; ++r)
            s[r][r] -= press;
        store_particle_stress_matrix(soa, p_idx, s);

        if (delta_ep > 0.0f && fail_strain_base > 0.0f) {
            const float sigma_star_h = fminf(fmaxf(-press_raw / fmaxf(yield_base * aniso_factor, 1.0e6f), -2.5f), 2.5f);
            const float triax_mult = (sigma_star_h >= 0.33f) ? 1.0f : ((sigma_star_h >= 0.0f) ? (2.0f - 3.0f * sigma_star_h) : 4.0f);
            damage_p = fminf(1.0f, damage_p + delta_ep / fmaxf(0.01f, fail_strain_base * triax_mult));
        }
        if (mat.enable_strain_erosion && fail_strain_base > 0.0f) {
            damage_p = fmaxf(damage_p, fminf(fmaxf(ep_bar_p / fail_strain_base, 0.0f), 1.0f));
        }
        if (p_spall_hypo > 0.0f && (-press_raw) > p_spall_hypo) {
            if (mat.enable_stress_erosion) {
                damage_p = fmaxf(damage_p, fminf((-press_raw) / p_spall_hypo, 1.0f));
            } else if (ep_bar_p > 0.005f || (V_p > 1.03f * V0_p)) {
                float spall_over = ((-press_raw) - p_spall_hypo) / p_spall_hypo;
                damage_p = fminf(1.0f, damage_p + 0.5f * spall_over);
            }
        }

        soa.damage[p_idx] = damage_p;
    }

    if (damage_p >= 1.0f) {
        soa.has_failed[p_idx] = 1;
        soa.damage[p_idx] = 1.0f;
        if (V_p > V0_p) {
            float lp_f = 0.5f * cbrtf(V0_p);
            soa.lp[0][p_idx] = lp_f; soa.lp[1][p_idx] = lp_f; soa.lp[2][p_idx] = lp_f;
        }

        const float J = V_p / (V0_p > 1.0e-20f ? V0_p : 1.0e-20f);
        float p_comp = 0.0f;
        if (J < 1.0f) {
            if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen && mat.mg_c0 > 0.0f) {
                const float mu_vol = (1.0f - J) / fmaxf(0.25f, J);
                p_comp = fmaxf(0.0f, Blast::Materials::mie_gruneisen_compression_pressure<float>(
                    mat.density, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mu_vol, 0.0f));
            } else {
                const float E_mod_d  = mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f;
                const float nu_d     = fminf(fmaxf(mat.poissons_ratio, 0.01f), 0.49f);
                const float K_parent = E_mod_d / (3.0f * (1.0f - 2.0f * nu_d));
                p_comp = K_parent * (1.0f - J) / fmaxf(0.01f, J);
            }
        }

        store_particle_stress_isotropic(soa, p_idx, p_comp);
        return;
    }
}

// Standalone stress update kernel (loads L_grad from SoA and invokes constitutive math)
__global__ void kernel_stress_update_3d(MPMParticle3DSoA soa, int num_particles, float dt, const MaterialTable3D* d_mat_tables) {
    int p_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (p_idx >= num_particles || (soa.state && soa.state[p_idx] == 2) || soa.m[p_idx] <= 0.0f) return;

    int obj_id = soa.object_id[p_idx];
    const MaterialTable3D& mat = d_mat_tables[obj_id];

    float L[3][3];
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            L[r][c] = soa.L_grad[r][c][p_idx];
        }
    }

    update_particle_stress_constitutive(p_idx, dt, L, soa, mat);
}

__global__ void kernel_compute_max_speed(MPMParticle3DSoA soa, int num_particles, float* d_max_speed, const MaterialTable3D* d_mat_tables) {
    extern __shared__ float s_max[];
    int tid = threadIdx.x;
    int idx = blockIdx.x * blockDim.x + threadIdx.x;

    float local_max = 100.0f;
    if (idx < num_particles && (!soa.state || soa.state[idx] != 2) && soa.m[idx] > 0.0f) {
        int obj_id = soa.object_id[idx];
        const MaterialTable3D& mat = d_mat_tables[obj_id];
        float E = mat.youngs_modulus;
        float rho = fabsf(mat.density) > 10.0f ? fabsf(mat.density) : 10.0f;
        float nu = mat.poissons_ratio;
        float c_s = 0.0f;
        if (mat.material_model == MPMMaterialModel::TaitWater) {
            float J_val = soa.V[idx] / (soa.V0[idx] > 1.0e-20f ? soa.V0[idx] : 1.0e-20f);
            float rho_p = mat.tait_rho0 / fmaxf(0.05f, J_val);
            float p_p = -0.33333334f * (soa.sigma_voigt[0][idx] + soa.sigma_voigt[1][idx] + soa.sigma_voigt[2][idx]);
            c_s = Blast::TaitEOSWater::compute_sound_speed_unified(rho_p, p_p, soa.e_int[idx], static_cast<Blast::TaitVariant>(mat.tait_variant), mat.tait_B, mat.tait_gamma, mat.tait_rho0, mat.tait_c0, mat.tait_gruneisen);
        } else if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen) {
            float C0 = mat.mg_c0;
            c_s = sqrtf(C0 * C0 + (2.0f / 3.0f) * E / (rho * (1.0f + nu)));
        } else if (mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
                   mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
                   mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth) {
            float C0 = (mat.solid_model == SolidReactantEOS::DavisSolid) ? mat.davis_c0 : (mat.mg_c0 > 100.0f ? mat.mg_c0 : 2500.0f);
            float c_det = (mat.product_model == DetonationProductEOS::DavisProduct) ? ((mat.davis_pc > 1.0e6f) ? 7500.0f : 6000.0f) : (mat.det_vel > 1000.0f ? mat.det_vel : 6930.0f);
            float lam = soa.lambda ? soa.lambda[idx] : 0.0f;
            if (lam >= 1.0f) {
                float v_rel = fmaxf(soa.V[idx] / (soa.V0[idx] > 1.0e-20f ? soa.V0[idx] : 1.0e-20f), 0.02f);
                float p_p = -0.33333334f * (soa.sigma_voigt[0][idx] + soa.sigma_voigt[1][idx] + soa.sigma_voigt[2][idx]);
                p_p = fmaxf(1.0f, p_p);
                bool use_davis_solid = (mat.solid_model == SolidReactantEOS::DavisSolid) || (mat.material_model == MPMMaterialModel::CRESTReactiveBurn);
                bool use_davis_prod = (mat.product_model == DetonationProductEOS::DavisProduct) || (mat.material_model == MPMMaterialModel::CRESTReactiveBurn);
                float rho_ref = (mat.density > 10.0f) ? mat.density : (use_davis_solid ? mat.davis_rho0 : 1630.0f);
                if (use_davis_prod) {
                    float gamma_eff = mat.davis_k + 1.0f;
                    float rho_cur = rho_ref / v_rel;
                    c_s = sqrtf(fmaxf(100.0f, gamma_eff * p_p / rho_cur));
                } else {
                    c_s = JWL::computeJWLSoundSpeed(v_rel, p_p, mat.jwl_A, mat.jwl_B, mat.jwl_R1, mat.jwl_R2, mat.jwl_omega, rho_ref);
                }
            } else if (lam > 0.0f) {
                c_s = c_det;
            } else {
                c_s = C0;
            }
        } else if (mat.material_model == MPMMaterialModel::RHTConcrete || mat.material_model == MPMMaterialModel::KCConcrete || mat.material_model == MPMMaterialModel::CSCMConcrete) {
            float G = E / (2.0f * (1.0f + nu));
            float K = 1.6f * (E / (3.0f * fmaxf(0.02f, 1.0f - 2.0f * nu)));
            c_s = sqrtf((K + 4.0f / 3.0f * G) / rho);
        } else {
            if (nu >= 0.0f && nu < 0.5f) {
                float denom = (1.0f + nu) * fmaxf(0.02f, 1.0f - 2.0f * nu);
                float factor = (1.0f - nu) / denom;
                c_s = sqrtf(E * factor / rho);
            } else {
                c_s = sqrtf(E / rho);
            }
        }
        if (isnan(c_s) || isinf(c_s)) c_s = 5000.0f;
        float vx = soa.v[0][idx], vy = soa.v[1][idx], vz = soa.v[2][idx];
        float v_mag = sqrtf(vx * vx + vy * vy + vz * vz);
        v_mag = fminf(25000.0f, v_mag);
        local_max = fmaxf(local_max, c_s + v_mag);
    }
    s_max[tid] = local_max;
    __syncthreads();

    for (int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s) {
            s_max[tid] = fmaxf(s_max[tid], s_max[tid + s]);
        }
        __syncthreads();
    }

    if (tid == 0) {
        atomicMax((int*)d_max_speed, __float_as_int(s_max[0]));
    }
}

// Helper to copy a particle's full state within SoA
__device__ inline void copy_particle_soa(MPMParticle3DSoA soa, int dst, int src) {
    if (dst == src) return;
    for (int d = 0; d < 3; ++d) {
        if (soa.x[d]) soa.x[d][dst] = soa.x[d][src];
        if (soa.v[d]) soa.v[d][dst] = soa.v[d][src];
        if (soa.lp[d]) soa.lp[d][dst] = soa.lp[d][src];
    }
    if (soa.sigma_voigt[0]) {
        #pragma unroll
        for (int k = 0; k < 6; ++k) {
            soa.sigma_voigt[k][dst] = soa.sigma_voigt[k][src];
        }
    } else {
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                if (soa.sigma[r][c]) soa.sigma[r][c][dst] = soa.sigma[r][c][src];
            }
        }
    }
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            if (soa.B[r][c]) soa.B[r][c][dst] = soa.B[r][c][src];
            if (soa.L_grad[r][c] && soa.L_grad[r][c] != soa.B[r][c]) {
                soa.L_grad[r][c][dst] = soa.L_grad[r][c][src];
            }
        }
    }
    if (soa.m) soa.m[dst] = soa.m[src];
    if (soa.V0) soa.V0[dst] = soa.V0[src];
    if (soa.V) soa.V[dst] = soa.V[src];
    if (soa.e_int) soa.e_int[dst] = soa.e_int[src];
    if (soa.temperature) soa.temperature[dst] = soa.temperature[src];
    if (soa.ep_bar) soa.ep_bar[dst] = soa.ep_bar[src];
    if (soa.damage) soa.damage[dst] = soa.damage[src];
    if (soa.lambda) soa.lambda[dst] = soa.lambda[src];
    if (soa.t_arrival) soa.t_arrival[dst] = soa.t_arrival[src];
    if (soa.v_min) soa.v_min[dst] = soa.v_min[src];
    if (soa.s_shock) soa.s_shock[dst] = soa.s_shock[src];
    if (soa.weibull_factor) soa.weibull_factor[dst] = soa.weibull_factor[src];
    if (soa.contact_radius) soa.contact_radius[dst] = soa.contact_radius[src];
    if (soa.has_failed) soa.has_failed[dst] = soa.has_failed[src];
    if (soa.object_id) soa.object_id[dst] = soa.object_id[src];
    if (soa.state) soa.state[dst] = soa.state[src];
    if (soa.cluster_id) soa.cluster_id[dst] = soa.cluster_id[src];
    if (soa.material_id) soa.material_id[dst] = soa.material_id[src];
}

__global__ void kernel_count_active_particles(MPMParticle3DSoA soa, int num_particles, int* d_active_count) {
    extern __shared__ int s_count[];
    int tid = threadIdx.x;
    int idx = blockIdx.x * blockDim.x + threadIdx.x;

    int local_active = 0;
    if (idx < num_particles) {
        bool active = ((!soa.state || soa.state[idx] != 2) && soa.m[idx] > 0.0f);
        local_active = active ? 1 : 0;
    }
    s_count[tid] = local_active;
    __syncthreads();

    for (int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s) {
            s_count[tid] += s_count[tid + s];
        }
        __syncthreads();
    }

    if (tid == 0 && s_count[0] > 0) {
        atomicAdd(d_active_count, s_count[0]);
    }
}

__global__ void kernel_gather_holes_and_sources(
    MPMParticle3DSoA soa, int num_particles, int active_target,
    int* d_holes, int* d_sources, int* d_counters)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_particles) return;

    bool is_active = (!soa.state || soa.state[idx] != 2) && (soa.m[idx] > 0.0f);

    if (idx < active_target) {
        if (!is_active) {
            int slot = atomicAdd(&d_counters[0], 1);
            d_holes[slot] = idx;
        }
    } else {
        if (is_active) {
            int slot = atomicAdd(&d_counters[1], 1);
            d_sources[slot] = idx;
        }
    }
}

// Compaction kernel: relocates remaining active particles to fill holes
__global__ void kernel_compact_particles(
    MPMParticle3DSoA soa, const int* d_holes, const int* d_sources, int num_moves)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_moves) return;

    int dst = d_holes[idx];
    int src = d_sources[idx];
    copy_particle_soa(soa, dst, src);
}

// Sample continuum velocity at a single point (x, y, z) using the configured transfer scheme and material-specific grid fields
__global__ void kernel_sample_grid_velocity_single(
    const MPMGridNode3D* grid,
    int nx, int ny, int nz,
    float dx, float dy, float dz,
    float xmin, float ymin, float zmin,
    int bc_x_min, int bc_x_max,
    int bc_y_min, int bc_y_max,
    int bc_z_min, int bc_z_max,
    float x, float y, float z,
    int transfer_scheme,
    int target_mat,
    const int* d_mat_tag,
    const float* d_mat_grid_m,
    const float* d_mat_grid_v,
    const float* d_mat_grid_dv,
    int num_materials,
    size_t num_nodes_total,
    float* out_vel_and_flag // float4: vx, vy, vz, flag (1.0 = success, 0.0 = out of bounds / empty)
) {
    if (threadIdx.x != 0 || blockIdx.x != 0) return;
    out_vel_and_flag[0] = 0.0f;
    out_vel_and_flag[1] = 0.0f;
    out_vel_and_flag[2] = 0.0f;
    out_vel_and_flag[3] = 0.0f;

    float px = x - xmin;
    float py = y - ymin;
    float pz = z - zmin;

    if (px < 0.0f || px >= static_cast<float>(nx) * dx ||
        py < 0.0f || py >= static_cast<float>(ny) * dy ||
        pz < 0.0f || pz >= static_cast<float>(nz) * dz) {
        return;
    }

    int base_i = static_cast<int>(floorf(px / dx));
    int base_j = static_cast<int>(floorf(py / dy));
    int base_k = static_cast<int>(floorf(pz / dz));

    float sum_vx = 0.0f, sum_vy = 0.0f, sum_vz = 0.0f;
    float weight_sum = 0.0f;

    if (transfer_scheme == 3) {
        // RadialMLS (Wendland C2 kernel, 5-point stencil per axis)
        float max_h = fmaxf(dx, fmaxf(dy, dz));
        float R_supp = 2.0f * max_h;
        for (int offset_i = -2; offset_i <= 2; ++offset_i) {
            int i = base_i + offset_i;
            float sign_x = 1.0f;
            if (!resolve_ghost_node_3d(i, sign_x, nx, bc_x_min, bc_x_max)) continue;
            float node_x = (static_cast<float>(base_i + offset_i) + 0.5f) * dx;

            for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                int j = base_j + offset_j;
                float sign_y = 1.0f;
                if (!resolve_ghost_node_3d(j, sign_y, ny, bc_y_min, bc_y_max)) continue;
                float node_y = (static_cast<float>(base_j + offset_j) + 0.5f) * dy;

                for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                    int k = base_k + offset_k;
                    float sign_z = 1.0f;
                    if (!resolve_ghost_node_3d(k, sign_z, nz, bc_z_min, bc_z_max)) continue;
                    float node_z = (static_cast<float>(base_k + offset_k) + 0.5f) * dz;

                    float dist_x = node_x - px;
                    float dist_y = node_y - py;
                    float dist_z = node_z - pz;
                    float r = sqrtf(dist_x * dist_x + dist_y * dist_y + dist_z * dist_z);
                    if (r >= R_supp) continue;

                    float weight = evalWendland_C2_dev(r, R_supp);
                    if (weight < 1.0e-7f) continue;

                    size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                    float n_vx = 0.0f, n_vy = 0.0f, n_vz = 0.0f;
                    bool node_valid = false;

                    if (target_mat >= 0 && d_mat_grid_m != nullptr) {
                        float dvx = 0.0f, dvy = 0.0f, dvz = 0.0f;
                        float m_val = mpm_mat_node_kinematics(grid, d_mat_tag, d_mat_grid_m, d_mat_grid_v, d_mat_grid_dv,
                                                              num_materials, num_nodes_total, target_mat, node_idx,
                                                              0.0f, 0.0f, 0.0f, n_vx, n_vy, n_vz, dvx, dvy, dvz);
                        if (m_val > 1.0e-20f) {
                            node_valid = true;
                        }
                    }
                    if (!node_valid) {
                        const MPMGridNode3D& node = grid[node_idx];
                        if (node.m > MPMGridNode3D::MIN_MASS) {
                            float inv_m = 1.0f / node.m;
                            n_vx = node.p[0] * inv_m;
                            n_vy = node.p[1] * inv_m;
                            n_vz = node.p[2] * inv_m;
                            node_valid = true;
                        }
                    }

                    if (node_valid) {
                        sum_vx += weight * sign_x * n_vx;
                        sum_vy += weight * sign_y * n_vy;
                        sum_vz += weight * sign_z * n_vz;
                        weight_sum += weight;
                    }
                }
            }
        }
    } else {
        int min_offset = -1;
        int max_offset = 2;
        if (transfer_scheme == 4) { // CubicBSpline
            min_offset = -2;
            max_offset = 2;
        }

        float Sx_arr[5], Sy_arr[5], Sz_arr[5];
        float lp_x = 0.5f * dx, lp_y = 0.5f * dy, lp_z = 0.5f * dz;

        #pragma unroll
        for (int offset = min_offset; offset <= max_offset; ++offset) {
            int idx = offset - min_offset;
            float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * dx;
            if (transfer_scheme == 1) { // GIMP
                Sx_arr[idx] = evalGIMP_S_dev(px, nx_val, dx, lp_x);
            } else if (transfer_scheme == 2) { // BSpline
                Sx_arr[idx] = evalBSpline_S_dev(px, nx_val, dx);
            } else if (transfer_scheme == 4) { // CubicBSpline
                Sx_arr[idx] = evalCubicBSpline_S_dev(px, nx_val, dx);
            } else { // Standard (Linear)
                Sx_arr[idx] = evalLinear_S_dev(px, nx_val, dx);
            }

            float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * dy;
            if (transfer_scheme == 1) {
                Sy_arr[idx] = evalGIMP_S_dev(py, ny_val, dy, lp_y);
            } else if (transfer_scheme == 2) {
                Sy_arr[idx] = evalBSpline_S_dev(py, ny_val, dy);
            } else if (transfer_scheme == 4) {
                Sy_arr[idx] = evalCubicBSpline_S_dev(py, ny_val, dy);
            } else {
                Sy_arr[idx] = evalLinear_S_dev(py, ny_val, dy);
            }

            float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * dz;
            if (transfer_scheme == 1) {
                Sz_arr[idx] = evalGIMP_S_dev(pz, nz_val, dz, lp_z);
            } else if (transfer_scheme == 2) {
                Sz_arr[idx] = evalBSpline_S_dev(pz, nz_val, dz);
            } else if (transfer_scheme == 4) {
                Sz_arr[idx] = evalCubicBSpline_S_dev(pz, nz_val, dz);
            } else {
                Sz_arr[idx] = evalLinear_S_dev(pz, nz_val, dz);
            }
        }

        for (int offset_i = min_offset; offset_i <= max_offset; ++offset_i) {
            int i = base_i + offset_i;
            float sign_x = 1.0f;
            if (!resolve_ghost_node_3d(i, sign_x, nx, bc_x_min, bc_x_max)) continue;
            int i_idx = offset_i - min_offset;
            float Sx = Sx_arr[i_idx];
            if (fabsf(Sx) < 1.0e-7f) continue;

            for (int offset_j = min_offset; offset_j <= max_offset; ++offset_j) {
                int j = base_j + offset_j;
                float sign_y = 1.0f;
                if (!resolve_ghost_node_3d(j, sign_y, ny, bc_y_min, bc_y_max)) continue;
                int j_idx = offset_j - min_offset;
                float Sy = Sy_arr[j_idx];
                if (fabsf(Sy) < 1.0e-7f) continue;

                for (int offset_k = min_offset; offset_k <= max_offset; ++offset_k) {
                    int k = base_k + offset_k;
                    float sign_z = 1.0f;
                    if (!resolve_ghost_node_3d(k, sign_z, nz, bc_z_min, bc_z_max)) continue;
                    int k_idx = offset_k - min_offset;
                    float Sz = Sz_arr[k_idx];
                    if (fabsf(Sz) < 1.0e-7f) continue;

                    float weight = Sx * Sy * Sz;
                    if (weight < 1.0e-7f) continue;
                    size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                    float n_vx = 0.0f, n_vy = 0.0f, n_vz = 0.0f;
                    bool node_valid = false;

                    if (target_mat >= 0 && d_mat_grid_m != nullptr) {
                        float dvx = 0.0f, dvy = 0.0f, dvz = 0.0f;
                        float m_val = mpm_mat_node_kinematics(grid, d_mat_tag, d_mat_grid_m, d_mat_grid_v, d_mat_grid_dv,
                                                              num_materials, num_nodes_total, target_mat, node_idx,
                                                              0.0f, 0.0f, 0.0f, n_vx, n_vy, n_vz, dvx, dvy, dvz);
                        if (m_val > 1.0e-20f) {
                            node_valid = true;
                        }
                    }
                    if (!node_valid) {
                        const MPMGridNode3D& node = grid[node_idx];
                        if (node.m > MPMGridNode3D::MIN_MASS) {
                            float inv_m = 1.0f / node.m;
                            n_vx = node.p[0] * inv_m;
                            n_vy = node.p[1] * inv_m;
                            n_vz = node.p[2] * inv_m;
                            node_valid = true;
                        }
                    }

                    if (node_valid) {
                        sum_vx += weight * sign_x * n_vx;
                        sum_vy += weight * sign_y * n_vy;
                        sum_vz += weight * sign_z * n_vz;
                        weight_sum += weight;
                    }
                }
            }
        }
    }

    if (weight_sum > 1.0e-6f) {
        out_vel_and_flag[0] = sum_vx / weight_sum;
        out_vel_and_flag[1] = sum_vy / weight_sum;
        out_vel_and_flag[2] = sum_vz / weight_sum;
        out_vel_and_flag[3] = 1.0f;
    }
}

// Runtime detonator ignition kernel directly updating SoA on device
__global__ void kernel_fire_detonator_3d(
    MPMParticle3DSoA soa,
    int num_particles,
    float det_x, float det_y, float det_z, float det_radius,
    float current_sim_time,
    const MaterialTable3D* d_mat_tables, int num_materials,
    int target_object_id,
    float cell_dx
) {
    int p_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (p_idx >= num_particles || (soa.state && soa.state[p_idx] == 2) || soa.m[p_idx] <= 0.0f) return;
    if (target_object_id >= 0 && soa.object_id[p_idx] != target_object_id) return;

    int obj_id = soa.object_id[p_idx];
    if (obj_id < 0 || obj_id >= num_materials) return;
    const MaterialTable3D& mat = d_mat_tables[obj_id];

    bool is_energetic = (mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
                         mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
                         mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);
    if (!is_energetic) return;

    float px = soa.x[0][p_idx];
    float py = soa.x[1][p_idx];
    float pz = soa.x[2][p_idx];

    float dx = px - det_x;
    float dy = py - det_y;
    float dz = pz - det_z;
    float dist = sqrtf(dx * dx + dy * dy + dz * dz);
    float eff_dist = (det_radius > 0.0f) ? fmaxf(0.0f, dist - det_radius) : dist;

    if (mat.material_model == MPMMaterialModel::JWLProgrammedBurn) {
        float det_v = fmaxf(mat.det_vel, 100.0f);
        float t_arr = current_sim_time + eff_dist / det_v;
        if (soa.t_arrival) {
            soa.t_arrival[p_idx] = fminf(soa.t_arrival[p_idx], t_arr);
        }
        float core_radius = fmaxf(det_radius, 1.5f * cell_dx);
        if (dist <= core_radius) {
            if (soa.lambda) soa.lambda[p_idx] = 1.0f;
            soa.e_int[p_idx] = mat.detonation_energy;
            float V_p = soa.V[p_idx];
            float V0_p = soa.V0[p_idx];
            float v_ratio = (V0_p > 1.0e-20f) ? (V_p / V0_p) : 1.0f;
            float p_init = Blast::JWL::computeJWLProductPressure(
                v_ratio, mat.detonation_energy,
                mat.jwl_A, mat.jwl_B, mat.jwl_R1, mat.jwl_R2,
                mat.jwl_omega, mat.density
            );
            if (soa.sigma_voigt[0]) {
                soa.sigma_voigt[0][p_idx] = -p_init;
                soa.sigma_voigt[1][p_idx] = -p_init;
                soa.sigma_voigt[2][p_idx] = -p_init;
                soa.sigma_voigt[3][p_idx] = 0.0f;
                soa.sigma_voigt[4][p_idx] = 0.0f;
                soa.sigma_voigt[5][p_idx] = 0.0f;
            }
        }
    } else if (mat.material_model == MPMMaterialModel::CRESTReactiveBurn) {
        float trigger_radius = fmaxf(det_radius, 2.5f * cell_dx);
        if (dist <= trigger_radius) {
            if (soa.s_shock) soa.s_shock[p_idx] = 1.5f * mat.crest_s_threshold;
            if (soa.lambda) soa.lambda[p_idx] = 1.0f;
            soa.e_int[p_idx] = fmaxf(mat.davis_q_det, mat.detonation_energy);
            float vc = (mat.davis_vc > 0.1f) ? mat.davis_vc : 0.70f;
            if (soa.v_min) soa.v_min[p_idx] = vc;
            soa.V[p_idx] = vc * soa.V0[p_idx];
            float p_init = ((mat.davis_pc > 1.0e6f) ? mat.davis_pc : 15.0e9f);
            if (soa.sigma_voigt[0]) {
                soa.sigma_voigt[0][p_idx] = -p_init;
                soa.sigma_voigt[1][p_idx] = -p_init;
                soa.sigma_voigt[2][p_idx] = -p_init;
                soa.sigma_voigt[3][p_idx] = 0.0f;
                soa.sigma_voigt[4][p_idx] = 0.0f;
                soa.sigma_voigt[5][p_idx] = 0.0f;
            }
        }
    } else if (mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth) {
        float trigger_radius = fmaxf(det_radius, 2.5f * cell_dx);
        if (dist <= trigger_radius) {
            if (soa.lambda) soa.lambda[p_idx] = 1.0f;
            soa.e_int[p_idx] = mat.detonation_energy;
            float p_init = 20.0e9f;
            if (soa.sigma_voigt[0]) {
                soa.sigma_voigt[0][p_idx] = -p_init;
                soa.sigma_voigt[1][p_idx] = -p_init;
                soa.sigma_voigt[2][p_idx] = -p_init;
                soa.sigma_voigt[3][p_idx] = 0.0f;
                soa.sigma_voigt[4][p_idx] = 0.0f;
                soa.sigma_voigt[5][p_idx] = 0.0f;
            }
        }
    }
}

// MPMSolver3DCUDA Implementation
MPMSolver3DCUDA::MPMSolver3DCUDA() {}

MPMSolver3DCUDA::~MPMSolver3DCUDA() {
    freeDeviceMemory();
}

void MPMSolver3DCUDA::allocateSoABuffer(size_t count) {
    // 3(x) + 3(v) + 6(sigma_voigt) + 9(B) + 1(lp) + 13(m..contact_radius) = 35 floats
    // + 5 ints = 35 * 4 + 20 = 160 bytes per particle
    size_t required_bytes = count * (35 * sizeof(float) + 5 * sizeof(int));
    if (required_bytes > m_allocated_soa_bytes) {
        if (d_soa_buffer) cudaFree(d_soa_buffer);
        CUDA_CHECK_ALLOC(cudaMalloc(&d_soa_buffer, required_bytes), "Allocating d_soa_buffer (" + std::to_string(required_bytes) + " bytes)");
        m_allocated_soa_bytes = required_bytes;
    }

    float* fptr = static_cast<float*>(d_soa_buffer);
    d_soa.x[0] = fptr; fptr += count;
    d_soa.x[1] = fptr; fptr += count;
    d_soa.x[2] = fptr; fptr += count;

    d_soa.v[0] = fptr; fptr += count;
    d_soa.v[1] = fptr; fptr += count;
    d_soa.v[2] = fptr; fptr += count;

    // 6 Voigt stress components: xx, yy, zz, xy, yz, zx
    d_soa.sigma_voigt[0] = fptr; fptr += count; // xx
    d_soa.sigma_voigt[1] = fptr; fptr += count; // yy
    d_soa.sigma_voigt[2] = fptr; fptr += count; // zz
    d_soa.sigma_voigt[3] = fptr; fptr += count; // xy
    d_soa.sigma_voigt[4] = fptr; fptr += count; // yz
    d_soa.sigma_voigt[5] = fptr; fptr += count; // zx

    // Alias 3x3 sigma tensor directly to Voigt components for seamless backwards compatibility
    d_soa.sigma[0][0] = d_soa.sigma_voigt[0];
    d_soa.sigma[1][1] = d_soa.sigma_voigt[1];
    d_soa.sigma[2][2] = d_soa.sigma_voigt[2];
    d_soa.sigma[0][1] = d_soa.sigma[1][0] = d_soa.sigma_voigt[3];
    d_soa.sigma[1][2] = d_soa.sigma[2][1] = d_soa.sigma_voigt[4];
    d_soa.sigma[2][0] = d_soa.sigma[0][2] = d_soa.sigma_voigt[5];

    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            d_soa.B[r][c] = fptr; fptr += count;
            d_soa.L_grad[r][c] = d_soa.B[r][c]; // Alias L_grad to B to eliminate 9 redundant float arrays
        }
    }

    // Isotropic lp: single buffer aliased to all 3 axes
    d_soa.lp[0] = d_soa.lp[1] = d_soa.lp[2] = fptr; fptr += count;

    d_soa.m = fptr; fptr += count;
    d_soa.V0 = fptr; fptr += count;
    d_soa.V = fptr; fptr += count;
    d_soa.e_int = fptr; fptr += count;
    d_soa.temperature = fptr; fptr += count;
    d_soa.ep_bar = fptr; fptr += count;
    d_soa.damage = fptr; fptr += count;
    d_soa.lambda = fptr; fptr += count;
    d_soa.t_arrival = fptr; fptr += count;
    d_soa.v_min = fptr; fptr += count;
    d_soa.s_shock = fptr; fptr += count;
    d_soa.weibull_factor = fptr; fptr += count;
    d_soa.contact_radius = fptr; fptr += count;

    int* iptr = reinterpret_cast<int*>(fptr);
    d_soa.has_failed = iptr; iptr += count;
    d_soa.object_id = iptr; iptr += count;
    d_soa.state = iptr; iptr += count;
    d_soa.cluster_id = iptr; iptr += count;
    d_soa.material_id = iptr; iptr += count;
}

void MPMSolver3DCUDA::freeSoABuffer() {
    if (d_soa_buffer) {
        cudaFree(d_soa_buffer);
        d_soa_buffer = nullptr;
    }
    d_soa = MPMParticle3DSoA{};
    m_allocated_soa_bytes = 0;
}

void MPMSolver3DCUDA::uploadAoS2SoA() {
    size_t count = m_host_particles.size();
    if (count == 0) return;
    allocateDeviceMemory();

    // Bound staging buffer to 65536 particles (~14 MB max) to prevent unbounded GPU memory allocations
    constexpr size_t MAX_AOS_CHUNK_SIZE = 65536;
    size_t chunk_capacity = std::min(count, MAX_AOS_CHUNK_SIZE);

    if (!d_temp_aos_particles || m_allocated_temp_aos_particles < chunk_capacity) {
        if (d_temp_aos_particles) cudaFree(d_temp_aos_particles);
        CUDA_CHECK_ALLOC(cudaMalloc(&d_temp_aos_particles, chunk_capacity * sizeof(MPMParticle3D)), "Allocating d_temp_aos_particles for upload");
        m_allocated_temp_aos_particles = chunk_capacity;
    }

    int threads = 256;
    for (size_t offset = 0; offset < count; offset += chunk_capacity) {
        size_t cur_chunk = std::min(chunk_capacity, count - offset);
        cudaMemcpy(d_temp_aos_particles, m_host_particles.data() + offset, cur_chunk * sizeof(MPMParticle3D), cudaMemcpyHostToDevice);
        int blocks = (static_cast<int>(cur_chunk) + threads - 1) / threads;
        kernel_pack_aos_to_soa<<<blocks, threads>>>(d_temp_aos_particles, d_soa, static_cast<int>(cur_chunk), static_cast<int>(offset));
    }
    cudaDeviceSynchronize();
    m_num_active_particles = count;
}

int MPMSolver3DCUDA::compactTerminatedParticlesDevice() {
    size_t current_count = (m_num_active_particles > 0) ? m_num_active_particles : m_host_particles.size();
    if (current_count == 0 || !d_soa_buffer) {
        m_num_active_particles = 0;
        return 0;
    }

    allocateDeviceMemory();

    cudaMemsetAsync(d_active_count, 0, sizeof(int));
    int threads = 256;
    int blocks = (static_cast<int>(current_count) + threads - 1) / threads;
    kernel_count_active_particles<<<blocks, threads, threads * sizeof(int)>>>(
        d_soa, static_cast<int>(current_count), d_active_count);

    int active_target = 0;
    cudaMemcpy(&active_target, d_active_count, sizeof(int), cudaMemcpyDeviceToHost);

    if (active_target >= static_cast<int>(current_count)) {
        m_num_active_particles = active_target;
        return active_target;
    }

    if (active_target == 0) {
        m_num_active_particles = 0;
        m_host_particles.clear();
        return 0;
    }

    cudaMemsetAsync(d_compaction_counters, 0, 2 * sizeof(int));
    int* d_holes = d_compaction_indices;
    int* d_sources = d_compaction_indices + current_count;

    kernel_gather_holes_and_sources<<<blocks, threads>>>(
        d_soa, static_cast<int>(current_count), active_target,
        d_holes, d_sources, d_compaction_counters);

    int counters[2] = {0, 0};
    cudaMemcpy(counters, d_compaction_counters, 2 * sizeof(int), cudaMemcpyDeviceToHost);

    int num_moves = std::min(counters[0], counters[1]);
    if (num_moves > 0) {
        int move_blocks = (num_moves + threads - 1) / threads;
        kernel_compact_particles<<<move_blocks, threads>>>(d_soa, d_holes, d_sources, num_moves);
        cudaDeviceSynchronize();
    }

    m_num_active_particles = active_target;
    return active_target;
}

void MPMSolver3DCUDA::downloadSoA2AoS() {
    if (m_device_dirty) syncToDevice();
    size_t count = (m_num_active_particles > 0) ? m_num_active_particles : m_host_particles.size();
    if (count == 0 || !d_soa_buffer) return;

    compactTerminatedParticlesDevice();
    count = m_num_active_particles;
    if (count == 0) {
        m_host_particles.clear();
        return;
    }

    // Bound staging buffer to 65536 particles (~14 MB max) to prevent unbounded GPU memory allocations
    constexpr size_t MAX_AOS_CHUNK_SIZE = 65536;
    size_t chunk_capacity = std::min(count, MAX_AOS_CHUNK_SIZE);

    if (!d_temp_aos_particles || m_allocated_temp_aos_particles < chunk_capacity) {
        if (d_temp_aos_particles) cudaFree(d_temp_aos_particles);
        CUDA_CHECK_ALLOC(cudaMalloc(&d_temp_aos_particles, chunk_capacity * sizeof(MPMParticle3D)), "Allocating d_temp_aos_particles for download");
        m_allocated_temp_aos_particles = chunk_capacity;
    }

    int threads = 256;
    for (size_t offset = 0; offset < count; offset += chunk_capacity) {
        size_t cur_chunk = std::min(chunk_capacity, count - offset);
        int blocks = (static_cast<int>(cur_chunk) + threads - 1) / threads;
        kernel_unpack_soa_to_aos<<<blocks, threads>>>(d_temp_aos_particles, d_soa, static_cast<int>(cur_chunk), static_cast<int>(offset));
        cudaDeviceSynchronize();
        cudaMemcpy(m_host_particles.data() + offset, d_temp_aos_particles, cur_chunk * sizeof(MPMParticle3D), cudaMemcpyDeviceToHost);
    }
    m_host_particles.resize(count);
}

void MPMSolver3DCUDA::allocateDeviceMemory() {
    size_t num_grid_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
    size_t num_particles = m_host_particles.size();
    size_t num_materials = m_material_tables.size();

    if (num_grid_nodes > m_allocated_grid_nodes) {
        if (d_grid) cudaFree(d_grid);
        if (d_grid_n) cudaFree(d_grid_n);
        CUDA_CHECK_ALLOC(cudaMalloc(&d_grid, num_grid_nodes * sizeof(MPMGridNode3D)), "Allocating d_grid (" + std::to_string(num_grid_nodes) + " nodes)");
        CUDA_CHECK_ALLOC(cudaMalloc(&d_grid_n, num_grid_nodes * sizeof(float)), "Allocating d_grid_n (" + std::to_string(num_grid_nodes) + " floats)");
        m_allocated_grid_nodes = num_grid_nodes;
    }

    if (num_particles > m_allocated_particles) {
        allocateSoABuffer(num_particles);
        m_allocated_particles = num_particles;
    }

    if (num_particles * 2 > m_allocated_compaction_indices) {
        if (d_compaction_indices) cudaFree(d_compaction_indices);
        CUDA_CHECK_ALLOC(cudaMalloc(&d_compaction_indices, num_particles * 2 * sizeof(int)), "Allocating d_compaction_indices");
        m_allocated_compaction_indices = num_particles * 2;
    }
    if (!d_compaction_counters) {
        CUDA_CHECK_ALLOC(cudaMalloc(&d_compaction_counters, 2 * sizeof(int)), "Allocating d_compaction_counters");
    }
    if (!d_active_count) {
        CUDA_CHECK_ALLOC(cudaMalloc(&d_active_count, sizeof(int)), "Allocating d_active_count");
    }
    if (!d_boundary_flags) {
        CUDA_CHECK_ALLOC(cudaMalloc(&d_boundary_flags, 2 * sizeof(int)), "Allocating d_boundary_flags");
        cudaMemset(d_boundary_flags, 0, 2 * sizeof(int));
    }

    if (num_materials > m_allocated_material_tables) {
        if (d_material_tables) cudaFree(d_material_tables);
        CUDA_CHECK_ALLOC(cudaMalloc(&d_material_tables, num_materials * sizeof(MaterialTable3D)), "Allocating d_material_tables");
        m_allocated_material_tables = num_materials;
    }

    if (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen) {
        allocateMatGridBuffers(num_grid_nodes, m_num_materials);
    }

    if (!d_max_v_buf) {
        CUDA_CHECK_ALLOC(cudaMalloc(&d_max_v_buf, sizeof(float)), "Allocating d_max_v_buf");
    }
    if (!d_max_v_pinned) {
        CUDA_CHECK_ALLOC(cudaHostAlloc(&d_max_v_pinned, 2 * sizeof(int), cudaHostAllocPortable), "Allocating d_max_v_pinned");
        d_max_v_pinned[0] = 0;
        d_max_v_pinned[1] = 0;
    }
    if (!d_det_vel_buffer) {
        CUDA_CHECK_ALLOC(cudaMalloc(&d_det_vel_buffer, 4 * sizeof(float)), "Allocating d_det_vel_buffer");
    }
}

void MPMSolver3DCUDA::uploadMaterialTableToDevice() {
    if (m_material_tables.empty()) return;
    for (auto& mat : m_material_tables) {
        mat.synchronizePillars();
    }
    allocateDeviceMemory();
    cudaMemcpy(d_material_tables, m_material_tables.data(), m_material_tables.size() * sizeof(MaterialTable3D), cudaMemcpyHostToDevice);
}

size_t MPMSolver3DCUDA::getAllocatedVRAM() const {
    size_t total = 0;
    total += m_allocated_grid_nodes * sizeof(MPMGridNode3D); // d_grid
    total += m_allocated_grid_nodes * sizeof(float);          // d_grid_n (helper)
    total += m_allocated_soa_bytes;                            // d_soa_buffer (SoA)
    total += m_allocated_material_tables * sizeof(MaterialTable3D); // d_material_tables
    total += m_allocated_active_nodes * sizeof(int);           // d_active_nodes
    total += m_allocated_compaction_indices * sizeof(int);     // d_compaction_indices
    total += m_allocated_f_ext_fsi * sizeof(float);             // d_f_ext_fsi
    total += m_allocated_temp_aos_particles * sizeof(MPMParticle3D); // d_temp_aos_particles
    total += m_allocated_slice_buf;                             // d_telemetry_slice_buf
    total += m_allocated_mat_grid_bytes;                        // d_mat_grid_buffer (dense fields or compact slots)
    total += m_allocated_mat_tag_bytes;                         // d_mat_tag (compact Bardenhagen layout)
    if (d_mat_slot_counters) total += 2 * sizeof(int);
    if (d_compaction_counters) total += 2 * sizeof(int);
    if (d_active_count) total += sizeof(int);
    if (d_boundary_flags) total += 2 * sizeof(int);
    if (d_max_v_buf) total += sizeof(float);
    if (d_num_active_nodes) total += sizeof(int);
    return total;
}

void MPMSolver3DCUDA::allocateActiveNodeBuffers() {
    size_t num_grid_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;

    if (num_grid_nodes > m_allocated_active_nodes) {
        if (d_active_nodes) cudaFree(d_active_nodes);
        if (d_num_active_nodes) cudaFree(d_num_active_nodes);
        CUDA_CHECK_ALLOC(cudaMalloc(&d_active_nodes, num_grid_nodes * sizeof(int)), "Allocating d_active_nodes");
        CUDA_CHECK_ALLOC(cudaMalloc(&d_num_active_nodes, sizeof(int)), "Allocating d_num_active_nodes");
        cudaMemset(d_num_active_nodes, 0, sizeof(int));
        m_allocated_active_nodes = num_grid_nodes;
        m_num_active_nodes = 0;
    }
}

void MPMSolver3DCUDA::freeActiveNodeBuffers() {
    if (d_active_nodes) { cudaFree(d_active_nodes); d_active_nodes = nullptr; }
    if (d_num_active_nodes) { cudaFree(d_num_active_nodes); d_num_active_nodes = nullptr; }
    m_allocated_active_nodes = 0;
    m_num_active_nodes = 0;
}

void MPMSolver3DCUDA::freeDeviceMemory() {
    if (d_grid) { cudaFree(d_grid); d_grid = nullptr; }
    if (d_grid_n) { cudaFree(d_grid_n); d_grid_n = nullptr; }
    if (d_particles) { cudaFree(d_particles); d_particles = nullptr; }
    if (d_temp_aos_particles) { cudaFree(d_temp_aos_particles); d_temp_aos_particles = nullptr; }
    m_allocated_temp_aos_particles = 0;
    freeSoABuffer();
    if (d_compaction_indices) { cudaFree(d_compaction_indices); d_compaction_indices = nullptr; }
    if (d_compaction_counters) { cudaFree(d_compaction_counters); d_compaction_counters = nullptr; }
    if (d_active_count) { cudaFree(d_active_count); d_active_count = nullptr; }
    if (d_boundary_flags) { cudaFree(d_boundary_flags); d_boundary_flags = nullptr; }
    m_allocated_compaction_indices = 0;
    if (d_material_tables) { cudaFree(d_material_tables); d_material_tables = nullptr; }
    if (d_max_v_buf) { cudaFree(d_max_v_buf); d_max_v_buf = nullptr; }
    if (d_max_v_pinned) { cudaFreeHost(d_max_v_pinned); d_max_v_pinned = nullptr; }
    if (d_telemetry_slice_buf) { cudaFree(d_telemetry_slice_buf); d_telemetry_slice_buf = nullptr; m_allocated_slice_buf = 0; }
    if (d_f_ext_fsi) { cudaFree(d_f_ext_fsi); d_f_ext_fsi = nullptr; }
    if (d_zonal_ghost_p) { cudaFree(d_zonal_ghost_p); d_zonal_ghost_p = nullptr; m_allocated_zonal_ghost_p = 0; }
    if (d_dem_cell_head) { cudaFree(d_dem_cell_head); d_dem_cell_head = nullptr; }
    if (d_dem_particle_next) { cudaFree(d_dem_particle_next); d_dem_particle_next = nullptr; }
    if (d_det_vel_buffer) { cudaFree(d_det_vel_buffer); d_det_vel_buffer = nullptr; }
    m_allocated_dem_particles = 0;
    freeActiveNodeBuffers();
    freeMatGridBuffers();
    if (d_mat_to_obj) { cudaFree(d_mat_to_obj); d_mat_to_obj = nullptr; }
    m_allocated_grid_nodes = 0;
    m_allocated_particles = 0;
    m_allocated_material_tables = 0;
}

void MPMSolver3DCUDA::initializeGrid(int nx, int ny, int nz, float dx, float dy, float dz, float xmin, float ymin, float zmin) {
    m_nx = nx; m_ny = ny; m_nz = nz;
    m_dx = dx; m_dy = dy; m_dz = dz;
    m_xmin = xmin; m_ymin = ymin; m_zmin = zmin;

    m_host_grid.clear(); // Lazy host grid allocation: only allocate when syncGridToHost or CPU FSI is called
    m_host_particles.clear();
    m_num_active_particles = 0;
    m_terminated = false;
    allocateDeviceMemory();
    if (d_boundary_flags) {
        cudaMemset(d_boundary_flags, 0, 2 * sizeof(int));
    }
}

bool MPMSolver3DCUDA::isCompactMultiMaterialStorageActive() const {
    // Zonal ghost scatter adds mass/momentum to the global node only, so the global node is
    // no longer identical to the single material field: use the dense layout in that case.
    return m_compact_mat_storage && !m_zonal_params.enabled;
}

void MPMSolver3DCUDA::setCompactMultiMaterialStorage(bool enable) {
    m_compact_mat_storage = enable;
    if (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen && d_mat_grid_buffer &&
        m_mat_grid_compact_layout != isCompactMultiMaterialStorageActive()) {
        allocateMatGridBuffers(static_cast<size_t>(m_nx) * m_ny * m_nz, m_num_materials);
    }
}

void MPMSolver3DCUDA::setInitialMultiMaterialSlotCapacity(size_t slots) {
    m_initial_mat_slot_capacity = std::max<size_t>(1, slots);
    if (m_mat_grid_compact_layout && m_mat_slot_capacity > m_initial_mat_slot_capacity) {
        m_mat_slot_capacity = 0; // allow the shrink; allocateMatGridBuffers resets tags and slots
    }
    if (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen && d_mat_grid_buffer) {
        allocateMatGridBuffers(static_cast<size_t>(m_nx) * m_ny * m_nz, m_num_materials);
    }
}

bool MPMSolver3DCUDA::allocateMatSlotBuffer(size_t slot_capacity, int num_materials) {
    int mats = std::max(1, num_materials);
    slot_capacity = std::max<size_t>(1, slot_capacity);
    size_t mat_nodes = slot_capacity * static_cast<size_t>(mats);
    size_t num_floats = 10 * mat_nodes;
    size_t bytes = num_floats * sizeof(float);

    bool replaced = false;
    if (!d_mat_grid_buffer || !m_mat_grid_compact_layout || bytes > m_allocated_mat_grid_bytes) {
        if (d_mat_grid_buffer) cudaFree(d_mat_grid_buffer);
        d_mat_grid_buffer = nullptr;
        m_allocated_mat_grid_bytes = 0;
        CUDA_CHECK_ALLOC(cudaMalloc(&d_mat_grid_buffer, bytes),
                         "Allocating compact d_mat_grid_buffer (" + std::to_string(slot_capacity) +
                         " slots x " + std::to_string(mats) + " materials)");
        m_allocated_mat_grid_bytes = bytes;
        replaced = true;
    }
    if (replaced || mats != m_mat_slot_materials || slot_capacity != m_mat_slot_capacity) {
        // Keep the "unused slot rows are zero" invariant required by the P2G atomics
        cudaMemset(d_mat_grid_buffer, 0, m_allocated_mat_grid_bytes);
        replaced = true;
    }
    m_mat_grid_compact_layout = true;
    m_mat_slot_capacity = slot_capacity;
    m_mat_slot_materials = mats;

    float* base = reinterpret_cast<float*>(d_mat_grid_buffer);
    d_mat_grid_m  = base;
    d_mat_grid_p  = base + mat_nodes;
    d_mat_grid_f  = base + 4 * mat_nodes;
    d_mat_grid_v  = base + 4 * mat_nodes; // In-place alias with d_mat_grid_f
    d_mat_grid_dv = base + 7 * mat_nodes;
    return replaced;
}

void MPMSolver3DCUDA::allocateMatGridBuffers(size_t num_nodes, int num_materials) {
    if (num_nodes == 0) return; // grid not initialised yet; allocateDeviceMemory() calls back later
    int mats = std::max(1, num_materials);

    if (isCompactMultiMaterialStorageActive()) {
        // --- Compact layout: per-node tag + multi-material slot buffer ---
        size_t tag_bytes = num_nodes * sizeof(int);
        bool fresh_tags = false;
        if (!d_mat_tag || tag_bytes > m_allocated_mat_tag_bytes) {
            if (d_mat_tag) cudaFree(d_mat_tag);
            d_mat_tag = nullptr;
            m_allocated_mat_tag_bytes = 0;
            CUDA_CHECK_ALLOC(cudaMalloc(&d_mat_tag, tag_bytes),
                             "Allocating d_mat_tag (" + std::to_string(num_nodes) + " ints)");
            m_allocated_mat_tag_bytes = tag_bytes;
            fresh_tags = true;
        }
        if (!d_mat_slot_counters) {
            CUDA_CHECK_ALLOC(cudaMalloc(&d_mat_slot_counters, 2 * sizeof(int)), "Allocating d_mat_slot_counters");
            cudaMemset(d_mat_slot_counters, 0, 2 * sizeof(int));
        }

        size_t cap = std::max(m_mat_slot_capacity, std::max<size_t>(1, m_initial_mat_slot_capacity));
        cap = std::min(cap, num_nodes);
        bool fresh_slots = allocateMatSlotBuffer(cap, mats);

        if (fresh_tags || fresh_slots) {
            // Existing tags would reference a discarded slot buffer: reset to EMPTY
            cudaMemset(d_mat_tag, 0xFF, m_allocated_mat_tag_bytes);
            m_num_mat_slots = 0;
        }
        return;
    }

    // --- Dense layout: one full-grid field per material ---
    if (d_mat_tag) { cudaFree(d_mat_tag); d_mat_tag = nullptr; }
    if (d_mat_slot_counters) { cudaFree(d_mat_slot_counters); d_mat_slot_counters = nullptr; }
    m_allocated_mat_tag_bytes = 0;
    m_mat_slot_capacity = 0;
    m_mat_slot_materials = 0;
    m_num_mat_slots = 0;

    size_t mat_nodes = static_cast<size_t>(mats) * num_nodes;
    size_t num_floats = 10 * mat_nodes;
    size_t bytes = num_floats * sizeof(float);

    if (bytes > m_allocated_mat_grid_bytes || !d_mat_grid_buffer || m_mat_grid_compact_layout) {
        if (d_mat_grid_buffer) cudaFree(d_mat_grid_buffer);
        d_mat_grid_buffer = nullptr;
        m_allocated_mat_grid_bytes = 0;
        CUDA_CHECK_ALLOC(cudaMalloc(&d_mat_grid_buffer, bytes),
                         "Allocating d_mat_grid_buffer (" + std::to_string(num_floats) + " floats)");
        m_allocated_mat_grid_bytes = bytes;
    }
    m_mat_grid_compact_layout = false;

    float* base = reinterpret_cast<float*>(d_mat_grid_buffer);
    d_mat_grid_m      = base;
    d_mat_grid_p      = base + mat_nodes;
    d_mat_grid_f      = base + 4 * mat_nodes;
    d_mat_grid_v      = base + 4 * mat_nodes; // In-place alias with d_mat_grid_f
    d_mat_grid_dv     = base + 7 * mat_nodes;
    cudaMemsetAsync(d_mat_grid_buffer, 0, bytes);
}

void MPMSolver3DCUDA::freeMatGridBuffers() {
    if (d_mat_grid_buffer) {
        cudaFree(d_mat_grid_buffer);
        d_mat_grid_buffer = nullptr;
    }
    d_mat_grid_m = nullptr;
    d_mat_grid_p = nullptr;
    d_mat_grid_f = nullptr;
    d_mat_grid_v = nullptr;
    d_mat_grid_dv = nullptr;
    // NOTE: d_mat_to_obj is owned by setObjectMaterialMapping() and released in freeDeviceMemory().
    // It must survive a material-buffer regrow (previously it was freed here, which silently
    // nulled the material->object table whenever the buffer grew after the mapping was set).
    if (d_mat_tag) { cudaFree(d_mat_tag); d_mat_tag = nullptr; }
    if (d_mat_slot_counters) { cudaFree(d_mat_slot_counters); d_mat_slot_counters = nullptr; }
    m_allocated_mat_grid_bytes = 0;
    m_allocated_mat_tag_bytes = 0;
    m_mat_grid_compact_layout = false;
    m_mat_slot_capacity = 0;
    m_mat_slot_materials = 0;
    m_num_mat_slots = 0;
}

void MPMSolver3DCUDA::setContactMethod(MPMContactMethod method) {
    m_contact_method = method;
    if (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen) {
        size_t num_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
        allocateMatGridBuffers(num_nodes, m_num_materials);
    } else {
        freeMatGridBuffers();
    }
}

void MPMSolver3DCUDA::setObjectMaterialMapping(const std::vector<int>& obj_to_mat, int num_materials) {
    m_object_to_mat = obj_to_mat;
    m_num_materials = std::max(1, num_materials);
    for (auto& p : m_host_particles) {
        if (p.object_id >= 0 && p.object_id < static_cast<int>(m_object_to_mat.size())) {
            p.material_id = m_object_to_mat[p.object_id];
        } else if (p.object_id > 0 && (p.object_id - 1) < static_cast<int>(m_object_to_mat.size())) {
            p.material_id = m_object_to_mat[p.object_id - 1];
        } else {
            p.material_id = 0;
        }
    }
    m_device_dirty = true;

    // Build mat_to_obj lookup table on host and upload to device
    std::vector<int> mat_to_obj(m_num_materials, 0);
    for (int m = 0; m < m_num_materials; ++m) {
        mat_to_obj[m] = std::max(1, m + 1);
    }
    for (size_t oi = 1; oi < m_object_to_mat.size(); ++oi) {
        int m = m_object_to_mat[oi];
        if (m >= 0 && m < m_num_materials) {
            mat_to_obj[m] = static_cast<int>(oi);
        }
    }
    if (d_mat_to_obj) {
        cudaFree(d_mat_to_obj);
        d_mat_to_obj = nullptr;
    }
    CUDA_CHECK_ALLOC(cudaMalloc(&d_mat_to_obj, m_num_materials * sizeof(int)), "Allocating d_mat_to_obj");
    cudaMemcpy(d_mat_to_obj, mat_to_obj.data(), m_num_materials * sizeof(int), cudaMemcpyHostToDevice);

    if (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen) {
        size_t num_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
        allocateMatGridBuffers(num_nodes, m_num_materials);
    } else {
        freeMatGridBuffers();
    }
}

void MPMSolver3DCUDA::setBoundaryConditions(MPMBoundaryCondition3D x_min, MPMBoundaryCondition3D x_max,
                                             MPMBoundaryCondition3D y_min, MPMBoundaryCondition3D y_max,
                                             MPMBoundaryCondition3D z_min, MPMBoundaryCondition3D z_max) {
    m_bc_x_min = x_min; m_bc_x_max = x_max;
    m_bc_y_min = y_min; m_bc_y_max = y_max;
    m_bc_z_min = z_min; m_bc_z_max = z_max;
}

void MPMSolver3DCUDA::addBoxObject(int obj_id, float pos_x, float pos_y, float pos_z,
                                    float size_x, float size_y, float size_z,
                                    float vel_x, float vel_y, float vel_z,
                                    float angular_vel_x, float angular_vel_y, float angular_vel_z,
                                    float density, float E, float nu,
                                    float yield_stress, float hardening, float failure_strain,
                                    float tensile_failure_stress, int ppc,
                                    MPMParticleDistribution particle_dist, MPMBoundaryFilling boundary_fill,
                                    float rot_x, float rot_y, float rot_z,
                                    float clip_z_min, float clip_z_max) {
    if (d_soa_buffer && !m_host_particles.empty() && !m_device_dirty && m_step_count > 0) {
        downloadSoA2AoS();
    }
    MPMSolver3D cpu_solver;
    cpu_solver.setDomainGeometry(m_dx, m_dy, m_dz, m_xmin, m_ymin, m_zmin, m_nx, m_ny, m_nz);
    cpu_solver.addBoxObject(obj_id, pos_x, pos_y, pos_z, size_x, size_y, size_z,
                            vel_x, vel_y, vel_z, angular_vel_x, angular_vel_y, angular_vel_z,
                            density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill,
                            rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
    m_host_particles.insert(m_host_particles.end(), cpu_solver.getParticles().begin(), cpu_solver.getParticles().end());
    if (obj_id >= static_cast<int>(m_material_tables.size())) {
        m_material_tables.resize(obj_id + 1);
    }
    m_material_tables[obj_id] = cpu_solver.getMaterialTable(obj_id);
    m_device_dirty = true;
}

void MPMSolver3DCUDA::addSphereObject(int obj_id, float pos_x, float pos_y, float pos_z, float radius, float inner_radius,
                                       float vel_x, float vel_y, float vel_z,
                                       float angular_vel_x, float angular_vel_y, float angular_vel_z,
                                       float density, float E, float nu,
                                       float yield_stress, float hardening, float failure_strain,
                                       float tensile_failure_stress, int ppc,
                                       MPMParticleDistribution particle_dist, MPMBoundaryFilling boundary_fill,
                                       float rot_x, float rot_y, float rot_z,
                                       float clip_z_min, float clip_z_max) {
    if (d_soa_buffer && !m_host_particles.empty() && !m_device_dirty && m_step_count > 0) {
        downloadSoA2AoS();
    }
    MPMSolver3D cpu_solver;
    cpu_solver.setDomainGeometry(m_dx, m_dy, m_dz, m_xmin, m_ymin, m_zmin, m_nx, m_ny, m_nz);
    cpu_solver.addSphereObject(obj_id, pos_x, pos_y, pos_z, radius, inner_radius,
                               vel_x, vel_y, vel_z, angular_vel_x, angular_vel_y, angular_vel_z,
                               density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill,
                               rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
    m_host_particles.insert(m_host_particles.end(), cpu_solver.getParticles().begin(), cpu_solver.getParticles().end());
    if (obj_id >= static_cast<int>(m_material_tables.size())) {
        m_material_tables.resize(obj_id + 1);
    }
    m_material_tables[obj_id] = cpu_solver.getMaterialTable(obj_id);
    m_device_dirty = true;
}

void MPMSolver3DCUDA::addCylinderObject(int obj_id, float pos_x, float pos_y, float pos_z,
                                          float radius, float inner_radius, float height,
                                          float vel_x, float vel_y, float vel_z,
                                          float angular_vel_x, float angular_vel_y, float angular_vel_z,
                                          float density, float E, float nu,
                                          float yield_stress, float hardening, float failure_strain,
                                          float tensile_failure_stress, int ppc,
                                          MPMParticleDistribution particle_dist, MPMBoundaryFilling boundary_fill,
                                          float rot_x, float rot_y, float rot_z,
                                          float clip_z_min, float clip_z_max) {
    if (d_soa_buffer && !m_host_particles.empty() && !m_device_dirty && m_step_count > 0) {
        downloadSoA2AoS();
    }
    MPMSolver3D cpu_solver;
    cpu_solver.setDomainGeometry(m_dx, m_dy, m_dz, m_xmin, m_ymin, m_zmin, m_nx, m_ny, m_nz);
    cpu_solver.addCylinderObject(obj_id, pos_x, pos_y, pos_z, radius, inner_radius, height,
                                vel_x, vel_y, vel_z, angular_vel_x, angular_vel_y, angular_vel_z,
                                density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill,
                                rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
    m_host_particles.insert(m_host_particles.end(), cpu_solver.getParticles().begin(), cpu_solver.getParticles().end());
    if (obj_id >= static_cast<int>(m_material_tables.size())) {
        m_material_tables.resize(obj_id + 1);
    }
    m_material_tables[obj_id] = cpu_solver.getMaterialTable(obj_id);
    m_device_dirty = true;
}

void MPMSolver3DCUDA::addSTLObject(int obj_id, const std::string& stl_filepath,
                                    float pos_x, float pos_y, float pos_z,
                                    float scale_x, float scale_y, float scale_z,
                                    float vel_x, float vel_y, float vel_z,
                                    float angular_vel_x, float angular_vel_y, float angular_vel_z,
                                    float density, float E, float nu,
                                    float yield_stress, float hardening, float failure_strain,
                                    float tensile_failure_stress, int ppc,
                                    MPMParticleDistribution particle_dist, MPMBoundaryFilling boundary_fill,
                                    const std::string& voxelization_method,
                                    float rot_x, float rot_y, float rot_z,
                                    const std::string& origin_mode) {
    if (d_soa_buffer && !m_host_particles.empty() && !m_device_dirty && m_step_count > 0) {
        downloadSoA2AoS();
    }
    MPMSolver3D cpu_solver;
    cpu_solver.setDomainGeometry(m_dx, m_dy, m_dz, m_xmin, m_ymin, m_zmin, m_nx, m_ny, m_nz);
    cpu_solver.addSTLObject(obj_id, stl_filepath, pos_x, pos_y, pos_z, scale_x, scale_y, scale_z,
                            vel_x, vel_y, vel_z, angular_vel_x, angular_vel_y, angular_vel_z,
                            density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, voxelization_method,
                            rot_x, rot_y, rot_z, origin_mode);
    m_host_particles.insert(m_host_particles.end(), cpu_solver.getParticles().begin(), cpu_solver.getParticles().end());
    if (obj_id >= static_cast<int>(m_material_tables.size())) {
        m_material_tables.resize(obj_id + 1);
    }
    m_material_tables[obj_id] = cpu_solver.getMaterialTable(obj_id);
    m_device_dirty = true;
}

void MPMSolver3DCUDA::syncToDevice() {
    allocateDeviceMemory();
    uploadMaterialTableToDevice();
    if (!m_host_particles.empty()) {
        uploadAoS2SoA();
    }
    size_t num_grid_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
    cudaMemset(d_grid, 0, num_grid_nodes * sizeof(MPMGridNode3D));
    m_device_dirty = false;
}

void MPMSolver3DCUDA::syncToHost() {
    if (!m_host_particles.empty()) {
        downloadSoA2AoS();
    }
    size_t num_grid_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
    m_host_grid.resize(num_grid_nodes);
    cudaMemcpy(m_host_grid.data(), d_grid, num_grid_nodes * sizeof(MPMGridNode3D), cudaMemcpyDeviceToHost);
}

void MPMSolver3DCUDA::syncParticlesToHost() {
    if (!m_host_particles.empty()) {
        downloadSoA2AoS();
    }
}

MPMVTKSnapshot3D MPMSolver3DCUDA::extractVTKSnapshot(bool has_vel, bool has_stress, bool has_strain, bool has_damage, bool has_temp, bool has_pressure, bool has_material_id, bool has_object_id, bool has_particle_density) {
    MPMVTKSnapshot3D snap;
    if (d_soa_buffer && m_step_count > 0) {
        compactTerminatedParticlesDevice();
    }
    size_t count = (m_num_active_particles > 0) ? m_num_active_particles : m_host_particles.size();
    snap.num_particles = static_cast<int>(count);
    snap.has_vel = has_vel;
    snap.has_stress = has_stress;
    snap.has_strain = has_strain;
    snap.has_damage = has_damage;
    snap.has_temp = has_temp;
    snap.has_pressure = has_pressure;
    snap.has_material_id = has_material_id;
    snap.has_object_id = has_object_id;
    snap.has_particle_density = has_particle_density;

    if (count == 0) return snap;

    snap.points.resize(count * 3);
    if (has_vel) snap.vel.resize(count * 3);
    if (has_stress) snap.von_mises.resize(count);
    if (has_pressure) snap.pressure.resize(count);
    if (has_strain) snap.ep_bar.resize(count);
    if (has_damage) snap.damage.resize(count);
    if (has_temp) snap.temp.resize(count);
    if (has_object_id) snap.obj_id.resize(count);
    if (has_material_id) snap.material_id.resize(count);
    if (has_particle_density) snap.particle_density.resize(count);

    const float inv_dx = (m_dx > 0.0f) ? (1.0f / m_dx) : 0.0f;
    const float inv_dy = (m_dy > 0.0f) ? (1.0f / m_dy) : 0.0f;
    const float inv_dz = (m_dz > 0.0f) ? (1.0f / m_dz) : 0.0f;

    if (d_soa_buffer) {
        constexpr size_t MAX_VTK_CHUNK_SIZE = 262144;
        size_t chunk_cap = std::min(count, MAX_VTK_CHUNK_SIZE);

        float *d_pts = nullptr, *d_v = nullptr, *d_vm = nullptr, *d_p = nullptr;
        float *d_ep = nullptr, *d_dmg = nullptr, *d_tmp = nullptr;
        uint8_t *d_obj = nullptr, *d_mat = nullptr, *d_pd = nullptr;

        CUDA_CHECK_ALLOC(cudaMalloc(&d_pts, chunk_cap * 3 * sizeof(float)), "Allocating d_pts for VTK snapshot");
        if (has_vel) CUDA_CHECK_ALLOC(cudaMalloc(&d_v, chunk_cap * 3 * sizeof(float)), "Allocating d_v for VTK snapshot");
        if (has_stress) CUDA_CHECK_ALLOC(cudaMalloc(&d_vm, chunk_cap * sizeof(float)), "Allocating d_vm for VTK snapshot");
        if (has_pressure) CUDA_CHECK_ALLOC(cudaMalloc(&d_p, chunk_cap * sizeof(float)), "Allocating d_p for VTK snapshot");
        if (has_strain) CUDA_CHECK_ALLOC(cudaMalloc(&d_ep, chunk_cap * sizeof(float)), "Allocating d_ep for VTK snapshot");
        if (has_damage) CUDA_CHECK_ALLOC(cudaMalloc(&d_dmg, chunk_cap * sizeof(float)), "Allocating d_dmg for VTK snapshot");
        if (has_temp) CUDA_CHECK_ALLOC(cudaMalloc(&d_tmp, chunk_cap * sizeof(float)), "Allocating d_tmp for VTK snapshot");
        if (has_object_id) CUDA_CHECK_ALLOC(cudaMalloc(&d_obj, chunk_cap * sizeof(uint8_t)), "Allocating d_obj for VTK snapshot");
        if (has_material_id) CUDA_CHECK_ALLOC(cudaMalloc(&d_mat, chunk_cap * sizeof(uint8_t)), "Allocating d_mat for VTK snapshot");
        if (has_particle_density) CUDA_CHECK_ALLOC(cudaMalloc(&d_pd, chunk_cap * sizeof(uint8_t)), "Allocating d_pd for VTK snapshot");

        int threads = 256;
        const size_t num_grid_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
        const bool can_count_grid = has_particle_density && d_grid && num_grid_nodes > 0 &&
                                    m_dx > 0.0f && m_dy > 0.0f && m_dz > 0.0f;

        if (can_count_grid) {
            int grid_blocks = (static_cast<int>(num_grid_nodes) + threads - 1) / threads;
            kernel_clear_grid_cell_counts_3d<<<grid_blocks, threads>>>(d_grid, static_cast<int>(num_grid_nodes), -1);
            int p_blocks = (static_cast<int>(count) + threads - 1) / threads;
            kernel_count_particles_per_cell_3d<<<p_blocks, threads>>>(
                d_soa, static_cast<int>(count),
                d_grid, m_nx, m_ny, m_nz,
                inv_dx, inv_dy, inv_dz,
                m_xmin, m_ymin, m_zmin
            );
        }

        for (size_t offset = 0; offset < count; offset += chunk_cap) {
            size_t cur_chunk = std::min(chunk_cap, count - offset);
            int blocks = (static_cast<int>(cur_chunk) + threads - 1) / threads;
            kernel_extract_mpm_vtk_snapshot_3d<<<blocks, threads>>>(
                d_soa, static_cast<int>(offset), static_cast<int>(cur_chunk),
                d_pts, d_v, d_vm, d_p, d_ep, d_dmg, d_tmp, d_obj, d_mat, d_pd,
                can_count_grid ? d_grid : nullptr, m_nx, m_ny, m_nz,
                inv_dx, inv_dy, inv_dz,
                m_xmin, m_ymin, m_zmin,
                has_vel, has_stress, has_strain, has_damage, has_temp,
                has_pressure, has_material_id, has_object_id, has_particle_density
            );
            cudaDeviceSynchronize();

            cudaMemcpy(snap.points.data() + offset * 3, d_pts, cur_chunk * 3 * sizeof(float), cudaMemcpyDeviceToHost);
            if (has_vel && d_v) cudaMemcpy(snap.vel.data() + offset * 3, d_v, cur_chunk * 3 * sizeof(float), cudaMemcpyDeviceToHost);
            if (has_stress && d_vm) cudaMemcpy(snap.von_mises.data() + offset, d_vm, cur_chunk * sizeof(float), cudaMemcpyDeviceToHost);
            if (has_pressure && d_p) cudaMemcpy(snap.pressure.data() + offset, d_p, cur_chunk * sizeof(float), cudaMemcpyDeviceToHost);
            if (has_strain && d_ep) cudaMemcpy(snap.ep_bar.data() + offset, d_ep, cur_chunk * sizeof(float), cudaMemcpyDeviceToHost);
            if (has_damage && d_dmg) cudaMemcpy(snap.damage.data() + offset, d_dmg, cur_chunk * sizeof(float), cudaMemcpyDeviceToHost);
            if (has_temp && d_tmp) cudaMemcpy(snap.temp.data() + offset, d_tmp, cur_chunk * sizeof(float), cudaMemcpyDeviceToHost);
            if (has_object_id && d_obj) cudaMemcpy(snap.obj_id.data() + offset, d_obj, cur_chunk * sizeof(uint8_t), cudaMemcpyDeviceToHost);
            if (has_material_id && d_mat) cudaMemcpy(snap.material_id.data() + offset, d_mat, cur_chunk * sizeof(uint8_t), cudaMemcpyDeviceToHost);
            if (has_particle_density && d_pd) cudaMemcpy(snap.particle_density.data() + offset, d_pd, cur_chunk * sizeof(uint8_t), cudaMemcpyDeviceToHost);
        }

        if (can_count_grid) {
            int grid_blocks = (static_cast<int>(num_grid_nodes) + threads - 1) / threads;
            kernel_clear_grid_cell_counts_3d<<<grid_blocks, threads>>>(d_grid, static_cast<int>(num_grid_nodes), 0);
        }

        cudaFree(d_pts);
        if (d_v) cudaFree(d_v);
        if (d_vm) cudaFree(d_vm);
        if (d_p) cudaFree(d_p);
        if (d_ep) cudaFree(d_ep);
        if (d_dmg) cudaFree(d_dmg);
        if (d_tmp) cudaFree(d_tmp);
        if (d_obj) cudaFree(d_obj);
        if (d_mat) cudaFree(d_mat);
        if (d_pd) cudaFree(d_pd);
    } else {
        const size_t num_grid_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
        const bool can_count_host = has_particle_density && m_nx > 0 && m_ny > 0 && m_nz > 0 &&
                                    m_dx > 0.0f && m_dy > 0.0f && m_dz > 0.0f;
        if (can_count_host) {
            if (m_host_grid.size() < num_grid_nodes) {
                m_host_grid.resize(num_grid_nodes);
            }
            #pragma omp parallel for schedule(static)
            for (size_t n = 0; n < num_grid_nodes; ++n) {
                for (int s = 0; s < 8; ++s) {
                    *mpm_cell_slot_ptr(m_host_grid[n], s) = -1;
                }
            }
            #pragma omp parallel for schedule(static)
            for (size_t i = 0; i < count; ++i) {
                const auto& p = m_host_particles[i];
                int cx = std::clamp(static_cast<int>(std::floor((p.x[0] - m_xmin) * inv_dx)), 0, m_nx - 1);
                int cy = std::clamp(static_cast<int>(std::floor((p.x[1] - m_ymin) * inv_dy)), 0, m_ny - 1);
                int cz = std::clamp(static_cast<int>(std::floor((p.x[2] - m_zmin) * inv_dz)), 0, m_nz - 1);
                size_t c_idx = (static_cast<size_t>(cx) * m_ny + cy) * m_nz + cz;
                MPMGridNode3D& cell = m_host_grid[c_idx];
                for (int s = 0; s < 8; ++s) {
                    int* slot_ptr = mpm_cell_slot_ptr(cell, s);
                    int expected = -1;
                    if (__atomic_compare_exchange_n(slot_ptr, &expected, static_cast<int>(i), false, __ATOMIC_RELAXED, __ATOMIC_RELAXED)) {
                        break;
                    }
                }
            }
        }

        const float cell_min_dx = std::min({m_dx, m_dy, m_dz});

        #pragma omp parallel for schedule(static)
        for (size_t i = 0; i < count; ++i) {
            const auto& p = m_host_particles[i];
            snap.points[i * 3 + 0] = static_cast<float>(p.x[0]);
            snap.points[i * 3 + 1] = static_cast<float>(p.x[1]);
            snap.points[i * 3 + 2] = static_cast<float>(p.x[2]);

            if (has_vel) {
                snap.vel[i * 3 + 0] = static_cast<float>(p.v[0]);
                snap.vel[i * 3 + 1] = static_cast<float>(p.v[1]);
                snap.vel[i * 3 + 2] = static_cast<float>(p.v[2]);
            }
            if (has_stress || has_pressure) {
                double mean_s = (p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0;
                if (has_stress) {
                    double s00 = p.sigma[0][0] - mean_s;
                    double s11 = p.sigma[1][1] - mean_s;
                    double s22 = p.sigma[2][2] - mean_s;
                    double s01 = p.sigma[0][1];
                    double s12 = p.sigma[1][2];
                    double s20 = p.sigma[2][0];
                    snap.von_mises[i] = static_cast<float>(std::sqrt(1.5 * (s00*s00 + s11*s11 + s22*s22 + 2.0*(s01*s01 + s12*s12 + s20*s20))));
                }
                if (has_pressure) {
                    snap.pressure[i] = static_cast<float>(-mean_s);
                }
            }
            if (has_strain) snap.ep_bar[i] = static_cast<float>(p.ep_bar);
            if (has_damage) snap.damage[i] = static_cast<float>(p.damage);
            if (has_temp) snap.temp[i] = static_cast<float>(p.temperature);
            if (has_object_id) snap.obj_id[i] = static_cast<uint8_t>(std::clamp(p.object_id, 0, 255));
            if (has_material_id) snap.material_id[i] = static_cast<uint8_t>(std::clamp(p.material_id, 0, 255));
            if (has_particle_density) {
                if (can_count_host) {
                    int cx = std::clamp(static_cast<int>(std::floor((p.x[0] - m_xmin) * inv_dx)), 0, m_nx - 1);
                    int cy = std::clamp(static_cast<int>(std::floor((p.x[1] - m_ymin) * inv_dy)), 0, m_ny - 1);
                    int cz = std::clamp(static_cast<int>(std::floor((p.x[2] - m_zmin) * inv_dz)), 0, m_nz - 1);
                    int ix_lo = std::max(0, cx - 1), ix_hi = std::min(m_nx - 1, cx + 1);
                    int iy_lo = std::max(0, cy - 1), iy_hi = std::min(m_ny - 1, cy + 1);
                    int iz_lo = std::max(0, cz - 1), iz_hi = std::min(m_nz - 1, cz + 1);

                    const int my_obj = p.object_id;
                    const bool my_failed = p.has_failed || (p.damage >= 0.99f);
                    const float dp_i = (p.lp[0] > 1.0e-9f) ? (2.0f * p.lp[0]) : (0.5f * cell_min_dx);

                    int neighbor_count = 1;
                    for (int ix = ix_lo; ix <= ix_hi; ++ix) {
                        for (int iy = iy_lo; iy <= iy_hi; ++iy) {
                            size_t row_base = (static_cast<size_t>(ix) * m_ny + iy) * m_nz;
                            for (int iz = iz_lo; iz <= iz_hi; ++iz) {
                                const MPMGridNode3D& cell = m_host_grid[row_base + iz];
                                for (int s = 0; s < 8; ++s) {
                                    int q = mpm_cell_slot_read(cell, s);
                                    if (q < 0) break;
                                    if (static_cast<size_t>(q) == i) continue;
                                    const auto& pq = m_host_particles[q];
                                    if (pq.object_id != my_obj) continue;
                                    const bool q_failed = pq.has_failed || (pq.damage >= 0.99f);
                                    if (my_failed != q_failed) continue;

                                    const float dp_q = (pq.lp[0] > 1.0e-9f) ? (2.0f * pq.lp[0]) : dp_i;
                                    const float r_cut = 1.80f * 0.5f * (dp_i + dp_q);
                                    const float dx_pq = p.x[0] - pq.x[0];
                                    const float dy_pq = p.x[1] - pq.x[1];
                                    const float dz_pq = p.x[2] - pq.x[2];
                                    if (dx_pq * dx_pq + dy_pq * dy_pq + dz_pq * dz_pq <= r_cut * r_cut) {
                                        ++neighbor_count;
                                    }
                                }
                            }
                        }
                    }
                    snap.particle_density[i] = static_cast<uint8_t>(std::clamp(neighbor_count, 1, 255));
                } else {
                    snap.particle_density[i] = 1;
                }
            }
        }

        if (can_count_host) {
            #pragma omp parallel for schedule(static)
            for (size_t n = 0; n < num_grid_nodes; ++n) {
                MPMGridNode3D& g = m_host_grid[n];
                g.dT_cond = 0.0f;
                g.q_fric = 0.0f;
                g.t_star = 0.0f;
                g.v_energetic = 0.0f;
                g.v_reacted = 0.0f;
                g.f_int[0] = 0.0f;
                g.f_int[1] = 0.0f;
                g.f_int[2] = 0.0f;
            }
        }
    }
    return snap;
}

void MPMSolver3DCUDA::syncGridToHost() {
    if (d_grid) {
        size_t num_grid_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
        m_host_grid.resize(num_grid_nodes);
        cudaMemcpy(m_host_grid.data(), d_grid, num_grid_nodes * sizeof(MPMGridNode3D), cudaMemcpyDeviceToHost);
    }
}

void MPMSolver3DCUDA::uploadGridToDevice() {
    if (d_grid && !m_host_grid.empty()) {
        size_t num_grid_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
        cudaMemcpy(d_grid, m_host_grid.data(), num_grid_nodes * sizeof(MPMGridNode3D), cudaMemcpyHostToDevice);
        storeFSIForces();
    }
}

void MPMSolver3DCUDA::clearGridDevice() {
    if (!d_grid) return;
    allocateActiveNodeBuffers();

    const bool bardenhagen = (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen && d_mat_grid_buffer);
    const bool compact = bardenhagen && m_mat_grid_compact_layout;

    if (m_num_active_nodes > 0 && d_active_nodes) {
        int threads = 256;
        int blocks = (m_num_active_nodes + threads - 1) / threads;
        kernel_clear_active_nodes_3d<<<blocks, threads>>>(d_grid, d_active_nodes, m_num_active_nodes);
        if (compact) {
            // Every tagged node was appended to the active list on first touch, so resetting the
            // list restores all tags to EMPTY. Only the used slot prefix needs zeroing.
            if (d_mat_tag) {
                kernel_reset_mat_tags_3d<<<blocks, threads>>>(d_mat_tag, d_active_nodes, m_num_active_nodes);
            }
            if (m_num_mat_slots > 0) {
                const size_t mat_nodes = m_mat_slot_capacity * static_cast<size_t>(m_mat_slot_materials);
                const size_t used_rows = static_cast<size_t>(m_num_mat_slots) * m_mat_slot_materials;
                float* base = reinterpret_cast<float*>(d_mat_grid_buffer);
                cudaMemsetAsync(base,                 0, used_rows * sizeof(float));     // m
                cudaMemsetAsync(base + mat_nodes,     0, used_rows * 3 * sizeof(float)); // p
                cudaMemsetAsync(base + 4 * mat_nodes, 0, used_rows * 3 * sizeof(float)); // f / v
                cudaMemsetAsync(base + 7 * mat_nodes, 0, used_rows * 3 * sizeof(float)); // dv
            }
        } else if (bardenhagen) {
            size_t num_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
            kernel_clear_active_mat_nodes_3d<<<blocks, threads>>>(
                d_mat_grid_m, d_mat_grid_p, d_mat_grid_f,
                d_mat_grid_dv,
                d_active_nodes, m_num_active_nodes,
                num_nodes, m_num_materials);
        }
    } else {
        size_t num_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
        cudaMemsetAsync(d_grid, 0, num_nodes * sizeof(MPMGridNode3D));
        if (bardenhagen) {
            cudaMemsetAsync(d_mat_grid_buffer, 0, m_allocated_mat_grid_bytes);
        }
        if (compact && d_mat_tag) {
            cudaMemsetAsync(d_mat_tag, 0xFF, m_allocated_mat_tag_bytes);
        }
    }
    if (d_num_active_nodes) {
        cudaMemsetAsync(d_num_active_nodes, 0, sizeof(int));
    }
    m_num_active_nodes = 0;
    m_num_mat_slots = 0;
}

void MPMSolver3DCUDA::launchParticleToGrid(int num_particles, bool use_bardenhagen) {
    if (num_particles <= 0) return;
    const int threads_per_block = 256;
    const int blocks_particles = (num_particles + threads_per_block - 1) / threads_per_block;
    const int bxl = static_cast<int>(m_bc_x_min), bxh = static_cast<int>(m_bc_x_max);
    const int byl = static_cast<int>(m_bc_y_min), byh = static_cast<int>(m_bc_y_max);
    const int bzl = static_cast<int>(m_bc_z_min), bzh = static_cast<int>(m_bc_z_max);
    const size_t num_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;

    // Layout safety net: the setters keep the layout in sync, but never scatter with a stale one.
    if (use_bardenhagen && m_mat_grid_compact_layout != isCompactMultiMaterialStorageActive()) {
        allocateMatGridBuffers(num_nodes, m_num_materials);
    }
    const bool compact = use_bardenhagen && m_mat_grid_compact_layout && d_mat_tag && d_mat_slot_counters;

    if (!compact) {
        kernel_p2g_3d<MPM_P2G_SCATTER><<<blocks_particles, threads_per_block>>>(
            d_soa, num_particles,
            d_grid, m_nx, m_ny, m_nz,
            m_dx, m_dy, m_dz, static_cast<int>(m_transfer_scheme),
            m_xmin, m_ymin, m_zmin,
            d_active_nodes, d_num_active_nodes,
            d_material_tables,
            use_bardenhagen ? d_mat_grid_m : nullptr,
            use_bardenhagen ? d_mat_grid_p : nullptr,
            use_bardenhagen ? d_mat_grid_f : nullptr,
            m_num_materials,
            bxl, bxh, byl, byh, bzl, bzh);
        if (d_num_active_nodes) {
            cudaMemcpy(&m_num_active_nodes, d_num_active_nodes, sizeof(int), cudaMemcpyDeviceToHost);
        }
        return;
    }

    // Pass 1: tag nodes with their contributing material(s) and build the active-node list.
    kernel_p2g_3d<MPM_P2G_TAG><<<blocks_particles, threads_per_block>>>(
        d_soa, num_particles,
        d_grid, m_nx, m_ny, m_nz,
        m_dx, m_dy, m_dz, static_cast<int>(m_transfer_scheme),
        m_xmin, m_ymin, m_zmin,
        d_active_nodes, d_num_active_nodes,
        d_material_tables,
        d_mat_grid_m, d_mat_grid_p, d_mat_grid_f,
        m_num_materials,
        bxl, bxh, byl, byh, bzl, bzh,
        d_mat_tag, d_mat_slot_counters);
    if (d_num_active_nodes) {
        cudaMemcpy(&m_num_active_nodes, d_num_active_nodes, sizeof(int), cudaMemcpyDeviceToHost);
    }

    // Pass 2: hand out compact slots to multi-material nodes (grow geometrically on overflow).
    int h_counters[2] = {0, 0};
    for (;;) {
        cudaMemset(d_mat_slot_counters, 0, 2 * sizeof(int));
        if (m_num_active_nodes > 0) {
            int blocks_active = (m_num_active_nodes + threads_per_block - 1) / threads_per_block;
            kernel_assign_mat_slots_3d<<<blocks_active, threads_per_block>>>(
                d_mat_tag, d_active_nodes, m_num_active_nodes, m_num_materials,
                d_mat_slot_counters, static_cast<int>(m_mat_slot_capacity));
        }
        cudaMemcpy(h_counters, d_mat_slot_counters, 2 * sizeof(int), cudaMemcpyDeviceToHost);
        if (h_counters[0] < 0) {
            throw std::runtime_error("[MPM3D-CUDA] Compact multi-material slot counter overflow");
        }
        const size_t needed = static_cast<size_t>(h_counters[0]);
        if (needed <= m_mat_slot_capacity) break;

        size_t new_cap = std::max(needed + needed / 2, m_mat_slot_capacity + m_mat_slot_capacity / 2);
        new_cap = std::max(std::min(new_cap, num_nodes), needed);
        std::cerr << "[MPM3D-CUDA] Growing compact multi-material slot buffer: "
                  << m_mat_slot_capacity << " -> " << new_cap << " slots ("
                  << needed << " multi-material nodes, "
                  << (new_cap * static_cast<size_t>(std::max(1, m_num_materials)) * 10 * sizeof(float)) / (1024.0 * 1024.0)
                  << " MiB)" << std::endl;
        // Tags of this step are kept: the assignment pass re-labels every multi-material node.
        allocateMatSlotBuffer(new_cap, m_num_materials);
    }
    m_num_mat_slots = h_counters[0];

    // Pass 3: scatter. Single-material nodes use the global node; multi-material nodes use slots.
    kernel_p2g_3d<MPM_P2G_SCATTER><<<blocks_particles, threads_per_block>>>(
        d_soa, num_particles,
        d_grid, m_nx, m_ny, m_nz,
        m_dx, m_dy, m_dz, static_cast<int>(m_transfer_scheme),
        m_xmin, m_ymin, m_zmin,
        nullptr, nullptr,   // active list already built by the tag pass
        d_material_tables,
        d_mat_grid_m, d_mat_grid_p, d_mat_grid_f,
        m_num_materials,
        bxl, bxh, byl, byh, bzl, bzh,
        d_mat_tag, d_mat_slot_counters);

    // Fail loudly if the tag and scatter passes disagreed (would otherwise lose material mass).
    cudaMemcpy(h_counters, d_mat_slot_counters, 2 * sizeof(int), cudaMemcpyDeviceToHost);
    if (h_counters[1] != 0) {
        std::string msg = "[MPM3D-CUDA] Compact multi-material P2G consistency failure: " +
                          std::to_string(h_counters[1]) +
                          " particle-node contributions had no material storage. Aborting step.";
        std::cerr << msg << std::endl;
        throw std::runtime_error(msg);
    }
}

void MPMSolver3DCUDA::particleToGridOnly() {
    if (m_host_particles.empty()) return;
    if (m_device_dirty) syncToDevice();

    size_t num_particles = (m_num_active_particles > 0) ? m_num_active_particles : m_host_particles.size();
    if (num_particles == 0) return;
    size_t num_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;

    // Zero the active grid neighborhoods
    clearGridDevice();

    bool use_bardenhagen = (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen && d_mat_grid_buffer != nullptr);

    // Run P2G only (also refreshes m_num_active_nodes)
    launchParticleToGrid(static_cast<int>(num_particles), use_bardenhagen);

    // Download grid to host so FSI forces can be injected into m_host_grid
    m_host_grid.resize(num_nodes);
    cudaMemcpy(m_host_grid.data(), d_grid, num_nodes * sizeof(MPMGridNode3D), cudaMemcpyDeviceToHost);
}

void MPMSolver3DCUDA::particleToGridDeviceOnly() {
    if (m_host_particles.empty()) return;
    if (m_device_dirty) syncToDevice();

    size_t num_particles = (m_num_active_particles > 0) ? m_num_active_particles : m_host_particles.size();
    if (num_particles == 0) return;

    // Zero the active grid neighborhoods
    clearGridDevice();

    bool use_bardenhagen = (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen && d_mat_grid_buffer != nullptr);

    // Run P2G entirely on GPU (only the small active-count / slot-count readbacks)
    launchParticleToGrid(static_cast<int>(num_particles), use_bardenhagen);
}

float MPMSolver3DCUDA::computeStepSize(float cfl) {
    size_t num_particles = (m_num_active_particles > 0) ? m_num_active_particles : m_host_particles.size();
    if (num_particles == 0) return 1.0e-4f;

    if (m_device_dirty) syncToDevice();
    allocateDeviceMemory();
    if (!d_soa_buffer || !d_max_v_buf) return 1.0e-4f;

    float init_max_speed = 100.0f;
    union { float f; int i; } u_init, u_res;
    u_init.f = init_max_speed;
    int init_int = u_init.i;

    cudaMemcpyAsync(d_max_v_buf, &init_int, sizeof(int), cudaMemcpyHostToDevice, 0);

    int threads = 256;
    int blocks = (static_cast<int>(num_particles) + threads - 1) / threads;
    kernel_compute_max_speed<<<blocks, threads, threads * sizeof(float)>>>(d_soa, static_cast<int>(num_particles), d_max_v_buf, d_material_tables);

    if (m_step_count == 0 || !d_max_v_pinned) {
        int result_int = 0;
        cudaMemcpy(&result_int, d_max_v_buf, sizeof(int), cudaMemcpyDeviceToHost);
        u_res.i = result_int;
        if (d_max_v_pinned) {
            d_max_v_pinned[0] = result_int;
            d_max_v_pinned[1] = result_int;
        }
    } else {
        int buf_idx = m_step_count % 2;
        cudaMemcpyAsync(&d_max_v_pinned[buf_idx], d_max_v_buf, sizeof(int), cudaMemcpyDeviceToHost, 0);

        int prev_idx = (m_step_count - 1) % 2;
        int result_int = d_max_v_pinned[prev_idx];
        if (result_int == 0) result_int = init_int;
        u_res.i = result_int;
    }

    float max_speed = u_res.f;
    if (std::isnan(max_speed) || std::isinf(max_speed) || max_speed < 1.0f) max_speed = 100.0f;

    float min_h = std::min({m_dx, m_dy, m_dz});
    float dt_crit = min_h / max_speed;
    float stability_factor = 1.0f / std::sqrt(3.0f); // 3D Courant stability factor (~0.577)
    m_cached_dt = std::max(1.0e-8f, cfl * stability_factor * dt_crit);
    m_last_v_max = max_speed;
    m_last_cfl = cfl;
    m_dt_calc_counter++;
    return m_cached_dt;
}

__global__ void kernel_restore_grid_mass_momentum(MPMGridNode3D* grid, const MPMGridNode3D* grid_n, int num_nodes) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_nodes) return;
    grid[idx].m = grid_n[idx].m;
    grid[idx].p[0] = grid_n[idx].p[0];
    grid[idx].p[1] = grid_n[idx].p[1];
    grid[idx].p[2] = grid_n[idx].p[2];
}

// Kernel: Restore per-node f_ext from a flat FSI force buffer after P2G resets the grid
__global__ void kernel_restore_fsi_forces(MPMGridNode3D* grid, const float* d_f_ext_fsi, int num_nodes) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_nodes) return;
    grid[idx].f_ext[0] = d_f_ext_fsi[idx * 3 + 0];
    grid[idx].f_ext[1] = d_f_ext_fsi[idx * 3 + 1];
    grid[idx].f_ext[2] = d_f_ext_fsi[idx * 3 + 2];
}

// Kernel: Apply external gravity body force to grid nodes (f_ext += m * g)
__global__ void kernel_apply_gravity_to_grid(MPMGridNode3D* grid, int num_nodes, float gx, float gy, float gz) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_nodes) return;
    MPMGridNode3D& node = grid[idx];
    if (node.m > MPMGridNode3D::MIN_MASS) {
        node.f_ext[0] += node.m * gx;
        node.f_ext[1] += node.m * gy;
        node.f_ext[2] += node.m * gz;
    }
}

// Kernel: Write per-node f_ext into the FSI force buffer (stores from grid → buffer)
__global__ void kernel_store_fsi_forces(const MPMGridNode3D* grid, float* d_f_ext_fsi, int num_nodes) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_nodes) return;
    d_f_ext_fsi[idx * 3 + 0] = grid[idx].f_ext[0];
    d_f_ext_fsi[idx * 3 + 1] = grid[idx].f_ext[1];
    d_f_ext_fsi[idx * 3 + 2] = grid[idx].f_ext[2];
}

void MPMSolver3DCUDA::storeFSIForces() {
    if (!d_grid) return;
    size_t num_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
    size_t buf_size = num_nodes * 3;
    if (!d_f_ext_fsi || m_allocated_f_ext_fsi < buf_size) {
        if (d_f_ext_fsi) cudaFree(d_f_ext_fsi);
        CUDA_CHECK_ALLOC(cudaMalloc(&d_f_ext_fsi, buf_size * sizeof(float)), "Allocating d_f_ext_fsi");
        m_allocated_f_ext_fsi = buf_size;
    }
    int threads = 256;
    int blocks = (static_cast<int>(num_nodes) + threads - 1) / threads;
    kernel_store_fsi_forces<<<blocks, threads>>>(d_grid, d_f_ext_fsi, static_cast<int>(num_nodes));
}

void MPMSolver3DCUDA::clearFSIForces() {
    if (d_f_ext_fsi && m_allocated_f_ext_fsi > 0) {
        cudaMemset(d_f_ext_fsi, 0, m_allocated_f_ext_fsi * sizeof(float));
    }
}

// =============================================================================
// Zonal FV -> MPM exterior traction (overlapping Schwarz coupling)
// -----------------------------------------------------------------------------
// The MPM sleeve occupies r < R_outer. Without an exterior contribution, the stress
// divergence at its boundary nodes is unbalanced and the outer face behaves as a
// traction-free (vacuum) surface: incoming compression reflects as tension.
//
// Here the region just outside the sleeve is represented by ghost material points
// carrying the FV pressure, sigma_g = -p_FV * I. Their internal-force contribution
//
//     f_i += - V_g * sigma_g . grad N_i(x_g) = V_g * p_FV * grad N_i(x_g)
//
// is computed with exactly the same shape functions as kernel_p2g_3d. Hence, for a
// uniform pressure field, sum over (particles + ghosts) of V * grad N_i = 0 at every
// node, and the boundary node force vanishes identically (no artificial free surface).
// Ghost points carry the FV density and velocity, so they also add mass, momentum and
// mass-weighted pressure to boundary nodes: the boundary nodes then hold their full mass
// and the interface presents the impedance rho * c of the continuing water (a pressure-only
// ghost leaves boundary nodes at partial mass, which over-accelerates them and makes the
// interface acoustically soft). Contributions go only to nodes that already carry particle
// mass (node.m > MIN_MASS), so the active-node list is unchanged and nothing accumulates on
// inactive nodes. Sub-points are placed on a 2 x 2 x 2 lattice per cell (spacing dx/2,
// matching the ppc = 8 Cartesian particle lattice) and are kept only where the sleeve
// has no material, i.e. r >= R_outer or z > clip_z_max, and z >= clip_z_min (below the
// seabed clip the soil MPM / FEM own the region).
// =============================================================================
__device__ inline void zonal_ghost_scatter_force(
    MPMGridNode3D* grid, int nx, int ny, int nz, float dx, float dy, float dz,
    int scheme, float px, float py, float pz,
    float Vg, float pg, float rhog, float ugx, float ugy, float ugz)
{
    // Ghost material point: volume Vg, pressure pg, density rhog, velocity ug (from FV)
    const float Vp_times_p = Vg * pg;
    const float mg = rhog * Vg;
    int base_i = static_cast<int>(floorf(px / dx));
    int base_j = static_cast<int>(floorf(py / dy));
    int base_k = static_cast<int>(floorf(pz / dz));

    if (scheme == 3) {
        // Radial MLS (Wendland C2), identical to kernel_p2g_3d scheme 3
        float R_supp = 2.0f * fmaxf(fmaxf(dx, dy), dz);
        float w_sum = 0.0f, sx = 0.0f, sy = 0.0f, sz = 0.0f;
        float sxx = 0.0f, sxy = 0.0f, sxz = 0.0f, syy = 0.0f, syz = 0.0f, szz = 0.0f;
        for (int oi = -2; oi <= 2; ++oi) {
            int i = base_i + oi; if (i < 0 || i >= nx) continue;
            float ddx = (static_cast<float>(i) + 0.5f) * dx - px;
            for (int oj = -2; oj <= 2; ++oj) {
                int j = base_j + oj; if (j < 0 || j >= ny) continue;
                float ddy = (static_cast<float>(j) + 0.5f) * dy - py;
                for (int ok = -2; ok <= 2; ++ok) {
                    int k = base_k + ok; if (k < 0 || k >= nz) continue;
                    float ddz = (static_cast<float>(k) + 0.5f) * dz - pz;
                    float r = sqrtf(ddx * ddx + ddy * ddy + ddz * ddz);
                    if (r >= R_supp) continue;
                    float w = evalWendland_C2_dev(r, R_supp);
                    if (w < 1.0e-7f) continue;
                    w_sum += w; sx += w * ddx; sy += w * ddy; sz += w * ddz;
                    sxx += w * ddx * ddx; sxy += w * ddx * ddy; sxz += w * ddx * ddz;
                    syy += w * ddy * ddy; syz += w * ddy * ddz; szz += w * ddz * ddz;
                }
            }
        }
        if (w_sum <= 1.0e-7f) return;
        float iw = 1.0f / w_sum;
        float ddxc = sx * iw, ddyc = sy * iw, ddzc = sz * iw;
        float D00 = sxx * iw - ddxc * ddxc, D01 = sxy * iw - ddxc * ddyc, D02 = sxz * iw - ddxc * ddzc;
        float D11 = syy * iw - ddyc * ddyc, D12 = syz * iw - ddyc * ddzc, D22 = szz * iw - ddzc * ddzc;
        float Di[3][3];
        float det = D00 * (D11 * D22 - D12 * D12) - D01 * (D01 * D22 - D12 * D02) + D02 * (D01 * D12 - D11 * D02);
        if (det > 1.0e-18f) {
            float id = 1.0f / det;
            Di[0][0] = (D11 * D22 - D12 * D12) * id; Di[0][1] = -(D01 * D22 - D12 * D02) * id; Di[0][2] = (D01 * D12 - D11 * D02) * id;
            Di[1][0] = Di[0][1]; Di[1][1] = (D00 * D22 - D02 * D02) * id; Di[1][2] = -(D00 * D12 - D01 * D02) * id;
            Di[2][0] = Di[0][2]; Di[2][1] = Di[1][2]; Di[2][2] = (D00 * D11 - D01 * D01) * id;
        } else {
            float d_iso = 3.75f / (dx * dx);
            Di[0][0] = d_iso; Di[0][1] = 0.0f; Di[0][2] = 0.0f;
            Di[1][0] = 0.0f; Di[1][1] = d_iso; Di[1][2] = 0.0f;
            Di[2][0] = 0.0f; Di[2][1] = 0.0f; Di[2][2] = d_iso;
        }
        float xc = px + ddxc, yc = py + ddyc, zc = pz + ddzc;
        for (int oi = -2; oi <= 2; ++oi) {
            int i = base_i + oi; if (i < 0 || i >= nx) continue;
            float nxp = (static_cast<float>(i) + 0.5f) * dx;
            for (int oj = -2; oj <= 2; ++oj) {
                int j = base_j + oj; if (j < 0 || j >= ny) continue;
                float nyp = (static_cast<float>(j) + 0.5f) * dy;
                for (int ok = -2; ok <= 2; ++ok) {
                    int k = base_k + ok; if (k < 0 || k >= nz) continue;
                    float nzp = (static_cast<float>(k) + 0.5f) * dz;
                    float ddx = nxp - px, ddy = nyp - py, ddz = nzp - pz;
                    float r = sqrtf(ddx * ddx + ddy * ddy + ddz * ddz);
                    if (r >= R_supp) continue;
                    float w = evalWendland_C2_dev(r, R_supp);
                    if (w < 1.0e-7f) continue;
                    size_t n_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                    MPMGridNode3D* node = &grid[n_idx];
                    if (node->m <= MPMGridNode3D::MIN_MASS) continue;
                    const float m_ref = rhog * dx * dy * dz;
                    float weight = w * iw;
                    float m_cap = fmaxf(0.0f, 1.05f * m_ref - node->m);
                    float dm = fminf(mg * weight, m_cap);
                    if (dm > 0.0f) {
                        atomicAdd(&node->m, dm);
                        atomicAdd(&node->p[0], dm * ugx);
                        atomicAdd(&node->p[1], dm * ugy);
                        atomicAdd(&node->p[2], dm * ugz);
                    }
                    float cx = nxp - xc, cy = nyp - yc, cz = nzp - zc;
                    atomicAdd(&node->f_ext[0], Vp_times_p * weight * (Di[0][0] * cx + Di[0][1] * cy + Di[0][2] * cz));
                    atomicAdd(&node->f_ext[1], Vp_times_p * weight * (Di[1][0] * cx + Di[1][1] * cy + Di[1][2] * cz));
                    atomicAdd(&node->f_ext[2], Vp_times_p * weight * (Di[2][0] * cx + Di[2][1] * cy + Di[2][2] * cz));
                }
            }
        }
        return;
    }

    // Tensor-product schemes, identical stencils to kernel_p2g_3d
    const bool cubic = (scheme == 4);
    const int o_lo = cubic ? -2 : -1;
    const int o_hi = 2;
    const float lp = 0.25f * dx; // GIMP half-length of a dx/2 ghost sub-point
    float Sx[5], dSx[5], Sy[5], dSy[5], Sz[5], dSz[5];
    for (int o = o_lo; o <= o_hi; ++o) {
        int a = o - o_lo;
        float xi = (static_cast<float>(base_i + o) + 0.5f) * dx;
        float yi = (static_cast<float>(base_j + o) + 0.5f) * dy;
        float zi = (static_cast<float>(base_k + o) + 0.5f) * dz;
        if (cubic) {
            Sx[a] = evalCubicBSpline_S_dev(px, xi, dx); dSx[a] = evalCubicBSpline_dS_dev(px, xi, dx);
            Sy[a] = evalCubicBSpline_S_dev(py, yi, dy); dSy[a] = evalCubicBSpline_dS_dev(py, yi, dy);
            Sz[a] = evalCubicBSpline_S_dev(pz, zi, dz); dSz[a] = evalCubicBSpline_dS_dev(pz, zi, dz);
        } else if (scheme == 2) {
            Sx[a] = evalBSpline_S_dev(px, xi, dx); dSx[a] = evalBSpline_dS_dev(px, xi, dx);
            Sy[a] = evalBSpline_S_dev(py, yi, dy); dSy[a] = evalBSpline_dS_dev(py, yi, dy);
            Sz[a] = evalBSpline_S_dev(pz, zi, dz); dSz[a] = evalBSpline_dS_dev(pz, zi, dz);
        } else if (scheme == 1) {
            Sx[a] = evalGIMP_S_dev(px, xi, dx, lp); dSx[a] = evalGIMP_dS_dev(px, xi, dx, lp);
            Sy[a] = evalGIMP_S_dev(py, yi, dy, lp); dSy[a] = evalGIMP_dS_dev(py, yi, dy, lp);
            Sz[a] = evalGIMP_S_dev(pz, zi, dz, lp); dSz[a] = evalGIMP_dS_dev(pz, zi, dz, lp);
        } else {
            Sx[a] = evalLinear_S_dev(px, xi, dx); dSx[a] = evalLinear_dS_dev(px, xi, dx);
            Sy[a] = evalLinear_S_dev(py, yi, dy); dSy[a] = evalLinear_dS_dev(py, yi, dy);
            Sz[a] = evalLinear_S_dev(pz, zi, dz); dSz[a] = evalLinear_dS_dev(pz, zi, dz);
        }
    }
    for (int oi = o_lo; oi <= o_hi; ++oi) {
        int i = base_i + oi; if (i < 0 || i >= nx) continue;
        int ai = oi - o_lo; if (fabsf(Sx[ai]) < 1.0e-7f) continue;
        for (int oj = o_lo; oj <= o_hi; ++oj) {
            int j = base_j + oj; if (j < 0 || j >= ny) continue;
            int aj = oj - o_lo; if (fabsf(Sy[aj]) < 1.0e-7f) continue;
            for (int ok = o_lo; ok <= o_hi; ++ok) {
                int k = base_k + ok; if (k < 0 || k >= nz) continue;
                int ak = ok - o_lo; if (fabsf(Sz[ak]) < 1.0e-7f) continue;
                size_t n_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                MPMGridNode3D* node = &grid[n_idx];
                if (node->m <= MPMGridNode3D::MIN_MASS) continue;
                const float m_ref = rhog * dx * dy * dz;
                float wN = Sx[ai] * Sy[aj] * Sz[ak];
                float m_cap = fmaxf(0.0f, 1.05f * m_ref - node->m);
                float dm = fminf(mg * wN, m_cap);
                if (dm > 0.0f) {
                    atomicAdd(&node->m, dm);
                    atomicAdd(&node->p[0], dm * ugx);
                    atomicAdd(&node->p[1], dm * ugy);
                    atomicAdd(&node->p[2], dm * ugz);
                }
                float gNx = dSx[ai] * Sy[aj] * Sz[ak];
                float gNy = Sx[ai] * dSy[aj] * Sz[ak];
                float gNz = Sx[ai] * Sy[aj] * dSz[ak];
                atomicAdd(&node->f_ext[0], Vp_times_p * gNx);
                atomicAdd(&node->f_ext[1], Vp_times_p * gNy);
                atomicAdd(&node->f_ext[2], Vp_times_p * gNz);
            }
        }
    }
}

__global__ void kernel_zonal_ghost_pressure_traction_3d(
    MPMGridNode3D* grid, const float* ghost_p, int nx, int ny, int nz,
    float dx, float dy, float dz, float xmin, float ymin, float zmin,
    int scheme, Blast::ZonalHandoff3DParams zp)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int num_nodes = nx * ny * nz;
    if (idx >= num_nodes) return;
    float pg = ghost_p[idx];
    if (!(pg > -1.0e29f)) return; // sentinel kZonalGhostNone: not an exterior band cell
    float rhog = ghost_p[idx + 1 * num_nodes];
    float ugx  = ghost_p[idx + 2 * num_nodes];
    float ugy  = ghost_p[idx + 3 * num_nodes];
    float ugz  = ghost_p[idx + 4 * num_nodes];

    int gi = idx / (ny * nz);
    int gj = (idx / nz) % ny;
    int gk = idx % nz;
    const float V_sub = 0.125f * dx * dy * dz;
    const float R_outer = static_cast<float>(zp.sleeve_radius);
    const float czmin = static_cast<float>(zp.clip_z_min);
    const float czmax = static_cast<float>(zp.clip_z_max);

    for (int a = 0; a < 2; ++a) {
        float px = (static_cast<float>(gi) + 0.25f + 0.5f * a) * dx;
        for (int b = 0; b < 2; ++b) {
            float py = (static_cast<float>(gj) + 0.25f + 0.5f * b) * dy;
            for (int c = 0; c < 2; ++c) {
                float pz = (static_cast<float>(gk) + 0.25f + 0.5f * c) * dz;
                float zabs = zmin + pz;
                if (zabs < czmin) continue;
                float rx = xmin + px - static_cast<float>(zp.center_x);
                float ry = ymin + py - static_cast<float>(zp.center_y);
                float rz = zabs - static_cast<float>(zp.center_z);
                float r = zp.is_cylinder ? sqrtf(rx * rx + ry * ry) : sqrtf(rx * rx + ry * ry + rz * rz);
                bool outside_sleeve = (r >= R_outer) || (zabs > czmax);
                if (!outside_sleeve) continue;
                zonal_ghost_scatter_force(grid, nx, ny, nz, dx, dy, dz, scheme, px, py, pz, V_sub, pg, rhog, ugx, ugy, ugz);
            }
        }
    }
}

void MPMSolver3DCUDA::setZonalHandoffParams(const Blast::ZonalHandoff3DParams& params) {
    m_zonal_params = params;
    if (params.enabled) {
        (void)getZonalGhostPressureBuffer(); // one-time set-up allocation (Directive 13)
    }
    // Zonal ghosts add mass to the global node only, so compact Bardenhagen storage is
    // unavailable while zonal coupling is on: switch the material-field layout if required.
    if (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen && d_mat_grid_buffer &&
        m_mat_grid_compact_layout != isCompactMultiMaterialStorageActive()) {
        allocateMatGridBuffers(static_cast<size_t>(m_nx) * m_ny * m_nz, m_num_materials);
    }
}

float* MPMSolver3DCUDA::getZonalGhostPressureBuffer() {
    size_t num_floats = static_cast<size_t>(m_nx) * m_ny * m_nz * kZonalGhostPlanes;
    if (!d_zonal_ghost_p || m_allocated_zonal_ghost_p < num_floats) {
        if (d_zonal_ghost_p) cudaFree(d_zonal_ghost_p);
        d_zonal_ghost_p = nullptr;
        CUDA_CHECK_ALLOC(cudaMalloc(&d_zonal_ghost_p, num_floats * sizeof(float)), "Allocating d_zonal_ghost_p");
        m_allocated_zonal_ghost_p = num_floats;
    }
    return d_zonal_ghost_p;
}

void MPMSolver3DCUDA::applyZonalGhostPressureTraction() {
    if (!d_grid || !d_zonal_ghost_p || !m_zonal_params.enabled) return;
    // Use the transfer scheme of the fluid sleeve material (per-material override if set)
    int scheme = static_cast<int>(m_transfer_scheme);
    for (const auto& mt : m_material_tables) {
        if (mt.material_model == MPMMaterialModel::TaitWater && mt.transfer_scheme >= 0) {
            scheme = mt.transfer_scheme;
            break;
        }
    }
    int num_nodes = m_nx * m_ny * m_nz;
    int threads = 256;
    int blocks = (num_nodes + threads - 1) / threads;
    kernel_zonal_ghost_pressure_traction_3d<<<blocks, threads>>>(
        d_grid, d_zonal_ghost_p, m_nx, m_ny, m_nz, m_dx, m_dy, m_dz,
        m_xmin, m_ymin, m_zmin, scheme, m_zonal_params);
    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
        throw std::runtime_error(std::string("[MPMSolver3DCUDA] kernel_zonal_ghost_pressure_traction_3d launch failed: ") + cudaGetErrorString(err));
    }
}

void MPMSolver3DCUDA::stepWithDt(float dt, bool run_p2g) {
    if (m_host_particles.empty()) return;
    if (m_device_dirty) syncToDevice();

    m_last_dt = dt;
    m_sim_time += static_cast<double>(dt);
    float sim_t = static_cast<float>(m_sim_time);
    cudaMemcpyToSymbol(d_current_sim_time, &sim_t, sizeof(float));
    m_step_count++;

    size_t num_particles = (m_num_active_particles > 0) ? m_num_active_particles : m_host_particles.size();
    if (num_particles == 0) return;
    size_t num_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;

    int threads_per_block = 256;
    int blocks_particles = (static_cast<int>(num_particles) + threads_per_block - 1) / threads_per_block;
    int blocks_nodes = (static_cast<int>(num_nodes) + threads_per_block - 1) / threads_per_block;
    int blocks_active = (m_num_active_nodes > 0 && d_active_nodes)
                      ? (m_num_active_nodes + threads_per_block - 1) / threads_per_block
                      : blocks_nodes;
    float avg_p_mass = 0.001f;
    if (!m_host_particles.empty()) {
        float min_m = 1.0e30f;
        for (size_t pi = 0; pi < std::min(m_host_particles.size(), (size_t)10000); ++pi) {
            if (m_host_particles[pi].m > 0.0f && m_host_particles[pi].m < min_m) {
                min_m = m_host_particles[pi].m;
            }
        }
        if (min_m < 1.0e29f) avg_p_mass = min_m;
    }

    bool use_bardenhagen = (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen && d_mat_grid_buffer != nullptr);
    // Material-field pointers are resolved at launch time: the compact slot buffer may be
    // regrown (and its pointers change) inside launchParticleToGrid().
    auto matM   = [&]() -> const float* { return use_bardenhagen ? d_mat_grid_m : nullptr; };
    auto matV   = [&]() -> const float* { return use_bardenhagen ? d_mat_grid_v : nullptr; };
    auto matDV  = [&]() -> const float* { return use_bardenhagen ? d_mat_grid_dv : nullptr; };
    auto matTag = [&]() -> const int*   { return (use_bardenhagen && m_mat_grid_compact_layout) ? d_mat_tag : nullptr; };

    if (m_time_scheme == MPMTimeIntegrationScheme::RK2) {
        // --- 2nd-Order Midpoint RK2 ---
        // 1. Predictor Stage (Half-step dt/2)
        if (run_p2g) {
            clearGridDevice();
            launchParticleToGrid(static_cast<int>(num_particles), use_bardenhagen);
            if (d_num_active_nodes) {
                blocks_active = (m_num_active_nodes > 0 && d_active_nodes)
                              ? (m_num_active_nodes + threads_per_block - 1) / threads_per_block
                              : blocks_nodes;
            }
            if (d_f_ext_fsi) {
                kernel_restore_fsi_forces<<<blocks_nodes, threads_per_block>>>(d_grid, d_f_ext_fsi, static_cast<int>(num_nodes));
            } else if (m_zonal_params.enabled && d_zonal_ghost_p) {
                applyZonalGhostPressureTraction();
            }
        }
        if (m_has_gravity) {
            kernel_apply_gravity_to_grid<<<blocks_nodes, threads_per_block>>>(d_grid, static_cast<int>(num_nodes), m_gravity[0], m_gravity[1], m_gravity[2]);
        }

        if (use_bardenhagen) {
            kernel_bardenhagen_grid_update_3d<<<blocks_active, threads_per_block>>>(
                d_grid, static_cast<int>(num_nodes), m_nx, m_ny, m_nz,
                0.5f * dt, avg_p_mass,
                static_cast<int>(m_bc_x_min), static_cast<int>(m_bc_x_max),
                static_cast<int>(m_bc_y_min), static_cast<int>(m_bc_y_max),
                static_cast<int>(m_bc_z_min), static_cast<int>(m_bc_z_max),
                d_active_nodes, m_num_active_nodes,
                m_num_materials,
                d_mat_grid_m, d_mat_grid_p, d_mat_grid_f,
                d_mat_grid_v, d_mat_grid_dv,
                m_dem_friction, m_dem_restitution, m_dx,
                d_material_tables, d_mat_to_obj,
                m_dy, m_dz,
                m_lysmer_params.rho, m_lysmer_params.c_p, m_lysmer_params.c_s,
                m_lysmer_params.normal_relaxation, m_lysmer_params.shear_relaxation,
                matTag(),
                m_enable_impact_welding, m_enable_frictional_heating);
        } else {
            kernel_grid_update_3d<<<blocks_active, threads_per_block>>>(d_grid, static_cast<int>(num_nodes), m_nx, m_ny, m_nz,
                                                                       0.5f * dt, avg_p_mass,
                                                                       static_cast<int>(m_bc_x_min), static_cast<int>(m_bc_x_max),
                                                                       static_cast<int>(m_bc_y_min), static_cast<int>(m_bc_y_max),
                                                                       static_cast<int>(m_bc_z_min), static_cast<int>(m_bc_z_max),
                                                                       d_active_nodes, m_num_active_nodes,
                                                                       m_dx, m_dy, m_dz,
                                                                       m_lysmer_params.rho, m_lysmer_params.c_p, m_lysmer_params.c_s,
                                                                       m_lysmer_params.normal_relaxation, m_lysmer_params.shear_relaxation);
        }

        if (m_enable_thermal_conduction) {
            kernel_thermal_conduction_3d<<<blocks_active, threads_per_block>>>(d_grid, m_nx, m_ny, m_nz, m_dx, m_dy, m_dz, 0.5f * dt, d_active_nodes, m_num_active_nodes);
        }

        updateDetonators(0.5f * dt);

        if (m_smooth_plastic_strain) {
            kernel_smooth_plastic_strain_3d<<<blocks_active, threads_per_block>>>(d_grid, d_grid_n, m_nx, m_ny, m_nz, d_active_nodes, m_num_active_nodes);
            kernel_copy_smoothed_plastic_strain_3d<<<blocks_active, threads_per_block>>>(d_grid, d_grid_n, static_cast<int>(num_nodes), d_active_nodes, m_num_active_nodes);
        }

        kernel_g2p_stress_update_3d<<<blocks_particles, threads_per_block>>>(d_soa, static_cast<int>(num_particles),
                                                                             d_grid, m_nx, m_ny, m_nz,
                                                                             m_dx, m_dy, m_dz, 0.5f * dt, static_cast<int>(m_transfer_scheme),
                                                                             static_cast<int>(m_velocity_scheme), m_flip_blend,
                                                                             m_xmin, m_ymin, m_zmin,
                                                                             static_cast<int>(m_bc_x_min), static_cast<int>(m_bc_x_max),
                                                                             static_cast<int>(m_bc_y_min), static_cast<int>(m_bc_y_max),
                                                                             static_cast<int>(m_bc_z_min), static_cast<int>(m_bc_z_max),
                                                                             d_material_tables,
                                                                             matM(), matV(), matDV(), m_num_materials,
                                                                             m_zonal_params, d_boundary_flags, matTag(),
                                                                             m_enable_frictional_heating, m_enable_thermal_conduction, m_enable_impact_welding);

        // 2. Corrector Stage — P2G from predictor midpoint state
        clearGridDevice();
        launchParticleToGrid(static_cast<int>(num_particles), use_bardenhagen);
        if (d_num_active_nodes) {
            blocks_active = (m_num_active_nodes > 0 && d_active_nodes)
                          ? (m_num_active_nodes + threads_per_block - 1) / threads_per_block
                          : blocks_nodes;
        }
        if (d_f_ext_fsi) {
            kernel_restore_fsi_forces<<<blocks_nodes, threads_per_block>>>(d_grid, d_f_ext_fsi, static_cast<int>(num_nodes));
        } else if (m_zonal_params.enabled && d_zonal_ghost_p) {
            applyZonalGhostPressureTraction();
        }
        if (m_has_gravity) {
            kernel_apply_gravity_to_grid<<<blocks_nodes, threads_per_block>>>(d_grid, static_cast<int>(num_nodes), m_gravity[0], m_gravity[1], m_gravity[2]);
        }

        if (use_bardenhagen) {
            kernel_bardenhagen_grid_update_3d<<<blocks_active, threads_per_block>>>(
                d_grid, static_cast<int>(num_nodes), m_nx, m_ny, m_nz,
                dt, avg_p_mass,
                static_cast<int>(m_bc_x_min), static_cast<int>(m_bc_x_max),
                static_cast<int>(m_bc_y_min), static_cast<int>(m_bc_y_max),
                static_cast<int>(m_bc_z_min), static_cast<int>(m_bc_z_max),
                d_active_nodes, m_num_active_nodes,
                m_num_materials,
                d_mat_grid_m, d_mat_grid_p, d_mat_grid_f,
                d_mat_grid_v, d_mat_grid_dv,
                m_dem_friction, m_dem_restitution, m_dx,
                d_material_tables, d_mat_to_obj,
                m_dy, m_dz,
                m_lysmer_params.rho, m_lysmer_params.c_p, m_lysmer_params.c_s,
                m_lysmer_params.normal_relaxation, m_lysmer_params.shear_relaxation,
                matTag(),
                m_enable_impact_welding, m_enable_frictional_heating);
        } else {
            kernel_grid_update_3d<<<blocks_active, threads_per_block>>>(d_grid, static_cast<int>(num_nodes), m_nx, m_ny, m_nz,
                                                                       dt, avg_p_mass,
                                                                       static_cast<int>(m_bc_x_min), static_cast<int>(m_bc_x_max),
                                                                       static_cast<int>(m_bc_y_min), static_cast<int>(m_bc_y_max),
                                                                       static_cast<int>(m_bc_z_min), static_cast<int>(m_bc_z_max),
                                                                       d_active_nodes, m_num_active_nodes,
                                                                       m_dx, m_dy, m_dz,
                                                                       m_lysmer_params.rho, m_lysmer_params.c_p, m_lysmer_params.c_s,
                                                                       m_lysmer_params.normal_relaxation, m_lysmer_params.shear_relaxation);
        }

        if (m_enable_thermal_conduction) {
            kernel_thermal_conduction_3d<<<blocks_active, threads_per_block>>>(d_grid, m_nx, m_ny, m_nz, m_dx, m_dy, m_dz, 0.5f * dt, d_active_nodes, m_num_active_nodes);
        }

        updateDetonators(0.5f * dt);

        if (m_smooth_plastic_strain) {
            kernel_smooth_plastic_strain_3d<<<blocks_active, threads_per_block>>>(d_grid, d_grid_n, m_nx, m_ny, m_nz, d_active_nodes, m_num_active_nodes);
            kernel_copy_smoothed_plastic_strain_3d<<<blocks_active, threads_per_block>>>(d_grid, d_grid_n, static_cast<int>(num_nodes), d_active_nodes, m_num_active_nodes);
        }

        kernel_g2p_stress_update_3d<<<blocks_particles, threads_per_block>>>(d_soa, static_cast<int>(num_particles),
                                                                             d_grid, m_nx, m_ny, m_nz,
                                                                             m_dx, m_dy, m_dz, 0.5f * dt, static_cast<int>(m_transfer_scheme),
                                                                             static_cast<int>(m_velocity_scheme), m_flip_blend,
                                                                             m_xmin, m_ymin, m_zmin,
                                                                             static_cast<int>(m_bc_x_min), static_cast<int>(m_bc_x_max),
                                                                             static_cast<int>(m_bc_y_min), static_cast<int>(m_bc_y_max),
                                                                             static_cast<int>(m_bc_z_min), static_cast<int>(m_bc_z_max),
                                                                             d_material_tables,
                                                                             matM(), matV(), matDV(), m_num_materials,
                                                                             m_zonal_params, d_boundary_flags, matTag(),
                                                                             m_enable_frictional_heating, m_enable_thermal_conduction, m_enable_impact_welding);
    } else {
        // --- 1st-Order USL / USF ---
        if (run_p2g) {
            clearGridDevice();
            launchParticleToGrid(static_cast<int>(num_particles), use_bardenhagen);
            if (d_num_active_nodes) {
                blocks_active = (m_num_active_nodes > 0 && d_active_nodes)
                              ? (m_num_active_nodes + threads_per_block - 1) / threads_per_block
                              : blocks_nodes;
            }
            if (d_f_ext_fsi) {
                kernel_restore_fsi_forces<<<blocks_nodes, threads_per_block>>>(d_grid, d_f_ext_fsi, static_cast<int>(num_nodes));
            } else if (m_zonal_params.enabled && d_zonal_ghost_p) {
                applyZonalGhostPressureTraction();
            }
        }
        if (m_has_gravity) {
            kernel_apply_gravity_to_grid<<<blocks_nodes, threads_per_block>>>(d_grid, static_cast<int>(num_nodes), m_gravity[0], m_gravity[1], m_gravity[2]);
        }

        if (use_bardenhagen) {
            kernel_bardenhagen_grid_update_3d<<<blocks_active, threads_per_block>>>(
                d_grid, static_cast<int>(num_nodes), m_nx, m_ny, m_nz,
                dt, avg_p_mass,
                static_cast<int>(m_bc_x_min), static_cast<int>(m_bc_x_max),
                static_cast<int>(m_bc_y_min), static_cast<int>(m_bc_y_max),
                static_cast<int>(m_bc_z_min), static_cast<int>(m_bc_z_max),
                d_active_nodes, m_num_active_nodes,
                m_num_materials,
                d_mat_grid_m, d_mat_grid_p, d_mat_grid_f,
                d_mat_grid_v, d_mat_grid_dv,
                m_dem_friction, m_dem_restitution, m_dx,
                d_material_tables, d_mat_to_obj,
                m_dy, m_dz,
                m_lysmer_params.rho, m_lysmer_params.c_p, m_lysmer_params.c_s,
                m_lysmer_params.normal_relaxation, m_lysmer_params.shear_relaxation,
                matTag(),
                m_enable_impact_welding, m_enable_frictional_heating);
        } else {
            kernel_grid_update_3d<<<blocks_active, threads_per_block>>>(d_grid, static_cast<int>(num_nodes), m_nx, m_ny, m_nz,
                                                                       dt, avg_p_mass,
                                                                       static_cast<int>(m_bc_x_min), static_cast<int>(m_bc_x_max),
                                                                       static_cast<int>(m_bc_y_min), static_cast<int>(m_bc_y_max),
                                                                       static_cast<int>(m_bc_z_min), static_cast<int>(m_bc_z_max),
                                                                       d_active_nodes, m_num_active_nodes,
                                                                       m_dx, m_dy, m_dz,
                                                                       m_lysmer_params.rho, m_lysmer_params.c_p, m_lysmer_params.c_s,
                                                                       m_lysmer_params.normal_relaxation, m_lysmer_params.shear_relaxation);
        }

        if (m_enable_thermal_conduction) {
            kernel_thermal_conduction_3d<<<blocks_active, threads_per_block>>>(d_grid, m_nx, m_ny, m_nz, m_dx, m_dy, m_dz, dt, d_active_nodes, m_num_active_nodes);
        }

        updateDetonators(dt);

        if (m_smooth_plastic_strain) {
            kernel_smooth_plastic_strain_3d<<<blocks_active, threads_per_block>>>(d_grid, d_grid_n, m_nx, m_ny, m_nz, d_active_nodes, m_num_active_nodes);
            kernel_copy_smoothed_plastic_strain_3d<<<blocks_active, threads_per_block>>>(d_grid, d_grid_n, static_cast<int>(num_nodes), d_active_nodes, m_num_active_nodes);
        }

        kernel_g2p_stress_update_3d<<<blocks_particles, threads_per_block>>>(d_soa, static_cast<int>(num_particles),
                                                                             d_grid, m_nx, m_ny, m_nz,
                                                                             m_dx, m_dy, m_dz, dt, static_cast<int>(m_transfer_scheme),
                                                                             static_cast<int>(m_velocity_scheme), m_flip_blend,
                                                                             m_xmin, m_ymin, m_zmin,
                                                                             static_cast<int>(m_bc_x_min), static_cast<int>(m_bc_x_max),
                                                                             static_cast<int>(m_bc_y_min), static_cast<int>(m_bc_y_max),
                                                                             static_cast<int>(m_bc_z_min), static_cast<int>(m_bc_z_max),
                                                                             d_material_tables,
                                                                             matM(), matV(), matDV(), m_num_materials,
                                                                             m_zonal_params, d_boundary_flags, matTag(),
                                                                             m_enable_frictional_heating, m_enable_thermal_conduction, m_enable_impact_welding);
    }

    // Resolve Discrete Element (DEM) Contact & Collisions on GPU
    if (m_contact_method == MPMContactMethod::SubGridDEM || m_enable_dem_contact) {
        evaluateDEMContactDevice(dt);
    }

    // Check boundary flags for simulation termination (Terminate BC) and immediate compaction of exited particles
    if (d_boundary_flags) {
        int h_flags[2] = {0, 0};
        cudaMemcpy(h_flags, d_boundary_flags, 2 * sizeof(int), cudaMemcpyDeviceToHost);
        if (h_flags[0] != 0) {
            m_terminated = true;
        }
        if (h_flags[1] != 0 || (m_step_count % 50 == 0)) {
            int zero = 0;
            cudaMemcpyAsync(&d_boundary_flags[1], &zero, sizeof(int), cudaMemcpyHostToDevice);
            compactTerminatedParticlesDevice();
        }
    } else if (m_step_count % 50 == 0) {
        compactTerminatedParticlesDevice();
    }
}

__device__ inline uint32_t hashCoordsDEM3D(int cx, int cy, int cz, uint32_t table_size) {
    return ((static_cast<uint32_t>(cx) * 73856093u) ^
            (static_cast<uint32_t>(cy) * 19349663u) ^
            (static_cast<uint32_t>(cz) * 83492791u)) & (table_size - 1u);
}

__global__ void kernel_dem_clear_hash_table_3d(int* cell_head, uint32_t table_size) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx < table_size) {
        cell_head[idx] = -1;
    }
}

__global__ void kernel_dem_insert_particles_3d(
    MPMParticle3DSoA soa, int num_particles,
    int* cell_head, int* particle_next, uint32_t table_size,
    float inv_h_bin, float xmin, float ymin, float zmin) {
    
    int p_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (p_idx >= num_particles) return;

    if ((soa.state && soa.state[p_idx] == 2) || soa.m[p_idx] <= 0.0f) {
        particle_next[p_idx] = -1;
        return;
    }

    int cx = static_cast<int>(floorf((soa.x[0][p_idx] - xmin) * inv_h_bin));
    int cy = static_cast<int>(floorf((soa.x[1][p_idx] - ymin) * inv_h_bin));
    int cz = static_cast<int>(floorf((soa.x[2][p_idx] - zmin) * inv_h_bin));

    uint32_t bucket = hashCoordsDEM3D(cx, cy, cz, table_size);
    int old_head = atomicExch(&cell_head[bucket], p_idx);
    particle_next[p_idx] = old_head;
}

__device__ inline bool isDeviceGasParticle(int p_idx, const MPMParticle3DSoA& soa, const MaterialTable3D* d_mat_tables, int num_mat_tables) {
    if (soa.state && soa.state[p_idx] == 1) return true;
    if (d_mat_tables && num_mat_tables > 0) {
        int obj_id = soa.object_id[p_idx];
        if (obj_id >= 0 && obj_id < num_mat_tables) {
            const auto& mat = d_mat_tables[obj_id];
            bool is_energetic = (mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
                                 mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
                                 mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);
            if (is_energetic) {
                return (soa.lambda && soa.lambda[p_idx] > 0.5f);
            }
        }
    }
    return false;
}

__device__ inline bool isDeviceFluidParticle(int p_idx, const MPMParticle3DSoA& soa, const MaterialTable3D* d_mat_tables, int num_mat_tables) {
    if (d_mat_tables && num_mat_tables > 0) {
        int obj_id = soa.object_id[p_idx];
        if (obj_id >= 0 && obj_id < num_mat_tables) {
            return d_mat_tables[obj_id].material_model == MPMMaterialModel::TaitWater;
        }
    }
    return false;
}

__global__ void kernel_dem_resolve_contact_3d(
    MPMParticle3DSoA soa, int num_particles,
    const int* cell_head, const int* particle_next, uint32_t table_size,
    float inv_h_bin, float xmin, float ymin, float zmin,
    float contact_scale, float restitution, float friction_coef,
    int contact_mode, float velocity_threshold,
    const MaterialTable3D* d_mat_tables, int num_mat_tables,
    float cell_dx = 0.004f, float dt = 1.0e-6f) {

    int p = blockIdx.x * blockDim.x + threadIdx.x;
    if (p >= num_particles) return;

    if ((soa.state && soa.state[p] == 2) || soa.m[p] <= 0.0f) return;
    if (isDeviceFluidParticle(p, soa, d_mat_tables, num_mat_tables)) return;

    float px = soa.x[0][p];
    float py = soa.x[1][p];
    float pz = soa.x[2][p];

    int cx = static_cast<int>(floorf((px - xmin) * inv_h_bin));
    int cy = static_cast<int>(floorf((py - ymin) * inv_h_bin));
    int cz = static_cast<int>(floorf((pz - zmin) * inv_h_bin));

    float r_p = (soa.contact_radius && soa.contact_radius[p] > 1.0e-6f) ? soa.contact_radius[p] : (0.5f * cbrtf(fmaxf(1.0e-18f, soa.V0[p])));
    int obj_p = soa.object_id[p];
    float m_p = soa.m[p];

    float p_vx = soa.v[0][p];
    float p_vy = soa.v[1][p];
    float p_vz = soa.v[2][p];
    float total_dv_p = 0.0f;

    bool p_is_gas = isDeviceGasParticle(p, soa, d_mat_tables, num_mat_tables);
    bool p_is_solid = !p_is_gas;

    for (int dz_idx = -1; dz_idx <= 1; ++dz_idx) {
        for (int dy_idx = -1; dy_idx <= 1; ++dy_idx) {
            for (int dx_idx = -1; dx_idx <= 1; ++dx_idx) {
                uint32_t bucket = hashCoordsDEM3D(cx + dx_idx, cy + dy_idx, cz + dz_idx, table_size);
                int q = cell_head[bucket];

                while (q != -1) {
                    if (q > p) {
                        if ((!soa.state || soa.state[q] != 2) && soa.m[q] > 0.0f) {
                            int obj_q = soa.object_id[q];
                            // Intra-object contact is strictly excluded to prevent continuum popcorn fragmentation
                            if (obj_p != obj_q) {
                                if (isDeviceFluidParticle(q, soa, d_mat_tables, num_mat_tables)) {
                                    q = particle_next[q];
                                    continue;
                                }
                                bool q_is_gas = isDeviceGasParticle(q, soa, d_mat_tables, num_mat_tables);
                                bool q_is_solid = !q_is_gas;

                                bool eligible = false;
                                if (contact_mode == 0) { // GasSolidOnly
                                    eligible = (p_is_gas && q_is_solid) || (p_is_solid && q_is_gas);
                                } else if (contact_mode == 1) { // BallisticAndGas
                                    bool is_gas_solid = (p_is_gas && q_is_solid) || (p_is_solid && q_is_gas);
                                    bool is_solid_solid = p_is_solid && q_is_solid;
                                    eligible = is_gas_solid || is_solid_solid;
                                } else { // AllDynamic
                                    eligible = true;
                                }

                                if (eligible) {
                                    float r_q = (soa.contact_radius && soa.contact_radius[q] > 1.0e-6f) ? soa.contact_radius[q] : (0.5f * cbrtf(fmaxf(1.0e-18f, soa.V0[q])));
                                    float R_sum = contact_scale * (r_p + r_q);
                                    float R_sum_sq = R_sum * R_sum;

                                    float rx = px - soa.x[0][q];
                                    float ry = py - soa.x[1][q];
                                    float rz = pz - soa.x[2][q];
                                    float dist_sq = rx * rx + ry * ry + rz * rz;

                                    if (dist_sq < R_sum_sq && dist_sq > 1.0e-14f) {
                                        float dist = sqrtf(dist_sq);
                                        float inv_dist = 1.0f / dist;
                                        float nx = rx * inv_dist;
                                        float ny = ry * inv_dist;
                                        float nz = rz * inv_dist;

                                        float vx_rel = p_vx - soa.v[0][q];
                                        float vy_rel = p_vy - soa.v[1][q];
                                        float vz_rel = p_vz - soa.v[2][q];

                                        float v_n = vx_rel * nx + vy_rel * ny + vz_rel * nz;

                                        // Strict Approach Velocity Gate:
                                        // Static proximity at rest (v_n >= 0 or |v_n| <= v_thresh) generates zero force!
                                        if (v_n < -velocity_threshold) {
                                            float m_q = soa.m[q];
                                            float m_eff = (m_p * m_q) / (m_p + m_q);

                                            float target_vn = - restitution * v_n;
                                            float dv_n = target_vn - v_n;
                                            float max_dvn = (1.0f + restitution) * (-v_n);
                                            dv_n = fminf(fmaxf(dv_n, 0.0f), max_dvn);
                                            float J_n = m_eff * dv_n;

                                            if (J_n > 0.0f) {
                                                float v_tx = vx_rel - v_n * nx;
                                                float v_ty = vy_rel - v_n * ny;
                                                float v_tz = vz_rel - v_n * nz;
                                                float v_t_mag = sqrtf(v_tx * v_tx + v_ty * v_ty + v_tz * v_tz);

                                                float J_tx = 0.0f, J_ty = 0.0f, J_tz = 0.0f;
                                                if (v_t_mag > 1.0e-5f && friction_coef > 0.0f) {
                                                    float J_t_limit = fminf(friction_coef * J_n, m_eff * v_t_mag);
                                                    float inv_vt = J_t_limit / v_t_mag;
                                                    J_tx = v_tx * inv_vt;
                                                    J_ty = v_ty * inv_vt;
                                                    J_tz = v_tz * inv_vt;
                                                }

                                                float Jx = J_n * nx - J_tx;
                                                float Jy = J_n * ny - J_ty;
                                                float Jz = J_n * nz - J_tz;

                                                float inv_mp = 1.0f / m_p;
                                                float inv_mq = 1.0f / m_q;

                                                float dv_p_x = Jx * inv_mp;
                                                float dv_p_y = Jy * inv_mp;
                                                float dv_p_z = Jz * inv_mp;

                                                float dv_mag_p = sqrtf(dv_p_x * dv_p_x + dv_p_y * dv_p_y + dv_p_z * dv_p_z);
                                                float dv_limit = fminf(fabsf(v_n), 0.5f * (cell_dx / fmaxf(dt, 1.0e-12f)));
                                                if (dv_mag_p > dv_limit && dv_mag_p > 1.0e-7f) {
                                                    float scale = dv_limit / dv_mag_p;
                                                    dv_p_x *= scale;
                                                    dv_p_y *= scale;
                                                    dv_p_z *= scale;
                                                    Jx *= scale;
                                                    Jy *= scale;
                                                    Jz *= scale;
                                                }

                                                atomicAdd(&soa.v[0][p], dv_p_x);
                                                atomicAdd(&soa.v[1][p], dv_p_y);
                                                atomicAdd(&soa.v[2][p], dv_p_z);

                                                atomicAdd(&soa.v[0][q], -Jx * inv_mq);
                                                atomicAdd(&soa.v[1][q], -Jy * inv_mq);
                                                atomicAdd(&soa.v[2][q], -Jz * inv_mq);

                                                p_vx += dv_p_x;
                                                p_vy += dv_p_y;
                                                p_vz += dv_p_z;
                                                total_dv_p += sqrtf(dv_p_x * dv_p_x + dv_p_y * dv_p_y + dv_p_z * dv_p_z);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    q = particle_next[q];
                }
            }
        }
    }

    if (total_dv_p > 25.0f && soa.B[0][0]) {
        float relax = fmaxf(0.2f, 1.0f - (total_dv_p - 25.0f) * 0.005f);
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                soa.B[r][c][p] *= relax;
            }
        }
    }
}

void MPMSolver3DCUDA::evaluateDEMContactDevice(float dt) {
    if ((!m_enable_dem_contact && m_contact_method != MPMContactMethod::SubGridDEM) || m_num_active_particles == 0 || dt <= 1.0e-12f) return;

    if (!d_dem_cell_head) {
        CUDA_CHECK_ALLOC(cudaMalloc(&d_dem_cell_head, DEM_HASH_TABLE_SIZE * sizeof(int)), "Allocating d_dem_cell_head");
    }
    if (m_allocated_particles > m_allocated_dem_particles || !d_dem_particle_next) {
        if (d_dem_particle_next) cudaFree(d_dem_particle_next);
        CUDA_CHECK_ALLOC(cudaMalloc(&d_dem_particle_next, m_allocated_particles * sizeof(int)), "Allocating d_dem_particle_next");
        m_allocated_dem_particles = m_allocated_particles;
    }

    int block_size = 256;
    int grid_clear = (static_cast<int>(DEM_HASH_TABLE_SIZE) + block_size - 1) / block_size;
    kernel_dem_clear_hash_table_3d<<<grid_clear, block_size>>>(d_dem_cell_head, static_cast<uint32_t>(DEM_HASH_TABLE_SIZE));

    float max_cell_size = fmaxf(fmaxf(m_dx, m_dy), m_dz);
    if (max_cell_size < 1.0e-4f) max_cell_size = 0.02f;
    float h_bin = fmaxf(max_cell_size, 1.25f * m_dem_contact_scale * max_cell_size);
    float inv_h_bin = 1.0f / h_bin;

    int grid_p = (static_cast<int>(m_num_active_particles) + block_size - 1) / block_size;
    kernel_dem_insert_particles_3d<<<grid_p, block_size>>>(
        d_soa, static_cast<int>(m_num_active_particles),
        d_dem_cell_head, d_dem_particle_next, static_cast<uint32_t>(DEM_HASH_TABLE_SIZE),
        inv_h_bin, m_xmin, m_ymin, m_zmin);

    float contact_scale = fmaxf(0.1f, m_dem_contact_scale);
    float restitution = fminf(fmaxf(m_dem_restitution, 0.0f), 1.0f);
    float friction_coef = fmaxf(m_dem_friction, 0.0f);

    float cell_dx = fminf(fminf(m_dx, m_dy), m_dz);
    if (cell_dx < 1.0e-4f) cell_dx = 0.004f;

    kernel_dem_resolve_contact_3d<<<grid_p, block_size>>>(
        d_soa, static_cast<int>(m_num_active_particles),
        d_dem_cell_head, d_dem_particle_next, static_cast<uint32_t>(DEM_HASH_TABLE_SIZE),
        inv_h_bin, m_xmin, m_ymin, m_zmin,
        contact_scale, restitution, friction_coef,
        static_cast<int>(m_dem_contact_mode), m_dem_velocity_threshold,
        d_material_tables, static_cast<int>(m_material_tables.size()),
        cell_dx, dt);
}

__global__ void kernel_extract_slice_3d(const MPMGridNode3D* grid, float* slice_out, int nx, int ny, int nz, int axis_code, int offset_idx, int req_qty_code) {
    int t_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (axis_code == 0) { // xy slice (w=nx, h=ny, at k=offset_idx)
        if (t_idx >= nx * ny) return;
        int i = t_idx % nx;
        int j = t_idx / nx;
        int k = offset_idx;
        size_t idx = (static_cast<size_t>(i) * ny + j) * nz + k;
        float val = 0.0f;
        if (grid[idx].m > 1.0e-11f) {
            if (req_qty_code == 1) { // velocity
                float inv_m = 1.0f / grid[idx].m;
                float vx = grid[idx].p[0] * inv_m;
                float vy = grid[idx].p[1] * inv_m;
                float vz = grid[idx].p[2] * inv_m;
                val = sqrtf(vx*vx + vy*vy + vz*vz);
            } else if (req_qty_code == 2) { // pressure
                val = grid[idx].pressure;
            } else { // plastic_strain
                val = grid[idx].plastic_strain;
            }
        }
        slice_out[t_idx] = val;
    } else if (axis_code == 1) { // xz slice (w=nx, h=nz, at j=offset_idx)
        if (t_idx >= nx * nz) return;
        int i = t_idx % nx;
        int k = t_idx / nx;
        int j = offset_idx;
        size_t idx = (static_cast<size_t>(i) * ny + j) * nz + k;
        float val = 0.0f;
        if (grid[idx].m > 1.0e-11f) {
            if (req_qty_code == 1) {
                float inv_m = 1.0f / grid[idx].m;
                float vx = grid[idx].p[0] * inv_m;
                float vy = grid[idx].p[1] * inv_m;
                float vz = grid[idx].p[2] * inv_m;
                val = sqrtf(vx*vx + vy*vy + vz*vz);
            } else if (req_qty_code == 2) {
                val = grid[idx].pressure;
            } else {
                val = grid[idx].plastic_strain;
            }
        }
        slice_out[t_idx] = val;
    } else { // yz slice (w=ny, h=nz, at i=offset_idx)
        if (t_idx >= ny * nz) return;
        int j = t_idx % ny;
        int k = t_idx / ny;
        int i = offset_idx;
        size_t idx = (static_cast<size_t>(i) * ny + j) * nz + k;
        float val = 0.0f;
        if (grid[idx].m > 1.0e-11f) {
            if (req_qty_code == 1) {
                float inv_m = 1.0f / grid[idx].m;
                float vx = grid[idx].p[0] * inv_m;
                float vy = grid[idx].p[1] * inv_m;
                float vz = grid[idx].p[2] * inv_m;
                val = sqrtf(vx*vx + vy*vy + vz*vz);
            } else if (req_qty_code == 2) {
                val = grid[idx].pressure;
            } else {
                val = grid[idx].plastic_strain;
            }
        }
        slice_out[t_idx] = val;
    }
}

void MPMSolver3DCUDA::extractSliceToHost(std::vector<float>& out_slice, const std::string& axis, float offset, const std::string& req_qty) {
    if (!d_grid) return;
    int axis_code = (axis == "xy") ? 0 : ((axis == "xz") ? 1 : 2);
    int req_qty_code = (req_qty == "velocity") ? 1 : ((req_qty == "pressure") ? 2 : 0);
    size_t slice_elements = 0;
    int offset_idx = 0;

    if (axis_code == 0) {
        slice_elements = static_cast<size_t>(m_nx) * m_ny;
        offset_idx = std::clamp(static_cast<int>(offset / m_dz), 0, m_nz - 1);
    } else if (axis_code == 1) {
        slice_elements = static_cast<size_t>(m_nx) * m_nz;
        offset_idx = std::clamp(static_cast<int>(offset / m_dy), 0, m_ny - 1);
    } else {
        slice_elements = static_cast<size_t>(m_ny) * m_nz;
        offset_idx = std::clamp(static_cast<int>(offset / m_dx), 0, m_nx - 1);
    }

    if (slice_elements == 0) return;

    if (slice_elements * sizeof(float) > m_allocated_slice_buf) {
        if (d_telemetry_slice_buf) cudaFree(d_telemetry_slice_buf);
        CUDA_CHECK_ALLOC(cudaMalloc(&d_telemetry_slice_buf, slice_elements * sizeof(float)), "Allocating d_telemetry_slice_buf");
        m_allocated_slice_buf = slice_elements * sizeof(float);
    }

    int threads = 256;
    int blocks = (static_cast<int>(slice_elements) + threads - 1) / threads;
    kernel_extract_slice_3d<<<blocks, threads>>>(d_grid, d_telemetry_slice_buf, m_nx, m_ny, m_nz, axis_code, offset_idx, req_qty_code);

    out_slice.resize(slice_elements);
    cudaMemcpy(out_slice.data(), d_telemetry_slice_buf, slice_elements * sizeof(float), cudaMemcpyDeviceToHost);
}

void MPMSolver3DCUDA::initMaterialHeterogeneity(int obj_id) {
    if (!m_host_particles.empty() && d_soa_buffer && !m_device_dirty && m_step_count > 0) {
        syncParticlesToHost();
    }
    Blast::MPMSolver3D cpu_temp;
    cpu_temp.setTransferScheme(m_transfer_scheme);
    cpu_temp.getMaterialTables() = m_material_tables;
    cpu_temp.getParticles() = std::move(m_host_particles);
    cpu_temp.initMaterialHeterogeneity(obj_id);
    m_material_tables = cpu_temp.getMaterialTables();
    m_host_particles = std::move(cpu_temp.getParticles());
    m_device_dirty = true;
    if (d_soa_buffer != nullptr && m_step_count > 0) {
        syncToDevice();
    }
}

void MPMSolver3DCUDA::seedMottGradyFragments(int obj_id) {
    if (!m_host_particles.empty() && d_soa_buffer && !m_device_dirty && m_step_count > 0) {
        syncParticlesToHost();
    }
    Blast::MPMSolver3D cpu_temp;
    cpu_temp.getMaterialTables() = m_material_tables;
    cpu_temp.getParticles() = std::move(m_host_particles);
    cpu_temp.seedMottGradyFragments(obj_id);
    m_host_particles = std::move(cpu_temp.getParticles());
    m_device_dirty = true;
    if (d_soa_buffer != nullptr && m_step_count > 0) {
        syncToDevice();
    }
}

void MPMSolver3DCUDA::step(float cfl) {
    if (m_host_particles.empty()) return;
    float dt = computeStepSize(cfl);
    if (m_step_count == 0) {
        dt = 0.5f * dt;
    } else {
        dt = std::min(dt, 1.5f * (m_last_dt > 0.0f ? m_last_dt : dt));
    }
    m_last_cfl = cfl;
    stepWithDt(dt);
}

void MPMSolver3DCUDA::applyStratifiedInitialCondition(const Blast::Stratified3DParams& strat) {
    if (strat.gravity_z != 0.0) {
        setGravity(0.0f, 0.0f, static_cast<float>(strat.gravity_z));
    }
    float g_mag = std::abs(static_cast<float>(strat.gravity_z));
    if (g_mag < 1.0e-6f) g_mag = 9.81f;

    for (auto& mat : m_material_tables) {
        if (mat.material_model == MPMMaterialModel::TaitWater) {
            mat.tait_p0 = static_cast<float>(strat.p_atm);
        }
    }

    float p_atm = static_cast<float>(strat.p_atm);
    float z_surf = static_cast<float>(strat.water_surface_z);
    float z_bed = static_cast<float>(strat.seabed_surface_z);

    for (auto& p : m_host_particles) {
        float z_c = p.x[2];
        const MaterialTable3D* mat_ptr = nullptr;
        if (p.object_id >= 0 && static_cast<size_t>(p.object_id) < m_material_tables.size()) {
            mat_ptr = &m_material_tables[p.object_id];
        } else if (p.material_id >= 0 && static_cast<size_t>(p.material_id) < m_material_tables.size()) {
            mat_ptr = &m_material_tables[p.material_id];
        } else if (!m_material_tables.empty()) {
            mat_ptr = &m_material_tables[0];
        }

        float rho_water = (mat_ptr && mat_ptr->tait_rho0 > 0.0f) ? mat_ptr->tait_rho0 : static_cast<float>(strat.tait_rho0);
        float tait_B = (mat_ptr && mat_ptr->tait_B > 0.0f) ? mat_ptr->tait_B : static_cast<float>(strat.tait_B);
        float tait_gamma = (mat_ptr && mat_ptr->tait_gamma > 0.0f) ? mat_ptr->tait_gamma : static_cast<float>(strat.tait_gamma);

        bool is_water = (mat_ptr && mat_ptr->material_model == MPMMaterialModel::TaitWater);
        bool is_soil = (mat_ptr && mat_ptr->material_model == MPMMaterialModel::DruckerPragerSoil);
        bool is_energetic = (mat_ptr && (
            mat_ptr->material_model == MPMMaterialModel::CRESTReactiveBurn ||
            mat_ptr->material_model == MPMMaterialModel::JWLProgrammedBurn ||
            mat_ptr->material_model == MPMMaterialModel::LeeTarverIgnitionGrowth
        ));

        if (is_water) {
            if (z_c > z_surf) {
                p.sigma.setIsotropic(p_atm);
                p.rho = rho_water;
                p.J = 1.0f;
                p.V = p.V0;
            } else {
                float p_h = 0.0f, rho_h = 0.0f, e_h = 0.0f;
                Blast::TaitEOSWater::compute_hydrostatic_state(
                    z_c, z_surf, g_mag, p_atm,
                    p_h, rho_h, e_h, tait_B, tait_gamma, rho_water
                );
                p.rho = rho_h;
                p.J = rho_water / rho_h;
                p.V = p.V0 * p.J;
                p.sigma.setIsotropic(p_h);
                p.e_int = e_h;
            }
        } else if (is_soil) {
            double p_bed = static_cast<double>(p_atm + rho_water * g_mag * std::max(0.0f, z_surf - z_bed));
            double sig_v = 0.0, u_p = 0.0, sig_h = 0.0;
            Blast::TaitEOSWater::compute_geostatic_stress(
                static_cast<double>(z_c), static_cast<double>(z_bed), p_bed, strat.soil_density, static_cast<double>(rho_water),
                static_cast<double>(g_mag), strat.k0_earth_pressure,
                sig_v, u_p, sig_h
            );
            p.sigma[0][0] = -static_cast<float>(sig_h);
            p.sigma[1][1] = -static_cast<float>(sig_h);
            p.sigma[2][2] = -static_cast<float>(sig_v);
            p.sigma[0][1] = 0.0f;
            p.sigma[1][2] = 0.0f;
            p.sigma[2][0] = 0.0f;
            p.rho = static_cast<float>(strat.soil_density);
            p.J = 1.0f;
            p.V = p.V0;
        } else if (is_energetic) {
            // Energetic materials: protect detonation state and reference density.
            // If particle was already ignited at t=0, keep its detonation energy and stress intact.
            // If unreacted, it must carry the ambient hydrostatic pressure p_h through its own EOS:
            // solve p_solid(v_ref, e = 0) = p_h for the reference compression v_ref = V / V0 by
            // bisection on [0.5, 1] (p_solid is monotone in v), then set V = V0 * v_ref.
            // The reactive kernel evaluates the EOS from (V / V0, e_th) every step, so this state is
            // an exact equilibrium of the discrete update (no stress-history offset is needed).
            if (p.lambda <= 0.0f && p.e_int < 1.0e4f) {
                float p_h = p_atm;
                if (z_c <= z_surf) {
                    p_h += rho_water * g_mag * std::max(0.0f, z_surf - z_c);
                }
                const MaterialTable3D& m = *mat_ptr;
                const bool davis = (m.solid_model == SolidReactantEOS::DavisSolid);
                auto p_of_v = [&](float v) {
                    return davis
                        ? CrestDavis::computeDavisReactantPressure(v, 0.0f, m.davis_c0, m.davis_s1, m.davis_gamma0, m.davis_cv, m.davis_t0, m.davis_rho0)
                        : JWL::computeSolidReactantPressure(v, 0.0f, m.mg_c0, m.mg_s, m.mg_gamma0, m.density);
                };
                float v_lo = 0.5f, v_hi = 1.0f;
                for (int it = 0; it < 60; ++it) {
                    float v_mid = 0.5f * (v_lo + v_hi);
                    if (p_of_v(v_mid) > p_h) v_lo = v_mid; else v_hi = v_mid;
                }
                float v_ref = 0.5f * (v_lo + v_hi);
                p.V = p.V0 * v_ref;
                p.J = v_ref;
                p.e_int = 0.0f;
                p.sigma.setIsotropic(p_of_v(v_ref));
            }
        } else {
            // Structural solid: maintain material reference density, apply ambient confining pressure if submerged.
            if (z_c <= z_surf) {
                float p_h = p_atm + rho_water * g_mag * std::max(0.0f, z_surf - z_c);
                p.sigma.setIsotropic(p_h);
            }
        }
    }
    m_device_dirty = true;
    if (d_soa_buffer != nullptr) {
        syncToDevice();
    }
}

void MPMSolver3DCUDA::addDetonator(float x, float y, float z, float radius, float time_delay, bool track_velocity, int target_object_id) {
    MPMDetonator3D det;
    det.x = x;
    det.y = y;
    det.z = z;
    det.radius = radius;
    det.time_delay = time_delay;
    det.track_mpm_velocity = track_velocity;
    det.fired = false;
    det.target_object_id = target_object_id;
    m_detonators.push_back(det);
}

bool MPMSolver3DCUDA::interpolateGridVelocityDevice(float x, float y, float z, float& vx, float& vy, float& vz, int target_object_id) const {
    vx = 0.0f; vy = 0.0f; vz = 0.0f;
    if (!d_grid || !d_det_vel_buffer) return false;

    int eff_mat = -1;
    bool use_bardenhagen = (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen && d_mat_grid_buffer != nullptr);
    if (use_bardenhagen) {
        if (target_object_id >= 0 && target_object_id < static_cast<int>(m_object_to_mat.size())) {
            eff_mat = m_object_to_mat[target_object_id];
        } else if (target_object_id > 0 && (target_object_id - 1) < static_cast<int>(m_object_to_mat.size())) {
            eff_mat = m_object_to_mat[target_object_id - 1];
        }
        if (eff_mat < 0 || eff_mat >= m_num_materials) {
            eff_mat = -1;
        }
    }

    size_t num_nodes_total = static_cast<size_t>(m_nx) * m_ny * m_nz;
    const int* eff_mat_tag = (use_bardenhagen && m_mat_grid_compact_layout) ? d_mat_tag : nullptr;
    const float* eff_mat_m = use_bardenhagen ? d_mat_grid_m : nullptr;
    const float* eff_mat_v = use_bardenhagen ? d_mat_grid_v : nullptr;
    const float* eff_mat_dv = use_bardenhagen ? d_mat_grid_dv : nullptr;

    kernel_sample_grid_velocity_single<<<1, 1>>>(
        d_grid, m_nx, m_ny, m_nz, m_dx, m_dy, m_dz,
        m_xmin, m_ymin, m_zmin,
        static_cast<int>(m_bc_x_min), static_cast<int>(m_bc_x_max),
        static_cast<int>(m_bc_y_min), static_cast<int>(m_bc_y_max),
        static_cast<int>(m_bc_z_min), static_cast<int>(m_bc_z_max),
        x, y, z,
        static_cast<int>(m_transfer_scheme),
        eff_mat,
        eff_mat_tag,
        eff_mat_m,
        eff_mat_v,
        eff_mat_dv,
        m_num_materials,
        num_nodes_total,
        d_det_vel_buffer
    );

    float h_res[4] = {0.0f, 0.0f, 0.0f, 0.0f};
    cudaMemcpy(h_res, d_det_vel_buffer, 4 * sizeof(float), cudaMemcpyDeviceToHost);
    if (h_res[3] > 0.5f) {
        vx = h_res[0]; vy = h_res[1]; vz = h_res[2];
        return true;
    }
    return false;
}

void MPMSolver3DCUDA::updateDetonators(float dt) {
    if (m_detonators.empty()) return;

    for (auto& det : m_detonators) {
        if (det.track_mpm_velocity && !det.fired) {
            float vx = 0.0f, vy = 0.0f, vz = 0.0f;
            if (interpolateGridVelocityDevice(det.x, det.y, det.z, vx, vy, vz, det.target_object_id)) {
                det.x += vx * dt;
                det.y += vy * dt;
                det.z += vz * dt;
            }
        }

        if (!det.fired && static_cast<float>(m_sim_time) >= det.time_delay) {
            fireDetonator(det);
            det.fired = true;
        }
    }
}

void MPMSolver3DCUDA::fireDetonator(MPMDetonator3D& det) {
    size_t count = (m_num_active_particles > 0) ? m_num_active_particles : m_host_particles.size();
    if (count == 0 || !d_soa_buffer) return;

    int threads = 256;
    int blocks = (static_cast<int>(count) + threads - 1) / threads;
    kernel_fire_detonator_3d<<<blocks, threads>>>(
        d_soa, static_cast<int>(count),
        det.x, det.y, det.z, det.radius,
        static_cast<float>(m_sim_time),
        d_material_tables, static_cast<int>(m_material_tables.size()),
        det.target_object_id,
        m_dx
    );
    cudaDeviceSynchronize();
}

} // namespace Blast
