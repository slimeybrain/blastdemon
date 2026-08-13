#include "fem_solver_3d_cuda.hpp"
#include "fem_contact_3d.hpp"
#include <cuda_runtime.h>
#include <device_launch_parameters.h>
#include <cmath>

namespace Blast {

// Double precision atomicAdd helper if needed for older compute architectures
#if __CUDA_ARCH__ < 600
__device__ double atomicAdd(double* address, double val) {
    unsigned long long int* address_as_ull = (unsigned long long int*)address;
    unsigned long long int old = *address_as_ull, assumed;
    do {
        assumed = old;
        old = atomicCAS(address_as_ull, assumed,
                        __double_as_longlong(val + __longlong_as_double(assumed)));
    } while (assumed != old);
    return __longlong_as_double(old);
}
#endif

// CUDA Kernel: 1. Half-Step Nodal Velocity & Position Update (2nd-Order Velocity-Verlet)
template <typename T>
__global__ void fem_nodal_half_step_kernel_3d_device(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    T dt
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_nodes) return;

    FEMNode3D<T>& node = d_nodes[idx];
    if (node.m <= static_cast<T>(1.0e-12f) || node.is_eroded) return;

    for (int c = 0; c < 3; ++c) {
        if (node.is_fixed[c]) {
            node.v[c] = static_cast<T>(0.0f);
            node.a[c] = static_cast<T>(0.0f);
            continue;
        }

        T v_h = node.v[c] + static_cast<T>(0.5f) * node.a[c] * dt;
        node.x[c] += v_h * dt;
        node.v[c] = v_h; // Stores v^{n+1/2} temporarily
    }
}

