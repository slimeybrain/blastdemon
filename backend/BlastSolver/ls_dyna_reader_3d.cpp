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
void LSDynaReader3D<T>::tokenizeLine(const std::string& line, TokenBuffer& tb) const {
    tb.count = 0;
    size_t len = line.length();
    if (len == 0) return;

    if (line.find(',') != std::string::npos) {
        // Comma-delimited free format
        size_t start = 0;
        while (start < len && tb.count < 16) {
            size_t comma = line.find(',', start);
            size_t end = (comma == std::string::npos) ? len : comma;
            size_t s = start;
            while (s < end && (line[s] == ' ' || line[s] == '\t' || line[s] == '\r')) s++;
            size_t e = end;
            while (e > s && (line[e - 1] == ' ' || line[e - 1] == '\t' || line[e - 1] == '\r')) e--;
            tb.tokens[tb.count++] = std::string_view(line.data() + s, e - s);
            if (comma == std::string::npos) break;
            start = comma + 1;
        }
    } else {
        // Whitespace / fixed-width free-format (also split touching numbers like -1.23E+02-4.56E+01)
        size_t i = 0;
        while (i < len && tb.count < 16) {
            while (i < len && (line[i] == ' ' || line[i] == '\t' || line[i] == '\r')) i++;
            if (i >= len) break;
            size_t start = i;
            i++;
            while (i < len && line[i] != ' ' && line[i] != '\t' && line[i] != '\r') {
                if ((line[i] == '-' || line[i] == '+') && i > start) {
                    char prev = line[i - 1];
                    if (prev != 'e' && prev != 'E' && prev != 'd' && prev != 'D') {
                        break;
                    }
                }
                i++;
            }
            tb.tokens[tb.count++] = std::string_view(line.data() + start, i - start);
        }
    }
}

template <typename T>
T LSDynaReader3D<T>::getFieldVal(const TokenBuffer& tb, const std::string& line, int field_idx, T default_val) const {
    if (field_idx >= 0 && field_idx < static_cast<int>(tb.count)) {
        std::string_view sv = tb.tokens[field_idx];
        if (!sv.empty()) {
            char buf[64];
            size_t n = std::min(sv.size(), sizeof(buf) - 1);
            std::memcpy(buf, sv.data(), n);
            buf[n] = '\0';
            char* endptr = nullptr;
            double val = std::strtod(buf, &endptr);
            if (endptr != buf) {
                return static_cast<T>(val);
            }
        }
    }
    // Fixed 10-character columns fallback (for fixed-format cards with blank fields)
    size_t start = field_idx * 10;
    if (start < line.length()) {
        size_t n = std::min<size_t>(10, line.length() - start);
        size_t s = start;
        size_t e = start + n;
        while (s < e && (line[s] == ' ' || line[s] == '\t' || line[s] == '\r')) s++;
        while (e > s && (line[e - 1] == ' ' || line[e - 1] == '\t' || line[e - 1] == '\r')) e--;
        if (e > s) {
            char buf[64];
            size_t sz = std::min<size_t>(e - s, sizeof(buf) - 1);
            std::memcpy(buf, line.data() + s, sz);
            buf[sz] = '\0';
            char* endptr = nullptr;
            double val = std::strtod(buf, &endptr);
            if (endptr != buf) {
                return static_cast<T>(val);
            }
        }
    }
    return default_val;
}

template <typename T>
T LSDynaReader3D<T>::parseFieldVal(const std::string& line, int field_idx, T default_val) const {
    TokenBuffer tb;
    tokenizeLine(line, tb);
    return getFieldVal(tb, line, field_idx, default_val);
}

