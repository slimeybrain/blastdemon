// =============================================================================
// VV-FEM-CPL: Coupled MPM-FEM Contact, Tet4/KosloffFrazier Stability, &
// Per-Part / Per-Material Configuration Isolation Verification
// =============================================================================
// Every benchmark instantiates production Blast::FEMSolver3D / MPMSolver3D
// (and CUDA counterparts when a CUDA device is present), allocates concrete
// meshes/particle clouds, advances genuine time integration + contact steps,
// and verifies explicit quantitative metrics directly from solver state buffers.
// =============================================================================

#include "vv_fem_coupling_fixes.hpp"
#include "fem_solver_3d.hpp"
#include "fem_solver_3d_cuda.hpp"
#include "mpm_solver_3d.hpp"
#include "mpm_solver_3d_cuda.hpp"

#include <cuda_runtime.h>

#include <algorithm>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>
#include <vector>

namespace Blast::VV {

namespace {

bool hasCudaDeviceAvailable() {
    int count = 0;
    return (cudaGetDeviceCount(&count) == cudaSuccess && count > 0);
}

template <typename FemT, typename FemSolverT, typename MpmSolverT>
void advanceCoupledStep(FemSolverT& fem, MpmSolverT& mpm, FemT fem_cfl, float mpm_cfl) {
    FemT fem_dt = fem.computeStepSize(fem_cfl);
    float mpm_dt_est = mpm.computeStepSize(mpm_cfl);
    if (mpm_dt_est > 0.0f) {
        FemT cap = static_cast<FemT>(4.0f) * static_cast<FemT>(mpm_dt_est);
        if (fem_dt <= static_cast<FemT>(0.0f) || cap < fem_dt) fem_dt = cap;
    }
    if (fem_dt > static_cast<FemT>(0.0f)) {
        fem.stepWithDt(fem_dt);
    } else {
        fem.step(fem_cfl);
    }
    const double last_dt = static_cast<double>(fem.getLastDt());
    if (last_dt > 1.0e-15) {
        double remaining = last_dt;
        while (remaining > 1.0e-15) {
            float mpm_dt = std::min(static_cast<float>(remaining), mpm.computeStepSize(mpm_cfl));
            if (mpm_dt <= 0.0f) break;
            mpm.stepWithDt(mpm_dt);
            fem.applyMPMContact(static_cast<FemT>(mpm_dt));
            remaining -= static_cast<double>(mpm_dt);
        }
    }
}

// -----------------------------------------------------------------------------
// VV-FEM-CPL-01: MPM Projectile Impact on Intact FEM Plate (Zero Pass-Through)
// -----------------------------------------------------------------------------
BenchmarkResult run_mpm_projectile_fem_impact_test() {
    BenchmarkResult res;
    res.id = "VV-FEM-CPL-01";
    res.title = "MPM Projectile Impact on FEM Plate (Zero Pass-Through & Plastic Strain)";
    res.level = 3;
    res.pending = false;
    res.tolerance_l2 = 1.0e-2;
    res.tolerance_linf = 5.0e-2;

    MaterialTable3D steel_fem{};
    steel_fem.material_model = MPMMaterialModel::Hypoelastic;
    steel_fem.density = 7850.0f;
    steel_fem.youngs_modulus = 200.0e9f;
    steel_fem.poissons_ratio = 0.30f;
    steel_fem.yield_stress = 250.0e6f;
    steel_fem.hardening_modulus = 1.0e9f;
    steel_fem.failure_strain = 0.60f;
    steel_fem.erosion_strain = 0.60f;
    steel_fem.enable_strain_erosion = false;
    steel_fem.synchronizePillars();

    // Target FEM plate: x,y in [-0.12, 0.12], z in [0.0, 0.04], bottom z=0 fixed
    FEMSolver3D<float> fem;
    fem.setIntegrationScheme(FEMIntegrationScheme::OnePointFB);
    fem.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoStiffness);
    fem.setHourglassCoeff(0.05f);
    fem.setContactPenaltyScale(1.0f);
    fem.createStructuredBoxMesh(6, 6, 2, 0.24f, 0.24f, 0.04f, -0.12f, -0.12f, 0.0f, steel_fem, "Fixed Base");

    MPMSolver3D mpm;
    mpm.initializeGrid(28, 28, 16, 0.01f, 0.01f, 0.01f, -0.14f, -0.14f, -0.02f);
    mpm.setTimeScheme(MPMTimeIntegrationScheme::Leapfrog);
    // Projectile cube [ -0.02, 0.02 ]^2 x [ 0.042, 0.082 ] impacting downward at vz = -150 m/s
    mpm.addBoxObject(0, 0.0f, 0.0f, 0.062f, 0.04f, 0.04f, 0.04f,
                     0.0f, 0.0f, -150.0f, 0.0f, 0.0f, 0.0f,
                     7850.0f, 200.0e9f, 0.30f, 600.0e6f, 1.0e9f, 0.80f, 1.0e9f, 8);
    fem.setMPMSolver(&mpm);

    std::vector<double> t_ms_trace;
    std::vector<double> z_min_p_trace;
    std::vector<double> z_plate_bottom_trace;

    const double target_time = 2.5e-4; // 0.25 ms: free-flight at -150 m/s would reach z = 0.0045 m
    int steps = 0;
    while (fem.getSimTime() < target_time && steps < 4000) {
        advanceCoupledStep(fem, mpm, 0.5f, 0.3f);
        steps++;
        if (steps % 10 == 0 || fem.getSimTime() >= target_time) {
            double p_min_z = 1.0e9;
            for (const auto& p : mpm.getParticles()) {
                if (p.m > 0.0f) p_min_z = std::min(p_min_z, static_cast<double>(p.x[2]));
            }
            t_ms_trace.push_back(static_cast<double>(fem.getSimTime()) * 1000.0);
            z_min_p_trace.push_back(p_min_z);
            z_plate_bottom_trace.push_back(0.025); // Physical lower bound above mid/bottom plane
        }
    }

    double min_p_z = 1.0e9;
    double avg_vz = 0.0;
    int active_p = 0;
    for (const auto& p : mpm.getParticles()) {
        if (p.m > 0.0f) {
            min_p_z = std::min(min_p_z, static_cast<double>(p.x[2]));
            avg_vz += static_cast<double>(p.v[2]);
            active_p++;
        }
    }
    if (active_p > 0) avg_vz /= active_p;

    const float fem_ep_max_cpu = fem.getMaxPlasticStrain();
    const double fem_dt_last = static_cast<double>(fem.getLastDt());
    bool any_nan = !std::isfinite(min_p_z) || !std::isfinite(avg_vz) || !std::isfinite(fem_ep_max_cpu);
    int eroded_count = 0;
    for (const auto& el : fem.getElements()) {
        if (el.is_eroded) eroded_count++;
    }

    bool gpu_tested = false;
    bool gpu_ok = true;
    double gpu_min_pz = min_p_z;
    double gpu_avg_vz = avg_vz;
    float gpu_ep_max = fem_ep_max_cpu;

    if (hasCudaDeviceAvailable()) {
        gpu_tested = true;
        FEMSolver3DCUDA<float> fem_gpu;
        fem_gpu.setIntegrationScheme(FEMIntegrationScheme::OnePointFB);
        fem_gpu.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoStiffness);
        fem_gpu.setHourglassCoeff(0.05f);
        fem_gpu.setContactPenaltyScale(1.0f);
        fem_gpu.createStructuredBoxMesh(6, 6, 2, 0.24f, 0.24f, 0.04f, -0.12f, -0.12f, 0.0f, steel_fem, "Fixed Base");

        MPMSolver3DCUDA mpm_gpu;
        mpm_gpu.initializeGrid(28, 28, 16, 0.01f, 0.01f, 0.01f, -0.14f, -0.14f, -0.02f);
        mpm_gpu.setTimeScheme(MPMTimeIntegrationScheme::Leapfrog);
        mpm_gpu.addBoxObject(0, 0.0f, 0.0f, 0.062f, 0.04f, 0.04f, 0.04f,
                             0.0f, 0.0f, -150.0f, 0.0f, 0.0f, 0.0f,
                             7850.0f, 200.0e9f, 0.30f, 600.0e6f, 1.0e9f, 0.80f, 1.0e9f, 8);
        mpm_gpu.syncToDevice();
        fem_gpu.setCUDAMPMSolver(&mpm_gpu);

        int g_steps = 0;
        while (fem_gpu.getSimTime() < target_time && g_steps < 4000) {
            advanceCoupledStep(fem_gpu, mpm_gpu, 0.5f, 0.3f);
            g_steps++;
        }
        mpm_gpu.syncParticlesToHost();
        fem_gpu.syncToHost();
        gpu_min_pz = 1.0e9;
        gpu_avg_vz = 0.0;
        int g_act = 0;
        for (const auto& p : mpm_gpu.getParticles()) {
            if (p.m > 0.0f) {
                gpu_min_pz = std::min(gpu_min_pz, static_cast<double>(p.x[2]));
                gpu_avg_vz += static_cast<double>(p.v[2]);
                g_act++;
            }
        }
        if (g_act > 0) gpu_avg_vz /= g_act;
        float elem_ep_max = 0.0f;
        for (const auto& el : fem_gpu.getElements()) {
            elem_ep_max = std::max(elem_ep_max, el.ep_bar);
        }
        gpu_ep_max = std::max(fem_gpu.getMaxPlasticStrain(), elem_ep_max);
        gpu_ok = std::isfinite(gpu_min_pz) && std::isfinite(gpu_avg_vz) &&
                 (gpu_min_pz > 0.025) && (gpu_avg_vz > -30.0) && (gpu_ep_max > 1.0e-4f);
    }

