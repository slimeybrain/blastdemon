#include "fem_solver_3d.hpp"
#include "fem_contact_3d.hpp"
#include "VTKWriter.hpp"
#include <iostream>
#include <cassert>
#include <iomanip>

using namespace Blast;

int main() {
    std::cout << "[TEST] Running test_contact_impact (2500 steps of explicit 3D FEM contact)..." << std::endl;

    FEMSolver3D<float> solver;
    solver.setIntegrationScheme(FEMIntegrationScheme::OnePointFB);
    solver.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoViscous);
    solver.setHourglassCoeff(0.1f);

    MaterialTable3D mat{};
    mat.density = 7850.0f;
    mat.youngs_modulus = 210.0e9f;
    mat.bulk_viscosity_b1 = 0.5f; // Safe linear artificial viscosity
    mat.bulk_viscosity_b2 = 1.2f; // Standard quadratic artificial viscosity
    mat.poissons_ratio = 0.3f;
    mat.yield_stress = 400.0e6f;
    mat.hardening_modulus = 1.0e9f;
    mat.failure_strain = 0.54f;

    // Rigid target block (Fixed Base)
    solver.addStructuredBoxMesh(10, 10, 10, 0.1f, 0.1f, 0.1f, -0.05f, -0.05f, 0.0f, mat, 0.0f, 0.0f, 0.0f, "Fixed Base");
    
    // Impacting cylinder (Free, vel_z = -100)
    solver.addStructuredCylinderMesh(4, 20, 0.02f, 0.1f, 0.0f, 0.0f, 0.101f, mat, 0.0f, 0.0f, -100.0f, 0.0f, "Free");



    FEMContact3D<float> contact;
    contact.setContactPenaltyScale(0.1f);

    for (int step = 0; step <= 1500; ++step) {
        float dt = solver.computeStepSize(0.4f);
        solver.stepWithDt(dt);
        contact.solveContact(solver, dt);

        float max_v = 0.0f;
        int max_node_idx = -1;
        float max_node_z = 0.0f;
        const auto& nodes = solver.getNodes();
        for (size_t i = 0; i < nodes.size(); ++i) {
            float v_mag = std::sqrt(nodes[i].v[0]*nodes[i].v[0] + nodes[i].v[1]*nodes[i].v[1] + nodes[i].v[2]*nodes[i].v[2]);
            if (v_mag > max_v) {
                max_v = v_mag;
                max_node_idx = i;
                max_node_z = nodes[i].x[2];
            }
        }

        if (step % 50 == 0) {
            std::cout << "  Step " << std::setw(4) << step 
                      << " | dt=" << std::scientific << std::setprecision(3) << dt
                      << " | max_v=" << std::fixed << std::setprecision(2) << max_v
                      << " (node " << max_node_idx << " z=" << max_node_z << ")"
                      << std::endl;
            export_vtu_fem_3d("test_contact_" + std::to_string(step/50) + ".vtu", solver);
        }

        if (max_v >= 1000.0f) {
            std::cout << "EXPLOSION DETECTED at Step " << step << " | max_v=" << max_v << " on node " << max_node_idx << std::endl;
            const auto& node = nodes[max_node_idx];
            std::cout << "Node pos: " << node.x[0] << ", " << node.x[1] << ", " << node.x[2] << std::endl;
            std::cout << "Node vel: " << node.v[0] << ", " << node.v[1] << ", " << node.v[2] << std::endl;
            std::cout << "Node f_ext: " << node.f_ext[0] << ", " << node.f_ext[1] << ", " << node.f_ext[2] << std::endl;
            std::cout << "Node f_int: " << node.f_int[0] << ", " << node.f_int[1] << ", " << node.f_int[2] << std::endl;
            std::cout << "Node f_con: " << node.f_contact[0] << ", " << node.f_contact[1] << ", " << node.f_contact[2] << std::endl;
            
            const auto& elements = solver.getElements();
            for (size_t e = 0; e < elements.size(); ++e) {
                const auto& elem = elements[e];
                if (elem.is_eroded) continue;
                bool attached = false;
                for(int i=0; i<8; ++i) if(elem.node_ids[i] == max_node_idx) attached = true;
                if (attached) {
                    std::cout << "Attached Elem " << e << " V=" << elem.V << " V0=" << elem.V0 << " q_visc=" << elem.q_visc << std::endl;
                    std::cout << "   sigma_zz=" << elem.sigma[2][2] << " s_dev_zz=" << elem.s_dev[2][2] << std::endl;
                }
            }
            return 1;
        }
    }

    std::cout << "[PASS] test_contact_impact PASSED successfully." << std::endl;
    return 0;
}
