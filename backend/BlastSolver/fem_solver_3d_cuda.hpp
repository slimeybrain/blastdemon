#ifndef FEM_SOLVER_3D_CUDA_HPP
#define FEM_SOLVER_3D_CUDA_HPP

#include "fem_solver_3d.hpp"
#if defined(__CUDACC__) || defined(__CUDA_ARCH__) || defined(BLAST_ENABLE_CUDA)
#include <cuda_runtime.h>
#else
typedef struct CUstream_st* cudaStream_t;
#endif
#include <vector>
#include <string>

namespace Blast {

class MPMSolver3DCUDA;

template <typename T>
void launch_fem_reset_nodal_forces_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    cudaStream_t stream
);

template <typename T>
void launch_fem_element_forces_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    FEMElement3D<T>* d_elements,
    int num_elements,
    FEMGaussPointHistory3D<T>* d_gp_history,
    const MaterialTable3D* d_materials,
    BlastPhysicsParams<T> physics_params,
    T dt,
    T hourglass_coeff,
    FEMHourglassModel hg_model,
    FEMIntegrationScheme integration_scheme,
    cudaStream_t stream
);

template <typename T>
void launch_fem_truss_forces_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    FEMTrussElement3D<T>* d_trusses,
    int num_trusses,
    const MaterialTable3D* d_materials,
    T dt,
    cudaStream_t stream
);

template <typename T>
void launch_fem_beam_forces_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    FEMBeam3DElement<T>* d_beams,
    int num_beams,
    FEMNodeRotationalState3D<T>* d_rot_nodes,
    int num_rot_nodes,
    const MaterialTable3D* d_materials,
    T dt,
    cudaStream_t stream
);

template <typename T>
void launch_fem_nodal_half_step_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    T dt,
    cudaStream_t stream
);

template <typename T>
void launch_fem_nodal_full_step_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    T dt,
    cudaStream_t stream
);


template <typename T>
void launch_fem_initial_timestep_erosion_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    FEMElement3D<T>* d_elements,
    int num_elements,
    const FEMTrussElement3D<T>* d_trusses,
    int num_trusses,
    const FEMBeam3DElement<T>* d_beams,
    int num_beams,
    const MaterialTable3D* d_materials,
    FEMErosionCriteria<T> erosion_criteria,
    int* d_node_active_count,
    int* d_erosion_flag,
    cudaStream_t stream
);

template <typename T>
void launch_fem_update_orphan_nodes_erosion_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    const FEMTrussElement3D<T>* d_trusses,
    int num_trusses,
    const FEMBeam3DElement<T>* d_beams,
    int num_beams,
    int* d_node_active_count,
    cudaStream_t stream
);

template <typename T>
void launch_fem_update_surface_facets_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    FEMFacet3D<T>* d_facets,
    int num_facets,
    T* d_node_normals,
    cudaStream_t stream
);

template <typename T>
void launch_fem_contact_forces_kernel_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    const FEMFacet3D<T>* d_facets,
    int num_facets,
    const int* d_surface_nodes,
    int num_surface_nodes,
    const int* d_node_part_id,
    const int* d_part_mat_id,
    int max_parts,
    const T* d_node_normals,
    const MaterialTable3D* d_materials,
    T contact_penalty_scale,
    T mu_static,
    T mu_kinetic,
    T contact_damping,
    T dt,
    cudaStream_t stream
);

struct MPMParticle3DSoA;

template <typename T>
void launch_fem_mpm_debris_contact_kernel_3d(
    MPMParticle3DSoA soa,
    int num_particles,
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    const FEMFacet3D<T>* d_facets,
    int num_facets,
    const FEMTrussElement3D<T>* d_trusses,
    int num_trusses,
    const FEMBeam3DElement<T>* d_beams,
    int num_beams,
    const MaterialTable3D* d_materials,
    T contact_penalty_scale,
    T mu_static,
    T mu_kinetic,
    T contact_damping,
    T dt,
    cudaStream_t stream
);

