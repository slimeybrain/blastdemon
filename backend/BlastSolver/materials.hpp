#ifndef MATERIALS_HPP
#define MATERIALS_HPP

#include <cmath>
#include <algorithm>
#include "cfd_eos_water.hpp"

namespace MultiMat {

    // Material 0: Air (Ideal Gas)
    // Material 1: Detonation Products (JWL)
    // Material 2: Unburned Explosive (JWL/Murnaghan, modeled as JWL for generality)

    struct JWLParams {
        double A = 0;
        double B = 0;
        double R1 = 0;
        double R2 = 0;
        double omega = 0;
        double rho0 = 0;
        double cv = 0;
        double T0 = 0;

        // Precalculated terms for fast evaluation
        double omega_over_R1 = 0;
        double omega_over_R2 = 0;
        double A_over_rho0 = 0;
        double B_over_rho0 = 0;
        double omega_plus_1 = 0;
        double f2_const = 0;
        double c2_2_const1 = 0;
        double c2_2_const2 = 0;
    };

    struct AfterburnParams {
        bool enabled = false;
        double Q_ab = 0.0;                  // Specific afterburn energy release (J/kg of reacted fuel)
        double f_fuel = 0.0;                // Combustible fuel mass fraction in detonation products
        double s_ratio = 0.0;               // Stoichiometric oxygen-to-fuel mass ratio
        double T_ign = 600.0;               // Ignition temperature threshold (K)
        double tau_chem = 1.0e-5;           // Scale-independent chemical kinetic timescale limit (s)
        double C_edc = 0.15;                // Eddy Dissipation Concept mixing constant
        double tau_expansion = 0.0;         // 0.0 = Auto Taylor-Sedov fireball scale invariant (1g to 1MT), > 0 = manual override (s)
        double ambient_o2_fraction = 0.233; // Ambient oxidizer mass fraction (0.233 for air, 0.0 for N2/inert)
        double C_mix = 0.0;                 // Deprecated legacy field kept for ABI compatibility
        double induction_delay = 0.0;       // Deprecated legacy field kept for ABI compatibility
    };

    struct MaterialSet {
        JWLParams products;
        JWLParams unreacted;
        double det_vel;
        double detonation_energy; // J/kg
        AfterburnParams afterburn;
    };

    inline void initializePrecalculatedTerms(MaterialSet& matSet) {
        using std::exp;
        
        // Products
        matSet.products.omega_over_R1 = matSet.products.omega / matSet.products.R1;
        matSet.products.omega_over_R2 = matSet.products.omega / matSet.products.R2;
        matSet.products.A_over_rho0 = matSet.products.A / matSet.products.rho0;
        matSet.products.B_over_rho0 = matSet.products.B / matSet.products.rho0;
        matSet.products.omega_plus_1 = matSet.products.omega + 1.0;
        
        // Unreacted
        matSet.unreacted.omega_over_R1 = matSet.unreacted.omega / matSet.unreacted.R1;
        matSet.unreacted.omega_over_R2 = matSet.unreacted.omega / matSet.unreacted.R2;
        matSet.unreacted.A_over_rho0 = matSet.unreacted.A / matSet.unreacted.rho0;
        matSet.unreacted.B_over_rho0 = matSet.unreacted.B / matSet.unreacted.rho0;
        matSet.unreacted.omega_plus_1 = matSet.unreacted.omega + 1.0;
        
        // f2_const for unreacted (V2 = 1.0)
        matSet.unreacted.f2_const = matSet.unreacted.A * (1.0 - matSet.unreacted.omega / matSet.unreacted.R1) * exp(-matSet.unreacted.R1) +
                                    matSet.unreacted.B * (1.0 - matSet.unreacted.omega / matSet.unreacted.R2) * exp(-matSet.unreacted.R2);
        
        // c2_2 constants for unreacted (V2 = 1.0)
        matSet.unreacted.c2_2_const1 = (matSet.unreacted.A / matSet.unreacted.rho0) * (matSet.unreacted.R1 - matSet.unreacted.omega - 1.0) * exp(-matSet.unreacted.R1) +
                                       (matSet.unreacted.B / matSet.unreacted.rho0) * (matSet.unreacted.R2 - matSet.unreacted.omega - 1.0) * exp(-matSet.unreacted.R2);
        matSet.unreacted.c2_2_const2 = (matSet.unreacted.omega + 1.0) / matSet.unreacted.rho0;
    }

    // Parameters for TNT
    // Afterburn: Real empirical calorimetry (Cooper 1996, LLNL UCRL-52997, Kuhl et al. 2010)
    // Heat of detonation: 4.29 MJ/kg, Total heat of combustion: 15.00 MJ/kg -> Q_ab = 1.071e7 J/kg
    const MaterialSet TNT = {
        // Products
        { 373.77e9, 3.747e9, 4.15, 0.90, 0.35, 1630.0, 1000.0, 300.0 },
        // Unreacted
        { 732.0e9, -5.265e9, 11.3, 1.13, 0.8938, 1630.0, 1000.0, 300.0 },
        // Det Vel
        6930.0,
        // Detonation Energy (J/kg)
        4.29e6,
        // Afterburn (Real Data: oxygen-deficient OB = -74%, first-principles EDC mixing)
        { true, 1.071e7, 0.35, 2.67, 600.0, 1.0e-5, 0.15, 0.0, 0.233, 0.0, 0.0 }
    };

