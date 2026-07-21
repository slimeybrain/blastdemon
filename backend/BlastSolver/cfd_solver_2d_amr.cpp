#include "cfd_solver_2d_amr.hpp"
#include "VTKWriter.hpp"
#include <iostream>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <omp.h>

template <typename RealType>
CFDSolver2DAMRImpl<RealType>::CFDSolver2DAMRImpl(int nr, int nz, double max_r, double max_z, double gamma, int max_levels, double threshold, double coarsen_ratio)
    : level0_nr(nr), level0_nz(nz), max_r_coord(max_r), max_z_coord(max_z),
      time_val(0.0), gamma_val(gamma), is_ideal_gas_val(true),
      amr_max_levels_val(max_levels), amr_threshold_val(threshold), amr_coarsen_ratio_val(coarsen_ratio),
      flux_scheme_name("AUSM+"), spatial_order_val(2), temporal_order_val(2),
      bc_r_min(REFLECTIVE), bc_r_max(OUTFLOW_RIEMANN), bc_z_min(REFLECTIVE), bc_z_max(OUTFLOW_RIEMANN),
      is_cartesian(false), detonator_r_coord(0.0), detonator_z_coord(0.0),
      ambient_rho_val(1.225), ambient_p_val(101325.0) {

    level0_num_tiles_r = (nr + TILE_SIZE - 1) / TILE_SIZE;
    level0_num_tiles_z = (nz + TILE_SIZE - 1) / TILE_SIZE;
    dr_base = max_r / nr;
    dz_base = max_z / nz;

    // Allocate Level 0 grid
    int num_lvl0_nodes = level0_num_tiles_r * level0_num_tiles_z;
    amr_nodes.reserve(num_lvl0_nodes * 2);

    for (int r = 0; r < level0_num_tiles_r; ++r) {
        for (int z = 0; z < level0_num_tiles_z; ++z) {
            AMRTileNode node;
            node.tile_id = allocateTile();
            node.level = 0;
            node.parent = -1;
            std::fill(std::begin(node.children), std::end(node.children), -1);
            std::fill(std::begin(node.neighbors), std::end(node.neighbors), -1);
            node.is_active = true;
            node.r_idx = r;
            node.z_idx = z;
            node.r_min = r * TILE_SIZE * dr_base;
            node.r_max = (r + 1) * TILE_SIZE * dr_base;
            node.z_min = z * TILE_SIZE * dz_base;
            node.z_max = (z + 1) * TILE_SIZE * dz_base;
            amr_nodes.push_back(node);
        }
    }

    rebuildNeighborPointers();
}