template <typename T>
T launch_fem_compute_step_size_kernel_3d(
    const FEMNode3D<T>* d_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    const MaterialTable3D* d_materials,
    T cfl,
    T* d_reduction_buffer,
    cudaStream_t stream
);

template <typename T>
class FEMSolver3DCUDA {
public:
    FEMSolver3DCUDA();
    ~FEMSolver3DCUDA();

    void initializeDomain(T xmin, T xmax, T ymin, T ymax, T zmin, T zmax) {
        m_cpu_solver.initializeDomain(xmin, xmax, ymin, ymax, zmin, zmax);
    }
    void setHourglassCoeff(T q_hg) { m_cpu_solver.setHourglassCoeff(q_hg); }
    void setHourglassModel(FEMHourglassModel model) { m_cpu_solver.setHourglassModel(model); }
    void setIntegrationScheme(FEMIntegrationScheme scheme) { m_cpu_solver.setIntegrationScheme(scheme); }
    void setPhysicsParams(const BlastPhysicsParams<T>& params) { m_cpu_solver.setPhysicsParams(params); }
    const BlastPhysicsParams<T>& getPhysicsParams() const { return m_cpu_solver.getPhysicsParams(); }
    BlastPhysicsParams<T>& getPhysicsParams() { return m_cpu_solver.getPhysicsParams(); }
    void setMPMSolver(MPMSolver3D* mpm) { m_cpu_solver.setMPMSolver(mpm); }
    MPMSolver3D* getMPMSolver() const { return m_cpu_solver.getMPMSolver(); }
    void setCUDAMPMSolver(MPMSolver3DCUDA* mpm) { m_cuda_mpm_solver = mpm; }
    MPMSolver3DCUDA* getCUDAMPMSolver() const { return m_cuda_mpm_solver; }
    void setErosionCriteria(const FEMErosionCriteria<T>& criteria);
    void setContactPenaltyScale(T scale) { m_cpu_solver.setContactPenaltyScale(scale); }
    void setContactDamping(T damping) { m_cpu_solver.setContactDamping(damping); }
    void setFrictionCoefficients(T mu_s, T mu_k) { m_cpu_solver.setFrictionCoefficients(mu_s, mu_k); }

    void createStructuredBoxMesh(int nx, int ny, int nz, T lx, T ly, T lz, T pos_x, T pos_y, T pos_z, const MaterialTable3D& mat, const std::string& bc = "Free") {
        m_cpu_solver.createStructuredBoxMesh(nx, ny, nz, lx, ly, lz, pos_x, pos_y, pos_z, mat, bc);
        syncToDevice();
    }

    void addStructuredBoxMesh(int nx, int ny, int nz, T lx, T ly, T lz, T pos_x, T pos_y, T pos_z, const MaterialTable3D& mat, T vx = static_cast<T>(0), T vy = static_cast<T>(0), T vz = static_cast<T>(0), const std::string& bc = "Free") {
        m_cpu_solver.addStructuredBoxMesh(nx, ny, nz, lx, ly, lz, pos_x, pos_y, pos_z, mat, vx, vy, vz, bc);
        syncToDevice();
    }

    void addStructuredCylinderMesh(int nr, int nz, T radius, T height, T pos_x, T pos_y, T pos_z, const MaterialTable3D& mat, T vx = static_cast<T>(0), T vy = static_cast<T>(0), T vz = static_cast<T>(0), T inner_r = static_cast<T>(0), const std::string& bc = "Free") {
        m_cpu_solver.addStructuredCylinderMesh(nr, nz, radius, height, pos_x, pos_y, pos_z, mat, vx, vy, vz, inner_r, bc);
        syncToDevice();
    }

    void setNodesAndElements(const std::vector<FEMNode3D<T>>& nodes, const std::vector<FEMElement3D<T>>& elements, const MaterialTable3D& mat) {
        m_cpu_solver.setNodesAndElements(nodes, elements, mat);
        syncToDevice();
    }

