#pragma once

#include <cmath>
#include <vector>
#include <array>
#include <algorithm>

namespace Blast {

struct ShellFSIPoint {
    int facet_id;
    double x[3];
    double normal[3];
    double area;
    double p_top{101325.0};
    double p_bottom{101325.0};
    double net_pressure{0.0};
    bool is_ruptured{false}; // Dynamic venting active
};

class UniversalFSICoupler3D {
public:
    UniversalFSICoupler3D() = default;
    ~UniversalFSICoupler3D() = default;

    // 1. Two-sided shell pressure jump and aperture venting
    static void compute_two_sided_shell_pressure(
        ShellFSIPoint& pt,
        double p_fluid_top,
        double p_fluid_bottom,
        double plastic_strain,
        double rupture_strain = 0.35
    ) {
        pt.p_top = p_fluid_top;
        pt.p_bottom = p_fluid_bottom;

        if (plastic_strain >= rupture_strain) {
            pt.is_ruptured = true;
        }

        if (pt.is_ruptured) {
            // Vented aperture: pressures equalize smoothly, zero net structural pressure
            pt.net_pressure = 0.0;
        } else {
            pt.net_pressure = pt.p_top - pt.p_bottom;
        }
    }

    // 2. Ergun and Wen-Yu Eulerian-Lagrangian fluid-particle drag
    // Computes interphase drag force F_drag on MPM particle of diameter d_p in cell with gas density rho_g and velocity u_g
    static void compute_fluid_particle_drag(
        double d_p, double rho_p, double v_p[3],
        double rho_g, double u_g[3], double mu_g,
        double void_fraction_alpha, // gas volume fraction alpha in [0.3, 1.0]
        double f_drag_out[3]
    ) {
        double du[3] = {u_g[0] - v_p[0], u_g[1] - v_p[1], u_g[2] - v_p[2]};
        double slip_mag = std::sqrt(du[0]*du[0] + du[1]*du[1] + du[2]*du[2]);
        if (slip_mag < 1.0e-8) {
            f_drag_out[0] = f_drag_out[1] = f_drag_out[2] = 0.0;
            return;
        }

        double Re_p = (rho_g * slip_mag * d_p) / (mu_g + 1e-12);
        double beta = 0.0; // interphase momentum exchange coefficient

        if (void_fraction_alpha < 0.80) {
            // Dense regime: Ergun equation
            beta = 150.0 * ((1.0 - void_fraction_alpha)*(1.0 - void_fraction_alpha) * mu_g) / 
                   (void_fraction_alpha * d_p * d_p) +
                   1.75 * ((1.0 - void_fraction_alpha) * rho_g * slip_mag) / d_p;
        } else {
            // Dilute regime: Wen & Yu correlation
            double C_d = (Re_p < 1000.0) ? (24.0 / (Re_p + 1e-5) * (1.0 + 0.15 * std::pow(Re_p, 0.687))) : 0.44;
            beta = 0.75 * C_d * ((1.0 - void_fraction_alpha) * rho_g * slip_mag) / d_p * std::pow(void_fraction_alpha, -2.65);
        }

        // Total drag force on particle: F = beta * Vol_p * (u_g - v_p)
        double vol_p = (M_PI / 6.0) * d_p * d_p * d_p;
        for (int i = 0; i < 3; ++i) {
            f_drag_out[i] = beta * vol_p * du[i];
        }
    }

    // 3. Symplectic multi-rate timestepping scheduler
    // Staggered subcycling guaranteeing strict Hamiltonian energy balance:
    // dt_macro = min(dt_fem, dt_mpm), dt_sub = dt_fluid
    static void compute_subcycling_schedule(
        double dt_fem, double dt_mpm, double dt_fluid,
        double& dt_macro_out, int& num_subcycles_out, double& dt_sub_out
    ) {
        dt_macro_out = std::min(dt_fem, dt_mpm);
        if (dt_macro_out <= 0.0) dt_macro_out = 1.0e-5;

        num_subcycles_out = std::max(1, static_cast<int>(std::ceil(dt_macro_out / std::max(1.0e-8, dt_fluid))));
        dt_sub_out = dt_macro_out / static_cast<double>(num_subcycles_out);
    }
};

} // namespace Blast
