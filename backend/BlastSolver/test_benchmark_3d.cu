#include <iostream>
#include <chrono>
#include <vector>
#include "cfd_solver_3d_cuda.hpp"

int main() {
    int nx = 305;
    int ny = 160;
    int nz = 102;
    double cellSize = 0.05;
    double xmin = -7.625;
    double ymin = -4.0;
    double zmin = 0.0;

    std::cout << "=== Detailed CUDA Profiling for Exact Scene (4.97M Cells) ===" << std::endl;
    std::cout << "Grid: " << nx << " x " << ny << " x " << nz << " (" << (nx * ny * nz / 1e6) << " M cells)" << std::endl;

    CFDSolver3DCuda<float, false> solver(nx, ny, nz, cellSize, xmin, ymin, zmin);
    solver.setFluxScheme("AUSM+");
    solver.setSpatialOrder(2);
    solver.setTemporalOrder(2);

    // Warmup
    double dt = 1e-5;
    
    // Create a dummy voxelization to make all tiles active so the benchmark actually runs the kernels
    nlohmann::json dummy_primitives = nlohmann::json::array();
    dummy_primitives.push_back({
        {"type", "Block"},
        {"x", -3.8}, {"y", 0}, {"z", 0},
        {"size_x", 7.625}, {"size_y", 8.0}, {"size_z", 10.2} // Covers half the domain in X
    });
    solver.setGeometryPrimitives(dummy_primitives, "dummy", "primitive");

    Charge3DParams charge;
    charge.shape_type = 0; // Sphere
    charge.x = 0.0; charge.y = 0.0; charge.z = 0.0;
    charge.radius = 5.0;

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

    solver.step(dt);
    cudaDeviceSynchronize();

    std::cout << "Active tiles after geometry: " << solver.getNumActiveTiles() << std::endl;

    // Measure step breakdown over 10 RK2 steps
    const int num_steps = 10;

    cudaEvent_t start_evt, end_evt;
    cudaEventCreate(&start_evt);
    cudaEventCreate(&end_evt);

    // Profile computeStepSize
    cudaEventRecord(start_evt);
    for (int i = 0; i < num_steps; ++i) {
        solver.computeStepSize(0.6);
    }
    cudaEventRecord(end_evt);
    cudaEventSynchronize(end_evt);
    float dt_time_ms = 0;
    cudaEventElapsedTime(&dt_time_ms, start_evt, end_evt);

    // Profile full step() execution
    cudaEventRecord(start_evt);
    for (int i = 0; i < num_steps; ++i) {
        solver.step(dt);
    }
    cudaEventRecord(end_evt);
    cudaEventSynchronize(end_evt);
    float step_time_ms = 0;
    cudaEventElapsedTime(&step_time_ms, start_evt, end_evt);

    std::cout << "\n--- Profiling Results (Average over " << num_steps << " RK2 steps) ---" << std::endl;
    std::cout << "1. computeStepSize() (Wave Speed Reduction + D2H Memcpy): " << (dt_time_ms / num_steps) << " ms/step" << std::endl;
    std::cout << "2. step() Execution (RK2 Fluxes + Primitives Update):       " << (step_time_ms / num_steps) << " ms/step" << std::endl;
    std::cout << "Total step time (computeStepSize + step):                   " << ((dt_time_ms + step_time_ms) / num_steps) << " ms/step" << std::endl;
    std::cout << "Achievable Stepping Throughput:                              " << (1000.0 / ((dt_time_ms + step_time_ms) / num_steps)) << " steps/second" << std::endl;

    return 0;
}
