#include "fem_solver_3d_cuda.hpp"
#include "fem_contact_3d.hpp"
#include "constitutive_concrete_models.hpp"
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

            // Johnson-Cook Plasticity & Thermal Softening
            T dynamic_yield_g = static_cast<T>(mat.yield_stress);
            bool is_jc_g = (mat.jc_A > static_cast<T>(0.0f));
            T A_g = is_jc_g ? static_cast<T>(mat.jc_A) : static_cast<T>(mat.yield_stress);
            T B_g_mat = is_jc_g ? static_cast<T>(mat.jc_B) : static_cast<T>(mat.hardening_modulus);
            T n_exp_g = is_jc_g ? static_cast<T>(mat.jc_n) : static_cast<T>(1.0f);
            T C_rate_g = is_jc_g ? static_cast<T>(mat.jc_C) : static_cast<T>(0.0f);
            T m_exp_g = is_jc_g ? static_cast<T>(mat.jc_m) : static_cast<T>(0.0f);
            T T_melt_g = static_cast<T>(mat.T_melt > 0.0f ? mat.T_melt : 1793.0f);
            T T_room_g = static_cast<T>(mat.T_room > 0.0f ? mat.T_room : 293.0f);

            T ep_val_g = (elem.ep_bar_gp[g] > static_cast<T>(0.0f)) ? elem.ep_bar_gp[g] : static_cast<T>(0.0f);
            T sigma_hard_g = A_g + (B_g_mat > static_cast<T>(0.0f) ? B_g_mat * pow(ep_val_g, n_exp_g) : static_cast<T>(0.0f));

            T strain_rate_factor_g = static_cast<T>(1.0f);
            if (ep_dot_g > static_cast<T>(1.0e-3f)) {
                if (C_rate_g > static_cast<T>(0.0f)) {
                    T ep_dot_star = (ep_dot_g > static_cast<T>(1.0f)) ? ep_dot_g : static_cast<T>(1.0f);
                    strain_rate_factor_g += C_rate_g * log(ep_dot_star);
                    if (strain_rate_factor_g < static_cast<T>(0.1f)) strain_rate_factor_g = static_cast<T>(0.1f);
                } else if (cs_C > static_cast<T>(0.0f) && cs_P > static_cast<T>(0.0f)) {
                    strain_rate_factor_g += pow(ep_dot_g / cs_C, static_cast<T>(1.0f) / cs_P);
                }
            }

            T thermal_factor_g = static_cast<T>(1.0f);
            if (m_exp_g > static_cast<T>(0.0f) && T_melt_g > T_room_g) {
                T T_star_g = (elem.temp_gp[g] - T_room_g) / (T_melt_g - T_room_g);
                T_star_g = (T_star_g < static_cast<T>(0.0f)) ? static_cast<T>(0.0f) : ((T_star_g > static_cast<T>(1.0f)) ? static_cast<T>(1.0f) : T_star_g);
                thermal_factor_g = static_cast<T>(1.0f) - pow(T_star_g, m_exp_g);
                if (thermal_factor_g < static_cast<T>(0.01f)) thermal_factor_g = static_cast<T>(0.01f);
            }
            dynamic_yield_g = (sigma_hard_g * strain_rate_factor_g * thermal_factor_g > static_cast<T>(1.0e6f)) ? (sigma_hard_g * strain_rate_factor_g * thermal_factor_g) : static_cast<T>(1.0e6f);

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
            // Mie-Grueneisen Shock EOS Hydrostatic Pressure
            T p_hydro_g = static_cast<T>(0.0f);
            if (mat.mg_c0 > static_cast<T>(0.0f) && mat.mg_gamma0 > static_cast<T>(0.0f)) {
                T c0 = static_cast<T>(mat.mg_c0);
                T s1 = static_cast<T>(mat.mg_s > 0.0f ? mat.mg_s : 1.49f);
                T gamma0 = static_cast<T>(mat.mg_gamma0);
                T mu = (elem.V > static_cast<T>(1.0e-18f) && elem.V0 > static_cast<T>(1.0e-18f))
                     ? (elem.V0 / elem.V - static_cast<T>(1.0f))
                     : static_cast<T>(0.0f);
                T E_v = density * (mat.Cp > 0.0f ? mat.Cp : 477.0f) * (elem.temp_gp[g] - (mat.T_room > 0.0f ? mat.T_room : 293.0f));
                if (mu > static_cast<T>(0.0f)) {
                    T denom = static_cast<T>(1.0f) - (s1 - static_cast<T>(1.0f)) * mu;
                    if (denom > static_cast<T>(0.1f)) {
                        p_hydro_g = (density * c0 * c0 * mu * (static_cast<T>(1.0f) + (static_cast<T>(1.0f) - static_cast<T>(0.5f) * gamma0) * mu)) / (denom * denom) + gamma0 * E_v;
                    } else {
                        p_hydro_g = K * mu + gamma0 * E_v;
                    }
                } else {
                    p_hydro_g = density * c0 * c0 * mu + gamma0 * E_v;
                }
                p_hydro_g += q_visc_g;
            } else {
                p_hydro_g = -K * vol_strain_g + q_visc_g;
            }

            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    elem.s_dev_gp[g][r][c] += static_cast<T>(2.0f) * G * d_dev_g[r][c] * dt;
                }
            }

            if (mat.material_model == MPMMaterialModel::RHTConcrete) {
                RHTStateVariables<T> rht_state;
                rht_state.damage = elem.damage_gp[g];
                rht_state.ep_bar = elem.ep_bar_gp[g];
                rht_state.p_hydro = p_hydro_g;
                updateRHTStress<T>(
                    elem.s_dev_gp[g], p_hydro_g, vol_strain_g, dt, h_e_g, ep_dot_g,
                    static_cast<T>(mat.fc), static_cast<T>(mat.ft), G, K,
                    static_cast<T>(mat.G_f), static_cast<T>(mat.moisture_content),
                    static_cast<T>(mat.rht_A), static_cast<T>(mat.rht_N),
                    static_cast<T>(mat.rht_B), static_cast<T>(mat.rht_M),
                    static_cast<T>(mat.rht_Q0), static_cast<T>(mat.rht_BQ),
                    static_cast<T>(mat.rht_D1), static_cast<T>(mat.rht_D2),
                    static_cast<T>(mat.rht_p_crush), static_cast<T>(mat.rht_p_lock),
                    static_cast<T>(mat.rht_alpha0), static_cast<T>(mat.rht_n_comp),
                    static_cast<T>(mat.rht_betac), static_cast<T>(mat.rht_deltat),
                    static_cast<T>(mat.dif_cap_compression), static_cast<T>(mat.dif_cap_tension),
                    rht_state
                );
                elem.damage_gp[g] = rht_state.damage;
                elem.ep_bar_gp[g] = rht_state.ep_bar;
                p_hydro_g = rht_state.p_hydro;
            } else if (mat.material_model == MPMMaterialModel::KCConcrete) {
                KCStateVariables<T> kc_state;
                kc_state.damage = elem.damage_gp[g];
                kc_state.lambda = elem.lambda_gp[g];
                kc_state.ep_bar = elem.ep_bar_gp[g];
                kc_state.p_hydro = p_hydro_g;
                updateKCStress<T>(
                    elem.s_dev_gp[g], p_hydro_g, vol_strain_g, dt, h_e_g, ep_dot_g,
                    static_cast<T>(mat.fc), static_cast<T>(mat.ft), G, K,
                    static_cast<T>(mat.G_f), static_cast<T>(mat.moisture_content),
                    mat.kc_auto_generate,
                    static_cast<T>(mat.kc_a0), static_cast<T>(mat.kc_a1), static_cast<T>(mat.kc_a2),
                    static_cast<T>(mat.kc_a0y), static_cast<T>(mat.kc_a1y), static_cast<T>(mat.kc_a2y),
                    static_cast<T>(mat.kc_a1r), static_cast<T>(mat.kc_a2r),
                    static_cast<T>(mat.kc_b1), static_cast<T>(mat.kc_omega),
                    static_cast<T>(mat.dif_cap_compression), static_cast<T>(mat.dif_cap_tension),
                    kc_state
                );
                elem.damage_gp[g] = kc_state.damage;
                elem.lambda_gp[g] = kc_state.lambda;
                elem.ep_bar_gp[g] = kc_state.ep_bar;
                p_hydro_g = kc_state.p_hydro;
            } else if (mat.material_model == MPMMaterialModel::CSCMConcrete) {
                CSCMStateVariables<T> cscm_state;
                cscm_state.damage = elem.damage_gp[g];
                cscm_state.kappa = elem.lambda_gp[g];
                cscm_state.ep_bar = elem.ep_bar_gp[g];
                cscm_state.p_hydro = p_hydro_g;
                updateCSCMStress<T>(
                    elem.s_dev_gp[g], p_hydro_g, vol_strain_g, dt, h_e_g, ep_dot_g,
                    static_cast<T>(mat.fc), static_cast<T>(mat.ft), G, K,
                    static_cast<T>(mat.G_f),
                    static_cast<T>(mat.cscm_alpha), static_cast<T>(mat.cscm_theta),
                    static_cast<T>(mat.cscm_lambda), static_cast<T>(mat.cscm_beta),
                    static_cast<T>(mat.cscm_R), static_cast<T>(mat.cscm_X0),
                    static_cast<T>(mat.cscm_W), static_cast<T>(mat.cscm_D1),
                    static_cast<T>(mat.cscm_D2),
                    static_cast<T>(mat.dif_cap_compression), static_cast<T>(mat.dif_cap_tension),
                    cscm_state
                );
                elem.damage_gp[g] = cscm_state.damage;
                elem.lambda_gp[g] = cscm_state.kappa;
                elem.ep_bar_gp[g] = cscm_state.ep_bar;
                p_hydro_g = cscm_state.p_hydro;
            } else {
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

    min_vol_r = static_cast<T>(0.02f);
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

    // Johnson-Cook Plasticity & Thermal Softening
    T dynamic_yield = static_cast<T>(mat.yield_stress);
    bool is_jc = (mat.jc_A > static_cast<T>(0.0f));
    T A_mat = is_jc ? static_cast<T>(mat.jc_A) : static_cast<T>(mat.yield_stress);
    T B_mat = is_jc ? static_cast<T>(mat.jc_B) : static_cast<T>(mat.hardening_modulus);
    T n_exp = is_jc ? static_cast<T>(mat.jc_n) : static_cast<T>(1.0f);
    T C_rate = is_jc ? static_cast<T>(mat.jc_C) : static_cast<T>(0.0f);
    T m_exp = is_jc ? static_cast<T>(mat.jc_m) : static_cast<T>(0.0f);
    T T_melt = static_cast<T>(mat.T_melt > 0.0f ? mat.T_melt : 1793.0f);
    T T_room = static_cast<T>(mat.T_room > 0.0f ? mat.T_room : 293.0f);

    T ep_val = (elem.ep_bar > static_cast<T>(0.0f)) ? elem.ep_bar : static_cast<T>(0.0f);
    T sigma_hard = A_mat + (B_mat > static_cast<T>(0.0f) ? B_mat * pow(ep_val, n_exp) : static_cast<T>(0.0f));

    T strain_rate_factor = static_cast<T>(1.0f);
    if (ep_dot > static_cast<T>(1.0e-3f)) {
        if (C_rate > static_cast<T>(0.0f)) {
            T ep_dot_star = (ep_dot > static_cast<T>(1.0f)) ? ep_dot : static_cast<T>(1.0f);
            strain_rate_factor += C_rate * log(ep_dot_star);
            if (strain_rate_factor < static_cast<T>(0.1f)) strain_rate_factor = static_cast<T>(0.1f);
        } else if (cs_C > static_cast<T>(0.0f) && cs_P > static_cast<T>(0.0f)) {
            strain_rate_factor += pow(ep_dot / cs_C, static_cast<T>(1.0f) / cs_P);
        }
    }

    T thermal_factor = static_cast<T>(1.0f);
    if (m_exp > static_cast<T>(0.0f) && T_melt > T_room) {
        T T_star = (elem.temperature - T_room) / (T_melt - T_room);
        T_star = (T_star < static_cast<T>(0.0f)) ? static_cast<T>(0.0f) : ((T_star > static_cast<T>(1.0f)) ? static_cast<T>(1.0f) : T_star);
        thermal_factor = static_cast<T>(1.0f) - pow(T_star, m_exp);
        if (thermal_factor < static_cast<T>(0.01f)) thermal_factor = static_cast<T>(0.01f);
    }
    dynamic_yield = (sigma_hard * strain_rate_factor * thermal_factor > static_cast<T>(1.0e6f)) ? (sigma_hard * strain_rate_factor * thermal_factor) : static_cast<T>(1.0e6f);

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
    // Mie-Grueneisen Shock EOS Hydrostatic Pressure
    T p_hydro = static_cast<T>(0.0f);
    if (mat.mg_c0 > static_cast<T>(0.0f) && mat.mg_gamma0 > static_cast<T>(0.0f)) {
        T c0 = static_cast<T>(mat.mg_c0);
        T s1 = static_cast<T>(mat.mg_s > 0.0f ? mat.mg_s : 1.49f);
        T gamma0 = static_cast<T>(mat.mg_gamma0);
        T mu = (elem.V > static_cast<T>(1.0e-18f) && elem.V0 > static_cast<T>(1.0e-18f))
             ? (elem.V0 / elem.V - static_cast<T>(1.0f))
             : static_cast<T>(0.0f);
        T E_v = density * (mat.Cp > 0.0f ? mat.Cp : 477.0f) * (elem.temperature - (mat.T_room > 0.0f ? mat.T_room : 293.0f));
        if (mu > static_cast<T>(0.0f)) {
            T denom = static_cast<T>(1.0f) - (s1 - static_cast<T>(1.0f)) * mu;
            if (denom > static_cast<T>(0.1f)) {
                p_hydro = (density * c0 * c0 * mu * (static_cast<T>(1.0f) + (static_cast<T>(1.0f) - static_cast<T>(0.5f) * gamma0) * mu)) / (denom * denom) + gamma0 * E_v;
            } else {
                p_hydro = K * mu + gamma0 * E_v;
            }
        } else {
            p_hydro = density * c0 * c0 * mu + gamma0 * E_v;
        }
        p_hydro += q_visc;
    } else {
        p_hydro = -K * vol_strain + q_visc;
    }
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            elem.s_dev[r][c] += static_cast<T>(2.0f) * G * d_dev[r][c] * dt;
        }
    }

    if (mat.material_model == MPMMaterialModel::RHTConcrete) {
        RHTStateVariables<T> rht_state;
        rht_state.damage = elem.damage;
        rht_state.ep_bar = elem.ep_bar;
        rht_state.p_hydro = p_hydro;
        updateRHTStress<T>(
            elem.s_dev, p_hydro, vol_strain, dt, h_e, ep_dot,
            static_cast<T>(mat.fc), static_cast<T>(mat.ft), G, K,
            static_cast<T>(mat.G_f), static_cast<T>(mat.moisture_content),
            static_cast<T>(mat.rht_A), static_cast<T>(mat.rht_N),
            static_cast<T>(mat.rht_B), static_cast<T>(mat.rht_M),
            static_cast<T>(mat.rht_Q0), static_cast<T>(mat.rht_BQ),
            static_cast<T>(mat.rht_D1), static_cast<T>(mat.rht_D2),
            static_cast<T>(mat.rht_p_crush), static_cast<T>(mat.rht_p_lock),
            static_cast<T>(mat.rht_alpha0), static_cast<T>(mat.rht_n_comp),
            static_cast<T>(mat.rht_betac), static_cast<T>(mat.rht_deltat),
            static_cast<T>(mat.dif_cap_compression), static_cast<T>(mat.dif_cap_tension),
            rht_state
        );
        elem.damage = rht_state.damage;
        elem.ep_bar = rht_state.ep_bar;
        p_hydro = rht_state.p_hydro;
    } else if (mat.material_model == MPMMaterialModel::KCConcrete) {
        KCStateVariables<T> kc_state;
        kc_state.damage = elem.damage;
        kc_state.lambda = elem.lambda;
        kc_state.ep_bar = elem.ep_bar;
        kc_state.p_hydro = p_hydro;
        updateKCStress<T>(
            elem.s_dev, p_hydro, vol_strain, dt, h_e, ep_dot,
            static_cast<T>(mat.fc), static_cast<T>(mat.ft), G, K,
            static_cast<T>(mat.G_f), static_cast<T>(mat.moisture_content),
            mat.kc_auto_generate,
            static_cast<T>(mat.kc_a0), static_cast<T>(mat.kc_a1), static_cast<T>(mat.kc_a2),
            static_cast<T>(mat.kc_a0y), static_cast<T>(mat.kc_a1y), static_cast<T>(mat.kc_a2y),
            static_cast<T>(mat.kc_a1r), static_cast<T>(mat.kc_a2r),
            static_cast<T>(mat.kc_b1), static_cast<T>(mat.kc_omega),
            static_cast<T>(mat.dif_cap_compression), static_cast<T>(mat.dif_cap_tension),
            kc_state
        );
        elem.damage = kc_state.damage;
        elem.lambda = kc_state.lambda;
        elem.ep_bar = kc_state.ep_bar;
        p_hydro = kc_state.p_hydro;
    } else if (mat.material_model == MPMMaterialModel::CSCMConcrete) {
        CSCMStateVariables<T> cscm_state;
        cscm_state.damage = elem.damage;
        cscm_state.kappa = elem.lambda;
        cscm_state.ep_bar = elem.ep_bar;
        cscm_state.p_hydro = p_hydro;
        updateCSCMStress<T>(
            elem.s_dev, p_hydro, vol_strain, dt, h_e, ep_dot,
            static_cast<T>(mat.fc), static_cast<T>(mat.ft), G, K,
            static_cast<T>(mat.G_f),
            static_cast<T>(mat.cscm_alpha), static_cast<T>(mat.cscm_theta),
            static_cast<T>(mat.cscm_lambda), static_cast<T>(mat.cscm_beta),
            static_cast<T>(mat.cscm_R), static_cast<T>(mat.cscm_X0),
            static_cast<T>(mat.cscm_W), static_cast<T>(mat.cscm_D1),
            static_cast<T>(mat.cscm_D2),
            static_cast<T>(mat.dif_cap_compression), static_cast<T>(mat.dif_cap_tension),
            cscm_state
        );
        elem.damage = cscm_state.damage;
        elem.lambda = cscm_state.kappa;
        elem.ep_bar = cscm_state.ep_bar;
        p_hydro = cscm_state.p_hydro;
    } else {
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
    FEMErosionCriteria<T> erosion_criteria,
    int* d_erosion_flag
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

    if (mat.enable_timestep_erosion && mat.timestep_erosion_factor > static_cast<T>(1.0e-5f)) {
        T eta = static_cast<T>(mat.timestep_erosion_factor > 0.0f ? mat.timestep_erosion_factor : erosion_criteria.timestep_erosion_factor);
        if (current_dt <= eta * elem.dt0) {
            newly_eroded = true;
        }
    }

    if (mat.enable_strain_erosion) {
        T fail_strain = static_cast<T>(mat.erosion_strain > 0.0f ? mat.erosion_strain : (mat.failure_strain > 0.0f ? mat.failure_strain : erosion_criteria.failure_strain));
        if (fail_strain > static_cast<T>(0.0f) && elem.ep_bar >= fail_strain) {
            newly_eroded = true;
        }
    }

    if (mat.enable_stress_erosion) {
        T mean_s = (elem.sigma[0][0] + elem.sigma[1][1] + elem.sigma[2][2]) / static_cast<T>(3.0f);
        T fail_stress = static_cast<T>(mat.erosion_stress > 0.0f ? mat.erosion_stress : (mat.tensile_failure_stress > 0.0f ? mat.tensile_failure_stress : erosion_criteria.tensile_failure_stress));
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
        if (d_erosion_flag) {
            *d_erosion_flag = 1;
        }
    }
}

