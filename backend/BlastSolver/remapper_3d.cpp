#include "cfd_solver_3d.hpp"
#include "cfd_states.hpp"
#include <vector>
#include <cmath>
#include <algorithm>
#include <iostream>

/**
 * remap_1d_to_3d
 * Projects 1D spherical simulation results onto a 3D Cartesian grid.
 * Uses 27-point subgrid CONSERVATIVE volume integration per cell.
 */
void remap_1d_to_3d(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d,
                    CFDSolver3D& solver_3d, double x_expl, double y_expl, double z_expl, double R_remap) {

    int nx = solver_3d.getNx();
    int ny = solver_3d.getNy();
    int nz = solver_3d.getNz();
    double dx = solver_3d.getCellSize();
    double gamma = solver_3d.getGamma();
    bool is_ideal = solver_3d.isIdealGas();
    const auto& mat = solver_3d.getMaterialParameters();

    double r_max_1d = r_1d.back();
    MultiMaterialState amb_state = states_1d.back();
    if (solver_3d.getAmbientP() > 0.0) amb_state.p = solver_3d.getAmbientP();
    if (solver_3d.getAmbientRho() > 0.0) amb_state.rho = solver_3d.getAmbientRho();
    amb_state.u = 0.0;

    auto interp_1d = [&](double r) -> MultiMaterialState {
        if (r <= r_1d.front()) return states_1d.front();
        if (r >= r_1d.back()) return amb_state;

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

                // Cutoff only if dist is far outside max domain profile radius
                double cut_r = (R_remap > 0.0) ? std::min(R_remap, r_max_1d) : r_max_1d;
                if (dist > cut_r + dx * 2.0) {
                    const auto& amb = amb_state;
                    if (is_ideal) {
                        CellState3D<false> s_gas;
                        s_gas.rho = amb.rho;
                        s_gas.ux = s_gas.uy = s_gas.uz = 0.0;
                        s_gas.p = amb.p;
                        s_gas.E = amb.p / (gamma - 1.0);
                        solver_3d.setCellStateIdeal(i, j, k, s_gas);
                    } else {
                        CellState3D<true> s3d;
                        s3d.rho = amb.rho;
                        s3d.ux = s3d.uy = s3d.uz = 0.0;
                        s3d.p = amb.p;
                        s3d.alpha1 = 0.0; s3d.alpha2 = 0.0;
                        s3d.arho1 = 0.0; s3d.arho2 = 0.0;
                        s3d.E = amb.p / (gamma - 1.0);
                        solver_3d.setCellStateMulti(i, j, k, s3d);
                    }
                    continue;
                }

                // 27-point conservative volume integration
                double sum_rho = 0.0;
                double sum_rhoux = 0.0;
                double sum_rhouy = 0.0;
                double sum_rhouz = 0.0;
                double sum_p = 0.0;
                double sum_alpha1 = 0.0;
                double sum_alpha2 = 0.0;
                double sum_arho1 = 0.0;
                double sum_arho2 = 0.0;

                const double sub[3] = {-0.333333333, 0.0, 0.333333333};
                for (int sk = 0; sk < 3; ++sk) {
                    for (int sj = 0; sj < 3; sj++) {
                        for (int si = 0; si < 3; si++) {
                            double sx = x_c + sub[si] * dx;
                            double sy = y_c + sub[sj] * dx;
                            double sz = z_c + sub[sk] * dx;
                            double rx = sx - x_expl;
                            double ry = sy - y_expl;
                            double rz = sz - z_expl;
                            double sr = std::sqrt(rx*rx + ry*ry + rz*rz);

                            auto s = interp_1d(sr);

                            double sux = 0.0, suy = 0.0, suz = 0.0;
                            if (sr > 1e-9) {
                                sux = s.u * (rx / sr);
                                suy = s.u * (ry / sr);
                                suz = s.u * (rz / sr);
                            }

                            if (!is_ideal) {
                                double a1 = s.alpha1, a2 = s.alpha2;
                                // Removed forced alpha2 = 1.0; ambient air is alpha1=0, alpha2=0
                                double ar1 = s.arho1, ar2 = s.arho2;
                                sum_alpha1 += a1;
                                sum_alpha2 += a2;
                                sum_arho1 += ar1;
                                sum_arho2 += ar2;
                            }

                            sum_rho += s.rho;
                            sum_rhoux += s.rho * sux;
                            sum_rhouy += s.rho * suy;
                            sum_rhouz += s.rho * suz;
                            sum_p += s.p;
                        }
                    }
                }

                double inv27 = 1.0 / 27.0;
                double rho_avg = sum_rho * inv27;
                double rhoux_avg = sum_rhoux * inv27;
                double rhouy_avg = sum_rhouy * inv27;
                double rhouz_avg = sum_rhouz * inv27;
                double p_avg = std::max(1e-6, sum_p * inv27);

                double ux_avg = rhoux_avg / std::max(1e-9, rho_avg);
                double uy_avg = rhouy_avg / std::max(1e-9, rho_avg);
                double uz_avg = rhouz_avg / std::max(1e-9, rho_avg);
                double ke_avg = 0.5 * rho_avg * (ux_avg*ux_avg + uy_avg*uy_avg + uz_avg*uz_avg);

                if (is_ideal) {
                    CellState3D<false> s_gas;
                    s_gas.rho = rho_avg;
                    s_gas.ux = ux_avg;
                    s_gas.uy = uy_avg;
                    s_gas.uz = uz_avg;
                    s_gas.p = p_avg;
                    s_gas.E = p_avg / (gamma - 1.0) + ke_avg;
                    solver_3d.setCellStateIdeal(i, j, k, s_gas);
                } else {
                    double a1_avg = sum_alpha1 * inv27;
                    double a2_avg = sum_alpha2 * inv27;
                    // Ambient is alpha1=0, alpha2=0
                    double ar1_avg = sum_arho1 * inv27;
                    double ar2_avg = sum_arho2 * inv27;

                    CellState3D<true> s3d;
                    s3d.rho = rho_avg;
                    s3d.ux = ux_avg;
                    s3d.uy = uy_avg;
                    s3d.uz = uz_avg;
                    s3d.p = p_avg;
                    s3d.E = MultiMat::getMixtureEnergy(p_avg, rho_avg, a1_avg, a2_avg, ar1_avg, ar2_avg, gamma, mat.products, mat.unreacted) + ke_avg;
                    s3d.alpha1 = a1_avg;
                    s3d.alpha2 = a2_avg;
                    s3d.arho1 = ar1_avg;
                    s3d.arho2 = ar2_avg;
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
 * Uses 27-point subgrid CONSERVATIVE volume integration per cell.
 */
void remap_2d_to_3d(int nr, int nz, double dr, double dz, const std::vector<State2D>& states_2d,
                    CFDSolver3D& solver_3d, double x_expl, double y_expl, double z_expl, double R_remap, double source_explosive_z) {

    int nx = solver_3d.getNx();
    int ny = solver_3d.getNy();
    int nz_3d = solver_3d.getNz();
    double dx = solver_3d.getCellSize();
    double gamma = solver_3d.getGamma();
    bool is_ideal = solver_3d.isIdealGas();
    const auto& mat = solver_3d.getMaterialParameters();

    double max_r_2d = nr * dr;
    double max_z_2d = nz * dz;

    State2D amb_state = states_2d.back();
    if (solver_3d.getAmbientP() > 0.0) amb_state.p = solver_3d.getAmbientP();
    if (solver_3d.getAmbientRho() > 0.0) amb_state.rho = solver_3d.getAmbientRho();
    amb_state.ur = 0.0;
    amb_state.uz = 0.0;

    auto interp_2d = [&](double r, double z) -> State2D {
        if (r < 0.0) r = 0.0;
        if (z < 0.0) z = 0.0;

        if (r >= max_r_2d - 1e-9 || z >= max_z_2d - 1e-9) {
            return amb_state;
        }

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

        // 2D telemetry is flattened as r_idx * nz + z_idx
        const auto& s00 = states_2d[i0 * nz + j0];
        const auto& s10 = states_2d[i1 * nz + j0];
        const auto& s01 = states_2d[i0 * nz + j1];
        const auto& s11 = states_2d[i1 * nz + j1];

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

                if (R_remap > 0.0 && dist_total > R_remap) {
                    const auto& amb = amb_state;
                    if (is_ideal) {
                        CellState3D<false> s_gas;
                        s_gas.rho = amb.rho;
                        s_gas.ux = s_gas.uy = s_gas.uz = 0.0;
                        s_gas.p = amb.p;
                        s_gas.E = amb.p / (gamma - 1.0);
                        solver_3d.setCellStateIdeal(i, j, k, s_gas);
                    } else {
                        CellState3D<true> s3d;
                        s3d.rho = amb.rho;
                        s3d.ux = s3d.uy = s3d.uz = 0.0;
                        s3d.p = amb.p;
                        s3d.alpha1 = 0.0; s3d.alpha2 = 0.0;
                        s3d.arho1 = 0.0; s3d.arho2 = 0.0;
                        s3d.E = amb.p / (gamma - 1.0);
                        solver_3d.setCellStateMulti(i, j, k, s3d);
                    }
                    continue;
                }

                // 27-point conservative volume integration
                double sum_rho = 0.0;
                double sum_rhoux = 0.0;
                double sum_rhouy = 0.0;
                double sum_rhouz = 0.0;
                double sum_p = 0.0;
                double sum_alpha1 = 0.0;
                double sum_alpha2 = 0.0;
                double sum_arho1 = 0.0;
                double sum_arho2 = 0.0;

                const double sub[3] = {-0.333333333, 0.0, 0.333333333};
                for (int sk = 0; sk < 3; ++sk) {
                    for (int sj = 0; sj < 3; sj++) {
                        for (int si = 0; si < 3; si++) {
                            double sx = x_c + sub[si] * dx;
                            double sy = y_c + sub[sj] * dx;
                            double sz = z_c + sub[sk] * dx;
                            double rx = sx - x_expl;
                            double ry = sy - y_expl;
                            double rz = sz - z_expl;
                            double sr = std::sqrt(rx * rx + ry * ry);
                            double s_z = source_explosive_z + rz;
                            bool is_below_ground_hemisphere = false;
                            if (s_z < 0.0) {
                                if (source_explosive_z <= 1e-6) {
                                    // 2D source was at z=0 (ground-burst hemisphere).
                                    // Mirror z for bottom hemisphere in 3D and negate uz so velocity points downward away from charge.
                                    s_z = -s_z;
                                    is_below_ground_hemisphere = true;
                                } else {
                                    // 2D source was an air-burst (z > 0).
                                    // s_z < 0 is below the 2D ground wall -> clamp to z=0.
                                    s_z = 0.0;
                                }
                            } else if (s_z >= max_z_2d) {
                                s_z = max_z_2d - 1e-9;
                            }

                            auto s = interp_2d(sr, s_z);

                            double sux = 0.0, suy = 0.0;
                            if (sr > 1e-9) {
                                sux = s.ur * (rx / sr);
                                suy = s.ur * (ry / sr);
                            }

                            double suz = s.uz;
                            if (is_below_ground_hemisphere) {
                                suz = -s.uz;
                            } else if (source_explosive_z > 1e-6 && (source_explosive_z + rz) < 0.0) {
                                suz = 0.0; // Below 2D ground wall
                            }

                            if (!is_ideal) {
                                double a1 = s.alpha1, a2 = s.alpha2;
                                double ar1 = s.arho1, ar2 = s.arho2;
                                sum_alpha1 += a1;
                                sum_alpha2 += a2;
                                sum_arho1 += ar1;
                                sum_arho2 += ar2;
                            }

                            sum_rho += s.rho;
                            sum_rhoux += s.rho * sux;
                            sum_rhouy += s.rho * suy;
                            sum_rhouz += s.rho * suz;
                            sum_p += s.p;
                        }
                    }
                }

                double inv27 = 1.0 / 27.0;
                double rho_avg = sum_rho * inv27;
                double rhoux_avg = sum_rhoux * inv27;
                double rhouy_avg = sum_rhouy * inv27;
                double rhouz_avg = sum_rhouz * inv27;
                double p_avg = std::max(1e-6, sum_p * inv27);

                double ux_avg = rhoux_avg / std::max(1e-9, rho_avg);
                double uy_avg = rhouy_avg / std::max(1e-9, rho_avg);
                double uz_avg = rhouz_avg / std::max(1e-9, rho_avg);
                double ke_avg = 0.5 * rho_avg * (ux_avg*ux_avg + uy_avg*uy_avg + uz_avg*uz_avg);

                if (is_ideal) {
                    CellState3D<false> s_gas;
                    s_gas.rho = rho_avg;
                    s_gas.ux = ux_avg;
                    s_gas.uy = uy_avg;
                    s_gas.uz = uz_avg;
                    s_gas.p = p_avg;
                    s_gas.E = p_avg / (gamma - 1.0) + ke_avg;
                    solver_3d.setCellStateIdeal(i, j, k, s_gas);
                } else {
                    double a1_avg = sum_alpha1 * inv27;
                    double a2_avg = sum_alpha2 * inv27;
                    // Ambient is alpha1=0, alpha2=0
                    double ar1_avg = sum_arho1 * inv27;
                    double ar2_avg = sum_arho2 * inv27;

                    CellState3D<true> s3d;
                    s3d.rho = rho_avg;
                    s3d.ux = ux_avg;
                    s3d.uy = uy_avg;
                    s3d.uz = uz_avg;
                    s3d.p = p_avg;
                    s3d.E = MultiMat::getMixtureEnergy(p_avg, rho_avg, a1_avg, a2_avg, ar1_avg, ar2_avg, gamma, mat.products, mat.unreacted) + ke_avg;
                    s3d.alpha1 = a1_avg;
                    s3d.alpha2 = a2_avg;
                    s3d.arho1 = ar1_avg;
                    s3d.arho2 = ar2_avg;
                    solver_3d.setCellStateMulti(i, j, k, s3d);
                }
            }
        }
    }
    solver_3d.commitStates();
}


