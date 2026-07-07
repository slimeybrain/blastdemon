#include "cfd_solver_3d.hpp"
#include <cmath>
#include <algorithm>
#include <iostream>
#include <omp.h>

template <bool IsMultiMaterial>
CFDSolver3DImpl<IsMultiMaterial>::CFDSolver3DImpl(int nx, int ny, int nz, double cellSize, double xmin, double ymin, double zmin)
    : CFDSolver3DImplBase(nx, ny, nz, cellSize, xmin, ymin, zmin) {

    n_tiles_x = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    n_tiles_y = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    n_tiles_z = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;

    int total_tiles = n_tiles_x * n_tiles_y * n_tiles_z;
    states_pool.resize(total_tiles);
    U_pool.resize(total_tiles);
    active_tiles.assign(total_tiles, false);
}

template <bool IsMultiMaterial>
void CFDSolver3DImpl<IsMultiMaterial>::setDetonatorLocation(double x, double y, double z) {
    detX = x; detY = y; detZ = z;
}

template <bool IsMultiMaterial>
void CFDSolver3DImpl<IsMultiMaterial>::setInitialCondition(const Charge3DParams& charge, const MultiMat::MaterialSet& materials, double amb_rho, double amb_p) {
    ambient_rho = amb_rho;
    ambient_p = amb_p;
    currentMaterials = materials;

    #pragma omp parallel for
    for (int t = 0; t < (int)states_pool.size(); ++t) {
        auto& tile = states_pool[t];
        for (int i = 0; i < TILE_CELLS_3D; ++i) {
            tile.rho[i] = ambient_rho;
            tile.ux[i] = 0.0;
            tile.uy[i] = 0.0;
            tile.uz[i] = 0.0;
            tile.p[i] = ambient_p;
            tile.E[i] = ambient_p / (gamma - 1.0);
            tile.arrival_time[i] = -1.0;
            if constexpr (IsMultiMaterial) {
                tile.alpha1[i] = 0.0;
                tile.alpha2[i] = 0.0;
                tile.arho1[i] = 0.0;
                tile.arho2[i] = 0.0;
            }
            tile.floor_status[i] = 0;
        }
    }

    #pragma omp parallel for collapse(3)
    for (int tz = 0; tz < n_tiles_z; ++tz) {
        for (int ty = 0; ty < n_tiles_y; ++ty) {
            for (int tx = 0; tx < n_tiles_x; ++tx) {
                int t_idx = tx + ty * n_tiles_x + tz * n_tiles_x * n_tiles_y;
                auto& tile = states_pool[t_idx];
                bool tile_has_charge = false;

                for (int k = 0; k < TILE_SIZE_3D; ++k) {
                    int gz = tz * TILE_SIZE_3D + k;
                    if (gz >= nz) continue;
                    double z_c = zmin + (gz + 0.5) * cellSize;
                    for (int j = 0; j < TILE_SIZE_3D; ++j) {
                        int gy = ty * TILE_SIZE_3D + j;
                        if (gy >= ny) continue;
                        double y_c = ymin + (gy + 0.5) * cellSize;
                        for (int i = 0; i < TILE_SIZE_3D; ++i) {
                            int gx = tx * TILE_SIZE_3D + i;
                            if (gx >= nx) continue;
                            double x_c = xmin + (gx + 0.5) * cellSize;

                            int c_idx = i + j * TILE_SIZE_3D + k * TILE_SIZE_3D * TILE_SIZE_3D;
                            double dist_sq = (x_c - charge.x)*(x_c - charge.x) + (y_c - charge.y)*(y_c - charge.y) + (z_c - charge.z)*(z_c - charge.z);
                            bool in_charge = false;

                            if (charge.shape == "Sphere") {
                                if (dist_sq <= charge.radius * charge.radius) in_charge = true;
                            } else if (charge.shape == "Block") {
                                if (std::abs(x_c - charge.x) <= charge.lx*0.5 &&
                                    std::abs(y_c - charge.y) <= charge.ly*0.5 &&
                                    std::abs(z_c - charge.z) <= charge.lz*0.5) in_charge = true;
                            } else if (charge.shape == "Cylinder") {
                                double dr_sq = (x_c - charge.x)*(x_c - charge.x) + (y_c - charge.y)*(y_c - charge.y);
                                if (dr_sq <= charge.radius*charge.radius && std::abs(z_c - charge.z) <= charge.height*0.5) in_charge = true;
                            }

                            if (in_charge) {
                                tile_has_charge = true;
                                if constexpr (IsMultiMaterial) {
                                    tile.alpha1[c_idx] = 0.0;
                                    tile.alpha2[c_idx] = 1.0;
                                    tile.arho1[c_idx] = 0.0;
                                    tile.arho2[c_idx] = materials.unreacted.rho0;
                                    tile.rho[c_idx] = tile.arho2[c_idx];
                                    tile.p[c_idx] = ambient_p;
                                } else {
                                    tile.rho[c_idx] = ambient_rho * 10.0;
                                    tile.p[c_idx] = ambient_p * 1000.0;
                                }
                                tile.E[c_idx] = tile.p[c_idx] / (gamma - 1.0);
                                double dist = std::sqrt(dist_sq);
                                tile.arrival_time[c_idx] = dist / materials.det_vel;
                            }
                        }
                    }
                }
                if (tile_has_charge) active_tiles[t_idx] = true;
            }
        }
    }
    updateActiveRegions();
}