// CUDA Kernel: Count active (non-eroded) elements attached to each node
template <typename T>
__global__ void fem_count_active_node_elements_kernel_device(
    const FEMElement3D<T>* d_elements,
    int num_elements,
    int* d_node_active_count,
    int num_nodes
) {
    int e = blockIdx.x * blockDim.x + threadIdx.x;
    if (e >= num_elements) return;
    const auto& elem = d_elements[e];
    if (elem.is_eroded) return;
    #pragma unroll
    for (int k = 0; k < 8; ++k) {
        int nid = elem.node_ids[k];
        if (nid >= 0 && nid < num_nodes) {
            ::atomicAdd(&d_node_active_count[nid], 1);
        }
    }
}

// CUDA Kernel: Neutralize orphan nodes whose connected elements have all eroded (matching CPU updateNodeErosionStatus)
template <typename T>
__global__ void fem_update_orphan_nodes_erosion_kernel_device(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    const int* d_node_active_count
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_nodes) return;
    if (!d_nodes[idx].is_eroded && d_node_active_count[idx] == 0 && d_nodes[idx].m > static_cast<T>(1.0e-12f)) {
        d_nodes[idx].is_eroded = true;
        d_nodes[idx].v[0] = static_cast<T>(0.0f);
        d_nodes[idx].v[1] = static_cast<T>(0.0f);
        d_nodes[idx].v[2] = static_cast<T>(0.0f);
        d_nodes[idx].a[0] = static_cast<T>(0.0f);
        d_nodes[idx].a[1] = static_cast<T>(0.0f);
        d_nodes[idx].a[2] = static_cast<T>(0.0f);
        d_nodes[idx].f_int[0] = static_cast<T>(0.0f);
        d_nodes[idx].f_int[1] = static_cast<T>(0.0f);
        d_nodes[idx].f_int[2] = static_cast<T>(0.0f);
        d_nodes[idx].f_contact[0] = static_cast<T>(0.0f);
        d_nodes[idx].f_contact[1] = static_cast<T>(0.0f);
        d_nodes[idx].f_contact[2] = static_cast<T>(0.0f);
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

// CUDA Kernel: Reset Nodal Contact Forces and Nodal Normal Accumulator
template <typename T>
__global__ void fem_reset_nodal_contact_forces_kernel_device(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    T* d_node_normals
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_nodes) return;
    d_nodes[idx].f_contact[0] = static_cast<T>(0.0f);
    d_nodes[idx].f_contact[1] = static_cast<T>(0.0f);
    d_nodes[idx].f_contact[2] = static_cast<T>(0.0f);
    if (d_node_normals) {
        d_node_normals[idx * 3 + 0] = static_cast<T>(0.0f);
        d_node_normals[idx * 3 + 1] = static_cast<T>(0.0f);
        d_node_normals[idx * 3 + 2] = static_cast<T>(0.0f);
    }
}

