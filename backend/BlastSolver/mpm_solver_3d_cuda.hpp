#ifndef MPM_SOLVER_3D_CUDA_HPP
#define MPM_SOLVER_3D_CUDA_HPP

#include "mpm_solver_3d.hpp"

namespace Blast {

class MPMSolver3DCUDA {
public:
    MPMSolver3DCUDA();
    ~MPMSolver3DCUDA();

    void initializeGrid(int nx, int ny, int nz, float dx, float dy, float dz);
    void setTransferScheme(MPMTransferScheme scheme) { m_transfer_scheme = scheme; }
    void setVelocityScheme(MPMVelocityScheme scheme) { m_velocity_scheme = scheme; }
    void setTimeScheme(MPMTimeIntegrationScheme scheme) { m_time_scheme = scheme; }
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

    void step(float cfl = 0.3f);
    void stepWithDt(float dt, bool run_p2g = true);
    float computeStepSize(float cfl = 0.3f);

    // Synchronize host vectors from device memory
    void syncToHost();
    void syncToDevice();

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
    MPMGridNode3D* getDeviceGrid() { return d_grid; }
    size_t getParticleCount() const { return m_host_particles.size(); }

private:
    void allocateDeviceMemory();
    void freeDeviceMemory();

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

    std::vector<MPMGridNode3D> m_host_grid;
    std::vector<MPMParticle3D> m_host_particles;

    MPMGridNode3D* d_grid{nullptr};
    MPMParticle3D* d_particles{nullptr};
    float* d_max_v_buf{nullptr};

    size_t m_allocated_grid_nodes{0};
    size_t m_allocated_particles{0};

    float m_last_dt{0.0f};
    float m_last_cfl{0.3f};
    float m_last_v_max{0.0f};
    double m_sim_time{0.0};
    int m_step_count{0};
    bool m_device_dirty{true};
};

} // namespace Blast

#endif // MPM_SOLVER_3D_CUDA_HPP
