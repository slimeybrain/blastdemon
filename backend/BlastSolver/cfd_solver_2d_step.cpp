#include "cfd_solver_2d.hpp"
#include "VTKWriter.hpp"
#include "cfd_2d_math_kernels.hpp"
#include <cmath>
#include <iostream>
#include <algorithm>
#include <stdexcept>
#include <omp.h>

template <typename RealType>
void CFDSolver2DImpl<RealType>::updateActiveRegion() {
    bool expanded = false;
    std::vector<int32_t> new_map = tile_map;
    std::vector<std::pair<int, int>> new_tiles_to_allocate;

    #pragma omp parallel for collapse(2) shared(expanded, new_map, new_tiles_to_allocate)
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
                                    new_map[n_flat] = -2; // Mark as pending allocation
                                    new_tiles_to_allocate.push_back({ntr, ntz});
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
        for (const auto& coord : new_tiles_to_allocate) {
            int pool_idx = allocateTile(coord.first, coord.second);
            new_map[coord.first * num_tiles_z + coord.second] = pool_idx;
        }
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
                p = MultiMat::getMixturePressure(e_internal, u_rho, alpha1, alpha2, arho1, arho2, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted);
                
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

    if (!solid_mask.empty() && !solid_velocities.empty()) {
        #pragma omp parallel for collapse(2)
        for (int i = 0; i < nr_cells; ++i) {
            for (int j = 0; j < nz_cells; ++j) {
                int flat = i * nz_cells + j;
                if (solid_mask[flat]) {
                    int tr = i / TILE_SIZE;
                    int tz = j / TILE_SIZE;
                    int pool_idx = tile_map[tr * num_tiles_z + tz];
                    if (pool_idx != -1) {
                        int local_i = i % TILE_SIZE;
                        int local_j = j % TILE_SIZE;
                        int k = local_i * TILE_SIZE + local_j;
                        RealType sv_u = (RealType)solid_velocities[2 * flat + 0];
                        RealType sv_v = (RealType)solid_velocities[2 * flat + 1];

                        states_pool[pool_idx].ur[k] = sv_u;
                        states_pool[pool_idx].uz[k] = sv_v;
                        U_pool[pool_idx].rhour[k] = states_pool[pool_idx].rho[k] * sv_u;
                        U_pool[pool_idx].rhouz[k] = states_pool[pool_idx].rho[k] * sv_v;
                        RealType ke = (RealType)0.5 * states_pool[pool_idx].rho[k] * (sv_u * sv_u + sv_v * sv_v);
                        U_pool[pool_idx].E[k] = states_pool[pool_idx].p[k] / ((RealType)gamma - (RealType)1.0) + ke;
                        states_pool[pool_idx].E[k] = U_pool[pool_idx].E[k];
                    }
                }
            }
        }
    }
}

// --------------------------------------------------------------------------------------
// Helper to read state safely given a global coordinate
template <typename RealType>
using CellStateT = CellState2DT<RealType>;

template <typename RealType>
inline void compute_E_cpu(CellStateT<RealType>& s, RealType gamma, const MultiMat::MaterialSet& mat, bool is_ideal_gas) {
    compute_E_kernel(s, gamma, mat, is_ideal_gas);
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
            c = MultiMat::getMixtureSoundSpeed(s.p, s.rho, s.alpha1, s.alpha2, s.arho1, s.arho2, gamma, mat.products, mat.unreacted);
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
              ((RealType)solver->getAmbientRho() * MultiMat::getEnergy_IdealGas((RealType)solver->getAmbientP(), (RealType)solver->getAmbientRho(), (RealType)solver->getGamma())), 
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
    return minmod_kernel(a, b);
}

template <typename RealType>
inline RealType weno3(RealType qm1, RealType q0, RealType qp1) {
    return weno3_kernel(qm1, q0, qp1);
}

