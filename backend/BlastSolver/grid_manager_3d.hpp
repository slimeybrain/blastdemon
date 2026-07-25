#ifndef GRID_MANAGER_3D_HPP
#define GRID_MANAGER_3D_HPP

#include <vector>
#include <memory>
#include <iostream>
#include <cmath>
#include <algorithm>
#include "submesh_3d.hpp"
#include "cfd_solver_3d.hpp"
#include "ImmersedBoundary.hpp"

template <typename RealType, bool IsMultiMaterial>
class GridManager3D {
private:
    std::shared_ptr<SubMesh3D<RealType, IsMultiMaterial>> root_mesh;
    std::vector<std::shared_ptr<SubMesh3D<RealType, IsMultiMaterial>>> submeshes;

public:
    GridManager3D(std::shared_ptr<SubMesh3D<RealType, IsMultiMaterial>> root)
        : root_mesh(root) {}

    void addSubMesh(std::shared_ptr<SubMesh3D<RealType, IsMultiMaterial>> submesh) {
        submeshes.push_back(submesh);
        // Sort submeshes by refinement level ascending
        std::sort(submeshes.begin(), submeshes.end(), [](const auto& a, const auto& b) {
            return a->level < b->level;
        });
    }

    size_t getSubMeshCount() const { return submeshes.size(); }
    const std::vector<std::shared_ptr<SubMesh3D<RealType, IsMultiMaterial>>>& getSubMeshes() const { return submeshes; }
    std::shared_ptr<SubMesh3D<RealType, IsMultiMaterial>> getRootMesh() { return root_mesh; }

    void updateSubMeshGeometry(const std::vector<GeometryTile3D>& geom_pool, int parent_nx, int parent_ny, int parent_nz, RealType parent_h, RealType parent_xmin, RealType parent_ymin, RealType parent_zmin, int ntx, int nty) {
        if (geom_pool.empty()) return;
        for (auto& sm : submeshes) {
            #pragma omp parallel for collapse(3)
            for (int k = 0; k < sm->nz; ++k) {
                for (int j = 0; j < sm->ny; ++j) {
                    for (int i = 0; i < sm->nx; ++i) {
                        RealType xc = sm->xmin + (i + static_cast<RealType>(0.5)) * sm->cellSize;
                        RealType yc = sm->ymin + (j + static_cast<RealType>(0.5)) * sm->cellSize;
                        RealType zc = sm->zmin + (k + static_cast<RealType>(0.5)) * sm->cellSize;

                        int pi = std::clamp(static_cast<int>(std::floor((xc - parent_xmin) / parent_h)), 0, parent_nx - 1);
                        int pj = std::clamp(static_cast<int>(std::floor((yc - parent_ymin) / parent_h)), 0, parent_ny - 1);
                        int pk = std::clamp(static_cast<int>(std::floor((zc - parent_zmin) / parent_h)), 0, parent_nz - 1);

                        int tx = pi / 8;
                        int ty = pj / 8;
                        int tz = pk / 8;
                        int t_idx = tx + ty * ntx + tz * ntx * nty;
                        int c_idx = (pi % 8) + (pj % 8) * 8 + (pk % 8) * 64;

                        size_t sm_idx = sm->getIndex(i, j, k);
                        sm->is_boundary[sm_idx] = geom_pool[t_idx].cells[c_idx].is_boundary ? 1 : 0;
                    }
                }
            }
        }
    }

