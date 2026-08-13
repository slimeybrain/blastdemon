#ifndef FEM_FSI_COUPLER_3D_HPP
#define FEM_FSI_COUPLER_3D_HPP

#include "fem_solver_3d.hpp"
#include "cfd_solver_3d.hpp"
#include <memory>
#include <vector>

namespace Blast {

template <typename T>
class FEMFSICoupler3D {
public:
    FEMFSICoupler3D();
    ~FEMFSICoupler3D() = default;

    void attachSolvers(CFDSolver3D* cfd_solver, FEMSolver3D<T>* fem_solver);

    void step(T cfl = 0.3f);
    void stepWithDt(T dt);

    T computeCoupledDt(T cfl = 0.3f) const;

    T getSimTime() const { return m_sim_time; }
    int getStepCount() const { return m_step_count; }

private:
    void applyFluidPressureToStructure(T dt);
    void handleCellUncovering();

    CFDSolver3D* m_cfd_solver{nullptr};
    FEMSolver3D<T>* m_fem_solver{nullptr};

    T m_sim_time{0.0f};
    int m_step_count{0};
};

} // namespace Blast

#endif // FEM_FSI_COUPLER_3D_HPP
