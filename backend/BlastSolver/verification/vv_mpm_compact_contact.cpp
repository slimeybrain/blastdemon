// =============================================================================
// VV-L2-MPM-CMP: Compact vs Dense Multi-Material (Bardenhagen) Grid Storage Parity
// =============================================================================
// The compact layout stores per-material grid fields only on nodes where >= 2 material
// fields overlap; single-material nodes are advanced directly on the global grid node.
// The two layouts are algebraically identical, so the only admissible difference is the
// non-deterministic ordering of float atomics. Every scenario therefore runs:
//   A  = production MPMSolver3DCUDA, dense layout
//   B  = production MPMSolver3DCUDA, compact layout (small initial slot capacity)
//   A' = second dense run (identical input) -> measured atomic-ordering noise floor
// in lockstep with the identical dt sequence (dt taken from A), and compares genuine
// particle state downloaded from device memory. No analytical or synthetic curves are used.
// =============================================================================

#include "vv_mpm_compact_contact.hpp"
#include "mpm_solver_3d_cuda.hpp"

#include <functional>
#include <memory>
#include <stdexcept>

namespace Blast::VV {

namespace {

struct ParityScenario {
    std::string id;
    std::string title;
    int nx{80}, ny{20}, nz{20};
    float dx{0.01f};
    MPMTransferScheme transfer{MPMTransferScheme::BSpline};
    MPMTimeIntegrationScheme time_scheme{MPMTimeIntegrationScheme::Leapfrog};
    int num_materials{2};
    std::vector<int> obj_to_mat;            // index = object id
    float friction{0.0f};
    float restitution{0.8f};
    int steps{150};
    float cfl{0.3f};
    float interface_x{0.40f};               // x position of the initial contact plane (profile band centre)
    size_t compact_initial_slots{1024};     // compact run starts small to exercise regrowth
    float v_ref{10.0f};                     // reference speed for profile normalisation
    std::function<void(MPMSolver3DCUDA&)> add_objects;
};

struct ParticleState {
    std::vector<double> vx, vy, vz, x, y, z, m;
};

ParticleState capture(MPMSolver3DCUDA& s) {
    s.syncParticlesToHost(); // genuine device particle state (no grid download needed)
    ParticleState st;
    const auto& ps = s.getParticles();
    const size_t n = s.getParticleCount();
    st.vx.reserve(n); st.vy.reserve(n); st.vz.reserve(n);
    st.x.reserve(n);  st.y.reserve(n);  st.z.reserve(n); st.m.reserve(n);
    for (size_t i = 0; i < n && i < ps.size(); ++i) {
        const auto& p = ps[i];
        st.vx.push_back(p.v[0]); st.vy.push_back(p.v[1]); st.vz.push_back(p.v[2]);
        st.x.push_back(p.x[0]);  st.y.push_back(p.x[1]);  st.z.push_back(p.x[2]);
        st.m.push_back(p.m);
    }
    return st;
}

struct ParityNorms {
    double v_l2{1.0};      // relative L2 of particle velocity vectors
    double v_linf{1.0};    // relative Linf of particle velocity components
    double x_linf_cells{1.0}; // max particle position difference in cells
    double momentum{1.0};  // |P_a - P_b| / sum(m |v_a|)
    double kinetic{1.0};   // |KE_a - KE_b| / KE_a
    bool comparable{false};
};

ParityNorms compare(const ParticleState& a, const ParticleState& b, double dx) {
    ParityNorms n;
    if (a.vx.empty() || a.vx.size() != b.vx.size()) return n;
    n.comparable = true;
    double d2 = 0.0, a2 = 0.0, dmax = 0.0, amax = 0.0, xmax = 0.0;
    double Pa[3] = {0, 0, 0}, Pb[3] = {0, 0, 0}, Pnorm = 0.0, KEa = 0.0, KEb = 0.0;
    for (size_t i = 0; i < a.vx.size(); ++i) {
        const double da[3] = {a.vx[i], a.vy[i], a.vz[i]};
        const double db[3] = {b.vx[i], b.vy[i], b.vz[i]};
        for (int c = 0; c < 3; ++c) {
            double d = db[c] - da[c];
            d2 += d * d;
            a2 += da[c] * da[c];
            dmax = std::max(dmax, std::abs(d));
            amax = std::max(amax, std::abs(da[c]));
            Pa[c] += a.m[i] * da[c];
            Pb[c] += b.m[i] * db[c];
        }
        xmax = std::max({xmax, std::abs(a.x[i] - b.x[i]), std::abs(a.y[i] - b.y[i]), std::abs(a.z[i] - b.z[i])});
        double sa = std::sqrt(da[0] * da[0] + da[1] * da[1] + da[2] * da[2]);
        Pnorm += a.m[i] * sa;
        KEa += 0.5 * a.m[i] * (da[0] * da[0] + da[1] * da[1] + da[2] * da[2]);
        KEb += 0.5 * b.m[i] * (db[0] * db[0] + db[1] * db[1] + db[2] * db[2]);
    }
    n.v_l2 = (a2 > 1.0e-30) ? std::sqrt(d2 / a2) : std::sqrt(d2);
    n.v_linf = (amax > 1.0e-30) ? dmax / amax : dmax;
    n.x_linf_cells = xmax / dx;
    double dP = std::sqrt((Pa[0] - Pb[0]) * (Pa[0] - Pb[0]) + (Pa[1] - Pb[1]) * (Pa[1] - Pb[1]) +
                          (Pa[2] - Pb[2]) * (Pa[2] - Pb[2]));
    n.momentum = (Pnorm > 1.0e-30) ? dP / Pnorm : dP;
    n.kinetic = (KEa > 1.0e-30) ? std::abs(KEa - KEb) / KEa : std::abs(KEa - KEb);
    return n;
}

// Mean particle vx per grid column (cell index along x) in the +/-5 cell band around the interface
void interface_profile(const ParticleState& s, double xmin, double dx, int ic,
                       std::vector<double>& centers, std::vector<double>& mean_vx, std::vector<int>& counts) {
    centers.clear(); mean_vx.clear(); counts.clear();
    for (int c = ic - 5; c <= ic + 5; ++c) {
        double sum = 0.0;
        int cnt = 0;
        for (size_t i = 0; i < s.x.size(); ++i) {
            int ci = static_cast<int>(std::floor((s.x[i] - xmin) / dx));
            if (ci == c) { sum += s.vx[i]; cnt++; }
        }
        centers.push_back(xmin + (c + 0.5) * dx);
        mean_vx.push_back(cnt > 0 ? sum / cnt : 0.0);
        counts.push_back(cnt);
    }
}

std::unique_ptr<MPMSolver3DCUDA> build_solver(const ParityScenario& sc, bool compact) {
    auto s = std::make_unique<MPMSolver3DCUDA>();
    s->initializeGrid(sc.nx, sc.ny, sc.nz, sc.dx, sc.dx, sc.dx, 0.0f, 0.0f, 0.0f);
    s->setTransferScheme(sc.transfer);
    s->setVelocityScheme(MPMVelocityScheme::APIC);
    s->setTimeScheme(sc.time_scheme);
    sc.add_objects(*s);
    s->setCompactMultiMaterialStorage(compact);
    if (compact) s->setInitialMultiMaterialSlotCapacity(sc.compact_initial_slots);
    s->setContactMethod(MPMContactMethod::MultiVelocityBardenhagen);
    s->setObjectMaterialMapping(sc.obj_to_mat, sc.num_materials);
    // DEM disabled; friction / restitution feed the Bardenhagen contact law
    s->setDemContact(false, sc.friction, sc.restitution, 1.0f, MPMDEMContactMode::AllDynamic, 0.1f);
    s->syncToDevice();
    return s;
}

std::string fmt(double v, int prec = 3) {
    std::ostringstream os;
    os << std::scientific << std::setprecision(prec) << v;
    return os.str();
}

BenchmarkResult run_parity_scenario(const ParityScenario& sc) {
    BenchmarkResult res;
    res.id = sc.id;
    res.title = sc.title;
    res.level = 2;
    res.tolerance_linf = 1.0e-4;     // one-step particle velocity, relative Linf
    res.tolerance_l2 = 1.0e-3;       // end-of-run particle velocity, relative L2
    res.tolerance_momentum = 1.0e-4; // end-of-run momentum difference / sum(m|v|)
    res.tolerance_energy = 1.0e-3;   // end-of-run kinetic energy difference, relative
    const double tol_profile = 1.0e-3; // per-cell |dvx| / v_ref in the +/-5 cell interface band

    try {
        auto A  = build_solver(sc, false);
        auto B  = build_solver(sc, true);
        auto A2 = build_solver(sc, false);

        if (A->isCompactMultiMaterialStorageActive() || !B->isCompactMultiMaterialStorageActive()) {
            throw std::runtime_error("storage layout selection failed (dense run compact or compact run dense)");
        }
        const size_t np = A->getParticleCount();
        if (np == 0 || np != B->getParticleCount() || np != A2->getParticleCount()) {
            throw std::runtime_error("particle counts differ between runs");
        }

        ParityNorms one_step, one_step_noise;
        int peak_slots = 0;
        size_t peak_compact_bytes = 0;
        double dt_first = 0.0, dt_last = 0.0, t_end = 0.0;

        for (int step = 0; step < sc.steps; ++step) {
            float dt = A->computeStepSize(sc.cfl);
            if (step == 0) dt_first = dt;
            dt_last = dt;
            t_end += dt;
            A->stepWithDt(dt, true);
            B->stepWithDt(dt, true);
            A2->stepWithDt(dt, true);
            peak_slots = std::max(peak_slots, B->getNumMultiMaterialSlots());
            peak_compact_bytes = std::max(peak_compact_bytes, B->getMultiMaterialStorageBytes());
            if (step == 0) {
                ParticleState a = capture(*A), b = capture(*B), a2 = capture(*A2);
                one_step = compare(a, b, sc.dx);
                one_step_noise = compare(a, a2, sc.dx);
            }
        }

        ParticleState a = capture(*A), b = capture(*B), a2 = capture(*A2);
        ParityNorms fin = compare(a, b, sc.dx);
        ParityNorms fin_noise = compare(a, a2, sc.dx);
        if (!one_step.comparable || !fin.comparable) {
            throw std::runtime_error("particle state not comparable (size mismatch after download)");
        }

        // +/-5 cell interface band profile (Directive 20)
        const int ic = static_cast<int>(std::floor(sc.interface_x / sc.dx));
        std::vector<double> xc, vxa, vxb, xc2;
        std::vector<int> cnt_a, cnt_b;
        interface_profile(a, 0.0, sc.dx, ic, xc, vxa, cnt_a);
        interface_profile(b, 0.0, sc.dx, ic, xc2, vxb, cnt_b);
        double profile_max = 0.0;
        bool counts_match = true;
        std::ostringstream prof;
        prof << "Interface band (cell, x [m], N_dense, N_compact, vx_dense, vx_compact, |dvx|/v_ref): ";
        for (size_t k = 0; k < xc.size(); ++k) {
            double d = std::abs(vxa[k] - vxb[k]) / sc.v_ref;
            profile_max = std::max(profile_max, d);
            if (cnt_a[k] != cnt_b[k]) counts_match = false;
            prof << "[" << (ic - 5 + static_cast<int>(k)) << ", " << std::fixed << std::setprecision(4) << xc[k]
                 << ", " << cnt_a[k] << ", " << cnt_b[k] << ", " << std::setprecision(5) << vxa[k] << ", " << vxb[k]
                 << ", " << fmt(d, 2) << "] ";
        }

        // Memory: compact must be smaller than dense on these grids (small initial slot capacity)
        const size_t dense_bytes = A->getMultiMaterialStorageBytes();
        const size_t compact_bytes = B->getMultiMaterialStorageBytes();
        const bool memory_ok = compact_bytes < dense_bytes;
        const bool slots_used = peak_slots > 0; // contact actually exercised the slot path
        const bool regrew = B->getMultiMaterialSlotCapacity() > sc.compact_initial_slots;

        res.error_linf = one_step.v_linf;
        res.error_l2 = fin.v_l2;
        res.momentum_drift = fin.momentum;
        res.energy_drift = fin.kinetic;
        res.passed = (res.error_linf <= res.tolerance_linf) &&
                     (res.error_l2 <= res.tolerance_l2) &&
                     (res.momentum_drift <= res.tolerance_momentum) &&
                     (res.energy_drift <= res.tolerance_energy) &&
                     (profile_max <= tol_profile) && memory_ok && slots_used;

        std::string svg_file = "vv_mpm_cmp_" + sc.id.substr(sc.id.size() - 2) + "_interface_profile.svg";
        generate_svg_plot(svg_file,
                          sc.id + ": Interface-band particle vx, dense (reference) vs compact storage",
                          "Cell centre x (m)", "Mean particle vx (m/s)", xc, vxa, vxb, 1.0, 5.0);
        res.svg_path = svg_file;

        std::ostringstream sum;
        sum << "Dense vs compact Bardenhagen storage: 1-step e_Linf(v) = " << fmt(one_step.v_linf)
            << " (noise floor " << fmt(one_step_noise.v_linf) << "), end e_L2(v) = " << fmt(fin.v_l2)
            << " (noise floor " << fmt(fin_noise.v_l2) << "), e_P = " << fmt(fin.momentum)
            << ", e_KE = " << fmt(fin.kinetic) << ", band max |dvx|/v_ref = " << fmt(profile_max)
            << ". Material storage " << dense_bytes << " B dense vs " << compact_bytes
            << " B compact (" << std::fixed << std::setprecision(1)
            << (100.0 * static_cast<double>(compact_bytes) / std::max<size_t>(1, dense_bytes)) << "%).";
        res.summary = sum.str();

        std::ostringstream det;
        det << "Discretisation: grid " << sc.nx << " x " << sc.ny << " x " << sc.nz
            << " (" << static_cast<size_t>(sc.nx) * sc.ny * sc.nz << " nodes), dx = dy = dz = " << sc.dx
            << " m, Np = " << np << ", materials M = " << sc.num_materials
            << ", steps = " << sc.steps << ", dt_first = " << fmt(dt_first) << " s, dt_last = " << fmt(dt_last)
            << " s, t_end = " << fmt(t_end) << " s, CFL = " << sc.cfl
            << ", transfer scheme = " << static_cast<int>(sc.transfer)
            << ", time scheme = " << static_cast<int>(sc.time_scheme)
            << ", friction = " << sc.friction << ", restitution = " << sc.restitution << ". "
            << "Compact slots: peak used = " << peak_slots << ", final capacity = " << B->getMultiMaterialSlotCapacity()
            << " (initial " << sc.compact_initial_slots << (regrew ? ", regrown" : ", no regrowth") << "), peak bytes = "
            << peak_compact_bytes << ". "
            << "Positions: 1-step max |dx| = " << fmt(one_step.x_linf_cells) << " cells, end max |dx| = "
            << fmt(fin.x_linf_cells) << " cells (noise floor " << fmt(fin_noise.x_linf_cells) << "). "
            << "Noise floor (dense vs dense rerun): e_P = " << fmt(fin_noise.momentum) << ", e_KE = "
            << fmt(fin_noise.kinetic) << ". "
            << "Checks: memory_ok = " << (memory_ok ? "yes" : "NO") << ", slot path exercised = "
            << (slots_used ? "yes" : "NO") << ", band particle counts identical = " << (counts_match ? "yes" : "no")
            << ". Tolerances: 1-step e_Linf <= " << fmt(res.tolerance_linf, 1) << ", end e_L2 <= "
            << fmt(res.tolerance_l2, 1) << ", e_P <= " << fmt(res.tolerance_momentum, 1) << ", e_KE <= "
            << fmt(res.tolerance_energy, 1) << ", band |dvx|/v_ref <= " << fmt(tol_profile, 1) << ". "
            << prof.str();
        res.details = det.str();
    } catch (const std::exception& e) {
        res.passed = false;
        res.summary = std::string("FAILED with exception: ") + e.what();
        res.details = "Scenario aborted before completion; see summary. No PASS is reported.";
    }
    return res;
}

// Additional structural check: zonal coupling must force the dense layout and switch back after.
BenchmarkResult run_layout_switch_check() {
    BenchmarkResult res;
    res.id = "VV-L2-CMP-00";
    res.title = "Compact Bardenhagen storage: zonal fallback and layout switching";
    res.level = 2;
    try {
        MPMSolver3DCUDA s;
        const int nx = 40, ny = 20, nz = 20;
        s.initializeGrid(nx, ny, nz, 0.01f, 0.01f, 0.01f, 0.0f, 0.0f, 0.0f);
        s.addBoxObject(1, 0.18f, 0.10f, 0.10f, 0.04f, 0.04f, 0.04f, 1.0f, 0, 0, 0, 0, 0,
                       1000.0f, 10.0e6f, 0.30f, 1.0e6f, 0.0f, 1.0f, 1.0e6f, 8);
        s.addBoxObject(2, 0.22f, 0.10f, 0.10f, 0.04f, 0.04f, 0.04f, -1.0f, 0, 0, 0, 0, 0,
                       1000.0f, 10.0e6f, 0.30f, 1.0e6f, 0.0f, 1.0f, 1.0e6f, 8);
        s.setInitialMultiMaterialSlotCapacity(256);
        s.setContactMethod(MPMContactMethod::MultiVelocityBardenhagen);
        s.setObjectMaterialMapping({0, 0, 1}, 2);
        s.syncToDevice();

        const size_t nodes = static_cast<size_t>(nx) * ny * nz;
        const size_t dense_expected = 10 * 2 * nodes * sizeof(float);
        const size_t compact_expected = 10 * 2 * 256 * sizeof(float) + nodes * sizeof(int);

        bool ok_initial = s.isCompactMultiMaterialStorageActive() && s.getMultiMaterialStorageBytes() == compact_expected;
        Blast::ZonalHandoff3DParams z{};
        z.enabled = true;
        s.setZonalHandoffParams(z);
        bool ok_zonal = !s.isCompactMultiMaterialStorageActive() && s.getMultiMaterialStorageBytes() == dense_expected;
        z.enabled = false;
        s.setZonalHandoffParams(z);
        bool ok_back = s.isCompactMultiMaterialStorageActive() && s.getMultiMaterialStorageBytes() == compact_expected;
        s.setCompactMultiMaterialStorage(false);
        bool ok_forced_dense = s.getMultiMaterialStorageBytes() == dense_expected;

        // A step after switching back must run cleanly in the compact layout
        s.setCompactMultiMaterialStorage(true);
        float dt = s.computeStepSize(0.3f);
        s.stepWithDt(dt, true);

        res.passed = ok_initial && ok_zonal && ok_back && ok_forced_dense;
        res.error_l2 = res.passed ? 0.0 : 1.0;
        res.error_linf = res.error_l2;
        std::ostringstream os;
        os << "Grid " << nx << " x " << ny << " x " << nz << ", dx = 0.01 m, Np = " << s.getParticleCount()
           << ", M = 2. Expected bytes: dense " << dense_expected << ", compact " << compact_expected
           << ". initial compact = " << ok_initial << ", zonal -> dense = " << ok_zonal
           << ", zonal off -> compact = " << ok_back << ", forced dense = " << ok_forced_dense
           << ", post-switch step dt = " << fmt(dt) << " s completed.";
        res.summary = res.passed ? "Layout selection follows zonal coupling and the user toggle; storage sizes match the analytical allocation formulas."
                                 : "Layout selection or storage size mismatch.";
        res.details = os.str();
    } catch (const std::exception& e) {
        res.passed = false;
        res.summary = std::string("FAILED with exception: ") + e.what();
    }
    return res;
}

} // namespace

std::vector<BenchmarkResult> run_mpm_compact_contact_benchmarks() {
    std::vector<BenchmarkResult> results;

    const float rho = 1000.0f, E = 10.0e6f, nu = 0.30f, sy = 1.0e6f, hard = 0.0f, eps_f = 1.0f, sig_t = 1.0e6f;

    results.push_back(run_layout_switch_check());

    // ---------------------------------------------------------------------------------------
    // 01: Head-on two-body impact and rebound, 2 materials, quadratic B-spline, Leapfrog
    // ---------------------------------------------------------------------------------------
    {
        ParityScenario sc;
        sc.id = "VV-L2-CMP-01";
        sc.title = "Compact Bardenhagen storage parity: head-on impact (B-spline, Leapfrog, M = 2)";
        sc.transfer = MPMTransferScheme::BSpline;
        sc.time_scheme = MPMTimeIntegrationScheme::Leapfrog;
        sc.num_materials = 2;
        sc.obj_to_mat = {0, 0, 1};
        sc.restitution = 0.8f;
        sc.steps = 150;
        sc.interface_x = 0.40f;
        sc.compact_initial_slots = 1024;
        sc.add_objects = [=](MPMSolver3DCUDA& s) {
            s.addBoxObject(1, 0.38f, 0.10f, 0.10f, 0.04f, 0.04f, 0.04f, 10.0f, 0, 0, 0, 0, 0,
                           rho, E, nu, sy, hard, eps_f, sig_t, 8);
            s.addBoxObject(2, 0.42f, 0.10f, 0.10f, 0.04f, 0.04f, 0.04f, -10.0f, 0, 0, 0, 0, 0,
                           rho, E, nu, sy, hard, eps_f, sig_t, 8);
        };
        results.push_back(run_parity_scenario(sc));
    }

    // ---------------------------------------------------------------------------------------
    // 02: Oblique frictional contact, 3 materials meeting on a plate, cubic B-spline, RK2
    //     (exercises sig_count = 3 nodes, Coulomb stick/slip branch and the cubic stencil)
    // ---------------------------------------------------------------------------------------
    {
        ParityScenario sc;
        sc.id = "VV-L2-CMP-02";
        sc.title = "Compact Bardenhagen storage parity: oblique frictional 3-body contact (cubic B-spline, RK2, M = 3)";
        sc.nx = 40; sc.ny = 20; sc.nz = 30;
        sc.transfer = MPMTransferScheme::CubicBSpline;
        sc.time_scheme = MPMTimeIntegrationScheme::RK2;
        sc.num_materials = 3;
        sc.obj_to_mat = {0, 0, 1, 2};
        sc.friction = 0.30f;
        sc.restitution = 0.0f;
        sc.steps = 120;
        sc.interface_x = 0.175f;   // gap between the two sliding blocks
        sc.compact_initial_slots = 1024;
        sc.v_ref = 4.0f;
        sc.add_objects = [=](MPMSolver3DCUDA& s) {
            // Plate (material 0), stationary
            s.addBoxObject(1, 0.20f, 0.10f, 0.06f, 0.36f, 0.16f, 0.04f, 0.0f, 0, 0, 0, 0, 0,
                           rho, E, nu, sy, hard, eps_f, sig_t, 8);
            // Block A (material 1) moving +x and down onto the plate
            s.addBoxObject(2, 0.15f, 0.10f, 0.105f, 0.04f, 0.04f, 0.04f, 4.0f, 0.0f, -4.0f, 0, 0, 0,
                           rho, E, nu, sy, hard, eps_f, sig_t, 8);
            // Block B (material 2) moving -x and down onto the plate, colliding with block A
            s.addBoxObject(3, 0.20f, 0.10f, 0.105f, 0.04f, 0.04f, 0.04f, -4.0f, 0.0f, -4.0f, 0, 0, 0,
                           rho, E, nu, sy, hard, eps_f, sig_t, 8);
        };
        results.push_back(run_parity_scenario(sc));
    }

    // ---------------------------------------------------------------------------------------
    // 03: Radial MLS stencil, many-to-one object->material mapping, forced slot regrowth
    // ---------------------------------------------------------------------------------------
    {
        ParityScenario sc;
        sc.id = "VV-L2-CMP-03";
        sc.title = "Compact Bardenhagen storage parity: radial MLS, 3 objects -> 2 materials, slot regrowth";
        sc.transfer = MPMTransferScheme::RadialMLS;
        sc.time_scheme = MPMTimeIntegrationScheme::Leapfrog;
        sc.num_materials = 2;
        sc.obj_to_mat = {0, 0, 0, 1};  // objects 1 and 2 share material 0 (welded), object 3 is material 1
        sc.restitution = 0.5f;
        sc.steps = 100;
        sc.interface_x = 0.40f;
        sc.compact_initial_slots = 16; // far below demand -> geometric regrowth inside P2G
        sc.add_objects = [=](MPMSolver3DCUDA& s) {
            s.addBoxObject(1, 0.34f, 0.10f, 0.10f, 0.04f, 0.04f, 0.04f, 8.0f, 0, 0, 0, 0, 0,
                           rho, E, nu, sy, hard, eps_f, sig_t, 8);
            s.addBoxObject(2, 0.38f, 0.10f, 0.10f, 0.04f, 0.04f, 0.04f, 8.0f, 0, 0, 0, 0, 0,
                           rho, E, nu, sy, hard, eps_f, sig_t, 8);
            s.addBoxObject(3, 0.42f, 0.10f, 0.10f, 0.04f, 0.04f, 0.04f, -8.0f, 0, 0, 0, 0, 0,
                           rho, E, nu, sy, hard, eps_f, sig_t, 8);
        };
        results.push_back(run_parity_scenario(sc));
    }

    // ---------------------------------------------------------------------------------------
    // 04: Millimeter-scale (dx = 2 mm) high-spin (2000 rad/s axial + 250 rad/s transverse)
    //     3D MPM steel collar: linear/angular momentum conservation & Cayley stress rotation
    // ---------------------------------------------------------------------------------------
    {
        BenchmarkResult res;
        res.id = "VV-L2-CMP-04";
        res.title = "Millimeter-scale high-spin (2000 rad/s) 3D MPM angular/linear momentum & Cayley stress conservation";
        res.level = 2;
        res.tolerance_linf = 5.0e-5;     // Cayley stress J2 invariant FP32 roundoff bound over 2000 steps
        res.tolerance_l2 = 1.0e-4;       // Relative angular momentum vector conservation |L(t) - L(0)| / |L(0)|
        res.tolerance_momentum = 1.0e-5; // Linear momentum drift |P(t) - P(0)| / sum(m |v_0|)
        res.tolerance_energy = 1.0e-3;   // Transverse spin rate bound max(|w_z(t)| - |w_z(0)|) / |w_x(0)|

        try {
            // 1. Direct orthogonal Cayley stress rotation invariant check under compound 3D spin
            float sig_c[3][3] = {{-400.0e6f, 50.0e6f, -30.0e6f},
                                 {  50.0e6f, 200.0e6f,  40.0e6f},
                                 { -30.0e6f,  40.0e6f, 200.0e6f}};
            const float W_c[3][3] = {{    0.0f,  1500.0f,  1200.0f},
                                     {-1500.0f,     0.0f, -2000.0f},
                                     {-1200.0f,  2000.0f,     0.0f}};
            auto calc_j2 = [](const float s[3][3]) -> double {
                double p = (s[0][0] + s[1][1] + s[2][2]) / 3.0;
                double j2 = 0.0;
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c) {
                        double dev = s[r][c] - (r == c ? p : 0.0);
                        j2 += 0.5 * dev * dev;
                    }
                return std::sqrt(j2);
            };
            const double j2_0 = calc_j2(sig_c);
            const double tr_0 = sig_c[0][0] + sig_c[1][1] + sig_c[2][2];
            for (int step = 0; step < 2000; ++step) {
                rotate_stress_cayley_3d(sig_c, W_c, 2.5e-7f, sig_c);
            }
            const double j2_end = calc_j2(sig_c);
            const double tr_end = sig_c[0][0] + sig_c[1][1] + sig_c[2][2];
            const double cayley_err = std::max(std::abs(j2_end - j2_0) / j2_0, std::abs(tr_end - tr_0) / j2_0);

            // 2. Genuine 3D MPM GPU simulation of a millimeter-scale spinning + pitching steel body
            MPMSolver3DCUDA s;
            const int nx = 32, ny = 32, nz = 32;
            const float dx = 0.002f; // 2 mm cells (particle mass ~ 7.85e-6 kg)
            s.initializeGrid(nx, ny, nz, dx, dx, dx, 0.0f, 0.0f, 0.0f);
            s.setTransferScheme(MPMTransferScheme::BSpline);
            s.setVelocityScheme(MPMVelocityScheme::APIC);
            s.setTimeScheme(MPMTimeIntegrationScheme::Leapfrog);

            const float cx0 = 0.032f, cy0 = 0.032f, cz0 = 0.032f;
            const float wx0 = 2000.0f, wy0 = 0.0f, wz0 = 250.0f;
            const float vx0 = 15.0f;
            s.addCylinderObject(1, cx0, cy0, cz0, 0.010f, 0.0f, 0.016f,
                                vx0, 0.0f, 0.0f, wx0, wy0, wz0,
                                7850.0f, 210.0e9f, 0.30f, 950.0e6f, 1.0e9f, 0.35f, 1.8e9f, 8);

            // Impose initial non-uniform residual stress on the particles to test stress-force conservation on fringe nodes
            auto& host_ps = s.getParticles();
            for (auto& p : host_ps) {
                float ry = p.x[1] - cy0;
                float rz = p.x[2] - cz0;
                p.sigma[0][0] = -150.0e6f;
                p.sigma[1][1] =  80.0e6f * (ry / 0.010f);
                p.sigma[2][2] =  80.0e6f * (rz / 0.010f);
                p.sigma[1][2] =  40.0e6f;
                p.sigma[2][1] =  40.0e6f;
            }
            s.setContactMethod(MPMContactMethod::MultiVelocityBardenhagen);
            s.setObjectMaterialMapping({0, 0}, 1);
            s.syncToDevice();

            auto measure_angular = [&](MPMSolver3DCUDA& solver, double& P_err, double& P_ref,
                                       double L_vec[3], double omega_est[3], int& failed_cnt) {
                solver.syncParticlesToHost();
                const auto& ps = solver.getParticles();
                double M = 0.0, cm[3] = {0, 0, 0}, P[3] = {0, 0, 0};
                P_ref = 0.0;
                failed_cnt = 0;
                for (const auto& p : ps) {
                    M += p.m;
                    for (int c = 0; c < 3; ++c) {
                        cm[c] += p.m * p.x[c];
                        P[c] += p.m * p.v[c];
                    }
                    P_ref += p.m * std::sqrt(p.v[0]*p.v[0] + p.v[1]*p.v[1] + p.v[2]*p.v[2]);
                    if (p.has_failed || p.damage >= 1.0f) failed_cnt++;
                }
                for (int c = 0; c < 3; ++c) cm[c] /= std::max(M, 1.0e-30);
                double vcm[3] = {P[0] / M, P[1] / M, P[2] / M};
                P_err = std::sqrt((P[0] - M * vx0)*(P[0] - M * vx0) + P[1]*P[1] + P[2]*P[2]) / std::max(P_ref, 1.0e-30);

                // Total APIC angular momentum L = sum_p m_p [ (x_p - x_cm) x (v_p - v_cm) + eps_{ijk} (B_p * D_p)_{kj} ]
                // For quadratic B-spline, D_p = (1/4) dx^2 I, so C_p * D_p = B_p * (1/4 dx^2)
                const double dp_inertia = 0.25 * dx * dx;
                L_vec[0] = L_vec[1] = L_vec[2] = 0.0;
                double Ixx = 0.0, Izz = 0.0;
                for (const auto& p : ps) {
                    double rx = p.x[0] - cm[0], ry = p.x[1] - cm[1], rz = p.x[2] - cm[2];
                    double ux = p.v[0] - vcm[0], uy = p.v[1] - vcm[1], uz = p.v[2] - vcm[2];
                    L_vec[0] += p.m * ((ry * uz - rz * uy) + dp_inertia * (p.B[2][1] - p.B[1][2]));
                    L_vec[1] += p.m * ((rz * ux - rx * uz) + dp_inertia * (p.B[0][2] - p.B[2][0]));
                    L_vec[2] += p.m * ((rx * uy - ry * ux) + dp_inertia * (p.B[1][0] - p.B[0][1]));
                    Ixx += p.m * (ry * ry + rz * rz + 2.0 * dp_inertia);
                    Izz += p.m * (rx * rx + ry * ry + 2.0 * dp_inertia);
                }
                omega_est[0] = L_vec[0] / std::max(Ixx, 1.0e-30);
                omega_est[1] = L_vec[1] / std::max(Izz, 1.0e-30);
                omega_est[2] = L_vec[2] / std::max(Izz, 1.0e-30);
            };

            double P_err0 = 0.0, P_ref0 = 0.0, L0[3] = {0, 0, 0}, w0[3] = {0, 0, 0};
            int fail0 = 0;
            measure_angular(s, P_err0, P_ref0, L0, w0, fail0);
            const double L0_mag = std::sqrt(L0[0]*L0[0] + L0[1]*L0[1] + L0[2]*L0[2]);

            const int n_steps = 200;
            const float dt = 1.0e-7f;
            std::vector<double> t_hist, l_ref_hist, l_num_hist;
            double max_wz_excess = 0.0;
            for (int step = 1; step <= n_steps; ++step) {
                s.stepWithDt(dt, true);
                if (step % 20 == 0 || step == n_steps) {
                    double P_err = 0.0, P_ref = 0.0, Lt[3] = {0, 0, 0}, wt[3] = {0, 0, 0};
                    int fail_t = 0;
                    measure_angular(s, P_err, P_ref, Lt, wt, fail_t);
                    double Lt_mag = std::sqrt(Lt[0]*Lt[0] + Lt[1]*Lt[1] + Lt[2]*Lt[2]);
                    t_hist.push_back(step * dt * 1.0e6);
                    l_ref_hist.push_back(L0_mag);
                    l_num_hist.push_back(Lt_mag);
                    double wz_perp = std::sqrt(wt[1]*wt[1] + wt[2]*wt[2]);
                    double wz0_perp = std::sqrt(w0[1]*w0[1] + w0[2]*w0[2]);
                    max_wz_excess = std::max(max_wz_excess, std::max(0.0, wz_perp - wz0_perp) / wx0);
                }
            }

            double P_err_end = 0.0, P_ref_end = 0.0, L_end[3] = {0, 0, 0}, w_end[3] = {0, 0, 0};
            int fail_end = 0;
            measure_angular(s, P_err_end, P_ref_end, L_end, w_end, fail_end);
            const double dL_vec = std::sqrt((L_end[0] - L0[0])*(L_end[0] - L0[0]) +
                                            (L_end[1] - L0[1])*(L_end[1] - L0[1]) +
                                            (L_end[2] - L0[2])*(L_end[2] - L0[2])) / std::max(L0_mag, 1.0e-30);

            // 3. Partially damaged post-impact remnant check (intact core + failed outer jacket under compressive stress)
            // Verifies that intact/failed interfaces do not create a hybrid APIC/FLIP momentum ratchet or runaway spin-up.
            MPMSolver3DCUDA s_dmg;
            s_dmg.initializeGrid(nx, ny, nz, dx, dx, dx, 0.0f, 0.0f, 0.0f);
            s_dmg.setTransferScheme(MPMTransferScheme::BSpline);
            s_dmg.setVelocityScheme(MPMVelocityScheme::APIC);
            s_dmg.setTimeScheme(MPMTimeIntegrationScheme::Leapfrog);
            s_dmg.addCylinderObject(1, cx0, cy0, cz0, 0.010f, 0.0f, 0.016f,
                                    vx0, -5.0f, 8.0f, 500.0f, -200.0f, 750.0f,
                                    7850.0f, 210.0e9f, 0.30f, 950.0e6f, 1.0e9f, 0.35f, 1.8e9f, 8);
            auto& dmg_ps = s_dmg.getParticles();
            for (auto& p : dmg_ps) {
                float ry = p.x[1] - cy0;
                float rz = p.x[2] - cz0;
                float r_cyl = std::sqrt(ry * ry + rz * rz);
                p.sigma[0][0] = -120.0e6f;
                p.sigma[1][1] = -120.0e6f;
                p.sigma[2][2] = -120.0e6f;
                if (r_cyl > 0.007f) {
                    p.damage = 1.0f;
                    p.has_failed = 1;
                }
            }
            s_dmg.setContactMethod(MPMContactMethod::MultiVelocityBardenhagen);
            s_dmg.setObjectMaterialMapping({0, 0}, 1);
            s_dmg.syncToDevice();

            double P_dmg0 = 0.0, Pref_dmg0 = 0.0, L_dmg0[3] = {0, 0, 0}, w_dmg0[3] = {0, 0, 0};
            int fail_dmg0 = 0;
            measure_angular(s_dmg, P_dmg0, Pref_dmg0, L_dmg0, w_dmg0, fail_dmg0);
            for (int step = 1; step <= n_steps; ++step) {
                s_dmg.stepWithDt(dt, true);
            }
            s_dmg.syncParticlesToHost();
            const auto& ps_dmg_end = s_dmg.getParticles();
            double M_dmg = 0.0, P_dmg_vec[3] = {0, 0, 0};
            for (const auto& p : ps_dmg_end) {
                M_dmg += p.m;
                for (int c = 0; c < 3; ++c) P_dmg_vec[c] += p.m * p.v[c];
            }
            double P_dmg_drift = std::sqrt(
                (P_dmg_vec[0] - M_dmg * vx0) * (P_dmg_vec[0] - M_dmg * vx0) +
                (P_dmg_vec[1] - M_dmg * (-5.0)) * (P_dmg_vec[1] - M_dmg * (-5.0)) +
                (P_dmg_vec[2] - M_dmg * 8.0) * (P_dmg_vec[2] - M_dmg * 8.0)) / std::max(Pref_dmg0, 1.0e-30);
            double dummy_pe = 0.0, dummy_pr = 0.0, L_dmg_end[3] = {0, 0, 0}, w_dmg_end[3] = {0, 0, 0};
            int fail_dmg_end = 0;
            measure_angular(s_dmg, dummy_pe, dummy_pr, L_dmg_end, w_dmg_end, fail_dmg_end);
            double w_dmg0_mag = std::sqrt(w_dmg0[0]*w_dmg0[0] + w_dmg0[1]*w_dmg0[1] + w_dmg0[2]*w_dmg0[2]);
            double w_dmg_end_mag = std::sqrt(w_dmg_end[0]*w_dmg_end[0] + w_dmg_end[1]*w_dmg_end[1] + w_dmg_end[2]*w_dmg_end[2]);
            double dmg_spinup_excess = std::max(0.0, w_dmg_end_mag - w_dmg0_mag) / std::max(w_dmg0_mag, 1.0e-30);

            res.error_linf = cayley_err;
            res.error_l2 = dL_vec;
            res.momentum_drift = std::max(P_err_end, P_dmg_drift);
            res.energy_drift = std::max(max_wz_excess, dmg_spinup_excess);
            res.passed = (res.error_linf <= res.tolerance_linf) &&
                         (res.error_l2 <= res.tolerance_l2) &&
                         (res.momentum_drift <= res.tolerance_momentum) &&
                         (res.energy_drift <= res.tolerance_energy) &&
                         (fail_end == 0);

            std::string svg_file = "vv_mpm_cmp_04_high_spin_angular_momentum.svg";
            generate_svg_plot(svg_file,
                              "VV-L2-CMP-04: High-Spin (2000 rad/s) 3D MPM Total Angular Momentum |L(t)|",
                              "Time (us)", "|L| (kg m^2 / s)", t_hist, l_ref_hist, l_num_hist, 1.0, 5.0);
            res.svg_path = svg_file;

            std::ostringstream sum;
            sum << "High-spin (wx = 2000 rad/s, wz = 250 rad/s, dx = 2 mm) 3D MPM conservation: "
                << "Cayley stress invariant error = " << fmt(cayley_err)
                << ", angular momentum vector error |L(t)-L(0)|/|L(0)| = " << fmt(dL_vec)
                << ", linear momentum drift = " << fmt(res.momentum_drift)
                << ", spin-up / transverse excess = " << fmt(res.energy_drift)
                << ", intact fractured particles = " << fail_end << ".";
            res.summary = sum.str();

            std::ostringstream det;
            det << "Discretisation: grid " << nx << " x " << ny << " x " << nz
                << ", dx = dy = dz = " << dx << " m, Np = " << s.getParticleCount()
                << ", steps = " << n_steps << ", dt = " << fmt(dt) << " s. "
                << "Intact w(0) = (" << w0[0] << ", " << w0[1] << ", " << w0[2] << ") rad/s -> "
                << "w(t) = (" << w_end[0] << ", " << w_end[1] << ", " << w_end[2] << ") rad/s. "
                << "Partially-damaged remnant |w(0)| = " << w_dmg0_mag << " rad/s -> |w(t)| = " << w_dmg_end_mag << " rad/s.";
            res.details = det.str();
        } catch (const std::exception& e) {
            res.passed = false;
            res.summary = std::string("FAILED with exception: ") + e.what();
        }
        results.push_back(res);
    }

    return results;
}

} // namespace Blast::VV
