#ifndef CONSTITUTIVE_MIXTURE_HPP
#define CONSTITUTIVE_MIXTURE_HPP

#include <cmath>
#include <algorithm>

#ifdef __CUDACC__
#define HD_MIX_FUNC __host__ __device__
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

} // namespace Mixture
} // namespace Blast

#endif // CONSTITUTIVE_MIXTURE_HPP
