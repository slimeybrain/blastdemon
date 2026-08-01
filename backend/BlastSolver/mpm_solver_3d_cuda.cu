#include "mpm_solver_3d_cuda.hpp"
#include <cuda_runtime.h>
#include <device_launch_parameters.h>
#include <algorithm>
#include <cmath>
#include <iostream>

namespace Blast {

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

// 1. P2G Scatter Kernel
__global__ void kernel_p2g_3d(const MPMParticle3D* particles, int num_particles,
                              MPMGridNode3D* grid, int nx, int ny, int nz,
                              float dx, float dy, float dz, int transfer_scheme) {
    int p_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (p_idx >= num_particles) return;

    const MPMParticle3D& p = particles[p_idx];

    int base_i = static_cast<int>(floorf(p.x[0] / dx));
    int base_j = static_cast<int>(floorf(p.x[1] / dy));
    int base_k = static_cast<int>(floorf(p.x[2] / dz));

    float s_xx = p.sigma[0][0]; float s_yy = p.sigma[1][1]; float s_zz = p.sigma[2][2];
    float s_xy = p.sigma[0][1]; float s_yz = p.sigma[1][2]; float s_zx = p.sigma[2][0];

    float press = - (s_xx + s_yy + s_zz) / 3.0f;
    float diff_xy = s_xx - s_yy;
    float diff_yz = s_yy - s_zz;
    float diff_zx = s_zz - s_xx;
    float vm_stress = sqrtf(0.5f * (diff_xy * diff_xy + diff_yz * diff_yz + diff_zx * diff_zx) +
                            3.0f * (s_xy * s_xy + s_yz * s_yz + s_zx * s_zx));

    for (int offset_i = -1; offset_i <= 2; ++offset_i) {
        int i = base_i + offset_i;
        if (i < 0 || i >= nx) continue;
        float node_x = (static_cast<float>(i) + 0.5f) * dx;

        float Sx = (transfer_scheme == 0) ? evalGIMP_S_dev(p.x[0], node_x, dx, p.lp[0]) :
                   ((transfer_scheme == 2) ? evalBSpline_S_dev(p.x[0], node_x, dx) :
                   fmaxf(0.0f, 1.0f - fabsf(p.x[0] - node_x) / dx));

        float dSx = (transfer_scheme == 0) ? evalGIMP_dS_dev(p.x[0], node_x, dx, p.lp[0]) :
                    ((transfer_scheme == 2) ? evalBSpline_dS_dev(p.x[0], node_x, dx) :
                    (p.x[0] >= node_x ? -1.0f / dx : 1.0f / dx));

        if (fabsf(Sx) < 1.0e-7f) continue;

        for (int offset_j = -1; offset_j <= 2; ++offset_j) {
            int j = base_j + offset_j;
            if (j < 0 || j >= ny) continue;
            float node_y = (static_cast<float>(j) + 0.5f) * dy;

            float Sy = (transfer_scheme == 0) ? evalGIMP_S_dev(p.x[1], node_y, dy, p.lp[1]) :
                       ((transfer_scheme == 2) ? evalBSpline_S_dev(p.x[1], node_y, dy) :
                       fmaxf(0.0f, 1.0f - fabsf(p.x[1] - node_y) / dy));

            float dSy = (transfer_scheme == 0) ? evalGIMP_dS_dev(p.x[1], node_y, dy, p.lp[1]) :
                        ((transfer_scheme == 2) ? evalBSpline_dS_dev(p.x[1], node_y, dy) :
                        (p.x[1] >= node_y ? -1.0f / dy : 1.0f / dy));

            if (fabsf(Sy) < 1.0e-7f) continue;

            for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                int k = base_k + offset_k;
                if (k < 0 || k >= nz) continue;
                float node_z = (static_cast<float>(k) + 0.5f) * dz;

                float Sz = (transfer_scheme == 0) ? evalGIMP_S_dev(p.x[2], node_z, dz, p.lp[2]) :
                           ((transfer_scheme == 2) ? evalBSpline_S_dev(p.x[2], node_z, dz) :
                           fmaxf(0.0f, 1.0f - fabsf(p.x[2] - node_z) / dz));

                float dSz = (transfer_scheme == 0) ? evalGIMP_dS_dev(p.x[2], node_z, dz, p.lp[2]) :
                            ((transfer_scheme == 2) ? evalBSpline_dS_dev(p.x[2], node_z, dz) :
                            (p.x[2] >= node_z ? -1.0f / dz : 1.0f / dz));

                if (fabsf(Sz) < 1.0e-7f) continue;

                float weight = Sx * Sy * Sz;
                float dN_dx = dSx * Sy * Sz;
                float dN_dy = Sx * dSy * Sz;
                float dN_dz = Sx * Sy * dSz;

                size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                MPMGridNode3D* node = &grid[node_idx];

                atomicAdd(&node->m, p.m * weight);

                float dist_x = node_x - p.x[0];
                float dist_y = node_y - p.x[1];
                float dist_z = node_z - p.x[2];

                float v_apic_x = p.v[0] + (p.B[0][0] * dist_x + p.B[0][1] * dist_y + p.B[0][2] * dist_z);
                float v_apic_y = p.v[1] + (p.B[1][0] * dist_x + p.B[1][1] * dist_y + p.B[1][2] * dist_z);
                float v_apic_z = p.v[2] + (p.B[2][0] * dist_x + p.B[2][1] * dist_y + p.B[2][2] * dist_z);

                atomicAdd(&node->p[0], p.m * weight * v_apic_x);
                atomicAdd(&node->p[1], p.m * weight * v_apic_y);
                atomicAdd(&node->p[2], p.m * weight * v_apic_z);

                atomicAdd(&node->f_int[0], p.V * (p.sigma[0][0] * dN_dx + p.sigma[0][1] * dN_dy + p.sigma[0][2] * dN_dz));
                atomicAdd(&node->f_int[1], p.V * (p.sigma[1][0] * dN_dx + p.sigma[1][1] * dN_dy + p.sigma[1][2] * dN_dz));
                atomicAdd(&node->f_int[2], p.V * (p.sigma[2][0] * dN_dx + p.sigma[2][1] * dN_dy + p.sigma[2][2] * dN_dz));

                atomicAdd(&node->von_mises, p.m * weight * vm_stress);
                atomicAdd(&node->plastic_strain, p.m * weight * p.ep_bar);
                atomicAdd(&node->density, p.m * weight * p.density);
                atomicAdd(&node->pressure, p.m * weight * press);
                atomicAdd(&node->damage, p.m * weight * p.damage);
            }
        }
    }
}

