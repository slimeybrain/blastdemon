#include "fem_solver_3d_cuda.hpp"
#include "fem_contact_3d.hpp"
#include "constitutive_concrete_models.hpp"
#include "cfd_eos_water.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include "materials/ConstitutiveGeomaterials.hpp"
#include <cub/cub.cuh>
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
        if (node.is_prescribed[c]) {
            node.a[c] = static_cast<T>(0.0f);
            node.x[c] += node.v[c] * dt;
            continue;
        }

        T v_h = node.v[c] + static_cast<T>(0.5f) * node.a[c] * dt;
        node.x[c] += v_h * dt;
        node.v[c] = v_h; // Stores v^{n+1/2} temporarily
    }
}

// CUDA Kernel: Pass 1 for Tet4-ANP (Bonet & Burton 1998; Puso & Solberg 2006) — Accumulate Current & Reference Nodal Volumes and Volume Rates
template <typename T>
__global__ void fem_anp_nodal_volumes_kernel_3d_device(
    const FEMNode3D<T>* d_nodes,
    FEMElement3D<T>* d_elements,
    int num_elements,
    const MaterialTable3D* d_materials,
    T dt,
    T* d_nodal_vol_cur,
    T* d_nodal_vol_ref,
    T* d_nodal_dvol_dt
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_elements) return;

    FEMElement3D<T>& elem = d_elements[idx];
    if (elem.is_eroded || !isTet4ANPElement(elem) || elem.is_detached) return;

    if (d_materials) {
        const MaterialTable3D& mat = d_materials[elem.mat_id];
        const bool is_energetic = (mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
                                   mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
                                   mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);
        if (is_energetic) return;
    }

    T x_cur_t[4][3], x_mid[4][3], v_t[4][3];
    T v_center_t[3] = {static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(0.0f)};
    for (int n = 0; n < 4; ++n) {
        int nid = elem.node_ids[n];
        for (int c = 0; c < 3; ++c) {
            x_cur_t[n][c] = d_nodes[nid].x[c];
            v_t[n][c] = d_nodes[nid].v[c];
            x_mid[n][c] = x_cur_t[n][c] - static_cast<T>(0.5f) * v_t[n][c] * dt;
            v_center_t[c] += v_t[n][c];
        }
    }
    v_center_t[0] *= static_cast<T>(0.25f);
    v_center_t[1] *= static_cast<T>(0.25f);
    v_center_t[2] *= static_cast<T>(0.25f);

    T dN_cur_t[4][3] = {{static_cast<T>(0.0f)}};
    T V_cur = static_cast<T>(0.0f);
    computeTet4ShapeGradients(x_cur_t, dN_cur_t, V_cur);

    T dN_t[4][3] = {{static_cast<T>(0.0f)}};
    T V_mid = static_cast<T>(0.0f);
    computeTet4ShapeGradients(x_mid, dN_t, V_mid);

    if (V_cur > static_cast<T>(1.0e-18f) && V_mid > static_cast<T>(1.0e-18f) && elem.V0 > static_cast<T>(1.0e-18f)) {
        elem.V = V_cur;
        T div_v_elem = static_cast<T>(0.0f);
        for (int n = 0; n < 4; ++n) {
            div_v_elem += dN_t[n][0] * (v_t[n][0] - v_center_t[0])
                        + dN_t[n][1] * (v_t[n][1] - v_center_t[1])
                        + dN_t[n][2] * (v_t[n][2] - v_center_t[2]);
        }
        T v_cur_q = static_cast<T>(0.25f) * V_cur;
        T v_ref_q = static_cast<T>(0.25f) * elem.V0;
        T dvol_dt_q = static_cast<T>(0.25f) * V_mid * div_v_elem;
        for (int n = 0; n < 4; ++n) {
            int nid = elem.node_ids[n];
            atomicAdd(&d_nodal_vol_cur[nid], v_cur_q);
            atomicAdd(&d_nodal_vol_ref[nid], v_ref_q);
            if (d_nodal_dvol_dt) {
                atomicAdd(&d_nodal_dvol_dt[nid], dvol_dt_q);
            }
        }
    }
}

