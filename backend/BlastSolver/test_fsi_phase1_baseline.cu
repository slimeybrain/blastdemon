// =====================================================================================
// test_fsi_phase1_baseline.cu
//
// Phase 1 V&V Baseline Suite (Genuine 3D CUDA Production Solvers, Zero Coupler Changes):
//   V1 : Moving MPM Piston (u_p = 300 m/s) into Quiescent Air vs Exact Rankine-Hugoniot
//   V3 : Supersonic MPM Sphere (M = 2.20) in Air vs Rayleigh-Pitot / Billig Stand-off
//   V4 : HE Detonation (MPM-JWL No-Erode vs MPM-JWL Erode vs FV-JWL) + V4b Failed Fragments
//   V5 : MPM-JWL Products Erosion Handoff Conservation in Sealed 3D Box
//
// Every test executes the production MPMSolver3DCUDA + CFDSolver3DCuda pipeline,
// logs full mesh/particle discretization provenance, conducts +/-5-cell pointwise audits
// (Directive 20), and reports honest quantitative PASS/FAIL status (Directive 17).
// =====================================================================================
#include "cfd_solver_3d_cuda.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include "materials.hpp"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <memory>
#include <vector>
#include <cuda_runtime.h>

using namespace Blast;

namespace {

struct MpmBudget {
    double mass = 0.0, px = 0.0, py = 0.0, pz = 0.0, ke = 0.0, e_int = 0.0, e_chem = 0.0, vol = 0.0;
    double mean_rho = 0.0, max_lambda = 0.0;
    size_t active = 0;
};

MpmBudget read_mpm_budget(MPMSolver3DCUDA& mpm, double e_det_per_kg = 0.0) {
    mpm.syncParticlesToHost();
    MpmBudget b;
    for (const auto& p : mpm.getParticles()) {
        if (p.m <= 0.0f || p.state == 2) continue;
        const double m = p.m;
        b.mass += m;
        b.px += m * p.v[0];
        b.py += m * p.v[1];
        b.pz += m * p.v[2];
        b.ke += 0.5 * m * (double(p.v[0])*p.v[0] + double(p.v[1])*p.v[1] + double(p.v[2])*p.v[2]);
        b.e_int += m * p.e_int;
        b.e_chem += std::max(0.0, 1.0 - double(p.lambda)) * m * e_det_per_kg;
        b.vol += p.V;
        b.max_lambda = std::max(b.max_lambda, double(p.lambda));
        ++b.active;
    }
    if (b.vol > 1.0e-30) b.mean_rho = b.mass / b.vol;
    return b;
}

MultiMat::MaterialSet make_tnt_no_afterburn() {
    MultiMat::MaterialSet m = MultiMat::TNT;
    m.afterburn.enabled = false;
    MultiMat::initializePrecalculatedTerms(m);
    return m;
}

MaterialTable3D make_mpm_tnt_material(double cell_dx, bool enable_erosion, float rho_thresh) {
    MaterialTable3D mat{};
    mat.material_model = MPMMaterialModel::JWLProgrammedBurn;
    mat.density = 1630.0f;
    mat.jwl_A = 373.77e9f;
    mat.jwl_B = 3.747e9f;
    mat.jwl_R1 = 4.15f;
    mat.jwl_R2 = 0.90f;
    mat.jwl_omega = 0.35f;
    mat.det_vel = 6930.0f;
    mat.detonation_energy = 4.29e6f;
    mat.burn_zone_cells = 4;
    mat.cell_dx = static_cast<float>(cell_dx);
    mat.enable_density_erosion = enable_erosion;
    mat.erosion_min_density = rho_thresh;
    mat.erosion_min_density_ratio = 0.0f;
    mat.erode_to_fv_grid = enable_erosion;
    return mat;
}

void add_mpm_tnt_sphere(MPMSolver3DCUDA& mpm, int obj_id, float cx, float cy, float cz, float radius,
                        float cell_dx, bool enable_erosion, float rho_thresh) {
    mpm.addSphereObject(obj_id, cx, cy, cz, radius,
                        0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                        1630.0f, 1.0e9f, 0.30f, 1.0e9f, 0.0f, 1.0f, 1.0e9f, 8);
    MaterialTable3D mat = make_mpm_tnt_material(cell_dx, enable_erosion, rho_thresh);
    mpm.setMaterialTable(obj_id, mat);
    for (auto& p : mpm.getParticles()) {
        if (p.object_id == obj_id) {
            p.t_arrival = 1.0e10f;
            p.lambda = 0.0f;
            p.e_int = 0.0f;
        }
    }
    mpm.addDetonator(cx, cy, cz, 0.0f, 0.0f, false, obj_id);
    mpm.syncToDevice();
}

// -------------------------------------------------------------------------------------
// V1: Moving MPM Piston (u_p = 300 m/s) in 1D-channel 3D box vs Exact Rankine-Hugoniot
// -------------------------------------------------------------------------------------
int run_V1_piston(double u_p_arg = 300.0, double t_end_arg = 7.0e-4) {
    const int nx = 96, ny = 24, nz = 24;
    const double h = 0.01;
    const double rho0 = 1.225, p0 = 101325.0, gamma = 1.4;
    const double u_p = u_p_arg;
    const double c0 = std::sqrt(gamma * p0 / rho0);
    const double b_rh = 0.25 * (gamma + 1.0) * (u_p / c0);
    const double Ms_ex = b_rh + std::sqrt(b_rh * b_rh + 1.0);
    const double Ws_ex = Ms_ex * c0;
    const double p2_ex = p0 * (1.0 + (2.0 * gamma / (gamma + 1.0)) * (Ms_ex * Ms_ex - 1.0));
    const double rho2_ex = rho0 * (((gamma + 1.0) * Ms_ex * Ms_ex) / ((gamma - 1.0) * Ms_ex * Ms_ex + 2.0));
    const double T2_ex_ratio = (p2_ex / p0) / (rho2_ex / rho0);

    std::printf("\n================================================================================\n");
    std::printf("V1: Moving MPM Piston (u_p = %.1f m/s) into Quiescent Air vs Rankine-Hugoniot\n", u_p);
    std::printf("  Discretization: %d x %d x %d, dx = %.4f m, FP64 ideal gas, ADER-2/AUSM+\n", nx, ny, nz, h);
    std::printf("  Exact R-H: Ms=%.4f, Ws=%.2f m/s, p2/p0=%.4f (%.2f kPa), rho2/rho0=%.4f, T2/T0=%.4f\n",
                Ms_ex, Ws_ex, p2_ex / p0, p2_ex * 1e-3, rho2_ex / rho0, T2_ex_ratio);
    std::printf("================================================================================\n");

    auto cfd = std::make_unique<CFDSolver3DCuda<double, false>>(nx, ny, nz, h, 0.0, 0.0, 0.0);
    cfd->setFluxScheme("AUSM+");
    cfd->setSpatialOrder(2);
    cfd->setTemporalOrder(2);
    cfd->setBoundaryConditions(BCType3D::TRANSMISSIVE, BCType3D::TRANSMISSIVE,
                               BCType3D::REFLECTIVE, BCType3D::REFLECTIVE,
                               BCType3D::REFLECTIVE, BCType3D::REFLECTIVE);
    Charge3DParams ch; ch.radius = 0.0;
    MultiMat::MaterialSet mats;
    cfd->setInitialCondition(ch, mats, rho0, p0);

    auto mpm = std::make_unique<MPMSolver3DCUDA>();
    mpm->initializeGrid(nx, ny, nz, float(h), float(h), float(h));
    mpm->setTransferScheme(MPMTransferScheme::BSpline);
    mpm->setVelocityScheme(MPMVelocityScheme::APIC);
    mpm->setBoundaryConditions(MPMBoundaryCondition3D::Transmitting, MPMBoundaryCondition3D::Transmitting,
                               MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                               MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip);
    // Piston spans full y/z cross-section, x in [0.10, 0.22] -> x_face0 = 0.22 m
    mpm->addBoxObject(1, 0.16f, float(ny * h * 0.5), float(nz * h * 0.5),
                      0.12f, float(ny * h), float(nz * h),
                      float(u_p), 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                      7850.0f, 200.0e9f, 0.30f, 1.0e12f, 0.0f, 10.0f, 1.0e12f, 8);
    mpm->syncToDevice();

    const MpmBudget m0 = read_mpm_budget(*mpm);
    std::printf("  MPM piston Np = %zu, mass = %.3f kg\n", m0.active, m0.mass);

    mpm->particleToGridDeviceOnly();
    cfd->coupleFSIWithMPMGPU(mpm.get());
    cudaDeviceSynchronize();
    const CFDFluidLedger3D L_init = cfd->getFluidLedger();

    const double t_end = t_end_arg; // shock at 0.22 + 565*7e-4 = 0.616 m; piston front at 0.43 m
    const float cfl = 0.4f;
    double t = 0.0, last_dt = 0.0;
    int step = 0;
    while (t < t_end) {
        mpm->particleToGridDeviceOnly();
        cfd->coupleFSIWithMPMGPU(mpm.get());
        double dt = std::min<double>(mpm->computeStepSize(cfl), cfd->computeStepSize(cfl));
        dt = (step == 0) ? 0.5 * dt : (last_dt > 0.0 ? std::min(dt, 1.5 * last_dt) : dt);
        if (t + dt > t_end) dt = t_end - t;
        last_dt = dt;
        mpm->stepWithDt(float(dt), false);
        cfd->step(dt);
        t += dt;
        ++step;
    }
    cudaDeviceSynchronize();
    const CFDFluidLedger3D L_end = cfd->getFluidLedger();

    std::vector<uint8_t> sf; std::vector<double> rf;
    cfd->downloadFluidDiagnostics(sf, rf);
    const int jc = ny / 2, kc = nz / 2;
    auto s_at = [&](int i) { return sf[size_t(i) + size_t(jc) * nx + size_t(kc) * nx * ny]; };

    int i_rear = -1, i_front = -1;
    for (int i = 0; i < nx; ++i) {
        if (i_rear < 0 && s_at(i)) i_rear = i;
        else if (i_rear >= 0 && i_front < 0 && !s_at(i)) { i_front = i; break; }
    }

    const double x_shock_ex = 0.22 + Ws_ex * t;
    // Measure shock location from half-pressure jump in fluid ahead of piston
    double x_shock_num = 0.0;
    for (int i = std::max(0, i_front); i < nx - 1; ++i) {
        float u1, v1, w1, r1, p1, u2, v2, w2, r2, p2;
        cfd->getFluidVelocity(i, jc, kc, u1, v1, w1, r1, p1);
        cfd->getFluidVelocity(i + 1, jc, kc, u2, v2, w2, r2, p2);
        double p_mid = 0.5 * (p0 + p2_ex);
        if (p1 >= p_mid && p2 <= p_mid) {
            double frac = (p1 - p_mid) / std::max(1.0, double(p1 - p2));
            x_shock_num = (i + 0.5 + frac) * h;
            break;
        }
    }

    // Evaluate post-shock plateau L2/Linf between [i_front + 3, i_shock - 3]
    int i_shock_cell = static_cast<int>(std::floor(x_shock_ex / h));
    std::vector<double> p_num, p_ex, r_num, r_ex, u_num, u_ex;
    for (int i = i_front + 3; i <= i_shock_cell - 3 && i < nx; ++i) {
        float u, v, w, rho, p;
        cfd->getFluidVelocity(i, jc, kc, u, v, w, rho, p);
        p_num.push_back(p); p_ex.push_back(p2_ex);
        r_num.push_back(rho); r_ex.push_back(rho2_ex);
        u_num.push_back(u); u_ex.push_back(u_p);
    }
    auto rel_l2 = [](const std::vector<double>& a, const std::vector<double>& b) {
        if (a.empty()) return 1.0;
        double s1 = 0, s2 = 0;
        for (size_t i = 0; i < a.size(); ++i) { double d = a[i] - b[i]; s1 += d*d; s2 += b[i]*b[i]; }
        return std::sqrt(s1 / std::max(1e-30, s2));
    };
    const double err_p = rel_l2(p_num, p_ex);
    const double err_r = rel_l2(r_num, r_ex);
    const double err_u = rel_l2(u_num, u_ex);
    const double err_xs = std::fabs(x_shock_num - x_shock_ex) / std::max(1e-9, x_shock_ex - 0.22);

    std::printf("  Steps = %d, t = %.4f ms, dt_last = %.1f ns\n", step, t * 1e3, last_dt * 1e9);
    std::printf("  Piston solid cells i=[%d..%d], fluid_mass_drift = %+.3e x M0\n",
                i_rear, i_front - 1, (L_end.mass - L_init.mass) / L_init.mass);
    std::printf("  Shock pos: num=%.4f m vs exact=%.4f m (travel error = %.2f%%)\n",
                x_shock_num, x_shock_ex, err_xs * 100.0);
    std::printf("  Plateau L2 error (i=%d..%d, %zu cells): p=%.3f%%, rho=%.3f%%, ux=%.3f%%\n",
                i_front + 3, i_shock_cell - 3, p_num.size(), err_p * 100.0, err_r * 100.0, err_u * 100.0);

    std::printf("  --- Point-wise centerline profile (trailing wake + leading shock plateau) ---\n");
    std::printf("  Trailing face (i=%d..%d): [i: rho/r0, p/p0, T/T0, ux]\n", std::max(0, i_rear - 5), i_rear - 1);
    for (int i = std::max(0, i_rear - 5); i < i_rear; ++i) {
        float u, v, w, rho, p; cfd->getFluidVelocity(i, jc, kc, u, v, w, rho, p);
        double rr = rho / rho0, pp = p / p0;
        std::printf("    i=%2d: rho=%.3f  p=%.3f  T=%.3f  ux=%+.1f\n", i, rr, pp, pp / rr, u);
    }
    std::printf("  Leading face (i=%d..%d): [i: rho/r0, p/p0, T/T0, ux]\n", i_front, std::min(nx - 1, i_shock_cell + 5));
    for (int i = i_front; i <= std::min(nx - 1, i_shock_cell + 5); ++i) {
        float u, v, w, rho, p; cfd->getFluidVelocity(i, jc, kc, u, v, w, rho, p);
        double rr = rho / rho0, pp = p / p0;
        std::printf("    i=%2d: rho=%.3f  p=%.3f  T=%.3f  ux=%+.1f\n", i, rr, pp, pp / rr, u);
    }

    const bool ok = (err_p <= 0.05) && (err_r <= 0.05) && (err_u <= 0.05) && (err_xs <= 0.05);
    std::printf("  STATUS V1 (5%% plateau/shock tol): %s\n", ok ? "PASS" : "FAIL");
    return ok ? 0 : 1;
}

// -------------------------------------------------------------------------------------
// V3: Supersonic MPM Sphere (M = 2.20, v_x = 750 m/s) through Quiescent Air
// -------------------------------------------------------------------------------------
int run_V3_supersonic_sphere(bool stationary_wind = false, int fine = 1) {
    const int nx = 96 * fine, ny = 48 * fine, nz = 48 * fine;
    const double h = 0.01 / fine;
    const double rho0 = 1.225, p0 = 101325.0, gamma = 1.4;
    const double c0 = std::sqrt(gamma * p0 / rho0);
    const double v_sph = 750.0; // M = 2.204
    const double u_sph = stationary_wind ? 0.0 : v_sph;
    const double u_wind = stationary_wind ? -v_sph : 0.0;
    const double M_inf = v_sph / c0;
    const double R = 0.06;
    // Rayleigh-Pitot formula for stagnation pressure behind normal shock at M_inf
    const double p2_p0 = 1.0 + (2.0 * gamma / (gamma + 1.0)) * (M_inf * M_inf - 1.0);
    const double p02_p0 = std::pow(((gamma + 1.0) * M_inf * M_inf) / 2.0, gamma / (gamma - 1.0)) *
                          std::pow((gamma + 1.0) / (2.0 * gamma * M_inf * M_inf - (gamma - 1.0)), 1.0 / (gamma - 1.0));
    const double billig_delta_R = 0.143 * std::exp(3.24 / (M_inf * M_inf));

    std::printf("\n================================================================================\n");
    std::printf("V3%s: Supersonic MPM Sphere (R = %.3f m, V_rel = %.1f m/s, M = %.2f)\n",
                stationary_wind ? " [STATIONARY WIND]" : "", R, v_sph, M_inf);
    std::printf("  Discretization: %d x %d x %d, dx = %.4f m, FP64 ideal gas, ADER-2/AUSM+\n", nx, ny, nz, h);
    std::printf("  Refs: Rayleigh-Pitot p02/p0=%.3f, normal p2/p0=%.3f, Billig stand-off delta/R=%.3f (%.2f cm)\n",
                p02_p0, p2_p0, billig_delta_R, billig_delta_R * R * 100.0);
    std::printf("================================================================================\n");

    auto cfd = std::make_unique<CFDSolver3DCuda<double, false>>(nx, ny, nz, h, 0.0, 0.0, 0.0);
    cfd->setFluxScheme("AUSM+");
    cfd->setSpatialOrder(2);
    cfd->setTemporalOrder(2);
    cfd->setBoundaryConditions(BCType3D::TRANSMISSIVE, BCType3D::TRANSMISSIVE,
                               BCType3D::TRANSMISSIVE, BCType3D::TRANSMISSIVE,
                               BCType3D::TRANSMISSIVE, BCType3D::TRANSMISSIVE);
    Charge3DParams ch; ch.radius = 0.0;
    MultiMat::MaterialSet mats;
    cfd->setInitialCondition(ch, mats, rho0, p0);
    if (stationary_wind) {
        CellState3D<false> s{};
        s.rho = rho0;
        s.ux = u_wind;
        s.uy = 0.0;
        s.uz = 0.0;
        s.p = p0;
        s.E = p0 / (gamma - 1.0) + 0.5 * rho0 * u_wind * u_wind;
        for (int k = 0; k < nz; ++k)
            for (int j = 0; j < ny; ++j)
                for (int i = 0; i < nx; ++i)
                    cfd->setCellStateIdeal(i, j, k, s);
        cfd->commitStates();
    }

    auto mpm = std::make_unique<MPMSolver3DCUDA>();
    mpm->initializeGrid(nx, ny, nz, float(h), float(h), float(h));
    mpm->setTransferScheme(MPMTransferScheme::BSpline);
    mpm->setVelocityScheme(MPMVelocityScheme::APIC);
    mpm->setBoundaryConditions(MPMBoundaryCondition3D::Transmitting, MPMBoundaryCondition3D::Transmitting,
                               MPMBoundaryCondition3D::Transmitting, MPMBoundaryCondition3D::Transmitting,
                               MPMBoundaryCondition3D::Transmitting, MPMBoundaryCondition3D::Transmitting);
    const float cx0 = 0.54f - float(u_sph * 4.0e-4), cy0 = 0.24f, cz0 = 0.24f;
    mpm->addSphereObject(1, cx0, cy0, cz0, float(R),
                         float(u_sph), 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                         7850.0f, 200.0e9f, 0.30f, 1.0e12f, 0.0f, 10.0f, 1.0e12f, 8);
    mpm->syncToDevice();

    const MpmBudget m0 = read_mpm_budget(*mpm);
    mpm->particleToGridDeviceOnly();
    cfd->coupleFSIWithMPMGPU(mpm.get());
    cudaDeviceSynchronize();
    const CFDFluidLedger3D L0 = cfd->getFluidLedger();

    const double t_end = 4.0e-4; // travels 0.30 m -> cx_end = 0.54 m
    const float cfl = 0.4f;
    double t = 0.0, last_dt = 0.0, t_late = 0.0, px_late = m0.px;
    bool got_late = false;
    int step = 0;
    while (t < t_end) {
        mpm->particleToGridDeviceOnly();
        cfd->coupleFSIWithMPMGPU(mpm.get());
        double dt = std::min<double>(mpm->computeStepSize(cfl), cfd->computeStepSize(cfl));
        dt = (step == 0) ? 0.5 * dt : (last_dt > 0.0 ? std::min(dt, 1.5 * last_dt) : dt);
        if (t + dt > t_end) dt = t_end - t;
        last_dt = dt;
        mpm->stepWithDt(float(dt), false);
        cfd->step(dt);
        t += dt;
        ++step;
        if (!got_late && t >= 0.30e-3) {
            got_late = true;
            t_late = t;
            px_late = read_mpm_budget(*mpm).px;
        }
    }
    cudaDeviceSynchronize();

    const MpmBudget m1 = read_mpm_budget(*mpm);
    const CFDFluidLedger3D L1 = cfd->getFluidLedger();

    // Compute coupled momentum conservation and drag coefficient
    const double dpx = (L1.momentum[0] - L0.momentum[0]) + (m1.px - m0.px);
    const double dpy = (L1.momentum[1] - L0.momentum[1]) + (m1.py - m0.py);
    const double dpz = (L1.momentum[2] - L0.momentum[2]) + (m1.pz - m0.pz);
    const double mom_ref = std::max(1e-12, stationary_wind ? (m0.mass * v_sph) : std::fabs(m0.px));
    const double mom_drift = std::sqrt(dpx*dpx + dpy*dpy + dpz*dpz) / mom_ref;
    const double drag_force_avg = -(m1.px - m0.px) / t;
    const double q_dyn = 0.5 * rho0 * v_sph * v_sph * 3.14159265358979 * R * R;
    const double Cd_meas = drag_force_avg / q_dyn;
    const double Cd_inst = (got_late && t > t_late) ? (-(m1.px - px_late) / (t - t_late)) / q_dyn : Cd_meas;

    std::vector<uint8_t> sf; std::vector<double> rf;
    cfd->downloadFluidDiagnostics(sf, rf);
    const int jc = ny / 2, kc = nz / 2;
    auto s_at = [&](int i) { return sf[size_t(i) + size_t(jc) * nx + size_t(kc) * nx * ny]; };
    int i_rear = -1, i_last_s = -1;
    for (int i = 0; i < nx; ++i) {
        if (s_at(i)) {
            if (i_rear < 0) i_rear = i;
            i_last_s = i;
        }
    }
    int i_front = (i_last_s >= 0 && i_last_s + 1 < nx) ? (i_last_s + 1) : -1;

    double p_stag_num = 0.0;
    double x_shock_num = 0.0;
    const double p_mid = 0.5 * (p0 + p2_p0 * p0);
    for (int i = i_front; i < nx - 1; ++i) {
        float u, v, w, rho, p; cfd->getFluidVelocity(i, jc, kc, u, v, w, rho, p);
        p_stag_num = std::max(p_stag_num, double(p));
        float u2, v2, w2, r2, p2; cfd->getFluidVelocity(i + 1, jc, kc, u2, v2, w2, r2, p2);
        if (x_shock_num == 0.0 && p >= p_mid && p2 <= p_mid) {
            x_shock_num = (i + 0.5 + (p - p_mid) / std::max(1.0, double(p - p2))) * h;
        }
    }
    const double x_nose_exact = cx0 + (u_sph * t) + R;
    const double delta_num = x_shock_num - x_nose_exact;

    std::printf("  Steps = %d, t = %.4f ms, Np = %zu\n", step, t * 1e3, m0.active);
    std::printf("  Stagnation p_max/p0 = %.3f (Rayleigh-Pitot=%.3f, rel err=%.1f%%)\n",
                p_stag_num / p0, p02_p0, 100.0 * std::fabs(p_stag_num / p0 - p02_p0) / p02_p0);
    std::printf("  Shock stand-off delta/R = %.3f (Billig=%.3f), Cd_avg = %.3f, Cd_inst[0.3-0.4ms] = %.3f (ref ~0.95)\n",
                delta_num / R, billig_delta_R, Cd_meas, Cd_inst);
    std::printf("  Coupled momentum drift |dP|/|P_mpm0| = %.3e, fluid mass drift = %+.3e x M0\n",
                mom_drift, (L1.mass - L0.mass) / L0.mass);

    std::printf("  Centerline wake (i=%d..%d): [i: rho/r0, p/p0, T/T0, ux]\n", std::max(0, i_rear - 5), i_rear - 1);
    for (int i = std::max(0, i_rear - 5); i < i_rear; ++i) {
        float u, v, w, rho, p; cfd->getFluidVelocity(i, jc, kc, u, v, w, rho, p);
        double rr = rho / rho0, pp = p / p0;
        std::printf("    i=%2d: rho=%.3f  p=%.3f  T=%.3f  ux=%+.1f\n", i, rr, pp, pp / rr, u);
    }
    std::printf("  Centerline bow (i=%d..%d): [i: s af rho/r0, p/p0, T/T0, ux, uy]\n", i_front - 1, std::min(nx - 1, i_front + 6 * fine));
    for (int jj = jc; jj <= jc + 4 * fine; jj += fine) {
        std::printf("   -- j=%d (y=%.3f) --\n", jj, (jj + 0.5) * h);
        for (int i = std::max(0, i_front - 2 * fine); i <= std::min(nx - 1, i_front + 6 * fine); ++i) {
            float u, v, w, rho, p; cfd->getFluidVelocity(i, jj, kc, u, v, w, rho, p);
            double af = (rho > 1e-6f) ? rf[size_t(i) + size_t(jj) * nx + size_t(kc) * nx * ny] / rho : 0.0;
            double rr = rho / rho0, pp = p / p0;
            std::printf("    i=%2d: af=%.3f rho=%.3f  p=%.3f  T=%.3f  ux=%+.1f uy=%+.1f\n", i, af, rr, pp, pp / rr, u, v);
        }
    }

    const bool ok = (std::fabs(p_stag_num / p0 - p02_p0) / p02_p0 <= 0.15) &&
                    (std::fabs(Cd_meas - 0.95) <= 0.30) && (mom_drift <= 1.0e-3);
    std::printf("  STATUS V3: %s\n", ok ? "PASS" : "FAIL");
    return ok ? 0 : 1;
}

// -------------------------------------------------------------------------------------
// V4: Expanding TNT Sphere: FV-JWL vs MPM-JWL (No Erosion) vs MPM-JWL (With Erosion)
// -------------------------------------------------------------------------------------
struct V4Metrics {
    double p_max[3] = {0, 0, 0};      // peak overpressure [Pa] at r = 2R, 3R, 4R
    double t_arr[3] = {-1, -1, -1};   // first time delta_p > 5 kPa [s]
    double first_erode_t = -1.0;
    int total_eroded = 0;
    double mean_rho_end = 0.0, max_lambda_end = 0.0;
};

V4Metrics run_v4_case(const char* label, bool use_mpm, bool enable_erosion) {
    const int n = 64;
    const double h = 0.01;
    const double rho0 = 1.225, p0 = 101325.0;
    const float R = 0.06f, c = 0.32f;
    MultiMat::MaterialSet tnt = make_tnt_no_afterburn();

    auto cfd = std::make_unique<CFDSolver3DCuda<double, true>>(n, n, n, h, 0.0, 0.0, 0.0);
    cfd->setFluxScheme("AUSM+");
    cfd->setSpatialOrder(2);
    cfd->setTemporalOrder(2);
    cfd->setBoundaryConditions(BCType3D::TRANSMISSIVE, BCType3D::TRANSMISSIVE,
                               BCType3D::TRANSMISSIVE, BCType3D::TRANSMISSIVE,
                               BCType3D::TRANSMISSIVE, BCType3D::TRANSMISSIVE);

    std::unique_ptr<MPMSolver3DCUDA> mpm;
    if (!use_mpm) {
        Charge3DParams ch; ch.shape_type = 0; ch.x = c; ch.y = c; ch.z = c; ch.radius = R;
        cfd->setDetonatorLocation(c, c, c, 0.0);
        cfd->setInitialCondition(ch, tnt, rho0, p0);
    } else {
        Charge3DParams ch; ch.radius = 0.0;
        cfd->setInitialCondition(ch, tnt, rho0, p0);
        mpm = std::make_unique<MPMSolver3DCUDA>();
        mpm->setDeferFVErosionToCoupler(true);
        mpm->initializeGrid(n, n, n, float(h), float(h), float(h));
        mpm->setTransferScheme(MPMTransferScheme::BSpline);
        mpm->setVelocityScheme(MPMVelocityScheme::APIC);
        mpm->setBoundaryConditions(MPMBoundaryCondition3D::Transmitting, MPMBoundaryCondition3D::Transmitting,
                                   MPMBoundaryCondition3D::Transmitting, MPMBoundaryCondition3D::Transmitting,
                                   MPMBoundaryCondition3D::Transmitting, MPMBoundaryCondition3D::Transmitting);
        add_mpm_tnt_sphere(*mpm, 1, c, c, c, R, float(h), enable_erosion, enable_erosion ? 50.0f : 0.0f);
    }

    // Gauges at r = 2R (0.12 m), 3R (0.18 m), 4R (0.24 m) along +x from center (0.32, 0.32, 0.32)
    const int gi[3] = {44, 50, 56};
    const int gj = 32, gk = 32;
    V4Metrics res;

    const double t_end = 2.0e-4;
    const float cfl = 0.4f;
    double t = 0.0, last_dt = 0.0;
    int step = 0;
    while (t < t_end) {
        if (mpm) {
            mpm->particleToGridDeviceOnly();
            cfd->coupleFSIWithMPMGPU(mpm.get());
        }
        double dt = cfd->computeStepSize(cfl);
        if (mpm) dt = std::min<double>(dt, mpm->computeStepSize(cfl));
        dt = (step == 0) ? 0.5 * dt : (last_dt > 0.0 ? std::min(dt, 1.5 * last_dt) : dt);
        if (t + dt > t_end) dt = t_end - t;
        last_dt = dt;

        if (mpm) {
            mpm->stepWithDt(float(dt), false);
            if (enable_erosion) {
                int er = cfd->erodeMPMParticlesToCFDGPU(mpm.get());
                if (er > 0 && res.first_erode_t < 0.0) res.first_erode_t = t + dt;
                res.total_eroded += er;
            }
        }
        cfd->step(dt);
        t += dt;
        ++step;

        for (int k = 0; k < 3; ++k) {
            float u, v, w, rho, p;
            cfd->getFluidVelocity(gi[k], gj, gk, u, v, w, rho, p);
            double dp = double(p) - p0;
            if (dp > res.p_max[k]) res.p_max[k] = dp;
            if (res.t_arr[k] < 0.0 && dp > 5000.0) res.t_arr[k] = t;
        }
    }
    cudaDeviceSynchronize();
    if (mpm) {
        MpmBudget mb = read_mpm_budget(*mpm);
        res.mean_rho_end = mb.mean_rho;
        res.max_lambda_end = mb.max_lambda;
    }

    std::printf("  %-18s | steps=%4d | eroded=%5d (first=%.2f us) | mpm_rho=%.1f lam=%.2f\n",
                label, step, res.total_eroded, res.first_erode_t > 0 ? res.first_erode_t * 1e6 : -1.0,
                res.mean_rho_end, res.max_lambda_end);
    std::printf("    2R: dp_max=%9.2f kPa (t_arr=%6.2f us) | 3R: %9.2f kPa (%6.2f us) | 4R: %9.2f kPa (%6.2f us)\n",
                res.p_max[0]*1e-3, res.t_arr[0]*1e6,
                res.p_max[1]*1e-3, res.t_arr[1]*1e6,
                res.p_max[2]*1e-3, res.t_arr[2]*1e6);
    return res;
}

int run_V4_he_and_fragments() {
    std::printf("\n================================================================================\n");
    std::printf("V4: Expanding TNT Sphere (R=0.06m, 64^3, dx=0.01m, FP64 multi-mat) FV vs MPM\n");
    std::printf("================================================================================\n");

    const V4Metrics m_fv = run_v4_case("V4-FV (baseline)", false, false);
    const V4Metrics m_mpm_no = run_v4_case("V4-MPM No-Erosion", true, false);
    const V4Metrics m_mpm_er = run_v4_case("V4-MPM Erode@50", true, true);

    const bool mpm_drives_before_erosion = (m_mpm_no.p_max[0] >= 0.25 * m_fv.p_max[0]) && (m_mpm_no.t_arr[0] > 0.0);
    std::printf("  Ratio MPM_NoErode / FV at r=2R: %.3f   |   MPM_Erode / FV at r=2R: %.3f\n",
                m_fv.p_max[0] > 0 ? m_mpm_no.p_max[0] / m_fv.p_max[0] : 0.0,
                m_fv.p_max[0] > 0 ? m_mpm_er.p_max[0] / m_fv.p_max[0] : 0.0);
    std::printf("  STATUS V4a (MPM JWL drives air shock before erosion): %s\n",
                mpm_drives_before_erosion ? "PASS" : "FAIL");

    return mpm_drives_before_erosion ? 0 : 1;
}

int run_V4b_fragments() {
    std::printf("\n--- V4b: 8 Failed Steel Fragments (has_failed=1, damage=1, vx=800 m/s) in 64x48x48 Air ---\n");
    const int nx = 64, ny = 48, nz = 48;
    const double h = 0.01, rho0 = 1.225, p0 = 101325.0;
    auto cfd = std::make_unique<CFDSolver3DCuda<double, false>>(nx, ny, nz, h, 0.0, 0.0, 0.0);
    cfd->setFluxScheme("AUSM+");
    cfd->setSpatialOrder(2);
    cfd->setTemporalOrder(2);
    cfd->setBoundaryConditions(BCType3D::TRANSMISSIVE, BCType3D::TRANSMISSIVE,
                               BCType3D::TRANSMISSIVE, BCType3D::TRANSMISSIVE,
                               BCType3D::TRANSMISSIVE, BCType3D::TRANSMISSIVE);
    Charge3DParams ch; ch.radius = 0.0; MultiMat::MaterialSet mats;
    cfd->setInitialCondition(ch, mats, rho0, p0);

    auto mpm = std::make_unique<MPMSolver3DCUDA>();
    mpm->initializeGrid(nx, ny, nz, float(h), float(h), float(h));
    mpm->setTransferScheme(MPMTransferScheme::BSpline);
    mpm->setVelocityScheme(MPMVelocityScheme::APIC);
    mpm->setBoundaryConditions(MPMBoundaryCondition3D::Transmitting, MPMBoundaryCondition3D::Transmitting,
                               MPMBoundaryCondition3D::Transmitting, MPMBoundaryCondition3D::Transmitting,
                               MPMBoundaryCondition3D::Transmitting, MPMBoundaryCondition3D::Transmitting);
    const float offsets[8][3] = {
        {0.18f, 0.21f, 0.21f}, {0.18f, 0.27f, 0.21f}, {0.18f, 0.21f, 0.27f}, {0.18f, 0.27f, 0.27f},
        {0.23f, 0.21f, 0.21f}, {0.23f, 0.27f, 0.21f}, {0.23f, 0.21f, 0.27f}, {0.23f, 0.27f, 0.27f}
    };
    for (int f = 0; f < 8; ++f) {
        mpm->addBoxObject(1, offsets[f][0], offsets[f][1], offsets[f][2], 0.02f, 0.02f, 0.02f,
                          800.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                          7850.0f, 200.0e9f, 0.30f, 400.0e6f, 1.0e9f, 0.25f, 600.0e6f, 8);
    }
    for (auto& p : mpm->getParticles()) {
        p.has_failed = true;
        p.damage = 1.0f;
    }
    mpm->syncToDevice();
    const MpmBudget mb0 = read_mpm_budget(*mpm);
    const CFDFluidLedger3D L0 = cfd->getFluidLedger();

    const double t_end = 2.0e-4;
    const float cfl = 0.4f;
    double t = 0.0, last_dt = 0.0;
    int step = 0;
    while (t < t_end) {
        mpm->particleToGridDeviceOnly();
        cfd->coupleFSIWithMPMGPU(mpm.get());
        double dt = std::min<double>(mpm->computeStepSize(cfl), cfd->computeStepSize(cfl));
        dt = (step == 0) ? 0.5 * dt : (last_dt > 0.0 ? std::min(dt, 1.5 * last_dt) : dt);
        if (t + dt > t_end) dt = t_end - t;
        last_dt = dt;
        mpm->stepWithDt(float(dt), false);
        cfd->step(dt);
        t += dt;
        ++step;
    }
    cudaDeviceSynchronize();
    const MpmBudget mb1 = read_mpm_budget(*mpm);
    const CFDFluidLedger3D L1 = cfd->getFluidLedger();
    auto pf = cfd->extractPressureField();
    double dp_max = 0.0;
    for (float pv : pf) dp_max = std::max(dp_max, double(pv) - p0);
    const double dpx_air = L1.momentum[0] - L0.momentum[0];
    const double dpx_mpm = mb1.px - mb0.px;
    const double mom_err = std::fabs(dpx_air + dpx_mpm) / std::max(1e-12, std::fabs(mb0.px));

    std::printf("  Np = %zu, steps = %d, max air overpressure = %.3f kPa (at M=2.35!)\n",
                mb0.active, step, dp_max * 1e-3);
    std::printf("  dP_air_x = %+.4e kg m/s, dP_mpm_x = %+.4e kg m/s, |dP_tot|/|P0| = %.3e\n",
                dpx_air, dpx_mpm, mom_err);
    const bool ok_4b = (dp_max > 50.0e3) && (mom_err <= 1.0e-3);
    std::printf("  STATUS V4b (failed fragments drive air & conserve momentum): %s\n", ok_4b ? "PASS" : "FAIL");
    return ok_4b ? 0 : 1;
}

// -------------------------------------------------------------------------------------
// V5: MPM-JWL Products Erosion Handoff Conservation in Sealed 48^3 Box
// -------------------------------------------------------------------------------------
int run_V5_erosion_conservation() {
    const int n = 48;
    const double h = 0.01;
    const double rho0 = 1.225, p0 = 101325.0;
    const float R = 0.05f, c = 0.24f;
    MultiMat::MaterialSet tnt = make_tnt_no_afterburn();

    std::printf("\n================================================================================\n");
    std::printf("V5: MPM-JWL Erosion Handoff Conservation (48^3 Sealed Box, dx=%.4f m, erode@120)\n", h);
    std::printf("================================================================================\n");

    auto cfd = std::make_unique<CFDSolver3DCuda<double, true>>(n, n, n, h, 0.0, 0.0, 0.0);
    cfd->setFluxScheme("AUSM+");
    cfd->setSpatialOrder(2);
    cfd->setTemporalOrder(2);
    cfd->setBoundaryConditions(BCType3D::REFLECTIVE, BCType3D::REFLECTIVE,
                               BCType3D::REFLECTIVE, BCType3D::REFLECTIVE,
                               BCType3D::REFLECTIVE, BCType3D::REFLECTIVE);
    Charge3DParams ch; ch.radius = 0.0;
    cfd->setInitialCondition(ch, tnt, rho0, p0);

    auto mpm = std::make_unique<MPMSolver3DCUDA>();
    mpm->setDeferFVErosionToCoupler(true);
    mpm->initializeGrid(n, n, n, float(h), float(h), float(h));
    mpm->setTransferScheme(MPMTransferScheme::BSpline);
    mpm->setVelocityScheme(MPMVelocityScheme::APIC);
    mpm->setBoundaryConditions(MPMBoundaryCondition3D::Reflecting, MPMBoundaryCondition3D::Reflecting,
                               MPMBoundaryCondition3D::Reflecting, MPMBoundaryCondition3D::Reflecting,
                               MPMBoundaryCondition3D::Reflecting, MPMBoundaryCondition3D::Reflecting);
    add_mpm_tnt_sphere(*mpm, 1, c, c, c, R, float(h), true, 120.0f);

    mpm->particleToGridDeviceOnly();
    cfd->coupleFSIWithMPMGPU(mpm.get());
    cudaDeviceSynchronize();

    const double e_det = 4.29e6;
    const MpmBudget mb0 = read_mpm_budget(*mpm, e_det);
    const CFDFluidLedger3D L0 = cfd->getFluidLedger();
    const double M_sys0 = L0.mass + mb0.mass;
    const double M_jwl0 = L0.jwl_mass + mb0.mass;
    const double E_sys0 = L0.energy + mb0.ke + mb0.e_int + mb0.e_chem;
    std::printf("  Initial: Np=%zu, M_mpm=%.5f kg, M_air=%.5f kg, M_sys0=%.5f kg, E_sys0=%.4e J (E_chem0=%.4e J)\n",
                mb0.active, mb0.mass, L0.mass, M_sys0, E_sys0, mb0.e_chem);

    const double t_end = 1.5e-4;
    const float cfl = 0.4f;
    double t = 0.0, last_dt = 0.0;
    int step = 0, total_eroded = 0;
    double max_dm_erode = 0.0, max_djwl_erode = 0.0, max_de_erode = 0.0;
    double max_post_erode_p_kpa = 0.0, max_center_p_kpa = 0.0, max_r2_p_kpa = 0.0;
    double dm_pre_erode = 0.0, de_pre_erode = 0.0, first_erode_t = -1.0;

    while (t < t_end) {
        mpm->particleToGridDeviceOnly();
        cfd->coupleFSIWithMPMGPU(mpm.get());
        double dt = std::min<double>(mpm->computeStepSize(cfl), cfd->computeStepSize(cfl));
        dt = (step == 0) ? 0.5 * dt : (last_dt > 0.0 ? std::min(dt, 1.5 * last_dt) : dt);
        if (t + dt > t_end) dt = t_end - t;
        last_dt = dt;
        mpm->stepWithDt(float(dt), false);

        const MpmBudget mb_pre = read_mpm_budget(*mpm, e_det);
        const CFDFluidLedger3D L_pre = cfd->getFluidLedger();
        const int er = cfd->erodeMPMParticlesToCFDGPU(mpm.get());
        if (er > 0) {
            if (first_erode_t < 0.0) {
                first_erode_t = t + dt;
                dm_pre_erode = ((L_pre.mass + mb_pre.mass) - M_sys0) / M_sys0;
                de_pre_erode = ((L_pre.energy + mb_pre.ke + mb_pre.e_int + mb_pre.e_chem) - E_sys0) / E_sys0;
            }
            total_eroded += er;
            const MpmBudget mb_post = read_mpm_budget(*mpm, e_det);
            const CFDFluidLedger3D L_post = cfd->getFluidLedger();
            const double dm = std::fabs((L_post.mass + mb_post.mass) - (L_pre.mass + mb_pre.mass)) / M_sys0;
            const double dj = std::fabs((L_post.jwl_mass + mb_post.mass) - (L_pre.jwl_mass + mb_pre.mass)) / M_jwl0;
            const double de = std::fabs((L_post.energy + mb_post.ke + mb_post.e_int + mb_post.e_chem) -
                                        (L_pre.energy + mb_pre.ke + mb_pre.e_int + mb_pre.e_chem)) / E_sys0;
            max_dm_erode = std::max(max_dm_erode, dm);
            max_djwl_erode = std::max(max_djwl_erode, dj);
            max_de_erode = std::max(max_de_erode, de);
            for (int ii = 18; ii <= 30; ++ii) {
                float u, v, w, r, p;
                cfd->getFluidVelocity(ii, 24, 24, u, v, w, r, p);
                max_post_erode_p_kpa = std::max(max_post_erode_p_kpa, double(p - p0) * 1e-3);
            }
        }

        cfd->step(dt);
        t += dt;
        ++step;

        float uc, vc, wc, rc, pc;
        cfd->getFluidVelocity(24, 24, 24, uc, vc, wc, rc, pc);
        max_center_p_kpa = std::max(max_center_p_kpa, double(pc - p0) * 1e-3);
        cfd->getFluidVelocity(34, 24, 24, uc, vc, wc, rc, pc); // r = 2R = 0.10 m
        max_r2_p_kpa = std::max(max_r2_p_kpa, double(pc - p0) * 1e-3);
    }
    cudaDeviceSynchronize();

    const MpmBudget mb1 = read_mpm_budget(*mpm, e_det);
    const CFDFluidLedger3D L1 = cfd->getFluidLedger();
    const double M_sys1 = L1.mass + mb1.mass;
    const double M_jwl1 = L1.jwl_mass + mb1.mass;
    const double E_sys1 = L1.energy + mb1.ke + mb1.e_int + mb1.e_chem;
    const double dM_tot = std::fabs(M_sys1 - M_sys0) / M_sys0;
    const double dJ_tot = std::fabs(M_jwl1 - M_jwl0) / M_jwl0;
    const double dE_tot = std::fabs(E_sys1 - E_sys0) / E_sys0;

    std::printf("  Steps = %d, eroded = %d / %zu (first=%.2f us, remaining MPM active = %zu)\n",
                step, total_eroded, mb0.active, first_erode_t > 0 ? first_erode_t * 1e6 : -1.0, mb1.active);
    std::printf("  Pre-erosion signed drift: dM_sys=%+.3e, dE_tot=%+.3e\n", dm_pre_erode, de_pre_erode);
    std::printf("  Peak overpressure: post_erode_band=%.2f kPa, center=%.2f kPa, 2R=%.2f kPa\n",
                max_post_erode_p_kpa, max_center_p_kpa, max_r2_p_kpa);
    std::printf("  Per-erosion max step drift: dM_sys=%.3e, dM_jwl=%.3e, dE_sys=%.3e\n",
                max_dm_erode, max_djwl_erode, max_de_erode);
    std::printf("  End-to-end sealed-box drift (incl chem): dM_sys=%.3e, dM_jwl=%.3e, dE_tot=%.3e (E_sys1=%.4e J)\n",
                dM_tot, dJ_tot, dE_tot, E_sys1);

    const bool ok = (total_eroded > 0) && (dM_tot <= 1.0e-5) && (dJ_tot <= 1.0e-5) && (dE_tot <= 1.0e-3);
    std::printf("  STATUS V5: %s\n", ok ? "PASS" : "FAIL");
    return ok ? 0 : 1;
}

} // namespace

int main(int argc, char** argv) {
    const std::string only = (argc > 1) ? std::string(argv[1]) : std::string("all");
    int rc = 0;
    if (only == "all" || only == "v1") rc |= run_V1_piston();
    if (only == "all" || only == "v3") rc |= run_V3_supersonic_sphere(false, 1);
    if (only == "v3stat") return run_V3_supersonic_sphere(true, 1);
    if (only == "v3fine") return run_V3_supersonic_sphere(false, 2);
    if (only == "v3stat_fine") return run_V3_supersonic_sphere(true, 2);
    if (only == "all" || only == "v4") { rc |= run_V4_he_and_fragments(); rc |= run_V4b_fragments(); }
    if (only == "v4_mpm") { run_v4_case("V4-MPM No-Erosion", true, false); return 0; }
    if (only == "v4_erode") { run_v4_case("V4-MPM Erode@50", true, true); return 0; }
    if (only == "v4b") return run_V4b_fragments();
    if (only == "all" || only == "v5") rc |= run_V5_erosion_conservation();
    std::printf("\nPhase 1 Overall Status: %s\n", rc == 0 ? "ALL PASSED" : "BASELINE DEFECTS DETECTED (see above)");
    return rc;
}
