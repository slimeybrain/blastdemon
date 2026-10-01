#pragma once

#include <cmath>
#include <array>
#include <algorithm>

namespace Blast::DAA {

struct alignas(64) GeersHunterBubble4DOF {
    // Explosive source parameters
    double W_charge{100.0};    // Charge weight (kg TNT equivalent)
    double depth0{50.0};       // Initial detonation depth (m)
    double rho_water{1000.0};  // Water density (kg/m^3)
    double c_water{1500.0};    // Acoustic sound speed (m/s)
    double gamma_gas{1.25};    // Adiabatic index of bubble gas

    // 4 State variables: R (radius), R_dot, z (vertical position), u_z (vertical velocity)
    double R{0.5};             // Bubble radius (m)
    double R_dot{0.0};         // Radial velocity (m/s)
    double z{50.0};            // Bubble depth (m)
    double u_z{0.0};           // Vertical migration velocity (m/s)
    double time{0.0};          // Current time (s)

    // Hull interaction (Bjerknes force)
    double hull_distance{10.0}; // Distance to structural hull (m)
    bool enable_bjerknes{true};

    // Derived equilibrium properties
    double R_max{0.0};         // Rayleigh maximum bubble radius
    double T_period{0.0};      // Willis pulsation period

    void initialize(double W_kg, double depth_m) {
        W_charge = W_kg;
        depth0 = depth_m;
        z = depth_m;
        time = 0.0;

        // Willis formula for bubble period: T = K1 * W^(1/3) / (depth + 10.33)^(5/6)
        const double K1 = 2.11;
        T_period = (K1 * std::pow(W_charge, 1.0 / 3.0)) / std::pow(depth0 + 10.33, 5.0 / 6.0);

        // Maximum radius: R_max = K2 * W^(1/3) / (depth + 10.33)^(1/3)
        const double K2 = 3.50;
        R_max = (K2 * std::pow(W_charge, 1.0 / 3.0)) / std::pow(depth0 + 10.33, 1.0 / 3.0);

        R = R_max * 0.15; // Initial core radius
        R_dot = 200.0;    // Initial expansion shock velocity
        u_z = 0.0;
    }

    // Step 4-DOF ODE system via Runge-Kutta 4th Order (RK4)
    void step(double dt) {
        // Hydrostatic ambient pressure: P_inf = P_atm + rho * g * z
        auto get_derivatives = [&](double cur_R, double cur_Rdot, double cur_z, double cur_uz,
                                   double& dR, double& dRdot, double& dz, double& duz) {
            dR = cur_Rdot;
            dz = cur_uz;

            double P_inf = 101325.0 + rho_water * 9.81 * cur_z;
            double P_gas = P_inf * std::pow(R_max / std::max(0.01, cur_R), 3.0 * gamma_gas);

            // Geers-Hunter modified Keller-Miksis radial equation with acoustic radiation damping:
            // R * R_ddot * (1 - R_dot/c) + 1.5 * R_dot^2 * (1 - R_dot/(3*c)) = (1/rho) * (P_gas - P_inf) + (R / (rho*c)) * dP_gas/dt
            double dP = P_gas - P_inf;
            double num = (dP / rho_water) - 1.5 * cur_Rdot * cur_Rdot * (1.0 - cur_Rdot / (3.0 * c_water));
            double den = std::max(0.05, cur_R) * (1.0 - cur_Rdot / c_water);
            dRdot = num / den;

            // Vertical buoyant migration: du_z/dt = 2 * g - (3 / R) * R_dot * u_z - (3 / (8*R)) * C_d * |u_z| * u_z
            double buoyancy = 2.0 * 9.81;
            double drag = (3.0 / (8.0 * std::max(0.05, cur_R))) * 0.40 * std::abs(cur_uz) * cur_uz;
            double app_mass_rate = (3.0 / std::max(0.05, cur_R)) * cur_Rdot * cur_uz;
            duz = buoyancy - drag - app_mass_rate;

            // Bjerknes hull attraction: F_b = - (2 * pi * rho * R^3 * R_dot * u_z) / d^2
            if (enable_bjerknes && hull_distance > 0.5) {
                double a_bjerknes = (3.0 * cur_R * cur_Rdot * cur_uz) / (hull_distance * hull_distance);
                duz += a_bjerknes;
            }
        };

        // RK4 Sub-stepping
        double k1_R, k1_Rdot, k1_z, k1_uz;
        get_derivatives(R, R_dot, z, u_z, k1_R, k1_Rdot, k1_z, k1_uz);

        double k2_R, k2_Rdot, k2_z, k2_uz;
        get_derivatives(R + 0.5*dt*k1_R, R_dot + 0.5*dt*k1_Rdot, z + 0.5*dt*k1_z, u_z + 0.5*dt*k1_uz,
                        k2_R, k2_Rdot, k2_z, k2_uz);

        double k3_R, k3_Rdot, k3_z, k3_uz;
        get_derivatives(R + 0.5*dt*k2_R, R_dot + 0.5*dt*k2_Rdot, z + 0.5*dt*k2_z, u_z + 0.5*dt*k2_uz,
                        k3_R, k3_Rdot, k3_z, k3_uz);

        double k4_R, k4_Rdot, k4_z, k4_uz;
        get_derivatives(R + dt*k3_R, R_dot + dt*k3_Rdot, z + dt*k3_z, u_z + dt*k3_uz,
                        k4_R, k4_Rdot, k4_z, k4_uz);

        R += (dt / 6.0) * (k1_R + 2.0*k2_R + 2.0*k3_R + k4_R);
        R_dot += (dt / 6.0) * (k1_Rdot + 2.0*k2_Rdot + 2.0*k3_Rdot + k4_Rdot);
        z += (dt / 6.0) * (k1_z + 2.0*k2_z + 2.0*k3_z + k4_z);
        u_z += (dt / 6.0) * (k1_uz + 2.0*k2_uz + 2.0*k3_uz + k4_uz);

        time += dt;
    }

    // Acoustic pressure radiated at distance r
    double get_radiated_pressure(double r) const {
        double dist = std::max(R, r);
        double P_rad = (rho_water / dist) * (2.0 * R * R_dot * R_dot + R * R * (R_dot / (time + 1e-4)));
        return P_rad;
    }
};

} // namespace Blast::DAA