    // Check CPU impact: blocked from falling below plate mid/bottom (0.025 m),
    // velocity arrested/rebounded (avg_vz > -30 m/s from -150 m/s), plastic strain > 1e-4
    const bool cpu_ok = !any_nan && (min_p_z > 0.025) && (avg_vz > -30.0) &&
                        (fem_ep_max_cpu > 1.0e-4f) && (eroded_count == 0);
    res.passed = cpu_ok && gpu_ok;
    res.error_l2 = (min_p_z > 0.030) ? 0.0 : std::abs(0.030 - min_p_z);
    res.error_linf = gpu_tested ? std::abs(min_p_z - gpu_min_pz) : 0.0;

    std::string svg_file = "vv_fem_cpl_01_mpm_impact.svg";
    generate_svg_plot(
        svg_file,
        "VV-FEM-CPL-01: Minimum MPM Projectile Z vs Time During FEM Plate Impact (m vs ms)",
        "Time (ms)",
        "Min Projectile Z (m)",
        t_ms_trace, z_plate_bottom_trace, z_min_p_trace, 1.0, 5.0
    );
    res.svg_path = svg_file;

    std::ostringstream sum, det;
    sum << "CPU min_p_z=" << std::fixed << std::setprecision(4) << min_p_z
        << " m (>0.025 m non-penetration), avg_vz=" << std::setprecision(2) << avg_vz
        << " m/s (from -150 m/s), ep_max=" << std::scientific << fem_ep_max_cpu;
    if (gpu_tested) {
        sum << " | CUDA min_p_z=" << std::fixed << std::setprecision(4) << gpu_min_pz
            << " m, avg_vz=" << std::setprecision(2) << gpu_avg_vz
            << " m/s, ep_max=" << std::scientific << gpu_ep_max;
    }
    res.summary = sum.str();

    det << "FEM grid: 6x6x2 Hex8 (72 elems, dx=dy=0.04 m, dz=0.02 m, z in [0, 0.04] m); "
        << "MPM grid: 28x28x16 (dx=0.01 m, Np=" << mpm.getParticles().size() << "); "
        << "last_dt=" << std::scientific << fem_dt_last << " s, steps=" << steps
        << ". Free-flight position at t=0.25 ms without contact would be z=0.0045 m (through bottom face).";
    res.details = det.str();
    return res;
}

// -----------------------------------------------------------------------------
// VV-FEM-CPL-02: Detonation Gas Loading Against FEM Wall (Zero Wall Inflation)
// -----------------------------------------------------------------------------
BenchmarkResult run_detonation_gas_fem_wall_test() {
    BenchmarkResult res;
    res.id = "VV-FEM-CPL-02";
    res.title = "Detonation Gas MPM Contact on FEM Wall (Swollen Gas Radius Clamp & No Inflation)";
    res.level = 3;
    res.pending = false;
    res.tolerance_l2 = 2.0e-3;  // Max allowed spurious outward +z inflation (m)
    res.tolerance_linf = 1.15;  // Max element V/V0 ratio

    MaterialTable3D wall_mat{};
    wall_mat.material_model = MPMMaterialModel::Hypoelastic;
    wall_mat.density = 2400.0f;
    wall_mat.youngs_modulus = 30.0e9f;
    wall_mat.poissons_ratio = 0.22f;
    wall_mat.yield_stress = 40.0e6f;
    wall_mat.hardening_modulus = 1.0e9f;
    wall_mat.synchronizePillars();

    // FEM wall: x,y in [-0.15, 0.15], z in [0.0, 0.10], bottom fixed at z=0.0
    FEMSolver3D<float> fem;
    fem.setIntegrationScheme(FEMIntegrationScheme::OnePointFB);
    fem.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoStiffness);
    fem.setHourglassCoeff(0.05f);
    fem.setContactPenaltyScale(1.0f);
    fem.createStructuredBoxMesh(4, 4, 2, 0.30f, 0.30f, 0.10f, -0.15f, -0.15f, 0.0f, wall_mat, "Fixed Base");

    // HE charge block just above the wall (z in [0.12, 0.20]) + explicit swollen/receding gas particles
    MPMSolver3D mpm;
    mpm.initializeGrid(20, 20, 20, 0.025f, 0.025f, 0.025f, -0.25f, -0.25f, -0.05f);
    mpm.setTimeScheme(MPMTimeIntegrationScheme::Leapfrog);

    MaterialTable3D he_mat{};
    he_mat.material_model = MPMMaterialModel::JWLProgrammedBurn;
    he_mat.density = 1630.0f;
    he_mat.youngs_modulus = 10.0e9f;
    he_mat.poissons_ratio = 0.30f;
    he_mat.det_vel = 6930.0f;
    he_mat.jwl_A = 373.77e9f;
    he_mat.jwl_B = 3.747e9f;
    he_mat.jwl_R1 = 4.15f;
    he_mat.jwl_R2 = 0.90f;
    he_mat.jwl_omega = 0.35f;
    he_mat.detonation_energy = 4.29e6f;
    he_mat.synchronizePillars();
    mpm.setMaterialTable(0, he_mat);

    mpm.addBoxObject(0, 0.0f, 0.0f, 0.16f, 0.10f, 0.10f, 0.08f,
                     0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                     he_mat.density, he_mat.youngs_modulus, he_mat.poissons_ratio,
                     0.0f, 0.0f, 10.0f, 1.0e9f, 8);
    // Explicitly test swollen gas particles (lp[0]=0.35 m >> h_elem=0.05 m) moving upward (+z)
    // away from top face z=0.10 m: un-clamped radius + missing unidirectional v_rel_n check
    // would artificially inflate/pull wall nodes upward (+z).
    for (int ix = -1; ix <= 1; ++ix) {
        for (int iy = -1; iy <= 1; ++iy) {
            MPMParticle3D gp{};
            gp.x[0] = ix * 0.04f;
            gp.x[1] = iy * 0.04f;
            gp.x[2] = 0.14f;
            gp.v[0] = ix * 50.0f;
            gp.v[1] = iy * 50.0f;
            gp.v[2] = 300.0f; // Receding upward away from z=0.10 m wall
            gp.m = 0.025f;
            gp.V0 = 0.025f / 1630.0f;
            gp.V = gp.V0 * 10.0f;
            gp.lp[0] = 0.35f;
            gp.lp[1] = 0.35f;
            gp.lp[2] = 0.35f;
            gp.object_id = 0;
            gp.material_id = 0;
            mpm.addParticleDirect(gp);
        }
    }
    mpm.addDetonator(0.0f, 0.0f, 0.16f, 0.02f, 0.0f, false, 0);
    fem.setMPMSolver(&mpm);

    std::vector<double> t_us_trace;
    std::vector<double> z_top_max_trace;
    std::vector<double> z_top_ref_trace;

    double max_wall_z = 0.10;
    double min_top_vz = 0.0;
    for (int s = 0; s < 120; ++s) {
        advanceCoupledStep(fem, mpm, 0.5f, 0.3f);
        double cur_max_z = -1.0e9;
        for (const auto& n : fem.getNodes()) {
            cur_max_z = std::max(cur_max_z, static_cast<double>(n.x[2]));
            if (n.x0[2] > 0.09f) {
                min_top_vz = std::min(min_top_vz, static_cast<double>(n.v[2]));
            }
        }
        max_wall_z = std::max(max_wall_z, cur_max_z);
        t_us_trace.push_back(static_cast<double>(fem.getSimTime()) * 1.0e6);
        z_top_max_trace.push_back(cur_max_z);
        z_top_ref_trace.push_back(0.10);
    }

    double max_v_ratio = 1.0;
    bool any_nan = false;
    int eroded = 0;
    for (const auto& el : fem.getElements()) {
        if (el.is_eroded) eroded++;
        if (el.V0 > 0.0f) {
            double vr = static_cast<double>(el.V) / static_cast<double>(el.V0);
            if (!std::isfinite(vr)) any_nan = true;
            max_v_ratio = std::max(max_v_ratio, vr);
        }
    }
    const double spurious_inflation = std::max(0.0, max_wall_z - 0.10);

    res.error_l2 = spurious_inflation;
    res.error_linf = max_v_ratio;
    res.passed = !any_nan && (eroded == 0) &&
                 (spurious_inflation <= res.tolerance_l2) &&
                 (max_v_ratio <= res.tolerance_linf) &&
                 (min_top_vz < -0.01);

    std::string svg_file = "vv_fem_cpl_02_detonation_wall.svg";
    generate_svg_plot(
        svg_file,
        "VV-FEM-CPL-02: FEM Wall Top-Surface Z During Close-In HE Gas Loading (m vs us)",
        "Time (us)",
        "Max Wall Z (m)",
        t_us_trace, z_top_ref_trace, z_top_max_trace, 1.0, 5.0
    );
    res.svg_path = svg_file;

    std::ostringstream sum, det;
    sum << "Max wall Z=" << std::fixed << std::setprecision(5) << max_wall_z
        << " m (spurious +z inflation=" << spurious_inflation << " m <= 2e-3 m), "
        << "max(V/V0)=" << std::setprecision(4) << max_v_ratio
        << ", min_top_vz=" << std::setprecision(3) << min_top_vz << " m/s";
    res.summary = sum.str();

    det << "FEM wall: 4x4x2 Hex8 (32 elems, dx=dy=0.075 m, dz=0.05 m, z in [0, 0.10] m); "
        << "MPM HE + swollen gas (20x20x20, dx=0.025 m, Np=" << mpm.getParticles().size()
        << ", swollen lp=0.35 m); 120 coupled steps to t="
        << std::scientific << fem.getSimTime() << " s.";
    res.details = det.str();
    return res;
}

