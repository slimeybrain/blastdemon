#include <iostream>
#include <fstream>
#include <vector>
#include <array>
#include <cmath>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <random>
#include <algorithm>
#include <iomanip>
#include <cassert>
#include <chrono>

struct Vec3 {
    double x{0.0}, y{0.0}, z{0.0};

    Vec3 operator+(const Vec3& o) const { return {x + o.x, y + o.y, z + o.z}; }
    Vec3 operator-(const Vec3& o) const { return {x - o.x, y - o.y, z - o.z}; }
    Vec3 operator*(double s) const { return {x * s, y * s, z * s}; }
    Vec3 operator/(double s) const { return {x / s, y / s, z / s}; }
    Vec3& operator+=(const Vec3& o) { x += o.x; y += o.y; z += o.z; return *this; }

    double dot(const Vec3& o) const { return x * o.x + y * o.y + z * o.z; }
    Vec3 cross(const Vec3& o) const {
        return {
            y * o.z - z * o.y,
            z * o.x - x * o.z,
            x * o.y - y * o.x
        };
    }
    double length() const { return std::sqrt(x * x + y * y + z * z); }
};

struct HexElement {
    int eid{0};
    int pid{1};
    std::array<int, 8> n{}; // 1-based node IDs
};

struct BeamElement {
    int eid{0};
    int pid{2};
    int n1{0};
    int n2{0};
};

// Evaluate minimum corner scaled Jacobian for an 8-node hex
double computeScaledJacobian(const std::array<Vec3, 8>& v) {
    // 8 corners: check corner triad vectors
    // Local corner definitions in standard LS-DYNA Hex8:
    // Corner 0: (v1-v0, v3-v0, v4-v0)
    // Corner 1: (v2-v1, v0-v1, v5-v1)
    // Corner 2: (v3-v2, v1-v2, v6-v2)
    // Corner 3: (v0-v3, v2-v3, v7-v3)
    // Corner 4: (v5-v4, v7-v4, v0-v4) -> top face
    // Corner 5: (v6-v5, v4-v5, v1-v5)
    // Corner 6: (v7-v6, v5-v6, v2-v6)
    // Corner 7: (v4-v7, v6-v7, v3-v7)
    
    static const int corner_triads[8][3][2] = {
        {{1, 0}, {3, 0}, {4, 0}},
        {{2, 1}, {0, 1}, {5, 1}},
        {{3, 2}, {1, 2}, {6, 2}},
        {{0, 3}, {2, 3}, {7, 3}},
        {{5, 4}, {7, 4}, {0, 4}}, // 4 to 0 is reversed from top to bottom
        {{6, 5}, {4, 5}, {1, 5}},
        {{7, 6}, {5, 6}, {2, 6}},
        {{4, 7}, {6, 7}, {3, 7}}
    };

    double min_sj = 1e30;

    for (int c = 0; c < 8; ++c) {
        Vec3 e1 = v[corner_triads[c][0][0]] - v[corner_triads[c][0][1]];
        Vec3 e2 = v[corner_triads[c][1][0]] - v[corner_triads[c][1][1]];
        Vec3 e3 = v[corner_triads[c][2][0]] - v[corner_triads[c][2][1]];

        // Adjust top corners so e3 points outward
        if (c >= 4) {
            e3 = e3 * -1.0;
        }

        double l1 = e1.length();
        double l2 = e2.length();
        double l3 = e3.length();

        if (l1 < 1e-12 || l2 < 1e-12 || l3 < 1e-12) return 0.0;

        double det = e1.cross(e2).dot(e3);
        double sj = det / (l1 * l2 * l3);

        if (sj < min_sj) min_sj = sj;
    }

    return min_sj;
}

