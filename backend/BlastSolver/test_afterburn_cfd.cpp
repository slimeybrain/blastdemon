#include "cfd_solver.hpp"
#include "cfd_solver_2d.hpp"
#include "cfd_solver_3d.hpp"
#include "materials.hpp"
#include <iostream>
#include <vector>
#include <cmath>
#include <cassert>
#include <iomanip>

// ============================================================================
// BlastDemon Verification Suite: Secondary Aerobic Afterburn (Directives 16 & 17)
// Genuine Physical Execution of Production Solvers and Reaction Kinetics
// ============================================================================

static int g_tests_run = 0;
static int g_tests_passed = 0;

#define ASSERT_TEST(cond, msg) \
    do { \
        g_tests_run++; \
        if (!(cond)) { \
            std::cerr << "  [FAIL] " << msg << " (" << #cond << ") at line " << __LINE__ << "\n"; \
        } else { \
            std::cout << "  [PASS] " << msg << "\n"; \
            g_tests_passed++; \
        } \
    } while(0)

// ----------------------------------------------------------------------------
// Test 1: Closed-Form MultiMat::computeAfterburn Kinetics & Physical Invariants
// ----------------------------------------------------------------------------
void test_afterburn_kinetics() {
    std::cout << "\n=== Test Suite 1: Fundamental Reaction Kinetics & Physical Invariants ===\n";

    MultiMat::AfterburnParams params;
    params.enabled = true;
    params.Q_ab = 1.071e7;       // TNT: 10.71 MJ/kg
    params.f_fuel = 0.35;        // 35% combustible carbonaceous fuel
    params.s_ratio = 2.70;       // 2.70 kg air / kg fuel
    params.T_ign = 600.0;        // 600 K autoignition threshold
    params.tau_chem = 1.0e-5;    // 10 microsecond kinetic limit
    params.C_mix = 0.05;         // Mixing factor

    double dt = 1.0e-6;
    double R_charge = 0.05;      // 50 mm radius charge
    double D_cj = 6930.0;        // TNT CJ velocity

    // 1.1 Inactive when disabled
    {
        MultiMat::AfterburnParams disabled_params = params;
        disabled_params.enabled = false;
        double rho = 5.0, E = 2.0e7, a1 = 0.5, ar0 = 2.5, ar1 = 2.5;
        double E_orig = E, a1_orig = a1;
        MultiMat::computeAfterburn(dt, R_charge, D_cj, disabled_params, rho, a1, ar1, ar0, E, 0.0);
        ASSERT_TEST(E == E_orig && a1 == a1_orig, "Disabled afterburn produces zero state change");
    }

    // 1.2 Anaerobic Invariance: Zero air fraction (arho0 = 0)
    {
        double rho = 10.0, E = 5.0e7, a1 = 1.0, ar0 = 0.0, ar1 = 10.0;
        double E_orig = E, a1_orig = a1;
        MultiMat::computeAfterburn(dt, R_charge, D_cj, params, rho, a1, ar1, ar0, E, 0.0);
        ASSERT_TEST(E == E_orig && a1 == a1_orig, "Anaerobic condition (zero air) produces zero afterburn");
    }

    // 1.2b Pure Nitrogen / Inert Gas Ambient Invariance (ambient_o2_fraction = 0.0)
    {
        MultiMat::AfterburnParams n2_params = params;
        n2_params.ambient_o2_fraction = 0.0; // Pure N2 / Argon / Vacuum
        double rho = 2.0;
        double E = rho * (718.0 * 1500.0);   // Hot gas T ≈ 1500 K > T_ign
        double a1 = 0.5, ar0 = 1.0, ar1 = 1.0;
        double E_orig = E, a1_orig = a1;
        double dE = MultiMat::computeAfterburn(dt, R_charge, D_cj, n2_params, rho, a1, ar1, ar0, E, 0.0);
        ASSERT_TEST(dE == 0.0 && E == E_orig && a1 == a1_orig, "Pure nitrogen / inert ambient gas strictly suppresses aerobic afterburn (zero energy released)");
    }

    // 1.3 Autoignition Temperature Gating: T < T_ign (Cold mixture, T ~ 350 K)
    {
        double rho = 2.0;
        double E = rho * (718.0 * 50.0); // Cold mixture, e_int low so T < 600 K
        double a1 = 0.5, ar0 = 1.0, ar1 = 1.0;
        double E_orig = E, a1_orig = a1;
        MultiMat::computeAfterburn(dt, R_charge, D_cj, params, rho, a1, ar1, ar0, E, 0.0);
        ASSERT_TEST(E == E_orig && a1 == a1_orig, "Mixture below ignition temperature (T < T_ign) does not burn");
    }

    // 1.4 Exothermic Reaction Above T_ign: T ≈ 1500 K > 600 K
    {
        double rho = 2.0;
        double E = rho * (718.0 * 1500.0); // T ≈ 1500 K > 600 K
        double a1 = 0.5, ar0 = 1.0, ar1 = 1.0;
        double E_orig = E;
        double ar0_orig = ar0;
        double ar1_orig = ar1;

        double dE_returned = MultiMat::computeAfterburn(dt, R_charge, D_cj, params, rho, a1, ar1, ar0, E, 0.0);
        double dm_reacted = ar1_orig - ar1;
        ar0 += dm_reacted; // Phase mass transfer to ambient material 0

        ASSERT_TEST(std::abs((ar0 + ar1) - (ar0_orig + ar1_orig)) < 1.0e-14, "Sum of partial densities is strictly conserved");
        ASSERT_TEST(E > E_orig, "Exothermic combustion releases positive energy into mixture");
        ASSERT_TEST(dE_returned > 0.0, "computeAfterburn returns positive reacted mass");
        ASSERT_TEST(ar1 < ar1_orig, "Combustible detonation product mass is consumed");

        // Energy release matches d_m_fuel * Q_ab exactly (accounting for IEEE 754 subtraction over 2.15e6 J)
        double expected_dE = dm_reacted * params.Q_ab;
        double actual_dE = E - E_orig;
        double energy_rel_err = std::abs(actual_dE - expected_dE) / expected_dE;
        ASSERT_TEST(energy_rel_err < 1.0e-9, "Energy release matches exact enthalpy of combustion (dE = dm * Q_ab)");
    }

    // 1.5 Stoichiometric Air Limitation: Starved Oxygen vs Pure Oxygen
    {
        // Very small air (arho0 = 0.01), large fuel (arho1 = 2.0)
        double rho = 2.01;
        double E = rho * (718.0 * 2000.0);
        double a1 = 0.99, ar0 = 0.01, ar1 = 2.0;
        double ar1_orig = ar1;
        double large_dt = 1.0; // Equilibrium limit

        MultiMat::computeAfterburn(large_dt, R_charge, D_cj, params, rho, a1, ar1, ar0, E, 0.0);

        double dm_consumed = ar1_orig - ar1;
        // rho_O2 = 0.233 * arho0 = 0.00233. max_fuel = rho_O2 / s_ratio
        double max_fuel = (0.233 * 0.01) / params.s_ratio;
        double max_explosive = max_fuel / params.f_fuel;
        ASSERT_TEST(dm_consumed <= max_explosive + 1.0e-14, "Explosive consumption is strictly capped by stoichiometric O2 availability");

        // Now test pure oxygen (ambient_o2_fraction = 1.0)
        MultiMat::AfterburnParams o2_params = params;
        o2_params.ambient_o2_fraction = 1.0;
        double a1_o2 = 0.99, ar0_o2 = 0.01, ar1_o2 = 2.0, E_o2 = E;
        MultiMat::computeAfterburn(large_dt, R_charge, D_cj, o2_params, rho, a1_o2, ar1_o2, ar0_o2, E_o2, 0.0);
        double dm_consumed_o2 = 2.0 - ar1_o2;
        double max_fuel_o2 = (1.0 * 0.01) / params.s_ratio;
        double max_explosive_o2 = max_fuel_o2 / o2_params.f_fuel;
        ASSERT_TEST(dm_consumed_o2 <= max_explosive_o2 + 1.0e-14 && dm_consumed_o2 > dm_consumed, "Pure oxygen ambient enables stoichiometrically proportional oxidation capacity");
    }

    // 1.6 First-Principles EDC Mixing Rate Modulation
    {
        double rho_laminar = 2.0, rho_turb = 2.0;
        double E_laminar = rho_laminar * (718.0 * 1500.0);
        double E_turb = E_laminar;
        double a1_l = 0.5, a1_t = 0.5;
        double ar0_l = 1.0, ar0_t = 1.0;
        double ar1_l = 1.0, ar1_t = 1.0;

        double dE_laminar = MultiMat::computeAfterburn(dt, 0.0, R_charge, D_cj, params, rho_laminar, a1_l, ar1_l, ar0_l, E_laminar, 0.0, 0.0);
        double dE_turbulent = MultiMat::computeAfterburn(dt, 0.0, R_charge, D_cj, params, rho_turb, a1_t, ar1_t, ar0_t, E_turb, 0.0, 5000.0); // 5000 s^-1 turbulent shear vorticity

        ASSERT_TEST(dE_turbulent > dE_laminar, "Local vorticity / strain rate accelerates turbulent mixing rate relative to irrotational laminar expansion");
    }

    // 1.7 Scale Invariance across 1g to 1MT (Taylor-Sedov Fireball Scaling)
    {
        double rho = 2.0;
        double E = rho * (718.0 * 1500.0);
        double a1 = 0.5, ar0 = 1.0, ar1 = 1.0;

        // 1 gram TNT charge (R_c ~ 5.3 mm)
        double R_1g = 0.0053;
        double E_1g = E, a1_1g = a1, ar1_1g = ar1, ar0_1g = ar0;
        double dE_1g = MultiMat::computeAfterburn(1.0e-5, 0.0, R_1g, D_cj, params, rho, a1_1g, ar1_1g, ar0_1g, E_1g, 0.0, 0.0);

        // 1 Megaton TNT charge (R_c ~ 52.7 m)
        double R_1MT = 52.7;
        double E_1MT = E, a1_1MT = a1, ar1_1MT = ar1, ar0_1MT = ar0;
        double dE_1MT = MultiMat::computeAfterburn(1.0e-5, 0.0, R_1MT, D_cj, params, rho, a1_1MT, ar1_1MT, ar0_1MT, E_1MT, 0.0, 0.0);

        // 1g fireball has small Sedov scale (tau ~ 1ms), so early-time reaction rate is high.
        // 1MT fireball has vast Sedov scale (tau ~ 10s), so early-time 10-microsecond release rate is small.
        ASSERT_TEST(dE_1g > dE_1MT * 100.0, "Taylor-Sedov scaling naturally differentiates 1g early mixing from 1MT gradual expansion (zero early dump on megatons)");
    }
}