    // Parameters for PETN (Pentaerythritol Tetranitrate)
    // Afterburn: Real empirical data (Dobratz 1985, LLNL UCRL-52997)
    // Nearly oxygen balanced (OB = -10.1%). Minor secondary combustion.
    const MaterialSet PETN = {
        // Products
        { 613.4e9, 15.07e9, 4.4, 1.2, 0.28, 1770.0, 1000.0, 300.0 },
        // Unreacted
        { 800.0e9, -5.0e9, 10.0, 1.0, 0.9, 1770.0, 1000.0, 300.0 },
        // Det Vel
        8300.0,
        // Detonation Energy (J/kg)
        5.80e6,
        // Afterburn (Real Data: minor secondary heat release)
        { true, 2.00e6, 0.08, 1.50, 600.0, 1.0e-5, 0.15, 0.0, 0.233, 0.0, 0.0 }
    };

    // Parameters for RDX (Hexogen)
    // Afterburn: Real empirical data (LLNL UCRL-52997, Ornellas 1982)
    // Moderately oxygen-deficient (OB = -21.6%).
    const MaterialSet RDX = {
        // Products
        { 524.2e9, 7.678e9, 4.2, 1.1, 0.34, 1806.0, 1000.0, 300.0 },
        // Unreacted
        { 770.0e9, -4.0e9, 10.5, 1.1, 0.88, 1806.0, 1000.0, 300.0 },
        // Det Vel
        8750.0,
        // Detonation Energy (J/kg)
        5.30e6,
        // Afterburn (Real Data)
        { true, 5.60e6, 0.18, 2.10, 600.0, 1.0e-5, 0.15, 0.0, 0.233, 0.0, 0.0 }
    };

    // Parameters for Nitromethane (CH3NO2) - LLNL Explosives Handbook
    // NO AFTERBURN DATA AVAILABLE: Afterburn explicitly disabled (zero afterburn)
    const MaterialSet Nitromethane = {
        // Products (JWL: A=209.2 GPa, B=5.689 GPa, R1=4.40, R2=1.20, omega=0.30, rho0=1128 kg/m3)
        { 209.2e9, 5.689e9, 4.40, 1.20, 0.30, 1128.0, 1000.0, 300.0 },
        // Unreacted
        { 770.0e9 * (1128.0 / 1800.0), -4.8e9 * (1128.0 / 1800.0), 10.5, 1.1, 0.89, 1128.0, 1000.0, 300.0 },
        // Det Vel (m/s)
        6280.0,
        // Detonation Energy (J/kg)
        4.48e6,
        // Afterburn: NO DATA AVAILABLE (Explicitly zeroed)
        { false, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0 }
    };

    // Parameters for C-4 (Composition C-4) - LLNL UCRL-52997 / Lee et al.
    // 91% RDX, 9% polyisobutylene plasticizer. Real empirical afterburn calorimetry.
    const MaterialSet C4 = {
        { 596.22e9, 13.75e9, 4.50, 1.50, 0.32, 1601.0, 1000.0, 300.0 },
        { 770.0e9 * (1601.0 / 1800.0), -4.8e9 * (1601.0 / 1800.0), 10.5, 1.1, 0.89, 1601.0, 1000.0, 300.0 },
        8193.0,
        5.60e6,
        // Afterburn: Real Data (Hydrocarbon binder aerobic combustion, Ornellas 1982)
        { true, 8.58e6, 0.28, 2.50, 600.0, 1.2e-5, 0.15, 0.0, 0.233, 0.0, 0.0 }
    };

    // Parameters for Composition B (Comp B) - Dobratz 1985 / Ornellas 1982
    // 60% RDX / 40% TNT. Real empirical afterburn calorimetry.
    const MaterialSet CompB = {
        { 524.23e9, 7.678e9, 4.20, 1.10, 0.34, 1717.0, 1000.0, 300.0 },
        { 770.0e9 * (1717.0 / 1800.0), -4.8e9 * (1717.0 / 1800.0), 10.5, 1.1, 0.89, 1717.0, 1000.0, 300.0 },
        7980.0,
        5.19e6,
        // Afterburn: Real Data (Calorimetry, Ornellas 1982, Dobratz 1985)
        { true, 8.31e6, 0.26, 2.40, 600.0, 1.0e-5, 0.15, 0.0, 0.233, 0.0, 0.0 }
    };

    // Parameters for Tritonal (80% TNT / 20% Al) - Neuwald et al. 2003 / AFATL
    // Real empirical data for aluminum aerobic combustion in expansion fireball.
    const MaterialSet Tritonal = {
        { 390.0e9, 5.0e9, 4.20, 0.95, 0.33, 1720.0, 1000.0, 300.0 },
        { 770.0e9 * (1720.0 / 1800.0), -4.8e9 * (1720.0 / 1800.0), 10.5, 1.1, 0.89, 1720.0, 1000.0, 300.0 },
        6700.0,
        5.10e6,
        // Afterburn: Real Data (Aluminum aerobic oxidation, Neuwald et al. 2003)
        { true, 1.80e7, 0.45, 2.80, 600.0, 2.0e-5, 0.15, 0.0, 0.233, 0.0, 0.0 }
    };

    // Parameters for HMX (Octogen / EDC37) - LASL Explosive Property Data
    // NO AFTERBURN DATA AVAILABLE: Afterburn explicitly disabled (zero afterburn)
    const MaterialSet HMX = {
        { 778.3e9, 7.071e9, 4.20, 1.00, 0.30, 1890.0, 1000.0, 300.0 },
        { 770.0e9 * (1890.0 / 1800.0), -4.8e9 * (1890.0 / 1800.0), 10.5, 1.1, 0.89, 1890.0, 1000.0, 300.0 },
        9110.0,
        6.20e6,
        // Afterburn: NO DATA AVAILABLE (Explicitly zeroed)
        { false, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0 }
    };

