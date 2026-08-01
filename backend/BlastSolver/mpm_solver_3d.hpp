#ifndef MPM_SOLVER_3D_HPP
#define MPM_SOLVER_3D_HPP

#include "mpm_solver_2d.hpp"

namespace Blast {

struct MPMParticle3D {
    // Kinematics & Position in 3D
    float x[3];         // Position (x, y, z)
    float v[3];         // Velocity (vx, vy, vz)
    float B[3][3];      // APIC affine velocity matrix (3x3)
    float lp[3];        // GIMP particle domain half-widths (lx, ly, lz)

    // Mass & Volume
    float m;            // Mass
    float V0;           // Initial volume
    float V;            // Current volume

    // Material Properties (Steel / Metal J2 Elastoplasticity & Failure)
    float density;               // kg/m^3 (e.g. 7850)
    float youngs_modulus;        // Pa (e.g. 210e9)
    float poissons_ratio;        // (e.g. 0.3)
    float yield_stress;          // Pa (e.g. 400e6)
    float hardening_modulus;     // Pa (e.g. 1e9)
    float failure_strain;        // Critical equivalent plastic strain (e.g. 0.25)
    float tensile_failure_stress;// Critical tensile stress cutoff Pa (e.g. 600e6)

    // Deformation, Stress (3x3) & Damage State
    float F[3][3];      // Deformation gradient
    float sigma[3][3];  // Cauchy stress tensor (3x3 symmetric)
    float ep_bar;       // Equivalent plastic strain
    float damage;       // Scalar damage D in [0, 1]
    bool has_failed;    // Total failure status flag
    int object_id;
};

struct MPMGridNode3D {
    float m;            // Mass
    float p[3];         // Momentum (px, py, pz)
    float v[3];         // Velocity (vx, vy, vz)
    float f_int[3];     // Internal stress force
    float f_ext[3];     // External force (FSI coupling)
    
    // Interpolated Telemetry Scalars
    float von_mises;
    float plastic_strain;
    float density;
    float pressure;
    float damage;
};

enum class MPMTimeIntegrationScheme {
    USL, // Update Stress Last (Symplectic Euler)
    USF, // Update Stress First
    RK2  // Midpoint RK2
};

enum class MPMBoundaryCondition3D {
    Sticky,     // No-slip (v = 0)
    FreeSlip,   // Normal velocity v_n = 0, tangential free
    Reflecting, // Symmetric velocity reflection
    Terminate   // Outflow / particle absorption
};

class MPMSolver3D {
public:
    MPMSolver3D();
    ~MPMSolver3D() = default;

    // Initialization & Grid Setup
    void initializeGrid(int nx, int ny, int nz, float dx, float dy, float dz);
    void setTransferScheme(MPMTransferScheme scheme) { m_transfer_scheme = scheme; }
    void setVelocityScheme(MPMVelocityScheme scheme) { m_velocity_scheme = scheme; }
    void setTimeScheme(MPMTimeIntegrationScheme scheme) { m_time_scheme = scheme; }
    void setBoundaryConditions(MPMBoundaryCondition3D x_min, MPMBoundaryCondition3D x_max,
                               MPMBoundaryCondition3D y_min, MPMBoundaryCondition3D y_max,
                               MPMBoundaryCondition3D z_min, MPMBoundaryCondition3D z_max);

    // Object Adders (3D Primitives)
    void addBoxObject(int obj_id, float pos_x, float pos_y, float pos_z,
                      float size_x, float size_y, float size_z,
                      float vel_x, float vel_y, float vel_z,
                      float angular_vel_x, float angular_vel_y, float angular_vel_z,
                      float density, float E, float nu,
                      float yield_stress, float hardening, float failure_strain = 0.25f,
                      float tensile_failure_stress = 600.0e6f, int ppc = 8);

    void addSphereObject(int obj_id, float pos_x, float pos_y, float pos_z, float radius,
                         float vel_x, float vel_y, float vel_z,
                         float angular_vel_x, float angular_vel_y, float angular_vel_z,
                         float density, float E, float nu,
                         float yield_stress, float hardening, float failure_strain = 0.25f,
                         float tensile_failure_stress = 600.0e6f, int ppc = 8);

    // Simulation Step
    void step(float cfl = 0.3f);
    void stepWithDt(float dt, bool run_p2g = true);
    float computeStepSize(float cfl = 0.3f) const;

    // Getters & Telemetry
    const std::vector<MPMParticle3D>& getParticles() const { return m_particles; }
    std::vector<MPMGridNode3D>& getGrid() { return m_grid; }
    const std::vector<MPMGridNode3D>& getGrid() const { return m_grid; }
    int getNx() const { return m_nx; }
    int getNy() const { return m_ny; }
    int getNz() const { return m_nz; }
    float getDx() const { return m_dx; }
    float getDy() const { return m_dy; }
    float getDz() const { return m_dz; }
    float getLastDt() const { return m_last_dt; }
    float getLastCFL() const { return m_last_cfl; }
    float getMaxVelocity() const { return m_last_v_max; }
    double getSimTime() const { return m_sim_time; }
    int getStepCount() const { return m_step_count; }

    void particleToGrid();

private:
    void updateGridKinematics(float dt);
    void gridToParticle(float dt);
    void updateStressState(float dt);

    // Shape Function Evaluators (1D & 3D)
    float evalGIMP_S(float x_p, float x_i, float h, float l_p) const;
    float evalGIMP_dS(float x_p, float x_i, float h, float l_p) const;

    float evalBSpline_S(float x_p, float x_i, float h) const;
    float evalBSpline_dS(float x_p, float x_i, float h) const;

    int m_nx{32};
    int m_ny{32};
    int m_nz{32};
    float m_dx{0.01f};
    float m_dy{0.01f};
    float m_dz{0.01f};

    MPMTransferScheme m_transfer_scheme{MPMTransferScheme::GIMP};
    MPMVelocityScheme m_velocity_scheme{MPMVelocityScheme::APIC};
    MPMTimeIntegrationScheme m_time_scheme{MPMTimeIntegrationScheme::USL};

    MPMBoundaryCondition3D m_bc_x_min{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_x_max{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_y_min{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_y_max{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_z_min{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_z_max{MPMBoundaryCondition3D::Sticky};

    std::vector<MPMGridNode3D> m_grid;
    std::vector<MPMParticle3D> m_particles;

    float m_last_dt{0.0f};
    float m_last_cfl{0.3f};
    float m_last_v_max{0.0f};
    double m_sim_time{0.0};
    int m_step_count{0};
};

} // namespace Blast

#endif // MPM_SOLVER_3D_HPP