template <typename RealType>
int CFDSolver2DAMRImpl<RealType>::allocateTile() {
    int id;
    if (!free_tile_ids.empty()) {
        id = free_tile_ids.back();
        free_tile_ids.pop_back();
    } else {
        id = states_pool.size();
        states_pool.emplace_back();
        U_pool.emplace_back();
        dU_pool.emplace_back();
        node_boundary_fluxes.emplace_back();
    }

    auto& S = states_pool[id];
    auto& U = U_pool[id];
    auto& dU = dU_pool[id];

    for (int k = 0; k < AMR_TILE_DIM * AMR_TILE_DIM; ++k) {
        S.rho[k] = (RealType)ambient_rho_val;
        S.ur[k] = 0.0;
        S.uz[k] = 0.0;
        S.p[k] = (RealType)ambient_p_val;
        S.E[k] = (RealType)(ambient_p_val / (gamma_val - 1.0));
        S.alpha1[k] = 0.0;
        S.alpha2[k] = 0.0;
        S.arho1[k] = 0.0;
        S.arho2[k] = 0.0;
        S.floor_status[k] = 0;

        U.rho[k] = (RealType)ambient_rho_val;
        U.rhour[k] = 0.0;
        U.rhouz[k] = 0.0;
        U.E[k] = (RealType)(ambient_p_val / (gamma_val - 1.0));
        U.alpha1[k] = 0.0;
        U.alpha2[k] = 0.0;
        U.arho1[k] = 0.0;
        U.arho2[k] = 0.0;

        dU.rho[k] = 0.0;
        dU.rhour[k] = 0.0;
        dU.rhouz[k] = 0.0;
        dU.E[k] = 0.0;
        dU.alpha1[k] = 0.0;
        dU.alpha2[k] = 0.0;
        dU.arho1[k] = 0.0;
        dU.arho2[k] = 0.0;
    }
    return id;
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::freeTile(int tile_id) {
    free_tile_ids.push_back(tile_id);
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::rebuildNeighborPointers() {
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        if (amr_nodes[n].tile_id == -1 && amr_nodes[n].children[0] == -1) continue;
        for (int d = 0; d < 4; ++d) {
            amr_nodes[n].neighbors[d] = findNeighborNode(n, d);
        }
    }
}

template <typename RealType>
int CFDSolver2DAMRImpl<RealType>::findNeighborNode(int node_idx, int dir) {
    const auto& node = amr_nodes[node_idx];
    if (node.level == 0) {
        int r = node.r_idx;
        int z = node.z_idx;
        if (dir == AMR_DIR_LEFT)   return (r > 0) ? (r - 1) * level0_num_tiles_z + z : -1;
        if (dir == AMR_DIR_RIGHT)  return (r < level0_num_tiles_r - 1) ? (r + 1) * level0_num_tiles_z + z : -1;
        if (dir == AMR_DIR_BOTTOM) return (z > 0) ? r * level0_num_tiles_z + (z - 1) : -1;
        if (dir == AMR_DIR_TOP)    return (z < level0_num_tiles_z - 1) ? r * level0_num_tiles_z + (z + 1) : -1;
        return -1;
    }

    int parent_idx = node.parent;
    int child_quadrant = -1;
    for (int c = 0; c < 4; ++c) {
        if (amr_nodes[parent_idx].children[c] == node_idx) {
            child_quadrant = c;
            break;
        }
    }

    // Internal neighbors inside same parent
    if (dir == AMR_DIR_LEFT) {
        if (child_quadrant == 1) return amr_nodes[parent_idx].children[0];
        if (child_quadrant == 3) return amr_nodes[parent_idx].children[2];
    }
    if (dir == AMR_DIR_RIGHT) {
        if (child_quadrant == 0) return amr_nodes[parent_idx].children[1];
        if (child_quadrant == 2) return amr_nodes[parent_idx].children[3];
    }
    if (dir == AMR_DIR_BOTTOM) {
        if (child_quadrant == 2) return amr_nodes[parent_idx].children[0];
        if (child_quadrant == 3) return amr_nodes[parent_idx].children[1];
    }
    if (dir == AMR_DIR_TOP) {
        if (child_quadrant == 0) return amr_nodes[parent_idx].children[2];
        if (child_quadrant == 1) return amr_nodes[parent_idx].children[3];
    }

    // External neighbors
    int nb_parent = findNeighborNode(parent_idx, dir);
    if (nb_parent == -1) return -1;

    const auto& nb_node = amr_nodes[nb_parent];
    if (nb_node.children[0] == -1) {
        return nb_parent;
    }

    if (dir == AMR_DIR_LEFT) {
        if (child_quadrant == 0) return nb_node.children[1];
        if (child_quadrant == 2) return nb_node.children[3];
    }
    if (dir == AMR_DIR_RIGHT) {
        if (child_quadrant == 1) return nb_node.children[0];
        if (child_quadrant == 3) return nb_node.children[2];
    }
    if (dir == AMR_DIR_BOTTOM) {
        if (child_quadrant == 0) return nb_node.children[2];
        if (child_quadrant == 1) return nb_node.children[3];
    }
    if (dir == AMR_DIR_TOP) {
        if (child_quadrant == 2) return nb_node.children[0];
        if (child_quadrant == 3) return nb_node.children[1];
    }
    return -1;
}

template <typename RealType>
int CFDSolver2DAMRImpl<RealType>::findNodeByCoords(int r_idx, int z_idx, int level) {
    if (r_idx < 0 || r_idx >= (level0_num_tiles_r << level) ||
        z_idx < 0 || z_idx >= (level0_num_tiles_z << level)) {
        return -1;
    }
    int r0 = r_idx >> level;
    int z0 = z_idx >> level;
    int curr = r0 * level0_num_tiles_z + z0;
    if (curr < 0 || curr >= (int)amr_nodes.size()) return -1;

    for (int l = 0; l < level; ++l) {
        if (amr_nodes[curr].children[0] == -1) {
            return curr;
        }
        int shift = level - 1 - l;
        int bit_r = (r_idx >> shift) & 1;
        int bit_z = (z_idx >> shift) & 1;
        int quadrant = bit_r + 2 * bit_z;
        curr = amr_nodes[curr].children[quadrant];
        if (curr == -1) return -1;
    }
    return curr;
}



template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::fillGhostCells() {
    #pragma omp parallel for
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        auto& node = amr_nodes[n];
        if (node.tile_id == -1) continue;

        auto& T = states_pool[node.tile_id];

        for (int d = 0; d < 4; ++d) {
            int nb_idx = node.neighbors[d];
            if (nb_idx != -1) {
                const auto& nb_node = amr_nodes[nb_idx];
                if (nb_node.level == node.level) {
                    const auto& Nb = states_pool[nb_node.tile_id];
                    if (d == AMR_DIR_LEFT) {
                        for (int j = 0; j < 16; ++j) {
                            int tj = j + 2;
                            T.rho[0 * AMR_TILE_DIM + tj] = Nb.rho[16 * AMR_TILE_DIM + tj];
                            T.rho[1 * AMR_TILE_DIM + tj] = Nb.rho[17 * AMR_TILE_DIM + tj];
                            T.ur[0 * AMR_TILE_DIM + tj] = Nb.ur[16 * AMR_TILE_DIM + tj];
                            T.ur[1 * AMR_TILE_DIM + tj] = Nb.ur[17 * AMR_TILE_DIM + tj];
                            T.uz[0 * AMR_TILE_DIM + tj] = Nb.uz[16 * AMR_TILE_DIM + tj];
                            T.uz[1 * AMR_TILE_DIM + tj] = Nb.uz[17 * AMR_TILE_DIM + tj];
                            T.p[0 * AMR_TILE_DIM + tj] = Nb.p[16 * AMR_TILE_DIM + tj];
                            T.p[1 * AMR_TILE_DIM + tj] = Nb.p[17 * AMR_TILE_DIM + tj];
                            T.E[0 * AMR_TILE_DIM + tj] = Nb.E[16 * AMR_TILE_DIM + tj];
                            T.E[1 * AMR_TILE_DIM + tj] = Nb.E[17 * AMR_TILE_DIM + tj];
                            T.alpha1[0 * AMR_TILE_DIM + tj] = Nb.alpha1[16 * AMR_TILE_DIM + tj];
                            T.alpha1[1 * AMR_TILE_DIM + tj] = Nb.alpha1[17 * AMR_TILE_DIM + tj];
                            T.alpha2[0 * AMR_TILE_DIM + tj] = Nb.alpha2[16 * AMR_TILE_DIM + tj];
                            T.alpha2[1 * AMR_TILE_DIM + tj] = Nb.alpha2[17 * AMR_TILE_DIM + tj];
                            T.arho1[0 * AMR_TILE_DIM + tj] = Nb.arho1[16 * AMR_TILE_DIM + tj];
                            T.arho1[1 * AMR_TILE_DIM + tj] = Nb.arho1[17 * AMR_TILE_DIM + tj];
                            T.arho2[0 * AMR_TILE_DIM + tj] = Nb.arho2[16 * AMR_TILE_DIM + tj];
                            T.arho2[1 * AMR_TILE_DIM + tj] = Nb.arho2[17 * AMR_TILE_DIM + tj];
                        }
                    } else if (d == AMR_DIR_RIGHT) {
                        for (int j = 0; j < 16; ++j) {
                            int tj = j + 2;
                            T.rho[18 * AMR_TILE_DIM + tj] = Nb.rho[2 * AMR_TILE_DIM + tj];
                            T.rho[19 * AMR_TILE_DIM + tj] = Nb.rho[3 * AMR_TILE_DIM + tj];
                            T.ur[18 * AMR_TILE_DIM + tj] = Nb.ur[2 * AMR_TILE_DIM + tj];
                            T.ur[19 * AMR_TILE_DIM + tj] = Nb.ur[3 * AMR_TILE_DIM + tj];
                            T.uz[18 * AMR_TILE_DIM + tj] = Nb.uz[2 * AMR_TILE_DIM + tj];
                            T.uz[19 * AMR_TILE_DIM + tj] = Nb.uz[3 * AMR_TILE_DIM + tj];
                            T.p[18 * AMR_TILE_DIM + tj] = Nb.p[2 * AMR_TILE_DIM + tj];
                            T.p[19 * AMR_TILE_DIM + tj] = Nb.p[3 * AMR_TILE_DIM + tj];
                            T.E[18 * AMR_TILE_DIM + tj] = Nb.E[2 * AMR_TILE_DIM + tj];
                            T.E[19 * AMR_TILE_DIM + tj] = Nb.E[3 * AMR_TILE_DIM + tj];
                            T.alpha1[18 * AMR_TILE_DIM + tj] = Nb.alpha1[2 * AMR_TILE_DIM + tj];
                            T.alpha1[19 * AMR_TILE_DIM + tj] = Nb.alpha1[3 * AMR_TILE_DIM + tj];
                            T.alpha2[18 * AMR_TILE_DIM + tj] = Nb.alpha2[2 * AMR_TILE_DIM + tj];
                            T.alpha2[19 * AMR_TILE_DIM + tj] = Nb.alpha2[3 * AMR_TILE_DIM + tj];
                            T.arho1[18 * AMR_TILE_DIM + tj] = Nb.arho1[2 * AMR_TILE_DIM + tj];
                            T.arho1[19 * AMR_TILE_DIM + tj] = Nb.arho1[3 * AMR_TILE_DIM + tj];
                            T.arho2[18 * AMR_TILE_DIM + tj] = Nb.arho2[2 * AMR_TILE_DIM + tj];
                            T.arho2[19 * AMR_TILE_DIM + tj] = Nb.arho2[3 * AMR_TILE_DIM + tj];
                        }
                    } else if (d == AMR_DIR_BOTTOM) {
                        for (int i = 0; i < 16; ++i) {
                            int ti = i + 2;
                            T.rho[ti * AMR_TILE_DIM + 0] = Nb.rho[ti * AMR_TILE_DIM + 16];
                            T.rho[ti * AMR_TILE_DIM + 1] = Nb.rho[ti * AMR_TILE_DIM + 17];
                            T.ur[ti * AMR_TILE_DIM + 0] = Nb.ur[ti * AMR_TILE_DIM + 16];
                            T.ur[ti * AMR_TILE_DIM + 1] = Nb.ur[ti * AMR_TILE_DIM + 17];
                            T.uz[ti * AMR_TILE_DIM + 0] = Nb.uz[ti * AMR_TILE_DIM + 16];
                            T.uz[ti * AMR_TILE_DIM + 1] = Nb.uz[ti * AMR_TILE_DIM + 17];
                            T.p[ti * AMR_TILE_DIM + 0] = Nb.p[ti * AMR_TILE_DIM + 16];
                            T.p[ti * AMR_TILE_DIM + 1] = Nb.p[ti * AMR_TILE_DIM + 17];
                            T.E[ti * AMR_TILE_DIM + 0] = Nb.E[ti * AMR_TILE_DIM + 16];
                            T.E[ti * AMR_TILE_DIM + 1] = Nb.E[ti * AMR_TILE_DIM + 17];
                            T.alpha1[ti * AMR_TILE_DIM + 0] = Nb.alpha1[ti * AMR_TILE_DIM + 16];
                            T.alpha1[ti * AMR_TILE_DIM + 1] = Nb.alpha1[ti * AMR_TILE_DIM + 17];
                            T.alpha2[ti * AMR_TILE_DIM + 0] = Nb.alpha2[ti * AMR_TILE_DIM + 16];
                            T.alpha2[ti * AMR_TILE_DIM + 1] = Nb.alpha2[ti * AMR_TILE_DIM + 17];
                            T.arho1[ti * AMR_TILE_DIM + 0] = Nb.arho1[ti * AMR_TILE_DIM + 16];
                            T.arho1[ti * AMR_TILE_DIM + 1] = Nb.arho1[ti * AMR_TILE_DIM + 17];
                            T.arho2[ti * AMR_TILE_DIM + 0] = Nb.arho2[ti * AMR_TILE_DIM + 16];
                            T.arho2[ti * AMR_TILE_DIM + 1] = Nb.arho2[ti * AMR_TILE_DIM + 17];
                        }
                    } else if (d == AMR_DIR_TOP) {
                        for (int i = 0; i < 16; ++i) {
                            int ti = i + 2;
                            T.rho[ti * AMR_TILE_DIM + 18] = Nb.rho[ti * AMR_TILE_DIM + 2];
                            T.rho[ti * AMR_TILE_DIM + 19] = Nb.rho[ti * AMR_TILE_DIM + 3];
                            T.ur[ti * AMR_TILE_DIM + 18] = Nb.ur[ti * AMR_TILE_DIM + 2];
                            T.ur[ti * AMR_TILE_DIM + 19] = Nb.ur[ti * AMR_TILE_DIM + 3];
                            T.uz[ti * AMR_TILE_DIM + 18] = Nb.uz[ti * AMR_TILE_DIM + 2];
                            T.uz[ti * AMR_TILE_DIM + 19] = Nb.uz[ti * AMR_TILE_DIM + 3];
                            T.p[ti * AMR_TILE_DIM + 18] = Nb.p[ti * AMR_TILE_DIM + 2];
                            T.p[ti * AMR_TILE_DIM + 19] = Nb.p[ti * AMR_TILE_DIM + 3];
                            T.E[ti * AMR_TILE_DIM + 18] = Nb.E[ti * AMR_TILE_DIM + 2];
                            T.E[ti * AMR_TILE_DIM + 19] = Nb.E[ti * AMR_TILE_DIM + 3];
                            T.alpha1[ti * AMR_TILE_DIM + 18] = Nb.alpha1[ti * AMR_TILE_DIM + 2];
                            T.alpha1[ti * AMR_TILE_DIM + 19] = Nb.alpha1[ti * AMR_TILE_DIM + 3];
                            T.alpha2[ti * AMR_TILE_DIM + 18] = Nb.alpha2[ti * AMR_TILE_DIM + 2];
                            T.alpha2[ti * AMR_TILE_DIM + 19] = Nb.alpha2[ti * AMR_TILE_DIM + 3];
                            T.arho1[ti * AMR_TILE_DIM + 18] = Nb.arho1[ti * AMR_TILE_DIM + 2];
                            T.arho1[ti * AMR_TILE_DIM + 19] = Nb.arho1[ti * AMR_TILE_DIM + 3];
                            T.arho2[ti * AMR_TILE_DIM + 18] = Nb.arho2[ti * AMR_TILE_DIM + 2];
                            T.arho2[ti * AMR_TILE_DIM + 19] = Nb.arho2[ti * AMR_TILE_DIM + 3];
                        }
                    }
                } else if (nb_node.level == node.level - 1) {
                    // Prolongate from coarser neighbor
                    const auto& Nb = states_pool[nb_node.tile_id];
                    auto prolongate_cell = [&](int ic, int jc, double xfrac, double yfrac, auto field) {
                        double v = (Nb.*field)[ic * AMR_TILE_DIM + jc];
                        double vr = (ic == 17) ? (v - (Nb.*field)[(ic-1)*AMR_TILE_DIM+jc]) :
                                    ((ic == 2)  ? ((Nb.*field)[(ic+1)*AMR_TILE_DIM+jc] - v) :
                                    minmod_kernel((Nb.*field)[(ic+1)*AMR_TILE_DIM+jc] - v, v - (Nb.*field)[(ic-1)*AMR_TILE_DIM+jc]));
                        double vz = (jc == 17) ? (v - (Nb.*field)[ic*AMR_TILE_DIM+jc-1]) :
                                    ((jc == 2)  ? ((Nb.*field)[ic*AMR_TILE_DIM+jc+1] - v) :
                                    minmod_kernel((Nb.*field)[ic*AMR_TILE_DIM+jc+1] - v, v - (Nb.*field)[ic*AMR_TILE_DIM+jc-1]));
                        return (RealType)(v + xfrac * vr + yfrac * vz);
                    };

                    int r_off = node.r_idx % 2;
                    int z_off = node.z_idx % 2;

                    if (d == AMR_DIR_LEFT) {
                        int ic = 17; // column 15 of coarse Nb (+2 offset)
                        for (int j = 0; j < 16; ++j) {
                            int jc = (j / 2) + 2 + z_off * 8;
                            double yf = (j % 2 == 0) ? -0.25 : 0.25;
                            #define PROLONG_L(field) \
                                T.field[1 * AMR_TILE_DIM + (j+2)] = prolongate_cell(ic, jc, 0.25, yf, &AMRPrimitiveTileT<RealType>::field); \
                                T.field[0 * AMR_TILE_DIM + (j+2)] = prolongate_cell(ic, jc, -0.25, yf, &AMRPrimitiveTileT<RealType>::field);
                            PROLONG_L(rho) PROLONG_L(ur) PROLONG_L(uz) PROLONG_L(p) PROLONG_L(E) PROLONG_L(alpha1) PROLONG_L(alpha2) PROLONG_L(arho1) PROLONG_L(arho2)
                            #undef PROLONG_L
                        }
                    } else if (d == AMR_DIR_RIGHT) {
                        int ic = 2; // column 0 of coarse Nb (+2 offset)
                        for (int j = 0; j < 16; ++j) {
                            int jc = (j / 2) + 2 + z_off * 8;
                            double yf = (j % 2 == 0) ? -0.25 : 0.25;
                            #define PROLONG_R(field) \
                                T.field[18 * AMR_TILE_DIM + (j+2)] = prolongate_cell(ic, jc, -0.25, yf, &AMRPrimitiveTileT<RealType>::field); \
                                T.field[19 * AMR_TILE_DIM + (j+2)] = prolongate_cell(ic, jc, 0.25, yf, &AMRPrimitiveTileT<RealType>::field);
                            PROLONG_R(rho) PROLONG_R(ur) PROLONG_R(uz) PROLONG_R(p) PROLONG_R(E) PROLONG_R(alpha1) PROLONG_R(alpha2) PROLONG_R(arho1) PROLONG_R(arho2)
                            #undef PROLONG_R
                        }
                    } else if (d == AMR_DIR_BOTTOM) {
                        int jc = 17; // row 15 of coarse Nb (+2 offset)
                        for (int i = 0; i < 16; ++i) {
                            int ic = (i / 2) + 2 + r_off * 8;
                            double xf = (i % 2 == 0) ? -0.25 : 0.25;
                            #define PROLONG_B(field) \
                                T.field[(i+2) * AMR_TILE_DIM + 1] = prolongate_cell(ic, jc, xf, 0.25, &AMRPrimitiveTileT<RealType>::field); \
                                T.field[(i+2) * AMR_TILE_DIM + 0] = prolongate_cell(ic, jc, xf, -0.25, &AMRPrimitiveTileT<RealType>::field);
                            PROLONG_B(rho) PROLONG_B(ur) PROLONG_B(uz) PROLONG_B(p) PROLONG_B(E) PROLONG_B(alpha1) PROLONG_B(alpha2) PROLONG_B(arho1) PROLONG_B(arho2)
                            #undef PROLONG_B
                        }
                    } else if (d == AMR_DIR_TOP) {
                        int jc = 2; // row 0 of coarse Nb (+2 offset)
                        for (int i = 0; i < 16; ++i) {
                            int ic = (i / 2) + 2 + r_off * 8;
                            double xf = (i % 2 == 0) ? -0.25 : 0.25;
                            #define PROLONG_T(field) \
                                T.field[(i+2) * AMR_TILE_DIM + 18] = prolongate_cell(ic, jc, xf, -0.25, &AMRPrimitiveTileT<RealType>::field); \
                                T.field[(i+2) * AMR_TILE_DIM + 19] = prolongate_cell(ic, jc, xf, 0.25, &AMRPrimitiveTileT<RealType>::field);
                            PROLONG_T(rho) PROLONG_T(ur) PROLONG_T(uz) PROLONG_T(p) PROLONG_T(E) PROLONG_T(alpha1) PROLONG_T(alpha2) PROLONG_T(arho1) PROLONG_T(arho2)
                            #undef PROLONG_T
                        }
                    }
                }
            } else {
                // Apply boundary conditions cell-by-cell on ghost cells
                if (d == AMR_DIR_LEFT) {
                    for (int j = 0; j < 16; ++j) {
                        int tj = j + 2;
                        CellState2DT<RealType> s1 = { T.rho[2*AMR_TILE_DIM+tj], T.ur[2*AMR_TILE_DIM+tj], T.uz[2*AMR_TILE_DIM+tj], T.p[2*AMR_TILE_DIM+tj], T.E[2*AMR_TILE_DIM+tj], T.alpha1[2*AMR_TILE_DIM+tj], T.alpha2[2*AMR_TILE_DIM+tj], T.arho1[2*AMR_TILE_DIM+tj], T.arho2[2*AMR_TILE_DIM+tj] };
                        s1 = applyBC_AMR_kernel(s1, (int)bc_r_min, s1.ur, (RealType)ambient_rho_val, (RealType)ambient_p_val, (RealType)gamma_val, materials_val, is_ideal_gas_val, true);
                        T.rho[1*AMR_TILE_DIM+tj] = s1.rho; T.ur[1*AMR_TILE_DIM+tj] = s1.ur; T.uz[1*AMR_TILE_DIM+tj] = s1.uz; T.p[1*AMR_TILE_DIM+tj] = s1.p; T.E[1*AMR_TILE_DIM+tj] = s1.E; T.alpha1[1*AMR_TILE_DIM+tj] = s1.alpha1; T.alpha2[1*AMR_TILE_DIM+tj] = s1.alpha2; T.arho1[1*AMR_TILE_DIM+tj] = s1.arho1; T.arho2[1*AMR_TILE_DIM+tj] = s1.arho2;
                        T.rho[0*AMR_TILE_DIM+tj] = s1.rho; T.ur[0*AMR_TILE_DIM+tj] = s1.ur; T.uz[0*AMR_TILE_DIM+tj] = s1.uz; T.p[0*AMR_TILE_DIM+tj] = s1.p; T.E[0*AMR_TILE_DIM+tj] = s1.E; T.alpha1[0*AMR_TILE_DIM+tj] = s1.alpha1; T.alpha2[0*AMR_TILE_DIM+tj] = s1.alpha2; T.arho1[0*AMR_TILE_DIM+tj] = s1.arho1; T.arho2[0*AMR_TILE_DIM+tj] = s1.arho2;
                    }
                } else if (d == AMR_DIR_RIGHT) {
                    for (int j = 0; j < 16; ++j) {
                        int tj = j + 2;
                        CellState2DT<RealType> s1 = { T.rho[17*AMR_TILE_DIM+tj], T.ur[17*AMR_TILE_DIM+tj], T.uz[17*AMR_TILE_DIM+tj], T.p[17*AMR_TILE_DIM+tj], T.E[17*AMR_TILE_DIM+tj], T.alpha1[17*AMR_TILE_DIM+tj], T.alpha2[17*AMR_TILE_DIM+tj], T.arho1[17*AMR_TILE_DIM+tj], T.arho2[17*AMR_TILE_DIM+tj] };
                        s1 = applyBC_AMR_kernel(s1, (int)bc_r_max, -s1.ur, (RealType)ambient_rho_val, (RealType)ambient_p_val, (RealType)gamma_val, materials_val, is_ideal_gas_val, true);
                        T.rho[18*AMR_TILE_DIM+tj] = s1.rho; T.ur[18*AMR_TILE_DIM+tj] = s1.ur; T.uz[18*AMR_TILE_DIM+tj] = s1.uz; T.p[18*AMR_TILE_DIM+tj] = s1.p; T.E[18*AMR_TILE_DIM+tj] = s1.E; T.alpha1[18*AMR_TILE_DIM+tj] = s1.alpha1; T.alpha2[18*AMR_TILE_DIM+tj] = s1.alpha2; T.arho1[18*AMR_TILE_DIM+tj] = s1.arho1; T.arho2[18*AMR_TILE_DIM+tj] = s1.arho2;
                        T.rho[19*AMR_TILE_DIM+tj] = s1.rho; T.ur[19*AMR_TILE_DIM+tj] = s1.ur; T.uz[19*AMR_TILE_DIM+tj] = s1.uz; T.p[19*AMR_TILE_DIM+tj] = s1.p; T.E[19*AMR_TILE_DIM+tj] = s1.E; T.alpha1[19*AMR_TILE_DIM+tj] = s1.alpha1; T.alpha2[19*AMR_TILE_DIM+tj] = s1.alpha2; T.arho1[19*AMR_TILE_DIM+tj] = s1.arho1; T.arho2[19*AMR_TILE_DIM+tj] = s1.arho2;
                    }
                } else if (d == AMR_DIR_BOTTOM) {
                    for (int i = 0; i < 16; ++i) {
                        int ti = i + 2;
                        CellState2DT<RealType> s1 = { T.rho[ti*AMR_TILE_DIM+2], T.ur[ti*AMR_TILE_DIM+2], T.uz[ti*AMR_TILE_DIM+2], T.p[ti*AMR_TILE_DIM+2], T.E[ti*AMR_TILE_DIM+2], T.alpha1[ti*AMR_TILE_DIM+2], T.alpha2[ti*AMR_TILE_DIM+2], T.arho1[ti*AMR_TILE_DIM+2], T.arho2[ti*AMR_TILE_DIM+2] };
                        s1 = applyBC_AMR_kernel(s1, (int)bc_z_min, s1.uz, (RealType)ambient_rho_val, (RealType)ambient_p_val, (RealType)gamma_val, materials_val, is_ideal_gas_val, false);
                        T.rho[ti*AMR_TILE_DIM+1] = s1.rho; T.ur[ti*AMR_TILE_DIM+1] = s1.ur; T.uz[ti*AMR_TILE_DIM+1] = s1.uz; T.p[ti*AMR_TILE_DIM+1] = s1.p; T.E[ti*AMR_TILE_DIM+1] = s1.E; T.alpha1[ti*AMR_TILE_DIM+1] = s1.alpha1; T.alpha2[ti*AMR_TILE_DIM+1] = s1.alpha2; T.arho1[ti*AMR_TILE_DIM+1] = s1.arho1; T.arho2[ti*AMR_TILE_DIM+1] = s1.arho2;
                        T.rho[ti*AMR_TILE_DIM+0] = s1.rho; T.ur[ti*AMR_TILE_DIM+0] = s1.ur; T.uz[ti*AMR_TILE_DIM+0] = s1.uz; T.p[ti*AMR_TILE_DIM+0] = s1.p; T.E[ti*AMR_TILE_DIM+0] = s1.E; T.alpha1[ti*AMR_TILE_DIM+0] = s1.alpha1; T.alpha2[ti*AMR_TILE_DIM+0] = s1.alpha2; T.arho1[ti*AMR_TILE_DIM+0] = s1.arho1; T.arho2[ti*AMR_TILE_DIM+0] = s1.arho2;
                    }
                } else if (d == AMR_DIR_TOP) {
                    for (int i = 0; i < 16; ++i) {
                        int ti = i + 2;
                        CellState2DT<RealType> s1 = { T.rho[ti*AMR_TILE_DIM+17], T.ur[ti*AMR_TILE_DIM+17], T.uz[ti*AMR_TILE_DIM+17], T.p[ti*AMR_TILE_DIM+17], T.E[ti*AMR_TILE_DIM+17], T.alpha1[ti*AMR_TILE_DIM+17], T.alpha2[ti*AMR_TILE_DIM+17], T.arho1[ti*AMR_TILE_DIM+17], T.arho2[ti*AMR_TILE_DIM+17] };
                        s1 = applyBC_AMR_kernel(s1, (int)bc_z_max, -s1.uz, (RealType)ambient_rho_val, (RealType)ambient_p_val, (RealType)gamma_val, materials_val, is_ideal_gas_val, false);
                        T.rho[ti*AMR_TILE_DIM+18] = s1.rho; T.ur[ti*AMR_TILE_DIM+18] = s1.ur; T.uz[ti*AMR_TILE_DIM+18] = s1.uz; T.p[ti*AMR_TILE_DIM+18] = s1.p; T.E[ti*AMR_TILE_DIM+18] = s1.E; T.alpha1[ti*AMR_TILE_DIM+18] = s1.alpha1; T.alpha2[ti*AMR_TILE_DIM+18] = s1.alpha2; T.arho1[ti*AMR_TILE_DIM+18] = s1.arho1; T.arho2[ti*AMR_TILE_DIM+18] = s1.arho2;
                        T.rho[ti*AMR_TILE_DIM+19] = s1.rho; T.ur[ti*AMR_TILE_DIM+19] = s1.ur; T.uz[ti*AMR_TILE_DIM+19] = s1.uz; T.p[ti*AMR_TILE_DIM+19] = s1.p; T.E[ti*AMR_TILE_DIM+19] = s1.E; T.alpha1[ti*AMR_TILE_DIM+19] = s1.alpha1; T.alpha2[ti*AMR_TILE_DIM+19] = s1.alpha2; T.arho1[ti*AMR_TILE_DIM+19] = s1.arho1; T.arho2[ti*AMR_TILE_DIM+19] = s1.arho2;
                    }
                }
            }
        }

        // Fill the 4 corner ghost pads (2x2 cells at each corner)
        auto copy_corner_cell = [&](int dst_i, int dst_j, int src_node_idx, int src_i, int src_j) {
            int dst_k = dst_i * AMR_TILE_DIM + dst_j;
            if (src_node_idx != -1 && amr_nodes[src_node_idx].tile_id != -1) {
                const auto& Nb = states_pool[amr_nodes[src_node_idx].tile_id];
                int src_k = src_i * AMR_TILE_DIM + src_j;
                T.rho[dst_k] = Nb.rho[src_k];
                T.ur[dst_k] = Nb.ur[src_k];
                T.uz[dst_k] = Nb.uz[src_k];
                T.p[dst_k] = Nb.p[src_k];
                T.E[dst_k] = Nb.E[src_k];
                T.alpha1[dst_k] = Nb.alpha1[src_k];
                T.alpha2[dst_k] = Nb.alpha2[src_k];
                T.arho1[dst_k] = Nb.arho1[src_k];
                T.arho2[dst_k] = Nb.arho2[src_k];
            } else {
                // Fallback: copy from adjacent cardinal ghost cell
                int fallback_i = (dst_i < 2) ? 0 : (dst_i >= 18 ? 19 : dst_i);
                int fallback_j = (dst_j < 2) ? 2 : (dst_j >= 18 ? 17 : dst_j);
                int src_k = fallback_i * AMR_TILE_DIM + fallback_j;
                T.rho[dst_k] = T.rho[src_k];
                T.ur[dst_k] = T.ur[src_k];
                T.uz[dst_k] = T.uz[src_k];
                T.p[dst_k] = T.p[src_k];
                T.E[dst_k] = T.E[src_k];
                T.alpha1[dst_k] = T.alpha1[src_k];
                T.alpha2[dst_k] = T.alpha2[src_k];
                T.arho1[dst_k] = T.arho1[src_k];
                T.arho2[dst_k] = T.arho2[src_k];
            }
        };

        // 1. Bottom-Left corner (i = 0..1, j = 0..1)
        int nb_bl = findNodeByCoords(node.r_idx - 1, node.z_idx - 1, node.level);
        for (int ci = 0; ci < 2; ++ci) {
            for (int cj = 0; cj < 2; ++cj) {
                copy_corner_cell(ci, cj, nb_bl, 16 + ci, 16 + cj);
            }
        }

        // 2. Bottom-Right corner (i = 18..19, j = 0..1)
        int nb_br = findNodeByCoords(node.r_idx + 1, node.z_idx - 1, node.level);
        for (int ci = 0; ci < 2; ++ci) {
            for (int cj = 0; cj < 2; ++cj) {
                copy_corner_cell(18 + ci, cj, nb_br, 2 + ci, 16 + cj);
            }
        }

        // 3. Top-Left corner (i = 0..1, j = 18..19)
        int nb_tl = findNodeByCoords(node.r_idx - 1, node.z_idx + 1, node.level);
        for (int ci = 0; ci < 2; ++ci) {
            for (int cj = 0; cj < 2; ++cj) {
                copy_corner_cell(ci, 18 + cj, nb_tl, 16 + ci, 2 + cj);
            }
        }

        // 4. Top-Right corner (i = 18..19, j = 18..19)
        int nb_tr = findNodeByCoords(node.r_idx + 1, node.z_idx + 1, node.level);
        for (int ci = 0; ci < 2; ++ci) {
            for (int cj = 0; cj < 2; ++cj) {
                copy_corner_cell(18 + ci, 18 + cj, nb_tr, 2 + ci, 2 + cj);
            }
        }
    }
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::computeTileRHS(int node_idx, double A_coeff, double dt) {
    const auto& node = amr_nodes[node_idx];
    int pool_idx = node.tile_id;
    auto& T = states_pool[pool_idx];
    auto& dU = dU_pool[pool_idx];

    RealType A_coeff_r = (RealType)A_coeff;
    RealType dt_r = (RealType)dt;
    RealType gamma_r = (RealType)gamma_val;

    double factor = 1.0 / (1 << node.level);
    RealType dr_r = (RealType)(dr_base * factor);
    RealType dz_r = (RealType)(dz_base * factor);

    for (int i = 0; i < 16; ++i) {
        int ti = i + 2;
        double global_r = node.r_min + (i + 0.5) * dr_base * factor;

        for (int j = 0; j < 16; ++j) {
            int tj = j + 2;
            int k_20 = ti * AMR_TILE_DIM + tj;
            int k_16 = i * TILE_SIZE + j;

            auto readStateLocal = [&](int ii, int jj) {
                int idx = ii * AMR_TILE_DIM + jj;
                CellState2DT<RealType> s = { T.rho[idx], T.ur[idx], T.uz[idx], T.p[idx], T.E[idx], T.alpha1[idx], T.alpha2[idx], T.arho1[idx], T.arho2[idx] };
                return s;
            };

            CellState2DT<RealType> s_c = readStateLocal(ti, tj);
            CellState2DT<RealType> s_L = readStateLocal(ti - 1, tj);
            CellState2DT<RealType> s_R = readStateLocal(ti + 1, tj);
            CellState2DT<RealType> s_B = readStateLocal(ti, tj - 1);
            CellState2DT<RealType> s_T = readStateLocal(ti, tj + 1);

            CellState2DT<RealType> s_faceL_L = s_L;
            CellState2DT<RealType> s_faceL_R = s_c;
            CellState2DT<RealType> s_faceR_L = s_c;
            CellState2DT<RealType> s_faceR_R = s_R;
            CellState2DT<RealType> s_faceB_L = s_B;
            CellState2DT<RealType> s_faceB_R = s_c;
            CellState2DT<RealType> s_faceT_L = s_c;
            CellState2DT<RealType> s_faceT_R = s_T;

            if (spatial_order_val == 2) {
                CellState2DT<RealType> s_LL = readStateLocal(ti - 2, tj);
                CellState2DT<RealType> s_RR = readStateLocal(ti + 2, tj);
                CellState2DT<RealType> s_BB = readStateLocal(ti, tj - 2);
                CellState2DT<RealType> s_TT = readStateLocal(ti, tj + 2);

                #define RECONSTRUCT(L, R, LL, RR, fl_L, fl_R, fr_L, fr_R, field) \
                    fl_L.field = L.field + (RealType)0.5 * minmod_kernel(L.field - LL.field, s_c.field - L.field); \
                    fl_R.field = s_c.field - (RealType)0.5 * minmod_kernel(s_c.field - L.field, R.field - s_c.field); \
                    fr_L.field = s_c.field + (RealType)0.5 * minmod_kernel(s_c.field - L.field, R.field - s_c.field); \
                    fr_R.field = R.field - (RealType)0.5 * minmod_kernel(R.field - s_c.field, RR.field - R.field);

                RECONSTRUCT(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, rho)
                RECONSTRUCT(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, ur)
                RECONSTRUCT(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, uz)
                RECONSTRUCT(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, p)
                RECONSTRUCT(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, alpha1)
                RECONSTRUCT(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, alpha2)
                RECONSTRUCT(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, arho1)
                RECONSTRUCT(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, arho2)

                RECONSTRUCT(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, rho)
                RECONSTRUCT(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, ur)
                RECONSTRUCT(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, uz)
                RECONSTRUCT(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, p)
                RECONSTRUCT(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, alpha1)
                RECONSTRUCT(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, alpha2)
                RECONSTRUCT(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, arho1)
                RECONSTRUCT(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, arho2)
                #undef RECONSTRUCT

                #define CLAMP(face) \
                    face.alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, face.alpha1)); \
                    face.alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, face.alpha2)); \
                    compute_E_kernel(face, gamma_r, materials_val, is_ideal_gas_val);

                CLAMP(s_faceL_L) CLAMP(s_faceL_R) CLAMP(s_faceR_L) CLAMP(s_faceR_R)
                CLAMP(s_faceB_L) CLAMP(s_faceB_R) CLAMP(s_faceT_L) CLAMP(s_faceT_R)
                #undef CLAMP

            } else if (spatial_order_val == 3) {
                CellState2DT<RealType> s_LL = readStateLocal(ti - 2, tj);
                CellState2DT<RealType> s_RR = readStateLocal(ti + 2, tj);
                CellState2DT<RealType> s_BB = readStateLocal(ti, tj - 2);
                CellState2DT<RealType> s_TT = readStateLocal(ti, tj + 2);

                #define RECONSTRUCT_WENO(L, R, LL, RR, fl_L, fl_R, fr_L, fr_R, field) \
                    fl_L.field = weno3_kernel(LL.field, L.field, s_c.field); \
                    fl_R.field = weno3_kernel(R.field, s_c.field, L.field); \
                    fr_L.field = weno3_kernel(L.field, s_c.field, R.field); \
                    fr_R.field = weno3_kernel(RR.field, R.field, s_c.field);

                RECONSTRUCT_WENO(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, rho)
                RECONSTRUCT_WENO(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, ur)
                RECONSTRUCT_WENO(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, uz)
                RECONSTRUCT_WENO(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, p)

                RECONSTRUCT_WENO(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, rho)
                RECONSTRUCT_WENO(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, ur)
                RECONSTRUCT_WENO(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, uz)
                RECONSTRUCT_WENO(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, p)
                #undef RECONSTRUCT_WENO

                // Species fractions still use second-order minmod for WENO3 stability
                #define RECONSTRUCT_MM(L, R, LL, RR, fl_L, fl_R, fr_L, fr_R, field) \
                    fl_L.field = L.field + (RealType)0.5 * minmod_kernel(L.field - LL.field, s_c.field - L.field); \
                    fl_R.field = s_c.field - (RealType)0.5 * minmod_kernel(s_c.field - L.field, R.field - s_c.field); \
                    fr_L.field = s_c.field + (RealType)0.5 * minmod_kernel(s_c.field - L.field, R.field - s_c.field); \
                    fr_R.field = R.field - (RealType)0.5 * minmod_kernel(R.field - s_c.field, RR.field - R.field);

                RECONSTRUCT_MM(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, alpha1)
                RECONSTRUCT_MM(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, alpha2)
                RECONSTRUCT_MM(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, arho1)
                RECONSTRUCT_MM(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, arho2)

                RECONSTRUCT_MM(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, alpha1)
                RECONSTRUCT_MM(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, alpha2)
                RECONSTRUCT_MM(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, arho1)
                RECONSTRUCT_MM(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, arho2)
                #undef RECONSTRUCT_MM

                #define CLAMP(face) \
                    face.alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, face.alpha1)); \
                    face.alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, face.alpha2)); \
                    compute_E_kernel(face, gamma_r, materials_val, is_ideal_gas_val);

                CLAMP(s_faceL_L) CLAMP(s_faceL_R) CLAMP(s_faceR_L) CLAMP(s_faceR_R)
                CLAMP(s_faceB_L) CLAMP(s_faceB_R) CLAMP(s_faceT_L) CLAMP(s_faceT_R)
                #undef CLAMP
            }

            RealType fr_L_rho, fr_L_rhour, fr_L_rhouz, fr_L_E, fr_L_a1, fr_L_a2, fr_L_ar1, fr_L_ar2, v_face_rL;
            RealType fr_R_rho, fr_R_rhour, fr_R_rhouz, fr_R_E, fr_R_a1, fr_R_a2, fr_R_ar1, fr_R_ar2, v_face_rR;
            
            calcFluxRusanov_kernel(s_faceL_L, s_faceL_R, gamma_r, materials_val, fr_L_rho, fr_L_rhour, fr_L_rhouz, fr_L_E, fr_L_a1, fr_L_a2, fr_L_ar1, fr_L_ar2, v_face_rL, is_ideal_gas_val);
            calcFluxRusanov_kernel(s_faceR_L, s_faceR_R, gamma_r, materials_val, fr_R_rho, fr_R_rhour, fr_R_rhouz, fr_R_E, fr_R_a1, fr_R_a2, fr_R_ar1, fr_R_ar2, v_face_rR, is_ideal_gas_val);
            
            RealType fz_B_rho, fz_B_rhour, fz_B_rhouz, fz_B_E, fz_B_a1, fz_B_a2, fz_B_ar1, fz_B_ar2, v_face_zB;
            RealType fz_T_rho, fz_T_rhour, fz_T_rhouz, fz_T_E, fz_T_a1, fz_T_a2, fz_T_ar1, fz_T_ar2, v_face_zT;

            calcFluxRusanovZ_kernel(s_faceB_L, s_faceB_R, gamma_r, materials_val, fz_B_rho, fz_B_rhour, fz_B_rhouz, fz_B_E, fz_B_a1, fz_B_a2, fz_B_ar1, fz_B_ar2, v_face_zB, is_ideal_gas_val);
            calcFluxRusanovZ_kernel(s_faceT_L, s_faceT_R, gamma_r, materials_val, fz_T_rho, fz_T_rhour, fz_T_rhouz, fz_T_E, fz_T_a1, fz_T_a2, fz_T_ar1, fz_T_ar2, v_face_zT, is_ideal_gas_val);

            // Record interface fluxes for conservative matching on outer boundary cells
            if (i == 0) {
                auto& f = node_boundary_fluxes[node_idx][AMR_DIR_LEFT];
                f.rho[j] = fr_L_rho; f.rhour[j] = fr_L_rhour; f.rhouz[j] = fr_L_rhouz; f.E[j] = fr_L_E;
                f.alpha1[j] = fr_L_a1; f.alpha2[j] = fr_L_a2; f.arho1[j] = fr_L_ar1; f.arho2[j] = fr_L_ar2;
            }
            if (i == 15) {
                auto& f = node_boundary_fluxes[node_idx][AMR_DIR_RIGHT];
                f.rho[j] = fr_R_rho; f.rhour[j] = fr_R_rhour; f.rhouz[j] = fr_R_rhouz; f.E[j] = fr_R_E;
                f.alpha1[j] = fr_R_a1; f.alpha2[j] = fr_R_a2; f.arho1[j] = fr_R_ar1; f.arho2[j] = fr_R_ar2;
            }
            if (j == 0) {
                auto& f = node_boundary_fluxes[node_idx][AMR_DIR_BOTTOM];
                f.rho[i] = fz_B_rho; f.rhour[i] = fz_B_rhour; f.rhouz[i] = fz_B_rhouz; f.E[i] = fz_B_E;
                f.alpha1[i] = fz_B_a1; f.alpha2[i] = fz_B_a2; f.arho1[i] = fz_B_ar1; f.arho2[i] = fz_B_ar2;
            }
            if (j == 15) {
                auto& f = node_boundary_fluxes[node_idx][AMR_DIR_TOP];
                f.rho[i] = fz_T_rho; f.rhour[i] = fz_T_rhour; f.rhouz[i] = fz_T_rhouz; f.E[i] = fz_T_E;
                f.alpha1[i] = fz_T_a1; f.alpha2[i] = fz_T_a2; f.arho1[i] = fz_T_ar1; f.arho2[i] = fz_T_ar2;
            }

            RealType r_center = (RealType)global_r;
            RealType r_left = (RealType)(global_r - 0.5 * dr_r);
            RealType r_right = (RealType)(global_r + 0.5 * dr_r);
            
            RealType dU_rho = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_rho - r_left * fr_L_rho) - ((RealType)1.0 / dz_r) * (fz_T_rho - fz_B_rho);
            RealType dU_rhour = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_rhour - r_left * fr_L_rhour) - ((RealType)1.0 / dz_r) * (fz_T_rhour - fz_B_rhour) + s_c.p / r_center;
            RealType dU_rhouz = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_rhouz - r_left * fr_L_rhouz) - ((RealType)1.0 / dz_r) * (fz_T_rhouz - fz_B_rhouz);
            RealType dU_E = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_E - r_left * fr_L_E) - ((RealType)1.0 / dz_r) * (fz_T_E - fz_B_E);

            RealType div_u = ((RealType)1.0 / (r_center * dr_r)) * (r_right * v_face_rR - r_left * v_face_rL) + ((RealType)1.0 / dz_r) * (v_face_zT - v_face_zB);
            
            RealType dU_alpha1 = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_a1 - r_left * fr_L_a1) - ((RealType)1.0 / dz_r) * (fz_T_a1 - fz_B_a1) + s_c.alpha1 * div_u;
            RealType dU_alpha2 = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_a2 - r_left * fr_L_a2) - ((RealType)1.0 / dz_r) * (fz_T_a2 - fz_B_a2) + s_c.alpha2 * div_u;
            RealType dU_arho1 = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_ar1 - r_left * fr_L_ar1) - ((RealType)1.0 / dz_r) * (fz_T_ar1 - fz_B_ar1);
            RealType dU_arho2 = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_ar2 - r_left * fr_L_ar2) - ((RealType)1.0 / dz_r) * (fz_T_ar2 - fz_B_ar2);

            dU.rho[k_20] = A_coeff_r * dU.rho[k_20] + dt_r * dU_rho;
            dU.rhour[k_20] = A_coeff_r * dU.rhour[k_20] + dt_r * dU_rhour;
            dU.rhouz[k_20] = A_coeff_r * dU.rhouz[k_20] + dt_r * dU_rhouz;
            dU.E[k_20] = A_coeff_r * dU.E[k_20] + dt_r * dU_E;
            dU.alpha1[k_20] = A_coeff_r * dU.alpha1[k_20] + dt_r * dU_alpha1;
            dU.alpha2[k_20] = A_coeff_r * dU.alpha2[k_20] + dt_r * dU_alpha2;
            dU.arho1[k_20] = A_coeff_r * dU.arho1[k_20] + dt_r * dU_arho1;
            dU.arho2[k_20] = A_coeff_r * dU.arho2[k_20] + dt_r * dU_arho2;
        }
    }
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::applyLSRK3Step(int stage, double dt) {
    const double A[3] = {0.0, -5.0/9.0, -153.0/128.0};
    const double B[3] = {1.0/3.0, 15.0/16.0, 8.0/15.0};

    // Fill ghost cells before RHS evaluation
    fillGhostCells();

    #pragma omp parallel for
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        if (amr_nodes[n].tile_id != -1 && amr_nodes[n].is_active) {
            computeTileRHS(n, A[stage], dt);
        }
    }

    // Apply flux correction to preserve conservation at resolution jumps
    applyFluxCorrection(dt);

    #pragma omp parallel for
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        if (amr_nodes[n].tile_id != -1 && amr_nodes[n].is_active) {
            int pool_idx = amr_nodes[n].tile_id;
            auto& U = U_pool[pool_idx];
            const auto& dU = dU_pool[pool_idx];

            for (int i = 0; i < 16; ++i) {
                for (int j = 0; j < 16; ++j) {
                    int k = (i + 2) * AMR_TILE_DIM + (j + 2);
                    U.rho[k] += (RealType)(B[stage] * dU.rho[k]);
                    U.rhour[k] += (RealType)(B[stage] * dU.rhour[k]);
                    U.rhouz[k] += (RealType)(B[stage] * dU.rhouz[k]);
                    U.E[k] += (RealType)(B[stage] * dU.E[k]);
                    U.alpha1[k] += (RealType)(B[stage] * dU.alpha1[k]);
                    U.alpha2[k] += (RealType)(B[stage] * dU.alpha2[k]);
                    U.arho1[k] += (RealType)(B[stage] * dU.arho1[k]);
                    U.arho2[k] += (RealType)(B[stage] * dU.arho2[k]);
                }
            }
        }
    }
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::applyFluxCorrection(double dt) {
    // Correct coarse cells adjacent to a fine neighbor boundary
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        const auto& node = amr_nodes[n];
        if (node.tile_id == -1 || !node.is_active) continue;

        for (int d = 0; d < 4; ++d) {
            int nb_idx = node.neighbors[d];
            if (nb_idx == -1) continue;

            const auto& nb_node = amr_nodes[nb_idx];
            if (nb_node.level == node.level + 1) {
                // Neighbors at higher level (meaning nb_node has refined children)
                // Correct our coarse tile boundary cells with the sum of fine fluxes
                auto& U = U_pool[node.tile_id];
                RealType dt_r = (RealType)dt;
                double factor = 1.0 / (1 << node.level);
                RealType dx = (RealType)(d == AMR_DIR_LEFT || d == AMR_DIR_RIGHT ? dr_base * factor : dz_base * factor);

                // Find the children of nb_node that touch our boundary
                int child1 = -1, child2 = -1;
                int fine_dir = -1;
                if (d == AMR_DIR_LEFT) {
                    child1 = nb_node.children[1]; child2 = nb_node.children[3]; fine_dir = AMR_DIR_RIGHT;
                } else if (d == AMR_DIR_RIGHT) {
                    child1 = nb_node.children[0]; child2 = nb_node.children[2]; fine_dir = AMR_DIR_LEFT;
                } else if (d == AMR_DIR_BOTTOM) {
                    child1 = nb_node.children[2]; child2 = nb_node.children[3]; fine_dir = AMR_DIR_TOP;
                } else if (d == AMR_DIR_TOP) {
                    child1 = nb_node.children[0]; child2 = nb_node.children[1]; fine_dir = AMR_DIR_BOTTOM;
                }

                if (child1 == -1 || child2 == -1) continue;

                // Loop over the 16 boundary cells of this face
                for (int c = 0; c < 16; ++c) {
                    // Match fine cells to coarse cell c
                    int fc1 = (c * 2);
                    int fc2 = (c * 2) + 1;
                    int f_idx1 = fc1 % 16;
                    int f_idx2 = fc2 % 16;
                    int fine_node_idx = (fc1 < 16) ? child1 : child2;

                    const auto& f_flux = node_boundary_fluxes[fine_node_idx][fine_dir];

                    // Coarse index
                    int ci = (d == AMR_DIR_LEFT) ? 2 : ((d == AMR_DIR_RIGHT) ? 17 : c + 2);
                    int cj = (d == AMR_DIR_BOTTOM) ? 2 : ((d == AMR_DIR_TOP) ? 17 : c + 2);
                    int ck = ci * AMR_TILE_DIM + cj;

                    // Compute the coarse flux we calculated
                    const auto& c_flux = node_boundary_fluxes[n][d];

                    // Standard conservation mismatch correction: sum of fine minus coarse
                    // We divide by 2 since dx fine is half of coarse dx
                    #define CORRECT(field) \
                    { \
                        RealType fine_sum = (RealType)0.5 * (f_flux.field[f_idx1] + f_flux.field[f_idx2]); \
                        U.field[ck] += (RealType)(dt_r / dx) * (c_flux.field[c] - fine_sum); \
                    }

                    CORRECT(rho) CORRECT(rhour) CORRECT(rhouz) CORRECT(E) CORRECT(alpha1) CORRECT(alpha2) CORRECT(arho1) CORRECT(arho2)
                    #undef CORRECT
                }
            }
        }
    }
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::updatePrimitiveFromConservative() {
    const RealType rho_floor = (RealType)1e-8;
    const RealType p_floor = (RealType)1e-8;

    #pragma omp parallel for
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        if (amr_nodes[n].tile_id == -1) continue;
        int pool_idx = amr_nodes[n].tile_id;
        auto& U = U_pool[pool_idx];
        auto& S = states_pool[pool_idx];

        for (int k = 0; k < AMR_TILE_DIM * AMR_TILE_DIM; ++k) {
            RealType u_rho = U.rho[k];
            RealType u_rhour = U.rhour[k];
            RealType u_rhouz = U.rhouz[k];
            RealType u_E = U.E[k];
            RealType u_alpha1 = U.alpha1[k];
            RealType u_alpha2 = U.alpha2[k];
            RealType u_arho1 = U.arho1[k];
            RealType u_arho2 = U.arho2[k];

            bool bad = std::isnan(u_rho) || std::isinf(u_rho) || u_rho < rho_floor ||
                       std::isnan(u_rhour) || std::isinf(u_rhour) ||
                       std::isnan(u_rhouz) || std::isinf(u_rhouz) ||
                       std::isnan(u_E) || std::isinf(u_E);

            int floor_status = 0;
            RealType p = (RealType)ambient_p_val;
            RealType ur = 0.0;
            RealType uz = 0.0;

            if (!bad) {
                RealType rho_safe = std::max(u_rho, rho_floor);
                ur = u_rhour / rho_safe;
                uz = u_rhouz / rho_safe;
                RealType ke = 0.5 * rho_safe * (ur * ur + uz * uz);

                RealType alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, u_alpha1));
                RealType alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, u_alpha2));
                if (alpha1 + alpha2 > (RealType)1.0) {
                    RealType sum = alpha1 + alpha2;
                    alpha1 /= sum;
                    alpha2 /= sum;
                }

                RealType arho1 = std::max((RealType)0.0, std::min(u_rho, u_arho1));
                RealType arho2 = std::max((RealType)0.0, std::min(u_rho, u_arho2));
                if (arho1 + arho2 > u_rho) {
                    RealType sum = arho1 + arho2;
                    arho1 = (arho1 / sum) * u_rho;
                    arho2 = (arho2 / sum) * u_rho;
                }

                RealType e_internal = std::max(u_E - ke, p_floor / ((RealType)gamma_val - (RealType)1.0));
                if (is_ideal_gas_val) {
                    p = e_internal * ((RealType)gamma_val - (RealType)1.0);
                } else {
                    p = MultiMat::getMixturePressure(e_internal, u_rho, alpha1, alpha2, arho1, arho2, (RealType)gamma_val, materials_val.products, materials_val.unreacted);
                }
                
                if (std::isnan(p) || std::isinf(p) || p < p_floor) {
                    bad = true;
                } else {
                    S.rho[k] = rho_safe;
                    S.ur[k] = ur;
                    S.uz[k] = uz;
                    S.E[k] = u_E;
                    S.alpha1[k] = alpha1;
                    S.alpha2[k] = alpha2;
                    S.arho1[k] = arho1;
                    S.arho2[k] = arho2;
                    S.p[k] = p;
                }
            }

            if (bad) {
                // Fallback to ambient
                S.rho[k] = (RealType)ambient_rho_val;
                S.ur[k] = 0.0;
                S.uz[k] = 0.0;
                S.p[k] = (RealType)ambient_p_val;
                S.alpha1[k] = 0.0;
                S.alpha2[k] = 0.0;
                S.arho1[k] = 0.0;
                S.arho2[k] = 0.0;
                S.E[k] = (RealType)ambient_p_val / ((RealType)gamma_val - (RealType)1.0);
                
                U.rho[k] = (RealType)ambient_rho_val;
                U.rhour[k] = 0.0;
                U.rhouz[k] = 0.0;
                U.E[k] = S.E[k];
                U.alpha1[k] = 0.0;
                U.alpha2[k] = 0.0;
                U.arho1[k] = 0.0;
                U.arho2[k] = 0.0;
            }
            S.floor_status[k] = floor_status;
        }
    }
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::restrictAll() {
    // Restrict values from finest level down to level 0
    for (int lvl = amr_max_levels_val - 2; lvl >= 0; --lvl) {
        #pragma omp parallel for
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            if (amr_nodes[n].level == lvl && amr_nodes[n].children[0] != -1) {
                restrictNode(n);
            }
        }
    }
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::restrictNode(int node_idx) {
    const auto& node = amr_nodes[node_idx];
    auto& U_parent = U_pool[node.tile_id];

    int child_bl = amr_nodes[node.children[0]].tile_id;
    int child_br = amr_nodes[node.children[1]].tile_id;
    int child_tl = amr_nodes[node.children[2]].tile_id;
    int child_tr = amr_nodes[node.children[3]].tile_id;

    for (int pi = 0; pi < AMR_TILE_DIM; ++pi) {
        int child_tile_r = (pi >= 10) ? 1 : 0;
        int local_pi = pi % 10;
        int ci1 = 2 * local_pi;
        int ci2 = 2 * local_pi + 1;

        for (int pj = 0; pj < AMR_TILE_DIM; ++pj) {
            int pk = pi * AMR_TILE_DIM + pj;
            int child_tile_z = (pj >= 10) ? 2 : 0;
            int quadrant = child_tile_r + child_tile_z;

            int active_child_tile_id = -1;
            if (quadrant == 0) active_child_tile_id = child_bl;
            else if (quadrant == 1) active_child_tile_id = child_br;
            else if (quadrant == 2) active_child_tile_id = child_tl;
            else active_child_tile_id = child_tr;

            int local_pj = pj % 10;
            int cj1 = 2 * local_pj;
            int cj2 = 2 * local_pj + 1;

            auto get_child_val = [&](int child_id, int local_i, int local_j, auto field) {
                int k = local_i * AMR_TILE_DIM + local_j;
                return (U_pool[child_id].*field)[k];
            };

            #define RESTRICT_FIELD(field) \
            { \
                RealType val_bl = get_child_val(active_child_tile_id, ci1, cj1, &AMRConservativeTileT<RealType>::field); \
                RealType val_br = get_child_val(active_child_tile_id, ci2, cj1, &AMRConservativeTileT<RealType>::field); \
                RealType val_tl = get_child_val(active_child_tile_id, ci1, cj2, &AMRConservativeTileT<RealType>::field); \
                RealType val_tr = get_child_val(active_child_tile_id, ci2, cj2, &AMRConservativeTileT<RealType>::field); \
                U_parent.field[pk] = (RealType)0.25 * (val_bl + val_br + val_tl + val_tr); \
            }

            RESTRICT_FIELD(rho) RESTRICT_FIELD(rhour) RESTRICT_FIELD(rhouz) RESTRICT_FIELD(E)
            RESTRICT_FIELD(alpha1) RESTRICT_FIELD(alpha2) RESTRICT_FIELD(arho1) RESTRICT_FIELD(arho2)
            #undef RESTRICT_FIELD
        }
    }
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::adaptMesh() {
    // 1. Run restriction sweep first so parent nodes have up-to-date conservative variables before coarsening
    restrictAll();

    std::vector<bool> to_refine(amr_nodes.size(), false);

    // 2. Identify nodes to refine directly, and flag their 8 cardinal/diagonal neighbors
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        const auto& node = amr_nodes[n];
        if (node.tile_id == -1 || !node.is_active) continue;

        if (shouldRefineNode(n)) {
            to_refine[n] = true;
            for (int dr = -1; dr <= 1; ++dr) {
                for (int dz = -1; dz <= 1; ++dz) {
                    if (dr == 0 && dz == 0) continue;
                    int nb_idx = findNodeByCoords(node.r_idx + dr, node.z_idx + dz, node.level);
                    if (nb_idx != -1 && amr_nodes[nb_idx].tile_id != -1 && amr_nodes[nb_idx].is_active) {
                        to_refine[nb_idx] = true;
                    }
                }
            }
        }
    }

    std::vector<int> nodes_to_refine;
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        if (to_refine[n] && amr_nodes[n].level < amr_max_levels_val - 1) {
            nodes_to_refine.push_back(n);
        }
    }

    // 3. Identify parent nodes to coarsen (checking children leaf status, gradient checks, and refinement buffer checks)
    std::vector<int> parents_to_coarsen;
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        const auto& node = amr_nodes[n];
        if (node.children[0] != -1 && node.tile_id != -1) {
            bool all_children_leaves = true;
            bool any_child_refining = false;
            for (int c = 0; c < 4; ++c) {
                int child_idx = node.children[c];
                if (amr_nodes[child_idx].children[0] != -1) {
                    all_children_leaves = false;
                }
                if (to_refine[child_idx]) {
                    any_child_refining = true;
                }
            }
            if (all_children_leaves && !any_child_refining && shouldCoarsenNode(n)) {
                parents_to_coarsen.push_back(n);
            }
        }
    }

    // Refinement execution
    for (int idx : nodes_to_refine) {
        refineNode(idx);
    }

    // Coarsening execution
    for (int idx : parents_to_coarsen) {
        coarsenNode(idx);
    }

    if (!nodes_to_refine.empty() || !parents_to_coarsen.empty()) {
        rebuildNeighborPointers();
        updatePrimitiveFromConservative();
        fillGhostCells();
    }
}

