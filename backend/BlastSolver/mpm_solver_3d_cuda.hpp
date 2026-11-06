#ifndef MPM_SOLVER_3D_CUDA_HPP
#define MPM_SOLVER_3D_CUDA_HPP

#include "mpm_solver_3d.hpp"
#include "VTKWriter.hpp"
#include "cfd_eos_water.hpp"

namespace Blast {

struct MPMParticle3DSoA {
    float* x[3]{nullptr, nullptr, nullptr};
    float* v[3]{nullptr, nullptr, nullptr};
    float* sigma[3][3]{};
    float* sigma_voigt[6]{}; // Voigt notation: 0=xx, 1=yy, 2=zz, 3=xy, 4=yz, 5=zx
    float* B[3][3]{};
    float* L_grad[3][3]{};
    float* lp[3]{nullptr, nullptr, nullptr};
    float* m{nullptr};
    float* V0{nullptr};
    float* V{nullptr};
    float* e_int{nullptr};
    float* temperature{nullptr};
    float* ep_bar{nullptr};
    float* damage{nullptr};
    float* lambda{nullptr};
    float* t_arrival{nullptr};
    float* v_min{nullptr};
    float* s_shock{nullptr};
    float* weibull_factor{nullptr};
    float* contact_radius{nullptr};
    int* has_failed{nullptr};
    int* object_id{nullptr};
    int* state{nullptr};
    int* cluster_id{nullptr};
    int* material_id{nullptr};
};

// 3D MPM Tile structure matching TILE_SIZE_3D = 8 (512 nodes per block) for CFD-MPM alignment
struct MPMTile3D {
    MPMGridNode3D nodes[512];
};

class MPMSolver3DCUDA {
public:
    MPMSolver3DCUDA();
    ~MPMSolver3DCUDA();

    void initializeGrid(int nx, int ny, int nz, float dx, float dy, float dz, float xmin = 0.0f, float ymin = 0.0f, float zmin = 0.0f);
    void setTransferScheme(MPMTransferScheme scheme) { m_transfer_scheme = scheme; }
    void setVelocityScheme(MPMVelocityScheme scheme) { m_velocity_scheme = scheme; }
    void setTimeScheme(MPMTimeIntegrationScheme scheme) { m_time_scheme = scheme; }
    void setSmoothPlasticStrain(bool smooth) { m_smooth_plastic_strain = smooth; }
    bool getSmoothPlasticStrain() const { return m_smooth_plastic_strain; }
    void setFlipBlend(float alpha) { m_flip_blend = alpha; }
    float getFlipBlend() const { return m_flip_blend; }

    // Discrete Element (DEM) Contact & Non-Penetration Pipeline
    void setDemContact(bool enable, float friction = 0.20f, float restitution = 0.0f, float scale = 1.0f,
                       MPMDEMContactMode mode = MPMDEMContactMode::GasSolidOnly, float v_threshold = 1.0f) {
        m_enable_dem_contact = enable;
        m_dem_friction = friction;
        m_dem_restitution = restitution;
        m_dem_contact_scale = scale;
        m_dem_contact_mode = mode;
        m_dem_velocity_threshold = v_threshold;
    }
    bool getEnableDemContact() const { return m_enable_dem_contact; }
    float getDemFriction() const { return m_dem_friction; }
    float getDemRestitution() const { return m_dem_restitution; }
    float getDemContactScale() const { return m_dem_contact_scale; }
    MPMDEMContactMode getDemContactMode() const { return m_dem_contact_mode; }
    float getDemVelocityThreshold() const { return m_dem_velocity_threshold; }
    void setDemContactMode(MPMDEMContactMode mode) { m_dem_contact_mode = mode; }
    void setDemVelocityThreshold(float v_thresh) { m_dem_velocity_threshold = v_thresh; }

    // Multi-Velocity Field (Bardenhagen) Contact Pipeline
    void setContactMethod(MPMContactMethod method);
    MPMContactMethod getContactMethod() const { return m_contact_method; }
    void setObjectMaterialMapping(const std::vector<int>& obj_to_mat, int num_materials);
    int getNumMaterials() const { return m_num_materials; }

