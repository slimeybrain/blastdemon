#include "cfd_solver.hpp"
#include <cmath>
#include <algorithm>
#include <array>

template <typename RealType, bool IsMultiMaterial>
inline RealType getPressure(RealType E_internal, RealType rho, const typename StateTypes<RealType, IsMultiMaterial>::PrimitiveState& s, RealType gamma, const MultiMat::JWLParams& products, const MultiMat::JWLParams& unreacted) {
    if constexpr (IsMultiMaterial) {
        return (RealType)MultiMat::getMixturePressure(E_internal, rho, s.alpha1, s.alpha2, s.arho1, s.arho2, gamma, products, unreacted);
    } else {
        return E_internal * (gamma - (RealType)1.0);
    }
}

template <typename RealType, bool IsMultiMaterial>
inline RealType getSoundSpeed(RealType p, RealType rho, const typename StateTypes<RealType, IsMultiMaterial>::PrimitiveState& s, RealType gamma, const MultiMat::JWLParams& products, const MultiMat::JWLParams& unreacted) {
    if constexpr (IsMultiMaterial) {
        return (RealType)MultiMat::getMixtureSoundSpeed(p, rho, s.alpha1, s.alpha2, s.arho1, s.arho2, gamma, products, unreacted);
    } else {
        return std::sqrt(gamma * p / rho);
    }
}

template <typename RealType, bool IsMultiMaterial>
inline RealType getEnergy(RealType p, RealType rho, const typename StateTypes<RealType, IsMultiMaterial>::PrimitiveState& s, RealType gamma, const MultiMat::JWLParams& products, const MultiMat::JWLParams& unreacted) {
    if constexpr (IsMultiMaterial) {
        return (RealType)MultiMat::getMixtureEnergy(p, rho, s.alpha1, s.alpha2, s.arho1, s.arho2, gamma, products, unreacted);
    } else {
        return p / (gamma - (RealType)1.0);
    }
}

template <typename RealType, bool IsMultiMaterial>
typename CFDSolverImpl<RealType, IsMultiMaterial>::ConservedState CFDSolverImpl<RealType, IsMultiMaterial>::flux(const PrimitiveState& s) {
    ConservedState f;
    f.rho = s.rho * s.u;
    f.rhou = s.rho * s.u * s.u + s.p;
    f.E = s.u * (s.E + s.p);
    if constexpr (IsMultiMaterial) {
        f.alpha1 = s.alpha1 * s.u; f.alpha2 = s.alpha2 * s.u;
        f.arho1 = s.arho1 * s.u; f.arho2 = s.arho2 * s.u;
    }
    return f;
}

template <typename RealType, bool IsMultiMaterial>
typename CFDSolverImpl<RealType, IsMultiMaterial>::ConservedState CFDSolverImpl<RealType, IsMultiMaterial>::getFlux(const PrimitiveState& sL, const PrimitiveState& sR, const ConservedState& uL, const ConservedState& uR, double dt, double& v_face) {
    ConservedState f;
    if (currentScheme == AUSM_PLUS) {
        f = getFluxAUSMPlus(sL, sR, v_face);
    } else {
        f = getFluxRusanov(sL, sR, uL, uR, v_face);
    }
    return f;
}

template <typename RealType, bool IsMultiMaterial>
typename CFDSolverImpl<RealType, IsMultiMaterial>::ConservedState CFDSolverImpl<RealType, IsMultiMaterial>::getFluxRusanov(const PrimitiveState& sL, const PrimitiveState& sR, const ConservedState& uL, const ConservedState& uR, double& v_face) {
    ConservedState fL = flux(sL);
    ConservedState fR = flux(sR);

    RealType cL = getSoundSpeed<RealType, IsMultiMaterial>(sL.p, sL.rho, sL, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted);
    RealType cR = getSoundSpeed<RealType, IsMultiMaterial>(sR.p, sR.rho, sR, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted);
    RealType s_max = std::max(std::abs(sL.u) + cL, std::abs(sR.u) + cR);

    ConservedState f;
    f.rho  = 0.5 * (fL.rho + fR.rho)   - 0.5 * s_max * (uR.rho - uL.rho);
    f.rhou = 0.5 * (fL.rhou + fR.rhou) - 0.5 * s_max * (uR.rhou - uL.rhou);
    f.E    = 0.5 * (fL.E + fR.E)       - 0.5 * s_max * (uR.E - uL.E);

    // Mass Fraction Consistency
    RealType u_int = 0.5 * (sL.u + sR.u);
    v_face = (double)u_int;
    if constexpr (IsMultiMaterial) {
        if (u_int >= 0) {
            f.alpha1 = sL.alpha1 * u_int;
            f.alpha2 = sL.alpha2 * u_int;
            RealType Y1 = sL.arho1 / fmax((RealType)1e-12, sL.rho);
            RealType Y2 = sL.arho2 / fmax((RealType)1e-12, sL.rho);
            f.arho1 = f.rho * Y1;
            f.arho2 = f.rho * Y2;
        } else {
            f.alpha1 = sR.alpha1 * u_int;
            f.alpha2 = sR.alpha2 * u_int;
            RealType Y1 = sR.arho1 / fmax((RealType)1e-12, sR.rho);
            RealType Y2 = sR.arho2 / fmax((RealType)1e-12, sR.rho);
            f.arho1 = f.rho * Y1;
            f.arho2 = f.rho * Y2;
        }
    }
    return f;
}

