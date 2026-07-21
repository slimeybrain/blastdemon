#ifndef CFD_2D_MATH_KERNELS_HPP
#define CFD_2D_MATH_KERNELS_HPP

#include "materials.hpp"
#include <cmath>
#include <algorithm>

template <typename RealType>
struct CellState2DT {
    RealType rho;
    RealType ur;
    RealType uz;
    RealType p;
    RealType E;
    RealType alpha1;
    RealType alpha2;
    RealType arho1;
    RealType arho2;
};

template <typename RealType>
struct ConservativeState2DT {
    RealType rho;
    RealType rhour;
    RealType rhouz;
    RealType E;
    RealType alpha1;
    RealType alpha2;
    RealType arho1;
    RealType arho2;
};

template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
inline RealType minmod_kernel(RealType a, RealType b) {
    using std::abs;
    if (a * b <= (RealType)0.0) return (RealType)0.0;
    return (abs(a) < abs(b)) ? a : b;
}

template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
inline RealType weno3_kernel(RealType qm1, RealType q0, RealType qp1) {
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

template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
inline void compute_E_kernel(CellState2DT<RealType>& s, RealType gamma, const MultiMat::MaterialSet& mat, bool is_ideal_gas) {
    if (s.rho < (RealType)1e-10 || s.p < (RealType)1e-10) return;
    if (is_ideal_gas) {
        s.E = s.p / (gamma - (RealType)1.0) + (RealType)0.5 * s.rho * (s.ur * s.ur + s.uz * s.uz);
    } else {
        s.E = MultiMat::getMixtureEnergy(s.p, s.rho, s.alpha1, s.alpha2, s.arho1, s.arho2, gamma, mat.products, mat.unreacted) + (RealType)0.5 * s.rho * (s.ur * s.ur + s.uz * s.uz);
    }
}

template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
inline void calcFluxRusanov_kernel(const CellState2DT<RealType>& sL, const CellState2DT<RealType>& sR, RealType gamma, const MultiMat::MaterialSet& mat, 
                                   RealType& f_rho, RealType& f_rhour, RealType& f_rhouz, RealType& f_E, 
                                   RealType& f_alpha1, RealType& f_alpha2, RealType& f_arho1, RealType& f_arho2, RealType& v_face, bool is_ideal_gas) {
    using std::abs;
    using std::max;
    RealType cL, cR;
    RealType rhoL_safe = max(sL.rho, (RealType)1e-8);
    RealType rhoR_safe = max(sR.rho, (RealType)1e-8);
    RealType pL_safe = max(sL.p, (RealType)1e-8);
    RealType pR_safe = max(sR.p, (RealType)1e-8);

    if (is_ideal_gas) {
        cL = std::sqrt(gamma * pL_safe / rhoL_safe);
        cR = std::sqrt(gamma * pR_safe / rhoR_safe);
    } else {
        cL = MultiMat::getMixtureSoundSpeed(pL_safe, rhoL_safe, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, gamma, mat.products, mat.unreacted);
        cR = MultiMat::getMixtureSoundSpeed(pR_safe, rhoR_safe, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, gamma, mat.products, mat.unreacted);
    }
    RealType s_max = max(abs(sL.ur) + cL, abs(sR.ur) + cR);

    RealType fL_rho = sL.rho * sL.ur;
    RealType fL_rhour = sL.rho * sL.ur * sL.ur + sL.p;
    RealType fL_rhouz = sL.rho * sL.ur * sL.uz;
    RealType fL_E = sL.ur * (sL.E + sL.p);
    
    RealType fR_rho = sR.rho * sR.ur;
    RealType fR_rhour = sR.rho * sR.ur * sR.ur + sR.p;
    RealType fR_rhouz = sR.rho * sR.ur * sR.uz;
    RealType fR_E = sR.ur * (sR.E + sR.p);

    RealType uL_rho = sL.rho, uL_rhour = sL.rho * sL.ur, uL_rhouz = sL.rho * sL.uz, uL_E = sL.E;
    RealType uR_rho = sR.rho, uR_rhour = sR.rho * sR.ur, uR_rhouz = sR.rho * sR.uz, uR_E = sR.E;

    f_rho = (RealType)0.5 * (fL_rho + fR_rho) - (RealType)0.5 * s_max * (uR_rho - uL_rho);
    f_rhour = (RealType)0.5 * (fL_rhour + fR_rhour) - (RealType)0.5 * s_max * (uR_rhour - uL_rhour);
    f_rhouz = (RealType)0.5 * (fL_rhouz + fR_rhouz) - (RealType)0.5 * s_max * (uR_rhouz - uL_rhouz);
    f_E = (RealType)0.5 * (fL_E + fR_E) - (RealType)0.5 * s_max * (uR_E - uL_E);

    v_face = (RealType)0.5 * (sL.ur + sR.ur);

    f_alpha1 = (RealType)0.5 * (sL.alpha1 * sL.ur + sR.alpha1 * sR.ur) - (RealType)0.5 * s_max * (sR.alpha1 - sL.alpha1);
    f_alpha2 = (RealType)0.5 * (sL.alpha2 * sL.ur + sR.alpha2 * sR.ur) - (RealType)0.5 * s_max * (sR.alpha2 - sL.alpha2);
    f_arho1 = (RealType)0.5 * (sL.arho1 * sL.ur + sR.arho1 * sR.ur) - (RealType)0.5 * s_max * (sR.arho1 - sL.arho1);
    f_arho2 = (RealType)0.5 * (sL.arho2 * sL.ur + sR.arho2 * sR.ur) - (RealType)0.5 * s_max * (sR.arho2 - sL.arho2);
}

template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
inline void calcFluxRusanovZ_kernel(const CellState2DT<RealType>& sL, const CellState2DT<RealType>& sR, RealType gamma, const MultiMat::MaterialSet& mat, 
                                    RealType& f_rho, RealType& f_rhour, RealType& f_rhouz, RealType& f_E, 
                                    RealType& f_alpha1, RealType& f_alpha2, RealType& f_arho1, RealType& f_arho2, RealType& v_face, bool is_ideal_gas) {
    using std::abs;
    using std::max;
    RealType cL, cR;
    RealType rhoL_safe = max(sL.rho, (RealType)1e-8);
    RealType rhoR_safe = max(sR.rho, (RealType)1e-8);
    RealType pL_safe = max(sL.p, (RealType)1e-8);
    RealType pR_safe = max(sR.p, (RealType)1e-8);

    if (is_ideal_gas) {
        cL = std::sqrt(gamma * pL_safe / rhoL_safe);
        cR = std::sqrt(gamma * pR_safe / rhoR_safe);
    } else {
        cL = MultiMat::getMixtureSoundSpeed(pL_safe, rhoL_safe, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, gamma, mat.products, mat.unreacted);
        cR = MultiMat::getMixtureSoundSpeed(pR_safe, rhoR_safe, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, gamma, mat.products, mat.unreacted);
    }
    RealType s_max = max(abs(sL.uz) + cL, abs(sR.uz) + cR);

    RealType fL_rho = sL.rho * sL.uz;
    RealType fL_rhour = sL.rho * sL.ur * sL.uz;
    RealType fL_rhouz = sL.rho * sL.uz * sL.uz + sL.p;
    RealType fL_E = sL.uz * (sL.E + sL.p);
    
    RealType fR_rho = sR.rho * sR.uz;
    RealType fR_rhour = sR.rho * sR.ur * sR.uz;
    RealType fR_rhouz = sR.rho * sR.uz * sR.uz + sR.p;
    RealType fR_E = sR.uz * (sR.E + sR.p);

    RealType uL_rho = sL.rho, uL_rhour = sL.rho * sL.ur, uL_rhouz = sL.rho * sL.uz, uL_E = sL.E;
    RealType uR_rho = sR.rho, uR_rhour = sR.rho * sR.ur, uR_rhouz = sR.rho * sR.uz, uR_E = sR.E;

    f_rho = (RealType)0.5 * (fL_rho + fR_rho) - (RealType)0.5 * s_max * (uR_rho - uL_rho);
    f_rhour = (RealType)0.5 * (fL_rhour + fR_rhour) - (RealType)0.5 * s_max * (uR_rhour - uL_rhour);
    f_rhouz = (RealType)0.5 * (fL_rhouz + fR_rhouz) - (RealType)0.5 * s_max * (uR_rhouz - uL_rhouz);
    f_E = (RealType)0.5 * (fL_E + fR_E) - (RealType)0.5 * s_max * (uR_E - uL_E);

    v_face = (RealType)0.5 * (sL.uz + sR.uz);

    f_alpha1 = (RealType)0.5 * (sL.alpha1 * sL.uz + sR.alpha1 * sR.uz) - (RealType)0.5 * s_max * (sR.alpha1 - sL.alpha1);
    f_alpha2 = (RealType)0.5 * (sL.alpha2 * sL.uz + sR.alpha2 * sR.uz) - (RealType)0.5 * s_max * (sR.alpha2 - sL.alpha2);
    f_arho1 = (RealType)0.5 * (sL.arho1 * sL.uz + sR.arho1 * sR.uz) - (RealType)0.5 * s_max * (sR.arho1 - sL.arho1);
    f_arho2 = (RealType)0.5 * (sL.arho2 * sL.uz + sR.arho2 * sR.uz) - (RealType)0.5 * s_max * (sR.arho2 - sL.arho2);
}

template <typename RealType>
#ifdef __CUDACC__
__host__ __device__
#endif
inline CellState2DT<RealType> applyBC_AMR_kernel(CellState2DT<RealType> s, int bc, RealType normal_vel, RealType ambient_rho, RealType ambient_p, RealType gamma, const MultiMat::MaterialSet& mat, bool is_ideal_gas, bool is_r_axis) {
    if (bc == 0) { // REFLECTIVE
        if (is_r_axis) s.ur = -s.ur;
        else s.uz = -s.uz;
    } else if (bc == 1) { // TRANSMISSIVE
        // zero gradient
    } else if (bc == 2) { // OUTFLOW_RIEMANN
        using std::max;
        RealType rho_safe = max(s.rho, (RealType)1e-8);
        RealType p_safe = max(s.p, (RealType)1e-8);
        RealType c;
        if (is_ideal_gas) {
            c = std::sqrt(gamma * p_safe / rho_safe);
        } else {
            c = MultiMat::getMixtureSoundSpeed(p_safe, rho_safe, s.alpha1, s.alpha2, s.arho1, s.arho2, gamma, mat.products, mat.unreacted);
        }
        if (normal_vel < (RealType)0.0) {
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
            s.p = ambient_p;
            compute_E_kernel(s, gamma, mat, is_ideal_gas);
        }
    }
    return s;
}

#endif // CFD_2D_MATH_KERNELS_HPP