// CUDA Kernel: Dynamically update surface facet normals and areas on GPU
template <typename T>
__global__ void fem_update_surface_facets_kernel_3d_device(
    const FEMNode3D<T>* d_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    FEMFacet3D<T>* d_facets,
    int num_facets,
    T* d_node_normals
) {
    int f = blockIdx.x * blockDim.x + threadIdx.x;
    if (f >= num_facets) return;

    FEMFacet3D<T>& facet = d_facets[f];
    if (facet.is_eroded) return;
    if (facet.element_id >= 0 && facet.element_id < num_elements && d_elements && d_elements[facet.element_id].is_eroded) {
        facet.is_eroded = true;
        return;
    }

    const auto& n0 = d_nodes[facet.node_ids[0]];
    const auto& n1 = d_nodes[facet.node_ids[1]];
    const auto& n2 = d_nodes[facet.node_ids[2]];
    const auto& n3 = d_nodes[facet.node_ids[3]];

    T d1[3] = {n2.x[0] - n0.x[0], n2.x[1] - n0.x[1], n2.x[2] - n0.x[2]};
    T d2[3] = {n3.x[0] - n1.x[0], n3.x[1] - n1.x[1], n3.x[2] - n1.x[2]};

    T nx = d1[1] * d2[2] - d1[2] * d2[1];
    T ny = d1[2] * d2[0] - d1[0] * d2[2];
    T nz = d1[0] * d2[1] - d1[1] * d2[0];

    T len = sqrt(nx * nx + ny * ny + nz * nz);
    if (len > static_cast<T>(1.0e-12f)) {
        facet.normal[0] = nx / len;
        facet.normal[1] = ny / len;
        facet.normal[2] = nz / len;
        facet.area = static_cast<T>(0.5f) * len;

        if (d_node_normals) {
            T weighted_n[3] = {facet.area * facet.normal[0], facet.area * facet.normal[1], facet.area * facet.normal[2]};
            #pragma unroll
            for (int k = 0; k < 4; ++k) {
                int nid = facet.node_ids[k];
                atomicAdd(&d_node_normals[nid * 3 + 0], weighted_n[0]);
                atomicAdd(&d_node_normals[nid * 3 + 1], weighted_n[1]);
                atomicAdd(&d_node_normals[nid * 3 + 2], weighted_n[2]);
            }
        }
    }

    T min_fx = n0.x[0], max_fx = n0.x[0];
    T min_fy = n0.x[1], max_fy = n0.x[1];
    T min_fz = n0.x[2], max_fz = n0.x[2];

    #pragma unroll
    for (int k = 1; k < 4; ++k) {
        const auto& nk = (k == 1) ? n1 : ((k == 2) ? n2 : n3);
        if (nk.x[0] < min_fx) min_fx = nk.x[0];
        if (nk.x[0] > max_fx) max_fx = nk.x[0];
        if (nk.x[1] < min_fy) min_fy = nk.x[1];
        if (nk.x[1] > max_fy) max_fy = nk.x[1];
        if (nk.x[2] < min_fz) min_fz = nk.x[2];
        if (nk.x[2] > max_fz) max_fz = nk.x[2];
    }

    T h_elem = sqrt(facet.area > static_cast<T>(1.0e-24f) ? facet.area : static_cast<T>(1.0e-24f));
    T margin = static_cast<T>(0.8f) * h_elem;
    facet.bbox_min[0] = min_fx - margin;
    facet.bbox_min[1] = min_fy - margin;
    facet.bbox_min[2] = min_fz - margin;
    facet.bbox_max[0] = max_fx + margin;
    facet.bbox_max[1] = max_fy + margin;
    facet.bbox_max[2] = max_fz + margin;
}

// CUDA Kernel: Extract nodal positions and velocities directly to telemetry buffer on GPU
template <typename T>
__global__ void fem_extract_node_telemetry_kernel_3d_device(
    const FEMNode3D<T>* d_nodes,
    int num_nodes,
    float* d_node_out
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= num_nodes) return;

    const auto& node = d_nodes[i];
    float vx = static_cast<float>(node.v[0]);
    float vy = static_cast<float>(node.v[1]);
    float vz = static_cast<float>(node.v[2]);
    float v_mag = sqrtf(vx * vx + vy * vy + vz * vz);

    d_node_out[i * 7 + 0] = static_cast<float>(node.x[0]);
    d_node_out[i * 7 + 1] = static_cast<float>(node.x[1]);
    d_node_out[i * 7 + 2] = static_cast<float>(node.x[2]);
    d_node_out[i * 7 + 3] = vx;
    d_node_out[i * 7 + 4] = vy;
    d_node_out[i * 7 + 5] = vz;
    d_node_out[i * 7 + 6] = v_mag;
}

// CUDA Kernel: Extract surface facet stresses, plastic strain, and damage directly to telemetry buffer on GPU
template <typename T>
__global__ void fem_extract_facet_telemetry_kernel_3d_device(
    const FEMFacet3D<T>* d_facets,
    int num_facets,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    float* d_facet_out
) {
    int f = blockIdx.x * blockDim.x + threadIdx.x;
    if (f >= num_facets) return;

    const FEMFacet3D<T>& facet = d_facets[f];
    d_facet_out[f * 8 + 0] = static_cast<float>(facet.node_ids[0]);
    d_facet_out[f * 8 + 1] = static_cast<float>(facet.node_ids[1]);
    d_facet_out[f * 8 + 2] = static_cast<float>(facet.node_ids[2]);
    d_facet_out[f * 8 + 3] = static_cast<float>(facet.node_ids[3]);

    float vm = 0.0f, ep = 0.0f, press = 0.0f, dmg = 0.0f;
    int elem_idx = facet.element_id;
    if (elem_idx >= 0 && elem_idx < num_elements) {
        const auto& elem = d_elements[elem_idx];
        if (!elem.is_eroded) {
            float s00 = static_cast<float>(elem.sigma[0][0]);
            float s11 = static_cast<float>(elem.sigma[1][1]);
            float s22 = static_cast<float>(elem.sigma[2][2]);
            float s01 = static_cast<float>(elem.sigma[0][1]);
            float s02 = static_cast<float>(elem.sigma[0][2]);
            float s12 = static_cast<float>(elem.sigma[1][2]);
            press = -(s00 + s11 + s22) / 3.0f;
            float dev00 = s00 + press, dev11 = s11 + press, dev22 = s22 + press;
            float vm_sq = dev00 * dev00 + dev11 * dev11 + dev22 * dev22 + 2.0f * (s01 * s01 + s02 * s02 + s12 * s12);
            vm = sqrtf(fmaxf(0.0f, 1.5f * vm_sq));
            ep = static_cast<float>(elem.ep_bar);
            dmg = static_cast<float>(elem.damage);
        }
    }
    d_facet_out[f * 8 + 4] = vm;
    d_facet_out[f * 8 + 5] = ep;
    d_facet_out[f * 8 + 6] = press;
    d_facet_out[f * 8 + 7] = dmg;
}

// 3D Spatial Grid Hash Function
__device__ __host__ inline uint32_t hashCoords3D(int cx, int cy, int cz, uint32_t table_size) {
    const uint32_t p1 = 73856093u;
    const uint32_t p2 = 19349663u;
    const uint32_t p3 = 83492791u;
    uint32_t h = (static_cast<uint32_t>(cx) * p1) ^ (static_cast<uint32_t>(cy) * p2) ^ (static_cast<uint32_t>(cz) * p3);
    return h & (table_size - 1);
}

// CUDA Kernel: Insert surface facet bounding boxes into GPU uniform spatial hash grid
template <typename T>
__global__ void fem_build_spatial_hash_grid_kernel_3d_device(
    const FEMFacet3D<T>* d_facets,
    int num_facets,
    T inv_cell_size,
    int* d_cell_counts,
    int* d_cell_facet_ids,
    uint32_t table_size
) {
    int f = blockIdx.x * blockDim.x + threadIdx.x;
    if (f >= num_facets) return;

    const FEMFacet3D<T>& facet = d_facets[f];
    if (facet.is_eroded) return;

    int min_cx = static_cast<int>(floor(facet.bbox_min[0] * inv_cell_size));
    int max_cx = static_cast<int>(floor(facet.bbox_max[0] * inv_cell_size));
    int min_cy = static_cast<int>(floor(facet.bbox_min[1] * inv_cell_size));
    int max_cy = static_cast<int>(floor(facet.bbox_max[1] * inv_cell_size));
    int min_cz = static_cast<int>(floor(facet.bbox_min[2] * inv_cell_size));
    int max_cz = static_cast<int>(floor(facet.bbox_max[2] * inv_cell_size));

    if (max_cx - min_cx > 2) max_cx = min_cx + 2;
    if (max_cy - min_cy > 2) max_cy = min_cy + 2;
    if (max_cz - min_cz > 2) max_cz = min_cz + 2;

    for (int cz = min_cz; cz <= max_cz; ++cz) {
        for (int cy = min_cy; cy <= max_cy; ++cy) {
            for (int cx = min_cx; cx <= max_cx; ++cx) {
                uint32_t bucket = hashCoords3D(cx, cy, cz, table_size);
                int slot = ::atomicAdd(&d_cell_counts[bucket], 1);
                if (slot < 32) {
                    d_cell_facet_ids[bucket * 32 + slot] = f;
                }
            }
        }
    }
}

