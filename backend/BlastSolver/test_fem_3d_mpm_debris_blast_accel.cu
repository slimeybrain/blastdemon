#include <iostream>
#include <cassert>
#include <vector>
#include <cmath>
#include "fem_solver_3d.hpp"
#include "mpm_solver_3d.hpp"
#include "cfd_solver_3d.hpp"
#include "fem_fsi_coupler_3d.hpp"
#include "fem_solver_3d_cuda.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include "cfd_solver_3d_cuda.hpp"
#include "fem_fsi_coupler_3d_cuda.hpp"

using namespace Blast;

void test_mpm_debris_blast_acceleration_cpu() {
    std::cout << "=== TEST 1: CPU Auto-Generated MPM Debris Blast Acceleration ===" << std::endl;

    // 1. Create a 1-element FEM Solid Hex
    std::vector<FEMNode3D<float>> nodes(8);
    float L = 0.02f; // 20mm cube
    nodes[0].x[0] = 0.0f; nodes[0].x[1] = 0.0f; nodes[0].x[2] = 0.0f;
    nodes[1].x[0] = L;    nodes[1].x[1] = 0.0f; nodes[1].x[2] = 0.0f;
    nodes[2].x[0] = L;    nodes[2].x[1] = L;    nodes[2].x[2] = 0.0f;
    nodes[3].x[0] = 0.0f; nodes[3].x[1] = L;    nodes[3].x[2] = 0.0f;
    nodes[4].x[0] = 0.0f; nodes[4].x[1] = 0.0f; nodes[4].x[2] = L;
    nodes[5].x[0] = L;    nodes[5].x[1] = 0.0f; nodes[5].x[2] = L;
    nodes[6].x[0] = L;    nodes[6].x[1] = L;    nodes[6].x[2] = L;
    nodes[7].x[0] = 0.0f; nodes[7].x[1] = L;    nodes[7].x[2] = L;

    std::vector<FEMElement3D<float>> elements(1);
    for (int i = 0; i < 8; ++i) elements[0].node_ids[i] = i;
    elements[0].mat_id = 0;

    MaterialTable3D mat{};
    mat.density = 2400.0f;
    mat.youngs_modulus = 30.0e9f;
    mat.poissons_ratio = 0.20f;
    mat.enable_strain_erosion = true;
    mat.failure_strain = 0.01f;

    FEMSolver3D<float> fem;
    fem.setNodesAndElements(nodes, elements, mat);

    auto params = fem.getPhysicsParams();
    params.convert_failed_elements_to_mpm = true;
    params.mpm_particles_per_failed_element = 8;
    fem.setPhysicsParams(params);

    FEMErosionCriteria<float> erosion{};
    erosion.enable_strain_erosion = true;
    erosion.failure_strain = 0.01f;
    fem.setErosionCriteria(erosion);

    MPMSolver3D mpm;
    mpm.initializeGrid(32, 32, 32, 0.05f, 0.05f, 0.05f, -0.5f, -0.5f, -0.5f);
    fem.setMPMSolver(&mpm);

    // 2. Setup 3D CFD Solver with high blast pressure & supersonic velocity
    CFDSolver3DImpl<float, false> cfd(32, 32, 32, 0.05f, -0.5f, -0.5f, -0.5f);
    // Initialize high-speed blast wind along +X
    for (int k = 0; k < 32; ++k) {
        for (int j = 0; j < 32; ++j) {
            for (int i = 0; i < 32; ++i) {
                CellState3D<false> s{};
                s.p = 50.0e6f;  // 50 MPa shock pressure
                s.rho = 15.0f;  // High-density detonation gas (15 kg/m^3)
                s.ux = 1500.0f; // 1500 m/s blast wind along +X
                s.uy = 0.0f;
                s.uz = 0.0f;
                s.E = s.p / 0.4f + 0.5f * s.rho * s.ux * s.ux;
                cfd.setCellStateIdeal(i, j, k, s);
            }
        }
    }
    cfd.commitStates();

    // 3. Attach Coupler
    FEMFSICoupler3D<float> coupler;
    coupler.attachSolvers(&cfd, &fem);

    // 4. Force element erosion
    fem.getElements()[0].ep_bar = 0.05f; // Exceed failure strain 0.01
    fem.evaluateErosionCriteria();

    assert(fem.getElements()[0].is_eroded);
    assert(mpm.getParticles().size() == 8);
    std::cout << "  ✓ Element eroded into " << mpm.getParticles().size() << " MPM debris particles." << std::endl;

    // 5. Step coupler and measure debris acceleration
    float dt = 1.0e-5f; // 10 microseconds
    for (int step = 0; step < 10; ++step) {
        coupler.stepWithDt(dt);
    }

    const auto& particles = mpm.getParticles();
    float avg_vx = 0.0f;
    for (const auto& p : particles) {
        avg_vx += p.v[0];
    }
    avg_vx /= static_cast<float>(particles.size());

    std::cout << "  ✓ After 100 microseconds of supersonic blast wind, avg debris v_x = " << avg_vx << " m/s" << std::endl;
    assert(avg_vx > 10.0f); // Must pick up substantial load and accelerate
    std::cout << "  ✓ CPU MPM debris acceleration test passed successfully!" << std::endl;
}

