#include "mpm_solver_3d.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include <iostream>
#include <iomanip>
#include <cmath>
#include <algorithm>

int main() {
    std::cout << "===========================================================\n";
    std::cout << "CYLINDER IMPACT MODEL: CPU vs GPU COMPARISON TEST\n";
    std::cout << "===========================================================\n\n";

    float xmin = -0.003f, xmax = 0.003f;
    float ymin = -0.003f, ymax = 0.003f;
    float zmin = 0.0000001f, zmax = 0.015f;
    float cell_size = 0.00025f;
    int pad = 3;

    int nx = std::max(1, static_cast<int>(std::round((xmax - xmin) / cell_size))) + 2 * pad;
    int ny = std::max(1, static_cast<int>(std::round((ymax - ymin) / cell_size))) + 2 * pad;
    int nz = std::max(1, static_cast<int>(std::round((zmax - zmin) / cell_size))) + 2 * pad;
    xmin -= pad * cell_size;
    ymin -= pad * cell_size;
    zmin -= pad * cell_size;
    float dx = cell_size, dy = cell_size, dz = cell_size;

    std::cout << "Grid Dimensions: " << nx << " x " << ny << " x " << nz << "\n";
    std::cout << "xmin=" << xmin << ", ymin=" << ymin << ", zmin=" << zmin << "\n\n";

    auto bc_trans = Blast::MPMBoundaryCondition3D::Terminate; // Transmitting
    auto bc_sticky = Blast::MPMBoundaryCondition3D::Sticky;

    // --- CPU Setup ---
    Blast::MPMSolver3D cpu_solver;
    cpu_solver.initializeGrid(nx, ny, nz, dx, dy, dz, xmin, ymin, zmin);
    cpu_solver.setTransferScheme(Blast::MPMTransferScheme::BSpline);
    cpu_solver.setVelocityScheme(Blast::MPMVelocityScheme::APIC);
    cpu_solver.setTimeScheme(Blast::MPMTimeIntegrationScheme::USF);
    cpu_solver.setFlipBlend(0.95f);
    cpu_solver.setSmoothPlasticStrain(true);
    cpu_solver.setBoundaryConditions(bc_sticky, bc_sticky, bc_sticky, bc_sticky, bc_sticky, bc_sticky);

    cpu_solver.addCylinderObject(1, 0.0f, 0.0f, 0.008f, 0.0005f, 0.0f, 0.01f,
                                 0.0f, 0.0f, -250.0f, 0.0f, 0.0f, 0.0f,
                                 8960.0f, 124.0e9f, 0.34f, 90.0e6f, 292.0e6f, 0.54f, 230.0e6f, 8);

    auto& cpu_mat = cpu_solver.getMaterialTables()[1];
    cpu_mat.material_model = Blast::MPMMaterialModel::JohnsonCookMieGruneisen;
    cpu_mat.jc_A = 90.0e6f; cpu_mat.jc_B = 292.0e6f; cpu_mat.jc_n = 0.31f; cpu_mat.jc_C = 0.025f; cpu_mat.jc_m = 1.09f;
    cpu_mat.T_melt = 1356.0f; cpu_mat.T_room = 293.0f; cpu_mat.Cp = 383.0f;
    cpu_mat.mg_gamma0 = 2.02f; cpu_mat.mg_c0 = 3940.0f; cpu_mat.mg_s = 1.49f;

    // --- GPU Setup ---
    Blast::MPMSolver3DCUDA gpu_solver;
    gpu_solver.initializeGrid(nx, ny, nz, dx, dy, dz, xmin, ymin, zmin);
    gpu_solver.setTransferScheme(Blast::MPMTransferScheme::BSpline);
    gpu_solver.setVelocityScheme(Blast::MPMVelocityScheme::APIC);
    gpu_solver.setTimeScheme(Blast::MPMTimeIntegrationScheme::USF);
    gpu_solver.setFlipBlend(0.95f);
    gpu_solver.setSmoothPlasticStrain(true);
    gpu_solver.setBoundaryConditions(bc_sticky, bc_sticky, bc_sticky, bc_sticky, bc_sticky, bc_sticky);

    gpu_solver.addCylinderObject(1, 0.0f, 0.0f, 0.008f, 0.0005f, 0.0f, 0.01f,
                                 0.0f, 0.0f, -250.0f, 0.0f, 0.0f, 0.0f,
                                 8960.0f, 124.0e9f, 0.34f, 90.0e6f, 292.0e6f, 0.54f, 230.0e6f, 8);

    auto& gpu_mat = gpu_solver.getMaterialTables()[1];
    gpu_mat.material_model = Blast::MPMMaterialModel::JohnsonCookMieGruneisen;
    gpu_mat.jc_A = 90.0e6f; gpu_mat.jc_B = 292.0e6f; gpu_mat.jc_n = 0.31f; gpu_mat.jc_C = 0.025f; gpu_mat.jc_m = 1.09f;
    gpu_mat.T_melt = 1356.0f; gpu_mat.T_room = 293.0f; gpu_mat.Cp = 383.0f;
    gpu_mat.mg_gamma0 = 2.02f; gpu_mat.mg_c0 = 3940.0f; gpu_mat.mg_s = 1.49f;

    gpu_solver.syncToDevice();

    std::cout << "Particle count: CPU = " << cpu_solver.getParticles().size() 
              << ", GPU = " << gpu_solver.getParticles().size() << "\n\n";

    std::cout << std::setw(6) << "Step"
              << std::setw(16) << "CPU Min Z"
              << std::setw(16) << "GPU Min Z"
              << std::setw(16) << "CPU Max R"
              << std::setw(16) << "GPU Max R"
              << std::setw(16) << "CPU Max Ep"
              << std::setw(16) << "GPU Max Ep\n";
    std::cout << "----------------------------------------------------------------------------------------------------\n";

    float cfl = 0.4f;
    for (int step = 1; step <= 2500; ++step) {
        cpu_solver.step(cfl);
        gpu_solver.step(cfl);

        if (step % 100 == 0 || step == 1) {
            gpu_solver.syncToHost();
            const auto& cpu_parts = cpu_solver.getParticles();
            const auto& gpu_parts = gpu_solver.getParticles();

            float cpu_min_z = 1e9f, gpu_min_z = 1e9f;
            float cpu_max_r = 0.0f, gpu_max_r = 0.0f;
            float cpu_max_ep = 0.0f, gpu_max_ep = 0.0f;

            for (const auto& p : cpu_parts) {
                if (p.x[2] < cpu_min_z) cpu_min_z = p.x[2];
                float r = std::sqrt(p.x[0]*p.x[0] + p.x[1]*p.x[1]);
                if (r > cpu_max_r) cpu_max_r = r;
                if (p.ep_bar > cpu_max_ep) cpu_max_ep = p.ep_bar;
            }
            for (const auto& p : gpu_parts) {
                if (p.x[2] < gpu_min_z) gpu_min_z = p.x[2];
                float r = std::sqrt(p.x[0]*p.x[0] + p.x[1]*p.x[1]);
                if (r > gpu_max_r) gpu_max_r = r;
                if (p.ep_bar > gpu_max_ep) gpu_max_ep = p.ep_bar;
            }

            std::cout << std::setw(6) << step
                      << std::setw(16) << std::scientific << std::setprecision(4) << cpu_min_z
                      << std::setw(16) << std::scientific << std::setprecision(4) << gpu_min_z
                      << std::setw(16) << std::scientific << std::setprecision(4) << cpu_max_r
                      << std::setw(16) << std::scientific << std::setprecision(4) << gpu_max_r
                      << std::setw(16) << std::scientific << std::setprecision(4) << cpu_max_ep
                      << std::setw(16) << std::scientific << std::setprecision(4) << gpu_max_ep << "\n";
        }
    }
    return 0;
}
