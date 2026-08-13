#include "fem_contact_3d.hpp"
#include <algorithm>
#include <iostream>

namespace Blast {

template <typename T>
FEMContact3D<T>::FEMContact3D() {
    m_candidate_pairs.reserve(10000);
}

static inline int64_t hashCell3D(int cx, int cy, int cz) {
    const int64_t p1 = 73856093;
    const int64_t p2 = 19349663;
    const int64_t p3 = 83492791;
    return (static_cast<int64_t>(cx) * p1) ^ (static_cast<int64_t>(cy) * p2) ^ (static_cast<int64_t>(cz) * p3);
}

template <typename T>
void FEMContact3D<T>::buildSpatialHash(FEMSolver3D<T>& solver) {
    m_bucket_nodes.clear();
    m_bucket_facets.clear();

    const auto& nodes = solver.getNodes();
    const auto& facets = solver.getSurfaceFacets();

    // Compute dynamic cell size based on average facet area
    T avg_area = static_cast<T>(0.0f);
    int valid_facets = 0;
    for (const auto& facet : facets) {
        if (!facet.is_eroded) {
            avg_area += facet.area;
            valid_facets++;
        }
    }

    if (valid_facets > 0) {
        T h_avg = std::sqrt(avg_area / static_cast<T>(valid_facets));
        m_cell_size = std::max(static_cast<T>(2.0f) * h_avg, static_cast<T>(1.0e-4f));
    }

    T inv_cell = static_cast<T>(1.0f) / m_cell_size;

    // Identify surface nodes using persistent buffer pool
    m_is_surface_node.assign(nodes.size(), false);
    for (const auto& facet : facets) {
        if (facet.is_eroded) continue;
        for (int k = 0; k < 4; ++k) {
            if (facet.node_ids[k] >= 0 && facet.node_ids[k] < static_cast<int>(nodes.size())) {
                m_is_surface_node[facet.node_ids[k]] = true;
            }
        }
    }

    // Hash Surface Nodes
    for (int i = 0; i < static_cast<int>(nodes.size()); ++i) {
        if (nodes[i].is_eroded || !m_is_surface_node[i]) continue;
        int cx = static_cast<int>(std::floor(nodes[i].x[0] * inv_cell));
        int cy = static_cast<int>(std::floor(nodes[i].x[1] * inv_cell));
        int cz = static_cast<int>(std::floor(nodes[i].x[2] * inv_cell));
        int64_t key = hashCell3D(cx, cy, cz);
        m_bucket_nodes[key].push_back(i);
    }

    // Hash Surface Facets
    for (int f = 0; f < static_cast<int>(facets.size()); ++f) {
        if (facets[f].is_eroded) continue;
        const auto& facet = facets[f];

        T f_center[3] = {0.0f, 0.0f, 0.0f};
        for (int k = 0; k < 4; ++k) {
            int nid = facet.node_ids[k];
            f_center[0] += nodes[nid].x[0];
            f_center[1] += nodes[nid].x[1];
            f_center[2] += nodes[nid].x[2];
        }
        f_center[0] *= 0.25f; f_center[1] *= 0.25f; f_center[2] *= 0.25f;

        int cx = static_cast<int>(std::floor(f_center[0] * inv_cell));
        int cy = static_cast<int>(std::floor(f_center[1] * inv_cell));
        int cz = static_cast<int>(std::floor(f_center[2] * inv_cell));
        int64_t key = hashCell3D(cx, cy, cz);
        m_bucket_facets[key].push_back(f);
    }
}

template <typename T>
void FEMContact3D<T>::findCandidatePairs(FEMSolver3D<T>& solver) {
    m_candidate_pairs.clear();
    const auto& nodes = solver.getNodes();
    const auto& facets = solver.getSurfaceFacets();
    const auto& elements = solver.getElements();

    T inv_cell = static_cast<T>(1.0f) / m_cell_size;

    // Reuse surface node mask and node-to-part mapping persistent buffers
    m_node_part_id.assign(nodes.size(), -1);
    for (const auto& elem : elements) {
        if (elem.is_eroded) continue;
        for (int k = 0; k < 8; ++k) {
            if (elem.node_ids[k] >= 0 && elem.node_ids[k] < static_cast<int>(nodes.size())) {
                m_node_part_id[elem.node_ids[k]] = elem.part_id;
            }
        }
    }

    // Search 27-neighbor buckets around each surface node
    for (int i = 0; i < static_cast<int>(nodes.size()); ++i) {
        if (nodes[i].is_eroded || !m_is_surface_node[i]) continue;

        int cx = static_cast<int>(std::floor(nodes[i].x[0] * inv_cell));
        int cy = static_cast<int>(std::floor(nodes[i].x[1] * inv_cell));
        int cz = static_cast<int>(std::floor(nodes[i].x[2] * inv_cell));
        int n_part = m_node_part_id[i];

        for (int dx = -1; dx <= 1; ++dx) {
            for (int dy = -1; dy <= 1; ++dy) {
                for (int dz = -1; dz <= 1; ++dz) {
                    int64_t key = hashCell3D(cx + dx, cy + dy, cz + dz);
                    auto it = m_bucket_facets.find(key);
                    if (it != m_bucket_facets.end()) {
                        for (int f_idx : it->second) {
                            const auto& facet = facets[f_idx];
                            if (facet.is_eroded) continue;

                            // Exclude self-nodes belonging to facet
                            if (facet.node_ids[0] == i || facet.node_ids[1] == i ||
                                facet.node_ids[2] == i || facet.node_ids[3] == i) continue;

                            // Exclude facets from the same part/mesh object to prevent self-penetration
                            if (facet.element_id >= 0 && facet.element_id < static_cast<int>(elements.size())) {
                                int facet_part = elements[facet.element_id].part_id;
                                if (n_part >= 0 && facet_part >= 0 && n_part == facet_part) continue;
                            }

                            ContactPairCandidate<T> pair;
                            pair.node_idx = i;
                            pair.facet_idx = f_idx;
                            m_candidate_pairs.push_back(pair);
                        }
                    }
                }
            }
        }
    }
}

template <typename T>
void FEMContact3D<T>::updateDynamicSurfaceNormals(FEMSolver3D<T>& solver) {
    const auto& nodes = solver.getNodes();
    auto& facets = solver.getSurfaceFacets();

    m_node_facets.assign(nodes.size(), {});
    m_facet_corner_normals.assign(facets.size(), {{{static_cast<T>(0), static_cast<T>(0), static_cast<T>(0)},
                                                    {static_cast<T>(0), static_cast<T>(0), static_cast<T>(0)},
                                                    {static_cast<T>(0), static_cast<T>(0), static_cast<T>(0)},
                                                    {static_cast<T>(0), static_cast<T>(0), static_cast<T>(0)}}});

    // Step 1: Dynamically update facet unit normals and areas, build node-to-facets mapping
    for (int f = 0; f < static_cast<int>(facets.size()); ++f) {
        auto& facet = facets[f];
        if (facet.is_eroded) continue;

        const auto& n0 = nodes[facet.node_ids[0]];
        const auto& n1 = nodes[facet.node_ids[1]];
        const auto& n2 = nodes[facet.node_ids[2]];
        const auto& n3 = nodes[facet.node_ids[3]];

        T d1[3] = {n2.x[0] - n0.x[0], n2.x[1] - n0.x[1], n2.x[2] - n0.x[2]};
        T d2[3] = {n3.x[0] - n1.x[0], n3.x[1] - n1.x[1], n3.x[2] - n1.x[2]};

        T nx = d1[1]*d2[2] - d1[2]*d2[1];
        T ny = d1[2]*d2[0] - d1[0]*d2[2];
        T nz = d1[0]*d2[1] - d1[1]*d2[0];

        T len = std::sqrt(nx*nx + ny*ny + nz*nz);
        if (len > static_cast<T>(1.0e-12f)) {
            facet.normal[0] = nx / len;
            facet.normal[1] = ny / len;
            facet.normal[2] = nz / len;
            facet.area = static_cast<T>(0.5f) * len;
        }

        for (int k = 0; k < 4; ++k) {
            int nid = facet.node_ids[k];
            if (nid >= 0 && nid < static_cast<int>(nodes.size())) {
                m_node_facets[nid].push_back(f);
            }
        }
    }

    // Step 2: Compute feature-angle nodal surface normals for each facet's 4 corner nodes
    for (int f = 0; f < static_cast<int>(facets.size()); ++f) {
        if (facets[f].is_eroded) continue;
        const auto& facet = facets[f];

        for (int k = 0; k < 4; ++k) {
            int nid = facet.node_ids[k];
            T n_acc[3] = {static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(0.0f)};

            for (int neighbor_f : m_node_facets[nid]) {
                if (facets[neighbor_f].is_eroded) continue;
                T dot_prod = facet.normal[0] * facets[neighbor_f].normal[0] +
                             facet.normal[1] * facets[neighbor_f].normal[1] +
                             facet.normal[2] * facets[neighbor_f].normal[2];
                if (dot_prod > static_cast<T>(0.5f)) { // Feature angle <= 60 deg (filters out 90-deg sharp edges)
                    n_acc[0] += facets[neighbor_f].area * facets[neighbor_f].normal[0];
                    n_acc[1] += facets[neighbor_f].area * facets[neighbor_f].normal[1];
                    n_acc[2] += facets[neighbor_f].area * facets[neighbor_f].normal[2];
                }
            }

            T acc_len = std::sqrt(n_acc[0]*n_acc[0] + n_acc[1]*n_acc[1] + n_acc[2]*n_acc[2]);
            if (acc_len > static_cast<T>(1.0e-12f)) {
                m_facet_corner_normals[f][k][0] = n_acc[0] / acc_len;
                m_facet_corner_normals[f][k][1] = n_acc[1] / acc_len;
                m_facet_corner_normals[f][k][2] = n_acc[2] / acc_len;
            } else {
                m_facet_corner_normals[f][k][0] = facet.normal[0];
                m_facet_corner_normals[f][k][1] = facet.normal[1];
                m_facet_corner_normals[f][k][2] = facet.normal[2];
            }
        }
    }
}

template <typename T>
void FEMContact3D<T>::applyPenaltyForces(FEMSolver3D<T>& solver, T dt) {
    auto& nodes = solver.getNodes();
    const auto& facets = solver.getSurfaceFacets();

    for (auto& node : nodes) {
        node.f_contact[0] = 0.0f;
        node.f_contact[1] = 0.0f;
        node.f_contact[2] = 0.0f;
    }

    m_node_f_mag.assign(nodes.size(), static_cast<T>(0.0f));
    m_node_f_dir.assign(nodes.size(), {static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(0.0f)});
    m_node_f_facet_idx.assign(nodes.size(), -1);
    m_node_N_shape.assign(nodes.size(), {static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(0.0f)});

    for (const auto& candidate : m_candidate_pairs) {
        auto& node = nodes[candidate.node_idx];
        const auto& facet = facets[candidate.facet_idx];
        if (facet.is_eroded || node.is_eroded) continue;

        // Check normal opposition to filter out ghost/spurious contacts
        T n_node[3] = {static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(0.0f)};
        for (int neighbor_f : m_node_facets[candidate.node_idx]) {
            if (facets[neighbor_f].is_eroded) continue;
            n_node[0] += facets[neighbor_f].area * facets[neighbor_f].normal[0];
            n_node[1] += facets[neighbor_f].area * facets[neighbor_f].normal[1];
            n_node[2] += facets[neighbor_f].area * facets[neighbor_f].normal[2];
        }
        T n_node_len = std::sqrt(n_node[0]*n_node[0] + n_node[1]*n_node[1] + n_node[2]*n_node[2]);
        if (n_node_len > static_cast<T>(1.0e-12f)) {
            n_node[0] /= n_node_len;
            n_node[1] /= n_node_len;
            n_node[2] /= n_node_len;
            
            T dot_normals = n_node[0]*facet.normal[0] + n_node[1]*facet.normal[1] + n_node[2]*facet.normal[2];
            if (dot_normals > static_cast<T>(-0.15f)) {
                continue; // Reject spurious/non-opposing contact (e.g. orthogonal sidewalls or co-directional facets)
            }
        }

        T v0[3] = {nodes[facet.node_ids[0]].x[0], nodes[facet.node_ids[0]].x[1], nodes[facet.node_ids[0]].x[2]};

        T min_fx = v0[0], max_fx = v0[0];
        T min_fy = v0[1], max_fy = v0[1];
        T min_fz = v0[2], max_fz = v0[2];
        for (int k = 1; k < 4; ++k) {
            int nid = facet.node_ids[k];
            min_fx = std::min(min_fx, nodes[nid].x[0]); max_fx = std::max(max_fx, nodes[nid].x[0]);
            min_fy = std::min(min_fy, nodes[nid].x[1]); max_fy = std::max(max_fy, nodes[nid].x[1]);
            min_fz = std::min(min_fz, nodes[nid].x[2]); max_fz = std::max(max_fz, nodes[nid].x[2]);
        }
        T margin = static_cast<T>(0.3f) * std::sqrt(facet.area > static_cast<T>(1.0e-12f) ? facet.area : static_cast<T>(1.0e-4f));
        min_fx -= margin; max_fx += margin;
        min_fy -= margin; max_fy += margin;
        min_fz -= margin; max_fz += margin;

        if (node.x[0] < min_fx || node.x[0] > max_fx ||
            node.x[1] < min_fy || node.x[1] > max_fy ||
            node.x[2] < min_fz || node.x[2] > max_fz) continue;

        T v1[3] = {nodes[facet.node_ids[1]].x[0], nodes[facet.node_ids[1]].x[1], nodes[facet.node_ids[1]].x[2]};
        T v2[3] = {nodes[facet.node_ids[2]].x[0], nodes[facet.node_ids[2]].x[1], nodes[facet.node_ids[2]].x[2]};
        T v3[3] = {nodes[facet.node_ids[3]].x[0], nodes[facet.node_ids[3]].x[1], nodes[facet.node_ids[3]].x[2]};

        // Closed-form analytical projection onto quad face local tangent frame
        T e1[3] = {v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]};
        T e3[3] = {v3[0] - v0[0], v3[1] - v0[1], v3[2] - v0[2]};
        T dx_v0[3] = {node.x[0] - v0[0], node.x[1] - v0[1], node.x[2] - v0[2]};

        T len1_sq = e1[0]*e1[0] + e1[1]*e1[1] + e1[2]*e1[2];
        T len3_sq = e3[0]*e3[0] + e3[1]*e3[1] + e3[2]*e3[2];
        T dot_e1_e3 = e1[0]*e3[0] + e1[1]*e3[1] + e1[2]*e3[2];

        T det_tangent = len1_sq * len3_sq - dot_e1_e3 * dot_e1_e3;
        T u_param = 0.5f, v_param = 0.5f;

        if (std::abs(det_tangent) > static_cast<T>(1.0e-12f)) {
            T proj1 = dx_v0[0]*e1[0] + dx_v0[1]*e1[1] + dx_v0[2]*e1[2];
            T proj3 = dx_v0[0]*e3[0] + dx_v0[1]*e3[1] + dx_v0[2]*e3[2];
            T inv_det = static_cast<T>(1.0f) / det_tangent;
            u_param = (proj1 * len3_sq - proj3 * dot_e1_e3) * inv_det;
            v_param = (proj3 * len1_sq - proj1 * dot_e1_e3) * inv_det;
        } else {
            u_param = (len1_sq > static_cast<T>(1.0e-12f)) ? ((dx_v0[0]*e1[0] + dx_v0[1]*e1[1] + dx_v0[2]*e1[2]) / len1_sq) : static_cast<T>(0.5f);
            v_param = (len3_sq > static_cast<T>(1.0e-12f)) ? ((dx_v0[0]*e3[0] + dx_v0[1]*e3[1] + dx_v0[2]*e3[2]) / len3_sq) : static_cast<T>(0.5f);
        }

        // Expanded candidate bounds tolerance ([-0.20, 1.20]) to prevent dropout gaps across convex edges
        if (u_param < static_cast<T>(-0.20f) || u_param > static_cast<T>(1.20f) ||
            v_param < static_cast<T>(-0.20f) || v_param > static_cast<T>(1.20f)) continue;

        T u_clamped = std::max(static_cast<T>(0.0f), std::min(static_cast<T>(1.0f), u_param));
        T v_clamped = std::max(static_cast<T>(0.0f), std::min(static_cast<T>(1.0f), v_param));
        T N_shape[4] = {
            (static_cast<T>(1.0f) - u_clamped) * (static_cast<T>(1.0f) - v_clamped),
            u_clamped * (static_cast<T>(1.0f) - v_clamped),
            u_clamped * v_clamped,
            (static_cast<T>(1.0f) - u_clamped) * v_clamped
        };

        // Bilinearly interpolate exact target surface point on quad face
        T x_surf[3] = {
            N_shape[0]*v0[0] + N_shape[1]*v1[0] + N_shape[2]*v2[0] + N_shape[3]*v3[0],
            N_shape[0]*v0[1] + N_shape[1]*v1[1] + N_shape[2]*v2[1] + N_shape[3]*v3[1],
            N_shape[0]*v0[2] + N_shape[1]*v1[2] + N_shape[2]*v2[2] + N_shape[3]*v3[2]
        };

        // True geometric distance vector from exact projected surface point
        T dx_surf[3] = {node.x[0] - x_surf[0], node.x[1] - x_surf[1], node.x[2] - x_surf[2]};

        // Bilinearly interpolate smooth contact normal from 4 corner nodal surface normals
        T n_smooth[3] = {static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(0.0f)};
        for (int k = 0; k < 4; ++k) {
            n_smooth[0] += N_shape[k] * m_facet_corner_normals[candidate.facet_idx][k][0];
            n_smooth[1] += N_shape[k] * m_facet_corner_normals[candidate.facet_idx][k][1];
            n_smooth[2] += N_shape[k] * m_facet_corner_normals[candidate.facet_idx][k][2];
        }
        T n_smooth_len = std::sqrt(n_smooth[0]*n_smooth[0] + n_smooth[1]*n_smooth[1] + n_smooth[2]*n_smooth[2]);
        T contact_normal[3];
        if (n_smooth_len > static_cast<T>(1.0e-12f)) {
            contact_normal[0] = n_smooth[0] / n_smooth_len;
            contact_normal[1] = n_smooth[1] / n_smooth_len;
            contact_normal[2] = n_smooth[2] / n_smooth_len;
        } else {
            contact_normal[0] = facet.normal[0];
            contact_normal[1] = facet.normal[1];
            contact_normal[2] = facet.normal[2];
        }

        // Exact penetration depth along smooth surface contact normal
        T penetration = -(dx_surf[0]*contact_normal[0] + dx_surf[1]*contact_normal[1] + dx_surf[2]*contact_normal[2]);

        T h_elem = std::sqrt(facet.area > static_cast<T>(1.0e-24f) ? facet.area : static_cast<T>(1.0e-24f));
        T max_penetration = static_cast<T>(3.0f) * h_elem;

        if (penetration > static_cast<T>(0.0f) && penetration <= max_penetration) {
            T eff_penetration = std::min(penetration, static_cast<T>(1.5f) * h_elem);
            const auto& elements = solver.getElements();
            const auto& materials = solver.getMaterialTables();

            T K_master = static_cast<T>(160.0e9f);
            if (facet.element_id >= 0 && facet.element_id < static_cast<int>(elements.size())) {
                const auto& elem = elements[facet.element_id];
                if (elem.mat_id >= 0 && elem.mat_id < static_cast<int>(materials.size())) {
                    const auto& mat = materials[elem.mat_id];
                    T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 210.0e9f);
                    T nu = static_cast<T>(mat.poissons_ratio);
                    T denom = static_cast<T>(1.0f) - static_cast<T>(2.0f) * nu;
                    if (std::abs(denom) > static_cast<T>(1.0e-4f)) {
                        K_master = E / (static_cast<T>(3.0f) * denom);
                    }
                }
            }

            T K_slave = K_master;
            int slave_part = m_node_part_id[candidate.node_idx];
            for (const auto& elem : elements) {
                if (elem.is_eroded) continue;
                if (elem.part_id == slave_part) {
                    if (elem.mat_id >= 0 && elem.mat_id < static_cast<int>(materials.size())) {
                        const auto& mat = materials[elem.mat_id];
                        T E = static_cast<T>(mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 210.0e9f);
                        T nu = static_cast<T>(mat.poissons_ratio);
                        T denom = static_cast<T>(1.0f) - static_cast<T>(2.0f) * nu;
                        if (std::abs(denom) > static_cast<T>(1.0e-4f)) {
                            K_slave = E / (static_cast<T>(3.0f) * denom);
                        }
                    }
                    break;
                }
            }

            // Harmonic mean interface bulk modulus for general dissimilar materials
            T K_interface = (static_cast<T>(2.0f) * K_master * K_slave) / (K_master + K_slave + static_cast<T>(1.0e-30f));

            T k_stiff = m_penalty_scale * K_interface * h_elem;
            T f_spring = k_stiff * eff_penetration;

            T m_facet_avg = static_cast<T>(0.25f) * (nodes[facet.node_ids[0]].m + nodes[facet.node_ids[1]].m
                                                     + nodes[facet.node_ids[2]].m + nodes[facet.node_ids[3]].m);
            T m_sum = node.m + m_facet_avg;
            T m_pair = (m_sum > static_cast<T>(1.0e-30f)) ? (node.m * m_facet_avg / m_sum) : static_cast<T>(1.0e-30f);

            T vf0 = static_cast<T>(0.25f) * (nodes[facet.node_ids[0]].v[0] + nodes[facet.node_ids[1]].v[0] + nodes[facet.node_ids[2]].v[0] + nodes[facet.node_ids[3]].v[0]);
            T vf1 = static_cast<T>(0.25f) * (nodes[facet.node_ids[0]].v[1] + nodes[facet.node_ids[1]].v[1] + nodes[facet.node_ids[2]].v[1] + nodes[facet.node_ids[3]].v[1]);
            T vf2 = static_cast<T>(0.25f) * (nodes[facet.node_ids[0]].v[2] + nodes[facet.node_ids[1]].v[2] + nodes[facet.node_ids[2]].v[2] + nodes[facet.node_ids[3]].v[2]);
            T v_rel_n = (node.v[0] - vf0)*contact_normal[0] + (node.v[1] - vf1)*contact_normal[1] + (node.v[2] - vf2)*contact_normal[2];

            T f_damp = static_cast<T>(0.0f);
            if (v_rel_n < static_cast<T>(0.0f)) {
                T c = static_cast<T>(2.0f) * m_contact_damping * std::sqrt(k_stiff * m_pair);
                f_damp = -c * v_rel_n;
            }

            T f_total = f_spring + f_damp;
            T v_limit = std::max(static_cast<T>(2.0f) * std::abs(v_rel_n), static_cast<T>(20.0f));
            T f_max = m_pair * v_limit / (dt > static_cast<T>(1.0e-12f) ? dt : static_cast<T>(1.0e-12f));
            f_total = std::min(f_total, f_max);



            if (f_total > m_node_f_mag[candidate.node_idx]) {
                m_node_f_mag[candidate.node_idx] = f_total;
                m_node_f_dir[candidate.node_idx][0] = contact_normal[0];
                m_node_f_dir[candidate.node_idx][1] = contact_normal[1];
                m_node_f_dir[candidate.node_idx][2] = contact_normal[2];
                m_node_f_facet_idx[candidate.node_idx] = candidate.facet_idx;
                for (int k = 0; k < 4; ++k) {
                    m_node_N_shape[candidate.node_idx][k] = N_shape[k];
                }
            }
        }
    }

    // Pass 2: Apply equal and opposite normal & Coulomb friction forces to node and facet nodes
    for (size_t nid = 0; nid < nodes.size(); ++nid) {
        if (m_node_f_mag[nid] > static_cast<T>(0.0f)) {
            auto& node = nodes[nid];
            T f_mag = m_node_f_mag[nid];
            T nx = m_node_f_dir[nid][0];
            T ny = m_node_f_dir[nid][1];
            T nz = m_node_f_dir[nid][2];

            int fid = m_node_f_facet_idx[nid];
            const auto& facet = facets[fid];

            T f_normal[3] = {f_mag * nx, f_mag * ny, f_mag * nz};

            // Coulomb Tangential Friction Force
            T f_tangential[3] = {static_cast<T>(0.0f), static_cast<T>(0.0f), static_cast<T>(0.0f)};
            if (m_mu_static > static_cast<T>(0.0f) || m_mu_kinetic > static_cast<T>(0.0f)) {
                T v_rel[3] = {node.v[0], node.v[1], node.v[2]};
                for (int k = 0; k < 4; ++k) {
                    int fnid = facet.node_ids[k];
                    T N_k = m_node_N_shape[nid][k];
                    v_rel[0] -= N_k * nodes[fnid].v[0];
                    v_rel[1] -= N_k * nodes[fnid].v[1];
                    v_rel[2] -= N_k * nodes[fnid].v[2];
                }

                T v_rel_n = v_rel[0]*nx + v_rel[1]*ny + v_rel[2]*nz;
                T v_tan[3] = {
                    v_rel[0] - v_rel_n * nx,
                    v_rel[1] - v_rel_n * ny,
                    v_rel[2] - v_rel_n * nz
                };

                T v_tan_len = std::sqrt(v_tan[0]*v_tan[0] + v_tan[1]*v_tan[1] + v_tan[2]*v_tan[2]);
                if (v_tan_len > static_cast<T>(1.0e-6f)) {
                    T mu = m_mu_kinetic + (m_mu_static - m_mu_kinetic) * std::exp(-static_cast<T>(10.0f) * v_tan_len);
                    T f_fric_limit = mu * f_mag;

                    T m_facet = static_cast<T>(0.25f) * (nodes[facet.node_ids[0]].m + nodes[facet.node_ids[1]].m + nodes[facet.node_ids[2]].m + nodes[facet.node_ids[3]].m);
                    T m_pair = (node.m * m_facet) / (node.m + m_facet > static_cast<T>(1.0e-12f) ? node.m + m_facet : static_cast<T>(1.0e-12f));
                    T f_stick = m_pair * v_tan_len / (dt > static_cast<T>(1.0e-12f) ? dt : static_cast<T>(1.0e-12f));

                    T f_tan_mag = std::min(f_fric_limit, f_stick);
                    T inv_v_tan = static_cast<T>(1.0f) / v_tan_len;

                    f_tangential[0] = -f_tan_mag * (v_tan[0] * inv_v_tan);
                    f_tangential[1] = -f_tan_mag * (v_tan[1] * inv_v_tan);
                    f_tangential[2] = -f_tan_mag * (v_tan[2] * inv_v_tan);
                }
            }

            T f_total_node[3] = {
                f_normal[0] + f_tangential[0],
                f_normal[1] + f_tangential[1],
                f_normal[2] + f_tangential[2]
            };

            node.f_contact[0] += f_total_node[0];
            node.f_contact[1] += f_total_node[1];
            node.f_contact[2] += f_total_node[2];

            for (int k = 0; k < 4; ++k) {
                int fnid = facet.node_ids[k];
                T N_k = m_node_N_shape[nid][k];
                nodes[fnid].f_contact[0] -= N_k * f_total_node[0];
                nodes[fnid].f_contact[1] -= N_k * f_total_node[1];
                nodes[fnid].f_contact[2] -= N_k * f_total_node[2];
            }
        }
    }
}

template <typename T>
void FEMContact3D<T>::solveContact(FEMSolver3D<T>& solver, T dt) {
    updateDynamicSurfaceNormals(solver);
    buildSpatialHash(solver);
    findCandidatePairs(solver);
    applyPenaltyForces(solver, dt);
}

// Explicit Instantiations
template class FEMContact3D<float>;
template class FEMContact3D<double>;

} // namespace Blast