template <bool IsMultiMaterial>
void CFDSolver3DImpl<IsMultiMaterial>::updateActiveRegions() {
    std::vector<bool> next_active = active_tiles;
    for (int tz = 0; tz < n_tiles_z; ++tz) {
        for (int ty = 0; ty < n_tiles_y; ++ty) {
            for (int tx = 0; tx < n_tiles_x; ++tx) {
                int idx = tx + ty * n_tiles_x + tz * n_tiles_x * n_tiles_y;
                if (active_tiles[idx]) {
                    if (tx > 0) next_active[idx - 1] = true;
                    if (tx < n_tiles_x - 1) next_active[idx + 1] = true;
                    if (ty > 0) next_active[idx - n_tiles_x] = true;
                    if (ty < n_tiles_y - 1) next_active[idx + n_tiles_x] = true;
                    if (tz > 0) next_active[idx - n_tiles_x * n_tiles_y] = true;
                    if (tz < n_tiles_z - 1) next_active[idx + n_tiles_x * n_tiles_y] = true;
                }
            }
        }
    }
    active_tiles = next_active;
}

template <bool IsMultiMaterial>
struct Flux3D {
    double rho, rhoux, rhouy, rhouz, E, alpha1, alpha2, arho1, arho2;
};

template <bool IsMultiMaterial>
Flux3D<IsMultiMaterial> getRusanovFlux3D(const CellState3D<IsMultiMaterial>& sL, const CellState3D<IsMultiMaterial>& sR, int dir, double gamma) {
    auto physFlux = [](const CellState3D<IsMultiMaterial>& s, int dir) {
        Flux3D<IsMultiMaterial> f;
        double u_n = (dir == 0) ? s.ux : (dir == 1 ? s.uy : s.uz);
        f.rho = s.rho * u_n;
        f.rhoux = s.rho * u_n * s.ux + (dir == 0 ? s.p : 0);
        f.rhouy = s.rho * u_n * s.uy + (dir == 1 ? s.p : 0);
        f.rhouz = s.rho * u_n * s.uz + (dir == 2 ? s.p : 0);
        f.E = u_n * (s.E + s.p);
        if constexpr (IsMultiMaterial) {
            f.alpha1 = s.alpha1 * u_n; f.alpha2 = s.alpha2 * u_n;
            f.arho1 = s.arho1 * u_n; f.arho2 = s.arho2 * u_n;
        }
        return f;
    };

    Flux3D<IsMultiMaterial> fL = physFlux(sL, dir);
    Flux3D<IsMultiMaterial> fR = physFlux(sR, dir);

    double cL = std::sqrt(gamma * sL.p / std::max(1e-6, sL.rho));
    double cR = std::sqrt(gamma * sR.p / std::max(1e-6, sR.rho));
    double uL = (dir == 0) ? sL.ux : (dir == 1 ? sL.uy : sL.uz);
    double uR = (dir == 0) ? sR.ux : (dir == 1 ? sR.uy : sR.uz);
    double s_max = std::max(std::abs(uL) + cL, std::abs(uR) + cR);

    Flux3D<IsMultiMaterial> f;
    f.rho = 0.5 * (fL.rho + fR.rho) - 0.5 * s_max * (sR.rho - sL.rho);
    f.rhoux = 0.5 * (fL.rhoux + fR.rhoux) - 0.5 * s_max * (sR.rho * sR.ux - sL.rho * sL.ux);
    f.rhouy = 0.5 * (fL.rhouy + fR.rhouy) - 0.5 * s_max * (sR.rho * sR.uy - sL.rho * sL.uy);
    f.rhouz = 0.5 * (fL.rhouz + fR.rhouz) - 0.5 * s_max * (sR.rho * sR.uz - sL.rho * sL.uz);
    f.E = 0.5 * (fL.E + fR.E) - 0.5 * s_max * (sR.E - sL.E);
    if constexpr (IsMultiMaterial) {
        f.alpha1 = 0.5 * (fL.alpha1 + fR.alpha1) - 0.5 * s_max * (sR.alpha1 - sL.alpha1);
        f.alpha2 = 0.5 * (fL.alpha2 + fR.alpha2) - 0.5 * s_max * (sR.alpha2 - sL.alpha2);
        f.arho1 = 0.5 * (fL.arho1 + fR.arho1) - 0.5 * s_max * (sR.arho1 - sL.arho1);
        f.arho2 = 0.5 * (fL.arho2 + fR.arho2) - 0.5 * s_max * (sR.arho2 - sL.arho2);
    }
    return f;
}

