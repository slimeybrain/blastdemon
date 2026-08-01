#include "cfd_solver.hpp"
#include "cfd_solver_2d.hpp"
#include "cfd_solver_3d.hpp"
#include "cfd_states.hpp"
#include <iostream>
#include <vector>
#include <cmath>
#include <algorithm>
#include <iomanip>

void remap_1d_to_3d(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d,
                    CFDSolver3D& solver_3d, double x_expl, double y_expl, double z_expl, double R_remap);

void remap_2d_to_3d(int nr, int nz, double dr, double dz, const std::vector<State2D>& states_2d,
                    CFDSolver3D& solver_3d, double x_expl, double y_expl, double z_expl, double R_remap, double source_explosive_z);

int main() {
    std::cout << "========================================================\n";
    std::cout << " BlastDaemon Diagnostic: Multi-Material 3D Stability Test\n";
    std::cout << "========================================================\n\n";

    double R_tnt = 0.0527;
    double high_rho = 1630.0;
    double ambient_rho = 1.2;
    double ambient_p = 101325.0;
    double gamma = 1.4;

    double domain_r_1d = 1.5;
    int num_cells_1d = 1500;
    double dr_1d = domain_r_1d / num_cells_1d;

    std::cout << "[MultiMat 1D Setup] Initializing Multi-Material 1D TNT solver...\n";
    CFDSolverImpl<double, true> solver_1d_multi(num_cells_1d, domain_r_1d, gamma);
    solver_1d_multi.setMaterialParameters(MultiMat::TNT);
    solver_1d_multi.setFluxScheme("ausm_plus");
    solver_1d_multi.setSpatialOrder(2);
    solver_1d_multi.setTemporalOrder(2);
    solver_1d_multi.setInitialConditionTNT(R_tnt, high_rho, ambient_rho, ambient_p);

    double current_time = 0.0;
    double target_radius = 0.8; // Step 1D solver until shock is at 0.8 m
    double peak_r = 0.0;
    double peak_p_1d = 0.0;

    int steps = 0;
    while (peak_r < target_radius && current_time < 0.005) {
        double dt = solver_1d_multi.computeStepSize(0.4);
        solver_1d_multi.step(dt);
        current_time = solver_1d_multi.getTime();
        steps++;

        const auto& states = solver_1d_multi.getStates();
        peak_p_1d = 0.0; peak_r = 0.0;
        for (int i = 0; i < num_cells_1d; ++i) {
            double r = (i + 0.5) * dr_1d;
            if (states[i].p > peak_p_1d) {
                peak_p_1d = states[i].p;
                peak_r = r;
            }
        }
    }

    std::cout << "           Completed " << steps << " 1D steps. Peak P = " << peak_p_1d / 1e6 << " MPa at r = " << peak_r << " m\n\n";

    // Prepare 2D MultiMat state
    int nr2d = 200, nz2d = 400;
    double dr2d = 0.005, dz2d = 0.005; // 5 mm 2D resolution
    double source_z_2d = 1.0;

    const auto& states_1d_raw = solver_1d_multi.getStates();
    std::vector<double> r_1d(num_cells_1d);
    std::vector<MultiMaterialState> states_1d(num_cells_1d);
    for (int i = 0; i < num_cells_1d; ++i) {
        r_1d[i] = (i + 0.5) * dr_1d;
        states_1d[i].rho = states_1d_raw[i].rho;
        states_1d[i].u = states_1d_raw[i].u;
        states_1d[i].p = states_1d_raw[i].p;
        states_1d[i].alpha1 = states_1d_raw[i].alpha1;
        states_1d[i].alpha2 = states_1d_raw[i].alpha2;
        states_1d[i].arho1 = states_1d_raw[i].arho1;
        states_1d[i].arho2 = states_1d_raw[i].arho2;
    }

    std::vector<State2D> states_2d(nr2d * nz2d);
    State2D amb_2d;
    amb_2d.rho = ambient_rho; amb_2d.p = ambient_p; amb_2d.ur = 0.0; amb_2d.uz = 0.0;
    amb_2d.alpha1 = 0.0; amb_2d.alpha2 = 0.0; amb_2d.arho1 = 0.0; amb_2d.arho2 = 0.0;

    for (int i = 0; i < nr2d; ++i) {
        double r_cell = (i + 0.5) * dr2d;
        for (int j = 0; j < nz2d; ++j) {
            double z_cell = (j + 0.5) * dz2d;
            double dist = std::sqrt(r_cell * r_cell + (z_cell - source_z_2d) * (z_cell - source_z_2d));
            State2D s = amb_2d;
            if (dist <= r_1d.front()) {
                s.rho = states_1d[0].rho; s.p = states_1d[0].p; double u = states_1d[0].u;
                s.ur = u * (r_cell / std::max(1e-9, dist));
                s.uz = u * ((z_cell - source_z_2d) / std::max(1e-9, dist));
                s.alpha1 = states_1d[0].alpha1; s.alpha2 = states_1d[0].alpha2;
                s.arho1 = states_1d[0].arho1; s.arho2 = states_1d[0].arho2;
            } else if (dist < r_1d.back()) {
                auto it = std::lower_bound(r_1d.begin(), r_1d.end(), dist);
                size_t idx = std::distance(r_1d.begin(), it);
                double t = (dist - r_1d[idx-1]) / (r_1d[idx] - r_1d[idx-1]);
                s.rho = states_1d[idx-1].rho + t * (states_1d[idx].rho - states_1d[idx-1].rho);
                s.p = states_1d[idx-1].p + t * (states_1d[idx].p - states_1d[idx-1].p);
                double u = states_1d[idx-1].u + t * (states_1d[idx].u - states_1d[idx-1].u);
                s.ur = u * (r_cell / std::max(1e-9, dist));
                s.uz = u * ((z_cell - source_z_2d) / std::max(1e-9, dist));
                s.alpha1 = states_1d[idx-1].alpha1 + t * (states_1d[idx].alpha1 - states_1d[idx-1].alpha1);
                s.alpha2 = states_1d[idx-1].alpha2 + t * (states_1d[idx].alpha2 - states_1d[idx-1].alpha2);
                s.arho1 = states_1d[idx-1].arho1 + t * (states_1d[idx].arho1 - states_1d[idx-1].arho1);
                s.arho2 = states_1d[idx-1].arho2 + t * (states_1d[idx].arho2 - states_1d[idx-1].arho2);
            }
            states_2d[i * nz2d + j] = s;
        }
    }

    std::cout << "[MultiMat 2D->3D Remap] Remapping Multi-Material 2D state into 3D solver...\n";
    int nx3d = 80, ny3d = 80, nz3d = 80;
    double domain_sz = 2.0;
    double dx3d = domain_sz / nx3d;

    CFDSolver3DImpl<double, true> solver_3d_multimat(nx3d, ny3d, nz3d, dx3d, -1.0, -1.0, -1.0);
    solver_3d_multimat.setMaterialParameters(MultiMat::TNT);
    solver_3d_multimat.setAmbientState(ambient_rho, ambient_p);
    solver_3d_multimat.setFluxScheme("ausm_plus");
    solver_3d_multimat.setSpatialOrder(2);
    solver_3d_multimat.setTemporalOrder(2);
    solver_3d_multimat.setIdealGas(false);



    solver_3d_multimat.initializeFrom2D(nr2d, nz2d, dr2d, dz2d, states_2d, 0.0, 0.0, 0.0, 0.0, source_z_2d);

    std::cout << "Stepping 3D Multi-Material solver for 50 timesteps after remapping...\n";
    bool unstable = false;
    for (int step = 1; step <= 50; ++step) {
        double dt = solver_3d_multimat.computeStepSize(0.1);
        solver_3d_multimat.step(dt);

        double max_p = 0.0, min_p = 1e12;
        int bad_i = -1, bad_j = -1, bad_k = -1;
        for (int k = 0; k < nz3d; ++k) {
            for (int j = 0; j < ny3d; ++j) {
                for (int i = 0; i < nx3d; ++i) {
                    double p = solver_3d_multimat.sampleState(i, j, k).p;
                    if (std::isnan(p) || p <= 0.0 || p > 1e11) {
                        unstable = true;
                        bad_i = i; bad_j = j; bad_k = k;
                    }
                    if (p > max_p) max_p = p;
                    if (p < min_p) min_p = p;
                }
            }
        }
        if (step % 10 == 0 || unstable) {
            std::cout << "  Step " << std::setw(2) << step 
                      << " (t = " << std::fixed << std::setprecision(5) << solver_3d_multimat.getTime()*1e3 << " ms):"
                      << " Peak P = " << max_p / 1e6 << " MPa, Min P = " << min_p << " Pa\n";
        }
        if (unstable) {
            std::cout << " -> UNSTABLE / NAN AT STEP " << step << " at cell (" << bad_i << ", " << bad_j << ", " << bad_k << ")\n";
            auto state = solver_3d_multimat.sampleState(bad_i, bad_j, bad_k);
            std::cout << "    State: rho=" << state.rho << ", p=" << state.p << ", E=" << state.E 
                      << ", ux=" << state.ux << ", uy=" << state.uy << ", uz=" << state.uz << "\n";
            break;
        }
    }

    if (!unstable) {
        std::cout << "\n -> RESULT: Multi-Material 3D time stepping is STABLE & SMOOTH!\n";
    }

    return 0;
}