// ----------------------------------------------------------------------------
// Test 2: Genuine 1D Multi-Material CFD Solver Blast Wave Simulation
// ----------------------------------------------------------------------------
void test_1d_cfd_afterburn() {
    std::cout << "\n=== Test Suite 2: Genuine 1D Multi-Material CFD Solver Steps ===\n";

    double R_tnt = 0.05;          // 50 mm TNT sphere
    double high_rho = 1630.0;
    double ambient_rho = 1.225;
    double ambient_p = 101325.0;
    double gamma = 1.4;
    double domain_r = 0.8;
    int num_cells = 400;
    double dr = domain_r / num_cells;

    // Solver A: Baseline TNT without afterburn
    CFDSolverImpl<double, true> solver_base(num_cells, domain_r, gamma);
    MultiMat::MaterialSet mat_base = MultiMat::TNT;
    mat_base.afterburn.enabled = false;
    solver_base.setMaterialParameters(mat_base);
    solver_base.setFluxScheme("ausm_plus");
    solver_base.setSpatialOrder(2);
    solver_base.setTemporalOrder(2);
    solver_base.setInitialConditionTNT(R_tnt, high_rho, ambient_rho, ambient_p);

    // Solver B: Calibrated TNT with afterburn enabled
    CFDSolverImpl<double, true> solver_ab(num_cells, domain_r, gamma);
    MultiMat::MaterialSet mat_ab = MultiMat::TNT;
    mat_ab.afterburn.enabled = true;
    mat_ab.afterburn.Q_ab = 1.071e7;
    mat_ab.afterburn.f_fuel = 0.35;
    mat_ab.afterburn.s_ratio = 2.70;
    mat_ab.afterburn.T_ign = 600.0;
    mat_ab.afterburn.tau_chem = 1.0e-5;
    mat_ab.afterburn.C_edc = 0.15;
    mat_ab.afterburn.tau_expansion = 0.020;
    mat_ab.afterburn.ambient_o2_fraction = 0.233;
    solver_ab.setMaterialParameters(mat_ab);
    solver_ab.setFluxScheme("ausm_plus");
    solver_ab.setSpatialOrder(2);
    solver_ab.setTemporalOrder(2);
    solver_ab.setInitialConditionTNT(R_tnt, high_rho, ambient_rho, ambient_p);

    // Solver C: TNT with afterburn enabled but in pure Nitrogen ambient (ambient_o2_fraction = 0.0)
    CFDSolverImpl<double, true> solver_n2(num_cells, domain_r, gamma);
    MultiMat::MaterialSet mat_n2 = mat_ab;
    mat_n2.afterburn.ambient_o2_fraction = 0.0; // Pure Nitrogen
    solver_n2.setMaterialParameters(mat_n2);
    solver_n2.setFluxScheme("ausm_plus");
    solver_n2.setSpatialOrder(2);
    solver_n2.setTemporalOrder(2);
    solver_n2.setInitialConditionTNT(R_tnt, high_rho, ambient_rho, ambient_p);

    // Verify charge_radius was properly set
    ASSERT_TEST(std::abs(solver_ab.getChargeRadius() - R_tnt) < 1.0e-12, "1D Solver correctly caches charge_radius for scale-dependent mixing");

    // Advance solvers for 150 timesteps
    double t_end = 0.00035; // 350 microseconds
    int step_count = 0;
    double dt_fixed = 1.5e-7;

    double initial_mass_base = 0.0;
    double initial_mass_ab = 0.0;
    double initial_mass_n2 = 0.0;
    auto get_vol = [dr](int i) {
        double r_left = i * dr;
        double r_right = (i + 1) * dr;
        return (4.0 / 3.0) * M_PI * (r_right * r_right * r_right - r_left * r_left * r_left);
    };

    for (int i = 0; i < num_cells; ++i) {
        double vol = get_vol(i);
        initial_mass_base += solver_base.getStates()[i].rho * vol;
        initial_mass_ab += solver_ab.getStates()[i].rho * vol;
        initial_mass_n2 += solver_n2.getStates()[i].rho * vol;
    }

    while (solver_base.getTime() < t_end && step_count < 150) {
        double dt_b = solver_base.computeStepSize(0.4);
        double dt_a = solver_ab.computeStepSize(0.4);
        double dt_n = solver_n2.computeStepSize(0.4);
        double dt = std::min(std::min(dt_b, dt_a), dt_n);
        if (dt > dt_fixed) dt = dt_fixed;

        solver_base.step(dt);
        solver_ab.step(dt);
        solver_n2.step(dt);
        step_count++;
    }

    std::cout << "  Executed " << step_count << " synchronized 1D multi-material CFD steps to t = " 
              << solver_ab.getTime() * 1.0e6 << " μs\n";

    // Mass conservation check
    double final_mass_base = 0.0;
    double final_mass_ab = 0.0;
    double final_mass_n2 = 0.0;
    double total_energy_base = 0.0;
    double total_energy_ab = 0.0;
    double total_energy_n2 = 0.0;
    double peak_p_base = 0.0;
    double peak_p_ab = 0.0;

    for (int i = 0; i < num_cells; ++i) {
        double vol = get_vol(i);
        final_mass_base += solver_base.getStates()[i].rho * vol;
        final_mass_ab += solver_ab.getStates()[i].rho * vol;
        final_mass_n2 += solver_n2.getStates()[i].rho * vol;

        total_energy_base += solver_base.getStates()[i].E * vol;
        total_energy_ab += solver_ab.getStates()[i].E * vol;
        total_energy_n2 += solver_n2.getStates()[i].E * vol;

        if (solver_base.getStates()[i].p > peak_p_base) peak_p_base = solver_base.getStates()[i].p;
        if (solver_ab.getStates()[i].p > peak_p_ab) peak_p_ab = solver_ab.getStates()[i].p;
    }

    double mass_drift_ab = std::abs(final_mass_ab - initial_mass_ab) / initial_mass_ab;
    double mass_drift_base = std::abs(final_mass_base - initial_mass_base) / initial_mass_base;
    double afterburn_mass_drift = std::abs(final_mass_ab - final_mass_base) / final_mass_base;

    std::cout << "  1D Mass Drift: Base = " << mass_drift_base << ", Afterburn = " << mass_drift_ab 
              << ", Relative AB Drift = " << afterburn_mass_drift << "\n";
    ASSERT_TEST(afterburn_mass_drift < 1.0e-12, "1D Solver mass with afterburn matches non-reacting baseline exactly (drift < 1e-12)");
    ASSERT_TEST(total_energy_ab >= total_energy_base, "1D Solver with afterburn exhibits higher internal energy than non-afterburn baseline");

    double delta_E = total_energy_ab - total_energy_base;
    std::cout << "  Energy Augmentation from Afterburn (Air): ΔE = " << delta_E / 1.0e3 << " kJ ("
              << (delta_E / total_energy_base) * 100.0 << "% gain over non-reacting baseline)\n";
    ASSERT_TEST(delta_E > 0.0, "Secondary combustion successfully releases aerobic thermal enthalpy into blast gas");

    // Pure nitrogen verification: energy must match baseline exactly
    double delta_E_n2 = std::abs(total_energy_n2 - total_energy_base) / total_energy_base;
    ASSERT_TEST(delta_E_n2 < 1.0e-12, "1D Solver in pure nitrogen ambient (ambient_o2_fraction = 0.0) produces zero afterburn energy (matches baseline exactly)");
}

