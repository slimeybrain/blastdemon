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
    bool convert_failed_elements_to_mpm{false}; // Global conversion of failed FEM elements to MPM debris
    int mpm_particles_per_failed_element{8};    // Particles generated per failed element (1, 8, or 27)
    T material_heterogeneity{0.08f};            // Spatial Weibull material strength variance (0.0 to 0.30)
    T debris_velocity_smoothing{0.25f};         // Inter-element debris birth velocity smoothing factor (0.0 to 1.0)
    T debris_clumping{0.40f};                   // Multi-element aggregate clumping cohesion (0.0 for soil/water, 0.4 concrete, 0.8+ steel)
    int debris_max_clump_size{8};               // Maximum adjacent elements fused into a single fragment boulder/shred (1 to 64)
    int random_seed{42};                        // Persistent random seed for exact deterministic repeatability
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
struct alignas(32) FEMGaussPointHistory3D {
    T F_gp[8][3][3];
    T s_dev_gp[8][3][3];
    T ep_bar_gp[8];
    T temp_gp[8];
    T damage_gp[8];
    T lambda_gp[8];
};

template <typename T>
struct alignas(32) FEMElement3D {
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
    bool mpm_converted{false}; // Converted to MPM debris particles
    int mat_id{0};       // Material Table ID
    int part_id{0};      // LS-DYNA Part ID
    int64_t lsdyna_id{-1}; // Original LS-DYNA element ID
};

enum class FEMBeamFormulation {
    AxialTruss1D,     // Fast 1D axial tension/compression (3 DOFs/node, 0 rotational memory)
    TimoshenkoBeam3D  // Full 3D Timoshenko structural beam (6 DOFs/node: axial, biaxial bending, shear, torsion, plastic hinges)
};

template <typename T>
struct alignas(32) FEMTrussElement3D {
    int node_ids[2];        // 8 bytes (2 node indices)
    T A{0.0f};              // 4 bytes (Cross-sectional area)
    T L0{0.0f};             // 4 bytes (Reference length at t=0)
    T eps_p{0.0f};          // 4 bytes (Signed axial plastic strain)
    T ep_bar{0.0f};         // 4 bytes (Accumulated equivalent plastic strain)
    T sigma{0.0f};          // 4 bytes (Current axial Cauchy stress)
    T failure_strain{0.20f};// 4 bytes (Plastic failure strain)
    int mat_id{0};          // 2 bytes (Material table index)
    int part_id{0};         // 2 bytes (Part ID)
    bool is_eroded{false};  // 1 byte
    int64_t lsdyna_id{-1};  // Original LS-DYNA element ID
};

template <typename T>
struct alignas(64) FEMBeam3DElement {
    int node_ids[2];            // 2 global translational node indices
    int rot_node_ids[2];        // 2 indices into m_rot_nodes sparse table
    T A{0.0f};                  // Cross-sectional area
    T d{0.012f};                // Cross-section diameter (for circular rebar)
    T I2{0.0f}, I3{0.0f};       // Area moments of inertia
    T J{0.0f};                  // Torsional polar constant
    T Zp{0.0f};                 // Plastic section modulus
    T L0{0.0f};                 // Reference length at t=0
    T e2[3]{0, 1, 0};           // Co-rotational cross-section triad axis 2
    T e3[3]{0, 0, 1};           // Co-rotational cross-section triad axis 3
    T kappa2{0.0f}, kappa3{0.0f};// Bending curvatures about e2 and e3
    T gamma12{0.0f}, gamma13{0.0f}; // Transverse shear strains
    T kappa_tor{0.0f};          // Torsional twist angle per unit length
    T eps_p{0.0f};              // Signed axial plastic strain
    T ep_bar{0.0f};             // Accumulated equivalent plastic strain
    T failure_strain{0.20f};    // Plastic failure strain
    bool is_eroded{false};      // Erosion flag
    int mat_id{0};              // Material table index
    int part_id{0};             // Part ID
    int64_t lsdyna_id{-1};      // Original LS-DYNA element ID
};