// CUDA Kernel: Compute Hex8 Element Stresses, Hourglass Forces, and Atomic Nodal Force Assembly
template <typename T>
__global__ void fem_element_forces_kernel_3d_device(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    FEMElement3D<T>* d_elements,
    int num_elements,
    const MaterialTable3D* d_materials,
    BlastPhysicsParams<T> physics_params,
    T dt,
    T hourglass_coeff,
    FEMHourglassModel hg_model,
    FEMIntegrationScheme integration_scheme
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_elements) return;

    FEMElement3D<T>& elem = d_elements[idx];
    if (elem.is_eroded) return;

    const MaterialTable3D& mat = d_materials[elem.mat_id];
    T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 210.0e9f);
    T nu = static_cast<T>(mat.poissons_ratio);
    T G = E / (static_cast<T>(2.0f) * (static_cast<T>(1.0f) + nu));
    T K = E / (static_cast<T>(3.0f) * (static_cast<T>(1.0f) - static_cast<T>(2.0f) * nu));
    T density = static_cast<T>(mat.density > 0.0f ? mat.density : 7850.0f);

    // Gather nodal positions and velocities
    T x_nodes[8][3], v_nodes[8][3];
    for (int n = 0; n < 8; ++n) {
        int nid = elem.node_ids[n];
        for (int c = 0; c < 3; ++c) {
            x_nodes[n][c] = d_nodes[nid].x[c];
            v_nodes[n][c] = d_nodes[nid].v[c];
        }
    }

    // Subtract element centroids to preserve precision in single-precision floating point
    T x_center[3] = {0.0f, 0.0f, 0.0f};
    T v_center[3] = {0.0f, 0.0f, 0.0f};
    for (int n = 0; n < 8; ++n) {
        x_center[0] += x_nodes[n][0]; x_center[1] += x_nodes[n][1]; x_center[2] += x_nodes[n][2];
        v_center[0] += v_nodes[n][0]; v_center[1] += v_nodes[n][1]; v_center[2] += v_nodes[n][2];
    }
    x_center[0] *= static_cast<T>(0.125f); x_center[1] *= static_cast<T>(0.125f); x_center[2] *= static_cast<T>(0.125f);
    v_center[0] *= static_cast<T>(0.125f); v_center[1] *= static_cast<T>(0.125f); v_center[2] *= static_cast<T>(0.125f);

    T x_mid[8][3];
    for (int n = 0; n < 8; ++n) {
        for (int c = 0; c < 3; ++c) {
            x_mid[n][c] = x_nodes[n][c] - static_cast<T>(0.5f) * v_nodes[n][c] * dt;
        }
    }

    T x_center_mid[3] = {0.0f, 0.0f, 0.0f};
    for (int n = 0; n < 8; ++n) {
        x_center_mid[0] += x_mid[n][0]; x_center_mid[1] += x_mid[n][1]; x_center_mid[2] += x_mid[n][2];
    }
    x_center_mid[0] *= static_cast<T>(0.125f); x_center_mid[1] *= static_cast<T>(0.125f); x_center_mid[2] *= static_cast<T>(0.125f);

    T x_rel[8][3], v_rel[8][3];
    for (int n = 0; n < 8; ++n) {
        for (int c = 0; c < 3; ++c) {
            x_rel[n][c] = x_mid[n][c] - x_center_mid[c];
            v_rel[n][c] = v_nodes[n][c] - v_center[c];
        }
    }

    // Hex8 Center Shape Function Derivatives dN_dxi
    T dN_dxi[8][3];
    static const float HEX8_XI_CUDA[8][3] = {
        {-1.0f, -1.0f, -1.0f}, { 1.0f, -1.0f, -1.0f}, { 1.0f,  1.0f, -1.0f}, {-1.0f,  1.0f, -1.0f},
        {-1.0f, -1.0f,  1.0f}, { 1.0f, -1.0f,  1.0f}, { 1.0f,  1.0f,  1.0f}, {-1.0f,  1.0f,  1.0f}
    };

    for (int i = 0; i < 8; ++i) {
        dN_dxi[i][0] = 0.125f * HEX8_XI_CUDA[i][0];
        dN_dxi[i][1] = 0.125f * HEX8_XI_CUDA[i][1];
        dN_dxi[i][2] = 0.125f * HEX8_XI_CUDA[i][2];
    }

    T min_vol_r = static_cast<T>(mat.timestep_erosion_factor > 0.0f ? mat.timestep_erosion_factor : 0.05f);
    T cs_C = physics_params.cowper_symonds_C;
    T cs_P = physics_params.cowper_symonds_P;
    T b1 = static_cast<T>(mat.bulk_viscosity_b1 > 0.0f ? mat.bulk_viscosity_b1 : physics_params.bulk_viscosity_b1);
    T b2 = static_cast<T>(mat.bulk_viscosity_b2 > 0.0f ? mat.bulk_viscosity_b2 : physics_params.bulk_viscosity_b2);
    T cd = sqrt((K + static_cast<T>(4.0f) / static_cast<T>(3.0f) * G) / density);

    if (integration_scheme == FEMIntegrationScheme::FullGauss8 || integration_scheme == FEMIntegrationScheme::SelectiveReduced) {
        const T gp_coords[8][3] = {
            {static_cast<T>(-0.5773502691896257), static_cast<T>(-0.5773502691896257), static_cast<T>(-0.5773502691896257)},
            {static_cast<T>( 0.5773502691896257), static_cast<T>(-0.5773502691896257), static_cast<T>(-0.5773502691896257)},
            {static_cast<T>( 0.5773502691896257), static_cast<T>( 0.5773502691896257), static_cast<T>(-0.5773502691896257)},
            {static_cast<T>(-0.5773502691896257), static_cast<T>( 0.5773502691896257), static_cast<T>(-0.5773502691896257)},
            {static_cast<T>(-0.5773502691896257), static_cast<T>(-0.5773502691896257), static_cast<T>( 0.5773502691896257)},
            {static_cast<T>( 0.5773502691896257), static_cast<T>(-0.5773502691896257), static_cast<T>( 0.5773502691896257)},
            {static_cast<T>( 0.5773502691896257), static_cast<T>( 0.5773502691896257), static_cast<T>( 0.5773502691896257)},
            {static_cast<T>(-0.5773502691896257), static_cast<T>( 0.5773502691896257), static_cast<T>( 0.5773502691896257)}
        };

        T dN_dxi_center[8][3];
        for (int i = 0; i < 8; ++i) {
            dN_dxi_center[i][0] = 0.125f * HEX8_XI_CUDA[i][0];
            dN_dxi_center[i][1] = 0.125f * HEX8_XI_CUDA[i][1];
            dN_dxi_center[i][2] = 0.125f * HEX8_XI_CUDA[i][2];
        }

        T J_center[3][3] = {{0.0f}};
        for (int i = 0; i < 8; ++i) {
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    J_center[r][c] += dN_dxi_center[i][r] * x_rel[i][c];
                }
            }
        }

        T detJ_center = J_center[0][0] * (J_center[1][1]*J_center[2][2] - J_center[1][2]*J_center[2][1])
                      - J_center[0][1] * (J_center[1][0]*J_center[2][2] - J_center[1][2]*J_center[2][0])
                      + J_center[0][2] * (J_center[1][0]*J_center[2][1] - J_center[1][1]*J_center[2][0]);

        if (detJ_center <= static_cast<T>(1.0e-15f) || (elem.V0 > static_cast<T>(1.0e-18f) && (detJ_center * static_cast<T>(8.0f) / elem.V0) <= min_vol_r)) {
            elem.is_eroded = true;
            return;
        }
        elem.V = detJ_center * static_cast<T>(8.0f);

        T div_v_center = 0.0f;
        if (integration_scheme == FEMIntegrationScheme::SelectiveReduced) {
            T invDetJ_center = static_cast<T>(1.0f) / detJ_center;
            T J_inv_center[3][3];
            J_inv_center[0][0] = (J_center[1][1]*J_center[2][2] - J_center[1][2]*J_center[2][1]) * invDetJ_center;
            J_inv_center[0][1] = (J_center[0][2]*J_center[2][1] - J_center[0][1]*J_center[2][2]) * invDetJ_center;
            J_inv_center[0][2] = (J_center[0][1]*J_center[1][2] - J_center[0][2]*J_center[1][1]) * invDetJ_center;
            J_inv_center[1][0] = (J_center[1][2]*J_center[2][0] - J_center[1][0]*J_center[2][2]) * invDetJ_center;
            J_inv_center[1][1] = (J_center[0][0]*J_center[2][2] - J_center[0][2]*J_center[2][0]) * invDetJ_center;
            J_inv_center[1][2] = (J_center[0][2]*J_center[1][0] - J_center[0][0]*J_center[1][2]) * invDetJ_center;
            J_inv_center[2][0] = (J_center[1][0]*J_center[2][1] - J_center[1][1]*J_center[2][0]) * invDetJ_center;
            J_inv_center[2][1] = (J_center[0][1]*J_center[2][0] - J_center[0][0]*J_center[2][1]) * invDetJ_center;
            J_inv_center[2][2] = (J_center[0][0]*J_center[1][1] - J_center[0][1]*J_center[1][0]) * invDetJ_center;

            T dN_dx_center[8][3];
            for (int i = 0; i < 8; ++i) {
                for (int c = 0; c < 3; ++c) {
                    dN_dx_center[i][c] = J_inv_center[c][0] * dN_dxi_center[i][0] + J_inv_center[c][1] * dN_dxi_center[i][1] + J_inv_center[c][2] * dN_dxi_center[i][2];
                }
            }

            T strain_rate_center[3] = {0.0f, 0.0f, 0.0f};
            for (int i = 0; i < 8; ++i) {
                strain_rate_center[0] += dN_dx_center[i][0] * v_rel[i][0];
                strain_rate_center[1] += dN_dx_center[i][1] * v_rel[i][1];
                strain_rate_center[2] += dN_dx_center[i][2] * v_rel[i][2];
            }
            div_v_center = strain_rate_center[0] + strain_rate_center[1] + strain_rate_center[2];
            if (fabs(div_v_center) * dt < static_cast<T>(1.0e-6f)) {
                div_v_center = static_cast<T>(0.0f);
            }
        }

        T sigma_avg[3][3] = {{0.0f}};
        T s_dev_avg[3][3] = {{0.0f}};
        T ep_bar_avg = 0.0f;
        T temp_avg = 0.0f;
        T damage_avg = 0.0f;
        T V_sum = 0.0f;

        for (int g = 0; g < 8; ++g) {
            T dN_dxi_g[8][3];
            T xi = gp_coords[g][0];
            T eta = gp_coords[g][1];
            T zeta = gp_coords[g][2];
            for (int i = 0; i < 8; ++i) {
                dN_dxi_g[i][0] = 0.125f * HEX8_XI_CUDA[i][0] * (1.0f + HEX8_XI_CUDA[i][1] * eta) * (1.0f + HEX8_XI_CUDA[i][2] * zeta);
                dN_dxi_g[i][1] = 0.125f * HEX8_XI_CUDA[i][1] * (1.0f + HEX8_XI_CUDA[i][0] * xi)  * (1.0f + HEX8_XI_CUDA[i][2] * zeta);
                dN_dxi_g[i][2] = 0.125f * HEX8_XI_CUDA[i][2] * (1.0f + HEX8_XI_CUDA[i][0] * xi)  * (1.0f + HEX8_XI_CUDA[i][1] * eta);
            }

            T J_g[3][3] = {{0.0f}};
            for (int i = 0; i < 8; ++i) {
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        J_g[r][c] += dN_dxi_g[i][r] * x_rel[i][c];
                    }
                }
            }

            T detJ_g = J_g[0][0] * (J_g[1][1]*J_g[2][2] - J_g[1][2]*J_g[2][1])
                     - J_g[0][1] * (J_g[1][0]*J_g[2][2] - J_g[1][2]*J_g[2][0])
                     + J_g[0][2] * (J_g[1][0]*J_g[2][1] - J_g[1][1]*J_g[2][0]);

            if (detJ_g <= static_cast<T>(1.0e-15f)) {
                elem.is_eroded = true;
                return;
            }
            V_sum += detJ_g;
            T invDetJ_g = static_cast<T>(1.0f) / detJ_g;

            T J_inv_g[3][3];
            J_inv_g[0][0] = (J_g[1][1]*J_g[2][2] - J_g[1][2]*J_g[2][1]) * invDetJ_g;
            J_inv_g[0][1] = (J_g[0][2]*J_g[2][1] - J_g[0][1]*J_g[2][2]) * invDetJ_g;
            J_inv_g[0][2] = (J_g[0][1]*J_g[1][2] - J_g[0][2]*J_g[1][1]) * invDetJ_g;
            J_inv_g[1][0] = (J_g[1][2]*J_g[2][0] - J_g[1][0]*J_g[2][2]) * invDetJ_g;
            J_inv_g[1][1] = (J_g[0][0]*J_g[2][2] - J_g[0][2]*J_g[2][0]) * invDetJ_g;
            J_inv_g[1][2] = (J_g[0][2]*J_g[1][0] - J_g[0][0]*J_g[1][2]) * invDetJ_g;
            J_inv_g[2][0] = (J_g[1][0]*J_g[2][1] - J_g[1][1]*J_g[2][0]) * invDetJ_g;
            J_inv_g[2][1] = (J_g[0][1]*J_g[2][0] - J_g[0][0]*J_g[2][1]) * invDetJ_g;
            J_inv_g[2][2] = (J_g[0][0]*J_g[1][1] - J_g[0][1]*J_g[1][0]) * invDetJ_g;

            T dN_dx_g[8][3];
            for (int i = 0; i < 8; ++i) {
                for (int c = 0; c < 3; ++c) {
                    dN_dx_g[i][c] = J_inv_g[c][0] * dN_dxi_g[i][0] + J_inv_g[c][1] * dN_dxi_g[i][1] + J_inv_g[c][2] * dN_dxi_g[i][2];
                }
            }

            T strain_rate_g[6] = {0.0f};
            for (int i = 0; i < 8; ++i) {
                strain_rate_g[0] += dN_dx_g[i][0] * v_rel[i][0];
                strain_rate_g[1] += dN_dx_g[i][1] * v_rel[i][1];
                strain_rate_g[2] += dN_dx_g[i][2] * v_rel[i][2];
                strain_rate_g[3] += dN_dx_g[i][1] * v_rel[i][0] + dN_dx_g[i][0] * v_rel[i][1];
                strain_rate_g[4] += dN_dx_g[i][2] * v_rel[i][1] + dN_dx_g[i][1] * v_rel[i][2];
                strain_rate_g[5] += dN_dx_g[i][0] * v_rel[i][2] + dN_dx_g[i][2] * v_rel[i][0];
            }

            T div_v_g = strain_rate_g[0] + strain_rate_g[1] + strain_rate_g[2];
            if (fabs(div_v_g) * dt < static_cast<T>(1.0e-6f)) {
                div_v_g = static_cast<T>(0.0f);
            }

            T h_e_g = cbrt(detJ_g * static_cast<T>(8.0f));
            T q_visc_g = (div_v_g < static_cast<T>(0.0f))
                       ? (density * (-b1 * h_e_g * div_v_g * cd + b2 * h_e_g * h_e_g * div_v_g * div_v_g))
                       : static_cast<T>(0.0f);

            T d_dev_g[3][3];
            T active_div_v = (integration_scheme == FEMIntegrationScheme::SelectiveReduced) ? div_v_center : div_v_g;
            d_dev_g[0][0] = strain_rate_g[0] - static_cast<T>(1.0f)/static_cast<T>(3.0f) * active_div_v;
            d_dev_g[1][1] = strain_rate_g[1] - static_cast<T>(1.0f)/static_cast<T>(3.0f) * active_div_v;
            d_dev_g[2][2] = strain_rate_g[2] - static_cast<T>(1.0f)/static_cast<T>(3.0f) * active_div_v;
            d_dev_g[0][1] = d_dev_g[1][0] = static_cast<T>(0.5f) * strain_rate_g[3];
            d_dev_g[1][2] = d_dev_g[2][1] = static_cast<T>(0.5f) * strain_rate_g[4];
            d_dev_g[2][0] = d_dev_g[0][2] = static_cast<T>(0.5f) * strain_rate_g[5];

            T d_norm_sq_g = d_dev_g[0][0]*d_dev_g[0][0] + d_dev_g[1][1]*d_dev_g[1][1] + d_dev_g[2][2]*d_dev_g[2][2] +
                            static_cast<T>(2.0f)*(d_dev_g[0][1]*d_dev_g[0][1] + d_dev_g[1][2]*d_dev_g[1][2] + d_dev_g[2][0]*d_dev_g[2][0]);
            T ep_dot_g = sqrt(static_cast<T>(2.0f) / static_cast<T>(3.0f) * d_norm_sq_g);

            T dynamic_yield_g = static_cast<T>(mat.yield_stress > 0.0f ? mat.yield_stress : 250.0e6f);
            if (ep_dot_g > static_cast<T>(1.0e-3f) && cs_C > static_cast<T>(0.0f) && cs_P > static_cast<T>(0.0f)) {
                dynamic_yield_g *= (static_cast<T>(1.0f) + pow(ep_dot_g / cs_C, static_cast<T>(1.0f) / cs_P));
            }

            T L_g[3][3] = {{static_cast<T>(0.0f)}};
            for (int i = 0; i < 8; ++i) {
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        L_g[r][c] += v_rel[i][r] * dN_dx_g[i][c];
                    }
                }
            }
            T W_g[3][3];
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    W_g[r][c] = static_cast<T>(0.5f) * (L_g[r][c] - L_g[c][r]);
                }
            }
            T theta_sq_g = (W_g[0][1]*W_g[0][1] + W_g[1][2]*W_g[1][2] + W_g[2][0]*W_g[2][0]) * (dt * dt);
            T R_dt_g[3][3] = {
                {static_cast<T>(1.0f), static_cast<T>(0.0f), static_cast<T>(0.0f)},
                {static_cast<T>(0.0f), static_cast<T>(1.0f), static_cast<T>(0.0f)},
                {static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(1.0f)}
            };
            if (theta_sq_g > static_cast<T>(1.0e-24f)) {
                T theta = sqrt(theta_sq_g);
                T Omega[3][3];
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        Omega[r][c] = W_g[r][c] * dt;
                    }
                }
                T c1 = sin(theta) / theta;
                T c2 = (static_cast<T>(1.0f) - cos(theta)) / theta_sq_g;
                T Om2[3][3] = {{static_cast<T>(0.0f)}};
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        for (int k = 0; k < 3; ++k) {
                            Om2[r][c] += Omega[r][k] * Omega[k][c];
                        }
                    }
                }
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        R_dt_g[r][c] = (r == c ? static_cast<T>(1.0f) : static_cast<T>(0.0f))
                                     + c1 * Omega[r][c] + c2 * Om2[r][c];
                    }
                }
                T s_temp[3][3] = {{static_cast<T>(0.0f)}};
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        for (int k = 0; k < 3; ++k) {
                            s_temp[r][c] += R_dt_g[r][k] * elem.s_dev_gp[g][k][c];
                        }
                    }
                }
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        elem.s_dev_gp[g][r][c] = static_cast<T>(0.0f);
                        for (int k = 0; k < 3; ++k) {
                            elem.s_dev_gp[g][r][c] += s_temp[r][k] * R_dt_g[c][k];
                        }
                    }
                }
            }

            T F_new_g[3][3] = {{static_cast<T>(0.0f)}};
            T I_plus_Ldt_g[3][3];
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    I_plus_Ldt_g[r][c] = (r == c ? static_cast<T>(1.0f) : static_cast<T>(0.0f)) + L_g[r][c] * dt;
                }
            }
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    for (int k = 0; k < 3; ++k) {
                        F_new_g[r][c] += I_plus_Ldt_g[r][k] * elem.F_gp[g][k][c];
                    }
                }
            }
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    elem.F_gp[g][r][c] = F_new_g[r][c];
                }
            }

            T vol_strain_g = 0.0f;
            if (integration_scheme == FEMIntegrationScheme::SelectiveReduced) {
                T F_det = elem.F[0][0] * (elem.F[1][1]*elem.F[2][2] - elem.F[1][2]*elem.F[2][1])
                        - elem.F[0][1] * (elem.F[1][0]*elem.F[2][2] - elem.F[1][2]*elem.F[2][0])
                        + elem.F[0][2] * (elem.F[1][0]*elem.F[2][1] - elem.F[1][1]*elem.F[2][0]);
                vol_strain_g = F_det - static_cast<T>(1.0f);
            } else {
                T F_det = elem.F_gp[g][0][0] * (elem.F_gp[g][1][1]*elem.F_gp[g][2][2] - elem.F_gp[g][1][2]*elem.F_gp[g][2][1])
                        - elem.F_gp[g][0][1] * (elem.F_gp[g][1][0]*elem.F_gp[g][2][2] - elem.F_gp[g][1][2]*elem.F_gp[g][2][0])
                        + elem.F_gp[g][0][2] * (elem.F_gp[g][1][0]*elem.F_gp[g][2][1] - elem.F_gp[g][1][1]*elem.F_gp[g][2][0]);
                vol_strain_g = F_det - static_cast<T>(1.0f);
            }
            if (fabs(vol_strain_g) < static_cast<T>(1.0e-6f)) {
                vol_strain_g = static_cast<T>(0.0f);
            }
            T p_hydro_g = -K * vol_strain_g + q_visc_g;

            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    elem.s_dev_gp[g][r][c] += static_cast<T>(2.0f) * G * d_dev_g[r][c] * dt;
                }
            }

            T s_norm_g = sqrt(
                elem.s_dev_gp[g][0][0]*elem.s_dev_gp[g][0][0] + elem.s_dev_gp[g][1][1]*elem.s_dev_gp[g][1][1] + elem.s_dev_gp[g][2][2]*elem.s_dev_gp[g][2][2] +
                static_cast<T>(2.0f)*(elem.s_dev_gp[g][0][1]*elem.s_dev_gp[g][0][1] + elem.s_dev_gp[g][1][2]*elem.s_dev_gp[g][1][2] + elem.s_dev_gp[g][2][0]*elem.s_dev_gp[g][2][0])
            );
            T vm_trial_g = sqrt(static_cast<T>(1.5f)) * s_norm_g;

            if (vm_trial_g > dynamic_yield_g && vm_trial_g > static_cast<T>(1.0e-6f)) {
                T scale = dynamic_yield_g / vm_trial_g;
                T d_ep = (vm_trial_g - dynamic_yield_g) / (static_cast<T>(3.0f) * G + static_cast<T>(mat.hardening_modulus));
                elem.ep_bar_gp[g] += d_ep;
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        elem.s_dev_gp[g][r][c] *= scale;
                    }
                }
                T plastic_work = dynamic_yield_g * d_ep;
                T chi = physics_params.taylor_quinney_factor;
                T Cp = static_cast<T>(mat.Cp > 0.0f ? mat.Cp : 477.0f);
                elem.temp_gp[g] += (chi * plastic_work) / (density * Cp);
            }

            T eta_shear_g = static_cast<T>(mat.bulk_viscosity_b1 > 0.0f ? mat.bulk_viscosity_b1 : 0.06f) * density * cd * h_e_g;
            T sigma_g[3][3];
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    sigma_g[r][c] = elem.s_dev_gp[g][r][c] + static_cast<T>(2.0f) * eta_shear_g * d_dev_g[r][c] - (r == c ? p_hydro_g : static_cast<T>(0.0f));
                }
            }

            for (int i = 0; i < 8; ++i) {
                int nid = elem.node_ids[i];
                T f_x = (dN_dx_g[i][0] * sigma_g[0][0] + dN_dx_g[i][1] * sigma_g[0][1] + dN_dx_g[i][2] * sigma_g[0][2]) * detJ_g;
                T f_y = (dN_dx_g[i][0] * sigma_g[1][0] + dN_dx_g[i][1] * sigma_g[1][1] + dN_dx_g[i][2] * sigma_g[1][2]) * detJ_g;
                T f_z = (dN_dx_g[i][0] * sigma_g[2][0] + dN_dx_g[i][1] * sigma_g[2][1] + dN_dx_g[i][2] * sigma_g[2][2]) * detJ_g;

                atomicAdd(&d_nodes[nid].f_int[0], f_x);
                atomicAdd(&d_nodes[nid].f_int[1], f_y);
                atomicAdd(&d_nodes[nid].f_int[2], f_z);
            }

            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    sigma_avg[r][c] += 0.125f * sigma_g[r][c];
                    s_dev_avg[r][c] += 0.125f * elem.s_dev_gp[g][r][c];
                }
            }
            ep_bar_avg += 0.125f * elem.ep_bar_gp[g];
            temp_avg += 0.125f * elem.temp_gp[g];
            damage_avg += 0.125f * elem.damage_gp[g];
        }

        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                elem.sigma[r][c] = sigma_avg[r][c];
                elem.s_dev[r][c] = s_dev_avg[r][c];
            }
        }
        elem.ep_bar = ep_bar_avg;
        elem.temperature = temp_avg;
        elem.damage = damage_avg;
        elem.V = V_sum;

        T F_avg[3][3] = {{0.0f}};
        for (int g = 0; g < 8; ++g) {
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    F_avg[r][c] += 0.125f * elem.F_gp[g][r][c];
                }
            }
        }
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                elem.F[r][c] = F_avg[r][c];
            }
        }
        return;
    }

    for (int i = 0; i < 8; ++i) {
        dN_dxi[i][0] = 0.125f * HEX8_XI_CUDA[i][0];
        dN_dxi[i][1] = 0.125f * HEX8_XI_CUDA[i][1];
        dN_dxi[i][2] = 0.125f * HEX8_XI_CUDA[i][2];
    }

    // Compute Jacobian matrix J (3x3)
    T J[3][3] = {{0.0f}};
    for (int i = 0; i < 8; ++i) {
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                J[r][c] += dN_dxi[i][r] * x_rel[i][c];
            }
        }
    }

    T detJ = J[0][0] * (J[1][1]*J[2][2] - J[1][2]*J[2][1])
           - J[0][1] * (J[1][0]*J[2][2] - J[1][2]*J[2][0])
           + J[0][2] * (J[1][0]*J[2][1] - J[1][1]*J[2][0]);

    min_vol_r = static_cast<T>(mat.timestep_erosion_factor > 0.0f ? mat.timestep_erosion_factor : 0.05f);
    if (detJ <= static_cast<T>(1.0e-15f) || (elem.V0 > static_cast<T>(1.0e-18f) && (detJ * static_cast<T>(8.0f) / elem.V0) <= min_vol_r)) {
        elem.is_eroded = true;
        return; // Skip force generation for inverted or severely crushed elements
    }

    T invDetJ = static_cast<T>(1.0f) / detJ;
    elem.V = detJ * static_cast<T>(8.0f);

    T J_inv[3][3];
    J_inv[0][0] = (J[1][1]*J[2][2] - J[1][2]*J[2][1]) * invDetJ;
    J_inv[0][1] = (J[0][2]*J[2][1] - J[0][1]*J[2][2]) * invDetJ;
    J_inv[0][2] = (J[0][1]*J[1][2] - J[0][2]*J[1][1]) * invDetJ;

    J_inv[1][0] = (J[1][2]*J[2][0] - J[1][0]*J[2][2]) * invDetJ;
    J_inv[1][1] = (J[0][0]*J[2][2] - J[0][2]*J[2][0]) * invDetJ;
    J_inv[1][2] = (J[0][2]*J[1][0] - J[0][0]*J[1][2]) * invDetJ;

    J_inv[2][0] = (J[1][0]*J[2][1] - J[1][1]*J[2][0]) * invDetJ;
    J_inv[2][1] = (J[0][1]*J[2][0] - J[0][0]*J[2][1]) * invDetJ;
    J_inv[2][2] = (J[0][0]*J[1][1] - J[0][1]*J[1][0]) * invDetJ;

    // Spatial shape function derivatives dN_dx[8][3] (Correct non-transposed indexing)
    T dN_dx[8][3];
    for (int i = 0; i < 8; ++i) {
        for (int c = 0; c < 3; ++c) {
            dN_dx[i][c] = J_inv[c][0] * dN_dxi[i][0] + J_inv[c][1] * dN_dxi[i][1] + J_inv[c][2] * dN_dxi[i][2];
        }
    }

    // Strain rate tensor components
    T strain_rate[6] = {0.0f};
    for (int i = 0; i < 8; ++i) {
        strain_rate[0] += dN_dx[i][0] * v_rel[i][0];
        strain_rate[1] += dN_dx[i][1] * v_rel[i][1];
        strain_rate[2] += dN_dx[i][2] * v_rel[i][2];
        strain_rate[3] += dN_dx[i][1] * v_rel[i][0] + dN_dx[i][0] * v_rel[i][1];
        strain_rate[4] += dN_dx[i][2] * v_rel[i][1] + dN_dx[i][1] * v_rel[i][2];
        strain_rate[5] += dN_dx[i][0] * v_rel[i][2] + dN_dx[i][2] * v_rel[i][0];
    }
    T div_v = strain_rate[0] + strain_rate[1] + strain_rate[2];
    if (fabs(div_v) * dt < static_cast<T>(1.0e-6f)) {
        div_v = static_cast<T>(0.0f);
    }

    // Artificial Bulk Viscosity Pressure q
    T h_e = cbrt(elem.V > static_cast<T>(1.0e-18f) ? elem.V : static_cast<T>(1.0e-18f));
    cd = sqrt((K + static_cast<T>(4.0f) / static_cast<T>(3.0f) * G) / density);
    b1 = static_cast<T>(mat.bulk_viscosity_b1 > 0.0f ? mat.bulk_viscosity_b1 : physics_params.bulk_viscosity_b1);
    b2 = static_cast<T>(mat.bulk_viscosity_b2 > 0.0f ? mat.bulk_viscosity_b2 : physics_params.bulk_viscosity_b2);
    T q_visc = (div_v < static_cast<T>(0.0f))
             ? (density * (-b1 * h_e * div_v * cd + b2 * h_e * h_e * div_v * div_v))
             : static_cast<T>(0.0f);
    elem.q_visc = q_visc;

    // Deviatoric strain rate tensor d_dev
    T d_dev[3][3];
    d_dev[0][0] = strain_rate[0] - static_cast<T>(1.0f)/static_cast<T>(3.0f) * div_v;
    d_dev[1][1] = strain_rate[1] - static_cast<T>(1.0f)/static_cast<T>(3.0f) * div_v;
    d_dev[2][2] = strain_rate[2] - static_cast<T>(1.0f)/static_cast<T>(3.0f) * div_v;
    d_dev[0][1] = d_dev[1][0] = static_cast<T>(0.5f) * strain_rate[3];
    d_dev[1][2] = d_dev[2][1] = static_cast<T>(0.5f) * strain_rate[4];
    d_dev[2][0] = d_dev[0][2] = static_cast<T>(0.5f) * strain_rate[5];

    T d_norm_sq = d_dev[0][0]*d_dev[0][0] + d_dev[1][1]*d_dev[1][1] + d_dev[2][2]*d_dev[2][2] +
                  static_cast<T>(2.0f)*(d_dev[0][1]*d_dev[0][1] + d_dev[1][2]*d_dev[1][2] + d_dev[2][0]*d_dev[2][0]);
    T ep_dot = sqrt(static_cast<T>(2.0f) / static_cast<T>(3.0f) * d_norm_sq);

    // Dynamic Yield Stress & Cowper-Symonds Strain Rate Hardening
    T dynamic_yield = static_cast<T>(mat.yield_stress > 0.0f ? mat.yield_stress : 250.0e6f);
    cs_C = physics_params.cowper_symonds_C;
    cs_P = physics_params.cowper_symonds_P;
    if (ep_dot > static_cast<T>(1.0e-3f) && cs_C > static_cast<T>(0.0f) && cs_P > static_cast<T>(0.0f)) {
        dynamic_yield *= (static_cast<T>(1.0f) + pow(ep_dot / cs_C, static_cast<T>(1.0f) / cs_P));
    }

    // 1. Calculate Velocity Gradient Tensor L[3][3]
    T L[3][3] = {{static_cast<T>(0.0f)}};
    for (int i = 0; i < 8; ++i) {
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                L[r][c] += v_rel[i][r] * dN_dx[i][c];
            }
        }
    }

    // 2. Extract Anti-Symmetric Spin Tensor W[3][3]
    T W[3][3];
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            W[r][c] = static_cast<T>(0.5f) * (L[r][c] - L[c][r]);
        }
    }

    // 3. Compute Rotation Angle theta and Rotation Matrix R_dt using Rodrigues' Formula
    T theta_sq = (W[0][1]*W[0][1] + W[1][2]*W[1][2] + W[2][0]*W[2][0]) * (dt * dt);
    T R_dt[3][3] = {
        {static_cast<T>(1.0f), static_cast<T>(0.0f), static_cast<T>(0.0f)},
        {static_cast<T>(0.0f), static_cast<T>(1.0f), static_cast<T>(0.0f)},
        {static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(1.0f)}
    };

    if (theta_sq > static_cast<T>(1.0e-24f)) {
        T theta = sqrt(theta_sq);
        T Omega[3][3];
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                Omega[r][c] = W[r][c] * dt;
            }
        }

        T c1 = sin(theta) / theta;
        T c2 = (static_cast<T>(1.0f) - cos(theta)) / theta_sq;

        T Om2[3][3] = {{static_cast<T>(0.0f)}};
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                for (int k = 0; k < 3; ++k) {
                    Om2[r][c] += Omega[r][k] * Omega[k][c];
                }
            }
        }

        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                R_dt[r][c] = (r == c ? static_cast<T>(1.0f) : static_cast<T>(0.0f))
                           + c1 * Omega[r][c] + c2 * Om2[r][c];
            }
        }

        // Objective Jaumann Rotation of Deviatoric Stress Tensor: s_dev = R_dt * s_dev * R_dt^T
        T s_temp[3][3] = {{static_cast<T>(0.0f)}};
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                for (int k = 0; k < 3; ++k) {
                    s_temp[r][c] += R_dt[r][k] * elem.s_dev[k][c];
                }
            }
        }

        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                elem.s_dev[r][c] = static_cast<T>(0.0f);
                for (int k = 0; k < 3; ++k) {
                    elem.s_dev[r][c] += s_temp[r][k] * R_dt[c][k];
                }
            }
        }
    }

    // 4. Update Deformation Gradient Tensor F^{n+1} = (I + L * dt) * F^n
    T F_new[3][3] = {{static_cast<T>(0.0f)}};
    T I_plus_Ldt[3][3];
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            I_plus_Ldt[r][c] = (r == c ? static_cast<T>(1.0f) : static_cast<T>(0.0f)) + L[r][c] * dt;
        }
    }
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            for (int k = 0; k < 3; ++k) {
                F_new[r][c] += I_plus_Ldt[r][k] * elem.F[k][c];
            }
        }
    }
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            elem.F[r][c] = F_new[r][c];
        }
    }

    // Increment deviatoric trial stress with numerical relaxation
    T vol_strain = (elem.V0 > static_cast<T>(1.0e-18f)) ? (elem.V / elem.V0 - static_cast<T>(1.0f)) : static_cast<T>(0.0f);
    if (fabs(vol_strain) < static_cast<T>(1.0e-6f)) {
        vol_strain = static_cast<T>(0.0f);
    }
    T p_hydro = -K * vol_strain + q_visc; // Positive in compression
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            elem.s_dev[r][c] += static_cast<T>(2.0f) * G * d_dev[r][c] * dt;
        }
    }

    // Von Mises Trial Stress & Radial Return Mapping
    T s_norm = sqrt(
        elem.s_dev[0][0]*elem.s_dev[0][0] + elem.s_dev[1][1]*elem.s_dev[1][1] + elem.s_dev[2][2]*elem.s_dev[2][2] +
        static_cast<T>(2.0f)*(elem.s_dev[0][1]*elem.s_dev[0][1] + elem.s_dev[1][2]*elem.s_dev[1][2] + elem.s_dev[2][0]*elem.s_dev[2][0])
    );
    T vm_trial = sqrt(static_cast<T>(1.5f)) * s_norm;

    if (vm_trial > dynamic_yield && vm_trial > static_cast<T>(1.0e-6f)) {
        T scale = dynamic_yield / vm_trial;
        T d_ep = (vm_trial - dynamic_yield) / (static_cast<T>(3.0f) * G + static_cast<T>(mat.hardening_modulus));
        elem.ep_bar += d_ep;

        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                elem.s_dev[r][c] *= scale;
            }
        }

        T plastic_work = dynamic_yield * d_ep;
        T chi = physics_params.taylor_quinney_factor;
        T Cp = static_cast<T>(mat.Cp > 0.0f ? mat.Cp : 477.0f);
        elem.temperature += (chi * plastic_work) / (density * Cp);
    }

    // Stress Assembly (sigma = s_dev - p*I)
    T eta_shear = static_cast<T>(mat.bulk_viscosity_b1 > 0.0f ? mat.bulk_viscosity_b1 : 0.06f) * density * cd * h_e;
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            elem.sigma[r][c] = elem.s_dev[r][c] + static_cast<T>(2.0f) * eta_shear * d_dev[r][c] - (r == c ? p_hydro : static_cast<T>(0.0f));
        }
    }

    // Nodal Internal Force Assembly via atomicAdd
    for (int i = 0; i < 8; ++i) {
        int nid = elem.node_ids[i];
        T f_x = (dN_dx[i][0] * elem.sigma[0][0] + dN_dx[i][1] * elem.sigma[0][1] + dN_dx[i][2] * elem.sigma[0][2]) * elem.V;
        T f_y = (dN_dx[i][0] * elem.sigma[1][0] + dN_dx[i][1] * elem.sigma[1][1] + dN_dx[i][2] * elem.sigma[1][2]) * elem.V;
        T f_z = (dN_dx[i][0] * elem.sigma[2][0] + dN_dx[i][1] * elem.sigma[2][1] + dN_dx[i][2] * elem.sigma[2][2]) * elem.V;

        atomicAdd(&d_nodes[nid].f_int[0], f_x);
        atomicAdd(&d_nodes[nid].f_int[1], f_y);
        atomicAdd(&d_nodes[nid].f_int[2], f_z);
    }

    // Hourglass Forces via atomicAdd (Corrected dimensionally scaling matching CPU)
    if (hourglass_coeff > static_cast<T>(0.0f)) {
        static const float FB_GAMMA_CUDA[4][8] = {
            { 1.0f,  1.0f, -1.0f, -1.0f, -1.0f, -1.0f,  1.0f,  1.0f},
            { 1.0f, -1.0f, -1.0f,  1.0f, -1.0f,  1.0f,  1.0f, -1.0f},
            { 1.0f, -1.0f,  1.0f, -1.0f,  1.0f, -1.0f,  1.0f, -1.0f},
            {-1.0f,  1.0f, -1.0f,  1.0f,  1.0f, -1.0f,  1.0f, -1.0f}
        };

        // Newton-Schulz Polar Decomposition to extract element rotation R_elem
        T R_elem[3][3];
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                R_elem[r][c] = elem.F[r][c];
            }
        }
        for (int iter = 0; iter < 4; ++iter) {
            T det = R_elem[0][0]*(R_elem[1][1]*R_elem[2][2] - R_elem[1][2]*R_elem[2][1])
                  - R_elem[0][1]*(R_elem[1][0]*R_elem[2][2] - R_elem[1][2]*R_elem[2][0])
                  + R_elem[0][2]*(R_elem[1][0]*R_elem[2][1] - R_elem[1][1]*R_elem[2][0]);
            if (fabs(det) < static_cast<T>(1.0e-9f)) {
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        R_elem[r][c] = (r == c ? static_cast<T>(1.0f) : static_cast<T>(0.0f));
                    }
                }
                break;
            }
            T invDet = static_cast<T>(1.0f) / det;
            T R_inv_T[3][3];
            R_inv_T[0][0] = (R_elem[1][1]*R_elem[2][2] - R_elem[1][2]*R_elem[2][1]) * invDet;
            R_inv_T[1][0] = (R_elem[0][2]*R_elem[2][1] - R_elem[0][1]*R_elem[2][2]) * invDet;
            R_inv_T[2][0] = (R_elem[0][1]*R_elem[1][2] - R_elem[0][2]*R_elem[1][1]) * invDet;
            R_inv_T[0][1] = (R_elem[1][2]*R_elem[2][0] - R_elem[1][0]*R_elem[2][2]) * invDet;
            R_inv_T[1][1] = (R_elem[0][0]*R_elem[2][2] - R_elem[0][2]*R_elem[2][0]) * invDet;
            R_inv_T[2][1] = (R_elem[0][2]*R_elem[1][0] - R_elem[0][0]*R_elem[1][2]) * invDet;
            R_inv_T[0][2] = (R_elem[1][0]*R_elem[2][1] - R_elem[1][1]*R_elem[2][0]) * invDet;
            R_inv_T[1][2] = (R_elem[0][1]*R_elem[2][0] - R_elem[0][0]*R_elem[2][1]) * invDet;
            R_inv_T[2][2] = (R_elem[0][0]*R_elem[1][1] - R_elem[0][1]*R_elem[1][0]) * invDet;

            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    R_elem[r][c] = static_cast<T>(0.5f) * (R_elem[r][c] + R_inv_T[r][c]);
                }
            }
        }

        T x0_center[3] = {0.0f, 0.0f, 0.0f};
        for (int n = 0; n < 8; ++n) {
            int nid = elem.node_ids[n];
            x0_center[0] += d_nodes[nid].x0[0];
            x0_center[1] += d_nodes[nid].x0[1];
            x0_center[2] += d_nodes[nid].x0[2];
        }
        x0_center[0] *= static_cast<T>(0.125f);
        x0_center[1] *= static_cast<T>(0.125f);
        x0_center[2] *= static_cast<T>(0.125f);

        T u_rel[8][3];
        for (int n = 0; n < 8; ++n) {
            int nid = elem.node_ids[n];
            T x_rel_val[3], x0_rel_val[3];
            for (int c = 0; c < 3; ++c) {
                x_rel_val[c] = x_nodes[n][c] - x_center[c];
                x0_rel_val[c] = d_nodes[nid].x0[c] - x0_center[c];
            }

            T x0_rot_val[3] = {0.0f, 0.0f, 0.0f};
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    x0_rot_val[r] += R_elem[r][c] * x0_rel_val[c];
                }
            }

            for (int c = 0; c < 3; ++c) {
                u_rel[n][c] = x_rel_val[c] - x0_rot_val[c];
            }
        }

        T viscous_factor = static_cast<T>(0.05f) * hourglass_coeff * density * cd * h_e * h_e;
        T stiffness_factor = static_cast<T>(0.25f) * hourglass_coeff * E * h_e;

        for (int alpha = 0; alpha < 4; ++alpha) {
            T sub[3] = {0.0f, 0.0f, 0.0f};
            for (int n = 0; n < 8; ++n) {
                T g_raw = FB_GAMMA_CUDA[alpha][n];
                for (int c = 0; c < 3; ++c) sub[c] += g_raw * x_nodes[n][c];
            }

            T gamma_ortho[8];
            for (int n = 0; n < 8; ++n) {
                gamma_ortho[n] = FB_GAMMA_CUDA[alpha][n] - (sub[0] * dN_dx[n][0] + sub[1] * dN_dx[n][1] + sub[2] * dN_dx[n][2]);
            }

            T q_vel[3] = {0.0f, 0.0f, 0.0f};
            T q_disp[3] = {0.0f, 0.0f, 0.0f};
            for (int n = 0; n < 8; ++n) {
                for (int c = 0; c < 3; ++c) {
                    q_vel[c] += gamma_ortho[n] * v_rel[n][c];
                    q_disp[c] += gamma_ortho[n] * u_rel[n][c];
                }
            }

            for (int n = 0; n < 8; ++n) {
                int nid = elem.node_ids[n];
                for (int c = 0; c < 3; ++c) {
                    T f_hg = (hg_model == FEMHourglassModel::FlanaganBelytschkoViscous)
                             ? viscous_factor * gamma_ortho[n] * q_vel[c]
                             : stiffness_factor * gamma_ortho[n] * q_disp[c];
                    atomicAdd(&d_nodes[nid].f_int[c], f_hg);
                }
            }
        }
    }
}

