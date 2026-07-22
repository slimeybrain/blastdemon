#include "cfd_solver_3d.hpp"
#include "cfd_states.hpp"
#include <vector>
#include <cmath>
#include <algorithm>
#include <iostream>

/**
 * remap_1d_to_3d
 * Projects 1D spherical simulation results onto a 3D Cartesian grid.
 * Uses 27-point subgrid averaging (3x3x3) per cell for robust volume-weighted remapping.
 */
void remap_1d_to_3d(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d,
                    CFDSolver3D& solver_3d, double x_expl, double y_expl, double z_expl, double R_remap) {

    int nx = solver_3d.getNx();
    int ny = solver_3d.getNy();
    int nz = solver_3d.getNz();
    double dx = solver_3d.getCellSize();

    auto interp_1d = [&](double r) -> MultiMaterialState {
        if (r <= r_1d.front()) return states_1d.front();
        if (r >= r_1d.back()) return states_1d.back();

        auto it = std::lower_bound(r_1d.begin(), r_1d.end(), r);
        size_t idx = std::distance(r_1d.begin(), it);
        if (idx == 0) return states_1d[0];

        double r0 = r_1d[idx-1];
        double r1 = r_1d[idx];
        double t = (r - r0) / (r1 - r0);

        const auto& s0 = states_1d[idx-1];
        const auto& s1 = states_1d[idx];

        MultiMaterialState res;
        res.rho = s0.rho + t * (s1.rho - s0.rho);
        res.u = s0.u + t * (s1.u - s0.u);
        res.p = s0.p + t * (s1.p - s0.p);
        res.alpha1 = s0.alpha1 + t * (s1.alpha1 - s0.alpha1);
        res.alpha2 = s0.alpha2 + t * (s1.alpha2 - s0.alpha2);
        res.arho1 = s0.arho1 + t * (s1.arho1 - s0.arho1);
        res.arho2 = s0.arho2 + t * (s1.arho2 - s0.arho2);
        return res;
    };

    #pragma omp parallel for collapse(3)
    for (int k = 0; k < nz; ++k) {
        for (int j = 0; j < ny; ++j) {
            for (int i = 0; i < nx; ++i) {
                double x_c = solver_3d.getXMin() + (i + 0.5) * dx;
                double y_c = solver_3d.getYMin() + (j + 0.5) * dx;
                double z_c = solver_3d.getZMin() + (k + 0.5) * dx;

                double dx_expl = x_c - x_expl;
                double dy_expl = y_c - y_expl;
                double dz_expl = z_c - z_expl;
                double dist = std::sqrt(dx_expl*dx_expl + dy_expl*dy_expl + dz_expl*dz_expl);

                if (dist > R_remap + dx * 2.0) continue;

                // 27-point subgrid averaging
                MultiMaterialState avg;
                avg.rho = avg.u = avg.p = avg.alpha1 = avg.alpha2 = avg.arho1 = avg.arho2 = 0;

                const double sub[3] = {-0.333, 0.0, 0.333};
                for (int sk = 0; sk < 3; ++sk) {
                    for (int sj = 0; sj < 3; sj++) {
                        for (int si = 0; si < 3; si++) {
                            double sx = x_c + sub[si] * dx;
                            double sy = y_c + sub[sj] * dx;
                            double sz = z_c + sub[sk] * dx;
                            double r = std::sqrt((sx-x_expl)*(sx-x_expl) + (sy-y_expl)*(sy-y_expl) + (sz-z_expl)*(sz-z_expl));
                            auto s = interp_1d(r);
                            avg.rho += s.rho; avg.u += s.u; avg.p += s.p;
                            avg.alpha1 += s.alpha1; avg.alpha2 += s.alpha2;
                            avg.arho1 += s.arho1; avg.arho2 += s.arho2;
                        }
                    }
                }

                double inv27 = 1.0 / 27.0;
                CellState3D<true> s3d;
                s3d.rho = avg.rho * inv27;
                double u_mag = avg.u * inv27;
                if (dist > 1e-9) {
                    s3d.ux = u_mag * (dx_expl / dist);
                    s3d.uy = u_mag * (dy_expl / dist);
                    s3d.uz = u_mag * (dz_expl / dist);
                } else {
                    s3d.ux = s3d.uy = s3d.uz = 0;
                }
                s3d.p = avg.p * inv27;
                s3d.alpha1 = avg.alpha1 * inv27;
                s3d.alpha2 = avg.alpha2 * inv27;
                s3d.arho1 = avg.arho1 * inv27;
                s3d.arho2 = avg.arho2 * inv27;

                double ke = 0.5 * s3d.rho * (s3d.ux*s3d.ux + s3d.uy*s3d.uy + s3d.uz*s3d.uz);
                if (solver_3d.isIdealGas()) {
                    s3d.E = s3d.p / (solver_3d.getGamma() - 1.0) + ke;
                    CellState3D<false> s_gas;
                    s_gas.rho = s3d.rho;
                    s_gas.ux = s3d.ux;
                    s_gas.uy = s3d.uy;
                    s_gas.uz = s3d.uz;
                    s_gas.p = s3d.p;
                    s_gas.E = s3d.E;
                    solver_3d.setCellStateIdeal(i, j, k, s_gas);
                } else {
                    const auto& mat = solver_3d.getMaterialParameters();
                    s3d.E = MultiMat::getMixtureEnergy(s3d.p, s3d.rho, s3d.alpha1, s3d.alpha2, s3d.arho1, s3d.arho2, solver_3d.getGamma(), mat.products, mat.unreacted) + ke;
                    solver_3d.setCellStateMulti(i, j, k, s3d);
                }
            }
        }
    }
    solver_3d.commitStates();
}

