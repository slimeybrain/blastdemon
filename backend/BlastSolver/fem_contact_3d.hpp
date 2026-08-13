#ifndef FEM_CONTACT_3D_HPP
#define FEM_CONTACT_3D_HPP

#include "fem_solver_3d.hpp"
#include <vector>
#include <unordered_map>
#include <cmath>
#include <cstdint>

namespace Blast {

template <typename T>
struct ContactPairCandidate {
    int node_idx;
    int facet_idx;
};

template <typename T>
class FEMContact3D {
public:
    FEMContact3D();
    ~FEMContact3D() = default;

    void setContactPenaltyScale(T scale) { m_penalty_scale = scale; }
    void setContactStiffness(T k_stiff) { m_penalty_scale = (k_stiff > static_cast<T>(100.0f)) ? static_cast<T>(1.0f) : k_stiff; }
    T getContactPenaltyScale() const { return m_penalty_scale; }
    void setFrictionCoefficients(T mu_static, T mu_kinetic) {
        m_mu_static = mu_static;
        m_mu_kinetic = mu_kinetic;
    }
    T getFrictionStatic() const { return m_mu_static; }
    T getFrictionKinetic() const { return m_mu_kinetic; }
    void setContactDamping(T damping) { m_contact_damping = std::max(static_cast<T>(0.0f), std::min(static_cast<T>(1.0f), damping)); }
    T getContactDamping() const { return m_contact_damping; }

    void solveContact(FEMSolver3D<T>& solver, T dt);

private:
    void updateDynamicSurfaceNormals(FEMSolver3D<T>& solver);
    void buildSpatialHash(FEMSolver3D<T>& solver);
    void findCandidatePairs(FEMSolver3D<T>& solver);
    void applyPenaltyForces(FEMSolver3D<T>& solver, T dt);

    T m_penalty_scale{1.0f};
    T m_mu_static{0.3f};
    T m_mu_kinetic{0.2f};
    T m_contact_damping{0.2f};
    T m_cell_size{0.05f};

    // Pre-allocated spatial grid buffers to guarantee zero in-loop allocation
    std::unordered_map<int64_t, std::vector<int>> m_bucket_nodes;
    std::unordered_map<int64_t, std::vector<int>> m_bucket_facets;
    std::vector<ContactPairCandidate<T>> m_candidate_pairs;

    std::vector<bool> m_is_surface_node;
    std::vector<int> m_node_part_id;
    std::vector<std::vector<int>> m_node_facets;
    std::vector<std::array<std::array<T, 3>, 4>> m_facet_corner_normals;
    std::vector<T> m_node_f_mag;
    std::vector<std::array<T, 3>> m_node_f_dir;
    std::vector<int> m_node_f_facet_idx;
    std::vector<std::array<T, 4>> m_node_N_shape;
};

} // namespace Blast

#endif // FEM_CONTACT_3D_HPP
