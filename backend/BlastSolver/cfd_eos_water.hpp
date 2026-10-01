#pragma once

#include <cmath>
#include <algorithm>

#ifdef __CUDACC__
#define HD_EOS_FUNC __host__ __device__
#else
#define HD_EOS_FUNC inline
#endif

namespace Blast {

enum class TaitVariant : int {
    Isentropic = 0,       // Cole 1948 barotropic p(rho)
    CaloricGruneisen = 1, // Energy-coupled p(rho, e) with Gruneisen gamma
    ShockHugoniot = 2     // Mie-Gruneisen / linear shock Hugoniot reference Us = c0 + s*up
};

struct TaitEOSParams {
    double rho0{1000.0};       // Reference density (kg/m^3)
    double gamma{7.15};        // Tait adiabatic index
    double B{3.039e8};         // Tait bulk constant (Pa)
    double c0{1482.0};         // Reference sound speed in water (m/s)
    double p_cav{-1.0e5};      // Cavitation tension limit (Pa)
    double p0{101325.0};       // Ambient reference pressure (Pa)
    double gruneisen{0.28};    // Gruneisen parameter Gamma_0 for liquid water
    double s_hugoniot{1.75};   // Hugoniot Us-Up slope
    double cv{4184.0};         // Specific heat capacity at constant volume (J/(kg K))
    double T0{293.15};         // Reference room temperature (K)
    double dynamic_viscosity{1.002e-3}; // Dynamic shear viscosity mu (Pa s)
    TaitVariant variant{TaitVariant::Isentropic};
};

struct Stratified3DParams {
    bool enabled{false};
    double water_surface_z{10.0};       // Elevation of water free surface (m)
    double seabed_surface_z{2.0};        // Elevation of mudline / seabed (m)
    double k0_earth_pressure{0.50};      // Jaky's lateral earth pressure ratio K0
    double gravity_z{-9.81};             // Vertical acceleration (m/s^2)
    double tait_B{3.039e8};              // Tait parameter B (Pa)
    double tait_gamma{7.15};             // Tait adiabatic exponent
    double tait_rho0{1000.0};            // Reference water density (kg/m^3)
    double air_rho{1.225};               // Atmospheric air density (kg/m^3)
    double p_atm{101325.0};              // Atmospheric reference pressure (Pa)
    double soil_density{2000.0};         // Bulk soil density (kg/m^3)
    double soil_friction_angle{30.0};    // Internal friction angle (deg)
    double soil_cohesion{0.0};           // Soil / rock cohesion (Pa)
    double soil_c0{2500.0};              // Reference bulk sound speed (m/s) (e.g. 1500 for mud, 2500 for sandstone, 4500-5000 for basalt)
    double soil_gamma{4.0};              // Tait exponent or Grüneisen gamma
    double soil_s{1.35};                 // Hugoniot Us-Up slope
    double soil_gruneisen{1.45};         // Grüneisen coefficient
    double soil_p_cav{-1.0e5};           // Tensile cutoff / cavitation limit (Pa)
    int soil_eos_variant{0};             // 0: Isentropic Tait, 1: Caloric Grüneisen, 2: Shock Hugoniot
    double charge_x{0.0};
    double charge_y{0.0};
    double charge_z{0.0};
    double charge_radius{0.05};
};

struct TaitEOSWater {
    static constexpr double RHO0 = 1000.0;      // Reference density (kg/m^3)
    static constexpr double GAMMA = 7.15;       // Tait adiabatic index
    static constexpr double B = 3.039e8;        // Tait bulk constant (Pa)
    static constexpr double P_CAV = -1.0e5;     // Cavitation tension limit (Pa)
    static constexpr double C0 = 1482.0;        // Reference sound speed in water (m/s)
    static constexpr double GRUNEISEN = 0.28;   // Water Gruneisen parameter
    static constexpr double S_HUGONIOT = 1.75;  // Water Hugoniot Us-Up slope