template <typename RealType>
bool CFDSolver2DAMRImpl<RealType>::shouldRefineNode(int node_idx) {
    const auto& node = amr_nodes[node_idx];
    if (node.level >= amr_max_levels_val - 1) return false;

    const auto& S = states_pool[node.tile_id];

    // Normalized gradient check on density, pressure, and volume fraction (internal cells only)
    for (int i = 1; i < 15; ++i) {
        int ti = i + 2;
        for (int j = 1; j < 15; ++j) {
            int tj = j + 2;
            int k = ti * AMR_TILE_DIM + tj;

            double gr_rho = std::abs((double)(S.rho[k+AMR_TILE_DIM] - S.rho[k-AMR_TILE_DIM]));
            double gz_rho = std::abs((double)(S.rho[k+1] - S.rho[k-1]));
            double norm_rho = gr_rho + gz_rho;

            double gr_p = std::abs((double)(S.p[k+AMR_TILE_DIM] - S.p[k-AMR_TILE_DIM]));
            double gz_p = std::abs((double)(S.p[k+1] - S.p[k-1]));
            double norm_p = gr_p + gz_p;

            if (norm_rho / (ambient_rho_val + 1e-4) > amr_threshold_val ||
                norm_p / (ambient_p_val + 1e-4) > amr_threshold_val) {
                return true;
            }
        }
    }
    return false;
}