    // Compact multi-material (Bardenhagen) grid storage.
    // Per-material grid fields are stored only on nodes where two or more material fields
    // overlap ("multi-material slots"). Single-material nodes use the global grid node directly,
    // which is arithmetically identical to the dense layout (the per-material copy of a
    // single-material node duplicates the global node). A 4-byte tag per node records
    // empty / owning material / slot index. Enabled by default; the dense layout is retained
    // for verification parity runs and is used automatically when zonal ghost coupling is on
    // (ghost mass enters the global node only, so the global node no longer equals the
    // single material field).
    void setCompactMultiMaterialStorage(bool enable);
    bool getCompactMultiMaterialStorage() const { return m_compact_mat_storage; }
    bool isCompactMultiMaterialStorageActive() const;
    int getNumMultiMaterialSlots() const { return m_num_mat_slots; }
    size_t getMultiMaterialSlotCapacity() const { return m_mat_slot_capacity; }
    size_t getMultiMaterialStorageBytes() const { return m_allocated_mat_grid_bytes + m_allocated_mat_tag_bytes; }
    // Initial number of compact multi-material slots (grown geometrically on demand, never shrunk
    // during a run). Lowering it below the current capacity resets the slot buffer.
    void setInitialMultiMaterialSlotCapacity(size_t slots);

    // Thermo-Mechanical Bonding, Frictional Heating & Thermal Conduction Toggles
    void setImpactWelding(bool enable) { m_enable_impact_welding = enable; }
    bool getEnableImpactWelding() const { return m_enable_impact_welding; }
    void setFrictionalHeating(bool enable) { m_enable_frictional_heating = enable; }
    bool getEnableFrictionalHeating() const { return m_enable_frictional_heating; }
    void setThermalConduction(bool enable) { m_enable_thermal_conduction = enable; }
    bool getEnableThermalConduction() const { return m_enable_thermal_conduction; }

    // Retained for backward API compatibility (Clean Single-Grid Continuum Contact)
    void setSdfBarrier([[maybe_unused]] bool enable = false,
                       [[maybe_unused]] float restitution = 0.10f,
                       [[maybe_unused]] float friction = 0.25f,
                       [[maybe_unused]] float skin = 0.15f) {}
    bool getEnableSdfBarrier() const { return false; }
    float getSdfBarrierRestitution() const { return 0.0f; }
    float getSdfBarrierFriction() const { return 0.0f; }
    float getSdfBarrierSkin() const { return 0.0f; }

    float getXMin() const { return m_xmin; }
    float getYMin() const { return m_ymin; }
    float getZMin() const { return m_zmin; }
    void setBoundaryConditions(MPMBoundaryCondition3D x_min, MPMBoundaryCondition3D x_max,
                               MPMBoundaryCondition3D y_min, MPMBoundaryCondition3D y_max,
                               MPMBoundaryCondition3D z_min, MPMBoundaryCondition3D z_max);
    bool is_terminated() const { return m_terminated; }
    void resetTermination() { m_terminated = false; }
    void setLysmerParams(const LysmerDashpotParams& params) { m_lysmer_params = params; }
    const LysmerDashpotParams& getLysmerParams() const { return m_lysmer_params; }
    void setZonalHandoffParams(const Blast::ZonalHandoff3DParams& params);
    const Blast::ZonalHandoff3DParams& getZonalHandoffParams() const { return m_zonal_params; }
    // Zonal FV -> MPM exterior coupling (overlapping Schwarz, ghost material points).
    // The FV solver writes its state into this per-node SoA buffer (MPM node layout
    // [(i * ny + j) * nz + k]) as 5 planes of nx*ny*nz floats: [p | rho | ux | uy | uz],
    // for cells in the exterior band of the sleeve, and the sentinel kZonalGhostNone in the
    // p-plane elsewhere. applyZonalGhostPressureTraction() integrates the exterior water as
    // ghost material points (sigma = -p * I, density rho, velocity u) over the region *outside*
    // the sleeve, with the same shape functions as P2G: ghosts add mass, momentum, mass-weighted
    // pressure and stress-divergence force to nodes that already carry particle mass.
    // Uniform pressure yields zero net boundary force, and boundary nodes carry their full
    // mass, so the interface has the acoustic impedance of the continuing water.
    static constexpr float kZonalGhostNone = -1.0e30f;
    static constexpr int kZonalGhostPlanes = 5;
    float* getZonalGhostPressureBuffer(); // allocates once (5 * nx*ny*nz floats) if not yet allocated
    void applyZonalGhostPressureTraction();

