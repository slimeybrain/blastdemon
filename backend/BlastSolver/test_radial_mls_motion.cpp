#include "mpm_solver_3d.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include <iostream>
#include <iomanip>
#include <cmath>

int main() {
    std::cout << "===========================================================\n";
    std::cout << "3D MPM RADIAL MLS MOTION & EQUIVALENCE TEST\n";
    std::cout << "===========================================================\n\n";

    int nx = 32, ny = 32, nz = 32;
    float dx = 0.01f, dy = 0.01f, dz = 0.01f;

    // 1. CPU Solver Setup
    Blast::MPMSolver3D cpu_solver;
    cpu_solver.initializeGrid(nx, ny, nz, dx, dy, dz);
    cpu_solver.setTransferScheme(Blast::MPMTransferScheme::RadialMLS);
    cpu_solver.setVelocityScheme(Blast::MPMVelocityScheme::APIC);
    cpu_solver.setTimeScheme(Blast::MPMTimeIntegrationScheme::USL);

    cpu_solver.addBoxObject(1, 0.08f, 0.08f, 0.08f, 0.04f, 0.04f, 0.04f,
                            500.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                            7850.0f, 210.0e9f, 0.3f, 1.0e6f, 1.0e8f, 0.25f, 600.0e6f, 2);

    // 2. GPU Solver Setup
    Blast::MPMSolver3DCUDA gpu_solver;
    gpu_solver.initializeGrid(nx, ny, nz, dx, dy, dz);
    gpu_solver.setTransferScheme(Blast::MPMTransferScheme::RadialMLS);
    gpu_solver.setVelocityScheme(Blast::MPMVelocityScheme::APIC);
    gpu_solver.setTimeScheme(Blast::MPMTimeIntegrationScheme::USL);

    gpu_solver.addBoxObject(1, 0.08f, 0.08f, 0.08f, 0.04f, 0.04f, 0.04f,
                            500.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                            7850.0f, 210.0e9f, 0.3f, 1.0e6f, 1.0e8f, 0.25f, 600.0e6f, 2);

    gpu_solver.syncToDevice();

    float init_cpu_x = cpu_solver.getParticles()[0].x[0];
    float init_gpu_x = gpu_solver.getParticles()[0].x[0];

    std::cout << "Initial Particle 0 X: CPU = " << init_cpu_x << ", GPU = " << init_gpu_x << "\n\n";

    float cfl = 0.2f;
    for (int step = 1; step <= 20; ++step) {
        cpu_solver.step(cfl);
        gpu_solver.step(cfl);
    }
    gpu_solver.syncToHost();

    float final_cpu_x = cpu_solver.getParticles()[0].x[0];
    float final_gpu_x = gpu_solver.getParticles()[0].x[0];

    float final_cpu_vx = cpu_solver.getParticles()[0].v[0];
    float final_gpu_vx = gpu_solver.getParticles()[0].v[0];

    std::cout << "After 20 steps:\n";
    std::cout << "  CPU Particle 0 X  = " << final_cpu_x << " (Delta X = " << (final_cpu_x - init_cpu_x) << " m), Vx = " << final_cpu_vx << " m/s\n";
    std::cout << "  GPU Particle 0 X  = " << final_gpu_x << " (Delta X = " << (final_gpu_x - init_gpu_x) << " m), Vx = " << final_gpu_vx << " m/s\n";

    if (std::abs(final_cpu_x - init_cpu_x) > 1.0e-5f && std::abs(final_gpu_x - init_gpu_x) > 1.0e-5f) {
        std::cout << "\n[PASS] 3D Radial MLS material moves dynamically and correctly on both CPU and GPU!\n";
        return 0;
    } else {
        std::cerr << "\n[FAIL] 3D Radial MLS material did not move!\n";
        return 1;
    }
}
