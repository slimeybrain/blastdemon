#include "fsi_coupler_3d.hpp"
#include <algorithm>
#include <cmath>
#include <iostream>

namespace Blast {

FSICoupler3D::FSICoupler3D() {}

void FSICoupler3D::attachSolvers(CFDSolver3D* cfd_solver, MPMSolver3D* mpm_solver) {
    m_cfd_solver = cfd_solver;
    m_mpm_solver = mpm_solver;
}

float FSICoupler3D::computeCoupledDt(float cfl) const {
    float dt_mpm = m_mpm_solver ? m_mpm_solver->computeStepSize(cfl) : 1.0e-5f;
    float dt_cfd = m_cfd_solver ? static_cast<float>(m_cfd_solver->computeStepSize(cfl)) : 1.0e-5f;
    return std::min(dt_mpm, dt_cfd);
}

void FSICoupler3D::applyFluidPressureToSolid(float dt) {
    if (!m_cfd_solver || !m_mpm_solver) return;

    int nx = m_mpm_solver->getNx();
    int ny = m_mpm_solver->getNy();
    int nz = m_mpm_solver->getNz();
    float dx = m_mpm_solver->getDx();
    float dy = m_mpm_solver->getDy();
    float dz = m_mpm_solver->getDz();

    float cell_area_xy = dx * dy;
    float cell_area_yz = dy * dz;
    float cell_area_zx = dz * dx;

    auto& grid = m_mpm_solver->getGrid();

    auto is_fluid = [&](int xi, int yi, int zi) -> bool {
        if (xi < 0 || xi >= nx || yi < 0 || yi >= ny || zi < 0 || zi >= nz) return false;
        size_t idx = (static_cast<size_t>(xi) * ny + yi) * nz + zi;
        return grid[idx].m <= 1.0e-8f;
    };

    auto get_cell_p = [&](int xi, int yi, int zi) -> float {
        auto cv = m_cfd_solver->getCellValues(xi, yi, zi);
        if (!cv.empty() && cv[0] > 0.0f) return cv[0];
        return 0.0f;
    };

    // Map CFD gas pressure to solid grid nodes external force
    for (int i = 0; i < nx; ++i) {
        for (int j = 0; j < ny; ++j) {
            for (int k = 0; k < nz; ++k) {
                size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                auto& node = grid[node_idx];

                if (node.m > 1.0e-8f) {
                    float f_x = 0.0f, f_y = 0.0f, f_z = 0.0f;
                    if (i > 0 && is_fluid(i-1, j, k)) f_x += get_cell_p(i-1, j, k);
                    if (i < nx-1 && is_fluid(i+1, j, k)) f_x -= get_cell_p(i+1, j, k);
                    if (j > 0 && is_fluid(i, j-1, k)) f_y += get_cell_p(i, j-1, k);
                    if (j < ny-1 && is_fluid(i, j+1, k)) f_y -= get_cell_p(i, j+1, k);
                    if (k > 0 && is_fluid(i, j, k-1)) f_z += get_cell_p(i, j, k-1);
                    if (k < nz-1 && is_fluid(i, j, k+1)) f_z -= get_cell_p(i, j, k+1);

                    node.f_ext[0] += f_x * cell_area_yz;
                    node.f_ext[1] += f_y * cell_area_zx;
                    node.f_ext[2] += f_z * cell_area_xy;
                }
            }
        }
    }

    // Apply blast aerodynamic drag to discrete DEM particles
    auto& particles = m_mpm_solver->getParticles();
    for (auto& p : particles) {
        if (p.state == 1 || p.has_failed) {
            int ci = std::clamp(static_cast<int>(std::floor((p.x[0] - m_mpm_solver->getXMin()) / dx)), 0, nx - 1);
            int cj = std::clamp(static_cast<int>(std::floor((p.x[1] - m_mpm_solver->getYMin()) / dy)), 0, ny - 1);
            int ck = std::clamp(static_cast<int>(std::floor((p.x[2] - m_mpm_solver->getZMin()) / dz)), 0, nz - 1);
            auto cv = m_cfd_solver->getCellValues(ci, cj, ck);
            if (cv.size() >= 5) {
                float rho_gas = cv[1];
                float u_gas = cv[2];
                float v_gas = cv[3];
                float w_gas = cv[4];

                float rel_vx = u_gas - p.v[0];
                float rel_vy = v_gas - p.v[1];
                float rel_vz = w_gas - p.v[2];
                float rel_v = std::sqrt(rel_vx * rel_vx + rel_vy * rel_vy + rel_vz * rel_vz);

                float r_p = (p.contact_radius > 0.0f) ? p.contact_radius : 0.005f;
                float A_p = 3.14159265f * r_p * r_p;
                float Cd = 1.2f;
                float F_drag = 0.5f * Cd * rho_gas * A_p * rel_v;

                float m_p = std::max(1.0e-12f, p.m);
                p.v[0] += dt * (F_drag * rel_vx) / m_p;
                p.v[1] += dt * (F_drag * rel_vy) / m_p;
                p.v[2] += dt * (F_drag * rel_vz) / m_p;
            }
        }
    }
}

void FSICoupler3D::enforceSolidVelocityOnFluid() {
    // Immersed boundary velocity synchronization
}

void FSICoupler3D::stepWithDt(float dt) {
    if (!m_cfd_solver || !m_mpm_solver) return;

    m_sim_time += static_cast<double>(dt);
    m_step_count++;

    // Step 1: P2G on MPM Solid
    m_mpm_solver->particleToGrid();

    // Step 2: Transfer fluid gas pressure onto MPM solid grid nodes
    applyFluidPressureToSolid(dt);

    // Step 3: Advance MPM Solid solver by dt
    m_mpm_solver->stepWithDt(dt, false);

    // Step 4: Advance CFD Gas Dynamics solver by dt
    m_cfd_solver->step(static_cast<double>(dt));
}

void FSICoupler3D::step(float cfl) {
    float dt = computeCoupledDt(cfl);
    stepWithDt(dt);
}

} // namespace Blast