template <typename RealType>
bool CFDSolver2DAMRImpl<RealType>::shouldCoarsenNode(int parent_idx) {
    const auto& parent = amr_nodes[parent_idx];
    
    // Check if children contain high gradients (internal cells only)
    for (int c = 0; c < 4; ++c) {
        int child_idx = parent.children[c];
        const auto& S = states_pool[amr_nodes[child_idx].tile_id];

        for (int i = 1; i < 15; ++i) {
            int ti = i + 2;
            for (int j = 1; j < 15; ++j) {
                int tj = j + 2;
                int k = ti * AMR_TILE_DIM + tj;

                double gr_rho = std::abs((double)(S.rho[k+AMR_TILE_DIM] - S.rho[k-AMR_TILE_DIM]));
                double gz_rho = std::abs((double)(S.rho[k+1] - S.rho[k-1]));
                double norm_rho = gr_rho + gz_rho;

                double gr_p = std::abs((double)(S.p[k+AMR_TILE_DIM] - S.p[k-AMR_TILE_DIM]));
                double gz_p = std::abs((double)(S.p[k+1] - S.p[k-1]));
                double norm_p = gr_p + gz_p;

                if (norm_rho / (ambient_rho_val + 1e-4) > amr_threshold_val * amr_coarsen_ratio_val ||
                    norm_p / (ambient_p_val + 1e-4) > amr_threshold_val * amr_coarsen_ratio_val) {
                    return false;
                }
            }
        }
    }
    return true;
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::refineNode(int node_idx) {
    int parent_tile_id = amr_nodes[node_idx].tile_id;
    double p_r_min = amr_nodes[node_idx].r_min;
    double p_r_max = amr_nodes[node_idx].r_max;
    double p_z_min = amr_nodes[node_idx].z_min;
    double p_z_max = amr_nodes[node_idx].z_max;
    int p_level = amr_nodes[node_idx].level;
    int p_r_idx = amr_nodes[node_idx].r_idx;
    int p_z_idx = amr_nodes[node_idx].z_idx;

    amr_nodes[node_idx].is_active = false;

    double mid_r = 0.5 * (p_r_min + p_r_max);
    double mid_z = 0.5 * (p_z_min + p_z_max);

    int start_idx = amr_nodes.size();
    for (int c = 0; c < 4; ++c) {
        AMRTileNode child;
        child.tile_id = allocateTile();
        child.level = p_level + 1;
        child.parent = node_idx;
        std::fill(std::begin(child.children), std::end(child.children), -1);
        std::fill(std::begin(child.neighbors), std::end(child.neighbors), -1);
        child.is_active = true;

        if (c == 0) { // Bottom-Left
            child.r_min = p_r_min; child.r_max = mid_r;
            child.z_min = p_z_min; child.z_max = mid_z;
            child.r_idx = p_r_idx * 2;
            child.z_idx = p_z_idx * 2;
        } else if (c == 1) { // Bottom-Right
            child.r_min = mid_r;   child.r_max = p_r_max;
            child.z_min = p_z_min; child.z_max = mid_z;
            child.r_idx = p_r_idx * 2 + 1;
            child.z_idx = p_z_idx * 2;
        } else if (c == 2) { // Top-Left
            child.r_min = p_r_min; child.r_max = mid_r;
            child.z_min = mid_z;   child.z_max = p_z_max;
            child.r_idx = p_r_idx * 2;
            child.z_idx = p_z_idx * 2 + 1;
        } else if (c == 3) { // Top-Right
            child.r_min = mid_r;   child.r_max = p_r_max;
            child.z_min = mid_z;   child.z_max = p_z_max;
            child.r_idx = p_r_idx * 2 + 1;
            child.z_idx = p_z_idx * 2 + 1;
        }

        amr_nodes.push_back(child);
        amr_nodes[node_idx].children[c] = start_idx + c;
    }

    // Prolongate conservative variables from parent to 4 children
    const auto& U_parent = U_pool[parent_tile_id];
    auto prolongate_node_field = [&](int child_idx, int quadrant, auto field) {
        auto& U_child = U_pool[amr_nodes[child_idx].tile_id];
        int r_quad = (quadrant == 1 || quadrant == 3) ? 1 : 0;
        int z_quad = (quadrant == 2 || quadrant == 3) ? 1 : 0;
        
        for (int ci = 0; ci < AMR_TILE_DIM; ++ci) {
            int pi = (ci / 2) + r_quad * 8 + 1;
            double xfrac = (ci % 2 == 0) ? -0.25 : 0.25;
            
            for (int cj = 0; cj < AMR_TILE_DIM; ++cj) {
                int pj = (cj / 2) + z_quad * 8 + 1;
                double yfrac = (cj % 2 == 0) ? -0.25 : 0.25;
                
                int pk = pi * AMR_TILE_DIM + pj;
                int ck = ci * AMR_TILE_DIM + cj;

                RealType v = (U_parent.*field)[pk];
                RealType vr = minmod_kernel((U_parent.*field)[pk+AMR_TILE_DIM] - v, v - (U_parent.*field)[pk-AMR_TILE_DIM]);
                RealType vz = minmod_kernel((U_parent.*field)[pk+1] - v, v - (U_parent.*field)[pk-1]);

                (U_child.*field)[ck] = (RealType)(v + xfrac * vr + yfrac * vz);
            }
        }
    };

    #define PROLONG_CHILD(c) \
        prolongate_node_field(amr_nodes[node_idx].children[c], c, &AMRConservativeTileT<RealType>::rho); \
        prolongate_node_field(amr_nodes[node_idx].children[c], c, &AMRConservativeTileT<RealType>::rhour); \
        prolongate_node_field(amr_nodes[node_idx].children[c], c, &AMRConservativeTileT<RealType>::rhouz); \
        prolongate_node_field(amr_nodes[node_idx].children[c], c, &AMRConservativeTileT<RealType>::E); \
        prolongate_node_field(amr_nodes[node_idx].children[c], c, &AMRConservativeTileT<RealType>::alpha1); \
        prolongate_node_field(amr_nodes[node_idx].children[c], c, &AMRConservativeTileT<RealType>::alpha2); \
        prolongate_node_field(amr_nodes[node_idx].children[c], c, &AMRConservativeTileT<RealType>::arho1); \
        prolongate_node_field(amr_nodes[node_idx].children[c], c, &AMRConservativeTileT<RealType>::arho2);

    PROLONG_CHILD(0) PROLONG_CHILD(1) PROLONG_CHILD(2) PROLONG_CHILD(3)
    #undef PROLONG_CHILD
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::coarsenNode(int parent_idx) {
    auto& parent = amr_nodes[parent_idx];
    parent.is_active = true;

    // Free the children nodes and tiles
    for (int c = 0; c < 4; ++c) {
        int child_idx = parent.children[c];
        freeTile(amr_nodes[child_idx].tile_id);
        amr_nodes[child_idx].tile_id = -1;
        amr_nodes[child_idx].is_active = false;
        parent.children[c] = -1;
    }
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::setInitialConditionTNT(double explosive_z, double explosive_radius, double high_rho, double ambient_rho, double ambient_p) {
    ambient_rho_val = ambient_rho;
    ambient_p_val = ambient_p;
    is_ideal_gas_val = false;

    // Initial refinement loop around charge and detonator coordinates
    for (int step = 0; step < amr_max_levels_val - 1; ++step) {
        bool changed = false;
        std::vector<int> to_refine;
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            const auto& node = amr_nodes[n];
            if (node.is_active && node.level < amr_max_levels_val - 1) {
                // Check intersection with charge sphere
                double dist_z1 = std::max(node.z_min, std::min(explosive_z, node.z_max)) - explosive_z;
                double dist_r1 = std::max(node.r_min, std::min(detonator_r_coord, node.r_max)) - detonator_r_coord;
                double dist = std::sqrt(dist_r1 * dist_r1 + dist_z1 * dist_z1);
                
                if (dist <= explosive_radius * 1.5 || 
                    (detonator_r_coord >= node.r_min && detonator_r_coord <= node.r_max &&
                     detonator_z_coord >= node.z_min && detonator_z_coord <= node.z_max)) {
                    to_refine.push_back(n);
                    changed = true;
                }
            }
        }
        for (int idx : to_refine) {
            refineNode(idx);
        }
        if (changed) rebuildNeighborPointers();
    }

    // Apply exact initial profile on leaf tiles
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        if (amr_nodes[n].tile_id != -1 && amr_nodes[n].is_active) {
            applyInitialConditionToNode(n, explosive_z, explosive_radius, high_rho, 0.0, ambient_rho, ambient_p, true);
        }
    }

    restrictAll();
    updatePrimitiveFromConservative();
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::setInitialConditionIdealGas(double explosive_z, double explosive_radius, double high_rho, double detonation_energy, double ambient_rho, double ambient_p) {
    ambient_rho_val = ambient_rho;
    ambient_p_val = ambient_p;
    is_ideal_gas_val = true;

    for (int step = 0; step < amr_max_levels_val - 1; ++step) {
        bool changed = false;
        std::vector<int> to_refine;
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            const auto& node = amr_nodes[n];
            if (node.is_active && node.level < amr_max_levels_val - 1) {
                double dist_z1 = std::max(node.z_min, std::min(explosive_z, node.z_max)) - explosive_z;
                double dist_r1 = std::max(node.r_min, std::min(detonator_r_coord, node.r_max)) - detonator_r_coord;
                double dist = std::sqrt(dist_r1 * dist_r1 + dist_z1 * dist_z1);

                if (dist <= explosive_radius * 1.5 ||
                    (detonator_r_coord >= node.r_min && detonator_r_coord <= node.r_max &&
                     detonator_z_coord >= node.z_min && detonator_z_coord <= node.z_max)) {
                    to_refine.push_back(n);
                    changed = true;
                }
            }
        }
        for (int idx : to_refine) {
            refineNode(idx);
        }
        if (changed) rebuildNeighborPointers();
    }

    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        if (amr_nodes[n].tile_id != -1 && amr_nodes[n].is_active) {
            applyInitialConditionToNode(n, explosive_z, explosive_radius, high_rho, detonation_energy, ambient_rho, ambient_p, false);
        }
    }

    restrictAll();
    updatePrimitiveFromConservative();
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::setInitialConditionTNTCylinder(double explosive_z, double radius, double height, double high_rho, double ambient_rho, double ambient_p) {
    ambient_rho_val = ambient_rho;
    ambient_p_val = ambient_p;
    is_ideal_gas_val = false;

    for (int step = 0; step < amr_max_levels_val - 1; ++step) {
        bool changed = false;
        std::vector<int> to_refine;
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            const auto& node = amr_nodes[n];
            if (node.is_active && node.level < amr_max_levels_val - 1) {
                // Bounding box cylinder intersection
                double dz = std::max(node.z_min, std::min(explosive_z + height / 2.0, node.z_max)) - (explosive_z + height / 2.0);
                double dr = std::max(node.r_min, std::min(0.0, node.r_max));
                double dist = std::sqrt(dr * dr + dz * dz);

                if (dist <= radius * 1.5 ||
                    (detonator_r_coord >= node.r_min && detonator_r_coord <= node.r_max &&
                     detonator_z_coord >= node.z_min && detonator_z_coord <= node.z_max)) {
                    to_refine.push_back(n);
                    changed = true;
                }
            }
        }
        for (int idx : to_refine) {
            refineNode(idx);
        }
        if (changed) rebuildNeighborPointers();
    }

    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        if (amr_nodes[n].tile_id != -1 && amr_nodes[n].is_active) {
            applyInitialConditionToNode(n, explosive_z, radius, high_rho, 0.0, ambient_rho, ambient_p, true, true, height);
        }
    }

    restrictAll();
    updatePrimitiveFromConservative();
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::setInitialConditionFrom1D(double explosive_z, double remap_radius, const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d, double ambient_rho, double ambient_p, double explosive_r) {
    ambient_rho_val = ambient_rho;
    ambient_p_val = ambient_p;
    is_ideal_gas_val = false;

    for (int step = 0; step < amr_max_levels_val - 1; ++step) {
        bool changed = false;
        std::vector<int> to_refine;
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            const auto& node = amr_nodes[n];
            if (node.is_active && node.level < amr_max_levels_val - 1) {
                double dist_z1 = std::max(node.z_min, std::min(explosive_z, node.z_max)) - explosive_z;
                double dist_r1 = std::max(node.r_min, std::min(explosive_r, node.r_max)) - explosive_r;
                double dist = std::sqrt(dist_r1 * dist_r1 + dist_z1 * dist_z1);

                if (dist <= remap_radius * 1.5 ||
                    (detonator_r_coord >= node.r_min && detonator_r_coord <= node.r_max &&
                     detonator_z_coord >= node.z_min && detonator_z_coord <= node.z_max)) {
                    to_refine.push_back(n);
                    changed = true;
                }
            }
        }
        for (int idx : to_refine) {
            refineNode(idx);
        }
        if (changed) rebuildNeighborPointers();
    }

    // Direct remap of 1D profile
    #pragma omp parallel for
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        const auto& node = amr_nodes[n];
        if (node.tile_id == -1 || !node.is_active) continue;

        auto& U = U_pool[node.tile_id];
        double factor = 1.0 / (1 << node.level);

        for (int i = 0; i < 16; ++i) {
            double cell_r = node.r_min + (i + 0.5) * dr_base * factor;
            for (int j = 0; j < 16; ++j) {
                double cell_z = node.z_min + (j + 0.5) * dz_base * factor;

                double r_dist = std::sqrt((cell_r - explosive_r) * (cell_r - explosive_r) + (cell_z - explosive_z) * (cell_z - explosive_z));
                int k = (i + 2) * AMR_TILE_DIM + (j + 2);

                // Interpolate from 1D states
                auto it = std::lower_bound(r_1d.begin(), r_1d.end(), r_dist);
                size_t idx = std::distance(r_1d.begin(), it);
                if (idx >= r_1d.size()) idx = r_1d.size() - 1;

                const auto& state = states_1d[idx];

                U.rho[k] = (RealType)state.rho;
                U.rhour[k] = (RealType)(state.rho * state.u * (cell_r - explosive_r) / (r_dist + 1e-12));
                U.rhouz[k] = (RealType)(state.rho * state.u * (cell_z - explosive_z) / (r_dist + 1e-12));
                U.E[k] = (RealType)(state.p / (gamma_val - 1.0) + 0.5 * state.rho * state.u * state.u);
                U.alpha1[k] = (RealType)state.alpha1;
                U.alpha2[k] = (RealType)state.alpha2;
                U.arho1[k] = (RealType)state.arho1;
                U.arho2[k] = (RealType)state.arho2;
            }
        }
    }

    restrictAll();
    updatePrimitiveFromConservative();
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::applyInitialConditionToNode(int node_idx, double explosive_z, double explosive_radius, double high_rho, double detonation_energy, double ambient_rho, double ambient_p, bool is_tnt, bool is_cylinder, double charge_height) {
    const auto& node = amr_nodes[node_idx];
    auto& U = U_pool[node.tile_id];
    double factor = 1.0 / (1 << node.level);

    for (int i = 0; i < 16; ++i) {
        double cell_r = node.r_min + (i + 0.5) * dr_base * factor;
        for (int j = 0; j < 16; ++j) {
            double cell_z = node.z_min + (j + 0.5) * dz_base * factor;
            int k = (i + 2) * AMR_TILE_DIM + (j + 2);

            bool inside_charge = false;
            if (is_cylinder) {
                inside_charge = (cell_r <= explosive_radius) && (std::abs(cell_z - explosive_z) <= charge_height / 2.0);
            } else {
                double dist = std::sqrt(cell_r * cell_r + (cell_z - explosive_z) * (cell_z - explosive_z));
                inside_charge = (dist <= explosive_radius);
            }

            if (inside_charge) {
                if (is_tnt) {
                    U.rho[k] = (RealType)high_rho;
                    U.rhour[k] = 0.0;
                    U.rhouz[k] = 0.0;
                    U.alpha1[k] = 1.0;
                    U.alpha2[k] = 0.0;
                    U.arho1[k] = (RealType)high_rho;
                    U.arho2[k] = 0.0;
                    U.E[k] = (RealType)(high_rho * MultiMat::getEnergy_IdealGas(ambient_p, high_rho, gamma_val));
                } else {
                    U.rho[k] = (RealType)high_rho;
                    U.rhour[k] = 0.0;
                    U.rhouz[k] = 0.0;
                    U.alpha1[k] = 0.0;
                    U.alpha2[k] = 1.0;
                    U.arho1[k] = 0.0;
                    U.arho2[k] = (RealType)high_rho;
                    U.E[k] = (RealType)(high_rho * detonation_energy);
                }
            } else {
                U.rho[k] = (RealType)ambient_rho;
                U.rhour[k] = 0.0;
                U.rhouz[k] = 0.0;
                U.alpha1[k] = 0.0;
                U.alpha2[k] = 0.0;
                U.arho1[k] = 0.0;
                U.arho2[k] = 0.0;
                U.E[k] = (RealType)(ambient_p / (gamma_val - 1.0));
            }
        }
    }
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::setFluxScheme(const std::string& scheme_name) { flux_scheme_name = scheme_name; }

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::setSpatialOrder(int order) { spatial_order_val = order; }

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::setTemporalOrder(int order) { temporal_order_val = order; }

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::setMaterialParameters(const MultiMat::MaterialSet& materials) { materials_val = materials; }

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::setGamma(double g) { gamma_val = g; }

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::setIdealGas(bool val) { is_ideal_gas_val = val; }

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::setBCTypes(BCType r_min, BCType r_max, BCType z_min, BCType z_max) {
    bc_r_min = r_min; bc_r_max = r_max;
    bc_z_min = z_min; bc_z_max = z_max;
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::step(double dt) {
    if (temporal_order_val == 1) {
        // Forward Euler
        fillGhostCells();
        #pragma omp parallel for
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            if (amr_nodes[n].tile_id != -1 && amr_nodes[n].is_active) {
                computeTileRHS(n, 0.0, 1.0);
            }
        }
        applyFluxCorrection(dt);
        #pragma omp parallel for
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            if (amr_nodes[n].tile_id != -1 && amr_nodes[n].is_active) {
                int pool_idx = amr_nodes[n].tile_id;
                auto& U = U_pool[pool_idx];
                const auto& dU = dU_pool[pool_idx];
                for (int k = 0; k < AMR_TILE_DIM * AMR_TILE_DIM; ++k) {
                    U.rho[k] += (RealType)(dt * dU.rho[k]);
                    U.rhour[k] += (RealType)(dt * dU.rhour[k]);
                    U.rhouz[k] += (RealType)(dt * dU.rhouz[k]);
                    U.E[k] += (RealType)(dt * dU.E[k]);
                    U.alpha1[k] += (RealType)(dt * dU.alpha1[k]);
                    U.alpha2[k] += (RealType)(dt * dU.alpha2[k]);
                    U.arho1[k] += (RealType)(dt * dU.arho1[k]);
                    U.arho2[k] += (RealType)(dt * dU.arho2[k]);
                }
            }
        }
        updatePrimitiveFromConservative();
    } else {
        // Runge-Kutta 3
        for (int stage = 0; stage < 3; ++stage) {
            applyLSRK3Step(stage, dt);
            updatePrimitiveFromConservative();
            restrictAll();
        }
    }

    time_val += dt;

    // Adapt mesh at the end of timestep
    adaptMesh();
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::run(double duration) {
    double target_time = time_val + duration;
    while (time_val < target_time) {
        double dt = computeStepSize(0.35);
        if (time_val + dt > target_time) dt = target_time - time_val;
        step(dt);
    }
}

template <typename RealType>
double CFDSolver2DAMRImpl<RealType>::computeStepSize(double cfl) const {
    double min_dt = 1e20;
    
    // Step size is determined by the finest active leaf tile
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        const auto& node = amr_nodes[n];
        if (node.tile_id != -1 && node.is_active) {
            double factor = 1.0 / (1 << node.level);
            double dr = dr_base * factor;
            double dz = dz_base * factor;

            const auto& S = states_pool[node.tile_id];
            for (int i = 0; i < 16; ++i) {
                int ti = i + 2;
                for (int j = 0; j < 16; ++j) {
                    int tj = j + 2;
                    int k = ti * AMR_TILE_DIM + tj;
                    if (S.rho[k] < 1e-10) continue;
                    double c;
                    if (is_ideal_gas_val) {
                        c = std::sqrt(gamma_val * S.p[k] / S.rho[k]);
                    } else {
                        c = MultiMat::getMixtureSoundSpeed(S.p[k], S.rho[k], S.alpha1[k], S.alpha2[k], S.arho1[k], S.arho2[k], (RealType)gamma_val, materials_val.products, materials_val.unreacted);
                    }
                    double speed_r = std::abs(S.ur[k]) + c;
                    double speed_z = std::abs(S.uz[k]) + c;
                    double cell_dt = cfl * std::min(dr / (speed_r + 1e-12), dz / (speed_z + 1e-12));
                    if (cell_dt < min_dt) min_dt = cell_dt;
                }
            }
        }
    }
    return min_dt;
}