// CUDA Kernel: 2. Full-Step Kinematic Acceleration & Velocity Update (2nd-Order Velocity-Verlet)
template <typename T>
__global__ void fem_nodal_full_step_kernel_3d_device(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    T dt
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_nodes) return;

    FEMNode3D<T>& node = d_nodes[idx];
    if (node.m <= static_cast<T>(1.0e-12f) || node.is_eroded) return;

    for (int c = 0; c < 3; ++c) {
        if (node.is_fixed[c]) {
            node.v[c] = static_cast<T>(0.0f);
            node.a[c] = static_cast<T>(0.0f);
            continue;
        }

        T f_net = node.f_ext[c] - node.f_int[c] + node.f_contact[c];
        node.a[c] = f_net / node.m;
        node.v[c] += static_cast<T>(0.5f) * node.a[c] * dt;
    }

    T v_mag_sq = node.v[0]*node.v[0] + node.v[1]*node.v[1] + node.v[2]*node.v[2];
    T v_max_phys = static_cast<T>(10000.0f);
    if (v_mag_sq > v_max_phys * v_max_phys) {
        T scale = v_max_phys / sqrt(v_mag_sq);
        node.v[0] *= scale;
        node.v[1] *= scale;
        node.v[2] *= scale;
    }
}

// CUDA Kernel: Erosion Check (Negative volume, min_volume_ratio, plastic strain, tensile stress, timestep ratio)
template <typename T>
__global__ void fem_initial_timestep_erosion_kernel_3d_device(
    FEMNode3D<T>* d_nodes,
    FEMElement3D<T>* d_elements,
    int num_elements,
    const MaterialTable3D* d_materials,
    FEMErosionCriteria<T> erosion_criteria
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_elements) return;

    FEMElement3D<T>& elem = d_elements[idx];
    if (elem.is_eroded) return;

    const MaterialTable3D& mat = d_materials[elem.mat_id];
    T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 210.0e9f);
    T nu = static_cast<T>(mat.poissons_ratio);
    T density = static_cast<T>(mat.density > 0.0f ? mat.density : 7850.0f);
    T G = E / (static_cast<T>(2.0f) * (static_cast<T>(1.0f) + nu));
    T K = E / (static_cast<T>(3.0f) * (static_cast<T>(1.0f) - static_cast<T>(2.0f) * nu));
    T cd = sqrt((K + static_cast<T>(4.0f)/static_cast<T>(3.0f) * G) / density);

    T char_len = cbrt(elem.V > static_cast<T>(1.0e-18f) ? elem.V : static_cast<T>(1.0e-18f));
    T current_dt = char_len / (cd > static_cast<T>(1.0f) ? cd : static_cast<T>(5000.0f));

    bool newly_eroded = false;
    T min_vol_r = erosion_criteria.min_volume_ratio > static_cast<T>(0.0f) ? erosion_criteria.min_volume_ratio : static_cast<T>(0.02f);
    if (elem.V <= static_cast<T>(1.0e-18f) || (elem.V0 > static_cast<T>(1.0e-18f) && (elem.V / elem.V0) <= min_vol_r)) {
        newly_eroded = true;
    }

    if (erosion_criteria.enable_timestep_erosion && mat.timestep_erosion_factor > static_cast<T>(1.0e-5f)) {
        T eta = static_cast<T>(mat.timestep_erosion_factor);
        if (current_dt <= eta * elem.dt0) {
            newly_eroded = true;
        }
    }

    if (erosion_criteria.enable_strain_erosion) {
        T fail_strain = static_cast<T>(mat.failure_strain > 0.0f ? mat.failure_strain : erosion_criteria.failure_strain);
        if (fail_strain > static_cast<T>(0.0f) && elem.ep_bar >= fail_strain) {
            newly_eroded = true;
        }
    }

    if (erosion_criteria.enable_stress_erosion) {
        T mean_s = (elem.sigma[0][0] + elem.sigma[1][1] + elem.sigma[2][2]) / static_cast<T>(3.0f);
        T fail_stress = static_cast<T>(mat.tensile_failure_stress > 0.0f ? mat.tensile_failure_stress : erosion_criteria.tensile_failure_stress);
        if (fail_stress > static_cast<T>(0.0f) && mean_s >= fail_stress) {
            newly_eroded = true;
        }
    }

    if (newly_eroded) {
        elem.is_eroded = true;
        elem.sigma[0][0] = elem.sigma[1][1] = elem.sigma[2][2] = static_cast<T>(0.0f);
        elem.sigma[0][1] = elem.sigma[1][2] = elem.sigma[2][0] = static_cast<T>(0.0f);
        elem.s_dev[0][0] = elem.s_dev[1][1] = elem.s_dev[2][2] = static_cast<T>(0.0f);
        elem.s_dev[0][1] = elem.s_dev[1][2] = elem.s_dev[2][0] = static_cast<T>(0.0f);
    }
}