// CUDA Kernel: Exact Penalty Surface Contact and Coulomb Friction (Direct All-Pairs on GPU)
template <typename T>
__global__ void fem_contact_forces_direct_kernel_3d_device(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    const FEMFacet3D<T>* d_facets,
    int num_facets,
    const int* d_surface_nodes,
    int num_surface_nodes,
    const int* d_node_part_id,
    const int* d_part_mat_id,
    int max_parts,
    const T* d_node_normals,
    const MaterialTable3D* d_materials,
    T contact_penalty_scale,
    T mu_static,
    T mu_kinetic,
    T contact_damping,
    T dt
) {
    int sn_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (sn_idx >= num_surface_nodes) return;

    int nid = d_surface_nodes[sn_idx];
    if (nid < 0 || nid >= num_nodes) return;

    FEMNode3D<T>& node = d_nodes[nid];
    if (node.is_eroded || node.m <= static_cast<T>(1.0e-12f)) return;

    int n_part = d_node_part_id ? d_node_part_id[nid] : -1;

    T K_slave_node = static_cast<T>(160.0e9f);
    if (n_part >= 0 && n_part <= max_parts && d_part_mat_id && d_materials) {
        int mid = d_part_mat_id[n_part];
        if (mid >= 0) {
            const MaterialTable3D& mat = d_materials[mid];
            T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 210.0e9f);
            T nu = static_cast<T>(mat.poissons_ratio);
            T denom = static_cast<T>(1.0f) - static_cast<T>(2.0f) * nu;
            if (fabs(denom) > static_cast<T>(1.0e-4f)) {
                K_slave_node = E / (static_cast<T>(3.0f) * denom);
            }
        }
    }

    T n_node[3] = {static_cast<T>(0), static_cast<T>(0), static_cast<T>(0)};
    bool has_node_norm = false;
    if (d_node_normals) {
        T n_len = sqrt(d_node_normals[nid * 3 + 0]*d_node_normals[nid * 3 + 0] +
                       d_node_normals[nid * 3 + 1]*d_node_normals[nid * 3 + 1] +
                       d_node_normals[nid * 3 + 2]*d_node_normals[nid * 3 + 2]);
        if (n_len > static_cast<T>(1.0e-12f)) {
            n_node[0] = d_node_normals[nid * 3 + 0] / n_len;
            n_node[1] = d_node_normals[nid * 3 + 1] / n_len;
            n_node[2] = d_node_normals[nid * 3 + 2] / n_len;
            has_node_norm = true;
        }
    }

    T best_f_total = static_cast<T>(0.0f);
    T best_nx = static_cast<T>(0.0f), best_ny = static_cast<T>(0.0f), best_nz = static_cast<T>(0.0f);
    int best_fid = -1;
    T best_N[4] = {static_cast<T>(0), static_cast<T>(0), static_cast<T>(0), static_cast<T>(0)};
    T best_m_pair = static_cast<T>(0.0f);

    for (int f = 0; f < num_facets; ++f) {
        const FEMFacet3D<T>& facet = d_facets[f];
        if (facet.is_eroded) continue;

        if (facet.node_ids[0] == nid || facet.node_ids[1] == nid ||
            facet.node_ids[2] == nid || facet.node_ids[3] == nid) continue;

        if (n_part >= 0 && facet.part_id >= 0 && n_part == facet.part_id) continue;

        if (facet.element_id >= 0 && facet.element_id < num_elements) {
            if (d_elements[facet.element_id].is_eroded) continue;
            int f_part = d_elements[facet.element_id].part_id;
            if (n_part >= 0 && f_part >= 0 && n_part == f_part) continue;
        }

        if (has_node_norm) {
            T dot_norm = n_node[0]*facet.normal[0] + n_node[1]*facet.normal[1] + n_node[2]*facet.normal[2];
            if (dot_norm > static_cast<T>(-0.15f)) continue;
        }

        if (node.x[0] < facet.bbox_min[0] || node.x[0] > facet.bbox_max[0] ||
            node.x[1] < facet.bbox_min[1] || node.x[1] > facet.bbox_max[1] ||
            node.x[2] < facet.bbox_min[2] || node.x[2] > facet.bbox_max[2]) continue;

        const auto& n0 = d_nodes[facet.node_ids[0]];
        const auto& n1 = d_nodes[facet.node_ids[1]];
        const auto& n2 = d_nodes[facet.node_ids[2]];
        const auto& n3 = d_nodes[facet.node_ids[3]];

        T e1[3] = {n1.x[0] - n0.x[0], n1.x[1] - n0.x[1], n1.x[2] - n0.x[2]};
        T e3[3] = {n3.x[0] - n0.x[0], n3.x[1] - n0.x[1], n3.x[2] - n0.x[2]};
        T dx_v0[3] = {node.x[0] - n0.x[0], node.x[1] - n0.x[1], node.x[2] - n0.x[2]};

        T len1_sq = e1[0]*e1[0] + e1[1]*e1[1] + e1[2]*e1[2];
        T len3_sq = e3[0]*e3[0] + e3[1]*e3[1] + e3[2]*e3[2];
        T dot_e1_e3 = e1[0]*e3[0] + e1[1]*e3[1] + e1[2]*e3[2];

        T det_tangent = len1_sq * len3_sq - dot_e1_e3 * dot_e1_e3;
        T u_param = static_cast<T>(0.5f), v_param = static_cast<T>(0.5f);

        if (fabs(det_tangent) > static_cast<T>(1.0e-12f)) {
            T proj1 = dx_v0[0]*e1[0] + dx_v0[1]*e1[1] + dx_v0[2]*e1[2];
            T proj3 = dx_v0[0]*e3[0] + dx_v0[1]*e3[1] + dx_v0[2]*e3[2];
            T inv_det = static_cast<T>(1.0f) / det_tangent;
            u_param = (proj1 * len3_sq - proj3 * dot_e1_e3) * inv_det;
            v_param = (proj3 * len1_sq - proj1 * dot_e1_e3) * inv_det;
        } else {
            u_param = (len1_sq > static_cast<T>(1.0e-12f)) ? ((dx_v0[0]*e1[0] + dx_v0[1]*e1[1] + dx_v0[2]*e1[2]) / len1_sq) : static_cast<T>(0.5f);
            v_param = (len3_sq > static_cast<T>(1.0e-12f)) ? ((dx_v0[0]*e3[0] + dx_v0[1]*e3[1] + dx_v0[2]*e3[2]) / len3_sq) : static_cast<T>(0.5f);
        }

        if (u_param < static_cast<T>(-0.05f) || u_param > static_cast<T>(1.05f) ||
            v_param < static_cast<T>(-0.05f) || v_param > static_cast<T>(1.05f)) continue;

        T u_clamped = u_param < static_cast<T>(0.0f) ? static_cast<T>(0.0f) : (u_param > static_cast<T>(1.0f) ? static_cast<T>(1.0f) : u_param);
        T v_clamped = v_param < static_cast<T>(0.0f) ? static_cast<T>(0.0f) : (v_param > static_cast<T>(1.0f) ? static_cast<T>(1.0f) : v_param);

        T N_shape[4] = {
            (static_cast<T>(1.0f) - u_clamped) * (static_cast<T>(1.0f) - v_clamped),
            u_clamped * (static_cast<T>(1.0f) - v_clamped),
            u_clamped * v_clamped,
            (static_cast<T>(1.0f) - u_clamped) * v_clamped
        };

        T x_surf[3] = {
            N_shape[0]*n0.x[0] + N_shape[1]*n1.x[0] + N_shape[2]*n2.x[0] + N_shape[3]*n3.x[0],
            N_shape[0]*n0.x[1] + N_shape[1]*n1.x[1] + N_shape[2]*n2.x[1] + N_shape[3]*n3.x[1],
            N_shape[0]*n0.x[2] + N_shape[1]*n1.x[2] + N_shape[2]*n2.x[2] + N_shape[3]*n3.x[2]
        };

        T contact_normal[3] = {facet.normal[0], facet.normal[1], facet.normal[2]};

        T dx_surf[3] = {node.x[0] - x_surf[0], node.x[1] - x_surf[1], node.x[2] - x_surf[2]};
        T penetration = -(dx_surf[0]*contact_normal[0] + dx_surf[1]*contact_normal[1] + dx_surf[2]*contact_normal[2]);

        T h_elem = sqrt(facet.area > static_cast<T>(1.0e-24f) ? facet.area : static_cast<T>(1.0e-24f));
        if (facet.element_id >= 0 && facet.element_id < num_elements) {
            T elem_V = d_elements[facet.element_id].V;
            if (elem_V > static_cast<T>(1.0e-30f) && facet.area > static_cast<T>(1.0e-24f)) {
                h_elem = elem_V / facet.area;
            }
        }
        T max_penetration = static_cast<T>(0.35f) * h_elem;

        // Tangential offset check: Ensure node is physically over the facet and not far off the edge
        T dx_t0 = dx_surf[0] + penetration * contact_normal[0];
        T dx_t1 = dx_surf[1] + penetration * contact_normal[1];
        T dx_t2 = dx_surf[2] + penetration * contact_normal[2];
        T d_tangent_sq = dx_t0*dx_t0 + dx_t1*dx_t1 + dx_t2*dx_t2;
        if (d_tangent_sq > static_cast<T>(0.04f) * h_elem * h_elem) continue;

        if (penetration > static_cast<T>(0.0f) && penetration <= max_penetration) {
            T eff_penetration = (penetration < static_cast<T>(0.30f) * h_elem) ? penetration : static_cast<T>(0.30f) * h_elem;

            T K_master = static_cast<T>(160.0e9f);
            if (facet.element_id >= 0 && facet.element_id < num_elements) {
                int mid = d_elements[facet.element_id].mat_id;
                const MaterialTable3D& mat = d_materials[mid];
                T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 210.0e9f);
                T nu = static_cast<T>(mat.poissons_ratio);
                T denom = static_cast<T>(1.0f) - static_cast<T>(2.0f) * nu;
                if (fabs(denom) > static_cast<T>(1.0e-4f)) {
                    K_master = E / (static_cast<T>(3.0f) * denom);
                }
            }

            T K_slave = K_slave_node;
            T K_interface = (static_cast<T>(2.0f) * K_master * K_slave) / (K_master + K_slave + static_cast<T>(1.0e-30f));
            T k_stiff = contact_penalty_scale * K_interface * h_elem;
            T f_spring = k_stiff * eff_penetration;

            T m_facet_avg = static_cast<T>(0.25f) * (n0.m + n1.m + n2.m + n3.m);
            T m_sum = node.m + m_facet_avg;
            T m_pair = (m_sum > static_cast<T>(1.0e-30f)) ? (node.m * m_facet_avg / m_sum) : static_cast<T>(1.0e-30f);

            T vf0 = N_shape[0]*n0.v[0] + N_shape[1]*n1.v[0] + N_shape[2]*n2.v[0] + N_shape[3]*n3.v[0];
            T vf1 = N_shape[0]*n0.v[1] + N_shape[1]*n1.v[1] + N_shape[2]*n2.v[1] + N_shape[3]*n3.v[1];
            T vf2 = N_shape[0]*n0.v[2] + N_shape[1]*n1.v[2] + N_shape[2]*n2.v[2] + N_shape[3]*n3.v[2];
            T v_rel_n = (node.v[0] - vf0)*contact_normal[0] + (node.v[1] - vf1)*contact_normal[1] + (node.v[2] - vf2)*contact_normal[2];

            T f_damp = static_cast<T>(0.0f);
            if (v_rel_n < static_cast<T>(0.0f)) {
                T c = static_cast<T>(2.0f) * contact_damping * sqrt(k_stiff * m_pair);
                f_damp = -c * v_rel_n;
            }

            T f_total = f_spring + f_damp;
            T v_limit = (static_cast<T>(2.0f) * fabs(v_rel_n) > static_cast<T>(20.0f)) ? static_cast<T>(2.0f) * fabs(v_rel_n) : static_cast<T>(20.0f);
            T f_max = m_pair * v_limit / (dt > static_cast<T>(1.0e-12f) ? dt : static_cast<T>(1.0e-12f));
            if (f_total > f_max) f_total = f_max;

            if (f_total > best_f_total) {
                best_f_total = f_total;
                best_nx = contact_normal[0];
                best_ny = contact_normal[1];
                best_nz = contact_normal[2];
                best_fid = f;
                best_N[0] = N_shape[0];
                best_N[1] = N_shape[1];
                best_N[2] = N_shape[2];
                best_N[3] = N_shape[3];
                best_m_pair = m_pair;
            }
        }
    }

    if (best_fid >= 0 && best_f_total > static_cast<T>(0.0f)) {
        const FEMFacet3D<T>& facet = d_facets[best_fid];
        const auto& n0 = d_nodes[facet.node_ids[0]];
        const auto& n1 = d_nodes[facet.node_ids[1]];
        const auto& n2 = d_nodes[facet.node_ids[2]];
        const auto& n3 = d_nodes[facet.node_ids[3]];

        T vf0 = best_N[0]*n0.v[0] + best_N[1]*n1.v[0] + best_N[2]*n2.v[0] + best_N[3]*n3.v[0];
        T vf1 = best_N[0]*n0.v[1] + best_N[1]*n1.v[1] + best_N[2]*n2.v[1] + best_N[3]*n3.v[1];
        T vf2 = best_N[0]*n0.v[2] + best_N[1]*n1.v[2] + best_N[2]*n2.v[2] + best_N[3]*n3.v[2];

        T v_rel[3] = {node.v[0] - vf0, node.v[1] - vf1, node.v[2] - vf2};
        T v_rel_n = v_rel[0]*best_nx + v_rel[1]*best_ny + v_rel[2]*best_nz;

        T v_rel_t[3] = {
            v_rel[0] - v_rel_n * best_nx,
            v_rel[1] - v_rel_n * best_ny,
            v_rel[2] - v_rel_n * best_nz
        };
        T vt_mag = sqrt(v_rel_t[0]*v_rel_t[0] + v_rel_t[1]*v_rel_t[1] + v_rel_t[2]*v_rel_t[2]);

        T f_fric[3] = {static_cast<T>(0), static_cast<T>(0), static_cast<T>(0)};
        if (vt_mag > static_cast<T>(1.0e-6f) && (mu_static > static_cast<T>(0.0f) || mu_kinetic > static_cast<T>(0.0f))) {
            T t_dir[3] = {v_rel_t[0] / vt_mag, v_rel_t[1] / vt_mag, v_rel_t[2] / vt_mag};
            T mu_eff = mu_kinetic + (mu_static - mu_kinetic) * exp(-static_cast<T>(10.0f) * vt_mag);
            T f_fric_mag = mu_eff * best_f_total;
            T f_stick_max = best_m_pair * vt_mag / (dt > static_cast<T>(1.0e-12f) ? dt : static_cast<T>(1.0e-12f));
            if (f_fric_mag > f_stick_max) f_fric_mag = f_stick_max;

            f_fric[0] = -f_fric_mag * t_dir[0];
            f_fric[1] = -f_fric_mag * t_dir[1];
            f_fric[2] = -f_fric_mag * t_dir[2];
        }

        T f_tot[3] = {
            best_f_total * best_nx + f_fric[0],
            best_f_total * best_ny + f_fric[1],
            best_f_total * best_nz + f_fric[2]
        };

        atomicAdd(&d_nodes[nid].f_contact[0], f_tot[0]);
        atomicAdd(&d_nodes[nid].f_contact[1], f_tot[1]);
        atomicAdd(&d_nodes[nid].f_contact[2], f_tot[2]);

        #pragma unroll
        for (int k = 0; k < 4; ++k) {
            int fnid = facet.node_ids[k];
            T N_k = best_N[k];
            atomicAdd(&d_nodes[fnid].f_contact[0], -N_k * f_tot[0]);
            atomicAdd(&d_nodes[fnid].f_contact[1], -N_k * f_tot[1]);
            atomicAdd(&d_nodes[fnid].f_contact[2], -N_k * f_tot[2]);
        }
    }
}

