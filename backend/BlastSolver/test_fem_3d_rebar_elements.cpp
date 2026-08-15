#include "fem_solver_3d.hpp"
#include "fem_contact_3d.hpp"
#include "ls_dyna_reader_3d.hpp"
#include <iostream>
#include <cassert>
#include <cmath>
#include <fstream>
#include <sstream>

using namespace Blast;

void test_1d_axial_truss() {
    std::cout << "[TEST] Running 1D Axial Truss Formulation Verification..." << std::endl;

    FEMSolver3D<double> solver;
    // Add two nodes along X-axis: L0 = 1.0 m
    int n0 = solver.addNode(0.0, 0.0, 0.0, 1.0);
    int n1 = solver.addNode(1.0, 0.0, 0.0, 1.0);

    MaterialTable3D steel_mat;
    steel_mat.density = 7850.0f;
    steel_mat.youngs_modulus = 200.0e9f; // 200 GPa
    steel_mat.yield_stress = 500.0e6f;   // 500 MPa
    steel_mat.hardening_modulus = 2.0e9f;// 2 GPa
    steel_mat.failure_strain = 0.15f;    // 15% failure strain

    double diameter = 0.012; // 12 mm rebar
    double area = M_PI * diameter * diameter * 0.25; // ~1.131e-4 m^2

    solver.addTruss(n0, n1, area, steel_mat, steel_mat.failure_strain);

    // 1. Verify zero rotational DOFs allocated
    assert(solver.getRotationalNodes().empty());
    assert(solver.getTrusses().size() == 1);
    std::cout << "  ✓ Zero rotational DOFs allocated for 1D truss" << std::endl;

    // 2. Elastic tension test: stretch by 1 mm (strain = 1e-3, stress = 200 MPa < 500 MPa)
    auto& nodes = solver.getNodes();
    nodes[1].x[0] = 1.001; // Delta L = 0.001 m
    double dt = 1.0e-6;
    solver.computeTrussForces1D(dt);

    const auto& truss = solver.getTrusses()[0];
    double expected_stress = 200.0e9 * 0.001; // 200 MPa
    double expected_force = expected_stress * area; // ~22.62 kN

    assert(std::abs(truss.sigma - expected_stress) / expected_stress < 1.0e-4);
    assert(std::abs(nodes[1].f_int[0] - expected_force) / expected_force < 1.0e-4);
    assert(std::abs(nodes[0].f_int[0] + expected_force) / expected_force < 1.0e-4);
    std::cout << "  ✓ Elastic axial stiffness and internal force accumulation verified (N = " << expected_force << " N)" << std::endl;

    // 3. Plastic yield test: stretch by 5 mm (strain = 5e-3, elastic trial = 1000 MPa > 500 MPa)
    nodes[1].x[0] = 1.005;
    solver.computeTrussForces1D(dt);
    double dep = (1000.0e6 - 500.0e6) / (200.0e9 + 2.0e9);
    double expected_plastic_stress = 500.0e6 + 2.0e9 * dep;
    assert(std::abs(truss.sigma - expected_plastic_stress) / expected_plastic_stress < 1.0e-3);
    assert(truss.ep_bar > 0.0 && !truss.is_eroded);
    std::cout << "  ✓ Bilinear elastoplastic yielding with hardening verified (sigma_y = " << truss.sigma * 1e-6 << " MPa, ep_bar = " << truss.ep_bar << ")" << std::endl;

    // 4. Failure erosion test: stretch beyond failure strain (strain = 0.20 > 0.15)
    nodes[1].x[0] = 1.20;
    solver.computeTrussForces1D(dt);
    assert(solver.getTrusses()[0].is_eroded);
    std::cout << "  ✓ Plastic failure strain erosion verified" << std::endl;
}

