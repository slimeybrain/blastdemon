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

    int getNodeCount() const { return static_cast<int>(m_id_to_node_index.size()); }
    int getElementCount() const { return static_cast<int>(m_id_to_elem_index.size()); }

private:
    bool parseStream(
        const std::string& filepath,
        std::vector<FEMNode3D<T>>& out_nodes,
        std::vector<FEMElement3D<T>>& out_elements,
        MaterialTable3D& out_default_mat,
        std::vector<MaterialTable3D>& out_materials,
        int depth = 0
    );

    std::string trim(const std::string& str) const;
    std::vector<std::string> splitLine(const std::string& line) const;
    T parseFieldVal(const std::string& line, int field_idx, T default_val = 0.0f) const;

    std::unordered_map<int64_t, int> m_id_to_node_index;
    std::unordered_map<int64_t, int> m_id_to_elem_index;
};

} // namespace Blast

#endif // LS_DYNA_READER_3D_HPP