/**
 * remap_2d_to_3d
 * Projects 2D axisymmetric (r, z) simulation results onto a 3D Cartesian grid.
 * Revolves the 2D radial profile around the specified origin (x_expl, y_expl, z_expl).
 * Uses 27-point subgrid averaging per cell for robust volume-weighted remapping.
 */
void remap_2d_to_3d(int nr, int nz, double dr, double dz, const std::vector<State2D>& states_2d,
                    CFDSolver3D& solver_3d, double x_expl, double y_expl, double z_expl, double R_remap) {

    int nx = solver_3d.getNx();
    int ny = solver_3d.getNy();
    int nz_3d = solver_3d.getNz();
    double dx = solver_3d.getCellSize();

    auto interp_2d = [&](double r, double z) -> State2D {
        if (r < 0.0) r = 0.0;
        if (z < 0.0) z = 0.0;

        double max_r = nr * dr;
        double max_z = nz * dz;

        if (r >= max_r - 1e-9) r = max_r - 1e-9;
        if (z >= max_z - 1e-9) z = max_z - 1e-9;

        double r_idx_f = (r / dr) - 0.5;
        double z_idx_f = (z / dz) - 0.5;

        if (r_idx_f < 0.0) r_idx_f = 0.0;
        if (z_idx_f < 0.0) z_idx_f = 0.0;

        int i0 = static_cast<int>(r_idx_f);
        int j0 = static_cast<int>(z_idx_f);
        int i1 = std::min(i0 + 1, nr - 1);
        int j1 = std::min(j0 + 1, nz - 1);

        double tr = r_idx_f - i0;
        double tz = z_idx_f - j0;

        const auto& s00 = states_2d[i0 + j0 * nr];
        const auto& s10 = states_2d[i1 + j0 * nr];
        const auto& s01 = states_2d[i0 + j1 * nr];
        const auto& s11 = states_2d[i1 + j1 * nr];

        State2D res;
        auto blend = [&](double a, double b, double c, double d) {
            return (1.0 - tr) * (1.0 - tz) * a + tr * (1.0 - tz) * b + (1.0 - tr) * tz * c + tr * tz * d;
        };

        res.rho = blend(s00.rho, s10.rho, s01.rho, s11.rho);
        res.ur = blend(s00.ur, s10.ur, s01.ur, s11.ur);
        res.uz = blend(s00.uz, s10.uz, s01.uz, s11.uz);
        res.p = blend(s00.p, s10.p, s01.p, s11.p);
        res.alpha1 = blend(s00.alpha1, s10.alpha1, s01.alpha1, s11.alpha1);
        res.alpha2 = blend(s00.alpha2, s10.alpha2, s01.alpha2, s11.alpha2);
        res.arho1 = blend(s00.arho1, s10.arho1, s01.arho1, s11.arho1);
        res.arho2 = blend(s00.arho2, s10.arho2, s01.arho2, s11.arho2);
        return res;
    };

    #pragma omp parallel for collapse(3)
    for (int k = 0; k < nz_3d; ++k) {
        for (int j = 0; j < ny; ++j) {
            for (int i = 0; i < nx; ++i) {
                double x_c = solver_3d.getXMin() + (i + 0.5) * dx;
                double y_c = solver_3d.getYMin() + (j + 0.5) * dx;
                double z_c = solver_3d.getZMin() + (k + 0.5) * dx;

                double dx_expl = x_c - x_expl;
                double dy_expl = y_c - y_expl;
                double dz_expl = z_c - z_expl;
                double r_dist = std::sqrt(dx_expl * dx_expl + dy_expl * dy_expl);
                double dist_total = std::sqrt(r_dist * r_dist + dz_expl * dz_expl);

                if (R_remap > 0.0 && dist_total > R_remap + dx * 2.0) continue;

                // 27-point subgrid averaging
                State2D avg;
                avg.rho = avg.ur = avg.uz = avg.p = avg.alpha1 = avg.alpha2 = avg.arho1 = avg.arho2 = 0;

                const double sub[3] = {-0.333, 0.0, 0.333};
                for (int sk = 0; sk < 3; ++sk) {
                    for (int sj = 0; sj < 3; sj++) {
                        for (int si = 0; si < 3; si++) {
                            double sx = x_c + sub[si] * dx;
                            double sy = y_c + sub[sj] * dx;
                            double sz = z_c + sub[sk] * dx;
                            double sr = std::sqrt((sx - x_expl)*(sx - x_expl) + (sy - y_expl)*(sy - y_expl));
                            double s_z = std::abs(sz - z_expl);
                            auto s = interp_2d(sr, s_z);
                            avg.rho += s.rho; avg.ur += s.ur; avg.uz += s.uz; avg.p += s.p;
                            avg.alpha1 += s.alpha1; avg.alpha2 += s.alpha2;
                            avg.arho1 += s.arho1; avg.arho2 += s.arho2;
                        }
                    }
                }

                double inv27 = 1.0 / 27.0;
                CellState3D<true> s3d;
                s3d.rho = avg.rho * inv27;
                double ur_avg = avg.ur * inv27;
                double uz_avg = avg.uz * inv27;

                if (r_dist > 1e-9) {
                    s3d.ux = ur_avg * (dx_expl / r_dist);
                    s3d.uy = ur_avg * (dy_expl / r_dist);
                } else {
                    s3d.ux = s3d.uy = 0;
                }
                s3d.uz = uz_avg;
                s3d.p = avg.p * inv27;
                s3d.alpha1 = avg.alpha1 * inv27;
                s3d.alpha2 = avg.alpha2 * inv27;
                s3d.arho1 = avg.arho1 * inv27;
                s3d.arho2 = avg.arho2 * inv27;

                double ke = 0.5 * s3d.rho * (s3d.ux*s3d.ux + s3d.uy*s3d.uy + s3d.uz*s3d.uz);
                if (solver_3d.isIdealGas()) {
                    s3d.E = s3d.p / (solver_3d.getGamma() - 1.0) + ke;
                    CellState3D<false> s_gas;
                    s_gas.rho = s3d.rho;
                    s_gas.ux = s3d.ux;
                    s_gas.uy = s3d.uy;
                    s_gas.uz = s3d.uz;
                    s_gas.p = s3d.p;
                    s_gas.E = s3d.E;
                    solver_3d.setCellStateIdeal(i, j, k, s_gas);
                } else {
                    const auto& mat = solver_3d.getMaterialParameters();
                    s3d.E = MultiMat::getMixtureEnergy(s3d.p, s3d.rho, s3d.alpha1, s3d.alpha2, s3d.arho1, s3d.arho2, solver_3d.getGamma(), mat.products, mat.unreacted) + ke;
                    solver_3d.setCellStateMulti(i, j, k, s3d);
                }
            }
        }
    }
    solver_3d.commitStates();
}
