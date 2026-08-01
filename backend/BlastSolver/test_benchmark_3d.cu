#include <iostream>
#include <chrono>
#include <vector>
#include <string>
#include "cfd_solver_3d_cuda.hpp"

// Templated benchmark execution function
template <typename RealType, bool IsMultiMaterial>
void run_benchmark(int nx, int ny, int nz, double cellSize, const std::string& fluxScheme, int spatial, int temporal, int num_steps, const std::string& precision_str, const std::string& physics_str, const std::string& scheme_name) {
    double xmin = -cellSize * nx / 2.0;
    double ymin = -cellSize * ny / 2.0;
    double zmin = 0.0;

    CFDSolver3DCuda<RealType, IsMultiMaterial> solver(nx, ny, nz, cellSize, xmin, ymin, zmin);
    solver.setFluxScheme(fluxScheme);
    solver.setSpatialOrder(spatial);
    solver.setTemporalOrder(temporal);

    // Make all cells active using a block charge covering the entire grid
    Charge3DParams charge;
    charge.shape_type = 1; // Block
    charge.x = 0.0; charge.y = 0.0; charge.z = 0.0;
    charge.radius = 1e6;
    charge.height = 1e6;
    charge.lx = 1e6; charge.ly = 1e6; charge.lz = 1e6;

    MultiMat::MaterialSet mats;
    mats.products.A = 3.73e11;
    mats.products.B = 3.74e9;
    mats.products.R1 = 4.15;
    mats.products.R2 = 0.9;
    mats.products.omega = 0.35;
    mats.products.rho0 = 1630.0;
    mats.unreacted = mats.products;

    double amb_rho = 1.18;
    double amb_p = 101325.0;
    solver.setInitialCondition(charge, mats, amb_rho, amb_p);
    
    // Warmup step
    double dt = 1e-5;
    solver.step(dt);
    cudaDeviceSynchronize();

    int active_tiles = solver.getNumActiveTiles();

    cudaEvent_t start_evt, end_evt;
    cudaEventCreate(&start_evt);
    cudaEventCreate(&end_evt);

    cudaEventRecord(start_evt);
    for (int i = 0; i < num_steps; ++i) {
        solver.step(dt);
    }
    cudaEventRecord(end_evt);
    cudaEventSynchronize(end_evt);
    float step_time_ms = 0;
    cudaEventElapsedTime(&step_time_ms, start_evt, end_evt);
    float avg_step_ms = step_time_ms / num_steps;

    std::cout << "| " << precision_str << " | " 
              << physics_str << " | " 
              << fluxScheme << " | " 
              << scheme_name << " | "
              << active_tiles << " | " 
              << avg_step_ms << " ms | " 
              << (1000.0 / avg_step_ms) << " |" << std::endl;

    cudaEventDestroy(start_evt);
    cudaEventDestroy(end_evt);
}