// CUDA Kernel: Reset Nodal Internal Forces
template <typename T>
__global__ void fem_reset_nodal_forces_kernel_device(
    FEMNode3D<T>* d_nodes,
    int num_nodes
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_nodes) return;
    d_nodes[idx].f_int[0] = static_cast<T>(0.0f);
    d_nodes[idx].f_int[1] = static_cast<T>(0.0f);
    d_nodes[idx].f_int[2] = static_cast<T>(0.0f);
}

// Host Launch Wrappers
template <typename T>
void launch_fem_reset_nodal_forces_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    cudaStream_t stream
) {
    int block_size = 256;
    int grid_size = (num_nodes + block_size - 1) / block_size;
    fem_reset_nodal_forces_kernel_device<T><<<grid_size, block_size, 0, stream>>>(
        d_nodes, num_nodes
    );
}

template <typename T>
void launch_fem_element_forces_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    FEMElement3D<T>* d_elements,
    int num_elements,
    const MaterialTable3D* d_materials,
    BlastPhysicsParams<T> physics_params,
    T dt,
    T hourglass_coeff,
    FEMHourglassModel hg_model,
    FEMIntegrationScheme integration_scheme,
    cudaStream_t stream
) {
    int block_size = 256;
    int grid_size = (num_elements + block_size - 1) / block_size;
    fem_element_forces_kernel_3d_device<T><<<grid_size, block_size, 0, stream>>>(
        d_nodes, num_nodes, d_elements, num_elements, d_materials, physics_params, dt, hourglass_coeff, hg_model, integration_scheme
    );
}

