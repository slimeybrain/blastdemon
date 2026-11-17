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

    // Perturb nodes with an hourglass deformation mode (alternate z perturbation + velocity)
    nodes[0].x[2] += 0.05f; nodes[0].v[2] =  5.0f;
    nodes[1].x[2] -= 0.05f; nodes[1].v[2] = -5.0f;
    nodes[2].x[2] += 0.05f; nodes[2].v[2] =  5.0f;
    nodes[3].x[2] -= 0.05f; nodes[3].v[2] = -5.0f;

    std::vector<FEMElement3D<float>> elements(1);
    for (int i = 0; i < 8; ++i) elements[0].node_ids[i] = i;
    elements[0].lsdyna_id = 1;

    MaterialTable3D mat{};
    mat.density = 7850.0f;
    mat.youngs_modulus = 210.0e9f;
    mat.poissons_ratio = 0.30f;

    solver.setNodesAndElements(nodes, elements, mat);
    for (int step = 0; step < 10; ++step) {
        solver.stepWithDt(1.0e-6f);
    }

    const auto& energy = solver.getEnergyTracker();
    const auto& nodes_out = solver.getNodes();
    std::cout << "  Recorded Hourglass Energy E_hg = " << energy.E_hg << " J, Node 0 f_int_z = " << nodes_out[0].f_int[2] << " N" << std::endl;

    if (!std::isfinite(energy.E_hg) || energy.E_hg <= 0.0f) {
        std::cerr << "[FAIL] Expected positive hourglass stabilization work E_hg > 0, got " << energy.E_hg << std::endl;
        return 1;
    }
    if (!(nodes_out[0].f_int[2] > 0.0f && nodes_out[1].f_int[2] < 0.0f)) {
        std::cerr << "[FAIL] Hourglass forces did not oppose Z hourglass perturbation" << std::endl;
        return 1;
    }

    std::cout << "[PASS] test_fem_3d_hourglass PASSED successfully." << std::endl;
    return 0;
}
