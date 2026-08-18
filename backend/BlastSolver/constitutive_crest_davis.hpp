#ifndef CONSTITUTIVE_CREST_DAVIS_HPP
#define CONSTITUTIVE_CREST_DAVIS_HPP

#include <cmath>
#include <algorithm>

#ifdef __CUDACC__
#define HD_CREST_FUNC __host__ __device__
#else
#define HD_CREST_FUNC inline
#endif

namespace Blast {
namespace CrestDavis {

// ============================================================================
// Davis Reactant Equation of State (Solid Phase)
// ============================================================================

template <typename T>
HD_CREST_FUNC T computeDavisReactantPressure(
    T v_rel,            // Relative specific volume V / V0 = rho0 / rho
    T e_int,            // Specific internal energy (J/kg)
    T c0,               // Bulk acoustic speed (m/s)
    T s1,               // Hugoniot slope Us-Up
    T gamma0,           // Reference Grüneisen parameter
    T cv,               // Specific heat capacity at constant volume (J/(kg K))
    T t0,               // Reference temperature (K)
    T rho0              // Initial reference density (kg/m^3)
) {
    (void)cv;
    (void)t0;
    if (v_rel < static_cast<T>(0.1)) v_rel = static_cast<T>(0.1);
    T mu = static_cast<T>(1.0) - v_rel; // Compressive strain 1 - V/V0

    T p_H = static_cast<T>(0.0);
    T e_H = static_cast<T>(0.0);

    if (mu > static_cast<T>(0.0)) {
        T denom = static_cast<T>(1.0) - s1 * mu;
        if (denom < static_cast<T>(0.1)) denom = static_cast<T>(0.1);
        p_H = (rho0 * c0 * c0 * mu) / (denom * denom);
        e_H = static_cast<T>(0.5) * p_H * mu / rho0;
    } else {
        // Tension / expansion state
        p_H = rho0 * c0 * c0 * mu;
        e_H = static_cast<T>(0.0);
    }

    T Gamma = gamma0; // Grüneisen ratio
    T p_react = p_H + (Gamma / v_rel) * (e_int - e_H);
    return p_react;
}

// Compute peak shock entropy along unreacted solid Hugoniot from minimum volume v_min
template <typename T>
HD_CREST_FUNC T computeDavisShockEntropy(
    T v_min,            // Peak compressive relative volume V_min / V0 <= 1.0
    T c0,               // Bulk sound speed (m/s)
    T s1,               // Hugoniot slope
    T gamma0,           // Grüneisen gamma
    T cv,               // Specific heat (J/(kg K))
    T t0,               // Reference temperature (K)
    T rho0              // Reference density (kg/m^3)
) {
    (void)gamma0;
    if (v_min >= static_cast<T>(0.9999)) return static_cast<T>(0.0);
    if (v_min < static_cast<T>(0.1)) v_min = static_cast<T>(0.1);

    T mu = static_cast<T>(1.0) - v_min;
    T denom = static_cast<T>(1.0) - s1 * mu;
    if (denom < static_cast<T>(0.1)) denom = static_cast<T>(0.1);

    T p_H = (rho0 * c0 * c0 * mu) / (denom * denom);
    T e_H = static_cast<T>(0.5) * p_H * mu / rho0;

    // Thermodynamic Hugoniot temperature estimate
    T T_H = t0 + (e_H / (cv > static_cast<T>(1.0) ? cv : static_cast<T>(1000.0)));
    if (T_H <= t0) return static_cast<T>(0.0);

    // Shock entropy jump: s_s = cv * ln(T_H / T0)
    T ratio = T_H / (t0 > static_cast<T>(1.0) ? t0 : static_cast<T>(293.0));
    if (ratio < static_cast<T>(1.0)) ratio = static_cast<T>(1.0);

    T s_shock = cv * std::log(ratio);
    return s_shock;
}

// ============================================================================
// Davis Product Equation of State (Detonation Gas Phase)
// ============================================================================

template <typename T>
HD_CREST_FUNC T computeDavisProductPressure(
    T v_rel,            // Relative specific volume V / V0
    T e_int,            // Specific internal energy (J/kg)
    T a,                // High-density exponent parameter
    T b,                // Transition curvature exponent
    T k,                // Low-density adiabatic exponent (e.g. 1.30 - 1.40)
    T vc,               // Characteristic transition relative volume
    T pc,               // Characteristic transition pressure (Pa)
    T q_det,            // Detonation chemical energy release (J/kg)
    T rho0              // Reference solid density (kg/m^3)
) {
    (void)q_det;
    if (v_rel < static_cast<T>(0.05)) v_rel = static_cast<T>(0.05);

    // Variable Grüneisen gamma transitioning from dense fluid to dilute gas
    T v_ratio_b = std::pow(v_rel / (vc > static_cast<T>(0.01) ? vc : static_cast<T>(0.6)), b);
    T Gamma_g = (k - static_cast<T>(1.0)) + (a - k + static_cast<T>(1.0)) / (static_cast<T>(1.0) + v_ratio_b);

    // Reference Isentrope
    T x = (vc > static_cast<T>(0.01) ? vc : static_cast<T>(0.6)) / v_rel;
    T x_k = std::pow(x, k);
    T x_a = std::pow(x, a);
    T x_ak = std::pow(x, a - k);

    T p_is = pc * (x_k + x_a) / (static_cast<T>(1.0) + x_ak);
    if (p_is < static_cast<T>(1.0e-6)) p_is = static_cast<T>(1.0e-6);

    // Reference internal energy along isentrope
    T k_eff = (k > static_cast<T>(1.01)) ? k : static_cast<T>(1.35);
    T e_is = p_is / (rho0 * (k_eff - static_cast<T>(1.0)));

    T p_prod = p_is + (Gamma_g / v_rel) * (e_int - e_is);
    if (p_prod < static_cast<T>(1.0e-6)) p_prod = static_cast<T>(1.0e-6);

    return p_prod;
}

// ============================================================================
// CREST Reaction Kinetics Rate Integrator (Stiff Sub-Cycling ODE)
// ============================================================================

template <typename T>
HD_CREST_FUNC T evalCRESTReactionRate(
    T s_shock,          // Latched peak shock entropy (J/(kg K))
    T lambda,           // Reaction progress variable in [0, 1]
    T b1, T c1, T m1,   // Hot-spot ignition parameters
    T b2, T c2, T c3, T m2, // Grain-growth parameters
    T s0,               // Reference entropy scale (J/(kg K))
    T s_threshold       // Ignition entropy threshold (J/(kg K))
) {
    if (s_shock <= s_threshold || lambda >= static_cast<T>(0.9999)) {
        return static_cast<T>(0.0);
    }

    T s_eff = (s_shock - s_threshold) / (s0 > static_cast<T>(1.0) ? s0 : static_cast<T>(100.0));
    if (s_eff <= static_cast<T>(0.0)) return static_cast<T>(0.0);

    T one_minus_lam = static_cast<T>(1.0) - lambda;
    if (one_minus_lam < static_cast<T>(1.0e-7)) return static_cast<T>(0.0);
    T lam_safe = (lambda > static_cast<T>(0.0)) ? lambda : static_cast<T>(0.0);

    // 1. Hot-Spot Ignition Channel: b1 * (1 - lambda)^c1 * (s_eff)^m1
    T R_ign = b1 * std::pow(one_minus_lam, c1) * std::pow(s_eff, m1);

    // 2. Main Grain-Burning Growth Channel: b2 * lambda^c2 * (1 - lambda)^c3 * (s_eff)^m2
    T R_grow = (lam_safe > static_cast<T>(1.0e-6)) ? (b2 * std::pow(lam_safe, c2) * std::pow(one_minus_lam, c3) * std::pow(s_eff, m2)) : static_cast<T>(0.0);

    // Total specific rate coefficient K such that d(lambda)/dt = (1 - lambda) * K
    T K_rate = (R_ign + R_grow);
    return K_rate;
}

template <typename T>
HD_CREST_FUNC T advanceCRESTProgress(
    T dt,
    T s_shock,
    T lambda_curr,
    T b1, T c1, T m1,
    T b2, T c2, T c3, T m2,
    T s0,
    T s_threshold
) {
    if (s_shock <= s_threshold || lambda_curr >= static_cast<T>(0.9999)) {
        return lambda_curr;
    }

    // 4-stage sub-cycled exponential production advance
    constexpr int N_SUB = 4;
    T dt_sub = dt / static_cast<T>(N_SUB);
    T lam = lambda_curr;

    for (int step = 0; step < N_SUB; ++step) {
        T K_rate = evalCRESTReactionRate(s_shock, lam, b1, c1, m1, b2, c2, c3, m2, s0, s_threshold);
        if (K_rate <= static_cast<T>(0.0)) break;

        // Exact exponential integrator for d(1 - lambda)/dt = - K_rate * (1 - lambda)
        T decay = std::exp(-K_rate * dt_sub);
        lam = static_cast<T>(1.0) - (static_cast<T>(1.0) - lam) * decay;
        if (lam >= static_cast<T>(0.9999)) {
            lam = static_cast<T>(1.0);
            break;
        }
    }

    if (lam < static_cast<T>(0.0)) lam = static_cast<T>(0.0);
    if (lam > static_cast<T>(1.0)) lam = static_cast<T>(1.0);
    return lam;
}

} // namespace CrestDavis
} // namespace Blast

#endif // CONSTITUTIVE_CREST_DAVIS_HPP
