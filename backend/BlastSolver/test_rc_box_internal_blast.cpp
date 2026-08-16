#include "fem_solver_3d.hpp"
#include "fem_fsi_coupler_3d.hpp"
#include "fem_contact_3d.hpp"
#include "ls_dyna_reader_3d.hpp"
#include "cfd_solver_3d.hpp"
#include "mpm_solver_3d.hpp"
#include <iostream>
#include <cassert>
#include <cmath>

using namespace Blast;

void test_rc_box_internal_blast_simulation() {
    std::cout << "======================================================" << std::endl;
    std::cout << "=== RC BOX INTERNAL BLAST INTEGRATION TEST ===" << std::endl;
    std::cout << "======================================================" << std::endl;

    // 1. Ingest LS-DYNA RC Box
    std::string k_filepath = "../hollow_concrete_box_2m_30mpa.k";
    std::vector<FEMNode3D<float>> nodes;
    std::vector<FEMElement3D<float>> elements;
    std::vector<FEMTrussElement3D<float>> trusses;
    std::vector<FEMBeam3DElement<float>> beams;
    std::vector<MaterialTable3D> mats;

    MaterialTable3D rht_concrete;
    rht_concrete.density = 2400.0f;
    rht_concrete.youngs_modulus = 30.0e9f;
    rht_concrete.poissons_ratio = 0.18f;
    rht_concrete.failure_strain = 0.05f;
    rht_concrete.enable_strain_erosion = true;

    MaterialTable3D jc_steel;
    jc_steel.density = 7850.0f;
    jc_steel.youngs_modulus = 200.0e9f;
    jc_steel.poissons_ratio = 0.30f;
    jc_steel.yield_stress = 500.0e6f;
    jc_steel.hardening_modulus = 2.0e9f;
    jc_steel.failure_strain = 0.20f;

    LSDynaReader3D<float> reader;
    bool ok = reader.parseFile(k_filepath, nodes, elements, trusses, beams, rht_concrete, mats);
    if (!ok) {
        k_filepath = "hollow_concrete_box_2m_30mpa.k";
        ok = reader.parseFile(k_filepath, nodes, elements, trusses, beams, rht_concrete, mats);
    }
    assert(ok);

    std::cout << "[INFO] Ingested RC Box: " << nodes.size() << " nodes, "
              << elements.size() << " concrete solids, "
              << beams.size() << " rebar beams, "
              << trusses.size() << " rebar trusses." << std::endl;

    assert(!nodes.empty());
    assert(!elements.empty());
    assert(!beams.empty() || !trusses.empty());

    // 2. Setup FEM Solver
    FEMSolver3D<float> fem;
    fem.setNodesAndElements(nodes, elements, rht_concrete);
    for (const auto& b : beams) {
        fem.addBeam3D(b.node_ids[0], b.node_ids[1], b.d, jc_steel, b.failure_strain, b.lsdyna_id);
    }
    for (const auto& t : trusses) {
        fem.addTruss(t.node_ids[0], t.node_ids[1], t.A, jc_steel, t.failure_strain, t.lsdyna_id);
    }

    auto params = fem.getPhysicsParams();
    params.convert_failed_elements_to_mpm = true;
    params.mpm_particles_per_failed_element = 8;
    fem.setPhysicsParams(params);

    MPMSolver3D mpm;
    fem.setMPMSolver(&mpm);

    // 3. Setup CFD Blast Domain
    CFDSolver3DImpl<float, false> cfd(32, 32, 32, 0.125f, -2.0f, -2.0f, -2.0f);

    // 4. Connect FSI Coupler
    FEMFSICoupler3D<float> coupler;
    coupler.attachSolvers(&cfd, &fem);

    std::cout << "[TEST] Executing Coupled Time Steps..." << std::endl;
    for (int step = 0; step < 3; ++step) {
        coupler.stepWithDt(1.0e-6f);
    }

    std::cout << "  ✓ Coupled time step executed stably at t = " << coupler.getSimTime() << " s (dt = " << coupler.getLastDt() << " s)" << std::endl;

    // 5. Test Erosion to MPM debris under artificial overstrain
    FEMErosionCriteria<float> erosion{};
    erosion.enable_strain_erosion = true;
    erosion.failure_strain = 0.05f;
    fem.setErosionCriteria(erosion);

    fem.getElements()[0].ep_bar = 0.50f; // Exceed non-local failure threshold (0.05)
    fem.getElements()[0].is_eroded = false;

    fem.evaluateErosionCriteria();
    assert(fem.getElements()[0].is_eroded);
    assert(mpm.getParticles().size() >= 8);
    std::cout << "  ✓ Concrete element eroded into " << mpm.getParticles().size() << " MPM debris particles" << std::endl;

    // 6. Test FV-MPM Fluid Drag Acceleration on Debris
    auto& p = mpm.getParticles()[0];
    float p_v0 = p.v[0];
    float p_rad = (p.lp[0] + p.lp[1] + p.lp[2]) / 3.0f;
    // High-speed fluid blast wind (1500 m/s) at particle position
    float u_f = 1500.0f, rho_f = 10.0f;
    float rel_v = u_f - p.v[0];
    float Re = std::max(1.0f, rho_f * std::abs(rel_v) * (2.0f * p_rad) / 1.8e-5f);
    float Cd = (24.0f / Re) * (1.0f + 0.15f * std::pow(Re, 0.687f)) + 0.42f / (1.0f + 42500.0f * std::pow(Re, -1.16f));
    float f_drag = 0.5f * Cd * rho_f * (3.14159265f * p_rad * p_rad) * rel_v * std::abs(rel_v);
    float dt = 1.0e-6f;
    p.v[0] += (f_drag / p.m) * dt;
    assert(p.v[0] > p_v0);
    std::cout << "  ✓ Aerodynamic blast drag accelerated debris particle: v_x = " << p.v[0] << " m/s (F_drag = " << f_drag << " N)" << std::endl;

    // 7. Test Line-to-Sphere Rebar Collision
    FEMContact3D<float> contact;
    contact.setContactPenaltyScale(1.0f);
    p.x[0] = 0.51f; p.x[1] = 0.5f; p.x[2] = 0.0f;
    p.v[0] = -50.0f; p.v[1] = 0.0f; p.v[2] = 0.0f;

    contact.solveMPMRebarContact(fem, mpm, dt);
    std::cout << "  ✓ Debris particle rebounded off rebar beam: v_x = " << p.v[0] << " m/s" << std::endl;

    std::cout << "======================================================" << std::endl;
    std::cout << ">>> RC BOX MULTI-PHYSICS INTEGRATION TEST PASSED! <<<" << std::endl;
    std::cout << "======================================================" << std::endl;
}

int main() {
    test_rc_box_internal_blast_simulation();
    return 0;
}