template <bool IsMultiMaterial>
Flux3D<IsMultiMaterial> getAUSMPlusFlux3D(const CellState3D<IsMultiMaterial>& sL, const CellState3D<IsMultiMaterial>& sR, int dir, double gamma) {
    double aL = std::sqrt(gamma * sL.p / std::max(1e-6, sL.rho));
    double aR = std::sqrt(gamma * sR.p / std::max(1e-6, sR.rho));
    double a_half = 0.5 * (aL + aR);

    double uL = (dir == 0) ? sL.ux : (dir == 1 ? sL.uy : sL.uz);
    double uR = (dir == 0) ? sR.ux : (dir == 1 ? sR.uy : sR.uz);
    double ML = uL / a_half;
    double MR = uR / a_half;

    double alpha = 3.0 / 16.0;
    double beta = 1.0 / 8.0;

    auto get_M_plus = [beta](double M) {
        if (std::abs(M) <= 1.0) return 0.25 * (M + 1.0) * (M + 1.0) + beta * (M * M - 1.0) * (M * M - 1.0);
        return 0.5 * (M + std::abs(M));
    };
    auto get_M_minus = [beta](double M) {
        if (std::abs(M) <= 1.0) return -0.25 * (M - 1.0) * (M - 1.0) - beta * (M * M - 1.0) * (M * M - 1.0);
        return 0.5 * (M - std::abs(M));
    };
    auto get_P_plus = [alpha](double M) {
        if (std::abs(M) <= 1.0) return 0.25 * (M + 1.0) * (M + 1.0) * (2.0 - M) + alpha * M * (M * M - 1.0) * (M * M - 1.0);
        return (M >= 0.0) ? 1.0 : 0.0;
    };
    auto get_P_minus = [alpha](double M) {
        if (std::abs(M) <= 1.0) return 0.25 * (M - 1.0) * (M - 1.0) * (2.0 + M) - alpha * M * (M * M - 1.0) * (M * M - 1.0);
        return (M < 0.0) ? 1.0 : 0.0;
    };

    double M_half = get_M_plus(ML) + get_M_minus(MR);
    double p_half = get_P_plus(ML) * sL.p + get_P_minus(MR) * sR.p;
    double mass_flux = M_half * a_half;

    Flux3D<IsMultiMaterial> F;
    const auto& s = (mass_flux >= 0) ? sL : sR;

    F.rho = mass_flux * s.rho;
    F.rhoux = mass_flux * s.rho * s.ux + (dir == 0 ? p_half : 0);
    F.rhouy = mass_flux * s.rho * s.uy + (dir == 1 ? p_half : 0);
    F.rhouz = mass_flux * s.rho * s.uz + (dir == 2 ? p_half : 0);
    F.E = mass_flux * (s.E + s.p);
    if constexpr (IsMultiMaterial) {
        F.alpha1 = mass_flux * s.alpha1; F.alpha2 = mass_flux * s.alpha2;
        F.arho1 = mass_flux * s.arho1; F.arho2 = mass_flux * s.arho2;
    }

    // Entropy fix for expansion shocks (parity with 1D)
    double lambda_minus_L = uL - aL;
    double lambda_minus_R = uR - aR;
    if (lambda_minus_L < 0.0 && lambda_minus_R > 0.0) {
        double dlambda = lambda_minus_R - lambda_minus_L;
        double diss = dlambda / 4.0;
        F.rho -= diss * (sR.rho - sL.rho);
        F.rhoux -= diss * (sR.rho * sR.ux - sL.rho * sL.ux);
        F.rhouy -= diss * (sR.rho * sR.uy - sL.rho * sL.uy);
        F.rhouz -= diss * (sR.rho * sR.uz - sL.rho * sL.uz);
        F.E -= diss * (sR.E - sL.E);
        if constexpr (IsMultiMaterial) {
            F.arho1 -= diss * (sR.arho1 - sL.arho1);
            F.arho2 -= diss * (sR.arho2 - sL.arho2);
        }
    }
    double lambda_plus_L = uL + aL;
    double lambda_plus_R = uR + aR;
    if (lambda_plus_L < 0.0 && lambda_plus_R > 0.0) {
        double dlambda = lambda_plus_R - lambda_plus_L;
        double diss = dlambda / 4.0;
        F.rho -= diss * (sR.rho - sL.rho);
        F.rhoux -= diss * (sR.rho * sR.ux - sL.rho * sL.ux);
        F.rhouy -= diss * (sR.rho * sR.uy - sL.rho * sL.uy);
        F.rhouz -= diss * (sR.rho * sR.uz - sL.rho * sL.uz);
        F.E -= diss * (sR.E - sL.E);
        if constexpr (IsMultiMaterial) {
            F.arho1 -= diss * (sR.arho1 - sL.arho1);
            F.arho2 -= diss * (sR.arho2 - sL.arho2);
        }
    }

    return F;
}

