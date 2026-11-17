#pragma once

#include <cmath>
#include <algorithm>
#include "../mpm_solver_2d.hpp"
#include "../constitutive_concrete_models.hpp"
#include "ConstitutiveGeomaterials.hpp"

namespace Blast::Materials {

template <typename T>
struct ConstitutiveState3D {
    T sigma[3][3]{};
    T F_total[3][3]{
        {static_cast<T>(1.0), static_cast<T>(0.0), static_cast<T>(0.0)},
        {static_cast<T>(0.0), static_cast<T>(1.0), static_cast<T>(0.0)},
        {static_cast<T>(0.0), static_cast<T>(0.0), static_cast<T>(1.0)}
    };
    T hill_a[3]{static_cast<T>(1.0), static_cast<T>(0.0), static_cast<T>(0.0)};
    T hill_b[3]{static_cast<T>(0.0), static_cast<T>(1.0), static_cast<T>(0.0)};
    T ep_bar{static_cast<T>(0.0)};
    T damage{static_cast<T>(0.0)};
    T lambda{static_cast<T>(0.0)}; // CDP: ep_t | KC/CSCM: lambda/kappa | Cap: X | JH2: delta_P | Foam: eps_v_p
    T temperature{static_cast<T>(293.0)};
    T e_internal{static_cast<T>(0.0)};
    T J{static_cast<T>(1.0)};
    bool has_failed{false};
};

template <typename T>
HD_MAT_FUNC void compute_cayley_rotation(const T W[3][3], T dt, T R[3][3]) {
    const T w01 = W[0][1] * dt;
    const T w02 = W[0][2] * dt;
    const T w12 = W[1][2] * dt;
    const T theta2 = w01 * w01 + w02 * w02 + w12 * w12;
    const T c = static_cast<T>(1.0) / (static_cast<T>(1.0) + static_cast<T>(0.25) * theta2);
    const T h_c = static_cast<T>(0.5) * c;

    const T dW[3][3] = {
        {static_cast<T>(0.0),  w01,  w02},
        {-w01, static_cast<T>(0.0),  w12},
        {-w02, -w12, static_cast<T>(0.0)}
    };

    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            const T dW2_ij = dW[i][0] * dW[0][j] + dW[i][1] * dW[1][j] + dW[i][2] * dW[2][j];
            R[i][j] = ((i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0)) + c * dW[i][j] + h_c * dW2_ij;
        }
    }
}

template <typename T>
HD_MAT_FUNC void rotate_tensor_orthogonal(const T R[3][3], const T M[3][3], T out[3][3]) {
    T tmp[3][3];
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            tmp[i][j] = R[i][0] * M[0][j] + R[i][1] * M[1][j] + R[i][2] * M[2][j];
        }
    }
    for (int i = 0; i < 3; ++i) {
        for (int j = 0; j < 3; ++j) {
            out[i][j] = tmp[i][0] * R[j][0] + tmp[i][1] * R[j][1] + tmp[i][2] * R[j][2];
        }
    }
}

template <typename T>
HD_MAT_FUNC T mat3_det(const T F[3][3]) {
    return F[0][0] * (F[1][1] * F[2][2] - F[1][2] * F[2][1]) -
           F[0][1] * (F[1][0] * F[2][2] - F[1][2] * F[2][0]) +
           F[0][2] * (F[1][0] * F[2][1] - F[1][1] * F[2][0]);
}

template <typename T>
HD_MAT_FUNC void orthonormalize_hill_triad(T a[3], T b[3], T Q[3][3]) {
    T na = std::sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    if (na < static_cast<T>(1.0e-8)) {
        a[0] = static_cast<T>(1.0); a[1] = static_cast<T>(0.0); a[2] = static_cast<T>(0.0);
        na = static_cast<T>(1.0);
    }
    const T inv_a = static_cast<T>(1.0) / na;
    a[0] *= inv_a; a[1] *= inv_a; a[2] *= inv_a;

    T dot_ab = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    b[0] -= dot_ab * a[0];
    b[1] -= dot_ab * a[1];
    b[2] -= dot_ab * a[2];
    T nb = std::sqrt(b[0] * b[0] + b[1] * b[1] + b[2] * b[2]);
    if (nb < static_cast<T>(1.0e-8)) {
        if (std::abs(a[0]) < static_cast<T>(0.9)) {
            b[0] = static_cast<T>(1.0); b[1] = static_cast<T>(0.0); b[2] = static_cast<T>(0.0);
        } else {
            b[0] = static_cast<T>(0.0); b[1] = static_cast<T>(1.0); b[2] = static_cast<T>(0.0);
        }
        dot_ab = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        b[0] -= dot_ab * a[0]; b[1] -= dot_ab * a[1]; b[2] -= dot_ab * a[2];
        nb = std::sqrt(b[0] * b[0] + b[1] * b[1] + b[2] * b[2]);
    }
    const T inv_b = static_cast<T>(1.0) / std::max(static_cast<T>(1.0e-12), nb);
    b[0] *= inv_b; b[1] *= inv_b; b[2] *= inv_b;

    const T e3[3] = {
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0]
    };

    for (int r = 0; r < 3; ++r) {
        Q[r][0] = a[r];
        Q[r][1] = b[r];
        Q[r][2] = e3[r];
    }
}

template <typename T, typename MatType>
HD_MAT_FUNC T getEffectiveBulkModulus(const MatType& mat, T J_in = static_cast<T>(1.0)) {
    const T rho0 = std::max(static_cast<T>(1.0), static_cast<T>(mat.density));
    const MPMMaterialModel model = mat.material_model;
    const T J = std::max(static_cast<T>(0.05), J_in);

    if (model == MPMMaterialModel::TaitWater) {
        const T B = static_cast<T>(mat.tait_B > 0.0f ? mat.tait_B : 3.039e8f);
        const T g = static_cast<T>(mat.tait_gamma > 0.0f ? mat.tait_gamma : 7.15f);
        return g * B * std::pow(static_cast<T>(1.0) / J, g);
    }
    if (model == MPMMaterialModel::IdealGas) {
        const T g = static_cast<T>(mat.ideal_gamma > 1.0f ? mat.ideal_gamma : ((mat.tait_gamma > 1.0f && mat.tait_gamma < 5.0f) ? mat.tait_gamma : 1.4f));
        const T p_ref = static_cast<T>(mat.tait_p0 > 0.0f ? mat.tait_p0 : 101325.0f);
        return g * p_ref / J;
    }
    if (model == MPMMaterialModel::HyperelasticYeoh || model == MPMMaterialModel::HyperelasticMooneyRivlin) {
        return std::max(static_cast<T>(1.0e5), static_cast<T>(mat.k_bulk));
    }
    if (model == MPMMaterialModel::JohnsonHolmquistJH2) {
        const T mu = (static_cast<T>(1.0) / J) - static_cast<T>(1.0);
        const T K1 = std::max(static_cast<T>(1.0e6), static_cast<T>(mat.jh2_K1));
        if (mu > static_cast<T>(0.0)) {
            return std::max(K1, K1 + static_cast<T>(2.0) * static_cast<T>(mat.jh2_K2) * mu +
                                 static_cast<T>(3.0) * static_cast<T>(mat.jh2_K3) * mu * mu);
        }
        return K1;
    }
    if ((model == MPMMaterialModel::JohnsonCookMieGruneisen || model == MPMMaterialModel::SteinbergGuinan) &&
        mat.mg_c0 > 0.0f) {
        const T c0 = static_cast<T>(mat.mg_c0);
        const T s = static_cast<T>(mat.mg_s);
        const T mu = std::max(static_cast<T>(0.0), (static_cast<T>(1.0) / J) - static_cast<T>(1.0));
        return rho0 * c0 * c0 * (static_cast<T>(1.0) + static_cast<T>(2.0) * s * mu);
    }

    const T E = std::max(static_cast<T>(1.0e3), static_cast<T>(mat.youngs_modulus));
    const T nu = std::max(static_cast<T>(0.0), std::min(static_cast<T>(0.49999), static_cast<T>(mat.poissons_ratio)));
    return E / (static_cast<T>(3.0) * (static_cast<T>(1.0) - static_cast<T>(2.0) * nu));
}

