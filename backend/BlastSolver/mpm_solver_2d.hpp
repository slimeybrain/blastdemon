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

inline float computeWeibullFactor2D(float x, float y, float V0, float weibull_modulus, float weibull_scale, float weibull_ref_volume = 1.0e-4f) {
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

    // Physically-consistent 2D Weibull area/volume scaling: (V_ref / V0)^(1 / m_w)
    float v_ref = (weibull_ref_volume > 1.0e-18f) ? weibull_ref_volume : 1.0e-4f;
    float v_eff = (V0 > 1.0e-18f) ? V0 : v_ref;
    float size_scale = std::pow(v_ref / v_eff, 1.0f / m_w);

    float w = (std::pow(-std::log(1.0f - u), 1.0f / m_w) / gamma_mean) * eta_w * size_scale;
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
    CRESTReactiveBurn = 6,
    JWLProgrammedBurn = 7,
    LeeTarverIgnitionGrowth = 8,
    HyperelasticYeoh = 9,
    HyperelasticMooneyRivlin = 10,
    ConcreteDamagePlasticity = 11,
    Hill48Orthotropic = 12,
    TaitWater = 13,
    DruckerPragerSoil = 14
};

enum class SolidReactantEOS : int {
    MieGruneisen = 0,
    DavisSolid = 1,
    JWLReactant = 2   // Unreacted-explosive JWL (temperature form), required for published Lee-Tarver calibrations
};

enum class ReactionKinetics : int {
    ProgrammedBurn = 0,
    LeeTarverODE = 1,
    CRESTEntropy = 2
};

enum class DetonationProductEOS : int {
    JWLProductGas = 0,
    DavisProduct = 1
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

    // Three-Pillar Energetic Material Architecture
    SolidReactantEOS solid_model{SolidReactantEOS::MieGruneisen};
    ReactionKinetics burn_model{ReactionKinetics::ProgrammedBurn};
    DetonationProductEOS product_model{DetonationProductEOS::JWLProductGas};

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
    float weibull_ref_volume{1.0e-4f}; // Reference flaw area/volume V_ref (m^2) for Weibull size effect
    float weibull_factor{1.0f};  // Pre-computed spatial Weibull strength multiplier (mean-normalized)

    // Directional Material Anisotropy & Orientation
    bool enable_anisotropy{false};        // Enable directional material anisotropy (false = isotropic)
    float anisotropy_ratio{1.0f};         // Transverse-to-longitudinal yield strength ratio (0.5 to 2.0, 1.0 = isotropic)
    float anisotropy_dir[2]{1.0f, 0.0f};  // Primary material orientation / rolling / fiber axis vector

    // Dynamic State Variables
    float e_int{0.0f};           // Specific internal energy (J/kg)
    float temperature{293.0f};   // Current temperature (K)
    // Cauchy stress tensor stored compactly in symmetric Voigt format: data[0]=xx, data[1]=yy, data[2]=xy
    struct SymmetricTensor2D {
        float data[3]{0.0f, 0.0f, 0.0f};

        inline SymmetricTensor2D() = default;
        inline SymmetricTensor2D(float xx, float yy, float xy) : data{xx, yy, xy} {}
        inline SymmetricTensor2D(const float s[2][2]) : data{s[0][0], s[1][1], s[0][1]} {}

        inline void zero() { data[0] = data[1] = data[2] = 0.0f; }

        inline SymmetricTensor2D& operator=(const float s[2][2]) {
            data[0] = s[0][0]; data[1] = s[1][1]; data[2] = s[0][1];
            return *this;
        }

        inline void set(float xx, float yy, float xy) {
            data[0] = xx; data[1] = yy; data[2] = xy;
        }

        inline void setIsotropic(float p_hydro) {
            data[0] = -p_hydro; data[1] = -p_hydro; data[2] = 0.0f;
        }

