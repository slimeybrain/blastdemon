#include <iostream>
#include <iomanip>
#include <vector>
#include <cmath>
#include <fstream>
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
    strat.soil_p_cav = 0.0; // Vacuum cutoff in absolute pressure
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

    Slice3D slice_mat;
    slice_mat.axis = "xz";
    slice_mat.offset = 0.0;
    slice_mat.quantities = {"materials"};

    // Run steps up to 4500 (spanning 9.0 ms to capture seabed shock reflection hitting cavity)
    double dt = 2.0e-6;
    double sim_time = 0.0;
    float final_max_alpha1_air = 0.0f;
    float global_min_p_soil = 1e30f;
    for (int step = 0; step <= 4500; ++step) {
        if (step > 0) {
            double cfl_dt = solver.computeStepSize(0.4);
            dt = std::min(2.0e-6, std::max(1.0e-8, cfl_dt));
            solver.step(dt);
            sim_time += dt;
        }
        bool print_step = (step % 400 == 0 || (step >= 3600 && step <= 4500 && step % 50 == 0) || step == 1 || step == 1937 || step == 2559 || step == 3862 || step == 4344);
        if (!print_step) continue;
        std::vector<float> p_slice = solver.extractSlice(slice_p);
        std::vector<float> vel_slice = solver.extractSlice(slice_vel);
        std::vector<float> a1_slice = solver.extractSlice(slice_alpha1);
        std::vector<float> rho_slice = solver.extractSlice(slice_rho);
        std::vector<float> mat_slice = solver.extractSlice(slice_mat);

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
        if (min_p_soil < global_min_p_soil) global_min_p_soil = min_p_soil;

        // Max alpha1 in air (gz >= gz_surf)
        float max_alpha1_air = 0.0f;
        for (int gz = gz_surf; gz < nz; ++gz) {
            for (int gx = 0; gx < nx; ++gx) {
                float a1 = a1_slice[gx + gz * w];
                if (a1 > max_alpha1_air) max_alpha1_air = a1;
            }
        }
        final_max_alpha1_air = max_alpha1_air;

        // Max pressure inside gas cavity (alpha1 > 0.05, z >= 7.0, z <= 12.0)
        float max_p_cavity = 0.0f;
        float max_v_cavity = 0.0f;
        float p_at_cavity_base = 0.0f;
        for (int gz = 0; gz < nz; ++gz) {
            double z = zmin + (gz + 0.5) * cellSize;
            if (z < 7.0 || z > 13.0) continue;
            for (int gx = 0; gx < nx; ++gx) {
                if (a1_slice[gx + gz * w] > 0.05f) {
                    float p = p_slice[gx + gz * w];
                    float v = vel_slice[gx + gz * w];
                    if (p > max_p_cavity) max_p_cavity = p;
                    if (v > max_v_cavity) max_v_cavity = v;
                }
            }
        }

        double dt_cfl = solver.computeStepSize(0.5);

        std::cout << "Step " << std::setw(4) << step 
                  << " (t=" << std::scientific << std::setprecision(2) << sim_time << " s)"
                  << " | P_air_surf: " << std::fixed << std::setprecision(1) << p_slice[idx_surf_air]
                  << " | P_wat_surf: " << p_slice[idx_surf_water]
                  << " | Max_alpha1_air: " << std::setprecision(4) << max_alpha1_air
                  << " | Max_P_cavity: " << std::scientific << std::setprecision(3) << max_p_cavity
                  << " | Max_V_cavity: " << std::fixed << std::setprecision(1) << max_v_cavity
                  << " | Soil [min=" << min_p_soil << ", max=" << max_p_soil << "]"
                  << " | CFL_dt: " << std::scientific << std::setprecision(2) << dt_cfl
                  << std::endl;

        if ((step >= 1600 && step <= 1700) || (step >= 2200 && step <= 2400)) {
            std::cout << "  [INTERFACE " << step << "] gz=23 (Soil): p=" << std::scientific << p_slice[0 + gz_bed * w - w]
                      << ", rho=" << rho_slice[0 + gz_bed * w - w]
                      << ", v=" << vel_slice[0 + gz_bed * w - w]
                      << " | gz=24 (Wat): p=" << p_slice[0 + gz_bed * w]
                      << ", rho=" << rho_slice[0 + gz_bed * w]
                      << ", v=" << vel_slice[0 + gz_bed * w]
                      << std::endl;
        }

        if (step == 1937 || step == 2559 || step == 2600) {
            std::cout << "--- Vertical profile at x=0 (gz_bed=" << gz_bed << ", z=" << strat.seabed_surface_z << ") ---" << std::endl;
            for (int gz = gz_bed - 4; gz <= gz_bed + 4; ++gz) {
                double z = zmin + (gz + 0.5) * cellSize;
                std::cout << "  gz=" << gz << " z=" << std::fixed << std::setprecision(3) << z
                          << " | P=" << std::scientific << std::setprecision(4) << p_slice[0 + gz * w]
                          << " | V=" << vel_slice[0 + gz * w]
                          << " | alpha1=" << a1_slice[0 + gz * w] << std::endl;
            }
            std::cout << "--- Horizontal profile at z=3.0 (gz=" << gz_bed << ") ---" << std::endl;
            for (int gx = 0; gx < 50; gx += 5) {
                std::cout << "  gx=" << gx << " x=" << gx * cellSize
                          << " | P_water(gz=" << gz_bed << ")=" << p_slice[gx + gz_bed * w]
                          << " | P_soil(gz=" << gz_bed-1 << ")=" << p_slice[gx + (gz_bed-1) * w]
                          << " | V_water=" << vel_slice[gx + gz_bed * w]
                          << " | V_soil=" << vel_slice[gx + (gz_bed-1) * w] << std::endl;
            }
            std::cout << "--- Vertical profile at x=0 across surface (gz_surf=" << gz_surf << ", z=" << strat.water_surface_z << ") ---" << std::endl;
            for (int gz = gz_surf - 4; gz <= gz_surf + 4; ++gz) {
                double z = zmin + (gz + 0.5) * cellSize;
                std::cout << "  gz=" << gz << " z=" << std::fixed << std::setprecision(3) << z
                          << " | P=" << std::scientific << std::setprecision(4) << p_slice[0 + gz * w]
                          << " | rho=" << rho_slice[0 + gz * w]
                          << " | V=" << vel_slice[0 + gz * w]
                          << " | alpha1=" << a1_slice[0 + gz * w]
                          << " | mat=" << std::fixed << std::setprecision(1) << mat_slice[0 + gz * w]
                          << std::endl;
            }
            std::cout << "--- Surface transect gz=79 (z=9.938) vs gz=80 (z=10.062) ---" << std::endl;
            for (int gx = 0; gx <= 30; gx += 2) {
                std::cout << "  gx=" << std::setw(2) << gx << " x=" << std::fixed << std::setprecision(2) << gx * cellSize
                          << " | P79=" << std::scientific << std::setprecision(2) << p_slice[gx + (gz_surf-1) * w]
                          << " P80=" << p_slice[gx + gz_surf * w]
                          << " | rho79=" << rho_slice[gx + (gz_surf-1) * w]
                          << " rho80=" << rho_slice[gx + gz_surf * w]
                          << " | a1_79=" << std::fixed << std::setprecision(2) << a1_slice[gx + (gz_surf-1) * w]
                          << " a1_80=" << a1_slice[gx + gz_surf * w]
                          << " | mat79=" << mat_slice[gx + (gz_surf-1) * w]
                          << " mat80=" << mat_slice[gx + gz_surf * w]
                          << std::endl;
            }
            if (const char* dump_ppm = std::getenv("DUMP_PPM")) {
                std::string ppm_name = "harbour_slice_step" + std::to_string(step) + ".ppm";
                std::ofstream out(ppm_name, std::ios::binary);
                out << "P6\n" << nx << " " << nz << "\n255\n";
            float log_min = std::log10(30000.0f);
            float log_max = std::log10(44474224.0f);
            for (int r = 0; r < nz; ++r) {
                int gz = nz - 1 - r;
                for (int gx = 0; gx < nx; ++gx) {
                    float val = p_slice[gx + gz * nx];
                    float val_c = std::max(30000.0f, std::min(44474224.0f, val));
                    float t = (std::log10(val_c) - log_min) / (log_max - log_min);
                    t = std::max(0.0f, std::min(1.0f, t));
                    float rf = std::max(0.0f, std::min(1.0f, 1.5f - std::abs(4.0f * t - 3.0f)));
                    float gf = std::max(0.0f, std::min(1.0f, 1.5f - std::abs(4.0f * t - 2.0f)));
                    float bf = std::max(0.0f, std::min(1.0f, 1.5f - std::abs(4.0f * t - 1.0f)));
                    out.put((unsigned char)std::round(rf * 255.0f));
                    out.put((unsigned char)std::round(gf * 255.0f));
                    out.put((unsigned char)std::round(bf * 255.0f));
                }
            }
            }
        }
    }

    double final_dt_cfl = solver.computeStepSize(0.5);
    std::cout << "\n--- VERIFICATION RESULT ---" << std::endl;
    std::cout << "Final max_alpha1_air: " << final_max_alpha1_air << std::endl;
    std::cout << "Final CFL_dt: " << final_dt_cfl << " s" << std::endl;
    std::cout << "Global min soil pressure: " << global_min_p_soil << " Pa" << std::endl;

    bool passed = true;
    if (final_max_alpha1_air <= 0.05f) {
        std::cout << "[FAIL] Detonation products failed to breach water/air interface!" << std::endl;
        passed = false;
    }
    if (final_dt_cfl <= 5.0e-7) {
        std::cout << "[FAIL] CFL timestep collapsed!" << std::endl;
        passed = false;
    }
    if (global_min_p_soil < 0.0f) {
        std::cout << "[FAIL] Seabed soil entered tension/cavitation! min_p_soil = " << global_min_p_soil << " Pa" << std::endl;
        passed = false;
    }
    if (passed) {
        std::cout << "[PASS] All physics criteria satisfied: clean breach, healthy CFL dt, and zero seabed cavitation!" << std::endl;
        return 0;
    } else {
        return 1;
    }
}