// -----------------------------------------------------------------------------
// VV-FEM-CPL-03: Tet4 vs Tet4_ANP, KosloffFrazier (nu=0.49), & Inverted Tet4 Erosion
// -----------------------------------------------------------------------------
BenchmarkResult run_tet4_anp_and_kf_stability_test() {
    BenchmarkResult res;
    res.id = "VV-FEM-CPL-03";
    res.title = "Tet4 vs Tet4_ANP Locking, KosloffFrazier (nu=0.49) & Inverted Tet4 Erosion";
    res.level = 2;
    res.pending = false;
    res.tolerance_l2 = 1.0e-2;
    res.tolerance_linf = 5.0e-2;

    // Part A: Cantilever beam (0.30 x 0.06 x 0.06 m, 6x2x2 hex -> tets) at near-incompressible nu=0.45
    MaterialTable3D elastic_incomp{};
    elastic_incomp.material_model = MPMMaterialModel::Hypoelastic;
    elastic_incomp.density = 2700.0f;
    elastic_incomp.youngs_modulus = 70.0e9f;
    elastic_incomp.poissons_ratio = 0.45f;
    elastic_incomp.yield_stress = 1.0e12f; // Elastic regime for bending compliance test
    elastic_incomp.hardening_modulus = 0.0f;
    elastic_incomp.synchronizePillars();

    auto run_cantilever = [&](FEMElementFormulation form) -> double {
        FEMSolver3D<float> fem;
        fem.createStructuredTetBoxMesh(6, 2, 2, 0.30f, 0.06f, 0.06f, 0.0f, 0.0f, 0.0f, elastic_incomp, "Free");
        for (auto& n : fem.getNodes()) {
            if (n.x0[0] < 1.0e-5f) {
                n.is_fixed[0] = n.is_fixed[1] = n.is_fixed[2] = true;
            } else if (n.x0[0] > 0.295f) {
                n.v[2] = -2.0f; // Initial transverse velocity impulse at tip
            }
        }
        for (auto& el : fem.getElements()) {
            el.element_formulation = static_cast<int8_t>(form);
        }
        for (int s = 0; s < 120; ++s) {
            fem.step(0.5f);
        }
        double min_tip_z_disp = 0.0;
        for (const auto& n : fem.getNodes()) {
            if (n.x0[0] > 0.295f) {
                min_tip_z_disp = std::max(min_tip_z_disp, std::abs(static_cast<double>(n.x[2] - n.x0[2])));
            }
        }
        return min_tip_z_disp;
    };

    const double disp_p1 = run_cantilever(FEMElementFormulation::Tet4_Standard);
    const double disp_anp = run_cantilever(FEMElementFormulation::Tet4_ANP);
    const bool anp_distinct_and_softer = std::isfinite(disp_p1) && std::isfinite(disp_anp) &&
                                         (disp_anp > disp_p1 * 1.02);

    // Part B: KosloffFrazier at extreme nu=0.49 (previously nu_kf could divide by 1-2*nu -> ~50x blowup)
    MaterialTable3D rubber{};
    rubber.material_model = MPMMaterialModel::Hypoelastic;
    rubber.density = 1100.0f;
    rubber.youngs_modulus = 10.0e6f;
    rubber.poissons_ratio = 0.49f;
    rubber.yield_stress = 1.0e9f;
    rubber.hardening_modulus = 0.0f;
    rubber.synchronizePillars();

    FEMSolver3D<float> fem_kf;
    fem_kf.setIntegrationScheme(FEMIntegrationScheme::OnePointKF);
    fem_kf.setHourglassModel(FEMHourglassModel::KosloffFrazier);
    fem_kf.setHourglassCoeff(0.10f);
    fem_kf.createStructuredBoxMesh(4, 4, 4, 0.20f, 0.20f, 0.20f, 0.0f, 0.0f, 0.0f, rubber, "Fixed Base");
    for (auto& n : fem_kf.getNodes()) {
        if (n.x0[2] > 0.195f) n.v[2] = -5.0f;
    }
    bool kf_nan = false;
    double kf_vmax = 0.0;
    for (int s = 0; s < 200; ++s) {
        fem_kf.step(0.5f);
        double vm = static_cast<double>(fem_kf.getMaxVelocity());
        if (!std::isfinite(vm)) { kf_nan = true; break; }
        kf_vmax = std::max(kf_vmax, vm);
    }
    const bool kf_ok = !kf_nan && (kf_vmax > 0.0) && (kf_vmax < 100.0);

    // Part C: Signed inverted Tet4 (V_tet <= 0) must erode cleanly instead of producing restoring inversion force
    FEMSolver3D<float> fem_inv;
    fem_inv.createStructuredTetBoxMesh(2, 2, 2, 0.10f, 0.10f, 0.10f, 0.0f, 0.0f, 0.0f, elastic_incomp, "Free");
    auto& inv_elems = fem_inv.getElements();
    if (!inv_elems.empty()) {
        // Flip orientation of element 0 (swap two vertices -> V_signed < 0)
        std::swap(inv_elems[0].node_ids[0], inv_elems[0].node_ids[1]);
        inv_elems[0].element_formulation = static_cast<int8_t>(FEMElementFormulation::Tet4_ANP);
    }
    for (int s = 0; s < 5; ++s) {
        fem_inv.step(0.5f);
    }
    const bool inv_eroded = (!fem_inv.getElements().empty() && fem_inv.getElements()[0].is_eroded);
    bool inv_nan = false;
    for (const auto& n : fem_inv.getNodes()) {
        if (!std::isfinite(n.x[2]) || !std::isfinite(n.v[2])) { inv_nan = true; break; }
    }

    res.passed = anp_distinct_and_softer && kf_ok && inv_eroded && !inv_nan;
    res.error_l2 = inv_eroded ? 0.0 : 1.0;
    res.error_linf = kf_nan ? 1.0 : 0.0;

    std::vector<double> xs = {1.0, 2.0, 3.0};
    std::vector<double> refs = {disp_p1, disp_anp, kf_vmax * 1.0e-5};
    std::vector<double> nums = {disp_p1, disp_anp, kf_vmax * 1.0e-5};
    std::string svg_file = "vv_fem_cpl_03_tet4_anp_kf.svg";
    generate_svg_plot(
        svg_file,
        "VV-FEM-CPL-03: Tet4_Standard vs Tet4_ANP Cantilever Deflection & KF nu=0.49 Check",
        "Subtest Case (1=Tet4_P1, 2=Tet4_ANP, 3=KF_scaled)",
        "Metric Value",
        xs, refs, nums, 1.0, 5.0
    );
    res.svg_path = svg_file;

    std::ostringstream sum, det;
    sum << "Cantilever disp Tet4_ANP=" << std::scientific << std::setprecision(4) << disp_anp
        << " m vs Tet4_P1=" << disp_p1 << " m; KF(nu=0.49) vmax=" << std::fixed << std::setprecision(2)
        << kf_vmax << " m/s; Inverted Tet4 eroded=" << (inv_eroded ? "YES" : "NO");
    res.summary = sum.str();

    det << "Part A: 6x2x2 Tet4 beam (dx=0.05, dy=dz=0.03 m, nu=0.45, 120 steps); "
        << "Part B: 4x4x4 Hex8 (dx=0.05 m, E=10 MPa, nu=0.49, 200 KF steps); "
        << "Part C: 2x2x2 Tet4 inverted elem 0 check over 5 steps.";
    res.details = det.str();
    return res;
}