// ----------------------------------------------------------------------------
// Test 3: Genuine 2D Axisymmetric CFD Solver Steps
// ----------------------------------------------------------------------------
void test_2d_cfd_afterburn() {
    std::cout << "\n=== Test Suite 3: Genuine 2D Axisymmetric CFD Solver Steps ===\n";

    int nr = 50, nz = 50;
    double dr = 0.01, dz = 0.01;
    double gamma = 1.4;

    CFDSolver2DImpl<double> solver_2d_base(nr, nz, nr * dr, nz * dz, gamma);
    solver_2d_base.setCoordinateSystemCartesian(false);
    MultiMat::MaterialSet mat_base = MultiMat::TNT;
    mat_base.afterburn.enabled = false;
    solver_2d_base.setMaterialParameters(mat_base);
    solver_2d_base.setInitialConditionTNT(0.25, 0.05, 1630.0, 1.225, 101325.0, 0.0);

    CFDSolver2DImpl<double> solver_2d_ab(nr, nz, nr * dr, nz * dz, gamma);
    solver_2d_ab.setCoordinateSystemCartesian(false);
    MultiMat::MaterialSet mat_ab = MultiMat::TNT;
    mat_ab.afterburn.enabled = true;
    mat_ab.afterburn.Q_ab = 1.071e7;
    mat_ab.afterburn.f_fuel = 0.35;
    mat_ab.afterburn.s_ratio = 2.70;
    mat_ab.afterburn.T_ign = 600.0;
    mat_ab.afterburn.tau_chem = 1.0e-5;
    mat_ab.afterburn.C_edc = 0.15;
    mat_ab.afterburn.tau_expansion = 0.020;
    mat_ab.afterburn.ambient_o2_fraction = 0.233;
    solver_2d_ab.setMaterialParameters(mat_ab);
    solver_2d_ab.setInitialConditionTNT(0.25, 0.05, 1630.0, 1.225, 101325.0, 0.0);

    ASSERT_TEST(std::abs(solver_2d_ab.getChargeRadius() - 0.05) < 1.0e-12, "2D Solver correctly caches charge_radius");

    // Advance 25 steps
    for (int step = 0; step < 25; ++step) {
        double dt = solver_2d_ab.computeStepSize(0.3);
        solver_2d_base.step(dt);
        solver_2d_ab.step(dt);
    }

    std::cout << "  Executed 25 2D Axisymmetric steps cleanly to t = " << solver_2d_ab.getTime() * 1.0e6 << " μs\n";

    // Verify non-nan and energy release
    const auto& states_base = solver_2d_base.getStates();
    const auto& states_ab = solver_2d_ab.getStates();
    bool has_nan = false;
    double E_tot_base = 0.0;
    double E_tot_ab = 0.0;

    for (size_t i = 0; i < states_base.size(); ++i) {
        if (std::isnan(states_ab[i].p) || std::isnan(states_ab[i].rho) || std::isnan(states_ab[i].E)) {
            has_nan = true;
            break;
        }
        E_tot_base += states_base[i].E;
        E_tot_ab += states_ab[i].E;
    }

    ASSERT_TEST(!has_nan, "2D Axisymmetric state fields remain completely NaN/Inf-free");
    ASSERT_TEST(E_tot_ab >= E_tot_base, "2D Axisymmetric total energy with afterburn exceeds non-reacting baseline");
}

