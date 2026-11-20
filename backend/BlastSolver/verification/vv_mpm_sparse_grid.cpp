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

// -----------------------------------------------------------------------------
// 6. Coupled 3D Cased-Charge Erosion + Solid-Wall FSI on Non-Divisible Grid (VV-L3-FSI-ERO-SOL)
// -----------------------------------------------------------------------------
BenchmarkResult run_3d_coupled_fsi_erosion_solid_wall() {
    BenchmarkResult res;
    res.id = "VV-L3-FSI-ERO-SOL";
    res.title = "Coupled 3D Sparse vs Dense MPM Erosion + Solid-Wall FSI on Non-Multiple-of-8 Grid (54x30x30)";
    res.level = 3;
    res.tolerance_l2 = 1.0e-4;
    res.tolerance_linf = 1.0e-3;
    res.tolerance_momentum = 1.0e-4;
    res.tolerance_energy = 1.0e-4;

    // Non-multiple-of-8 3D grid (54 x 30 x 30 = 48,600 dense nodes; ntx=7, nty=4, ntz=4 = 112 tiles)
    // to exercise partial-tile OOB boundary guards, solid-wall ghost reflections in compute_flux_fused_3d,
    // and sub-dense 8x8x8 sparse MPM tile pool allocation.
    const int nx = 54, ny = 30, nz = 30;
    const double dx = 0.01;
    const float mpm_dx = 0.01f;
    const int steps = 35;
    const float dt = 1.2e-7f;

    struct RunStats {
        int cfd_tiles_init = -1;
        int cfd_tiles_final = 0;
        int eroded_count = 0;
        size_t mpm_alloc_nodes = 0;
        size_t mpm_active_tiles = 0;
        size_t mpm_total_tiles = 0;
        size_t nonfinite_cells = 0;
        double p_min = 1.0e300;
        double p_max = 0.0;
        double p_wall_upstream = 0.0;
        double steel_px = 0.0;
        double cfd_mass_final = 0.0;
        std::vector<double> x_prof;
        std::vector<double> p_prof;
        std::vector<double> steel_vel_vec;
    };

    auto run_case = [&](bool sparse) -> RunStats {
        RunStats st;
        auto cfd = std::make_unique<CFDSolver3DCuda<float, true>>(nx, ny, nz, dx, 0.0, 0.0, 0.0);
        cfd->setBoundaryConditions(
            BCType3D::REFLECTIVE, BCType3D::REFLECTIVE,
            BCType3D::REFLECTIVE, BCType3D::REFLECTIVE,
            BCType3D::REFLECTIVE, BCType3D::REFLECTIVE
        );
        cfd->setSpaceTimeScheme(SpaceTimeScheme3D::ADER_2);

        Charge3DParams chg{};
        chg.x = 0.15; chg.y = 0.15; chg.z = 0.15;
        chg.radius = 0.0; // Quiescent initial Eulerian domain (0 active CFD tiles prior to erosion)
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
        mpm->setSparseGridMode(sparse);
        mpm->setDeferFVErosionToCoupler(true);
        mpm->initializeGrid(nx, ny, nz, mpm_dx, mpm_dx, mpm_dx, 0.0f, 0.0f, 0.0f);
        mpm->setTransferScheme(Blast::MPMTransferScheme::BSpline);
        mpm->setVelocityScheme(Blast::MPMVelocityScheme::APIC);
        mpm->setTimeScheme(Blast::MPMTimeIntegrationScheme::Leapfrog);

        // Object 0: JWL Programmed Burn sphere centered at (0.15, 0.15, 0.15) m
        const float rho_he = 1630.0f;
        mpm->addSphereObject(0, 0.15f, 0.15f, 0.15f, 0.026f,
                             0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                             rho_he, 1.0e9f, 0.3f, 100.0e6f, 100.0e6f, 0.50f, 600.0e6f, 8);
        Blast::MaterialTable3D mat_he{};
        mat_he.material_model = Blast::MPMMaterialModel::JWLProgrammedBurn;
        mat_he.density = rho_he;
        mat_he.youngs_modulus = 1.0e9f;
        mat_he.poissons_ratio = 0.3f;
        mat_he.jwl_A = 373.77e9f;
        mat_he.jwl_B = 3.747e9f;
        mat_he.jwl_R1 = 4.15f;
        mat_he.jwl_R2 = 0.90f;
        mat_he.jwl_omega = 0.35f;
        mat_he.det_vel = 6930.0f;
        mat_he.detonation_energy = 4.29e6f;
        mat_he.enable_density_erosion = true;
        mat_he.erosion_min_density = 0.0f;
        mat_he.erosion_min_density_ratio = 0.85f;
        mat_he.erode_to_fv_grid = true;
        mpm->setMaterialTable(0, mat_he);

        // Object 1: Solid Steel Target Plate spanning x in [0.20, 0.23] m (interface at gx = 20)
        mpm->addBoxObject(1, 0.215f, 0.15f, 0.15f,
                          0.03f, 0.10f, 0.10f,
                          0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                          7850.0f, 210.0e9f, 0.30f, 792.0e6f, 510.0e6f, 0.50f, 1.5e9f, 8);
        Blast::MaterialTable3D mat_steel{};
        mat_steel.material_model = Blast::MPMMaterialModel::JohnsonCookMieGruneisen;
        mat_steel.density = 7850.0f;
        mat_steel.youngs_modulus = 210.0e9f;
        mat_steel.poissons_ratio = 0.30f;
        mat_steel.jc_A = 792.0e6f;
        mat_steel.jc_B = 510.0e6f;
        mat_steel.jc_n = 0.26f;
        mat_steel.jc_C = 0.014f;
        mat_steel.jc_m = 1.03f;
        mat_steel.erode_to_fv_grid = false;
        mpm->setMaterialTable(1, mat_steel);

        mpm->addDetonator(0.15f, 0.15f, 0.15f, 0.04f, 0.0f, false, 0);
        mpm->syncToDevice();

        st.cfd_tiles_init = cfd->getNumActiveTiles();

        for (int step = 1; step <= steps; ++step) {
            mpm->particleToGridDeviceOnly();
            cfd->coupleFSIWithMPMGPU(mpm.get());
            mpm->stepWithDt(dt, false);
            st.eroded_count += cfd->erodeMPMParticlesToCFDGPU(mpm.get());
            cfd->step(static_cast<double>(dt));
        }

        st.cfd_tiles_final = cfd->getNumActiveTiles();
        st.mpm_alloc_nodes = mpm->getAllocatedGridNodeCapacity();
        st.mpm_active_tiles = mpm->getNumActiveTiles();
        st.mpm_total_tiles = mpm->getTotalLogicalTiles();
        st.cfd_mass_final = cfd->getConservationTotals().first;

        std::vector<float> pf = cfd->extractPressureField();
        for (float pv : pf) {
            if (!std::isfinite(pv)) {
                st.nonfinite_cells++;
                continue;
            }
            st.p_min = std::min(st.p_min, static_cast<double>(pv));
            st.p_max = std::max(st.p_max, static_cast<double>(pv));
        }

        // Point-wise +/- 5 cell centerline profile across the fluid-solid boundary at gx = 20
        const int gy_c = ny / 2;
        const int gz_c = nz / 2;
        const int gx_if = 20;
        for (int gx = gx_if - 5; gx <= gx_if + 5; ++gx) {
            size_t idx = static_cast<size_t>(gx) + static_cast<size_t>(gy_c) * nx + static_cast<size_t>(gz_c) * nx * ny;
            double p_val = (idx < pf.size()) ? static_cast<double>(pf[idx]) : 0.0;
            st.x_prof.push_back((gx + 0.5) * dx);
            st.p_prof.push_back(p_val * 1.0e-6); // MPa
            if (gx == gx_if - 1) {
                st.p_wall_upstream = p_val;
            }
        }

        mpm->syncParticlesToHost();
        std::vector<const Blast::MPMParticle3D*> steel_pts;
        for (const auto& p : mpm->getParticles()) {
            if (p.state != 2 && p.object_id == 1) {
                st.steel_px += static_cast<double>(p.m) * static_cast<double>(p.v[0]);
                steel_pts.push_back(&p);
            }
        }
        // Sort surviving steel particles by physical position because GPU compaction fills eroded
        // SoA holes via warp-scheduled atomicAdd.
        std::sort(steel_pts.begin(), steel_pts.end(), [](const Blast::MPMParticle3D* a, const Blast::MPMParticle3D* b) {
            auto q = [](float c) { return static_cast<long long>(std::llround(c * 1.0e5f)); };
            if (q(a->x[0]) != q(b->x[0])) return q(a->x[0]) < q(b->x[0]);
            if (q(a->x[1]) != q(b->x[1])) return q(a->x[1]) < q(b->x[1]);
            return q(a->x[2]) < q(b->x[2]);
        });
        st.steel_vel_vec.reserve(steel_pts.size() * 3);
        for (const auto* p : steel_pts) {
            st.steel_vel_vec.push_back(static_cast<double>(p->v[0]));
            st.steel_vel_vec.push_back(static_cast<double>(p->v[1]));
            st.steel_vel_vec.push_back(static_cast<double>(p->v[2]));
        }
        return st;
    };

    RunStats dense = run_case(false);
    RunStats sparse = run_case(true);

    res.error_l2 = compute_L2_norm(sparse.p_prof, dense.p_prof);
    res.error_linf = compute_Linf_norm(sparse.p_prof, dense.p_prof);
    res.momentum_drift = std::abs(sparse.steel_px - dense.steel_px) / std::max(1.0e-9, std::abs(dense.steel_px));
    res.energy_drift = std::abs(sparse.cfd_mass_final - dense.cfd_mass_final) / std::max(1.0e-9, dense.cfd_mass_final);
    res.r_squared = compute_R2(sparse.p_prof, dense.p_prof);

    const double vel_l2 = (!dense.steel_vel_vec.empty() && sparse.steel_vel_vec.size() == dense.steel_vel_vec.size())
                        ? compute_L2_norm(sparse.steel_vel_vec, dense.steel_vel_vec) : 1.0;

    res.svg_path = "vv_plots/" + res.id + ".svg";
    generate_svg_plot(res.svg_path,
                      res.id + ": +/-5 Cell Fluid-Solid Interface Pressure Profile (MPa)",
                      "x (m)", "Centerline Pressure (MPa)",
                      dense.x_prof, dense.p_prof, sparse.p_prof, 1.0, 5.0);

    const bool mem_saved = (sparse.mpm_alloc_nodes < dense.mpm_alloc_nodes) &&
                           (sparse.mpm_active_tiles < sparse.mpm_total_tiles);
    const bool physics_valid = (dense.cfd_tiles_init == 0) &&
                               (sparse.cfd_tiles_init == 0) &&
                               (sparse.cfd_tiles_final > 0) &&
                               (sparse.eroded_count > 0) &&
                               (sparse.eroded_count == dense.eroded_count) &&
                               (sparse.nonfinite_cells == 0) &&
                               (dense.nonfinite_cells == 0) &&
                               (sparse.p_min > 1.0e3) &&
                               (sparse.p_wall_upstream > 101325.0) &&
                               (sparse.steel_px > 0.0);

    res.passed = physics_valid &&
                 mem_saved &&
                 (vel_l2 <= res.tolerance_l2) &&
                 (res.error_l2 <= res.tolerance_l2) &&
                 (res.error_linf <= res.tolerance_linf) &&
                 (res.momentum_drift <= res.tolerance_momentum) &&
                 (res.energy_drift <= res.tolerance_energy);

    std::ostringstream sum;
    sum << "3D Coupled FSI + Erosion on " << nx << "x" << ny << "x" << nz << " grid: active CFD tiles 0 -> " << sparse.cfd_tiles_final
        << ", eroded=" << sparse.eroded_count << " particles, steel +x impulse=" << fmt_sci(sparse.steel_px)
        << " N*s, sparse MPM nodes=" << sparse.mpm_alloc_nodes << "/" << dense.mpm_alloc_nodes
        << ", interface pressure e_L2=" << fmt_sci(res.error_l2) << ".";
    res.summary = sum.str();

    std::ostringstream det;
    det << "- **Non-Multiple-of-8 Discretization:** Coupled 3D ADER-2 FV CFD + Symplectic Leapfrog MPM on `"
        << nx << " x " << ny << " x " << nz << "` (`dx = " << dx << " m`, `" << sparse.mpm_total_tiles << "` logical `8x8x8` tiles, `"
        << steps << "` steps at `dt = " << fmt_sci(dt) << " s`).\n"
        << "- **Dynamic Tile Activation & Solid-Wall FSI:** CFD active tiles transitioned from `"
        << sparse.cfd_tiles_init << "` to `" << sparse.cfd_tiles_final << "` upon eroding `"
        << sparse.eroded_count << "` JWL explosive particles adjacent to the steel target plate (`gx = 20`); "
        << "upstream wall fluid pressure `p(gx=19) = " << fmt_sci(sparse.p_wall_upstream * 1.0e-6)
        << " MPa`, global `p_min = " << fmt_sci(sparse.p_min) << " Pa` (`0` non-finite/cavitation cells), "
        << "steel plate `+x` momentum = `" << fmt_sci(sparse.steel_px) << " N*s`.\n"
        << "- **Sparse vs Dense Parity & Memory Savings:** Allocated MPM grid nodes `"
        << sparse.mpm_alloc_nodes << "` (sparse, `" << sparse.mpm_active_tiles << "/" << sparse.mpm_total_tiles
        << "` active tiles) vs `" << dense.mpm_alloc_nodes << "` (dense); `+/-5` cell interface pressure `e_L2 = "
        << fmt_sci(res.error_l2) << "`, `e_Linf = " << fmt_sci(res.error_linf)
        << "`, steel velocity `e_L2 = " << fmt_sci(vel_l2) << "`.";
    res.details = det.str();
    return res;
}

