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



#ifdef __CUDACC__
__host__ __device__
#endif
    inline double getEnergy_IdealGas(double p, double rho, double gamma) {
        return p / ((gamma - 1.0) * rho);
    }

#ifdef __CUDACC__
__host__ __device__
#endif
    inline double getEnergy_JWL(double p, double rho, const JWLParams& jwl) {
        double V = jwl.rho0 / rho;
        double f = jwl.A * (1.0 - jwl.omega / (jwl.R1 * V)) * exp(-jwl.R1 * V) +
                   jwl.B * (1.0 - jwl.omega / (jwl.R2 * V)) * exp(-jwl.R2 * V);
        return (p - f) / (jwl.omega * rho);
    }

// Returns the JWL pressure of the unreacted solid at its natural (reference) volume V=1.
// Interface cells between explosive and air must be initialized at this pressure so that
// getMixtureEnergy and getMixturePressure are consistent (inverses) from the first step.
#ifdef __CUDACC__
__host__ __device__
#endif
    inline double getReferencePressure_Unreacted(const JWLParams& unreacted) {
        // V2 = 1.0 (reference specific volume used throughout the stiffened-gas solid EoS)
        const double V2 = 1.0;
        double f2 = unreacted.A * (1.0 - unreacted.omega / (unreacted.R1 * V2)) * exp(-unreacted.R1 * V2) +
                    unreacted.B * (1.0 - unreacted.omega / (unreacted.R2 * V2)) * exp(-unreacted.R2 * V2);
        // At zero internal temperature the JWL pressure equals the cold curve f(V)
        // plus omega * rho * e_int.  For e_int = 0 (reference state), p = f(V).
        // We return fmax(0, f2) because negative JWL pressures are unphysical here.
        return fmax(0.0, f2);
    }

    constexpr double MIN_ALPHA = 1e-4;


#ifdef __CUDACC__
__host__ __device__
#endif
    inline double getMixturePressure(double E_internal, double rho, double alpha1, double alpha2, double arho1, double arho2, double gamma0, const JWLParams& products, const JWLParams& unreacted) {
        double alpha0 = 1.0 - alpha1 - alpha2;
        if (alpha0 < 0.0) alpha0 = 0.0;

        double rho1_mat = fmax(1e-6, arho1 / fmax(alpha1, 1e-10));

        double omega0 = gamma0 - 1.0;
        double omega1 = products.omega;
        double omega2 = unreacted.omega;

        if (E_internal < 0) E_internal = 1e-6; // Safeguard

        // S1, S2: smooth ramp factors that scale both the alpha/omega and f(V) JWL terms.
        // Applied uniformly to numerator AND denominator so getMixturePressure and
        // getMixtureEnergy remain exact inverses at all concentrations.
        double S1 = (alpha1 > 1e-10) ? fmin(1.0, alpha1 / 0.01) : 0.0;
        double S2 = (alpha2 > 1e-10) ? fmin(1.0, alpha2 / 0.01) : 0.0;

        double sum_alpha_omega = (alpha0 / omega0) + S1 * (alpha1 / omega1) + S2 * (alpha2 / omega2);

        // Compute the f(V) terms for JWL materials
        double sum_alpha_f_omega = 0.0;

        if (S1 > 0.0) {
            double V1 = products.rho0 / rho1_mat;
            double f1 = products.A * (1.0 - products.omega / (products.R1 * V1)) * exp(-products.R1 * V1) +
                        products.B * (1.0 - products.omega / (products.R2 * V1)) * exp(-products.R2 * V1);
            // Products JWL: f1 can be positive (high-pressure detonation products), keep as-is.
            sum_alpha_f_omega += alpha1 * S1 * f1 / omega1;
        }

        if (S2 > 0.0) {
            double V2 = 1.0; // Stiffened gas approximation for unreacted solid to prevent severe numerical stiffness
            double f2 = unreacted.A * (1.0 - unreacted.omega / (unreacted.R1 * V2)) * exp(-unreacted.R1 * V2) +
                        unreacted.B * (1.0 - unreacted.omega / (unreacted.R2 * V2)) * exp(-unreacted.R2 * V2);
            // Clamp f2 >= 0: the unreacted solid JWL cold-curve is negative at V=1 for TNT/PETN/RDX
            // (e.g. TNT: f2 ~ -347 MPa). A negative f2 forces interface cells to store ~194 MJ/m3
            // of reference energy; any flux perturbation drives recovered pressure negative.
            // Clamping to 0 makes the unreacted solid behave like a stiffened gas with zero
            // cold-curve pressure, keeping interface cell energies at ~air levels (~183 kJ/m3).
            f2 = fmax(0.0, f2);
            sum_alpha_f_omega += alpha2 * S2 * f2 / omega2;
        }

        double p = (E_internal + sum_alpha_f_omega) / sum_alpha_omega;
        return fmax(1e-6, p);
    }

