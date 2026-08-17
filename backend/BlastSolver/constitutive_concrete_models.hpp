#ifndef CONSTITUTIVE_CONCRETE_MODELS_HPP
#define CONSTITUTIVE_CONCRETE_MODELS_HPP

#include <cmath>
#include <algorithm>

#ifdef __CUDACC__
#define HD_CONC_FUNC __host__ __device__
#else
#define HD_CONC_FUNC inline
#endif

namespace Blast {
namespace ConcreteModels {

// ============================================================================
// Tensor Invariants & Lode Angle Calculations
// ============================================================================

template <typename T>
HD_CONC_FUNC void computeStressInvariants(
    const T s_dev[3][3],
    T& J2,
    T& J3,
    T& q_vm,
    T& lode_theta
) {
    // J2 = 0.5 * s_ij * s_ij
    J2 = static_cast<T>(0.5) * (
        s_dev[0][0]*s_dev[0][0] + s_dev[1][1]*s_dev[1][1] + s_dev[2][2]*s_dev[2][2] +
        static_cast<T>(2.0) * (s_dev[0][1]*s_dev[0][1] + s_dev[1][2]*s_dev[1][2] + s_dev[2][0]*s_dev[2][0])
    );
    if (J2 < static_cast<T>(1.0e-24)) J2 = static_cast<T>(1.0e-24);

    q_vm = std::sqrt(static_cast<T>(3.0) * J2);

    // J3 = det(s_dev)
    J3 = s_dev[0][0] * (s_dev[1][1]*s_dev[2][2] - s_dev[1][2]*s_dev[1][2])
       - s_dev[0][1] * (s_dev[0][1]*s_dev[2][2] - s_dev[1][2]*s_dev[2][0])
       + s_dev[2][0] * (s_dev[0][1]*s_dev[1][2] - s_dev[1][1]*s_dev[2][0]);

    // cos(3 * theta) = 3 * sqrt(3) / 2 * J3 / (J2^(3/2))
    T J2_15 = J2 * std::sqrt(J2);
    T r = (J2_15 > static_cast<T>(1.0e-20))
        ? (static_cast<T>(1.5) * std::sqrt(static_cast<T>(3.0)) * J3 / J2_15)
        : static_cast<T>(0.0);

    if (r > static_cast<T>(1.0)) r = static_cast<T>(1.0);
    if (r < static_cast<T>(-1.0)) r = static_cast<T>(-1.0);

    lode_theta = static_cast<T>(1.0 / 3.0) * std::acos(r);
}

// Rubin / Willam-Warnke third-invariant factor R_3(theta, Q)
template <typename T>
HD_CONC_FUNC T computeRubinScaling(T theta, T Q) {
    if (Q < static_cast<T>(0.51)) Q = static_cast<T>(0.51);
    if (Q > static_cast<T>(1.0)) Q = static_cast<T>(1.0);

    T cos_th = std::cos(theta);
    T cos_sq = cos_th * cos_th;
    T one_minus_Q2 = static_cast<T>(1.0) - Q * Q;
    T two_Q_minus_1 = static_cast<T>(2.0) * Q - static_cast<T>(1.0);

    T num_disc = static_cast<T>(4.0) * one_minus_Q2 * cos_sq + static_cast<T>(5.0) * Q * Q - static_cast<T>(4.0) * Q;
    if (num_disc < static_cast<T>(0.0)) num_disc = static_cast<T>(0.0);

    T num = static_cast<T>(2.0) * one_minus_Q2 * cos_th + two_Q_minus_1 * std::sqrt(num_disc);
    T denom = static_cast<T>(4.0) * one_minus_Q2 * cos_sq + two_Q_minus_1 * two_Q_minus_1;

    if (denom < static_cast<T>(1.0e-12)) return static_cast<T>(1.0);
    return num / denom;
}

// Dynamic Increase Factor (DIF) with Saturation Caps
template <typename T>
HD_CONC_FUNC void computeDIF(
    T strain_rate,
    T betac,
    T deltat,
    T dif_cap_c,
    T dif_cap_t,
    T& dif_c,
    T& dif_t
) {
    T edot = (strain_rate > static_cast<T>(1.0e-6)) ? strain_rate : static_cast<T>(1.0e-6);

    // Compression DIF: (edot / 30e-6)^betac
    T edot_0c = static_cast<T>(3.0e-5);
    if (edot > edot_0c && betac > static_cast<T>(0.0)) {
        dif_c = std::pow(edot / edot_0c, betac);
    } else {
        dif_c = static_cast<T>(1.0);
    }
    if (dif_c > dif_cap_c) dif_c = dif_cap_c;
    if (dif_c < static_cast<T>(1.0)) dif_c = static_cast<T>(1.0);

    // Tension DIF: (edot / 1e-6)^deltat
    T edot_0t = static_cast<T>(1.0e-6);
    if (edot > edot_0t && deltat > static_cast<T>(0.0)) {
        dif_t = std::pow(edot / edot_0t, deltat);
    } else {
        dif_t = static_cast<T>(1.0);
    }
    if (dif_t > dif_cap_t) dif_t = dif_cap_t;
    if (dif_t < static_cast<T>(1.0)) dif_t = static_cast<T>(1.0);
}

// ============================================================================
// 1. RHT (Riedel-Hiermaier-Thoma) Concrete Constitutive Model
// ============================================================================

template <typename T>
struct RHTStateVariables {
    T damage{0.0};          // Scalar damage D in [0, 1]
    T ep_bar{0.0};          // Equivalent plastic strain
    T p_hydro{0.0};         // Hydrostatic pressure (compression positive)
    T K_tangent{30.0e9};    // Tangent bulk modulus for CFL update
};

template <typename T>
HD_CONC_FUNC T computePAlphaPorosity(
    T p_calc,
    T rht_p_crush,
    T rht_p_lock,
    T rht_alpha0,
    T rht_n_comp,
    T moisture
) {
    T eff_alpha0 = static_cast<T>(1.0) + (rht_alpha0 - static_cast<T>(1.0)) * (static_cast<T>(1.0) - moisture);
    if (eff_alpha0 < static_cast<T>(1.001)) eff_alpha0 = static_cast<T>(1.001);
    if (p_calc <= rht_p_crush) {
        return eff_alpha0;
    } else if (p_calc >= rht_p_lock) {
        return static_cast<T>(1.0);
    } else {
        T frac = (rht_p_lock - p_calc) / (rht_p_lock - rht_p_crush);
        if (frac < static_cast<T>(0.0)) frac = static_cast<T>(0.0);
        if (frac > static_cast<T>(1.0)) frac = static_cast<T>(1.0);
        return static_cast<T>(1.0) + (eff_alpha0 - static_cast<T>(1.0)) * std::pow(frac, rht_n_comp);
    }
}

template <typename T>
HD_CONC_FUNC void updateRHTStress(
    T s_trial[3][3],
    T p_trial,
    T vol_strain,
    T dt,
    T char_len,
    T strain_rate,
    // Material parameters
    T fc,
    T ft,
    T G_shear,
    T K_bulk,
    T G_f,
    T moisture,
    T rht_A,
    T rht_N,
    T rht_B,
    T rht_M,
    T rht_Q0,
    T rht_BQ,
    T rht_D1,
    T rht_D2,
    T rht_p_crush,
    T rht_p_lock,
    T rht_alpha0,
    T rht_n_comp,
    T rht_betac,
    T rht_deltat,
    T dif_cap_c,
    T dif_cap_t,
    // State history
    RHTStateVariables<T>& state
) {
    if (fc < static_cast<T>(1.0e5)) fc = static_cast<T>(30.0e6);
    if (ft < static_cast<T>(1.0e4)) ft = static_cast<T>(0.1) * fc;

    // 1. Compute Rate Enhancement (DIF)
    T dif_c, dif_t;
    computeDIF(strain_rate, rht_betac, rht_deltat, dif_cap_c, dif_cap_t, dif_c, dif_t);

    // 2. Porous P-alpha EOS Hydrostatic Pressure & Tangent Bulk Modulus
    // Moisture saturation reduces initial porosity alpha0
    T eff_alpha0 = static_cast<T>(1.0) + (rht_alpha0 - static_cast<T>(1.0)) * (static_cast<T>(1.0) - moisture);
    if (eff_alpha0 < static_cast<T>(1.001)) eff_alpha0 = static_cast<T>(1.001);

    T p_calc = p_trial; // Hydrostatic pressure (compression positive)
    T K_solid = static_cast<T>(1.6) * K_bulk;
    T K_tangent = K_bulk;

    if (p_calc > rht_p_crush && p_calc < rht_p_lock) {
        T frac = (rht_p_lock - p_calc) / (rht_p_lock - rht_p_crush);
        if (frac < static_cast<T>(0.0)) frac = static_cast<T>(0.0);
        if (frac > static_cast<T>(1.0)) frac = static_cast<T>(1.0);
        T alpha = static_cast<T>(1.0) + (eff_alpha0 - static_cast<T>(1.0)) * std::pow(frac, rht_n_comp);
        T comp_progress = (eff_alpha0 - alpha) / (eff_alpha0 - static_cast<T>(1.0));
        K_tangent = K_bulk + comp_progress * (K_solid - K_bulk);
    } else if (p_calc >= rht_p_lock) {
        K_tangent = K_solid;
    }

    // Unilateral crack closure: under compression, full bulk stiffness is active.
    // Under tension, stiffness degrades with tensile damage.
    if (p_calc < static_cast<T>(0.0)) {
        T D_tensile = state.damage;
        K_tangent = (static_cast<T>(1.0) - static_cast<T>(0.9) * D_tensile) * K_bulk;
    }

    state.p_hydro = p_calc;
    state.K_tangent = K_tangent;

    // 3. Stress Invariants & Lode Angle
    T J2, J3, q_vm, lode_theta;
    computeStressInvariants(s_trial, J2, J3, q_vm, lode_theta);

    // 4. Failure & Limit Surfaces
    T P_star = p_calc / fc;
    T P_spall_star = (ft * dif_t) / fc;

    // Rubin Lode Scaling
    T Q = rht_Q0 + rht_BQ * P_star;
    T R3 = computeRubinScaling(lode_theta, Q);

    // Failure Surface Y_fail
    T P_eff = P_star + P_spall_star;
    T Y_fail = static_cast<T>(0.0);
    if (P_eff > static_cast<T>(0.0)) {
        Y_fail = fc * rht_A * std::pow(P_eff, rht_N) * R3 * dif_c;
    }

    // Elastic Limit Surface Y_elastic (onset of microcracking)
    T Y_elastic = Y_fail * static_cast<T>(0.53);

    // Residual Friction Surface Y_res (fully crushed pulverized granular state)
    T Y_res = static_cast<T>(0.0);
    if (P_star > static_cast<T>(0.0)) {
        Y_res = fc * rht_B * std::pow(P_star, rht_M);
    }

    // Interpolate current yield strength based on damage D
    T Y_curr = (static_cast<T>(1.0) - state.damage) * Y_fail + state.damage * Y_res;
    if (Y_curr < Y_res) Y_curr = Y_res;
    if (Y_curr < static_cast<T>(1.0e4)) Y_curr = static_cast<T>(1.0e4);

    // 5. Radial Return Mapping & Plastic Strain Increment
    if (q_vm > Y_curr) {
        T d_sigma = q_vm - Y_curr;
        T scale = Y_curr / q_vm;

        T d_ep = d_sigma / (static_cast<T>(3.0) * G_shear + static_cast<T>(1.0e7));
        state.ep_bar += d_ep;

        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                s_trial[r][c] *= scale;
            }
        }

