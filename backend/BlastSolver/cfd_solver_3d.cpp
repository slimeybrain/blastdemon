#include "cfd_solver_3d.hpp"
#include <cmath>
#include <algorithm>
#include <iostream>
#include <omp.h>

template <typename RealType, bool IsMultiMaterial>
CFDSolver3DImpl<RealType, IsMultiMaterial>::CFDSolver3DImpl(int nx, int ny, int nz, double cellSize, double xmin, double ymin, double zmin)
    : CFDSolver3DImplBase(nx, ny, nz, cellSize, xmin, ymin, zmin) {

    n_tiles_x = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    n_tiles_y = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    n_tiles_z = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;

    int total_tiles = n_tiles_x * n_tiles_y * n_tiles_z;
    states_pool.resize(total_tiles);
    U_pool.resize(total_tiles);
    U_prev_pool.resize(total_tiles);
    active_tiles.assign(total_tiles, 0);
    is_ideal_gas_val = !IsMultiMaterial;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::setDetonatorLocation(double x, double y, double z) {
    detX = x; detY = y; detZ = z;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::setInitialCondition(const Charge3DParams& charge, const MultiMat::MaterialSet& materials, double amb_rho, double amb_p) {
    ambient_rho = amb_rho;
    ambient_p = amb_p;
    currentMaterials = materials;

    #pragma omp parallel for
    for (int t = 0; t < (int)states_pool.size(); ++t) {
        auto& tile = states_pool[t];
        auto& u_tile = U_pool[t];
        for (int i = 0; i < TILE_CELLS_3D; ++i) {
            tile.rho[i] = (RealType)ambient_rho;
            tile.ux[i] = 0.0;
            tile.uy[i] = 0.0;
            tile.uz[i] = 0.0;
            tile.p[i] = (RealType)ambient_p;
            CellState3D<IsMultiMaterial> temp_s;
            if constexpr (IsMultiMaterial) {
                temp_s.alpha1 = 0.0; temp_s.alpha2 = 0.0;
                temp_s.arho1 = 0.0; temp_s.arho2 = 0.0;
            }
            tile.E[i] = (RealType)getEnergy3D<IsMultiMaterial>(ambient_p, ambient_rho, temp_s, gamma, materials.products, materials.unreacted);
            tile.arrival_time[i] = (RealType)-1.0;
            if constexpr (IsMultiMaterial) {
                tile.alpha1[i] = 0.0;
                tile.alpha2[i] = 0.0;
                tile.arho1[i] = 0.0;
                tile.arho2[i] = 0.0;
            }
            tile.floor_status[i] = 0;

            u_tile.rho[i] = (RealType)ambient_rho;
            u_tile.rhoux[i] = 0.0;
            u_tile.rhouy[i] = 0.0;
            u_tile.rhouz[i] = 0.0;
            u_tile.E[i] = tile.E[i];
            if constexpr (IsMultiMaterial) {
                u_tile.alpha1[i] = 0.0;
                u_tile.alpha2[i] = 0.0;
                u_tile.arho1[i] = 0.0;
                u_tile.arho2[i] = 0.0;
            }
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
                            
                            int points_inside = 0;
                            for (double ox : {-0.25, 0.25}) {
                                for (double oy : {-0.25, 0.25}) {
                                    for (double oz : {-0.25, 0.25}) {
                                        double px = x_c + ox * cellSize;
                                        double py = y_c + oy * cellSize;
                                        double pz = z_c + oz * cellSize;
                                        double dx = px - charge.x;
                                        double dy = py - charge.y;
                                        double dz = pz - charge.z;
                                        double dist_sq = dx*dx + dy*dy + dz*dz;
                                        bool inside = false;
                                        if (charge.shape_type == 0) { // Sphere
                                            if (dist_sq <= charge.radius * charge.radius) inside = true;
                                        } else if (charge.shape_type == 1) { // Block
                                            if (std::abs(dx) <= charge.lx*0.5 && std::abs(dy) <= charge.ly*0.5 && std::abs(dz) <= charge.lz*0.5) inside = true;
                                        } else if (charge.shape_type == 2) { // Cylinder
                                            double dr_sq = dx*dx + dy*dy;
                                            if (dr_sq <= charge.radius*charge.radius && std::abs(dz) <= charge.height*0.5) inside = true;
                                        }
                                        if (inside) points_inside++;
                                    }
                                }
                            }
                            double f_vol = points_inside / 8.0;

                            if (f_vol > 0.0) {
                                tile_has_charge = true;
                                CellState3D<IsMultiMaterial> temp_s;
                                if constexpr (IsMultiMaterial) {
                                    tile.alpha1[c_idx] = (RealType)(1.0 - f_vol);
                                    tile.alpha2[c_idx] = (RealType)f_vol;
                                    tile.arho1[c_idx] = tile.alpha1[c_idx] * (RealType)ambient_rho;
                                    tile.arho2[c_idx] = tile.alpha2[c_idx] * (RealType)materials.unreacted.rho0;
                                    tile.rho[c_idx] = tile.arho1[c_idx] + tile.arho2[c_idx];
                                    tile.p[c_idx] = (RealType)ambient_p;
                                    temp_s.alpha1 = (double)tile.alpha1[c_idx]; temp_s.alpha2 = (double)tile.alpha2[c_idx];
                                    temp_s.arho1 = (double)tile.arho1[c_idx]; temp_s.arho2 = (double)tile.arho2[c_idx];
                                } else {
                                    tile.rho[c_idx] = (RealType)(f_vol * materials.unreacted.rho0 + (1.0 - f_vol) * ambient_rho);
                                    double p_high = (gamma - 1.0) * materials.unreacted.rho0 * materials.detonation_energy;
                                    tile.p[c_idx] = (RealType)(f_vol * p_high + (1.0 - f_vol) * ambient_p);
                                }
                                tile.E[c_idx] = (RealType)getEnergy3D<IsMultiMaterial>((double)tile.p[c_idx], (double)tile.rho[c_idx], temp_s, gamma, materials.products, materials.unreacted);
                                double dist = std::sqrt((x_c - charge.x)*(x_c - charge.x) + (y_c - charge.y)*(y_c - charge.y) + (z_c - charge.z)*(z_c - charge.z));
                                tile.arrival_time[c_idx] = (RealType)(dist / materials.det_vel);

                                auto& u_tile = U_pool[t_idx];
                                u_tile.rho[c_idx] = tile.rho[c_idx];
                                u_tile.rhoux[c_idx] = 0.0;
                                u_tile.rhouy[c_idx] = 0.0;
                                u_tile.rhouz[c_idx] = 0.0;
                                u_tile.E[c_idx] = tile.E[c_idx];
                                if constexpr (IsMultiMaterial) {
                                    u_tile.alpha1[c_idx] = tile.alpha1[c_idx];
                                    u_tile.alpha2[c_idx] = tile.alpha2[c_idx];
                                    u_tile.arho1[c_idx] = tile.arho1[c_idx];
                                    u_tile.arho2[c_idx] = tile.arho2[c_idx];
                                }
                            }
                        }
                    }
                }
                if (tile_has_charge) active_tiles[t_idx] = 1;
            }
        }
    }
    updateActiveRegions();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::updateActiveRegions() {
    std::vector<uint8_t> next_active = active_tiles;
    for (int tz = 0; tz < n_tiles_z; ++tz) {
        for (int ty = 0; ty < n_tiles_y; ++ty) {
            for (int tx = 0; tx < n_tiles_x; ++tx) {
                int idx = tx + ty * n_tiles_x + tz * n_tiles_x * n_tiles_y;
                if (active_tiles[idx]) {
                    if (tx > 0) next_active[idx - 1] = 1;
                    if (tx < n_tiles_x - 1) next_active[idx + 1] = 1;
                    if (ty > 0) next_active[idx - n_tiles_x] = 1;
                    if (ty < n_tiles_y - 1) next_active[idx + n_tiles_x] = 1;
                    if (tz > 0) next_active[idx - n_tiles_x * n_tiles_y] = 1;
                    if (tz < n_tiles_z - 1) next_active[idx + n_tiles_x * n_tiles_y] = 1;
                }
            }
        }
    }
    active_tiles = next_active;
}

