#include "cfd_solver_2d.hpp"
#include <cmath>
#include <iostream>
#include <algorithm>
#include <stdexcept>
#include <omp.h>

template <typename RealType>
void CFDSolver2DImpl<RealType>::updateActiveRegion() {
    bool expanded = false;
    std::vector<int32_t> new_map = tile_map;

    #pragma omp parallel for collapse(2) shared(expanded, new_map)
    for (int tr = 0; tr < num_tiles_r; ++tr) {
        for (int tz = 0; tz < num_tiles_z; ++tz) {
            int pool_idx = tile_map[tr * num_tiles_z + tz];
            if (pool_idx == -1) continue;

            bool is_active = false;
            for (int k = 0; k < TILE_SIZE * TILE_SIZE; ++k) {
                if (std::abs((double)states_pool[pool_idx].p[k] - ambient_p) / ambient_p > 1e-4 ||
                    std::abs((double)states_pool[pool_idx].ur[k]) > 1e-2 ||
                    std::abs((double)states_pool[pool_idx].uz[k]) > 1e-2) {
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

template <typename RealType>
void CFDSolver2DImpl<RealType>::updatePrimitiveFromConservative() {
    const RealType rho_floor = (RealType)1e-8;
    const RealType p_floor = (RealType)1e-8;

    #pragma omp parallel for
    for (int pool_idx = 0; pool_idx < (int)U_pool.size(); ++pool_idx) {
        for (int k = 0; k < TILE_SIZE * TILE_SIZE; ++k) {
            RealType u_rho = U_pool[pool_idx].rho[k];
            RealType u_rhour = U_pool[pool_idx].rhour[k];
            RealType u_rhouz = U_pool[pool_idx].rhouz[k];
            RealType u_E = U_pool[pool_idx].E[k];
            RealType u_alpha1 = U_pool[pool_idx].alpha1[k];
            RealType u_alpha2 = U_pool[pool_idx].alpha2[k];
            RealType u_arho1 = U_pool[pool_idx].arho1[k];
            RealType u_arho2 = U_pool[pool_idx].arho2[k];

            bool bad = std::isnan(u_rho) || std::isinf(u_rho) || u_rho < rho_floor ||
                       std::isnan(u_rhour) || std::isinf(u_rhour) ||
                       std::isnan(u_rhouz) || std::isinf(u_rhouz) ||
                       std::isnan(u_E) || std::isinf(u_E);

            int floor_status = 0;
            RealType p = (RealType)ambient_p;
            RealType ur = 0.0;
            RealType uz = 0.0;

            if (!bad) {
                RealType rho_safe = std::max(u_rho, rho_floor);
                ur = u_rhour / rho_safe;
                uz = u_rhouz / rho_safe;
                RealType ke = 0.5 * rho_safe * (ur * ur + uz * uz);

                RealType alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, u_alpha1));
                RealType alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, u_alpha2));
                if (alpha1 + alpha2 > (RealType)1.0) {
                    RealType sum = alpha1 + alpha2;
                    alpha1 /= sum;
                    alpha2 /= sum;
                }

                RealType arho1 = std::max((RealType)0.0, std::min(u_rho, u_arho1));
                RealType arho2 = std::max((RealType)0.0, std::min(u_rho, u_arho2));
                if (arho1 + arho2 > u_rho) {
                    RealType sum = arho1 + arho2;
                    arho1 = (arho1 / sum) * u_rho;
                    arho2 = (arho2 / sum) * u_rho;
                }

                RealType e_internal = std::max(u_E - ke, p_floor / ((RealType)gamma - (RealType)1.0));
                p = (RealType)MultiMat::getMixturePressure((double)e_internal, (double)u_rho, (double)alpha1, (double)alpha2, (double)arho1, (double)arho2, gamma, currentMaterials.products, currentMaterials.unreacted);
                
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
                states_pool[pool_idx].rho[k] = (RealType)ambient_rho;
                states_pool[pool_idx].ur[k] = 0.0;
                states_pool[pool_idx].uz[k] = 0.0;
                states_pool[pool_idx].p[k] = (RealType)ambient_p;
                states_pool[pool_idx].alpha1[k] = 0.0;
                states_pool[pool_idx].alpha2[k] = 0.0;
                states_pool[pool_idx].arho1[k] = 0.0;
                states_pool[pool_idx].arho2[k] = 0.0;
                states_pool[pool_idx].E[k] = (RealType)ambient_p / ((RealType)gamma - (RealType)1.0);
                
                U_pool[pool_idx].rho[k] = (RealType)ambient_rho;
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
template <typename RealType>
struct CellStateT {
    RealType rho, ur, uz, p, E, alpha1, alpha2, arho1, arho2;
};

template <typename RealType>
inline void compute_E_cpu(CellStateT<RealType>& s, RealType gamma, const MultiMat::MaterialSet& mat, bool is_ideal_gas) {
    if (s.rho < (RealType)1e-10 || s.p < (RealType)1e-10) return;
    if (is_ideal_gas) {
        s.E = s.p / (gamma - (RealType)1.0) + (RealType)0.5 * s.rho * (s.ur * s.ur + s.uz * s.uz);
    } else {
        s.E = (RealType)MultiMat::getMixtureEnergy((double)s.p, (double)s.rho, (double)s.alpha1, (double)s.alpha2, (double)s.arho1, (double)s.arho2, (double)gamma, mat.products, mat.unreacted) + (RealType)0.5 * s.rho * (s.ur * s.ur + s.uz * s.uz);
    }
}

template <typename RealType>
inline CellStateT<RealType> applyBC(CellStateT<RealType> s, CFDSolver2D::BCType bc, RealType normal_vel, RealType ambient_rho, RealType ambient_p, RealType gamma, const MultiMat::MaterialSet& mat, bool is_ideal_gas, bool is_r_axis) {
    if (bc == CFDSolver2D::REFLECTIVE) {
        if (is_r_axis) {
            s.ur = -s.ur;
        } else {
            s.uz = -s.uz;
        }
    } else if (bc == CFDSolver2D::TRANSMISSIVE) {
        // Zero-gradient
    } else if (bc == CFDSolver2D::OUTFLOW_RIEMANN) {
        RealType c;
        if (is_ideal_gas) {
            c = std::sqrt(gamma * s.p / s.rho);
        } else {
            c = (RealType)MultiMat::getMixtureSoundSpeed((double)s.p, (double)s.rho, (double)s.alpha1, (double)s.alpha2, (double)s.arho1, (double)s.arho2, (double)gamma, mat.products, mat.unreacted);
        }
        if (normal_vel < (RealType)0.0) {
            // Inflow
            s.rho = ambient_rho;
            s.ur = 0.0;
            s.uz = 0.0;
            s.p = ambient_p;
            s.alpha1 = 0.0;
            s.alpha2 = 0.0;
            s.arho1 = 0.0;
            s.arho2 = 0.0;
            s.E = is_ideal_gas ? (ambient_p / (gamma - (RealType)1.0)) : 
                  (RealType)(ambient_rho * MultiMat::getEnergy_IdealGas((double)ambient_p, (double)ambient_rho, (double)gamma));
        } else if (normal_vel < c) {
            // Subsonic outflow
            s.p = ambient_p;
            compute_E_cpu(s, gamma, mat, is_ideal_gas);
        }
        // Supersonic outflow (extrapolate as is)
    }
    return s;
}

template <typename RealType>
inline CellStateT<RealType> readState(const CFDSolver2DImpl<RealType>* solver, const std::vector<int32_t>& tile_map, const std::vector<PrimitiveTileT<RealType>>& states_pool, int i, int j) {
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

    CellStateT<RealType> s;
    if (pool_idx == -1) {
        s = { (RealType)solver->getAmbientRho(), 0.0, 0.0, (RealType)solver->getAmbientP(), 
              solver->isIdealGas() ? ((RealType)solver->getAmbientP() / ((RealType)solver->getGamma() - (RealType)1.0)) : 
              (RealType)(solver->getAmbientRho() * MultiMat::getEnergy_IdealGas(solver->getAmbientP(), solver->getAmbientRho(), solver->getGamma())), 
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
        RealType normal_vel = (original_i < 0) ? s.ur : -s.ur;
        s = applyBC(s, (original_i < 0) ? solver->getBCRmin() : solver->getBCRmax(), normal_vel, (RealType)solver->getAmbientRho(), (RealType)solver->getAmbientP(), (RealType)solver->getGamma(), solver->getMaterialParameters(), solver->isIdealGas(), true);
    }
    if (is_outside_j) {
        RealType normal_vel = (original_j < 0) ? s.uz : -s.uz;
        s = applyBC(s, (original_j < 0) ? solver->getBCZmin() : solver->getBCZmax(), normal_vel, (RealType)solver->getAmbientRho(), (RealType)solver->getAmbientP(), (RealType)solver->getGamma(), solver->getMaterialParameters(), solver->isIdealGas(), false);
    }

    return s;
}

// --------------------------------------------------------------------------------------
// Helpers for spatial reconstruction on CPU
template <typename RealType>
inline RealType minmod(RealType a, RealType b) {
    if (a * b <= 0) return 0.0;
    return (std::abs(a) < std::abs(b)) ? a : b;
}

template <typename RealType>
inline RealType weno3(RealType qm1, RealType q0, RealType qp1) {
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

// --------------------------------------------------------------------------------------
// Flux implementations adapted for CellStateT
template <typename RealType>
inline void calcFluxRusanov(const CellStateT<RealType>& sL, const CellStateT<RealType>& sR, RealType gamma, const MultiMat::MaterialSet& mat, 
                            RealType& f_rho, RealType& f_rhour, RealType& f_rhouz, RealType& f_E, 
                            RealType& f_alpha1, RealType& f_alpha2, RealType& f_arho1, RealType& f_arho2, RealType& v_face) {
    double cL = MultiMat::getMixtureSoundSpeed((double)sL.p, (double)sL.rho, (double)sL.alpha1, (double)sL.alpha2, (double)sL.arho1, (double)sL.arho2, (double)gamma, mat.products, mat.unreacted);
    double cR = MultiMat::getMixtureSoundSpeed((double)sR.p, (double)sR.rho, (double)sR.alpha1, (double)sR.alpha2, (double)sR.arho1, (double)sR.arho2, (double)gamma, mat.products, mat.unreacted);
    double s_max = std::max(std::abs((double)sL.ur) + cL, std::abs((double)sR.ur) + cR);

    double fL_rho = (double)(sL.rho * sL.ur);
    double fL_rhour = (double)(sL.rho * sL.ur * sL.ur + sL.p);
    double fL_rhouz = (double)(sL.rho * sL.ur * sL.uz);
    double fL_E = (double)(sL.ur * (sL.E + sL.p));
    
    double fR_rho = (double)(sR.rho * sR.ur);
    double fR_rhour = (double)(sR.rho * sR.ur * sR.ur + sR.p);
    double fR_rhouz = (double)(sR.rho * sR.ur * sR.uz);
    double fR_E = (double)(sR.ur * (sR.E + sR.p));

    double uL_rho = (double)sL.rho, uL_rhour = (double)(sL.rho * sL.ur), uL_rhouz = (double)(sL.rho * sL.uz), uL_E = (double)sL.E;
    double uR_rho = (double)sR.rho, uR_rhour = (double)(sR.rho * sR.ur), uR_rhouz = (double)(sR.rho * sR.uz), uR_E = (double)sR.E;

    f_rho = (RealType)(0.5 * (fL_rho + fR_rho) - 0.5 * s_max * (uR_rho - uL_rho));
    f_rhour = (RealType)(0.5 * (fL_rhour + fR_rhour) - 0.5 * s_max * (uR_rhour - uL_rhour));
    f_rhouz = (RealType)(0.5 * (fL_rhouz + fR_rhouz) - 0.5 * s_max * (uR_rhouz - uL_rhouz));
    f_E = (RealType)(0.5 * (fL_E + fR_E) - 0.5 * s_max * (uR_E - uL_E));

    v_face = (RealType)(0.5 * ((double)sL.ur + (double)sR.ur));

    f_alpha1 = (RealType)(0.5 * ((double)sL.alpha1*(double)sL.ur + (double)sR.alpha1*(double)sR.ur) - 0.5 * s_max * ((double)sR.alpha1 - (double)sL.alpha1));
    f_alpha2 = (RealType)(0.5 * ((double)sL.alpha2*(double)sL.ur + (double)sR.alpha2*(double)sR.ur) - 0.5 * s_max * ((double)sR.alpha2 - (double)sL.alpha2));
    f_arho1 = (RealType)(0.5 * ((double)sL.arho1*(double)sL.ur + (double)sR.arho1*(double)sR.ur) - 0.5 * s_max * ((double)sR.arho1 - (double)sL.arho1));
    f_arho2 = (RealType)(0.5 * ((double)sL.arho2*(double)sL.ur + (double)sR.arho2*(double)sR.ur) - 0.5 * s_max * ((double)sR.arho2 - (double)sL.arho2));
}

template <typename RealType>
inline void calcFluxRusanovZ(const CellStateT<RealType>& sL, const CellStateT<RealType>& sR, RealType gamma, const MultiMat::MaterialSet& mat, 
                             RealType& f_rho, RealType& f_rhour, RealType& f_rhouz, RealType& f_E, 
                             RealType& f_alpha1, RealType& f_alpha2, RealType& f_arho1, RealType& f_arho2, RealType& v_face) {
    double cL = MultiMat::getMixtureSoundSpeed((double)sL.p, (double)sL.rho, (double)sL.alpha1, (double)sL.alpha2, (double)sL.arho1, (double)sL.arho2, (double)gamma, mat.products, mat.unreacted);
    double cR = MultiMat::getMixtureSoundSpeed((double)sR.p, (double)sR.rho, (double)sR.alpha1, (double)sR.alpha2, (double)sR.arho1, (double)sR.arho2, (double)gamma, mat.products, mat.unreacted);
    double s_max = std::max(std::abs((double)sL.uz) + cL, std::abs((double)sR.uz) + cR);

    double fL_rho = (double)(sL.rho * sL.uz);
    double fL_rhour = (double)(sL.rho * sL.ur * sL.uz);
    double fL_rhouz = (double)(sL.rho * sL.uz * sL.uz + sL.p);
    double fL_E = (double)(sL.uz * (sL.E + sL.p));
    
    double fR_rho = (double)(sR.rho * sR.uz);
    double fR_rhour = (double)(sR.rho * sR.ur * sR.uz);
    double fR_rhouz = (double)(sR.rho * sR.uz * sR.uz + sR.p);
    double fR_E = (double)(sR.uz * (sR.E + sR.p));

    double uL_rho = (double)sL.rho, uL_rhour = (double)(sL.rho * sL.ur), uL_rhouz = (double)(sL.rho * sL.uz), uL_E = (double)sL.E;
    double uR_rho = (double)sR.rho, uR_rhour = (double)(sR.rho * sR.ur), uR_rhouz = (double)(sR.rho * sR.uz), uR_E = (double)sR.E;

    f_rho = (RealType)(0.5 * (fL_rho + fR_rho) - 0.5 * s_max * (uR_rho - uL_rho));
    f_rhour = (RealType)(0.5 * (fL_rhour + fR_rhour) - 0.5 * s_max * (uR_rhour - uL_rhour));
    f_rhouz = (RealType)(0.5 * (fL_rhouz + fR_rhouz) - 0.5 * s_max * (uR_rhouz - uL_rhouz));
    f_E = (RealType)(0.5 * (fL_E + fR_E) - 0.5 * s_max * (uR_E - uL_E));

    v_face = (RealType)(0.5 * ((double)sL.uz + (double)sR.uz));

    f_alpha1 = (RealType)(0.5 * ((double)sL.alpha1*(double)sL.uz + (double)sR.alpha1*(double)sR.uz) - 0.5 * s_max * ((double)sR.alpha1 - (double)sL.alpha1));
    f_alpha2 = (RealType)(0.5 * ((double)sL.alpha2*(double)sL.uz + (double)sR.alpha2*(double)sR.uz) - 0.5 * s_max * ((double)sR.alpha2 - (double)sL.alpha2));
    f_arho1 = (RealType)(0.5 * ((double)sL.arho1*(double)sL.uz + (double)sR.arho1*(double)sR.uz) - 0.5 * s_max * ((double)sR.arho1 - (double)sL.arho1));
    f_arho2 = (RealType)(0.5 * ((double)sL.arho2*(double)sL.uz + (double)sR.arho2*(double)sR.uz) - 0.5 * s_max * ((double)sR.arho2 - (double)sL.arho2));
}

// --------------------------------------------------------------------------------------
// computeTileRHS computes the right-hand-side (spatial derivatives) for one tile
template <typename RealType>
void CFDSolver2DImpl<RealType>::computeTileRHS(int pool_idx, int tr, int tz, double A_coeff, double dt) {
    RealType A_coeff_r = (RealType)A_coeff;
    RealType dt_r = (RealType)dt;
    RealType dr_r = (RealType)dr;
    RealType dz_r = (RealType)dz;
    RealType gamma_r = (RealType)gamma;

    for (int local_i = 0; local_i < TILE_SIZE; ++local_i) {
        for (int local_j = 0; local_j < TILE_SIZE; ++local_j) {
            int i = tr * TILE_SIZE + local_i;
            int j = tz * TILE_SIZE + local_j;
            
            if (i >= nr_cells || j >= nz_cells) continue;
            
            int k = local_i * TILE_SIZE + local_j;
            
            CellStateT<RealType> s_c = readState(this, tile_map, states_pool, i, j);
            CellStateT<RealType> s_L = readState(this, tile_map, states_pool, i - 1, j);
            CellStateT<RealType> s_R = readState(this, tile_map, states_pool, i + 1, j);
            CellStateT<RealType> s_B = readState(this, tile_map, states_pool, i, j - 1);
            CellStateT<RealType> s_T = readState(this, tile_map, states_pool, i, j + 1);

            CellStateT<RealType> s_faceL_L = s_L;
            CellStateT<RealType> s_faceL_R = s_c;
            CellStateT<RealType> s_faceR_L = s_c;
            CellStateT<RealType> s_faceR_R = s_R;
            CellStateT<RealType> s_faceB_L = s_B;
            CellStateT<RealType> s_faceB_R = s_c;
            CellStateT<RealType> s_faceT_L = s_c;
            CellStateT<RealType> s_faceT_R = s_T;

            if (spatialOrder == 2) {
                CellStateT<RealType> s_LL = readState(this, tile_map, states_pool, i - 2, j);
                CellStateT<RealType> s_RR = readState(this, tile_map, states_pool, i + 2, j);
                CellStateT<RealType> s_BB = readState(this, tile_map, states_pool, i, j - 2);
                CellStateT<RealType> s_TT = readState(this, tile_map, states_pool, i, j + 2);

                // Reconstruct left radial face i - 1/2
                s_faceL_L.rho = s_L.rho + (RealType)0.5 * minmod(s_L.rho - s_LL.rho, s_c.rho - s_L.rho);
                s_faceL_R.rho = s_c.rho - (RealType)0.5 * minmod(s_c.rho - s_L.rho, s_R.rho - s_c.rho);
                s_faceL_L.ur  = s_L.ur + (RealType)0.5 * minmod(s_L.ur - s_LL.ur, s_c.ur - s_L.ur);
                s_faceL_R.ur  = s_c.ur - (RealType)0.5 * minmod(s_c.ur - s_L.ur, s_R.ur - s_c.ur);
                s_faceL_L.uz  = s_L.uz + (RealType)0.5 * minmod(s_L.uz - s_LL.uz, s_c.uz - s_L.uz);
                s_faceL_R.uz  = s_c.uz - (RealType)0.5 * minmod(s_c.uz - s_L.uz, s_R.uz - s_c.uz);
                s_faceL_L.p   = s_L.p + (RealType)0.5 * minmod(s_L.p - s_LL.p, s_c.p - s_L.p);
                s_faceL_R.p   = s_c.p - (RealType)0.5 * minmod(s_c.p - s_L.p, s_R.p - s_c.p);

                s_faceL_L.alpha1 = s_L.alpha1 + (RealType)0.5 * minmod(s_L.alpha1 - s_LL.alpha1, s_c.alpha1 - s_L.alpha1);
                s_faceL_L.alpha2 = s_L.alpha2 + (RealType)0.5 * minmod(s_L.alpha2 - s_LL.alpha2, s_c.alpha2 - s_L.alpha2);
                s_faceL_L.arho1  = s_L.arho1  + (RealType)0.5 * minmod(s_L.arho1 - s_LL.arho1, s_c.arho1 - s_L.arho1);
                s_faceL_L.arho2  = s_L.arho2  + (RealType)0.5 * minmod(s_L.arho2 - s_LL.arho2, s_c.arho2 - s_L.arho2);

                s_faceL_R.alpha1 = s_c.alpha1 - (RealType)0.5 * minmod(s_c.alpha1 - s_L.alpha1, s_R.alpha1 - s_c.alpha1);
                s_faceL_R.alpha2 = s_c.alpha2 - (RealType)0.5 * minmod(s_c.alpha2 - s_L.alpha2, s_R.alpha2 - s_c.alpha2);
                s_faceL_R.arho1  = s_c.arho1  - (RealType)0.5 * minmod(s_c.arho1 - s_L.arho1, s_R.arho1 - s_c.arho1);
                s_faceL_R.arho2  = s_c.arho2  - (RealType)0.5 * minmod(s_c.arho2 - s_L.arho2, s_R.arho2 - s_c.arho2);

                // Reconstruct right radial face i + 1/2
                s_faceR_L.rho = s_c.rho + (RealType)0.5 * minmod(s_c.rho - s_L.rho, s_R.rho - s_c.rho);
                s_faceR_R.rho = s_R.rho - (RealType)0.5 * minmod(s_R.rho - s_c.rho, s_RR.rho - s_R.rho);
                s_faceR_L.ur  = s_c.ur + (RealType)0.5 * minmod(s_c.ur - s_L.ur, s_R.ur - s_c.ur);
                s_faceR_R.ur  = s_R.ur - (RealType)0.5 * minmod(s_R.ur - s_c.ur, s_RR.ur - s_R.ur);
                s_faceR_L.uz  = s_c.uz + (RealType)0.5 * minmod(s_c.uz - s_L.uz, s_R.uz - s_c.uz);
                s_faceR_R.uz  = s_R.uz - (RealType)0.5 * minmod(s_R.uz - s_c.uz, s_RR.uz - s_R.uz);
                s_faceR_L.p   = s_c.p + (RealType)0.5 * minmod(s_c.p - s_L.p, s_R.p - s_c.p);
                s_faceR_R.p   = s_R.p - (RealType)0.5 * minmod(s_R.p - s_c.p, s_RR.p - s_R.p);

                s_faceR_L.alpha1 = s_c.alpha1 + (RealType)0.5 * minmod(s_c.alpha1 - s_L.alpha1, s_R.alpha1 - s_c.alpha1);
                s_faceR_L.alpha2 = s_c.alpha2 + (RealType)0.5 * minmod(s_c.alpha2 - s_L.alpha2, s_R.alpha2 - s_c.alpha2);
                s_faceR_L.arho1  = s_c.arho1  + (RealType)0.5 * minmod(s_c.arho1 - s_L.arho1, s_R.arho1 - s_c.arho1);
                s_faceR_L.arho2  = s_c.arho2  + (RealType)0.5 * minmod(s_c.arho2 - s_L.arho2, s_R.arho2 - s_c.arho2);

                s_faceR_R.alpha1 = s_R.alpha1 - (RealType)0.5 * minmod(s_R.alpha1 - s_c.alpha1, s_RR.alpha1 - s_R.alpha1);
                s_faceR_R.alpha2 = s_R.alpha2 - (RealType)0.5 * minmod(s_R.alpha2 - s_c.alpha2, s_RR.alpha2 - s_R.alpha2);
                s_faceR_R.arho1  = s_R.arho1  - (RealType)0.5 * minmod(s_R.arho1 - s_c.arho1, s_RR.arho1 - s_R.arho1);
                s_faceR_R.arho2  = s_R.arho2  - (RealType)0.5 * minmod(s_R.arho2 - s_c.arho2, s_RR.arho2 - s_R.arho2);

                // Reconstruct bottom axial face j - 1/2
                s_faceB_L.rho = s_B.rho + (RealType)0.5 * minmod(s_B.rho - s_BB.rho, s_c.rho - s_B.rho);
                s_faceB_R.rho = s_c.rho - (RealType)0.5 * minmod(s_c.rho - s_B.rho, s_T.rho - s_c.rho);
                s_faceB_L.ur  = s_B.ur + (RealType)0.5 * minmod(s_B.ur - s_BB.ur, s_c.ur - s_B.ur);
                s_faceB_R.ur  = s_c.ur - (RealType)0.5 * minmod(s_c.ur - s_B.ur, s_T.ur - s_c.ur);
                s_faceB_L.uz  = s_B.uz + (RealType)0.5 * minmod(s_B.uz - s_BB.uz, s_c.uz - s_B.uz);
                s_faceB_R.uz  = s_c.uz - (RealType)0.5 * minmod(s_c.uz - s_B.uz, s_T.uz - s_c.uz);
                s_faceB_L.p   = s_B.p + (RealType)0.5 * minmod(s_B.p - s_BB.p, s_c.p - s_B.p);
                s_faceB_R.p   = s_c.p - (RealType)0.5 * minmod(s_c.p - s_B.p, s_T.p - s_c.p);

                s_faceB_L.alpha1 = s_B.alpha1 + (RealType)0.5 * minmod(s_B.alpha1 - s_BB.alpha1, s_c.alpha1 - s_B.alpha1);
                s_faceB_L.alpha2 = s_B.alpha2 + (RealType)0.5 * minmod(s_B.alpha2 - s_BB.alpha2, s_c.alpha2 - s_B.alpha2);
                s_faceB_L.arho1  = s_B.arho1  + (RealType)0.5 * minmod(s_B.arho1 - s_BB.arho1, s_c.arho1 - s_B.arho1);
                s_faceB_L.arho2  = s_B.arho2  + (RealType)0.5 * minmod(s_B.arho2 - s_BB.arho2, s_c.arho2 - s_B.arho2);

                s_faceB_R.alpha1 = s_c.alpha1 - (RealType)0.5 * minmod(s_c.alpha1 - s_B.alpha1, s_T.alpha1 - s_c.alpha1);
                s_faceB_R.alpha2 = s_c.alpha2 - (RealType)0.5 * minmod(s_c.alpha2 - s_B.alpha2, s_T.alpha2 - s_c.alpha2);
                s_faceB_R.arho1  = s_c.arho1  - (RealType)0.5 * minmod(s_c.arho1 - s_B.arho1, s_T.arho1 - s_c.arho1);
                s_faceB_R.arho2  = s_c.arho2  - (RealType)0.5 * minmod(s_c.arho2 - s_B.arho2, s_T.arho2 - s_c.arho2);

                // Reconstruct top axial face j + 1/2
                s_faceT_L.rho = s_c.rho + (RealType)0.5 * minmod(s_c.rho - s_B.rho, s_T.rho - s_c.rho);
                s_faceT_R.rho = s_T.rho - (RealType)0.5 * minmod(s_T.rho - s_c.rho, s_TT.rho - s_T.rho);
                s_faceT_L.ur  = s_c.ur + (RealType)0.5 * minmod(s_c.ur - s_B.ur, s_T.ur - s_c.ur);
                s_faceT_R.ur  = s_T.ur - (RealType)0.5 * minmod(s_T.ur - s_c.ur, s_TT.ur - s_T.ur);
                s_faceT_L.uz  = s_c.uz + (RealType)0.5 * minmod(s_c.uz - s_B.uz, s_T.uz - s_c.uz);
                s_faceT_R.uz  = s_T.uz - (RealType)0.5 * minmod(s_T.uz - s_c.uz, s_TT.uz - s_T.uz);
                s_faceT_L.p   = s_c.p + (RealType)0.5 * minmod(s_c.p - s_B.p, s_T.p - s_c.p);
                s_faceT_R.p   = s_T.p - (RealType)0.5 * minmod(s_T.p - s_c.p, s_TT.p - s_T.p);

                s_faceT_L.alpha1 = s_c.alpha1 + (RealType)0.5 * minmod(s_c.alpha1 - s_B.alpha1, s_T.alpha1 - s_c.alpha1);
                s_faceT_L.alpha2 = s_c.alpha2 + (RealType)0.5 * minmod(s_c.alpha2 - s_B.alpha2, s_T.alpha2 - s_c.alpha2);
                s_faceT_L.arho1  = s_c.arho1  + (RealType)0.5 * minmod(s_c.arho1 - s_B.arho1, s_T.arho1 - s_c.arho1);
                s_faceT_L.arho2  = s_c.arho2  + (RealType)0.5 * minmod(s_c.arho2 - s_B.arho2, s_T.arho2 - s_c.arho2);

                s_faceT_R.alpha1 = s_T.alpha1 - (RealType)0.5 * minmod(s_T.alpha1 - s_c.alpha1, s_TT.alpha1 - s_T.alpha1);
                s_faceT_R.alpha2 = s_T.alpha2 - (RealType)0.5 * minmod(s_T.alpha2 - s_c.alpha2, s_TT.alpha2 - s_T.alpha2);
                s_faceT_R.arho1  = s_T.arho1  - (RealType)0.5 * minmod(s_T.arho1 - s_c.arho1, s_TT.arho1 - s_T.arho1);
                s_faceT_R.arho2  = s_T.arho2  - (RealType)0.5 * minmod(s_T.arho2 - s_c.arho2, s_TT.arho2 - s_T.arho2);

                // Clamp volume fractions
                s_faceL_L.alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceL_L.alpha1)); s_faceL_L.alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceL_L.alpha2));
                s_faceL_R.alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceL_R.alpha1)); s_faceL_R.alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceL_R.alpha2));
                s_faceR_L.alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceR_L.alpha1)); s_faceR_L.alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceR_L.alpha2));
                s_faceR_R.alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceR_R.alpha1)); s_faceR_R.alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceR_R.alpha2));
                s_faceB_L.alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceB_L.alpha1)); s_faceB_L.alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceB_L.alpha2));
                s_faceB_R.alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceB_R.alpha1)); s_faceB_R.alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceB_R.alpha2));
                s_faceT_L.alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceT_L.alpha1)); s_faceT_L.alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceT_L.alpha2));
                s_faceT_R.alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceT_R.alpha1)); s_faceT_R.alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceT_R.alpha2));

                // Recompute energies
                compute_E_cpu(s_faceL_L, gamma_r, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceL_R, gamma_r, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceR_L, gamma_r, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceR_R, gamma_r, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceB_L, gamma_r, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceB_R, gamma_r, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceT_L, gamma_r, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceT_R, gamma_r, currentMaterials, is_ideal_gas);

            } else if (spatialOrder == 3) {
                CellStateT<RealType> s_LL = readState(this, tile_map, states_pool, i - 2, j);
                CellStateT<RealType> s_RR = readState(this, tile_map, states_pool, i + 2, j);
                CellStateT<RealType> s_BB = readState(this, tile_map, states_pool, i, j - 2);
                CellStateT<RealType> s_TT = readState(this, tile_map, states_pool, i, j + 2);

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
                s_faceL_L.alpha1 = s_L.alpha1 + (RealType)0.5 * minmod(s_L.alpha1 - s_LL.alpha1, s_c.alpha1 - s_L.alpha1);
                s_faceL_L.alpha2 = s_L.alpha2 + (RealType)0.5 * minmod(s_L.alpha2 - s_LL.alpha2, s_c.alpha2 - s_L.alpha2);
                s_faceL_L.arho1  = s_L.arho1  + (RealType)0.5 * minmod(s_L.arho1 - s_LL.arho1, s_c.arho1 - s_L.arho1);
                s_faceL_L.arho2  = s_L.arho2  + (RealType)0.5 * minmod(s_L.arho2 - s_LL.arho2, s_c.arho2 - s_L.arho2);

                s_faceL_R.alpha1 = s_c.alpha1 - (RealType)0.5 * minmod(s_c.alpha1 - s_L.alpha1, s_R.alpha1 - s_c.alpha1);
                s_faceL_R.alpha2 = s_c.alpha2 - (RealType)0.5 * minmod(s_c.alpha2 - s_L.alpha2, s_R.alpha2 - s_c.alpha2);
                s_faceL_R.arho1  = s_c.arho1  - (RealType)0.5 * minmod(s_c.arho1 - s_L.arho1, s_R.arho1 - s_c.arho1);
                s_faceL_R.arho2  = s_c.arho2  - (RealType)0.5 * minmod(s_c.arho2 - s_L.arho2, s_R.arho2 - s_c.arho2);

                s_faceR_L.alpha1 = s_c.alpha1 + (RealType)0.5 * minmod(s_c.alpha1 - s_L.alpha1, s_R.alpha1 - s_c.alpha1);
                s_faceR_L.alpha2 = s_c.alpha2 + (RealType)0.5 * minmod(s_c.alpha2 - s_L.alpha2, s_R.alpha2 - s_c.alpha2);
                s_faceR_L.arho1  = s_c.arho1  + (RealType)0.5 * minmod(s_c.arho1 - s_L.arho1, s_R.arho1 - s_c.arho1);
                s_faceR_L.arho2  = s_c.arho2  + (RealType)0.5 * minmod(s_c.arho2 - s_L.arho2, s_R.arho2 - s_c.arho2);

                s_faceR_R.alpha1 = s_R.alpha1 - (RealType)0.5 * minmod(s_R.alpha1 - s_c.alpha1, s_RR.alpha1 - s_R.alpha1);
                s_faceR_R.alpha2 = s_R.alpha2 - (RealType)0.5 * minmod(s_R.alpha2 - s_c.alpha2, s_RR.alpha2 - s_R.alpha2);
                s_faceR_R.arho1  = s_R.arho1  - (RealType)0.5 * minmod(s_R.arho1 - s_c.arho1, s_RR.arho1 - s_R.arho1);
                s_faceR_R.arho2  = s_R.arho2  - (RealType)0.5 * minmod(s_R.arho2 - s_c.arho2, s_RR.arho2 - s_R.arho2);

                s_faceB_L.alpha1 = s_B.alpha1 + (RealType)0.5 * minmod(s_B.alpha1 - s_BB.alpha1, s_c.alpha1 - s_B.alpha1);
                s_faceB_L.alpha2 = s_B.alpha2 + (RealType)0.5 * minmod(s_B.alpha2 - s_BB.alpha2, s_c.alpha2 - s_B.alpha2);
                s_faceB_L.arho1  = s_B.arho1  + (RealType)0.5 * minmod(s_B.arho1 - s_BB.arho1, s_c.arho1 - s_B.arho1);
                s_faceB_L.arho2  = s_B.arho2  + (RealType)0.5 * minmod(s_B.arho2 - s_BB.arho2, s_c.arho2 - s_B.arho2);

                s_faceB_R.alpha1 = s_c.alpha1 - (RealType)0.5 * minmod(s_c.alpha1 - s_B.alpha1, s_T.alpha1 - s_c.alpha1);
                s_faceB_R.alpha2 = s_c.alpha2 - (RealType)0.5 * minmod(s_c.alpha2 - s_B.alpha2, s_T.alpha2 - s_c.alpha2);
                s_faceB_R.arho1  = s_c.arho1  - (RealType)0.5 * minmod(s_c.arho1 - s_B.arho1, s_T.arho1 - s_c.arho1);
                s_faceB_R.arho2  = s_c.arho2  - (RealType)0.5 * minmod(s_c.arho2 - s_B.arho2, s_T.arho2 - s_c.arho2);

                s_faceT_L.alpha1 = s_c.alpha1 + (RealType)0.5 * minmod(s_c.alpha1 - s_B.alpha1, s_T.alpha1 - s_c.alpha1);
                s_faceT_L.alpha2 = s_c.alpha2 + (RealType)0.5 * minmod(s_c.alpha2 - s_B.alpha2, s_T.alpha2 - s_c.alpha2);
                s_faceT_L.arho1  = s_c.arho1  + (RealType)0.5 * minmod(s_c.arho1 - s_B.arho1, s_T.arho1 - s_c.arho1);
                s_faceT_L.arho2  = s_c.arho2  + (RealType)0.5 * minmod(s_c.arho2 - s_B.arho2, s_T.arho2 - s_c.arho2);

                s_faceT_R.alpha1 = s_T.alpha1 - (RealType)0.5 * minmod(s_T.alpha1 - s_c.alpha1, s_TT.alpha1 - s_T.alpha1);
                s_faceT_R.alpha2 = s_T.alpha2 - (RealType)0.5 * minmod(s_T.alpha2 - s_c.alpha2, s_TT.alpha2 - s_T.alpha2);
                s_faceT_R.arho1  = s_T.arho1  - (RealType)0.5 * minmod(s_T.arho1 - s_c.arho1, s_TT.arho1 - s_T.arho1);
                s_faceT_R.arho2  = s_T.arho2  - (RealType)0.5 * minmod(s_T.arho2 - s_c.arho2, s_TT.arho2 - s_T.arho2);

                // Clamp volume fractions
                s_faceL_L.alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceL_L.alpha1)); s_faceL_L.alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceL_L.alpha2));
                s_faceL_R.alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceL_R.alpha1)); s_faceL_R.alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceL_R.alpha2));
                s_faceR_L.alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceR_L.alpha1)); s_faceR_L.alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceR_L.alpha2));
                s_faceR_R.alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceR_R.alpha1)); s_faceR_R.alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceR_R.alpha2));
                s_faceB_L.alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceB_L.alpha1)); s_faceB_L.alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceB_L.alpha2));
                s_faceB_R.alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceB_R.alpha1)); s_faceB_R.alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceB_R.alpha2));
                s_faceT_L.alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceT_L.alpha1)); s_faceT_L.alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceT_L.alpha2));
                s_faceT_R.alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceT_R.alpha1)); s_faceT_R.alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, s_faceT_R.alpha2));

                // Recompute energies
                compute_E_cpu(s_faceL_L, gamma_r, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceL_R, gamma_r, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceR_L, gamma_r, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceR_R, gamma_r, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceB_L, gamma_r, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceB_R, gamma_r, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceT_L, gamma_r, currentMaterials, is_ideal_gas);
                compute_E_cpu(s_faceT_R, gamma_r, currentMaterials, is_ideal_gas);
            }

            RealType fr_L_rho, fr_L_rhour, fr_L_rhouz, fr_L_E, fr_L_a1, fr_L_a2, fr_L_ar1, fr_L_ar2, v_face_rL;
            RealType fr_R_rho, fr_R_rhour, fr_R_rhouz, fr_R_E, fr_R_a1, fr_R_a2, fr_R_ar1, fr_R_ar2, v_face_rR;
            
            calcFluxRusanov(s_faceL_L, s_faceL_R, gamma_r, currentMaterials, fr_L_rho, fr_L_rhour, fr_L_rhouz, fr_L_E, fr_L_a1, fr_L_a2, fr_L_ar1, fr_L_ar2, v_face_rL);
            calcFluxRusanov(s_faceR_L, s_faceR_R, gamma_r, currentMaterials, fr_R_rho, fr_R_rhour, fr_R_rhouz, fr_R_E, fr_R_a1, fr_R_a2, fr_R_ar1, fr_R_ar2, v_face_rR);
            
            RealType fz_B_rho, fz_B_rhour, fz_B_rhouz, fz_B_E, fz_B_a1, fz_B_a2, fz_B_ar1, fz_B_ar2, v_face_zB;
            RealType fz_T_rho, fz_T_rhour, fz_T_rhouz, fz_T_E, fz_T_a1, fz_T_a2, fz_T_ar1, fz_T_ar2, v_face_zT;

            calcFluxRusanovZ(s_faceB_L, s_faceB_R, gamma_r, currentMaterials, fz_B_rho, fz_B_rhour, fz_B_rhouz, fz_B_E, fz_B_a1, fz_B_a2, fz_B_ar1, fz_B_ar2, v_face_zB);
            calcFluxRusanovZ(s_faceT_L, s_faceT_R, gamma_r, currentMaterials, fz_T_rho, fz_T_rhour, fz_T_rhouz, fz_T_E, fz_T_a1, fz_T_a2, fz_T_ar1, fz_T_ar2, v_face_zT);

            RealType r_center = (RealType)(i + 0.5) * dr_r;
            RealType r_left = (RealType)i * dr_r;
            RealType r_right = (RealType)(i + 1) * dr_r;
            
            RealType dU_rho = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_rho - r_left * fr_L_rho) - ((RealType)1.0 / dz_r) * (fz_T_rho - fz_B_rho);
            RealType dU_rhour = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_rhour - r_left * fr_L_rhour) - ((RealType)1.0 / dz_r) * (fz_T_rhour - fz_B_rhour) + s_c.p / r_center;
            RealType dU_rhouz = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_rhouz - r_left * fr_L_rhouz) - ((RealType)1.0 / dz_r) * (fz_T_rhouz - fz_B_rhouz);
            RealType dU_E = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_E - r_left * fr_L_E) - ((RealType)1.0 / dz_r) * (fz_T_E - fz_B_E);

            RealType div_u = ((RealType)1.0 / (r_center * dr_r)) * (r_right * v_face_rR - r_left * v_face_rL) + ((RealType)1.0 / dz_r) * (v_face_zT - v_face_zB);
            
            RealType dU_alpha1 = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_a1 - r_left * fr_L_a1) - ((RealType)1.0 / dz_r) * (fz_T_a1 - fz_B_a1) + s_c.alpha1 * div_u;
            RealType dU_alpha2 = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_a2 - r_left * fr_L_a2) - ((RealType)1.0 / dz_r) * (fz_T_a2 - fz_B_a2) + s_c.alpha2 * div_u;
            RealType dU_arho1 = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_ar1 - r_left * fr_L_ar1) - ((RealType)1.0 / dz_r) * (fz_T_ar1 - fz_B_ar1);
            RealType dU_arho2 = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_ar2 - r_left * fr_L_ar2) - ((RealType)1.0 / dz_r) * (fz_T_ar2 - fz_B_ar2);

            dU_pool[pool_idx].rho[k] = A_coeff_r * dU_pool[pool_idx].rho[k] + dt_r * dU_rho;
            dU_pool[pool_idx].rhour[k] = A_coeff_r * dU_pool[pool_idx].rhour[k] + dt_r * dU_rhour;
            dU_pool[pool_idx].rhouz[k] = A_coeff_r * dU_pool[pool_idx].rhouz[k] + dt_r * dU_rhouz;
            dU_pool[pool_idx].E[k] = A_coeff_r * dU_pool[pool_idx].E[k] + dt_r * dU_E;
            dU_pool[pool_idx].alpha1[k] = A_coeff_r * dU_pool[pool_idx].alpha1[k] + dt_r * dU_alpha1;
            dU_pool[pool_idx].alpha2[k] = A_coeff_r * dU_pool[pool_idx].alpha2[k] + dt_r * dU_alpha2;
            dU_pool[pool_idx].arho1[k] = A_coeff_r * dU_pool[pool_idx].arho1[k] + dt_r * dU_arho1;
            dU_pool[pool_idx].arho2[k] = A_coeff_r * dU_pool[pool_idx].arho2[k] + dt_r * dU_arho2;
        }
    }
}

