#ifndef MPM_SOLVER_3D_HPP
#define MPM_SOLVER_3D_HPP

#include "mpm_solver_2d.hpp"
#include "constitutive_concrete_models.hpp"
#include <vector>
#include <array>

namespace Blast {

struct MaterialTable3D {
    MPMMaterialModel material_model{MPMMaterialModel::Hypoelastic};

    // Baseline Material Properties
    float density{7850.0f};               // kg/m^3
    float youngs_modulus{210.0e9f};        // Pa
    float poissons_ratio{0.3f};            // ratio
    float yield_stress{400.0e6f};          // Pa
    float hardening_modulus{1.0e9f};     // Pa
    float failure_strain{0.25f};        // strain
    float tensile_failure_stress{600.0e6f};// Pa

    // Concrete Standard Properties
    float fc{35.0e6f};                   // Unconfined compressive strength (Pa)
    float ft{3.5e6f};                    // Unconfined tensile strength (Pa)
    float G_f{150.0f};                   // Mode I tensile fracture energy (N/m = J/m^2)
    float G_fc{15000.0f};                // Compressive fracture energy (N/m)
    float aggregate_size{0.016f};        // Maximum aggregate diameter (m)
    float moisture_content{0.0f};        // Pore water saturation ratio Sw in [0, 1]
    float dif_cap_compression{2.5f};     // Max compressive DIF rate enhancement cap
    float dif_cap_tension{8.0f};         // Max tensile DIF rate enhancement cap

    // RHT Concrete Model Parameters
    float rht_A{1.60f};                  // Failure surface parameter A
    float rht_N{0.61f};                  // Failure surface exponent N
    float rht_B{0.70f};                  // Residual surface parameter B
    float rht_M{0.80f};                  // Residual surface exponent M
    float rht_Q0{0.680f};                // Lode angle ratio parameter Q0
    float rht_BQ{0.0105f};               // Lode angle ratio slope BQ
    float rht_D1{0.04f};                 // Damage accumulation constant D1
    float rht_D2{1.0f};                  // Damage accumulation exponent D2
    float rht_p_crush{17.0e6f};          // Initial pore crush pressure (Pa)
    float rht_p_lock{600.0e6f};          // Fully locked solid compaction pressure (Pa)
    float rht_alpha0{1.22f};             // Initial porosity ratio alpha0 = rho_solid / rho_0
    float rht_n_comp{3.0f};              // Compaction exponent n
    float rht_betac{0.032f};             // Compressive strain rate exponent
    float rht_deltat{0.036f};            // Tensile strain rate exponent

    // K&C Concrete (MAT_072R3) Parameters
    bool kc_auto_generate{true};         // Auto-generate Malvar parameters from fc
    float kc_a0{11.6e6f};
    float kc_a1{0.45f};
    float kc_a2{4.28e-9f};
    float kc_a0y{5.2e6f};
    float kc_a1y{0.45f};
    float kc_a2y{4.28e-9f};
    float kc_a1r{0.75f};
    float kc_a2r{5.71e-9f};
    float kc_b1{1.60f};
    float kc_omega{0.50f};

    // CSCM (MAT_159) Concrete Parameters
    float cscm_alpha{14.0e6f};           // Shear surface intercept (Pa)
    float cscm_theta{0.15f};             // Shear surface linear slope
    float cscm_lambda{10.5e6f};          // Shear surface non-linear coefficient (Pa)
    float cscm_beta{2.85e-9f};           // Shear surface exponent (1/Pa)
    float cscm_R{5.0f};                  // Cap aspect ratio R
    float cscm_X0{87.5e6f};              // Initial cap position (Pa)
    float cscm_W{0.05f};                 // Max plastic volume strain W
    float cscm_D1{2.5e-9f};              // Cap hardening evolution parameter D1 (1/Pa)
    float cscm_D2{3.0e-17f};             // Cap hardening evolution parameter D2 (1/Pa^2)

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

    // Artificial Bulk Viscosity & Timestep Erosion Parameters
    float bulk_viscosity_b1{0.06f};       // Linear artificial bulk viscosity coefficient
    float bulk_viscosity_b2{1.20f};       // Quadratic artificial bulk viscosity coefficient
    float timestep_erosion_factor{0.10f}; // Timestep erosion ratio threshold

    // Material Removal & Erosion Criteria (Independent of constitutive failure)
    bool enable_strain_erosion{false};
    float erosion_strain{0.50f};          // Plastic strain erosion threshold (ep_bar >= erosion_strain)
    bool enable_stress_erosion{false};
    float erosion_stress{600.0e6f};       // Tensile hydrostatic stress threshold (Pa)
    bool enable_timestep_erosion{false};
};

struct MPMParticle3D {
    // Kinematics & Position in 3D
    float x[3];         // Position (x, y, z)
    float v[3];         // Velocity (vx, vy, vz)
    float B[3][3];      // APIC affine velocity matrix (3x3)
    float L_grad[3][3]; // True continuum velocity gradient from shape function derivatives (3x3)
    float lp[3];        // GIMP particle domain half-widths (lx, ly, lz)

    // Mass & Volume
    float m;            // Mass
    float V0;           // Initial volume
    float V;            // Current volume