    // Spatial Trilinear & Temporal Linear Prolongation (Fill 2-cell Fine Ghost Boundary Layer from Parent)
    void prolongateGhosts(SubMesh3D<RealType, IsMultiMaterial>& child, const SubMesh3D<RealType, IsMultiMaterial>& parent, RealType temporal_factor = 1.0) {
        RealType h_parent = parent.cellSize;

        for (int k = 0; k < child.nz; ++k) {
            RealType z_child = child.zmin + (k + static_cast<RealType>(0.5)) * child.cellSize;
            for (int j = 0; j < child.ny; ++j) {
                RealType y_child = child.ymin + (j + static_cast<RealType>(0.5)) * child.cellSize;
                for (int i = 0; i < child.nx; ++i) {
                    // Check if cell is in 1-cell ghost boundary layer
                    bool is_ghost = (i < 1 || i >= child.nx - 1 || j < 1 || j >= child.ny - 1 || k < 1 || k >= child.nz - 1);
                    if (!is_ghost) continue;

                    RealType x_child = child.xmin + (i + static_cast<RealType>(0.5)) * child.cellSize;

                    // If ghost cell touches parent domain exterior physical boundary, skip spatial interpolation
                    if (x_child < parent.xmin || x_child > parent.xmax ||
                        y_child < parent.ymin || y_child > parent.ymax ||
                        z_child < parent.zmin || z_child > parent.zmax) {
                        continue;
                    }

                    // Map child cell center to parent fractional cell index
                    RealType parent_i_f = (x_child - parent.xmin) / h_parent - static_cast<RealType>(0.5);
                    RealType parent_j_f = (y_child - parent.ymin) / h_parent - static_cast<RealType>(0.5);
                    RealType parent_k_f = (z_child - parent.zmin) / h_parent - static_cast<RealType>(0.5);

                    int i0 = std::clamp(static_cast<int>(std::floor(parent_i_f)), 0, parent.nx - 1);
                    int j0 = std::clamp(static_cast<int>(std::floor(parent_j_f)), 0, parent.ny - 1);
                    int k0 = std::clamp(static_cast<int>(std::floor(parent_k_f)), 0, parent.nz - 1);
                    int i1 = std::clamp(i0 + 1, 0, parent.nx - 1);
                    int j1 = std::clamp(j0 + 1, 0, parent.ny - 1);
                    int k1 = std::clamp(k0 + 1, 0, parent.nz - 1);

                    RealType wx = std::clamp(parent_i_f - i0, static_cast<RealType>(0.0), static_cast<RealType>(1.0));
                    RealType wy = std::clamp(parent_j_f - j0, static_cast<RealType>(0.0), static_cast<RealType>(1.0));
                    RealType wz = std::clamp(parent_k_f - k0, static_cast<RealType>(0.0), static_cast<RealType>(1.0));

                    // Trilinear weights
                    RealType w000 = (1 - wx) * (1 - wy) * (1 - wz);
                    RealType w100 = wx * (1 - wy) * (1 - wz);
                    RealType w010 = (1 - wx) * wy * (1 - wz);
                    RealType w110 = wx * wy * (1 - wz);
                    RealType w001 = (1 - wx) * (1 - wy) * wz;
                    RealType w101 = wx * (1 - wy) * wz;
                    RealType w011 = (1 - wx) * wy * wz;
                    RealType w111 = wx * wy * wz;

                    auto interpolate = [&](const std::vector<RealType>& p_buf) -> RealType {
                        return w000 * p_buf[parent.getIndex(i0, j0, k0)] +
                               w100 * p_buf[parent.getIndex(i1, j0, k0)] +
                               w010 * p_buf[parent.getIndex(i0, j1, k0)] +
                               w110 * p_buf[parent.getIndex(i1, j1, k0)] +
                               w001 * p_buf[parent.getIndex(i0, j0, k1)] +
                               w101 * p_buf[parent.getIndex(i1, j0, k1)] +
                               w011 * p_buf[parent.getIndex(i0, j1, k1)] +
                               w111 * p_buf[parent.getIndex(i1, j1, k1)];
                    };

                    size_t c_idx = child.getIndex(i, j, k);
                    child.rho[c_idx] = interpolate(parent.rho);
                    child.ux[c_idx] = interpolate(parent.ux);
                    child.uy[c_idx] = interpolate(parent.uy);
                    child.uz[c_idx] = interpolate(parent.uz);
                    child.p[c_idx] = interpolate(parent.p);
                    child.E[c_idx] = interpolate(parent.E);

                    if constexpr (IsMultiMaterial) {
                        child.alpha1[c_idx] = interpolate(parent.alpha1);
                        child.alpha2[c_idx] = interpolate(parent.alpha2);
                        child.arho1[c_idx] = interpolate(parent.arho1);
                        child.arho2[c_idx] = interpolate(parent.arho2);
                    }
                }
            }
        }
    }

    // 8:1 Fine-to-Coarse Restriction (Momentum & Energy Conserving Volume Averaging)
    void restrictToParent(SubMesh3D<RealType, IsMultiMaterial>& parent, const SubMesh3D<RealType, IsMultiMaterial>& child, int n_ghost = 2) {
        for (int ck = 0; ck < child.nz; ck += 2) {
            RealType z_child = child.zmin + (ck + static_cast<RealType>(0.5)) * child.cellSize;
            int pk = std::clamp(static_cast<int>(std::floor((z_child - parent.zmin) / parent.cellSize)), 0, parent.nz - 1);
            
            for (int cj = 0; cj < child.ny; cj += 2) {
                RealType y_child = child.ymin + (cj + static_cast<RealType>(0.5)) * child.cellSize;
                int pj = std::clamp(static_cast<int>(std::floor((y_child - parent.ymin) / parent.cellSize)), 0, parent.ny - 1);

                for (int ci = 0; ci < child.nx; ci += 2) {
                    if (ci < n_ghost || ci + 1 >= child.nx - n_ghost ||
                        cj < n_ghost || cj + 1 >= child.ny - n_ghost ||
                        ck < n_ghost || ck + 1 >= child.nz - n_ghost) {
                        continue;
                    }

                    RealType x_child = child.xmin + (ci + static_cast<RealType>(0.5)) * child.cellSize;
                    int pi = std::clamp(static_cast<int>(std::floor((x_child - parent.xmin) / parent.cellSize)), 0, parent.nx - 1);

                    size_t p_idx = parent.getIndex(pi, pj, pk);

                    RealType sum_rho = 0, sum_rhoux = 0, sum_rhouy = 0, sum_rhouz = 0, sum_p = 0, sum_E = 0;
                    RealType sum_alpha1 = 0, sum_alpha2 = 0, sum_arho1 = 0, sum_arho2 = 0;
                    int valid_cells = 0;

                    for (int dk = 0; dk < 2 && (ck + dk) < child.nz; ++dk) {
                        for (int dj = 0; dj < 2 && (cj + dj) < child.ny; ++dj) {
                            for (int di = 0; di < 2 && (ci + di) < child.nx; ++di) {
                                size_t c_idx = child.getIndex(ci + di, cj + dj, ck + dk);
                                if (!child.is_boundary.empty() && child.is_boundary[c_idx]) {
                                    continue; // Skip solid obstacle cells from restriction averaging
                                }
                                RealType r = child.rho[c_idx];
                                sum_rho += r;
                                sum_rhoux += r * child.ux[c_idx];
                                sum_rhouy += r * child.uy[c_idx];
                                sum_rhouz += r * child.uz[c_idx];
                                sum_p += child.p[c_idx];
                                sum_E += child.E[c_idx];
                                valid_cells++;

                                if constexpr (IsMultiMaterial) {
                                    sum_alpha1 += child.alpha1[c_idx];
                                    sum_alpha2 += child.alpha2[c_idx];
                                    sum_arho1 += child.arho1[c_idx];
                                    sum_arho2 += child.arho2[c_idx];
                                }
                            }
                        }
                    }

                    if (valid_cells > 0) {
                        RealType inv_vc = static_cast<RealType>(1.0) / static_cast<RealType>(valid_cells);
                        RealType avg_rho = std::max(static_cast<RealType>(1e-8), sum_rho * inv_vc);
                        parent.rho[p_idx] = avg_rho;
                        parent.ux[p_idx] = (sum_rhoux * inv_vc) / avg_rho;
                        parent.uy[p_idx] = (sum_rhouy * inv_vc) / avg_rho;
                        parent.uz[p_idx] = (sum_rhouz * inv_vc) / avg_rho;
                        parent.p[p_idx] = std::max(static_cast<RealType>(1e-8), sum_p * inv_vc);
                        parent.E[p_idx] = sum_E * inv_vc;

                        if constexpr (IsMultiMaterial) {
                            parent.alpha1[p_idx] = sum_alpha1 * inv_vc;
                            parent.alpha2[p_idx] = sum_alpha2 * inv_vc;
                            parent.arho1[p_idx] = sum_arho1 * inv_vc;
                            parent.arho2[p_idx] = sum_arho2 * inv_vc;
                        }
                    }
                }
            }
        }
    }

