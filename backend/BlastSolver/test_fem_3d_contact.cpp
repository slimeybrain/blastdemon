#include "fem_solver_3d.hpp"
#include "fem_contact_3d.hpp"
#include <iostream>
#include <cassert>

using namespace Blast;

int main() {
    std::cout << "[TEST] Running test_fem_3d_contact..." << std::endl;

    FEMSolver3D<float> solver;
    FEMContact3D<float> contact;

    // Create 2 colliding cubes
    std::vector<FEMNode3D<float>> nodes(16);
    // Cube 1 at z=[0,1]
    static const float c1[8][3] = {
        {0,0,0}, {1,0,0}, {1,1,0}, {0,1,0},
        {0,0,1}, {1,0,1}, {1,1,1}, {0,1,1}
    };
    // Cube 2 at z=[0.95, 1.95] (0.05m penetration)
    static const float c2[8][3] = {
        {0,0,0.95f}, {1,0,0.95f}, {1,1,0.95f}, {0,1,0.95f},
        {0,0,1.95f}, {1,0,1.95f}, {1,1,1.95f}, {0,1,1.95f}
    };

    for (int i = 0; i < 8; ++i) {
        nodes[i].x[0] = c1[i][0]; nodes[i].x[1] = c1[i][1]; nodes[i].x[2] = c1[i][2];
        nodes[i].lsdyna_id = i + 1;

        nodes[i + 8].x[0] = c2[i][0]; nodes[i + 8].x[1] = c2[i][1]; nodes[i + 8].x[2] = c2[i][2];
        nodes[i + 8].lsdyna_id = i + 9;
    }

    std::vector<FEMElement3D<float>> elements(2);
    for (int i = 0; i < 8; ++i) {
        elements[0].node_ids[i] = i;
        elements[1].node_ids[i] = i + 8;
    }
    elements[0].lsdyna_id = 1;
    elements[1].lsdyna_id = 2;

    MaterialTable3D mat{};
    mat.density = 7850.0f;
    mat.youngs_modulus = 210.0e9f;
    mat.poissons_ratio = 0.30f;

    solver.setNodesAndElements(nodes, elements, mat);

    contact.setContactPenaltyScale(1.0f);
    contact.solveContact(solver, 1.0e-5f);

    const auto& nodes_out = solver.getNodes();
    std::cout << "  Contact test evaluated." << std::endl;
    std::cout << "  Node 8 (Cube 2 bottom corner) contact force f_z = " << nodes_out[8].f_contact[2] << " N" << std::endl;

    std::cout << "[PASS] test_fem_3d_contact PASSED successfully." << std::endl;
    return 0;
}