void test_mpm_debris_blast_acceleration_gpu() {
    std::cout << "=== TEST 2: GPU Auto-Generated MPM Debris Blast Acceleration & Force Preservation ===" << std::endl;

    // 1. Create a 1-element FEM Solid Hex on GPU
    std::vector<FEMNode3D<float>> nodes(8);
    float L = 0.02f; // 20mm cube
    nodes[0].x[0] = 0.0f; nodes[0].x[1] = 0.0f; nodes[0].x[2] = 0.0f;
    nodes[1].x[0] = L;    nodes[1].x[1] = 0.0f; nodes[1].x[2] = 0.0f;
    nodes[2].x[0] = L;    nodes[2].x[1] = L;    nodes[2].x[2] = 0.0f;
    nodes[3].x[0] = 0.0f; nodes[3].x[1] = L;    nodes[3].x[2] = 0.0f;
    nodes[4].x[0] = 0.0f; nodes[4].x[1] = 0.0f; nodes[4].x[2] = L;
    nodes[5].x[0] = L;    nodes[5].x[1] = 0.0f; nodes[5].x[2] = L;
    nodes[6].x[0] = L;    nodes[6].x[1] = L;    nodes[6].x[2] = L;
    nodes[7].x[0] = 0.0f; nodes[7].x[1] = L;    nodes[7].x[2] = L;

    std::vector<FEMElement3D<float>> elements(1);
    for (int i = 0; i < 8; ++i) elements[0].node_ids[i] = i;
    elements[0].mat_id = 0;

    MaterialTable3D mat{};
    mat.density = 2400.0f;
    mat.youngs_modulus = 30.0e9f;
    mat.poissons_ratio = 0.20f;
    mat.enable_strain_erosion = true;
    mat.failure_strain = 0.01f;

    FEMSolver3DCUDA<float> fem_gpu;
    fem_gpu.setNodesAndElements(nodes, elements, mat);

    auto params = fem_gpu.getPhysicsParams();
    params.convert_failed_elements_to_mpm = true;
    params.mpm_particles_per_failed_element = 8;
    fem_gpu.setPhysicsParams(params);

    MPMSolver3D mpm_cpu;
    mpm_cpu.initializeGrid(32, 32, 32, 0.05f, 0.05f, 0.05f, -0.5f, -0.5f, -0.5f);
    fem_gpu.setMPMSolver(&mpm_cpu);

    MPMSolver3DCUDA mpm_gpu;
    mpm_gpu.initializeGrid(32, 32, 32, 0.05f, 0.05f, 0.05f, -0.5f, -0.5f, -0.5f);
    fem_gpu.setCUDAMPMSolver(&mpm_gpu);

    // 2. Setup 3D GPU CFD Solver with high blast pressure & supersonic velocity
    CFDSolver3DCuda<float, false> cfd_gpu(32, 32, 32, 0.05f, -0.5f, -0.5f, -0.5f);
    for (int k = 0; k < 32; ++k) {
        for (int j = 0; j < 32; ++j) {
            for (int i = 0; i < 32; ++i) {
                CellState3D<false> s{};
                s.p = 50.0e6f;  // 50 MPa shock pressure
                s.rho = 15.0f;  // High-density detonation gas (15 kg/m^3)
                s.ux = 1500.0f; // 1500 m/s blast wind along +X
                s.uy = 0.0f;
                s.uz = 0.0f;
                s.E = s.p / 0.4f + 0.5f * s.rho * s.ux * s.ux;
                cfd_gpu.setCellStateIdeal(i, j, k, s);
            }
        }
    }
    cfd_gpu.commitStates();

    // 3. Attach GPU Coupler
    FEMFSICoupler3DCUDA<float> coupler_gpu;
    coupler_gpu.attachSolvers(&cfd_gpu, &fem_gpu);

    // 4. Force element erosion
    FEMErosionCriteria<float> erosion{};
    erosion.enable_strain_erosion = true;
    erosion.failure_strain = 0.01f;
    fem_gpu.setErosionCriteria(erosion);

    fem_gpu.getElements()[0].ep_bar = 0.05f;
    fem_gpu.evaluateErosionCriteria();

    assert(fem_gpu.getElements()[0].is_eroded);
    assert(mpm_gpu.getParticleCount() == 8);
    std::cout << "  ✓ GPU Element eroded into " << mpm_gpu.getParticleCount() << " CUDA MPM debris particles." << std::endl;

    // 5. Step GPU coupler and measure debris acceleration
    float dt = 1.0e-5f; // 10 microseconds
    for (int step = 0; step < 10; ++step) {
        coupler_gpu.stepWithDt(dt);
    }

    mpm_gpu.syncToHost();
    const auto& particles_gpu = mpm_gpu.getParticles();
    float avg_vx_gpu = 0.0f;
    for (const auto& p : particles_gpu) {
        avg_vx_gpu += p.v[0];
    }
    avg_vx_gpu /= static_cast<float>(particles_gpu.size());

    std::cout << "  ✓ After 100 microseconds of GPU supersonic blast wind, avg debris v_x = " << avg_vx_gpu << " m/s" << std::endl;
    assert(avg_vx_gpu > 10.0f); // Must pick up substantial load and accelerate
    std::cout << "  ✓ GPU MPM debris acceleration & force preservation test passed successfully!" << std::endl;
}

int main() {
    test_mpm_debris_blast_acceleration_cpu();
    test_mpm_debris_blast_acceleration_gpu();
    std::cout << "\n=======================================================" << std::endl;
    std::cout << ">>> ALL MPM DEBRIS BLAST ACCELERATION TESTS PASSED! <<<" << std::endl;
    std::cout << "=======================================================" << std::endl;
    return 0;
}