// -----------------------------------------------------------------------------
// VV-FEM-CPL-04: Per-Part Formulation/Hourglass & Per-Material Erosion Isolation
// -----------------------------------------------------------------------------
BenchmarkResult run_per_part_material_isolation_test() {
    BenchmarkResult res;
    res.id = "VV-FEM-CPL-04";
    res.title = "Per-Part Formulation (Tet4 vs Hex8_SRI) & Per-Material Erosion Isolation";
    res.level = 3;
    res.pending = false;
    res.tolerance_l2 = 0.0;
    res.tolerance_linf = 0.0;

    MaterialTable3D mat0_brittle{};
    mat0_brittle.material_model = MPMMaterialModel::Hypoelastic;
    mat0_brittle.density = 7850.0f;
    mat0_brittle.youngs_modulus = 200.0e9f;
    mat0_brittle.poissons_ratio = 0.30f;
    mat0_brittle.yield_stress = 200.0e6f;
    mat0_brittle.hardening_modulus = 500.0e6f;
    mat0_brittle.enable_strain_erosion = true;
    mat0_brittle.failure_strain = 0.005f;
    mat0_brittle.erosion_strain = 0.005f;
    mat0_brittle.synchronizePillars();

    MaterialTable3D mat1_ductile = mat0_brittle;
    mat1_ductile.enable_strain_erosion = false;
    mat1_ductile.failure_strain = 0.90f;
    mat1_ductile.erosion_strain = 0.90f;
    mat1_ductile.synchronizePillars();

    FEMSolver3D<float> fem;
    // Part 0: Tet4_Standard + KosloffFrazier + brittle per-material erosion (0.005)
    fem.addStructuredTetBoxMesh(2, 2, 2, 0.10f, 0.10f, 0.10f, -0.20f, 0.0f, 0.0f, mat0_brittle, 0, 0, 0, "Fixed Base");
    // Part 1: Hex8_SRI + FlanaganBelytschkoStiffness + ductile no-erosion (0.90)
    fem.addStructuredBoxMesh(2, 2, 2, 0.10f, 0.10f, 0.10f, 0.10f, 0.0f, 0.0f, mat1_ductile, 0, 0, 0, "Fixed Base");

    for (auto& el : fem.getElements()) {
        if (el.mat_id == 0) {
            el.element_formulation = static_cast<int8_t>(FEMElementFormulation::Tet4_Standard);
            el.hourglass_model = static_cast<int8_t>(FEMHourglassModel::KosloffFrazier);
        } else {
            el.element_formulation = static_cast<int8_t>(FEMElementFormulation::Hex8_SRI);
            el.hourglass_model = static_cast<int8_t>(FEMHourglassModel::FlanaganBelytschkoStiffness);
        }
    }
    fem.ensureGaussPointHistory();

    // Drive identical top-face downward velocity v_z = -80 m/s on BOTH separate blocks
    for (auto& n : fem.getNodes()) {
        if (n.x0[2] > 0.095f) n.v[2] = -80.0f;
    }

    for (int s = 0; s < 200; ++s) {
        fem.step(0.5f);
    }

    int part0_total = 0, part0_eroded = 0;
    int part1_total = 0, part1_eroded = 0;
    float part1_ep_max = 0.0f;
    for (const auto& el : fem.getElements()) {
        if (el.mat_id == 0) {
            part0_total++;
            if (el.is_eroded) part0_eroded++;
        } else {
            part1_total++;
            if (el.is_eroded) part1_eroded++;
            part1_ep_max = std::max(part1_ep_max, el.ep_bar);
        }
    }

    const bool mats_isolated = (fem.getMaterialTables().size() == 2) &&
                               (fem.getMaterialTables()[0].enable_strain_erosion == true) &&
                               (fem.getMaterialTables()[1].enable_strain_erosion == false);
    const bool gp_alloc_ok = !fem.getGaussPointHistory().empty();
    res.passed = mats_isolated && gp_alloc_ok && (part0_eroded > 0) &&
                 (part1_eroded == 0) && (part1_ep_max > 0.005f);
    res.error_l2 = static_cast<double>(part1_eroded);
    res.error_linf = (part0_eroded > 0) ? 0.0 : 1.0;

    std::vector<double> xs = {0.0, 1.0};
    std::vector<double> refs = {static_cast<double>(part0_total), 0.0};
    std::vector<double> nums = {static_cast<double>(part0_eroded), static_cast<double>(part1_eroded)};
    std::string svg_file = "vv_fem_cpl_04_per_part_isolation.svg";
    generate_svg_plot(
        svg_file,
        "VV-FEM-CPL-04: Eroded Element Count by Part (Part 0 Brittle vs Part 1 Ductile Hex8_SRI)",
        "Part ID",
        "Eroded Elements",
        xs, refs, nums, 1.0, 5.0
    );
    res.svg_path = svg_file;

    std::ostringstream sum, det;
    sum << "Part0(Tet4, eps_fail=0.005) eroded=" << part0_eroded << "/" << part0_total
        << " | Part1(Hex8_SRI, ductile) eroded=" << part1_eroded << "/" << part1_total
        << ", part1_ep_max=" << std::scientific << part1_ep_max;
    res.summary = sum.str();

    det << "Two isolated 0.10 m cubes (2x2x2 Tet4 vs 2x2x2 Hex8_SRI) driven at top vz=-80 m/s for 200 steps. "
        << "Verified m_material_tables[0] vs [1] erosion isolation, Hex8_SRI 8-GP history allocation ("
        << fem.getGaussPointHistory().size() << " entries), and zero leakage onto Part 1.";
    res.details = det.str();
    return res;
}

// -----------------------------------------------------------------------------
// VV-FEM-CPL-05: Hypoelastic Steel + Detonator Must Not Burn & Yields Plastically
// -----------------------------------------------------------------------------
BenchmarkResult run_hypoelastic_detonator_no_burn_test() {
    BenchmarkResult res;
    res.id = "VV-FEM-CPL-05";
    res.title = "Hypoelastic Steel with JWL Fields & Active Detonator (No Burn & Plastic Yield)";
    res.level = 2;
    res.pending = false;
    res.tolerance_l2 = 1.0e-3;
    res.tolerance_linf = 1.0e-2;

    MaterialTable3D steel_with_jwl{};
    steel_with_jwl.material_model = MPMMaterialModel::Hypoelastic;
    steel_with_jwl.density = 7850.0f;
    steel_with_jwl.youngs_modulus = 200.0e9f;
    steel_with_jwl.poissons_ratio = 0.26f;
    steel_with_jwl.yield_stress = 250.0e6f;
    steel_with_jwl.hardening_modulus = 1.0e9f;
    steel_with_jwl.failure_strain = 0.50f;
    steel_with_jwl.erosion_strain = 0.50f;
    steel_with_jwl.enable_strain_erosion = false;
    // Populate unused JWL fields as emitted by frontend material presets to ensure
    // Hypoelastic steel never mis-triggers programmed burn when a detonator exists.
    steel_with_jwl.jwl_A = 373.77e9f;
    steel_with_jwl.jwl_B = 3.747e9f;
    steel_with_jwl.jwl_R1 = 4.15f;
    steel_with_jwl.jwl_R2 = 0.90f;
    steel_with_jwl.jwl_omega = 0.35f;
    steel_with_jwl.det_vel = 6930.0f;
    steel_with_jwl.detonation_energy = 4.29e6f;
    steel_with_jwl.solid_model = SolidReactantEOS::MieGruneisen;
    steel_with_jwl.product_model = DetonationProductEOS::JWLProductGas;
    steel_with_jwl.synchronizePillars();

    // Part A: Quiescent steel block directly over an active t=0 detonator must stay bounded (no burn)
    FEMSolver3D<float> fem_quiescent;
    fem_quiescent.setIntegrationScheme(FEMIntegrationScheme::SelectiveReduced);
    fem_quiescent.createStructuredBoxMesh(3, 3, 3, 0.12f, 0.12f, 0.12f, -0.06f, -0.06f, 0.0f, steel_with_jwl, "Fixed Base");
    fem_quiescent.addDetonator(0.0f, 0.0f, 0.06f, 0.02f, 0.0f, -1);
    for (int s = 0; s < 120; ++s) {
        fem_quiescent.step(0.5f);
    }

    double quiescent_max_v = 0.0;
    double quiescent_max_p = 0.0;
    double quiescent_max_lambda = 0.0;
    for (const auto& n : fem_quiescent.getNodes()) {
        double vmag = std::sqrt(n.v[0] * n.v[0] + n.v[1] * n.v[1] + n.v[2] * n.v[2]);
        quiescent_max_v = std::max(quiescent_max_v, vmag);
    }
    for (const auto& el : fem_quiescent.getElements()) {
        double p_el = -(el.sigma[0][0] + el.sigma[1][1] + el.sigma[2][2]) / 3.0;
        quiescent_max_p = std::max(quiescent_max_p, std::abs(p_el));
        quiescent_max_lambda = std::max(quiescent_max_lambda, static_cast<double>(el.lambda));
    }

    // Part B: Dynamic compression of same steel block + detonator produces J2 plastic yielding
    FEMSolver3D<float> fem_yield;
    fem_yield.setIntegrationScheme(FEMIntegrationScheme::SelectiveReduced);
    fem_yield.createStructuredBoxMesh(3, 3, 3, 0.12f, 0.12f, 0.12f, -0.06f, -0.06f, 0.0f, steel_with_jwl, "Fixed Base");
    fem_yield.addDetonator(0.0f, 0.0f, 0.06f, 0.02f, 0.0f, -1);
    for (auto& n : fem_yield.getNodes()) {
        if (n.x0[2] > 0.115f) n.v[2] = -60.0f;
    }

    std::vector<double> step_ids, ep_ref_trace, ep_cpu_trace;
    for (int s = 0; s < 120; ++s) {
        fem_yield.step(0.5f);
        step_ids.push_back(static_cast<double>(s + 1));
        ep_cpu_trace.push_back(static_cast<double>(fem_yield.getMaxPlasticStrain()));
    }
    double yield_ep_cpu = static_cast<double>(fem_yield.getMaxPlasticStrain());

    bool gpu_tested = false;
    bool gpu_ok = true;
    double yield_ep_gpu = yield_ep_cpu;
    if (hasCudaDeviceAvailable()) {
        gpu_tested = true;
        FEMSolver3DCUDA<float> fem_gpu;
        fem_gpu.setIntegrationScheme(FEMIntegrationScheme::SelectiveReduced);
        fem_gpu.createStructuredBoxMesh(3, 3, 3, 0.12f, 0.12f, 0.12f, -0.06f, -0.06f, 0.0f, steel_with_jwl, "Fixed Base");
        fem_gpu.addDetonator(0.0f, 0.0f, 0.06f, 0.02f, 0.0f, -1);
        for (auto& n : fem_gpu.getCpuSolver().getNodes()) {
            if (n.x0[2] > 0.115f) n.v[2] = -60.0f;
        }
        fem_gpu.syncToDevice();
        for (int s = 0; s < 120; ++s) {
            fem_gpu.step(0.5f);
        }
        fem_gpu.syncToHost();
        yield_ep_gpu = static_cast<double>(fem_gpu.getMaxPlasticStrain());
        gpu_ok = std::isfinite(yield_ep_gpu) && (yield_ep_gpu > 1.0e-3);
    }

    ep_ref_trace.assign(step_ids.size(), ep_cpu_trace.empty() ? 0.0 : ep_cpu_trace.back());
    double rel_cpu_gpu = gpu_tested
        ? std::abs(yield_ep_cpu - yield_ep_gpu) / std::max(1.0e-9, std::max(yield_ep_cpu, yield_ep_gpu))
        : 0.0;

    res.passed = std::isfinite(quiescent_max_v) && std::isfinite(yield_ep_cpu) &&
                 (quiescent_max_v < 1.0e-3) && (quiescent_max_p < 1.0) &&
                 (quiescent_max_lambda == 0.0) &&
                 (yield_ep_cpu > 1.0e-3) && gpu_ok && (rel_cpu_gpu < 0.05);
    res.error_l2 = rel_cpu_gpu;
    res.error_linf = quiescent_max_v;

    std::string svg_file = "vv_fem_cpl_05_hypoelastic_no_burn.svg";
    generate_svg_plot(
        svg_file,
        "VV-FEM-CPL-05: Hypoelastic Steel Peak Plastic Strain Under Compression (With Active Detonator)",
        "Step",
        "Max Equivalent Plastic Strain",
        step_ids, ep_cpu_trace, ep_cpu_trace, 1.0, 5.0
    );
    res.svg_path = svg_file;

    std::ostringstream sum, det;
    sum << "quiescent_vmax=" << std::scientific << quiescent_max_v
        << " m/s, yield_ep_cpu=" << yield_ep_cpu
        << ", yield_ep_gpu=" << yield_ep_gpu;
    res.summary = sum.str();

    det << "FEM grid: 3x3x3 Hex8_SRI (27 elems, dx=0.04 m, 0.12 m cube) + active Detonator at center (t=0). "
        << "Verified unused JWL fields on Hypoelastic steel never trigger burn, and J2 plastic yielding activates properly.";
    res.details = det.str();
    return res;
}

