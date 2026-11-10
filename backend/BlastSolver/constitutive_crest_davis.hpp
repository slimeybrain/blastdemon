#ifndef CONSTITUTIVE_CREST_DAVIS_HPP
#define CONSTITUTIVE_CREST_DAVIS_HPP

#include <cmath>
#include <algorithm>

#ifdef __CUDACC__
#define HD_CREST_FUNC inline __host__ __device__
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

// Helper: Irreversible Rayleigh-Hugoniot specific shock dissipation energy e_irr = e_H(mu) - e_rev(mu)
// Along the linear Us = c0 + s1 * Up Hugoniot:
//   p_H(mu)   = rho0 * c0^2 * mu / (1 - s1 * mu)^2
//   e_H(mu)   = (1/2) * p_H(mu) * mu / rho0 = (c0 / s1)^2 * x^2 / (2 * (1 - x)^2),  x = s1 * mu
//   e_rev(mu) = int_0^mu (p_H(mu') / rho0) d(mu') = (c0 / s1)^2 * (x / (1 - x) + ln(1 - x))
// Subtracting the reversible isentropic elastic strain energy e_rev(mu) cancels the O(mu^2) linear
// elastic energy identically, leaving the strictly positive O(mu^3) Bethe-Weyl shock dissipation energy.
template <typename T>
HD_CREST_FUNC T computeIrreversibleHugoniotEnergy(
    T mu,               // Compressive volumetric strain 1 - V/V0 > 0
    T c0,               // Bulk acoustic speed (m/s)
    T s1                // Hugoniot slope Us-Up
) {
    if (mu <= static_cast<T>(1.0e-5) || s1 <= static_cast<T>(1.0e-4)) {
        return static_cast<T>(0.0);
    }
    T x = s1 * mu;
    if (x > static_cast<T>(0.90)) x = static_cast<T>(0.90);

    T f_irr = static_cast<T>(0.0);
    if (x < static_cast<T>(0.05)) {
        // Exact cancellation-free Maclaurin series: sum_{n=3..6} ((n-1)(n-2)/(2n)) * x^n
        T x2 = x * x;
        T x3 = x2 * x;
        f_irr = x3 * (static_cast<T>(1.0 / 3.0) +
                      x * (static_cast<T>(0.75) +
                           x * (static_cast<T>(1.20) +
                                x * static_cast<T>(5.0 / 3.0))));
    } else {
        T denom = static_cast<T>(1.0) - x;
        f_irr = (x * (static_cast<T>(1.5) * x - static_cast<T>(1.0))) / (denom * denom) - std::log(denom);
    }
    if (f_irr <= static_cast<T>(0.0)) return static_cast<T>(0.0);

    T c0_over_s1 = c0 / s1;
    return (c0_over_s1 * c0_over_s1) * f_irr;
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
    (void)rho0;
    if (v_min >= static_cast<T>(0.9999)) return static_cast<T>(0.0);
    if (v_min < static_cast<T>(0.1)) v_min = static_cast<T>(0.1);

    T mu = static_cast<T>(1.0) - v_min;
    T e_irr = computeIrreversibleHugoniotEnergy(mu, c0, s1);
    if (e_irr <= static_cast<T>(0.0)) return static_cast<T>(0.0);

    T cv_safe = (cv > static_cast<T>(1.0)) ? cv : static_cast<T>(1000.0);
    T t0_safe = (t0 > static_cast<T>(1.0)) ? t0 : static_cast<T>(293.0);

    // Shock entropy jump from irreversible shock dissipation: s_s = cv * ln(1 + e_irr / (cv * T0))
    return cv_safe * std::log(static_cast<T>(1.0) + e_irr / (cv_safe * t0_safe));
}

