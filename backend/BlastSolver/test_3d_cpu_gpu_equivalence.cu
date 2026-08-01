#include "cfd_solver_3d.hpp"
#include "cfd_solver_3d_cuda.hpp"
#include <iostream>
#include <vector>
#include <cmath>
#include <iomanip>
#include <algorithm>

int main(int argc, char* argv[]) {
    std::cout << "===========================================================\n";
    std::cout << "3D CPU vs GPU SINGLE PRECISION IDEAL GAS EQUIVALENCE TEST\n";
    std::cout << "===========================================================\n\n";

    std::string flux_scheme = "Rusanov";
    int spatial_order = 1;
    int temporal_order = 1;
    if (argc > 1) flux_scheme = argv[1];
    if (argc > 2) spatial_order = std::stoi(argv[2]);
    if (argc > 3) temporal_order = std::stoi(argv[3]);


    int nx = 32, ny = 32, nz = 32;
    double cellSize = 0.01;
    double xmin = 0.0, ymin = 0.0, zmin = 0.0;

    std::cout << "Config: Grid (" << nx << "x" << ny << "x" << nz << "), dx=" << cellSize 
              << ", Flux=" << flux_scheme << ", Spatial=" << spatial_order << ", Temporal=" << temporal_order << "\n";

    // 1. CPU Solver
    CFDSolver3DImpl<float, false> solver_cpu(nx, ny, nz, cellSize, xmin, ymin, zmin);
    solver_cpu.setFluxScheme(flux_scheme);
    solver_cpu.setSpatialOrder(spatial_order);
    solver_cpu.setTemporalOrder(temporal_order);
    solver_cpu.setBoundaryConditions(
        BCType3D::REFLECTIVE, BCType3D::TRANSMISSIVE,
        BCType3D::REFLECTIVE, BCType3D::TRANSMISSIVE,
        BCType3D::REFLECTIVE, BCType3D::TRANSMISSIVE
    );

    // 2. GPU Solver
    CFDSolver3DCuda<float, false> solver_gpu(nx, ny, nz, cellSize, xmin, ymin, zmin);
    solver_gpu.setFluxScheme(flux_scheme);
    solver_gpu.setSpatialOrder(spatial_order);
    solver_gpu.setTemporalOrder(temporal_order);
    solver_gpu.setBoundaryConditions(
        BCType3D::REFLECTIVE, BCType3D::TRANSMISSIVE,
        BCType3D::REFLECTIVE, BCType3D::TRANSMISSIVE,
        BCType3D::REFLECTIVE, BCType3D::TRANSMISSIVE
    );



    // Initial Condition
    Charge3DParams charge{};
    charge.shape_type = 0; // Sphere
    charge.x = 0.16; charge.y = 0.16; charge.z = 0.16;
    charge.radius = 0.05;

    MultiMat::MaterialSet mats{};
    mats.products.A = 3.73e11;
    mats.products.B = 3.74e9;
    mats.products.R1 = 4.15;
    mats.products.R2 = 0.9;
    mats.products.omega = 0.35;
    mats.products.rho0 = 1630.0;
    mats.detonation_energy = 4.52e6;
    mats.unreacted = mats.products;


    double amb_rho = 1.225;
    double amb_p = 101325.0;

    solver_cpu.setInitialCondition(charge, mats, amb_rho, amb_p);
    solver_gpu.setInitialCondition(charge, mats, amb_rho, amb_p);

    // Gauges
    Gauge3D g1{"g_center", 0.16, 0.16, 0.16};
    Gauge3D g2{"g_sub_edge", 0.23, 0.16, 0.16};
    Gauge3D g3{"g_outside", 0.28, 0.16, 0.16};

    // Slices
    Slice3D slice_xy;
    slice_xy.axis = "xy";
    slice_xy.offset = 0.16;
    slice_xy.stride = 1;
    slice_xy.quantities = {"pressure", "density"};

    int num_steps = 10;
    double cfl = 0.35;

    std::cout << "\nRunning " << num_steps << " step comparison...\n";
    std::cout << std::setw(6) << "Step" 
              << std::setw(14) << "MaxDiff Rho" 
              << std::setw(14) << "MaxDiff P"
              << std::setw(14) << "RelDiff P"
              << std::setw(14) << "Gauge1 CPU"
              << std::setw(14) << "Gauge1 GPU"
              << std::setw(14) << "Gauge2 CPU"
              << std::setw(14) << "Gauge2 GPU\n";
    std::cout << "---------------------------------------------------------------------------------------------------\n";

    bool failed = false;

    for (int step = 0; step <= num_steps; ++step) {
        if (step > 0) {
            double dt_cpu = solver_cpu.computeStepSize(cfl);
            double dt_gpu = solver_gpu.computeStepSize(cfl);
            double dt = std::min(dt_cpu, dt_gpu);

            solver_cpu.step(dt);
            solver_gpu.step(dt);
        }

        // Extract slice data to compare cell by cell
        auto slice_cpu = solver_cpu.extractSlice(slice_xy);
        auto slice_gpu = solver_gpu.extractSlice(slice_xy);

        // Compare pressures in slice (first component of slice)
        double max_diff_p = 0.0;
        double max_diff_rho = 0.0;
        double max_val_p = 1.0;

        size_t n_cells = slice_cpu.size() / 2; // two quantities: pressure, density
        size_t worst_idx = 0;
        for (size_t i = 0; i < n_cells; ++i) {
            double p_c = slice_cpu[i];
            double p_g = slice_gpu[i];
            double diff_p = std::abs(p_c - p_g);
            if (diff_p > max_diff_p) {
                max_diff_p = diff_p;
                worst_idx = i;
            }
            if (std::abs(p_c) > max_val_p) max_val_p = std::abs(p_c);

            double rho_c = slice_cpu[n_cells + i];
            double rho_g = slice_gpu[n_cells + i];
            double diff_rho = std::abs(rho_c - rho_g);
            if (diff_rho > max_diff_rho) max_diff_rho = diff_rho;
        }

        if (step == 0) {
            int gx_w = worst_idx % nx;
            int gy_w = worst_idx / nx;
            std::cout << "[DIAG Step 0] Worst cell at slice (" << gx_w << "," << gy_w << "): "
                      << "CPU P=" << slice_cpu[worst_idx] << " Rho=" << slice_cpu[n_cells + worst_idx]
                      << " | GPU P=" << slice_gpu[worst_idx] << " Rho=" << slice_gpu[n_cells + worst_idx] << "\n";
            
            // Check direct root mesh cell vs submesh cell
            auto cell_cpu = solver_cpu.getCellValues(gx_w, gy_w, 16);
            auto cell_gpu = solver_gpu.getCellValues(gx_w, gy_w, 16);
            std::cout << "[DIAG Step 0] getCellValues(gx=" << gx_w << ", gy=" << gy_w << ", gz=16): "
                      << "CPU P=" << cell_cpu[0] << " Rho=" << cell_cpu[1]
                      << " | GPU P=" << cell_gpu[0] << " Rho=" << cell_gpu[1] << "\n";
        }

        double rel_diff_p = max_diff_p / max_val_p;

        auto v1_c = solver_cpu.sampleGauge(g1);
        auto v1_g = solver_gpu.sampleGauge(g1);
        auto v2_c = solver_cpu.sampleGauge(g2);
        auto v2_g = solver_gpu.sampleGauge(g2);

        std::cout << std::setw(6) << step
                  << std::setw(14) << std::scientific << std::setprecision(3) << max_diff_rho
                  << std::setw(14) << std::scientific << std::setprecision(3) << max_diff_p
                  << std::setw(14) << std::scientific << std::setprecision(3) << rel_diff_p
                  << std::setw(14) << std::scientific << std::setprecision(3) << v1_c[0]
                  << std::setw(14) << std::scientific << std::setprecision(3) << v1_g[0]
                  << std::setw(14) << std::scientific << std::setprecision(3) << v2_c[0]
                  << std::setw(14) << std::scientific << std::setprecision(3) << v2_g[0]
                  << "\n";

        if (rel_diff_p > 1e-4) {
            failed = true;
        }
    }

    std::cout << "\n===========================================================\n";
    if (!failed) {
        std::cout << ">>> TEST PASSED: CPU and GPU 3D Ideal Gas Solvers Match! <<<\n";
    } else {
        std::cout << ">>> TEST FAILED: Significant CPU/GPU Discrepancy Detected! <<<\n";
    }
    std::cout << "===========================================================\n";

    return failed ? 1 : 0;
}
