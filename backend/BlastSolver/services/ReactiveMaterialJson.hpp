#ifndef REACTIVE_MATERIAL_JSON_HPP
#define REACTIVE_MATERIAL_JSON_HPP

// Single source of truth for reading the Lee-Tarver / unreacted-JWL / mixture-rule
// parameters from an INIT JSON object. Previously this 15-key parse was copy-pasted at
// three call sites in main.cpp with divergent, un-calibrated defaults.
//
// All values are STRICT SI (see constitutive_lee_tarver.hpp). Defaults are one traceable
// calibration: LLNL PBX 9501, UCRL-JC-141967 Table 1, converted with
// Blast::LeeTarver::fromLLNL_* (unreacted JWL at T0 = 298 K).

#include <nlohmann/json.hpp>
#include <cmath>
#include <stdexcept>
#include <string>
#include "SolverState.hpp"

namespace Blast {
namespace ReactiveJson {

struct LeeTarverParams {
    float I{1.4e17f}, a{0.0f}, b{0.667f}, x{20.0f}, ig_max{0.3f};
    float G1{1.3e-14f}, c{0.667f}, d{0.277f}, y{2.0f}, growth_max{0.5f};
    float G2{4.0e-14f}, e{0.333f}, g{1.0f}, z{2.0f}, comp_min{0.5f};

    // Unreacted-explosive JWL (SolidReactantEOS::JWLReactant)
    float jwlr_A{7.32e14f}, jwlr_B{-5.2654e9f}, jwlr_R1{14.1f}, jwlr_R2{1.41f};
    float jwlr_omega{0.8867f}, jwlr_Cv{2.7806e6f}, jwlr_T0{298.0f};
    int   mixture_rule{1};

