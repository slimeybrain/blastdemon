#ifndef CONSTITUTIVE_JWL_HPP
#define CONSTITUTIVE_JWL_HPP

#include <cmath>
#include <algorithm>

#ifdef __CUDACC__
#define HD_JWL_FUNC __host__ __device__
#else
#define HD_JWL_FUNC inline
#endif

namespace Blast {
namespace JWL {

// ============================================================================
// Unreacted Solid Reactant Equation of State (Mie-Grüneisen Shock Hugoniot)
// ============================================================================

template <typename T>
HD_JWL_FUNC T computeSolidReactantPressure(
    T v_rel,            // Relative specific volume V / V0 = rho0 / rho
    T e_int,            // Specific internal energy (J/kg)
    T c0,               // Bulk acoustic sound speed (m/s)
    T s1,               // Hugoniot Us-Up slope
    T gamma0,           // Reference Grüneisen parameter
    T rho0              // Unreacted reference density (kg/m^3)
) {
    if (v_rel < static_cast<T>(0.05)) v_rel = static_cast<T>(0.05);
    T mu = static_cast<T>(1.0) - v_rel; // Compressive strain: 1 - V / V0

    T p_H = static_cast<T>(0.0);
    T e_H = static_cast<T>(0.0);

    if (mu > static_cast<T>(0.0)) {
        T denom = static_cast<T>(1.0) - s1 * mu;
        if (denom < static_cast<T>(0.1)) denom = static_cast<T>(0.1);
        p_H = (rho0 * c0 * c0 * mu) / (denom * denom);
        e_H = static_cast<T>(0.5) * p_H * mu / (rho0 > static_cast<T>(1.0) ? rho0 : static_cast<T>(1000.0));
    } else {
        // Tension / volumetric expansion
        p_H = rho0 * c0 * c0 * mu;
        e_H = static_cast<T>(0.0);
    }

    T p_solid = p_H + (gamma0 / v_rel) * (e_int - e_H);
    return p_solid;
}

// ============================================================================
// Reacted Detonation Product Gas Equation of State (Jones-Wilkins-Lee)
// ============================================================================

template <typename T>
HD_JWL_FUNC T computeJWLProductPressure(
    T v_rel,            // Relative specific volume V / V0 = rho0 / rho
    T e_int,            // Specific internal energy (J/kg)
    T A,                // High-pressure expansion coefficient (Pa)
    T B,                // Moderate-pressure expansion coefficient (Pa)
    T R1,               // High-pressure decay constant
    T R2,               // Moderate-pressure decay constant
    T omega,            // Fractional Grüneisen ratio
    T rho0              // Reference unreacted solid density (kg/m^3)
) {
    if (v_rel < static_cast<T>(0.02)) v_rel = static_cast<T>(0.02);

    T R1_V = R1 * v_rel;
    T R2_V = R2 * v_rel;

    // Numerical protection against exponential underflow / overflow
    T term1 = static_cast<T>(0.0);
    if (R1_V < static_cast<T>(80.0)) {
        term1 = A * (static_cast<T>(1.0) - (omega / (R1_V > static_cast<T>(1e-4) ? R1_V : static_cast<T>(1e-4)))) * std::exp(-R1_V);
    }

    T term2 = static_cast<T>(0.0);
    if (R2_V < static_cast<T>(80.0)) {
        term2 = B * (static_cast<T>(1.0) - (omega / (R2_V > static_cast<T>(1e-4) ? R2_V : static_cast<T>(1e-4)))) * std::exp(-R2_V);
    }

    // Thermal expansion energy term: omega * rho * e_int = (omega * rho0 * e_int) / v_rel
    T term3 = (omega * rho0 * e_int) / v_rel;

    T p_jwl = term1 + term2 + term3;
    if (p_jwl < static_cast<T>(1.0e-6)) p_jwl = static_cast<T>(1.0e-6);

    return p_jwl;
}

// Sound speed estimation along JWL state for dynamic CFL timestep calculation
template <typename T>
HD_JWL_FUNC T computeJWLSoundSpeed(
    T v_rel,
    T p_jwl,
    T A, T B, T R1, T R2, T omega, T rho0
) {
    if (v_rel < static_cast<T>(0.02)) v_rel = static_cast<T>(0.02);
    T rho = rho0 / v_rel;

    T R1_V = R1 * v_rel;
    T R2_V = R2 * v_rel;

    T term1 = static_cast<T>(0.0);
    if (R1_V < static_cast<T>(80.0)) {
        term1 = (A * R1 / rho0) * (static_cast<T>(1.0) - omega / (R1_V > static_cast<T>(1e-4) ? R1_V : static_cast<T>(1e-4))) * std::exp(-R1_V);
    }

    T term2 = static_cast<T>(0.0);
    if (R2_V < static_cast<T>(80.0)) {
        term2 = (B * R2 / rho0) * (static_cast<T>(1.0) - omega / (R2_V > static_cast<T>(1e-4) ? R2_V : static_cast<T>(1e-4))) * std::exp(-R2_V);
    }

    T c2 = term1 + term2 + ((omega + static_cast<T>(1.0)) * p_jwl) / (rho > static_cast<T>(1e-6) ? rho : static_cast<T>(1e-6));
    if (c2 < static_cast<T>(100.0)) c2 = static_cast<T>(100.0);

    return std::sqrt(c2);
}

// ============================================================================
// Programmed Wavefront Burn Arrival & Reaction Progress
// ============================================================================

template <typename T>
HD_JWL_FUNC T computeProgrammedProgress(
    T t_current,
    T t_arrival,
    T tau_burn
) {
    if (t_current < t_arrival) return static_cast<T>(0.0);
    if (tau_burn <= static_cast<T>(1.0e-12)) return static_cast<T>(1.0);

    T lambda = (t_current - t_arrival) / tau_burn;
    if (lambda < static_cast<T>(0.0)) lambda = static_cast<T>(0.0);
    if (lambda > static_cast<T>(1.0)) lambda = static_cast<T>(1.0);
    return lambda;
}

} // namespace JWL
} // namespace Blast

#endif // CONSTITUTIVE_JWL_HPP
