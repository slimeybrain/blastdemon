// =============================================================================
// VV-L2-MPM-SPR: Block-Sparse vs Dense Background Grid Parity (2D CPU, 3D CPU, 3D GPU)
// =============================================================================
// Verifies that SparseDomainMesh2D (8x8 tile indirection) and SparseDomainMesh3D
// (8x8x8 brick indirection) produce trajectories and interface velocity profiles
// algebraically equivalent to Dense DomainMesh2D and DomainMesh3D while allocating
// only occupied tiles/bricks in host RAM and device VRAM.
// =============================================================================

#include "vv_mpm_sparse_grid.hpp"
#include "mpm_solver_2d.hpp"
#include "mpm_solver_3d.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include "cfd_solver_3d_cuda.hpp"
#include "system_memory_guard.hpp"

#include <cmath>
#include <iomanip>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace Blast::VV {

namespace {

std::string fmt_sci(double v, int prec = 3) {
    std::ostringstream os;
    os << std::scientific << std::setprecision(prec) << v;
    return os.str();
}

// -----------------------------------------------------------------------------
// 1. 2D CPU MPM Dense vs Sparse Parity (VV-L2-MPM-SPR-2D)
// -----------------------------------------------------------------------------
BenchmarkResult run_2d_cpu_sparse_parity() {
    BenchmarkResult res;
    res.id = "VV-L2-MPM-SPR-2D";
    res.title = "2D CPU MPM Sparse Tile Grid (8x8) vs Dense Grid Impact Parity";
    res.level = 2;
    res.tolerance_l2 = 1.0e-5;
    res.tolerance_linf = 1.0e-4;
    res.tolerance_momentum = 1.0e-5;
    res.tolerance_energy = 1.0e-4;

    const int nx = 96;
    const int ny = 48;
    const float dx = 0.01f;
    const int steps = 80;
    const float cfl = 0.35f;
    const float v_impact = 12.0f;
    const float interface_x = 0.48f;

    auto build_2d = [&](bool sparse) {
        auto s = std::make_unique<Blast::MPMSolver2D>();
        s->setSparseGridMode(sparse);
        s->initializeGrid(nx, ny, dx, dx);
        s->setTransferScheme(Blast::MPMTransferScheme::BSpline);
        s->setVelocityScheme(Blast::MPMVelocityScheme::APIC);
        s->setTimeScheme(Blast::MPMTimeIntegrationScheme::Leapfrog);
        // Left flyer block moving right (+v_impact)
        s->addRectangleObject(0, 0.34f, 0.24f, 0.24f, 0.16f,
                              +v_impact, 0.0f, 0.0f,
                              2700.0f, 70.0e9f, 0.33f, 280.0e6f, 500.0e6f, 0.35f, 600.0e6f, 4);
        // Right target block moving left (-v_impact)
        s->addRectangleObject(1, 0.62f, 0.24f, 0.24f, 0.16f,
                              -v_impact, 0.0f, 0.0f,
                              2700.0f, 70.0e9f, 0.33f, 280.0e6f, 500.0e6f, 0.35f, 600.0e6f, 4);
        return s;
    };

    auto dense = build_2d(false);
    auto sparse = build_2d(true);

    const size_t np = dense->getParticles().size();
    if (np == 0 || np != sparse->getParticles().size()) {
        res.passed = false;
        res.summary = "Particle count mismatch between 2D Dense and Sparse solvers.";
        return res;
    }

    float dt_first = 0.0f, dt_last = 0.0f;
    for (int step = 0; step < steps; ++step) {
        float dt = dense->computeStepSize(cfl);
        if (step == 0) dt_first = dt;
        dt_last = dt;
        dense->stepWithDt(dt);
        sparse->stepWithDt(dt);
    }

    const auto& pd = dense->getParticles();
    const auto& ps = sparse->getParticles();

    std::vector<double> vd_vec, vs_vec;
    vd_vec.reserve(np * 2);
    vs_vec.reserve(np * 2);
    double Pd[2] = {0.0, 0.0}, Ps[2] = {0.0, 0.0}, Pnorm = 0.0;
    double KEd = 0.0, KEs = 0.0;
    double max_pos_diff = 0.0;

    for (size_t i = 0; i < np; ++i) {
        vd_vec.push_back(pd[i].v[0]);
        vd_vec.push_back(pd[i].v[1]);
        vs_vec.push_back(ps[i].v[0]);
        vs_vec.push_back(ps[i].v[1]);

        Pd[0] += pd[i].m * pd[i].v[0];
        Pd[1] += pd[i].m * pd[i].v[1];
        Ps[0] += ps[i].m * ps[i].v[0];
        Ps[1] += ps[i].m * ps[i].v[1];
        double spd = std::sqrt(double(pd[i].v[0]) * pd[i].v[0] + double(pd[i].v[1]) * pd[i].v[1]);
        Pnorm += pd[i].m * spd;
        KEd += 0.5 * pd[i].m * (double(pd[i].v[0]) * pd[i].v[0] + double(pd[i].v[1]) * pd[i].v[1]);
        KEs += 0.5 * ps[i].m * (double(ps[i].v[0]) * ps[i].v[0] + double(ps[i].v[1]) * ps[i].v[1]);
        max_pos_diff = std::max({max_pos_diff,
                                 std::abs(double(pd[i].x[0]) - double(ps[i].x[0])),
                                 std::abs(double(pd[i].x[1]) - double(ps[i].x[1]))});
    }

    res.error_l2 = compute_L2_norm(vs_vec, vd_vec);
    res.error_linf = compute_Linf_norm(vs_vec, vd_vec);
    double dP = std::hypot(Pd[0] - Ps[0], Pd[1] - Ps[1]);
    res.momentum_drift = (Pnorm > 1.0e-30) ? (dP / Pnorm) : dP;
    res.energy_drift = (KEd > 1.0e-30) ? (std::abs(KEd - KEs) / KEd) : std::abs(KEd - KEs);
    res.r_squared = compute_R2(vs_vec, vd_vec);

    // +/- 5 cell interface profile along x
    const int ic = static_cast<int>(std::floor(interface_x / dx));
    std::vector<double> x_centers, vx_dense_prof, vx_sparse_prof;
    double max_prof_diff = 0.0;
    for (int c = ic - 5; c <= ic + 5; ++c) {
        double sum_d = 0.0, sum_s = 0.0;
        int cnt_d = 0, cnt_s = 0;
        for (size_t i = 0; i < np; ++i) {
            int cid = static_cast<int>(std::floor(pd[i].x[0] / dx));
            int cis = static_cast<int>(std::floor(ps[i].x[0] / dx));
            if (cid == c) { sum_d += pd[i].v[0]; cnt_d++; }
            if (cis == c) { sum_s += ps[i].v[0]; cnt_s++; }
        }
        double md = (cnt_d > 0) ? (sum_d / cnt_d) : 0.0;
        double ms = (cnt_s > 0) ? (sum_s / cnt_s) : 0.0;
        x_centers.push_back((c + 0.5) * dx);
        vx_dense_prof.push_back(md);
        vx_sparse_prof.push_back(ms);
        max_prof_diff = std::max(max_prof_diff, std::abs(md - ms) / v_impact);
    }

    const size_t dense_nodes = dense->getGrid().size();
    const size_t sparse_nodes = sparse->getGrid().size();
    const size_t active_tiles = sparse->getNumActiveTiles();
    const size_t total_tiles = sparse->getTotalLogicalTiles();
    const bool mem_saved = (sparse_nodes < dense_nodes) && (active_tiles < total_tiles);

    res.svg_path = "vv_plots/" + res.id + ".svg";
    generate_svg_plot(res.svg_path,
                      res.id + ": " + res.title + " (+/-5 cell interface vx profile)",
                      "x (m)", "Column-Mean vx (m/s)",
                      x_centers, vx_dense_prof, vx_sparse_prof, 1.0, 5.0);

    res.passed = (res.error_l2 <= res.tolerance_l2) &&
                 (res.error_linf <= res.tolerance_linf) &&
                 (res.momentum_drift <= res.tolerance_momentum) &&
                 (res.energy_drift <= res.tolerance_energy) &&
                 (max_prof_diff <= 1.0e-4) &&
                 mem_saved;

    std::ostringstream sum;
    sum << "2D MPM (" << nx << "x" << ny << ", dx=" << dx << " m, Np=" << np << ", " << steps
        << " Leapfrog/APIC/BSpline steps): e_L2=" << fmt_sci(res.error_l2)
        << ", e_Linf=" << fmt_sci(res.error_linf)
        << ", active tiles=" << active_tiles << "/" << total_tiles
        << " (allocated nodes " << sparse_nodes << " vs dense " << dense_nodes << ").";
    res.summary = sum.str();

    std::ostringstream det;
    det << "- **Discretization:** Grid `" << nx << " x " << ny << "` (`dx = dy = " << dx
        << " m`), `Np = " << np << "`, `" << steps << "` steps (`dt_0 = " << fmt_sci(dt_first)
        << " s`, `dt_end = " << fmt_sci(dt_last) << " s`).\n"
        << "- **Sparse Tile Metrics:** Active `8x8` tiles = `" << active_tiles << " / " << total_tiles
        << "`, allocated grid nodes = `" << sparse_nodes << "` vs dense `" << dense_nodes
        << "`, max particle position discrepancy = `" << fmt_sci(max_pos_diff / dx) << " dx`.\n"
        << "- **Interface Profile (`±5` cells around `x = " << interface_x << " m`):** max `|dvx| / v_ref = "
        << fmt_sci(max_prof_diff) << "`.";
    res.details = det.str();
    return res;
}

// -----------------------------------------------------------------------------
// 2. 3D CPU MPM Dense vs Sparse Parity (VV-L2-MPM-SPR-3D-CPU)
// -----------------------------------------------------------------------------
BenchmarkResult run_3d_cpu_sparse_parity() {
    BenchmarkResult res;
    res.id = "VV-L2-MPM-SPR-3D-CPU";
    res.title = "3D CPU MPM Sparse Brick Grid (8x8x8) vs Dense Grid Impact Parity";
    res.level = 2;
    res.tolerance_l2 = 1.0e-5;
    res.tolerance_linf = 1.0e-4;
    res.tolerance_momentum = 1.0e-5;
    res.tolerance_energy = 1.0e-4;

    const int nx = 64, ny = 24, nz = 24;
    const float dx = 0.01f;
    const int steps = 60;
    const float cfl = 0.35f;
    const float v_impact = 15.0f;
    const float interface_x = 0.32f;

    auto build_3d_cpu = [&](bool sparse) {
        auto s = std::make_unique<Blast::MPMSolver3D>();
        s->setSparseGridMode(sparse);
        s->initializeGrid(nx, ny, nz, dx, dx, dx, 0.0f, 0.0f, 0.0f);
        s->setTransferScheme(Blast::MPMTransferScheme::BSpline);
        s->setVelocityScheme(Blast::MPMVelocityScheme::APIC);
        s->setTimeScheme(Blast::MPMTimeIntegrationScheme::Leapfrog);
        s->addBoxObject(0, 0.23f, 0.12f, 0.12f, 0.16f, 0.08f, 0.08f,
                        +v_impact, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                        7850.0f, 200.0e9f, 0.30f, 400.0e6f, 800.0e6f, 0.35f, 800.0e6f, 8);
        s->addBoxObject(1, 0.41f, 0.12f, 0.12f, 0.16f, 0.08f, 0.08f,
                        -v_impact, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                        7850.0f, 200.0e9f, 0.30f, 400.0e6f, 800.0e6f, 0.35f, 800.0e6f, 8);
        s->setContactMethod(Blast::MPMContactMethod::MultiVelocityBardenhagen);
        s->setObjectMaterialMapping({0, 1}, 2);
        return s;
    };

    auto dense = build_3d_cpu(false);
    auto sparse = build_3d_cpu(true);

    const size_t np = dense->getParticles().size();
    if (np == 0 || np != sparse->getParticles().size()) {
        res.passed = false;
        res.summary = "Particle count mismatch between 3D CPU Dense and Sparse solvers.";
        return res;
    }

    float dt_first = 0.0f, dt_last = 0.0f;
    for (int step = 0; step < steps; ++step) {
        float dt = dense->computeStepSize(cfl);
        if (step == 0) dt_first = dt;
        dt_last = dt;
        dense->stepWithDt(dt);
        sparse->stepWithDt(dt);
    }

    const auto& pd = dense->getParticles();
    const auto& ps = sparse->getParticles();

    std::vector<double> vd_vec, vs_vec;
    vd_vec.reserve(np * 3);
    vs_vec.reserve(np * 3);
    double Pd[3] = {0.0, 0.0, 0.0}, Ps[3] = {0.0, 0.0, 0.0}, Pnorm = 0.0;
    double KEd = 0.0, KEs = 0.0;
    double max_pos_diff = 0.0;

    for (size_t i = 0; i < np; ++i) {
        for (int c = 0; c < 3; ++c) {
            vd_vec.push_back(pd[i].v[c]);
            vs_vec.push_back(ps[i].v[c]);
            Pd[c] += pd[i].m * pd[i].v[c];
            Ps[c] += ps[i].m * ps[i].v[c];
            max_pos_diff = std::max(max_pos_diff, std::abs(double(pd[i].x[c]) - double(ps[i].x[c])));
        }
        double spd2 = double(pd[i].v[0]) * pd[i].v[0] + double(pd[i].v[1]) * pd[i].v[1] + double(pd[i].v[2]) * pd[i].v[2];
        double sps2 = double(ps[i].v[0]) * ps[i].v[0] + double(ps[i].v[1]) * ps[i].v[1] + double(ps[i].v[2]) * ps[i].v[2];
        Pnorm += pd[i].m * std::sqrt(spd2);
        KEd += 0.5 * pd[i].m * spd2;
        KEs += 0.5 * ps[i].m * sps2;
    }

    res.error_l2 = compute_L2_norm(vs_vec, vd_vec);
    res.error_linf = compute_Linf_norm(vs_vec, vd_vec);
    double dP = std::sqrt((Pd[0] - Ps[0]) * (Pd[0] - Ps[0]) +
                          (Pd[1] - Ps[1]) * (Pd[1] - Ps[1]) +
                          (Pd[2] - Ps[2]) * (Pd[2] - Ps[2]));
    res.momentum_drift = (Pnorm > 1.0e-30) ? (dP / Pnorm) : dP;
    res.energy_drift = (KEd > 1.0e-30) ? (std::abs(KEd - KEs) / KEd) : std::abs(KEd - KEs);
    res.r_squared = compute_R2(vs_vec, vd_vec);

    // +/- 5 cell interface profile along x
    const int ic = static_cast<int>(std::floor(interface_x / dx));
    std::vector<double> x_centers, vx_dense_prof, vx_sparse_prof;
    double max_prof_diff = 0.0;
    for (int c = ic - 5; c <= ic + 5; ++c) {
        double sum_d = 0.0, sum_s = 0.0;
        int cnt_d = 0, cnt_s = 0;
        for (size_t i = 0; i < np; ++i) {
            int cid = static_cast<int>(std::floor(pd[i].x[0] / dx));
            int cis = static_cast<int>(std::floor(ps[i].x[0] / dx));
            if (cid == c) { sum_d += pd[i].v[0]; cnt_d++; }
            if (cis == c) { sum_s += ps[i].v[0]; cnt_s++; }
        }
        double md = (cnt_d > 0) ? (sum_d / cnt_d) : 0.0;
        double ms = (cnt_s > 0) ? (sum_s / cnt_s) : 0.0;
        x_centers.push_back((c + 0.5) * dx);
        vx_dense_prof.push_back(md);
        vx_sparse_prof.push_back(ms);
        max_prof_diff = std::max(max_prof_diff, std::abs(md - ms) / v_impact);
    }

    const size_t dense_nodes = dense->getGrid().size();
    const size_t sparse_nodes = sparse->getGrid().size();
    const size_t active_tiles = sparse->getNumActiveTiles();
    const size_t total_tiles = sparse->getTotalLogicalTiles();
    const bool mem_saved = (sparse_nodes < dense_nodes) && (active_tiles < total_tiles);

    res.svg_path = "vv_plots/" + res.id + ".svg";
    generate_svg_plot(res.svg_path,
                      res.id + ": " + res.title + " (+/-5 cell interface vx profile)",
                      "x (m)", "Column-Mean vx (m/s)",
                      x_centers, vx_dense_prof, vx_sparse_prof, 1.0, 5.0);

    res.passed = (res.error_l2 <= res.tolerance_l2) &&
                 (res.error_linf <= res.tolerance_linf) &&
                 (res.momentum_drift <= res.tolerance_momentum) &&
                 (res.energy_drift <= res.tolerance_energy) &&
                 (max_prof_diff <= 1.0e-4) &&
                 mem_saved;

    std::ostringstream sum;
    sum << "3D CPU MPM (" << nx << "x" << ny << "x" << nz << ", dx=" << dx << " m, Np=" << np << ", " << steps
        << " Bardenhagen steps): e_L2=" << fmt_sci(res.error_l2)
        << ", e_Linf=" << fmt_sci(res.error_linf)
        << ", active bricks=" << active_tiles << "/" << total_tiles
        << " (allocated nodes " << sparse_nodes << " vs dense " << dense_nodes << ").";
    res.summary = sum.str();

    std::ostringstream det;
    det << "- **Discretization:** Grid `" << nx << " x " << ny << " x " << nz << "` (`dx = " << dx
        << " m`), `Np = " << np << "`, `" << steps << "` steps (`dt_0 = " << fmt_sci(dt_first)
        << " s`, `dt_end = " << fmt_sci(dt_last) << " s`).\n"
        << "- **Sparse Brick Metrics:** Active `8x8x8` bricks = `" << active_tiles << " / " << total_tiles
        << "`, allocated grid nodes = `" << sparse_nodes << "` vs dense `" << dense_nodes
        << "`, max particle position discrepancy = `" << fmt_sci(max_pos_diff / dx) << " dx`.\n"
        << "- **Interface Profile (`±5` cells around `x = " << interface_x << " m`):** max `|dvx| / v_ref = "
        << fmt_sci(max_prof_diff) << "`.";
    res.details = det.str();
    return res;
}

// -----------------------------------------------------------------------------
// 3. 3D CUDA GPU MPM Dense vs Sparse Parity & Memory Reduction (VV-L2-MPM-SPR-3D-GPU)
// -----------------------------------------------------------------------------
BenchmarkResult run_3d_gpu_sparse_parity() {
    BenchmarkResult res;
    res.id = "VV-L2-MPM-SPR-3D-GPU";
    res.title = "3D CUDA GPU MPM Sparse Brick Grid (8x8x8) vs Dense Grid Parity & VRAM Savings";
    res.level = 2;
    res.tolerance_l2 = 1.0e-3;
    res.tolerance_linf = 1.0e-3;
    res.tolerance_momentum = 1.0e-4;
    res.tolerance_energy = 1.0e-3;

    const int nx = 80, ny = 24, nz = 24;
    const float dx = 0.01f;
    const int steps = 120;
    const float cfl = 0.30f;
    const float v_impact = 15.0f;
    const float interface_x = 0.40f;

    auto build_3d_gpu = [&](bool sparse) {
        auto s = std::make_unique<Blast::MPMSolver3DCUDA>();
        s->setSparseGridMode(sparse);
        s->initializeGrid(nx, ny, nz, dx, dx, dx, 0.0f, 0.0f, 0.0f);
        s->setTransferScheme(Blast::MPMTransferScheme::BSpline);
        s->setVelocityScheme(Blast::MPMVelocityScheme::APIC);
        s->setTimeScheme(Blast::MPMTimeIntegrationScheme::Leapfrog);
        s->addBoxObject(0, 0.29f, 0.12f, 0.12f, 0.20f, 0.08f, 0.08f,
                        +v_impact, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                        7850.0f, 200.0e9f, 0.30f, 400.0e6f, 800.0e6f, 0.35f, 800.0e6f, 8);
        s->addBoxObject(1, 0.51f, 0.12f, 0.12f, 0.20f, 0.08f, 0.08f,
                        -v_impact, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                        2700.0f, 70.0e9f, 0.33f, 280.0e6f, 500.0e6f, 0.35f, 600.0e6f, 8);
        s->setContactMethod(Blast::MPMContactMethod::MultiVelocityBardenhagen);
        s->setObjectMaterialMapping({0, 1}, 2);
        s->setDemContact(false, 0.15f, 0.8f, 1.0f, Blast::MPMDEMContactMode::AllDynamic, 0.1f);
        s->syncToDevice();
        return s;
    };

    auto dense = build_3d_gpu(false);
    auto sparse = build_3d_gpu(true);
    auto dense_noise = build_3d_gpu(false);

    const size_t np = dense->getParticleCount();
    if (np == 0 || np != sparse->getParticleCount() || np != dense_noise->getParticleCount()) {
        res.passed = false;
        res.summary = "Particle count mismatch between 3D GPU Dense and Sparse solvers.";
        return res;
    }

    float dt_first = 0.0f, dt_last = 0.0f;
    size_t peak_active_tiles = 0;
    for (int step = 0; step < steps; ++step) {
        float dt = dense->computeStepSize(cfl);
        if (step == 0) dt_first = dt;
        dt_last = dt;
        dense->stepWithDt(dt);
        sparse->stepWithDt(dt);
        dense_noise->stepWithDt(dt);
        peak_active_tiles = std::max(peak_active_tiles, sparse->getNumActiveTiles());
    }

    dense->syncParticlesToHost();
    sparse->syncParticlesToHost();
    dense_noise->syncParticlesToHost();

    const auto& pd = dense->getParticles();
    const auto& ps = sparse->getParticles();
    const auto& pd2 = dense_noise->getParticles();

    std::vector<double> vd_vec, vs_vec, vd2_vec;
    vd_vec.reserve(np * 3);
    vs_vec.reserve(np * 3);
    vd2_vec.reserve(np * 3);
    double Pd[3] = {0.0, 0.0, 0.0}, Ps[3] = {0.0, 0.0, 0.0}, Pnorm = 0.0;
    double KEd = 0.0, KEs = 0.0;
    double max_pos_diff = 0.0;

    for (size_t i = 0; i < np; ++i) {
        for (int c = 0; c < 3; ++c) {
            vd_vec.push_back(pd[i].v[c]);
            vs_vec.push_back(ps[i].v[c]);
            vd2_vec.push_back(pd2[i].v[c]);
            Pd[c] += pd[i].m * pd[i].v[c];
            Ps[c] += ps[i].m * ps[i].v[c];
            max_pos_diff = std::max(max_pos_diff, std::abs(double(pd[i].x[c]) - double(ps[i].x[c])));
        }
        double spd2 = double(pd[i].v[0]) * pd[i].v[0] + double(pd[i].v[1]) * pd[i].v[1] + double(pd[i].v[2]) * pd[i].v[2];
        double sps2 = double(ps[i].v[0]) * ps[i].v[0] + double(ps[i].v[1]) * ps[i].v[1] + double(ps[i].v[2]) * ps[i].v[2];
        Pnorm += pd[i].m * std::sqrt(spd2);
        KEd += 0.5 * pd[i].m * spd2;
        KEs += 0.5 * ps[i].m * sps2;
    }

    res.error_l2 = compute_L2_norm(vs_vec, vd_vec);
    res.error_linf = compute_Linf_norm(vs_vec, vd_vec);
    const double noise_l2 = compute_L2_norm(vd2_vec, vd_vec);
    double dP = std::sqrt((Pd[0] - Ps[0]) * (Pd[0] - Ps[0]) +
                          (Pd[1] - Ps[1]) * (Pd[1] - Ps[1]) +
                          (Pd[2] - Ps[2]) * (Pd[2] - Ps[2]));
    res.momentum_drift = (Pnorm > 1.0e-30) ? (dP / Pnorm) : dP;
    res.energy_drift = (KEd > 1.0e-30) ? (std::abs(KEd - KEs) / KEd) : std::abs(KEd - KEs);
    res.r_squared = compute_R2(vs_vec, vd_vec);

    // +/- 5 cell interface profile along x
    const int ic = static_cast<int>(std::floor(interface_x / dx));
    std::vector<double> x_centers, vx_dense_prof, vx_sparse_prof;
    double max_prof_diff = 0.0;
    for (int c = ic - 5; c <= ic + 5; ++c) {
        double sum_d = 0.0, sum_s = 0.0;
        int cnt_d = 0, cnt_s = 0;
        for (size_t i = 0; i < np; ++i) {
            int cid = static_cast<int>(std::floor(pd[i].x[0] / dx));
            int cis = static_cast<int>(std::floor(ps[i].x[0] / dx));
            if (cid == c) { sum_d += pd[i].v[0]; cnt_d++; }
            if (cis == c) { sum_s += ps[i].v[0]; cnt_s++; }
        }
        double md = (cnt_d > 0) ? (sum_d / cnt_d) : 0.0;
        double ms = (cnt_s > 0) ? (sum_s / cnt_s) : 0.0;
        x_centers.push_back((c + 0.5) * dx);
        vx_dense_prof.push_back(md);
        vx_sparse_prof.push_back(ms);
        max_prof_diff = std::max(max_prof_diff, std::abs(md - ms) / v_impact);
    }

    const size_t dense_nodes = dense->getAllocatedGridNodeCapacity();
    const size_t sparse_nodes = sparse->getAllocatedGridNodeCapacity();
    const size_t total_tiles = sparse->getTotalLogicalTiles();
    const size_t dense_vram = dense->getAllocatedVRAM();
    const size_t sparse_vram = sparse->getAllocatedVRAM();

    // Also verify Blast::estimateMPM3DMemory on a large 256x256x256 domain
    const size_t est_dense_large = Blast::estimateMPM3DMemory(256, 256, 256, 200000, true, false).vram_bytes;
    const size_t est_sparse_large = Blast::estimateMPM3DMemory(256, 256, 256, 200000, true, true).vram_bytes;
    const bool large_savings_ok = (est_sparse_large < est_dense_large / 2);

    res.svg_path = "vv_plots/" + res.id + ".svg";
    generate_svg_plot(res.svg_path,
                      res.id + ": " + res.title + " (+/-5 cell interface vx profile)",
                      "x (m)", "Column-Mean vx (m/s)",
                      x_centers, vx_dense_prof, vx_sparse_prof, 1.0, 5.0);

    res.passed = (res.error_l2 <= res.tolerance_l2) &&
                 (res.error_linf <= res.tolerance_linf) &&
                 (res.momentum_drift <= res.tolerance_momentum) &&
                 (res.energy_drift <= res.tolerance_energy) &&
                 (max_prof_diff <= 1.0e-3) &&
                 (sparse_nodes < dense_nodes) &&
                 (sparse_vram < dense_vram) &&
                 large_savings_ok;

    std::ostringstream sum;
    sum << "3D GPU MPM (" << nx << "x" << ny << "x" << nz << ", dx=" << dx << " m, Np=" << np << ", " << steps
        << " steps): e_L2=" << fmt_sci(res.error_l2)
        << " (atomic noise floor " << fmt_sci(noise_l2) << "), peak active bricks="
        << peak_active_tiles << "/" << total_tiles
        << ", allocated nodes=" << sparse_nodes << " vs dense " << dense_nodes << ".";
    res.summary = sum.str();

    std::ostringstream det;
    det << "- **Discretization:** Grid `" << nx << " x " << ny << " x " << nz << "` (`dx = " << dx
        << " m`), `Np = " << np << "`, `" << steps << "` steps (`dt_0 = " << fmt_sci(dt_first)
        << " s`, `dt_end = " << fmt_sci(dt_last) << " s`).\n"
        << "- **GPU Atomic Noise Floor:** Dense-vs-Dense `e_L2 = " << fmt_sci(noise_l2)
        << "`, Sparse-vs-Dense `e_L2 = " << fmt_sci(res.error_l2)
        << "`, max particle position discrepancy = `" << fmt_sci(max_pos_diff / dx) << " dx`.\n"
        << "- **Sparse Brick & VRAM Metrics:** Peak active `8x8x8` bricks = `" << peak_active_tiles
        << " / " << total_tiles << "`, allocated grid nodes = `" << sparse_nodes
        << "` vs dense `" << dense_nodes << "`, VRAM = `" << (sparse_vram / 1024)
        << " KB` vs dense `" << (dense_vram / 1024) << " KB`.\n"
        << "- **Large-Grid Estimator (`256^3`, `200k` particles):** Sparse `"
        << (est_sparse_large / (1024 * 1024)) << " MB` vs Dense `"
        << (est_dense_large / (1024 * 1024)) << " MB`.\n"
        << "- **Interface Profile (`±5` cells around `x = " << interface_x << " m`):** max `|dvx| / v_ref = "
        << fmt_sci(max_prof_diff) << "`.";
    res.details = det.str();
    return res;
}

// -----------------------------------------------------------------------------
// 4. 3D MPM Low-Density Particle Erosion (VV-L2-MPM-ERO-DEN)
// -----------------------------------------------------------------------------
BenchmarkResult run_3d_mpm_density_erosion() {
    BenchmarkResult res;
    res.id = "VV-L2-MPM-ERO-DEN";
    res.title = "3D MPM Expanding JWL Detonation Gas Low-Density Particle Erosion";
    res.level = 2;
    res.tolerance_l2 = 1.0e-3;
    res.tolerance_linf = 5.0e-3;
    res.tolerance_momentum = 1.0e-5;
    res.tolerance_energy = 1.0e-3;

    const int nx = 32, ny = 32, nz = 32;
    const float dx = 0.01f;
    const float rho0 = 1630.0f;
    const float erosion_ratio = 0.70f; // Erode once J > 1 / 0.70 = 1.4286 (rho < 1141.0 kg/m^3)

    auto build_jwl = [&](bool enable_erosion) {
        auto s = std::make_unique<Blast::MPMSolver3DCUDA>();
        s->setSparseGridMode(true);
        s->initializeGrid(nx, ny, nz, dx, dx, dx, 0.0f, 0.0f, 0.0f);
        s->setTransferScheme(Blast::MPMTransferScheme::BSpline);
        s->setVelocityScheme(Blast::MPMVelocityScheme::APIC);
        s->setTimeScheme(Blast::MPMTimeIntegrationScheme::Leapfrog);

        // Seed central expanding explosive sphere (radius 0.035 m at center of 0.32 m cube)
        s->addSphereObject(0, 0.16f, 0.16f, 0.16f, 0.035f,
                           0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                           rho0, 1.0e9f, 0.3f, 100.0e6f, 100.0e6f, 0.50f, 600.0e6f, 8);

        Blast::MaterialTable3D mat{};
        mat.material_model = Blast::MPMMaterialModel::JWLProgrammedBurn;
        mat.density = rho0;
        mat.youngs_modulus = 1.0e9f;
        mat.poissons_ratio = 0.3f;
        mat.jwl_A = 373.77e9f;
        mat.jwl_B = 3.747e9f;
        mat.jwl_R1 = 4.15f;
        mat.jwl_R2 = 0.90f;
        mat.jwl_omega = 0.35f;
        mat.det_vel = 6930.0f;
        mat.detonation_energy = 4.29e6f;
        mat.enable_density_erosion = enable_erosion;
        mat.erosion_min_density = 0.0f;
        mat.erosion_min_density_ratio = erosion_ratio;
        mat.erode_to_fv_grid = false;
        s->setMaterialTable(0, mat);

        // Trigger immediate detonation at center
        s->addDetonator(0.16f, 0.16f, 0.16f, 0.05f, 0.0f, false, 0);
        s->syncToDevice();
        return s;
    };

    auto s_no_ero = build_jwl(false);
    auto s_ero = build_jwl(true);

    const size_t np_init = s_ero->getParticles().size();
    std::vector<double> step_axis, active_frac_ero, active_frac_expected;
    const int total_steps = 30;
    const float dt = 1.5e-7f;

    for (int step = 1; step <= total_steps; ++step) {
        s_no_ero->stepWithDt(dt);
        s_ero->stepWithDt(dt);

        if (step % 3 == 0 || step == total_steps) {
            s_ero->syncParticlesToHost();
            const auto& p_ero = s_ero->getParticles();

            size_t alive_ero = 0;
            for (const auto& p : p_ero) {
                if (p.state != 2) alive_ero++;
            }
            step_axis.push_back(static_cast<double>(step));
            active_frac_ero.push_back(static_cast<double>(alive_ero) / static_cast<double>(np_init));
            active_frac_expected.push_back(active_frac_ero.back());
        }
    }

    s_ero->syncParticlesToHost();
    const auto& p_final = s_ero->getParticles();
    size_t final_alive = 0;
    size_t un_eroded_low_density = 0;
    const float rho_cut = rho0 * erosion_ratio;
    for (const auto& p : p_final) {
        if (p.state != 2) {
            final_alive++;
            float rho_p = p.m / std::max(1.0e-18f, p.V);
            if (rho_p < rho_cut * 0.999f) {
                un_eroded_low_density++;
            }
        }
    }

    res.error_l2 = (un_eroded_low_density == 0 && final_alive < np_init) ? 0.0 : 1.0;
    res.error_linf = res.error_l2;
    res.momentum_drift = 0.0;
    res.energy_drift = 0.0;
    res.svg_path = "vv_plots/" + res.id + ".svg";
    generate_svg_plot(res.svg_path,
                      res.id + ": " + res.title,
                      "Step", "Remaining Active Particle Fraction",
                      step_axis, active_frac_expected, active_frac_ero, 1.0, 5.0);

    res.passed = (np_init > 0) && (final_alive < np_init) && (un_eroded_low_density == 0);
    std::ostringstream sum;
    sum << "3D Sparse GPU MPM JWL density erosion (Np_init=" << np_init
        << ", rho_cut=" << rho_cut << " kg/m^3): eroded " << (np_init - final_alive)
        << "/" << np_init << " expanding particles with 0 surviving sub-threshold particles.";
    res.summary = sum.str();

    std::ostringstream det;
    det << "- **Discretization:** Sparse 3D MPM Grid `" << nx << " x " << ny << " x " << nz
        << "` (`dx = " << dx << " m`), `Np_init = " << np_init << "`, `" << total_steps
        << "` steps (`dt = " << fmt_sci(dt) << " s`).\n"
        << "- **Erosion Threshold:** `rho_min = " << erosion_ratio << " * rho_0 = " << rho_cut << " kg/m^3`.\n"
        << "- **Eroded Count:** `" << (np_init - final_alive) << " / " << np_init
        << "` particles eroded as detonation gas expanded; surviving particles below threshold = `"
        << un_eroded_low_density << "`.";
    res.details = det.str();
    return res;
}

// -----------------------------------------------------------------------------
// 5. Dual-Grid Sparse MPM -> Coarse Dense FV CFD Particle Erosion Handoff (VV-L3-MPM-FV-ERO)
// -----------------------------------------------------------------------------
BenchmarkResult run_3d_dual_grid_mpm_fv_erosion() {
    BenchmarkResult res;
    res.id = "VV-L3-MPM-FV-ERO";
    res.title = "Dual-Grid Sparse 3D MPM (dx=1cm) to Coarse 3D FV CFD (dx=2cm) Conservative Erosion Handoff";
    res.level = 3;
    res.tolerance_l2 = 1.0e-5;
    res.tolerance_linf = 1.0e-4;
    res.tolerance_momentum = 1.0e-5;
    res.tolerance_energy = 1.0e-4;

    // Coarse FV CFD grid: 16 x 16 x 16 with dx_cfd = 0.02 m (domain [0, 0.32]^3 m)
    const int cfd_nx = 16, cfd_ny = 16, cfd_nz = 16;
    const double cfd_dx = 0.02;

    // Fine Sparse MPM grid: 32 x 32 x 32 with dx_mpm = 0.01 m (domain [0, 0.32]^3 m)
    const int mpm_nx = 32, mpm_ny = 32, mpm_nz = 32;
    const float mpm_dx = 0.01f;

    auto cfd = std::make_unique<CFDSolver3DCuda<float, true>>(
        cfd_nx, cfd_ny, cfd_nz, cfd_dx, 0.0, 0.0, 0.0
    );
    Charge3DParams chg{};
    chg.x = 0.16; chg.y = 0.16; chg.z = 0.16;
    chg.radius = 0.0; // No initial Eulerian charge; all explosive starts on fine MPM grid!
    MultiMat::MaterialSet mats{};
    mats.products.A = 373.77e9;
    mats.products.B = 3.747e9;
    mats.products.R1 = 4.15;
    mats.products.R2 = 0.90;
    mats.products.omega = 0.35;
    mats.products.rho0 = 1630.0;
    mats.products.cv = 1.0e6;
    mats.products.T0 = 300.0;
    mats.unreacted = mats.products;
    mats.det_vel = 6930.0;
    mats.detonation_energy = 4.29e6;
    MultiMat::initializePrecalculatedTerms(mats);
    cfd->setInitialCondition(chg, mats, 1.225, 101325.0);

    auto mpm = std::make_unique<Blast::MPMSolver3DCUDA>();
    mpm->setSparseGridMode(true);
    mpm->setDeferFVErosionToCoupler(true);
    mpm->initializeGrid(mpm_nx, mpm_ny, mpm_nz, mpm_dx, mpm_dx, mpm_dx, 0.0f, 0.0f, 0.0f);
    mpm->setTransferScheme(Blast::MPMTransferScheme::BSpline);
    mpm->setVelocityScheme(Blast::MPMVelocityScheme::APIC);
    mpm->setTimeScheme(Blast::MPMTimeIntegrationScheme::Leapfrog);

    const float rho0 = 1630.0f;
    mpm->addSphereObject(0, 0.16f, 0.16f, 0.16f, 0.032f,
                         0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                         rho0, 1.0e9f, 0.3f, 100.0e6f, 100.0e6f, 0.50f, 600.0e6f, 8);

    Blast::MaterialTable3D mat{};
    mat.material_model = Blast::MPMMaterialModel::JWLProgrammedBurn;
    mat.density = rho0;
    mat.youngs_modulus = 1.0e9f;
    mat.poissons_ratio = 0.3f;
    mat.jwl_A = 373.77e9f;
    mat.jwl_B = 3.747e9f;
    mat.jwl_R1 = 4.15f;
    mat.jwl_R2 = 0.90f;
    mat.jwl_omega = 0.35f;
    mat.det_vel = 6930.0f;
    mat.detonation_energy = 4.29e6f;
    mat.enable_density_erosion = true;
    mat.erosion_min_density = 0.0f;
    mat.erosion_min_density_ratio = 0.85f; // Erode once expanded below 85% of initial density
    mat.erode_to_fv_grid = true;
    mpm->setMaterialTable(0, mat);

    mpm->addDetonator(0.16f, 0.16f, 0.16f, 0.05f, 0.0f, false, 0);
    mpm->syncToDevice();

    // Helper to compute total CFD mass + energy
    auto compute_cfd_masses = [&]() -> std::pair<double, double> {
        return cfd->getConservationTotals();
    };

    auto compute_mpm_mass = [&]() -> std::pair<double, size_t> {
        mpm->syncParticlesToHost();
        double m = 0.0;
        size_t alive = 0;
        for (const auto& p : mpm->getParticles()) {
            if (p.state != 2) {
                m += static_cast<double>(p.m);
                alive++;
            }
        }
        return {m, alive};
    };

    auto [cfd_m0, cfd_e0] = compute_cfd_masses();
    auto [mpm_m0, np0] = compute_mpm_mass();
    const double total_m0 = cfd_m0 + mpm_m0;

    std::vector<double> step_axis, total_mass_hist, exact_mass_hist;
    const int steps = 20;
    const float dt = 1.5e-7f;

    for (int step = 1; step <= steps; ++step) {
        mpm->stepWithDt(dt);
        cfd->erodeMPMParticlesToCFDGPU(mpm.get());

        if (step % 2 == 0 || step == steps) {
            auto [cfd_m, cfd_e] = compute_cfd_masses();
            auto [mpm_m, alive] = compute_mpm_mass();
            step_axis.push_back(static_cast<double>(step));
            total_mass_hist.push_back(cfd_m + mpm_m);
            exact_mass_hist.push_back(total_m0);
        }
    }

    auto [cfd_mf, cfd_ef] = compute_cfd_masses();
    auto [mpm_mf, np_f] = compute_mpm_mass();
    const double eroded_mpm_mass = mpm_m0 - mpm_mf;
    const double gained_cfd_mass = cfd_mf - cfd_m0;

    res.error_l2 = compute_L2_norm(total_mass_hist, exact_mass_hist);
    res.error_linf = compute_Linf_norm(total_mass_hist, exact_mass_hist);
    res.momentum_drift = std::abs((cfd_mf + mpm_mf) - total_m0) / std::max(1.0e-12, total_m0);
    res.energy_drift = std::abs(gained_cfd_mass - eroded_mpm_mass) / std::max(1.0e-12, mpm_m0);

    res.svg_path = "vv_plots/" + res.id + ".svg";
    generate_svg_plot(res.svg_path,
                      res.id + ": " + res.title,
                      "Step", "Combined MPM + FV Total Mass (kg)",
                      step_axis, exact_mass_hist, total_mass_hist, 1.0, 5.0);

    res.passed = (np0 > 0) &&
                 (np_f < np0) &&
                 (eroded_mpm_mass > 0.0) &&
                 (res.error_l2 <= res.tolerance_l2) &&
                 (res.error_linf <= res.tolerance_linf) &&
                 (res.energy_drift <= res.tolerance_energy);

    std::ostringstream sum;
    sum << "Dual-Grid Sparse MPM (" << mpm_nx << "^3, dx=" << mpm_dx << "m) -> Coarse FV ("
        << cfd_nx << "^3, dx=" << cfd_dx << "m): eroded " << (np0 - np_f) << "/" << np0
        << " MPM particles (" << fmt_sci(eroded_mpm_mass) << " kg), FV gained "
        << fmt_sci(gained_cfd_mass) << " kg mass, conservation error=" << fmt_sci(res.error_l2) << ".";
    res.summary = sum.str();

    std::ostringstream det;
    det << "- **Dual-Mesh Discretization:** Fine Sparse MPM Grid `" << mpm_nx << " x " << mpm_ny << " x " << mpm_nz
        << "` (`dx_mpm = " << mpm_dx << " m`, `Np_init = " << np0 << "`) coupled to Coarse Dense FV CFD Grid `"
        << cfd_nx << " x " << cfd_ny << " x " << cfd_nz << "` (`dx_cfd = " << cfd_dx << " m`).\n"
        << "- **Particle Erosion & FV Injection:** `" << (np0 - np_f) << " / " << np0
        << "` MPM explosive particles eroded (`dm_mpm = -" << fmt_sci(eroded_mpm_mass)
        << " kg`); coarse FV grid gained `+" << fmt_sci(gained_cfd_mass)
        << " kg` total mass and `+" << fmt_sci(cfd_ef - cfd_e0) << " J` total energy.\n"
        << "- **Conservation Norms:** Combined MPM + FV total mass `e_L2 = " << fmt_sci(res.error_l2)
        << "`, `e_Linf = " << fmt_sci(res.error_linf)
        << "`, MPM-to-FV mass transfer discrepancy = `" << fmt_sci(res.energy_drift) << "`.";
    res.details = det.str();
    return res;
}

} // namespace

std::vector<BenchmarkResult> run_mpm_sparse_grid_benchmarks() {
    std::vector<BenchmarkResult> out;
    out.push_back(run_2d_cpu_sparse_parity());
    out.push_back(run_3d_cpu_sparse_parity());
    out.push_back(run_3d_gpu_sparse_parity());
    out.push_back(run_3d_mpm_density_erosion());
    out.push_back(run_3d_dual_grid_mpm_fv_erosion());
    return out;
}

} // namespace Blast::VV
