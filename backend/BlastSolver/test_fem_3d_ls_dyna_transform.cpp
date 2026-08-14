#include "fem_solver_3d.hpp"
#include "ls_dyna_reader_3d.hpp"
#include <iostream>
#include <fstream>
#include <cassert>
#include <cmath>

using namespace Blast;

int main() {
    std::cout << "[TEST] Running test_fem_3d_ls_dyna_transform..." << std::endl;

    // Create a temporary keyword file for testing
    std::string test_k_file = "temp_test_transform_model.k";
    std::ofstream out(test_k_file);
    out << "$ Test LS-DYNA Keyword File for Positioning and Initial Velocity\n";
    out << "*KEYWORD\n";
    out << "*NODE\n";
    out << "   1001, 0.0, 0.0, 0.0\n";
    out << "   1002, 0.1, 0.0, 0.0\n";
    out << "   1003, 0.1, 0.1, 0.0\n";
    out << "   1004, 0.0, 0.1, 0.0\n";
    out << "   1005, 0.0, 0.0, 0.1\n";
    out << "   1006, 0.1, 0.0, 0.1\n";
    out << "   1007, 0.1, 0.1, 0.1\n";
    out << "   1008, 0.0, 0.1, 0.1\n";
    out << "*ELEMENT_SOLID\n";
    out << "   5001, 1, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008\n";
    out << "*MAT_ELASTIC\n";
    out << "$     MID        RHO          E         PR\n";
    out << "        1     7850.0   210.0E9       0.30\n";
    out << "*END\n";
    out.close();

    // 1. Test parsing with positioning, velocity, and scaling
    LSDynaReader3D<float> reader;
    std::vector<FEMNode3D<float>> nodes;
    std::vector<FEMElement3D<float>> elements;
    MaterialTable3D default_mat;
    std::vector<MaterialTable3D> mat_list;

    bool ok = reader.parseFile(test_k_file, nodes, elements, default_mat, mat_list);
    assert(ok);
    assert(nodes.size() == 8);
    assert(elements.size() == 1);

    float pos_x = 0.5f, pos_y = 1.0f, pos_z = 2.0f;
    float vel_x = 250.0f, vel_y = -50.0f, vel_z = 10.0f;
    float scale_x = 1.0f, scale_y = 1.0f, scale_z = 1.0f;
    std::string bc_cond = "Fixed Base";

    float min_z = 1e30f;
    for (const auto& nd : nodes) {
        float z_val = nd.x[2] * scale_z + pos_z;
        if (z_val < min_z) min_z = z_val;
    }

    for (auto& nd : nodes) {
        nd.x[0] = nd.x[0] * scale_x + pos_x;
        nd.x[1] = nd.x[1] * scale_y + pos_y;
        nd.x[2] = nd.x[2] * scale_z + pos_z;
        nd.x0[0] = nd.x[0];
        nd.x0[1] = nd.x[1];
        nd.x0[2] = nd.x[2];

        nd.v[0] += vel_x;
        nd.v[1] += vel_y;
        nd.v[2] += vel_z;

        if (std::abs(nd.x[2] - min_z) < 1e-4f) {
            nd.is_fixed[0] = true;
            nd.is_fixed[1] = true;
            nd.is_fixed[2] = true;
        }
    }

    // Verify node 1001 (originally 0,0,0) is now at (0.5, 1.0, 2.0)
    assert(std::abs(nodes[0].x[0] - 0.5f) < 1e-5f);
    assert(std::abs(nodes[0].x[1] - 1.0f) < 1e-5f);
    assert(std::abs(nodes[0].x[2] - 2.0f) < 1e-5f);

    // Verify node 1007 (originally 0.1, 0.1, 0.1) is now at (0.6, 1.1, 2.1)
    assert(std::abs(nodes[6].x[0] - 0.6f) < 1e-5f);
    assert(std::abs(nodes[6].x[1] - 1.1f) < 1e-5f);
    assert(std::abs(nodes[6].x[2] - 2.1f) < 1e-5f);

    // Verify velocities
    for (const auto& nd : nodes) {
        assert(std::abs(nd.v[0] - 250.0f) < 1e-5f);
        assert(std::abs(nd.v[1] - (-50.0f)) < 1e-5f);
        assert(std::abs(nd.v[2] - 10.0f) < 1e-5f);
    }

    // Verify base nodes (z = 2.0) are fixed
    int fixed_count = 0;
    for (const auto& nd : nodes) {
        if (nd.is_fixed[0] && nd.is_fixed[1] && nd.is_fixed[2]) {
            fixed_count++;
            assert(std::abs(nd.x[2] - 2.0f) < 1e-5f);
        }
    }
    assert(fixed_count == 4);

    // 2. Initialize FEM solver and append transformed nodes
    FEMSolver3D<float> solver;
    solver.appendNodesAndElements(nodes, elements, default_mat);

    assert(solver.getNodes().size() == 8);
    assert(solver.getElements().size() == 1);

    // Step the solver forward in time
    for (int step = 0; step < 10; ++step) {
        solver.step(0.3f);
    }

    const auto& solver_nodes = solver.getNodes();
    // Verify that top nodes moved due to initial velocity
    assert(solver_nodes[4].x[0] > 0.5f);
    // Verify that base nodes stayed fixed at x = 0.5, y = 1.0, z = 2.0
    assert(std::abs(solver_nodes[0].x[0] - 0.5f) < 1e-5f);
    assert(std::abs(solver_nodes[0].x[1] - 1.0f) < 1e-5f);
    assert(std::abs(solver_nodes[0].x[2] - 2.0f) < 1e-5f);

    std::remove(test_k_file.c_str());

    std::cout << "[PASS] test_fem_3d_ls_dyna_transform PASSED successfully." << std::endl;
    return 0;
}