// 2. Grid Kinematics Kernel
__global__ void kernel_grid_update_3d(MPMGridNode3D* grid, int num_nodes, int nx, int ny, int nz,
                                     float dt, float avg_p_mass,
                                     int bc_x_min, int bc_x_max,
                                     int bc_y_min, int bc_y_max,
                                     int bc_z_min, int bc_z_max) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_nodes) return;

    MPMGridNode3D& node = grid[idx];
    if (node.m <= 1.0e-8f) return;

    // Normalize telemetry scalars
    node.von_mises /= node.m;
    node.plastic_strain /= node.m;
    node.density /= node.m;
    node.pressure /= node.m;
    node.damage /= node.m;

    node.v[0] = node.p[0] / node.m;
    node.v[1] = node.p[1] / node.m;
    node.v[2] = node.p[2] / node.m;

    float f_tot_x = node.f_ext[0] - node.f_int[0];
    float f_tot_y = node.f_ext[1] - node.f_int[1];
    float f_tot_z = node.f_ext[2] - node.f_int[2];

    float m_eff_floor = 0.25f * avg_p_mass;
    float m_eff = fmaxf(node.m, m_eff_floor);

    node.v[0] += dt * (f_tot_x / m_eff);
    node.v[1] += dt * (f_tot_y / m_eff);
    node.v[2] += dt * (f_tot_z / m_eff);

    node.v[0] = fminf(fmaxf(node.v[0], -5000.0f), 5000.0f);
    node.v[1] = fminf(fmaxf(node.v[1], -5000.0f), 5000.0f);
    node.v[2] = fminf(fmaxf(node.v[2], -5000.0f), 5000.0f);

    // Unpack 3D indices
    int k = idx % nz;
    int j = (idx / nz) % ny;
    int i = idx / (ny * nz);

    if ((i == 0 && bc_x_min == 0) || (i == nx - 1 && bc_x_max == 0)) {
        node.v[0] = 0.0f; node.v[1] = 0.0f; node.v[2] = 0.0f;
    } else if ((i == 0 && bc_x_min == 1) || (i == nx - 1 && bc_x_max == 1)) {
        node.v[0] = 0.0f;
    }

    if ((j == 0 && bc_y_min == 0) || (j == ny - 1 && bc_y_max == 0)) {
        node.v[0] = 0.0f; node.v[1] = 0.0f; node.v[2] = 0.0f;
    } else if ((j == 0 && bc_y_min == 1) || (j == ny - 1 && bc_y_max == 1)) {
        node.v[1] = 0.0f;
    }

    if ((k == 0 && bc_z_min == 0) || (k == nz - 1 && bc_z_max == 0)) {
        node.v[0] = 0.0f; node.v[1] = 0.0f; node.v[2] = 0.0f;
    } else if ((k == 0 && bc_z_min == 1) || (k == nz - 1 && bc_z_max == 1)) {
        node.v[2] = 0.0f;
    }
}