    // Helper to safely clamp values without macro collisions or template ambiguity
    template <typename T>
    HD_EOS_FUNC static T clamp_val(T val, T low, T high) {
        return (val < low) ? low : ((val > high) ? high : val);
    }

    // --- 1. Isentropic / Barotropic Modified Tait (Cole 1948) ---
    template <typename T>
    HD_EOS_FUNC static T compute_pressure_isentropic(T rho, T B_val = static_cast<T>(B), T gamma_val = static_cast<T>(GAMMA),
                                                     T rho0_val = static_cast<T>(RHO0), T p_cav_val = static_cast<T>(P_CAV),
                                                     T p0_val = static_cast<T>(0.0)) {
        using std::pow;
        using std::max;
        T rho_safe = max(static_cast<T>(1.0), rho);
        T r0 = max(static_cast<T>(1.0), rho0_val);
        T rho_ratio = clamp_val(rho_safe / r0, static_cast<T>(0.05), static_cast<T>(10.0));
        T p = B_val * (pow(rho_ratio, gamma_val) - static_cast<T>(1.0)) + p0_val;
        return max(p_cav_val, p);
    }

    template <typename T>
    HD_EOS_FUNC static T compute_sound_speed_isentropic(T rho, T B_val = static_cast<T>(B), T gamma_val = static_cast<T>(GAMMA),
                                                        T rho0_val = static_cast<T>(RHO0)) {
        using std::pow;
        using std::sqrt;
        using std::max;
        T rho_safe = max(static_cast<T>(1.0), rho);
        T r0 = max(static_cast<T>(1.0), rho0_val);
        T rho_ratio = clamp_val(rho_safe / r0, static_cast<T>(0.05), static_cast<T>(10.0));
        T c2 = (B_val * gamma_val / r0) * pow(rho_ratio, gamma_val - static_cast<T>(1.0));
        T c = sqrt(max(static_cast<T>(10.0), c2));
        return clamp_val(c, static_cast<T>(10.0), static_cast<T>(50000.0));
    }

    template <typename T>
    HD_EOS_FUNC static T compute_energy_isentropic(T rho, T B_val = static_cast<T>(B), T gamma_val = static_cast<T>(GAMMA),
                                                   T rho0_val = static_cast<T>(RHO0)) {
        using std::pow;
        using std::max;
        T rho_safe = max(static_cast<T>(1.0), rho);
        T r0 = max(static_cast<T>(1.0), rho0_val);
        T rho_ratio = clamp_val(rho_safe / r0, static_cast<T>(0.05), static_cast<T>(10.0));
        T gm1 = gamma_val - static_cast<T>(1.0);
        T term1 = (static_cast<T>(1.0) / gm1) * pow(rho_ratio, gm1);
        T term2 = static_cast<T>(1.0) / rho_ratio;
        T term3 = gamma_val / gm1;
        return (B_val / r0) * (term1 + term2 - term3);
    }

    template <typename T>
    HD_EOS_FUNC static T compute_density_isentropic(T p, T B_val = static_cast<T>(B), T gamma_val = static_cast<T>(GAMMA),
                                                     T rho0_val = static_cast<T>(RHO0), T p0_val = static_cast<T>(0.0)) {
        using std::pow;
        using std::max;
        T p_eff = max(static_cast<T>(0.0), p - p0_val + B_val);
        return rho0_val * pow(p_eff / B_val, static_cast<T>(1.0) / gamma_val);
    }