void test_3d_timoshenko_beam() {
    std::cout << "[TEST] Running 3D Timoshenko Beam Formulation Verification..." << std::endl;

    FEMSolver3D<double> solver;
    int n0 = solver.addNode(0.0, 0.0, 0.0, 1.0);
    int n1 = solver.addNode(1.0, 0.0, 0.0, 1.0);

    MaterialTable3D steel_mat;
    steel_mat.density = 7850.0f;
    steel_mat.youngs_modulus = 200.0e9f;
    steel_mat.poissons_ratio = 0.30f;
    steel_mat.yield_stress = 500.0e6f;
    steel_mat.hardening_modulus = 2.0e9f;
    steel_mat.failure_strain = 0.20f;

    double diameter = 0.020; // 20 mm diameter beam
    solver.addBeam3D(n0, n1, diameter, steel_mat, steel_mat.failure_strain);

    // 1. Verify sparse rotational DOFs allocated ONLY for the 2 beam nodes
    assert(solver.getBeams().size() == 1);
    assert(solver.getRotationalNodes().size() == 2);
    std::cout << "  ✓ Sparse rotational table allocated exactly 2 rotational nodes (m_rot_nodes = " << solver.getRotationalNodes().size() << ")" << std::endl;

    const auto& beam = solver.getBeams()[0];
    // 2. Verify orthonormal cross-section triad (e1 along X, e2, e3 orthogonal in Y-Z plane)
    assert(std::abs(beam.e2[0]) < 1.0e-6 && std::abs(beam.e3[0]) < 1.0e-6);
    double dot_e23 = beam.e2[0]*beam.e3[0] + beam.e2[1]*beam.e3[1] + beam.e2[2]*beam.e3[2];
    assert(std::abs(dot_e23) < 1.0e-6);
    std::cout << "  ✓ Initial co-rotational triad e1, e2, e3 is orthonormal" << std::endl;

    // 3. Cantilever bending moment test
    auto& rot_nodes = solver.getRotationalNodes();
    double dt = 1.0e-6;
    // Apply curvature rate by setting angular velocity omega_z at node 1
    rot_nodes[1].omega[2] = 1.0; // 1 rad/s about Z-axis
    solver.computeBeamForces3D(dt);

    assert(solver.getBeams()[0].kappa3 > 0.0);
    assert(std::abs(rot_nodes[1].m_int[2]) > 0.0);
    std::cout << "  ✓ Bending moment and angular momentum accumulation verified (M_z = " << rot_nodes[1].m_int[2] << " N*m)" << std::endl;

    // 4. Plastic moment capacity cap verification (Pure bending with zero transverse shear)
    rot_nodes[0].omega[2] = -1.0e6;
    rot_nodes[1].omega[2] = 1.0e6; // Force huge curvature with w_avg = 0
    solver.computeBeamForces3D(dt);
    double Mp_expected = beam.Zp * 500.0e6; // Mp = Zp * sigma_y
    double M_actual = std::abs(rot_nodes[1].m_int[2]);
    // Internal moment in pure bending should be strictly capped at Mp
    assert(M_actual <= Mp_expected * 1.01 && M_actual >= Mp_expected * 0.99);
    std::cout << "  ✓ Plastic moment capacity limit enforced (Mp = " << Mp_expected << " N*m, M_actual = " << M_actual << " N*m)" << std::endl;
}

void test_ls_dyna_rebar_ingestion() {
    std::cout << "[TEST] Running LS-DYNA Beam & Truss Keyword Reader Verification..." << std::endl;

    std::string test_deck = 
        "*KEYWORD\n"
        "*NODE\n"
        "       1       0.0       0.0       0.0\n"
        "       2       1.0       0.0       0.0\n"
        "       3       0.0       1.0       0.0\n"
        "       4       1.0       1.0       0.0\n"
        "*MAT_ELASTIC\n"
        "       1  7850.0  200.0E9      0.30\n"
        "*PART\n"
        "       1       1       1\n"
        "       2       2       1\n"
        "*SECTION_BEAM\n"
        "$ SECID  ELFORM\n"
        "      1       3\n"
        "$   TS1     TS2\n"
        "  0.012   0.012\n"
        "*SECTION_BEAM\n"
        "$ SECID  ELFORM\n"
        "      2       1\n"
        "$   TS1     TS2\n"
        "  0.020   0.020\n"
        "*ELEMENT_BEAM\n"
        "       1       1       1       2\n"
        "       2       2       3       4\n"
        "*END\n";

    std::string temp_k_path = "/tmp/test_rebar_deck.k";
    {
        std::ofstream ofs(temp_k_path);
        ofs << test_deck;
    }

    LSDynaReader3D<double> reader;
    std::vector<FEMNode3D<double>> nodes;
    std::vector<FEMElement3D<double>> elements;
    std::vector<FEMTrussElement3D<double>> trusses;
    std::vector<FEMBeam3DElement<double>> beams;
    MaterialTable3D default_mat;
    std::vector<MaterialTable3D> mats;

    bool ok = reader.parseFile(temp_k_path, nodes, elements, trusses, beams, default_mat, mats);
    assert(ok);
    assert(nodes.size() == 4);
    assert(trusses.size() == 1); // ELFORM=3 mapped to 1D Axial Truss
    assert(beams.size() == 1);   // ELFORM=1 mapped to 3D Timoshenko Beam
    assert(std::abs(trusses[0].A - M_PI * 0.012 * 0.012 * 0.25) < 1.0e-7);
    assert(std::abs(beams[0].d - 0.020) < 1.0e-6);

    std::cout << "  ✓ Ingested " << trusses.size() << " 1D truss element(s) and " << beams.size() << " 3D beam element(s) from LS-DYNA deck" << std::endl;
}