    // Initialize Explosive Super-Sampling & Execute Initial Restriction Pass
    void initializeExplosiveSuperSampled(const Charge3DParams& charge, RealType rho_exp, RealType p_exp, RealType gamma) {
        // First initialize root mesh and all submeshes
        auto initMesh = [&](SubMesh3D<RealType, IsMultiMaterial>& mesh) {
            RealType radius = static_cast<RealType>(charge.radius);
            RealType cx = static_cast<RealType>(charge.x);
            RealType cy = static_cast<RealType>(charge.y);
            RealType cz = static_cast<RealType>(charge.z);

            for (int k = 0; k < mesh.nz; ++k) {
                RealType z0 = mesh.zmin + k * mesh.cellSize;
                for (int j = 0; j < mesh.ny; ++j) {
                    RealType y0 = mesh.ymin + j * mesh.cellSize;
                    for (int i = 0; i < mesh.nx; ++i) {
                        RealType x0 = mesh.xmin + i * mesh.cellSize;

                        // 4x4x4 Quadrature Micro-Cell Integration
                        int inside_count = 0;
                        int total_samples = 64;
                        RealType h_micro = mesh.cellSize / static_cast<RealType>(4.0);

                        for (int sk = 0; sk < 4; ++sk) {
                            RealType zs = z0 + (sk + static_cast<RealType>(0.5)) * h_micro;
                            for (int sj = 0; sj < 4; ++sj) {
                                RealType ys = y0 + (sj + static_cast<RealType>(0.5)) * h_micro;
                                for (int si = 0; si < 4; ++si) {
                                    RealType xs = x0 + (si + static_cast<RealType>(0.5)) * h_micro;
                                    RealType r2 = (xs - cx)*(xs - cx) + (ys - cy)*(ys - cy) + (zs - cz)*(zs - cz);
                                    if (r2 <= radius * radius) {
                                        inside_count++;
                                    }
                                }
                            }
                        }

                        RealType alpha_exp = static_cast<RealType>(inside_count) / static_cast<RealType>(total_samples);
                        size_t idx = mesh.getIndex(i, j, k);

                        if (alpha_exp > static_cast<RealType>(0.0)) {
                            RealType rho_mix = alpha_exp * rho_exp + (static_cast<RealType>(1.0) - alpha_exp) * static_cast<RealType>(1.225);
                            RealType p_mix = alpha_exp * p_exp + (static_cast<RealType>(1.0) - alpha_exp) * static_cast<RealType>(101325.0);
                            mesh.rho[idx] = rho_mix;
                            mesh.p[idx] = p_mix;
                            mesh.E[idx] = p_mix / (gamma - static_cast<RealType>(1.0));

                            if constexpr (IsMultiMaterial) {
                                mesh.alpha1[idx] = alpha_exp;
                                mesh.alpha2[idx] = static_cast<RealType>(1.0) - alpha_exp;
                                mesh.arho1[idx] = alpha_exp * rho_exp;
                                mesh.arho2[idx] = (static_cast<RealType>(1.0) - alpha_exp) * static_cast<RealType>(1.225);
                            }
                        } else {
                            // Explicitly reset ambient cells — necessary because prolongateAll()
                            // from the coarse parent (triggered during syncRootFromTiles) may have
                            // deposited interpolated high-pressure values into submesh cells that
                            // are actually outside the charge at the fine-grid resolution.
                            mesh.rho[idx] = static_cast<RealType>(1.225);
                            mesh.ux[idx]  = static_cast<RealType>(0.0);
                            mesh.uy[idx]  = static_cast<RealType>(0.0);
                            mesh.uz[idx]  = static_cast<RealType>(0.0);
                            mesh.p[idx]   = static_cast<RealType>(101325.0);
                            mesh.E[idx]   = static_cast<RealType>(101325.0) / (gamma - static_cast<RealType>(1.0));

                            if constexpr (IsMultiMaterial) {
                                mesh.alpha1[idx] = static_cast<RealType>(0.0);
                                mesh.alpha2[idx] = static_cast<RealType>(0.0);
                                mesh.arho1[idx]  = static_cast<RealType>(0.0);
                                mesh.arho2[idx]  = static_cast<RealType>(0.0);
                            }
                        }
                    }
                }
            }
        };

        initMesh(*root_mesh);
        for (auto& submesh : submeshes) {
            initMesh(*submesh);
        }

        // NOTE: No restriction pass here. Each grid (root and submeshes) is
        // independently initialized at its own resolution using super-sampling.
        // The parent should NOT be overwritten with submesh-averaged values during
        // init, as this smears high-pressure cells outward into the ambient zone
        // at the coarser parent resolution. Restriction only happens during stepping.
    }