static inline double minmod(double a, double b) {
    if (a * b <= 0) return 0.0;
    return (std::abs(a) < std::abs(b)) ? a : b;
}

template <bool IsMultiMaterial>
CellState3D<IsMultiMaterial> reconstruct(const CellState3D<IsMultiMaterial>& sL, const CellState3D<IsMultiMaterial>& sC, const CellState3D<IsMultiMaterial>& sR, double side, double gamma) {
    CellState3D<IsMultiMaterial> res;
    auto slope = [&](double L, double C, double R) { return minmod(C - L, R - C); };

    res.rho = sC.rho + side * slope(sL.rho, sC.rho, sR.rho);
    res.ux = sC.ux + side * slope(sL.ux, sC.ux, sR.ux);
    res.uy = sC.uy + side * slope(sL.uy, sC.uy, sR.uy);
    res.uz = sC.uz + side * slope(sL.uz, sC.uz, sR.uz);
    res.p = sC.p + side * slope(sL.p, sC.p, sR.p);

    double ke = 0.5 * res.rho * (res.ux*res.ux + res.uy*res.uy + res.uz*res.uz);
    res.E = res.p / (gamma - 1.0) + ke;

    if constexpr (IsMultiMaterial) {
        res.alpha1 = sC.alpha1 + side * slope(sL.alpha1, sC.alpha1, sR.alpha1);
        res.alpha2 = sC.alpha2 + side * slope(sL.alpha2, sC.alpha2, sR.alpha2);
        res.arho1 = sC.arho1 + side * slope(sL.arho1, sC.arho1, sR.arho1);
        res.arho2 = sC.arho2 + side * slope(sL.arho2, sC.arho2, sR.arho2);
    }
    return res;
}