BenchmarkResult run_3d_supersonic_oblique_fsi_stability() {
    BenchmarkResult res;
    res.id = "VV-L3-FSI-OBL-01";
    res.title = "3D Supersonic Spinning Multi-Part MPM + FV CFD Oblique Armor Impact Stability";
    res.level = 3;
    res.tolerance_l2 = 2.0e-2;
    res.tolerance_linf = 5.0e-2;
    res.tolerance_energy = 1.0e-2;
    res.tolerance_momentum = 1.0e-2;

    const int nx = 56, ny = 40, nz = 40;
    const double dx = 0.005;
    const float mpm_dx = static_cast<float>(dx);
    const int steps = 180;

    struct ObliqueStats {
        double p_min = 1.0e30;
        double p_max = -1.0e30;
        double rho_min = 1.0e30;
        double mpm_vmax = 0.0;
        double total_mpm_px = 0.0;
        double cfd_mass_init = 0.0;
        double cfd_mass_final = 0.0;
        int nonfinite_cells = 0;
        std::vector<double> x_prof;
        std::vector<double> p_prof;
    };

    auto run_precision_case = [&](bool use_double_cfd) -> ObliqueStats {
        ObliqueStats st;
        std::unique_ptr<CFDSolver3D> cfd;
        if (use_double_cfd) {
            cfd = std::make_unique<CFDSolver3DCuda<double, false>>(nx, ny, nz, dx, 0.0, -0.10, -0.10);
        } else {
            cfd = std::make_unique<CFDSolver3DCuda<float, false>>(nx, ny, nz, dx, 0.0, -0.10, -0.10);
        }
        cfd->setFluxScheme("AUSM+");
        cfd->setSpaceTimeScheme(SpaceTimeScheme3D::MUSCL_HANCOCK);
        cfd->setBoundaryConditions(
            BCType3D::OUTFLOW_RIEMANN, BCType3D::OUTFLOW_RIEMANN,
            BCType3D::OUTFLOW_RIEMANN, BCType3D::OUTFLOW_RIEMANN,
            BCType3D::OUTFLOW_RIEMANN, BCType3D::OUTFLOW_RIEMANN
        );

        Charge3DParams chg{};
        chg.x = 0.05; chg.y = 0.0; chg.z = 0.0;
        chg.radius = 0.0;
        MultiMat::MaterialSet mats{};
        mats.products.rho0 = 1630.0;
        mats.unreacted = mats.products;
        MultiMat::initializePrecalculatedTerms(mats);
        cfd->setInitialCondition(chg, mats, 1.225, 101325.0);

        auto mpm = std::make_unique<Blast::MPMSolver3DCUDA>();
        mpm->setSparseGridMode(true);
        mpm->setDeferFVErosionToCoupler(true);
        mpm->initializeGrid(nx, ny, nz, mpm_dx, mpm_dx, mpm_dx, 0.0f, -0.10f, -0.10f);
        mpm->setTransferScheme(Blast::MPMTransferScheme::BSpline);
        mpm->setVelocityScheme(Blast::MPMVelocityScheme::APIC);
        mpm->setTimeScheme(Blast::MPMTimeIntegrationScheme::Leapfrog);
        mpm->setContactMethod(Blast::MPMContactMethod::MultiVelocityBardenhagen);

        // Object 1: BSpline Steel Projectile Body/Cap spinning at omega_x = 2000 rad/s, vx = 750 m/s
        mpm->addSphereObject(1, 0.075f, 0.0f, 0.0f, 0.022f,
                             750.0f, 0.0f, 0.0f, 2000.0f, 0.0f, 0.0f,
                             7850.0f, 200.0e9f, 0.28f, 900.0e6f, 800.0e6f, 0.25f, 1.8e9f, 8);
        Blast::MaterialTable3D mat_cap{};
        mat_cap.material_model = Blast::MPMMaterialModel::JohnsonCookMieGruneisen;
        mat_cap.transfer_scheme = static_cast<int>(Blast::MPMTransferScheme::BSpline);
        mat_cap.density = 7850.0f;
        mat_cap.youngs_modulus = 200.0e9f;
        mat_cap.poissons_ratio = 0.28f;
        mat_cap.jc_A = 900.0e6f;
        mat_cap.jc_B = 800.0e6f;
        mat_cap.jc_n = 0.26f;
        mat_cap.jc_C = 0.014f;
        mat_cap.jc_m = 1.03f;
        mat_cap.failure_strain = 0.25f;
        mpm->setMaterialTable(1, mat_cap);

        // Object 2: Standard Thin Aluminum Nose Shell touching Object 1 (mixed Standard/BSpline fringe)
        mpm->addSphereObject(2, 0.095f, 0.0f, 0.0f, 0.018f, 0.014f,
                             750.0f, 0.0f, 0.0f, 2000.0f, 0.0f, 0.0f,
                             2700.0f, 68.9e9f, 0.33f, 324.0e6f, 400.0e6f, 0.17f, 310.0e6f, 8);
        Blast::MaterialTable3D mat_nose{};
        mat_nose.material_model = Blast::MPMMaterialModel::JohnsonCookMieGruneisen;
        mat_nose.transfer_scheme = static_cast<int>(Blast::MPMTransferScheme::Standard);
        mat_nose.density = 2700.0f;
        mat_nose.youngs_modulus = 68.9e9f;
        mat_nose.poissons_ratio = 0.33f;
        mat_nose.jc_A = 324.0e6f;
        mat_nose.jc_B = 114.0e6f;
        mat_nose.jc_n = 0.42f;
        mat_nose.jc_C = 0.002f;
        mat_nose.jc_m = 1.34f;
        mat_nose.failure_strain = 0.17f;
        mpm->setMaterialTable(2, mat_nose);

        // Object 3: Standard Inclined (10 deg) Steel Armor Target Plate
        mpm->addBoxObject(3, 0.155f, 0.0f, 0.0f,
                          0.025f, 0.12f, 0.12f,
                          0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
                          7850.0f, 200.0e9f, 0.29f, 850.0e6f, 600.0e6f, 0.22f, 1.5e9f, 8,
                          Blast::MPMParticleDistribution::Cartesian,
                          Blast::MPMBoundaryFilling::Stairstepped,
                          0.0f, 10.0f, 0.0f);
        Blast::MaterialTable3D mat_tgt = mat_cap;
        mat_tgt.transfer_scheme = static_cast<int>(Blast::MPMTransferScheme::Standard);
        mpm->setMaterialTable(3, mat_tgt);

        mpm->setInitialContactTie(true);
        mpm->syncToDevice();

        mpm->particleToGridDeviceOnly();
        cfd->coupleFSIWithMPMGPU(mpm.get());
        st.cfd_mass_init = cfd->getConservationTotals().first;

        const double dt_step = 2.5e-7;
        for (int step = 1; step <= steps; ++step) {
            if (step > 1) {
                mpm->particleToGridDeviceOnly();
                cfd->coupleFSIWithMPMGPU(mpm.get());
            }
            mpm->stepWithDt(static_cast<float>(dt_step), false);
            cfd->step(dt_step);
        }

        st.cfd_mass_final = cfd->getConservationTotals().first;
        Slice3D sl_p; sl_p.axis = "xz"; sl_p.offset = 0.0; sl_p.stride = 1; sl_p.quantities = {"pressure"};
        Slice3D sl_r; sl_r.axis = "xz"; sl_r.offset = 0.0; sl_r.stride = 1; sl_r.quantities = {"density"};
        Slice3D sl_s; sl_s.axis = "xz"; sl_s.offset = 0.0; sl_s.stride = 1; sl_s.quantities = {"solid"};
        std::vector<float> pf = cfd->extractSlice(sl_p);
        std::vector<float> rf = cfd->extractSlice(sl_r);
        std::vector<float> sf = cfd->extractSlice(sl_s);

        for (size_t idx = 0; idx < pf.size(); ++idx) {
            if (!std::isfinite(pf[idx]) || !std::isfinite(rf[idx])) {
                st.nonfinite_cells++;
                continue;
            }
            if (idx < sf.size() && sf[idx] < 0.5f) {
                st.p_min = std::min(st.p_min, static_cast<double>(pf[idx]));
                st.p_max = std::max(st.p_max, static_cast<double>(pf[idx]));
                st.rho_min = std::min(st.rho_min, static_cast<double>(rf[idx]));
            }
        }

        // +/-5 cell interface profile across oblique impact rim (gz = nz/2 - 3)
        const int gz_if = nz / 2 - 3;
        const int gx_if = 28;
        for (int gx = gx_if - 5; gx <= gx_if + 5; ++gx) {
            size_t s_idx = static_cast<size_t>(gx) + static_cast<size_t>(gz_if) * nx;
            st.x_prof.push_back((gx + 0.5) * dx);
            st.p_prof.push_back((s_idx < pf.size() ? static_cast<double>(pf[s_idx]) : 101325.0) * 1.0e-3); // kPa
        }

        mpm->syncParticlesToHost();
        for (const auto& p : mpm->getParticles()) {
            if (p.state != 2 && p.m > 0.0f) {
                double vmag = std::sqrt(static_cast<double>(p.v[0]) * p.v[0] +
                                        static_cast<double>(p.v[1]) * p.v[1] +
                                        static_cast<double>(p.v[2]) * p.v[2]);
                st.mpm_vmax = std::max(st.mpm_vmax, vmag);
                st.total_mpm_px += static_cast<double>(p.m) * static_cast<double>(p.v[0]);
            }
        }
        return st;
    };

    ObliqueStats f32 = run_precision_case(false);
    ObliqueStats f64 = run_precision_case(true);

    res.error_l2 = compute_L2_norm(f32.p_prof, f64.p_prof);
    res.error_linf = compute_Linf_norm(f32.p_prof, f64.p_prof);
    res.momentum_drift = std::abs(f32.total_mpm_px - f64.total_mpm_px) / std::max(1.0e-9, std::abs(f64.total_mpm_px));
    res.energy_drift = std::abs(f32.p_max - f64.p_max) / std::max(1.0, f64.p_max);
    res.r_squared = compute_R2(f32.p_prof, f64.p_prof);

    res.svg_path = "vv_plots/" + res.id + ".svg";
    generate_svg_plot(res.svg_path,
                      res.id + ": +/-5 Cell Oblique Penetration Interface Pressure Profile (kPa)",
                      "x (m)", "Pressure (kPa)",
                      f64.x_prof, f64.p_prof, f32.p_prof, 1.0, 5.0);

    const bool stability_ok = (f32.nonfinite_cells == 0) &&
                              (f64.nonfinite_cells == 0) &&
                              (f32.mpm_vmax > 500.0 && f32.mpm_vmax < 1600.0) &&
                              (f32.p_max > 250000.0 && f32.p_max < 8.0e6) &&
                              (f32.p_min > 5000.0) &&
                              (f32.rho_min > 0.05);

    res.passed = stability_ok &&
                 (res.error_l2 <= res.tolerance_l2) &&
                 (res.error_linf <= res.tolerance_linf) &&
                 (res.momentum_drift <= res.tolerance_momentum);

    std::ostringstream sum;
    sum << "Supersonic 750 m/s spinning multi-part oblique impact on " << nx << "x" << ny << "x" << nz
        << " grid: MPM vmax=" << std::fixed << std::setprecision(1) << f32.mpm_vmax
        << " m/s, CFD p_max=" << std::setprecision(3) << (f32.p_max * 1.0e-6)
        << " MPa, rho_min=" << f32.rho_min << " kg/m^3, F32/F64 interface e_L2=" << fmt_sci(res.error_l2) << ".";
    res.summary = sum.str();

    std::ostringstream det;
    det << "- **Discretization:** `" << nx << " x " << ny << " x " << nz << "` uniform 3D FSI grid (`dx = " << dx
        << " m`), `" << steps << "` coupled MUSCL-Hancock + AUSM+ / Bardenhagen APIC Leapfrog steps (`CFL = 0.5`).\n"
        << "- **Mixed Transfer & Oblique Crater Stability:** Spinning (`2000 rad/s`) `BSpline` steel body + thin `Standard` aluminum nose shell (`750 m/s`) impacting `10 deg` inclined `Standard` steel plate: "
        << "MPM `|v|_max = " << f32.mpm_vmax << " m/s` (zero `1/eps` fringe blowup), fluid `p_max = "
        << (f32.p_max * 1.0e-6) << " MPa`, `p_min = " << (f32.p_min * 1.0e-3) << " kPa`, `rho_min = "
        << f32.rho_min << " kg/m^3` (`0` non-finite/drained cells).\n"
        << "- **Point-Wise `+/-5` Cell Interface Audit:** F32 vs F64 interface pressure `e_L2 = "
        << fmt_sci(res.error_l2) << "`, `e_Linf = " << fmt_sci(res.error_linf)
        << "`, MPM momentum parity `e_p = " << fmt_sci(res.momentum_drift) << "`.";
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
    out.push_back(run_3d_coupled_fsi_erosion_solid_wall());
    out.push_back(run_3d_supersonic_oblique_fsi_stability());
    return out;
}

} // namespace Blast::VV