    void prolongateAll(SubMesh3D<RealType, IsMultiMaterial>& child, const SubMesh3D<RealType, IsMultiMaterial>& parent) {
        RealType h_parent = parent.cellSize;

        for (int k = 0; k < child.nz; ++k) {
            RealType z_child = child.zmin + (k + static_cast<RealType>(0.5)) * child.cellSize;
            for (int j = 0; j < child.ny; ++j) {
                RealType y_child = child.ymin + (j + static_cast<RealType>(0.5)) * child.cellSize;
                for (int i = 0; i < child.nx; ++i) {
                    RealType x_child = child.xmin + (i + static_cast<RealType>(0.5)) * child.cellSize;

                    if (x_child < parent.xmin || x_child > parent.xmax ||
                        y_child < parent.ymin || y_child > parent.ymax ||
                        z_child < parent.zmin || z_child > parent.zmax) {
                        continue;
                    }

                    RealType parent_i_f = (x_child - parent.xmin) / h_parent - static_cast<RealType>(0.5);
                    RealType parent_j_f = (y_child - parent.ymin) / h_parent - static_cast<RealType>(0.5);
                    RealType parent_k_f = (z_child - parent.zmin) / h_parent - static_cast<RealType>(0.5);

                    int i0 = std::clamp(static_cast<int>(std::floor(parent_i_f)), 0, parent.nx - 1);
                    int j0 = std::clamp(static_cast<int>(std::floor(parent_j_f)), 0, parent.ny - 1);
                    int k0 = std::clamp(static_cast<int>(std::floor(parent_k_f)), 0, parent.nz - 1);
                    int i1 = std::clamp(i0 + 1, 0, parent.nx - 1);
                    int j1 = std::clamp(j0 + 1, 0, parent.ny - 1);
                    int k1 = std::clamp(k0 + 1, 0, parent.nz - 1);

                    RealType wx = std::clamp(parent_i_f - i0, static_cast<RealType>(0.0), static_cast<RealType>(1.0));
                    RealType wy = std::clamp(parent_j_f - j0, static_cast<RealType>(0.0), static_cast<RealType>(1.0));
                    RealType wz = std::clamp(parent_k_f - k0, static_cast<RealType>(0.0), static_cast<RealType>(1.0));

                    RealType w000 = (1 - wx) * (1 - wy) * (1 - wz);
                    RealType w100 = wx * (1 - wy) * (1 - wz);
                    RealType w010 = (1 - wx) * wy * (1 - wz);
                    RealType w110 = wx * wy * (1 - wz);
                    RealType w001 = (1 - wx) * (1 - wy) * wz;
                    RealType w101 = wx * (1 - wy) * wz;
                    RealType w011 = (1 - wx) * wy * wz;
                    RealType w111 = wx * wy * wz;

                    auto interpolate = [&](const std::vector<RealType>& p_buf) -> RealType {
                        return w000 * p_buf[parent.getIndex(i0, j0, k0)] +
                               w100 * p_buf[parent.getIndex(i1, j0, k0)] +
                               w010 * p_buf[parent.getIndex(i0, j1, k0)] +
                               w110 * p_buf[parent.getIndex(i1, j1, k0)] +
                               w001 * p_buf[parent.getIndex(i0, j0, k1)] +
                               w101 * p_buf[parent.getIndex(i1, j0, k1)] +
                               w011 * p_buf[parent.getIndex(i0, j1, k1)] +
                               w111 * p_buf[parent.getIndex(i1, j1, k1)];
                    };

                    size_t c_idx = child.getIndex(i, j, k);
                    child.rho[c_idx] = interpolate(parent.rho);
                    child.ux[c_idx] = interpolate(parent.ux);
                    child.uy[c_idx] = interpolate(parent.uy);
                    child.uz[c_idx] = interpolate(parent.uz);
                    child.p[c_idx] = interpolate(parent.p);
                    child.E[c_idx] = interpolate(parent.E);

                    if constexpr (IsMultiMaterial) {
                        child.alpha1[c_idx] = interpolate(parent.alpha1);
                        child.alpha2[c_idx] = interpolate(parent.alpha2);
                        child.arho1[c_idx] = interpolate(parent.arho1);
                        child.arho2[c_idx] = interpolate(parent.arho2);
                    }
                }
            }
        }
        child.is_initialized = true;
    }

