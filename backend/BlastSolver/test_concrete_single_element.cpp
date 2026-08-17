#include <iostream>
#include <vector>
#include <cmath>
#include <cassert>
#include <iomanip>
#include "constitutive_concrete_models.hpp"
#include "mpm_solver_3d.hpp"

using namespace Blast;

void testUniaxialCompression() {
    std::cout << "--- Test 1: Uniaxial Compression (RHT, K&C, CSCM) ---" << std::endl;

    MaterialTable3D mat;
    mat.density = 2400.0f;
    mat.youngs_modulus = 30.0e9f;
    mat.poissons_ratio = 0.20f;
    mat.fc = 30.0e6f;
    mat.ft = 3.0e6f;
    mat.G_f = 100.0f;
    mat.dif_cap_compression = 2.5f;
    mat.dif_cap_tension = 5.0f;

    // RHT params
    mat.rht_A = 1.60f; mat.rht_N = 0.61f; mat.rht_B = 0.70f; mat.rht_M = 0.80f;
    mat.rht_Q0 = 0.68f; mat.rht_BQ = 0.0105f; mat.rht_D1 = 0.04f; mat.rht_D2 = 1.0f;
    mat.rht_p_crush = 10.0e6f; mat.rht_p_lock = 6.0e9f; mat.rht_alpha0 = 1.25f; mat.rht_n_comp = 3.0f;

    // K&C params
    mat.kc_auto_generate = true;
    mat.kc_a0 = 10.0e6f; mat.kc_a1 = 0.44f; mat.kc_a2 = 0.77e-9f;
    mat.kc_a0y = 8.0e6f; mat.kc_a1y = 0.35f; mat.kc_a2y = 0.62e-9f;
    mat.kc_a1r = 0.25f; mat.kc_a2r = 0.50e-9f; mat.kc_b1 = 1.60f; mat.kc_omega = 0.50f;

    // CSCM params
    mat.cscm_alpha = 12.0e6f; mat.cscm_theta = 0.87f; mat.cscm_lambda = 9.0e6f; mat.cscm_beta = 3.33e-9f;
    mat.cscm_R = 4.0f; mat.cscm_X0 = 85.0e6f; mat.cscm_W = 0.05f; mat.cscm_D1 = 2.5e-9f; mat.cscm_D2 = 1.0f;

    float dt = 1.0f;
    float strain_rate = 1.0e-5f; // quasi-static s^-1
    float d_eps = -strain_rate * dt; // compressive
    float h_c = 0.01f;

    // 1. RHT
    {
        float sig[6] = {0};
        float ep = 0.0f, D = 0.0f;
        float max_comp_stress = 0.0f;
        for (int step = 0; step < 1000; ++step) {
            float de_l = (D == 0.0f) ? (-mat.poissons_ratio * d_eps) : (-0.5f * d_eps);
            float de[6] = { d_eps, de_l, de_l, 0, 0, 0 };
            ConcreteModels::updateRHTStress<float>(sig, de, ep, D, mat, dt, h_c);
            float p_h = -(sig[0] + sig[1] + sig[2]) / 3.0f;
            float s0 = sig[0] + p_h, s1 = sig[1] + p_h, s2 = sig[2] + p_h;
            float J2 = 0.5f * (s0*s0 + s1*s1 + s2*s2 + 2.0f*(sig[3]*sig[3] + sig[4]*sig[4] + sig[5]*sig[5]));
            float q_vm = std::sqrt(3.0f * J2);
            if (q_vm > max_comp_stress) max_comp_stress = q_vm;
        }
        std::cout << "  RHT Peak Compressive Stress: " << (max_comp_stress * 1e-6f) << " MPa (Target: ~" << (mat.fc * 1e-6f) << " MPa), Damage: " << D << std::endl;
        assert(max_comp_stress >= 0.85f * mat.fc && max_comp_stress <= 1.35f * mat.fc);
        assert(D > 0.0f);
    }

    // 2. K&C
    {
        float sig[6] = {0};
        float ep = 0.0f, D = 0.0f, lambda = 0.0f;
        float max_comp_stress = 0.0f;
        for (int step = 0; step < 1000; ++step) {
            float de_l = (D == 0.0f) ? (-mat.poissons_ratio * d_eps) : (-0.5f * d_eps);
            float de[6] = { d_eps, de_l, de_l, 0, 0, 0 };
            ConcreteModels::updateKCStress<float>(sig, de, ep, lambda, D, mat, dt, h_c);
            float p_h = -(sig[0] + sig[1] + sig[2]) / 3.0f;
            float s0 = sig[0] + p_h, s1 = sig[1] + p_h, s2 = sig[2] + p_h;
            float J2 = 0.5f * (s0*s0 + s1*s1 + s2*s2 + 2.0f*(sig[3]*sig[3] + sig[4]*sig[4] + sig[5]*sig[5]));
            float q_vm = std::sqrt(3.0f * J2);
            if (q_vm > max_comp_stress) max_comp_stress = q_vm;
        }
        std::cout << "  K&C Peak Compressive Stress: " << (max_comp_stress * 1e-6f) << " MPa (Target: ~" << (mat.fc * 1e-6f) << " MPa), Damage: " << D << std::endl;
        assert(max_comp_stress >= 0.85f * mat.fc && max_comp_stress <= 1.35f * mat.fc);
        assert(D > 0.0f);
    }

    // 3. CSCM
    {
        float sig[6] = {0};
        float ep = 0.0f, D = 0.0f, kappa = 0.0f, eps_v_p = 0.0f;
        float max_comp_stress = 0.0f;
        for (int step = 0; step < 1000; ++step) {
            float de_l = (D == 0.0f) ? (-mat.poissons_ratio * d_eps) : (-0.5f * d_eps);
            float de[6] = { d_eps, de_l, de_l, 0, 0, 0 };
            ConcreteModels::updateCSCMStress<float>(sig, de, ep, kappa, eps_v_p, D, mat, dt, h_c);
            float p_h = -(sig[0] + sig[1] + sig[2]) / 3.0f;
            float s0 = sig[0] + p_h, s1 = sig[1] + p_h, s2 = sig[2] + p_h;
            float J2 = 0.5f * (s0*s0 + s1*s1 + s2*s2 + 2.0f*(sig[3]*sig[3] + sig[4]*sig[4] + sig[5]*sig[5]));
            float q_vm = std::sqrt(3.0f * J2);
            if (q_vm > max_comp_stress) max_comp_stress = q_vm;
        }
        std::cout << "  CSCM Peak Compressive Stress: " << (max_comp_stress * 1e-6f) << " MPa (Target: ~" << (mat.fc * 1e-6f) << " MPa), Damage: " << D << std::endl;
        assert(max_comp_stress >= 0.80f * mat.fc && max_comp_stress <= 1.35f * mat.fc);
        assert(D > 0.0f);
    }
    std::cout << "  [PASS] Uniaxial Compression validation successful.\n" << std::endl;
}