template <typename RealType, bool IsMultiMaterial>
struct Flux3DT {
    RealType rho, rhoux, rhouy, rhouz, E, alpha1, alpha2, arho1, arho2;
};

template <typename RealType, bool IsMultiMaterial>
Flux3DT<RealType, IsMultiMaterial> getRusanovFlux3D(
    const typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial>& sL, 
    const typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial>& sR, 
    int dir, RealType gamma, const MultiMat::JWLParams& products, const MultiMat::JWLParams& unreacted) {
    
    auto physFlux = [](const typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial>& s, int dir) {
        Flux3DT<RealType, IsMultiMaterial> f;
        RealType u_n = (dir == 0) ? s.ux : (dir == 1 ? s.uy : s.uz);
        f.rho = s.rho * u_n;
        f.rhoux = s.rho * u_n * s.ux + (dir == 0 ? s.p : (RealType)0.0);
        f.rhouy = s.rho * u_n * s.uy + (dir == 1 ? s.p : (RealType)0.0);
        f.rhouz = s.rho * u_n * s.uz + (dir == 2 ? s.p : (RealType)0.0);
        f.E = u_n * (s.E + s.p);
        if constexpr (IsMultiMaterial) {
            f.alpha1 = s.alpha1 * u_n; f.alpha2 = s.alpha2 * u_n;
            f.arho1 = s.arho1 * u_n; f.arho2 = s.arho2 * u_n;
        }
        return f;
    };

    Flux3DT<RealType, IsMultiMaterial> fL = physFlux(sL, dir);
    Flux3DT<RealType, IsMultiMaterial> fR = physFlux(sR, dir);

    double cL, cR;
    if constexpr (IsMultiMaterial) {
        cL = MultiMat::getMixtureSoundSpeed((double)sL.p, (double)sL.rho, (double)sL.alpha1, (double)sL.alpha2, (double)sL.arho1, (double)sL.arho2, (double)gamma, products, unreacted);
        cR = MultiMat::getMixtureSoundSpeed((double)sR.p, (double)sR.rho, (double)sR.alpha1, (double)sR.alpha2, (double)sR.arho1, (double)sR.arho2, (double)gamma, products, unreacted);
    } else {
        cL = std::sqrt((double)gamma * (double)sL.p / std::max(1e-6, (double)sL.rho));
        cR = std::sqrt((double)gamma * (double)sR.p / std::max(1e-6, (double)sR.rho));
    }
    double uL = (dir == 0) ? (double)sL.ux : (dir == 1 ? (double)sL.uy : (double)sL.uz);
    double uR = (dir == 0) ? (double)sR.ux : (dir == 1 ? (double)sR.uy : (double)sR.uz);
    double s_max = std::max(std::abs(uL) + cL, std::abs(uR) + cR);

    Flux3DT<RealType, IsMultiMaterial> f;
    f.rho = (RealType)(0.5 * ((double)fL.rho + (double)fR.rho) - 0.5 * s_max * ((double)sR.rho - (double)sL.rho));
    f.rhoux = (RealType)(0.5 * ((double)fL.rhoux + (double)fR.rhoux) - 0.5 * s_max * ((double)sR.rho * (double)sR.ux - (double)sL.rho * (double)sL.ux));
    f.rhouy = (RealType)(0.5 * ((double)fL.rhouy + (double)fR.rhouy) - 0.5 * s_max * ((double)sR.rho * (double)sR.uy - (double)sL.rho * (double)sL.uy));
    f.rhouz = (RealType)(0.5 * ((double)fL.rhouz + (double)fR.rhouz) - 0.5 * s_max * ((double)sR.rho * (double)sR.uz - (double)sL.rho * (double)sL.uz));
    f.E = (RealType)(0.5 * ((double)fL.E + (double)fR.E) - 0.5 * s_max * ((double)sR.E - (double)sL.E));
    if constexpr (IsMultiMaterial) {
        f.alpha1 = (RealType)(0.5 * ((double)fL.alpha1 + (double)fR.alpha1) - 0.5 * s_max * ((double)sR.alpha1 - (double)sL.alpha1));
        f.alpha2 = (RealType)(0.5 * ((double)fL.alpha2 + (double)fR.alpha2) - 0.5 * s_max * ((double)sR.alpha2 - (double)sL.alpha2));
        f.arho1 = (RealType)(0.5 * ((double)fL.arho1 + (double)fR.arho1) - 0.5 * s_max * ((double)sR.arho1 - (double)sL.arho1));
        f.arho2 = (RealType)(0.5 * ((double)fL.arho2 + (double)fR.arho2) - 0.5 * s_max * ((double)sR.arho2 - (double)sL.arho2));
    }
    return f;
}