    void syncRootFromTiles(const std::vector<PrimitiveTile3D<RealType, IsMultiMaterial>>& states_pool, int nx, int ny, int nz, int ntx, int nty, RealType gamma = static_cast<RealType>(1.4)) {
        if (!root_mesh) return;
        #pragma omp parallel for collapse(3)
        for (int gz = 0; gz < nz; ++gz) {
            for (int gy = 0; gy < ny; ++gy) {
                for (int gx = 0; gx < nx; ++gx) {
                    int tx = gx / 8;
                    int ty = gy / 8;
                    int tz = gz / 8;
                    int t_idx = tx + ty * ntx + tz * ntx * nty;
                    int c_idx = (gx % 8) + (gy % 8) * 8 + (gz % 8) * 64;
                    const auto& tile = states_pool[t_idx];
                    size_t r_idx = root_mesh->getIndex(gx, gy, gz);
                    root_mesh->rho[r_idx] = tile.rho[c_idx];
                    root_mesh->ux[r_idx] = tile.ux[c_idx];
                    root_mesh->uy[r_idx] = tile.uy[c_idx];
                    root_mesh->uz[r_idx] = tile.uz[c_idx];
                    root_mesh->p[r_idx] = tile.p[c_idx];
                    RealType gm1 = std::max(static_cast<RealType>(1e-4), gamma - static_cast<RealType>(1.0));
                    root_mesh->E[r_idx] = tile.p[c_idx] / gm1 + static_cast<RealType>(0.5) * tile.rho[c_idx] * (tile.ux[c_idx]*tile.ux[c_idx] + tile.uy[c_idx]*tile.uy[c_idx] + tile.uz[c_idx]*tile.uz[c_idx]);
                    if constexpr (IsMultiMaterial) {
                        root_mesh->alpha1[r_idx] = tile.alpha1[c_idx];
                        root_mesh->alpha2[r_idx] = tile.alpha2[c_idx];
                        root_mesh->arho1[r_idx] = tile.arho1[c_idx];
                        root_mesh->arho2[r_idx] = tile.arho2[c_idx];
                    }
                }
            }
        }
        for (auto& sm : submeshes) {
            if (!sm->is_initialized) {
                prolongateAll(*sm, *root_mesh);
            }
        }
    }

    void syncRootToTiles(std::vector<PrimitiveTile3D<RealType, IsMultiMaterial>>& states_pool, int nx, int ny, int nz, int ntx, int nty) {
        if (!root_mesh) return;
        #pragma omp parallel for collapse(3)
        for (int gz = 0; gz < nz; ++gz) {
            for (int gy = 0; gy < ny; ++gy) {
                for (int gx = 0; gx < nx; ++gx) {
                    int tx = gx / 8;
                    int ty = gy / 8;
                    int tz = gz / 8;
                    int t_idx = tx + ty * ntx + tz * ntx * nty;
                    int c_idx = (gx % 8) + (gy % 8) * 8 + (gz % 8) * 64;
                    auto& tile = states_pool[t_idx];
                    size_t r_idx = root_mesh->getIndex(gx, gy, gz);
                    tile.rho[c_idx] = root_mesh->rho[r_idx];
                    tile.ux[c_idx] = root_mesh->ux[r_idx];
                    tile.uy[c_idx] = root_mesh->uy[r_idx];
                    tile.uz[c_idx] = root_mesh->uz[r_idx];
                    tile.p[c_idx] = root_mesh->p[r_idx];
                    if constexpr (IsMultiMaterial) {
                        tile.alpha1[c_idx] = root_mesh->alpha1[r_idx];
                        tile.alpha2[c_idx] = root_mesh->alpha2[r_idx];
                        tile.arho1[c_idx] = root_mesh->arho1[r_idx];
                        tile.arho2[c_idx] = root_mesh->arho2[r_idx];
                    }
                }
            }
        }
    }