// CUDA Kernel: Penalty Surface Contact and Coulomb Friction using GPU Spatial Hash Grid (O(1) lookups)
template <typename T>
__global__ void fem_contact_forces_spatial_grid_kernel_3d_device(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    const FEMFacet3D<T>* d_facets,
    int num_facets,
    const int* d_surface_nodes,
    int num_surface_nodes,
    const int* d_node_part_id,
    const int* d_part_mat_id,
    int max_parts,
    const T* d_node_normals,
    const MaterialTable3D* d_materials,
    const int* d_cell_counts,
    const int* d_cell_facet_ids,
    uint32_t table_size,
    T inv_cell_size,
    T contact_penalty_scale,
    T mu_static,
    T mu_kinetic,
    T contact_damping,
    T dt
) {
    int sn_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (sn_idx >= num_surface_nodes) return;

    int nid = d_surface_nodes[sn_idx];
    if (nid < 0 || nid >= num_nodes) return;

    FEMNode3D<T>& node = d_nodes[nid];
    if (node.is_eroded || node.m <= static_cast<T>(1.0e-12f)) return;

    int n_part = d_node_part_id ? d_node_part_id[nid] : -1;

    T K_slave_node = static_cast<T>(160.0e9f);
    if (n_part >= 0 && n_part <= max_parts && d_part_mat_id && d_materials) {
        int mid = d_part_mat_id[n_part];
        if (mid >= 0) {
            const MaterialTable3D& mat = d_materials[mid];
            T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 210.0e9f);
            T nu = static_cast<T>(mat.poissons_ratio);
            T denom = static_cast<T>(1.0f) - static_cast<T>(2.0f) * nu;
            if (fabs(denom) > static_cast<T>(1.0e-4f)) {
                K_slave_node = E / (static_cast<T>(3.0f) * denom);
            }
        }
    }

    T n_node[3] = {static_cast<T>(0), static_cast<T>(0), static_cast<T>(0)};
    bool has_node_norm = false;
    if (d_node_normals) {
        T n_len = sqrt(d_node_normals[nid * 3 + 0]*d_node_normals[nid * 3 + 0] +
                       d_node_normals[nid * 3 + 1]*d_node_normals[nid * 3 + 1] +
                       d_node_normals[nid * 3 + 2]*d_node_normals[nid * 3 + 2]);
        if (n_len > static_cast<T>(1.0e-12f)) {
            n_node[0] = d_node_normals[nid * 3 + 0] / n_len;
            n_node[1] = d_node_normals[nid * 3 + 1] / n_len;
            n_node[2] = d_node_normals[nid * 3 + 2] / n_len;
            has_node_norm = true;
        }
    }

    T best_f_total = static_cast<T>(0.0f);
    T best_nx = static_cast<T>(0.0f), best_ny = static_cast<T>(0.0f), best_nz = static_cast<T>(0.0f);
    int best_fid = -1;
    T best_N[4] = {static_cast<T>(0), static_cast<T>(0), static_cast<T>(0), static_cast<T>(0)};
    T best_m_pair = static_cast<T>(0.0f);

    int node_cx = static_cast<int>(floor(node.x[0] * inv_cell_size));
    int node_cy = static_cast<int>(floor(node.x[1] * inv_cell_size));
    int node_cz = static_cast<int>(floor(node.x[2] * inv_cell_size));

    #pragma unroll 1
    for (int dz = -1; dz <= 1; ++dz) {
        for (int dy = -1; dy <= 1; ++dy) {
            for (int dx = -1; dx <= 1; ++dx) {
                uint32_t bucket = hashCoords3D(node_cx + dx, node_cy + dy, node_cz + dz, table_size);
                int count = d_cell_counts[bucket];
                if (count > 32) count = 32;

                for (int slot = 0; slot < count; ++slot) {
                    int f = d_cell_facet_ids[bucket * 32 + slot];
                    if (f < 0 || f >= num_facets) continue;

                    const FEMFacet3D<T>& facet = d_facets[f];
                    if (facet.is_eroded) continue;

                    if (facet.node_ids[0] == nid || facet.node_ids[1] == nid ||
                        facet.node_ids[2] == nid || facet.node_ids[3] == nid) continue;

                    if (n_part >= 0 && facet.part_id >= 0 && n_part == facet.part_id) continue;

                    if (facet.element_id >= 0 && facet.element_id < num_elements) {
                        if (d_elements[facet.element_id].is_eroded) continue;
                        int f_part = d_elements[facet.element_id].part_id;
                        if (n_part >= 0 && f_part >= 0 && n_part == f_part) continue;
                    }

                    if (has_node_norm) {
                        T dot_norm = n_node[0]*facet.normal[0] + n_node[1]*facet.normal[1] + n_node[2]*facet.normal[2];
                        if (dot_norm > static_cast<T>(0.707f)) continue;
                    }

                    if (node.x[0] < facet.bbox_min[0] || node.x[0] > facet.bbox_max[0] ||
                        node.x[1] < facet.bbox_min[1] || node.x[1] > facet.bbox_max[1] ||
                        node.x[2] < facet.bbox_min[2] || node.x[2] > facet.bbox_max[2]) continue;

                    const auto& n0 = d_nodes[facet.node_ids[0]];
                    const auto& n1 = d_nodes[facet.node_ids[1]];
                    const auto& n2 = d_nodes[facet.node_ids[2]];
                    const auto& n3 = d_nodes[facet.node_ids[3]];

                    T e1[3] = {n1.x[0] - n0.x[0], n1.x[1] - n0.x[1], n1.x[2] - n0.x[2]};
                    T e3[3] = {n3.x[0] - n0.x[0], n3.x[1] - n0.x[1], n3.x[2] - n0.x[2]};
                    T dx_v0[3] = {node.x[0] - n0.x[0], node.x[1] - n0.x[1], node.x[2] - n0.x[2]};

                    T len1_sq = e1[0]*e1[0] + e1[1]*e1[1] + e1[2]*e1[2];
                    T len3_sq = e3[0]*e3[0] + e3[1]*e3[1] + e3[2]*e3[2];
                    T dot_e1_e3 = e1[0]*e3[0] + e1[1]*e3[1] + e1[2]*e3[2];

                    T det_tangent = len1_sq * len3_sq - dot_e1_e3 * dot_e1_e3;
                    T u_param = static_cast<T>(0.5f), v_param = static_cast<T>(0.5f);

                    if (fabs(det_tangent) > static_cast<T>(1.0e-12f)) {
                        T proj1 = dx_v0[0]*e1[0] + dx_v0[1]*e1[1] + dx_v0[2]*e1[2];
                        T proj3 = dx_v0[0]*e3[0] + dx_v0[1]*e3[1] + dx_v0[2]*e3[2];
                        T inv_det = static_cast<T>(1.0f) / det_tangent;
                        u_param = (proj1 * len3_sq - proj3 * dot_e1_e3) * inv_det;
                        v_param = (proj3 * len1_sq - proj1 * dot_e1_e3) * inv_det;
                    } else {
                        u_param = (len1_sq > static_cast<T>(1.0e-12f)) ? ((dx_v0[0]*e1[0] + dx_v0[1]*e1[1] + dx_v0[2]*e1[2]) / len1_sq) : static_cast<T>(0.5f);
                        v_param = (len3_sq > static_cast<T>(1.0e-12f)) ? ((dx_v0[0]*e3[0] + dx_v0[1]*e3[1] + dx_v0[2]*e3[2]) / len3_sq) : static_cast<T>(0.5f);
                    }

                    if (u_param < static_cast<T>(-0.05f) || u_param > static_cast<T>(1.05f) ||
                        v_param < static_cast<T>(-0.05f) || v_param > static_cast<T>(1.05f)) continue;

                    T u_clamped = u_param < static_cast<T>(0.0f) ? static_cast<T>(0.0f) : (u_param > static_cast<T>(1.0f) ? static_cast<T>(1.0f) : u_param);
                    T v_clamped = v_param < static_cast<T>(0.0f) ? static_cast<T>(0.0f) : (v_param > static_cast<T>(1.0f) ? static_cast<T>(1.0f) : v_param);

                    T N_shape[4] = {
                        (static_cast<T>(1.0f) - u_clamped) * (static_cast<T>(1.0f) - v_clamped),
                        u_clamped * (static_cast<T>(1.0f) - v_clamped),
                        u_clamped * v_clamped,
                        (static_cast<T>(1.0f) - u_clamped) * v_clamped
                    };

                    T x_surf[3] = {
                        N_shape[0]*n0.x[0] + N_shape[1]*n1.x[0] + N_shape[2]*n2.x[0] + N_shape[3]*n3.x[0],
                        N_shape[0]*n0.x[1] + N_shape[1]*n1.x[1] + N_shape[2]*n2.x[1] + N_shape[3]*n3.x[1],
                        N_shape[0]*n0.x[2] + N_shape[1]*n1.x[2] + N_shape[2]*n2.x[2] + N_shape[3]*n3.x[2]
                    };

                    T contact_normal[3] = {facet.normal[0], facet.normal[1], facet.normal[2]};

                    T dx_surf[3] = {node.x[0] - x_surf[0], node.x[1] - x_surf[1], node.x[2] - x_surf[2]};
                    T penetration = -(dx_surf[0]*contact_normal[0] + dx_surf[1]*contact_normal[1] + dx_surf[2]*contact_normal[2]);

                    T h_elem = sqrt(facet.area > static_cast<T>(1.0e-24f) ? facet.area : static_cast<T>(1.0e-24f));
                    if (facet.element_id >= 0 && facet.element_id < num_elements) {
                        T elem_V = d_elements[facet.element_id].V;
                        if (elem_V > static_cast<T>(1.0e-30f) && facet.area > static_cast<T>(1.0e-24f)) {
                            h_elem = elem_V / facet.area;
                        }
                    }
                    T max_penetration = static_cast<T>(0.35f) * h_elem;

                    // Tangential offset check: Ensure node is physically over the facet and not far off the edge
                    T dx_t0 = dx_surf[0] + penetration * contact_normal[0];
                    T dx_t1 = dx_surf[1] + penetration * contact_normal[1];
                    T dx_t2 = dx_surf[2] + penetration * contact_normal[2];
                    T d_tangent_sq = dx_t0*dx_t0 + dx_t1*dx_t1 + dx_t2*dx_t2;
                    if (d_tangent_sq > static_cast<T>(0.04f) * h_elem * h_elem) continue;

                    if (penetration > static_cast<T>(0.0f) && penetration <= max_penetration) {
                        T eff_penetration = (penetration < static_cast<T>(0.30f) * h_elem) ? penetration : static_cast<T>(0.30f) * h_elem;

                        T K_master = static_cast<T>(160.0e9f);
                        if (facet.element_id >= 0 && facet.element_id < num_elements) {
                            int mid = d_elements[facet.element_id].mat_id;
                            const MaterialTable3D& mat = d_materials[mid];
                            T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 210.0e9f);
                            T nu = static_cast<T>(mat.poissons_ratio);
                            T denom = static_cast<T>(1.0f) - static_cast<T>(2.0f) * nu;
                            if (fabs(denom) > static_cast<T>(1.0e-4f)) {
                                K_master = E / (static_cast<T>(3.0f) * denom);
                            }
                        }

                        T K_slave = K_slave_node;
                        T K_interface = (static_cast<T>(2.0f) * K_master * K_slave) / (K_master + K_slave + static_cast<T>(1.0e-30f));
                        T k_stiff = contact_penalty_scale * K_interface * h_elem;
                        T f_spring = k_stiff * eff_penetration;

                        T m_facet_avg = static_cast<T>(0.25f) * (n0.m + n1.m + n2.m + n3.m);
                        T m_sum = node.m + m_facet_avg;
                        T m_pair = (m_sum > static_cast<T>(1.0e-30f)) ? (node.m * m_facet_avg / m_sum) : static_cast<T>(1.0e-30f);

                        T vf0 = N_shape[0]*n0.v[0] + N_shape[1]*n1.v[0] + N_shape[2]*n2.v[0] + N_shape[3]*n3.v[0];
                        T vf1 = N_shape[0]*n0.v[1] + N_shape[1]*n1.v[1] + N_shape[2]*n2.v[1] + N_shape[3]*n3.v[1];
                        T vf2 = N_shape[0]*n0.v[2] + N_shape[1]*n1.v[2] + N_shape[2]*n2.v[2] + N_shape[3]*n3.v[2];
                        T v_rel_n = (node.v[0] - vf0)*contact_normal[0] + (node.v[1] - vf1)*contact_normal[1] + (node.v[2] - vf2)*contact_normal[2];

                        T f_damp = static_cast<T>(0.0f);
                        if (v_rel_n < static_cast<T>(0.0f)) {
                            T c = static_cast<T>(2.0f) * contact_damping * sqrt(k_stiff * m_pair);
                            f_damp = -c * v_rel_n;
                        }

                        T f_total = f_spring + f_damp;
                        T v_limit = (static_cast<T>(2.0f) * fabs(v_rel_n) > static_cast<T>(20.0f)) ? static_cast<T>(2.0f) * fabs(v_rel_n) : static_cast<T>(20.0f);
                        T f_max = m_pair * v_limit / (dt > static_cast<T>(1.0e-12f) ? dt : static_cast<T>(1.0e-12f));
                        if (f_total > f_max) f_total = f_max;

                        if (f_total > best_f_total) {
                            best_f_total = f_total;
                            best_nx = contact_normal[0];
                            best_ny = contact_normal[1];
                            best_nz = contact_normal[2];
                            best_fid = f;
                            best_N[0] = N_shape[0];
                            best_N[1] = N_shape[1];
                            best_N[2] = N_shape[2];
                            best_N[3] = N_shape[3];
                            best_m_pair = m_pair;
                        }
                    }
                }
            }
        }
    }

    if (best_fid >= 0 && best_f_total > static_cast<T>(0.0f)) {
        const FEMFacet3D<T>& facet = d_facets[best_fid];
        const auto& n0 = d_nodes[facet.node_ids[0]];
        const auto& n1 = d_nodes[facet.node_ids[1]];
        const auto& n2 = d_nodes[facet.node_ids[2]];
        const auto& n3 = d_nodes[facet.node_ids[3]];

        T vf0 = best_N[0]*n0.v[0] + best_N[1]*n1.v[0] + best_N[2]*n2.v[0] + best_N[3]*n3.v[0];
        T vf1 = best_N[0]*n0.v[1] + best_N[1]*n1.v[1] + best_N[2]*n2.v[1] + best_N[3]*n3.v[1];
        T vf2 = best_N[0]*n0.v[2] + best_N[1]*n1.v[2] + best_N[2]*n2.v[2] + best_N[3]*n3.v[2];

        T v_rel[3] = {node.v[0] - vf0, node.v[1] - vf1, node.v[2] - vf2};
        T v_rel_n = v_rel[0]*best_nx + v_rel[1]*best_ny + v_rel[2]*best_nz;

        T v_rel_t[3] = {
            v_rel[0] - v_rel_n * best_nx,
            v_rel[1] - v_rel_n * best_ny,
            v_rel[2] - v_rel_n * best_nz
        };
        T vt_mag = sqrt(v_rel_t[0]*v_rel_t[0] + v_rel_t[1]*v_rel_t[1] + v_rel_t[2]*v_rel_t[2]);

        T f_fric[3] = {static_cast<T>(0), static_cast<T>(0), static_cast<T>(0)};
        if (vt_mag > static_cast<T>(1.0e-6f) && (mu_static > static_cast<T>(0.0f) || mu_kinetic > static_cast<T>(0.0f))) {
            T t_dir[3] = {v_rel_t[0] / vt_mag, v_rel_t[1] / vt_mag, v_rel_t[2] / vt_mag};
            T mu_eff = mu_kinetic + (mu_static - mu_kinetic) * exp(-static_cast<T>(10.0f) * vt_mag);
            T f_fric_mag = mu_eff * best_f_total;
            T f_stick_max = best_m_pair * vt_mag / (dt > static_cast<T>(1.0e-12f) ? dt : static_cast<T>(1.0e-12f));
            if (f_fric_mag > f_stick_max) f_fric_mag = f_stick_max;

            f_fric[0] = -f_fric_mag * t_dir[0];
            f_fric[1] = -f_fric_mag * t_dir[1];
            f_fric[2] = -f_fric_mag * t_dir[2];
        }

        T f_tot[3] = {
            best_f_total * best_nx + f_fric[0],
            best_f_total * best_ny + f_fric[1],
            best_f_total * best_nz + f_fric[2]
        };

        atomicAdd(&d_nodes[nid].f_contact[0], f_tot[0]);
        atomicAdd(&d_nodes[nid].f_contact[1], f_tot[1]);
        atomicAdd(&d_nodes[nid].f_contact[2], f_tot[2]);

        #pragma unroll
        for (int k = 0; k < 4; ++k) {
            int fnid = facet.node_ids[k];
            T N_k = best_N[k];
            atomicAdd(&d_nodes[fnid].f_contact[0], -N_k * f_tot[0]);
            atomicAdd(&d_nodes[fnid].f_contact[1], -N_k * f_tot[1]);
            atomicAdd(&d_nodes[fnid].f_contact[2], -N_k * f_tot[2]);
        }
    }
}