    // Parameters for PBX 9501 (95% HMX / 2.5% Estane / 2.5% BDNPA-F) - LASL Data
    // NO AFTERBURN DATA AVAILABLE: Afterburn explicitly disabled (zero afterburn)
    const MaterialSet PBX9501 = {
        { 852.4e9, 18.02e9, 4.55, 1.30, 0.38, 1830.0, 1000.0, 300.0 },
        { 770.0e9 * (1830.0 / 1800.0), -4.8e9 * (1830.0 / 1800.0), 10.5, 1.1, 0.89, 1830.0, 1000.0, 300.0 },
        8800.0,
        5.50e6,
        // Afterburn: NO DATA AVAILABLE (Explicitly zeroed)
        { false, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0 }
    };

    // Parameters for PBX 9502 (95% TATB / 5% Kel-F) - LLNL UCRL-52997
    // NO AFTERBURN DATA AVAILABLE: Afterburn explicitly disabled (zero afterburn)
    const MaterialSet PBX9502 = {
        { 732.0e9, 7.50e9, 4.20, 1.10, 0.30, 1895.0, 1000.0, 300.0 },
        { 770.0e9 * (1895.0 / 1800.0), -4.8e9 * (1895.0 / 1800.0), 10.5, 1.1, 0.89, 1895.0, 1000.0, 300.0 },
        7700.0,
        4.30e6,
        // Afterburn: NO DATA AVAILABLE (Explicitly zeroed)
        { false, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0 }
    };

    // Parameters for ANFO (Ammonium Nitrate / Fuel Oil, 94.3 / 5.7)
    // Stoichiometric oxygen-balanced formulation (OB ~ 0%): Negligible secondary afterburn.
    const MaterialSet ANFO = {
        { 100.0e9, 2.0e9, 4.00, 0.80, 0.30, 850.0, 1000.0, 300.0 },
        { 770.0e9 * (850.0 / 1800.0), -4.8e9 * (850.0 / 1800.0), 10.5, 1.1, 0.89, 850.0, 1000.0, 300.0 },
        4200.0,
        3.90e6,
        // Afterburn: Oxygen-Balanced (OB ~ 0%), explicitly zeroed
        { false, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0 }
    };

    constexpr double MIN_ALPHA = 1e-4;

    template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
    inline RealType getEnergy_IdealGas(RealType p, RealType rho, RealType gamma) {
        return p / ((gamma - (RealType)1.0) * rho);
    }

    template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
    inline RealType getEnergy_JWL(RealType p, RealType rho, const JWLParams& jwl) {
        using std::exp;
        RealType V = (RealType)jwl.rho0 / rho;
        RealType f = (RealType)jwl.A * ((RealType)1.0 - (RealType)jwl.omega_over_R1 / V) * exp(-(RealType)jwl.R1 * V) +
                     (RealType)jwl.B * ((RealType)1.0 - (RealType)jwl.omega_over_R2 / V) * exp(-(RealType)jwl.R2 * V);
        return (p - f) / ((RealType)jwl.omega * rho);
    }

    template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
    inline RealType getReferencePressure_Unreacted(const JWLParams& unreacted) {
        using std::fmax;
        return fmax((RealType)0.0, (RealType)unreacted.f2_const);
    }

    template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
    inline RealType getEnergy_Tait(RealType p, RealType rho, RealType B = 3.039e8, RealType gamma = 7.15, RealType rho0 = 1000.0, RealType gruneisen = 0.28, bool is_caloric = false) {
        RealType e_isen = Blast::TaitEOSWater::compute_energy_isentropic<RealType>(rho, B, gamma, rho0);
        if (is_caloric) {
            RealType p_isen = Blast::TaitEOSWater::compute_pressure_isentropic<RealType>(rho, B, gamma, rho0);
            return e_isen + (p - p_isen) / (gruneisen * rho + (RealType)1e-9);
        }
        return e_isen;
    }

    template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
    inline RealType getMixturePressureTait(
        RealType E_internal, RealType rho,
        RealType alpha1, RealType alpha2, RealType arho1, RealType arho2,
        RealType B, RealType gamma_tait, RealType rho0_water, RealType gruneisen,
        RealType p_cav, RealType p0,
        const JWLParams& products, const JWLParams& unreacted
    ) {
        using std::fmax;
        using std::fmin;
        using std::exp;

        if (E_internal < (RealType)0.0) E_internal = (RealType)1e-6;

        RealType alpha0 = (RealType)1.0 - alpha1 - alpha2;
        if (alpha0 < (RealType)0.0) alpha0 = (RealType)0.0;

        RealType rho0_mat = (rho - arho1 - arho2) / fmax(alpha0, (RealType)1e-10);
        // Bound intrinsic liquid water density in mixture to physically realistic liquid range [rho0_water, 1.40 * rho0_water]
        // This prevents spurious cavitation and 1/rho divergence in Tait energy when alpha0 is small (interface cells)
        rho0_mat = fmax((RealType)rho0_water, fmin((RealType)(1.40 * rho0_water), rho0_mat));
        RealType rho1_mat = fmax((RealType)1e-6, arho1 / fmax(alpha1, (RealType)1e-10));

        RealType p_isen = Blast::TaitEOSWater::compute_pressure_isentropic<RealType>(rho0_mat, B, gamma_tait, rho0_water, p_cav, p0);
        RealType e_isen = Blast::TaitEOSWater::compute_energy_isentropic<RealType>(rho0_mat, B, gamma_tait, rho0_water);

        if (alpha1 + alpha2 < (RealType)1e-8) {
            RealType spec_e = E_internal / fmax((RealType)1e-6, rho);
            RealType p = p_isen + gruneisen * rho * (spec_e - e_isen);
            return fmax(p_cav, p);
        }

        RealType omega0 = fmax((RealType)1e-4, gruneisen);
        RealType omega1 = fmax((RealType)1e-4, (RealType)products.omega);
        RealType omega2 = fmax((RealType)1e-4, (RealType)unreacted.omega);

        RealType S0 = (alpha0 > (RealType)1e-10) ? fmin((RealType)1.0, alpha0 / (RealType)0.01) : (RealType)0.0;
        RealType S1 = (alpha1 > (RealType)1e-10) ? fmin((RealType)1.0, alpha1 / (RealType)0.01) : (RealType)0.0;
        RealType S2 = (alpha2 > (RealType)1e-10) ? fmin((RealType)1.0, alpha2 / (RealType)0.01) : (RealType)0.0;

        RealType term1 = (S1 > (RealType)0.0) ? (alpha1 / omega1) : (RealType)0.0;
        RealType term2 = (S2 > (RealType)0.0) ? (alpha2 / omega2) : (RealType)0.0;
        RealType sum_alpha_omega = S0 * (alpha0 / omega0) + S1 * term1 + S2 * term2;
        if (sum_alpha_omega < (RealType)1e-6) sum_alpha_omega = (RealType)1e-6;

        RealType f0 = p_isen - gruneisen * rho0_mat * e_isen;
        RealType sum_alpha_f_omega = alpha0 * S0 * f0 / omega0;

        if (S1 > (RealType)0.0) {
            RealType V1 = fmax((RealType)1.0, (RealType)products.rho0 / fmax((RealType)1e-6, rho1_mat));
            RealType f1 = (RealType)products.A * ((RealType)1.0 - (RealType)products.omega_over_R1 / V1) * exp(-(RealType)products.R1 * V1) +
                          (RealType)products.B * ((RealType)1.0 - (RealType)products.omega_over_R2 / V1) * exp(-(RealType)products.R2 * V1);
            sum_alpha_f_omega += alpha1 * S1 * f1 / omega1;
        }

        if (S2 > (RealType)0.0) {
            RealType f2 = fmax((RealType)0.0, (RealType)unreacted.f2_const);
            sum_alpha_f_omega += alpha2 * S2 * f2 / omega2;
        }

        RealType p = (E_internal + sum_alpha_f_omega) / sum_alpha_omega;
        return fmax(p_cav, p);
    }