template <typename T>
bool LSDynaReader3D<T>::parseStream(
    const std::string& filepath,
    std::vector<FEMNode3D<T>>& out_nodes,
    std::vector<FEMElement3D<T>>& out_elements,
    std::vector<FEMTrussElement3D<T>>& out_trusses,
    std::vector<FEMBeam3DElement<T>>& out_beams,
    std::vector<FEMShell4BTElement<T>>& out_shells,
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

    std::string dir_prefix;
    {
        size_t sep = filepath.find_last_of("/\\");
        if (sep != std::string::npos) {
            dir_prefix = filepath.substr(0, sep + 1);
        }
    }

    std::string line;
    std::string current_keyword = "";
    std::string pending_part_title = "";
    std::string pending_set_title = "";
    int active_set_id = 0;
    TokenBuffer tb;

    while (std::getline(file, line)) {
        std::string trimmed = trim(line);
        if (trimmed.empty() || trimmed[0] == '$') continue; // Skip comments and empty lines

        if (trimmed[0] == '*') {
            // Transform keyword to uppercase
            current_keyword = trimmed;
            std::transform(current_keyword.begin(), current_keyword.end(), current_keyword.begin(), ::toupper);
            active_set_id = 0;
            continue;
        }

        tokenizeLine(line, tb);

        // Handle Keyword Block Content
        if (current_keyword.rfind("*NODE", 0) == 0) {
            if (current_keyword.rfind("*NODE_TITLE", 0) == 0) {
                // Consume title line
                std::getline(file, line);
                current_keyword = "*NODE";
                continue;
            }

            int64_t node_id = static_cast<int64_t>(getFieldVal(tb, line, 0, 0.0f));
            if (node_id <= 0) continue;

            T x = getFieldVal(tb, line, 1, 0.0f);
            T y = getFieldVal(tb, line, 2, 0.0f);
            T z = getFieldVal(tb, line, 3, 0.0f);

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

            int64_t elem_id = static_cast<int64_t>(getFieldVal(tb, line, 0, 0.0f));
            int part_id = static_cast<int>(getFieldVal(tb, line, 1, 1.0f));
            if (elem_id <= 0) continue;

            int64_t n1 = 0, n2 = 0, n3 = 0, n4 = 0, n5 = 0, n6 = 0, n7 = 0, n8 = 0;
            if (tb.count <= 2) {
                // 2-card LS-DYNA *ELEMENT_SOLID format: Card 1 = EID, PID; Card 2 = N1..N8(, N9, N10)
                std::streampos pos = file.tellg();
                std::string line2;
                while (std::getline(file, line2)) {
                    std::string trimmed2 = trim(line2);
                    if (trimmed2.empty() || trimmed2[0] == '$') continue;
                    if (trimmed2[0] == '*') {
                        file.seekg(pos);
                        break;
                    }
                    TokenBuffer tb2;
                    tokenizeLine(line2, tb2);
                    n1 = static_cast<int64_t>(getFieldVal(tb2, line2, 0, 0.0f));
                    n2 = static_cast<int64_t>(getFieldVal(tb2, line2, 1, 0.0f));
                    n3 = static_cast<int64_t>(getFieldVal(tb2, line2, 2, 0.0f));
                    n4 = static_cast<int64_t>(getFieldVal(tb2, line2, 3, 0.0f));
                    n5 = static_cast<int64_t>(getFieldVal(tb2, line2, 4, 0.0f));
                    n6 = static_cast<int64_t>(getFieldVal(tb2, line2, 5, 0.0f));
                    n7 = static_cast<int64_t>(getFieldVal(tb2, line2, 6, 0.0f));
                    n8 = static_cast<int64_t>(getFieldVal(tb2, line2, 7, 0.0f));
                    break;
                }
            } else {
                n1 = static_cast<int64_t>(getFieldVal(tb, line, 2, 0.0f));
                n2 = static_cast<int64_t>(getFieldVal(tb, line, 3, 0.0f));
                n3 = static_cast<int64_t>(getFieldVal(tb, line, 4, 0.0f));
                n4 = static_cast<int64_t>(getFieldVal(tb, line, 5, 0.0f));
                n5 = static_cast<int64_t>(getFieldVal(tb, line, 6, 0.0f));
                n6 = static_cast<int64_t>(getFieldVal(tb, line, 7, 0.0f));
                n7 = static_cast<int64_t>(getFieldVal(tb, line, 8, 0.0f));
                n8 = static_cast<int64_t>(getFieldVal(tb, line, 9, 0.0f));
            }

            if (m_id_to_node_index.count(n1) && m_id_to_node_index.count(n2) &&
                m_id_to_node_index.count(n3) && m_id_to_node_index.count(n4)) {

                FEMElement3D<T> elem{};
                elem.node_ids[0] = m_id_to_node_index.at(n1);
                elem.node_ids[1] = m_id_to_node_index.at(n2);
                elem.node_ids[2] = m_id_to_node_index.at(n3);
                elem.node_ids[3] = m_id_to_node_index.at(n4);
                elem.node_ids[4] = (n5 > 0 && m_id_to_node_index.count(n5)) ? m_id_to_node_index.at(n5) : elem.node_ids[3];
                elem.node_ids[5] = (n6 > 0 && m_id_to_node_index.count(n6)) ? m_id_to_node_index.at(n6) : elem.node_ids[3];
                elem.node_ids[6] = (n7 > 0 && m_id_to_node_index.count(n7)) ? m_id_to_node_index.at(n7) : elem.node_ids[3];
                elem.node_ids[7] = (n8 > 0 && m_id_to_node_index.count(n8)) ? m_id_to_node_index.at(n8) : elem.node_ids[3];

                elem.lsdyna_id = elem_id;
                elem.part_id = part_id;
                elem.mat_id = m_part_to_matid.count(part_id) ? m_part_to_matid[part_id] : 0;

                std::memset(elem.F, 0, sizeof(elem.F));
                elem.F[0][0] = 1.0f; elem.F[1][1] = 1.0f; elem.F[2][2] = 1.0f;
                std::memset(elem.sigma, 0, sizeof(elem.sigma));

                m_id_to_elem_index[elem_id] = static_cast<int>(out_elements.size());
                out_elements.push_back(elem);

                if (!m_parts.count(part_id)) {
                    m_parts[part_id].part_id = part_id;
                    m_parts[part_id].name = "Part_" + std::to_string(part_id);
                }
                m_parts[part_id].num_solids++;
            }
        } else if ((current_keyword.rfind("*MAT_", 0) == 0 || current_keyword.rfind("*EOS_", 0) == 0) &&
                   current_keyword.find("_TITLE") != std::string::npos) {
            size_t tpos = current_keyword.find("_TITLE");
            current_keyword.erase(tpos, 6);
            continue;
        } else if (current_keyword.rfind("*MAT_ELASTIC", 0) == 0 || current_keyword.rfind("*MAT_001", 0) == 0) {
            // Card 1: MID, RO, E, PR
            int mid = static_cast<int>(parseFieldVal(line, 0, 1.0f));
            MaterialTable3D m_tb{};
            m_tb.material_model = MPMMaterialModel::LinearElastic;
            m_tb.density = static_cast<float>(parseFieldVal(line, 1, 7850.0f));
            m_tb.youngs_modulus = static_cast<float>(parseFieldVal(line, 2, 210.0e9f));
            m_tb.poissons_ratio = static_cast<float>(parseFieldVal(line, 3, 0.30f));

            m_imported_materials[mid] = m_tb;
            current_keyword = "";
        } else if (current_keyword.rfind("*MAT_PIECEWISE_LINEAR_PLASTICITY", 0) == 0 ||
                   current_keyword.rfind("*MAT_024", 0) == 0 ||
                   current_keyword.rfind("*MAT_PLASTIC_KINEMATIC", 0) == 0 ||
                   current_keyword.rfind("*MAT_003", 0) == 0) {
            // Card 1: MID, RO, E, PR, SIGY, ETAN, FAIL, TDEL
            int mid = static_cast<int>(parseFieldVal(line, 0, 1.0f));
            const bool is_mat024 = (current_keyword.rfind("*MAT_PIECEWISE_LINEAR_PLASTICITY", 0) == 0 ||
                                    current_keyword.rfind("*MAT_024", 0) == 0);
            MaterialTable3D m_tb{};
            m_tb.material_model = MPMMaterialModel::Hypoelastic;
            m_tb.density = static_cast<float>(parseFieldVal(line, 1, 7850.0f));
            m_tb.youngs_modulus = static_cast<float>(parseFieldVal(line, 2, 210.0e9f));
            m_tb.poissons_ratio = static_cast<float>(parseFieldVal(line, 3, 0.30f));
            m_tb.yield_stress = static_cast<float>(parseFieldVal(line, 4, 400.0e6f));
            m_tb.hardening_modulus = static_cast<float>(parseFieldVal(line, 5, 1.0e9f));
            T fail = parseFieldVal(line, 6, 0.0f);
            if (fail > 0.0f) m_tb.failure_strain = static_cast<float>(fail);

            if (is_mat024) {
                // Optional Card 2: C, P, LCSS, LCSR, VP
                std::streampos pos = file.tellg();
                std::string line2;
                while (std::getline(file, line2)) {
                    std::string trimmed2 = trim(line2);
                    if (trimmed2.empty() || trimmed2[0] == '$') continue;
                    if (trimmed2[0] == '*') { file.seekg(pos); break; }
                    float cs_c = static_cast<float>(parseFieldVal(line2, 0, 0.0f));
                    float cs_p = static_cast<float>(parseFieldVal(line2, 1, 0.0f));
                    if (cs_c > 0.0f && cs_p > 0.0f) {
                        m_tb.cs_C = cs_c;
                        m_tb.cs_P = cs_p;
                    }
                    break;
                }
            }

            m_imported_materials[mid] = m_tb;
            current_keyword = "";
        } else if (current_keyword.rfind("*MAT_CONCRETE_DAMAGE_REL3", 0) == 0 ||
                   current_keyword.rfind("*MAT_072R3", 0) == 0 ||
                   current_keyword.rfind("*MAT_072", 0) == 0 ||
                   current_keyword.rfind("*MAT_CONCRETE_DAMAGE", 0) == 0) {
            // Card 1: MID, RO, PR
            int mid = static_cast<int>(parseFieldVal(line, 0, 1.0f));
            T ro = parseFieldVal(line, 1, 2400.0f);
            T pr = parseFieldVal(line, 2, 0.20f);

            // Card 2: SIGF, A0, A1, A2
            T sigf = static_cast<T>(35.0e6f);
            std::streampos pos = file.tellg();
            std::string line2;
            while (std::getline(file, line2)) {
                std::string trimmed2 = trim(line2);
                if (trimmed2.empty() || trimmed2[0] == '$') continue;
                if (trimmed2[0] == '*') { file.seekg(pos); break; }
                sigf = parseFieldVal(line2, 0, 35.0e6f);
                break;
            }

            MaterialTable3D m_tb{};
            m_tb.material_model = MPMMaterialModel::RHTConcrete;
            m_tb.density = static_cast<float>(ro);
            m_tb.poissons_ratio = static_cast<float>(pr > 0.0f ? pr : 0.18f);
            m_tb.youngs_modulus = 34.0e9f;
            m_tb.yield_stress = static_cast<float>(sigf > 0.0f ? sigf : 35.0e6f);
            m_tb.fc = m_tb.yield_stress;
            m_tb.ft = 0.09f * m_tb.fc;
            m_tb.G_f = 150.0f;
            m_tb.rht_A = 1.6f;
            m_tb.rht_N = 0.61f;
            m_tb.rht_B = 0.7f;
            m_tb.rht_M = 0.8f;
            m_tb.rht_p_crush = 17.0e6f;
            m_tb.rht_p_lock = 600.0e6f;
            m_tb.rht_alpha0 = 1.22f;
            m_tb.enable_strain_erosion = true;
            m_tb.erosion_strain = 1.20f;
            m_tb.failure_strain = 0.0035f;
            m_tb.tensile_failure_stress = m_tb.ft;

            m_imported_materials[mid] = m_tb;
            current_keyword = "";
        } else if (current_keyword.rfind("*MAT_JOHNSON_COOK", 0) == 0 || current_keyword.rfind("*MAT_015", 0) == 0) {
            // Card 1: MID, RO, E, PR, A, B, N, C
            int mid = static_cast<int>(parseFieldVal(line, 0, 1.0f));
            MaterialTable3D m_tb{};
            m_tb.material_model = MPMMaterialModel::JohnsonCookMieGruneisen;
            m_tb.density = static_cast<float>(parseFieldVal(line, 1, 7850.0f));
            m_tb.youngs_modulus = static_cast<float>(parseFieldVal(line, 2, 210.0e9f));
            m_tb.poissons_ratio = static_cast<float>(parseFieldVal(line, 3, 0.30f));
            m_tb.jc_A = static_cast<float>(parseFieldVal(line, 4, 792.0e6f));
            m_tb.jc_B = static_cast<float>(parseFieldVal(line, 5, 510.0e6f));
            m_tb.jc_n = static_cast<float>(parseFieldVal(line, 6, 0.26f));
            m_tb.jc_C = static_cast<float>(parseFieldVal(line, 7, 0.014f));
            m_tb.yield_stress = m_tb.jc_A;

            // Card 2: M, TM, TR, CP, PC, SPALL, ...
            std::streampos pos = file.tellg();
            std::string line2;
            while (std::getline(file, line2)) {
                std::string trimmed2 = trim(line2);
                if (trimmed2.empty() || trimmed2[0] == '$') continue;
                if (trimmed2[0] == '*') { file.seekg(pos); break; }
                m_tb.jc_m = static_cast<float>(parseFieldVal(line2, 0, 1.03f));
                m_tb.T_melt = static_cast<float>(parseFieldVal(line2, 1, 1793.0f));
                m_tb.T_room = static_cast<float>(parseFieldVal(line2, 2, 293.0f));
                m_tb.Cp = static_cast<float>(parseFieldVal(line2, 3, 477.0f));
                T spall = parseFieldVal(line2, 5, 0.0f);
                if (spall > 0.0f) m_tb.tensile_failure_stress = static_cast<float>(spall);
                break;
            }

            m_imported_materials[mid] = m_tb;
            current_keyword = "";
        } else if (current_keyword.rfind("*MAT_STEINBERG", 0) == 0 || current_keyword.rfind("*MAT_011", 0) == 0) {
            // Card 1: MID, RO, G0, SIGO, BETA, N, GAMA, SIGM
            int mid = static_cast<int>(parseFieldVal(line, 0, 1.0f));
            MaterialTable3D m_tb{};
            m_tb.material_model = MPMMaterialModel::SteinbergGuinan;
            m_tb.density = static_cast<float>(parseFieldVal(line, 1, 8930.0f));
            float G0 = static_cast<float>(parseFieldVal(line, 2, 47.7e9f));
            m_tb.sg_Y0 = static_cast<float>(parseFieldVal(line, 3, 120.0e6f));
            m_tb.sg_beta = static_cast<float>(parseFieldVal(line, 4, 36.0f));
            m_tb.sg_n = static_cast<float>(parseFieldVal(line, 5, 0.45f));
            m_tb.sg_Ymax = static_cast<float>(parseFieldVal(line, 7, 640.0e6f));
            m_tb.yield_stress = m_tb.sg_Y0;
            m_tb.poissons_ratio = 0.34f;
            m_tb.youngs_modulus = 2.0f * G0 * (1.0f + m_tb.poissons_ratio);

            // Card 2: B, BP, H, F, A, TM0, GAM0
            std::streampos pos = file.tellg();
            std::string line2;
            while (std::getline(file, line2)) {
                std::string trimmed2 = trim(line2);
                if (trimmed2.empty() || trimmed2[0] == '$') continue;
                if (trimmed2[0] == '*') { file.seekg(pos); break; }
                m_tb.sg_bp = static_cast<float>(parseFieldVal(line2, 1, 2.83e-11f));
                m_tb.sg_bT = static_cast<float>(parseFieldVal(line2, 2, 3.77e-4f));
                float tm0 = static_cast<float>(parseFieldVal(line2, 5, 1360.0f));
                float gam0 = static_cast<float>(parseFieldVal(line2, 6, 1.99f));
                if (tm0 > 0.0f) m_tb.T_melt = tm0;
                if (gam0 > 0.0f) m_tb.mg_gamma0 = gam0;
                break;
            }

            m_imported_materials[mid] = m_tb;
            current_keyword = "";
        } else if (current_keyword.rfind("*MAT_GEOLOGICAL_CAP_MODEL", 0) == 0 || current_keyword.rfind("*MAT_025", 0) == 0) {
            // Card 1: MID, RO, BULK, G, ALPHA, THETA, GAMMA, BETA
            int mid = static_cast<int>(parseFieldVal(line, 0, 1.0f));
            MaterialTable3D m_tb{};
            m_tb.material_model = MPMMaterialModel::GeologicalCap;
            m_tb.density = static_cast<float>(parseFieldVal(line, 1, 1950.0f));
            float K = static_cast<float>(parseFieldVal(line, 2, 1.5e8f));
            float G = static_cast<float>(parseFieldVal(line, 3, 7.5e7f));
            float alpha = static_cast<float>(parseFieldVal(line, 4, 25.0e3f));
            float theta = static_cast<float>(parseFieldVal(line, 5, 0.25f));
            m_tb.poissons_ratio = std::clamp((3.0f * K - 2.0f * G) / std::max(1.0f, 2.0f * (3.0f * K + G)), 0.01f, 0.49f);
            m_tb.youngs_modulus = (9.0f * K * G) / std::max(1.0f, 3.0f * K + G);
            m_tb.dp_cohesion = alpha;
            m_tb.dp_friction_angle = std::atan(std::clamp(3.0f * theta, 0.0f, 1.5f)) * (180.0f / 3.14159265f);

            // Card 2: R, D, W, X0, C, N
            std::streampos pos = file.tellg();
            std::string line2;
            while (std::getline(file, line2)) {
                std::string trimmed2 = trim(line2);
                if (trimmed2.empty() || trimmed2[0] == '$') continue;
                if (trimmed2[0] == '*') { file.seekg(pos); break; }
                m_tb.cap_R = static_cast<float>(parseFieldVal(line2, 0, 2.5f));
                m_tb.cap_D1 = static_cast<float>(parseFieldVal(line2, 1, 5.0e-7f));
                m_tb.cap_W = static_cast<float>(parseFieldVal(line2, 2, 0.15f));
                m_tb.cap_X0 = static_cast<float>(parseFieldVal(line2, 3, 4.0e5f));
                float t_cut = static_cast<float>(parseFieldVal(line2, 4, 0.0f));
                if (t_cut > 0.0f) m_tb.dp_tensile_cutoff = t_cut;
                break;
            }

            m_imported_materials[mid] = m_tb;
            current_keyword = "";
        } else if (current_keyword.rfind("*MAT_MOONEY", 0) == 0 || current_keyword.rfind("*MAT_027", 0) == 0) {
            // Card 1: MID, RO, PR, A (C10), B (C01)
            int mid = static_cast<int>(parseFieldVal(line, 0, 1.0f));
            MaterialTable3D m_tb{};
            m_tb.material_model = MPMMaterialModel::HyperelasticMooneyRivlin;
            m_tb.density = static_cast<float>(parseFieldVal(line, 1, 1100.0f));
            float pr = std::clamp(static_cast<float>(parseFieldVal(line, 2, 0.495f)), 0.01f, 0.499f);
            m_tb.mr_c10 = static_cast<float>(parseFieldVal(line, 3, 0.40e6f));
            m_tb.mr_c01 = static_cast<float>(parseFieldVal(line, 4, 0.10e6f));
            float G0 = 2.0f * (m_tb.mr_c10 + m_tb.mr_c01);
            m_tb.poissons_ratio = pr;
            m_tb.youngs_modulus = 2.0f * G0 * (1.0f + pr);
            m_tb.k_bulk = m_tb.youngs_modulus / (3.0f * std::max(0.002f, 1.0f - 2.0f * pr));

            m_imported_materials[mid] = m_tb;
            current_keyword = "";
        } else if (current_keyword.rfind("*MAT_CRUSHABLE_FOAM", 0) == 0 || current_keyword.rfind("*MAT_063", 0) == 0) {
            // Card 1: MID, RO, E, PR, LCID, TSC, DAMP
            int mid = static_cast<int>(parseFieldVal(line, 0, 1.0f));
            MaterialTable3D m_tb{};
            m_tb.material_model = MPMMaterialModel::CrushableFoam;
            m_tb.density = static_cast<float>(parseFieldVal(line, 1, 120.0f));
            m_tb.youngs_modulus = static_cast<float>(parseFieldVal(line, 2, 1.5e8f));
            m_tb.poissons_ratio = static_cast<float>(parseFieldVal(line, 3, 0.05f));
            float tsc = static_cast<float>(parseFieldVal(line, 5, 0.0f));
            m_tb.foam_plateau_stress = (tsc > 0.0f) ? tsc : 0.02f * m_tb.youngs_modulus;
            m_tb.tensile_failure_stress = m_tb.foam_plateau_stress;
            m_tb.foam_alpha = 1.5f;
            m_tb.foam_densification_strain = 0.60f;

            m_imported_materials[mid] = m_tb;
            current_keyword = "";
        } else if (current_keyword.rfind("*MAT_JOHNSON_HOLMQUIST_CERAMICS", 0) == 0 || current_keyword.rfind("*MAT_110", 0) == 0) {
            // Card 1: MID, RO, G, A, B, C, M, N
            int mid = static_cast<int>(parseFieldVal(line, 0, 1.0f));
            MaterialTable3D m_tb{};
            m_tb.material_model = MPMMaterialModel::JohnsonHolmquistJH2;
            m_tb.density = static_cast<float>(parseFieldVal(line, 1, 3200.0f));
            float G = static_cast<float>(parseFieldVal(line, 2, 193.0e9f));
            m_tb.jh2_A = static_cast<float>(parseFieldVal(line, 3, 0.96f));
            m_tb.jh2_B = static_cast<float>(parseFieldVal(line, 4, 0.35f));
            m_tb.jh2_C = static_cast<float>(parseFieldVal(line, 5, 0.009f));
            m_tb.jh2_M = static_cast<float>(parseFieldVal(line, 6, 1.0f));
            m_tb.jh2_N = static_cast<float>(parseFieldVal(line, 7, 0.65f));

            // Card 2: EPSI, T, SFMAX, HEL, PHEL, BETA, D1, D2
            std::streampos pos = file.tellg();
            std::string line2;
            while (std::getline(file, line2)) {
                std::string trimmed2 = trim(line2);
                if (trimmed2.empty() || trimmed2[0] == '$') continue;
                if (trimmed2[0] == '*') { file.seekg(pos); break; }
                m_tb.jh2_t_max = static_cast<float>(parseFieldVal(line2, 1, 370.0e6f));
                m_tb.jh2_sigma_hel = static_cast<float>(parseFieldVal(line2, 3, 14.5e9f));
                m_tb.jh2_p_hel = static_cast<float>(parseFieldVal(line2, 4, 5.9e9f));
                m_tb.jh2_beta = static_cast<float>(parseFieldVal(line2, 5, 1.0f));
                m_tb.jh2_D1 = static_cast<float>(parseFieldVal(line2, 6, 0.48f));
                m_tb.jh2_D2 = static_cast<float>(parseFieldVal(line2, 7, 0.48f));
                break;
            }
            // Card 3: K1, K2, K3, FS
            std::streampos pos3 = file.tellg();
            std::string line3;
            while (std::getline(file, line3)) {
                std::string trimmed3 = trim(line3);
                if (trimmed3.empty() || trimmed3[0] == '$') continue;
                if (trimmed3[0] == '*') { file.seekg(pos3); break; }
                m_tb.jh2_K1 = static_cast<float>(parseFieldVal(line3, 0, 204.0e9f));
                m_tb.jh2_K2 = static_cast<float>(parseFieldVal(line3, 1, 0.0f));
                m_tb.jh2_K3 = static_cast<float>(parseFieldVal(line3, 2, 0.0f));
                break;
            }
            float K1 = std::max(1.0e6f, m_tb.jh2_K1);
            m_tb.poissons_ratio = std::clamp((3.0f * K1 - 2.0f * G) / std::max(1.0f, 2.0f * (3.0f * K1 + G)), 0.01f, 0.49f);
            m_tb.youngs_modulus = (9.0f * K1 * G) / std::max(1.0f, 3.0f * K1 + G);

            m_imported_materials[mid] = m_tb;
            current_keyword = "";
        } else if (current_keyword.rfind("*MAT_MOHR_COULOMB", 0) == 0 || current_keyword.rfind("*MAT_173", 0) == 0) {
            // Card 1: MID, RO, GMOD, RNU, NPLANES, PHI, CVAL, PSI
            int mid = static_cast<int>(parseFieldVal(line, 0, 1.0f));
            MaterialTable3D m_tb{};
            m_tb.material_model = MPMMaterialModel::MohrCoulomb;
            m_tb.density = static_cast<float>(parseFieldVal(line, 1, 2000.0f));
            float Gmod = static_cast<float>(parseFieldVal(line, 2, 4.0e7f));
            m_tb.poissons_ratio = std::clamp(static_cast<float>(parseFieldVal(line, 3, 0.30f)), 0.01f, 0.49f);
            m_tb.youngs_modulus = 2.0f * Gmod * (1.0f + m_tb.poissons_ratio);
            m_tb.dp_friction_angle = static_cast<float>(parseFieldVal(line, 5, 30.0f));
            m_tb.dp_cohesion = static_cast<float>(parseFieldVal(line, 6, 20.0e3f));
            m_tb.dp_dilatancy_angle = static_cast<float>(parseFieldVal(line, 7, 0.0f));

            m_imported_materials[mid] = m_tb;
            current_keyword = "";
        } else if (current_keyword.rfind("*MAT_SIMPLIFIED_RUBBER", 0) == 0 || current_keyword.rfind("*MAT_181", 0) == 0) {
            // Card 1: MID, RO, KM, MU, G, SIGF
            int mid = static_cast<int>(parseFieldVal(line, 0, 1.0f));
            MaterialTable3D m_tb{};
            m_tb.material_model = MPMMaterialModel::HyperelasticYeoh;
            m_tb.density = static_cast<float>(parseFieldVal(line, 1, 1100.0f));
            float KM = static_cast<float>(parseFieldVal(line, 2, 1.0e8f));
            float G = static_cast<float>(parseFieldVal(line, 4, 1.0e6f));
            m_tb.k_bulk = KM;
            m_tb.yeoh_c10 = 0.5f * G;
            m_tb.yeoh_c20 = 0.0f;
            m_tb.yeoh_c30 = 0.0f;
            m_tb.poissons_ratio = std::clamp((3.0f * KM - 2.0f * G) / std::max(1.0f, 2.0f * (3.0f * KM + G)), 0.01f, 0.495f);
            m_tb.youngs_modulus = 2.0f * G * (1.0f + m_tb.poissons_ratio);

            m_imported_materials[mid] = m_tb;
            current_keyword = "";
        } else if (current_keyword.rfind("*EOS_GRUNEISEN", 0) == 0 || current_keyword.rfind("*EOS_004", 0) == 0) {
            // Card 1: EOSID, C, S1, S2, S3, GAMAO, A, E0
            int eosid = static_cast<int>(parseFieldVal(line, 0, 1.0f));
            GruneisenEOSProps eos{};
            eos.c0 = static_cast<float>(parseFieldVal(line, 1, 4570.0f));
            eos.s1 = static_cast<float>(parseFieldVal(line, 2, 1.49f));
            eos.gamma0 = static_cast<float>(parseFieldVal(line, 5, 1.81f));
            eos.valid = true;
            m_imported_eos[eosid] = eos;
            current_keyword = "";
        } else if (current_keyword.rfind("*MAT_ADD_EROSION", 0) == 0) {
            // Card 1: MID, EXFAIL, MXPRES, MNEPS, EFFEPS, VOLEPS, NUMFIP, NCS
            int mid = static_cast<int>(parseFieldVal(line, 0, 1.0f));
            T exf = parseFieldVal(line, 1, 0.0f);
            T f4 = parseFieldVal(line, 4, 0.0f);
            float fail_eps = 0.0f;
            if (f4 > 0.0f && f4 <= 10.0f) fail_eps = static_cast<float>(f4);
            else if (exf > 0.0f && exf <= 10.0f) fail_eps = static_cast<float>(exf);

            if (fail_eps > 0.0f) {
                if (m_imported_materials.count(mid)) {
                    m_imported_materials[mid].failure_strain = fail_eps;
                    m_imported_materials[mid].erosion_strain = fail_eps;
                    m_imported_materials[mid].enable_strain_erosion = true;
                } else {
                    m_pending_erosions.push_back({mid, fail_eps, 0.0f});
                }
            }

            if (f4 > 1.0e5f) {
                if (m_imported_materials.count(mid)) {
                    m_imported_materials[mid].tensile_failure_stress = static_cast<float>(f4);
                    m_imported_materials[mid].erosion_stress = static_cast<float>(f4);
                    m_imported_materials[mid].enable_stress_erosion = true;
                } else {
                    m_pending_erosions.push_back({mid, 0.0f, static_cast<float>(f4)});
                }
            }

            // Optional Card 2: MNPRES, SIGP1, SIGVM, ...
            std::streampos pos = file.tellg();
            std::string line2;
            while (std::getline(file, line2)) {
                std::string trimmed2 = trim(line2);
                if (trimmed2.empty() || trimmed2[0] == '$') continue;
                if (trimmed2[0] == '*') {
                    file.seekg(pos);
                    break;
                }
                T sigp1_c2 = parseFieldVal(line2, 1, 0.0f);
                if (sigp1_c2 > 1.0e5f) {
                    if (m_imported_materials.count(mid)) {
                        m_imported_materials[mid].tensile_failure_stress = static_cast<float>(sigp1_c2);
                        m_imported_materials[mid].erosion_stress = static_cast<float>(sigp1_c2);
                        m_imported_materials[mid].enable_stress_erosion = true;
                    } else {
                        m_pending_erosions.push_back({mid, 0.0f, static_cast<float>(sigp1_c2)});
                    }
                }
                break;
            }
            current_keyword = "";
        } else if (current_keyword.rfind("*CONTROL_TIMESTEP", 0) == 0) {
            // Card 1: DTINIT, TSSFAC, ISDO, TSLIMT, DTMS, LCTM, ERODE, MS1ST
            // Note: Explicit UI material settings take strict precedence over .k card defaults (Rule 11)
            T tslimt = parseFieldVal(line, 3, 0.0f);
            int erode = static_cast<int>(parseFieldVal(line, 6, 0.0f));
            if (erode == 1 && !out_default_mat.enable_timestep_erosion) {
                // UI disabled timestep erosion has precedence; record factor if valid
                if (tslimt > 0.0f && tslimt <= 1.0f) {
                    out_default_mat.timestep_erosion_factor = static_cast<float>(tslimt);
                }
            }
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
            std::vector<std::string> tokens = splitLine(line);
            int64_t node_id = static_cast<int64_t>(parseFieldVal(line, 0, 0.0f));
            bool fix_x = false, fix_y = false, fix_z = false;
            if (tokens.size() > 5) {
                // Full format: nid, tc, rc, dofx, dofy, dofz, dofrx, dofry, dofrz
                int tc = static_cast<int>(parseFieldVal(line, 1, 0.0f));
                int dofx = static_cast<int>(parseFieldVal(line, 3, 0.0f));
                int dofy = static_cast<int>(parseFieldVal(line, 4, 0.0f));
                int dofz = static_cast<int>(parseFieldVal(line, 5, 0.0f));
                fix_x = (dofx != 0) || (tc == 1 || tc == 4 || tc == 6 || tc == 7);
                fix_y = (dofy != 0) || (tc == 2 || tc == 4 || tc == 5 || tc == 7);
                fix_z = (dofz != 0) || (tc == 3 || tc == 5 || tc == 6 || tc == 7);
            } else {
                // Short format: nid, dofx, dofy, dofz
                int dofx = static_cast<int>(parseFieldVal(line, 1, 0.0f));
                int dofy = static_cast<int>(parseFieldVal(line, 2, 0.0f));
                int dofz = static_cast<int>(parseFieldVal(line, 3, 0.0f));
                fix_x = (dofx != 0);
                fix_y = (dofy != 0);
                fix_z = (dofz != 0);
            }

            m_pending_spc_nodes.push_back({node_id, fix_x, fix_y, fix_z});
            if (m_id_to_node_index.count(node_id)) {
                int idx = m_id_to_node_index[node_id];
                out_nodes[idx].is_fixed[0] = fix_x;
                out_nodes[idx].is_fixed[1] = fix_y;
                out_nodes[idx].is_fixed[2] = fix_z;
            }
        } else if (current_keyword.rfind("*BOUNDARY_SPC_SET", 0) == 0) {
            std::vector<std::string> tokens = splitLine(line);
            int sid = static_cast<int>(parseFieldVal(line, 0, 0.0f));
            bool fix_x = false, fix_y = false, fix_z = false;
            if (tokens.size() > 5) {
                int tc = static_cast<int>(parseFieldVal(line, 1, 0.0f));
                int dofx = static_cast<int>(parseFieldVal(line, 3, 0.0f));
                int dofy = static_cast<int>(parseFieldVal(line, 4, 0.0f));
                int dofz = static_cast<int>(parseFieldVal(line, 5, 0.0f));
                fix_x = (dofx != 0) || (tc == 1 || tc == 4 || tc == 6 || tc == 7);
                fix_y = (dofy != 0) || (tc == 2 || tc == 4 || tc == 5 || tc == 7);
                fix_z = (dofz != 0) || (tc == 3 || tc == 5 || tc == 6 || tc == 7);
            } else {
                int dofx = static_cast<int>(parseFieldVal(line, 1, 0.0f));
                int dofy = static_cast<int>(parseFieldVal(line, 2, 0.0f));
                int dofz = static_cast<int>(parseFieldVal(line, 3, 0.0f));
                fix_x = (dofx != 0);
                fix_y = (dofy != 0);
                fix_z = (dofz != 0);
            }

            m_pending_spc_sets.push_back({sid, fix_x, fix_y, fix_z});
            if (m_sets.count(sid)) {
                for (int64_t nid : m_sets[sid].ids) {
                    if (m_id_to_node_index.count(nid)) {
                        int idx = m_id_to_node_index[nid];
                        out_nodes[idx].is_fixed[0] = fix_x;
                        out_nodes[idx].is_fixed[1] = fix_y;
                        out_nodes[idx].is_fixed[2] = fix_z;
                    }
                }
            }
        } else if (current_keyword.rfind("*SET_NODE", 0) == 0) {
            if (current_keyword.rfind("*SET_NODE_TITLE", 0) == 0) {
                std::getline(file, line);
                pending_set_title = trim(line);
                current_keyword = "*SET_NODE_LIST";
                continue;
            }
            auto tokens = splitLine(line);
            if (!tokens.empty()) {
                if (active_set_id <= 0) {
                    int sid = 0;
                    try { sid = std::stoi(tokens[0]); } catch (...) {}
                    if (sid > 0) {
                        active_set_id = sid;
                        if (!m_sets.count(sid)) {
                            SetInfo& s = m_sets[sid];
                            s.set_id = sid;
                            s.name = pending_set_title.empty() ? ("Node_Set_" + std::to_string(sid)) : pending_set_title;
                            s.type = "NODE";
                        }
                        pending_set_title.clear();
                        // Support compact test syntax where Card 1 already lists node IDs after SID
                        bool card1_has_inline_ids = true;
                        if (tokens.size() >= 2 && tokens[1].find('.') != std::string::npos) {
                            card1_has_inline_ids = false; // Standard LS-DYNA Card 1 has DA1..DA4 floats
                        }
                        if (card1_has_inline_ids) {
                            for (size_t k = 1; k < tokens.size(); ++k) {
                                try { int64_t nid = std::stoll(tokens[k]); if (nid > 0) m_sets[active_set_id].ids.push_back(nid); } catch (...) {}
                            }
                        }
                    }
                } else {
                    for (const auto& t : tokens) {
                        try { int64_t nid = std::stoll(t); if (nid > 0) m_sets[active_set_id].ids.push_back(nid); } catch (...) {}
                    }
                }
            }
        } else if (current_keyword.rfind("*SET_PART", 0) == 0) {
            if (current_keyword.rfind("*SET_PART_TITLE", 0) == 0) {
                std::getline(file, line);
                pending_set_title = trim(line);
                current_keyword = "*SET_PART_LIST";
                continue;
            }
            auto tokens = splitLine(line);
            if (!tokens.empty()) {
                if (active_set_id <= 0) {
                    int sid = 0;
                    try { sid = std::stoi(tokens[0]); } catch (...) {}
                    if (sid > 0) {
                        active_set_id = sid;
                        if (!m_sets.count(sid)) {
                            SetInfo& s = m_sets[sid];
                            s.set_id = sid;
                            s.name = pending_set_title.empty() ? ("Part_Set_" + std::to_string(sid)) : pending_set_title;
                            s.type = "PART";
                        }
                        pending_set_title.clear();
                        bool card1_has_inline_ids = true;
                        if (tokens.size() >= 2 && tokens[1].find('.') != std::string::npos) {
                            card1_has_inline_ids = false;
                        }
                        if (card1_has_inline_ids) {
                            for (size_t k = 1; k < tokens.size(); ++k) {
                                try { int64_t pid = std::stoll(tokens[k]); if (pid > 0) m_sets[active_set_id].ids.push_back(pid); } catch (...) {}
                            }
                        }
                    }
                } else {
                    for (const auto& t : tokens) {
                        try { int64_t pid = std::stoll(t); if (pid > 0) m_sets[active_set_id].ids.push_back(pid); } catch (...) {}
                    }
                }
            }
        } else if (current_keyword.rfind("*PART", 0) == 0) {
            if (current_keyword.rfind("*PART_TITLE", 0) == 0) {
                std::getline(file, line);
                pending_part_title = trim(line);
                current_keyword = "*PART";
                continue;
            }
            bool has_alpha = false;
            for (char c : line) {
                if (std::isalpha(static_cast<unsigned char>(c))) {
                    has_alpha = true;
                    break;
                }
            }
            if (has_alpha) {
                pending_part_title = trim(line);
                continue;
            }
            int part_id = static_cast<int>(parseFieldVal(line, 0, 1.0f));
            int sec_id = static_cast<int>(parseFieldVal(line, 1, 1.0f));
            int mat_id = static_cast<int>(parseFieldVal(line, 2, 1.0f));
            int eos_id = static_cast<int>(parseFieldVal(line, 3, 0.0f));
            m_part_to_secid[part_id] = sec_id;
            m_part_to_matid[part_id] = mat_id;
            if (eos_id > 0) m_part_to_eosid[part_id] = eos_id;
            PartInfo& pinfo = m_parts[part_id];
            pinfo.part_id = part_id;
            pinfo.sec_id = sec_id;
            pinfo.mat_id = mat_id;
            pinfo.name = pending_part_title.empty() ? ("Part_" + std::to_string(part_id)) : pending_part_title;
            pending_part_title.clear();
        } else if (current_keyword.rfind("*SECTION_BEAM", 0) == 0) {
            if (current_keyword.rfind("*SECTION_BEAM_TITLE", 0) == 0) {
                std::getline(file, line);
                current_keyword = "*SECTION_BEAM";
                continue;
            }
            // Card 1: SECID, ELFORM, SHRF, QR/IRID, CST, SCOOR, NSM
            int sec_id = static_cast<int>(parseFieldVal(line, 0, 1.0f));
            int elform = static_cast<int>(parseFieldVal(line, 1, 3.0f)); // Default 3 = Truss

            BeamSectionProps props{};
            props.elform = elform;

            // Card 2: Read section dimensions (TS1, TS2, TT1, TT2 or A, ISS, ITT, J)
            std::streampos pos = file.tellg();
            std::string line2;
            while (std::getline(file, line2)) {
                std::string trimmed2 = trim(line2);
                if (trimmed2.empty() || trimmed2[0] == '$') continue;
                if (trimmed2[0] == '*') {
                    file.seekg(pos);
                    break;
                }
                T val1 = parseFieldVal(line2, 0, 0.0f);
                T val2 = parseFieldVal(line2, 1, 0.0f);
                T val3 = parseFieldVal(line2, 2, 0.0f);
                T val4 = parseFieldVal(line2, 3, 0.0f);

                if (val1 > 0.0f) {
                    if (val1 < 0.05f) {
                        // Interpreted as diameter d or thickness ts1
                        props.d = val1;
                        props.area = static_cast<T>(M_PI) * (props.d * props.d) * static_cast<T>(0.25f);
                        props.I2 = static_cast<T>(M_PI) * (props.d * props.d * props.d * props.d) / static_cast<T>(64.0f);
                        props.I3 = props.I2;
                        props.J = static_cast<T>(2.0f) * props.I2;
                        props.Zp = (props.d * props.d * props.d) / static_cast<T>(6.0f);
                    } else {
                        // Interpreted directly as Area A
                        props.area = val1;
                        props.d = std::sqrt(val1 * static_cast<T>(4.0f / M_PI));
                        props.I2 = val2 > 0.0f ? val2 : static_cast<T>(M_PI) * (props.d * props.d * props.d * props.d) / static_cast<T>(64.0f);
                        props.I3 = val3 > 0.0f ? val3 : props.I2;
                        props.J = val4 > 0.0f ? val4 : (props.I2 + props.I3);
                        props.Zp = (props.d * props.d * props.d) / static_cast<T>(6.0f);
                    }
                }
                break;
            }

            m_secid_to_beam_props[sec_id] = props;
        } else if (current_keyword.rfind("*ELEMENT_BEAM", 0) == 0) {
            if (current_keyword.rfind("*ELEMENT_BEAM_TITLE", 0) == 0) {
                std::getline(file, line);
                current_keyword = "*ELEMENT_BEAM";
                continue;
            }

            int64_t elem_id = static_cast<int64_t>(getFieldVal(tb, line, 0, 0.0f));
            int part_id = static_cast<int>(getFieldVal(tb, line, 1, 1.0f));
            int64_t n1 = static_cast<int64_t>(getFieldVal(tb, line, 2, 0.0f));
            int64_t n2 = static_cast<int64_t>(getFieldVal(tb, line, 3, 0.0f));

            if (elem_id > 0 && m_id_to_node_index.count(n1) && m_id_to_node_index.count(n2)) {
                int idx1 = m_id_to_node_index[n1];
                int idx2 = m_id_to_node_index[n2];

                int sec_id = m_part_to_secid.count(part_id) ? m_part_to_secid[part_id] : part_id;
                BeamSectionProps props{};
                if (m_secid_to_beam_props.count(sec_id)) {
                    props = m_secid_to_beam_props[sec_id];
                }

                T dx = out_nodes[idx2].x[0] - out_nodes[idx1].x[0];
                T dy = out_nodes[idx2].x[1] - out_nodes[idx1].x[1];
                T dz = out_nodes[idx2].x[2] - out_nodes[idx1].x[2];
                T L0 = std::sqrt(dx*dx + dy*dy + dz*dz);

                int beam_mat_key = m_part_to_matid.count(part_id) ? m_part_to_matid[part_id] : 0;
                T beam_fs = static_cast<T>(0.20f);
                if (m_imported_materials.count(beam_mat_key) && m_imported_materials[beam_mat_key].failure_strain > static_cast<float>(0.01f)) {
                    beam_fs = static_cast<T>(m_imported_materials[beam_mat_key].failure_strain);
                }

                if (props.elform == 3) {
                    // Instantiate fast 1D Axial Truss
                    FEMTrussElement3D<T> truss{};
                    truss.node_ids[0] = idx1;
                    truss.node_ids[1] = idx2;
                    truss.A = props.area;
                    truss.L0 = L0;
                    truss.mat_id = beam_mat_key;
                    truss.part_id = part_id;
                    truss.lsdyna_id = elem_id;
                    truss.failure_strain = beam_fs;

                    m_id_to_beam_index[elem_id] = static_cast<int>(out_trusses.size());
                    out_trusses.push_back(truss);
                    if (!m_parts.count(part_id)) {
                        m_parts[part_id].part_id = part_id;
                        m_parts[part_id].name = "Part_" + std::to_string(part_id);
                    }
                    m_parts[part_id].num_trusses++;
                } else {
                    // Instantiate full 3D Timoshenko Beam
                    FEMBeam3DElement<T> beam{};
                    beam.node_ids[0] = idx1;
                    beam.node_ids[1] = idx2;
                    beam.rot_node_ids[0] = -1; // Wire dynamically during solver setup
                    beam.rot_node_ids[1] = -1;
                    beam.d = props.d;
                    beam.A = props.area;
                    beam.I2 = props.I2;
                    beam.I3 = props.I3;
                    beam.J = props.J;
                    beam.Zp = props.Zp;
                    beam.L0 = L0;
                    beam.mat_id = beam_mat_key;
                    beam.part_id = part_id;
                    beam.lsdyna_id = elem_id;
                    beam.failure_strain = beam_fs;

                    if (L0 > static_cast<T>(1.0e-12f)) {
                        T invL = static_cast<T>(1.0f) / L0;
                        T e1[3] = { dx * invL, dy * invL, dz * invL };

                        T v_ref[3] = { static_cast<T>(0.0f), static_cast<T>(1.0f), static_cast<T>(0.0f) };
                        if (std::abs(e1[1]) > static_cast<T>(0.90f)) {
                            v_ref[0] = static_cast<T>(1.0f);
                            v_ref[1] = static_cast<T>(0.0f);
                            v_ref[2] = static_cast<T>(0.0f);
                        }

                        T e3_raw[3] = {
                            e1[1] * v_ref[2] - e1[2] * v_ref[1],
                            e1[2] * v_ref[0] - e1[0] * v_ref[2],
                            e1[0] * v_ref[1] - e1[1] * v_ref[0]
                        };
                        T norm_e3 = std::sqrt(e3_raw[0]*e3_raw[0] + e3_raw[1]*e3_raw[1] + e3_raw[2]*e3_raw[2]);
                        if (norm_e3 < static_cast<T>(1.0e-12f)) norm_e3 = static_cast<T>(1.0f);
                        beam.e3[0] = e3_raw[0] / norm_e3;
                        beam.e3[1] = e3_raw[1] / norm_e3;
                        beam.e3[2] = e3_raw[2] / norm_e3;

                        beam.e2[0] = beam.e3[1] * e1[2] - beam.e3[2] * e1[1];
                        beam.e2[1] = beam.e3[2] * e1[0] - beam.e3[0] * e1[2];
                        beam.e2[2] = beam.e3[0] * e1[1] - beam.e3[1] * e1[0];
                    }

                    m_id_to_beam_index[elem_id] = static_cast<int>(out_beams.size());
                    out_beams.push_back(beam);
                    if (!m_parts.count(part_id)) {
                        m_parts[part_id].part_id = part_id;
                        m_parts[part_id].name = "Part_" + std::to_string(part_id);
                    }
                    m_parts[part_id].num_beams++;
                }
            }
        } else if (current_keyword.rfind("*SECTION_SHELL", 0) == 0) {
            if (current_keyword.rfind("*SECTION_SHELL_TITLE", 0) == 0) {
                std::getline(file, line);
                current_keyword = "*SECTION_SHELL";
                continue;
            }
            // Card 1: SECID, ELFORM, SHRF, NIP, PROPT, QR/IRID, ICOMP, SETYP
            int sec_id = static_cast<int>(parseFieldVal(line, 0, 1.0f));
            int elform = static_cast<int>(parseFieldVal(line, 1, 2.0f)); // Default 2 = Belytschko-Tsay
            T shrf = parseFieldVal(line, 2, 1.0f);
            int nip = static_cast<int>(parseFieldVal(line, 3, 5.0f));

            ShellSectionProps props{};
            props.elform = elform;
            props.shrf = shrf > static_cast<T>(0.0f) ? shrf : static_cast<T>(1.0f);
            props.nip = nip > 0 ? nip : 5;

            // Card 2: Read shell thickness T1, T2, T3, T4
            std::streampos pos = file.tellg();
            std::string line2;
            while (std::getline(file, line2)) {
                std::string trimmed2 = trim(line2);
                if (trimmed2.empty() || trimmed2[0] == '$') continue;
                if (trimmed2[0] == '*') {
                    file.seekg(pos);
                    break;
                }
                T t1 = parseFieldVal(line2, 0, 0.001f);
                T t2 = parseFieldVal(line2, 1, 0.0f);
                T t3 = parseFieldVal(line2, 2, 0.0f);
                T t4 = parseFieldVal(line2, 3, 0.0f);

                props.t1 = t1 > static_cast<T>(0.0f) ? t1 : static_cast<T>(0.001f);
                props.t2 = (t2 > static_cast<T>(0.0f)) ? t2 : props.t1;
                props.t3 = (t3 > static_cast<T>(0.0f)) ? t3 : props.t1;
                props.t4 = (t4 > static_cast<T>(0.0f)) ? t4 : props.t1;
                props.thickness = (props.t1 + props.t2 + props.t3 + props.t4) * static_cast<T>(0.25f);
                break;
            }

            m_secid_to_shell_props[sec_id] = props;
        } else if (current_keyword.rfind("*ELEMENT_SHELL", 0) == 0) {
            if (current_keyword.rfind("*ELEMENT_SHELL_TITLE", 0) == 0) {
                std::getline(file, line);
                current_keyword = "*ELEMENT_SHELL";
                continue;
            }

            int64_t elem_id = static_cast<int64_t>(getFieldVal(tb, line, 0, 0.0f));
            int part_id = static_cast<int>(getFieldVal(tb, line, 1, 1.0f));
            int64_t n1 = static_cast<int64_t>(getFieldVal(tb, line, 2, 0.0f));
            int64_t n2 = static_cast<int64_t>(getFieldVal(tb, line, 3, 0.0f));
            int64_t n3 = static_cast<int64_t>(getFieldVal(tb, line, 4, 0.0f));
            int64_t n4 = static_cast<int64_t>(getFieldVal(tb, line, 5, 0.0f));

            if (elem_id > 0 && m_id_to_node_index.count(n1) && m_id_to_node_index.count(n2) &&
                m_id_to_node_index.count(n3)) {
                int idx1 = m_id_to_node_index[n1];
                int idx2 = m_id_to_node_index[n2];
                int idx3 = m_id_to_node_index[n3];
                int idx4 = (n4 > 0 && m_id_to_node_index.count(n4)) ? m_id_to_node_index[n4] : idx3;

                FEMShell4BTElement<T> shell{};
                shell.node_ids[0] = idx1;
                shell.node_ids[1] = idx2;
                shell.node_ids[2] = idx3;
                shell.node_ids[3] = idx4;
                shell.lsdyna_id = elem_id;
                shell.part_id = part_id;

                int sec_id = m_part_to_secid.count(part_id) ? m_part_to_secid[part_id] : part_id;
                if (m_secid_to_shell_props.count(sec_id)) {
                    shell.thickness = m_secid_to_shell_props[sec_id].thickness;
                } else {
                    shell.thickness = static_cast<T>(0.001f);
                }

                int shell_mat_key = m_part_to_matid.count(part_id) ? m_part_to_matid[part_id] : 0;
                shell.mat_id = shell_mat_key;

                T shell_fs = static_cast<T>(0.30f);
                if (m_imported_materials.count(shell_mat_key) && m_imported_materials[shell_mat_key].failure_strain > static_cast<float>(0.01f)) {
                    shell_fs = static_cast<T>(m_imported_materials[shell_mat_key].failure_strain);
                }
                shell.failure_strain = shell_fs;

                // Compute initial co-rotational triad and reference area
                T x_elem[4][3];
                for (int k = 0; k < 3; ++k) {
                    x_elem[0][k] = out_nodes[idx1].x[k];
                    x_elem[1][k] = out_nodes[idx2].x[k];
                    x_elem[2][k] = out_nodes[idx3].x[k];
                    x_elem[3][k] = out_nodes[idx4].x[k];
                }
                T area = static_cast<T>(0.0f);
                FEMShell4BTElement<T>::compute_corotational_triad(x_elem, shell.e1, shell.e2, shell.e3, area);
                shell.area0 = area;
                shell.area = area;

                T cd = static_cast<T>(5000.0f);
                if (m_imported_materials.count(shell_mat_key)) {
                    cd = computeDilatationalWaveSpeed<T>(m_imported_materials[shell_mat_key]);
                }
                T char_len = std::sqrt(std::max(static_cast<T>(1e-12), area));
                shell.dt0 = char_len / cd;

                m_id_to_shell_index[elem_id] = static_cast<int>(out_shells.size());
                out_shells.push_back(shell);
                if (!m_parts.count(part_id)) {
                    m_parts[part_id].part_id = part_id;
                    m_parts[part_id].name = "Part_" + std::to_string(part_id);
                }
                m_parts[part_id].num_shells++;
            }
        } else if (current_keyword.rfind("*INCLUDE", 0) == 0) {
            std::string inc_file = trim(line);
            if (inc_file.size() >= 2 &&
                ((inc_file.front() == '"' && inc_file.back() == '"') ||
                 (inc_file.front() == '\'' && inc_file.back() == '\''))) {
                inc_file = inc_file.substr(1, inc_file.size() - 2);
            }
            if (!inc_file.empty()) {
                std::string resolved = inc_file;
                bool is_abs = (inc_file[0] == '/' || inc_file[0] == '\\' || (inc_file.size() >= 2 && inc_file[1] == ':'));
                if (!is_abs && !dir_prefix.empty()) {
                    std::string candidate = dir_prefix + inc_file;
                    std::ifstream probe(candidate);
                    if (probe.good()) {
                        resolved = candidate;
                    }
                }
                parseStream(resolved, out_nodes, out_elements, out_trusses, out_beams, out_shells, out_default_mat, out_materials, depth + 1);
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
    std::vector<FEMTrussElement3D<T>> dummy_trusses;
    std::vector<FEMBeam3DElement<T>> dummy_beams;
    std::vector<FEMShell4BTElement<T>> dummy_shells;
    return parseFile(filepath, out_nodes, out_elements, dummy_trusses, dummy_beams, dummy_shells, out_default_mat, out_materials);
}

template <typename T>
bool LSDynaReader3D<T>::parseFile(
    const std::string& filepath,
    std::vector<FEMNode3D<T>>& out_nodes,
    std::vector<FEMElement3D<T>>& out_elements,
    std::vector<FEMTrussElement3D<T>>& out_trusses,
    std::vector<FEMBeam3DElement<T>>& out_beams,
    MaterialTable3D& out_default_mat,
    std::vector<MaterialTable3D>& out_materials
) {
    std::vector<FEMShell4BTElement<T>> dummy_shells;
    return parseFile(filepath, out_nodes, out_elements, out_trusses, out_beams, dummy_shells, out_default_mat, out_materials);
}

template <typename T>
bool LSDynaReader3D<T>::parseFile(
    const std::string& filepath,
    std::vector<FEMNode3D<T>>& out_nodes,
    std::vector<FEMElement3D<T>>& out_elements,
    std::vector<FEMShell4BTElement<T>>& out_shells,
    MaterialTable3D& out_default_mat,
    std::vector<MaterialTable3D>& out_materials
) {
    std::vector<FEMTrussElement3D<T>> dummy_trusses;
    std::vector<FEMBeam3DElement<T>> dummy_beams;
    return parseFile(filepath, out_nodes, out_elements, dummy_trusses, dummy_beams, out_shells, out_default_mat, out_materials);
}

template <typename T>
bool LSDynaReader3D<T>::parseFile(
    const std::string& filepath,
    std::vector<FEMNode3D<T>>& out_nodes,
    std::vector<FEMElement3D<T>>& out_elements,
    std::vector<FEMTrussElement3D<T>>& out_trusses,
    std::vector<FEMBeam3DElement<T>>& out_beams,
    std::vector<FEMShell4BTElement<T>>& out_shells,
    MaterialTable3D& out_default_mat,
    std::vector<MaterialTable3D>& out_materials
) {
    m_id_to_node_index.clear();
    m_id_to_elem_index.clear();
    m_id_to_beam_index.clear();
    m_id_to_shell_index.clear();
    m_secid_to_beam_props.clear();
    m_secid_to_shell_props.clear();
    m_part_to_secid.clear();
    m_part_to_matid.clear();
    m_part_to_eosid.clear();
    m_parts.clear();
    m_sets.clear();
    m_imported_materials.clear();
    m_imported_eos.clear();
    m_pending_spc_nodes.clear();
    m_pending_spc_sets.clear();
    m_pending_erosions.clear();

    std::ifstream check_file(filepath, std::ios::binary | std::ios::ate);
    if (check_file.is_open()) {
        std::streamsize fsize = check_file.tellg();
        check_file.close();
        if (fsize > 10 * 1024 * 1024) { // > 10 MB
            size_t est_nodes = static_cast<size_t>(fsize / 140);
            size_t est_elems = static_cast<size_t>(fsize / 160);
            out_nodes.reserve(est_nodes);
            out_elements.reserve(est_elems);
            out_shells.reserve(est_elems);
            m_id_to_node_index.reserve(est_nodes);
            m_id_to_elem_index.reserve(est_elems);
            m_id_to_shell_index.reserve(est_elems);
        }
    }

    const bool caller_ts_erode = out_default_mat.enable_timestep_erosion;
    bool ok = parseStream(filepath, out_nodes, out_elements, out_trusses, out_beams, out_shells, out_default_mat, out_materials, 0);
    if (ok) {
        for (const auto& pe : m_pending_erosions) {
            if (m_imported_materials.count(pe.mid)) {
                if (pe.fail_eps > 0.0f) {
                    m_imported_materials[pe.mid].failure_strain = pe.fail_eps;
                    m_imported_materials[pe.mid].erosion_strain = pe.fail_eps;
                    m_imported_materials[pe.mid].enable_strain_erosion = true;
                }
                if (pe.fail_stress > 1.0e5f) {
                    m_imported_materials[pe.mid].tensile_failure_stress = pe.fail_stress;
                    m_imported_materials[pe.mid].erosion_stress = pe.fail_stress;
                    m_imported_materials[pe.mid].enable_stress_erosion = true;
                }
            }
        }
        // Re-resolve part->mat_id and section props if *ELEMENT_* appeared before *PART or *SECTION_*
        for (auto& el : out_elements) {
            if (m_part_to_matid.count(el.part_id)) {
                el.mat_id = m_part_to_matid[el.part_id];
            }
        }
        for (auto& tr : out_trusses) {
            if (m_part_to_matid.count(tr.part_id)) {
                tr.mat_id = m_part_to_matid[tr.part_id];
            }
            if (m_imported_materials.count(tr.mat_id) && m_imported_materials[tr.mat_id].failure_strain > 0.01f) {
                tr.failure_strain = static_cast<T>(m_imported_materials[tr.mat_id].failure_strain);
            }
        }
        for (auto& bm : out_beams) {
            if (m_part_to_matid.count(bm.part_id)) {
                bm.mat_id = m_part_to_matid[bm.part_id];
            }
            if (m_imported_materials.count(bm.mat_id) && m_imported_materials[bm.mat_id].failure_strain > 0.01f) {
                bm.failure_strain = static_cast<T>(m_imported_materials[bm.mat_id].failure_strain);
            }
        }
        for (auto& sh : out_shells) {
            if (m_part_to_matid.count(sh.part_id)) {
                sh.mat_id = m_part_to_matid[sh.part_id];
            }
            int sec_id = m_part_to_secid.count(sh.part_id) ? m_part_to_secid[sh.part_id] : sh.part_id;
            if (m_secid_to_shell_props.count(sec_id)) {
                sh.thickness = m_secid_to_shell_props[sec_id].thickness;
            }
            if (m_imported_materials.count(sh.mat_id) && m_imported_materials[sh.mat_id].failure_strain > 0.01f) {
                sh.failure_strain = static_cast<T>(m_imported_materials[sh.mat_id].failure_strain);
            }
        }

        for (const auto& spc : m_pending_spc_nodes) {
            auto it = m_id_to_node_index.find(spc.node_id);
            if (it != m_id_to_node_index.end()) {
                int idx = it->second;
                if (spc.fix_x) out_nodes[idx].is_fixed[0] = true;
                if (spc.fix_y) out_nodes[idx].is_fixed[1] = true;
                if (spc.fix_z) out_nodes[idx].is_fixed[2] = true;
            }
        }
        for (const auto& spc : m_pending_spc_sets) {
            auto sit = m_sets.find(spc.sid);
            if (sit != m_sets.end()) {
                for (int64_t nid : sit->second.ids) {
                    auto it = m_id_to_node_index.find(nid);
                    if (it != m_id_to_node_index.end()) {
                        int idx = it->second;
                        if (spc.fix_x) out_nodes[idx].is_fixed[0] = true;
                        if (spc.fix_y) out_nodes[idx].is_fixed[1] = true;
                        if (spc.fix_z) out_nodes[idx].is_fixed[2] = true;
                    }
                }
            }
        }
    }
    if (ok && !m_imported_materials.empty()) {
        std::unordered_map<int, int> mat_to_eos_linked;
        for (const auto& pk : m_part_to_eosid) {
            int pid = pk.first;
            int eosid = pk.second;
            if (eosid > 0 && m_part_to_matid.count(pid)) {
                mat_to_eos_linked[m_part_to_matid[pid]] = eosid;
            }
        }
        for (auto& kv : m_imported_materials) {
            int mid = kv.first;
            MaterialTable3D& m = kv.second;
            if (m.material_model == MPMMaterialModel::JohnsonCookMieGruneisen ||
                m.material_model == MPMMaterialModel::SteinbergGuinan) {
                int eos_id = 0;
                if (mat_to_eos_linked.count(mid)) {
                    eos_id = mat_to_eos_linked[mid];
                } else if (m_imported_eos.count(mid)) {
                    eos_id = mid;
                } else if (m_imported_eos.size() == 1) {
                    eos_id = m_imported_eos.begin()->first;
                }
                if (eos_id > 0 && m_imported_eos.count(eos_id)) {
                    const auto& eos = m_imported_eos[eos_id];
                    m.mg_c0 = eos.c0;
                    m.mg_s = eos.s1;
                    m.mg_gamma0 = eos.gamma0;
                    if (m.material_model == MPMMaterialModel::SteinbergGuinan && eos.c0 > 0.0f && m.density > 0.0f) {
                        float G0 = m.youngs_modulus / (2.0f * (1.0f + std::clamp(m.poissons_ratio, 0.05f, 0.49f)));
                        float K0 = m.density * eos.c0 * eos.c0;
                        float nu_calc = std::clamp((3.0f * K0 - 2.0f * G0) / std::max(1.0f, 6.0f * K0 + 2.0f * G0), 0.05f, 0.49f);
                        m.poissons_ratio = nu_calc;
                        m.youngs_modulus = 2.0f * G0 * (1.0f + nu_calc);
                    }
                }
            }
            if (!caller_ts_erode && out_default_mat.timestep_erosion_factor > 0.0f && out_default_mat.timestep_erosion_factor <= 1.0f) {
                // Keep caller default factor untouched unless specified
            }
        }
        if (out_materials.empty()) {
            std::unordered_map<int, int> mid_to_index;
            for (const auto& kv : m_imported_materials) {
                mid_to_index[kv.first] = static_cast<int>(out_materials.size());
                out_materials.push_back(kv.second);
            }
            out_default_mat = out_materials[0];
            for (auto& el : out_elements) {
                if (mid_to_index.count(el.mat_id)) {
                    el.mat_id = mid_to_index[el.mat_id];
                } else if (!out_materials.empty()) {
                    el.mat_id = 0;
                }
            }
            for (auto& tr : out_trusses) {
                if (mid_to_index.count(tr.mat_id)) {
                    tr.mat_id = mid_to_index[tr.mat_id];
                } else if (!out_materials.empty()) {
                    tr.mat_id = 0;
                }
            }
            for (auto& bm : out_beams) {
                if (mid_to_index.count(bm.mat_id)) {
                    bm.mat_id = mid_to_index[bm.mat_id];
                } else if (!out_materials.empty()) {
                    bm.mat_id = 0;
                }
            }
            for (auto& sh : out_shells) {
                if (mid_to_index.count(sh.mat_id)) {
                    sh.mat_id = mid_to_index[sh.mat_id];
                } else if (!out_materials.empty()) {
                    sh.mat_id = 0;
                }
            }
        }
    }
    return ok;
}

// Explicit Instantiations
template class LSDynaReader3D<float>;
template class LSDynaReader3D<double>;

} // namespace Blast
