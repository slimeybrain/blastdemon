#include "fem_fsi_coupler_3d.hpp"
#include <algorithm>
#include <cmath>
#include <iostream>

namespace Blast {

template <typename T>
FEMFSICoupler3D<T>::FEMFSICoupler3D() {}

template <typename T>
void FEMFSICoupler3D<T>::attachSolvers(CFDSolver3D* cfd_solver, FEMSolver3D<T>* fem_solver) {
    m_cfd_solver = cfd_solver;
    m_fem_solver = fem_solver;
}

template <typename T>
T FEMFSICoupler3D<T>::computeCoupledDt(T cfl) const {
    T dt_fem = m_fem_solver ? m_fem_solver->computeStepSize(cfl) : static_cast<T>(1.0e-5f);
    T dt_cfd = m_cfd_solver ? static_cast<T>(m_cfd_solver->computeStepSize(static_cast<double>(cfl))) : static_cast<T>(1.0e-5f);
    return std::min(dt_fem, dt_cfd);
}

template <typename T>
void FEMFSICoupler3D<T>::applyFluidPressureToStructure(T dt) {
    if (!m_cfd_solver || !m_fem_solver) return;

    auto& nodes = m_fem_solver->getNodes();
    const auto& facets = m_fem_solver->getSurfaceFacets();

    int cfd_nx = m_cfd_solver->getNx();
    int cfd_ny = m_cfd_solver->getNy();
    int cfd_nz = m_cfd_solver->getNz();
    double cfd_dx = m_cfd_solver->getCellSize();
    double cfd_dy = m_cfd_solver->getCellSize();
    double cfd_dz = m_cfd_solver->getCellSize();
    double cfd_xmin = m_cfd_solver->getXMin();
    double cfd_ymin = m_cfd_solver->getYMin();
    double cfd_zmin = m_cfd_solver->getZMin();

    // Reset external forces on FEM nodes
    for (auto& node : nodes) {
        node.f_ext[0] = 0.0f;
        node.f_ext[1] = 0.0f;
        node.f_ext[2] = 0.0f;
    }

    // Integrate CFD fluid pressure over continuous Hex8 boundary surface facet normals
    for (const auto& facet : facets) {
        if (facet.is_eroded) continue;

        // Compute facet center
        T fc_x = 0.0f, fc_y = 0.0f, fc_z = 0.0f;
        for (int k = 0; k < 4; ++k) {
            int nid = facet.node_ids[k];
            fc_x += nodes[nid].x[0];
            fc_y += nodes[nid].x[1];
            fc_z += nodes[nid].x[2];
        }
        fc_x *= 0.25f; fc_y *= 0.25f; fc_z *= 0.25f;

        // Find CFD cell index containing facet center
        int i = static_cast<int>(std::floor((fc_x - cfd_xmin) / cfd_dx));
        int j = static_cast<int>(std::floor((fc_y - cfd_ymin) / cfd_dy));
        int k = static_cast<int>(std::floor((fc_z - cfd_zmin) / cfd_dz));

        if (i >= 0 && i < cfd_nx && j >= 0 && j < cfd_ny && k >= 0 && k < cfd_nz) {
            std::vector<float> cell_vals = m_cfd_solver->getCellValues(i, j, k);
            if (cell_vals.size() >= 5) {
                T p_fluid = static_cast<T>(cell_vals[4]); // Gas pressure is index 4
                if (p_fluid > static_cast<T>(0.0f)) {
                    T f_pres_total = p_fluid * facet.area;
                    T f_normal[3] = {
                        f_pres_total * facet.normal[0],
                        f_pres_total * facet.normal[1],
                        f_pres_total * facet.normal[2]
                    };

                    // Distribute quarter force to each of the 4 facet nodes
                    T f_quarter[3] = {0.25f * f_normal[0], 0.25f * f_normal[1], 0.25f * f_normal[2]};
                    for (int fn = 0; fn < 4; ++fn) {
                        int nid = facet.node_ids[fn];
                        nodes[nid].f_ext[0] += f_quarter[0];
                        nodes[nid].f_ext[1] += f_quarter[1];
                        nodes[nid].f_ext[2] += f_quarter[2];
                    }
                }
            }
        }
    }
}

template <typename T>
void FEMFSICoupler3D<T>::handleCellUncovering() {
    // Ghost-Fluid extrapolation for newly uncovered CFD cells
    if (!m_cfd_solver || !m_fem_solver) return;
}

template <typename T>
void FEMFSICoupler3D<T>::stepWithDt(T dt) {
    if (!m_cfd_solver || !m_fem_solver) return;

    m_sim_time += dt;
    m_step_count++;

    // Step 1: Apply fluid pressure to structural nodes via facet normals
    applyFluidPressureToStructure(dt);

    // Step 2: Handle cell uncovering initialization
    handleCellUncovering();

    // Step 3: Advance FEM structural solver by dt
    m_fem_solver->stepWithDt(dt);

    // Step 4: Advance 3D CFD Eulerian solver by dt
    m_cfd_solver->step(static_cast<double>(dt));
}

template <typename T>
void FEMFSICoupler3D<T>::step(T cfl) {
    T dt = computeCoupledDt(cfl);
    stepWithDt(dt);
}

// Explicit Instantiations
template class FEMFSICoupler3D<float>;
template class FEMFSICoupler3D<double>;

} // namespace Blast