    template <typename T>
    HD_EOS_FUNC static void compute_hydrostatic_state(T z, T z_surface, T g_acc, T p_atm,
                                                      T& p_out, T& rho_out, T& e_out,
                                                      T B_val = static_cast<T>(B), T gamma_val = static_cast<T>(GAMMA),
                                                      T rho0_val = static_cast<T>(RHO0)) {
        using std::pow;
        using std::max;
        T depth = max(static_cast<T>(0.0), z_surface - z);
        T gm1 = gamma_val - static_cast<T>(1.0);
        T factor = static_cast<T>(1.0) + (gm1 / gamma_val) * (rho0_val * g_acc * depth) / B_val;
        factor = max(static_cast<T>(1.0e-6), factor);
        rho_out = rho0_val * pow(factor, static_cast<T>(1.0) / gm1);
        p_out = compute_pressure_isentropic(rho_out, B_val, gamma_val, rho0_val, static_cast<T>(P_CAV), p_atm);
        e_out = compute_energy_isentropic(rho_out, B_val, gamma_val, rho0_val);
    }

    template <typename T>
    HD_EOS_FUNC static void compute_geostatic_stress(T z, T z_bed, T p_bed, T rho_soil, T rho_water, T g_acc, T K0,
                                                     T& sigma_v_out, T& u_pore_out, T& sigma_h_out) {
        using std::max;
        T depth_soil = max(static_cast<T>(0.0), z_bed - z);
        sigma_v_out = p_bed + rho_soil * g_acc * depth_soil;
        u_pore_out = p_bed + rho_water * g_acc * depth_soil;
        T sigma_prime_v = max(static_cast<T>(0.0), sigma_v_out - u_pore_out);
        T sigma_prime_h = K0 * sigma_prime_v;
        sigma_h_out = sigma_prime_h + u_pore_out;
    }

    // --- 2. Caloric / Energy-Coupled Modified Tait (Kirkwood-Bethe Gruneisen) ---
    template <typename T>
    HD_EOS_FUNC static T compute_pressure_caloric(T rho, T e, T B_val = static_cast<T>(B), T gamma_val = static_cast<T>(GAMMA),
                                                  T rho0_val = static_cast<T>(RHO0), T gruneisen_val = static_cast<T>(GRUNEISEN),
                                                  T p_cav_val = static_cast<T>(P_CAV), T p0_val = static_cast<T>(0.0)) {
        using std::max;
        T p_isen = compute_pressure_isentropic(rho, B_val, gamma_val, rho0_val, p_cav_val, p0_val);
        T e_isen = compute_energy_isentropic(rho, B_val, gamma_val, rho0_val);
        T p = p_isen + gruneisen_val * rho * (e - e_isen);
        return max(p_cav_val, p);
    }

    template <typename T>
    HD_EOS_FUNC static T compute_sound_speed_caloric(T rho, T p, T e, T B_val = static_cast<T>(B), T gamma_val = static_cast<T>(GAMMA),
                                                     T rho0_val = static_cast<T>(RHO0), T gruneisen_val = static_cast<T>(GRUNEISEN)) {
        using std::pow;
        using std::sqrt;
        using std::max;
        T rho_safe = max(static_cast<T>(1.0), rho);
        T r0 = max(static_cast<T>(1.0), rho0_val);
        T rho_ratio = clamp_val(rho_safe / r0, static_cast<T>(0.05), static_cast<T>(10.0));
        T c2_isen = (B_val * gamma_val / r0) * pow(rho_ratio, gamma_val - static_cast<T>(1.0));
        T e_isen = compute_energy_isentropic(rho_safe, B_val, gamma_val, r0);
        T c2 = c2_isen + (gruneisen_val / (rho_safe + static_cast<T>(1e-9))) * p + gruneisen_val * (e - e_isen);
        T c = sqrt(max(static_cast<T>(10.0), c2));
        return clamp_val(c, static_cast<T>(10.0), static_cast<T>(50000.0));
    }