template <typename RealType, bool IsMultiMaterial>
Flux3DT<RealType, IsMultiMaterial> getAUSMPlusFlux3D(
    const typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial>& sL, 
    const typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial>& sR, 
    int dir, RealType gamma, const MultiMat::JWLParams& products, const MultiMat::JWLParams& unreacted) {
    
    double aL, aR;
    if constexpr (IsMultiMaterial) {
        aL = MultiMat::getMixtureSoundSpeed((double)sL.p, (double)sL.rho, (double)sL.alpha1, (double)sL.alpha2, (double)sL.arho1, (double)sL.arho2, (double)gamma, products, unreacted);
        aR = MultiMat::getMixtureSoundSpeed((double)sR.p, (double)sR.rho, (double)sR.alpha1, (double)sR.alpha2, (double)sR.arho1, (double)sR.arho2, (double)gamma, products, unreacted);
    } else {
        aL = std::sqrt((double)gamma * (double)sL.p / std::max(1e-6, (double)sL.rho));
        aR = std::sqrt((double)gamma * (double)sR.p / std::max(1e-6, (double)sR.rho));
    }
    double a_half = 0.5 * (aL + aR);

    double uL = (dir == 0) ? (double)sL.ux : (dir == 1 ? (double)sL.uy : (double)sL.uz);
    double uR = (dir == 0) ? (double)sR.ux : (dir == 1 ? (double)sR.uy : (double)sR.uz);
    double ML = uL / a_half;
    double MR = uR / a_half;

    double alpha = 3.0 / 16.0;
    double beta = 1.0 / 8.0;

    auto get_M_plus = [beta](double M) {
        if (std::abs(M) <= 1.0) {
            double term = 0.25 * (M + 1.0) * (M + 1.0);
            return term + beta * (M * M - 1.0) * (M * M - 1.0);
        } else {
            return 0.5 * (M + std::abs(M));
        }
    };

    auto get_M_minus = [beta](double M) {
        if (std::abs(M) <= 1.0) {
            double term = -0.25 * (M - 1.0) * (M - 1.0);
            return term - beta * (M * M - 1.0) * (M * M - 1.0);
        } else {
            return 0.5 * (M - std::abs(M));
        }
    };

    auto get_P_plus = [alpha](double M) {
        if (std::abs(M) <= 1.0) {
            double term = 0.25 * (M + 1.0) * (M + 1.0) * (2.0 - M);
            return term + alpha * M * (M * M - 1.0) * (M * M - 1.0);
        } else {
            return (M >= 0.0) ? 1.0 : 0.0;
        }
    };

    auto get_P_minus = [alpha](double M) {
        if (std::abs(M) <= 1.0) {
            double term = 0.25 * (M - 1.0) * (M - 1.0) * (2.0 + M);
            return term - alpha * M * (M * M - 1.0) * (M * M - 1.0);
        } else {
            return (M < 0.0) ? 1.0 : 0.0;
        }
    };

    double M_half_unmod = get_M_plus(ML) + get_M_minus(MR);
    double p_half_unmod = get_P_plus(ML) * (double)sL.p + get_P_minus(MR) * (double)sR.p;
    
    // AUSM+-up stabilization terms to prevent carbuncle/cube artifacts
    double Kp = 0.25;
    double Ku = 0.75;
    double rho_half = 0.5 * ((double)sL.rho + (double)sR.rho);
    
    double M_half = M_half_unmod - Kp * ((double)sR.p - (double)sL.p) / std::max(1e-6, rho_half * a_half * a_half);
    double p_half = p_half_unmod - Ku * get_P_plus(ML) * get_P_minus(MR) * rho_half * a_half * (uR - uL);

    Flux3DT<RealType, IsMultiMaterial> F;
    if (M_half >= 0.0) {
        F.rho = (RealType)(M_half * a_half * (double)sL.rho);
        F.rhoux = (RealType)(M_half * a_half * (double)sL.rho * (double)sL.ux + (dir == 0 ? p_half : 0.0));
        F.rhouy = (RealType)(M_half * a_half * (double)sL.rho * (double)sL.uy + (dir == 1 ? p_half : 0.0));
        F.rhouz = (RealType)(M_half * a_half * (double)sL.rho * (double)sL.uz + (dir == 2 ? p_half : 0.0));
        F.E = (RealType)(M_half * a_half * ((double)sL.E + (double)sL.p));
        if constexpr (IsMultiMaterial) {
            F.alpha1 = (RealType)(M_half * a_half * (double)sL.alpha1);
            F.alpha2 = (RealType)(M_half * a_half * (double)sL.alpha2);
            F.arho1 = (RealType)(M_half * a_half * (double)sL.arho1);
            F.arho2 = (RealType)(M_half * a_half * (double)sL.arho2);
        }
    } else {
        F.rho = (RealType)(M_half * a_half * (double)sR.rho);
        F.rhoux = (RealType)(M_half * a_half * (double)sR.rho * (double)sR.ux + (dir == 0 ? p_half : 0.0));
        F.rhouy = (RealType)(M_half * a_half * (double)sR.rho * (double)sR.uy + (dir == 1 ? p_half : 0.0));
        F.rhouz = (RealType)(M_half * a_half * (double)sR.rho * (double)sR.uz + (dir == 2 ? p_half : 0.0));
        F.E = (RealType)(M_half * a_half * ((double)sR.E + (double)sR.p));
        if constexpr (IsMultiMaterial) {
            F.alpha1 = (RealType)(M_half * a_half * (double)sR.alpha1);
            F.alpha2 = (RealType)(M_half * a_half * (double)sR.alpha2);
            F.arho1 = (RealType)(M_half * a_half * (double)sR.arho1);
            F.arho2 = (RealType)(M_half * a_half * (double)sR.arho2);
        }
    }



    return F;
}

