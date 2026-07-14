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
    };

    struct MaterialSet {
        JWLParams products;
        JWLParams unreacted;
        double det_vel;
        double detonation_energy; // J/kg
    };

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
        RealType f = (RealType)jwl.A * ((RealType)1.0 - (RealType)jwl.omega / ((RealType)jwl.R1 * V)) * exp(-(RealType)jwl.R1 * V) +
                     (RealType)jwl.B * ((RealType)1.0 - (RealType)jwl.omega / ((RealType)jwl.R2 * V)) * exp(-(RealType)jwl.R2 * V);
        return (p - f) / ((RealType)jwl.omega * rho);
    }

    template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
    inline RealType getReferencePressure_Unreacted(const JWLParams& unreacted) {
        using std::exp;
        using std::fmax;
        const RealType V2 = (RealType)1.0;
        RealType f2 = (RealType)unreacted.A * ((RealType)1.0 - (RealType)unreacted.omega / ((RealType)unreacted.R1 * V2)) * exp(-(RealType)unreacted.R1 * V2) +
                      (RealType)unreacted.B * ((RealType)1.0 - (RealType)unreacted.omega / ((RealType)unreacted.R2 * V2)) * exp(-(RealType)unreacted.R2 * V2);
        return fmax((RealType)0.0, f2);
    }

    template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
    inline RealType getMixturePressure(RealType E_internal, RealType rho, RealType alpha1, RealType alpha2, RealType arho1, RealType arho2, RealType gamma0, const JWLParams& products, const JWLParams& unreacted) {
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
            RealType f1 = (RealType)products.A * ((RealType)1.0 - (RealType)products.omega / ((RealType)products.R1 * V1)) * exp(-(RealType)products.R1 * V1) +
                          (RealType)products.B * ((RealType)1.0 - (RealType)products.omega / ((RealType)products.R2 * V1)) * exp(-(RealType)products.R2 * V1);
            sum_alpha_f_omega += alpha1 * S1 * f1 / omega1;
        }

        if (S2 > (RealType)0.0) {
            RealType V2 = (RealType)1.0;
            RealType f2 = (RealType)unreacted.A * ((RealType)1.0 - (RealType)unreacted.omega / ((RealType)unreacted.R1 * V2)) * exp(-(RealType)unreacted.R1 * V2) +
                          (RealType)unreacted.B * ((RealType)1.0 - (RealType)unreacted.omega / ((RealType)unreacted.R2 * V2)) * exp(-(RealType)unreacted.R2 * V2);
            f2 = fmax((RealType)0.0, f2);
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
            RealType f1 = (RealType)products.A * ((RealType)1.0 - (RealType)products.omega / ((RealType)products.R1 * V1)) * exp(-(RealType)products.R1 * V1) +
                          (RealType)products.B * ((RealType)1.0 - (RealType)products.omega / ((RealType)products.R2 * V1)) * exp(-(RealType)products.R2 * V1);
            sum_alpha_f_omega += alpha1 * S1 * f1 / omega1;
        }

        if (S2 > (RealType)0.0) {
            RealType V2 = (RealType)1.0;
            RealType f2 = (RealType)unreacted.A * ((RealType)1.0 - (RealType)unreacted.omega / ((RealType)unreacted.R1 * V2)) * exp(-(RealType)unreacted.R1 * V2) +
                          (RealType)unreacted.B * ((RealType)1.0 - (RealType)unreacted.omega / ((RealType)unreacted.R2 * V2)) * exp(-(RealType)unreacted.R2 * V2);
            f2 = fmax((RealType)0.0, f2);
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
            c2_1 = ((RealType)products.A / rho1_mat) * ((RealType)products.R1 * V1 - (RealType)products.omega - (RealType)1.0) * exp(-(RealType)products.R1 * V1) +
                   ((RealType)products.B / rho1_mat) * ((RealType)products.R2 * V1 - (RealType)products.omega - (RealType)1.0) * exp(-(RealType)products.R2 * V1) +
                   ((RealType)products.omega + (RealType)1.0) * p / rho1_mat;
        }

        RealType c2_2 = (RealType)0.0;
        if (S2 > (RealType)0.0) {
            RealType V2 = (RealType)1.0;
            c2_2 = ((RealType)unreacted.A / (RealType)unreacted.rho0) * ((RealType)unreacted.R1 * V2 - (RealType)unreacted.omega - (RealType)1.0) * exp(-(RealType)unreacted.R1 * V2) +
                   ((RealType)unreacted.B / (RealType)unreacted.rho0) * ((RealType)unreacted.R2 * V2 - (RealType)unreacted.omega - (RealType)1.0) * exp(-(RealType)unreacted.R2 * V2) +
                   ((RealType)unreacted.omega + (RealType)1.0) * p / (RealType)unreacted.rho0;
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
