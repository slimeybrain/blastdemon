#include "fem_fsi_coupler_3d.hpp"
#include <algorithm>
#include <cmath>
#include <iostream>

namespace Blast {

template <typename T>
FEMFSICoupler3D<T>::FEMFSICoupler3D() {}

template <typename T>
void FEMFSICoupler3D<T>::attachSolvers(CFDSolver3D* fv_solver, FEMSolver3D<T>* fem_solver) {
    m_fv_solver = fv_solver;
    m_fem_solver = fem_solver;
    m_has_prev_mask = false;
    m_accumulated_work_fsi = static_cast<T>(0.0f);
}

template <typename T>
T FEMFSICoupler3D<T>::computeCoupledDt(T cfl) const {
    T dt_fem = m_fem_solver ? m_fem_solver->computeStepSize(cfl) : static_cast<T>(1.0e-5f);
    T dt_fv = m_fv_solver ? static_cast<T>(m_fv_solver->computeStepSize(static_cast<double>(cfl))) : static_cast<T>(1.0e-5f);
    return std::min(dt_fem, dt_fv);
}

template <typename T>
void FEMFSICoupler3D<T>::rasterizeFEMFacetsToFVGrid() {
    if (!m_fv_solver || !m_fem_solver) return;

    int nx = m_fv_solver->getNx();
    int ny = m_fv_solver->getNy();
    int nz = m_fv_solver->getNz();
    double dx = m_fv_solver->getCellSize();
    double dy = m_fv_solver->getCellSize();
    double dz = m_fv_solver->getCellSize();
    double xmin = m_fv_solver->getXMin();
    double ymin = m_fv_solver->getYMin();
    double zmin = m_fv_solver->getZMin();

    size_t total_cells = static_cast<size_t>(nx) * ny * nz;
    if (m_solid_mask.size() != total_cells) {
        m_solid_mask.assign(total_cells, 0);
        m_solid_vel.assign(total_cells * 3, 0.0);
    } else {
        std::fill(m_solid_mask.begin(), m_solid_mask.end(), 0);
        std::fill(m_solid_vel.begin(), m_solid_vel.end(), 0.0);
    }

    const auto& nodes = m_fem_solver->getNodes();
    const auto& facets = m_fem_solver->getSurfaceFacets();

    // 1. Rasterize all active surface facets into the Cartesian FV grid
    for (const auto& facet : facets) {
        if (facet.is_eroded) continue;

        // Facet vertex positions & velocities
        Point3D v0 = { static_cast<float>(nodes[facet.node_ids[0]].x[0]), static_cast<float>(nodes[facet.node_ids[0]].x[1]), static_cast<float>(nodes[facet.node_ids[0]].x[2]) };
        Point3D v1 = { static_cast<float>(nodes[facet.node_ids[1]].x[0]), static_cast<float>(nodes[facet.node_ids[1]].x[1]), static_cast<float>(nodes[facet.node_ids[1]].x[2]) };
        Point3D v2 = { static_cast<float>(nodes[facet.node_ids[2]].x[0]), static_cast<float>(nodes[facet.node_ids[2]].x[1]), static_cast<float>(nodes[facet.node_ids[2]].x[2]) };
        Point3D v3 = { static_cast<float>(nodes[facet.node_ids[3]].x[0]), static_cast<float>(nodes[facet.node_ids[3]].x[1]), static_cast<float>(nodes[facet.node_ids[3]].x[2]) };

        // Average facet velocity
        double avg_vx = 0.25 * (nodes[facet.node_ids[0]].v[0] + nodes[facet.node_ids[1]].v[0] + nodes[facet.node_ids[2]].v[0] + nodes[facet.node_ids[3]].v[0]);
        double avg_vy = 0.25 * (nodes[facet.node_ids[0]].v[1] + nodes[facet.node_ids[1]].v[1] + nodes[facet.node_ids[2]].v[1] + nodes[facet.node_ids[3]].v[1]);
        double avg_vz = 0.25 * (nodes[facet.node_ids[0]].v[2] + nodes[facet.node_ids[1]].v[2] + nodes[facet.node_ids[2]].v[2] + nodes[facet.node_ids[3]].v[2]);

        // Triangles forming the quad
        Triangle triA = { v0, v1, v2 };
        Triangle triB = { v0, v2, v3 };

        // Grid index bounding box
        int imin = std::clamp(static_cast<int>(std::floor((facet.bbox_min[0] - xmin) / dx)), 0, nx - 1);
        int imax = std::clamp(static_cast<int>(std::ceil((facet.bbox_max[0] - xmin) / dx)), 0, nx - 1);
        int jmin = std::clamp(static_cast<int>(std::floor((facet.bbox_min[1] - ymin) / dy)), 0, ny - 1);
        int jmax = std::clamp(static_cast<int>(std::ceil((facet.bbox_max[1] - ymin) / dy)), 0, ny - 1);
        int kmin = std::clamp(static_cast<int>(std::floor((facet.bbox_min[2] - zmin) / dz)), 0, nz - 1);
        int kmax = std::clamp(static_cast<int>(std::ceil((facet.bbox_max[2] - zmin) / dz)), 0, nz - 1);

        float half_dx = static_cast<float>(0.5 * dx);

        for (int k = kmin; k <= kmax; ++k) {
            float cz = static_cast<float>(zmin + (k + 0.5) * dz);
            for (int j = jmin; j <= jmax; ++j) {
                float cy = static_cast<float>(ymin + (j + 0.5) * dy);
                for (int i = imin; i <= imax; ++i) {
                    float cx = static_cast<float>(xmin + (i + 0.5) * dx);
                    Point3D cell_center = { cx, cy, cz };

                    if (tri_box_overlap(cell_center, half_dx, triA) || tri_box_overlap(cell_center, half_dx, triB)) {
                        size_t cfd_idx = static_cast<size_t>(i) + static_cast<size_t>(j) * nx + static_cast<size_t>(k) * nx * ny;
                        m_solid_mask[cfd_idx] = 1;
                        m_solid_vel[3 * cfd_idx + 0] = avg_vx;
                        m_solid_vel[3 * cfd_idx + 1] = avg_vy;
                        m_solid_vel[3 * cfd_idx + 2] = avg_vz;
                    }
                }
            }
        }
    }

    // 2. Mark cells completely inside solid elements as solid
    const auto& elements = m_fem_solver->getElements();
    for (const auto& elem : elements) {
        if (elem.is_eroded) continue;

        T min_x = nodes[elem.node_ids[0]].x[0], max_x = min_x;
        T min_y = nodes[elem.node_ids[0]].x[1], max_y = min_y;
        T min_z = nodes[elem.node_ids[0]].x[2], max_z = min_z;
        double avg_vx = 0.0, avg_vy = 0.0, avg_vz = 0.0;

        for (int n = 0; n < 8; ++n) {
            int nid = elem.node_ids[n];
            min_x = std::min(min_x, nodes[nid].x[0]); max_x = std::max(max_x, nodes[nid].x[0]);
            min_y = std::min(min_y, nodes[nid].x[1]); max_y = std::max(max_y, nodes[nid].x[1]);
            min_z = std::min(min_z, nodes[nid].x[2]); max_z = std::max(max_z, nodes[nid].x[2]);
            avg_vx += nodes[nid].v[0]; avg_vy += nodes[nid].v[1]; avg_vz += nodes[nid].v[2];
        }
        avg_vx *= 0.125; avg_vy *= 0.125; avg_vz *= 0.125;

        int imin = std::clamp(static_cast<int>(std::floor((min_x - xmin) / dx)), 0, nx - 1);
        int imax = std::clamp(static_cast<int>(std::ceil((max_x - xmin) / dx)), 0, nx - 1);
        int jmin = std::clamp(static_cast<int>(std::floor((min_y - ymin) / dy)), 0, ny - 1);
        int jmax = std::clamp(static_cast<int>(std::ceil((max_y - ymin) / dy)), 0, ny - 1);
        int kmin = std::clamp(static_cast<int>(std::floor((min_z - zmin) / dz)), 0, nz - 1);
        int kmax = std::clamp(static_cast<int>(std::ceil((max_z - zmin) / dz)), 0, nz - 1);

        for (int k = kmin; k <= kmax; ++k) {
            double cz = zmin + (k + 0.5) * dz;
            if (cz < min_z || cz > max_z) continue;
            for (int j = jmin; j <= jmax; ++j) {
                double cy = ymin + (j + 0.5) * dy;
                if (cy < min_y || cy > max_y) continue;
                for (int i = imin; i <= imax; ++i) {
                    double cx = xmin + (i + 0.5) * dx;
                    if (cx < min_x || cx > max_x) continue;

                    size_t cfd_idx = static_cast<size_t>(i) + static_cast<size_t>(j) * nx + static_cast<size_t>(k) * nx * ny;
                    m_solid_mask[cfd_idx] = 1;
                    m_solid_vel[3 * cfd_idx + 0] = avg_vx;
                    m_solid_vel[3 * cfd_idx + 1] = avg_vy;
                    m_solid_vel[3 * cfd_idx + 2] = avg_vz;
                }
            }
        }
    }

    // Pass mask and moving solid velocities to FV solver
    m_fv_solver->setSolidMask(m_solid_mask.data());
    m_fv_solver->setSolidVelocities(m_solid_vel.data());
}

template <typename T>
void FEMFSICoupler3D<T>::handleCellTransitions() {
    if (!m_fv_solver || !m_fem_solver) return;
    if (!m_has_prev_mask) {
        m_prev_solid_mask = m_solid_mask;
        m_has_prev_mask = true;
        return;
    }

    // Update previous mask snapshot
    m_prev_solid_mask = m_solid_mask;
}

template <typename T>
void FEMFSICoupler3D<T>::applyFluidPressureToStructure(T dt) {
    if (!m_fv_solver || !m_fem_solver) return;

    auto& nodes = m_fem_solver->getNodes();
    const auto& facets = m_fem_solver->getSurfaceFacets();

    int nx = m_fv_solver->getNx();
    int ny = m_fv_solver->getNy();
    int nz = m_fv_solver->getNz();
    double dx = m_fv_solver->getCellSize();
    double dy = m_fv_solver->getCellSize();
    double dz = m_fv_solver->getCellSize();
    double xmin = m_fv_solver->getXMin();
    double ymin = m_fv_solver->getYMin();
    double zmin = m_fv_solver->getZMin();

    // Reset external forces on all FEM nodes
    for (auto& node : nodes) {
        node.f_ext[0] = static_cast<T>(0.0f);
        node.f_ext[1] = static_cast<T>(0.0f);
        node.f_ext[2] = static_cast<T>(0.0f);
    }

    // Extract FV pressure field in one bulk transfer
    std::vector<float> pfield = m_fv_solver->extractPressureField();
    bool use_bulk = !pfield.empty();

    auto sample_p_at = [&](double px, double py, double pz) -> T {
        int i = static_cast<int>(std::floor((px - xmin) / dx));
        int j = static_cast<int>(std::floor((py - ymin) / dy));
        int k = static_cast<int>(std::floor((pz - zmin) / dz));

        if (i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k >= nz) {
            return static_cast<T>(101325.0f);
        }

        if (use_bulk) {
            return static_cast<T>(pfield[i + j * nx + k * nx * ny]);
        } else {
            auto cv = m_fv_solver->getCellValues(i, j, k);
            if (cv.size() >= 5) return static_cast<T>(cv[4]);
            return static_cast<T>(101325.0f);
        }
    };

    static const double GAUSS_POINTS[4][2] = {
        {-0.5773502691896257, -0.5773502691896257},
        { 0.5773502691896257, -0.5773502691896257},
        { 0.5773502691896257,  0.5773502691896257},
        {-0.5773502691896257,  0.5773502691896257}
    };

    for (const auto& facet : facets) {
        if (facet.is_eroded) continue;

        T xn[4][3];
        T vn[4][3];
        for (int k = 0; k < 4; ++k) {
            int nid = facet.node_ids[k];
            for (int c = 0; c < 3; ++c) {
                xn[k][c] = nodes[nid].x[c];
                vn[k][c] = nodes[nid].v[c];
            }
        }

        if (m_pressure_integ == FSIPressureIntegration::Gauss2x2) {
            for (int g = 0; g < 4; ++g) {
                double xi = GAUSS_POINTS[g][0];
                double eta = GAUSS_POINTS[g][1];

                double N[4] = {
                    0.25 * (1.0 - xi) * (1.0 - eta),
                    0.25 * (1.0 + xi) * (1.0 - eta),
                    0.25 * (1.0 + xi) * (1.0 + eta),
                    0.25 * (1.0 - xi) * (1.0 + eta)
                };

                double dN_dxi[4] = {
                    -0.25 * (1.0 - eta),
                     0.25 * (1.0 - eta),
                     0.25 * (1.0 + eta),
                    -0.25 * (1.0 + eta)
                };

                double dN_deta[4] = {
                    -0.25 * (1.0 - xi),
                    -0.25 * (1.0 + xi),
                     0.25 * (1.0 + xi),
                     0.25 * (1.0 - xi)
                };

                double gx = 0.0, gy = 0.0, gz = 0.0;
                double t_xi[3] = {0.0, 0.0, 0.0};
                double t_eta[3] = {0.0, 0.0, 0.0};
                double g_vx = 0.0, g_vy = 0.0, g_vz = 0.0;

                for (int k = 0; k < 4; ++k) {
                    gx += N[k] * xn[k][0];
                    gy += N[k] * xn[k][1];
                    gz += N[k] * xn[k][2];
                    g_vx += N[k] * vn[k][0];
                    g_vy += N[k] * vn[k][1];
                    g_vz += N[k] * vn[k][2];

                    for (int c = 0; c < 3; ++c) {
                        t_xi[c] += dN_dxi[k] * xn[k][c];
                        t_eta[c] += dN_deta[k] * xn[k][c];
                    }
                }

                // Surface normal cross product vector: n_cross = t_xi x t_eta (pointing outward from solid into fluid)
                double n_cross[3] = {
                    t_xi[1] * t_eta[2] - t_xi[2] * t_eta[1],
                    t_xi[2] * t_eta[0] - t_xi[0] * t_eta[2],
                    t_xi[0] * t_eta[1] - t_xi[1] * t_eta[0]
                };

                double n_len = std::sqrt(n_cross[0] * n_cross[0] + n_cross[1] * n_cross[1] + n_cross[2] * n_cross[2]);
                double unx = 0.0, uny = 0.0, unz = 0.0;
                if (n_len > 1.0e-12) {
                    unx = n_cross[0] / n_len;
                    uny = n_cross[1] / n_len;
                    unz = n_cross[2] / n_len;
                }

                // Probe slightly into adjacent fluid cell along outward normal to sample fluid pressure outside solid
                double probe_x = gx + 0.5 * dx * unx;
                double probe_y = gy + 0.5 * dy * uny;
                double probe_z = gz + 0.5 * dz * unz;

                T p_fluid = sample_p_at(probe_x, probe_y, probe_z);
                if (p_fluid > static_cast<T>(0.0f)) {
                    // Compressive pressure force on solid: -p * n_outward * dA = -p * n_cross
                    double dF[3] = {
                        -static_cast<double>(p_fluid) * n_cross[0],
                        -static_cast<double>(p_fluid) * n_cross[1],
                        -static_cast<double>(p_fluid) * n_cross[2]
                    };

                    // Distribute to the 4 facet nodes
                    for (int k = 0; k < 4; ++k) {
                        int nid = facet.node_ids[k];
                        nodes[nid].f_ext[0] += static_cast<T>(N[k] * dF[0]);
                        nodes[nid].f_ext[1] += static_cast<T>(N[k] * dF[1]);
                        nodes[nid].f_ext[2] += static_cast<T>(N[k] * dF[2]);
                    }

                    // Accumulate boundary work
                    double power = g_vx * dF[0] + g_vy * dF[1] + g_vz * dF[2];
                    m_accumulated_work_fsi += static_cast<T>(power * dt);
                }
            }
        } else {
            // 1-Point Centroid
            T fc_x = 0.25f * (xn[0][0] + xn[1][0] + xn[2][0] + xn[3][0]);
            T fc_y = 0.25f * (xn[0][1] + xn[1][1] + xn[2][1] + xn[3][1]);
            T fc_z = 0.25f * (xn[0][2] + xn[1][2] + xn[2][2] + xn[3][2]);

            // Probe slightly into adjacent fluid cell along outward normal
            double probe_x = static_cast<double>(fc_x) + 0.5 * dx * static_cast<double>(facet.normal[0]);
            double probe_y = static_cast<double>(fc_y) + 0.5 * dy * static_cast<double>(facet.normal[1]);
            double probe_z = static_cast<double>(fc_z) + 0.5 * dz * static_cast<double>(facet.normal[2]);

            T p_fluid = sample_p_at(probe_x, probe_y, probe_z);
            if (p_fluid > static_cast<T>(0.0f)) {
                T f_total = p_fluid * facet.area;
                // Compressive pressure force on solid: -f_total * normal
                T f_normal[3] = {
                    -f_total * facet.normal[0],
                    -f_total * facet.normal[1],
                    -f_total * facet.normal[2]
                };
                T f_quarter[3] = {0.25f * f_normal[0], 0.25f * f_normal[1], 0.25f * f_normal[2]};

                for (int k = 0; k < 4; ++k) {
                    int nid = facet.node_ids[k];
                    nodes[nid].f_ext[0] += f_quarter[0];
                    nodes[nid].f_ext[1] += f_quarter[1];
                    nodes[nid].f_ext[2] += f_quarter[2];
                }
            }
        }
    }
}

template <typename T>
void FEMFSICoupler3D<T>::stepWithDt(T dt) {
    if (!m_fv_solver || !m_fem_solver) return;

    m_sim_time += dt;
    m_step_count++;
    m_last_dt = dt;

    // 1. Rasterize moving Lagrangian structural boundary facets into Eulerian FV grid
    rasterizeFEMFacetsToFVGrid();

    // 2. Handle cell uncovering and isolated vacuum cavity genesis
    handleCellTransitions();

    // 3. Apply fluid pressure to structural nodes via 2x2 Gauss quadrature
    applyFluidPressureToStructure(dt);

    // 4. Advance FEM structural solver by dt
    m_fem_solver->stepWithDt(dt);

    // 5. Advance 3D FV Eulerian gas dynamics solver by dt
    m_fv_solver->step(static_cast<double>(dt));
}

template <typename T>
void FEMFSICoupler3D<T>::step(T cfl) {
    T dt = computeCoupledDt(cfl);
    stepWithDt(dt);
}

// Explicit template instantiations
template class FEMFSICoupler3D<float>;
template class FEMFSICoupler3D<double>;

} // namespace Blast