// CUDA Kernel: Compute Hex8 & Tet4-ANP Element Stresses, Hourglass Forces, and Atomic Nodal Force Assembly
template <typename T>
__global__ void fem_element_forces_kernel_3d_device(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    FEMElement3D<T>* d_elements,
    int num_elements,
    FEMGaussPointHistory3D<T>* d_gp_history,
    const MaterialTable3D* d_materials,
    BlastPhysicsParams<T> physics_params,
    T dt,
    T hourglass_coeff,
    FEMHourglassModel hg_model,
    FEMIntegrationScheme integration_scheme,
    const T* d_nodal_vol_cur,
    const T* d_nodal_vol_ref,
    const T* d_nodal_dvol_dt,
    T sim_time,
    T min_volume_ratio = static_cast<T>(0.02f),
    int* d_erosion_flag = nullptr
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_elements) return;

    FEMElement3D<T>& elem = d_elements[idx];
    if (elem.is_eroded) return;

    const bool is_tet4 = isTet4Element(elem);
    const int n_elem_nodes = is_tet4 ? 4 : 8;
    const T inv_n_nodes = is_tet4 ? static_cast<T>(0.25f) : static_cast<T>(0.125f);

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
    T x0_center[3] = {0.0f, 0.0f, 0.0f};
    T v_center[3] = {0.0f, 0.0f, 0.0f};
    for (int n = 0; n < n_elem_nodes; ++n) {
        int nid = elem.node_ids[n];
        x_center[0] += x_nodes[n][0]; x_center[1] += x_nodes[n][1]; x_center[2] += x_nodes[n][2];
        x0_center[0] += d_nodes[nid].x0[0]; x0_center[1] += d_nodes[nid].x0[1]; x0_center[2] += d_nodes[nid].x0[2];
        v_center[0] += v_nodes[n][0]; v_center[1] += v_nodes[n][1]; v_center[2] += v_nodes[n][2];
    }
    x_center[0] *= inv_n_nodes; x_center[1] *= inv_n_nodes; x_center[2] *= inv_n_nodes;
    x0_center[0] *= inv_n_nodes; x0_center[1] *= inv_n_nodes; x0_center[2] *= inv_n_nodes;
    v_center[0] *= inv_n_nodes; v_center[1] *= inv_n_nodes; v_center[2] *= inv_n_nodes;

    T x_mid[8][3];
    for (int n = 0; n < 8; ++n) {
        for (int c = 0; c < 3; ++c) {
            x_mid[n][c] = x_nodes[n][c] - static_cast<T>(0.5f) * v_nodes[n][c] * dt;
        }
    }

    T x_center_mid[3] = {0.0f, 0.0f, 0.0f};
    for (int n = 0; n < n_elem_nodes; ++n) {
        x_center_mid[0] += x_mid[n][0]; x_center_mid[1] += x_mid[n][1]; x_center_mid[2] += x_mid[n][2];
    }
    x_center_mid[0] *= inv_n_nodes; x_center_mid[1] *= inv_n_nodes; x_center_mid[2] *= inv_n_nodes;

    T x_rel[8][3], x_cur_rel[8][3], v_rel[8][3];
    for (int n = 0; n < 8; ++n) {
        for (int c = 0; c < 3; ++c) {
            x_rel[n][c] = x_mid[n][c] - x_center_mid[c];
            x_cur_rel[n][c] = x_nodes[n][c] - x_center[c];
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

    const FEMIntegrationScheme elem_scheme = resolveElementIntegrationScheme(elem, integration_scheme);
    const FEMHourglassModel elem_hg_model = resolveElementHourglassModel(elem, hg_model);
    const T elem_hg_coeff = resolveElementHourglassCoeff(elem, hourglass_coeff);

    const bool is_energetic_elem = (mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
                                    mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
                                    mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);
    T min_vol_r = is_energetic_elem
                ? static_cast<T>(0.005f)
                : static_cast<T>(mat.min_volume_ratio > 0.0f ? mat.min_volume_ratio : (min_volume_ratio > static_cast<T>(0.0f) ? min_volume_ratio : static_cast<T>(0.02f)));
    T cs_C = physics_params.cowper_symonds_C;
    T cs_P = physics_params.cowper_symonds_P;
    T b1 = static_cast<T>(mat.bulk_viscosity_b1 > 0.0f ? mat.bulk_viscosity_b1 : physics_params.bulk_viscosity_b1);
    T b2 = static_cast<T>(mat.bulk_viscosity_b2 > 0.0f ? mat.bulk_viscosity_b2 : physics_params.bulk_viscosity_b2);
    T v_rel_elem = (elem.V0 > static_cast<T>(1.0e-18f) && elem.V > static_cast<T>(0.0f))
        ? (elem.V / elem.V0) : static_cast<T>(1.0f);
    T p_elem_prev = -(elem.sigma[0][0] + elem.sigma[1][1] + elem.sigma[2][2]) / static_cast<T>(3.0f) - elem.q_visc;
    T cd = computeDilatationalWaveSpeed<T>(mat, v_rel_elem, elem.lambda, p_elem_prev, elem.e_int);

    if (!is_tet4 && !is_energetic_elem && d_gp_history && (elem_scheme == FEMIntegrationScheme::FullGauss8 || elem_scheme == FEMIntegrationScheme::SelectiveReduced)) {
        FEMGaussPointHistory3D<T>* gp_hist_ptr = &d_gp_history[idx];
        static const T gp_coords[8][3] = {
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

        T J_center_cur[3][3] = {{0.0f}};
        T J_center[3][3] = {{0.0f}};
        for (int i = 0; i < 8; ++i) {
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    J_center_cur[r][c] += dN_dxi_center[i][r] * x_cur_rel[i][c];
                    J_center[r][c] += dN_dxi_center[i][r] * x_rel[i][c];
                }
            }
        }

        T detJ_center_cur = J_center_cur[0][0] * (J_center_cur[1][1]*J_center_cur[2][2] - J_center_cur[1][2]*J_center_cur[2][1])
                          - J_center_cur[0][1] * (J_center_cur[1][0]*J_center_cur[2][2] - J_center_cur[1][2]*J_center_cur[2][0])
                          + J_center_cur[0][2] * (J_center_cur[1][0]*J_center_cur[2][1] - J_center_cur[1][1]*J_center_cur[2][0]);

        if (detJ_center_cur <= static_cast<T>(0.0f) || (elem.V0 > static_cast<T>(1.0e-30f) && (detJ_center_cur * static_cast<T>(8.0f) / elem.V0) <= min_vol_r)) {
            elem.V = detJ_center_cur * static_cast<T>(8.0f);
            elem.is_eroded = true;
            elem.sigma[0][0] = elem.sigma[1][1] = elem.sigma[2][2] = static_cast<T>(0.0f);
            elem.sigma[0][1] = elem.sigma[1][2] = elem.sigma[2][0] = static_cast<T>(0.0f);
            elem.s_dev[0][0] = elem.s_dev[1][1] = elem.s_dev[2][2] = static_cast<T>(0.0f);
            elem.s_dev[0][1] = elem.s_dev[1][2] = elem.s_dev[2][0] = static_cast<T>(0.0f);
            if (d_erosion_flag) *d_erosion_flag = 1;
            return;
        }
        elem.V = detJ_center_cur * static_cast<T>(8.0f);

        T div_v_center = 0.0f;
        if (elem_scheme == FEMIntegrationScheme::SelectiveReduced) {
            T detJ_center = J_center[0][0] * (J_center[1][1]*J_center[2][2] - J_center[1][2]*J_center[2][1])
                          - J_center[0][1] * (J_center[1][0]*J_center[2][2] - J_center[1][2]*J_center[2][0])
                          + J_center[0][2] * (J_center[1][0]*J_center[2][1] - J_center[1][1]*J_center[2][0]);
            const T (&J_c_kin)[3][3] = (detJ_center > static_cast<T>(1.0e-15f)) ? J_center : J_center_cur;
            const T detJ_c_kin = (detJ_center > static_cast<T>(1.0e-15f)) ? detJ_center : detJ_center_cur;
            T invDetJ_center = static_cast<T>(1.0f) / detJ_c_kin;
            T J_inv_center[3][3];
            J_inv_center[0][0] = (J_c_kin[1][1]*J_c_kin[2][2] - J_c_kin[1][2]*J_c_kin[2][1]) * invDetJ_center;
            J_inv_center[0][1] = (J_c_kin[0][2]*J_c_kin[2][1] - J_c_kin[0][1]*J_c_kin[2][2]) * invDetJ_center;
            J_inv_center[0][2] = (J_c_kin[0][1]*J_c_kin[1][2] - J_c_kin[0][2]*J_c_kin[1][1]) * invDetJ_center;
            J_inv_center[1][0] = (J_c_kin[1][2]*J_c_kin[2][0] - J_c_kin[1][0]*J_c_kin[2][2]) * invDetJ_center;
            J_inv_center[1][1] = (J_c_kin[0][0]*J_c_kin[2][2] - J_c_kin[0][2]*J_c_kin[2][0]) * invDetJ_center;
            J_inv_center[1][2] = (J_c_kin[0][2]*J_c_kin[1][0] - J_c_kin[0][0]*J_c_kin[1][2]) * invDetJ_center;
            J_inv_center[2][0] = (J_c_kin[1][0]*J_c_kin[2][1] - J_c_kin[1][1]*J_c_kin[2][0]) * invDetJ_center;
            J_inv_center[2][1] = (J_c_kin[0][1]*J_c_kin[2][0] - J_c_kin[0][0]*J_c_kin[2][1]) * invDetJ_center;
            J_inv_center[2][2] = (J_c_kin[0][0]*J_c_kin[1][1] - J_c_kin[0][1]*J_c_kin[1][0]) * invDetJ_center;

            T dN_dx_center[8][3];
            for (int i = 0; i < 8; ++i) {
                for (int c = 0; c < 3; ++c) {
                    dN_dx_center[i][c] = J_inv_center[c][0] * dN_dxi_center[i][0] + J_inv_center[c][1] * dN_dxi_center[i][1] + J_inv_center[c][2] * dN_dxi_center[i][2];
                }
            }

            T strain_rate_center[6] = {0.0f};
            for (int i = 0; i < 8; ++i) {
                strain_rate_center[0] += dN_dx_center[i][0] * v_rel[i][0];
                strain_rate_center[1] += dN_dx_center[i][1] * v_rel[i][1];
                strain_rate_center[2] += dN_dx_center[i][2] * v_rel[i][2];
            }
            div_v_center = strain_rate_center[0] + strain_rate_center[1] + strain_rate_center[2];
            if (fabs(div_v_center) * dt < static_cast<T>(1.0e-15f)) {
                div_v_center = static_cast<T>(0.0f);
            }
        }

        T sigma_avg[3][3] = {{0.0f}};
        T s_dev_avg[3][3] = {{0.0f}};
        T ep_bar_avg = 0.0f;
        T lambda_avg = 0.0f;
        T e_int_avg = 0.0f;
        T temp_avg = 0.0f;
        T damage_avg = 0.0f;
        T V_sum = 0.0f;
        T f_elem_total[24] = {static_cast<T>(0.0f)};
        bool all_gp_valid = true;

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

            T J_g_cur[3][3] = {{0.0f}};
            T J_g[3][3] = {{0.0f}};
            for (int i = 0; i < 8; ++i) {
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        J_g_cur[r][c] += dN_dxi_g[i][r] * x_cur_rel[i][c];
                        J_g[r][c] += dN_dxi_g[i][r] * x_rel[i][c];
                    }
                }
            }

            T detJ_g_cur = J_g_cur[0][0] * (J_g_cur[1][1]*J_g_cur[2][2] - J_g_cur[1][2]*J_g_cur[2][1])
                         - J_g_cur[0][1] * (J_g_cur[1][0]*J_g_cur[2][2] - J_g_cur[1][2]*J_g_cur[2][0])
                         + J_g_cur[0][2] * (J_g_cur[1][0]*J_g_cur[2][1] - J_g_cur[1][1]*J_g_cur[2][0]);

            if (detJ_g_cur <= static_cast<T>(1.0e-15f)) {
                elem.is_eroded = true;
                if (d_erosion_flag) *d_erosion_flag = 1;
                all_gp_valid = false;
                break;
            }
            V_sum += detJ_g_cur;
            T invDetJ_g_cur = static_cast<T>(1.0f) / detJ_g_cur;

            T J_inv_g_cur[3][3];
            J_inv_g_cur[0][0] = (J_g_cur[1][1]*J_g_cur[2][2] - J_g_cur[1][2]*J_g_cur[2][1]) * invDetJ_g_cur;
            J_inv_g_cur[0][1] = (J_g_cur[0][2]*J_g_cur[2][1] - J_g_cur[0][1]*J_g_cur[2][2]) * invDetJ_g_cur;
            J_inv_g_cur[0][2] = (J_g_cur[0][1]*J_g_cur[1][2] - J_g_cur[0][2]*J_g_cur[1][1]) * invDetJ_g_cur;
            J_inv_g_cur[1][0] = (J_g_cur[1][2]*J_g_cur[2][0] - J_g_cur[1][0]*J_g_cur[2][2]) * invDetJ_g_cur;
            J_inv_g_cur[1][1] = (J_g_cur[0][0]*J_g_cur[2][2] - J_g_cur[0][2]*J_g_cur[2][0]) * invDetJ_g_cur;
            J_inv_g_cur[1][2] = (J_g_cur[0][2]*J_g_cur[1][0] - J_g_cur[0][0]*J_g_cur[1][2]) * invDetJ_g_cur;
            J_inv_g_cur[2][0] = (J_g_cur[1][0]*J_g_cur[2][1] - J_g_cur[1][1]*J_g_cur[2][0]) * invDetJ_g_cur;
            J_inv_g_cur[2][1] = (J_g_cur[0][1]*J_g_cur[2][0] - J_g_cur[0][0]*J_g_cur[2][1]) * invDetJ_g_cur;
            J_inv_g_cur[2][2] = (J_g_cur[0][0]*J_g_cur[1][1] - J_g_cur[0][1]*J_g_cur[1][0]) * invDetJ_g_cur;

            T dN_dx_g_cur[8][3];
            for (int i = 0; i < 8; ++i) {
                for (int c = 0; c < 3; ++c) {
                    dN_dx_g_cur[i][c] = J_inv_g_cur[c][0] * dN_dxi_g[i][0] + J_inv_g_cur[c][1] * dN_dxi_g[i][1] + J_inv_g_cur[c][2] * dN_dxi_g[i][2];
                }
            }

            T detJ_g = J_g[0][0] * (J_g[1][1]*J_g[2][2] - J_g[1][2]*J_g[2][1])
                     - J_g[0][1] * (J_g[1][0]*J_g[2][2] - J_g[1][2]*J_g[2][0])
                     + J_g[0][2] * (J_g[1][0]*J_g[2][1] - J_g[1][1]*J_g[2][0]);
            const T (&J_g_kin)[3][3] = (detJ_g > static_cast<T>(1.0e-15f)) ? J_g : J_g_cur;
            const T detJ_g_kin = (detJ_g > static_cast<T>(1.0e-15f)) ? detJ_g : detJ_g_cur;
            T invDetJ_g = static_cast<T>(1.0f) / detJ_g_kin;

            T J_inv_g[3][3];
            J_inv_g[0][0] = (J_g_kin[1][1]*J_g_kin[2][2] - J_g_kin[1][2]*J_g_kin[2][1]) * invDetJ_g;
            J_inv_g[0][1] = (J_g_kin[0][2]*J_g_kin[2][1] - J_g_kin[0][1]*J_g_kin[2][2]) * invDetJ_g;
            J_inv_g[0][2] = (J_g_kin[0][1]*J_g_kin[1][2] - J_g_kin[0][2]*J_g_kin[1][1]) * invDetJ_g;
            J_inv_g[1][0] = (J_g_kin[1][2]*J_g_kin[2][0] - J_g_kin[1][0]*J_g_kin[2][2]) * invDetJ_g;
            J_inv_g[1][1] = (J_g_kin[0][0]*J_g_kin[2][2] - J_g_kin[0][2]*J_g_kin[2][0]) * invDetJ_g;
            J_inv_g[1][2] = (J_g_kin[0][2]*J_g_kin[1][0] - J_g_kin[0][0]*J_g_kin[1][2]) * invDetJ_g;
            J_inv_g[2][0] = (J_g_kin[1][0]*J_g_kin[2][1] - J_g_kin[1][1]*J_g_kin[2][0]) * invDetJ_g;
            J_inv_g[2][1] = (J_g_kin[0][1]*J_g_kin[2][0] - J_g_kin[0][0]*J_g_kin[2][1]) * invDetJ_g;
            J_inv_g[2][2] = (J_g_kin[0][0]*J_g_kin[1][1] - J_g_kin[0][1]*J_g_kin[1][0]) * invDetJ_g;

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
            if (fabs(div_v_g) * dt < static_cast<T>(1.0e-15f)) {
                div_v_g = static_cast<T>(0.0f);
            }

            T h_e_g = cbrt(detJ_g * static_cast<T>(8.0f));
            T q_visc_g = (div_v_g < static_cast<T>(0.0f))
                       ? (density * (-b1 * h_e_g * div_v_g * cd + b2 * h_e_g * h_e_g * div_v_g * div_v_g))
                       : static_cast<T>(0.0f);

            T d_dev_g[3][3];
            T active_div_v = (elem_scheme == FEMIntegrationScheme::SelectiveReduced) ? div_v_center : div_v_g;
            d_dev_g[0][0] = strain_rate_g[0] - static_cast<T>(1.0f)/static_cast<T>(3.0f) * div_v_g;
            d_dev_g[1][1] = strain_rate_g[1] - static_cast<T>(1.0f)/static_cast<T>(3.0f) * div_v_g;
            d_dev_g[2][2] = strain_rate_g[2] - static_cast<T>(1.0f)/static_cast<T>(3.0f) * div_v_g;
            d_dev_g[0][1] = d_dev_g[1][0] = static_cast<T>(0.5f) * strain_rate_g[3];
            d_dev_g[1][2] = d_dev_g[2][1] = static_cast<T>(0.5f) * strain_rate_g[4];
            d_dev_g[2][0] = d_dev_g[0][2] = static_cast<T>(0.5f) * strain_rate_g[5];

            uint32_t user_seed_g = static_cast<uint32_t>(physics_params.random_seed) * 2654435761u;
            uint32_t elem_seed_g = user_seed_g ^ (static_cast<uint32_t>(elem.node_ids[0]) * 73856093u)
                                             ^ (static_cast<uint32_t>(elem.node_ids[6]) * 19349663u)
                                             ^ (static_cast<uint32_t>(idx) * 83492791u)
                                             ^ (static_cast<uint32_t>(g) * 374761393u);
            T L_corr_g = fmax(static_cast<T>(3.0f) * h_e_g, static_cast<T>(mat.nonlocal_radius));
            T het_factor_g = computeFEMWeibullFactor<T>(elem_seed_g, physics_params, x0_center[0], x0_center[1], x0_center[2], L_corr_g, &mat);

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
                if (gp_hist_ptr) {
                    T s_temp[3][3] = {{static_cast<T>(0.0f)}};
                    for (int r = 0; r < 3; ++r) {
                        for (int c = 0; c < 3; ++c) {
                            for (int k = 0; k < 3; ++k) {
                                s_temp[r][c] += R_dt_g[r][k] * gp_hist_ptr->s_dev_gp[g][k][c];
                            }
                        }
                    }
                    for (int r = 0; r < 3; ++r) {
                        for (int c = 0; c < 3; ++c) {
                            gp_hist_ptr->s_dev_gp[g][r][c] = static_cast<T>(0.0f);
                            for (int k = 0; k < 3; ++k) {
                                gp_hist_ptr->s_dev_gp[g][r][c] += s_temp[r][k] * R_dt_g[c][k];
                            }
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
            if (gp_hist_ptr) {
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        for (int k = 0; k < 3; ++k) {
                            F_new_g[r][c] += I_plus_Ldt_g[r][k] * gp_hist_ptr->F_gp[g][k][c];
                        }
                    }
                }
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        gp_hist_ptr->F_gp[g][r][c] = F_new_g[r][c];
                    }
                }
            }

            T J_vol_g = static_cast<T>(1.0f);
            if (elem_scheme == FEMIntegrationScheme::SelectiveReduced) {
                J_vol_g = (elem.V0 > static_cast<T>(1.0e-18f)) ? (elem.V / elem.V0) : static_cast<T>(1.0f);
            } else if (gp_hist_ptr) {
                J_vol_g = gp_hist_ptr->F_gp[g][0][0] * (gp_hist_ptr->F_gp[g][1][1]*gp_hist_ptr->F_gp[g][2][2] - gp_hist_ptr->F_gp[g][1][2]*gp_hist_ptr->F_gp[g][2][1])
                        - gp_hist_ptr->F_gp[g][0][1] * (gp_hist_ptr->F_gp[g][1][0]*gp_hist_ptr->F_gp[g][2][2] - gp_hist_ptr->F_gp[g][1][2]*gp_hist_ptr->F_gp[g][2][0])
                        + gp_hist_ptr->F_gp[g][0][2] * (gp_hist_ptr->F_gp[g][1][0]*gp_hist_ptr->F_gp[g][2][1] - gp_hist_ptr->F_gp[g][1][1]*gp_hist_ptr->F_gp[g][2][0]);
            }

            if (gp_hist_ptr) {
                T p_hydro_g = static_cast<T>(0.0f);
                runFEMConstitutivePoint<T>(
                    mat, physics_params, gp_hist_ptr->F_gp[g], d_dev_g, active_div_v, J_vol_g, dt,
                    h_e_g, q_visc_g, het_factor_g, elem.is_detached,
                    gp_hist_ptr->s_dev_gp[g], gp_hist_ptr->p_gp[g], p_hydro_g,
                    gp_hist_ptr->ep_bar_gp[g], gp_hist_ptr->damage_gp[g], gp_hist_ptr->lambda_gp[g],
                    gp_hist_ptr->temp_gp[g], gp_hist_ptr->e_int_gp[g]
                );

                T sigma_g[3][3];
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        sigma_g[r][c] = gp_hist_ptr->s_dev_gp[g][r][c] - (r == c ? p_hydro_g : static_cast<T>(0.0f));
                    }
                }

                for (int i = 0; i < 8; ++i) {
                    T f_x = (dN_dx_g_cur[i][0] * sigma_g[0][0] + dN_dx_g_cur[i][1] * sigma_g[0][1] + dN_dx_g_cur[i][2] * sigma_g[0][2]) * detJ_g_cur;
                    T f_y = (dN_dx_g_cur[i][0] * sigma_g[1][0] + dN_dx_g_cur[i][1] * sigma_g[1][1] + dN_dx_g_cur[i][2] * sigma_g[1][2]) * detJ_g_cur;
                    T f_z = (dN_dx_g_cur[i][0] * sigma_g[2][0] + dN_dx_g_cur[i][1] * sigma_g[2][1] + dN_dx_g_cur[i][2] * sigma_g[2][2]) * detJ_g_cur;

                    f_elem_total[i * 3 + 0] += f_x;
                    f_elem_total[i * 3 + 1] += f_y;
                    f_elem_total[i * 3 + 2] += f_z;
                }

                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        sigma_avg[r][c] += 0.125f * sigma_g[r][c];
                        s_dev_avg[r][c] += 0.125f * gp_hist_ptr->s_dev_gp[g][r][c];
                    }
                }
                ep_bar_avg += 0.125f * gp_hist_ptr->ep_bar_gp[g];
                temp_avg += 0.125f * gp_hist_ptr->temp_gp[g];
                damage_avg += 0.125f * gp_hist_ptr->damage_gp[g];
                lambda_avg += 0.125f * gp_hist_ptr->lambda_gp[g];
                e_int_avg += 0.125f * gp_hist_ptr->e_int_gp[g];
            }
        }

        if (!all_gp_valid) {
            return;
        }

        if (!elem.is_eroded) {
            for (int i = 0; i < 8; ++i) {
                int nid = elem.node_ids[i];
                atomicAdd(&d_nodes[nid].f_int[0], f_elem_total[i * 3 + 0]);
                atomicAdd(&d_nodes[nid].f_int[1], f_elem_total[i * 3 + 1]);
                atomicAdd(&d_nodes[nid].f_int[2], f_elem_total[i * 3 + 2]);
            }
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
        elem.lambda = lambda_avg;
        elem.e_int = e_int_avg;
        elem.q_visc = static_cast<T>(0.0f);
        elem.V = V_sum;

        if (gp_hist_ptr) {
            T F_avg[3][3] = {{0.0f}};
            for (int g = 0; g < 8; ++g) {
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        F_avg[r][c] += 0.125f * gp_hist_ptr->F_gp[g][r][c];
                    }
                }
            }
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    elem.F[r][c] = F_avg[r][c];
                }
            }
        }
        return;
    }

    T dN_dx[8][3] = {{0.0f}};
    T dN_dx_mid[8][3] = {{0.0f}};
    T J_anp = static_cast<T>(1.0f);
    if (is_tet4) {
        T x_tet[4][3], x_tet_mid[4][3];
        for (int n = 0; n < 4; ++n) {
            x_tet[n][0] = x_cur_rel[n][0];
            x_tet[n][1] = x_cur_rel[n][1];
            x_tet[n][2] = x_cur_rel[n][2];
            x_tet_mid[n][0] = x_rel[n][0];
            x_tet_mid[n][1] = x_rel[n][1];
            x_tet_mid[n][2] = x_rel[n][2];
        }
        T dN_tet[4][3] = {{0.0f}};
        T V_tet = static_cast<T>(0.0f);
        computeTet4ShapeGradients(x_tet, dN_tet, V_tet);
        for (int n = 0; n < 4; ++n) {
            dN_dx[n][0] = dN_tet[n][0];
            dN_dx[n][1] = dN_tet[n][1];
            dN_dx[n][2] = dN_tet[n][2];
        }
        if (V_tet <= static_cast<T>(0.0f) || (elem.V0 > static_cast<T>(1.0e-30f) && (V_tet / elem.V0) <= min_vol_r)) {
            elem.V = V_tet;
            elem.is_eroded = true;
            elem.sigma[0][0] = elem.sigma[1][1] = elem.sigma[2][2] = static_cast<T>(0.0f);
            elem.sigma[0][1] = elem.sigma[1][2] = elem.sigma[2][0] = static_cast<T>(0.0f);
            elem.s_dev[0][0] = elem.s_dev[1][1] = elem.s_dev[2][2] = static_cast<T>(0.0f);
            elem.s_dev[0][1] = elem.s_dev[1][2] = elem.s_dev[2][0] = static_cast<T>(0.0f);
            if (d_erosion_flag) *d_erosion_flag = 1;
            return;
        }
        elem.V = V_tet;

        T dN_tet_mid[4][3] = {{0.0f}};
        T V_tet_mid = static_cast<T>(0.0f);
        computeTet4ShapeGradients(x_tet_mid, dN_tet_mid, V_tet_mid);
        const T (&dN_kin)[4][3] = (V_tet_mid > static_cast<T>(1.0e-18f)) ? dN_tet_mid : dN_tet;
        for (int n = 0; n < 4; ++n) {
            dN_dx_mid[n][0] = dN_kin[n][0];
            dN_dx_mid[n][1] = dN_kin[n][1];
            dN_dx_mid[n][2] = dN_kin[n][2];
        }

        T v_rel_local = (elem.V0 > static_cast<T>(1.0e-18f)) ? (elem.V / elem.V0) : static_cast<T>(1.0f);
        if (isTet4ANPElement(elem) && !elem.is_detached && !is_energetic_elem && d_nodal_vol_cur && d_nodal_vol_ref) {
            T j_sum = static_cast<T>(0.0f);
            int valid_a = 0;
            for (int n = 0; n < 4; ++n) {
                int nid = elem.node_ids[n];
                if (nid >= 0 && nid < num_nodes && d_nodal_vol_ref[nid] > static_cast<T>(1.0e-18f)) {
                    j_sum += d_nodal_vol_cur[nid] / d_nodal_vol_ref[nid];
                    valid_a++;
                }
            }
            if (valid_a > 0) {
                T j_avg = j_sum / static_cast<T>(valid_a);
                J_anp = static_cast<T>(0.85f) * j_avg + static_cast<T>(0.15f) * v_rel_local;
            } else {
                J_anp = v_rel_local;
            }
        } else {
            J_anp = v_rel_local;
        }
    } else {
        for (int i = 0; i < 8; ++i) {
            dN_dxi[i][0] = 0.125f * HEX8_XI_CUDA[i][0];
            dN_dxi[i][1] = 0.125f * HEX8_XI_CUDA[i][1];
            dN_dxi[i][2] = 0.125f * HEX8_XI_CUDA[i][2];
        }

        // Compute current Jacobian matrix J (3x3) at t^{n+1} and midpoint J_mid at t^{n+1/2}
        T J[3][3] = {{0.0f}};
        T J_mid[3][3] = {{0.0f}};
        for (int i = 0; i < 8; ++i) {
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    J[r][c] += dN_dxi[i][r] * x_cur_rel[i][c];
                    J_mid[r][c] += dN_dxi[i][r] * x_rel[i][c];
                }
            }
        }

        T detJ = J[0][0] * (J[1][1]*J[2][2] - J[1][2]*J[2][1])
               - J[0][1] * (J[1][0]*J[2][2] - J[1][2]*J[2][0])
               + J[0][2] * (J[1][0]*J[2][1] - J[1][1]*J[2][0]);

        if (detJ <= static_cast<T>(0.0f) || (elem.V0 > static_cast<T>(1.0e-30f) && (detJ * static_cast<T>(8.0f) / elem.V0) <= min_vol_r)) {
            elem.V = detJ * static_cast<T>(8.0f);
            elem.is_eroded = true;
            elem.sigma[0][0] = elem.sigma[1][1] = elem.sigma[2][2] = static_cast<T>(0.0f);
            elem.sigma[0][1] = elem.sigma[1][2] = elem.sigma[2][0] = static_cast<T>(0.0f);
            elem.s_dev[0][0] = elem.s_dev[1][1] = elem.s_dev[2][2] = static_cast<T>(0.0f);
            elem.s_dev[0][1] = elem.s_dev[1][2] = elem.s_dev[2][0] = static_cast<T>(0.0f);
            if (d_erosion_flag) *d_erosion_flag = 1;
            return; // Skip force generation and cleanly erode inverted or severely crushed elements
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

        // Spatial shape function derivatives dN_dx[8][3] at t^{n+1}
        for (int i = 0; i < 8; ++i) {
            for (int c = 0; c < 3; ++c) {
                dN_dx[i][c] = J_inv[c][0] * dN_dxi[i][0] + J_inv[c][1] * dN_dxi[i][1] + J_inv[c][2] * dN_dxi[i][2];
            }
        }

        T detJ_mid = J_mid[0][0] * (J_mid[1][1]*J_mid[2][2] - J_mid[1][2]*J_mid[2][1])
                   - J_mid[0][1] * (J_mid[1][0]*J_mid[2][2] - J_mid[1][2]*J_mid[2][0])
                   + J_mid[0][2] * (J_mid[1][0]*J_mid[2][1] - J_mid[1][1]*J_mid[2][0]);
        if (detJ_mid > static_cast<T>(1.0e-15f)) {
            T invDetJ_mid = static_cast<T>(1.0f) / detJ_mid;
            T J_inv_mid[3][3];
            J_inv_mid[0][0] = (J_mid[1][1]*J_mid[2][2] - J_mid[1][2]*J_mid[2][1]) * invDetJ_mid;
            J_inv_mid[0][1] = (J_mid[0][2]*J_mid[2][1] - J_mid[0][1]*J_mid[2][2]) * invDetJ_mid;
            J_inv_mid[0][2] = (J_mid[0][1]*J_mid[1][2] - J_mid[0][2]*J_mid[1][1]) * invDetJ_mid;
            J_inv_mid[1][0] = (J_mid[1][2]*J_mid[2][0] - J_mid[1][0]*J_mid[2][2]) * invDetJ_mid;
            J_inv_mid[1][1] = (J_mid[0][0]*J_mid[2][2] - J_mid[0][2]*J_mid[2][0]) * invDetJ_mid;
            J_inv_mid[1][2] = (J_mid[0][2]*J_mid[1][0] - J_mid[0][0]*J_mid[1][2]) * invDetJ_mid;
            J_inv_mid[2][0] = (J_mid[1][0]*J_mid[2][1] - J_mid[1][1]*J_mid[2][0]) * invDetJ_mid;
            J_inv_mid[2][1] = (J_mid[0][1]*J_mid[2][0] - J_mid[0][0]*J_mid[2][1]) * invDetJ_mid;
            J_inv_mid[2][2] = (J_mid[0][0]*J_mid[1][1] - J_mid[0][1]*J_mid[1][0]) * invDetJ_mid;
            for (int i = 0; i < 8; ++i) {
                for (int c = 0; c < 3; ++c) {
                    dN_dx_mid[i][c] = J_inv_mid[c][0] * dN_dxi[i][0] + J_inv_mid[c][1] * dN_dxi[i][1] + J_inv_mid[c][2] * dN_dxi[i][2];
                }
            }
        } else {
            for (int i = 0; i < 8; ++i) {
                for (int c = 0; c < 3; ++c) {
                    dN_dx_mid[i][c] = dN_dx[i][c];
                }
            }
        }
        J_anp = (elem.V0 > static_cast<T>(1.0e-18f)) ? (elem.V / elem.V0) : static_cast<T>(1.0f);
    }

    // Strain rate tensor components (midpoint kinematics across [t^n, t^{n+1}])
    T strain_rate[6] = {0.0f};
    for (int i = 0; i < n_elem_nodes; ++i) {
        strain_rate[0] += dN_dx_mid[i][0] * v_rel[i][0];
        strain_rate[1] += dN_dx_mid[i][1] * v_rel[i][1];
        strain_rate[2] += dN_dx_mid[i][2] * v_rel[i][2];
        strain_rate[3] += dN_dx_mid[i][1] * v_rel[i][0] + dN_dx_mid[i][0] * v_rel[i][1];
        strain_rate[4] += dN_dx_mid[i][2] * v_rel[i][1] + dN_dx_mid[i][1] * v_rel[i][2];
        strain_rate[5] += dN_dx_mid[i][0] * v_rel[i][2] + dN_dx_mid[i][2] * v_rel[i][0];
    }
    T div_v = strain_rate[0] + strain_rate[1] + strain_rate[2];
    if (is_tet4 && !is_energetic_elem && !elem.is_detached && d_nodal_vol_cur && d_nodal_dvol_dt) {
        T div_v_anp_sum = static_cast<T>(0.0f);
        int valid_anp = 0;
        for (int n = 0; n < 4; ++n) {
            int nid = elem.node_ids[n];
            if (nid >= 0 && nid < num_nodes && d_nodal_vol_cur[nid] > static_cast<T>(1.0e-18f)) {
                div_v_anp_sum += d_nodal_dvol_dt[nid] / d_nodal_vol_cur[nid];
                valid_anp++;
            }
        }
        if (valid_anp > 0) {
            T div_v_anp = div_v_anp_sum / static_cast<T>(valid_anp);
            T div_v_eff = static_cast<T>(0.85f) * div_v_anp + static_cast<T>(0.15f) * div_v;
            T d_vol_corr = (div_v_eff - div_v) / static_cast<T>(3.0f);
            strain_rate[0] += d_vol_corr;
            strain_rate[1] += d_vol_corr;
            strain_rate[2] += d_vol_corr;
            div_v = div_v_eff;
        }
    }
    if (fabs(div_v) * dt < static_cast<T>(1.0e-15f)) {
        div_v = static_cast<T>(0.0f);
    }

    // Artificial Bulk Viscosity Pressure q
    T h_e = is_tet4
          ? computeTet4CharacteristicLength(x_cur_rel, elem.V > static_cast<T>(1.0e-18f) ? elem.V : static_cast<T>(1.0e-18f))
          : cbrt(elem.V > static_cast<T>(1.0e-18f) ? elem.V : static_cast<T>(1.0e-18f));
    T p_constit = -(elem.sigma[0][0] + elem.sigma[1][1] + elem.sigma[2][2]) / static_cast<T>(3.0f) - elem.q_visc;
    T v_rel_1pt = is_tet4
        ? J_anp
        : ((elem.V0 > static_cast<T>(1.0e-18f) && elem.V > static_cast<T>(0.0f)) ? (elem.V / elem.V0) : static_cast<T>(1.0f));
    cd = computeDilatationalWaveSpeed<T>(mat, v_rel_1pt, elem.lambda, p_constit, elem.e_int);
    b1 = static_cast<T>(mat.bulk_viscosity_b1 > 0.0f ? mat.bulk_viscosity_b1 : physics_params.bulk_viscosity_b1);
    b2 = static_cast<T>(mat.bulk_viscosity_b2 > 0.0f ? mat.bulk_viscosity_b2 : physics_params.bulk_viscosity_b2);
    T rho_curr = density / fmax(static_cast<T>(0.05f), v_rel_1pt);
    T q_visc = (div_v < static_cast<T>(0.0f))
             ? (rho_curr * (-b1 * h_e * div_v * cd + b2 * h_e * h_e * div_v * div_v))
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
    bool is_jc = (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen && mat.jc_A > static_cast<T>(0.0f));
    T A_mat = is_jc ? static_cast<T>(mat.jc_A) : static_cast<T>(mat.yield_stress);
    T B_mat = is_jc ? static_cast<T>(mat.jc_B) : static_cast<T>(mat.hardening_modulus);
    T n_exp = is_jc ? static_cast<T>(mat.jc_n) : static_cast<T>(1.0f);
    T C_rate = is_jc ? static_cast<T>(mat.jc_C) : static_cast<T>(0.0f);
    T m_exp = is_jc ? static_cast<T>(mat.jc_m) : static_cast<T>(0.0f);
    T T_melt = static_cast<T>(mat.T_melt > 0.0f ? mat.T_melt : 1793.0f);
    T T_room = static_cast<T>(mat.T_room > 0.0f ? mat.T_room : 293.0f);

    T ep_val = (elem.ep_bar > static_cast<T>(0.0f)) ? elem.ep_bar : static_cast<T>(0.0f);
    T hard_term = (B_mat > static_cast<T>(0.0f) && ep_val > static_cast<T>(0.0f))
        ? (B_mat * (n_exp > static_cast<T>(0.0f) ? pow(ep_val, n_exp) : static_cast<T>(1.0f)))
        : static_cast<T>(0.0f);
    T sigma_hard = A_mat + hard_term;

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
        if (T_star > static_cast<T>(0.0f)) {
            thermal_factor = static_cast<T>(1.0f) - pow(T_star, m_exp);
            if (thermal_factor < static_cast<T>(0.01f)) thermal_factor = static_cast<T>(0.01f);
        }
    }
    uint32_t user_seed_1pt = static_cast<uint32_t>(physics_params.random_seed) * 2654435761u;
    uint32_t elem_seed_1pt = user_seed_1pt ^ (static_cast<uint32_t>(elem.node_ids[0]) * 73856093u)
                                           ^ (static_cast<uint32_t>(elem.node_ids[is_tet4 ? 3 : 6]) * 19349663u)
                                           ^ (static_cast<uint32_t>(idx) * 83492791u);
    T L_corr_1pt = fmax(static_cast<T>(3.0f) * h_e, static_cast<T>(mat.nonlocal_radius));
    T het_factor_1pt = computeFEMWeibullFactor<T>(elem_seed_1pt, physics_params, x0_center[0], x0_center[1], x0_center[2], L_corr_1pt, &mat);
    dynamic_yield = fmax(static_cast<T>(1.0f), sigma_hard * strain_rate_factor * thermal_factor * het_factor_1pt);
    if (elem.is_detached) {
        dynamic_yield *= static_cast<T>(0.15f);
    }

    // 1. Calculate Velocity Gradient Tensor L[3][3] (midpoint kinematics)
    T L[3][3] = {{static_cast<T>(0.0f)}};
    for (int i = 0; i < n_elem_nodes; ++i) {
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                L[r][c] += v_rel[i][r] * dN_dx_mid[i][c];
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
    if (is_tet4 && !is_energetic_elem && !elem.is_detached) {
        T F_det_new = F_new[0][0] * (F_new[1][1]*F_new[2][2] - F_new[1][2]*F_new[2][1])
                    - F_new[0][1] * (F_new[1][0]*F_new[2][2] - F_new[1][2]*F_new[2][0])
                    + F_new[0][2] * (F_new[1][0]*F_new[2][1] - F_new[1][1]*F_new[2][0]);
        if (F_det_new > static_cast<T>(1.0e-12f) && J_anp > static_cast<T>(1.0e-12f)) {
            T scale_F = cbrt(J_anp / F_det_new);
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    F_new[r][c] *= scale_F;
                }
            }
        }
    }
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            elem.F[r][c] = F_new[r][c];
        }
    }

    // Increment deviatoric trial stress with numerical relaxation
    T vol_strain = is_tet4
                 ? (J_anp - static_cast<T>(1.0f))
                 : ((elem.V0 > static_cast<T>(1.0e-18f)) ? (elem.V / elem.V0 - static_cast<T>(1.0f)) : static_cast<T>(0.0f));
    if (fabs(vol_strain) < static_cast<T>(1.0e-14f)) {
        vol_strain = static_cast<T>(0.0f);
    }

    const bool is_energetic = (mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
                               mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
                               mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);

    // Mie-Grueneisen Shock EOS, Tait Water, or Three-Pillar Energetic Materials
    T p_hydro = static_cast<T>(0.0f);
    if (is_energetic) {
        T V_rel = is_tet4 ? J_anp : ((elem.V0 > static_cast<T>(1.0e-18f)) ? (elem.V / elem.V0) : static_cast<T>(1.0f));
        float v_rel_f = fmaxf(static_cast<float>(V_rel), 0.02f);
        float lam_curr = static_cast<float>(elem.lambda);
        float lam_new = lam_curr;

        bool is_crest_kinetics = (mat.burn_model == ReactionKinetics::CRESTEntropy) ||
                                 (mat.material_model == MPMMaterialModel::CRESTReactiveBurn && mat.burn_model != ReactionKinetics::LeeTarverODE);
        bool is_lt_kinetics = (mat.burn_model == ReactionKinetics::LeeTarverODE) ||
                              (mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth && mat.burn_model != ReactionKinetics::CRESTEntropy);
        bool use_davis_solid = (mat.solid_model == SolidReactantEOS::DavisSolid) ||
                               (mat.material_model == MPMMaterialModel::CRESTReactiveBurn);
        const bool awe = is_crest_kinetics && mat.crest_awe_c0 > 0.0f;
        CrestDavis::CRESTSolidParams awe_q{};
        float awe_vtmd = 1.0f;
        if (awe) {
            const float rho0s = (mat.davis_rho0 > 0.0f) ? mat.davis_rho0 : mat.density;
            awe_q = {mat.density, rho0s, mat.crest_awe_K0s, mat.detonation_energy,
                     mat.crest_awe_A1, mat.crest_awe_A2, mat.crest_awe_A3,
                     mat.crest_awe_B1, mat.crest_awe_B2, mat.crest_awe_B3,
                     mat.crest_awe_fc, mat.crest_awe_delta,
                     mat.crest_awe_Gamma1, mat.crest_awe_Gamma2, mat.crest_awe_gamma00, mat.crest_awe_m};
            awe_vtmd = rho0s / mat.density;
        }
        bool use_davis_prod = !awe && ((mat.product_model == DetonationProductEOS::DavisProduct) ||
                              (mat.material_model == MPMMaterialModel::CRESTReactiveBurn));

        float p_curr_comp = static_cast<float>(-(elem.sigma[0][0] + elem.sigma[1][1] + elem.sigma[2][2]) / static_cast<T>(3.0f));
        if (p_curr_comp < 0.0f) p_curr_comp = 0.0f;

        if (awe) {
            elem.v_min = fmin(elem.v_min, static_cast<T>(v_rel_f));
            elem.s_shock = fmax(elem.s_shock, static_cast<T>(CrestDavis::computeCRESTShockEntropy(static_cast<double>(elem.v_min), awe_q)));
            float e_th_trial = fmaxf(0.0f, static_cast<float>(elem.e_int) - lam_curr * mat.detonation_energy);
            float p_react_trial = static_cast<float>(CrestDavis::computeCRESTSolidPressure(v_rel_f, e_th_trial, awe_q));
            float p_mech_trial = p_react_trial + static_cast<float>(q_visc);
            float p_eff_comp = (lam_curr <= 1.0e-5f) ? fmaxf(p_curr_comp, p_mech_trial) : p_mech_trial;
            if (p_eff_comp > 1.0e6f)
                elem.s_shock = fmax(elem.s_shock, static_cast<T>(CrestDavis::computeCRESTShockEntropyFromPressure(p_eff_comp, awe_q)));
            lam_new = static_cast<float>(CrestDavis::advanceAWECRESTProgress(static_cast<double>(dt), static_cast<double>(elem.s_shock), lam_curr,
                    mat.crest_awe_c0, mat.crest_awe_c1, mat.crest_awe_c2, mat.crest_awe_c3, mat.crest_awe_c6,
                    mat.crest_awe_c8, mat.crest_awe_c9, mat.crest_awe_c10, mat.crest_awe_c11, mat.crest_awe_c12, mat.crest_awe_c13));
        } else if (is_crest_kinetics) {
            elem.v_min = fmin(elem.v_min, static_cast<T>(v_rel_f));
            float s_calc = CrestDavis::computeDavisShockEntropy(
                static_cast<float>(elem.v_min), mat.davis_c0, mat.davis_s1, mat.davis_gamma0,
                mat.davis_cv, mat.davis_t0, mat.davis_rho0);
            elem.s_shock = fmax(elem.s_shock, static_cast<T>(s_calc));

            float q_heat_trial = use_davis_prod ? mat.davis_q_det : mat.detonation_energy;
            float e_th_trial = fmaxf(0.0f, static_cast<float>(elem.e_int) - lam_curr * q_heat_trial);
            float p_react_trial = use_davis_solid
                ? CrestDavis::computeDavisReactantPressure(v_rel_f, e_th_trial, mat.davis_c0, mat.davis_s1, mat.davis_gamma0, mat.davis_cv, mat.davis_t0, mat.davis_rho0)
                : JWL::computeSolidReactantPressure(v_rel_f, e_th_trial, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mat.density);
            float p_mech_trial = p_react_trial + static_cast<float>(q_visc);
            float p_eff_comp = (lam_curr <= 1.0e-5f) ? fmaxf(p_curr_comp, p_mech_trial) : p_mech_trial;
            if (p_eff_comp > 1.0e6f) {
                float s_p = CrestDavis::computeDavisShockEntropyFromPressure(
                    p_eff_comp, mat.davis_c0, mat.davis_s1, mat.davis_cv, mat.davis_t0, mat.davis_rho0);
                elem.s_shock = fmax(elem.s_shock, static_cast<T>(s_p));
            }

            lam_new = CrestDavis::advanceCRESTProgress(
                static_cast<float>(dt), static_cast<float>(elem.s_shock), lam_curr,
                mat.crest_b1, mat.crest_c1, mat.crest_m1,
                mat.crest_b2, mat.crest_c2, mat.crest_c3, mat.crest_m2,
                mat.crest_s0, mat.crest_s_threshold);
        } else if (is_lt_kinetics) {
            const float q_heat_lt = use_davis_prod ? mat.davis_q_det : mat.detonation_energy;
            const float e_th_lt = fmaxf(0.0f, static_cast<float>(elem.e_int) - lam_curr * q_heat_lt);
            float p_react_trial = (mat.solid_model == SolidReactantEOS::JWLReactant)
                ? JWL::computeJWLReactantPressure(v_rel_f, e_th_lt, mat.jwlr_A, mat.jwlr_B, mat.jwlr_R1, mat.jwlr_R2, mat.jwlr_omega, mat.jwlr_Cv, mat.jwlr_T0, mat.density)
                : use_davis_solid
                ? CrestDavis::computeDavisReactantPressure(v_rel_f, e_th_lt, mat.davis_c0, mat.davis_s1, mat.davis_gamma0, mat.davis_cv, mat.davis_t0, mat.davis_rho0)
                : JWL::computeSolidReactantPressure(v_rel_f, e_th_lt, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mat.density);
            float p_lt = fmaxf(p_curr_comp, p_react_trial + static_cast<float>(q_visc));
            lam_new = LeeTarver::advanceLeeTarver(
                static_cast<float>(dt), lam_curr, v_rel_f, p_lt,
                mat.lt_I, mat.lt_a, mat.lt_b, mat.lt_x, mat.lt_ig_max,
                mat.lt_G1, mat.lt_c, mat.lt_d, mat.lt_y, mat.lt_growth_max,
                mat.lt_G2, mat.lt_e, mat.lt_g, mat.lt_z, mat.lt_comp_min);
        } else {
            float t_arr = static_cast<float>(elem.t_arrival);
            float eff_dx = (mat.cell_dx > 0.0f) ? mat.cell_dx : fmaxf(2.0f * static_cast<float>(h_e), 0.002f);
            float tau_burn = fmaxf(static_cast<float>(mat.burn_zone_cells) * eff_dx / fmaxf(mat.det_vel, 100.0f), mat.tau_burn_min);
            float lam_prog = JWL::computeProgrammedProgress(static_cast<float>(sim_time), t_arr, tau_burn);
            lam_new = fmaxf(lam_curr, lam_prog);
        }

        elem.lambda = static_cast<T>(lam_new);
        float d_lam = fmaxf(0.0f, lam_new - lam_curr);

        float q_heat = use_davis_prod ? mat.davis_q_det : mat.detonation_energy;
        float e_th = static_cast<float>(elem.e_int) - lam_curr * q_heat;
        float e_prod = e_th + q_heat;

        float p_ambient = 101325.0f;
        const bool use_jwl_reactant = (mat.solid_model == SolidReactantEOS::JWLReactant);
        auto solid_pressure_at = [&](float v) -> float {
            return awe
                ? (p_ambient + static_cast<float>(CrestDavis::computeCRESTSolidPressure(v, fmaxf(0.0f, e_th), awe_q)))
                : use_jwl_reactant
                ? (p_ambient + JWL::computeJWLReactantPressure(v, e_th, mat.jwlr_A, mat.jwlr_B, mat.jwlr_R1, mat.jwlr_R2, mat.jwlr_omega, mat.jwlr_Cv, mat.jwlr_T0, mat.density))
                : use_davis_solid
                ? (p_ambient + CrestDavis::computeDavisReactantPressure(v, e_th, mat.davis_c0, mat.davis_s1, mat.davis_gamma0, mat.davis_cv, mat.davis_t0, mat.davis_rho0))
                : (p_ambient + JWL::computeSolidReactantPressure(v, e_th, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mat.density));
        };
        auto product_pressure_at = [&](float v) -> float {
            return awe
                ? JWL::computeJWLProductPressure(v * awe_vtmd, e_prod, mat.jwl_A, mat.jwl_B, mat.jwl_R1, mat.jwl_R2, mat.jwl_omega, static_cast<float>(awe_q.rho0s))
                : use_davis_prod
                ? CrestDavis::computeDavisProductPressure(v, e_prod, mat.davis_a, mat.davis_b, mat.davis_k, mat.davis_vc, mat.davis_pc, mat.davis_q_det, mat.davis_rho0)
                : JWL::computeJWLProductPressure(v, e_prod, mat.jwl_A, mat.jwl_B, mat.jwl_R1, mat.jwl_R2, mat.jwl_omega, mat.density);
        };

        // Lee-Tarver kinetics use the selectable mixture rule (default: pressure equilibrium, volume additive);
        // all other reactive models keep the linear blend.
        const Mixture::Rule mix_rule = is_lt_kinetics
            ? static_cast<Mixture::Rule>(mat.mixture_rule) : Mixture::Rule::LinearBlend;
        const Mixture::Result mix = Mixture::mixturePressure(mix_rule, static_cast<double>(v_rel_f), static_cast<double>(lam_new),
            [&](double v) { return static_cast<double>(solid_pressure_at(static_cast<float>(v))); },
            [&](double v) { return static_cast<double>(product_pressure_at(static_cast<float>(v))); });
        float p_mix = static_cast<float>(mix.p);
        if (!isfinite(p_mix)) p_mix = 0.0f;   // numerical guard only; tension is physical and is not clipped
        // Phase pressures at the phase volumes chosen by the mixture rule (used by sound-speed/CFL closures)
        [[maybe_unused]] const float p_solid = solid_pressure_at(static_cast<float>(mix.v_s));
        [[maybe_unused]] const float p_prod = product_pressure_at(static_cast<float>(mix.v_p));

        float rho_eff = (mat.density > 10.0f) ? mat.density : (use_davis_solid ? mat.davis_rho0 : 1630.0f);
        float tr_deps = static_cast<float>(div_v * dt);
        float de_comp = -((p_mix + static_cast<float>(q_visc)) / rho_eff) * tr_deps * v_rel_f;   // PdV work in BOTH directions
        float de_chem = d_lam * q_heat;
        elem.e_int += static_cast<T>(de_comp + de_chem);

        float cv_eff = use_davis_solid ? (mat.davis_cv > 1.0f ? mat.davis_cv : 1000.0f) : (mat.Cp > 1.0f ? mat.Cp : 1000.0f);
        float t0_eff = use_davis_solid ? mat.davis_t0 : mat.T_room;
        elem.temperature = static_cast<T>(t0_eff) + elem.e_int / static_cast<T>(cv_eff);

        p_hydro = static_cast<T>(p_mix) + q_visc;
        G *= static_cast<T>(1.0f - lam_new);
        dynamic_yield *= static_cast<T>(1.0f - lam_new);

        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                elem.s_dev[r][c] += static_cast<T>(2.0f) * G * d_dev[r][c] * dt;
            }
        }
        if (elem.lambda >= static_cast<T>(0.99f)) {
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    elem.s_dev[r][c] = static_cast<T>(0.0f);
                }
            }
        } else {
            T s_norm = sqrt(
                elem.s_dev[0][0]*elem.s_dev[0][0] + elem.s_dev[1][1]*elem.s_dev[1][1] + elem.s_dev[2][2]*elem.s_dev[2][2] +
                static_cast<T>(2.0f)*(elem.s_dev[0][1]*elem.s_dev[0][1] + elem.s_dev[1][2]*elem.s_dev[1][2] + elem.s_dev[2][0]*elem.s_dev[2][0])
            );
            T vm_trial = sqrt(static_cast<T>(1.5f)) * s_norm;
            if (vm_trial > dynamic_yield && vm_trial > static_cast<T>(1.0e-6f)) {
                T scale = dynamic_yield / vm_trial;
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        elem.s_dev[r][c] *= scale;
                    }
                }
            }
        }
        if (elem.is_detached) {
            if (p_hydro < static_cast<T>(0.0f)) p_hydro = static_cast<T>(0.0f);
        }
    } else {
        T J_vol_elem = is_tet4
            ? J_anp
            : ((elem.V0 > static_cast<T>(1.0e-18f) && elem.V > static_cast<T>(0.0f)) ? (elem.V / elem.V0) : static_cast<T>(1.0f));
        T weibull_fac = het_factor_1pt;
        runFEMConstitutivePoint<T>(
            mat, physics_params, elem.F, d_dev, div_v, J_vol_elem, dt,
            h_e, q_visc, weibull_fac, elem.is_detached,
            elem.s_dev, p_constit, p_hydro,
            elem.ep_bar, elem.damage, elem.lambda,
            elem.temperature, elem.e_int
        );
        if (mat.material_model == MPMMaterialModel::TaitWater ||
            mat.material_model == MPMMaterialModel::IdealGas) {
            elem.q_visc = static_cast<T>(0.0f);
        }
    }

    // Stress Assembly (sigma = s_dev - p_hydro*I; bulk viscosity q_visc is already in p_hydro)
    for (int r = 0; r < 3; ++r) {
        for (int c = 0; c < 3; ++c) {
            elem.sigma[r][c] = elem.s_dev[r][c] - (r == c ? p_hydro : static_cast<T>(0.0f));
        }
    }

    // Nodal Internal Force Assembly via atomicAdd
    for (int i = 0; i < n_elem_nodes; ++i) {
        int nid = elem.node_ids[i];
        T f_x = (dN_dx[i][0] * elem.sigma[0][0] + dN_dx[i][1] * elem.sigma[0][1] + dN_dx[i][2] * elem.sigma[0][2]) * elem.V;
        T f_y = (dN_dx[i][0] * elem.sigma[1][0] + dN_dx[i][1] * elem.sigma[1][1] + dN_dx[i][2] * elem.sigma[1][2]) * elem.V;
        T f_z = (dN_dx[i][0] * elem.sigma[2][0] + dN_dx[i][1] * elem.sigma[2][1] + dN_dx[i][2] * elem.sigma[2][2]) * elem.V;

        atomicAdd(&d_nodes[nid].f_int[0], f_x);
        atomicAdd(&d_nodes[nid].f_int[1], f_y);
        atomicAdd(&d_nodes[nid].f_int[2], f_z);
    }

    // Hourglass Forces via atomicAdd (Hex8 only; Tet4 has 0 hourglass modes)
    if (!is_tet4 && hourglass_coeff > static_cast<T>(0.0f)) {
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

        T viscous_factor = static_cast<T>(0.05f) * elem_hg_coeff * density * cd * h_e * h_e;
        T stiffness_factor = static_cast<T>(0.25f) * elem_hg_coeff * E * h_e;
        T nu_kf = nu;
        if (nu_kf > static_cast<T>(0.45f)) nu_kf = static_cast<T>(0.45f);
        if (nu_kf < static_cast<T>(0.0f)) nu_kf = static_cast<T>(0.0f);
        T G_kf = E / (static_cast<T>(2.0f) * (static_cast<T>(1.0f) + nu_kf));
        T lambda_kf = (E * nu_kf) / ((static_cast<T>(1.0f) + nu_kf) * (static_cast<T>(1.0f) - static_cast<T>(2.0f) * nu_kf));
        T b_norm_sq = static_cast<T>(0.0f);
        for (int n = 0; n < 8; ++n) {
            b_norm_sq += dN_dx[n][0] * dN_dx[n][0] + dN_dx[n][1] * dN_dx[n][1] + dN_dx[n][2] * dN_dx[n][2];
        }
        T c_stiff_kf = static_cast<T>(0.5f) * elem_hg_coeff * (lambda_kf + static_cast<T>(2.0f) * G_kf) * elem.V * b_norm_sq;
        const bool is_kf_hg = (elem_hg_model == FEMHourglassModel::KosloffFrazier || elem_scheme == FEMIntegrationScheme::OnePointKF);

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
                    T f_hg = (elem_hg_model == FEMHourglassModel::FlanaganBelytschkoViscous && !is_kf_hg)
                             ? gamma_ortho[n] * (viscous_factor * q_vel[c] + static_cast<T>(0.10f) * stiffness_factor * q_disp[c])
                             : (is_kf_hg
                                ? gamma_ortho[n] * (c_stiff_kf * q_disp[c] + static_cast<T>(0.15f) * viscous_factor * q_vel[c])
                                : gamma_ortho[n] * (stiffness_factor * q_disp[c] + static_cast<T>(0.25f) * viscous_factor * q_vel[c]));
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
        if (node.is_prescribed[c]) {
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

// CUDA Kernel: Erosion Check (Negative volume, min_volume_ratio, max_volume_ratio, damage, plastic strain, tensile stress, timestep ratio)
template <typename T>
__global__ void fem_initial_timestep_erosion_kernel_3d_device(
    FEMNode3D<T>* d_nodes,
    FEMElement3D<T>* d_elements,
    int num_elements,
    const MaterialTable3D* d_materials,
    FEMErosionCriteria<T> erosion_criteria,
    int* d_erosion_flag,
    bool enable_cohesive_splitting,
    const int* d_face_neighbors,
    bool enable_nonlocal_damage,
    BlastPhysicsParams<T> physics_params = BlastPhysicsParams<T>{}
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_elements) return;

    FEMElement3D<T>& elem = d_elements[idx];
    if (elem.is_eroded) return;

    const bool is_tet4 = isTet4Element(elem);
    const MaterialTable3D& mat = d_materials[elem.mat_id];

    const bool is_energetic = (mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
                               mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
                               mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);
    if (is_energetic) {
        T v_rel_e = (elem.V0 > static_cast<T>(1.0e-18f) && elem.V > static_cast<T>(0.0f))
            ? (elem.V / elem.V0) : static_cast<T>(0.0f);
        if (elem.V <= static_cast<T>(1.0e-18f) ||
            v_rel_e <= static_cast<T>(0.005f) ||
            v_rel_e >= static_cast<T>(25.0f)) {
            elem.is_eroded = true;
            elem.mpm_converted = true;
            elem.sigma[0][0] = elem.sigma[1][1] = elem.sigma[2][2] = static_cast<T>(0.0f);
            elem.sigma[0][1] = elem.sigma[1][2] = elem.sigma[2][0] = static_cast<T>(0.0f);
            elem.s_dev[0][0] = elem.s_dev[1][1] = elem.s_dev[2][2] = static_cast<T>(0.0f);
            elem.s_dev[0][1] = elem.s_dev[1][2] = elem.s_dev[2][0] = static_cast<T>(0.0f);
            if (d_erosion_flag) *d_erosion_flag = 1;
        }
        return;
    }

    T v_rel_e = (elem.V0 > static_cast<T>(1.0e-18f) && elem.V > static_cast<T>(0.0f))
        ? (elem.V / elem.V0) : static_cast<T>(1.0f);
    T p_el_e = -(elem.sigma[0][0] + elem.sigma[1][1] + elem.sigma[2][2]) / static_cast<T>(3.0f) - elem.q_visc;
    T cd = computeDilatationalWaveSpeed<T>(mat, v_rel_e, elem.lambda, p_el_e, elem.e_int);

    T x_curr[8][3];
    for (int n = 0; n < 8; ++n) {
        int nid = elem.node_ids[n];
        x_curr[n][0] = d_nodes[nid].x[0];
        x_curr[n][1] = d_nodes[nid].x[1];
        x_curr[n][2] = d_nodes[nid].x[2];
    }
    T V_cur = elem.V > static_cast<T>(0.0f) ? elem.V : elem.V0;
    T L_e = is_tet4 ? computeTet4CharacteristicLength(x_curr, V_cur) : computeHex8CharacteristicLength(x_curr, V_cur);
    T current_dt = L_e / cd;

    bool severe_crush = false;
    bool newly_eroded = false;
    const bool global_overrides = (erosion_criteria.enable_strain_erosion ||
                                   erosion_criteria.enable_stress_erosion ||
                                   erosion_criteria.enable_damage_erosion ||
                                   erosion_criteria.enable_timestep_erosion);
    const T mat_min_vol = static_cast<T>(mat.min_volume_ratio > 0.0f ? mat.min_volume_ratio : 0.02f);
    const T min_vol_r = (global_overrides && erosion_criteria.min_volume_ratio > static_cast<T>(0.0f) && mat.min_volume_ratio == 0.02f)
        ? erosion_criteria.min_volume_ratio : mat_min_vol;
    if (elem.V <= static_cast<T>(0.0f) || (elem.V0 > static_cast<T>(1.0e-30f) && (elem.V / elem.V0) <= min_vol_r)) {
        severe_crush = true;
    }

    const T mat_max_vol = static_cast<T>(mat.max_volume_ratio > 1.0f ? mat.max_volume_ratio : 0.0f);
    const T max_vol_r = (global_overrides && erosion_criteria.max_volume_ratio > static_cast<T>(1.0f) && mat.max_volume_ratio == 5.00f)
        ? erosion_criteria.max_volume_ratio : mat_max_vol;
    if (max_vol_r > static_cast<T>(1.0f) && elem.V0 > static_cast<T>(1.0e-30f) && (elem.V / elem.V0) >= max_vol_r) {
        severe_crush = true;
    }

    bool check_dt = (mat.enable_timestep_erosion || erosion_criteria.enable_timestep_erosion);
    T eta = static_cast<T>((mat.enable_timestep_erosion && mat.timestep_erosion_factor > 1.0e-5f)
        ? mat.timestep_erosion_factor
        : (erosion_criteria.timestep_erosion_factor > static_cast<T>(1.0e-5f) ? erosion_criteria.timestep_erosion_factor : static_cast<T>(mat.timestep_erosion_factor)));
    if (check_dt && eta > static_cast<T>(1.0e-5f)) {
        T dt0_eff = elem.dt0;
        if (dt0_eff <= static_cast<T>(1.0e-12f) || dt0_eff >= static_cast<T>(1.0e20f)) {
            T x_0[8][3];
            for (int n = 0; n < 8; ++n) {
                int nid = elem.node_ids[n];
                x_0[n][0] = d_nodes[nid].x0[0];
                x_0[n][1] = d_nodes[nid].x0[1];
                x_0[n][2] = d_nodes[nid].x0[2];
            }
            T L_e0 = is_tet4 ? computeTet4CharacteristicLength(x_0, elem.V0) : computeHex8CharacteristicLength(x_0, elem.V0);
            T cd0 = computeDilatationalWaveSpeed<T>(mat);
            dt0_eff = L_e0 / cd0;
        }
        if (current_dt <= eta * dt0_eff) {
            severe_crush = true;
        }
    }

    const int n_self = is_tet4 ? 4 : 8;
    const T inv_n_self = is_tet4 ? static_cast<T>(0.25f) : static_cast<T>(0.125f);
    T c_self[3] = {static_cast<T>(0), static_cast<T>(0), static_cast<T>(0)};
    for (int n = 0; n < n_self; ++n) {
        int nid = elem.node_ids[n];
        c_self[0] += d_nodes[nid].x0[0];
        c_self[1] += d_nodes[nid].x0[1];
        c_self[2] += d_nodes[nid].x0[2];
    }
    c_self[0] *= inv_n_self; c_self[1] *= inv_n_self; c_self[2] *= inv_n_self;

    T ep_eval = elem.ep_bar;
    if (enable_nonlocal_damage && d_face_neighbors != nullptr && mat.nonlocal_radius > 1.0e-4f) {
        T w_self = elem.V0 > static_cast<T>(0.0f) ? elem.V0 : static_cast<T>(1.0f);
        T ep_sum = elem.ep_bar * w_self;
        T w_sum = w_self;
        T R_nl = static_cast<T>(mat.nonlocal_radius);
        T R_sq = fmax(static_cast<T>(1.0e-12f), R_nl * R_nl);
        for (int f = 0; f < 6; ++f) {
            int nb = d_face_neighbors[idx * 6 + f];
            if (nb >= 0 && nb < num_elements && !d_elements[nb].is_eroded) {
                const auto& nb_elem = d_elements[nb];
                const bool nb_tet = isTet4Element(nb_elem);
                const int n_nb = nb_tet ? 4 : 8;
                const T inv_n_nb = nb_tet ? static_cast<T>(0.25f) : static_cast<T>(0.125f);
                T c_nb[3] = {static_cast<T>(0), static_cast<T>(0), static_cast<T>(0)};
                for (int n = 0; n < n_nb; ++n) {
                    int nid = nb_elem.node_ids[n];
                    c_nb[0] += d_nodes[nid].x0[0];
                    c_nb[1] += d_nodes[nid].x0[1];
                    c_nb[2] += d_nodes[nid].x0[2];
                }
                c_nb[0] *= inv_n_nb; c_nb[1] *= inv_n_nb; c_nb[2] *= inv_n_nb;
                T dx = c_self[0] - c_nb[0];
                T dy = c_self[1] - c_nb[1];
                T dz = c_self[2] - c_nb[2];
                T dist_sq = dx * dx + dy * dy + dz * dz;
                T w_gauss = exp(-dist_sq / R_sq);
                T w_nb = w_gauss * (nb_elem.V0 > static_cast<T>(0.0f) ? nb_elem.V0 : static_cast<T>(1.0f));
                ep_sum += nb_elem.ep_bar * w_nb;
                w_sum += w_nb;
            }
        }
        if (w_sum > static_cast<T>(0.0f)) {
            ep_eval = ep_sum / w_sum;
        }
    }

    uint32_t user_seed = static_cast<uint32_t>(physics_params.random_seed) * 2654435761u;
    uint32_t elem_seed = user_seed ^ (static_cast<uint32_t>(elem.node_ids[0]) * 73856093u)
                                   ^ (static_cast<uint32_t>(elem.node_ids[is_tet4 ? 3 : 6]) * 19349663u)
                                   ^ (static_cast<uint32_t>(idx) * 83492791u);
    T L_corr_er = fmax(static_cast<T>(3.0f) * L_e, static_cast<T>(mat.nonlocal_radius));
    T het_factor = computeFEMWeibullFactor<T>(elem_seed, physics_params, c_self[0], c_self[1], c_self[2], L_corr_er, &mat);

    T aniso_factor = static_cast<T>(1.0f);
    const bool use_aniso = mat.enable_anisotropy || physics_params.enable_anisotropy;
    const T aniso_ratio_val = mat.enable_anisotropy ? static_cast<T>(mat.anisotropy_ratio) : physics_params.anisotropy_ratio;
    if (use_aniso && fabs(aniso_ratio_val - static_cast<T>(1.0f)) > static_cast<T>(1.0e-4f)) {
        T ax = mat.enable_anisotropy ? static_cast<T>(mat.anisotropy_dir[0]) : physics_params.anisotropy_dir[0];
        T ay = mat.enable_anisotropy ? static_cast<T>(mat.anisotropy_dir[1]) : physics_params.anisotropy_dir[1];
        T az = mat.enable_anisotropy ? static_cast<T>(mat.anisotropy_dir[2]) : physics_params.anisotropy_dir[2];
        T alen = sqrt(ax * ax + ay * ay + az * az);
        if (alen > static_cast<T>(1.0e-6f)) {
            ax /= alen; ay /= alen; az /= alen;
            T s_axial = elem.sigma[0][0] * ax * ax + elem.sigma[1][1] * ay * ay + elem.sigma[2][2] * az * az +
                        static_cast<T>(2.0f) * (elem.sigma[0][1] * ax * ay + elem.sigma[1][2] * ay * az + elem.sigma[2][0] * az * ax);
            T s_norm = sqrt(elem.sigma[0][0]*elem.sigma[0][0] + elem.sigma[1][1]*elem.sigma[1][1] + elem.sigma[2][2]*elem.sigma[2][2] +
                            static_cast<T>(2.0f)*(elem.sigma[0][1]*elem.sigma[0][1] + elem.sigma[1][2]*elem.sigma[1][2] + elem.sigma[2][0]*elem.sigma[2][0]));
            if (s_norm > static_cast<T>(1.0e-6f)) {
                T xi = fmin(static_cast<T>(1.0f), fabs(s_axial) / s_norm);
                aniso_factor = static_cast<T>(1.0f) + (aniso_ratio_val - static_cast<T>(1.0f)) * (static_cast<T>(1.0f) - xi * xi);
            }
        }
    }

    bool is_concrete = (mat.material_model == MPMMaterialModel::RHTConcrete ||
                        mat.material_model == MPMMaterialModel::KCConcrete ||
                        mat.material_model == MPMMaterialModel::CSCMConcrete);
    const bool cohesive_active = mat.enable_cohesive_splitting || enable_cohesive_splitting;

    if (!(cohesive_active && elem.is_detached)) {
        if (mat.enable_strain_erosion || erosion_criteria.enable_strain_erosion || cohesive_active) {
            if (is_concrete) {
                T conc_erosion_strain = static_cast<T>(
                    (mat.enable_strain_erosion && mat.erosion_strain > 0.0f) ? mat.erosion_strain :
                    (erosion_criteria.failure_strain > 0.0f ? erosion_criteria.failure_strain :
                     (mat.erosion_strain > 0.0f ? mat.erosion_strain : 0.10f))) * het_factor * aniso_factor;
                bool damage_saturated = (elem.damage >= static_cast<T>(0.95f));
                if ((damage_saturated && ep_eval >= conc_erosion_strain) || (elem.ep_bar >= static_cast<T>(1.5f) * conc_erosion_strain)) {
                    newly_eroded = true;
                }
            } else {
                T fail_strain = static_cast<T>(
                    (mat.enable_strain_erosion && mat.erosion_strain > 0.0f) ? mat.erosion_strain :
                    ((mat.enable_strain_erosion && mat.failure_strain > 0.0f) ? mat.failure_strain :
                     (erosion_criteria.failure_strain > 0.0f ? erosion_criteria.failure_strain :
                      (mat.erosion_strain > 0.0f ? mat.erosion_strain : mat.failure_strain)))) * het_factor * aniso_factor;
                if (fail_strain > static_cast<T>(0.0f) && (ep_eval >= fail_strain || elem.ep_bar >= static_cast<T>(2.0f) * fail_strain)) {
                    newly_eroded = true;
                }
            }
        }

        if (mat.enable_damage_erosion || erosion_criteria.enable_damage_erosion || cohesive_active) {
            T max_dmg = static_cast<T>((mat.enable_damage_erosion && mat.max_damage > 0.0f)
                ? mat.max_damage
                : ((erosion_criteria.max_damage > static_cast<T>(0.0f)) ? erosion_criteria.max_damage : static_cast<T>(mat.max_damage > 0.0f ? mat.max_damage : 0.99f)));
            if (elem.damage >= max_dmg) {
                newly_eroded = true;
            }
        }

        if (mat.enable_stress_erosion || erosion_criteria.enable_stress_erosion || cohesive_active) {
            T mean_s = (elem.sigma[0][0] + elem.sigma[1][1] + elem.sigma[2][2]) / static_cast<T>(3.0f);
            T fail_stress = static_cast<T>(
                (mat.enable_stress_erosion && mat.erosion_stress > 0.0f) ? mat.erosion_stress :
                ((mat.enable_stress_erosion && mat.tensile_failure_stress > 0.0f) ? mat.tensile_failure_stress :
                 (mat.erosion_stress > 0.0f ? mat.erosion_stress :
                  (mat.tensile_failure_stress > 0.0f ? mat.tensile_failure_stress : erosion_criteria.tensile_failure_stress)))) * het_factor * aniso_factor;
            if (fail_stress > static_cast<T>(0.0f) && mean_s >= fail_stress) {
                if (!is_concrete || elem.damage >= static_cast<T>(0.95f)) {
                    newly_eroded = true;
                }
            }
        }
    }

    if (severe_crush) {
        elem.is_eroded = true;
        elem.sigma[0][0] = elem.sigma[1][1] = elem.sigma[2][2] = static_cast<T>(0.0f);
        elem.sigma[0][1] = elem.sigma[1][2] = elem.sigma[2][0] = static_cast<T>(0.0f);
        elem.s_dev[0][0] = elem.s_dev[1][1] = elem.s_dev[2][2] = static_cast<T>(0.0f);
        elem.s_dev[0][1] = elem.s_dev[1][2] = elem.s_dev[2][0] = static_cast<T>(0.0f);
        if (d_erosion_flag) {
            *d_erosion_flag = 1;
        }
    } else if (newly_eroded) {
        if (cohesive_active && !elem.is_detached) {
            elem.damage = static_cast<T>(1.0f);
            elem.decay_step = 10;
            if (d_erosion_flag) {
                *d_erosion_flag = 1;
            }
        } else {
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
    const int n_elem_nodes = isTet4Element(elem) ? 4 : 8;
    for (int k = 0; k < n_elem_nodes; ++k) {
        int nid = elem.node_ids[k];
        if (nid >= 0 && nid < num_nodes) {
            ::atomicAdd(&d_node_active_count[nid], 1);
        }
    }
}

// CUDA Kernel: Count active 1D trusses and 3D beams attached to each node
template <typename T>
__global__ void fem_count_active_node_trusses_and_beams_kernel_device(
    const FEMTrussElement3D<T>* d_trusses,
    int num_trusses,
    const FEMBeam3DElement<T>* d_beams,
    int num_beams,
    int* d_node_active_count,
    int num_nodes
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (d_trusses && idx < num_trusses) {
        const auto& tr = d_trusses[idx];
        if (!tr.is_eroded && tr.L0 > static_cast<T>(0.0f)) {
            for (int k = 0; k < 2; ++k) {
                int nid = tr.node_ids[k];
                if (nid >= 0 && nid < num_nodes) {
                    ::atomicAdd(&d_node_active_count[nid], 1);
                }
            }
        }
    }
    if (d_beams && idx < num_beams) {
        const auto& bm = d_beams[idx];
        if (!bm.is_eroded && bm.L0 > static_cast<T>(0.0f)) {
            for (int k = 0; k < 2; ++k) {
                int nid = bm.node_ids[k];
                if (nid >= 0 && nid < num_nodes) {
                    ::atomicAdd(&d_node_active_count[nid], 1);
                }
            }
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

template <typename T>
__global__ void fem_flush_mpm_impulse_kernel_3d_device(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    T* d_mpm_impulse_accum,
    T inv_dt
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_nodes || !d_mpm_impulse_accum) return;
    d_nodes[idx].f_contact[0] += d_mpm_impulse_accum[idx * 3 + 0] * inv_dt;
    d_nodes[idx].f_contact[1] += d_mpm_impulse_accum[idx * 3 + 1] * inv_dt;
    d_nodes[idx].f_contact[2] += d_mpm_impulse_accum[idx * 3 + 2] * inv_dt;
    d_mpm_impulse_accum[idx * 3 + 0] = static_cast<T>(0.0f);
    d_mpm_impulse_accum[idx * 3 + 1] = static_cast<T>(0.0f);
    d_mpm_impulse_accum[idx * 3 + 2] = static_cast<T>(0.0f);
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
            int n_corners = (facet.node_ids[2] == facet.node_ids[3]) ? 3 : 4;
            for (int k = 0; k < n_corners; ++k) {
                int nid = facet.node_ids[k];
                atomicAdd(&d_node_normals[nid * 3 + 0], facet.normal[0]);
                atomicAdd(&d_node_normals[nid * 3 + 1], facet.normal[1]);
                atomicAdd(&d_node_normals[nid * 3 + 2], facet.normal[2]);
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
        if (elem.is_eroded) {
            d_facet_out[f * 8 + 0] = -1.0f;
            d_facet_out[f * 8 + 1] = -1.0f;
            d_facet_out[f * 8 + 2] = -1.0f;
            d_facet_out[f * 8 + 3] = -1.0f;
            d_facet_out[f * 8 + 4] = 0.0f;
            d_facet_out[f * 8 + 5] = 0.0f;
            d_facet_out[f * 8 + 6] = 0.0f;
            d_facet_out[f * 8 + 7] = -1.0f;
            return;
        }
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

// Common Contact Physics Helper: Evaluates contact penetration, interface stiffness, spring-damper response, and yield cap
template <typename T>
__device__ inline void fem_evaluate_candidate_facet_contact(
    int f,
    int nid,
    const FEMNode3D<T>& node,
    int n_part,
    bool has_node_norm,
    const T* n_node,
    const FEMFacet3D<T>* d_facets,
    int num_facets,
    const FEMNode3D<T>* d_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    const MaterialTable3D* d_materials,
    T K_slave_node,
    T contact_penalty_scale,
    T contact_damping,
    T dt,
    T& best_f_total,
    T& best_nx, T& best_ny, T& best_nz,
    int& best_fid,
    T best_N[4],
    T& best_m_pair
) {
    if (f < 0 || f >= num_facets) return;

    const FEMFacet3D<T>& facet = d_facets[f];
    if (facet.is_eroded) return;

    if (facet.node_ids[0] == nid || facet.node_ids[1] == nid ||
        facet.node_ids[2] == nid || facet.node_ids[3] == nid) return;

    (void)n_part;
    // Exclude nodes belonging to the facet's own parent element, and enforce surface normal opposition
    if (facet.element_id >= 0 && facet.element_id < num_elements) {
        const auto& f_elem = d_elements[facet.element_id];
        if (f_elem.is_eroded) return;
        for (int k = 0; k < 8; ++k) {
            if (f_elem.node_ids[k] == nid) return;
        }
    }
    if (!has_node_norm) return;
    T dot_norm = n_node[0]*facet.normal[0] + n_node[1]*facet.normal[1] + n_node[2]*facet.normal[2];
    if (dot_norm > static_cast<T>(-0.15f)) return;

    if (node.x[0] < facet.bbox_min[0] || node.x[0] > facet.bbox_max[0] ||
        node.x[1] < facet.bbox_min[1] || node.x[1] > facet.bbox_max[1] ||
        node.x[2] < facet.bbox_min[2] || node.x[2] > facet.bbox_max[2]) return;

    const auto& n0 = d_nodes[facet.node_ids[0]];
    const auto& n1 = d_nodes[facet.node_ids[1]];
    const auto& n2 = d_nodes[facet.node_ids[2]];
    const auto& n3 = d_nodes[facet.node_ids[3]];
    const bool is_tri = (facet.node_ids[2] == facet.node_ids[3]);

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
        v_param < static_cast<T>(-0.05f) || v_param > static_cast<T>(1.05f)) return;
    if (is_tri && (u_param + v_param > static_cast<T>(1.05f))) return;

    T u_clamped = u_param < static_cast<T>(0.0f) ? static_cast<T>(0.0f) : (u_param > static_cast<T>(1.0f) ? static_cast<T>(1.0f) : u_param);
    T v_clamped = v_param < static_cast<T>(0.0f) ? static_cast<T>(0.0f) : (v_param > static_cast<T>(1.0f) ? static_cast<T>(1.0f) : v_param);

    T N_shape[4];
    if (is_tri) {
        if (u_clamped + v_clamped > static_cast<T>(1.0f)) {
            T s = u_clamped + v_clamped;
            u_clamped /= s;
            v_clamped /= s;
        }
        N_shape[0] = static_cast<T>(1.0f) - u_clamped - v_clamped;
        N_shape[1] = u_clamped;
        N_shape[2] = v_clamped;
        N_shape[3] = static_cast<T>(0.0f);
    } else {
        N_shape[0] = (static_cast<T>(1.0f) - u_clamped) * (static_cast<T>(1.0f) - v_clamped);
        N_shape[1] = u_clamped * (static_cast<T>(1.0f) - v_clamped);
        N_shape[2] = u_clamped * v_clamped;
        N_shape[3] = (static_cast<T>(1.0f) - u_clamped) * v_clamped;
    }

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
            h_elem = (is_tri ? static_cast<T>(3.0f) : static_cast<T>(1.0f)) * elem_V / facet.area;
        }
    }
    T max_penetration = static_cast<T>(0.35f) * h_elem;

    // Tangential offset check
    T dx_t0 = dx_surf[0] + penetration * contact_normal[0];
    T dx_t1 = dx_surf[1] + penetration * contact_normal[1];
    T dx_t2 = dx_surf[2] + penetration * contact_normal[2];
    T d_tangent_sq = dx_t0*dx_t0 + dx_t1*dx_t1 + dx_t2*dx_t2;
    if (d_tangent_sq > static_cast<T>(0.04f) * h_elem * h_elem) return;

    if (penetration > static_cast<T>(0.0f) && penetration <= max_penetration) {
        T eff_penetration = (penetration < static_cast<T>(0.30f) * h_elem) ? penetration : static_cast<T>(0.30f) * h_elem;

        T K_master = static_cast<T>(160.0e9f);
        if (facet.element_id >= 0 && facet.element_id < num_elements && d_materials) {
            const auto& f_elem = d_elements[facet.element_id];
            int mid = f_elem.mat_id;
            const MaterialTable3D& mat = d_materials[mid];
            T v_rel_m = (f_elem.V0 > static_cast<T>(1.0e-18f) && f_elem.V > static_cast<T>(0.0f))
                ? (f_elem.V / f_elem.V0) : static_cast<T>(1.0f);
            K_master = Blast::Materials::getEffectiveBulkModulus<T>(mat, v_rel_m);
            T p_elem_master = -(f_elem.sigma[0][0] + f_elem.sigma[1][1] + f_elem.sigma[2][2]) / static_cast<T>(3.0f);
            if (p_elem_master * static_cast<T>(3.0f) > K_master) {
                K_master = p_elem_master * static_cast<T>(3.0f);
            }
        }

        T K_slave = K_slave_node;
        T K_interface = (static_cast<T>(2.0f) * K_master * K_slave) / (K_master + K_slave + static_cast<T>(1.0e-30f));

        T m_facet_avg = is_tri
            ? ((n0.m + n1.m + n2.m) / static_cast<T>(3.0f))
            : (static_cast<T>(0.25f) * (n0.m + n1.m + n2.m + n3.m));
        T m_sum = node.m + m_facet_avg;
        T m_pair = (m_sum > static_cast<T>(1.0e-30f)) ? (node.m * m_facet_avg / m_sum) : static_cast<T>(1.0e-30f);

        T dt_safe = (dt > static_cast<T>(1.0e-12f)) ? dt : static_cast<T>(1.0e-12f);
        T k_dyn = static_cast<T>(0.50f) * m_pair / (dt_safe * dt_safe);
        T k_geom = (static_cast<T>(0.10f) * K_interface) * h_elem;
        T k_base = (k_geom < k_dyn) ? k_geom : k_dyn;
        T k_stiff = contact_penalty_scale * k_base;
        if (k_stiff < static_cast<T>(1.0e5f)) k_stiff = static_cast<T>(1.0e5f);

        T vf0 = N_shape[0]*n0.v[0] + N_shape[1]*n1.v[0] + N_shape[2]*n2.v[0] + N_shape[3]*n3.v[0];
        T vf1 = N_shape[0]*n0.v[1] + N_shape[1]*n1.v[1] + N_shape[2]*n2.v[1] + N_shape[3]*n3.v[1];
        T vf2 = N_shape[0]*n0.v[2] + N_shape[1]*n1.v[2] + N_shape[2]*n2.v[2] + N_shape[3]*n3.v[2];
        T v_rel_n = (node.v[0] - vf0)*contact_normal[0] + (node.v[1] - vf1)*contact_normal[1] + (node.v[2] - vf2)*contact_normal[2];

        T f_spring = k_stiff * eff_penetration;

        T f_damp = static_cast<T>(0.0f);
        if (v_rel_n < static_cast<T>(0.0f)) {
            T c = static_cast<T>(2.0f) * contact_damping * sqrt(k_stiff * m_pair);
            f_damp = -c * v_rel_n;
        }

        T f_total = f_spring + f_damp;
        T v_limit = (static_cast<T>(1.5f) * fabs(v_rel_n) > static_cast<T>(1.0f)) ? static_cast<T>(1.5f) * fabs(v_rel_n) : static_cast<T>(1.0f);
        T f_max = m_pair * v_limit / dt_safe;
        if (facet.element_id >= 0 && facet.element_id < num_elements && d_materials) {
            const auto& f_elem = d_elements[facet.element_id];
            int mid = f_elem.mat_id;
            T sigma_y = static_cast<T>(d_materials[mid].yield_stress > 0.0f ? d_materials[mid].yield_stress : 400.0e6f);
            T p_elem_master = -(f_elem.sigma[0][0] + f_elem.sigma[1][1] + f_elem.sigma[2][2]) / static_cast<T>(3.0f);
            T p_cap = (p_elem_master > static_cast<T>(1.5f) * sigma_y) ? p_elem_master : static_cast<T>(1.5f) * sigma_y;
            T f_mat_cap = p_cap * facet.area;
            if (f_max > f_mat_cap && f_mat_cap > static_cast<T>(1.0e3f)) f_max = f_mat_cap;
        }
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

// Common Contact Physics Helper: Applies final penalty normal force + Coulomb friction to slave node and facet vertices
template <typename T>
__device__ inline void fem_apply_contact_response(
    int best_fid,
    T best_f_total,
    T best_nx, T best_ny, T best_nz,
    const T best_N[4],
    T best_m_pair,
    int nid,
    const FEMNode3D<T>& node,
    FEMNode3D<T>* d_nodes,
    const FEMFacet3D<T>* d_facets,
    T mu_static,
    T mu_kinetic,
    T dt
) {
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

// Compute octave level and integer cell bounds for a facet AABB. Returns true if oversized (span > 4 in any axis).
template <typename T>
__device__ inline bool fem_compute_facet_octave_bounds(
    const FEMFacet3D<T>& facet,
    T base_cell_size,
    int& lvl_out,
    int& min_cx, int& max_cx,
    int& min_cy, int& max_cy,
    int& min_cz, int& max_cz
) {
    T dx = facet.bbox_max[0] - facet.bbox_min[0];
    T dy = facet.bbox_max[1] - facet.bbox_min[1];
    T dz = facet.bbox_max[2] - facet.bbox_min[2];
    T max_d = (dx > dy) ? ((dx > dz) ? dx : dz) : ((dy > dz) ? dy : dz);

    int lvl = 0;
    if (max_d > base_cell_size * static_cast<T>(4.0f)) lvl = 3;
    else if (max_d > base_cell_size * static_cast<T>(2.0f)) lvl = 2;
    else if (max_d > base_cell_size) lvl = 1;
    lvl_out = lvl;

    T cell_size = base_cell_size * static_cast<T>(1 << lvl);
    T inv_cs = static_cast<T>(1.0f) / cell_size;

    min_cx = static_cast<int>(floor(facet.bbox_min[0] * inv_cs));
    max_cx = static_cast<int>(floor(facet.bbox_max[0] * inv_cs));
    min_cy = static_cast<int>(floor(facet.bbox_min[1] * inv_cs));
    max_cy = static_cast<int>(floor(facet.bbox_max[1] * inv_cs));
    min_cz = static_cast<int>(floor(facet.bbox_min[2] * inv_cs));
    max_cz = static_cast<int>(floor(facet.bbox_max[2] * inv_cs));

    return ((max_cx - min_cx + 1) > 4 ||
            (max_cy - min_cy + 1) > 4 ||
            (max_cz - min_cz + 1) > 4);
}

// CUDA Kernel (Pass 1): Count bucket hits and record oversized facets into flat list
template <typename T>
__global__ void fem_count_octave_hash_grid_kernel_3d_device(
    const FEMFacet3D<T>* __restrict__ d_facets,
    int num_facets,
    T base_cell_size,
    int* __restrict__ d_cell_counts,
    int* __restrict__ d_oversized_facets,
    int* __restrict__ d_oversized_count,
    int max_oversized_facets,
    uint32_t table_size
) {
    int f = blockIdx.x * blockDim.x + threadIdx.x;
    if (f >= num_facets) return;

    const FEMFacet3D<T>& facet = d_facets[f];
    if (facet.is_eroded) return;

    int lvl = 0, min_cx = 0, max_cx = 0, min_cy = 0, max_cy = 0, min_cz = 0, max_cz = 0;
    if (fem_compute_facet_octave_bounds(facet, base_cell_size, lvl, min_cx, max_cx, min_cy, max_cy, min_cz, max_cz)) {
        if (d_oversized_facets && d_oversized_count) {
            int oslot = ::atomicAdd(d_oversized_count, 1);
            if (oslot >= 0 && oslot < max_oversized_facets) {
                d_oversized_facets[oslot] = f;
            }
        }
        return;
    }

    for (int cz = min_cz; cz <= max_cz; ++cz) {
        for (int cy = min_cy; cy <= max_cy; ++cy) {
            for (int cx = min_cx; cx <= max_cx; ++cx) {
                uint32_t bucket = hashCoords3D(cx, cy, cz, table_size) + lvl * table_size;
                ::atomicAdd(&d_cell_counts[bucket], 1);
            }
        }
    }
}

// CUDA Kernel (Pass 2): Scatter facet IDs into CSR array using scanned bucket offsets
template <typename T>
__global__ void fem_scatter_octave_hash_grid_kernel_3d_device(
    const FEMFacet3D<T>* __restrict__ d_facets,
    int num_facets,
    T base_cell_size,
    int* __restrict__ d_cell_counts,
    const int* __restrict__ d_cell_offsets,
    int* __restrict__ d_cell_facet_ids,
    int max_hash_entries,
    uint32_t table_size
) {
    int f = blockIdx.x * blockDim.x + threadIdx.x;
    if (f >= num_facets) return;

    const FEMFacet3D<T>& facet = d_facets[f];
    if (facet.is_eroded) return;

    int lvl = 0, min_cx = 0, max_cx = 0, min_cy = 0, max_cy = 0, min_cz = 0, max_cz = 0;
    if (fem_compute_facet_octave_bounds(facet, base_cell_size, lvl, min_cx, max_cx, min_cy, max_cy, min_cz, max_cz)) {
        return;
    }

    for (int cz = min_cz; cz <= max_cz; ++cz) {
        for (int cy = min_cy; cy <= max_cy; ++cy) {
            for (int cx = min_cx; cx <= max_cx; ++cx) {
                uint32_t bucket = hashCoords3D(cx, cy, cz, table_size) + lvl * table_size;
                int local_slot = ::atomicAdd(&d_cell_counts[bucket], 1);
                int entry_idx = d_cell_offsets[bucket] + local_slot;
                if (entry_idx >= 0 && entry_idx < max_hash_entries) {
                    d_cell_facet_ids[entry_idx] = f;
                }
            }
        }
    }
}

// CUDA Kernel: Penalty Surface Contact and Coulomb Friction using Lossless Multi-Level CSR Octave Hash Grid
template <typename T>
__global__ void fem_contact_forces_octave_grid_kernel_3d_device(
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
    const int* __restrict__ d_cell_counts,
    const int* __restrict__ d_cell_offsets,
    const int* __restrict__ d_cell_facet_ids,
    int max_hash_entries,
    const int* __restrict__ d_oversized_facets,
    const int* __restrict__ d_oversized_count,
    int max_oversized_facets,
    uint32_t table_size,
    T base_cell_size,
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
            K_slave_node = Blast::Materials::getEffectiveBulkModulus<T>(mat);
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

    // Query 4 octave scale levels
    for (int lvl = 0; lvl < 4; ++lvl) {
        T cell_size = base_cell_size * static_cast<T>(1 << lvl);
        T inv_cs = static_cast<T>(1.0f) / cell_size;
        int ncx = static_cast<int>(floor(node.x[0] * inv_cs));
        int ncy = static_cast<int>(floor(node.x[1] * inv_cs));
        int ncz = static_cast<int>(floor(node.x[2] * inv_cs));

        #pragma unroll 1
        for (int dz = -1; dz <= 1; ++dz) {
            for (int dy = -1; dy <= 1; ++dy) {
                for (int dx = -1; dx <= 1; ++dx) {
                    uint32_t bucket = hashCoords3D(ncx + dx, ncy + dy, ncz + dz, table_size) + lvl * table_size;
                    int count = d_cell_counts[bucket];
                    int start = d_cell_offsets[bucket];

                    for (int slot = 0; slot < count; ++slot) {
                        int entry_idx = start + slot;
                        if (entry_idx < 0 || entry_idx >= max_hash_entries) break;
                        int f = d_cell_facet_ids[entry_idx];
                        fem_evaluate_candidate_facet_contact<T>(
                            f, nid, node, n_part, has_node_norm, n_node,
                            d_facets, num_facets, d_nodes, d_elements, num_elements,
                            d_materials, K_slave_node, contact_penalty_scale, contact_damping,
                            dt, best_f_total, best_nx, best_ny, best_nz, best_fid, best_N, best_m_pair
                        );
                    }
                }
            }
        }
    }

    // Evaluate oversized facets that exceeded 4 cells per axis
    int num_over = d_oversized_count ? *d_oversized_count : 0;
    if (num_over > max_oversized_facets) num_over = max_oversized_facets;
    if (d_oversized_facets) {
        for (int oi = 0; oi < num_over; ++oi) {
            int f = d_oversized_facets[oi];
            fem_evaluate_candidate_facet_contact<T>(
                f, nid, node, n_part, has_node_norm, n_node,
                d_facets, num_facets, d_nodes, d_elements, num_elements,
                d_materials, K_slave_node, contact_penalty_scale, contact_damping,
                dt, best_f_total, best_nx, best_ny, best_nz, best_fid, best_N, best_m_pair
            );
        }
    }

    fem_apply_contact_response<T>(
        best_fid, best_f_total, best_nx, best_ny, best_nz, best_N, best_m_pair,
        nid, node, d_nodes, d_facets, mu_static, mu_kinetic, dt
    );
}

// Morton 30-Bit Code Helper for GPU Linear BVH
__device__ inline uint32_t expandBits30(uint32_t v) {
    v = (v * 0x00010001u) & 0xFF0000FFu;
    v = (v * 0x00000101u) & 0x0F00F00Fu;
    v = (v * 0x00000011u) & 0xC30C30C3u;
    v = (v * 0x00000005u) & 0x49249249u;
    return v;
}

__device__ inline uint32_t morton3D_30(float x, float y, float z) {
    x = fminf(fmaxf(x, 0.0f), 1.0f);
    y = fminf(fmaxf(y, 0.0f), 1.0f);
    z = fminf(fmaxf(z, 0.0f), 1.0f);
    uint32_t ix = min(static_cast<uint32_t>(x * 1023.0f), 1023u);
    uint32_t iy = min(static_cast<uint32_t>(y * 1023.0f), 1023u);
    uint32_t iz = min(static_cast<uint32_t>(z * 1023.0f), 1023u);
    return (expandBits30(ix) << 2) | (expandBits30(iy) << 1) | expandBits30(iz);
}

__device__ inline int longestCommonPrefix(int i, int j, int num_facets, const uint32_t* __restrict__ morton_keys) {
    if (j < 0 || j >= num_facets) return -1;
    uint32_t k_i = morton_keys[i];
    uint32_t k_j = morton_keys[j];
    if (k_i != k_j) {
        return __clz(k_i ^ k_j);
    }
    return 32 + __clz(static_cast<uint32_t>(i ^ j));
}

// CUDA Kernel: Compute 30-bit Morton Codes from Facet Centroids
template <typename T>
__global__ void fem_compute_morton_codes_kernel_3d_device(
    const FEMFacet3D<T>* __restrict__ d_facets,
    int num_facets,
    T min_x, T min_y, T min_z,
    T inv_extent_x, T inv_extent_y, T inv_extent_z,
    uint32_t* __restrict__ d_morton_codes,
    int* __restrict__ d_facet_indices_in
) {
    int f = blockIdx.x * blockDim.x + threadIdx.x;
    if (f >= num_facets) return;

    d_facet_indices_in[f] = f;

    const FEMFacet3D<T>& facet = d_facets[f];
    if (facet.is_eroded) {
        d_morton_codes[f] = 0xFFFFFFFFu;
        return;
    }

    T cx = static_cast<T>(0.5f) * (facet.bbox_min[0] + facet.bbox_max[0]);
    T cy = static_cast<T>(0.5f) * (facet.bbox_min[1] + facet.bbox_max[1]);
    T cz = static_cast<T>(0.5f) * (facet.bbox_min[2] + facet.bbox_max[2]);

    float u = static_cast<float>((cx - min_x) * inv_extent_x);
    float v = static_cast<float>((cy - min_y) * inv_extent_y);
    float w = static_cast<float>((cz - min_z) * inv_extent_z);

    d_morton_codes[f] = morton3D_30(u, v, w);
}

// CUDA Kernel: Construct LBVH Radix Tree (Karras 2012 Parallel Hierarchy)
template <typename T>
__global__ void fem_build_lbvh_tree_kernel_3d_device(
    int num_facets,
    const uint32_t* __restrict__ morton_keys,
    LBVHNode3D<T>* __restrict__ nodes,
    int* __restrict__ leaf_parents
) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= num_facets - 1) return;

    nodes[i].parent = -1;
    nodes[i].left_child = -1;
    nodes[i].right_child = -1;
    nodes[i].is_leaf = 0;

    // Determine direction of range (+1 or -1)
    int d = (longestCommonPrefix(i, i + 1, num_facets, morton_keys) - longestCommonPrefix(i, i - 1, num_facets, morton_keys) >= 0) ? 1 : -1;

    // Compute upper bound for range length
    int delta_min = longestCommonPrefix(i, i - d, num_facets, morton_keys);
    int l_max = 2;
    while (longestCommonPrefix(i, i + l_max * d, num_facets, morton_keys) > delta_min) {
        l_max <<= 1;
    }

    // Find other end of range using binary search
    int l = 0;
    for (int t = l_max >> 1; t > 0; t >>= 1) {
        if (longestCommonPrefix(i, i + (l + t) * d, num_facets, morton_keys) > delta_min) {
            l += t;
        }
    }
    int j = i + l * d;

    // Find split position using binary search (Karras 2012 ceil divider)
    int delta_node = longestCommonPrefix(i, j, num_facets, morton_keys);
    int s = 0;
    for (int div = 2; ; div *= 2) {
        int t = (l + div - 1) / div;
        if (s + t < l && longestCommonPrefix(i, i + (s + t) * d, num_facets, morton_keys) > delta_node) {
            s += t;
        }
        if (t <= 1) break;
    }
    int gamma = i + s * d + min(d, 0);

    // Output child pointers
    int left_child, right_child;
    int first = min(i, j);
    int last = max(i, j);

    if (first == gamma) {
        left_child = ~gamma; // Leaf node (negative index encoding)
        leaf_parents[gamma] = i;
    } else {
        left_child = gamma; // Internal node
        nodes[gamma].parent = i;
    }

    if (last == gamma + 1) {
        right_child = ~(gamma + 1); // Leaf node
        leaf_parents[gamma + 1] = i;
    } else {
        right_child = gamma + 1; // Internal node
        nodes[gamma + 1].parent = i;
    }

    nodes[i].left_child = left_child;
    nodes[i].right_child = right_child;
    nodes[i].is_leaf = 0;
}

// CUDA Kernel: Compute Node Bounding Boxes Bottom-Up with Atomic Counters (Karras 2012)
template <typename T>
__global__ void fem_build_lbvh_aabbs_kernel_3d_device(
    int num_facets,
    const int* __restrict__ sorted_facet_ids,
    const FEMFacet3D<T>* __restrict__ facets,
    LBVHNode3D<T>* __restrict__ nodes,
    const int* __restrict__ leaf_parents,
    int* __restrict__ node_flags,
    int* __restrict__ d_root_index
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_facets) return;

    int parent = leaf_parents[idx];
    while (parent >= 0 && parent < num_facets - 1) {
        __threadfence();
        int old = ::atomicAdd(&node_flags[parent], 1);
        if (old == 0) {
            // First child to arrive terminates
            return;
        }

        // Second child: both children are guaranteed to have completed and fenced their AABBs.
        // Read sibling internal nodes via volatile pointer so L1 cache never returns stale AABBs.
        const volatile LBVHNode3D<T>* v_nodes = nodes;
        int left = nodes[parent].left_child;
        int right = nodes[parent].right_child;

        T min_box[3], max_box[3];

        if (left < 0) {
            int leaf_id = sorted_facet_ids[~left];
            const auto& f = facets[leaf_id];
            min_box[0] = f.bbox_min[0]; min_box[1] = f.bbox_min[1]; min_box[2] = f.bbox_min[2];
            max_box[0] = f.bbox_max[0]; max_box[1] = f.bbox_max[1]; max_box[2] = f.bbox_max[2];
        } else {
            min_box[0] = v_nodes[left].aabb_min[0]; min_box[1] = v_nodes[left].aabb_min[1]; min_box[2] = v_nodes[left].aabb_min[2];
            max_box[0] = v_nodes[left].aabb_max[0]; max_box[1] = v_nodes[left].aabb_max[1]; max_box[2] = v_nodes[left].aabb_max[2];
        }

        if (right < 0) {
            int leaf_id = sorted_facet_ids[~right];
            const auto& f = facets[leaf_id];
            min_box[0] = (min_box[0] < f.bbox_min[0]) ? min_box[0] : f.bbox_min[0];
            min_box[1] = (min_box[1] < f.bbox_min[1]) ? min_box[1] : f.bbox_min[1];
            min_box[2] = (min_box[2] < f.bbox_min[2]) ? min_box[2] : f.bbox_min[2];
            max_box[0] = (max_box[0] > f.bbox_max[0]) ? max_box[0] : f.bbox_max[0];
            max_box[1] = (max_box[1] > f.bbox_max[1]) ? max_box[1] : f.bbox_max[1];
            max_box[2] = (max_box[2] > f.bbox_max[2]) ? max_box[2] : f.bbox_max[2];
        } else {
            T rmin0 = v_nodes[right].aabb_min[0];
            T rmin1 = v_nodes[right].aabb_min[1];
            T rmin2 = v_nodes[right].aabb_min[2];
            T rmax0 = v_nodes[right].aabb_max[0];
            T rmax1 = v_nodes[right].aabb_max[1];
            T rmax2 = v_nodes[right].aabb_max[2];
            min_box[0] = (min_box[0] < rmin0) ? min_box[0] : rmin0;
            min_box[1] = (min_box[1] < rmin1) ? min_box[1] : rmin1;
            min_box[2] = (min_box[2] < rmin2) ? min_box[2] : rmin2;
            max_box[0] = (max_box[0] > rmax0) ? max_box[0] : rmax0;
            max_box[1] = (max_box[1] > rmax1) ? max_box[1] : rmax1;
            max_box[2] = (max_box[2] > rmax2) ? max_box[2] : rmax2;
        }

        nodes[parent].aabb_min[0] = min_box[0];
        nodes[parent].aabb_min[1] = min_box[1];
        nodes[parent].aabb_min[2] = min_box[2];
        nodes[parent].aabb_max[0] = max_box[0];
        nodes[parent].aabb_max[1] = max_box[1];
        nodes[parent].aabb_max[2] = max_box[2];
        __threadfence();

        int next_parent = nodes[parent].parent;
        if (next_parent < 0) {
            if (d_root_index) *d_root_index = parent;
            return;
        }
        parent = next_parent;
    }
}

// CUDA Kernel: Penalty Surface Contact and Coulomb Friction using GPU Linear BVH
template <typename T>
__global__ void fem_contact_forces_lbvh_kernel_3d_device(
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
    const int* __restrict__ d_sorted_facet_ids,
    const LBVHNode3D<T>* __restrict__ d_bvh_nodes,
    const int* __restrict__ d_root_index,
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
            K_slave_node = Blast::Materials::getEffectiveBulkModulus<T>(mat);
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

    int root = (d_root_index && *d_root_index >= 0) ? *d_root_index : 0;
    int stack[64];
    int stack_ptr = 0;
    stack[stack_ptr++] = root;

    while (stack_ptr > 0) {
        int curr = stack[--stack_ptr];
        if (curr < 0) {
            int leaf_idx = ~curr;
            if (leaf_idx >= 0 && leaf_idx < num_facets) {
                int f = d_sorted_facet_ids[leaf_idx];
                fem_evaluate_candidate_facet_contact<T>(
                    f, nid, node, n_part, has_node_norm, n_node,
                    d_facets, num_facets, d_nodes, d_elements, num_elements,
                    d_materials, K_slave_node, contact_penalty_scale, contact_damping,
                    dt, best_f_total, best_nx, best_ny, best_nz, best_fid, best_N, best_m_pair
                );
            }
        } else if (curr < num_facets - 1) {
            const LBVHNode3D<T>& bvh_node = d_bvh_nodes[curr];
            if (node.x[0] >= bvh_node.aabb_min[0] && node.x[0] <= bvh_node.aabb_max[0] &&
                node.x[1] >= bvh_node.aabb_min[1] && node.x[1] <= bvh_node.aabb_max[1] &&
                node.x[2] >= bvh_node.aabb_min[2] && node.x[2] <= bvh_node.aabb_max[2]) {
                if (stack_ptr < 62) {
                    if (bvh_node.right_child != curr) stack[stack_ptr++] = bvh_node.right_child;
                    if (bvh_node.left_child != curr) stack[stack_ptr++] = bvh_node.left_child;
                }
            }
        }
    }

    fem_apply_contact_response<T>(
        best_fid, best_f_total, best_nx, best_ny, best_nz, best_N, best_m_pair,
        nid, node, d_nodes, d_facets, mu_static, mu_kinetic, dt
    );
}

// Device helper: evaluate candidate FEM boundary facet against an MPM particle
template <typename T>
__device__ inline void fem_eval_mpm_facet_candidate(
    int f,
    float px, float py, float pz,
    float pvx, float pvy, float pvz,
    float pm,
    float r_debris,
    T total_pad,
    const FEMNode3D<T>* d_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    const FEMFacet3D<T>* d_facets,
    const MaterialTable3D* d_materials,
    T contact_penalty_scale,
    T contact_damping,
    T dt_safe,
    T& best_f_total,
    T& best_nx, T& best_ny, T& best_nz,
    int& best_fid,
    T best_N[4],
    T& best_m_pair,
    T& best_dist_n,
    T& best_r_eff,
    T& best_capture_depth,
    T& best_v_rel_n
) {
    const FEMFacet3D<T>& facet = d_facets[f];
    if (facet.is_eroded) return;

    if (px < facet.bbox_min[0] - total_pad || px > facet.bbox_max[0] + total_pad ||
        py < facet.bbox_min[1] - total_pad || py > facet.bbox_max[1] + total_pad ||
        pz < facet.bbox_min[2] - total_pad || pz > facet.bbox_max[2] + total_pad) return;

    const auto& n0 = d_nodes[facet.node_ids[0]];
    const auto& n1 = d_nodes[facet.node_ids[1]];
    const auto& n2 = d_nodes[facet.node_ids[2]];
    const auto& n3 = d_nodes[facet.node_ids[3]];
    const bool is_tri = (facet.node_ids[2] == facet.node_ids[3]);

    T e1[3] = {n1.x[0] - n0.x[0], n1.x[1] - n0.x[1], n1.x[2] - n0.x[2]};
    T e3[3] = {n3.x[0] - n0.x[0], n3.x[1] - n0.x[1], n3.x[2] - n0.x[2]};
    T dx_v0[3] = {static_cast<T>(px) - n0.x[0], static_cast<T>(py) - n0.x[1], static_cast<T>(pz) - n0.x[2]};

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

    if (u_param < static_cast<T>(-0.08f) || u_param > static_cast<T>(1.08f) ||
        v_param < static_cast<T>(-0.08f) || v_param > static_cast<T>(1.08f)) return;
    if (is_tri && (u_param + v_param > static_cast<T>(1.08f))) return;

    T u_clamped = u_param < static_cast<T>(0.0f) ? static_cast<T>(0.0f) : (u_param > static_cast<T>(1.0f) ? static_cast<T>(1.0f) : u_param);
    T v_clamped = v_param < static_cast<T>(0.0f) ? static_cast<T>(0.0f) : (v_param > static_cast<T>(1.0f) ? static_cast<T>(1.0f) : v_param);

    T N_shape[4];
    if (is_tri) {
        if (u_clamped + v_clamped > static_cast<T>(1.0f)) {
            T s = u_clamped + v_clamped;
            u_clamped /= s;
            v_clamped /= s;
        }
        N_shape[0] = static_cast<T>(1.0f) - u_clamped - v_clamped;
        N_shape[1] = u_clamped;
        N_shape[2] = v_clamped;
        N_shape[3] = static_cast<T>(0.0f);
    } else {
        N_shape[0] = (static_cast<T>(1.0f) - u_clamped) * (static_cast<T>(1.0f) - v_clamped);
        N_shape[1] = u_clamped * (static_cast<T>(1.0f) - v_clamped);
        N_shape[2] = u_clamped * v_clamped;
        N_shape[3] = (static_cast<T>(1.0f) - u_clamped) * v_clamped;
    }

    T x_surf[3] = {
        N_shape[0]*n0.x[0] + N_shape[1]*n1.x[0] + N_shape[2]*n2.x[0] + N_shape[3]*n3.x[0],
        N_shape[0]*n0.x[1] + N_shape[1]*n1.x[1] + N_shape[2]*n2.x[1] + N_shape[3]*n3.x[1],
        N_shape[0]*n0.x[2] + N_shape[1]*n1.x[2] + N_shape[2]*n2.x[2] + N_shape[3]*n3.x[2]
    };

    T contact_normal[3] = {facet.normal[0], facet.normal[1], facet.normal[2]};
    T dx_surf[3] = {static_cast<T>(px) - x_surf[0], static_cast<T>(py) - x_surf[1], static_cast<T>(pz) - x_surf[2]};
    T dist_n = dx_surf[0]*contact_normal[0] + dx_surf[1]*contact_normal[1] + dx_surf[2]*contact_normal[2];

    T h_elem = sqrt(facet.area > static_cast<T>(1.0e-24f) ? facet.area : static_cast<T>(1.0e-24f));
    if (facet.element_id >= 0 && facet.element_id < num_elements) {
        T elem_V = d_elements[facet.element_id].V;
        if (elem_V > static_cast<T>(1.0e-30f) && facet.area > static_cast<T>(1.0e-24f)) {
            h_elem = (is_tri ? static_cast<T>(3.0f) : static_cast<T>(1.0f)) * elem_V / facet.area;
        }
    }

    T r_eff = (static_cast<T>(r_debris) < static_cast<T>(0.25f) * h_elem)
            ? static_cast<T>(r_debris) : (static_cast<T>(0.25f) * h_elem);

    T dx_t0 = dx_surf[0] - dist_n * contact_normal[0];
    T dx_t1 = dx_surf[1] - dist_n * contact_normal[1];
    T dx_t2 = dx_surf[2] - dist_n * contact_normal[2];
    T d_tangent_sq = dx_t0*dx_t0 + dx_t1*dx_t1 + dx_t2*dx_t2;
    T d_tan_tol_sq = (static_cast<T>(0.25f) * h_elem * h_elem > static_cast<T>(2.0f) * r_eff * r_eff)
                   ? static_cast<T>(0.25f) * h_elem * h_elem : static_cast<T>(2.0f) * r_eff * r_eff;
    if (d_tangent_sq > d_tan_tol_sq) return;

    T vf0 = N_shape[0]*n0.v[0] + N_shape[1]*n1.v[0] + N_shape[2]*n2.v[0] + N_shape[3]*n3.v[0];
    T vf1 = N_shape[0]*n0.v[1] + N_shape[1]*n1.v[1] + N_shape[2]*n2.v[1] + N_shape[3]*n3.v[1];
    T vf2 = N_shape[0]*n0.v[2] + N_shape[1]*n1.v[2] + N_shape[2]*n2.v[2] + N_shape[3]*n3.v[2];
    T v_rel_n = (static_cast<T>(pvx) - vf0)*contact_normal[0] +
                (static_cast<T>(pvy) - vf1)*contact_normal[1] +
                (static_cast<T>(pvz) - vf2)*contact_normal[2];

    // Unidirectional compressive gate: ignore separating or back-face exiting particles
    if (v_rel_n > static_cast<T>(0.0f)) return;

    T capture_depth = static_cast<T>(0.50f) * h_elem;
    T v_sweep = static_cast<T>(1.5f) * fabs(v_rel_n) * dt_safe;
    if (v_sweep > capture_depth) capture_depth = v_sweep;
    T r_floor = static_cast<T>(2.0f) * r_eff;
    if (r_floor > capture_depth) capture_depth = r_floor;

    if (dist_n < r_eff && dist_n > -capture_depth) {
        T penetration = r_eff - dist_n;
        T eff_penetration = (penetration < capture_depth) ? penetration : capture_depth;

        T K_master = static_cast<T>(160.0e9f);
        T p_elem_master = static_cast<T>(0.0f);
        if (facet.element_id >= 0 && facet.element_id < num_elements && d_materials) {
            const auto& f_elem = d_elements[facet.element_id];
            int mid = f_elem.mat_id;
            const MaterialTable3D& mat = d_materials[mid];
            T v_rel_m = (f_elem.V0 > static_cast<T>(1.0e-18f) && f_elem.V > static_cast<T>(0.0f))
                ? (f_elem.V / f_elem.V0) : static_cast<T>(1.0f);
            K_master = Blast::Materials::getEffectiveBulkModulus<T>(mat, v_rel_m);
            p_elem_master = -(f_elem.sigma[0][0] + f_elem.sigma[1][1] + f_elem.sigma[2][2]) / static_cast<T>(3.0f);
            if (p_elem_master < static_cast<T>(0.0f)) p_elem_master = static_cast<T>(0.0f);
            if (p_elem_master * static_cast<T>(3.0f) > K_master) {
                K_master = p_elem_master * static_cast<T>(3.0f);
            }
        }

        T m_facet_avg = is_tri
            ? ((n0.m + n1.m + n2.m) / static_cast<T>(3.0f))
            : (static_cast<T>(0.25f) * (n0.m + n1.m + n2.m + n3.m));
        T p_m = static_cast<T>(pm);
        T m_sum = p_m + m_facet_avg;
        T m_pair = (m_sum > static_cast<T>(1.0e-30f)) ? (p_m * m_facet_avg / m_sum) : static_cast<T>(1.0e-30f);

        T k_dyn = static_cast<T>(0.50f) * m_pair / (dt_safe * dt_safe);
        T k_geom = contact_penalty_scale * (static_cast<T>(0.10f) * K_master) * h_elem;
        T k_stiff = (k_geom < k_dyn) ? k_geom : k_dyn;
        if (k_stiff < static_cast<T>(1.0e5f)) k_stiff = static_cast<T>(1.0e5f);
        T f_spring = k_stiff * eff_penetration;

        T f_damp = static_cast<T>(0.0f);
        if (v_rel_n < static_cast<T>(0.0f)) {
            T c = static_cast<T>(2.0f) * contact_damping * sqrt(k_stiff * m_pair);
            f_damp = -c * v_rel_n;
        }

        T f_total = f_spring + f_damp;
        T v_limit = (static_cast<T>(1.5f) * fabs(v_rel_n) > static_cast<T>(1.0f)) ? static_cast<T>(1.5f) * fabs(v_rel_n) : static_cast<T>(1.0f);
        T f_max = m_pair * v_limit / dt_safe;
        if (facet.element_id >= 0 && facet.element_id < num_elements && d_materials) {
            const auto& f_elem = d_elements[facet.element_id];
            int mid = f_elem.mat_id;
            T sigma_y = static_cast<T>(d_materials[mid].yield_stress > 0.0f ? d_materials[mid].yield_stress : 400.0e6f);
            T facet_a = facet.area > static_cast<T>(1.0e-12f) ? facet.area : static_cast<T>(1.0e-12f);
            T area_frac = (static_cast<T>(4.0f) * r_eff * r_eff) / facet_a;
            if (area_frac > static_cast<T>(1.0f)) area_frac = static_cast<T>(1.0f);
            if (area_frac < static_cast<T>(0.10f)) area_frac = static_cast<T>(0.10f);
            T p_cap = (p_elem_master > static_cast<T>(1.5f) * sigma_y) ? p_elem_master : static_cast<T>(1.5f) * sigma_y;
            T f_mat_cap = p_cap * facet.area * area_frac;
            if (f_max > f_mat_cap && f_mat_cap > static_cast<T>(1.0e3f)) f_max = f_mat_cap;
        }
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
            best_dist_n = dist_n;
            best_r_eff = r_eff;
            best_capture_depth = capture_depth;
            best_v_rel_n = v_rel_n;
        }
    }
}

// CUDA Kernel: Penalty Contact between MPM Debris Particles and Intact FEM Facets & Rebars
template <typename T>
__global__ void fem_contact_mpm_debris_kernel_3d_device(
    MPMParticle3DSoA soa,
    int num_particles,
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    const FEMFacet3D<T>* d_facets,
    int num_facets,
    const FEMTrussElement3D<T>* d_trusses,
    int num_trusses,
    const FEMBeam3DElement<T>* d_beams,
    int num_beams,
    const MaterialTable3D* d_materials,
    const int* __restrict__ d_cell_counts,
    const int* __restrict__ d_cell_offsets,
    const int* __restrict__ d_cell_facet_ids,
    int max_hash_entries,
    const int* __restrict__ d_oversized_facets,
    const int* __restrict__ d_oversized_count,
    int max_oversized_facets,
    uint32_t table_size,
    T base_cell_size,
    T contact_penalty_scale,
    T mu_static,
    T mu_kinetic,
    T contact_damping,
    T dt,
    T* d_mpm_impulse_accum,
    bool accumulate_impulse
) {
    int p_idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (p_idx >= num_particles) return;

    float px = soa.x[0][p_idx];
    float py = soa.x[1][p_idx];
    float pz = soa.x[2][p_idx];
    float pvx = soa.v[0][p_idx];
    float pvy = soa.v[1][p_idx];
    float pvz = soa.v[2][p_idx];
    float pm = soa.m[p_idx];
    if (pm <= 0.0f) return;

    float r_debris = soa.lp[0][p_idx] > 0.0f ? soa.lp[0][p_idx] : 0.002f;
    T dt_safe = (dt > static_cast<T>(1.0e-12f)) ? dt : static_cast<T>(1.0e-12f);
    T v_pad = (fabs(pvx) + fabs(pvy) + fabs(pvz)) * dt_safe;
    T cell_ref = (base_cell_size > static_cast<T>(0.0f)) ? base_cell_size : static_cast<T>(0.02f);
    T r_broad = (static_cast<T>(r_debris) < static_cast<T>(0.5f) * cell_ref) ? static_cast<T>(r_debris) : static_cast<T>(0.5f) * cell_ref;
    T total_pad = r_broad + v_pad + static_cast<T>(0.005f);

    T best_f_total = static_cast<T>(0.0f);
    T best_nx = static_cast<T>(0.0f), best_ny = static_cast<T>(0.0f), best_nz = static_cast<T>(0.0f);
    int best_fid = -1;
    T best_N[4] = {0, 0, 0, 0};
    T best_m_pair = static_cast<T>(0.0f);
    T best_dist_n = static_cast<T>(0.0f);
    T best_r_eff = static_cast<T>(r_debris);
    T best_capture_depth = static_cast<T>(0.0f);
    T best_v_rel_n = static_cast<T>(0.0f);

    const bool use_hash = (d_cell_counts != nullptr && d_cell_offsets != nullptr &&
                           d_cell_facet_ids != nullptr && table_size > 0 &&
                           base_cell_size > static_cast<T>(0.0f));

    if (num_facets > 0) {
        if (use_hash) {
            for (int lvl = 0; lvl < 4; ++lvl) {
                T cell_size = base_cell_size * static_cast<T>(1 << lvl);
                T inv_cs = static_cast<T>(1.0f) / cell_size;
                int pcx = static_cast<int>(floor(static_cast<T>(px) * inv_cs));
                int pcy = static_cast<int>(floor(static_cast<T>(py) * inv_cs));
                int pcz = static_cast<int>(floor(static_cast<T>(pz) * inv_cs));

                #pragma unroll 1
                for (int dz = -1; dz <= 1; ++dz) {
                    for (int dy = -1; dy <= 1; ++dy) {
                        for (int dx = -1; dx <= 1; ++dx) {
                            uint32_t bucket = hashCoords3D(pcx + dx, pcy + dy, pcz + dz, table_size) + lvl * table_size;
                            int count = d_cell_counts[bucket];
                            int start = d_cell_offsets[bucket];

                            for (int slot = 0; slot < count; ++slot) {
                                int entry_idx = start + slot;
                                if (entry_idx < 0 || entry_idx >= max_hash_entries) break;
                                int f = d_cell_facet_ids[entry_idx];
                                if (f < 0 || f >= num_facets) continue;
                                fem_eval_mpm_facet_candidate<T>(
                                    f, px, py, pz, pvx, pvy, pvz, pm, r_debris, total_pad,
                                    d_nodes, d_elements, num_elements, d_facets, d_materials,
                                    contact_penalty_scale, contact_damping, dt_safe,
                                    best_f_total, best_nx, best_ny, best_nz, best_fid, best_N,
                                    best_m_pair, best_dist_n, best_r_eff, best_capture_depth, best_v_rel_n
                                );
                            }
                        }
                    }
                }
            }

            int num_over = d_oversized_count ? *d_oversized_count : 0;
            if (num_over > max_oversized_facets) num_over = max_oversized_facets;
            if (d_oversized_facets) {
                for (int oi = 0; oi < num_over; ++oi) {
                    int f = d_oversized_facets[oi];
                    if (f < 0 || f >= num_facets) continue;
                    fem_eval_mpm_facet_candidate<T>(
                        f, px, py, pz, pvx, pvy, pvz, pm, r_debris, total_pad,
                        d_nodes, d_elements, num_elements, d_facets, d_materials,
                        contact_penalty_scale, contact_damping, dt_safe,
                        best_f_total, best_nx, best_ny, best_nz, best_fid, best_N,
                        best_m_pair, best_dist_n, best_r_eff, best_capture_depth, best_v_rel_n
                    );
                }
            }
        } else {
            for (int f = 0; f < num_facets; ++f) {
                fem_eval_mpm_facet_candidate<T>(
                    f, px, py, pz, pvx, pvy, pvz, pm, r_debris, total_pad,
                    d_nodes, d_elements, num_elements, d_facets, d_materials,
                    contact_penalty_scale, contact_damping, dt_safe,
                    best_f_total, best_nx, best_ny, best_nz, best_fid, best_N,
                    best_m_pair, best_dist_n, best_r_eff, best_capture_depth, best_v_rel_n
                );
            }
        }
    }

    if (best_fid >= 0 && best_f_total > static_cast<T>(0.0f)) {
        const FEMFacet3D<T>& facet = d_facets[best_fid];
        const auto& n0 = d_nodes[facet.node_ids[0]];
        const auto& n1 = d_nodes[facet.node_ids[1]];
        const auto& n2 = d_nodes[facet.node_ids[2]];
        const auto& n3 = d_nodes[facet.node_ids[3]];

        // Enforce positional non-penetration for penetrating particles
        if (best_dist_n < static_cast<T>(0.0f) && best_v_rel_n <= static_cast<T>(0.0f)) {
            T target_clearance = static_cast<T>(0.05f) * best_r_eff;
            T corr = target_clearance - best_dist_n;
            if (corr > best_capture_depth) corr = best_capture_depth;
            if (corr > static_cast<T>(0.0f)) {
                px += static_cast<float>(corr * best_nx);
                py += static_cast<float>(corr * best_ny);
                pz += static_cast<float>(corr * best_nz);
                soa.x[0][p_idx] = px;
                soa.x[1][p_idx] = py;
                soa.x[2][p_idx] = pz;
            }
        }

        T vf0 = best_N[0]*n0.v[0] + best_N[1]*n1.v[0] + best_N[2]*n2.v[0] + best_N[3]*n3.v[0];
        T vf1 = best_N[0]*n0.v[1] + best_N[1]*n1.v[1] + best_N[2]*n2.v[1] + best_N[3]*n3.v[1];
        T vf2 = best_N[0]*n0.v[2] + best_N[1]*n1.v[2] + best_N[2]*n2.v[2] + best_N[3]*n3.v[2];

        T v_before[3] = {
            static_cast<T>(pvx),
            static_cast<T>(pvy),
            static_cast<T>(pvz)
        };

        T v_rel[3] = {v_before[0] - vf0, v_before[1] - vf1, v_before[2] - vf2};
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
            T f_stick_max = best_m_pair * vt_mag / dt_safe;
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

        T v_post[3] = {
            v_before[0] + (f_tot[0] * dt_safe) / pm,
            v_before[1] + (f_tot[1] * dt_safe) / pm,
            v_before[2] + (f_tot[2] * dt_safe) / pm
        };

        // Kinematic non-penetration outbound velocity cap
        T v_post_rel_n = (v_post[0] - vf0)*best_nx + (v_post[1] - vf1)*best_ny + (v_post[2] - vf2)*best_nz;
        T max_outbound_vn = (fabs(v_rel_n) > static_cast<T>(5.0f)) ? (static_cast<T>(0.5f) * fabs(v_rel_n)) : static_cast<T>(5.0f);
        if (v_post_rel_n > max_outbound_vn) {
            T excess_vn = v_post_rel_n - max_outbound_vn;
            v_post[0] -= excess_vn * best_nx;
            v_post[1] -= excess_vn * best_ny;
            v_post[2] -= excess_vn * best_nz;
        }

        soa.v[0][p_idx] = static_cast<float>(v_post[0]);
        soa.v[1][p_idx] = static_cast<float>(v_post[1]);
        soa.v[2][p_idx] = static_cast<float>(v_post[2]);
        pvx = static_cast<float>(v_post[0]);
        pvy = static_cast<float>(v_post[1]);
        pvz = static_cast<float>(v_post[2]);

        // Exact Newton's 3rd Law reaction force based on actual velocity change
        T f_react[3] = {
            static_cast<T>(pm) * (v_post[0] - v_before[0]) / dt_safe,
            static_cast<T>(pm) * (v_post[1] - v_before[1]) / dt_safe,
            static_cast<T>(pm) * (v_post[2] - v_before[2]) / dt_safe
        };

        #pragma unroll
        for (int k = 0; k < 4; ++k) {
            int fnid = facet.node_ids[k];
            T N_k = best_N[k];
            if (accumulate_impulse && d_mpm_impulse_accum) {
                atomicAdd(&d_mpm_impulse_accum[fnid * 3 + 0], -N_k * f_react[0] * dt_safe);
                atomicAdd(&d_mpm_impulse_accum[fnid * 3 + 1], -N_k * f_react[1] * dt_safe);
                atomicAdd(&d_mpm_impulse_accum[fnid * 3 + 2], -N_k * f_react[2] * dt_safe);
            } else {
                atomicAdd(&d_nodes[fnid].f_contact[0], -N_k * f_react[0]);
                atomicAdd(&d_nodes[fnid].f_contact[1], -N_k * f_react[1]);
                atomicAdd(&d_nodes[fnid].f_contact[2], -N_k * f_react[2]);
            }
        }
    }

    // 2. Rebar Truss Contact Evaluation (if trusses present)
    if (d_trusses && num_trusses > 0) {
        for (int tr = 0; tr < num_trusses; ++tr) {
            const FEMTrussElement3D<T>& truss = d_trusses[tr];
            if (truss.is_eroded) continue;

            int tid0 = truss.node_ids[0];
            int tid1 = truss.node_ids[1];
            if (tid0 < 0 || tid0 >= num_nodes || tid1 < 0 || tid1 >= num_nodes) continue;
            const auto& n1 = d_nodes[tid0];
            const auto& n2 = d_nodes[tid1];
            if (n1.is_eroded || n2.is_eroded) continue;

            T r_rebar = sqrt(truss.A > static_cast<T>(1.0e-12f) ? (truss.A / static_cast<T>(3.1415926535f)) : static_cast<T>(0.0001f));
            T r_rebar_eff = (static_cast<T>(r_debris) < (static_cast<T>(2.0f) * r_rebar + static_cast<T>(0.005f)))
                          ? static_cast<T>(r_debris) : (static_cast<T>(2.0f) * r_rebar + static_cast<T>(0.005f));
            T R_contact = r_rebar + r_rebar_eff;

            T ab[3] = {n2.x[0] - n1.x[0], n2.x[1] - n1.x[1], n2.x[2] - n1.x[2]};
            T ap[3] = {static_cast<T>(px) - n1.x[0], static_cast<T>(py) - n1.x[1], static_cast<T>(pz) - n1.x[2]};
            T ab_len_sq = ab[0]*ab[0] + ab[1]*ab[1] + ab[2]*ab[2];
            if (ab_len_sq <= static_cast<T>(1.0e-16f)) continue;

            T t_proj = (ap[0]*ab[0] + ap[1]*ab[1] + ap[2]*ab[2]) / ab_len_sq;
            t_proj = t_proj < static_cast<T>(0.0f) ? static_cast<T>(0.0f) : (t_proj > static_cast<T>(1.0f) ? static_cast<T>(1.0f) : t_proj);

            T x_seg[3] = {
                n1.x[0] + t_proj * ab[0],
                n1.x[1] + t_proj * ab[1],
                n1.x[2] + t_proj * ab[2]
            };

            T d_vec[3] = {static_cast<T>(px) - x_seg[0], static_cast<T>(py) - x_seg[1], static_cast<T>(pz) - x_seg[2]};
            T dist_sq = d_vec[0]*d_vec[0] + d_vec[1]*d_vec[1] + d_vec[2]*d_vec[2];

            T v_seg[3] = {
                (static_cast<T>(1.0f) - t_proj) * n1.v[0] + t_proj * n2.v[0],
                (static_cast<T>(1.0f) - t_proj) * n1.v[1] + t_proj * n2.v[1],
                (static_cast<T>(1.0f) - t_proj) * n1.v[2] + t_proj * n2.v[2]
            };
            T v_rel[3] = {static_cast<T>(pvx) - v_seg[0], static_cast<T>(pvy) - v_seg[1], static_cast<T>(pvz) - v_seg[2]};

            T dist = sqrt(dist_sq > static_cast<T>(1.0e-20f) ? dist_sq : static_cast<T>(1.0e-20f));
            T n_dir[3] = {
                dist > static_cast<T>(1.0e-8f) ? (d_vec[0] / dist) : static_cast<T>(0.0f),
                dist > static_cast<T>(1.0e-8f) ? (d_vec[1] / dist) : static_cast<T>(1.0f),
                dist > static_cast<T>(1.0e-8f) ? (d_vec[2] / dist) : static_cast<T>(0.0f)
            };
            T v_n = v_rel[0]*n_dir[0] + v_rel[1]*n_dir[1] + v_rel[2]*n_dir[2];
            if (v_n > static_cast<T>(0.0f)) continue;

            T capture_depth = R_contact;
            T v_sweep = static_cast<T>(1.5f) * fabs(v_n) * dt_safe;
            if (v_sweep > capture_depth) capture_depth = v_sweep;

            if (dist < capture_depth) {
                T delta = R_contact - dist;
                if (delta <= static_cast<T>(0.0f) && v_n < static_cast<T>(0.0f)) delta = -v_n * dt_safe * static_cast<T>(0.5f);
                if (delta > static_cast<T>(0.0f)) {
                    T K_steel = static_cast<T>(200.0e9f);
                    if (d_materials && truss.mat_id >= 0 && d_materials[truss.mat_id].youngs_modulus > 0.0f) {
                        K_steel = static_cast<T>(d_materials[truss.mat_id].youngs_modulus);
                    }
                    T m_seg_avg = static_cast<T>(0.5f) * (n1.m + n2.m);
                    T m_sum_seg = static_cast<T>(pm) + m_seg_avg;
                    T m_pair = (m_sum_seg > static_cast<T>(1.0e-30f))
                        ? (static_cast<T>(pm) * m_seg_avg / m_sum_seg)
                        : static_cast<T>(1.0e-30f);

                    T k_dyn = static_cast<T>(0.50f) * m_pair / (dt_safe * dt_safe);
                    T L_seg = sqrt(ab_len_sq);
                    T seg_area = static_cast<T>(3.1415926535f) * r_rebar * r_rebar;
                    T k_geom = contact_penalty_scale * ((static_cast<T>(0.10f) * K_steel * seg_area) / (L_seg > static_cast<T>(1.0e-12f) ? L_seg : static_cast<T>(1.0e-12f)));
                    T k_pen = (k_geom < k_dyn) ? k_geom : k_dyn;
                    if (k_pen < static_cast<T>(1.0e5f)) k_pen = static_cast<T>(1.0e5f);

                    T f_norm_mag = k_pen * delta;
                    if (v_n < static_cast<T>(0.0f)) {
                        T c_damp = static_cast<T>(2.0f) * contact_damping * sqrt(k_pen * m_pair);
                        f_norm_mag -= c_damp * v_n;
                    }

                    T v_limit = (static_cast<T>(1.5f) * fabs(v_n) > static_cast<T>(1.0f)) ? static_cast<T>(1.5f) * fabs(v_n) : static_cast<T>(1.0f);
                    T f_max = m_pair * v_limit / dt_safe;
                    if (f_norm_mag > f_max) f_norm_mag = f_max;
                    if (f_norm_mag < static_cast<T>(0.0f)) f_norm_mag = static_cast<T>(0.0f);

                    T v_rel_t[3] = {
                        v_rel[0] - v_n * n_dir[0],
                        v_rel[1] - v_n * n_dir[1],
                        v_rel[2] - v_n * n_dir[2]
                    };
                    T vt_mag = sqrt(v_rel_t[0]*v_rel_t[0] + v_rel_t[1]*v_rel_t[1] + v_rel_t[2]*v_rel_t[2]);
                    T f_fric[3] = {static_cast<T>(0), static_cast<T>(0), static_cast<T>(0)};
                    if (vt_mag > static_cast<T>(1.0e-6f) && (mu_static > static_cast<T>(0.0f) || mu_kinetic > static_cast<T>(0.0f))) {
                        T mu_eff = mu_kinetic + (mu_static - mu_kinetic) * exp(-static_cast<T>(10.0f) * vt_mag);
                        T f_fric_mag = mu_eff * f_norm_mag;
                        T f_stick = m_pair * vt_mag / dt_safe;
                        if (f_fric_mag > f_stick) f_fric_mag = f_stick;
                        f_fric[0] = -f_fric_mag * (v_rel_t[0] / vt_mag);
                        f_fric[1] = -f_fric_mag * (v_rel_t[1] / vt_mag);
                        f_fric[2] = -f_fric_mag * (v_rel_t[2] / vt_mag);
                    }

                    T f_tot_seg[3] = {
                        f_norm_mag * n_dir[0] + f_fric[0],
                        f_norm_mag * n_dir[1] + f_fric[1],
                        f_norm_mag * n_dir[2] + f_fric[2]
                    };

                    pvx += static_cast<float>((f_tot_seg[0] * dt_safe) / pm);
                    pvy += static_cast<float>((f_tot_seg[1] * dt_safe) / pm);
                    pvz += static_cast<float>((f_tot_seg[2] * dt_safe) / pm);
                    soa.v[0][p_idx] = pvx;
                    soa.v[1][p_idx] = pvy;
                    soa.v[2][p_idx] = pvz;

                    const T w0 = static_cast<T>(1.0f) - t_proj;
                    const T w1 = t_proj;
                    if (accumulate_impulse && d_mpm_impulse_accum) {
                        atomicAdd(&d_mpm_impulse_accum[tid0 * 3 + 0], -w0 * f_tot_seg[0] * dt_safe);
                        atomicAdd(&d_mpm_impulse_accum[tid0 * 3 + 1], -w0 * f_tot_seg[1] * dt_safe);
                        atomicAdd(&d_mpm_impulse_accum[tid0 * 3 + 2], -w0 * f_tot_seg[2] * dt_safe);
                        atomicAdd(&d_mpm_impulse_accum[tid1 * 3 + 0], -w1 * f_tot_seg[0] * dt_safe);
                        atomicAdd(&d_mpm_impulse_accum[tid1 * 3 + 1], -w1 * f_tot_seg[1] * dt_safe);
                        atomicAdd(&d_mpm_impulse_accum[tid1 * 3 + 2], -w1 * f_tot_seg[2] * dt_safe);
                    } else {
                        atomicAdd(&d_nodes[tid0].f_contact[0], -w0 * f_tot_seg[0]);
                        atomicAdd(&d_nodes[tid0].f_contact[1], -w0 * f_tot_seg[1]);
                        atomicAdd(&d_nodes[tid0].f_contact[2], -w0 * f_tot_seg[2]);
                        atomicAdd(&d_nodes[tid1].f_contact[0], -w1 * f_tot_seg[0]);
                        atomicAdd(&d_nodes[tid1].f_contact[1], -w1 * f_tot_seg[1]);
                        atomicAdd(&d_nodes[tid1].f_contact[2], -w1 * f_tot_seg[2]);
                    }
                }
            }
        }
    }

    // 3. 3D Timoshenko Beam Contact Evaluation (if beams present)
    if (d_beams && num_beams > 0) {
        for (int b = 0; b < num_beams; ++b) {
            const FEMBeam3DElement<T>& beam = d_beams[b];
            if (beam.is_eroded) continue;

            int bid0 = beam.node_ids[0];
            int bid1 = beam.node_ids[1];
            if (bid0 < 0 || bid0 >= num_nodes || bid1 < 0 || bid1 >= num_nodes) continue;
            const auto& n1 = d_nodes[bid0];
            const auto& n2 = d_nodes[bid1];
            if (n1.is_eroded || n2.is_eroded) continue;

            T r_rebar = (beam.d > static_cast<T>(0.0f))
                ? (static_cast<T>(0.5f) * beam.d)
                : sqrt(beam.A > static_cast<T>(1.0e-12f) ? (beam.A / static_cast<T>(3.1415926535f)) : static_cast<T>(0.0001f));
            T r_rebar_eff = (static_cast<T>(r_debris) < (static_cast<T>(2.0f) * r_rebar + static_cast<T>(0.005f)))
                          ? static_cast<T>(r_debris) : (static_cast<T>(2.0f) * r_rebar + static_cast<T>(0.005f));
            T R_contact = r_rebar + r_rebar_eff;

            T ab[3] = {n2.x[0] - n1.x[0], n2.x[1] - n1.x[1], n2.x[2] - n1.x[2]};
            T ap[3] = {static_cast<T>(px) - n1.x[0], static_cast<T>(py) - n1.x[1], static_cast<T>(pz) - n1.x[2]};
            T ab_len_sq = ab[0]*ab[0] + ab[1]*ab[1] + ab[2]*ab[2];
            if (ab_len_sq <= static_cast<T>(1.0e-16f)) continue;

            T t_proj = (ap[0]*ab[0] + ap[1]*ab[1] + ap[2]*ab[2]) / ab_len_sq;
            t_proj = t_proj < static_cast<T>(0.0f) ? static_cast<T>(0.0f) : (t_proj > static_cast<T>(1.0f) ? static_cast<T>(1.0f) : t_proj);

            T x_seg[3] = {
                n1.x[0] + t_proj * ab[0],
                n1.x[1] + t_proj * ab[1],
                n1.x[2] + t_proj * ab[2]
            };

            T d_vec[3] = {static_cast<T>(px) - x_seg[0], static_cast<T>(py) - x_seg[1], static_cast<T>(pz) - x_seg[2]};
            T dist_sq = d_vec[0]*d_vec[0] + d_vec[1]*d_vec[1] + d_vec[2]*d_vec[2];

            T v_seg[3] = {
                (static_cast<T>(1.0f) - t_proj) * n1.v[0] + t_proj * n2.v[0],
                (static_cast<T>(1.0f) - t_proj) * n1.v[1] + t_proj * n2.v[1],
                (static_cast<T>(1.0f) - t_proj) * n1.v[2] + t_proj * n2.v[2]
            };
            T v_rel[3] = {static_cast<T>(pvx) - v_seg[0], static_cast<T>(pvy) - v_seg[1], static_cast<T>(pvz) - v_seg[2]};

            T dist = sqrt(dist_sq > static_cast<T>(1.0e-20f) ? dist_sq : static_cast<T>(1.0e-20f));
            T n_dir[3] = {
                dist > static_cast<T>(1.0e-8f) ? (d_vec[0] / dist) : static_cast<T>(0.0f),
                dist > static_cast<T>(1.0e-8f) ? (d_vec[1] / dist) : static_cast<T>(1.0f),
                dist > static_cast<T>(1.0e-8f) ? (d_vec[2] / dist) : static_cast<T>(0.0f)
            };
            T v_n = v_rel[0]*n_dir[0] + v_rel[1]*n_dir[1] + v_rel[2]*n_dir[2];
            if (v_n > static_cast<T>(0.0f)) continue;

            T capture_depth = R_contact;
            T v_sweep = static_cast<T>(1.5f) * fabs(v_n) * dt_safe;
            if (v_sweep > capture_depth) capture_depth = v_sweep;

            if (dist < capture_depth) {
                T delta = R_contact - dist;
                if (delta <= static_cast<T>(0.0f) && v_n < static_cast<T>(0.0f)) delta = -v_n * dt_safe * static_cast<T>(0.5f);
                if (delta > static_cast<T>(0.0f)) {
                    T K_steel = static_cast<T>(200.0e9f);
                    if (d_materials && beam.mat_id >= 0 && d_materials[beam.mat_id].youngs_modulus > 0.0f) {
                        K_steel = static_cast<T>(d_materials[beam.mat_id].youngs_modulus);
                    }
                    T m_seg_avg = static_cast<T>(0.5f) * (n1.m + n2.m);
                    T m_sum_seg = static_cast<T>(pm) + m_seg_avg;
                    T m_pair = (m_sum_seg > static_cast<T>(1.0e-30f))
                        ? (static_cast<T>(pm) * m_seg_avg / m_sum_seg)
                        : static_cast<T>(1.0e-30f);

                    T k_dyn = static_cast<T>(0.50f) * m_pair / (dt_safe * dt_safe);
                    T L_seg = sqrt(ab_len_sq);
                    T seg_area = static_cast<T>(3.1415926535f) * r_rebar * r_rebar;
                    T k_geom = contact_penalty_scale * ((static_cast<T>(0.10f) * K_steel * seg_area) / (L_seg > static_cast<T>(1.0e-12f) ? L_seg : static_cast<T>(1.0e-12f)));
                    T k_pen = (k_geom < k_dyn) ? k_geom : k_dyn;
                    if (k_pen < static_cast<T>(1.0e5f)) k_pen = static_cast<T>(1.0e5f);

                    T f_norm_mag = k_pen * delta;
                    if (v_n < static_cast<T>(0.0f)) {
                        T c_damp = static_cast<T>(2.0f) * contact_damping * sqrt(k_pen * m_pair);
                        f_norm_mag -= c_damp * v_n;
                    }

                    T v_limit = (static_cast<T>(1.5f) * fabs(v_n) > static_cast<T>(1.0f)) ? static_cast<T>(1.5f) * fabs(v_n) : static_cast<T>(1.0f);
                    T f_max = m_pair * v_limit / dt_safe;
                    if (f_norm_mag > f_max) f_norm_mag = f_max;
                    if (f_norm_mag < static_cast<T>(0.0f)) f_norm_mag = static_cast<T>(0.0f);

                    T v_rel_t[3] = {
                        v_rel[0] - v_n * n_dir[0],
                        v_rel[1] - v_n * n_dir[1],
                        v_rel[2] - v_n * n_dir[2]
                    };
                    T vt_mag = sqrt(v_rel_t[0]*v_rel_t[0] + v_rel_t[1]*v_rel_t[1] + v_rel_t[2]*v_rel_t[2]);
                    T f_fric[3] = {static_cast<T>(0), static_cast<T>(0), static_cast<T>(0)};
                    if (vt_mag > static_cast<T>(1.0e-6f) && (mu_static > static_cast<T>(0.0f) || mu_kinetic > static_cast<T>(0.0f))) {
                        T mu_eff = mu_kinetic + (mu_static - mu_kinetic) * exp(-static_cast<T>(10.0f) * vt_mag);
                        T f_fric_mag = mu_eff * f_norm_mag;
                        T f_stick = m_pair * vt_mag / dt_safe;
                        if (f_fric_mag > f_stick) f_fric_mag = f_stick;
                        f_fric[0] = -f_fric_mag * (v_rel_t[0] / vt_mag);
                        f_fric[1] = -f_fric_mag * (v_rel_t[1] / vt_mag);
                        f_fric[2] = -f_fric_mag * (v_rel_t[2] / vt_mag);
                    }

                    T f_tot_seg[3] = {
                        f_norm_mag * n_dir[0] + f_fric[0],
                        f_norm_mag * n_dir[1] + f_fric[1],
                        f_norm_mag * n_dir[2] + f_fric[2]
                    };

                    pvx += static_cast<float>((f_tot_seg[0] * dt_safe) / pm);
                    pvy += static_cast<float>((f_tot_seg[1] * dt_safe) / pm);
                    pvz += static_cast<float>((f_tot_seg[2] * dt_safe) / pm);
                    soa.v[0][p_idx] = pvx;
                    soa.v[1][p_idx] = pvy;
                    soa.v[2][p_idx] = pvz;

                    const T w0 = static_cast<T>(1.0f) - t_proj;
                    const T w1 = t_proj;
                    if (accumulate_impulse && d_mpm_impulse_accum) {
                        atomicAdd(&d_mpm_impulse_accum[bid0 * 3 + 0], -w0 * f_tot_seg[0] * dt_safe);
                        atomicAdd(&d_mpm_impulse_accum[bid0 * 3 + 1], -w0 * f_tot_seg[1] * dt_safe);
                        atomicAdd(&d_mpm_impulse_accum[bid0 * 3 + 2], -w0 * f_tot_seg[2] * dt_safe);
                        atomicAdd(&d_mpm_impulse_accum[bid1 * 3 + 0], -w1 * f_tot_seg[0] * dt_safe);
                        atomicAdd(&d_mpm_impulse_accum[bid1 * 3 + 1], -w1 * f_tot_seg[1] * dt_safe);
                        atomicAdd(&d_mpm_impulse_accum[bid1 * 3 + 2], -w1 * f_tot_seg[2] * dt_safe);
                    } else {
                        atomicAdd(&d_nodes[bid0].f_contact[0], -w0 * f_tot_seg[0]);
                        atomicAdd(&d_nodes[bid0].f_contact[1], -w0 * f_tot_seg[1]);
                        atomicAdd(&d_nodes[bid0].f_contact[2], -w0 * f_tot_seg[2]);
                        atomicAdd(&d_nodes[bid1].f_contact[0], -w1 * f_tot_seg[0]);
                        atomicAdd(&d_nodes[bid1].f_contact[1], -w1 * f_tot_seg[1]);
                        atomicAdd(&d_nodes[bid1].f_contact[2], -w1 * f_tot_seg[2]);
                    }
                }
            }
        }
    }
}



// CUDA Kernel: Compute minimum stable timestep size on GPU
template <typename T>
__global__ void fem_compute_step_size_kernel_3d_device(
    const FEMNode3D<T>* d_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    const FEMTrussElement3D<T>* d_trusses,
    int num_trusses,
    const FEMBeam3DElement<T>* d_beams,
    int num_beams,
    const MaterialTable3D* d_materials,
    T cfl,
    T* d_block_min_dt
) {
    extern __shared__ char s_mem[];
    T* s_dt = reinterpret_cast<T*>(s_mem);

    int tid = threadIdx.x;
    int e = blockIdx.x * blockDim.x + threadIdx.x;

    T dt_elem = static_cast<T>(1.0e30f);

    if (e < num_elements && d_elements) {
        const FEMElement3D<T>& elem = d_elements[e];
        if (!elem.is_eroded) {
            T x_curr[8][3];
            for (int n = 0; n < 8; ++n) {
                int nid = elem.node_ids[n];
                x_curr[n][0] = d_nodes[nid].x[0];
                x_curr[n][1] = d_nodes[nid].x[1];
                x_curr[n][2] = d_nodes[nid].x[2];
            }
            T V_cur = elem.V > static_cast<T>(0.0f) ? elem.V : elem.V0;
            T L_e = isTet4Element(elem)
                ? computeTet4CharacteristicLength(x_curr, V_cur)
                : computeHex8CharacteristicLength(x_curr, V_cur);

            const MaterialTable3D& mat = d_materials[elem.mat_id];
            T v_rel = (elem.V0 > static_cast<T>(1.0e-18f) && V_cur > static_cast<T>(0.0f))
                ? (V_cur / elem.V0) : static_cast<T>(1.0f);
            T p_el = -(elem.sigma[0][0] + elem.sigma[1][1] + elem.sigma[2][2]) / static_cast<T>(3.0f) - elem.q_visc;
            T cd = computeDilatationalWaveSpeed<T>(mat, v_rel, elem.lambda, p_el, elem.e_int);

            if (cd > static_cast<T>(1.0e-6f)) {
                dt_elem = cfl * (L_e / cd);
            }
        }
    }

    if (d_trusses && e < num_trusses) {
        const FEMTrussElement3D<T>& tr = d_trusses[e];
        if (!tr.is_eroded && tr.L0 > static_cast<T>(1.0e-9f)) {
            int n1 = tr.node_ids[0];
            int n2 = tr.node_ids[1];
            T dx = d_nodes[n2].x[0] - d_nodes[n1].x[0];
            T dy = d_nodes[n2].x[1] - d_nodes[n1].x[1];
            T dz = d_nodes[n2].x[2] - d_nodes[n1].x[2];
            T L = sqrt(dx*dx + dy*dy + dz*dz);
            if (L <= static_cast<T>(1.0e-9f)) L = tr.L0;

            const MaterialTable3D& mat = d_materials[tr.mat_id];
            T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f);
            T rho = static_cast<T>(mat.density > 0.0f ? mat.density : 7850.0f);
            T cd = sqrt(E / rho);
            if (cd > static_cast<T>(1.0e-6f)) {
                T dt_tr = cfl * (L / cd);
                if (dt_tr < dt_elem) dt_elem = dt_tr;
            }
        }
    }

    if (d_beams && e < num_beams) {
        const FEMBeam3DElement<T>& bm = d_beams[e];
        if (!bm.is_eroded && bm.L0 > static_cast<T>(1.0e-9f)) {
            int n1 = bm.node_ids[0];
            int n2 = bm.node_ids[1];
            T dx = d_nodes[n2].x[0] - d_nodes[n1].x[0];
            T dy = d_nodes[n2].x[1] - d_nodes[n1].x[1];
            T dz = d_nodes[n2].x[2] - d_nodes[n1].x[2];
            T L = sqrt(dx*dx + dy*dy + dz*dz);
            if (L <= static_cast<T>(1.0e-9f)) L = bm.L0;

            const MaterialTable3D& mat = d_materials[bm.mat_id];
            T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f);
            T rho = static_cast<T>(mat.density > 0.0f ? mat.density : 7850.0f);
            T cd = sqrt(E / rho);
            if (cd > static_cast<T>(1.0e-6f)) {
                T dt_axial = cfl * (L / cd);
                T d_safe = bm.d > static_cast<T>(1.0e-6f) ? bm.d : static_cast<T>(0.01f);
                T dt_bend = cfl * (L * L) / (static_cast<T>(3.464f) * d_safe * cd);
                T dt_bm = (dt_axial < dt_bend) ? dt_axial : dt_bend;
                if (dt_bm < dt_elem) dt_elem = dt_bm;
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
    FEMGaussPointHistory3D<T>* d_gp_history,
    const MaterialTable3D* d_materials,
    BlastPhysicsParams<T> physics_params,
    T dt,
    T hourglass_coeff,
    FEMHourglassModel hg_model,
    FEMIntegrationScheme integration_scheme,
    cudaStream_t stream,
    T* d_nodal_vol_cur,
    T* d_nodal_vol_ref,
    T current_time,
    T* d_nodal_dvol_dt,
    T min_volume_ratio,
    int* d_erosion_flag
) {
    if (num_elements <= 0) return;
    int block_size = 256;
    int grid_size = (num_elements + block_size - 1) / block_size;
    if (d_nodal_vol_cur && d_nodal_vol_ref && num_nodes > 0) {
        cudaMemsetAsync(d_nodal_vol_cur, 0, sizeof(T) * num_nodes, stream);
        cudaMemsetAsync(d_nodal_vol_ref, 0, sizeof(T) * num_nodes, stream);
        if (d_nodal_dvol_dt) {
            cudaMemsetAsync(d_nodal_dvol_dt, 0, sizeof(T) * num_nodes, stream);
        }
        fem_anp_nodal_volumes_kernel_3d_device<T><<<grid_size, block_size, 0, stream>>>(
            d_nodes, d_elements, num_elements, d_materials, dt, d_nodal_vol_cur, d_nodal_vol_ref, d_nodal_dvol_dt
        );
    }
    fem_element_forces_kernel_3d_device<T><<<grid_size, block_size, 0, stream>>>(
        d_nodes, num_nodes, d_elements, num_elements, d_gp_history, d_materials,
        physics_params, dt, hourglass_coeff, hg_model, integration_scheme,
        d_nodal_vol_cur, d_nodal_vol_ref, d_nodal_dvol_dt, current_time,
        min_volume_ratio, d_erosion_flag
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
    const FEMTrussElement3D<T>* d_trusses,
    int num_trusses,
    const FEMBeam3DElement<T>* d_beams,
    int num_beams,
    const MaterialTable3D* d_materials,
    FEMErosionCriteria<T> erosion_criteria,
    BlastPhysicsParams<T> physics_params,
    int* d_node_active_count,
    int* d_erosion_flag,
    cudaStream_t stream,
    bool enable_cohesive_splitting,
    const int* d_face_neighbors,
    bool enable_nonlocal_damage
) {
    if (num_elements <= 0) return;
    int block_size = 256;
    int grid_size = (num_elements + block_size - 1) / block_size;
    fem_initial_timestep_erosion_kernel_3d_device<T><<<grid_size, block_size, 0, stream>>>(
        d_nodes, d_elements, num_elements, d_materials, erosion_criteria, d_erosion_flag,
        enable_cohesive_splitting, d_face_neighbors, enable_nonlocal_damage, physics_params
    );
}

template <typename T>
void launch_fem_update_orphan_nodes_erosion_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    const FEMTrussElement3D<T>* d_trusses,
    int num_trusses,
    const FEMBeam3DElement<T>* d_beams,
    int num_beams,
    int* d_node_active_count,
    cudaStream_t stream
) {
    if (num_nodes <= 0 || !d_node_active_count) return;
    int block_size = 256;
    cudaMemsetAsync(d_node_active_count, 0, sizeof(int) * num_nodes, stream);
    if (num_elements > 0) {
        int grid_size = (num_elements + block_size - 1) / block_size;
        fem_count_active_node_elements_kernel_device<T><<<grid_size, block_size, 0, stream>>>(
            d_elements, num_elements, d_node_active_count, num_nodes
        );
    }
    if ((d_trusses && num_trusses > 0) || (d_beams && num_beams > 0)) {
        int max_tb = std::max(num_trusses, num_beams);
        int tb_grid_size = (max_tb + block_size - 1) / block_size;
        fem_count_active_node_trusses_and_beams_kernel_device<T><<<tb_grid_size, block_size, 0, stream>>>(
            d_trusses, num_trusses, d_beams, num_beams, d_node_active_count, num_nodes
        );
    }
    int node_grid_size = (num_nodes + block_size - 1) / block_size;
    fem_update_orphan_nodes_erosion_kernel_device<T><<<node_grid_size, block_size, 0, stream>>>(
        d_nodes, num_nodes, d_node_active_count
    );
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
    FEMContactSearchMethod search_method,
    int* d_cell_counts,
    int* d_cell_offsets,
    int* d_cell_facet_ids,
    int max_hash_entries,
    int* d_oversized_facets,
    int* d_oversized_count,
    int max_oversized_facets,
    void* d_hash_scan_temp,
    size_t hash_scan_temp_bytes,
    uint32_t table_size,
    T base_cell_size,
    uint32_t* d_morton_codes,
    uint32_t* d_morton_codes_alt,
    int* d_sorted_facet_ids,
    int* d_facet_indices_in,
    LBVHNode3D<T>* d_bvh_nodes,
    int* d_bvh_leaf_parents,
    int* d_bvh_flags,
    void* d_bvh_temp_storage,
    size_t& bvh_temp_storage_bytes,
    T xmin, T xmax, T ymin, T ymax, T zmin, T zmax,
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

    if (search_method == FEMContactSearchMethod::LinearBVH &&
        d_bvh_nodes && d_morton_codes && d_morton_codes_alt &&
        d_sorted_facet_ids && d_facet_indices_in && d_bvh_leaf_parents &&
        d_bvh_flags && d_bvh_temp_storage && bvh_temp_storage_bytes > 0) {

        int facet_grid_size = (num_facets + block_size - 1) / block_size;
        T lx = (xmax > xmin) ? (xmax - xmin) : static_cast<T>(1.0f);
        T ly = (ymax > ymin) ? (ymax - ymin) : static_cast<T>(1.0f);
        T lz = (zmax > zmin) ? (zmax - zmin) : static_cast<T>(1.0f);
        T inv_lx = static_cast<T>(1.0f) / lx;
        T inv_ly = static_cast<T>(1.0f) / ly;
        T inv_lz = static_cast<T>(1.0f) / lz;

        // 1. Compute 30-bit Morton codes from facet centroids
        fem_compute_morton_codes_kernel_3d_device<T><<<facet_grid_size, block_size, 0, stream>>>(
            d_facets, num_facets, xmin, ymin, zmin, inv_lx, inv_ly, inv_lz,
            d_morton_codes, d_facet_indices_in
        );

        // 2. Parallel Radix Sort on Morton codes via CUB
        cub::DeviceRadixSort::SortPairs(
            d_bvh_temp_storage, bvh_temp_storage_bytes,
            d_morton_codes, d_morton_codes_alt,
            d_facet_indices_in, d_sorted_facet_ids,
            num_facets, 0, 32, stream
        );

        if (num_facets > 1) {
            cudaMemsetAsync(d_bvh_leaf_parents, 0xFF, sizeof(int) * num_facets, stream);
            cudaMemsetAsync(d_bvh_flags, 0, sizeof(int) * (num_facets + 1), stream);

            // 3. Construct LBVH binary radix tree (Karras 2012)
            int tree_grid_size = ((num_facets - 1) + block_size - 1) / block_size;
            fem_build_lbvh_tree_kernel_3d_device<T><<<tree_grid_size, block_size, 0, stream>>>(
                num_facets, d_morton_codes_alt, d_bvh_nodes, d_bvh_leaf_parents
            );

            // 4. Compute AABBs bottom-up with atomic counters and capture root
            int* d_root_index = &d_bvh_flags[num_facets - 1];
            fem_build_lbvh_aabbs_kernel_3d_device<T><<<facet_grid_size, block_size, 0, stream>>>(
                num_facets, d_sorted_facet_ids, d_facets, d_bvh_nodes, d_bvh_leaf_parents, d_bvh_flags, d_root_index
            );

            // 5. Query contact using stack-based GPU LBVH traversal
            fem_contact_forces_lbvh_kernel_3d_device<T><<<sn_grid_size, block_size, 0, stream>>>(
                d_nodes, num_nodes, d_elements, num_elements, d_facets, num_facets,
                d_surface_nodes, num_surface_nodes, d_node_part_id, d_part_mat_id, max_parts,
                d_node_normals, d_materials, d_sorted_facet_ids, d_bvh_nodes, d_root_index,
                contact_penalty_scale, mu_static, mu_kinetic, contact_damping, dt
            );
        }
    } else {
        // Lossless Multi-Level CSR Octave Spatial Hash Grid (4 octaves + oversized list)
        if (d_cell_counts && d_cell_offsets && d_cell_facet_ids &&
            d_hash_scan_temp && hash_scan_temp_bytes > 0 && d_oversized_count && table_size > 0) {
            const int total_buckets = 4 * static_cast<int>(table_size);
            int facet_grid_size = (num_facets + block_size - 1) / block_size;

            cudaMemsetAsync(d_cell_counts, 0, sizeof(int) * total_buckets, stream);
            cudaMemsetAsync(d_oversized_count, 0, sizeof(int), stream);
            fem_count_octave_hash_grid_kernel_3d_device<T><<<facet_grid_size, block_size, 0, stream>>>(
                d_facets, num_facets, base_cell_size, d_cell_counts,
                d_oversized_facets, d_oversized_count, max_oversized_facets, table_size
            );

            size_t scan_bytes = hash_scan_temp_bytes;
            cub::DeviceScan::ExclusiveSum(
                d_hash_scan_temp, scan_bytes,
                d_cell_counts, d_cell_offsets,
                total_buckets, stream
            );

            cudaMemsetAsync(d_cell_counts, 0, sizeof(int) * total_buckets, stream);
            fem_scatter_octave_hash_grid_kernel_3d_device<T><<<facet_grid_size, block_size, 0, stream>>>(
                d_facets, num_facets, base_cell_size, d_cell_counts, d_cell_offsets,
                d_cell_facet_ids, max_hash_entries, table_size
            );

            fem_contact_forces_octave_grid_kernel_3d_device<T><<<sn_grid_size, block_size, 0, stream>>>(
                d_nodes, num_nodes, d_elements, num_elements, d_facets, num_facets,
                d_surface_nodes, num_surface_nodes, d_node_part_id, d_part_mat_id, max_parts,
                d_node_normals, d_materials, d_cell_counts, d_cell_offsets, d_cell_facet_ids,
                max_hash_entries, d_oversized_facets, d_oversized_count, max_oversized_facets,
                table_size, base_cell_size,
                contact_penalty_scale, mu_static, mu_kinetic, contact_damping, dt
            );
        }
    }
}

template <typename T>
void launch_fem_mpm_debris_contact_kernel_3d(
    MPMParticle3DSoA soa,
    int num_particles,
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    const FEMFacet3D<T>* d_facets,
    int num_facets,
    const FEMTrussElement3D<T>* d_trusses,
    int num_trusses,
    const FEMBeam3DElement<T>* d_beams,
    int num_beams,
    const MaterialTable3D* d_materials,
    const int* d_cell_counts,
    const int* d_cell_offsets,
    const int* d_cell_facet_ids,
    int max_hash_entries,
    const int* d_oversized_facets,
    const int* d_oversized_count,
    int max_oversized_facets,
    uint32_t table_size,
    T base_cell_size,
    T contact_penalty_scale,
    T mu_static,
    T mu_kinetic,
    T contact_damping,
    T dt,
    T* d_mpm_impulse_accum,
    bool accumulate_impulse,
    cudaStream_t stream
) {
    if (contact_penalty_scale <= static_cast<T>(0.0f)) return;
    if (num_particles <= 0 || (num_facets <= 0 && num_trusses <= 0 && num_beams <= 0)) return;
    int block_size = 256;
    int grid_size = (num_particles + block_size - 1) / block_size;
    fem_contact_mpm_debris_kernel_3d_device<T><<<grid_size, block_size, 0, stream>>>(
        soa, num_particles, d_nodes, num_nodes, d_elements, num_elements,
        d_facets, num_facets, d_trusses, num_trusses, d_beams, num_beams,
        d_materials, d_cell_counts, d_cell_offsets, d_cell_facet_ids,
        max_hash_entries, d_oversized_facets, d_oversized_count,
        max_oversized_facets, table_size, base_cell_size,
        contact_penalty_scale, mu_static, mu_kinetic, contact_damping, dt,
        d_mpm_impulse_accum, accumulate_impulse
    );
}

template <typename T>
T launch_fem_compute_step_size_kernel_3d(
    const FEMNode3D<T>* d_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    const FEMTrussElement3D<T>* d_trusses,
    int num_trusses,
    const FEMBeam3DElement<T>* d_beams,
    int num_beams,
    const MaterialTable3D* d_materials,
    T cfl,
    T* d_reduction_buffer,
    cudaStream_t stream
) {
    int max_count = std::max({num_elements, num_trusses, num_beams});
    if (max_count <= 0) return static_cast<T>(1.0e-6f);
    int block_size = 256;
    int grid_size = (max_count + block_size - 1) / block_size;

    fem_compute_step_size_kernel_3d_device<T><<<grid_size, block_size, sizeof(T) * block_size, stream>>>(
        d_nodes, d_elements, num_elements, d_trusses, num_trusses, d_beams, num_beams,
        d_materials, cfl, d_reduction_buffer
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
    cudaMallocHost(&m_h_erosion_flag_pinned, sizeof(int));
    if (m_h_erosion_flag_pinned) *m_h_erosion_flag_pinned = 0;
}

template <typename T>
FEMSolver3DCUDA<T>::~FEMSolver3DCUDA() {
    if (m_h_erosion_flag_pinned) { cudaFreeHost(m_h_erosion_flag_pinned); m_h_erosion_flag_pinned = nullptr; }
    if (m_d_nodes) { cudaFree(m_d_nodes); m_d_nodes = nullptr; }
    if (m_d_mpm_impulse_accum) { cudaFree(m_d_mpm_impulse_accum); m_d_mpm_impulse_accum = nullptr; }
    if (m_d_elements) { cudaFree(m_d_elements); m_d_elements = nullptr; }
    if (m_d_gp_history) { cudaFree(m_d_gp_history); m_d_gp_history = nullptr; }
    if (m_d_materials) { cudaFree(m_d_materials); m_d_materials = nullptr; }
    if (m_d_facets) { cudaFree(m_d_facets); m_d_facets = nullptr; }
    if (m_d_surface_nodes) { cudaFree(m_d_surface_nodes); m_d_surface_nodes = nullptr; }
    if (m_d_node_part_id) { cudaFree(m_d_node_part_id); m_d_node_part_id = nullptr; }
    if (m_d_part_mat_id) { cudaFree(m_d_part_mat_id); m_d_part_mat_id = nullptr; }
    if (m_d_node_normals) { cudaFree(m_d_node_normals); m_d_node_normals = nullptr; }
    if (m_d_reduction_buffer) { cudaFree(m_d_reduction_buffer); m_d_reduction_buffer = nullptr; }
    if (m_d_node_active_count) { cudaFree(m_d_node_active_count); m_d_node_active_count = nullptr; }
    if (m_d_nodal_vol_cur) { cudaFree(m_d_nodal_vol_cur); m_d_nodal_vol_cur = nullptr; }
    if (m_d_nodal_vol_ref) { cudaFree(m_d_nodal_vol_ref); m_d_nodal_vol_ref = nullptr; }
    if (m_d_nodal_dvol_dt) { cudaFree(m_d_nodal_dvol_dt); m_d_nodal_dvol_dt = nullptr; }
    if (m_d_face_neighbors) { cudaFree(m_d_face_neighbors); m_d_face_neighbors = nullptr; }
    if (m_d_erosion_flag) { cudaFree(m_d_erosion_flag); m_d_erosion_flag = nullptr; }
    if (m_d_cell_counts) { cudaFree(m_d_cell_counts); m_d_cell_counts = nullptr; }
    if (m_d_cell_offsets) { cudaFree(m_d_cell_offsets); m_d_cell_offsets = nullptr; }
    if (m_d_cell_facet_ids) { cudaFree(m_d_cell_facet_ids); m_d_cell_facet_ids = nullptr; }
    if (m_d_oversized_facets) { cudaFree(m_d_oversized_facets); m_d_oversized_facets = nullptr; }
    if (m_d_oversized_count) { cudaFree(m_d_oversized_count); m_d_oversized_count = nullptr; }
    if (m_d_hash_scan_temp) { cudaFree(m_d_hash_scan_temp); m_d_hash_scan_temp = nullptr; }
    if (m_d_bvh_morton_codes) { cudaFree(m_d_bvh_morton_codes); m_d_bvh_morton_codes = nullptr; }
    if (m_d_bvh_morton_codes_alt) { cudaFree(m_d_bvh_morton_codes_alt); m_d_bvh_morton_codes_alt = nullptr; }
    if (m_d_bvh_sorted_facet_ids) { cudaFree(m_d_bvh_sorted_facet_ids); m_d_bvh_sorted_facet_ids = nullptr; }
    if (m_d_bvh_facet_indices_in) { cudaFree(m_d_bvh_facet_indices_in); m_d_bvh_facet_indices_in = nullptr; }
    if (m_d_bvh_nodes) { cudaFree(m_d_bvh_nodes); m_d_bvh_nodes = nullptr; }
    if (m_d_bvh_leaf_parents) { cudaFree(m_d_bvh_leaf_parents); m_d_bvh_leaf_parents = nullptr; }
    if (m_d_bvh_flags) { cudaFree(m_d_bvh_flags); m_d_bvh_flags = nullptr; }
    if (m_d_bvh_temp_storage) { cudaFree(m_d_bvh_temp_storage); m_d_bvh_temp_storage = nullptr; }
    if (m_d_trusses) { cudaFree(m_d_trusses); m_d_trusses = nullptr; }
    if (m_d_beams) { cudaFree(m_d_beams); m_d_beams = nullptr; }
    if (m_d_rot_nodes) { cudaFree(m_d_rot_nodes); m_d_rot_nodes = nullptr; }
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
void FEMSolver3DCUDA<T>::ensureOctaveHashCapacity(size_t facet_cap) {
    const size_t total_buckets = m_spatial_grid_capacity * NUM_OCTAVES;
    if (!m_d_cell_counts) {
        cudaMalloc(&m_d_cell_counts, sizeof(int) * total_buckets);
        cudaMalloc(&m_d_cell_offsets, sizeof(int) * total_buckets);
        cudaMalloc(&m_d_oversized_count, sizeof(int));
        m_hash_scan_temp_bytes = 0;
        cub::DeviceScan::ExclusiveSum(
            nullptr, m_hash_scan_temp_bytes,
            m_d_cell_counts, m_d_cell_offsets,
            static_cast<int>(total_buckets), m_cuda_stream
        );
        if (m_d_hash_scan_temp) cudaFree(m_d_hash_scan_temp);
        cudaMalloc(&m_d_hash_scan_temp, m_hash_scan_temp_bytes > 0 ? m_hash_scan_temp_bytes : 256);
    }
    size_t req_over = std::max(facet_cap, static_cast<size_t>(4096));
    if (req_over > m_allocated_oversized_facets) {
        if (m_d_oversized_facets) cudaFree(m_d_oversized_facets);
        m_allocated_oversized_facets = std::max(req_over * 2, m_allocated_oversized_facets * 2);
        cudaMalloc(&m_d_oversized_facets, sizeof(int) * m_allocated_oversized_facets);
    }
    size_t req_entries = std::max(static_cast<size_t>(8388608), (facet_cap + 4096) * 64);
    if (req_entries > m_allocated_hash_entries) {
        if (m_d_cell_facet_ids) cudaFree(m_d_cell_facet_ids);
        m_allocated_hash_entries = std::max(req_entries, m_allocated_hash_entries * 2);
        cudaMalloc(&m_d_cell_facet_ids, sizeof(int) * m_allocated_hash_entries);
    }
}

template <typename T>
void FEMSolver3DCUDA<T>::syncToDevice() {
    const auto& nodes = m_cpu_solver.getNodes();
    const auto& elements = m_cpu_solver.getElements();
    const auto& trusses = m_cpu_solver.getTrusses();
    const auto& beams = m_cpu_solver.getBeams();
    const auto& materials = m_cpu_solver.getMaterialTables();
    const auto& facets = m_cpu_solver.getSurfaceFacets();

    if (nodes.empty() || (elements.empty() && trusses.empty() && beams.empty())) return;

    if (nodes.size() > m_allocated_nodes) {
        if (m_d_nodes) cudaFree(m_d_nodes);
        if (m_d_mpm_impulse_accum) cudaFree(m_d_mpm_impulse_accum);
        if (m_d_node_part_id) cudaFree(m_d_node_part_id);
        if (m_d_node_normals) cudaFree(m_d_node_normals);
        if (m_d_node_active_count) cudaFree(m_d_node_active_count);
        if (m_d_nodal_vol_cur) cudaFree(m_d_nodal_vol_cur);
        if (m_d_nodal_vol_ref) cudaFree(m_d_nodal_vol_ref);
        if (m_d_nodal_dvol_dt) cudaFree(m_d_nodal_dvol_dt);
        m_allocated_nodes = std::max(nodes.size() * 2, m_allocated_nodes * 2 + 1024);
        cudaMalloc(&m_d_nodes, sizeof(FEMNode3D<T>) * m_allocated_nodes);
        cudaMalloc(&m_d_mpm_impulse_accum, sizeof(T) * m_allocated_nodes * 3);
        cudaMalloc(&m_d_node_part_id, sizeof(int) * m_allocated_nodes);
        cudaMalloc(&m_d_node_normals, sizeof(T) * m_allocated_nodes * 3);
        cudaMalloc(&m_d_node_active_count, sizeof(int) * m_allocated_nodes);
        cudaMalloc(&m_d_nodal_vol_cur, sizeof(T) * m_allocated_nodes);
        cudaMalloc(&m_d_nodal_vol_ref, sizeof(T) * m_allocated_nodes);
        cudaMalloc(&m_d_nodal_dvol_dt, sizeof(T) * m_allocated_nodes);
    }
    if (m_d_mpm_impulse_accum && m_allocated_nodes > 0) {
        cudaMemsetAsync(m_d_mpm_impulse_accum, 0, sizeof(T) * m_allocated_nodes * 3, m_cuda_stream);
    }
    m_has_pending_mpm_impulse = false;
    if (!m_d_erosion_flag) {
        cudaMalloc(&m_d_erosion_flag, sizeof(int));
    }
    cudaMemsetAsync(m_d_erosion_flag, 0, sizeof(int), m_cuda_stream);
    if (m_h_erosion_flag_pinned) *m_h_erosion_flag_pinned = 0;

    cudaMemcpyAsync(m_d_nodes, nodes.data(), sizeof(FEMNode3D<T>) * nodes.size(), cudaMemcpyHostToDevice, m_cuda_stream);

    // Compute node-to-part mapping on CPU and copy to GPU
    m_h_node_part_scratch.assign(nodes.size(), -1);
    m_max_part_id = -1;
    for (const auto& elem : elements) {
        if (elem.is_eroded) continue;
        if (elem.part_id > m_max_part_id) m_max_part_id = elem.part_id;
        for (int k = 0; k < 8; ++k) {
            int nid = elem.node_ids[k];
            if (nid >= 0 && nid < static_cast<int>(nodes.size())) {
                m_h_node_part_scratch[nid] = elem.part_id;
            }
        }
    }
    cudaMemcpyAsync(m_d_node_part_id, m_h_node_part_scratch.data(), sizeof(int) * nodes.size(), cudaMemcpyHostToDevice, m_cuda_stream);

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

    size_t max_elem_count = std::max({elements.size(), trusses.size(), beams.size(), static_cast<size_t>(1)});
    if (elements.size() > m_allocated_elements) {
        if (m_d_elements) cudaFree(m_d_elements);
        if (m_d_face_neighbors) cudaFree(m_d_face_neighbors);
        m_allocated_elements = elements.size();
        cudaMalloc(&m_d_elements, sizeof(FEMElement3D<T>) * m_allocated_elements);
        cudaMalloc(&m_d_face_neighbors, sizeof(int) * m_allocated_elements * 6);
    }
    size_t target_red_count = (std::max(max_elem_count, m_allocated_elements) + 255) / 256;
    if (target_red_count < 1) target_red_count = 1;
    if (!m_d_reduction_buffer || target_red_count > m_allocated_reduction_count) {
        if (m_d_reduction_buffer) cudaFree(m_d_reduction_buffer);
        m_allocated_reduction_count = target_red_count;
        cudaMalloc(&m_d_reduction_buffer, sizeof(T) * m_allocated_reduction_count);
    }
    if (!elements.empty()) {
        cudaMemcpyAsync(m_d_elements, elements.data(), sizeof(FEMElement3D<T>) * elements.size(), cudaMemcpyHostToDevice, m_cuda_stream);
        const auto& face_neighbors = m_cpu_solver.getFaceNeighbors();
        if (m_d_face_neighbors && face_neighbors.size() >= elements.size() * 6) {
            cudaMemcpyAsync(m_d_face_neighbors, face_neighbors.data(), sizeof(int) * elements.size() * 6, cudaMemcpyHostToDevice, m_cuda_stream);
        } else if (m_d_face_neighbors) {
            cudaMemsetAsync(m_d_face_neighbors, 0xFF, sizeof(int) * elements.size() * 6, m_cuda_stream);
        }
    }

    // Conditionally allocate and copy Gauss point history when global or per-part 8-point Gauss schemes are used
    bool need_gp_hist = (m_cpu_solver.getIntegrationScheme() == FEMIntegrationScheme::FullGauss8 ||
                         m_cpu_solver.getIntegrationScheme() == FEMIntegrationScheme::SelectiveReduced);
    if (!need_gp_hist) {
        for (const auto& elem : elements) {
            if (!elem.is_eroded) {
                FEMIntegrationScheme es = resolveElementIntegrationScheme(elem, m_cpu_solver.getIntegrationScheme());
                if (es == FEMIntegrationScheme::FullGauss8 || es == FEMIntegrationScheme::SelectiveReduced) {
                    need_gp_hist = true;
                    break;
                }
            }
        }
    }
    if (need_gp_hist) {
        m_cpu_solver.ensureGaussPointHistory();
        const auto& gp_hist = m_cpu_solver.getGaussPointHistory();
        if (!gp_hist.empty()) {
            if (gp_hist.size() > m_allocated_gp_history) {
                if (m_d_gp_history) cudaFree(m_d_gp_history);
                m_allocated_gp_history = gp_hist.size();
                cudaMalloc(&m_d_gp_history, sizeof(FEMGaussPointHistory3D<T>) * m_allocated_gp_history);
            }
            cudaMemcpyAsync(m_d_gp_history, gp_hist.data(), sizeof(FEMGaussPointHistory3D<T>) * gp_hist.size(), cudaMemcpyHostToDevice, m_cuda_stream);
        }
    }

    if (materials.size() > m_allocated_materials) {
        if (m_d_materials) cudaFree(m_d_materials);
        m_allocated_materials = materials.size();
        cudaMalloc(&m_d_materials, sizeof(MaterialTable3D) * m_allocated_materials);
    }
    if (!materials.empty()) {
        cudaMemcpyAsync(m_d_materials, materials.data(), sizeof(MaterialTable3D) * materials.size(), cudaMemcpyHostToDevice, m_cuda_stream);
    }

    // Allocate and copy 1D trusses and 3D beams to GPU
    if (trusses.size() > m_allocated_trusses) {
        if (m_d_trusses) cudaFree(m_d_trusses);
        m_allocated_trusses = trusses.size() + 128;
        cudaMalloc(&m_d_trusses, sizeof(FEMTrussElement3D<T>) * m_allocated_trusses);
    }
    if (!trusses.empty()) {
        cudaMemcpyAsync(m_d_trusses, trusses.data(), sizeof(FEMTrussElement3D<T>) * trusses.size(), cudaMemcpyHostToDevice, m_cuda_stream);
    }

    if (beams.size() > m_allocated_beams) {
        if (m_d_beams) cudaFree(m_d_beams);
        m_allocated_beams = beams.size() + 128;
        cudaMalloc(&m_d_beams, sizeof(FEMBeam3DElement<T>) * m_allocated_beams);
    }
    if (!beams.empty()) {
        cudaMemcpyAsync(m_d_beams, beams.data(), sizeof(FEMBeam3DElement<T>) * beams.size(), cudaMemcpyHostToDevice, m_cuda_stream);
    }

    const auto& rot_nodes = m_cpu_solver.getRotationalNodes();
    if (rot_nodes.size() > m_allocated_rot_nodes) {
        if (m_d_rot_nodes) cudaFree(m_d_rot_nodes);
        m_allocated_rot_nodes = rot_nodes.size() + 128;
        cudaMalloc(&m_d_rot_nodes, sizeof(FEMNodeRotationalState3D<T>) * m_allocated_rot_nodes);
    }
    if (!rot_nodes.empty()) {
        cudaMemcpyAsync(m_d_rot_nodes, rot_nodes.data(), sizeof(FEMNodeRotationalState3D<T>) * rot_nodes.size(), cudaMemcpyHostToDevice, m_cuda_stream);
    }

    m_num_surface_facets = facets.size();
    size_t target_facets_cap = std::max(facets.size() * 2, elements.size() * 3);
    if (target_facets_cap > m_allocated_facets) {
        if (m_d_facets) cudaFree(m_d_facets);
        m_allocated_facets = std::max(target_facets_cap + 4096, m_allocated_facets * 2);
        cudaMalloc(&m_d_facets, sizeof(FEMFacet3D<T>) * m_allocated_facets);
    }
    if (!facets.empty()) {
        cudaMemcpyAsync(m_d_facets, facets.data(), sizeof(FEMFacet3D<T>) * facets.size(), cudaMemcpyHostToDevice, m_cuda_stream);
    }

    // Allocate GPU spatial grid buffers for contact (4 octaves, CSR + oversized list)
    ensureOctaveHashCapacity(target_facets_cap);

    // Allocate GPU Linear BVH buffers for contact
    if (target_facets_cap > m_allocated_bvh_facets) {
        if (m_d_bvh_morton_codes) cudaFree(m_d_bvh_morton_codes);
        if (m_d_bvh_morton_codes_alt) cudaFree(m_d_bvh_morton_codes_alt);
        if (m_d_bvh_sorted_facet_ids) cudaFree(m_d_bvh_sorted_facet_ids);
        if (m_d_bvh_facet_indices_in) cudaFree(m_d_bvh_facet_indices_in);
        if (m_d_bvh_nodes) cudaFree(m_d_bvh_nodes);
        if (m_d_bvh_leaf_parents) cudaFree(m_d_bvh_leaf_parents);
        if (m_d_bvh_flags) cudaFree(m_d_bvh_flags);

        m_allocated_bvh_facets = std::max(target_facets_cap + 4096, m_allocated_bvh_facets * 2);
        cudaMalloc(&m_d_bvh_morton_codes, sizeof(uint32_t) * m_allocated_bvh_facets);
        cudaMalloc(&m_d_bvh_morton_codes_alt, sizeof(uint32_t) * m_allocated_bvh_facets);
        cudaMalloc(&m_d_bvh_sorted_facet_ids, sizeof(int) * m_allocated_bvh_facets);
        cudaMalloc(&m_d_bvh_facet_indices_in, sizeof(int) * m_allocated_bvh_facets);
        cudaMalloc(&m_d_bvh_nodes, sizeof(LBVHNode3D<T>) * m_allocated_bvh_facets);
        cudaMalloc(&m_d_bvh_leaf_parents, sizeof(int) * m_allocated_bvh_facets);
        cudaMalloc(&m_d_bvh_flags, sizeof(int) * (m_allocated_bvh_facets + 1));

        // Query and allocate CUB RadixSort temp storage
        m_bvh_temp_storage_bytes = 0;
        cub::DeviceRadixSort::SortPairs(
            nullptr, m_bvh_temp_storage_bytes,
            m_d_bvh_morton_codes, m_d_bvh_morton_codes_alt,
            m_d_bvh_facet_indices_in, m_d_bvh_sorted_facet_ids,
            static_cast<int>(m_allocated_bvh_facets), 0, 32, m_cuda_stream
        );
        if (m_d_bvh_temp_storage) cudaFree(m_d_bvh_temp_storage);
        cudaMalloc(&m_d_bvh_temp_storage, m_bvh_temp_storage_bytes);
    }

    // Compute mesh bounding box and base cell size
    T bb_min_x = static_cast<T>(1.0e30f), bb_min_y = static_cast<T>(1.0e30f), bb_min_z = static_cast<T>(1.0e30f);
    T bb_max_x = static_cast<T>(-1.0e30f), bb_max_y = static_cast<T>(-1.0e30f), bb_max_z = static_cast<T>(-1.0e30f);
    for (const auto& node : nodes) {
        if (node.x[0] < bb_min_x) bb_min_x = node.x[0];
        if (node.x[0] > bb_max_x) bb_max_x = node.x[0];
        if (node.x[1] < bb_min_y) bb_min_y = node.x[1];
        if (node.x[1] > bb_max_y) bb_max_y = node.x[1];
        if (node.x[2] < bb_min_z) bb_min_z = node.x[2];
        if (node.x[2] > bb_max_z) bb_max_z = node.x[2];
    }
    if (bb_min_x < bb_max_x) {
        T pad_x = std::max(static_cast<T>(0.05f) * (bb_max_x - bb_min_x), static_cast<T>(0.01f));
        T pad_y = std::max(static_cast<T>(0.05f) * (bb_max_y - bb_min_y), static_cast<T>(0.01f));
        T pad_z = std::max(static_cast<T>(0.05f) * (bb_max_z - bb_min_z), static_cast<T>(0.01f));
        m_bbox_min[0] = bb_min_x - pad_x;
        m_bbox_max[0] = bb_max_x + pad_x;
        m_bbox_min[1] = bb_min_y - pad_y;
        m_bbox_max[1] = bb_max_y + pad_y;
        m_bbox_min[2] = bb_min_z - pad_z;
        m_bbox_max[2] = bb_max_z + pad_z;
    }

    T min_edge = static_cast<T>(1.0e30f);
    for (const auto& f : facets) {
        T dx = f.bbox_max[0] - f.bbox_min[0];
        T dy = f.bbox_max[1] - f.bbox_min[1];
        T dz = f.bbox_max[2] - f.bbox_min[2];
        T diag = std::max({dx, dy, dz});
        if (diag > static_cast<T>(1.0e-5f) && diag < min_edge) min_edge = diag;
    }
    if (min_edge >= static_cast<T>(1.0e29f) || min_edge <= static_cast<T>(0.0f)) {
        min_edge = static_cast<T>(0.005f);
    }
    m_base_cell_size = min_edge * static_cast<T>(1.2f);

    // Extract surface node indices on CPU and copy to GPU
    m_h_is_surf_node_scratch.assign(nodes.size(), 0);
    for (const auto& f : facets) {
        if (f.is_eroded) continue;
        for (int k = 0; k < 4; ++k) {
            if (f.node_ids[k] >= 0 && f.node_ids[k] < static_cast<int>(nodes.size())) {
                m_h_is_surf_node_scratch[f.node_ids[k]] = 1;
            }
        }
    }
    m_h_surf_nodes_scratch.clear();
    if (m_h_surf_nodes_scratch.capacity() < nodes.size()) {
        m_h_surf_nodes_scratch.reserve(nodes.size());
    }
    for (size_t i = 0; i < nodes.size(); ++i) {
        if (m_h_is_surf_node_scratch[i]) {
            m_h_surf_nodes_scratch.push_back(static_cast<int>(i));
        }
    }
    m_num_surface_nodes = m_h_surf_nodes_scratch.size();
    size_t target_nodes_cap = std::max(m_h_surf_nodes_scratch.size() * 2, nodes.size());
    if (target_nodes_cap > m_allocated_surface_nodes) {
        if (m_d_surface_nodes) cudaFree(m_d_surface_nodes);
        m_allocated_surface_nodes = std::max(target_nodes_cap + 1024, m_allocated_surface_nodes * 2);
        cudaMalloc(&m_d_surface_nodes, sizeof(int) * m_allocated_surface_nodes);
    }
    if (!m_h_surf_nodes_scratch.empty()) {
        cudaMemcpyAsync(m_d_surface_nodes, m_h_surf_nodes_scratch.data(), sizeof(int) * m_h_surf_nodes_scratch.size(), cudaMemcpyHostToDevice, m_cuda_stream);
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
    auto& trusses = const_cast<std::vector<FEMTrussElement3D<T>>&>(m_cpu_solver.getTrusses());
    auto& beams = const_cast<std::vector<FEMBeam3DElement<T>>&>(m_cpu_solver.getBeams());
    auto& rot_nodes = const_cast<std::vector<FEMNodeRotationalState3D<T>>&>(m_cpu_solver.getRotationalNodes());
    if (m_d_nodes && !nodes.empty()) {
        cudaMemcpyAsync(nodes.data(), m_d_nodes, sizeof(FEMNode3D<T>) * nodes.size(), cudaMemcpyDeviceToHost, m_cuda_stream);
    }
    if (m_d_elements && !elements.empty()) {
        cudaMemcpyAsync(elements.data(), m_d_elements, sizeof(FEMElement3D<T>) * elements.size(), cudaMemcpyDeviceToHost, m_cuda_stream);
    }
    if (m_d_trusses && !trusses.empty()) {
        cudaMemcpyAsync(trusses.data(), m_d_trusses, sizeof(FEMTrussElement3D<T>) * trusses.size(), cudaMemcpyDeviceToHost, m_cuda_stream);
    }
    if (m_d_beams && !beams.empty()) {
        cudaMemcpyAsync(beams.data(), m_d_beams, sizeof(FEMBeam3DElement<T>) * beams.size(), cudaMemcpyDeviceToHost, m_cuda_stream);
    }
    if (m_d_rot_nodes && !rot_nodes.empty()) {
        cudaMemcpyAsync(rot_nodes.data(), m_d_rot_nodes, sizeof(FEMNodeRotationalState3D<T>) * rot_nodes.size(), cudaMemcpyDeviceToHost, m_cuda_stream);
    }
    if (m_d_gp_history) {
        auto& gp_hist = const_cast<std::vector<FEMGaussPointHistory3D<T>>&>(m_cpu_solver.getGaussPointHistory());
        if (!gp_hist.empty()) {
            cudaMemcpyAsync(gp_hist.data(), m_d_gp_history, sizeof(FEMGaussPointHistory3D<T>) * gp_hist.size(), cudaMemcpyDeviceToHost, m_cuda_stream);
        }
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
static void flush_fem_debris_to_cuda_mpm(
    FEMSolver3D<T>& cpu_solver,
    MPMSolver3DCUDA* cuda_mpm,
    size_t& synced_debris_count,
    int& debris_mat_offset
);

template <typename T>
void FEMSolver3DCUDA<T>::syncTopologyAfterSplitOrErosion(bool did_split) {
    auto& nodes = m_cpu_solver.getNodes();
    auto& elements = m_cpu_solver.getElements();
    if (nodes.empty() || elements.empty()) return;

    // Download only nodes and elements (skip trusses, beams, rot_nodes, gp_history, and CPU energy/maxima)
    if (m_d_nodes) {
        cudaMemcpyAsync(nodes.data(), m_d_nodes, sizeof(FEMNode3D<T>) * nodes.size(), cudaMemcpyDeviceToHost, m_cuda_stream);
    }
    if (m_d_elements) {
        cudaMemcpyAsync(elements.data(), m_d_elements, sizeof(FEMElement3D<T>) * elements.size(), cudaMemcpyDeviceToHost, m_cuda_stream);
    }
    cudaStreamSynchronize(m_cuda_stream);

    if (did_split) {
        m_cpu_solver.splitFracturedElementNodes();
        m_cpu_solver.processErodedElementsToMPM();
        m_cpu_solver.updateNodeErosionStatus();
        m_cpu_solver.invalidateSurfaceFacets();
        const auto& new_facets = m_cpu_solver.getSurfaceFacets();

        if (nodes.size() > m_allocated_nodes) {
            if (m_d_nodes) cudaFree(m_d_nodes);
            if (m_d_mpm_impulse_accum) cudaFree(m_d_mpm_impulse_accum);
            if (m_d_node_part_id) cudaFree(m_d_node_part_id);
            if (m_d_node_normals) cudaFree(m_d_node_normals);
            if (m_d_node_active_count) cudaFree(m_d_node_active_count);
            if (m_d_nodal_vol_cur) cudaFree(m_d_nodal_vol_cur);
            if (m_d_nodal_vol_ref) cudaFree(m_d_nodal_vol_ref);
            if (m_d_nodal_dvol_dt) cudaFree(m_d_nodal_dvol_dt);
            m_allocated_nodes = std::max(nodes.size() * 2, m_allocated_nodes * 2 + 1024);
            cudaMalloc(&m_d_nodes, sizeof(FEMNode3D<T>) * m_allocated_nodes);
            cudaMalloc(&m_d_mpm_impulse_accum, sizeof(T) * m_allocated_nodes * 3);
            cudaMalloc(&m_d_node_part_id, sizeof(int) * m_allocated_nodes);
            cudaMalloc(&m_d_node_normals, sizeof(T) * m_allocated_nodes * 3);
            cudaMalloc(&m_d_node_active_count, sizeof(int) * m_allocated_nodes);
            cudaMalloc(&m_d_nodal_vol_cur, sizeof(T) * m_allocated_nodes);
            cudaMalloc(&m_d_nodal_vol_ref, sizeof(T) * m_allocated_nodes);
            cudaMalloc(&m_d_nodal_dvol_dt, sizeof(T) * m_allocated_nodes);
            cudaMemsetAsync(m_d_mpm_impulse_accum, 0, sizeof(T) * m_allocated_nodes * 3, m_cuda_stream);
        }

        cudaMemcpyAsync(m_d_nodes, nodes.data(), sizeof(FEMNode3D<T>) * nodes.size(), cudaMemcpyHostToDevice, m_cuda_stream);
        cudaMemcpyAsync(m_d_elements, elements.data(), sizeof(FEMElement3D<T>) * elements.size(), cudaMemcpyHostToDevice, m_cuda_stream);

        const auto& face_neighbors = m_cpu_solver.getFaceNeighbors();
        if (m_d_face_neighbors && face_neighbors.size() >= elements.size() * 6) {
            cudaMemcpyAsync(m_d_face_neighbors, face_neighbors.data(), sizeof(int) * elements.size() * 6, cudaMemcpyHostToDevice, m_cuda_stream);
        }

        m_h_node_part_scratch.assign(nodes.size(), -1);
        for (const auto& elem : elements) {
            if (elem.is_eroded) continue;
            for (int k = 0; k < 8; ++k) {
                int nid = elem.node_ids[k];
                if (nid >= 0 && nid < static_cast<int>(nodes.size())) {
                    m_h_node_part_scratch[nid] = elem.part_id;
                }
            }
        }
        cudaMemcpyAsync(m_d_node_part_id, m_h_node_part_scratch.data(), sizeof(int) * nodes.size(), cudaMemcpyHostToDevice, m_cuda_stream);

        m_num_surface_facets = new_facets.size();
        size_t target_facets_cap = std::max(new_facets.size() * 2, elements.size() * 3);
        if (target_facets_cap > m_allocated_facets) {
            if (m_d_facets) cudaFree(m_d_facets);
            m_allocated_facets = std::max(target_facets_cap + 4096, m_allocated_facets * 2);
            cudaMalloc(&m_d_facets, sizeof(FEMFacet3D<T>) * m_allocated_facets);
            ensureOctaveHashCapacity(m_allocated_facets);
        }
        if (target_facets_cap > m_allocated_bvh_facets) {
            if (m_d_bvh_morton_codes) cudaFree(m_d_bvh_morton_codes);
            if (m_d_bvh_morton_codes_alt) cudaFree(m_d_bvh_morton_codes_alt);
            if (m_d_bvh_sorted_facet_ids) cudaFree(m_d_bvh_sorted_facet_ids);
            if (m_d_bvh_facet_indices_in) cudaFree(m_d_bvh_facet_indices_in);
            if (m_d_bvh_nodes) cudaFree(m_d_bvh_nodes);
            if (m_d_bvh_leaf_parents) cudaFree(m_d_bvh_leaf_parents);
            if (m_d_bvh_flags) cudaFree(m_d_bvh_flags);

            m_allocated_bvh_facets = std::max(target_facets_cap + 4096, m_allocated_bvh_facets * 2);
            cudaMalloc(&m_d_bvh_morton_codes, sizeof(uint32_t) * m_allocated_bvh_facets);
            cudaMalloc(&m_d_bvh_morton_codes_alt, sizeof(uint32_t) * m_allocated_bvh_facets);
            cudaMalloc(&m_d_bvh_sorted_facet_ids, sizeof(int) * m_allocated_bvh_facets);
            cudaMalloc(&m_d_bvh_facet_indices_in, sizeof(int) * m_allocated_bvh_facets);
            cudaMalloc(&m_d_bvh_nodes, sizeof(LBVHNode3D<T>) * m_allocated_bvh_facets);
            cudaMalloc(&m_d_bvh_leaf_parents, sizeof(int) * m_allocated_bvh_facets);
            cudaMalloc(&m_d_bvh_flags, sizeof(int) * (m_allocated_bvh_facets + 1));

            m_bvh_temp_storage_bytes = 0;
            cub::DeviceRadixSort::SortPairs(
                nullptr, m_bvh_temp_storage_bytes,
                m_d_bvh_morton_codes, m_d_bvh_morton_codes_alt,
                m_d_bvh_facet_indices_in, m_d_bvh_sorted_facet_ids,
                static_cast<int>(m_allocated_bvh_facets), 0, 32, m_cuda_stream
            );
            if (m_d_bvh_temp_storage) cudaFree(m_d_bvh_temp_storage);
            cudaMalloc(&m_d_bvh_temp_storage, m_bvh_temp_storage_bytes);
        }
        if (!new_facets.empty()) {
            cudaMemcpyAsync(m_d_facets, new_facets.data(), sizeof(FEMFacet3D<T>) * new_facets.size(), cudaMemcpyHostToDevice, m_cuda_stream);
        }

        // Refresh bounding box and surface nodes
        T bb_min_x = static_cast<T>(1.0e30f), bb_min_y = static_cast<T>(1.0e30f), bb_min_z = static_cast<T>(1.0e30f);
        T bb_max_x = static_cast<T>(-1.0e30f), bb_max_y = static_cast<T>(-1.0e30f), bb_max_z = static_cast<T>(-1.0e30f);
        for (const auto& node : nodes) {
            if (node.is_eroded) continue;
            if (node.x[0] < bb_min_x) bb_min_x = node.x[0];
            if (node.x[0] > bb_max_x) bb_max_x = node.x[0];
            if (node.x[1] < bb_min_y) bb_min_y = node.x[1];
            if (node.x[1] > bb_max_y) bb_max_y = node.x[1];
            if (node.x[2] < bb_min_z) bb_min_z = node.x[2];
            if (node.x[2] > bb_max_z) bb_max_z = node.x[2];
        }
        if (bb_min_x < bb_max_x) {
            T pad_x = std::max(static_cast<T>(0.05f) * (bb_max_x - bb_min_x), static_cast<T>(0.01f));
            T pad_y = std::max(static_cast<T>(0.05f) * (bb_max_y - bb_min_y), static_cast<T>(0.01f));
            T pad_z = std::max(static_cast<T>(0.05f) * (bb_max_z - bb_min_z), static_cast<T>(0.01f));
            m_bbox_min[0] = bb_min_x - pad_x; m_bbox_max[0] = bb_max_x + pad_x;
            m_bbox_min[1] = bb_min_y - pad_y; m_bbox_max[1] = bb_max_y + pad_y;
            m_bbox_min[2] = bb_min_z - pad_z; m_bbox_max[2] = bb_max_z + pad_z;
        }

        m_h_is_surf_node_scratch.assign(nodes.size(), 0);
        for (const auto& f : new_facets) {
            if (f.is_eroded) continue;
            for (int k = 0; k < 4; ++k) {
                if (f.node_ids[k] >= 0 && f.node_ids[k] < static_cast<int>(nodes.size())) {
                    m_h_is_surf_node_scratch[f.node_ids[k]] = 1;
                }
            }
        }
        m_h_surf_nodes_scratch.clear();
        if (m_h_surf_nodes_scratch.capacity() < nodes.size()) {
            m_h_surf_nodes_scratch.reserve(nodes.size());
        }
        for (size_t i = 0; i < nodes.size(); ++i) {
            if (m_h_is_surf_node_scratch[i]) {
                m_h_surf_nodes_scratch.push_back(static_cast<int>(i));
            }
        }
        m_num_surface_nodes = m_h_surf_nodes_scratch.size();
        size_t target_nodes_cap = std::max(m_h_surf_nodes_scratch.size() * 2, nodes.size());
        if (target_nodes_cap > m_allocated_surface_nodes) {
            if (m_d_surface_nodes) cudaFree(m_d_surface_nodes);
            m_allocated_surface_nodes = std::max(target_nodes_cap + 1024, m_allocated_surface_nodes * 2);
            cudaMalloc(&m_d_surface_nodes, sizeof(int) * m_allocated_surface_nodes);
        }
        if (!m_h_surf_nodes_scratch.empty()) {
            cudaMemcpyAsync(m_d_surface_nodes, m_h_surf_nodes_scratch.data(), sizeof(int) * m_h_surf_nodes_scratch.size(), cudaMemcpyHostToDevice, m_cuda_stream);
        }

        flush_fem_debris_to_cuda_mpm<T>(m_cpu_solver, m_cuda_mpm_solver, m_synced_debris_particle_count, m_debris_mat_offset);
        cudaStreamSynchronize(m_cuda_stream);
    } else {
        const int num_nodes = static_cast<int>(nodes.size());
        const int num_elements = static_cast<int>(elements.size());
        const int num_trusses = static_cast<int>(m_cpu_solver.getTrusses().size());
        const int num_beams = static_cast<int>(m_cpu_solver.getBeams().size());

        m_cpu_solver.processErodedElementsToMPM();
        cudaMemcpyAsync(m_d_elements, elements.data(), sizeof(FEMElement3D<T>) * elements.size(), cudaMemcpyHostToDevice, m_cuda_stream);
        flush_fem_debris_to_cuda_mpm<T>(m_cpu_solver, m_cuda_mpm_solver, m_synced_debris_particle_count, m_debris_mat_offset);
        launch_fem_update_orphan_nodes_erosion_kernel_3d<T>(
            m_d_nodes, num_nodes, m_d_elements, num_elements,
            m_d_trusses, num_trusses, m_d_beams, num_beams,
            m_d_node_active_count, m_cuda_stream
        );
        m_cpu_solver.invalidateSurfaceFacets();
        const auto& new_facets = m_cpu_solver.getSurfaceFacets();

        m_num_surface_facets = new_facets.size();
        if (new_facets.size() > m_allocated_facets) {
            if (m_d_facets) cudaFree(m_d_facets);
            m_allocated_facets = std::max(new_facets.size() * 2, m_allocated_facets * 2);
            cudaMalloc(&m_d_facets, sizeof(FEMFacet3D<T>) * m_allocated_facets);
            ensureOctaveHashCapacity(m_allocated_facets);
        }
        if (!new_facets.empty()) {
            cudaMemcpyAsync(m_d_facets, new_facets.data(), sizeof(FEMFacet3D<T>) * new_facets.size(), cudaMemcpyHostToDevice, m_cuda_stream);
        }

        m_h_is_surf_node_scratch.assign(nodes.size(), 0);
        for (const auto& f : new_facets) {
            if (f.is_eroded) continue;
            for (int k = 0; k < 4; ++k) {
                if (f.node_ids[k] >= 0 && f.node_ids[k] < static_cast<int>(nodes.size())) {
                    m_h_is_surf_node_scratch[f.node_ids[k]] = 1;
                }
            }
        }
        m_h_surf_nodes_scratch.clear();
        if (m_h_surf_nodes_scratch.capacity() < nodes.size()) {
            m_h_surf_nodes_scratch.reserve(nodes.size());
        }
        for (size_t i = 0; i < nodes.size(); ++i) {
            if (m_h_is_surf_node_scratch[i]) {
                m_h_surf_nodes_scratch.push_back(static_cast<int>(i));
            }
        }
        m_num_surface_nodes = m_h_surf_nodes_scratch.size();
        if (m_num_surface_nodes > m_allocated_surface_nodes) {
            if (m_d_surface_nodes) cudaFree(m_d_surface_nodes);
            m_allocated_surface_nodes = std::max(m_num_surface_nodes * 2, m_allocated_surface_nodes * 2);
            cudaMalloc(&m_d_surface_nodes, sizeof(int) * m_allocated_surface_nodes);
        }
        if (!m_h_surf_nodes_scratch.empty()) {
            cudaMemcpyAsync(m_d_surface_nodes, m_h_surf_nodes_scratch.data(), sizeof(int) * m_h_surf_nodes_scratch.size(), cudaMemcpyHostToDevice, m_cuda_stream);
        }
        cudaStreamSynchronize(m_cuda_stream);
    }

    m_topology_dirty = false;
}

template <typename T>
void FEMSolver3DCUDA<T>::extractTelemetry(std::vector<float>& h_node_data, std::vector<float>& h_facet_data) const {
    size_t num_nodes = m_cpu_solver.getNodes().size();
    size_t num_facets = m_num_surface_facets;
    size_t num_elements = m_cpu_solver.getElements().size();

    if (num_nodes == 0) {
        h_node_data.clear();
        h_facet_data.clear();
        return;
    }

    if (!m_d_nodes) {
        const_cast<FEMSolver3DCUDA<T>*>(this)->syncToDevice();
        num_facets = m_num_surface_facets;
        num_elements = m_cpu_solver.getElements().size();
    }

    if (!m_d_nodes) {
        h_node_data.clear();
        h_facet_data.clear();
        return;
    }

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

    float max_vm = 0.0f;
    float max_ep = 0.0f;
    for (size_t f = 0; f < num_facets; ++f) {
        float vm = h_facet_data[f * 8 + 4];
        float ep = h_facet_data[f * 8 + 5];
        if (vm > max_vm) max_vm = vm;
        if (ep > max_ep) max_ep = ep;
    }

    // Append 1D rebar trusses and beams for 3D viewport plotting
    const auto& trusses = m_cpu_solver.getTrusses();
    const auto& beams = m_cpu_solver.getBeams();
    size_t n_trusses = trusses.size();
    size_t n_beams = beams.size();

    if (m_d_trusses && n_trusses > 0) {
        auto& trusses_mut = const_cast<std::vector<FEMTrussElement3D<T>>&>(m_cpu_solver.getTrusses());
        cudaMemcpyAsync(trusses_mut.data(), m_d_trusses, sizeof(FEMTrussElement3D<T>) * n_trusses, cudaMemcpyDeviceToHost, m_cuda_stream);
    }
    if (m_d_beams && n_beams > 0) {
        auto& beams_mut = const_cast<std::vector<FEMBeam3DElement<T>>&>(m_cpu_solver.getBeams());
        cudaMemcpyAsync(beams_mut.data(), m_d_beams, sizeof(FEMBeam3DElement<T>) * n_beams, cudaMemcpyDeviceToHost, m_cuda_stream);
    }
    if (n_trusses > 0 || n_beams > 0) {
        cudaStreamSynchronize(m_cuda_stream);
    }

    if (n_trusses > 0 || n_beams > 0) {
        size_t prev_facets = num_facets;
        h_facet_data.resize((prev_facets + n_trusses + n_beams) * 8);
        for (size_t t = 0; t < n_trusses; ++t) {
            const auto& tr = trusses[t];
            if (tr.is_eroded) {
                h_facet_data[(prev_facets + t) * 8 + 0] = -1.0f;
                h_facet_data[(prev_facets + t) * 8 + 1] = -1.0f;
                h_facet_data[(prev_facets + t) * 8 + 2] = -1.0f;
                h_facet_data[(prev_facets + t) * 8 + 3] = -1.0f;
                h_facet_data[(prev_facets + t) * 8 + 4] = 0.0f;
                h_facet_data[(prev_facets + t) * 8 + 5] = 0.0f;
                h_facet_data[(prev_facets + t) * 8 + 6] = 0.0f;
                h_facet_data[(prev_facets + t) * 8 + 7] = 1.0f;
            } else {
                h_facet_data[(prev_facets + t) * 8 + 0] = static_cast<float>(tr.node_ids[0]);
                h_facet_data[(prev_facets + t) * 8 + 1] = static_cast<float>(tr.node_ids[1]);
                h_facet_data[(prev_facets + t) * 8 + 2] = -1.0f;
                h_facet_data[(prev_facets + t) * 8 + 3] = -1.0f;
                h_facet_data[(prev_facets + t) * 8 + 4] = static_cast<float>(std::abs(tr.sigma));
                h_facet_data[(prev_facets + t) * 8 + 5] = static_cast<float>(tr.ep_bar);
                h_facet_data[(prev_facets + t) * 8 + 6] = static_cast<float>(std::abs(tr.sigma * tr.A));
                h_facet_data[(prev_facets + t) * 8 + 7] = 0.0f;
            }
        }
        size_t beam_offset = prev_facets + n_trusses;
        for (size_t b = 0; b < n_beams; ++b) {
            const auto& bm = beams[b];
            if (bm.is_eroded) {
                h_facet_data[(beam_offset + b) * 8 + 0] = -1.0f;
                h_facet_data[(beam_offset + b) * 8 + 1] = -1.0f;
                h_facet_data[(beam_offset + b) * 8 + 2] = -1.0f;
                h_facet_data[(beam_offset + b) * 8 + 3] = -1.0f;
                h_facet_data[(beam_offset + b) * 8 + 4] = 0.0f;
                h_facet_data[(beam_offset + b) * 8 + 5] = 0.0f;
                h_facet_data[(beam_offset + b) * 8 + 6] = 0.0f;
                h_facet_data[(beam_offset + b) * 8 + 7] = 1.0f;
            } else {
                double A_safe = bm.A > static_cast<T>(1.0e-12f) ? static_cast<double>(bm.A) : 1.0e-6;
                double I2_safe = bm.I2 > static_cast<T>(1.0e-16f) ? static_cast<double>(bm.I2) : 1.0e-12;
                double I3_safe = bm.I3 > static_cast<T>(1.0e-16f) ? static_cast<double>(bm.I3) : I2_safe;
                double d_safe = bm.d > static_cast<T>(1.0e-6f) ? static_cast<double>(bm.d) : 0.01;
                double W2 = I2_safe / (0.5 * d_safe);
                double W3 = I3_safe / (0.5 * d_safe);
                double M_bend = std::hypot(static_cast<double>(bm.M2) / W2, static_cast<double>(bm.M3) / W3);
                double M_res = std::hypot(static_cast<double>(bm.M2), static_cast<double>(bm.M3));
                float sig = static_cast<float>(std::abs(static_cast<double>(bm.N)) / A_safe + M_bend);
                float moment = static_cast<float>(M_res);
                h_facet_data[(beam_offset + b) * 8 + 0] = static_cast<float>(bm.node_ids[0]);
                h_facet_data[(beam_offset + b) * 8 + 1] = static_cast<float>(bm.node_ids[1]);
                h_facet_data[(beam_offset + b) * 8 + 2] = -1.0f;
                h_facet_data[(beam_offset + b) * 8 + 3] = -1.0f;
                h_facet_data[(beam_offset + b) * 8 + 4] = sig;
                h_facet_data[(beam_offset + b) * 8 + 5] = static_cast<float>(bm.ep_bar);
                h_facet_data[(beam_offset + b) * 8 + 6] = moment;
                h_facet_data[(beam_offset + b) * 8 + 7] = 0.0f;
            }
        }
    }
    m_last_vm_max = static_cast<T>(max_vm);
    m_last_ep_max = static_cast<T>(max_ep);

    // Sync MPM debris particles from GPU to CPU if active
    if (m_cuda_mpm_solver && m_cuda_mpm_solver->getParticleCount() > 0) {
        m_cuda_mpm_solver->syncParticlesToHost();
        if (m_cpu_solver.getMPMSolver()) {
            m_cpu_solver.getMPMSolver()->getParticles() = m_cuda_mpm_solver->getParticles();
            m_synced_debris_particle_count = m_cpu_solver.getMPMSolver()->getParticles().size();
        }
    }
}

template <typename T>
__global__ void fem_rot_nodal_half_step_kernel_3d_device(
    FEMNodeRotationalState3D<T>* d_rot_nodes,
    int num_rot_nodes,
    T dt
) {
    int r = blockIdx.x * blockDim.x + threadIdx.x;
    if (r >= num_rot_nodes) return;

    FEMNodeRotationalState3D<T>& rn = d_rot_nodes[r];
    for (int c = 0; c < 3; ++c) {
        if (rn.is_fixed[c]) {
            rn.omega[c] = static_cast<T>(0.0f);
            rn.alpha[c] = static_cast<T>(0.0f);
        } else if (rn.I_rot > static_cast<T>(1.0e-12f)) {
            rn.omega[c] += static_cast<T>(0.5f) * rn.alpha[c] * dt;
        }
        rn.m_int[c] = static_cast<T>(0.0f);
    }
}

template <typename T>
__global__ void fem_rot_nodal_full_step_kernel_3d_device(
    FEMNodeRotationalState3D<T>* d_rot_nodes,
    int num_rot_nodes,
    T dt
) {
    int r = blockIdx.x * blockDim.x + threadIdx.x;
    if (r >= num_rot_nodes) return;

    FEMNodeRotationalState3D<T>& rn = d_rot_nodes[r];
    if (rn.I_rot > static_cast<T>(1.0e-12f)) {
        T invI = static_cast<T>(1.0f) / rn.I_rot;
        for (int c = 0; c < 3; ++c) {
            if (rn.is_fixed[c]) {
                rn.omega[c] = static_cast<T>(0.0f);
                rn.alpha[c] = static_cast<T>(0.0f);
            } else {
                rn.alpha[c] = (rn.m_ext[c] - rn.m_int[c]) * invI;
                rn.omega[c] += static_cast<T>(0.5f) * rn.alpha[c] * dt;
            }
        }
    }
}

template <typename T>
static void flush_fem_debris_to_cuda_mpm(
    FEMSolver3D<T>& cpu_solver,
    MPMSolver3DCUDA* cuda_mpm,
    size_t& synced_debris_count,
    int& debris_mat_offset
) {
    if (!cuda_mpm || !cpu_solver.getMPMSolver()) return;
    const auto& cpu_particles = cpu_solver.getMPMSolver()->getParticles();
    if (cpu_particles.size() <= synced_debris_count) return;

    std::vector<MPMParticle3D> new_pts(cpu_particles.begin() + synced_debris_count, cpu_particles.end());
    auto& mpm_mats = cuda_mpm->getMaterialTables();
    const auto& fem_mats = cpu_solver.getMaterialTables();
    if (!fem_mats.empty()) {
        if (mpm_mats.empty()) {
            mpm_mats = fem_mats;
            debris_mat_offset = 0;
            cuda_mpm->uploadMaterialTableToDevice();
        } else if (debris_mat_offset < 0) {
            debris_mat_offset = static_cast<int>(mpm_mats.size());
            mpm_mats.insert(mpm_mats.end(), fem_mats.begin(), fem_mats.end());
            cuda_mpm->uploadMaterialTableToDevice();
        }
        if (debris_mat_offset > 0) {
            for (auto& pt : new_pts) {
                if (pt.object_id >= 0) pt.object_id += debris_mat_offset;
                if (pt.material_id >= 0) pt.material_id += debris_mat_offset;
            }
        }
    }
    cuda_mpm->addParticlesDirect(new_pts);
    synced_debris_count = cpu_particles.size();
}

template <typename T>
void FEMSolver3DCUDA<T>::buildOctaveHashOnDevice() {
    if (m_num_surface_facets == 0 || !m_d_facets || !m_d_cell_counts || !m_d_cell_offsets ||
        !m_d_cell_facet_ids || !m_d_hash_scan_temp || m_hash_scan_temp_bytes == 0 ||
        !m_d_oversized_count || m_spatial_grid_capacity == 0) {
        return;
    }
    const int num_facets = static_cast<int>(m_num_surface_facets);
    const uint32_t table_size = static_cast<uint32_t>(m_spatial_grid_capacity);
    const int total_buckets = 4 * static_cast<int>(table_size);
    const int block_size = 256;
    const int facet_grid_size = (num_facets + block_size - 1) / block_size;

    cudaMemsetAsync(m_d_cell_counts, 0, sizeof(int) * total_buckets, m_cuda_stream);
    cudaMemsetAsync(m_d_oversized_count, 0, sizeof(int), m_cuda_stream);
    fem_count_octave_hash_grid_kernel_3d_device<T><<<facet_grid_size, block_size, 0, m_cuda_stream>>>(
        m_d_facets, num_facets, m_base_cell_size, m_d_cell_counts,
        m_d_oversized_facets, m_d_oversized_count, static_cast<int>(m_allocated_oversized_facets), table_size
    );

    size_t scan_bytes = m_hash_scan_temp_bytes;
    cub::DeviceScan::ExclusiveSum(
        m_d_hash_scan_temp, scan_bytes,
        m_d_cell_counts, m_d_cell_offsets,
        total_buckets, m_cuda_stream
    );

    cudaMemsetAsync(m_d_cell_counts, 0, sizeof(int) * total_buckets, m_cuda_stream);
    fem_scatter_octave_hash_grid_kernel_3d_device<T><<<facet_grid_size, block_size, 0, m_cuda_stream>>>(
        m_d_facets, num_facets, m_base_cell_size, m_d_cell_counts, m_d_cell_offsets,
        m_d_cell_facet_ids, static_cast<int>(m_allocated_hash_entries), table_size
    );
}

template <typename T>
void FEMSolver3DCUDA<T>::stepWithDt(T dt) {
    auto& nodes = m_cpu_solver.getNodes();
    auto& elements = m_cpu_solver.getElements();
    const auto& trusses = m_cpu_solver.getTrusses();
    const auto& beams = m_cpu_solver.getBeams();
    if (nodes.empty() || (elements.empty() && trusses.empty() && beams.empty())) return;

    if (!m_d_nodes || (!elements.empty() && !m_d_elements) || (!trusses.empty() && !m_d_trusses) || (!beams.empty() && !m_d_beams)) {
        syncToDevice();
    }

    m_last_dt = dt;
    m_sim_time += dt;
    m_step_count++;
    m_cpu_solver.setSimTime(m_sim_time);

    // Fire any delayed detonators whose delay has been reached
    bool det_fired = false;
    for (auto& det : m_cpu_solver.getDetonators()) {
        if (!det.fired && m_sim_time >= static_cast<T>(det.time_delay)) {
            if (!det_fired) {
                cudaMemcpyAsync(nodes.data(), m_d_nodes, sizeof(FEMNode3D<T>) * nodes.size(), cudaMemcpyDeviceToHost, m_cuda_stream);
                if (!elements.empty()) {
                    cudaMemcpyAsync(elements.data(), m_d_elements, sizeof(FEMElement3D<T>) * elements.size(), cudaMemcpyDeviceToHost, m_cuda_stream);
                }
                cudaStreamSynchronize(m_cuda_stream);
                det_fired = true;
            }
            m_cpu_solver.igniteDetonator(static_cast<T>(det.x), static_cast<T>(det.y), static_cast<T>(det.z),
                                         static_cast<T>(det.radius), det.target_part_id, static_cast<T>(det.time_delay));
            det.fired = true;
        }
    }
    if (det_fired && !elements.empty()) {
        cudaMemcpyAsync(m_d_elements, elements.data(), sizeof(FEMElement3D<T>) * elements.size(), cudaMemcpyHostToDevice, m_cuda_stream);
    }

    int num_nodes = static_cast<int>(nodes.size());
    int num_elements = static_cast<int>(elements.size());
    int num_trusses = static_cast<int>(trusses.size());
    int num_beams = static_cast<int>(beams.size());
    int num_rot_nodes = static_cast<int>(m_cpu_solver.getRotationalNodes().size());

    // 1. Half-Step Velocity & Nodal Position Update on GPU (2nd-Order Velocity-Verlet)
    launch_fem_nodal_half_step_kernel_3d<T>(m_d_nodes, num_nodes, dt, m_cuda_stream);
    if (m_d_rot_nodes && num_rot_nodes > 0) {
        int block_size = 256;
        int rot_grid = (num_rot_nodes + block_size - 1) / block_size;
        fem_rot_nodal_half_step_kernel_3d_device<T><<<rot_grid, block_size, 0, m_cuda_stream>>>(
            m_d_rot_nodes, num_rot_nodes, dt
        );
    }

    // 2. Penalty Surface Contact Handling using GPU Spatial Grid (100% on GPU!)
    const bool need_debris_contact = (m_cuda_mpm_solver && m_cuda_mpm_solver->getParticleCount() > 0 &&
                                      m_cpu_solver.getContactPenaltyScale() > static_cast<T>(0.0f));
    if (m_cpu_solver.getContactPenaltyScale() > static_cast<T>(0.0f) &&
        m_num_surface_facets > 0 && (m_num_surface_nodes > 0 || need_debris_contact)) {
        launch_fem_update_surface_facets_kernel_3d<T>(
            m_d_nodes, num_nodes, m_d_elements, num_elements, m_d_facets, static_cast<int>(m_num_surface_facets), m_d_node_normals, m_cuda_stream
        );

        if (m_num_surface_nodes > 0) {
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
                m_cpu_solver.getContactSearchMethod(),
                m_d_cell_counts,
                m_d_cell_offsets,
                m_d_cell_facet_ids,
                static_cast<int>(m_allocated_hash_entries),
                m_d_oversized_facets,
                m_d_oversized_count,
                static_cast<int>(m_allocated_oversized_facets),
                m_d_hash_scan_temp,
                m_hash_scan_temp_bytes,
                static_cast<uint32_t>(m_spatial_grid_capacity),
                m_base_cell_size,
                m_d_bvh_morton_codes,
                m_d_bvh_morton_codes_alt,
                m_d_bvh_sorted_facet_ids,
                m_d_bvh_facet_indices_in,
                m_d_bvh_nodes,
                m_d_bvh_leaf_parents,
                m_d_bvh_flags,
                m_d_bvh_temp_storage,
                m_bvh_temp_storage_bytes,
                m_bbox_min[0], m_bbox_max[0],
                m_bbox_min[1], m_bbox_max[1],
                m_bbox_min[2], m_bbox_max[2],
                m_cpu_solver.getContactPenaltyScale(),
                m_cpu_solver.getFrictionStatic(),
                m_cpu_solver.getFrictionKinetic(),
                m_cpu_solver.getContactDamping(),
                dt,
                m_cuda_stream
            );
        }

        // 2b. Penalty MPM Debris-to-FEM Facet & Rebar Contact on GPU
        if (m_has_pending_mpm_impulse && m_d_mpm_impulse_accum) {
            T inv_dt = (dt > static_cast<T>(1.0e-15f)) ? (static_cast<T>(1.0f) / dt) : static_cast<T>(0.0f);
            int block_size = 256;
            int grid_size = (num_nodes + block_size - 1) / block_size;
            fem_flush_mpm_impulse_kernel_3d_device<T><<<grid_size, block_size, 0, m_cuda_stream>>>(
                m_d_nodes, num_nodes, m_d_mpm_impulse_accum, inv_dt
            );
            m_has_pending_mpm_impulse = false;
        } else if (need_debris_contact) {
            if (m_num_surface_nodes == 0 || m_cpu_solver.getContactSearchMethod() == FEMContactSearchMethod::LinearBVH) {
                buildOctaveHashOnDevice();
            }
            launch_fem_mpm_debris_contact_kernel_3d<T>(
                m_cuda_mpm_solver->getDeviceParticlesSoA(),
                static_cast<int>(m_cuda_mpm_solver->getParticleCount()),
                m_d_nodes, num_nodes,
                m_d_elements, num_elements,
                m_d_facets, static_cast<int>(m_num_surface_facets),
                m_d_trusses, num_trusses,
                m_d_beams, num_beams,
                m_d_materials,
                m_d_cell_counts,
                m_d_cell_offsets,
                m_d_cell_facet_ids,
                static_cast<int>(m_allocated_hash_entries),
                m_d_oversized_facets,
                m_d_oversized_count,
                static_cast<int>(m_allocated_oversized_facets),
                static_cast<uint32_t>(m_spatial_grid_capacity),
                m_base_cell_size,
                m_cpu_solver.getContactPenaltyScale(),
                m_cpu_solver.getFrictionStatic(),
                m_cpu_solver.getFrictionKinetic(),
                m_cpu_solver.getContactDamping(),
                dt,
                nullptr,
                false,
                m_cuda_stream
            );
        }
    } else {
        int block_size = 256;
        int grid_size = (num_nodes + block_size - 1) / block_size;
        fem_reset_nodal_contact_forces_kernel_device<T><<<grid_size, block_size, 0, m_cuda_stream>>>(
            m_d_nodes, num_nodes, m_d_node_normals
        );
        if (m_cpu_solver.getLysmerParams().enabled && m_num_surface_facets > 0) {
            launch_fem_update_surface_facets_kernel_3d<T>(
                m_d_nodes, num_nodes, m_d_elements, num_elements, m_d_facets, static_cast<int>(m_num_surface_facets), m_d_node_normals, m_cuda_stream
            );
        }
        if (m_has_pending_mpm_impulse && m_d_mpm_impulse_accum) {
            if (m_cpu_solver.getContactPenaltyScale() > static_cast<T>(0.0f)) {
                T inv_dt = (dt > static_cast<T>(1.0e-15f)) ? (static_cast<T>(1.0f) / dt) : static_cast<T>(0.0f);
                fem_flush_mpm_impulse_kernel_3d_device<T><<<grid_size, block_size, 0, m_cuda_stream>>>(
                    m_d_nodes, num_nodes, m_d_mpm_impulse_accum, inv_dt
                );
            } else if (m_allocated_nodes > 0) {
                cudaMemsetAsync(m_d_mpm_impulse_accum, 0, sizeof(T) * m_allocated_nodes * 3, m_cuda_stream);
            }
            m_has_pending_mpm_impulse = false;
        } else if (need_debris_contact && (num_trusses > 0 || num_beams > 0)) {
            launch_fem_mpm_debris_contact_kernel_3d<T>(
                m_cuda_mpm_solver->getDeviceParticlesSoA(),
                static_cast<int>(m_cuda_mpm_solver->getParticleCount()),
                m_d_nodes, num_nodes,
                m_d_elements, num_elements,
                m_d_facets, static_cast<int>(m_num_surface_facets),
                m_d_trusses, num_trusses,
                m_d_beams, num_beams,
                m_d_materials,
                nullptr, nullptr, nullptr, 0, nullptr, nullptr, 0, 0, static_cast<T>(0.0f),
                m_cpu_solver.getContactPenaltyScale(),
                m_cpu_solver.getFrictionStatic(),
                m_cpu_solver.getFrictionKinetic(),
                m_cpu_solver.getContactDamping(),
                dt,
                nullptr,
                false,
                m_cuda_stream
            );
        }
    }

    // 3. Reset nodal internal forces on GPU
    launch_fem_reset_nodal_forces_kernel_3d<T>(m_d_nodes, num_nodes, m_cuda_stream);

    // 4. Compute Hex8 / Tet4-ANP Element Stresses and Hourglass Forces on GPU
    const auto& erosion = m_cpu_solver.getErosionCriteria();
    launch_fem_element_forces_kernel_3d<T>(
        m_d_nodes, num_nodes, m_d_elements, num_elements, m_d_gp_history, m_d_materials,
        m_cpu_solver.getPhysicsParams(), dt, m_cpu_solver.getHourglassCoeff(),
        m_cpu_solver.getHourglassModel(), m_cpu_solver.getIntegrationScheme(), m_cuda_stream,
        m_d_nodal_vol_cur, m_d_nodal_vol_ref, m_sim_time, m_d_nodal_dvol_dt,
        erosion.min_volume_ratio, m_d_erosion_flag
    );

    // 4b. Compute 1D Rebar Truss and Beam Forces on GPU
    if (m_d_trusses && num_trusses > 0) {
        launch_fem_truss_forces_kernel_3d<T>(
            m_d_nodes, num_nodes, m_d_trusses, num_trusses, m_d_materials, dt, m_cuda_stream
        );
    }
    if (m_d_beams && num_beams > 0) {
        launch_fem_beam_forces_kernel_3d<T>(
            m_d_nodes, num_nodes, m_d_beams, num_beams, m_d_rot_nodes, num_rot_nodes, m_d_materials, dt, m_cuda_stream
        );
    }

    // 4c. Lysmer-Kuhlemeyer Transmitting Boundary Dashpots on GPU
    if (m_cpu_solver.getLysmerParams().enabled && m_num_surface_facets > 0) {
        launch_fem_lysmer_dashpots_kernel_3d<T>(
            m_d_nodes, m_d_facets, static_cast<int>(m_num_surface_facets),
            m_cpu_solver.getLysmerParams(), m_cuda_stream
        );
    }

    // 5. Central Difference Kinematic Acceleration & Full Velocity Update on GPU
    launch_fem_nodal_full_step_kernel_3d<T>(m_d_nodes, num_nodes, dt, m_cuda_stream);
    if (m_d_rot_nodes && num_rot_nodes > 0) {
        int block_size = 256;
        int rot_grid = (num_rot_nodes + block_size - 1) / block_size;
        fem_rot_nodal_full_step_kernel_3d_device<T><<<rot_grid, block_size, 0, m_cuda_stream>>>(
            m_d_rot_nodes, num_rot_nodes, dt
        );
    }

    // 6. Erosion & Option C Cohesive Splitting Evaluation on GPU
    const bool enable_cohesive_splitting = m_cpu_solver.getPhysicsParams().enable_cohesive_splitting;
    bool any_cohesive_splitting = enable_cohesive_splitting;
    if (!any_cohesive_splitting) {
        for (const auto& mt : m_cpu_solver.getMaterialTables()) {
            if (mt.enable_cohesive_splitting) { any_cohesive_splitting = true; break; }
        }
    }
    const bool enable_nonlocal_damage = m_cpu_solver.getPhysicsParams().enable_nonlocal_damage;
    if (num_elements > 0) {
        launch_fem_initial_timestep_erosion_kernel_3d<T>(
            m_d_nodes, num_nodes, m_d_elements, num_elements,
            m_d_trusses, num_trusses, m_d_beams, num_beams,
            m_d_materials, erosion, m_cpu_solver.getPhysicsParams(),
            m_d_node_active_count, m_d_erosion_flag, m_cuda_stream,
            enable_cohesive_splitting, m_d_face_neighbors, enable_nonlocal_damage
        );
    }

    if (num_elements > 0) {
        const int check_interval = 4;
        if (m_d_erosion_flag && m_h_erosion_flag_pinned && (m_step_count % check_interval == 0)) {
            cudaMemcpyAsync(m_h_erosion_flag_pinned, m_d_erosion_flag, sizeof(int), cudaMemcpyDeviceToHost, m_cuda_stream);
            cudaStreamSynchronize(m_cuda_stream);

            if (*m_h_erosion_flag_pinned != 0) {
                *m_h_erosion_flag_pinned = 0;
                cudaMemsetAsync(m_d_erosion_flag, 0, sizeof(int), m_cuda_stream);
                m_topology_dirty = true;
                syncTopologyAfterSplitOrErosion(any_cohesive_splitting);
            }
        }
    }

    m_gpu_dirty = true;
}

template <typename T>
size_t FEMSolver3DCUDA<T>::getAllocatedVRAM() const {
    size_t total = 0;
    if (m_d_nodes) total += sizeof(FEMNode3D<T>) * m_allocated_nodes;
    if (m_d_mpm_impulse_accum) total += sizeof(T) * m_allocated_nodes * 3;
    if (m_d_node_part_id) total += sizeof(int) * m_allocated_nodes;
    if (m_d_node_normals) total += sizeof(T) * m_allocated_nodes * 3;
    if (m_d_node_active_count) total += sizeof(int) * m_allocated_nodes;
    if (m_d_nodal_vol_cur) total += sizeof(T) * m_allocated_nodes;
    if (m_d_nodal_vol_ref) total += sizeof(T) * m_allocated_nodes;
    if (m_d_nodal_dvol_dt) total += sizeof(T) * m_allocated_nodes;
    if (m_d_face_neighbors) total += sizeof(int) * m_allocated_elements * 6;
    if (m_d_erosion_flag) total += sizeof(int);
    if (m_d_part_mat_id) total += sizeof(int) * m_allocated_part_mat_id;
    if (m_d_elements) total += sizeof(FEMElement3D<T>) * m_allocated_elements;
    if (m_d_reduction_buffer) {
        size_t max_elem = std::max({m_allocated_elements, m_allocated_trusses, m_allocated_beams, static_cast<size_t>(1)});
        int grid_size = static_cast<int>((max_elem + 255) / 256);
        total += sizeof(T) * (grid_size > 0 ? grid_size : 1);
    }
    if (m_d_gp_history) total += sizeof(FEMGaussPointHistory3D<T>) * m_allocated_gp_history;
    if (m_d_materials) total += sizeof(MaterialTable3D) * m_allocated_materials;
    if (m_d_trusses) total += sizeof(FEMTrussElement3D<T>) * m_allocated_trusses;
    if (m_d_beams) total += sizeof(FEMBeam3DElement<T>) * m_allocated_beams;
    if (m_d_rot_nodes) total += sizeof(FEMNodeRotationalState3D<T>) * m_allocated_rot_nodes;
    if (m_d_facets) total += sizeof(FEMFacet3D<T>) * m_allocated_facets;
    if (m_d_cell_counts) total += sizeof(int) * m_spatial_grid_capacity * NUM_OCTAVES;
    if (m_d_cell_offsets) total += sizeof(int) * m_spatial_grid_capacity * NUM_OCTAVES;
    if (m_d_cell_facet_ids) total += sizeof(int) * m_allocated_hash_entries;
    if (m_d_oversized_facets) total += sizeof(int) * m_allocated_oversized_facets;
    if (m_d_oversized_count) total += sizeof(int);
    if (m_d_hash_scan_temp) total += m_hash_scan_temp_bytes;
    if (m_d_bvh_morton_codes) total += sizeof(uint32_t) * m_allocated_bvh_facets;
    if (m_d_bvh_morton_codes_alt) total += sizeof(uint32_t) * m_allocated_bvh_facets;
    if (m_d_bvh_sorted_facet_ids) total += sizeof(int) * m_allocated_bvh_facets;
    if (m_d_bvh_facet_indices_in) total += sizeof(int) * m_allocated_bvh_facets;
    if (m_d_bvh_nodes) total += sizeof(LBVHNode3D<T>) * m_allocated_bvh_facets;
    if (m_d_bvh_leaf_parents) total += sizeof(int) * m_allocated_bvh_facets;
    if (m_d_bvh_flags) total += sizeof(int) * (m_allocated_bvh_facets + 1);
    if (m_d_bvh_temp_storage) total += m_bvh_temp_storage_bytes;
    if (m_d_surface_nodes) total += sizeof(int) * m_allocated_surface_nodes;
    if (m_d_telemetry_nodes) total += sizeof(float) * m_allocated_telemetry_nodes * 7;
    if (m_d_telemetry_facets) total += sizeof(float) * m_allocated_telemetry_facets * 8;
    return total;
}

template <typename T>
T FEMSolver3DCUDA<T>::computeStepSize(T cfl) {
    if (!m_d_nodes) {
        syncToDevice();
    }
    return launch_fem_compute_step_size_kernel_3d<T>(
        m_d_nodes,
        m_d_elements, static_cast<int>(m_cpu_solver.getElements().size()),
        m_d_trusses, static_cast<int>(m_cpu_solver.getTrusses().size()),
        m_d_beams, static_cast<int>(m_cpu_solver.getBeams().size()),
        m_d_materials, cfl, m_d_reduction_buffer, m_cuda_stream
    );
}

template <typename T>
void FEMSolver3DCUDA<T>::step(T cfl) {
    m_last_cfl = cfl;
    T dt = computeStepSize(cfl);
    stepWithDt(dt);
}

template <typename T>
void FEMSolver3DCUDA<T>::applyMPMContact(T dt) {
    if (dt <= static_cast<T>(0.0f)) return;
    if (!m_cuda_mpm_solver || m_cuda_mpm_solver->getParticleCount() == 0) return;
    if (m_cpu_solver.getContactPenaltyScale() <= static_cast<T>(0.0f)) return;
    int num_nodes = static_cast<int>(m_cpu_solver.getNodes().size());
    int num_elements = static_cast<int>(m_cpu_solver.getElements().size());
    int num_trusses = static_cast<int>(m_cpu_solver.getTrusses().size());
    int num_beams = static_cast<int>(m_cpu_solver.getBeams().size());
    if (m_num_surface_facets == 0 && num_trusses == 0 && num_beams == 0) return;
    if (!m_d_nodes || !m_d_mpm_impulse_accum) syncToDevice();
    if (m_num_surface_facets > 0 && m_d_facets) {
        int f_block = 256;
        int f_grid = (static_cast<int>(m_num_surface_facets) + f_block - 1) / f_block;
        fem_update_surface_facets_kernel_3d_device<T><<<f_grid, f_block, 0, m_cuda_stream>>>(
            m_d_nodes, m_d_elements, num_elements,
            m_d_facets, static_cast<int>(m_num_surface_facets), m_d_node_normals
        );
        buildOctaveHashOnDevice();
    }
    launch_fem_mpm_debris_contact_kernel_3d<T>(
        m_cuda_mpm_solver->getDeviceParticlesSoA(),
        static_cast<int>(m_cuda_mpm_solver->getParticleCount()),
        m_d_nodes, num_nodes,
        m_d_elements, num_elements,
        m_d_facets, static_cast<int>(m_num_surface_facets),
        m_d_trusses, num_trusses,
        m_d_beams, num_beams,
        m_d_materials,
        m_d_cell_counts,
        m_d_cell_offsets,
        m_d_cell_facet_ids,
        static_cast<int>(m_allocated_hash_entries),
        m_d_oversized_facets,
        m_d_oversized_count,
        static_cast<int>(m_allocated_oversized_facets),
        static_cast<uint32_t>(m_spatial_grid_capacity),
        m_base_cell_size,
        m_cpu_solver.getContactPenaltyScale(),
        m_cpu_solver.getFrictionStatic(),
        m_cpu_solver.getFrictionKinetic(),
        m_cpu_solver.getContactDamping(),
        dt,
        m_d_mpm_impulse_accum,
        true,
        m_cuda_stream
    );
    m_has_pending_mpm_impulse = true;
    cudaStreamSynchronize(m_cuda_stream);
}

template <typename T>
__global__ void fem_truss_forces_kernel_3d_device(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    FEMTrussElement3D<T>* d_trusses,
    int num_trusses,
    const MaterialTable3D* d_materials,
    T dt
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_trusses) return;

    FEMTrussElement3D<T>& truss = d_trusses[idx];
    if (truss.is_eroded || truss.L0 <= static_cast<T>(0.0f)) return;

    int n1 = truss.node_ids[0];
    int n2 = truss.node_ids[1];
    if (n1 < 0 || n1 >= num_nodes || n2 < 0 || n2 >= num_nodes) return;

    T dx = d_nodes[n2].x[0] - d_nodes[n1].x[0];
    T dy = d_nodes[n2].x[1] - d_nodes[n1].x[1];
    T dz = d_nodes[n2].x[2] - d_nodes[n1].x[2];
    T L = sqrt(dx*dx + dy*dy + dz*dz);
    if (L < static_cast<T>(1.0e-12f)) return;

    T invL = static_cast<T>(1.0f) / L;
    T e1[3] = { dx * invL, dy * invL, dz * invL };

    T eps = (L - truss.L0) / truss.L0;
    T dvx = d_nodes[n2].v[0] - d_nodes[n1].v[0];
    T dvy = d_nodes[n2].v[1] - d_nodes[n1].v[1];
    T dvz = d_nodes[n2].v[2] - d_nodes[n1].v[2];
    T axial_edot = (dvx * e1[0] + dvy * e1[1] + dvz * e1[2]) * invL;

    const MaterialTable3D& mat = d_materials[truss.mat_id];
    if (mat.enable_timestep_erosion && mat.timestep_erosion_factor > 1.0e-5f &&
        L <= static_cast<T>(mat.timestep_erosion_factor) * truss.L0) {
        truss.is_eroded = true;
        truss.sigma = static_cast<T>(0.0f);
        return;
    }
    T sigma = static_cast<T>(0.0f);
    T current_yield = static_cast<T>(0.0f);
    bool eroded_truss = false;
    evaluateFEMAxialPlasticity<T>(
        mat, eps, axial_edot, static_cast<T>(293.0f),
        truss.eps_p, truss.ep_bar, sigma, current_yield,
        truss.failure_strain, eroded_truss);
    truss.sigma = sigma;

    if (eroded_truss) {
        truss.is_eroded = true;
        truss.sigma = static_cast<T>(0.0f);
        return;
    }

    T N = sigma * truss.A;
    T fx = N * e1[0];
    T fy = N * e1[1];
    T fz = N * e1[2];

    atomicAdd(&d_nodes[n2].f_int[0], fx);
    atomicAdd(&d_nodes[n2].f_int[1], fy);
    atomicAdd(&d_nodes[n2].f_int[2], fz);

    atomicAdd(&d_nodes[n1].f_int[0], -fx);
    atomicAdd(&d_nodes[n1].f_int[1], -fy);
    atomicAdd(&d_nodes[n1].f_int[2], -fz);
}

template <typename T>
void launch_fem_truss_forces_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    FEMTrussElement3D<T>* d_trusses,
    int num_trusses,
    const MaterialTable3D* d_materials,
    T dt,
    cudaStream_t stream
) {
    if (!d_nodes || !d_trusses || num_trusses <= 0) return;
    int blockSize = 256;
    int numBlocks = (num_trusses + blockSize - 1) / blockSize;
    fem_truss_forces_kernel_3d_device<T><<<numBlocks, blockSize, 0, stream>>>(
        d_nodes, num_nodes, d_trusses, num_trusses, d_materials, dt
    );
}

template <typename T>
__global__ void fem_beam_forces_kernel_3d_device(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    FEMBeam3DElement<T>* d_beams,
    int num_beams,
    FEMNodeRotationalState3D<T>* d_rot_nodes,
    int num_rot_nodes,
    const MaterialTable3D* d_materials,
    T dt
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_beams) return;

    FEMBeam3DElement<T>& beam = d_beams[idx];
    if (beam.is_eroded || beam.L0 <= static_cast<T>(0.0f)) return;

    int n1 = beam.node_ids[0];
    int n2 = beam.node_ids[1];
    int r1 = beam.rot_node_ids[0];
    int r2 = beam.rot_node_ids[1];
    if (n1 < 0 || n1 >= num_nodes || n2 < 0 || n2 >= num_nodes) return;

    T dx = d_nodes[n2].x[0] - d_nodes[n1].x[0];
    T dy = d_nodes[n2].x[1] - d_nodes[n1].x[1];
    T dz = d_nodes[n2].x[2] - d_nodes[n1].x[2];
    T L = sqrt(dx*dx + dy*dy + dz*dz);
    if (L < static_cast<T>(1.0e-12f)) return;

    T invL = static_cast<T>(1.0f) / L;
    T e1[3] = { dx * invL, dy * invL, dz * invL };

    T eps = (L - beam.L0) / beam.L0;
    T dv[3] = { d_nodes[n2].v[0] - d_nodes[n1].v[0], d_nodes[n2].v[1] - d_nodes[n1].v[1], d_nodes[n2].v[2] - d_nodes[n1].v[2] };
    T axial_edot = (dv[0]*e1[0] + dv[1]*e1[1] + dv[2]*e1[2]) * invL;

    const MaterialTable3D& mat = d_materials[beam.mat_id];
    if (mat.enable_timestep_erosion && mat.timestep_erosion_factor > 1.0e-5f) {
        T d_val = beam.d > static_cast<T>(1.0e-6f) ? beam.d : static_cast<T>(0.012f);
        T dt0_ax = beam.L0;
        T dt0_bn = (beam.L0 * beam.L0) / (static_cast<T>(3.464f) * d_val);
        T dt0_eff = dt0_ax < dt0_bn ? dt0_ax : dt0_bn;
        T dt_ax = L;
        T dt_bn = (L * L) / (static_cast<T>(3.464f) * d_val);
        T dt_eff = dt_ax < dt_bn ? dt_ax : dt_bn;
        if (dt0_eff > static_cast<T>(0.0f) && dt_eff <= static_cast<T>(mat.timestep_erosion_factor) * dt0_eff) {
            beam.is_eroded = true;
            beam.N = beam.V2 = beam.V3 = beam.M2 = beam.M3 = beam.T_tor = static_cast<T>(0.0f);
            return;
        }
    }
    T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f);
    T nu = static_cast<T>(mat.poissons_ratio > 0.0f ? mat.poissons_ratio : 0.30f);
    T G = E / (static_cast<T>(2.0f) * (static_cast<T>(1.0f) + nu));

    T sigma = static_cast<T>(0.0f);
    T current_yield = static_cast<T>(0.0f);
    bool eroded_beam = false;
    evaluateFEMAxialPlasticity<T>(
        mat, eps, axial_edot, static_cast<T>(293.0f),
        beam.eps_p, beam.ep_bar, sigma, current_yield,
        beam.failure_strain, eroded_beam);
    if (eroded_beam) {
        beam.is_eroded = true;
        beam.N = beam.V2 = beam.V3 = beam.M2 = beam.M3 = beam.T_tor = static_cast<T>(0.0f);
        return;
    }
    T N = sigma * beam.A;

    T w1[3] = { static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(0.0f) };
    T w2[3] = { static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(0.0f) };
    if (d_rot_nodes && r1 >= 0 && r1 < num_rot_nodes) {
        w1[0] = d_rot_nodes[r1].omega[0];
        w1[1] = d_rot_nodes[r1].omega[1];
        w1[2] = d_rot_nodes[r1].omega[2];
    }
    if (d_rot_nodes && r2 >= 0 && r2 < num_rot_nodes) {
        w2[0] = d_rot_nodes[r2].omega[0];
        w2[1] = d_rot_nodes[r2].omega[1];
        w2[2] = d_rot_nodes[r2].omega[2];
    }

    // Co-rotate transverse triad (beam.e2, beam.e3) with current axis e1 and axial twist
    T e1_old[3] = {
        beam.e2[1]*beam.e3[2] - beam.e2[2]*beam.e3[1],
        beam.e2[2]*beam.e3[0] - beam.e2[0]*beam.e3[2],
        beam.e2[0]*beam.e3[1] - beam.e2[1]*beam.e3[0]
    };
    T c_axis = e1_old[0]*e1[0] + e1_old[1]*e1[1] + e1_old[2]*e1[2];
    T v_axis[3] = {
        e1_old[1]*e1[2] - e1_old[2]*e1[1],
        e1_old[2]*e1[0] - e1_old[0]*e1[2],
        e1_old[0]*e1[1] - e1_old[1]*e1[0]
    };
    if (c_axis > static_cast<T>(-0.999999f)) {
        T k_rot = static_cast<T>(1.0f) / (static_cast<T>(1.0f) + c_axis);
        T vx_e2[3] = {
            v_axis[1]*beam.e2[2] - v_axis[2]*beam.e2[1],
            v_axis[2]*beam.e2[0] - v_axis[0]*beam.e2[2],
            v_axis[0]*beam.e2[1] - v_axis[1]*beam.e2[0]
        };
        T v_dot_e2 = v_axis[0]*beam.e2[0] + v_axis[1]*beam.e2[1] + v_axis[2]*beam.e2[2];
        for (int c = 0; c < 3; ++c) {
            beam.e2[c] = beam.e2[c] * c_axis + vx_e2[c] + v_axis[c] * (v_dot_e2 * k_rot);
        }
    }
    T dtheta_twist = static_cast<T>(0.5f) * ((w1[0]*e1[0] + w1[1]*e1[1] + w1[2]*e1[2]) +
                                             (w2[0]*e1[0] + w2[1]*e1[1] + w2[2]*e1[2])) * dt;
    if (fabs(dtheta_twist) > static_cast<T>(1.0e-12f)) {
        T ct = cos(dtheta_twist);
        T st = sin(dtheta_twist);
        T e1_x_e2[3] = {
            e1[1]*beam.e2[2] - e1[2]*beam.e2[1],
            e1[2]*beam.e2[0] - e1[0]*beam.e2[2],
            e1[0]*beam.e2[1] - e1[1]*beam.e2[0]
        };
        for (int c = 0; c < 3; ++c) {
            beam.e2[c] = beam.e2[c] * ct + e1_x_e2[c] * st;
        }
    }
    // Re-orthonormalize (e1, beam.e2, beam.e3)
    T dot12 = beam.e2[0]*e1[0] + beam.e2[1]*e1[1] + beam.e2[2]*e1[2];
    beam.e2[0] -= dot12 * e1[0];
    beam.e2[1] -= dot12 * e1[1];
    beam.e2[2] -= dot12 * e1[2];
    T e2_norm = sqrt(beam.e2[0]*beam.e2[0] + beam.e2[1]*beam.e2[1] + beam.e2[2]*beam.e2[2]);
    if (e2_norm > static_cast<T>(1.0e-12f)) {
        beam.e2[0] /= e2_norm;
        beam.e2[1] /= e2_norm;
        beam.e2[2] /= e2_norm;
    }
    beam.e3[0] = e1[1]*beam.e2[2] - e1[2]*beam.e2[1];
    beam.e3[1] = e1[2]*beam.e2[0] - e1[0]*beam.e2[2];
    beam.e3[2] = e1[0]*beam.e2[1] - e1[1]*beam.e2[0];

    T dw[3] = { w2[0] - w1[0], w2[1] - w1[1], w2[2] - w1[2] };
    T dot_kappa2 = (dw[0]*beam.e2[0] + dw[1]*beam.e2[1] + dw[2]*beam.e2[2]) * invL;
    T dot_kappa3 = (dw[0]*beam.e3[0] + dw[1]*beam.e3[1] + dw[2]*beam.e3[2]) * invL;
    T dot_kappa_tor = (dw[0]*e1[0] + dw[1]*e1[1] + dw[2]*e1[2]) * invL;

    beam.kappa2 += dot_kappa2 * dt;
    beam.kappa3 += dot_kappa3 * dt;
    beam.kappa_tor += dot_kappa_tor * dt;

    T omega_rigid[3] = {
        (e1[1]*dv[2] - e1[2]*dv[1]) * invL,
        (e1[2]*dv[0] - e1[0]*dv[2]) * invL,
        (e1[0]*dv[1] - e1[1]*dv[0]) * invL
    };
    T w_avg[3] = {
        static_cast<T>(0.5f) * (w1[0] + w2[0]),
        static_cast<T>(0.5f) * (w1[1] + w2[1]),
        static_cast<T>(0.5f) * (w1[2] + w2[2])
    };
    T dot_gamma12 = 0.0f;
    T dot_gamma13 = 0.0f;
    T V2 = 0.0f;
    T V3 = 0.0f;

    if (d_rot_nodes && r1 >= 0 && r1 < num_rot_nodes && r2 >= 0 && r2 < num_rot_nodes) {
        T w_rel[3] = { w_avg[0] - omega_rigid[0], w_avg[1] - omega_rigid[1], w_avg[2] - omega_rigid[2] };
        dot_gamma12 = -(w_rel[0]*beam.e3[0] + w_rel[1]*beam.e3[1] + w_rel[2]*beam.e3[2]);
        dot_gamma13 = w_rel[0]*beam.e2[0] + w_rel[1]*beam.e2[1] + w_rel[2]*beam.e2[2];
        beam.gamma12 += dot_gamma12 * dt;
        beam.gamma13 += dot_gamma13 * dt;
        T kappa_shear = static_cast<T>(0.90f);
        V2 = kappa_shear * G * beam.A * beam.gamma12;
        V3 = kappa_shear * G * beam.A * beam.gamma13;
    }

    T M2 = E * beam.I2 * beam.kappa2;
    T M3 = E * beam.I3 * beam.kappa3;
    T M_res = sqrt(M2*M2 + M3*M3);
    T Mp = beam.Zp * current_yield;
    if (Mp > static_cast<T>(0.0f) && M_res > Mp && M_res > static_cast<T>(1.0e-12f)) {
        T scale_m = Mp / M_res;
        M2 *= scale_m;
        M3 *= scale_m;
        T dkappa2_p = beam.kappa2 * (static_cast<T>(1.0f) - scale_m);
        T dkappa3_p = beam.kappa3 * (static_cast<T>(1.0f) - scale_m);
        beam.kappa2 *= scale_m;
        beam.kappa3 *= scale_m;
        T dkappa_p = sqrt(dkappa2_p * dkappa2_p + dkappa3_p * dkappa3_p);
        T y_max = static_cast<T>(0.5f) * (beam.d > static_cast<T>(1.0e-6f) ? beam.d : sqrt(beam.A));
        beam.ep_bar += dkappa_p * y_max;
        T eff_fail = (beam.failure_strain > static_cast<T>(0.0f))
            ? beam.failure_strain
            : static_cast<T>(mat.failure_strain > 0.0f ? mat.failure_strain : mat.erosion_strain);
        if (eff_fail > static_cast<T>(0.0f) && beam.ep_bar >= eff_fail) {
            beam.is_eroded = true;
            beam.N = beam.V2 = beam.V3 = beam.M2 = beam.M3 = beam.T_tor = static_cast<T>(0.0f);
            return;
        }
    }

    T T_tor = G * beam.J * beam.kappa_tor;

    beam.N = N;
    beam.V2 = V2;
    beam.V3 = V3;
    beam.M2 = M2;
    beam.M3 = M3;
    beam.T_tor = T_tor;

    T f2_x = N * e1[0] + V2 * beam.e2[0] + V3 * beam.e3[0];
    T f2_y = N * e1[1] + V2 * beam.e2[1] + V3 * beam.e3[1];
    T f2_z = N * e1[2] + V2 * beam.e2[2] + V3 * beam.e3[2];

    atomicAdd(&d_nodes[n2].f_int[0], f2_x);
    atomicAdd(&d_nodes[n2].f_int[1], f2_y);
    atomicAdd(&d_nodes[n2].f_int[2], f2_z);

    atomicAdd(&d_nodes[n1].f_int[0], -f2_x);
    atomicAdd(&d_nodes[n1].f_int[1], -f2_y);
    atomicAdd(&d_nodes[n1].f_int[2], -f2_z);

    if (d_rot_nodes) {
        T half_L = static_cast<T>(0.5f) * L;
        T V_cross[3] = {
            V3 * beam.e2[0] - V2 * beam.e3[0],
            V3 * beam.e2[1] - V2 * beam.e3[1],
            V3 * beam.e2[2] - V2 * beam.e3[2]
        };

        T m2_x = T_tor * e1[0] + M2 * beam.e2[0] + M3 * beam.e3[0] + half_L * V_cross[0];
        T m2_y = T_tor * e1[1] + M2 * beam.e2[1] + M3 * beam.e3[1] + half_L * V_cross[1];
        T m2_z = T_tor * e1[2] + M2 * beam.e2[2] + M3 * beam.e3[2] + half_L * V_cross[2];

        T m1_x = -T_tor * e1[0] - M2 * beam.e2[0] - M3 * beam.e3[0] + half_L * V_cross[0];
        T m1_y = -T_tor * e1[1] - M2 * beam.e2[1] - M3 * beam.e3[1] + half_L * V_cross[1];
        T m1_z = -T_tor * e1[2] - M2 * beam.e2[2] - M3 * beam.e3[2] + half_L * V_cross[2];

        if (r2 >= 0 && r2 < num_rot_nodes) {
            atomicAdd(&d_rot_nodes[r2].m_int[0], m2_x);
            atomicAdd(&d_rot_nodes[r2].m_int[1], m2_y);
            atomicAdd(&d_rot_nodes[r2].m_int[2], m2_z);
        }
        if (r1 >= 0 && r1 < num_rot_nodes) {
            atomicAdd(&d_rot_nodes[r1].m_int[0], m1_x);
            atomicAdd(&d_rot_nodes[r1].m_int[1], m1_y);
            atomicAdd(&d_rot_nodes[r1].m_int[2], m1_z);
        }
    }
}

template <typename T>
void launch_fem_beam_forces_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    FEMBeam3DElement<T>* d_beams,
    int num_beams,
    FEMNodeRotationalState3D<T>* d_rot_nodes,
    int num_rot_nodes,
    const MaterialTable3D* d_materials,
    T dt,
    cudaStream_t stream
) {
    if (!d_nodes || !d_beams || num_beams <= 0) return;
    int blockSize = 256;
    int numBlocks = (num_beams + blockSize - 1) / blockSize;
    fem_beam_forces_kernel_3d_device<T><<<numBlocks, blockSize, 0, stream>>>(
        d_nodes, num_nodes, d_beams, num_beams, d_rot_nodes, num_rot_nodes, d_materials, dt
    );
}

template <typename T>
__global__ void fem_lysmer_dashpots_kernel_3d_device(
    FEMNode3D<T>* d_nodes,
    const FEMFacet3D<T>* d_facets,
    int num_facets,
    LysmerBoundaryParams params
) {
    int f = blockIdx.x * blockDim.x + threadIdx.x;
    if (f >= num_facets) return;

    const FEMFacet3D<T>& facet = d_facets[f];
    if (facet.is_eroded) return;

    const bool is_tri = (facet.node_ids[2] == facet.node_ids[3]);
    const int num_facet_nodes = is_tri ? 3 : 4;
    const T inv_nodes = static_cast<T>(1.0f) / static_cast<T>(num_facet_nodes);

    if (params.filter_box) {
        T cx = static_cast<T>(0.0f), cy = static_cast<T>(0.0f), cz = static_cast<T>(0.0f);
        for (int k = 0; k < num_facet_nodes; ++k) {
            const int nid = facet.node_ids[k];
            cx += d_nodes[nid].x[0];
            cy += d_nodes[nid].x[1];
            cz += d_nodes[nid].x[2];
        }
        cx *= inv_nodes;
        cy *= inv_nodes;
        cz *= inv_nodes;
        T tol = static_cast<T>(params.tol);

        bool on_bound = (fabs(cx - static_cast<T>(params.x_min)) <= tol) ||
                        (fabs(cx - static_cast<T>(params.x_max)) <= tol) ||
                        (fabs(cy - static_cast<T>(params.y_min)) <= tol) ||
                        (fabs(cy - static_cast<T>(params.y_max)) <= tol) ||
                        (fabs(cz - static_cast<T>(params.z_min)) <= tol) ||
                        (fabs(cz - static_cast<T>(params.z_max)) <= tol);
        if (!on_bound) return;
    }

    T rho = static_cast<T>(params.rho);
    T cp = static_cast<T>(params.c_p);
    T cs = static_cast<T>(params.c_s);
    T norm_rel = static_cast<T>(params.normal_relaxation);
    T shear_rel = static_cast<T>(params.shear_relaxation);

    T A_node = inv_nodes * facet.area;
    T nx = facet.normal[0], ny = facet.normal[1], nz = facet.normal[2];

    for (int k = 0; k < num_facet_nodes; ++k) {
        int nid = facet.node_ids[k];
        const auto& node = d_nodes[nid];
        if (node.is_eroded || node.m <= static_cast<T>(1.0e-12f)) continue;

        T vn = node.v[0] * nx + node.v[1] * ny + node.v[2] * nz;
        T vs_x = node.v[0] - vn * nx;
        T vs_y = node.v[1] - vn * ny;
        T vs_z = node.v[2] - vn * nz;

        T fn = - A_node * rho * cp * norm_rel * vn;
        T fs_x = - A_node * rho * cs * shear_rel * vs_x;
        T fs_y = - A_node * rho * cs * shear_rel * vs_y;
        T fs_z = - A_node * rho * cs * shear_rel * vs_z;

        T fx = fn * nx + fs_x;
        T fy = fn * ny + fs_y;
        T fz = fn * nz + fs_z;

        atomicAdd(&d_nodes[nid].f_contact[0], fx);
        atomicAdd(&d_nodes[nid].f_contact[1], fy);
        atomicAdd(&d_nodes[nid].f_contact[2], fz);
    }
}

template <typename T>
void launch_fem_lysmer_dashpots_kernel_3d(
    FEMNode3D<T>* d_nodes,
    const FEMFacet3D<T>* d_facets,
    int num_facets,
    const LysmerBoundaryParams& params,
    cudaStream_t stream
) {
    if (!d_nodes || !d_facets || num_facets <= 0 || !params.enabled) return;
    int blockSize = 256;
    int numBlocks = (num_facets + blockSize - 1) / blockSize;
    fem_lysmer_dashpots_kernel_3d_device<T><<<numBlocks, blockSize, 0, stream>>>(
        d_nodes, d_facets, num_facets, params
    );
}

// Explicit Instantiations
template void launch_fem_reset_nodal_forces_kernel_3d<float>(FEMNode3D<float>*, int, cudaStream_t);
template void launch_fem_reset_nodal_forces_kernel_3d<double>(FEMNode3D<double>*, int, cudaStream_t);

template void launch_fem_element_forces_kernel_3d<float>(FEMNode3D<float>*, int, FEMElement3D<float>*, int, FEMGaussPointHistory3D<float>*, const MaterialTable3D*, BlastPhysicsParams<float>, float, float, FEMHourglassModel, FEMIntegrationScheme, cudaStream_t, float*, float*, float, float*, float, int*);
template void launch_fem_element_forces_kernel_3d<double>(FEMNode3D<double>*, int, FEMElement3D<double>*, int, FEMGaussPointHistory3D<double>*, const MaterialTable3D*, BlastPhysicsParams<double>, double, double, FEMHourglassModel, FEMIntegrationScheme, cudaStream_t, double*, double*, double, double*, double, int*);

template void launch_fem_truss_forces_kernel_3d<float>(FEMNode3D<float>*, int, FEMTrussElement3D<float>*, int, const MaterialTable3D*, float, cudaStream_t);
template void launch_fem_truss_forces_kernel_3d<double>(FEMNode3D<double>*, int, FEMTrussElement3D<double>*, int, const MaterialTable3D*, double, cudaStream_t);

template void launch_fem_beam_forces_kernel_3d<float>(FEMNode3D<float>*, int, FEMBeam3DElement<float>*, int, FEMNodeRotationalState3D<float>*, int, const MaterialTable3D*, float, cudaStream_t);
template void launch_fem_beam_forces_kernel_3d<double>(FEMNode3D<double>*, int, FEMBeam3DElement<double>*, int, FEMNodeRotationalState3D<double>*, int, const MaterialTable3D*, double, cudaStream_t);

template void launch_fem_nodal_half_step_kernel_3d<float>(FEMNode3D<float>*, int, float, cudaStream_t);
template void launch_fem_nodal_half_step_kernel_3d<double>(FEMNode3D<double>*, int, double, cudaStream_t);

template void launch_fem_nodal_full_step_kernel_3d<float>(FEMNode3D<float>*, int, float, cudaStream_t);
template void launch_fem_nodal_full_step_kernel_3d<double>(FEMNode3D<double>*, int, double, cudaStream_t);

template void launch_fem_initial_timestep_erosion_kernel_3d<float>(FEMNode3D<float>*, int, FEMElement3D<float>*, int, const FEMTrussElement3D<float>*, int, const FEMBeam3DElement<float>*, int, const MaterialTable3D*, FEMErosionCriteria<float>, BlastPhysicsParams<float>, int*, int*, cudaStream_t, bool, const int*, bool);
template void launch_fem_initial_timestep_erosion_kernel_3d<double>(FEMNode3D<double>*, int, FEMElement3D<double>*, int, const FEMTrussElement3D<double>*, int, const FEMBeam3DElement<double>*, int, const MaterialTable3D*, FEMErosionCriteria<double>, BlastPhysicsParams<double>, int*, int*, cudaStream_t, bool, const int*, bool);

template void launch_fem_update_orphan_nodes_erosion_kernel_3d<float>(FEMNode3D<float>*, int, const FEMElement3D<float>*, int, const FEMTrussElement3D<float>*, int, const FEMBeam3DElement<float>*, int, int*, cudaStream_t);
template void launch_fem_update_orphan_nodes_erosion_kernel_3d<double>(FEMNode3D<double>*, int, const FEMElement3D<double>*, int, const FEMTrussElement3D<double>*, int, const FEMBeam3DElement<double>*, int, int*, cudaStream_t);

template void launch_fem_update_surface_facets_kernel_3d<float>(FEMNode3D<float>*, int, const FEMElement3D<float>*, int, FEMFacet3D<float>*, int, float*, cudaStream_t);
template void launch_fem_update_surface_facets_kernel_3d<double>(FEMNode3D<double>*, int, const FEMElement3D<double>*, int, FEMFacet3D<double>*, int, double*, cudaStream_t);

template void launch_fem_contact_forces_kernel_3d<float>(
    FEMNode3D<float>*, int, const FEMElement3D<float>*, int, const FEMFacet3D<float>*, int,
    const int*, int, const int*, const int*, int, const float*, const MaterialTable3D*,
    FEMContactSearchMethod, int*, int*, int*, int, int*, int*, int, void*, size_t, uint32_t, float,
    uint32_t*, uint32_t*, int*, int*, LBVHNode3D<float>*, int*, int*, void*, size_t&,
    float, float, float, float, float, float,
    float, float, float, float, float, cudaStream_t
);
template void launch_fem_contact_forces_kernel_3d<double>(
    FEMNode3D<double>*, int, const FEMElement3D<double>*, int, const FEMFacet3D<double>*, int,
    const int*, int, const int*, const int*, int, const double*, const MaterialTable3D*,
    FEMContactSearchMethod, int*, int*, int*, int, int*, int*, int, void*, size_t, uint32_t, double,
    uint32_t*, uint32_t*, int*, int*, LBVHNode3D<double>*, int*, int*, void*, size_t&,
    double, double, double, double, double, double,
    double, double, double, double, double, cudaStream_t
);

template void launch_fem_mpm_debris_contact_kernel_3d<float>(MPMParticle3DSoA, int, FEMNode3D<float>*, int, const FEMElement3D<float>*, int, const FEMFacet3D<float>*, int, const FEMTrussElement3D<float>*, int, const FEMBeam3DElement<float>*, int, const MaterialTable3D*, const int*, const int*, const int*, int, const int*, const int*, int, uint32_t, float, float, float, float, float, float, float*, bool, cudaStream_t);
template void launch_fem_mpm_debris_contact_kernel_3d<double>(MPMParticle3DSoA, int, FEMNode3D<double>*, int, const FEMElement3D<double>*, int, const FEMFacet3D<double>*, int, const FEMTrussElement3D<double>*, int, const FEMBeam3DElement<double>*, int, const MaterialTable3D*, const int*, const int*, const int*, int, const int*, const int*, int, uint32_t, double, double, double, double, double, double, double*, bool, cudaStream_t);

template float launch_fem_compute_step_size_kernel_3d<float>(const FEMNode3D<float>*, const FEMElement3D<float>*, int, const FEMTrussElement3D<float>*, int, const FEMBeam3DElement<float>*, int, const MaterialTable3D*, float, float*, cudaStream_t);
template double launch_fem_compute_step_size_kernel_3d<double>(const FEMNode3D<double>*, const FEMElement3D<double>*, int, const FEMTrussElement3D<double>*, int, const FEMBeam3DElement<double>*, int, const MaterialTable3D*, double, double*, cudaStream_t);

template void launch_fem_lysmer_dashpots_kernel_3d<float>(FEMNode3D<float>*, const FEMFacet3D<float>*, int, const LysmerBoundaryParams&, cudaStream_t);
template void launch_fem_lysmer_dashpots_kernel_3d<double>(FEMNode3D<double>*, const FEMFacet3D<double>*, int, const LysmerBoundaryParams&, cudaStream_t);

template <typename T>
void FEMSolver3DCUDA<T>::evaluateErosionCriteria() {
    m_cpu_solver.evaluateErosionCriteria();
    syncToDevice();
    flush_fem_debris_to_cuda_mpm<T>(m_cpu_solver, m_cuda_mpm_solver, m_synced_debris_particle_count, m_debris_mat_offset);
}

template class FEMSolver3DCUDA<float>;
template class FEMSolver3DCUDA<double>;

} // namespace Blast

