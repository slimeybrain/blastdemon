#ifndef PHASE_TRACKING_PARTICLES_3D_HPP
#define PHASE_TRACKING_PARTICLES_3D_HPP

#include <vector>
#include <cmath>
#include <cstdint>
#include <string>
#include <algorithm>
#include <memory>
#include <iostream>

namespace Blast {

// Discrete material phase identifiers for multilateral tracking
enum class TrackingPhaseID : uint8_t {
    DetonationGas = 0,
    DetonationProducts = 0,
    Gas = 0,
    UnreactedExplosive = 1,
    LiquidWater = 2,
    Water = 2,
    SolidMetalCasing = 3,
    CasingSolid = 3,
    Solid = 3,
    GranularSoil = 4,
    SoilSeabed = 4,
    Soil = 4,
    AmbientAir = 5,
    AtmosphericAir = 5,
    Air = 5
};

struct PhaseTrackingParticle3D {
    float x[3]{0.0f, 0.0f, 0.0f};       // Position (m)
    float v[3]{0.0f, 0.0f, 0.0f};       // Velocity (m/s)
    float V{0.0f};                      // Current volume (m^3)
    float V0{0.0f};                     // Reference volume (m^3)
    float m{0.0f};                      // Mass (kg)
    uint8_t phase_id{2};                // TrackingPhaseID (default: LiquidWater)
    uint8_t active{1};                  // 1 = active, 0 = inactive
    uint16_t flags{0};
};

struct PhaseTrackingVTKSnapshot3D {
    int num_particles{0};
    std::vector<float> points;          // 3 * num_particles
    std::vector<float> vel;             // 3 * num_particles
    std::vector<int32_t> phase_id;      // num_particles
    std::vector<float> volume;          // num_particles
    std::vector<float> mass;            // num_particles
};

class PhaseTrackingParticles3D {
public:
    explicit PhaseTrackingParticles3D(bool is_cuda = false);
    ~PhaseTrackingParticles3D();

    bool isCUDA() const { return m_is_cuda; }
    void setCUDA(bool val) { m_is_cuda = val; }

    void initialize(int max_capacity, double xmin, double ymin, double zmin,
                    double dx, double dy, double dz, int nx, int ny, int nz);

    void reset();

    // Seeding methods
    void seedSphere(float cx, float cy, float cz, float radius_outer, float radius_inner,
                    TrackingPhaseID phase, float dx, float dy, float dz, int ppc, float density,
                    float z_min_clip = -1e30f, float z_max_clip = 1e30f);

    void seedSphere(float cx, float cy, float cz, float radius_outer, float radius_inner,
                    TrackingPhaseID phase, float density, int ppc_1d = 2);

    void seedCylinder(float cx, float cy, float cz, float radius_outer, float radius_inner, float height,
                      TrackingPhaseID phase, float dx, float dy, float dz, int ppc, float density,
                      float z_min_clip = -1e30f, float z_max_clip = 1e30f);

    void seedBox(float xmin, float xmax, float ymin, float ymax, float zmin, float zmax,
                 TrackingPhaseID phase, float dx, float dy, float dz, int ppc, float density);

    void seedBox(float xmin, float xmax, float ymin, float ymax, float zmin, float zmax,
                 TrackingPhaseID phase, float density, int ppc_1d = 2);

    // Particle accessors
    size_t getParticleCount() const { return m_particles.size(); }
    const std::vector<PhaseTrackingParticle3D>& getParticles() const { return m_particles; }
    std::vector<PhaseTrackingParticle3D>& getParticles() { return m_particles; }

    // Adaptive Particle Refinement (Divergence Conforming)
    bool isAdaptive() const { return m_adaptive; }
    void setAdaptive(bool val) { m_adaptive = val; }
    void adaptParticlesCPU();
    void adaptParticlesGPU();

    // Advection: 2nd-order Runge-Kutta advection with divergence-conforming volume evolution
    // Complies with Directive 14 (Mandatory Minimum 2nd-Order Temporal Accuracy)
    void advectCPU(float dt,
                   int nx, int ny, int nz, float dx, float dy, float dz,
                   float xmin, float ymin, float zmin,
                   const float* u_grid, const float* v_grid, const float* w_grid);

    // Partition-of-Unity Remap: Projects particle volumes into Eulerian CFD cells
    // Guaranteed partition of unity (sum(alpha_k) = 1.0) and thermodynamic consistency
    void remapToCFD_CPU(int nx, int ny, int nz, float dx, float dy, float dz,
                        float xmin, float ymin, float zmin,
                        float sleeve_radius, float center_x, float center_y, float center_z,
                        float* cfd_alpha1, float* cfd_alpha2,
                        float* cfd_arho1, float* cfd_arho2,
                        float rho1_nominal, float rho2_nominal,
                        float* cfd_rho = nullptr,
                        float* cfd_ux = nullptr, float* cfd_uy = nullptr, float* cfd_uz = nullptr,
                        float* cfd_E = nullptr,
                        float rho0_water = 1025.0f, float water_B = 3.039e8f, float water_gamma = 7.15f);

    // GPU CUDA methods
    void syncToDevice();
    void syncToHost();
    void advectGPU(float dt, int nx, int ny, int nz, float dx, float dy, float dz,
                   float xmin, float ymin, float zmin,
                   const void* d_states, bool is_double, bool is_multimat);
    void remapToCFD_GPU(void* d_states, void* d_U, int nx, int ny, int nz, float dx, float dy, float dz,
                        float xmin, float ymin, float zmin,
                        bool is_double, bool is_multimat,
                        float rho1_nominal, float rho2_nominal,
                        float sleeve_radius = 1e9f, float cx = 0.0f, float cy = 0.0f, float cz = 0.0f,
                        float rho0_water = 1025.0f, float water_B = 3.039e8f, float water_gamma = 7.15f);

    // Telemetry & Export
    void extractTelemetry(std::vector<float>& out_buffer, int max_visual_particles = 65536) const;
    PhaseTrackingVTKSnapshot3D extractSnapshot() const;
    void extractVTKSnapshot(PhaseTrackingVTKSnapshot3D& snap) const { snap = extractSnapshot(); }

private:
    std::vector<PhaseTrackingParticle3D> m_particles;
    int m_max_capacity{500000};
    double m_xmin{0.0}, m_ymin{0.0}, m_zmin{0.0};
    double m_dx{0.1}, m_dy{0.1}, m_dz{0.1};
    int m_nx{0}, m_ny{0}, m_nz{0};
    bool m_is_cuda{false};
    bool m_adaptive{true};
    float m_split_vol_factor{2.0f};
    float m_merge_vol_factor{0.25f};

    // Device pointers for GPU execution
    void* d_x{nullptr};
    void* d_y{nullptr};
    void* d_z{nullptr};
    void* d_vx{nullptr};
    void* d_vy{nullptr};
    void* d_vz{nullptr};
    void* d_V{nullptr};
    void* d_V0{nullptr};
    void* d_m{nullptr};
    void* d_phase{nullptr};
    void* d_active{nullptr};
    int* d_count{nullptr};
    size_t d_capacity{0};

    // Device temporary grid reduction buffers
    float* d_grid_V_tot{nullptr};
    float* d_grid_V_gas{nullptr};
    float* d_grid_V_he{nullptr};
    size_t d_grid_capacity{0};
};

} // namespace Blast

#endif // PHASE_TRACKING_PARTICLES_3D_HPP