    void appendNodesAndElements(const std::vector<FEMNode3D<T>>& nodes, const std::vector<FEMElement3D<T>>& elements, const MaterialTable3D& mat) {
        m_cpu_solver.appendNodesAndElements(nodes, elements, mat);
        syncToDevice();
    }

    void setNodeFixed(int node_idx, bool fix_x, bool fix_y, bool fix_z) {
        m_cpu_solver.setNodeFixed(node_idx, fix_x, fix_y, fix_z);
        if (m_d_nodes) syncToDevice();
    }

    void addTruss(int n1, int n2, T area, const MaterialTable3D& mat, T failure_strain = static_cast<T>(0.20f), int64_t lsdyna_id = -1) {
        m_cpu_solver.addTruss(n1, n2, area, mat, failure_strain, lsdyna_id);
    }

    void addBeam3D(int n1, int n2, T diameter, const MaterialTable3D& mat, T failure_strain = static_cast<T>(0.20f), int64_t lsdyna_id = -1) {
        m_cpu_solver.addBeam3D(n1, n2, diameter, mat, failure_strain, lsdyna_id);
    }

    std::vector<FEMTrussElement3D<T>>& getTrusses() { return m_cpu_solver.getTrusses(); }
    const std::vector<FEMTrussElement3D<T>>& getTrusses() const { return m_cpu_solver.getTrusses(); }

    std::vector<FEMBeam3DElement<T>>& getBeams() { return m_cpu_solver.getBeams(); }
    const std::vector<FEMBeam3DElement<T>>& getBeams() const { return m_cpu_solver.getBeams(); }

    void syncToDevice();
    void syncToHost() const;

    void step(T cfl = 0.3f);
    void stepWithDt(T dt);

    std::vector<FEMNode3D<T>>& getNodes() { syncToHost(); return m_cpu_solver.getNodes(); }
    const std::vector<FEMNode3D<T>>& getNodes() const { syncToHost(); return m_cpu_solver.getNodes(); }

    std::vector<FEMElement3D<T>>& getElements() { syncToHost(); return m_cpu_solver.getElements(); }
    const std::vector<FEMElement3D<T>>& getElements() const { syncToHost(); return m_cpu_solver.getElements(); }

    std::vector<FEMFacet3D<T>>& getSurfaceFacets() { syncToHost(); return m_cpu_solver.getSurfaceFacets(); }
    const std::vector<FEMFacet3D<T>>& getSurfaceFacets() const { syncToHost(); return m_cpu_solver.getSurfaceFacets(); }

    size_t getNodeCount() const { return m_cpu_solver.getNodes().size(); }
    size_t getElementCount() const { return m_cpu_solver.getElements().size(); }
    size_t getSurfaceFacetCount() const { return m_num_surface_facets; }
    FEMFacet3D<T>* getSurfaceFacetsDevice() { return m_d_facets; }
    const FEMFacet3D<T>* getSurfaceFacetsDevice() const { return m_d_facets; }
    FEMElement3D<T>* getElementsDevice() { return m_d_elements; }
    const FEMElement3D<T>* getElementsDevice() const { return m_d_elements; }
    FEMGaussPointHistory3D<T>* getGaussPointHistoryDevice() { return m_d_gp_history; }
    const FEMGaussPointHistory3D<T>* getGaussPointHistoryDevice() const { return m_d_gp_history; }
    FEMNode3D<T>* getNodesDevice() { return m_d_nodes; }
    const FEMNode3D<T>* getNodesDevice() const { return m_d_nodes; }

    void extractTelemetry(std::vector<float>& h_node_data, std::vector<float>& h_facet_data) const;