template <typename RealType>
std::vector<double> CFDSolver2DAMRImpl<RealType>::getLocalTimesteps(double cfl) const {
    return { computeStepSize(cfl) };
}

template <typename RealType>
bool CFDSolver2DAMRImpl<RealType>::checkTerminationCondition() const {
    // Terminate if shock wave hits the outer domain boundary
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        const auto& node = amr_nodes[n];
        if (node.tile_id != -1 && node.is_active) {
            // Check if boundary nodes have high pressure
            bool is_outer_boundary = (node.r_max >= max_r_coord - 1e-5) || (node.z_max >= max_z_coord - 1e-5);
            if (is_outer_boundary) {
                const auto& S = states_pool[node.tile_id];
                for (int k = 0; k < AMR_TILE_DIM * AMR_TILE_DIM; ++k) {
                    if (S.p[k] > ambient_p_val * 1.5) {
                        return true;
                    }
                }
            }
        }
    }
    return false;
}

template <typename RealType>
std::vector<State2D> CFDSolver2DAMRImpl<RealType>::getStates() const {
    // Reconstruct flat regular grid states from leaf tiles for legacy outputs
    std::vector<State2D> states(level0_nr * level0_nz);
    double dr = dr_base;
    double dz = dz_base;

    #pragma omp parallel for collapse(2)
    for (int i = 0; i < level0_nr; ++i) {
        for (int j = 0; j < level0_nz; ++j) {
            double cell_r = (i + 0.5) * dr;
            double cell_z = (j + 0.5) * dz;

            // Find the finest leaf tile covering (cell_r, cell_z)
            int best_node = -1;
            int best_level = -1;

            for (size_t n = 0; n < amr_nodes.size(); ++n) {
                const auto& node = amr_nodes[n];
                if (node.tile_id != -1 && node.is_active) {
                    if (cell_r >= node.r_min && cell_r <= node.r_max &&
                        cell_z >= node.z_min && cell_z <= node.z_max) {
                        if (node.level > best_level) {
                            best_level = node.level;
                            best_node = n;
                        }
                    }
                }
            }

            int idx = i * level0_nz + j;
            if (best_node == -1) {
                states[idx] = { (float)ambient_rho_val, 0.0f, 0.0f, (float)ambient_p_val, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f };
            } else {
                const auto& node = amr_nodes[best_node];
                const auto& S = states_pool[node.tile_id];
                double factor = 1.0 / (1 << node.level);
                int local_i = (int)((cell_r - node.r_min) / (dr_base * factor));
                int local_j = (int)((cell_z - node.z_min) / (dz_base * factor));
                local_i = std::max(0, std::min(15, local_i));
                local_j = std::max(0, std::min(15, local_j));
                int k = (local_i + 2) * AMR_TILE_DIM + (local_j + 2);

                states[idx] = {
                    (float)S.rho[k], (float)S.ur[k], (float)S.uz[k], (float)S.p[k],
                    0.0f, (float)S.alpha1[k], (float)S.alpha2[k], (float)S.arho1[k], (float)S.arho2[k]
                };
            }
        }
    }
    return states;
}