template <typename RealType>
static inline RealType minmod(RealType a, RealType b) {
    if (a * b <= (RealType)0.0) return 0.0;
    return (std::abs(a) < std::abs(b)) ? a : b;
}

template <typename RealType>
static inline RealType weno3(RealType qm1, RealType q0, RealType qp1) {
    RealType eps = (RealType)1e-6;
    RealType beta0 = (qp1 - q0) * (qp1 - q0);
    RealType beta1 = (q0 - qm1) * (q0 - qm1);
    RealType alpha0 = (RealType)(2.0 / 3.0) / ((eps + beta0) * (eps + beta0));
    RealType alpha1 = (RealType)(1.0 / 3.0) / ((eps + beta1) * (eps + beta1));
    RealType sum_alpha = alpha0 + alpha1;
    RealType w0 = alpha0 / sum_alpha;
    RealType w1 = alpha1 / sum_alpha;
    return w0 * ((RealType)0.5 * q0 + (RealType)0.5 * qp1) + w1 * ((RealType)-0.5 * qm1 + (RealType)1.5 * q0);
}

template <typename RealType, bool IsMultiMaterial>
typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial> reconstruct(
    const typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial>& sL, 
    const typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial>& sC, 
    const typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial>& sR, 
    RealType side, int spatialOrder, RealType gamma, const MultiMat::JWLParams& products, const MultiMat::JWLParams& unreacted) {
    
    typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial> res;
    
    if (spatialOrder == 1) {
        return sC;
    }
    
    if (spatialOrder == 3) {
        if (side < (RealType)0.0) { // Right-biased for left face of i+1
            res.rho = std::max((RealType)1e-7, weno3(sR.rho, sC.rho, sL.rho));
            res.ux = weno3(sR.ux, sC.ux, sL.ux);
            res.uy = weno3(sR.uy, sC.uy, sL.uy);
            res.uz = weno3(sR.uz, sC.uz, sL.uz);
            res.p = std::max((RealType)1e-7, weno3(sR.p, sC.p, sL.p));
            if constexpr (IsMultiMaterial) {
                res.alpha1 = std::clamp(weno3(sR.alpha1, sC.alpha1, sL.alpha1), (RealType)0.0, (RealType)1.0);
                res.alpha2 = std::clamp(weno3(sR.alpha2, sC.alpha2, sL.alpha2), (RealType)0.0, (RealType)1.0);
                res.arho1 = std::max((RealType)0.0, weno3(sR.arho1, sC.arho1, sL.arho1));
                res.arho2 = std::max((RealType)0.0, weno3(sR.arho2, sC.arho2, sL.arho2));
            }
        } else { // Left-biased for right face of i
            res.rho = std::max((RealType)1e-7, weno3(sL.rho, sC.rho, sR.rho));
            res.ux = weno3(sL.ux, sC.ux, sR.ux);
            res.uy = weno3(sL.uy, sC.uy, sR.uy);
            res.uz = weno3(sL.uz, sC.uz, sR.uz);
            res.p = std::max((RealType)1e-7, weno3(sL.p, sC.p, sR.p));
            if constexpr (IsMultiMaterial) {
                res.alpha1 = std::clamp(weno3(sL.alpha1, sC.alpha1, sR.alpha1), (RealType)0.0, (RealType)1.0);
                res.alpha2 = std::clamp(weno3(sL.alpha2, sC.alpha2, sR.alpha2), (RealType)0.0, (RealType)1.0);
                res.arho1 = std::max((RealType)0.0, weno3(sL.arho1, sC.arho1, sR.arho1));
                res.arho2 = std::max((RealType)0.0, weno3(sL.arho2, sC.arho2, sR.arho2));
            }
        }
    } else { // spatialOrder == 2 (MinMod)
        auto slope = [&](RealType L, RealType C, RealType R) { return minmod(C - L, R - C); };
        res.rho = sC.rho + side * slope(sL.rho, sC.rho, sR.rho);
        res.ux = sC.ux + side * slope(sL.ux, sC.ux, sR.ux);
        res.uy = sC.uy + side * slope(sL.uy, sC.uy, sR.uy);
        res.uz = sC.uz + side * slope(sL.uz, sC.uz, sR.uz);
        res.p = sC.p + side * slope(sL.p, sC.p, sR.p);

        if constexpr (IsMultiMaterial) {
            res.alpha1 = std::clamp(sC.alpha1 + side * slope(sL.alpha1, sC.alpha1, sR.alpha1), (RealType)0.0, (RealType)1.0);
            res.alpha2 = std::clamp(sC.alpha2 + side * slope(sL.alpha2, sC.alpha2, sR.alpha2), (RealType)0.0, (RealType)1.0);
            res.arho1 = std::clamp(sC.arho1 + side * slope(sL.arho1, sC.arho1, sR.arho1), (RealType)0.0, res.rho);
            res.arho2 = std::clamp(sC.arho2 + side * slope(sL.arho2, sC.arho2, sR.arho2), (RealType)0.0, res.rho);
        }
    }

    RealType ke = (RealType)0.5 * res.rho * (res.ux*res.ux + res.uy*res.uy + res.uz*res.uz);
    if constexpr (IsMultiMaterial) {
        res.E = (RealType)MultiMat::getMixtureEnergy((double)res.p, (double)res.rho, (double)res.alpha1, (double)res.alpha2, (double)res.arho1, (double)res.arho2, (double)gamma, products, unreacted) + ke;
    } else {
        res.E = res.p / (gamma - (RealType)1.0) + ke;
    }

    return res;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::computeFluxes(double dt) {
    RealType invDx = (RealType)(1.0 / cellSize);
    RealType gamma_r = (RealType)gamma;
    RealType dt_r = (RealType)dt;
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

                            auto get_f = [&](const CellState3DT<RealType, IsMultiMaterial>& L, const CellState3DT<RealType, IsMultiMaterial>& R, int d) {
                                return useAUSM ? getAUSMPlusFlux3D<RealType, IsMultiMaterial>(L, R, d, gamma_r, currentMaterials.products, currentMaterials.unreacted) : getRusanovFlux3D<RealType, IsMultiMaterial>(L, R, d, gamma_r, currentMaterials.products, currentMaterials.unreacted);
                            };

                            // X-Fluxes
                            auto sL2 = sampleStateInternal(gx-2, gy, gz);
                            auto sL1 = sampleStateInternal(gx-1, gy, gz);
                            auto sC  = sampleStateInternal(gx,   gy, gz);
                            auto sR1 = sampleStateInternal(gx+1, gy, gz);
                            auto sR2 = sampleStateInternal(gx+2, gy, gz);

                            auto fxL = get_f(reconstruct<RealType, IsMultiMaterial>(sL2, sL1, sC, (RealType)0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted), reconstruct<RealType, IsMultiMaterial>(sL1, sC, sR1, (RealType)-0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted), 0);
                            auto fxR = get_f(reconstruct<RealType, IsMultiMaterial>(sL1, sC, sR1, (RealType)0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted), reconstruct<RealType, IsMultiMaterial>(sC, sR1, sR2, (RealType)-0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted), 0);

                            // Y-Fluxes
                            auto sB2 = sampleStateInternal(gx, gy-2, gz);
                            auto sB1 = sampleStateInternal(gx, gy-1, gz);
                            auto sT1 = sampleStateInternal(gx,   gy+1, gz);
                            auto sT2 = sampleStateInternal(gx,   gy+2, gz);

                            auto fyB = get_f(reconstruct<RealType, IsMultiMaterial>(sB2, sB1, sC, (RealType)0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted), reconstruct<RealType, IsMultiMaterial>(sB1, sC, sT1, (RealType)-0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted), 1);
                            auto fyT = get_f(reconstruct<RealType, IsMultiMaterial>(sB1, sC, sT1, (RealType)0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted), reconstruct<RealType, IsMultiMaterial>(sC, sT1, sT2, (RealType)-0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted), 1);

                            // Z-Fluxes
                            auto sD2 = sampleStateInternal(gx, gy, gz-2);
                            auto sD1 = sampleStateInternal(gx, gy, gz-1);
                            auto sU1 = sampleStateInternal(gx, gy, gz+1);
                            auto sU2 = sampleStateInternal(gx, gy, gz+2);

                            auto fzD = get_f(reconstruct<RealType, IsMultiMaterial>(sD2, sD1, sC, (RealType)0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted), reconstruct<RealType, IsMultiMaterial>(sD1, sC, sU1, (RealType)-0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted), 2);
                            auto fzU = get_f(reconstruct<RealType, IsMultiMaterial>(sD1, sC, sU1, (RealType)0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted), reconstruct<RealType, IsMultiMaterial>(sC, sU1, sU2, (RealType)-0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted), 2);

                            u.rho[idx] -= dt_r * invDx * (fxR.rho - fxL.rho + fyT.rho - fyB.rho + fzU.rho - fzD.rho);
                            u.rhoux[idx] -= dt_r * invDx * (fxR.rhoux - fxL.rhoux + fyT.rhoux - fyB.rhoux + fzU.rhoux - fzD.rhoux);
                            u.rhouy[idx] -= dt_r * invDx * (fxR.rhouy - fxL.rhouy + fyT.rhouy - fyB.rhouy + fzU.rhouy - fzD.rhouy);
                            u.rhouz[idx] -= dt_r * invDx * (fxR.rhouz - fxL.rhouz + fyT.rhouz - fyB.rhouz + fzU.rhouz - fzD.rhouz);
                            u.E[idx] -= dt_r * invDx * (fxR.E - fxL.E + fyT.E - fyB.E + fzU.E - fzD.E);
                            if constexpr (IsMultiMaterial) {
                                u.alpha1[idx] -= dt_r * invDx * (fxR.alpha1 - fxL.alpha1 + fyT.alpha1 - fyB.alpha1 + fzU.alpha1 - fzD.alpha1);
                                u.alpha2[idx] -= dt_r * invDx * (fxR.alpha2 - fxL.alpha2 + fyT.alpha2 - fyB.alpha2 + fzU.alpha2 - fzD.alpha2);
                                u.arho1[idx] -= dt_r * invDx * (fxR.arho1 - fxL.arho1 + fyT.arho1 - fyB.arho1 + fzU.arho1 - fzD.arho1);
                                u.arho2[idx] -= dt_r * invDx * (fxR.arho2 - fxL.arho2 + fyT.arho2 - fyB.arho2 + fzU.arho2 - fzD.arho2);
                            }
                        }
                    }
                }
            }
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::applyProgrammedBurn(double dt) {
    if constexpr (IsMultiMaterial) {
        #pragma omp parallel for collapse(3)
        for (int tz = 0; tz < n_tiles_z; ++tz) {
            for (int ty = 0; ty < n_tiles_y; ++ty) {
                for (int tx = 0; tx < n_tiles_x; ++tx) {
                    int t_idx = tx + ty * n_tiles_x + tz * n_tiles_x * n_tiles_y;
                    if (!active_tiles[t_idx]) continue;
                    auto& u = U_pool[t_idx];
                    for (int k = 0; k < TILE_SIZE_3D; ++k) {
                        int gz = tz * TILE_SIZE_3D + k;
                        double z_c = zmin + (gz + 0.5) * cellSize;
                        for (int j = 0; j < TILE_SIZE_3D; ++j) {
                            int gy = ty * TILE_SIZE_3D + j;
                            double y_c = ymin + (gy + 0.5) * cellSize;
                            for (int i = 0; i < TILE_SIZE_3D; ++i) {
                                int gx = tx * TILE_SIZE_3D + i;
                                double x_c = xmin + (gx + 0.5) * cellSize;
                                int c_idx = i + j * TILE_SIZE_3D + k * TILE_SIZE_3D * TILE_SIZE_3D;

                                double tmp_alpha1 = (double)u.alpha1[c_idx];
                                double tmp_alpha2 = (double)u.alpha2[c_idx];
                                double tmp_arho1 = (double)u.arho1[c_idx];
                                double tmp_arho2 = (double)u.arho2[c_idx];
                                double dF = MultiMat::computeProgrammedBurn(
                                    currentTime, dt, x_c, y_c, z_c,
                                    currentMaterials.det_vel, 0.0, detX, detY, detZ,
                                    cellSize, currentMaterials.products.rho0,
                                    tmp_alpha1, tmp_alpha2, tmp_arho1, tmp_arho2
                                );
                                u.alpha1[c_idx] = (RealType)tmp_alpha1;
                                u.alpha2[c_idx] = (RealType)tmp_alpha2;
                                u.arho1[c_idx] = (RealType)tmp_arho1;
                                u.arho2[c_idx] = (RealType)tmp_arho2;
                                if (currentMaterials.detonation_energy > 0.0 && dF > 0.0) {
                                    double rho_expl = (double)(u.arho1[c_idx] + u.arho2[c_idx]);
                                    u.E[c_idx] += (RealType)(dF * rho_expl * currentMaterials.detonation_energy);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::updatePrimitiveFromConservative() {
    RealType gamma_r = (RealType)gamma;

    #pragma omp parallel for
    for (int t = 0; t < (int)states_pool.size(); ++t) {
        if (!active_tiles[t]) continue;
        auto& s = states_pool[t];
        auto& u = U_pool[t];
        for (int i = 0; i < TILE_CELLS_3D; ++i) {
            RealType u_rho = u.rho[i];
            RealType u_rhoux = u.rhoux[i];
            RealType u_rhouy = u.rhouy[i];
            RealType u_rhouz = u.rhouz[i];
            RealType u_E = u.E[i];

            bool bad = std::isnan(u_rho) || std::isinf(u_rho) || u_rho < (RealType)1e-8 ||
                       std::isnan(u_rhoux) || std::isinf(u_rhoux) ||
                       std::isnan(u_rhouy) || std::isinf(u_rhouy) ||
                       std::isnan(u_rhouz) || std::isinf(u_rhouz) ||
                       std::isnan(u_E) || std::isinf(u_E);

            if constexpr (IsMultiMaterial) {
                bad = bad || std::isnan(u.alpha1[i]) || std::isinf(u.alpha1[i]) ||
                            std::isnan(u.alpha2[i]) || std::isinf(u.alpha2[i]) ||
                            std::isnan(u.arho1[i]) || std::isinf(u.arho1[i]) ||
                            std::isnan(u.arho2[i]) || std::isinf(u.arho2[i]);
            }

            if (!bad) {
                s.rho[i] = std::max(u_rho, (RealType)1e-8);
                s.ux[i] = u_rhoux / s.rho[i];
                s.uy[i] = u_rhouy / s.rho[i];
                s.uz[i] = u_rhouz / s.rho[i];
                s.E[i] = u_E;
                RealType ke = (RealType)0.5 * s.rho[i] * (s.ux[i]*s.ux[i] + s.uy[i]*s.uy[i] + s.uz[i]*s.uz[i]);
                RealType e_int = s.E[i] - ke;

                if constexpr (IsMultiMaterial) {
                    s.alpha1[i] = std::clamp(u.alpha1[i], (RealType)0.0, (RealType)1.0);
                    s.alpha2[i] = std::clamp(u.alpha2[i], (RealType)0.0, (RealType)1.0);
                    s.arho1[i] = std::clamp(u.arho1[i], (RealType)0.0, s.rho[i]);
                    s.arho2[i] = std::clamp(u.arho2[i], (RealType)0.0, s.rho[i]);
                    
                    double p_val = MultiMat::getMixturePressure((double)e_int, (double)s.rho[i], (double)s.alpha1[i], (double)s.alpha2[i], (double)s.arho1[i], (double)s.arho2[i], (double)gamma_r, currentMaterials.products, currentMaterials.unreacted);
                    if (std::isnan(p_val) || std::isinf(p_val) || p_val < 1e-8) {
                        bad = true;
                    } else {
                        s.p[i] = (RealType)p_val;
                    }
                } else {
                    RealType p_val = e_int * (gamma_r - (RealType)1.0);
                    if (std::isnan(p_val) || std::isinf(p_val) || p_val < (RealType)1e-8) {
                        bad = true;
                    } else {
                        s.p[i] = p_val;
                    }
                }
            }

            if (bad) {
                s.rho[i] = (RealType)ambient_rho;
                s.ux[i] = 0.0;
                s.uy[i] = 0.0;
                s.uz[i] = 0.0;
                s.p[i] = (RealType)ambient_p;
                CellState3D<IsMultiMaterial> temp_s;
                if constexpr (IsMultiMaterial) {
                    temp_s.alpha1 = 0.0; temp_s.alpha2 = 0.0;
                    temp_s.arho1 = 0.0; temp_s.arho2 = 0.0;
                    s.alpha1[i] = 0.0; s.alpha2[i] = 0.0;
                    s.arho1[i] = 0.0; s.arho2[i] = 0.0;
                }
                s.E[i] = (RealType)getEnergy3D<IsMultiMaterial>(ambient_p, ambient_rho, temp_s, gamma, currentMaterials.products, currentMaterials.unreacted);

                u.rho[i] = (RealType)ambient_rho;
                u.rhoux[i] = 0.0;
                u.rhouy[i] = 0.0;
                u.rhouz[i] = 0.0;
                u.E[i] = s.E[i];
                if constexpr (IsMultiMaterial) {
                    u.alpha1[i] = 0.0; u.alpha2[i] = 0.0;
                    u.arho1[i] = 0.0; u.arho2[i] = 0.0;
                }
                s.floor_status[i] = 1;
            } else {
                s.floor_status[i] = 0;
            }
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::step(double dt) {
    auto copy_primitive_to_U = [&]() {
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
    };

    auto average_U = [&](const std::vector<ConservativeTile3D<RealType, IsMultiMaterial>>& U0, double w0, double w1) {
        RealType w0_r = (RealType)w0;
        RealType w1_r = (RealType)w1;
        #pragma omp parallel for
        for (int t = 0; t < (int)states_pool.size(); ++t) {
            if (!active_tiles[t]) continue;
            auto& u = U_pool[t];
            const auto& u0 = U0[t];
            for (int i = 0; i < TILE_CELLS_3D; ++i) {
                u.rho[i] = w0_r * u0.rho[i] + w1_r * u.rho[i];
                u.rhoux[i] = w0_r * u0.rhoux[i] + w1_r * u.rhoux[i];
                u.rhouy[i] = w0_r * u0.rhouy[i] + w1_r * u.rhouy[i];
                u.rhouz[i] = w0_r * u0.rhouz[i] + w1_r * u.rhouz[i];
                u.E[i] = w0_r * u0.E[i] + w1_r * u.E[i];
                if constexpr (IsMultiMaterial) {
                    u.alpha1[i] = w0_r * u0.alpha1[i] + w1_r * u.alpha1[i];
                    u.alpha2[i] = w0_r * u0.alpha2[i] + w1_r * u.alpha2[i];
                    u.arho1[i] = w0_r * u0.arho1[i] + w1_r * u.arho1[i];
                    u.arho2[i] = w0_r * u0.arho2[i] + w1_r * u.arho2[i];
                }
            }
        }
    };

    copy_primitive_to_U();

    if (temporalOrder == 1) {
        computeFluxes(dt);
    } else if (temporalOrder == 2) {
        U_prev_pool = U_pool;
        computeFluxes(dt);
        updatePrimitiveFromConservative();
        applyBC();
        
        computeFluxes(dt);
        average_U(U_prev_pool, 0.5, 0.5);
    } else { // SSP-RK3
        U_prev_pool = U_pool;
        
        // Stage 1
        computeFluxes(dt);
        updatePrimitiveFromConservative();
        applyBC();

        // Stage 2
        computeFluxes(dt);
        average_U(U_prev_pool, 0.75, 0.25);
        updatePrimitiveFromConservative();
        applyBC();

        // Stage 3
        computeFluxes(dt);
        average_U(U_prev_pool, 1.0 / 3.0, 2.0 / 3.0);
    }

    if constexpr (IsMultiMaterial) {
        applyProgrammedBurn(dt);
    }

    updatePrimitiveFromConservative();
    applyBC();
    currentTime += dt;
    updateActiveRegions();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::applyBC() {}

template <typename RealType, bool IsMultiMaterial>
double CFDSolver3DImpl<RealType, IsMultiMaterial>::computeStepSize(double cfl) const {
    double max_s = 1e-6;
    #pragma omp parallel for reduction(max:max_s)
    for (int t = 0; t < (int)states_pool.size(); ++t) {
        if (!active_tiles[t]) continue;
        const auto& tile = states_pool[t];
        for (int i = 0; i < TILE_CELLS_3D; ++i) {
            double u_mag = std::sqrt((double)(tile.ux[i]*tile.ux[i] + tile.uy[i]*tile.uy[i] + tile.uz[i]*tile.uz[i]));
            double c;
            if constexpr (IsMultiMaterial) {
                c = MultiMat::getMixtureSoundSpeed((double)tile.p[i], (double)tile.rho[i], (double)tile.alpha1[i], (double)tile.alpha2[i], (double)tile.arho1[i], (double)tile.arho2[i], gamma, currentMaterials.products, currentMaterials.unreacted);
            } else {
                c = std::sqrt(gamma * (double)tile.p[i] / std::max(1e-6, (double)tile.rho[i]));
            }
            if (u_mag + c > max_s) {
                max_s = u_mag + c;
            }
        }
    }
    return cfl * cellSize / max_s;
}

template <typename RealType, bool IsMultiMaterial>
std::vector<float> CFDSolver3DImpl<RealType, IsMultiMaterial>::sampleGauge(const Gauge3D& gauge) const {
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

template <typename RealType, bool IsMultiMaterial>
std::vector<float> CFDSolver3DImpl<RealType, IsMultiMaterial>::extractSlice(const Slice3D& slice) const {
    std::vector<float> data;
    std::string qty = (slice.quantities.empty()) ? "pressure" : slice.quantities[0];
    int stride = slice.stride > 0 ? slice.stride : 1;

    auto getVal = [&](const CellState3D<IsMultiMaterial>& s) -> float {
        if (qty == "density" || qty == "rho") return (float)s.rho;
        if (qty == "velocity" || qty == "speed") return (float)std::sqrt(s.ux*s.ux + s.uy*s.uy + s.uz*s.uz);
        if (qty == "energy" || qty == "internal_energy") return (float)(s.E / std::max(s.rho, 1e-6));
        if (qty == "species1" || qty == "alpha1") return (float)s.alpha1;
        if (qty == "species2" || qty == "alpha2") return (float)s.alpha2;
        if (qty == "species3") return (float)(1.0 - s.alpha1 - s.alpha2);
        return (float)s.p;
    };

    if (slice.axis == "xy") {
        int gz = std::clamp((int)((slice.offset - zmin) / cellSize), 0, nz - 1);
        int out_nx = (nx + stride - 1) / stride;
        int out_ny = (ny + stride - 1) / stride;
        data.resize(out_nx * out_ny);
        for (int gy = 0; gy < out_ny; ++gy) {
            for (int gx = 0; gx < out_nx; ++gx) {
                data[gx + gy * out_nx] = getVal(sampleState(gx * stride, gy * stride, gz));
            }
        }
    } else if (slice.axis == "xz") {
        int gy = std::clamp((int)((slice.offset - ymin) / cellSize), 0, ny - 1);
        int out_nx = (nx + stride - 1) / stride;
        int out_nz = (nz + stride - 1) / stride;
        data.resize(out_nx * out_nz);
        for (int gz = 0; gz < out_nz; ++gz) {
            for (int gx = 0; gx < out_nx; ++gx) {
                data[gx + gz * out_nx] = getVal(sampleState(gx * stride, gy, gz * stride));
            }
        }
    } else if (slice.axis == "yz") {
        int gx = std::clamp((int)((slice.offset - xmin) / cellSize), 0, nx - 1);
        int out_ny = (ny + stride - 1) / stride;
        int out_nz = (nz + stride - 1) / stride;
        data.resize(out_ny * out_nz);
        for (int gz = 0; gz < out_nz; ++gz) {
            for (int gy = 0; gy < out_ny; ++gy) {
                data[gy + gz * out_ny] = getVal(sampleState(gx, gy * stride, gz * stride));
            }
        }
    }
    return data;
}

extern void remap_1d_to_3d(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d,
                    CFDSolver3D& solver_3d, double x_expl, double y_expl, double z_expl, double R_remap);

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::initializeFrom1D(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d, double x_expl, double y_expl, double z_expl, double R_remap) {
    double amb_rho = states_1d.back().rho;
    double amb_p = states_1d.back().p;
    ambient_rho = amb_rho;
    ambient_p = amb_p;

    #pragma omp parallel for
    for (int t = 0; t < (int)states_pool.size(); ++t) {
        auto& tile = states_pool[t];
        auto& u_tile = U_pool[t];
        for (int i = 0; i < TILE_CELLS_3D; ++i) {
            tile.rho[i] = (RealType)amb_rho;
            tile.ux[i] = 0.0;
            tile.uy[i] = 0.0;
            tile.uz[i] = 0.0;
            tile.p[i] = (RealType)amb_p;
            CellState3D<IsMultiMaterial> temp_s;
            if constexpr (IsMultiMaterial) {
                temp_s.alpha1 = 1.0; temp_s.alpha2 = 0.0;
                temp_s.arho1 = amb_rho; temp_s.arho2 = 0.0;
                tile.alpha1[i] = 1.0;
                tile.alpha2[i] = 0.0;
                tile.arho1[i] = (RealType)amb_rho;
                tile.arho2[i] = 0.0;
            }
            tile.E[i] = (RealType)getEnergy3D<IsMultiMaterial>(amb_p, amb_rho, temp_s, gamma, currentMaterials.products, currentMaterials.unreacted);
            tile.arrival_time[i] = (RealType)-1.0;
            tile.floor_status[i] = 0;

            u_tile.rho[i] = (RealType)amb_rho;
            u_tile.rhoux[i] = 0.0;
            u_tile.rhouy[i] = 0.0;
            u_tile.rhouz[i] = 0.0;
            u_tile.E[i] = tile.E[i];
            if constexpr (IsMultiMaterial) {
                u_tile.alpha1[i] = 1.0;
                u_tile.alpha2[i] = 0.0;
                u_tile.arho1[i] = (RealType)amb_rho;
                u_tile.arho2[i] = 0.0;
            }
        }
    }
    active_tiles.assign(states_pool.size(), 0);

    remap_1d_to_3d(r_1d, states_1d, *this, x_expl, y_expl, z_expl, R_remap);
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::setCellStateMulti(int gx, int gy, int gz, const CellState3D<true>& s) {
    if constexpr (IsMultiMaterial) {
        int t_idx = (gx / TILE_SIZE_3D) + (gy / TILE_SIZE_3D) * n_tiles_x + (gz / TILE_SIZE_3D) * n_tiles_x * n_tiles_y;
        int c_idx = (gx % TILE_SIZE_3D) + (gy % TILE_SIZE_3D) * TILE_SIZE_3D + (gz % TILE_SIZE_3D) * TILE_SIZE_3D * TILE_SIZE_3D;
        auto& tile = states_pool[t_idx];
        tile.rho[c_idx] = (RealType)s.rho; tile.ux[c_idx] = (RealType)s.ux; tile.uy[c_idx] = (RealType)s.uy; tile.uz[c_idx] = (RealType)s.uz;
        tile.p[c_idx] = (RealType)s.p; tile.E[c_idx] = (RealType)s.E;
        tile.alpha1[c_idx] = (RealType)s.alpha1; tile.alpha2[c_idx] = (RealType)s.alpha2;
        tile.arho1[c_idx] = (RealType)s.arho1; tile.arho2[c_idx] = (RealType)s.arho2;
        active_tiles[t_idx] = 1;
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::setCellStateIdeal(int gx, int gy, int gz, const CellState3D<false>& s) {
    int tx = gx / TILE_SIZE_3D;
    int ty = gy / TILE_SIZE_3D;
    int tz = gz / TILE_SIZE_3D;
    int t_idx = tx + ty * n_tiles_x + tz * n_tiles_x * n_tiles_y;
    int c_idx = (gx % TILE_SIZE_3D) + (gy % TILE_SIZE_3D) * TILE_SIZE_3D + (gz % TILE_SIZE_3D) * TILE_SIZE_3D * TILE_SIZE_3D;
    auto& tile = states_pool[t_idx];
    tile.rho[c_idx] = (RealType)s.rho; tile.ux[c_idx] = (RealType)s.ux; tile.uy[c_idx] = (RealType)s.uy; tile.uz[c_idx] = (RealType)s.uz;
    tile.p[c_idx] = (RealType)s.p; tile.E[c_idx] = (RealType)s.E;
    active_tiles[t_idx] = 1;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::commitStates() {
    updateActiveRegions();
    
    #pragma omp parallel for
    for (int t = 0; t < (int)states_pool.size(); ++t) {
        if (!active_tiles[t]) continue;
        const auto& state_tile = states_pool[t];
        auto& u_tile = U_pool[t];
        for (int i = 0; i < TILE_CELLS_3D; ++i) {
            u_tile.rho[i] = state_tile.rho[i];
            u_tile.rhoux[i] = state_tile.rho[i] * state_tile.ux[i];
            u_tile.rhouy[i] = state_tile.rho[i] * state_tile.uy[i];
            u_tile.rhouz[i] = state_tile.rho[i] * state_tile.uz[i];
            u_tile.E[i] = state_tile.E[i];
            if constexpr (IsMultiMaterial) {
                u_tile.arho1[i] = state_tile.arho1[i];
                u_tile.arho2[i] = state_tile.arho2[i];
                u_tile.alpha1[i] = state_tile.alpha1[i];
                u_tile.alpha2[i] = state_tile.alpha2[i];
            }
        }
    }
}

template <typename RealType, bool IsMultiMaterial> void CFDSolver3DImpl<RealType, IsMultiMaterial>::setFluxScheme(const std::string& name) { currentFluxScheme = name; }
template <typename RealType, bool IsMultiMaterial> void CFDSolver3DImpl<RealType, IsMultiMaterial>::setSpatialOrder(int order) { spatialOrder = order; }
template <typename RealType, bool IsMultiMaterial> void CFDSolver3DImpl<RealType, IsMultiMaterial>::setTemporalOrder(int order) { temporalOrder = order; }
template <typename RealType, bool IsMultiMaterial> bool CFDSolver3DImpl<RealType, IsMultiMaterial>::checkTermination() { return false; }

template class CFDSolver3DImpl<float, false>;
template class CFDSolver3DImpl<float, true>;
template class CFDSolver3DImpl<double, false>;
template class CFDSolver3DImpl<double, true>;