template <bool IsMultiMaterial>
void CFDSolver3DImpl<IsMultiMaterial>::computeFluxes(double dt) {
    double invDx = 1.0 / cellSize;
    bool useAUSM = (currentFluxScheme == "AUSM+");

    #pragma omp parallel for collapse(3)
    for (int tz = 0; tz < n_tiles_z; ++tz) {
        for (int ty = 0; ty < n_tiles_y; ++ty) {
            for (int tx = 0; tx < n_tiles_x; ++tx) {
                int t_idx = tx + ty * n_tiles_x + tz * n_tiles_x * n_tiles_y;
                if (!active_tiles[t_idx]) continue;

                auto& u = U_pool[t_idx];

                for (int k = 0; k < TILE_SIZE_3D; ++k) {
                    int gz = tz * TILE_SIZE_3D + k;
                    for (int j = 0; j < TILE_SIZE_3D; ++j) {
                        int gy = ty * TILE_SIZE_3D + j;
                        for (int i = 0; i < TILE_SIZE_3D; ++i) {
                            int gx = tx * TILE_SIZE_3D + i;
                            int idx = i + j * TILE_SIZE_3D + k * TILE_SIZE_3D * TILE_SIZE_3D;

                            auto get_f = [&](const CellState3D<IsMultiMaterial>& L, const CellState3D<IsMultiMaterial>& R, int d) {
                                return useAUSM ? getAUSMPlusFlux3D(L, R, d, gamma) : getRusanovFlux3D(L, R, d, gamma);
                            };

                            // X-Fluxes
                            auto sL2 = sampleState(gx-2, gy, gz);
                            auto sL1 = sampleState(gx-1, gy, gz);
                            auto sC  = sampleState(gx,   gy, gz);
                            auto sR1 = sampleState(gx+1, gy, gz);
                            auto sR2 = sampleState(gx+2, gy, gz);

                            auto fxL = get_f(reconstruct(sL2, sL1, sC, 0.5, gamma), reconstruct(sL1, sC, sR1, -0.5, gamma), 0);
                            auto fxR = get_f(reconstruct(sL1, sC, sR1, 0.5, gamma), reconstruct(sC, sR1, sR2, -0.5, gamma), 0);

                            // Y-Fluxes
                            auto sB2 = sampleState(gx, gy-2, gz);
                            auto sB1 = sampleState(gx, gy-1, gz);
                            auto sT1 = sampleState(gx, gy+1, gz);
                            auto sT2 = sampleState(gx, gy+2, gz);

                            auto fyB = get_f(reconstruct(sB2, sB1, sC, 0.5, gamma), reconstruct(sB1, sC, sT1, -0.5, gamma), 1);
                            auto fyT = get_f(reconstruct(sB1, sC, sT1, 0.5, gamma), reconstruct(sC, sT1, sT2, -0.5, gamma), 1);

                            // Z-Fluxes
                            auto sD2 = sampleState(gx, gy, gz-2);
                            auto sD1 = sampleState(gx, gy, gz-1);
                            auto sU1 = sampleState(gx, gy, gz+1);
                            auto sU2 = sampleState(gx, gy, gz+2);

                            auto fzD = get_f(reconstruct(sD2, sD1, sC, 0.5, gamma), reconstruct(sD1, sC, sU1, -0.5, gamma), 2);
                            auto fzU = get_f(reconstruct(sD1, sC, sU1, 0.5, gamma), reconstruct(sC, sU1, sU2, -0.5, gamma), 2);

                            u.rho[idx] -= dt * invDx * (fxR.rho - fxL.rho + fyT.rho - fyB.rho + fzU.rho - fzD.rho);
                            u.rhoux[idx] -= dt * invDx * (fxR.rhoux - fxL.rhoux + fyT.rhoux - fyB.rhoux + fzU.rhoux - fzD.rhoux);
                            u.rhouy[idx] -= dt * invDx * (fxR.rhouy - fxL.rhouy + fyT.rhouy - fyB.rhouy + fzU.rhouy - fzD.rhouy);
                            u.rhouz[idx] -= dt * invDx * (fxR.rhouz - fxL.rhouz + fyT.rhouz - fyB.rhouz + fzU.rhouz - fzD.rhouz);
                            u.E[idx] -= dt * invDx * (fxR.E - fxL.E + fyT.E - fyB.E + fzU.E - fzD.E);
                            if constexpr (IsMultiMaterial) {
                                u.alpha1[idx] -= dt * invDx * (fxR.alpha1 - fxL.alpha1 + fyT.alpha1 - fyB.alpha1 + fzU.alpha1 - fzD.alpha1);
                                u.alpha2[idx] -= dt * invDx * (fxR.alpha2 - fxL.alpha2 + fyT.alpha2 - fyB.alpha2 + fzU.alpha2 - fzD.alpha2);
                                u.arho1[idx] -= dt * invDx * (fxR.arho1 - fxL.arho1 + fyT.arho1 - fyB.arho1 + fzU.arho1 - fzD.arho1);
                                u.arho2[idx] -= dt * invDx * (fxR.arho2 - fxL.arho2 + fyT.arho2 - fyB.arho2 + fzU.arho2 - fzD.arho2);
                            }
                        }
                    }
                }
            }
        }
    }
}

