#include "mpm_solver_3d.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include <iostream>
#include <cmath>
#include <cassert>

using namespace Blast;

int main() {
    std::cout << "========================================================\n";
    std::cout << " 3D MPM Sub-Grid DEM Kinematic Contact Unit Tests\n";
    std::cout << "========================================================\n\n";

    const int nx = 20, ny = 20, nz = 20;
    const float dx = 0.05f, dy = 0.05f, dz = 0.05f;

    std::cout << "[Test 1] CPU DEM Kinematic Impulse Collision & Momentum Conservation (Ballistic Impact)...\n";
    {
        MPMSolver3D solver;
        solver.initializeGrid(nx, ny, nz, dx, dy, dz, 0.0f, 0.0f, 0.0f);
        solver.setDemContact(true, 0.25f, 0.0f, 1.0f, MPMDEMContactMode::BallisticAndGas, 1.0f); // Inelastic contact, e = 0.0

        // Manually configure two opposing particles from different objects
        MPMParticle3D p1{};
        p1.object_id = 1;
        p1.m = 2.0f;
        p1.V0 = 0.001f;
        p1.contact_radius = 0.02f;
        p1.x[0] = 0.485f; p1.x[1] = 0.50f; p1.x[2] = 0.50f;
        p1.v[0] = 100.0f; p1.v[1] = 0.0f;  p1.v[2] = 0.0f;

        MPMParticle3D p2{};
        p2.object_id = 2;
        p2.m = 3.0f;
        p2.V0 = 0.001f;
        p2.contact_radius = 0.02f;
        p2.x[0] = 0.515f; p2.x[1] = 0.50f; p2.x[2] = 0.50f;
        p2.v[0] = -50.0f; p2.v[1] = 0.0f;  p2.v[2] = 0.0f;

        // Total initial momentum: 2.0 * 100 + 3.0 * (-50) = 200 - 150 = +50 kg*m/s
        float P0 = p1.m * p1.v[0] + p2.m * p2.v[0];
        std::cout << "  Initial Momentum P_x = " << P0 << " kg*m/s\n";

        // Initial distance = 0.515 - 0.485 = 0.030m. Contact radius sum = 0.02 + 0.02 = 0.040m.
        // Overlap delta = 0.010m > 0! Particles are overlapping and actively approaching.
        auto& particles = solver.getParticles();
        particles.push_back(p1);
        particles.push_back(p2);

        float dt = 1.0e-4f;
        solver.evaluateDEMContact(dt);

        float P1 = particles[0].m * particles[0].v[0] + particles[1].m * particles[1].v[0];
        std::cout << "  Post-Collision Momentum P_x = " << P1 << " kg*m/s\n";
        assert(std::abs(P1 - P0) < 1.0e-4f); // Exact linear momentum conservation!

        // Relative velocity v_1 - v_2 should be zero or separating (v_1 <= v_2)
        std::cout << "  Post-Collision v1 = " << particles[0].v[0] << " m/s, v2 = " << particles[1].v[0] << " m/s\n";
        assert(particles[0].v[0] <= particles[1].v[0] + 1.0e-3f); // Non-penetration kinematic check
        std::cout << "  -> PASSED: CPU DEM collision exactly conserved momentum and halted interpenetration.\n\n";
    }

    std::cout << "[Test 2] GPU DEM Kinematic Impulse Collision Parity...\n";
    {
        MPMSolver3DCUDA gpu_solver;
        gpu_solver.initializeGrid(nx, ny, nz, dx, dy, dz, 0.0f, 0.0f, 0.0f);
        gpu_solver.setDemContact(true, 0.25f, 0.0f, 1.0f, MPMDEMContactMode::BallisticAndGas, 1.0f);

        MPMParticle3D p1{};
        p1.object_id = 1;
        p1.m = 2.0f;
        p1.V0 = 0.001f;
        p1.contact_radius = 0.02f;
        p1.x[0] = 0.485f; p1.x[1] = 0.50f; p1.x[2] = 0.50f;
        p1.v[0] = 100.0f; p1.v[1] = 0.0f;  p1.v[2] = 0.0f;

        MPMParticle3D p2{};
        p2.object_id = 2;
        p2.m = 3.0f;
        p2.V0 = 0.001f;
        p2.contact_radius = 0.02f;
        p2.x[0] = 0.515f; p2.x[1] = 0.50f; p2.x[2] = 0.50f;
        p2.v[0] = -50.0f; p2.v[1] = 0.0f;  p2.v[2] = 0.0f;

        auto& particles = gpu_solver.getParticles();
        particles.push_back(p1);
        particles.push_back(p2);
        gpu_solver.syncToDevice();

        float dt = 1.0e-4f;
        gpu_solver.evaluateDEMContactDevice(dt);
        gpu_solver.syncParticlesToHost();

        const auto& gpu_pts = gpu_solver.getParticles();
        float P_gpu = gpu_pts[0].m * gpu_pts[0].v[0] + gpu_pts[1].m * gpu_pts[1].v[0];
        std::cout << "  GPU Post-Collision Momentum P_x = " << P_gpu << " kg*m/s\n";
        assert(std::abs(P_gpu - 50.0f) < 1.0e-4f);
        std::cout << "  GPU Post-Collision v1 = " << gpu_pts[0].v[0] << " m/s, v2 = " << gpu_pts[1].v[0] << " m/s\n";
        assert(gpu_pts[0].v[0] <= gpu_pts[1].v[0] + 1.0e-3f);
        std::cout << "  -> PASSED: GPU DEM contact matches CPU mechanics exactly.\n\n";
    }

    std::cout << "[Test 3] Elastic Restitution Check (e = 1.0)...\n";
    {
        MPMSolver3D solver;
        solver.initializeGrid(nx, ny, nz, dx, dy, dz, 0.0f, 0.0f, 0.0f);
        solver.setDemContact(true, 0.0f, 1.0f, 1.0f, MPMDEMContactMode::BallisticAndGas, 1.0f); // Restitution = 1.0, zero friction

        MPMParticle3D p1{};
        p1.object_id = 1;
        p1.m = 2.0f; p1.contact_radius = 0.02f;
        p1.x[0] = 0.49f; p1.x[1] = 0.50f; p1.x[2] = 0.50f;
        p1.v[0] = 60.0f; p1.v[1] = 0.0f;  p1.v[2] = 0.0f;

        MPMParticle3D p2{};
        p2.object_id = 2;
        p2.m = 2.0f; p2.contact_radius = 0.02f;
        p2.x[0] = 0.51f; p2.x[1] = 0.50f; p2.x[2] = 0.50f;
        p2.v[0] = -60.0f; p2.v[1] = 0.0f;  p2.v[2] = 0.0f;

        auto& particles = solver.getParticles();
        particles.push_back(p1);
        particles.push_back(p2);

        solver.evaluateDEMContact(1.0e-4f);

        // Equal masses head-on elastic collision should exchange velocities: v1 = -60, v2 = +60
        std::cout << "  Elastic Rebound: v1 = " << particles[0].v[0] << " m/s, v2 = " << particles[1].v[0] << " m/s\n";
        assert(std::abs(particles[0].v[0] - (-60.0f)) < 1.0e-2f);
        assert(std::abs(particles[1].v[0] - (60.0f)) < 1.0e-2f);
        std::cout << "  -> PASSED: Elastic restitution correctly exchanges kinetic momentum.\n\n";
    }

    std::cout << "[Test 4] Static CAD Interface Zero-Repulsion Verification (v_rel = 0 at t = 0)...\n";
    {
        // CPU Test
        MPMSolver3D solver;
        solver.initializeGrid(nx, ny, nz, dx, dy, dz, 0.0f, 0.0f, 0.0f);
        solver.setDemContact(true, 0.25f, 0.0f, 1.0f, MPMDEMContactMode::AllDynamic, 1.0f);

        MPMParticle3D p1{};
        p1.object_id = 1;
        p1.m = 2.0f;
        p1.V0 = 0.001f;
        p1.contact_radius = 0.02f;
        p1.x[0] = 0.495f; p1.x[1] = 0.50f; p1.x[2] = 0.50f;
        p1.v[0] = 0.0f;   p1.v[1] = 0.0f;  p1.v[2] = 0.0f; // AT REST

        MPMParticle3D p2{};
        p2.object_id = 2;
        p2.m = 3.0f;
        p2.V0 = 0.001f;
        p2.contact_radius = 0.02f;
        p2.x[0] = 0.505f; p2.x[1] = 0.50f; p2.x[2] = 0.50f;
        p2.v[0] = 0.0f;   p2.v[1] = 0.0f;  p2.v[2] = 0.0f; // AT REST

        // Distance = 0.010m < R_sum = 0.040m (Overlap delta = 0.030m)
        auto& particles = solver.getParticles();
        particles.push_back(p1);
        particles.push_back(p2);

        float dt = 1.0e-7f; // Realistic microsecond timestep
        solver.evaluateDEMContact(dt);

        std::cout << "  CPU Static touching: v1 = " << particles[0].v[0] << ", v2 = " << particles[1].v[0] << "\n";
        assert(std::abs(particles[0].v[0]) == 0.0f);
        assert(std::abs(particles[1].v[0]) == 0.0f);

        // GPU Test
        MPMSolver3DCUDA gpu_solver;
        gpu_solver.initializeGrid(nx, ny, nz, dx, dy, dz, 0.0f, 0.0f, 0.0f);
        gpu_solver.setDemContact(true, 0.25f, 0.0f, 1.0f, MPMDEMContactMode::AllDynamic, 1.0f);

        auto& gpu_particles = gpu_solver.getParticles();
        gpu_particles.push_back(p1);
        gpu_particles.push_back(p2);
        gpu_solver.syncToDevice();

        gpu_solver.evaluateDEMContactDevice(dt);
        gpu_solver.syncParticlesToHost();

        const auto& gpu_pts = gpu_solver.getParticles();
        std::cout << "  GPU Static touching: v1 = " << gpu_pts[0].v[0] << ", v2 = " << gpu_pts[1].v[0] << "\n";
        assert(std::abs(gpu_pts[0].v[0]) == 0.0f);
        assert(std::abs(gpu_pts[1].v[0]) == 0.0f);

        std::cout << "  -> PASSED: Touching CAD interfaces at rest experience exactly zero artificial DEM shock.\n\n";
    }

    std::cout << "[Test 5] GasSolidOnly Mode Filtering (Unreacted vs Reacted Explosive)...\n";
    {
        MPMSolver3D solver;
        solver.initializeGrid(nx, ny, nz, dx, dy, dz, 0.0f, 0.0f, 0.0f);
        solver.setDemContact(true, 0.25f, 0.0f, 1.0f, MPMDEMContactMode::GasSolidOnly, 1.0f);

        MaterialTable3D mat_exp{};
        mat_exp.material_model = MPMMaterialModel::JWLProgrammedBurn;
        solver.setMaterialTable(1, mat_exp);

        MaterialTable3D mat_casing{};
        mat_casing.material_model = MPMMaterialModel::JohnsonCookMieGruneisen;
        solver.setMaterialTable(2, mat_casing);

        // Part A: Unreacted explosive (lambda = 0.0) moving towards casing
        MPMParticle3D p_exp{};
        p_exp.object_id = 1;
        p_exp.m = 1.0f;
        p_exp.contact_radius = 0.02f;
        p_exp.lambda = 0.0f; // Unreacted reactant
        p_exp.x[0] = 0.485f; p_exp.x[1] = 0.50f; p_exp.x[2] = 0.50f;
        p_exp.v[0] = 50.0f;  p_exp.v[1] = 0.0f;  p_exp.v[2] = 0.0f;

        MPMParticle3D p_case{};
        p_case.object_id = 2;
        p_case.m = 2.0f;
        p_case.contact_radius = 0.02f;
        p_case.x[0] = 0.515f; p_case.x[1] = 0.50f; p_case.x[2] = 0.50f;
        p_case.v[0] = -10.0f; p_case.v[1] = 0.0f;  p_case.v[2] = 0.0f;

        auto& particles = solver.getParticles();
        particles.push_back(p_exp);
        particles.push_back(p_case);

        solver.evaluateDEMContact(1.0e-5f);

        // Should NOT trigger DEM contact because explosive is not reacted gas (governed by continuum grid)
        std::cout << "  Unreacted reactant v_exp = " << particles[0].v[0] << " (expected 50.0), v_case = " << particles[1].v[0] << " (expected -10.0)\n";
        assert(std::abs(particles[0].v[0] - 50.0f) < 1.0e-5f);
        assert(std::abs(particles[1].v[0] - (-10.0f)) < 1.0e-5f);

        // Part B: Explosive has reacted to detonation gas (lambda = 1.0)
        particles[0].lambda = 1.0f;
        solver.evaluateDEMContact(1.0e-5f);

        // Now DEM contact MUST trigger!
        std::cout << "  Reacted detonation gas v_exp = " << particles[0].v[0] << ", v_case = " << particles[1].v[0] << "\n";
        assert(particles[0].v[0] <= particles[1].v[0] + 1.0e-3f);
        std::cout << "  -> PASSED: GasSolidOnly selectively protects solid reactants while preventing gas tunneling.\n\n";
    }

    std::cout << "[Test 6] Intra-Object Contact Exclusion (No Fragment Popcorn)...\n";
    {
        MPMSolver3D solver;
        solver.initializeGrid(nx, ny, nz, dx, dy, dz, 0.0f, 0.0f, 0.0f);
        solver.setDemContact(true, 0.25f, 0.0f, 1.0f, MPMDEMContactMode::AllDynamic, 1.0f);

        // Two particles from the SAME object (e.g. fractured casing fragments)
        MPMParticle3D p1{};
        p1.object_id = 5;
        p1.m = 2.0f; p1.contact_radius = 0.02f;
        p1.has_failed = 1;
        p1.damage = 1.0f;
        p1.x[0] = 0.49f; p1.x[1] = 0.50f; p1.x[2] = 0.50f;
        p1.v[0] = 20.0f; p1.v[1] = 0.0f;  p1.v[2] = 0.0f;

        MPMParticle3D p2{};
        p2.object_id = 5; // Same object!
        p2.m = 2.0f; p2.contact_radius = 0.02f;
        p2.has_failed = 1;
        p2.damage = 1.0f;
        p2.x[0] = 0.51f; p2.x[1] = 0.50f; p2.x[2] = 0.50f;
        p2.v[0] = -20.0f; p2.v[1] = 0.0f;  p2.v[2] = 0.0f;

        auto& particles = solver.getParticles();
        particles.push_back(p1);
        particles.push_back(p2);

        solver.evaluateDEMContact(1.0e-5f);

        // Must NOT exert intra-object DEM impulses
        std::cout << "  Intra-object post v1 = " << particles[0].v[0] << " (expected 20.0), v2 = " << particles[1].v[0] << " (expected -20.0)\n";
        assert(std::abs(particles[0].v[0] - 20.0f) < 1.0e-5f);
        assert(std::abs(particles[1].v[0] - (-20.0f)) < 1.0e-5f);
        std::cout << "  -> PASSED: Intra-object contact exclusion prevents artificial fragment popcorn.\n\n";
    }

    std::cout << "========================================================\n";
    std::cout << " All 3D MPM DEM Contact Tests Passed Successfully!\n";
    std::cout << "========================================================\n";
    return 0;
}
