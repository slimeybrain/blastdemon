#include "mpm_solver_3d.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include "cfd_solver_3d.hpp"
#include "cfd_solver_3d_cuda.hpp"
#include "cfd_solver_2d.hpp"
#include "cfd_solver_2d_cuda.hpp"
#include "materials.hpp"
#include <iostream>
#include <iomanip>
#include <cmath>
#undef NDEBUG
#include <cassert>

using namespace Blast;

int main() {
    std::cout << "========================================================\n";
    std::cout << "DIAGNOSTIC TEST: Detonator Delay & Velocity Tracking\n";
    std::cout << "========================================================\n";

    float dx = 0.02f;
    float xmin = 0.0f;
    float ymin = 0.0f;
    float zmin = 0.0f;
    int nx = 50, ny = 50, nz = 50;

    std::cout << "\n--- TEST 1: CUDA Solver ---\n";
    {
        MPMSolver3DCUDA cuda_solver;
        cuda_solver.initializeGrid(nx, ny, nz, dx, dx, dx, xmin, ymin, zmin);
        cuda_solver.setBoundaryConditions(MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                                          MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                                          MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip);
        cuda_solver.setTransferScheme(MPMTransferScheme::BSpline);
        cuda_solver.setVelocityScheme(MPMVelocityScheme::APIC);
        cuda_solver.setTimeScheme(MPMTimeIntegrationScheme::USL);

        // Add moving explosive box: center=(0.4, 0.5, 0.5), size=(0.1, 0.1, 0.1), vel_x = 200 m/s
        cuda_solver.addBoxObject(1, 0.4f, 0.5f, 0.5f, 0.1f, 0.1f, 0.1f, 200.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                                 1630.0f, 1.0e9f, 0.3f, 100.0e6f, 0.0f, 0.5f, 100.0e6f, 8);

        auto& mat_tables = cuda_solver.getMaterialTables();
        mat_tables.resize(2);
        mat_tables[1].material_model = MPMMaterialModel::JWLProgrammedBurn;
        mat_tables[1].burn_model = ReactionKinetics::ProgrammedBurn;
        mat_tables[1].solid_model = SolidReactantEOS::MieGruneisen;
        mat_tables[1].product_model = DetonationProductEOS::JWLProductGas;
        mat_tables[1].density = 1630.0f;
        mat_tables[1].detonation_energy = 4.29e6f;
        mat_tables[1].det_vel = 6930.0f;
        mat_tables[1].jwl_A = 371.2e9f;
        mat_tables[1].jwl_B = 3.23e9f;
        mat_tables[1].jwl_R1 = 4.15f;
        mat_tables[1].jwl_R2 = 0.95f;
        mat_tables[1].jwl_omega = 0.30f;

        cuda_solver.uploadMaterialTableToDevice();

        float t_delay = 2.0e-4f; // 200 microseconds
        cuda_solver.addDetonator(0.4f, 0.5f, 0.5f, 0.02f, t_delay, true, 1);

        cuda_solver.syncToDevice();

        std::cout << "Initial detonator at: (" 
                  << cuda_solver.getDetonators()[0].x << ", "
                  << cuda_solver.getDetonators()[0].y << ", "
                  << cuda_solver.getDetonators()[0].z << "), delay="
                  << cuda_solver.getDetonators()[0].time_delay
                  << ", track_vel=" << cuda_solver.getDetonators()[0].track_mpm_velocity
                  << ", fired=" << cuda_solver.getDetonators()[0].fired
                  << "\n";

        float dt = 1.0e-5f; // 10 us steps
        for (int step = 1; step <= 30; ++step) {
            cuda_solver.stepWithDt(dt, true);
            const auto& det = cuda_solver.getDetonators()[0];
            double t = cuda_solver.getSimTime();
            if (step % 5 == 0 || det.fired) {
                std::cout << "Step " << step << " | t = " << t 
                          << " | det.x = " << det.x 
                          << " | fired = " << det.fired << "\n";
            }
        }

        cuda_solver.syncParticlesToHost();
        int ignited = 0;
        for (const auto& p : cuda_solver.getParticles()) {
            if (p.lambda > 0.01f) ignited++;
        }
        std::cout << "Final ignited particles on CUDA: " << ignited << " / " << cuda_solver.getParticles().size() << "\n";
    }

    std::cout << "\n--- TEST 2: CPU Solver ---\n";
    {
        MPMSolver3D cpu_solver;
        cpu_solver.initializeGrid(nx, ny, nz, dx, dx, dx, xmin, ymin, zmin);
        cpu_solver.setBoundaryConditions(MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                                         MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                                         MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip);
        cpu_solver.setTransferScheme(MPMTransferScheme::BSpline);
        cpu_solver.setVelocityScheme(MPMVelocityScheme::APIC);
        cpu_solver.setTimeScheme(MPMTimeIntegrationScheme::USL);

        // Add moving explosive box
        cpu_solver.addBoxObject(1, 0.4f, 0.5f, 0.5f, 0.1f, 0.1f, 0.1f, 200.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                                1630.0f, 1.0e9f, 0.3f, 100.0e6f, 0.0f, 0.5f, 100.0e6f, 8);

        auto& mat_tables = cpu_solver.getMaterialTables();
        mat_tables.resize(2);
        mat_tables[1].material_model = MPMMaterialModel::JWLProgrammedBurn;
        mat_tables[1].burn_model = ReactionKinetics::ProgrammedBurn;
        mat_tables[1].solid_model = SolidReactantEOS::MieGruneisen;
        mat_tables[1].product_model = DetonationProductEOS::JWLProductGas;
        mat_tables[1].density = 1630.0f;
        mat_tables[1].detonation_energy = 4.29e6f;
        mat_tables[1].det_vel = 6930.0f;
        mat_tables[1].jwl_A = 371.2e9f;
        mat_tables[1].jwl_B = 3.23e9f;
        mat_tables[1].jwl_R1 = 4.15f;
        mat_tables[1].jwl_R2 = 0.95f;
        mat_tables[1].jwl_omega = 0.30f;

        float t_delay = 2.0e-4f; // 200 microseconds
        cpu_solver.addDetonator(0.4f, 0.5f, 0.5f, 0.02f, t_delay, true, 1);

        std::cout << "Initial detonator at: (" 
                  << cpu_solver.getDetonators()[0].x << ", "
                  << cpu_solver.getDetonators()[0].y << ", "
                  << cpu_solver.getDetonators()[0].z << "), delay="
                  << cpu_solver.getDetonators()[0].time_delay
                  << ", track_vel=" << cpu_solver.getDetonators()[0].track_mpm_velocity
                  << ", fired=" << cpu_solver.getDetonators()[0].fired
                  << "\n";

        float dt = 1.0e-5f; // 10 us steps
        for (int step = 1; step <= 30; ++step) {
            cpu_solver.stepWithDt(dt, true);
            const auto& det = cpu_solver.getDetonators()[0];
            double t = cpu_solver.getSimTime();
            if (step % 5 == 0 || det.fired) {
                std::cout << "Step " << step << " | t = " << t 
                          << " | det.x = " << det.x 
                          << " | fired = " << det.fired << "\n";
            }
        }

        int ignited = 0;
        for (const auto& p : cpu_solver.getParticles()) {
            if (p.lambda > 0.01f) ignited++;
        }
        std::cout << "Final ignited particles on CPU: " << ignited << " / " << cpu_solver.getParticles().size() << "\n";
    }

    std::cout << "\n--- TEST 3: CFD 3D CUDA Solver Delayed Initiation ---\n";
    {
        int nx = 24, ny = 24, nz = 24;
        double cellSize = 0.05;
        double xmin = -0.6, ymin = -0.6, zmin = -0.6;
        CFDSolver3DCuda<float, true> solver_gpu(nx, ny, nz, cellSize, xmin, ymin, zmin);
        solver_gpu.setFluxScheme("AUSM+");
        solver_gpu.setSpatialOrder(2);
        solver_gpu.setTemporalOrder(2);
        solver_gpu.setBoundaryConditions(
            BCType3D::TRANSMISSIVE, BCType3D::TRANSMISSIVE,
            BCType3D::TRANSMISSIVE, BCType3D::TRANSMISSIVE,
            BCType3D::TRANSMISSIVE, BCType3D::TRANSMISSIVE
        );

        Charge3DParams charge{};
        charge.shape_type = 0;
        charge.x = 0.0; charge.y = 0.0; charge.z = 0.0;
        charge.radius = 0.15;

        float t_delay = 2.0e-4f; // 200 us delay
        solver_gpu.setDetonatorLocation(0.0, 0.0, 0.0, t_delay);

        MultiMat::MaterialSet mats{};
        mats.products.A = 373.77e9; mats.products.B = 3.747e9;
        mats.products.R1 = 4.15; mats.products.R2 = 0.9; mats.products.omega = 0.35;
        mats.products.rho0 = 1630.0;
        mats.detonation_energy = 4.29e6; mats.det_vel = 6930.0;
        mats.unreacted = mats.products;

        double amb_rho = 1.225;
        double amb_p = 101325.0;
        solver_gpu.setInitialCondition(charge, mats, amb_rho, amb_p);

        float dt = 1.0e-5f;
        // Step to t = 1.0e-4 (before delay)
        for (int i = 0; i < 10; ++i) solver_gpu.step(dt);
        float p_before = solver_gpu.getCellValues(12, 12, 12)[0];
        std::cout << "CFD 3D CUDA p at center at t = 100 us (before delay 200 us): " << p_before << " Pa\n";
        assert(p_before < 1.0e6f && "CFD 3D CUDA detonated prematurely before delay!");

        // Step to t = 2.5e-4 (after delay)
        for (int i = 0; i < 15; ++i) solver_gpu.step(dt);
        float p_after = solver_gpu.getCellValues(12, 12, 12)[0];
        std::cout << "CFD 3D CUDA p at center at t = 250 us (after delay 200 us): " << p_after << " Pa\n";
        assert(p_after > 1.0e8f && "CFD 3D CUDA failed to detonate after delay!");
    }

    std::cout << "\n--- TEST 4: CFD 3D CPU Solver Delayed Initiation ---\n";
    {
        int nx = 24, ny = 24, nz = 24;
        double cellSize = 0.05;
        double xmin = -0.6, ymin = -0.6, zmin = -0.6;
        CFDSolver3DImpl<float, true> solver_cpu(nx, ny, nz, cellSize, xmin, ymin, zmin);
        solver_cpu.setFluxScheme("AUSM+");
        solver_cpu.setSpatialOrder(2);
        solver_cpu.setTemporalOrder(2);
        solver_cpu.setBoundaryConditions(
            BCType3D::TRANSMISSIVE, BCType3D::TRANSMISSIVE,
            BCType3D::TRANSMISSIVE, BCType3D::TRANSMISSIVE,
            BCType3D::TRANSMISSIVE, BCType3D::TRANSMISSIVE
        );

        Charge3DParams charge{};
        charge.shape_type = 0;
        charge.x = 0.0; charge.y = 0.0; charge.z = 0.0;
        charge.radius = 0.15;

        float t_delay = 2.0e-4f; // 200 us delay
        solver_cpu.setDetonatorLocation(0.0, 0.0, 0.0, t_delay);

        MultiMat::MaterialSet mats{};
        mats.products.A = 373.77e9; mats.products.B = 3.747e9;
        mats.products.R1 = 4.15; mats.products.R2 = 0.9; mats.products.omega = 0.35;
        mats.products.rho0 = 1630.0;
        mats.detonation_energy = 4.29e6; mats.det_vel = 6930.0;
        mats.unreacted = mats.products;

        double amb_rho = 1.225;
        double amb_p = 101325.0;
        solver_cpu.setInitialCondition(charge, mats, amb_rho, amb_p);

        float dt = 1.0e-5f;
        // Step to t = 1.0e-4 (before delay)
        for (int i = 0; i < 10; ++i) solver_cpu.step(dt);
        float p_before = solver_cpu.getCellValues(12, 12, 12)[0];
        std::cout << "CFD 3D CPU p at center at t = 100 us (before delay 200 us): " << p_before << " Pa\n";
        assert(p_before < 1.0e6f && "CFD 3D CPU detonated prematurely before delay!");

        // Step to t = 2.5e-4 (after delay)
        for (int i = 0; i < 15; ++i) solver_cpu.step(dt);
        float p_after = solver_cpu.getCellValues(12, 12, 12)[0];
        std::cout << "CFD 3D CPU p at center at t = 250 us (after delay 200 us): " << p_after << " Pa\n";
        assert(p_after > 1.0e8f && "CFD 3D CPU failed to detonate after delay!");
    }

    std::cout << "\n--- TEST 5: CFD 2D CUDA Solver Delayed Initiation ---\n";
    {
        int nr = 32, nz = 32;
        double max_r = 1.0, max_z = 1.0;
        double gamma = 1.4;
        CFDSolver2DCudaImpl<float> solver_2d_cuda(nr, nz, max_r, max_z, gamma);
        solver_2d_cuda.setFluxScheme("AUSM+");
        solver_2d_cuda.setSpatialOrder(2);
        solver_2d_cuda.setTemporalOrder(2);
        solver_2d_cuda.setBCTypes(CFDSolver2DCuda::REFLECTIVE, CFDSolver2DCuda::OUTFLOW_RIEMANN,
                                  CFDSolver2DCuda::REFLECTIVE, CFDSolver2DCuda::OUTFLOW_RIEMANN);

        MultiMat::MaterialSet mats = MultiMat::TNT;
        solver_2d_cuda.setMaterialParameters(mats);

        float t_delay = 2.0e-4f;
        solver_2d_cuda.setDetonatorLocation(0.0, 0.5, t_delay);
        solver_2d_cuda.setInitialConditionTNT(0.5, 0.15, 1630.0, 1.225, 101325.0);

        float dt = 1.0e-5f;
        for (int i = 0; i < 10; ++i) solver_2d_cuda.step(dt);
        float p_before = solver_2d_cuda.getCellValues(0, 16)[0];
        std::cout << "CFD 2D CUDA p at (0, 16) at t = 100 us (before delay 200 us): " << p_before << " Pa\n";
        assert(p_before < 1.0e6f && "CFD 2D CUDA detonated prematurely before delay!");

        for (int i = 0; i < 15; ++i) solver_2d_cuda.step(dt);
        float p_after = solver_2d_cuda.getCellValues(0, 16)[0];
        std::cout << "CFD 2D CUDA p at (0, 16) at t = 250 us (after delay 200 us): " << p_after << " Pa\n";
        assert(p_after > 1.0e8f && "CFD 2D CUDA failed to detonate after delay!");
    }

    std::cout << "\n--- TEST 6: CFD 2D CPU Solver Delayed Initiation ---\n";
    {
        int nr = 32, nz = 32;
        double max_r = 1.0, max_z = 1.0;
        double gamma = 1.4;
        CFDSolver2DImpl<float> solver_2d_cpu(nr, nz, max_r, max_z, gamma);
        solver_2d_cpu.setFluxScheme("AUSM+");
        solver_2d_cpu.setSpatialOrder(2);
        solver_2d_cpu.setTemporalOrder(2);
        solver_2d_cpu.setBCTypes(CFDSolver2D::REFLECTIVE, CFDSolver2D::OUTFLOW_RIEMANN,
                                 CFDSolver2D::REFLECTIVE, CFDSolver2D::OUTFLOW_RIEMANN);

        MultiMat::MaterialSet mats = MultiMat::TNT;
        solver_2d_cpu.setMaterialParameters(mats);

        float t_delay = 2.0e-4f;
        solver_2d_cpu.setDetonatorLocation(0.0, 0.5, t_delay);
        solver_2d_cpu.setInitialConditionTNT(0.5, 0.15, 1630.0, 1.225, 101325.0);

        float dt = 1.0e-5f;
        for (int i = 0; i < 10; ++i) solver_2d_cpu.step(dt);
        float p_before = solver_2d_cpu.getCellValues(0, 16)[0];
        std::cout << "CFD 2D CPU p at (0, 16) at t = 100 us (before delay 200 us): " << p_before << " Pa\n";
        assert(p_before < 1.0e6f && "CFD 2D CPU detonated prematurely before delay!");

        for (int i = 0; i < 15; ++i) solver_2d_cpu.step(dt);
        float p_after = solver_2d_cpu.getCellValues(0, 16)[0];
        std::cout << "CFD 2D CPU p at (0, 16) at t = 250 us (after delay 200 us): " << p_after << " Pa\n";
        assert(p_after > 1.0e8f && "CFD 2D CPU failed to detonate after delay!");
    }

    std::cout << "\n--- TEST 7: MPM 3D CUDA CREST Delayed Initiation ---\n";
    {
        MPMSolver3DCUDA cuda_solver;
        cuda_solver.initializeGrid(nx, ny, nz, dx, dx, dx, xmin, ymin, zmin);
        cuda_solver.setBoundaryConditions(MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                                          MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                                          MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip);
        cuda_solver.setTransferScheme(MPMTransferScheme::BSpline);
        cuda_solver.setVelocityScheme(MPMVelocityScheme::APIC);
        cuda_solver.setTimeScheme(MPMTimeIntegrationScheme::USL);

        cuda_solver.addBoxObject(1, 0.5f, 0.5f, 0.5f, 0.1f, 0.1f, 0.1f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                                 1895.0f, 10.0e9f, 0.35f, 50.0e6f, 100.0e6f, 0.1f, 60.0e6f, 8);

        auto& mat_tables = cuda_solver.getMaterialTables();
        mat_tables.resize(2);
        mat_tables[1].material_model = MPMMaterialModel::CRESTReactiveBurn;
        mat_tables[1].burn_model = ReactionKinetics::CRESTEntropy;
        mat_tables[1].solid_model = SolidReactantEOS::DavisSolid;
        mat_tables[1].product_model = DetonationProductEOS::DavisProduct;
        mat_tables[1].density = 1895.0f;
        mat_tables[1].davis_c0 = 2050.0f;
        mat_tables[1].davis_s1 = 2.12f;
        mat_tables[1].davis_gamma0 = 0.65f;
        mat_tables[1].davis_cv = 1000.0f;
        mat_tables[1].davis_t0 = 293.0f;
        mat_tables[1].davis_rho0 = 1895.0f;
        mat_tables[1].davis_a = 2.85f;
        mat_tables[1].davis_b = 1.10f;
        mat_tables[1].davis_k = 1.35f;
        mat_tables[1].davis_vc = 0.65f;
        mat_tables[1].davis_pc = 12.5e9f;
        mat_tables[1].davis_q_det = 3.90e6f;
        mat_tables[1].detonation_energy = 3.90e6f;
        mat_tables[1].crest_b1 = 1.2e7f;
        mat_tables[1].crest_c1 = 0.67f;
        mat_tables[1].crest_m1 = 2.5f;
        mat_tables[1].crest_b2 = 3.5e6f;
        mat_tables[1].crest_c2 = 0.50f;
        mat_tables[1].crest_c3 = 0.67f;
        mat_tables[1].crest_m2 = 1.5f;
        mat_tables[1].crest_s0 = 15.0f;
        mat_tables[1].crest_s_threshold = 2.0f;

        cuda_solver.uploadMaterialTableToDevice();

        float t_delay = 2.0e-4f; // 200 microseconds
        cuda_solver.addDetonator(0.5f, 0.5f, 0.5f, 0.02f, t_delay, false, 1);
        cuda_solver.syncToDevice();

        float dt = 1.0e-5f; // 10 us steps
        // Step 1: at t = 10 us (well before 200 us delay)
        cuda_solver.stepWithDt(dt, true);
        cuda_solver.syncParticlesToHost();
        int ignited_step1 = 0;
        float max_lambda_step1 = 0.0f;
        float max_s_step1 = 0.0f;
        for (const auto& p : cuda_solver.getParticles()) {
            if (p.lambda > max_lambda_step1) max_lambda_step1 = p.lambda;
            if (p.s_shock > max_s_step1) max_s_step1 = p.s_shock;
            if (p.lambda > 0.01f) ignited_step1++;
        }
        std::cout << "MPM CUDA CREST at t = 10 us: ignited = " << ignited_step1 
                  << ", max_lambda = " << max_lambda_step1 
                  << ", max_s_shock = " << max_s_step1 << "\n";
        assert(ignited_step1 == 0 && "MPM CUDA CREST ignited prematurely at step 1!");

        // Run until after t_delay (step 30 = 300 us)
        for (int step = 2; step <= 30; ++step) {
            cuda_solver.stepWithDt(dt, true);
        }
        cuda_solver.syncParticlesToHost();
        int ignited_final = 0;
        for (const auto& p : cuda_solver.getParticles()) {
            if (p.lambda > 0.01f) ignited_final++;
        }
        std::cout << "MPM CUDA CREST at t = 300 us (after delay): ignited = " << ignited_final << "\n";
        assert(ignited_final > 0 && "MPM CUDA CREST failed to ignite after delay!");
    }

    std::cout << "\n--- TEST 8: MPM 3D CPU CREST Delayed Initiation ---\n";
    {
        MPMSolver3D cpu_solver;
        cpu_solver.initializeGrid(nx, ny, nz, dx, dx, dx, xmin, ymin, zmin);
        cpu_solver.setBoundaryConditions(MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                                         MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                                         MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip);
        cpu_solver.setTransferScheme(MPMTransferScheme::BSpline);
        cpu_solver.setVelocityScheme(MPMVelocityScheme::APIC);
        cpu_solver.setTimeScheme(MPMTimeIntegrationScheme::USL);

        cpu_solver.addBoxObject(1, 0.5f, 0.5f, 0.5f, 0.1f, 0.1f, 0.1f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                                1895.0f, 10.0e9f, 0.35f, 50.0e6f, 100.0e6f, 0.1f, 60.0e6f, 8);

        auto& mat_tables = cpu_solver.getMaterialTables();
        mat_tables.resize(2);
        mat_tables[1].material_model = MPMMaterialModel::CRESTReactiveBurn;
        mat_tables[1].burn_model = ReactionKinetics::CRESTEntropy;
        mat_tables[1].solid_model = SolidReactantEOS::DavisSolid;
        mat_tables[1].product_model = DetonationProductEOS::DavisProduct;
        mat_tables[1].density = 1895.0f;
        mat_tables[1].davis_c0 = 2050.0f;
        mat_tables[1].davis_s1 = 2.12f;
        mat_tables[1].davis_gamma0 = 0.65f;
        mat_tables[1].davis_cv = 1000.0f;
        mat_tables[1].davis_t0 = 293.0f;
        mat_tables[1].davis_rho0 = 1895.0f;
        mat_tables[1].davis_a = 2.85f;
        mat_tables[1].davis_b = 1.10f;
        mat_tables[1].davis_k = 1.35f;
        mat_tables[1].davis_vc = 0.65f;
        mat_tables[1].davis_pc = 12.5e9f;
        mat_tables[1].davis_q_det = 3.90e6f;
        mat_tables[1].detonation_energy = 3.90e6f;
        mat_tables[1].crest_b1 = 1.2e7f;
        mat_tables[1].crest_c1 = 0.67f;
        mat_tables[1].crest_m1 = 2.5f;
        mat_tables[1].crest_b2 = 3.5e6f;
        mat_tables[1].crest_c2 = 0.50f;
        mat_tables[1].crest_c3 = 0.67f;
        mat_tables[1].crest_m2 = 1.5f;
        mat_tables[1].crest_s0 = 15.0f;
        mat_tables[1].crest_s_threshold = 2.0f;

        float t_delay = 2.0e-4f; // 200 microseconds
        cpu_solver.addDetonator(0.5f, 0.5f, 0.5f, 0.02f, t_delay, false, 1);

        float dt = 1.0e-5f; // 10 us steps
        // Step 1: at t = 10 us (well before 200 us delay)
        cpu_solver.stepWithDt(dt, true);
        int ignited_step1 = 0;
        float max_lambda_step1 = 0.0f;
        float max_s_step1 = 0.0f;
        for (const auto& p : cpu_solver.getParticles()) {
            if (p.lambda > max_lambda_step1) max_lambda_step1 = p.lambda;
            if (p.s_shock > max_s_step1) max_s_step1 = p.s_shock;
            if (p.lambda > 0.01f) ignited_step1++;
        }
        std::cout << "MPM CPU CREST at t = 10 us: ignited = " << ignited_step1 
                  << ", max_lambda = " << max_lambda_step1 
                  << ", max_s_shock = " << max_s_step1 << "\n";
        assert(ignited_step1 == 0 && "MPM CPU CREST ignited prematurely at step 1!");

        // Run until after t_delay (step 30 = 300 us)
        for (int step = 2; step <= 30; ++step) {
            cpu_solver.stepWithDt(dt, true);
        }
        int ignited_final = 0;
        for (const auto& p : cpu_solver.getParticles()) {
            if (p.lambda > 0.01f) ignited_final++;
        }
        std::cout << "MPM CPU CREST at t = 300 us (after delay): ignited = " << ignited_final << "\n";
        assert(ignited_final > 0 && "MPM CPU CREST failed to ignite after delay!");
    }

    std::cout << "\n--- TEST 9: MPM 3D CUDA CREST High-Speed (750 m/s) with Thermal Offset & Delayed Ignition ---\n";
    {
        MPMSolver3DCUDA cuda_solver;
        cuda_solver.initializeGrid(nx, ny, nz, dx, dx, dx, xmin, ymin, zmin);
        cuda_solver.setBoundaryConditions(MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                                          MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                                          MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip);
        cuda_solver.setTransferScheme(MPMTransferScheme::BSpline);
        cuda_solver.setVelocityScheme(MPMVelocityScheme::APIC);
        cuda_solver.setTimeScheme(MPMTimeIntegrationScheme::USL);

        // Add moving box object with vel_x = 750 m/s, ang_x = 2000 rad/s
        cuda_solver.addBoxObject(1, 0.3f, 0.5f, 0.5f, 0.08f, 0.08f, 0.08f, 750.0f, 0.0f, 0.0f, 2000.0f, 0.0f, 0.0f,
                                 1717.0f, 7.2e9f, 0.34f, 35.0e6f, 70.0e6f, 0.15f, 40.0e6f, 8);

        auto& mat_tables = cuda_solver.getMaterialTables();
        mat_tables.resize(2);
        mat_tables[1].material_model = MPMMaterialModel::CRESTReactiveBurn;
        mat_tables[1].burn_model = ReactionKinetics::CRESTEntropy;
        mat_tables[1].solid_model = SolidReactantEOS::DavisSolid;
        mat_tables[1].product_model = DetonationProductEOS::DavisProduct;
        mat_tables[1].density = 1717.0f;
        mat_tables[1].davis_c0 = 2450.0f;
        mat_tables[1].davis_s1 = 1.95f;
        mat_tables[1].davis_gamma0 = 0.72f;
        mat_tables[1].davis_cv = 1050.0f;
        mat_tables[1].davis_t0 = 293.0f; // Reference T0
        mat_tables[1].davis_rho0 = 1717.0f;
        mat_tables[1].davis_a = 2.70f;
        mat_tables[1].davis_b = 1.15f;
        mat_tables[1].davis_k = 1.36f;
        mat_tables[1].davis_vc = 0.66f;
        mat_tables[1].davis_pc = 11.8e9f;
        mat_tables[1].davis_q_det = 4.60e6f;
        mat_tables[1].detonation_energy = 5.19e6f;
        mat_tables[1].crest_b1 = 1.8e7f;
        mat_tables[1].crest_c1 = 0.67f;
        mat_tables[1].crest_m1 = 2.3f;
        mat_tables[1].crest_b2 = 4.5e6f;
        mat_tables[1].crest_c2 = 0.50f;
        mat_tables[1].crest_c3 = 0.67f;
        mat_tables[1].crest_m2 = 1.4f;
        mat_tables[1].crest_s0 = 15.0f;
        mat_tables[1].crest_s_threshold = 1.5f;

        // Apply thermal offset (e.g. ambient T = 288.15 K != davis_t0 = 293.0 K)
        for (auto& p : cuda_solver.getParticles()) {
            p.temperature = 288.15f;
            p.s_shock = 0.0f;
            p.lambda = 0.0f;
            p.e_int = 0.0f;
            p.v_min = 1.0f;
        }

        cuda_solver.uploadMaterialTableToDevice();

        float t_delay = 2.0e-4f; // 200 us delay
        // Detonator at center of box, tracking velocity
        cuda_solver.addDetonator(0.3f, 0.5f, 0.5f, 0.015f, t_delay, true, 1);
        cuda_solver.syncToDevice();

        float dt = 5.0e-6f; // 5 us steps
        // Advance 20 steps (t = 100 us, halfway to delay)
        for (int i = 0; i < 20; ++i) {
            cuda_solver.stepWithDt(dt, true);
        }
        cuda_solver.syncParticlesToHost();
        int ignited_100us = 0;
        float max_s_100us = 0.0f;
        float max_lam_100us = 0.0f;
        for (const auto& p : cuda_solver.getParticles()) {
            if (p.lambda > max_lam_100us) max_lam_100us = p.lambda;
            if (p.s_shock > max_s_100us) max_s_100us = p.s_shock;
            if (p.lambda > 0.01f) ignited_100us++;
        }
        std::cout << "MPM CUDA CREST (750 m/s moving) at t = 100 us: ignited = " << ignited_100us
                  << ", max_lambda = " << max_lam_100us
                  << ", max_s_shock = " << max_s_100us << "\n";
        assert(ignited_100us == 0 && "Moving MPM CUDA CREST ignited prematurely before delay!");

        // Advance past delay (to t = 250 us, 30 more steps)
        for (int i = 0; i < 30; ++i) {
            cuda_solver.stepWithDt(dt, true);
        }
        cuda_solver.syncParticlesToHost();
        int ignited_after = 0;
        float max_s_after = 0.0f;
        float max_lam_after = 0.0f;
        for (const auto& p : cuda_solver.getParticles()) {
            if (p.lambda > max_lam_after) max_lam_after = p.lambda;
            if (p.s_shock > max_s_after) max_s_after = p.s_shock;
            if (p.lambda > 0.01f) ignited_after++;
        }
        std::cout << "MPM CUDA CREST (750 m/s moving) at t = 250 us (after delay): ignited = " << ignited_after
                  << ", max_lambda = " << max_lam_after
                  << ", max_s_shock = " << max_s_after << "\n";
        assert(ignited_after > 0 && "Moving MPM CUDA CREST failed to detonate after delay!");
    }

    std::cout << "\n--- TEST 10: MPM 3D CPU CREST High-Speed (750 m/s) with Thermal Offset & Delayed Ignition ---\n";
    {
        MPMSolver3D cpu_solver;
        cpu_solver.initializeGrid(nx, ny, nz, dx, dx, dx, xmin, ymin, zmin);
        cpu_solver.setBoundaryConditions(MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                                          MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                                          MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip);
        cpu_solver.setTransferScheme(MPMTransferScheme::BSpline);
        cpu_solver.setVelocityScheme(MPMVelocityScheme::APIC);
        cpu_solver.setTimeScheme(MPMTimeIntegrationScheme::USL);

        cpu_solver.addBoxObject(1, 0.3f, 0.5f, 0.5f, 0.08f, 0.08f, 0.08f, 750.0f, 0.0f, 0.0f, 2000.0f, 0.0f, 0.0f,
                                1717.0f, 7.2e9f, 0.34f, 35.0e6f, 70.0e6f, 0.15f, 40.0e6f, 8);

        auto& mat_tables = cpu_solver.getMaterialTables();
        mat_tables.resize(2);
        mat_tables[1].material_model = MPMMaterialModel::CRESTReactiveBurn;
        mat_tables[1].burn_model = ReactionKinetics::CRESTEntropy;
        mat_tables[1].solid_model = SolidReactantEOS::DavisSolid;
        mat_tables[1].product_model = DetonationProductEOS::DavisProduct;
        mat_tables[1].density = 1717.0f;
        mat_tables[1].davis_c0 = 2450.0f;
        mat_tables[1].davis_s1 = 1.95f;
        mat_tables[1].davis_gamma0 = 0.72f;
        mat_tables[1].davis_cv = 1050.0f;
        mat_tables[1].davis_t0 = 293.0f;
        mat_tables[1].davis_rho0 = 1717.0f;
        mat_tables[1].davis_a = 2.70f;
        mat_tables[1].davis_b = 1.15f;
        mat_tables[1].davis_k = 1.36f;
        mat_tables[1].davis_vc = 0.66f;
        mat_tables[1].davis_pc = 11.8e9f;
        mat_tables[1].davis_q_det = 4.60e6f;
        mat_tables[1].detonation_energy = 5.19e6f;
        mat_tables[1].crest_b1 = 1.8e7f;
        mat_tables[1].crest_c1 = 0.67f;
        mat_tables[1].crest_m1 = 2.3f;
        mat_tables[1].crest_b2 = 4.5e6f;
        mat_tables[1].crest_c2 = 0.50f;
        mat_tables[1].crest_c3 = 0.67f;
        mat_tables[1].crest_m2 = 1.4f;
        mat_tables[1].crest_s0 = 15.0f;
        mat_tables[1].crest_s_threshold = 1.5f;

        for (auto& p : cpu_solver.getParticles()) {
            p.temperature = 288.15f;
            p.s_shock = 0.0f;
            p.lambda = 0.0f;
            p.e_int = 0.0f;
            p.v_min = 1.0f;
        }

        float t_delay = 2.0e-4f;
        cpu_solver.addDetonator(0.3f, 0.5f, 0.5f, 0.015f, t_delay, true, 1);

        float dt = 5.0e-6f;
        for (int i = 0; i < 20; ++i) {
            cpu_solver.stepWithDt(dt, true);
        }
        int ignited_100us = 0;
        float max_s_100us = 0.0f;
        float max_lam_100us = 0.0f;
        for (const auto& p : cpu_solver.getParticles()) {
            if (p.lambda > max_lam_100us) max_lam_100us = p.lambda;
            if (p.s_shock > max_s_100us) max_s_100us = p.s_shock;
            if (p.lambda > 0.01f) ignited_100us++;
        }
        std::cout << "MPM CPU CREST (750 m/s moving) at t = 100 us: ignited = " << ignited_100us
                  << ", max_lambda = " << max_lam_100us
                  << ", max_s_shock = " << max_s_100us << "\n";
        assert(ignited_100us == 0 && "Moving MPM CPU CREST ignited prematurely before delay!");

        for (int i = 0; i < 30; ++i) {
            cpu_solver.stepWithDt(dt, true);
        }
        int ignited_after = 0;
        float max_s_after = 0.0f;
        float max_lam_after = 0.0f;
        for (const auto& p : cpu_solver.getParticles()) {
            if (p.lambda > max_lam_after) max_lam_after = p.lambda;
            if (p.s_shock > max_s_after) max_s_after = p.s_shock;
            if (p.lambda > 0.01f) ignited_after++;
        }
        std::cout << "MPM CPU CREST (750 m/s moving) at t = 250 us (after delay): ignited = " << ignited_after
                  << ", max_lambda = " << max_lam_after
                  << ", max_s_shock = " << max_s_after << "\n";
        assert(ignited_after > 0 && "Moving MPM CPU CREST failed to detonate after delay!");
    }

    std::cout << "\n--- TEST 11: Irreversible Shock Entropy & Multi-Material Spinning Projectile (Fuze + CREST Explosive) ---\n";
    {
        // Part A: Verify Rayleigh-Hugoniot irreversible shock entropy excludes reversible elastic energy
        float s_elastic_127MPa = Blast::CrestDavis::computeDavisShockEntropyFromPressure(
            127.0e6f, 2450.0f, 1.95f, 1050.0f, 293.0f, 1717.0f);
        float s_shock_600MPa = Blast::CrestDavis::computeDavisShockEntropyFromPressure(
            600.0e6f, 2450.0f, 1.95f, 1050.0f, 293.0f, 1717.0f);
        std::cout << "Irreversible s_shock at 127 MPa (elastic): " << s_elastic_127MPa
                  << " J/(kg*K), at 600 MPa (shock): " << s_shock_600MPa << " J/(kg*K)\n";
        assert(s_elastic_127MPa < 0.05f && "127 MPa elastic stress must stay far below 1.5 J/(kg*K) CREST threshold!");
        assert(s_shock_600MPa > 1.5f && "600 MPa shock stress must exceed 1.5 J/(kg*K) CREST threshold!");

        // Part B: Multi-material spinning/translating projectile (Steel Fuze + CREST Explosive)
        // with Bardenhagen contact and per-object BSpline transfer on a Standard global solver
        MPMSolver3DCUDA cuda_solver;
        cuda_solver.initializeGrid(nx, ny, nz, dx, dx, dx, xmin, ymin, zmin);
        cuda_solver.setBoundaryConditions(MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                                           MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                                           MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip);
        cuda_solver.setTransferScheme(MPMTransferScheme::Standard); // Overridden per-material to BSpline (2)
        cuda_solver.setVelocityScheme(MPMVelocityScheme::APIC);
        cuda_solver.setTimeScheme(MPMTimeIntegrationScheme::USL);
        cuda_solver.setContactMethod(MPMContactMethod::MultiVelocityBardenhagen);

        // Object 1: Steel Fuze (front block x in [0.34, 0.38])
        cuda_solver.addBoxObject(1, 0.36f, 0.5f, 0.5f, 0.04f, 0.08f, 0.08f, 750.0f, 0.0f, 0.0f, 2000.0f, 0.0f, 0.0f,
                                 7850.0f, 200.0e9f, 0.30f, 800.0e6f, 500.0e6f, 0.25f, 1.5e9f, 8);
        // Object 2: Composition B CREST Explosive (rear block x in [0.26, 0.34], directly abutting Fuze at x = 0.34)
        cuda_solver.addBoxObject(2, 0.30f, 0.5f, 0.5f, 0.08f, 0.08f, 0.08f, 750.0f, 0.0f, 0.0f, 2000.0f, 0.0f, 0.0f,
                                 1717.0f, 7.2e9f, 0.34f, 35.0e6f, 70.0e6f, 0.15f, 40.0e6f, 8);
        cuda_solver.setObjectMaterialMapping({0, 0, 1}, 2);

        auto& mat_tables = cuda_solver.getMaterialTables();
        mat_tables.resize(3);
        mat_tables[1].material_model = MPMMaterialModel::Hypoelastic;
        mat_tables[1].solid_model = SolidReactantEOS::MieGruneisen;
        mat_tables[1].density = 7850.0f;
        mat_tables[1].youngs_modulus = 200.0e9f;
        mat_tables[1].poissons_ratio = 0.30f;
        mat_tables[1].yield_stress = 800.0e6f;
        mat_tables[1].hardening_modulus = 500.0e6f;
        mat_tables[1].transfer_scheme = 2; // BSpline per-object override

        mat_tables[2].material_model = MPMMaterialModel::CRESTReactiveBurn;
        mat_tables[2].burn_model = ReactionKinetics::CRESTEntropy;
        mat_tables[2].solid_model = SolidReactantEOS::DavisSolid;
        mat_tables[2].product_model = DetonationProductEOS::DavisProduct;
        mat_tables[2].density = 1717.0f;
        mat_tables[2].youngs_modulus = 7.2e9f;
        mat_tables[2].poissons_ratio = 0.34f;
        mat_tables[2].yield_stress = 35.0e6f;
        mat_tables[2].hardening_modulus = 70.0e6f;
        mat_tables[2].davis_c0 = 2450.0f;
        mat_tables[2].davis_s1 = 1.95f;
        mat_tables[2].davis_gamma0 = 0.72f;
        mat_tables[2].davis_cv = 1050.0f;
        mat_tables[2].davis_t0 = 293.0f;
        mat_tables[2].davis_rho0 = 1717.0f;
        mat_tables[2].davis_a = 2.70f;
        mat_tables[2].davis_b = 1.15f;
        mat_tables[2].davis_k = 1.36f;
        mat_tables[2].davis_vc = 0.66f;
        mat_tables[2].davis_pc = 11.8e9f;
        mat_tables[2].davis_q_det = 4.60e6f;
        mat_tables[2].detonation_energy = 5.19e6f;
        mat_tables[2].crest_b1 = 1.8e7f;
        mat_tables[2].crest_c1 = 0.67f;
        mat_tables[2].crest_m1 = 2.3f;
        mat_tables[2].crest_b2 = 4.5e6f;
        mat_tables[2].crest_c2 = 0.50f;
        mat_tables[2].crest_c3 = 0.67f;
        mat_tables[2].crest_m2 = 1.4f;
        mat_tables[2].crest_s0 = 15.0f;
        mat_tables[2].crest_s_threshold = 1.5f;
        mat_tables[2].transfer_scheme = 2; // BSpline per-object override

        for (auto& p : cuda_solver.getParticles()) {
            p.temperature = 288.15f;
            p.s_shock = 0.0f;
            p.lambda = 0.0f;
            p.e_int = 0.0f;
            p.v_min = 1.0f;
        }
        cuda_solver.uploadMaterialTableToDevice();

        // Delayed detonator at Fuze/Explosive interface (x = 0.34) tracking MPM velocity
        float t_delay = 2.0e-4f;
        cuda_solver.addDetonator(0.34f, 0.5f, 0.5f, 0.02f, t_delay, true, 2);
        cuda_solver.syncToDevice();

        float dt = 2.5e-6f;
        for (int i = 0; i < 40; ++i) {
            cuda_solver.stepWithDt(dt, true);
        }
        cuda_solver.syncParticlesToHost();
        int ignited_100us = 0;
        float max_s_100us = 0.0f;
        float max_lam_100us = 0.0f;
        for (const auto& p : cuda_solver.getParticles()) {
            if (p.object_id == 2) {
                if (p.lambda > max_lam_100us) max_lam_100us = p.lambda;
                if (p.s_shock > max_s_100us) max_s_100us = p.s_shock;
                if (p.lambda > 0.01f) ignited_100us++;
            }
        }
        std::cout << "Multi-Material Spinning Projectile at t = 100 us: ignited = " << ignited_100us
                  << ", max_lambda = " << max_lam_100us
                  << ", max_s_shock = " << max_s_100us << "\n";
        assert(ignited_100us == 0 && "Multi-material spinning projectile ignited prematurely at interface!");
        assert(max_lam_100us == 0.0f && "Multi-material spinning projectile had non-zero lambda before delay!");

        for (int i = 0; i < 60; ++i) {
            cuda_solver.stepWithDt(dt, true);
        }
        cuda_solver.syncParticlesToHost();
        int ignited_after = 0;
        float max_s_after = 0.0f;
        float max_lam_after = 0.0f;
        for (const auto& p : cuda_solver.getParticles()) {
            if (p.object_id == 2) {
                if (p.lambda > max_lam_after) max_lam_after = p.lambda;
                if (p.s_shock > max_s_after) max_s_after = p.s_shock;
                if (p.lambda > 0.01f) ignited_after++;
            }
        }
        std::cout << "Multi-Material Spinning Projectile at t = 250 us (after delay): ignited = " << ignited_after
                  << ", max_lambda = " << max_lam_after
                  << ", max_s_shock = " << max_s_after << "\n";
        assert(ignited_after > 0 && "Multi-material spinning projectile failed to detonate after delay!");
    }

    std::cout << "\n========================================================\n";
    std::cout << "ALL 11 DETONATOR DELAY & VELOCITY TRACKING TESTS PASSED!\n";
    std::cout << "========================================================\n";

    return 0;
}
