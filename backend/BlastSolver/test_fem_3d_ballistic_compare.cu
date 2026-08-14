#include "fem_solver_3d.hpp"
#include "fem_solver_3d_cuda.hpp"
#include <iostream>
#include <vector>
#include <cmath>
#include <cassert>

using namespace Blast;

int main() {
    std::cout << "==========================================================================" << std::endl;
    std::cout << "[COMPARE] Ballistic Impact CPU vs GPU..." << std::endl;
    std::cout << "==========================================================================" << std::endl;

    FEMSolver3D<float> cpu_solver;
    FEMSolver3DCUDA<float> gpu_solver;

    MaterialTable3D target_mat{};
    target_mat.density = 7850.0f;
    target_mat.youngs_modulus = 210.0e9f;
    target_mat.poissons_ratio = 0.30f;
    target_mat.yield_stress = 792.0e6f;
    target_mat.hardening_modulus = 510.0e9f;
    target_mat.jc_A = 792.0e6f;
    target_mat.jc_B = 510.0e6f;
    target_mat.jc_n = 0.26f;
    target_mat.jc_C = 0.014f;
    target_mat.jc_m = 1.03f;
    target_mat.T_melt = 1793.0f;
    target_mat.T_room = 293.0f;
    target_mat.Cp = 477.0f;
    target_mat.mg_gamma0 = 1.81f;
    target_mat.mg_c0 = 4570.0f;
    target_mat.mg_s = 1.49f;
    target_mat.bulk_viscosity_b1 = 0.06f;
    target_mat.bulk_viscosity_b2 = 1.20f;
    target_mat.failure_strain = 0.40f;
    target_mat.tensile_failure_stress = 1200.0e6f;

    MaterialTable3D proj_mat{};
    proj_mat.density = 17800.0f;
    proj_mat.youngs_modulus = 360.0e9f;
    proj_mat.poissons_ratio = 0.28f;
    proj_mat.yield_stress = 1500.0e6f;
    proj_mat.hardening_modulus = 800.0e6f;
    proj_mat.jc_A = 1500.0e6f;
    proj_mat.jc_B = 800.0e6f;
    proj_mat.jc_n = 0.12f;
    proj_mat.jc_C = 0.016f;
    proj_mat.jc_m = 1.00f;
    proj_mat.T_melt = 3695.0f;
    proj_mat.T_room = 293.0f;
    proj_mat.Cp = 134.0f;
    proj_mat.mg_gamma0 = 1.54f;
    proj_mat.mg_c0 = 4030.0f;
    proj_mat.mg_s = 1.23f;

    // CPU setup
    cpu_solver.createStructuredBoxMesh(8, 8, 4, 0.04f, 0.04f, 0.02f, -0.02f, -0.02f, 0.0f, target_mat, "Fixed Base");
    cpu_solver.addStructuredCylinderMesh(3, 4, 0.008f, 0.02f, 0.0f, 0.0f, 0.025f, proj_mat, 0.0f, 0.0f, -800.0f, 0.0f, "Free");
    cpu_solver.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoViscous);
    cpu_solver.setHourglassCoeff(0.10f);
    cpu_solver.setContactPenaltyScale(1.5f);
    cpu_solver.setContactDamping(0.20f);
    cpu_solver.setFrictionCoefficients(0.3f, 0.2f);

    FEMErosionCriteria<float> erosion{};
    erosion.enable_strain_erosion = true;
    erosion.failure_strain = 0.45f;
    cpu_solver.setErosionCriteria(erosion);

    // GPU setup
    gpu_solver.createStructuredBoxMesh(8, 8, 4, 0.04f, 0.04f, 0.02f, -0.02f, -0.02f, 0.0f, target_mat, "Fixed Base");
    gpu_solver.addStructuredCylinderMesh(3, 4, 0.008f, 0.02f, 0.0f, 0.0f, 0.025f, proj_mat, 0.0f, 0.0f, -800.0f, 0.0f, "Free");
    gpu_solver.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoViscous);
    gpu_solver.setHourglassCoeff(0.10f);
    gpu_solver.setContactPenaltyScale(1.5f);
    gpu_solver.setContactDamping(0.20f);
    gpu_solver.setFrictionCoefficients(0.3f, 0.2f);
    gpu_solver.setErosionCriteria(erosion);

    for (int step = 1; step <= 250; ++step) {
        float dt = cpu_solver.computeStepSize(0.3f);
        cpu_solver.stepWithDt(dt);
        gpu_solver.stepWithDt(dt);

        if ((step >= 60 && step <= 85) || step % 25 == 0) {
            float cpu_v = cpu_solver.getMaxVelocity();
            float gpu_v = gpu_solver.getMaxVelocity();
            float cpu_ep = cpu_solver.getMaxPlasticStrain();
            float gpu_ep = gpu_solver.getMaxPlasticStrain();
            float cpu_vm = cpu_solver.getMaxVonMisesStress();
            float gpu_vm = gpu_solver.getMaxVonMisesStress();

            const auto& cpu_nodes = cpu_solver.getNodes();
            const auto& gpu_nodes = gpu_solver.getNodes();
            const auto& cpu_elems = cpu_solver.getElements();
            const auto& gpu_elems = gpu_solver.getElements();

            float max_x_diff = 0.0f, max_v_diff = 0.0f, max_fc_diff = 0.0f;
            int max_fc_node = -1;
            for (size_t i = 0; i < cpu_nodes.size(); ++i) {
                for (int c = 0; c < 3; ++c) {
                    float dx = std::fabs(cpu_nodes[i].x[c] - gpu_nodes[i].x[c]);
                    float dv = std::fabs(cpu_nodes[i].v[c] - gpu_nodes[i].v[c]);
                    float dfc = std::fabs(cpu_nodes[i].f_contact[c] - gpu_nodes[i].f_contact[c]);
                    if (dx > max_x_diff) max_x_diff = dx;
                    if (dv > max_v_diff) max_v_diff = dv;
                    if (dfc > max_fc_diff) { max_fc_diff = dfc; max_fc_node = i; }
                }
            }

            std::cout << "[Step " << step << "] PosDiff: " << max_x_diff << " m | VelDiff: " << max_v_diff << " m/s | ContactFDiff: " << max_fc_diff << " N (node " << max_fc_node << ")" << std::endl;
            std::cout << "  CPU: Vmax=" << cpu_v << " EpMax=" << cpu_ep << " VM=" << (cpu_vm/1e6f) << " MPa" << std::endl;
            if (max_fc_node >= 0) {
                std::cout << "    CPU Node " << max_fc_node << " pos=(" << cpu_nodes[max_fc_node].x[0] << "," << cpu_nodes[max_fc_node].x[1] << "," << cpu_nodes[max_fc_node].x[2]
                          << ") v=(" << cpu_nodes[max_fc_node].v[0] << "," << cpu_nodes[max_fc_node].v[1] << "," << cpu_nodes[max_fc_node].v[2]
                          << ") f_c=(" << cpu_nodes[max_fc_node].f_contact[0] << "," << cpu_nodes[max_fc_node].f_contact[1] << "," << cpu_nodes[max_fc_node].f_contact[2] << ")" << std::endl;
                std::cout << "    GPU Node " << max_fc_node << " pos=(" << gpu_nodes[max_fc_node].x[0] << "," << gpu_nodes[max_fc_node].x[1] << "," << gpu_nodes[max_fc_node].x[2]
                          << ") v=(" << gpu_nodes[max_fc_node].v[0] << "," << gpu_nodes[max_fc_node].v[1] << "," << gpu_nodes[max_fc_node].v[2]
                          << ") f_c=(" << gpu_nodes[max_fc_node].f_contact[0] << "," << gpu_nodes[max_fc_node].f_contact[1] << "," << gpu_nodes[max_fc_node].f_contact[2] << ")" << std::endl;
            }
            std::cout << "  GPU: Vmax=" << gpu_v << " EpMax=" << gpu_ep << " VM=" << (gpu_vm/1e6f) << " MPa" << std::endl;
        }
    }

    return 0;
}