template <typename T>
void launch_fem_nodal_half_step_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    T dt,
    cudaStream_t stream
) {
    int block_size = 256;
    int grid_size = (num_nodes + block_size - 1) / block_size;
    fem_nodal_half_step_kernel_3d_device<T><<<grid_size, block_size, 0, stream>>>(
        d_nodes, num_nodes, dt
    );
}

template <typename T>
void launch_fem_nodal_full_step_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    T dt,
    cudaStream_t stream
) {
    int block_size = 256;
    int grid_size = (num_nodes + block_size - 1) / block_size;
    fem_nodal_full_step_kernel_3d_device<T><<<grid_size, block_size, 0, stream>>>(
        d_nodes, num_nodes, dt
    );
}

template <typename T>
void launch_fem_initial_timestep_erosion_kernel_3d(
    FEMNode3D<T>* d_nodes,
    FEMElement3D<T>* d_elements,
    int num_elements,
    const MaterialTable3D* d_materials,
    FEMErosionCriteria<T> erosion_criteria,
    cudaStream_t stream
) {
    int block_size = 256;
    int grid_size = (num_elements + block_size - 1) / block_size;
    fem_initial_timestep_erosion_kernel_3d_device<T><<<grid_size, block_size, 0, stream>>>(
        d_nodes, d_elements, num_elements, d_materials, erosion_criteria
    );
}

