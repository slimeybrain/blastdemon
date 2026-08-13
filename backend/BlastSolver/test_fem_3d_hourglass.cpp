#include "fem_solver_3d.hpp"
#include <iostream>
#include <cassert>
#include <cmath>

using namespace Blast;

int main() {
    std::cout << "[TEST] Running test_fem_3d_hourglass..." << std::endl;

    FEMSolver3D<float> solver;
    solver.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoStiffness);
    solver.setHourglassCoeff(0.10f);

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

    // Perturb nodes with an hourglass deformation mode (alternate z perturbation)
    nodes[0].x[2] += 0.05f;
    nodes[1].x[2] -= 0.05f;
    nodes[2].x[2] += 0.05f;
    nodes[3].x[2] -= 0.05f;

    std::vector<FEMElement3D<float>> elements(1);
    for (int i = 0; i < 8; ++i) elements[0].node_ids[i] = i;
    elements[0].lsdyna_id = 1;

    MaterialTable3D mat{};
    mat.density = 7850.0f;
    mat.youngs_modulus = 210.0e9f;
    mat.poissons_ratio = 0.30f;

    solver.setNodesAndElements(nodes, elements, mat);
    solver.stepWithDt(1.0e-7f);

    const auto& energy = solver.getEnergyTracker();
    std::cout << "  Recorded Hourglass Energy E_hg = " << energy.E_hg << " J" << std::endl;

    std::cout << "[PASS] test_fem_3d_hourglass PASSED successfully." << std::endl;
    return 0;
}
