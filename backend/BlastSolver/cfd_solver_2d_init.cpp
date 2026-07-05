#include "cfd_solver_2d.hpp"
#include <cmath>
#include <iostream>
#include <algorithm>
#include <stdexcept>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

CFDSolver2D::CFDSolver2D(int nr, int nz, double max_r, double max_z, double gamma)
    : nr_cells(nr), nz_cells(nz), max_r(max_r), max_z(max_z), gamma(gamma), currentTime(0.0), currentScheme(AUSM_PLUS),
      ambient_rho(1.2), ambient_p(101325.0) {
    dr = max_r / nr_cells;
    dz = max_z / nz_cells;

    num_tiles_r = (nr_cells + TILE_SIZE - 1) / TILE_SIZE;
    num_tiles_z = (nz_cells + TILE_SIZE - 1) / TILE_SIZE;

    tile_map.resize(num_tiles_r * num_tiles_z, -1);
    
    // We start with an empty pool, tiles will be allocated dynamically
    states_pool.clear();
    U_pool.clear();
    dU_pool.clear();

    solid_mask.resize(nr_cells * nz_cells, 0);
}

int CFDSolver2D::allocateTile(int tr, int tz) {
    if (tr < 0 || tr >= num_tiles_r || tz < 0 || tz >= num_tiles_z) return -1;
    int flat_idx = tr * num_tiles_z + tz;
    if (tile_map[flat_idx] != -1) return tile_map[flat_idx];
    
    int pool_idx = states_pool.size();
    states_pool.push_back(PrimitiveTile());
    U_pool.push_back(ConservativeTile());
    dU_pool.push_back(ConservativeTile());
    
    initTileToAmbient(pool_idx);
    
    tile_map[flat_idx] = pool_idx;
    
    return pool_idx;
}

void CFDSolver2D::initTileToAmbient(int pool_idx) {
    for (int k = 0; k < TILE_SIZE * TILE_SIZE; ++k) {
        states_pool[pool_idx].rho[k] = ambient_rho;
        states_pool[pool_idx].ur[k] = 0.0;
        states_pool[pool_idx].uz[k] = 0.0;
        states_pool[pool_idx].p[k] = ambient_p;
        states_pool[pool_idx].alpha1[k] = 0.0;
        states_pool[pool_idx].alpha2[k] = 0.0;
        states_pool[pool_idx].arho1[k] = 0.0;
        states_pool[pool_idx].arho2[k] = 0.0;
        states_pool[pool_idx].floor_status[k] = 0;
        
        if (is_ideal_gas) {
            states_pool[pool_idx].E[k] = ambient_p / (gamma - 1.0);
        } else {
            states_pool[pool_idx].E[k] = ambient_rho * MultiMat::getEnergy_IdealGas(ambient_p, ambient_rho, gamma);
        }
        
        U_pool[pool_idx].rho[k] = ambient_rho;
        U_pool[pool_idx].rhour[k] = 0.0;
        U_pool[pool_idx].rhouz[k] = 0.0;
        U_pool[pool_idx].E[k] = states_pool[pool_idx].E[k];
        U_pool[pool_idx].alpha1[k] = 0.0;
        U_pool[pool_idx].alpha2[k] = 0.0;
        U_pool[pool_idx].arho1[k] = 0.0;
        U_pool[pool_idx].arho2[k] = 0.0;
    }
}

void CFDSolver2D::setFluxScheme(const std::string& scheme_name) {
    if (scheme_name == "ausm_plus" || scheme_name == "AUSMPlus" || scheme_name == "ausm+" || scheme_name == "AUSM+") {
        currentScheme = AUSM_PLUS;
    } else {
        currentScheme = RUSANOV;
    }
}

