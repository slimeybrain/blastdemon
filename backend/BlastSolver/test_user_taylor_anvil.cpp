#include "mpm_solver_3d.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include <iostream>
#include <iomanip>
#include <cmath>

void run_test(const std::string& name, Blast::MPMMaterialModel model_type, Blast::MPMTransferScheme transfer_scheme) {
    std::cout << "\n===========================================================\n";
    std::cout << "RUNNING EXACT UI TAYLOR ANVIL TEST: " << name << "\n";
    std::cout << "===========================================================\n";

    float xmin = -0.015f, xmax = 0.015f;
    float ymin = -0.015f, ymax = 0.015f;
    float zmin = 0.0f, zmax = 0.06f;
    float cell_size = 0.00075f;
    int pad = 3;

    int nx = std::max(1, static_cast<int>(std::round((xmax - xmin) / cell_size))) + 2 * pad;
    int ny = std::max(1, static_cast<int>(std::round((ymax - ymin) / cell_size))) + 2 * pad;
    int nz = std::max(1, static_cast<int>(std::round((zmax - zmin) / cell_size))) + 2 * pad;
    xmin -= pad * cell_size;
    ymin -= pad * cell_size;
    zmin -= pad * cell_size;
    float dx = cell_size, dy = cell_size, dz = cell_size;

    std::cout << "Grid: " << nx << " x " << ny << " x " << nz << " | dx=" << dx << "\n";

    auto bc_trans = Blast::MPMBoundaryCondition3D::Terminate; // Transmitting
    auto bc_refl = Blast::MPMBoundaryCondition3D::Reflecting; // Reflecting

    Blast::MPMSolver3DCUDA solver;
    solver.initializeGrid(nx, ny, nz, dx, dy, dz, xmin, ymin, zmin);
    solver.setTransferScheme(transfer_scheme);
    solver.setVelocityScheme(Blast::MPMVelocityScheme::APIC);
    solver.setTimeScheme(Blast::MPMTimeIntegrationScheme::Leapfrog);
    solver.setFlipBlend(0.95f);
    solver.setSmoothPlasticStrain(true);
    solver.setBoundaryConditions(bc_trans, bc_trans, bc_trans, bc_trans, bc_refl, bc_trans);

    // Cylinder: pos_z = 0.0254, r = 0.004, h = 0.04, v_z = -115 m/s
    solver.addCylinderObject(1, 0.0f, 0.0f, 0.0254f, 0.004f, 0.0f, 0.04f,
                             0.0f, 0.0f, -115.0f, 0.0f, 0.0f, 0.0f,
                             8960.0f, 124.0e9f, 0.34f,
                             90.0e6f, 292.0e6f, 0.54f, 230.0e6f, 8);

    auto& mat = solver.getMaterialTables()[1];
    mat.material_model = model_type;
    mat.yield_stress = 90.0e6f;
    mat.hardening_modulus = 292.0e6f;
    mat.failure_strain = 0.54f;
    mat.tensile_failure_stress = 230.0e6f;
    mat.enable_strain_erosion = false;
    mat.enable_stress_erosion = false;

    solver.syncToDevice();
    size_t num_particles = solver.getParticles().size();
    std::cout << "Total particles initialized: " << num_particles << "\n";

    float cfl = 0.6f;
    double sim_time = 0.0;
    int step = 0;

    for (int i = 1; i <= 2000; ++i) {
        solver.step(cfl);
        step++;
        sim_time = solver.getSimTime();

        if (i % 100 == 0 || i == 1 || i == 10) {
            solver.syncToHost();
            const auto& parts = solver.getParticles();
            float min_z = 1e9f, max_z = -1e9f, max_r = 0.0f, max_v = 0.0f, max_ep = 0.0f;
            int failed_count = 0;
            int escaped_count = 0;

            float max_ep_top = 0.0f;
            float max_ep_impact = 0.0f;
            for (const auto& p : parts) {
                float r = std::sqrt(p.x[0]*p.x[0] + p.x[1]*p.x[1]);
                if (p.x[2] < min_z) min_z = p.x[2];
                if (p.x[2] > max_z) max_z = p.x[2];
                if (r > max_r) max_r = r;
                float v = std::sqrt(p.v[0]*p.v[0] + p.v[1]*p.v[1] + p.v[2]*p.v[2]);
                if (v > max_v) max_v = v;
                if (p.ep_bar > max_ep) max_ep = p.ep_bar;
                if (p.x[2] > 0.025f && p.ep_bar > max_ep_top) max_ep_top = p.ep_bar;
                if (p.x[2] <= 0.015f && p.ep_bar > max_ep_impact) max_ep_impact = p.ep_bar;
                if (p.has_failed || p.damage >= 1.0f) failed_count++;
                if (r > 0.015f || p.x[2] < -0.001f || p.x[2] > 0.06f) escaped_count++;
            }

            std::cout << "Step " << std::setw(4) << i
                      << " | t = " << std::scientific << std::setprecision(3) << sim_time
                      << " | min_z = " << std::setprecision(4) << min_z
                      << " | max_z = " << max_z
                      << " | max_r = " << max_r
                      << " | max_v = " << std::fixed << std::setprecision(1) << max_v
                      << " | max_ep = " << std::setprecision(3) << max_ep
                      << " | ep_impact = " << max_ep_impact
                      << " | ep_top = " << max_ep_top
                      << " | failed = " << failed_count
                      << " | escaped = " << escaped_count << "\n";
        }
    }
}

int main() {
    run_test("Variant 1: Linear Elastic (BSpline)", Blast::MPMMaterialModel::LinearElastic, Blast::MPMTransferScheme::BSpline);
    run_test("Variant 3: Johnson-Cook (BSpline)", Blast::MPMMaterialModel::JohnsonCookMieGruneisen, Blast::MPMTransferScheme::BSpline);
    return 0;
}
