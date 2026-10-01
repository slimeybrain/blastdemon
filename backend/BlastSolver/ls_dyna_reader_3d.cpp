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
        // Whitespace free-format
        size_t i = 0;
        while (i < len && tb.count < 16) {
            while (i < len && (line[i] == ' ' || line[i] == '\t' || line[i] == '\r')) i++;
            if (i >= len) break;
            size_t start = i;
            while (i < len && line[i] != ' ' && line[i] != '\t' && line[i] != '\r') i++;
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
    std::string pending_part_title = "";
    std::string pending_set_title = "";
    TokenBuffer tb;

    while (std::getline(file, line)) {
        std::string trimmed = trim(line);
        if (trimmed.empty() || trimmed[0] == '$') continue; // Skip comments and empty lines

        if (trimmed[0] == '*') {
            // Transform keyword to uppercase
            current_keyword = trimmed;
            std::transform(current_keyword.begin(), current_keyword.end(), current_keyword.begin(), ::toupper);
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

            int64_t n1 = static_cast<int64_t>(getFieldVal(tb, line, 2, 0.0f));
            int64_t n2 = static_cast<int64_t>(getFieldVal(tb, line, 3, 0.0f));
            int64_t n3 = static_cast<int64_t>(getFieldVal(tb, line, 4, 0.0f));
            int64_t n4 = static_cast<int64_t>(getFieldVal(tb, line, 5, 0.0f));
            int64_t n5 = static_cast<int64_t>(getFieldVal(tb, line, 6, 0.0f));
            int64_t n6 = static_cast<int64_t>(getFieldVal(tb, line, 7, 0.0f));
            int64_t n7 = static_cast<int64_t>(getFieldVal(tb, line, 8, 0.0f));
            int64_t n8 = static_cast<int64_t>(getFieldVal(tb, line, 9, 0.0f));

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
                elem.mat_id = m_part_to_matid.count(part_id) ? m_part_to_matid[part_id] : 0;

                std::memset(elem.F, 0, sizeof(elem.F));
                elem.F[0][0] = 1.0f; elem.F[1][1] = 1.0f; elem.F[2][2] = 1.0f;
                std::memset(elem.sigma, 0, sizeof(elem.sigma));

                m_id_to_elem_index[elem_id] = static_cast<int>(out_elements.size());
                out_elements.push_back(elem);

                m_parts[part_id].num_solids++;
                if (!m_parts.count(part_id)) {
                    m_parts[part_id].part_id = part_id;
                    m_parts[part_id].name = "Part_" + std::to_string(part_id);
                }
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

            MaterialTable3D m_tb = out_default_mat;
            m_imported_materials[static_cast<int>(mid)] = m_tb;
            current_keyword = "";
        } else if (current_keyword.rfind("*MAT_PIECEWISE_LINEAR_PLASTICITY", 0) == 0 ||
                   current_keyword.rfind("*MAT_024", 0) == 0 ||
                   current_keyword.rfind("*MAT_PLASTIC_KINEMATIC", 0) == 0 ||
                   current_keyword.rfind("*MAT_003", 0) == 0) {
            // Card 1: MID, RO, E, PR, SIGY, ETAN, FAIL, TDEL
            T mid = parseFieldVal(line, 0, 1.0f);
            T ro = parseFieldVal(line, 1, 7850.0f);
            T e = parseFieldVal(line, 2, 210.0e9f);
            T pr = parseFieldVal(line, 3, 0.30f);
            T sigy = parseFieldVal(line, 4, 400.0e6f);
            T etan = parseFieldVal(line, 5, 1.0e9f);
            T fail = parseFieldVal(line, 6, 0.0f);

            out_default_mat.material_model = MPMMaterialModel::Hypoelastic;
            out_default_mat.density = static_cast<float>(ro);
            out_default_mat.youngs_modulus = static_cast<float>(e);
            out_default_mat.poissons_ratio = static_cast<float>(pr);
            out_default_mat.yield_stress = static_cast<float>(sigy);
            out_default_mat.hardening_modulus = static_cast<float>(etan);
            if (fail > 0.0f) out_default_mat.failure_strain = static_cast<float>(fail);

            MaterialTable3D m_tb = out_default_mat;
            m_imported_materials[static_cast<int>(mid)] = m_tb;
            current_keyword = "";
        } else if (current_keyword.rfind("*MAT_CONCRETE_DAMAGE_REL3", 0) == 0 ||
                   current_keyword.rfind("*MAT_072R3", 0) == 0 ||
                   current_keyword.rfind("*MAT_072", 0) == 0 ||
                   current_keyword.rfind("*MAT_CONCRETE_DAMAGE", 0) == 0) {
            // Card 1: MID, RO, PR
            T mid = parseFieldVal(line, 0, 1.0f);
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

            out_default_mat.material_model = MPMMaterialModel::RHTConcrete;
            out_default_mat.density = static_cast<float>(ro);
            out_default_mat.poissons_ratio = static_cast<float>(pr > 0.0f ? pr : 0.18f);
            out_default_mat.youngs_modulus = 34.0e9f;
            out_default_mat.yield_stress = static_cast<float>(sigf > 0.0f ? sigf : 35.0e6f);
            out_default_mat.fc = out_default_mat.yield_stress;
            out_default_mat.ft = 0.09f * out_default_mat.fc;
            out_default_mat.G_f = 150.0f;
            out_default_mat.rht_A = 1.6f;
            out_default_mat.rht_N = 0.61f;
            out_default_mat.rht_B = 0.7f;
            out_default_mat.rht_M = 0.8f;
            out_default_mat.rht_p_crush = 17.0e6f;
            out_default_mat.rht_p_lock = 600.0e6f;
            out_default_mat.rht_alpha0 = 1.22f;
            out_default_mat.enable_strain_erosion = true;
            out_default_mat.erosion_strain = 1.20f;
            out_default_mat.failure_strain = 0.0035f;
            out_default_mat.tensile_failure_stress = out_default_mat.ft;

            MaterialTable3D m_tb = out_default_mat;
            m_imported_materials[static_cast<int>(mid)] = m_tb;
            current_keyword = "";
        } else if (current_keyword.rfind("*MAT_JOHNSON_COOK", 0) == 0 || current_keyword.rfind("*MAT_015", 0) == 0) {
            // Card 1: MID, RO, E, PR, A, B, N, C
            T mid = parseFieldVal(line, 0, 1.0f);
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

            MaterialTable3D m_tb = out_default_mat;
            m_imported_materials[static_cast<int>(mid)] = m_tb;
            current_keyword = "";
        } else if (current_keyword.rfind("*EOS_GRUNEISEN", 0) == 0 || current_keyword.rfind("*EOS_004", 0) == 0) {
            // Card 1: EOSID, C, S1, S2, S3, GAMAO, A, E0
            out_default_mat.mg_c0 = static_cast<float>(parseFieldVal(line, 1, 4570.0f));
            out_default_mat.mg_s = static_cast<float>(parseFieldVal(line, 2, 1.49f));
            out_default_mat.mg_gamma0 = static_cast<float>(parseFieldVal(line, 5, 1.81f));
        } else if (current_keyword.rfind("*MAT_ADD_EROSION", 0) == 0) {
            // Card 1: MID, EXFAIL, MXPRES, MNEPS, EFFEPS, VOLEPS, NUMFIP, NCS
            int mid = static_cast<int>(parseFieldVal(line, 0, 1.0f));
            T exf = parseFieldVal(line, 1, 0.0f);
            T effeps = parseFieldVal(line, 4, 0.0f);
            float fail_eps = 0.0f;
            if (effeps > 0.0f && effeps <= 10.0f) fail_eps = static_cast<float>(effeps);
            else if (exf > 0.0f && exf <= 10.0f) fail_eps = static_cast<float>(exf);

            if (fail_eps > 0.0f) {
                out_default_mat.failure_strain = fail_eps;
                out_default_mat.enable_strain_erosion = true;
                if (m_imported_materials.count(mid)) {
                    m_imported_materials[mid].failure_strain = fail_eps;
                    m_imported_materials[mid].enable_strain_erosion = true;
                }
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
                int sid = 0;
                try { sid = std::stoi(tokens[0]); } catch (...) {}
                if (sid > 0 && !m_sets.count(sid)) {
                    SetInfo& s = m_sets[sid];
                    s.set_id = sid;
                    s.name = pending_set_title.empty() ? ("Node_Set_" + std::to_string(sid)) : pending_set_title;
                    s.type = "NODE";
                    pending_set_title.clear();
                    for (size_t k = 1; k < tokens.size(); ++k) {
                        try { int64_t nid = std::stoll(tokens[k]); if (nid > 0) s.ids.push_back(nid); } catch (...) {}
                    }
                } else if (sid > 0) {
                    for (const auto& t : tokens) {
                        try { int64_t nid = std::stoll(t); if (nid > 0) m_sets[sid].ids.push_back(nid); } catch (...) {}
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
                int sid = 0;
                try { sid = std::stoi(tokens[0]); } catch (...) {}
                if (sid > 0 && !m_sets.count(sid)) {
                    SetInfo& s = m_sets[sid];
                    s.set_id = sid;
                    s.name = pending_set_title.empty() ? ("Part_Set_" + std::to_string(sid)) : pending_set_title;
                    s.type = "PART";
                    pending_set_title.clear();
                    for (size_t k = 1; k < tokens.size(); ++k) {
                        try { int64_t pid = std::stoll(tokens[k]); if (pid > 0) s.ids.push_back(pid); } catch (...) {}
                    }
                } else if (sid > 0) {
                    for (const auto& t : tokens) {
                        try { int64_t pid = std::stoll(t); if (pid > 0) m_sets[sid].ids.push_back(pid); } catch (...) {}
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
            m_part_to_secid[part_id] = sec_id;
            m_part_to_matid[part_id] = mat_id;
            PartInfo& pinfo = m_parts[part_id];
            pinfo.part_id = part_id;
            pinfo.sec_id = sec_id;
            pinfo.mat_id = mat_id;
            pinfo.name = pending_part_title.empty() ? ("Part_" + std::to_string(part_id)) : pending_part_title;
            pending_part_title.clear();
            m_part_to_secid[part_id] = sec_id;
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
                    m_parts[part_id].num_beams++;
                }
            }
        } else if (current_keyword.rfind("*INCLUDE", 0) == 0) {
            std::string inc_file = trim(line);
            if (!inc_file.empty()) {
                parseStream(inc_file, out_nodes, out_elements, out_trusses, out_beams, out_default_mat, out_materials, depth + 1);
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
    return parseFile(filepath, out_nodes, out_elements, dummy_trusses, dummy_beams, out_default_mat, out_materials);
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
    m_id_to_node_index.clear();
    m_id_to_elem_index.clear();
    m_id_to_beam_index.clear();
    m_secid_to_beam_props.clear();
    m_part_to_secid.clear();
    m_part_to_matid.clear();
    m_parts.clear();
    m_sets.clear();
    m_imported_materials.clear();
    m_pending_spc_nodes.clear();
    m_pending_spc_sets.clear();

    std::ifstream check_file(filepath, std::ios::binary | std::ios::ate);
    if (check_file.is_open()) {
        std::streamsize fsize = check_file.tellg();
        check_file.close();
        if (fsize > 10 * 1024 * 1024) { // > 10 MB
            size_t est_nodes = static_cast<size_t>(fsize / 140);
            size_t est_elems = static_cast<size_t>(fsize / 160);
            out_nodes.reserve(est_nodes);
            out_elements.reserve(est_elems);
            m_id_to_node_index.reserve(est_nodes);
            m_id_to_elem_index.reserve(est_elems);
        }
    }

    bool ok = parseStream(filepath, out_nodes, out_elements, out_trusses, out_beams, out_default_mat, out_materials, 0);
    if (ok) {
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
    if (ok && out_materials.empty() && !m_imported_materials.empty()) {
        std::unordered_map<int, int> mid_to_index;
        for (const auto& kv : m_imported_materials) {
            mid_to_index[kv.first] = static_cast<int>(out_materials.size());
            out_materials.push_back(kv.second);
        }
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
    }
    return ok;
}

// Explicit Instantiations
template class LSDynaReader3D<float>;
template class LSDynaReader3D<double>;

} // namespace Blast