// Compute peak shock entropy along unreacted solid Hugoniot directly from compressive shock pressure
template <typename T>
HD_CREST_FUNC T computeDavisShockEntropyFromPressure(
    T p_shock,          // Compressive shock pressure (Pa)
    T c0,               // Bulk sound speed (m/s)
    T s1,               // Hugoniot slope
    T cv,               // Specific heat (J/(kg K))
    T t0,               // Reference temperature (K)
    T rho0              // Reference density (kg/m^3)
) {
    if (p_shock <= static_cast<T>(1.0e6)) return static_cast<T>(0.0);
    T rho_c0 = rho0 * c0;
    T discr = rho_c0 * rho_c0 + static_cast<T>(4.0) * s1 * rho0 * p_shock;
    if (discr <= static_cast<T>(0.0)) return static_cast<T>(0.0);

    T Up = (std::sqrt(discr) - rho_c0) / (static_cast<T>(2.0) * s1 * rho0);
    if (Up <= static_cast<T>(0.0)) return static_cast<T>(0.0);

    T Us = c0 + s1 * Up;
    T mu = Up / (Us > static_cast<T>(1.0) ? Us : static_cast<T>(1.0));
    if (mu <= static_cast<T>(0.0)) return static_cast<T>(0.0);
    if (mu > static_cast<T>(0.90)) mu = static_cast<T>(0.90);

    T e_irr = computeIrreversibleHugoniotEnergy(mu, c0, s1);
    if (e_irr <= static_cast<T>(0.0)) return static_cast<T>(0.0);

    T cv_safe = (cv > static_cast<T>(1.0)) ? cv : static_cast<T>(1000.0);
    T t0_safe = (t0 > static_cast<T>(1.0)) ? t0 : static_cast<T>(293.0);

    return cv_safe * std::log(static_cast<T>(1.0) + e_irr / (cv_safe * t0_safe));
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

// ============================================================================
// AWE CREST (Handley 2006 Table 2; Cartwright 2016 Ch.3, Table 3.1)
// Finite-strain solid isentrope. SI in/out; Zs returned in Mbar*cm^3/g.
// ============================================================================
struct CRESTSolidParams {
    double rho0, rho0s, K0s, Ed;
    double A1, A2, A3, B1, B2, B3, fc, delta;
    double Gamma1, Gamma2, gamma00, m;
};

struct CRESTIsentrope { double pi, ei_rel, Gamma, tau; };

HD_CREST_FUNC CRESTIsentrope evalCRESTSolidIsentrope(double rho_s, const CRESTSolidParams& q) {
    const double PI = 3.14159265358979323846;
    CRESTIsentrope o;
    double x = 1.0;
    o.pi = 0.0; o.ei_rel = 0.0;
    if (rho_s > q.rho0s) {
        const double f = 0.5 * (std::pow(rho_s / q.rho0s, 2.0 / 3.0) - 1.0);
        double gA = q.A1 * f + q.A2 * f * f + q.A3 * f * f * f;
        double dgA = q.A1 + 2.0 * q.A2 * f + 3.0 * q.A3 * f * f;
        double gB = 0.0, dgB = 0.0, gC = 0.0;
        const double d = q.delta;
        if (d > 0.0 && (q.B1 != 0.0 || q.B2 != 0.0 || q.B3 != 0.0)) {
            const double df = f - q.fc, fc = q.fc;
            const double at = std::atan(df / d), atm = std::atan(-fc / d);
            const double poly = q.B1 * df + q.B2 * df * df + q.B3 * df * df * df;
            const double dpoly = q.B1 + 2.0 * q.B2 * df + 3.0 * q.B3 * df * df;
            const double br = 0.5 * (1.0 - (2.0 / PI) * at);
            const double dbr = -(1.0 / PI) * (d / (d * d + df * df));
            gA += poly * br; dgA += dpoly * br + poly * dbr;
            const double k = q.B1 - d * d * q.B3;
            gB = (d / (2 * PI)) * k * std::log(d * d + df * df) - (q.B2 * d * d / PI) * at
                 + (d / (2 * PI)) * df * (2 * q.B2 + q.B3 * df);
            dgB = (d / (2 * PI)) * k * (2 * df / (d * d + df * df))
                  - (q.B2 * d * d / PI) * (d / (d * d + df * df))
                  + (d / (2 * PI)) * (2 * q.B2 + 2 * q.B3 * df);
            gC = (q.B1 * fc - q.B2 * fc * fc + q.B3 * fc * fc * fc) * 0.5 * (1.0 - (2.0 / PI) * atm)
                 - (d / (2 * PI)) * k * std::log(d * d + fc * fc) + (q.B2 * d * d / PI) * atm
                 + (d / (2 * PI)) * fc * (2 * q.B2 - q.B3 * fc);
        }
        const double F = std::exp(gA + gB + gC), dF = F * (dgA + dgB);
        o.pi = 3.0 * q.K0s * f * std::pow(2.0 * f + 1.0, 2.5) * (F + 0.5 * f * dF);
        o.ei_rel = 4.5 * (q.K0s / q.rho0s) * f * f * F;
        x = q.rho0s / rho_s;
    }
    o.Gamma = q.gamma00 + q.Gamma1 * std::pow(x, q.m) * std::exp(-q.Gamma2 * x);
    const double G2 = q.Gamma2;
    const double ig = q.gamma00 * std::log(x) + q.Gamma1 *
        ((-std::exp(-G2 * x) * (G2 * x + 1.0) / (G2 * G2)) - (-std::exp(-G2) * (G2 + 1.0) / (G2 * G2)));
    o.tau = std::exp(-ig);
    return o;
}

// Solid pressure (Pa) at relative volume v_rel=rho0/rho_s and thermal-offset energy e_th (J/kg, above Ed).
HD_CREST_FUNC double computeCRESTSolidPressure(double v_rel, double e_th, const CRESTSolidParams& q) {
    const double rho_s = q.rho0 / v_rel;
    const CRESTIsentrope s = evalCRESTSolidIsentrope(rho_s, q);
    return std::max(0.0, s.pi + rho_s * s.Gamma * (e_th - s.ei_rel));
}

HD_CREST_FUNC double crestZsFromRho(double rho_s, const CRESTSolidParams& q, double* pH_out) {
    const CRESTIsentrope s = evalCRESTSolidIsentrope(rho_s, q);
    const double dv = 1.0 / q.rho0 - 1.0 / rho_s;
    const double den = 1.0 - 0.5 * rho_s * s.Gamma * dv;
    double pH = (den > 1e-9) ? (s.pi - rho_s * s.Gamma * s.ei_rel) / den : 0.0;
    if (pH < 0.0) pH = 0.0;
    if (pH_out) *pH_out = pH;
    const double eH = 0.5 * pH * dv;
    return std::max(0.0, (eH - s.ei_rel) / (s.tau * 1.0e8));
}

// Zs (Mbar*cm^3/g) from minimum relative volume reached.
HD_CREST_FUNC double computeCRESTShockEntropy(double v_min, const CRESTSolidParams& q) {
    if (v_min >= 1.0) return 0.0;
    return crestZsFromRho(q.rho0 / v_min, q, nullptr);
}

// Zs (Mbar*cm^3/g) from compressive shock pressure (Pa) via Hugoniot bisection.
HD_CREST_FUNC double computeCRESTShockEntropyFromPressure(double p_shock, const CRESTSolidParams& q) {
    if (p_shock <= 0.0) return 0.0;
    double lo = std::min(q.rho0, q.rho0s), hi = 3.0 * q.rho0s;
    for (int i = 0; i < 40; ++i) {
        const double mid = 0.5 * (lo + hi);
        double pH; crestZsFromRho(mid, q, &pH);
        if (pH < p_shock) lo = mid; else hi = mid;
    }
    return crestZsFromRho(0.5 * (lo + hi), q, nullptr);
}

// Exact manifold step for (lambda1, lambda2, lambda). Zs in Mbar*cm^3/g, dt in seconds.
HD_CREST_FUNC double advanceAWECRESTProgress(double dt, double Zs, double lam,
    double c0, double c1, double c2, double c3, double c6, double c8, double c9,
    double c10, double c11, double c12, double c13) {
    if (Zs <= 0.0) return lam;
    const double b1 = std::min(4000.0, c0 * std::pow(Zs, c1));
    const double b2 = std::min(4000.0, c2 * std::pow(Zs, c3));
    if (b1 <= 0.0) return lam;
    const double M1 = (c6 > 0.0) ? c6 * std::pow(Zs, c12) / std::sqrt(b1) : 0.0;
    const double t8 = (c8 > 0.0) ? c8 * std::pow(Zs, -c9) : 0.0;
    const double t10 = (c10 > 0.0 && Zs > c13) ? c10 * std::pow(Zs - c13, c11) : 0.0;
    const double M2 = (b2 > 0.0) ? std::min(10.0, (t8 + t10) / std::sqrt(b2)) : 0.0;
    const double lam_max = 1.0 - std::exp(-(M1 + M2));
    if (lam >= lam_max - 1e-7) return lam;
    const double r = b2 / b1;
    auto Phi = [&](double u, double* dPhi) {
        const double eu = std::exp(-u);
        const double g = std::exp(-r * (u - 1.0 + eu));
        if (dPhi) *dPhi = M1 * eu + M2 * g * r * (1.0 - eu);
        return M1 * (1.0 - eu) + M2 * (1.0 - g);
    };
    double u = 0.0;
    if (lam > 1e-12) {
        const double target = -std::log(1.0 - lam);
        double lo = 0.0, hi = 1.0;
        while (Phi(hi, nullptr) < target && hi < 1e6) hi *= 2.0;
        u = 0.5 * (lo + hi);
        for (int i = 0; i < 12; ++i) {
            double d; const double f = Phi(u, &d) - target;
            if (f > 0) hi = u; else lo = u;
            double un = (d > 1e-300) ? u - f / d : 0.5 * (lo + hi);
            if (un <= lo || un >= hi) un = 0.5 * (lo + hi);
            u = un;
        }
    }
    const double dt_us = dt * 1.0e6;
    const double sq = std::sqrt(u) + std::sqrt(0.5 * b1) * dt_us;
    const double un = sq * sq;
    const double l1 = 1.0 - std::exp(-un);
    const double l2 = 1.0 - std::exp(-r * (un - l1));
    return std::max(lam, 1.0 - std::exp(-(M1 * l1 + M2 * l2)));
}

} // namespace CrestDavis
} // namespace Blast

#endif // CONSTITUTIVE_CREST_DAVIS_HPP