template <bool IsMultiMaterial>
void CFDSolver3DImpl<IsMultiMaterial>::step(double dt) {
    #pragma omp parallel for
    for (int t = 0; t < (int)states_pool.size(); ++t) {
        if (!active_tiles[t]) continue;
        auto& s = states_pool[t];
        auto& u = U_pool[t];
        for (int i = 0; i < TILE_CELLS_3D; ++i) {
            u.rho[i] = s.rho[i];
            u.rhoux[i] = s.rho[i] * s.ux[i];
            u.rhouy[i] = s.rho[i] * s.uy[i];
            u.rhouz[i] = s.rho[i] * s.uz[i];
            u.E[i] = s.E[i];
            if constexpr (IsMultiMaterial) {
                u.alpha1[i] = s.alpha1[i]; u.alpha2[i] = s.alpha2[i];
                u.arho1[i] = s.arho1[i]; u.arho2[i] = s.arho2[i];
            }
        }
    }

    computeFluxes(dt);

    #pragma omp parallel for
    for (int t = 0; t < (int)states_pool.size(); ++t) {
        if (!active_tiles[t]) continue;
        auto& s = states_pool[t];
        auto& u = U_pool[t];
        for (int i = 0; i < TILE_CELLS_3D; ++i) {
            s.rho[i] = std::max(u.rho[i], 1e-6);
            s.ux[i] = u.rhoux[i] / s.rho[i];
            s.uy[i] = u.rhouy[i] / s.rho[i];
            s.uz[i] = u.rhouz[i] / s.rho[i];
            s.E[i] = u.E[i];
            double ke = 0.5 * s.rho[i] * (s.ux[i]*s.ux[i] + s.uy[i]*s.uy[i] + s.uz[i]*s.uz[i]);
            s.p[i] = std::max((s.E[i] - ke) * (gamma - 1.0), 1e-6);
            if constexpr (IsMultiMaterial) {
                s.alpha1[i] = std::clamp(u.alpha1[i], 0.0, 1.0);
                s.alpha2[i] = std::clamp(u.alpha2[i], 0.0, 1.0);
                s.arho1[i] = std::clamp(u.arho1[i], 0.0, s.rho[i]);
                s.arho2[i] = std::clamp(u.arho2[i], 0.0, s.rho[i]);
            }
        }
    }

    applyBC();
    currentTime += dt;
    updateActiveRegions();
}

template <bool IsMultiMaterial>
void CFDSolver3DImpl<IsMultiMaterial>::applyBC() {}

template <bool IsMultiMaterial>
double CFDSolver3DImpl<IsMultiMaterial>::computeStepSize(double cfl) const {
    double max_s = 1e-6;
    #pragma omp parallel for reduction(max:max_s)
    for (int t = 0; t < (int)states_pool.size(); ++t) {
        if (!active_tiles[t]) continue;
        const auto& tile = states_pool[t];
        for (int i = 0; i < TILE_CELLS_3D; ++i) {
            double u_mag = std::sqrt(tile.ux[i]*tile.ux[i] + tile.uy[i]*tile.uy[i] + tile.uz[i]*tile.uz[i]);
            double c = std::sqrt(gamma * tile.p[i] / std::max(1e-6, tile.rho[i]));
            max_s = std::max(max_s, u_mag + c);
        }
    }
    return cfl * cellSize / max_s;
}