    // Dynamic State Variables
    float e_int{0.0f};           // Specific internal energy (J/kg)
    float temperature{293.0f};   // Current temperature (K)
    float F[3][3];               // Deformation gradient
    float sigma[3][3];           // Cauchy stress tensor (3x3 symmetric)
    float ep_bar{0.0f};          // Equivalent plastic strain
    float damage{0.0f};          // Scalar damage D in [0, 1]
    float lambda{0.0f};          // Modified damage scaling parameter (K&C / CSCM cap)
    bool has_failed{false};      // Total failure status flag
    int object_id{0};            // Object / Material Table ID
};

struct alignas(32) MPMGridNode3D {
    float m{0.0f};            // Mass (4B)
    float p[3]{0.0f, 0.0f, 0.0f};         // Momentum (px, py, pz) (12B)
    float f_ext[3]{0.0f, 0.0f, 0.0f};     // External force (FSI coupling) (12B)
    float f_int[3]{0.0f, 0.0f, 0.0f};     // Internal stress force (12B)
    float plastic_strain{0.0f}; // Interpolated plastic strain for smoothing (4B)

    static constexpr float MIN_MASS = 1.0e-11f;
    float v(int i) const { return m > MIN_MASS ? p[i] / m : 0.0f; }
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
    void initializeGrid(int nx, int ny, int nz, float dx, float dy, float dz, float xmin = 0.0f, float ymin = 0.0f, float zmin = 0.0f);
    void setTransferScheme(MPMTransferScheme scheme) { m_transfer_scheme = scheme; }
    void setVelocityScheme(MPMVelocityScheme scheme) { m_velocity_scheme = scheme; }
    void setTimeScheme(MPMTimeIntegrationScheme scheme) { m_time_scheme = scheme; }
    void setSmoothPlasticStrain(bool smooth) { m_smooth_plastic_strain = smooth; }
    bool getSmoothPlasticStrain() const { return m_smooth_plastic_strain; }
    void setFlipBlend(float alpha) { m_flip_blend = alpha; }
    float getFlipBlend() const { return m_flip_blend; }
    float getXMin() const { return m_xmin; }
    float getYMin() const { return m_ymin; }
    float getZMin() const { return m_zmin; }
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

    void addCylinderObject(int obj_id, float pos_x, float pos_y, float pos_z,
                           float radius, float inner_radius, float height,
                           float vel_x, float vel_y, float vel_z,
                           float angular_vel_x, float angular_vel_y, float angular_vel_z,
                           float density, float E, float nu,
                           float yield_stress, float hardening, float failure_strain = 0.25f,
                           float tensile_failure_stress = 600.0e6f, int ppc = 8);

    void addSTLObject(int obj_id, const std::string& stl_filepath,
                      float pos_x, float pos_y, float pos_z,
                      float scale_x, float scale_y, float scale_z,
                      float vel_x, float vel_y, float vel_z,
                      float angular_vel_x, float angular_vel_y, float angular_vel_z,
                      float density, float E, float nu,
                      float yield_stress, float hardening, float failure_strain = 0.25f,
                      float tensile_failure_stress = 600.0e6f, int ppc = 8);

    void addParticleDirect(const MPMParticle3D& particle) {
        m_particles.push_back(particle);
    }

    void addParticlesDirect(const std::vector<MPMParticle3D>& particles) {
        m_particles.insert(m_particles.end(), particles.begin(), particles.end());
    }

    // Simulation Step
    void step(float cfl = 0.3f);
    void stepWithDt(float dt, bool run_p2g = true);
    float computeStepSize(float cfl = 0.3f) const;

    // Getters & Telemetry
    std::vector<MPMParticle3D>& getParticles() { return m_particles; }
    const std::vector<MPMParticle3D>& getParticles() const { return m_particles; }

    std::vector<MaterialTable3D>& getMaterialTables() { return m_material_tables; }
    const std::vector<MaterialTable3D>& getMaterialTables() const { return m_material_tables; }
    const MaterialTable3D& getMaterialTable(int object_id) const {
        if (object_id >= 0 && object_id < static_cast<int>(m_material_tables.size())) {
            return m_material_tables[object_id];
        }
        static MaterialTable3D default_mat{};
        return default_mat;
    }

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
    float m_xmin{0.0f};
    float m_ymin{0.0f};
    float m_zmin{0.0f};

    MPMTransferScheme m_transfer_scheme{MPMTransferScheme::GIMP};
    MPMVelocityScheme m_velocity_scheme{MPMVelocityScheme::APIC};
    MPMTimeIntegrationScheme m_time_scheme{MPMTimeIntegrationScheme::Leapfrog};
    float m_flip_blend{0.95f};
    bool m_smooth_plastic_strain{true};

    MPMBoundaryCondition3D m_bc_x_min{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_x_max{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_y_min{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_y_max{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_z_min{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_z_max{MPMBoundaryCondition3D::Sticky};

    std::vector<MaterialTable3D> m_material_tables;
    std::vector<MPMGridNode3D> m_grid;
    std::vector<MPMParticle3D> m_particles;

    float m_last_dt{0.0f};
    float m_last_cfl{0.3f};
    mutable float m_last_v_max{0.0f};
    double m_sim_time{0.0};
    int m_step_count{0};
};

} // namespace Blast

#endif // MPM_SOLVER_3D_HPP