        // 6. Fracture Energy Regularized Damage Accumulation
        // Hydrodynamic pressure-dependent failure plastic strain epsilon_p_f(P*)
        T ep_f_comp = rht_D1 * std::pow(P_eff > static_cast<T>(1.0e-4) ? P_eff : static_cast<T>(1.0e-4), rht_D2);
        if (ep_f_comp < static_cast<T>(0.0001)) ep_f_comp = static_cast<T>(0.0001);

        // Fracture energy regularization for tensile softening (Bažant crack-band formulation)
        T h = (char_len > static_cast<T>(1.0e-6)) ? char_len : static_cast<T>(0.01);
        T ep_f_tensile = (G_f > static_cast<T>(0.0) && ft > static_cast<T>(0.0)) ? (G_f / (ft * h)) : ep_f_comp;
        if (ep_f_tensile < static_cast<T>(1.0e-5)) ep_f_tensile = static_cast<T>(1.0e-5);
        if (ep_f_tensile > static_cast<T>(1.0)) ep_f_tensile = static_cast<T>(1.0);

        // Under tension/spall (P_star < 0), crack-band tensile regularization governs.
        // Under compression/shear (P_star >= 0), RHT pressure-hardening law governs with tensile lower bound.
        T ep_f_eff = (P_star < static_cast<T>(0.0)) ? ep_f_tensile : (ep_f_comp > ep_f_tensile ? ep_f_comp : ep_f_tensile);