// --------------------------------------------------------------------------------------
// applyLSRK3Step performs one stage of Williamson's LSRK3
template <typename RealType>
void CFDSolver2DImpl<RealType>::applyLSRK3Step(int stage, double dt) {
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
            U_pool[pool_idx].rho[k] += (RealType)(B[stage] * dU_pool[pool_idx].rho[k]);
            U_pool[pool_idx].rhour[k] += (RealType)(B[stage] * dU_pool[pool_idx].rhour[k]);
            U_pool[pool_idx].rhouz[k] += (RealType)(B[stage] * dU_pool[pool_idx].rhouz[k]);
            U_pool[pool_idx].E[k] += (RealType)(B[stage] * dU_pool[pool_idx].E[k]);
            U_pool[pool_idx].alpha1[k] += (RealType)(B[stage] * dU_pool[pool_idx].alpha1[k]);
            U_pool[pool_idx].alpha2[k] += (RealType)(B[stage] * dU_pool[pool_idx].alpha2[k]);
            U_pool[pool_idx].arho1[k] += (RealType)(B[stage] * dU_pool[pool_idx].arho1[k]);
            U_pool[pool_idx].arho2[k] += (RealType)(B[stage] * dU_pool[pool_idx].arho2[k]);
        }
    }
}

template <typename RealType>
void CFDSolver2DImpl<RealType>::step(double dt) {
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
                U_pool[pool_idx].rho[k] += (RealType)(dt * dU_pool[pool_idx].rho[k]);
                U_pool[pool_idx].rhour[k] += (RealType)(dt * dU_pool[pool_idx].rhour[k]);
                U_pool[pool_idx].rhouz[k] += (RealType)(dt * dU_pool[pool_idx].rhouz[k]);
                U_pool[pool_idx].E[k] += (RealType)(dt * dU_pool[pool_idx].E[k]);
                U_pool[pool_idx].alpha1[k] += (RealType)(dt * dU_pool[pool_idx].alpha1[k]);
                U_pool[pool_idx].alpha2[k] += (RealType)(dt * dU_pool[pool_idx].alpha2[k]);
                U_pool[pool_idx].arho1[k] += (RealType)(dt * dU_pool[pool_idx].arho1[k]);
                U_pool[pool_idx].arho2[k] += (RealType)(dt * dU_pool[pool_idx].arho2[k]);
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
                    double tmp_alpha1 = (double)U_pool[pool_idx].alpha1[k];
                    double tmp_alpha2 = (double)U_pool[pool_idx].alpha2[k];
                    double tmp_arho1 = (double)U_pool[pool_idx].arho1[k];
                    double tmp_arho2 = (double)U_pool[pool_idx].arho2[k];
                    double dF = MultiMat::computeProgrammedBurn(currentTime, dt, r_c, 0, z_c, currentMaterials.det_vel, 0.0, det_x, det_y, det_z, std::min(dr, dz), currentMaterials.products.rho0, tmp_alpha1, tmp_alpha2, tmp_arho1, tmp_arho2);
                    U_pool[pool_idx].alpha1[k] = (RealType)tmp_alpha1;
                    U_pool[pool_idx].alpha2[k] = (RealType)tmp_alpha2;
                    U_pool[pool_idx].arho1[k] = (RealType)tmp_arho1;
                    U_pool[pool_idx].arho2[k] = (RealType)tmp_arho2;
                    if (currentMaterials.detonation_energy > 0.0 && dF > 0.0) {
                        double rho_expl = (double)(U_pool[pool_idx].arho1[k] + U_pool[pool_idx].arho2[k]);
                        U_pool[pool_idx].E[k] += (RealType)(dF * rho_expl * currentMaterials.detonation_energy);
                    }
                }
            }
        }
    }
    updatePrimitiveFromConservative();
    updateActiveRegion();
    currentTime += dt;
}

