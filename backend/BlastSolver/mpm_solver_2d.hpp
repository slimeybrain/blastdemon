#ifndef MPM_SOLVER_2D_HPP
#define MPM_SOLVER_2D_HPP

#include <vector>
#include <cmath>
#include <string>
#include <iostream>
#include <algorithm>
#include <memory>

namespace Blast {

struct MPMParticle2D {
    // Kinematics & Position
    float x[2];         // Position (x, y)
    float v[2];         // Velocity (vx, vy)
    float B[2][2];      // APIC affine velocity matrix
    float lp[2];        // GIMP particle domain half-lengths

    // Mass & Volume
    float m;            // Mass
    float V0;           // Initial volume
    float V;            // Current volume

    // Material Properties (Steel J2 Elastoplasticity & Fracture/Failure)
    float density;               // kg/m^3 (e.g. 7850)
    float youngs_modulus;        // Pa (e.g. 210e9)
    float poissons_ratio;        // (e.g. 0.3)
    float yield_stress;          // Pa (e.g. 400e6)
    float hardening_modulus;     // Pa (e.g. 1e9)
    float failure_strain;        // Critical equivalent plastic strain (e.g. 0.25)
    float tensile_failure_stress;// Critical tensile stress cutoff Pa (e.g. 600e6)

    // Deformation, Stress & Damage State
    float F[2][2];      // Deformation gradient
    float sigma[2][2];  // Cauchy stress tensor
    float ep_bar;       // Equivalent plastic strain
    float damage;       // Scalar damage D in [0, 1]
    bool has_failed;    // Total failure status flag
    int object_id;
};

struct MPMGridNode2D {
    float m;            // Mass
    float p[2];         // Momentum (px, py)
    float v[2];         // Velocity (vx, vy)
    float v_old[2];     // Pre-update velocity for FLIP scheme
    float f_int[2];     // Internal stress force
    float f_ext[2];     // External force (FSI coupling)
    
    // Interpolated Telemetry Scalars
    float von_mises;
    float plastic_strain;
    float density;
    float pressure;
    float damage;
};

enum class MPMTransferScheme {
    GIMP,
    Standard,
    BSpline
};

enum class MPMVelocityScheme {
    APIC,
    PIC,
    FLIP
};

class MPMSolver2D {
public:
    MPMSolver2D();
    ~MPMSolver2D() = default;

    // Initialization & Grid Setup
    void initializeGrid(int nx, int ny, float dx, float dy);
    void setTransferScheme(MPMTransferScheme scheme) { m_transfer_scheme = scheme; }
    void setVelocityScheme(MPMVelocityScheme scheme) { m_velocity_scheme = scheme; }
    void setFlipBlend(float blend) { m_flip_blend = std::clamp(blend, 0.0f, 1.0f); }

    // Object Adders (Primitives)
    void addRectangleObject(int obj_id, float pos_x, float pos_y, float size_x, float size_y,
                            float vel_x, float vel_y, float angular_vel, float density, float E, float nu,
                            float yield_stress, float hardening, float failure_strain = 0.25f,
                            float tensile_failure_stress = 600.0e6f, int ppc = 4);

    void addCircleObject(int obj_id, float pos_x, float pos_y, float radius,
                         float vel_x, float vel_y, float angular_vel, float density, float E, float nu,
                         float yield_stress, float hardening, float failure_strain = 0.25f,
                         float tensile_failure_stress = 600.0e6f, int ppc = 4);

    // Simulation Step: Run 1 step at dt = cfl * dt_critical
    void step(float cfl = 0.3f);
    void stepWithDt(float dt, bool run_p2g = true);
    float computeStepSize(float cfl = 0.3f) const;

    // Getters & Telemetry
    const std::vector<MPMParticle2D>& getParticles() const { return m_particles; }
    std::vector<MPMGridNode2D>& getGrid() { return m_grid; }
    const std::vector<MPMGridNode2D>& getGrid() const { return m_grid; }
    int getNx() const { return m_nx; }
    int getNy() const { return m_ny; }
    float getDx() const { return m_dx; }
    float getDy() const { return m_dy; }
    float getLastDt() const { return m_last_dt; }
    float getLastCFL() const { return m_last_cfl; }
    float getMaxVelocity() const { return m_last_v_max; }
    double getSimTime() const { return m_sim_time; }
    int getStepCount() const { return m_step_count; }

    // Export interpolated scalar grid for 2D contour telemetry
    std::vector<float> getGridScalarField(const std::string& quantity) const;

    void particleToGrid();

private:
    // MPM Transfer Kernels
    void updateGridKinematics(float dt);
    void gridToParticle(float dt);
    void updateStressState(float dt);

    // uGIMP Shape Functions (1D & 2D)
    float evalGIMP_S(float x_p, float x_i, float h, float l_p) const;
    float evalGIMP_dS(float x_p, float x_i, float h, float l_p) const;

    int m_nx{64};
    int m_ny{64};
    float m_dx{0.01f};
    float m_dy{0.01f};

    MPMTransferScheme m_transfer_scheme{MPMTransferScheme::GIMP};
    MPMVelocityScheme m_velocity_scheme{MPMVelocityScheme::APIC};
    float m_flip_blend{0.95f};

    std::vector<MPMGridNode2D> m_grid;
    std::vector<MPMParticle2D> m_particles;

    float m_last_dt{0.0f};
    float m_last_cfl{0.3f};
    float m_last_v_max{0.0f};
    double m_sim_time{0.0};
    int m_step_count{0};
};

} // namespace Blast

#endif // MPM_SOLVER_2D_HPP