    // Gravity & Stratified Initial Condition
    void setGravity(float gx, float gy, float gz) {
        m_gravity[0] = gx;
        m_gravity[1] = gy;
        m_gravity[2] = gz;
        m_has_gravity = (gx != 0.0f || gy != 0.0f || gz != 0.0f);
    }
    bool hasGravity() const { return m_has_gravity; }
    const float* getGravity() const { return m_gravity; }
    void applyStratifiedInitialCondition(const Blast::Stratified3DParams& strat);

    void addBoxObject(int obj_id, float pos_x, float pos_y, float pos_z,
                      float size_x, float size_y, float size_z,
                      float vel_x, float vel_y, float vel_z,
                      float angular_vel_x, float angular_vel_y, float angular_vel_z,
                      float density, float E, float nu,
                      float yield_stress, float hardening, float failure_strain = 0.25f,
                      float tensile_failure_stress = 600.0e6f, int ppc = 8,
                      MPMParticleDistribution particle_dist = MPMParticleDistribution::Cartesian,
                      MPMBoundaryFilling boundary_fill = MPMBoundaryFilling::Stairstepped,
                      float rot_x = 0.0f, float rot_y = 0.0f, float rot_z = 0.0f,
                      float clip_z_min = -1.0e30f, float clip_z_max = 1.0e30f);

    void addSphereObject(int obj_id, float pos_x, float pos_y, float pos_z, float radius, float inner_radius,
                         float vel_x, float vel_y, float vel_z,
                         float angular_vel_x, float angular_vel_y, float angular_vel_z,
                         float density, float E, float nu,
                         float yield_stress, float hardening, float failure_strain = 0.25f,
                         float tensile_failure_stress = 600.0e6f, int ppc = 8,
                         MPMParticleDistribution particle_dist = MPMParticleDistribution::Cartesian,
                         MPMBoundaryFilling boundary_fill = MPMBoundaryFilling::Stairstepped,
                         float rot_x = 0.0f, float rot_y = 0.0f, float rot_z = 0.0f,
                         float clip_z_min = -1.0e30f, float clip_z_max = 1.0e30f);