void testTriaxialConfinement() {
    std::cout << "--- Test 2: Triaxial Confinement (RHT, K&C, CSCM) ---" << std::endl;

    MaterialTable3D mat;
    mat.density = 2400.0f;
    mat.youngs_modulus = 30.0e9f;
    mat.poissons_ratio = 0.20f;
    mat.fc = 30.0e6f;
    mat.ft = 3.0e6f;
    mat.G_f = 100.0f;
    mat.rht_A = 1.60f; mat.rht_N = 0.61f; mat.rht_B = 0.70f; mat.rht_M = 0.80f;
    mat.rht_Q0 = 0.68f; mat.rht_BQ = 0.0105f; mat.rht_D1 = 0.04f; mat.rht_D2 = 1.0f;
    mat.rht_p_crush = 10.0e6f; mat.rht_p_lock = 6.0e9f; mat.rht_alpha0 = 1.25f; mat.rht_n_comp = 3.0f;

    mat.kc_auto_generate = true;
    mat.kc_a0 = 10.0e6f; mat.kc_a1 = 0.44f; mat.kc_a2 = 0.77e-9f;
    mat.kc_a0y = 8.0e6f; mat.kc_a1y = 0.35f; mat.kc_a2y = 0.62e-9f;
    mat.kc_a1r = 0.25f; mat.kc_a2r = 0.50e-9f; mat.kc_b1 = 1.60f; mat.kc_omega = 0.50f;

    mat.cscm_alpha = 10.5e6f; mat.cscm_theta = 0.40f; mat.cscm_lambda = 7.0e6f; mat.cscm_beta = 1.5e-8f;
    mat.cscm_R = 4.0f; mat.cscm_X0 = 85.0e6f; mat.cscm_W = 0.05f; mat.cscm_D1 = 2.5e-9f; mat.cscm_D2 = 1.0f;

    float dt = 1.0e-5f;
    float d_eps = -10.0f * dt;
    float h_c = 0.01f;
    float p_conf = 20.0e6f; // 20 MPa hydrostatic pre-confinement

    // 1. RHT Triaxial
    {
        float sig[6] = { -p_conf, -p_conf, -p_conf, 0, 0, 0 };
        float ep = 0.0f, D = 0.0f;
        float max_axial = 0.0f;
        for (int step = 0; step < 800; ++step) {
            float de[6] = { d_eps, 0, 0, 0, 0, 0 };
            ConcreteModels::updateRHTStress<float>(sig, de, ep, D, mat, dt, h_c);
            if (-sig[0] > max_axial) max_axial = -sig[0];
        }
        float diff_stress = max_axial - p_conf;
        std::cout << "  RHT Confined Peak Axial: " << (max_axial * 1e-6f) << " MPa (Differential: " << (diff_stress * 1e-6f) << " MPa vs Unconfined fc = 30 MPa)" << std::endl;
        assert(diff_stress > mat.fc); // Confinement hardening effect
    }

    // 2. K&C Triaxial
    {
        float sig[6] = { -p_conf, -p_conf, -p_conf, 0, 0, 0 };
        float ep = 0.0f, D = 0.0f, lambda = 0.0f;
        float max_axial = 0.0f;
        for (int step = 0; step < 800; ++step) {
            float de[6] = { d_eps, 0, 0, 0, 0, 0 };
            ConcreteModels::updateKCStress<float>(sig, de, ep, lambda, D, mat, dt, h_c);
            if (-sig[0] > max_axial) max_axial = -sig[0];
        }
        float diff_stress = max_axial - p_conf;
        std::cout << "  K&C Confined Peak Axial: " << (max_axial * 1e-6f) << " MPa (Differential: " << (diff_stress * 1e-6f) << " MPa vs Unconfined fc = 30 MPa)" << std::endl;
        assert(diff_stress > mat.fc);
    }

    // 3. CSCM Triaxial
    {
        float sig[6] = { -p_conf, -p_conf, -p_conf, 0, 0, 0 };
        float ep = 0.0f, D = 0.0f, kappa = 0.0f, eps_v_p = 0.0f;
        float max_axial = 0.0f;
        for (int step = 0; step < 800; ++step) {
            float de[6] = { d_eps, 0, 0, 0, 0, 0 };
            ConcreteModels::updateCSCMStress<float>(sig, de, ep, kappa, eps_v_p, D, mat, dt, h_c);
            if (-sig[0] > max_axial) max_axial = -sig[0];
        }
        float diff_stress = max_axial - p_conf;
        std::cout << "  CSCM Confined Peak Axial: " << (max_axial * 1e-6f) << " MPa (Differential: " << (diff_stress * 1e-6f) << " MPa vs Unconfined fc = 30 MPa)" << std::endl;
        assert(diff_stress > mat.fc);
    }
    std::cout << "  [PASS] Triaxial Confinement shear enhancement verified.\n" << std::endl;
}