// 3. G2P Gather Kernel
__global__ void kernel_g2p_3d(MPMParticle3D* particles, int num_particles,
                              const MPMGridNode3D* grid, int nx, int ny, int nz,
                              float dx, float dy, float dz, float dt, int transfer_scheme) {
    int p_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (p_idx >= num_particles) return;

    MPMParticle3D& p = particles[p_idx];

    int base_i = static_cast<int>(floorf(p.x[0] / dx));
    int base_j = static_cast<int>(floorf(p.x[1] / dy));
    int base_k = static_cast<int>(floorf(p.x[2] / dz));

    float v_pic_x = 0.0f; float v_pic_y = 0.0f; float v_pic_z = 0.0f;
    float weight_sum = 0.0f;

    for (int offset_i = -1; offset_i <= 2; ++offset_i) {
        int i = base_i + offset_i;
        if (i < 0 || i >= nx) continue;
        float node_x = (static_cast<float>(i) + 0.5f) * dx;

        float Sx = (transfer_scheme == 0) ? evalGIMP_S_dev(p.x[0], node_x, dx, p.lp[0]) :
                   ((transfer_scheme == 2) ? evalBSpline_S_dev(p.x[0], node_x, dx) :
                   fmaxf(0.0f, 1.0f - fabsf(p.x[0] - node_x) / dx));

        if (fabsf(Sx) < 1.0e-7f) continue;

        for (int offset_j = -1; offset_j <= 2; ++offset_j) {
            int j = base_j + offset_j;
            if (j < 0 || j >= ny) continue;
            float node_y = (static_cast<float>(j) + 0.5f) * dy;

            float Sy = (transfer_scheme == 0) ? evalGIMP_S_dev(p.x[1], node_y, dy, p.lp[1]) :
                       ((transfer_scheme == 2) ? evalBSpline_S_dev(p.x[1], node_y, dy) :
                       fmaxf(0.0f, 1.0f - fabsf(p.x[1] - node_y) / dy));

            if (fabsf(Sy) < 1.0e-7f) continue;

            for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                int k = base_k + offset_k;
                if (k < 0 || k >= nz) continue;
                float node_z = (static_cast<float>(k) + 0.5f) * dz;

                float Sz = (transfer_scheme == 0) ? evalGIMP_S_dev(p.x[2], node_z, dz, p.lp[2]) :
                           ((transfer_scheme == 2) ? evalBSpline_S_dev(p.x[2], node_z, dz) :
                           fmaxf(0.0f, 1.0f - fabsf(p.x[2] - node_z) / dz));

                if (fabsf(Sz) < 1.0e-7f) continue;

                float weight = Sx * Sy * Sz;
                size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                const MPMGridNode3D& node = grid[node_idx];

                if (node.m > 1.0e-8f) {
                    v_pic_x += weight * node.v[0];
                    v_pic_y += weight * node.v[1];
                    v_pic_z += weight * node.v[2];
                    weight_sum += weight;
                }
            }
        }
    }

    if (weight_sum > 1.0e-7f) {
        v_pic_x /= weight_sum; v_pic_y /= weight_sum; v_pic_z /= weight_sum;
    } else {
        v_pic_x = p.v[0]; v_pic_y = p.v[1]; v_pic_z = p.v[2];
    }

    // APIC B_p computation
    float D_inv_x = 3.0f / (dx * dx);
    float D_inv_y = 3.0f / (dy * dy);
    float D_inv_z = 3.0f / (dz * dz);
    float max_B = 5000.0f / fminf(fminf(dx, dy), dz);

    float B_new[3][3] = {{0,0,0},{0,0,0},{0,0,0}};

    for (int offset_i = -1; offset_i <= 2; ++offset_i) {
        int i = base_i + offset_i;
        if (i < 0 || i >= nx) continue;
        float node_x = (static_cast<float>(i) + 0.5f) * dx;

        float Sx = (transfer_scheme == 0) ? evalGIMP_S_dev(p.x[0], node_x, dx, p.lp[0]) :
                   ((transfer_scheme == 2) ? evalBSpline_S_dev(p.x[0], node_x, dx) :
                   fmaxf(0.0f, 1.0f - fabsf(p.x[0] - node_x) / dx));

        if (fabsf(Sx) < 1.0e-7f) continue;

        for (int offset_j = -1; offset_j <= 2; ++offset_j) {
            int j = base_j + offset_j;
            if (j < 0 || j >= ny) continue;
            float node_y = (static_cast<float>(j) + 0.5f) * dy;

            float Sy = (transfer_scheme == 0) ? evalGIMP_S_dev(p.x[1], node_y, dy, p.lp[1]) :
                       ((transfer_scheme == 2) ? evalBSpline_S_dev(p.x[1], node_y, dy) :
                       fmaxf(0.0f, 1.0f - fabsf(p.x[1] - node_y) / dy));

            if (fabsf(Sy) < 1.0e-7f) continue;

            for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                int k = base_k + offset_k;
                if (k < 0 || k >= nz) continue;
                float node_z = (static_cast<float>(k) + 0.5f) * dz;

                float Sz = (transfer_scheme == 0) ? evalGIMP_S_dev(p.x[2], node_z, dz, p.lp[2]) :
                           ((transfer_scheme == 2) ? evalBSpline_S_dev(p.x[2], node_z, dz) :
                           fmaxf(0.0f, 1.0f - fabsf(p.x[2] - node_z) / dz));

                if (fabsf(Sz) < 1.0e-7f) continue;

                float weight = Sx * Sy * Sz;
                size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                const MPMGridNode3D& node = grid[node_idx];

                if (node.m > 1.0e-8f) {
                    float dist_x = node_x - p.x[0];
                    float dist_y = node_y - p.x[1];
                    float dist_z = node_z - p.x[2];

                    float rel_vx = node.v[0] - v_pic_x;
                    float rel_vy = node.v[1] - v_pic_y;
                    float rel_vz = node.v[2] - v_pic_z;

                    B_new[0][0] += weight * rel_vx * dist_x * D_inv_x;
                    B_new[0][1] += weight * rel_vx * dist_y * D_inv_y;
                    B_new[0][2] += weight * rel_vx * dist_z * D_inv_z;

                    B_new[1][0] += weight * rel_vy * dist_x * D_inv_x;
                    B_new[1][1] += weight * rel_vy * dist_y * D_inv_y;
                    B_new[1][2] += weight * rel_vy * dist_z * D_inv_z;

                    B_new[2][0] += weight * rel_vz * dist_x * D_inv_x;
                    B_new[2][1] += weight * rel_vz * dist_y * D_inv_y;
                    B_new[2][2] += weight * rel_vz * dist_z * D_inv_z;
                }
            }
        }
    }

    p.v[0] = fminf(fmaxf(v_pic_x, -5000.0f), 5000.0f);
    p.v[1] = fminf(fmaxf(v_pic_y, -5000.0f), 5000.0f);
    p.v[2] = fminf(fmaxf(v_pic_z, -5000.0f), 5000.0f);

    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            p.B[r][c] = fminf(fmaxf(B_new[r][c], -max_B), max_B);
        }
    }

    p.x[0] += dt * p.v[0];
    p.x[1] += dt * p.v[1];
    p.x[2] += dt * p.v[2];

    float min_x = 1.5f * dx; float max_x = (static_cast<float>(nx) - 1.5f) * dx;
    float min_y = 1.5f * dy; float max_y = (static_cast<float>(ny) - 1.5f) * dy;
    float min_z = 1.5f * dz; float max_z = (static_cast<float>(nz) - 1.5f) * dz;

    if (p.x[0] < min_x) { p.x[0] = min_x; if (p.v[0] < 0) p.v[0] = 0; }
    else if (p.x[0] > max_x) { p.x[0] = max_x; if (p.v[0] > 0) p.v[0] = 0; }

    if (p.x[1] < min_y) { p.x[1] = min_y; if (p.v[1] < 0) p.v[1] = 0; }
    else if (p.x[1] > max_y) { p.x[1] = max_y; if (p.v[1] > 0) p.v[1] = 0; }

    if (p.x[2] < min_z) { p.x[2] = min_z; if (p.v[2] < 0) p.v[2] = 0; }
    else if (p.x[2] > max_z) { p.x[2] = max_z; if (p.v[2] > 0) p.v[2] = 0; }
}

