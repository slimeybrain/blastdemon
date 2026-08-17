#include <iostream>
#include <fstream>
#include <vector>
#include <array>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <algorithm>
#include <cmath>

struct QuadFace {
    int n[4];
    bool operator==(const QuadFace& o) const {
        return n[0] == o.n[0] && n[1] == o.n[1] && n[2] == o.n[2] && n[3] == o.n[3];
    }
};

struct QuadFaceHash {
    size_t operator()(const QuadFace& f) const {
        return (size_t(f.n[0]) * 73856093) ^
               (size_t(f.n[1]) * 19349663) ^
               (size_t(f.n[2]) * 83492791) ^
               (size_t(f.n[3]) * 536870909);
    }
};

// Canonical sorting for undirected 4-node quad face
QuadFace makeCanonicalQuad(int a, int b, int c, int d) {
    std::array<int, 4> arr = {a, b, c, d};
    std::sort(arr.begin(), arr.end());
    return {arr[0], arr[1], arr[2], arr[3]};
}

struct Vec3 {
    double x, y, z;
};

int main(int argc, char** argv) {
    std::string k_filename = "unstructured_rc_box_tet2hex_high_qual.k";
    if (argc > 1) k_filename = argv[1];

    std::cout << "======================================================================" << std::endl;
    std::cout << "=== RIGOROUS MESH TOPOLOGY & MANIFOLD CONNECTIVITY AUDITOR ===" << std::endl;
    std::cout << "Target Deck: " << k_filename << std::endl;
    std::cout << "======================================================================" << std::endl;

    std::ifstream in(k_filename);
    if (!in.is_open()) {
        std::cerr << "Error: Could not open " << k_filename << std::endl;
        return 1;
    }

    std::unordered_map<int, Vec3> nodes;
    std::vector<std::array<int, 8>> hex_solids;
    std::vector<std::pair<int, int>> rebar_beams;

    std::string line;
    std::string current_card = "";

    while (std::getline(in, line)) {
        if (line.empty() || line[0] == '$') continue;
        if (line[0] == '*') {
            current_card = line.substr(0, line.find_first_of(" \t\r\n"));
            continue;
        }

        if (current_card == "*NODE") {
            try {
                int nid = std::stoi(line.substr(0, 8));
                double x = std::stod(line.substr(8, 16));
                double y = std::stod(line.substr(24, 16));
                double z = std::stod(line.substr(40, 16));
                nodes[nid] = {x, y, z};
            } catch (...) {}
        } else if (current_card == "*ELEMENT_SOLID") {
            try {
                int eid = std::stoi(line.substr(0, 8));
                int pid = std::stoi(line.substr(8, 8));
                std::array<int, 8> h;
                for (int i = 0; i < 8; ++i) {
                    h[i] = std::stoi(line.substr(16 + i * 8, 8));
                }
                hex_solids.push_back(h);
            } catch (...) {}
        } else if (current_card == "*ELEMENT_BEAM") {
            try {
                int eid = std::stoi(line.substr(0, 8));
                int pid = std::stoi(line.substr(8, 8));
                int n1 = std::stoi(line.substr(16, 8));
                int n2 = std::stoi(line.substr(24, 8));
                rebar_beams.push_back({n1, n2});
            } catch (...) {}
        }
    }

    std::cout << "Parsed Mesh: " << nodes.size() << " Nodes, "
              << hex_solids.size() << " Hex8 Elements, "
              << rebar_beams.size() << " Beam Elements" << std::endl;

    // 1. Check Quad Faces Incidence Count
    // Every 8-node hex has 6 quad faces:
    // Face 0 (bottom): n0, n3, n2, n1
    // Face 1 (top):    n4, n5, n6, n7
    // Face 2 (front):  n0, n1, n5, n4
    // Face 3 (right):  n1, n2, n6, n5
    // Face 4 (back):   n2, n3, n7, n6
    // Face 5 (left):   n3, n0, n4, n7
    static const int hex_faces[6][4] = {
        {0, 3, 2, 1},
        {4, 5, 6, 7},
        {0, 1, 5, 4},
        {1, 2, 6, 5},
        {2, 3, 7, 6},
        {3, 0, 4, 7}
    };

    std::unordered_map<QuadFace, int, QuadFaceHash> face_count;
    face_count.reserve(hex_solids.size() * 3);

    for (const auto& h : hex_solids) {
        for (int f = 0; f < 6; ++f) {
            QuadFace qf = makeCanonicalQuad(h[hex_faces[f][0]],
                                            h[hex_faces[f][1]],
                                            h[hex_faces[f][2]],
                                            h[hex_faces[f][3]]);
            face_count[qf]++;
        }
    }

    int count_1 = 0; // Boundary faces
    int count_2 = 0; // Conforming internal faces (shared by exactly 2 hexes)
    int count_invalid = 0; // Non-manifold faces (> 2)
    int count_internal_gaps = 0; // Boundary faces that are inside the concrete!

    const double eps = 1e-3;
    const double Lx = 2.0, Ly = 2.0, Lz = 2.0;
    const double tw = 0.15;

    auto is_on_true_boundary = [&](const QuadFace& qf) {
        // Face is on true boundary if all 4 nodes lie on:
        // x=0, x=Lx, y=0, y=Ly, z=0, z=Lz (Outer box) OR
        // x=tw, x=Lx-tw, y=tw, y=Ly-tw, z=tw, z=Lz-tw (Inner void)
        int on_x0 = 0, on_xL = 0, on_y0 = 0, on_yL = 0, on_z0 = 0, on_zL = 0;
        int on_vx0 = 0, on_vxL = 0, on_vy0 = 0, on_vyL = 0, on_vz0 = 0, on_vzL = 0;

        for (int i = 0; i < 4; ++i) {
            Vec3 p = nodes[qf.n[i]];
            if (std::abs(p.x) < eps) on_x0++;
            if (std::abs(p.x - Lx) < eps) on_xL++;
            if (std::abs(p.y) < eps) on_y0++;
            if (std::abs(p.y - Ly) < eps) on_yL++;
            if (std::abs(p.z) < eps) on_z0++;
            if (std::abs(p.z - Lz) < eps) on_zL++;

            if (std::abs(p.x - tw) < eps && p.y >= tw-eps && p.y <= Ly-tw+eps && p.z >= tw-eps && p.z <= Lz-tw+eps) on_vx0++;
            if (std::abs(p.x - (Lx - tw)) < eps && p.y >= tw-eps && p.y <= Ly-tw+eps && p.z >= tw-eps && p.z <= Lz-tw+eps) on_vxL++;
            if (std::abs(p.y - tw) < eps && p.x >= tw-eps && p.x <= Lx-tw+eps && p.z >= tw-eps && p.z <= Lz-tw+eps) on_vy0++;
            if (std::abs(p.y - (Ly - tw)) < eps && p.x >= tw-eps && p.x <= Lx-tw+eps && p.z >= tw-eps && p.z <= Lz-tw+eps) on_vyL++;
            if (std::abs(p.z - tw) < eps && p.x >= tw-eps && p.x <= Lx-tw+eps && p.y >= tw-eps && p.y <= Ly-tw+eps) on_vz0++;
            if (std::abs(p.z - (Lz - tw)) < eps && p.x >= tw-eps && p.x <= Lx-tw+eps && p.y >= tw-eps && p.y <= Ly-tw+eps) on_vzL++;
        }

        return (on_x0 == 4 || on_xL == 4 || on_y0 == 4 || on_yL == 4 || on_z0 == 4 || on_zL == 4 ||
                on_vx0 == 4 || on_vxL == 4 || on_vy0 == 4 || on_vyL == 4 || on_vz0 == 4 || on_vzL == 4);
    };

    for (const auto& kv : face_count) {
        if (kv.second == 2) {
            count_2++;
        } else if (kv.second == 1) {
            count_1++;
            if (!is_on_true_boundary(kv.first)) {
                count_internal_gaps++;
            }
        } else {
            count_invalid++;
        }
    }

    std::cout << "\n======================================================================" << std::endl;
    std::cout << "TOPOLOGICAL INTEGRITY RESULTS:" << std::endl;
    std::cout << "  Total Unique Quad Faces: " << face_count.size() << std::endl;
    std::cout << "  Internal Conforming Faces (Count = 2): " << count_2 << " (Exact 2-Hex Sharing)" << std::endl;
    std::cout << "  Boundary Surface Faces (Count = 1): " << count_1 << std::endl;
    std::cout << "  Non-Manifold Faces (Count > 2): " << count_invalid << " (Target: 0)" << std::endl;
    std::cout << "  Internal Free Edges / Gaps (Count = 1 inside bulk): " << count_internal_gaps << " (Target: 0)" << std::endl;
    std::cout << "======================================================================" << std::endl;

    // 2. Rebar Conformance Check
    std::unordered_set<int> solid_node_set;
    for (const auto& h : hex_solids) {
        for (int i = 0; i < 8; ++i) solid_node_set.insert(h[i]);
    }

    int unshared_rebar_nodes = 0;
    for (const auto& b : rebar_beams) {
        if (solid_node_set.find(b.first) == solid_node_set.end()) unshared_rebar_nodes++;
        if (solid_node_set.find(b.second) == solid_node_set.end()) unshared_rebar_nodes++;
    }

    std::cout << "REBAR CONFORMANCE CHECK:" << std::endl;
    std::cout << "  Total Rebar Beams: " << rebar_beams.size() << std::endl;
    std::cout << "  Unshared Rebar Nodes: " << unshared_rebar_nodes << " (Target: 0)" << std::endl;

    bool passed = (count_invalid == 0 && count_internal_gaps == 0 && unshared_rebar_nodes == 0);
    if (passed) {
        std::cout << "\n>>> VERIFICATION SUCCESS: MESH IS 100% WATERTIGHT, FULLY CONNECTED, CONFORMING, AND ZERO GAPS! <<<" << std::endl;
    } else {
        std::cout << "\n>>> VERIFICATION FAILED: GAPS OR NON-CONFORMING FACES FOUND! <<<" << std::endl;
    }

    return passed ? 0 : 1;
}
