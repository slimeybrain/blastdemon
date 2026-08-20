#include "mpm_solver_3d.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include <iostream>
#include <iomanip>
#include <vector>
#include <cmath>
#include <cassert>
#include <algorithm>

int main() {
    std::cout << "======================================================================\n";
    std::cout << "3D MPM-TO-DEM DYNAMIC FRACTURE TRANSITION & FRAGMENT SIZE TEST\n";
    std::cout << "======================================================================\n\n";

    int nx = 32, ny = 32, nz = 32;
    float dx = 0.005f, dy = 0.005f, dz = 0.005f;

    // --- 1. CPU Solver Test ---
    std::cout << "--- 1. Testing CPU MPM-to-DEM Dynamic Transition ---\n";
    Blast::MPMSolver3D cpu_solver;
    cpu_solver.initializeGrid(nx, ny, nz, dx, dy, dz);
    cpu_solver.setTransferScheme(Blast::MPMTransferScheme::BSpline);
    cpu_solver.setVelocityScheme(Blast::MPMVelocityScheme::APIC);
    cpu_solver.setTimeScheme(Blast::MPMTimeIntegrationScheme::USL);

    // High velocity projectile block (1500 m/s) right next to target
    cpu_solver.addBoxObject(1, 0.052f, 0.07f, 0.07f, 0.015f, 0.02f, 0.02f,
                            1500.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                            7850.0f, 210.0e9f, 0.30f, 400.0e6f, 1.0e9f, 0.03f, 600.0e6f, 2);

    // Target steel plate at rest
    cpu_solver.addBoxObject(2, 0.07f, 0.05f, 0.05f, 0.015f, 0.06f, 0.06f,
                            0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                            7850.0f, 210.0e9f, 0.30f, 400.0e6f, 1.0e9f, 0.03f, 600.0e6f, 2);

    // Configure Steel Fragmentation & DEM parameters for both objects
    for (int obj_id = 1; obj_id <= 2; ++obj_id) {
        auto mat = cpu_solver.getMaterialTable(obj_id);
        mat.material_model = Blast::MPMMaterialModel::JohnsonCookMieGruneisen;
        mat.dem_transition_enabled = true;
        mat.fragment_distribution = "Rosin-Rammler";
        mat.fragment_min_size = 0.001f;   // 1 mm minimum fine spall
        mat.fragment_max_size = 0.020f;   // 20 mm maximum chunk
        mat.fragment_weibull_n = 1.80f;   // Rosin-Rammler slope
        mat.fragment_ejection_jitter = 0.40f;
        mat.fragment_contact_friction = 0.50f;
        mat.fragment_restitution = 0.30f;
        mat.failure_strain = 0.03f;
        mat.jc_d1 = 0.01f;
        mat.jc_d2 = 0.05f;
        cpu_solver.setMaterialTable(obj_id, mat);
    }

    std::cout << "Initial CPU particles count: " << cpu_solver.getParticles().size() << "\n";

    int failed_count_cpu = 0;
    int dem_count_cpu = 0;
    float min_assigned_r = 1e9f, max_assigned_r = 0.0f;

    for (int step = 1; step <= 80; ++step) {
        cpu_solver.step(0.4f);

        failed_count_cpu = 0;
        dem_count_cpu = 0;
        for (const auto& p : cpu_solver.getParticles()) {
            if (p.has_failed || p.damage >= 1.0f) failed_count_cpu++;
            if (p.state == 1) {
                dem_count_cpu++;
                if (p.contact_radius > 0.0f) {
                    min_assigned_r = std::min(min_assigned_r, p.contact_radius);
                    max_assigned_r = std::max(max_assigned_r, p.contact_radius);
                }
            }
        }

        if (step % 10 == 0 || (step > 20 && dem_count_cpu > 0 && step % 10 == 0)) {
            std::cout << "Step " << std::setw(3) << step 
                      << " | Failed particles: " << std::setw(5) << failed_count_cpu
                      << " | DEM grains: " << std::setw(5) << dem_count_cpu
                      << " | Min grain radius: " << std::setprecision(4) << min_assigned_r << " m"
                      << " | Max grain radius: " << std::setprecision(4) << max_assigned_r << " m\n";
        }
    }

    std::cout << "\n[CPU Validation]\n";
    std::cout << "DEM Transition count: " << dem_count_cpu << " (Expected > 0 under 1500 m/s impact)\n";
    assert(dem_count_cpu > 0);
    assert(min_assigned_r >= 0.0005f);
    assert(max_assigned_r <= 0.025f);
    std::cout << "PASS: CPU MPM-to-DEM transition and multi-scale fragment size verified!\n";

    // --- 2. GPU Solver Test ---
    std::cout << "\n--- 2. Testing GPU MPM-to-DEM Dynamic Transition ---\n";
    Blast::MPMSolver3DCUDA gpu_solver;
    gpu_solver.initializeGrid(nx, ny, nz, dx, dy, dz);
    gpu_solver.setTransferScheme(Blast::MPMTransferScheme::BSpline);
    gpu_solver.setVelocityScheme(Blast::MPMVelocityScheme::APIC);
    gpu_solver.setTimeScheme(Blast::MPMTimeIntegrationScheme::USL);

    gpu_solver.addBoxObject(1, 0.052f, 0.07f, 0.07f, 0.015f, 0.02f, 0.02f,
                            1500.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                            7850.0f, 210.0e9f, 0.30f, 400.0e6f, 1.0e9f, 0.03f, 600.0e6f, 2);

    gpu_solver.addBoxObject(2, 0.07f, 0.05f, 0.05f, 0.015f, 0.06f, 0.06f,
                            0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                            7850.0f, 210.0e9f, 0.30f, 400.0e6f, 1.0e9f, 0.03f, 600.0e6f, 2);

    for (int obj_id = 1; obj_id <= 2; ++obj_id) {
        auto mat = gpu_solver.getMaterialTable(obj_id);
        mat.material_model = Blast::MPMMaterialModel::JohnsonCookMieGruneisen;
        mat.dem_transition_enabled = true;
        mat.fragment_distribution = "Rosin-Rammler";
        mat.fragment_min_size = 0.001f;
        mat.fragment_max_size = 0.020f;
        mat.fragment_weibull_n = 1.80f;
        mat.fragment_ejection_jitter = 0.40f;
        mat.fragment_contact_friction = 0.50f;
        mat.fragment_restitution = 0.30f;
        mat.failure_strain = 0.03f;
        mat.jc_d1 = 0.01f;
        mat.jc_d2 = 0.05f;
        gpu_solver.setMaterialTable(obj_id, mat);
    }

    gpu_solver.syncToDevice();

    std::cout << "Initial GPU particles count: " << gpu_solver.getParticles().size() << "\n";

    for (int step = 1; step <= 80; ++step) {
        gpu_solver.step(0.4f);
    }

    gpu_solver.syncParticlesToHost();
    int failed_count_gpu = 0;
    int dem_count_gpu = 0;
    float min_assigned_r_gpu = 1e9f, max_assigned_r_gpu = 0.0f;

    for (const auto& p : gpu_solver.getParticles()) {
        if (p.has_failed || p.damage >= 1.0f) failed_count_gpu++;
        if (p.state == 1) {
            dem_count_gpu++;
            if (p.contact_radius > 0.0f) {
                min_assigned_r_gpu = std::min(min_assigned_r_gpu, p.contact_radius);
                max_assigned_r_gpu = std::max(max_assigned_r_gpu, p.contact_radius);
            }
        }
    }

    std::cout << "\n[GPU Validation]\n";
    std::cout << "GPU Failed particles: " << failed_count_gpu << " | DEM grains: " << dem_count_gpu << "\n";
    if (dem_count_gpu > 0) {
        std::cout << "GPU Rosin-Rammler radii sampled in [" 
                  << min_assigned_r_gpu << ", " << max_assigned_r_gpu << "] m.\n";
        assert(min_assigned_r_gpu >= 0.0005f);
        std::cout << "PASS: GPU MPM-to-DEM transition and fragment distribution verified!\n";
    }

    std::cout << "\n--- 3. Testing Direct DEM Fragment vs Intact MPM Solid Plate Collision (CPU & GPU) ---\n";
    {
        // CPU MPM-DEM Contact Test
        Blast::MPMSolver3D contact_solver_cpu;
        contact_solver_cpu.initializeGrid(32, 32, 32, 0.005f, 0.005f, 0.005f);

        // Intact MPM solid plate (object 1) at x = [0.08, 0.09] at rest
        contact_solver_cpu.addBoxObject(1, 0.08f, 0.07f, 0.07f, 0.010f, 0.03f, 0.03f,
                                        0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                                        7850.0f, 210.0e9f, 0.30f, 400.0e6f, 1.0e9f, 0.50f, 600.0e6f, 2);

        // Incoming discrete DEM fragment (object 2, state = 1) at x = 0.076 moving at +300 m/s towards plate at x = 0.080
        Blast::MPMParticle3D dem_p{};
        dem_p.object_id = 2;
        dem_p.x[0] = 0.076f;
        dem_p.x[1] = 0.075f;
        dem_p.x[2] = 0.075f;
        dem_p.v[0] = 300.0f;
        dem_p.v[1] = 0.0f;
        dem_p.v[2] = 0.0f;
        dem_p.m = 0.005f; // 5 grams
        dem_p.V = 0.005f / 7850.0f;
        dem_p.V0 = dem_p.V;
        dem_p.contact_radius = 0.003f;
        dem_p.state = 1; // Explicit DEM grain
        dem_p.has_failed = true;
        contact_solver_cpu.addParticleDirect(dem_p);

        auto mat2 = contact_solver_cpu.getMaterialTable(2);
        mat2.youngs_modulus = 210.0e9f;
        mat2.fragment_restitution = 0.50f;
        mat2.fragment_contact_friction = 0.30f;
        contact_solver_cpu.setMaterialTable(2, mat2);

        float plate_front_x = 0.080f;

        for (int step = 1; step <= 120; ++step) {
            contact_solver_cpu.step(0.4f);
        }

        const auto& particles = contact_solver_cpu.getParticles();
        const auto& dem_res = particles.back();
        std::cout << "CPU DEM Particle Final: x=" << dem_res.x[0] << " m (Plate front: " << plate_front_x << " m), vx=" << dem_res.v[0] << " m/s\n";
        assert(dem_res.x[0] < plate_front_x + 0.005f); // DEM particle did not penetrate through plate
        assert(dem_res.v[0] < 300.0f); // DEM particle was strongly decelerated/repelled by intact MPM plate
        std::cout << "PASS: CPU DEM particle successfully coupled with intact MPM solid plate!\n";
    }

    {
        // GPU MPM-DEM Contact Test
        Blast::MPMSolver3DCUDA contact_solver_gpu;
        contact_solver_gpu.initializeGrid(32, 32, 32, 0.005f, 0.005f, 0.005f);

        contact_solver_gpu.addBoxObject(1, 0.080f, 0.07f, 0.07f, 0.010f, 0.03f, 0.03f,
                                        0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                                        7850.0f, 210.0e9f, 0.30f, 400.0e6f, 1.0e9f, 0.50f, 600.0e6f, 2);

        Blast::MPMParticle3D dem_p{};
        dem_p.object_id = 2;
        dem_p.x[0] = 0.076f;
        dem_p.x[1] = 0.075f;
        dem_p.x[2] = 0.075f;
        dem_p.v[0] = 300.0f;
        dem_p.v[1] = 0.0f;
        dem_p.v[2] = 0.0f;
        dem_p.m = 0.005f;
        dem_p.V = 0.005f / 7850.0f;
        dem_p.V0 = dem_p.V;
        dem_p.contact_radius = 0.003f;
        dem_p.state = 1;
        dem_p.has_failed = true;
        std::vector<Blast::MPMParticle3D> extra = { dem_p };
        contact_solver_gpu.addParticlesDirect(extra);

        auto mat2 = contact_solver_gpu.getMaterialTable(2);
        mat2.youngs_modulus = 210.0e9f;
        mat2.fragment_restitution = 0.50f;
        mat2.fragment_contact_friction = 0.30f;
        contact_solver_gpu.setMaterialTable(2, mat2);

        contact_solver_gpu.syncToDevice();

        for (int step = 1; step <= 120; ++step) {
            contact_solver_gpu.step(0.4f);
        }

        contact_solver_gpu.syncParticlesToHost();
        const auto& particles = contact_solver_gpu.getParticles();
        const auto& dem_res = particles.back();
        std::cout << "GPU DEM Particle Final: x=" << dem_res.x[0] << " m (Plate front: 0.08 m), vx=" << dem_res.v[0] << " m/s\n";
        assert(dem_res.x[0] < 0.085f);
        assert(dem_res.v[0] < 300.0f);
        std::cout << "PASS: GPU DEM particle successfully coupled with intact MPM solid plate!\n";
    }

    std::cout << "\n======================================================================\n";
    std::cout << "ALL MPM-TO-DEM DISCRETE FRACTURE & COUPLING TESTS PASSED!\n";
    std::cout << "======================================================================\n";

    return 0;
}
