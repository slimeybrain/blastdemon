#include "fem_solver_3d.hpp"
#include <iostream>
#include <cassert>
#include <cmath>

using namespace Blast;

int main() {
    std::cout << "[TEST] Running test_fem_3d_element_math..." << std::endl;

    FEMSolver3D<float> solver;
    
    // Create single unit cube Hex8 element (1m x 1m x 1m)
    std::vector<FEMNode3D<float>> nodes(8);
    static const float coords[8][3] = {
        {0.0f, 0.0f, 0.0f}, {1.0f, 0.0f, 0.0f}, {1.0f, 1.0f, 0.0f}, {0.0f, 1.0f, 0.0f},
        {0.0f, 0.0f, 1.0f}, {1.0f, 0.0f, 1.0f}, {1.0f, 1.0f, 1.0f}, {0.0f, 1.0f, 1.0f}
    };
    for (int i = 0; i < 8; ++i) {
        nodes[i].x[0] = coords[i][0];
        nodes[i].x[1] = coords[i][1];
        nodes[i].x[2] = coords[i][2];
        nodes[i].lsdyna_id = i + 1;
    }

    std::vector<FEMElement3D<float>> elements(1);
    for (int i = 0; i < 8; ++i) elements[0].node_ids[i] = i;
    elements[0].lsdyna_id = 1;
    elements[0].mat_id = 0;

    MaterialTable3D mat{};
    mat.density = 7850.0f;
    mat.youngs_modulus = 210.0e9f;
    mat.poissons_ratio = 0.30f;

    solver.setNodesAndElements(nodes, elements, mat);

    const auto& elems_out = solver.getElements();
    assert(elems_out.size() == 1);
    float V0 = elems_out[0].V0;
    std::cout << "  Computed Hex8 V0 = " << V0 << " m^3 (Expected: 1.0 m^3)" << std::endl;
    assert(std::fabs(V0 - 1.0f) < 1.0e-4f);

    // Single step
    solver.stepWithDt(1.0e-7f);
    assert(solver.getStepCount() == 1);

    // Test Cylinder Mesh Generation Jacobians & Facet Normals
    FEMSolver3D<float> cyl_solver;
    cyl_solver.addStructuredCylinderMesh(4, 10, 0.01f, 0.05f, 0.0f, 0.0f, 0.0f, mat, 0.0f, 0.0f, 0.0f);
    const auto& cyl_elems = cyl_solver.getElements();
    const auto& cyl_nodes = cyl_solver.getNodes();
    const auto& cyl_facets = cyl_solver.getSurfaceFacets();

    std::cout << "  Cylinder mesh generated: " << cyl_nodes.size() << " nodes, " << cyl_elems.size() << " elements, " << cyl_facets.size() << " surface facets." << std::endl;

    int invalid_elems = 0;
    for (size_t e = 0; e < cyl_elems.size(); ++e) {
        if (cyl_elems[e].V0 <= 0.0f) {
            std::cout << "  [ERROR] Elem " << e << " has non-positive volume V0 = " << cyl_elems[e].V0 << std::endl;
            invalid_elems++;
        }
    }
    std::cout << "  Invalid cylinder elements count = " << invalid_elems << std::endl;
    assert(invalid_elems == 0);

    std::cout << "[PASS] test_fem_3d_element_math PASSED successfully." << std::endl;
    return 0;
}