    // --- 3. Shock Hugoniot Modified Tait (Mie-Gruneisen Shock Reference) ---
    template <typename T>
    HD_EOS_FUNC static T compute_pressure_hugoniot(T rho, T e, T c0_val = static_cast<T>(C0), T s_val = static_cast<T>(S_HUGONIOT),
                                                   T rho0_val = static_cast<T>(RHO0), T gruneisen_val = static_cast<T>(GRUNEISEN),
                                                   T p_cav_val = static_cast<T>(P_CAV), T p0_val = static_cast<T>(0.0)) {
        using std::max;
        T rho_safe = max(static_cast<T>(1.0), rho);
        T r0 = max(static_cast<T>(1.0), rho0_val);
        T mu = (rho_safe / r0) - static_cast<T>(1.0);
        T p_H, e_H;
        if (mu > static_cast<T>(0.0)) {
            T denom = static_cast<T>(1.0) - (s_val - static_cast<T>(1.0)) * mu;
            denom = max(static_cast<T>(0.1), denom);
            p_H = (r0 * c0_val * c0_val * mu * (static_cast<T>(1.0) + (static_cast<T>(1.0) - static_cast<T>(0.5) * gruneisen_val) * mu)) / (denom * denom);
            e_H = static_cast<T>(0.5) * p_H * (mu / (r0 * (static_cast<T>(1.0) + mu)));
        } else {
            p_H = r0 * c0_val * c0_val * mu;
            e_H = static_cast<T>(0.0);
        }
        T p = p_H + gruneisen_val * r0 * (e - e_H) + p0_val;
        return max(p_cav_val, p);
    }

    template <typename T>
    HD_EOS_FUNC static T compute_sound_speed_hugoniot(T rho, T p, T c0_val = static_cast<T>(C0), T s_val = static_cast<T>(S_HUGONIOT),
                                                      T rho0_val = static_cast<T>(RHO0), T gruneisen_val = static_cast<T>(GRUNEISEN)) {
        using std::sqrt;
        using std::max;
        T rho_safe = max(static_cast<T>(1.0), rho);
        T r0 = max(static_cast<T>(1.0), rho0_val);
        T mu = clamp_val((rho_safe / r0) - static_cast<T>(1.0), static_cast<T>(-0.95), static_cast<T>(10.0));
        T c2;
        if (mu > static_cast<T>(0.0)) {
            T denom = static_cast<T>(1.0) - (s_val - static_cast<T>(1.0)) * mu;
            denom = max(static_cast<T>(0.1), denom);
            T dp_drho_H = (c0_val * c0_val * (static_cast<T>(1.0) + (s_val - static_cast<T>(1.0)) * mu)) / (denom * denom * denom);
            c2 = dp_drho_H + (gruneisen_val / (rho_safe + static_cast<T>(1e-9))) * p;
        } else {
            c2 = c0_val * c0_val + (gruneisen_val / (rho_safe + static_cast<T>(1e-9))) * p;
        }
        T c = sqrt(max(static_cast<T>(10.0), c2));
        return clamp_val(c, static_cast<T>(10.0), static_cast<T>(50000.0));
    }

    // --- Unified Dispatchers for Backward Compatibility ---
    template <typename T>
    HD_EOS_FUNC static T compute_pressure(T rho) {
        return compute_pressure_isentropic(rho);
    }

    template <typename T>
    HD_EOS_FUNC static T compute_sound_speed(T rho) {
        return compute_sound_speed_isentropic(rho);
    }

    template <typename T>
    HD_EOS_FUNC static T compute_pressure_unified(T rho, T e, TaitVariant variant, T B_val = static_cast<T>(B),
                                                  T gamma_val = static_cast<T>(GAMMA), T rho0_val = static_cast<T>(RHO0),
                                                  T c0_val = static_cast<T>(C0), T p_cav_val = static_cast<T>(P_CAV),
                                                  T p0_val = static_cast<T>(0.0), T gruneisen_val = static_cast<T>(GRUNEISEN),
                                                  T s_val = static_cast<T>(S_HUGONIOT)) {
        if (variant == TaitVariant::CaloricGruneisen) {
            return compute_pressure_caloric(rho, e, B_val, gamma_val, rho0_val, gruneisen_val, p_cav_val, p0_val);
        } else if (variant == TaitVariant::ShockHugoniot) {
            return compute_pressure_hugoniot(rho, e, c0_val, s_val, rho0_val, gruneisen_val, p_cav_val, p0_val);
        } else {
            return compute_pressure_isentropic(rho, B_val, gamma_val, rho0_val, p_cav_val, p0_val);
        }
    }

