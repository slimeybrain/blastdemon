#include "fem_solver_3d.hpp"
#include "fem_solver_3d_cuda.hpp"
#include <iostream>
#include <vector>
#include <cmath>
#include <cassert>
#include <iomanip>

using namespace Blast;

int main() {
    std::cout << "[TEST] Running test_fem_3d_gpu_contact_methods..." << std::endl;

    MaterialTable3D mat{};
    mat.density = 7850.0f;
    mat.youngs_modulus = 210.0e9f;
    mat.poissons_ratio = 0.30f;
    mat.yield_stress = 400.0e6f;

    // Test 1: Hierarchical Octave Hash Grid
    std::cout << "--- Subtest 1: Hierarchical Octave Hash Grid ---" << std::endl;
    float max_f_octave = 0.0f;
    {
        FEMSolver3DCUDA<float> solver;
        solver.setIntegrationScheme(FEMIntegrationScheme::OnePointFB);
        solver.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoViscous);
        solver.setHourglassCoeff(0.10f);
        solver.setContactPenaltyScale(0.50f);
        solver.setContactDamping(0.20f);
        solver.setFrictionCoefficients(0.3f, 0.2f);
        solver.setContactSearchMethod(FEMContactSearchMethod::HierarchicalOctaveGrid);

        // Fixed base block (0.1 x 0.1 x 0.04 m)
        solver.addStructuredBoxMesh(
            4, 4, 2,
            0.10f, 0.10f, 0.04f,
            0.0f, 0.0f, 0.0f,
            mat, 0.0f, 0.0f, 0.0f, "Fixed"
        );

        // Impacting projectile block (0.04 x 0.04 x 0.02 m) traveling downward at vz = -50 m/s
        solver.addStructuredBoxMesh(
            2, 2, 1,
            0.04f, 0.04f, 0.02f,
            0.03f, 0.03f, 0.0402f,
            mat, 0.0f, 0.0f, -50.0f, "Free"
        );

        for (int step = 1; step <= 250; ++step) {
            float dt = solver.computeStepSize(0.3f);
            solver.stepWithDt(dt);

            const auto& nodes = solver.getNodes();
            for (size_t i = 0; i < nodes.size(); ++i) {
                float f_mag = std::sqrt(nodes[i].f_contact[0]*nodes[i].f_contact[0] +
                                        nodes[i].f_contact[1]*nodes[i].f_contact[1] +
                                        nodes[i].f_contact[2]*nodes[i].f_contact[2]);
                if (f_mag > max_f_octave) max_f_octave = f_mag;
            }
        }
        std::cout << "  Octave Grid Peak Contact Force Magnitude = " << max_f_octave << " N" << std::endl;
        if (max_f_octave < 50.0f) {
            std::cerr << "[FAIL] Octave grid failed to produce contact response force!" << std::endl;
            return 1;
        }
        std::cout << "  [PASS] Hierarchical Octave Hash Grid contact verified." << std::endl;
    }

    // Test 2: Linear BVH (Morton Codes)
    std::cout << "--- Subtest 2: GPU Linear BVH (Morton Codes) ---" << std::endl;
    float max_f_lbvh = 0.0f;
    {
        FEMSolver3DCUDA<float> solver;
        solver.setIntegrationScheme(FEMIntegrationScheme::OnePointFB);
        solver.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoViscous);
        solver.setHourglassCoeff(0.10f);
        solver.setContactPenaltyScale(0.50f);
        solver.setContactDamping(0.20f);
        solver.setFrictionCoefficients(0.3f, 0.2f);
        solver.setContactSearchMethod(FEMContactSearchMethod::LinearBVH);

        // Fixed base block (0.1 x 0.1 x 0.04 m)
        solver.addStructuredBoxMesh(
            4, 4, 2,
            0.10f, 0.10f, 0.04f,
            0.0f, 0.0f, 0.0f,
            mat, 0.0f, 0.0f, 0.0f, "Fixed"
        );

        // Impacting projectile block (0.04 x 0.04 x 0.02 m) traveling downward at vz = -50 m/s
        solver.addStructuredBoxMesh(
            2, 2, 1,
            0.04f, 0.04f, 0.02f,
            0.03f, 0.03f, 0.0402f,
            mat, 0.0f, 0.0f, -50.0f, "Free"
        );

        for (int step = 1; step <= 250; ++step) {
            float dt = solver.computeStepSize(0.3f);
            solver.stepWithDt(dt);

            const auto& nodes = solver.getNodes();
            for (size_t i = 0; i < nodes.size(); ++i) {
                float f_mag = std::sqrt(nodes[i].f_contact[0]*nodes[i].f_contact[0] +
                                        nodes[i].f_contact[1]*nodes[i].f_contact[1] +
                                        nodes[i].f_contact[2]*nodes[i].f_contact[2]);
                if (f_mag > max_f_lbvh) max_f_lbvh = f_mag;
            }
        }
        std::cout << "  Linear BVH Peak Contact Force Magnitude = " << max_f_lbvh << " N" << std::endl;
        if (max_f_lbvh < 50.0f) {
            std::cerr << "[FAIL] Linear BVH failed to produce contact response force!" << std::endl;
            return 1;
        }
        std::cout << "  [PASS] GPU Linear BVH contact verified." << std::endl;
    }

    // Parity check between Octave Grid and Linear BVH
    float rel_diff = std::fabs(max_f_octave - max_f_lbvh) / std::max(max_f_octave, max_f_lbvh);
    std::cout << "  Relative Peak Force Difference between Octave Grid & LBVH: " 
              << std::fixed << std::setprecision(2) << (rel_diff * 100.0f) << "%" << std::endl;
    if (rel_diff > 0.15f) {
        std::cerr << "[FAIL] Discrepancy between Octave Grid and Linear BVH exceeds 15%!" << std::endl;
        return 1;
    }

    std::cout << "[PASS] test_fem_3d_gpu_contact_methods PASSED successfully!" << std::endl;
    return 0;
}