// CUDA Kernel: Compute minimum stable timestep size on GPU
template <typename T>
__global__ void fem_compute_step_size_kernel_3d_device(
    const FEMNode3D<T>* d_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    const MaterialTable3D* d_materials,
    T cfl,
    T* d_block_min_dt
) {
    extern __shared__ char s_mem[];
    T* s_dt = reinterpret_cast<T*>(s_mem);

    int tid = threadIdx.x;
    int e = blockIdx.x * blockDim.x + threadIdx.x;

    T dt_elem = static_cast<T>(1.0e30f);

    if (e < num_elements) {
        const FEMElement3D<T>& elem = d_elements[e];
        if (!elem.is_eroded) {
            static const int HEX8_EDGES_DEV[12][2] = {
                {0,1}, {1,2}, {2,3}, {3,0},
                {4,5}, {5,6}, {6,7}, {7,4},
                {0,4}, {1,5}, {2,6}, {3,7}
            };
            T h_min_sq = static_cast<T>(1.0e30f);
            #pragma unroll
            for (int edge = 0; edge < 12; ++edge) {
                int n1 = elem.node_ids[HEX8_EDGES_DEV[edge][0]];
                int n2 = elem.node_ids[HEX8_EDGES_DEV[edge][1]];
                T edx = d_nodes[n1].x[0] - d_nodes[n2].x[0];
                T edy = d_nodes[n1].x[1] - d_nodes[n2].x[1];
                T edz = d_nodes[n1].x[2] - d_nodes[n2].x[2];
                T len_sq = edx*edx + edy*edy + edz*edz;
                if (len_sq < h_min_sq) h_min_sq = len_sq;
            }
            T h_min = sqrt(h_min_sq);

            const MaterialTable3D& mat = d_materials[elem.mat_id];
            T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 210.0e9f);
            T nu = static_cast<T>(mat.poissons_ratio);
            T density = static_cast<T>(mat.density > 0.0f ? mat.density : 7850.0f);
            T G = E / (static_cast<T>(2.0f) * (static_cast<T>(1.0f) + nu));
            T K = E / (static_cast<T>(3.0f) * (static_cast<T>(1.0f) - static_cast<T>(2.0f) * nu));
            if (mat.material_model == MPMMaterialModel::RHTConcrete || mat.material_model == MPMMaterialModel::KCConcrete || mat.material_model == MPMMaterialModel::CSCMConcrete) {
                K *= static_cast<T>(1.6f);
            }
            T cd = sqrt((K + static_cast<T>(4.0f) / static_cast<T>(3.0f) * G) / density);

            if (cd > static_cast<T>(1.0e-6f)) {
                dt_elem = cfl * (h_min / cd);
            }
        }
    }

    s_dt[tid] = dt_elem;
    __syncthreads();

    // Block reduction
    for (unsigned int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s) {
            if (s_dt[tid + s] < s_dt[tid]) {
                s_dt[tid] = s_dt[tid + s];
            }
        }
        __syncthreads();
    }

    if (tid == 0) {
        d_block_min_dt[blockIdx.x] = s_dt[0];
    }
}

// CUDA Kernel: 2nd Stage Block-to-Scalar Reduction for Minimum Timestep
template <typename T>
__global__ void fem_reduce_min_kernel_device(
    const T* d_in,
    int n,
    T* d_out
) {
    extern __shared__ char s_mem_reduce[];
    T* s_data = reinterpret_cast<T*>(s_mem_reduce);

    int tid = threadIdx.x;
    T val = static_cast<T>(1.0e30f);
    for (int i = tid; i < n; i += blockDim.x) {
        T x = d_in[i];
        if (x < val) val = x;
    }
    s_data[tid] = val;
    __syncthreads();

    for (unsigned int s = blockDim.x / 2; s > 0; s >>= 1) {
        if (tid < s) {
            if (s_data[tid + s] < s_data[tid]) {
                s_data[tid] = s_data[tid + s];
            }
        }
        __syncthreads();
    }

    if (tid == 0) {
        d_out[0] = s_data[0];
    }
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
    int num_nodes,
    FEMElement3D<T>* d_elements,
    int num_elements,
    const MaterialTable3D* d_materials,
    FEMErosionCriteria<T> erosion_criteria,
    int* d_node_active_count,
    int* d_erosion_flag,
    cudaStream_t stream
) {
    if (num_elements <= 0) return;
    if (d_erosion_flag) {
        cudaMemsetAsync(d_erosion_flag, 0, sizeof(int), stream);
    }
    int block_size = 256;
    int grid_size = (num_elements + block_size - 1) / block_size;
    fem_initial_timestep_erosion_kernel_3d_device<T><<<grid_size, block_size, 0, stream>>>(
        d_nodes, d_elements, num_elements, d_materials, erosion_criteria, d_erosion_flag
    );

    if (num_nodes > 0 && d_node_active_count) {
        cudaMemsetAsync(d_node_active_count, 0, sizeof(int) * num_nodes, stream);
        fem_count_active_node_elements_kernel_device<T><<<grid_size, block_size, 0, stream>>>(
            d_elements, num_elements, d_node_active_count, num_nodes
        );
        int node_grid_size = (num_nodes + block_size - 1) / block_size;
        fem_update_orphan_nodes_erosion_kernel_device<T><<<node_grid_size, block_size, 0, stream>>>(
            d_nodes, num_nodes, d_node_active_count
        );
    }
}

template <typename T>
void launch_fem_update_surface_facets_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    FEMFacet3D<T>* d_facets,
    int num_facets,
    T* d_node_normals,
    cudaStream_t stream
) {
    if (num_facets <= 0) return;
    int block_size = 256;
    if (num_nodes > 0) {
        int grid_size_nodes = (num_nodes + block_size - 1) / block_size;
        fem_reset_nodal_contact_forces_kernel_device<T><<<grid_size_nodes, block_size, 0, stream>>>(
            d_nodes, num_nodes, d_node_normals
        );
    }
    int grid_size = (num_facets + block_size - 1) / block_size;
    fem_update_surface_facets_kernel_3d_device<T><<<grid_size, block_size, 0, stream>>>(
        d_nodes, d_elements, num_elements, d_facets, num_facets, d_node_normals
    );
}