        T d_D = d_ep / ep_f_eff;
        state.damage += d_D;
        if (state.damage > static_cast<T>(1.0)) state.damage = static_cast<T>(1.0);
    }
}

// ============================================================================
// 2. K&C (Karagozian & Case / MAT_072R3) Concrete Constitutive Model
// ============================================================================

template <typename T>
struct KCStateVariables {
    T damage{0.0};          // Scalar damage D in [0, 1]
    T lambda{0.0};          // Modified effective plastic strain
    T ep_bar{0.0};          // Equivalent plastic strain
    T p_hydro{0.0};         // Hydrostatic pressure
    T K_tangent{30.0e9};    // Tangent bulk modulus
};

template <typename T>
HD_CONC_FUNC void updateKCStress(
    T s_trial[3][3],
    T p_trial,
    T vol_strain,
    T dt,
    T char_len,
    T strain_rate,
    // Material parameters
    T fc,
    T ft,
    T G_shear,
    T K_bulk,
    T G_f,
    T moisture,
    bool auto_generate,
    T a0, T a1, T a2,
    T a0y, T a1y, T a2y,
    T a1r, T a2r,
    T b1, T omega,
    T dif_cap_c,
    T dif_cap_t,
    // State history
    KCStateVariables<T>& state
) {
    if (fc < static_cast<T>(1.0e5)) fc = static_cast<T>(30.0e6);
    if (ft < static_cast<T>(1.0e4)) ft = static_cast<T>(0.1) * fc;

    // 1. Auto-generate Malvar coefficients if enabled
    if (auto_generate) {
        a0 = fc / static_cast<T>(3.0);
        a1 = static_cast<T>(0.45);
        a2 = static_cast<T>(0.15) / fc;
        a0y = static_cast<T>(0.45) * a0;
        a1y = a1;
        a2y = a2;
        a1r = static_cast<T>(0.75);
        a2r = static_cast<T>(0.20) / fc;
        b1 = static_cast<T>(1.60);
        omega = static_cast<T>(0.50);
    }

    T p_calc = p_trial; // Compression positive
    state.p_hydro = p_calc;
    state.K_tangent = K_bulk * (p_calc > static_cast<T>(0.0) ? (static_cast<T>(1.0) + static_cast<T>(0.5) * p_calc / fc) : static_cast<T>(1.0));

    // Rate enhancement
    T dif_c, dif_t;
    computeDIF(strain_rate, static_cast<T>(0.03), static_cast<T>(0.08), dif_cap_c, dif_cap_t, dif_c, dif_t);

    // 2. Strength Surfaces (Maximum, Yield, Residual)
    T denom_m = a1 + a2 * p_calc;
    T delta_sigma_m = (denom_m > static_cast<T>(0.01)) ? (a0 + p_calc / denom_m) : a0;
    delta_sigma_m *= dif_c;

    T denom_y = a1y + a2y * p_calc;
    T delta_sigma_y = (denom_y > static_cast<T>(0.01)) ? (a0y + p_calc / denom_y) : a0y;
    delta_sigma_y *= dif_c;

    T denom_r = a1r + a2r * p_calc;
    T delta_sigma_r = (denom_r > static_cast<T>(0.01)) ? (p_calc / denom_r) : static_cast<T>(0.0);

    // 3. Current Yield Surface Interpolation using lambda
    T lambda_m = static_cast<T>(1.0e-4);
    T eta = static_cast<T>(0.0);
    if (state.lambda <= static_cast<T>(0.0)) {
        eta = static_cast<T>(0.0);
    } else if (state.lambda < lambda_m) {
        eta = state.lambda / lambda_m;
    } else {
        eta = static_cast<T>(1.0);
    }

    T delta_sigma = static_cast<T>(0.0);
    if (state.damage <= static_cast<T>(0.0)) {
        delta_sigma = delta_sigma_y + eta * (delta_sigma_m - delta_sigma_y);
    } else {
        delta_sigma = (static_cast<T>(1.0) - state.damage) * delta_sigma_m + state.damage * delta_sigma_r;
    }
    if (delta_sigma < delta_sigma_r) delta_sigma = delta_sigma_r;
    if (delta_sigma < static_cast<T>(1.0e4)) delta_sigma = static_cast<T>(1.0e4);

    // 4. Stress Invariants & Radial Return Mapping
    T J2, J3, q_vm, lode_theta;
    computeStressInvariants(s_trial, J2, J3, q_vm, lode_theta);

    T psi_lode = computeRubinScaling(lode_theta, static_cast<T>(0.68));
    T yield_vm = delta_sigma * psi_lode;

    if (q_vm > yield_vm) {
        T d_sigma = q_vm - yield_vm;
        T scale = yield_vm / q_vm;

        T d_ep = d_sigma / (static_cast<T>(3.0) * G_shear + static_cast<T>(1.0e7));
        state.ep_bar += d_ep;

        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                s_trial[r][c] *= scale;
            }
        }

        // Modified effective plastic strain lambda evolution
        T r_p = (p_calc > static_cast<T>(0.0)) ? (static_cast<T>(1.0) + p_calc / fc) : static_cast<T>(1.0);
        state.lambda += d_ep / r_p;
        // Damage Softening beyond peak (lambda > lambda_m)
        if (state.lambda > lambda_m) {
            T h = (char_len > static_cast<T>(1.0e-6)) ? char_len : static_cast<T>(0.01);
            T lambda_f = (G_f > static_cast<T>(0.0) && ft > static_cast<T>(0.0)) ? (static_cast<T>(2.0) * G_f / (ft * h)) : static_cast<T>(0.005);
            if (lambda_f < static_cast<T>(0.005)) lambda_f = static_cast<T>(0.005);
            T d_D = d_ep / (lambda_f * r_p);
            state.damage += d_D;
            if (state.damage > static_cast<T>(1.0)) state.damage = static_cast<T>(1.0);
        }
    }
}

