#include "fem_solver_3d.hpp"
#include "fem_solver_3d_cuda.hpp"
#include <iostream>
#include <cassert>
#include <cmath>

using namespace Blast;

int main() {
    std::cout << "[TEST] Running test_fem_3d_precision_parity..." << std::endl;

    // Single Precision CPU
    FEMSolver3D<float> solver_float;
    // Double Precision CPU
    FEMSolver3D<double> solver_double;

    std::vector<FEMNode3D<float>> nodes_f(8);
    std::vector<FEMNode3D<double>> nodes_d(8);
    static const double coords[8][3] = {
        {0,0,0}, {1,0,0}, {1,1,0}, {0,1,0},
        {0,0,1}, {1,0,1}, {1,1,1}, {0,1,1}
    };
    for (int i = 0; i < 8; ++i) {
        for (int c = 0; c < 3; ++c) {
            nodes_f[i].x[c] = static_cast<float>(coords[i][c]);
            nodes_d[i].x[c] = coords[i][c];
        }
        nodes_f[i].lsdyna_id = i + 1;
        nodes_d[i].lsdyna_id = i + 1;
    }

    std::vector<FEMElement3D<float>> elems_f(1);
    std::vector<FEMElement3D<double>> elems_d(1);
    for (int i = 0; i < 8; ++i) {
        elems_f[0].node_ids[i] = i;
        elems_d[0].node_ids[i] = i;
    }

    MaterialTable3D mat{};
    mat.density = 7850.0f;
    mat.youngs_modulus = 210.0e9f;
    mat.poissons_ratio = 0.30f;

    solver_float.setNodesAndElements(nodes_f, elems_f, mat);
    solver_double.setNodesAndElements(nodes_d, elems_d, mat);

    solver_float.stepWithDt(1.0e-7f);
    solver_double.stepWithDt(1.0e-7);

    float V_f = solver_float.getElements()[0].V;
    double V_d = solver_double.getElements()[0].V;

    std::cout << "  Single Precision Hex8 Volume = " << V_f << " m^3" << std::endl;
    std::cout << "  Double Precision Hex8 Volume = " << V_d << " m^3" << std::endl;
    assert(std::fabs(V_f - static_cast<float>(V_d)) < 1.0e-5f);

    std::cout << "[PASS] test_fem_3d_precision_parity PASSED successfully." << std::endl;
    return 0;
}
