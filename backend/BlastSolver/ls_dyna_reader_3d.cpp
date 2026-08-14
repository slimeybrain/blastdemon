#include "ls_dyna_reader_3d.hpp"
#include <fstream>
#include <iostream>
#include <sstream>
#include <algorithm>
#include <cctype>
#include <cstring>

namespace Blast {

template <typename T>
std::string LSDynaReader3D<T>::trim(const std::string& str) const {
    size_t first = str.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return "";
    size_t last = str.find_last_not_of(" \t\r\n");
    return str.substr(first, (last - first + 1));
}

template <typename T>
std::vector<std::string> LSDynaReader3D<T>::splitLine(const std::string& line) const {
    std::vector<std::string> tokens;
    if (line.find(',') != std::string::npos) {
        // Comma-delimited free format
        std::stringstream ss(line);
        std::string token;
        while (std::getline(ss, token, ',')) {
            tokens.push_back(trim(token));
        }
    } else {
        // Whitespace free-format
        std::stringstream ss(line);
        std::string token;
        while (ss >> token) {
            tokens.push_back(trim(token));
        }
    }
    return tokens;
}

template <typename T>
T LSDynaReader3D<T>::parseFieldVal(const std::string& line, int field_idx, T default_val) const {
    std::vector<std::string> tokens = splitLine(line);
    if (field_idx >= 0 && field_idx < static_cast<int>(tokens.size()) && !tokens[field_idx].empty()) {
        try { return static_cast<T>(std::stod(tokens[field_idx])); } catch (...) {}
    }
    // Fixed 10-character columns fallback (for fixed-format cards with blank fields)
    size_t start = field_idx * 10;
    if (start < line.length()) {
        std::string sub = trim(line.substr(start, std::min<size_t>(10, line.length() - start)));
        if (!sub.empty()) {
            try { return static_cast<T>(std::stod(sub)); } catch (...) {}
        }
    }
    return default_val;
}

template <typename T>
bool LSDynaReader3D<T>::parseStream(
    const std::string& filepath,
    std::vector<FEMNode3D<T>>& out_nodes,
    std::vector<FEMElement3D<T>>& out_elements,
    MaterialTable3D& out_default_mat,
    std::vector<MaterialTable3D>& out_materials,
    int depth
) {
    if (depth > 10) {
        std::cerr << "[LSDynaReader3D] Exceeded maximum *INCLUDE recursion depth at " << filepath << std::endl;
        return false;
    }

    std::ifstream file(filepath);
    if (!file.is_open()) {
        std::cerr << "[LSDynaReader3D] Failed to open keyword file: " << filepath << std::endl;
        return false;
    }

    std::string line;
    std::string current_keyword = "";

    while (std::getline(file, line)) {
        std::string trimmed = trim(line);
        if (trimmed.empty() || trimmed[0] == '$') continue; // Skip comments and empty lines

        if (trimmed[0] == '*') {
            // Transform keyword to uppercase
            current_keyword = trimmed;
            std::transform(current_keyword.begin(), current_keyword.end(), current_keyword.begin(), ::toupper);
            continue;
        }

        // Handle Keyword Block Content
        if (current_keyword.rfind("*NODE", 0) == 0) {
            if (current_keyword.rfind("*NODE_TITLE", 0) == 0) {
                // Consume title line
                std::getline(file, line);
                current_keyword = "*NODE";
                continue;
            }

            int64_t node_id = static_cast<int64_t>(parseFieldVal(line, 0, 0.0f));
            if (node_id <= 0) continue;

            T x = parseFieldVal(line, 1, 0.0f);
            T y = parseFieldVal(line, 2, 0.0f);
            T z = parseFieldVal(line, 3, 0.0f);

            if (m_id_to_node_index.find(node_id) == m_id_to_node_index.end()) {
                int new_idx = static_cast<int>(out_nodes.size());
                m_id_to_node_index[node_id] = new_idx;

                FEMNode3D<T> node{};
                node.x[0] = x; node.x[1] = y; node.x[2] = z;
                node.lsdyna_id = node_id;
                out_nodes.push_back(node);
            }
        } else if (current_keyword.rfind("*ELEMENT_SOLID", 0) == 0) {
            if (current_keyword.rfind("*ELEMENT_SOLID_TITLE", 0) == 0) {
                std::getline(file, line);
                current_keyword = "*ELEMENT_SOLID";
                continue;
            }

            int64_t elem_id = static_cast<int64_t>(parseFieldVal(line, 0, 0.0f));
            int part_id = static_cast<int>(parseFieldVal(line, 1, 1.0f));
            if (elem_id <= 0) continue;

            int64_t n1 = static_cast<int64_t>(parseFieldVal(line, 2, 0.0f));
            int64_t n2 = static_cast<int64_t>(parseFieldVal(line, 3, 0.0f));
            int64_t n3 = static_cast<int64_t>(parseFieldVal(line, 4, 0.0f));
            int64_t n4 = static_cast<int64_t>(parseFieldVal(line, 5, 0.0f));
            int64_t n5 = static_cast<int64_t>(parseFieldVal(line, 6, 0.0f));
            int64_t n6 = static_cast<int64_t>(parseFieldVal(line, 7, 0.0f));
            int64_t n7 = static_cast<int64_t>(parseFieldVal(line, 8, 0.0f));
            int64_t n8 = static_cast<int64_t>(parseFieldVal(line, 9, 0.0f));

            if (m_id_to_node_index.count(n1) && m_id_to_node_index.count(n2) &&
                m_id_to_node_index.count(n3) && m_id_to_node_index.count(n4)) {

                FEMElement3D<T> elem{};
                elem.node_ids[0] = m_id_to_node_index[n1];
                elem.node_ids[1] = m_id_to_node_index[n2];
                elem.node_ids[2] = m_id_to_node_index[n3];
                elem.node_ids[3] = m_id_to_node_index[n4];
                elem.node_ids[4] = m_id_to_node_index[n5 > 0 ? n5 : n4];
                elem.node_ids[5] = m_id_to_node_index[n6 > 0 ? n6 : n4];
                elem.node_ids[6] = m_id_to_node_index[n7 > 0 ? n7 : n4];
                elem.node_ids[7] = m_id_to_node_index[n8 > 0 ? n8 : n4];

                elem.lsdyna_id = elem_id;
                elem.part_id = part_id;
                elem.mat_id = 0;

                std::memset(elem.F, 0, sizeof(elem.F));
                elem.F[0][0] = 1.0f; elem.F[1][1] = 1.0f; elem.F[2][2] = 1.0f;
                std::memset(elem.sigma, 0, sizeof(elem.sigma));

                m_id_to_elem_index[elem_id] = static_cast<int>(out_elements.size());
                out_elements.push_back(elem);
            }
        } else if (current_keyword.rfind("*MAT_ELASTIC", 0) == 0 || current_keyword.rfind("*MAT_001", 0) == 0) {
            // Card 1: MID, RO, E, PR
            T mid = parseFieldVal(line, 0, 1.0f);
            T ro = parseFieldVal(line, 1, 7850.0f);
            T e = parseFieldVal(line, 2, 210.0e9f);
            T pr = parseFieldVal(line, 3, 0.30f);

            out_default_mat.density = static_cast<float>(ro);
            out_default_mat.youngs_modulus = static_cast<float>(e);
            out_default_mat.poissons_ratio = static_cast<float>(pr);
        } else if (current_keyword.rfind("*MAT_JOHNSON_COOK", 0) == 0 || current_keyword.rfind("*MAT_015", 0) == 0) {
            // Card 1: MID, RO, E, PR, A, B, N, C
            out_default_mat.material_model = MPMMaterialModel::JohnsonCookMieGruneisen;
            out_default_mat.density = static_cast<float>(parseFieldVal(line, 1, 7850.0f));
            out_default_mat.youngs_modulus = static_cast<float>(parseFieldVal(line, 2, 210.0e9f));
            out_default_mat.poissons_ratio = static_cast<float>(parseFieldVal(line, 3, 0.30f));
            out_default_mat.jc_A = static_cast<float>(parseFieldVal(line, 4, 792.0e6f));
            out_default_mat.jc_B = static_cast<float>(parseFieldVal(line, 5, 510.0e6f));
            out_default_mat.jc_n = static_cast<float>(parseFieldVal(line, 6, 0.26f));
            out_default_mat.jc_C = static_cast<float>(parseFieldVal(line, 7, 0.014f));

            // Card 2: M, TM, TR, CP, PC, SPALL, ...
            std::streampos pos = file.tellg();
            std::string line2;
            while (std::getline(file, line2)) {
                std::string trimmed2 = trim(line2);
                if (trimmed2.empty()) continue;
                if (trimmed2[0] == '$') continue;
                if (trimmed2[0] == '*') {
                    file.seekg(pos);
                    break;
                }
                out_default_mat.jc_m = static_cast<float>(parseFieldVal(line2, 0, 1.03f));
                out_default_mat.T_melt = static_cast<float>(parseFieldVal(line2, 1, 1793.0f));
                out_default_mat.T_room = static_cast<float>(parseFieldVal(line2, 2, 293.0f));
                out_default_mat.Cp = static_cast<float>(parseFieldVal(line2, 3, 477.0f));
                T spall = parseFieldVal(line2, 5, 0.0f);
                if (spall > 0.0f) out_default_mat.tensile_failure_stress = static_cast<float>(spall);
                break;
            }
        } else if (current_keyword.rfind("*EOS_GRUNEISEN", 0) == 0 || current_keyword.rfind("*EOS_004", 0) == 0) {
            // Card 1: EOSID, C, S1, S2, S3, GAMAO, A, E0
            out_default_mat.mg_c0 = static_cast<float>(parseFieldVal(line, 1, 4570.0f));
            out_default_mat.mg_s = static_cast<float>(parseFieldVal(line, 2, 1.49f));
            out_default_mat.mg_gamma0 = static_cast<float>(parseFieldVal(line, 5, 1.81f));
        } else if (current_keyword.rfind("*MAT_ADD_EROSION", 0) == 0) {
            // Card 1: MID, EXFAIL, MXEPS, EPSTH, SIGP1, SIGVM, ...
            T exf = parseFieldVal(line, 1, 0.0f);
            T sigp1 = parseFieldVal(line, 4, 0.0f);
            if (exf > 0.0f) out_default_mat.failure_strain = static_cast<float>(exf);
            if (sigp1 > 0.0f) out_default_mat.tensile_failure_stress = static_cast<float>(sigp1);
        } else if (current_keyword.rfind("*INITIAL_VELOCITY", 0) == 0) {
            int64_t node_id = static_cast<int64_t>(parseFieldVal(line, 0, 0.0f));
            T vx = parseFieldVal(line, 1, 0.0f);
            T vy = parseFieldVal(line, 2, 0.0f);
            T vz = parseFieldVal(line, 3, 0.0f);

            if (m_id_to_node_index.count(node_id)) {
                int idx = m_id_to_node_index[node_id];
                out_nodes[idx].v[0] = vx;
                out_nodes[idx].v[1] = vy;
                out_nodes[idx].v[2] = vz;
            }
        } else if (current_keyword.rfind("*BOUNDARY_SPC_NODE", 0) == 0) {
            int64_t node_id = static_cast<int64_t>(parseFieldVal(line, 0, 0.0f));
            int dofx = static_cast<int>(parseFieldVal(line, 2, 0.0f));
            int dofy = static_cast<int>(parseFieldVal(line, 3, 0.0f));
            int dofz = static_cast<int>(parseFieldVal(line, 4, 0.0f));

            if (m_id_to_node_index.count(node_id)) {
                int idx = m_id_to_node_index[node_id];
                out_nodes[idx].is_fixed[0] = (dofx != 0);
                out_nodes[idx].is_fixed[1] = (dofy != 0);
                out_nodes[idx].is_fixed[2] = (dofz != 0);
            }
        } else if (current_keyword.rfind("*INCLUDE", 0) == 0) {
            std::string inc_file = trim(line);
            if (!inc_file.empty()) {
                parseStream(inc_file, out_nodes, out_elements, out_default_mat, out_materials, depth + 1);
            }
        }
    }

    return true;
}

template <typename T>
bool LSDynaReader3D<T>::parseFile(
    const std::string& filepath,
    std::vector<FEMNode3D<T>>& out_nodes,
    std::vector<FEMElement3D<T>>& out_elements,
    MaterialTable3D& out_default_mat,
    std::vector<MaterialTable3D>& out_materials
) {
    m_id_to_node_index.clear();
    m_id_to_elem_index.clear();

    return parseStream(filepath, out_nodes, out_elements, out_default_mat, out_materials, 0);
}

// Explicit Instantiations
template class LSDynaReader3D<float>;
template class LSDynaReader3D<double>;

} // namespace Blast