template <typename RealType>
std::vector<State2D> CFDSolver2DImpl<RealType>::getStates() const {
    std::vector<State2D> out(nr_cells * nz_cells);
    for (int i = 0; i < nr_cells; ++i) {
        for (int j = 0; j < nz_cells; ++j) {
            CellStateT<RealType> s = readState(this, tile_map, states_pool, i, j);
            int idx = i * nz_cells + j;
            out[idx].rho = (double)s.rho;
            out[idx].ur = (double)s.ur;
            out[idx].uz = (double)s.uz;
            out[idx].p = (double)s.p;
            out[idx].E = (double)s.E;
            out[idx].alpha1 = (double)s.alpha1;
            out[idx].alpha2 = (double)s.alpha2;
            out[idx].arho1 = (double)s.arho1;
            out[idx].arho2 = (double)s.arho2;
            out[idx].floor_status = 0; // Or whatever
        }
    }
    return out;
}

template <typename RealType>
std::vector<float> CFDSolver2DImpl<RealType>::getTelemetry2D(int stride) const {
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
            CellStateT<RealType> s = readState(this, tile_map, states_pool, src_i, src_j);
            int idx = i * out_nz + j;
            data[0 * dest_stride + idx] = (float)s.p;
            data[1 * dest_stride + idx] = (float)s.rho;
            data[2 * dest_stride + idx] = (float)s.ur;
            data[3 * dest_stride + idx] = (float)s.uz;
            data[4 * dest_stride + idx] = (float)s.E;
            data[5 * dest_stride + idx] = (float)s.alpha1;
            data[6 * dest_stride + idx] = (float)s.alpha2;
        }
    }
    return out;
}