// FEMSolver3DCUDA Class Implementation
template <typename T>
FEMSolver3DCUDA<T>::FEMSolver3DCUDA() {
    cudaStreamCreateWithFlags(&m_cuda_stream, cudaStreamNonBlocking);
}

template <typename T>
FEMSolver3DCUDA<T>::~FEMSolver3DCUDA() {
    if (m_d_nodes) { cudaFree(m_d_nodes); m_d_nodes = nullptr; }
    if (m_d_elements) { cudaFree(m_d_elements); m_d_elements = nullptr; }
    if (m_d_materials) { cudaFree(m_d_materials); m_d_materials = nullptr; }
    if (m_cuda_stream) { cudaStreamDestroy(m_cuda_stream); m_cuda_stream = nullptr; }
}

template <typename T>
void FEMSolver3DCUDA<T>::syncToDevice() {
    auto& nodes = m_cpu_solver.getNodes();
    auto& elements = m_cpu_solver.getElements();
    auto& materials = m_cpu_solver.getMaterialTables();

    if (nodes.size() > m_allocated_nodes) {
        if (m_d_nodes) cudaFree(m_d_nodes);
        m_allocated_nodes = nodes.size() + 1024;
        cudaMalloc(&m_d_nodes, sizeof(FEMNode3D<T>) * m_allocated_nodes);
    }
    if (!nodes.empty()) {
        cudaMemcpyAsync(m_d_nodes, nodes.data(), sizeof(FEMNode3D<T>) * nodes.size(), cudaMemcpyHostToDevice, m_cuda_stream);
    }

    if (elements.size() > m_allocated_elements) {
        if (m_d_elements) cudaFree(m_d_elements);
        m_allocated_elements = elements.size() + 1024;
        cudaMalloc(&m_d_elements, sizeof(FEMElement3D<T>) * m_allocated_elements);
    }
    if (!elements.empty()) {
        cudaMemcpyAsync(m_d_elements, elements.data(), sizeof(FEMElement3D<T>) * elements.size(), cudaMemcpyHostToDevice, m_cuda_stream);
    }

    if (materials.size() > m_allocated_materials) {
        if (m_d_materials) cudaFree(m_d_materials);
        m_allocated_materials = materials.size() + 16;
        cudaMalloc(&m_d_materials, sizeof(MaterialTable3D) * m_allocated_materials);
    }
    if (!materials.empty()) {
        cudaMemcpyAsync(m_d_materials, materials.data(), sizeof(MaterialTable3D) * materials.size(), cudaMemcpyHostToDevice, m_cuda_stream);
    }
    cudaStreamSynchronize(m_cuda_stream);
    m_gpu_dirty = false;
}

