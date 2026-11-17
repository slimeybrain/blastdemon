#ifndef CONSTITUTIVE_MIXTURE_HPP
#define CONSTITUTIVE_MIXTURE_HPP

#include <cmath>
#include <algorithm>

#ifdef __CUDACC__
#define HD_MIX_FUNC __host__ __device__ inline
#else
#define HD_MIX_FUNC inline
#endif

namespace Blast {
namespace Mixture {

// ============================================================================
// Reactive-mixture rule for unreacted solid + detonation products
// ============================================================================
//
// mixture_rule (stored per material, integer):
//   0 = LinearBlend         p = (1 - lambda) p_s(V) + lambda p_p(V)   (both phases at the cell volume)
//   1 = PressureEquilibrium V = (1 - lambda) V_s + lambda V_p,   p_s(V_s) = p_p(V_p)
//
// V, V_s, V_p are relative volumes (specific volume / initial specific volume of the
// UNREACTED explosive), (1 - lambda) and lambda are mass fractions, so volume
// additivity is exact.
//
// For fixed lambda and V, g(V_s) = p_s(V_s) - p_p((V - (1 - lambda) V_s) / lambda) is
// strictly decreasing in V_s on the physical bracket (p_s falls with V_s; V_p falls as V_s rises so
// p_p rises, for V_p >= kVpMin), hence a unique root exists inside it. It is found with the
// Illinois (modified regula falsi) method with a fixed iteration cap: bounded work,
// no allocation (Directive 13).
//
// Limits lambda < kLambdaPure or > 1 - kLambdaPure return the pure phase pressure.
// That is an asymptotic cutoff at the physical limit, identical for every particle.

enum class Rule : int { LinearBlend = 0, PressureEquilibrium = 1 };

constexpr double kLambdaPure = 1.0e-6;
constexpr double kVsMin = 0.05;  // solid relative-volume floor (matches the solid EOS clamps)
// Product relative-volume floor for the equilibrium bracket. The JWL energy form
// p = A(1 - w/(R1 V))e^(-R1 V) + ... + w E/V turns NEGATIVE for R1*V < w (V ~ 0.07 for typical
// products), so p_p(V_p) is only monotone on the physical domain of the EOS. 0.2 keeps every
// published product calibration positive and monotone; the same bound applies to every particle.
constexpr double kVpMin = 0.2;

struct Result {
    double p;     // equilibrium / blended mixture pressure (Pa)
    double v_s;   // relative volume of the unreacted phase
    double v_p;   // relative volume of the product phase
    int    iters; // Illinois iterations used (0 for linear / pure phase)
    double T{0.0}; // common phase temperature (K); only set by thermalMixture()
};

template <typename FS, typename FP>
HD_MIX_FUNC Result mixturePressure(Rule rule, double V, double lam, FS&& p_s_of_v, FP&& p_p_of_v) {
    Result r{0.0, V, V, 0};
    if (lam <= kLambdaPure) { r.p = p_s_of_v(V); return r; }
    if (lam >= 1.0 - kLambdaPure) { r.p = p_p_of_v(V); return r; }

    if (rule == Rule::LinearBlend) {
        r.p = (1.0 - lam) * p_s_of_v(V) + lam * p_p_of_v(V);
        return r;
    }

    const double one_minus = 1.0 - lam;
    // Start from a tight physical bracket (V_s between 0.5 V and the V_p floor); fall back to the
    // absolute floor only if the root lies below it. Tight brackets matter: p_s is exponential in V_s.
    const double vs_floor = kVsMin;      // by-value copies: constexpr namespace scalars must not be odr-used in device code
    const double vp_floor = kVpMin;
    double lo = (0.5 * V > vs_floor) ? 0.5 * V : vs_floor;
    double hi = (V - lam * vp_floor) / one_minus;  // keeps V_p >= kVpMin
    if (!(hi > lo)) {
        // Cell volume is below the combined physical floors; evaluate at the bracket floor.
        const double vs = lo;
        const double vp_raw = (V - one_minus * vs) / lam;
        const double vp = (vp_raw > vp_floor) ? vp_raw : vp_floor;
        r.v_s = vs; r.v_p = vp;
        r.p = 0.5 * (p_s_of_v(vs) + p_p_of_v(vp));
        return r;
    }

    auto g = [&](double vs, double& ps, double& pp, double& vp) {
        vp = (V - one_minus * vs) / lam;
        ps = p_s_of_v(vs);
        pp = p_p_of_v(vp);
        return ps - pp;
    };

    double ps_lo, pp_lo, vp_lo, ps_hi, pp_hi, vp_hi;
    double g_lo = g(lo, ps_lo, pp_lo, vp_lo);
    if (g_lo <= 0.0 && lo > vs_floor) { lo = vs_floor; g_lo = g(lo, ps_lo, pp_lo, vp_lo); }
    double g_hi = g(hi, ps_hi, pp_hi, vp_hi);

    // g decreasing: root requires g_lo >= 0 >= g_hi. Otherwise the root is outside the bracket
    // and the closest physical bound is the answer.
    if (g_lo <= 0.0) { r.v_s = lo; r.v_p = vp_lo; r.p = 0.5 * (ps_lo + pp_lo); return r; }
    if (g_hi >= 0.0) { r.v_s = hi; r.v_p = vp_hi; r.p = 0.5 * (ps_hi + pp_hi); return r; }

    constexpr int kMaxIter = 24;
    int side = 0;
    double x = lo, ps = ps_lo, pp = pp_lo, vp = vp_lo;
    for (int it = 0; it < kMaxIter; ++it) {
        r.iters = it + 1;
        x = (lo * g_hi - hi * g_lo) / (g_hi - g_lo);
        const double gx = g(x, ps, pp, vp);
        if (std::fabs(gx) <= 1.0e-6 * (std::fabs(ps) + std::fabs(pp) + 1.0)) break;
        if (gx > 0.0) {
            lo = x; g_lo = gx;
            if (side == +1) g_hi *= 0.5;
            side = +1;
        } else {
            hi = x; g_hi = gx;
            if (side == -1) g_lo *= 0.5;
            side = -1;
        }
    }
    r.v_s = x; r.v_p = vp;
    r.p = 0.5 * (ps + pp);
    return r;
}

// ============================================================================
// Pressure AND temperature equilibrium (Lee-Tarver Ignition & Growth closure)
// ============================================================================
//
// Both phases are temperature-form JWL (strict SI, energies per INITIAL volume):
//     p_s(V_s, T) = A_s e^{-R1s V_s} + B_s e^{-R2s V_s} + w_s Cv_s T / V_s       (unreacted)
//     p_p(V_p, T) = A_p e^{-R1p V_p} + B_p e^{-R2p V_p} + w_p Cv_p T / V_p       (products)
// cold-curve energy  Ec(V) = (A/R1) e^{-R1 V} + (B/R2) e^{-R2 V}.
// Energy of each phase measured from the initial unreacted state (V = 1, T = T0, p ~ 0):
//     E_s = Cv_s (T - T0) + Ec_s(V_s) - Ec_s(1)
//     E_p = Cv_p T + Ec_p(V_p) - E0               (E0 = detonation energy per initial volume)
// Unknowns (V_s, V_p, T) for given cell volume V, mass fraction lambda and total energy e_th:
//     V            = (1 - lambda) V_s + lambda V_p         (volume additivity)
//     p_s(V_s, T)  = p_p(V_p, T)                           (pressure equilibrium)
//     rho0 e_th    = (1 - lambda) E_s + lambda E_p         (energy conservation)
// Solved by nested bracketed root-finds: inner = pressure equilibrium at fixed T (mixturePressure),
// outer = Illinois on T (the mixture energy is strictly increasing in T). Iteration caps are fixed
// (no allocation, Directive 13). e_th is the solver's e_int - lambda*q ("total energy without the
// chemical source term"), identical to the convention used by the rest of the reactive update.
//
// Realizability: T is floored at 0 (thermal energy cannot be negative) exactly like the pure-phase EOS.

struct ThermalParams {
    double As, Bs, R1s, R2s, ws, Cvs, T0;   // unreacted JWL (Pa, Pa, -, -, -, Pa/K, K)
    double Ap, Bp, R1p, R2p, wp, Cvp, E0;   // product JWL (Pa, Pa, -, -, -, Pa/K, Pa = J/m^3 per initial volume)
    double rho0;                            // kg/m^3
};

HD_MIX_FUNC double coldEnergy(double A, double B, double R1, double R2, double V) {
    return (A / R1) * std::exp(-R1 * V) + (B / R2) * std::exp(-R2 * V);
}

HD_MIX_FUNC Result thermalMixture(double V, double lam, double e_th, const ThermalParams& P) {
    Result r{0.0, V, V, 0};
    const double Etot = P.rho0 * e_th;
    const double Ecs1 = coldEnergy(P.As, P.Bs, P.R1s, P.R2s, 1.0);

    if (lam <= kLambdaPure) {
        const double Vs = (V > 0.05) ? V : 0.05;
        double CvT = Etot + P.Cvs * P.T0 + Ecs1 - coldEnergy(P.As, P.Bs, P.R1s, P.R2s, Vs);
        if (CvT < 0.0) CvT = 0.0;
        r.T = CvT / P.Cvs; r.v_s = Vs; r.v_p = Vs;
        r.p = P.As * std::exp(-P.R1s * Vs) + P.Bs * std::exp(-P.R2s * Vs) + P.ws * CvT / Vs;
        return r;
    }
    if (lam >= 1.0 - kLambdaPure) {
        const double Vp = (V > 0.02) ? V : 0.02;
        double CvT = Etot + P.E0 - coldEnergy(P.Ap, P.Bp, P.R1p, P.R2p, Vp);
        if (CvT < 0.0) CvT = 0.0;
        r.T = CvT / P.Cvp; r.v_s = Vp; r.v_p = Vp;
        r.p = P.Ap * std::exp(-P.R1p * Vp) + P.Bp * std::exp(-P.R2p * Vp) + P.wp * CvT / Vp;
        return r;
    }

    const double one_minus = 1.0 - lam;
    auto energy_residual = [&](double T, Result& m) -> double {
        auto ps = [&](double vs) { return P.As * std::exp(-P.R1s * vs) + P.Bs * std::exp(-P.R2s * vs) + P.ws * P.Cvs * T / vs; };
        auto pp = [&](double vp) { return P.Ap * std::exp(-P.R1p * vp) + P.Bp * std::exp(-P.R2p * vp) + P.wp * P.Cvp * T / vp; };
        m = mixturePressure(Rule::PressureEquilibrium, V, lam, ps, pp);
        m.T = T;
        const double Es = P.Cvs * (T - P.T0) + coldEnergy(P.As, P.Bs, P.R1s, P.R2s, m.v_s) - Ecs1;
        const double Ep = P.Cvp * T + coldEnergy(P.Ap, P.Bp, P.R1p, P.R2p, m.v_p) - P.E0;
        return one_minus * Es + lam * Ep - Etot;
    };

    Result m_lo, m_hi;
    double T_lo = 0.0;
    double g_lo = energy_residual(T_lo, m_lo);
    if (g_lo >= 0.0) { m_lo.iters = 1; return m_lo; }       // thermal-energy floor (T = 0)

    double T_hi = (P.T0 > 1.0) ? P.T0 : 300.0;
    double g_hi = energy_residual(T_hi, m_hi);
    int grow = 0;
    while (g_hi < 0.0 && grow < 40) {
        T_lo = T_hi; g_lo = g_hi; m_lo = m_hi;
        T_hi *= 2.0;
        g_hi = energy_residual(T_hi, m_hi);
        ++grow;
    }
    if (g_hi < 0.0) { m_hi.iters = grow; return m_hi; }     // beyond any physical temperature

    const double scale = std::fabs(Etot) + P.Cvs * P.T0 + 1.0e6;
    constexpr int kMaxOuter = 40;
    int side = 0;
    Result best = m_hi; double T = T_hi;
    for (int it = 0; it < kMaxOuter; ++it) {
        T = (T_lo * g_hi - T_hi * g_lo) / (g_hi - g_lo);
        Result m;
        const double g = energy_residual(T, m);
        best = m;
        best.iters = grow + it + 1;
        if (std::fabs(g) <= 1.0e-9 * scale || (T_hi - T_lo) <= 1.0e-9 * T_hi) break;
        if (g > 0.0) {
            T_hi = T; g_hi = g;
            if (side == +1) g_lo *= 0.5;
            side = +1;
        } else {
            T_lo = T; g_lo = g;
            if (side == -1) g_hi *= 0.5;
            side = -1;
        }
    }
    return best;
}

} // namespace Mixture
} // namespace Blast

#endif // CONSTITUTIVE_MIXTURE_HPP
