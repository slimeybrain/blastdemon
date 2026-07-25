#include "cfd_solver_3d.hpp"
#include "cfd_solver_3d_cuda.hpp"
#include <iostream>
#include <vector>
#include <cmath>
#include <cuda_runtime.h>
#include <iomanip>

int main() {
    std::cout << "===========================================================\n";
    std::cout << "UNIFORM FINE GRID vs SUBGRIDDED MESH EQUIVALENCE TEST\n";
    std::cout << "===========================================================\n\n";

    // -------------------------------------------------------------------
    // Model A: Uniform Fine Mesh (64x64x32, dx = 0.01m)
    // -------------------------------------------------------------------
    int fine_nx = 64, fine_ny = 64, fine_nz = 32;
    double fine_h = 0.01;
    CFDSolver3DCuda<float, false> solver_fine(fine_nx, fine_ny, fine_nz, fine_h, 0.0, 0.0, 0.0);
    solver_fine.setFluxScheme("AUSM+");
    solver_fine.setSpatialOrder(2);
    solver_fine.setTemporalOrder(2);
    solver_fine.setBoundaryConditions(BCType3D::REFLECTIVE, BCType3D::TRANSMISSIVE, BCType3D::REFLECTIVE, BCType3D::TRANSMISSIVE, BCType3D::REFLECTIVE, BCType3D::TRANSMISSIVE);

    // -------------------------------------------------------------------
    // Model B: Subgridded Mesh (Base: 32x32x16, dx = 0.02m + Submesh L1: dx = 0.01m)
    // Submesh bounds: [0.16, 0.48] x [0.16, 0.48] x [0.0, 0.32]
    // -------------------------------------------------------------------
    int coarse_nx = 32, coarse_ny = 32, coarse_nz = 16;
    double coarse_h = 0.02;
    CFDSolver3DCuda<float, false> solver_subgrid(coarse_nx, coarse_ny, coarse_nz, coarse_h, 0.0, 0.0, 0.0);
    solver_subgrid.setFluxScheme("AUSM+");
    solver_subgrid.setSpatialOrder(2);
    solver_subgrid.setTemporalOrder(2);
    solver_subgrid.setBoundaryConditions(BCType3D::REFLECTIVE, BCType3D::TRANSMISSIVE, BCType3D::REFLECTIVE, BCType3D::TRANSMISSIVE, BCType3D::REFLECTIVE, BCType3D::TRANSMISSIVE);

    SubMeshParams3D sm_p;
    sm_p.id = "refinement_box";
    sm_p.level = 1;
    sm_p.xmin = 0.16;
    sm_p.ymin = 0.16;
    sm_p.zmin = 0.0;
    sm_p.size_x = 0.32;
    sm_p.size_y = 0.32;
    sm_p.size_z = 0.32;
    solver_subgrid.addSubMesh(sm_p);

    // -------------------------------------------------------------------
    // Common Initial Blast Charge (Sphere at x=0.32, y=0.32, z=0.16, r=0.08)
    // -------------------------------------------------------------------
    Charge3DParams charge{};
    charge.shape_type = 0; // Sphere
    charge.x = 0.32; charge.y = 0.32; charge.z = 0.16;
    charge.radius = 0.08;

    MultiMat::MaterialSet mats;
    mats.products.A = 3.73e11;
    mats.products.B = 3.74e9;
    mats.products.R1 = 4.15;
    mats.products.R2 = 0.9;
    mats.products.omega = 0.35;
    mats.products.rho0 = 1630.0;
    mats.detonation_energy = 4.0e6;
    mats.unreacted = mats.products;

    double amb_rho = 1.225;
    double amb_p = 101325.0;

    solver_fine.setInitialCondition(charge, mats, amb_rho, amb_p);
    solver_subgrid.setInitialCondition(charge, mats, amb_rho, amb_p);

    // Print initial charge statistics for both solvers
    {
        int fine_cnt = 0, sub_cnt = 0;
        double max_p_fine = 0, max_p_sub = 0;
        for (int k = 0; k < 32; ++k) {
            for (int j = 0; j < 64; ++j) {
                for (int i = 0; i < 64; ++i) {
                    auto v_f = solver_fine.getCellValues(i, j, k);
                    if (v_f[0] > 200000.0) { fine_cnt++; if (v_f[0] > max_p_fine) max_p_fine = v_f[0]; }
                }
            }
        }
        for (int k = 0; k < 16; ++k) {
            for (int j = 0; j < 32; ++j) {
                for (int i = 0; i < 32; ++i) {
                    auto v_s = solver_subgrid.getCellValues(i, j, k);
                    if (v_s[0] > 200000.0) { sub_cnt++; if (v_s[0] > max_p_sub) max_p_sub = v_s[0]; }
                }
            }
        }
        std::cout << "[INIT DIAG] Uniform Fine Solver Z-profile at (32,32):\n";
        for (int k = 0; k < 32; ++k) {
            auto v = solver_fine.getCellValues(32, 32, k);
            if (v[0] > 200000.0) {
                std::cout << "  k=" << k << " (z=" << (k + 0.5) * 0.01 << "m): P=" << std::scientific << std::setprecision(3) << v[0] << "\n";
            }
        }
        std::cout << "[INIT DIAG] Uniform Fine Solver high pressure cell count: " << fine_cnt << ", Max P: " << max_p_fine << "\n";
        std::cout << "[INIT DIAG] Subgridded Base Solver high pressure cell count: " << sub_cnt << ", Max P: " << max_p_sub << "\n";
    }
    Gauge3D g1{"g1_center", 0.32, 0.32, 0.16};
    Gauge3D g2{"g2_sub_interior", 0.40, 0.32, 0.16};
    Gauge3D g3{"g3_sub_boundary", 0.46, 0.32, 0.16};
    Gauge3D g4{"g4_parent_near", 0.50, 0.32, 0.16};
    Gauge3D g5{"g5_parent_far", 0.58, 0.32, 0.16};

    std::vector<Gauge3D> gauges = {g1, g2, g3, g4, g5};

    std::cout << std::setw(6) << "Step" 
              << std::setw(12) << "Time (ms)"
              << std::setw(14) << "Fine P_g3"
              << std::setw(14) << "Subg P_g3"
              << std::setw(14) << "Fine P_g4"
              << std::setw(14) << "Subg P_g4"
              << std::setw(14) << "Fine P_g5"
              << std::setw(14) << "Subg P_g5"
              << std::setw(14) << "Max Slice Diff\n";
    std::cout << "-----------------------------------------------------------------------------------------------------------------------------------\n";

    double total_time = 0.0;
    int num_steps = 200;
    double cfl = 0.35;

    Slice3D slice_xy;
    slice_xy.axis = "xy";
    slice_xy.offset = 0.16;
    slice_xy.stride = 1;
    slice_xy.quantities = {"pressure"};

    for (int step = 0; step <= num_steps; ++step) {
        if (step > 0) {
            double dt_fine = solver_fine.computeStepSize(cfl);
            double dt_sub = solver_subgrid.computeStepSize(cfl);
            double dt = std::min(dt_fine, dt_sub);

            solver_fine.step(dt);
            solver_subgrid.step(dt);
            total_time += dt;
        }

        if (step % 10 == 0 || step == 0) {
            // Extract gauge pressure
            auto v1_fine = solver_fine.sampleGauge(g1);
            auto v1_sub  = solver_subgrid.sampleGauge(g1);

            auto v2_fine = solver_fine.sampleGauge(g2);
            auto v2_sub  = solver_subgrid.sampleGauge(g2);

            auto v3_fine = solver_fine.sampleGauge(g3);
            auto v3_sub  = solver_subgrid.sampleGauge(g3);

            // Extract XY slice comparison
            auto slice_f = solver_fine.extractSlice(slice_xy);
            auto slice_s = solver_subgrid.extractSlice(slice_xy);

            double max_slice_diff = 0.0;
            size_t worst_p = 0;
            size_t n_pts = std::min(slice_f.size(), slice_s.size());
            for (size_t p = 0; p < n_pts; ++p) {
                double diff = std::abs((double)slice_f[p] - (double)slice_s[p]);
                if (diff > max_slice_diff) {
                    max_slice_diff = diff;
                    worst_p = p;
                }
            }

            int scale = 2; // base_w = 32, w = 64
            int w = 64;
            int worst_i = worst_p % w;
            int worst_j = worst_p / w;
            double worst_x = 0.0 + (worst_i + 0.5) * 0.01;
            double worst_y = 0.0 + (worst_j + 0.5) * 0.01;

            std::cout << std::setw(6) << step 
                      << std::setw(12) << std::fixed << std::setprecision(4) << (total_time * 1000.0)
                      << std::setw(14) << std::scientific << std::setprecision(3) << v1_fine[0]
                      << std::setw(14) << std::scientific << std::setprecision(3) << v1_sub[0]
                      << std::setw(14) << std::scientific << std::setprecision(3) << v2_fine[0]
                      << std::setw(14) << std::scientific << std::setprecision(3) << v2_sub[0]
                      << std::setw(14) << std::scientific << std::setprecision(3) << max_slice_diff
                      << " [Worst at (" << worst_i << "," << worst_j << ") x=" << worst_x << ",y=" << worst_y
                      << " Fine=" << slice_f[worst_p] << " Sub=" << slice_s[worst_p] << "]\n";

            if (step == 0) {
                std::cout << "\n--- Step 0 Fine Grid Slice (around center 32,32) ---\n";
                for (int sj = 28; sj <= 34; ++sj) {
                    for (int si = 28; si <= 34; ++si) {
                        std::cout << std::scientific << std::setprecision(1) << slice_f[si + sj * 64] << " ";
                    }
                    std::cout << "\n";
                }
                std::cout << "\n--- Step 0 Subgridded Slice (around center 32,32) ---\n";
                for (int sj = 28; sj <= 34; ++sj) {
                    for (int si = 28; si <= 34; ++si) {
                        std::cout << std::scientific << std::setprecision(1) << slice_s[si + sj * 64] << " ";
                    }
                    std::cout << "\n";
                }
                std::cout << "---------------------------------------------------\n\n";
            }
        }
    }

    std::cout << "\nTest run complete.\n";
    return 0;
}