    template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
    inline RealType getMixturePressureTait(
        RealType E_internal, RealType rho,
        RealType alpha1, RealType alpha2, RealType arho1, RealType arho2,
        const Blast::TaitEOSParams& tait,
        const JWLParams& products, const JWLParams& unreacted
    ) {
        return getMixturePressureTait<RealType>(
            E_internal, rho, alpha1, alpha2, arho1, arho2,
            (RealType)tait.B, (RealType)tait.gamma, (RealType)tait.rho0, (RealType)tait.gruneisen,
            (RealType)tait.p_cav, (RealType)tait.p0,
            products, unreacted
        );
    }

    template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
    inline RealType getMixtureEnergyTait(
        RealType p, RealType rho,
        RealType alpha1, RealType alpha2, RealType arho1, RealType arho2,
        RealType B, RealType gamma_tait, RealType rho0_water, RealType gruneisen,
        RealType p_cav, RealType p0,
        const JWLParams& products, const JWLParams& unreacted
    ) {
        using std::fmax;
        using std::fmin;
        using std::exp;

        RealType alpha0 = (RealType)1.0 - alpha1 - alpha2;
        if (alpha0 < (RealType)0.0) alpha0 = (RealType)0.0;

        RealType rho0_mat = (rho - arho1 - arho2) / fmax(alpha0, (RealType)1e-10);
        rho0_mat = fmax((RealType)rho0_water, fmin((RealType)(1.40 * rho0_water), rho0_mat));
        RealType rho1_mat = fmax((RealType)1e-6, arho1 / fmax(alpha1, (RealType)1e-10));

        RealType p_isen = Blast::TaitEOSWater::compute_pressure_isentropic<RealType>(rho0_mat, B, gamma_tait, rho0_water, p_cav, p0);
        RealType e_isen = Blast::TaitEOSWater::compute_energy_isentropic<RealType>(rho0_mat, B, gamma_tait, rho0_water);

        if (alpha1 + alpha2 < (RealType)1e-8) {
            RealType e = e_isen + (p - p_isen) / (gruneisen * rho + (RealType)1e-9);
            return fmax((RealType)0.0, rho * e);
        }

        RealType omega0 = fmax((RealType)1e-4, gruneisen);
        RealType omega1 = fmax((RealType)1e-4, (RealType)products.omega);
        RealType omega2 = fmax((RealType)1e-4, (RealType)unreacted.omega);

        RealType S0 = (alpha0 > (RealType)1e-10) ? fmin((RealType)1.0, alpha0 / (RealType)0.01) : (RealType)0.0;
        RealType S1 = (alpha1 > (RealType)1e-10) ? fmin((RealType)1.0, alpha1 / (RealType)0.01) : (RealType)0.0;
        RealType S2 = (alpha2 > (RealType)1e-10) ? fmin((RealType)1.0, alpha2 / (RealType)0.01) : (RealType)0.0;

        RealType term1 = (S1 > (RealType)0.0) ? (alpha1 / omega1) : (RealType)0.0;
        RealType term2 = (S2 > (RealType)0.0) ? (alpha2 / omega2) : (RealType)0.0;
        RealType sum_alpha_omega = S0 * (alpha0 / omega0) + S1 * term1 + S2 * term2;
        if (sum_alpha_omega < (RealType)1e-6) sum_alpha_omega = (RealType)1e-6;

        RealType f0 = p_isen - gruneisen * rho0_mat * e_isen;
        RealType sum_alpha_f_omega = alpha0 * S0 * f0 / omega0;

        if (S1 > (RealType)0.0) {
            RealType V1 = fmax((RealType)1.0, (RealType)products.rho0 / fmax((RealType)1e-6, rho1_mat));
            RealType f1 = (RealType)products.A * ((RealType)1.0 - (RealType)products.omega_over_R1 / V1) * exp(-(RealType)products.R1 * V1) +
                          (RealType)products.B * ((RealType)1.0 - (RealType)products.omega_over_R2 / V1) * exp(-(RealType)products.R2 * V1);
            sum_alpha_f_omega += alpha1 * S1 * f1 / omega1;
        }

        if (S2 > (RealType)0.0) {
            RealType f2 = fmax((RealType)0.0, (RealType)unreacted.f2_const);
            sum_alpha_f_omega += alpha2 * S2 * f2 / omega2;
        }

        RealType E_internal = p * sum_alpha_omega - sum_alpha_f_omega;
        return fmax((RealType)0.0, E_internal);
    }

