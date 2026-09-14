#ifndef CONSTITUTIVE_LEE_TARVER_HPP
#define CONSTITUTIVE_LEE_TARVER_HPP

#include <cmath>
#include <algorithm>

#ifdef __CUDACC__
#define HD_LT_FUNC __host__ __device__
#else
#define HD_LT_FUNC inline
#endif

namespace Blast {
namespace LeeTarver {

// ============================================================================
// Lee-Tarver Ignition and Growth Reaction Rate Law
// ============================================================================
//
// Rate formulation:
// d(lambda)/dt = Ignition_term + Growth_term + Completion_term
//
// 1. Ignition:   I * (1 - lambda)^b * (rho / rho0 - 1 - a)^x * H(ig_max - lambda)
// 2. Growth:     G1 * (1 - lambda)^c * lambda^d * p^y * H(growth_max - lambda)
// 3. Completion: G2 * (1 - lambda)^e * lambda^g * p^z * H(lambda - comp_min)
// ============================================================================

template <typename T>
HD_LT_FUNC T evalLeeTarverRate(
    T lambda,           // Current reaction progress in [0, 1]
    T v_rel,            // Relative specific volume V / V0 = rho0 / rho
    T p_current,        // Current mixture pressure (Pa)
    T I, T a, T b, T x, T ig_max,       // Ignition parameters
    T G1, T c, T d, T y, T growth_max,  // Growth parameters
    T G2, T e, T g, T z, T comp_min     // Completion parameters
) {
    if (lambda >= static_cast<T>(0.9999)) return static_cast<T>(0.0);
    T one_minus_lam = static_cast<T>(1.0) - lambda;
    if (one_minus_lam < static_cast<T>(1.0e-7)) return static_cast<T>(0.0);
    T lam_safe = (lambda > static_cast<T>(0.0)) ? lambda : static_cast<T>(0.0);

    // Convert pressure to Mbar (1 Mbar = 100 GPa = 1.0e11 Pa) as is standard in LLNL calibration tables,
    // or evaluate in GPa if coefficients are scaled. We support pressure in Pa by checking G1 scale:
    // If G1 < 1.0e-3, coefficients are calibrated for Pa; if G1 > 1.0, coefficients are in Mbar.
    T p_eval = p_current;
    if (G1 > static_cast<T>(0.1) && p_current > static_cast<T>(1.0e6)) {
        p_eval = p_current * static_cast<T>(1.0e-11); // Convert Pa -> Mbar
    }
    if (p_eval < static_cast<T>(0.0)) p_eval = static_cast<T>(0.0);

    T comp_ratio = (v_rel > static_cast<T>(1.0e-4)) ? (static_cast<T>(1.0) / v_rel) : static_cast<T>(1.0);
    T eta = comp_ratio - static_cast<T>(1.0) - a; // (rho / rho0 - 1 - a)

    T rate_ign = static_cast<T>(0.0);
    if (eta > static_cast<T>(0.0) && lambda < ig_max) {
        rate_ign = I * std::pow(one_minus_lam, b) * std::pow(eta, x);
    }

    T rate_growth = static_cast<T>(0.0);
    if (lambda < growth_max && p_eval > static_cast<T>(0.0)) {
        rate_growth = G1 * std::pow(one_minus_lam, c) * std::pow(lam_safe, d) * std::pow(p_eval, y);
    }

    T rate_comp = static_cast<T>(0.0);
    if (lambda > comp_min && p_eval > static_cast<T>(0.0)) {
        rate_comp = G2 * std::pow(one_minus_lam, e) * std::pow(lam_safe, g) * std::pow(p_eval, z);
    }

    T total_rate = rate_ign + rate_growth + rate_comp;
    if (total_rate < static_cast<T>(0.0)) total_rate = static_cast<T>(0.0);
    return total_rate;
}

// 4-stage sub-cycled exponential production advance for stiff reaction rate ODE
template <typename T>
HD_LT_FUNC T advanceLeeTarver(
    T dt,
    T lambda_curr,
    T v_rel,
    T p_current,
    T I, T a, T b, T x, T ig_max,
    T G1, T c, T d, T y, T growth_max,
    T G2, T e, T g, T z, T comp_min
) {
    if (lambda_curr >= static_cast<T>(0.9999)) return static_cast<T>(1.0);

    constexpr int N_SUB = 4;
    T dt_sub = dt / static_cast<T>(N_SUB);
    T lam = lambda_curr;

    for (int step = 0; step < N_SUB; ++step) {
        T rate = evalLeeTarverRate(lam, v_rel, p_current, I, a, b, x, ig_max, G1, c, d, y, growth_max, G2, e, g, z, comp_min);
        if (rate <= static_cast<T>(0.0)) break;

        // Bounded exponential advance
        T dlam = rate * dt_sub;
        lam += dlam;
        if (lam >= static_cast<T>(0.9999)) {
            lam = static_cast<T>(1.0);
            break;
        }
    }

    if (lam < static_cast<T>(0.0)) lam = static_cast<T>(0.0);
    if (lam > static_cast<T>(1.0)) lam = static_cast<T>(1.0);
    return lam;
}

} // namespace LeeTarver
} // namespace Blast

#endif // CONSTITUTIVE_LEE_TARVER_HPP
