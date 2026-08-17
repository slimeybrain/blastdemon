#ifndef FEM_FSI_COUPLER_3D_CUDA_HPP
#define FEM_FSI_COUPLER_3D_CUDA_HPP

#include "fem_solver_3d_cuda.hpp"
#include "cfd_solver_3d_cuda.hpp"
#include "fem_fsi_coupler_3d.hpp"
#if defined(__CUDACC__) || defined(__CUDA_ARCH__) || defined(BLAST_ENABLE_CUDA)
#include <cuda_runtime.h>
#else
typedef struct CUstream_st* cudaStream_t;
#endif
#include <memory>
#include <vector>

namespace Blast {

template <typename T>
class FEMFSICoupler3DCUDA {
public:
    FEMFSICoupler3DCUDA();
    ~FEMFSICoupler3DCUDA();

    // Attach GPU Eulerian FV solver and GPU Lagrangian FEM solver
    void attachSolvers(CFDSolver3D* fv_solver, FEMSolver3DCUDA<T>* fem_solver);

    void step(T cfl = static_cast<T>(0.6f));
    void stepWithDt(T dt);

    T computeCoupledDt(T cfl = static_cast<T>(0.6f)) const;

    T getSimTime() const { return m_sim_time; }
    int getStepCount() const { return m_step_count; }
    T getLastDt() const { return m_last_dt; }
    T getAccumulatedWork() const { return m_accumulated_work_fsi; }

    void setVacuumState(T rho_vac, T p_vac) { m_rho_vac = rho_vac; m_p_vac = p_vac; }
    void setPressureIntegration(FSIPressureIntegration integ) { m_pressure_integ = integ; }

    void resetCoupledDt() { m_cfl_subcycle_counter = 0; }

private:
    void executeGPUCoupling(T dt);

    CFDSolver3D* m_fv_solver{nullptr};
    FEMSolver3DCUDA<T>* m_fem_solver{nullptr};

    FSIPressureIntegration m_pressure_integ{FSIPressureIntegration::Gauss2x2};
    T m_rho_vac{static_cast<T>(1.0e-6f)};
    T m_p_vac{static_cast<T>(1.0e-2f)};

    T m_sim_time{static_cast<T>(0.0f)};
    T m_last_dt{static_cast<T>(1.0e-6f)};
    int m_step_count{0};
    T m_accumulated_work_fsi{static_cast<T>(0.0f)};

    // Timestep Subcycling Optimization
    mutable T m_cached_dt{static_cast<T>(1.0e-6f)};
    mutable int m_cfl_subcycle_counter{0};
    static constexpr int CFL_SUBCYCLE_INTERVAL{8};

    // GPU Device Staging Memory
    T* m_d_fsi_work{nullptr};
    cudaStream_t m_stream{nullptr};
};

template <typename T>
void launch_zero_fem_ext_forces_3d(
    FEMNode3D<T>* d_nodes,
    int num_nodes,
    cudaStream_t stream = 0
);

template <typename T>
void launch_rasterize_fem_elements_to_geom_3d(
    const FEMNode3D<T>* d_nodes,
    const FEMElement3D<T>* d_elements,
    int num_elements,
    GeometryTile3D* d_geom,
    SolidVelocityTile3D* d_solid_vel,
    int nx, int ny, int nz,
    int ntx, int nty,
    float dx, float dy, float dz,
    float xmin, float ymin, float zmin,
    cudaStream_t stream = 0
);

template <typename T>
void launch_rasterize_fem_facets_to_geom_3d(
    const FEMNode3D<T>* d_nodes,
    const FEMFacet3D<T>* d_facets,
    int num_facets,
    GeometryTile3D* d_geom,
    SolidVelocityTile3D* d_solid_vel,
    int nx, int ny, int nz,
    int ntx, int nty,
    float dx, float dy, float dz,
    float xmin, float ymin, float zmin,
    cudaStream_t stream = 0
);

template <typename T, typename RealType, bool IsMultiMaterial>
void launch_integrate_cfd_pressure_to_fem_nodes_3d(
    const PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    const GeometryTile3D* d_geom,
    FEMNode3D<T>* d_nodes,
    const FEMFacet3D<T>* d_facets,
    int num_facets,
    int nx, int ny, int nz,
    int ntx, int nty,
    float dx, float dy, float dz,
    float xmin, float ymin, float zmin,
    float ambient_p = 101325.0f,
    cudaStream_t stream = 0
);

} // namespace Blast

#endif // FEM_FSI_COUPLER_3D_CUDA_HPP