// 4. Stress Update Kernel
__global__ void kernel_stress_update_3d(MPMParticle3D* particles, int num_particles, float dt) {
    int p_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (p_idx >= num_particles) return;

    MPMParticle3D& p = particles[p_idx];

    float L[3][3];
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            L[r][c] = p.B[r][c];
        }
    }

    float deps[3][3];
    float W[3][3];
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            deps[r][c] = 0.5f * (L[r][c] + L[c][r]) * dt;
            W[r][c] = 0.5f * (L[r][c] - L[c][r]);
        }
    }

    float W_sig[3][3] = {{0,0,0},{0,0,0},{0,0,0}};
    float sig_W[3][3] = {{0,0,0},{0,0,0},{0,0,0}};
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            for (int k = 0; k < 3; ++k) {
                W_sig[r][c] += W[r][k] * p.sigma[k][c];
                sig_W[r][c] += p.sigma[r][k] * W[k][c];
            }
        }
    }

    float sig_base[3][3];
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            sig_base[r][c] = p.sigma[r][c] + (W_sig[r][c] - sig_W[r][c]) * dt;
        }
    }

    float E = p.youngs_modulus;
    float nu = p.poissons_ratio;
    float mu = E / (2.0f * (1.0f + nu));
    float lambda = (E * nu) / ((1.0f + nu) * (1.0f - 2.0f * nu));
    float tr_deps = deps[0][0] + deps[1][1] + deps[2][2];

    float sig_trial[3][3];
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            sig_trial[r][c] = sig_base[r][c] + 2.0f * mu * deps[r][c];
            if (r == c) sig_trial[r][c] += lambda * tr_deps;
        }
    }

    float press = - (sig_trial[0][0] + sig_trial[1][1] + sig_trial[2][2]) / 3.0f;
    float s[3][3];
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            s[r][c] = sig_trial[r][c];
            if (r == c) s[r][c] += press;
        }
    }

    float s_s = 0.0f;
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            s_s += s[r][c] * s[r][c];
        }
    }
    float q_trial = sqrtf(1.5f * s_s);
    float yield_surf = q_trial - (p.yield_stress + p.hardening_modulus * p.ep_bar);

    if (q_trial > 1.0e-5f && yield_surf > 0.0f) {
        float delta_ep = yield_surf / (3.0f * mu + p.hardening_modulus);
        float scale = 1.0f - (3.0f * mu * delta_ep) / q_trial;
        if (scale < 0.0f) scale = 0.0f;

        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                p.sigma[r][c] = scale * s[r][c];
                if (r == c) p.sigma[r][c] -= press;
            }
        }
        p.ep_bar += delta_ep;
    } else {
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                p.sigma[r][c] = sig_trial[r][c];
            }
        }
    }

    float d_plastic = 0.0f;
    if (p.failure_strain > 0.0f) {
        d_plastic = fminf(fmaxf(p.ep_bar / p.failure_strain, 0.0f), 1.0f);
    }

    float curr_press = - (p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
    float tensile_stress = -curr_press;
    float d_tensile = 0.0f;
    if (tensile_stress > 0.0f && p.tensile_failure_stress > 0.0f) {
        d_tensile = fminf(fmaxf(tensile_stress / p.tensile_failure_stress, 0.0f), 1.0f);
    }

    p.damage = fmaxf(p.damage, fmaxf(d_plastic, d_tensile));
    if (p.damage >= 1.0f) {
        p.has_failed = true;
        p.damage = 1.0f;
    }

    float soft_factor = fmaxf(0.0f, 1.0f - p.damage);
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            p.sigma[r][c] *= soft_factor;
        }
    }

    p.V = fminf(fmaxf(p.V * (1.0f + tr_deps), 0.1f * p.V0), 10.0f * p.V0);
}

