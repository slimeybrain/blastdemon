#include "mpm_solver_3d_cuda.hpp"
#include "constitutive_concrete_models.hpp"
#include <cuda_runtime.h>
#include <device_launch_parameters.h>
#include <algorithm>
#include <cmath>
#include <iostream>

namespace Blast {

__device__ inline float computeWeibullFactor_dev(float x, float y, float z, float weibull_modulus, float weibull_scale) {
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
    float u = fminf(fmaxf(static_cast<float>(seed & 0xFFFFu) / 65535.0f, 0.005f), 0.995f);
    float m_w = weibull_modulus;
    float eta_w = (weibull_scale > 0.001f) ? weibull_scale : 1.0f;
    float w = powf(-logf(1.0f - u), 1.0f / m_w) * eta_w;
    return fminf(fmaxf(w, 0.20f), 2.50f);
}

// CUDA Device Helper Functions
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

// Sparse Tile Table Marking Kernel
__global__ void kernel_mark_active_tiles(MPMParticle3DSoA soa, int num_particles,
                                        int* d_tile_table, int* d_num_active_tiles,
                                        int ntx, int nty, int ntz,
                                        float dx, float dy, float dz,
                                        float xmin, float ymin, float zmin) {
    int p_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (p_idx >= num_particles) return;

    float px = soa.x[0][p_idx] - xmin;
    float py = soa.x[1][p_idx] - ymin;
    float pz = soa.x[2][p_idx] - zmin;

    int base_i = static_cast<int>(floorf(px / dx));
    int base_j = static_cast<int>(floorf(py / dy));
    int base_k = static_cast<int>(floorf(pz / dz));

    for (int offset_i = -1; offset_i <= 2; ++offset_i) {
        int i = base_i + offset_i;
        if (i < 0) continue;
        int tx = i >> 3;
        if (tx >= ntx) continue;

        for (int offset_j = -1; offset_j <= 2; ++offset_j) {
            int j = base_j + offset_j;
            if (j < 0) continue;
            int ty = j >> 3;
            if (ty >= nty) continue;

            for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                int k = base_k + offset_k;
                if (k < 0) continue;
                int tz = k >> 3;
                if (tz >= ntz) continue;

                int tile_idx = (tx * nty + ty) * ntz + tz;
                if (atomicCAS(&d_tile_table[tile_idx], -1, -2) == -1) {
                    int slot = atomicAdd(d_num_active_tiles, 1);
                    d_tile_table[tile_idx] = slot;
                }
            }
        }
    }
}

__device__ __forceinline__ MPMGridNode3D* get_sparse_node(
    MPMGridNode3D* grid_pool, const int* tile_table,
    int ntx, int nty, int ntz,
    int gx, int gy, int gz) {
    if (gx < 0 || gy < 0 || gz < 0) return nullptr;
    int tx = gx >> 3;
    int ty = gy >> 3;
    int tz = gz >> 3;
    if (tx >= ntx || ty >= nty || tz >= ntz) return nullptr;
    int tile_idx = (tx * nty + ty) * ntz + tz;
    int slot = tile_table[tile_idx];
    if (slot < 0) return nullptr;
    int lx = gx & 7;
    int ly = gy & 7;
    int lz = gz & 7;
    int cell_idx = (lx * 8 + ly) * 8 + lz;
    return &grid_pool[slot * 512 + cell_idx];
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
}

// SoA Pack/Unpack Kernels
__global__ void kernel_pack_aos_to_soa(const MPMParticle3D* aos, MPMParticle3DSoA soa, int num_particles) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_particles) return;
    const MPMParticle3D& p = aos[idx];

    soa.x[0][idx] = p.x[0]; soa.x[1][idx] = p.x[1]; soa.x[2][idx] = p.x[2];
    soa.v[0][idx] = p.v[0]; soa.v[1][idx] = p.v[1]; soa.v[2][idx] = p.v[2];

    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            soa.sigma[r][c][idx] = p.sigma[r][c];
            soa.B[r][c][idx] = p.B[r][c];
            soa.L_grad[r][c][idx] = p.L_grad[r][c];
        }
    }

    soa.lp[0][idx] = p.lp[0]; soa.lp[1][idx] = p.lp[1]; soa.lp[2][idx] = p.lp[2];
    soa.m[idx] = p.m;
    soa.V0[idx] = p.V0;
    soa.V[idx] = p.V;
    soa.e_int[idx] = p.e_int;
    soa.temperature[idx] = p.temperature;
    soa.ep_bar[idx] = p.ep_bar;
    soa.damage[idx] = p.damage;
    if (soa.lambda) soa.lambda[idx] = p.lambda;
    if (soa.v_min) soa.v_min[idx] = p.v_min;
    if (soa.s_shock) soa.s_shock[idx] = p.s_shock;
    if (soa.weibull_factor) soa.weibull_factor[idx] = p.weibull_factor;
    if (soa.contact_radius) soa.contact_radius[idx] = p.contact_radius;
    soa.has_failed[idx] = p.has_failed ? 1 : 0;
    soa.object_id[idx] = p.object_id;
    if (soa.state) soa.state[idx] = static_cast<int>(p.state);
    if (soa.cluster_id) soa.cluster_id[idx] = p.cluster_id;
}

__global__ void kernel_unpack_soa_to_aos(MPMParticle3D* aos, MPMParticle3DSoA soa, int num_particles) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_particles) return;
    MPMParticle3D& p = aos[idx];

    p.x[0] = soa.x[0][idx]; p.x[1] = soa.x[1][idx]; p.x[2] = soa.x[2][idx];
    p.v[0] = soa.v[0][idx]; p.v[1] = soa.v[1][idx]; p.v[2] = soa.v[2][idx];

    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            p.sigma[r][c] = soa.sigma[r][c][idx];
            p.B[r][c] = soa.B[r][c][idx];
            p.L_grad[r][c] = soa.L_grad[r][c][idx];
        }
    }

    p.lp[0] = soa.lp[0][idx]; p.lp[1] = soa.lp[1][idx]; p.lp[2] = soa.lp[2][idx];
    p.m = soa.m[idx];
    p.V0 = soa.V0[idx];
    p.V = soa.V[idx];
    p.e_int = soa.e_int[idx];
    p.temperature = soa.temperature[idx];
    p.ep_bar = soa.ep_bar[idx];
    p.damage = soa.damage[idx];
    if (soa.lambda) p.lambda = soa.lambda[idx];
    if (soa.v_min) p.v_min = soa.v_min[idx];
    if (soa.s_shock) p.s_shock = soa.s_shock[idx];
    if (soa.weibull_factor) p.weibull_factor = soa.weibull_factor[idx];
    if (soa.contact_radius) p.contact_radius = soa.contact_radius[idx];
    p.has_failed = (soa.has_failed[idx] != 0);
    p.object_id = soa.object_id[idx];
    if (soa.state) p.state = static_cast<uint8_t>(soa.state[idx]);
    if (soa.cluster_id) p.cluster_id = soa.cluster_id[idx];
}

__global__ void kernel_extract_mpm_vtk_snapshot_3d(
    MPMParticle3DSoA soa, int num_particles,
    float* d_points, float* d_vel,
    float* d_von_mises, float* d_pressure,
    float* d_ep_bar, float* d_damage,
    float* d_temp, float* d_obj_id,
    bool has_vel, bool has_stress, bool has_strain, bool has_damage, bool has_temp)
{
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_particles) return;

    if (d_points) {
        d_points[idx * 3 + 0] = soa.x[0][idx];
        d_points[idx * 3 + 1] = soa.x[1][idx];
        d_points[idx * 3 + 2] = soa.x[2][idx];
    }
    if (has_vel && d_vel) {
        d_vel[idx * 3 + 0] = soa.v[0][idx];
        d_vel[idx * 3 + 1] = soa.v[1][idx];
        d_vel[idx * 3 + 2] = soa.v[2][idx];
    }
    if (has_stress) {
        float s00 = soa.sigma[0][0][idx];
        float s11 = soa.sigma[1][1][idx];
        float s22 = soa.sigma[2][2][idx];
        float s01 = soa.sigma[0][1][idx];
        float s12 = soa.sigma[1][2][idx];
        float s20 = soa.sigma[2][0][idx];
        float mean_s = (s00 + s11 + s22) * (1.0f / 3.0f);
        float dev00 = s00 - mean_s;
        float dev11 = s11 - mean_s;
        float dev22 = s22 - mean_s;
        if (d_von_mises) d_von_mises[idx] = sqrtf(1.5f * (dev00*dev00 + dev11*dev11 + dev22*dev22 + 2.0f*(s01*s01 + s12*s12 + s20*s20)));
        if (d_pressure) d_pressure[idx] = -mean_s;
    }
    if (has_strain && d_ep_bar) d_ep_bar[idx] = soa.ep_bar[idx];
    if (has_damage && d_damage) d_damage[idx] = soa.damage[idx];
    if (has_temp && d_temp) d_temp[idx] = soa.temperature[idx];
    if (d_obj_id) d_obj_id[idx] = static_cast<float>(soa.object_id[idx]);
}

