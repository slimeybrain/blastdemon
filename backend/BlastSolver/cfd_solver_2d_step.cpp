#include "cfd_solver_2d.hpp"
#include <cmath>
#include <iostream>
#include <algorithm>
#include <stdexcept>
#include <omp.h>

void CFDSolver2D::updateActiveRegion() {
    bool expanded = false;
    std::vector<int32_t> new_map = tile_map;

    #pragma omp parallel for collapse(2) shared(expanded, new_map)
    for (int tr = 0; tr < num_tiles_r; ++tr) {
        for (int tz = 0; tz < num_tiles_z; ++tz) {
            int pool_idx = tile_map[tr * num_tiles_z + tz];
            if (pool_idx == -1) continue;

            bool is_active = false;
            for (int k = 0; k < TILE_SIZE * TILE_SIZE; ++k) {
                if (std::abs(states_pool[pool_idx].p[k] - ambient_p) / ambient_p > 1e-4 ||
                    std::abs(states_pool[pool_idx].ur[k]) > 1e-2 ||
                    std::abs(states_pool[pool_idx].uz[k]) > 1e-2) {
                    is_active = true;
                    break;
                }
            }

            if (is_active) {
                // Activate neighbors
                int neighbors[4][2] = {{tr-1, tz}, {tr+1, tz}, {tr, tz-1}, {tr, tz+1}};
                for (int n = 0; n < 4; ++n) {
                    int ntr = neighbors[n][0];
                    int ntz = neighbors[n][1];
                    if (ntr >= 0 && ntr < num_tiles_r && ntz >= 0 && ntz < num_tiles_z) {
                        int n_flat = ntr * num_tiles_z + ntz;
                        if (tile_map[n_flat] == -1) {
                            #pragma omp critical
                            {
                                if (new_map[n_flat] == -1) {
                                    new_map[n_flat] = allocateTile(ntr, ntz);
                                    expanded = true;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    if (expanded) {
        tile_map = new_map;
    }
}

void CFDSolver2D::updatePrimitiveFromConservative() {
    const double rho_floor = 1e-8;
    const double p_floor = 1e-8;

    #pragma omp parallel for
    for (int pool_idx = 0; pool_idx < (int)U_pool.size(); ++pool_idx) {
        for (int k = 0; k < TILE_SIZE * TILE_SIZE; ++k) {
            double u_rho = U_pool[pool_idx].rho[k];
            double u_rhour = U_pool[pool_idx].rhour[k];
            double u_rhouz = U_pool[pool_idx].rhouz[k];
            double u_E = U_pool[pool_idx].E[k];
            double u_alpha1 = U_pool[pool_idx].alpha1[k];
            double u_alpha2 = U_pool[pool_idx].alpha2[k];
            double u_arho1 = U_pool[pool_idx].arho1[k];
            double u_arho2 = U_pool[pool_idx].arho2[k];

            bool bad = std::isnan(u_rho) || std::isinf(u_rho) || u_rho < rho_floor ||
                       std::isnan(u_rhour) || std::isinf(u_rhour) ||
                       std::isnan(u_rhouz) || std::isinf(u_rhouz) ||
                       std::isnan(u_E) || std::isinf(u_E);

            int floor_status = 0;
            double p = ambient_p;
            double ur = 0.0;
            double uz = 0.0;

            if (!bad) {
                double rho_safe = std::max(u_rho, rho_floor);
                ur = u_rhour / rho_safe;
                uz = u_rhouz / rho_safe;
                double ke = 0.5 * rho_safe * (ur * ur + uz * uz);

                double alpha1 = std::max(0.0, std::min(1.0, u_alpha1));
                double alpha2 = std::max(0.0, std::min(1.0, u_alpha2));
                if (alpha1 + alpha2 > 1.0) {
                    double sum = alpha1 + alpha2;
                    alpha1 /= sum;
                    alpha2 /= sum;
                }

                double arho1 = std::max(0.0, std::min(u_rho, u_arho1));
                double arho2 = std::max(0.0, std::min(u_rho, u_arho2));
                if (arho1 + arho2 > u_rho) {
                    double sum = arho1 + arho2;
                    arho1 = (arho1 / sum) * u_rho;
                    arho2 = (arho2 / sum) * u_rho;
                }

                double e_internal = std::max(u_E - ke, p_floor / (gamma - 1.0));
                p = MultiMat::getMixturePressure(e_internal, u_rho, alpha1, alpha2, arho1, arho2, gamma, currentMaterials.products, currentMaterials.unreacted);
                
                if (std::isnan(p) || std::isinf(p) || p < p_floor) {
                    bad = true;
                } else {
                    states_pool[pool_idx].rho[k] = rho_safe;
                    states_pool[pool_idx].ur[k] = ur;
                    states_pool[pool_idx].uz[k] = uz;
                    states_pool[pool_idx].E[k] = u_E;
                    states_pool[pool_idx].alpha1[k] = alpha1;
                    states_pool[pool_idx].alpha2[k] = alpha2;
                    states_pool[pool_idx].arho1[k] = arho1;
                    states_pool[pool_idx].arho2[k] = arho2;
                    states_pool[pool_idx].p[k] = p;
                }
            }

            if (bad) {
                // Fallback to ambient
                states_pool[pool_idx].rho[k] = ambient_rho;
                states_pool[pool_idx].ur[k] = 0.0;
                states_pool[pool_idx].uz[k] = 0.0;
                states_pool[pool_idx].p[k] = ambient_p;
                states_pool[pool_idx].alpha1[k] = 0.0;
                states_pool[pool_idx].alpha2[k] = 0.0;
                states_pool[pool_idx].arho1[k] = 0.0;
                states_pool[pool_idx].arho2[k] = 0.0;
                states_pool[pool_idx].E[k] = ambient_p / (gamma - 1.0);
                
                U_pool[pool_idx].rho[k] = ambient_rho;
                U_pool[pool_idx].rhour[k] = 0.0;
                U_pool[pool_idx].rhouz[k] = 0.0;
                U_pool[pool_idx].E[k] = states_pool[pool_idx].E[k];
                U_pool[pool_idx].alpha1[k] = 0.0;
                U_pool[pool_idx].alpha2[k] = 0.0;
                U_pool[pool_idx].arho1[k] = 0.0;
                U_pool[pool_idx].arho2[k] = 0.0;
            }
            
            states_pool[pool_idx].floor_status[k] = floor_status;
        }
    }
}

// --------------------------------------------------------------------------------------
// Helper to read state safely given a global coordinate
struct CellState {
    double rho, ur, uz, p, E, alpha1, alpha2, arho1, arho2;
};

inline void compute_E_cpu(CellState& s, double gamma, const MultiMat::MaterialSet& mat, bool is_ideal_gas);

inline CellState applyBC(CellState s, CFDSolver2D::BCType bc, double normal_vel, double ambient_rho, double ambient_p, double gamma, const MultiMat::MaterialSet& mat, bool is_ideal_gas, bool is_r_axis) {
    if (bc == CFDSolver2D::REFLECTIVE) {
        if (is_r_axis) {
            s.ur = -s.ur;
        } else {
            s.uz = -s.uz;
        }
    } else if (bc == CFDSolver2D::TRANSMISSIVE) {
        // Zero-gradient
    } else if (bc == CFDSolver2D::OUTFLOW_RIEMANN) {
        double c;
        if (is_ideal_gas) {
            c = std::sqrt(gamma * s.p / s.rho);
        } else {
            c = MultiMat::getMixtureSoundSpeed(s.p, s.rho, s.alpha1, s.alpha2, s.arho1, s.arho2, gamma, mat.products, mat.unreacted);
        }
        if (normal_vel < 0.0) {
            // Inflow
            s.rho = ambient_rho;
            s.ur = 0.0;
            s.uz = 0.0;
            s.p = ambient_p;
            s.alpha1 = 0.0;
            s.alpha2 = 0.0;
            s.arho1 = 0.0;
            s.arho2 = 0.0;
            s.E = is_ideal_gas ? (ambient_p / (gamma - 1.0)) : 
                  (ambient_rho * MultiMat::getEnergy_IdealGas(ambient_p, ambient_rho, gamma));
        } else if (normal_vel < c) {
            // Subsonic outflow
            s.p = ambient_p;
            compute_E_cpu(s, gamma, mat, is_ideal_gas);
        }
        // Supersonic outflow (extrapolate as is)
    }
    return s;
}

inline CellState readState(const CFDSolver2D* solver, const std::vector<int32_t>& tile_map, const std::vector<PrimitiveTile>& states_pool, int i, int j) {
    bool is_outside_i = false;
    bool is_outside_j = false;
    int original_i = i;
    int original_j = j;

    if (i < 0) {
        is_outside_i = true;
        if (solver->getBCRmin() == CFDSolver2D::REFLECTIVE) {
            i = -i - 1;
        } else {
            i = 0;
        }
    } else if (i >= solver->getNr()) {
        is_outside_i = true;
        if (solver->getBCRmax() == CFDSolver2D::REFLECTIVE) {
            i = 2 * solver->getNr() - 1 - i;
        } else {
            i = solver->getNr() - 1;
        }
    }
    if (j < 0) {
        is_outside_j = true;
        if (solver->getBCZmin() == CFDSolver2D::REFLECTIVE) {
            j = -j - 1;
        } else {
            j = 0;
        }
    } else if (j >= solver->getNz()) {
        is_outside_j = true;
        if (solver->getBCZmax() == CFDSolver2D::REFLECTIVE) {
            j = 2 * solver->getNz() - 1 - j;
        } else {
            j = solver->getNz() - 1;
        }
    }

    int tr = i / TILE_SIZE;
    int tz = j / TILE_SIZE;
    int pool_idx = tile_map[tr * ((solver->getNz() + TILE_SIZE - 1) / TILE_SIZE) + tz];

    CellState s;
    if (pool_idx == -1) {
        s = { solver->getAmbientRho(), 0.0, 0.0, solver->getAmbientP(), 
              solver->isIdealGas() ? (solver->getAmbientP() / (solver->getGamma() - 1.0)) : 
              (solver->getAmbientRho() * MultiMat::getEnergy_IdealGas(solver->getAmbientP(), solver->getAmbientRho(), solver->getGamma())), 
              0.0, 0.0, 0.0, 0.0 };
    } else {
        int local_i = i % TILE_SIZE;
        int local_j = j % TILE_SIZE;
        int k = local_i * TILE_SIZE + local_j;
        s = {
            states_pool[pool_idx].rho[k],
            states_pool[pool_idx].ur[k],
            states_pool[pool_idx].uz[k],
            states_pool[pool_idx].p[k],
            states_pool[pool_idx].E[k],
            states_pool[pool_idx].alpha1[k],
            states_pool[pool_idx].alpha2[k],
            states_pool[pool_idx].arho1[k],
            states_pool[pool_idx].arho2[k]
        };
    }

    if (is_outside_i) {
        double normal_vel = (original_i < 0) ? s.ur : -s.ur;
        s = applyBC(s, (original_i < 0) ? solver->getBCRmin() : solver->getBCRmax(), normal_vel, solver->getAmbientRho(), solver->getAmbientP(), solver->getGamma(), solver->getMaterialParameters(), solver->isIdealGas(), true);
    }
    if (is_outside_j) {
        double normal_vel = (original_j < 0) ? s.uz : -s.uz;
        s = applyBC(s, (original_j < 0) ? solver->getBCZmin() : solver->getBCZmax(), normal_vel, solver->getAmbientRho(), solver->getAmbientP(), solver->getGamma(), solver->getMaterialParameters(), solver->isIdealGas(), false);
    }

    return s;
}

// --------------------------------------------------------------------------------------
// Helpers for spatial reconstruction on CPU
inline double minmod(double a, double b) {
    if (a * b <= 0) return 0.0;
    return (std::abs(a) < std::abs(b)) ? a : b;
}

inline double weno3(double qm1, double q0, double qp1) {
    double eps = 1e-6;
    double beta0 = (qp1 - q0) * (qp1 - q0);
    double beta1 = (q0 - qm1) * (q0 - qm1);
    double alpha0 = (2.0 / 3.0) / ((eps + beta0) * (eps + beta0));
    double alpha1 = (1.0 / 3.0) / ((eps + beta1) * (eps + beta1));
    double sum_alpha = alpha0 + alpha1;
    double w0 = alpha0 / sum_alpha;
    double w1 = alpha1 / sum_alpha;
    return w0 * (0.5 * q0 + 0.5 * qp1) + w1 * (-0.5 * qm1 + 1.5 * q0);
}

inline void compute_E_cpu(CellState& s, double gamma, const MultiMat::MaterialSet& mat, bool is_ideal_gas) {
    if (s.rho < 1e-10 || s.p < 1e-10) return;
    if (is_ideal_gas) {
        s.E = s.p / (gamma - 1.0) + 0.5 * s.rho * (s.ur * s.ur + s.uz * s.uz);
    } else {
        s.E = MultiMat::getMixtureEnergy(s.p, s.rho, s.alpha1, s.alpha2, s.arho1, s.arho2, gamma, mat.products, mat.unreacted) + 0.5 * s.rho * (s.ur * s.ur + s.uz * s.uz);
    }
}

// --------------------------------------------------------------------------------------
// Flux implementations adapted for CellState
inline void calcFluxRusanov(const CellState& sL, const CellState& sR, double gamma, const MultiMat::MaterialSet& mat, 
                            double& f_rho, double& f_rhour, double& f_rhouz, double& f_E, 
                            double& f_alpha1, double& f_alpha2, double& f_arho1, double& f_arho2, double& v_face) {
    double cL = MultiMat::getMixtureSoundSpeed(sL.p, sL.rho, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, gamma, mat.products, mat.unreacted);
    double cR = MultiMat::getMixtureSoundSpeed(sR.p, sR.rho, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, gamma, mat.products, mat.unreacted);
    double s_max = std::max(std::abs(sL.ur) + cL, std::abs(sR.ur) + cR);

    double fL_rho = sL.rho * sL.ur;
    double fL_rhour = sL.rho * sL.ur * sL.ur + sL.p;
    double fL_rhouz = sL.rho * sL.ur * sL.uz;
    double fL_E = sL.ur * (sL.E + sL.p);
    
    double fR_rho = sR.rho * sR.ur;
    double fR_rhour = sR.rho * sR.ur * sR.ur + sR.p;
    double fR_rhouz = sR.rho * sR.ur * sR.uz;
    double fR_E = sR.ur * (sR.E + sR.p);

    double uL_rho = sL.rho, uL_rhour = sL.rho * sL.ur, uL_rhouz = sL.rho * sL.uz, uL_E = sL.E;
    double uR_rho = sR.rho, uR_rhour = sR.rho * sR.ur, uR_rhouz = sR.rho * sR.uz, uR_E = sR.E;

    f_rho = 0.5 * (fL_rho + fR_rho) - 0.5 * s_max * (uR_rho - uL_rho);
    f_rhour = 0.5 * (fL_rhour + fR_rhour) - 0.5 * s_max * (uR_rhour - uL_rhour);
    f_rhouz = 0.5 * (fL_rhouz + fR_rhouz) - 0.5 * s_max * (uR_rhouz - uL_rhouz);
    f_E = 0.5 * (fL_E + fR_E) - 0.5 * s_max * (uR_E - uL_E);

    v_face = 0.5 * (sL.ur + sR.ur);

    f_alpha1 = 0.5 * (sL.alpha1*sL.ur + sR.alpha1*sR.ur) - 0.5 * s_max * (sR.alpha1 - sL.alpha1);
    f_alpha2 = 0.5 * (sL.alpha2*sL.ur + sR.alpha2*sR.ur) - 0.5 * s_max * (sR.alpha2 - sL.alpha2);
    f_arho1 = 0.5 * (sL.arho1*sL.ur + sR.arho1*sR.ur) - 0.5 * s_max * (sR.arho1 - sL.arho1);
    f_arho2 = 0.5 * (sL.arho2*sL.ur + sR.arho2*sR.ur) - 0.5 * s_max * (sR.arho2 - sL.arho2);
}

inline void calcFluxRusanovZ(const CellState& sL, const CellState& sR, double gamma, const MultiMat::MaterialSet& mat, 
                            double& f_rho, double& f_rhour, double& f_rhouz, double& f_E, 
                            double& f_alpha1, double& f_alpha2, double& f_arho1, double& f_arho2, double& v_face) {
    double cL = MultiMat::getMixtureSoundSpeed(sL.p, sL.rho, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, gamma, mat.products, mat.unreacted);
    double cR = MultiMat::getMixtureSoundSpeed(sR.p, sR.rho, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, gamma, mat.products, mat.unreacted);
    double s_max = std::max(std::abs(sL.uz) + cL, std::abs(sR.uz) + cR);

    double fL_rho = sL.rho * sL.uz;
    double fL_rhour = sL.rho * sL.ur * sL.uz;
    double fL_rhouz = sL.rho * sL.uz * sL.uz + sL.p;
    double fL_E = sL.uz * (sL.E + sL.p);
    
    double fR_rho = sR.rho * sR.uz;
    double fR_rhour = sR.rho * sR.ur * sR.uz;
    double fR_rhouz = sR.rho * sR.uz * sR.uz + sR.p;
    double fR_E = sR.uz * (sR.E + sR.p);

    double uL_rho = sL.rho, uL_rhour = sL.rho * sL.ur, uL_rhouz = sL.rho * sL.uz, uL_E = sL.E;
    double uR_rho = sR.rho, uR_rhour = sR.rho * sR.ur, uR_rhouz = sR.rho * sR.uz, uR_E = sR.E;

    f_rho = 0.5 * (fL_rho + fR_rho) - 0.5 * s_max * (uR_rho - uL_rho);
    f_rhour = 0.5 * (fL_rhour + fR_rhour) - 0.5 * s_max * (uR_rhour - uL_rhour);
    f_rhouz = 0.5 * (fL_rhouz + fR_rhouz) - 0.5 * s_max * (uR_rhouz - uL_rhouz);
    f_E = 0.5 * (fL_E + fR_E) - 0.5 * s_max * (uR_E - uL_E);

    v_face = 0.5 * (sL.uz + sR.uz);

    f_alpha1 = 0.5 * (sL.alpha1*sL.uz + sR.alpha1*sR.uz) - 0.5 * s_max * (sR.alpha1 - sL.alpha1);
    f_alpha2 = 0.5 * (sL.alpha2*sL.uz + sR.alpha2*sR.uz) - 0.5 * s_max * (sR.alpha2 - sL.alpha2);
    f_arho1 = 0.5 * (sL.arho1*sL.uz + sR.arho1*sR.uz) - 0.5 * s_max * (sR.arho1 - sL.arho1);
    f_arho2 = 0.5 * (sL.arho2*sL.uz + sR.arho2*sR.uz) - 0.5 * s_max * (sR.arho2 - sL.arho2);
}

// --------------------------------------------------------------------------------------
// computeTileRHS computes the right-hand-side (spatial derivatives) for one tile
void CFDSolver2D::computeTileRHS(int pool_idx, int tr, int tz, double A_coeff, double dt) {
    for (int local_i = 0; local_i < TILE_SIZE; ++local_i) {
        for (int local_j = 0; local_j < TILE_SIZE; ++local_j) {
            int i = tr * TILE_SIZE + local_i;
            int j = tz * TILE_SIZE + local_j;
            
            if (i >= nr_cells || j >= nz_cells) continue;
            
            int k = local_i * TILE_SIZE + local_j;
            
            CellState s_c = readState(this, tile_map, states_pool, i, j);
            CellState s_L = readState(this, tile_map, states_pool, i - 1, j);
            CellState s_R = readState(this, tile_map, states_pool, i + 1, j);
            CellState s_B = readState(this, tile_map, states_pool, i, j - 1);
            CellState s_T = readState(this, tile_map, states_pool, i, j + 1);

            CellState s_faceL_L = s_L;
            CellState s_faceL_R = s_c;
            CellState s_faceR_L = s_c;
            CellState s_faceR_R = s_R;
            CellState s_faceB_L = s_B;
            CellState s_faceB_R = s_c;
            CellState s_faceT_L = s_c;
            CellState s_faceT_R = s_T;

            if (spatialOrder == 2) {
                CellState s_LL = readState(this, tile_map, states_pool, i - 2, j);
                CellState s_RR = readState(this, tile_map, states_pool, i + 2, j);
                CellState s_BB = readState(this, tile_map, states_pool, i, j - 2);
                CellState s_TT = readState(this, tile_map, states_pool, i, j + 2);

                // Reconstruct left radial face i - 1/2
                s_faceL_L.rho = s_L.rho + 0.5 * minmod(s_L.rho - s_LL.rho, s_c.rho - s_L.rho);
                s_faceL_R.rho = s_c.rho - 0.5 * minmod(s_c.rho - s_L.rho, s_R.rho - s_c.rho);
                s_faceL_L.ur  = s_L.ur + 0.5 * minmod(s_L.ur - s_LL.ur, s_c.ur - s_L.ur);
                s_faceL_R.ur  = s_c.ur - 0.5 * minmod(s_c.ur - s_L.ur, s_R.ur - s_c.ur);
                s_faceL_L.uz  = s_L.uz + 0.5 * minmod(s_L.uz - s_LL.uz, s_c.uz - s_L.uz);
                s_faceL_R.uz  = s_c.uz - 0.5 * minmod(s_c.uz - s_L.uz, s_R.uz - s_c.uz);
                s_faceL_L.p   = s_L.p + 0.5 * minmod(s_L.p - s_LL.p, s_c.p - s_L.p);
                s_faceL_R.p   = s_c.p - 0.5 * minmod(s_c.p - s_L.p, s_R.p - s_c.p);

                s_faceL_L.alpha1 = s_L.alpha1 + 0.5 * minmod(s_L.alpha1 - s_LL.alpha1, s_c.alpha1 - s_L.alpha1);
                s_faceL_L.alpha2 = s_L.alpha2 + 0.5 * minmod(s_L.alpha2 - s_LL.alpha2, s_c.alpha2 - s_L.alpha2);
                s_faceL_L.arho1  = s_L.arho1  + 0.5 * minmod(s_L.arho1 - s_LL.arho1, s_c.arho1 - s_L.arho1);
                s_faceL_L.arho2  = s_L.arho2  + 0.5 * minmod(s_L.arho2 - s_LL.arho2, s_c.arho2 - s_L.arho2);

                s_faceL_R.alpha1 = s_c.alpha1 - 0.5 * minmod(s_c.alpha1 - s_L.alpha1, s_R.alpha1 - s_c.alpha1);
                s_faceL_R.alpha2 = s_c.alpha2 - 0.5 * minmod(s_c.alpha2 - s_L.alpha2, s_R.alpha2 - s_c.alpha2);
                s_faceL_R.arho1  = s_c.arho1  - 0.5 * minmod(s_c.arho1 - s_L.arho1, s_R.arho1 - s_c.arho1);
                s_faceL_R.arho2  = s_c.arho2  - 0.5 * minmod(s_c.arho2 - s_L.arho2, s_R.arho2 - s_c.arho2);

                // Reconstruct right radial face i + 1/2
                s_faceR_L.rho = s_c.rho + 0.5 * minmod(s_c.rho - s_L.rho, s_R.rho - s_c.rho);
                s_faceR_R.rho = s_R.rho - 0.5 * minmod(s_R.rho - s_c.rho, s_RR.rho - s_R.rho);
                s_faceR_L.ur  = s_c.ur + 0.5 * minmod(s_c.ur - s_L.ur, s_R.ur - s_c.ur);
                s_faceR_R.ur  = s_R.ur - 0.5 * minmod(s_R.ur - s_c.ur, s_RR.ur - s_R.ur);
                s_faceR_L.uz  = s_c.uz + 0.5 * minmod(s_c.uz - s_L.uz, s_R.uz - s_c.uz);
                s_faceR_R.uz  = s_R.uz - 0.5 * minmod(s_R.uz - s_c.uz, s_RR.uz - s_R.uz);
                s_faceR_L.p   = s_c.p + 0.5 * minmod(s_c.p - s_L.p, s_R.p - s_c.p);
                s_faceR_R.p   = s_R.p - 0.5 * minmod(s_R.p - s_c.p, s_RR.p - s_R.p);

                s_faceR_L.alpha1 = s_c.alpha1 + 0.5 * minmod(s_c.alpha1 - s_L.alpha1, s_R.alpha1 - s_c.alpha1);
                s_faceR_L.alpha2 = s_c.alpha2 + 0.5 * minmod(s_c.alpha2 - s_L.alpha2, s_R.alpha2 - s_c.alpha2);
                s_faceR_L.arho1  = s_c.arho1  + 0.5 * minmod(s_c.arho1 - s_L.arho1, s_R.arho1 - s_c.arho1);
                s_faceR_L.arho2  = s_c.arho2  + 0.5 * minmod(s_c.arho2 - s_L.arho2, s_R.arho2 - s_c.arho2);

                s_faceR_R.alpha1 = s_R.alpha1 - 0.5 * minmod(s_R.alpha1 - s_c.alpha1, s_RR.alpha1 - s_R.alpha1);
                s_faceR_R.alpha2 = s_R.alpha2 - 0.5 * minmod(s_R.alpha2 - s_c.alpha2, s_RR.alpha2 - s_R.alpha2);
                s_faceR_R.arho1  = s_R.arho1  - 0.5 * minmod(s_R.arho1 - s_c.arho1, s_RR.arho1 - s_R.arho1);
                s_faceR_R.arho2  = s_R.arho2  - 0.5 * minmod(s_R.arho2 - s_c.arho2, s_RR.arho2 - s_R.arho2);

                // Reconstruct bottom axial face j - 1/2
                s_faceB_L.rho = s_B.rho + 0.5 * minmod(s_B.rho - s_BB.rho, s_c.rho - s_B.rho);
                s_faceB_R.rho = s_c.rho - 0.5 * minmod(s_c.rho - s_B.rho, s_T.rho - s_c.rho);
                s_faceB_L.ur  = s_B.ur + 0.5 * minmod(s_B.ur - s_BB.ur, s_c.ur - s_B.ur);
                s_faceB_R.ur  = s_c.ur - 0.5 * minmod(s_c.ur - s_B.ur, s_T.ur - s_c.ur);
                s_faceB_L.uz  = s_B.uz + 0.5 * minmod(s_B.uz - s_BB.uz, s_c.uz - s_B.uz);
                s_faceB_R.uz  = s_c.uz - 0.5 * minmod(s_c.uz - s_B.uz, s_T.uz - s_c.uz);
                s_faceB_L.p   = s_B.p + 0.5 * minmod(s_B.p - s_BB.p, s_c.p - s_B.p);
                s_faceB_R.p   = s_c.p - 0.5 * minmod(s_c.p - s_B.p, s_T.p - s_c.p);

                s_faceB_L.alpha1 = s_B.alpha1 + 0.5 * minmod(s_B.alpha1 - s_BB.alpha1, s_c.alpha1 - s_B.alpha1);
                s_faceB_L.alpha2 = s_B.alpha2 + 0.5 * minmod(s_B.alpha2 - s_BB.alpha2, s_c.alpha2 - s_B.alpha2);
                s_faceB_L.arho1  = s_B.arho1  + 0.5 * minmod(s_B.arho1 - s_BB.arho1, s_c.arho1 - s_B.arho1);
                s_faceB_L.arho2  = s_B.arho2  + 0.5 * minmod(s_B.arho2 - s_BB.arho2, s_c.arho2 - s_B.arho2);

                s_faceB_R.alpha1 = s_c.alpha1 - 0.5 * minmod(s_c.alpha1 - s_B.alpha1, s_T.alpha1 - s_c.alpha1);
                s_faceB_R.alpha2 = s_c.alpha2 - 0.5 * minmod(s_c.alpha2 - s_B.alpha2, s_T.alpha2 - s_c.alpha2);
                s_faceB_R.arho1  = s_c.arho1  - 0.5 * minmod(s_c.arho1 - s_B.arho1, s_T.arho1 - s_c.arho1);
                s_faceB_R.arho2  = s_c.arho2  - 0.5 * minmod(s_c.arho2 - s_B.arho2, s_T.arho2 - s_c.arho2);

                // Reconstruct top axial face j + 1/2
                s_faceT_L.rho = s_c.rho + 0.5 * minmod(s_c.rho - s_B.rho, s_T.rho - s_c.rho);
                s_faceT_R.rho = s_T.rho - 0.5 * minmod(s_T.rho - s_c.rho, s_TT.rho - s_T.rho);
                s_faceT_L.ur  = s_c.ur + 0.5 * minmod(s_c.ur - s_B.ur, s_T.ur - s_c.ur);
                s_faceT_R.ur  = s_T.ur - 0.5 * minmod(s_T.ur - s_c.ur, s_TT.ur - s_T.ur);
                s_faceT_L.uz  = s_c.uz + 0.5 * minmod(s_c.uz - s_B.uz, s_T.uz - s_c.uz);
                s_faceT_R.uz  = s_T.uz - 0.5 * minmod(s_T.uz - s_c.uz, s_TT.uz - s_T.uz);
                s_faceT_L.p   = s_c.p + 0.5 * minmod(s_c.p - s_B.p, s_T.p - s_c.p);
                s_faceT_R.p   = s_T.p - 0.5 * minmod(s_T.p - s_c.p, s_TT.p - s_T.p);

                s_faceT_L.alpha1 = s_c.alpha1 + 0.5 * minmod(s_c.alpha1 - s_B.alpha1, s_T.alpha1 - s_c.alpha1);
                s_faceT_L.alpha2 = s_c.alpha2 + 0.5 * minmod(s_c.alpha2 - s_B.alpha2, s_T.alpha2 - s_c.alpha2);
                s_faceT_L.arho1  = s_c.arho1  + 0.5 * minmod(s_c.arho1 - s_B.arho1, s_T.arho1 - s_c.arho1);
                s_faceT_L.arho2  = s_c.arho2  + 0.5 * minmod(s_c.arho2 - s_B.arho2, s_T.arho2 - s_c.arho2);

                s_faceT_R.alpha1 = s_T.alpha1 - 0.5 * minmod(s_T.alpha1 - s_c.alpha1, s_TT.alpha1 - s_T.alpha1);
                s_faceT_R.alpha2 = s_T.alpha2 - 0.5 * minmod(s_T.alpha2 - s_c.alpha2, s_TT.alpha2 - s_T.alpha2);
                s_faceT_R.arho1  = s_T.arho1  - 0.5 * minmod(s_T.arho1 - s_c.arho1, s_TT.arho1 - s_T.arho1);
                s_faceT_R.arho2  = s_T.arho2  - 0.5 * minmod(s_T.arho2 - s_c.arho2, s_TT.arho2 - s_T.arho2);

                // Clamp volume fractions
                s_faceL_L.alpha1 = std::max(0.0, std::min(1.0, s_faceL_L.alpha1)); s_faceL_L.alpha2 = std::max(0.0, std::min(1.0, s_faceL_L.alpha2));
                s_faceL_R.alpha1 = std::max(0.0, std::min(1.0, s_faceL_R.alpha1)); s_faceL_R.alpha2 = std::max(0.0, std::min(1.0, s_faceL_R.alpha2));
                s_faceR_L.alpha1 = std::max(0.0, std::min(1.0, s_faceR_L.alpha1)); s_faceR_L.alpha2 = std::max(0.0, std::min(1.0, s_faceR_L.alpha2));
                s_faceR_R.alpha1 = std::max(0.0, std::min(1.0, s_faceR_R.alpha1)); s_faceR_R.alpha2 = std::max(0.0, std::min(1.0, s_faceR_R.alpha2));
                s_faceB_L.alpha1 = std::max(0.0, std::min(1.0, s_faceB_L.alpha1)); s_faceB_L.alpha2 = std::max(0.0, std::min(1.0, s_faceB_L.alpha2));
                s_faceB_R.alpha1 = std::max(0.0, std::min(1.0, s_faceB_R.alpha1)); s_faceB_R.alpha2 = std::max(0.0, std::min(1.0, s_faceB_R.alpha2));
                s_faceT_L.alpha1 = std::max(0.0, std::min(1.0, s_faceT_L.alpha1)); s_faceT_L.alpha2 = std::max(0.0, std::min(1.0, s_faceT_L.alpha2));
                s_faceT_R.alpha1 = std::max(0.0, std::min(1.0, s_faceT_R.alpha1)); s_faceT_R.alpha2 = std::max(0.0, std::min(1.0, s_faceT_R.alpha2));

                // Recompute energies
                compute_E_cpu(s_faceL_L, gamma, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceL_R, gamma, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceR_L, gamma, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceR_R, gamma, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceB_L, gamma, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceB_R, gamma, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceT_L, gamma, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceT_R, gamma, currentMaterials, is_ideal_gas);

            } else if (spatialOrder == 3) {
                CellState s_LL = readState(this, tile_map, states_pool, i - 2, j);
                CellState s_RR = readState(this, tile_map, states_pool, i + 2, j);
                CellState s_BB = readState(this, tile_map, states_pool, i, j - 2);
                CellState s_TT = readState(this, tile_map, states_pool, i, j + 2);

                // Reconstruct left radial face i - 1/2 using WENO3
                s_faceL_L.rho = weno3(s_LL.rho, s_L.rho, s_c.rho);
                s_faceL_R.rho = weno3(s_R.rho, s_c.rho, s_L.rho);
                s_faceL_L.ur  = weno3(s_LL.ur, s_L.ur, s_c.ur);
                s_faceL_R.ur  = weno3(s_R.ur, s_c.ur, s_L.ur);
                s_faceL_L.uz  = weno3(s_LL.uz, s_L.uz, s_c.uz);
                s_faceL_R.uz  = weno3(s_R.uz, s_c.uz, s_L.uz);
                s_faceL_L.p   = weno3(s_LL.p, s_L.p, s_c.p);
                s_faceL_R.p   = weno3(s_R.p, s_c.p, s_L.p);

                // Reconstruct right radial face i + 1/2 using WENO3
                s_faceR_L.rho = weno3(s_L.rho, s_c.rho, s_R.rho);
                s_faceR_R.rho = weno3(s_RR.rho, s_R.rho, s_c.rho);
                s_faceR_L.ur  = weno3(s_L.ur, s_c.ur, s_R.ur);
                s_faceR_R.ur  = weno3(s_RR.ur, s_R.ur, s_c.ur);
                s_faceR_L.uz  = weno3(s_L.uz, s_c.uz, s_R.uz);
                s_faceR_R.uz  = weno3(s_RR.uz, s_R.uz, s_c.uz);
                s_faceR_L.p   = weno3(s_L.p, s_c.p, s_R.p);
                s_faceR_R.p   = weno3(s_RR.p, s_R.p, s_c.p);

                // Reconstruct bottom axial face j - 1/2 using WENO3
                s_faceB_L.rho = weno3(s_BB.rho, s_B.rho, s_c.rho);
                s_faceB_R.rho = weno3(s_T.rho, s_c.rho, s_B.rho);
                s_faceB_L.ur  = weno3(s_BB.ur, s_B.ur, s_c.ur);
                s_faceB_R.ur  = weno3(s_T.ur, s_c.ur, s_B.ur);
                s_faceB_L.uz  = weno3(s_BB.uz, s_B.uz, s_c.uz);
                s_faceB_R.uz  = weno3(s_T.uz, s_c.uz, s_B.uz);
                s_faceB_L.p   = weno3(s_BB.p, s_B.p, s_c.p);
                s_faceB_R.p   = weno3(s_T.p, s_c.p, s_B.p);

                // Reconstruct top axial face j + 1/2 using WENO3
                s_faceT_L.rho = weno3(s_B.rho, s_c.rho, s_T.rho);
                s_faceT_R.rho = weno3(s_TT.rho, s_T.rho, s_c.rho);
                s_faceT_L.ur  = weno3(s_B.ur, s_c.ur, s_T.ur);
                s_faceT_R.ur  = weno3(s_TT.ur, s_T.ur, s_c.ur);
                s_faceT_L.uz  = weno3(s_B.uz, s_c.uz, s_T.uz);
                s_faceT_R.uz  = weno3(s_TT.uz, s_T.uz, s_c.uz);
                s_faceT_L.p   = weno3(s_B.p, s_c.p, s_T.p);
                s_faceT_R.p   = weno3(s_TT.p, s_T.p, s_c.p);

                // Species fractions are reconstructed using second-order minmod for stability
                s_faceL_L.alpha1 = s_L.alpha1 + 0.5 * minmod(s_L.alpha1 - s_LL.alpha1, s_c.alpha1 - s_L.alpha1);
                s_faceL_L.alpha2 = s_L.alpha2 + 0.5 * minmod(s_L.alpha2 - s_LL.alpha2, s_c.alpha2 - s_L.alpha2);
                s_faceL_L.arho1  = s_L.arho1  + 0.5 * minmod(s_L.arho1 - s_LL.arho1, s_c.arho1 - s_L.arho1);
                s_faceL_L.arho2  = s_L.arho2  + 0.5 * minmod(s_L.arho2 - s_LL.arho2, s_c.arho2 - s_L.arho2);

                s_faceL_R.alpha1 = s_c.alpha1 - 0.5 * minmod(s_c.alpha1 - s_L.alpha1, s_R.alpha1 - s_c.alpha1);
                s_faceL_R.alpha2 = s_c.alpha2 - 0.5 * minmod(s_c.alpha2 - s_L.alpha2, s_R.alpha2 - s_c.alpha2);
                s_faceL_R.arho1  = s_c.arho1  - 0.5 * minmod(s_c.arho1 - s_L.arho1, s_R.arho1 - s_c.arho1);
                s_faceL_R.arho2  = s_c.arho2  - 0.5 * minmod(s_c.arho2 - s_L.arho2, s_R.arho2 - s_c.arho2);

                s_faceR_L.alpha1 = s_c.alpha1 + 0.5 * minmod(s_c.alpha1 - s_L.alpha1, s_R.alpha1 - s_c.alpha1);
                s_faceR_L.alpha2 = s_c.alpha2 + 0.5 * minmod(s_c.alpha2 - s_L.alpha2, s_R.alpha2 - s_c.alpha2);
                s_faceR_L.arho1  = s_c.arho1  + 0.5 * minmod(s_c.arho1 - s_L.arho1, s_R.arho1 - s_c.arho1);
                s_faceR_L.arho2  = s_c.arho2  + 0.5 * minmod(s_c.arho2 - s_L.arho2, s_R.arho2 - s_c.arho2);

                s_faceR_R.alpha1 = s_R.alpha1 - 0.5 * minmod(s_R.alpha1 - s_c.alpha1, s_RR.alpha1 - s_R.alpha1);
                s_faceR_R.alpha2 = s_R.alpha2 - 0.5 * minmod(s_R.alpha2 - s_c.alpha2, s_RR.alpha2 - s_R.alpha2);
                s_faceR_R.arho1  = s_R.arho1  - 0.5 * minmod(s_R.arho1 - s_c.arho1, s_RR.arho1 - s_R.arho1);
                s_faceR_R.arho2  = s_R.arho2  - 0.5 * minmod(s_R.arho2 - s_c.arho2, s_RR.arho2 - s_R.arho2);

                s_faceB_L.alpha1 = s_B.alpha1 + 0.5 * minmod(s_B.alpha1 - s_BB.alpha1, s_c.alpha1 - s_B.alpha1);
                s_faceB_L.alpha2 = s_B.alpha2 + 0.5 * minmod(s_B.alpha2 - s_BB.alpha2, s_c.alpha2 - s_B.alpha2);
                s_faceB_L.arho1  = s_B.arho1  + 0.5 * minmod(s_B.arho1 - s_BB.arho1, s_c.arho1 - s_B.arho1);
                s_faceB_L.arho2  = s_B.arho2  + 0.5 * minmod(s_B.arho2 - s_BB.arho2, s_c.arho2 - s_B.arho2);

                s_faceB_R.alpha1 = s_c.alpha1 - 0.5 * minmod(s_c.alpha1 - s_B.alpha1, s_T.alpha1 - s_c.alpha1);
                s_faceB_R.alpha2 = s_c.alpha2 - 0.5 * minmod(s_c.alpha2 - s_B.alpha2, s_T.alpha2 - s_c.alpha2);
                s_faceB_R.arho1  = s_c.arho1  - 0.5 * minmod(s_c.arho1 - s_B.arho1, s_T.arho1 - s_c.arho1);
                s_faceB_R.arho2  = s_c.arho2  - 0.5 * minmod(s_c.arho2 - s_B.arho2, s_T.arho2 - s_c.arho2);

                s_faceT_L.alpha1 = s_c.alpha1 + 0.5 * minmod(s_c.alpha1 - s_B.alpha1, s_T.alpha1 - s_c.alpha1);
                s_faceT_L.alpha2 = s_c.alpha2 + 0.5 * minmod(s_c.alpha2 - s_B.alpha2, s_T.alpha2 - s_c.alpha2);
                s_faceT_L.arho1  = s_c.arho1  + 0.5 * minmod(s_c.arho1 - s_B.arho1, s_T.arho1 - s_c.arho1);
                s_faceT_L.arho2  = s_c.arho2  + 0.5 * minmod(s_c.arho2 - s_B.arho2, s_T.arho2 - s_c.arho2);

                s_faceT_R.alpha1 = s_T.alpha1 - 0.5 * minmod(s_T.alpha1 - s_c.alpha1, s_TT.alpha1 - s_T.alpha1);
                s_faceT_R.alpha2 = s_T.alpha2 - 0.5 * minmod(s_T.alpha2 - s_c.alpha2, s_TT.alpha2 - s_T.alpha2);
                s_faceT_R.arho1  = s_T.arho1  - 0.5 * minmod(s_T.arho1 - s_c.arho1, s_TT.arho1 - s_T.arho1);
                s_faceT_R.arho2  = s_T.arho2  - 0.5 * minmod(s_T.arho2 - s_c.arho2, s_TT.arho2 - s_T.arho2);

                // Clamp volume fractions
                s_faceL_L.alpha1 = std::max(0.0, std::min(1.0, s_faceL_L.alpha1)); s_faceL_L.alpha2 = std::max(0.0, std::min(1.0, s_faceL_L.alpha2));
                s_faceL_R.alpha1 = std::max(0.0, std::min(1.0, s_faceL_R.alpha1)); s_faceL_R.alpha2 = std::max(0.0, std::min(1.0, s_faceL_R.alpha2));
                s_faceR_L.alpha1 = std::max(0.0, std::min(1.0, s_faceR_L.alpha1)); s_faceR_L.alpha2 = std::max(0.0, std::min(1.0, s_faceR_L.alpha2));
                s_faceR_R.alpha1 = std::max(0.0, std::min(1.0, s_faceR_R.alpha1)); s_faceR_R.alpha2 = std::max(0.0, std::min(1.0, s_faceR_R.alpha2));
                s_faceB_L.alpha1 = std::max(0.0, std::min(1.0, s_faceB_L.alpha1)); s_faceB_L.alpha2 = std::max(0.0, std::min(1.0, s_faceB_L.alpha2));
                s_faceB_R.alpha1 = std::max(0.0, std::min(1.0, s_faceB_R.alpha1)); s_faceB_R.alpha2 = std::max(0.0, std::min(1.0, s_faceB_R.alpha2));
                s_faceT_L.alpha1 = std::max(0.0, std::min(1.0, s_faceT_L.alpha1)); s_faceT_L.alpha2 = std::max(0.0, std::min(1.0, s_faceT_L.alpha2));
                s_faceT_R.alpha1 = std::max(0.0, std::min(1.0, s_faceT_R.alpha1)); s_faceT_R.alpha2 = std::max(0.0, std::min(1.0, s_faceT_R.alpha2));

                // Recompute energies
                compute_E_cpu(s_faceL_L, gamma, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceL_R, gamma, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceR_L, gamma, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceR_R, gamma, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceB_L, gamma, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceB_R, gamma, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceT_L, gamma, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceT_R, gamma, currentMaterials, is_ideal_gas);
            }

            double fr_L_rho, fr_L_rhour, fr_L_rhouz, fr_L_E, fr_L_a1, fr_L_a2, fr_L_ar1, fr_L_ar2, v_face_rL;
            double fr_R_rho, fr_R_rhour, fr_R_rhouz, fr_R_E, fr_R_a1, fr_R_a2, fr_R_ar1, fr_R_ar2, v_face_rR;
            
            calcFluxRusanov(s_faceL_L, s_faceL_R, gamma, currentMaterials, fr_L_rho, fr_L_rhour, fr_L_rhouz, fr_L_E, fr_L_a1, fr_L_a2, fr_L_ar1, fr_L_ar2, v_face_rL);
            calcFluxRusanov(s_faceR_L, s_faceR_R, gamma, currentMaterials, fr_R_rho, fr_R_rhour, fr_R_rhouz, fr_R_E, fr_R_a1, fr_R_a2, fr_R_ar1, fr_R_ar2, v_face_rR);
            
            double fz_B_rho, fz_B_rhour, fz_B_rhouz, fz_B_E, fz_B_a1, fz_B_a2, fz_B_ar1, fz_B_ar2, v_face_zB;
            double fz_T_rho, fz_T_rhour, fz_T_rhouz, fz_T_E, fz_T_a1, fz_T_a2, fz_T_ar1, fz_T_ar2, v_face_zT;

            calcFluxRusanovZ(s_faceB_L, s_faceB_R, gamma, currentMaterials, fz_B_rho, fz_B_rhour, fz_B_rhouz, fz_B_E, fz_B_a1, fz_B_a2, fz_B_ar1, fz_B_ar2, v_face_zB);
            calcFluxRusanovZ(s_faceT_L, s_faceT_R, gamma, currentMaterials, fz_T_rho, fz_T_rhour, fz_T_rhouz, fz_T_E, fz_T_a1, fz_T_a2, fz_T_ar1, fz_T_ar2, v_face_zT);

            double r_center = (i + 0.5) * dr;
            double r_left = i * dr;
            double r_right = (i + 1) * dr;
            
            double dU_rho = -(1.0 / (r_center * dr)) * (r_right * fr_R_rho - r_left * fr_L_rho) - (1.0 / dz) * (fz_T_rho - fz_B_rho);
            double dU_rhour = -(1.0 / (r_center * dr)) * (r_right * fr_R_rhour - r_left * fr_L_rhour) - (1.0 / dz) * (fz_T_rhour - fz_B_rhour) + s_c.p / r_center;
            double dU_rhouz = -(1.0 / (r_center * dr)) * (r_right * fr_R_rhouz - r_left * fr_L_rhouz) - (1.0 / dz) * (fz_T_rhouz - fz_B_rhouz);
            double dU_E = -(1.0 / (r_center * dr)) * (r_right * fr_R_E - r_left * fr_L_E) - (1.0 / dz) * (fz_T_E - fz_B_E);

            double div_u = (1.0 / (r_center * dr)) * (r_right * v_face_rR - r_left * v_face_rL) + (1.0 / dz) * (v_face_zT - v_face_zB);
            
            double dU_alpha1 = -(1.0 / (r_center * dr)) * (r_right * fr_R_a1 - r_left * fr_L_a1) - (1.0 / dz) * (fz_T_a1 - fz_B_a1) + s_c.alpha1 * div_u;
            double dU_alpha2 = -(1.0 / (r_center * dr)) * (r_right * fr_R_a2 - r_left * fr_L_a2) - (1.0 / dz) * (fz_T_a2 - fz_B_a2) + s_c.alpha2 * div_u;
            double dU_arho1 = -(1.0 / (r_center * dr)) * (r_right * fr_R_ar1 - r_left * fr_L_ar1) - (1.0 / dz) * (fz_T_ar1 - fz_B_ar1);
            double dU_arho2 = -(1.0 / (r_center * dr)) * (r_right * fr_R_ar2 - r_left * fr_L_ar2) - (1.0 / dz) * (fz_T_ar2 - fz_B_ar2);

            dU_pool[pool_idx].rho[k] = A_coeff * dU_pool[pool_idx].rho[k] + dt * dU_rho;
            dU_pool[pool_idx].rhour[k] = A_coeff * dU_pool[pool_idx].rhour[k] + dt * dU_rhour;
            dU_pool[pool_idx].rhouz[k] = A_coeff * dU_pool[pool_idx].rhouz[k] + dt * dU_rhouz;
            dU_pool[pool_idx].E[k] = A_coeff * dU_pool[pool_idx].E[k] + dt * dU_E;
            dU_pool[pool_idx].alpha1[k] = A_coeff * dU_pool[pool_idx].alpha1[k] + dt * dU_alpha1;
            dU_pool[pool_idx].alpha2[k] = A_coeff * dU_pool[pool_idx].alpha2[k] + dt * dU_alpha2;
            dU_pool[pool_idx].arho1[k] = A_coeff * dU_pool[pool_idx].arho1[k] + dt * dU_arho1;
            dU_pool[pool_idx].arho2[k] = A_coeff * dU_pool[pool_idx].arho2[k] + dt * dU_arho2;
        }
    }
}

// --------------------------------------------------------------------------------------
// applyLSRK3Step performs one stage of Williamson's LSRK3
void CFDSolver2D::applyLSRK3Step(int stage, double dt) {
    const double A[3] = {0.0, -5.0/9.0, -153.0/128.0};
    const double B[3] = {1.0/3.0, 15.0/16.0, 8.0/15.0};
    
    #pragma omp parallel for collapse(2)
    for (int tr = 0; tr < num_tiles_r; ++tr) {
        for (int tz = 0; tz < num_tiles_z; ++tz) {
            int pool_idx = tile_map[tr * num_tiles_z + tz];
            if (pool_idx == -1) continue;
            
            computeTileRHS(pool_idx, tr, tz, A[stage], dt);
        }
    }

    #pragma omp parallel for
    for (int pool_idx = 0; pool_idx < (int)U_pool.size(); ++pool_idx) {
        for (int k = 0; k < TILE_SIZE * TILE_SIZE; ++k) {
            U_pool[pool_idx].rho[k] += B[stage] * dU_pool[pool_idx].rho[k];
            U_pool[pool_idx].rhour[k] += B[stage] * dU_pool[pool_idx].rhour[k];
            U_pool[pool_idx].rhouz[k] += B[stage] * dU_pool[pool_idx].rhouz[k];
            U_pool[pool_idx].E[k] += B[stage] * dU_pool[pool_idx].E[k];
            U_pool[pool_idx].alpha1[k] += B[stage] * dU_pool[pool_idx].alpha1[k];
            U_pool[pool_idx].alpha2[k] += B[stage] * dU_pool[pool_idx].alpha2[k];
            U_pool[pool_idx].arho1[k] += B[stage] * dU_pool[pool_idx].arho1[k];
            U_pool[pool_idx].arho2[k] += B[stage] * dU_pool[pool_idx].arho2[k];
        }
    }
}

void CFDSolver2D::step(double dt) {
    if (temporalOrder == 1) {
        // Forward Euler
        #pragma omp parallel for collapse(2)
        for (int tr = 0; tr < num_tiles_r; ++tr) {
            for (int tz = 0; tz < num_tiles_z; ++tz) {
                int pool_idx = tile_map[tr * num_tiles_z + tz];
                if (pool_idx == -1) continue;
                computeTileRHS(pool_idx, tr, tz, 0.0, 1.0);
            }
        }
        #pragma omp parallel for
        for (int pool_idx = 0; pool_idx < (int)U_pool.size(); ++pool_idx) {
            for (int k = 0; k < TILE_SIZE * TILE_SIZE; ++k) {
                U_pool[pool_idx].rho[k] += dt * dU_pool[pool_idx].rho[k];
                U_pool[pool_idx].rhour[k] += dt * dU_pool[pool_idx].rhour[k];
                U_pool[pool_idx].rhouz[k] += dt * dU_pool[pool_idx].rhouz[k];
                U_pool[pool_idx].E[k] += dt * dU_pool[pool_idx].E[k];
                U_pool[pool_idx].alpha1[k] += dt * dU_pool[pool_idx].alpha1[k];
                U_pool[pool_idx].alpha2[k] += dt * dU_pool[pool_idx].alpha2[k];
                U_pool[pool_idx].arho1[k] += dt * dU_pool[pool_idx].arho1[k];
                U_pool[pool_idx].arho2[k] += dt * dU_pool[pool_idx].arho2[k];
            }
        }
    } else {
        // Tiled LSRK3 (Williamson)
        for (int stage = 0; stage < 3; ++stage) {
            applyLSRK3Step(stage, dt);
            updatePrimitiveFromConservative();
            updateActiveRegion();
        }
    }
    
    // Programmed Burn
    #pragma omp parallel for collapse(2)
    for (int tr = 0; tr < num_tiles_r; ++tr) {
        for (int tz = 0; tz < num_tiles_z; ++tz) {
            int pool_idx = tile_map[tr * num_tiles_z + tz];
            if (pool_idx == -1) continue;

            for (int local_i = 0; local_i < TILE_SIZE; ++local_i) {
                for (int local_j = 0; local_j < TILE_SIZE; ++local_j) {
                    int i = tr * TILE_SIZE + local_i;
                    int j = tz * TILE_SIZE + local_j;
                    if (i >= nr_cells || j >= nz_cells) continue;
                    
                    int k = local_i * TILE_SIZE + local_j;
                    
                    double r_c = (i + 0.5) * dr;
                    double z_c = (j + 0.5) * dz;
                    double dF = MultiMat::computeProgrammedBurn(currentTime, dt, r_c, 0, z_c, currentMaterials.det_vel, 0.0, det_x, det_y, det_z, std::min(dr, dz), currentMaterials.products.rho0, U_pool[pool_idx].alpha1[k], U_pool[pool_idx].alpha2[k], U_pool[pool_idx].arho1[k], U_pool[pool_idx].arho2[k]);
                    if (currentMaterials.detonation_energy > 0.0 && dF > 0.0) {
                        double rho_expl = U_pool[pool_idx].arho1[k] + U_pool[pool_idx].arho2[k];
                        U_pool[pool_idx].E[k] += dF * rho_expl * currentMaterials.detonation_energy;
                    }
                }
            }
        }
    }
    updatePrimitiveFromConservative();
    updateActiveRegion();
    currentTime += dt;
}

std::vector<State2D> CFDSolver2D::getStates() const {
    std::vector<State2D> out(nr_cells * nz_cells);
    for (int i = 0; i < nr_cells; ++i) {
        for (int j = 0; j < nz_cells; ++j) {
            CellState s = readState(this, tile_map, states_pool, i, j);
            int idx = i * nz_cells + j;
            out[idx].rho = s.rho;
            out[idx].ur = s.ur;
            out[idx].uz = s.uz;
            out[idx].p = s.p;
            out[idx].E = s.E;
            out[idx].alpha1 = s.alpha1;
            out[idx].alpha2 = s.alpha2;
            out[idx].arho1 = s.arho1;
            out[idx].arho2 = s.arho2;
            out[idx].floor_status = 0; // Or whatever
        }
    }
    return out;
}

std::vector<float> CFDSolver2D::getTelemetry2D(int stride) const {
    if (stride < 1) stride = 1;
    int out_nr = (nr_cells + stride - 1) / stride;
    int out_nz = (nz_cells + stride - 1) / stride;
    int n_ch = 7;
    std::vector<float> out(n_ch * out_nr * out_nz);
    float* data = out.data();
    int dest_stride = out_nr * out_nz;

    #pragma omp parallel for collapse(2)
    for (int i = 0; i < out_nr; ++i) {
        for (int j = 0; j < out_nz; ++j) {
            int src_i = std::min(nr_cells - 1, i * stride);
            int src_j = std::min(nz_cells - 1, j * stride);
            CellState s = readState(this, tile_map, states_pool, src_i, src_j);
            int idx = i * out_nz + j;
            data[0 * dest_stride + idx] = s.p;
            data[1 * dest_stride + idx] = s.rho;
            data[2 * dest_stride + idx] = s.ur;
            data[3 * dest_stride + idx] = s.uz;
            data[4 * dest_stride + idx] = s.E;
            data[5 * dest_stride + idx] = s.alpha1;
            data[6 * dest_stride + idx] = s.alpha2;
        }
    }
    return out;
}

double CFDSolver2D::computeStepSize(double cfl) const {
    double max_speed = 1e-6;
    #pragma omp parallel for reduction(max:max_speed)
    for (int pool_idx = 0; pool_idx < (int)states_pool.size(); ++pool_idx) {
        for (int k = 0; k < TILE_SIZE * TILE_SIZE; ++k) {
            double c = MultiMat::getMixtureSoundSpeed(states_pool[pool_idx].p[k], states_pool[pool_idx].rho[k], states_pool[pool_idx].alpha1[k], states_pool[pool_idx].alpha2[k], states_pool[pool_idx].arho1[k], states_pool[pool_idx].arho2[k], gamma, currentMaterials.products, currentMaterials.unreacted);
            double s = std::max(std::abs(states_pool[pool_idx].ur[k]), std::abs(states_pool[pool_idx].uz[k])) + c;
            max_speed = std::max(max_speed, s);
        }
    }
    return cfl * std::min(dr, dz) / max_speed;
}

void CFDSolver2D::run(double duration) {
    double target_time = currentTime + duration;
    while (currentTime < target_time) {
        double dt = computeStepSize(0.35);
        if (currentTime + dt > target_time) dt = target_time - currentTime;
        step(dt);
        currentTime += dt;
    }
}

std::vector<float> CFDSolver2D::getCellValues(int i, int j) const {
    std::vector<float> vals(7, 0.0f);
    if (i < 0 || i >= nr_cells || j < 0 || j >= nz_cells) return vals;
    
    CellState s = readState(this, tile_map, states_pool, i, j);
    vals[0] = static_cast<float>(s.p);
    vals[1] = static_cast<float>(s.rho);
    double u_mag = std::sqrt(s.ur * s.ur + s.uz * s.uz);
    vals[2] = static_cast<float>(u_mag);
    
    double e_int = (s.rho > 0.0) ? (s.E / s.rho - 0.5 * u_mag * u_mag) : 0.0;
    vals[3] = static_cast<float>(e_int);
    
    vals[4] = static_cast<float>(std::clamp(s.alpha1, 0.0, 1.0));
    vals[5] = static_cast<float>(std::clamp(s.alpha2, 0.0, 1.0));
    double air_frac = 1.0 - s.alpha1 - s.alpha2;
    vals[6] = static_cast<float>(std::clamp(air_frac, 0.0, 1.0));
    
    return vals;
}

bool CFDSolver2D::checkTerminationCondition() const {
    double threshold = 1.05 * ambient_p;
    
    auto get_cell_p = [&](int i, int j) -> double {
        int tr = i / TILE_SIZE;
        int tz = j / TILE_SIZE;
        int pool_idx = tile_map[tr * ((nz_cells + TILE_SIZE - 1) / TILE_SIZE) + tz];
        if (pool_idx == -1) return ambient_p;
        int local_i = i % TILE_SIZE;
        int local_j = j % TILE_SIZE;
        return states_pool[pool_idx].p[local_i * TILE_SIZE + local_j];
    };

    if (bcRmin == OUTFLOW_RIEMANN) {
        for (int j = 0; j < nz_cells; ++j) {
            if (get_cell_p(0, j) > threshold) return true;
        }
    }
    if (bcRmax == OUTFLOW_RIEMANN) {
        for (int j = 0; j < nz_cells; ++j) {
            if (get_cell_p(nr_cells - 1, j) > threshold) return true;
        }
    }
    if (bcZmin == OUTFLOW_RIEMANN) {
        for (int i = 0; i < nr_cells; ++i) {
            if (get_cell_p(i, 0) > threshold) return true;
        }
    }
    if (bcZmax == OUTFLOW_RIEMANN) {
        for (int i = 0; i < nr_cells; ++i) {
            if (get_cell_p(i, nz_cells - 1) > threshold) return true;
        }
    }
    return false;
}

