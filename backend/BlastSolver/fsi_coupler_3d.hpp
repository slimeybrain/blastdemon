#ifndef FSI_COUPLER_3D_HPP
#define FSI_COUPLER_3D_HPP

#include "mpm_solver_3d.hpp"
#include "cfd_solver_3d.hpp"
#include <memory>

namespace Blast {

class FSICoupler3D {
public:
    FSICoupler3D();
    ~FSICoupler3D() = default;

    // Attach CFD gas solver and MPM solid solver
    void attachSolvers(CFDSolver3D* cfd_solver, MPMSolver3D* mpm_solver);

    // Perform two-way coupled FSI step
    void step(float cfl = 0.3f);
    void stepWithDt(float dt);

    float computeCoupledDt(float cfl = 0.3f) const;

    double getSimTime() const { return m_sim_time; }
    int getStepCount() const { return m_step_count; }

private:
    // Transfer fluid pressure onto solid grid nodes
    void applyFluidPressureToSolid(float dt);

    // Enforce solid boundary velocity on fluid grid cells
    void enforceSolidVelocityOnFluid();

    CFDSolver3D* m_cfd_solver{nullptr};
    MPMSolver3D* m_mpm_solver{nullptr};

    double m_sim_time{0.0};
    int m_step_count{0};
};

} // namespace Blast

#endif // FSI_COUPLER_3D_HPP