// 1. P2G Scatter Kernel (Coalesced SoA)
__global__ void kernel_p2g_3d(MPMParticle3DSoA soa, int num_particles,
                              MPMGridNode3D* grid, int nx, int ny, int nz,
                              float dx, float dy, float dz, int transfer_scheme,
                              float xmin, float ymin, float zmin,
                              int* d_active_nodes, int* d_num_active_nodes,
                              const MaterialTable3D* d_mat_tables) {
    int p_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (p_idx >= num_particles) return;
    if (soa.has_failed[p_idx] != 0 || (soa.damage && soa.damage[p_idx] >= 1.0f) || (soa.state && soa.state[p_idx] != 0)) return;

    int obj_id = soa.object_id[p_idx];
    const MaterialTable3D& mat = d_mat_tables[obj_id];
    int eff_transfer_scheme = (mat.transfer_scheme >= 0) ? mat.transfer_scheme : transfer_scheme;

    float px = soa.x[0][p_idx] - xmin;
    float py = soa.x[1][p_idx] - ymin;
    float pz = soa.x[2][p_idx] - zmin;

    float p_m = soa.m[p_idx];
    float p_V = soa.V[p_idx];
    float p_ep_bar = soa.ep_bar[p_idx];
    float p_damage = soa.damage[p_idx];
    float lp_x = soa.lp[0][p_idx], lp_y = soa.lp[1][p_idx], lp_z = soa.lp[2][p_idx];
    float v_x = soa.v[0][p_idx], v_y = soa.v[1][p_idx], v_z = soa.v[2][p_idx];

    float s_xx = soa.sigma[0][0][p_idx]; float s_yy = soa.sigma[1][1][p_idx]; float s_zz = soa.sigma[2][2][p_idx];
    float s_xy = soa.sigma[0][1][p_idx]; float s_yz = soa.sigma[1][2][p_idx]; float s_zx = soa.sigma[2][0][p_idx];

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

        // Pass 1: Local partition of unity sum and stencil centroid (xc, yc, zc)
        float local_w_sum = 0.0f;
        float cx = 0.0f, cy = 0.0f, cz = 0.0f;

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
                    cx += w * node_x;
                    cy += w * node_y;
                    cz += w * node_z;
                }
            }
        }

        if (local_w_sum > 1.0e-7f) {
            float inv_w_sum = 1.0f / local_w_sum;
            float xc = cx * inv_w_sum;
            float yc = cy * inv_w_sum;
            float zc = cz * inv_w_sum;

            float D[3][3] = {{0.0f, 0.0f, 0.0f}, {0.0f, 0.0f, 0.0f}, {0.0f, 0.0f, 0.0f}};
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

                        float dc_x = node_x - xc;
                        float dc_y = node_y - yc;
                        float dc_z = node_z - zc;

                        D[0][0] += w * dc_x * dc_x;
                        D[0][1] += w * dc_x * dc_y;
                        D[0][2] += w * dc_x * dc_z;
                        D[1][1] += w * dc_y * dc_y;
                        D[1][2] += w * dc_y * dc_z;
                        D[2][2] += w * dc_z * dc_z;
                    }
                }
            }

            D[0][0] *= inv_w_sum; D[0][1] *= inv_w_sum; D[0][2] *= inv_w_sum;
            D[1][0] = D[0][1];    D[1][1] *= inv_w_sum; D[1][2] *= inv_w_sum;
            D[2][0] = D[0][2];    D[2][1] = D[1][2];    D[2][2] *= inv_w_sum;

            float D_inv[3][3];
            float det = D[0][0] * (D[1][1] * D[2][2] - D[1][2] * D[1][2]) -
                        D[0][1] * (D[0][1] * D[2][2] - D[1][2] * D[0][2]) +
                        D[0][2] * (D[0][1] * D[1][2] - D[1][1] * D[0][2]);

            if (det > 1.0e-18f) {
                float inv_det = 1.0f / det;
                D_inv[0][0] =  (D[1][1] * D[2][2] - D[1][2] * D[1][2]) * inv_det;
                D_inv[0][1] = -(D[0][1] * D[2][2] - D[1][2] * D[0][2]) * inv_det;
                D_inv[0][2] =  (D[0][1] * D[1][2] - D[1][1] * D[0][2]) * inv_det;
                D_inv[1][0] = D_inv[0][1];
                D_inv[1][1] =  (D[0][0] * D[2][2] - D[0][2] * D[0][2]) * inv_det;
                D_inv[1][2] = -(D[0][0] * D[1][2] - D[0][1] * D[0][2]) * inv_det;
                D_inv[2][0] = D_inv[0][2];
                D_inv[2][1] = D_inv[1][2];
                D_inv[2][2] =  (D[0][0] * D[1][1] - D[0][1] * D[0][1]) * inv_det;
            } else {
                float d_iso = 3.75f / (dx * dx);
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
                        if (w < 1.0e-7f) continue;

                        float weight = w * inv_w_sum;

                        size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                        MPMGridNode3D* node = &grid[node_idx];

                        float old_m = atomicAdd(&node->m, p_m * weight);
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

                        atomicAdd(&node->f_int[0], -p_V * weight * (s_Dinv[0][0] * dc_x + s_Dinv[0][1] * dc_y + s_Dinv[0][2] * dc_z));
                        atomicAdd(&node->f_int[1], -p_V * weight * (s_Dinv[1][0] * dc_x + s_Dinv[1][1] * dc_y + s_Dinv[1][2] * dc_z));
                        atomicAdd(&node->f_int[2], -p_V * weight * (s_Dinv[2][0] * dc_x + s_Dinv[2][1] * dc_y + s_Dinv[2][2] * dc_z));

                        atomicAdd(&node->plastic_strain, p_m * weight * p_ep_bar);
                    }
                }
            }
        }
    } else if (eff_transfer_scheme == 4) {
        // Cubic B-Spline (5-node stencil [-2, 2] per axis / 125 nodes in 3D, C2 continuous)
        float Sx_arr[5], dSx_arr[5], Sy_arr[5], dSy_arr[5], Sz_arr[5], dSz_arr[5];
        for (int offset = -2; offset <= 2; ++offset) {
            int idx = offset + 2;
            float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * dx;
            Sx_arr[idx] = evalCubicBSpline_S_dev(px, nx_val, dx);
            dSx_arr[idx] = evalCubicBSpline_dS_dev(px, nx_val, dx);

            float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * dy;
            Sy_arr[idx] = evalCubicBSpline_S_dev(py, ny_val, dy);
            dSy_arr[idx] = evalCubicBSpline_dS_dev(py, ny_val, dy);

            float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * dz;
            Sz_arr[idx] = evalCubicBSpline_S_dev(pz, nz_val, dz);
            dSz_arr[idx] = evalCubicBSpline_dS_dev(pz, nz_val, dz);
        }

        for (int offset_i = -2; offset_i <= 2; ++offset_i) {
            int i = base_i + offset_i;
            if (i < 0 || i >= nx) continue;
            int i_idx = offset_i + 2;
            float Sx = Sx_arr[i_idx];
            if (fabsf(Sx) < 1.0e-7f) continue;
            float dSx = dSx_arr[i_idx];
            float node_x = (static_cast<float>(i) + 0.5f) * dx;

            for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                int j = base_j + offset_j;
                if (j < 0 || j >= ny) continue;
                int j_idx = offset_j + 2;
                float Sy = Sy_arr[j_idx];
                if (fabsf(Sy) < 1.0e-7f) continue;
                float dSy = dSy_arr[j_idx];
                float node_y = (static_cast<float>(j) + 0.5f) * dy;

                for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                    int k = base_k + offset_k;
                    if (k < 0 || k >= nz) continue;
                    int k_idx = offset_k + 2;
                    float Sz = Sz_arr[k_idx];
                    if (fabsf(Sz) < 1.0e-7f) continue;
                    float dSz = dSz_arr[k_idx];
                    float node_z = (static_cast<float>(k) + 0.5f) * dz;

                    float weight = Sx * Sy * Sz;
                    float dN_dx = dSx * Sy * Sz;
                    float dN_dy = Sx * dSy * Sz;
                    float dN_dz = Sx * Sy * dSz;

                    size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                    MPMGridNode3D* node = &grid[node_idx];

                    float old_m = atomicAdd(&node->m, p_m * weight);
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

                    atomicAdd(&node->p[0], p_m * weight * v_apic_x);
                    atomicAdd(&node->p[1], p_m * weight * v_apic_y);
                    atomicAdd(&node->p[2], p_m * weight * v_apic_z);

                    atomicAdd(&node->f_int[0], -p_V * (s_xx * dN_dx + s_xy * dN_dy + s_zx * dN_dz));
                    atomicAdd(&node->f_int[1], -p_V * (s_xy * dN_dx + s_yy * dN_dy + s_yz * dN_dz));
                    atomicAdd(&node->f_int[2], -p_V * (s_zx * dN_dx + s_yz * dN_dy + s_zz * dN_dz));

                    atomicAdd(&node->plastic_strain, p_m * weight * p_ep_bar);
                }
            }
        }
    } else {
        float Sx_arr[4], dSx_arr[4], Sy_arr[4], dSy_arr[4], Sz_arr[4], dSz_arr[4];
        for (int offset = -1; offset <= 2; ++offset) {
            int idx = offset + 1;
            float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * dx;
            Sx_arr[idx] = (eff_transfer_scheme == 1) ? evalGIMP_S_dev(px, nx_val, dx, lp_x) :
                          ((eff_transfer_scheme == 2) ? evalBSpline_S_dev(px, nx_val, dx) :
                          fmaxf(0.0f, 1.0f - fabsf(px - nx_val) / dx));
            dSx_arr[idx] = (eff_transfer_scheme == 1) ? evalGIMP_dS_dev(px, nx_val, dx, lp_x) :
                           ((eff_transfer_scheme == 2) ? evalBSpline_dS_dev(px, nx_val, dx) :
                           (px >= nx_val ? -1.0f / dx : 1.0f / dx));

            float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * dy;
            Sy_arr[idx] = (eff_transfer_scheme == 1) ? evalGIMP_S_dev(py, ny_val, dy, lp_y) :
                          ((eff_transfer_scheme == 2) ? evalBSpline_S_dev(py, ny_val, dy) :
                          fmaxf(0.0f, 1.0f - fabsf(py - ny_val) / dy));
            dSy_arr[idx] = (eff_transfer_scheme == 1) ? evalGIMP_dS_dev(py, ny_val, dy, lp_y) :
                           ((eff_transfer_scheme == 2) ? evalBSpline_dS_dev(py, ny_val, dy) :
                           (py >= ny_val ? -1.0f / dy : 1.0f / dy));

            float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * dz;
            Sz_arr[idx] = (eff_transfer_scheme == 1) ? evalGIMP_S_dev(pz, nz_val, dz, lp_z) :
                          ((eff_transfer_scheme == 2) ? evalBSpline_S_dev(pz, nz_val, dz) :
                          fmaxf(0.0f, 1.0f - fabsf(pz - nz_val) / dz));
            dSz_arr[idx] = (eff_transfer_scheme == 1) ? evalGIMP_dS_dev(pz, nz_val, dz, lp_z) :
                           ((eff_transfer_scheme == 2) ? evalBSpline_dS_dev(pz, nz_val, dz) :
                           (pz >= nz_val ? -1.0f / dz : 1.0f / dz));
        }

        for (int offset_i = -1; offset_i <= 2; ++offset_i) {
            int i = base_i + offset_i;
            if (i < 0 || i >= nx) continue;
            int i_idx = offset_i + 1;
            float Sx = Sx_arr[i_idx];
            if (fabsf(Sx) < 1.0e-7f) continue;
            float dSx = dSx_arr[i_idx];
            float node_x = (static_cast<float>(i) + 0.5f) * dx;

            for (int offset_j = -1; offset_j <= 2; ++offset_j) {
                int j = base_j + offset_j;
                if (j < 0 || j >= ny) continue;
                int j_idx = offset_j + 1;
                float Sy = Sy_arr[j_idx];
                if (fabsf(Sy) < 1.0e-7f) continue;
                float dSy = dSy_arr[j_idx];
                float node_y = (static_cast<float>(j) + 0.5f) * dy;

                for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                    int k = base_k + offset_k;
                    if (k < 0 || k >= nz) continue;
                    int k_idx = offset_k + 1;
                    float Sz = Sz_arr[k_idx];
                    if (fabsf(Sz) < 1.0e-7f) continue;
                    float dSz = dSz_arr[k_idx];
                    float node_z = (static_cast<float>(k) + 0.5f) * dz;

                    float weight = Sx * Sy * Sz;
                    float dN_dx = dSx * Sy * Sz;
                    float dN_dy = Sx * dSy * Sz;
                    float dN_dz = Sx * Sy * dSz;

                    size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                    MPMGridNode3D* node = &grid[node_idx];

                    float old_m = atomicAdd(&node->m, p_m * weight);
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

                    atomicAdd(&node->p[0], p_m * weight * v_apic_x);
                    atomicAdd(&node->p[1], p_m * weight * v_apic_y);
                    atomicAdd(&node->p[2], p_m * weight * v_apic_z);

                    atomicAdd(&node->f_int[0], -p_V * (s_xx * dN_dx + s_xy * dN_dy + s_zx * dN_dz));
                    atomicAdd(&node->f_int[1], -p_V * (s_xy * dN_dx + s_yy * dN_dy + s_yz * dN_dz));
                    atomicAdd(&node->f_int[2], -p_V * (s_zx * dN_dx + s_yz * dN_dy + s_zz * dN_dz));

                    atomicAdd(&node->plastic_strain, p_m * weight * p_ep_bar);
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
                                     const int* active_nodes, int num_active) {
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
    if (node.m <= 1.0e-11f) return;

    node.plastic_strain /= node.m;

    node.p[0] += dt * (node.f_ext[0] + node.f_int[0]);
    node.p[1] += dt * (node.f_ext[1] + node.f_int[1]);
    node.p[2] += dt * (node.f_ext[2] + node.f_int[2]);

    // Unpack 3D indices
    int k = idx % nz;
    int j = (idx / nz) % ny;
    int i = idx / (ny * nz);

    if ((i <= 3 && bc_x_min == 0) || (i >= nx - 4 && bc_x_max == 0)) { node.p[0] = 0.0f; node.p[1] = 0.0f; node.p[2] = 0.0f; }
    else if ((i <= 3 && (bc_x_min == 1 || bc_x_min == 2)) || (i >= nx - 4 && (bc_x_max == 1 || bc_x_max == 2))) { node.p[0] = 0.0f; }

    if ((j <= 3 && bc_y_min == 0) || (j >= ny - 4 && bc_y_max == 0)) { node.p[0] = 0.0f; node.p[1] = 0.0f; node.p[2] = 0.0f; }
    else if ((j <= 3 && (bc_y_min == 1 || bc_y_min == 2)) || (j >= ny - 4 && (bc_y_max == 1 || bc_y_max == 2))) { node.p[1] = 0.0f; }

    if ((k <= 3 && bc_z_min == 0) || (k >= nz - 4 && bc_z_max == 0)) { node.p[0] = 0.0f; node.p[1] = 0.0f; node.p[2] = 0.0f; }
    else if ((k <= 3 && (bc_z_min == 1 || bc_z_min == 2)) || (k >= nz - 4 && (bc_z_max == 1 || bc_z_max == 2))) { node.p[2] = 0.0f; }
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
    if (grid_in[idx].m <= 1.0e-11f) return;

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
                    if (grid_in[n_idx].m > 1.0e-11f) {
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
    if (grid_in[idx].m > 1.0e-11f) {
        grid_in[idx].plastic_strain = plastic_strain_out[idx];
    }
}

__global__ void kernel_g2p_3d(MPMParticle3DSoA soa, int num_particles,
                              const MPMGridNode3D* grid, int nx, int ny, int nz,
                              float dx, float dy, float dz, float dt, int transfer_scheme,
                              int velocity_scheme, float flip_blend,
                              float xmin, float ymin, float zmin,
                              int bc_x_min, int bc_x_max,
                              int bc_y_min, int bc_y_max,
                              int bc_z_min, int bc_z_max,
                              const MaterialTable3D* d_mat_tables) {
    int p_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (p_idx >= num_particles) return;

    int obj_id = soa.object_id[p_idx];
    const MaterialTable3D& mat = d_mat_tables[obj_id];
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
    float delta_v_grid_x = 0.0f; float delta_v_grid_y = 0.0f; float delta_v_grid_z = 0.0f;
    float weight_sum = 0.0f;

    // APIC B_p & L_grad computation setup
    float max_B = 5000.0f / fminf(fminf(dx, dy), dz);
    float B_new[3][3] = {{0,0,0},{0,0,0},{0,0,0}};
    float L_new[3][3] = {{0,0,0},{0,0,0},{0,0,0}};

    if (eff_transfer_scheme == 3) {
        // Radial Moving Least Squares MPM (Wendland C2 radial kernel with Centroid-Centered Linear Completeness)
        float R_supp = 2.0f * fmaxf(fmaxf(dx, dy), dz);

        // Pass 1: Local partition of unity sum and stencil centroid (xc, yc, zc)
        float local_w_sum = 0.0f;
        float cx = 0.0f, cy = 0.0f, cz = 0.0f;

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
                    cx += w * node_x;
                    cy += w * node_y;
                    cz += w * node_z;
                }
            }
        }

        if (local_w_sum > 1.0e-7f) {
            float inv_w_sum = 1.0f / local_w_sum;
            float xc = cx * inv_w_sum;
            float yc = cy * inv_w_sum;
            float zc = cz * inv_w_sum;

            float D[3][3] = {{0.0f, 0.0f, 0.0f}, {0.0f, 0.0f, 0.0f}, {0.0f, 0.0f, 0.0f}};
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

                        float dc_x = node_x - xc;
                        float dc_y = node_y - yc;
                        float dc_z = node_z - zc;

                        D[0][0] += w * dc_x * dc_x;
                        D[0][1] += w * dc_x * dc_y;
                        D[0][2] += w * dc_x * dc_z;
                        D[1][1] += w * dc_y * dc_y;
                        D[1][2] += w * dc_y * dc_z;
                        D[2][2] += w * dc_z * dc_z;
                    }
                }
            }

            D[0][0] *= inv_w_sum; D[0][1] *= inv_w_sum; D[0][2] *= inv_w_sum;
            D[1][0] = D[0][1];    D[1][1] *= inv_w_sum; D[1][2] *= inv_w_sum;
            D[2][0] = D[0][2];    D[2][1] = D[1][2];    D[2][2] *= inv_w_sum;

            float D_inv[3][3];
            float det = D[0][0] * (D[1][1] * D[2][2] - D[1][2] * D[1][2]) -
                        D[0][1] * (D[0][1] * D[2][2] - D[1][2] * D[0][2]) +
                        D[0][2] * (D[0][1] * D[1][2] - D[1][1] * D[0][2]);

            if (det > 1.0e-18f) {
                float inv_det = 1.0f / det;
                D_inv[0][0] =  (D[1][1] * D[2][2] - D[1][2] * D[1][2]) * inv_det;
                D_inv[0][1] = -(D[0][1] * D[2][2] - D[1][2] * D[0][2]) * inv_det;
                D_inv[0][2] =  (D[0][1] * D[1][2] - D[1][1] * D[0][2]) * inv_det;
                D_inv[1][0] = D_inv[0][1];
                D_inv[1][1] =  (D[0][0] * D[2][2] - D[0][2] * D[0][2]) * inv_det;
                D_inv[1][2] = -(D[0][0] * D[1][2] - D[0][1] * D[0][2]) * inv_det;
                D_inv[2][0] = D_inv[0][2];
                D_inv[2][1] = D_inv[1][2];
                D_inv[2][2] =  (D[0][0] * D[1][1] - D[0][1] * D[0][1]) * inv_det;
            } else {
                float d_iso = 3.75f / (dx * dx);
                D_inv[0][0] = d_iso; D_inv[0][1] = 0.0f;  D_inv[0][2] = 0.0f;
                D_inv[1][0] = 0.0f;  D_inv[1][1] = d_iso; D_inv[1][2] = 0.0f;
                D_inv[2][0] = 0.0f;  D_inv[2][1] = 0.0f;  D_inv[2][2] = d_iso;
            }

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

                        float weight = w * inv_w_sum;

                        size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                        const MPMGridNode3D& node = grid[node_idx];

                        if (node.m > 1.0e-11f) {
                            float inv_m = 1.0f / node.m;
                            float n_vx = node.p[0] * inv_m;
                            float n_vy = node.p[1] * inv_m;
                            float n_vz = node.p[2] * inv_m;

                            v_pic_x += weight * n_vx;
                            v_pic_y += weight * n_vy;
                            v_pic_z += weight * n_vz;

                            float delta_vx = dt * (node.f_ext[0] + node.f_int[0]) * inv_m;
                            float delta_vy = dt * (node.f_ext[1] + node.f_int[1]) * inv_m;
                            float delta_vz = dt * (node.f_ext[2] + node.f_int[2]) * inv_m;

                            delta_v_grid_x += weight * delta_vx;
                            delta_v_grid_y += weight * delta_vy;
                            delta_v_grid_z += weight * delta_vz;

                            weight_sum += weight;

                            float dc_x = node_x - xc;
                            float dc_y = node_y - yc;
                            float dc_z = node_z - zc;

                            float d_dinv_x = D_inv[0][0] * dc_x + D_inv[0][1] * dc_y + D_inv[0][2] * dc_z;
                            float d_dinv_y = D_inv[1][0] * dc_x + D_inv[1][1] * dc_y + D_inv[1][2] * dc_z;
                            float d_dinv_z = D_inv[2][0] * dc_x + D_inv[2][1] * dc_y + D_inv[2][2] * dc_z;

                            B_new[0][0] += weight * n_vx * d_dinv_x;
                            B_new[0][1] += weight * n_vx * d_dinv_y;
                            B_new[0][2] += weight * n_vx * d_dinv_z;

                            B_new[1][0] += weight * n_vy * d_dinv_x;
                            B_new[1][1] += weight * n_vy * d_dinv_y;
                            B_new[1][2] += weight * n_vy * d_dinv_z;

                            B_new[2][0] += weight * n_vz * d_dinv_x;
                            B_new[2][1] += weight * n_vz * d_dinv_y;
                            B_new[2][2] += weight * n_vz * d_dinv_z;

                            L_new[0][0] += n_vx * weight * d_dinv_x;
                            L_new[0][1] += n_vx * weight * d_dinv_y;
                            L_new[0][2] += n_vx * weight * d_dinv_z;

                            L_new[1][0] += n_vy * weight * d_dinv_x;
                            L_new[1][1] += n_vy * weight * d_dinv_y;
                            L_new[1][2] += n_vy * weight * d_dinv_z;

                            L_new[2][0] += n_vz * weight * d_dinv_x;
                            L_new[2][1] += n_vz * weight * d_dinv_y;
                            L_new[2][2] += n_vz * weight * d_dinv_z;
                        }
                    }
                }
            }
        }
    } else if (eff_transfer_scheme == 4) {
        // Cubic B-Spline (5-node stencil [-2, 2] per axis / 125 nodes in 3D, C2 continuous, d_scale = 3.0)
        float d_scale = 3.0f;
        float D_inv_x = d_scale / (dx * dx);
        float D_inv_y = d_scale / (dy * dy);
        float D_inv_z = d_scale / (dz * dz);

        float Sx_arr[5], dSx_arr[5], Sy_arr[5], dSy_arr[5], Sz_arr[5], dSz_arr[5];
        for (int offset = -2; offset <= 2; ++offset) {
            int idx = offset + 2;
            float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * dx;
            Sx_arr[idx] = evalCubicBSpline_S_dev(px, nx_val, dx);
            dSx_arr[idx] = evalCubicBSpline_dS_dev(px, nx_val, dx);

            float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * dy;
            Sy_arr[idx] = evalCubicBSpline_S_dev(py, ny_val, dy);
            dSy_arr[idx] = evalCubicBSpline_dS_dev(py, ny_val, dy);

            float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * dz;
            Sz_arr[idx] = evalCubicBSpline_S_dev(pz, nz_val, dz);
            dSz_arr[idx] = evalCubicBSpline_dS_dev(pz, nz_val, dz);
        }

        for (int offset_i = -2; offset_i <= 2; ++offset_i) {
            int i = base_i + offset_i;
            if (i < 0 || i >= nx) continue;
            int i_idx = offset_i + 2;
            float Sx = Sx_arr[i_idx];
            if (fabsf(Sx) < 1.0e-7f) continue;
            float dSx = dSx_arr[i_idx];
            float node_x = (static_cast<float>(i) + 0.5f) * dx;

            for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                int j = base_j + offset_j;
                if (j < 0 || j >= ny) continue;
                int j_idx = offset_j + 2;
                float Sy = Sy_arr[j_idx];
                if (fabsf(Sy) < 1.0e-7f) continue;
                float dSy = dSy_arr[j_idx];
                float node_y = (static_cast<float>(j) + 0.5f) * dy;

                for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                    int k = base_k + offset_k;
                    if (k < 0 || k >= nz) continue;
                    int k_idx = offset_k + 2;
                    float Sz = Sz_arr[k_idx];
                    if (fabsf(Sz) < 1.0e-7f) continue;
                    float dSz = dSz_arr[k_idx];
                    float node_z = (static_cast<float>(k) + 0.5f) * dz;

                    float weight = Sx * Sy * Sz;
                    float dN_dx = dSx * Sy * Sz;
                    float dN_dy = Sx * dSy * Sz;
                    float dN_dz = Sx * Sy * dSz;

                    size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                    const MPMGridNode3D& node = grid[node_idx];

                    if (node.m > 1.0e-11f) {
                        float inv_m = 1.0f / node.m;
                        float n_vx = node.p[0] * inv_m;
                        float n_vy = node.p[1] * inv_m;
                        float n_vz = node.p[2] * inv_m;

                        v_pic_x += weight * n_vx;
                        v_pic_y += weight * n_vy;
                        v_pic_z += weight * n_vz;

                        float delta_vx = dt * (node.f_ext[0] + node.f_int[0]) * inv_m;
                        float delta_vy = dt * (node.f_ext[1] + node.f_int[1]) * inv_m;
                        float delta_vz = dt * (node.f_ext[2] + node.f_int[2]) * inv_m;

                        delta_v_grid_x += weight * delta_vx;
                        delta_v_grid_y += weight * delta_vy;
                        delta_v_grid_z += weight * delta_vz;

                        weight_sum += weight;

                        float dist_x = node_x - px;
                        float dist_y = node_y - py;
                        float dist_z = node_z - pz;

                        float w_apic = 1.0f;
                        B_new[0][0] += w_apic * weight * n_vx * dist_x * D_inv_x;
                        B_new[0][1] += w_apic * weight * n_vx * dist_y * D_inv_y;
                        B_new[0][2] += w_apic * weight * n_vx * dist_z * D_inv_z;

                        B_new[1][0] += w_apic * weight * n_vy * dist_x * D_inv_x;
                        B_new[1][1] += w_apic * weight * n_vy * dist_y * D_inv_y;
                        B_new[1][2] += w_apic * weight * n_vy * dist_z * D_inv_z;

                        B_new[2][0] += w_apic * weight * n_vz * dist_x * D_inv_x;
                        B_new[2][1] += w_apic * weight * n_vz * dist_y * D_inv_y;
                        B_new[2][2] += w_apic * weight * n_vz * dist_z * D_inv_z;

                        L_new[0][0] += n_vx * dN_dx;
                        L_new[0][1] += n_vx * dN_dy;
                        L_new[0][2] += n_vx * dN_dz;

                        L_new[1][0] += n_vy * dN_dx;
                        L_new[1][1] += n_vy * dN_dy;
                        L_new[1][2] += n_vy * dN_dz;

                        L_new[2][0] += n_vz * dN_dx;
                        L_new[2][1] += n_vz * dN_dy;
                        L_new[2][2] += n_vz * dN_dz;
                    }
                }
            }
        }
    } else {
        float d_scale = (eff_transfer_scheme == 2) ? 4.0f : 3.0f;
        float D_inv_x = d_scale / (dx * dx);
        float D_inv_y = d_scale / (dy * dy);
        float D_inv_z = d_scale / (dz * dz);

        float Sx_arr[4], dSx_arr[4], Sy_arr[4], dSy_arr[4], Sz_arr[4], dSz_arr[4];
        for (int offset = -1; offset <= 2; ++offset) {
            int idx = offset + 1;
            float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * dx;
            Sx_arr[idx] = (eff_transfer_scheme == 1) ? evalGIMP_S_dev(px, nx_val, dx, lp_0) :
                          ((eff_transfer_scheme == 2) ? evalBSpline_S_dev(px, nx_val, dx) :
                          fmaxf(0.0f, 1.0f - fabsf(px - nx_val) / dx));
            dSx_arr[idx] = (eff_transfer_scheme == 1) ? evalGIMP_dS_dev(px, nx_val, dx, lp_0) :
                           ((eff_transfer_scheme == 2) ? evalBSpline_dS_dev(px, nx_val, dx) :
                           (px >= nx_val ? -1.0f / dx : 1.0f / dx));

            float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * dy;
            Sy_arr[idx] = (eff_transfer_scheme == 1) ? evalGIMP_S_dev(py, ny_val, dy, lp_1) :
                          ((eff_transfer_scheme == 2) ? evalBSpline_S_dev(py, ny_val, dy) :
                          fmaxf(0.0f, 1.0f - fabsf(py - ny_val) / dy));
            dSy_arr[idx] = (eff_transfer_scheme == 1) ? evalGIMP_dS_dev(py, ny_val, dy, lp_1) :
                           ((eff_transfer_scheme == 2) ? evalBSpline_dS_dev(py, ny_val, dy) :
                           (py >= ny_val ? -1.0f / dy : 1.0f / dy));

            float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * dz;
            Sz_arr[idx] = (eff_transfer_scheme == 1) ? evalGIMP_S_dev(pz, nz_val, dz, lp_2) :
                          ((eff_transfer_scheme == 2) ? evalBSpline_S_dev(pz, nz_val, dz) :
                          fmaxf(0.0f, 1.0f - fabsf(pz - nz_val) / dz));
            dSz_arr[idx] = (eff_transfer_scheme == 1) ? evalGIMP_dS_dev(pz, nz_val, dz, lp_2) :
                           ((eff_transfer_scheme == 2) ? evalBSpline_dS_dev(pz, nz_val, dz) :
                           (pz >= nz_val ? -1.0f / dz : 1.0f / dz));
        }

        for (int offset_i = -1; offset_i <= 2; ++offset_i) {
            int i = base_i + offset_i;
            if (i < 0 || i >= nx) continue;
            int i_idx = offset_i + 1;
            float Sx = Sx_arr[i_idx];
            if (fabsf(Sx) < 1.0e-7f) continue;
            float dSx = dSx_arr[i_idx];
            float node_x = (static_cast<float>(i) + 0.5f) * dx;

            for (int offset_j = -1; offset_j <= 2; ++offset_j) {
                int j = base_j + offset_j;
                if (j < 0 || j >= ny) continue;
                int j_idx = offset_j + 1;
                float Sy = Sy_arr[j_idx];
                if (fabsf(Sy) < 1.0e-7f) continue;
                float dSy = dSy_arr[j_idx];
                float node_y = (static_cast<float>(j) + 0.5f) * dy;

                for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                    int k = base_k + offset_k;
                    if (k < 0 || k >= nz) continue;
                    int k_idx = offset_k + 1;
                    float Sz = Sz_arr[k_idx];
                    if (fabsf(Sz) < 1.0e-7f) continue;
                    float dSz = dSz_arr[k_idx];
                    float node_z = (static_cast<float>(k) + 0.5f) * dz;

                    float weight = Sx * Sy * Sz;
                    float dN_dx = dSx * Sy * Sz;
                    float dN_dy = Sx * dSy * Sz;
                    float dN_dz = Sx * Sy * dSz;

                    size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                    const MPMGridNode3D& node = grid[node_idx];

                    if (node.m > 1.0e-11f) {
                        float inv_m = 1.0f / node.m;
                        float n_vx = node.p[0] * inv_m;
                        float n_vy = node.p[1] * inv_m;
                        float n_vz = node.p[2] * inv_m;

                        v_pic_x += weight * n_vx;
                        v_pic_y += weight * n_vy;
                        v_pic_z += weight * n_vz;

                        float delta_vx = dt * (node.f_ext[0] + node.f_int[0]) * inv_m;
                        float delta_vy = dt * (node.f_ext[1] + node.f_int[1]) * inv_m;
                        float delta_vz = dt * (node.f_ext[2] + node.f_int[2]) * inv_m;

                        delta_v_grid_x += weight * delta_vx;
                        delta_v_grid_y += weight * delta_vy;
                        delta_v_grid_z += weight * delta_vz;

                        weight_sum += weight;

                        float dist_x = node_x - px;
                        float dist_y = node_y - py;
                        float dist_z = node_z - pz;

                        float w_apic = 1.0f;
                        B_new[0][0] += w_apic * weight * n_vx * dist_x * D_inv_x;
                        B_new[0][1] += w_apic * weight * n_vx * dist_y * D_inv_y;
                        B_new[0][2] += w_apic * weight * n_vx * dist_z * D_inv_z;

                        B_new[1][0] += w_apic * weight * n_vy * dist_x * D_inv_x;
                        B_new[1][1] += w_apic * weight * n_vy * dist_y * D_inv_y;
                        B_new[1][2] += w_apic * weight * n_vy * dist_z * D_inv_z;

                        B_new[2][0] += w_apic * weight * n_vz * dist_x * D_inv_x;
                        B_new[2][1] += w_apic * weight * n_vz * dist_y * D_inv_y;
                        B_new[2][2] += w_apic * weight * n_vz * dist_z * D_inv_z;

                        L_new[0][0] += n_vx * dN_dx;
                        L_new[0][1] += n_vx * dN_dy;
                        L_new[0][2] += n_vx * dN_dz;

                        L_new[1][0] += n_vy * dN_dx;
                        L_new[1][1] += n_vy * dN_dy;
                        L_new[1][2] += n_vy * dN_dz;

                        L_new[2][0] += n_vz * dN_dx;
                        L_new[2][1] += n_vz * dN_dy;
                        L_new[2][2] += n_vz * dN_dz;
                    }
                }
            }
        }
    }

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
    }

    bool has_failed_p = (soa.has_failed[p_idx] != 0);

    float target_vx = v_pic_x;
    float target_vy = v_pic_y;
    float target_vz = v_pic_z;

    // Pure Lagrangian ballistic velocity for DEM / failed particles (0% grid interpolation)
    if (has_failed_p || (soa.damage && soa.damage[p_idx] >= 1.0f) || (soa.state && soa.state[p_idx] != 0)) {
        target_vx = v_prev_x;
        target_vy = v_prev_y;
        target_vz = v_prev_z;
    } else if (velocity_scheme == 2) {
        float alpha = fminf(fmaxf(flip_blend, 0.0f), 1.0f);
        float v_flip_x = v_prev_x + delta_v_grid_x;
        float v_flip_y = v_prev_y + delta_v_grid_y;
        float v_flip_z = v_prev_z + delta_v_grid_z;
        target_vx = alpha * v_flip_x + (1.0f - alpha) * v_pic_x;
        target_vy = alpha * v_flip_y + (1.0f - alpha) * v_pic_y;
        target_vz = alpha * v_flip_z + (1.0f - alpha) * v_pic_z;
    }

    float final_vx = fminf(fmaxf(target_vx, -5000.0f), 5000.0f);
    float final_vy = fminf(fmaxf(target_vy, -5000.0f), 5000.0f);
    float final_vz = fminf(fmaxf(target_vz, -5000.0f), 5000.0f);

    soa.v[0][p_idx] = final_vx;
    soa.v[1][p_idx] = final_vy;
    soa.v[2][p_idx] = final_vz;

    // Store particle velocity gradient B_p for constitutive stress update (only for intact APIC particles)
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            float b_val = fminf(fmaxf(B_new[r][c], -max_B), max_B);
            soa.B[r][c][p_idx] = (!has_failed_p && velocity_scheme == 0) ? b_val : 0.0f;
            soa.L_grad[r][c][p_idx] = (velocity_scheme == 0) ? b_val : fminf(fmaxf(L_new[r][c], -max_B), max_B);
        }
    }

    float new_x = soa.x[0][p_idx] + dt * final_vx;
    float new_y = soa.x[1][p_idx] + dt * final_vy;
    float new_z = soa.x[2][p_idx] + dt * final_vz;

    float min_x = xmin + 3.0f * dx; float max_x = xmin + (static_cast<float>(nx - 4)) * dx;
    float min_y = ymin + 3.0f * dy; float max_y = ymin + (static_cast<float>(ny - 4)) * dy;
    float min_z = zmin + 3.0f * dz; float max_z = zmin + (static_cast<float>(nz - 4)) * dz;

    if (new_x < min_x && bc_x_min != 3) {
        new_x = min_x;
        if (final_vx < 0.0f) { final_vx = 0.0f; soa.v[0][p_idx] = 0.0f; }
    } else if (new_x > max_x && bc_x_max != 3) {
        new_x = max_x;
        if (final_vx > 0.0f) { final_vx = 0.0f; soa.v[0][p_idx] = 0.0f; }
    }

    if (new_y < min_y && bc_y_min != 3) {
        new_y = min_y;
        if (final_vy < 0.0f) { final_vy = 0.0f; soa.v[1][p_idx] = 0.0f; }
    } else if (new_y > max_y && bc_y_max != 3) {
        new_y = max_y;
        if (final_vy > 0.0f) { final_vy = 0.0f; soa.v[1][p_idx] = 0.0f; }
    }

    if (new_z < min_z && bc_z_min != 3) {
        new_z = min_z;
        if (final_vz < 0.0f) { final_vz = 0.0f; soa.v[2][p_idx] = 0.0f; }
    } else if (new_z > max_z && bc_z_max != 3) {
        new_z = max_z;
        if (final_vz > 0.0f) { final_vz = 0.0f; soa.v[2][p_idx] = 0.0f; }
    }

    soa.x[0][p_idx] = new_x;
    soa.x[1][p_idx] = new_y;
    soa.x[2][p_idx] = new_z;
}

