#ifndef VTU_WRITER_HPP
#define VTU_WRITER_HPP

#include <string>
#include <vector>

void export_vtu_1d(const std::string& filename, int n_cells, double dr, const std::vector<double>& rho, const std::vector<double>& u, const std::vector<double>& p, const std::vector<double>& E, const std::vector<double>& alpha1, const std::vector<double>& alpha2);

void export_vtu_2d(const std::string& filename, int nr, int nz, double dr, double dz, const std::vector<double>& rho, const std::vector<double>& ur, const std::vector<double>& uz, const std::vector<double>& p, const std::vector<double>& E, const std::vector<double>& alpha1, const std::vector<double>& alpha2);

void export_vtk_particles(const std::string& filename, int num_particles,
                           const double* pos_x, const double* pos_y,
                           const double* init_pos_x, const double* init_pos_y,
                           const double* stress_xx, const double* stress_yy,
                           const double* stress_xy, const double* stress_vm);

#endif