template <typename RealType, bool IsMultiMaterial>
void run_pause_validation(int nx, int ny, int nz, double cellSize, const std::string& fluxScheme, int spatial, int temporal, int num_steps) {
    double xmin = -cellSize * nx / 2.0;
    double ymin = -cellSize * ny / 2.0;
    double zmin = 0.0;

    // 1. Run Baseline (No Pause)
    CFDSolver3DCuda<RealType, IsMultiMaterial> solver_baseline(nx, ny, nz, cellSize, xmin, ymin, zmin);
    solver_baseline.setFluxScheme(fluxScheme);
    solver_baseline.setSpatialOrder(spatial);
    solver_baseline.setTemporalOrder(temporal);

    Charge3DParams charge;
    charge.shape_type = 1; // Block
    charge.x = 0.0; charge.y = 0.0; charge.z = 0.0;
    charge.radius = 1e6;
    charge.height = 1e6;
    charge.lx = 1e6; charge.ly = 1e6; charge.lz = 1e6;

    MultiMat::MaterialSet mats;
    mats.products.A = 3.73e11;
    mats.products.B = 3.74e9;
    mats.products.R1 = 4.15;
    mats.products.R2 = 0.9;
    mats.products.omega = 0.35;
    mats.products.rho0 = 1630.0;
    mats.unreacted = mats.products;

    double amb_rho = 1.18;
    double amb_p = 101325.0;
    solver_baseline.setInitialCondition(charge, mats, amb_rho, amb_p);

    double dt = 1e-5;
    // Step baseline
    for (int i = 0; i < num_steps; ++i) {
        solver_baseline.step(dt);
    }
    auto totals_baseline = solver_baseline.getConservationTotals();

    // 2. Run Test (Pause at step 5, Resume, Continue)
    CFDSolver3DCuda<RealType, IsMultiMaterial> solver_test(nx, ny, nz, cellSize, xmin, ymin, zmin);
    solver_test.setFluxScheme(fluxScheme);
    solver_test.setSpatialOrder(spatial);
    solver_test.setTemporalOrder(temporal);
    solver_test.setInitialCondition(charge, mats, amb_rho, amb_p);

    for (int i = 0; i < num_steps / 2; ++i) {
        solver_test.step(dt);
    }

    std::cout << "[Validation] Pausing simulation at step " << num_steps / 2 << "..." << std::endl;
    solver_test.pause();
    std::cout << "[Validation] Resuming simulation..." << std::endl;
    solver_test.resume();

    for (int i = num_steps / 2; i < num_steps; ++i) {
        solver_test.step(dt);
    }
    auto totals_test = solver_test.getConservationTotals();

    std::cout << "Baseline Total Mass:   " << totals_baseline.first << " kg, Energy: " << totals_baseline.second << " J" << std::endl;
    std::cout << "Pause-Resume Mass:     " << totals_test.first << " kg, Energy: " << totals_test.second << " J" << std::endl;

    double diff_mass = std::abs(totals_baseline.first - totals_test.first);
    double diff_energy = std::abs(totals_baseline.second - totals_test.second);

    std::cout << "Difference Mass:       " << diff_mass << ", Energy: " << diff_energy << std::endl;
    if (diff_mass < 1e-6 && diff_energy < 1e-6) {
        std::cout << ">>> VALIDATION SUCCESSFUL: Pause/Resume exact match! <<<" << std::endl;
    } else {
        std::cerr << ">>> VALIDATION FAILED: State mismatch detected! <<<" << std::endl;
        exit(1);
    }
}

