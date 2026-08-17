#include "fem_solver_3d.hpp"
#include <iostream>
#include <cassert>
#include <cmath>

using namespace Blast;

void test_elastic_wave_no_spurious_erosion() {
    std::cout << "--- Subtest: Elastic Wave Propagation (No Spurious Erosion) ---" << std::endl;
    FEMSolver3D<float> solver;

    MaterialTable3D mat{};
    mat.density = 7850.0f;
    mat.youngs_modulus = 200.0e9f;
    mat.poissons_ratio = 0.30f;
    mat.yield_stress = 1.0e12f; // High yield stress for pure elastic response
    mat.enable_timestep_erosion = true;
    mat.timestep_erosion_factor = 0.20f; // Erode if dt <= 0.20 * dt0

    // Create 4x4x4 box mesh (64 elements)
    solver.createStructuredBoxMesh(4, 4, 4, 0.04f, 0.04f, 0.04f, -0.02f, -0.02f, 0.0f, mat, "Free");

    FEMErosionCriteria<float> erosion{};
    erosion.enable_timestep_erosion = true;
    erosion.timestep_erosion_factor = 0.20f;
    solver.setErosionCriteria(erosion);

    // Apply moderate compression (10 m/s) - stress wave travels through without crushing
    for (auto& node : solver.getNodes()) {
        if (node.x[2] >= 0.039f) {
            node.v[2] = -10.0f;
        }
    }

    int initial_elems = solver.getElements().size();
    float dt0 = solver.computeStepSize(0.3f);
    std::cout << "  dt0 = " << dt0 << " s, checking for 200 steps..." << std::endl;

    for (int step = 0; step < 200; ++step) {
        float dt = solver.computeStepSize(0.3f);
        solver.stepWithDt(dt);

        for (const auto& elem : solver.getElements()) {
            assert(!elem.is_eroded && "Element should NOT erode during elastic wave propagation!");
        }
    }

    std::cout << "  [PASS] 0 / " << initial_elems << " elements eroded under elastic stress wave." << std::endl;
}

void test_severe_crush_timestep_erosion() {
    std::cout << "--- Subtest: Severe Element Crushing (Targeted Timestep Erosion) ---" << std::endl;
    FEMSolver3D<float> solver;

    MaterialTable3D mat{};
    mat.density = 7850.0f;
    mat.youngs_modulus = 200.0e9f;
    mat.poissons_ratio = 0.30f;
    mat.yield_stress = 100.0e6f;
    mat.hardening_modulus = 50.0e6f;
    mat.enable_timestep_erosion = true;
    mat.timestep_erosion_factor = 0.55f; // Erode if dt <= 0.55 * dt0

    // Create 2x2x2 mesh (8 elements)
    solver.createStructuredBoxMesh(2, 2, 2, 0.02f, 0.02f, 0.02f, 0.0f, 0.0f, 0.0f, mat, "Free");

    FEMErosionCriteria<float> erosion{};
    erosion.enable_timestep_erosion = true;
    erosion.timestep_erosion_factor = 0.55f;
    solver.setErosionCriteria(erosion);

    // Pin bottom nodes and give severe downward velocity to all upper nodes to crush into the base
    for (auto& node : solver.getNodes()) {
        if (node.x[2] <= 0.0001f) {
            node.is_fixed[0] = true;
            node.is_fixed[1] = true;
            node.is_fixed[2] = true;
        } else {
            node.v[2] = -2000.0f;
        }
    }

    int eroded_count = 0;
    for (int step = 0; step < 500; ++step) {
        float dt = solver.computeStepSize(0.3f);
        solver.stepWithDt(dt);

        eroded_count = 0;
        for (const auto& elem : solver.getElements()) {
            if (elem.is_eroded) eroded_count++;
        }
        if (step % 50 == 0 || eroded_count > 0) {
            std::cout << "  Step " << step << " | dt = " << dt << " s, eroded = " << eroded_count << std::endl;
        }
        if (eroded_count > 0) break;
    }

    std::cout << "  Eroded elements count after severe impact: " << eroded_count << std::endl;
    assert(eroded_count > 0 && "Severely crushed elements should erode under timestep erosion!");
    std::cout << "  [PASS] Timestep erosion successfully caught severely crushed elements." << std::endl;
}

int main() {
    std::cout << "==================================================" << std::endl;
    std::cout << "[TEST] Running test_fem_3d_timestep_erosion..." << std::endl;
    std::cout << "==================================================" << std::endl;

    test_elastic_wave_no_spurious_erosion();
    test_severe_crush_timestep_erosion();

    std::cout << "==================================================" << std::endl;
    std::cout << "[PASS] ALL TIMESTEP EROSION TESTS PASSED!" << std::endl;
    std::cout << "==================================================" << std::endl;
    return 0;
}