template <typename RealType>
double CFDSolver2DImpl<RealType>::computeStepSize(double cfl) const {
    double max_speed = 1e-6;
    #pragma omp parallel for reduction(max:max_speed)
    for (int pool_idx = 0; pool_idx < (int)states_pool.size(); ++pool_idx) {
        for (int k = 0; k < TILE_SIZE * TILE_SIZE; ++k) {
            double c = MultiMat::getMixtureSoundSpeed((double)states_pool[pool_idx].p[k], (double)states_pool[pool_idx].rho[k], (double)states_pool[pool_idx].alpha1[k], (double)states_pool[pool_idx].alpha2[k], (double)states_pool[pool_idx].arho1[k], (double)states_pool[pool_idx].arho2[k], gamma, currentMaterials.products, currentMaterials.unreacted);
            double s = std::max(std::abs((double)states_pool[pool_idx].ur[k]), std::abs((double)states_pool[pool_idx].uz[k])) + c;
            max_speed = std::max(max_speed, s);
        }
    }
    return cfl * std::min(dr, dz) / max_speed;
}

template <typename RealType>
void CFDSolver2DImpl<RealType>::run(double duration) {
    double target_time = currentTime + duration;
    while (currentTime < target_time) {
        double dt = computeStepSize(0.35);
        if (currentTime + dt > target_time) dt = target_time - currentTime;
        step(dt);
        currentTime += dt;
    }
}

