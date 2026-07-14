#ifndef MATERIALS_HPP
#define MATERIALS_HPP

#include <cmath>
#include <algorithm>

namespace MultiMat {

    // Material 0: Air (Ideal Gas)
    // Material 1: Detonation Products (JWL)
    // Material 2: Unburned Explosive (JWL/Murnaghan, modeled as JWL for generality)

    struct JWLParams {
        double A;
        double B;
        double R1;
        double R2;
        double omega;
        double rho0;
        double cv;
        double T0;

        // Precalculated terms for fast evaluation
        double omega_over_R1;
        double omega_over_R2;
        double A_over_rho0;
        double B_over_rho0;
        double omega_plus_1;
        double f2_const;
        double c2_2_const1;
        double c2_2_const2;
    };

    struct MaterialSet {
        JWLParams products;
        JWLParams unreacted;
        double det_vel;
        double detonation_energy; // J/kg
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
        double V2 = 1.0;
        matSet.unreacted.f2_const = matSet.unreacted.A * (1.0 - matSet.unreacted.omega / matSet.unreacted.R1) * exp(-matSet.unreacted.R1) +
                                    matSet.unreacted.B * (1.0 - matSet.unreacted.omega / matSet.unreacted.R2) * exp(-matSet.unreacted.R2);
        
        // c2_2 constants for unreacted (V2 = 1.0)
        matSet.unreacted.c2_2_const1 = (matSet.unreacted.A / matSet.unreacted.rho0) * (matSet.unreacted.R1 - matSet.unreacted.omega - 1.0) * exp(-matSet.unreacted.R1) +
                                       (matSet.unreacted.B / matSet.unreacted.rho0) * (matSet.unreacted.R2 - matSet.unreacted.omega - 1.0) * exp(-matSet.unreacted.R2);
        matSet.unreacted.c2_2_const2 = (matSet.unreacted.omega + 1.0) / matSet.unreacted.rho0;
    }

    // Parameters for TNT
    const MaterialSet TNT = {
        // Products
        { 373.77e9, 3.747e9, 4.15, 0.90, 0.35, 1630.0, 1000.0, 300.0 },
        // Unreacted
        { 732.0e9, -5.265e9, 11.3, 1.13, 0.8938, 1630.0, 1000.0, 300.0 },
        // Det Vel
        6930.0,
        // Detonation Energy (J/kg)
        4.29e6
    };

    // Parameters for PETN (Approximate)
    const MaterialSet PETN = {
        // Products
        { 613.4e9, 15.07e9, 4.4, 1.2, 0.28, 1770.0, 1000.0, 300.0 },
        // Unreacted
        { 800.0e9, -5.0e9, 10.0, 1.0, 0.9, 1770.0, 1000.0, 300.0 },
        // Det Vel
        8300.0,
        // Detonation Energy (J/kg)
        5.80e6
    };

    // Parameters for RDX
    const MaterialSet RDX = {
        // Products
        { 524.2e9, 7.678e9, 4.2, 1.1, 0.34, 1806.0, 1000.0, 300.0 },
        // Unreacted
        { 770.0e9, -4.0e9, 10.5, 1.1, 0.88, 1806.0, 1000.0, 300.0 },
        // Det Vel
        8750.0,
        // Detonation Energy (J/kg)
        5.30e6
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
    inline RealType getMixturePressure(RealType E_internal, RealType rho, RealType alpha1, RealType alpha2, RealType arho1, RealType arho2, RealType gamma0, const JWLParams& products, const JWLParams& unreacted) {
        if (alpha1 + alpha2 < (RealType)1e-8) {
            return fmax((RealType)1e-6, E_internal * (gamma0 - (RealType)1.0));
        }

        using std::exp;
        using std::fmax;
        using std::fmin;
        RealType alpha0 = (RealType)1.0 - alpha1 - alpha2;
        if (alpha0 < (RealType)0.0) alpha0 = (RealType)0.0;

        RealType rho1_mat = fmax((RealType)1e-6, arho1 / fmax(alpha1, (RealType)1e-10));

        RealType omega0 = gamma0 - (RealType)1.0;
        RealType omega1 = (RealType)products.omega;
        RealType omega2 = (RealType)unreacted.omega;

        if (E_internal < (RealType)0.0) E_internal = (RealType)1e-6;

        RealType S1 = (alpha1 > (RealType)1e-10) ? fmin((RealType)1.0, alpha1 / (RealType)0.01) : (RealType)0.0;
        RealType S2 = (alpha2 > (RealType)1e-10) ? fmin((RealType)1.0, alpha2 / (RealType)0.01) : (RealType)0.0;

        RealType sum_alpha_omega = (alpha0 / omega0) + S1 * (alpha1 / omega1) + S2 * (alpha2 / omega2);
        RealType sum_alpha_f_omega = (RealType)0.0;

        if (S1 > (RealType)0.0) {
            RealType V1 = (RealType)products.rho0 / rho1_mat;
            RealType f1 = (RealType)products.A * ((RealType)1.0 - (RealType)products.omega_over_R1 / V1) * exp(-(RealType)products.R1 * V1) +
                          (RealType)products.B * ((RealType)1.0 - (RealType)products.omega_over_R2 / V1) * exp(-(RealType)products.R2 * V1);
            sum_alpha_f_omega += alpha1 * S1 * f1 / omega1;
        }

        if (S2 > (RealType)0.0) {
            RealType f2 = (RealType)unreacted.f2_const;
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
        using std::exp;
        using std::fmax;
        using std::fmin;
        RealType alpha0 = (RealType)1.0 - alpha1 - alpha2;
        if (alpha0 < (RealType)0.0) alpha0 = (RealType)0.0;

        RealType rho1_mat = fmax((RealType)1e-6, arho1 / fmax(alpha1, (RealType)1e-10));

        RealType omega0 = gamma0 - (RealType)1.0;
        RealType omega1 = (RealType)products.omega;
        RealType omega2 = (RealType)unreacted.omega;

        RealType S1 = (alpha1 > (RealType)1e-10) ? fmin((RealType)1.0, alpha1 / (RealType)0.01) : (RealType)0.0;
        RealType S2 = (alpha2 > (RealType)1e-10) ? fmin((RealType)1.0, alpha2 / (RealType)0.01) : (RealType)0.0;

        RealType sum_alpha_omega = (alpha0 / omega0) + S1 * (alpha1 / omega1) + S2 * (alpha2 / omega2);
        RealType sum_alpha_f_omega = (RealType)0.0;

        if (S1 > (RealType)0.0) {
            RealType V1 = (RealType)products.rho0 / rho1_mat;
            RealType f1 = (RealType)products.A * ((RealType)1.0 - (RealType)products.omega_over_R1 / V1) * exp(-(RealType)products.R1 * V1) +
                          (RealType)products.B * ((RealType)1.0 - (RealType)products.omega_over_R2 / V1) * exp(-(RealType)products.R2 * V1);
            sum_alpha_f_omega += alpha1 * S1 * f1 / omega1;
        }

        if (S2 > (RealType)0.0) {
            RealType f2 = (RealType)unreacted.f2_const;
            sum_alpha_f_omega += alpha2 * S2 * f2 / omega2;
        }

        return p * sum_alpha_omega - sum_alpha_f_omega;
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
            RealType V1 = (RealType)products.rho0 / rho1_mat;
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

        RealType F_target = clamp01((t - t_arr) / tau_burn);
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
}

#endif