template <typename T>
void FEMSolver3DCUDA<T>::syncToHost() const {
    if (!m_gpu_dirty) return;
    auto& nodes = const_cast<FEMSolver3D<T>&>(m_cpu_solver).getNodes();
    auto& elements = const_cast<FEMSolver3D<T>&>(m_cpu_solver).getElements();
    if (m_d_nodes && !nodes.empty()) {
        cudaMemcpyAsync(nodes.data(), m_d_nodes, sizeof(FEMNode3D<T>) * nodes.size(), cudaMemcpyDeviceToHost, m_cuda_stream);
    }
    if (m_d_elements && !elements.empty()) {
        cudaMemcpyAsync(elements.data(), m_d_elements, sizeof(FEMElement3D<T>) * elements.size(), cudaMemcpyDeviceToHost, m_cuda_stream);
    }
    cudaStreamSynchronize(m_cuda_stream);
    const_cast<FEMSolver3D<T>&>(m_cpu_solver).computeGlobalEnergy();
    const_cast<FEMSolver3D<T>&>(m_cpu_solver).invalidateSurfaceFacets();
    m_gpu_dirty = false;
}

template <typename T>
void FEMSolver3DCUDA<T>::stepWithDt(T dt) {
    auto& nodes = m_cpu_solver.getNodes();
    auto& elements = m_cpu_solver.getElements();
    if (nodes.empty() || elements.empty()) return;

    if (!m_d_nodes || !m_d_elements) {
        syncToDevice();
    }

    m_last_dt = dt;
    m_sim_time += dt;
    m_step_count++;

    int num_nodes = static_cast<int>(nodes.size());
    int num_elements = static_cast<int>(elements.size());

    // 1. Half-Step Velocity & Nodal Position Update on GPU (2nd-Order Velocity-Verlet)
    launch_fem_nodal_half_step_kernel_3d<T>(m_d_nodes, num_nodes, dt, m_cuda_stream);

    // 2. Penalty Surface Contact Handling
    if (m_cpu_solver.getContactPenaltyScale() > static_cast<T>(0.0f) && !m_cpu_solver.getSurfaceFacets().empty()) {
        // Copy current half-step positions back to CPU host to evaluate surface contact pairs
        cudaMemcpyAsync(nodes.data(), m_d_nodes, sizeof(FEMNode3D<T>) * num_nodes, cudaMemcpyDeviceToHost, m_cuda_stream);
        cudaStreamSynchronize(m_cuda_stream);

        FEMContact3D<T> contact_solver;
        contact_solver.setContactPenaltyScale(m_cpu_solver.getContactPenaltyScale());
        contact_solver.setFrictionCoefficients(m_cpu_solver.getFrictionStatic(), m_cpu_solver.getFrictionKinetic());
        contact_solver.solveContact(m_cpu_solver, dt);

        // Copy contact forces back to GPU device
        cudaMemcpyAsync(m_d_nodes, nodes.data(), sizeof(FEMNode3D<T>) * num_nodes, cudaMemcpyHostToDevice, m_cuda_stream);
    }

    // 3. Reset nodal internal forces on GPU
    launch_fem_reset_nodal_forces_kernel_3d<T>(m_d_nodes, num_nodes, m_cuda_stream);

    // 4. Compute Hex8 Element Stresses and Hourglass Forces on GPU
    launch_fem_element_forces_kernel_3d<T>(
        m_d_nodes, num_nodes, m_d_elements, num_elements, m_d_materials,
        m_cpu_solver.getPhysicsParams(), dt, m_cpu_solver.getHourglassCoeff(),
        m_cpu_solver.getHourglassModel(), m_cpu_solver.getIntegrationScheme(), m_cuda_stream
    );

    // 5. Central Difference Kinematic Acceleration & Full Velocity Update on GPU
    launch_fem_nodal_full_step_kernel_3d<T>(m_d_nodes, num_nodes, dt, m_cuda_stream);

    // 6. Erosion Evaluation on GPU
    launch_fem_initial_timestep_erosion_kernel_3d<T>(m_d_nodes, m_d_elements, num_elements, m_d_materials, m_cpu_solver.getErosionCriteria(), m_cuda_stream);

    m_gpu_dirty = true;
}