void CFDSolver2D::setInitialConditionTNT(double explosive_z, double explosive_radius, 
                                        double high_rho, 
                                        double ambient_rho, double ambient_p) {
    this->ambient_rho = ambient_rho;
    this->ambient_p = ambient_p;
    this->det_x = 0.0;
    this->det_y = 0.0;
    this->det_z = explosive_z;
    this->is_ideal_gas = false;

    // Allocate all tiles that contain the explosive
    for (int i = 0; i < nr_cells; ++i) {
        for (int j = 0; j < nz_cells; ++j) {
            double sum_w = 0.0;
            double sum_w_inside = 0.0;
            for (int ki = 0; ki < 8; ++ki) {
                double r_sub = i * dr + (ki + 0.5) * (dr / 8.0);
                double w = is_cartesian ? 1.0 : r_sub;
                for (int kj = 0; kj < 8; ++kj) {
                    double z_sub = j * dz + (kj + 0.5) * (dz / 8.0);
                    double dist = std::sqrt(r_sub * r_sub + (z_sub - explosive_z) * (z_sub - explosive_z));
                    if (dist <= explosive_radius) {
                        sum_w_inside += w;
                    }
                    sum_w += w;
                }
            }
            double f_vol = sum_w_inside / sum_w;

            if (f_vol > 0.0) {
                int tr = i / TILE_SIZE;
                int tz = j / TILE_SIZE;
                int pool_idx = allocateTile(tr, tz);
                
                int local_i = i % TILE_SIZE;
                int local_j = j % TILE_SIZE;
                int local_idx = local_i * TILE_SIZE + local_j;
                
                double alpha2 = f_vol;
                double arho2 = f_vol * high_rho;
                double rho = arho2 + (1.0 - f_vol) * ambient_rho;
                double E = MultiMat::getMixtureEnergy(ambient_p, rho, 0.0, alpha2, 0.0, arho2, gamma, currentMaterials.products, currentMaterials.unreacted);

                states_pool[pool_idx].rho[local_idx] = rho;
                states_pool[pool_idx].p[local_idx] = ambient_p;
                states_pool[pool_idx].alpha1[local_idx] = 0.0; 
                states_pool[pool_idx].alpha2[local_idx] = alpha2;
                states_pool[pool_idx].arho1[local_idx] = 0.0; 
                states_pool[pool_idx].arho2[local_idx] = arho2;
                states_pool[pool_idx].ur[local_idx] = 0.0; 
                states_pool[pool_idx].uz[local_idx] = 0.0;
                states_pool[pool_idx].E[local_idx] = E;
                
                U_pool[pool_idx].rho[local_idx] = rho;
                U_pool[pool_idx].rhour[local_idx] = 0.0;
                U_pool[pool_idx].rhouz[local_idx] = 0.0;
                U_pool[pool_idx].E[local_idx] = E;
                U_pool[pool_idx].alpha1[local_idx] = 0.0;
                U_pool[pool_idx].alpha2[local_idx] = alpha2;
                U_pool[pool_idx].arho1[local_idx] = 0.0;
                U_pool[pool_idx].arho2[local_idx] = arho2;
            }
        }
    }
    updateActiveRegion();
}

void CFDSolver2D::setInitialConditionIdealGas(double explosive_z, double explosive_radius,
                                             double high_rho, double detonation_energy,
                                             double ambient_rho, double ambient_p) {
    this->ambient_rho = ambient_rho;
    this->ambient_p = ambient_p;
    this->det_x = 0.0;
    this->det_y = 0.0;
    this->det_z = explosive_z;
    this->is_ideal_gas = true;
    
    double p_high = (gamma - 1.0) * high_rho * detonation_energy;
    
    for (int i = 0; i < nr_cells; ++i) {
        for (int j = 0; j < nz_cells; ++j) {
            double sum_w = 0.0;
            double sum_w_inside = 0.0;
            for (int ki = 0; ki < 8; ++ki) {
                double r_sub = i * dr + (ki + 0.5) * (dr / 8.0);
                double w = is_cartesian ? 1.0 : r_sub;
                for (int kj = 0; kj < 8; ++kj) {
                    double z_sub = j * dz + (kj + 0.5) * (dz / 8.0);
                    double dist = std::sqrt(r_sub * r_sub + (z_sub - explosive_z) * (z_sub - explosive_z));
                    if (dist <= explosive_radius) {
                        sum_w_inside += w;
                    }
                    sum_w += w;
                }
            }
            double f_vol = sum_w_inside / sum_w;

            if (f_vol > 0.0) {
                int tr = i / TILE_SIZE;
                int tz = j / TILE_SIZE;
                int pool_idx = allocateTile(tr, tz);
                
                int local_i = i % TILE_SIZE;
                int local_j = j % TILE_SIZE;
                int local_idx = local_i * TILE_SIZE + local_j;
                
                double rho = f_vol * high_rho + (1.0 - f_vol) * ambient_rho;
                double p = f_vol * p_high + (1.0 - f_vol) * ambient_p;
                double E = p / (gamma - 1.0);

                states_pool[pool_idx].rho[local_idx] = rho;
                states_pool[pool_idx].p[local_idx] = p;
                states_pool[pool_idx].alpha1[local_idx] = 0.0; states_pool[pool_idx].alpha2[local_idx] = 0.0;
                states_pool[pool_idx].arho1[local_idx] = 0.0; states_pool[pool_idx].arho2[local_idx] = 0.0;
                states_pool[pool_idx].ur[local_idx] = 0.0; states_pool[pool_idx].uz[local_idx] = 0.0;
                states_pool[pool_idx].E[local_idx] = E;
                
                U_pool[pool_idx].rho[local_idx] = rho;
                U_pool[pool_idx].rhour[local_idx] = 0.0;
                U_pool[pool_idx].rhouz[local_idx] = 0.0;
                U_pool[pool_idx].E[local_idx] = E;
                U_pool[pool_idx].alpha1[local_idx] = 0.0; U_pool[pool_idx].alpha2[local_idx] = 0.0;
                U_pool[pool_idx].arho1[local_idx] = 0.0; U_pool[pool_idx].arho2[local_idx] = 0.0;
            }
        }
    }
    updateActiveRegion();
}

