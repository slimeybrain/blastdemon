#ifndef FEM_SOLVER_3D_HPP
#define FEM_SOLVER_3D_HPP

#include "mpm_solver_3d.hpp"
#include <vector>
#include <array>
#include <memory>
#include <string>
#include <cmath>
#include <algorithm>
#include <unordered_map>
#include <cstdint>

#ifdef __CUDACC__
#include <cuda_runtime.h>
#define HD_FEM_FUNC __host__ __device__
#else
#define HD_FEM_FUNC
#endif

namespace Blast {

enum class FEMIntegrationScheme {
    OnePointFB,       // 1-Point Reduced Integration with Flanagan-Belytschko Hourglass Control
    OnePointKF,       // 1-Point Reduced Integration with Kosloff-Frazier Stabilization
    FullGauss8,       // 8-Point (2x2x2) Gauss Quadrature Integration
    SelectiveReduced  // Selective Reduced Integration (SRI / B-bar volumetric anti-locking)
};

enum class FEMHourglassModel {
    FlanaganBelytschkoStiffness,
    FlanaganBelytschkoViscous,
    KosloffFrazier
};

template <typename T>
struct BlastPhysicsParams {
    T bulk_viscosity_b1{0.06f};   // Linear artificial bulk viscosity coefficient
    T bulk_viscosity_b2{1.20f};   // Quadratic (Von Neumann-Richtmyer) bulk viscosity coefficient
    T cowper_symonds_C{40.0f};     // Cowper-Symonds strain rate constant C (1/s)
    T cowper_symonds_P{5.0f};      // Cowper-Symonds strain rate exponent P
    T taylor_quinney_factor{0.9f}; // Fraction of plastic work converted to heat (0.9)
};

template <typename T>
struct FEMErosionCriteria {
    T timestep_erosion_factor{0.10f};  // Erode when dt_e <= eta * dt_e,0 (default 0.10)
    T failure_strain{0.50f};           // Equivalent plastic strain threshold
    T tensile_failure_stress{600.0e6f};// Tensile failure stress threshold (Pa)
    T min_volume_ratio{0.05f};         // V / V0 minimum compression ratio limit
    T max_volume_ratio{5.00f};         // V / V0 maximum expansion ratio limit
    T max_damage{1.0f};                // Johnson-Cook cumulative damage threshold D >= 1.0
    bool enable_timestep_erosion{false};
    bool enable_strain_erosion{false};
    bool enable_stress_erosion{false};
    bool enable_damage_erosion{false};
};

template <typename T>
struct alignas(32) FEMNode3D {
    T x[3];         // Current nodal position (x, y, z)
    T x0[3];        // Initial reference nodal position (x0, y0, z0)
    T v[3];         // Nodal velocity (vx, vy, vz)
    T a[3];         // Nodal acceleration (ax, ay, az)
    T f_ext[3];     // External forces (FSI, pressure, gravity)
    T f_int[3];     // Internal stress forces
    T f_contact[3]; // Frictional penalty contact forces
    T m{0.0f};      // Lumped mass
    bool is_fixed[3]{false, false, false}; // Constrained degrees of freedom (SPC)
    bool is_eroded{false};
    int64_t lsdyna_id{-1}; // Original LS-DYNA node ID
};

template <typename T>
struct FEMElement3D {
    int node_ids[8];     // 8 node indices forming Hex8 element
    T V0{0.0f};          // Initial reference element volume
    T V{0.0f};           // Current element volume
    T dt0{1.0e30f};      // Baseline initial acoustic timestep at t=0
    T F[3][3];           // Deformation gradient tensor (3x3)
    T s_dev[3][3];       // Deviatoric Cauchy stress tensor (3x3 symmetric)
    T sigma[3][3];       // Cauchy stress tensor (3x3 symmetric)
    T ep_bar{0.0f};      // Equivalent plastic strain
    T temperature{293.0f}; // Local temperature (K)
    T damage{0.0f};      // Scalar damage D in [0, 1]
    T lambda{0.0f};      // Modified damage scaling parameter (K&C / CSCM cap)
    T q_visc{0.0f};      // Artificial bulk viscosity pressure
    bool is_eroded{false};
    int mat_id{0};       // Material Table ID
    int part_id{0};      // LS-DYNA Part ID
    int64_t lsdyna_id{-1}; // Original LS-DYNA element ID

