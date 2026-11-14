// Lee-Tarver Ignition & Growth + JWLReactant + mixture-rule verification (Directives 16/17).
// Every test below calls the PRODUCTION constitutive headers (constitutive_lee_tarver.hpp,
// constitutive_jwl.hpp, constitutive_mixture.hpp). Data sources: LLNL UCRL-JC-141967 Table 1
// (PBX 9501) and UCRL-CONF-223847 Table 2 (C-4), converted to strict SI here via
// Blast::LeeTarver::fromLLNL_*. The grid-level pop-plot and Hugoniot benchmarks are NOT run and
// are reported honestly as STATUS: PENDING INTEGRATION.
#include "vv_lee_tarver.hpp"
#include "../constitutive_lee_tarver.hpp"
#include "../constitutive_jwl.hpp"
#include "../constitutive_mixture.hpp"
#include "../mpm_solver_3d.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <sstream>

namespace Blast::VV {

namespace {

struct Reactant { double A, B, R1, R2, omega, Cv, T0, rho0; };
struct Product  { double A, B, R1, R2, omega, E0; };

// LLNL Mbar/g/cc/us values -> SI (x1e11 for Mbar, x1000 for g/cc)
constexpr Reactant kPBX9501{7320.0e11, -0.052654e11, 14.1, 1.41, 0.8867, 2.7806e-5 * 1.0e11, 298.0, 1838.0};
constexpr Product  kPBX9501P{16.689e11, 0.5969e11, 5.9, 2.1, 0.45, 0.095e11};
constexpr Reactant kC4{778.1e11, -0.05031e11, 11.3, 1.13, 0.8938, 2.487e-5 * 1.0e11, 298.0, 1601.0};

double reactantP(const Reactant& r, double V, double e_th) {
    return Blast::JWL::computeJWLReactantPressure<double>(V, e_th, r.A, r.B, r.R1, r.R2, r.omega, r.Cv, r.T0, r.rho0);
}

struct Rates { double I, a, b, x, ig, G1, c, d, y, g1max, G2, e, g, z, g2min; };
Rates pbx9501Rates() {
    using namespace Blast::LeeTarver;
    return { fromLLNL_I(1.4e11), 0.0, 0.667, 20.0, 0.3,
             fromLLNL_G(130.0, 2.0), 0.667, 0.277, 2.0, 0.5,
             fromLLNL_G(400.0, 2.0), 0.333, 1.0, 2.0, 0.5 };
}
double rateOf(const Rates& k, double lam, double V, double p) {
    return Blast::LeeTarver::evalLeeTarverRate<double>(lam, V, p, k.I, k.a, k.b, k.x, k.ig, k.G1, k.c, k.d, k.y, k.g1max, k.G2, k.e, k.g, k.z, k.g2min);
}

BenchmarkResult pending(const std::string& id, const std::string& title, int level, const std::string& why) {
    BenchmarkResult r;
    r.id = id; r.title = title; r.level = level; r.passed = false; r.pending = true;
    r.summary = "STATUS: PENDING INTEGRATION";
    r.details = why;
    return r;
}

BenchmarkResult test_cold_curve_zero_pressure() {
    BenchmarkResult r;
    r.id = "VV-L1-LT-01"; r.level = 1;
    r.title = "JWLReactant: p(V=1, e_th=0, T0) vanishes (PBX 9501, C-4)";
    r.tolerance_linf = 1.0e-3;
    const Reactant sets[2] = {kPBX9501, kC4};
    double worst = 0.0;
    std::ostringstream d;
    d << "Material point (no grid, no time stepping), V = 1.0, e_th = 0. Residual / scale where scale = |A e^-R1| + omega Cv T0.\n";
    for (const auto& s : sets) {
        const double p = reactantP(s, 1.0, 0.0);
        const double scale = std::abs(s.A * std::exp(-s.R1)) + s.omega * s.Cv * s.T0;
        const double rel = std::abs(p) / scale;
        worst = std::max(worst, rel);
        d << "  rho0=" << s.rho0 << " kg/m^3  p=" << p << " Pa  scale=" << scale << " Pa  rel=" << rel << "\n";
    }
    r.error_linf = worst; r.passed = worst <= r.tolerance_linf;
    r.summary = "max |p|/scale = " + std::to_string(worst) + " (residual is rounding of the published B)";
    r.details = d.str();
    return r;
}

BenchmarkResult test_unit_conversions() {
    BenchmarkResult r;
    r.id = "VV-L1-LT-02"; r.level = 1;
    r.title = "LLNL -> strict SI conversion of Lee-Tarver rate constants";
    r.tolerance_linf = 1.0e-12;
    using namespace Blast::LeeTarver;
    // Exact hand conversions: I[1/s] = I[1/us]*1e6 ; G[1/(s Pa^n)] = G*1e6*(1e-11)^n
    const double got[4] = {fromLLNL_I(1.4e11), fromLLNL_G(130.0, 2.0), fromLLNL_G(400.0, 2.0), fromLLNL_G(140.0, 2.0)};
    const double ref[4] = {1.4e17, 1.3e-14, 4.0e-14, 1.4e-14};
    double worst = 0.0;
    for (int i = 0; i < 4; ++i) worst = std::max(worst, std::abs(got[i] - ref[i]) / ref[i]);
    r.error_linf = worst; r.passed = worst <= r.tolerance_linf;
    r.summary = "max relative error vs hand conversions = " + std::to_string(worst);
    r.details = "Pure scalar conversion; PBX 9501 I, G1, G2 and C-4 G1 (y = 2).";
    return r;
}

BenchmarkResult test_rate_hand_value() {
    BenchmarkResult r;
    r.id = "VV-L1-LT-03"; r.level = 1;
    r.title = "Lee-Tarver rate at 3 GPa, lambda=0.1, V=0.9 (PBX 9501) vs independent hand formula";
    r.tolerance_linf = 1.0e-9;
    const Rates k = pbx9501Rates();
    const double lam = 0.1, V = 0.9, p = 3.0e9;
    const double eta = 1.0 / V - 1.0;
    const double ref = k.I * std::pow(1.0 - lam, 0.667) * std::pow(eta, 20.0)
                     + k.G1 * std::pow(1.0 - lam, 0.667) * std::pow(lam, 0.277) * std::pow(p, 2.0);
    const double got = rateOf(k, lam, V, p);
    r.error_linf = std::abs(got - ref) / ref; r.passed = r.error_linf <= r.tolerance_linf;
    r.summary = "rate = " + std::to_string(got) + " 1/s (ref " + std::to_string(ref) + ")";
    r.details = "Material point. Ignition and growth-1 terms are active (lambda < Fig = 0.3 and < FG1 = 0.5); completion is off (lambda < FG2).";
    return r;
}

BenchmarkResult test_mixture_equilibrium() {
    BenchmarkResult r;
    r.id = "VV-L1-LT-04"; r.level = 1;
    r.title = "Pressure-equilibrium mixture: |p_s - p_p| and volume additivity (PBX 9501)";
    r.tolerance_linf = 1.0e-4;
    const double e_th = 3.0e5;                         // J/kg above initial state
    const double q = kPBX9501P.E0 / kPBX9501.rho0;     // J/kg
    auto ps = [&](double vs) { return reactantP(kPBX9501, vs, e_th); };
    auto pp = [&](double vp) {
        return Blast::JWL::computeJWLProductPressure<double>(vp, e_th + q, kPBX9501P.A, kPBX9501P.B, kPBX9501P.R1, kPBX9501P.R2, kPBX9501P.omega, kPBX9501.rho0);
    };
    double worst = 0.0, worst_vol = 0.0; int max_it = 0, n = 0;
    std::ostringstream d;
    d << "Material point, e_th = 3e5 J/kg, q = " << q << " J/kg; rows: V, lambda, p, V_s, V_p, iters, |ps-pp|/p\n";
    const double Vs[3] = {0.85, 0.95, 1.0};
    const double Ls[4] = {0.05, 0.3, 0.6, 0.9};
    for (double V : Vs) for (double lam : Ls) {
        const auto m = Blast::Mixture::mixturePressure(Blast::Mixture::Rule::PressureEquilibrium, V, lam, ps, pp);
        const double rs = std::abs(ps(m.v_s) - pp(m.v_p)) / std::max(std::abs(m.p), 1.0e6);
        const double vol = std::abs((1.0 - lam) * m.v_s + lam * m.v_p - V) / V;
        worst = std::max(worst, rs); worst_vol = std::max(worst_vol, vol); max_it = std::max(max_it, m.iters); ++n;
        d << "  " << V << " " << lam << " " << m.p << " " << m.v_s << " " << m.v_p << " " << m.iters << " " << rs << "\n";
    }
    r.error_linf = std::max(worst, worst_vol);
    r.passed = (r.error_linf <= r.tolerance_linf) && max_it <= 24;
    r.summary = std::to_string(n) + " states: max pressure mismatch " + std::to_string(worst) + ", volume error " + std::to_string(worst_vol) + ", max iterations " + std::to_string(max_it);
    r.details = d.str();
    return r;
}

BenchmarkResult test_rate_integrator_convergence() {
    BenchmarkResult r;
    r.id = "VV-L1-LT-05"; r.level = 1;
    r.title = "advanceLeeTarver (adaptive Heun) vs fine RK4 reference at frozen state";
    r.tolerance_linf = 5.0e-3;
    const Rates k = pbx9501Rates();
    const double V = 0.9, p = 3.0e9, lam0 = 0.05, T = 3.0e-6;
    const double lam_prod = Blast::LeeTarver::advanceLeeTarver<double>(T, lam0, V, p,
        k.I, k.a, k.b, k.x, k.ig, k.G1, k.c, k.d, k.y, k.g1max, k.G2, k.e, k.g, k.z, k.g2min);
    // Reference: classical RK4, N = 200000 steps of the production rate function.
    const int N = 200000; const double h = T / N; double lam = lam0;
    for (int i = 0; i < N; ++i) {
        const double k1 = rateOf(k, lam, V, p);
        const double k2 = rateOf(k, lam + 0.5 * h * k1, V, p);
        const double k3 = rateOf(k, lam + 0.5 * h * k2, V, p);
        const double k4 = rateOf(k, lam + h * k3, V, p);
        lam += h * (k1 + 2 * k2 + 2 * k3 + k4) / 6.0;
    }
    r.error_linf = std::abs(lam_prod - lam) / std::max(lam, 1.0e-12);
    r.passed = r.error_linf <= r.tolerance_linf;
    r.summary = "lambda(T): production " + std::to_string(lam_prod) + ", RK4 reference " + std::to_string(lam);
    r.details = "Material point at frozen V = 0.9, p = 3 GPa, lambda0 = 0.05, T = 3 us, one production call vs N = 200000 RK4 steps (dt = 1.5e-11 s). Pressure feedback is deliberately excluded here; it is covered by the pending grid benchmarks.";
    return r;
}


// ---------------------------------------------------------------------------------------------
// Pop-plot harness: genuine MPMSolver3D (CPU), 1-D slab (4 x 4 x Nz cells, free-slip lateral walls).
// A flyer of the SAME material with all Lee-Tarver rates zeroed (inert) is placed in contact with the
// reactive target (single velocity field -> exact symmetric-impact Riemann problem, up = v/2).
// The flyer speed is chosen so the unreacted Hugoniot (production JWLReactant EOS) gives the
// experimental input pressure. Run distance = depth at which the lead-wave speed first exceeds
// 0.95 * D_CJ. No tuning of any model parameter is performed.
// ---------------------------------------------------------------------------------------------
struct Explosive {
    const char* name; Reactant r; Product pr; Rates k; double nu, G, yield, det_vel;
};
Explosive makeExplosive(int which) {
    using namespace Blast::LeeTarver;
    Explosive e{};
    if (which == 0) { // PBX 9501
        e = {"PBX 9501", kPBX9501, kPBX9501P, pbx9501Rates(), 0.25, 0.0354e11, 0.002e11, 8800.0};
    } else if (which == 1) { // C-4
        Rates k{fromLLNL_I(4.0e6), 0.0367, 0.667, 7.0, 0.022, fromLLNL_G(140.0, 2.0), 0.667, 0.333, 2.0, 1.0, 0.0, 0.667, 0.667, 3.0, 0.0};
        e = {"C-4", kC4, Product{6.0977e11, 0.1295e11, 4.5, 1.4, 0.25, 0.09e11}, k, 0.25, 0.0354e11, 0.002e11, 8040.0};
    } else { // Composition B (PARTIAL calibration)
        Rates k{fromLLNL_I(4.0e6), 0.0367, 0.667, 7.0, 0.022, fromLLNL_G(140.0, 2.0), 0.667, 0.333, 2.0, 0.7, fromLLNL_G(1000.0, 3.0), 0.222, 1.0, 3.0, 0.0};
        Reactant rr = kC4; rr.rho0 = 1717.0;
        e = {"Composition B", rr, Product{5.242e11, 0.07678e11, 4.2, 1.1, 0.5, 0.085e11}, k, 0.25, 0.0354e11, 0.002e11, 7980.0};
    }
    return e;
}

// Unreacted principal Hugoniot: for relative volume V, p_H solves p = p_EOS(V, e_th = 0.5 p (1-V)/rho0).
double hugoniotPressure(const Reactant& r, double V) {
    double lo = 0.0, hi = 1.0e12;
    for (int i = 0; i < 200; ++i) {
        const double p = 0.5 * (lo + hi);
        const double f = reactantP(r, V, 0.5 * p * (1.0 - V) / r.rho0) - p;
        if (f > 0.0) lo = p; else hi = p;
    }
    return 0.5 * (lo + hi);
}
// Particle velocity for input pressure P (symmetric impact): bisect on V in [0.5, 1).
double particleVelocityForPressure(const Reactant& r, double P) {
    double lo = 0.5, hi = 0.9999;
    for (int i = 0; i < 100; ++i) {
        const double V = 0.5 * (lo + hi);
        if (hugoniotPressure(r, V) > P) lo = V; else hi = V;
    }
    const double V = 0.5 * (lo + hi);
    return std::sqrt(std::max(0.0, P * (1.0 - V) / r.rho0));
}

struct PopCase { int expl; double P_gpa, run_mm; };

struct PopResult { double run_mm, p_in_gpa, t_end_us; bool detonated; int np; int nz; double dt_last; };

PopResult runPopCase(const Explosive& ex, double P_in_pa, double run_exp_mm, double dz) {
    using namespace Blast;
    const double flyer_len = 0.020;                              // m
    const double target_len = std::max(0.020, 1.4 * run_exp_mm * 1.0e-3 + 0.010);
    const int nlat = 4;
    const int margin = 4;
    const int nz = static_cast<int>(std::ceil((flyer_len + target_len) / dz)) + 2 * margin;
    const double z0 = margin * dz;                               // flyer back face
    const double z_if = z0 + flyer_len;                          // interface
    MPMSolver3D mpm;
    mpm.initializeGrid(nlat, nlat, nz, (float)dz, (float)dz, (float)dz, 0.0f, 0.0f, 0.0f);
    mpm.setBoundaryConditions(MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                              MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                              MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip);

    MaterialTable3D mat;
    mat.material_model = MPMMaterialModel::LeeTarverIgnitionGrowth;
    mat.solid_model = SolidReactantEOS::JWLReactant;
    mat.burn_model = ReactionKinetics::LeeTarverODE;
    mat.product_model = DetonationProductEOS::JWLProductGas;
    mat.density = (float)ex.r.rho0;
    mat.youngs_modulus = (float)(2.0 * ex.G * (1.0 + ex.nu)); mat.poissons_ratio = (float)ex.nu;
    mat.yield_stress = (float)ex.yield; mat.hardening_modulus = 0.0f;
    mat.det_vel = (float)ex.det_vel; mat.detonation_energy = (float)(ex.pr.E0 / ex.r.rho0);
    mat.jwl_A = (float)ex.pr.A; mat.jwl_B = (float)ex.pr.B; mat.jwl_R1 = (float)ex.pr.R1; mat.jwl_R2 = (float)ex.pr.R2; mat.jwl_omega = (float)ex.pr.omega;
    mat.jwlr_A = (float)ex.r.A; mat.jwlr_B = (float)ex.r.B; mat.jwlr_R1 = (float)ex.r.R1; mat.jwlr_R2 = (float)ex.r.R2;
    mat.jwlr_omega = (float)ex.r.omega; mat.jwlr_Cv = (float)ex.r.Cv; mat.jwlr_T0 = (float)ex.r.T0;
    mat.mixture_rule = 1;
    const Rates& k = ex.k;
    mat.lt_I = (float)k.I; mat.lt_a = (float)k.a; mat.lt_b = (float)k.b; mat.lt_x = (float)k.x; mat.lt_ig_max = (float)k.ig;
    mat.lt_G1 = (float)k.G1; mat.lt_c = (float)k.c; mat.lt_d = (float)k.d; mat.lt_y = (float)k.y; mat.lt_growth_max = (float)k.g1max;
    mat.lt_G2 = (float)k.G2; mat.lt_e = (float)k.e; mat.lt_g = (float)k.g; mat.lt_z = (float)k.z; mat.lt_comp_min = (float)k.g2min;
    MaterialTable3D inert = mat; inert.lt_I = 0.0f; inert.lt_G1 = 0.0f; inert.lt_G2 = 0.0f;

    const double up = particleVelocityForPressure(ex.r, P_in_pa);
    const double vfly = 2.0 * up;
    mpm.addBoxObject(0, nlat * dz * 0.5, nlat * dz * 0.5, z0 + 0.5 * flyer_len, nlat * dz, nlat * dz, flyer_len,
                     0, 0, (float)vfly, 0, 0, 0, (float)ex.r.rho0, mat.youngs_modulus, (float)ex.nu, (float)ex.yield, 0.0f, 0.25f, 600.0e6f, 8);
    mpm.addBoxObject(1, nlat * dz * 0.5, nlat * dz * 0.5, z_if + 0.5 * target_len, nlat * dz, nlat * dz, target_len,
                     0, 0, 0, 0, 0, 0, (float)ex.r.rho0, mat.youngs_modulus, (float)ex.nu, (float)ex.yield, 0.0f, 0.25f, 600.0e6f, 8);
    mpm.setMaterialTable(0, inert);
    mpm.setMaterialTable(1, mat);

    PopResult res{0.0, 0.0, 0.0, false, (int)mpm.getParticles().size(), nz, 0.0};
    struct Sample { double t, z; };
    std::vector<Sample> front;
    const double t_max = 60.0e-6;
    int step = 0;
    while (mpm.getSimTime() < t_max && !res.detonated) {
        mpm.step(0.3f);
        ++step;
        if (step % 4 != 0) continue;
        double zf = -1.0, pmax_in = 0.0;
        for (const auto& p : mpm.getParticles()) {
            if (p.m <= 0.0f) continue;
            const double pr = -(p.sigma.data[0] + p.sigma.data[1] + p.sigma.data[2]) / 3.0;
            const double depth = p.x[2] - z_if;
            if (depth > 0.0 && pr > 0.5 * P_in_pa) zf = std::max(zf, depth);
            if (depth > 0.002 && depth < 0.004) pmax_in = std::max(pmax_in, pr);
        }
        // Input pressure is sampled only while the lead wave is still in the first 5 mm (before reaction can matter)
        if (zf > 0.0 && zf < 0.005) res.p_in_gpa = std::max(res.p_in_gpa, pmax_in * 1.0e-9);
        if (zf > 0.0) front.push_back({mpm.getSimTime(), zf});
        // lead-wave speed over a 2 mm window
        for (int i = (int)front.size() - 1; i > 0; --i) {
            if (front.back().z - front[i].z >= 0.002) {
                const double D = (front.back().z - front[i].z) / (front.back().t - front[i].t);
                if (D > 0.95 * ex.det_vel && front.back().z > 0.004) { res.detonated = true; res.run_mm = front[i].z * 1.0e3; }
                break;
            }
        }
        if (!front.empty() && front.back().z > target_len - 0.002) break;
    }
    res.t_end_us = mpm.getSimTime() * 1.0e6; res.dt_last = mpm.getLastDt();
    if (!res.detonated) res.run_mm = -1.0;
    return res;
}

BenchmarkResult test_pop_plot() {
    BenchmarkResult r;
    r.id = "VV-L2-LT-POP"; r.level = 2;
    r.title = "Pop-plot run-to-detonation (PBX 9501, C-4, Comp B): production MPMSolver3D, 1-D slab";
    r.tolerance_linf = 0.30;
    const PopCase cases[] = {
        {0, 1.45, 72.2}, {0, 2.56, 16.9}, {1, 2.2, 25.0}, {1, 2.86, 17.0}, {1, 4.2, 9.0},
        {2, 3.78, 14.0}, {2, 4.35, 11.0}, {2, 4.8, 10.0}, {2, 6.84, 5.0}};
    const double dz = 0.5e-3;
    std::ostringstream d;
    d << "Discretization: 4 x 4 x Nz cells, dx = dy = dz = 0.5 mm, 8 particles/cell, free-slip walls, flyer 20 mm inert (same EOS), "
         "adaptive dt from MPMSolver3D::step(CFL 0.3). Run distance = depth where the lead-wave speed first exceeds 0.95 D_CJ over a 2 mm window "
         "(not tuned). Nonzero hydrodynamic noise / rise-time of a few cells limits accuracy for runs < 10 mm (< 20 cells).\n"
         "case: explosive, P_in target [GPa], measured P_in [GPa], run experiment [mm], run numerical [mm], rel err, Np, Nz, t_end [us]\n";
    double worst = 0.0; int n_ok = 0, n_fail = 0;
    for (const auto& c : cases) {
        const Explosive ex = makeExplosive(c.expl);
        const PopResult pr = runPopCase(ex, c.P_gpa * 1.0e9, c.run_mm, dz);
        double rel = 1.0;
        if (pr.detonated) { rel = std::abs(pr.run_mm - c.run_mm) / c.run_mm; ++n_ok; } else { ++n_fail; }
        worst = std::max(worst, rel);
        d << "  " << ex.name << ", " << c.P_gpa << ", " << pr.p_in_gpa << ", " << c.run_mm << ", "
          << (pr.detonated ? std::to_string(pr.run_mm) : std::string("NO DETONATION")) << ", " << rel << ", "
          << pr.np << ", " << pr.nz << ", " << pr.t_end_us << "\n";
    }
    r.error_linf = worst;
    r.passed = (n_fail == 0) && worst <= r.tolerance_linf;
    r.summary = std::to_string(n_ok) + "/9 cases reached detonation; worst relative run-distance error = " + std::to_string(worst) +
                " (tolerance " + std::to_string(r.tolerance_linf) + "). Composition B is a PARTIAL calibration.";
    r.details = d.str();
    return r;
}

} // namespace

std::vector<BenchmarkResult> run_lee_tarver_benchmarks() {
    std::vector<BenchmarkResult> out;
    out.push_back(test_cold_curve_zero_pressure());
    out.push_back(test_unit_conversions());
    out.push_back(test_rate_hand_value());
    out.push_back(test_mixture_equilibrium());
    out.push_back(test_rate_integrator_convergence());
    out.push_back(test_pop_plot());
    out.push_back(pending("VV-L2-LT-HUG",
        "Unreacted-JWL principal Hugoniot vs published Us-up relations", 2,
        "Reference relations exist (LX-17 Us=1.99+1.76 up; PBX 9502 Us=1.90+3.00 up) but the matching reactant EOS calibrations lack published cutoffs, so no shippable preset exists to test against."));
    return out;
}

} // namespace Blast::VV
