#ifndef FEM_FSI_COUPLER_3D_HPP
#define FEM_FSI_COUPLER_3D_HPP

#include "fem_solver_3d.hpp"
#include "cfd_solver_3d.hpp"
#include "ImmersedBoundary.hpp"
#include <memory>
#include <vector>
#include <cmath>
#include <algorithm>
#include <iostream>

namespace Blast {

enum class FSIMethod3D {
    TwoWayStaggered,
    SubCycling
};

enum class FSIPressureIntegration {
    Gauss2x2,
    Centroid1Pt
};

enum class FSIUncoveringMethod {
    ConservativeIDW_VacuumCavity,
    StandardGhostFluid
};

template <typename T>
class FEMFSICoupler3D {
public:
    FEMFSICoupler3D();
    ~FEMFSICoupler3D() = default;

    // Attach Eulerian FV gas solver and Lagrangian FEM structural solver
    void attachSolvers(CFDSolver3D* fv_solver, FEMSolver3D<T>* fem_solver);

    // Configuration
    void setMethod(FSIMethod3D method) { m_method = method; }
    void setPressureIntegration(FSIPressureIntegration integ) { m_pressure_integ = integ; }
    void setUncoveringMethod(FSIUncoveringMethod uncov) { m_uncovering_method = uncov; }
    void setErosionVenting(bool enable) { m_erosion_venting = enable; }
    void setVacuumState(T rho_vac, T p_vac) { m_rho_vac = rho_vac; m_p_vac = p_vac; }

    // Dynamic Step execution
    void step(T cfl = static_cast<T>(0.6f));
    void stepWithDt(T dt);

    T computeCoupledDt(T cfl = static_cast<T>(0.6f)) const;

    // Energy & Work tracking
    T getSimTime() const { return m_sim_time; }
    int getStepCount() const { return m_step_count; }
    T getLastDt() const { return m_last_dt; }
    T getAccumulatedWork() const { return m_accumulated_work_fsi; }

    // Surface rasterization and pressure integration routines
    void rasterizeFEMFacetsToFVGrid();
    void handleCellTransitions();
    void applyFluidPressureToStructure(T dt);

private:
    CFDSolver3D* m_fv_solver{nullptr};
    FEMSolver3D<T>* m_fem_solver{nullptr};

    FSIMethod3D m_method{FSIMethod3D::TwoWayStaggered};
    FSIPressureIntegration m_pressure_integ{FSIPressureIntegration::Gauss2x2};
    FSIUncoveringMethod m_uncovering_method{FSIUncoveringMethod::ConservativeIDW_VacuumCavity};
    bool m_erosion_venting{true};

    T m_rho_vac{static_cast<T>(1.0e-6f)};
    T m_p_vac{static_cast<T>(1.0e-2f)};

    T m_sim_time{static_cast<T>(0.0f)};
    T m_last_dt{static_cast<T>(1.0e-6f)};
    int m_step_count{0};
    T m_accumulated_work_fsi{static_cast<T>(0.0f)};

    // Pre-allocated CPU staging arrays (Zero dynamic allocation in hot step loop)
    std::vector<uint8_t> m_solid_mask;
    std::vector<double> m_solid_vel;
    std::vector<uint8_t> m_prev_solid_mask;
    std::vector<float> m_pfield_cache;
    bool m_has_prev_mask{false};
};

} // namespace Blast

#endif // FEM_FSI_COUPLER_3D_HPP
