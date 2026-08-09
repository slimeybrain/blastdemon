#include "cfd_solver_3d.hpp"
#include "cfd_solver_3d_cuda.hpp"
#include <iostream>
#include <vector>
#include <cmath>
#include <iomanip>
#include <algorithm>

void test_mode(const std::string& flux, int spatial, int temporal, const std::string& name) {
    std::cout << "\n===========================================================\n";
    std::cout << "TESTING " << name << " (Spatial=" << spatial << ", Temporal=" << temporal << ")\n";
    std::cout << "===========================================================\n";

    int nx = 40, ny = 40, nz = 40;
    double cellSize = 0.2;
    double xmin = -4.0, ymin = -4.0, zmin = 0.0;

    CFDSolver3DCuda<float, true> solver_gpu(nx, ny, nz, cellSize, xmin, ymin, zmin);
    solver_gpu.setFluxScheme(flux);
    solver_gpu.setSpatialOrder(spatial);
    solver_gpu.setTemporalOrder(temporal);
    solver_gpu.setBoundaryConditions(
        BCType3D::TRANSMISSIVE, BCType3D::TRANSMISSIVE,
        BCType3D::TRANSMISSIVE, BCType3D::TRANSMISSIVE,
        BCType3D::REFLECTIVE, BCType3D::TRANSMISSIVE
    );

    Charge3DParams charge{};
    charge.shape_type = 0;
    charge.x = 0.0; charge.y = 0.0; charge.z = 1.0;
    charge.radius = 0.8;

    solver_gpu.setDetonatorLocation(0.0, 0.0, 1.0);

    MultiMat::MaterialSet mats{};
    mats.products.A = 373.77e9; mats.products.B = 3.747e9;
    mats.products.R1 = 4.15; mats.products.R2 = 0.9; mats.products.omega = 0.35;
    mats.products.rho0 = 1630.0;
    mats.detonation_energy = 4.29e6; mats.det_vel = 6930.0;
    mats.unreacted = mats.products;

    double amb_rho = 1.225;
    double amb_p = 101325.0;

    solver_gpu.setInitialCondition(charge, mats, amb_rho, amb_p);

    auto center_vals = solver_gpu.getCellValues(20, 20, 5);
    std::cout << "Center values | P: " << center_vals[0] << " | Rho: " << center_vals[1] << " | Alpha2: " << center_vals[5] << std::endl;

    Slice3D slice_xy;
    slice_xy.axis = "xy";
    slice_xy.offset = 1.0;
    slice_xy.stride = 1;
    slice_xy.quantities = {"pressure"};

    for (int step = 1; step <= 5; ++step) {
        double dt = solver_gpu.computeStepSize(0.35);
        solver_gpu.step(dt);
        auto slice = solver_gpu.extractSlice(slice_xy);
        float max_p = *std::max_element(slice.begin(), slice.end());
        std::cout << "Step " << step << " | dt: " << dt << " | Max P: " << max_p << std::endl;
        auto step_center_vals = solver_gpu.getCellValues(20, 20, 5);
        std::cout << "  Center P: " << step_center_vals[0] << std::endl;
    }
}

int main() {
    test_mode("AUSM+", 1, 1, "Forward Euler (Spatial=1, Temporal=1)");
    test_mode("AUSM+", 2, 2, "RK2 (Spatial=2, Temporal=2)");
    test_mode("AUSM+", 2, 3, "RK3 (Spatial=2, Temporal=3)");
    test_mode("AUSM+", 2, 4, "MUSCL-Hancock (Spatial=2, Temporal=4)");
    test_mode("AUSM+", 2, 6, "ADER-3 (Spatial=2, Temporal=6)");
    return 0;
}