        inline SymmetricTensor2D& operator*=(float s) {
            data[0] *= s; data[1] *= s; data[2] *= s;
            return *this;
        }

        struct RowProxy {
            float* ptr;
            int r;
            inline float& operator[](int c) {
                if (r == 0 && c == 0) return ptr[0];
                if (r == 1 && c == 1) return ptr[1];
                return ptr[2]; // (0,1) or (1,0) -> xy
            }
            inline float operator[](int c) const {
                if (r == 0 && c == 0) return ptr[0];
                if (r == 1 && c == 1) return ptr[1];
                return ptr[2];
            }
        };

        struct ConstRowProxy {
            const float* ptr;
            int r;
            inline float operator[](int c) const {
                if (r == 0 && c == 0) return ptr[0];
                if (r == 1 && c == 1) return ptr[1];
                return ptr[2];
            }
        };

        inline RowProxy operator[](int r) { return RowProxy{data, r}; }
        inline ConstRowProxy operator[](int r) const { return ConstRowProxy{data, r}; }
    } sigma;
    float ep_bar{0.0f};          // Equivalent plastic strain
    float damage{0.0f};          // Scalar damage D in [0, 1]
    float lambda{0.0f};          // Reaction progress [0, 1]
    float t_arrival{1.0e10f};    // Programmed detonation arrival time (s)
    float v_min{1.0f};           // Minimum relative volume
    float s_shock{0.0f};         // Latched shock entropy

    // Davis Solid Reactant EOS Parameters
    float davis_c0{2050.0f};             // Bulk sound speed (m/s)
    float davis_s1{2.12f};               // Hugoniot Us-Up slope
    float davis_gamma0{0.65f};           // Grüneisen gamma
    float davis_cv{1000.0f};             // Specific heat capacity (J/(kg K))
    float davis_t0{293.0f};              // Reference room temperature (K)
    float davis_rho0{1895.0f};           // Unreacted solid reference density (kg/m^3)

    // Davis Product Gas EOS Parameters
    float davis_a{2.85f};                // High-density exponent parameter
    float davis_b{1.10f};                // Transition curvature exponent
    float davis_k{1.35f};                // Low-density adiabatic exponent
    float davis_vc{0.65f};               // Characteristic relative transition volume
    float davis_pc{12.5e9f};             // Characteristic transition pressure (Pa)
    float davis_q_det{3.90e6f};          // Specific heat of reaction / detonation energy (J/kg)

    // CREST Reaction Kinetics Rate Law Parameters
    float crest_b1{1.2e7f};              // Hot-spot ignition rate constant (1/s)
    float crest_c1{0.67f};               // Hot-spot unreacted power exponent
    float crest_m1{2.5f};                // Hot-spot entropy power exponent
    float crest_b2{3.5e6f};              // Main grain-growth rate constant (1/s)
    float crest_c2{0.50f};               // Growth reacted power exponent
    float crest_c3{0.67f};               // Growth unreacted power exponent
    float crest_m2{1.5f};                // Growth entropy power exponent
    float crest_s0{100.0f};              // Reference entropy scale (J/(kg K))
    float crest_s_threshold{45.0f};      // Shock entropy ignition threshold (J/(kg K))
    // --- AWE CREST (Handley 2006 / Cartwright 2016); active when crest_awe_c0 > 0 ---
    float crest_awe_K0s{14.24525e9f};    // Solid bulk modulus (Pa)
    float crest_awe_A1{2.417494f}, crest_awe_A2{2.208027f}, crest_awe_A3{0.0f};
    float crest_awe_B1{0.0f}, crest_awe_B2{0.0f}, crest_awe_B3{0.0f};
    float crest_awe_fc{0.0f}, crest_awe_delta{0.0f};
    float crest_awe_Gamma1{32.33557f}, crest_awe_Gamma2{3.596933f};
    float crest_awe_gamma00{0.4f}, crest_awe_m{2.0f};
    float crest_awe_c0{0.0f}, crest_awe_c1{2.0f}, crest_awe_c2{2.2e8f}, crest_awe_c3{2.5f};
    float crest_awe_c6{0.0f}, crest_awe_c8{1.6e-4f}, crest_awe_c9{1.0f};
    float crest_awe_c10{4.0e5f}, crest_awe_c11{1.8f}, crest_awe_c12{0.0f}, crest_awe_c13{0.0f};