// ============================================================================
// 3. CSCM (Continuous Surface Cap Model / MAT_159) Concrete Constitutive Model
// ============================================================================

template <typename T>
struct CSCMStateVariables {
    T damage{static_cast<T>(0.0)};
    T damage_brittle{static_cast<T>(0.0)};
    T damage_ductile{static_cast<T>(0.0)};
    T kappa{static_cast<T>(0.0)};
    T ep_bar{static_cast<T>(0.0)};
    T p_hydro{static_cast<T>(0.0)};
    T K_tangent{static_cast<T>(30.0e9)};
};

template <typename T>
HD_CONC_FUNC void updateCSCMStress(
    T s_trial[3][3],
    T& p_trial,
    T vol_strain,
    T dt,
    T char_len,
    T strain_rate,
    T fc,
    T ft,
    T G_shear,
    T K_bulk,
    T G_f,
    T alpha,
    T theta,
    T lambda_c,
    T beta,
    T R_ratio,
    T X0,
    T W,
    T D1,
    T D2,
    T dif_cap_c,
    T dif_cap_t,
    CSCMStateVariables<T>& state
) {
    if (fc < static_cast<T>(1.0e5)) fc = static_cast<T>(30.0e6);
    if (ft < static_cast<T>(1.0e4)) ft = static_cast<T>(0.1) * fc;

    // Default CSCM parameters calibrated to fc if uninitialized
    if (alpha <= static_cast<T>(0.0)) {
        alpha = static_cast<T>(0.40) * fc;
        theta = static_cast<T>(0.87);
        lambda_c = static_cast<T>(0.30) * fc;
        beta = static_cast<T>(0.10) / fc;
        R_ratio = static_cast<T>(5.0);
        X0 = static_cast<T>(2.5) * fc;
        W = static_cast<T>(0.05);
        D1 = static_cast<T>(2.5e-9);
        D2 = static_cast<T>(1.0);
    }

    // 1. Dynamic Rate Effects
    T dif_c, dif_t;
    computeDIF(strain_rate, static_cast<T>(0.032), static_cast<T>(0.036), dif_cap_c, dif_cap_t, dif_c, dif_t);

    // 2. Stress Invariants
    T J2, J3, q_vm, lode_theta;
    computeStressInvariants(s_trial, J2, J3, q_vm, lode_theta);
    T J1 = static_cast<T>(3.0) * p_trial;

    // 3. Shear Failure Surface F_s(J1)
    T F_s = alpha - lambda_c * std::exp(-beta * J1) + theta * J1;
    if (F_s < ft * dif_t) F_s = ft * dif_t;

    // Cap Surface F_c(J1, kappa)
    T X_kappa = X0 + state.kappa;
    T L_kappa = (X_kappa > static_cast<T>(0.0)) ? X_kappa : static_cast<T>(0.0);
    T F_c = static_cast<T>(1.0);
    if (J1 > L_kappa && X_kappa > L_kappa) {
        T r_cap = (J1 - L_kappa) / (X_kappa - L_kappa);
        if (r_cap < static_cast<T>(1.0)) {
            F_c = static_cast<T>(1.0) - r_cap * r_cap;
        } else {
            F_c = static_cast<T>(0.0);
        }
    }

    T Y_limit = F_s * std::sqrt(F_c > static_cast<T>(0.0) ? F_c : static_cast<T>(0.0)) * dif_c;
    if (Y_limit < static_cast<T>(1.0e4)) Y_limit = static_cast<T>(1.0e4);

    if (q_vm > Y_limit) {
        T d_sigma = q_vm - Y_limit;
        T scale = Y_limit / q_vm;

        T d_ep = d_sigma / (static_cast<T>(3.0) * G_shear + static_cast<T>(1.0e7));

        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                s_trial[r][c] *= scale;
            }
        }

        // 4. Cap evolution & Damage Softening with G_f
        T h = (char_len > static_cast<T>(1.0e-6)) ? char_len : static_cast<T>(0.01);
        T g_reg = (G_f > static_cast<T>(0.0) && ft > static_cast<T>(0.0)) ? (static_cast<T>(2.0) * G_f / (ft * h)) : static_cast<T>(0.005);
        if (g_reg < static_cast<T>(0.005)) g_reg = static_cast<T>(0.005);
        if (J1 > L_kappa) {
            state.kappa += d_ep * (K_bulk * static_cast<T>(0.1));
            T d_ductile = d_ep / (static_cast<T>(2.0) * g_reg);
            state.damage_ductile += d_ductile;
        } else {
            T d_brittle = d_ep / g_reg;
            state.damage_brittle += d_brittle;
        }

        state.damage = std::max(state.damage_brittle, state.damage_ductile);
        if (state.damage > static_cast<T>(1.0)) state.damage = static_cast<T>(1.0);
    }
}