void test_rebar_uncovering_during_concrete_erosion() {
    std::cout << "[TEST] Running Concrete Solid Erosion with Embedded Rebar Retention..." << std::endl;

    FEMSolver3D<double> solver;
    std::vector<FEMNode3D<double>> hex_nodes_vec(8);
    static const double coords[8][3] = {
        {0.0, 0.0, 0.0}, {1.0, 0.0, 0.0}, {1.0, 1.0, 0.0}, {0.0, 1.0, 0.0},
        {0.0, 0.0, 1.0}, {1.0, 0.0, 1.0}, {1.0, 1.0, 1.0}, {0.0, 1.0, 1.0}
    };
    for (int i = 0; i < 8; ++i) {
        hex_nodes_vec[i].x[0] = coords[i][0];
        hex_nodes_vec[i].x[1] = coords[i][1];
        hex_nodes_vec[i].x[2] = coords[i][2];
        hex_nodes_vec[i].lsdyna_id = i + 1;
    }

    std::vector<FEMElement3D<double>> elements(1);
    for (int i = 0; i < 8; ++i) elements[0].node_ids[i] = i;
    elements[0].lsdyna_id = 1;
    elements[0].mat_id = 0;

    MaterialTable3D concrete_mat;
    concrete_mat.density = 2400.0f;
    concrete_mat.youngs_modulus = 30.0e9f;
    concrete_mat.poissons_ratio = 0.20f;
    concrete_mat.material_model = MPMMaterialModel::RHTConcrete;
    concrete_mat.enable_strain_erosion = true;
    concrete_mat.failure_strain = 0.05f;

    solver.setNodesAndElements(hex_nodes_vec, elements, concrete_mat);

    // Add rebar along edge 0 - 1
    MaterialTable3D rebar_mat;
    rebar_mat.density = 7850.0f;
    rebar_mat.youngs_modulus = 200.0e9f;
    rebar_mat.yield_stress = 500.0e6f;
    solver.addTruss(0, 1, 1.13e-4, rebar_mat, 0.25f);

    // Erode the concrete solid element manually
    solver.getElements()[0].is_eroded = true;
    solver.updateNodeErosionStatus();

    // Verify that nodes 2..7 with no rebar are eroded, while rebar nodes 0 and 1 remain active!
    const auto& nodes = solver.getNodes();
    assert(!nodes[0].is_eroded);
    assert(!nodes[1].is_eroded);
    assert(nodes[2].is_eroded);
    assert(nodes[3].is_eroded);
    assert(nodes[4].is_eroded);
    assert(nodes[5].is_eroded);
    assert(nodes[6].is_eroded);
    assert(nodes[7].is_eroded);

    std::cout << "  ✓ Rebar nodes 0 & 1 retained active structure after concrete solid erosion" << std::endl;
}

