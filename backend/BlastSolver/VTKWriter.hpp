#ifndef VTU_WRITER_HPP
#define VTU_WRITER_HPP

#include <string>
#include <vector>
#include <cstdint>

void export_vtu_1d(const std::string& filename, int n_cells, double dr, const std::vector<double>& rho, const std::vector<double>& u, const std::vector<double>& p, const std::vector<double>& E, const std::vector<double>& alpha1, const std::vector<double>& alpha2);

void export_vtu_2d(const std::string& filename, int nr, int nz, double dr, double dz, const std::vector<double>& rho, const std::vector<double>& ur, const std::vector<double>& uz, const std::vector<double>& p, const std::vector<double>& E, const std::vector<double>& alpha1, const std::vector<double>& alpha2);

void export_vtu_amr_2d(const std::string& filename,
                       const std::vector<double>& points,
                       const std::vector<int32_t>& connectivity,
                       const std::vector<int32_t>& offsets,
                       const std::vector<uint8_t>& types,
                       const std::vector<double>& rho,
                       const std::vector<double>& ur,
                       const std::vector<double>& uz,
                       const std::vector<double>& p,
                       const std::vector<double>& level);

void export_vtk_particles(const std::string& filename, int num_particles,
                           const double* pos_x, const double* pos_y,
                           const double* init_pos_x, const double* init_pos_y,
                           const double* stress_xx, const double* stress_yy,
                           const double* stress_xy, const double* stress_vm);

class CFDSolver3D;
struct Slice3D;

struct CFDSliceSnapshot3D {
    std::string axis = "xy";
    double offset = 0.0;
    int stride = 1;
    int nx = 0, ny = 0, nz = 0;
    double dx = 0.0, xmin = 0.0, ymin = 0.0, zmin = 0.0;
    int w = 0, h = 0;
    bool has_p = false, has_rho = false, has_vel = false, has_E = false;
    bool has_reacted = false, has_unreacted = false, has_air = false;
    bool has_solid = false, has_overpressure = false, has_impulse = false;
    std::vector<float> p, rho, vel, E, reacted, unreacted, air, solid, overpressure, impulse;
};

struct CFDVolumeSnapshot3D {
    int nx = 0, ny = 0, nz = 0;
    double cellSize = 0.0, xmin = 0.0, ymin = 0.0, zmin = 0.0;
    int stride = 1;
    bool roi_enabled = false;
    double roi_xmin = 0.0, roi_xmax = 1.0;
    double roi_ymin = 0.0, roi_ymax = 1.0;
    double roi_zmin = 0.0, roi_zmax = 1.0;
    int i_start = 0, i_end = 0, j_start = 0, j_end = 0, k_start = 0, k_end = 0;
    int nx_sub = 0, ny_sub = 0, nz_sub = 0;
    bool has_p = false, has_rho = false, has_vel = false, has_E = false;
    bool has_reacted = false, has_unreacted = false, has_air = false;
    bool has_solid = false, has_overpressure = false, has_impulse = false;
    std::vector<float> p, rho, vel, E, reacted, unreacted, air, solid, overpressure, impulse;
};

void export_vtu_slice_3d(const std::string& filename, const CFDSolver3D& solver, const Slice3D& slice, const std::string& format,
                         bool has_p, bool has_rho, bool has_vel, bool has_E,
                         bool has_reacted, bool has_unreacted, bool has_air,
                         bool has_solid = true, bool has_overpressure = true, bool has_impulse = true,
                         int slice_stride = 1);

void export_vtu_slice_3d_snapshot(const std::string& filename, const CFDSliceSnapshot3D& snap, const std::string& format = "Binary");

void export_vtu_volume_3d(const std::string& filename, const CFDSolver3D& solver, const std::string& format,
                          bool has_p, bool has_rho, bool has_vel, bool has_E,
                          bool has_reacted, bool has_unreacted, bool has_air,
                          bool has_solid = true, bool has_overpressure = true, bool has_impulse = true,
                          bool roi_enabled = false, double roi_xmin = 0.0, double roi_xmax = 1.0,
                          double roi_ymin = 0.0, double roi_ymax = 1.0,
                          double roi_zmin = 0.0, double roi_zmax = 1.0,
                          int volume_stride = 1);

void export_vtu_volume_3d_snapshot(const std::string& filename, const CFDVolumeSnapshot3D& snap, const std::string& format = "Binary");

namespace Blast {
template <typename T> class FEMSolver3D;
struct MPMParticle3D;
}

template <typename T>
void export_vtu_fem_3d(const std::string& filename, const Blast::FEMSolver3D<T>& solver, const std::string& format = "Binary",
                       bool has_stress = true, bool has_strain = true, bool has_pressure = true,
                       bool has_temp = true, bool has_damage = true, bool has_vel = true, bool has_disp = true);

void export_vtu_mpm_3d(const std::string& filename, const std::vector<Blast::MPMParticle3D>& particles, const std::string& format = "Binary",
                       bool has_vel = true, bool has_disp = true, bool has_stress = true,
                       bool has_strain = true, bool has_damage = true, bool has_temp = true);

void append_pvd_timestep(const std::string& pvd_filename, double sim_time, const std::string& relative_vtu_path, const std::string& part = "0");

#endif

