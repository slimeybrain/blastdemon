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
void CFDSolver3DImpl<RealType, IsMultiMaterial>::setBoundaryConditions(BCType3D xmin, BCType3D xmax, BCType3D ymin, BCType3D ymax, BCType3D zmin, BCType3D zmax) {
    CFDSolver3DImplBase::setBoundaryConditions(xmin, xmax, ymin, ymax, zmin, zmax);
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

    const double deg2rad = 3.14159265358979323846 / 180.0;
    const double ax = charge.rot_x * deg2rad;
    const double ay = charge.rot_y * deg2rad;
    const double az = charge.rot_z * deg2rad;
    const double cx_rot = std::cos(ax), sx_rot = std::sin(ax);
    const double cy_rot = std::cos(ay), sy_rot = std::sin(ay);
    const double cz_rot = std::cos(az), sz_rot = std::sin(az);
    const bool has_rot = (charge.rot_x != 0.0 || charge.rot_y != 0.0 || charge.rot_z != 0.0);

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

                            int total_points = 64;
                            for (double ox : {-0.375, -0.125, 0.125, 0.375}) {
                                for (double oy : {-0.375, -0.125, 0.125, 0.375}) {
                                    for (double oz : {-0.375, -0.125, 0.125, 0.375}) {
                                        double px = x_c + ox * cellSize;
                                        double py = y_c + oy * cellSize;
                                        double pz = z_c + oz * cellSize;
                                        double dx = px - charge.x;
                                        double dy = py - charge.y;
                                        double dz = pz - charge.z;
                                        double x_loc = dx;
                                        double y_loc = dy;
                                        double z_loc = dz;
                                        if (has_rot) {
                                            double x1 = cz_rot * dx + sz_rot * dy;
                                            double y1 = -sz_rot * dx + cz_rot * dy;
                                            double z1 = dz;

                                            double x2 = cy_rot * x1 - sy_rot * z1;
                                            double y2 = y1;
                                            double z2 = sy_rot * x1 + cy_rot * z1;

                                            x_loc = x2;
                                            y_loc = cx_rot * y2 + sx_rot * z2;
                                            z_loc = -sx_rot * y2 + cx_rot * z2;
                                        }
                                        bool inside = false;
                                        if (charge.shape_type == 0) { // Sphere
                                            double dist_sq = dx*dx + dy*dy + dz*dz;
                                            if (dist_sq <= charge.radius * charge.radius) inside = true;
                                        } else if (charge.shape_type == 1) { // Block
                                            if (std::abs(x_loc) <= charge.lx*0.5 && std::abs(y_loc) <= charge.ly*0.5 && std::abs(z_loc) <= charge.lz*0.5) inside = true;
                                        } else if (charge.shape_type == 2) { // Cylinder
                                            double dr_sq = x_loc*x_loc + y_loc*y_loc;
                                            if (dr_sq <= charge.radius*charge.radius && std::abs(z_loc) <= charge.height*0.5) inside = true;
                                        }
                                        if (inside) points_inside++;
                                    }
                                }
                            }
                            double f_vol = (double)points_inside / (double)total_points;


                            if (f_vol > 0.0) {
                                tile_has_charge = true;
                                CellState3D<IsMultiMaterial> temp_s;
                                if constexpr (IsMultiMaterial) {
                                    tile.alpha1[c_idx] = 0.0;
                                    tile.alpha2[c_idx] = (RealType)f_vol;
                                    tile.arho1[c_idx] = 0.0;
                                    tile.arho2[c_idx] = tile.alpha2[c_idx] * (RealType)materials.unreacted.rho0;
                                    tile.rho[c_idx] = ((RealType)1.0 - (RealType)f_vol) * (RealType)ambient_rho + tile.arho2[c_idx];
                                    RealType p_solid = (RealType)MultiMat::getReferencePressure_Unreacted<RealType>(materials.unreacted);
                                    tile.p[c_idx] = ((RealType)1.0 - f_vol) * (RealType)ambient_p + f_vol * std::max((RealType)ambient_p, p_solid);
                                    temp_s.alpha1 = (double)tile.alpha1[c_idx]; temp_s.alpha2 = (double)tile.alpha2[c_idx];
                                    temp_s.arho1 = (double)tile.arho1[c_idx]; temp_s.arho2 = (double)tile.arho2[c_idx];
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

    active_tile_indices.clear();
    active_tile_indices.reserve(total_tiles);
    tile_is_fully_interior.assign(total_tiles, 0);

    for (int tz = 0; tz < n_tiles_z; ++tz) {
        for (int ty = 0; ty < n_tiles_y; ++ty) {
            for (int tx = 0; tx < n_tiles_x; ++tx) {
                int t_idx = tx + ty * n_tiles_x + tz * n_tiles_x * n_tiles_y;
                if (!active_tiles[t_idx]) continue;
                active_tile_indices.push_back(t_idx);

                bool is_interior = (tx >= 2 && tx < n_tiles_x - 2 &&
                                    ty >= 2 && ty < n_tiles_y - 2 &&
                                    tz >= 2 && tz < n_tiles_z - 2);
                if (is_interior && !geom_pool.empty()) {
                    for (int dtz = -1; dtz <= 1 && is_interior; ++dtz) {
                        for (int dty = -1; dty <= 1 && is_interior; ++dty) {
                            for (int dtx = -1; dtx <= 1 && is_interior; ++dtx) {
                                int n_tidx = (tx + dtx) + (ty + dty) * n_tiles_x + (tz + dtz) * n_tiles_x * n_tiles_y;
                                for (int c = 0; c < TILE_CELLS_3D; ++c) {
                                    if (geom_pool[n_tidx].cells[c].is_boundary) {
                                        is_interior = false;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                tile_is_fully_interior[t_idx] = is_interior ? 1 : 0;
            }
        }
    }
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
void CFDSolver3DImpl<RealType, IsMultiMaterial>::getSliceDimensions(const Slice3D& slice, int& w, int& h, int& depth) const {
    int stride = slice.stride > 0 ? slice.stride : 1;
    depth = 1;
    int scale = 1;
    if (slice.axis == "xy" || slice.axis == "obstacles") {
        w = ((nx + stride - 1) / stride) * scale;
        h = ((ny + stride - 1) / stride) * scale;
    } else if (slice.axis == "xz") {
        w = ((nx + stride - 1) / stride) * scale;
        h = ((nz + stride - 1) / stride) * scale;
    } else if (slice.axis == "yz") {
        w = ((ny + stride - 1) / stride) * scale;
        h = ((nz + stride - 1) / stride) * scale;
    } else if (slice.axis == "volume") {
        int max_level = 0;
        int desired_factor = 1;
        int factor = desired_factor;
        while (factor > 1) {
            int test_w = ((nx + stride - 1) / stride) * factor;
            int test_h = ((ny + stride - 1) / stride) * factor;
            int test_d = ((nz + stride - 1) / stride) * factor;
            size_t test_voxels = (size_t)test_w * test_h * test_d;
            if (test_voxels <= 100000000ULL) break;
            factor /= 2;
        }
        if (factor < 1) factor = 1;

        w = ((nx + stride - 1) / stride) * factor;
        h = ((ny + stride - 1) / stride) * factor;
        depth = ((nz + stride - 1) / stride) * factor;
    } else {
        w = 0; h = 0; depth = 0;
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::computeFluxes(double dt, std::vector<ConservativeTile3D<RealType, IsMultiMaterial>>& target_pool) {
    RealType invDx = (RealType)(1.0 / cellSize);
    RealType gamma_r = (RealType)gamma;
    RealType dt_r = (RealType)dt;
    bool useAUSM = (currentFluxScheme == "AUSM+");
    int n_active = (int)active_tile_indices.size();

    #pragma omp parallel for schedule(guided)
    for (int a = 0; a < n_active; ++a) {
        int t_idx = active_tile_indices[a];
        int tx = t_idx % n_tiles_x;
        int ty = (t_idx / n_tiles_x) % n_tiles_y;
        int tz = t_idx / (n_tiles_x * n_tiles_y);

        auto& u = target_pool[t_idx];
        bool is_interior_tile = tile_is_fully_interior[t_idx];

        for (int k = 0; k < TILE_SIZE_3D; ++k) {
            int gz = tz * TILE_SIZE_3D + k;
            for (int j = 0; j < TILE_SIZE_3D; ++j) {
                int gy = ty * TILE_SIZE_3D + j;
                for (int i = 0; i < TILE_SIZE_3D; ++i) {
                    int gx = tx * TILE_SIZE_3D + i;
                    int idx = i + j * TILE_SIZE_3D + k * TILE_SIZE_3D * TILE_SIZE_3D;

                    bool is_boundary = false;
                    if (!geom_pool.empty() && !is_interior_tile) {
                        int c = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;
                        is_boundary = geom_pool[t_idx].cells[c].is_boundary;
                    }

                    if (!is_boundary) {
                        auto sC = sampleStateInternal(gx, gy, gz);

                        auto get_f = [&](const CellState3DT<RealType, IsMultiMaterial>& L, const CellState3DT<RealType, IsMultiMaterial>& R, int d) {
                            return useAUSM ? getAUSMPlusFlux3D<RealType, IsMultiMaterial>(L, R, d, gamma_r, currentMaterials.products, currentMaterials.unreacted) : getRusanovFlux3D<RealType, IsMultiMaterial>(L, R, d, gamma_r, currentMaterials.products, currentMaterials.unreacted);
                        };

                        RealType dt_dx = dt_r * invDx;

                        auto sample_func = [&](int tx_val, int ty_val, int tz_val, int qx_val, int qy_val, int qz_val, int dir_val) {
                            if (is_interior_tile) {
                                return sampleStateInternal(tx_val, ty_val, tz_val);
                            } else {
                                return sampleStateInternalIDW(tx_val, ty_val, tz_val, qx_val, qy_val, qz_val, dir_val);
                            }
                        };

                        // X-Fluxes
                        RealType fxL_rho = 0.0, fxL_rhoux = 0.0, fxL_rhouy = 0.0, fxL_rhouz = 0.0, fxL_E = 0.0;
                        RealType fxL_alpha1 = 0.0, fxL_alpha2 = 0.0, fxL_arho1 = 0.0, fxL_arho2 = 0.0, fxL_v_face = 0.0;

                        {
                            auto sL2 = sample_func(gx - 2, gy, gz, gx, gy, gz, 0);
                            auto sL1 = sample_func(gx - 1, gy, gz, gx, gy, gz, 0);
                            auto sR1 = sC;
                            auto sR2 = sample_func(gx + 1, gy, gz, gx, gy, gz, 0);
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
                            auto sL2 = sample_func(gx - 1, gy, gz, gx, gy, gz, 0);
                            auto sL1 = sC;
                            auto sR1 = sample_func(gx + 1, gy, gz, gx, gy, gz, 0);
                            auto sR2 = sample_func(gx + 2, gy, gz, gx, gy, gz, 0);
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
                            auto sL2 = sample_func(gx, gy - 2, gz, gx, gy, gz, 1);
                            auto sL1 = sample_func(gx, gy - 1, gz, gx, gy, gz, 1);
                            auto sR1 = sC;
                            auto sR2 = sample_func(gx, gy + 1, gz, gx, gy, gz, 1);
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
                            auto sL2 = sample_func(gx, gy - 1, gz, gx, gy, gz, 1);
                            auto sL1 = sC;
                            auto sR1 = sample_func(gx, gy + 1, gz, gx, gy, gz, 1);
                            auto sR2 = sample_func(gx, gy + 2, gz, gx, gy, gz, 1);
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
                            auto sL2 = sample_func(gx, gy, gz - 2, gx, gy, gz, 2);
                            auto sL1 = sample_func(gx, gy, gz - 1, gx, gy, gz, 2);
                            auto sR1 = sC;
                            auto sR2 = sample_func(gx, gy, gz + 1, gx, gy, gz, 2);
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
                            auto sL2 = sample_func(gx, gy, gz - 1, gx, gy, gz, 2);
                            auto sL1 = sC;
                            auto sR1 = sample_func(gx, gy, gz + 1, gx, gy, gz, 2);
                            auto sR2 = sample_func(gx, gy, gz + 2, gx, gy, gz, 2);
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

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::applyProgrammedBurn(double dt) {
    if constexpr (IsMultiMaterial) {
        int n_active = (int)active_tile_indices.size();
        #pragma omp parallel for schedule(guided)
        for (int a = 0; a < n_active; ++a) {
            int t_idx = active_tile_indices[a];
            int tx = t_idx % n_tiles_x;
            int ty = (t_idx / n_tiles_x) % n_tiles_y;
            int tz = t_idx / (n_tiles_x * n_tiles_y);
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

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::updatePrimitiveFromConservative() {
    RealType gamma_r = (RealType)gamma;
    int n_active = (int)active_tile_indices.size();

    #pragma omp parallel for schedule(guided)
    for (int a = 0; a < n_active; ++a) {
        int t = active_tile_indices[a];
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
struct PhysicalFlux3D {
    RealType rho, rhoux, rhouy, rhouz, E;
    RealType alpha1, alpha2, arho1, arho2;
    RealType v_face;
};

template <typename RealType, bool IsMultiMaterial>
PhysicalFlux3D<RealType, IsMultiMaterial> getPhysicalFlux(
    const typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial>& s, int dir, RealType gamma_val, 
    const MultiMat::JWLParams& products, const MultiMat::JWLParams& unreacted) {
    PhysicalFlux3D<RealType, IsMultiMaterial> f;
    RealType ke = (RealType)0.5 * s.rho * (s.ux*s.ux + s.uy*s.uy + s.uz*s.uz);
    RealType total_E;
    if constexpr (IsMultiMaterial) {
        total_E = (RealType)MultiMat::getMixtureEnergy((double)s.p, (double)s.rho, (double)s.alpha1, (double)s.alpha2, (double)s.arho1, (double)s.arho2, (double)gamma_val, products, unreacted) + ke;
    } else {
        total_E = s.p / (gamma_val - (RealType)1.0) + ke;
    }

    if (dir == 0) { // X
        f.rho = s.rho * s.ux;
        f.rhoux = s.rho * s.ux * s.ux + s.p;
        f.rhouy = s.rho * s.ux * s.uy;
        f.rhouz = s.rho * s.ux * s.uz;
        f.E = s.ux * (total_E + s.p);
        f.v_face = s.ux;
        if constexpr (IsMultiMaterial) {
            f.alpha1 = s.alpha1 * s.ux;
            f.alpha2 = s.alpha2 * s.ux;
            f.arho1 = s.arho1 * s.ux;
            f.arho2 = s.arho2 * s.ux;
        } else {
            f.alpha1 = 0; f.alpha2 = 0; f.arho1 = 0; f.arho2 = 0;
        }
    } else if (dir == 1) { // Y
        f.rho = s.rho * s.uy;
        f.rhoux = s.rho * s.uy * s.ux;
        f.rhouy = s.rho * s.uy * s.uy + s.p;
        f.rhouz = s.rho * s.uy * s.uz;
        f.E = s.uy * (total_E + s.p);
        f.v_face = s.uy;
        if constexpr (IsMultiMaterial) {
            f.alpha1 = s.alpha1 * s.uy;
            f.alpha2 = s.alpha2 * s.uy;
            f.arho1 = s.arho1 * s.uy;
            f.arho2 = s.arho2 * s.uy;
        } else {
            f.alpha1 = 0; f.alpha2 = 0; f.arho1 = 0; f.arho2 = 0;
        }
    } else { // Z
        f.rho = s.rho * s.uz;
        f.rhoux = s.rho * s.uz * s.ux;
        f.rhouy = s.rho * s.uz * s.uy;
        f.rhouz = s.rho * s.uz * s.uz + s.p;
        f.E = s.uz * (total_E + s.p);
        f.v_face = s.uz;
        if constexpr (IsMultiMaterial) {
            f.alpha1 = s.alpha1 * s.uz;
            f.alpha2 = s.alpha2 * s.uz;
            f.arho1 = s.arho1 * s.uz;
            f.arho2 = s.arho2 * s.uz;
        } else {
            f.alpha1 = 0; f.alpha2 = 0; f.arho1 = 0; f.arho2 = 0;
        }
    }
    return f;
}

template <typename RealType, bool IsMultiMaterial>
void computeTimeDerivative(
    const typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial>& sC,
    const typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial>& d_x,
    const typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial>& d_y,
    const typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial>& d_z,
    RealType gamma_r,
    typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial>& dW_dt) {
    
    dW_dt.rho = -(sC.ux * d_x.rho + sC.rho * d_x.ux +
                  sC.uy * d_y.rho + sC.rho * d_y.uy +
                  sC.uz * d_z.rho + sC.rho * d_z.uz);
                  
    dW_dt.ux = -(sC.ux * d_x.ux + sC.uy * d_y.ux + sC.uz * d_z.ux + (RealType)1.0 / sC.rho * d_x.p);
    dW_dt.uy = -(sC.ux * d_x.uy + sC.uy * d_y.uy + sC.uz * d_z.uy + (RealType)1.0 / sC.rho * d_y.p);
    dW_dt.uz = -(sC.ux * d_x.uz + sC.uy * d_y.uz + sC.uz * d_z.uz + (RealType)1.0 / sC.rho * d_z.p);
    
    dW_dt.p = -(sC.ux * d_x.p + sC.uy * d_y.p + sC.uz * d_z.p + gamma_r * sC.p * (d_x.ux + d_y.uy + d_z.uz));
    
    if constexpr (IsMultiMaterial) {
        dW_dt.alpha1 = -(sC.ux * d_x.alpha1 + sC.uy * d_y.alpha1 + sC.uz * d_z.alpha1) + sC.alpha1 * (d_x.ux + d_y.uy + d_z.uz);
        dW_dt.alpha2 = -(sC.ux * d_x.alpha2 + sC.uy * d_y.alpha2 + sC.uz * d_z.alpha2) + sC.alpha2 * (d_x.ux + d_y.uy + d_z.uz);
        
        dW_dt.arho1 = -(sC.ux * d_x.arho1 + sC.arho1 * d_x.ux +
                        sC.uy * d_y.arho1 + sC.arho1 * d_y.uy +
                        sC.uz * d_z.arho1 + sC.arho1 * d_z.uz);
        dW_dt.arho2 = dW_dt.rho - dW_dt.arho1;
    } else {
        dW_dt.alpha1 = 0; dW_dt.alpha2 = 0; dW_dt.arho1 = 0; dW_dt.arho2 = 0;
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::step(double dt) {
    int total_tiles = n_tiles_x * n_tiles_y * n_tiles_z;
    if (temporalOrder >= 2) {
        if (dU_pool.size() != (size_t)total_tiles) {
            dU_pool.resize(total_tiles);
        }
    }
    if (temporalOrder == 4) {
        if (states_pred.size() != (size_t)total_tiles) states_pred.resize(total_tiles);
        if (dW_dt_pool.size() != (size_t)total_tiles) dW_dt_pool.resize(total_tiles);
        if (states_int.size() != (size_t)total_tiles) states_int.resize(total_tiles);
    }

    auto copy_primitive_to_U = [&]() {
        int n_active = (int)active_tile_indices.size();
        #pragma omp parallel for schedule(guided)
        for (int a = 0; a < n_active; ++a) {
            int t = active_tile_indices[a];
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
        int n_active = (int)active_tile_indices.size();
        #pragma omp parallel for schedule(guided)
        for (int a = 0; a < n_active; ++a) {
            int t = active_tile_indices[a];
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
        int n_active = (int)active_tile_indices.size();
        #pragma omp parallel for schedule(guided)
        for (int a = 0; a < n_active; ++a) {
            int t = active_tile_indices[a];
            dU_pool[t] = U_pool[t];
        }
        computeFluxes(dt, U_pool);
        updatePrimitiveFromConservative();
        applyBC();
        
        computeFluxes(dt, U_pool);
        average_U(dU_pool, 0.5, 0.5);
    } else if (temporalOrder == 3) { // Williamson Low-Storage RK3
        const RealType A[3] = { (RealType)0.0, (RealType)(-5.0/9.0), (RealType)(-153.0/128.0) };
        const RealType B[3] = { (RealType)(1.0/3.0), (RealType)(15.0/16.0), (RealType)(8.0/15.0) };

        for (int stage = 0; stage < 3; ++stage) {
            int n_active = (int)active_tile_indices.size();
            #pragma omp parallel for schedule(guided)
            for (int a = 0; a < n_active; ++a) {
                int t = active_tile_indices[a];
                auto& du = dU_pool[t];
                RealType a_val = A[stage];
                for (int i = 0; i < TILE_CELLS_3D; ++i) {
                    du.rho[i] = a_val * du.rho[i];
                    du.rhoux[i] = a_val * du.rhoux[i];
                    du.rhouy[i] = a_val * du.rhouy[i];
                    du.rhouz[i] = a_val * du.rhouz[i];
                    du.E[i] = a_val * du.E[i];
                    if constexpr (IsMultiMaterial) {
                        du.alpha1[i] = a_val * du.alpha1[i];
                        du.alpha2[i] = a_val * du.alpha2[i];
                        du.arho1[i] = a_val * du.arho1[i];
                        du.arho2[i] = a_val * du.arho2[i];
                    }
                }
            }

            computeFluxes(dt, dU_pool);

            #pragma omp parallel for schedule(guided)
            for (int a = 0; a < n_active; ++a) {
                int t = active_tile_indices[a];
                auto& u = U_pool[t];
                const auto& du = dU_pool[t];
                RealType b_val = B[stage];
                for (int i = 0; i < TILE_CELLS_3D; ++i) {
                    u.rho[i] += b_val * du.rho[i];
                    u.rhoux[i] += b_val * du.rhoux[i];
                    u.rhouy[i] += b_val * du.rhouy[i];
                    u.rhouz[i] += b_val * du.rhouz[i];
                    u.E[i] += b_val * du.E[i];
                    if constexpr (IsMultiMaterial) {
                        u.alpha1[i] += b_val * du.alpha1[i];
                        u.alpha2[i] += b_val * du.alpha2[i];
                        u.arho1[i] += b_val * du.arho1[i];
                        u.arho2[i] += b_val * du.arho2[i];
                    }
                }
            }

            updatePrimitiveFromConservative();
            applyBC();
        }
    } else if (temporalOrder == 4) { // MUSCL-Hancock (2nd order)
        int total_tiles = n_tiles_x * n_tiles_y * n_tiles_z;
        #pragma omp parallel for schedule(static)
        for (int t = 0; t < total_tiles; ++t) {
            states_pred[t] = states_pool[t];
        }
        RealType gamma_r = (RealType)gamma;
        RealType invDx = (RealType)(1.0 / cellSize);
        int n_active = (int)active_tile_indices.size();

        #pragma omp parallel for schedule(guided)
        for (int a = 0; a < n_active; ++a) {
            int t = active_tile_indices[a];
            int tx = t % n_tiles_x;
            int ty = (t / n_tiles_x) % n_tiles_y;
            int tz = t / (n_tiles_x * n_tiles_y);
            
            auto& s_pred_tile = states_pred[t];
            bool is_interior_tile = tile_is_fully_interior[t];
            
            auto sample_func = [&](int tx_val, int ty_val, int tz_val, int qx_val, int qy_val, int qz_val, int dir_val) {
                if (is_interior_tile) {
                    return sampleStateInternal(tx_val, ty_val, tz_val);
                } else {
                    return sampleStateInternalIDW(tx_val, ty_val, tz_val, qx_val, qy_val, qz_val, dir_val);
                }
            };
            
            auto cons_to_prim = [&](RealType u_rho, RealType u_rhoux, RealType u_rhouy, RealType u_rhouz, RealType u_E,
                                    RealType& u_alpha1, RealType& u_alpha2, RealType& u_arho1, RealType& u_arho2,
                                    CellState3DT<RealType, IsMultiMaterial>& out_s) {
                bool bad = std::isnan(u_rho) || std::isinf(u_rho) || u_rho < (RealType)1e-8 ||
                           std::isnan(u_rhoux) || std::isinf(u_rhoux) ||
                           std::isnan(u_rhouy) || std::isinf(u_rhouy) ||
                           std::isnan(u_rhouz) || std::isinf(u_rhouz) ||
                           std::isnan(u_E) || std::isinf(u_E);

                if constexpr (IsMultiMaterial) {
                    bad = bad || std::isnan(u_alpha1) || std::isinf(u_alpha1) ||
                                std::isnan(u_alpha2) || std::isinf(u_alpha2) ||
                                std::isnan(u_arho1) || std::isinf(u_arho1) ||
                                std::isnan(u_arho2) || std::isinf(u_arho2);
                }

                if (!bad) {
                    out_s.rho = std::max(u_rho, (RealType)1e-8);
                    out_s.ux = u_rhoux / out_s.rho;
                    out_s.uy = u_rhouy / out_s.rho;
                    out_s.uz = u_rhouz / out_s.rho;
                    RealType ke = (RealType)0.5 * out_s.rho * (out_s.ux*out_s.ux + out_s.uy*out_s.uy + out_s.uz*out_s.uz);
                    RealType e_int = u_E - ke;

                    if constexpr (IsMultiMaterial) {
                        out_s.alpha1 = std::clamp(u_alpha1, (RealType)0.0, (RealType)1.0);
                        out_s.alpha2 = std::clamp(u_alpha2, (RealType)0.0, (RealType)1.0);
                        if (out_s.alpha1 + out_s.alpha2 > (RealType)1.0) {
                            RealType sum = out_s.alpha1 + out_s.alpha2;
                            out_s.alpha1 /= sum;
                            out_s.alpha2 /= sum;
                        }
                        out_s.arho1 = std::clamp(u_arho1, (RealType)0.0, out_s.rho);
                        out_s.arho2 = std::clamp(u_arho2, (RealType)0.0, out_s.rho);
                        if (out_s.arho1 + out_s.arho2 > out_s.rho) {
                            RealType sum = out_s.arho1 + out_s.arho2;
                            out_s.arho1 = (out_s.arho1 / sum) * out_s.rho;
                            out_s.arho2 = (out_s.arho2 / sum) * out_s.rho;
                        }
                        RealType p_val = MultiMat::getMixturePressure(e_int, out_s.rho, out_s.alpha1, out_s.alpha2, out_s.arho1, out_s.arho2, gamma_r, currentMaterials.products, currentMaterials.unreacted);
                        if (std::isnan(p_val) || std::isinf(p_val) || p_val < (RealType)1e-8) {
                            bad = true;
                        } else {
                            out_s.p = p_val;
                            u_alpha1 = out_s.alpha1;
                            u_alpha2 = out_s.alpha2;
                            u_arho1 = out_s.arho1;
                            u_arho2 = out_s.arho2;
                        }
                    } else {
                        RealType p_val = e_int * (gamma_r - (RealType)1.0);
                        if (std::isnan(p_val) || std::isinf(p_val) || p_val < (RealType)1e-8) {
                            bad = true;
                        } else {
                            out_s.p = p_val;
                        }
                    }
                }

                if (bad) {
                    out_s.rho = (RealType)ambient_rho;
                    out_s.ux = 0.0;
                    out_s.uy = 0.0;
                    out_s.uz = 0.0;
                    out_s.p = (RealType)ambient_p;
                    if constexpr (IsMultiMaterial) {
                        out_s.alpha1 = 0.0; out_s.alpha2 = 0.0;
                        out_s.arho1 = 0.0; out_s.arho2 = 0.0;
                    }
                }
            };

            for (int k = 0; k < TILE_SIZE_3D; ++k) {
                int gz = tz * TILE_SIZE_3D + k;
                for (int j = 0; j < TILE_SIZE_3D; ++j) {
                    int gy = ty * TILE_SIZE_3D + j;
                    for (int i = 0; i < TILE_SIZE_3D; ++i) {
                        int gx = tx * TILE_SIZE_3D + i;
                        int idx = i + j * TILE_SIZE_3D + k * TILE_SIZE_3D * TILE_SIZE_3D;
                        
                        bool is_boundary = false;
                        if (!geom_pool.empty() && !is_interior_tile) {
                            int c = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;
                            is_boundary = geom_pool[t].cells[c].is_boundary;
                        }
                        if (is_boundary) continue;
                        
                        auto sC = sampleStateInternal(gx, gy, gz);
                        
                        auto sX_L = sample_func(gx - 1, gy, gz, gx, gy, gz, 0);
                        auto sX_R = sample_func(gx + 1, gy, gz, gx, gy, gz, 0);
                        auto sY_B = sample_func(gx, gy - 1, gz, gx, gy, gz, 1);
                        auto sY_T = sample_func(gx, gy + 1, gz, gx, gy, gz, 1);
                        auto sZ_D = sample_func(gx, gy, gz - 1, gx, gy, gz, 2);
                        auto sZ_U = sample_func(gx, gy, gz + 1, gx, gy, gz, 2);
                        
                        auto W_xL = reconstruct<RealType, IsMultiMaterial>(sX_L, sC, sX_R, (RealType)-0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted);
                        auto W_xR = reconstruct<RealType, IsMultiMaterial>(sX_L, sC, sX_R, (RealType)0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted);
                        auto W_yB = reconstruct<RealType, IsMultiMaterial>(sY_B, sC, sY_T, (RealType)-0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted);
                        auto W_yT = reconstruct<RealType, IsMultiMaterial>(sY_B, sC, sY_T, (RealType)0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted);
                        auto W_zD = reconstruct<RealType, IsMultiMaterial>(sZ_D, sC, sZ_U, (RealType)-0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted);
                        auto W_zU = reconstruct<RealType, IsMultiMaterial>(sZ_D, sC, sZ_U, (RealType)0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted);
                        
                        auto F_L = getPhysicalFlux<RealType, IsMultiMaterial>(W_xL, 0, gamma_r, currentMaterials.products, currentMaterials.unreacted);
                        auto F_R = getPhysicalFlux<RealType, IsMultiMaterial>(W_xR, 0, gamma_r, currentMaterials.products, currentMaterials.unreacted);
                        auto G_B = getPhysicalFlux<RealType, IsMultiMaterial>(W_yB, 1, gamma_r, currentMaterials.products, currentMaterials.unreacted);
                        auto G_T = getPhysicalFlux<RealType, IsMultiMaterial>(W_yT, 1, gamma_r, currentMaterials.products, currentMaterials.unreacted);
                        auto H_D = getPhysicalFlux<RealType, IsMultiMaterial>(W_zD, 2, gamma_r, currentMaterials.products, currentMaterials.unreacted);
                        auto H_U = getPhysicalFlux<RealType, IsMultiMaterial>(W_zU, 2, gamma_r, currentMaterials.products, currentMaterials.unreacted);
                        
                        RealType dt_dx = (RealType)(0.5 * dt * invDx);
                        
                        RealType u_rho = sC.rho;
                        RealType u_rhoux = sC.rho * sC.ux;
                        RealType u_rhouy = sC.rho * sC.uy;
                        RealType u_rhouz = sC.rho * sC.uz;
                        RealType ke = (RealType)0.5 * sC.rho * (sC.ux*sC.ux + sC.uy*sC.uy + sC.uz*sC.uz);
                        RealType u_E;
                        if constexpr (IsMultiMaterial) {
                            u_E = MultiMat::getMixtureEnergy(sC.p, sC.rho, sC.alpha1, sC.alpha2, sC.arho1, sC.arho2, gamma_r, currentMaterials.products, currentMaterials.unreacted) + ke;
                        } else {
                            u_E = sC.p / (gamma_r - (RealType)1.0) + ke;
                        }
                        
                        u_rho -= dt_dx * (F_R.rho - F_L.rho + G_T.rho - G_B.rho + H_U.rho - H_D.rho);
                        u_rhoux -= dt_dx * (F_R.rhoux - F_L.rhoux + G_T.rhoux - G_B.rhoux + H_U.rhoux - H_D.rhoux);
                        u_rhouy -= dt_dx * (F_R.rhouy - F_L.rhouy + G_T.rhouy - G_B.rhouy + H_U.rhouy - H_D.rhouy);
                        u_rhouz -= dt_dx * (F_R.rhouz - F_L.rhouz + G_T.rhouz - G_B.rhouz + H_U.rhouz - H_D.rhouz);
                        u_E -= dt_dx * (F_R.E - F_L.E + G_T.E - G_B.E + H_U.E - H_D.E);
                        
                        RealType u_alpha1 = 0, u_alpha2 = 0, u_arho1 = 0, u_arho2 = 0;
                        if constexpr (IsMultiMaterial) {
                            u_alpha1 = sC.alpha1; u_alpha2 = sC.alpha2; u_arho1 = sC.arho1; u_arho2 = sC.arho2;
                            u_alpha1 -= dt_dx * (F_R.alpha1 - F_L.alpha1 + G_T.alpha1 - G_B.alpha1 + H_U.alpha1 - H_D.alpha1);
                            u_alpha2 -= dt_dx * (F_R.alpha2 - F_L.alpha2 + G_T.alpha2 - G_B.alpha2 + H_U.alpha2 - H_D.alpha2);
                            
                            RealType div_u = (W_xR.ux - W_xL.ux) + (W_yT.uy - W_yB.uy) + (W_zU.uz - W_zD.uz);
                            u_alpha1 += dt_dx * sC.alpha1 * div_u;
                            u_alpha2 += dt_dx * sC.alpha2 * div_u;
                            
                            u_arho1 -= dt_dx * (F_R.arho1 - F_L.arho1 + G_T.arho1 - G_B.arho1 + H_U.arho1 - H_D.arho1);
                            u_arho2 = u_rho - u_arho1;
                        }
                        
                        CellState3DT<RealType, IsMultiMaterial> pred_s;
                        cons_to_prim(u_rho, u_rhoux, u_rhouy, u_rhouz, u_E, u_alpha1, u_alpha2, u_arho1, u_arho2, pred_s);
                        
                        s_pred_tile.rho[idx] = pred_s.rho;
                        s_pred_tile.ux[idx] = pred_s.ux;
                        s_pred_tile.uy[idx] = pred_s.uy;
                        s_pred_tile.uz[idx] = pred_s.uz;
                        s_pred_tile.p[idx] = pred_s.p;
                        if constexpr (IsMultiMaterial) {
                            s_pred_tile.alpha1[idx] = pred_s.alpha1;
                            s_pred_tile.alpha2[idx] = pred_s.alpha2;
                            s_pred_tile.arho1[idx] = pred_s.arho1;
                            s_pred_tile.arho2[idx] = pred_s.arho2;
                        }
                    }
                }
            }
        }
        
        std::swap(states_pool, states_pred);
        computeFluxes(dt, U_pool);
        std::swap(states_pool, states_pred);

    } else if (temporalOrder == 5 || temporalOrder == 6) { // ADER-2 (5) and ADER-3 (6)
        int total_tiles = n_tiles_x * n_tiles_y * n_tiles_z;
        if (states_pred.size() != (size_t)total_tiles) states_pred.resize(total_tiles);
        if (dW_dt_pool.size() != (size_t)total_tiles) dW_dt_pool.resize(total_tiles);
        if (states_int.size() != (size_t)total_tiles) states_int.resize(total_tiles);
        #pragma omp parallel for schedule(static)
        for (int t = 0; t < total_tiles; ++t) {
            states_pred[t] = states_pool[t];
        }
        RealType gamma_r = (RealType)gamma;
        RealType invDx = (RealType)(1.0 / cellSize);
        int n_active = (int)active_tile_indices.size();

        #pragma omp parallel for schedule(guided)
        for (int a = 0; a < n_active; ++a) {
            int t = active_tile_indices[a];
            int tx = t % n_tiles_x;
            int ty = (t / n_tiles_x) % n_tiles_y;
            int tz = t / (n_tiles_x * n_tiles_y);
            
            auto& s_pred_tile = states_pred[t];
            auto& dW_dt_tile = dW_dt_pool[t];
            bool is_interior_tile = tile_is_fully_interior[t];
            
            auto sample_func = [&](int tx_val, int ty_val, int tz_val, int qx_val, int qy_val, int qz_val, int dir_val) {
                if (is_interior_tile) {
                    return sampleStateInternal(tx_val, ty_val, tz_val);
                } else {
                    return sampleStateInternalIDW(tx_val, ty_val, tz_val, qx_val, qy_val, qz_val, dir_val);
                }
            };
            
            auto slope = [&](RealType L, RealType C, RealType R) {
                return minmod(C - L, R - C) * invDx;
            };

            for (int k = 0; k < TILE_SIZE_3D; ++k) {
                int gz = tz * TILE_SIZE_3D + k;
                for (int j = 0; j < TILE_SIZE_3D; ++j) {
                    int gy = ty * TILE_SIZE_3D + j;
                    for (int i = 0; i < TILE_SIZE_3D; ++i) {
                        int gx = tx * TILE_SIZE_3D + i;
                        int idx = i + j * TILE_SIZE_3D + k * TILE_SIZE_3D * TILE_SIZE_3D;
                        
                        bool is_boundary = false;
                        if (!geom_pool.empty() && !is_interior_tile) {
                            int c = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;
                            is_boundary = geom_pool[t].cells[c].is_boundary;
                        }
                        if (is_boundary) continue;
                        
                        auto sC = sampleStateInternal(gx, gy, gz);
                        
                        auto sX_L = sample_func(gx - 1, gy, gz, gx, gy, gz, 0);
                        auto sX_R = sample_func(gx + 1, gy, gz, gx, gy, gz, 0);
                        auto sY_B = sample_func(gx, gy - 1, gz, gx, gy, gz, 1);
                        auto sY_T = sample_func(gx, gy + 1, gz, gx, gy, gz, 1);
                        auto sZ_D = sample_func(gx, gy, gz - 1, gx, gy, gz, 2);
                        auto sZ_U = sample_func(gx, gy, gz + 1, gx, gy, gz, 2);
                        
                        CellState3DT<RealType, IsMultiMaterial> d_x, d_y, d_z;
                        d_x.rho = slope(sX_L.rho, sC.rho, sX_R.rho);
                        d_x.ux = slope(sX_L.ux, sC.ux, sX_R.ux);
                        d_x.uy = slope(sX_L.uy, sC.uy, sX_R.uy);
                        d_x.uz = slope(sX_L.uz, sC.uz, sX_R.uz);
                        d_x.p = slope(sX_L.p, sC.p, sX_R.p);
                        if constexpr (IsMultiMaterial) {
                            d_x.alpha1 = slope(sX_L.alpha1, sC.alpha1, sX_R.alpha1);
                            d_x.alpha2 = slope(sX_L.alpha2, sC.alpha2, sX_R.alpha2);
                            d_x.arho1 = slope(sX_L.arho1, sC.arho1, sX_R.arho1);
                        } else {
                            d_x.alpha1 = 0; d_x.alpha2 = 0; d_x.arho1 = 0; d_x.arho2 = 0;
                        }

                        d_y.rho = slope(sY_B.rho, sC.rho, sY_T.rho);
                        d_y.ux = slope(sY_B.ux, sC.ux, sY_T.ux);
                        d_y.uy = slope(sY_B.uy, sC.uy, sY_T.uy);
                        d_y.uz = slope(sY_B.uz, sC.uz, sY_T.uz);
                        d_y.p = slope(sY_B.p, sC.p, sY_T.p);
                        if constexpr (IsMultiMaterial) {
                            d_y.alpha1 = slope(sY_B.alpha1, sC.alpha1, sY_T.alpha1);
                            d_y.alpha2 = slope(sY_B.alpha2, sC.alpha2, sY_T.alpha2);
                            d_y.arho1 = slope(sY_B.arho1, sC.arho1, sY_T.arho1);
                        } else {
                            d_y.alpha1 = 0; d_y.alpha2 = 0; d_y.arho1 = 0; d_y.arho2 = 0;
                        }

                        d_z.rho = slope(sZ_D.rho, sC.rho, sZ_U.rho);
                        d_z.ux = slope(sZ_D.ux, sC.ux, sZ_U.ux);
                        d_z.uy = slope(sZ_D.uy, sC.uy, sZ_U.uy);
                        d_z.uz = slope(sZ_D.uz, sC.uz, sZ_U.uz);
                        d_z.p = slope(sZ_D.p, sC.p, sZ_U.p);
                        if constexpr (IsMultiMaterial) {
                            d_z.alpha1 = slope(sZ_D.alpha1, sC.alpha1, sZ_U.alpha1);
                            d_z.alpha2 = slope(sZ_D.alpha2, sC.alpha2, sZ_U.alpha2);
                            d_z.arho1 = slope(sZ_D.arho1, sC.arho1, sZ_U.arho1);
                        } else {
                            d_z.alpha1 = 0; d_z.alpha2 = 0; d_z.arho1 = 0; d_z.arho2 = 0;
                        }
                        
                        CellState3DT<RealType, IsMultiMaterial> dW_dt;
                        computeTimeDerivative<RealType, IsMultiMaterial>(sC, d_x, d_y, d_z, gamma_r, dW_dt);
                        
                        // Store the first time derivative
                        dW_dt_tile.rho[idx] = dW_dt.rho;
                        dW_dt_tile.ux[idx] = dW_dt.ux;
                        dW_dt_tile.uy[idx] = dW_dt.uy;
                        dW_dt_tile.uz[idx] = dW_dt.uz;
                        dW_dt_tile.p[idx] = dW_dt.p;
                        if constexpr (IsMultiMaterial) {
                            dW_dt_tile.alpha1[idx] = dW_dt.alpha1;
                            dW_dt_tile.alpha2[idx] = dW_dt.alpha2;
                            dW_dt_tile.arho1[idx] = dW_dt.arho1;
                            dW_dt_tile.arho2[idx] = dW_dt.arho2;
                        }
                        
                        // Predict midpoint state W^{n+1/2}
                        s_pred_tile.rho[idx] = sC.rho + (RealType)0.5 * (RealType)dt * dW_dt.rho;
                        s_pred_tile.ux[idx] = sC.ux + (RealType)0.5 * (RealType)dt * dW_dt.ux;
                        s_pred_tile.uy[idx] = sC.uy + (RealType)0.5 * (RealType)dt * dW_dt.uy;
                        s_pred_tile.uz[idx] = sC.uz + (RealType)0.5 * (RealType)dt * dW_dt.uz;
                        s_pred_tile.p[idx] = sC.p + (RealType)0.5 * (RealType)dt * dW_dt.p;
                        if constexpr (IsMultiMaterial) {
                            s_pred_tile.alpha1[idx] = sC.alpha1 + (RealType)0.5 * (RealType)dt * dW_dt.alpha1;
                            s_pred_tile.alpha2[idx] = sC.alpha2 + (RealType)0.5 * (RealType)dt * dW_dt.alpha2;
                            s_pred_tile.arho1[idx] = sC.arho1 + (RealType)0.5 * (RealType)dt * dW_dt.arho1;
                            s_pred_tile.arho2[idx] = sC.arho2 + (RealType)0.5 * (RealType)dt * dW_dt.arho2;
                        }
                    }
                }
            }
        }
        
        if (temporalOrder == 6) { // ADER-3
            // Temporarily swap states_pool and states_pred so that we sample from W^{n+1/2}
            std::swap(states_pool, states_pred);
            
            // Copy midpoint structure to states_int in parallel
            #pragma omp parallel for schedule(static)
            for (int t = 0; t < total_tiles; ++t) {
                states_int[t] = states_pred[t];
            }
            
            #pragma omp parallel for schedule(guided)
            for (int a = 0; a < n_active; ++a) {
                int t = active_tile_indices[a];
                int tx = t % n_tiles_x;
                int ty = (t / n_tiles_x) % n_tiles_y;
                int tz = t / (n_tiles_x * n_tiles_y);
                
                auto& s_int_tile = states_int[t];
                bool is_interior_tile = tile_is_fully_interior[t];
                
                auto sample_func = [&](int tx_val, int ty_val, int tz_val, int qx_val, int qy_val, int qz_val, int dir_val) {
                    if (is_interior_tile) {
                        return sampleStateInternal(tx_val, ty_val, tz_val);
                    } else {
                        return sampleStateInternalIDW(tx_val, ty_val, tz_val, qx_val, qy_val, qz_val, dir_val);
                    }
                };
                
                auto slope = [&](RealType L, RealType C, RealType R) {
                    return minmod(C - L, R - C) * invDx;
                };

                for (int k = 0; k < TILE_SIZE_3D; ++k) {
                    int gz = tz * TILE_SIZE_3D + k;
                    for (int j = 0; j < TILE_SIZE_3D; ++j) {
                        int gy = ty * TILE_SIZE_3D + j;
                        for (int i = 0; i < TILE_SIZE_3D; ++i) {
                            int gx = tx * TILE_SIZE_3D + i;
                            int idx = i + j * TILE_SIZE_3D + k * TILE_SIZE_3D * TILE_SIZE_3D;
                            
                            bool is_boundary = false;
                            if (!geom_pool.empty() && !is_interior_tile) {
                                int c = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;
                                is_boundary = geom_pool[t].cells[c].is_boundary;
                            }
                            if (is_boundary) continue;
                            
                            auto sC = sampleStateInternal(gx, gy, gz); // midpoint state
                            
                            auto sX_L = sample_func(gx - 1, gy, gz, gx, gy, gz, 0);
                            auto sX_R = sample_func(gx + 1, gy, gz, gx, gy, gz, 0);
                            auto sY_B = sample_func(gx, gy - 1, gz, gx, gy, gz, 1);
                            auto sY_T = sample_func(gx, gy + 1, gz, gx, gy, gz, 1);
                            auto sZ_D = sample_func(gx, gy, gz - 1, gx, gy, gz, 2);
                            auto sZ_U = sample_func(gx, gy, gz + 1, gx, gy, gz, 2);
                            
                            CellState3DT<RealType, IsMultiMaterial> d_x, d_y, d_z;
                            d_x.rho = slope(sX_L.rho, sC.rho, sX_R.rho);
                            d_x.ux = slope(sX_L.ux, sC.ux, sX_R.ux);
                            d_x.uy = slope(sX_L.uy, sC.uy, sX_R.uy);
                            d_x.uz = slope(sX_L.uz, sC.uz, sX_R.uz);
                            d_x.p = slope(sX_L.p, sC.p, sX_R.p);
                            if constexpr (IsMultiMaterial) {
                                d_x.alpha1 = slope(sX_L.alpha1, sC.alpha1, sX_R.alpha1);
                                d_x.alpha2 = slope(sX_L.alpha2, sC.alpha2, sX_R.alpha2);
                                d_x.arho1 = slope(sX_L.arho1, sC.arho1, sX_R.arho1);
                            } else {
                                d_x.alpha1 = 0; d_x.alpha2 = 0; d_x.arho1 = 0; d_x.arho2 = 0;
                            }

                            d_y.rho = slope(sY_B.rho, sC.rho, sY_T.rho);
                            d_y.ux = slope(sY_B.ux, sC.ux, sY_T.ux);
                            d_y.uy = slope(sY_B.uy, sC.uy, sY_T.uy);
                            d_y.uz = slope(sY_B.uz, sC.uz, sY_T.uz);
                            d_y.p = slope(sY_B.p, sC.p, sY_T.p);
                            if constexpr (IsMultiMaterial) {
                                d_y.alpha1 = slope(sY_B.alpha1, sC.alpha1, sY_T.alpha1);
                                d_y.alpha2 = slope(sY_B.alpha2, sC.alpha2, sY_T.alpha2);
                                d_y.arho1 = slope(sY_B.arho1, sC.arho1, sY_T.arho1);
                            } else {
                                d_y.alpha1 = 0; d_y.alpha2 = 0; d_y.arho1 = 0; d_y.arho2 = 0;
                            }

                            d_z.rho = slope(sZ_D.rho, sC.rho, sZ_U.rho);
                            d_z.ux = slope(sZ_D.ux, sC.ux, sZ_U.ux);
                            d_z.uy = slope(sZ_D.uy, sC.uy, sZ_U.uy);
                            d_z.uz = slope(sZ_D.uz, sC.uz, sZ_U.uz);
                            d_z.p = slope(sZ_D.p, sC.p, sZ_U.p);
                            if constexpr (IsMultiMaterial) {
                                d_z.alpha1 = slope(sZ_D.alpha1, sC.alpha1, sZ_U.alpha1);
                                d_z.alpha2 = slope(sZ_D.alpha2, sC.alpha2, sZ_U.alpha2);
                                d_z.arho1 = slope(sZ_D.arho1, sC.arho1, sZ_U.arho1);
                            } else {
                                d_z.alpha1 = 0; d_z.alpha2 = 0; d_z.arho1 = 0; d_z.arho2 = 0;
                            }
                            
                            CellState3DT<RealType, IsMultiMaterial> dW_dt_mid;
                            computeTimeDerivative<RealType, IsMultiMaterial>(sC, d_x, d_y, d_z, gamma_r, dW_dt_mid);
                            
                            // states_pred contains the original state W^n because of the swap!
                            auto& s_orig = states_pred[t];
                            auto& dW_dt_orig = dW_dt_pool[t];
                            
                            s_int_tile.rho[idx] = s_orig.rho[idx] + (RealType)dt * ((RealType)(1.0/6.0) * dW_dt_orig.rho[idx] + (RealType)(2.0/3.0) * dW_dt_mid.rho);
                            s_int_tile.ux[idx] = s_orig.ux[idx] + (RealType)dt * ((RealType)(1.0/6.0) * dW_dt_orig.ux[idx] + (RealType)(2.0/3.0) * dW_dt_mid.ux);
                            s_int_tile.uy[idx] = s_orig.uy[idx] + (RealType)dt * ((RealType)(1.0/6.0) * dW_dt_orig.uy[idx] + (RealType)(2.0/3.0) * dW_dt_mid.uy);
                            s_int_tile.uz[idx] = s_orig.uz[idx] + (RealType)dt * ((RealType)(1.0/6.0) * dW_dt_orig.uz[idx] + (RealType)(2.0/3.0) * dW_dt_mid.uz);
                            s_int_tile.p[idx] = s_orig.p[idx] + (RealType)dt * ((RealType)(1.0/6.0) * dW_dt_orig.p[idx] + (RealType)(2.0/3.0) * dW_dt_mid.p);
                            if constexpr (IsMultiMaterial) {
                                s_int_tile.alpha1[idx] = s_orig.alpha1[idx] + (RealType)dt * ((RealType)(1.0/6.0) * dW_dt_orig.alpha1[idx] + (RealType)(2.0/3.0) * dW_dt_mid.alpha1);
                                s_int_tile.alpha2[idx] = s_orig.alpha2[idx] + (RealType)dt * ((RealType)(1.0/6.0) * dW_dt_orig.alpha2[idx] + (RealType)(2.0/3.0) * dW_dt_mid.alpha2);
                                s_int_tile.arho1[idx] = s_orig.arho1[idx] + (RealType)dt * ((RealType)(1.0/6.0) * dW_dt_orig.arho1[idx] + (RealType)(2.0/3.0) * dW_dt_mid.arho1);
                                s_int_tile.arho2[idx] = s_orig.arho2[idx] + (RealType)dt * ((RealType)(1.0/6.0) * dW_dt_orig.arho2[idx] + (RealType)(2.0/3.0) * dW_dt_mid.arho2);
                            }
                        }
                    }
                }
            }
            
            // Copy integrated states to states_pred so local states_int destruction does not leave dangling pointers
            states_pred = states_int;
        }
        
        std::swap(states_pool, states_pred);
        computeFluxes(dt, U_pool);
        std::swap(states_pool, states_pred);
    }

    if constexpr (IsMultiMaterial) {
        applyProgrammedBurn(dt);
    }

    updatePrimitiveFromConservative();
    applyBC();

    int n_active = (int)active_tile_indices.size();
    #pragma omp parallel for schedule(guided)
    for (int a = 0; a < n_active; ++a) {
        int t = active_tile_indices[a];
        auto& tile = states_pool[t];
        for (int i = 0; i < TILE_CELLS_3D; ++i) {
            RealType op = tile.p[i] - (RealType)ambient_p;
            if (op < (RealType)0.0) op = (RealType)0.0;
            if (op > tile.peak_overpressure[i]) {
                tile.peak_overpressure[i] = op;
            }
            tile.peak_impulse[i] += op * (RealType)dt;
        }
    }


    currentTime += dt;
    updateActiveRegions();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::applyBC() {}

template <typename RealType, bool IsMultiMaterial>
double CFDSolver3DImpl<RealType, IsMultiMaterial>::computeStepSize(double cfl) const {
    int n_active = (int)active_tile_indices.size();
    if (n_active == 0) return 1e-6;
    RealType max_s = (RealType)1e-6;

    #pragma omp parallel for reduction(max:max_s) schedule(guided)
    for (int a = 0; a < n_active; ++a) {
        int t = active_tile_indices[a];
        const auto& tile = states_pool[t];
        for (int i = 0; i < TILE_CELLS_3D; ++i) {
            if (!geom_pool.empty() && geom_pool[t].cells[i].is_boundary) continue;
            using std::abs;
            using std::sqrt;
            using std::max;
            RealType c;
            if constexpr (IsMultiMaterial) {
                c = MultiMat::getMixtureSoundSpeed(tile.p[i], tile.rho[i], tile.alpha1[i], tile.alpha2[i], tile.arho1[i], tile.arho2[i], (RealType)gamma, currentMaterials.products, currentMaterials.unreacted);
                RealType a2 = tile.alpha2[i];
                RealType ar2 = tile.arho2[i];
                if (a2 > (RealType)1e-4 && ar2 > (RealType)10.0 && currentMaterials.det_vel > 0.0) {
                    c = max(c, (RealType)currentMaterials.det_vel);
                }
            } else {
                c = sqrt((RealType)gamma * tile.p[i] / max((RealType)1e-6, tile.rho[i]));
            }
            RealType s = abs(tile.ux[i]) + abs(tile.uy[i]) + abs(tile.uz[i]) + (RealType)3.0 * c;
            if (s > max_s) {
                max_s = s;
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
        return geom_pool[t].cells[c].is_boundary != 0;
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

    if (slice.axis == "obstacles") {
        data.resize(obstacle_faces.size(), 0.0f);
        for (size_t f = 0; f < obstacle_faces.size(); ++f) {
            const auto& face = obstacle_faces[f];
            data[f] = getVal(sampleState(face.gx_fluid, face.gy_fluid, face.gz_fluid), face.gx_fluid, face.gy_fluid, face.gz_fluid);
        }
        return data;
    }

    if (slice.axis == "volume") {
        int factor = 1;
        int out_nx = ((nx + stride - 1) / stride) * factor;
        int out_ny = ((ny + stride - 1) / stride) * factor;
        int out_nz = ((nz + stride - 1) / stride) * factor;
        data.resize((size_t)out_nx * out_ny * out_nz);

        double h_ref = (cellSize * stride) / factor;

        #pragma omp parallel for collapse(3)
        for (int gz = 0; gz < out_nz; ++gz) {
            for (int gy = 0; gy < out_ny; ++gy) {
                for (int gx = 0; gx < out_nx; ++gx) {
                    double px = xmin + (gx + 0.5) * h_ref;
                    double py = ymin + (gy + 0.5) * h_ref;
                    double pz = zmin + (gz + 0.5) * h_ref;

                    int base_gx = std::clamp((int)std::floor((px - xmin) / cellSize), 0, nx - 1);
                    int base_gy = std::clamp((int)std::floor((py - ymin) / cellSize), 0, ny - 1);
                    int base_gz = std::clamp((int)std::floor((pz - zmin) / cellSize), 0, nz - 1);

                    int target_base_gx = base_gx;
                    int target_base_gy = base_gy;
                    int target_base_gz = base_gz;

                    if (is_solid(base_gx, base_gy, base_gz)) {
                        bool found = false;
                        for (int r = 1; r <= 2 && !found; ++r) {
                            for (int dz = -r; dz <= r && !found; ++dz) {
                                for (int dy = -r; dy <= r && !found; ++dy) {
                                    for (int dx = -r; dx <= r && !found; ++dx) {
                                        int nx_c = base_gx + dx;
                                        int ny_c = base_gy + dy;
                                        int nz_c = base_gz + dz;
                                        if (nx_c >= 0 && nx_c < nx && ny_c >= 0 && ny_c < ny && nz_c >= 0 && nz_c < nz) {
                                            if (!is_solid(nx_c, ny_c, nz_c)) {
                                                target_base_gx = nx_c;
                                                target_base_gy = ny_c;
                                                target_base_gz = nz_c;
                                                found = true;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    data[(size_t)gx + (size_t)gy * out_nx + (size_t)gz * out_nx * out_ny] = getVal(sampleState(target_base_gx, target_base_gy, target_base_gz), target_base_gx, target_base_gy, target_base_gz);
                }
            }
        }
        return data;
    }

    int scale = 1;
    int axis = (slice.axis == "xy" ? 0 : (slice.axis == "xz" ? 1 : 2));
    int base_w = 0, base_h = 0;
    if (axis == 0) { base_w = (nx + stride - 1) / stride; base_h = (ny + stride - 1) / stride; }
    else if (axis == 1) { base_w = (nx + stride - 1) / stride; base_h = (nz + stride - 1) / stride; }
    else { base_w = (ny + stride - 1) / stride; base_h = (nz + stride - 1) / stride; }

    int w = base_w * scale;
    int h = base_h * scale;

    data.resize(w * h, 0.0f);

    for (int j = 0; j < h; ++j) {
        for (int i = 0; i < w; ++i) {
            int gxc = (i / scale) * stride;
            int gyc = (j / scale) * stride;
            int gzc = (j / scale) * stride;

            if (axis == 0) {
                int gz = std::clamp((int)((slice.offset - zmin) / cellSize), 0, nz - 1);
                data[i + j * w] = getVal(sampleState(gxc, gyc, gz), gxc, gyc, gz);
            } else if (axis == 1) {
                int gy = std::clamp((int)((slice.offset - ymin) / cellSize), 0, ny - 1);
                data[i + j * w] = getVal(sampleState(gxc, gy, gzc), gxc, gy, gzc);
            } else {
                int gx = std::clamp((int)((slice.offset - xmin) / cellSize), 0, nx - 1);
                data[i + j * w] = getVal(sampleState(gx, gxc, gzc), gx, gxc, gzc);
            }
        }
    }
    return data;
}

template <typename RealType, bool IsMultiMaterial>
std::vector<SlicePayload3D> CFDSolver3DImpl<RealType, IsMultiMaterial>::extractAllSlices(const Slice3D& slice) const {
    std::vector<SlicePayload3D> results;

    // 1. Parent slice
    SlicePayload3D parent_sp;
    parent_sp.axis = slice.axis;
    parent_sp.offset = slice.offset;
    parent_sp.stride = slice.stride;
    parent_sp.level = 0;
    parent_sp.xmin = xmin; parent_sp.xmax = xmin + nx * cellSize;
    parent_sp.ymin = ymin; parent_sp.ymax = ymin + ny * cellSize;
    parent_sp.zmin = zmin; parent_sp.zmax = zmin + nz * cellSize;

    int base_w = 0, base_h = 0, depth = 1;
    getSliceDimensions(slice, base_w, base_h, depth);
    parent_sp.w = base_w;
    parent_sp.h = base_h;
    parent_sp.data = extractSlice(slice);

    results.push_back(std::move(parent_sp));
    return results;
}

extern void remap_1d_to_3d(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d,
                    CFDSolver3D& solver_3d, double x_expl, double y_expl, double z_expl, double R_remap);
extern void remap_2d_to_3d(int nr, int nz, double dr, double dz, const std::vector<State2D>& states_2d,
                    CFDSolver3D& solver_3d, double x_expl, double y_expl, double z_expl, double R_remap, double source_explosive_z = 0.0);

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::initializeFrom1D(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d, double x_expl, double y_expl, double z_expl, double R_remap) {
    currentTime = 0.0;
    const auto& outer_state_1d = states_1d.back();
    double amb_rho = (this->ambient_rho > 0.0) ? this->ambient_rho : outer_state_1d.rho;
    double amb_p = (this->ambient_p > 0.0) ? this->ambient_p : outer_state_1d.p;
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

    remap_1d_to_3d(r_1d, states_1d, *this, x_expl, y_expl, z_expl, R_remap);
    commitStates();


    double cell_sz_1d = (double)cellSize;
    #pragma omp parallel for
    for (int t = 0; t < (int)states_pool.size(); ++t) {
        int tx = t % n_tiles_x;
        int ty = (t / n_tiles_x) % n_tiles_y;
        int tz = t / (n_tiles_x * n_tiles_y);
        double t_x = xmin + (tx + 0.5) * TILE_SIZE_3D * cell_sz_1d;
        double t_y = ymin + (ty + 0.5) * TILE_SIZE_3D * cell_sz_1d;
        double t_z = zmin + (tz + 0.5) * TILE_SIZE_3D * cell_sz_1d;
        double dist = std::sqrt((t_x - x_expl)*(t_x - x_expl) + (t_y - y_expl)*(t_y - y_expl) + (t_z - z_expl)*(t_z - z_expl));
        if (dist <= R_remap + TILE_SIZE_3D * cell_sz_1d * 1.5) {
            active_tiles[t] = 1;
        }
    }

    active_tile_indices.clear();
    for (int t = 0; t < (int)states_pool.size(); ++t) {
        if (active_tiles[t]) {
            active_tile_indices.push_back(t);
        } else {
            auto& tile = states_pool[t];
            auto& u_tile = U_pool[t];
            for (int i = 0; i < TILE_CELLS_3D; ++i) {
                tile.rho[i] = (RealType)ambient_rho;
                tile.ux[i] = 0.0; tile.uy[i] = 0.0; tile.uz[i] = 0.0;
                tile.p[i] = (RealType)ambient_p;
                if constexpr (IsMultiMaterial) {
                    tile.alpha1[i] = 0.0; tile.alpha2[i] = 0.0;
                    tile.arho1[i] = 0.0; tile.arho2[i] = 0.0;
                }
                tile.floor_status[i] = 0;
                tile.peak_overpressure[i] = 0.0;
                tile.peak_impulse[i] = 0.0;

                u_tile.rho[i] = (RealType)ambient_rho;
                u_tile.rhoux[i] = 0.0; u_tile.rhouy[i] = 0.0; u_tile.rhouz[i] = 0.0;
                if constexpr (IsMultiMaterial) {
                    u_tile.alpha1[i] = 0.0; u_tile.alpha2[i] = 0.0;
                    u_tile.arho1[i] = 0.0; u_tile.arho2[i] = 0.0;
                    u_tile.E[i] = (RealType)MultiMat::getMixtureEnergy((double)ambient_p, (double)ambient_rho, 0.0, 0.0, 0.0, 0.0, (double)gamma, currentMaterials.products, currentMaterials.unreacted);
                } else {
                    u_tile.E[i] = (RealType)ambient_p / (gamma - (RealType)1.0);
                }
            }
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::initializeFrom2D(int nr, int nz, double dr, double dz, const std::vector<State2D>& states_2d, double x_expl, double y_expl, double z_expl, double R_remap, double source_explosive_z) {
    currentTime = 0.0;
    if (states_2d.empty()) return;
    const auto& outer_state_2d = states_2d.back();
    double amb_rho = (this->ambient_rho > 0.0) ? this->ambient_rho : outer_state_2d.rho;
    double amb_p = (this->ambient_p > 0.0) ? this->ambient_p : outer_state_2d.p;
    ambient_rho = amb_rho;
    ambient_p = amb_p;

    #pragma omp parallel for
    for (int t = 0; t < (int)states_pool.size(); ++t) {
        auto& tile = states_pool[t];
        auto& u_tile = U_pool[t];
        for (int i = 0; i < TILE_CELLS_3D; ++i) {
            tile.rho[i] = (RealType)amb_rho;
            tile.ux[i] = 0.0; tile.uy[i] = 0.0; tile.uz[i] = 0.0;
            tile.p[i] = (RealType)amb_p;
            CellState3D<IsMultiMaterial> temp_s;
            if constexpr (IsMultiMaterial) {
                temp_s.alpha1 = 0.0; temp_s.alpha2 = 0.0;
                temp_s.arho1 = 0.0; temp_s.arho2 = 0.0;
                tile.alpha1[i] = 0.0; tile.alpha2[i] = 0.0;
                tile.arho1[i] = 0.0; tile.arho2[i] = 0.0;
            }
            tile.floor_status[i] = 0;
            tile.peak_overpressure[i] = 0.0;
            tile.peak_impulse[i] = 0.0;

            u_tile.rho[i] = (RealType)amb_rho;
            u_tile.rhoux[i] = 0.0; u_tile.rhouy[i] = 0.0; u_tile.rhouz[i] = 0.0;
            u_tile.E[i] = (RealType)getEnergy3D<IsMultiMaterial>(amb_p, amb_rho, temp_s, gamma, currentMaterials.products, currentMaterials.unreacted);
            if constexpr (IsMultiMaterial) {
                u_tile.alpha1[i] = 0.0; u_tile.alpha2[i] = 0.0;
                u_tile.arho1[i] = 0.0; u_tile.arho2[i] = 0.0;
            }
        }
    }
    active_tiles.assign(states_pool.size(), 0);

    remap_2d_to_3d(nr, nz, dr, dz, states_2d, *this, x_expl, y_expl, z_expl, R_remap, source_explosive_z);
    commitStates();


    double max_extent_2d = std::max((double)(nr * dr), (double)(nz * dz));
    double cut_r = (R_remap > 0.0) ? R_remap : max_extent_2d;
    double cell_sz_2d = (double)cellSize;
    #pragma omp parallel for
    for (int t = 0; t < (int)states_pool.size(); ++t) {
        int tx = t % n_tiles_x;
        int ty = (t / n_tiles_x) % n_tiles_y;
        int tz = t / (n_tiles_x * n_tiles_y);
        double t_x = xmin + (tx + 0.5) * TILE_SIZE_3D * cell_sz_2d;
        double t_y = ymin + (ty + 0.5) * TILE_SIZE_3D * cell_sz_2d;
        double t_z = zmin + (tz + 0.5) * TILE_SIZE_3D * cell_sz_2d;
        double dist = std::sqrt((t_x - x_expl)*(t_x - x_expl) + (t_y - y_expl)*(t_y - y_expl) + (t_z - z_expl)*(t_z - z_expl));
        if (dist <= cut_r + TILE_SIZE_3D * cell_sz_2d * 1.5) {
            active_tiles[t] = 1;
        }
    }

    active_tile_indices.clear();
    for (int t = 0; t < (int)states_pool.size(); ++t) {
        if (active_tiles[t]) {
            active_tile_indices.push_back(t);
        } else {
            auto& tile = states_pool[t];
            auto& u_tile = U_pool[t];
            for (int i = 0; i < TILE_CELLS_3D; ++i) {
                tile.rho[i] = (RealType)ambient_rho;
                tile.ux[i] = 0.0; tile.uy[i] = 0.0; tile.uz[i] = 0.0;
                tile.p[i] = (RealType)ambient_p;
                if constexpr (IsMultiMaterial) {
                    tile.alpha1[i] = 0.0; tile.alpha2[i] = 0.0;
                    tile.arho1[i] = 0.0; tile.arho2[i] = 0.0;
                }
                tile.floor_status[i] = 0;
                tile.peak_overpressure[i] = 0.0;
                tile.peak_impulse[i] = 0.0;

                u_tile.rho[i] = (RealType)ambient_rho;
                u_tile.rhoux[i] = 0.0; u_tile.rhouy[i] = 0.0; u_tile.rhouz[i] = 0.0;
                if constexpr (IsMultiMaterial) {
                    u_tile.alpha1[i] = 0.0; u_tile.alpha2[i] = 0.0;
                    u_tile.arho1[i] = 0.0; u_tile.arho2[i] = 0.0;
                    u_tile.E[i] = (RealType)MultiMat::getMixtureEnergy((double)ambient_p, (double)ambient_rho, 0.0, 0.0, 0.0, 0.0, (double)gamma, currentMaterials.products, currentMaterials.unreacted);
                } else {
                    u_tile.E[i] = (RealType)ambient_p / (gamma - (RealType)1.0);
                }
            }
        }
    }
}


template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::setCellStateMulti(int gx, int gy, int gz, const CellState3D<true>& s) {
    int t_idx = (gx / TILE_SIZE_3D) + (gy / TILE_SIZE_3D) * n_tiles_x + (gz / TILE_SIZE_3D) * n_tiles_x * n_tiles_y;
    int c_idx = (gx % TILE_SIZE_3D) + (gy % TILE_SIZE_3D) * TILE_SIZE_3D + (gz % TILE_SIZE_3D) * TILE_SIZE_3D * TILE_SIZE_3D;
    auto& tile = states_pool[t_idx];
    tile.rho[c_idx] = (RealType)s.rho; tile.ux[c_idx] = (RealType)s.ux; tile.uy[c_idx] = (RealType)s.uy; tile.uz[c_idx] = (RealType)s.uz;
    tile.p[c_idx] = (RealType)s.p;
    if constexpr (IsMultiMaterial) {
        tile.alpha1[c_idx] = (RealType)s.alpha1; tile.alpha2[c_idx] = (RealType)s.alpha2;
        tile.arho1[c_idx] = (RealType)s.arho1; tile.arho2[c_idx] = (RealType)s.arho2;
    }
    tile.peak_overpressure[c_idx] = 0.0;
    tile.peak_impulse[c_idx] = 0.0;
    active_tiles[t_idx] = 1;
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
    tile.peak_impulse[c_idx] = 0.0;
    active_tiles[t_idx] = 1;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::commitStates() {
    updateActiveRegions();
    
    #pragma omp parallel for
    for (int t = 0; t < (int)states_pool.size(); ++t) {
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
void CFDSolver3DImpl<RealType, IsMultiMaterial>::uploadObstacleFaces(const std::vector<ObstacleFace>& faces) {
    obstacle_faces = faces;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::setSolidMask(const uint8_t* mask) {
    if (!mask) return;
    int total_tiles = n_tiles_x * n_tiles_y * n_tiles_z;
    if (geom_pool.size() != static_cast<size_t>(total_tiles)) {
        geom_pool.resize(total_tiles);
    }

    bool has_prev = (prev_mask_pool.size() == static_cast<size_t>(total_tiles));

    for (int gx = 0; gx < nx; ++gx) {
        for (int gy = 0; gy < ny; ++gy) {
            for (int gz = 0; gz < nz; ++gz) {
                int cfd_idx = gx + gy * nx + gz * nx * ny;
                int t_idx = (gx >> 3) + (gy >> 3) * n_tiles_x + (gz >> 3) * n_tiles_x * n_tiles_y;
                int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

                bool prev_is_solid = has_prev && ((prev_mask_pool[t_idx].words[c_idx >> 6] & (1ULL << (c_idx & 63))) != 0);
                bool curr_is_solid = (mask[cfd_idx] != 0);

                geom_pool[t_idx].cells[c_idx].is_boundary = curr_is_solid;

                // Freshly uncovered cell: WAS solid, NOW fluid
                if (prev_is_solid && !curr_is_solid) {
                    RealType sum_w = (RealType)0.0;
                    RealType sum_rho = (RealType)0.0;
                    RealType sum_ux = (RealType)0.0;
                    RealType sum_uy = (RealType)0.0;
                    RealType sum_uz = (RealType)0.0;
                    RealType sum_p = (RealType)0.0;
                    RealType sum_a1 = (RealType)0.0;
                    RealType sum_a2 = (RealType)0.0;
                    RealType sum_arho1 = (RealType)0.0;
                    RealType sum_arho2 = (RealType)0.0;

                    for (int dz_n = -1; dz_n <= 1; ++dz_n) {
                        for (int dy_n = -1; dy_n <= 1; ++dy_n) {
                            for (int dx_n = -1; dx_n <= 1; ++dx_n) {
                                if (dx_n == 0 && dy_n == 0 && dz_n == 0) continue;
                                int nx_c = gx + dx_n;
                                int ny_c = gy + dy_n;
                                int nz_c = gz + dz_n;
                                if (nx_c >= 0 && nx_c < nx && ny_c >= 0 && ny_c < ny && nz_c >= 0 && nz_c < nz) {
                                    int nflat = nx_c + ny_c * nx + nz_c * nx * ny;
                                    if (mask[nflat] == 0) {
                                        int nt_idx = (nx_c >> 3) + (ny_c >> 3) * n_tiles_x + (nz_c >> 3) * n_tiles_x * n_tiles_y;
                                        int nc_idx = (nx_c & 7) + (ny_c & 7) * 8 + (nz_c & 7) * 64;
                                        RealType dist_sq = (RealType)(dx_n * dx_n + dy_n * dy_n + dz_n * dz_n);
                                        RealType w = (RealType)1.0 / dist_sq;

                                        sum_w += w;
                                        sum_rho += w * states_pool[nt_idx].rho[nc_idx];
                                        sum_ux  += w * states_pool[nt_idx].ux[nc_idx];
                                        sum_uy  += w * states_pool[nt_idx].uy[nc_idx];
                                        sum_uz  += w * states_pool[nt_idx].uz[nc_idx];
                                        sum_p   += w * states_pool[nt_idx].p[nc_idx];
                                        if constexpr (IsMultiMaterial) {
                                            sum_a1    += w * states_pool[nt_idx].alpha1[nc_idx];
                                            sum_a2    += w * states_pool[nt_idx].alpha2[nc_idx];
                                            sum_arho1 += w * states_pool[nt_idx].arho1[nc_idx];
                                            sum_arho2 += w * states_pool[nt_idx].arho2[nc_idx];
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if (sum_w > (RealType)1e-8) {
                        RealType inv_w = (RealType)1.0 / sum_w;
                        RealType ext_rho = sum_rho * inv_w;
                        RealType ext_ux  = sum_ux * inv_w;
                        RealType ext_uy  = sum_uy * inv_w;
                        RealType ext_uz  = sum_uz * inv_w;
                        RealType ext_p   = sum_p * inv_w;

                        states_pool[t_idx].rho[c_idx] = ext_rho;
                        states_pool[t_idx].ux[c_idx]  = ext_ux;
                        states_pool[t_idx].uy[c_idx]  = ext_uy;
                        states_pool[t_idx].uz[c_idx]  = ext_uz;
                        states_pool[t_idx].p[c_idx]   = ext_p;

                        if constexpr (IsMultiMaterial) {
                            states_pool[t_idx].alpha1[c_idx] = sum_a1 * inv_w;
                            states_pool[t_idx].alpha2[c_idx] = sum_a2 * inv_w;
                            states_pool[t_idx].arho1[c_idx]  = sum_arho1 * inv_w;
                            states_pool[t_idx].arho2[c_idx]  = sum_arho2 * inv_w;
                        }

                        U_pool[t_idx].rho[c_idx]   = ext_rho;
                        U_pool[t_idx].rhoux[c_idx] = ext_rho * ext_ux;
                        U_pool[t_idx].rhouy[c_idx] = ext_rho * ext_uy;
                        U_pool[t_idx].rhouz[c_idx] = ext_rho * ext_uz;

                        RealType ke = (RealType)0.5 * ext_rho * (ext_ux * ext_ux + ext_uy * ext_uy + ext_uz * ext_uz);
                        U_pool[t_idx].E[c_idx]     = ext_p / (gamma - (RealType)1.0) + ke;

                        if constexpr (IsMultiMaterial) {
                            U_pool[t_idx].alpha1[c_idx] = sum_a1 * inv_w;
                            U_pool[t_idx].alpha2[c_idx] = sum_a2 * inv_w;
                            U_pool[t_idx].arho1[c_idx]  = sum_arho1 * inv_w;
                            U_pool[t_idx].arho2[c_idx]  = sum_arho2 * inv_w;
                        }
                    }
                }
            }
        }
    }
    if (prev_mask_pool.size() != static_cast<size_t>(total_tiles)) {
        prev_mask_pool.resize(total_tiles);
    }
    for (int t = 0; t < total_tiles; ++t) {
        const auto& gt = geom_pool[t];
        auto& mt = prev_mask_pool[t];
        for (int w = 0; w < 8; ++w) {
            uint64_t word = 0;
            int base = w * 64;
            for (int b = 0; b < 64; ++b) {
                if (gt.cells[base + b].is_boundary) {
                    word |= (1ULL << b);
                }
            }
            mt.words[w] = word;
        }
    }
}



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
void CFDSolver3DImpl<RealType, IsMultiMaterial>::setGeometryTriangles(const std::vector<Triangle>& triangles, const std::string& geometry_hash, const std::string& voxelization_method,
                                                                      const std::atomic<bool>* terminate_flag,
                                                                      std::function<void(double)> progress_callback) {
    voxelize_geometry(
        triangles,
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
void CFDSolver3DImpl<RealType, IsMultiMaterial>::setGeometryPrimitives(const nlohmann::json& primitives, const std::string& geometry_hash, const std::string& voxelization_method,
                                                                       const std::atomic<bool>* terminate_flag,
                                                                       std::function<void(double)> progress_callback) {
    voxelize_primitives(
        primitives,
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
            if (!geom_pool.empty() && geom_pool[t].cells[c].is_boundary) continue;
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