#ifdef __CUDACC__
__host__ __device__
#endif
    inline double getMixtureEnergy(double p, double rho, double alpha1, double alpha2, double arho1, double arho2, double gamma0, const JWLParams& products, const JWLParams& unreacted) {
        double alpha0 = 1.0 - alpha1 - alpha2;
        if (alpha0 < 0.0) alpha0 = 0.0;

        double rho1_mat = fmax(1e-6, arho1 / fmax(alpha1, 1e-10));

        double omega0 = gamma0 - 1.0;
        double omega1 = products.omega;
        double omega2 = unreacted.omega;

        // S1, S2 must match getMixturePressure exactly so the two functions are inverses.
        double S1 = (alpha1 > 1e-10) ? fmin(1.0, alpha1 / 0.01) : 0.0;
        double S2 = (alpha2 > 1e-10) ? fmin(1.0, alpha2 / 0.01) : 0.0;

        double sum_alpha_omega = (alpha0 / omega0) + S1 * (alpha1 / omega1) + S2 * (alpha2 / omega2);
        double sum_alpha_f_omega = 0.0;

        if (S1 > 0.0) {
            double V1 = products.rho0 / rho1_mat;
            double f1 = products.A * (1.0 - products.omega / (products.R1 * V1)) * exp(-products.R1 * V1) +
                        products.B * (1.0 - products.omega / (products.R2 * V1)) * exp(-products.R2 * V1);
            sum_alpha_f_omega += alpha1 * S1 * f1 / omega1;
        }

        if (S2 > 0.0) {
            double V2 = 1.0; // Stiffened gas approximation for unreacted solid
            double f2 = unreacted.A * (1.0 - unreacted.omega / (unreacted.R1 * V2)) * exp(-unreacted.R1 * V2) +
                        unreacted.B * (1.0 - unreacted.omega / (unreacted.R2 * V2)) * exp(-unreacted.R2 * V2);
            // Clamp f2 >= 0 for stability (see getMixturePressure comment).
            f2 = fmax(0.0, f2);
            sum_alpha_f_omega += alpha2 * S2 * f2 / omega2;
        }

        return p * sum_alpha_omega - sum_alpha_f_omega;
    }

#ifdef __CUDACC__
__host__ __device__
#endif
    inline double getMixtureSoundSpeed(double p, double rho, double alpha1, double alpha2, double arho1, double arho2, double gamma0, const JWLParams& products, const JWLParams& unreacted) {
        double alpha0 = 1.0 - alpha1 - alpha2;
        if (alpha0 < 0.0) alpha0 = 0.0;

        double rho0 = fmax(1e-6, rho - arho1 - arho2);
        double rho1_mat = fmax(1e-6, arho1 / fmax(alpha1, 1e-10));

        // S1, S2: same smooth ramp as getMixturePressure/getMixtureEnergy.
        double S1 = (alpha1 > 1e-10) ? fmin(1.0, alpha1 / 0.01) : 0.0;
        double S2 = (alpha2 > 1e-10) ? fmin(1.0, alpha2 / 0.01) : 0.0;

        double c2_0 = 0.0;
        if (alpha0 > 1e-6) {
            c2_0 = (gamma0) * p / rho0;
        }

        double c2_1 = 0.0;
        if (S1 > 0.0) {
            double V1 = products.rho0 / rho1_mat;
            c2_1 = (products.A / rho1_mat) * (products.R1 * V1 - products.omega - 1.0) * exp(-products.R1 * V1) +
                   (products.B / rho1_mat) * (products.R2 * V1 - products.omega - 1.0) * exp(-products.R2 * V1) +
                   (products.omega + 1.0) * p / rho1_mat;
        }

        double c2_2 = 0.0;
        if (S2 > 0.0) {
            double V2 = 1.0; // Stiffened gas approximation for unreacted solid
            // f2 clamped to >= 0 to match getMixturePressure/getMixtureEnergy.
            double f2_raw = unreacted.A * (1.0 - unreacted.omega / (unreacted.R1 * V2)) * exp(-unreacted.R1 * V2) +
                            unreacted.B * (1.0 - unreacted.omega / (unreacted.R2 * V2)) * exp(-unreacted.R2 * V2);
            (void)f2_raw; // f2_raw unused in sound speed formula; clamping only matters for pressure/energy
            c2_2 = (unreacted.A / unreacted.rho0) * (unreacted.R1 * V2 - unreacted.omega - 1.0) * exp(-unreacted.R1 * V2) +
                   (unreacted.B / unreacted.rho0) * (unreacted.R2 * V2 - unreacted.omega - 1.0) * exp(-unreacted.R2 * V2) +
                   (unreacted.omega + 1.0) * p / unreacted.rho0;
            c2_2 = fmax(0.0, c2_2);
        }

        double inv_rho_c2 = 0.0;
        if (alpha0 > 1e-6) inv_rho_c2 += alpha0 / (rho0 * fmax(115600.0, c2_0));
        if (S1 > 0.0) inv_rho_c2 += alpha1 * S1 / (rho1_mat * fmax(115600.0, c2_1));
        if (S2 > 0.0) inv_rho_c2 += alpha2 * S2 / (unreacted.rho0 * fmax(4.0e6, c2_2));

        if (inv_rho_c2 < 1e-12) return 340.0;
        double c2 = 1.0 / (rho * inv_rho_c2);

        return sqrt(fmax(1e-6, c2));
    }

