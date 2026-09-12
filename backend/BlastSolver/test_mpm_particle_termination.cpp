#include "mpm_solver_3d.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include <iostream>
#include <iomanip>
#include <cassert>

int main() {
    std::cout << "===========================================================\n";
    std::cout << "3D MPM PARTICLE OUT-OF-BOUNDS TERMINATION & COMPACTION TEST\n";
    std::cout << "===========================================================\n\n";

    int nx = 32, ny = 32, nz = 32;
    float dx = 0.01f, dy = 0.01f, dz = 0.01f;
    float xmin = 0.0f, ymin = 0.0f, zmin = 0.0f;

    auto bc_terminate = Blast::MPMBoundaryCondition3D::Terminate;
    auto bc_sticky = Blast::MPMBoundaryCondition3D::Sticky;

    // --- CPU Test ---
    std::cout << "[1/2] Testing CPU MPM Solver Particle Termination...\n";
    Blast::MPMSolver3D cpu_solver;
    cpu_solver.initializeGrid(nx, ny, nz, dx, dy, dz, xmin, ymin, zmin);
    cpu_solver.setTransferScheme(Blast::MPMTransferScheme::Standard);
    cpu_solver.setVelocityScheme(Blast::MPMVelocityScheme::APIC);
    cpu_solver.setTimeScheme(Blast::MPMTimeIntegrationScheme::USL);
    cpu_solver.setBoundaryConditions(bc_sticky, bc_terminate, bc_sticky, bc_sticky, bc_sticky, bc_sticky);

    // Box 1 (High velocity towards +x boundary at 0.28m): starts at 0.26m, crosses boundary quickly
    cpu_solver.addBoxObject(1, 0.26f, 0.15f, 0.15f, 0.02f, 0.02f, 0.02f,
                            8000.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                            2700.0f, 70.0e9f, 0.33f, 200.0e6f, 1.0e8f, 0.25f, 300.0e6f, 2);

    // Box 2 (Stationary in center): should remain active
    cpu_solver.addBoxObject(2, 0.08f, 0.15f, 0.15f, 0.02f, 0.02f, 0.02f,
                            0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                            2700.0f, 70.0e9f, 0.33f, 200.0e6f, 1.0e8f, 0.25f, 300.0e6f, 2);

    size_t cpu_initial_count = cpu_solver.getParticles().size();
    std::cout << "  Initial CPU particle count: " << cpu_initial_count << "\n";
    assert(cpu_initial_count > 0);

    // Step until Box 1 exits +x boundary
    for (int step = 0; step < 100; ++step) {
        float dt = cpu_solver.computeStepSize(0.2f);
        cpu_solver.stepWithDt(dt);
    }

    size_t cpu_final_count = cpu_solver.getParticles().size();
    std::cout << "  Final CPU particle count after boundary escape: " << cpu_final_count << "\n";
    assert(cpu_final_count < cpu_initial_count);
    assert(cpu_final_count > 0); // Stationary Box 2 particles remain intact
    std::cout << "  CPU Particle Termination & Compaction PASSED!\n\n";

    // --- GPU Test ---
    std::cout << "[2/2] Testing GPU MPM Solver Particle Termination...\n";
    Blast::MPMSolver3DCUDA gpu_solver;
    gpu_solver.initializeGrid(nx, ny, nz, dx, dy, dz, xmin, ymin, zmin);
    gpu_solver.setTransferScheme(Blast::MPMTransferScheme::Standard);
    gpu_solver.setVelocityScheme(Blast::MPMVelocityScheme::APIC);
    gpu_solver.setTimeScheme(Blast::MPMTimeIntegrationScheme::USL);
    gpu_solver.setBoundaryConditions(bc_sticky, bc_terminate, bc_sticky, bc_sticky, bc_sticky, bc_sticky);

    gpu_solver.addBoxObject(1, 0.26f, 0.15f, 0.15f, 0.02f, 0.02f, 0.02f,
                            8000.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                            2700.0f, 70.0e9f, 0.33f, 200.0e6f, 1.0e8f, 0.25f, 300.0e6f, 2);

    gpu_solver.addBoxObject(2, 0.08f, 0.15f, 0.15f, 0.02f, 0.02f, 0.02f,
                            0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                            2700.0f, 70.0e9f, 0.33f, 200.0e6f, 1.0e8f, 0.25f, 300.0e6f, 2);

    gpu_solver.syncToDevice();
    size_t gpu_initial_count = gpu_solver.getParticleCount();
    std::cout << "  Initial GPU particle count: " << gpu_initial_count << "\n";
    assert(gpu_initial_count == cpu_initial_count);

    // Step until Box 1 exits +x boundary
    for (int step = 0; step < 100; ++step) {
        float dt = gpu_solver.computeStepSize(0.2f);
        gpu_solver.stepWithDt(dt);
    }

    // Force compaction
    int active_particles = gpu_solver.compactTerminatedParticlesDevice();
    std::cout << "  GPU active particle count from compaction: " << active_particles << "\n";
    assert(active_particles < static_cast<int>(gpu_initial_count));
    assert(active_particles > 0);

    // Verify downloadSoA2AoS resizes host array to active count
    gpu_solver.downloadSoA2AoS();
    std::cout << "  GPU downloaded host particle count: " << gpu_solver.getParticles().size() << "\n";
    assert(gpu_solver.getParticles().size() == static_cast<size_t>(active_particles));

    // Verify VTK snapshot extraction only exports active particles
    MPMVTKSnapshot3D snap = gpu_solver.extractVTKSnapshot();
    std::cout << "  GPU VTK snapshot particle count: " << snap.num_particles << "\n";
    assert(snap.num_particles == active_particles);
    assert(snap.points.size() == static_cast<size_t>(active_particles * 3));

    // Verify step size computation continues smoothly
    float post_dt = gpu_solver.computeStepSize(0.2f);
    std::cout << "  GPU post-compaction stable dt: " << post_dt << " s\n";
    assert(post_dt > 0.0f && !std::isnan(post_dt) && !std::isinf(post_dt));

    std::cout << "  GPU Particle Termination & Compaction PASSED!\n\n";

    std::cout << "===========================================================\n";
    std::cout << "ALL MPM TERMINATION & COMPACTION TESTS PASSED SUCCESSFULLY!\n";
    std::cout << "===========================================================\n";
    return 0;
}
