#include "cfd_solver_3d.hpp"
#include <cmath>
#include <algorithm>
#include <iostream>
#include <omp.h>
#include <atomic>
#include <unordered_map>
#include "ImmersedBoundary.hpp"

template <typename RealType, bool IsMultiMaterial>
CFDSolver3DImpl<RealType, IsMultiMaterial>::CFDSolver3DImpl(int nx, int ny, int nz, double cellSize, double xmin, double ymin, double zmin)
    : CFDSolver3DImplBase(nx, ny, nz, cellSize, xmin, ymin, zmin) {

    n_tiles_x = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    n_tiles_y = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    n_tiles_z = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;

    int total_tiles = n_tiles_x * n_tiles_y * n_tiles_z;
    states_pool.resize(total_tiles);
    U_pool.resize(total_tiles);
    dU_pool.resize(total_tiles);
    active_tiles.assign(total_tiles, 0);
    geom_pool.resize(total_tiles);
    #pragma omp parallel for
    for (int t = 0; t < total_tiles; ++t) {
        std::fill(geom_pool[t].cells, geom_pool[t].cells + TILE_CELLS_3D, GeometryPayload{0, 0, 0, false});
    }
    is_ideal_gas_val = !IsMultiMaterial;
    MultiMat::initializePrecalculatedTerms(currentMaterials);
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
    MultiMat::initializePrecalculatedTerms(currentMaterials);

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
                tile.alpha1[i] = 0.0;
                tile.alpha2[i] = 0.0;
                tile.arho1[i] = 0.0;
                tile.arho2[i] = 0.0;
            }
            tile.floor_status[i] = 0;
            tile.peak_overpressure[i] = 0.0;
            tile.running_impulse[i] = 0.0;
            tile.peak_impulse[i] = 0.0;

            u_tile.rho[i] = (RealType)ambient_rho;
            u_tile.rhoux[i] = 0.0;
            u_tile.rhouy[i] = 0.0;
            u_tile.rhouz[i] = 0.0;
            u_tile.E[i] = (RealType)getEnergy3D<IsMultiMaterial>(ambient_p, ambient_rho, temp_s, gamma, currentMaterials.products, currentMaterials.unreacted);
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
                                    tile.alpha1[c_idx] = 0.0;
                                    tile.alpha2[c_idx] = (RealType)f_vol;
                                    tile.arho1[c_idx] = 0.0;
                                    tile.arho2[c_idx] = tile.alpha2[c_idx] * (RealType)materials.unreacted.rho0;
                                    tile.rho[c_idx] = tile.arho2[c_idx] + (1.0 - f_vol) * (RealType)ambient_rho;
                                    tile.p[c_idx] = (RealType)ambient_p;
                                    temp_s.alpha1 = 0.0; temp_s.alpha2 = (double)tile.alpha2[c_idx];
                                    temp_s.arho1 = 0.0; temp_s.arho2 = (double)tile.arho2[c_idx];
                                } else {
                                    tile.rho[c_idx] = (RealType)(f_vol * materials.unreacted.rho0 + (1.0 - f_vol) * ambient_rho);
                                    double p_high = (gamma - 1.0) * materials.unreacted.rho0 * materials.detonation_energy;
                                    tile.p[c_idx] = (RealType)(f_vol * p_high + (1.0 - f_vol) * ambient_p);
                                }
                                auto& u_tile = U_pool[t_idx];
                                u_tile.rho[c_idx] = tile.rho[c_idx];
                                u_tile.rhoux[c_idx] = 0.0;
                                u_tile.rhouy[c_idx] = 0.0;
                                u_tile.rhouz[c_idx] = 0.0;
                                u_tile.E[c_idx] = (RealType)getEnergy3D<IsMultiMaterial>((double)tile.p[c_idx], (double)tile.rho[c_idx], temp_s, gamma, currentMaterials.products, currentMaterials.unreacted);
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
    int total_tiles = n_tiles_x * n_tiles_y * n_tiles_z;
    std::vector<uint8_t> physically_active(total_tiles, 0);

    #pragma omp parallel for collapse(3)
    for (int tz = 0; tz < n_tiles_z; ++tz) {
        for (int ty = 0; ty < n_tiles_y; ++ty) {
            for (int tx = 0; tx < n_tiles_x; ++tx) {
                int t_idx = tx + ty * n_tiles_x + tz * n_tiles_x * n_tiles_y;
                const auto& tile = states_pool[t_idx];
                bool active = false;
                for (int i = 0; i < TILE_CELLS_3D; ++i) {
                    double u2 = (double)(tile.ux[i]*tile.ux[i] + tile.uy[i]*tile.uy[i] + tile.uz[i]*tile.uz[i]);
                    double dp = std::abs((double)tile.p[i] - ambient_p);
                    double a2 = 0.0;
                    if constexpr (IsMultiMaterial) {
                        a2 = (double)tile.alpha2[i];
                    }
                    if (a2 > 1e-4 || dp > 1e-3 * ambient_p || u2 > 1e-2) {
                        active = true;
                        break;
                    }
                }
                physically_active[t_idx] = active ? 1 : 0;
            }
        }
    }

    std::vector<uint8_t> next_active = physically_active;
    for (int tz = 0; tz < n_tiles_z; ++tz) {
        for (int ty = 0; ty < n_tiles_y; ++ty) {
            for (int tx = 0; tx < n_tiles_x; ++tx) {
                int idx = tx + ty * n_tiles_x + tz * n_tiles_x * n_tiles_y;
                if (physically_active[idx]) {
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
    RealType v_face;
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

    RealType cL, cR;
    if constexpr (IsMultiMaterial) {
        cL = MultiMat::getMixtureSoundSpeed(sL.p, sL.rho, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, gamma, products, unreacted);
        cR = MultiMat::getMixtureSoundSpeed(sR.p, sR.rho, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, gamma, products, unreacted);
    } else {
        cL = std::sqrt(gamma * sL.p / std::max((RealType)1e-6, sL.rho));
        cR = std::sqrt(gamma * sR.p / std::max((RealType)1e-6, sR.rho));
    }
    RealType uL = (dir == 0) ? sL.ux : (dir == 1 ? sL.uy : sL.uz);
    RealType uR = (dir == 0) ? sR.ux : (dir == 1 ? sR.uy : sR.uz);
    using std::abs;
    using std::max;
    RealType s_max = max(abs(uL) + cL, abs(uR) + cR);

    Flux3DT<RealType, IsMultiMaterial> f;
    f.rho = (RealType)0.5 * (fL.rho + fR.rho) - (RealType)0.5 * s_max * (sR.rho - sL.rho);
    f.rhoux = (RealType)0.5 * (fL.rhoux + fR.rhoux) - (RealType)0.5 * s_max * (sR.rho * sR.ux - sL.rho * sL.ux);
    f.rhouy = (RealType)0.5 * (fL.rhouy + fR.rhouy) - (RealType)0.5 * s_max * (sR.rho * sR.uy - sL.rho * sL.uy);
    f.rhouz = (RealType)0.5 * (fL.rhouz + fR.rhouz) - (RealType)0.5 * s_max * (sR.rho * sR.uz - sL.rho * sL.uz);
    f.E = (RealType)0.5 * (fL.E + fR.E) - (RealType)0.5 * s_max * (sR.E - sL.E);
    if constexpr (IsMultiMaterial) {
        f.alpha1 = (RealType)0.5 * (fL.alpha1 + fR.alpha1) - (RealType)0.5 * s_max * (sR.alpha1 - sL.alpha1);
        f.alpha2 = (RealType)0.5 * (fL.alpha2 + fR.alpha2) - (RealType)0.5 * s_max * (sR.alpha2 - sL.alpha2);
        f.arho1 = (RealType)0.5 * (fL.arho1 + fR.arho1) - (RealType)0.5 * s_max * (sR.arho1 - sL.arho1);
        f.arho2 = (RealType)0.5 * (fL.arho2 + fR.arho2) - (RealType)0.5 * s_max * (sR.arho2 - sL.arho2);
    }
    f.v_face = (RealType)0.5 * (uL + uR);
    return f;
}

template <typename RealType, bool IsMultiMaterial>
Flux3DT<RealType, IsMultiMaterial> getAUSMPlusFlux3D(
    const typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial>& sL, 
    const typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial>& sR, 
    int dir, RealType gamma, const MultiMat::JWLParams& products, const MultiMat::JWLParams& unreacted) {
    
    RealType aL, aR;
    if constexpr (IsMultiMaterial) {
        aL = MultiMat::getMixtureSoundSpeed(sL.p, sL.rho, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, gamma, products, unreacted);
        aR = MultiMat::getMixtureSoundSpeed(sR.p, sR.rho, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, gamma, products, unreacted);
    } else {
        using std::sqrt;
        aL = sqrt(gamma * sL.p / std::max((RealType)1e-6, sL.rho));
        aR = sqrt(gamma * sR.p / std::max((RealType)1e-6, sR.rho));
    }
    RealType a_half = (RealType)0.5 * (aL + aR);

    RealType uL = (dir == 0) ? sL.ux : (dir == 1 ? sL.uy : sL.uz);
    RealType uR = (dir == 0) ? sR.ux : (dir == 1 ? sR.uy : sR.uz);
    RealType ML = uL / a_half;
    RealType MR = uR / a_half;

    RealType alpha = (RealType)(3.0 / 16.0);
    RealType beta = (RealType)(1.0 / 8.0);

    auto get_M_plus = [beta](RealType M) {
        using std::abs;
        if (abs(M) <= (RealType)1.0) {
            RealType term = (RealType)0.25 * (M + (RealType)1.0) * (M + (RealType)1.0);
            return term + beta * (M * M - (RealType)1.0) * (M * M - (RealType)1.0);
        } else {
            return (RealType)0.5 * (M + abs(M));
        }
    };

    auto get_M_minus = [beta](RealType M) {
        using std::abs;
        if (abs(M) <= (RealType)1.0) {
            RealType term = (RealType)-0.25 * (M - (RealType)1.0) * (M - (RealType)1.0);
            return term - beta * (M * M - (RealType)1.0) * (M * M - (RealType)1.0);
        } else {
            return (RealType)0.5 * (M - abs(M));
        }
    };

    auto get_P_plus = [alpha](RealType M) {
        using std::abs;
        if (abs(M) <= (RealType)1.0) {
            RealType term = (RealType)0.25 * (M + (RealType)1.0) * (M + (RealType)1.0) * ((RealType)2.0 - M);
            return term + alpha * M * (M * M - (RealType)1.0) * (M * M - (RealType)1.0);
        } else {
            return (M >= (RealType)0.0) ? (RealType)1.0 : (RealType)0.0;
        }
    };

    auto get_P_minus = [alpha](RealType M) {
        using std::abs;
        if (abs(M) <= (RealType)1.0) {
            RealType term = (RealType)0.25 * (M - (RealType)1.0) * (M - (RealType)1.0) * ((RealType)2.0 + M);
            return term - alpha * M * (M * M - (RealType)1.0) * (M * M - (RealType)1.0);
        } else {
            return (M < (RealType)0.0) ? (RealType)1.0 : (RealType)0.0;
        }
    };

    RealType M_half_unmod = get_M_plus(ML) + get_M_minus(MR);
    RealType p_half_unmod = get_P_plus(ML) * sL.p + get_P_minus(MR) * sR.p;
    
    // AUSM+-up stabilization terms to prevent carbuncle/cube artifacts
    RealType Kp = (RealType)0.25;
    RealType Ku = (RealType)0.75;
    RealType rho_half = (RealType)0.5 * (sL.rho + sR.rho);
    
    RealType M_half = M_half_unmod - Kp * (sR.p - sL.p) / std::max((RealType)1e-6, rho_half * a_half * a_half);
    RealType p_half = p_half_unmod - Ku * get_P_plus(ML) * get_P_minus(MR) * rho_half * a_half * (uR - uL);

    Flux3DT<RealType, IsMultiMaterial> F;
    if (M_half >= (RealType)0.0) {
        F.rho = M_half * a_half * sL.rho;
        F.rhoux = M_half * a_half * sL.rho * sL.ux + (dir == 0 ? p_half : (RealType)0.0);
        F.rhouy = M_half * a_half * sL.rho * sL.uy + (dir == 1 ? p_half : (RealType)0.0);
        F.rhouz = M_half * a_half * sL.rho * sL.uz + (dir == 2 ? p_half : (RealType)0.0);
        F.E = M_half * a_half * (sL.E + sL.p);
        if constexpr (IsMultiMaterial) {
            F.alpha1 = M_half * a_half * sL.alpha1;
            F.alpha2 = M_half * a_half * sL.alpha2;
            F.arho1 = M_half * a_half * sL.arho1;
            F.arho2 = M_half * a_half * sL.arho2;
        }
    } else {
        F.rho = M_half * a_half * sR.rho;
        F.rhoux = M_half * a_half * sR.rho * sR.ux + (dir == 0 ? p_half : (RealType)0.0);
        F.rhouy = M_half * a_half * sR.rho * sR.uy + (dir == 1 ? p_half : (RealType)0.0);
        F.rhouz = M_half * a_half * sR.rho * sR.uz + (dir == 2 ? p_half : (RealType)0.0);
        F.E = M_half * a_half * (sR.E + sR.p);
        if constexpr (IsMultiMaterial) {
            F.alpha1 = M_half * a_half * sR.alpha1;
            F.alpha2 = M_half * a_half * sR.alpha2;
            F.arho1 = M_half * a_half * sR.arho1;
            F.arho2 = M_half * a_half * sR.arho2;
        }
    }
    F.v_face = M_half * a_half;
    return F;
}

template <typename RealType>
static inline RealType minmod(RealType a, RealType b) {
    if (a * b <= (RealType)0.0) return 0.0;
    return (std::abs(a) < std::abs(b)) ? a : b;
}

template <typename RealType>
static inline RealType weno3(RealType qm1, RealType q0, RealType qp1) {
    double eps = 1e-6;
    double beta0 = (double)(qp1 - q0) * (double)(qp1 - q0);
    double beta1 = (double)(q0 - qm1) * (double)(q0 - qm1);
    double alpha0 = (2.0 / 3.0) / ((eps + beta0) * (eps + beta0));
    double alpha1 = (1.0 / 3.0) / ((eps + beta1) * (eps + beta1));
    double sum_alpha = alpha0 + alpha1;
    double w0, w1;
    if (sum_alpha < 1e-300) {
        w0 = 2.0 / 3.0;
        w1 = 1.0 / 3.0;
    } else {
        w0 = alpha0 / sum_alpha;
        w1 = alpha1 / sum_alpha;
    }
    return (RealType)(w0 * (0.5 * (double)q0 + 0.5 * (double)qp1) + w1 * (-0.5 * (double)qm1 + 1.5 * (double)q0));
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
        res.E = MultiMat::getMixtureEnergy(res.p, res.rho, res.alpha1, res.alpha2, res.arho1, res.arho2, gamma, products, unreacted) + ke;
    } else {
        res.E = res.p / (gamma - (RealType)1.0) + ke;
    }

    return res;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::computeFluxes(double dt, std::vector<ConservativeTile3D<RealType, IsMultiMaterial>>& target_pool) {
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

                auto& u = target_pool[t_idx];

                for (int k = 0; k < TILE_SIZE_3D; ++k) {
                    int gz = tz * TILE_SIZE_3D + k;
                    for (int j = 0; j < TILE_SIZE_3D; ++j) {
                        int gy = ty * TILE_SIZE_3D + j;
                        for (int i = 0; i < TILE_SIZE_3D; ++i) {
                            int gx = tx * TILE_SIZE_3D + i;
                            int idx = i + j * TILE_SIZE_3D + k * TILE_SIZE_3D * TILE_SIZE_3D;
                            auto is_solid = [&](int cx, int cy, int cz) {
                                if (geom_pool.empty()) return false;
                                if (cx < 0 || cx >= nx || cy < 0 || cy >= ny || cz < 0 || cz >= nz) return false;
                                int t = (cx >> 3) + (cy >> 3) * n_tiles_x + (cz >> 3) * n_tiles_x * n_tiles_y;
                                int c = (cx & 7) + (cy & 7) * 8 + (cz & 7) * 64;
                                return geom_pool[t].cells[c].is_boundary;
                            };

                            bool is_boundary = is_solid(gx, gy, gz);
                            if (!is_boundary) {
                                auto sC = sampleStateInternal(gx, gy, gz);

                                auto get_f = [&](const CellState3DT<RealType, IsMultiMaterial>& L, const CellState3DT<RealType, IsMultiMaterial>& R, int d) {
                                    return useAUSM ? getAUSMPlusFlux3D<RealType, IsMultiMaterial>(L, R, d, gamma_r, currentMaterials.products, currentMaterials.unreacted) : getRusanovFlux3D<RealType, IsMultiMaterial>(L, R, d, gamma_r, currentMaterials.products, currentMaterials.unreacted);
                                };

                                auto get_c = [&](const CellState3DT<RealType, IsMultiMaterial>& state) {
                                    if constexpr (IsMultiMaterial) {
                                        return (RealType)MultiMat::getMixtureSoundSpeed((double)state.p, (double)state.rho, (double)state.alpha1, (double)state.alpha2, (double)state.arho1, (double)state.arho2, (double)gamma_r, currentMaterials.products, currentMaterials.unreacted);
                                    } else {
                                        return (RealType)std::sqrt(gamma_r * state.p / std::max((RealType)1e-6, state.rho));
                                    }
                                };

                                RealType dt_dx = dt_r * invDx;

                                // X-Fluxes
                                RealType fxL_rho = 0.0, fxL_rhoux = 0.0, fxL_rhouy = 0.0, fxL_rhouz = 0.0, fxL_E = 0.0;
                                RealType fxL_alpha1 = 0.0, fxL_alpha2 = 0.0, fxL_arho1 = 0.0, fxL_arho2 = 0.0, fxL_v_face = 0.0;

                                {
                                    auto sL2 = sampleStateInternalIDW(gx - 2, gy, gz, gx, gy, gz, 0);
                                    auto sL1 = sampleStateInternalIDW(gx - 1, gy, gz, gx, gy, gz, 0);
                                    auto sR1 = sC;
                                    auto sR2 = sampleStateInternalIDW(gx + 1, gy, gz, gx, gy, gz, 0);
                                    auto fxL = get_f(reconstruct<RealType, IsMultiMaterial>(sL2, sL1, sR1, (RealType)0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted),
                                                     reconstruct<RealType, IsMultiMaterial>(sL1, sR1, sR2, (RealType)-0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted), 0);
                                    fxL_rho = fxL.rho; fxL_rhoux = fxL.rhoux; fxL_rhouy = fxL.rhouy; fxL_rhouz = fxL.rhouz; fxL_E = fxL.E;
                                    fxL_v_face = fxL.v_face;
                                    if constexpr (IsMultiMaterial) {
                                        fxL_alpha1 = fxL.alpha1; fxL_alpha2 = fxL.alpha2; fxL_arho1 = fxL.arho1; fxL_arho2 = fxL.arho2;
                                    }
                                }

                                RealType fxR_rho = 0.0, fxR_rhoux = 0.0, fxR_rhouy = 0.0, fxR_rhouz = 0.0, fxR_E = 0.0;
                                RealType fxR_alpha1 = 0.0, fxR_alpha2 = 0.0, fxR_arho1 = 0.0, fxR_arho2 = 0.0, fxR_v_face = 0.0;

                                {
                                    auto sL2 = sampleStateInternalIDW(gx - 1, gy, gz, gx, gy, gz, 0);
                                    auto sL1 = sC;
                                    auto sR1 = sampleStateInternalIDW(gx + 1, gy, gz, gx, gy, gz, 0);
                                    auto sR2 = sampleStateInternalIDW(gx + 2, gy, gz, gx, gy, gz, 0);
                                    auto fxR = get_f(reconstruct<RealType, IsMultiMaterial>(sL2, sL1, sR1, (RealType)0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted),
                                                     reconstruct<RealType, IsMultiMaterial>(sL1, sR1, sR2, (RealType)-0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted), 0);
                                    fxR_rho = fxR.rho; fxR_rhoux = fxR.rhoux; fxR_rhouy = fxR.rhouy; fxR_rhouz = fxR.rhouz; fxR_E = fxR.E;
                                    fxR_v_face = fxR.v_face;
                                    if constexpr (IsMultiMaterial) {
                                        fxR_alpha1 = fxR.alpha1; fxR_alpha2 = fxR.alpha2; fxR_arho1 = fxR.arho1; fxR_arho2 = fxR.arho2;
                                    }
                                }

                                // Y-Fluxes
                                RealType fyB_rho = 0.0, fyB_rhoux = 0.0, fyB_rhouy = 0.0, fyB_rhouz = 0.0, fyB_E = 0.0;
                                RealType fyB_alpha1 = 0.0, fyB_alpha2 = 0.0, fyB_arho1 = 0.0, fyB_arho2 = 0.0, fyB_v_face = 0.0;

                                {
                                    auto sL2 = sampleStateInternalIDW(gx, gy - 2, gz, gx, gy, gz, 1);
                                    auto sL1 = sampleStateInternalIDW(gx, gy - 1, gz, gx, gy, gz, 1);
                                    auto sR1 = sC;
                                    auto sR2 = sampleStateInternalIDW(gx, gy + 1, gz, gx, gy, gz, 1);
                                    auto fyB = get_f(reconstruct<RealType, IsMultiMaterial>(sL2, sL1, sR1, (RealType)0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted),
                                                     reconstruct<RealType, IsMultiMaterial>(sL1, sR1, sR2, (RealType)-0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted), 1);
                                    fyB_rho = fyB.rho; fyB_rhoux = fyB.rhoux; fyB_rhouy = fyB.rhouy; fyB_rhouz = fyB.rhouz; fyB_E = fyB.E;
                                    fyB_v_face = fyB.v_face;
                                    if constexpr (IsMultiMaterial) {
                                        fyB_alpha1 = fyB.alpha1; fyB_alpha2 = fyB.alpha2; fyB_arho1 = fyB.arho1; fyB_arho2 = fyB.arho2;
                                    }
                                }

                                RealType fyT_rho = 0.0, fyT_rhoux = 0.0, fyT_rhouy = 0.0, fyT_rhouz = 0.0, fyT_E = 0.0;
                                RealType fyT_alpha1 = 0.0, fyT_alpha2 = 0.0, fyT_arho1 = 0.0, fyT_arho2 = 0.0, fyT_v_face = 0.0;

                                {
                                    auto sL2 = sampleStateInternalIDW(gx, gy - 1, gz, gx, gy, gz, 1);
                                    auto sL1 = sC;
                                    auto sR1 = sampleStateInternalIDW(gx, gy + 1, gz, gx, gy, gz, 1);
                                    auto sR2 = sampleStateInternalIDW(gx, gy + 2, gz, gx, gy, gz, 1);
                                    auto fyT = get_f(reconstruct<RealType, IsMultiMaterial>(sL2, sL1, sR1, (RealType)0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted),
                                                     reconstruct<RealType, IsMultiMaterial>(sL1, sR1, sR2, (RealType)-0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted), 1);
                                    fyT_rho = fyT.rho; fyT_rhoux = fyT.rhoux; fyT_rhouy = fyT.rhouy; fyT_rhouz = fyT.rhouz; fyT_E = fyT.E;
                                    fyT_v_face = fyT.v_face;
                                    if constexpr (IsMultiMaterial) {
                                        fyT_alpha1 = fyT.alpha1; fyT_alpha2 = fyT.alpha2; fyT_arho1 = fyT.arho1; fyT_arho2 = fyT.arho2;
                                    }
                                }

                                // Z-Fluxes
                                RealType fzD_rho = 0.0, fzD_rhoux = 0.0, fzD_rhouy = 0.0, fzD_rhouz = 0.0, fzD_E = 0.0;
                                RealType fzD_alpha1 = 0.0, fzD_alpha2 = 0.0, fzD_arho1 = 0.0, fzD_arho2 = 0.0, fzD_v_face = 0.0;

                                {
                                    auto sL2 = sampleStateInternalIDW(gx, gy, gz - 2, gx, gy, gz, 2);
                                    auto sL1 = sampleStateInternalIDW(gx, gy, gz - 1, gx, gy, gz, 2);
                                    auto sR1 = sC;
                                    auto sR2 = sampleStateInternalIDW(gx, gy, gz + 1, gx, gy, gz, 2);
                                    auto fzD = get_f(reconstruct<RealType, IsMultiMaterial>(sL2, sL1, sR1, (RealType)0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted),
                                                     reconstruct<RealType, IsMultiMaterial>(sL1, sR1, sR2, (RealType)-0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted), 2);
                                    fzD_rho = fzD.rho; fzD_rhoux = fzD.rhoux; fzD_rhouy = fzD.rhouy; fzD_rhouz = fzD.rhouz; fzD_E = fzD.E;
                                    fzD_v_face = fzD.v_face;
                                    if constexpr (IsMultiMaterial) {
                                        fzD_alpha1 = fzD.alpha1; fzD_alpha2 = fzD.alpha2; fzD_arho1 = fzD.arho1; fzD_arho2 = fzD.arho2;
                                    }
                                }

                                RealType fzU_rho = 0.0, fzU_rhoux = 0.0, fzU_rhouy = 0.0, fzU_rhouz = 0.0, fzU_E = 0.0;
                                RealType fzU_alpha1 = 0.0, fzU_alpha2 = 0.0, fzU_arho1 = 0.0, fzU_arho2 = 0.0, fzU_v_face = 0.0;

                                {
                                    auto sL2 = sampleStateInternalIDW(gx, gy, gz - 1, gx, gy, gz, 2);
                                    auto sL1 = sC;
                                    auto sR1 = sampleStateInternalIDW(gx, gy, gz + 1, gx, gy, gz, 2);
                                    auto sR2 = sampleStateInternalIDW(gx, gy, gz + 2, gx, gy, gz, 2);
                                    auto fzU = get_f(reconstruct<RealType, IsMultiMaterial>(sL2, sL1, sR1, (RealType)0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted),
                                                     reconstruct<RealType, IsMultiMaterial>(sL1, sR1, sR2, (RealType)-0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted), 2);
                                    fzU_rho = fzU.rho; fzU_rhoux = fzU.rhoux; fzU_rhouy = fzU.rhouy; fzU_rhouz = fzU.rhouz; fzU_E = fzU.E;
                                    fzU_v_face = fzU.v_face;
                                    if constexpr (IsMultiMaterial) {
                                        fzU_alpha1 = fzU.alpha1; fzU_alpha2 = fzU.alpha2; fzU_arho1 = fzU.arho1; fzU_arho2 = fzU.arho2;
                                    }
                                }

                                u.rho[idx] -= dt_dx * (fxR_rho - fxL_rho + fyT_rho - fyB_rho + fzU_rho - fzD_rho);
                                u.rhoux[idx] -= dt_dx * (fxR_rhoux - fxL_rhoux + fyT_rhoux - fyB_rhoux + fzU_rhoux - fzD_rhoux);
                                u.rhouy[idx] -= dt_dx * (fxR_rhouy - fxL_rhouy + fyT_rhouy - fyB_rhouy + fzU_rhouy - fzD_rhouy);
                                u.rhouz[idx] -= dt_dx * (fxR_rhouz - fxL_rhouz + fyT_rhouz - fyB_rhouz + fzU_rhouz - fzD_rhouz);
                                u.E[idx] -= dt_dx * (fxR_E - fxL_E + fyT_E - fyB_E + fzU_E - fzD_E);

                                if constexpr (IsMultiMaterial) {
                                    u.alpha1[idx] -= dt_dx * (fxR_alpha1 - fxL_alpha1 + fyT_alpha1 - fyB_alpha1 + fzU_alpha1 - fzD_alpha1);
                                    u.alpha2[idx] -= dt_dx * (fxR_alpha2 - fxL_alpha2 + fyT_alpha2 - fyB_alpha2 + fzU_alpha2 - fzD_alpha2);
                                    
                                    RealType div_u = fxR_v_face - fxL_v_face + fyT_v_face - fyB_v_face + fzU_v_face - fzD_v_face;
                                    u.alpha1[idx] += dt_dx * sC.alpha1 * div_u;
                                    u.alpha2[idx] += dt_dx * sC.alpha2 * div_u;

                                    u.arho1[idx] -= dt_dx * (fxR_arho1 - fxL_arho1 + fyT_arho1 - fyB_arho1 + fzU_arho1 - fzD_arho1);
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
                        RealType z_c = (RealType)zmin + ((RealType)gz + (RealType)0.5) * (RealType)cellSize;
                        for (int j = 0; j < TILE_SIZE_3D; ++j) {
                            int gy = ty * TILE_SIZE_3D + j;
                            RealType y_c = (RealType)ymin + ((RealType)gy + (RealType)0.5) * (RealType)cellSize;
                            for (int i = 0; i < TILE_SIZE_3D; ++i) {
                                int gx = tx * TILE_SIZE_3D + i;
                                RealType x_c = (RealType)xmin + ((RealType)gx + (RealType)0.5) * (RealType)cellSize;
                                int c_idx = i + j * TILE_SIZE_3D + k * TILE_SIZE_3D * TILE_SIZE_3D;

                                RealType tmp_alpha1 = u.alpha1[c_idx];
                                RealType tmp_alpha2 = u.alpha2[c_idx];
                                RealType tmp_arho1 = u.arho1[c_idx];
                                RealType tmp_arho2 = u.arho2[c_idx];
                                RealType dF = MultiMat::computeProgrammedBurn(
                                    (RealType)currentTime, (RealType)dt, x_c, y_c, z_c,
                                    (RealType)currentMaterials.det_vel, (RealType)0.0, (RealType)detX, (RealType)detY, (RealType)detZ,
                                    (RealType)cellSize, (RealType)currentMaterials.products.rho0,
                                    tmp_alpha1, tmp_alpha2, tmp_arho1, tmp_arho2
                                );
                                u.alpha1[c_idx] = tmp_alpha1;
                                u.alpha2[c_idx] = tmp_alpha2;
                                u.arho1[c_idx] = tmp_arho1;
                                u.arho2[c_idx] = tmp_arho2;
                                if (currentMaterials.detonation_energy > 0.0 && dF > (RealType)0.0) {
                                    RealType rho_expl = u.arho1[c_idx] + u.arho2[c_idx];
                                    u.E[c_idx] += dF * rho_expl * (RealType)currentMaterials.detonation_energy;
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
                RealType ke = (RealType)0.5 * s.rho[i] * (s.ux[i]*s.ux[i] + s.uy[i]*s.uy[i] + s.uz[i]*s.uz[i]);
                RealType e_int = u_E - ke;

                if constexpr (IsMultiMaterial) {
                    s.alpha1[i] = std::clamp(u.alpha1[i], (RealType)0.0, (RealType)1.0);
                    s.alpha2[i] = std::clamp(u.alpha2[i], (RealType)0.0, (RealType)1.0);
                    if (s.alpha1[i] + s.alpha2[i] > (RealType)1.0) {
                        RealType sum = s.alpha1[i] + s.alpha2[i];
                        s.alpha1[i] /= sum;
                        s.alpha2[i] /= sum;
                    }
                    s.arho1[i] = std::clamp(u.arho1[i], (RealType)0.0, s.rho[i]);
                    s.arho2[i] = std::clamp(u.arho2[i], (RealType)0.0, s.rho[i]);
                    if (s.arho1[i] + s.arho2[i] > s.rho[i]) {
                        RealType sum = s.arho1[i] + s.arho2[i];
                        s.arho1[i] = (s.arho1[i] / sum) * s.rho[i];
                        s.arho2[i] = (s.arho2[i] / sum) * s.rho[i];
                    }
                    RealType p_val = MultiMat::getMixturePressure(e_int, s.rho[i], s.alpha1[i], s.alpha2[i], s.arho1[i], s.arho2[i], gamma_r, currentMaterials.products, currentMaterials.unreacted);
                    if (std::isnan(p_val) || std::isinf(p_val) || p_val < (RealType)1e-8) {
                        bad = true;
                    } else {
                        s.p[i] = p_val;
                        u.alpha1[i] = s.alpha1[i];
                        u.alpha2[i] = s.alpha2[i];
                        u.arho1[i] = s.arho1[i];
                        u.arho2[i] = s.arho2[i];
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
                u.rho[i] = (RealType)ambient_rho;
                u.rhoux[i] = 0.0;
                u.rhouy[i] = 0.0;
                u.rhouz[i] = 0.0;
                u.E[i] = (RealType)getEnergy3D<IsMultiMaterial>(ambient_p, ambient_rho, temp_s, gamma, currentMaterials.products, currentMaterials.unreacted);
                if constexpr (IsMultiMaterial) {
                    u.alpha1[i] = 0.0; u.alpha2[i] = 0.0;
                    u.arho1[i] = 0.0; u.arho2[i] = 0.0;
                }
                s.floor_status[i] = 1;
            } else {
                s.floor_status[i] = 0;
            }

            if (!geom_pool.empty() && geom_pool[t].cells[i].is_boundary) {
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
                u.rho[i] = (RealType)ambient_rho;
                u.rhoux[i] = 0.0;
                u.rhouy[i] = 0.0;
                u.rhouz[i] = 0.0;
                u.E[i] = (RealType)getEnergy3D<IsMultiMaterial>(ambient_p, ambient_rho, temp_s, gamma, currentMaterials.products, currentMaterials.unreacted);
                if constexpr (IsMultiMaterial) {
                    u.alpha1[i] = 0.0; u.alpha2[i] = 0.0;
                    u.arho1[i] = 0.0; u.arho2[i] = 0.0;
                }
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
                RealType ke = (RealType)0.5 * s.rho[i] * (s.ux[i]*s.ux[i] + s.uy[i]*s.uy[i] + s.uz[i]*s.uz[i]);
                RealType total_E;
                if constexpr (IsMultiMaterial) {
                    total_E = (RealType)MultiMat::getMixtureEnergy((double)s.p[i], (double)s.rho[i], (double)s.alpha1[i], (double)s.alpha2[i], (double)s.arho1[i], (double)s.arho2[i], gamma, currentMaterials.products, currentMaterials.unreacted) + ke;
                } else {
                    total_E = s.p[i] / (gamma - (RealType)1.0) + ke;
                }
                u.E[i] = total_E;
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
        computeFluxes(dt, U_pool);
    } else if (temporalOrder == 2) {
        #pragma omp parallel for
        for (int t = 0; t < (int)states_pool.size(); ++t) {
            dU_pool[t] = U_pool[t];
        }
        computeFluxes(dt, U_pool);
        updatePrimitiveFromConservative();
        applyBC();
        
        computeFluxes(dt, U_pool);
        average_U(dU_pool, 0.5, 0.5);
    } else { // Williamson Low-Storage RK3
        const RealType A[3] = { (RealType)0.0, (RealType)(-5.0/9.0), (RealType)(-153.0/128.0) };
        const RealType B[3] = { (RealType)(1.0/3.0), (RealType)(15.0/16.0), (RealType)(8.0/15.0) };

        for (int stage = 0; stage < 3; ++stage) {
            #pragma omp parallel for
            for (int t = 0; t < (int)states_pool.size(); ++t) {
                if (!active_tiles[t]) continue;
                auto& du = dU_pool[t];
                RealType a = A[stage];
                for (int i = 0; i < TILE_CELLS_3D; ++i) {
                    du.rho[i] = a * du.rho[i];
                    du.rhoux[i] = a * du.rhoux[i];
                    du.rhouy[i] = a * du.rhouy[i];
                    du.rhouz[i] = a * du.rhouz[i];
                    du.E[i] = a * du.E[i];
                    if constexpr (IsMultiMaterial) {
                        du.alpha1[i] = a * du.alpha1[i];
                        du.alpha2[i] = a * du.alpha2[i];
                        du.arho1[i] = a * du.arho1[i];
                        du.arho2[i] = a * du.arho2[i];
                    }
                }
            }

            computeFluxes(dt, dU_pool);

            #pragma omp parallel for
            for (int t = 0; t < (int)states_pool.size(); ++t) {
                if (!active_tiles[t]) continue;
                auto& u = U_pool[t];
                const auto& du = dU_pool[t];
                RealType b = B[stage];
                for (int i = 0; i < TILE_CELLS_3D; ++i) {
                    u.rho[i] += b * du.rho[i];
                    u.rhoux[i] += b * du.rhoux[i];
                    u.rhouy[i] += b * du.rhouy[i];
                    u.rhouz[i] += b * du.rhouz[i];
                    u.E[i] += b * du.E[i];
                    if constexpr (IsMultiMaterial) {
                        u.alpha1[i] += b * du.alpha1[i];
                        u.alpha2[i] += b * du.alpha2[i];
                        u.arho1[i] += b * du.arho1[i];
                        u.arho2[i] += b * du.arho2[i];
                    }
                }
            }

            updatePrimitiveFromConservative();
            applyBC();
        }
    }

    if constexpr (IsMultiMaterial) {
        applyProgrammedBurn(dt);
    }

    updatePrimitiveFromConservative();
    applyBC();

    #pragma omp parallel for
    for (int t = 0; t < (int)states_pool.size(); ++t) {
        if (!active_tiles[t]) continue;
        auto& tile = states_pool[t];
        for (int i = 0; i < TILE_CELLS_3D; ++i) {
            RealType op = tile.p[i] - (RealType)ambient_p;
            if (op < (RealType)0.0) op = (RealType)0.0;
            if (op > tile.peak_overpressure[i]) {
                tile.peak_overpressure[i] = op;
            }
            tile.running_impulse[i] += op * (RealType)dt;
            if (tile.running_impulse[i] > tile.peak_impulse[i]) {
                tile.peak_impulse[i] = tile.running_impulse[i];
            }
        }
    }

    currentTime += dt;
    updateActiveRegions();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::applyBC() {}

template <typename RealType, bool IsMultiMaterial>
double CFDSolver3DImpl<RealType, IsMultiMaterial>::computeStepSize(double cfl) const {
    RealType max_s = (RealType)1e-6;
    #pragma omp parallel for reduction(max:max_s)
    for (int t = 0; t < (int)states_pool.size(); ++t) {
        if (!active_tiles[t]) continue;
        const auto& tile = states_pool[t];
        for (int i = 0; i < TILE_CELLS_3D; ++i) {
            using std::sqrt;
            using std::max;
            RealType u_mag = sqrt(tile.ux[i]*tile.ux[i] + tile.uy[i]*tile.uy[i] + tile.uz[i]*tile.uz[i]);
            RealType c;
            if constexpr (IsMultiMaterial) {
                c = MultiMat::getMixtureSoundSpeed(tile.p[i], tile.rho[i], tile.alpha1[i], tile.alpha2[i], tile.arho1[i], tile.arho2[i], (RealType)gamma, currentMaterials.products, currentMaterials.unreacted);
            } else {
                c = sqrt((RealType)gamma * tile.p[i] / max((RealType)1e-6, tile.rho[i]));
            }
            if (u_mag + c > max_s) {
                max_s = u_mag + c;
            }
        }
    }
    return cfl * cellSize / (double)max_s;
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
std::vector<float> CFDSolver3DImpl<RealType, IsMultiMaterial>::getCellValues(int gx, int gy, int gz) const {
    auto s = sampleState(gx, gy, gz);
    std::vector<float> vals(10, 0.0f);
    vals[0] = (float)s.p; vals[1] = (float)s.rho;
    vals[2] = (float)std::sqrt(s.ux*s.ux + s.uy*s.uy + s.uz*s.uz);
    vals[3] = (float)(s.E / std::max(s.rho, 1e-6));
    if constexpr (IsMultiMaterial) { vals[4] = (float)s.alpha1; vals[5] = (float)s.alpha2; vals[6] = (float)(1.0 - s.alpha1 - s.alpha2); }
    else { vals[6] = 1.0f; }

    if (!geom_pool.empty()) {
        int t = (gx >> 3) + (gy >> 3) * n_tiles_x + (gz >> 3) * n_tiles_x * n_tiles_y;
        int c = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;
        vals[7] = geom_pool[t].cells[c].is_boundary ? 1.0f : 0.0f;
    }
    vals[8] = (float)s.peak_overpressure;
    vals[9] = (float)s.peak_impulse;
    return vals;
}

template <typename RealType, bool IsMultiMaterial>
std::vector<float> CFDSolver3DImpl<RealType, IsMultiMaterial>::extractSlice(const Slice3D& slice) const {
    std::vector<float> data;
    std::string qty = (slice.quantities.empty()) ? "pressure" : slice.quantities[0];
    int stride = slice.stride > 0 ? slice.stride : 1;

    auto is_solid = [&](int cx, int cy, int cz) {
        if (geom_pool.empty()) return false;
        if (cx < 0 || cx >= nx || cy < 0 || cy >= ny || cz < 0 || cz >= nz) return false;
        int t = (cx >> 3) + (cy >> 3) * n_tiles_x + (cz >> 3) * n_tiles_x * n_tiles_y;
        int c = (cx & 7) + (cy & 7) * 8 + (cz & 7) * 64;
        return geom_pool[t].cells[c].is_boundary;
    };

    auto getVal = [&](const CellState3D<IsMultiMaterial>& s, int gx_c, int gy_c, int gz_c) -> float {
        if (qty == "solid" || qty == "solid_cells") {
            return is_solid(gx_c, gy_c, gz_c) ? 1.0f : 0.0f;
        }
        if (qty == "density" || qty == "rho") return (float)s.rho;
        if (qty == "velocity" || qty == "speed") return (float)std::sqrt(s.ux*s.ux + s.uy*s.uy + s.uz*s.uz);
        if (qty == "energy" || qty == "internal_energy") return (float)(s.E / std::max(s.rho, 1e-6));
        if (qty == "species1" || qty == "alpha1") return (float)s.alpha1;
        if (qty == "species2" || qty == "alpha2") return (float)s.alpha2;
        if (qty == "species3") return (float)(1.0 - s.alpha1 - s.alpha2);
        if (qty == "overpressure" || qty == "peak_overpressure") return (float)s.peak_overpressure;
        if (qty == "impulse" || qty == "peak_impulse") return (float)s.peak_impulse;
        return (float)s.p;
    };

    if (slice.axis == "xy") {
        int gz = std::clamp((int)((slice.offset - zmin) / cellSize), 0, nz - 1);
        int out_nx = (nx + stride - 1) / stride;
        int out_ny = (ny + stride - 1) / stride;
        data.resize(out_nx * out_ny);
        for (int gy = 0; gy < out_ny; ++gy) {
            for (int gx = 0; gx < out_nx; ++gx) {
                int gxc = gx * stride;
                int gyc = gy * stride;
                data[gx + gy * out_nx] = getVal(sampleState(gxc, gyc, gz), gxc, gyc, gz);
            }
        }
    } else if (slice.axis == "xz") {
        int gy = std::clamp((int)((slice.offset - ymin) / cellSize), 0, ny - 1);
        int out_nx = (nx + stride - 1) / stride;
        int out_nz = (nz + stride - 1) / stride;
        data.resize(out_nx * out_nz);
        for (int gz = 0; gz < out_nz; ++gz) {
            for (int gx = 0; gx < out_nx; ++gx) {
                int gxc = gx * stride;
                int gzc = gz * stride;
                data[gx + gz * out_nx] = getVal(sampleState(gxc, gy, gzc), gxc, gy, gzc);
            }
        }
    } else if (slice.axis == "yz") {
        int gx = std::clamp((int)((slice.offset - xmin) / cellSize), 0, nx - 1);
        int out_ny = (ny + stride - 1) / stride;
        int out_nz = (nz + stride - 1) / stride;
        data.resize(out_ny * out_nz);
        for (int gz = 0; gz < out_nz; ++gz) {
            for (int gy = 0; gy < out_ny; ++gy) {
                int gyc = gy * stride;
                int gzc = gz * stride;
                data[gy + gz * out_ny] = getVal(sampleState(gx, gyc, gzc), gx, gyc, gzc);
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
                temp_s.alpha1 = 0.0; temp_s.alpha2 = 0.0;
                temp_s.arho1 = 0.0; temp_s.arho2 = 0.0;
                tile.alpha1[i] = 0.0;
                tile.alpha2[i] = 0.0;
                tile.arho1[i] = 0.0;
                tile.arho2[i] = 0.0;
            }
            tile.floor_status[i] = 0;
            tile.peak_overpressure[i] = 0.0;
            tile.running_impulse[i] = 0.0;
            tile.peak_impulse[i] = 0.0;

            u_tile.rho[i] = (RealType)amb_rho;
            u_tile.rhoux[i] = 0.0;
            u_tile.rhouy[i] = 0.0;
            u_tile.rhouz[i] = 0.0;
            u_tile.E[i] = (RealType)getEnergy3D<IsMultiMaterial>(amb_p, amb_rho, temp_s, gamma, currentMaterials.products, currentMaterials.unreacted);
            if constexpr (IsMultiMaterial) {
                u_tile.alpha1[i] = 0.0;
                u_tile.alpha2[i] = 0.0;
                u_tile.arho1[i] = 0.0;
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
        tile.p[c_idx] = (RealType)s.p;
        tile.alpha1[c_idx] = (RealType)s.alpha1; tile.alpha2[c_idx] = (RealType)s.alpha2;
        tile.arho1[c_idx] = (RealType)s.arho1; tile.arho2[c_idx] = (RealType)s.arho2;
        tile.peak_overpressure[c_idx] = 0.0;
        tile.running_impulse[c_idx] = 0.0;
        tile.peak_impulse[c_idx] = 0.0;
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
    tile.p[c_idx] = (RealType)s.p;
    tile.peak_overpressure[c_idx] = 0.0;
    tile.running_impulse[c_idx] = 0.0;
    tile.peak_impulse[c_idx] = 0.0;
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
            RealType ke = (RealType)0.5 * state_tile.rho[i] * (state_tile.ux[i]*state_tile.ux[i] + state_tile.uy[i]*state_tile.uy[i] + state_tile.uz[i]*state_tile.uz[i]);
            RealType total_E;
            if constexpr (IsMultiMaterial) {
                total_E = (RealType)MultiMat::getMixtureEnergy((double)state_tile.p[i], (double)state_tile.rho[i], (double)state_tile.alpha1[i], (double)state_tile.alpha2[i], (double)state_tile.arho1[i], (double)state_tile.arho2[i], gamma, currentMaterials.products, currentMaterials.unreacted) + ke;
            } else {
                total_E = state_tile.p[i] / (gamma - (RealType)1.0) + ke;
            }
            u_tile.E[i] = total_E;
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

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::setGauges(const std::vector<Gauge3D>& gauges) {
    cpu_gauges = gauges;
    cpu_gauge_times.clear();
    cpu_gauge_values.clear();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::recordGaugesAsync(double t) {
    if (cpu_gauges.empty()) return;
    cpu_gauge_times.push_back(t);
    for (const auto& gauge : cpu_gauges) {
        auto vals = sampleGauge(gauge);
        cpu_gauge_values.insert(cpu_gauge_values.end(), vals.begin(), vals.end());
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::retrieveNewGaugeSamples(std::vector<double>& times, std::vector<float>& values) {
    times = std::move(cpu_gauge_times);
    values = std::move(cpu_gauge_values);
    cpu_gauge_times.clear();
    cpu_gauge_values.clear();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::setGeometry(const std::string& stl_filepath, const std::string& geometry_hash, const std::string& voxelization_method,
                                                             const std::atomic<bool>* terminate_flag,
                                                             std::function<void(double)> progress_callback) {
    voxelize_stl(
        stl_filepath,
        geometry_hash,
        voxelization_method,
        geom_pool,
        nx, ny, nz,
        cellSize,
        xmin, ymin, zmin,
        n_tiles_x, n_tiles_y, n_tiles_z,
        terminate_flag,
        progress_callback
    );
}

template <typename RealType, bool IsMultiMaterial>
std::pair<double, double> CFDSolver3DImpl<RealType, IsMultiMaterial>::getConservationTotals() const {
    double total_mass = 0.0;
    double total_energy = 0.0;
    double cell_vol = cellSize * cellSize * cellSize;

    int total_tiles = n_tiles_x * n_tiles_y * n_tiles_z;
    #pragma omp parallel for reduction(+:total_mass,total_energy)
    for (int t = 0; t < total_tiles; ++t) {
        const auto& tile = U_pool[t];
        for (int c = 0; c < TILE_CELLS_3D; ++c) {
            total_mass += tile.rho[c] * cell_vol;
            total_energy += tile.E[c] * cell_vol;
        }
    }
    return {total_mass, total_energy};
}

template class CFDSolver3DImpl<float, false>;
template class CFDSolver3DImpl<float, true>;
template class CFDSolver3DImpl<double, false>;
template class CFDSolver3DImpl<double, true>;