    // Gauss Point history variables for FullGauss8 and SelectiveReduced integration
    T F_gp[8][3][3];
    T s_dev_gp[8][3][3];
    T ep_bar_gp[8];
    T temp_gp[8];
    T damage_gp[8];
    T lambda_gp[8];
};

template <typename T>
struct FEMFacet3D {
    int node_ids[4];   // 4 nodes forming a quadrilateral boundary facet
    T normal[3];       // Outward unit normal vector (nx, ny, nz)
    T area{0.0f};      // Facet surface area
    T bbox_min[3]{0.0f, 0.0f, 0.0f}; // Precomputed AABB minimum bounds (with margin)
    T bbox_max[3]{0.0f, 0.0f, 0.0f}; // Precomputed AABB maximum bounds (with margin)
    int element_id{-1};
    int part_id{-1};
    bool is_eroded{false};
};

template <typename T>
struct FEMEnergyTracker {
    T E_kin{0.0f};     // Total kinetic energy
    T E_int{0.0f};     // Total internal strain energy
    T E_visc{0.0f};    // Artificial bulk viscosity energy
    T E_hg{0.0f};      // Hourglass dissipation energy
    T E_contact{0.0f}; // Contact penalty energy
    T E_total{0.0f};   // Sum of all energy components
    T E_0{0.0f};       // Reference initial energy at t=0
    
    T getEnergyRatio() const {
        return (E_0 > static_cast<T>(1.0e-12)) ? (E_total / E_0) : static_cast<T>(1.0);
    }
};

template <typename T>
struct SpatialHashBucket3D {
    int start_index{0};
    int count{0};
};

template <typename T>
class FEMSolver3D {
public:
    FEMSolver3D();
    ~FEMSolver3D();

    // Setup & Configuration
    void initializeDomain(T xmin, T xmax, T ymin, T ymax, T zmin, T zmax);
    void setIntegrationScheme(FEMIntegrationScheme scheme) { m_integration_scheme = scheme; }
    void setHourglassModel(FEMHourglassModel model) { m_hourglass_model = model; }
    void setHourglassCoeff(T q_hg) { m_hourglass_coeff = q_hg; }
    void setPhysicsParams(const BlastPhysicsParams<T>& params) { m_physics_params = params; }
    void setErosionCriteria(const FEMErosionCriteria<T>& criteria) {
        m_erosion_criteria = criteria;
        for (auto& mat : m_material_tables) {
            if (criteria.enable_strain_erosion) mat.enable_strain_erosion = true;
            if (criteria.enable_stress_erosion) mat.enable_stress_erosion = true;
            if (criteria.enable_timestep_erosion) mat.enable_timestep_erosion = true;
        }
    }
    void setContactPenaltyScale(T scale) { m_contact_penalty_scale = scale; }
    void setFrictionCoefficients(T mu_static, T mu_kinetic) { m_friction_static = mu_static; m_friction_kinetic = mu_kinetic; }
    void setContactDamping(T damping) { m_contact_damping = std::max(static_cast<T>(0.0f), std::min(static_cast<T>(1.0f), damping)); }
    
    FEMIntegrationScheme getIntegrationScheme() const { return m_integration_scheme; }
    FEMHourglassModel getHourglassModel() const { return m_hourglass_model; }
    T getHourglassCoeff() const { return m_hourglass_coeff; }
    T getContactPenaltyScale() const { return m_contact_penalty_scale; }
    T getFrictionStatic() const { return m_friction_static; }
    T getFrictionKinetic() const { return m_friction_kinetic; }
    T getContactDamping() const { return m_contact_damping; }
    const BlastPhysicsParams<T>& getPhysicsParams() const { return m_physics_params; }
    const FEMErosionCriteria<T>& getErosionCriteria() const { return m_erosion_criteria; }

    // Mesh Builders (Structured Box & Cylinder Generators)
    void createStructuredBoxMesh(int nx, int ny, int nz, T lx, T ly, T lz, T pos_x, T pos_y, T pos_z, const MaterialTable3D& material, const std::string& boundary_condition = "Free");
    void addStructuredBoxMesh(int nx, int ny, int nz, T lx, T ly, T lz, T pos_x, T pos_y, T pos_z, const MaterialTable3D& material, T vel_x = static_cast<T>(0), T vel_y = static_cast<T>(0), T vel_z = static_cast<T>(0), const std::string& boundary_condition = "Free");
    void createStructuredCylinderMesh(int nr, int nz, T radius, T height, T pos_x, T pos_y, T pos_z, const MaterialTable3D& material, T inner_radius = static_cast<T>(0), const std::string& boundary_condition = "Free");
    void addStructuredCylinderMesh(int nr, int nz, T radius, T height, T pos_x, T pos_y, T pos_z, const MaterialTable3D& material, T vel_x = static_cast<T>(0), T vel_y = static_cast<T>(0), T vel_z = static_cast<T>(0), T inner_radius = static_cast<T>(0), const std::string& boundary_condition = "Free");
    
    // Mesh Direct Loaders
    void setNodesAndElements(const std::vector<FEMNode3D<T>>& nodes, const std::vector<FEMElement3D<T>>& elements, const MaterialTable3D& mat);
    void appendNodesAndElements(const std::vector<FEMNode3D<T>>& nodes, const std::vector<FEMElement3D<T>>& elements, const MaterialTable3D& mat);

    // Dynamic Execution Control
    void step(T cfl = 0.3f);
    void stepWithDt(T dt);
    T computeStepSize(T cfl = 0.3f) const;