// --------------------------------------------------------------------------------------
// Flux implementations adapted for CellStateT
template <typename RealType>
inline void calcFluxRusanov(const CellStateT<RealType>& sL, const CellStateT<RealType>& sR, RealType gamma, const MultiMat::MaterialSet& mat, 
                            RealType& f_rho, RealType& f_rhour, RealType& f_rhouz, RealType& f_E, 
                            RealType& f_alpha1, RealType& f_alpha2, RealType& f_arho1, RealType& f_arho2, RealType& v_face, bool is_ideal_gas) {
    calcFluxRusanov_kernel(sL, sR, gamma, mat, f_rho, f_rhour, f_rhouz, f_E, f_alpha1, f_alpha2, f_arho1, f_arho2, v_face, is_ideal_gas);
}

template <typename RealType>
inline void calcFluxRusanovZ(const CellStateT<RealType>& sL, const CellStateT<RealType>& sR, RealType gamma, const MultiMat::MaterialSet& mat, 
                             RealType& f_rho, RealType& f_rhour, RealType& f_rhouz, RealType& f_E, 
                             RealType& f_alpha1, RealType& f_alpha2, RealType& f_arho1, RealType& f_arho2, RealType& v_face, bool is_ideal_gas) {
    calcFluxRusanovZ_kernel(sL, sR, gamma, mat, f_rho, f_rhour, f_rhouz, f_E, f_alpha1, f_alpha2, f_arho1, f_arho2, v_face, is_ideal_gas);
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

            // Immersed solid wall boundary handling for flux reconstruction
            if (!solid_mask.empty()) {
                bool is_c = solid_mask[i * nz_cells + j] != 0;
                bool is_L = (i > 0) && (solid_mask[(i - 1) * nz_cells + j] != 0);
                bool is_R = (i < nr_cells - 1) && (solid_mask[(i + 1) * nz_cells + j] != 0);
                bool is_B = (j > 0) && (solid_mask[i * nz_cells + (j - 1)] != 0);
                bool is_T = (j < nz_cells - 1) && (solid_mask[i * nz_cells + (j + 1)] != 0);

                // Left face (i-1/2)
                if (is_L && !is_c) { // Solid on left, fluid on right
                    double sv_u = solid_velocities.empty() ? 0.0 : solid_velocities[2 * ((i - 1) * nz_cells + j) + 0];
                    s_faceL_L = s_faceL_R;
                    s_faceL_L.ur = (RealType)(2.0 * sv_u - s_faceL_R.ur);
                } else if (!is_L && is_c) { // Fluid on left, solid on right
                    double sv_u = solid_velocities.empty() ? 0.0 : solid_velocities[2 * (i * nz_cells + j) + 0];
                    s_faceL_R = s_faceL_L;
                    s_faceL_R.ur = (RealType)(2.0 * sv_u - s_faceL_L.ur);
                }

                // Right face (i+1/2)
                if (is_c && !is_R) { // Solid on left, fluid on right
                    double sv_u = solid_velocities.empty() ? 0.0 : solid_velocities[2 * (i * nz_cells + j) + 0];
                    s_faceR_L = s_faceR_R;
                    s_faceR_L.ur = (RealType)(2.0 * sv_u - s_faceR_R.ur);
                } else if (!is_c && is_R) { // Fluid on left, solid on right
                    double sv_u = solid_velocities.empty() ? 0.0 : solid_velocities[2 * ((i + 1) * nz_cells + j) + 0];
                    s_faceR_R = s_faceR_L;
                    s_faceR_R.ur = (RealType)(2.0 * sv_u - s_faceR_L.ur);
                }

                // Bottom face (j-1/2)
                if (is_B && !is_c) { // Solid below, fluid above
                    double sv_v = solid_velocities.empty() ? 0.0 : solid_velocities[2 * (i * nz_cells + (j - 1)) + 1];
                    s_faceB_L = s_faceB_R;
                    s_faceB_L.uz = (RealType)(2.0 * sv_v - s_faceB_R.uz);
                } else if (!is_B && is_c) { // Fluid below, solid above
                    double sv_v = solid_velocities.empty() ? 0.0 : solid_velocities[2 * (i * nz_cells + j) + 1];
                    s_faceB_R = s_faceB_L;
                    s_faceB_R.uz = (RealType)(2.0 * sv_v - s_faceB_L.uz);
                }

                // Top face (j+1/2)
                if (is_c && !is_T) { // Solid below, fluid above
                    double sv_v = solid_velocities.empty() ? 0.0 : solid_velocities[2 * (i * nz_cells + j) + 1];
                    s_faceT_L = s_faceT_R;
                    s_faceT_L.uz = (RealType)(2.0 * sv_v - s_faceT_R.uz);
                } else if (!is_c && is_T) { // Fluid below, solid above
                    double sv_v = solid_velocities.empty() ? 0.0 : solid_velocities[2 * (i * nz_cells + (j + 1)) + 1];
                    s_faceT_R = s_faceT_L;
                    s_faceT_R.uz = (RealType)(2.0 * sv_v - s_faceT_L.uz);
                }

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

            calcFluxRusanov(s_faceL_L, s_faceL_R, gamma_r, currentMaterials, fr_L_rho, fr_L_rhour, fr_L_rhouz, fr_L_E, fr_L_a1, fr_L_a2, fr_L_ar1, fr_L_ar2, v_face_rL, is_ideal_gas);
            calcFluxRusanov(s_faceR_L, s_faceR_R, gamma_r, currentMaterials, fr_R_rho, fr_R_rhour, fr_R_rhouz, fr_R_E, fr_R_a1, fr_R_a2, fr_R_ar1, fr_R_ar2, v_face_rR, is_ideal_gas);
            
            RealType fz_B_rho, fz_B_rhour, fz_B_rhouz, fz_B_E, fz_B_a1, fz_B_a2, fz_B_ar1, fz_B_ar2, v_face_zB;
            RealType fz_T_rho, fz_T_rhour, fz_T_rhouz, fz_T_E, fz_T_a1, fz_T_a2, fz_T_ar1, fz_T_ar2, v_face_zT;
 
            calcFluxRusanovZ(s_faceB_L, s_faceB_R, gamma_r, currentMaterials, fz_B_rho, fz_B_rhour, fz_B_rhouz, fz_B_E, fz_B_a1, fz_B_a2, fz_B_ar1, fz_B_ar2, v_face_zB, is_ideal_gas);
            calcFluxRusanovZ(s_faceT_L, s_faceT_R, gamma_r, currentMaterials, fz_T_rho, fz_T_rhour, fz_T_rhouz, fz_T_E, fz_T_a1, fz_T_a2, fz_T_ar1, fz_T_ar2, v_face_zT, is_ideal_gas);

            // Zero fluxes across internal solid faces
            if (!solid_mask.empty()) {
                bool is_c = solid_mask[i * nz_cells + j] != 0;
                bool is_L = (i > 0) && (solid_mask[(i - 1) * nz_cells + j] != 0);
                bool is_R = (i < nr_cells - 1) && (solid_mask[(i + 1) * nz_cells + j] != 0);
                bool is_B = (j > 0) && (solid_mask[i * nz_cells + (j - 1)] != 0);
                bool is_T = (j < nz_cells - 1) && (solid_mask[i * nz_cells + (j + 1)] != 0);

                if (is_L && is_c) { fr_L_rho = 0; fr_L_rhour = 0; fr_L_rhouz = 0; fr_L_E = 0; }
                if (is_c && is_R) { fr_R_rho = 0; fr_R_rhour = 0; fr_R_rhouz = 0; fr_R_E = 0; }
                if (is_B && is_c) { fz_B_rho = 0; fz_B_rhour = 0; fz_B_rhouz = 0; fz_B_E = 0; }
                if (is_c && is_T) { fz_T_rho = 0; fz_T_rhour = 0; fz_T_rhouz = 0; fz_T_E = 0; }
            }

            RealType r_center = (RealType)(i + 0.5) * dr_r;
            RealType r_left = (RealType)i * dr_r;
            RealType r_right = (RealType)(i + 1) * dr_r;

            RealType p_face_R = (RealType)0.5 * (s_faceR_L.p + s_faceR_R.p);
            RealType p_face_L = (RealType)0.5 * (s_faceL_L.p + s_faceL_R.p);
            RealType p_face_avg = (RealType)0.5 * (p_face_R + p_face_L);

            RealType dU_rho, dU_rhour, dU_rhouz, dU_E, div_u, dU_alpha1, dU_alpha2, dU_arho1, dU_arho2;
            if (is_cartesian) {
                dU_rho = -((RealType)1.0 / dr_r) * (fr_R_rho - fr_L_rho) - ((RealType)1.0 / dz_r) * (fz_T_rho - fz_B_rho);
                dU_rhour = -((RealType)1.0 / dr_r) * (fr_R_rhour - fr_L_rhour) - ((RealType)1.0 / dz_r) * (fz_T_rhour - fz_B_rhour);
                dU_rhouz = -((RealType)1.0 / dr_r) * (fr_R_rhouz - fr_L_rhouz) - ((RealType)1.0 / dz_r) * (fz_T_rhouz - fz_B_rhouz);
                dU_E = -((RealType)1.0 / dr_r) * (fr_R_E - fr_L_E) - ((RealType)1.0 / dz_r) * (fz_T_E - fz_B_E);

                div_u = ((RealType)1.0 / dr_r) * (v_face_rR - v_face_rL) + ((RealType)1.0 / dz_r) * (v_face_zT - v_face_zB);

                dU_alpha1 = -((RealType)1.0 / dr_r) * (fr_R_a1 - fr_L_a1) - ((RealType)1.0 / dz_r) * (fz_T_a1 - fz_B_a1) + s_c.alpha1 * div_u;
                dU_alpha2 = -((RealType)1.0 / dr_r) * (fr_R_a2 - fr_L_a2) - ((RealType)1.0 / dz_r) * (fz_T_a2 - fz_B_a2) + s_c.alpha2 * div_u;
                dU_arho1 = -((RealType)1.0 / dr_r) * (fr_R_ar1 - fr_L_ar1) - ((RealType)1.0 / dz_r) * (fz_T_ar1 - fz_B_ar1);
                dU_arho2 = -((RealType)1.0 / dr_r) * (fr_R_ar2 - fr_L_ar2) - ((RealType)1.0 / dz_r) * (fz_T_ar2 - fz_B_ar2);
            } else {
                dU_rho = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_rho - r_left * fr_L_rho) - ((RealType)1.0 / dz_r) * (fz_T_rho - fz_B_rho);
                dU_rhour = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_rhour - r_left * fr_L_rhour) - ((RealType)1.0 / dz_r) * (fz_T_rhour - fz_B_rhour) + p_face_avg / r_center;
                dU_rhouz = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_rhouz - r_left * fr_L_rhouz) - ((RealType)1.0 / dz_r) * (fz_T_rhouz - fz_B_rhouz);
                dU_E = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_E - r_left * fr_L_E) - ((RealType)1.0 / dz_r) * (fz_T_E - fz_B_E);

                div_u = ((RealType)1.0 / (r_center * dr_r)) * (r_right * v_face_rR - r_left * v_face_rL) + ((RealType)1.0 / dz_r) * (v_face_zT - v_face_zB);

                dU_alpha1 = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_a1 - r_left * fr_L_a1) - ((RealType)1.0 / dz_r) * (fz_T_a1 - fz_B_a1) + s_c.alpha1 * div_u;
                dU_alpha2 = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_a2 - r_left * fr_L_a2) - ((RealType)1.0 / dz_r) * (fz_T_a2 - fz_B_a2) + s_c.alpha2 * div_u;
                dU_arho1 = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_ar1 - r_left * fr_L_ar1) - ((RealType)1.0 / dz_r) * (fz_T_ar1 - fz_B_ar1);
                dU_arho2 = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_ar2 - r_left * fr_L_ar2) - ((RealType)1.0 / dz_r) * (fz_T_ar2 - fz_B_ar2);
            }

            if (!solid_mask.empty() && solid_mask[i * nz_cells + j] != 0) {
                dU_rho = 0;
                dU_rhour = 0;
                dU_rhouz = 0;
                dU_E = 0;
                dU_alpha1 = 0;
                dU_alpha2 = 0;
                dU_arho1 = 0;
                dU_arho2 = 0;
            }

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
                    
                    RealType r_c = ((RealType)i + (RealType)0.5) * (RealType)dr;
                    RealType z_c = ((RealType)j + (RealType)0.5) * (RealType)dz;
                    RealType tmp_alpha1 = U_pool[pool_idx].alpha1[k];
                    RealType tmp_alpha2 = U_pool[pool_idx].alpha2[k];
                    RealType tmp_arho1 = U_pool[pool_idx].arho1[k];
                    RealType tmp_arho2 = U_pool[pool_idx].arho2[k];
                    RealType det_x_r = (RealType)det_x;
                    RealType det_y_r = (RealType)det_y;
                    RealType det_z_r = (RealType)det_z;
                    RealType currentTime_r = (RealType)currentTime;
                    RealType dt_r = (RealType)dt;
                    RealType dF = MultiMat::computeProgrammedBurn(currentTime_r, dt_r, r_c, (RealType)0.0, z_c, (RealType)currentMaterials.det_vel, (RealType)0.0, det_x_r, det_y_r, det_z_r, std::min((RealType)dr, (RealType)dz), (RealType)currentMaterials.products.rho0, tmp_alpha1, tmp_alpha2, tmp_arho1, tmp_arho2);
                    U_pool[pool_idx].alpha1[k] = tmp_alpha1;
                    U_pool[pool_idx].alpha2[k] = tmp_alpha2;
                    U_pool[pool_idx].arho1[k] = tmp_arho1;
                    U_pool[pool_idx].arho2[k] = tmp_arho2;
                    if (currentMaterials.detonation_energy > 0.0 && dF > (RealType)0.0) {
                        RealType rho_expl = U_pool[pool_idx].arho1[k] + U_pool[pool_idx].arho2[k];
                        U_pool[pool_idx].E[k] += dF * rho_expl * (RealType)currentMaterials.detonation_energy;
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
    RealType max_speed = (RealType)1e-6;
    #pragma omp parallel for reduction(max:max_speed)
    for (int pool_idx = 0; pool_idx < (int)states_pool.size(); ++pool_idx) {
        for (int k = 0; k < TILE_SIZE * TILE_SIZE; ++k) {
            using std::abs;
            using std::max;
            RealType rho = states_pool[pool_idx].rho[k];
            RealType p = states_pool[pool_idx].p[k];
            RealType ur = states_pool[pool_idx].ur[k];
            RealType uz = states_pool[pool_idx].uz[k];

            if (std::isnan(rho) || std::isnan(p) || std::isnan(ur) || std::isnan(uz) ||
                std::isinf(rho) || std::isinf(p) || std::isinf(ur) || std::isinf(uz) ||
                rho <= (RealType)1e-8 || p <= (RealType)1e-8) {
                continue;
            }

            RealType c = MultiMat::getMixtureSoundSpeed(p, rho, states_pool[pool_idx].alpha1[k], states_pool[pool_idx].alpha2[k], states_pool[pool_idx].arho1[k], states_pool[pool_idx].arho2[k], (RealType)gamma, currentMaterials.products, currentMaterials.unreacted);
            if (std::isnan(c) || std::isinf(c)) continue;

            RealType s = max(abs(ur), abs(uz)) + c;
            if (s > (RealType)20000.0) s = (RealType)20000.0;
            max_speed = max(max_speed, s);
        }
    }
    if (max_speed < (RealType)1e-6) max_speed = (RealType)340.0;
    return cfl * std::min(dr, dz) / (double)max_speed;
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
    if (!v) {
        solid_velocities.clear();
        return;
    }
    solid_velocities.assign(v, v + 2 * nr_cells * nz_cells);
}