// MPMSolver3DCUDA Implementation
MPMSolver3DCUDA::MPMSolver3DCUDA() {}

MPMSolver3DCUDA::~MPMSolver3DCUDA() {
    freeDeviceMemory();
}

void MPMSolver3DCUDA::allocateDeviceMemory() {
    size_t num_grid_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
    size_t num_particles = m_host_particles.size();

    if (num_grid_nodes > m_allocated_grid_nodes) {
        if (d_grid) cudaFree(d_grid);
        cudaMalloc(&d_grid, num_grid_nodes * sizeof(MPMGridNode3D));
        m_allocated_grid_nodes = num_grid_nodes;
    }

    if (num_particles > m_allocated_particles) {
        if (d_particles) cudaFree(d_particles);
        cudaMalloc(&d_particles, num_particles * sizeof(MPMParticle3D));
        m_allocated_particles = num_particles;
    }
}

void MPMSolver3DCUDA::freeDeviceMemory() {
    if (d_grid) { cudaFree(d_grid); d_grid = nullptr; }
    if (d_particles) { cudaFree(d_particles); d_particles = nullptr; }
    m_allocated_grid_nodes = 0;
    m_allocated_particles = 0;
}

void MPMSolver3DCUDA::initializeGrid(int nx, int ny, int nz, float dx, float dy, float dz) {
    m_nx = nx; m_ny = ny; m_nz = nz;
    m_dx = dx; m_dy = dy; m_dz = dz;

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
                                   float tensile_failure_stress, int ppc) {
    MPMSolver3D cpu_solver;
    cpu_solver.initializeGrid(m_nx, m_ny, m_nz, m_dx, m_dy, m_dz);
    cpu_solver.addBoxObject(obj_id, pos_x, pos_y, pos_z, size_x, size_y, size_z,
                            vel_x, vel_y, vel_z, angular_vel_x, angular_vel_y, angular_vel_z,
                            density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
    m_host_particles.insert(m_host_particles.end(), cpu_solver.getParticles().begin(), cpu_solver.getParticles().end());
    m_device_dirty = true;
}

void MPMSolver3DCUDA::addSphereObject(int obj_id, float pos_x, float pos_y, float pos_z, float radius,
                                      float vel_x, float vel_y, float vel_z,
                                      float angular_vel_x, float angular_vel_y, float angular_vel_z,
                                      float density, float E, float nu,
                                      float yield_stress, float hardening, float failure_strain,
                                      float tensile_failure_stress, int ppc) {
    MPMSolver3D cpu_solver;
    cpu_solver.initializeGrid(m_nx, m_ny, m_nz, m_dx, m_dy, m_dz);
    cpu_solver.addSphereObject(obj_id, pos_x, pos_y, pos_z, radius,
                               vel_x, vel_y, vel_z, angular_vel_x, angular_vel_y, angular_vel_z,
                               density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
    m_host_particles.insert(m_host_particles.end(), cpu_solver.getParticles().begin(), cpu_solver.getParticles().end());
    m_device_dirty = true;
}

void MPMSolver3DCUDA::syncToDevice() {
    allocateDeviceMemory();
    if (!m_host_particles.empty()) {
        cudaMemcpy(d_particles, m_host_particles.data(), m_host_particles.size() * sizeof(MPMParticle3D), cudaMemcpyHostToDevice);
    }
    size_t num_grid_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
    cudaMemset(d_grid, 0, num_grid_nodes * sizeof(MPMGridNode3D));
    m_device_dirty = false;
}

void MPMSolver3DCUDA::syncToHost() {
    if (!m_host_particles.empty()) {
        cudaMemcpy(m_host_particles.data(), d_particles, m_host_particles.size() * sizeof(MPMParticle3D), cudaMemcpyDeviceToHost);
    }
    size_t num_grid_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
    m_host_grid.resize(num_grid_nodes);
    cudaMemcpy(m_host_grid.data(), d_grid, num_grid_nodes * sizeof(MPMGridNode3D), cudaMemcpyDeviceToHost);
}

float MPMSolver3DCUDA::computeStepSize(float cfl) {
    if (m_host_particles.empty()) return 1.0e-6f;
    float max_speed = 100.0f;
    for (const auto& p : m_host_particles) {
        float E = p.youngs_modulus;
        float rho = std::max(10.0f, p.density);
        float c_s = std::sqrt(E / rho);
        float v_mag = std::sqrt(p.v[0] * p.v[0] + p.v[1] * p.v[1] + p.v[2] * p.v[2]);
        max_speed = std::max(max_speed, c_s + v_mag);
    }
    float min_h = std::min({m_dx, m_dy, m_dz});
    return std::max(1.0e-8f, cfl * (min_h / max_speed));
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

    if (run_p2g) {
        cudaMemset(d_grid, 0, num_nodes * sizeof(MPMGridNode3D));
        kernel_p2g_3d<<<blocks_particles, threads_per_block>>>(d_particles, static_cast<int>(num_particles),
                                                              d_grid, m_nx, m_ny, m_nz,
                                                              m_dx, m_dy, m_dz, static_cast<int>(m_transfer_scheme));
    }

    float avg_p_mass = m_host_particles.empty() ? 0.001f : m_host_particles[0].m;

    kernel_grid_update_3d<<<blocks_nodes, threads_per_block>>>(d_grid, static_cast<int>(num_nodes), m_nx, m_ny, m_nz,
                                                               dt, avg_p_mass,
                                                               static_cast<int>(m_bc_x_min), static_cast<int>(m_bc_x_max),
                                                               static_cast<int>(m_bc_y_min), static_cast<int>(m_bc_y_max),
                                                               static_cast<int>(m_bc_z_min), static_cast<int>(m_bc_z_max));

    kernel_g2p_3d<<<blocks_particles, threads_per_block>>>(d_particles, static_cast<int>(num_particles),
                                                           d_grid, m_nx, m_ny, m_nz,
                                                           m_dx, m_dy, m_dz, dt, static_cast<int>(m_transfer_scheme));

    kernel_stress_update_3d<<<blocks_particles, threads_per_block>>>(d_particles, static_cast<int>(num_particles), dt);

    cudaDeviceSynchronize();
}

void MPMSolver3DCUDA::step(float cfl) {
    if (m_host_particles.empty()) return;
    float dt = computeStepSize(cfl);
    m_last_cfl = cfl;
    stepWithDt(dt);
}

} // namespace Blast