template <typename T, typename MatType>
HD_CONC_FUNC void updateRHTStress(
    T sig[6],
    const T de[6],
    T& ep,
    T& damage,
    const MatType& mat,
    T dt,
    T h_c
) {
    T G = static_cast<T>(mat.youngs_modulus) / (static_cast<T>(2.0) * (static_cast<T>(1.0) + static_cast<T>(mat.poissons_ratio)));
    T K = static_cast<T>(mat.youngs_modulus) / (static_cast<T>(3.0) * (static_cast<T>(1.0) - static_cast<T>(2.0) * static_cast<T>(mat.poissons_ratio)));
    T vol_strain = de[0] + de[1] + de[2];
    T de_dev[3][3] = {
        { de[0] - vol_strain / static_cast<T>(3.0), de[3], de[5] },
        { de[3], de[1] - vol_strain / static_cast<T>(3.0), de[4] },
        { de[5], de[4], de[2] - vol_strain / static_cast<T>(3.0) }
    };
    T p_old = -(sig[0] + sig[1] + sig[2]) / static_cast<T>(3.0);
    T p_trial = p_old - K * vol_strain;
    T s_old[3][3] = {
        { sig[0] + p_old, sig[3], sig[5] },
        { sig[3], sig[1] + p_old, sig[4] },
        { sig[5], sig[4], sig[2] + p_old }
    };
    T s_trial[3][3] = {
        { s_old[0][0] + static_cast<T>(2.0) * G * de_dev[0][0], s_old[0][1] + static_cast<T>(2.0) * G * de_dev[0][1], s_old[0][2] + static_cast<T>(2.0) * G * de_dev[0][2] },
        { s_old[1][0] + static_cast<T>(2.0) * G * de_dev[1][0], s_old[1][1] + static_cast<T>(2.0) * G * de_dev[1][1], s_old[1][2] + static_cast<T>(2.0) * G * de_dev[1][2] },
        { s_old[2][0] + static_cast<T>(2.0) * G * de_dev[2][0], s_old[2][1] + static_cast<T>(2.0) * G * de_dev[2][1], s_old[2][2] + static_cast<T>(2.0) * G * de_dev[2][2] }
    };
    T strain_rate = (dt > static_cast<T>(1.0e-12)) ? (std::abs(de[0]) / dt) : static_cast<T>(0.0);

    RHTStateVariables<T> state;
    state.damage = damage;
    state.ep_bar = ep;
    state.p_hydro = p_trial;

    updateRHTStress<T>(
        s_trial, p_trial, vol_strain, dt, h_c, strain_rate,
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
        state
    );

    damage = state.damage;
    ep = state.ep_bar;
    T p_new = state.p_hydro;
    sig[0] = s_trial[0][0] - p_new;
    sig[1] = s_trial[1][1] - p_new;
    sig[2] = s_trial[2][2] - p_new;
    sig[3] = s_trial[0][1];
    sig[4] = s_trial[1][2];
    sig[5] = s_trial[0][2];
}

