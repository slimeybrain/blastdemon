#include "constitutive_crest_davis.hpp"
#include "mpm_solver_3d.hpp"
#include <iostream>
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

    // 7. MPMSolver3D with Linear Elastic and CREST Reactive Burn
    MPMSolver3D solver;
    solver.initializeGrid(16, 16, 16, 0.01f, 0.01f, 0.01f, 0.0f, 0.0f, 0.0f);
    
    // Object 1: Linear Elastic steel
    solver.addBoxObject(1, 0.04f, 0.04f, 0.04f, 0.02f, 0.02f, 0.02f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 7850.0f, 200.0e9f, 0.29f, 250.0e6f, 1.0e9f, 0.20f, 400.0e6f, 8);
    auto& mat1 = solver.getMaterialTables()[1];
    mat1.material_model = MPMMaterialModel::LinearElastic;

    // Object 2: CREST Reactive Burn HE
    solver.addSphereObject(2, 0.08f, 0.08f, 0.08f, 0.015f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1895.0f, 10.0e9f, 0.35f, 50.0e6f, 100.0e6f, 0.10f, 60.0e6f, 8);
    auto& mat2 = solver.getMaterialTables()[2];
    mat2.material_model = MPMMaterialModel::CRESTReactiveBurn;
    mat2.davis_c0 = c0; mat2.davis_s1 = s1; mat2.davis_gamma0 = gamma0; mat2.davis_cv = cv; mat2.davis_t0 = t0; mat2.davis_rho0 = rho0;
    mat2.davis_a = a; mat2.davis_b = b; mat2.davis_k = k; mat2.davis_vc = vc; mat2.davis_pc = pc; mat2.davis_q_det = q_det;
    mat2.crest_b1 = b1; mat2.crest_c1 = c1; mat2.crest_m1 = m1; mat2.crest_b2 = b2; mat2.crest_c2 = c2; mat2.crest_c3 = c3; mat2.crest_m2 = m2; mat2.crest_s0 = s0; mat2.crest_s_threshold = s_thresh;

    // Hot-spot initiate center particle of Object 2
    for (auto& p : solver.getParticles()) {
        if (p.object_id == 2) {
            float dist = std::sqrt(std::pow(p.x[0] - 0.08f, 2) + std::pow(p.x[1] - 0.08f, 2) + std::pow(p.x[2] - 0.08f, 2));
            if (dist < 0.005f) {
                p.s_shock = 1.5f * s_thresh;
                p.lambda = 1.0f;
                p.e_int = q_det;
            }
        }
    }

    // Step solver
    for (int step = 0; step < 5; ++step) {
        solver.step(1.0e-7f);
    }

    std::cout << "[PASS] All CREST & Davis EOS solver unit tests passed successfully!" << std::endl;
    return 0;
}