template <typename RealType>
std::vector<float> CFDSolver2DAMRImpl<RealType>::getCellValues(int i, int j) const {
    std::vector<State2D> states = getStates();
    int idx = i * level0_nz + j;
    if (idx >= (int)states.size()) return std::vector<float>(8, 0.0f);
    const auto& s = states[idx];
    return { (float)s.rho, (float)s.ur, (float)s.uz, (float)s.p, (float)s.alpha1, (float)s.alpha2, (float)s.arho1, (float)s.arho2 };
}

template <typename RealType>
std::vector<float> CFDSolver2DAMRImpl<RealType>::getTelemetry2D(int stride) const {
    // Pack binary telemetry: [uint32 num_leaves] [uint32 n_channels] followed by leaf tiles
    std::vector<float> data;
    uint32_t num_leaves = 0;
    for (const auto& node : amr_nodes) {
        if (node.tile_id != -1 && node.is_active) {
            num_leaves++;
        }
    }

    uint32_t n_channels = 7; // p, rho, ur, uz, E, alpha1, alpha2
    data.push_back(*(float*)&num_leaves);
    data.push_back(*(float*)&n_channels);

    for (const auto& node : amr_nodes) {
        if (node.tile_id != -1 && node.is_active) {
            const auto& S = states_pool[node.tile_id];
            
            // Pack metadata: [uint16 r_idx] [uint16 z_idx] [uint8 level] [uint8 padding]
            uint16_t r_idx = node.r_idx;
            uint16_t z_idx = node.z_idx;
            uint8_t lvl = node.level;
            uint8_t padding = 0;
            
            uint32_t meta1 = (r_idx << 16) | z_idx;
            uint32_t meta2 = (lvl << 8) | padding;
            
            data.push_back(*(float*)&meta1);
            data.push_back(*(float*)&meta2);

            // Pack 16x16 tile channel values
            for (int i = 0; i < 16; ++i) {
                int ti = i + 2;
                for (int j = 0; j < 16; ++j) {
                    int tj = j + 2;
                    int k = ti * AMR_TILE_DIM + tj;
                    data.push_back((float)S.p[k]);
                    data.push_back((float)S.rho[k]);
                    data.push_back((float)S.ur[k]);
                    data.push_back((float)S.uz[k]);
                    data.push_back((float)S.E[k]);
                    data.push_back((float)S.alpha1[k]);
                    data.push_back((float)S.alpha2[k]);
                }
            }
        }
    }
    return data;
}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::setSolidVelocities(const double* v) {}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::setSolidMask(const uint8_t* mask) {}