template <typename RealType, bool IsMultiMaterial>
typename CFDSolverImpl<RealType, IsMultiMaterial>::ConservedState CFDSolverImpl<RealType, IsMultiMaterial>::getFluxAUSMPlus(const PrimitiveState& sL, const PrimitiveState& sR, double& v_face) {
    RealType aL = getSoundSpeed<RealType, IsMultiMaterial>(sL.p, sL.rho, sL, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted);
    RealType aR = getSoundSpeed<RealType, IsMultiMaterial>(sR.p, sR.rho, sR, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted);
    RealType a_half = 0.5 * (aL + aR);

    RealType ML = sL.u / a_half;
    RealType MR = sR.u / a_half;

    RealType alpha = 3.0 / 16.0;
    RealType beta = 1.0 / 8.0;

    auto get_M_plus = [beta](RealType M) -> RealType {
        if (std::abs(M) <= 1.0) {
            RealType term = 0.25 * (M + 1.0) * (M + 1.0);
            return term + beta * (M * M - 1.0) * (M * M - 1.0);
        } else {
            return 0.5 * (M + std::abs(M));
        }
    };

    auto get_M_minus = [beta](RealType M) -> RealType {
        if (std::abs(M) <= 1.0) {
            RealType term = -0.25 * (M - 1.0) * (M - 1.0);
            return term - beta * (M * M - 1.0) * (M * M - 1.0);
        } else {
            return 0.5 * (M - std::abs(M));
        }
    };

    auto get_P_plus = [alpha](RealType M) -> RealType {
        if (std::abs(M) <= 1.0) {
            RealType term = 0.25 * (M + 1.0) * (M + 1.0) * (2.0 - M);
            return term + alpha * M * (M * M - 1.0) * (M * M - 1.0);
        } else {
            return (M >= 0.0) ? (RealType)1.0 : (RealType)0.0;
        }
    };

    auto get_P_minus = [alpha](RealType M) -> RealType {
        if (std::abs(M) <= 1.0) {
            RealType term = 0.25 * (M - 1.0) * (M - 1.0) * (2.0 + M);
            return term - alpha * M * (M * M - 1.0) * (M * M - 1.0);
        } else {
            return (M < 0.0) ? (RealType)1.0 : (RealType)0.0;
        }
    };

    RealType M_half = get_M_plus(ML) + get_M_minus(MR);
    RealType p_half = get_P_plus(ML) * sL.p + get_P_minus(MR) * sR.p;

    v_face = (double)(M_half * a_half);

    ConservedState F;
    if (M_half >= 0.0) {
        F.rho  = M_half * a_half * sL.rho;
        F.rhou = M_half * a_half * sL.rho * sL.u + p_half;
        F.E    = M_half * a_half * (sL.E + sL.p);
        if constexpr (IsMultiMaterial) {
            F.alpha1 = M_half * a_half * sL.alpha1;
            F.alpha2 = M_half * a_half * sL.alpha2;
            F.arho1 = M_half * a_half * sL.arho1;
            F.arho2 = M_half * a_half * sL.arho2;
        }
    } else {
        F.rho  = M_half * a_half * sR.rho;
        F.rhou = M_half * a_half * sR.rho * sR.u + p_half;
        F.E    = M_half * a_half * (sR.E + sR.p);
        if constexpr (IsMultiMaterial) {
            F.alpha1 = M_half * a_half * sR.alpha1;
            F.alpha2 = M_half * a_half * sR.alpha2;
            F.arho1 = M_half * a_half * sR.arho1;
            F.arho2 = M_half * a_half * sR.arho2;
        }
    }

    // Robust Entropy Fix (Harten entropy fix for expansion shocks)
    RealType cL = getSoundSpeed<RealType, IsMultiMaterial>(sL.p, sL.rho, sL, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted);
    RealType cR = getSoundSpeed<RealType, IsMultiMaterial>(sR.p, sR.rho, sR, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted);

    RealType lambda_L = sL.u - cL;
    RealType lambda_R = sR.u - cR;

    ConservedState uL, uR;
    uL.rho = sL.rho; uL.rhou = sL.rho * sL.u; uL.E = sL.E;
    uR.rho = sR.rho; uR.rhou = sR.rho * sR.u; uR.E = sR.E;
    if constexpr (IsMultiMaterial) {
        uL.arho1 = sL.arho1; uL.arho2 = sL.arho2;
        uR.arho1 = sR.arho1; uR.arho2 = sR.arho2;
    }

    // Left-going acoustic wave: u - c crosses zero (rarefaction fan)
    if (lambda_L < 0.0 && lambda_R > 0.0) {
        RealType dlambda = lambda_R - lambda_L;
        RealType diss = dlambda > 0 ? (dlambda * dlambda) / (4.0 * dlambda) : 0.0; // Proper Harten fix

        F.rho   -= diss * (uR.rho   - uL.rho);
        F.rhou  -= diss * (uR.rhou  - uL.rhou);
        F.E     -= diss * (uR.E     - uL.E);
        if constexpr (IsMultiMaterial) {
            F.arho1 -= diss * (uR.arho1 - uL.arho1);
            F.arho2 -= diss * (uR.arho2 - uL.arho2);
        }
    }

    // Right-going acoustic wave: u + c crosses zero
    RealType lambda_plus_L = sL.u + cL;
    RealType lambda_plus_R = sR.u + cR;
    if (lambda_plus_L < 0.0 && lambda_plus_R > 0.0) {
        RealType dlambda = lambda_plus_R - lambda_plus_L;
        RealType diss = dlambda > 0 ? (dlambda * dlambda) / (4.0 * dlambda) : 0.0;

        F.rho   -= diss * (uR.rho   - uL.rho);
        F.rhou  -= diss * (uR.rhou  - uL.rhou);
        F.E     -= diss * (uR.E     - uL.E);
        if constexpr (IsMultiMaterial) {
            F.arho1 -= diss * (uR.arho1 - uL.arho1);
            F.arho2 -= diss * (uR.arho2 - uL.arho2);
        }
    }

    return F;
}