    // Works for MaterialTable3D and the 2D particle struct (identical field names).
    template <typename M>
    void apply(M& m) const {
        m.lt_I = I; m.lt_a = a; m.lt_b = b; m.lt_x = x; m.lt_ig_max = ig_max;
        m.lt_G1 = G1; m.lt_c = c; m.lt_d = d; m.lt_y = y; m.lt_growth_max = growth_max;
        m.lt_G2 = G2; m.lt_e = e; m.lt_g = g; m.lt_z = z; m.lt_comp_min = comp_min;
        m.jwlr_A = jwlr_A; m.jwlr_B = jwlr_B; m.jwlr_R1 = jwlr_R1; m.jwlr_R2 = jwlr_R2;
        m.jwlr_omega = jwlr_omega; m.jwlr_Cv = jwlr_Cv; m.jwlr_T0 = jwlr_T0;
        m.mixture_rule = mixture_rule;
    }
};

// Reject values that cannot be SI (typically LLNL cm-g-us-Mbar numbers pasted unconverted).
// Check: the implied reaction rate at 1 GPa (growth) / 10 GPa (completion) must be physically
// bounded. PBX 9501 in SI gives 1.3e4 /s and 4.0e6 /s; unconverted LLNL values give > 1e20 /s.
inline void validateLeeTarverSI(const LeeTarverParams& p) {
    const double rate_g = static_cast<double>(p.G1) * std::pow(1.0e9, static_cast<double>(p.y));
    const double rate_c = static_cast<double>(p.G2) * std::pow(1.0e10, static_cast<double>(p.z));
    if (!(p.I >= 0.0f) || !(p.G1 >= 0.0f) || !(p.G2 >= 0.0f))
        throw std::invalid_argument("Lee-Tarver: I, G1 and G2 must be non-negative");
    if (rate_g > 1.0e13 || rate_c > 1.0e15)
        throw std::invalid_argument(
            "Lee-Tarver: growth/completion coefficients imply an unphysical rate at 1-10 GPa "
            "(G1*(1e9)^y = " + std::to_string(rate_g) + " /s, G2*(1e10)^z = " + std::to_string(rate_c) +
            " /s). Coefficients must be SI: I [1/s], G1 [1/(s Pa^y)], G2 [1/(s Pa^z)]. "
            "LLNL values (Mbar, us) must be converted: G[SI] = G[LLNL] * 1e6 * (1e-11)^n.");
    if (!(p.jwlr_Cv > 0.0f) || !(p.jwlr_T0 > 0.0f) || !(p.jwlr_R1 > 0.0f) || !(p.jwlr_R2 > 0.0f))
        throw std::invalid_argument("Unreacted JWL: Cv, T0, R1 and R2 must be positive (SI: Cv in Pa/K)");
    if (p.mixture_rule != 0 && p.mixture_rule != 1)
        throw std::invalid_argument("mixture_rule must be 0 (linear blend) or 1 (pressure equilibrium)");
}

inline int parseMixtureRule(const nlohmann::json& obj, int def) {
    if (!obj.contains("mixture_rule")) return def;
    const auto& v = obj["mixture_rule"];
    if (v.is_number()) return v.get<int>();
    if (v.is_string()) {
        const std::string s = v.get<std::string>();
        if (s.find("Linear") != std::string::npos) return 0;
        if (s.find("Pressure") != std::string::npos) return 1;
        throw std::invalid_argument("Unknown mixture_rule '" + s + "'");
    }
    return def;
}

// `validate` should be true only when Lee-Tarver kinetics are actually active for this
// material, so unrelated nodes carrying stale lt_* keys cannot abort an INIT.
inline LeeTarverParams readLeeTarverParams(const nlohmann::json& obj, bool validate) {
    LeeTarverParams p;
    p.I = static_cast<float>(get_json_double(obj, "lt_I", p.I));
    p.a = static_cast<float>(get_json_double(obj, "lt_a", p.a));
    p.b = static_cast<float>(get_json_double(obj, "lt_b", p.b));
    p.x = static_cast<float>(get_json_double(obj, "lt_x", p.x));
    p.G1 = static_cast<float>(get_json_double(obj, "lt_G1", p.G1));
    p.c = static_cast<float>(get_json_double(obj, "lt_c", p.c));
    p.d = static_cast<float>(get_json_double(obj, "lt_d", p.d));
    p.y = static_cast<float>(get_json_double(obj, "lt_y", p.y));
    p.G2 = static_cast<float>(get_json_double(obj, "lt_G2", p.G2));
    p.e = static_cast<float>(get_json_double(obj, "lt_e", p.e));
    p.g = static_cast<float>(get_json_double(obj, "lt_g", p.g));
    p.z = static_cast<float>(get_json_double(obj, "lt_z", p.z));
    p.ig_max = static_cast<float>(get_json_double(obj, "lt_ig_max", get_json_double(obj, "lt_F_ig_max", p.ig_max)));
    p.growth_max = static_cast<float>(get_json_double(obj, "lt_growth_max", get_json_double(obj, "lt_F_G1_max", p.growth_max)));
    p.comp_min = static_cast<float>(get_json_double(obj, "lt_comp_min", get_json_double(obj, "lt_F_G2_min", p.comp_min)));
    p.jwlr_A = static_cast<float>(get_json_double(obj, "jwlr_A", p.jwlr_A));
    p.jwlr_B = static_cast<float>(get_json_double(obj, "jwlr_B", p.jwlr_B));
    p.jwlr_R1 = static_cast<float>(get_json_double(obj, "jwlr_R1", p.jwlr_R1));
    p.jwlr_R2 = static_cast<float>(get_json_double(obj, "jwlr_R2", p.jwlr_R2));
    p.jwlr_omega = static_cast<float>(get_json_double(obj, "jwlr_omega", p.jwlr_omega));
    p.jwlr_Cv = static_cast<float>(get_json_double(obj, "jwlr_Cv", p.jwlr_Cv));
    p.jwlr_T0 = static_cast<float>(get_json_double(obj, "jwlr_T0", p.jwlr_T0));
    p.mixture_rule = parseMixtureRule(obj, p.mixture_rule);
    if (validate) validateLeeTarverSI(p);
    return p;
}

} // namespace ReactiveJson
} // namespace Blast

#endif // REACTIVE_MATERIAL_JSON_HPP
