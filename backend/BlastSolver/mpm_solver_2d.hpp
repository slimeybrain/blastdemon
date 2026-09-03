#ifndef MPM_SOLVER_2D_HPP
#define MPM_SOLVER_2D_HPP

#include <vector>
#include <cmath>
#include <string>
#include <iostream>
#include <algorithm>
#include <memory>
#include <cstring>

namespace Blast {

static inline uint32_t floatToBits2D(float f) {
    uint32_t u;
    std::memcpy(&u, &f, sizeof(float));
    return u;
}

inline float computeWeibullFactor2D(float x, float y, float weibull_modulus, float weibull_scale) {
    if (weibull_modulus <= 0.001f) return 1.0f;
    uint32_t ix = floatToBits2D(x);
    uint32_t iy = floatToBits2D(y);
    uint32_t seed = (ix * 73856093u) ^ (iy * 19349663u);
    seed = (seed ^ 61u) ^ (seed >> 16);
    seed *= 9u;
    seed = seed ^ (seed >> 4);
    seed *= 0x27d4eb2du;
    seed = seed ^ (seed >> 15);
    float u = std::clamp(static_cast<float>(seed & 0xFFFFu) / 65535.0f, 0.001f, 0.999f);
    float m_w = weibull_modulus;
    float eta_w = (weibull_scale > 0.001f) ? weibull_scale : 1.0f;
    float gamma_mean = std::tgamma(1.0f + 1.0f / m_w);
    float w = (std::pow(-std::log(1.0f - u), 1.0f / m_w) / gamma_mean) * eta_w;
    return std::clamp(w, 0.10f, 3.0f);
}

enum class MPMMaterialModel {
    LinearElastic = 0,
    Hypoelastic = 1,
    HypoelasticSteel = 1, // Alias for backward compatibility
    JohnsonCookMieGruneisen = 2,
    RHTConcrete = 3,
    KCConcrete = 4,
    CSCMConcrete = 5,
    CRESTReactiveBurn = 6
};

struct MPMParticle2D {
    // Kinematics & Position
    float x[2];         // Position (x, y)
    float v[2];         // Velocity (vx, vy)
    float B[2][2];      // APIC affine velocity matrix
    float L_grad[2][2]; // True velocity gradient from shape function derivatives
    float lp[2];        // GIMP particle domain half-lengths

    // Mass & Volume
    float m;            // Mass
    float V0;           // Initial volume
    float V;            // Current volume

    // Material Model Selector
    MPMMaterialModel material_model{MPMMaterialModel::Hypoelastic};

    // Baseline Material Properties (Solid Continuum J2 Elastoplasticity & Fracture/Failure)
    float density{7850.0f};               // kg/m^3 (e.g. 7850)
    float youngs_modulus{210.0e9f};        // Pa (e.g. 210e9)
    float poissons_ratio{0.3f};            // (e.g. 0.3)
    float yield_stress{400.0e6f};          // Pa (e.g. 400e6)
    float hardening_modulus{1.0e9f};     // Pa (e.g. 1e9)
    float failure_strain{0.25f};        // Critical equivalent plastic strain (e.g. 0.25)
    float tensile_failure_stress{600.0e6f};// Critical tensile stress cutoff Pa (e.g. 600e6)

    // Johnson-Cook Plasticity & Thermal Softening Parameters
    float jc_A{792.0e6f};        // Initial yield stress (Pa)
    float jc_B{510.0e6f};        // Strain hardening constant (Pa)
    float jc_n{0.26f};           // Strain hardening exponent
    float jc_C{0.014f};          // Strain rate constant
    float jc_m{1.03f};           // Thermal softening exponent
    float T_melt{1793.0f};       // Melting temperature (K)
    float T_room{293.0f};        // Room reference temperature (K)
    float Cp{477.0f};            // Specific heat capacity (J/(kg K))

    // Mie-Grüneisen Shock EOS Parameters
    float mg_gamma0{1.81f};      // Grüneisen gamma parameter
    float mg_c0{4570.0f};        // Bulk sound speed (m/s)
    float mg_s{1.49f};           // Hugoniot Us-Up slope

    // Weibull Flaw Scatter Parameters
    bool enable_heterogeneity{false}; // Enable spatial Weibull flaw scatter (false = homogeneous)
    float weibull_modulus{0.0f}; // Weibull modulus m_w (0.0 = homogeneous)
    float weibull_scale{1.0f};   // Weibull scale eta_w (1.0 = baseline)
    float weibull_factor{1.0f};  // Pre-computed spatial Weibull strength multiplier (mean-normalized)

    // Directional Material Anisotropy & Orientation
    bool enable_anisotropy{false};        // Enable directional material anisotropy (false = isotropic)
    float anisotropy_ratio{1.0f};         // Transverse-to-longitudinal yield strength ratio (0.5 to 2.0, 1.0 = isotropic)
    float anisotropy_dir[2]{1.0f, 0.0f};  // Primary material orientation / rolling / fiber axis vector

