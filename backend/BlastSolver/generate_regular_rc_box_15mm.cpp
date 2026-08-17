#include <iostream>
#include <fstream>
#include <vector>
#include <array>
#include <cmath>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <algorithm>
#include <iomanip>
#include <cassert>
#include <chrono>

struct Vec3 {
    double x{0.0}, y{0.0}, z{0.0};
    Vec3 operator+(const Vec3& o) const { return {x + o.x, y + o.y, z + o.z}; }
    Vec3 operator-(const Vec3& o) const { return {x - o.x, y - o.y, z - o.z}; }
    Vec3 operator*(double s) const { return {x * s, y * s, z * s}; }
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

int main(int argc, char** argv) {
    auto t_start = std::chrono::high_resolution_clock::now();

    std::cout << "======================================================================" << std::endl;
    std::cout << "=== REGULAR RC HOLLOW BOX GENERATOR (MINIMUM 15MM ELEMENT SIZE) ======" << std::endl;
    std::cout << "======================================================================" << std::endl;

    // Parameters
    const double Lx = 2.0;
    const double Ly = 2.0;
    const double Lz = 2.0;
    const double t_wall = 0.15;           // 150mm wall thickness
    const double cover = 0.025;           // 25mm cover depth
    const double rebar_pitch = 0.125;      // 125mm (0.125m) rebar spacing
    const double min_elem_target = 0.015; // 15mm strictly enforced minimum
    const std::string out_filename = "regular_rc_box_15mm.k";

    std::cout << "Outer Dimensions: " << Lx << "m x " << Ly << "m x " << Lz << "m" << std::endl;
    std::cout << "Wall Thickness: " << t_wall * 1000.0 << " mm" << std::endl;
    std::cout << "Minimum Element Size: " << min_elem_target * 1000.0 << " mm (strictly enforced min(h) >= 15mm)" << std::endl;
    std::cout << "Rebar Spacing: " << rebar_pitch * 1000.0 << " mm (125mm c/c dual curtains + ties)" << std::endl;

    // 1. Build Partition Stations with Strict Piecewise Subdivisions ensuring min(h) >= 15.0mm
    auto build_stations = [&](double L, double tw, double cov, double pitch) {
        std::vector<double> st;

        // --- Wall 1: [0.0 ... 0.150m] ---
        // 1. Outer Cover: [0.0 ... 0.025m] (1 element: 25.0 mm)
        st.push_back(0.0);
        st.push_back(cov);

        // 2. Wall 1 Core: [0.025 ... 0.125m] (6 elements: 16.667 mm each)
        for (int i = 1; i <= 6; ++i) {
            st.push_back(cov + i * ((tw - 2.0 * cov) / 6.0));
        }

        // 3. Wall 1 Inner Cover: [0.125 ... 0.150m] (1 element: 25.0 mm)
        st.push_back(tw);

        // --- Void: [0.150 ... 1.850m] ---
        // 4. Transition from wall boundary (0.150m) to first interior rebar station (0.250m)
        // Span = 100.0 mm (6 elements: 16.667 mm each)
        for (int i = 1; i <= 6; ++i) {
            st.push_back(tw + i * (0.100 / 6.0));
        }

        // 5. Interior 125mm Rebar Bays from 0.250m to 1.750m (12 bays)
        // Each 125mm bay divided into 8 elements: 15.625 mm each
        int num_interior_bays = int(round((L - 2.0 * 0.250) / pitch)); // (2.0 - 0.50) / 0.125 = 12
        for (int b = 0; b < num_interior_bays; ++b) {
            double bay_start = 0.250 + b * pitch;
            for (int sub = 1; sub <= 8; ++sub) {
                st.push_back(bay_start + sub * (pitch / 8.0));
            }
        }

        // 6. Transition from last interior rebar station (1.750m) to opposite wall boundary (1.850m)
        // Span = 100.0 mm (6 elements: 16.667 mm each)
        for (int i = 1; i <= 6; ++i) {
            st.push_back(1.750 + i * (0.100 / 6.0));
        }

        // --- Wall 2: [1.850 ... 2.000m] ---
        // 7. Wall 2 Inner Cover: [1.850 ... 1.875m] (1 element: 25.0 mm)
        st.push_back(L - (tw - cov));

        // 8. Wall 2 Core: [1.875 ... 1.975m] (6 elements: 16.667 mm each)
        for (int i = 1; i <= 6; ++i) {
            st.push_back((L - tw + cov) + i * ((tw - 2.0 * cov) / 6.0));
        }

        // 9. Wall 2 Outer Cover: [1.975 ... 2.000m] (1 element: 25.0 mm)
        st.push_back(L);

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

    std::vector<double> xs = build_stations(Lx, t_wall, cover, rebar_pitch);
    std::vector<double> ys = build_stations(Ly, t_wall, cover, rebar_pitch);
    std::vector<double> zs = build_stations(Lz, t_wall, cover, rebar_pitch);

    int Nx = int(xs.size()) - 1;
    int Ny = int(ys.size()) - 1;
    int Nz = int(zs.size()) - 1;

    // Check minimum and maximum element size across stations
    double actual_min_h = 1e30, actual_max_h = 0.0;
    for (int i = 0; i < Nx; ++i) {
        double h = xs[i+1] - xs[i];
        actual_min_h = std::min(actual_min_h, h);
        actual_max_h = std::max(actual_max_h, h);
    }

    std::cout << "Grid Resolution: Nx=" << Nx << ", Ny=" << Ny << ", Nz=" << Nz << " (Total Grid: " << Nx * Ny * Nz << ")" << std::endl;
    std::cout << "Actual Element Edge Length Range: [" << actual_min_h * 1000.0 << " mm, " << actual_max_h * 1000.0 << " mm]" << std::endl;
    assert(actual_min_h >= min_elem_target - 1e-6);

    // 2. Identify Solid Concrete Cells
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
    std::cout << "Solid Concrete Hex8 Elements: " << solid_cells.size() << std::endl;

    // 3. Register Nodes
    std::unordered_map<GridCoord, int, GridCoordHash> coord_to_node_id;
    std::vector<Vec3> nodes;

    for (const auto& cell : solid_cells) {
        for (int di = 0; di <= 1; ++di) {
            for (int dj = 0; dj <= 1; ++dj) {
                for (int dk = 0; dk <= 1; ++dk) {
                    GridCoord gc = {cell.i + di, cell.j + dj, cell.k + dk};
                    if (coord_to_node_id.find(gc) == coord_to_node_id.end()) {
                        int nid = int(nodes.size()) + 1;
                        coord_to_node_id[gc] = nid;
                        nodes.push_back({xs[gc.i], ys[gc.j], zs[gc.k]});
                    }
                }
            }
        }
    }

    std::cout << "Unique Concrete Mesh Nodes: " << nodes.size() << std::endl;

    // 4. Construct Regular Hex8 Elements
    std::vector<HexElement> hex_elements;
    hex_elements.reserve(solid_cells.size());
    int hex_eid = 1;

    for (const auto& cell : solid_cells) {
        int n0 = coord_to_node_id[{cell.i, cell.j, cell.k}];
        int n1 = coord_to_node_id[{cell.i + 1, cell.j, cell.k}];
        int n2 = coord_to_node_id[{cell.i + 1, cell.j + 1, cell.k}];
        int n3 = coord_to_node_id[{cell.i, cell.j + 1, cell.k}];
        int n4 = coord_to_node_id[{cell.i, cell.j, cell.k + 1}];
        int n5 = coord_to_node_id[{cell.i + 1, cell.j, cell.k + 1}];
        int n6 = coord_to_node_id[{cell.i + 1, cell.j + 1, cell.k + 1}];
        int n7 = coord_to_node_id[{cell.i, cell.j + 1, cell.k + 1}];

        hex_elements.push_back({hex_eid++, 1, {n0, n1, n2, n3, n4, n5, n6, n7}});
    }

    // 5. Construct Conforming 125mm Rebar Cage on Shared Nodes
    const std::vector<double> curtain_x = {cover, t_wall - cover, Lx - (t_wall - cover), Lx - cover};
    const std::vector<double> curtain_y = {cover, t_wall - cover, Ly - (t_wall - cover), Ly - cover};
    const std::vector<double> curtain_z = {cover, t_wall - cover, Lz - (t_wall - cover), Lz - cover};

    std::vector<double> grid_125mm;
    grid_125mm.push_back(cover);
    grid_125mm.push_back(t_wall - cover);
    for (int i = 2; i <= 14; ++i) {
        grid_125mm.push_back(round(i * rebar_pitch * 1e6) / 1e6);
    }
    grid_125mm.push_back(Lx - (t_wall - cover));
    grid_125mm.push_back(Lx - cover);

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

    // A. X-direction rebar lines
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
                    if (coord_to_node_id.count(c1) && coord_to_node_id.count(c2)) {
                        add_beam_edge(coord_to_node_id[c1], coord_to_node_id[c2]);
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
                    if (coord_to_node_id.count(c1) && coord_to_node_id.count(c2)) {
                        add_beam_edge(coord_to_node_id[c1], coord_to_node_id[c2]);
                    }
                }
            }
        }
    }

    // B. Y-direction rebar lines
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
                    if (coord_to_node_id.count(c1) && coord_to_node_id.count(c2)) {
                        add_beam_edge(coord_to_node_id[c1], coord_to_node_id[c2]);
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
                    if (coord_to_node_id.count(c1) && coord_to_node_id.count(c2)) {
                        add_beam_edge(coord_to_node_id[c1], coord_to_node_id[c2]);
                    }
                }
            }
        }
    }

    // C. Z-direction rebar lines
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
                    if (coord_to_node_id.count(c1) && coord_to_node_id.count(c2)) {
                        add_beam_edge(coord_to_node_id[c1], coord_to_node_id[c2]);
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
                    if (coord_to_node_id.count(c1) && coord_to_node_id.count(c2)) {
                        add_beam_edge(coord_to_node_id[c1], coord_to_node_id[c2]);
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
                        if (coord_to_node_id.count(c1) && coord_to_node_id.count(c2)) {
                            add_beam_edge(coord_to_node_id[c1], coord_to_node_id[c2]);
                        }
                    }
                    if (xs[i] >= Lx - t_wall + cover - eps && xs[i+1] <= Lx - cover + eps) {
                        GridCoord c1 = {i, j_idx, k_idx};
                        GridCoord c2 = {i + 1, j_idx, k_idx};
                        if (coord_to_node_id.count(c1) && coord_to_node_id.count(c2)) {
                            add_beam_edge(coord_to_node_id[c1], coord_to_node_id[c2]);
                        }
                    }
                }
            }
        }
    }

    std::cout << "Generated " << rebar_beams.size() << " Conforming Rebar Beam Elements (Exact 125mm Spacing)" << std::endl;

    // 6. Base Fixed SPC Nodes (Y = 0)
    std::vector<int> spc_nodes;
    for (size_t i = 0; i < nodes.size(); ++i) {
        if (std::abs(nodes[i].y) < eps) {
            spc_nodes.push_back(int(i) + 1);
        }
    }
    std::cout << "Fixed Base SPC Nodes (Y = 0.0m): " << spc_nodes.size() << std::endl;

    // 7. Write LS-DYNA Keyword Deck
    std::cout << "Streaming deck to " << out_filename << "..." << std::endl;
    std::ofstream out(out_filename, std::ios::out | std::ios::trunc);
    if (!out.is_open()) return 1;

    out << "$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$\n";
    out << "$ LS-DYNA KEYWORD DECK: REGULAR STRUCTURED RC HOLLOW BOX (2M, MIN 15MM ELEMENTS)\n";
    out << "$ Reinforcement: EXACT 125mm c/c Dual-Layer Curtain with Ties on Shared Hex Nodes\n";
    out << "$ Statistics: " << nodes.size() << " Nodes, " << hex_elements.size() << " Solid Hex8, " << rebar_beams.size() << " Beams\n";
    out << "$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$\n";
    out << "*KEYWORD\n";
    out << "*TITLE\n";
    out << "Regular Structured RC Hollow Box 2m (Min 15mm Hexes, 125mm Rebar)\n";

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
    out << "Concrete Hollow Box (Regular Hex8 CSCM)\n";
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
    char buf[128];
    out << "*NODE\n";
    for (size_t i = 0; i < nodes.size(); ++i) {
        snprintf(buf, sizeof(buf), "%8d%16.6f%16.6f%16.6f%8d%8d\n", int(i) + 1, nodes[i].x, nodes[i].y, nodes[i].z, 0, 0);
        out << buf;
    }

    // Solids
    out << "*ELEMENT_SOLID\n";
    for (const auto& h : hex_elements) {
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

    // Export VTK files
    {
        std::ofstream vtk("regular_concrete_15mm.vtk");
        vtk << "# vtk DataFile Version 3.0\nRegular Concrete 15mm (Min 15mm)\nASCII\nDATASET UNSTRUCTURED_GRID\n";
        vtk << "POINTS " << nodes.size() << " float\n";
        for (const auto& p : nodes) vtk << float(p.x) << " " << float(p.y) << " " << float(p.z) << "\n";
        vtk << "\nCELLS " << hex_elements.size() << " " << hex_elements.size() * 9 << "\n";
        for (const auto& h : hex_elements) {
            vtk << "8 " << h.n[0]-1 << " " << h.n[1]-1 << " " << h.n[2]-1 << " " << h.n[3]-1
                << " " << h.n[4]-1 << " " << h.n[5]-1 << " " << h.n[6]-1 << " " << h.n[7]-1 << "\n";
        }
        vtk << "\nCELL_TYPES " << hex_elements.size() << "\n";
        for (size_t i = 0; i < hex_elements.size(); ++i) vtk << "12\n";
    }
    {
        std::ofstream vtk("regular_rebar_15mm.vtk");
        vtk << "# vtk DataFile Version 3.0\nRegular Rebar 15mm\nASCII\nDATASET UNSTRUCTURED_GRID\n";
        vtk << "POINTS " << nodes.size() << " float\n";
        for (const auto& p : nodes) vtk << float(p.x) << " " << float(p.y) << " " << float(p.z) << "\n";
        vtk << "\nCELLS " << rebar_beams.size() << " " << rebar_beams.size() * 3 << "\n";
        for (const auto& b : rebar_beams) vtk << "2 " << b.n1-1 << " " << b.n2-1 << "\n";
        vtk << "\nCELL_TYPES " << rebar_beams.size() << "\n";
        for (size_t i = 0; i < rebar_beams.size(); ++i) vtk << "3\n";
    }

    auto t_end = std::chrono::high_resolution_clock::now();
    double elapsed_ms = std::chrono::duration<double, std::milli>(t_end - t_start).count();

    std::cout << "======================================================================" << std::endl;
    std::cout << "✓ Successfully generated " << out_filename << " in " << elapsed_ms << " ms!" << std::endl;
    std::cout << "======================================================================" << std::endl;

    return 0;
}
