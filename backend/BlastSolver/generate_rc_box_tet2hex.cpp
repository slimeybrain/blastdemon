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

double computeHexScaledJacobian(const std::array<Vec3, 8>& v) {
    static const int corner_triads[8][3][2] = {
        {{1, 0}, {3, 0}, {4, 0}},
        {{2, 1}, {0, 1}, {5, 1}},
        {{3, 2}, {1, 2}, {6, 2}},
        {{0, 3}, {2, 3}, {7, 3}},
        {{5, 4}, {7, 4}, {0, 4}},
        {{6, 5}, {4, 5}, {1, 5}},
        {{7, 6}, {5, 6}, {2, 6}},
        {{4, 7}, {6, 7}, {3, 7}}
    };

    double min_sj = 1e30;

    for (int c = 0; c < 8; ++c) {
        Vec3 e1 = v[corner_triads[c][0][0]] - v[corner_triads[c][0][1]];
        Vec3 e2 = v[corner_triads[c][1][0]] - v[corner_triads[c][1][1]];
        Vec3 e3 = v[corner_triads[c][2][0]] - v[corner_triads[c][2][1]];

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
    std::cout << "=== HIGH-QUALITY TET-TO-HEX RC BOX GENERATOR (~20MM RESOLUTION) ======" << std::endl;
    std::cout << "======================================================================" << std::endl;

    // Parameters
    const double Lx = 2.0;
    const double Ly = 2.0;
    const double Lz = 2.0;
    const double t_wall = 0.15;   // 150mm wall thickness
    const double cover = 0.025;   // 25mm cover depth
    const double rebar_pitch = 0.125; // EXACT 125mm (0.125m) rebar spacing
    const double jitter_fraction = 0.04;
    const int smoothing_iterations = 25;
    const double omega = 0.30;
    const std::string out_filename = "unstructured_rc_box_tet2hex_high_qual.k";

    std::cout << "Outer Box: " << Lx << "m x " << Ly << "m x " << Lz << "m, Wall: " << t_wall*1000.0 << " mm" << std::endl;
    std::cout << "Target Element Resolution: ~20 mm nominal (125mm / 6 = 20.8 mm)" << std::endl;
    std::cout << "Rebar Spacing: " << rebar_pitch*1000.0 << " mm (125mm c/c)" << std::endl;

    // 1. Build Grid Stations with Exact 125mm Rebar Spacing Alignment & ~20mm Hexes
    auto build_stations = [&](double L, double tw, double cov, double pitch) {
        std::vector<double> st;

        int n_bays = int(round(L / pitch));
        for (int b = 0; b < n_bays; ++b) {
            double b_start = b * pitch;
            for (int sub = 0; sub < 3; ++sub) {
                st.push_back(b_start + sub * (pitch / 3.0));
            }
        }
        st.push_back(L);

        // Wall boundary stations
        st.push_back(0.0);
        st.push_back(cov);
        st.push_back(tw - cov);
        st.push_back(tw);

        st.push_back(L - tw);
        st.push_back(L - (tw - cov));
        st.push_back(L - cov);
        st.push_back(L);

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

    std::vector<double> xs = build_stations(Lx, t_wall, cover, rebar_pitch);
    std::vector<double> ys = build_stations(Ly, t_wall, cover, rebar_pitch);
    std::vector<double> zs = build_stations(Lz, t_wall, cover, rebar_pitch);

    int Nx = int(xs.size()) - 1;
    int Ny = int(ys.size()) - 1;
    int Nz = int(zs.size()) - 1;

    std::cout << "Macro Grid Stations: Nx=" << Nx << ", Ny=" << Ny << ", Nz=" << Nz << " (Total Macro: " << Nx*Ny*Nz << ")" << std::endl;

    // 2. Identify Solid Concrete Macro Blocks
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

    std::vector<GridCoord> solid_macro_cells;
    for (int k = 0; k < Nz; ++k) {
        for (int j = 0; j < Ny; ++j) {
            for (int i = 0; i < Nx; ++i) {
                if (is_cell_solid(i, j, k)) {
                    solid_macro_cells.push_back({i, j, k});
                }
            }
        }
    }
    std::cout << "Active Solid Macro Blocks: " << solid_macro_cells.size() << std::endl;

    // 3. Define Rebar Grid Lines (Exact 125mm pitch on Outer/Inner Curtains)
    const std::vector<double> curtain_x = {cover, t_wall - cover, Lx - (t_wall - cover), Lx - cover};
    const std::vector<double> curtain_y = {cover, t_wall - cover, Ly - (t_wall - cover), Ly - cover};
    const std::vector<double> curtain_z = {cover, t_wall - cover, Lz - (t_wall - cover), Lz - cover};

    std::vector<double> grid_125mm;
    for (int i = 0; i <= int(round(Lx / rebar_pitch)); ++i) {
        grid_125mm.push_back(round(i * rebar_pitch * 1e6) / 1e6);
    }

    auto is_match = [&](double v, const std::vector<double>& targets) {
        for (double t : targets) {
            if (std::abs(v - t) < eps) return true;
        }
        return false;
    };

    std::unordered_map<GridCoord, int, GridCoordHash> macro_coord_to_idx;
    std::vector<GridCoord> macro_idx_to_coord;
    std::vector<Vec3> macro_pos;

    for (const auto& cell : solid_macro_cells) {
        for (int di = 0; di <= 1; ++di) {
            for (int dj = 0; dj <= 1; ++dj) {
                for (int dk = 0; dk <= 1; ++dk) {
                    GridCoord gc = {cell.i + di, cell.j + dj, cell.k + dk};
                    if (macro_coord_to_idx.find(gc) == macro_coord_to_idx.end()) {
                        int idx = int(macro_pos.size());
                        macro_coord_to_idx[gc] = idx;
                        macro_idx_to_coord.push_back(gc);

                        double x = xs[gc.i];
                        double y = ys[gc.j];
                        double z = zs[gc.k];
                        macro_pos.push_back({x, y, z});
                    }
                }
            }
        }
    }

    std::cout << "Macro Vertices: " << macro_pos.size() << std::endl;

    // Apply strict axis-clamped stochastic jitter to macro vertices
    std::mt19937 rng(42);
    std::uniform_real_distribution<double> dist(-1.0, 1.0);
    const double macro_h = 0.04167; // ~41.7 mm

    for (size_t i = 0; i < macro_pos.size(); ++i) {
        const auto& gc = macro_idx_to_coord[i];
        double x = xs[gc.i];
        double y = ys[gc.j];
        double z = zs[gc.k];

        bool on_base = (std::abs(y) < eps);
        if (on_base) continue;

        bool on_outer_x = (std::abs(x) < eps || std::abs(x - Lx) < eps);
        bool on_outer_y = (std::abs(y - Ly) < eps);
        bool on_outer_z = (std::abs(z) < eps || std::abs(z - Lz) < eps);

        bool on_void_x = (std::abs(x - t_wall) < eps || std::abs(x - (Lx - t_wall)) < eps);
        bool on_void_y = (std::abs(y - t_wall) < eps || std::abs(y - (Ly - t_wall)) < eps);
        bool on_void_z = (std::abs(z - t_wall) < eps || std::abs(z - (Lz - t_wall)) < eps);

        // Check if node is on ANY 125mm rebar line (mats or shear ties)
        bool on_rebar_x_mat = (is_match(y, curtain_y) && is_match(z, grid_125mm)) ||
                              (is_match(z, curtain_z) && is_match(y, grid_125mm));
        bool on_rebar_y_mat = (is_match(x, curtain_x) && is_match(z, grid_125mm)) ||
                              (is_match(z, curtain_z) && is_match(x, grid_125mm));
        bool on_rebar_z_mat = (is_match(x, curtain_x) && is_match(y, grid_125mm)) ||
                              (is_match(y, curtain_y) && is_match(x, grid_125mm));

        bool on_shear_tie_x = is_match(y, grid_125mm) && is_match(z, grid_125mm) &&
                              ((x >= cover - eps && x <= t_wall - cover + eps) || (x >= Lx - t_wall + cover - eps && x <= Lx - cover + eps));
        bool on_shear_tie_y = is_match(x, grid_125mm) && is_match(z, grid_125mm) &&
                              ((y >= cover - eps && y <= t_wall - cover + eps) || (y >= Ly - t_wall + cover - eps && y <= Ly - cover + eps));
        bool on_shear_tie_z = is_match(x, grid_125mm) && is_match(y, grid_125mm) &&
                              ((z >= cover - eps && z <= t_wall - cover + eps) || (z >= Lz - t_wall + cover - eps && z <= Lz - cover + eps));

        bool is_rebar = on_rebar_x_mat || on_rebar_y_mat || on_rebar_z_mat || on_shear_tie_x || on_shear_tie_y || on_shear_tie_z;

        if (is_rebar) continue; // Pinned strictly to straight 125mm rebar lines

        double jx = dist(rng) * jitter_fraction * macro_h;
        double jy = dist(rng) * jitter_fraction * macro_h;
        double jz = dist(rng) * jitter_fraction * macro_h;

        if (on_outer_x || on_void_x) jx = 0.0;
        if (on_outer_y || on_void_y) jy = 0.0;
        if (on_outer_z || on_void_z) jz = 0.0;

        macro_pos[i].x += jx;
        macro_pos[i].y += jy;
        macro_pos[i].z += jz;
    }

    // 4. Triangulate Solid Macro Blocks into Tetrahedra (Uniform Conforming Kuhn Decomposition)
    struct Tet {
        int v[4];
    };
    std::vector<Tet> tets;
    tets.reserve(solid_macro_cells.size() * 6);

    for (const auto& cell : solid_macro_cells) {
        int c0 = macro_coord_to_idx[{cell.i, cell.j, cell.k}];
        int c1 = macro_coord_to_idx[{cell.i + 1, cell.j, cell.k}];
        int c2 = macro_coord_to_idx[{cell.i + 1, cell.j + 1, cell.k}];
        int c3 = macro_coord_to_idx[{cell.i, cell.j + 1, cell.k}];
        int c4 = macro_coord_to_idx[{cell.i, cell.j, cell.k + 1}];
        int c5 = macro_coord_to_idx[{cell.i + 1, cell.j, cell.k + 1}];
        int c6 = macro_coord_to_idx[{cell.i + 1, cell.j + 1, cell.k + 1}];
        int c7 = macro_coord_to_idx[{cell.i, cell.j + 1, cell.k + 1}];

        tets.push_back({c0, c1, c2, c6});
        tets.push_back({c0, c1, c5, c6});
        tets.push_back({c0, c3, c2, c6});
        tets.push_back({c0, c3, c7, c6});
        tets.push_back({c0, c4, c5, c6});
        tets.push_back({c0, c4, c7, c6});
    }
    std::cout << "Generated " << tets.size() << " Conforming Tetrahedra" << std::endl;

    // 5. Perform 1-to-4 Tet-to-Hex Subdivision
    struct EdgeKey {
        int u, v;
        bool operator==(const EdgeKey& o) const { return u == o.u && v == o.v; }
    };
    struct EdgeKeyHash {
        size_t operator()(const EdgeKey& e) const {
            return (size_t(e.u) * 19349663) ^ (size_t(e.v) * 83492791);
        }
    };

    struct FaceKey {
        int a, b, c;
        bool operator==(const FaceKey& o) const { return a == o.a && b == o.b && c == o.c; }
    };
    struct FaceKeyHash {
        size_t operator()(const FaceKey& f) const {
            return (size_t(f.a) * 73856093) ^ (size_t(f.b) * 19349663) ^ (size_t(f.c) * 83492791);
        }
    };

    std::vector<Vec3> sub_nodes;

    std::vector<int> macro_to_sub(macro_pos.size());
    for (size_t i = 0; i < macro_pos.size(); ++i) {
        int nid = int(sub_nodes.size()) + 1;
        macro_to_sub[i] = nid;
        sub_nodes.push_back(macro_pos[i]);
    }

    std::unordered_map<EdgeKey, int, EdgeKeyHash> edge_to_node;
    auto get_edge_midpoint = [&](int u, int v) -> int {
        int a = std::min(u, v);
        int b = std::max(u, v);
        EdgeKey key = {a, b};
        auto it = edge_to_node.find(key);
        if (it != edge_to_node.end()) return it->second;

        int nid = int(sub_nodes.size()) + 1;
        edge_to_node[key] = nid;
        Vec3 mid = (macro_pos[a] + macro_pos[b]) * 0.5;
        sub_nodes.push_back(mid);
        return nid;
    };

    std::unordered_map<FaceKey, int, FaceKeyHash> face_to_node;
    auto get_face_centroid = [&](int u, int v, int w) -> int {
        std::array<int, 3> arr = {u, v, w};
        std::sort(arr.begin(), arr.end());
        FaceKey key = {arr[0], arr[1], arr[2]};
        auto it = face_to_node.find(key);
        if (it != face_to_node.end()) return it->second;

        int nid = int(sub_nodes.size()) + 1;
        face_to_node[key] = nid;
        Vec3 cent = (macro_pos[arr[0]] + macro_pos[arr[1]] + macro_pos[arr[2]]) * (1.0 / 3.0);
        sub_nodes.push_back(cent);
        return nid;
    };

    std::vector<HexElement> unstructured_hexes;
    unstructured_hexes.reserve(tets.size() * 4);
    int hex_eid = 1;

    for (const auto& tet : tets) {
        int v0 = tet.v[0];
        int v1 = tet.v[1];
        int v2 = tet.v[2];
        int v3 = tet.v[3];

        Vec3 V0 = macro_pos[v0];
        Vec3 V1 = macro_pos[v1];
        Vec3 V2 = macro_pos[v2];
        Vec3 V3 = macro_pos[v3];

        double vol6 = (V1 - V0).cross(V2 - V0).dot(V3 - V0);
        if (vol6 < 0) {
            std::swap(v2, v3);
            std::swap(V2, V3);
        }

        int n_v0 = macro_to_sub[v0];
        int n_v1 = macro_to_sub[v1];
        int n_v2 = macro_to_sub[v2];
        int n_v3 = macro_to_sub[v3];

        int n_m01 = get_edge_midpoint(v0, v1);
        int n_m02 = get_edge_midpoint(v0, v2);
        int n_m03 = get_edge_midpoint(v0, v3);
        int n_m12 = get_edge_midpoint(v1, v2);
        int n_m13 = get_edge_midpoint(v1, v3);
        int n_m23 = get_edge_midpoint(v2, v3);

        int n_f012 = get_face_centroid(v0, v1, v2);
        int n_f013 = get_face_centroid(v0, v1, v3);
        int n_f023 = get_face_centroid(v0, v2, v3);
        int n_f123 = get_face_centroid(v1, v2, v3);

        int n_c = int(sub_nodes.size()) + 1;
        Vec3 C = (V0 + V1 + V2 + V3) * 0.25;
        sub_nodes.push_back(C);

        unstructured_hexes.push_back({hex_eid++, 1, {n_v0, n_m01, n_f012, n_m02, n_m03, n_f013, n_c, n_f023}});
        unstructured_hexes.push_back({hex_eid++, 1, {n_v1, n_m12, n_f012, n_m01, n_m13, n_f123, n_c, n_f013}});
        unstructured_hexes.push_back({hex_eid++, 1, {n_v2, n_m02, n_f012, n_m12, n_m23, n_f023, n_c, n_f123}});
        unstructured_hexes.push_back({hex_eid++, 1, {n_v3, n_m23, n_f123, n_m13, n_m03, n_f023, n_c, n_f013}}); // Candidate 5 (Positive Orientation)
    }

    const int total_sub_nodes = int(sub_nodes.size());
    std::cout << "Subdivided into " << unstructured_hexes.size() << " Truly Unstructured Hex8 Elements (" << total_sub_nodes << " Nodes)" << std::endl;

    // 6. Centroidal / Cell-Relaxation Smoothing (ONLY on interior tet centroids)
    std::cout << "Applying " << smoothing_iterations << " iterations of geometry-preserving relaxation..." << std::endl;
    for (int it = 0; it < smoothing_iterations; ++it) {
        for (const auto& h : unstructured_hexes) {
            int n_c = h.n[6];
            Vec3 hex_center{0,0,0};
            for (int k = 0; k < 8; ++k) {
                hex_center += sub_nodes[h.n[k] - 1];
            }
            hex_center = hex_center * (1.0 / 8.0);
            sub_nodes[n_c - 1] = sub_nodes[n_c - 1] * (1.0 - omega) + hex_center * omega;
        }
    }

    // 7. Evaluate Scaled Jacobians
    double min_sj = 1e30, max_sj = -1e30, sum_sj = 0.0;
    int sj_above_40 = 0;
    for (const auto& h : unstructured_hexes) {
        std::array<Vec3, 8> v;
        for (int k = 0; k < 8; ++k) {
            v[k] = sub_nodes[h.n[k] - 1];
        }
        double sj = computeHexScaledJacobian(v);
        if (sj < min_sj) min_sj = sj;
        if (sj > max_sj) max_sj = sj;
        sum_sj += sj;
        if (sj >= 0.40) sj_above_40++;
    }

    std::cout << "======================================================================" << std::endl;
    std::cout << "TET-TO-HEX SCALED JACOBIAN QUALITY:" << std::endl;
    std::cout << "  Min Scaled Jacobian: " << min_sj << " (Strictly Positive: " << (min_sj > 0) << ")" << std::endl;
    std::cout << "  Avg Scaled Jacobian: " << (sum_sj / unstructured_hexes.size()) << std::endl;
    std::cout << "  Max Scaled Jacobian: " << max_sj << std::endl;
    std::cout << "  Elements with SJ >= 0.40: " << sj_above_40 << " (" << (100.0 * sj_above_40 / unstructured_hexes.size()) << "%)" << std::endl;
    std::cout << "======================================================================" << std::endl;

    // 8. Extract Conforming 125mm-Spaced Rebar Cage
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

    auto add_macro_rebar_segment = [&](int u, int v) {
        int n_u = macro_to_sub[u];
        int n_mid = get_edge_midpoint(u, v);
        int n_v = macro_to_sub[v];
        add_beam_edge(n_u, n_mid);
        add_beam_edge(n_mid, n_v);
    };

    // A. X-direction rebar lines: on curtain_y and grid_125mm Z (and curtain_z and grid_125mm Y)
    for (double cy : curtain_y) {
        for (double rz : grid_125mm) {
            for (int i = 0; i < Nx; ++i) {
                auto it_j = std::find_if(ys.begin(), ys.end(), [&](double v){ return std::abs(v - cy) < eps; });
                auto it_k = std::find_if(zs.begin(), zs.end(), [&](double v){ return std::abs(v - rz) < eps; });
                if (it_j != ys.end() && it_k != zs.end()) {
                    int j_idx = int(it_j - ys.begin());
                    int k_idx = int(it_k - zs.begin());
                    GridCoord c1 = {i, j_idx, k_idx};
                    GridCoord c2 = {i + 1, j_idx, k_idx};
                    if (macro_coord_to_idx.find(c1) != macro_coord_to_idx.end() && macro_coord_to_idx.find(c2) != macro_coord_to_idx.end()) {
                        add_macro_rebar_segment(macro_coord_to_idx[c1], macro_coord_to_idx[c2]);
                    }
                }
            }
        }
    }
    for (double cz : curtain_z) {
        for (double ry : grid_125mm) {
            for (int i = 0; i < Nx; ++i) {
                auto it_k = std::find_if(zs.begin(), zs.end(), [&](double v){ return std::abs(v - cz) < eps; });
                auto it_j = std::find_if(ys.begin(), ys.end(), [&](double v){ return std::abs(v - ry) < eps; });
                if (it_k != zs.end() && it_j != ys.end()) {
                    int k_idx = int(it_k - zs.begin());
                    int j_idx = int(it_j - ys.begin());
                    GridCoord c1 = {i, j_idx, k_idx};
                    GridCoord c2 = {i + 1, j_idx, k_idx};
                    if (macro_coord_to_idx.find(c1) != macro_coord_to_idx.end() && macro_coord_to_idx.find(c2) != macro_coord_to_idx.end()) {
                        add_macro_rebar_segment(macro_coord_to_idx[c1], macro_coord_to_idx[c2]);
                    }
                }
            }
        }
    }

    // B. Y-direction rebar lines: on curtain_x and grid_125mm Z (and curtain_z and grid_125mm X)
    for (double cx : curtain_x) {
        for (double rz : grid_125mm) {
            for (int j = 0; j < Ny; ++j) {
                auto it_i = std::find_if(xs.begin(), xs.end(), [&](double v){ return std::abs(v - cx) < eps; });
                auto it_k = std::find_if(zs.begin(), zs.end(), [&](double v){ return std::abs(v - rz) < eps; });
                if (it_i != xs.end() && it_k != zs.end()) {
                    int i_idx = int(it_i - xs.begin());
                    int k_idx = int(it_k - zs.begin());
                    GridCoord c1 = {i_idx, j, k_idx};
                    GridCoord c2 = {i_idx, j + 1, k_idx};
                    if (macro_coord_to_idx.find(c1) != macro_coord_to_idx.end() && macro_coord_to_idx.find(c2) != macro_coord_to_idx.end()) {
                        add_macro_rebar_segment(macro_coord_to_idx[c1], macro_coord_to_idx[c2]);
                    }
                }
            }
        }
    }
    for (double cz : curtain_z) {
        for (double rx : grid_125mm) {
            for (int j = 0; j < Ny; ++j) {
                auto it_k = std::find_if(zs.begin(), zs.end(), [&](double v){ return std::abs(v - cz) < eps; });
                auto it_i = std::find_if(xs.begin(), xs.end(), [&](double v){ return std::abs(v - rx) < eps; });
                if (it_k != zs.end() && it_i != xs.end()) {
                    int k_idx = int(it_k - zs.begin());
                    int i_idx = int(it_i - xs.begin());
                    GridCoord c1 = {i_idx, j, k_idx};
                    GridCoord c2 = {i_idx, j + 1, k_idx};
                    if (macro_coord_to_idx.find(c1) != macro_coord_to_idx.end() && macro_coord_to_idx.find(c2) != macro_coord_to_idx.end()) {
                        add_macro_rebar_segment(macro_coord_to_idx[c1], macro_coord_to_idx[c2]);
                    }
                }
            }
        }
    }

    // C. Z-direction rebar lines: on curtain_x and grid_125mm Y (and curtain_y and grid_125mm X)
    for (double cx : curtain_x) {
        for (double ry : grid_125mm) {
            for (int k = 0; k < Nz; ++k) {
                auto it_i = std::find_if(xs.begin(), xs.end(), [&](double v){ return std::abs(v - cx) < eps; });
                auto it_j = std::find_if(ys.begin(), ys.end(), [&](double v){ return std::abs(v - ry) < eps; });
                if (it_i != xs.end() && it_j != ys.end()) {
                    int i_idx = int(it_i - xs.begin());
                    int j_idx = int(it_j - ys.begin());
                    GridCoord c1 = {i_idx, j_idx, k};
                    GridCoord c2 = {i_idx, j_idx, k + 1};
                    if (macro_coord_to_idx.find(c1) != macro_coord_to_idx.end() && macro_coord_to_idx.find(c2) != macro_coord_to_idx.end()) {
                        add_macro_rebar_segment(macro_coord_to_idx[c1], macro_coord_to_idx[c2]);
                    }
                }
            }
        }
    }
    for (double cy : curtain_y) {
        for (double rx : grid_125mm) {
            for (int k = 0; k < Nz; ++k) {
                auto it_j = std::find_if(ys.begin(), ys.end(), [&](double v){ return std::abs(v - cy) < eps; });
                auto it_i = std::find_if(xs.begin(), xs.end(), [&](double v){ return std::abs(v - rx) < eps; });
                if (it_j != ys.end() && it_i != xs.end()) {
                    int j_idx = int(it_j - ys.begin());
                    int i_idx = int(it_i - xs.begin());
                    GridCoord c1 = {i_idx, j_idx, k};
                    GridCoord c2 = {i_idx, j_idx, k + 1};
                    if (macro_coord_to_idx.find(c1) != macro_coord_to_idx.end() && macro_coord_to_idx.find(c2) != macro_coord_to_idx.end()) {
                        add_macro_rebar_segment(macro_coord_to_idx[c1], macro_coord_to_idx[c2]);
                    }
                }
            }
        }
    }

    // Shear ties: connecting outer curtain to inner curtain at 125mm intersections
    for (double ry : grid_125mm) {
        for (double rz : grid_125mm) {
            auto it_j = std::find_if(ys.begin(), ys.end(), [&](double v){ return std::abs(v - ry) < eps; });
            auto it_k = std::find_if(zs.begin(), zs.end(), [&](double v){ return std::abs(v - rz) < eps; });
            if (it_j != ys.end() && it_k != zs.end()) {
                int j_idx = int(it_j - ys.begin());
                int k_idx = int(it_k - zs.begin());
                for (int i = 0; i < Nx; ++i) {
                    if (xs[i] >= cover - eps && xs[i+1] <= t_wall - cover + eps) {
                        GridCoord c1 = {i, j_idx, k_idx};
                        GridCoord c2 = {i + 1, j_idx, k_idx};
                        if (macro_coord_to_idx.find(c1) != macro_coord_to_idx.end() && macro_coord_to_idx.find(c2) != macro_coord_to_idx.end()) {
                            add_macro_rebar_segment(macro_coord_to_idx[c1], macro_coord_to_idx[c2]);
                        }
                    }
                    if (xs[i] >= Lx - t_wall + cover - eps && xs[i+1] <= Lx - cover + eps) {
                        GridCoord c1 = {i, j_idx, k_idx};
                        GridCoord c2 = {i + 1, j_idx, k_idx};
                        if (macro_coord_to_idx.find(c1) != macro_coord_to_idx.end() && macro_coord_to_idx.find(c2) != macro_coord_to_idx.end()) {
                            add_macro_rebar_segment(macro_coord_to_idx[c1], macro_coord_to_idx[c2]);
                        }
                    }
                }
            }
        }
    }

    std::cout << "Generated " << rebar_beams.size() << " Conforming Rebar Beam Elements (Exact 125mm Spacing)" << std::endl;

    // 9. Base SPC Nodes (Y = 0)
    std::vector<int> spc_nodes;
    for (int i = 0; i < total_sub_nodes; ++i) {
        if (std::abs(sub_nodes[i].y) < eps) {
            spc_nodes.push_back(i + 1);
        }
    }
    std::cout << "Fixed Base SPC Nodes (Y = 0.0m): " << spc_nodes.size() << std::endl;

    // 10. Stream LS-DYNA Keyword Deck
    std::cout << "Streaming deck to " << out_filename << "..." << std::endl;
    std::ofstream out(out_filename, std::ios::out | std::ios::trunc);
    if (!out.is_open()) return 1;

    out << "$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$\n";
    out << "$ LS-DYNA KEYWORD DECK: UNSTRUCTURED TET-TO-HEX RC HOLLOW BOX (2M, ~20MM RESOLUTION)\n";
    out << "$ Reinforcement: EXACT 125mm c/c Dual-Layer Curtain with Ties on Shared Hex Nodes\n";
    out << "$ Statistics: " << total_sub_nodes << " Nodes, " << unstructured_hexes.size() << " Solid Hex8, " << rebar_beams.size() << " Beams\n";
    out << "$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$\n";
    out << "*KEYWORD\n";
    out << "*TITLE\n";
    out << "Unstructured Tet-to-Hex RC Hollow Box 2m (20mm Hexes, 125mm Rebar)\n";

    // Controls
    out << "*CONTROL_TERMINATION\n";
    out << "     0.050         0     0.000     0.000     0.000         0\n";
    out << "*CONTROL_TIMESTEP\n";
    out << "     0.000      0.85         0     0.100     0.000         0         1         0\n";
    out << "*CONTROL_ENERGY\n";
    out << "         2         2         2         2\n";
    out << "*CONTROL_HOURGLASS\n";
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
    out << "Concrete Hollow Box (Unstructured Tet-to-Hex CSCM)\n";
    out << "         1         1         1         0         1         0         0         0\n";
    out << "*PART\n";
    out << "Steel Rebar Cage (Shared-Node 12mm Beams @ 125mm)\n";
    out << "         2         2         2         0         0         0         0         0\n";

    // Sections
    out << "*SECTION_SOLID\n";
    out << "         1         1         0\n";
    out << "*HOURGLASS\n";
    out << "         1         5      0.10         0      0.00         0      1.50      0.06\n";
    out << "*SECTION_BEAM\n";
    const double rebar_diam = 0.012;
    const double rebar_area = M_PI * (rebar_diam / 2.0) * (rebar_diam / 2.0);
    out << "         2         1     1.000         1" << std::setw(10) << std::scientific << std::setprecision(4) << rebar_area << "         0\n";
    out << " 1.2000e-02 1.2000e-02     0.000     0.000         0\n";

    // Materials
    out << "*MAT_CSCM_CONCRETE\n";
    out << "         1   2400.00 3.0000e+07     0.019         1\n";
    out << "*MAT_PIECEWISE_LINEAR_PLASTICITY\n";
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
    char buf[128];
    for (int i = 0; i < total_sub_nodes; ++i) {
        snprintf(buf, sizeof(buf), "%8d%16.6f%16.6f%16.6f%8d%8d\n", i + 1, sub_nodes[i].x, sub_nodes[i].y, sub_nodes[i].z, 0, 0);
        out << buf;
    }

    // Solids
    out << "*ELEMENT_SOLID\n";
    for (const auto& h : unstructured_hexes) {
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
    std::cout << "✓ Successfully generated " << out_filename << " in " << elapsed_ms << " ms!" << std::endl;
    std::cout << "======================================================================" << std::endl;

    return 0;
}