int main(int argc, char* argv[]) {
    int nx = 320;
    int ny = 256;
    int nz = 128;
    double cellSize = 0.05;
    int num_steps = 10;

    if (argc > 1 && std::string(argv[1]) == "--validate-pause") {
        if (argc < 8) {
            std::cerr << "Usage: " << argv[0] << " --validate-pause <precision: float|double> <multimat: 0|1> <flux: AUSM+|Rusanov> <spatial: 1|2|3> <temporal: 1|2|3|4|5|6> <steps>" << std::endl;
            return 1;
        }
        std::string precision = argv[2];
        int multimat = std::stoi(argv[3]);
        std::string flux = argv[4];
        int spatial = std::stoi(argv[5]);
        int temporal = std::stoi(argv[6]);
        int steps = std::stoi(argv[7]);

        if (precision == "float") {
            if (multimat) {
                run_pause_validation<float, true>(nx, ny, nz, cellSize, flux, spatial, temporal, steps);
            } else {
                run_pause_validation<float, false>(nx, ny, nz, cellSize, flux, spatial, temporal, steps);
            }
        } else {
            if (multimat) {
                run_pause_validation<double, true>(nx, ny, nz, cellSize, flux, spatial, temporal, steps);
            } else {
                run_pause_validation<double, false>(nx, ny, nz, cellSize, flux, spatial, temporal, steps);
            }
        }
        return 0;
    }

    if (argc > 1 && std::string(argv[1]) == "--single") {
        if (argc < 8) {
            std::cerr << "Usage: " << argv[0] << " --single <precision: float|double> <multimat: 0|1> <flux: AUSM+|Rusanov> <spatial: 1|2|3> <temporal: 1|2|3|4|5|6> <steps>" << std::endl;
            return 1;
        }
        std::string precision = argv[2];
        int multimat = std::stoi(argv[3]);
        std::string flux = argv[4];
        int spatial = std::stoi(argv[5]);
        int temporal = std::stoi(argv[6]);
        int steps = std::stoi(argv[7]);

        std::string scheme_name = "RK" + std::to_string(temporal);
        if (temporal == 4) scheme_name = "MUSCL-Hancock";
        else if (temporal == 5) scheme_name = "ADER-2";
        else if (temporal == 6) scheme_name = "ADER-3";

        std::string physics_str = multimat ? "Multi-Material" : "Ideal Gas";

        std::cout << "=== Running Single Profile Configuration ===" << std::endl;
        std::cout << "Grid: " << nx << " x " << ny << " x " << nz << " (" << (nx * ny * nz / 1e6) << "M cells)" << std::endl;
        std::cout << "Precision: " << precision << ", Physics: " << physics_str << ", Flux: " << flux << ", Scheme: " << scheme_name << std::endl;
        
        std::cout << "| Precision | Physics | Flux Scheme | Numerical Scheme | Active Tiles | Avg Step Time | Steps/Sec |" << std::endl;
        std::cout << "|-----------|---------|-------------|------------------|--------------|---------------|-----------|" << std::endl;

        if (precision == "float") {
            if (multimat) {
                run_benchmark<float, true>(nx, ny, nz, cellSize, flux, spatial, temporal, steps, "float", "Multi-Material", scheme_name);
            } else {
                run_benchmark<float, false>(nx, ny, nz, cellSize, flux, spatial, temporal, steps, "float", "Ideal Gas", scheme_name);
            }
        } else {
            if (multimat) {
                run_benchmark<double, true>(nx, ny, nz, cellSize, flux, spatial, temporal, steps, "double", "Multi-Material", scheme_name);
            } else {
                run_benchmark<double, false>(nx, ny, nz, cellSize, flux, spatial, temporal, steps, "double", "Ideal Gas", scheme_name);
            }
        }
        return 0;
    }

    std::cout << "=== Detailed CUDA Profiling for 10M Cell Model (All Tiles Active) ===" << std::endl;
    std::cout << "Grid: " << nx << " x " << ny << " x " << nz << " (" << (nx * ny * nz / 1e6) << " M cells)" << std::endl;
    std::cout << "Total Tiles: " << (nx/8 * ny/8 * nz/8) << " tiles" << std::endl;
    std::cout << std::endl;

    std::cout << "| Precision | Physics Model | Flux Scheme | Numerical Scheme | Active Tiles | Avg Step Time | Steps/Sec |" << std::endl;
    std::cout << "|-----------|---------------|-------------|------------------|--------------|---------------|-----------|" << std::endl;

    struct Scheme {
        std::string name;
        int spatial;
        int temporal;
    };
    std::vector<Scheme> schemes = {
        {"RK1", 1, 1},
        {"RK2 (2nd-Order)", 2, 2},
        {"RK3 (3rd-Order)", 3, 3},
        {"MUSCL-Hancock", 2, 4},
        {"ADER-2 (2nd-Order)", 2, 5},
        {"ADER-3 (3rd-Order)", 3, 6}
    };

    std::vector<std::string> flux_schemes = {"AUSM+", "Rusanov"};

    // Float, Ideal Gas
    for (const auto& flux : flux_schemes) {
        for (const auto& s : schemes) {
            run_benchmark<float, false>(nx, ny, nz, cellSize, flux, s.spatial, s.temporal, num_steps, "float", "Ideal Gas", s.name);
        }
    }

    // Float, Multi-Material
    for (const auto& flux : flux_schemes) {
        for (const auto& s : schemes) {
            run_benchmark<float, true>(nx, ny, nz, cellSize, flux, s.spatial, s.temporal, num_steps, "float", "Multi-Material", s.name);
        }
    }

    // Double, Ideal Gas
    for (const auto& flux : flux_schemes) {
        for (const auto& s : schemes) {
            run_benchmark<double, false>(nx, ny, nz, cellSize, flux, s.spatial, s.temporal, num_steps, "double", "Ideal Gas", s.name);
        }
    }

    // Double, Multi-Material
    for (const auto& flux : flux_schemes) {
        for (const auto& s : schemes) {
            run_benchmark<double, true>(nx, ny, nz, cellSize, flux, s.spatial, s.temporal, num_steps, "double", "Multi-Material", s.name);
        }
    }

    return 0;
}