template <typename T>
struct alignas(32) FEMNodeRotationalState3D {
    int global_node_id{-1};                // Index pointing back to global m_nodes array
    T omega[3]{0.0f, 0.0f, 0.0f};          // Nodal angular velocity (rad/s)
    T alpha[3]{0.0f, 0.0f, 0.0f};          // Nodal angular acceleration (rad/s^2)
    T m_int[3]{0.0f, 0.0f, 0.0f};          // Internal bending/torsional moment (N*m)
    T m_ext[3]{0.0f, 0.0f, 0.0f};          // External applied moment (N*m)
    T I_rot{0.0f};                         // Lumped scalar rotational inertia
    bool is_fixed[3]{false, false, false}; // Rotational SPC constraints (Rx, Ry, Rz)
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
    void setIntegrationScheme(FEMIntegrationScheme scheme) {
        m_integration_scheme = scheme;
        ensureGaussPointHistory();
    }
    void setHourglassModel(FEMHourglassModel model) { m_hourglass_model = model; }
    void setHourglassCoeff(T q_hg) { m_hourglass_coeff = q_hg; }
    void setPhysicsParams(const BlastPhysicsParams<T>& params) { m_physics_params = params; }
    void setErosionCriteria(const FEMErosionCriteria<T>& criteria) {
        m_erosion_criteria = criteria;
        for (auto& mat : m_material_tables) {
            if (criteria.enable_strain_erosion) {
                mat.enable_strain_erosion = true;
                if (criteria.failure_strain > static_cast<T>(0.0f)) {
                    mat.erosion_strain = static_cast<float>(criteria.failure_strain);
                    mat.failure_strain = static_cast<float>(criteria.failure_strain);
                }
            }
            if (criteria.enable_stress_erosion) {
                mat.enable_stress_erosion = true;
                if (criteria.tensile_failure_stress > static_cast<T>(0.0f)) {
                    mat.erosion_stress = static_cast<float>(criteria.tensile_failure_stress);
                    mat.tensile_failure_stress = static_cast<float>(criteria.tensile_failure_stress);
                }
            }
            if (criteria.enable_timestep_erosion) {
                mat.enable_timestep_erosion = true;
                if (criteria.timestep_erosion_factor > static_cast<T>(0.0f)) {
                    mat.timestep_erosion_factor = static_cast<float>(criteria.timestep_erosion_factor);
                }
            }
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
    BlastPhysicsParams<T>& getPhysicsParams() { return m_physics_params; }
    const FEMErosionCriteria<T>& getErosionCriteria() const { return m_erosion_criteria; }
    FEMErosionCriteria<T>& getErosionCriteria() { return m_erosion_criteria; }

    // Mesh Builders (Structured Box & Cylinder Generators)
    void createStructuredBoxMesh(int nx, int ny, int nz, T lx, T ly, T lz, T pos_x, T pos_y, T pos_z, const MaterialTable3D& material, const std::string& boundary_condition = "Free");
    void addStructuredBoxMesh(int nx, int ny, int nz, T lx, T ly, T lz, T pos_x, T pos_y, T pos_z, const MaterialTable3D& material, T vel_x = static_cast<T>(0), T vel_y = static_cast<T>(0), T vel_z = static_cast<T>(0), const std::string& boundary_condition = "Free");
    void createStructuredCylinderMesh(int nr, int nz, T radius, T height, T pos_x, T pos_y, T pos_z, const MaterialTable3D& material, T inner_radius = static_cast<T>(0), const std::string& boundary_condition = "Free");
    void addStructuredCylinderMesh(int nr, int nz, T radius, T height, T pos_x, T pos_y, T pos_z, const MaterialTable3D& material, T vel_x = static_cast<T>(0), T vel_y = static_cast<T>(0), T vel_z = static_cast<T>(0), T inner_radius = static_cast<T>(0), const std::string& boundary_condition = "Free");
    
    // Mesh Direct Loaders
    int addNode(T x, T y, T z, T mass = static_cast<T>(1.0f)) {
        FEMNode3D<T> n{};
        n.x[0] = x; n.x[1] = y; n.x[2] = z;
        n.m = mass;
        n.lsdyna_id = static_cast<int64_t>(m_nodes.size() + 1);
        m_nodes.push_back(n);
        return static_cast<int>(m_nodes.size() - 1);
    }

    void setNodesAndElements(const std::vector<FEMNode3D<T>>& nodes, const std::vector<FEMElement3D<T>>& elements, const MaterialTable3D& mat);
    void appendNodesAndElements(const std::vector<FEMNode3D<T>>& nodes, const std::vector<FEMElement3D<T>>& elements, const MaterialTable3D& mat);

    // Rebar Truss & 3D Beam Mesh Direct Loaders
    void addTruss(int n1, int n2, T area, const MaterialTable3D& mat, T failure_strain = static_cast<T>(0.20f), int64_t lsdyna_id = -1);
    void addBeam3D(int n1, int n2, T diameter, const MaterialTable3D& mat, T failure_strain = static_cast<T>(0.20f), int64_t lsdyna_id = -1);

    // Explicit Solver Phases & Modular Evaluation
    void computeTrussForces1D(T dt);
    void computeBeamForces3D(T dt);
    void updateNodeErosionStatus();
    void computeLumpedMasses();
    void evaluateErosionCriteria();
    void processErodedElementsToMPM();

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

    std::vector<FEMTrussElement3D<T>>& getTrusses() { return m_trusses; }
    const std::vector<FEMTrussElement3D<T>>& getTrusses() const { return m_trusses; }

    std::vector<FEMBeam3DElement<T>>& getBeams() { return m_beams; }
    const std::vector<FEMBeam3DElement<T>>& getBeams() const { return m_beams; }

    std::vector<FEMNodeRotationalState3D<T>>& getRotationalNodes() { return m_rot_nodes; }
    const std::vector<FEMNodeRotationalState3D<T>>& getRotationalNodes() const { return m_rot_nodes; }

    std::vector<FEMGaussPointHistory3D<T>>& getGaussPointHistory() { return m_gp_history; }
    const std::vector<FEMGaussPointHistory3D<T>>& getGaussPointHistory() const { return m_gp_history; }
    void ensureGaussPointHistory();

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

    // Multi-Physics Coupling & MPM Particle Conversion
    void setMPMSolver(MPMSolver3D* mpm_solver) { m_mpm_solver = mpm_solver; }
    void setMPMSolver(std::shared_ptr<MPMSolver3D> mpm_solver) { m_mpm_solver_ref = mpm_solver; m_mpm_solver = mpm_solver.get(); }
    MPMSolver3D* getMPMSolver() const { return m_mpm_solver; }
    void convertElementToMPMParticles(const FEMElement3D<T>& elem, std::vector<MPMParticle3D>& out_particles, const float* v_cluster_com = nullptr) const;

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
    void computeElementForces(T dt);
    void computeHourglassForcesFB(FEMElement3D<T>& elem, T dt, const T x_nodes[8][3], const T v_nodes[8][3], const T B[6][24], const T dN_dx[8][3], T detJ, T cd, T char_len);
    void updateKinematicsCentralDifference(T dt);
    void updateRotationalKinematicsCentralDifference(T dt);
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
    std::vector<FEMTrussElement3D<T>> m_trusses;
    std::vector<FEMBeam3DElement<T>> m_beams;
    std::vector<FEMNodeRotationalState3D<T>> m_rot_nodes;
    std::vector<int> m_global_to_rot_node;
    std::vector<FEMGaussPointHistory3D<T>> m_gp_history;
    std::vector<FEMFacet3D<T>> m_surface_facets;
    std::vector<MaterialTable3D> m_material_tables;
    bool m_surface_facets_dirty{true};

    // Time Integration State
    T m_sim_time{0.0f};
    T m_last_dt{1.0e-6f};
    T m_last_cfl{0.3f};
    int m_step_count{0};

    // Multi-Physics Solver References
    MPMSolver3D* m_mpm_solver{nullptr};
    std::shared_ptr<MPMSolver3D> m_mpm_solver_ref{nullptr};

    void* m_cuda_stream{nullptr};
};

} // namespace Blast

#endif // FEM_SOLVER_3D_HPP