template <typename T, typename MatType>
HD_MAT_FUNC T computeInstantaneousSoundSpeed(
    const MatType& mat,
    T J_in = static_cast<T>(1.0),
    T p_hydro = static_cast<T>(0.0),
    T e_int = static_cast<T>(0.0)
) {
    const MPMMaterialModel model = mat.material_model;
    const T J = std::max(static_cast<T>(0.05), J_in);
    const T rho0 = std::max(static_cast<T>(0.05), static_cast<T>(mat.density));
    const T rho = rho0 / J;

    if (model == MPMMaterialModel::TaitWater) {
        const T rho_w0 = std::max(static_cast<T>(1.0), static_cast<T>(mat.tait_rho0));
        const T rho_w = rho_w0 / std::max(static_cast<T>(0.45), J);
        Blast::TaitVariant v = Blast::TaitVariant::Isentropic;
        if (mat.tait_variant == 1) v = Blast::TaitVariant::CaloricGruneisen;
        else if (mat.tait_variant == 2) v = Blast::TaitVariant::ShockHugoniot;
        return Blast::TaitEOSWater::compute_sound_speed_unified<T>(
            rho_w, p_hydro, e_int, v,
            static_cast<T>(mat.tait_B), static_cast<T>(mat.tait_gamma), rho_w0,
            static_cast<T>(mat.tait_c0), static_cast<T>(mat.tait_gruneisen),
            static_cast<T>(mat.mg_s > 0.0f ? mat.mg_s : 1.75f)
        );
    }
    if (model == MPMMaterialModel::IdealGas) {
        const T g = static_cast<T>(mat.ideal_gamma > 1.0f ? mat.ideal_gamma : ((mat.tait_gamma > 1.0f && mat.tait_gamma < 5.0f) ? mat.tait_gamma : 1.4f));
        const T p_abs = std::max(static_cast<T>(1.0e4), p_hydro > static_cast<T>(0.0) ? p_hydro : static_cast<T>(101325.0));
        return std::sqrt(g * p_abs / rho);
    }

    T K_eff = getEffectiveBulkModulus<T>(mat, J);
    T G_eff = static_cast<T>(0.0);
    if (model == MPMMaterialModel::HyperelasticYeoh) {
        G_eff = static_cast<T>(2.0) * std::max(static_cast<T>(1.0e3), static_cast<T>(mat.yeoh_c10));
    } else if (model == MPMMaterialModel::HyperelasticMooneyRivlin) {
        G_eff = static_cast<T>(2.0) * std::max(static_cast<T>(1.0e3), static_cast<T>(mat.mr_c10 + mat.mr_c01));
    } else {
        const T E = std::max(static_cast<T>(1.0e3), static_cast<T>(mat.youngs_modulus));
        const T nu = std::max(static_cast<T>(0.0), std::min(static_cast<T>(0.49999), static_cast<T>(mat.poissons_ratio)));
        G_eff = E / (static_cast<T>(2.0) * (static_cast<T>(1.0) + nu));
    }

    if (model == MPMMaterialModel::SteinbergGuinan) {
        const T eta = std::max(static_cast<T>(0.1), static_cast<T>(1.0) / J);
        const T g_fac = static_cast<T>(1.0) + static_cast<T>(mat.sg_bp) * std::max(static_cast<T>(0.0), p_hydro) * std::pow(eta, static_cast<T>(-1.0 / 3.0));
        G_eff *= std::max(static_cast<T>(0.05), g_fac);
    }

    const T c_sq = (K_eff + static_cast<T>(4.0 / 3.0) * G_eff) / rho;
    return std::sqrt(std::max(static_cast<T>(1.0), c_sq));
}

template <typename T>
struct ConstitutiveDispatcher3D {
    template <typename MatType>
    HD_MAT_FUNC static void applyDeformationGradientUpdate(
        const T L_grad[3][3], T dt, T F[3][3]
    ) {
        T inc[3][3];
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                inc[i][j] = ((i == j) ? static_cast<T>(1.0) : static_cast<T>(0.0)) + L_grad[i][j] * dt;

        T F_new[3][3]{};
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                F_new[i][j] = inc[i][0] * F[0][j] + inc[i][1] * F[1][j] + inc[i][2] * F[2][j];

        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                F[i][j] = F_new[i][j];
    }

    template <typename MatType>
    HD_MAT_FUNC static void computeFailedDebrisEnvelope(
        const MatType& mat,
        const ConstitutiveState3D<T>& state,
        T& p_comp,
        T& q_max
    ) {
        const MPMMaterialModel model = mat.material_model;
        const bool is_concrete = isConcreteModel(model);
        const bool is_geo = isGeomaterialModel(model);
        const T J_eff = std::max(static_cast<T>(0.05), state.J);
        p_comp = static_cast<T>(0.0);

        T c_residual = static_cast<T>(0.0);
        T sigma_t_rubble = static_cast<T>(0.0);
        if (is_concrete) {
            const T c0 = std::max(static_cast<T>(0.04) * static_cast<T>(mat.fc), static_cast<T>(0.8e6));
            const T ep_debris = std::max(static_cast<T>(0.0), state.ep_bar - static_cast<T>(0.01));
            c_residual = c0 * std::exp(-ep_debris / static_cast<T>(0.08));
            sigma_t_rubble = std::min(c_residual * static_cast<T>(0.20), static_cast<T>(0.10) * static_cast<T>(mat.ft));
        }

        if (J_eff < static_cast<T>(1.0)) {
            if (usesMieGruneisenEOS(model) && mat.mg_c0 > 0.0f) {
                const T mu_vol = (static_cast<T>(1.0) - J_eff) / std::max(static_cast<T>(0.25), J_eff);
                p_comp = std::max(
                    static_cast<T>(0.0),
                    mie_gruneisen_compression_pressure<T>(
                        static_cast<T>(mat.density), static_cast<T>(mat.mg_c0),
                        static_cast<T>(mat.mg_s), static_cast<T>(mat.mg_gamma0), mu_vol, static_cast<T>(0.0)
                    )
                );
            } else {
                const T E_mod = mat.youngs_modulus > 0.0f ? static_cast<T>(mat.youngs_modulus) : static_cast<T>(30.0e9);
                const T nu = std::max(static_cast<T>(0.01), std::min(static_cast<T>(0.49), static_cast<T>(mat.poissons_ratio)));
                const T K_parent = E_mod / (static_cast<T>(3.0) * (static_cast<T>(1.0) - static_cast<T>(2.0) * nu));
                p_comp = K_parent * (static_cast<T>(1.0) - J_eff) / std::max(static_cast<T>(0.01), J_eff);
            }
        } else if (is_concrete && sigma_t_rubble > static_cast<T>(0.0)) {
            const T E_mod = mat.youngs_modulus > 0.0f ? static_cast<T>(mat.youngs_modulus) : static_cast<T>(30.0e9);
            const T nu = std::max(static_cast<T>(0.01), std::min(static_cast<T>(0.49), static_cast<T>(mat.poissons_ratio)));
            const T K_parent = E_mod / (static_cast<T>(3.0) * (static_cast<T>(1.0) - static_cast<T>(2.0) * nu));
            const T p_unconf = K_parent * (static_cast<T>(1.0) - J_eff) / std::max(static_cast<T>(0.01), J_eff);
            p_comp = std::max(p_unconf, -sigma_t_rubble);
        }

        q_max = c_residual;
        if (is_concrete || is_geo) {
            q_max = c_residual + static_cast<T>(0.60) * std::max(static_cast<T>(0.0), p_comp);
        } else if (model == MPMMaterialModel::JohnsonCookMieGruneisen ||
                   model == MPMMaterialModel::SteinbergGuinan ||
                   model == MPMMaterialModel::Hypoelastic ||
                   model == MPMMaterialModel::LinearElastic) {
            const T sig_y = (model == MPMMaterialModel::JohnsonCookMieGruneisen)
                ? static_cast<T>(mat.jc_A)
                : ((model == MPMMaterialModel::SteinbergGuinan) ? static_cast<T>(mat.sg_Y0) : static_cast<T>(mat.yield_stress));
            const bool melted = usesMieGruneisenEOS(model) && (mat.T_melt > mat.T_room) &&
                                (state.temperature >= static_cast<T>(mat.T_melt));
            q_max = fractured_metal_residual_strength<T>(p_comp, sig_y, melted);
        }
    }