    T getSimTime() const { return m_sim_time; }
    int getStepCount() const { return m_step_count; }
    T getLastDt() const { return m_last_dt; }
    T getLastCFL() const { return m_last_cfl; }
    T getMaxVelocity() const { return m_last_v_max; }
    T getMaxPlasticStrain() const { return m_last_ep_max; }
    T getMaxVonMisesStress() const { return m_last_vm_max; }

    T computeStepSize(T cfl = static_cast<T>(0.3f));
    T computeStableTimestep(T cfl = static_cast<T>(0.3f)) { return computeStepSize(cfl); }

    void getMeshBoundingBox(T& min_x, T& max_x, T& min_y, T& max_y, T& min_z, T& max_z) const {
        m_cpu_solver.getMeshBoundingBox(min_x, max_x, min_y, max_y, min_z, max_z);
    }

    const FEMEnergyTracker<T>& getEnergyTracker() const { return m_energy_tracker; }
    FEMSolver3D<T>& getCpuSolver() { return m_cpu_solver; }
    cudaStream_t getStream() const { return m_cuda_stream; }

    void evaluateErosionCriteria();

private:
    FEMSolver3D<T> m_cpu_solver;
    FEMNode3D<T>* m_d_nodes{nullptr};
    FEMElement3D<T>* m_d_elements{nullptr};
    FEMGaussPointHistory3D<T>* m_d_gp_history{nullptr};
    size_t m_allocated_gp_history{0};
    MaterialTable3D* m_d_materials{nullptr};
    FEMFacet3D<T>* m_d_facets{nullptr};
    int* m_d_surface_nodes{nullptr};
    int* m_d_node_part_id{nullptr};
    int* m_d_part_mat_id{nullptr};
    T* m_d_node_normals{nullptr};
    T* m_d_reduction_buffer{nullptr};
    int* m_d_node_active_count{nullptr};
    FEMTrussElement3D<T>* m_d_trusses{nullptr};
    size_t m_allocated_trusses{0};
    FEMBeam3DElement<T>* m_d_beams{nullptr};
    size_t m_allocated_beams{0};
    FEMNodeRotationalState3D<T>* m_d_rot_nodes{nullptr};
    size_t m_allocated_rot_nodes{0};
    int* m_d_erosion_flag{nullptr};
    int* m_h_erosion_flag_pinned{nullptr};

    // GPU Spatial Hash Grid for Contact
    int* m_d_cell_counts{nullptr};
    int* m_d_cell_facet_ids{nullptr};
    size_t m_spatial_grid_capacity{65536};
    static constexpr int MAX_FACETS_PER_CELL{32};

    // GPU Direct Telemetry Extraction Buffers
    mutable float* m_d_telemetry_nodes{nullptr};
    mutable float* m_d_telemetry_facets{nullptr};
    mutable size_t m_allocated_telemetry_nodes{0};
    mutable size_t m_allocated_telemetry_facets{0};

    size_t m_allocated_nodes{0};
    size_t m_allocated_elements{0};
    size_t m_allocated_materials{0};
    size_t m_allocated_facets{0};
    size_t m_allocated_surface_nodes{0};
    size_t m_allocated_node_parts{0};
    size_t m_allocated_part_mat_id{0};
    size_t m_num_surface_facets{0};
    size_t m_num_surface_nodes{0};
    int m_max_part_id{0};

    cudaStream_t m_cuda_stream{nullptr};
    T m_sim_time{0.0f};
    T m_last_dt{1.0e-6f};
    T m_last_cfl{0.3f};
    int m_step_count{0};
    mutable bool m_gpu_dirty{false};
    mutable bool m_topology_dirty{false};
    mutable T m_last_v_max{0.0f};
    mutable T m_last_vm_max{0.0f};
    mutable T m_last_ep_max{0.0f};
    mutable FEMEnergyTracker<T> m_energy_tracker{};
    MPMSolver3DCUDA* m_cuda_mpm_solver{nullptr};
};

} // namespace Blast

#endif // FEM_SOLVER_3D_CUDA_HPP
