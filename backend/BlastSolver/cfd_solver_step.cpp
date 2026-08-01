#include "cfd_solver.hpp"
#include <cmath>
#include <iostream>
#include <algorithm>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

template <typename RealType, bool IsMultiMaterial>
void CFDSolverImpl<RealType, IsMultiMaterial>::updateConservativeFromPrimitive(const std::vector<PrimitiveState>& states_vec, std::vector<ConservedState>& U_vec) {
    for (int i = 0; i < n_cells; ++i) {
        if (cancel_flag && cancel_flag->load()) return;
        U_vec[i].rho = states_vec[i].rho;
        U_vec[i].rhou = states_vec[i].rho * states_vec[i].u;
        U_vec[i].E = states_vec[i].E;
        if constexpr (IsMultiMaterial) {
            U_vec[i].alpha1 = states_vec[i].alpha1; U_vec[i].alpha2 = states_vec[i].alpha2;
            U_vec[i].arho1 = states_vec[i].arho1; U_vec[i].arho2 = states_vec[i].arho2;
        }
    }
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolverImpl<RealType, IsMultiMaterial>::updatePrimitiveFromConservative(std::vector<ConservedState>& U_vec, std::vector<PrimitiveState>& states_vec) {
    int limit = std::min(n_cells, active_r_idx);
    const RealType rho_floor = (RealType)1e-8;
    const RealType p_floor = (RealType)1e-8;

    for (int i = 0; i < limit; ++i) {
        if (cancel_flag && cancel_flag->load()) return;
        bool bad = false;
        if (std::isnan(U_vec[i].rho) || std::isinf(U_vec[i].rho) || U_vec[i].rho < rho_floor) bad = true;
        if (std::isnan(U_vec[i].rhou) || std::isinf(U_vec[i].rhou)) bad = true;
        if (std::isnan(U_vec[i].E) || std::isinf(U_vec[i].E)) bad = true;

        RealType u = 0.0;
        RealType p = 0.0;

        int floor_status = 0;

        if (!bad) {
            RealType rho_safe = std::max(U_vec[i].rho, rho_floor);
            if (U_vec[i].rho < rho_floor) floor_status |= 1; // Density floor activated

            u = U_vec[i].rhou / rho_safe;
            RealType ke = 0.5 * rho_safe * u * u;

            // Kinetic energy safeguard to protect internal energy
            RealType e_internal = U_vec[i].E - ke;
            if (e_internal < p_floor / ((RealType)gamma - (RealType)1.0)) {
                e_internal = p_floor / ((RealType)gamma - (RealType)1.0);
                ke = std::max((RealType)0.0, U_vec[i].E - e_internal);
                RealType u_safe = std::sqrt((RealType)2.0 * ke / rho_safe);
                u = (u >= 0) ? u_safe : -u_safe;
                U_vec[i].rhou = rho_safe * u;
                floor_status |= 4; // KE safeguard activated
            }

            if constexpr (IsMultiMaterial) {
                RealType alpha1 = std::max((RealType)0.0, std::min((RealType)1.0, U_vec[i].alpha1));
                RealType alpha2 = std::max((RealType)0.0, std::min((RealType)1.0, U_vec[i].alpha2));
                if (alpha1 + alpha2 > (RealType)1.0) {
                    RealType sum = alpha1 + alpha2;
                    alpha1 /= sum;
                    alpha2 /= sum;
                }

                RealType arho1 = std::max((RealType)0.0, std::min(U_vec[i].rho, U_vec[i].arho1));
                RealType arho2 = std::max((RealType)0.0, std::min(U_vec[i].rho, U_vec[i].arho2));
                if (arho1 + arho2 > U_vec[i].rho) {
                    RealType sum = arho1 + arho2;
                    arho1 = (arho1 / sum) * U_vec[i].rho;
                    arho2 = (arho2 / sum) * U_vec[i].rho;
                }

                U_vec[i].alpha1 = alpha1; U_vec[i].alpha2 = alpha2;
                U_vec[i].arho1 = arho1; U_vec[i].arho2 = arho2;

                states_vec[i].alpha1 = alpha1; states_vec[i].alpha2 = alpha2;
                states_vec[i].arho1 = arho1; states_vec[i].arho2 = arho2;
            }

            p = getPressure<RealType, IsMultiMaterial>(e_internal, U_vec[i].rho, states_vec[i], (RealType)gamma, currentMaterials.products, currentMaterials.unreacted);
            if (std::isnan(p) || std::isinf(p) || p < p_floor) {
                bad = true;
            } else {
                if (p < p_floor) floor_status |= 2; // Pressure floor activated
                states_vec[i].p = std::max(p, p_floor);
            }
        }

        if (bad) {
            floor_status |= 8; // Bad state fallback activated
            RealType sum_rho = 0, sum_rhou = 0, sum_E = 0;
            RealType sum_alpha1 = 0, sum_alpha2 = 0, sum_arho1 = 0, sum_arho2 = 0;
            int count = 0;

            auto is_good = [&](int idx) {
                if (idx < 0 || idx >= n_cells) return false;
                if (std::isnan(U_vec[idx].rho) || std::isinf(U_vec[idx].rho) || U_vec[idx].rho < rho_floor) return false;
                if (std::isnan(U_vec[idx].rhou) || std::isinf(U_vec[idx].rhou)) return false;
                if (std::isnan(U_vec[idx].E) || std::isinf(U_vec[idx].E)) return false;
                RealType rho_safe = std::max(U_vec[idx].rho, rho_floor);
                RealType u_n = U_vec[idx].rhou / rho_safe;
                RealType ke_n = 0.5 * rho_safe * u_n * u_n;
                RealType e_internal_n = U_vec[idx].E - ke_n;
                PrimitiveState temp_state_good;
                if constexpr (IsMultiMaterial) {
                    temp_state_good.alpha1 = U_vec[idx].alpha1;
                    temp_state_good.alpha2 = U_vec[idx].alpha2;
                    temp_state_good.arho1 = U_vec[idx].arho1;
                    temp_state_good.arho2 = U_vec[idx].arho2;
                }
                RealType p_n = getPressure<RealType, IsMultiMaterial>(std::max(e_internal_n, p_floor / ((RealType)gamma - (RealType)1.0)), U_vec[idx].rho, temp_state_good, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted);
                if (std::isnan(p_n) || std::isinf(p_n) || p_n < p_floor) return false;
                return true;
            };

            if (is_good(i - 1)) {
                sum_rho += U_vec[i-1].rho; sum_rhou += U_vec[i-1].rhou; sum_E += U_vec[i-1].E;
                if constexpr (IsMultiMaterial) {
                    sum_alpha1 += U_vec[i-1].alpha1; sum_alpha2 += U_vec[i-1].alpha2;
                    sum_arho1 += U_vec[i-1].arho1; sum_arho2 += U_vec[i-1].arho2;
                }
                count++;
            }
            if (is_good(i + 1)) {
                sum_rho += U_vec[i+1].rho; sum_rhou += U_vec[i+1].rhou; sum_E += U_vec[i+1].E;
                if constexpr (IsMultiMaterial) {
                    sum_alpha1 += U_vec[i+1].alpha1; sum_alpha2 += U_vec[i+1].alpha2;
                    sum_arho1 += U_vec[i+1].arho1; sum_arho2 += U_vec[i+1].arho2;
                }
                count++;
            }

            if (count > 0) {
                U_vec[i].rho   = sum_rho   / count;
                U_vec[i].rhou  = sum_rhou  / count;
                U_vec[i].E     = sum_E     / count;
                if constexpr (IsMultiMaterial) {
                    U_vec[i].alpha1 = sum_alpha1 / count;
                    U_vec[i].alpha2 = sum_alpha2 / count;
                    U_vec[i].arho1  = sum_arho1  / count;
                    U_vec[i].arho2  = sum_arho2  / count;

                    // -------------------------------------------------------
                    // Species re-normalisation after neighbour average.
                    // -------------------------------------------------------
                    RealType rho_new   = std::max(U_vec[i].rho, rho_floor);
                    RealType arho1_avg = std::max((RealType)0.0, std::min(rho_new, U_vec[i].arho1));
                    RealType arho2_avg = std::max((RealType)0.0, std::min(rho_new, U_vec[i].arho2));
                    if (arho1_avg + arho2_avg > rho_new) {
                        RealType s = arho1_avg + arho2_avg;
                        arho1_avg = (arho1_avg / s) * rho_new;
                        arho2_avg = (arho2_avg / s) * rho_new;
                    }
                    U_vec[i].arho1 = arho1_avg;
                    U_vec[i].arho2 = arho2_avg;

                    // Volume fractions: clamp then renormalise sum <= 1
                    RealType a1 = std::max((RealType)0.0, std::min((RealType)1.0, U_vec[i].alpha1));
                    RealType a2 = std::max((RealType)0.0, std::min((RealType)1.0, U_vec[i].alpha2));
                    if (a1 + a2 > (RealType)1.0) { RealType s = a1 + a2; a1 /= s; a2 /= s; }
                    U_vec[i].alpha1 = a1; U_vec[i].alpha2 = a2;
                }
            } else {
                U_vec[i].rho   = (RealType)ambient_rho;
                U_vec[i].rhou  = 0.0;
                U_vec[i].E     = (RealType)ambient_p / ((RealType)gamma - (RealType)1.0);
                if constexpr (IsMultiMaterial) {
                    U_vec[i].alpha1 = 0.0; U_vec[i].alpha2 = 0.0;
                    U_vec[i].arho1  = 0.0; U_vec[i].arho2  = 0.0;
                }
            }

            states_vec[i].rho    = std::max(U_vec[i].rho, rho_floor);
            states_vec[i].u      = U_vec[i].rhou / states_vec[i].rho;
            states_vec[i].E      = U_vec[i].E;
            if constexpr (IsMultiMaterial) {
                states_vec[i].alpha1 = U_vec[i].alpha1; states_vec[i].alpha2 = U_vec[i].alpha2;
                states_vec[i].arho1  = U_vec[i].arho1;  states_vec[i].arho2  = U_vec[i].arho2;
            }
            RealType ke_n       = 0.5 * states_vec[i].rho * states_vec[i].u * states_vec[i].u;
            RealType e_int_n    = std::max(states_vec[i].E - ke_n, p_floor / ((RealType)gamma - (RealType)1.0));
            states_vec[i].p   = std::max(getPressure<RealType, IsMultiMaterial>(
                e_int_n, states_vec[i].rho, states_vec[i],
                (RealType)gamma, currentMaterials.products, currentMaterials.unreacted), p_floor);
        } else {
            states_vec[i].rho = std::max(U_vec[i].rho, rho_floor);
            states_vec[i].u   = u;
            states_vec[i].E   = U_vec[i].E;
        }

        states_vec[i].floor_status = floor_status;
    }
}

template <typename RealType, bool IsMultiMaterial>
typename CFDSolverImpl<RealType, IsMultiMaterial>::ConservedState CFDSolverImpl<RealType, IsMultiMaterial>::computedUdt(const std::vector<ConservedState>& /*U_current*/, const std::vector<PrimitiveState>& states_current, int i, double dt) {
    RealType V_i = (RealType)geom_V[i];
    RealType A_left = (RealType)geom_A[i];
    RealType A_right = (RealType)geom_A[i+1];

    ConservedState F_left, F_right;

    // Left interface (i)
    PrimitiveState sL, sR;
    reconstruct(states_current, i, sL, sR, dt);
    ConservedState uL, uR;
    uL.rho = sL.rho; uL.rhou = sL.rho * sL.u; uL.E = sL.E;
    uR.rho = sR.rho; uR.rhou = sR.rho * sR.u; uR.E = sR.E;
    if constexpr (IsMultiMaterial) {
        uL.alpha1 = sL.alpha1; uL.alpha2 = sL.alpha2; uL.arho1 = sL.arho1; uL.arho2 = sL.arho2;
        uR.alpha1 = sR.alpha1; uR.alpha2 = sR.alpha2; uR.arho1 = sR.arho1; uR.arho2 = sR.arho2;
    }

    if (i == 0 && bcLeft == REFLECTIVE) {
        F_left.rho = 0.0;
        F_left.rhou = sR.p; // Exact pressure applied at A=0 face, using proper inner boundary state
        F_left.E = 0.0;
        if constexpr (IsMultiMaterial) {
            F_left.alpha1 = 0.0; F_left.alpha2 = 0.0; F_left.arho1 = 0.0; F_left.arho2 = 0.0;
        }
        v_int[i] = 0.0;
    } else {
        double v_face_L = 0.0;
        F_left = getFlux(sL, sR, uL, uR, dt, v_face_L);
        v_int[i] = (RealType)v_face_L;
    }

    // Right interface (i+1)
    if (i == n_cells - 1) {
        if (bcRight == TRANSMISSIVE) {
            F_right = flux(states_current[i]);
            v_int[i+1] = states_current[i].u;
        } else {
            F_right.rho = 0;
            F_right.rhou = states_current[i].p;
            F_right.E = 0;
            if constexpr (IsMultiMaterial) {
                F_right.alpha1 = 0; F_right.alpha2 = 0; F_right.arho1 = 0; F_right.arho2 = 0;
            }
            v_int[i+1] = 0.0;
        }
    } else {
        PrimitiveState sL, sR;
        reconstruct(states_current, i + 1, sL, sR, dt);
        ConservedState uL, uR;
        uL.rho = sL.rho; uL.rhou = sL.rho * sL.u; uL.E = sL.E;
        uR.rho = sR.rho; uR.rhou = sR.rho * sR.u; uR.E = sR.E;
        if constexpr (IsMultiMaterial) {
            uL.alpha1 = sL.alpha1; uL.alpha2 = sL.alpha2; uL.arho1 = sL.arho1; uL.arho2 = sL.arho2;
            uR.alpha1 = sR.alpha1; uR.alpha2 = sR.alpha2; uR.arho1 = sR.arho1; uR.arho2 = sR.arho2;
        }
        double v_face_R = 0.0;
        F_right = getFlux(sL, sR, uL, uR, dt, v_face_R);
        v_int[i+1] = (RealType)v_face_R;
    }

    // Well-balanced formulation
    ConservedState dU;
    RealType p_i = states_current[i].p;
    dU.rho  = -((RealType)1.0 / V_i) * (A_right * F_right.rho  - A_left * F_left.rho);
    dU.rhou = -((RealType)1.0 / V_i) * (A_right * (F_right.rhou - p_i) - A_left * (F_left.rhou - p_i));
    dU.E    = -((RealType)1.0 / V_i) * (A_right * F_right.E    - A_left * F_left.E);
    if constexpr (IsMultiMaterial) {
        dU.arho1 = -((RealType)1.0 / V_i) * (A_right * F_right.arho1 - A_left * F_left.arho1);
        dU.arho2 = -((RealType)1.0 / V_i) * (A_right * F_right.arho2 - A_left * F_left.arho2);
        RealType u_R_int = v_int[i+1];
        RealType u_L_int = v_int[i];
        RealType div_u = ((RealType)1.0 / V_i) * (A_right * u_R_int - A_left * u_L_int);
        dU.alpha1 = -((RealType)1.0 / V_i) * (A_right * F_right.alpha1 - A_left * F_left.alpha1) + states_current[i].alpha1 * div_u;
        dU.alpha2 = -((RealType)1.0 / V_i) * (A_right * F_right.alpha2 - A_left * F_left.alpha2) + states_current[i].alpha2 * div_u;
    }
    return dU;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolverImpl<RealType, IsMultiMaterial>::step(double dt) {
    auto applySourceTerms = [&](RealType dt_step, RealType t_step) {
        if constexpr (IsMultiMaterial) {
            for (int i = 0; i < active_r_idx; ++i) {
                if (cancel_flag && cancel_flag->load()) return;
                RealType r_c = (RealType)(i + 0.5) * (RealType)dr;

                RealType tmp_alpha1 = U[i].alpha1;
                RealType tmp_alpha2 = U[i].alpha2;
                RealType tmp_arho1 = U[i].arho1;
                RealType tmp_arho2 = U[i].arho2;
                RealType dF = MultiMat::computeProgrammedBurn(
                    t_step, dt_step,
                    r_c, (RealType)0.0, (RealType)0.0,
                    (RealType)currentMaterials.det_vel, (RealType)0.0,
                    (RealType)0.0, (RealType)0.0, (RealType)0.0,
                    (RealType)dr, (RealType)currentMaterials.products.rho0,
                    tmp_alpha1, tmp_alpha2,
                    tmp_arho1,  tmp_arho2);
                U[i].alpha1 = tmp_alpha1;
                U[i].alpha2 = tmp_alpha2;
                U[i].arho1 = tmp_arho1;
                U[i].arho2 = tmp_arho2;

                if (currentMaterials.detonation_energy > 0.0 && dF > 0.0) {
                    RealType rho_expl = U[i].arho1 + U[i].arho2;
                    U[i].E += dF * rho_expl * (RealType)currentMaterials.detonation_energy;
                }
            }
            updatePrimitiveFromConservative(U, states);
        }
    };

    applySourceTerms((RealType)(0.5 * dt), (RealType)currentTime);

    if (cancel_flag && cancel_flag->load()) return;

    if (temporalOrder == 1) {
        std::vector<ConservedState> next_U = U;
        for (int i = 0; i < active_r_idx; ++i) {
            if (cancel_flag && cancel_flag->load()) return;
            ConservedState dU = computedUdt(U, states, i, dt);
            next_U[i].rho  = U[i].rho  + (RealType)dt * dU.rho;
            next_U[i].rhou = U[i].rhou + (RealType)dt * dU.rhou;
            next_U[i].E    = U[i].E    + (RealType)dt * dU.E;
            if constexpr (IsMultiMaterial) {
                next_U[i].alpha1 = U[i].alpha1 + (RealType)dt * dU.alpha1;
                next_U[i].alpha2 = U[i].alpha2 + (RealType)dt * dU.alpha2;
                next_U[i].arho1  = U[i].arho1  + (RealType)dt * dU.arho1;
                next_U[i].arho2  = U[i].arho2  + (RealType)dt * dU.arho2;
            }
        }
        U = next_U;
    } else if (temporalOrder == 2) {
        std::vector<ConservedState> U1 = U;
        std::vector<PrimitiveState> states1 = states;
        for (int i = 0; i < active_r_idx; ++i) {
            if (cancel_flag && cancel_flag->load()) return;
            ConservedState dU = computedUdt(U, states, i, dt);
            U1[i].rho  = U[i].rho  + (RealType)dt * dU.rho;
            U1[i].rhou = U[i].rhou + (RealType)dt * dU.rhou;
            U1[i].E    = U[i].E    + (RealType)dt * dU.E;
            if constexpr (IsMultiMaterial) {
                U1[i].alpha1 = U[i].alpha1 + (RealType)dt * dU.alpha1;
                U1[i].alpha2 = U[i].alpha2 + (RealType)dt * dU.alpha2;
                U1[i].arho1  = U[i].arho1  + (RealType)dt * dU.arho1;
                U1[i].arho2  = U[i].arho2  + (RealType)dt * dU.arho2;
            }
        }
        updatePrimitiveFromConservative(U1, states1);
        if (cancel_flag && cancel_flag->load()) return;
        for (int i = 0; i < active_r_idx; ++i) {
            if (cancel_flag && cancel_flag->load()) return;
            ConservedState dU0 = computedUdt(U, states, i, dt);
            ConservedState dU1 = computedUdt(U1, states1, i, dt);
            U[i].rho  += (RealType)(0.5 * dt) * (dU0.rho  + dU1.rho);
            U[i].rhou += (RealType)(0.5 * dt) * (dU0.rhou + dU1.rhou);
            U[i].E    += (RealType)(0.5 * dt) * (dU0.E    + dU1.E);
            if constexpr (IsMultiMaterial) {
                U[i].alpha1 += (RealType)(0.5 * dt) * (dU0.alpha1 + dU1.alpha1);
                U[i].alpha2 += (RealType)(0.5 * dt) * (dU0.alpha2 + dU1.alpha2);
                U[i].arho1  += (RealType)(0.5 * dt) * (dU0.arho1  + dU1.arho1);
                U[i].arho2  += (RealType)(0.5 * dt) * (dU0.arho2  + dU1.arho2);
            }
        }
    } else if (temporalOrder == 3) {
        std::vector<ConservedState> U1 = U, U2 = U;
        std::vector<PrimitiveState> states1 = states, states2 = states;

        // Stage 1
        for (int i = 0; i < active_r_idx; ++i) {
            if (cancel_flag && cancel_flag->load()) return;
            ConservedState dU = computedUdt(U, states, i, dt);
            U1[i].rho  = U[i].rho  + (RealType)dt * dU.rho;
            U1[i].rhou = U[i].rhou + (RealType)dt * dU.rhou;
            U1[i].E    = U[i].E    + (RealType)dt * dU.E;
            if constexpr (IsMultiMaterial) {
                U1[i].alpha1 = U[i].alpha1 + (RealType)dt * dU.alpha1;
                U1[i].alpha2 = U[i].alpha2 + (RealType)dt * dU.alpha2;
                U1[i].arho1  = U[i].arho1  + (RealType)dt * dU.arho1;
                U1[i].arho2  = U[i].arho2  + (RealType)dt * dU.arho2;
            }
        }
        updatePrimitiveFromConservative(U1, states1);
        if (cancel_flag && cancel_flag->load()) return;

        // Stage 2
        for (int i = 0; i < active_r_idx; ++i) {
            if (cancel_flag && cancel_flag->load()) return;
            ConservedState dU = computedUdt(U1, states1, i, dt);
            U2[i].rho  = (RealType)0.75 * U[i].rho  + (RealType)0.25 * U1[i].rho  + (RealType)(0.25 * dt) * dU.rho;
            U2[i].rhou = (RealType)0.75 * U[i].rhou + (RealType)0.25 * U1[i].rhou + (RealType)(0.25 * dt) * dU.rhou;
            U2[i].E    = (RealType)0.75 * U[i].E    + (RealType)0.25 * U1[i].E    + (RealType)(0.25 * dt) * dU.E;
            if constexpr (IsMultiMaterial) {
                U2[i].alpha1 = (RealType)0.75 * U[i].alpha1 + (RealType)0.25 * U1[i].alpha1 + (RealType)(0.25 * dt) * dU.alpha1;
                U2[i].alpha2 = (RealType)0.75 * U[i].alpha2 + (RealType)0.25 * U1[i].alpha2 + (RealType)(0.25 * dt) * dU.alpha2;
                U2[i].arho1  = (RealType)0.75 * U[i].arho1  + (RealType)0.25 * U1[i].arho1  + (RealType)(0.25 * dt) * dU.arho1;
                U2[i].arho2  = (RealType)0.75 * U[i].arho2  + (RealType)0.25 * U1[i].arho2  + (RealType)(0.25 * dt) * dU.arho2;
            }
        }
        updatePrimitiveFromConservative(U2, states2);
        if (cancel_flag && cancel_flag->load()) return;

        // Stage 3
        for (int i = 0; i < active_r_idx; ++i) {
            if (cancel_flag && cancel_flag->load()) return;
            ConservedState dU = computedUdt(U2, states2, i, dt);
            U[i].rho  = (RealType)(1.0/3.0) * U[i].rho  + (RealType)(2.0/3.0) * U2[i].rho  + (RealType)((2.0/3.0) * dt) * dU.rho;
            U[i].rhou = (RealType)(1.0/3.0) * U[i].rhou + (RealType)(2.0/3.0) * U2[i].rhou + (RealType)((2.0/3.0) * dt) * dU.rhou;
            U[i].E    = (RealType)(1.0/3.0) * U[i].E    + (RealType)(2.0/3.0) * U2[i].E    + (RealType)((2.0/3.0) * dt) * dU.E;
            if constexpr (IsMultiMaterial) {
                U[i].alpha1 = (RealType)(1.0/3.0) * U[i].alpha1 + (RealType)(2.0/3.0) * U2[i].alpha1 + (RealType)((2.0/3.0) * dt) * dU.alpha1;
                U[i].alpha2 = (RealType)(1.0/3.0) * U[i].alpha2 + (RealType)(2.0/3.0) * U2[i].alpha2 + (RealType)((2.0/3.0) * dt) * dU.alpha2;
                U[i].arho1  = (RealType)(1.0/3.0) * U[i].arho1  + (RealType)(2.0/3.0) * U2[i].arho1  + (RealType)((2.0/3.0) * dt) * dU.arho1;
                U[i].arho2  = (RealType)(1.0/3.0) * U[i].arho2  + (RealType)(2.0/3.0) * U2[i].arho2  + (RealType)((2.0/3.0) * dt) * dU.arho2;
            }
        }
    } else if (temporalOrder == 4) {
        // SSP-RK4
        std::vector<ConservedState> U1 = U, U2 = U, U3 = U, U4 = U;
        std::vector<PrimitiveState> states1 = states, states2 = states, states3 = states, states4 = states;

        // Stage 1
        for (int i = 0; i < active_r_idx; ++i) {
            if (cancel_flag && cancel_flag->load()) return;
            ConservedState dU = computedUdt(U, states, i, dt);
            U1[i].rho  = U[i].rho  + (RealType)(0.39175222700392 * dt) * dU.rho;
            U1[i].rhou = U[i].rhou + (RealType)(0.39175222700392 * dt) * dU.rhou;
            U1[i].E    = U[i].E    + (RealType)(0.39175222700392 * dt) * dU.E;
            if constexpr (IsMultiMaterial) {
                U1[i].alpha1 = U[i].alpha1 + (RealType)(0.39175222700392 * dt) * dU.alpha1;
                U1[i].alpha2 = U[i].alpha2 + (RealType)(0.39175222700392 * dt) * dU.alpha2;
                U1[i].arho1  = U[i].arho1  + (RealType)(0.39175222700392 * dt) * dU.arho1;
                U1[i].arho2  = U[i].arho2  + (RealType)(0.39175222700392 * dt) * dU.arho2;
            }
        }
        updatePrimitiveFromConservative(U1, states1);
        if (cancel_flag && cancel_flag->load()) return;

        // Stage 2
        for (int i = 0; i < active_r_idx; ++i) {
            if (cancel_flag && cancel_flag->load()) return;
            ConservedState dU = computedUdt(U1, states1, i, dt);
            U2[i].rho  = (RealType)0.44437049406734 * U[i].rho  + (RealType)0.55562950593266 * U1[i].rho  + (RealType)(0.36841059262959 * dt) * dU.rho;
            U2[i].rhou = (RealType)0.44437049406734 * U[i].rhou + (RealType)0.55562950593266 * U1[i].rhou + (RealType)(0.36841059262959 * dt) * dU.rhou;
            U2[i].E    = (RealType)0.44437049406734 * U[i].E    + (RealType)0.55562950593266 * U1[i].E    + (RealType)(0.36841059262959 * dt) * dU.E;
            if constexpr (IsMultiMaterial) {
                U2[i].alpha1 = (RealType)0.44437049406734 * U[i].alpha1 + (RealType)0.55562950593266 * U1[i].alpha1 + (RealType)(0.36841059262959 * dt) * dU.alpha1;
                U2[i].alpha2 = (RealType)0.44437049406734 * U[i].alpha2 + (RealType)0.55562950593266 * U1[i].alpha2 + (RealType)(0.36841059262959 * dt) * dU.alpha2;
                U2[i].arho1  = (RealType)0.44437049406734 * U[i].arho1  + (RealType)0.55562950593266 * U1[i].arho1  + (RealType)(0.36841059262959 * dt) * dU.arho1;
                U2[i].arho2  = (RealType)0.44437049406734 * U[i].arho2  + (RealType)0.55562950593266 * U1[i].arho2  + (RealType)(0.36841059262959 * dt) * dU.arho2;
            }
        }
        updatePrimitiveFromConservative(U2, states2);
        if (cancel_flag && cancel_flag->load()) return;

        // Stage 3
        for (int i = 0; i < active_r_idx; ++i) {
            if (cancel_flag && cancel_flag->load()) return;
            ConservedState dU = computedUdt(U2, states2, i, dt);
            U3[i].rho  = (RealType)0.62010185138540 * U[i].rho  + (RealType)0.37989814861460 * U2[i].rho  + (RealType)(0.25189177424738 * dt) * dU.rho;
            U3[i].rhou = (RealType)0.62010185138540 * U[i].rhou + (RealType)0.37989814861460 * U2[i].rhou + (RealType)(0.25189177424738 * dt) * dU.rhou;
            U3[i].E    = (RealType)0.62010185138540 * U[i].E    + (RealType)0.37989814861460 * U2[i].E    + (RealType)(0.25189177424738 * dt) * dU.E;
            if constexpr (IsMultiMaterial) {
                U3[i].alpha1 = (RealType)0.62010185138540 * U[i].alpha1 + (RealType)0.37989814861460 * U2[i].alpha1 + (RealType)(0.25189177424738 * dt) * dU.alpha1;
                U3[i].alpha2 = (RealType)0.62010185138540 * U[i].alpha2 + (RealType)0.37989814861460 * U2[i].alpha2 + (RealType)(0.25189177424738 * dt) * dU.alpha2;
                U3[i].arho1  = (RealType)0.62010185138540 * U[i].arho1  + (RealType)0.37989814861460 * U2[i].arho1  + (RealType)(0.25189177424738 * dt) * dU.arho1;
                U3[i].arho2  = (RealType)0.62010185138540 * U[i].arho2  + (RealType)0.37989814861460 * U2[i].arho2  + (RealType)(0.25189177424738 * dt) * dU.arho2;
            }
        }
        updatePrimitiveFromConservative(U3, states3);
        if (cancel_flag && cancel_flag->load()) return;

        // Stage 4
        for (int i = 0; i < active_r_idx; ++i) {
            if (cancel_flag && cancel_flag->load()) return;
            ConservedState dU = computedUdt(U3, states3, i, dt);
            U4[i].rho  = (RealType)0.17807995410773 * U[i].rho  + (RealType)0.82192004589227 * U3[i].rho  + (RealType)(0.54468824602744 * dt) * dU.rho;
            U4[i].rhou = (RealType)0.17807995410773 * U[i].rhou + (RealType)0.82192004589227 * U3[i].rhou + (RealType)(0.54468824602744 * dt) * dU.rhou;
            U4[i].E    = (RealType)0.17807995410773 * U[i].E    + (RealType)0.82192004589227 * U3[i].E    + (RealType)(0.54468824602744 * dt) * dU.E;
            if constexpr (IsMultiMaterial) {
                U4[i].alpha1 = (RealType)0.17807995410773 * U[i].alpha1 + (RealType)0.82192004589227 * U3[i].alpha1 + (RealType)(0.54468824602744 * dt) * dU.alpha1;
                U4[i].alpha2 = (RealType)0.17807995410773 * U[i].alpha2 + (RealType)0.82192004589227 * U3[i].alpha2 + (RealType)(0.54468824602744 * dt) * dU.alpha2;
                U4[i].arho1  = (RealType)0.17807995410773 * U[i].arho1  + (RealType)0.82192004589227 * U3[i].arho1  + (RealType)(0.54468824602744 * dt) * dU.arho1;
                U4[i].arho2  = (RealType)0.17807995410773 * U[i].arho2  + (RealType)0.82192004589227 * U3[i].arho2  + (RealType)(0.54468824602744 * dt) * dU.arho2;
            }
        }
        updatePrimitiveFromConservative(U4, states4);
        if (cancel_flag && cancel_flag->load()) return;

        // Stage 5
        for (int i = 0; i < active_r_idx; ++i) {
            if (cancel_flag && cancel_flag->load()) return;
            ConservedState dU = computedUdt(U4, states4, i, dt);
            U[i].rho  = (RealType)0.00683325884039 * U[i].rho  + (RealType)0.51723167208978 * U2[i].rho  + (RealType)0.12759831133288 * U3[i].rho  + (RealType)0.34833675773694 * U4[i].rho  + (RealType)(0.22994065600216 * dt) * dU.rho;
            U[i].rhou = (RealType)0.00683325884039 * U[i].rhou + (RealType)0.51723167208978 * U2[i].rhou + (RealType)0.12759831133288 * U3[i].rhou + (RealType)0.34833675773694 * U4[i].rhou + (RealType)(0.22994065600216 * dt) * dU.rhou;
            U[i].E    = (RealType)0.00683325884039 * U[i].E    + (RealType)0.51723167208978 * U2[i].E    + (RealType)0.12759831133288 * U3[i].E    + (RealType)0.34833675773694 * U4[i].E    + (RealType)(0.22994065600216 * dt) * dU.E;
            if constexpr (IsMultiMaterial) {
                U[i].alpha1 = (RealType)0.00683325884039 * U[i].alpha1 + (RealType)0.51723167208978 * U2[i].alpha1 + (RealType)0.12759831133288 * U3[i].alpha1 + (RealType)0.34833675773694 * U4[i].alpha1 + (RealType)(0.22994065600216 * dt) * dU.alpha1;
                U[i].alpha2 = (RealType)0.00683325884039 * U[i].alpha2 + (RealType)0.51723167208978 * U2[i].alpha2 + (RealType)0.12759831133288 * U3[i].alpha2 + (RealType)0.34833675773694 * U4[i].alpha2 + (RealType)(0.22994065600216 * dt) * dU.alpha2;
                U[i].arho1  = (RealType)0.00683325884039 * U[i].arho1  + (RealType)0.51723167208978 * U2[i].arho1  + (RealType)0.12759831133288 * U3[i].arho1  + (RealType)0.34833675773694 * U4[i].arho1  + (RealType)(0.22994065600216 * dt) * dU.arho1;
                U[i].arho2  = (RealType)0.00683325884039 * U[i].arho2  + (RealType)0.51723167208978 * U2[i].arho2  + (RealType)0.12759831133288 * U3[i].arho2  + (RealType)0.34833675773694 * U4[i].arho2  + (RealType)(0.22994065600216 * dt) * dU.arho2;
            }
        }
    }

    updatePrimitiveFromConservative(U, states);

    applySourceTerms((RealType)(0.5 * dt), (RealType)(currentTime + 0.5 * dt));

    // Dynamic boundary tracking
    bool expand = false;
    int check_start = std::max(0, active_r_idx - 10);
    for (int i = check_start; i < active_r_idx; ++i) {
        if (std::abs(states[i].p - (RealType)ambient_p) / (RealType)ambient_p > (RealType)1e-4 || std::abs(states[i].u) > (RealType)1e-2) {
            expand = true;
            break;
        }
    }
    if (expand) {
        active_r_idx = std::min(n_cells, active_r_idx + 10);
    }

    currentTime += dt;
}

template <typename RealType, bool IsMultiMaterial>
double CFDSolverImpl<RealType, IsMultiMaterial>::computeStepSize(double cfl) const {
    RealType max_u_c = (RealType)1e-6;
    RealType max_p_ratio = (RealType)1.0;
    int limit = std::min(n_cells, active_r_idx + 2);

    for (int i = 0; i < limit; ++i) {
        RealType c = getSoundSpeed<RealType, IsMultiMaterial>(states[i].p, states[i].rho, states[i], (RealType)gamma, currentMaterials.products, currentMaterials.unreacted);
        RealType val = std::abs(states[i].u) + c;
        if (!std::isnan(val) && !std::isinf(val)) {
            max_u_c = std::max(max_u_c, val);
        }

        if (i > 0) {
            RealType p1 = std::max(states[i].p, (RealType)1e-10);
            RealType p0 = std::max(states[i-1].p, (RealType)1e-10);
            RealType ratio = std::max(p1, p0) / std::min(p1, p0);
            if (!std::isnan(ratio) && !std::isinf(ratio)) {
                max_p_ratio = std::max(max_p_ratio, ratio);
            }
        }
    }

    double order_factor = 1.0;
    if (spatialOrder == 2) order_factor = 0.8;
    else if (spatialOrder >= 3) order_factor = 0.4;

    double dynamic_cfl = cfl * order_factor;

    return dynamic_cfl * dr / (double)max_u_c;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolverImpl<RealType, IsMultiMaterial>::run(double duration) {
    double elapsed = 0;
    while (elapsed < duration) {
        double dt = computeStepSize(0.4);
        double step_dt = std::min(dt, duration - elapsed);
        step(step_dt);
        elapsed += step_dt;
    }
}

template <typename RealType, bool IsMultiMaterial>
std::vector<double> CFDSolverImpl<RealType, IsMultiMaterial>::getLocalTimesteps(double cfl) const {
    std::vector<double> dt_local(n_cells, 0.0);
    RealType max_p_ratio = (RealType)1.0;
    int limit = std::min(n_cells, active_r_idx + 2);

    for (int i = 0; i < limit; ++i) {
        if (i > 0) {
            RealType p1 = std::max(states[i].p, (RealType)1e-10);
            RealType p0 = std::max(states[i-1].p, (RealType)1e-10);
            RealType ratio = std::max(p1, p0) / std::min(p1, p0);
            if (!std::isnan(ratio) && !std::isinf(ratio)) {
                max_p_ratio = std::max(max_p_ratio, ratio);
            }
        }
    }

    double order_factor = 1.0;
    if (spatialOrder == 2) order_factor = 0.8;
    else if (spatialOrder >= 3) order_factor = 0.4;

    double dynamic_cfl = cfl * order_factor;

    for (int i = 0; i < n_cells; ++i) {
        RealType c = getSoundSpeed<RealType, IsMultiMaterial>(states[i].p, states[i].rho, states[i], (RealType)gamma, currentMaterials.products, currentMaterials.unreacted);
        RealType denom = std::abs(states[i].u) + c;
        if (denom < (RealType)1e-6) denom = (RealType)1e-6;
        dt_local[i] = dynamic_cfl * dr / (double)denom;
    }
    return dt_local;
}

template <typename RealType, bool IsMultiMaterial>
std::vector<float> CFDSolverImpl<RealType, IsMultiMaterial>::getTelemetryChannels() const {
    const uint32_t n = n_cells;
    const uint32_t n_channels = 7;
    std::vector<float> frame;
    frame.reserve(n * n_channels);

    // Channel 0: Pressure
    for (uint32_t i = 0; i < n; ++i) frame.push_back(static_cast<float>(states[i].p));
    // Channel 1: Density
    for (uint32_t i = 0; i < n; ++i) frame.push_back(static_cast<float>(states[i].rho));
    // Channel 2: Velocity
    for (uint32_t i = 0; i < n; ++i) frame.push_back(static_cast<float>(states[i].u));
    // Channel 3: Specific internal energy
    for (uint32_t i = 0; i < n; ++i) {
        RealType rho = states[i].rho;
        RealType e_int = (rho > (RealType)0.0) ? (states[i].E / rho - (RealType)0.5 * states[i].u * states[i].u) : (RealType)0.0;
        frame.push_back(static_cast<float>(e_int));
    }
    // Channel 4: Volume Fraction (burned products)
    for (uint32_t i = 0; i < n; ++i) {
        if constexpr (IsMultiMaterial) {
            frame.push_back(static_cast<float>(std::clamp((double)states[i].alpha1, 0.0, 1.0)));
        } else {
            frame.push_back(0.0f);
        }
    }
    // Channel 5: Volume Fraction (unburnt reactant)
    for (uint32_t i = 0; i < n; ++i) {
        if constexpr (IsMultiMaterial) {
            frame.push_back(static_cast<float>(std::clamp((double)states[i].alpha2, 0.0, 1.0)));
        } else {
            frame.push_back(0.0f);
        }
    }
    // Channel 6: Volume Fraction (air)
    for (uint32_t i = 0; i < n; ++i) {
        if constexpr (IsMultiMaterial) {
            RealType air_frac = (RealType)1.0 - states[i].alpha1 - states[i].alpha2;
            frame.push_back(static_cast<float>(std::clamp((double)air_frac, 0.0, 1.0)));
        } else {
            frame.push_back(1.0f);
        }
    }

    return frame;
}

template <typename RealType, bool IsMultiMaterial>
std::vector<float> CFDSolverImpl<RealType, IsMultiMaterial>::getCellValues(int i) const {
    std::vector<float> vals(7, 0.0f);
    if (i < 0 || i >= n_cells) return vals;
    
    const auto& s = states[i];
    vals[0] = static_cast<float>(s.p);
    vals[1] = static_cast<float>(s.rho);
    vals[2] = static_cast<float>(s.u);
    
    RealType e_int = (s.rho > (RealType)0.0) ? (s.E / s.rho - (RealType)0.5 * s.u * s.u) : (RealType)0.0;
    vals[3] = static_cast<float>(e_int);
    
    if constexpr (IsMultiMaterial) {
        vals[4] = static_cast<float>(std::clamp((double)s.alpha1, 0.0, 1.0));
        vals[5] = static_cast<float>(std::clamp((double)s.alpha2, 0.0, 1.0));
        RealType air_frac = (RealType)1.0 - s.alpha1 - s.alpha2;
        vals[6] = static_cast<float>(std::clamp((double)air_frac, 0.0, 1.0));
    } else {
        vals[4] = 0.0f;
        vals[5] = 0.0f;
        vals[6] = 1.0f;
    }
    return vals;
}