    // JWL Product Gas EOS & Programmed Burn Parameters
    float jwl_A{373.77e9f};              // High pressure coefficient A (Pa)
    float jwl_B{3.747e9f};               // Moderate pressure coefficient B (Pa)
    float jwl_R1{4.15f};                 // High pressure exponent R1
    float jwl_R2{0.90f};                 // Moderate pressure exponent R2
    float jwl_omega{0.35f};              // Grüneisen ratio omega
    float det_vel{6930.0f};              // Detonation velocity D_cj (m/s)
    float detonation_energy{4.29e6f};    // Detonation chemical energy release e0 (J/kg)
    int   burn_zone_cells{4};            // Smeared burn zone cell width N_cells
    float tau_burn_min{1.0e-7f};         // Minimum burn duration limiter (s)

    // Lee-Tarver Ignition & Growth Parameters  (STRICT SI; default = LLNL PBX 9501, UCRL-JC-141967 Table 1,
    // converted with Blast::LeeTarver::fromLLNL_*; I[1/s], G1[1/(s Pa^y)], G2[1/(s Pa^z)])
    float lt_I{1.4e17f};                 // Ignition rate coefficient I (1/s)
    float lt_a{0.0f};                    // Ignition compression threshold a
    float lt_b{0.667f};                  // Ignition depletion exponent
    float lt_x{20.0f};                   // Ignition compression exponent
    float lt_G1{1.3e-14f};               // Growth rate coefficient G1 (1/(s Pa^y))
    float lt_c{0.667f};                  // Growth depletion exponent
    float lt_d{0.277f};                  // Growth reaction progress exponent
    float lt_y{2.0f};                    // Growth pressure exponent
    float lt_G2{4.0e-14f};               // Completion rate coefficient G2 (1/(s Pa^z))
    float lt_e{0.333f};                  // Completion depletion exponent
    float lt_g{1.0f};                    // Completion reaction progress exponent
    float lt_z{2.0f};                    // Completion pressure exponent
    float lt_ig_max{0.3f};               // Maximum ignition fraction F_ig_max
    float lt_growth_max{0.50f};          // Maximum growth fraction F_G1_max
    float lt_comp_min{0.50f};            // Minimum completion threshold F_G2_min

    // Unreacted-explosive JWL EOS (SolidReactantEOS::JWLReactant), strict SI.
    // p = A e^(-R1 V) + B e^(-R2 V) + omega Cv T / V ;  default = LLNL PBX 9501 unreacted JWL at T0 = 298 K
    float jwlr_A{7.32e14f};              // A (Pa)
    float jwlr_B{-5.2654e9f};            // B (Pa), calibrated so p(V=1, T0) = 0
    float jwlr_R1{14.1f};                // R1
    float jwlr_R2{1.41f};                // R2
    float jwlr_omega{0.8867f};           // Gruneisen omega
    float jwlr_Cv{2.7806e6f};            // Cv (Pa/K, per initial volume)
    float jwlr_T0{298.0f};               // Reference temperature (K)
    int   mixture_rule{1};               // 0 = linear blend, 1 = pressure equilibrium (volume additive)

    // Tait Water / Compressible Fluid Parameters (2D)
    float tait_rho0{1000.0f};             // Reference density (kg/m^3)
    float tait_B{3.0e8f};                 // Tait bulk modulus constant B (Pa)
    float tait_gamma{7.0f};               // Tait exponent gamma
    float tait_p0{101325.0f};             // Reference pressure (Pa)
    float mu_visc{1.0e-3f};               // Dynamic viscosity (Pa s)

