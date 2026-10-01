#pragma once

#include <cmath>
#include <algorithm>

#ifdef __CUDACC__
#define HD_BURN_FUNC __host__ __device__
#else
#define HD_BURN_FUNC inline
#endif

namespace Blast {

/**
 * Finite-Rate Arrhenius Chemistry for Secondary Afterburn of Under-Oxygenated Detonation Gases.
 * Models aerobic combustion of CO and H2 as turbulent blast gases mix with ambient atmospheric oxygen.
 * Rate law: d(lambda_burn)/dt = A_burn * p^a * (1 - lambda_burn)^b * exp(-E_act / (R * T))
 */
struct AfterburnModel {
    template <typename T>
    HD_BURN_FUNC static T compute_afterburn_rate(
        T p, T T_gas, T Y_fuel, T Y_oxygen,
        T A_preexp = static_cast<T>(1.0e6),
        T E_activation = static_cast<T>(5.0e4),
        T R_universal = static_cast<T>(8.314)
    ) {
        if (T_gas < static_cast<T>(600.0) || Y_fuel <= static_cast<T>(1e-5) || Y_oxygen <= static_cast<T>(1e-5)) {
            return static_cast<T>(0.0);
        }

        // Arrhenius factor
        T arrhenius = std::exp(-E_activation / (R_universal * T_gas));
        // Pressure-dependent reaction rate
        T p_atm = p / static_cast<T>(101325.0);
        T p_factor = std::sqrt(std::max(static_cast<T>(0.01), p_atm));

        T omega_dot = A_preexp * p_factor * Y_fuel * Y_oxygen * arrhenius;
        return omega_dot;
    }
};

} // namespace Blast