template <typename T, typename MatType>
HD_CONC_FUNC void updateKCStress(
    T sig[6],
    const T de[6],
    T& ep,
    T& lambda,
    T& damage,
    const MatType& mat,
    T dt,
    T h_c
) {
    T G = static_cast<T>(mat.youngs_modulus) / (static_cast<T>(2.0) * (static_cast<T>(1.0) + static_cast<T>(mat.poissons_ratio)));
    T K = static_cast<T>(mat.youngs_modulus) / (static_cast<T>(3.0) * (static_cast<T>(1.0) - static_cast<T>(2.0) * static_cast<T>(mat.poissons_ratio)));
    T vol_strain = de[0] + de[1] + de[2];
    T de_dev[3][3] = {
        { de[0] - vol_strain / static_cast<T>(3.0), de[3], de[5] },
        { de[3], de[1] - vol_strain / static_cast<T>(3.0), de[4] },
        { de[5], de[4], de[2] - vol_strain / static_cast<T>(3.0) }
    };
    T p_old = -(sig[0] + sig[1] + sig[2]) / static_cast<T>(3.0);
    T p_trial = p_old - K * vol_strain;
    T s_old[3][3] = {
        { sig[0] + p_old, sig[3], sig[5] },
        { sig[3], sig[1] + p_old, sig[4] },
        { sig[5], sig[4], sig[2] + p_old }
    };
    T s_trial[3][3] = {
        { s_old[0][0] + static_cast<T>(2.0) * G * de_dev[0][0], s_old[0][1] + static_cast<T>(2.0) * G * de_dev[0][1], s_old[0][2] + static_cast<T>(2.0) * G * de_dev[0][2] },
        { s_old[1][0] + static_cast<T>(2.0) * G * de_dev[1][0], s_old[1][1] + static_cast<T>(2.0) * G * de_dev[1][1], s_old[1][2] + static_cast<T>(2.0) * G * de_dev[1][2] },
        { s_old[2][0] + static_cast<T>(2.0) * G * de_dev[2][0], s_old[2][1] + static_cast<T>(2.0) * G * de_dev[2][1], s_old[2][2] + static_cast<T>(2.0) * G * de_dev[2][2] }
    };
    T strain_rate = (dt > static_cast<T>(1.0e-12)) ? (std::abs(de[0]) / dt) : static_cast<T>(0.0);

    KCStateVariables<T> state;
    state.damage = damage;
    state.lambda = lambda;
    state.ep_bar = ep;
    state.p_hydro = p_trial;

    updateKCStress<T>(
        s_trial, p_trial, vol_strain, dt, h_c, strain_rate,
        static_cast<T>(mat.fc), static_cast<T>(mat.ft), G, K,
        static_cast<T>(mat.G_f), static_cast<T>(mat.moisture_content),
        mat.kc_auto_generate,
        static_cast<T>(mat.kc_a0), static_cast<T>(mat.kc_a1), static_cast<T>(mat.kc_a2),
        static_cast<T>(mat.kc_a0y), static_cast<T>(mat.kc_a1y), static_cast<T>(mat.kc_a2y),
        static_cast<T>(mat.kc_a1r), static_cast<T>(mat.kc_a2r),
        static_cast<T>(mat.kc_b1), static_cast<T>(mat.kc_omega),
        static_cast<T>(mat.dif_cap_compression), static_cast<T>(mat.dif_cap_tension),
        state
    );

    damage = state.damage;
    lambda = state.lambda;
    ep = state.ep_bar;
    T p_new = state.p_hydro;
    sig[0] = s_trial[0][0] - p_new;
    sig[1] = s_trial[1][1] - p_new;
    sig[2] = s_trial[2][2] - p_new;
    sig[3] = s_trial[0][1];
    sig[4] = s_trial[1][2];
    sig[5] = s_trial[0][2];
}

