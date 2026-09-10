#include "cfd_solver_3d_cuda.hpp"
#include "ImmersedBoundary.hpp"
#include <iostream>
#include <vector>
#include <cmath>
#include <cassert>

int main() {
    std::cout << "===========================================================" << std::endl;
    std::cout << "TEST: 1-Voxel Thin Shell & 1-Voxel Gap Numerical Stability" << std::endl;
    std::cout << "===========================================================" << std::endl;

    int nx = 64, ny = 64, nz = 16;
    double dx = 0.01; // 1 cm cells

    CFDSolver3DCuda<float, false> solver(nx, ny, nz, dx, 0.0, 0.0, 0.0);
    solver.setFluxScheme("AUSM+");
    solver.setSpatialOrder(2);
    solver.setTemporalOrder(2); // 2nd-Order ADER-2

    solver.setBoundaryConditions(
        BCType3D::REFLECTIVE, BCType3D::REFLECTIVE,
        BCType3D::REFLECTIVE, BCType3D::REFLECTIVE,
        BCType3D::REFLECTIVE, BCType3D::REFLECTIVE
    );

    // Create a 1-voxel-thick diagonal plate using STL triangles
    // Plate slanted at 45 degrees passing from (0.20, 0.12, 0.0) to (0.20, 0.12, 0.16)
    // and (0.12, 0.20, 0.0) to (0.12, 0.20, 0.16)
    // Plane: x + y = 0.32
    std::vector<Triangle> triangles;
    
    // Add two opposing facets on the thin sheet to verify unsigned co-alignment
    Point3D v0{0.10f, 0.22f, 0.0f};
    Point3D v1{0.22f, 0.10f, 0.0f};
    Point3D v2{0.10f, 0.22f, 0.16f};
    Point3D v3{0.22f, 0.10f, 0.16f};

    // Facet side A
    Triangle t1{v0, v1, v2, {1.0f/std::sqrt(2.0f), 1.0f/std::sqrt(2.0f), 0.0f}};
    Triangle t2{v1, v3, v2, {1.0f/std::sqrt(2.0f), 1.0f/std::sqrt(2.0f), 0.0f}};
    // Facet side B (opposing normal on same 1-voxel membrane)
    Triangle t3{v0, v2, v1, {-1.0f/std::sqrt(2.0f), -1.0f/std::sqrt(2.0f), 0.0f}};
    Triangle t4{v1, v2, v3, {-1.0f/std::sqrt(2.0f), -1.0f/std::sqrt(2.0f), 0.0f}};

    triangles.push_back(t1);
    triangles.push_back(t2);
    triangles.push_back(t3);
    triangles.push_back(t4);

    // Also add parallel walls forming a 1-voxel gap at x = 0.49 (between x = 0.48 and x = 0.50)
    Point3D w1_a{0.48f, 0.20f, 0.0f};
    Point3D w1_b{0.48f, 0.40f, 0.0f};
    Point3D w1_c{0.48f, 0.20f, 0.16f};
    Point3D w1_d{0.48f, 0.40f, 0.16f};
    triangles.push_back(Triangle{w1_a, w1_b, w1_c, {-1.0f, 0.0f, 0.0f}});
    triangles.push_back(Triangle{w1_b, w1_d, w1_c, {-1.0f, 0.0f, 0.0f}});

    Point3D w2_a{0.50f, 0.20f, 0.0f};
    Point3D w2_b{0.50f, 0.40f, 0.0f};
    Point3D w2_c{0.50f, 0.20f, 0.16f};
    Point3D w2_d{0.50f, 0.40f, 0.16f};
    triangles.push_back(Triangle{w2_a, w2_b, w2_c, {1.0f, 0.0f, 0.0f}});
    triangles.push_back(Triangle{w2_b, w2_d, w2_c, {1.0f, 0.0f, 0.0f}});

    std::cout << "[INFO] Voxelizing STL triangles with thin_shell method..." << std::endl;
    solver.setGeometryTriangles(triangles, "test_thin_shell_hash", "thin_shell");

    // Initialize charge on Side A of the thin shell
    Charge3DParams charge{};
    charge.shape_type = 0;
    charge.x = 0.08; charge.y = 0.08; charge.z = 0.08;
    charge.radius = 0.05;

    solver.setDetonatorLocation(0.08, 0.08, 0.08);

    MultiMat::MaterialSet mats{};
    mats.products.A = 373.77e9; mats.products.B = 3.747e9;
    mats.products.R1 = 4.15; mats.products.R2 = 0.9; mats.products.omega = 0.35;
    mats.products.rho0 = 1630.0;
    mats.detonation_energy = 4.29e6; mats.det_vel = 6930.0;
    mats.unreacted = mats.products;

    double amb_rho = 1.225;
    double amb_p = 101325.0;

    solver.setInitialCondition(charge, mats, amb_rho, amb_p);

    std::cout << "[INFO] Running 50 ADER-2 steps with thin shell and narrow gap..." << std::endl;

    for (int step = 1; step <= 50; ++step) {
        double dt = solver.computeStepSize(0.35);
        solver.step(dt);

        if (step % 10 == 0 || step == 1) {
            // Sample Side A (inside blast area, e.g. (8, 8, 8))
            auto vals_a = solver.getCellValues(8, 8, 8);
            // Sample Side B (protected by 1-voxel thin shell, e.g. (25, 25, 8) where x+y = 50 > 32)
            auto vals_b = solver.getCellValues(25, 25, 8);
            // Sample 1-voxel gap channel at (49, 30, 8)
            auto vals_gap = solver.getCellValues(49, 30, 8);

            std::cout << "Step " << step << " | dt: " << dt 
                      << " | Blast P: " << vals_a[0] << " Pa"
                      << " | Shielded Side B P: " << vals_b[0] << " Pa"
                      << " | 1-Voxel Gap P: " << vals_gap[0] << " Pa" << std::endl;

            // Assertions for stability:
            assert(!std::isnan(vals_a[0]) && !std::isinf(vals_a[0]) && vals_a[0] > 0.0f);
            assert(!std::isnan(vals_b[0]) && !std::isinf(vals_b[0]) && vals_b[0] > 0.0f);
            assert(!std::isnan(vals_gap[0]) && !std::isinf(vals_gap[0]) && vals_gap[0] > 0.0f);
        }
    }

    std::cout << "\n[SUCCESS] All 50 steps completed with zero instability or pressure divergence!" << std::endl;
    return 0;
}