template <bool IsMultiMaterial>
CellState3D<IsMultiMaterial> CFDSolver3DImpl<IsMultiMaterial>::sampleState(int gx, int gy, int gz) const {
    bool reflective_x = false, reflective_y = false, reflective_z = false;

    if (gx < 0) {
        if (bcXmin == BCType3D::REFLECTIVE) { gx = -gx - 1; reflective_x = true; }
        else gx = 0;
    } else if (gx >= nx) {
        if (bcXmax == BCType3D::REFLECTIVE) { gx = 2 * nx - 1 - gx; reflective_x = true; }
        else gx = nx - 1;
    }
    if (gy < 0) {
        if (bcYmin == BCType3D::REFLECTIVE) { gy = -gy - 1; reflective_y = true; }
        else gy = 0;
    } else if (gy >= ny) {
        if (bcYmax == BCType3D::REFLECTIVE) { gy = 2 * ny - 1 - gy; reflective_y = true; }
        else gy = ny - 1;
    }
    if (gz < 0) {
        if (bcZmin == BCType3D::REFLECTIVE) { gz = -gz - 1; reflective_z = true; }
        else gz = 0;
    } else if (gz >= nz) {
        if (bcZmax == BCType3D::REFLECTIVE) { gz = 2 * nz - 1 - gz; reflective_z = true; }
        else gz = nz - 1;
    }

    gx = std::clamp(gx, 0, nx - 1);
    gy = std::clamp(gy, 0, ny - 1);
    gz = std::clamp(gz, 0, nz - 1);

    int t_idx = (gx / TILE_SIZE_3D) + (gy / TILE_SIZE_3D) * n_tiles_x + (gz / TILE_SIZE_3D) * n_tiles_x * n_tiles_y;
    const auto& tile = states_pool[t_idx];
    int c_idx = (gx % TILE_SIZE_3D) + (gy % TILE_SIZE_3D) * TILE_SIZE_3D + (gz % TILE_SIZE_3D) * TILE_SIZE_3D * TILE_SIZE_3D;

    CellState3D<IsMultiMaterial> s;
    s.p = tile.p[c_idx]; s.rho = tile.rho[c_idx]; s.E = tile.E[c_idx];
    s.ux = reflective_x ? -tile.ux[c_idx] : tile.ux[c_idx];
    s.uy = reflective_y ? -tile.uy[c_idx] : tile.uy[c_idx];
    s.uz = reflective_z ? -tile.uz[c_idx] : tile.uz[c_idx];

    if constexpr (IsMultiMaterial) {
        s.alpha1 = tile.alpha1[c_idx]; s.alpha2 = tile.alpha2[c_idx];
        s.arho1 = tile.arho1[c_idx]; s.arho2 = tile.arho2[c_idx];
    }
    return s;
}

template <bool IsMultiMaterial>
std::vector<float> CFDSolver3DImpl<IsMultiMaterial>::sampleGauge(const Gauge3D& gauge) const {
    int gx = std::clamp((int)((gauge.x - xmin) / cellSize), 0, nx - 1);
    int gy = std::clamp((int)((gauge.y - ymin) / cellSize), 0, ny - 1);
    int gz = std::clamp((int)((gauge.z - zmin) / cellSize), 0, nz - 1);
    auto s = sampleState(gx, gy, gz);
    std::vector<float> vals(7, 0.0f);
    vals[0] = (float)s.p; vals[1] = (float)s.rho;
    vals[2] = (float)std::sqrt(s.ux*s.ux + s.uy*s.uy + s.uz*s.uz);
    vals[3] = (float)(s.E / std::max(s.rho, 1e-6));
    if constexpr (IsMultiMaterial) { vals[4] = (float)s.alpha1; vals[5] = (float)s.alpha2; vals[6] = (float)(1.0 - s.alpha1 - s.alpha2); }
    else { vals[6] = 1.0f; }
    return vals;
}

