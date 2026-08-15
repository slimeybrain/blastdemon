#ifndef LS_DYNA_READER_3D_HPP
#define LS_DYNA_READER_3D_HPP

#include "fem_solver_3d.hpp"
#include <string>
#include <vector>
#include <unordered_map>
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

    int getNodeCount() const { return static_cast<int>(m_id_to_node_index.size()); }
    int getElementCount() const { return static_cast<int>(m_id_to_elem_index.size()); }
    int getBeamCount() const { return static_cast<int>(m_id_to_beam_index.size()); }

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

    std::string trim(const std::string& str) const;
    std::vector<std::string> splitLine(const std::string& line) const;
    T parseFieldVal(const std::string& line, int field_idx, T default_val = 0.0f) const;

    std::unordered_map<int64_t, int> m_id_to_node_index;
    std::unordered_map<int64_t, int> m_id_to_elem_index;
    std::unordered_map<int64_t, int> m_id_to_beam_index;
    std::unordered_map<int, BeamSectionProps> m_secid_to_beam_props;
    std::unordered_map<int, int> m_part_to_secid;
};

} // namespace Blast

#endif // LS_DYNA_READER_3D_HPP
