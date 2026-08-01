#include "mpm_solver_3d.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include <iostream>
#include <iomanip>
#include <algorithm>

int main() {
    std::cout << "===========================================================\n";
    std::cout << "3D MPM CPU vs GPU PLASTIC STRAIN EQUIVALENCE TEST\n";
    std::cout << "===========================================================\n\n";

    int nx = 32, ny = 32, nz = 32;
    float dx = 0.01f, dy = 0.01f, dz = 0.01f;

    // 1. CPU Solver Setup
    Blast::MPMSolver3D cpu_solver;
    cpu_solver.initializeGrid(nx, ny, nz, dx, dy, dz);
    cpu_solver.setTransferScheme(Blast::MPMTransferScheme::Standard);
    cpu_solver.setVelocityScheme(Blast::MPMVelocityScheme::APIC);
    cpu_solver.setTimeScheme(Blast::MPMTimeIntegrationScheme::USL);

    // Box 1: Impacting block at high speed 3000 m/s
    cpu_solver.addBoxObject(1, 0.08f, 0.08f, 0.08f, 0.04f, 0.04f, 0.04f,
                            3000.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                            7850.0f, 210.0e9f, 0.3f, 1.0e6f, 1.0e8f, 0.25f, 600.0e6f, 2);

    // Box 2: Stationary target block
    cpu_solver.addBoxObject(2, 0.14f, 0.08f, 0.08f, 0.04f, 0.04f, 0.04f,
                            0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                            7850.0f, 210.0e9f, 0.3f, 1.0e6f, 1.0e8f, 0.25f, 600.0e6f, 2);

    // 2. GPU Solver Setup
    Blast::MPMSolver3DCUDA gpu_solver;
    gpu_solver.initializeGrid(nx, ny, nz, dx, dy, dz);
    gpu_solver.setTransferScheme(Blast::MPMTransferScheme::Standard);
    gpu_solver.setVelocityScheme(Blast::MPMVelocityScheme::APIC);
    gpu_solver.setTimeScheme(Blast::MPMTimeIntegrationScheme::USL);

    gpu_solver.addBoxObject(1, 0.08f, 0.08f, 0.08f, 0.04f, 0.04f, 0.04f,
                            3000.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                            7850.0f, 210.0e9f, 0.3f, 1.0e6f, 1.0e8f, 0.25f, 600.0e6f, 2);

    gpu_solver.addBoxObject(2, 0.14f, 0.08f, 0.08f, 0.04f, 0.04f, 0.04f,
                            0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                            7850.0f, 210.0e9f, 0.3f, 1.0e6f, 1.0e8f, 0.25f, 600.0e6f, 2);

    gpu_solver.syncToDevice();

    std::cout << "Particles: CPU = " << cpu_solver.getParticles().size() 
              << ", GPU = " << gpu_solver.getParticles().size() << "\n\n";

    std::cout << std::setw(6) << "Step"
              << std::setw(16) << "CPU Max ep_bar"
              << std::setw(16) << "GPU Max ep_bar"
              << std::setw(16) << "CPU Max VM"
              << std::setw(16) << "GPU Max VM\n";
    std::cout << "--------------------------------------------------------------------\n";

    float cfl = 0.2f;
    for (int step = 1; step <= 20; ++step) {
        cpu_solver.step(cfl);
        gpu_solver.step(cfl);
        gpu_solver.syncToHost();

        const auto& cpu_parts = cpu_solver.getParticles();
        const auto& gpu_parts = gpu_solver.getParticles();

        float cpu_max_ep = 0.0f, gpu_max_ep = 0.0f;
        float cpu_max_vm = 0.0f, gpu_max_vm = 0.0f;

        for (const auto& p : cpu_parts) {
            if (p.ep_bar > cpu_max_ep) cpu_max_ep = p.ep_bar;
            float s00 = p.sigma[0][0], s11 = p.sigma[1][1], s22 = p.sigma[2][2];
            float s01 = p.sigma[0][1], s02 = p.sigma[0][2], s12 = p.sigma[1][2];
            float pr = -(s00 + s11 + s22) / 3.0f;
            float d00 = s00 + pr, d11 = s11 + pr, d22 = s22 + pr;
            float vm = std::sqrt(std::max(0.0f, 1.5f * (d00*d00 + d11*d11 + d22*d22 + 2.0f * (s01*s01 + s02*s02 + s12*s12))));
            if (vm > cpu_max_vm) cpu_max_vm = vm;
        }

        for (const auto& p : gpu_parts) {
            if (p.ep_bar > gpu_max_ep) gpu_max_ep = p.ep_bar;
            float s00 = p.sigma[0][0], s11 = p.sigma[1][1], s22 = p.sigma[2][2];
            float s01 = p.sigma[0][1], s02 = p.sigma[0][2], s12 = p.sigma[1][2];
            float pr = -(s00 + s11 + s22) / 3.0f;
            float d00 = s00 + pr, d11 = s11 + pr, d22 = s22 + pr;
            float vm = std::sqrt(std::max(0.0f, 1.5f * (d00*d00 + d11*d11 + d22*d22 + 2.0f * (s01*s01 + s02*s02 + s12*s12))));
            if (vm > gpu_max_vm) gpu_max_vm = vm;
        }

        std::cout << std::setw(6) << step
                  << std::setw(16) << std::scientific << std::setprecision(4) << cpu_max_ep
                  << std::setw(16) << std::scientific << std::setprecision(4) << gpu_max_ep
                  << std::setw(16) << std::scientific << std::setprecision(4) << cpu_max_vm
                  << std::setw(16) << std::scientific << std::setprecision(4) << gpu_max_vm << "\n";
    }

    return 0;
}