void testTensileSofteningAndFractureEnergy() {
    std::cout << "--- Test 3: Uniaxial Tension & Mesh Regularization (G_f/h) ---" << std::endl;

    MaterialTable3D mat;
    mat.density = 2400.0f;
    mat.youngs_modulus = 30.0e9f;
    mat.poissons_ratio = 0.20f;
    mat.fc = 30.0e6f;
    mat.ft = 3.0e6f;
    mat.G_f = 90.0f; // 90 N/m fracture energy
    mat.rht_A = 1.60f; mat.rht_N = 0.61f; mat.rht_B = 0.70f; mat.rht_M = 0.80f;
    mat.rht_Q0 = 0.68f; mat.rht_BQ = 0.0105f; mat.rht_D1 = 0.04f; mat.rht_D2 = 1.0f;
    mat.rht_p_crush = 10.0e6f; mat.rht_p_lock = 6.0e9f; mat.rht_alpha0 = 1.25f; mat.rht_n_comp = 3.0f;

    float dt = 1.0f;
    float d_eps = 4.0e-6f; // quasi-static tensile strain increment (total strain 0.0040 > failure strain)

    // Compare two mesh sizes: h1 = 0.01m vs h2 = 0.02m
    float h1 = 0.01f;
    float h2 = 0.02f;

    float energy1 = 0.0f;
    float energy2 = 0.0f;

    // Element 1 (h1)
    {
        float sig[6] = {0};
        float ep = 0.0f, D = 0.0f;
        float max_tensile = 0.0f;
        float de_lat = -mat.poissons_ratio * d_eps;
        for (int step = 0; step < 2500; ++step) {
            sig[1] = 0; sig[2] = 0; sig[3] = 0; sig[4] = 0; sig[5] = 0;
            float de[6] = { d_eps, de_lat, de_lat, 0, 0, 0 };
            ConcreteModels::updateRHTStress<float>(sig, de, ep, D, mat, dt, h1);
            if (sig[0] > max_tensile) max_tensile = sig[0];
            energy1 += sig[0] * d_eps * h1; // Dissipated energy per unit crack area (N/m)
        }
        std::cout << "  h = " << h1 << " m: Peak Tensile: " << (max_tensile * 1e-6f) << " MPa (ft = " << (mat.ft * 1e-6f) << " MPa), Dissipated Energy per Area: " << energy1 << " N/m" << std::endl;
        assert(max_tensile >= 0.85f * mat.ft && max_tensile <= 2.0f * mat.ft);
        assert(D >= 0.90f);
    }

    // Element 2 (h2)
    {
        float sig[6] = {0};
        float ep = 0.0f, D = 0.0f;
        float max_tensile = 0.0f;
        float de_lat = -mat.poissons_ratio * d_eps;
        for (int step = 0; step < 2500; ++step) {
            sig[1] = 0; sig[2] = 0; sig[3] = 0; sig[4] = 0; sig[5] = 0;
            float de[6] = { d_eps, de_lat, de_lat, 0, 0, 0 };
            ConcreteModels::updateRHTStress<float>(sig, de, ep, D, mat, dt, h2);
            if (sig[0] > max_tensile) max_tensile = sig[0];
            energy2 += sig[0] * d_eps * h2;
        }
        std::cout << "  h = " << h2 << " m: Peak Tensile: " << (max_tensile * 1e-6f) << " MPa (ft = " << (mat.ft * 1e-6f) << " MPa), Dissipated Energy per Area: " << energy2 << " N/m" << std::endl;
        assert(max_tensile >= 0.85f * mat.ft && max_tensile <= 2.0f * mat.ft);
        assert(D >= 0.90f);
    }

    // Verify mesh objectivity: energy dissipated per unit crack area is preserved regardless of h
    float energy_ratio = energy1 / energy2;
    std::cout << "  Mesh Objectivity Energy Ratio (E_h1 / E_h2): " << energy_ratio << " (Target: ~1.0)" << std::endl;
    assert(energy_ratio > 0.80f && energy_ratio < 1.25f);
    std::cout << "  [PASS] Tensile softening and fracture energy regularization validated.\n" << std::endl;
}