    template <typename T>
    HD_EOS_FUNC static T compute_sound_speed_unified(T rho, T p, T e, TaitVariant variant, T B_val = static_cast<T>(B),
                                                     T gamma_val = static_cast<T>(GAMMA), T rho0_val = static_cast<T>(RHO0),
                                                     T c0_val = static_cast<T>(C0), T gruneisen_val = static_cast<T>(GRUNEISEN),
                                                     T s_val = static_cast<T>(S_HUGONIOT)) {
        if (variant == TaitVariant::CaloricGruneisen) {
            return compute_sound_speed_caloric(rho, p, e, B_val, gamma_val, rho0_val, gruneisen_val);
        } else if (variant == TaitVariant::ShockHugoniot) {
            return compute_sound_speed_hugoniot(rho, p, c0_val, s_val, rho0_val, gruneisen_val);
        } else {
            return compute_sound_speed_isentropic(rho, B_val, gamma_val, rho0_val);
        }
    }

    template <typename T>
    HD_EOS_FUNC static T compute_pressure_dispatcher(T rho, T e, const TaitEOSParams& params) {
        return compute_pressure_unified(rho, e, params.variant,
            static_cast<T>(params.B), static_cast<T>(params.gamma), static_cast<T>(params.rho0),
            static_cast<T>(params.c0), static_cast<T>(params.p_cav), static_cast<T>(params.p0),
            static_cast<T>(params.gruneisen), static_cast<T>(params.s_hugoniot));
    }

    template <typename T>
    HD_EOS_FUNC static T compute_sound_speed_dispatcher(T rho, T p, const TaitEOSParams& params, T e = static_cast<T>(0.0)) {
        return compute_sound_speed_unified(rho, p, e, params.variant,
            static_cast<T>(params.B), static_cast<T>(params.gamma), static_cast<T>(params.rho0),
            static_cast<T>(params.c0), static_cast<T>(params.gruneisen), static_cast<T>(params.s_hugoniot));
    }

    template <typename T>
    HD_EOS_FUNC static T compute_energy_dispatcher(T rho, T p, const TaitEOSParams& params) {
        T e_isen = compute_energy_isentropic(rho, static_cast<T>(params.B), static_cast<T>(params.gamma), static_cast<T>(params.rho0));
        if (params.variant == TaitVariant::CaloricGruneisen && params.gruneisen > 0.0) {
            T p_isen = compute_pressure_isentropic(rho, static_cast<T>(params.B), static_cast<T>(params.gamma), static_cast<T>(params.rho0), static_cast<T>(params.p_cav), static_cast<T>(params.p0));
            return e_isen + (p - p_isen) / (static_cast<T>(params.gruneisen) * (rho + static_cast<T>(1e-9)));
        }
        return e_isen;
    }
};

struct StiffenedGasEOS {
    template <typename T>
    HD_EOS_FUNC static T compute_pressure(T rho, T e, T gamma, T p_inf) {
        // p = (gamma - 1) * rho * e - gamma * p_inf
        T p = (gamma - static_cast<T>(1.0)) * rho * e - gamma * p_inf;
        return p;
    }

    template <typename T>
    HD_EOS_FUNC static T compute_sound_speed(T rho, T p, T gamma, T p_inf) {
        using std::sqrt;
        using std::max;
        T c2 = gamma * (p + p_inf) / (rho + static_cast<T>(1e-9));
        return sqrt(max(static_cast<T>(10.0), c2));
    }
};

} // namespace Blast
