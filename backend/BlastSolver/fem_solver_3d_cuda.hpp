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
    const MaterialTable3D* d_materials,
    BlastPhysicsParams<T> physics_params,
    T dt,
    T hourglass_coeff,
    FEMHourglassModel hg_model,
    FEMIntegrationScheme integration_scheme,
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
    FEMElement3D<T>* d_elements,
    int num_elements,
    FEMErosionCriteria<T> erosion_criteria,
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
    void setContactPenaltyScale(T scale) { m_cpu_solver.setContactPenaltyScale(scale); }
    void setFrictionCoefficients(T mu_s, T mu_k) { m_cpu_solver.setFrictionCoefficients(mu_s, mu_k); }

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

    T getSimTime() const { return m_sim_time; }
    int getStepCount() const { return m_step_count; }
    T getLastDt() const { return m_last_dt; }
    T getLastCFL() const { return m_last_cfl; }
    T getMaxVelocity() const { syncToHost(); return m_cpu_solver.getMaxVelocity(); }
    T getMaxPlasticStrain() const { syncToHost(); return m_cpu_solver.getMaxPlasticStrain(); }
    T getMaxVonMisesStress() const { syncToHost(); return m_cpu_solver.getMaxVonMisesStress(); }

    const FEMEnergyTracker<T>& getEnergyTracker() const { syncToHost(); return m_cpu_solver.getEnergyTracker(); }
    FEMSolver3D<T>& getCpuSolver() { return m_cpu_solver; }

private:
    FEMSolver3D<T> m_cpu_solver;
    FEMNode3D<T>* m_d_nodes{nullptr};
    FEMElement3D<T>* m_d_elements{nullptr};
    MaterialTable3D* m_d_materials{nullptr};
    size_t m_allocated_nodes{0};
    size_t m_allocated_elements{0};
    size_t m_allocated_materials{0};

    cudaStream_t m_cuda_stream{nullptr};
    T m_sim_time{0.0f};
    T m_last_dt{1.0e-6f};
    T m_last_cfl{0.3f};
    int m_step_count{0};
    mutable bool m_gpu_dirty{false};
};

} // namespace Blast

#endif // FEM_SOLVER_3D_CUDA_HPP
