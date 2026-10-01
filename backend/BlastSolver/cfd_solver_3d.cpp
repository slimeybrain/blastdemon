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
    charge_radius = charge.radius;
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
void CFDSolver3DImpl<RealType, IsMultiMaterial>::setAcousticWavePacket(
    double x0, double sigma, double delta_p, double amb_rho, double amb_p) {
    this->ambient_rho = amb_rho;
    this->ambient_p = amb_p;
    this->charge_radius = sigma;
    double c_sound = std::sqrt(this->gamma * amb_p / amb_rho);
    double Z0 = amb_rho * c_sound;

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
            if constexpr (IsMultiMaterial) {
                tile.alpha1[i] = 0.0; tile.alpha2[i] = 0.0;
                tile.arho1[i] = 0.0; tile.arho2[i] = 0.0;
            }
            tile.floor_status[i] = 0;
            tile.peak_overpressure[i] = 0.0;
            tile.peak_impulse[i] = 0.0;

            u_tile.rho[i] = (RealType)amb_rho;
            u_tile.rhoux[i] = 0.0;
            u_tile.rhouy[i] = 0.0;
            u_tile.rhouz[i] = 0.0;
            u_tile.E[i] = (RealType)(amb_p / (this->gamma - 1.0));
            if constexpr (IsMultiMaterial) {
                u_tile.alpha1[i] = 0.0; u_tile.alpha2[i] = 0.0;
                u_tile.arho1[i] = 0.0; u_tile.arho2[i] = 0.0;
            }
        }
    }

    #pragma omp parallel for collapse(3)
    for (int tz = 0; tz < n_tiles_z; ++tz) {
        for (int ty = 0; ty < n_tiles_y; ++ty) {
            for (int tx = 0; tx < n_tiles_x; ++tx) {
                int t_idx = tx + ty * n_tiles_x + tz * n_tiles_x * n_tiles_y;
                auto& tile = states_pool[t_idx];
                auto& u_tile = U_pool[t_idx];
                for (int k = 0; k < TILE_SIZE_3D; ++k) {
                    int gz = tz * TILE_SIZE_3D + k;
                    if (gz >= nz) continue;
                    for (int j = 0; j < TILE_SIZE_3D; ++j) {
                        int gy = ty * TILE_SIZE_3D + j;
                        if (gy >= ny) continue;
                        for (int i = 0; i < TILE_SIZE_3D; ++i) {
                            int gx = tx * TILE_SIZE_3D + i;
                            if (gx >= nx) continue;
                            double x_c = xmin + (gx + 0.5) * cellSize;
                            double dx_val = (x_c - x0) / sigma;
                            double dp = delta_p * std::exp(-dx_val * dx_val);
                            double p_cell = amb_p + dp;
                            double rho_cell = amb_rho + dp / (c_sound * c_sound);
                            double ux_cell = dp / Z0;

                            int c_idx = i + j * TILE_SIZE_3D + k * TILE_SIZE_3D * TILE_SIZE_3D;
                            tile.p[c_idx] = (RealType)p_cell;
                            tile.rho[c_idx] = (RealType)rho_cell;
                            tile.ux[c_idx] = (RealType)ux_cell;
                            tile.uy[c_idx] = 0.0;
                            tile.uz[c_idx] = 0.0;

                            RealType ke = (RealType)(0.5 * rho_cell * ux_cell * ux_cell);
                            u_tile.rho[c_idx] = (RealType)rho_cell;
                            u_tile.rhoux[c_idx] = (RealType)(rho_cell * ux_cell);
                            u_tile.rhouy[c_idx] = 0.0;
                            u_tile.rhouz[c_idx] = 0.0;
                            u_tile.E[c_idx] = (RealType)(p_cell / (this->gamma - 1.0)) + ke;
                        }
                    }
                }
            }
        }
    }
    updateActiveRegions();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::setStratifiedInitialCondition(
    const Charge3DParams& charge, const MultiMat::MaterialSet& materials, const Blast::Stratified3DParams& strat) {
    Blast::Stratified3DParams strat_snapped = strat;
    strat_snapped.enabled = true;
    int gz_seabed = std::max(1, (int)std::round((strat.seabed_surface_z - zmin) / cellSize));
    strat_snapped.seabed_surface_z = zmin + (double)gz_seabed * cellSize;
    strat_snapped.charge_x = charge.x;
    strat_snapped.charge_y = charge.y;
    strat_snapped.charge_z = charge.z;
    strat_snapped.charge_radius = charge.radius;
    this->stratified_params = strat_snapped;
    if (strat_snapped.gravity_z != 0.0) {
        this->setGravity(0.0, 0.0, strat_snapped.gravity_z);
    }
    double g_mag = std::abs(strat_snapped.gravity_z);
    if (g_mag < 1e-6) g_mag = 9.81;

    this->ambient_rho = strat_snapped.air_rho;
    this->ambient_p = strat_snapped.p_atm;
    this->charge_radius = charge.radius;
    this->currentMaterials = materials;
    MultiMat::initializePrecalculatedTerms(this->currentMaterials);

    #pragma omp parallel for collapse(3)
    for (int tz = 0; tz < n_tiles_z; ++tz) {
        for (int ty = 0; ty < n_tiles_y; ++ty) {
            for (int tx = 0; tx < n_tiles_x; ++tx) {
                int t_idx = tx + ty * n_tiles_x + tz * n_tiles_x * n_tiles_y;
                auto& tile = states_pool[t_idx];
                auto& u_tile = U_pool[t_idx];

                for (int k = 0; k < TILE_SIZE_3D; ++k) {
                    int gz = tz * TILE_SIZE_3D + k;
                    if (gz >= nz) continue;
                    double z_c = zmin + (gz + 0.5) * cellSize;
                    for (int j = 0; j < TILE_SIZE_3D; ++j) {
                        int gy = ty * TILE_SIZE_3D + j;
                        if (gy >= ny) continue;
                        for (int i = 0; i < TILE_SIZE_3D; ++i) {
                            int gx = tx * TILE_SIZE_3D + i;
                            if (gx >= nx) continue;
                            int c_idx = i + j * TILE_SIZE_3D + k * TILE_SIZE_3D * TILE_SIZE_3D;

                            double cell_p = strat_snapped.p_atm;
                            double cell_rho = strat_snapped.air_rho;
                            double cell_E = 0.0;
                            CellState3D<IsMultiMaterial> temp_s{};

                            if (z_c > strat_snapped.water_surface_z) {
                                // Zone 1: Atmosphere (Hydrostatic Air Column)
                                double z_air_depth = z_c - strat_snapped.water_surface_z;
                                cell_p = strat_snapped.p_atm - strat_snapped.air_rho * g_mag * z_air_depth;
                                cell_rho = strat_snapped.air_rho;
                                cell_E = getEnergy3D<IsMultiMaterial>(cell_p, cell_rho, temp_s, gamma, this->currentMaterials.products, this->currentMaterials.unreacted);
                            } else if (z_c >= strat_snapped.seabed_surface_z) {
                                // Zone 2: Seawater column (Modified Tait EOS)
                                double p_h = 0.0, rho_h = 0.0, e_h = 0.0;
                                Blast::TaitEOSWater::compute_hydrostatic_state(
                                    z_c, strat_snapped.water_surface_z, g_mag, strat_snapped.p_atm,
                                    p_h, rho_h, e_h, strat_snapped.tait_B, strat_snapped.tait_gamma, strat_snapped.tait_rho0
                                );
                                cell_p = p_h;
                                cell_rho = rho_h;
                                if constexpr (IsMultiMaterial) {
                                    cell_E = cell_rho * e_h;
                                } else if (this->is_water_tait_val) {
                                    cell_E = cell_rho * e_h;
                                } else {
                                    cell_E = cell_p / (gamma - 1.0);
                                }
                            } else {
                                // Zone 3: Geotechnical Seabed
                                double p_bed = 0.0, rho_bed = 0.0, e_bed = 0.0;
                                Blast::TaitEOSWater::compute_hydrostatic_state(
                                    strat_snapped.seabed_surface_z, strat_snapped.water_surface_z, g_mag, strat_snapped.p_atm,
                                    p_bed, rho_bed, e_bed, strat_snapped.tait_B, strat_snapped.tait_gamma, strat_snapped.tait_rho0
                                );
                                double sig_v = 0.0, u_p = 0.0, sig_h = 0.0;
                                Blast::TaitEOSWater::compute_geostatic_stress(
                                    z_c, strat_snapped.seabed_surface_z, p_bed, strat_snapped.soil_density, strat_snapped.tait_rho0, g_mag, strat_snapped.k0_earth_pressure,
                                    sig_v, u_p, sig_h
                                );
                                cell_p = sig_v;
                                double gamma_soil = strat_snapped.soil_gamma > 0.0 ? strat_snapped.soil_gamma : 4.0;
                                double rho0_soil = strat_snapped.soil_density > 0.0 ? strat_snapped.soil_density : 2000.0;
                                double c0_soil = strat_snapped.soil_c0 > 0.0 ? strat_snapped.soil_c0 : 2500.0;
                                double B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
                                double p0_soil = strat_snapped.p_atm;
                                cell_rho = Blast::TaitEOSWater::compute_density_isentropic(
                                    cell_p, B_soil, gamma_soil, rho0_soil, p0_soil
                                );
                                double e_soil = Blast::TaitEOSWater::compute_energy_isentropic(cell_rho, B_soil, gamma_soil, rho0_soil);
                                cell_E = cell_rho * e_soil;
                            }

                            tile.rho[c_idx] = (RealType)cell_rho;
                            tile.ux[c_idx] = 0.0;
                            tile.uy[c_idx] = 0.0;
                            tile.uz[c_idx] = 0.0;
                            tile.p[c_idx] = (RealType)cell_p;
                            tile.floor_status[c_idx] = 0;
                            tile.peak_overpressure[c_idx] = 0.0;
                            tile.peak_impulse[c_idx] = 0.0;

                            if constexpr (IsMultiMaterial) {
                                tile.alpha1[c_idx] = 0.0;
                                tile.alpha2[c_idx] = 0.0;
                                tile.arho1[c_idx] = 0.0;
                                tile.arho2[c_idx] = 0.0;
                            }

                            u_tile.rho[c_idx] = (RealType)cell_rho;
                            u_tile.rhoux[c_idx] = 0.0;
                            u_tile.rhouy[c_idx] = 0.0;
                            u_tile.rhouz[c_idx] = 0.0;
                            u_tile.E[c_idx] = (RealType)cell_E;

                            if constexpr (IsMultiMaterial) {
                                u_tile.alpha1[c_idx] = 0.0;
                                u_tile.alpha2[c_idx] = 0.0;
                                u_tile.arho1[c_idx] = 0.0;
                                u_tile.arho2[c_idx] = 0.0;
                            }
                        }
                    }
                }
            }
        }
    }

    if (charge.radius > 0.0 || charge.lx > 0.0) {
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
                                            if (charge.shape_type == 0) {
                                                double dist_sq = dx*dx + dy*dy + dz*dz;
                                                if (dist_sq <= charge.radius * charge.radius) inside = true;
                                            } else if (charge.shape_type == 1) {
                                                if (std::abs(x_loc) <= charge.lx*0.5 && std::abs(y_loc) <= charge.ly*0.5 && std::abs(z_loc) <= charge.lz*0.5) inside = true;
                                            } else if (charge.shape_type == 2) {
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
                                        tile.rho[c_idx] = ((RealType)1.0 - (RealType)f_vol) * tile.rho[c_idx] + tile.arho2[c_idx];
                                        RealType p_solid = (RealType)MultiMat::getReferencePressure_Unreacted<RealType>(materials.unreacted);
                                        tile.p[c_idx] = ((RealType)1.0 - f_vol) * tile.p[c_idx] + f_vol * std::max(tile.p[c_idx], p_solid);
                                        temp_s.alpha1 = (double)tile.alpha1[c_idx]; temp_s.alpha2 = (double)tile.alpha2[c_idx];
                                        temp_s.arho1 = (double)tile.arho1[c_idx]; temp_s.arho2 = (double)tile.arho2[c_idx];
                                    } else {
                                        tile.rho[c_idx] = (RealType)(f_vol * materials.unreacted.rho0 + (1.0 - f_vol) * (double)tile.rho[c_idx]);
                                        double p_high = (gamma - 1.0) * materials.unreacted.rho0 * materials.detonation_energy;
                                        tile.p[c_idx] = (RealType)(f_vol * p_high + (1.0 - f_vol) * (double)tile.p[c_idx]);
                                    }
                                    auto& u_tile = U_pool[t_idx];
                                    u_tile.rho[c_idx] = tile.rho[c_idx];
                                    u_tile.rhoux[c_idx] = 0.0;
                                    u_tile.rhouy[c_idx] = 0.0;
                                    u_tile.rhouz[c_idx] = 0.0;
                                    u_tile.E[c_idx] = (RealType)getEnergy3D<IsMultiMaterial>((double)tile.p[c_idx], (double)tile.rho[c_idx], temp_s, gamma, this->currentMaterials.products, this->currentMaterials.unreacted);
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
    }
    updateActiveRegions();
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::updateActiveRegions() {
    int total_tiles = n_tiles_x * n_tiles_y * n_tiles_z;
    std::vector<uint8_t> physically_active(total_tiles, 0);

    if (stratified_params.enabled) {
        std::fill(physically_active.begin(), physically_active.end(), 1);
    } else {
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
                        double a1 = 0.0, a2 = 0.0;
                        if constexpr (IsMultiMaterial) {
                            a1 = (double)tile.alpha1[i];
                            a2 = (double)tile.alpha2[i];
                        }
                        if (a1 > 1e-4 || a2 > 1e-4 || dp > 1e-3 * ambient_p || u2 > 1e-2) {
                            active = true;
                            break;
                        }
                    }
                    physically_active[t_idx] = active ? 1 : 0;
                }
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
    int dir, RealType gamma, const MultiMat::JWLParams& products, const MultiMat::JWLParams& unreacted,
    bool is_water = false, const Blast::TaitEOSParams* tait = nullptr) {
    
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
    if (is_water && tait) {
        CellState3D<IsMultiMaterial> sL_tmp{}, sR_tmp{};
        sL_tmp.ux = sL.ux; sL_tmp.uy = sL.uy; sL_tmp.uz = sL.uz; sL_tmp.p = sL.p; sL_tmp.E = sL.E; sL_tmp.rho = sL.rho;
        sR_tmp.ux = sR.ux; sR_tmp.uy = sR.uy; sR_tmp.uz = sR.uz; sR_tmp.p = sR.p; sR_tmp.E = sR.E; sR_tmp.rho = sR.rho;
        cL = (RealType)getSoundSpeed3D<IsMultiMaterial>((double)sL.p, (double)sL.rho, sL_tmp, (double)gamma, products, unreacted, true, tait);
        cR = (RealType)getSoundSpeed3D<IsMultiMaterial>((double)sR.p, (double)sR.rho, sR_tmp, (double)gamma, products, unreacted, true, tait);
    } else if constexpr (IsMultiMaterial) {
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
    int dir, RealType gamma, const MultiMat::JWLParams& products, const MultiMat::JWLParams& unreacted,
    bool is_water = false, const Blast::TaitEOSParams* tait = nullptr,
    RealType z_cL = (RealType)0.0, RealType z_cR = (RealType)0.0,
    bool has_gravity = false, RealType gravity_z = (RealType)0.0) {
    
    RealType aL, aR;
    if (is_water && tait) {
        CellState3D<IsMultiMaterial> sL_tmp{}, sR_tmp{};
        sL_tmp.ux = sL.ux; sL_tmp.uy = sL.uy; sL_tmp.uz = sL.uz; sL_tmp.p = sL.p; sL_tmp.E = sL.E; sL_tmp.rho = sL.rho;
        sR_tmp.ux = sR.ux; sR_tmp.uy = sR.uy; sR_tmp.uz = sR.uz; sR_tmp.p = sR.p; sR_tmp.E = sR.E; sR_tmp.rho = sR.rho;
        aL = (RealType)getSoundSpeed3D<IsMultiMaterial>((double)sL.p, (double)sL.rho, sL_tmp, (double)gamma, products, unreacted, true, tait);
        aR = (RealType)getSoundSpeed3D<IsMultiMaterial>((double)sR.p, (double)sR.rho, sR_tmp, (double)gamma, products, unreacted, true, tait);
    } else if constexpr (IsMultiMaterial) {
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
    
    // AUSM+-up stabilization terms to prevent carbuncle/cube artifacts with Liou (2006) shock cutoff
    RealType M_bar_sq = (sL.ux*sL.ux + sL.uy*sL.uy + sL.uz*sL.uz + sR.ux*sR.ux + sR.uy*sR.uy + sR.uz*sR.uz) / ((RealType)2.0 * a_half * a_half);
    RealType fa = (M_bar_sq < (RealType)1.0) ? ((RealType)1.0 - M_bar_sq) : (RealType)0.0;
    RealType rho_half = (RealType)0.5 * (sL.rho + sR.rho);

    bool is_large_density_jump = (sL.rho > (RealType)1.5 * sR.rho || sR.rho > (RealType)1.5 * sL.rho);
    if (is_large_density_jump) {
        RealType zL_ausm = std::max((RealType)1e-3, sL.rho * aL);
        RealType zR_ausm = std::max((RealType)1e-3, sR.rho * aR);
        rho_half = (RealType)2.0 * sL.rho * sR.rho / (sL.rho + sR.rho);
        p_half_unmod = (zR_ausm * sL.p + zL_ausm * sR.p) / (zL_ausm + zR_ausm);
    }

    RealType dp_wave = sR.p - sL.p;

    RealType p_scale = (is_water && tait) ? (RealType)tait->B : std::min(sL.p, sR.p);
    RealType dp_rel = (p_scale > (RealType)1e-6) ? (std::abs(dp_wave) / p_scale) : (RealType)0.0;
    RealType shock_sense = (dp_rel > (RealType)0.2) ? ((RealType)1.0 / ((RealType)1.0 + dp_rel * dp_rel)) : (RealType)1.0;
    RealType Kp = (RealType)0.25 * fa * shock_sense;
    RealType Ku = (RealType)0.75 * shock_sense;
    if (is_large_density_jump || (dir == 2 && has_gravity && std::abs(uL) < (RealType)1.0e-3 && std::abs(uR) < (RealType)1.0e-3)) {
        Kp = (RealType)0.0;
        if (is_large_density_jump) Ku = (RealType)0.0;
    }
    
    RealType M_half = M_half_unmod - Kp * dp_wave / std::max((RealType)1e-6, rho_half * a_half * a_half);
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
    RealType side, int spatialOrder, RealType gamma, const MultiMat::JWLParams& products, const MultiMat::JWLParams& unreacted,
    bool is_water = false, const Blast::TaitEOSParams* tait = nullptr) {
    
    typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial> res;
    
    if (spatialOrder == 1) {
        RealType ke = (RealType)0.5 * sC.rho * (sC.ux*sC.ux + sC.uy*sC.uy + sC.uz*sC.uz);
        res = sC;
        if constexpr (IsMultiMaterial) {
            res.E = MultiMat::getMixtureEnergy(res.p, res.rho, res.alpha1, res.alpha2, res.arho1, res.arho2, gamma, products, unreacted) + ke;
        } else if (is_water && tait) {
            CellState3D<IsMultiMaterial> s_tmp{};
            s_tmp.rho = res.rho;
            res.E = (RealType)getEnergy3D<IsMultiMaterial>((double)res.p, (double)res.rho, s_tmp, (double)gamma, products, unreacted, true, tait) + ke;
        } else {
            res.E = res.p / (gamma - (RealType)1.0) + ke;
        }
        return res;
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
    } else if (is_water && tait) {
        CellState3D<IsMultiMaterial> s_tmp{};
        s_tmp.rho = res.rho;
        res.E = (RealType)getEnergy3D<IsMultiMaterial>((double)res.p, (double)res.rho, s_tmp, (double)gamma, products, unreacted, true, tait) + ke;
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

                        auto is_solid_cell = [&](int x, int y, int z) -> bool {
                            if (geom_pool.empty()) return false;
                            if (x < 0) return bcXmin == BCType3D::REFLECTIVE;
                            if (x >= nx) return bcXmax == BCType3D::REFLECTIVE;
                            if (y < 0) return bcYmin == BCType3D::REFLECTIVE;
                            if (y >= ny) return bcYmax == BCType3D::REFLECTIVE;
                            if (z < 0) return bcZmin == BCType3D::REFLECTIVE;
                            if (z >= nz) return bcZmax == BCType3D::REFLECTIVE;
                            int t_idx = (x >> 3) + (y >> 3) * n_tiles_x + (z >> 3) * n_tiles_x * n_tiles_y;
                            int c_idx = (x & 7) + (y & 7) * 8 + (z & 7) * 64;
                            return geom_pool[t_idx].cells[c_idx].is_boundary;
                        };

                        RealType dt_dx = dt_r * invDx;

                        auto sample_func = [&](int tx_val, int ty_val, int tz_val, int qx_val, int qy_val, int qz_val, int dir_val) {
                            if (is_interior_tile) {
                                return sampleStateInternal(tx_val, ty_val, tz_val);
                            } else {
                                return sampleStateInternalIDW(tx_val, ty_val, tz_val, qx_val, qy_val, qz_val, dir_val);
                            }
                        };

                        auto compute_face_flux = [&](int dir,
                                                     int xL, int yL, int zL,
                                                     int xR, int yR, int zR,
                                                     int xLL, int yLL, int zLL,
                                                     int xRR, int yRR, int zRR) -> Flux3DT<RealType, IsMultiMaterial> {
                            bool solid_L = !is_interior_tile && is_solid_cell(xL, yL, zL);
                            bool solid_R = !is_interior_tile && is_solid_cell(xR, yR, zR);
                            if (solid_L && solid_R) {
                                return Flux3DT<RealType, IsMultiMaterial>{};
                            }
                            if (solid_L || solid_R) {
                                // Physically correct inviscid slip-wall boundary flux.
                                // Static wall: zero mass/energy flux, pure pressure in normal direction.
                                // Moving wall (FSI): p_wall * vn_wall work term (zero for static obstacles)
                                auto sL1 = sample_func(xL, yL, zL, gx, gy, gz, dir);
                                auto sR1 = sample_func(xR, yR, zR, gx, gy, gz, dir);
                                const auto& s_fluid = solid_L ? sR1 : sL1;
                                RealType p_wall = s_fluid.p;
                                RealType vn_wall = (RealType)0.0;
                                if (!solid_vel_tiles.empty()) {
                                    int s_gx = solid_L ? xL : xR;
                                    int s_gy = solid_L ? yL : yR;
                                    int s_gz = solid_L ? zL : zR;
                                    int tx = s_gx / 8, ty = s_gy / 8, tz = s_gz / 8;
                                    int ntx_dim = (nx + 7) / 8, nty_dim = (ny + 7) / 8;
                                    int t_idx = tx + ty * ntx_dim + tz * ntx_dim * nty_dim;
                                    int cx = s_gx % 8, cy = s_gy % 8, cz = s_gz % 8;
                                    int c_idx = cx + cy * 8 + cz * 64;
                                    if (t_idx >= 0 && t_idx < (int)solid_vel_tiles.size()) {
                                        vn_wall = (dir == 0) ? (RealType)solid_vel_tiles[t_idx].vx[c_idx] :
                                                  ((dir == 1) ? (RealType)solid_vel_tiles[t_idx].vy[c_idx] : (RealType)solid_vel_tiles[t_idx].vz[c_idx]);
                                    }
                                }
                                Flux3DT<RealType, IsMultiMaterial> flx{};
                                flx.rho = (RealType)0.0;
                                flx.rhoux = (dir == 0) ? p_wall : (RealType)0.0;
                                flx.rhouy = (dir == 1) ? p_wall : (RealType)0.0;
                                flx.rhouz = (dir == 2) ? p_wall : (RealType)0.0;
                                flx.E = p_wall * vn_wall;
                                flx.v_face = vn_wall;
                                return flx;
                            }
                            int eff_order = spatialOrder;
                            if (!is_interior_tile && (is_solid_cell(xLL, yLL, zLL) || is_solid_cell(xRR, yRR, zRR))) {
                                eff_order = 1;
                            }
                            if (this->stratified_params.enabled) {
                                RealType z_L1 = (RealType)this->zmin + ((RealType)zL + (RealType)0.5) * (RealType)this->cellSize;
                                RealType z_R1 = (RealType)this->zmin + ((RealType)zR + (RealType)0.5) * (RealType)this->cellSize;
                                bool soil_L = (z_L1 < (RealType)this->stratified_params.seabed_surface_z);
                                bool soil_R = (z_R1 < (RealType)this->stratified_params.seabed_surface_z);
                                bool water_L = (z_L1 <= (RealType)this->stratified_params.water_surface_z);
                                bool water_R = (z_R1 <= (RealType)this->stratified_params.water_surface_z);
                                if (soil_L != soil_R || water_L != water_R) {
                                    eff_order = 1;
                                }
                            }
                            auto sL2 = sample_func(xLL, yLL, zLL, gx, gy, gz, dir);
                            auto sL1 = sample_func(xL, yL, zL, gx, gy, gz, dir);
                            auto sR1 = sample_func(xR, yR, zR, gx, gy, gz, dir);
                            auto sR2 = sample_func(xRR, yRR, zRR, gx, gy, gz, dir);
                            auto wL = reconstruct<RealType, IsMultiMaterial>(sL2, sL1, sR1, (RealType)0.5, eff_order, gamma_r, currentMaterials.products, currentMaterials.unreacted, this->is_water_tait_val, &this->tait_water_params);
                            auto wR = reconstruct<RealType, IsMultiMaterial>(sL1, sR1, sR2, (RealType)-0.5, eff_order, gamma_r, currentMaterials.products, currentMaterials.unreacted, this->is_water_tait_val, &this->tait_water_params);
                            RealType z_cL = (RealType)this->zmin + ((RealType)zL + (RealType)0.5) * (RealType)this->cellSize;
                            RealType z_cR = (RealType)this->zmin + ((RealType)zR + (RealType)0.5) * (RealType)this->cellSize;
                            bool has_g = this->stratified_params.enabled || std::abs(this->gravity_z) > 1e-6;
                            RealType g_z = (RealType)(this->stratified_params.enabled ? this->stratified_params.gravity_z : this->gravity_z);

                            if (this->stratified_params.enabled && dir == 2 && has_g) {
                                bool soil_L = (z_cL < (RealType)this->stratified_params.seabed_surface_z);
                                bool soil_R = (z_cR < (RealType)this->stratified_params.seabed_surface_z);
                                bool water_L = (z_cL <= (RealType)this->stratified_params.water_surface_z);
                                bool water_R = (z_cR <= (RealType)this->stratified_params.water_surface_z);
                                if (soil_L != soil_R || water_L != water_R) {
                                    wL.p = sL1.p + (RealType)0.5 * sL1.rho * g_z * (RealType)this->cellSize;
                                    wR.p = sR1.p - (RealType)0.5 * sR1.rho * g_z * (RealType)this->cellSize;
                                }
                            }

                            auto flx = useAUSM ? getAUSMPlusFlux3D<RealType, IsMultiMaterial>(wL, wR, dir, gamma_r, currentMaterials.products, currentMaterials.unreacted, this->is_water_tait_val, &this->tait_water_params, z_cL, z_cR, has_g, g_z)
                                           : getRusanovFlux3D<RealType, IsMultiMaterial>(wL, wR, dir, gamma_r, currentMaterials.products, currentMaterials.unreacted, this->is_water_tait_val, &this->tait_water_params);
                            return flx;
                        };

                        // X-Fluxes
                        auto fxL = compute_face_flux(0, gx - 1, gy, gz, gx, gy, gz, gx - 2, gy, gz, gx + 1, gy, gz);
                        auto fxR = compute_face_flux(0, gx, gy, gz, gx + 1, gy, gz, gx - 1, gy, gz, gx + 2, gy, gz);

                        // Y-Fluxes
                        auto fyB = compute_face_flux(1, gx, gy - 1, gz, gx, gy, gz, gx, gy - 2, gz, gx, gy + 1, gz);
                        auto fyT = compute_face_flux(1, gx, gy, gz, gx, gy + 1, gz, gx, gy - 1, gz, gx, gy + 2, gz);

                        // Z-Fluxes
                        auto fzD = compute_face_flux(2, gx, gy, gz - 1, gx, gy, gz, gx, gy, gz - 2, gx, gy, gz + 1);
                        auto fzU = compute_face_flux(2, gx, gy, gz, gx, gy, gz + 1, gx, gy, gz - 1, gx, gy, gz + 2);

                        u.rho[idx] -= dt_dx * (fxR.rho - fxL.rho + fyT.rho - fyB.rho + fzU.rho - fzD.rho);
                        u.rhoux[idx] -= dt_dx * (fxR.rhoux - fxL.rhoux + fyT.rhoux - fyB.rhoux + fzU.rhoux - fzD.rhoux);
                        u.rhouy[idx] -= dt_dx * (fxR.rhouy - fxL.rhouy + fyT.rhouy - fyB.rhouy + fzU.rhouy - fzD.rhouy);
                        u.rhouz[idx] -= dt_dx * (fxR.rhouz - fxL.rhouz + fyT.rhouz - fyB.rhouz + fzU.rhouz - fzD.rhouz);
                        u.E[idx] -= dt_dx * (fxR.E - fxL.E + fyT.E - fyB.E + fzU.E - fzD.E);

                        if constexpr (IsMultiMaterial) {
                            u.alpha1[idx] -= dt_dx * (fxR.alpha1 - fxL.alpha1 + fyT.alpha1 - fyB.alpha1 + fzU.alpha1 - fzD.alpha1);
                            u.alpha2[idx] -= dt_dx * (fxR.alpha2 - fxL.alpha2 + fyT.alpha2 - fyB.alpha2 + fzU.alpha2 - fzD.alpha2);
                            
                            RealType div_u = fxR.v_face - fxL.v_face + fyT.v_face - fyB.v_face + fzU.v_face - fzD.v_face;
                            u.alpha1[idx] += dt_dx * sC.alpha1 * div_u;
                            u.alpha2[idx] += dt_dx * sC.alpha2 * div_u;

                            u.arho1[idx] -= dt_dx * (fxR.arho1 - fxL.arho1 + fyT.arho1 - fyB.arho1 + fzU.arho1 - fzD.arho1);
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
                        if (currentMaterials.afterburn.enabled) {
                            RealType arho0 = u.rho[c_idx] - u.arho1[c_idx] - u.arho2[c_idx];
                            RealType ke = (RealType)0.5 * (u.rhoux[c_idx] * u.rhoux[c_idx] + u.rhouy[c_idx] * u.rhouy[c_idx] + u.rhouz[c_idx] * u.rhouz[c_idx]) / u.rho[c_idx];
                            RealType R_ch = (RealType)charge_radius;
                            RealType tmp_alpha1_ab = u.alpha1[c_idx];
                            RealType tmp_arho1_ab = u.arho1[c_idx];

                            RealType vort_mag = (RealType)0.0;
                            if (i > 0 && i < TILE_SIZE_3D - 1 && j > 0 && j < TILE_SIZE_3D - 1 && k > 0 && k < TILE_SIZE_3D - 1) {
                                int c_px = c_idx + 1;
                                int c_mx = c_idx - 1;
                                int c_py = c_idx + TILE_SIZE_3D;
                                int c_my = c_idx - TILE_SIZE_3D;
                                int c_pz = c_idx + TILE_SIZE_3D * TILE_SIZE_3D;
                                int c_mz = c_idx - TILE_SIZE_3D * TILE_SIZE_3D;

                                RealType inv_rho_py = (RealType)1.0 / u.rho[c_py];
                                RealType inv_rho_my = (RealType)1.0 / u.rho[c_my];
                                RealType inv_rho_pz = (RealType)1.0 / u.rho[c_pz];
                                RealType inv_rho_mz = (RealType)1.0 / u.rho[c_mz];
                                RealType inv_rho_px = (RealType)1.0 / u.rho[c_px];
                                RealType inv_rho_mx = (RealType)1.0 / u.rho[c_mx];

                                RealType ux_py = u.rhoux[c_py] * inv_rho_py;
                                RealType ux_my = u.rhoux[c_my] * inv_rho_my;
                                RealType ux_pz = u.rhoux[c_pz] * inv_rho_pz;
                                RealType ux_mz = u.rhoux[c_mz] * inv_rho_mz;

                                RealType uy_px = u.rhouy[c_px] * inv_rho_px;
                                RealType uy_mx = u.rhouy[c_mx] * inv_rho_mx;
                                RealType uy_pz = u.rhouy[c_pz] * inv_rho_pz;
                                RealType uy_mz = u.rhouy[c_mz] * inv_rho_mz;

                                RealType uz_px = u.rhouz[c_px] * inv_rho_px;
                                RealType uz_mx = u.rhouz[c_mx] * inv_rho_mx;
                                RealType uz_py = u.rhouz[c_py] * inv_rho_py;
                                RealType uz_my = u.rhouz[c_my] * inv_rho_my;

                                RealType inv_2dx = (RealType)0.5 / (RealType)cellSize;
                                RealType wx = (uz_py - uz_my - (uy_pz - uy_mz)) * inv_2dx;
                                RealType wy = (ux_pz - ux_mz - (uz_px - uz_mx)) * inv_2dx;
                                RealType wz = (uy_px - uy_mx - (ux_py - ux_my)) * inv_2dx;
                                using std::sqrt;
                                vort_mag = sqrt(wx * wx + wy * wy + wz * wz);
                            }

                            MultiMat::computeAfterburn(
                                (RealType)dt, (RealType)currentTime, R_ch, (RealType)currentMaterials.det_vel,
                                currentMaterials.afterburn,
                                u.rho[c_idx], tmp_alpha1_ab, tmp_arho1_ab, arho0, u.E[c_idx], ke,
                                vort_mag
                            );
                            u.alpha1[c_idx] = tmp_alpha1_ab;
                            u.arho1[c_idx] = tmp_arho1_ab;
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

    // Pre-compute stratified hydrostatic recovery constants for bad-cell fallback.
    // CRITICAL: bad cells in soil/water zones MUST recover to their correct hydrostatic
    // reference state, NOT to ambient air. Resetting soil/water cells to ambient air
    // (rho~1.2, p~101325) was the root cause of the seabed/water interface instability
    // and the persistent solid blue-line colormap artifact.
    const bool   strat_en        = stratified_params.enabled;
    const double strat_seabed_z  = stratified_params.seabed_surface_z;
    const double strat_water_z   = stratified_params.water_surface_z;
    const double strat_g_mag     = std::abs(stratified_params.gravity_z);
    const double strat_p_atm_r   = stratified_params.p_atm;
    const double strat_tait_B    = stratified_params.tait_B;
    const double strat_tait_g    = stratified_params.tait_gamma;
    const double strat_tait_r0   = stratified_params.tait_rho0;
    const double strat_rho_soil  = (stratified_params.soil_density > 0.0) ? stratified_params.soil_density : 2000.0;
    const double strat_c0_soil   = (stratified_params.soil_c0 > 0.0)      ? stratified_params.soil_c0      : 2500.0;
    const double strat_gam_soil  = (stratified_params.soil_gamma > 0.0)   ? stratified_params.soil_gamma   : 4.0;
    const double strat_pcav_soil = (stratified_params.soil_p_cav != 0.0)  ? stratified_params.soil_p_cav  : -1.0e5;

    #pragma omp parallel for schedule(guided)
    for (int a = 0; a < n_active; ++a) {
        int t = active_tile_indices[a];
        auto& s = states_pool[t];
        auto& u = U_pool[t];
        // Tile z-index for per-cell z-coordinate computation in stratified fallback.
        int tz_tile = t / (n_tiles_x * n_tiles_y);
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
                    int tz = t / (n_tiles_x * n_tiles_y);
                    int k = i / (TILE_SIZE_3D * TILE_SIZE_3D);
                    int gz = tz * TILE_SIZE_3D + k;
                    RealType z_c = (RealType)zmin + ((RealType)gz + (RealType)0.5) * (RealType)cellSize;
                    bool is_water = false;
                    bool is_soil = false;
                    bool is_he = (s.alpha1[i] > (RealType)0.02 || s.alpha2[i] > (RealType)0.02);
                    if (this->stratified_params.enabled) {
                        if (z_c < (RealType)this->stratified_params.seabed_surface_z) {
                            is_water = false;
                            is_soil = true;
                        } else if (z_c <= (RealType)this->stratified_params.water_surface_z) {
                            is_water = true;
                        } else if (!is_he) {
                            is_water = (s.rho[i] >= (RealType)800.0);
                        }
                    } else if (!is_he && this->is_water_tait_val) {
                        is_water = (s.rho[i] > (RealType)100.0);
                    }
                    RealType p_val;
                    if (is_water) {
                        p_val = MultiMat::getMixturePressureTait<RealType>(e_int, s.rho[i], s.alpha1[i], s.alpha2[i], s.arho1[i], s.arho2[i], this->tait_water_params, currentMaterials.products, currentMaterials.unreacted);
                    } else if (is_soil) {
                        RealType gamma_soil = (RealType)(this->stratified_params.soil_gamma > 0.0 ? this->stratified_params.soil_gamma : 4.0);
                        RealType rho0_soil = (RealType)(this->stratified_params.soil_density > 0.0 ? this->stratified_params.soil_density : 2000.0);
                        RealType c0_soil = (RealType)(this->stratified_params.soil_c0 > 0.0 ? this->stratified_params.soil_c0 : 2500.0);
                        RealType B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
                        RealType p0_soil = (RealType)this->stratified_params.p_atm;
                        RealType p_cav_soil = (RealType)(this->stratified_params.soil_p_cav != 0.0 ? this->stratified_params.soil_p_cav : -1.0e5);
                        p_val = (RealType)Blast::TaitEOSWater::compute_pressure_isentropic((double)s.rho[i], (double)B_soil, (double)gamma_soil, (double)rho0_soil, (double)p_cav_soil, (double)p0_soil);
                    } else {
                        p_val = MultiMat::getMixturePressure(e_int, s.rho[i], s.alpha1[i], s.alpha2[i], s.arho1[i], s.arho2[i], gamma_r, currentMaterials.products, currentMaterials.unreacted);
                    }
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
                    RealType p_val;
                    if (this->is_water_tait_val) {
                        CellState3D<IsMultiMaterial> s_tmp{};
                        s_tmp.rho = s.rho[i];
                        p_val = (RealType)getPressure3D<IsMultiMaterial>((double)e_int, (double)s.rho[i], s_tmp, (double)gamma, currentMaterials.products, currentMaterials.unreacted, true, &this->tait_water_params);
                    } else {
                        p_val = e_int * (gamma_r - (RealType)1.0);
                    }
                    if (std::isnan(p_val) || std::isinf(p_val) || (!this->is_water_tait_val && p_val < (RealType)1e-8)) {
                        bad = true;
                    } else {
                        s.p[i] = p_val;
                    }
                }
            }

            if (bad) {
                // Recover to the correct hydrostatic reference state for this cell's zone.
                // For soil/water cells, this is their Tait EOS hydrostatic state — NOT air.
                double rec_rho = ambient_rho;
                double rec_p   = ambient_p;
                if (strat_en) {
                    // Compute cell z-coordinate
                    int k_local = i / (TILE_SIZE_3D * TILE_SIZE_3D);
                    int gz_cell = tz_tile * TILE_SIZE_3D + k_local;
                    double z_c  = zmin + (gz_cell + 0.5) * cellSize;
                    if (z_c < strat_seabed_z) {
                        // Soil zone: Tait isentropic EOS at geostatic pressure
                        double p_bed = 0.0, rho_bed_unused = 0.0, e_bed_unused = 0.0;
                        Blast::TaitEOSWater::compute_hydrostatic_state(
                            strat_seabed_z, strat_water_z, strat_g_mag, strat_p_atm_r,
                            p_bed, rho_bed_unused, e_bed_unused, strat_tait_B, strat_tait_g, strat_tait_r0);
                        double sig_v = 0.0, u_pw = 0.0, sig_h = 0.0;
                        Blast::TaitEOSWater::compute_geostatic_stress(
                            z_c, strat_seabed_z, p_bed, strat_rho_soil, strat_tait_r0, strat_g_mag,
                            stratified_params.k0_earth_pressure, sig_v, u_pw, sig_h);
                        rec_p = std::max(sig_v, strat_p_atm_r);
                        double B_soil = (strat_rho_soil * strat_c0_soil * strat_c0_soil) / strat_gam_soil;
                        rec_rho = (double)Blast::TaitEOSWater::compute_density_isentropic(
                            rec_p, B_soil, strat_gam_soil, strat_rho_soil, strat_p_atm_r);
                    } else if (z_c <= strat_water_z) {
                        // Water zone: Tait EOS hydrostatic state
                        double p_h = 0.0, e_h = 0.0;
                        Blast::TaitEOSWater::compute_hydrostatic_state(
                            z_c, strat_water_z, strat_g_mag, strat_p_atm_r,
                            p_h, rec_rho, e_h, strat_tait_B, strat_tait_g, strat_tait_r0);
                        rec_p = p_h;
                    }
                    // Air zone: falls through to ambient_rho / ambient_p
                }
                s.rho[i] = (RealType)rec_rho;
                s.ux[i]  = 0.0;
                s.uy[i]  = 0.0;
                s.uz[i]  = 0.0;
                s.p[i]   = (RealType)rec_p;
                CellState3D<IsMultiMaterial> temp_s;
                if constexpr (IsMultiMaterial) {
                    temp_s.alpha1 = 0.0; temp_s.alpha2 = 0.0;
                    temp_s.arho1 = 0.0; temp_s.arho2 = 0.0;
                    s.alpha1[i] = 0.0; s.alpha2[i] = 0.0;
                    s.arho1[i] = 0.0; s.arho2[i] = 0.0;
                }
                u.rho[i]   = (RealType)rec_rho;
                u.rhoux[i] = 0.0;
                u.rhouy[i] = 0.0;
                u.rhouz[i] = 0.0;
                u.E[i]     = (RealType)getEnergy3D<IsMultiMaterial>(
                    rec_p, rec_rho, temp_s, gamma, currentMaterials.products,
                    currentMaterials.unreacted, this->is_water_tait_val, &this->tait_water_params);
                if constexpr (IsMultiMaterial) {
                    u.alpha1[i] = 0.0; u.alpha2[i] = 0.0;
                    u.arho1[i] = 0.0; u.arho2[i] = 0.0;
                }
                s.floor_status[i] = (s.floor_status[i] & 2) | 1;
            } else {
                s.floor_status[i] = (s.floor_status[i] & 2);
            }

            if (!geom_pool.empty() && geom_pool[t].cells[i].is_boundary) {
                s.rho[i] = (RealType)ambient_rho;
                if (!solid_vel_tiles.empty()) {
                    s.ux[i] = (RealType)solid_vel_tiles[t].vx[i];
                    s.uy[i] = (RealType)solid_vel_tiles[t].vy[i];
                    s.uz[i] = (RealType)solid_vel_tiles[t].vz[i];
                } else {
                    s.ux[i] = 0.0;
                    s.uy[i] = 0.0;
                    s.uz[i] = 0.0;
                }
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
    const MultiMat::JWLParams& products, const MultiMat::JWLParams& unreacted,
    bool is_water = false, const Blast::TaitEOSParams* tait = nullptr) {
    PhysicalFlux3D<RealType, IsMultiMaterial> f;
    RealType ke = (RealType)0.5 * s.rho * (s.ux*s.ux + s.uy*s.uy + s.uz*s.uz);
    RealType total_E;
    if constexpr (IsMultiMaterial) {
        total_E = (RealType)MultiMat::getMixtureEnergy((double)s.p, (double)s.rho, (double)s.alpha1, (double)s.alpha2, (double)s.arho1, (double)s.arho2, (double)gamma_val, products, unreacted) + ke;
    } else if (is_water && tait) {
        CellState3D<IsMultiMaterial> s_tmp{};
        s_tmp.rho = s.rho;
        total_E = (RealType)getEnergy3D<IsMultiMaterial>((double)s.p, (double)s.rho, s_tmp, (double)gamma_val, products, unreacted, true, tait) + ke;
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
    typename CFDSolver3DImpl<RealType, IsMultiMaterial>::template CellState3DT<RealType, IsMultiMaterial>& dW_dt,
    RealType gx = 0, RealType gy = 0, RealType gz = 0) {
    
    dW_dt.rho = -(sC.ux * d_x.rho + sC.rho * d_x.ux +
                  sC.uy * d_y.rho + sC.rho * d_y.uy +
                  sC.uz * d_z.rho + sC.rho * d_z.uz);
                  
    dW_dt.ux = -(sC.ux * d_x.ux + sC.uy * d_y.ux + sC.uz * d_z.ux + (RealType)1.0 / sC.rho * d_x.p) + gx;
    dW_dt.uy = -(sC.ux * d_x.uy + sC.uy * d_y.uy + sC.uz * d_z.uy + (RealType)1.0 / sC.rho * d_y.p) + gy;
    dW_dt.uz = -(sC.ux * d_x.uz + sC.uy * d_y.uz + sC.uz * d_z.uz + (RealType)1.0 / sC.rho * d_z.p) + gz;
    
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
    if (states_pred.size() != (size_t)total_tiles) states_pred.resize(total_tiles);
    if (dW_dt_pool.size() != (size_t)total_tiles) dW_dt_pool.resize(total_tiles);
    if (temporalOrder == 6 && states_int.size() != (size_t)total_tiles) states_int.resize(total_tiles);

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
                } else if (this->is_water_tait_val) {
                    CellState3D<IsMultiMaterial> s_tmp{};
                    s_tmp.rho = s.rho[i];
                    total_E = (RealType)getEnergy3D<IsMultiMaterial>((double)s.p[i], (double)s.rho[i], s_tmp, gamma, currentMaterials.products, currentMaterials.unreacted, true, &this->tait_water_params) + ke;
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

    copy_primitive_to_U();

    if (temporalOrder == 4 || temporalOrder <= 3) { // MUSCL-Hancock (2nd order default)
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
                                    CellState3DT<RealType, IsMultiMaterial>& out_s, RealType z_c = (RealType)0.0) {
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
                        bool is_water = false;
                        bool is_soil = false;
                        bool is_he = (out_s.alpha1 > (RealType)0.02 || out_s.alpha2 > (RealType)0.02);
                        if (this->stratified_params.enabled) {
                            if (z_c < (RealType)this->stratified_params.seabed_surface_z) {
                                is_water = false;
                                is_soil = true;
                            } else if (z_c <= (RealType)this->stratified_params.water_surface_z) {
                                is_water = true;
                            } else if (!is_he) {
                                is_water = (out_s.rho >= (RealType)800.0);
                            }
                        } else if (!is_he && this->is_water_tait_val) {
                            is_water = (out_s.rho > (RealType)100.0);
                        }
                        RealType p_val;
                        if (is_water) {
                            p_val = MultiMat::getMixturePressureTait<RealType>(e_int, out_s.rho, out_s.alpha1, out_s.alpha2, out_s.arho1, out_s.arho2, this->tait_water_params, currentMaterials.products, currentMaterials.unreacted);
                        } else if (is_soil) {
                            RealType gamma_soil = (RealType)(this->stratified_params.soil_gamma > 0.0 ? this->stratified_params.soil_gamma : 4.0);
                            RealType rho0_soil = (RealType)(this->stratified_params.soil_density > 0.0 ? this->stratified_params.soil_density : 2000.0);
                            RealType c0_soil = (RealType)(this->stratified_params.soil_c0 > 0.0 ? this->stratified_params.soil_c0 : 2500.0);
                            RealType B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
                            RealType p0_soil = (RealType)this->stratified_params.p_atm;
                            RealType p_cav_soil = (RealType)(this->stratified_params.soil_p_cav != 0.0 ? this->stratified_params.soil_p_cav : -1.0e5);
                            p_val = (RealType)Blast::TaitEOSWater::compute_pressure_isentropic((double)out_s.rho, (double)B_soil, (double)gamma_soil, (double)rho0_soil, (double)p_cav_soil, (double)p0_soil);
                        } else {
                            p_val = MultiMat::getMixturePressure(e_int, out_s.rho, out_s.alpha1, out_s.alpha2, out_s.arho1, out_s.arho2, gamma_r, currentMaterials.products, currentMaterials.unreacted);
                        }
                        if (std::isnan(p_val) || std::isinf(p_val) || p_val < (RealType)1e-8) {
                            bad = true;
                        } else {
                            out_s.p = p_val;
                            u_alpha1 = out_s.alpha1;
                            u_alpha2 = out_s.alpha2;
                            u_arho1 = out_s.arho1;
                            u_arho2 = out_s.arho2;
                        }
                    } else if (this->is_water_tait_val) {
                        CellState3D<IsMultiMaterial> s_tmp{};
                        s_tmp.rho = out_s.rho;
                        RealType p_val = (RealType)getPressure3D<IsMultiMaterial>((double)e_int, (double)out_s.rho, s_tmp, (double)gamma, currentMaterials.products, currentMaterials.unreacted, true, &this->tait_water_params);
                        if (std::isnan(p_val) || std::isinf(p_val)) {
                            bad = true;
                        } else {
                            out_s.p = p_val;
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
                        
                        auto W_xL = reconstruct<RealType, IsMultiMaterial>(sX_L, sC, sX_R, (RealType)-0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted, this->is_water_tait_val, &this->tait_water_params);
                        auto W_xR = reconstruct<RealType, IsMultiMaterial>(sX_L, sC, sX_R, (RealType)0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted, this->is_water_tait_val, &this->tait_water_params);
                        auto W_yB = reconstruct<RealType, IsMultiMaterial>(sY_B, sC, sY_T, (RealType)-0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted, this->is_water_tait_val, &this->tait_water_params);
                        auto W_yT = reconstruct<RealType, IsMultiMaterial>(sY_B, sC, sY_T, (RealType)0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted, this->is_water_tait_val, &this->tait_water_params);
                        auto W_zD = reconstruct<RealType, IsMultiMaterial>(sZ_D, sC, sZ_U, (RealType)-0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted, this->is_water_tait_val, &this->tait_water_params);
                        auto W_zU = reconstruct<RealType, IsMultiMaterial>(sZ_D, sC, sZ_U, (RealType)0.5, spatialOrder, gamma_r, currentMaterials.products, currentMaterials.unreacted, this->is_water_tait_val, &this->tait_water_params);
                        
                        auto F_L = getPhysicalFlux<RealType, IsMultiMaterial>(W_xL, 0, gamma_r, currentMaterials.products, currentMaterials.unreacted, this->is_water_tait_val, &this->tait_water_params);
                        auto F_R = getPhysicalFlux<RealType, IsMultiMaterial>(W_xR, 0, gamma_r, currentMaterials.products, currentMaterials.unreacted, this->is_water_tait_val, &this->tait_water_params);
                        auto G_B = getPhysicalFlux<RealType, IsMultiMaterial>(W_yB, 1, gamma_r, currentMaterials.products, currentMaterials.unreacted, this->is_water_tait_val, &this->tait_water_params);
                        auto G_T = getPhysicalFlux<RealType, IsMultiMaterial>(W_yT, 1, gamma_r, currentMaterials.products, currentMaterials.unreacted, this->is_water_tait_val, &this->tait_water_params);
                        auto H_D = getPhysicalFlux<RealType, IsMultiMaterial>(W_zD, 2, gamma_r, currentMaterials.products, currentMaterials.unreacted, this->is_water_tait_val, &this->tait_water_params);
                        auto H_U = getPhysicalFlux<RealType, IsMultiMaterial>(W_zU, 2, gamma_r, currentMaterials.products, currentMaterials.unreacted, this->is_water_tait_val, &this->tait_water_params);
                        
                        RealType dt_dx = (RealType)(0.5 * dt * invDx);
                        
                        RealType u_rho = sC.rho;
                        RealType u_rhoux = sC.rho * sC.ux;
                        RealType u_rhouy = sC.rho * sC.uy;
                        RealType u_rhouz = sC.rho * sC.uz;
                        RealType ke = (RealType)0.5 * sC.rho * (sC.ux*sC.ux + sC.uy*sC.uy + sC.uz*sC.uz);
                        RealType u_E;
                        if constexpr (IsMultiMaterial) {
                            u_E = MultiMat::getMixtureEnergy(sC.p, sC.rho, sC.alpha1, sC.alpha2, sC.arho1, sC.arho2, gamma_r, currentMaterials.products, currentMaterials.unreacted) + ke;
                        } else if (this->is_water_tait_val) {
                            CellState3D<IsMultiMaterial> s_tmp{};
                            s_tmp.rho = sC.rho;
                            u_E = (RealType)getEnergy3D<IsMultiMaterial>((double)sC.p, (double)sC.rho, s_tmp, gamma, currentMaterials.products, currentMaterials.unreacted, true, &this->tait_water_params) + ke;
                        } else {
                            u_E = sC.p / (gamma_r - (RealType)1.0) + ke;
                        }
                        
                        u_rho -= dt_dx * (F_R.rho - F_L.rho + G_T.rho - G_B.rho + H_U.rho - H_D.rho);
                        u_rhoux -= dt_dx * (F_R.rhoux - F_L.rhoux + G_T.rhoux - G_B.rhoux + H_U.rhoux - H_D.rhoux);
                        u_rhouy -= dt_dx * (F_R.rhouy - F_L.rhouy + G_T.rhouy - G_B.rhouy + H_U.rhouy - H_D.rhouy);
                        u_rhouz -= dt_dx * (F_R.rhouz - F_L.rhouz + G_T.rhouz - G_B.rhouz + H_U.rhouz - H_D.rhouz);
                        u_E -= dt_dx * (F_R.E - F_L.E + G_T.E - G_B.E + H_U.E - H_D.E);
                        if (this->gravity_x != 0.0 || this->gravity_y != 0.0 || this->gravity_z != 0.0) {
                            RealType half_dt = (RealType)(0.5 * dt);
                            u_rhoux += half_dt * sC.rho * (RealType)this->gravity_x;
                            u_rhouy += half_dt * sC.rho * (RealType)this->gravity_y;
                            u_rhouz += half_dt * sC.rho * (RealType)this->gravity_z;
                            u_E     += half_dt * (sC.rho * sC.ux * (RealType)this->gravity_x + sC.rho * sC.uy * (RealType)this->gravity_y + sC.rho * sC.uz * (RealType)this->gravity_z);
                        }
                        
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
                        RealType z_c = (RealType)zmin + ((RealType)gz + (RealType)0.5) * (RealType)cellSize;
                        cons_to_prim(u_rho, u_rhoux, u_rhouy, u_rhouz, u_E, u_alpha1, u_alpha2, u_arho1, u_arho2, pred_s, z_c);
                        
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
                        
                        auto is_solid_cell = [&](int x, int y, int z) -> bool {
                            if (geom_pool.empty()) return false;
                            if (x < 0) return bcXmin == BCType3D::REFLECTIVE;
                            if (x >= nx) return bcXmax == BCType3D::REFLECTIVE;
                            if (y < 0) return bcYmin == BCType3D::REFLECTIVE;
                            if (y >= ny) return bcYmax == BCType3D::REFLECTIVE;
                            if (z < 0) return bcZmin == BCType3D::REFLECTIVE;
                            if (z >= nz) return bcZmax == BCType3D::REFLECTIVE;
                            int t_idx = (x >> 3) + (y >> 3) * n_tiles_x + (z >> 3) * n_tiles_x * n_tiles_y;
                            int c_idx = (x & 7) + (y & 7) * 8 + (z & 7) * 64;
                            return geom_pool[t_idx].cells[c_idx].is_boundary;
                        };

                        bool solid_x_L = !is_interior_tile && is_solid_cell(gx - 1, gy, gz);
                        bool solid_x_R = !is_interior_tile && is_solid_cell(gx + 1, gy, gz);
                        bool is_confined_x = solid_x_L && solid_x_R;

                        bool solid_y_B = !is_interior_tile && is_solid_cell(gx, gy - 1, gz);
                        bool solid_y_T = !is_interior_tile && is_solid_cell(gx, gy + 1, gz);
                        bool is_confined_y = solid_y_B && solid_y_T;

                        bool solid_z_D = !is_interior_tile && is_solid_cell(gx, gy, gz - 1);
                        bool solid_z_U = !is_interior_tile && is_solid_cell(gx, gy, gz + 1);
                        bool is_confined_z = solid_z_D && solid_z_U;

                        CellState3DT<RealType, IsMultiMaterial> d_x, d_y, d_z;
                        if (is_confined_x) {
                            d_x.rho = 0; d_x.ux = 0; d_x.uy = 0; d_x.uz = 0; d_x.p = 0;
                            d_x.alpha1 = 0; d_x.alpha2 = 0; d_x.arho1 = 0; d_x.arho2 = 0;
                        } else if (solid_x_L || solid_x_R) {
                            // Suppress ALL slopes near solid boundaries
                            d_x.rho = 0; d_x.ux = 0; d_x.uy = 0; d_x.uz = 0; d_x.p = 0;
                            d_x.alpha1 = 0; d_x.alpha2 = 0; d_x.arho1 = 0; d_x.arho2 = 0;
                        } else {
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
                        }

                        if (is_confined_y) {
                            d_y.rho = 0; d_y.ux = 0; d_y.uy = 0; d_y.uz = 0; d_y.p = 0;
                            d_y.alpha1 = 0; d_y.alpha2 = 0; d_y.arho1 = 0; d_y.arho2 = 0;
                        } else if (solid_y_B || solid_y_T) {
                            // Suppress ALL slopes near solid boundaries
                            d_y.rho = 0; d_y.ux = 0; d_y.uy = 0; d_y.uz = 0; d_y.p = 0;
                            d_y.alpha1 = 0; d_y.alpha2 = 0; d_y.arho1 = 0; d_y.arho2 = 0;
                        } else {
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
                        }

                        if (is_confined_z) {
                            d_z.rho = 0; d_z.ux = 0; d_z.uy = 0; d_z.uz = 0; d_z.p = 0;
                            d_z.alpha1 = 0; d_z.alpha2 = 0; d_z.arho1 = 0; d_z.arho2 = 0;
                        } else if (solid_z_D || solid_z_U) {
                            // Suppress ALL slopes near solid boundaries
                            d_z.rho = 0; d_z.ux = 0; d_z.uy = 0; d_z.uz = 0; d_z.p = 0;
                            d_z.alpha1 = 0; d_z.alpha2 = 0; d_z.arho1 = 0; d_z.arho2 = 0;
                        } else {
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
                        }
                        
                        CellState3DT<RealType, IsMultiMaterial> dW_dt;
                        computeTimeDerivative<RealType, IsMultiMaterial>(sC, d_x, d_y, d_z, gamma_r, dW_dt, (RealType)this->gravity_x, (RealType)this->gravity_y, (RealType)this->gravity_z);
                        
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
                const auto& sp = states_pred[t];
                auto& si = states_int[t];
                for (int c = 0; c < TILE_CELLS_3D; ++c) {
                    si.rho[c] = sp.rho[c];
                    si.ux[c]  = sp.ux[c];
                    si.uy[c]  = sp.uy[c];
                    si.uz[c]  = sp.uz[c];
                    si.p[c]   = sp.p[c];
                    if constexpr (IsMultiMaterial) {
                        si.alpha1[c] = sp.alpha1[c];
                        si.alpha2[c] = sp.alpha2[c];
                        si.arho1[c]  = sp.arho1[c];
                        si.arho2[c]  = sp.arho2[c];
                    }
                }
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
                            
                            auto is_solid_cell = [&](int x, int y, int z) -> bool {
                                if (geom_pool.empty()) return false;
                                if (x < 0) return bcXmin == BCType3D::REFLECTIVE;
                                if (x >= nx) return bcXmax == BCType3D::REFLECTIVE;
                                if (y < 0) return bcYmin == BCType3D::REFLECTIVE;
                                if (y >= ny) return bcYmax == BCType3D::REFLECTIVE;
                                if (z < 0) return bcZmin == BCType3D::REFLECTIVE;
                                if (z >= nz) return bcZmax == BCType3D::REFLECTIVE;
                                int t_idx = (x >> 3) + (y >> 3) * n_tiles_x + (z >> 3) * n_tiles_x * n_tiles_y;
                                int c_idx = (x & 7) + (y & 7) * 8 + (z & 7) * 64;
                                return geom_pool[t_idx].cells[c_idx].is_boundary;
                            };

                            bool solid_x_L = !is_interior_tile && is_solid_cell(gx - 1, gy, gz);
                            bool solid_x_R = !is_interior_tile && is_solid_cell(gx + 1, gy, gz);
                            bool is_confined_x = solid_x_L && solid_x_R;

                            bool solid_y_B = !is_interior_tile && is_solid_cell(gx, gy - 1, gz);
                            bool solid_y_T = !is_interior_tile && is_solid_cell(gx, gy + 1, gz);
                            bool is_confined_y = solid_y_B && solid_y_T;

                            bool solid_z_D = !is_interior_tile && is_solid_cell(gx, gy, gz - 1);
                            bool solid_z_U = !is_interior_tile && is_solid_cell(gx, gy, gz + 1);
                            bool is_confined_z = solid_z_D && solid_z_U;

                            CellState3DT<RealType, IsMultiMaterial> d_x, d_y, d_z;
                            if (is_confined_x) {
                                d_x.rho = 0; d_x.ux = 0; d_x.uy = 0; d_x.uz = 0; d_x.p = 0;
                                d_x.alpha1 = 0; d_x.alpha2 = 0; d_x.arho1 = 0; d_x.arho2 = 0;
                            } else if (solid_x_L || solid_x_R) {
                                // Suppress ALL slopes near solid boundaries
                                d_x.rho = 0; d_x.ux = 0; d_x.uy = 0; d_x.uz = 0; d_x.p = 0;
                                d_x.alpha1 = 0; d_x.alpha2 = 0; d_x.arho1 = 0; d_x.arho2 = 0;
                            } else {
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
                            }

                            if (is_confined_y) {
                                d_y.rho = 0; d_y.ux = 0; d_y.uy = 0; d_y.uz = 0; d_y.p = 0;
                                d_y.alpha1 = 0; d_y.alpha2 = 0; d_y.arho1 = 0; d_y.arho2 = 0;
                            } else if (solid_y_B || solid_y_T) {
                                // Suppress ALL slopes near solid boundaries
                                d_y.rho = 0; d_y.ux = 0; d_y.uy = 0; d_y.uz = 0; d_y.p = 0;
                                d_y.alpha1 = 0; d_y.alpha2 = 0; d_y.arho1 = 0; d_y.arho2 = 0;
                            } else {
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
                            }

                            if (is_confined_z) {
                                d_z.rho = 0; d_z.ux = 0; d_z.uy = 0; d_z.uz = 0; d_z.p = 0;
                                d_z.alpha1 = 0; d_z.alpha2 = 0; d_z.arho1 = 0; d_z.arho2 = 0;
                            } else if (solid_z_D || solid_z_U) {
                                // Suppress ALL slopes near solid boundaries
                                d_z.rho = 0; d_z.ux = 0; d_z.uy = 0; d_z.uz = 0; d_z.p = 0;
                                d_z.alpha1 = 0; d_z.alpha2 = 0; d_z.arho1 = 0; d_z.arho2 = 0;
                            } else {
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
                            }
                            
                            CellState3DT<RealType, IsMultiMaterial> dW_dt_mid;
                            computeTimeDerivative<RealType, IsMultiMaterial>(sC, d_x, d_y, d_z, gamma_r, dW_dt_mid, (RealType)this->gravity_x, (RealType)this->gravity_y, (RealType)this->gravity_z);
                            
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
            #pragma omp parallel for schedule(static)
            for (int t = 0; t < total_tiles; ++t) {
                const auto& si = states_int[t];
                auto& sp = states_pred[t];
                for (int c = 0; c < TILE_CELLS_3D; ++c) {
                    sp.rho[c] = si.rho[c];
                    sp.ux[c]  = si.ux[c];
                    sp.uy[c]  = si.uy[c];
                    sp.uz[c]  = si.uz[c];
                    sp.p[c]   = si.p[c];
                    if constexpr (IsMultiMaterial) {
                        sp.alpha1[c] = si.alpha1[c];
                        sp.alpha2[c] = si.alpha2[c];
                        sp.arho1[c]  = si.arho1[c];
                        sp.arho2[c]  = si.arho2[c];
                    }
                }
            }
        }
        
        std::swap(states_pool, states_pred);
        computeFluxes(dt, U_pool);
        std::swap(states_pool, states_pred);
    }

    if constexpr (IsMultiMaterial) {
        applyProgrammedBurn(dt);
    }

    if (this->gravity_x != 0.0 || this->gravity_y != 0.0 || this->gravity_z != 0.0) {
        RealType gx = (RealType)this->gravity_x;
        RealType gy = (RealType)this->gravity_y;
        RealType gz = (RealType)this->gravity_z;
        RealType dt_r = (RealType)dt;
        int n_act = (int)active_tile_indices.size();
        // For stratified (ocean/seabed) media, soil cells must NOT receive the generic
        // gravity impulse. The soil EOS is a stiff Tait model initialised to geostatic
        // equilibrium, so any net rhouz impulse injected into a nearly-incompressible
        // soil cell is NOT balanced by a matching hydrostatic pressure gradient from the
        // flux divergence — the two operators are applied separately (operator splitting).
        // The resulting spurious velocity accumulation at the seabed/water interface is
        // what drives both the instability and the blue-line colormap artifact.
        //
        #pragma omp parallel for schedule(guided)
        for (int a = 0; a < n_act; ++a) {
            int t = active_tile_indices[a];
            auto& u = U_pool[t];
            for (int i = 0; i < TILE_CELLS_3D; ++i) {
                u.rhoux[i] += dt_r * u.rho[i] * gx;
                u.rhouy[i] += dt_r * u.rho[i] * gy;
                u.rhouz[i] += dt_r * u.rho[i] * gz;
                u.E[i]     += dt_r * (u.rhoux[i] * gx + u.rhouy[i] * gy + u.rhouz[i] * gz);
            }
        }
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
void CFDSolver3DImpl<RealType, IsMultiMaterial>::applyBC() {
    // Outer boundary conditions are handled dynamically in sample_func across ghost stencils.
}


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
            if (this->is_water_tait_val) {
                CellState3D<IsMultiMaterial> s_tmp{};
                s_tmp.ux = tile.ux[i]; s_tmp.uy = tile.uy[i]; s_tmp.uz = tile.uz[i]; s_tmp.p = tile.p[i]; s_tmp.rho = tile.rho[i];
                c = (RealType)getSoundSpeed3D<IsMultiMaterial>((double)tile.p[i], (double)tile.rho[i], s_tmp, (double)gamma, currentMaterials.products, currentMaterials.unreacted, true, &this->tait_water_params);
            } else if constexpr (IsMultiMaterial) {
                c = MultiMat::getMixtureSoundSpeed(tile.p[i], tile.rho[i], tile.alpha1[i], tile.alpha2[i], tile.arho1[i], tile.arho2[i], (RealType)gamma, currentMaterials.products, currentMaterials.unreacted);
                RealType a2 = tile.alpha2[i];
                RealType ar2 = tile.arho2[i];
                if (a2 > (RealType)1e-4 && ar2 > (RealType)10.0 && currentMaterials.det_vel > 0.0) {
                    c = max(c, (RealType)currentMaterials.det_vel);
                }
            } else {
                c = sqrt((RealType)gamma * tile.p[i] / max((RealType)1e-6, tile.rho[i]));
            }
            if (std::isnan(c) || std::isinf(c) || c < (RealType)0.0) c = (RealType)1482.0;
            RealType s = abs(tile.ux[i]) + abs(tile.uy[i]) + abs(tile.uz[i]) + (RealType)3.0 * c;
            if (s > max_s) {
                max_s = s;
            }
        }
    }
    double max_s_d = (double)max_s;
    if (std::isnan(max_s_d) || std::isinf(max_s_d) || max_s_d <= 0.0) {
        max_s_d = 1e-6;
    }
    max_s_d = std::clamp(max_s_d, 1e-6, 1e9);
    double dt = cfl * cellSize / max_s_d;
    return std::max(1.0e-11, dt);
}

template <typename RealType, bool IsMultiMaterial>
std::vector<float> CFDSolver3DImpl<RealType, IsMultiMaterial>::sampleGauge(const Gauge3D& gauge) const {

    int gx = std::clamp((int)((gauge.x - xmin) / cellSize), 0, nx - 1);
    int gy = std::clamp((int)((gauge.y - ymin) / cellSize), 0, ny - 1);
    int gz = std::clamp((int)((gauge.z - zmin) / cellSize), 0, nz - 1);

    if (!geom_pool.empty()) {
        auto is_solid = [&](int x, int y, int z) -> bool {
            if (x < 0 || x >= nx || y < 0 || y >= ny || z < 0 || z >= nz) return false;
            int t = (x >> 3) + (y >> 3) * n_tiles_x + (z >> 3) * n_tiles_x * n_tiles_y;
            int c = (x & 7) + ((y & 7) << 3) + ((z & 7) << 6);
            if (t >= 0 && t < (int)geom_pool.size()) {
                return geom_pool[t].cells[c].is_boundary != 0;
            }
            return false;
        };

        if (is_solid(gx, gy, gz)) {
            int best_x = gx, best_y = gy, best_z = gz;
            float best_dist_sq = 1e9f;
            for (int r = 1; r <= 3; ++r) {
                for (int dz = -r; dz <= r; ++dz) {
                    for (int dy = -r; dy <= r; ++dy) {
                        for (int dx = -r; dx <= r; ++dx) {
                            if (dx == 0 && dy == 0 && dz == 0) continue;
                            int cx = gx + dx, cy = gy + dy, cz = gz + dz;
                            if (cx < 0 || cx >= nx || cy < 0 || cy >= ny || cz < 0 || cz >= nz) continue;
                            if (!is_solid(cx, cy, cz)) {
                                float dist_sq = (float)(dx * dx + dy * dy + dz * dz);
                                if (dist_sq < best_dist_sq) {
                                    best_dist_sq = dist_sq;
                                    best_x = cx; best_y = cy; best_z = cz;
                                }
                            }
                        }
                    }
                }
                if (best_dist_sq < 1e8f) break;
            }
            gx = best_x; gy = best_y; gz = best_z;
        }
    }

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
    std::transform(qty.begin(), qty.end(), qty.begin(), [](unsigned char c) { return std::tolower(c); });
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
        if (qty == "species1" || qty == "alpha1" || qty == "species_1" || qty == "species" || qty == "products" || qty == "detonation_products" || qty == "detonation" || qty == "reacted" || qty == "reacted_gas" || qty == "he_products" || qty == "alpha_1") return (float)s.alpha1;
        if (qty == "species2" || qty == "alpha2" || qty == "species_2" || qty == "unreacted" || qty == "unreacted_solid" || qty == "solid_he" || qty == "solid_explosive" || qty == "he_solid" || qty == "alpha_2") return (float)s.alpha2;
        if (qty == "species3" || qty == "species_3" || qty == "air" || qty == "ambient_air" || qty == "alpha3" || qty == "alpha_3") return (float)(1.0 - s.alpha1 - s.alpha2);
        if (qty == "overpressure" || qty == "peak_overpressure") return (float)s.peak_overpressure;
        if (qty == "impulse" || qty == "peak_impulse") return (float)s.peak_impulse;
        if (qty == "materials" || qty == "material" || qty == "phase") {
            if (is_solid(gx_c, gy_c, gz_c)) return 5.0f; // FEM Solid / Obstacle
            double z_c = zmin + ((double)gz_c + 0.5) * cellSize;
            if constexpr (IsMultiMaterial) {
                if (s.alpha2 > 0.05f && s.alpha2 >= s.alpha1) return 3.0f; // Solid HE
                if (s.alpha1 > 0.05f) return 4.0f; // Detonation products
            }
            if (this->stratified_params.enabled) {
                if (z_c < this->stratified_params.seabed_surface_z) return 2.0f; // Seabed Soil
                if (z_c <= this->stratified_params.water_surface_z || s.rho > 300.0) return 1.0f; // Water
            } else {
                if (s.rho > 1800.0) return 2.0f;
                if (s.rho > 300.0) return 1.0f;
            }
            return 0.0f; // Air
        }
        if (qty == "water" || qty == "phase_water") {
            if (is_solid(gx_c, gy_c, gz_c)) return 0.0f;
            double z_c = zmin + ((double)gz_c + 0.5) * cellSize;
            if (this->stratified_params.enabled) {
                if (z_c >= this->stratified_params.seabed_surface_z && (z_c <= this->stratified_params.water_surface_z || s.rho > 300.0)) return 1.0f;
                return 0.0f;
            } else {
                return (s.rho > 300.0 && s.rho <= 1800.0) ? 1.0f : 0.0f;
            }
        }
        if (qty == "soil" || qty == "phase_soil" || qty == "sediment") {
            if (is_solid(gx_c, gy_c, gz_c)) return 0.0f;
            double z_c = zmin + ((double)gz_c + 0.5) * cellSize;
            if (this->stratified_params.enabled) {
                return (z_c < this->stratified_params.seabed_surface_z) ? 1.0f : 0.0f;
            } else {
                return (s.rho > 1800.0) ? 1.0f : 0.0f;
            }
        }
        if (qty == "temperature" || qty == "temp" || qty == "T") {
            RealType ke = (RealType)0.5 * s.rho * (s.ux * s.ux + s.uy * s.uy + s.uz * s.uz);
            RealType e_int = (s.E - ke) / std::max((RealType)s.rho, (RealType)1e-6);
            RealType c_v = (RealType)718.0;
            return (float)std::max((RealType)200.0, e_int / c_v);
        }
        if (qty == "afterburn_rate" || qty == "ab_rate" || qty == "combustion_rate") {
            if constexpr (!IsMultiMaterial) return 0.0f;
            else {
                if (!currentMaterials.afterburn.enabled || currentMaterials.afterburn.ambient_o2_fraction <= 0.0) return 0.0f;
                RealType ke = (RealType)0.5 * (RealType)s.rho * ((RealType)s.ux * (RealType)s.ux + (RealType)s.uy * (RealType)s.uy + (RealType)s.uz * (RealType)s.uz);
                RealType e_int = ((RealType)s.E - ke) / std::max((RealType)s.rho, (RealType)1e-6);
                if (e_int / (RealType)718.0 < (RealType)currentMaterials.afterburn.T_ign) return 0.0f;
                RealType arho0 = std::max((RealType)0.0, (RealType)(s.rho - s.arho1 - s.arho2));
                RealType rho_fuel = (RealType)currentMaterials.afterburn.f_fuel * (RealType)s.arho1;
                RealType rho_O2 = (RealType)currentMaterials.afterburn.ambient_o2_fraction * arho0;
                RealType tau_exp = (currentMaterials.afterburn.tau_expansion > (RealType)1e-4) ? (RealType)currentMaterials.afterburn.tau_expansion : (RealType)0.0;
                if (tau_exp <= (RealType)0.0) {
                    if (charge_radius > (RealType)1e-4) {
                        RealType Q_scale = (currentMaterials.afterburn.Q_ab > (RealType)1e5) ? (RealType)currentMaterials.afterburn.Q_ab : (RealType)4.29e6;
                        RealType rho_exp = (s.rho > (RealType)100.0) ? (RealType)s.rho : (RealType)1630.0;
                        constexpr RealType P_amb = (RealType)101325.0;
                        constexpr RealType c_amb = (RealType)340.0;
                        constexpr RealType k_fireball = (RealType)0.16;
                        RealType sedov_ratio = std::pow((RealType)(4.0 / 3.0 * M_PI) * rho_exp * Q_scale / P_amb, (RealType)(1.0 / 3.0));
                        tau_exp = (k_fireball * sedov_ratio * (RealType)charge_radius) / c_amb;
                    } else {
                        tau_exp = (RealType)0.005;
                    }
                }
                RealType k_mix = (RealType)1.0 / std::max(tau_exp, (RealType)1e-5);
                RealType f_fuel_safe = std::max((RealType)currentMaterials.afterburn.f_fuel, (RealType)0.01);
                RealType r_fuel = k_mix * std::min(rho_fuel, (RealType)(rho_O2 / (RealType)currentMaterials.afterburn.s_ratio));
                RealType r_expl = r_fuel / f_fuel_safe;
                return (float)(r_expl * (RealType)currentMaterials.afterburn.Q_ab);
            }
        }
        if (qty == "fuel_density" || qty == "fuel_rho" || qty == "rho_fuel") {
            if constexpr (!IsMultiMaterial) return 0.0f;
            else {
                RealType rho_fuel = (RealType)currentMaterials.afterburn.f_fuel * (RealType)s.arho1;
                return (float)std::max((RealType)0.0, rho_fuel);
            }
        }
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
        int i_start = slice.roi_enabled ? slice.roi_i_start : 0;
        int j_start = slice.roi_enabled ? slice.roi_j_start : 0;
        int k_start = slice.roi_enabled ? slice.roi_k_start : 0;
        int i_end   = slice.roi_enabled ? slice.roi_i_end   : nx;
        int j_end   = slice.roi_enabled ? slice.roi_j_end   : ny;
        int k_end   = slice.roi_enabled ? slice.roi_k_end   : nz;

        int out_nx = ((i_end - i_start + stride - 1) / stride) * factor;
        int out_ny = ((j_end - j_start + stride - 1) / stride) * factor;
        int out_nz = ((k_end - k_start + stride - 1) / stride) * factor;
        data.resize((size_t)out_nx * out_ny * out_nz);

        #pragma omp parallel for collapse(3)
        for (int gz = 0; gz < out_nz; ++gz) {
            for (int gy = 0; gy < out_ny; ++gy) {
                for (int gx = 0; gx < out_nx; ++gx) {
                    int base_gx = std::clamp(i_start + (gx * stride) / factor, 0, nx - 1);
                    int base_gy = std::clamp(j_start + (gy * stride) / factor, 0, ny - 1);
                    int base_gz = std::clamp(k_start + (gz * stride) / factor, 0, nz - 1);

                    data[(size_t)gx + (size_t)gy * out_nx + (size_t)gz * out_nx * out_ny] = getVal(sampleState(base_gx, base_gy, base_gz), base_gx, base_gy, base_gz);
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

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::sampleSurfacePoints(
    const std::vector<Point3D>& points,
    const std::vector<std::string>& quantities,
    double dom_xmin, double dom_xmax,
    double dom_ymin, double dom_ymax,
    double dom_zmin, double dom_zmax,
    float outside_val,
    std::vector<std::vector<float>>& out_quantities
) const {
    size_t num_points = points.size();
    size_t num_qtys = quantities.size();
    out_quantities.resize(num_qtys);
    for (size_t q = 0; q < num_qtys; ++q) {
        out_quantities[q].resize(num_points, outside_val);
    }
    if (num_points == 0 || num_qtys == 0) return;

    std::vector<std::string> lowered_quantities(num_qtys);
    for (size_t q = 0; q < num_qtys; ++q) {
        lowered_quantities[q] = quantities[q];
        std::transform(lowered_quantities[q].begin(), lowered_quantities[q].end(), lowered_quantities[q].begin(), [](unsigned char c) { return std::tolower(c); });
    }

    const double tol = 1e-4 * cellSize;

    auto is_solid = [&](int cx, int cy, int cz) {
        if (geom_pool.empty()) return false;
        if (cx < 0 || cx >= nx || cy < 0 || cy >= ny || cz < 0 || cz >= nz) return false;
        int t = (cx >> 3) + (cy >> 3) * n_tiles_x + (cz >> 3) * n_tiles_x * n_tiles_y;
        int c = (cx & 7) + (cy & 7) * 8 + (cz & 7) * 64;
        return geom_pool[t].cells[c].is_boundary != 0;
    };

    auto getVal = [&](const CellState3D<IsMultiMaterial>& s, int gx_c, int gy_c, int gz_c, const std::string& qty) -> float {
        if (qty == "solid" || qty == "solid_cells") {
            return is_solid(gx_c, gy_c, gz_c) ? 1.0f : 0.0f;
        }
        if (qty == "density" || qty == "rho") return (float)s.rho;
        if (qty == "velocity" || qty == "speed") return (float)std::sqrt(s.ux*s.ux + s.uy*s.uy + s.uz*s.uz);
        if (qty == "energy" || qty == "internal_energy") return (float)(s.E / std::max(s.rho, 1e-6));
        if (qty == "species1" || qty == "alpha1" || qty == "reacted" || qty == "reacted_gas") return (float)s.alpha1;
        if (qty == "species2" || qty == "alpha2" || qty == "unreacted" || qty == "unreacted_solid") return (float)s.alpha2;
        if (qty == "species3" || qty == "air" || qty == "ambient_air") return (float)(1.0 - s.alpha1 - s.alpha2);
        if (qty == "overpressure" || qty == "peak_overpressure") return (float)s.peak_overpressure;
        if (qty == "impulse" || qty == "peak_impulse") return (float)s.peak_impulse;
        if (qty == "materials" || qty == "material" || qty == "phase") {
            if (is_solid(gx_c, gy_c, gz_c)) return 5.0f; // FEM Solid / Obstacle
            double z_c = zmin + ((double)gz_c + 0.5) * cellSize;
            if constexpr (IsMultiMaterial) {
                if (s.alpha2 > 0.05f && s.alpha2 >= s.alpha1) return 3.0f; // Solid HE
                if (s.alpha1 > 0.05f) return 4.0f; // Detonation products
            }
            if (this->stratified_params.enabled) {
                if (z_c < this->stratified_params.seabed_surface_z) return 2.0f; // Seabed Soil
                if (z_c <= this->stratified_params.water_surface_z || s.rho > 300.0) return 1.0f; // Water
            } else {
                if (s.rho > 1800.0) return 2.0f;
                if (s.rho > 300.0) return 1.0f;
            }
            return 0.0f; // Air
        }
        return (float)s.p;
    };

#ifdef _OPENMP
    #pragma omp parallel for schedule(static)
#endif
    for (size_t i = 0; i < num_points; ++i) {
        const auto& pt = points[i];
        if (pt.x < dom_xmin - tol || pt.x > dom_xmax + tol ||
            pt.y < dom_ymin - tol || pt.y > dom_ymax + tol ||
            pt.z < dom_zmin - tol || pt.z > dom_zmax + tol) {
            continue; // already initialized to outside_val
        }

        int gx = std::clamp((int)std::floor((pt.x - xmin) / cellSize), 0, nx - 1);
        int gy = std::clamp((int)std::floor((pt.y - ymin) / cellSize), 0, ny - 1);
        int gz = std::clamp((int)std::floor((pt.z - zmin) / cellSize), 0, nz - 1);

        int orig_gx = gx, orig_gy = gy, orig_gz = gz;
        bool point_is_solid = is_solid(orig_gx, orig_gy, orig_gz);

        if (point_is_solid) {
            double best_dist2 = 1e30;
            int best_gx = gx, best_gy = gy, best_gz = gz;
            bool found = false;

            // Search radius 1 (26 neighbors)
            for (int dz = -1; dz <= 1; ++dz) {
                int cz = gz + dz;
                if (cz < 0 || cz >= nz) continue;
                for (int dy = -1; dy <= 1; ++dy) {
                    int cy = gy + dy;
                    if (cy < 0 || cy >= ny) continue;
                    for (int dx_ = -1; dx_ <= 1; ++dx_) {
                        if (dx_ == 0 && dy == 0 && dz == 0) continue;
                        int cx = gx + dx_;
                        if (cx < 0 || cx >= nx) continue;

                        if (!is_solid(cx, cy, cz)) {
                            double ccx = xmin + (cx + 0.5) * cellSize;
                            double ccy = ymin + (cy + 0.5) * cellSize;
                            double ccz = zmin + (cz + 0.5) * cellSize;
                            double dist2 = (pt.x - ccx)*(pt.x - ccx) + (pt.y - ccy)*(pt.y - ccy) + (pt.z - ccz)*(pt.z - ccz);
                            if (dist2 < best_dist2) {
                                best_dist2 = dist2;
                                best_gx = cx; best_gy = cy; best_gz = cz;
                                found = true;
                            }
                        }
                    }
                }
            }

            // Search radius 2 if entirely surrounded in radius 1
            if (!found) {
                for (int dz = -2; dz <= 2; ++dz) {
                    int cz = gz + dz;
                    if (cz < 0 || cz >= nz) continue;
                    for (int dy = -2; dy <= 2; ++dy) {
                        int cy = gy + dy;
                        if (cy < 0 || cy >= ny) continue;
                        for (int dx_ = -2; dx_ <= 2; ++dx_) {
                            if (std::abs(dx_) <= 1 && std::abs(dy) <= 1 && std::abs(dz) <= 1) continue;
                            int cx = gx + dx_;
                            if (cx < 0 || cx >= nx) continue;

                            if (!is_solid(cx, cy, cz)) {
                                double ccx = xmin + (cx + 0.5) * cellSize;
                                double ccy = ymin + (cy + 0.5) * cellSize;
                                double ccz = zmin + (cz + 0.5) * cellSize;
                                double dist2 = (pt.x - ccx)*(pt.x - ccx) + (pt.y - ccy)*(pt.y - ccy) + (pt.z - ccz)*(pt.z - ccz);
                                if (dist2 < best_dist2) {
                                    best_dist2 = dist2;
                                    best_gx = cx; best_gy = cy; best_gz = cz;
                                    found = true;
                                }
                            }
                        }
                    }
                }
            }

            if (found) {
                gx = best_gx; gy = best_gy; gz = best_gz;
            }
        }

        auto s = sampleState(gx, gy, gz);
        for (size_t q = 0; q < num_qtys; ++q) {
            if (lowered_quantities[q] == "solid" || lowered_quantities[q] == "solid_cells") {
                out_quantities[q][i] = point_is_solid ? 1.0f : 0.0f;
            } else {
                out_quantities[q][i] = getVal(s, gx, gy, gz, lowered_quantities[q]);
            }
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolver3DImpl<RealType, IsMultiMaterial>::captureBulkSnapshot(CFDBulkSnapshot3D& out_snap, bool need_vel, bool need_E, bool need_species) const {
    size_t N = (size_t)nx * ny * nz;
    out_snap.nx = nx; out_snap.ny = ny; out_snap.nz = nz;
    out_snap.cellSize = cellSize;
    out_snap.xmin = xmin; out_snap.ymin = ymin; out_snap.zmin = zmin;
    out_snap.has_vel = need_vel;
    out_snap.has_E = need_E;
    out_snap.has_species = need_species;

    out_snap.p.resize(N);
    out_snap.rho.resize(N);
    out_snap.overpressure.resize(N);
    out_snap.impulse.resize(N);
    out_snap.solid.resize(N);
    if (need_vel) out_snap.vel.resize(N);
    if (need_E) out_snap.E.resize(N);
    if (need_species) {
        out_snap.alpha1.resize(N);
        out_snap.alpha2.resize(N);
        out_snap.air.resize(N);
    }

#ifdef _OPENMP
    #pragma omp parallel for collapse(3) schedule(static)
#endif
    for (int gz = 0; gz < nz; ++gz) {
        for (int gy = 0; gy < ny; ++gy) {
            for (int gx = 0; gx < nx; ++gx) {
                size_t lin_idx = (size_t)gx + (size_t)gy * nx + (size_t)gz * nx * ny;
                int t = (gx >> 3) + (gy >> 3) * n_tiles_x + (gz >> 3) * n_tiles_x * n_tiles_y;
                int c = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

                const auto& s = states_pool[t];
                out_snap.p[lin_idx] = (float)s.p[c];
                out_snap.rho[lin_idx] = (float)s.rho[c];
                out_snap.overpressure[lin_idx] = (float)s.peak_overpressure[c];
                out_snap.impulse[lin_idx] = (float)s.peak_impulse[c];

                if (!geom_pool.empty()) {
                    out_snap.solid[lin_idx] = geom_pool[t].cells[c].is_boundary ? 1.0f : 0.0f;
                } else {
                    out_snap.solid[lin_idx] = 0.0f;
                }

                if (need_vel) {
                    RealType ux = s.ux[c], uy = s.uy[c], uz = s.uz[c];
                    out_snap.vel[lin_idx] = (float)std::sqrt(ux*ux + uy*uy + uz*uz);
                }
                if (need_E) {
                    auto st = sampleState(gx, gy, gz);
                    out_snap.E[lin_idx] = (float)(st.E / std::max(st.rho, 1e-6));
                }
                if (need_species) {
                    if constexpr (IsMultiMaterial) {
                        out_snap.alpha1[lin_idx] = (float)s.alpha1[c];
                        out_snap.alpha2[lin_idx] = (float)s.alpha2[c];
                        out_snap.air[lin_idx] = (float)(1.0 - s.alpha1[c] - s.alpha2[c]);
                    } else {
                        out_snap.alpha1[lin_idx] = 0.0f;
                        out_snap.alpha2[lin_idx] = 0.0f;
                        out_snap.air[lin_idx] = 1.0f;
                    }
                }
            }
        }
    }
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
    commitStates();

    double cut_r = (R_remap > 0.0) ? R_remap : (r_1d.empty() ? 0.0 : r_1d.back());
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
        if (dist <= cut_r + TILE_SIZE_3D * cell_sz_1d * 1.5) {
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
            } else if (this->is_water_tait_val) {
                CellState3D<IsMultiMaterial> s_tmp{};
                s_tmp.rho = state_tile.rho[i];
                total_E = (RealType)getEnergy3D<IsMultiMaterial>((double)state_tile.p[i], (double)state_tile.rho[i], s_tmp, gamma, currentMaterials.products, currentMaterials.unreacted, true, &this->tait_water_params) + ke;
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