// -----------------------------------------------------------------------------
// VV-FEM-CPL-06: Per-Element SelectiveReduced (B-Bar) Under OnePointFB Default
// -----------------------------------------------------------------------------
BenchmarkResult run_per_element_sri_bbar_test() {
    BenchmarkResult res;
    res.id = "VV-FEM-CPL-06";
    res.title = "Per-Element SelectiveReduced (B-Bar) Override Under OnePointFB Domain Default";
    res.level = 2;
    res.pending = false;
    res.tolerance_l2 = 1.0e-2;
    res.tolerance_linf = 2.0e-2;

    MaterialTable3D steel{};
    steel.material_model = MPMMaterialModel::Hypoelastic;
    steel.density = 7850.0f;
    steel.youngs_modulus = 200.0e9f;
    steel.poissons_ratio = 0.28f;
    steel.yield_stress = 250.0e6f;
    steel.hardening_modulus = 1.0e9f;
    steel.synchronizePillars();

    // Global domain default = OnePointFB, while elements override to Hex8_SRI (B-bar)
    FEMSolver3D<float> fem_cpu;
    fem_cpu.setIntegrationScheme(FEMIntegrationScheme::OnePointFB);
    fem_cpu.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoStiffness);
    fem_cpu.setHourglassCoeff(0.05f);
    fem_cpu.createStructuredBoxMesh(3, 3, 3, 0.15f, 0.15f, 0.15f, 0.0f, 0.0f, 0.0f, steel, "Fixed Base");
    for (auto& el : fem_cpu.getElements()) {
        el.element_formulation = static_cast<int8_t>(FEMElementFormulation::Hex8_SRI);
    }
    fem_cpu.ensureGaussPointHistory();
    for (auto& n : fem_cpu.getNodes()) {
        if (n.x0[2] > 0.145f) n.v[2] = -60.0f;
    }

    for (int s = 0; s < 120; ++s) {
        fem_cpu.step(0.5f);
    }

    const size_t expected_gp = fem_cpu.getElements().size();
    const bool gp_ok = (fem_cpu.getGaussPointHistory().size() == expected_gp);
    double cpu_ep_max = static_cast<double>(fem_cpu.getMaxPlasticStrain());
    double cpu_min_z_top = 1e9;
    bool cpu_finite = std::isfinite(cpu_ep_max);
    for (const auto& n : fem_cpu.getNodes()) {
        if (!std::isfinite(n.x[2]) || !std::isfinite(n.v[2])) cpu_finite = false;
        if (n.x0[2] > 0.145f) cpu_min_z_top = std::min(cpu_min_z_top, static_cast<double>(n.x[2]));
    }

    // Compare against native SelectiveReduced domain run (should match CPU Hex8_SRI identically)
    FEMSolver3D<float> fem_ref;
    fem_ref.setIntegrationScheme(FEMIntegrationScheme::SelectiveReduced);
    fem_ref.createStructuredBoxMesh(3, 3, 3, 0.15f, 0.15f, 0.15f, 0.0f, 0.0f, 0.0f, steel, "Fixed Base");
    for (auto& n : fem_ref.getNodes()) {
        if (n.x0[2] > 0.145f) n.v[2] = -60.0f;
    }
    for (int s = 0; s < 120; ++s) {
        fem_ref.step(0.5f);
    }
    double ref_ep_max = static_cast<double>(fem_ref.getMaxPlasticStrain());
    double cpu_ref_err = std::abs(cpu_ep_max - ref_ep_max) / std::max(1.0e-9, ref_ep_max);

    bool gpu_tested = false;
    bool gpu_ok = true;
    double gpu_ep_max = cpu_ep_max;
    double gpu_cpu_err = 0.0;
    if (hasCudaDeviceAvailable()) {
        gpu_tested = true;
        FEMSolver3DCUDA<float> fem_gpu;
        fem_gpu.setIntegrationScheme(FEMIntegrationScheme::OnePointFB);
        fem_gpu.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoStiffness);
        fem_gpu.setHourglassCoeff(0.05f);
        fem_gpu.createStructuredBoxMesh(3, 3, 3, 0.15f, 0.15f, 0.15f, 0.0f, 0.0f, 0.0f, steel, "Fixed Base");
        for (auto& el : fem_gpu.getCpuSolver().getElements()) {
            el.element_formulation = static_cast<int8_t>(FEMElementFormulation::Hex8_SRI);
        }
        fem_gpu.getCpuSolver().ensureGaussPointHistory();
        for (auto& n : fem_gpu.getCpuSolver().getNodes()) {
            if (n.x0[2] > 0.145f) n.v[2] = -60.0f;
        }
        fem_gpu.syncToDevice();
        for (int s = 0; s < 120; ++s) {
            fem_gpu.step(0.5f);
        }
        fem_gpu.syncToHost();
        gpu_ep_max = static_cast<double>(fem_gpu.getMaxPlasticStrain());
        gpu_cpu_err = std::abs(gpu_ep_max - cpu_ep_max) / std::max(1.0e-9, cpu_ep_max);
        gpu_ok = std::isfinite(gpu_ep_max) && (gpu_ep_max > 1.0e-3) && (gpu_cpu_err < 0.02);
    }

    res.passed = gp_ok && cpu_finite && (cpu_ep_max > 1.0e-3) && (cpu_ref_err < 1.0e-4) && gpu_ok;
    res.error_l2 = std::max(cpu_ref_err, gpu_cpu_err);
    res.error_linf = std::abs(0.15 - cpu_min_z_top);

    std::vector<double> xs = {0.0, 1.0};
    std::vector<double> refs = {ref_ep_max, ref_ep_max};
    std::vector<double> nums = {cpu_ep_max, gpu_ep_max};
    std::string svg_file = "vv_fem_cpl_06_per_elem_sri.svg";
    generate_svg_plot(
        svg_file,
        "VV-FEM-CPL-06: Per-Element Hex8_SRI Override vs Domain SelectiveReduced (Max ep_bar)",
        "Device (0=CPU, 1=GPU)",
        "Max Equivalent Plastic Strain",
        xs, refs, nums, 1.0, 5.0
    );
    res.svg_path = svg_file;

    std::ostringstream sum, det;
    sum << "gp_count=" << fem_cpu.getGaussPointHistory().size()
        << ", cpu_ep=" << std::scientific << cpu_ep_max
        << ", ref_ep=" << ref_ep_max
        << ", gpu_ep=" << gpu_ep_max
        << ", rel_diff=" << res.error_l2;
    res.summary = sum.str();

    det << "FEM grid: 3x3x3 Hex8_SRI (27 elems, 216 Gauss points, dx=0.05 m) under global OnePointFB domain default, "
        << "120 steps top vz=-60 m/s. Verified per-element B-bar (d_dev_g - local div_v) matches native SelectiveReduced on CPU"
        << (gpu_tested ? " & CUDA." : " (CUDA skipped - no device).");
    res.details = det.str();
    return res;
}

// -----------------------------------------------------------------------------
// VV-FEM-CPL-07: JohnsonCookMieGruneisen Symplectic Volume Phase-Alignment &
// Impact Stability (CPU/CUDA, FP32/FP64, SelectiveReduced & OnePointFB)
// -----------------------------------------------------------------------------
template <typename T>
struct JCMGCaseStats {
    double max_vm = 0.0;
    double max_ep = 0.0;
    double max_dmg = 0.0;
    int eroded = 0;
    int detached = 0;
    int num_nodes = 0;
    bool finite = true;
};

template <typename T>
JCMGCaseStats<T> collectFEMStats(const FEMSolver3D<T>& solver) {
    JCMGCaseStats<T> st;
    st.num_nodes = static_cast<int>(solver.getNodes().size());
    for (const auto& el : solver.getElements()) {
        if (el.is_eroded) st.eroded++;
        if (el.is_detached) st.detached++;
        if (!std::isfinite(static_cast<double>(el.ep_bar)) || !std::isfinite(static_cast<double>(el.damage))) {
            st.finite = false;
            continue;
        }
        st.max_ep = std::max(st.max_ep, static_cast<double>(el.ep_bar));
        st.max_dmg = std::max(st.max_dmg, static_cast<double>(el.damage));
        const double sxx = static_cast<double>(el.sigma[0][0]);
        const double syy = static_cast<double>(el.sigma[1][1]);
        const double szz = static_cast<double>(el.sigma[2][2]);
        const double sxy = static_cast<double>(el.sigma[0][1]);
        const double syz = static_cast<double>(el.sigma[1][2]);
        const double szx = static_cast<double>(el.sigma[2][0]);
        double vm = std::sqrt(0.5 * ((sxx - syy)*(sxx - syy) + (syy - szz)*(syy - szz) + (szz - sxx)*(szz - sxx)
                          + 6.0 * (sxy*sxy + syz*syz + szx*szx)));
        if (!std::isfinite(vm)) {
            st.finite = false;
        } else {
            st.max_vm = std::max(st.max_vm, vm);
        }
    }
    return st;
}

