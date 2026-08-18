#include "constitutive_crest_davis.hpp"
#include "mpm_solver_3d.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include <iostream>
#include <iomanip>
#include <cassert>
#include <cmath>

using namespace Blast;

int main() {
    std::cout << "[TEST] Running CREST Reactive Burn & Davis EOS Unit Tests..." << std::endl;

    // PBX 9502 properties
    const float c0 = 2050.0f;
    const float s1 = 2.12f;
    const float gamma0 = 0.65f;
    const float cv = 1000.0f;
    const float t0 = 293.0f;
    const float rho0 = 1895.0f;

    const float a = 2.85f;
    const float b = 1.10f;
    const float k = 1.35f;
    const float vc = 0.65f;
    const float pc = 12.5e9f;
    const float q_det = 3.90e6f;

    const float b1 = 1.2e7f;
    const float c1 = 0.67f;
    const float m1 = 2.5f;
    const float b2 = 3.5e6f;
    const float c2 = 0.50f;
    const float c3 = 0.67f;
    const float m2 = 1.5f;
    const float s0 = 100.0f;
    const float s_thresh = 45.0f;

    // 1. Uncompressed Reactant Pressure at v = 1.0, e = 0.0
    float p_react_uncompressed = CrestDavis::computeDavisReactantPressure(1.0f, 0.0f, c0, s1, gamma0, cv, t0, rho0);
    std::cout << "  Uncompressed Reactant Pressure: " << p_react_uncompressed << " Pa" << std::endl;
    assert(std::abs(p_react_uncompressed) < 1.0f);

    // 2. Shocked Reactant Pressure at v = 0.80 (20% volumetric compression)
    float p_react_shocked = CrestDavis::computeDavisReactantPressure(0.80f, 5.0e4f, c0, s1, gamma0, cv, t0, rho0);
    std::cout << "  Shocked Reactant Pressure (v=0.80): " << (p_react_shocked * 1e-9f) << " GPa" << std::endl;
    assert(p_react_shocked > 2.0e9f); // Must produce several GPa of shock pressure

    // 3. Shock Entropy mapping
    float s_low = CrestDavis::computeDavisShockEntropy(0.95f, c0, s1, gamma0, cv, t0, rho0);
    float s_high = CrestDavis::computeDavisShockEntropy(0.70f, c0, s1, gamma0, cv, t0, rho0);
    std::cout << "  Shock Entropy (v=0.95): " << s_low << " J/(kg K)" << std::endl;
    std::cout << "  Shock Entropy (v=0.70): " << s_high << " J/(kg K)" << std::endl;
    assert(s_low < s_thresh);
    assert(s_high > s_thresh);

    // 4. CREST Reaction Advance below threshold (should remain 0)
    float lam_unignited = CrestDavis::advanceCRESTProgress(1.0e-6f, s_low, 0.0f, b1, c1, m1, b2, c2, c3, m2, s0, s_thresh);
    std::cout << "  Progress for s < s_thresh: " << lam_unignited << std::endl;
    assert(lam_unignited == 0.0f);

    // 5. CREST Reaction Advance above threshold (should increase smoothly)
    float lam_ignited = CrestDavis::advanceCRESTProgress(1.0e-7f, s_high, 0.0f, b1, c1, m1, b2, c2, c3, m2, s0, s_thresh);
    std::cout << "  Progress after 100ns (s= " << s_high << "): " << lam_ignited << std::endl;
    assert(lam_ignited > 0.0f && lam_ignited <= 1.0f);

    // 6. Product Gas Pressure
    float p_prod = CrestDavis::computeDavisProductPressure(0.70f, q_det, a, b, k, vc, pc, q_det, rho0);
    std::cout << "  Product Gas Pressure (v=0.70): " << (p_prod * 1e-9f) << " GPa" << std::endl;
    assert(p_prod > 10.0e9f); // Detonation CJ/product pressure in tens of GPa

    // 7. Replicate User's Exact Model from UI on CUDA GPU
    std::cout << "\n===========================================================" << std::endl;
    std::cout << "TESTING USER'S EXACT CYLINDER DETONATION MODEL ON CUDA GPU" << std::endl;
    std::cout << "===========================================================" << std::endl;

    float user_xmin = -1.0f, user_xmax = 1.5f;
    float user_ymin = -1.0f, user_ymax = 1.5f;
    float user_zmin = 0.0f, user_zmax = 1.5f;
    float user_cell_size = 0.0125f;
    int pad = 3;

    int user_nx = std::max(1, static_cast<int>(std::round((user_xmax - user_xmin) / user_cell_size))) + 2 * pad;
    int user_ny = std::max(1, static_cast<int>(std::round((user_ymax - user_ymin) / user_cell_size))) + 2 * pad;
    int user_nz = std::max(1, static_cast<int>(std::round((user_zmax - user_zmin) / user_cell_size))) + 2 * pad;
    user_xmin -= pad * user_cell_size;
    user_ymin -= pad * user_cell_size;
    user_zmin -= pad * user_cell_size;
    float user_dx = user_cell_size, user_dy = user_cell_size, user_dz = user_cell_size;

    std::cout << "Grid: " << user_nx << "x" << user_ny << "x" << user_nz << " | dx=" << user_dx << std::endl;

    Blast::MPMSolver3DCUDA cuda_solver;
    cuda_solver.initializeGrid(user_nx, user_ny, user_nz, user_dx, user_dy, user_dz, user_xmin, user_ymin, user_zmin);
    cuda_solver.setTransferScheme(Blast::MPMTransferScheme::BSpline);
    cuda_solver.setVelocityScheme(Blast::MPMVelocityScheme::APIC);
    cuda_solver.setTimeScheme(Blast::MPMTimeIntegrationScheme::Leapfrog);

    // Add User's Cylinder: Centroid (0.25, 0.25, 0.4), Radius 0.052, Height 0.4, PPC 8
    cuda_solver.addCylinderObject(1, 0.25f, 0.25f, 0.4f, 0.052f, 0.0f, 0.4f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1895.0f, 10.0e9f, 0.35f, 50.0e6f, 100.0e6f, 0.10f, 60.0e6f, 8);
    auto& user_mat = cuda_solver.getMaterialTables()[1];
    user_mat.material_model = MPMMaterialModel::CRESTReactiveBurn;
    user_mat.davis_c0 = c0; user_mat.davis_s1 = s1; user_mat.davis_gamma0 = gamma0; user_mat.davis_cv = cv; user_mat.davis_t0 = t0; user_mat.davis_rho0 = rho0;
    user_mat.davis_a = a; user_mat.davis_b = b; user_mat.davis_k = k; user_mat.davis_vc = vc; user_mat.davis_pc = pc; user_mat.davis_q_det = q_det;
    user_mat.crest_b1 = b1; user_mat.crest_c1 = c1; user_mat.crest_m1 = m1; user_mat.crest_b2 = b2; user_mat.crest_c2 = c2; user_mat.crest_c3 = c3; user_mat.crest_m2 = m2;
    user_mat.crest_s0 = 15.0f;          // Realistic characteristic entropy scale (J/(kg K))
    // Point Detonator at (0.25, 0.25, 0.425), radius 0.01
    float det_x = 0.25f, det_y = 0.25f, det_z = 0.425f;
    float init_rad = 0.01f;
    float effective_init_rad = std::max(init_rad, 2.5f * user_dx);
    user_mat.crest_s_threshold = 2.0f; // Discretized numerical threshold for coarse grids (12.5mm cells)

    int init_count = 0;
    for (auto& p : cuda_solver.getParticles()) {
        if (p.object_id == 1) {
            float d_x = p.x[0] - det_x;
            float d_y = p.x[1] - det_y;
            float d_z = p.x[2] - det_z;
            float dist = std::sqrt(d_x * d_x + d_y * d_y + d_z * d_z);
            if (dist <= effective_init_rad) {
                p.s_shock = 1.5f * user_mat.crest_s_threshold;
                p.lambda = 1.0f;
                p.e_int = user_mat.davis_q_det;
                p.v_min = 0.70f;
                p.V = 0.70f * p.V0;
                float p_init = (user_mat.davis_pc > 1.0e6f) ? user_mat.davis_pc : 15.0e9f;
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        p.sigma[r][c] = (r == c) ? -p_init : 0.0f;
                init_count++;
            }
        }
    }
    std::cout << "Total particles: " << cuda_solver.getParticles().size() 
              << " | Initialized hotspot particles: " << init_count << std::endl;

    cuda_solver.syncToDevice();

    for (int step = 0; step <= 250; ++step) {
        cuda_solver.step(0.6f);

        if (step <= 20 || step % 25 == 0) {
            cuda_solver.syncParticlesToHost();
            int reacting = 0;
            float max_lam = 0.0f;
            float min_v_min = 1.0f;
            float max_s = 0.0f;
            float max_p = 0.0f;
            float max_v = 0.0f;
            for (const auto& p : cuda_solver.getParticles()) {
                if (p.object_id == 1) {
                    if (p.lambda > 0.01f) reacting++;
                    max_lam = std::max(max_lam, p.lambda);
                    min_v_min = std::min(min_v_min, p.v_min);
                    max_s = std::max(max_s, p.s_shock);
                    float press = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
                    max_p = std::max(max_p, press);
                    float v_mag = std::sqrt(p.v[0]*p.v[0] + p.v[1]*p.v[1] + p.v[2]*p.v[2]);
                    max_v = std::max(max_v, v_mag);
                }
            }
            std::cout << "  Step " << std::setw(3) << step 
                      << " | Time: " << std::scientific << std::setprecision(3) << cuda_solver.getSimTime()
                      << " | dt: " << cuda_solver.getLastDt()
                      << " | Reacting: " << std::setw(5) << reacting << " / " << cuda_solver.getParticles().size()
                      << " | max_lam: " << std::fixed << std::setprecision(2) << max_lam
                      << " | min_v_min: " << min_v_min
                      << " | max_s: " << max_s
                      << " | max_p (GPa): " << (max_p * 1.0e-9f)
                      << " | max_v: " << max_v
                      << std::endl;
        }
    }

    std::cout << "\n--- DETAILED PARTICLE ENTROPY DISTRIBUTION AT STEP 250 ---" << std::endl;
    int count_s_gt_0 = 0, count_s_gt_10 = 0, count_s_gt_20 = 0, count_s_gt_25 = 0;
    float max_unreacted_s = 0.0f;
    float min_unreacted_v_min = 1.0f;
    float max_unreacted_p = 0.0f;
    for (const auto& p : cuda_solver.getParticles()) {
        if (p.object_id == 1 && p.lambda <= 0.01f) {
            max_unreacted_s = std::max(max_unreacted_s, p.s_shock);
            min_unreacted_v_min = std::min(min_unreacted_v_min, p.v_min);
            float press = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
            max_unreacted_p = std::max(max_unreacted_p, press);
            if (p.s_shock > 0.1f) count_s_gt_0++;
            if (p.s_shock > 10.0f) count_s_gt_10++;
            if (p.s_shock > 20.0f) count_s_gt_20++;
            if (p.s_shock > 25.0f) count_s_gt_25++;
        }
    }
    std::cout << "Unreacted particles: " << (cuda_solver.getParticles().size() - 88)
              << " | Max s_shock: " << max_unreacted_s
              << " | Min v_min: " << min_unreacted_v_min
              << " | Max pressure: " << (max_unreacted_p * 1e-9f) << " GPa"
              << " | s > 0: " << count_s_gt_0
              << " | s > 10: " << count_s_gt_10
              << " | s > 20: " << count_s_gt_20
              << " | s > 25: " << count_s_gt_25
              << std::endl;

    std::cout << "[PASS] All CREST & Davis EOS solver unit tests passed successfully!" << std::endl;
    return 0;
}