template <typename RealType>
void CFDSolver2DAMRImpl<RealType>::exportVTK(const std::string& filename) const {
    // 1. Count active leaf cells
    std::vector<int> leaf_indices;
    for (int idx = 0; idx < (int)amr_nodes.size(); ++idx) {
        if (amr_nodes[idx].is_active) {
            leaf_indices.push_back(idx);
        }
    }

    int num_cells = leaf_indices.size() * 256;
    int num_points = num_cells * 4;

    std::vector<double> points;
    points.reserve(num_points * 3);

    std::vector<int32_t> connectivity;
    connectivity.reserve(num_cells * 4);

    std::vector<int32_t> offsets;
    offsets.reserve(num_cells);

    std::vector<uint8_t> types(num_cells, 9); // VTK_QUAD

    std::vector<double> rho;
    rho.reserve(num_cells);
    std::vector<double> ur;
    ur.reserve(num_cells);
    std::vector<double> uz;
    uz.reserve(num_cells);
    std::vector<double> p;
    p.reserve(num_cells);
    std::vector<double> level;
    level.reserve(num_cells);

    int cell_global_idx = 0;

    for (int node_idx : leaf_indices) {
        const auto& node = amr_nodes[node_idx];
        const auto& S = states_pool[node.tile_id];

        double factor = 1.0 / (1 << node.level);
        double dr = dr_base * factor;
        double dz = dz_base * factor;

        double tile_r_min = node.r_idx * 16 * dr;
        double tile_z_min = node.z_idx * 16 * dz;

        for (int i = 0; i < 16; ++i) {
            double c_rMin = tile_r_min + i * dr;
            double c_rMax = tile_r_min + (i + 1) * dr;
            int ti = i + 2;

            for (int j = 0; j < 16; ++j) {
                double c_zMin = tile_z_min + j * dz;
                double c_zMax = tile_z_min + (j + 1) * dz;
                int tj = j + 2;
                int k = ti * AMR_TILE_DIM + tj;

                // Add 4 corner points
                points.push_back(c_rMin); points.push_back(c_zMin); points.push_back(0.0);
                points.push_back(c_rMax); points.push_back(c_zMin); points.push_back(0.0);
                points.push_back(c_rMax); points.push_back(c_zMax); points.push_back(0.0);
                points.push_back(c_rMin); points.push_back(c_zMax); points.push_back(0.0);

                // Add connectivity
                int p0 = cell_global_idx * 4;
                connectivity.push_back(p0);
                connectivity.push_back(p0 + 1);
                connectivity.push_back(p0 + 2);
                connectivity.push_back(p0 + 3);

                offsets.push_back(p0 + 4);

                // Add cell data
                rho.push_back((double)S.rho[k]);
                ur.push_back((double)S.ur[k]);
                uz.push_back((double)S.uz[k]);
                p.push_back((double)S.p[k]);
                level.push_back((double)node.level);

                cell_global_idx++;
            }
        }
    }

    export_vtu_amr_2d(filename, points, connectivity, offsets, types, rho, ur, uz, p, level);
}

// Explicit instantiation for float and double to satisfy linking
template class CFDSolver2DAMRImpl<float>;
template class CFDSolver2DAMRImpl<double>;