MaterialTable3D makeA36SteelJCMG() {
    MaterialTable3D mat{};
    mat.material_model = MPMMaterialModel::JohnsonCookMieGruneisen;
    mat.density = 7850.0f;
    mat.youngs_modulus = 200.0e9f;
    mat.poissons_ratio = 0.26f;
    mat.yield_stress = 250.0e6f;
    mat.hardening_modulus = 475.0e6f;
    mat.jc_A = 250.0e6f;
    mat.jc_B = 475.0e6f;
    mat.jc_n = 0.36f;
    mat.jc_C = 0.014f;
    mat.jc_m = 1.03f;
    mat.jc_d1 = 0.05f;
    mat.jc_d2 = 3.44f;
    mat.jc_d3 = -2.12f;
    mat.jc_d4 = 0.002f;
    mat.jc_d5 = 0.61f;
    mat.mg_c0 = 4570.0f;
    mat.mg_s = 1.49f;
    mat.mg_gamma0 = 2.17f;
    mat.T_room = 293.0f;
    mat.T_melt = 1793.0f;
    mat.Cp = 475.0f;
    mat.failure_strain = 0.60f;
    mat.erosion_strain = 0.20f;
    mat.enable_strain_erosion = true;
    mat.enable_heterogeneity = false;
    mat.weibull_modulus = 0.0f;
    mat.synchronizePillars();
    return mat;
}

template <typename T>
JCMGCaseStats<T> runJCMGRigidTranslationCPU(FEMIntegrationScheme scheme, double vz, int steps) {
    MaterialTable3D mat = makeA36SteelJCMG();
    FEMSolver3D<T> fem;
    fem.setIntegrationScheme(scheme);
    fem.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoStiffness);
    fem.setHourglassCoeff(0.05);
    fem.createStructuredBoxMesh(4, 4, 4,
                                static_cast<T>(0.20), static_cast<T>(0.20), static_cast<T>(0.20),
                                static_cast<T>(0.0), static_cast<T>(0.0), static_cast<T>(0.0),
                                mat, "");
    for (auto& n : fem.getNodes()) {
        n.v[2] = static_cast<T>(vz);
    }
    for (int s = 0; s < steps; ++s) {
        fem.step(static_cast<T>(0.6));
    }
    return collectFEMStats(fem);
}

template <typename T>
JCMGCaseStats<T> runJCMGRigidTranslationGPU(FEMIntegrationScheme scheme, double vz, int steps) {
    MaterialTable3D mat = makeA36SteelJCMG();
    FEMSolver3DCUDA<T> fem;
    fem.setIntegrationScheme(scheme);
    fem.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoStiffness);
    fem.setHourglassCoeff(static_cast<T>(0.05));
    fem.createStructuredBoxMesh(4, 4, 4,
                                static_cast<T>(0.20), static_cast<T>(0.20), static_cast<T>(0.20),
                                static_cast<T>(0.0), static_cast<T>(0.0), static_cast<T>(0.0),
                                mat, "");
    for (auto& n : fem.getCpuSolver().getNodes()) {
        n.v[2] = static_cast<T>(vz);
    }
    fem.syncToDevice();
    for (int s = 0; s < steps; ++s) {
        fem.step(static_cast<T>(0.6));
    }
    fem.syncToHost();
    return collectFEMStats(fem.getCpuSolver());
}

BenchmarkResult run_jc_mg_phase_stability_test() {
    BenchmarkResult res;
    res.id = "VV-FEM-CPL-07";
    res.title = "JohnsonCookMieGruneisen Volume Phase-Alignment & Impact Stability";
    res.level = 3;
    res.pending = false;
    res.tolerance_l2 = 1.0e-2;
    res.tolerance_linf = 5.0e-2;

    const int n_steps = 250;
    const double yield_ref = 250.0e6;

    // Part A: Rigid-body & quiescent stability across CPU/CUDA, FP32/FP64, SRI/OnePointFB
    auto cpu_fp32_sri = runJCMGRigidTranslationCPU<float>(FEMIntegrationScheme::SelectiveReduced, -10.0, n_steps);
    auto cpu_fp32_fb  = runJCMGRigidTranslationCPU<float>(FEMIntegrationScheme::OnePointFB,       -10.0, n_steps);
    auto cpu_fp64_fb  = runJCMGRigidTranslationCPU<double>(FEMIntegrationScheme::OnePointFB,      -10.0, n_steps);

    bool cpu_ok =
        cpu_fp32_sri.finite && cpu_fp32_sri.eroded == 0 && cpu_fp32_sri.max_ep == 0.0 && cpu_fp32_sri.max_dmg == 0.0 && cpu_fp32_sri.max_vm < 1.0e6 &&
        cpu_fp32_fb.finite  && cpu_fp32_fb.eroded  == 0 && cpu_fp32_fb.max_ep  == 0.0 && cpu_fp32_fb.max_dmg  == 0.0 && cpu_fp32_fb.max_vm  < 1.0e6 &&
        cpu_fp64_fb.finite  && cpu_fp64_fb.eroded  == 0 && cpu_fp64_fb.max_ep  == 0.0 && cpu_fp64_fb.max_dmg  == 0.0 && cpu_fp64_fb.max_vm  < 1.0;

    bool gpu_tested = false;
    bool gpu_ok = true;
    JCMGCaseStats<float>  gpu_fp32_q{};
    JCMGCaseStats<float>  gpu_fp32_sri{};
    JCMGCaseStats<float>  gpu_fp32_fb{};
    JCMGCaseStats<double> gpu_fp64_sri{};
    if (hasCudaDeviceAvailable()) {
        gpu_tested = true;
        gpu_fp32_q   = runJCMGRigidTranslationGPU<float>(FEMIntegrationScheme::SelectiveReduced,  0.0, n_steps);
        gpu_fp32_sri = runJCMGRigidTranslationGPU<float>(FEMIntegrationScheme::SelectiveReduced, -10.0, n_steps);
        gpu_fp32_fb  = runJCMGRigidTranslationGPU<float>(FEMIntegrationScheme::OnePointFB,       -10.0, n_steps);
        gpu_fp64_sri = runJCMGRigidTranslationGPU<double>(FEMIntegrationScheme::SelectiveReduced, -10.0, n_steps);
        gpu_ok =
            gpu_fp32_q.finite   && gpu_fp32_q.eroded   == 0 && gpu_fp32_q.max_ep   == 0.0 && gpu_fp32_q.max_dmg   == 0.0 && gpu_fp32_q.max_vm   < 1.0e6 &&
            gpu_fp32_sri.finite && gpu_fp32_sri.eroded == 0 && gpu_fp32_sri.max_ep == 0.0 && gpu_fp32_sri.max_dmg == 0.0 && gpu_fp32_sri.max_vm < 1.0e6 &&
            gpu_fp32_fb.finite  && gpu_fp32_fb.eroded  == 0 && gpu_fp32_fb.max_ep  == 0.0 && gpu_fp32_fb.max_dmg  == 0.0 && gpu_fp32_fb.max_vm  < 1.0e6 &&
            gpu_fp64_sri.finite && gpu_fp64_sri.eroded == 0 && gpu_fp64_sri.max_ep == 0.0 && gpu_fp64_sri.max_dmg == 0.0 && gpu_fp64_sri.max_vm < 1.0;
    }

    // Part B: Localized MPM steel projectile impact on JC+MG FEM steel block (erosion_strain=0.20)
    MaterialTable3D mat_imp = makeA36SteelJCMG();
    FEMSolver3D<float> fem_imp;
    fem_imp.setIntegrationScheme(FEMIntegrationScheme::SelectiveReduced);
    fem_imp.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoStiffness);
    fem_imp.setHourglassCoeff(0.05f);
    fem_imp.setContactPenaltyScale(1.0f);
    fem_imp.createStructuredBoxMesh(6, 6, 4, 0.24f, 0.24f, 0.16f, -0.12f, -0.12f, 0.0f, mat_imp, "Fixed Base");

    MPMSolver3D mpm_imp;
    mpm_imp.initializeGrid(28, 28, 26, 0.01f, 0.01f, 0.01f, -0.14f, -0.14f, -0.02f);
    mpm_imp.setTimeScheme(MPMTimeIntegrationScheme::Leapfrog);
    mpm_imp.addBoxObject(0, 0.0f, 0.0f, 0.19f, 0.06f, 0.06f, 0.06f,
                         0.0f, 0.0f, -120.0f, 0.0f, 0.0f, 0.0f,
                         7850.0f, 200.0e9f, 0.26f, 600.0e6f, 1.0e9f, 0.80f, 1.0e9f, 8);
    fem_imp.setMPMSolver(&mpm_imp);
    for (int s = 0; s < 160; ++s) {
        advanceCoupledStep(fem_imp, mpm_imp, 0.6f, 0.3f);
    }

    double impact_ep_max = 0.0;
    double distant_ep_max = 0.0;
    int distant_eroded = 0;
    bool impact_finite = true;
    const auto& nodes_imp = fem_imp.getNodes();
    for (const auto& el : fem_imp.getElements()) {
        double cz = 0.0;
        for (int k = 0; k < 8; ++k) cz += static_cast<double>(nodes_imp[el.node_ids[k]].x0[2]);
        cz *= 0.125;
        if (!std::isfinite(static_cast<double>(el.ep_bar))) impact_finite = false;
        impact_ep_max = std::max(impact_ep_max, static_cast<double>(el.ep_bar));
        if (cz < 0.08) {
            if (el.is_eroded) distant_eroded++;
            distant_ep_max = std::max(distant_ep_max, static_cast<double>(el.ep_bar));
        }
    }
    bool impact_ok = impact_finite && (impact_ep_max > 1.0e-3) && (distant_eroded == 0) && (distant_ep_max < 0.02);

    double worst_vm = std::max({cpu_fp32_sri.max_vm, cpu_fp32_fb.max_vm, cpu_fp64_fb.max_vm,
                                gpu_fp32_q.max_vm, gpu_fp32_sri.max_vm, gpu_fp32_fb.max_vm, gpu_fp64_sri.max_vm});

    res.passed = cpu_ok && gpu_ok && impact_ok;
    res.error_l2 = worst_vm / yield_ref;
    res.error_linf = distant_ep_max;

    std::vector<double> xs = {0.0, 1.0, 2.0, 3.0, 4.0, 5.0};
    std::vector<double> refs = {1.0, 1.0, 1.0, 1.0, 1.0, 1.0};
    std::vector<double> nums = {
        1.0 + cpu_fp32_sri.max_vm / yield_ref,
        1.0 + cpu_fp32_fb.max_vm / yield_ref,
        1.0 + cpu_fp64_fb.max_vm / yield_ref,
        1.0 + (gpu_tested ? gpu_fp32_sri.max_vm : cpu_fp32_sri.max_vm) / yield_ref,
        1.0 + (gpu_tested ? gpu_fp32_fb.max_vm : cpu_fp32_fb.max_vm) / yield_ref,
        1.0 + (gpu_tested ? gpu_fp64_sri.max_vm : cpu_fp64_fb.max_vm) / yield_ref
    };
    std::string svg_file = "vv_fem_cpl_07_jc_mg_stability.svg";
    generate_svg_plot(
        svg_file,
        "VV-FEM-CPL-07: JC+MG Rigid Translation Spurious Stress Ratio (1 + vm_max / A)",
        "Case (0=CPU32-SRI, 1=CPU32-FB, 2=CPU64-FB, 3=GPU32-SRI, 4=GPU32-FB, 5=GPU64-SRI)",
        "Normalized Stress (1.0 = Zero Spurious Growth)",
        xs, refs, nums, 1.0, 5.0
    );
    res.svg_path = svg_file;

    std::ostringstream sum, det;
    sum << "cpu32_sri_vm=" << std::scientific << cpu_fp32_sri.max_vm
        << " Pa, cpu32_fb_vm=" << cpu_fp32_fb.max_vm
        << " Pa, gpu32_sri_vm=" << gpu_fp32_sri.max_vm
        << " Pa, rigid_ep=" << std::max({cpu_fp32_sri.max_ep, cpu_fp32_fb.max_ep, gpu_fp32_sri.max_ep, gpu_fp32_fb.max_ep})
        << ", impact_ep=" << impact_ep_max
        << ", dist_ep=" << distant_ep_max
        << ", dist_eroded=" << distant_eroded;
    res.summary = sum.str();

    det << "Part A: 4x4x4 Hex8 (64 elems, dx=0.05 m) Structural Steel A36 JohnsonCookMieGruneisen, 250 steps at CFL=0.6 (vz=0 & -10 m/s), "
        << "CPU/CUDA FP32/FP64 SelectiveReduced & OnePointFB. Part B: 6x6x4 Hex8 (144 elems, dx=0.04 m) + MPM steel projectile (28x28x26, dx=0.01 m, vz=-120 m/s), 160 coupled steps.";
    res.details = det.str();
    return res;
}