template <typename T>
void launch_fem_contact_forces_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    const FEMFacet3D<T>* d_facets,
    int num_facets,
    const int* d_surface_nodes,
    int num_surface_nodes,
    const int* d_node_part_id,
    const int* d_part_mat_id,
    int max_parts,
    const T* d_node_normals,
    const MaterialTable3D* d_materials,
    int* d_cell_counts,
    int* d_cell_facet_ids,
    uint32_t table_size,
    T inv_cell_size,
    T contact_penalty_scale,
    T mu_static,
    T mu_kinetic,
    T contact_damping,
    T dt,
    cudaStream_t stream
) {
    if (num_surface_nodes <= 0 || num_facets <= 0) return;
    int block_size = 256;
    int sn_grid_size = (num_surface_nodes + block_size - 1) / block_size;

    if (num_facets <= 131072) {
        fem_contact_forces_direct_kernel_3d_device<T><<<sn_grid_size, block_size, 0, stream>>>(
            d_nodes, num_nodes, d_elements, num_elements, d_facets, num_facets,
            d_surface_nodes, num_surface_nodes, d_node_part_id, d_part_mat_id, max_parts,
            d_node_normals, d_materials, contact_penalty_scale, mu_static, mu_kinetic, contact_damping, dt
        );
    } else {
        if (d_cell_counts && d_cell_facet_ids && table_size > 0) {
            cudaMemsetAsync(d_cell_counts, 0, sizeof(int) * table_size, stream);
            int facet_grid_size = (num_facets + block_size - 1) / block_size;
            fem_build_spatial_hash_grid_kernel_3d_device<T><<<facet_grid_size, block_size, 0, stream>>>(
                d_facets, num_facets, inv_cell_size, d_cell_counts, d_cell_facet_ids, table_size
            );
        }
        fem_contact_forces_spatial_grid_kernel_3d_device<T><<<sn_grid_size, block_size, 0, stream>>>(
            d_nodes, num_nodes, d_elements, num_elements, d_facets, num_facets,
            d_surface_nodes, num_surface_nodes, d_node_part_id, d_part_mat_id, max_parts,
            d_node_normals, d_materials, d_cell_counts, d_cell_facet_ids, table_size, inv_cell_size,
            contact_penalty_scale, mu_static, mu_kinetic, contact_damping, dt
        );
    }
}

template <typename T>
T launch_fem_compute_step_size_kernel_3d(
    const FEMNode3D<T>* d_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    const MaterialTable3D* d_materials,
    T cfl,
    T* d_reduction_buffer,
    cudaStream_t stream
) {
    if (num_elements <= 0) return static_cast<T>(1.0e-6f);
    int block_size = 256;
    int grid_size = (num_elements + block_size - 1) / block_size;
    
    fem_compute_step_size_kernel_3d_device<T><<<grid_size, block_size, sizeof(T) * block_size, stream>>>(
        d_nodes, d_elements, num_elements, d_materials, cfl, d_reduction_buffer
    );

    if (grid_size > 1) {
        fem_reduce_min_kernel_device<T><<<1, 256, sizeof(T) * 256, stream>>>(
            d_reduction_buffer, grid_size, d_reduction_buffer
        );
    }

    T min_dt = static_cast<T>(1.0e-6f);
    cudaMemcpyAsync(&min_dt, d_reduction_buffer, sizeof(T), cudaMemcpyDeviceToHost, stream);
    cudaStreamSynchronize(stream);

    if (min_dt >= static_cast<T>(1.0e29f) || min_dt <= static_cast<T>(0.0f)) {
        min_dt = static_cast<T>(1.0e-6f);
    }
    T safe_min_dt = (min_dt < static_cast<T>(1.0e-9f)) ? static_cast<T>(1.0e-9f) : min_dt;
    return safe_min_dt;
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
    if (m_d_facets) { cudaFree(m_d_facets); m_d_facets = nullptr; }
    if (m_d_surface_nodes) { cudaFree(m_d_surface_nodes); m_d_surface_nodes = nullptr; }
    if (m_d_node_part_id) { cudaFree(m_d_node_part_id); m_d_node_part_id = nullptr; }
    if (m_d_part_mat_id) { cudaFree(m_d_part_mat_id); m_d_part_mat_id = nullptr; }
    if (m_d_node_normals) { cudaFree(m_d_node_normals); m_d_node_normals = nullptr; }
    if (m_d_reduction_buffer) { cudaFree(m_d_reduction_buffer); m_d_reduction_buffer = nullptr; }
    if (m_d_node_active_count) { cudaFree(m_d_node_active_count); m_d_node_active_count = nullptr; }
    if (m_d_erosion_flag) { cudaFree(m_d_erosion_flag); m_d_erosion_flag = nullptr; }
    if (m_d_cell_counts) { cudaFree(m_d_cell_counts); m_d_cell_counts = nullptr; }
    if (m_d_cell_facet_ids) { cudaFree(m_d_cell_facet_ids); m_d_cell_facet_ids = nullptr; }
    if (m_d_telemetry_nodes) { cudaFree(m_d_telemetry_nodes); m_d_telemetry_nodes = nullptr; }
    if (m_d_telemetry_facets) { cudaFree(m_d_telemetry_facets); m_d_telemetry_facets = nullptr; }
    if (m_cuda_stream) { cudaStreamDestroy(m_cuda_stream); m_cuda_stream = nullptr; }
}

template <typename T>
void FEMSolver3DCUDA<T>::setErosionCriteria(const FEMErosionCriteria<T>& criteria) {
    m_cpu_solver.setErosionCriteria(criteria);
    const auto& materials = m_cpu_solver.getMaterialTables();
    if (m_d_materials && !materials.empty()) {
        cudaMemcpyAsync(m_d_materials, materials.data(), sizeof(MaterialTable3D) * materials.size(), cudaMemcpyHostToDevice, m_cuda_stream);
    }
}

template <typename T>
void FEMSolver3DCUDA<T>::syncToDevice() {
    const auto& nodes = m_cpu_solver.getNodes();
    const auto& elements = m_cpu_solver.getElements();
    const auto& materials = m_cpu_solver.getMaterialTables();
    const auto& facets = m_cpu_solver.getSurfaceFacets();

    if (nodes.empty() || elements.empty()) return;

    if (nodes.size() > m_allocated_nodes) {
        if (m_d_nodes) cudaFree(m_d_nodes);
        if (m_d_node_part_id) cudaFree(m_d_node_part_id);
        if (m_d_node_normals) cudaFree(m_d_node_normals);
        if (m_d_node_active_count) cudaFree(m_d_node_active_count);
        m_allocated_nodes = nodes.size();
        cudaMalloc(&m_d_nodes, sizeof(FEMNode3D<T>) * m_allocated_nodes);
        cudaMalloc(&m_d_node_part_id, sizeof(int) * m_allocated_nodes);
        cudaMalloc(&m_d_node_normals, sizeof(T) * m_allocated_nodes * 3);
        cudaMalloc(&m_d_node_active_count, sizeof(int) * m_allocated_nodes);
    }
    if (!m_d_erosion_flag) {
        cudaMalloc(&m_d_erosion_flag, sizeof(int));
    }
    cudaMemcpyAsync(m_d_nodes, nodes.data(), sizeof(FEMNode3D<T>) * nodes.size(), cudaMemcpyHostToDevice, m_cuda_stream);

    // Compute node-to-part mapping on CPU and copy to GPU
    std::vector<int> h_node_part(nodes.size(), -1);
    m_max_part_id = -1;
    for (const auto& elem : elements) {
        if (elem.is_eroded) continue;
        if (elem.part_id > m_max_part_id) m_max_part_id = elem.part_id;
        for (int k = 0; k < 8; ++k) {
            int nid = elem.node_ids[k];
            if (nid >= 0 && nid < static_cast<int>(nodes.size())) {
                h_node_part[nid] = elem.part_id;
            }
        }
    }
    cudaMemcpyAsync(m_d_node_part_id, h_node_part.data(), sizeof(int) * nodes.size(), cudaMemcpyHostToDevice, m_cuda_stream);

    // Build part-to-material mapping table on GPU for O(1) contact stiffness lookup
    if (m_max_part_id >= 0) {
        size_t needed_part_mat = static_cast<size_t>(m_max_part_id + 1);
        if (needed_part_mat > m_allocated_part_mat_id) {
            if (m_d_part_mat_id) cudaFree(m_d_part_mat_id);
            m_allocated_part_mat_id = needed_part_mat + 16;
            cudaMalloc(&m_d_part_mat_id, sizeof(int) * m_allocated_part_mat_id);
        }
        std::vector<int> h_part_mat(m_max_part_id + 1, -1);
        for (const auto& elem : elements) {
            if (elem.part_id >= 0 && elem.part_id <= m_max_part_id) {
                h_part_mat[elem.part_id] = elem.mat_id;
            }
        }
        cudaMemcpyAsync(m_d_part_mat_id, h_part_mat.data(), sizeof(int) * (m_max_part_id + 1), cudaMemcpyHostToDevice, m_cuda_stream);
    }

    if (elements.size() > m_allocated_elements) {
        if (m_d_elements) cudaFree(m_d_elements);
        if (m_d_reduction_buffer) cudaFree(m_d_reduction_buffer);
        m_allocated_elements = elements.size();
        cudaMalloc(&m_d_elements, sizeof(FEMElement3D<T>) * m_allocated_elements);
        int grid_size = (m_allocated_elements + 255) / 256;
        cudaMalloc(&m_d_reduction_buffer, sizeof(T) * (grid_size > 0 ? grid_size : 1));
    }
    cudaMemcpyAsync(m_d_elements, elements.data(), sizeof(FEMElement3D<T>) * elements.size(), cudaMemcpyHostToDevice, m_cuda_stream);

    if (materials.size() > m_allocated_materials) {
        if (m_d_materials) cudaFree(m_d_materials);
        m_allocated_materials = materials.size();
        cudaMalloc(&m_d_materials, sizeof(MaterialTable3D) * m_allocated_materials);
    }
    if (!materials.empty()) {
        cudaMemcpyAsync(m_d_materials, materials.data(), sizeof(MaterialTable3D) * materials.size(), cudaMemcpyHostToDevice, m_cuda_stream);
    }

    m_num_surface_facets = facets.size();
    if (m_num_surface_facets > m_allocated_facets) {
        if (m_d_facets) cudaFree(m_d_facets);
        m_allocated_facets = m_num_surface_facets + 1024;
        cudaMalloc(&m_d_facets, sizeof(FEMFacet3D<T>) * m_allocated_facets);
    }
    if (!facets.empty()) {
        cudaMemcpyAsync(m_d_facets, facets.data(), sizeof(FEMFacet3D<T>) * facets.size(), cudaMemcpyHostToDevice, m_cuda_stream);
    }

    // Allocate GPU spatial grid buffers for contact
    if (!m_d_cell_counts) {
        cudaMalloc(&m_d_cell_counts, sizeof(int) * m_spatial_grid_capacity);
        cudaMalloc(&m_d_cell_facet_ids, sizeof(int) * m_spatial_grid_capacity * MAX_FACETS_PER_CELL);
    }

    // Extract surface node indices on CPU and copy to GPU
    std::vector<bool> is_surf_node(nodes.size(), false);
    for (const auto& f : facets) {
        if (f.is_eroded) continue;
        for (int k = 0; k < 4; ++k) {
            if (f.node_ids[k] >= 0 && f.node_ids[k] < static_cast<int>(nodes.size())) {
                is_surf_node[f.node_ids[k]] = true;
            }
        }
    }
    std::vector<int> surf_nodes;
    surf_nodes.reserve(nodes.size() / 2);
    for (size_t i = 0; i < nodes.size(); ++i) {
        if (is_surf_node[i]) {
            surf_nodes.push_back(static_cast<int>(i));
        }
    }
    m_num_surface_nodes = surf_nodes.size();
    if (m_num_surface_nodes > m_allocated_surface_nodes) {
        if (m_d_surface_nodes) cudaFree(m_d_surface_nodes);
        m_allocated_surface_nodes = m_num_surface_nodes + 1024;
        cudaMalloc(&m_d_surface_nodes, sizeof(int) * m_allocated_surface_nodes);
    }
    if (!surf_nodes.empty()) {
        cudaMemcpyAsync(m_d_surface_nodes, surf_nodes.data(), sizeof(int) * surf_nodes.size(), cudaMemcpyHostToDevice, m_cuda_stream);
    }

    cudaStreamSynchronize(m_cuda_stream);
    m_gpu_dirty = false;
    m_topology_dirty = false;
}