void CFDSolver2D::setInitialConditionTNTCylinder(double explosive_z, double radius, double height,
                                                double high_rho,
                                                double ambient_rho, double ambient_p) {
    this->ambient_rho = ambient_rho;
    this->ambient_p = ambient_p;
    this->det_x = 0.0;
    this->det_y = 0.0;
    this->det_z = explosive_z + height / 2.0; // Top of the cylinder
    this->is_ideal_gas = false;

    for (int i = 0; i < nr_cells; ++i) {
        for (int j = 0; j < nz_cells; ++j) {
            double sum_w = 0.0;
            double sum_w_inside = 0.0;
            for (int ki = 0; ki < 8; ++ki) {
                double r_sub = i * dr + (ki + 0.5) * (dr / 8.0);
                double w = is_cartesian ? 1.0 : r_sub;
                for (int kj = 0; kj < 8; ++kj) {
                    double z_sub = j * dz + (kj + 0.5) * (dz / 8.0);
                    bool inside = (r_sub <= radius) && (std::abs(z_sub - explosive_z) <= height / 2.0);
                    if (inside) {
                        sum_w_inside += w;
                    }
                    sum_w += w;
                }
            }
            double f_vol = sum_w_inside / sum_w;

            if (f_vol > 0.0) {
                int tr = i / TILE_SIZE;
                int tz = j / TILE_SIZE;
                int pool_idx = allocateTile(tr, tz);
                
                int local_i = i % TILE_SIZE;
                int local_j = j % TILE_SIZE;
                int local_idx = local_i * TILE_SIZE + local_j;
                
                double alpha2 = f_vol;
                double arho2 = f_vol * high_rho;
                double rho = arho2 + (1.0 - f_vol) * ambient_rho;
                double E = MultiMat::getMixtureEnergy(ambient_p, rho, 0.0, alpha2, 0.0, arho2, gamma, currentMaterials.products, currentMaterials.unreacted);

                states_pool[pool_idx].rho[local_idx] = rho;
                states_pool[pool_idx].p[local_idx] = ambient_p;
                states_pool[pool_idx].alpha1[local_idx] = 0.0; states_pool[pool_idx].alpha2[local_idx] = alpha2;
                states_pool[pool_idx].arho1[local_idx] = 0.0; states_pool[pool_idx].arho2[local_idx] = arho2;
                states_pool[pool_idx].ur[local_idx] = 0.0; states_pool[pool_idx].uz[local_idx] = 0.0;
                states_pool[pool_idx].E[local_idx] = E;
                
                U_pool[pool_idx].rho[local_idx] = rho;
                U_pool[pool_idx].rhour[local_idx] = 0.0;
                U_pool[pool_idx].rhouz[local_idx] = 0.0;
                U_pool[pool_idx].E[local_idx] = E;
                U_pool[pool_idx].alpha1[local_idx] = 0.0; U_pool[pool_idx].alpha2[local_idx] = alpha2;
                U_pool[pool_idx].arho1[local_idx] = 0.0; U_pool[pool_idx].arho2[local_idx] = arho2;
            }
        }
    }
    updateActiveRegion();
}

