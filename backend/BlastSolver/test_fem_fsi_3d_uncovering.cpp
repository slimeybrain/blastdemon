#include "fem_solver_3d.hpp"
#include "fem_fsi_coupler_3d.hpp"
#include "cfd_solver_3d.hpp"
#include <iostream>
#include <cassert>

using namespace Blast;

int main() {
    std::cout << "[TEST] Running test_fem_fsi_3d_uncovering..." << std::endl;

    // Create a 16x16x16 CFD domain
    CFDSolver3DImpl<float, false> cfd_solver(16, 16, 16, 0.01, 0.0, 0.0, 0.0);

    // Create 1 Hex8 element structure inside CFD domain
    FEMSolver3D<float> fem_solver;
    std::vector<FEMNode3D<float>> nodes(8);
    static const float coords[8][3] = {
        {0.05f, 0.05f, 0.05f}, {0.07f, 0.05f, 0.05f}, {0.07f, 0.07f, 0.05f}, {0.05f, 0.07f, 0.05f},
        {0.05f, 0.05f, 0.07f}, {0.07f, 0.05f, 0.07f}, {0.07f, 0.07f, 0.07f}, {0.05f, 0.07f, 0.07f}
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

    MaterialTable3D mat{};
    mat.density = 7850.0f;
    mat.youngs_modulus = 210.0e9f;
    mat.poissons_ratio = 0.30f;

    fem_solver.setNodesAndElements(nodes, elements, mat);

    FEMFSICoupler3D<float> coupler;
    coupler.attachSolvers(&cfd_solver, &fem_solver);

    coupler.stepWithDt(1.0e-6f);

    std::cout << "  FSI Step completed. Step count = " << coupler.getStepCount() << std::endl;
    assert(coupler.getStepCount() == 1);

    std::cout << "[PASS] test_fem_fsi_3d_uncovering PASSED successfully." << std::endl;
    return 0;
}