    // Boundary Conditions & Rigid Bodies
    void setNodeFixed(int node_idx, bool fix_x, bool fix_y, bool fix_z);
    void setNodalVelocity(int node_idx, T vx, T vy, T vz);

    // Accessors & Telemetry
    std::vector<FEMNode3D<T>>& getNodes() { return m_nodes; }
    const std::vector<FEMNode3D<T>>& getNodes() const { return m_nodes; }

    std::vector<FEMElement3D<T>>& getElements() { return m_elements; }
    const std::vector<FEMElement3D<T>>& getElements() const { return m_elements; }

    std::vector<FEMFacet3D<T>>& getSurfaceFacets() { if (m_surface_facets_dirty) extractBoundaryFacets(); return m_surface_facets; }
    const std::vector<FEMFacet3D<T>>& getSurfaceFacets() const { if (m_surface_facets_dirty) const_cast<FEMSolver3D<T>*>(this)->extractBoundaryFacets(); return m_surface_facets; }
    void invalidateSurfaceFacets() { m_surface_facets_dirty = true; }

    const std::vector<MaterialTable3D>& getMaterialTables() const { return m_material_tables; }
    std::vector<MaterialTable3D>& getMaterialTables() { return m_material_tables; }

    const FEMEnergyTracker<T>& getEnergyTracker() const { return m_energy_tracker; }

    T getSimTime() const { return m_sim_time; }
    int getStepCount() const { return m_step_count; }
    T getLastDt() const { return m_last_dt; }
    T getLastCFL() const { return m_last_cfl; }
    T getMaxVelocity() const;
    T getMaxPlasticStrain() const;
    T getMaxVonMisesStress() const;

    // CUDA Stream Accessor
    void* getCudaStream() const { return m_cuda_stream; }

    void computeGlobalEnergy();

    void getMeshBoundingBox(T& min_x, T& max_x, T& min_y, T& max_y, T& min_z, T& max_z) const {
        if (m_nodes.empty()) {
            min_x = min_y = min_z = static_cast<T>(0);
            max_x = max_y = max_z = static_cast<T>(0);
            return;
        }
        min_x = max_x = m_nodes[0].x[0];
        min_y = max_y = m_nodes[0].x[1];
        min_z = max_z = m_nodes[0].x[2];
        for (size_t i = 1; i < m_nodes.size(); ++i) {
            const auto& n = m_nodes[i];
            if (n.x[0] < min_x) min_x = n.x[0];
            if (n.x[0] > max_x) max_x = n.x[0];
            if (n.x[1] < min_y) min_y = n.x[1];
            if (n.x[1] > max_y) max_y = n.x[1];
            if (n.x[2] < min_z) min_z = n.x[2];
            if (n.x[2] > max_z) max_z = n.x[2];
        }
    }

private:
    void computeLumpedMasses();
    void computeElementForces(T dt);
    void computeHourglassForcesFB(FEMElement3D<T>& elem, T dt, const T x_nodes[8][3], const T v_nodes[8][3], const T B[6][24], const T dN_dx[8][3], T detJ, T cd, T char_len);
    void updateKinematicsCentralDifference(T dt);
    void evaluateErosionCriteria();
    void updateNodeErosionStatus();
    void extractBoundaryFacets();
    void buildFaceConnectivity();

    std::vector<int> m_face_neighbors; // Size: m_elements.size() * 6. Stores neighbor element ID for each face (-1 if boundary).

    // Geometric Shape Function Derivatives for Hex8
    void computeHex8BMatrix(const T x_nodes[8][3], T B[6][24], T& detJ) const;

    // Domain Bounds
    T m_xmin{0.0f}, m_xmax{1.0f};
    T m_ymin{0.0f}, m_ymax{1.0f};
    T m_zmin{0.0f}, m_zmax{1.0f};

    // Scheme Parameters
    FEMIntegrationScheme m_integration_scheme{FEMIntegrationScheme::OnePointFB};
    FEMHourglassModel m_hourglass_model{FEMHourglassModel::FlanaganBelytschkoViscous};
    T m_hourglass_coeff{0.10f};

    BlastPhysicsParams<T> m_physics_params;
    FEMErosionCriteria<T> m_erosion_criteria;
    FEMEnergyTracker<T> m_energy_tracker;
    T m_contact_penalty_scale{1.0f};
    T m_friction_static{0.3f};
    T m_friction_kinetic{0.2f};
    T m_contact_damping{0.20f};
    int m_next_part_id{1};

    // Core Data Containers
    std::vector<FEMNode3D<T>> m_nodes;
    std::vector<FEMElement3D<T>> m_elements;
    std::vector<FEMFacet3D<T>> m_surface_facets;
    std::vector<MaterialTable3D> m_material_tables;
    bool m_surface_facets_dirty{true};

    // Time Integration State
    T m_sim_time{0.0f};
    T m_last_dt{1.0e-6f};
    T m_last_cfl{0.3f};
    int m_step_count{0};

    void* m_cuda_stream{nullptr};
};

} // namespace Blast

#endif // FEM_SOLVER_3D_HPP
