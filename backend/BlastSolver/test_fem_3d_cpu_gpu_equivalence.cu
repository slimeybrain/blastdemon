#include "fem_solver_3d.hpp"
#include "fem_solver_3d_cuda.hpp"
#include <iostream>
#include <vector>
#include <cmath>
#include <cassert>
#include <algorithm>

using namespace Blast;

int main() {
    std::cout << "[TEST] Running test_fem_3d_cpu_gpu_equivalence..." << std::endl;
    FEMSolver3D<float> cpu_solver;
    FEMSolver3DCUDA<float> gpu_solver;

    MaterialTable3D mat{};
    mat.density = 8960.0f; // Copper
    mat.youngs_modulus = 124.0e9f;
    mat.poissons_ratio = 0.34f;
    mat.yield_stress = 90.0e6f;
    mat.hardening_modulus = 292.0e6f;
    mat.failure_strain = 1.54f;
    mat.bulk_viscosity_b1 = 0.06f;
    mat.bulk_viscosity_b2 = 1.2f;

    // 1. Add Target Rigid Base Box
    cpu_solver.addStructuredBoxMesh(
        6, 6, 6,
        0.03f, 0.03f, 0.03f,
        -0.015f, -0.015f, 0.0f,
        mat, 0.0f, 0.0f, 0.0f, "Fixed Entire"
    );

    // 2. Add Cylinder Projectile
    cpu_solver.addStructuredCylinderMesh(
        3, 12,
        0.004f, 0.030f,
        0.0f, 0.0f, 0.0306f,
        mat, 0.0f, 0.0f, -100.0f, 0.0f, "Free"
    );

    cpu_solver.setIntegrationScheme(FEMIntegrationScheme::FullGauss8);
    cpu_solver.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoViscous);
    cpu_solver.setHourglassCoeff(0.1f);
    cpu_solver.setContactPenaltyScale(0.1f);

    // Setup GPU Solver identically
    gpu_solver.setIntegrationScheme(FEMIntegrationScheme::FullGauss8);
    gpu_solver.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoViscous);
    gpu_solver.setHourglassCoeff(0.1f);
    gpu_solver.setContactPenaltyScale(0.1f);

    gpu_solver.addStructuredBoxMesh(
        6, 6, 6,
        0.03f, 0.03f, 0.03f,
        -0.015f, -0.015f, 0.0f,
        mat, 0.0f, 0.0f, 0.0f, "Fixed Entire"
    );

    gpu_solver.addStructuredCylinderMesh(
        3, 12,
        0.004f, 0.030f,
        0.0f, 0.0f, 0.0306f,
        mat, 0.0f, 0.0f, -100.0f, 0.0f, "Free"
    );

    std::cout << "  CPU Mesh: " << cpu_solver.getNodes().size() << " nodes, " << cpu_solver.getElements().size() << " elements." << std::endl;
    std::cout << "  GPU Mesh: " << gpu_solver.getNodes().size() << " nodes, " << gpu_solver.getElements().size() << " elements." << std::endl;

    assert(cpu_solver.getNodes().size() == gpu_solver.getNodes().size());
    assert(cpu_solver.getElements().size() == gpu_solver.getElements().size());

    float fixed_dt = 1.0e-7f;

    // Run 100 explicit time steps
    for (int step = 0; step < 100; ++step) {
        cpu_solver.stepWithDt(fixed_dt);
        gpu_solver.stepWithDt(fixed_dt);

        if (step % 25 == 0 || step == 99) {
            const auto& cpu_nodes = cpu_solver.getNodes();
            const auto& gpu_nodes = gpu_solver.getNodes();
            const auto& cpu_elems = cpu_solver.getElements();
            const auto& gpu_elems = gpu_solver.getElements();

            float max_x_diff = 0.0f;
            float max_v_diff = 0.0f;
            int mismatch_node = -1;
            for (size_t i = 0; i < cpu_nodes.size(); ++i) {
                for (int c = 0; c < 3; ++c) {
                    float dx = std::fabs(cpu_nodes[i].x[c] - gpu_nodes[i].x[c]);
                    float dv = std::fabs(cpu_nodes[i].v[c] - gpu_nodes[i].v[c]);
                    if (dx > max_x_diff) { max_x_diff = dx; if (dx > 1e-6) mismatch_node = i; }
                    if (dv > max_v_diff) { max_v_diff = dv; if (dv > 1e-4) mismatch_node = i; }
                }
            }

            int mismatch_elem = -1;
            float max_sig_diff = 0.0f;
            for (size_t e = 0; e < cpu_elems.size(); ++e) {
                for (int r = 0; r < 3; ++r) {
                    for (int c = 0; c < 3; ++c) {
                        float ds = std::fabs(cpu_elems[e].sigma[r][c] - gpu_elems[e].sigma[r][c]);
                        if (ds > max_sig_diff) {
                            max_sig_diff = ds;
                            if (ds > 1e-3) mismatch_elem = e;
                        }
                    }
                }
            }

            cpu_solver.computeGlobalEnergy();
            const auto& e_cpu = cpu_solver.getEnergyTracker();
            const auto& e_gpu = gpu_solver.getEnergyTracker();

            std::cout << "  [Step " << step << "] Max Pos Diff: " << max_x_diff << " m, Max Vel Diff: " << max_v_diff << " m/s, Max Stress Diff: " << max_sig_diff << " Pa" << std::endl;
            std::cout << "          CPU E_kin=" << e_cpu.E_kin << " J, E_int=" << e_cpu.E_int << " J" << std::endl;
            std::cout << "          GPU E_kin=" << e_gpu.E_kin << " J, E_int=" << e_gpu.E_int << " J" << std::endl;

            if (mismatch_node != -1) {
                std::cout << "  --- First Nodal Mismatch at Node " << mismatch_node << " ---" << std::endl;
                std::cout << "    CPU Pos: " << cpu_nodes[mismatch_node].x[0] << ", " << cpu_nodes[mismatch_node].x[1] << ", " << cpu_nodes[mismatch_node].x[2] << std::endl;
                std::cout << "    GPU Pos: " << gpu_nodes[mismatch_node].x[0] << ", " << gpu_nodes[mismatch_node].x[1] << ", " << gpu_nodes[mismatch_node].x[2] << std::endl;
                std::cout << "    CPU Vel: " << cpu_nodes[mismatch_node].v[0] << ", " << cpu_nodes[mismatch_node].v[1] << ", " << cpu_nodes[mismatch_node].v[2] << std::endl;
                std::cout << "    GPU Vel: " << gpu_nodes[mismatch_node].v[0] << ", " << gpu_nodes[mismatch_node].v[1] << ", " << gpu_nodes[mismatch_node].v[2] << std::endl;
                std::cout << "    CPU Acc: " << cpu_nodes[mismatch_node].a[0] << ", " << cpu_nodes[mismatch_node].a[1] << ", " << cpu_nodes[mismatch_node].a[2] << std::endl;
                std::cout << "    GPU Acc: " << gpu_nodes[mismatch_node].a[0] << ", " << gpu_nodes[mismatch_node].a[1] << ", " << gpu_nodes[mismatch_node].a[2] << std::endl;
                std::cout << "    CPU f_int: " << cpu_nodes[mismatch_node].f_int[0] << ", " << cpu_nodes[mismatch_node].f_int[1] << ", " << cpu_nodes[mismatch_node].f_int[2] << std::endl;
                std::cout << "    GPU f_int: " << gpu_nodes[mismatch_node].f_int[0] << ", " << gpu_nodes[mismatch_node].f_int[1] << ", " << gpu_nodes[mismatch_node].f_int[2] << std::endl;
            }
            if (mismatch_elem != -1) {
                std::cout << "  --- First Element Mismatch at Elem " << mismatch_elem << " ---" << std::endl;
                std::cout << "    CPU is_eroded: " << cpu_elems[mismatch_elem].is_eroded << ", GPU is_eroded: " << gpu_elems[mismatch_elem].is_eroded << std::endl;
                std::cout << "    CPU Sigma_zz: " << cpu_elems[mismatch_elem].sigma[2][2] << std::endl;
                std::cout << "    GPU Sigma_zz: " << gpu_elems[mismatch_elem].sigma[2][2] << std::endl;
                std::cout << "    CPU V: " << cpu_elems[mismatch_elem].V << ", GPU V: " << gpu_elems[mismatch_elem].V << std::endl;
            }



            assert(max_x_diff < 1.0e-4f);
            assert(max_v_diff < 5.0f);
        }
    }

    // Verify contact occurred and projectile rebounded/deformed without passing through
    const auto& final_gpu_nodes = gpu_solver.getNodes();
    float min_z_projectile = 1e9f;
    for (size_t i = 343; i < final_gpu_nodes.size(); ++i) { // Projectile nodes (343 to 1018)
        if (final_gpu_nodes[i].x[2] < min_z_projectile) {
            min_z_projectile = final_gpu_nodes[i].x[2];
        }
    }

    std::cout << "  Final Minimum Projectile Z (GPU) = " << min_z_projectile << " m" << std::endl;
    // Target surface is at z=0.03m. Projectile should not penetrate below 0.028m!
    assert(min_z_projectile > 0.028f);

    std::cout << "[PASS] test_fem_3d_cpu_gpu_equivalence PASSED successfully." << std::endl;
    return 0;
}