    template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
    inline RealType getMixtureEnergyTait(
        RealType p, RealType rho,
        RealType alpha1, RealType alpha2, RealType arho1, RealType arho2,
        const Blast::TaitEOSParams& tait,
        const JWLParams& products, const JWLParams& unreacted
    ) {
        return getMixtureEnergyTait<RealType>(
            p, rho, alpha1, alpha2, arho1, arho2,
            (RealType)tait.B, (RealType)tait.gamma, (RealType)tait.rho0, (RealType)tait.gruneisen,
            (RealType)tait.p_cav, (RealType)tait.p0,
            products, unreacted
        );
    }

    template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
    inline RealType getMixtureSoundSpeedTait(
        RealType p, RealType rho,
        RealType alpha1, RealType alpha2, RealType arho1, RealType arho2,
        RealType B, RealType gamma_tait, RealType rho0_water, RealType gruneisen,
        RealType p_cav, RealType p0,
        const JWLParams& products, const JWLParams& unreacted
    ) {
        using std::fmax;
        using std::fmin;
        using std::sqrt;
        using std::exp;

        RealType alpha0 = (RealType)1.0 - alpha1 - alpha2;
        if (alpha0 < (RealType)0.0) alpha0 = (RealType)0.0;

        RealType rho0_mat = (rho - arho1 - arho2) / fmax(alpha0, (RealType)1e-10);
        rho0_mat = fmax((RealType)rho0_water, fmin((RealType)(1.40 * rho0_water), rho0_mat));
        RealType rho1_mat = fmax((RealType)1e-6, arho1 / fmax(alpha1, (RealType)1e-10));

        RealType p_isen = Blast::TaitEOSWater::compute_pressure_isentropic<RealType>(rho0_mat, B, gamma_tait, rho0_water, p_cav, p0);
        RealType e_isen = Blast::TaitEOSWater::compute_energy_isentropic<RealType>(rho0_mat, B, gamma_tait, rho0_water);
        RealType spec_e = e_isen + (p - p_isen) / (gruneisen * rho0_mat + (RealType)1e-9);

        RealType c_water = Blast::TaitEOSWater::compute_sound_speed_caloric<RealType>(rho0_mat, p, spec_e, B, gamma_tait, rho0_water, gruneisen);
        RealType c2_0 = c_water * c_water;

        if (alpha1 + alpha2 < (RealType)1e-8) {
            return c_water;
        }

        RealType S0 = (alpha0 > (RealType)1e-10) ? fmin((RealType)1.0, alpha0 / (RealType)0.01) : (RealType)0.0;
        RealType S1 = (alpha1 > (RealType)1e-10) ? fmin((RealType)1.0, alpha1 / (RealType)0.01) : (RealType)0.0;
        RealType S2 = (alpha2 > (RealType)1e-10) ? fmin((RealType)1.0, alpha2 / (RealType)0.01) : (RealType)0.0;

        RealType c2_1 = (RealType)0.0;
        if (S1 > (RealType)0.0) {
            RealType V1 = fmax((RealType)1.0, (RealType)products.rho0 / fmax((RealType)1e-6, rho1_mat));
            c2_1 = ((RealType)products.A_over_rho0 * V1) * ((RealType)products.R1 * V1 - (RealType)products.omega_plus_1) * exp(-(RealType)products.R1 * V1) +
                   ((RealType)products.B_over_rho0 * V1) * ((RealType)products.R2 * V1 - (RealType)products.omega_plus_1) * exp(-(RealType)products.R2 * V1) +
                   ((RealType)products.omega_plus_1) * p / rho1_mat;
        }

        RealType c2_2 = (RealType)0.0;
        if (S2 > (RealType)0.0) {
            c2_2 = (RealType)unreacted.c2_2_const1 + (RealType)unreacted.c2_2_const2 * p;
            c2_2 = fmax((RealType)0.0, c2_2);
        }

        RealType inv_rho_c2 = (RealType)0.0;
        if (alpha0 > (RealType)1e-6) inv_rho_c2 += alpha0 * S0 / (rho0_mat * fmax((RealType)1e4, c2_0));
        if (S1 > (RealType)0.0) inv_rho_c2 += alpha1 * S1 / (rho1_mat * fmax((RealType)115600.0, c2_1));
        if (S2 > (RealType)0.0) inv_rho_c2 += alpha2 * S2 / ((RealType)unreacted.rho0 * fmax((RealType)4.0e6, c2_2));

        if (inv_rho_c2 < (RealType)1e-12) return c_water;
        RealType c2 = (RealType)1.0 / (rho * inv_rho_c2);

        return sqrt(fmax((RealType)1e-6, c2));
    }

    template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
    inline RealType getMixtureSoundSpeedTait(
        RealType p, RealType rho,
        RealType alpha1, RealType alpha2, RealType arho1, RealType arho2,
        const Blast::TaitEOSParams& tait,
        const JWLParams& products, const JWLParams& unreacted
    ) {
        return getMixtureSoundSpeedTait<RealType>(
            p, rho, alpha1, alpha2, arho1, arho2,
            (RealType)tait.B, (RealType)tait.gamma, (RealType)tait.rho0, (RealType)tait.gruneisen,
            (RealType)tait.p_cav, (RealType)tait.p0,
            products, unreacted
        );
    }