void CFDSolver2D::setInitialConditionFrom1D(double explosive_z, double remap_radius,
                                           const std::vector<double>& r_1d,
                                           const std::vector<MultiMaterialState>& states_1d,
                                           double ambient_rho, double ambient_p,
                                           double explosive_r) {
    this->ambient_rho = ambient_rho;
    this->ambient_p = ambient_p;
    this->det_x = explosive_r;
    this->det_y = 0.0;
    this->det_z = explosive_z;
    const int K = 5;
    double dr_sub = dr / K;
    double dz_sub = dz / K;

    bool is_uniform = true;
    double dr_1d = 0.0;
    if (r_1d.size() > 1) {
        dr_1d = r_1d[1] - r_1d[0];
        for (size_t k = 1; k < r_1d.size(); ++k) {
            if (std::abs((r_1d[k] - r_1d[k-1]) - dr_1d) > 1e-7) {
                is_uniform = false;
                break;
            }
        }
    } else {
        is_uniform = false;
    }

    #pragma omp parallel for collapse(2)
    for (int i = 0; i < nr_cells; ++i) {
        for (int j = 0; j < nz_cells; ++j) {
            double r_left = i * dr;
            double z_bottom = j * dz;
            
            // Fast check if we are within the remap_radius
            double r_c = (i + 0.5) * dr;
            double z_c = (j + 0.5) * dz;
            double dist_c = std::sqrt((r_c - explosive_r)*(r_c - explosive_r) + (z_c - explosive_z)*(z_c - explosive_z));
            
            if (dist_c > remap_radius + dr + dz) {
                continue; // Stays ambient, no tile allocation needed initially
            }
            
            // Force tile allocation from a critical section to avoid race condition
            int tr = i / TILE_SIZE;
            int tz = j / TILE_SIZE;
            int pool_idx;
            #pragma omp critical
            {
                pool_idx = allocateTile(tr, tz);
            }
            
            int local_i = i % TILE_SIZE;
            int local_j = j % TILE_SIZE;
            int local_idx = local_i * TILE_SIZE + local_j;

            double sum_rho_w = 0.0;
            double sum_rhour_w = 0.0;
            double sum_rhouz_w = 0.0;
            double sum_E_w = 0.0;
            double sum_alpha1_w = 0.0;
            double sum_alpha2_w = 0.0;
            double sum_arho1_w = 0.0;
            double sum_arho2_w = 0.0;
            double sum_w = 0.0;

            for (int m = 0; m < K; ++m) {
                double r_sub = r_left + (m + 0.5) * dr_sub;
                double w_sub = is_cartesian ? 1.0 : r_sub; // Uniform weight in Cartesian, radial in axisymmetric

                for (int n = 0; n < K; ++n) {
                    double z_sub = z_bottom + (n + 0.5) * dz_sub;
                    double dr_diff = r_sub - explosive_r;
                    double dz_diff = z_sub - explosive_z;
                    double d_sub = std::sqrt(dr_diff * dr_diff + dz_diff * dz_diff);

                    double rho_sub, ur_sub, uz_sub, p_sub, E_sub;
                    double alpha1_sub, alpha2_sub, arho1_sub, arho2_sub;

                    if (d_sub <= remap_radius && d_sub <= r_1d.back()) {
                        double rho_1d_val = ambient_rho;
                        double u_1d_val = 0.0;
                        double p_1d_val = ambient_p;
                        double alpha1_1d_val = 0.0;
                        double alpha2_1d_val = 0.0;
                        double arho1_1d_val = 0.0;
                        double arho2_1d_val = 0.0;

                        if (d_sub <= r_1d.front()) {
                            rho_1d_val = states_1d.front().rho;
                            u_1d_val = states_1d.front().u;
                            p_1d_val = states_1d.front().p;
                            alpha1_1d_val = states_1d.front().alpha1;
                            alpha2_1d_val = states_1d.front().alpha2;
                            arho1_1d_val = states_1d.front().arho1;
                            arho2_1d_val = states_1d.front().arho2;
                        } else {
                            int idx;
                            if (is_uniform) {
                                idx = std::ceil(d_sub / dr_1d - 0.5);
                                if (idx < 1) idx = 1;
                                if (idx >= (int)r_1d.size()) idx = (int)r_1d.size() - 1;
                            } else {
                                auto it = std::lower_bound(r_1d.begin(), r_1d.end(), d_sub);
                                idx = std::distance(r_1d.begin(), it);
                            }
                            double r_left_1d = r_1d[idx - 1];
                            double r_right_1d = r_1d[idx];
                            double frac = (d_sub - r_left_1d) / (r_right_1d - r_left_1d);

                            rho_1d_val = states_1d[idx - 1].rho + frac * (states_1d[idx].rho - states_1d[idx - 1].rho);
                            u_1d_val = states_1d[idx - 1].u + frac * (states_1d[idx].u - states_1d[idx - 1].u);
                            p_1d_val = states_1d[idx - 1].p + frac * (states_1d[idx].p - states_1d[idx - 1].p);
                            alpha1_1d_val = states_1d[idx - 1].alpha1 + frac * (states_1d[idx].alpha1 - states_1d[idx - 1].alpha1);
                            alpha2_1d_val = states_1d[idx - 1].alpha2 + frac * (states_1d[idx].alpha2 - states_1d[idx - 1].alpha2);
                            arho1_1d_val = states_1d[idx - 1].arho1 + frac * (states_1d[idx].arho1 - states_1d[idx - 1].arho1);
                            arho2_1d_val = states_1d[idx - 1].arho2 + frac * (states_1d[idx].arho2 - states_1d[idx - 1].arho2);
                        }

                        rho_sub = rho_1d_val;
                        alpha1_sub = alpha1_1d_val;
                        alpha2_sub = alpha2_1d_val;
                        arho1_sub = arho1_1d_val;
                        arho2_sub = arho2_1d_val;

                        if (d_sub > 1e-12) {
                            ur_sub = u_1d_val * (dr_diff / d_sub);
                            uz_sub = u_1d_val * (dz_diff / d_sub);
                        } else {
                            ur_sub = 0.0;
                            uz_sub = 0.0;
                        }
                        p_sub = p_1d_val;
                        E_sub = MultiMat::getMixtureEnergy(p_sub, rho_sub, alpha1_sub, alpha2_sub, arho1_sub, arho2_sub, gamma, currentMaterials.products, currentMaterials.unreacted) + 0.5 * rho_sub * (ur_sub * ur_sub + uz_sub * uz_sub);
                    } else {
                        rho_sub = ambient_rho;
                        ur_sub = 0.0;
                        uz_sub = 0.0;
                        p_sub = ambient_p;
                        alpha1_sub = 0.0;
                        alpha2_sub = 0.0;
                        arho1_sub = 0.0;
                        arho2_sub = 0.0;
                        E_sub = MultiMat::getMixtureEnergy(p_sub, rho_sub, alpha1_sub, alpha2_sub, arho1_sub, arho2_sub, gamma, currentMaterials.products, currentMaterials.unreacted) + 0.5 * rho_sub * (ur_sub * ur_sub + uz_sub * uz_sub);
                    }

                    sum_rho_w   += rho_sub * w_sub;
                    sum_rhour_w += rho_sub * ur_sub * w_sub;
                    sum_rhouz_w += rho_sub * uz_sub * w_sub;
                    sum_E_w     += E_sub * w_sub;
                    sum_alpha1_w += alpha1_sub * w_sub;
                    sum_alpha2_w += alpha2_sub * w_sub;
                    sum_arho1_w  += arho1_sub * w_sub;
                    sum_arho2_w  += arho2_sub * w_sub;
                    sum_w       += w_sub;
                }
            }

            U_pool[pool_idx].rho[local_idx]   = sum_rho_w / sum_w;
            U_pool[pool_idx].rhour[local_idx] = sum_rhour_w / sum_w;
            U_pool[pool_idx].rhouz[local_idx] = sum_rhouz_w / sum_w;
            U_pool[pool_idx].E[local_idx]     = sum_E_w / sum_w;
            U_pool[pool_idx].alpha1[local_idx] = sum_alpha1_w / sum_w;
            U_pool[pool_idx].alpha2[local_idx] = sum_alpha2_w / sum_w;
            U_pool[pool_idx].arho1[local_idx]  = sum_arho1_w / sum_w;
            U_pool[pool_idx].arho2[local_idx]  = sum_arho2_w / sum_w;
        }
    }

    updatePrimitiveFromConservative();
    updateActiveRegion();
}