template <bool IsMultiMaterial>
std::vector<float> CFDSolver3DImpl<IsMultiMaterial>::extractSlice(const Slice3D& slice) const {
    std::vector<float> data;
    if (slice.axis == "xy") {
        int gz = std::clamp((int)((slice.offset - zmin) / cellSize), 0, nz - 1);
        data.resize(nx * ny);
        for (int gy = 0; gy < ny; ++gy) for (int gx = 0; gx < nx; ++gx) data[gx + gy * nx] = (float)sampleState(gx, gy, gz).p;
    } else if (slice.axis == "xz") {
        int gy = std::clamp((int)((slice.offset - ymin) / cellSize), 0, ny - 1);
        data.resize(nx * nz);
        for (int gz = 0; gz < nz; ++gz) for (int gx = 0; gx < nx; ++gx) data[gx + gz * nx] = (float)sampleState(gx, gy, gz).p;
    } else if (slice.axis == "yz") {
        int gx = std::clamp((int)((slice.offset - xmin) / cellSize), 0, nx - 1);
        data.resize(ny * nz);
        for (int gz = 0; gz < nz; ++gz) for (int gy = 0; gy < ny; ++gy) data[gy + gz * ny] = (float)sampleState(gx, gy, gz).p;
    }
    return data;
}

extern void remap_1d_to_3d(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d,
                    CFDSolver3D& solver_3d, double x_expl, double y_expl, double z_expl, double R_remap);

template <bool IsMultiMaterial>
void CFDSolver3DImpl<IsMultiMaterial>::initializeFrom1D(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d, double x_expl, double y_expl, double z_expl, double R_remap) {
    remap_1d_to_3d(r_1d, states_1d, *this, x_expl, y_expl, z_expl, R_remap);
    updateActiveRegions();
}

template <bool IsMultiMaterial>
void CFDSolver3DImpl<IsMultiMaterial>::setCellStateMulti(int gx, int gy, int gz, const CellState3D<true>& s) {
    if constexpr (IsMultiMaterial) {
        int t_idx = (gx / TILE_SIZE_3D) + (gy / TILE_SIZE_3D) * n_tiles_x + (gz / TILE_SIZE_3D) * n_tiles_x * n_tiles_y;
        int c_idx = (gx % TILE_SIZE_3D) + (gy % TILE_SIZE_3D) * TILE_SIZE_3D + (gz % TILE_SIZE_3D) * TILE_SIZE_3D * TILE_SIZE_3D;
        auto& tile = states_pool[t_idx];
        tile.rho[c_idx] = s.rho; tile.ux[c_idx] = s.ux; tile.uy[c_idx] = s.uy; tile.uz[c_idx] = s.uz;
        tile.p[c_idx] = s.p; tile.E[c_idx] = s.E;
        tile.alpha1[c_idx] = s.alpha1; tile.alpha2[c_idx] = s.alpha2;
        tile.arho1[c_idx] = s.arho1; tile.arho2[c_idx] = s.arho2;
        active_tiles[t_idx] = true;
    }
}

template <bool IsMultiMaterial>
void CFDSolver3DImpl<IsMultiMaterial>::setCellStateIdeal(int gx, int gy, int gz, const CellState3D<false>& s) {
    int t_idx = (gx / TILE_SIZE_3D) + (gy / TILE_SIZE_3D) * n_tiles_x + (gz / TILE_SIZE_3D) * n_tiles_x * n_tiles_y;
    int c_idx = (gx % TILE_SIZE_3D) + (gy % TILE_SIZE_3D) * TILE_SIZE_3D + (gz % TILE_SIZE_3D) * TILE_SIZE_3D * TILE_SIZE_3D;
    auto& tile = states_pool[t_idx];
    tile.rho[c_idx] = s.rho; tile.ux[c_idx] = s.ux; tile.uy[c_idx] = s.uy; tile.uz[c_idx] = s.uz;
    tile.p[c_idx] = s.p; tile.E[c_idx] = s.E;
    active_tiles[t_idx] = true;
}

template <bool IsMultiMaterial>
void CFDSolver3DImpl<IsMultiMaterial>::commitStates() {
    updateActiveRegions();
}

template <bool IsMultiMaterial> void CFDSolver3DImpl<IsMultiMaterial>::setFluxScheme(const std::string& name) { currentFluxScheme = name; }
template <bool IsMultiMaterial> void CFDSolver3DImpl<IsMultiMaterial>::setSpatialOrder(int order) { spatialOrder = order; }
template <bool IsMultiMaterial> void CFDSolver3DImpl<IsMultiMaterial>::setTemporalOrder(int order) { temporalOrder = order; }
template <bool IsMultiMaterial> bool CFDSolver3DImpl<IsMultiMaterial>::checkTermination() { return false; }

template class CFDSolver3DImpl<false>;
template class CFDSolver3DImpl<true>;
