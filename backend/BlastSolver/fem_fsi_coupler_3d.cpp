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
    return (m_method == FSIMethod3D::SubCycling) ? dt_fv : std::min(dt_fem, dt_fv);
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

        const bool is_tri = (facet.node_ids[2] == facet.node_ids[3]);

        // Facet vertex positions & velocities
        Point3D v0 = { static_cast<float>(nodes[facet.node_ids[0]].x[0]), static_cast<float>(nodes[facet.node_ids[0]].x[1]), static_cast<float>(nodes[facet.node_ids[0]].x[2]) };
        Point3D v1 = { static_cast<float>(nodes[facet.node_ids[1]].x[0]), static_cast<float>(nodes[facet.node_ids[1]].x[1]), static_cast<float>(nodes[facet.node_ids[1]].x[2]) };
        Point3D v2 = { static_cast<float>(nodes[facet.node_ids[2]].x[0]), static_cast<float>(nodes[facet.node_ids[2]].x[1]), static_cast<float>(nodes[facet.node_ids[2]].x[2]) };
        Point3D v3 = { static_cast<float>(nodes[facet.node_ids[3]].x[0]), static_cast<float>(nodes[facet.node_ids[3]].x[1]), static_cast<float>(nodes[facet.node_ids[3]].x[2]) };

        // Average facet velocity
        const double inv_fn = is_tri ? (1.0 / 3.0) : 0.25;
        double avg_vx = inv_fn * (nodes[facet.node_ids[0]].v[0] + nodes[facet.node_ids[1]].v[0] + nodes[facet.node_ids[2]].v[0] + (is_tri ? 0.0 : nodes[facet.node_ids[3]].v[0]));
        double avg_vy = inv_fn * (nodes[facet.node_ids[0]].v[1] + nodes[facet.node_ids[1]].v[1] + nodes[facet.node_ids[2]].v[1] + (is_tri ? 0.0 : nodes[facet.node_ids[3]].v[1]));
        double avg_vz = inv_fn * (nodes[facet.node_ids[0]].v[2] + nodes[facet.node_ids[1]].v[2] + nodes[facet.node_ids[2]].v[2] + (is_tri ? 0.0 : nodes[facet.node_ids[3]].v[2]));

        // Triangles forming the quad (or single triangle for Tet4)
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

                    if (tri_box_overlap(cell_center, half_dx, triA) || (!is_tri && tri_box_overlap(cell_center, half_dx, triB))) {
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

    // 2. Mark cells whose center lies inside solid Hex8 or Tet4 elements as solid
    const auto& elements = m_fem_solver->getElements();
    static const int hex_faces[6][4] = {
        { 0, 3, 2, 1 },
        { 4, 5, 6, 7 },
        { 0, 1, 5, 4 },
        { 1, 2, 6, 5 },
        { 2, 3, 7, 6 },
        { 3, 0, 4, 7 }
    };
    static const int tet_faces[4][3] = {
        { 0, 2, 1 },
        { 0, 1, 3 },
        { 1, 2, 3 },
        { 2, 0, 3 }
    };

    for (const auto& elem : elements) {
        if (elem.is_eroded) continue;

        const bool is_tet = isTet4Element(elem);
        const int nn = is_tet ? 4 : 8;
        Point3D v[8];
        T min_x = nodes[elem.node_ids[0]].x[0], max_x = min_x;
        T min_y = nodes[elem.node_ids[0]].x[1], max_y = min_y;
        T min_z = nodes[elem.node_ids[0]].x[2], max_z = min_z;
        double avg_vx = 0.0, avg_vy = 0.0, avg_vz = 0.0;
        double cen_x = 0.0, cen_y = 0.0, cen_z = 0.0;

        for (int n = 0; n < nn; ++n) {
            int nid = elem.node_ids[n];
            v[n] = { static_cast<float>(nodes[nid].x[0]), static_cast<float>(nodes[nid].x[1]), static_cast<float>(nodes[nid].x[2]) };
            min_x = std::min(min_x, nodes[nid].x[0]); max_x = std::max(max_x, nodes[nid].x[0]);
            min_y = std::min(min_y, nodes[nid].x[1]); max_y = std::max(max_y, nodes[nid].x[1]);
            min_z = std::min(min_z, nodes[nid].x[2]); max_z = std::max(max_z, nodes[nid].x[2]);
            avg_vx += nodes[nid].v[0]; avg_vy += nodes[nid].v[1]; avg_vz += nodes[nid].v[2];
            cen_x += nodes[nid].x[0]; cen_y += nodes[nid].x[1]; cen_z += nodes[nid].x[2];
        }
        const double inv_nn = 1.0 / static_cast<double>(nn);
        avg_vx *= inv_nn; avg_vy *= inv_nn; avg_vz *= inv_nn;
        cen_x *= inv_nn; cen_y *= inv_nn; cen_z *= inv_nn;

        const int nfaces = is_tet ? 4 : 6;
        Point3D face_normals[6];
        Point3D face_centers[6];
        if (is_tet) {
            for (int f = 0; f < 4; ++f) {
                Point3D p0 = v[tet_faces[f][0]];
                Point3D p1 = v[tet_faces[f][1]];
                Point3D p2 = v[tet_faces[f][2]];
                face_centers[f] = {
                    (p0.x + p1.x + p2.x) / 3.0f,
                    (p0.y + p1.y + p2.y) / 3.0f,
                    (p0.z + p1.z + p2.z) / 3.0f
                };
                float e1x = p1.x - p0.x, e1y = p1.y - p0.y, e1z = p1.z - p0.z;
                float e2x = p2.x - p0.x, e2y = p2.y - p0.y, e2z = p2.z - p0.z;
                float nx_f = e1y * e2z - e1z * e2y;
                float ny_f = e1z * e2x - e1x * e2z;
                float nz_f = e1x * e2y - e1y * e2x;
                // Ensure outward orientation relative to element centroid
                if ((static_cast<float>(cen_x) - face_centers[f].x) * nx_f +
                    (static_cast<float>(cen_y) - face_centers[f].y) * ny_f +
                    (static_cast<float>(cen_z) - face_centers[f].z) * nz_f > 0.0f) {
                    nx_f = -nx_f; ny_f = -ny_f; nz_f = -nz_f;
                }
                face_normals[f] = { nx_f, ny_f, nz_f };
            }
        } else {
            for (int f = 0; f < 6; ++f) {
                Point3D p0 = v[hex_faces[f][0]];
                Point3D p1 = v[hex_faces[f][1]];
                Point3D p2 = v[hex_faces[f][2]];
                Point3D p3 = v[hex_faces[f][3]];
                face_centers[f] = {
                    0.25f * (p0.x + p1.x + p2.x + p3.x),
                    0.25f * (p0.y + p1.y + p2.y + p3.y),
                    0.25f * (p0.z + p1.z + p2.z + p3.z)
                };
                float d10_x = p1.x - p0.x, d10_y = p1.y - p0.y, d10_z = p1.z - p0.z;
                float d30_x = p3.x - p0.x, d30_y = p3.y - p0.y, d30_z = p3.z - p0.z;
                float nx_f = d10_y * d30_z - d10_z * d30_y;
                float ny_f = d10_z * d30_x - d10_x * d30_z;
                float nz_f = d10_x * d30_y - d10_y * d30_x;
                if ((static_cast<float>(cen_x) - face_centers[f].x) * nx_f +
                    (static_cast<float>(cen_y) - face_centers[f].y) * ny_f +
                    (static_cast<float>(cen_z) - face_centers[f].z) * nz_f > 0.0f) {
                    nx_f = -nx_f; ny_f = -ny_f; nz_f = -nz_f;
                }
                face_normals[f] = { nx_f, ny_f, nz_f };
            }
        }

        int imin = std::clamp(static_cast<int>(std::floor((static_cast<double>(min_x) - xmin) / dx - 0.5)), 0, nx - 1);
        int imax = std::clamp(static_cast<int>(std::ceil((static_cast<double>(max_x) - xmin) / dx - 0.5)), 0, nx - 1);
        int jmin = std::clamp(static_cast<int>(std::floor((static_cast<double>(min_y) - ymin) / dy - 0.5)), 0, ny - 1);
        int jmax = std::clamp(static_cast<int>(std::ceil((static_cast<double>(max_y) - ymin) / dy - 0.5)), 0, ny - 1);
        int kmin = std::clamp(static_cast<int>(std::floor((static_cast<double>(min_z) - zmin) / dz - 0.5)), 0, nz - 1);
        int kmax = std::clamp(static_cast<int>(std::ceil((static_cast<double>(max_z) - zmin) / dz - 0.5)), 0, nz - 1);

        for (int k = kmin; k <= kmax; ++k) {
            float cz = static_cast<float>(zmin + (k + 0.5) * dz);
            for (int j = jmin; j <= jmax; ++j) {
                float cy = static_cast<float>(ymin + (j + 0.5) * dy);
                for (int i = imin; i <= imax; ++i) {
                    float cx = static_cast<float>(xmin + (i + 0.5) * dx);
                    bool inside = true;
                    for (int f = 0; f < nfaces; ++f) {
                        float dot = (cx - face_centers[f].x) * face_normals[f].x +
                                    (cy - face_centers[f].y) * face_normals[f].y +
                                    (cz - face_centers[f].z) * face_normals[f].z;
                        if (dot > 1.0e-5f) {
                            inside = false;
                            break;
                        }
                    }
                    if (inside) {
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

    // 3. Rasterize active MPM debris particles into Cartesian FV grid as moving solid obstacles
    auto* mpm_cpu = m_fem_solver->getMPMSolver();
    if (mpm_cpu && !mpm_cpu->getParticles().empty()) {
        const auto& particles = mpm_cpu->getParticles();
        for (const auto& p : particles) {
            int i = std::clamp(static_cast<int>(std::floor((p.x[0] - xmin) / dx)), 0, nx - 1);
            int j = std::clamp(static_cast<int>(std::floor((p.x[1] - ymin) / dy)), 0, ny - 1);
            int k = std::clamp(static_cast<int>(std::floor((p.x[2] - zmin) / dz)), 0, nz - 1);
            size_t cfd_idx = static_cast<size_t>(i) + static_cast<size_t>(j) * nx + static_cast<size_t>(k) * nx * ny;
            m_solid_mask[cfd_idx] = 1;
            m_solid_vel[3 * cfd_idx + 0] = p.v[0];
            m_solid_vel[3 * cfd_idx + 1] = p.v[1];
            m_solid_vel[3 * cfd_idx + 2] = p.v[2];
        }
    }

    // Pass mask and moving solid velocities to FV solver
    m_fv_solver->setSolidMask(m_solid_mask.data());
    m_fv_solver->setSolidVelocities(m_solid_vel.data());
}

template <typename T>
void FEMFSICoupler3D<T>::handleCellTransitions() {
    if (!m_fv_solver || !m_fem_solver) return;
    if (!m_has_prev_mask || m_prev_solid_mask.size() != m_solid_mask.size()) {
        m_prev_solid_mask = m_solid_mask;
        m_has_prev_mask = true;
        return;
    }

    const int nx = m_fv_solver->getNx();
    const int ny = m_fv_solver->getNy();
    const int nz = m_fv_solver->getNz();
    const double rho_vac_d = std::max(1.0e-7, static_cast<double>(m_rho_vac));
    const double p_vac_d   = std::max(1.0e-4, static_cast<double>(m_p_vac));
    const double amb_rho   = (m_fv_solver->getAmbientRho() > 0.0) ? m_fv_solver->getAmbientRho() : 1.225;
    const double amb_p     = (m_fv_solver->getAmbientP() > 0.0)   ? m_fv_solver->getAmbientP()   : 101325.0;

    for (int k = 0; k < nz; ++k) {
        for (int j = 0; j < ny; ++j) {
            for (int i = 0; i < nx; ++i) {
                const size_t idx = static_cast<size_t>(i) + static_cast<size_t>(j) * nx + static_cast<size_t>(k) * nx * ny;
                if (m_prev_solid_mask[idx] != 0 && m_solid_mask[idx] == 0) {
                    double w_sum = 0.0;
                    double p_acc = 0.0, rho_acc = 0.0, E_acc = 0.0;
                    double a1_acc = 0.0, a2_acc = 0.0;
                    double ux_acc = 0.0, uy_acc = 0.0, uz_acc = 0.0;
                    double arho1_acc = 0.0, arho2_acc = 0.0;

                    for (int dk = -1; dk <= 1; ++dk) {
                        for (int dj = -1; dj <= 1; ++dj) {
                            for (int di = -1; di <= 1; ++di) {
                                if (di == 0 && dj == 0 && dk == 0) continue;
                                const int ni = i + di;
                                const int nj = j + dj;
                                const int nk = k + dk;
                                if (ni < 0 || ni >= nx || nj < 0 || nj >= ny || nk < 0 || nk >= nz) continue;
                                const size_t n_idx = static_cast<size_t>(ni) + static_cast<size_t>(nj) * nx + static_cast<size_t>(nk) * nx * ny;
                                if (m_solid_mask[n_idx] != 0) continue;

                                const auto cv = m_fv_solver->getCellValues(ni, nj, nk);
                                if (cv.size() < 10) continue;

                                const double dist = std::sqrt(static_cast<double>(di * di + dj * dj + dk * dk));
                                const double w = 1.0 / dist;
                                p_acc   += w * std::max(static_cast<double>(cv[0]), p_vac_d);
                                rho_acc += w * std::max(static_cast<double>(cv[1]), rho_vac_d);
                                E_acc   += w * std::max(static_cast<double>(cv[3]), p_vac_d);
                                a1_acc  += w * std::clamp(static_cast<double>(cv[4]), 0.0, 1.0);
                                a2_acc  += w * std::clamp(static_cast<double>(cv[5]), 0.0, 1.0);
                                ux_acc  += w * static_cast<double>(cv[7]);
                                uy_acc  += w * static_cast<double>(cv[8]);
                                uz_acc  += w * static_cast<double>(cv[9]);
                                if (cv.size() >= 12) {
                                    arho1_acc += w * std::max(0.0, static_cast<double>(cv[10]));
                                    arho2_acc += w * std::max(0.0, static_cast<double>(cv[11]));
                                }
                                w_sum += w;
                            }
                        }
                    }

                    const bool use_vac = (m_uncovering_method == FSIUncoveringMethod::ConservativeIDW_VacuumCavity);
                    const double rho_new = std::max(rho_vac_d, (w_sum > 0.0) ? (rho_acc / w_sum) : (use_vac ? rho_vac_d : amb_rho));
                    const double p_new   = std::max(p_vac_d,   (w_sum > 0.0) ? (p_acc   / w_sum) : (use_vac ? p_vac_d   : amb_p));
                    const double ux_new  = (w_sum > 0.0) ? (ux_acc / w_sum) : 0.0;
                    const double uy_new  = (w_sum > 0.0) ? (uy_acc / w_sum) : 0.0;
                    const double uz_new  = (w_sum > 0.0) ? (uz_acc / w_sum) : 0.0;
                    const double ke_new  = 0.5 * rho_new * (ux_new * ux_new + uy_new * uy_new + uz_new * uz_new);
                    const double gamma   = (m_fv_solver->getGamma() > 1.0) ? m_fv_solver->getGamma() : 1.4;
                    const double E_new   = (w_sum > 0.0) ? std::max(ke_new + p_vac_d / (gamma - 1.0), E_acc / w_sum)
                                                         : (p_new / (gamma - 1.0) + ke_new);

                    if (m_fv_solver->isMultiMaterial()) {
                        CellState3D<true> s3d{};
                        s3d.rho = rho_new;
                        s3d.ux  = ux_new;
                        s3d.uy  = uy_new;
                        s3d.uz  = uz_new;
                        s3d.E   = E_new;
                        s3d.p   = p_new;
                        const double a1_new = (w_sum > 0.0) ? std::clamp(a1_acc / w_sum, 0.0, 1.0) : 0.0;
                        const double a2_new = (w_sum > 0.0) ? std::clamp(a2_acc / w_sum, 0.0, 1.0 - a1_new) : (1.0 - a1_new);
                        s3d.alpha1 = a1_new;
                        s3d.alpha2 = a2_new;
                        s3d.arho1  = (w_sum > 0.0 && (arho1_acc + arho2_acc) > 0.0) ? (arho1_acc / w_sum) : (a1_new * rho_new);
                        s3d.arho2  = (w_sum > 0.0 && (arho1_acc + arho2_acc) > 0.0) ? (arho2_acc / w_sum) : (a2_new * rho_new);
                        m_fv_solver->setCellStateMulti(i, j, k, s3d);
                    } else {
                        CellState3D<false> s_gas{};
                        s_gas.rho = rho_new;
                        s_gas.ux  = ux_new;
                        s_gas.uy  = uy_new;
                        s_gas.uz  = uz_new;
                        s_gas.E   = E_new;
                        s_gas.p   = p_new;
                        m_fv_solver->setCellStateIdeal(i, j, k, s_gas);
                    }
                }
            }
        }
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
    const T ambient_p = static_cast<T>((m_fv_solver->getAmbientP() > 0.0) ? m_fv_solver->getAmbientP() : 101325.0);

    // Reset external forces on all FEM nodes
    for (auto& node : nodes) {
        node.f_ext[0] = static_cast<T>(0.0f);
        node.f_ext[1] = static_cast<T>(0.0f);
        node.f_ext[2] = static_cast<T>(0.0f);
    }

    // Extract FV pressure field in one bulk transfer
    std::vector<float> pfield = m_fv_solver->extractPressureField();
    bool use_bulk = !pfield.empty();

    auto get_cell_p = [&](int ci, int cj, int ck) -> T {
        if (use_bulk) {
            return static_cast<T>(pfield[ci + cj * nx + ck * nx * ny]);
        } else {
            auto cv = m_fv_solver->getCellValues(ci, cj, ck);
            if (!cv.empty()) return static_cast<T>(cv[0]);
            return ambient_p;
        }
    };

    auto is_cell_solid = [&](int ci, int cj, int ck) -> bool {
        if (ci < 0 || ci >= nx || cj < 0 || cj >= ny || ck < 0 || ck >= nz) return true;
        const size_t c_idx = static_cast<size_t>(ci) + static_cast<size_t>(cj) * nx + static_cast<size_t>(ck) * nx * ny;
        return (c_idx < m_solid_mask.size() && m_solid_mask[c_idx] != 0);
    };

    // Ray-march outward along normal (0.5 to 3.5 cells), skipping solid-masked cells, and clamp to vacuum floor
    auto sample_fluid_p_ray = [&](double gx, double gy, double gz, double unx, double uny, double unz) -> T {
        for (double dist = 0.5; dist <= 3.5; dist += 0.5) {
            double px = gx + dist * dx * unx;
            double py = gy + dist * dy * uny;
            double pz = gz + dist * dz * unz;

            double fx = (px - xmin) / dx - 0.5;
            double fy = (py - ymin) / dy - 0.5;
            double fz = (pz - zmin) / dz - 0.5;
            int i0 = static_cast<int>(std::floor(fx));
            int j0 = static_cast<int>(std::floor(fy));
            int k0 = static_cast<int>(std::floor(fz));

            if (i0 < -1 || i0 >= nx || j0 < -1 || j0 >= ny || k0 < -1 || k0 >= nz) continue;

            double tx = std::max(0.0, std::min(1.0, fx - static_cast<double>(i0)));
            double ty = std::max(0.0, std::min(1.0, fy - static_cast<double>(j0)));
            double tz = std::max(0.0, std::min(1.0, fz - static_cast<double>(k0)));

            T p_sum = static_cast<T>(0.0f);
            T w_sum = static_cast<T>(0.0f);
            for (int dk = 0; dk <= 1; ++dk) {
                int ck = std::max(0, std::min(nz - 1, k0 + dk));
                T wz = static_cast<T>((dk == 0) ? (1.0 - tz) : tz);
                for (int dj = 0; dj <= 1; ++dj) {
                    int cj = std::max(0, std::min(ny - 1, j0 + dj));
                    T wy = static_cast<T>((dj == 0) ? (1.0 - ty) : ty);
                    for (int di = 0; di <= 1; ++di) {
                        int ci = std::max(0, std::min(nx - 1, i0 + di));
                        if (is_cell_solid(ci, cj, ck)) continue;
                        T wx = static_cast<T>((di == 0) ? (1.0 - tx) : tx);
                        T w = wx * wy * wz;
                        p_sum += w * get_cell_p(ci, cj, ck);
                        w_sum += w;
                    }
                }
            }
            if (w_sum > static_cast<T>(1.0e-5f)) {
                return std::max(p_sum / w_sum, m_p_vac);
            }
        }
        return std::max(ambient_p, m_p_vac);
    };

    auto sample_p_at = [&](double px, double py, double pz) -> T {
        double fx = (px - xmin) / dx - 0.5;
        double fy = (py - ymin) / dy - 0.5;
        double fz = (pz - zmin) / dz - 0.5;
        int i0 = static_cast<int>(std::floor(fx));
        int j0 = static_cast<int>(std::floor(fy));
        int k0 = static_cast<int>(std::floor(fz));

        if (i0 < -1 || i0 >= nx || j0 < -1 || j0 >= ny || k0 < -1 || k0 >= nz) {
            return ambient_p;
        }

        double tx = std::max(0.0, std::min(1.0, fx - static_cast<double>(i0)));
        double ty = std::max(0.0, std::min(1.0, fy - static_cast<double>(j0)));
        double tz = std::max(0.0, std::min(1.0, fz - static_cast<double>(k0)));

        T p_sum = static_cast<T>(0.0f);
        for (int dk = 0; dk <= 1; ++dk) {
            int ck = std::max(0, std::min(nz - 1, k0 + dk));
            T wz = static_cast<T>((dk == 0) ? (1.0 - tz) : tz);
            for (int dj = 0; dj <= 1; ++dj) {
                int cj = std::max(0, std::min(ny - 1, j0 + dj));
                T wy = static_cast<T>((dj == 0) ? (1.0 - ty) : ty);
                for (int di = 0; di <= 1; ++di) {
                    int ci = std::max(0, std::min(nx - 1, i0 + di));
                    T wx = static_cast<T>((di == 0) ? (1.0 - tx) : tx);
                    p_sum += (wx * wy * wz) * get_cell_p(ci, cj, ck);
                }
            }
        }
        return std::max(p_sum, m_p_vac);
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

                // Sample fluid pressure along outward normal ray (skipping solid cells) and compute gauge overpressure
                T p_fluid = sample_fluid_p_ray(gx, gy, gz, unx, uny, unz);
                T p_overpressure = p_fluid - ambient_p;
                if (std::abs(static_cast<double>(p_overpressure)) > 1.0e-3) {
                    // Net compressive / suction force on solid: -p_overpressure * n_outward * dA = -p_overpressure * n_cross
                    double dF[3] = {
                        -static_cast<double>(p_overpressure) * n_cross[0],
                        -static_cast<double>(p_overpressure) * n_cross[1],
                        -static_cast<double>(p_overpressure) * n_cross[2]
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
            const bool is_tri = (facet.node_ids[2] == facet.node_ids[3]);
            const int fnodes = is_tri ? 3 : 4;
            const T inv_fnodes = is_tri ? static_cast<T>(1.0 / 3.0) : static_cast<T>(0.25);
            T fc_x = static_cast<T>(0.0), fc_y = static_cast<T>(0.0), fc_z = static_cast<T>(0.0);
            for (int k = 0; k < fnodes; ++k) {
                fc_x += xn[k][0];
                fc_y += xn[k][1];
                fc_z += xn[k][2];
            }
            fc_x *= inv_fnodes;
            fc_y *= inv_fnodes;
            fc_z *= inv_fnodes;

            T p_fluid = sample_fluid_p_ray(
                static_cast<double>(fc_x), static_cast<double>(fc_y), static_cast<double>(fc_z),
                static_cast<double>(facet.normal[0]), static_cast<double>(facet.normal[1]), static_cast<double>(facet.normal[2])
            );
            T p_overpressure = p_fluid - ambient_p;
            if (std::abs(static_cast<double>(p_overpressure)) > 1.0e-3) {
                T f_total = p_overpressure * facet.area;
                // Compressive pressure force on solid: -f_total * normal
                T f_normal[3] = {
                    -f_total * facet.normal[0],
                    -f_total * facet.normal[1],
                    -f_total * facet.normal[2]
                };
                T f_share[3] = {inv_fnodes * f_normal[0], inv_fnodes * f_normal[1], inv_fnodes * f_normal[2]};

                for (int k = 0; k < fnodes; ++k) {
                    int nid = facet.node_ids[k];
                    nodes[nid].f_ext[0] += f_share[0];
                    nodes[nid].f_ext[1] += f_share[1];
                    nodes[nid].f_ext[2] += f_share[2];

                    double power_k = static_cast<double>(f_share[0]) * vn[k][0]
                                   + static_cast<double>(f_share[1]) * vn[k][1]
                                   + static_cast<double>(f_share[2]) * vn[k][2];
                    m_accumulated_work_fsi += static_cast<T>(power_k * dt);
                }
            }
        }
    }

    // Apply fluid pressure gradient and blast aerodynamic drag to active MPM debris particles
    auto* mpm_cpu = m_fem_solver->getMPMSolver();
    if (mpm_cpu && !mpm_cpu->getParticles().empty()) {
        auto& particles = mpm_cpu->getParticles();
        for (auto& p : particles) {
            int i = std::clamp(static_cast<int>(std::floor((p.x[0] - xmin) / dx)), 0, nx - 1);
            int j = std::clamp(static_cast<int>(std::floor((p.x[1] - ymin) / dy)), 0, ny - 1);
            int k = std::clamp(static_cast<int>(std::floor((p.x[2] - zmin) / dz)), 0, nz - 1);

            auto is_solid = [&](int ci, int cj, int ck) -> bool {
                if (ci < 0 || ci >= nx || cj < 0 || cj >= ny || ck < 0 || ck >= nz) return true;
                size_t c_idx = static_cast<size_t>(ci) + static_cast<size_t>(cj) * nx + static_cast<size_t>(ck) * nx * ny;
                return (c_idx < m_solid_mask.size() && m_solid_mask[c_idx] != 0);
            };

            T p_C = sample_p_at(p.x[0], p.x[1], p.x[2]);

            // Robust, scale-invariant one-sided gradient evaluation that never bridges across solid walls
            float grad_px = 0.0f;
            bool solid_L = (i <= 0) || is_solid(i - 1, j, k);
            bool solid_R = (i >= nx - 1) || is_solid(i + 1, j, k);
            if (!solid_L && !solid_R) {
                grad_px = static_cast<float>(sample_p_at(xmin + (i + 1.5) * dx, p.x[1], p.x[2]) - sample_p_at(xmin + (i - 0.5) * dx, p.x[1], p.x[2])) / static_cast<float>(2.0 * dx);
            } else if (!solid_R) {
                grad_px = static_cast<float>(sample_p_at(xmin + (i + 1.5) * dx, p.x[1], p.x[2]) - p_C) / static_cast<float>(dx);
            } else if (!solid_L) {
                grad_px = static_cast<float>(p_C - sample_p_at(xmin + (i - 0.5) * dx, p.x[1], p.x[2])) / static_cast<float>(dx);
            }

            float grad_py = 0.0f;
            bool solid_B = (j <= 0) || is_solid(i, j - 1, k);
            bool solid_T = (j >= ny - 1) || is_solid(i, j + 1, k);
            if (!solid_B && !solid_T) {
                grad_py = static_cast<float>(sample_p_at(p.x[0], ymin + (j + 1.5) * dy, p.x[2]) - sample_p_at(p.x[0], ymin + (j - 0.5) * dy, p.x[2])) / static_cast<float>(2.0 * dy);
            } else if (!solid_T) {
                grad_py = static_cast<float>(sample_p_at(p.x[0], ymin + (j + 1.5) * dy, p.x[2]) - p_C) / static_cast<float>(dy);
            } else if (!solid_B) {
                grad_py = static_cast<float>(p_C - sample_p_at(p.x[0], ymin + (j - 0.5) * dy, p.x[2])) / static_cast<float>(dy);
            }

            float grad_pz = 0.0f;
            bool solid_D = (k <= 0) || is_solid(i, j, k - 1);
            bool solid_U = (k >= nz - 1) || is_solid(i, j, k + 1);
            if (!solid_D && !solid_U) {
                grad_pz = static_cast<float>(sample_p_at(p.x[0], p.x[1], zmin + (k + 1.5) * dz) - sample_p_at(p.x[0], p.x[1], zmin + (k - 0.5) * dz)) / static_cast<float>(2.0 * dz);
            } else if (!solid_U) {
                grad_pz = static_cast<float>(sample_p_at(p.x[0], p.x[1], zmin + (k + 1.5) * dz) - p_C) / static_cast<float>(dz);
            } else if (!solid_D) {
                grad_pz = static_cast<float>(p_C - sample_p_at(p.x[0], p.x[1], zmin + (k - 0.5) * dz)) / static_cast<float>(dz);
            }

            float r_p = (p.contact_radius > 0.0f) ? p.contact_radius : ((p.lp[0] > 0.0f) ? p.lp[0] : (0.5f * std::cbrt(std::max(1.0e-30f, p.V))));
            float A_p = 3.14159265f * r_p * r_p;
            float V_p = (p.V > 0.0f) ? p.V : ((4.0f / 3.0f) * 3.14159265f * r_p * r_p * r_p);

            // Pressure gradient force: F_grad = -V_p * grad(p)
            float F_x = -V_p * grad_px;
            float F_y = -V_p * grad_py;
            float F_z = -V_p * grad_pz;

            // Sample surrounding fluid velocity, density, and pressure for supersonic blast aerodynamic drag
            float u_f = 0.0f, v_f = 0.0f, w_f = 0.0f, rho_f = 1.2f, p_f = 101325.0f;
            if (m_fv_solver->getFluidVelocity(i, j, k, u_f, v_f, w_f, rho_f, p_f)) {
                float rel_vx = u_f - p.v[0];
                float rel_vy = v_f - p.v[1];
                float rel_vz = w_f - p.v[2];
                float rel_v = std::sqrt(rel_vx * rel_vx + rel_vy * rel_vy + rel_vz * rel_vz);

                float gamma = 1.4f;
                float c_s = std::sqrt(std::max(10.0f, gamma * std::max(10.0f, p_f) / std::max(1.0e-4f, rho_f)));
                float M_rel = rel_v / c_s;
                float Cd = (M_rel > 1.0f) ? std::min(1.8f, 1.2f + 0.4f * (M_rel - 1.0f)) : 1.0f;

                float F_drag_mag = 0.5f * Cd * rho_f * A_p * rel_v;
                F_x += F_drag_mag * rel_vx;
                F_y += F_drag_mag * rel_vy;
                F_z += F_drag_mag * rel_vz;
            }

            float m_p = std::max(1.0e-12f, p.m);
            p.v[0] += (F_x / m_p) * static_cast<float>(dt);
            p.v[1] += (F_y / m_p) * static_cast<float>(dt);
            p.v[2] += (F_z / m_p) * static_cast<float>(dt);
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

    // 3. Apply fluid pressure to structural nodes via 2x2 Gauss quadrature & MPM debris particles
    applyFluidPressureToStructure(dt);

    // 4. Advance FEM structural solver by dt (with subcycling when FSIMethod3D::SubCycling is selected)
    auto* mpm_cpu = m_fem_solver->getMPMSolver();
    if (m_method == FSIMethod3D::SubCycling) {
        const T dt_fem = m_fem_solver->computeStepSize(m_last_cfl);
        const int n_sub = std::clamp(
            static_cast<int>(std::ceil(dt / std::max(dt_fem, static_cast<T>(1e-12)))),
            1, m_max_subcycles);
        const T sub_dt = dt / static_cast<T>(n_sub);

        auto& nodes = m_fem_solver->getNodes();
        std::vector<std::array<T, 3>> saved_f_ext(nodes.size());
        for (size_t i = 0; i < nodes.size(); ++i) {
            saved_f_ext[i] = {nodes[i].f_ext[0], nodes[i].f_ext[1], nodes[i].f_ext[2]};
        }

        for (int s = 0; s < n_sub; ++s) {
            if (s > 0) {
                auto& cur_nodes = m_fem_solver->getNodes();
                const size_t n_restore = std::min(saved_f_ext.size(), cur_nodes.size());
                for (size_t i = 0; i < n_restore; ++i) {
                    cur_nodes[i].f_ext[0] = saved_f_ext[i][0];
                    cur_nodes[i].f_ext[1] = saved_f_ext[i][1];
                    cur_nodes[i].f_ext[2] = saved_f_ext[i][2];
                }
            }
            m_fem_solver->stepWithDt(sub_dt);
        }
    } else {
        m_fem_solver->stepWithDt(dt);
    }

    // 5. Advance MPM debris solver by dt
    if (mpm_cpu && !mpm_cpu->getParticles().empty()) {
        mpm_cpu->stepWithDt(static_cast<float>(dt));
    }

    // 6. Re-rasterize updated FEM obstacle geometry and solid velocities before advancing FV gas dynamics
    rasterizeFEMFacetsToFVGrid();
    handleCellTransitions();

    // 7. Advance 3D FV Eulerian gas dynamics solver by dt
    m_fv_solver->step(static_cast<double>(dt));
}

template <typename T>
void FEMFSICoupler3D<T>::step(T cfl) {
    m_last_cfl = cfl;
    T dt = computeCoupledDt(cfl);
    stepWithDt(dt);
}

// Explicit template instantiations
template class FEMFSICoupler3D<float>;
template class FEMFSICoupler3D<double>;

} // namespace Blast