template <typename RealType>
void CFDSolver2DImpl<RealType>::setSolidMask(const uint8_t* mask) {
    if (!mask) {
        solid_mask.clear();
        return;
    }
    solid_mask.assign(mask, mask + nr_cells * nz_cells);
}

template <typename RealType>
std::vector<double> CFDSolver2DImpl<RealType>::getLocalTimesteps(double cfl) const {
    std::vector<double> dt_local(nr_cells * nz_cells, 0.0);
    // Dummy implementation matching getLocalTimesteps signature
    #pragma omp parallel for collapse(2)
    for (int i = 0; i < nr_cells; ++i) {
        for (int j = 0; j < nz_cells; ++j) {
            CellStateT<RealType> s = readState(this, tile_map, states_pool, i, j);
            using std::abs;
            using std::max;
            RealType c = MultiMat::getMixtureSoundSpeed(s.p, s.rho, s.alpha1, s.alpha2, s.arho1, s.arho2, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted);
            RealType denom = max(abs(s.ur), abs(s.uz)) + c;
            if (denom < (RealType)1e-6) denom = (RealType)1e-6;
            dt_local[i * nz_cells + j] = cfl * std::min(dr, dz) / (double)denom;
        }
    }
    return dt_local;
}

template <typename RealType>
void CFDSolver2DImpl<RealType>::setGauges(const std::vector<Gauge2D>& gauges) {
    cpu_gauges = gauges;
    cpu_gauge_times.clear();
    cpu_gauge_values.clear();
}