    template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
    inline RealType getMixturePressure(RealType E_internal, RealType rho, RealType alpha1, RealType alpha2, RealType arho1, RealType arho2, RealType gamma0, const JWLParams& products, const JWLParams& unreacted) {
        (void)rho;
        (void)arho2;
        if (alpha1 + alpha2 < (RealType)1e-8) {
            return fmax((RealType)1e-6, E_internal * (gamma0 - (RealType)1.0));
        }

        using std::exp;
        using std::fmax;
        using std::fmin;
        RealType alpha0 = (RealType)1.0 - alpha1 - alpha2;
        if (alpha0 < (RealType)0.0) alpha0 = (RealType)0.0;

        RealType rho1_mat = fmax((RealType)1e-6, arho1 / fmax(alpha1, (RealType)1e-10));

        RealType omega0 = fmax((RealType)1e-4, gamma0 - (RealType)1.0);
        RealType omega1 = fmax((RealType)1e-4, (RealType)products.omega);
        RealType omega2 = fmax((RealType)1e-4, (RealType)unreacted.omega);

        if (E_internal < (RealType)0.0) E_internal = (RealType)1e-6;

        RealType S1 = (alpha1 > (RealType)1e-10) ? fmin((RealType)1.0, alpha1 / (RealType)0.01) : (RealType)0.0;
        RealType S2 = (alpha2 > (RealType)1e-10) ? fmin((RealType)1.0, alpha2 / (RealType)0.01) : (RealType)0.0;

        RealType term1 = (S1 > (RealType)0.0) ? (alpha1 / omega1) : (RealType)0.0;
        RealType term2 = (S2 > (RealType)0.0) ? (alpha2 / omega2) : (RealType)0.0;
        RealType sum_alpha_omega = (alpha0 / omega0) + S1 * term1 + S2 * term2;
        RealType sum_alpha_f_omega = (RealType)0.0;

        if (S1 > (RealType)0.0) {
            RealType V1 = fmax((RealType)1.0, (RealType)products.rho0 / fmax((RealType)1e-6, rho1_mat));
            RealType f1 = (RealType)products.A * ((RealType)1.0 - (RealType)products.omega_over_R1 / V1) * exp(-(RealType)products.R1 * V1) +
                          (RealType)products.B * ((RealType)1.0 - (RealType)products.omega_over_R2 / V1) * exp(-(RealType)products.R2 * V1);
            sum_alpha_f_omega += alpha1 * S1 * f1 / omega1;
        }

        if (S2 > (RealType)0.0) {
            RealType f2 = fmax((RealType)0.0, (RealType)unreacted.f2_const);
            sum_alpha_f_omega += alpha2 * S2 * f2 / omega2;
        }

        RealType p = (E_internal + sum_alpha_f_omega) / sum_alpha_omega;
        return fmax((RealType)1e-6, p);
    }

    template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
    inline RealType getMixtureEnergy(RealType p, RealType rho, RealType alpha1, RealType alpha2, RealType arho1, RealType arho2, RealType gamma0, const JWLParams& products, const JWLParams& unreacted) {
        (void)rho;
        (void)arho2;
        RealType omega0 = fmax((RealType)1e-4, gamma0 - (RealType)1.0);
        if (alpha1 + alpha2 < (RealType)1e-8) {
            return fmax((RealType)0.0, p / omega0);
        }

        using std::exp;
        using std::fmax;
        using std::fmin;
        RealType alpha0 = (RealType)1.0 - alpha1 - alpha2;
        if (alpha0 < (RealType)0.0) alpha0 = (RealType)0.0;

        RealType rho1_mat = fmax((RealType)1e-6, arho1 / fmax(alpha1, (RealType)1e-10));

        RealType omega1 = fmax((RealType)1e-4, (RealType)products.omega);
        RealType omega2 = fmax((RealType)1e-4, (RealType)unreacted.omega);

        RealType S1 = (alpha1 > (RealType)1e-10) ? fmin((RealType)1.0, alpha1 / (RealType)0.01) : (RealType)0.0;
        RealType S2 = (alpha2 > (RealType)1e-10) ? fmin((RealType)1.0, alpha2 / (RealType)0.01) : (RealType)0.0;

        RealType term1 = (S1 > (RealType)0.0) ? (alpha1 / omega1) : (RealType)0.0;
        RealType term2 = (S2 > (RealType)0.0) ? (alpha2 / omega2) : (RealType)0.0;
        RealType sum_alpha_omega = (alpha0 / omega0) + S1 * term1 + S2 * term2;
        RealType sum_alpha_f_omega = (RealType)0.0;

        if (S1 > (RealType)0.0) {
            RealType V1 = fmax((RealType)1.0, (RealType)products.rho0 / fmax((RealType)1e-6, rho1_mat));
            RealType f1 = (RealType)products.A * ((RealType)1.0 - (RealType)products.omega_over_R1 / V1) * exp(-(RealType)products.R1 * V1) +
                          (RealType)products.B * ((RealType)1.0 - (RealType)products.omega_over_R2 / V1) * exp(-(RealType)products.R2 * V1);
            sum_alpha_f_omega += alpha1 * S1 * f1 / omega1;
        }

        if (S2 > (RealType)0.0) {
            RealType f2 = fmax((RealType)0.0, (RealType)unreacted.f2_const);
            sum_alpha_f_omega += alpha2 * S2 * f2 / omega2;
        }

        return fmax((RealType)0.0, p * sum_alpha_omega - sum_alpha_f_omega);
    }