    // Dynamic State Variables
    float e_int{0.0f};           // Specific internal energy (J/kg)
    float temperature{293.0f};   // Current temperature (K)
    float F[2][2];               // Deformation gradient
    float sigma[2][2];           // Cauchy stress tensor
    float ep_bar{0.0f};          // Equivalent plastic strain
    float damage{0.0f};          // Scalar damage D in [0, 1]
    bool has_failed{false};      // Total failure status flag
    int object_id{0};
    int transfer_scheme{-1};    // -1 = Inherit domain default, otherwise MPMTransferScheme cast
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
    Standard = 0,
    GIMP = 1,
    BSpline = 2,
    RadialMLS = 3,
    CubicBSpline = 4
};

enum class MPMParticleDistribution {
    Cartesian = 0,
    Hexagonal = 1
};

enum class MPMBoundaryFilling {
    Stairstepped = 0,
    Partial = 1
};

enum class MPMVelocityScheme {
    APIC,
    PIC,
    FLIP
};

enum class MPMTimeIntegrationScheme {
    Leapfrog, // 2nd-Order Symplectic Staggered Leapfrog (Default)
    USL,      // Update Stress Last
    USF,      // Update Stress First
    RK2       // Midpoint RK2
};

class MPMSolver2D {
public:
    MPMSolver2D();
    ~MPMSolver2D() = default;

    // Initialization & Grid Setup
    void initializeGrid(int nx, int ny, float dx, float dy);
    void setTransferScheme(MPMTransferScheme scheme) { m_transfer_scheme = scheme; }
    void setVelocityScheme(MPMVelocityScheme scheme) { m_velocity_scheme = scheme; }
    void setTimeScheme(MPMTimeIntegrationScheme scheme) { m_time_scheme = scheme; }
    void setSmoothPlasticStrain(bool smooth) { m_smooth_plastic_strain = smooth; }
    bool getSmoothPlasticStrain() const { return m_smooth_plastic_strain; }
    void setFlipBlend(float blend) { m_flip_blend = std::clamp(blend, 0.0f, 1.0f); }

    // Object Adders (Primitives)
    void addRectangleObject(int obj_id, float pos_x, float pos_y, float size_x, float size_y,
                            float vel_x, float vel_y, float angular_vel, float density, float E, float nu,
                            float yield_stress, float hardening, float failure_strain = 0.25f,
                            float tensile_failure_stress = 600.0e6f, int ppc = 4,
                            MPMParticleDistribution particle_dist = MPMParticleDistribution::Cartesian,
                            MPMBoundaryFilling boundary_fill = MPMBoundaryFilling::Stairstepped);

    void addCircleObject(int obj_id, float pos_x, float pos_y, float radius,
                         float vel_x, float vel_y, float angular_vel, float density, float E, float nu,
                         float yield_stress, float hardening, float failure_strain = 0.25f,
                         float tensile_failure_stress = 600.0e6f, int ppc = 4,
                         MPMParticleDistribution particle_dist = MPMParticleDistribution::Cartesian,
                         MPMBoundaryFilling boundary_fill = MPMBoundaryFilling::Stairstepped);

    // Simulation Step: Run 1 step at dt = cfl * dt_critical
    void step(float cfl = 0.6f);
    void stepWithDt(float dt, bool run_p2g = true);
    float computeStepSize(float cfl = 0.6f) const;

    // Getters & Telemetry
    std::vector<MPMParticle2D>& getParticles() { return m_particles; }
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

    // Shape Functions & Radial Kernels
    float evalGIMP_S(float x_p, float x_i, float h, float l_p) const;
    float evalGIMP_dS(float x_p, float x_i, float h, float l_p) const;
    float evalBSpline_S(float x_p, float x_i, float h) const;
    float evalBSpline_dS(float x_p, float x_i, float h) const;
    float evalCubicBSpline_S(float x_p, float x_i, float h) const;
    float evalCubicBSpline_dS(float x_p, float x_i, float h) const;
    float evalWendland_C2(float r, float R_supp) const;

    int m_nx{64};
    int m_ny{64};
    float m_dx{0.01f};
    float m_dy{0.01f};

    MPMTransferScheme m_transfer_scheme{MPMTransferScheme::GIMP};
    MPMVelocityScheme m_velocity_scheme{MPMVelocityScheme::APIC};
    MPMTimeIntegrationScheme m_time_scheme{MPMTimeIntegrationScheme::Leapfrog};
    float m_flip_blend{0.95f};
    bool m_smooth_plastic_strain{true};

    std::vector<MPMGridNode2D> m_grid;
    std::vector<MPMParticle2D> m_particles;

    float m_last_dt{0.0f};
    float m_last_cfl{0.3f};
    mutable float m_last_v_max{0.0f};
    double m_sim_time{0.0};
    int m_step_count{0};
};

} // namespace Blast

#endif // MPM_SOLVER_2D_HPP