// -----------------------------------------------------------------------------
// VV-FEM-CPL-08: Per-Object / Per-Material Erosion Isolation (CPU + CUDA)
// Verifies that with global FEMErosionCriteria disabled, only materials with
// explicit per-material/per-object erosion flags erode while adjacent unflagged
// deformable objects undergo large plastic deformation with zero erosion.
// -----------------------------------------------------------------------------
BenchmarkResult run_per_object_erosion_isolation_cpu_gpu_test() {
    BenchmarkResult res;
    res.id = "VV-FEM-CPL-08";
    res.title = "Per-Object / Per-Material Erosion Isolation Without Global Overrides (CPU + CUDA)";
    res.level = 3;
    res.pending = false;
    res.tolerance_l2 = 0.0;
    res.tolerance_linf = 0.0;

    MaterialTable3D mat0_erodible{};
    mat0_erodible.material_model = MPMMaterialModel::Hypoelastic;
    mat0_erodible.density = 7850.0f;
    mat0_erodible.youngs_modulus = 200.0e9f;
    mat0_erodible.poissons_ratio = 0.30f;
    mat0_erodible.yield_stress = 250.0e6f;
    mat0_erodible.hardening_modulus = 400.0e6f;
    mat0_erodible.enable_strain_erosion = true;
    mat0_erodible.failure_strain = 0.015f;
    mat0_erodible.erosion_strain = 0.015f;
    mat0_erodible.enable_stress_erosion = false;
    mat0_erodible.enable_damage_erosion = false;
    mat0_erodible.enable_timestep_erosion = true;
    mat0_erodible.timestep_erosion_factor = 0.10f;
    mat0_erodible.min_volume_ratio = 0.02f;
    mat0_erodible.max_volume_ratio = 5.00f;
    mat0_erodible.synchronizePillars();

    MaterialTable3D mat1_non_eroding = mat0_erodible;
    mat1_non_eroding.enable_strain_erosion = false;
    mat1_non_eroding.enable_stress_erosion = false;
    mat1_non_eroding.enable_damage_erosion = false;
    mat1_non_eroding.enable_timestep_erosion = false;
    mat1_non_eroding.synchronizePillars();

    auto setup_blocks = [&](FEMSolver3D<float>& solver) {
        // Explicit opt-out of any global overrides (all enable_* = false)
        FEMErosionCriteria<float> no_global{};
        solver.setErosionCriteria(no_global);
        solver.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoStiffness);
        solver.setHourglassCoeff(0.05f);
        // Side-by-side 3x3x3 Hex8 blocks (dx = 0.05 m) separated cleanly in X
        solver.addStructuredBoxMesh(3, 3, 3, 0.15f, 0.15f, 0.15f, -0.30f, 0.0f, 0.0f, mat0_erodible, 0.0f, 0.0f, 0.0f, "Fixed Base");
        solver.addStructuredBoxMesh(3, 3, 3, 0.15f, 0.15f, 0.15f,  0.15f, 0.0f, 0.0f, mat1_non_eroding, 0.0f, 0.0f, 0.0f, "Fixed Base");
        for (auto& n : solver.getNodes()) {
            if (n.x0[2] > 0.145f) {
                n.v[2] = -150.0f;
            }
        }
    };

    auto measure_blocks = [](const FEMSolver3D<float>& solver, int& eroded_m0, int& eroded_m1, double& max_ep_m1, bool& finite) {
        eroded_m0 = 0;
        eroded_m1 = 0;
        max_ep_m1 = 0.0;
        finite = true;
        for (const auto& el : solver.getElements()) {
            if (!std::isfinite(el.ep_bar) || !std::isfinite(el.V)) finite = false;
            if (el.mat_id == 0) {
                if (el.is_eroded) eroded_m0++;
            } else {
                if (el.is_eroded) eroded_m1++;
                max_ep_m1 = std::max(max_ep_m1, static_cast<double>(el.ep_bar));
            }
        }
    };

    FEMSolver3D<float> fem_cpu;
    setup_blocks(fem_cpu);
    for (int s = 0; s < 160; ++s) {
        fem_cpu.step(0.5f);
    }
    int cpu_e0 = 0, cpu_e1 = 0;
    double cpu_ep1 = 0.0;
    bool cpu_finite = true;
    measure_blocks(fem_cpu, cpu_e0, cpu_e1, cpu_ep1, cpu_finite);

    bool gpu_tested = false;
    int gpu_e0 = cpu_e0, gpu_e1 = cpu_e1;
    double gpu_ep1 = cpu_ep1;
    bool gpu_finite = true;
    if (hasCudaDeviceAvailable()) {
        gpu_tested = true;
        FEMSolver3DCUDA<float> fem_gpu;
        setup_blocks(fem_gpu.getCpuSolver());
        fem_gpu.syncToDevice();
        for (int s = 0; s < 160; ++s) {
            fem_gpu.step(0.5f);
        }
        fem_gpu.syncToHost();
        measure_blocks(fem_gpu.getCpuSolver(), gpu_e0, gpu_e1, gpu_ep1, gpu_finite);
    }

    const bool cpu_ok = cpu_finite && (cpu_e0 > 0) && (cpu_e1 == 0) && (cpu_ep1 > 0.015);
    const bool gpu_ok = !gpu_tested || (gpu_finite && (gpu_e0 > 0) && (gpu_e1 == 0) && (gpu_ep1 > 0.015));
    res.passed = cpu_ok && gpu_ok;
    res.error_l2 = static_cast<double>(cpu_e1 + (gpu_tested ? gpu_e1 : 0));
    res.error_linf = (cpu_e0 > 0 && (!gpu_tested || gpu_e0 > 0)) ? 0.0 : 1.0;

    std::vector<double> xs = {0.0, 1.0, 2.0, 3.0};
    std::vector<double> refs = {1.0, 0.0, 1.0, 0.0};
    std::vector<double> nums = {
        cpu_e0 > 0 ? 1.0 : 0.0,
        static_cast<double>(cpu_e1),
        gpu_e0 > 0 ? 1.0 : 0.0,
        static_cast<double>(gpu_e1)
    };
    std::string svg_file = "vv_fem_cpl_08_per_object_erosion.svg";
    generate_svg_plot(
        svg_file,
        "VV-FEM-CPL-08: Eroded Indicator by Material & Backend (0=CPU-M0, 1=CPU-M1, 2=GPU-M0, 3=GPU-M1)",
        "Case Index (Mat 0 Erodible vs Mat 1 Isolated)",
        "Eroded Indicator / Count",
        xs, refs, nums, 0.0, 3.0
    );
    res.svg_path = svg_file;

    std::ostringstream sum, det;
    sum << "cpu_e0=" << cpu_e0 << "/27, cpu_e1=" << cpu_e1 << " (max_ep1=" << std::scientific << cpu_ep1 << ")"
        << ", gpu_e0=" << gpu_e0 << "/27, gpu_e1=" << gpu_e1 << " (max_ep1=" << gpu_ep1 << ")"
        << (gpu_tested ? " [CUDA verified]" : " [CUDA skipped]");
    res.summary = sum.str();

    det << "Two isolated 3x3x3 Hex8 steel blocks (27 elems each, dx=0.05 m, 0.15 m cube, Fixed Base, top vz=-150 m/s, 160 steps at CFL=0.5). "
        << "Mat 0 has enable_strain_erosion=true (erosion_strain=0.015) + enable_timestep_erosion=true (factor=0.10); "
        << "Mat 1 has all enable_*_erosion=false while experiencing ep_bar > 0.015 without global erosion leakage.";
    res.details = det.str();
    return res;
}