    template <typename MatType>
    HD_MAT_FUNC static void clampFailedDeviatoricTransition(
        const MatType& mat,
        ConstitutiveState3D<T>& state,
        const T s_dev_in[3][3]
    ) {
        state.has_failed = true;
        state.damage = static_cast<T>(1.0);
        T p_comp = static_cast<T>(0.0), q_max = static_cast<T>(0.0);
        computeFailedDebrisEnvelope(mat, state, p_comp, q_max);

        if (q_max <= static_cast<T>(1.0e-5)) {
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    state.sigma[r][c] = (r == c) ? -p_comp : static_cast<T>(0.0);
            return;
        }

        T s_sq = static_cast<T>(0.0);
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                s_sq += s_dev_in[r][c] * s_dev_in[r][c];
        const T q_cur = std::sqrt(std::max(static_cast<T>(0.0), static_cast<T>(1.5) * s_sq));
        const T scale = (q_cur > q_max && q_cur > static_cast<T>(1.0e-7)) ? (q_max / q_cur) : static_cast<T>(1.0);
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                state.sigma[r][c] = s_dev_in[r][c] * scale - ((r == c) ? p_comp : static_cast<T>(0.0));
    }

    template <typename MatType>
    HD_MAT_FUNC static void handleFailedDebris(
        const MatType& mat,
        ConstitutiveState3D<T>& state,
        const T deps[3][3],
        const T W_spin[3][3],
        T dt
    ) {
        state.has_failed = true;
        state.damage = static_cast<T>(1.0);

        T p_comp = static_cast<T>(0.0), q_max = static_cast<T>(0.0);
        computeFailedDebrisEnvelope(mat, state, p_comp, q_max);

        if (q_max <= static_cast<T>(1.0e-5)) {
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    state.sigma[r][c] = (r == c) ? -p_comp : static_cast<T>(0.0);
            return;
        }

        const T E_mod = mat.youngs_modulus > 0.0f ? static_cast<T>(mat.youngs_modulus) : static_cast<T>(30.0e9);
        const T nu = std::max(static_cast<T>(0.01), std::min(static_cast<T>(0.49), static_cast<T>(mat.poissons_ratio)));
        const T mu_parent = E_mod / (static_cast<T>(2.0) * (static_cast<T>(1.0) + nu));
        const T tr_deps = deps[0][0] + deps[1][1] + deps[2][2];

        T R[3][3], sig_rot[3][3];
        compute_cayley_rotation(W_spin, dt, R);
        rotate_tensor_orthogonal(R, state.sigma, sig_rot);

        T s_trial[3][3];
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                const T d_dev = deps[r][c] - ((r == c) ? tr_deps / static_cast<T>(3.0) : static_cast<T>(0.0));
                s_trial[r][c] = sig_rot[r][c] + static_cast<T>(2.0) * mu_parent * d_dev;
            }
        }
        const T press_s = -(s_trial[0][0] + s_trial[1][1] + s_trial[2][2]) / static_cast<T>(3.0);
        for (int r = 0; r < 3; ++r) s_trial[r][r] += press_s;

        T s_sq = static_cast<T>(0.0);
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                s_sq += s_trial[r][c] * s_trial[r][c];
        const T q_trial = std::sqrt(std::max(static_cast<T>(0.0), static_cast<T>(1.5) * s_sq));
        const T scale = (q_trial > q_max && q_trial > static_cast<T>(1.0e-7)) ? (q_max / q_trial) : static_cast<T>(1.0);
        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                state.sigma[r][c] = s_trial[r][c] * scale - ((r == c) ? p_comp : static_cast<T>(0.0));
            }
        }
    }

    template <typename MatType>
    HD_MAT_FUNC static void step(
        const MatType& mat,
        ConstitutiveState3D<T>& state,
        const T deps[3][3],
        const T W_spin[3][3],
        const T L_grad[3][3],
        T dt,
        T h_elem,
        T weibull_factor = static_cast<T>(1.0),
        bool rotate_and_advance_kinematics = true
    ) {
        const MPMMaterialModel model = mat.material_model;
        const T dt_safe = std::max(static_cast<T>(1.0e-12), dt);
        const T tr_deps = deps[0][0] + deps[1][1] + deps[2][2];

        if (state.has_failed && model != MPMMaterialModel::JohnsonHolmquistJH2) {
            handleFailedDebris(mat, state, deps, W_spin, dt);
            return;
        }

        // --- 1. Tait Water / Weakly Compressible Shock Fluid ---
        if (model == MPMMaterialModel::TaitWater) {
            const T rho0 = std::max(static_cast<T>(1.0), static_cast<T>(mat.tait_rho0));
            T p_hydro = static_cast<T>(0.0);
            T sig_tait[3][3]{};
            update_constitutive_tait_fluid<T>(
                static_cast<T>(mat.tait_B), static_cast<T>(mat.tait_gamma), rho0,
                static_cast<T>(mat.tait_viscosity), static_cast<T>(mat.tait_p_cav),
                static_cast<T>(mat.tait_gruneisen), mat.tait_variant,
                state.J, dt, h_elem, state.e_internal, deps, sig_tait, p_hydro,
                mat.bulk_viscosity_b1 > 0.0f ? static_cast<T>(mat.bulk_viscosity_b1) : static_cast<T>(0.06),
                mat.bulk_viscosity_b2 > 0.0f ? static_cast<T>(mat.bulk_viscosity_b2) : static_cast<T>(1.20),
                static_cast<T>(mat.tait_p0)
            );
            const T rho_p = rho0 / std::max(static_cast<T>(0.05), state.J);
            T work_rate = static_cast<T>(0.0);
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    work_rate += sig_tait[r][c] * (deps[r][c] / dt_safe);
            state.e_internal = std::max(static_cast<T>(0.0), state.e_internal + (work_rate / rho_p) * dt);
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    state.sigma[r][c] = sig_tait[r][c];
            return;
        }

        // --- 1b. Ideal Gas EOS (Continuum Particle / Lagrangian Air) ---
        if (model == MPMMaterialModel::IdealGas) {
            const T gamma_g = static_cast<T>(mat.ideal_gamma > 1.0f ? mat.ideal_gamma : ((mat.tait_gamma > 1.0f && mat.tait_gamma < 5.0f) ? mat.tait_gamma : 1.4f));
            const T rho0 = std::max(static_cast<T>(0.01), static_cast<T>(mat.density));
            const T J_eff = std::max(static_cast<T>(0.02), state.J);
            const T rho = rho0 / J_eff;
            const T p0 = static_cast<T>(mat.tait_p0 > 0.0f ? mat.tait_p0 : 101325.0f);
            if (state.e_internal <= static_cast<T>(0.0)) {
                state.e_internal = p0 / ((gamma_g - static_cast<T>(1.0)) * rho0);
            }
            const T p_caloric = (gamma_g - static_cast<T>(1.0)) * rho * state.e_internal;
            const T tr_D = tr_deps / dt_safe;
            const T c_gas = std::sqrt(std::max(static_cast<T>(1.0), gamma_g * std::max(static_cast<T>(100.0), p_caloric) / rho));
            T q_visc_g = static_cast<T>(0.0);
            if (tr_D < static_cast<T>(0.0)) {
                const T b1_v = mat.bulk_viscosity_b1 > 0.0f ? static_cast<T>(mat.bulk_viscosity_b1) : static_cast<T>(0.06);
                const T b2_v = mat.bulk_viscosity_b2 > 0.0f ? static_cast<T>(mat.bulk_viscosity_b2) : static_cast<T>(1.20);
                q_visc_g = b1_v * rho * c_gas * h_elem * (-tr_D) + b2_v * rho * h_elem * h_elem * tr_D * tr_D;
            }
            const T p_tot = std::max(static_cast<T>(0.0), p_caloric + q_visc_g);
            state.e_internal = std::max(static_cast<T>(1.0), state.e_internal - (p_tot / rho) * tr_deps);
            const T p_new = std::max(static_cast<T>(0.0), (gamma_g - static_cast<T>(1.0)) * rho * state.e_internal + q_visc_g);
            const T mu_air = (mat.tait_viscosity > 0.0f && mat.tait_viscosity < 1.0e-3f) ? static_cast<T>(mat.tait_viscosity) : static_cast<T>(1.81e-5);
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    const T d_dev_rc = (deps[r][c] - ((r == c) ? tr_deps / static_cast<T>(3.0) : static_cast<T>(0.0))) / dt_safe;
                    state.sigma[r][c] = static_cast<T>(2.0) * mu_air * d_dev_rc - ((r == c) ? p_new : static_cast<T>(0.0));
                }
            }
            return;
        }

        // --- 2. Hyperelastic Finite Strain Models (Yeoh & Mooney-Rivlin using total F) ---
        if (model == MPMMaterialModel::HyperelasticYeoh ||
            model == MPMMaterialModel::HyperelasticMooneyRivlin) {
            if (rotate_and_advance_kinematics) {
                applyDeformationGradientUpdate<MatType>(L_grad, dt, state.F_total);
                state.J = std::max(static_cast<T>(1.0e-4), mat3_det(state.F_total));
            }
            if (model == MPMMaterialModel::HyperelasticYeoh) {
                update_constitutive_yeoh<T>(
                    static_cast<T>(mat.yeoh_c10), static_cast<T>(mat.yeoh_c20),
                    static_cast<T>(mat.yeoh_c30), static_cast<T>(mat.k_bulk),
                    state.F_total, state.sigma
                );
            } else {
                update_constitutive_mooney_rivlin<T>(
                    static_cast<T>(mat.mr_c10), static_cast<T>(mat.mr_c01),
                    static_cast<T>(mat.k_bulk),
                    state.F_total, state.sigma
                );
            }
            return;
        }

        // --- Prepare Rotated Stress Frame for Hypoelastic / Elastoplastic / Brittle Formulations ---
        T sig_base[3][3];
        T R_rot[3][3];
        if (rotate_and_advance_kinematics) {
            compute_cayley_rotation(W_spin, dt, R_rot);
            rotate_tensor_orthogonal(R_rot, state.sigma, sig_base);
        } else {
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c) {
                    sig_base[r][c] = state.sigma[r][c];
                    R_rot[r][c] = (r == c) ? static_cast<T>(1.0) : static_cast<T>(0.0);
                }
        }

        const T E_mod = std::max(static_cast<T>(1.0e3), static_cast<T>(mat.youngs_modulus));
        const T nu = std::max(static_cast<T>(0.0), std::min(static_cast<T>(0.49999), static_cast<T>(mat.poissons_ratio)));
        const T G_shear = E_mod / (static_cast<T>(2.0) * (static_cast<T>(1.0) + nu));
        const T K_bulk = E_mod / (static_cast<T>(3.0) * (static_cast<T>(1.0) - static_cast<T>(2.0) * nu));

        T deps_dev[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                deps_dev[r][c] = deps[r][c] - ((r == c) ? tr_deps / static_cast<T>(3.0) : static_cast<T>(0.0));

        const T eps_dot_eq = std::sqrt(std::max(static_cast<T>(0.0), (static_cast<T>(2.0) / static_cast<T>(3.0)) * (
            deps_dev[0][0] * deps_dev[0][0] + deps_dev[1][1] * deps_dev[1][1] + deps_dev[2][2] * deps_dev[2][2] +
            static_cast<T>(2.0) * (deps_dev[0][1] * deps_dev[0][1] + deps_dev[0][2] * deps_dev[0][2] + deps_dev[1][2] * deps_dev[1][2])
        ))) / dt_safe;
        const T w_factor = (mat.enable_heterogeneity && weibull_factor > static_cast<T>(1.0e-3)) ? weibull_factor : static_cast<T>(1.0);
        const T h_c = (h_elem > static_cast<T>(1.0e-6))
            ? h_elem
            : (mat.cdp_l_ch > 0.0f ? static_cast<T>(mat.cdp_l_ch) : static_cast<T>(0.05));

        // --- 3. Linear Elastic ---
        if (model == MPMMaterialModel::LinearElastic) {
            T s_trial[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_trial[r][c] = sig_base[r][c] + static_cast<T>(2.0) * G_shear * deps_dev[r][c];
            const T p_s = -(s_trial[0][0] + s_trial[1][1] + s_trial[2][2]) / static_cast<T>(3.0);
            for (int r = 0; r < 3; ++r) s_trial[r][r] += p_s;

            const T J_eff = std::max(static_cast<T>(0.01), state.J);
            const T p_hydro = K_bulk * (static_cast<T>(1.0) - J_eff) / J_eff;
            for (int r = 0; r < 3; ++r) s_trial[r][r] -= p_hydro;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    state.sigma[r][c] = s_trial[r][c];
            return;
        }

        // --- 4. Hill48 Orthotropic Plasticity with Corotational Local Frame ---
        if (model == MPMMaterialModel::Hill48Orthotropic) {
            if (rotate_and_advance_kinematics) {
                const T a_rot[3] = {
                    R_rot[0][0] * state.hill_a[0] + R_rot[0][1] * state.hill_a[1] + R_rot[0][2] * state.hill_a[2],
                    R_rot[1][0] * state.hill_a[0] + R_rot[1][1] * state.hill_a[1] + R_rot[1][2] * state.hill_a[2],
                    R_rot[2][0] * state.hill_a[0] + R_rot[2][1] * state.hill_a[1] + R_rot[2][2] * state.hill_a[2]
                };
                const T b_rot[3] = {
                    R_rot[0][0] * state.hill_b[0] + R_rot[0][1] * state.hill_b[1] + R_rot[0][2] * state.hill_b[2],
                    R_rot[1][0] * state.hill_b[0] + R_rot[1][1] * state.hill_b[1] + R_rot[1][2] * state.hill_b[2],
                    R_rot[2][0] * state.hill_b[0] + R_rot[2][1] * state.hill_b[1] + R_rot[2][2] * state.hill_b[2]
                };
                for (int k = 0; k < 3; ++k) {
                    state.hill_a[k] = a_rot[k];
                    state.hill_b[k] = b_rot[k];
                }
            }
            T Q[3][3];
            orthonormalize_hill_triad(state.hill_a, state.hill_b, Q);
            T deps_loc[3][3], sig_loc[3][3];
            mat3_rotate_to_local(Q, deps, deps_loc);
            mat3_rotate_to_local(Q, sig_base, sig_loc);

            update_constitutive_hill48<T>(
                static_cast<T>(mat.hill_F), static_cast<T>(mat.hill_G), static_cast<T>(mat.hill_H),
                static_cast<T>(mat.hill_L), static_cast<T>(mat.hill_M), static_cast<T>(mat.hill_N),
                static_cast<T>(mat.hill_sigma_y0), deps_loc, sig_loc, state.ep_bar,
                E_mod, nu, static_cast<T>(mat.hardening_modulus)
            );
            mat3_rotate_to_global(Q, sig_loc, state.sigma);
            return;
        }

        // --- 5. Concrete Damage Plasticity (CDP) with Spectral Crack Closure ---
        if (model == MPMMaterialModel::ConcreteDamagePlasticity) {
            const T f_t0 = std::max(static_cast<T>(1.0e3), static_cast<T>(mat.cdp_f_t0) * w_factor);
            const T f_c0 = std::max(static_cast<T>(1.0e4), static_cast<T>(mat.cdp_f_c0) * w_factor);
            const T G_f_cdp = std::max(static_cast<T>(1.0e-3), static_cast<T>(mat.cdp_g_f));
            const T l_ch_cdp = mat.directional_crack_band
                ? h_c
                : (mat.cdp_l_ch > 0.0f ? static_cast<T>(mat.cdp_l_ch) : h_c);

            T ep_t = std::max(static_cast<T>(0.0), state.lambda);
            T ep_c = std::max(static_cast<T>(0.0), state.ep_bar - ep_t);
            const T eps_t_init = f_t0 / (E_mod + static_cast<T>(1.0e-12));
            const T eps_t_u = (static_cast<T>(2.0) * G_f_cdp) / (f_t0 * std::max(static_cast<T>(1.0e-5), l_ch_cdp) + static_cast<T>(1.0e-12));
            const T eps_t_span = std::max(static_cast<T>(0.2) * eps_t_init, eps_t_u - eps_t_init);
            T d_t = (ep_t > eps_t_init)
                ? std::min(static_cast<T>(0.99), (ep_t - eps_t_init) / (eps_t_span + static_cast<T>(1.0e-12)))
                : static_cast<T>(0.0);
            const T eps_c_peak = f_c0 / (E_mod + static_cast<T>(1.0e-12));
            T d_c = (ep_c > eps_c_peak)
                ? std::min(static_cast<T>(0.95), (ep_c - eps_c_peak) / (static_cast<T>(4.0) * eps_c_peak + static_cast<T>(1.0e-12)))
                : static_cast<T>(0.0);

            update_constitutive_cdp<T>(
                E_mod, nu, f_t0, f_c0, G_f_cdp, l_ch_cdp,
                deps, sig_base, d_t, d_c, ep_t, ep_c
            );

            state.lambda = ep_t;
            state.ep_bar = ep_t + ep_c;
            state.damage = std::max(d_t, d_c);
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    state.sigma[r][c] = sig_base[r][c];
            return;
        }

        // --- 6. Geomaterial Models: Drucker-Prager, Mohr-Coulomb, GeologicalCap, Hoek-Brown ---
        if (isGeomaterialModel(model)) {
            const T deg_to_rad = static_cast<T>(0.01745329251994329577);
            DruckerPragerParams<T> dp;
            dp.cohesion = static_cast<T>(mat.dp_cohesion) * w_factor;
            dp.friction_angle = static_cast<T>(mat.dp_friction_angle) * deg_to_rad;
            dp.dilatancy_angle = static_cast<T>(mat.dp_dilatancy_angle) * deg_to_rad;
            dp.tensile_cutoff = static_cast<T>(mat.dp_tensile_cutoff) * w_factor;
            dp.H_plastic = static_cast<T>(mat.dp_hardening_modulus);

            if (model == MPMMaterialModel::MohrCoulomb) {
                update_constitutive_mohr_coulomb<T>(E_mod, nu, dp, deps, sig_base, state.ep_bar);
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        state.sigma[r][c] = sig_base[r][c];
                return;
            }
            if (model == MPMMaterialModel::HoekBrownRock) {
                const T sci = (mat.hb_sigma_ci > 0.0f ? static_cast<T>(mat.hb_sigma_ci) : std::max(static_cast<T>(1.0e6), static_cast<T>(mat.fc))) * w_factor;
                update_constitutive_hoek_brown<T>(
                    E_mod, nu, sci, static_cast<T>(mat.hb_mi),
                    static_cast<T>(mat.hb_gsi), static_cast<T>(mat.hb_D),
                    dp.dilatancy_angle, dp.tensile_cutoff, deps, sig_base, state.ep_bar
                );
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        state.sigma[r][c] = sig_base[r][c];
                return;
            }

            // DruckerPragerSoil and GeologicalCap operate on (p_hydro, s_dev)
            T p_hydro = -(sig_base[0][0] + sig_base[1][1] + sig_base[2][2]) / static_cast<T>(3.0);
            T s_dev[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_dev[r][c] = sig_base[r][c] + ((r == c) ? p_hydro : static_cast<T>(0.0));

            if (model == MPMMaterialModel::GeologicalCap) {
                update_constitutive_geological_cap<T>(
                    E_mod, nu, dp,
                    static_cast<T>(mat.cap_X0), static_cast<T>(mat.cap_W),
                    static_cast<T>(mat.cap_D1), static_cast<T>(mat.cap_D2), static_cast<T>(mat.cap_R),
                    deps, s_dev, p_hydro, state.lambda, state.ep_bar
                );
            } else {
                update_constitutive_drucker_prager<T>(
                    E_mod, nu, dp, deps, s_dev, p_hydro, state.ep_bar
                );
            }
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    state.sigma[r][c] = s_dev[r][c] - ((r == c) ? p_hydro : static_cast<T>(0.0));
            return;
        }

        // --- 7. Deshpande-Fleck Crushable Foam ---
        if (model == MPMMaterialModel::CrushableFoam) {
            T p_hydro = -(sig_base[0][0] + sig_base[1][1] + sig_base[2][2]) / static_cast<T>(3.0);
            T s_dev[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_dev[r][c] = sig_base[r][c] + ((r == c) ? p_hydro : static_cast<T>(0.0));

            const T plateau = (mat.foam_plateau_stress > 0.0f ? static_cast<T>(mat.foam_plateau_stress) : static_cast<T>(mat.yield_stress)) * w_factor;
            const T t_cut = static_cast<T>(mat.dp_tensile_cutoff > 0.0f ? mat.dp_tensile_cutoff : mat.tensile_failure_stress);
            update_constitutive_crushable_foam<T>(
                E_mod, nu, plateau,
                static_cast<T>(mat.foam_densification_strain),
                static_cast<T>(mat.foam_alpha),
                static_cast<T>(mat.foam_hardening),
                t_cut, deps, s_dev, p_hydro, state.lambda, state.ep_bar
            );
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    state.sigma[r][c] = s_dev[r][c] - ((r == c) ? p_hydro : static_cast<T>(0.0));
            return;
        }

        // --- 8. Johnson-Holmquist II (JH-2) Ceramics & Brittle Glass ---
        if (model == MPMMaterialModel::JohnsonHolmquistJH2) {
            T p_hydro = -(sig_base[0][0] + sig_base[1][1] + sig_base[2][2]) / static_cast<T>(3.0);
            T s_dev[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_dev[r][c] = sig_base[r][c] + ((r == c) ? p_hydro : static_cast<T>(0.0));

            const T K1_val = mat.jh2_K1 > 0.0f ? static_cast<T>(mat.jh2_K1) : K_bulk;
            update_constitutive_jh2<T>(
                G_shear, eps_dot_eq, state.J,
                static_cast<T>(mat.jh2_sigma_hel) * w_factor,
                static_cast<T>(mat.jh2_p_hel),
                static_cast<T>(mat.jh2_t_max) * w_factor,
                static_cast<T>(mat.jh2_A), static_cast<T>(mat.jh2_N),
                static_cast<T>(mat.jh2_B), static_cast<T>(mat.jh2_M),
                static_cast<T>(mat.jh2_C), static_cast<T>(mat.jh2_D1),
                static_cast<T>(mat.jh2_D2), K1_val,
                static_cast<T>(mat.jh2_K2), static_cast<T>(mat.jh2_K3),
                static_cast<T>(mat.jh2_beta),
                deps, s_dev, p_hydro, state.ep_bar, state.damage, state.lambda
            );
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    state.sigma[r][c] = s_dev[r][c] - ((r == c) ? p_hydro : static_cast<T>(0.0));
            return;
        }

        // --- 9. Steinberg-Guinan High-Pressure Shock Metal (*MAT_011) ---
        if (model == MPMMaterialModel::SteinbergGuinan) {
            const T J_eff = std::max(static_cast<T>(0.25), state.J);
            const T mu_vol = (static_cast<T>(1.0) - J_eff) / J_eff;
            T p_hydro = (mu_vol > static_cast<T>(0.0) && mat.mg_c0 > 0.0f)
                ? mie_gruneisen_compression_pressure<T>(
                    static_cast<T>(mat.density), static_cast<T>(mat.mg_c0),
                    static_cast<T>(mat.mg_s), static_cast<T>(mat.mg_gamma0), mu_vol, state.e_internal)
                : ((mat.mg_c0 > 0.0f) ? (static_cast<T>(mat.density) * static_cast<T>(mat.mg_c0) * static_cast<T>(mat.mg_c0) * mu_vol)
                                      : (K_bulk * mu_vol));

            const T p_s = -(sig_base[0][0] + sig_base[1][1] + sig_base[2][2]) / static_cast<T>(3.0);
            T s_dev[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_dev[r][c] = sig_base[r][c] + ((r == c) ? p_s : static_cast<T>(0.0));

            const T sg_Y0 = (mat.sg_Y0 > 0.0f ? static_cast<T>(mat.sg_Y0) : static_cast<T>(mat.yield_stress)) * w_factor;
            const T sg_Ymax = static_cast<T>(mat.sg_Ymax) * w_factor;
            const T ep_prev = state.ep_bar;

            update_constitutive_steinberg_guinan<T>(
                G_shear, state.temperature, static_cast<T>(mat.T_melt), J_eff,
                sg_Y0, sg_Ymax, static_cast<T>(mat.sg_beta), static_cast<T>(mat.sg_n),
                static_cast<T>(mat.sg_bp), static_cast<T>(mat.sg_bT), p_hydro,
                deps, s_dev, state.ep_bar
            );

            const T d_ep = std::max(static_cast<T>(0.0), state.ep_bar - ep_prev);
            if (d_ep > static_cast<T>(0.0) && mat.density > 0.0f && mat.Cp > 0.0f) {
                const T q_y = std::max(sg_Y0, std::sqrt(static_cast<T>(1.5) * (
                    s_dev[0][0]*s_dev[0][0] + s_dev[1][1]*s_dev[1][1] + s_dev[2][2]*s_dev[2][2] +
                    static_cast<T>(2.0) * (s_dev[0][1]*s_dev[0][1] + s_dev[0][2]*s_dev[0][2] + s_dev[1][2]*s_dev[1][2]))));
                state.e_internal += (static_cast<T>(0.90) * q_y * d_ep) / static_cast<T>(mat.density);
                state.temperature = static_cast<T>(mat.T_room) + state.e_internal / static_cast<T>(mat.Cp);
            }

            if (mat.enable_strain_erosion) {
                if (mat.erosion_strain > 0.0f) {
                    state.damage = std::max(state.damage, std::min(static_cast<T>(1.0), state.ep_bar / static_cast<T>(mat.erosion_strain)));
                } else if (mat.failure_strain > 0.0f && d_ep > static_cast<T>(0.0)) {
                    state.damage = std::min(static_cast<T>(1.0), state.damage + d_ep / static_cast<T>(mat.failure_strain * w_factor));
                }
            }
            const T fail_stress = ((mat.enable_stress_erosion && mat.erosion_stress > 0.0f) ? static_cast<T>(mat.erosion_stress) : static_cast<T>(mat.tensile_failure_stress)) * w_factor;
            if (fail_stress > static_cast<T>(0.0) && p_hydro < -fail_stress) {
                if (mat.enable_stress_erosion) {
                    state.damage = std::max(state.damage, std::min(static_cast<T>(1.0), (-p_hydro) / fail_stress));
                }
                p_hydro = std::max(p_hydro, -fail_stress * std::max(static_cast<T>(0.0), static_cast<T>(1.0) - state.damage));
            }
            if (state.damage >= static_cast<T>(1.0)) {
                clampFailedDeviatoricTransition(mat, state, s_dev);
            } else {
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        state.sigma[r][c] = s_dev[r][c] - ((r == c) ? p_hydro : static_cast<T>(0.0));
            }
            return;
        }

        // --- 10. Johnson-Cook + Mie-Gruneisen Metal ---
        if (model == MPMMaterialModel::JohnsonCookMieGruneisen) {
            const T J_eff = std::max(static_cast<T>(0.25), state.J);
            const T mu_vol = (static_cast<T>(1.0) - J_eff) / J_eff;
            T p_hydro = (mu_vol > static_cast<T>(0.0) && mat.mg_c0 > 0.0f)
                ? mie_gruneisen_compression_pressure<T>(
                    static_cast<T>(mat.density), static_cast<T>(mat.mg_c0),
                    static_cast<T>(mat.mg_s), static_cast<T>(mat.mg_gamma0), mu_vol, state.e_internal)
                : ((mat.mg_c0 > 0.0f) ? (static_cast<T>(mat.density) * static_cast<T>(mat.mg_c0) * static_cast<T>(mat.mg_c0) * mu_vol)
                                      : (K_bulk * mu_vol));

            T T_star = (state.temperature - static_cast<T>(mat.T_room)) / std::max(static_cast<T>(1.0), static_cast<T>(mat.T_melt) - static_cast<T>(mat.T_room));
            T_star = std::max(static_cast<T>(0.0), std::min(static_cast<T>(1.0), T_star));
            if (T_star >= static_cast<T>(1.0)) {
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        state.sigma[r][c] = (r == c) ? -p_hydro : static_cast<T>(0.0);
                return;
            }

            const T p_s = -(sig_base[0][0] + sig_base[1][1] + sig_base[2][2]) / static_cast<T>(3.0);
            T s_trial[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_trial[r][c] = sig_base[r][c] + ((r == c) ? p_s : static_cast<T>(0.0)) + static_cast<T>(2.0) * G_shear * deps_dev[r][c];

            T s_sq = static_cast<T>(0.0);
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_sq += s_trial[r][c] * s_trial[r][c];
            const T q_trial = std::sqrt(std::max(static_cast<T>(0.0), static_cast<T>(1.5) * s_sq));

            T aniso_factor = static_cast<T>(1.0);
            if (mat.enable_anisotropy && std::abs(mat.anisotropy_ratio - 1.0f) > 1.0e-3f) {
                const T ax = static_cast<T>(mat.anisotropy_dir[0]);
                const T ay = static_cast<T>(mat.anisotropy_dir[1]);
                const T az = static_cast<T>(mat.anisotropy_dir[2]);
                const T sigma_a = ax * (s_trial[0][0]*ax + s_trial[0][1]*ay + s_trial[0][2]*az) +
                                  ay * (s_trial[1][0]*ax + s_trial[1][1]*ay + s_trial[1][2]*az) +
                                  az * (s_trial[2][0]*ax + s_trial[2][1]*ay + s_trial[2][2]*az);
                const T q_norm = (q_trial > static_cast<T>(1.0e-12)) ? q_trial : static_cast<T>(1.0);
                const T xi = std::max(static_cast<T>(0.0), std::min(static_cast<T>(1.0), std::abs(sigma_a) / q_norm));
                aniso_factor = static_cast<T>(1.0) + (static_cast<T>(mat.anisotropy_ratio) - static_cast<T>(1.0)) * (static_cast<T>(1.0) - xi * xi);
            }

            const T A = static_cast<T>(mat.jc_A);
            const T B = static_cast<T>(mat.jc_B);
            const T n = static_cast<T>(mat.jc_n);
            const T C = static_cast<T>(mat.jc_C);
            const T m = static_cast<T>(mat.jc_m);

            const T eps_dot_star = std::max(static_cast<T>(1.0e-5), eps_dot_eq);
            const T ep_pos = std::max(static_cast<T>(0.0), state.ep_bar);
            const T hard_term = (B > static_cast<T>(0.0) && ep_pos > static_cast<T>(0.0))
                ? (B * (n > static_cast<T>(0.0) ? std::pow(ep_pos, n) : static_cast<T>(1.0)))
                : static_cast<T>(0.0);
            const T strain_term = A + hard_term;
            const T rate_term = (eps_dot_star > static_cast<T>(1.0)) ? (static_cast<T>(1.0) + C * std::log(eps_dot_star)) : static_cast<T>(1.0);
            const T temp_term = (m > static_cast<T>(0.0) && T_star > static_cast<T>(0.0))
                ? (static_cast<T>(1.0) - std::pow(T_star, m))
                : static_cast<T>(1.0);
            const T jc_yield = strain_term * rate_term * temp_term * aniso_factor;

            const T fail_strain_base = ((mat.enable_strain_erosion && mat.erosion_strain > 0.0f) ? static_cast<T>(mat.erosion_strain) : static_cast<T>(mat.failure_strain)) * w_factor * aniso_factor;
            const T tensile_fail_base = ((mat.enable_stress_erosion && mat.erosion_stress > 0.0f) ? static_cast<T>(mat.erosion_stress) : static_cast<T>(mat.tensile_failure_stress)) * w_factor * aniso_factor;
            const T p_spall_limit = std::max(tensile_fail_base, static_cast<T>(1.5) * A * w_factor * aniso_factor);
            const T p_hydro_raw = p_hydro;
            if (p_spall_limit > static_cast<T>(0.0) && p_hydro < static_cast<T>(0.0)) {
                p_hydro = std::max(p_hydro, -p_spall_limit * std::max(static_cast<T>(0.0), static_cast<T>(1.0) - state.damage));
            }

            T delta_ep = static_cast<T>(0.0);
            if (q_trial > jc_yield) {
                const T ep_eval = std::max(static_cast<T>(1.0e-4), state.ep_bar);
                const T H_jc = (B > static_cast<T>(0.0) && n > static_cast<T>(0.0))
                    ? std::min(static_cast<T>(10.0) * G_shear, B * n * std::pow(ep_eval, n - static_cast<T>(1.0)) * rate_term * temp_term * aniso_factor)
                    : static_cast<T>(0.0);
                delta_ep = (q_trial - jc_yield) / std::max(static_cast<T>(1.0), static_cast<T>(3.0) * G_shear + H_jc);
                const T scale = (q_trial > static_cast<T>(1.0e-12)) ? (jc_yield / q_trial) : static_cast<T>(0.0);
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        s_trial[r][c] *= scale;
                state.ep_bar += delta_ep;
            }
            if (delta_ep > static_cast<T>(0.0) && mat.density > 0.0f && mat.Cp > 0.0f) {
                state.e_internal += (static_cast<T>(0.90) * jc_yield * delta_ep) / static_cast<T>(mat.density);
                state.temperature = static_cast<T>(mat.T_room) + state.e_internal / static_cast<T>(mat.Cp);
            }

            // Johnson-Cook fracture strain eps_f. Predictable hierarchy (documented in parameter-definitions.ts):
            //   1. failure_strain (or erosion_strain when strain erosion is enabled) > 0  -> it IS the fracture
            //      strain at uniaxial-tension triaxiality (sigma* = 1/3). D1-D3 only supply the *shape* across
            //      stress states (ratio D(sigma*)/D(1/3)); D4/D5 supply the rate / temperature factors.
            //        eps_f = failure_strain * [D(sigma*)/D(1/3)] * (1 + D4 ln eps_dot*) * (1 + D5 T*)
            //   2. failure_strain == 0 and D1/D2 given -> absolute JC locus
            //        eps_f = (D1 + D2 exp(D3 sigma*)) * (1 + D4 ln eps_dot*) * (1 + D5 T*)
            //   3. no D-values and strain erosion enabled -> failure_strain with a simple triaxiality multiplier.
            // This guarantees the failure strain the user types in is the one the solver uses, regardless of
            // whether a preset also carries D-values.
            const bool has_jc_damage = (std::abs(mat.jc_d1) > 0.0f || std::abs(mat.jc_d2) > 0.0f);
            const T jc_flow_undam = std::max(jc_yield, static_cast<T>(1.0e6));
            const T sigma_star = std::max(static_cast<T>(-2.5), std::min(static_cast<T>(2.5), -p_hydro_raw / jc_flow_undam));
            const T jc_rate_f = std::max(static_cast<T>(0.1), static_cast<T>(1.0) + static_cast<T>(mat.jc_d4) * std::log(std::max(static_cast<T>(1.0), eps_dot_star)));
            const T jc_temp_f = std::max(static_cast<T>(0.1), static_cast<T>(1.0) + static_cast<T>(mat.jc_d5) * T_star);

            T eps_f = static_cast<T>(0.0);
            if (has_jc_damage && fail_strain_base > static_cast<T>(0.0)) {
                // fail_strain_base already carries the Weibull / anisotropy scatter factors.
                const T triax_ratio = jc_fracture_triaxiality_ratio<T>(
                    static_cast<T>(mat.jc_d1), static_cast<T>(mat.jc_d2), static_cast<T>(mat.jc_d3), sigma_star);
                eps_f = std::max(static_cast<T>(1.0e-4), fail_strain_base * triax_ratio * jc_rate_f * jc_temp_f);
            } else if (has_jc_damage) {
                const T exp_arg = std::max(static_cast<T>(-30.0), std::min(static_cast<T>(30.0), static_cast<T>(mat.jc_d3) * sigma_star));
                const T jc_triax = std::max(static_cast<T>(1.0e-4), static_cast<T>(mat.jc_d1) + static_cast<T>(mat.jc_d2) * std::exp(exp_arg));
                eps_f = std::max(static_cast<T>(1.0e-4), jc_triax * jc_rate_f * jc_temp_f * w_factor * aniso_factor);
            } else if (mat.enable_strain_erosion && fail_strain_base > static_cast<T>(0.0)) {
                const T triax_mult = (sigma_star >= static_cast<T>(0.33))
                    ? static_cast<T>(1.0)
                    : ((sigma_star >= static_cast<T>(0.0)) ? (static_cast<T>(2.0) - static_cast<T>(3.0) * sigma_star) : static_cast<T>(4.0));
                eps_f = std::max(static_cast<T>(1.0e-4), fail_strain_base * triax_mult);
            }

            if (delta_ep > static_cast<T>(0.0) && eps_f > static_cast<T>(0.0)) {
                state.damage = std::min(static_cast<T>(1.0), state.damage + delta_ep / eps_f);
            }
            if (mat.enable_strain_erosion && fail_strain_base > static_cast<T>(0.0)) {
                state.damage = std::max(state.damage, std::max(static_cast<T>(0.0), std::min(static_cast<T>(1.0), state.ep_bar / fail_strain_base)));
            }
            if (p_spall_limit > static_cast<T>(0.0) && (-p_hydro_raw) > p_spall_limit) {
                if (mat.enable_stress_erosion) {
                    state.damage = std::max(state.damage, std::min((-p_hydro_raw) / p_spall_limit, static_cast<T>(1.0)));
                } else if (J_eff > static_cast<T>(1.025) && tr_deps > static_cast<T>(0.0)) {
                    const T spall_over = ((-p_hydro_raw) - p_spall_limit) / p_spall_limit;
                    state.damage = std::min(static_cast<T>(1.0), state.damage + static_cast<T>(0.5) * spall_over);
                }
            }
            if (p_spall_limit > static_cast<T>(0.0) && p_hydro < static_cast<T>(0.0)) {
                p_hydro = std::max(p_hydro, -p_spall_limit * std::max(static_cast<T>(0.0), static_cast<T>(1.0) - state.damage));
            }
            if (state.damage >= static_cast<T>(1.0)) {
                clampFailedDeviatoricTransition(mat, state, s_trial);
            } else {
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        state.sigma[r][c] = s_trial[r][c] - ((r == c) ? p_hydro : static_cast<T>(0.0));
            }
            return;
        }

        // --- 11. Concrete Models (RHT, K&C, CSCM) ---
        const T lame_lam = (E_mod * nu) / ((static_cast<T>(1.0) + nu) * (static_cast<T>(1.0) - static_cast<T>(2.0) * nu));
        T sig_trial[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                sig_trial[r][c] = sig_base[r][c] + static_cast<T>(2.0) * G_shear * deps[r][c] + ((r == c) ? lame_lam * tr_deps : static_cast<T>(0.0));

        T press = -(sig_trial[0][0] + sig_trial[1][1] + sig_trial[2][2]) / static_cast<T>(3.0);
        T s[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                s[r][c] = sig_trial[r][c] + ((r == c) ? press : static_cast<T>(0.0));

        if (model == MPMMaterialModel::RHTConcrete) {
            Blast::ConcreteModels::RHTStateVariables<T> rht_state;
            rht_state.damage = state.damage;
            rht_state.ep_bar = state.ep_bar;
            rht_state.p_hydro = press;
            Blast::ConcreteModels::updateRHTStress<T>(
                s, press, tr_deps, dt_safe, h_c, eps_dot_eq,
                static_cast<T>(mat.fc) * w_factor, static_cast<T>(mat.ft) * w_factor, G_shear, K_bulk,
                static_cast<T>(mat.G_f), static_cast<T>(mat.moisture_content),
                static_cast<T>(mat.rht_A), static_cast<T>(mat.rht_N),
                static_cast<T>(mat.rht_B), static_cast<T>(mat.rht_M),
                static_cast<T>(mat.rht_Q0), static_cast<T>(mat.rht_BQ),
                static_cast<T>(mat.rht_D1), static_cast<T>(mat.rht_D2),
                static_cast<T>(mat.rht_p_crush), static_cast<T>(mat.rht_p_lock),
                static_cast<T>(mat.rht_alpha0), static_cast<T>(mat.rht_n_comp),
                static_cast<T>(mat.rht_betac), static_cast<T>(mat.rht_deltat),
                static_cast<T>(mat.dif_cap_compression), static_cast<T>(mat.dif_cap_tension),
                rht_state,
                static_cast<T>(mat.rht_f_el_c)
            );
            state.damage = rht_state.damage;
            state.ep_bar = rht_state.ep_bar;
            press = rht_state.p_hydro;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    state.sigma[r][c] = s[r][c] - ((r == c) ? press : static_cast<T>(0.0));
            return;
        }
        if (model == MPMMaterialModel::KCConcrete) {
            Blast::ConcreteModels::KCStateVariables<T> kc_state;
            kc_state.damage = state.damage;
            kc_state.lambda = state.lambda;
            kc_state.ep_bar = state.ep_bar;
            kc_state.p_hydro = press;
            Blast::ConcreteModels::updateKCStress<T>(
                s, press, tr_deps, dt_safe, h_c, eps_dot_eq,
                static_cast<T>(mat.fc) * w_factor, static_cast<T>(mat.ft) * w_factor, G_shear, K_bulk,
                static_cast<T>(mat.G_f), static_cast<T>(mat.moisture_content),
                mat.kc_auto_generate,
                static_cast<T>(mat.kc_a0), static_cast<T>(mat.kc_a1), static_cast<T>(mat.kc_a2),
                static_cast<T>(mat.kc_a0y), static_cast<T>(mat.kc_a1y), static_cast<T>(mat.kc_a2y),
                static_cast<T>(mat.kc_a1r), static_cast<T>(mat.kc_a2r),
                static_cast<T>(mat.kc_b1), static_cast<T>(mat.kc_omega),
                static_cast<T>(mat.dif_cap_compression), static_cast<T>(mat.dif_cap_tension),
                kc_state
            );
            state.damage = kc_state.damage;
            state.lambda = kc_state.lambda;
            state.ep_bar = kc_state.ep_bar;
            press = kc_state.p_hydro;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    state.sigma[r][c] = s[r][c] - ((r == c) ? press : static_cast<T>(0.0));
            return;
        }
        if (model == MPMMaterialModel::CSCMConcrete) {
            Blast::ConcreteModels::CSCMStateVariables<T> cscm_state;
            cscm_state.damage = state.damage;
            cscm_state.damage_brittle = state.damage;
            cscm_state.damage_ductile = state.damage;
            cscm_state.kappa = state.lambda;
            cscm_state.ep_bar = state.ep_bar;
            cscm_state.p_hydro = press;
            Blast::ConcreteModels::updateCSCMStress<T>(
                s, press, tr_deps, dt_safe, h_c, eps_dot_eq,
                static_cast<T>(mat.fc) * w_factor, static_cast<T>(mat.ft) * w_factor, G_shear, K_bulk,
                static_cast<T>(mat.G_f),
                static_cast<T>(mat.cscm_alpha) * w_factor, static_cast<T>(mat.cscm_theta),
                static_cast<T>(mat.cscm_lambda) * w_factor, static_cast<T>(mat.cscm_beta),
                static_cast<T>(mat.cscm_R), static_cast<T>(mat.cscm_X0),
                static_cast<T>(mat.cscm_W), static_cast<T>(mat.cscm_D1),
                static_cast<T>(mat.cscm_D2),
                static_cast<T>(mat.dif_cap_compression), static_cast<T>(mat.dif_cap_tension),
                cscm_state
            );
            state.damage = cscm_state.damage;
            state.lambda = cscm_state.kappa;
            state.ep_bar = cscm_state.ep_bar;
            press = cscm_state.p_hydro;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    state.sigma[r][c] = s[r][c] - ((r == c) ? press : static_cast<T>(0.0));
            return;
        }

        // --- 12. Default / Hypoelastic J2 (+ Optional Cowper-Symonds Rate Scaling & Fracture) ---
        T s_sq = static_cast<T>(0.0);
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                s_sq += s[r][c] * s[r][c];
        const T q_trial_hypo = std::sqrt(std::max(static_cast<T>(0.0), static_cast<T>(1.5) * s_sq));

        T aniso_factor = static_cast<T>(1.0);
        if (mat.enable_anisotropy && std::abs(mat.anisotropy_ratio - 1.0f) > 1.0e-3f) {
            const T ax = static_cast<T>(mat.anisotropy_dir[0]);
            const T ay = static_cast<T>(mat.anisotropy_dir[1]);
            const T az = static_cast<T>(mat.anisotropy_dir[2]);
            const T sigma_a = ax * (s[0][0]*ax + s[0][1]*ay + s[0][2]*az) +
                              ay * (s[1][0]*ax + s[1][1]*ay + s[1][2]*az) +
                              az * (s[2][0]*ax + s[2][1]*ay + s[2][2]*az);
            const T q_norm = (q_trial_hypo > static_cast<T>(1.0e-12)) ? q_trial_hypo : static_cast<T>(1.0);
            const T xi = std::max(static_cast<T>(0.0), std::min(static_cast<T>(1.0), std::abs(sigma_a) / q_norm));
            aniso_factor = static_cast<T>(1.0) + (static_cast<T>(mat.anisotropy_ratio) - static_cast<T>(1.0)) * (static_cast<T>(1.0) - xi * xi);
        }

        const T yield_base = static_cast<T>(mat.yield_stress) * w_factor;
        const T fail_strain_base = ((mat.enable_strain_erosion && mat.erosion_strain > 0.0f) ? static_cast<T>(mat.erosion_strain) : static_cast<T>(mat.failure_strain)) * w_factor * aniso_factor;
        const T fail_stress = ((mat.enable_stress_erosion && mat.erosion_stress > 0.0f) ? static_cast<T>(mat.erosion_stress) : static_cast<T>(mat.tensile_failure_stress)) * w_factor * aniso_factor;
        const T p_spall_hypo = std::max(fail_stress, static_cast<T>(1.5) * yield_base * aniso_factor);
        const T press_raw = press;
        if (p_spall_hypo > static_cast<T>(0.0) && press < static_cast<T>(0.0)) {
            press = std::max(press, -p_spall_hypo * std::max(static_cast<T>(0.0), static_cast<T>(1.0) - state.damage));
        }

        T cs_rate = static_cast<T>(1.0);
        if (mat.cs_C > 0.0f && mat.cs_P > 0.0f && eps_dot_eq > static_cast<T>(0.0)) {
            const T inv_p = static_cast<T>(1.0) / std::max(static_cast<T>(0.05), static_cast<T>(mat.cs_P));
            cs_rate = static_cast<T>(1.0) + std::pow(eps_dot_eq / static_cast<T>(mat.cs_C), inv_p);
        }

        const T soft_factor = std::max(static_cast<T>(0.10), std::min(static_cast<T>(1.0), static_cast<T>(1.0) - static_cast<T>(0.70) * state.damage));
        const T yield_eff = (yield_base * soft_factor + static_cast<T>(mat.hardening_modulus) * state.ep_bar) * cs_rate * aniso_factor;
        const T yield_surf = q_trial_hypo - yield_eff;

        T delta_ep = static_cast<T>(0.0);
        if (q_trial_hypo > static_cast<T>(1.0e-5) && yield_surf > static_cast<T>(0.0)) {
            const T H_eff = static_cast<T>(mat.hardening_modulus) * cs_rate * aniso_factor;
            delta_ep = yield_surf / std::max(static_cast<T>(1.0), static_cast<T>(3.0) * G_shear + H_eff);
            const T scale = std::max(static_cast<T>(0.0), static_cast<T>(1.0) - (static_cast<T>(3.0) * G_shear * delta_ep) / q_trial_hypo);
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s[r][c] *= scale;
            state.ep_bar += delta_ep;
            if (mat.density > 0.0f) {
                const T cp_h = (mat.Cp > 1.0f) ? static_cast<T>(mat.Cp) : static_cast<T>(470.0);
                const T t_room_h = (mat.T_room > 0.0f) ? static_cast<T>(mat.T_room) : static_cast<T>(293.0);
                state.e_internal += (static_cast<T>(0.90) * yield_eff * delta_ep) / static_cast<T>(mat.density);
                state.temperature = t_room_h + state.e_internal / cp_h;
            }
        }

        if (mat.enable_strain_erosion && delta_ep > static_cast<T>(0.0) && fail_strain_base > static_cast<T>(0.0)) {
            const T sigma_star_h = std::max(static_cast<T>(-2.5), std::min(static_cast<T>(2.5), -press_raw / std::max(yield_base * aniso_factor, static_cast<T>(1.0e6))));
            const T triax_mult = (sigma_star_h >= static_cast<T>(0.33))
                ? static_cast<T>(1.0)
                : ((sigma_star_h >= static_cast<T>(0.0)) ? (static_cast<T>(2.0) - static_cast<T>(3.0) * sigma_star_h) : static_cast<T>(4.0));
            state.damage = std::min(static_cast<T>(1.0), state.damage + delta_ep / std::max(static_cast<T>(1.0e-4), fail_strain_base * triax_mult));
        }
        if (mat.enable_strain_erosion && fail_strain_base > static_cast<T>(0.0)) {
            state.damage = std::max(state.damage, std::max(static_cast<T>(0.0), std::min(static_cast<T>(1.0), state.ep_bar / fail_strain_base)));
        }
        if (p_spall_hypo > static_cast<T>(0.0) && (-press_raw) > p_spall_hypo) {
            if (mat.enable_stress_erosion) {
                state.damage = std::max(state.damage, std::min((-press_raw) / p_spall_hypo, static_cast<T>(1.0)));
            } else if (state.ep_bar > static_cast<T>(0.005) || state.J > static_cast<T>(1.03)) {
                const T spall_over = ((-press_raw) - p_spall_hypo) / p_spall_hypo;
                state.damage = std::min(static_cast<T>(1.0), state.damage + static_cast<T>(0.5) * spall_over);
            }
        }

        if (state.damage >= static_cast<T>(1.0)) {
            clampFailedDeviatoricTransition(mat, state, s);
        } else {
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    state.sigma[r][c] = s[r][c] - ((r == c) ? press : static_cast<T>(0.0));
        }
    }
};

} // namespace Blast::Materials