// 4. Stress Update Kernel (Coalesced SoA)
__global__ void kernel_stress_update_3d(MPMParticle3DSoA soa, int num_particles, float dt, const MaterialTable3D* d_mat_tables) {
    int p_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (p_idx >= num_particles) return;

    int obj_id = soa.object_id[p_idx];
    const MaterialTable3D& mat = d_mat_tables[obj_id];

    float L[3][3];
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            L[r][c] = soa.L_grad[r][c][p_idx];
        }
    }

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
    V_p = fminf(fmaxf(V_p * (1.0f + tr_deps), 0.1f * V0_p), 10.0f * V0_p);
    soa.V[p_idx] = V_p;

    float lp_val = 0.5f * cbrtf(V_p);
    soa.lp[0][p_idx] = lp_val; soa.lp[1][p_idx] = lp_val; soa.lp[2][p_idx] = lp_val;

    float sigma_p[3][3];
    for (int r = 0; r < 3; ++r)
        for (int c = 0; c < 3; ++c)
            sigma_p[r][c] = soa.sigma[r][c][p_idx];

    bool has_failed_p = (soa.has_failed[p_idx] != 0);
    float damage_p = soa.damage[p_idx];
    float ep_bar_p = soa.ep_bar[p_idx];
    float temperature_p = soa.temperature[p_idx];
    float e_int_p = soa.e_int[p_idx];

    // --- Unified Parent Material Response for Eroded / Failed / Fractured Particles ---
    if (has_failed_p || damage_p >= 1.0f) {
        bool first_fail = (!has_failed_p || (soa.state && soa.state[p_idx] == 0));
        soa.has_failed[p_idx] = 1;
        soa.damage[p_idx] = 1.0f;
        if (soa.state && mat.dem_transition_enabled) {
            soa.state[p_idx] = 1; // Mark as DEM particle
        }

        if (first_fail) {
            // 1. Deviatoric Elastic Strain Energy conversion to radial kinetic ejection jitter
            const float E_mod = mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f;
            const float nu_d  = fminf(fmaxf(mat.poissons_ratio, 0.01f), 0.49f);
            const float G_mod = E_mod / (2.0f * (1.0f + nu_d));
            const float rho   = mat.density > 0.0f ? mat.density : 7850.0f;

            float p_hyd = -(sigma_p[0][0] + sigma_p[1][1] + sigma_p[2][2]) / 3.0f;
            float s00 = sigma_p[0][0] + p_hyd;
            float s11 = sigma_p[1][1] + p_hyd;
            float s22 = sigma_p[2][2] + p_hyd;
            float s_dev_sq = s00*s00 + s11*s11 + s22*s22 + 2.0f * (sigma_p[0][1]*sigma_p[0][1] + sigma_p[1][2]*sigma_p[1][2] + sigma_p[2][0]*sigma_p[2][0]);
            float U_e = 0.5f * s_dev_sq / fmaxf(1.0e6f, 2.0f * G_mod);
            float v_kick = mat.fragment_ejection_jitter * sqrtf(fmaxf(0.0f, 2.0f * U_e / rho));
            v_kick = fminf(v_kick, 30.0f); // Clamp to physical crack opening speed

            // Deterministic pseudo-random direction based on particle index
            unsigned int seed = static_cast<unsigned int>(p_idx * 1664525u + 1013904223u);
            float rx = (static_cast<float>(seed & 0xFFFF) / 65535.0f - 0.5f) * 2.0f; seed = seed * 1664525u + 1013904223u;
            float ry = (static_cast<float>(seed & 0xFFFF) / 65535.0f - 0.5f) * 2.0f; seed = seed * 1664525u + 1013904223u;
            float rz = (static_cast<float>(seed & 0xFFFF) / 65535.0f - 0.5f) * 2.0f;
            float r_len = sqrtf(rx*rx + ry*ry + rz*rz) + 1.0e-5f;
            soa.v[0][p_idx] += v_kick * (rx / r_len);
            soa.v[1][p_idx] += v_kick * (ry / r_len);
            soa.v[2][p_idx] += v_kick * (rz / r_len);

            // 2. Statistical Rosin-Rammler / Mott-Grady fragment diameter assignment
            seed = seed * 1664525u + 1013904223u;
            float u_rand = fminf(fmaxf(static_cast<float>(seed & 0xFFFF) / 65535.0f, 1.0e-4f), 0.999f);
            float d_min = fmaxf(0.0005f, mat.fragment_min_size);
            float d_max = fmaxf(d_min * 1.5f, mat.fragment_max_size);
            float weibull_n = fmaxf(0.5f, mat.fragment_weibull_n);
            float d_frag = d_min + (d_max - d_min) * powf(-logf(1.0f - u_rand), 1.0f / weibull_n);
            d_frag = fminf(fmaxf(d_frag, d_min), d_max * 2.0f);
            if (soa.contact_radius) {
                soa.contact_radius[p_idx] = 0.5f * d_frag;
            }
        }

        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                soa.B[r][c][p_idx] = 0.0f; // Zero affine velocity gradient to eliminate elastic tensile coupling

        // 1. Bulk Pressure from Volumetric Compression J = V / V0 using Parent EOS
        const float J = V_p / (V0_p > 1.0e-20f ? V0_p : 1.0e-20f);
        float p_comp = 0.0f;
        if (J < 1.0f) {
            if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen && mat.mg_c0 > 0.0f) {
                const float mu_vol = (1.0f - J) / fmaxf(0.01f, J);
                const float denom = fmaxf(0.1f, 1.0f - (mat.mg_s - 1.0f) * mu_vol);
                const float p_hugoniot = (mat.density * mat.mg_c0 * mat.mg_c0 * mu_vol * (1.0f + (1.0f - 0.5f * mat.mg_gamma0) * mu_vol)) / (denom * denom);
                p_comp = fmaxf(0.0f, p_hugoniot + mat.mg_gamma0 * mat.density * soa.e_int[p_idx]);
            } else {
                const float E_mod    = mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f;
                const float nu       = fminf(fmaxf(mat.poissons_ratio, 0.01f), 0.49f);
                const float K_parent = E_mod / (3.0f * (1.0f - 2.0f * nu));
                p_comp = K_parent * (1.0f - J) / fmaxf(0.01f, J);
            }
        }

        // 2. Frictional Shear Resistance under Confinement (Mohr-Coulomb / Drucker-Prager: q <= M * p_comp)
        float M_friction = 0.30f;
        if (mat.material_model == MPMMaterialModel::RHTConcrete ||
            mat.material_model == MPMMaterialModel::KCConcrete ||
            mat.material_model == MPMMaterialModel::CSCMConcrete) {
            M_friction = 0.60f; // Concrete/rock aggregate friction
        } else if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen) {
            M_friction = 0.15f; // Ductile metal shear resistance under high pressure
        }
        const float q_max = M_friction * p_comp;

        const float E_mod = mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f;
        const float nu = fminf(fmaxf(mat.poissons_ratio, 0.01f), 0.49f);
        const float mu_parent = E_mod / (2.0f * (1.0f + nu));

        float deps_dev[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c) {
                deps_dev[r][c] = deps[r][c];
                if (r == c) deps_dev[r][c] -= tr_deps / 3.0f;
            }

        float s_trial[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                s_trial[r][c] = sigma_p[r][c] + 2.0f * mu_parent * deps_dev[r][c];

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
                    soa.sigma[r][c][p_idx] = scale * s_trial[r][c];
        } else {
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    soa.sigma[r][c][p_idx] = s_trial[r][c];
        }

        for (int r = 0; r < 3; ++r)
            soa.sigma[r][r][p_idx] -= p_comp;

        return;
    }

    // --- Linear Elastic Model (Hooke's Law with Jaumann Rotation) ---
    if (mat.material_model == MPMMaterialModel::LinearElastic) {
        const float J = V_p / (V0_p > 1.0e-20f ? V0_p : 1.0e-20f);

        float W_sig[3][3] = {}, sig_W[3][3] = {};
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                for (int k = 0; k < 3; ++k) {
                    W_sig[r][c] += W[r][k] * sigma_p[k][c];
                    sig_W[r][c] += sigma_p[r][k] * W[k][c];
                }

        float sig_base[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                sig_base[r][c] = sigma_p[r][c] + (W_sig[r][c] - sig_W[r][c]) * dt;

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
            for (int c = 0; c < 3; ++c)
                soa.sigma[r][c][p_idx] = s_trial[r][c] - (r == c ? p_hydro : 0.0f);

        return;
    }

    // --- CREST Reactive Burn Model with Davis Reactant & Product EOS ---
    if (mat.material_model == MPMMaterialModel::CRESTReactiveBurn) {
        const float v_rel = fminf(fmaxf(V_p / (V0_p > 1.0e-20f ? V0_p : 1.0e-20f), 0.05f), 50.0f);
        float v_min_val = soa.v_min ? soa.v_min[p_idx] : 1.0f;
        v_min_val = fminf(v_min_val, v_rel);
        if (soa.v_min) soa.v_min[p_idx] = v_min_val;

        // 1. Peak Shock Entropy Latching (Kinematic Volume, Cauchy Pressure, Reactant Pressure & Temperature)
        float s_calc = CrestDavis::computeDavisShockEntropy(v_min_val, mat.davis_c0, mat.davis_s1, mat.davis_gamma0, mat.davis_cv, mat.davis_t0, mat.davis_rho0);
        float s_shock_val = soa.s_shock ? soa.s_shock[p_idx] : 0.0f;
        s_shock_val = fmaxf(s_shock_val, s_calc);

        float p_curr_comp = -(sigma_p[0][0] + sigma_p[1][1] + sigma_p[2][2]) / 3.0f;
        float p_react_trial = CrestDavis::computeDavisReactantPressure(v_rel, e_int_p, mat.davis_c0, mat.davis_s1, mat.davis_gamma0, mat.davis_cv, mat.davis_t0, mat.davis_rho0);
        float p_eff_comp = fmaxf(p_curr_comp, p_react_trial);
        if (p_eff_comp > 1.0e6f) {
            float s_p = CrestDavis::computeDavisShockEntropyFromPressure(p_eff_comp, mat.davis_c0, mat.davis_s1, mat.davis_cv, mat.davis_t0, mat.davis_rho0);
            s_shock_val = fmaxf(s_shock_val, s_p);
        }

        if (temperature_p > mat.davis_t0) {
            float s_therm = mat.davis_cv * logf(temperature_p / mat.davis_t0);
            s_shock_val = fmaxf(s_shock_val, s_therm);
        }
        if (soa.s_shock) soa.s_shock[p_idx] = s_shock_val;

        // 2. CREST Kinetics ODE Advance
        float lam_curr = soa.lambda ? soa.lambda[p_idx] : 0.0f;
        float lam_new = CrestDavis::advanceCRESTProgress(dt, s_shock_val, lam_curr, mat.crest_b1, mat.crest_c1, mat.crest_m1, mat.crest_b2, mat.crest_c2, mat.crest_c3, mat.crest_m2, mat.crest_s0, mat.crest_s_threshold);
        if (soa.lambda) soa.lambda[p_idx] = lam_new;
        float d_lam = fmaxf(0.0f, lam_new - lam_curr);

        // 3. Two-Phase Pressures
        float p_react = CrestDavis::computeDavisReactantPressure(v_rel, e_int_p, mat.davis_c0, mat.davis_s1, mat.davis_gamma0, mat.davis_cv, mat.davis_t0, mat.davis_rho0);
        float p_prod  = CrestDavis::computeDavisProductPressure(v_rel, e_int_p + mat.davis_q_det, mat.davis_a, mat.davis_b, mat.davis_k, mat.davis_vc, mat.davis_pc, mat.davis_q_det, mat.davis_rho0);
        float p_mix   = (1.0f - lam_new) * p_react + lam_new * p_prod;
        if (p_mix < 1.0e-6f) p_mix = 1.0e-6f;

        // 4. Energy Conservation: Shock Work & Chemical Heat Release
        float rho_eff = (mat.density > 10.0f) ? mat.density : 1895.0f;
        float de_comp = (tr_deps < 0.0f) ? -(p_mix / rho_eff) * tr_deps : 0.0f;
        float de_chem = d_lam * mat.davis_q_det;
        e_int_p += de_comp + de_chem;
        if (soa.e_int) soa.e_int[p_idx] = e_int_p;
        temperature_p = mat.davis_t0 + e_int_p / (mat.davis_cv > 1.0f ? mat.davis_cv : 1000.0f);
        if (soa.temperature) soa.temperature[p_idx] = temperature_p;
        if (temperature_p > mat.davis_t0) {
            float s_therm = mat.davis_cv * logf(temperature_p / mat.davis_t0);
            s_shock_val = fmaxf(s_shock_val, s_therm);
            if (soa.s_shock) soa.s_shock[p_idx] = s_shock_val;
        }

        // 5. Solid Shear Stress Relaxation with Radial Return Plasticity
        float W_sig[3][3] = {}, sig_W[3][3] = {};
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                for (int k = 0; k < 3; ++k) {
                    W_sig[r][c] += W[r][k] * sigma_p[k][c];
                    sig_W[r][c] += sigma_p[r][k] * W[k][c];
                }

        float sig_base[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                sig_base[r][c] = sigma_p[r][c] + (W_sig[r][c] - sig_W[r][c]) * dt;

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
            for (int c = 0; c < 3; ++c)
                soa.sigma[r][c][p_idx] = s_trial[r][c] - (r == c ? p_mix : 0.0f);

        return;
    }

    // --- Johnson-Cook Plasticity + Mie-Grüneisen Shock EOS Model ---
    if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen) {
        float w_factor = (soa.weibull_factor && soa.weibull_factor[p_idx] > 0.001f) ? soa.weibull_factor[p_idx] : 1.0f;

        const float J = V_p / (V0_p > 1.0e-20f ? V0_p : 1.0e-20f);
        const float mu_vol = (1.0f - J) / J;

        float p_hydro = 0.0f;
        if (mu_vol > 0.0f) {
            float denom = 1.0f - (mat.mg_s - 1.0f) * mu_vol;
            if (denom < 0.1f) denom = 0.1f;
            float p_H = (mat.density * mat.mg_c0 * mat.mg_c0 * mu_vol * (1.0f + mu_vol)) / (denom * denom);
            float e_H = (p_H * mu_vol) / (2.0f * mat.density * (1.0f + mu_vol));
            p_hydro = p_H + mat.mg_gamma0 * mat.density * (e_int_p - e_H);
        } else {
            p_hydro = mat.density * mat.mg_c0 * mat.mg_c0 * mu_vol;
        }

        float W_sig[3][3] = {}, sig_W[3][3] = {};
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                for (int k = 0; k < 3; ++k) {
                    W_sig[r][c] += W[r][k] * sigma_p[k][c];
                    sig_W[r][c] += sigma_p[r][k] * W[k][c];
                }

        float sig_base[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                sig_base[r][c] = sigma_p[r][c] + (W_sig[r][c] - sig_W[r][c]) * dt;

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

        float double_contraction = 0.0f;
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                double_contraction += deps_dev[r][c] * deps_dev[r][c];
        float deps_eq = sqrtf((2.0f / 3.0f) * double_contraction);
        float ep_dot_star = fmaxf(1.0f, deps_eq / (dt > 1e-12f ? dt : 1e-12f));
        float T_star = fminf(fmaxf((temperature_p - mat.T_room) / (mat.T_melt > mat.T_room ? mat.T_melt - mat.T_room : 1.0f), 0.0f), 1.0f);

        float term_strain = (mat.jc_A * w_factor) + mat.jc_B * powf(fmaxf(0.0f, ep_bar_p), mat.jc_n);
        float term_rate   = 1.0f + mat.jc_C * logf(ep_dot_star);
        float term_temp   = 1.0f - powf(T_star, mat.jc_m);
        if (term_temp < 0.0f) term_temp = 0.0f;

        float soft_damage = fminf(fmaxf(1.0f - damage_p, 0.05f), 1.0f);
        float jc_yield = term_strain * term_rate * term_temp * soft_damage;
        if (T_star >= 1.0f) jc_yield = 0.0f;

        float H_jc = (mat.jc_n > 0.0f && ep_bar_p > 1.0e-6f)
            ? (mat.jc_n * mat.jc_B * powf(ep_bar_p, mat.jc_n - 1.0f) * term_rate * term_temp)
            : mat.hardening_modulus;
        float delta_ep = 0.0f;
        if (q_trial > 1.0e-5f && q_trial > jc_yield) {
            delta_ep = (q_trial - jc_yield) / (3.0f * mu_shear + H_jc);
            float scale = (q_trial > 1e-12f) ? (jc_yield / q_trial) : 0.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c) {
                    soa.sigma[r][c][p_idx] = scale * s_trial[r][c];
                    if (r == c) soa.sigma[r][c][p_idx] -= p_hydro;
                }
            ep_bar_p += delta_ep;
            soa.ep_bar[p_idx] = ep_bar_p;
        } else {
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c) {
                    soa.sigma[r][c][p_idx] = s_trial[r][c];
                    if (r == c) soa.sigma[r][c][p_idx] -= p_hydro;
                }
        }

        if (delta_ep > 0.0f && mat.density > 0.0f && mat.Cp > 0.0f) {
            float dw_p = jc_yield * delta_ep;
            float de_p = (0.90f * dw_p) / mat.density;
            e_int_p += de_p;
            temperature_p = mat.T_room + e_int_p / mat.Cp;
            soa.e_int[p_idx] = e_int_p;
            soa.temperature[p_idx] = temperature_p;
        }

        const float fail_strain_base = ((mat.erosion_strain > 0.0f) ? mat.erosion_strain : mat.failure_strain) * w_factor;
        const float tensile_fail_base = ((mat.erosion_stress > 0.0f) ? mat.erosion_stress : mat.tensile_failure_stress) * w_factor;

        float d_plastic = 0.0f;
        if (mat.enable_strain_erosion && fail_strain_base > 0.0f) {
            d_plastic = fminf(fmaxf(ep_bar_p / fail_strain_base, 0.0f), 1.0f);
        }

        float d_tensile = 0.0f;
        if (mat.enable_stress_erosion && tensile_fail_base > 0.0f) {
            float tensile_stress = -p_hydro;
            if (tensile_stress > 0.0f) {
                d_tensile = fminf(fmaxf(tensile_stress / tensile_fail_base, 0.0f), 1.0f);
            }
        }

            damage_p = fmaxf(damage_p, fmaxf(d_plastic, d_tensile));
            soa.damage[p_idx] = damage_p;
            if (damage_p >= 1.0f && (mat.enable_strain_erosion || mat.enable_stress_erosion)) {
                soa.has_failed[p_idx] = 1;
                soa.damage[p_idx] = 1.0f;
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        soa.B[r][c][p_idx] = 0.0f;

                float p_comp = 0.0f;
                if (J < 1.0f) {
                    if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen && mat.mg_c0 > 0.0f) {
                        const float mu_vol = (1.0f - J) / fmaxf(0.01f, J);
                        const float denom = fmaxf(0.1f, 1.0f - (mat.mg_s - 1.0f) * mu_vol);
                        const float p_hugoniot = (mat.density * mat.mg_c0 * mat.mg_c0 * mu_vol * (1.0f + (1.0f - 0.5f * mat.mg_gamma0) * mu_vol)) / (denom * denom);
                        p_comp = fmaxf(0.0f, p_hugoniot + mat.mg_gamma0 * mat.density * soa.e_int[p_idx]);
                    } else {
                        const float E_mod_d  = mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f;
                        const float nu_d     = fminf(fmaxf(mat.poissons_ratio, 0.01f), 0.49f);
                        const float K_parent = E_mod_d / (3.0f * (1.0f - 2.0f * nu_d));
                        p_comp = K_parent * (1.0f - J) / fmaxf(0.01f, J);
                    }
                }
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        soa.sigma[r][c][p_idx] = (r == c) ? -p_comp : 0.0f;
                return;
            }

        return;
    }

    // --- Standard Hypoelastic Model ---
    float W_sig[3][3] = {}, sig_W[3][3] = {};
    for (int r = 0; r < 3; ++r)
        for (int c = 0; c < 3; ++c)
            for (int k = 0; k < 3; ++k) {
                W_sig[r][c] += W[r][k] * sigma_p[k][c];
                sig_W[r][c] += sigma_p[r][k] * W[k][c];
            }

    float sig_base[3][3];
    for (int r = 0; r < 3; ++r)
        for (int c = 0; c < 3; ++c)
            sig_base[r][c] = sigma_p[r][c] + (W_sig[r][c] - sig_W[r][c]) * dt;

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

    float char_len_p = cbrtf(V_p > 1.0e-20f ? V_p : 1.0e-6f);
    float deps_norm = 0.0f;
    for (int r = 0; r < 3; ++r)
        for (int c = 0; c < 3; ++c)
            deps_norm += deps[r][c] * deps[r][c];
    float ep_dot = sqrtf((2.0f / 3.0f) * deps_norm) / (dt > 1.0e-12f ? dt : 1.0e-12f);
    float lambda_p = soa.lambda ? soa.lambda[p_idx] : 0.0f;

    if (mat.material_model == MPMMaterialModel::RHTConcrete) {
        RHTStateVariables<float> rht_state;
        rht_state.damage = damage_p;
        rht_state.ep_bar = ep_bar_p;
        rht_state.p_hydro = press;
        updateRHTStress<float>(
            s, press, tr_deps, dt, char_len_p, ep_dot,
            mat.fc, mat.ft, mu, K_bulk,
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
            for (int c = 0; c < 3; ++c) {
                soa.sigma[r][c][p_idx] = s[r][c];
                if (r == c) soa.sigma[r][c][p_idx] -= press;
            }
    } else if (mat.material_model == MPMMaterialModel::KCConcrete) {
        KCStateVariables<float> kc_state;
        kc_state.damage = damage_p;
        kc_state.lambda = lambda_p;
        kc_state.ep_bar = ep_bar_p;
        kc_state.p_hydro = press;
        updateKCStress<float>(
            s, press, tr_deps, dt, char_len_p, ep_dot,
            mat.fc, mat.ft, mu, K_bulk,
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
            for (int c = 0; c < 3; ++c) {
                soa.sigma[r][c][p_idx] = s[r][c];
                if (r == c) soa.sigma[r][c][p_idx] -= press;
            }
    } else if (mat.material_model == MPMMaterialModel::CSCMConcrete) {
        CSCMStateVariables<float> cscm_state;
        cscm_state.damage = damage_p;
        cscm_state.kappa = lambda_p;
        cscm_state.ep_bar = ep_bar_p;
        cscm_state.p_hydro = press;
        updateCSCMStress<float>(
            s, press, tr_deps, dt, char_len_p, ep_dot,
            mat.fc, mat.ft, mu, K_bulk,
            mat.G_f,
            mat.cscm_alpha, mat.cscm_theta,
            mat.cscm_lambda, mat.cscm_beta,
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
            for (int c = 0; c < 3; ++c) {
                soa.sigma[r][c][p_idx] = s[r][c];
                if (r == c) soa.sigma[r][c][p_idx] -= press;
            }
    } else {
        // Default Hypoelastic J2 Elastoplasticity with Weibull flaw scatter & plastic damage softening
        float w_factor = (soa.weibull_factor && soa.weibull_factor[p_idx] > 0.001f) ? soa.weibull_factor[p_idx] : 1.0f;
        if (w_factor <= 0.001f && mat.weibull_modulus > 0.001f) {
            w_factor = computeWeibullFactor_dev(soa.x[0][p_idx], soa.x[1][p_idx], soa.x[2][p_idx], mat.weibull_modulus, mat.weibull_scale);
            soa.weibull_factor[p_idx] = w_factor;
        }
        const float yield_base = mat.yield_stress * w_factor;
        const float fail_strain_base = ((mat.erosion_strain > 0.0f) ? mat.erosion_strain : mat.failure_strain) * w_factor;
        const float soft_factor = fminf(fmaxf(1.0f - 0.70f * damage_p, 0.10f), 1.0f);
        const float yield_eff = yield_base * soft_factor + mat.hardening_modulus * ep_bar_p;

        float s_s = 0.0f;
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                s_s += s[r][c] * s[r][c];
        const float q_trial   = sqrtf(1.5f * s_s);
        const float yield_surf = q_trial - yield_eff;

        if (q_trial > 1.0e-5f && yield_surf > 0.0f) {
            const float delta_ep = yield_surf / (3.0f * mu + mat.hardening_modulus);
            float scale = 1.0f - (3.0f * mu * delta_ep) / q_trial;
            if (scale < 0.0f) scale = 0.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c) {
                    soa.sigma[r][c][p_idx] = scale * s[r][c];
                    if (r == c) soa.sigma[r][c][p_idx] -= press;
                }
            ep_bar_p += delta_ep;
            soa.ep_bar[p_idx] = ep_bar_p;
        } else {
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    soa.sigma[r][c][p_idx] = sig_trial[r][c];
        }
        float d_plastic = 0.0f;
        if (mat.enable_strain_erosion && fail_strain_base > 0.0f) {
            d_plastic = fminf(fmaxf(ep_bar_p / fail_strain_base, 0.0f), 1.0f);
        }

        float d_tensile = 0.0f;
        if (mat.enable_stress_erosion) {
            float fail_stress = ((mat.erosion_stress > 0.0f) ? mat.erosion_stress : mat.tensile_failure_stress) * w_factor;
            float s00 = soa.sigma[0][0][p_idx], s11 = soa.sigma[1][1][p_idx], s22 = soa.sigma[2][2][p_idx];
            const float curr_press    = -(s00 + s11 + s22) / 3.0f;
            const float tensile_stress = -curr_press;
            if (tensile_stress > 0.0f && fail_stress > 0.0f) {
                d_tensile = fminf(fmaxf(tensile_stress / fail_stress, 0.0f), 1.0f);
            }
        }

        damage_p = fmaxf(damage_p, fmaxf(d_plastic, d_tensile));
        soa.damage[p_idx] = damage_p;
    }

    if (damage_p >= 1.0f && (mat.enable_strain_erosion || mat.enable_stress_erosion)) {
        soa.has_failed[p_idx] = 1;
        soa.damage[p_idx] = 1.0f;
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                soa.B[r][c][p_idx] = 0.0f;

        const float J = V_p / (V0_p > 1.0e-20f ? V0_p : 1.0e-20f);
        float p_comp = 0.0f;
        if (J < 1.0f) {
            if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen && mat.mg_c0 > 0.0f) {
                const float mu_vol = (1.0f - J) / fmaxf(0.01f, J);
                const float denom = fmaxf(0.1f, 1.0f - (mat.mg_s - 1.0f) * mu_vol);
                const float p_hugoniot = (mat.density * mat.mg_c0 * mat.mg_c0 * mu_vol * (1.0f + (1.0f - 0.5f * mat.mg_gamma0) * mu_vol)) / (denom * denom);
                p_comp = fmaxf(0.0f, p_hugoniot + mat.mg_gamma0 * mat.density * soa.e_int[p_idx]);
            } else {
                const float E_mod_d  = mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f;
                const float nu_d     = fminf(fmaxf(mat.poissons_ratio, 0.01f), 0.49f);
                const float K_parent = E_mod_d / (3.0f * (1.0f - 2.0f * nu_d));
                p_comp = K_parent * (1.0f - J) / fmaxf(0.01f, J);
            }
        }

        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                soa.sigma[r][c][p_idx] = (r == c) ? -p_comp : 0.0f;

        return;
    }
}