// -----------------------------------------------------------------------------
// VV-FEM-CPL-09: High-Damage JC+MG + Strain/Timestep Erosion + Cohesive
// Splitting Timestep Non-Collapse Audit (CPU + CUDA)
// Verifies severely damaged/crushed elements erode instead of trapping dt near
// zero when enable_cohesive_splitting=true, and min dt remains bounded by
// 0.99 * cfl * eta * min_dt0 across the entire impact history.
// -----------------------------------------------------------------------------
BenchmarkResult run_jc_mg_high_damage_erosion_noncollapse_test() {
    BenchmarkResult res;
    res.id = "VV-FEM-CPL-09";
    res.title = "High-Damage JC+MG + Strain/Timestep Erosion & Cohesive Splitting dt Non-Collapse (CPU + CUDA)";
    res.level = 3;
    res.pending = false;
    res.tolerance_l2 = 0.01;
    res.tolerance_linf = 0.01;

    constexpr float cfl = 0.5f;
    constexpr float eta = 0.10f;
    constexpr int nsteps = 250;

    MaterialTable3D mat = makeA36SteelJCMG();
    mat.enable_strain_erosion = true;
    mat.erosion_strain = 0.20f;
    mat.failure_strain = 0.20f;
    mat.enable_damage_erosion = true;
    mat.max_damage = 0.90f;
    mat.enable_timestep_erosion = true;
    mat.timestep_erosion_factor = eta;
    mat.min_volume_ratio = 0.02f;
    mat.max_volume_ratio = 5.00f;
    mat.synchronizePillars();

    auto configure_heavy_crush = [&](FEMSolver3D<float>& solver) {
        FEMErosionCriteria<float> no_global{};
        solver.setErosionCriteria(no_global);
        solver.getPhysicsParams().enable_cohesive_splitting = true;
        solver.setHourglassModel(FEMHourglassModel::FlanaganBelytschkoStiffness);
        solver.setHourglassCoeff(0.05f);
        solver.createStructuredBoxMesh(4, 4, 4, 0.20f, 0.20f, 0.20f, 0.0f, 0.0f, 0.0f, mat, "Fixed Base");
        for (auto& n : solver.getNodes()) {
            if (n.x0[2] > 0.195f) {
                n.v[2] = -500.0f;
            }
        }
    };

    auto compute_min_dt0 = [](const FEMSolver3D<float>& solver) {
        double min_dt0 = 1.0e30;
        for (const auto& el : solver.getElements()) {
            if (el.dt0 > 0.0f) {
                min_dt0 = std::min(min_dt0, static_cast<double>(el.dt0));
            }
        }
        return min_dt0;
    };

    // CPU Execution
    FEMSolver3D<float> fem_cpu;
    configure_heavy_crush(fem_cpu);
    const double cpu_min_dt0 = compute_min_dt0(fem_cpu);
    const double dt_floor = 0.99 * static_cast<double>(cfl) * static_cast<double>(eta) * cpu_min_dt0;
    double cpu_min_dt = 1.0e30;
    std::vector<double> cpu_dt_hist;
    cpu_dt_hist.reserve(nsteps);
    bool cpu_dt_finite = true;
    for (int s = 0; s < nsteps; ++s) {
        fem_cpu.step(cfl);
        double dt_s = static_cast<double>(fem_cpu.getLastDt());
        if (!std::isfinite(dt_s) || dt_s <= 0.0) cpu_dt_finite = false;
        cpu_min_dt = std::min(cpu_min_dt, dt_s);
        cpu_dt_hist.push_back(dt_s);
    }
    const auto cpu_st = collectFEMStats(fem_cpu);

    // CUDA Execution
    bool gpu_tested = false;
    double gpu_min_dt0 = cpu_min_dt0;
    double gpu_min_dt = cpu_min_dt;
    bool gpu_dt_finite = true;
    std::vector<double> gpu_dt_hist;
    JCMGCaseStats<float> gpu_st = cpu_st;
    if (hasCudaDeviceAvailable()) {
        gpu_tested = true;
        FEMSolver3DCUDA<float> fem_gpu;
        configure_heavy_crush(fem_gpu.getCpuSolver());
        gpu_min_dt0 = compute_min_dt0(fem_gpu.getCpuSolver());
        fem_gpu.syncToDevice();
        gpu_min_dt = 1.0e30;
        gpu_dt_hist.reserve(nsteps);
        for (int s = 0; s < nsteps; ++s) {
            fem_gpu.step(cfl);
            double dt_s = static_cast<double>(fem_gpu.getLastDt());
            if (!std::isfinite(dt_s) || dt_s <= 0.0) gpu_dt_finite = false;
            gpu_min_dt = std::min(gpu_min_dt, dt_s);
            gpu_dt_hist.push_back(dt_s);
        }
        fem_gpu.syncToHost();
        gpu_st = collectFEMStats(fem_gpu.getCpuSolver());
    }

    const double gpu_floor = 0.99 * static_cast<double>(cfl) * static_cast<double>(eta) * gpu_min_dt0;
    const bool cpu_ok = cpu_st.finite && cpu_dt_finite && (cpu_st.detached > 0) && (cpu_st.num_nodes > 125) && (cpu_st.max_dmg > 0.5) && (cpu_min_dt >= dt_floor);
    const bool gpu_ok = !gpu_tested || (gpu_st.finite && gpu_dt_finite && (gpu_st.detached > 0) && (gpu_st.num_nodes > 125) && (gpu_st.max_dmg > 0.5) && (gpu_min_dt >= gpu_floor));
    res.passed = cpu_ok && gpu_ok;

    const double cpu_ratio = cpu_min_dt / std::max(1.0e-30, dt_floor);
    const double gpu_ratio = gpu_min_dt / std::max(1.0e-30, gpu_floor);
    res.error_l2 = (cpu_ok && gpu_ok) ? 0.0 : std::max(0.0, 1.0 - std::min(cpu_ratio, gpu_ratio));
    res.error_linf = res.error_l2;

    std::vector<double> xs(nsteps), refs(nsteps), nums(nsteps);
    for (int s = 0; s < nsteps; ++s) {
        xs[s] = static_cast<double>(s + 1);
        refs[s] = gpu_floor / std::max(1.0e-30, gpu_min_dt0);
        double d_plot = gpu_tested ? gpu_dt_hist[s] : cpu_dt_hist[s];
        nums[s] = d_plot / std::max(1.0e-30, gpu_tested ? gpu_min_dt0 : cpu_min_dt0);
    }
    std::string svg_file = "vv_fem_cpl_09_jc_mg_dt_noncollapse.svg";
    generate_svg_plot(
        svg_file,
        "VV-FEM-CPL-09: Normalized Timestep History (dt / dt0) Under High Damage + Cohesive Splitting",
        "Step Index",
        "Normalized dt (dt / min_dt0)",
        xs, refs, nums, 1.0, static_cast<double>(nsteps)
    );
    res.svg_path = svg_file;

    std::ostringstream sum, det;
    sum << std::scientific
        << "cpu_min_dt=" << cpu_min_dt << " s (floor=" << dt_floor << " s, detached=" << cpu_st.detached << "/64, nodes=" << cpu_st.num_nodes << ", eroded=" << cpu_st.eroded << "/64, max_dmg=" << std::fixed << std::setprecision(3) << cpu_st.max_dmg << ")"
        << std::scientific
        << ", gpu_min_dt=" << gpu_min_dt << " s (floor=" << gpu_floor << " s, detached=" << gpu_st.detached << "/64, nodes=" << gpu_st.num_nodes << ", eroded=" << gpu_st.eroded << "/64, max_dmg=" << std::fixed << std::setprecision(3) << gpu_st.max_dmg << ")"
        << (gpu_tested ? " [CUDA verified]" : " [CUDA skipped]");
    res.summary = sum.str();

    det << "4x4x4 Hex8 (64 elems, dx=0.05 m, 0.20 m A36 steel JC+MG block, Fixed Base, top vz=-500 m/s, 250 steps at CFL=0.5) "
        << "with enable_strain_erosion=true (0.20), enable_damage_erosion=true (0.90), enable_timestep_erosion=true (factor=0.10), "
        << "min_volume_ratio=0.02, and enable_cohesive_splitting=true on both CPU and CUDA.";
    res.details = det.str();
    return res;
}

} // namespace

std::vector<BenchmarkResult> run_fem_coupling_fixes_benchmarks() {
    std::vector<BenchmarkResult> results;
    results.push_back(run_mpm_projectile_fem_impact_test());
    results.push_back(run_detonation_gas_fem_wall_test());
    results.push_back(run_tet4_anp_and_kf_stability_test());
    results.push_back(run_per_part_material_isolation_test());
    results.push_back(run_hypoelastic_detonator_no_burn_test());
    results.push_back(run_per_element_sri_bbar_test());
    results.push_back(run_jc_mg_phase_stability_test());
    results.push_back(run_per_object_erosion_isolation_cpu_gpu_test());
    results.push_back(run_jc_mg_high_damage_erosion_noncollapse_test());
    return results;
}

} // namespace Blast::VV
