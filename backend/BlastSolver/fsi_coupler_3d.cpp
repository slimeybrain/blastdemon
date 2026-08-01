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

    // Map CFD gas pressure to solid grid nodes external force
    for (int i = 0; i < nx; ++i) {
        for (int j = 0; j < ny; ++j) {
            for (int k = 0; k < nz; ++k) {
                size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                auto& node = grid[node_idx];

                if (node.m > 1.0e-8f) {
                    std::vector<float> cell_vals = m_cfd_solver->getCellValues(i, j, k);
                    if (cell_vals.size() >= 5) {
                        float p_gas = cell_vals[4]; // Pressure is index 4 in cell values
                        if (p_gas > 0.0f) {
                            // Compute pressure gradient / surface penalty force on solid boundary nodes
                            node.f_ext[0] += p_gas * cell_area_yz * 0.1f;
                            node.f_ext[1] += p_gas * cell_area_zx * 0.1f;
                            node.f_ext[2] += p_gas * cell_area_xy * 0.1f;
                        }
                    }
                }
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