__global__ void kernel_compute_max_speed(MPMParticle3DSoA soa, int num_particles, float* d_max_speed, const MaterialTable3D* d_mat_tables) {
    extern __shared__ float s_max[];
    int tid = threadIdx.x;
    int idx = blockIdx.x * blockDim.x + threadIdx.x;

    float local_max = 100.0f;
    if (idx < num_particles) {
        int obj_id = soa.object_id[idx];
        const MaterialTable3D& mat = d_mat_tables[obj_id];
        float E = mat.youngs_modulus;
        float rho = fabsf(mat.density) > 10.0f ? fabsf(mat.density) : 10.0f;
        float nu = mat.poissons_ratio;
        float c_s = 0.0f;
        if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen) {
            float C0 = mat.mg_c0;
            c_s = sqrtf(C0 * C0 + (2.0f / 3.0f) * E / (rho * (1.0f + nu)));
        } else if (mat.material_model == MPMMaterialModel::CRESTReactiveBurn) {
            float C0 = mat.davis_c0;
            float c_solid = sqrtf(C0 * C0 + (2.0f / 3.0f) * E / (rho * (1.0f + nu)));
            float c_det = (mat.davis_pc > 1.0e6f) ? 7500.0f : 6000.0f;
            c_s = fmaxf(c_solid, c_det);
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
        v_mag = fminf(5000.0f, v_mag);
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

// MPMSolver3DCUDA Implementation
MPMSolver3DCUDA::MPMSolver3DCUDA() {}

MPMSolver3DCUDA::~MPMSolver3DCUDA() {
    freeDeviceMemory();
}

void MPMSolver3DCUDA::allocateSoABuffer(size_t count) {
    size_t required_bytes = count * (48 * sizeof(float) + 4 * sizeof(int));
    if (required_bytes > m_allocated_soa_bytes) {
        if (d_soa_buffer) cudaFree(d_soa_buffer);
        cudaMalloc(&d_soa_buffer, required_bytes);
        m_allocated_soa_bytes = required_bytes;
    }

    float* fptr = static_cast<float*>(d_soa_buffer);
    d_soa.x[0] = fptr; fptr += count;
    d_soa.x[1] = fptr; fptr += count;
    d_soa.x[2] = fptr; fptr += count;

    d_soa.v[0] = fptr; fptr += count;
    d_soa.v[1] = fptr; fptr += count;
    d_soa.v[2] = fptr; fptr += count;

    for (int r = 0; r < 3; ++r)
        for (int c = 0; c < 3; ++c) {
            d_soa.sigma[r][c] = fptr; fptr += count;
        }

    for (int r = 0; r < 3; ++r)
        for (int c = 0; c < 3; ++c) {
            d_soa.B[r][c] = fptr; fptr += count;
        }

    for (int r = 0; r < 3; ++r)
        for (int c = 0; c < 3; ++c) {
            d_soa.L_grad[r][c] = fptr; fptr += count;
        }

    d_soa.lp[0] = fptr; fptr += count;
    d_soa.lp[1] = fptr; fptr += count;
    d_soa.lp[2] = fptr; fptr += count;

    d_soa.m = fptr; fptr += count;
    d_soa.V0 = fptr; fptr += count;
    d_soa.V = fptr; fptr += count;
    d_soa.e_int = fptr; fptr += count;
    d_soa.temperature = fptr; fptr += count;
    d_soa.ep_bar = fptr; fptr += count;
    d_soa.damage = fptr; fptr += count;
    d_soa.lambda = fptr; fptr += count;
    d_soa.v_min = fptr; fptr += count;
    d_soa.s_shock = fptr; fptr += count;
    d_soa.weibull_factor = fptr; fptr += count;
    d_soa.contact_radius = fptr; fptr += count;

    int* iptr = reinterpret_cast<int*>(fptr);
    d_soa.has_failed = iptr; iptr += count;
    d_soa.object_id = iptr; iptr += count;
    d_soa.state = iptr; iptr += count;
    d_soa.cluster_id = iptr; iptr += count;
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

    if (!d_temp_aos_particles || m_allocated_temp_aos_particles < count) {
        if (d_temp_aos_particles) cudaFree(d_temp_aos_particles);
        cudaMalloc(&d_temp_aos_particles, count * sizeof(MPMParticle3D));
        m_allocated_temp_aos_particles = count;
    }
    cudaMemcpy(d_temp_aos_particles, m_host_particles.data(), count * sizeof(MPMParticle3D), cudaMemcpyHostToDevice);

    int threads = 256;
    int blocks = (static_cast<int>(count) + threads - 1) / threads;
    kernel_pack_aos_to_soa<<<blocks, threads>>>(d_temp_aos_particles, d_soa, static_cast<int>(count));
    cudaDeviceSynchronize();
}

void MPMSolver3DCUDA::downloadSoA2AoS() {
    if (m_device_dirty) syncToDevice();
    size_t count = m_host_particles.size();
    if (count == 0 || !d_soa_buffer) return;

    if (!d_temp_aos_particles || m_allocated_temp_aos_particles < count) {
        if (d_temp_aos_particles) cudaFree(d_temp_aos_particles);
        cudaMalloc(&d_temp_aos_particles, count * sizeof(MPMParticle3D));
        m_allocated_temp_aos_particles = count;
    }

    int threads = 256;
    int blocks = (static_cast<int>(count) + threads - 1) / threads;
    kernel_unpack_soa_to_aos<<<blocks, threads>>>(d_temp_aos_particles, d_soa, static_cast<int>(count));
    cudaDeviceSynchronize();
    cudaMemcpy(m_host_particles.data(), d_temp_aos_particles, count * sizeof(MPMParticle3D), cudaMemcpyDeviceToHost);
}

void MPMSolver3DCUDA::allocateDeviceMemory() {
    size_t num_grid_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
    size_t num_particles = m_host_particles.size();
    size_t num_materials = m_material_tables.size();

    int ntx = (m_nx + 7) / 8;
    int nty = (m_ny + 7) / 8;
    int ntz = (m_nz + 7) / 8;
    size_t total_tiles = static_cast<size_t>(ntx) * nty * ntz;

    if (total_tiles > m_allocated_tile_table) {
        if (d_tile_table) cudaFree(d_tile_table);
        if (d_num_active_tiles) cudaFree(d_num_active_tiles);
        cudaMalloc(&d_tile_table, total_tiles * sizeof(int));
        cudaMalloc(&d_num_active_tiles, sizeof(int));
        m_allocated_tile_table = total_tiles;
    }

    if (num_grid_nodes > m_allocated_grid_nodes) {
        if (d_grid) cudaFree(d_grid);
        if (d_grid_n) cudaFree(d_grid_n);
        cudaMalloc(&d_grid, num_grid_nodes * sizeof(MPMGridNode3D));
        cudaMalloc(&d_grid_n, num_grid_nodes * sizeof(float));
        m_allocated_grid_nodes = num_grid_nodes;
    }

    if (num_particles > m_allocated_particles) {
        allocateSoABuffer(num_particles);
        m_allocated_particles = num_particles;
    }

    if (num_materials > m_allocated_material_tables) {
        if (d_material_tables) cudaFree(d_material_tables);
        cudaMalloc(&d_material_tables, num_materials * sizeof(MaterialTable3D));
        m_allocated_material_tables = num_materials;
    }

    if (num_grid_nodes > m_allocated_cell_head) {
        if (d_cell_head) cudaFree(d_cell_head);
        cudaMalloc(&d_cell_head, num_grid_nodes * sizeof(int));
        m_allocated_cell_head = num_grid_nodes;
    }

    if (num_particles > m_allocated_particle_next) {
        if (d_particle_next) cudaFree(d_particle_next);
        cudaMalloc(&d_particle_next, num_particles * sizeof(int));
        m_allocated_particle_next = num_particles;
    }

    if (!d_max_v_buf) {
        cudaMalloc(&d_max_v_buf, sizeof(float));
    }
    if (!d_max_v_pinned) {
        cudaHostAlloc(&d_max_v_pinned, 2 * sizeof(int), cudaHostAllocPortable);
        d_max_v_pinned[0] = 0;
        d_max_v_pinned[1] = 0;
    }
}

void MPMSolver3DCUDA::uploadMaterialTableToDevice() {
    if (m_material_tables.empty()) return;
    allocateDeviceMemory();
    cudaMemcpy(d_material_tables, m_material_tables.data(), m_material_tables.size() * sizeof(MaterialTable3D), cudaMemcpyHostToDevice);
}

size_t MPMSolver3DCUDA::getAllocatedVRAM() const {
    size_t total = 0;
    total += m_allocated_grid_nodes * sizeof(MPMGridNode3D); // d_grid
    total += m_allocated_grid_nodes * sizeof(float);          // d_grid_n (helper)
    total += m_allocated_tile_table * sizeof(int);              // d_tile_table
    total += m_allocated_soa_bytes;                            // d_soa_buffer (SoA)
    total += m_allocated_material_tables * sizeof(MaterialTable3D); // d_material_tables
    total += m_allocated_active_nodes * sizeof(int);           // d_active_nodes
    total += m_allocated_f_ext_fsi * sizeof(float);             // d_f_ext_fsi
    total += m_allocated_temp_aos_particles * sizeof(MPMParticle3D); // d_temp_aos_particles
    total += m_allocated_slice_buf;                             // d_telemetry_slice_buf
    total += m_allocated_cell_head * sizeof(int);              // d_cell_head
    total += m_allocated_particle_next * sizeof(int);          // d_particle_next
    if (d_max_v_buf) total += sizeof(float);
    if (d_num_active_nodes) total += sizeof(int);
    if (d_num_active_tiles) total += sizeof(int);
    return total;
}

void MPMSolver3DCUDA::allocateActiveNodeBuffers() {
    size_t num_grid_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;

    if (num_grid_nodes > m_allocated_active_nodes) {
        if (d_active_nodes) cudaFree(d_active_nodes);
        if (d_num_active_nodes) cudaFree(d_num_active_nodes);
        cudaMalloc(&d_active_nodes, num_grid_nodes * sizeof(int));
        cudaMalloc(&d_num_active_nodes, sizeof(int));
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
    if (d_material_tables) { cudaFree(d_material_tables); d_material_tables = nullptr; }
    if (d_max_v_buf) { cudaFree(d_max_v_buf); d_max_v_buf = nullptr; }
    if (d_max_v_pinned) { cudaFreeHost(d_max_v_pinned); d_max_v_pinned = nullptr; }
    if (d_telemetry_slice_buf) { cudaFree(d_telemetry_slice_buf); d_telemetry_slice_buf = nullptr; m_allocated_slice_buf = 0; }
    if (d_f_ext_fsi) { cudaFree(d_f_ext_fsi); d_f_ext_fsi = nullptr; }
    if (d_cell_head) { cudaFree(d_cell_head); d_cell_head = nullptr; }
    if (d_particle_next) { cudaFree(d_particle_next); d_particle_next = nullptr; }
    m_allocated_cell_head = 0;
    m_allocated_particle_next = 0;
    freeActiveNodeBuffers();
    m_allocated_grid_nodes = 0;
    m_allocated_particles = 0;
    m_allocated_material_tables = 0;
}

void MPMSolver3DCUDA::initializeGrid(int nx, int ny, int nz, float dx, float dy, float dz, float xmin, float ymin, float zmin) {
    m_nx = nx; m_ny = ny; m_nz = nz;
    m_dx = dx; m_dy = dy; m_dz = dz;
    m_xmin = xmin; m_ymin = ymin; m_zmin = zmin;

    m_host_grid.resize(static_cast<size_t>(m_nx) * m_ny * m_nz);
    m_host_particles.clear();
    allocateDeviceMemory();
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
                                    MPMParticleDistribution particle_dist, MPMBoundaryFilling boundary_fill) {
    if (d_soa_buffer && !m_host_particles.empty()) {
        downloadSoA2AoS();
    }
    MPMSolver3D cpu_solver;
    cpu_solver.initializeGrid(m_nx, m_ny, m_nz, m_dx, m_dy, m_dz, m_xmin, m_ymin, m_zmin);
    cpu_solver.addBoxObject(obj_id, pos_x, pos_y, pos_z, size_x, size_y, size_z,
                            vel_x, vel_y, vel_z, angular_vel_x, angular_vel_y, angular_vel_z,
                            density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill);
    m_host_particles.insert(m_host_particles.end(), cpu_solver.getParticles().begin(), cpu_solver.getParticles().end());
    if (obj_id >= static_cast<int>(m_material_tables.size())) {
        m_material_tables.resize(obj_id + 1);
    }
    m_material_tables[obj_id] = cpu_solver.getMaterialTable(obj_id);
    m_device_dirty = true;
}

void MPMSolver3DCUDA::addSphereObject(int obj_id, float pos_x, float pos_y, float pos_z, float radius,
                                       float vel_x, float vel_y, float vel_z,
                                       float angular_vel_x, float angular_vel_y, float angular_vel_z,
                                       float density, float E, float nu,
                                       float yield_stress, float hardening, float failure_strain,
                                       float tensile_failure_stress, int ppc,
                                       MPMParticleDistribution particle_dist, MPMBoundaryFilling boundary_fill) {
    if (d_soa_buffer && !m_host_particles.empty()) {
        downloadSoA2AoS();
    }
    MPMSolver3D cpu_solver;
    cpu_solver.initializeGrid(m_nx, m_ny, m_nz, m_dx, m_dy, m_dz, m_xmin, m_ymin, m_zmin);
    cpu_solver.addSphereObject(obj_id, pos_x, pos_y, pos_z, radius,
                               vel_x, vel_y, vel_z, angular_vel_x, angular_vel_y, angular_vel_z,
                               density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill);
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
                                          MPMParticleDistribution particle_dist, MPMBoundaryFilling boundary_fill) {
    if (d_soa_buffer && !m_host_particles.empty()) {
        downloadSoA2AoS();
    }
    MPMSolver3D cpu_solver;
    cpu_solver.initializeGrid(m_nx, m_ny, m_nz, m_dx, m_dy, m_dz, m_xmin, m_ymin, m_zmin);
    cpu_solver.addCylinderObject(obj_id, pos_x, pos_y, pos_z, radius, inner_radius, height,
                                vel_x, vel_y, vel_z, angular_vel_x, angular_vel_y, angular_vel_z,
                                density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill);
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
                                    MPMParticleDistribution particle_dist, MPMBoundaryFilling boundary_fill) {
    if (d_soa_buffer && !m_host_particles.empty()) {
        downloadSoA2AoS();
    }
    MPMSolver3D cpu_solver;
    cpu_solver.initializeGrid(m_nx, m_ny, m_nz, m_dx, m_dy, m_dz, m_xmin, m_ymin, m_zmin);
    cpu_solver.addSTLObject(obj_id, stl_filepath, pos_x, pos_y, pos_z, scale_x, scale_y, scale_z,
                            vel_x, vel_y, vel_z, angular_vel_x, angular_vel_y, angular_vel_z,
                            density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill);
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

MPMVTKSnapshot3D MPMSolver3DCUDA::extractVTKSnapshot(bool has_vel, bool has_stress, bool has_strain, bool has_damage, bool has_temp) {
    MPMVTKSnapshot3D snap;
    size_t count = m_host_particles.size();
    snap.num_particles = static_cast<int>(count);
    snap.has_vel = has_vel;
    snap.has_stress = has_stress;
    snap.has_strain = has_strain;
    snap.has_damage = has_damage;
    snap.has_temp = has_temp;

    if (count == 0) return snap;

    snap.points.resize(count * 3);
    if (has_vel) snap.vel.resize(count * 3);
    if (has_stress) { snap.von_mises.resize(count); snap.pressure.resize(count); }
    if (has_strain) snap.ep_bar.resize(count);
    if (has_damage) snap.damage.resize(count);
    if (has_temp) snap.temp.resize(count);
    snap.obj_id.resize(count);

    if (d_soa_buffer) {
        float *d_pts = nullptr, *d_v = nullptr, *d_vm = nullptr, *d_p = nullptr;
        float *d_ep = nullptr, *d_dmg = nullptr, *d_tmp = nullptr, *d_obj = nullptr;

        cudaMalloc(&d_pts, count * 3 * sizeof(float));
        if (has_vel) cudaMalloc(&d_v, count * 3 * sizeof(float));
        if (has_stress) {
            cudaMalloc(&d_vm, count * sizeof(float));
            cudaMalloc(&d_p, count * sizeof(float));
        }
        if (has_strain) cudaMalloc(&d_ep, count * sizeof(float));
        if (has_damage) cudaMalloc(&d_dmg, count * sizeof(float));
        if (has_temp) cudaMalloc(&d_tmp, count * sizeof(float));
        cudaMalloc(&d_obj, count * sizeof(float));

        int threads = 256;
        int blocks = (static_cast<int>(count) + threads - 1) / threads;
        kernel_extract_mpm_vtk_snapshot_3d<<<blocks, threads>>>(
            d_soa, static_cast<int>(count),
            d_pts, d_v, d_vm, d_p, d_ep, d_dmg, d_tmp, d_obj,
            has_vel, has_stress, has_strain, has_damage, has_temp
        );
        cudaDeviceSynchronize();

        cudaMemcpy(snap.points.data(), d_pts, count * 3 * sizeof(float), cudaMemcpyDeviceToHost);
        if (has_vel && d_v) cudaMemcpy(snap.vel.data(), d_v, count * 3 * sizeof(float), cudaMemcpyDeviceToHost);
        if (has_stress) {
            if (d_vm) cudaMemcpy(snap.von_mises.data(), d_vm, count * sizeof(float), cudaMemcpyDeviceToHost);
            if (d_p) cudaMemcpy(snap.pressure.data(), d_p, count * sizeof(float), cudaMemcpyDeviceToHost);
        }
        if (has_strain && d_ep) cudaMemcpy(snap.ep_bar.data(), d_ep, count * sizeof(float), cudaMemcpyDeviceToHost);
        if (has_damage && d_dmg) cudaMemcpy(snap.damage.data(), d_dmg, count * sizeof(float), cudaMemcpyDeviceToHost);
        if (has_temp && d_tmp) cudaMemcpy(snap.temp.data(), d_tmp, count * sizeof(float), cudaMemcpyDeviceToHost);
        if (d_obj) cudaMemcpy(snap.obj_id.data(), d_obj, count * sizeof(float), cudaMemcpyDeviceToHost);

        cudaFree(d_pts);
        if (d_v) cudaFree(d_v);
        if (d_vm) cudaFree(d_vm);
        if (d_p) cudaFree(d_p);
        if (d_ep) cudaFree(d_ep);
        if (d_dmg) cudaFree(d_dmg);
        if (d_tmp) cudaFree(d_tmp);
        if (d_obj) cudaFree(d_obj);
    } else {
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
            if (has_stress) {
                double mean_s = (p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0;
                double s00 = p.sigma[0][0] - mean_s;
                double s11 = p.sigma[1][1] - mean_s;
                double s22 = p.sigma[2][2] - mean_s;
                double s01 = p.sigma[0][1];
                double s12 = p.sigma[1][2];
                double s20 = p.sigma[2][0];
                snap.von_mises[i] = static_cast<float>(std::sqrt(1.5 * (s00*s00 + s11*s11 + s22*s22 + 2.0*(s01*s01 + s12*s12 + s20*s20))));
                snap.pressure[i] = static_cast<float>(-mean_s);
            }
            if (has_strain) snap.ep_bar[i] = static_cast<float>(p.ep_bar);
            if (has_damage) snap.damage[i] = static_cast<float>(p.damage);
            if (has_temp) snap.temp[i] = static_cast<float>(p.temperature);
            snap.obj_id[i] = static_cast<float>(p.object_id);
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

    if (m_num_active_nodes > 0 && d_active_nodes) {
        int threads = 256;
        int blocks = (m_num_active_nodes + threads - 1) / threads;
        kernel_clear_active_nodes_3d<<<blocks, threads>>>(d_grid, d_active_nodes, m_num_active_nodes);
    } else {
        size_t num_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
        cudaMemsetAsync(d_grid, 0, num_nodes * sizeof(MPMGridNode3D));
    }
    if (d_num_active_nodes) {
        cudaMemsetAsync(d_num_active_nodes, 0, sizeof(int));
    }
    m_num_active_nodes = 0;
}

void MPMSolver3DCUDA::particleToGridOnly() {
    if (m_host_particles.empty()) return;
    if (m_device_dirty) syncToDevice();

    size_t num_particles = m_host_particles.size();
    size_t num_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;

    // Zero the active grid neighborhoods
    clearGridDevice();

    // Run P2G kernel only
    int threads_per_block = 256;
    int blocks_particles = (static_cast<int>(num_particles) + threads_per_block - 1) / threads_per_block;
    kernel_p2g_3d<<<blocks_particles, threads_per_block>>>(
        d_soa, static_cast<int>(num_particles),
        d_grid, m_nx, m_ny, m_nz,
        m_dx, m_dy, m_dz, static_cast<int>(m_transfer_scheme),
        m_xmin, m_ymin, m_zmin,
        d_active_nodes, d_num_active_nodes,
        d_material_tables);

    if (d_num_active_nodes) {
        cudaMemcpy(&m_num_active_nodes, d_num_active_nodes, sizeof(int), cudaMemcpyDeviceToHost);
    }

    // Download grid to host so FSI forces can be injected into m_host_grid
    m_host_grid.resize(num_nodes);
    cudaMemcpy(m_host_grid.data(), d_grid, num_nodes * sizeof(MPMGridNode3D), cudaMemcpyDeviceToHost);
}

void MPMSolver3DCUDA::particleToGridDeviceOnly() {
    if (m_host_particles.empty()) return;
    if (m_device_dirty) syncToDevice();

    size_t num_particles = m_host_particles.size();

    // Zero the active grid neighborhoods
    clearGridDevice();

    // Run P2G kernel only (no CPU synchronization, no download!)
    int threads_per_block = 256;
    int blocks_particles = (static_cast<int>(num_particles) + threads_per_block - 1) / threads_per_block;
    kernel_p2g_3d<<<blocks_particles, threads_per_block>>>(
        d_soa, static_cast<int>(num_particles),
        d_grid, m_nx, m_ny, m_nz,
        m_dx, m_dy, m_dz, static_cast<int>(m_transfer_scheme),
        m_xmin, m_ymin, m_zmin,
        d_active_nodes, d_num_active_nodes,
        d_material_tables);

    if (d_num_active_nodes) {
        cudaMemcpy(&m_num_active_nodes, d_num_active_nodes, sizeof(int), cudaMemcpyDeviceToHost);
    }
}

float MPMSolver3DCUDA::computeStepSize(float cfl) {
    size_t num_particles = m_host_particles.size();
    if (num_particles == 0 || !d_soa_buffer || !d_max_v_buf) return 1.0e-6f;

    allocateDeviceMemory();

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
        cudaMalloc(&d_f_ext_fsi, buf_size * sizeof(float));
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

void MPMSolver3DCUDA::stepWithDt(float dt, bool run_p2g) {
    if (m_host_particles.empty()) return;
    if (m_device_dirty) syncToDevice();

    m_last_dt = dt;
    m_sim_time += static_cast<double>(dt);
    m_step_count++;

    size_t num_particles = m_host_particles.size();
    size_t num_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;

    int threads_per_block = 256;
    int blocks_particles = (static_cast<int>(num_particles) + threads_per_block - 1) / threads_per_block;
    int blocks_nodes = (static_cast<int>(num_nodes) + threads_per_block - 1) / threads_per_block;
    int blocks_active = (m_num_active_nodes > 0 && d_active_nodes)
                      ? (m_num_active_nodes + threads_per_block - 1) / threads_per_block
                      : blocks_nodes;
    float avg_p_mass = m_host_particles.empty() ? 0.001f : m_host_particles[0].m;

    if (m_time_scheme == MPMTimeIntegrationScheme::RK2) {
        // --- 2nd-Order Midpoint RK2 ---
        // 1. Predictor Stage (Half-step dt/2)
        if (run_p2g) {
            int ntx = (m_nx + 7) / 8;
            int nty = (m_ny + 7) / 8;
            int ntz = (m_nz + 7) / 8;
            size_t total_tiles = static_cast<size_t>(ntx) * nty * ntz;
            if (d_tile_table && d_num_active_tiles) {
                cudaMemset(d_tile_table, -1, total_tiles * sizeof(int));
                cudaMemset(d_num_active_tiles, 0, sizeof(int));
                kernel_mark_active_tiles<<<blocks_particles, threads_per_block>>>(d_soa, static_cast<int>(num_particles),
                                                                                 d_tile_table, d_num_active_tiles,
                                                                                 ntx, nty, ntz, m_dx, m_dy, m_dz,
                                                                                 m_xmin, m_ymin, m_zmin);
            }
            clearGridDevice();
            kernel_p2g_3d<<<blocks_particles, threads_per_block>>>(d_soa, static_cast<int>(num_particles),
                                                                   d_grid, m_nx, m_ny, m_nz,
                                                                   m_dx, m_dy, m_dz, static_cast<int>(m_transfer_scheme),
                                                                   m_xmin, m_ymin, m_zmin,
                                                                   d_active_nodes, d_num_active_nodes,
                                                                   d_material_tables);
            if (d_num_active_nodes) {
                cudaMemcpy(&m_num_active_nodes, d_num_active_nodes, sizeof(int), cudaMemcpyDeviceToHost);
                blocks_active = (m_num_active_nodes > 0 && d_active_nodes)
                              ? (m_num_active_nodes + threads_per_block - 1) / threads_per_block
                              : blocks_nodes;
            }
        }
        if (d_f_ext_fsi) {
            kernel_restore_fsi_forces<<<blocks_nodes, threads_per_block>>>(d_grid, d_f_ext_fsi, static_cast<int>(num_nodes));
        }

        kernel_grid_update_3d<<<blocks_active, threads_per_block>>>(d_grid, static_cast<int>(num_nodes), m_nx, m_ny, m_nz,
                                                                   0.5f * dt, avg_p_mass,
                                                                   static_cast<int>(m_bc_x_min), static_cast<int>(m_bc_x_max),
                                                                   static_cast<int>(m_bc_y_min), static_cast<int>(m_bc_y_max),
                                                                   static_cast<int>(m_bc_z_min), static_cast<int>(m_bc_z_max),
                                                                   d_active_nodes, m_num_active_nodes);

        if (m_smooth_plastic_strain) {
            kernel_smooth_plastic_strain_3d<<<blocks_active, threads_per_block>>>(d_grid, d_grid_n, m_nx, m_ny, m_nz, d_active_nodes, m_num_active_nodes);
            kernel_copy_smoothed_plastic_strain_3d<<<blocks_active, threads_per_block>>>(d_grid, d_grid_n, static_cast<int>(num_nodes), d_active_nodes, m_num_active_nodes);
        }

        kernel_g2p_3d<<<blocks_particles, threads_per_block>>>(d_soa, static_cast<int>(num_particles),
                                                               d_grid, m_nx, m_ny, m_nz,
                                                               m_dx, m_dy, m_dz, 0.5f * dt, static_cast<int>(m_transfer_scheme),
                                                               static_cast<int>(m_velocity_scheme), m_flip_blend,
                                                               m_xmin, m_ymin, m_zmin,
                                                               static_cast<int>(m_bc_x_min), static_cast<int>(m_bc_x_max),
                                                               static_cast<int>(m_bc_y_min), static_cast<int>(m_bc_y_max),
                                                               static_cast<int>(m_bc_z_min), static_cast<int>(m_bc_z_max),
                                                               d_material_tables);

        kernel_stress_update_3d<<<blocks_particles, threads_per_block>>>(d_soa, static_cast<int>(num_particles), 0.5f * dt, d_material_tables);

        // 2. Corrector Stage — P2G from predictor midpoint state
        clearGridDevice();
        kernel_p2g_3d<<<blocks_particles, threads_per_block>>>(d_soa, static_cast<int>(num_particles),
                                                               d_grid, m_nx, m_ny, m_nz,
                                                               m_dx, m_dy, m_dz, static_cast<int>(m_transfer_scheme),
                                                               m_xmin, m_ymin, m_zmin,
                                                               d_active_nodes, d_num_active_nodes,
                                                               d_material_tables);
        if (d_num_active_nodes) {
            cudaMemcpy(&m_num_active_nodes, d_num_active_nodes, sizeof(int), cudaMemcpyDeviceToHost);
            blocks_active = (m_num_active_nodes > 0 && d_active_nodes)
                          ? (m_num_active_nodes + threads_per_block - 1) / threads_per_block
                          : blocks_nodes;
        }
        if (d_f_ext_fsi) {
            kernel_restore_fsi_forces<<<blocks_nodes, threads_per_block>>>(d_grid, d_f_ext_fsi, static_cast<int>(num_nodes));
        }

        kernel_grid_update_3d<<<blocks_active, threads_per_block>>>(d_grid, static_cast<int>(num_nodes), m_nx, m_ny, m_nz,
                                                                   dt, avg_p_mass,
                                                                   static_cast<int>(m_bc_x_min), static_cast<int>(m_bc_x_max),
                                                                   static_cast<int>(m_bc_y_min), static_cast<int>(m_bc_y_max),
                                                                   static_cast<int>(m_bc_z_min), static_cast<int>(m_bc_z_max),
                                                                   d_active_nodes, m_num_active_nodes);

        if (m_smooth_plastic_strain) {
            kernel_smooth_plastic_strain_3d<<<blocks_active, threads_per_block>>>(d_grid, d_grid_n, m_nx, m_ny, m_nz, d_active_nodes, m_num_active_nodes);
            kernel_copy_smoothed_plastic_strain_3d<<<blocks_active, threads_per_block>>>(d_grid, d_grid_n, static_cast<int>(num_nodes), d_active_nodes, m_num_active_nodes);
        }

        kernel_g2p_3d<<<blocks_particles, threads_per_block>>>(d_soa, static_cast<int>(num_particles),
                                                               d_grid, m_nx, m_ny, m_nz,
                                                               m_dx, m_dy, m_dz, 0.5f * dt, static_cast<int>(m_transfer_scheme),
                                                               static_cast<int>(m_velocity_scheme), m_flip_blend,
                                                               m_xmin, m_ymin, m_zmin,
                                                               static_cast<int>(m_bc_x_min), static_cast<int>(m_bc_x_max),
                                                               static_cast<int>(m_bc_y_min), static_cast<int>(m_bc_y_max),
                                                               static_cast<int>(m_bc_z_min), static_cast<int>(m_bc_z_max),
                                                               d_material_tables);

        kernel_stress_update_3d<<<blocks_particles, threads_per_block>>>(d_soa, static_cast<int>(num_particles), 0.5f * dt, d_material_tables);
    } else {
        // --- 1st-Order USL / USF ---
        if (run_p2g) {
            clearGridDevice();
            kernel_p2g_3d<<<blocks_particles, threads_per_block>>>(d_soa, static_cast<int>(num_particles),
                                                                   d_grid, m_nx, m_ny, m_nz,
                                                                   m_dx, m_dy, m_dz, static_cast<int>(m_transfer_scheme),
                                                                   m_xmin, m_ymin, m_zmin,
                                                                   d_active_nodes, d_num_active_nodes,
                                                                   d_material_tables);
            if (d_num_active_nodes) {
                cudaMemcpy(&m_num_active_nodes, d_num_active_nodes, sizeof(int), cudaMemcpyDeviceToHost);
                blocks_active = (m_num_active_nodes > 0 && d_active_nodes)
                              ? (m_num_active_nodes + threads_per_block - 1) / threads_per_block
                              : blocks_nodes;
            }
        }
        if (d_f_ext_fsi) {
            kernel_restore_fsi_forces<<<blocks_nodes, threads_per_block>>>(d_grid, d_f_ext_fsi, static_cast<int>(num_nodes));
        }

        kernel_grid_update_3d<<<blocks_active, threads_per_block>>>(d_grid, static_cast<int>(num_nodes), m_nx, m_ny, m_nz,
                                                                   dt, avg_p_mass,
                                                                   static_cast<int>(m_bc_x_min), static_cast<int>(m_bc_x_max),
                                                                   static_cast<int>(m_bc_y_min), static_cast<int>(m_bc_y_max),
                                                                   static_cast<int>(m_bc_z_min), static_cast<int>(m_bc_z_max),
                                                                   d_active_nodes, m_num_active_nodes);

        if (m_smooth_plastic_strain) {
            kernel_smooth_plastic_strain_3d<<<blocks_active, threads_per_block>>>(d_grid, d_grid_n, m_nx, m_ny, m_nz, d_active_nodes, m_num_active_nodes);
            kernel_copy_smoothed_plastic_strain_3d<<<blocks_active, threads_per_block>>>(d_grid, d_grid_n, static_cast<int>(num_nodes), d_active_nodes, m_num_active_nodes);
        }

        kernel_g2p_3d<<<blocks_particles, threads_per_block>>>(d_soa, static_cast<int>(num_particles),
                                                               d_grid, m_nx, m_ny, m_nz,
                                                               m_dx, m_dy, m_dz, dt, static_cast<int>(m_transfer_scheme),
                                                               static_cast<int>(m_velocity_scheme), m_flip_blend,
                                                               m_xmin, m_ymin, m_zmin,
                                                               static_cast<int>(m_bc_x_min), static_cast<int>(m_bc_x_max),
                                                               static_cast<int>(m_bc_y_min), static_cast<int>(m_bc_y_max),
                                                               static_cast<int>(m_bc_z_min), static_cast<int>(m_bc_z_max),
                                                               d_material_tables);

        kernel_stress_update_3d<<<blocks_particles, threads_per_block>>>(d_soa, static_cast<int>(num_particles), dt, d_material_tables);
    }

    // Resolve Discrete Element (DEM) Contact & Collisions on GPU
    evaluateDEMContactDevice(dt);
}

__global__ void kernel_reset_cell_heads_3d(int* cell_head, int total_cells) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx < total_cells) {
        cell_head[idx] = -1;
    }
}

__global__ void kernel_bin_particles_3d(MPMParticle3DSoA soa, int num_particles,
                                       int* cell_head, int* particle_next,
                                       int nx, int ny, int nz,
                                       float dx, float dy, float dz,
                                       float xmin, float ymin, float zmin) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= num_particles) return;

    particle_next[i] = -1;

    float px = soa.x[0][i];
    float py = soa.x[1][i];
    float pz = soa.x[2][i];

    int ci = static_cast<int>(floorf((px - xmin) / dx));
    int cj = static_cast<int>(floorf((py - ymin) / dy));
    int ck = static_cast<int>(floorf((pz - zmin) / dz));

    if (ci >= 0 && ci < nx && cj >= 0 && cj < ny && ck >= 0 && ck < nz) {
        size_t cell_idx = (static_cast<size_t>(ci) * ny + cj) * nz + ck;
        int prev = atomicExch(&cell_head[cell_idx], i);
        particle_next[i] = prev;
    }
}

__global__ void kernel_dem_contact_3d(MPMParticle3DSoA soa, int num_particles, float dt,
                                     const MPMGridNode3D* grid, int nx, int ny, int nz,
                                     float dx, float dy, float dz, float xmin, float ymin, float zmin,
                                     const MaterialTable3D* d_mat_tables,
                                     const int* cell_head, const int* particle_next) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= num_particles) return;

    bool is_dem_i = (soa.state && soa.state[i] == 1);
    if (!is_dem_i) return; // Intact continuum MPM particles are governed strictly by the Eulerian grid

    int obj_id_i = soa.object_id[i];
    const MaterialTable3D& mat_i = d_mat_tables[obj_id_i];

    float px_i = soa.x[0][i];
    float py_i = soa.x[1][i];
    float pz_i = soa.x[2][i];

    float r_i = (soa.contact_radius && soa.contact_radius[i] > 0.0f) ? soa.contact_radius[i] : 
                ((soa.lp[0][i] > 0.0f) ? soa.lp[0][i] : 0.5f * cbrtf(fmaxf(1.0e-30f, soa.V[i])));
    float m_i = fmaxf(1.0e-12f, soa.m[i]);
    float E_i = mat_i.youngs_modulus > 0.0f ? mat_i.youngs_modulus : 200.0e9f;

    float vx_i = soa.v[0][i];
    float vy_i = soa.v[1][i];
    float vz_i = soa.v[2][i];

    float fx = 0.0f, fy = 0.0f, fz = 0.0f;
    float dx_corr = 0.0f, dy_corr = 0.0f, dz_corr = 0.0f;

    int ci = static_cast<int>(floorf((px_i - xmin) / dx));
    int cj = static_cast<int>(floorf((py_i - ymin) / dy));
    int ck = static_cast<int>(floorf((pz_i - zmin) / dz));

    // Evaluate Pairwise Contact (DEM-DEM and DEM vs external intact MPM body)
    if (cell_head != nullptr && particle_next != nullptr && ci >= 0 && ci < nx && cj >= 0 && cj < ny && ck >= 0 && ck < nz) {
        for (int dix = -1; dix <= 1; ++dix) {
            int nci = ci + dix;
            if (nci < 0 || nci >= nx) continue;
            for (int diy = -1; diy <= 1; ++diy) {
                int ncj = cj + diy;
                if (ncj < 0 || ncj >= ny) continue;
                for (int diz = -1; diz <= 1; ++diz) {
                    int nck = ck + diz;
                    if (nck < 0 || nck >= nz) continue;

                    size_t n_cell = (static_cast<size_t>(nci) * ny + ncj) * nz + nck;
                    int j = cell_head[n_cell];
                    int iter = 0;
                    while (j != -1 && iter++ < 128) {
                        if (j != i) {
                            bool is_dem_j = (soa.state && soa.state[j] == 1);
                            int obj_id_j = soa.object_id[j];

                            // Valid contact: either two DEM grains, or DEM grain hitting an external intact body
                            if (is_dem_j || obj_id_i != obj_id_j) {
                                float px_j = soa.x[0][j];
                                float py_j = soa.x[1][j];
                                float pz_j = soa.x[2][j];

                                float r_j = (soa.contact_radius && soa.contact_radius[j] > 0.0f) ? soa.contact_radius[j] :
                                            ((soa.lp[0][j] > 0.0f) ? soa.lp[0][j] : 0.5f * cbrtf(fmaxf(1.0e-30f, soa.V[j])));
                                float r_sum = r_i + r_j;

                                float dx_ij = px_i - px_j;
                                float dy_ij = py_i - py_j;
                                float dz_ij = pz_i - pz_j;
                                float dist_sq = dx_ij * dx_ij + dy_ij * dy_ij + dz_ij * dz_ij;

                                if (dist_sq < r_sum * r_sum && dist_sq > 1.0e-14f) {
                                    float dist = sqrtf(dist_sq);
                                    float overlap = r_sum - dist;
                                    float nx_ij = dx_ij / dist;
                                    float ny_ij = dy_ij / dist;
                                    float nz_ij = dz_ij / dist;

                                    float vx_j = soa.v[0][j];
                                    float vy_j = soa.v[1][j];
                                    float vz_j = soa.v[2][j];

                                    float v_rel_x = vx_i - vx_j;
                                    float v_rel_y = vy_i - vy_j;
                                    float v_rel_z = vz_i - vz_j;
                                    float v_rel_n = v_rel_x * nx_ij + v_rel_y * ny_ij + v_rel_z * nz_ij;

                                    const MaterialTable3D& mat_j = d_mat_tables[obj_id_j];
                                    float E_j = mat_j.youngs_modulus > 0.0f ? mat_j.youngs_modulus : 200.0e9f;
                                    float E_eff = 2.0f * (E_i * E_j) / (E_i + E_j + 1.0f);
                                    float m_j = fmaxf(1.0e-12f, soa.m[j]);
                                    float m_eff = (m_i * m_j) / (m_i + m_j);

                                    float k_n_phys = 0.05f * E_eff * sqrtf(fmaxf(0.0001f, (r_i * r_j) / (r_i + r_j)));
                                    float k_n_stab = 0.05f * m_eff / (dt * dt + 1.0e-20f);
                                    float k_n = fminf(k_n_phys, k_n_stab);

                                    float rest = fmaxf(0.0f, fminf(1.0f, mat_i.fragment_restitution));
                                    float gamma_n = 2.0f * (1.0f - rest) * sqrtf(k_n * m_eff);

                                    float f_n = fmaxf(0.0f, k_n * overlap - gamma_n * v_rel_n);
                                    float max_fn = 0.25f * m_i * (5000.0f / dt);
                                    f_n = fminf(f_n, max_fn);

                                    float v_tx = v_rel_x - v_rel_n * nx_ij;
                                    float v_ty = v_rel_y - v_rel_n * ny_ij;
                                    float v_tz = v_rel_z - v_rel_n * nz_ij;
                                    float v_t_mag = sqrtf(v_tx * v_tx + v_ty * v_ty + v_tz * v_tz);

                                    float f_tx = 0.0f, f_ty = 0.0f, f_tz = 0.0f;
                                    if (v_t_mag > 1.0e-6f) {
                                        float mu = mat_i.fragment_contact_friction > 0.0f ? mat_i.fragment_contact_friction : 0.50f;
                                        float f_t_max = mu * f_n;
                                        float scale = fminf(f_t_max, 0.5f * k_n * v_t_mag * dt) / v_t_mag;
                                        f_tx = -scale * v_tx;
                                        f_ty = -scale * v_ty;
                                        f_tz = -scale * v_tz;
                                    }

                                    fx += f_n * nx_ij + f_tx;
                                    fy += f_n * ny_ij + f_ty;
                                    fz += f_n * nz_ij + f_tz;

                                    float mass_ratio = m_j / (m_i + m_j);
                                    float d_sep = fminf(0.5f * overlap, 0.02f * dx);
                                    dx_corr += d_sep * nx_ij * mass_ratio;
                                    dy_corr += d_sep * ny_ij * mass_ratio;
                                    dz_corr += d_sep * nz_ij * mass_ratio;
                                }
                            }
                        }
                        j = particle_next[j];
                    }
                }
            }
        }
    }

    // Resolve solid background grid boundary for DEM debris particles
    if (is_dem_i && grid && ci >= 1 && ci < nx - 2 && cj >= 1 && cj < ny - 2 && ck >= 1 && ck < nz - 2) {
        size_t n_c = (static_cast<size_t>(ci) * ny + cj) * nz + ck;
        float local_m = grid[n_c].m;
        if (local_m > 1.0e-8f) {
            float grad_mx = (grid[(static_cast<size_t>(ci+1)*ny + cj)*nz + ck].m - grid[(static_cast<size_t>(ci-1)*ny + cj)*nz + ck].m) / (2.0f * dx);
            float grad_my = (grid[(static_cast<size_t>(ci)*ny + (cj+1))*nz + ck].m - grid[(static_cast<size_t>(ci)*ny + (cj-1))*nz + ck].m) / (2.0f * dy);
            float grad_mz = (grid[(static_cast<size_t>(ci)*ny + cj)*nz + (ck+1)].m - grid[(static_cast<size_t>(ci)*ny + cj)*nz + (ck-1)].m) / (2.0f * dz);
            float g_len = sqrtf(grad_mx * grad_mx + grad_my * grad_my + grad_mz * grad_mz);
            if (g_len > 1.0e-6f) {
                float n_out_x = -grad_mx / g_len;
                float n_out_y = -grad_my / g_len;
                float n_out_z = -grad_mz / g_len;

                float v_solid_x = grid[n_c].p[0] / local_m;
                float v_solid_y = grid[n_c].p[1] / local_m;
                float v_solid_z = grid[n_c].p[2] / local_m;

                float v_rel_x = vx_i - v_solid_x;
                float v_rel_y = vy_i - v_solid_y;
                float v_rel_z = vz_i - v_solid_z;
                float v_rel_n = v_rel_x * n_out_x + v_rel_y * n_out_y + v_rel_z * n_out_z;

                if (v_rel_n < 0.0f) {
                    float k_wall = 0.20f * E_i * dx;
                    float f_wall_n = -2.0f * k_wall * v_rel_n * dt;
                    fx += f_wall_n * n_out_x;
                    fy += f_wall_n * n_out_y;
                    fz += f_wall_n * n_out_z;
                    dx_corr += 0.5f * dx * n_out_x;
                    dy_corr += 0.5f * dx * n_out_y;
                    dz_corr += 0.5f * dx * n_out_z;
                }
            }
        }
    }

    soa.v[0][i] = vx_i + dt * fx / m_i;
    soa.v[1][i] = vy_i + dt * fy / m_i;
    soa.v[2][i] = vz_i + dt * fz / m_i;

    soa.x[0][i] = px_i + dx_corr;
    soa.x[1][i] = py_i + dy_corr;
    soa.x[2][i] = pz_i + dz_corr;
}

void MPMSolver3DCUDA::evaluateDEMContactDevice(float dt) {
    if (m_host_particles.empty()) return;
    size_t num_particles = m_host_particles.size();
    size_t total_cells = static_cast<size_t>(m_nx) * m_ny * m_nz;

    int threads_per_block = 256;
    int blocks_cells = (static_cast<int>(total_cells) + threads_per_block - 1) / threads_per_block;
    int blocks_particles = (static_cast<int>(num_particles) + threads_per_block - 1) / threads_per_block;

    // Reset cell heads
    kernel_reset_cell_heads_3d<<<blocks_cells, threads_per_block>>>(d_cell_head, static_cast<int>(total_cells));

    // Bin all particles into spatial cell linked list
    kernel_bin_particles_3d<<<blocks_particles, threads_per_block>>>(
        d_soa, static_cast<int>(num_particles),
        d_cell_head, d_particle_next,
        m_nx, m_ny, m_nz,
        m_dx, m_dy, m_dz,
        m_xmin, m_ymin, m_zmin);

    // Evaluate DEM-DEM and DEM-MPM pairwise & grid contact
    kernel_dem_contact_3d<<<blocks_particles, threads_per_block>>>(
        d_soa, static_cast<int>(num_particles), dt,
        d_grid, m_nx, m_ny, m_nz,
        m_dx, m_dy, m_dz, m_xmin, m_ymin, m_zmin,
        d_material_tables,
        d_cell_head, d_particle_next);
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
    int req_qty_code = (req_qty == "velocity") ? 1 : 0;
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
        cudaMalloc(&d_telemetry_slice_buf, slice_elements * sizeof(float));
        m_allocated_slice_buf = slice_elements * sizeof(float);
    }

    int threads = 256;
    int blocks = (static_cast<int>(slice_elements) + threads - 1) / threads;
    kernel_extract_slice_3d<<<blocks, threads>>>(d_grid, d_telemetry_slice_buf, m_nx, m_ny, m_nz, axis_code, offset_idx, req_qty_code);

    out_slice.resize(slice_elements);
    cudaMemcpy(out_slice.data(), d_telemetry_slice_buf, slice_elements * sizeof(float), cudaMemcpyDeviceToHost);
}

void MPMSolver3DCUDA::seedMottGradyFragments(int obj_id) {
    if (!m_host_particles.empty() && d_soa_buffer && !m_device_dirty) {
        syncParticlesToHost();
    }
    Blast::MPMSolver3D cpu_temp;
    cpu_temp.getMaterialTables() = m_material_tables;
    cpu_temp.getParticles() = std::move(m_host_particles);
    cpu_temp.seedMottGradyFragments(obj_id);
    m_host_particles = std::move(cpu_temp.getParticles());
    m_device_dirty = true;
    syncToDevice();
}

void MPMSolver3DCUDA::step(float cfl) {
    if (m_host_particles.empty()) return;
    float dt = computeStepSize(cfl);
    if (m_step_count == 0) {
        dt = std::min(dt, 1.0e-7f);
    } else {
        dt = std::min(dt, 1.3f * (m_last_dt > 0.0f ? m_last_dt : 1.0e-7f));
    }
    m_last_cfl = cfl;
    stepWithDt(dt);
}

} // namespace Blast
