#ifndef CONSTITUTIVE_LEE_TARVER_HPP
#define CONSTITUTIVE_LEE_TARVER_HPP

#include <cmath>
#include <algorithm>

#ifdef __CUDACC__
#define HD_LT_FUNC __host__ __device__ inline
#else
#define HD_LT_FUNC inline
#endif

namespace Blast {
namespace LeeTarver {

// ============================================================================
// Lee-Tarver Ignition and Growth Reaction Rate Law  (STRICT SI)
// ============================================================================
//
// Rate formulation:
//   d(lambda)/dt = Ignition_term + Growth_term + Completion_term
//
// 1. Ignition:   I  * (1 - lambda)^b * (rho / rho0 - 1 - a)^x                 for lambda <  ig_max
// 2. Growth:     G1 * (1 - lambda)^c * lambda^d * p^y                          for lambda <  growth_max
// 3. Completion: G2 * (1 - lambda)^e * lambda^g * p^z                          for lambda >  comp_min
//
// UNITS (all SI, no heuristics):
//   lambda          dimensionless in [0, 1]
//   p               Pa
//   I               1/s
//   G1              1/(s * Pa^y)
//   G2              1/(s * Pa^z)
//   a, b, c, d, e, g, x, y, z, ig_max, growth_max, comp_min   dimensionless
//
// Published (LLNL) constants use cm-g-us-Mbar. They MUST be converted exactly once,
// at the preset-source boundary, with Blast::LeeTarver::fromLLNL*() below:
//   I[1/s]          = I[1/us] * 1e6
//   G[1/(s Pa^n)]   = G[1/(us Mbar^n)] * 1e6 * (1e-11)^n
//
// The rate is evaluated in double: G2 * p^3 mixes coefficients ~1e-24 with p^3 ~1e32.

constexpr double kMbarToPa = 1.0e11;
constexpr double kPerMicrosecondToPerSecond = 1.0e6;
// Asymptotic completion threshold: reaction is complete once (1 - lambda) < 1e-4.
// This is a realizability cutoff at the physical limit lambda = 1 (Directive 19).
constexpr double kLambdaComplete = 0.9999;

// Exact conversion of published LLNL constants to SI.
HD_LT_FUNC double fromLLNL_I(double I_per_us) {
    return I_per_us * kPerMicrosecondToPerSecond;
}
HD_LT_FUNC double fromLLNL_G(double G_us_Mbar, double pressure_exponent) {
    return G_us_Mbar * kPerMicrosecondToPerSecond * std::pow(1.0 / kMbarToPa, pressure_exponent);
}

template <typename T>
HD_LT_FUNC T evalLeeTarverRate(
    T lambda,           // Current reaction progress in [0, 1]
    T v_rel,            // Relative specific volume V / V0 = rho0 / rho
    T p_current,        // Current mixture pressure (Pa)
    T I, T a, T b, T x, T ig_max,       // Ignition parameters
    T G1, T c, T d, T y, T growth_max,  // Growth parameters
    T G2, T e, T g, T z, T comp_min     // Completion parameters
) {
    const double lam = static_cast<double>(lambda);
    if (lam >= kLambdaComplete) return static_cast<T>(0.0);
    const double one_minus_lam = 1.0 - lam;
    if (one_minus_lam < 1.0e-7) return static_cast<T>(0.0);
    const double lam_safe = (lam > 0.0) ? lam : 0.0;

    const double p = (p_current > static_cast<T>(0.0)) ? static_cast<double>(p_current) : 0.0;

    const double vr = (v_rel > static_cast<T>(1.0e-4)) ? static_cast<double>(v_rel) : 1.0e-4;
    const double eta = 1.0 / vr - 1.0 - static_cast<double>(a); // rho/rho0 - 1 - a

    double rate = 0.0;
    if (eta > 0.0 && lam < static_cast<double>(ig_max)) {
        rate += static_cast<double>(I) * std::pow(one_minus_lam, static_cast<double>(b)) * std::pow(eta, static_cast<double>(x));
    }
    if (lam < static_cast<double>(growth_max) && p > 0.0) {
        rate += static_cast<double>(G1) * std::pow(one_minus_lam, static_cast<double>(c))
              * std::pow(lam_safe, static_cast<double>(d)) * std::pow(p, static_cast<double>(y));
    }
    if (lam > static_cast<double>(comp_min) && p > 0.0) {
        rate += static_cast<double>(G2) * std::pow(one_minus_lam, static_cast<double>(e))
              * std::pow(lam_safe, static_cast<double>(g)) * std::pow(p, static_cast<double>(z));
    }
    if (!(rate > 0.0)) rate = 0.0;
    return static_cast<T>(rate);
}

// Adaptive 2nd-order (Heun / explicit trapezoid) advance of the reaction progress ODE.
// Substep size is limited so that no substep changes lambda by more than kMaxDLambda.
// Work per call is bounded (kMaxSubsteps), so there are no allocations and no
// unbounded loops in the particle hot path (Directive 13). Pressure and compression
// are held at the step-start values (operator-split coupling).
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
    if (static_cast<double>(lambda_curr) >= kLambdaComplete) return static_cast<T>(1.0);

    constexpr int    kMaxSubsteps = 32;
    constexpr double kMaxDLambda  = 0.02;

    double lam = static_cast<double>(lambda_curr);
    double t_rem = static_cast<double>(dt);

    for (int step = 0; step < kMaxSubsteps && t_rem > 0.0; ++step) {
        const double r1 = static_cast<double>(evalLeeTarverRate<T>(static_cast<T>(lam), v_rel, p_current,
            I, a, b, x, ig_max, G1, c, d, y, growth_max, G2, e, g, z, comp_min));
        if (!(r1 > 0.0)) break;

        // Last allowed substep consumes all remaining time so the step is never truncated.
        double h = (step == kMaxSubsteps - 1) ? t_rem : std::min(t_rem, kMaxDLambda / r1);

        const double lam_pred = std::min(1.0, lam + h * r1);
        const double r2 = static_cast<double>(evalLeeTarverRate<T>(static_cast<T>(lam_pred), v_rel, p_current,
            I, a, b, x, ig_max, G1, c, d, y, growth_max, G2, e, g, z, comp_min));

        double lam_new = lam + 0.5 * h * (r1 + r2);
        if (lam_new < lam) lam_new = lam; // reaction is irreversible
        lam = lam_new;
        t_rem -= h;
        if (lam >= kLambdaComplete) { lam = 1.0; break; }
    }

    if (lam < 0.0) lam = 0.0;
    if (lam > 1.0) lam = 1.0;
    return static_cast<T>(lam);
}

} // namespace LeeTarver
} // namespace Blast

#endif // CONSTITUTIVE_LEE_TARVER_HPP