void testDynamicIncreaseFactor() {
    std::cout << "--- Test 4: Dynamic Increase Factor (DIF) Rate Sensitivity ---" << std::endl;

    MaterialTable3D mat;
    mat.fc = 30.0e6f;
    mat.ft = 3.0e6f;
    mat.dif_cap_compression = 2.5f;
    mat.dif_cap_tension = 5.0f;
    mat.rht_betac = 0.032f;
    mat.rht_deltat = 0.036f;

    float eps_dot_static = 1.0e-6f;
    float eps_dot_blast = 100.0f;
    float eps_dot_extreme = 1.0e15f;

    float dif_c_static = ConcreteModels::computeDIFCompression(eps_dot_static, mat);
    float dif_c_blast = ConcreteModels::computeDIFCompression(eps_dot_blast, mat);
    float dif_c_extreme = ConcreteModels::computeDIFCompression(eps_dot_extreme, mat);

    float dif_t_static = ConcreteModels::computeDIFTension(eps_dot_static, mat);
    float dif_t_blast = ConcreteModels::computeDIFTension(eps_dot_blast, mat);
    float dif_t_extreme = ConcreteModels::computeDIFTension(eps_dot_extreme, mat);

    std::cout << "  DIF Compression: Static = " << dif_c_static << ", Blast (100/s) = " << dif_c_blast << ", Extreme = " << dif_c_extreme << " (Cap: " << mat.dif_cap_compression << ")" << std::endl;
    std::cout << "  DIF Tension:     Static = " << dif_t_static << ", Blast (100/s) = " << dif_t_blast << ", Extreme = " << dif_t_extreme << " (Cap: " << mat.dif_cap_tension << ")" << std::endl;

    assert(dif_c_static == 1.0f);
    assert(dif_c_blast > 1.2f && dif_c_blast <= mat.dif_cap_compression);
    assert(dif_c_extreme == mat.dif_cap_compression);

    assert(dif_t_static == 1.0f);
    assert(dif_t_blast > 1.5f && dif_t_blast <= mat.dif_cap_tension);
    assert(dif_t_extreme == mat.dif_cap_tension);

    std::cout << "  [PASS] DIF rate sensitivity and saturation caps verified.\n" << std::endl;
}