template <typename T>
void FEMSolver3DCUDA<T>::step(T cfl) {
    m_last_cfl = cfl;
    T dt = m_cpu_solver.computeStepSize(cfl);
    stepWithDt(dt);
}

// Explicit Instantiations
template void launch_fem_reset_nodal_forces_kernel_3d<float>(FEMNode3D<float>*, int, cudaStream_t);
template void launch_fem_reset_nodal_forces_kernel_3d<double>(FEMNode3D<double>*, int, cudaStream_t);

template void launch_fem_element_forces_kernel_3d<float>(FEMNode3D<float>*, int, FEMElement3D<float>*, int, const MaterialTable3D*, BlastPhysicsParams<float>, float, float, FEMHourglassModel, FEMIntegrationScheme, cudaStream_t);
template void launch_fem_element_forces_kernel_3d<double>(FEMNode3D<double>*, int, FEMElement3D<double>*, int, const MaterialTable3D*, BlastPhysicsParams<double>, double, double, FEMHourglassModel, FEMIntegrationScheme, cudaStream_t);

template void launch_fem_nodal_half_step_kernel_3d<float>(FEMNode3D<float>*, int, float, cudaStream_t);
template void launch_fem_nodal_half_step_kernel_3d<double>(FEMNode3D<double>*, int, double, cudaStream_t);

template void launch_fem_nodal_full_step_kernel_3d<float>(FEMNode3D<float>*, int, float, cudaStream_t);
template void launch_fem_nodal_full_step_kernel_3d<double>(FEMNode3D<double>*, int, double, cudaStream_t);

template void launch_fem_initial_timestep_erosion_kernel_3d<float>(FEMNode3D<float>*, FEMElement3D<float>*, int, const MaterialTable3D*, FEMErosionCriteria<float>, cudaStream_t);
template void launch_fem_initial_timestep_erosion_kernel_3d<double>(FEMNode3D<double>*, FEMElement3D<double>*, int, const MaterialTable3D*, FEMErosionCriteria<double>, cudaStream_t);

template class FEMSolver3DCUDA<float>;
template class FEMSolver3DCUDA<double>;

} // namespace Blast