    void addSphereObject(int obj_id, float pos_x, float pos_y, float pos_z, float radius,
                         float vel_x, float vel_y, float vel_z,
                         float angular_vel_x, float angular_vel_y, float angular_vel_z,
                         float density, float E, float nu,
                         float yield_stress, float hardening, float failure_strain = 0.25f,
                         float tensile_failure_stress = 600.0e6f, int ppc = 8,
                         MPMParticleDistribution particle_dist = MPMParticleDistribution::Cartesian,
                         MPMBoundaryFilling boundary_fill = MPMBoundaryFilling::Stairstepped,
                         float rot_x = 0.0f, float rot_y = 0.0f, float rot_z = 0.0f,
                         float clip_z_min = -1.0e30f, float clip_z_max = 1.0e30f) {
        addSphereObject(obj_id, pos_x, pos_y, pos_z, radius, 0.0f, vel_x, vel_y, vel_z, angular_vel_x, angular_vel_y, angular_vel_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
    }

    void addCylinderObject(int obj_id, float pos_x, float pos_y, float pos_z,
                           float radius, float inner_radius, float height,
                           float vel_x, float vel_y, float vel_z,
                           float angular_vel_x, float angular_vel_y, float angular_vel_z,
                           float density, float E, float nu,
                           float yield_stress, float hardening, float failure_strain = 0.25f,
                           float tensile_failure_stress = 600.0e6f, int ppc = 8,
                           MPMParticleDistribution particle_dist = MPMParticleDistribution::Cartesian,
                           MPMBoundaryFilling boundary_fill = MPMBoundaryFilling::Stairstepped,
                           float rot_x = 0.0f, float rot_y = 0.0f, float rot_z = 0.0f,
                           float clip_z_min = -1.0e30f, float clip_z_max = 1.0e30f);

    void addSTLObject(int obj_id, const std::string& stl_filepath,
                      float pos_x, float pos_y, float pos_z,
                      float scale_x, float scale_y, float scale_z,
                      float vel_x, float vel_y, float vel_z,
                      float angular_vel_x, float angular_vel_y, float angular_vel_z,
                      float density, float E, float nu,
                      float yield_stress, float hardening, float failure_strain = 0.25f,
                      float tensile_failure_stress = 600.0e6f, int ppc = 8,
                      MPMParticleDistribution particle_dist = MPMParticleDistribution::Cartesian,
                      MPMBoundaryFilling boundary_fill = MPMBoundaryFilling::Stairstepped,
                      const std::string& voxelization_method = "watertight_raycast",
                      float rot_x = 0.0f, float rot_y = 0.0f, float rot_z = 0.0f,
                      const std::string& origin_mode = "Center");

    void initMaterialHeterogeneity(int obj_id);
    void seedMottGradyFragments(int obj_id);

    void addParticlesDirect(const std::vector<MPMParticle3D>& particles) {
        if (particles.empty()) return;
        if (!m_host_particles.empty() && d_soa_buffer && !m_device_dirty) {
            syncParticlesToHost();
        }
        m_host_particles.insert(m_host_particles.end(), particles.begin(), particles.end());
        m_device_dirty = true;
        syncToDevice();
    }

    void step(float cfl = 0.6f);
    void stepWithDt(float dt, bool run_p2g = true);
    float computeStepSize(float cfl = 0.6f);

    // Synchronize host vectors from device memory
    void syncToHost();
    void syncParticlesToHost();
    void syncGridToHost();
    void syncToDevice();
    MPMVTKSnapshot3D extractVTKSnapshot(bool has_vel = true, bool has_stress = true, bool has_strain = true, bool has_damage = true, bool has_temp = true, bool has_pressure = true, bool has_material_id = true, bool has_object_id = true, bool has_particle_density = true);
    void uploadGridToDevice();
    void uploadMaterialTableToDevice();

    // Clear the active grid regions via particle neighborhood (fast sparse clear)
    void clearGridDevice();
    void evaluateDEMContactDevice(float dt);
    // Run only the P2G scatter pass on GPU, then sync grid to host for FSI force injection
    void particleToGridOnly();
    // Run P2G scatter pass entirely on GPU, with no host synchronization (high performance FSI)
    void particleToGridDeviceOnly();
    // Store the current host-grid f_ext values into a persistent device-side FSI buffer,
    // so they are automatically restored after every internal RK2 corrector P2G reset.
    void storeFSIForces();
    // Clear the persisted FSI forces (call at the start of each FSI timestep before building new forces)
    void clearFSIForces();

    std::vector<MaterialTable3D>& getMaterialTables() { return m_material_tables; }
    const std::vector<MaterialTable3D>& getMaterialTables() const { return m_material_tables; }
    const MaterialTable3D& getMaterialTable(int object_id) const {
        if (object_id >= 0 && object_id < static_cast<int>(m_material_tables.size())) {
            return m_material_tables[object_id];
        }
        static MaterialTable3D default_mat{};
        return default_mat;
    }
    void setMaterialTable(int object_id, const MaterialTable3D& mat) {
        if (object_id >= static_cast<int>(m_material_tables.size())) {
            m_material_tables.resize(object_id + 1);
        }
        m_material_tables[object_id] = mat;
        m_material_tables[object_id].synchronizePillars();
        if (m_material_tables[object_id].cell_dx <= 0.0f) {
            m_material_tables[object_id].cell_dx = m_dx;
        }
        initMaterialHeterogeneity(object_id);
    }

    // Detonator & Point Initiation Management
    void clearDetonators() { m_detonators.clear(); }
    void addDetonator(float x, float y, float z, float radius, float time_delay, bool track_velocity, int target_object_id = -1);
    void addDetonator(const MPMDetonator3D& det) { m_detonators.push_back(det); }
    const std::vector<MPMDetonator3D>& getDetonators() const { return m_detonators; }
    std::vector<MPMDetonator3D>& getDetonators() { return m_detonators; }
    bool interpolateGridVelocityDevice(float x, float y, float z, float& vx, float& vy, float& vz, int target_object_id = -1) const;
    void updateDetonators(float dt);
    void fireDetonator(MPMDetonator3D& det);

    const std::vector<MPMParticle3D>& getParticles() const { return m_host_particles; }
    const std::vector<MPMGridNode3D>& getGrid() const { return m_host_grid; }
    std::vector<MPMParticle3D>& getParticles() { return m_host_particles; }
    std::vector<MPMGridNode3D>& getGrid() { return m_host_grid; }

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

    // Device memory getters
    MPMParticle3D* getDeviceParticles() { return d_particles; }
    const MPMParticle3DSoA& getDeviceParticlesSoA() const { return d_soa; }
    MPMParticle3DSoA& getDeviceParticlesSoA() { return d_soa; }
    MPMGridNode3D* getDeviceGrid() { return d_grid; }
    int* getDeviceActiveNodes() { return d_active_nodes; }
    int getNumActiveNodes() const { return m_num_active_nodes; }
    MPMTile3D** getDeviceTilePtrs() { return nullptr; }
    int* getDeviceTileTable() { return nullptr; }
    MaterialTable3D* getDeviceMaterialTables() { return d_material_tables; }
    // Extract 2D slice directly on GPU to host vector (eliminates 512 MB PCIe downloads)
    void extractSliceToHost(std::vector<float>& out_slice, const std::string& axis, float offset, const std::string& req_qty = "plastic_strain");

    size_t getParticleCount() const { return m_num_active_particles > 0 ? m_num_active_particles : m_host_particles.size(); }
    size_t getActiveParticleCount() const { return m_num_active_particles; }
    size_t getAllocatedVRAM() const;

    int compactTerminatedParticlesDevice();

    void uploadAoS2SoA();
    void downloadSoA2AoS();

private:
    void allocateDeviceMemory();
    void freeDeviceMemory();
    void allocateSoABuffer(size_t count);
    void freeSoABuffer();

    int m_nx{32};
    int m_ny{32};
    int m_nz{32};
    float m_dx{0.01f};
    float m_dy{0.01f};
    float m_dz{0.01f};
    float m_gravity[3]{0.0f, 0.0f, 0.0f};
    bool m_has_gravity{false};

    MPMTransferScheme m_transfer_scheme{MPMTransferScheme::GIMP};
    MPMVelocityScheme m_velocity_scheme{MPMVelocityScheme::APIC};
    MPMTimeIntegrationScheme m_time_scheme{MPMTimeIntegrationScheme::Leapfrog};
    float m_flip_blend{0.95f};
    bool m_smooth_plastic_strain{true};
    bool m_enable_impact_welding{false};
    bool m_enable_frictional_heating{false};
    bool m_enable_thermal_conduction{false};

    MPMBoundaryCondition3D m_bc_x_min{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_x_max{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_y_min{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_y_max{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_z_min{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_z_max{MPMBoundaryCondition3D::Sticky};
    LysmerDashpotParams m_lysmer_params;
    Blast::ZonalHandoff3DParams m_zonal_params{};

    std::vector<MPMGridNode3D> m_host_grid;
    std::vector<MPMParticle3D> m_host_particles;
    std::vector<MaterialTable3D> m_material_tables;

    MPMGridNode3D* d_grid{nullptr};
    float* d_grid_n{nullptr};
    MPMParticle3D* d_particles{nullptr};
    MPMParticle3DSoA d_soa{};
    void* d_soa_buffer{nullptr};
    size_t m_allocated_soa_bytes{0};
    MaterialTable3D* d_material_tables{nullptr};
    size_t m_allocated_material_tables{0};
    float* d_max_v_buf{nullptr};
    int* d_max_v_pinned{nullptr};
    float* d_telemetry_slice_buf{nullptr};
    size_t m_allocated_slice_buf{0};
    // Persistent FSI external force buffer: 3 floats per node (fx, fy, fz)
    float* d_f_ext_fsi{nullptr};
    size_t m_allocated_f_ext_fsi{0};
    // Zonal exterior FV pressure band (1 float per node), allocated once in setZonalHandoffParams
    float* d_zonal_ghost_p{nullptr};
    size_t m_allocated_zonal_ghost_p{0};

    int* d_active_nodes{nullptr};
    int* d_num_active_nodes{nullptr};
    size_t m_allocated_active_nodes{0};
    int m_num_active_nodes{0};
    void allocateActiveNodeBuffers();
    void freeActiveNodeBuffers();

    MPMParticle3D* d_temp_aos_particles{nullptr};
    size_t m_allocated_temp_aos_particles{0};

    size_t m_allocated_grid_nodes{0};
    size_t m_allocated_particles{0};
    size_t m_num_active_particles{0};

    int* d_compaction_counters{nullptr};
    int* d_active_count{nullptr};
    int* d_boundary_flags{nullptr};
    int* d_compaction_indices{nullptr};
    size_t m_allocated_compaction_indices{0};

    // Zero-allocation GPU DEM contact acceleration buffers
    int* d_dem_cell_head{nullptr};
    int* d_dem_particle_next{nullptr};
    size_t m_allocated_dem_particles{0};
    static constexpr size_t DEM_HASH_TABLE_SIZE = 131072;

    bool m_enable_dem_contact{false};
    float m_dem_friction{0.20f};
    float m_dem_restitution{0.0f};
    float m_dem_contact_scale{1.0f};
    MPMDEMContactMode m_dem_contact_mode{MPMDEMContactMode::GasSolidOnly};
    float m_dem_velocity_threshold{1.0f};

    float m_last_dt{0.0f};
    float m_last_cfl{0.3f};
    mutable float m_last_v_max{0.0f};
    double m_sim_time{0.0};
    int m_step_count{0};
    bool m_terminated{false};
    bool m_device_dirty{true};
    float m_xmin{0.0f};
    float m_ymin{0.0f};
    float m_zmin{0.0f};
    float m_cached_dt{1.0e-6f};
    int m_dt_calc_counter{0};
    int m_ppc{8};

    MPMContactMethod m_contact_method{MPMContactMethod::SingleVelocity};
    std::vector<int> m_object_to_mat;
    int m_num_materials{1};

    void* d_mat_grid_buffer{nullptr};
    size_t m_allocated_mat_grid_bytes{0};
    float* d_mat_grid_m{nullptr};
    float* d_mat_grid_p{nullptr};
    float* d_mat_grid_f{nullptr};
    float* d_mat_grid_v{nullptr};
    float* d_mat_grid_dv{nullptr};
    int* d_mat_to_obj{nullptr};
    void allocateMatGridBuffers(size_t num_nodes, int num_materials);
    void freeMatGridBuffers();

    // Compact multi-material storage state (see setCompactMultiMaterialStorage)
    bool m_compact_mat_storage{true};
    bool m_mat_grid_compact_layout{false};  // layout of the currently allocated d_mat_grid_buffer
    int* d_mat_tag{nullptr};                 // per-node tag: -1 empty, [0,M) owning material, >= M slot + M
    size_t m_allocated_mat_tag_bytes{0};
    int* d_mat_slot_counters{nullptr};       // [0] = assigned multi-material slots, [1] = tag consistency violations
    size_t m_mat_slot_capacity{0};
    int m_mat_slot_materials{0};             // material count the slot buffer is laid out for
    int m_num_mat_slots{0};
    static constexpr size_t kInitialMatSlotCapacity = 131072;
    size_t m_initial_mat_slot_capacity{kInitialMatSlotCapacity};
    // (Re)allocates the compact slot buffer if needed; returns true if the buffer was replaced (zero-filled).
    bool allocateMatSlotBuffer(size_t slot_capacity, int num_materials);
    // Runs the full P2G scatter (tagging, slot assignment, scatter) and refreshes m_num_active_nodes.
    void launchParticleToGrid(int num_particles, bool use_bardenhagen);

    std::vector<MPMDetonator3D> m_detonators;
    float* d_det_vel_buffer{nullptr};
};

} // namespace Blast

#endif // MPM_SOLVER_3D_CUDA_HPP