void test_timestep_acoustic_limits() {
    std::cout << "[TEST] Running Timestep Stability & Courant Calculation..." << std::endl;

    FEMSolver3D<double> solver;
    int n0 = solver.addNode(0.0, 0.0, 0.0, 1.0);
    int n1 = solver.addNode(0.1, 0.0, 0.0, 1.0); // 10 cm element

    MaterialTable3D steel_mat;
    steel_mat.density = 7850.0f;
    steel_mat.youngs_modulus = 200.0e9f;
    solver.addBeam3D(n0, n1, 0.012, steel_mat, 0.20f);

    double dt = solver.computeStepSize(0.67);
    // cd = sqrt(200e9 / 7850) = ~5047 m/s
    // dt_axial = 0.1 / 5047 = ~1.98e-5 s
    // dt_cfl = 0.67 * min(...)
    assert(dt > 0.0 && dt < 1.0e-4);
    std::cout << "  ✓ Computed stable explicit timestep: dt = " << dt * 1e6 << " microseconds" << std::endl;
}

void test_fem_to_mpm_conversion() {
    std::cout << "[TEST] Running Failed Concrete Elements to MPM Debris Conversion..." << std::endl;

    FEMSolver3D<double> fem_solver;
    auto mpm_solver = std::make_shared<MPMSolver3D>();
    mpm_solver->initializeGrid(30, 30, 30, 0.2f, 0.2f, 0.2f, -1.0f, -1.0f, -1.0f);

    fem_solver.setMPMSolver(mpm_solver);
    auto& physics_params = fem_solver.getPhysicsParams();
    physics_params.convert_failed_elements_to_mpm = true;
    physics_params.mpm_particles_per_failed_element = 8;

    // Create a 1m x 1m x 1m concrete solid block
    std::vector<FEMNode3D<double>> hex_nodes_vec(8);
    static const double coords[8][3] = {
        {0.0, 0.0, 0.0}, {1.0, 0.0, 0.0}, {1.0, 1.0, 0.0}, {0.0, 1.0, 0.0},
        {0.0, 0.0, 1.0}, {1.0, 0.0, 1.0}, {1.0, 1.0, 1.0}, {0.0, 1.0, 1.0}
    };
    for (int i = 0; i < 8; ++i) {
        hex_nodes_vec[i].x[0] = coords[i][0];
        hex_nodes_vec[i].x[1] = coords[i][1];
        hex_nodes_vec[i].x[2] = coords[i][2];
        hex_nodes_vec[i].v[0] = 50.0; // 50 m/s blast ejecta velocity
        hex_nodes_vec[i].lsdyna_id = i + 1;
    }

    std::vector<FEMElement3D<double>> elements(1);
    for (int i = 0; i < 8; ++i) elements[0].node_ids[i] = i;
    elements[0].lsdyna_id = 1;
    elements[0].mat_id = 0;

    MaterialTable3D concrete_mat;
    concrete_mat.density = 2400.0f;
    concrete_mat.youngs_modulus = 30.0e9f;
    concrete_mat.poissons_ratio = 0.20f;
    concrete_mat.material_model = MPMMaterialModel::RHTConcrete;
    concrete_mat.enable_strain_erosion = true;
    concrete_mat.erosion_strain = 0.05f;
    concrete_mat.failure_strain = 0.05f;

    fem_solver.setNodesAndElements(hex_nodes_vec, elements, concrete_mat);

    // Verify MPM solver initial particle count is 0
    assert(mpm_solver->getParticles().empty());

    // Trigger plastic failure on the concrete solid element
    fem_solver.getElements()[0].ep_bar = 0.10; // Exceeds 0.05 failure strain
    fem_solver.evaluateErosionCriteria();

    // 1. Verify element is eroded
    assert(fem_solver.getElements()[0].is_eroded);

    // 2. Verify exactly 8 MPM particles were generated
    const auto& particles = mpm_solver->getParticles();
    assert(particles.size() == 8);

    // 3. Verify total mass and volume conservation (M = 2400 kg, V = 1.0 m^3)
    double total_mass = 0.0;
    double total_vol = 0.0;
    double total_px = 0.0;
    for (const auto& p : particles) {
        total_mass += p.m;
        total_vol += p.V;
        total_px += p.m * p.v[0];
        // Check bounds (within [0, 1] in all axes)
        assert(p.x[0] >= 0.0 && p.x[0] <= 1.0);
        assert(p.x[1] >= 0.0 && p.x[1] <= 1.0);
        assert(p.x[2] >= 0.0 && p.x[2] <= 1.0);
        // Check velocity
        assert(std::abs(p.v[0] - 50.0) < 1.0e-3);
    }
    assert(std::abs(total_mass - 2400.0) < 1.0e-3);
    assert(std::abs(total_vol - 1.0) < 1.0e-3);
    assert(std::abs(total_px - 2400.0 * 50.0) < 1.0e-2);
    std::cout << "  ✓ Transferred " << particles.size() << " MPM debris particles with exact mass (" << total_mass << " kg), volume (" << total_vol << " m^3), and momentum (" << total_px << " kg*m/s) conservation" << std::endl;

    // 4. Advance MPM solver step to ensure successful grid transfer and continuum physics
    mpm_solver->stepWithDt(1.0e-4);
    assert(mpm_solver->getParticles().size() == 8);
    std::cout << "  ✓ Debris particles successfully advanced through MPM background grid" << std::endl;
}