template <typename RealType>
void CFDSolver2DImpl<RealType>::recordGaugesAsync(double t) {
    if (cpu_gauges.empty()) return;
    cpu_gauge_times.push_back(t);
    for (const auto& gauge : cpu_gauges) {
        int i = std::clamp(static_cast<int>(gauge.r / dr), 0, nr_cells - 1);
        int j = std::clamp(static_cast<int>(gauge.z / dz), 0, nz_cells - 1);
        auto vals = getCellValues(i, j);
        cpu_gauge_values.insert(cpu_gauge_values.end(), vals.begin(), vals.end());
    }
}

template <typename RealType>
void CFDSolver2DImpl<RealType>::retrieveNewGaugeSamples(std::vector<double>& times, std::vector<float>& values) {
    times = std::move(cpu_gauge_times);
    values = std::move(cpu_gauge_values);
    cpu_gauge_times.clear();
    cpu_gauge_values.clear();
}

template <typename RealType>
void CFDSolver2DImpl<RealType>::exportVTK(const std::string& filename) const {
    int nr = getNr();
    int nz = getNz();
    double dr = getDr();
    double dz = getDz();
    auto states = getStates();
    std::vector<double> rho(states.size()), ur(states.size()), uz(states.size()), p(states.size()), E(states.size()), alpha1(states.size()), alpha2(states.size());
    for (size_t idx = 0; idx < states.size(); ++idx) {
        rho[idx] = states[idx].rho;
        ur[idx] = states[idx].ur;
        uz[idx] = states[idx].uz;
        p[idx] = states[idx].p;
        E[idx] = states[idx].E;
        alpha1[idx] = states[idx].alpha1;
        alpha2[idx] = states[idx].alpha2;
    }
    export_vtu_2d(filename, nr, nz, dr, dz, rho, ur, uz, p, E, alpha1, alpha2);
}

// Explicit instantiations
template class CFDSolver2DImpl<float>;
template class CFDSolver2DImpl<double>;