    // Density-Based Particle Erosion & FV Grid Handoff
    bool enable_density_erosion{false};
    float erosion_min_density{0.0f};      // Minimum physical density threshold (kg/m^3)
    float erosion_min_density_ratio{0.0f};// Minimum relative density ratio rho / rho0
    bool erode_to_fv_grid{true};          // Inject eroded fluid/explosive particle into FV grid when coupled

    bool has_failed{false};      // Total failure status flag
    int state{0};                // 0 = active, 2 = terminated/eroded
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

struct MPMGridView2D {
    MPMGridNode2D* nodes{nullptr};
    const int* tile_table{nullptr}; // nullptr in Dense mode; size ntx * nty in Sparse mode
    int nx{0};
    int ny{0};
    int ntx{0};
    int nty{0};

    inline bool isValidCoords(int i, int j) const {
        return (i >= 0 && i < nx && j >= 0 && j < ny);
    }

    // Converts logical (i, j) -> physical slot index in `nodes` (or -1 if unallocated tile)
    inline long long slotIndex(int i, int j) const {
        if (i < 0 || i >= nx || j < 0 || j >= ny) return -1;
        if (!tile_table) {
            return static_cast<long long>(i) * ny + j;
        }
        int tx = i >> 3;
        int ty = j >> 3;
        int t_slot = tile_table[tx * nty + ty];
        if (t_slot < 0) return -1;
        int lx = i & 7;
        int ly = j & 7;
        return (static_cast<long long>(t_slot) << 6) | (lx << 3) | ly;
    }

    inline long long slotIndexFromLogical(long long logical_idx) const {
        if (!tile_table) return logical_idx;
        if (logical_idx < 0 || ny <= 0) return -1;
        int j = static_cast<int>(logical_idx % ny);
        int i = static_cast<int>(logical_idx / ny);
        return slotIndex(i, j);
    }
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

enum class MPMBoundaryCondition2D {
    Sticky = 0,        // No-slip (v = 0)
    FreeSlip = 1,      // Normal velocity v_n = 0, tangential free
    Reflecting = 2,    // Symmetric velocity reflection
    Terminate = 3,     // Terminate simulation when particles cross boundary
    LysmerDashpot = 4, // Lysmer-Kuhlemeyer viscous absorbing boundary
    Transmitting = 5   // Free outflow: particles pass out of domain and stop being processed
};

class MPMSolver2D {
public:
    MPMSolver2D();
    ~MPMSolver2D() = default;

    // Initialization & Grid Setup
    void initializeGrid(int nx, int ny, float dx, float dy);
    void setSparseGridMode(bool sparse) { m_sparse_grid_mode = sparse; }
    bool isSparseGridMode() const { return m_sparse_grid_mode; }
    MPMGridView2D getGridView() const {
        return MPMGridView2D{
            const_cast<MPMGridNode2D*>(m_grid.data()),
            m_sparse_grid_mode && !m_tile_table.empty() ? m_tile_table.data() : nullptr,
            m_nx, m_ny, m_ntx, m_nty
        };
    }
    MPMGridView2D getHostGridView() const { return getGridView(); }
    size_t getNumActiveTiles() const { return m_sparse_grid_mode ? m_active_tiles.size() : static_cast<size_t>(m_ntx) * m_nty; }
    size_t getTileCapacity() const { return m_sparse_grid_mode ? m_tile_capacity : static_cast<size_t>(m_ntx) * m_nty; }
    size_t getTotalLogicalTiles() const { return static_cast<size_t>(m_ntx) * m_nty; }
    int getSparseActiveTileCount() const { return static_cast<int>(getNumActiveTiles()); }
    int getSparseMaxActiveTiles() const { return static_cast<int>(getTileCapacity()); }