int main(int argc, char** argv) {
    auto t_start = std::chrono::high_resolution_clock::now();

    std::cout << "======================================================================" << std::endl;
    std::cout << "=== HIGH-PERFORMANCE C++20 RC HOLLOW BOX MESH GENERATOR ===" << std::endl;
    std::cout << "======================================================================" << std::endl;

    // Parameters
    const double Lx = 2.0;
    const double Ly = 2.0;
    const double Lz = 2.0;
    const double t_wall = 0.15;   // 150mm wall thickness
    const double cover = 0.025;   // 25mm cover depth
    const double h_target = 0.025; // 25mm nominal element size (fine mesh)
    const double jitter_ratio = 0.10; // 10% controlled stochastic jitter
    const int smoothing_iterations = 15;
    const double omega = 0.45; // Laplacian relaxation factor
    const std::string out_filename = "unstructured_rc_box_fine_high_qual.k";

    std::cout << "Outer Box: " << Lx << "m x " << Ly << "m x " << Lz << "m" << std::endl;
    std::cout << "Wall Thickness: " << t_wall * 1000.0 << " mm (" << int(round(t_wall / h_target)) << " elements through wall)" << std::endl;
    std::cout << "Cover: " << cover * 1000.0 << " mm, Nominal Element Size: " << h_target * 1000.0 << " mm" << std::endl;
    std::cout << "Controlled Jitter: " << jitter_ratio * 100.0 << "%, Smoothing Iterations: " << smoothing_iterations << std::endl;

    // 1. Build Partition Stations along X, Y, Z
    auto build_stations = [&](double L, double tw, double cov, double h) {
        std::vector<double> st;
        // Wall 1: [0, cov, ..., tw - cov, tw]
        int n_cov = std::max(1, int(round(cov / h)));
        for (int i = 0; i <= n_cov; ++i) st.push_back(i * (cov / n_cov));

        int n_core = std::max(1, int(round((tw - 2.0 * cov) / h)));
        for (int i = 1; i <= n_core; ++i) st.push_back(cov + i * ((tw - 2.0 * cov) / n_core));

        for (int i = 1; i <= n_cov; ++i) st.push_back((tw - cov) + i * (cov / n_cov));

        // Void: [tw ... L - tw]
        double L_void = L - 2.0 * tw;
        int n_void = std::max(2, int(round(L_void / h)));
        for (int i = 1; i < n_void; ++i) st.push_back(tw + i * (L_void / n_void));

        // Wall 2
        double base2 = L - tw;
        st.push_back(base2);
        for (int i = 1; i <= n_cov; ++i) st.push_back(base2 + i * (cov / n_cov));
        for (int i = 1; i <= n_core; ++i) st.push_back(base2 + cov + i * ((tw - 2.0 * cov) / n_core));
        for (int i = 1; i <= n_cov; ++i) st.push_back(base2 + (tw - cov) + i * (cov / n_cov));

        // Deduplicate and round
        std::sort(st.begin(), st.end());
        std::vector<double> unique_st;
        for (double v : st) {
            double r = std::round(v * 1e6) / 1e6;
            if (unique_st.empty() || std::abs(unique_st.back() - r) > 1e-5) {
                unique_st.push_back(r);
            }
        }
        return unique_st;
    };

    std::vector<double> xs = build_stations(Lx, t_wall, cover, h_target);
    std::vector<double> ys = build_stations(Ly, t_wall, cover, h_target);
    std::vector<double> zs = build_stations(Lz, t_wall, cover, h_target);

    int Nx = int(xs.size()) - 1;
    int Ny = int(ys.size()) - 1;
    int Nz = int(zs.size()) - 1;

    std::cout << "Grid Resolution: Nx=" << Nx << ", Ny=" << Ny << ", Nz=" << Nz << " (" << Nx * Ny * Nz << " total cells)" << std::endl;

    // 2. Identify Solid Concrete Cells (Hollow Box)
    const double eps = 1e-4;
    auto is_cell_solid = [&](int i, int j, int k) {
        double cx = 0.5 * (xs[i] + xs[i+1]);
        double cy = 0.5 * (ys[j] + ys[j+1]);
        double cz = 0.5 * (zs[k] + zs[k+1]);
        bool in_void = (cx >= t_wall - eps && cx <= Lx - t_wall + eps &&
                        cy >= t_wall - eps && cy <= Ly - t_wall + eps &&
                        cz >= t_wall - eps && cz <= Lz - t_wall + eps);
        return !in_void;
    };

    struct GridCoord {
        int i, j, k;
        bool operator==(const GridCoord& o) const { return i == o.i && j == o.j && k == o.k; }
    };

    struct GridCoordHash {
        size_t operator()(const GridCoord& c) const {
            return (size_t(c.i) * 73856093) ^ (size_t(c.j) * 19349663) ^ (size_t(c.k) * 83492791);
        }
    };

    std::vector<GridCoord> solid_cells;
    for (int k = 0; k < Nz; ++k) {
        for (int j = 0; j < Ny; ++j) {
            for (int i = 0; i < Nx; ++i) {
                if (is_cell_solid(i, j, k)) {
                    solid_cells.push_back({i, j, k});
                }
            }
        }
    }
    std::cout << "Active Solid Elements: " << solid_cells.size() << std::endl;

    // 3. Register Active Nodes
    std::unordered_map<GridCoord, int, GridCoordHash> coord_to_nid;
    std::vector<GridCoord> nid_to_coord;
    std::vector<Vec3> node_pos;
    std::vector<uint8_t> node_type; // 0=Free interior, 1=Outer planar, 2=Void planar, 3=Rebar 1D, 4=Rebar Crossing / Fixed SPC

    const std::vector<double> rebar_x = {cover, t_wall - cover, Lx - t_wall + cover, Lx - cover};
    const std::vector<double> rebar_y = {cover, t_wall - cover, Ly - t_wall + cover, Ly - cover};
    const std::vector<double> rebar_z = {cover, t_wall - cover, Lz - t_wall + cover, Lz - cover};

    auto is_val_match = [&](double v, const std::vector<double>& targets) {
        for (double t : targets) {
            if (std::abs(v - t) < eps) return true;
        }
        return false;
    };

    for (const auto& cell : solid_cells) {
        for (int di = 0; di <= 1; ++di) {
            for (int dj = 0; dj <= 1; ++dj) {
                for (int dk = 0; dk <= 1; ++dk) {
                    GridCoord gc = {cell.i + di, cell.j + dj, cell.k + dk};
                    if (coord_to_nid.find(gc) == coord_to_nid.end()) {
                        int nid = int(node_pos.size()) + 1;
                        coord_to_nid[gc] = nid;
                        nid_to_coord.push_back(gc);

                        double x = xs[gc.i];
                        double y = ys[gc.j];
                        double z = zs[gc.k];
                        node_pos.push_back({x, y, z});

                        // Classify node constraint type
                        bool on_base = (std::abs(y) < eps);
                        bool on_outer_x = (std::abs(x) < eps || std::abs(x - Lx) < eps);
                        bool on_outer_y = (std::abs(y - Ly) < eps);
                        bool on_outer_z = (std::abs(z) < eps || std::abs(z - Lz) < eps);

                        bool on_void_x = (std::abs(x - t_wall) < eps || std::abs(x - (Lx - t_wall)) < eps);
                        bool on_void_y = (std::abs(y - t_wall) < eps || std::abs(y - (Ly - t_wall)) < eps);
                        bool on_void_z = (std::abs(z - t_wall) < eps || std::abs(z - (Lz - t_wall)) < eps);

                        bool rx = is_val_match(x, rebar_x);
                        bool ry = is_val_match(y, rebar_y);
                        bool rz = is_val_match(z, rebar_z);

                        int rebar_count = (rx ? 1 : 0) + (ry ? 1 : 0) + (rz ? 1 : 0);

                        if (on_base) {
                            node_type.push_back(4); // Fully fixed SPC base
                        } else if (rebar_count >= 2) {
                            node_type.push_back(4); // Rebar intersection / rigid anchor
                        } else if (rebar_count == 1 && (on_outer_x || on_outer_y || on_outer_z || on_void_x || on_void_y || on_void_z)) {
                            node_type.push_back(3); // Rebar surface line
                        } else if (rx || ry || rz) {
                            node_type.push_back(3); // Rebar 1D line
                        } else if (on_outer_x || on_outer_y || on_outer_z) {
                            node_type.push_back(1); // Outer surface
                        } else if (on_void_x || on_void_y || on_void_z) {
                            node_type.push_back(2); // Void surface
                        } else {
                            node_type.push_back(0); // Free interior node
                        }
                    }
                }
            }
        }
    }

    const int num_nodes = int(node_pos.size());
    std::cout << "Total Active Nodes: " << num_nodes << std::endl;

    // 4. Build Hex Elements Connectivity
    std::vector<HexElement> hexes;
    hexes.reserve(solid_cells.size());
    int eid_counter = 1;

    for (const auto& cell : solid_cells) {
        int n1 = coord_to_nid[{cell.i, cell.j, cell.k}];
        int n2 = coord_to_nid[{cell.i + 1, cell.j, cell.k}];
        int n3 = coord_to_nid[{cell.i + 1, cell.j + 1, cell.k}];
        int n4 = coord_to_nid[{cell.i, cell.j + 1, cell.k}];

        int n5 = coord_to_nid[{cell.i, cell.j, cell.k + 1}];
        int n6 = coord_to_nid[{cell.i + 1, cell.j, cell.k + 1}];
        int n7 = coord_to_nid[{cell.i + 1, cell.j + 1, cell.k + 1}];
        int n8 = coord_to_nid[{cell.i, cell.j + 1, cell.k + 1}];

        hexes.push_back({eid_counter++, 1, {n1, n2, n3, n4, n5, n6, n7, n8}});
    }

    // 5. Build Nodal Adjacency Graph for Laplacian Smoothing
    std::vector<std::vector<int>> adj(num_nodes);
    auto add_edge = [&](int u, int v) {
        adj[u - 1].push_back(v - 1);
        adj[v - 1].push_back(u - 1);
    };

    for (const auto& h : hexes) {
        // 12 edges of a hex
        add_edge(h.n[0], h.n[1]); add_edge(h.n[1], h.n[2]); add_edge(h.n[2], h.n[3]); add_edge(h.n[3], h.n[0]);
        add_edge(h.n[4], h.n[5]); add_edge(h.n[5], h.n[6]); add_edge(h.n[6], h.n[7]); add_edge(h.n[7], h.n[4]);
        add_edge(h.n[0], h.n[4]); add_edge(h.n[1], h.n[5]); add_edge(h.n[2], h.n[6]); add_edge(h.n[3], h.n[7]);
    }

    for (int i = 0; i < num_nodes; ++i) {
        std::sort(adj[i].begin(), adj[i].end());
        adj[i].erase(std::unique(adj[i].begin(), adj[i].end()), adj[i].end());
    }

    // 6. Apply Stochastic Nodal Jitter to Break Cartesian Grid Alignment
    std::mt19937 rng(1337);
    std::uniform_real_distribution<double> dist(-1.0, 1.0);

    for (int i = 0; i < num_nodes; ++i) {
        uint8_t type = node_type[i];
        if (type == 4) continue; // Pinned SPC or rebar intersection

        double jx = dist(rng) * jitter_ratio * h_target;
        double jy = dist(rng) * jitter_ratio * h_target;
        double jz = dist(rng) * jitter_ratio * h_target;

        const auto& gc = nid_to_coord[i];
        double orig_x = xs[gc.i];
        double orig_y = ys[gc.j];
        double orig_z = zs[gc.k];

        bool on_outer_x = (std::abs(orig_x) < eps || std::abs(orig_x - Lx) < eps);
        bool on_outer_y = (std::abs(orig_y - Ly) < eps);
        bool on_outer_z = (std::abs(orig_z) < eps || std::abs(orig_z - Lz) < eps);

        bool on_void_x = (std::abs(orig_x - t_wall) < eps || std::abs(orig_x - (Lx - t_wall)) < eps);
        bool on_void_y = (std::abs(orig_y - t_wall) < eps || std::abs(orig_y - (Ly - t_wall)) < eps);
        bool on_void_z = (std::abs(orig_z - t_wall) < eps || std::abs(orig_z - (Lz - t_wall)) < eps);

        bool rx = is_val_match(orig_x, rebar_x);
        bool ry = is_val_match(orig_y, rebar_y);
        bool rz = is_val_match(orig_z, rebar_z);

        // Clamping rules
        if (on_outer_x || on_void_x) jx = 0.0;
        if (on_outer_y || on_void_y) jy = 0.0;
        if (on_outer_z || on_void_z) jz = 0.0;

        // Rebar lines: keep straight!
        if (rx && ry) { jx = 0.0; jy = 0.0; }
        if (rx && rz) { jx = 0.0; jz = 0.0; }
        if (ry && rz) { jy = 0.0; jz = 0.0; }

        node_pos[i].x += jx;
        node_pos[i].y += jy;
        node_pos[i].z += jz;
    }

    // 7. Multi-Pass Laplacian Relaxation & Geometric Smoothing
    std::cout << "Applying " << smoothing_iterations << " iterations of Laplacian smoothing..." << std::endl;
    std::vector<Vec3> smoothed_pos = node_pos;

    for (int it = 0; it < smoothing_iterations; ++it) {
        for (int i = 0; i < num_nodes; ++i) {
            uint8_t type = node_type[i];
            if (type == 4) continue; // Pinned

            Vec3 avg{0.0, 0.0, 0.0};
            for (int neighbor : adj[i]) {
                avg += node_pos[neighbor];
            }
            if (!adj[i].empty()) {
                avg = avg / double(adj[i].size());
                Vec3 disp = (avg - node_pos[i]) * omega;

                const auto& gc = nid_to_coord[i];
                double orig_x = xs[gc.i];
                double orig_y = ys[gc.j];
                double orig_z = zs[gc.k];

                bool on_outer_x = (std::abs(orig_x) < eps || std::abs(orig_x - Lx) < eps);
                bool on_outer_y = (std::abs(orig_y - Ly) < eps);
                bool on_outer_z = (std::abs(orig_z) < eps || std::abs(orig_z - Lz) < eps);

                bool on_void_x = (std::abs(orig_x - t_wall) < eps || std::abs(orig_x - (Lx - t_wall)) < eps);
                bool on_void_y = (std::abs(orig_y - t_wall) < eps || std::abs(orig_y - (Ly - t_wall)) < eps);
                bool on_void_z = (std::abs(orig_z - t_wall) < eps || std::abs(orig_z - (Lz - t_wall)) < eps);

                bool rx = is_val_match(orig_x, rebar_x);
                bool ry = is_val_match(orig_y, rebar_y);
                bool rz = is_val_match(orig_z, rebar_z);

                if (on_outer_x || on_void_x) disp.x = 0.0;
                if (on_outer_y || on_void_y) disp.y = 0.0;
                if (on_outer_z || on_void_z) disp.z = 0.0;

                if (rx && ry) { disp.x = 0.0; disp.y = 0.0; }
                if (rx && rz) { disp.x = 0.0; disp.z = 0.0; }
                if (ry && rz) { disp.y = 0.0; disp.z = 0.0; }

                smoothed_pos[i] = node_pos[i] + disp;
            }
        }
        node_pos = smoothed_pos;
    }

    // 8. Evaluate Scaled Jacobians
    double min_sj = 1e30;
    double max_sj = -1e30;
    double sum_sj = 0.0;
    int below_threshold = 0;

    for (const auto& h : hexes) {
        std::array<Vec3, 8> v;
        for (int k = 0; k < 8; ++k) {
            v[k] = node_pos[h.n[k] - 1];
        }
        double sj = computeScaledJacobian(v);
        if (sj < min_sj) min_sj = sj;
        if (sj > max_sj) max_sj = sj;
        sum_sj += sj;
        if (sj < 0.30) below_threshold++;
    }

    double avg_sj = sum_sj / double(hexes.size());
    std::cout << "Scaled Jacobian Statistics:" << std::endl;
    std::cout << "  Min Scaled Jacobian: " << min_sj << " (Target >= 0.40)" << std::endl;
    std::cout << "  Avg Scaled Jacobian: " << avg_sj << std::endl;
    std::cout << "  Max Scaled Jacobian: " << max_sj << std::endl;
    std::cout << "  Elements with SJ < 0.30: " << below_threshold << " (" << (double(below_threshold)/hexes.size()*100.0) << "%)" << std::endl;
    assert(min_sj > 0.15 && "Error: Inverted or severely distorted element detected!");

    // 9. Extract Conforming Shared-Node Rebar Cage
    std::vector<BeamElement> rebar_beams;
    std::unordered_set<uint64_t> seen_beams;

    auto add_beam_edge = [&](int n1, int n2) {
        int u = std::min(n1, n2);
        int v = std::max(n1, n2);
        uint64_t key = (uint64_t(u) << 32) | uint64_t(v);
        if (seen_beams.find(key) == seen_beams.end()) {
            seen_beams.insert(key);
            rebar_beams.push_back({1000000 + int(rebar_beams.size()) + 1, 2, u, v});
        }
    };

    // A. X-direction rebar lines: on rebar_y and rebar_z
    for (double ry : rebar_y) {
        for (double rz : rebar_z) {
            for (int i = 0; i < Nx; ++i) {
                // Find corresponding grid indices
                auto it_j = std::find_if(ys.begin(), ys.end(), [&](double v){ return std::abs(v - ry) < eps; });
                auto it_k = std::find_if(zs.begin(), zs.end(), [&](double v){ return std::abs(v - rz) < eps; });
                if (it_j != ys.end() && it_k != zs.end()) {
                    int j_idx = int(it_j - ys.begin());
                    int k_idx = int(it_k - zs.begin());
                    GridCoord c1 = {i, j_idx, k_idx};
                    GridCoord c2 = {i + 1, j_idx, k_idx};
                    if (coord_to_nid.find(c1) != coord_to_nid.end() && coord_to_nid.find(c2) != coord_to_nid.end()) {
                        add_beam_edge(coord_to_nid[c1], coord_to_nid[c2]);
                    }
                }
            }
        }
    }

    // B. Y-direction rebar lines: on rebar_x and rebar_z
    for (double rx : rebar_x) {
        for (double rz : rebar_z) {
            for (int j = 0; j < Ny; ++j) {
                auto it_i = std::find_if(xs.begin(), xs.end(), [&](double v){ return std::abs(v - rx) < eps; });
                auto it_k = std::find_if(zs.begin(), zs.end(), [&](double v){ return std::abs(v - rz) < eps; });
                if (it_i != xs.end() && it_k != zs.end()) {
                    int i_idx = int(it_i - xs.begin());
                    int k_idx = int(it_k - zs.begin());
                    GridCoord c1 = {i_idx, j, k_idx};
                    GridCoord c2 = {i_idx, j + 1, k_idx};
                    if (coord_to_nid.find(c1) != coord_to_nid.end() && coord_to_nid.find(c2) != coord_to_nid.end()) {
                        add_beam_edge(coord_to_nid[c1], coord_to_nid[c2]);
                    }
                }
            }
        }
    }

    // C. Z-direction rebar lines: on rebar_x and rebar_y
    for (double rx : rebar_x) {
        for (double ry : rebar_y) {
            for (int k = 0; k < Nz; ++k) {
                auto it_i = std::find_if(xs.begin(), xs.end(), [&](double v){ return std::abs(v - rx) < eps; });
                auto it_j = std::find_if(ys.begin(), ys.end(), [&](double v){ return std::abs(v - ry) < eps; });
                if (it_i != xs.end() && it_j != ys.end()) {
                    int i_idx = int(it_i - xs.begin());
                    int j_idx = int(it_j - ys.begin());
                    GridCoord c1 = {i_idx, j_idx, k};
                    GridCoord c2 = {i_idx, j_idx, k + 1};
                    if (coord_to_nid.find(c1) != coord_to_nid.end() && coord_to_nid.find(c2) != coord_to_nid.end()) {
                        add_beam_edge(coord_to_nid[c1], coord_to_nid[c2]);
                    }
                }
            }
        }
    }

    std::cout << "Generated " << rebar_beams.size() << " Conforming Rebar Beam Elements (Shared Nodes)" << std::endl;

    // 10. Base SPC Nodes (Y = 0)
    std::vector<int> spc_nodes;
    for (int i = 0; i < num_nodes; ++i) {
        if (std::abs(node_pos[i].y) < eps) {
            spc_nodes.push_back(i + 1);
        }
    }
    std::cout << "Fixed Base SPC Nodes (Y = 0.0m): " << spc_nodes.size() << std::endl;

    // 11. Stream Fast LS-DYNA Keyword Deck to Disk
    std::cout << "Writing LS-DYNA Keyword Deck to " << out_filename << "..." << std::endl;
    std::ofstream out(out_filename, std::ios::out | std::ios::trunc);
    if (!out.is_open()) {
        std::cerr << "Error: Could not open output file " << out_filename << std::endl;
        return 1;
    }

    out << "$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$\n";
    out << "$ HIGH-QUALITY NON-RECTILINEAR REINFORCED CONCRETE HOLLOW BOX (FINE MESH)\n";
    out << "$ Generated with C++20 High-Speed Engine + Laplacian Smoothing\n";
    out << "$ Statistics: " << num_nodes << " Nodes, " << hexes.size() << " Hex8 Solids, " << rebar_beams.size() << " Rebar Beams\n";
    out << "$ Scaled Jacobian Quality: Min = " << min_sj << ", Avg = " << avg_sj << "\n";
    out << "$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$\n";
    out << "*KEYWORD\n";
    out << "*TITLE\n";
    out << "High-Quality Non-Rectilinear RC Hollow Box 2m (Jitter=" << int(jitter_ratio*100) << "%)\n";

    // Controls
    out << "*CONTROL_TERMINATION\n";
    out << "$#  endtim    endcyc     dtmin    endeng    endmas     nosol\n";
    out << "     0.050         0     0.000     0.000     0.000         0\n";
    out << "*CONTROL_TIMESTEP\n";
    out << "$#  dtinit    tssfac      isdo    tslimt     dtms     lctm     erode     ms1st\n";
    out << "     0.000      0.85         0     0.000     0.000         0         0         0\n";
    out << "*CONTROL_ENERGY\n";
    out << "         2         2         2         2\n";
    out << "*CONTROL_HOURGLASS\n";
    out << "$#     ihq        qh\n";
    out << "         5      0.10\n";
    out << "*CONTROL_SOLID\n";
    out << "         0         0         0         0\n";

    // Database
    out << "*DATABASE_D3PLOT\n";
    out << "     0.001         0         0         0         0\n";
    out << "*DATABASE_GLSTAT\n";
    out << "    0.0001         0         0         1\n";
    out << "*DATABASE_MATSUM\n";
    out << "    0.0001         0         0         1\n";

    // Parts
    out << "*PART\n";
    out << "Concrete Hollow Box (CSCM 30MPa)\n";
    out << "$#     pid     secid       mid     eosid      hgid      grav    adpopt      tmid\n";
    out << "         1         1         1         0         1         0         0         0\n";
    out << "*PART\n";
    out << "Steel Rebar Cage (Shared Nodes 12mm)\n";
    out << "         2         2         2         0         0         0         0         0\n";

    // Sections
    out << "*SECTION_SOLID\n";
    out << "         1         1         0\n";
    out << "*HOURGLASS\n";
    out << "         1         5      0.10         0      0.00         0      1.50      0.06\n";
    out << "*SECTION_BEAM\n";
    out << "$#   secid    elform      shrf       cst      sarea     norm\n";
    const double rebar_diam = 0.012;
    const double rebar_area = M_PI * (rebar_diam / 2.0) * (rebar_diam / 2.0);
    out << "         2         1     1.000         1" << std::setw(10) << std::scientific << std::setprecision(4) << rebar_area << "         0\n";
    out << "$#     ts1       ts2       tt1       tt2      nsip\n";
    out << " 1.2000e-02 1.2000e-02     0.000     0.000         0\n";

    // Materials
    out << "*MAT_CSCM_CONCRETE\n";
    out << "$#     mid        ro       fpc      dagg     units\n";
    out << "         1   2400.00 3.0000e+07     0.019         1\n";

    out << "*MAT_PIECEWISE_LINEAR_PLASTICITY\n";
    out << "$#     mid        ro         e        pr      sigy      etan      fail      tdel\n";
    out << "         2   7850.00 2.0000e+11    0.3000 5.0000e+08 1.0000e+09     0.150     0.000\n";

    // SPC
    out << "*SET_NODE_LIST_TITLE\n";
    out << "Fixed Base Nodes (Y = 0)\n";
    out << "         1       0.0       0.0       0.0       0.0      MECH\n";
    for (size_t i = 0; i < spc_nodes.size(); i += 8) {
        for (size_t k = 0; k < 8 && i + k < spc_nodes.size(); ++k) {
            out << std::setw(10) << spc_nodes[i + k];
        }
        out << "\n";
    }
    out << "*BOUNDARY_SPC_SET\n";
    out << "         1         0         1         1         1         1         1         1\n";

    // Nodes
    out << "*NODE\n";
    out << std::fixed << std::setprecision(6);
    char buf[128];
    for (int i = 0; i < num_nodes; ++i) {
        snprintf(buf, sizeof(buf), "%8d%16.6f%16.6f%16.6f%8d%8d\n", i + 1, node_pos[i].x, node_pos[i].y, node_pos[i].z, 0, 0);
        out << buf;
    }

    // Solids
    out << "*ELEMENT_SOLID\n";
    for (const auto& h : hexes) {
        snprintf(buf, sizeof(buf), "%8d%8d%8d%8d%8d%8d%8d%8d%8d%8d\n",
                 h.eid, h.pid, h.n[0], h.n[1], h.n[2], h.n[3], h.n[4], h.n[5], h.n[6], h.n[7]);
        out << buf;
    }

    // Beams
    out << "*ELEMENT_BEAM\n";
    for (const auto& b : rebar_beams) {
        snprintf(buf, sizeof(buf), "%8d%8d%8d%8d%8d%8d%8d%8d%8d%8d\n",
                 b.eid, b.pid, b.n1, b.n2, 0, 0, 0, 0, 0, 0);
        out << buf;
    }

    out << "*END\n";
    out.close();

    auto t_end = std::chrono::high_resolution_clock::now();
    double elapsed_ms = std::chrono::duration<double, std::milli>(t_end - t_start).count();

    std::cout << "======================================================================" << std::endl;
    std::cout << "✓ Successfully generated " << out_filename << " in " << elapsed_ms << " ms (" << elapsed_ms / 1000.0 << " s)!" << std::endl;
    std::cout << "======================================================================" << std::endl;

    return 0;
}
