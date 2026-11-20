// =====================================================================================
// test_fsi_gap_conservation.cu
//
// V2 baseline: conservation audit of the production 3D MPM-FV GPU FSI coupling sequence
// (MPMSolver3DCUDA + CFDSolver3DCuda<double,false>), exactly as sequenced in main.cpp:
//     P2G -> coupleFSIWithMPMGPU -> MPM step -> CFD step
//
// Scenario A  "gap closing":  two MPM slabs close a gap inside a REFLECTIVE sealed box.
//             Every air molecule stays in the box, so total fluid mass must be constant.
// Scenario B  "free flight":  one MPM block translates through quiescent air with
//             TRANSMISSIVE boundaries far enough away that no wave leaves the domain.
//             Fluid momentum + MPM momentum must then be constant.
//
// Fluid mass is attributed to two mechanisms using the fluid-only ledger (getFluidLedger):
//     transition leak = ledger(after coupleFSI) - ledger(before coupleFSI)  (cell covering / uncovering)
//     step leak       = ledger(after CFD step)  - ledger(after coupleFSI)   (FV update with fixed mask)
//
// This executable REPORTS the error budget. It fails (exit 1) only when a rigorous
// conservation tolerance is violated, and it prints that status honestly (Directive 17).
// =====================================================================================
#include "cfd_solver_3d_cuda.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <iostream>
#include <memory>
#include <vector>
#include <cuda_runtime.h>

using namespace Blast;

