#include "fem_solver_3d.hpp"
#include <iostream>
#include <cassert>
#include <cmath>

using namespace Blast;

int main() {
    std::cout << "[TEST] Running test_fem_3d_large_rotation..." << std::endl;

    FEMSolver3D<double> solver;

    MaterialTable3D mat{};
    mat.density = 7850.0;
    mat.youngs_modulus = 210.0e9;
    mat.poissons_ratio = 0.30;
    mat.yield_stress = 1.0e12; // High yield stress to remain purely elastic

    solver.addStructuredBoxMesh(2, 2, 2, 0.2, 0.2, 0.2, -0.1, -0.1, -0.1, mat);

    // Apply an initial non-zero deviatoric stress to all elements:
    // s_xx = +50 MPa, s_yy = -50 MPa, s_xy = 50 MPa
    double s_xx_0 = 50.0e6;
    double s_yy_0 = -50.0e6;
    double s_xy_0 = 50.0e6;

    for (auto& elem : solver.getElements()) {
        elem.s_dev[0][0] = s_xx_0;
        elem.s_dev[1][1] = s_yy_0;
        elem.s_dev[0][1] = elem.s_dev[1][0] = s_xy_0;
        elem.sigma[0][0] = s_xx_0;
        elem.sigma[1][1] = s_yy_0;
        elem.sigma[0][1] = elem.sigma[1][0] = s_xy_0;
    }

    double initial_vm = solver.getMaxVonMisesStress();
    std::cout << "  Initial Max Von Mises Stress = " << initial_vm / 1.0e6 << " MPa" << std::endl;

    double omega = 1000.0;
    double dt = 1.0e-6;

    for (int step = 0; step < 100; ++step) {
        // Enforce pure rigid body rotation kinematics at each step:
        // Position: x(t) = R(omega*t) * x0, Velocity: v(t) = omega x x(t)
        double current_t = (step + 1) * dt;
        double th = omega * current_t;
        double cos_th = std::cos(th);
        double sin_th = std::sin(th);

        for (auto& node : solver.getNodes()) {
            double x0 = node.x0[0];
            double y0 = node.x0[1];
            double z0 = node.x0[2];

            // Exact circular arc position
            node.x[0] = cos_th * x0 - sin_th * y0;
            node.x[1] = sin_th * x0 + cos_th * y0;
            node.x[2] = z0;

            // Velocity at x(t)
            node.v[0] = -omega * node.x[1];
            node.v[1] =  omega * node.x[0];
            node.v[2] = 0.0;
            node.a[0] = node.a[1] = node.a[2] = 0.0;
        }

        solver.stepWithDt(dt);

        if ((step + 1) % 20 == 0 || step == 0) {
            const auto& elem = solver.getElements()[0];
            double vm = solver.getMaxVonMisesStress();
            std::cout << "  Step " << (step + 1) << ": s_xx=" << elem.s_dev[0][0]/1.0e6
                      << " MPa, s_yy=" << elem.s_dev[1][1]/1.0e6
                      << " MPa, s_xy=" << elem.s_dev[0][1]/1.0e6
                      << " MPa | Von Mises=" << vm/1.0e6 << " MPa" << std::endl;
        }
    }

    double final_vm = solver.getMaxVonMisesStress();
    double total_rot_angle = omega * 100 * dt; // radians
    std::cout << "  After 100 steps (" << total_rot_angle * (180.0 / 3.141592653589793) << " deg rotation):" << std::endl;
    std::cout << "  Final Max Von Mises Stress = " << final_vm / 1.0e6 << " MPa (Initial: " << initial_vm / 1.0e6 << " MPa)" << std::endl;

    double vm_diff_pct = std::abs(final_vm - initial_vm) / initial_vm * 100.0;
    std::cout << "  Von Mises Stress Variation = " << vm_diff_pct << " %" << std::endl;

    assert(vm_diff_pct < 0.5);
    std::cout << "[PASS] test_fem_3d_large_rotation PASSED successfully!" << std::endl;

    return 0;
}