template <typename T>
void FEMSolver3DCUDA<T>::syncToHost() const {
    if (!m_gpu_dirty) return;
    auto& nodes = const_cast<std::vector<FEMNode3D<T>>&>(m_cpu_solver.getNodes());
    auto& elements = const_cast<std::vector<FEMElement3D<T>>&>(m_cpu_solver.getElements());
    if (m_d_nodes && !nodes.empty()) {
        cudaMemcpyAsync(nodes.data(), m_d_nodes, sizeof(FEMNode3D<T>) * nodes.size(), cudaMemcpyDeviceToHost, m_cuda_stream);
    }
    if (m_d_elements && !elements.empty()) {
        cudaMemcpyAsync(elements.data(), m_d_elements, sizeof(FEMElement3D<T>) * elements.size(), cudaMemcpyDeviceToHost, m_cuda_stream);
    }
    cudaStreamSynchronize(m_cuda_stream);
    const_cast<FEMSolver3D<T>&>(m_cpu_solver).computeGlobalEnergy();
    if (m_topology_dirty) {
        const_cast<FEMSolver3D<T>&>(m_cpu_solver).invalidateSurfaceFacets();
        m_topology_dirty = false;
    }
    m_last_v_max = m_cpu_solver.getMaxVelocity();
    m_last_vm_max = m_cpu_solver.getMaxVonMisesStress();
    m_last_ep_max = m_cpu_solver.getMaxPlasticStrain();
    m_energy_tracker = m_cpu_solver.getEnergyTracker();
    m_gpu_dirty = false;
}

template <typename T>
void FEMSolver3DCUDA<T>::extractTelemetry(std::vector<float>& h_node_data, std::vector<float>& h_facet_data) const {
    size_t num_nodes = m_cpu_solver.getNodes().size();
    size_t num_facets = m_num_surface_facets;
    size_t num_elements = m_cpu_solver.getElements().size();

    if (num_nodes == 0 || !m_d_nodes) return;

    if (num_nodes > m_allocated_telemetry_nodes) {
        if (m_d_telemetry_nodes) cudaFree(m_d_telemetry_nodes);
        m_allocated_telemetry_nodes = num_nodes + 1024;
        cudaMalloc(&m_d_telemetry_nodes, sizeof(float) * m_allocated_telemetry_nodes * 7);
    }
    if (num_facets > m_allocated_telemetry_facets) {
        if (m_d_telemetry_facets) cudaFree(m_d_telemetry_facets);
        m_allocated_telemetry_facets = num_facets + 1024;
        cudaMalloc(&m_d_telemetry_facets, sizeof(float) * m_allocated_telemetry_facets * 8);
    }

    int block_size = 256;
    int grid_nodes = (static_cast<int>(num_nodes) + block_size - 1) / block_size;
    fem_extract_node_telemetry_kernel_3d_device<T><<<grid_nodes, block_size, 0, m_cuda_stream>>>(
        m_d_nodes, static_cast<int>(num_nodes), m_d_telemetry_nodes
    );

    if (num_facets > 0 && m_d_facets && m_d_elements) {
        int grid_facets = (static_cast<int>(num_facets) + block_size - 1) / block_size;
        fem_extract_facet_telemetry_kernel_3d_device<T><<<grid_facets, block_size, 0, m_cuda_stream>>>(
            m_d_facets, static_cast<int>(num_facets), m_d_elements, static_cast<int>(num_elements), m_d_telemetry_facets
        );
    }

    h_node_data.resize(num_nodes * 7);
    cudaMemcpyAsync(h_node_data.data(), m_d_telemetry_nodes, sizeof(float) * num_nodes * 7, cudaMemcpyDeviceToHost, m_cuda_stream);

    if (num_facets > 0) {
        h_facet_data.resize(num_facets * 8);
        cudaMemcpyAsync(h_facet_data.data(), m_d_telemetry_facets, sizeof(float) * num_facets * 8, cudaMemcpyDeviceToHost, m_cuda_stream);
    } else {
        h_facet_data.clear();
    }

    cudaStreamSynchronize(m_cuda_stream);

    // Compute max velocity from telemetry buffer
    float max_v = 0.0f;
    for (size_t i = 0; i < num_nodes; ++i) {
        float v_mag = h_node_data[i * 7 + 6];
        if (v_mag > max_v) max_v = v_mag;
    }
    m_last_v_max = static_cast<T>(max_v);

    // Compute max stress and plastic strain from facet buffer
    float max_vm = 0.0f;
    float max_ep = 0.0f;
    for (size_t f = 0; f < num_facets; ++f) {
        float vm = h_facet_data[f * 8 + 4];
        float ep = h_facet_data[f * 8 + 5];
        if (vm > max_vm) max_vm = vm;
        if (ep > max_ep) max_ep = ep;
    }
    m_last_vm_max = static_cast<T>(max_vm);
    m_last_ep_max = static_cast<T>(max_ep);
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

    // 2. Penalty Surface Contact Handling using GPU Spatial Grid (100% on GPU!)
    if (m_cpu_solver.getContactPenaltyScale() > static_cast<T>(0.0f) && m_num_surface_facets > 0 && m_num_surface_nodes > 0) {
        launch_fem_update_surface_facets_kernel_3d<T>(
            m_d_nodes, num_nodes, m_d_elements, num_elements, m_d_facets, static_cast<int>(m_num_surface_facets), m_d_node_normals, m_cuda_stream
        );

        T cell_size = static_cast<T>(0.005f); // 5mm default spatial grid cell
        T inv_cell_size = static_cast<T>(1.0f) / cell_size;

        launch_fem_contact_forces_kernel_3d<T>(
            m_d_nodes, num_nodes,
            m_d_elements, num_elements,
            m_d_facets, static_cast<int>(m_num_surface_facets),
            m_d_surface_nodes, static_cast<int>(m_num_surface_nodes),
            m_d_node_part_id,
            m_d_part_mat_id,
            m_max_part_id,
            m_d_node_normals,
            m_d_materials,
            m_d_cell_counts,
            m_d_cell_facet_ids,
            static_cast<uint32_t>(m_spatial_grid_capacity),
            inv_cell_size,
            m_cpu_solver.getContactPenaltyScale(),
            m_cpu_solver.getFrictionStatic(),
            m_cpu_solver.getFrictionKinetic(),
            m_cpu_solver.getContactDamping(),
            dt,
            m_cuda_stream
        );
    } else {
        int block_size = 256;
        int grid_size = (num_nodes + block_size - 1) / block_size;
        fem_reset_nodal_contact_forces_kernel_device<T><<<grid_size, block_size, 0, m_cuda_stream>>>(
            m_d_nodes, num_nodes, m_d_node_normals
        );
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
    launch_fem_initial_timestep_erosion_kernel_3d<T>(
        m_d_nodes, num_nodes, m_d_elements, num_elements, m_d_materials, m_cpu_solver.getErosionCriteria(), m_d_node_active_count, m_d_erosion_flag, m_cuda_stream
    );

    int h_eroded = 0;
    if (m_d_erosion_flag) {
        cudaMemcpyAsync(&h_eroded, m_d_erosion_flag, sizeof(int), cudaMemcpyDeviceToHost, m_cuda_stream);
        cudaStreamSynchronize(m_cuda_stream);
    }

    if (h_eroded != 0) {
        m_topology_dirty = true;
        // Sync element erosion state back to CPU and extract new interior boundary facets
        cudaMemcpyAsync(elements.data(), m_d_elements, sizeof(FEMElement3D<T>) * elements.size(), cudaMemcpyDeviceToHost, m_cuda_stream);
        cudaStreamSynchronize(m_cuda_stream);
        m_cpu_solver.invalidateSurfaceFacets();
        const auto& new_facets = m_cpu_solver.getSurfaceFacets();

        m_num_surface_facets = new_facets.size();
        if (new_facets.size() > m_allocated_facets) {
            if (m_d_facets) cudaFree(m_d_facets);
            m_allocated_facets = new_facets.size() + 1024;
            cudaMalloc(&m_d_facets, sizeof(FEMFacet3D<T>) * m_allocated_facets);
        }
        if (!new_facets.empty()) {
            cudaMemcpyAsync(m_d_facets, new_facets.data(), sizeof(FEMFacet3D<T>) * new_facets.size(), cudaMemcpyHostToDevice, m_cuda_stream);
        }

        // Extract surface nodes
        std::vector<bool> is_surf_node(nodes.size(), false);
        for (const auto& f : new_facets) {
            if (f.is_eroded) continue;
            for (int k = 0; k < 4; ++k) {
                if (f.node_ids[k] >= 0 && f.node_ids[k] < static_cast<int>(nodes.size())) {
                    is_surf_node[f.node_ids[k]] = true;
                }
            }
        }
        std::vector<int> surf_nodes;
        surf_nodes.reserve(nodes.size() / 2);
        for (size_t i = 0; i < nodes.size(); ++i) {
            if (is_surf_node[i]) {
                surf_nodes.push_back(static_cast<int>(i));
            }
        }
        m_num_surface_nodes = surf_nodes.size();
        if (m_num_surface_nodes > m_allocated_surface_nodes) {
            if (m_d_surface_nodes) cudaFree(m_d_surface_nodes);
            m_allocated_surface_nodes = m_num_surface_nodes + 1024;
            cudaMalloc(&m_d_surface_nodes, sizeof(int) * m_allocated_surface_nodes);
        }
        if (!surf_nodes.empty()) {
            cudaMemcpyAsync(m_d_surface_nodes, surf_nodes.data(), sizeof(int) * surf_nodes.size(), cudaMemcpyHostToDevice, m_cuda_stream);
        }
        cudaStreamSynchronize(m_cuda_stream);
    }

    m_gpu_dirty = true;
}

template <typename T>
void FEMSolver3DCUDA<T>::step(T cfl) {
    m_last_cfl = cfl;
    if (!m_d_nodes || !m_d_elements) {
        syncToDevice();
    }
    T dt = launch_fem_compute_step_size_kernel_3d<T>(
        m_d_nodes, m_d_elements, static_cast<int>(m_cpu_solver.getElements().size()),
        m_d_materials, cfl, m_d_reduction_buffer, m_cuda_stream
    );
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

template void launch_fem_initial_timestep_erosion_kernel_3d<float>(FEMNode3D<float>*, int, FEMElement3D<float>*, int, const MaterialTable3D*, FEMErosionCriteria<float>, int*, int*, cudaStream_t);
template void launch_fem_initial_timestep_erosion_kernel_3d<double>(FEMNode3D<double>*, int, FEMElement3D<double>*, int, const MaterialTable3D*, FEMErosionCriteria<double>, int*, int*, cudaStream_t);

template void launch_fem_update_surface_facets_kernel_3d<float>(FEMNode3D<float>*, int, const FEMElement3D<float>*, int, FEMFacet3D<float>*, int, float*, cudaStream_t);
template void launch_fem_update_surface_facets_kernel_3d<double>(FEMNode3D<double>*, int, const FEMElement3D<double>*, int, FEMFacet3D<double>*, int, double*, cudaStream_t);

template void launch_fem_contact_forces_kernel_3d<float>(FEMNode3D<float>*, int, const FEMElement3D<float>*, int, const FEMFacet3D<float>*, int, const int*, int, const int*, const int*, int, const float*, const MaterialTable3D*, int*, int*, uint32_t, float, float, float, float, float, float, cudaStream_t);
template void launch_fem_contact_forces_kernel_3d<double>(FEMNode3D<double>*, int, const FEMElement3D<double>*, int, const FEMFacet3D<double>*, int, const int*, int, const int*, const int*, int, const double*, const MaterialTable3D*, int*, int*, uint32_t, double, double, double, double, double, double, cudaStream_t);

template float launch_fem_compute_step_size_kernel_3d<float>(const FEMNode3D<float>*, const FEMElement3D<float>*, int, const MaterialTable3D*, float, float*, cudaStream_t);
template double launch_fem_compute_step_size_kernel_3d<double>(const FEMNode3D<double>*, const FEMElement3D<double>*, int, const MaterialTable3D*, double, double*, cudaStream_t);

template class FEMSolver3DCUDA<float>;
template class FEMSolver3DCUDA<double>;

} // namespace Blast
