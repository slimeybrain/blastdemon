#include "fem_solver_3d.hpp"
#include <iostream>
#include <cassert>
#include <cmath>

using namespace Blast;

int main() {
    std::cout << "[TEST] Running test_fem_3d_taylor_impact..." << std::endl;

    FEMSolver3D<float> solver;

    // Create 2x2x4 rod mesh (16 elements, 45 nodes)
    std::vector<FEMNode3D<float>> nodes;
    int node_count = 0;
    for (int k = 0; k <= 4; ++k) {
        for (int j = 0; j <= 2; ++j) {
            for (int i = 0; i <= 2; ++i) {
                FEMNode3D<float> n{};
                n.x[0] = i * 0.005f;
                n.x[1] = j * 0.005f;
                n.x[2] = k * 0.005f;
                n.v[2] = -200.0f; // Initial impact velocity -200 m/s
                n.lsdyna_id = ++node_count;
                if (k == 0) n.is_fixed[2] = true; // Rigid wall boundary at z=0
                nodes.push_back(n);
            }
        }
    }

    std::vector<FEMElement3D<float>> elements;
    int elem_count = 0;
    for (int k = 0; k < 4; ++k) {
        for (int j = 0; j < 2; ++j) {
            for (int i = 0; i < 2; ++i) {
                FEMElement3D<float> e{};
                int n0 = i + j*3 + k*9;
                int n1 = (i+1) + j*3 + k*9;
                int n2 = (i+1) + (j+1)*3 + k*9;
                int n3 = i + (j+1)*3 + k*9;
                int n4 = i + j*3 + (k+1)*9;
                int n5 = (i+1) + j*3 + (k+1)*9;
                int n6 = (i+1) + (j+1)*3 + (k+1)*9;
                int n7 = i + (j+1)*3 + (k+1)*9;

                e.node_ids[0] = n0; e.node_ids[1] = n1; e.node_ids[2] = n2; e.node_ids[3] = n3;
                e.node_ids[4] = n4; e.node_ids[5] = n5; e.node_ids[6] = n6; e.node_ids[7] = n7;
                e.lsdyna_id = ++elem_count;
                elements.push_back(e);
            }
        }
    }

    MaterialTable3D mat{};
    mat.density = 8960.0f; // Copper density
    mat.youngs_modulus = 117.0e9f;
    mat.poissons_ratio = 0.35f;
    mat.jc_A = 400.0e6f;
    mat.jc_B = 100.0e6f;
    mat.jc_n = 1.0f;
    mat.jc_C = 0.025f;
    mat.jc_m = 1.09f;
    mat.T_melt = 1356.0f; // Copper melt temperature
    mat.T_room = 293.0f;
    mat.Cp = 385.0f;

    FEMErosionCriteria<float> erosion{};
    erosion.enable_stress_erosion = false;
    erosion.enable_strain_erosion = false;
    solver.setErosionCriteria(erosion);

    solver.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoViscous);
    solver.setHourglassCoeff(0.03f);
    solver.setNodesAndElements(nodes, elements, mat);

    const auto& energy_init = solver.getEnergyTracker();
    std::cout << "  Initial E_0 = " << energy_init.E_0 << " J, E_kin = " << energy_init.E_kin << " J" << std::endl;

    // Run 100 explicit time steps
    for (int step = 0; step < 100; ++step) {
        float dt = solver.computeStepSize(0.4f);
        solver.stepWithDt(dt);
        if (step < 5 || step % 20 == 0) {
            const auto& e = solver.getEnergyTracker();
            std::cout << "  [Step " << step << "] dt=" << dt << " s, E_kin=" << e.E_kin << " J, E_int=" << e.E_int << " J, Ratio=" << e.getEnergyRatio() << std::endl;
        }
    }

    const auto& energy = solver.getEnergyTracker();
    std::cout << "  Taylor impact completed 100 steps." << std::endl;
    std::cout << "  E_kin = " << energy.E_kin << " J, E_int = " << energy.E_int << " J, Ratio = " << energy.getEnergyRatio() << std::endl;
    assert(energy.getEnergyRatio() > 0.35f && energy.getEnergyRatio() < 5.00f);

    std::cout << "[PASS] test_fem_3d_taylor_impact PASSED successfully." << std::endl;
    return 0;
}
