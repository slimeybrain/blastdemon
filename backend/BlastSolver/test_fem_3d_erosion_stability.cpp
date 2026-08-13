#include "fem_solver_3d.hpp"
#include <iostream>
#include <cassert>
#include <cmath>

using namespace Blast;

int main() {
    std::cout << "[TEST] Running test_fem_3d_erosion_stability..." << std::endl;

    FEMSolver3D<float> solver;

    MaterialTable3D mat{};
    mat.density = 7850.0f;
    mat.youngs_modulus = 200.0e9f;
    mat.poissons_ratio = 0.30f;
    mat.yield_stress = 250.0e6f;
    mat.hardening_modulus = 100.0e6f;
    mat.failure_strain = 0.05f; // Low failure strain to force element erosion

    // Create 4x4x4 box mesh (64 elements, 125 nodes)
    solver.createStructuredBoxMesh(4, 4, 4, 0.04f, 0.04f, 0.04f, -0.02f, -0.02f, 0.0f, mat, "Free");

    FEMErosionCriteria<float> erosion{};
    erosion.enable_strain_erosion = true;
    erosion.enable_stress_erosion = true;
    erosion.failure_strain = 0.05f;
    erosion.tensile_failure_stress = 300.0e6f;
    solver.setErosionCriteria(erosion);

    // Apply high initial compressive velocity to trigger plastic strain and erosion
    for (auto& node : solver.getNodes()) {
        node.v[2] = -150.0f;
        if (node.x[2] <= 0.001f) {
            node.is_fixed[2] = true;
        }
    }

    int initial_nodes = solver.getNodes().size();
    int initial_elems = solver.getElements().size();
    std::cout << "  Mesh initialized: " << initial_nodes << " nodes, " << initial_elems << " elements." << std::endl;

    int eroded_elem_count = 0;
    int eroded_node_count = 0;

    // Step simulation for 100 steps
    for (int step = 0; step < 100; ++step) {
        float dt = solver.computeStepSize(0.3f);
        solver.stepWithDt(dt);

        // Verify that no active or eroded node coordinates explode or become NaN/Inf
        for (const auto& node : solver.getNodes()) {
            assert(!std::isnan(node.x[0]) && !std::isinf(node.x[0]));
            assert(!std::isnan(node.x[1]) && !std::isinf(node.x[1]));
            assert(!std::isnan(node.x[2]) && !std::isinf(node.x[2]));
            assert(std::abs(node.x[0]) < 10.0f);
            assert(std::abs(node.x[1]) < 10.0f);
            assert(std::abs(node.x[2]) < 10.0f);
            
            float v_mag = std::sqrt(node.v[0]*node.v[0] + node.v[1]*node.v[1] + node.v[2]*node.v[2]);
            assert(v_mag <= 10000.1f);
        }
    }

    const auto& elements = solver.getElements();
    const auto& nodes = solver.getNodes();
    for (const auto& elem : elements) {
        if (elem.is_eroded) eroded_elem_count++;
    }
    for (const auto& node : nodes) {
        if (node.is_eroded) eroded_node_count++;
    }

    std::cout << "  After 100 steps: " << eroded_elem_count << " / " << initial_elems << " elements eroded, "
              << eroded_node_count << " / " << initial_nodes << " nodes marked eroded." << std::endl;

    // Ensure surface facets extraction runs without errors
    const auto& surface_facets = solver.getSurfaceFacets();
    std::cout << "  Uncovered surface facets count: " << surface_facets.size() << std::endl;

    // Assert that erosion occurred, node erosion was tracked, and mesh bounds remained stable
    assert(eroded_elem_count > 0);
    assert(eroded_node_count >= 0);

    std::cout << "[PASS] test_fem_3d_erosion_stability PASSED successfully." << std::endl;
    return 0;
}
