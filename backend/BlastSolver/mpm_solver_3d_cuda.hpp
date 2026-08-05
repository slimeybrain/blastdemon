#ifndef MPM_SOLVER_3D_CUDA_HPP
#define MPM_SOLVER_3D_CUDA_HPP

#include "mpm_solver_3d.hpp"

namespace Blast {

struct MPMParticle3DSoA {
    float* x[3]{nullptr, nullptr, nullptr};
    float* v[3]{nullptr, nullptr, nullptr};
    float* sigma[3][3]{};
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
    int* has_failed{nullptr};
    int* object_id{nullptr};
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
    float getXMin() const { return m_xmin; }
    float getYMin() const { return m_ymin; }
    float getZMin() const { return m_zmin; }
    void setBoundaryConditions(MPMBoundaryCondition3D x_min, MPMBoundaryCondition3D x_max,
                               MPMBoundaryCondition3D y_min, MPMBoundaryCondition3D y_max,
                               MPMBoundaryCondition3D z_min, MPMBoundaryCondition3D z_max);

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

    void step(float cfl = 0.3f);
    void stepWithDt(float dt, bool run_p2g = true);
    float computeStepSize(float cfl = 0.3f);

    // Synchronize host vectors from device memory
    void syncToHost();
    void syncParticlesToHost();
    void syncToDevice();
    void uploadGridToDevice();
    void uploadMaterialTableToDevice();

    // Clear the active grid regions via particle neighborhood (fast sparse clear)
    void clearGridDevice();
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
    MaterialTable3D* getDeviceMaterialTables() { return d_material_tables; }
    size_t getParticleCount() const { return m_host_particles.size(); }
    size_t getAllocatedVRAM() const;

private:
    void allocateDeviceMemory();
    void freeDeviceMemory();
    void allocateSoABuffer(size_t count);
    void freeSoABuffer();
    void uploadAoS2SoA();
    void downloadSoA2AoS();

    int m_nx{32};
    int m_ny{32};
    int m_nz{32};
    float m_dx{0.01f};
    float m_dy{0.01f};
    float m_dz{0.01f};

    MPMTransferScheme m_transfer_scheme{MPMTransferScheme::GIMP};
    MPMVelocityScheme m_velocity_scheme{MPMVelocityScheme::APIC};
    MPMTimeIntegrationScheme m_time_scheme{MPMTimeIntegrationScheme::USL};
    float m_flip_blend{0.95f};
    bool m_smooth_plastic_strain{true};

    MPMBoundaryCondition3D m_bc_x_min{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_x_max{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_y_min{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_y_max{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_z_min{MPMBoundaryCondition3D::Sticky};
    MPMBoundaryCondition3D m_bc_z_max{MPMBoundaryCondition3D::Sticky};

    std::vector<MPMGridNode3D> m_host_grid;
    std::vector<MPMParticle3D> m_host_particles;
    std::vector<MaterialTable3D> m_material_tables;

    MPMGridNode3D* d_grid{nullptr};
    MPMGridNode3D* d_grid_n{nullptr};
    MPMParticle3D* d_particles{nullptr};
    MPMParticle3DSoA d_soa{};
    void* d_soa_buffer{nullptr};
    size_t m_allocated_soa_bytes{0};
    MaterialTable3D* d_material_tables{nullptr};
    size_t m_allocated_material_tables{0};
    float* d_max_v_buf{nullptr};
    // Persistent FSI external force buffer: 3 floats per node (fx, fy, fz)
    float* d_f_ext_fsi{nullptr};
    size_t m_allocated_f_ext_fsi{0};

    int* d_active_nodes{nullptr};
    int* d_num_active_nodes{nullptr};
    size_t m_allocated_active_nodes{0};
    int m_num_active_nodes{0};
    void allocateActiveNodeBuffers();
    void freeActiveNodeBuffers();

    size_t m_allocated_grid_nodes{0};
    size_t m_allocated_particles{0};

    float m_last_dt{0.0f};
    float m_last_cfl{0.3f};
    float m_last_v_max{0.0f};
    double m_sim_time{0.0};
    int m_step_count{0};
    bool m_device_dirty{true};
    float m_xmin{0.0f};
    float m_ymin{0.0f};
    float m_zmin{0.0f};
    float m_cached_dt{1.0e-6f};
    int m_dt_calc_counter{0};
};

} // namespace Blast

#endif // MPM_SOLVER_3D_CUDA_HPP
