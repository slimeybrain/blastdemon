#include "fem_solver_3d.hpp"
#include "fem_contact_3d.hpp"
#include "mpm_solver_3d.hpp"
#include <iostream>
#include <vector>
#include <cassert>
#include <cmath>

using namespace Blast;

void test_mpm_debris_hex_contact() {
    std::cout << "==========================================================" << std::endl;
    std::cout << "=== TEST 1: MPM Debris vs Intact Solid Hex FEM Contact ===" << std::endl;
    std::cout << "==========================================================" << std::endl;

    FEMSolver3D<float> fem_solver;
    MaterialTable3D mat;
    mat.density = 2400.0f;
    mat.youngs_modulus = 30.0e9f;
    mat.poissons_ratio = 0.20f;
    mat.yield_stress = 30.0e6f;

    // Create a 1x1x1 solid concrete hex block at X in [0.0, 1.0], Y in [0.0, 1.0], Z in [0.0, 1.0]
    fem_solver.createStructuredBoxMesh(1, 1, 1, 1.0f, 1.0f, 1.0f, 0.0f, 0.0f, 0.0f, mat, "Free");
    fem_solver.setContactPenaltyScale(1.0f);

    // Fix back face nodes at X = 1.0
    for (int nid = 0; nid < static_cast<int>(fem_solver.getNodes().size()); ++nid) {
        if (fem_solver.getNodes()[nid].x[0] > 0.9f) {
            fem_solver.setNodeFixed(nid, true, true, true);
        }
    }

    MPMSolver3D mpm_solver;
    mpm_solver.initializeGrid(32, 32, 32, 0.1f, 0.1f, 0.1f, -1.0f, -1.0f, -1.0f);

    // Create an incoming MPM debris particle at X = -0.005 (just penetrating front facet at X = 0.0)
    // Moving towards the hex block at v_x = +100 m/s
    MPMParticle3D debris_p{};
    debris_p.x[0] = -0.005f;
    debris_p.x[1] = 0.5f;
    debris_p.x[2] = 0.5f;
    debris_p.v[0] = 100.0f;
    debris_p.v[1] = 0.0f;
    debris_p.v[2] = 0.0f;
    debris_p.m = 0.05f; // 50 grams
    debris_p.V = 0.05f / 2400.0f;
    debris_p.V0 = debris_p.V;
    debris_p.lp[0] = 0.01f; // 10mm effective radius
    debris_p.lp[1] = 0.01f;
    debris_p.lp[2] = 0.01f;
    debris_p.has_failed = true; // Debris flag

    mpm_solver.addParticleDirect(debris_p);

    FEMContact3D<float> contact;
    contact.setContactPenaltyScale(1.0f);
    contact.setContactDamping(0.1f);
    contact.setFrictionCoefficients(0.3f, 0.2f);

    float dt = 1.0e-5f;
    contact.solveMPMFacetContact(fem_solver, mpm_solver, dt);

    auto& p_after = mpm_solver.getParticles()[0];
    std::cout << "  Initial debris velocity: v_x = +100.0 m/s" << std::endl;
    std::cout << "  Post-contact velocity:   v_x = " << p_after.v[0] << " m/s" << std::endl;

    // Contact penalty force must decelerate/rebound the particle (v_x < 100.0 m/s)
    assert(p_after.v[0] < 100.0f);

    // Verify reaction force applied to front facet FEM nodes (X = 0)
    float total_fem_fx = 0.0f;
    for (const auto& node : fem_solver.getNodes()) {
        if (node.x[0] < 0.1f) {
            total_fem_fx += node.f_contact[0];
        }
    }
    std::cout << "  Total FEM contact force on front facet: F_x = " << total_fem_fx << " N" << std::endl;
    assert(total_fem_fx > 0.0f); // Positive X reaction force pushing back into the hex block

    std::cout << "  ✓ Debris-to-Hex Contact & Reaction Force Validation PASSED!" << std::endl;
}

void test_native_mpm_projectile_hex_contact() {
    std::cout << "===========================================================" << std::endl;
    std::cout << "=== TEST 2: Native MPM Projectile vs FEM Solid Hex Wall ===" << std::endl;
    std::cout << "===========================================================" << std::endl;

    FEMSolver3D<float> fem_solver;
    MaterialTable3D steel_armor;
    steel_armor.density = 7850.0f;
    steel_armor.youngs_modulus = 200.0e9f;
    steel_armor.poissons_ratio = 0.29f;
    steel_armor.yield_stress = 800.0e6f;

    // Create a 2x2x2 solid steel armor plate at X in [0.0, 0.2], Y in [0.0, 1.0], Z in [0.0, 1.0]
    fem_solver.createStructuredBoxMesh(2, 2, 2, 0.2f, 1.0f, 1.0f, 0.0f, 0.0f, 0.0f, steel_armor, "Free");
    fem_solver.setContactPenaltyScale(1.0f);

    // Fix back face
    for (int nid = 0; nid < static_cast<int>(fem_solver.getNodes().size()); ++nid) {
        if (fem_solver.getNodes()[nid].x[0] > 0.19f) {
            fem_solver.setNodeFixed(nid, true, true, true);
        }
    }

    MPMSolver3D mpm_solver;
    mpm_solver.initializeGrid(32, 32, 32, 0.05f, 0.05f, 0.05f, -0.5f, -0.5f, -0.5f);

    // Launch a cluster of 8 native MPM particles representing a high-speed steel impactor
    // at X = -0.004, moving towards armor plate at v_x = +400 m/s
    for (int i = 0; i < 8; ++i) {
        MPMParticle3D p{};
        p.x[0] = -0.004f + 0.001f * (i % 2);
        p.x[1] = 0.48f + 0.02f * ((i / 2) % 2);
        p.x[2] = 0.48f + 0.02f * (i / 4);
        p.v[0] = 400.0f;
        p.v[1] = 0.0f;
        p.v[2] = 0.0f;
        p.m = 0.02f; // 20g
        p.V = 0.02f / 7850.0f;
        p.V0 = p.V;
        p.lp[0] = 0.008f;
        p.lp[1] = 0.008f;
        p.lp[2] = 0.008f;
        p.has_failed = false; // Native intact MPM particle
        mpm_solver.addParticleDirect(p);
    }

    fem_solver.setMPMSolver(&mpm_solver);

    std::cout << "  Simulating steps with full FEMSolver3D::stepWithDt..." << std::endl;
    float dt = 5.0e-7f;
    for (int step = 0; step < 5; ++step) {
        fem_solver.stepWithDt(dt);
    }

    float avg_vx = 0.0f;
    for (const auto& p : mpm_solver.getParticles()) {
        avg_vx += p.v[0];
    }
    avg_vx /= mpm_solver.getParticles().size();

    std::cout << "  Initial projectile velocity: v_x = +400.0 m/s" << std::endl;
    std::cout << "  Post-impact average velocity: v_x = " << avg_vx << " m/s" << std::endl;

    // Contact with solid hex plate must have strongly decelerated the particles
    assert(avg_vx < 400.0f);

    std::cout << "  ✓ Native MPM vs Solid Hex Contact Validation PASSED!" << std::endl;
}

int main() {
    test_mpm_debris_hex_contact();
    test_native_mpm_projectile_hex_contact();
    std::cout << "\n>>> ALL MPM-TO-HEX FEM CONTACT TESTS PASSED! <<<\n" << std::endl;
    return 0;
}
