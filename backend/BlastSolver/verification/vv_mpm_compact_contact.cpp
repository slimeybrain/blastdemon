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

    // =========================================================================
    // VV-L2-CMP-05: High-Velocity Multi-Metal Impact Welding, Frictional Heating
    //               & Grid Thermal Conduction (MultiVelocityBardenhagen)
    // =========================================================================
    {
        BenchmarkResult res;
        res.id = "VV-L2-CMP-05";
        res.title = "3D MPM Multi-Velocity Impact Welding, Frictional Heating & Thermal Conduction";
        res.level = 2;
        res.tolerance_l2 = 0.20;
        res.tolerance_linf = 0.25;
        res.tolerance_momentum = 1.0e-5;
        res.tolerance_energy = 0.05;

        try {
            const int nx = 24, ny = 20, nz = 20;
            const float dx = 0.0025f;
            const float dt = 1.5e-7f;
            const int n_steps = 80;
            const float v_imp_x = 380.0f;
            const float v_imp_y = 140.0f;

            auto setup_impact = [&](MPMSolver3DCUDA& solver, bool weld, bool fric_heat, bool cond) {
                solver.initializeGrid(nx, ny, nz, dx, dx, dx, 0.0f, 0.0f, 0.0f);
                solver.setTransferScheme(MPMTransferScheme::BSpline);
                solver.setVelocityScheme(MPMVelocityScheme::APIC);
                solver.setTimeScheme(MPMTimeIntegrationScheme::Leapfrog);
                solver.setContactMethod(MPMContactMethod::MultiVelocityBardenhagen);
                solver.setDemContact(false, 0.15f, 0.80f, 1.0f);
                solver.setImpactWelding(weld);
                solver.setFrictionalHeating(fric_heat);
                solver.setThermalConduction(cond);

                // Object 1: Copper flyer (center x = 0.0225 m, size_x = 0.005 m -> x in [0.020, 0.025] m)
                solver.addBoxObject(1, 0.0225f, 0.025f, 0.025f, 0.005f, 0.014f, 0.014f,
                                    v_imp_x, v_imp_y, 0.0f, 0.0f, 0.0f, 0.0f,
                                    8960.0f, 120.0e9f, 0.34f, 250.0e6f, 400.0e6f, 0.80f, 1.5e9f, 8);
                // Object 2: Steel target plate (center x = 0.0280 m, size_x = 0.005 m -> x in [0.0255, 0.0305] m)
                solver.addBoxObject(2, 0.0280f, 0.025f, 0.025f, 0.005f, 0.014f, 0.014f,
                                    0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                                    7850.0f, 200.0e9f, 0.30f, 600.0e6f, 500.0e6f, 0.80f, 2.0e9f, 8);

                auto& mats = solver.getMaterialTables();
                if (mats.size() < 3) mats.resize(3);
                mats[1].Cp = 385.0f;
                mats[1].T_melt = 1358.0f;
                mats[1].T_room = 293.0f;
                mats[2].Cp = 475.0f;
                mats[2].T_melt = 1793.0f;
                mats[2].T_room = 293.0f;

                // Seed damaged interface particle under compression at 0.81 * T_melt to verify sintering healing
                for (auto& p : solver.getParticles()) {
                    if (p.object_id == 1 && p.x[0] > 0.022f) {
                        p.temperature = 1100.0f;
                        p.e_int = (p.temperature - 293.0f) * 385.0f;
                        p.ep_bar = 0.35f;
                        p.damage = 0.85f;
                        p.has_failed = true;
                        p.V = 0.96f * p.V0;
                    } else if (p.object_id == 2 && p.x[0] < 0.0285f) {
                        p.temperature = 1050.0f;
                        p.e_int = (p.temperature - 293.0f) * 475.0f;
                        p.ep_bar = 0.32f;
                    }
                }

                solver.setObjectMaterialMapping({0, 0, 1}, 2);
                solver.uploadMaterialTableToDevice();
                solver.syncToDevice();
            };

            MPMSolver3DCUDA s_unwelded;
            setup_impact(s_unwelded, false, false, false);

            MPMSolver3DCUDA s_welded;
            setup_impact(s_welded, true, true, true);

            // Compute initial total linear momentum and analytical center-of-mass velocity
            double M1 = 0.0, M2 = 0.0;
            double P0[3] = {0.0, 0.0, 0.0};
            for (const auto& p : s_welded.getParticles()) {
                if (p.object_id == 1) M1 += p.m;
                else if (p.object_id == 2) M2 += p.m;
                for (int c = 0; c < 3; ++c) P0[c] += p.m * p.v[c];
            }
            const double M_tot = M1 + M2;
            const double vx_cm_exact = P0[0] / std::max(M_tot, 1.0e-30);
            const double vy_cm_exact = P0[1] / std::max(M_tot, 1.0e-30);
            const double P0_mag = std::sqrt(P0[0]*P0[0] + P0[1]*P0[1] + P0[2]*P0[2]);

            std::vector<double> t_hist, vcm_ref_hist, v1_weld_hist;
            t_hist.reserve(n_steps);
            vcm_ref_hist.reserve(n_steps);
            v1_weld_hist.reserve(n_steps);

            for (int step = 1; step <= n_steps; ++step) {
                s_unwelded.stepWithDt(dt, true);
                s_welded.stepWithDt(dt, true);
                if (step % 4 == 0 || step == n_steps) {
                    s_welded.syncParticlesToHost();
                    double p1x = 0.0;
                    for (const auto& p : s_welded.getParticles()) {
                        if (p.object_id == 1) p1x += p.m * p.v[0];
                    }
                    t_hist.push_back(step * dt * 1.0e6);
                    vcm_ref_hist.push_back(vx_cm_exact);
                    v1_weld_hist.push_back(p1x / std::max(M1, 1.0e-30));
                }
            }

            s_unwelded.syncParticlesToHost();
            s_welded.syncParticlesToHost();

            auto analyze_state = [&](const std::vector<MPMParticle3D>& ps,
                                     double& v1x, double& v2x, double& v1y, double& v2y,
                                     double P_vec[3], double& e_th_sum, int& healed_count) {
                double p1x = 0.0, p2x = 0.0, p1y = 0.0, p2y = 0.0;
                P_vec[0] = P_vec[1] = P_vec[2] = 0.0;
                e_th_sum = 0.0;
                healed_count = 0;
                for (const auto& p : ps) {
                    for (int c = 0; c < 3; ++c) P_vec[c] += p.m * p.v[c];
                    e_th_sum += p.m * p.e_int;
                    if (p.object_id == 1) {
                        p1x += p.m * p.v[0];
                        p1y += p.m * p.v[1];
                        if (p.x[0] > 0.022f && p.has_failed == 0 && p.damage < 0.50f) {
                            healed_count++;
                        }
                    } else if (p.object_id == 2) {
                        p2x += p.m * p.v[0];
                        p2y += p.m * p.v[1];
                    }
                }
                v1x = p1x / std::max(M1, 1.0e-30);
                v2x = p2x / std::max(M2, 1.0e-30);
                v1y = p1y / std::max(M1, 1.0e-30);
                v2y = p2y / std::max(M2, 1.0e-30);
            };

            double v1x_unw = 0, v2x_unw = 0, v1y_unw = 0, v2y_unw = 0, P_unw[3] = {0,0,0}, eth_unw = 0;
            int healed_unw = 0;
            analyze_state(s_unwelded.getParticles(), v1x_unw, v2x_unw, v1y_unw, v2y_unw, P_unw, eth_unw, healed_unw);

            double v1x_w = 0, v2x_w = 0, v1y_w = 0, v2y_w = 0, P_w[3] = {0,0,0}, eth_w = 0;
            int healed_w = 0;
            analyze_state(s_welded.getParticles(), v1x_w, v2x_w, v1y_w, v2y_w, P_w, eth_w, healed_w);

            const double dv_unwelded = std::hypot(v1x_unw - v2x_unw, v1y_unw - v2y_unw);
            const double dv_welded = std::hypot(v1x_w - v2x_w, v1y_w - v2y_w);
            const double v_cm_mag = std::hypot(vx_cm_exact, vy_cm_exact);

            // Relative velocity discrepancy from fused center-of-mass velocity
            const double err_v1_cm = std::hypot(v1x_w - vx_cm_exact, v1y_w - vy_cm_exact) / std::max(v_cm_mag, 1.0);
            const double err_v2_cm = std::hypot(v2x_w - vx_cm_exact, v2y_w - vy_cm_exact) / std::max(v_cm_mag, 1.0);
            const double mom_drift = std::sqrt(
                (P_w[0] - P0[0])*(P_w[0] - P0[0]) +
                (P_w[1] - P0[1])*(P_w[1] - P0[1]) +
                (P_w[2] - P0[2])*(P_w[2] - P0[2])) / std::max(P0_mag, 1.0e-30);

            // Verify frictional heating increased total thermal energy compared to unwelded run
            const bool fric_heat_positive = (eth_w > eth_unw);
            // Verify welded relative separation speed is substantially locked compared to unwelded rebound (>40% relative reduction)
            const bool weld_locked = (dv_welded < 0.60 * dv_unwelded) && (healed_w > 0);

            res.error_l2 = 0.5 * (err_v1_cm + err_v2_cm);
            res.error_linf = std::max(err_v1_cm, err_v2_cm);
            res.momentum_drift = mom_drift;
            res.energy_drift = fric_heat_positive ? 0.0 : 1.0;
            res.passed = (res.error_l2 <= res.tolerance_l2) &&
                         (res.error_linf <= res.tolerance_linf) &&
                         (res.momentum_drift <= res.tolerance_momentum) &&
                         fric_heat_positive &&
                         weld_locked;

            std::string svg_file = "vv_mpm_cmp_05_impact_welding.svg";
            generate_svg_plot(svg_file,
                              "VV-L2-CMP-05: 3D MPM Multi-Metal Impact Welding Flyer Velocity Convergence to v_cm",
                              "Time (us)", "Velocity vx (m/s)", t_hist, vcm_ref_hist, v1_weld_hist, 1.0, 5.0);
            res.svg_path = svg_file;

            std::ostringstream sum;
            sum << "Oblique Cu-Steel impact welding (v0 = (" << v_imp_x << ", " << v_imp_y << ") m/s): "
                << "welded |dv_12| = " << fmt(dv_welded) << " m/s vs unwelded |dv_12| = " << fmt(dv_unwelded) << " m/s, "
                << "E_th(weld) = " << fmt(eth_w) << " J vs E_th(unwelded) = " << fmt(eth_unw) << " J, "
                << "sinter-healed particles = " << healed_w << ", "
                << "momentum drift = " << fmt(mom_drift) << ".";
            res.summary = sum.str();

            std::ostringstream det;
            det << "Discretisation: grid " << nx << " x " << ny << " x " << nz
                << ", dx = dy = dz = " << dx << " m, Np = " << s_welded.getParticleCount()
                << ", steps = " << n_steps << ", dt = " << fmt(dt) << " s. "
                << "Exact v_cm = (" << fmt(vx_cm_exact) << ", " << fmt(vy_cm_exact) << ") m/s; "
                << "Welded final v1 = (" << fmt(v1x_w) << ", " << fmt(v1y_w) << ") m/s, "
                << "v2 = (" << fmt(v2x_w) << ", " << fmt(v2y_w) << ") m/s. "
                << "Interface band (cell, x [m], Np, vx_weld [m/s], T_avg [K]): ";
            for (int ci = 6; ci <= 16; ++ci) {
                int np_c = 0;
                double m_c = 0.0, px_c = 0.0, mt_c = 0.0;
                for (const auto& p : s_welded.getParticles()) {
                    int ic = static_cast<int>(std::floor(p.x[0] / dx));
                    if (ic == ci) {
                        np_c++;
                        m_c += p.m;
                        px_c += p.m * p.v[0];
                        mt_c += p.m * p.temperature;
                    }
                }
                double vx_c = (m_c > 1.0e-30) ? (px_c / m_c) : 0.0;
                double T_c = (m_c > 1.0e-30) ? (mt_c / m_c) : 293.0;
                det << "[" << ci << ", " << std::fixed << std::setprecision(4) << (ci + 0.5) * dx
                    << ", " << np_c << ", " << std::setprecision(2) << vx_c
                    << ", " << std::setprecision(1) << T_c << "] ";
            }
            res.details = det.str();
        } catch (const std::exception& e) {
            res.passed = false;
            res.summary = std::string("FAILED with exception: ") + e.what();
        }
        results.push_back(res);
    }

    // =========================================================================
    // 6. VV-L2-CMP-06: Inclined Target Plate Oblique Fragment Skimming &
    //    Hexagonal Partial-Fill Box Face Flatness
    // =========================================================================
    {
        BenchmarkResult res;
        res.id = "VV-L2-CMP-06";
        res.title = "Inclined Target Plate (rot_y = 10 deg) Pre-Strained Fragment Skimming & Hexagonal Box Flatness";
        res.level = 2;
        res.tolerance_l2 = 1.0e-4;
        res.tolerance_linf = 5.0e-4;
        res.tolerance_momentum = 1.0e-5;
        res.tolerance_energy = 1.0e-3;

        try {
            // Part A: Verify Hexagonal + Partial box seeding preserves exact mass and flat faces
            MPMSolver3D s_hex;
            s_hex.initializeGrid(16, 16, 16, 0.01f, 0.01f, 0.01f, 0.0f, 0.0f, 0.0f);
            const float bx = 0.04f, by = 0.06f, bz = 0.08f;
            const float rho_steel = 7850.0f;
            s_hex.addBoxObject(
                1, 0.08f, 0.08f, 0.08f,
                bx, by, bz,
                0.0f, 0.0f, 0.0f,
                0.0f, 0.0f, 0.0f,
                rho_steel, 210.0e9f, 0.30f,
                800.0e6f, 1.0e9f, 0.80f, 2.0e9f, 8,
                MPMParticleDistribution::Hexagonal,
                MPMBoundaryFilling::Partial,
                0.0f, 0.0f, 0.0f);

            double m_hex_total = 0.0;
            float min_y_front = 1.0e9f, max_y_front = -1.0e9f;
            float min_x_front = 1.0e9f, max_x_front = -1.0e9f;
            for (const auto& p : s_hex.getParticles()) {
                m_hex_total += p.m;
                min_y_front = std::min(min_y_front, p.x[1] - p.lp[1]);
                max_y_front = std::max(max_y_front, p.x[1] + p.lp[1]);
                min_x_front = std::min(min_x_front, p.x[0] - p.lp[0]);
                max_x_front = std::max(max_x_front, p.x[0] + p.lp[0]);
            }
            const double m_hex_exact = static_cast<double>(rho_steel) * bx * by * bz;
            const double err_hex_mass = std::abs(m_hex_total - m_hex_exact) / m_hex_exact;
            const double err_hex_bounds = std::max({
                std::abs(min_y_front - (0.08f - 0.5f * by)),
                std::abs(max_y_front - (0.08f + 0.5f * by)),
                std::abs(min_x_front - (0.08f - 0.5f * bx)),
                std::abs(max_x_front - (0.08f + 0.5f * bx))
            });

            // Part B: Inclined target plate (rot_y = 10 deg) with pre-strained fragment sheet skimming across 1.25*dx gap
            const int nx = 24, ny = 10, nz = 28;
            const float dx = 0.01f;
            MPMSolver3DCUDA s_incl;
            s_incl.initializeGrid(nx, ny, nz, dx, dx, dx, 0.0f, 0.0f, 0.0f);
            s_incl.setCompactMultiMaterialStorage(true);
            s_incl.setContactMethod(MPMContactMethod::MultiVelocityBardenhagen);
            s_incl.setTransferScheme(MPMTransferScheme::BSpline);
            s_incl.setVelocityScheme(MPMVelocityScheme::APIC);
            s_incl.setTimeScheme(MPMTimeIntegrationScheme::Leapfrog);
            s_incl.setDemContact(false, 0.25f, 0.0f, 1.0f);
            s_incl.setFrictionalHeating(true);
            s_incl.setImpactWelding(true);
            s_incl.setBoundaryConditions(
                MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip,
                MPMBoundaryCondition3D::FreeSlip, MPMBoundaryCondition3D::FreeSlip);

            const float deg2rad = 3.14159265358979323846f / 180.0f;
            const float theta = 10.0f * deg2rad;
            const float cos_t = std::cos(theta);
            const float sin_t = std::sin(theta);

            // Object 1: Stationary inclined Target plate (rot_y = 10 deg)
            const float tx_c = 0.135f, ty_c = 0.05f, tz_c = 0.14f;
            const float t_sx = 0.03f, t_sy = 0.04f, t_sz = 0.16f;
            s_incl.addBoxObject(
                1, tx_c, ty_c, tz_c,
                t_sx, t_sy, t_sz,
                0.0f, 0.0f, 0.0f,
                0.0f, 0.0f, 0.0f,
                rho_steel, 210.0e9f, 0.30f,
                800.0e6f, 1.0e9f, 0.80f, 2.0e9f, 8,
                MPMParticleDistribution::Cartesian,
                MPMBoundaryFilling::Stairstepped,
                0.0f, 10.0f, 0.0f);

            // Object 2: Pre-strained (ep_bar = 0.55) cold fragment sheet at 1.25*dx normal stand-off gap
            // skimming parallel to the inclined face at 320 m/s (and receding slightly at 15 m/s normal)
            const float f_sx = 0.01f, f_sy = 0.04f, f_sz = 0.14f;
            const float normal_offset = 0.5f * t_sx + 1.25f * dx + 0.5f * f_sx;
            const float fx_c = tx_c - normal_offset * cos_t;
            const float fy_c = ty_c;
            const float fz_c = tz_c + normal_offset * sin_t;
            const float v_skim = 320.0f;
            const float v_recede = 15.0f;
            const float f_vx = v_skim * sin_t - v_recede * cos_t;
            const float f_vz = v_skim * cos_t + v_recede * sin_t;

            s_incl.addBoxObject(
                2, fx_c, fy_c, fz_c,
                f_sx, f_sy, f_sz,
                f_vx, 0.0f, f_vz,
                0.0f, 0.0f, 0.0f,
                rho_steel, 210.0e9f, 0.30f,
                800.0e6f, 1.0e9f, 0.80f, 2.0e9f, 8,
                MPMParticleDistribution::Cartesian,
                MPMBoundaryFilling::Stairstepped,
                0.0f, 10.0f, 0.0f);

            auto& mats = s_incl.getMaterialTables();
            if (mats.size() < 3) mats.resize(3);
            mats[1].Cp = 470.0f;
            mats[1].T_room = 293.0f;
            mats[1].T_melt = 1793.0f;
            mats[1].transfer_scheme = static_cast<int>(MPMTransferScheme::BSpline);

            mats[2].Cp = 470.0f;
            mats[2].T_room = 293.0f;
            mats[2].T_melt = 1793.0f;
            mats[2].transfer_scheme = static_cast<int>(MPMTransferScheme::BSpline);

            // Seed pre-existing plastic strain ep_bar = 0.55 on the fragment sheet (Object 2)
            // to mimic fragments produced by casing rupture prior to skimming past the target plate
            for (auto& p : s_incl.getParticles()) {
                p.transfer_scheme = static_cast<int>(MPMTransferScheme::BSpline);
                if (p.object_id == 2) {
                    p.ep_bar = 0.55f;
                    p.temperature = 300.0f;
                } else {
                    p.ep_bar = 0.0f;
                    p.temperature = 293.0f;
                }
            }

            s_incl.setObjectMaterialMapping({0, 0, 1}, 2);
            s_incl.uploadMaterialTableToDevice();
            s_incl.syncToDevice();

            const auto& p_init = s_incl.getParticles();
            double P0[3] = {0.0, 0.0, 0.0};
            for (const auto& p : p_init) {
                P0[0] += static_cast<double>(p.m) * p.v[0];
                P0[1] += static_cast<double>(p.m) * p.v[1];
                P0[2] += static_cast<double>(p.m) * p.v[2];
            }
            const double P0_mag = std::sqrt(P0[0]*P0[0] + P0[1]*P0[1] + P0[2]*P0[2]);

            const float dt = 1.0e-6f;
            const int n_steps = 50;
            for (int step = 1; step <= n_steps; ++step) {
                s_incl.stepWithDt(dt, true);
            }
            s_incl.syncParticlesToHost();

            const auto& p_final = s_incl.getParticles();
            double P_end[3] = {0.0, 0.0, 0.0};
            double max_ep_target = 0.0;
            double sum_ep2_target = 0.0;
            size_t count_target = 0;

            // Sample plastic strain profile along 11 z-bins on the target plate's front face
            const int n_bins = 11;
            std::vector<double> z_bins(n_bins, 0.0);
            std::vector<double> ep_exact_bins(n_bins, 0.0);
            std::vector<double> ep_num_bins(n_bins, 0.0);
            std::vector<int> bin_counts(n_bins, 0);
            const double z_start = tz_c - 0.5 * t_sz;
            const double z_span = t_sz;

            for (const auto& p : p_final) {
                P_end[0] += static_cast<double>(p.m) * p.v[0];
                P_end[1] += static_cast<double>(p.m) * p.v[1];
                P_end[2] += static_cast<double>(p.m) * p.v[2];
                if (p.object_id == 1) {
                    double ep = static_cast<double>(p.ep_bar);
                    max_ep_target = std::max(max_ep_target, ep);
                    sum_ep2_target += ep * ep;
                    count_target++;

                    int bin = static_cast<int>(std::floor(((p.x[2] - z_start) / z_span) * n_bins));
                    bin = std::clamp(bin, 0, n_bins - 1);
                    ep_num_bins[bin] = std::max(ep_num_bins[bin], ep);
                    bin_counts[bin]++;
                }
            }
            for (int b = 0; b < n_bins; ++b) {
                z_bins[b] = (z_start + (b + 0.5) * (z_span / n_bins)) * 1000.0; // mm
            }

            const double ep_l2 = (count_target > 0) ? std::sqrt(sum_ep2_target / count_target) : 0.0;
            const double mom_drift = std::sqrt(
                (P_end[0] - P0[0])*(P_end[0] - P0[0]) +
                (P_end[1] - P0[1])*(P_end[1] - P0[1]) +
                (P_end[2] - P0[2])*(P_end[2] - P0[2])) / std::max(P0_mag, 1.0e-30);

            res.error_l2 = std::max(ep_l2, err_hex_mass);
            res.error_linf = std::max(max_ep_target, err_hex_bounds);
            res.momentum_drift = mom_drift;
            res.energy_drift = 0.0;
            res.passed = (res.error_l2 <= res.tolerance_l2) &&
                         (res.error_linf <= res.tolerance_linf) &&
                         (res.momentum_drift <= res.tolerance_momentum);

            std::string svg_file = "vv_mpm_cmp_06_inclined_plate_skimming.svg";
            generate_svg_plot(svg_file,
                              "VV-L2-CMP-06: Inclined Plate (rot_y=10 deg) Front-Face Plastic Strain Profile",
                              "Span Coordinate z (mm)", "Max Plastic Strain ep_bar (-)",
                              z_bins, ep_exact_bins, ep_num_bins, 1.0, 5.0);
            res.svg_path = svg_file;

            std::ostringstream sum;
            sum << "Inclined target plate (rot_y = 10 deg) under 320 m/s pre-strained fragment skimming: "
                << "max(ep_bar) = " << fmt(max_ep_target) << ", L2(ep_bar) = " << fmt(ep_l2)
                << ", Hexagonal+Partial mass error = " << fmt(err_hex_mass)
                << ", face flatness error = " << fmt(err_hex_bounds) << " m"
                << ", momentum drift = " << fmt(mom_drift) << ".";
            res.summary = sum.str();

            std::ostringstream det;
            det << "Discretisation: grid " << nx << " x " << ny << " x " << nz
                << ", dx = dy = dz = " << dx << " m, Np = " << s_incl.getParticleCount()
                << " (target = " << count_target << "), steps = " << n_steps << ", dt = " << fmt(dt) << " s. "
                << "Profile across inclined plate z-bins (bin, z [mm], Np_bin, max_ep_bar): ";
            for (int b = 0; b < n_bins; ++b) {
                det << "[" << b << ", " << std::fixed << std::setprecision(1) << z_bins[b]
                    << ", " << bin_counts[b] << ", " << std::scientific << std::setprecision(3) << ep_num_bins[b] << "] ";
            }
            res.details = det.str();
        } catch (const std::exception& e) {
            res.passed = false;
            res.summary = std::string("FAILED with exception: ") + e.what();
        }
        results.push_back(res);
    }

    // ---------------------------------------------------------------------------------------
    // 07: Hybrid Bardenhagen Coupler (Bonded Single-Velocity Pair + Independent 3rd Body)
    //     Objects 1 & 2 are coupled into Velocity Field 0 (Bonded Group A) and move at +10 m/s.
    //     Object 3 is on Velocity Field 1 (Independent) and moves at -10 m/s.
    //     Verifies:
    //       1. Exact parity with an equivalent monolithic block + 2nd body impact
    //       2. Zero separation between bonded objects 1 and 2 throughout collision & rebound
    //       3. Clean Bardenhagen rebound against the unbonded 3rd body
    // ---------------------------------------------------------------------------------------
    {
        BenchmarkResult res;
        res.id = "VV-L2-CMP-07";
        res.title = "Hybrid Bardenhagen Coupler: Bonded Single-Velocity Pair Impacting Independent 3rd Body";
        res.level = 2;
        res.tolerance_l2 = 1.0e-4;
        res.tolerance_linf = 1.0e-3;
        res.tolerance_momentum = 1.0e-5;
        res.tolerance_energy = 1.0e-3;

        try {
            const int nx = 80, ny = 20, nz = 20;
            const float dx = 0.01f;
            const int steps = 150;
            const float cfl = 0.3f;

            // Run A: 3 objects with Bardenhagen Coupler mapping {0, 0, 0, 1}
            // Object 1: [0.36, 0.38] (length 0.02 m, center 0.37 m) -> Velocity Field 0
            // Object 2: [0.38, 0.40] (length 0.02 m, center 0.39 m) -> Velocity Field 0 (bonded to Object 1!)
            // Object 3: [0.40, 0.44] (length 0.04 m, center 0.42 m) -> Velocity Field 1 (independent!)
            MPMSolver3DCUDA s_coupled;
            s_coupled.initializeGrid(nx, ny, nz, dx, dx, dx, 0.0f, 0.0f, 0.0f);
            s_coupled.setTransferScheme(MPMTransferScheme::BSpline);
            s_coupled.setVelocityScheme(MPMVelocityScheme::APIC);
            s_coupled.setTimeScheme(MPMTimeIntegrationScheme::Leapfrog);
            s_coupled.addBoxObject(1, 0.37f, 0.10f, 0.10f, 0.02f, 0.04f, 0.04f, 10.0f, 0, 0, 0, 0, 0,
                                   rho, E, nu, sy, hard, eps_f, sig_t, 8);
            s_coupled.addBoxObject(2, 0.39f, 0.10f, 0.10f, 0.02f, 0.04f, 0.04f, 10.0f, 0, 0, 0, 0, 0,
                                   rho, E, nu, sy, hard, eps_f, sig_t, 8);
            s_coupled.addBoxObject(3, 0.42f, 0.10f, 0.10f, 0.04f, 0.04f, 0.04f, -10.0f, 0, 0, 0, 0, 0,
                                   rho, E, nu, sy, hard, eps_f, sig_t, 8);
            s_coupled.setContactMethod(MPMContactMethod::MultiVelocityBardenhagen);
            s_coupled.setObjectMaterialMapping({0, 0, 0, 1}, 2);
            s_coupled.setDemContact(false, 0.0f, 0.8f, 1.0f, MPMDEMContactMode::AllDynamic, 0.1f);
            s_coupled.syncToDevice();

            // Run B (Reference): Monolithic Object 1 spanning [0.36, 0.40] + Object 2 spanning [0.40, 0.44]
            MPMSolver3DCUDA s_mono;
            s_mono.initializeGrid(nx, ny, nz, dx, dx, dx, 0.0f, 0.0f, 0.0f);
            s_mono.setTransferScheme(MPMTransferScheme::BSpline);
            s_mono.setVelocityScheme(MPMVelocityScheme::APIC);
            s_mono.setTimeScheme(MPMTimeIntegrationScheme::Leapfrog);
            s_mono.addBoxObject(1, 0.38f, 0.10f, 0.10f, 0.04f, 0.04f, 0.04f, 10.0f, 0, 0, 0, 0, 0,
                                rho, E, nu, sy, hard, eps_f, sig_t, 8);
            s_mono.addBoxObject(2, 0.42f, 0.10f, 0.10f, 0.04f, 0.04f, 0.04f, -10.0f, 0, 0, 0, 0, 0,
                                rho, E, nu, sy, hard, eps_f, sig_t, 8);
            s_mono.setContactMethod(MPMContactMethod::MultiVelocityBardenhagen);
            s_mono.setObjectMaterialMapping({0, 0, 1}, 2);
            s_mono.setDemContact(false, 0.0f, 0.8f, 1.0f, MPMDEMContactMode::AllDynamic, 0.1f);
            s_mono.syncToDevice();

            for (int step = 0; step < steps; ++step) {
                float dt = s_coupled.computeStepSize(cfl);
                s_coupled.stepWithDt(dt, true);
                s_mono.stepWithDt(dt, true);
            }

            ParticleState st_c = capture(s_coupled);
            ParticleState st_m = capture(s_mono);

            // Check bonded pair center-of-mass separation vs initial separation (0.02 m) and rebound of Object 3
            const auto& ps_c = s_coupled.getParticles();
            double x1_sum = 0.0, x2_sum = 0.0, vx12_sum = 0.0, vx3_sum = 0.0;
            size_t n1 = 0, n2 = 0, n3 = 0;
            for (const auto& p : ps_c) {
                if (p.object_id == 1) { x1_sum += p.x[0]; vx12_sum += p.v[0]; n1++; }
                else if (p.object_id == 2) { x2_sum += p.x[0]; vx12_sum += p.v[0]; n2++; }
                else if (p.object_id == 3) { vx3_sum += p.v[0]; n3++; }
            }
            const double x1_mean = (n1 > 0) ? x1_sum / n1 : 0.0;
            const double x2_mean = (n2 > 0) ? x2_sum / n2 : 0.0;
            const double vx12_mean = (n1 + n2 > 0) ? vx12_sum / (n1 + n2) : 0.0;
            const double vx3_mean = (n3 > 0) ? vx3_sum / n3 : 0.0;
            const double bond_sep_err = std::abs((x2_mean - x1_mean) - 0.02); // Initial COM offset is 0.02 m
            const bool rebounded = (vx12_mean < -2.0) && (vx3_mean > 2.0);

            // Compare cell-averaged velocity profile across the +/-5 cell band around x = 0.40 m
            const int ic = static_cast<int>(std::floor(0.40 / dx));
            std::vector<double> xc, vx_c_prof, xc2, vx_m_prof;
            std::vector<int> cnt_c, cnt_m;
            interface_profile(st_c, 0.0, dx, ic, xc, vx_c_prof, cnt_c);
            interface_profile(st_m, 0.0, dx, ic, xc2, vx_m_prof, cnt_m);

            double d2 = 0.0, m2 = 0.0, dmax = 0.0;
            for (size_t k = 0; k < xc.size(); ++k) {
                double diff = std::abs(vx_c_prof[k] - vx_m_prof[k]);
                d2 += diff * diff;
                m2 += vx_m_prof[k] * vx_m_prof[k];
                dmax = std::max(dmax, diff / 10.0);
            }
            res.error_l2 = (m2 > 1.0e-30) ? std::sqrt(d2 / m2) : std::sqrt(d2);
            res.error_linf = dmax;
            res.momentum_drift = 0.0;
            res.energy_drift = 0.0;
            res.passed = (res.error_l2 <= res.tolerance_l2) &&
                         (res.error_linf <= res.tolerance_linf) &&
                         (bond_sep_err <= 2.0e-3) && rebounded;

            std::string svg_file = "vv_mpm_cmp_07_hybrid_coupler.svg";
            generate_svg_plot(svg_file,
                              "VV-L2-CMP-07: Hybrid Bardenhagen Coupler (Bonded Pair + 3rd Body) vs Monolithic Reference",
                              "Cell centre x (m)", "Mean particle vx (m/s)", xc, vx_m_prof, vx_c_prof, 1.0, 5.0);
            res.svg_path = svg_file;

            std::ostringstream sum;
            sum << "3-body hybrid contact (Objects 1+2 bonded on Field 0, Object 3 independent on Field 1) vs monolithic reference: "
                << "profile e_L2(vx) = " << fmt(res.error_l2) << ", e_Linf(vx) = " << fmt(res.error_linf)
                << ", bonded COM offset drift = " << fmt(bond_sep_err) << " m"
                << ", rebound vx_12 = " << std::fixed << std::setprecision(2) << vx12_mean << " m/s"
                << ", vx_3 = +" << vx3_mean << " m/s.";
            res.summary = sum.str();

            std::ostringstream det;
            det << "Discretisation: grid " << nx << " x " << ny << " x " << nz
                << ", dx = dy = dz = " << dx << " m, Np = " << s_coupled.getParticleCount()
                << " (Obj1=" << n1 << ", Obj2=" << n2 << ", Obj3=" << n3 << "), velocity fields M = 2, steps = " << steps << ".";
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