    // 3D Compressible Euler Fluid Solver for SubMeshes with 2-Step Sub-Cycling
    void stepSubMeshes(RealType dt, RealType gamma, const MultiMat::MaterialSet& materials) {
        RealType dt_sub = dt * static_cast<RealType>(0.5); // Sub-cycling half timestep for CFL stability

        for (int substep = 0; substep < 2; ++substep) {
            for (auto& submesh : submeshes) {
                // Prolongate 2-cell ghost boundary layer from parent mesh
                prolongateGhosts(*submesh, *root_mesh);

                RealType h = submesh->cellSize;
                RealType dt_h = dt_sub / h;

                std::vector<RealType> new_rho = submesh->rho;
                std::vector<RealType> new_ux = submesh->ux;
                std::vector<RealType> new_uy = submesh->uy;
                std::vector<RealType> new_uz = submesh->uz;
                std::vector<RealType> new_p = submesh->p;
                std::vector<RealType> new_E = submesh->E;

                std::vector<RealType> new_alpha1, new_alpha2, new_arho1, new_arho2;
                if constexpr (IsMultiMaterial) {
                    new_alpha1 = submesh->alpha1;
                    new_alpha2 = submesh->alpha2;
                    new_arho1 = submesh->arho1;
                    new_arho2 = submesh->arho2;
                }

                RealType gm1 = std::max(static_cast<RealType>(1e-4), gamma - static_cast<RealType>(1.0));

                for (int k = 1; k < submesh->nz - 1; ++k) {
                    for (int j = 1; j < submesh->ny - 1; ++j) {
                        for (int i = 1; i < submesh->nx - 1; ++i) {
                            size_t c_idx = submesh->getIndex(i, j, k);

                            size_t L_x = submesh->getIndex(i - 1, j, k);
                            size_t R_x = submesh->getIndex(i + 1, j, k);
                            size_t L_y = submesh->getIndex(i, j - 1, k);
                            size_t R_y = submesh->getIndex(i, j + 1, k);
                            size_t L_z = submesh->getIndex(i, j, k - 1);
                            size_t R_z = submesh->getIndex(i, j, k + 1);

                            auto get_state_info = [&](size_t idx, RealType& r, RealType& u, RealType& v, RealType& w, RealType& pr, RealType& energy, RealType& c) {
                                bool is_solid = !submesh->is_boundary.empty() && submesh->is_boundary[idx];
                                if (is_solid) {
                                    r = std::max(static_cast<RealType>(1e-8), submesh->rho[c_idx]);
                                    pr = std::max(static_cast<RealType>(1e-8), submesh->p[c_idx]);
                                    u = (idx == L_x || idx == R_x) ? -submesh->ux[c_idx] : submesh->ux[c_idx];
                                    v = (idx == L_y || idx == R_y) ? -submesh->uy[c_idx] : submesh->uy[c_idx];
                                    w = (idx == L_z || idx == R_z) ? -submesh->uz[c_idx] : submesh->uz[c_idx];
                                } else {
                                    r = std::max(static_cast<RealType>(1e-8), submesh->rho[idx]);
                                    u = submesh->ux[idx];
                                    v = submesh->uy[idx];
                                    w = submesh->uz[idx];
                                    pr = std::max(static_cast<RealType>(1e-8), submesh->p[idx]);
                                }
                                energy = pr / gm1 + static_cast<RealType>(0.5) * r * (u*u + v*v + w*w);
                                c = std::sqrt(gamma * pr / r);
                            };

                            RealType rC, uC, vC, wC, pC, EC, cC;
                            get_state_info(c_idx, rC, uC, vC, wC, pC, EC, cC);

                            RealType rLx, uLx, vLx, wLx, pLx, ELx, cLx;
                            get_state_info(L_x, rLx, uLx, vLx, wLx, pLx, ELx, cLx);

                            RealType rRx, uRx, vRx, wRx, pRx, ERx, cRx;
                            get_state_info(R_x, rRx, uRx, vRx, wRx, pRx, ERx, cRx);

                            RealType rLy, uLy, vLy, wLy, pLy, ELy, cLy;
                            get_state_info(L_y, rLy, uLy, vLy, wLy, pLy, ELy, cLy);

                            RealType rRy, uRy, vRy, wRy, pRy, ERy, cRy;
                            get_state_info(R_y, rRy, uRy, vRy, wRy, pRy, ERy, cRy);

                            RealType rLz, uLz, vLz, wLz, pLz, ELz, cLz;
                            get_state_info(L_z, rLz, uLz, vLz, wLz, pLz, ELz, cLz);

                            RealType rRz, uRz, vRz, wRz, pRz, ERz, cRz;
                            get_state_info(R_z, rRz, uRz, vRz, wRz, pRz, ERz, cRz);

                            RealType Sx_L = std::max(std::abs(uLx) + cLx, std::abs(uC) + cC);
                            RealType Sx_R = std::max(std::abs(uC) + cC, std::abs(uRx) + cRx);

                            RealType Sy_L = std::max(std::abs(vLy) + cLy, std::abs(vC) + cC);
                            RealType Sy_R = std::max(std::abs(vC) + cC, std::abs(vRy) + cRy);

                            RealType Sz_L = std::max(std::abs(wLz) + cLz, std::abs(wC) + cC);
                            RealType Sz_R = std::max(std::abs(wC) + cC, std::abs(wRz) + cRz);

                            // Rusanov interface fluxes in X
                            RealType Fx_L_rho = 0.5 * (rLx*uLx + rC*uC) - 0.5 * Sx_L * (rC - rLx);
                            RealType Fx_R_rho = 0.5 * (rC*uC + rRx*uRx) - 0.5 * Sx_R * (rRx - rC);

                            RealType Fx_L_rhoux = 0.5 * (rLx*uLx*uLx + pLx + rC*uC*uC + pC) - 0.5 * Sx_L * (rC*uC - rLx*uLx);
                            RealType Fx_R_rhoux = 0.5 * (rC*uC*uC + pC + rRx*uRx*uRx + pRx) - 0.5 * Sx_R * (rRx*uRx - rC*uC);

                            RealType Fx_L_rhouy = 0.5 * (rLx*uLx*vLx + rC*uC*vC) - 0.5 * Sx_L * (rC*vC - rLx*vLx);
                            RealType Fx_R_rhouy = 0.5 * (rC*uC*vC + rRx*uRx*vRx) - 0.5 * Sx_R * (rRx*vRx - rC*vC);

                            RealType Fx_L_rhouz = 0.5 * (rLx*uLx*wLx + rC*uC*wC) - 0.5 * Sx_L * (rC*wC - rLx*wLx);
                            RealType Fx_R_rhouz = 0.5 * (rC*uC*wC + rRx*uRx*wRx) - 0.5 * Sx_R * (rRx*wRx - rC*wC);

                            RealType Fx_L_E = 0.5 * ((ELx + pLx)*uLx + (EC + pC)*uC) - 0.5 * Sx_L * (EC - ELx);
                            RealType Fx_R_E = 0.5 * ((EC + pC)*uC + (ERx + pRx)*uRx) - 0.5 * Sx_R * (ERx - EC);

                            // Rusanov interface fluxes in Y
                            RealType Fy_L_rho = 0.5 * (rLy*vLy + rC*vC) - 0.5 * Sy_L * (rC - rLy);
                            RealType Fy_R_rho = 0.5 * (rC*vC + rRy*vRy) - 0.5 * Sy_R * (rRy - rC);

                            RealType Fy_L_rhoux = 0.5 * (rLy*vLy*uLy + rC*vC*uC) - 0.5 * Sy_L * (rC*uC - rLy*uLy);
                            RealType Fy_R_rhoux = 0.5 * (rC*vC*uC + rRy*vRy*uRy) - 0.5 * Sy_R * (rRy*uRy - rC*uC);

                            RealType Fy_L_rhouy = 0.5 * (rLy*vLy*vLy + pLy + rC*vC*vC + pC) - 0.5 * Sy_L * (rC*vC - rLy*vLy);
                            RealType Fy_R_rhouy = 0.5 * (rC*vC*vC + pC + rRy*vRy*vRy + pRy) - 0.5 * Sy_R * (rRy*vRy - rC*vC);

                            RealType Fy_L_rhouz = 0.5 * (rLy*vLy*wLy + rC*vC*wC) - 0.5 * Sy_L * (rC*wC - rLy*wLy);
                            RealType Fy_R_rhouz = 0.5 * (rC*vC*wC + rRy*vRy*wRy) - 0.5 * Sy_R * (rRy*wRy - rC*wC);

                            RealType Fy_L_E = 0.5 * ((ELy + pLy)*vLy + (EC + pC)*vC) - 0.5 * Sy_L * (EC - ELy);
                            RealType Fy_R_E = 0.5 * ((EC + pC)*vC + (ERy + pRy)*vRy) - 0.5 * Sy_R * (ERy - EC);

                            // Rusanov interface fluxes in Z
                            RealType Fz_L_rho = 0.5 * (rLz*wLz + rC*wC) - 0.5 * Sz_L * (rC - rLz);
                            RealType Fz_R_rho = 0.5 * (rC*wC + rRz*wRz) - 0.5 * Sz_R * (rRz - rC);

                            RealType Fz_L_rhoux = 0.5 * (rLz*wLz*uLz + rC*wC*uC) - 0.5 * Sz_L * (rC*uC - rLz*uLz);
                            RealType Fz_R_rhoux = 0.5 * (rC*wC*uC + rRz*wRz*uRz) - 0.5 * Sz_R * (rRz*uRz - rC*uC);

                            RealType Fz_L_rhouy = 0.5 * (rLz*wLz*vLz + rC*wC*vC) - 0.5 * Sz_L * (rC*vC - rLz*vLz);
                            RealType Fz_R_rhouy = 0.5 * (rC*wC*vC + rRz*wRz*vRz) - 0.5 * Sz_R * (rRz*vRz - rC*vC);

                            RealType Fz_L_rhouz = 0.5 * (rLz*wLz*wLz + pLz + rC*wC*wC + pC) - 0.5 * Sz_L * (rC*wC - rLz*wLz);
                            RealType Fz_R_rhouz = 0.5 * (rC*wC*wC + pC + rRz*wRz*wRz + pRz) - 0.5 * Sz_R * (rRz*wRz - rC*wC);

                            RealType Fz_L_E = 0.5 * ((ELz + pLz)*wLz + (EC + pC)*wC) - 0.5 * Sz_L * (EC - ELz);
                            RealType Fz_R_E = 0.5 * ((EC + pC)*wC + (ERz + pRz)*wRz) - 0.5 * Sz_R * (ERz - EC);

                            // Conservative finite volume updates
                            RealType rho_n = rC - dt_h * (Fx_R_rho - Fx_L_rho + Fy_R_rho - Fy_L_rho + Fz_R_rho - Fz_L_rho);
                            RealType rhoux_n = rC*uC - dt_h * (Fx_R_rhoux - Fx_L_rhoux + Fy_R_rhoux - Fy_L_rhoux + Fz_R_rhoux - Fz_L_rhoux);
                            RealType rhouy_n = rC*vC - dt_h * (Fx_R_rhouy - Fx_L_rhouy + Fy_R_rhouy - Fy_L_rhouy + Fz_R_rhouy - Fz_L_rhouy);
                            RealType rhouz_n = rC*wC - dt_h * (Fx_R_rhouz - Fx_L_rhouz + Fy_R_rhouz - Fy_L_rhouz + Fz_R_rhouz - Fz_L_rhouz);
                            RealType E_n = EC - dt_h * (Fx_R_E - Fx_L_E + Fy_R_E - Fy_L_E + Fz_R_E - Fz_L_E);

                            if (!submesh->is_boundary.empty() && submesh->is_boundary[c_idx]) {
                                new_rho[c_idx] = static_cast<RealType>(1.225);
                                new_ux[c_idx] = static_cast<RealType>(0.0);
                                new_uy[c_idx] = static_cast<RealType>(0.0);
                                new_uz[c_idx] = static_cast<RealType>(0.0);
                                new_p[c_idx] = static_cast<RealType>(101325.0);
                                new_E[c_idx] = static_cast<RealType>(101325.0) / gm1;
                                if constexpr (IsMultiMaterial) {
                                    new_alpha1[c_idx] = static_cast<RealType>(0.0);
                                    new_alpha2[c_idx] = static_cast<RealType>(1.0);
                                    new_arho1[c_idx] = static_cast<RealType>(0.0);
                                    new_arho2[c_idx] = static_cast<RealType>(1.225);
                                }
                            } else {
                                RealType rho_clamped = std::max(static_cast<RealType>(1e-8), rho_n);
                                new_rho[c_idx] = rho_clamped;
                                new_ux[c_idx] = rhoux_n / rho_clamped;
                                new_uy[c_idx] = rhouy_n / rho_clamped;
                                new_uz[c_idx] = rhouz_n / rho_clamped;

                                RealType ke_n = static_cast<RealType>(0.5) * rho_clamped * (new_ux[c_idx]*new_ux[c_idx] + new_uy[c_idx]*new_uy[c_idx] + new_uz[c_idx]*new_uz[c_idx]);
                                RealType e_int = E_n - ke_n;
                                if (e_int < static_cast<RealType>(0.0)) e_int = static_cast<RealType>(0.0);

                                if constexpr (IsMultiMaterial) {
                                    RealType Fx_L_a1 = 0.5 * (submesh->alpha1[L_x]*uLx + submesh->alpha1[c_idx]*uC) - 0.5 * Sx_L * (submesh->alpha1[c_idx] - submesh->alpha1[L_x]);
                                    RealType Fx_R_a1 = 0.5 * (submesh->alpha1[c_idx]*uC + submesh->alpha1[R_x]*uRx) - 0.5 * Sx_R * (submesh->alpha1[R_x] - submesh->alpha1[c_idx]);

                                    RealType Fy_L_a1 = 0.5 * (submesh->alpha1[L_y]*vLy + submesh->alpha1[c_idx]*vC) - 0.5 * Sy_L * (submesh->alpha1[c_idx] - submesh->alpha1[L_y]);
                                    RealType Fy_R_a1 = 0.5 * (submesh->alpha1[c_idx]*vC + submesh->alpha1[R_y]*vRy) - 0.5 * Sy_R * (submesh->alpha1[R_y] - submesh->alpha1[c_idx]);

                                    RealType Fz_L_a1 = 0.5 * (submesh->alpha1[L_z]*wLz + submesh->alpha1[c_idx]*wC) - 0.5 * Sz_L * (submesh->alpha1[c_idx] - submesh->alpha1[L_z]);
                                    RealType Fz_R_a1 = 0.5 * (submesh->alpha1[c_idx]*wC + submesh->alpha1[R_z]*wRz) - 0.5 * Sz_R * (submesh->alpha1[R_z] - submesh->alpha1[c_idx]);

                                    new_alpha1[c_idx] = std::clamp(submesh->alpha1[c_idx] - dt_h * (Fx_R_a1 - Fx_L_a1 + Fy_R_a1 - Fy_L_a1 + Fz_R_a1 - Fz_L_a1), static_cast<RealType>(0.0), static_cast<RealType>(1.0));
                                    new_alpha2[c_idx] = static_cast<RealType>(1.0) - new_alpha1[c_idx];
                                    new_arho1[c_idx] = new_alpha1[c_idx] * new_rho[c_idx];
                                    new_arho2[c_idx] = new_alpha2[c_idx] * new_rho[c_idx];

                                    RealType p_n = (RealType)MultiMat::getMixturePressure((double)e_int, (double)rho_clamped, (double)new_alpha1[c_idx], (double)new_alpha2[c_idx], (double)new_arho1[c_idx], (double)new_arho2[c_idx], (double)gamma, materials.products, materials.unreacted);
                                    if (std::isnan(p_n) || std::isinf(p_n) || p_n < static_cast<RealType>(1e-8)) {
                                        p_n = static_cast<RealType>(101325.0);
                                        new_rho[c_idx] = static_cast<RealType>(1.225);
                                        new_ux[c_idx] = static_cast<RealType>(0.0);
                                        new_uy[c_idx] = static_cast<RealType>(0.0);
                                        new_uz[c_idx] = static_cast<RealType>(0.0);
                                        ke_n = static_cast<RealType>(0.0);
                                        new_alpha1[c_idx] = static_cast<RealType>(0.0);
                                        new_alpha2[c_idx] = static_cast<RealType>(1.0);
                                        new_arho1[c_idx] = static_cast<RealType>(0.0);
                                        new_arho2[c_idx] = static_cast<RealType>(1.225);
                                        e_int = p_n / gm1;
                                    }
                                    new_p[c_idx] = p_n;
                                    new_E[c_idx] = (RealType)MultiMat::getMixtureEnergy((double)p_n, (double)new_rho[c_idx], (double)new_alpha1[c_idx], (double)new_alpha2[c_idx], (double)new_arho1[c_idx], (double)new_arho2[c_idx], (double)gamma, materials.products, materials.unreacted) + ke_n;
                                } else {
                                    RealType p_n = e_int * gm1;
                                    if (std::isnan(p_n) || std::isinf(p_n) || p_n < static_cast<RealType>(1e-8)) {
                                        p_n = static_cast<RealType>(101325.0);
                                        new_rho[c_idx] = static_cast<RealType>(1.225);
                                        new_ux[c_idx] = static_cast<RealType>(0.0);
                                        new_uy[c_idx] = static_cast<RealType>(0.0);
                                        new_uz[c_idx] = static_cast<RealType>(0.0);
                                        ke_n = static_cast<RealType>(0.0);
                                        e_int = p_n / gm1;
                                    }
                                    new_p[c_idx] = p_n;
                                    new_E[c_idx] = e_int + ke_n;
                                }
                            }

                            RealType op = new_p[c_idx] - static_cast<RealType>(101325.0);
                            if (op < static_cast<RealType>(0.0)) op = static_cast<RealType>(0.0);
                            if (op > submesh->peak_overpressure[c_idx]) {
                                submesh->peak_overpressure[c_idx] = op;
                            }
                            submesh->peak_impulse[c_idx] += op * dt_sub;
                        }
                    }
                }

                submesh->rho = std::move(new_rho);
                submesh->ux = std::move(new_ux);
                submesh->uy = std::move(new_uy);
                submesh->uz = std::move(new_uz);
                submesh->p = std::move(new_p);
                submesh->E = std::move(new_E);
                if constexpr (IsMultiMaterial) {
                    submesh->alpha1 = std::move(new_alpha1);
                    submesh->alpha2 = std::move(new_alpha2);
                    submesh->arho1 = std::move(new_arho1);
                    submesh->arho2 = std::move(new_arho2);
                }
            }
        }
    }

    void voxelizeSubMeshGeometry(const std::vector<Triangle>& triangles, const std::string& voxelization_method) {
        for (auto& sm : submeshes) {
            voxelize_flat_boundary(
                triangles,
                voxelization_method,
                sm->is_boundary,
                sm->nx, sm->ny, sm->nz,
                (double)sm->cellSize,
                (double)sm->xmin, (double)sm->ymin, (double)sm->zmin
            );
        }
    }
};

#endif // GRID_MANAGER_3D_HPP
