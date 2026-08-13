#include "fem_solver_3d.hpp"
#include "fem_contact_3d.hpp"
#include <iostream>
#include <cassert>
#include <iomanip>

using namespace Blast;

int main() {
    std::cout << "[TEST] Running test_fem_3d_sliding_contact..." << std::endl;

    FEMSolver3D<float> solver;
    solver.setIntegrationScheme(FEMIntegrationScheme::OnePointFB);

    MaterialTable3D mat{};
    mat.density = 7850.0f;
    mat.youngs_modulus = 210.0e9f;
    mat.poissons_ratio = 0.3f;
    mat.yield_stress = 400.0e6f;

    // Master plate: 10 x 2 x 1 elements along X (length 0.5m, width 0.1m, height 0.02m)
    // Element edges occur every 0.05m along X (at x = 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45)
    solver.addStructuredBoxMesh(10, 2, 1, 0.5f, 0.1f, 0.02f, 0.0f, 0.0f, 0.0f, mat, 0.0f, 0.0f, 0.0f, "Fixed");

    // Slave slider: 1 x 1 x 1 element at X=[0.02, 0.06], Y=[0.03, 0.07], Z=[0.020, 0.040]
    // Flush contact with top surface of master plate (z = 0.020m)
    // Tangential sliding velocity: v_x = +20 m/s (frictionless)
    solver.addStructuredBoxMesh(1, 1, 1, 0.04f, 0.04f, 0.02f, 0.02f, 0.03f, 0.020f, mat, 20.0f, 0.0f, 0.0f, "Free");

    FEMContact3D<float> contact;
    contact.setContactPenaltyScale(0.1f);
    contact.setContactDamping(0.1f);
    contact.setFrictionCoefficients(0.0f, 0.0f); // Pure frictionless sliding

    float initial_x = solver.getNodes()[solver.getNodes().size() - 8].x[0];
    std::cout << "  Slave block initial X position: " << initial_x << " m, initial v_x = 20.0 m/s" << std::endl;

    int edge_crossings = 0;
    float last_x = initial_x;

    for (int step = 1; step <= 8000; ++step) {
        float dt = solver.computeStepSize(0.3f);
        solver.stepWithDt(dt);
        contact.solveContact(solver, dt);

        const auto& nodes = solver.getNodes();
        // Track position and velocity of slave block nodes (last 8 nodes)
        float avg_x = 0.0f;
        float avg_vx = 0.0f;
        int slave_start = static_cast<int>(nodes.size()) - 8;
        for (int i = slave_start; i < static_cast<int>(nodes.size()); ++i) {
            avg_x += nodes[i].x[0];
            avg_vx += nodes[i].v[0];
        }
        avg_x /= 8.0f;
        avg_vx /= 8.0f;



        // Check element boundary crossings (every 0.05m along X)
        int prev_elem = static_cast<int>(last_x / 0.05f);
        int curr_elem = static_cast<int>(avg_x / 0.05f);
        if (curr_elem > prev_elem) {
            edge_crossings++;
            std::cout << "  [PASS] Slider crossed element boundary edge #" << edge_crossings 
                      << " at step " << step
                      << " to X=" << std::fixed << std::setprecision(4) << avg_x 
                      << " m (v_x=" << avg_vx << " m/s)" << std::endl;
        }
        last_x = avg_x;

        if (step % 1000 == 0) {
            std::cout << "  Step " << std::setw(4) << step 
                      << " | t=" << std::scientific << std::setprecision(3) << solver.getSimTime()
                      << " s | Slider X=" << std::fixed << std::setprecision(4) << avg_x
                      << " m | v_x=" << std::setprecision(2) << avg_vx << " m/s"
                      << std::endl;
        }

        // Verify slider does not get stuck (v_x must not collapse to 0 while sliding)
        if (avg_vx < 1.0f && avg_x < 0.35f) {
            std::cerr << "[FAIL] Frictionless sliding node GOT STUCK at step " << step 
                      << " position X=" << avg_x << " m, v_x=" << avg_vx << " m/s!" << std::endl;
            return 1;
        }
    }

    const auto& final_nodes = solver.getNodes();
    float final_x = 0.0f;
    int slave_start = static_cast<int>(final_nodes.size()) - 8;
    for (int i = slave_start; i < static_cast<int>(final_nodes.size()); ++i) {
        final_x += final_nodes[i].x[0];
    }
    final_x /= 8.0f;

    std::cout << "  Final Slider X position: " << final_x << " m (Total distance traveled = " 
              << (final_x - initial_x) << " m, Edge crossings = " << edge_crossings << ")" << std::endl;

    if (edge_crossings < 3) {
        std::cerr << "[FAIL] Insufficient edge crossings (" << edge_crossings << " < 3)!" << std::endl;
        return 1;
    }

    std::cout << "[PASS] test_fem_3d_sliding_contact PASSED successfully!" << std::endl;
    return 0;
}
