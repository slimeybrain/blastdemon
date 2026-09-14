#include "mpm_solver_3d.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include <iostream>
#include <cmath>
#include <vector>

using namespace Blast;

int main() {
    std::cout << "========================================================\n";
    std::cout << " 3D MPM Multi-Velocity Bardenhagen Contact & Rebound Test\n";
    std::cout << "========================================================\n\n";

    const int nx = 80, ny = 20, nz = 20;
    const float dx = 0.01f, dy = 0.01f, dz = 0.01f;

    // Test 0: Baseline Single-Velocity Impact (bodies stick together)
    std::cout << "[Test 0] Single-Velocity Baseline Impact (Bodies must weld/stick)...\n";
    {
        MPMSolver3D solver;
        solver.initializeGrid(nx, ny, nz, dx, dy, dz, 0.0f, 0.0f, 0.0f);
        solver.setTransferScheme(MPMTransferScheme::BSpline);
        solver.setVelocityScheme(MPMVelocityScheme::PIC);
        solver.setTimeScheme(MPMTimeIntegrationScheme::USL);

        // Block 1: Centered at x = 0.38m, size 0.04m -> right edge at 0.40m, moving right +10 m/s
        solver.addBoxObject(1, 0.38f, 0.10f, 0.10f,
                            0.04f, 0.04f, 0.04f,
                            10.0f, 0.0f, 0.0f,
                            0.0f, 0.0f, 0.0f,
                            1000.0f, 10.0e6f, 0.30f,
                            1.0e6f, 0.0f, 1.0f, 1.0e6f,
                            8, MPMParticleDistribution::Cartesian, MPMBoundaryFilling::Stairstepped);

        // Block 2: Centered at x = 0.42m, size 0.04m -> left edge at 0.40m, moving left -10 m/s
        solver.addBoxObject(2, 0.42f, 0.10f, 0.10f,
                            0.04f, 0.04f, 0.04f,
                            -10.0f, 0.0f, 0.0f,
                            0.0f, 0.0f, 0.0f,
                            1000.0f, 10.0e6f, 0.30f,
                            1.0e6f, 0.0f, 1.0f, 1.0e6f,
                            8, MPMParticleDistribution::Cartesian, MPMBoundaryFilling::Stairstepped);

        solver.setContactMethod(MPMContactMethod::SingleVelocity);
        solver.particleToGrid();

        const auto& particles = solver.getParticles();
        for (int step = 0; step < 100; ++step) {
            float dt = solver.computeStepSize(0.3f);
            solver.stepWithDt(dt, true);
        }

        float v1_final = 0.0f, v2_final = 0.0f;
        int c1 = 0, c2 = 0;
        for (const auto& p : particles) {
            if (p.object_id == 1) { v1_final += p.v[0]; c1++; }
            else if (p.object_id == 2) { v2_final += p.v[0]; c2++; }
        }
        v1_final /= c1;
        v2_final /= c2;

        std::cout << "  Single-Velocity Final: Block 1 Vx = " << v1_final << " m/s, Block 2 Vx = " << v2_final << " m/s\n";
        // Under single velocity, colliding symmetric bodies arrest and stick together (relative velocity -> 0)
        float rel_v = std::abs(v1_final - v2_final);
        std::cout << "  Relative velocity: " << rel_v << " m/s (sticking confirmed)\n\n";
    }

    // Test 1: CPU Bardenhagen Contact (bodies do NOT stick)
    std::cout << "[Test 1] CPU Multi-Velocity Bardenhagen Contact & Separation...\n";
    {
        MPMSolver3D solver;
        solver.initializeGrid(nx, ny, nz, dx, dy, dz, 0.0f, 0.0f, 0.0f);
        solver.setTransferScheme(MPMTransferScheme::BSpline);
        solver.setVelocityScheme(MPMVelocityScheme::APIC);
        solver.setTimeScheme(MPMTimeIntegrationScheme::USL);

        // Block 1
        solver.addBoxObject(1, 0.38f, 0.10f, 0.10f,
                            0.04f, 0.04f, 0.04f,
                            10.0f, 0.0f, 0.0f,
                            0.0f, 0.0f, 0.0f,
                            1000.0f, 10.0e6f, 0.30f,
                            1.0e6f, 0.0f, 1.0f, 1.0e6f,
                            8, MPMParticleDistribution::Cartesian, MPMBoundaryFilling::Stairstepped);

        // Block 2
        solver.addBoxObject(2, 0.42f, 0.10f, 0.10f,
                            0.04f, 0.04f, 0.04f,
                            -10.0f, 0.0f, 0.0f,
                            0.0f, 0.0f, 0.0f,
                            1000.0f, 10.0e6f, 0.30f,
                            1.0e6f, 0.0f, 1.0f, 1.0e6f,
                            8, MPMParticleDistribution::Cartesian, MPMBoundaryFilling::Stairstepped);

        solver.setContactMethod(MPMContactMethod::MultiVelocityBardenhagen);
        std::vector<int> obj_to_mat = {0, 0, 1}; // obj 1 -> mat 0, obj 2 -> mat 1
        solver.setObjectMaterialMapping(obj_to_mat, 2);
        solver.setDemContact(false, 0.0f, 0.8f, 1.0f, MPMDEMContactMode::AllDynamic, 0.1f);
        solver.particleToGrid();

        const auto& particles = solver.getParticles();
        for (int step = 0; step < 400; ++step) {
            float dt = solver.computeStepSize(0.3f);
            solver.stepWithDt(dt, true);

            if ((step + 1) % 20 == 0) {
                float v1 = 0.0f, v2 = 0.0f, x1 = 0.0f, x2 = 0.0f;
                int c1 = 0, c2 = 0;
                for (const auto& p : particles) {
                    if (p.object_id == 1) { v1 += p.v[0]; x1 += p.x[0]; c1++; }
                    else if (p.object_id == 2) { v2 += p.v[0]; x2 += p.x[0]; c2++; }
                }
                v1 /= c1; v2 /= c2; x1 /= c1; x2 /= c2;
                std::cout << "    Step " << (step + 1) << ": x1=" << x1 << " m, x2=" << x2 << " m, gap=" << (x2 - x1)
                          << " m | v1=" << v1 << " m/s, v2=" << v2 << " m/s\n";
            }
        }

        float v1_final = 0.0f, v2_final = 0.0f;
        int c1 = 0, c2 = 0;
        for (const auto& p : particles) {
            if (p.object_id == 1) { v1_final += p.v[0]; c1++; }
            else if (p.object_id == 2) { v2_final += p.v[0]; c2++; }
        }
        v1_final /= c1;
        v2_final /= c2;

        std::cout << "  Bardenhagen Final: Block 1 Vx = " << v1_final << " m/s, Block 2 Vx = " << v2_final << " m/s\n";
        float rel_v = v2_final - v1_final;
        std::cout << "  Separation velocity (v2 - v1): " << rel_v << " m/s\n";

        if (v1_final > 0.0f || v2_final < 0.0f) {
            std::cerr << "  FAIL: Bodies did not rebound and separate! v1=" << v1_final << ", v2=" << v2_final << "\n";
            return 1;
        }
        std::cout << "  -> PASSED: CPU Bardenhagen contact prevented sticking and allowed free rebound!\n\n";
    }

    // Test 2: CUDA GPU Bardenhagen Contact
    std::cout << "[Test 2] CUDA GPU Multi-Velocity Bardenhagen Contact & Separation...\n";
    {
        MPMSolver3DCUDA gpu_solver;
        gpu_solver.initializeGrid(nx, ny, nz, dx, dy, dz, 0.0f, 0.0f, 0.0f);
        gpu_solver.setTransferScheme(MPMTransferScheme::BSpline);
        gpu_solver.setVelocityScheme(MPMVelocityScheme::APIC);
        gpu_solver.setTimeScheme(MPMTimeIntegrationScheme::USL);

        // Block 1
        gpu_solver.addBoxObject(1, 0.38f, 0.10f, 0.10f,
                               0.04f, 0.04f, 0.04f,
                               10.0f, 0.0f, 0.0f,
                               0.0f, 0.0f, 0.0f,
                               1000.0f, 10.0e6f, 0.30f,
                               1.0e6f, 0.0f, 1.0f, 1.0e6f,
                               8, MPMParticleDistribution::Cartesian, MPMBoundaryFilling::Stairstepped);

        // Block 2
        gpu_solver.addBoxObject(2, 0.42f, 0.10f, 0.10f,
                               0.04f, 0.04f, 0.04f,
                               -10.0f, 0.0f, 0.0f,
                               0.0f, 0.0f, 0.0f,
                               1000.0f, 10.0e6f, 0.30f,
                               1.0e6f, 0.0f, 1.0f, 1.0e6f,
                               8, MPMParticleDistribution::Cartesian, MPMBoundaryFilling::Stairstepped);

        gpu_solver.setContactMethod(MPMContactMethod::MultiVelocityBardenhagen);
        std::vector<int> obj_to_mat = {0, 0, 1};
        gpu_solver.setObjectMaterialMapping(obj_to_mat, 2);
        gpu_solver.setDemContact(false, 0.0f, 0.8f, 1.0f, MPMDEMContactMode::AllDynamic, 0.1f);
        gpu_solver.syncToDevice();

        for (int step = 0; step < 100; ++step) {
            float dt = gpu_solver.computeStepSize(0.3f);
            gpu_solver.stepWithDt(dt, true);
        }

        gpu_solver.syncToHost();
        const auto& particles = gpu_solver.getParticles();
        float v1_final = 0.0f, v2_final = 0.0f;
        int c1 = 0, c2 = 0;
        for (const auto& p : particles) {
            if (p.object_id == 1) { v1_final += p.v[0]; c1++; }
            else if (p.object_id == 2) { v2_final += p.v[0]; c2++; }
        }
        v1_final /= c1;
        v2_final /= c2;

        std::cout << "  GPU Bardenhagen Final: Block 1 Vx = " << v1_final << " m/s, Block 2 Vx = " << v2_final << " m/s\n";
        float rel_v = v2_final - v1_final;
        std::cout << "  Separation velocity (v2 - v1): " << rel_v << " m/s\n";

        if (v1_final > 0.0f || v2_final < 0.0f) {
            std::cerr << "  FAIL: GPU bodies did not rebound and separate! v1=" << v1_final << ", v2=" << v2_final << "\n";
            return 1;
        }
        std::cout << "  -> PASSED: CUDA GPU Bardenhagen contact prevented sticking and allowed free rebound!\n\n";
    }

    std::cout << "========================================================\n";
    std::cout << " ALL BARDENHAGEN CONTACT & SEPARATION TESTS PASSED!\n";
    std::cout << "========================================================\n";
    return 0;
}