template <typename RealType>
std::vector<float> CFDSolver2DImpl<RealType>::getCellValues(int i, int j) const {
    std::vector<float> vals(7, 0.0f);
    if (i < 0 || i >= nr_cells || j < 0 || j >= nz_cells) return vals;
    
    CellStateT<RealType> s = readState(this, tile_map, states_pool, i, j);
    vals[0] = static_cast<float>(s.p);
    vals[1] = static_cast<float>(s.rho);
    double u_mag = std::sqrt((double)(s.ur * s.ur + s.uz * s.uz));
    vals[2] = static_cast<float>(u_mag);
    
    double e_int = (s.rho > 0.0) ? ((double)s.E / (double)s.rho - 0.5 * u_mag * u_mag) : 0.0;
    vals[3] = static_cast<float>(e_int);
    
    vals[4] = static_cast<float>(std::clamp((double)s.alpha1, 0.0, 1.0));
    vals[5] = static_cast<float>(std::clamp((double)s.alpha2, 0.0, 1.0));
    double air_frac = 1.0 - (double)s.alpha1 - (double)s.alpha2;
    vals[6] = static_cast<float>(std::clamp(air_frac, 0.0, 1.0));
    
    return vals;
}

template <typename RealType>
bool CFDSolver2DImpl<RealType>::checkTerminationCondition() const {
    double threshold = 1.05 * ambient_p;
    
    auto get_cell_p = [&](int i, int j) -> double {
        int tr = i / TILE_SIZE;
        int tz = j / TILE_SIZE;
        int pool_idx = tile_map[tr * ((nz_cells + TILE_SIZE - 1) / TILE_SIZE) + tz];
        if (pool_idx == -1) return ambient_p;
        int local_i = i % TILE_SIZE;
        int local_j = j % TILE_SIZE;
        return (double)states_pool[pool_idx].p[local_i * TILE_SIZE + local_j];
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

template <typename RealType>
void CFDSolver2DImpl<RealType>::setSolidVelocities(const double* v) {
    // dummy
}

template <typename RealType>
void CFDSolver2DImpl<RealType>::setSolidMask(const uint8_t* mask) {
    // dummy
}

template <typename RealType>
std::vector<double> CFDSolver2DImpl<RealType>::getLocalTimesteps(double cfl) const {
    std::vector<double> dt_local(nr_cells * nz_cells, 0.0);
    // Dummy implementation matching getLocalTimesteps signature
    #pragma omp parallel for collapse(2)
    for (int i = 0; i < nr_cells; ++i) {
        for (int j = 0; j < nz_cells; ++j) {
            CellStateT<RealType> s = readState(this, tile_map, states_pool, i, j);
            double c = MultiMat::getMixtureSoundSpeed((double)s.p, (double)s.rho, (double)s.alpha1, (double)s.alpha2, (double)s.arho1, (double)s.arho2, gamma, currentMaterials.products, currentMaterials.unreacted);
            double denom = std::max(std::abs((double)s.ur), std::abs((double)s.uz)) + c;
            if (denom < 1e-6) denom = 1e-6;
            dt_local[i * nz_cells + j] = cfl * std::min(dr, dz) / denom;
        }
    }
    return dt_local;
}

// Explicit instantiations
template class CFDSolver2DImpl<float>;
template class CFDSolver2DImpl<double>;