    template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
    inline RealType getMixtureSoundSpeed(RealType p, RealType rho, RealType alpha1, RealType alpha2, RealType arho1, RealType arho2, RealType gamma0, const JWLParams& products, const JWLParams& unreacted) {
        using std::exp;
        using std::sqrt;
        using std::fmax;
        using std::fmin;

        if (alpha1 + alpha2 < (RealType)1e-8) {
            RealType c2_0 = gamma0 * p / fmax((RealType)1e-6, rho);
            return sqrt(fmax((RealType)115600.0, c2_0));
        }

        RealType alpha0 = (RealType)1.0 - alpha1 - alpha2;
        if (alpha0 < (RealType)0.0) alpha0 = (RealType)0.0;

        RealType rho0 = fmax((RealType)1e-6, rho - arho1 - arho2);
        RealType rho1_mat = fmax((RealType)1e-6, arho1 / fmax(alpha1, (RealType)1e-10));

        RealType S1 = (alpha1 > (RealType)1e-10) ? fmin((RealType)1.0, alpha1 / (RealType)0.01) : (RealType)0.0;
        RealType S2 = (alpha2 > (RealType)1e-10) ? fmin((RealType)1.0, alpha2 / (RealType)0.01) : (RealType)0.0;

        RealType c2_0 = (RealType)0.0;
        if (alpha0 > (RealType)1e-6) {
            c2_0 = gamma0 * p / rho0;
        }

        RealType c2_1 = (RealType)0.0;
        if (S1 > (RealType)0.0) {
            RealType V1 = fmax((RealType)1.0, (RealType)products.rho0 / fmax((RealType)1e-6, rho1_mat));
            c2_1 = ((RealType)products.A_over_rho0 * V1) * ((RealType)products.R1 * V1 - (RealType)products.omega_plus_1) * exp(-(RealType)products.R1 * V1) +
                   ((RealType)products.B_over_rho0 * V1) * ((RealType)products.R2 * V1 - (RealType)products.omega_plus_1) * exp(-(RealType)products.R2 * V1) +
                   ((RealType)products.omega_plus_1) * p / rho1_mat;
        }

        RealType c2_2 = (RealType)0.0;
        if (S2 > (RealType)0.0) {
            c2_2 = (RealType)unreacted.c2_2_const1 + (RealType)unreacted.c2_2_const2 * p;
            c2_2 = fmax((RealType)0.0, c2_2);
        }

        RealType inv_rho_c2 = (RealType)0.0;
        if (alpha0 > (RealType)1e-6) inv_rho_c2 += alpha0 / (rho0 * fmax((RealType)115600.0, c2_0));
        if (S1 > (RealType)0.0) inv_rho_c2 += alpha1 * S1 / (rho1_mat * fmax((RealType)115600.0, c2_1));
        if (S2 > (RealType)0.0) inv_rho_c2 += alpha2 * S2 / ((RealType)unreacted.rho0 * fmax((RealType)4.0e6, c2_2));

        if (inv_rho_c2 < (RealType)1e-12) return (RealType)340.0;
        RealType c2 = (RealType)1.0 / (rho * inv_rho_c2);

        return sqrt(fmax((RealType)1e-6, c2));
    }

    template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
    inline RealType computeProgrammedBurn(
            RealType t, RealType dt,
            RealType x, RealType y, RealType z,
            RealType det_vel, RealType det_start_time,
            RealType det_x, RealType det_y, RealType det_z,
            RealType dx,
            RealType products_rho0,
            RealType& alpha1, RealType& alpha2,
            RealType& arho1,  RealType& arho2) {

        (void)products_rho0;

        if (alpha2 <= (RealType)MIN_ALPHA) return (RealType)0.0;

        constexpr int    N_BURN_CELLS = 4;
        using std::fmax;
        using std::fmin;
        using std::sqrt;
        const     RealType tau_burn     = (RealType)N_BURN_CELLS * dx / fmax(det_vel, (RealType)1.0);

        RealType r       = sqrt(  (x - det_x)*(x - det_x)
                                + (y - det_y)*(y - det_y)
                                + (z - det_z)*(z - det_z));
        RealType t_arr   = det_start_time + r / fmax(det_vel, (RealType)1.0);

        auto clamp01 = [](RealType v) { return v < (RealType)0.0 ? (RealType)0.0 : (v > (RealType)1.0 ? (RealType)1.0 : v); };

        RealType F_target = clamp01((t + dt - t_arr) / tau_burn);
        if (F_target <= (RealType)0.0) return (RealType)0.0;

        RealType rho_expl   = arho1 + arho2;
        RealType alpha_expl = alpha1 + alpha2;

        RealType arho1_target = F_target * rho_expl;
        RealType d_arho = arho1_target - arho1;
        if (d_arho < (RealType)0.0) d_arho = (RealType)0.0;
        if (d_arho > arho2) d_arho = arho2;

        RealType alpha1_target = F_target * alpha_expl;
        RealType d_alpha = alpha1_target - alpha1;
        if (d_alpha < (RealType)0.0) d_alpha = (RealType)0.0;
        if (d_alpha > alpha2) d_alpha = alpha2;

        alpha2 -= d_alpha;
        alpha1 += d_alpha;
        arho2  -= d_arho;
        arho1  += d_arho;

        return d_arho / fmax(rho_expl, (RealType)1e-20);
    }