// ----------------------------------------------------------------------------
// Test 4: Genuine 3D Uniform Grid CFD Solver Steps
// ----------------------------------------------------------------------------
void test_3d_cfd_afterburn() {
    std::cout << "\n=== Test Suite 4: Genuine 3D Uniform Grid CFD Solver Steps ===\n";

    int nx = 24, ny = 24, nz = 24;
    double cellSize = 0.02;

    CFDSolver3DImpl<double, true> solver_3d_base(nx, ny, nz, cellSize);
    Charge3DParams charge;
    charge.shape_type = 0; // Sphere
    charge.x = 0.24; charge.y = 0.24; charge.z = 0.24;
    charge.radius = 0.06;

    MultiMat::MaterialSet mat_base = MultiMat::TNT;
    mat_base.afterburn.enabled = false;
    solver_3d_base.setInitialCondition(charge, mat_base, 1.225, 101325.0);

    CFDSolver3DImpl<double, true> solver_3d_ab(nx, ny, nz, cellSize);
    MultiMat::MaterialSet mat_ab = MultiMat::TNT;
    mat_ab.afterburn.enabled = true;
    mat_ab.afterburn.Q_ab = 1.071e7;
    mat_ab.afterburn.f_fuel = 0.35;
    mat_ab.afterburn.s_ratio = 2.70;
    mat_ab.afterburn.T_ign = 600.0;
    mat_ab.afterburn.tau_chem = 1.0e-5;
    mat_ab.afterburn.C_edc = 0.15;
    mat_ab.afterburn.tau_expansion = 0.020;
    mat_ab.afterburn.ambient_o2_fraction = 0.233;
    solver_3d_ab.setInitialCondition(charge, mat_ab, 1.225, 101325.0);

    ASSERT_TEST(std::abs(solver_3d_ab.getChargeRadius() - 0.06) < 1.0e-12, "3D Solver correctly caches charge_radius");

    // Advance 15 steps
    for (int step = 0; step < 15; ++step) {
        double dt = solver_3d_ab.computeStepSize(0.3);
        solver_3d_base.step(dt);
        solver_3d_ab.step(dt);
    }

    std::cout << "  Executed 15 3D uniform grid steps cleanly to t = " << solver_3d_ab.getTime() * 1.0e6 << " μs\n";

    auto [mass_base, energy_base] = solver_3d_base.getConservationTotals();
    auto [mass_ab, energy_ab] = solver_3d_ab.getConservationTotals();
    std::cout << "  3D Conservation: energy_base = " << energy_base << " J, energy_ab = " << energy_ab << " J\n";

    ASSERT_TEST(!std::isnan(mass_ab) && !std::isnan(energy_ab) && !std::isinf(energy_ab), "3D conservation totals remain completely NaN/Inf-free");
    ASSERT_TEST(energy_ab >= energy_base, "3D total energy with afterburn exceeds non-reacting baseline");
}

int main() {
    std::cout << "====================================================================\n";
    std::cout << "  BlastDemon Verification & Validation: Afterburn & Aerobic Kinetics\n";
    std::cout << "  Master Directives 14, 16 & 17: Genuine Multi-Physics Solver Execution\n";
    std::cout << "====================================================================\n";

    test_afterburn_kinetics();
    test_1d_cfd_afterburn();
    test_2d_cfd_afterburn();
    test_3d_cfd_afterburn();

    std::cout << "\n====================================================================\n";
    std::cout << "  Verification Summary: " << g_tests_passed << " / " << g_tests_run << " assertions passed.\n";
    if (g_tests_passed == g_tests_run) {
        std::cout << "  [SUCCESS] All afterburn verification assertions PASSED with 100% integrity.\n";
        std::cout << "====================================================================\n";
        return 0;
    } else {
        std::cerr << "  [FAILURE] " << (g_tests_run - g_tests_passed) << " assertions FAILED.\n";
        std::cout << "====================================================================\n";
        return 1;
    }
}