template <typename T, typename MatType>
HD_CONC_FUNC void updateCSCMStress(
    T sig[6],
    const T de[6],
    T& ep,
    T& kappa,
    T& eps_v_p,
    T& damage,
    const MatType& mat,
    T dt,
    T h_c
) {
    (void)eps_v_p;
    T G = static_cast<T>(mat.youngs_modulus) / (static_cast<T>(2.0) * (static_cast<T>(1.0) + static_cast<T>(mat.poissons_ratio)));
    T K = static_cast<T>(mat.youngs_modulus) / (static_cast<T>(3.0) * (static_cast<T>(1.0) - static_cast<T>(2.0) * static_cast<T>(mat.poissons_ratio)));
    T vol_strain = de[0] + de[1] + de[2];
    T de_dev[3][3] = {
        { de[0] - vol_strain / static_cast<T>(3.0), de[3], de[5] },
        { de[3], de[1] - vol_strain / static_cast<T>(3.0), de[4] },
        { de[5], de[4], de[2] - vol_strain / static_cast<T>(3.0) }
    };
    T p_old = -(sig[0] + sig[1] + sig[2]) / static_cast<T>(3.0);
    T p_trial = p_old - K * vol_strain;
    T s_old[3][3] = {
        { sig[0] + p_old, sig[3], sig[5] },
        { sig[3], sig[1] + p_old, sig[4] },
        { sig[5], sig[4], sig[2] + p_old }
    };
    T s_trial[3][3] = {
        { s_old[0][0] + static_cast<T>(2.0) * G * de_dev[0][0], s_old[0][1] + static_cast<T>(2.0) * G * de_dev[0][1], s_old[0][2] + static_cast<T>(2.0) * G * de_dev[0][2] },
        { s_old[1][0] + static_cast<T>(2.0) * G * de_dev[1][0], s_old[1][1] + static_cast<T>(2.0) * G * de_dev[1][1], s_old[1][2] + static_cast<T>(2.0) * G * de_dev[1][2] },
        { s_old[2][0] + static_cast<T>(2.0) * G * de_dev[2][0], s_old[2][1] + static_cast<T>(2.0) * G * de_dev[2][1], s_old[2][2] + static_cast<T>(2.0) * G * de_dev[2][2] }
    };
    T strain_rate = (dt > static_cast<T>(1.0e-12)) ? (std::abs(de[0]) / dt) : static_cast<T>(0.0);

    CSCMStateVariables<T> state;
    state.damage = damage;
    state.kappa = kappa;
    state.ep_bar = ep;
    state.p_hydro = p_trial;

    updateCSCMStress<T>(
        s_trial, p_trial, vol_strain, dt, h_c, strain_rate,
        static_cast<T>(mat.fc), static_cast<T>(mat.ft), G, K,
        static_cast<T>(mat.G_f),
        static_cast<T>(mat.cscm_alpha), static_cast<T>(mat.cscm_theta),
        static_cast<T>(mat.cscm_lambda), static_cast<T>(mat.cscm_beta),
        static_cast<T>(mat.cscm_R), static_cast<T>(mat.cscm_X0),
        static_cast<T>(mat.cscm_W), static_cast<T>(mat.cscm_D1),
        static_cast<T>(mat.cscm_D2),
        static_cast<T>(mat.dif_cap_compression), static_cast<T>(mat.dif_cap_tension),
        state
    );

    damage = state.damage;
    kappa = state.kappa;
    ep = state.ep_bar;
    T p_new = state.p_hydro;
    sig[0] = s_trial[0][0] - p_new;
    sig[1] = s_trial[1][1] - p_new;
    sig[2] = s_trial[2][2] - p_new;
    sig[3] = s_trial[0][1];
    sig[4] = s_trial[1][2];
    sig[5] = s_trial[0][2];
}

