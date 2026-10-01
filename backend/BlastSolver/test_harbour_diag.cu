#include <iostream>
#include <iomanip>
#include <vector>
#include <cmath>
#include "cfd_solver_3d_cuda.hpp"

int main() {
    double cellSize = 0.125;
    double xmin = 0.0, xmax = 10.0;
    double ymin = 0.0, ymax = 10.0;
    double zmin = 0.0, zmax = 20.0;

    int nx = (int)round((xmax - xmin) / cellSize);
    int ny = (int)round((ymax - ymin) / cellSize);
    int nz = (int)round((zmax - zmin) / cellSize);

    std::cout << "Initializing Harbour 3D Test: " << nx << " x " << ny << " x " << nz << ", dx=" << cellSize << std::endl;

    CFDSolver3DCuda<float, true> solver(nx, ny, nz, cellSize, xmin, ymin, zmin);
    solver.setFluxScheme("AUSM+");
    solver.setSpatialOrder(2);
    solver.setTemporalOrder(5); // ADER-2

    solver.setBoundaryConditions(
        BCType3D::REFLECTIVE, BCType3D::OUTFLOW_RIEMANN,
        BCType3D::REFLECTIVE, BCType3D::OUTFLOW_RIEMANN,
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
    cp.shape_type = 0; // Sphere
    cp.x = 0.0; cp.y = 0.0; cp.z = 9.5;
    cp.radius = 0.33; // ~250 kg TNT sphere

    MultiMat::MaterialSet matSet;
    matSet.products.A = 3.712e11;
    matSet.products.B = 3.23e9;
    matSet.products.R1 = 4.15;
    matSet.products.R2 = 0.95;
    // matSet.products
    matSet.products.omega = 0.30;
    matSet.products.rho0 = 1630.0;
    matSet.unreacted = matSet.products;
    matSet.det_vel = 6930.0;
    matSet.detonation_energy = 4.29e6;

    solver.setGravity(0.0, 0.0, strat.gravity_z);
    solver.setStratifiedInitialCondition(cp, matSet, strat);
    solver.setDetonatorLocation(0.0, 0.0, 9.5);

    std::cout << "Initial condition set. Number of active tiles: " << solver.getNumActiveTiles() << std::endl;

    Slice3D slice_p;
    slice_p.axis = "xz";
    slice_p.offset = 0.0;
    slice_p.quantities = {"pressure"};

    Slice3D slice_rho;
    slice_rho.axis = "xz";
    slice_rho.offset = 0.0;
    slice_rho.quantities = {"density"};

    Slice3D slice_vel;
    slice_vel.axis = "xz";
    slice_vel.offset = 0.0;
    slice_vel.quantities = {"velocity"};

    Slice3D slice_alpha1;
    slice_alpha1.axis = "xz";
    slice_alpha1.offset = 0.0;
    slice_alpha1.quantities = {"alpha1"};

    // Let's run steps up to 1950
    double dt = 2.0e-6;
    double sim_time = 0.0;
    float final_max_alpha1_air = 0.0f;
    for (int step = 0; step <= 1950; ++step) {
        if (step > 0) {
            double cfl_dt = solver.computeStepSize(0.4);
            dt = std::min(2.0e-6, std::max(1.0e-8, cfl_dt));
            solver.step(dt);
            sim_time += dt;
        }
        bool print_step = (step % 200 == 0 || step == 1 || step == 50 || step == 100 || step == 1937 || (step >= 1800 && step % 10 == 0));
        if (!print_step) continue;
        std::vector<float> p_slice = solver.extractSlice(slice_p);
        std::vector<float> vel_slice = solver.extractSlice(slice_vel);
        std::vector<float> a1_slice = solver.extractSlice(slice_alpha1);
        std::vector<float> rho_slice = solver.extractSlice(slice_rho);

        int w = nx;
        int gz_bed = (int)round((strat.seabed_surface_z - zmin) / cellSize);
        int gz_surf = (int)round((strat.water_surface_z - zmin) / cellSize);
        int idx_water = 0 + gz_bed * w;
        int idx_soil_top = 0 + (gz_bed - 1) * w;
        int idx_surf_water = 0 + (gz_surf - 1) * w;
        int idx_surf_air = 0 + gz_surf * w;

        // Min/max in soil (gz < gz_bed)
        float min_p_soil = 1e30f, max_p_soil = -1e30f;
        float max_v_soil = 0.0f;
        for (int gz = 0; gz < gz_bed; ++gz) {
            for (int gx = 0; gx < nx; ++gx) {
                float p = p_slice[gx + gz * w];
                float v = vel_slice[gx + gz * w];
                if (p < min_p_soil) min_p_soil = p;
                if (p > max_p_soil) max_p_soil = p;
                if (v > max_v_soil) max_v_soil = v;
            }
        }

        // Max alpha1 in air (gz >= gz_surf)
        float max_alpha1_air = 0.0f;
        for (int gz = gz_surf; gz < nz; ++gz) {
            for (int gx = 0; gx < nx; ++gx) {
                float a1 = a1_slice[gx + gz * w];
                if (a1 > max_alpha1_air) max_alpha1_air = a1;
            }
        }
        final_max_alpha1_air = max_alpha1_air;

        double dt_cfl = solver.computeStepSize(0.5);

        std::cout << "Step " << std::setw(4) << step 
                  << " (t=" << std::scientific << std::setprecision(2) << sim_time << " s)"
                  << " | P_air_surf: " << std::fixed << std::setprecision(1) << p_slice[idx_surf_air]
                  << " | P_wat_surf: " << p_slice[idx_surf_water]
                  << " | Max_alpha1_air: " << std::setprecision(4) << max_alpha1_air
                  << " | Soil [min=" << min_p_soil << ", max=" << max_p_soil << "]"
                  << " | Max_v_soil: " << std::scientific << std::setprecision(2) << max_v_soil
                  << " | CFL_dt: " << std::scientific << std::setprecision(2) << dt_cfl
                  << std::endl;

        if (step == 1937 || step == 1000) {
            std::cout << "--- Vertical profile at x=0 (gz_bed=" << gz_bed << ", z=" << strat.seabed_surface_z << ") ---" << std::endl;
            for (int gz = gz_bed - 4; gz <= gz_bed + 4; ++gz) {
                double z = zmin + (gz + 0.5) * cellSize;
                std::cout << "  gz=" << gz << " z=" << std::fixed << std::setprecision(3) << z
                          << " | P=" << std::scientific << std::setprecision(4) << p_slice[0 + gz * w]
                          << " | V=" << vel_slice[0 + gz * w]
                          << " | alpha1=" << a1_slice[0 + gz * w] << std::endl;
            }
            std::cout << "--- Vertical profile at x=0 (gz_surf=" << gz_surf << ", z=" << strat.water_surface_z << ") ---" << std::endl;
            for (int gz = gz_surf - 4; gz <= gz_surf + 4; ++gz) {
                double z = zmin + (gz + 0.5) * cellSize;
                std::cout << "  gz=" << gz << " z=" << std::fixed << std::setprecision(3) << z
                          << " | P=" << std::scientific << std::setprecision(4) << p_slice[0 + gz * w]
                          << " | V=" << vel_slice[0 + gz * w]
                          << " | alpha1=" << a1_slice[0 + gz * w] << std::endl;
            }
        }
    }

    double final_dt_cfl = solver.computeStepSize(0.5);
    std::cout << "\n--- VERIFICATION RESULT ---" << std::endl;
    std::cout << "Final max_alpha1_air: " << final_max_alpha1_air << std::endl;
    std::cout << "Final CFL_dt: " << final_dt_cfl << " s" << std::endl;
    if (final_max_alpha1_air > 0.05f && final_dt_cfl > 5.0e-7) {
        std::cout << "[PASS] Detonation products successfully breached water/air interface and expanded into air with healthy dt!" << std::endl;
        return 0;
    } else {
        std::cout << "[FAIL] Verification criteria failed (breach or dt collapse)!" << std::endl;
        return 1;
    }
}
