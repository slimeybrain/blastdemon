#include "mpm_solver_2d.hpp"
#include "mpm_solver_3d.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include <iostream>
#include <iomanip>
#include <cstdlib>
#include <cmath>

#define VERIFY_CHECK(cond, msg) do { \
    if (!(cond)) { \
        std::cerr << "[FAIL] " << (msg) << " (line " << __LINE__ << ")\n"; \
        return 1; \
    } \
} while (0)

int main() {
    std::cout << "=====================================================================\n";
    std::cout << "MPM TRANSMITTING vs TERMINATE BOUNDARY CONDITION & COMPACTION VERIFY\n";
    std::cout << "=====================================================================\n\n";

    int nx = 32, ny = 32, nz = 32;
    float dx = 0.01f, dy = 0.01f, dz = 0.01f;
    float xmin = 0.0f, ymin = 0.0f, zmin = 0.0f;

    auto bc_transmitting = Blast::MPMBoundaryCondition3D::Transmitting;
    auto bc_terminate    = Blast::MPMBoundaryCondition3D::Terminate;
    auto bc_sticky       = Blast::MPMBoundaryCondition3D::Sticky;

    // -------------------------------------------------------------------------
    // [1/5] CPU 3D MPM: Transmitting BC (Particles pass out & compact, sim NOT terminated)
    // -------------------------------------------------------------------------
    std::cout << "[1/5] Testing CPU 3D MPM Transmitting BC (Pass-Out Without Sim Termination)...\n";
    {
        Blast::MPMSolver3D cpu_solver;
        cpu_solver.initializeGrid(nx, ny, nz, dx, dy, dz, xmin, ymin, zmin);
        cpu_solver.setTransferScheme(Blast::MPMTransferScheme::Standard);
        cpu_solver.setVelocityScheme(Blast::MPMVelocityScheme::APIC);
        cpu_solver.setTimeScheme(Blast::MPMTimeIntegrationScheme::USL);
        cpu_solver.setBoundaryConditions(bc_sticky, bc_transmitting, bc_sticky, bc_sticky, bc_sticky, bc_sticky);

        // Box 1: High velocity towards +x Transmitting boundary at x = 0.32m
        cpu_solver.addBoxObject(1, 0.26f, 0.15f, 0.15f, 0.02f, 0.02f, 0.02f,
                                8000.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                                2700.0f, 70.0e9f, 0.33f, 200.0e6f, 1.0e8f, 0.25f, 300.0e6f, 2);

        // Box 2: Stationary in center
        cpu_solver.addBoxObject(2, 0.08f, 0.15f, 0.15f, 0.02f, 0.02f, 0.02f,
                                0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                                2700.0f, 70.0e9f, 0.33f, 200.0e6f, 1.0e8f, 0.25f, 300.0e6f, 2);

        size_t initial_count = cpu_solver.getParticles().size();
        VERIFY_CHECK(initial_count > 0, "Initial CPU particle count > 0");

        for (int step = 0; step < 150; ++step) {
            float dt = cpu_solver.computeStepSize(0.2f);
            cpu_solver.stepWithDt(dt);
        }

        size_t final_count = cpu_solver.getParticles().size();
        std::cout << "  Initial count: " << initial_count << " -> Final count: " << final_count
                  << " | is_terminated: " << (cpu_solver.is_terminated() ? "true" : "false") << "\n";
        VERIFY_CHECK(final_count == initial_count / 2, "CPU Box 1 passed out & compacted, Box 2 remains");
        VERIFY_CHECK(!cpu_solver.is_terminated(), "CPU Transmitting BC must NOT terminate simulation");
        std::cout << "  CPU 3D Transmitting BC PASSED!\n\n";
    }

    // -------------------------------------------------------------------------
    // [2/5] CPU 3D MPM: Terminate BC (Particles hit boundary -> sim TERMINATED)
    // -------------------------------------------------------------------------
    std::cout << "[2/5] Testing CPU 3D MPM Terminate BC (Sim Terminates on Boundary Hit)...\n";
    {
        Blast::MPMSolver3D cpu_solver;
        cpu_solver.initializeGrid(nx, ny, nz, dx, dy, dz, xmin, ymin, zmin);
        cpu_solver.setTransferScheme(Blast::MPMTransferScheme::Standard);
        cpu_solver.setVelocityScheme(Blast::MPMVelocityScheme::APIC);
        cpu_solver.setTimeScheme(Blast::MPMTimeIntegrationScheme::USL);
        cpu_solver.setBoundaryConditions(bc_sticky, bc_terminate, bc_sticky, bc_sticky, bc_sticky, bc_sticky);

        cpu_solver.addBoxObject(1, 0.26f, 0.15f, 0.15f, 0.02f, 0.02f, 0.02f,
                                8000.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                                2700.0f, 70.0e9f, 0.33f, 200.0e6f, 1.0e8f, 0.25f, 300.0e6f, 2);

        for (int step = 0; step < 150 && !cpu_solver.is_terminated(); ++step) {
            float dt = cpu_solver.computeStepSize(0.2f);
            cpu_solver.stepWithDt(dt);
        }

        std::cout << "  is_terminated: " << (cpu_solver.is_terminated() ? "true" : "false") << "\n";
        VERIFY_CHECK(cpu_solver.is_terminated(), "CPU Terminate BC MUST terminate simulation");
        std::cout << "  CPU 3D Terminate BC PASSED!\n\n";
    }

    // -------------------------------------------------------------------------
    // [3/5] GPU 3D MPM: Transmitting BC (Particles pass out & compact immediately, sim NOT terminated)
    // -------------------------------------------------------------------------
    std::cout << "[3/5] Testing GPU 3D MPM Transmitting BC (Pass-Out & Compaction Without Sim Termination)...\n";
    {
        Blast::MPMSolver3DCUDA gpu_solver;
        gpu_solver.initializeGrid(nx, ny, nz, dx, dy, dz, xmin, ymin, zmin);
        gpu_solver.setTransferScheme(Blast::MPMTransferScheme::Standard);
        gpu_solver.setVelocityScheme(Blast::MPMVelocityScheme::APIC);
        gpu_solver.setTimeScheme(Blast::MPMTimeIntegrationScheme::USL);
        gpu_solver.setBoundaryConditions(bc_sticky, bc_transmitting, bc_sticky, bc_sticky, bc_sticky, bc_sticky);

        gpu_solver.addBoxObject(1, 0.26f, 0.15f, 0.15f, 0.02f, 0.02f, 0.02f,
                                8000.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                                2700.0f, 70.0e9f, 0.33f, 200.0e6f, 1.0e8f, 0.25f, 300.0e6f, 2);

        gpu_solver.addBoxObject(2, 0.08f, 0.15f, 0.15f, 0.02f, 0.02f, 0.02f,
                                0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                                2700.0f, 70.0e9f, 0.33f, 200.0e6f, 1.0e8f, 0.25f, 300.0e6f, 2);

        gpu_solver.syncToDevice();
        size_t gpu_initial_count = gpu_solver.getParticleCount();
        VERIFY_CHECK(gpu_initial_count > 0, "Initial GPU particle count > 0");

        for (int step = 0; step < 150; ++step) {
            float dt = gpu_solver.computeStepSize(0.2f);
            gpu_solver.stepWithDt(dt);
        }

        // stepWithDt automatically compacts exited particles when d_boundary_flags[1] != 0
        size_t active_particles = gpu_solver.getParticleCount();
        std::cout << "  GPU initial count: " << gpu_initial_count << " -> Active count: " << active_particles
                  << " | is_terminated: " << (gpu_solver.is_terminated() ? "true" : "false") << "\n";
        VERIFY_CHECK(active_particles == gpu_initial_count / 2, "GPU Box 1 passed out & compacted, Box 2 remains");
        VERIFY_CHECK(!gpu_solver.is_terminated(), "GPU Transmitting BC must NOT terminate simulation");

        gpu_solver.downloadSoA2AoS();
        VERIFY_CHECK(gpu_solver.getParticles().size() == active_particles, "GPU downloaded host particle count matches active count");

        MPMVTKSnapshot3D snap = gpu_solver.extractVTKSnapshot();
        VERIFY_CHECK(static_cast<size_t>(snap.num_particles) == active_particles, "GPU VTK snapshot particle count matches active count");
        VERIFY_CHECK(snap.points.size() == active_particles * 3, "GPU VTK snapshot points size matches active count * 3");

        float post_dt = gpu_solver.computeStepSize(0.2f);
        VERIFY_CHECK(post_dt > 0.0f && !std::isnan(post_dt) && !std::isinf(post_dt), "GPU post-compaction dt is finite and positive");
        std::cout << "  GPU 3D Transmitting BC PASSED!\n\n";
    }

    // -------------------------------------------------------------------------
    // [4/5] GPU 3D MPM: Terminate BC (Particles hit boundary -> sim TERMINATED)
    // -------------------------------------------------------------------------
    std::cout << "[4/5] Testing GPU 3D MPM Terminate BC (Sim Terminates on Boundary Hit)...\n";
    {
        Blast::MPMSolver3DCUDA gpu_solver;
        gpu_solver.initializeGrid(nx, ny, nz, dx, dy, dz, xmin, ymin, zmin);
        gpu_solver.setTransferScheme(Blast::MPMTransferScheme::Standard);
        gpu_solver.setVelocityScheme(Blast::MPMVelocityScheme::APIC);
        gpu_solver.setTimeScheme(Blast::MPMTimeIntegrationScheme::USL);
        gpu_solver.setBoundaryConditions(bc_sticky, bc_terminate, bc_sticky, bc_sticky, bc_sticky, bc_sticky);

        gpu_solver.addBoxObject(1, 0.26f, 0.15f, 0.15f, 0.02f, 0.02f, 0.02f,
                                8000.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                                2700.0f, 70.0e9f, 0.33f, 200.0e6f, 1.0e8f, 0.25f, 300.0e6f, 2);

        gpu_solver.syncToDevice();
        for (int step = 0; step < 150 && !gpu_solver.is_terminated(); ++step) {
            float dt = gpu_solver.computeStepSize(0.2f);
            gpu_solver.stepWithDt(dt);
        }

        std::cout << "  GPU is_terminated: " << (gpu_solver.is_terminated() ? "true" : "false") << "\n";
        VERIFY_CHECK(gpu_solver.is_terminated(), "GPU Terminate BC MUST terminate simulation");
        std::cout << "  GPU 3D Terminate BC PASSED!\n\n";
    }

    // -------------------------------------------------------------------------
    // [5/5] CPU 2D MPM: Transmitting vs Terminate BC
    // -------------------------------------------------------------------------
    std::cout << "[5/5] Testing CPU 2D MPM Transmitting & Terminate BCs...\n";
    {
        Blast::MPMSolver2D solver2d_trans;
        solver2d_trans.initializeGrid(32, 32, 0.01f, 0.01f);
        solver2d_trans.setBoundaryConditions(
            Blast::MPMBoundaryCondition2D::FreeSlip,
            Blast::MPMBoundaryCondition2D::Transmitting,
            Blast::MPMBoundaryCondition2D::FreeSlip,
            Blast::MPMBoundaryCondition2D::FreeSlip
        );
        solver2d_trans.addRectangleObject(1, 0.26f, 0.15f, 0.02f, 0.02f, 8000.0f, 0.0f, 0.0f, 2700.0f, 70.0e9f, 0.33f, 200.0e6f, 1.0e8f, 0.25f, 300.0e6f, 2);
        solver2d_trans.addRectangleObject(2, 0.08f, 0.15f, 0.02f, 0.02f, 0.0f, 0.0f, 0.0f, 2700.0f, 70.0e9f, 0.33f, 200.0e6f, 1.0e8f, 0.25f, 300.0e6f, 2);
        size_t init2d = solver2d_trans.getParticles().size();
        for (int step = 0; step < 150; ++step) {
            float dt = solver2d_trans.computeStepSize(0.2f);
            solver2d_trans.stepWithDt(dt);
        }
        std::cout << "  CPU 2D initial count: " << init2d << " -> Final count: " << solver2d_trans.getParticles().size()
                  << " | is_terminated: " << (solver2d_trans.is_terminated() ? "true" : "false") << "\n";
        VERIFY_CHECK(solver2d_trans.getParticles().size() == init2d / 2, "CPU 2D Box 1 passed out & compacted, Box 2 remains");
        VERIFY_CHECK(!solver2d_trans.is_terminated(), "CPU 2D Transmitting BC must NOT terminate simulation");

        Blast::MPMSolver2D solver2d_term;
        solver2d_term.initializeGrid(32, 32, 0.01f, 0.01f);
        solver2d_term.setBoundaryConditions(
            Blast::MPMBoundaryCondition2D::FreeSlip,
            Blast::MPMBoundaryCondition2D::Terminate,
            Blast::MPMBoundaryCondition2D::FreeSlip,
            Blast::MPMBoundaryCondition2D::FreeSlip
        );
        solver2d_term.addRectangleObject(1, 0.26f, 0.15f, 0.02f, 0.02f, 8000.0f, 0.0f, 0.0f, 2700.0f, 70.0e9f, 0.33f, 200.0e6f, 1.0e8f, 0.25f, 300.0e6f, 2);
        for (int step = 0; step < 150 && !solver2d_term.is_terminated(); ++step) {
            float dt = solver2d_term.computeStepSize(0.2f);
            solver2d_term.stepWithDt(dt);
        }
        std::cout << "  CPU 2D Terminate is_terminated: " << (solver2d_term.is_terminated() ? "true" : "false") << "\n";
        VERIFY_CHECK(solver2d_term.is_terminated(), "CPU 2D Terminate BC MUST terminate simulation");
        std::cout << "  CPU 2D Transmitting & Terminate BCs PASSED!\n\n";
    }

    std::cout << "=====================================================================\n";
    std::cout << "ALL MPM TRANSMITTING & TERMINATE BC TESTS PASSED SUCCESSFULLY!\n";
    std::cout << "=====================================================================\n";
    return 0;
}