    void setTransferScheme(MPMTransferScheme scheme) { m_transfer_scheme = scheme; }
    void setVelocityScheme(MPMVelocityScheme scheme) { m_velocity_scheme = scheme; }
    void setTimeScheme(MPMTimeIntegrationScheme scheme) { m_time_scheme = scheme; }
    void setSmoothPlasticStrain(bool smooth) { m_smooth_plastic_strain = smooth; }
    bool getSmoothPlasticStrain() const { return m_smooth_plastic_strain; }
    void setFlipBlend(float blend) { m_flip_blend = std::clamp(blend, 0.0f, 1.0f); }
    void setBoundaryConditions(MPMBoundaryCondition2D x_min, MPMBoundaryCondition2D x_max,
                               MPMBoundaryCondition2D y_min, MPMBoundaryCondition2D y_max) {
        m_bc_x_min = x_min; m_bc_x_max = x_max;
        m_bc_y_min = y_min; m_bc_y_max = y_max;
    }
    bool is_terminated() const { return m_terminated; }
    void resetTermination() { m_terminated = false; }

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

    void setDeferFVErosionToCoupler(bool defer) { m_defer_fv_erosion_to_coupler = defer; }
    bool getDeferFVErosionToCoupler() const { return m_defer_fv_erosion_to_coupler; }

    void particleToGrid();

private:
    // MPM Transfer Kernels
    void updateGridKinematics(float dt);
    void gridToParticle(float dt);
    void updateStressState(float dt);
    void gridToParticleAndStress(float dt);
    template <bool FUSE_STRESS>
    void gridToParticleInternal(float dt);
    void updateParticleStress(MPMParticle2D& p, float dt, const float L[2][2]);

    // Shape Functions & Radial Kernels
    float evalLinear_S(float x_p, float x_i, float h) const;
    float evalLinear_dS(float x_p, float x_i, float h) const;
    float evalGIMP_S(float x_p, float x_i, float h, float l_p) const;
    float evalGIMP_dS(float x_p, float x_i, float h, float l_p) const;
    float evalBSpline_S(float x_p, float x_i, float h) const;
    float evalBSpline_dS(float x_p, float x_i, float h) const;
    float evalCubicBSpline_S(float x_p, float x_i, float h) const;
    float evalCubicBSpline_dS(float x_p, float x_i, float h) const;
    float evalWendland_C2(float r, float R_supp) const;

    int m_nx{64};
    int m_ny{64};
    int m_ntx{8};
    int m_nty{8};
    float m_dx{0.01f};
    float m_dy{0.01f};
    bool m_sparse_grid_mode{false};
    bool m_defer_fv_erosion_to_coupler{false};
    size_t m_tile_capacity{0};
    std::vector<int> m_tile_table;
    std::vector<int> m_active_tiles;

    MPMTransferScheme m_transfer_scheme{MPMTransferScheme::GIMP};
    MPMVelocityScheme m_velocity_scheme{MPMVelocityScheme::APIC};
    MPMTimeIntegrationScheme m_time_scheme{MPMTimeIntegrationScheme::Leapfrog};
    float m_flip_blend{0.95f};
    bool m_smooth_plastic_strain{true};

    MPMBoundaryCondition2D m_bc_x_min{MPMBoundaryCondition2D::Sticky};
    MPMBoundaryCondition2D m_bc_x_max{MPMBoundaryCondition2D::Sticky};
    MPMBoundaryCondition2D m_bc_y_min{MPMBoundaryCondition2D::Sticky};
    MPMBoundaryCondition2D m_bc_y_max{MPMBoundaryCondition2D::Sticky};

    std::vector<MPMGridNode2D> m_grid;
    std::vector<MPMParticle2D> m_particles;

    float m_last_dt{0.0f};
    float m_last_cfl{0.3f};
    mutable float m_last_v_max{0.0f};
    double m_sim_time{0.0};
    int m_step_count{0};
    bool m_terminated{false};
};

} // namespace Blast

#endif // MPM_SOLVER_2D_HPP
