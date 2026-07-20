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

void export_vtu_slice_3d(const std::string& filename, const CFDSolver3D& solver, const Slice3D& slice, const std::string& format,
                         bool has_p, bool has_rho, bool has_vel, bool has_E,
                         bool has_reacted, bool has_unreacted, bool has_air,
                         bool has_solid = true, bool has_overpressure = true, bool has_impulse = true);

void export_vtu_volume_3d(const std::string& filename, const CFDSolver3D& solver, const std::string& format,
                          bool has_p, bool has_rho, bool has_vel, bool has_E,
                          bool has_reacted, bool has_unreacted, bool has_air,
                          bool has_solid = true, bool has_overpressure = true, bool has_impulse = true);

#endif
