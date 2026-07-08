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
