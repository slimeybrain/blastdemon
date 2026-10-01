#include <iostream>
#include <iomanip>
#include <vector>
#include <cmath>
#include "cfd_solver_3d_cuda.hpp"

int main() {
    double cellSize = 0.125;
    double xmin = 0.0, xmax = 5.0;
    double ymin = 0.0, ymax = 5.0;
    double zmin = 0.0, zmax = 20.0;

    int nx = (int)round((xmax - xmin) / cellSize);
    int ny = (int)round((ymax - ymin) / cellSize);
    int nz = (int)round((zmax - zmin) / cellSize);

    std::cout << "Testing Quiescent Harbour: " << nx << " x " << ny << " x " << nz << ", dx=" << cellSize << std::endl;

    CFDSolver3DCuda<float, true> solver(nx, ny, nz, cellSize, xmin, ymin, zmin);
    solver.setFluxScheme("AUSM+");
    solver.setSpatialOrder(2);
    solver.setTemporalOrder(5); // ADER-2

    solver.setBoundaryConditions(
        BCType3D::REFLECTIVE, BCType3D::REFLECTIVE,
        BCType3D::REFLECTIVE, BCType3D::REFLECTIVE,
        BCType3D::REFLECTIVE, BCType3D::OUTFLOW_RIEMANN
    );

    double ambient_rho = 1.225;
    double ambient_p = 101325.0;

    Blast::Stratified3DParams strat;
    strat.enabled = true;
    strat.air_rho = ambient_rho;
    strat.p_atm = ambient_p;
    strat.gravity_z = -9.81;
    strat.water_surface_z = 10.0;
    strat.seabed_surface_z = 3.0;
    strat.k0_earth_pressure = 0.50;
    strat.tait_B = 3.039e8;
    strat.tait_gamma = 7.15;
    strat.tait_rho0 = 1025.0;
    strat.soil_density = 2000.0;
    strat.soil_c0 = 2500.0;
    strat.soil_gamma = 4.0;
    strat.soil_s = 1.35;
    strat.soil_gruneisen = 1.45;
    strat.soil_p_cav = -1.0e5;
    strat.soil_eos_variant = 2;

    Charge3DParams cp;
    cp.radius = 0.0; // NO CHARGE (Quiescent)

    MultiMat::MaterialSet matSet;
    solver.setGravity(0.0, 0.0, strat.gravity_z);
    solver.setStratifiedInitialCondition(cp, matSet, strat);

    Slice3D slice_p;
    slice_p.axis = "xz";
    slice_p.offset = 0.0;
    slice_p.quantities = {"pressure"};

    Slice3D slice_vel;
    slice_vel.axis = "xz";
    slice_vel.offset = 0.0;
    slice_vel.quantities = {"velocity"};

    int gz_bed = (int)round((strat.seabed_surface_z - zmin) / cellSize);
    int gz_surf = (int)round((strat.water_surface_z - zmin) / cellSize);

    std::cout << "Starting quiescent stepping (200 steps)..." << std::endl;
    {
        std::vector<float> p_slice = solver.extractSlice(slice_p);
        std::vector<float> vel_slice = solver.extractSlice(slice_vel);
        float p_bed_lower = p_slice[0 + (gz_bed - 1) * nx];
        float p_bed_upper = p_slice[0 + gz_bed * nx];
        float p_surf_lower = p_slice[0 + (gz_surf - 1) * nx];
        float p_surf_upper = p_slice[0 + gz_surf * nx];
        std::cout << "Step   0 | P_seabed [z=2.94: " << std::fixed << std::setprecision(1) << p_bed_lower
                  << ", z=3.06: " << p_bed_upper << "]"
                  << " | P_surface [z=9.94: " << p_surf_lower
                  << ", z=10.06: " << p_surf_upper << "]"
                  << std::endl;
    }
    Slice3D slice_rho;
    slice_rho.axis = "xz";
    slice_rho.offset = 0.0;
    slice_rho.quantities = {"density"};

    Slice3D slice_E;
    slice_E.axis = "xz";
    slice_E.offset = 0.0;
    slice_E.quantities = {"energy"};

    float max_v_overall = 0.0f;
    for (int step = 1; step <= 1000; ++step) {
        double dt = 2.0e-5;
        solver.step(dt);

        std::vector<float> p_slice = solver.extractSlice(slice_p);
        std::vector<float> vel_slice = solver.extractSlice(slice_vel);
        std::vector<float> rho_slice = solver.extractSlice(slice_rho);
        std::vector<float> e_slice = solver.extractSlice(slice_E);

        float max_v_step = 0.0f;
        int max_v_gx = 0, max_v_gy = 0, max_v_gz = 0;
        for (int gz = 0; gz < nz; ++gz) {
            for (int gx = 0; gx < nx; ++gx) {
                float v = vel_slice[gx + gz * nx];
                if (v > max_v_step) {
                    max_v_step = v;
                    max_v_gx = gx;
                    max_v_gz = gz;
                }
            }
        }
        if (max_v_step > max_v_overall) max_v_overall = max_v_step;

        if (step <= 5 || step % 100 == 0) {
            float p_bed_lower = p_slice[0 + (gz_bed - 1) * nx];
            float p_bed_upper = p_slice[0 + gz_bed * nx];
            float rho_bed_lower = rho_slice[0 + (gz_bed - 1) * nx];
            float rho_bed_upper = rho_slice[0 + gz_bed * nx];
            float v_bed_lower = vel_slice[0 + (gz_bed - 1) * nx];
            float v_bed_upper = vel_slice[0 + gz_bed * nx];
            float e_bed_upper = e_slice[0 + gz_bed * nx];
            std::cout << "Step " << std::setw(4) << step 
                      << " | t=" << std::fixed << std::setprecision(3) << (step * dt * 1000.0) << " ms"
                      << " | P_soil=" << std::fixed << std::setprecision(1) << p_bed_lower
                      << " | P_wat=" << std::fixed << std::setprecision(1) << p_bed_upper
                      << " rho_wat=" << std::fixed << std::setprecision(7) << rho_bed_upper
                      << " E_wat=" << std::scientific << std::setprecision(4) << e_bed_upper
                      << " V_wat=" << v_bed_upper
                      << " | max_v=" << std::scientific << std::setprecision(3) << max_v_step << " at (gx=" << max_v_gx << " gz=" << max_v_gz << ")"
                      << std::endl;
            if (step <= 3) {
                for (int gz = gz_bed - 1; gz <= gz_bed + 2; ++gz) {
                    std::cout << "   [step " << step << " gz=" << gz << "] P=" << std::fixed << std::setprecision(2) << p_slice[0 + gz * nx]
                              << " rho=" << std::setprecision(5) << rho_slice[0 + gz * nx]
                              << " V=" << std::scientific << std::setprecision(4) << vel_slice[0 + gz * nx]
                              << " E=" << e_slice[0 + gz * nx] << std::endl;
                }
            }
        }

        if (step == 600) {
            std::cout << "\n--- Detailed profile after Step 600 around water surface ---" << std::endl;
            for (int gz = gz_surf - 3; gz <= gz_surf + 3; ++gz) {
                double z = zmin + (gz + 0.5) * cellSize;
                std::cout << "  gz=" << gz << " z=" << std::fixed << std::setprecision(3) << z
                          << " | P=" << std::scientific << std::setprecision(4) << p_slice[0 + gz * nx]
                          << " | V=" << vel_slice[0 + gz * nx] << std::endl;
            }
            std::cout << "--- Detailed profile after Step 600 around seabed ---" << std::endl;
            for (int gz = gz_bed - 3; gz <= gz_bed + 3; ++gz) {
                double z = zmin + (gz + 0.5) * cellSize;
                std::cout << "  gz=" << gz << " z=" << std::fixed << std::setprecision(3) << z
                          << " | P=" << std::scientific << std::setprecision(4) << p_slice[0 + gz * nx]
                          << " | V=" << vel_slice[0 + gz * nx] << std::endl;
            }
        }
    }
    std::cout << "\nOverall Maximum Velocity over 1000 steps: " << std::scientific << max_v_overall << " m/s" << std::endl;
    if (max_v_overall < 0.05f) {
        std::cout << ">>> QUIESCENT HARBOUR TEST PASSED (max_v < 0.05 m/s) <<<\n" << std::endl;
        return 0;
    } else {
        std::cerr << ">>> QUIESCENT HARBOUR TEST FAILED: spurious velocity " << max_v_overall << " m/s exceeds threshold <<<\n" << std::endl;
        return 1;
    }
}