template <typename MatType>
HD_CONC_FUNC float computeDIFCompression(float strain_rate, const MatType& mat) {
    float dif_c, dif_t;
    computeDIF(strain_rate, static_cast<float>(mat.rht_betac), static_cast<float>(mat.rht_deltat), static_cast<float>(mat.dif_cap_compression), static_cast<float>(mat.dif_cap_tension), dif_c, dif_t);
    return dif_c;
}

template <typename MatType>
HD_CONC_FUNC float computeDIFTension(float strain_rate, const MatType& mat) {
    float dif_c, dif_t;
    computeDIF(strain_rate, static_cast<float>(mat.rht_betac), static_cast<float>(mat.rht_deltat), static_cast<float>(mat.dif_cap_compression), static_cast<float>(mat.dif_cap_tension), dif_c, dif_t);
    return dif_t;
}

template <typename MatType>
HD_CONC_FUNC float computeAlpha(float p, const MatType& mat) {
    return computePAlphaPorosity(p, static_cast<float>(mat.rht_p_crush), static_cast<float>(mat.rht_p_lock), static_cast<float>(mat.rht_alpha0), static_cast<float>(mat.rht_n_comp), static_cast<float>(mat.moisture_content));
}

} // namespace ConcreteModels
using namespace ConcreteModels;
} // namespace Blast

#endif // CONSTITUTIVE_CONCRETE_MODELS_HPP