void testMoistureSaturationAndCrush() {
    std::cout << "--- Test 5: Moisture Saturation & P-alpha Pore Compaction ---" << std::endl;

    MaterialTable3D mat_dry;
    mat_dry.density = 2350.0f;
    mat_dry.youngs_modulus = 33.0e9f;
    mat_dry.poissons_ratio = 0.20f;
    mat_dry.moisture_content = 0.0f;
    mat_dry.rht_alpha0 = 1.25f;
    mat_dry.rht_p_crush = 10.0e6f;
    mat_dry.rht_p_lock = 6.0e9f;
    mat_dry.rht_n_comp = 3.0f;

    MaterialTable3D mat_sat = mat_dry;
    mat_sat.moisture_content = 0.05f; // 5% moisture by mass

    float p_mid = 100.0e6f; // Between p_crush and p_lock
    float alpha_dry = ConcreteModels::computeAlpha(p_mid, mat_dry);
    float alpha_sat = ConcreteModels::computeAlpha(p_mid, mat_sat);

    std::cout << "  P-alpha Porosity at p = 100 MPa: Dry alpha = " << alpha_dry << ", Saturated alpha = " << alpha_sat << std::endl;
    assert(alpha_dry > 1.0f && alpha_dry < mat_dry.rht_alpha0);
    assert(alpha_sat < alpha_dry); // Moisture accelerates compaction / stiffens pores

    std::cout << "  [PASS] Moisture saturation and pore compaction verified.\n" << std::endl;
}

void testUnilateralCrackClosure() {
    std::cout << "--- Test 6: Unilateral Crack Closure ---" << std::endl;

    MaterialTable3D mat;
    mat.density = 2400.0f;
    mat.youngs_modulus = 30.0e9f;
    mat.poissons_ratio = 0.20f;
    mat.fc = 30.0e6f;
    mat.ft = 3.0e6f;
    mat.G_f = 100.0f;
    mat.rht_A = 1.60f; mat.rht_N = 0.61f; mat.rht_B = 0.70f; mat.rht_M = 0.80f;
    mat.rht_Q0 = 0.68f; mat.rht_BQ = 0.0105f; mat.rht_D1 = 0.04f; mat.rht_D2 = 1.0f;
    mat.rht_p_crush = 10.0e6f; mat.rht_p_lock = 6.0e9f; mat.rht_alpha0 = 1.25f; mat.rht_n_comp = 3.0f;

    float dt = 1.0e-5f;
    float h_c = 0.01f;
    float sig[6] = {0};
    float ep = 0.0f, D = 0.0f;

    // 1. Apply tensile deformation to produce heavy damage
    for (int step = 0; step < 400; ++step) {
        float de[6] = { 1.0f * dt, 0, 0, 0, 0, 0 };
        ConcreteModels::updateRHTStress<float>(sig, de, ep, D, mat, dt, h_c);
    }
    std::cout << "  After Tension: Damage D = " << D << ", Tensile Stress = " << (sig[0] * 1e-6f) << " MPa" << std::endl;
    assert(D > 0.5f);

    // 2. Reverse loading to compression (crack closure)
    float comp_stress = 0.0f;
    for (int step = 0; step < 500; ++step) {
        float de[6] = { -5.0f * dt, 0, 0, 0, 0, 0 };
        ConcreteModels::updateRHTStress<float>(sig, de, ep, D, mat, dt, h_c);
        if (-sig[0] > comp_stress) comp_stress = -sig[0];
    }
    std::cout << "  Under Reversed Compression: Peak Stress = " << (comp_stress * 1e-6f) << " MPa" << std::endl;
    assert(comp_stress > 15.0e6f); // Compression stiffness recovered despite tensile crack damage
    std::cout << "  [PASS] Unilateral crack closure stiffness recovery verified.\n" << std::endl;
}

int main() {
    std::cout << "=================================================================" << std::endl;
    std::cout << "   BlastSolver Concrete Constitutive Models Single-Element Tests  " << std::endl;
    std::cout << "=================================================================\n" << std::endl;

    testUniaxialCompression();
    testTriaxialConfinement();
    testTensileSofteningAndFractureEnergy();
    testDynamicIncreaseFactor();
    testMoistureSaturationAndCrush();
    testUnilateralCrackClosure();

    std::cout << "=================================================================" << std::endl;
    std::cout << "   ALL SINGLE ELEMENT CONCRETE TESTS PASSED SUCCESSFULLY!       " << std::endl;
    std::cout << "=================================================================" << std::endl;
    return 0;
}