// ---------------------------------------------------------------------------
// computeProgrammedBurn
//
// Smooth linear ramp over a finite burn thickness δ = N_BURN_CELLS · dx.
//
// Define  t_arr  = det_start_time + r / D_CJ   (arrival time at cell centre)
//         τ      = δ / D_CJ                      (transit time across δ)
//
// The cumulative burn fraction at time t is:
//   F_pb(t) = clamp( (t - t_arr) / τ, 0, 1 )
//
// The increment delivered in [t-dt, t] is:
//   ΔF = F_pb(t) − F_pb(t − dt)
//
// This integrates to exactly 1 across the front, is Lipschitz continuous,
// and is stage-independent (evaluated using t and dt from the outer split).
// ---------------------------------------------------------------------------
#ifdef __CUDACC__
__host__ __device__
#endif
    inline double computeProgrammedBurn(
            double t, double dt,
            double x, double y, double z,
            double det_vel, double det_start_time,
            double det_x, double det_y, double det_z,
            double dx,
            double products_rho0,
            double& alpha1, double& alpha2,
            double& arho1,  double& arho2) {

        if (alpha2 <= MIN_ALPHA) return 0.0;   // nothing to burn

        // N_BURN_CELLS controls the detonation-front smearing width.
        // 4 cells gives a smooth profile while preserving sharp shock capture.
        constexpr int    N_BURN_CELLS = 4;
        const     double tau_burn     = N_BURN_CELLS * dx / fmax(det_vel, 1.0);

        double r       = sqrt(  (x - det_x)*(x - det_x)
                              + (y - det_y)*(y - det_y)
                              + (z - det_z)*(z - det_z));
        double t_arr   = det_start_time + r / fmax(det_vel, 1.0);

        // Clamp helper: saturates to [0,1]
        auto clamp01 = [](double v) { return v < 0.0 ? 0.0 : (v > 1.0 ? 1.0 : v); };

        double F_target = clamp01((t - t_arr) / tau_burn);
        if (F_target <= 0.0) return 0.0;

        double rho_expl   = arho1 + arho2;
        double alpha_expl = alpha1 + alpha2;

        double arho1_target = F_target * rho_expl;
        double d_arho = arho1_target - arho1;
        if (d_arho < 0.0) d_arho = 0.0;
        if (d_arho > arho2) d_arho = arho2;

        double alpha1_target = F_target * alpha_expl;
        double d_alpha = alpha1_target - alpha1;
        if (d_alpha < 0.0) d_alpha = 0.0;
        if (d_alpha > alpha2) d_alpha = alpha2;

        alpha2 -= d_alpha;
        alpha1 += d_alpha;
        arho2  -= d_arho;
        arho1  += d_arho;

        return d_arho / fmax(rho_expl, 1e-20);
    }
}

#endif