void test_mpm_debris_rebar_contact() {
    std::cout << "[TEST] Running Line-to-Sphere Rebar vs MPM Debris Contact..." << std::endl;

    FEMSolver3D<double> fem_solver;
    MPMSolver3D mpm_solver;
    FEMContact3D<double> contact;
    contact.setContactPenaltyScale(1.0);

    // Rebar beam spanning along Y axis at X = 0.5, Z = 0.0
    int n0 = fem_solver.addNode(0.5, 0.0, 0.0, 5.0);
    int n1 = fem_solver.addNode(0.5, 1.0, 0.0, 5.0);

    MaterialTable3D steel_mat;
    steel_mat.youngs_modulus = 200.0e9f;
    steel_mat.density = 7850.0f;
    fem_solver.addBeam3D(n0, n1, 0.02, steel_mat); // 20mm diameter rebar (r = 10mm)

    // MPM debris particle approaching the rebar at X = 0.51, Y = 0.5, Z = 0.0 (penetration into contact zone)
    MPMParticle3D p{};
    p.x[0] = 0.51f; p.x[1] = 0.5f; p.x[2] = 0.0f;
    p.v[0] = -50.0f; // Flying towards -X into the rebar
    p.m = 2.0f;      // 2 kg concrete fragment
    p.lp[0] = 0.015f; p.lp[1] = 0.015f; p.lp[2] = 0.015f; // 15mm half-width
    // R_contact = 0.010 + 0.015 = 0.025m.
    // Particle at 0.51m is at dist = 0.010m from rebar (0.50m), penetration depth = 0.015m!
    mpm_solver.addParticleDirect(p);

    double dt = 1.0e-4;
    contact.solveMPMRebarContact(fem_solver, mpm_solver, dt);

    const auto& particles = mpm_solver.getParticles();
    const auto& nodes = fem_solver.getNodes();

    // 1. Particle velocity should be pushed back in +X direction
    assert(particles[0].v[0] > -50.0f);

    // 2. Reaction forces on rebar nodes should be in -X direction (opposing particle velocity)
    assert(nodes[n0].f_contact[0] < 0.0);
    assert(nodes[n1].f_contact[0] < 0.0);

    // 3. Since particle is at Y = 0.5 (exact midpoint), reaction forces on n0 and n1 should be equal
    assert(std::abs(nodes[n0].f_contact[0] - nodes[n1].f_contact[0]) < 1.0e-3);

    std::cout << "  ✓ Debris particle rebounded (vx: -50 m/s -> " << particles[0].v[0] << " m/s)" << std::endl;
    std::cout << "  ✓ Symmetric reaction force applied to rebar nodes: F_x = " << nodes[n0].f_contact[0] << " N" << std::endl;
}

int main() {
    std::cout << "======================================================" << std::endl;
    std::cout << "=== BLASTDAEMON FEM 3D REBAR & BEAM TEST SUITE ===" << std::endl;
    std::cout << "======================================================" << std::endl;

    test_1d_axial_truss();
    test_3d_timoshenko_beam();
    test_ls_dyna_rebar_ingestion();
    test_rebar_uncovering_during_concrete_erosion();
    test_timestep_acoustic_limits();
    test_fem_to_mpm_conversion();
    test_mpm_debris_rebar_contact();

    std::cout << "======================================================" << std::endl;
    std::cout << ">>> ALL REBAR AND BEAM TESTS PASSED SUCCESSFULLY! <<<" << std::endl;
    std::cout << "======================================================" << std::endl;
    return 0;
}
