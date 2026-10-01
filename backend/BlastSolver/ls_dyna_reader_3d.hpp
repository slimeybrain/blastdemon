#ifndef LS_DYNA_READER_3D_HPP
#define LS_DYNA_READER_3D_HPP

#include "fem_solver_3d.hpp"
#include <string>
#include <vector>
#include <unordered_map>
#include <map>
#include <cstdint>

namespace Blast {

template <typename T>
class LSDynaReader3D {
public:
    LSDynaReader3D() = default;
    ~LSDynaReader3D() = default;

    // Parse an LS-DYNA keyword file (.k / .dyn)
    bool parseFile(
        const std::string& filepath,
        std::vector<FEMNode3D<T>>& out_nodes,
        std::vector<FEMElement3D<T>>& out_elements,
        MaterialTable3D& out_default_mat,
        std::vector<MaterialTable3D>& out_materials
    );

    bool parseFile(
        const std::string& filepath,
        std::vector<FEMNode3D<T>>& out_nodes,
        std::vector<FEMElement3D<T>>& out_elements,
        std::vector<FEMTrussElement3D<T>>& out_trusses,
        std::vector<FEMBeam3DElement<T>>& out_beams,
        MaterialTable3D& out_default_mat,
        std::vector<MaterialTable3D>& out_materials
    );

    struct PartInfo {
        int part_id{1};
        std::string name{"Part_1"};
        int sec_id{1};
        int mat_id{1};
        int num_solids{0};
        int num_beams{0};
        int num_trusses{0};
    };

    struct SetInfo {
        int set_id{1};
        std::string name{"Set_1"};
        std::string type{"NODE"}; // "NODE", "PART", "SEGMENT", "SOLID", "BEAM"
        std::vector<int64_t> ids;
    };

    int getNodeCount() const { return static_cast<int>(m_id_to_node_index.size()); }
    int getElementCount() const { return static_cast<int>(m_id_to_elem_index.size()); }
    int getBeamCount() const { return static_cast<int>(m_id_to_beam_index.size()); }

    const std::unordered_map<int, PartInfo>& getParts() const { return m_parts; }
    const std::unordered_map<int, SetInfo>& getSets() const { return m_sets; }
    const std::map<int, MaterialTable3D>& getImportedMaterials() const { return m_imported_materials; }
    const std::unordered_map<int64_t, int>& getNodeIdToIndex() const { return m_id_to_node_index; }

private:
    struct BeamSectionProps {
        int elform{3};       // 3 = Truss (default fast), 1 = Hughes-Liu 3D Beam, 2 = Belytschko
        T area{1.13097e-4f}; // Cross-sectional area (default 12mm diameter rebar)
        T d{0.012f};         // Diameter
        T I2{1.01788e-9f};   // Area moment of inertia
        T I3{1.01788e-9f};
        T J{2.03575e-9f};
        T Zp{2.88e-7f};
    };

    bool parseStream(
        const std::string& filepath,
        std::vector<FEMNode3D<T>>& out_nodes,
        std::vector<FEMElement3D<T>>& out_elements,
        std::vector<FEMTrussElement3D<T>>& out_trusses,
        std::vector<FEMBeam3DElement<T>>& out_beams,
        MaterialTable3D& out_default_mat,
        std::vector<MaterialTable3D>& out_materials,
        int depth = 0
    );

    struct TokenBuffer {
        std::string_view tokens[16];
        size_t count{0};
    };

    std::string trim(const std::string& str) const;
    std::vector<std::string> splitLine(const std::string& line) const;
    void tokenizeLine(const std::string& line, TokenBuffer& tb) const;
    T getFieldVal(const TokenBuffer& tb, const std::string& line, int field_idx, T default_val = 0.0f) const;
    T parseFieldVal(const std::string& line, int field_idx, T default_val = 0.0f) const;

    struct PendingSPCNode {
        int64_t node_id;
        bool fix_x{false};
        bool fix_y{false};
        bool fix_z{false};
    };
    struct PendingSPCSet {
        int sid{0};
        bool fix_x{false};
        bool fix_y{false};
        bool fix_z{false};
    };
    std::vector<PendingSPCNode> m_pending_spc_nodes;
    std::vector<PendingSPCSet> m_pending_spc_sets;

    std::unordered_map<int64_t, int> m_id_to_node_index;
    std::unordered_map<int64_t, int> m_id_to_elem_index;
    std::unordered_map<int64_t, int> m_id_to_beam_index;
    std::unordered_map<int, BeamSectionProps> m_secid_to_beam_props;
    std::unordered_map<int, int> m_part_to_secid;
    std::unordered_map<int, int> m_part_to_matid;
    std::unordered_map<int, PartInfo> m_parts;
    std::unordered_map<int, SetInfo> m_sets;
    std::map<int, MaterialTable3D> m_imported_materials;
};

} // namespace Blast

#endif // LS_DYNA_READER_3D_HPP