namespace {

struct MpmTotals {
    double mass = 0.0, px = 0.0, py = 0.0, pz = 0.0, ke = 0.0, e_int = 0.0, volume = 0.0;
    size_t n = 0;
};

MpmTotals mpm_totals(MPMSolver3DCUDA& mpm) {
    mpm.syncParticlesToHost();
    MpmTotals t;
    for (const auto& p : mpm.getParticles()) {
        if (p.m <= 0.0f || p.state == 2) continue;
        const double m = p.m;
        t.mass += m;
        t.px += m * p.v[0];
        t.py += m * p.v[1];
        t.pz += m * p.v[2];
        t.ke += 0.5 * m * (double(p.v[0]) * p.v[0] + double(p.v[1]) * p.v[1] + double(p.v[2]) * p.v[2]);
        t.e_int += m * p.e_int;
        t.volume += p.V;
        ++t.n;
    }
    return t;
}

struct Scenario {
    const char* name;
    int n;                 // cubic grid n^3
    double h;              // cell size
    BCType3D cfd_bc;
    MPMBoundaryCondition3D mpm_bc;
    double t_end;
    bool two_slabs;
};

struct Budget {
    double mass0 = 0.0, mom0[3] = {0, 0, 0}, mom_mpm0[3] = {0, 0, 0};
    double trans_net = 0.0, trans_gross = 0.0;
    double step_net = 0.0, step_gross = 0.0;
    double max_mass_rel = 0.0;
    double max_mom_rel = 0.0;
    double e_total0 = 0.0, max_e_rel = 0.0;
    double min_fluid_cells_frac = 1.0;
    double cov_mass = 0.0, unc_mass = 0.0;       // mass removed by covering / created by uncovering [kg]
    long long n_cov = 0, n_unc = 0, n_reversal = 0;
};
constexpr int kReversalWindow = 5;

int run(const Scenario& sc) {
    const int n = sc.n;
    const double h = sc.h;
    const double L = n * h;
    std::printf("\n==================================================================\n");
    std::printf("Scenario: %s\n", sc.name);
    std::printf("  CFD grid %d x %d x %d, dx = %.4f m, FP64 single-material ideal gas, ADER-2/AUSM+\n", n, n, n, h);
    std::printf("  MPM grid %d x %d x %d (co-located), dx = %.4f m\n", n, n, n, h);
    std::printf("==================================================================\n");

    auto cfd = std::make_unique<CFDSolver3DCuda<double, false>>(n, n, n, h, 0.0, 0.0, 0.0);
    cfd->setFluxScheme("AUSM+");
    cfd->setSpatialOrder(2);
    cfd->setTemporalOrder(2);
    cfd->setBoundaryConditions(sc.cfd_bc, sc.cfd_bc, sc.cfd_bc, sc.cfd_bc, sc.cfd_bc, sc.cfd_bc);

    Charge3DParams charge;      // radius 0 -> quiescent ambient air, no charge
    charge.radius = 0.0;
    MultiMat::MaterialSet mats;
    cfd->setInitialCondition(charge, mats, 1.225, 101325.0);

    auto mpm = std::make_unique<MPMSolver3DCUDA>();
    mpm->initializeGrid(n, n, n, float(h), float(h), float(h));
    mpm->setTransferScheme(MPMTransferScheme::BSpline);
    mpm->setVelocityScheme(MPMVelocityScheme::APIC);
    mpm->setBoundaryConditions(sc.mpm_bc, sc.mpm_bc, sc.mpm_bc, sc.mpm_bc, sc.mpm_bc, sc.mpm_bc);

    const float u0 = 50.0f;  // m/s slab speed
    if (sc.two_slabs) {
        // Two aluminium slabs, 12 cm gap, closing at 100 m/s. They leave 9 cm of air margin on each
        // y/z side so squeezed air can escape sideways (reflective walls keep it in the box).
        const float sx = 0.10f, sy = float(L) - 0.18f, sz = float(L) - 0.18f;
        const float cy = float(L) * 0.5f, cz = float(L) * 0.5f;
        mpm->addBoxObject(1, 0.08f + sx * 0.5f, cy, cz, sx, sy, sz, +u0, 0, 0, 0, 0, 0,
                          2700.0f, 70.0e9f, 0.33f, 276.0e6f, 1.0e8f, 0.25f, 3.0e8f, 8);
        mpm->addBoxObject(2, float(L) - 0.08f - sx * 0.5f, cy, cz, sx, sy, sz, -u0, 0, 0, 0, 0, 0,
                          2700.0f, 70.0e9f, 0.33f, 276.0e6f, 1.0e8f, 0.25f, 3.0e8f, 8);
    } else {
        const float s = 0.10f;
        mpm->addBoxObject(1, float(L) * 0.5f, float(L) * 0.5f, float(L) * 0.5f, s, s, s, +u0, 0, 0, 0, 0, 0,
                          2700.0f, 70.0e9f, 0.33f, 276.0e6f, 1.0e8f, 0.25f, 3.0e8f, 8);
    }
    mpm->syncToDevice();

    MpmTotals m0 = mpm_totals(*mpm);
    if (m0.n == 0) { std::fprintf(stderr, "[FAIL] no MPM particles generated\n"); return 1; }
    std::printf("  MPM particles Np = %zu, solid mass = %.4f kg, solid volume = %.6e m^3\n", m0.n, m0.mass, m0.volume);

    // The CFD ledger before any coupling still counts the ambient air sitting inside the solid's initial
    // volume (the initial condition does not know about the MPM bodies). That air is removed when the
    // first solid mask is established; this is a setup artifact, NOT a coupling leak, so the budget is
    // baselined AFTER the first mask and the artifact is reported separately.
    const CFDFluidLedger3D led_unmasked = cfd->getFluidLedger();
    if (!led_unmasked.valid) { std::fprintf(stderr, "[FAIL] fluid ledger unsupported by backend\n"); return 1; }
    mpm->particleToGridDeviceOnly();
    cfd->coupleFSIWithMPMGPU(mpm.get());
    cudaDeviceSynchronize();
    CFDFluidLedger3D led = cfd->getFluidLedger();
    std::printf("  Initial air inside solid footprint (setup artifact, excluded): %.6e kg (%.3f%% of domain air)\n",
                led_unmasked.mass - led.mass, 100.0 * (led_unmasked.mass - led.mass) / led_unmasked.mass);
    std::printf("  Initial mask volume / true solid volume = %.3f  (staircase oversize)\n",
                (led_unmasked.fluid_volume - led.fluid_volume) / m0.volume);
    if (!led.valid) { std::fprintf(stderr, "[FAIL] fluid ledger unsupported by backend\n"); return 1; }

    Budget b;
    b.mass0 = led.mass;
    for (int i = 0; i < 3; ++i) b.mom0[i] = led.momentum[i];
    b.mom_mpm0[0] = m0.px; b.mom_mpm0[1] = m0.py; b.mom_mpm0[2] = m0.pz;
    b.e_total0 = led.energy + m0.ke + m0.e_int;
    const double mom_ref = std::max(1.0e-12, std::sqrt(m0.px * m0.px + m0.py * m0.py + m0.pz * m0.pz));
    const double total_cells0 = double(n) * n * n;
    (void)total_cells0;

    const float cfl = 0.4f;
    double t = 0.0, last_dt = 0.0;
    int step = 0;
    const int report_every = 40;
    std::vector<int8_t> last_flip;       // +1 last covered, -1 last uncovered, 0 never flipped
    std::vector<int> last_flip_step;
    std::printf("\n  step      t[ms]   dt[ns]   fluid_cells   dM_net/M0    transition_net/M0  step_net/M0\n");

    while (t < sc.t_end) {
        const CFDFluidLedger3D L0 = cfd->getFluidLedger();
        std::vector<uint8_t> solid0, solid1;
        std::vector<double> rho0, rho1;
        cfd->downloadFluidDiagnostics(solid0, rho0);

        mpm->particleToGridDeviceOnly();
        cfd->coupleFSIWithMPMGPU(mpm.get());
        cudaDeviceSynchronize();
        const CFDFluidLedger3D L1 = cfd->getFluidLedger();
        cfd->downloadFluidDiagnostics(solid1, rho1);
        if (last_flip.empty()) { last_flip.assign(solid0.size(), 0); last_flip_step.assign(solid0.size(), -1000000); }
        for (size_t c = 0; c < solid0.size(); ++c) {
            if (!solid0[c] && solid1[c]) {            // covered: fluid mass in this cell is removed
                b.cov_mass += rho0[c] * h * h * h;  ++b.n_cov;
                if (last_flip[c] == -1 && step - last_flip_step[c] <= kReversalWindow) ++b.n_reversal;
                last_flip[c] = +1; last_flip_step[c] = step;
            } else if (solid0[c] && !solid1[c]) {     // uncovered: fluid mass is created in this cell
                b.unc_mass += rho1[c] * h * h * h;  ++b.n_unc;
                if (last_flip[c] == +1 && step - last_flip_step[c] <= kReversalWindow) ++b.n_reversal;
                last_flip[c] = -1; last_flip_step[c] = step;
            }
        }

        double dt_m = mpm->computeStepSize(cfl);
        double dt_c = cfd->computeStepSize(cfl);
        double dt = std::min(dt_m, dt_c);
        dt = (step == 0) ? 0.5 * dt : (last_dt > 0.0 ? std::min(dt, 1.5 * last_dt) : dt);
        last_dt = dt;

        mpm->stepWithDt(float(dt), false);
        cfd->step(dt);
        cudaDeviceSynchronize();
        const CFDFluidLedger3D L2 = cfd->getFluidLedger();

        t += dt;
        ++step;

        const double dm_trans = L1.mass - L0.mass;
        const double dm_step = L2.mass - L1.mass;
        b.trans_net += dm_trans;  b.trans_gross += std::fabs(dm_trans);
        b.step_net += dm_step;    b.step_gross += std::fabs(dm_step);
        const double mass_rel = std::fabs(L2.mass - b.mass0) / b.mass0;
        b.max_mass_rel = std::max(b.max_mass_rel, mass_rel);

        if (step == 20 || (sc.two_slabs && step == 1350)) {
            const int jc = n / 2, kc = n / 2;
            std::printf("  [step %d centerline] trailing / gap / leading [i: rho/r0, p/p0, T/T0, |u|]:\n", step);
            for (int i = 0; i < n; ++i) {
                const size_t idx = size_t(i) + size_t(jc) * n + size_t(kc) * n * n;
                bool near_edge = false;
                for (int d = -2; d <= 2; ++d) {
                    int ni = i + d;
                    if (ni >= 0 && ni < n && solid1[size_t(ni) + size_t(jc) * n + size_t(kc) * n * n] != solid1[idx]) near_edge = true;
                }
                if (!solid1[idx] && (near_edge || (sc.two_slabs && step == 1350 && i >= 17 && i <= 30))) {
                    auto cv = cfd->getCellValues(i, jc, kc);
                    if (cv.size() >= 3) {
                        double rr = cv[1] / 1.225, pp = cv[0] / 101325.0;
                        std::printf("    i=%2d: rho=%.3f  p=%.3f  T=%.3f  |u|=%.1f\n", i, rr, pp, pp / rr, cv[2]);
                    }
                }
            }
        }
        if (step % report_every == 0 || t >= sc.t_end) {
            const MpmTotals mt = mpm_totals(*mpm);
            const double px = L2.momentum[0] + mt.px, py = L2.momentum[1] + mt.py, pz = L2.momentum[2] + mt.pz;
            const double dpx = px - (b.mom0[0] + b.mom_mpm0[0]);
            const double dpy = py - (b.mom0[1] + b.mom_mpm0[1]);
            const double dpz = pz - (b.mom0[2] + b.mom_mpm0[2]);
            const double mom_rel = std::sqrt(dpx * dpx + dpy * dpy + dpz * dpz) / mom_ref;
            b.max_mom_rel = std::max(b.max_mom_rel, mom_rel);
            const double e_tot = L2.energy + mt.ke + mt.e_int;
            const double e_rel = std::fabs(e_tot - b.e_total0) / std::fabs(b.e_total0);
            b.max_e_rel = std::max(b.max_e_rel, e_rel);
            std::printf("  %5d  %9.4f  %7.1f  %11lld   %+.3e      %+.3e        %+.3e\n",
                        step, t * 1.0e3, dt * 1.0e9, L2.fluid_cells,
                        (L2.mass - b.mass0) / b.mass0, b.trans_net / b.mass0, b.step_net / b.mass0);
        }
        if (step > 200000) { std::fprintf(stderr, "[FAIL] step limit\n"); return 1; }
    }

    const MpmTotals mt = mpm_totals(*mpm);
    const CFDFluidLedger3D Lf = cfd->getFluidLedger();
    std::printf("\n  ---- ERROR BUDGET (steps = %d, t = %.4f ms) ----\n", step, t * 1.0e3);
    std::printf("  Fluid mass:      M0 = %.9e kg   M_end = %.9e kg\n", b.mass0, Lf.mass);
    std::printf("  max |dM|/M0 over run             = %.3e\n", b.max_mass_rel);
    std::printf("  transition (cover/uncover): net  = %+.3e   gross = %.3e   (x M0)\n", b.trans_net / b.mass0, b.trans_gross / b.mass0);
    std::printf("  FV step (fixed mask):       net  = %+.3e   gross = %.3e   (x M0)\n", b.step_net / b.mass0, b.step_gross / b.mass0);
    std::printf("  Fluid volume: V_end = %.6e m^3, solid volume = %.6e m^3, domain = %.6e m^3\n",
                Lf.fluid_volume, mt.volume, L * L * L);
    const double amb_cell_mass = 1.225 * h * h * h;
    std::printf("  ---- TRANSITION ATTRIBUTION (cells flipping fluid<->wall) ----\n");
    std::printf("  covered   (fluid->wall): %lld cells, mass removed  = %.3e x M0, mean rho = %.4f x ambient\n",
                b.n_cov, b.cov_mass / b.mass0, b.n_cov ? (b.cov_mass / double(b.n_cov)) / amb_cell_mass : 0.0);
    std::printf("  uncovered (wall->fluid): %lld cells, mass created  = %.3e x M0, mean rho = %.4f x ambient\n",
                b.n_unc, b.unc_mass / b.mass0, b.n_unc ? (b.unc_mass / double(b.n_unc)) / amb_cell_mass : 0.0);
    std::printf("  net (created - removed)  = %+.3e x M0   [cell-count imbalance uncovered-covered = %+lld]\n",
                (b.unc_mass - b.cov_mass) / b.mass0, b.n_unc - b.n_cov);
    std::printf("  flicker: %lld flips reversed within %d steps (%.1f%% of all %lld flips)\n",
                b.n_reversal, kReversalWindow, 100.0 * double(b.n_reversal) / double(std::max<long long>(1, b.n_cov + b.n_unc)),
                b.n_cov + b.n_unc);
    {
        std::vector<uint8_t> sf; std::vector<double> rf;
        if (cfd->downloadFluidDiagnostics(sf, rf)) {
            const int jc = n / 2, kc = n / 2;
            auto at = [&](int i) { return size_t(i) + size_t(jc) * n + size_t(kc) * n * n; };
            int i_rear = -1, i_front = -1;                 // first solid cell, first fluid cell after it
            for (int i = 0; i < n; ++i) {
                if (i_rear < 0 && sf[at(i)]) i_rear = i;
                else if (i_rear >= 0 && i_front < 0 && !sf[at(i)]) { i_front = i; break; }
            }
            if (i_rear >= 0 && i_front >= 0) {
                std::printf("  ---- CENTERLINE DENSITY PROFILE rho/rho_amb (final state, j=k=%d) ----\n", jc);
                std::printf("  trailing face of body 1 (solid starts at i=%d):  fluid cells i=%d..%d:", i_rear, std::max(0, i_rear - 5), i_rear - 1);
                for (int i = std::max(0, i_rear - 5); i < i_rear; ++i) std::printf(" %.3f", rf[at(i)] / 1.225);
                std::printf("\n  leading  face of body 1 (solid ends at i=%d):    fluid cells i=%d..%d:", i_front - 1, i_front, std::min(n - 1, i_front + 4));
                for (int i = i_front; i <= std::min(n - 1, i_front + 4); ++i) std::printf(" %.3f", rf[at(i)] / 1.225);
                std::printf("\n");
                std::printf("  trailing [p/p0, T/T0, |u|]:");
                for (int i = std::max(0, i_rear - 5); i < i_rear; ++i) {
                    auto cv = cfd->getCellValues(i, jc, kc);
                    if (cv.size() >= 3) {
                        double rr = cv[1] / 1.225, pp = cv[0] / 101325.0;
                        std::printf(" [%.3f,%.3f,%.1f]", pp, pp / rr, cv[2]);
                    }
                }
                std::printf("\n  leading  [p/p0, T/T0, |u|]:");
                for (int i = i_front; i <= std::min(n - 1, i_front + 4); ++i) {
                    auto cv = cfd->getCellValues(i, jc, kc);
                    if (cv.size() >= 3) {
                        double rr = cv[1] / 1.225, pp = cv[0] / 101325.0;
                        std::printf(" [%.3f,%.3f,%.1f]", pp, pp / rr, cv[2]);
                    }
                }
                std::printf("\n");
            }
        }
    }
    std::printf("  Coupled momentum drift  max |dP|/|P_mpm0| = %.3e%s\n", b.max_mom_rel,
                sc.cfd_bc == BCType3D::REFLECTIVE ? "  (informational: reflective walls exchange momentum with the box)" : "");
    std::printf("  Coupled energy drift    max |dE|/E0       = %.3e  (INFORMATIONAL: excludes MPM elastic strain energy)\n", b.max_e_rel);

    int rc = 0;
    // Rigorous criterion only for scenario A (sealed box): fluid mass must be conserved.
    if (sc.cfd_bc == BCType3D::REFLECTIVE) {
        const double tol = 1.0e-9;
        const bool ok = b.max_mass_rel <= tol;
        std::printf("  STATUS fluid mass conservation  (tol %.1e): %s\n", tol, ok ? "PASS" : "FAIL");
        if (!ok) rc = 1;
    } else {
        const double tol = 1.0e-3;
        const bool ok = b.max_mom_rel <= tol;
        std::printf("  STATUS coupled momentum         (tol %.1e): %s\n", tol, ok ? "PASS" : "FAIL");
        if (!ok) rc = 1;
    }
    return rc;
}

} // namespace

int main() {
    int rc = 0;
    rc |= run(Scenario{"A: gap closing in sealed box", 48, 0.01, BCType3D::REFLECTIVE,
                       MPMBoundaryCondition3D::Reflecting, 1.0e-3, true});
    rc |= run(Scenario{"B: free flight through quiescent air", 64, 0.01, BCType3D::TRANSMISSIVE,
                       MPMBoundaryCondition3D::Transmitting, 4.0e-4, false});
    std::printf("\nOverall: %s\n", rc == 0 ? "ALL RIGOROUS CRITERIA MET" : "CONSERVATION CRITERIA VIOLATED (see budget above)");
    return rc;
}
