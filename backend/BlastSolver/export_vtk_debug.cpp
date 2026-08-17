#include <iostream>
#include <fstream>
#include <vector>
#include <array>
#include <string>
#include <unordered_map>
#include <unordered_set>

struct Vec3 { double x, y, z; };

int main() {
    std::string k_filename = "unstructured_rc_box_tet2hex_high_qual.k";
    std::ifstream in(k_filename);
    if (!in.is_open()) return 1;

    std::vector<Vec3> nodes;
    std::vector<std::array<int, 8>> hex_solids;
    std::vector<std::pair<int, int>> rebar_beams;

    std::string line, current_card = "";
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
                if (int(nodes.size()) < nid) nodes.resize(nid);
                nodes[nid - 1] = {x, y, z};
            } catch (...) {}
        } else if (current_card == "*ELEMENT_SOLID") {
            try {
                int eid = std::stoi(line.substr(0, 8));
                int pid = std::stoi(line.substr(8, 8));
                std::array<int, 8> h;
                for (int i = 0; i < 8; ++i) {
                    h[i] = std::stoi(line.substr(16 + i * 8, 8)) - 1; // 0-based
                }
                hex_solids.push_back(h);
            } catch (...) {}
        } else if (current_card == "*ELEMENT_BEAM") {
            try {
                int eid = std::stoi(line.substr(0, 8));
                int pid = std::stoi(line.substr(8, 8));
                int n1 = std::stoi(line.substr(16, 8)) - 1;
                int n2 = std::stoi(line.substr(24, 8)) - 1;
                rebar_beams.push_back({n1, n2});
            } catch (...) {}
        }
    }

    std::cout << "Parsed " << nodes.size() << " nodes, " << hex_solids.size() << " hexes, " << rebar_beams.size() << " beams." << std::endl;

    // Export VTK Unstructured Grid (.vtu or legacy .vtk) for Concrete Solids
    {
        std::ofstream vtk("concrete_solids_only.vtk");
        vtk << "# vtk DataFile Version 3.0\n";
        vtk << "Concrete Solids Only\n";
        vtk << "ASCII\n";
        vtk << "DATASET UNSTRUCTURED_GRID\n";
        vtk << "POINTS " << nodes.size() << " float\n";
        for (const auto& p : nodes) {
            vtk << float(p.x) << " " << float(p.y) << " " << float(p.z) << "\n";
        }
        vtk << "\nCELLS " << hex_solids.size() << " " << hex_solids.size() * 9 << "\n";
        for (const auto& h : hex_solids) {
            vtk << "8 " << h[0] << " " << h[1] << " " << h[2] << " " << h[3]
                << " " << h[4] << " " << h[5] << " " << h[6] << " " << h[7] << "\n";
        }
        vtk << "\nCELL_TYPES " << hex_solids.size() << "\n";
        for (size_t i = 0; i < hex_solids.size(); ++i) {
            vtk << "12\n"; // VTK_HEXAHEDRON
        }
        std::cout << "Exported concrete_solids_only.vtk" << std::endl;
    }

    // Export VTK for Rebar Beams Only
    {
        std::ofstream vtk("rebar_beams_only.vtk");
        vtk << "# vtk DataFile Version 3.0\n";
        vtk << "Rebar Beams Only\n";
        vtk << "ASCII\n";
        vtk << "DATASET UNSTRUCTURED_GRID\n";
        vtk << "POINTS " << nodes.size() << " float\n";
        for (const auto& p : nodes) {
            vtk << float(p.x) << " " << float(p.y) << " " << float(p.z) << "\n";
        }
        vtk << "\nCELLS " << rebar_beams.size() << " " << rebar_beams.size() * 3 << "\n";
        for (const auto& b : rebar_beams) {
            vtk << "2 " << b.first << " " << b.second << "\n";
        }
        vtk << "\nCELL_TYPES " << rebar_beams.size() << "\n";
        for (size_t i = 0; i < rebar_beams.size(); ++i) {
            vtk << "3\n"; // VTK_LINE
        }
        std::cout << "Exported rebar_beams_only.vtk" << std::endl;
    }

    return 0;
}