    template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
    inline RealType computeAfterburn(
            RealType dt,
            RealType currentTime,
            RealType R_charge,
            RealType det_vel,
            const AfterburnParams& ab,
            RealType rho,
            RealType& alpha1,
            RealType& arho1,
            RealType arho0,
            RealType& E,
            RealType kinetic_energy,
            RealType turbulent_freq = (RealType)0.0) {
        
        (void)currentTime;
        (void)R_charge;
        (void)det_vel;

        if (!ab.enabled || ab.Q_ab <= (RealType)0.0 || ab.f_fuel <= (RealType)0.0) return (RealType)0.0;
        if (arho1 <= (RealType)1e-5 || arho0 <= (RealType)1e-5) return (RealType)0.0;
        if (rho <= (RealType)1e-6) return (RealType)0.0;

        // Ambient oxidizer fraction (0.233 for standard atmospheric air, 0.0 for pure nitrogen or inert gases)
        RealType f_O2 = (RealType)ab.ambient_o2_fraction;
        if (f_O2 <= (RealType)0.0) return (RealType)0.0;

        RealType rho_O2 = f_O2 * arho0;
        RealType rho_fuel = (RealType)ab.f_fuel * arho1;
        if (rho_fuel <= (RealType)1e-6 || rho_O2 <= (RealType)1e-6) return (RealType)0.0;

        using std::fmax;
        using std::fmin;
        using std::exp;
        using std::pow;

        // Internal energy per unit mass
        RealType rho_e = E - kinetic_energy;
        if (rho_e <= (RealType)0.0) return (RealType)0.0;
        RealType e_int = rho_e / rho;

        // Mixture specific heat cv (Ambient ~ 717.6 J/(kg K), detonation products ~ 1000.0 J/(kg K))
        constexpr RealType cv_ambient = (RealType)717.6;
        constexpr RealType cv_prod = (RealType)1000.0;
        RealType cv_mix = (arho0 * cv_ambient + arho1 * cv_prod) / fmax(arho0 + arho1, (RealType)1e-12);
        RealType T_cell = e_int / cv_mix;

        // Thermal ignition gating: reaction only active if temperature exceeds threshold
        if (T_cell < (RealType)ab.T_ign) return (RealType)0.0;

        // Stoichiometric limit of fuel that can react with available O2
        RealType s = (RealType)ab.s_ratio > (RealType)0.1 ? (RealType)ab.s_ratio : (RealType)2.67;
        RealType rho_fuel_avail = fmin(rho_fuel, rho_O2 / s);

        // First-principles Eddy Dissipation Concept (EDC) mixing timescale:
        // Local turbulent strain / vorticity frequency modulates interfacial entrainment.
        // During early laminar spherical expansion, turbulent_freq ~ 0, bounded by Taylor-Sedov fireball expansion time.
        RealType C_edc = (ab.C_edc > (RealType)0.0) ? (RealType)ab.C_edc : (RealType)0.15;
        RealType tau_exp = (ab.tau_expansion > (RealType)1e-4) ? (RealType)ab.tau_expansion : (RealType)0.0;
        if (tau_exp <= (RealType)0.0) {
            if (R_charge > (RealType)1e-4) {
                // Dynamic Taylor-Sedov scale invariance across 1g to 1MT:
                // Evaluates physical fireball contact surface expansion timescale:
                // R_fireball ≈ 0.35 * R_sedov, u_expansion ≈ 2.2 * c_ambient.
                // Scale factor: k_fireball = 0.35 / 2.2 ≈ 0.16.
                RealType Q_scale = (ab.Q_ab > (RealType)1e5) ? (RealType)ab.Q_ab : (RealType)4.29e6;
                RealType rho_exp = (rho > (RealType)100.0) ? rho : (RealType)1630.0;
                constexpr RealType P_amb = (RealType)101325.0;
                constexpr RealType c_amb = (RealType)340.0;
                constexpr RealType k_fireball = (RealType)0.16;
                RealType sedov_ratio = pow((RealType)(4.0 / 3.0 * M_PI) * rho_exp * Q_scale / P_amb, (RealType)(1.0 / 3.0));
                tau_exp = (k_fireball * sedov_ratio * R_charge) / c_amb;
            } else {
                tau_exp = (RealType)0.005; // 5 ms mesoscale fireball default
            }
        }

        RealType k_mix = (RealType)1.0 / fmax(tau_exp, (RealType)1e-5);
        if (turbulent_freq > (RealType)0.0) {
            k_mix = fmax(k_mix, C_edc * turbulent_freq);
        }

        RealType tau_mix = (RealType)1.0 / fmax(k_mix, (RealType)1e-3);
        RealType tau = (RealType)ab.tau_chem + tau_mix;
        if (tau < (RealType)1e-8) tau = (RealType)1e-8;

        // Unconditionally stable exponential relaxation over dt: 1 - exp(-dt / tau)
        RealType react_frac = (RealType)1.0 - exp(-dt / tau);
        RealType d_rho_fuel = rho_fuel_avail * react_frac;

        // Total explosive detonation product mass consumed by this oxidation
        RealType f_fuel_safe = fmax((RealType)ab.f_fuel, (RealType)0.01);
        RealType d_rho_reacted = d_rho_fuel / f_fuel_safe;
        if (d_rho_reacted > arho1) d_rho_reacted = arho1;
        if (d_rho_reacted <= (RealType)0.0) return (RealType)0.0;

        // Exothermic afterburn energy release: Q_ab is specific energy per kg of explosive
        RealType d_E = d_rho_reacted * (RealType)ab.Q_ab;
        E += d_E;

        // Phase transfer: reacted detonation products converted to expanded ambient gas
        RealType d_alpha = (arho1 > (RealType)1e-12) ? (d_rho_reacted / arho1) * alpha1 : (RealType)0.0;
        if (d_alpha > alpha1) d_alpha = alpha1;

        alpha1 -= d_alpha;
        arho1  -= d_rho_reacted;

        return d_rho_reacted;
    }

    // 10-parameter backwards-compatible overload (defaults currentTime=0.0, vorticity_mag=0.0)
    template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
    inline RealType computeAfterburn(
            RealType dt,
            RealType R_charge,
            RealType det_vel,
            const AfterburnParams& ab,
            RealType rho,
            RealType& alpha1,
            RealType& arho1,
            RealType arho0,
            RealType& E,
            RealType kinetic_energy) {
        return computeAfterburn(dt, (RealType)0.0, R_charge, det_vel, ab, rho, alpha1, arho1, arho0, E, kinetic_energy, (RealType)0.0);
    }
}

#endif