template <typename RealType, bool IsMultiMaterial>
void CFDSolverImpl<RealType, IsMultiMaterial>::reconstruct(const std::vector<PrimitiveState>& states_current, int i, PrimitiveState& s_L, PrimitiveState& s_R, double dt) {
    auto minmod = [](RealType a, RealType b) {
        if (a * b <= 0) return (RealType)0.0;
        return (std::abs(a) < std::abs(b)) ? a : b;
    };

    auto mc = [](RealType a, RealType b) {
        if (a * b <= 0) return (RealType)0.0;
        RealType c = 0.5 * (a + b);
        RealType s1 = std::min(std::abs(c), (RealType)2.0 * std::abs(a));
        RealType s2 = std::min(s1, (RealType)2.0 * std::abs(b));
        return (a > 0) ? s2 : -s2;
    };

    auto get_state = [&](int idx) {
        if (idx < 0) {
            PrimitiveState s = states_current[-idx]; // Fix ghost cell reflecting index
            s.u = -s.u;
            return s;
        }
        if (idx >= n_cells) return states_current[n_cells - 1];
        return states_current[idx];
    };

    constexpr size_t num_eq = IsMultiMaterial ? 7 : 3;
    using DiffArray = std::array<RealType, num_eq>;

    auto diff = [](const PrimitiveState& a, const PrimitiveState& b) {
        DiffArray d;
        d[0] = a.rho - b.rho;
        d[1] = a.u - b.u;
        d[2] = a.p - b.p;
        if constexpr (IsMultiMaterial) {
            d[3] = a.alpha1 - b.alpha1;
            d[4] = a.alpha2 - b.alpha2;
            d[5] = a.arho1 - b.arho1;
            d[6] = a.arho2 - b.arho2;
        }
        return d;
    };

    auto project_to_char = [](const PrimitiveState& ref, RealType c, const DiffArray& dV) {
        DiffArray dW;
        dW[0] = dV[0] - dV[2] / (c * c);
        dW[1] = dV[1] + dV[2] / (ref.rho * c);
        dW[2] = dV[1] - dV[2] / (ref.rho * c);
        if constexpr (IsMultiMaterial) {
            dW[3] = dV[3]; dW[4] = dV[4]; dW[5] = dV[5]; dW[6] = dV[6];
        }
        return dW;
    };

    auto project_to_prim = [](const PrimitiveState& ref, RealType c, const DiffArray& dW) {
        DiffArray dV;
        dV[2] = 0.5 * ref.rho * c * (dW[1] - dW[2]); // dp
        dV[1] = 0.5 * (dW[1] + dW[2]); // du
        dV[0] = dW[0] + dV[2] / (c * c); // drho
        if constexpr (IsMultiMaterial) {
            dV[3] = dW[3]; dV[4] = dW[4]; dV[5] = dW[5]; dV[6] = dW[6];
        }
        return dV;
    };

    if (spatialOrder == 1) {
        s_L = get_state(i - 1);
        s_R = get_state(i);
    } else if (spatialOrder >= 2) { // Use MUSCL for both 2nd and 3rd order for robustness
        bool near_shock = false;
        // Stronger shock detector (Ducros-like compression + pressure ratio)
        for (int j = std::max(1, i - 2); j <= std::min(n_cells - 1, i + 1); ++j) {
            RealType pmax = std::max(states_current[j].p, states_current[j-1].p);
            RealType pmin = std::min(states_current[j].p, states_current[j-1].p);
            RealType div_u = states_current[j].u - states_current[j-1].u;
            if (pmin > 0 && pmax > 5.0 * pmin && div_u < 0) { near_shock = true; break; }
        }

        auto limiter = [&](RealType a, RealType b) -> RealType {
            return near_shock ? minmod(a, b) : mc(a, b);
        };

        PrimitiveState sm1 = get_state(i - 2);
        PrimitiveState s0  = get_state(i - 1);
        PrimitiveState sp1 = get_state(i);
        PrimitiveState sp2 = get_state(i + 1);

        // Reconstruction in cell i-1 (for s_L)
        RealType c0 = getSoundSpeed<RealType, IsMultiMaterial>(s0.p, s0.rho, s0, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted);
        auto dV_m1 = diff(s0, sm1);
        auto dV_0  = diff(sp1, s0);
        auto dW_m1 = project_to_char(s0, c0, dV_m1);
        auto dW_0  = project_to_char(s0, c0, dV_0);
        DiffArray dW_L;
        for(size_t k=0; k<num_eq; ++k) dW_L[k] = limiter(dW_m1[k], dW_0[k]);
        auto dV_L = project_to_prim(s0, c0, dW_L);

        s_L = s0;
        s_L.rho += 0.5 * dV_L[0]; s_L.u += 0.5 * dV_L[1]; s_L.p += 0.5 * dV_L[2];
        if constexpr (IsMultiMaterial) {
            s_L.alpha1 += 0.5 * dV_L[3]; s_L.alpha2 += 0.5 * dV_L[4];
            s_L.arho1 += 0.5 * dV_L[5]; s_L.arho2 += 0.5 * dV_L[6];
        }

        // Reconstruction in cell i (for s_R)
        RealType cp1 = getSoundSpeed<RealType, IsMultiMaterial>(sp1.p, sp1.rho, sp1, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted);
        auto dV_p1 = diff(sp2, sp1);
        auto dW_p1 = project_to_char(sp1, cp1, dV_p1);
        auto dW_0_R  = project_to_char(sp1, cp1, dV_0);
        DiffArray dW_R;
        for(size_t k=0; k<num_eq; ++k) dW_R[k] = limiter(dW_0_R[k], dW_p1[k]);
        auto dV_R = project_to_prim(sp1, cp1, dW_R);

        s_R = sp1;
        s_R.rho -= 0.5 * dV_R[0]; s_R.u -= 0.5 * dV_R[1]; s_R.p -= 0.5 * dV_R[2];
        if constexpr (IsMultiMaterial) {
            s_R.alpha1 -= 0.5 * dV_R[3]; s_R.alpha2 -= 0.5 * dV_R[4];
            s_R.arho1 -= 0.5 * dV_R[5]; s_R.arho2 -= 0.5 * dV_R[6];
        }

        // Clamp reconstructed volume fractions
        if constexpr (IsMultiMaterial) {
            s_L.alpha1 = fmax((RealType)0.0, fmin((RealType)1.0, s_L.alpha1));
            s_L.alpha2 = fmax((RealType)0.0, fmin((RealType)1.0, s_L.alpha2));
            s_R.alpha1 = fmax((RealType)0.0, fmin((RealType)1.0, s_R.alpha1));
            s_R.alpha2 = fmax((RealType)0.0, fmin((RealType)1.0, s_R.alpha2));
        }

        if (s_L.rho < 1e-10 || s_L.p < 1e-10 || s_R.rho < 1e-10 || s_R.p < 1e-10) {
            s_L = states_current[i-1];
            s_R = states_current[i];
        } else {
            s_L.E = getEnergy<RealType, IsMultiMaterial>(s_L.p, s_L.rho, s_L, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted) + 0.5 * s_L.rho * s_L.u * s_L.u;
            s_R.E = getEnergy<RealType, IsMultiMaterial>(s_R.p, s_R.rho, s_R, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted) + 0.5 * s_R.rho * s_R.u * s_R.u;
        }
    }
}
