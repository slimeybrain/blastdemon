#include "cfd_solver_2d_cuda.hpp"
#include "VTKWriter.hpp"
#include <omp.h>
#include <cuda_runtime.h>
#include <iostream>
#include <cmath>
#include <algorithm>
#include <thrust/reduce.h>
#include <thrust/device_ptr.h>

#define CUDA_CHECK(call) \
    do { \
        cudaError_t err = call; \
        if (err != cudaSuccess) { \
            std::cerr << "CUDA Error at " << __FILE__ << ":" << __LINE__ << " - " << cudaGetErrorString(err) << std::endl; \
            exit(EXIT_FAILURE); \
        } \
    } while (0)

template <typename RealType>
struct CellStateT {
    RealType rho, ur, uz, p, E, alpha1, alpha2, arho1, arho2;
};

template <typename RealType>
__device__ inline void compute_E_device(CellStateT<RealType>& s, RealType gamma, const MultiMat::MaterialSet* d_materials, bool is_ideal_gas) {
    if (s.rho < (RealType)1e-10 || s.p < (RealType)1e-10) return;
    if (is_ideal_gas) {
        s.E = s.p / (gamma - (RealType)1.0) + (RealType)0.5 * s.rho * (s.ur * s.ur + s.uz * s.uz);
    } else {
        s.E = MultiMat::getMixtureEnergy(s.p, s.rho, s.alpha1, s.alpha2, s.arho1, s.arho2, gamma, d_materials->products, d_materials->unreacted) + (RealType)0.5 * s.rho * (s.ur * s.ur + s.uz * s.uz);
    }
}

template <typename RealType>
__device__ inline CellStateT<RealType> applyBC_device(CellStateT<RealType> s, int bc, RealType normal_vel, RealType ambient_rho, RealType ambient_p, RealType gamma, const MultiMat::MaterialSet* d_materials, bool is_ideal_gas, bool is_r_axis) {
    if (bc == 0) { // REFLECTIVE is 0
        if (is_r_axis) {
            s.ur = -s.ur;
        } else {
            s.uz = -s.uz;
        }
    } else if (bc == 1) { // TRANSMISSIVE is 1
        // Zero-gradient: copy directly, do nothing
    } else if (bc == 2) { // OUTFLOW_RIEMANN is 2
        RealType c;
        if (is_ideal_gas) {
            c = sqrt(gamma * s.p / s.rho);
        } else {
            c = MultiMat::getMixtureSoundSpeed(s.p, s.rho, s.alpha1, s.alpha2, s.arho1, s.arho2, gamma, d_materials->products, d_materials->unreacted);
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
            compute_E_device(s, gamma, d_materials, is_ideal_gas);
        }
        // Supersonic outflow (extrapolate as is)
    }
    return s;
}

template <typename RealType>
__device__ inline CellStateT<RealType> readState_device(
    const int32_t* tile_map, const PrimitiveTileT<RealType>* states_pool, 
    int i, int j, int nr_cells, int nz_cells, int num_tiles_z,
    RealType ambient_rho, RealType ambient_p, RealType gamma,
    int bcRmin, int bcRmax, int bcZmin, int bcZmax,
    const MultiMat::MaterialSet* d_materials, bool is_ideal_gas) {
    
    bool is_outside_i = false;
    bool is_outside_j = false;
    int original_i = i;
    int original_j = j;
    
    if (i < 0) {
        is_outside_i = true;
        if (bcRmin == 0) {
            i = -i - 1;
        } else {
            i = 0;
        }
    } else if (i >= nr_cells) {
        is_outside_i = true;
        if (bcRmax == 0) {
            i = 2 * nr_cells - 1 - i;
        } else {
            i = nr_cells - 1;
        }
    }
    
    if (j < 0) {
        is_outside_j = true;
        if (bcZmin == 0) {
            j = -j - 1;
        } else {
            j = 0;
        }
    } else if (j >= nz_cells) {
        is_outside_j = true;
        if (bcZmax == 0) {
            j = 2 * nz_cells - 1 - j;
        } else {
            j = nz_cells - 1;
        }
    }
    
    int tr = i / TILE_SIZE;
    int tz = j / TILE_SIZE;
    int pool_idx = tile_map[tr * num_tiles_z + tz];
    
    CellStateT<RealType> s;
    if (pool_idx == -1) {
        s = { ambient_rho, 0.0, 0.0, ambient_p, 
              is_ideal_gas ? (ambient_p / (gamma - (RealType)1.0)) : 
              (ambient_rho * MultiMat::getEnergy_IdealGas(ambient_p, ambient_rho, gamma)), 
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
        s = applyBC_device(s, (original_i < 0) ? bcRmin : bcRmax, normal_vel, ambient_rho, ambient_p, gamma, d_materials, is_ideal_gas, true);
    }
    if (is_outside_j) {
        RealType normal_vel = (original_j < 0) ? s.uz : -s.uz;
        s = applyBC_device(s, (original_j < 0) ? bcZmin : bcZmax, normal_vel, ambient_rho, ambient_p, gamma, d_materials, is_ideal_gas, false);
    }
    
    return s;
}

// Helpers for spatial reconstruction on CUDA device
template <typename RealType>
__device__ inline RealType minmod_device(RealType a, RealType b) {
    if (a * b <= (RealType)0.0) return (RealType)0.0;
    RealType abs_a = a < (RealType)0.0 ? -a : a;
    RealType abs_b = b < (RealType)0.0 ? -b : b;
    return (abs_a < abs_b) ? a : b;
}

template <typename RealType>
__device__ inline RealType weno3_device(RealType qm1, RealType q0, RealType qp1) {
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
__device__ inline void calcFluxRusanov_device(const CellStateT<RealType>& sL, const CellStateT<RealType>& sR, RealType gamma, const MultiMat::MaterialSet& mat, 
                            RealType& f_rho, RealType& f_rhour, RealType& f_rhouz, RealType& f_E, 
                            RealType& f_alpha1, RealType& f_alpha2, RealType& f_arho1, RealType& f_arho2, RealType& v_face) {
    using std::abs;
    RealType cL = MultiMat::getMixtureSoundSpeed(sL.p, sL.rho, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, gamma, mat.products, mat.unreacted);
    RealType cR = MultiMat::getMixtureSoundSpeed(sR.p, sR.rho, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, gamma, mat.products, mat.unreacted);
    RealType val_L = abs(sL.ur) + cL;
    RealType val_R = abs(sR.ur) + cR;
    RealType s_max = (val_L > val_R) ? val_L : val_R;

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
__device__ inline void calcFluxRusanovZ_device(const CellStateT<RealType>& sL, const CellStateT<RealType>& sR, RealType gamma, const MultiMat::MaterialSet& mat, 
                            RealType& f_rho, RealType& f_rhour, RealType& f_rhouz, RealType& f_E, 
                            RealType& f_alpha1, RealType& f_alpha2, RealType& f_arho1, RealType& f_arho2, RealType& v_face) {
    using std::abs;
    RealType cL = MultiMat::getMixtureSoundSpeed(sL.p, sL.rho, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, gamma, mat.products, mat.unreacted);
    RealType cR = MultiMat::getMixtureSoundSpeed(sR.p, sR.rho, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, gamma, mat.products, mat.unreacted);
    RealType val_L = abs(sL.uz) + cL;
    RealType val_R = abs(sR.uz) + cR;
    RealType s_max = (val_L > val_R) ? val_L : val_R;

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
__global__ __launch_bounds__(256, 2) void computeTileRHS_kernel(
    int num_tiles_r, int num_tiles_z, int nr_cells, int nz_cells, 
    RealType dr, RealType dz, RealType gamma, RealType dt, RealType A_coeff, MultiMat::MaterialSet* d_materials,
    const int32_t* tile_map, const PrimitiveTileT<RealType>* states_pool, ConservativeTileT<RealType>* dU_pool,
    int spatialOrder, bool is_ideal_gas,
    int bcRmin, int bcRmax, int bcZmin, int bcZmax,
    RealType ambient_rho, RealType ambient_p, bool is_cartesian,
    const uint8_t* d_solid_mask, const double* d_solid_velocities) {
    
    int tr = blockIdx.x;
    int tz = blockIdx.y;
    int pool_idx = tile_map[tr * num_tiles_z + tz];
    if (pool_idx == -1) return;
    
    int local_i = threadIdx.x;
    int local_j = threadIdx.y;
    int i = tr * TILE_SIZE + local_i;
    int j = tz * TILE_SIZE + local_j;
    
    if (i >= nr_cells || j >= nz_cells) return;
    
    int k = local_i * TILE_SIZE + local_j;
    
    CellStateT<RealType> s_c = readState_device(tile_map, states_pool, i, j, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
    CellStateT<RealType> s_L = readState_device(tile_map, states_pool, i - 1, j, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
    CellStateT<RealType> s_R = readState_device(tile_map, states_pool, i + 1, j, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
    CellStateT<RealType> s_B = readState_device(tile_map, states_pool, i, j - 1, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
    CellStateT<RealType> s_T = readState_device(tile_map, states_pool, i, j + 1, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);

    CellStateT<RealType> s_faceL_L = s_L;
    CellStateT<RealType> s_faceL_R = s_c;
    CellStateT<RealType> s_faceR_L = s_c;
    CellStateT<RealType> s_faceR_R = s_R;
    CellStateT<RealType> s_faceB_L = s_B;
    CellStateT<RealType> s_faceB_R = s_c;
    CellStateT<RealType> s_faceT_L = s_c;
    CellStateT<RealType> s_faceT_R = s_T;

    if (spatialOrder == 2) {
        CellStateT<RealType> s_LL = readState_device(tile_map, states_pool, i - 2, j, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
        CellStateT<RealType> s_RR = readState_device(tile_map, states_pool, i + 2, j, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
        CellStateT<RealType> s_BB = readState_device(tile_map, states_pool, i, j - 2, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
        CellStateT<RealType> s_TT = readState_device(tile_map, states_pool, i, j + 2, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);

        // Reconstruct left radial face i - 1/2
        s_faceL_L.rho = s_L.rho + (RealType)0.5 * minmod_device(s_L.rho - s_LL.rho, s_c.rho - s_L.rho);
        s_faceL_R.rho = s_c.rho - (RealType)0.5 * minmod_device(s_c.rho - s_L.rho, s_R.rho - s_c.rho);
        s_faceL_L.ur  = s_L.ur + (RealType)0.5 * minmod_device(s_L.ur - s_LL.ur, s_c.ur - s_L.ur);
        s_faceL_R.ur  = s_c.ur - (RealType)0.5 * minmod_device(s_c.ur - s_L.ur, s_R.ur - s_c.ur);
        s_faceL_L.uz  = s_L.uz + (RealType)0.5 * minmod_device(s_L.uz - s_LL.uz, s_c.uz - s_L.uz);
        s_faceL_R.uz  = s_c.uz - (RealType)0.5 * minmod_device(s_c.uz - s_L.uz, s_R.uz - s_c.uz);
        s_faceL_L.p   = s_L.p + (RealType)0.5 * minmod_device(s_L.p - s_LL.p, s_c.p - s_L.p);
        s_faceL_R.p   = s_c.p - (RealType)0.5 * minmod_device(s_c.p - s_L.p, s_R.p - s_c.p);

        s_faceL_L.alpha1 = s_L.alpha1 + (RealType)0.5 * minmod_device(s_L.alpha1 - s_LL.alpha1, s_c.alpha1 - s_L.alpha1);
        s_faceL_L.alpha2 = s_L.alpha2 + (RealType)0.5 * minmod_device(s_L.alpha2 - s_LL.alpha2, s_c.alpha2 - s_L.alpha2);
        s_faceL_L.arho1  = s_L.arho1  + (RealType)0.5 * minmod_device(s_L.arho1 - s_LL.arho1, s_c.arho1 - s_L.arho1);
        s_faceL_L.arho2  = s_L.arho2  + (RealType)0.5 * minmod_device(s_L.arho2 - s_LL.arho2, s_c.arho2 - s_L.arho2);

        s_faceL_R.alpha1 = s_c.alpha1 - (RealType)0.5 * minmod_device(s_c.alpha1 - s_L.alpha1, s_R.alpha1 - s_c.alpha1);
        s_faceL_R.alpha2 = s_c.alpha2 - (RealType)0.5 * minmod_device(s_c.alpha2 - s_L.alpha2, s_R.alpha2 - s_c.alpha2);
        s_faceL_R.arho1  = s_c.arho1  - (RealType)0.5 * minmod_device(s_c.arho1 - s_L.arho1, s_R.arho1 - s_c.arho1);
        s_faceL_R.arho2  = s_c.arho2  - (RealType)0.5 * minmod_device(s_c.arho2 - s_L.arho2, s_R.arho2 - s_c.arho2);

        // Reconstruct right radial face i + 1/2
        s_faceR_L.rho = s_c.rho + (RealType)0.5 * minmod_device(s_c.rho - s_L.rho, s_R.rho - s_c.rho);
        s_faceR_R.rho = s_R.rho - (RealType)0.5 * minmod_device(s_R.rho - s_c.rho, s_RR.rho - s_R.rho);
        s_faceR_L.ur  = s_c.ur + (RealType)0.5 * minmod_device(s_c.ur - s_L.ur, s_R.ur - s_c.ur);
        s_faceR_R.ur  = s_R.ur - (RealType)0.5 * minmod_device(s_R.ur - s_c.ur, s_RR.ur - s_R.ur);
        s_faceR_L.uz  = s_c.uz + (RealType)0.5 * minmod_device(s_c.uz - s_L.uz, s_R.uz - s_c.uz);
        s_faceR_R.uz  = s_R.uz - (RealType)0.5 * minmod_device(s_R.uz - s_c.uz, s_RR.uz - s_R.uz);
        s_faceR_L.p   = s_c.p + (RealType)0.5 * minmod_device(s_c.p - s_L.p, s_R.p - s_c.p);
        s_faceR_R.p   = s_R.p - (RealType)0.5 * minmod_device(s_R.p - s_c.p, s_RR.p - s_R.p);

        s_faceR_L.alpha1 = s_c.alpha1 + (RealType)0.5 * minmod_device(s_c.alpha1 - s_L.alpha1, s_R.alpha1 - s_c.alpha1);
        s_faceR_L.alpha2 = s_c.alpha2 + (RealType)0.5 * minmod_device(s_c.alpha2 - s_L.alpha2, s_R.alpha2 - s_c.alpha2);
        s_faceR_L.arho1  = s_c.arho1  + (RealType)0.5 * minmod_device(s_c.arho1 - s_L.arho1, s_R.arho1 - s_c.arho1);
        s_faceR_L.arho2  = s_c.arho2  + (RealType)0.5 * minmod_device(s_c.arho2 - s_L.arho2, s_R.arho2 - s_c.arho2);

        s_faceR_R.alpha1 = s_R.alpha1 - (RealType)0.5 * minmod_device(s_R.alpha1 - s_c.alpha1, s_RR.alpha1 - s_R.alpha1);
        s_faceR_R.alpha2 = s_R.alpha2 - (RealType)0.5 * minmod_device(s_R.alpha2 - s_c.alpha2, s_RR.alpha2 - s_R.alpha2);
        s_faceR_R.arho1  = s_R.arho1  - (RealType)0.5 * minmod_device(s_R.arho1 - s_c.arho1, s_RR.arho1 - s_R.arho1);
        s_faceR_R.arho2  = s_R.arho2  - (RealType)0.5 * minmod_device(s_R.arho2 - s_c.arho2, s_RR.arho2 - s_R.arho2);

        // Reconstruct bottom axial face j - 1/2
        s_faceB_L.rho = s_B.rho + (RealType)0.5 * minmod_device(s_B.rho - s_BB.rho, s_c.rho - s_B.rho);
        s_faceB_R.rho = s_c.rho - (RealType)0.5 * minmod_device(s_c.rho - s_B.rho, s_T.rho - s_c.rho);
        s_faceB_L.ur  = s_B.ur + (RealType)0.5 * minmod_device(s_B.ur - s_BB.ur, s_c.ur - s_B.ur);
        s_faceB_R.ur  = s_c.ur - (RealType)0.5 * minmod_device(s_c.ur - s_B.ur, s_T.ur - s_c.ur);
        s_faceB_L.uz  = s_B.uz + (RealType)0.5 * minmod_device(s_B.uz - s_BB.uz, s_c.uz - s_B.uz);
        s_faceB_R.uz  = s_c.uz - (RealType)0.5 * minmod_device(s_c.uz - s_B.uz, s_T.uz - s_c.uz);
        s_faceB_L.p   = s_B.p + (RealType)0.5 * minmod_device(s_B.p - s_BB.p, s_c.p - s_B.p);
        s_faceB_R.p   = s_c.p - (RealType)0.5 * minmod_device(s_c.p - s_B.p, s_T.p - s_c.p);

        s_faceB_L.alpha1 = s_B.alpha1 + (RealType)0.5 * minmod_device(s_B.alpha1 - s_BB.alpha1, s_c.alpha1 - s_B.alpha1);
        s_faceB_L.alpha2 = s_B.alpha2 + (RealType)0.5 * minmod_device(s_B.alpha2 - s_BB.alpha2, s_c.alpha2 - s_B.alpha2);
        s_faceB_L.arho1  = s_B.arho1  + (RealType)0.5 * minmod_device(s_B.arho1 - s_BB.arho1, s_c.arho1 - s_B.arho1);
        s_faceB_L.arho2  = s_B.arho2  + (RealType)0.5 * minmod_device(s_B.arho2 - s_BB.arho2, s_c.arho2 - s_B.arho2);

        s_faceB_R.alpha1 = s_c.alpha1 - (RealType)0.5 * minmod_device(s_c.alpha1 - s_B.alpha1, s_T.alpha1 - s_c.alpha1);
        s_faceB_R.alpha2 = s_c.alpha2 - (RealType)0.5 * minmod_device(s_c.alpha2 - s_B.alpha2, s_T.alpha2 - s_c.alpha2);
        s_faceB_R.arho1  = s_c.arho1  - (RealType)0.5 * minmod_device(s_c.arho1 - s_B.arho1, s_T.arho1 - s_c.arho1);
        s_faceB_R.arho2  = s_c.arho2  - (RealType)0.5 * minmod_device(s_c.arho2 - s_B.arho2, s_T.arho2 - s_c.arho2);

        // Reconstruct top axial face j + 1/2
        s_faceT_L.rho = s_c.rho + (RealType)0.5 * minmod_device(s_c.rho - s_B.rho, s_T.rho - s_c.rho);
        s_faceT_R.rho = s_T.rho - (RealType)0.5 * minmod_device(s_T.rho - s_c.rho, s_TT.rho - s_T.rho);
        s_faceT_L.ur  = s_c.ur + (RealType)0.5 * minmod_device(s_c.ur - s_B.ur, s_T.ur - s_c.ur);
        s_faceT_R.ur  = s_T.ur - (RealType)0.5 * minmod_device(s_T.ur - s_c.ur, s_TT.ur - s_T.ur);
        s_faceT_L.uz  = s_c.uz + (RealType)0.5 * minmod_device(s_c.uz - s_B.uz, s_T.uz - s_c.uz);
        s_faceT_R.uz  = s_T.uz - (RealType)0.5 * minmod_device(s_T.uz - s_c.uz, s_TT.uz - s_T.uz);
        s_faceT_L.p   = s_c.p + (RealType)0.5 * minmod_device(s_c.p - s_B.p, s_T.p - s_c.p);
        s_faceT_R.p   = s_T.p - (RealType)0.5 * minmod_device(s_T.p - s_c.p, s_TT.p - s_T.p);

        s_faceT_L.alpha1 = s_c.alpha1 + (RealType)0.5 * minmod_device(s_c.alpha1 - s_B.alpha1, s_T.alpha1 - s_c.alpha1);
        s_faceT_L.alpha2 = s_c.alpha2 + (RealType)0.5 * minmod_device(s_c.alpha2 - s_B.alpha2, s_T.alpha2 - s_c.alpha2);
        s_faceT_L.arho1  = s_c.arho1  + (RealType)0.5 * minmod_device(s_c.arho1 - s_B.arho1, s_T.arho1 - s_c.arho1);
        s_faceT_L.arho2  = s_c.arho2  + (RealType)0.5 * minmod_device(s_c.arho2 - s_B.arho2, s_T.arho2 - s_c.arho2);

        s_faceT_R.alpha1 = s_T.alpha1 - (RealType)0.5 * minmod_device(s_T.alpha1 - s_c.alpha1, s_TT.alpha1 - s_T.alpha1);
        s_faceT_R.alpha2 = s_T.alpha2 - (RealType)0.5 * minmod_device(s_T.alpha2 - s_c.alpha2, s_TT.alpha2 - s_T.alpha2);
        s_faceT_R.arho1  = s_T.arho1  - (RealType)0.5 * minmod_device(s_T.arho1 - s_c.arho1, s_TT.arho1 - s_T.arho1);
        s_faceT_R.arho2  = s_T.arho2  - (RealType)0.5 * minmod_device(s_T.arho2 - s_c.arho2, s_TT.arho2 - s_T.arho2);

        // Clamp volume fractions
        s_faceL_L.alpha1 = fmax(0.0, fmin(1.0, s_faceL_L.alpha1)); s_faceL_L.alpha2 = fmax(0.0, fmin(1.0, s_faceL_L.alpha2));
        s_faceL_R.alpha1 = fmax(0.0, fmin(1.0, s_faceL_R.alpha1)); s_faceL_R.alpha2 = fmax(0.0, fmin(1.0, s_faceL_R.alpha2));
        s_faceR_L.alpha1 = fmax(0.0, fmin(1.0, s_faceR_L.alpha1)); s_faceR_L.alpha2 = fmax(0.0, fmin(1.0, s_faceR_L.alpha2));
        s_faceR_R.alpha1 = fmax(0.0, fmin(1.0, s_faceR_R.alpha1)); s_faceR_R.alpha2 = fmax(0.0, fmin(1.0, s_faceR_R.alpha2));
        s_faceB_L.alpha1 = fmax(0.0, fmin(1.0, s_faceB_L.alpha1)); s_faceB_L.alpha2 = fmax(0.0, fmin(1.0, s_faceB_L.alpha2));
        s_faceB_R.alpha1 = fmax(0.0, fmin(1.0, s_faceB_R.alpha1)); s_faceB_R.alpha2 = fmax(0.0, fmin(1.0, s_faceB_R.alpha2));
        s_faceT_L.alpha1 = fmax(0.0, fmin(1.0, s_faceT_L.alpha1)); s_faceT_L.alpha2 = fmax(0.0, fmin(1.0, s_faceT_L.alpha2));
        s_faceT_R.alpha1 = fmax(0.0, fmin(1.0, s_faceT_R.alpha1)); s_faceT_R.alpha2 = fmax(0.0, fmin(1.0, s_faceT_R.alpha2));

        // Recompute energies
        compute_E_device(s_faceL_L, gamma, d_materials, is_ideal_gas);
        compute_E_device(s_faceL_R, gamma, d_materials, is_ideal_gas);
        compute_E_device(s_faceR_L, gamma, d_materials, is_ideal_gas);
        compute_E_device(s_faceR_R, gamma, d_materials, is_ideal_gas);
        compute_E_device(s_faceB_L, gamma, d_materials, is_ideal_gas);
        compute_E_device(s_faceB_R, gamma, d_materials, is_ideal_gas);
        compute_E_device(s_faceT_L, gamma, d_materials, is_ideal_gas);
        compute_E_device(s_faceT_R, gamma, d_materials, is_ideal_gas);

    } else if (spatialOrder == 3) {
        CellStateT<RealType> s_LL = readState_device(tile_map, states_pool, i - 2, j, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
        CellStateT<RealType> s_RR = readState_device(tile_map, states_pool, i + 2, j, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
        CellStateT<RealType> s_BB = readState_device(tile_map, states_pool, i, j - 2, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
        CellStateT<RealType> s_TT = readState_device(tile_map, states_pool, i, j + 2, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);

        // Reconstruct left radial face i - 1/2 using WENO3
        s_faceL_L.rho = weno3_device(s_LL.rho, s_L.rho, s_c.rho);
        s_faceL_R.rho = weno3_device(s_R.rho, s_c.rho, s_L.rho);
        s_faceL_L.ur  = weno3_device(s_LL.ur, s_L.ur, s_c.ur);
        s_faceL_R.ur  = weno3_device(s_R.ur, s_c.ur, s_L.ur);
        s_faceL_L.uz  = weno3_device(s_LL.uz, s_L.uz, s_c.uz);
        s_faceL_R.uz  = weno3_device(s_R.uz, s_c.uz, s_L.uz);
        s_faceL_L.p   = weno3_device(s_LL.p, s_L.p, s_c.p);
        s_faceL_R.p   = weno3_device(s_R.p, s_c.p, s_L.p);

        // Reconstruct right radial face i + 1/2 using WENO3
        s_faceR_L.rho = weno3_device(s_L.rho, s_c.rho, s_R.rho);
        s_faceR_R.rho = weno3_device(s_RR.rho, s_R.rho, s_c.rho);
        s_faceR_L.ur  = weno3_device(s_L.ur, s_c.ur, s_R.ur);
        s_faceR_R.ur  = weno3_device(s_RR.ur, s_R.ur, s_c.ur);
        s_faceR_L.uz  = weno3_device(s_L.uz, s_c.uz, s_R.uz);
        s_faceR_R.uz  = weno3_device(s_RR.uz, s_R.uz, s_c.uz);
        s_faceR_L.p   = weno3_device(s_L.p, s_c.p, s_R.p);
        s_faceR_R.p   = weno3_device(s_RR.p, s_R.p, s_c.p);

        // Reconstruct bottom axial face j - 1/2 using WENO3
        s_faceB_L.rho = weno3_device(s_BB.rho, s_B.rho, s_c.rho);
        s_faceB_R.rho = weno3_device(s_T.rho, s_c.rho, s_B.rho);
        s_faceB_L.ur  = weno3_device(s_BB.ur, s_B.ur, s_c.ur);
        s_faceB_R.ur  = weno3_device(s_T.ur, s_c.ur, s_B.ur);
        s_faceB_L.uz  = weno3_device(s_BB.uz, s_B.uz, s_c.uz);
        s_faceB_R.uz  = weno3_device(s_T.uz, s_c.uz, s_B.uz);
        s_faceB_L.p   = weno3_device(s_BB.p, s_B.p, s_c.p);
        s_faceB_R.p   = weno3_device(s_T.p, s_c.p, s_B.p);

        // Reconstruct top axial face j + 1/2 using WENO3
        s_faceT_L.rho = weno3_device(s_B.rho, s_c.rho, s_T.rho);
        s_faceT_R.rho = weno3_device(s_TT.rho, s_T.rho, s_c.rho);
        s_faceT_L.ur  = weno3_device(s_B.ur, s_c.ur, s_T.ur);
        s_faceT_R.ur  = weno3_device(s_TT.ur, s_T.ur, s_c.ur);
        s_faceT_L.uz  = weno3_device(s_B.uz, s_c.uz, s_T.uz);
        s_faceT_R.uz  = weno3_device(s_TT.uz, s_T.uz, s_c.uz);
        s_faceT_L.p   = weno3_device(s_B.p, s_c.p, s_T.p);
        s_faceT_R.p   = weno3_device(s_TT.p, s_T.p, s_c.p);

        // Species fractions are reconstructed using second-order minmod for stability
        s_faceL_L.alpha1 = s_L.alpha1 + (RealType)0.5 * minmod_device(s_L.alpha1 - s_LL.alpha1, s_c.alpha1 - s_L.alpha1);
        s_faceL_L.alpha2 = s_L.alpha2 + (RealType)0.5 * minmod_device(s_L.alpha2 - s_LL.alpha2, s_c.alpha2 - s_L.alpha2);
        s_faceL_L.arho1  = s_L.arho1  + (RealType)0.5 * minmod_device(s_L.arho1 - s_LL.arho1, s_c.arho1 - s_L.arho1);
        s_faceL_L.arho2  = s_L.arho2  + (RealType)0.5 * minmod_device(s_L.arho2 - s_LL.arho2, s_c.arho2 - s_L.arho2);

        s_faceL_R.alpha1 = s_c.alpha1 - (RealType)0.5 * minmod_device(s_c.alpha1 - s_L.alpha1, s_R.alpha1 - s_c.alpha1);
        s_faceL_R.alpha2 = s_c.alpha2 - (RealType)0.5 * minmod_device(s_c.alpha2 - s_L.alpha2, s_R.alpha2 - s_c.alpha2);
        s_faceL_R.arho1  = s_c.arho1  - (RealType)0.5 * minmod_device(s_c.arho1 - s_L.arho1, s_R.arho1 - s_c.arho1);
        s_faceL_R.arho2  = s_c.arho2  - (RealType)0.5 * minmod_device(s_c.arho2 - s_L.arho2, s_R.arho2 - s_c.arho2);

        s_faceR_L.alpha1 = s_c.alpha1 + (RealType)0.5 * minmod_device(s_c.alpha1 - s_L.alpha1, s_R.alpha1 - s_c.alpha1);
        s_faceR_L.alpha2 = s_c.alpha2 + (RealType)0.5 * minmod_device(s_c.alpha2 - s_L.alpha2, s_R.alpha2 - s_c.alpha2);
        s_faceR_L.arho1  = s_c.arho1  + (RealType)0.5 * minmod_device(s_c.arho1 - s_L.arho1, s_R.arho1 - s_c.arho1);
        s_faceR_L.arho2  = s_c.arho2  + (RealType)0.5 * minmod_device(s_c.arho2 - s_L.arho2, s_R.arho2 - s_c.arho2);

        s_faceR_R.alpha1 = s_R.alpha1 - (RealType)0.5 * minmod_device(s_R.alpha1 - s_c.alpha1, s_RR.alpha1 - s_R.alpha1);
        s_faceR_R.alpha2 = s_R.alpha2 - (RealType)0.5 * minmod_device(s_R.alpha2 - s_c.alpha2, s_RR.alpha2 - s_R.alpha2);
        s_faceR_R.arho1  = s_R.arho1  - (RealType)0.5 * minmod_device(s_R.arho1 - s_c.arho1, s_RR.arho1 - s_R.arho1);
        s_faceR_R.arho2  = s_R.arho2  - (RealType)0.5 * minmod_device(s_R.arho2 - s_c.arho2, s_RR.arho2 - s_R.arho2);

        s_faceB_L.alpha1 = s_B.alpha1 + (RealType)0.5 * minmod_device(s_B.alpha1 - s_BB.alpha1, s_c.alpha1 - s_B.alpha1);
        s_faceB_L.alpha2 = s_B.alpha2 + (RealType)0.5 * minmod_device(s_B.alpha2 - s_BB.alpha2, s_c.alpha2 - s_B.alpha2);
        s_faceB_L.arho1  = s_B.arho1  + (RealType)0.5 * minmod_device(s_B.arho1 - s_BB.arho1, s_c.arho1 - s_B.arho1);
        s_faceB_L.arho2  = s_B.arho2  + (RealType)0.5 * minmod_device(s_B.arho2 - s_BB.arho2, s_c.arho2 - s_B.arho2);

        s_faceB_R.alpha1 = s_c.alpha1 - (RealType)0.5 * minmod_device(s_c.alpha1 - s_B.alpha1, s_T.alpha1 - s_c.alpha1);
        s_faceB_R.alpha2 = s_c.alpha2 - (RealType)0.5 * minmod_device(s_c.alpha2 - s_B.alpha2, s_T.alpha2 - s_c.alpha2);
        s_faceB_R.arho1  = s_c.arho1  - (RealType)0.5 * minmod_device(s_c.arho1 - s_B.arho1, s_T.arho1 - s_c.arho1);
        s_faceB_R.arho2  = s_c.arho2  - (RealType)0.5 * minmod_device(s_c.arho2 - s_B.arho2, s_T.arho2 - s_c.arho2);

        s_faceT_L.alpha1 = s_c.alpha1 + (RealType)0.5 * minmod_device(s_c.alpha1 - s_B.alpha1, s_T.alpha1 - s_c.alpha1);
        s_faceT_L.alpha2 = s_c.alpha2 + (RealType)0.5 * minmod_device(s_c.alpha2 - s_B.alpha2, s_T.alpha2 - s_c.alpha2);
        s_faceT_L.arho1  = s_c.arho1  + (RealType)0.5 * minmod_device(s_c.arho1 - s_B.arho1, s_T.arho1 - s_c.arho1);
        s_faceT_L.arho2  = s_c.arho2  + (RealType)0.5 * minmod_device(s_c.arho2 - s_B.arho2, s_T.arho2 - s_c.arho2);

        s_faceT_R.alpha1 = s_T.alpha1 - (RealType)0.5 * minmod_device(s_T.alpha1 - s_c.alpha1, s_TT.alpha1 - s_T.alpha1);
        s_faceT_R.alpha2 = s_T.alpha2 - (RealType)0.5 * minmod_device(s_T.alpha2 - s_c.alpha2, s_TT.alpha2 - s_T.alpha2);
        s_faceT_R.arho1  = s_T.arho1  - (RealType)0.5 * minmod_device(s_T.arho1 - s_c.arho1, s_TT.arho1 - s_T.arho1);
        s_faceT_R.arho2  = s_T.arho2  - (RealType)0.5 * minmod_device(s_T.arho2 - s_c.arho2, s_TT.arho2 - s_T.arho2);

        // Clamp volume fractions
        s_faceL_L.alpha1 = fmax(0.0, fmin(1.0, s_faceL_L.alpha1)); s_faceL_L.alpha2 = fmax(0.0, fmin(1.0, s_faceL_L.alpha2));
        s_faceL_R.alpha1 = fmax(0.0, fmin(1.0, s_faceL_R.alpha1)); s_faceL_R.alpha2 = fmax(0.0, fmin(1.0, s_faceL_R.alpha2));
        s_faceR_L.alpha1 = fmax(0.0, fmin(1.0, s_faceR_L.alpha1)); s_faceR_L.alpha2 = fmax(0.0, fmin(1.0, s_faceR_L.alpha2));
        s_faceR_R.alpha1 = fmax(0.0, fmin(1.0, s_faceR_R.alpha1)); s_faceR_R.alpha2 = fmax(0.0, fmin(1.0, s_faceR_R.alpha2));
        s_faceB_L.alpha1 = fmax(0.0, fmin(1.0, s_faceB_L.alpha1)); s_faceB_L.alpha2 = fmax(0.0, fmin(1.0, s_faceB_L.alpha2));
        s_faceB_R.alpha1 = fmax(0.0, fmin(1.0, s_faceB_R.alpha1)); s_faceB_R.alpha2 = fmax(0.0, fmin(1.0, s_faceB_R.alpha2));
        s_faceT_L.alpha1 = fmax(0.0, fmin(1.0, s_faceT_L.alpha1)); s_faceT_L.alpha2 = fmax(0.0, fmin(1.0, s_faceT_L.alpha2));
        s_faceT_R.alpha1 = fmax(0.0, fmin(1.0, s_faceT_R.alpha1)); s_faceT_R.alpha2 = fmax(0.0, fmin(1.0, s_faceT_R.alpha2));

        // Recompute energies
        compute_E_device(s_faceL_L, gamma, d_materials, is_ideal_gas);
        compute_E_device(s_faceL_R, gamma, d_materials, is_ideal_gas);
        compute_E_device(s_faceR_L, gamma, d_materials, is_ideal_gas);
        compute_E_device(s_faceR_R, gamma, d_materials, is_ideal_gas);
        compute_E_device(s_faceB_L, gamma, d_materials, is_ideal_gas);
        compute_E_device(s_faceB_R, gamma, d_materials, is_ideal_gas);
        compute_E_device(s_faceT_L, gamma, d_materials, is_ideal_gas);
        compute_E_device(s_faceT_R, gamma, d_materials, is_ideal_gas);
    }

    RealType fr_L_rho, fr_L_rhour, fr_L_rhouz, fr_L_E, fr_L_a1, fr_L_a2, fr_L_ar1, fr_L_ar2, v_face_rL;
    RealType fr_R_rho, fr_R_rhour, fr_R_rhouz, fr_R_E, fr_R_a1, fr_R_a2, fr_R_ar1, fr_R_ar2, v_face_rR;
    
    calcFluxRusanov_device(s_faceL_L, s_faceL_R, gamma, *d_materials, fr_L_rho, fr_L_rhour, fr_L_rhouz, fr_L_E, fr_L_a1, fr_L_a2, fr_L_ar1, fr_L_ar2, v_face_rL);
    calcFluxRusanov_device(s_faceR_L, s_faceR_R, gamma, *d_materials, fr_R_rho, fr_R_rhour, fr_R_rhouz, fr_R_E, fr_R_a1, fr_R_a2, fr_R_ar1, fr_R_ar2, v_face_rR);
    
    RealType fz_B_rho, fz_B_rhour, fz_B_rhouz, fz_B_E, fz_B_a1, fz_B_a2, fz_B_ar1, fz_B_ar2, v_face_zB;
    RealType fz_T_rho, fz_T_rhour, fz_T_rhouz, fz_T_E, fz_T_a1, fz_T_a2, fz_T_ar1, fz_T_ar2, v_face_zT;

    calcFluxRusanovZ_device(s_faceB_L, s_faceB_R, gamma, *d_materials, fz_B_rho, fz_B_rhour, fz_B_rhouz, fz_B_E, fz_B_a1, fz_B_a2, fz_B_ar1, fz_B_ar2, v_face_zB);
    calcFluxRusanovZ_device(s_faceT_L, s_faceT_R, gamma, *d_materials, fz_T_rho, fz_T_rhour, fz_T_rhouz, fz_T_E, fz_T_a1, fz_T_a2, fz_T_ar1, fz_T_ar2, v_face_zT);

    RealType r_center = (RealType)(i + 0.5) * dr;
    RealType r_left = (RealType)i * dr;
    RealType r_right = (RealType)(i + 1) * dr;

    RealType p_face_R = (RealType)0.5 * (s_faceR_L.p + s_faceR_R.p);
    RealType p_face_L = (RealType)0.5 * (s_faceL_L.p + s_faceL_R.p);
    RealType p_face_avg = (RealType)0.5 * (p_face_R + p_face_L);

    RealType dU_rho, dU_rhour, dU_rhouz, dU_E, div_u, dU_alpha1, dU_alpha2, dU_arho1, dU_arho2;
    if (is_cartesian) {
        dU_rho = -((RealType)1.0 / dr) * (fr_R_rho - fr_L_rho) - ((RealType)1.0 / dz) * (fz_T_rho - fz_B_rho);
        dU_rhour = -((RealType)1.0 / dr) * (fr_R_rhour - fr_L_rhour) - ((RealType)1.0 / dz) * (fz_T_rhour - fz_B_rhour);
        dU_rhouz = -((RealType)1.0 / dr) * (fr_R_rhouz - fr_L_rhouz) - ((RealType)1.0 / dz) * (fz_T_rhouz - fz_B_rhouz);
        dU_E = -((RealType)1.0 / dr) * (fr_R_E - fr_L_E) - ((RealType)1.0 / dz) * (fz_T_E - fz_B_E);

        div_u = ((RealType)1.0 / dr) * (v_face_rR - v_face_rL) + ((RealType)1.0 / dz) * (v_face_zT - v_face_zB);

        dU_alpha1 = -((RealType)1.0 / dr) * (fr_R_a1 - fr_L_a1) - ((RealType)1.0 / dz) * (fz_T_a1 - fz_B_a1) + s_c.alpha1 * div_u;
        dU_alpha2 = -((RealType)1.0 / dr) * (fr_R_a2 - fr_L_a2) - ((RealType)1.0 / dz) * (fz_T_a2 - fz_B_a2) + s_c.alpha2 * div_u;
        dU_arho1 = -((RealType)1.0 / dr) * (fr_R_ar1 - fr_L_ar1) - ((RealType)1.0 / dz) * (fz_T_ar1 - fz_B_ar1);
        dU_arho2 = -((RealType)1.0 / dr) * (fr_R_ar2 - fr_L_ar2) - ((RealType)1.0 / dz) * (fz_T_ar2 - fz_B_ar2);
    } else {
        dU_rho = -((RealType)1.0 / (r_center * dr)) * (r_right * fr_R_rho - r_left * fr_L_rho) - ((RealType)1.0 / dz) * (fz_T_rho - fz_B_rho);
        dU_rhour = -((RealType)1.0 / (r_center * dr)) * (r_right * fr_R_rhour - r_left * fr_L_rhour) - ((RealType)1.0 / dz) * (fz_T_rhour - fz_B_rhour) + p_face_avg / r_center;
        dU_rhouz = -((RealType)1.0 / (r_center * dr)) * (r_right * fr_R_rhouz - r_left * fr_L_rhouz) - ((RealType)1.0 / dz) * (fz_T_rhouz - fz_B_rhouz);
        dU_E = -((RealType)1.0 / (r_center * dr)) * (r_right * fr_R_E - r_left * fr_L_E) - ((RealType)1.0 / dz) * (fz_T_E - fz_B_E);

        div_u = ((RealType)1.0 / (r_center * dr)) * (r_right * v_face_rR - r_left * v_face_rL) + ((RealType)1.0 / dz) * (v_face_zT - v_face_zB);

        dU_alpha1 = -((RealType)1.0 / (r_center * dr)) * (r_right * fr_R_a1 - r_left * fr_L_a1) - ((RealType)1.0 / dz) * (fz_T_a1 - fz_B_a1) + s_c.alpha1 * div_u;
        dU_alpha2 = -((RealType)1.0 / (r_center * dr)) * (r_right * fr_R_a2 - r_left * fr_L_a2) - ((RealType)1.0 / dz) * (fz_T_a2 - fz_B_a2) + s_c.alpha2 * div_u;
        dU_arho1 = -((RealType)1.0 / (r_center * dr)) * (r_right * fr_R_ar1 - r_left * fr_L_ar1) - ((RealType)1.0 / dz) * (fz_T_ar1 - fz_B_ar1);
        dU_arho2 = -((RealType)1.0 / (r_center * dr)) * (r_right * fr_R_ar2 - r_left * fr_L_ar2) - ((RealType)1.0 / dz) * (fz_T_ar2 - fz_B_ar2);
    }

    if (d_solid_mask != nullptr && d_solid_mask[i * nz_cells + j] != 0) {
        dU_rho = 0;
        dU_rhour = 0;
        dU_rhouz = 0;
        dU_E = 0;
        dU_alpha1 = 0;
        dU_alpha2 = 0;
        dU_arho1 = 0;
        dU_arho2 = 0;
    }

    dU_pool[pool_idx].rho[k] = A_coeff * dU_pool[pool_idx].rho[k] + dt * dU_rho;
    dU_pool[pool_idx].rhour[k] = A_coeff * dU_pool[pool_idx].rhour[k] + dt * dU_rhour;
    dU_pool[pool_idx].rhouz[k] = A_coeff * dU_pool[pool_idx].rhouz[k] + dt * dU_rhouz;
    dU_pool[pool_idx].E[k] = A_coeff * dU_pool[pool_idx].E[k] + dt * dU_E;
    dU_pool[pool_idx].alpha1[k] = A_coeff * dU_pool[pool_idx].alpha1[k] + dt * dU_alpha1;
    dU_pool[pool_idx].alpha2[k] = A_coeff * dU_pool[pool_idx].alpha2[k] + dt * dU_alpha2;
    dU_pool[pool_idx].arho1[k] = A_coeff * dU_pool[pool_idx].arho1[k] + dt * dU_arho1;
    dU_pool[pool_idx].arho2[k] = A_coeff * dU_pool[pool_idx].arho2[k] + dt * dU_arho2;
}

template <typename RealType>
__global__ void applyLSRK3Step_kernel(
    int current_pool_size, int stage,
    ConservativeTileT<RealType>* d_U_pool, ConservativeTileT<RealType>* d_dU_pool) {
    
    int pool_idx = blockIdx.x;
    if (pool_idx >= current_pool_size) return;
    
    int k = threadIdx.x * TILE_SIZE + threadIdx.y;
    
    const double B[3] = {1.0/3.0, 15.0/16.0, 8.0/15.0};
    
    d_U_pool[pool_idx].rho[k] += (RealType)(B[stage] * d_dU_pool[pool_idx].rho[k]);
    d_U_pool[pool_idx].rhour[k] += (RealType)(B[stage] * d_dU_pool[pool_idx].rhour[k]);
    d_U_pool[pool_idx].rhouz[k] += (RealType)(B[stage] * d_dU_pool[pool_idx].rhouz[k]);
    d_U_pool[pool_idx].E[k] += (RealType)(B[stage] * d_dU_pool[pool_idx].E[k]);
    d_U_pool[pool_idx].alpha1[k] += (RealType)(B[stage] * d_dU_pool[pool_idx].alpha1[k]);
    d_U_pool[pool_idx].alpha2[k] += (RealType)(B[stage] * d_dU_pool[pool_idx].alpha2[k]);
    d_U_pool[pool_idx].arho1[k] += (RealType)(B[stage] * d_dU_pool[pool_idx].arho1[k]);
    d_U_pool[pool_idx].arho2[k] += (RealType)(B[stage] * d_dU_pool[pool_idx].arho2[k]);
}

template <typename RealType>
__global__ void applyEulerStep_kernel(
    int current_pool_size, RealType dt,
    ConservativeTileT<RealType>* d_U_pool, ConservativeTileT<RealType>* d_dU_pool) {
    
    int pool_idx = blockIdx.x;
    if (pool_idx >= current_pool_size) return;
    
    int k = threadIdx.x * TILE_SIZE + threadIdx.y;
    
    d_U_pool[pool_idx].rho[k] += dt * d_dU_pool[pool_idx].rho[k];
    d_U_pool[pool_idx].rhour[k] += dt * d_dU_pool[pool_idx].rhour[k];
    d_U_pool[pool_idx].rhouz[k] += dt * d_dU_pool[pool_idx].rhouz[k];
    d_U_pool[pool_idx].E[k] += dt * d_dU_pool[pool_idx].E[k];
    d_U_pool[pool_idx].alpha1[k] += dt * d_dU_pool[pool_idx].alpha1[k];
    d_U_pool[pool_idx].alpha2[k] += dt * d_dU_pool[pool_idx].alpha2[k];
    d_U_pool[pool_idx].arho1[k] += dt * d_dU_pool[pool_idx].arho1[k];
    d_U_pool[pool_idx].arho2[k] += dt * d_dU_pool[pool_idx].arho2[k];
}

template <typename RealType>
__global__ void applyProgrammedBurn_kernel(
    int num_tiles_r, int num_tiles_z, int nr_cells, int nz_cells,
    RealType dr, RealType dz, RealType currentTime, RealType dt,
    RealType det_x, RealType det_y, RealType det_z,
    MultiMat::MaterialSet* d_materials,
    const int32_t* tile_map,
    ConservativeTileT<RealType>* d_U_pool) {
    
    int tr = blockIdx.x;
    int tz = blockIdx.y;
    int pool_idx = tile_map[tr * num_tiles_z + tz];
    if (pool_idx == -1) return;
    
    int local_i = threadIdx.x;
    int local_j = threadIdx.y;
    int i = tr * TILE_SIZE + local_i;
    int j = tz * TILE_SIZE + local_j;
    
    if (i >= nr_cells || j >= nz_cells) return;
    
    int k = local_i * TILE_SIZE + local_j;
    
    RealType r_c = ((RealType)i + (RealType)0.5) * dr;
    RealType z_c = ((RealType)j + (RealType)0.5) * dz;
    
    RealType alpha1 = d_U_pool[pool_idx].alpha1[k];
    RealType alpha2 = d_U_pool[pool_idx].alpha2[k];
    RealType arho1 = d_U_pool[pool_idx].arho1[k];
    RealType arho2 = d_U_pool[pool_idx].arho2[k];
    
    using std::fmin;
    RealType dF = MultiMat::computeProgrammedBurn(
        currentTime, dt, r_c, (RealType)0.0, z_c,
        (RealType)d_materials->det_vel, (RealType)0.0,
        det_x, (RealType)0.0, det_z,
        fmin(dr, dz),
        (RealType)d_materials->products.rho0,
        alpha1, alpha2,
        arho1, arho2
    );
    
    if (dF > (RealType)0.0) {
        if (d_materials->detonation_energy > 0.0) {
            RealType rho_expl = arho1 + arho2;
            d_U_pool[pool_idx].E[k] += dF * rho_expl * (RealType)d_materials->detonation_energy;
        }
    }
    d_U_pool[pool_idx].alpha1[k] = alpha1;
    d_U_pool[pool_idx].alpha2[k] = alpha2;
    d_U_pool[pool_idx].arho1[k] = arho1;
    d_U_pool[pool_idx].arho2[k] = arho2;
}

template <typename RealType>
__global__ void updatePrimitiveFromConservative_kernel(
    int current_pool_size, RealType gamma, MultiMat::MaterialSet* d_materials,
    RealType ambient_rho, RealType ambient_p,
    ConservativeTileT<RealType>* d_U_pool, PrimitiveTileT<RealType>* d_states_pool) {
    
    int pool_idx = blockIdx.x;
    if (pool_idx >= current_pool_size) return;
    
    int k = threadIdx.x * TILE_SIZE + threadIdx.y;
    
    RealType u_rho = d_U_pool[pool_idx].rho[k];
    RealType u_rhour = d_U_pool[pool_idx].rhour[k];
    RealType u_rhouz = d_U_pool[pool_idx].rhouz[k];
    RealType u_E = d_U_pool[pool_idx].E[k];
    RealType u_alpha1 = d_U_pool[pool_idx].alpha1[k];
    RealType u_alpha2 = d_U_pool[pool_idx].alpha2[k];
    RealType u_arho1 = d_U_pool[pool_idx].arho1[k];
    RealType u_arho2 = d_U_pool[pool_idx].arho2[k];

    const RealType rho_floor = (RealType)1e-8;
    const RealType p_floor = (RealType)1e-8;

    bool bad = isnan(u_rho) || isinf(u_rho) || u_rho < rho_floor ||
               isnan(u_rhour) || isinf(u_rhour) ||
               isnan(u_rhouz) || isinf(u_rhouz) ||
               isnan(u_E) || isinf(u_E);

    RealType p = ambient_p;
    RealType ur = 0.0;
    RealType uz = 0.0;

    if (!bad) {
        RealType rho_safe = fmax(u_rho, rho_floor);
        ur = u_rhour / rho_safe;
        uz = u_rhouz / rho_safe;
        RealType ke = 0.5 * rho_safe * (ur * ur + uz * uz);

        RealType alpha1 = fmax((RealType)0.0, fmin((RealType)1.0, u_alpha1));
        RealType alpha2 = fmax((RealType)0.0, fmin((RealType)1.0, u_alpha2));
        if (alpha1 + alpha2 > (RealType)1.0) {
            RealType sum = alpha1 + alpha2;
            alpha1 /= sum;
            alpha2 /= sum;
        }

        RealType arho1 = fmax((RealType)0.0, fmin(u_rho, u_arho1));
        RealType arho2 = fmax((RealType)0.0, fmin(u_rho, u_arho2));
        if (arho1 + arho2 > u_rho) {
            RealType sum = arho1 + arho2;
            arho1 = (arho1 / sum) * u_rho;
            arho2 = (arho2 / sum) * u_rho;
        }

        RealType e_internal = fmax(u_E - ke, p_floor / (gamma - (RealType)1.0));
        p = MultiMat::getMixturePressure(e_internal, u_rho, alpha1, alpha2, arho1, arho2, gamma, d_materials->products, d_materials->unreacted);
        
        if (isnan(p) || isinf(p)) {
            bad = true;
        } else {
            p = fmax(p, p_floor);
            d_states_pool[pool_idx].rho[k] = rho_safe;
            d_states_pool[pool_idx].ur[k] = ur;
            d_states_pool[pool_idx].uz[k] = uz;
            d_states_pool[pool_idx].E[k] = u_E;
            d_states_pool[pool_idx].alpha1[k] = alpha1;
            d_states_pool[pool_idx].alpha2[k] = alpha2;
            d_states_pool[pool_idx].arho1[k] = arho1;
            d_states_pool[pool_idx].arho2[k] = arho2;
            d_states_pool[pool_idx].p[k] = p;
        }
    }

    if (bad) {
        d_states_pool[pool_idx].rho[k] = ambient_rho;
        d_states_pool[pool_idx].ur[k] = 0.0;
        d_states_pool[pool_idx].uz[k] = 0.0;
        d_states_pool[pool_idx].p[k] = ambient_p;
        d_states_pool[pool_idx].alpha1[k] = 0.0;
        d_states_pool[pool_idx].alpha2[k] = 0.0;
        d_states_pool[pool_idx].arho1[k] = 0.0;
        d_states_pool[pool_idx].arho2[k] = 0.0;
        d_states_pool[pool_idx].E[k] = ambient_p / (gamma - (RealType)1.0);

        d_U_pool[pool_idx].rho[k] = ambient_rho;
        d_U_pool[pool_idx].rhour[k] = 0.0;
        d_U_pool[pool_idx].rhouz[k] = 0.0;
        d_U_pool[pool_idx].E[k] = d_states_pool[pool_idx].E[k];
        d_U_pool[pool_idx].alpha1[k] = 0.0;
        d_U_pool[pool_idx].alpha2[k] = 0.0;
        d_U_pool[pool_idx].arho1[k] = 0.0;
        d_U_pool[pool_idx].arho2[k] = 0.0;
    }
}

template <typename RealType>
__global__ void computeMaxWaveSpeed_kernel(
    int current_pool_size, RealType gamma, MultiMat::MaterialSet* d_materials,
    PrimitiveTileT<RealType>* d_states_pool, RealType* d_block_maxes) {
    
    int pool_idx = blockIdx.x;
    if (pool_idx >= current_pool_size) return;
    
    int local_i = threadIdx.x;
    int local_j = threadIdx.y;
    int k = local_i * TILE_SIZE + local_j;
    
    RealType p = d_states_pool[pool_idx].p[k];
    RealType rho = d_states_pool[pool_idx].rho[k];
    RealType alpha1 = d_states_pool[pool_idx].alpha1[k];
    RealType alpha2 = d_states_pool[pool_idx].alpha2[k];
    RealType arho1 = d_states_pool[pool_idx].arho1[k];
    RealType arho2 = d_states_pool[pool_idx].arho2[k];
    RealType ur = d_states_pool[pool_idx].ur[k];
    RealType uz = d_states_pool[pool_idx].uz[k];
    
    using std::abs;
    using std::fmax;
    RealType c = MultiMat::getMixtureSoundSpeed(
        p, rho, alpha1, alpha2, arho1, arho2, gamma,
        d_materials->products, d_materials->unreacted
    );
    double s = fmax(fabs(ur), fabs(uz)) + c;
    
    __shared__ RealType s_data[256];
    int tid = threadIdx.x * TILE_SIZE + threadIdx.y;
    s_data[tid] = (RealType)s;
    __syncthreads();
    
    for (unsigned int s_step = 128; s_step > 0; s_step >>= 1) {
        if (tid < s_step) {
            s_data[tid] = fmax(s_data[tid], s_data[tid + s_step]);
        }
        __syncthreads();
    }
    
    if (tid == 0) {
        d_block_maxes[pool_idx] = s_data[0];
    }
}

template <typename RealType>
__global__ void checkTileActive_kernel(
    int current_pool_size, RealType ambient_p,
    PrimitiveTileT<RealType>* d_states_pool, uint8_t* d_tile_active_flags) {
    
    int pool_idx = blockIdx.x;
    if (pool_idx >= current_pool_size) return;
    
    int local_i = threadIdx.x;
    int local_j = threadIdx.y;
    int k = local_i * TILE_SIZE + local_j;
    
    RealType p = d_states_pool[pool_idx].p[k];
    RealType ur = d_states_pool[pool_idx].ur[k];
    RealType uz = d_states_pool[pool_idx].uz[k];
    
    bool is_active = (fabs((double)(p - ambient_p)) / (double)ambient_p > 1e-4) ||
                     (fabs((double)ur) > 1e-2) ||
                     (fabs((double)uz) > 1e-2);
                     
    __shared__ bool s_active[256];
    int tid = threadIdx.x * TILE_SIZE + threadIdx.y;
    s_active[tid] = is_active;
    __syncthreads();
    
    for (unsigned int s_step = 128; s_step > 0; s_step >>= 1) {
        if (tid < s_step) {
            s_active[tid] = s_active[tid] || s_active[tid + s_step];
        }
        __syncthreads();
    }
    
    if (tid == 0) {
        d_tile_active_flags[pool_idx] = s_active[0] ? 1 : 0;
    }
}

template <typename RealType>
__global__ void checkTerminationCudaKernel(
    const int32_t* tile_map, const PrimitiveTileT<RealType>* states_pool,
    int nr_cells, int nz_cells, int num_tiles_z, RealType ambient_p, RealType threshold,
    int bcRmin, int bcRmax, int bcZmin, int bcZmax,
    int* d_terminated) {
    
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    
    // Check bcRmin or bcRmax along z axis
    if (idx < nz_cells) {
        int j = idx;
        if (bcRmin == 2) { // OUTFLOW_RIEMANN is 2
            int tr = 0; // i = 0 is tile_tr = 0
            int tz = j / TILE_SIZE;
            int pool_idx = tile_map[tr * num_tiles_z + tz];
            if (pool_idx != -1) {
                int local_i = 0;
                int local_j = j % TILE_SIZE;
                if (states_pool[pool_idx].p[local_i * TILE_SIZE + local_j] > threshold) {
                    *d_terminated = 1;
                }
            }
        }
        if (bcRmax == 2) {
            int tr = (nr_cells - 1) / TILE_SIZE;
            int tz = j / TILE_SIZE;
            int pool_idx = tile_map[tr * num_tiles_z + tz];
            if (pool_idx != -1) {
                int local_i = (nr_cells - 1) % TILE_SIZE;
                int local_j = j % TILE_SIZE;
                if (states_pool[pool_idx].p[local_i * TILE_SIZE + local_j] > threshold) {
                    *d_terminated = 1;
                }
            }
        }
    }
    
    // Check bcZmin or bcZmax along r axis
    if (idx < nr_cells) {
        int i = idx;
        if (bcZmin == 2) {
            int tr = i / TILE_SIZE;
            int tz = 0;
            int pool_idx = tile_map[tr * num_tiles_z + tz];
            if (pool_idx != -1) {
                int local_i = i % TILE_SIZE;
                int local_j = 0;
                if (states_pool[pool_idx].p[local_i * TILE_SIZE + local_j] > threshold) {
                    *d_terminated = 1;
                }
            }
        }
        if (bcZmax == 2) {
            int tr = i / TILE_SIZE;
            int tz = (nz_cells - 1) / TILE_SIZE;
            int pool_idx = tile_map[tr * num_tiles_z + tz];
            if (pool_idx != -1) {
                int local_i = i % TILE_SIZE;
                int local_j = (nz_cells - 1) % TILE_SIZE;
                if (states_pool[pool_idx].p[local_i * TILE_SIZE + local_j] > threshold) {
                    *d_terminated = 1;
                }
            }
        }
    }
}

// --------------------------------------------------------------------------------------
// Class Implementation

template <typename RealType>
CFDSolver2DCudaImpl<RealType>::CFDSolver2DCudaImpl(int nr, int nz, double max_r, double max_z, double gamma)
    : nr_cells(nr), nz_cells(nz), max_r(max_r), max_z(max_z), gamma(gamma), currentTime(0.0), currentScheme(RUSANOV),
      ambient_rho(1.2), ambient_p(101325.0), current_pool_size(0), is_ideal_gas(false), d_block_maxes(nullptr), d_tile_active_flags(nullptr),
      d_telemetry_buf(nullptr), telemetry_buf_size(0) {
    
    dr = max_r / nr_cells;
    dz = max_z / nz_cells;

    num_tiles_r = (nr_cells + TILE_SIZE - 1) / TILE_SIZE;
    num_tiles_z = (nz_cells + TILE_SIZE - 1) / TILE_SIZE;
    
    max_active_tiles = (num_tiles_r * num_tiles_z) * 0.25; 
    if (max_active_tiles < 10) max_active_tiles = 10;
    
    host_tile_map.resize(num_tiles_r * num_tiles_z, -1);
    host_states_pool.resize(max_active_tiles);
    host_U_pool.resize(max_active_tiles);

    CUDA_CHECK(cudaMalloc(&d_tile_map, num_tiles_r * num_tiles_z * sizeof(int32_t)));
    CUDA_CHECK(cudaMemcpy(d_tile_map, host_tile_map.data(), host_tile_map.size() * sizeof(int32_t), cudaMemcpyHostToDevice));
    
    CUDA_CHECK(cudaMalloc(&d_states_pool, max_active_tiles * sizeof(PrimitiveTileT<RealType>)));
    CUDA_CHECK(cudaMalloc(&d_U_pool, max_active_tiles * sizeof(ConservativeTileT<RealType>)));
    CUDA_CHECK(cudaMalloc(&d_dU_pool, max_active_tiles * sizeof(ConservativeTileT<RealType>)));
    CUDA_CHECK(cudaMalloc(&d_block_maxes, max_active_tiles * sizeof(RealType)));
    CUDA_CHECK(cudaMalloc(&d_tile_active_flags, max_active_tiles * sizeof(uint8_t)));
    
    MultiMat::initializePrecalculatedTerms(currentMaterials);
    CUDA_CHECK(cudaMalloc(&d_materials, sizeof(MultiMat::MaterialSet)));
    CUDA_CHECK(cudaMemcpy(d_materials, &currentMaterials, sizeof(MultiMat::MaterialSet), cudaMemcpyHostToDevice));
    CUDA_CHECK(cudaMalloc(&d_terminated, sizeof(int)));
    int zero = 0;
    CUDA_CHECK(cudaMemcpy(d_terminated, &zero, sizeof(int), cudaMemcpyHostToDevice));
}

template <typename RealType>
CFDSolver2DCudaImpl<RealType>::~CFDSolver2DCudaImpl() {
    cudaDeviceSynchronize(); // flush all in-flight work before freeing
    cudaFree(d_tile_map);
    cudaFree(d_states_pool);
    cudaFree(d_U_pool);
    cudaFree(d_dU_pool);
    cudaFree(d_materials);
    if (d_block_maxes) cudaFree(d_block_maxes);
    if (d_tile_active_flags) cudaFree(d_tile_active_flags);
    if (d_terminated) cudaFree(d_terminated);

    if (d_gauge_coords) cudaFree(d_gauge_coords);
    if (d_gauge_results) cudaFree(d_gauge_results);
    if (host_pinned_gauge_data) cudaFreeHost(host_pinned_gauge_data);
    if (gauge_stream) cudaStreamDestroy((cudaStream_t)gauge_stream);
    if (step_done) cudaEventDestroy((cudaEvent_t)step_done);
    if (d_telemetry_buf) cudaFree(d_telemetry_buf);
}

template <typename RealType>
void CFDSolver2DCudaImpl<RealType>::setMaterialParameters(const MultiMat::MaterialSet& materials) {
    currentMaterials = materials;
    MultiMat::initializePrecalculatedTerms(currentMaterials);
    CUDA_CHECK(cudaMemcpy(d_materials, &currentMaterials, sizeof(MultiMat::MaterialSet), cudaMemcpyHostToDevice));
}

template <typename RealType>
void CFDSolver2DCudaImpl<RealType>::growTilePool(int new_max_tiles) {
    if (new_max_tiles <= max_active_tiles) return;

    host_states_pool.resize(new_max_tiles);
    host_U_pool.resize(new_max_tiles);

    PrimitiveTileT<RealType>* d_new_states_pool = nullptr;
    ConservativeTileT<RealType>* d_new_U_pool = nullptr;
    ConservativeTileT<RealType>* d_new_dU_pool = nullptr;
    RealType* d_new_block_maxes = nullptr;
    uint8_t* d_new_tile_active_flags = nullptr;

    CUDA_CHECK(cudaMalloc(&d_new_states_pool, new_max_tiles * sizeof(PrimitiveTileT<RealType>)));
    CUDA_CHECK(cudaMalloc(&d_new_U_pool, new_max_tiles * sizeof(ConservativeTileT<RealType>)));
    CUDA_CHECK(cudaMalloc(&d_new_dU_pool, new_max_tiles * sizeof(ConservativeTileT<RealType>)));
    CUDA_CHECK(cudaMalloc(&d_new_block_maxes, new_max_tiles * sizeof(RealType)));
    CUDA_CHECK(cudaMalloc(&d_new_tile_active_flags, new_max_tiles * sizeof(uint8_t)));

    if (current_pool_size > 0) {
        CUDA_CHECK(cudaMemcpy(d_new_states_pool, d_states_pool, current_pool_size * sizeof(PrimitiveTileT<RealType>), cudaMemcpyDeviceToDevice));
        CUDA_CHECK(cudaMemcpy(d_new_U_pool, d_U_pool, current_pool_size * sizeof(ConservativeTileT<RealType>), cudaMemcpyDeviceToDevice));
        CUDA_CHECK(cudaMemcpy(d_new_dU_pool, d_dU_pool, current_pool_size * sizeof(ConservativeTileT<RealType>), cudaMemcpyDeviceToDevice));
    }

    if (d_states_pool) CUDA_CHECK(cudaFree(d_states_pool));
    if (d_U_pool) CUDA_CHECK(cudaFree(d_U_pool));
    if (d_dU_pool) CUDA_CHECK(cudaFree(d_dU_pool));
    if (d_block_maxes) CUDA_CHECK(cudaFree(d_block_maxes));
    if (d_tile_active_flags) CUDA_CHECK(cudaFree(d_tile_active_flags));

    d_states_pool = d_new_states_pool;
    d_U_pool = d_new_U_pool;
    d_dU_pool = d_new_dU_pool;
    d_block_maxes = d_new_block_maxes;
    d_tile_active_flags = d_new_tile_active_flags;
    max_active_tiles = new_max_tiles;
}

template <typename RealType>
int CFDSolver2DCudaImpl<RealType>::allocateTile(int tr, int tz) {
    if (tr < 0 || tr >= num_tiles_r || tz < 0 || tz >= num_tiles_z) return -1;
    int flat_idx = tr * num_tiles_z + tz;
    if (host_tile_map[flat_idx] != -1) return host_tile_map[flat_idx];
    
    if (current_pool_size >= max_active_tiles) {
        growTilePool(max_active_tiles * 1.5);
    }
    
    int pool_idx = current_pool_size++;
    initTileToAmbientHost(pool_idx);
    host_tile_map[flat_idx] = pool_idx;
    
    return pool_idx;
}

template <typename RealType>
void CFDSolver2DCudaImpl<RealType>::initTileToAmbientHost(int pool_idx) {
    for (int k = 0; k < TILE_SIZE * TILE_SIZE; ++k) {
        host_states_pool[pool_idx].rho[k] = (RealType)ambient_rho;
        host_states_pool[pool_idx].ur[k] = 0.0;
        host_states_pool[pool_idx].uz[k] = 0.0;
        host_states_pool[pool_idx].p[k] = (RealType)ambient_p;
        host_states_pool[pool_idx].alpha1[k] = 0.0;
        host_states_pool[pool_idx].alpha2[k] = 0.0;
        host_states_pool[pool_idx].arho1[k] = 0.0;
        host_states_pool[pool_idx].arho2[k] = 0.0;
        host_states_pool[pool_idx].floor_status[k] = 0;
        
        if (is_ideal_gas) {
            host_states_pool[pool_idx].E[k] = (RealType)ambient_p / ((RealType)gamma - (RealType)1.0);
        } else {
            host_states_pool[pool_idx].E[k] = (RealType)(ambient_rho * MultiMat::getEnergy_IdealGas(ambient_p, ambient_rho, gamma));
        }
        
        host_U_pool[pool_idx].rho[k] = (RealType)ambient_rho;
        host_U_pool[pool_idx].rhour[k] = 0.0;
        host_U_pool[pool_idx].rhouz[k] = 0.0;
        host_U_pool[pool_idx].E[k] = host_states_pool[pool_idx].E[k];
        host_U_pool[pool_idx].alpha1[k] = 0.0;
        host_U_pool[pool_idx].alpha2[k] = 0.0;
        host_U_pool[pool_idx].arho1[k] = 0.0;
        host_U_pool[pool_idx].arho2[k] = 0.0;
    }
}

template <typename RealType>
void CFDSolver2DCudaImpl<RealType>::syncPoolToDevice() {
    if (current_pool_size == 0) return;
    CUDA_CHECK(cudaMemcpy(d_tile_map, host_tile_map.data(), host_tile_map.size() * sizeof(int32_t), cudaMemcpyHostToDevice));
    CUDA_CHECK(cudaMemcpy(d_states_pool, host_states_pool.data(), current_pool_size * sizeof(PrimitiveTileT<RealType>), cudaMemcpyHostToDevice));
    CUDA_CHECK(cudaMemcpy(d_U_pool, host_U_pool.data(), current_pool_size * sizeof(ConservativeTileT<RealType>), cudaMemcpyHostToDevice));
}

template <typename RealType>
void CFDSolver2DCudaImpl<RealType>::setInitialConditionTNT(double explosive_z, double explosive_radius, 
                                            double high_rho, 
                                            double ambient_rho, double ambient_p, double explosive_r) {
    this->ambient_rho = ambient_rho;
    this->ambient_p = ambient_p;
    this->det_x = explosive_r;
    this->det_y = 0.0;
    this->det_z = explosive_z;
    this->is_ideal_gas = false;

    // Reset tile pool to clear stale states
    std::fill(host_tile_map.begin(), host_tile_map.end(), -1);
    current_pool_size = 0;

    for (int i = 0; i < nr_cells; ++i) {
        for (int j = 0; j < nz_cells; ++j) {
            double sum_w = 0.0;
            double sum_w_inside = 0.0;
            for (int ki = 0; ki < 8; ++ki) {
                double r_sub = i * dr + (ki + 0.5) * (dr / 8.0);
                double w = r_sub;
                for (int kj = 0; kj < 8; ++kj) {
                    double z_sub = j * dz + (kj + 0.5) * (dz / 8.0);
                    double dist = std::sqrt((r_sub - explosive_r) * (r_sub - explosive_r) + (z_sub - explosive_z) * (z_sub - explosive_z));
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

                host_states_pool[pool_idx].rho[local_idx] = (RealType)rho;
                host_states_pool[pool_idx].p[local_idx] = (RealType)ambient_p;
                host_states_pool[pool_idx].alpha1[local_idx] = 0.0; 
                host_states_pool[pool_idx].alpha2[local_idx] = (RealType)alpha2;
                host_states_pool[pool_idx].arho1[local_idx] = 0.0; 
                host_states_pool[pool_idx].arho2[local_idx] = (RealType)arho2;
                host_states_pool[pool_idx].ur[local_idx] = 0.0; 
                host_states_pool[pool_idx].uz[local_idx] = 0.0;
                host_states_pool[pool_idx].E[local_idx] = (RealType)E;
                
                host_U_pool[pool_idx].rho[local_idx] = (RealType)rho;
                host_U_pool[pool_idx].rhour[local_idx] = 0.0;
                host_U_pool[pool_idx].rhouz[local_idx] = 0.0;
                host_U_pool[pool_idx].E[local_idx] = (RealType)E;
                host_U_pool[pool_idx].alpha1[local_idx] = 0.0;
                host_U_pool[pool_idx].alpha2[local_idx] = (RealType)alpha2;
                host_U_pool[pool_idx].arho1[local_idx] = 0.0;
                host_U_pool[pool_idx].arho2[local_idx] = (RealType)arho2;
            }
        }
    }
    
    syncPoolToDevice();
}

template <typename RealType>
void CFDSolver2DCudaImpl<RealType>::setInitialConditionFrom1D(double explosive_z, double remap_radius,
                                           const std::vector<double>& r_1d,
                                           const std::vector<MultiMaterialState>& states_1d,
                                           double ambient_rho, double ambient_p,
                                           double explosive_r) {
    this->ambient_rho = ambient_rho;
    this->ambient_p = ambient_p;
    this->det_x = explosive_r;
    this->det_y = 0.0;
    this->det_z = explosive_z;
    
    // Clear and reset tile pool to prevent stale/accumulated state from previous runs
    std::fill(host_tile_map.begin(), host_tile_map.end(), -1);
    current_pool_size = 0;

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
            
            int tr = i / TILE_SIZE;
            int tz = j / TILE_SIZE;
            int pool_idx = allocateTile(tr, tz);
            
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
                double w_sub = r_sub; // Uniform weight in Cartesian, radial in axisymmetric

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
                        if (is_ideal_gas) {
                            E_sub = p_sub / (gamma - 1.0) + 0.5 * rho_sub * (ur_sub * ur_sub + uz_sub * uz_sub);
                        } else {
                            E_sub = MultiMat::getMixtureEnergy(p_sub, rho_sub, alpha1_sub, alpha2_sub, arho1_sub, arho2_sub, gamma, currentMaterials.products, currentMaterials.unreacted) + 0.5 * rho_sub * (ur_sub * ur_sub + uz_sub * uz_sub);
                        }
                    } else {
                        rho_sub = ambient_rho;
                        ur_sub = 0.0;
                        uz_sub = 0.0;
                        p_sub = ambient_p;
                        alpha1_sub = 0.0;
                        alpha2_sub = 0.0;
                        arho1_sub = 0.0;
                        arho2_sub = 0.0;
                        if (is_ideal_gas) {
                            E_sub = p_sub / (gamma - 1.0) + 0.5 * rho_sub * (ur_sub * ur_sub + uz_sub * uz_sub);
                        } else {
                            E_sub = MultiMat::getMixtureEnergy(p_sub, rho_sub, alpha1_sub, alpha2_sub, arho1_sub, arho2_sub, gamma, currentMaterials.products, currentMaterials.unreacted) + 0.5 * rho_sub * (ur_sub * ur_sub + uz_sub * uz_sub);
                        }
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

            host_U_pool[pool_idx].rho[local_idx]   = (RealType)(sum_rho_w / sum_w);
            host_U_pool[pool_idx].rhour[local_idx] = (RealType)(sum_rhour_w / sum_w);
            host_U_pool[pool_idx].rhouz[local_idx] = (RealType)(sum_rhouz_w / sum_w);
            host_U_pool[pool_idx].E[local_idx]     = (RealType)(sum_E_w / sum_w);
            host_U_pool[pool_idx].alpha1[local_idx] = (RealType)(sum_alpha1_w / sum_w);
            host_U_pool[pool_idx].alpha2[local_idx] = (RealType)(sum_alpha2_w / sum_w);
            host_U_pool[pool_idx].arho1[local_idx]  = (RealType)(sum_arho1_w / sum_w);
            host_U_pool[pool_idx].arho2[local_idx]  = (RealType)(sum_arho2_w / sum_w);
        }
    }

    // Direct CPU implementation of updatePrimitiveFromConservative on host maps
    #pragma omp parallel for
    for (int pool_idx = 0; pool_idx < current_pool_size; ++pool_idx) {
        for (int k = 0; k < TILE_SIZE * TILE_SIZE; ++k) {
            double rho_safe = std::max((double)host_U_pool[pool_idx].rho[k], 1e-8);
            double ur = (double)host_U_pool[pool_idx].rhour[k] / rho_safe;
            double uz = (double)host_U_pool[pool_idx].rhouz[k] / rho_safe;
            double ke = 0.5 * rho_safe * (ur * ur + uz * uz);

            double alpha1 = std::max(0.0, std::min(1.0, (double)host_U_pool[pool_idx].alpha1[k]));
            double alpha2 = std::max(0.0, std::min(1.0, (double)host_U_pool[pool_idx].alpha2[k]));
            if (alpha1 + alpha2 > 1.0) {
                double sum = alpha1 + alpha2;
                alpha1 /= sum;
                alpha2 /= sum;
            }

            double arho1 = std::max(0.0, std::min(rho_safe, (double)host_U_pool[pool_idx].arho1[k]));
            double arho2 = std::max(0.0, std::min(rho_safe, (double)host_U_pool[pool_idx].arho2[k]));
            if (arho1 + arho2 > rho_safe) {
                double sum = arho1 + arho2;
                arho1 = (arho1 / sum) * rho_safe;
                arho2 = (arho2 / sum) * rho_safe;
            }

            double e_internal = std::max((double)host_U_pool[pool_idx].E[k] - ke, 1e-8 / (gamma - 1.0));
            double p = MultiMat::getMixturePressure(e_internal, rho_safe, alpha1, alpha2, arho1, arho2, gamma, currentMaterials.products, currentMaterials.unreacted);

            host_states_pool[pool_idx].rho[k] = (RealType)rho_safe;
            host_states_pool[pool_idx].ur[k] = (RealType)ur;
            host_states_pool[pool_idx].uz[k] = (RealType)uz;
            host_states_pool[pool_idx].E[k] = host_U_pool[pool_idx].E[k];
            host_states_pool[pool_idx].alpha1[k] = (RealType)alpha1;
            host_states_pool[pool_idx].alpha2[k] = (RealType)alpha2;
            host_states_pool[pool_idx].arho1[k] = (RealType)arho1;
            host_states_pool[pool_idx].arho2[k] = (RealType)arho2;
            host_states_pool[pool_idx].p[k] = (RealType)p;
        }
    }

    syncPoolToDevice();
}

template <typename RealType>
void CFDSolver2DCudaImpl<RealType>::setInitialConditionTNTCylinder(double explosive_z, double radius, double height, double high_rho, double ambient_rho, double ambient_p, double explosive_r) {
    this->ambient_rho = ambient_rho;
    this->ambient_p = ambient_p;
    this->det_x = explosive_r;
    this->det_y = 0.0;
    this->det_z = explosive_z + height / 2.0;
    this->is_ideal_gas = false;

    // Reset tile pool to clear stale states
    std::fill(host_tile_map.begin(), host_tile_map.end(), -1);
    current_pool_size = 0;

    for (int i = 0; i < nr_cells; ++i) {
        for (int j = 0; j < nz_cells; ++j) {
            double sum_w = 0.0;
            double sum_w_inside = 0.0;
            for (int ki = 0; ki < 8; ++ki) {
                double r_sub = i * dr + (ki + 0.5) * (dr / 8.0);
                double w = r_sub;
                for (int kj = 0; kj < 8; ++kj) {
                    double z_sub = j * dz + (kj + 0.5) * (dz / 8.0);
                    bool inside = (std::abs(r_sub - explosive_r) <= radius) && (std::abs(z_sub - explosive_z) <= height / 2.0);
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

                host_states_pool[pool_idx].rho[local_idx] = (RealType)rho;
                host_states_pool[pool_idx].p[local_idx] = (RealType)ambient_p;
                host_states_pool[pool_idx].alpha1[local_idx] = 0.0; host_states_pool[pool_idx].alpha2[local_idx] = (RealType)alpha2;
                host_states_pool[pool_idx].arho1[local_idx] = 0.0; host_states_pool[pool_idx].arho2[local_idx] = (RealType)arho2;
                host_states_pool[pool_idx].ur[local_idx] = 0.0; host_states_pool[pool_idx].uz[local_idx] = 0.0;
                host_states_pool[pool_idx].E[local_idx] = (RealType)E;
                
                host_U_pool[pool_idx].rho[local_idx] = (RealType)rho;
                host_U_pool[pool_idx].rhour[local_idx] = 0.0;
                host_U_pool[pool_idx].rhouz[local_idx] = 0.0;
                host_U_pool[pool_idx].E[local_idx] = (RealType)E;
                host_U_pool[pool_idx].alpha1[local_idx] = 0.0; host_U_pool[pool_idx].alpha2[local_idx] = (RealType)alpha2;
                host_U_pool[pool_idx].arho1[local_idx] = 0.0; host_U_pool[pool_idx].arho2[local_idx] = (RealType)arho2;
            }
        }
    }

    syncPoolToDevice();
}

template <typename RealType>
void CFDSolver2DCudaImpl<RealType>::setInitialConditionIdealGas(double explosive_z, double explosive_radius, double high_rho, double detonation_energy, double ambient_rho, double ambient_p, double explosive_r) {
    this->ambient_rho = ambient_rho;
    this->ambient_p = ambient_p;
    this->det_x = explosive_r;
    this->det_y = 0.0;
    this->det_z = explosive_z;
    this->is_ideal_gas = true;

    // Reset tile pool to clear stale states
    std::fill(host_tile_map.begin(), host_tile_map.end(), -1);
    current_pool_size = 0;

    double p_high = (gamma - 1.0) * high_rho * detonation_energy;

    for (int i = 0; i < nr_cells; ++i) {
        for (int j = 0; j < nz_cells; ++j) {
            double sum_w = 0.0;
            double sum_w_inside = 0.0;
            for (int ki = 0; ki < 8; ++ki) {
                double r_sub = i * dr + (ki + 0.5) * (dr / 8.0);
                double w = r_sub;
                for (int kj = 0; kj < 8; ++kj) {
                    double z_sub = j * dz + (kj + 0.5) * (dz / 8.0);
                    double dist = std::sqrt((r_sub - explosive_r) * (r_sub - explosive_r) + (z_sub - explosive_z) * (z_sub - explosive_z));
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

                host_states_pool[pool_idx].rho[local_idx] = (RealType)rho;
                host_states_pool[pool_idx].p[local_idx] = (RealType)p;
                host_states_pool[pool_idx].alpha1[local_idx] = 0.0; host_states_pool[pool_idx].alpha2[local_idx] = 0.0;
                host_states_pool[pool_idx].arho1[local_idx] = 0.0; host_states_pool[pool_idx].arho2[local_idx] = 0.0;
                host_states_pool[pool_idx].ur[local_idx] = 0.0; host_states_pool[pool_idx].uz[local_idx] = 0.0;
                host_states_pool[pool_idx].E[local_idx] = (RealType)E;
                
                host_U_pool[pool_idx].rho[local_idx] = (RealType)rho;
                host_U_pool[pool_idx].rhour[local_idx] = 0.0;
                host_U_pool[pool_idx].rhouz[local_idx] = 0.0;
                host_U_pool[pool_idx].E[local_idx] = (RealType)E;
                host_U_pool[pool_idx].alpha1[local_idx] = 0.0; host_U_pool[pool_idx].alpha2[local_idx] = 0.0;
                host_U_pool[pool_idx].arho1[local_idx] = 0.0; host_U_pool[pool_idx].arho2[local_idx] = 0.0;
            }
        }
    }

    syncPoolToDevice();
}

template <typename RealType>
void CFDSolver2DCudaImpl<RealType>::setFluxScheme(const std::string& scheme_name) {
    if (scheme_name == "ausm_plus" || scheme_name == "AUSMPlus" || scheme_name == "ausm+" || scheme_name == "AUSM+") {
        currentScheme = AUSM_PLUS;
    } else {
        currentScheme = RUSANOV;
    }
}

template <typename RealType>
void CFDSolver2DCudaImpl<RealType>::run(double duration) {
    double target_time = currentTime + duration;
    while (currentTime < target_time) {
        double max_s = getMaxWaveSpeed();
        double dt = 0.35 * std::min(dr, dz) / max_s;
        if (currentTime + dt > target_time) dt = target_time - currentTime;
        step(dt);
    }
}

template <typename RealType>
void CFDSolver2DCudaImpl<RealType>::updateActiveRegionHost() {
    if (current_pool_size == 0) return;
    
    dim3 threads(TILE_SIZE, TILE_SIZE);
    checkTileActive_kernel<<<current_pool_size, threads>>>(current_pool_size, (RealType)ambient_p, d_states_pool, d_tile_active_flags);
    CUDA_CHECK(cudaGetLastError());
    
    std::vector<uint8_t> host_tile_active_flags(current_pool_size);
    CUDA_CHECK(cudaMemcpy(host_tile_active_flags.data(), d_tile_active_flags, current_pool_size * sizeof(uint8_t), cudaMemcpyDeviceToHost));
    
    int initial_pool_size = current_pool_size;
    bool expanded = false;
    std::vector<int32_t> new_map = host_tile_map;
    
    for (int tr = 0; tr < num_tiles_r; ++tr) {
        for (int tz = 0; tz < num_tiles_z; ++tz) {
            int pool_idx = host_tile_map[tr * num_tiles_z + tz];
            if (pool_idx == -1 || pool_idx >= initial_pool_size) continue;
            
            if (host_tile_active_flags[pool_idx]) {
                int neighbors[4][2] = {{tr-1, tz}, {tr+1, tz}, {tr, tz-1}, {tr, tz+1}};
                for (int n = 0; n < 4; ++n) {
                    int ntr = neighbors[n][0];
                    int ntz = neighbors[n][1];
                    if (ntr >= 0 && ntr < num_tiles_r && ntz >= 0 && ntz < num_tiles_z) {
                        int n_flat = ntr * num_tiles_z + ntz;
                        if (new_map[n_flat] == -1) {
                            int new_pool_idx = allocateTile(ntr, ntz);
                            new_map[n_flat] = new_pool_idx;
                            expanded = true;
                        }
                    }
                }
            }
        }
    }
    
    if (expanded) {
        host_tile_map = new_map;
        int num_new_tiles = current_pool_size - initial_pool_size;
        if (num_new_tiles > 0) {
            CUDA_CHECK(cudaMemcpy(d_states_pool + initial_pool_size, host_states_pool.data() + initial_pool_size, num_new_tiles * sizeof(PrimitiveTileT<RealType>), cudaMemcpyHostToDevice));
            CUDA_CHECK(cudaMemcpy(d_U_pool + initial_pool_size, host_U_pool.data() + initial_pool_size, num_new_tiles * sizeof(ConservativeTileT<RealType>), cudaMemcpyHostToDevice));
            CUDA_CHECK(cudaMemcpy(d_tile_map, host_tile_map.data(), host_tile_map.size() * sizeof(int32_t), cudaMemcpyHostToDevice));
        }
    }
}

template <typename RealType>
void CFDSolver2DCudaImpl<RealType>::step(double dt) {
    dim3 threads(TILE_SIZE, TILE_SIZE);
    dim3 blocks(num_tiles_r, num_tiles_z);
    
    RealType dt_r = (RealType)dt;
    RealType dr_r = (RealType)dr;
    RealType dz_r = (RealType)dz;
    RealType gamma_r = (RealType)gamma;
    RealType ambient_rho_r = (RealType)ambient_rho;
    RealType ambient_p_r = (RealType)ambient_p;
    RealType currentTime_r = (RealType)currentTime;
    RealType det_x_r = (RealType)det_x;
    RealType det_y_r = (RealType)det_y;
    RealType det_z_r = (RealType)det_z;

    if (temporalOrder == 1) {
        computeTileRHS_kernel<<<blocks, threads>>>(
            num_tiles_r, num_tiles_z, nr_cells, nz_cells, dr_r, dz_r, gamma_r, (RealType)1.0, (RealType)0.0, d_materials, d_tile_map, d_states_pool, d_dU_pool, spatialOrder, is_ideal_gas,
            static_cast<int>(bcRmin), static_cast<int>(bcRmax), static_cast<int>(bcZmin), static_cast<int>(bcZmax),
            ambient_rho_r, ambient_p_r, this->is_cartesian,
            d_solid_mask, d_solid_velocities
        );
        CUDA_CHECK(cudaGetLastError());
        
        applyEulerStep_kernel<<<current_pool_size, threads>>>(current_pool_size, dt_r, d_U_pool, d_dU_pool);
        CUDA_CHECK(cudaGetLastError());
        
        updatePrimitiveFromConservative_kernel<<<current_pool_size, threads>>>(current_pool_size, gamma_r, d_materials, ambient_rho_r, ambient_p_r, d_U_pool, d_states_pool);
        CUDA_CHECK(cudaGetLastError());
    } else {
        for (int stage = 0; stage < 3; ++stage) {
            const double A[3] = {0.0, -5.0/9.0, -153.0/128.0};
            computeTileRHS_kernel<<<blocks, threads>>>(
                num_tiles_r, num_tiles_z, nr_cells, nz_cells, dr_r, dz_r, gamma_r, dt_r, (RealType)A[stage], d_materials, d_tile_map, d_states_pool, d_dU_pool, spatialOrder, is_ideal_gas,
                static_cast<int>(bcRmin), static_cast<int>(bcRmax), static_cast<int>(bcZmin), static_cast<int>(bcZmax),
                ambient_rho_r, ambient_p_r, this->is_cartesian,
                d_solid_mask, d_solid_velocities
            );
            CUDA_CHECK(cudaGetLastError());
            
            applyLSRK3Step_kernel<<<current_pool_size, threads>>>(current_pool_size, stage, d_U_pool, d_dU_pool);
            CUDA_CHECK(cudaGetLastError());
            
            updatePrimitiveFromConservative_kernel<<<current_pool_size, threads>>>(current_pool_size, gamma_r, d_materials, ambient_rho_r, ambient_p_r, d_U_pool, d_states_pool);
            CUDA_CHECK(cudaGetLastError());
        }
    }
    
    if (!is_ideal_gas) {
        applyProgrammedBurn_kernel<<<blocks, threads>>>(num_tiles_r, num_tiles_z, nr_cells, nz_cells, dr_r, dz_r, currentTime_r, dt_r, det_x_r, det_y_r, det_z_r, d_materials, d_tile_map, d_U_pool);
        CUDA_CHECK(cudaGetLastError());
        
        updatePrimitiveFromConservative_kernel<<<current_pool_size, threads>>>(current_pool_size, gamma_r, d_materials, ambient_rho_r, ambient_p_r, d_U_pool, d_states_pool);
        CUDA_CHECK(cudaGetLastError());
    }
    
    currentTime += dt;
    step_count++;
    CUDA_CHECK(cudaDeviceSynchronize());
    updateActiveRegionHost();
}

template <typename RealType>
std::vector<State2D> CFDSolver2DCudaImpl<RealType>::getStates() {
    if (current_pool_size > 0) {
        CUDA_CHECK(cudaMemcpy(host_states_pool.data(), d_states_pool, current_pool_size * sizeof(PrimitiveTileT<RealType>), cudaMemcpyDeviceToHost));
    }
    std::vector<State2D> out(nr_cells * nz_cells);
    #pragma omp parallel for collapse(2)
    for (int i = 0; i < nr_cells; ++i) {
        for (int j = 0; j < nz_cells; ++j) {
            int tr = i / TILE_SIZE;
            int tz = j / TILE_SIZE;
            int pool_idx = host_tile_map[tr * num_tiles_z + tz];
            int idx = i * nz_cells + j;
            if (pool_idx == -1) {
                out[idx].rho = ambient_rho;
                out[idx].ur = 0.0;
                out[idx].uz = 0.0;
                out[idx].p = ambient_p;
                out[idx].E = is_ideal_gas ? (ambient_p / (gamma - 1.0)) : 
                             (ambient_rho * MultiMat::getEnergy_IdealGas(ambient_p, ambient_rho, gamma));
                out[idx].alpha1 = 0.0;
                out[idx].alpha2 = 0.0;
                out[idx].arho1 = 0.0;
                out[idx].arho2 = 0.0;
                out[idx].floor_status = 0;
            } else {
                int k = (i % TILE_SIZE) * TILE_SIZE + (j % TILE_SIZE);
                out[idx].rho = (double)host_states_pool[pool_idx].rho[k];
                out[idx].ur = (double)host_states_pool[pool_idx].ur[k];
                out[idx].uz = (double)host_states_pool[pool_idx].uz[k];
                out[idx].p = (double)host_states_pool[pool_idx].p[k];
                out[idx].E = (double)host_states_pool[pool_idx].E[k];
                out[idx].alpha1 = (double)host_states_pool[pool_idx].alpha1[k];
                out[idx].alpha2 = (double)host_states_pool[pool_idx].alpha2[k];
                out[idx].arho1 = (double)host_states_pool[pool_idx].arho1[k];
                out[idx].arho2 = (double)host_states_pool[pool_idx].arho2[k];
                out[idx].floor_status = host_states_pool[pool_idx].floor_status[k];
            }
        }
    }
    return out;
}

template <typename RealType>
__global__ void gatherTelemetry2DKernel(
    const PrimitiveTileT<RealType>* states_pool,
    const int32_t* tile_map,
    float* data,
    int out_nr, int out_nz, int stride,
    int nr_cells, int nz_cells, int num_tiles_z,
    float ambient_p, float ambient_rho) {
    
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total_elements = out_nr * out_nz;
    if (idx >= total_elements) return;
    
    int i = idx / out_nz;
    int j = idx % out_nz;
    
    int src_i = (i * stride < nr_cells) ? i * stride : nr_cells - 1;
    int src_j = (j * stride < nz_cells) ? j * stride : nz_cells - 1;
    
    int tr = src_i / TILE_SIZE;
    int tz = src_j / TILE_SIZE;
    int pool_idx = tile_map[tr * num_tiles_z + tz];
    int dest_stride = total_elements;
    
    if (pool_idx == -1) {
        data[0 * dest_stride + idx] = ambient_p;
        data[1 * dest_stride + idx] = ambient_rho;
        data[2 * dest_stride + idx] = 0.0f;
        data[3 * dest_stride + idx] = 0.0f;
        data[4 * dest_stride + idx] = ambient_p / 0.4f;
        data[5 * dest_stride + idx] = 0.0f;
        data[6 * dest_stride + idx] = 0.0f;
    } else {
        int k = (src_i % TILE_SIZE) * TILE_SIZE + (src_j % TILE_SIZE);
        data[0 * dest_stride + idx] = (float)states_pool[pool_idx].p[k];
        data[1 * dest_stride + idx] = (float)states_pool[pool_idx].rho[k];
        data[2 * dest_stride + idx] = (float)states_pool[pool_idx].ur[k];
        data[3 * dest_stride + idx] = (float)states_pool[pool_idx].uz[k];
        data[4 * dest_stride + idx] = (float)states_pool[pool_idx].E[k];
        data[5 * dest_stride + idx] = (float)states_pool[pool_idx].alpha1[k];
        data[6 * dest_stride + idx] = (float)states_pool[pool_idx].alpha2[k];
    }
}

template <typename RealType>
std::vector<float> CFDSolver2DCudaImpl<RealType>::getTelemetry2D(int stride) {
    if (stride < 1) stride = 1;
    int out_nr = (nr_cells + stride - 1) / stride;
    int out_nz = (nz_cells + stride - 1) / stride;
    int n_ch = 7;
    int total_elements = out_nr * out_nz;
    size_t req_bytes = n_ch * total_elements * sizeof(float);
    
    std::vector<float> out(n_ch * total_elements);
    
    if (req_bytes > telemetry_buf_size) {
        if (d_telemetry_buf) {
            CUDA_CHECK(cudaFree(d_telemetry_buf));
        }
        CUDA_CHECK(cudaMalloc(&d_telemetry_buf, req_bytes));
        telemetry_buf_size = req_bytes;
    }
    
    int threads = 256;
    int blocks = (total_elements + threads - 1) / threads;
    
    gatherTelemetry2DKernel<RealType><<<blocks, threads>>>(
        d_states_pool,
        d_tile_map,
        d_telemetry_buf,
        out_nr, out_nz, stride,
        nr_cells, nz_cells, num_tiles_z,
        (float)ambient_p, (float)ambient_rho
    );
    CUDA_CHECK(cudaGetLastError());
    
    CUDA_CHECK(cudaMemcpy(out.data(), d_telemetry_buf, req_bytes, cudaMemcpyDeviceToHost));
    
    return out;
}

template <typename RealType>
double CFDSolver2DCudaImpl<RealType>::getMaxWaveSpeed() {
    if (current_pool_size == 0) return 340.0;
    
    dim3 threads(TILE_SIZE, TILE_SIZE);
    computeMaxWaveSpeed_kernel<<<current_pool_size, threads>>>(current_pool_size, (RealType)gamma, d_materials, d_states_pool, d_block_maxes);
    CUDA_CHECK(cudaGetLastError());
    
    std::vector<RealType> host_block_maxes(current_pool_size);
    CUDA_CHECK(cudaMemcpy(host_block_maxes.data(), d_block_maxes, current_pool_size * sizeof(RealType), cudaMemcpyDeviceToHost));
    
    double max_speed = 1e-6;
    for (int p = 0; p < current_pool_size; ++p) {
        if ((double)host_block_maxes[p] > max_speed) max_speed = (double)host_block_maxes[p];
    }
    return max_speed;
}

template <typename RealType>
bool CFDSolver2DCudaImpl<RealType>::checkTerminationCondition() {
    int h_terminated = 0;
    CUDA_CHECK(cudaMemcpy(d_terminated, &h_terminated, sizeof(int), cudaMemcpyHostToDevice));
    
    RealType threshold = (RealType)(1.05 * ambient_p);
    int max_threads = std::max(nr_cells, nz_cells);
    int threads_per_block = 256;
    int num_blocks = (max_threads + threads_per_block - 1) / threads_per_block;
    
    checkTerminationCudaKernel<<<num_blocks, threads_per_block>>>(
        d_tile_map, d_states_pool, nr_cells, nz_cells, num_tiles_z, (RealType)ambient_p, threshold,
        static_cast<int>(bcRmin), static_cast<int>(bcRmax), static_cast<int>(bcZmin), static_cast<int>(bcZmax),
        d_terminated
    );
    CUDA_CHECK(cudaGetLastError());
    CUDA_CHECK(cudaDeviceSynchronize());
    
    CUDA_CHECK(cudaMemcpy(&h_terminated, d_terminated, sizeof(int), cudaMemcpyDeviceToHost));
    return h_terminated == 1;
}

template <typename RealType>
std::vector<float> CFDSolver2DCudaImpl<RealType>::getCellValues(int i, int j) {
    std::vector<float> vals(7, 0.0f);
    if (i < 0 || i >= nr_cells || j < 0 || j >= nz_cells) return vals;
    
    int tr = i / TILE_SIZE;
    int tz = j / TILE_SIZE;
    int pool_idx = host_tile_map[tr * num_tiles_z + tz];
    
    if (pool_idx == -1) {
        vals[0] = static_cast<float>(ambient_p);
        vals[1] = static_cast<float>(ambient_rho);
        vals[2] = 0.0f;
        vals[3] = 0.0f;
        if (is_ideal_gas) {
            vals[4] = static_cast<float>(ambient_p / (gamma - 1.0));
        } else {
            vals[4] = static_cast<float>(ambient_rho * MultiMat::getEnergy_IdealGas(ambient_p, ambient_rho, gamma));
        }
        vals[5] = 0.0f;
        vals[6] = 0.0f;
    } else {
        int k = (i % TILE_SIZE) * TILE_SIZE + (j % TILE_SIZE);
        RealType h_rho = 0.0, h_ur = 0.0, h_uz = 0.0, h_p = 0.0, h_E = 0.0, h_a1 = 0.0, h_a2 = 0.0;
        
        CUDA_CHECK(cudaMemcpy(&h_rho, &(d_states_pool[pool_idx].rho[k]), sizeof(RealType), cudaMemcpyDeviceToHost));
        CUDA_CHECK(cudaMemcpy(&h_ur,  &(d_states_pool[pool_idx].ur[k]),  sizeof(RealType), cudaMemcpyDeviceToHost));
        CUDA_CHECK(cudaMemcpy(&h_uz,  &(d_states_pool[pool_idx].uz[k]),  sizeof(RealType), cudaMemcpyDeviceToHost));
        CUDA_CHECK(cudaMemcpy(&h_p,   &(d_states_pool[pool_idx].p[k]),   sizeof(RealType), cudaMemcpyDeviceToHost));
        CUDA_CHECK(cudaMemcpy(&h_E,   &(d_states_pool[pool_idx].E[k]),   sizeof(RealType), cudaMemcpyDeviceToHost));
        CUDA_CHECK(cudaMemcpy(&h_a1,  &(d_states_pool[pool_idx].alpha1[k]), sizeof(RealType), cudaMemcpyDeviceToHost));
        CUDA_CHECK(cudaMemcpy(&h_a2,  &(d_states_pool[pool_idx].alpha2[k]), sizeof(RealType), cudaMemcpyDeviceToHost));
        
        vals[0] = static_cast<float>(h_p);
        vals[1] = static_cast<float>(h_rho);
        double u_mag = std::sqrt((double)(h_ur * h_ur + h_uz * h_uz));
        vals[2] = static_cast<float>(u_mag);
        
        double e_int = (h_rho > 0.0) ? ((double)h_E / (double)h_rho - 0.5 * u_mag * u_mag) : 0.0;
        vals[3] = static_cast<float>(e_int);
        
        vals[4] = static_cast<float>(std::clamp((double)h_a1, 0.0, 1.0));
        vals[5] = static_cast<float>(std::clamp((double)h_a2, 0.0, 1.0));
        double air_frac = 1.0 - (double)h_a1 - (double)h_a2;
        vals[6] = static_cast<float>(std::clamp(air_frac, 0.0, 1.0));
    }
    return vals;
}

template <typename RealType>
size_t CFDSolver2DCudaImpl<RealType>::getAllocatedVRAM() const {
    size_t total = 0;
    total += num_tiles_r * num_tiles_z * sizeof(int32_t); // d_tile_map
    total += max_active_tiles * sizeof(PrimitiveTileT<RealType>);   // d_states_pool
    total += max_active_tiles * sizeof(ConservativeTileT<RealType>); // d_U_pool
    total += max_active_tiles * sizeof(ConservativeTileT<RealType>); // d_dU_pool
    total += max_active_tiles * sizeof(RealType);           // d_block_maxes
    total += max_active_tiles * sizeof(uint8_t);          // d_tile_active_flags
    total += sizeof(MultiMat::MaterialSet);               // d_materials
    total += sizeof(int);                                 // d_terminated
    return total;
}

void get_cuda_vram_info(size_t& free_bytes, size_t& total_bytes) {
    if (cudaMemGetInfo(&free_bytes, &total_bytes) != cudaSuccess) {
        free_bytes = 0;
        total_bytes = 0;
    }
}

template <typename RealType>
__global__ void batch_sample_gauges_kernel_2d(
    const PrimitiveTileT<RealType>* states_pool,
    const int32_t* tile_map,
    const GPUGauge2D* gauges,
    float* out_data,
    int num_tiles_z,
    int num_gauges,
    RealType ambient_p,
    RealType ambient_rho,
    RealType gamma,
    bool is_ideal_gas
) {
    int g = blockIdx.x * blockDim.x + threadIdx.x;
    if (g >= num_gauges) return;

    int tr = gauges[g].tr;
    int tz = gauges[g].tz;
    int k = gauges[g].k;

    int pool_idx = tile_map[tr * num_tiles_z + tz];
    if (pool_idx == -1) {
        out_data[g * 7 + 0] = (float)ambient_p;
        out_data[g * 7 + 1] = (float)ambient_rho;
        out_data[g * 7 + 2] = 0.0f;
        out_data[g * 7 + 3] = (float)(is_ideal_gas ? (ambient_p / (ambient_rho * (gamma - 1.0))) :
                              (double)MultiMat::getEnergy_IdealGas(ambient_p, ambient_rho, gamma));
        out_data[g * 7 + 4] = 0.0f;
        out_data[g * 7 + 5] = 0.0f;
        out_data[g * 7 + 6] = 1.0f;
    } else {
        const auto& tile = states_pool[pool_idx];
        out_data[g * 7 + 0] = (float)tile.p[k];
        out_data[g * 7 + 1] = (float)tile.rho[k];
        RealType ur = tile.ur[k];
        RealType uz = tile.uz[k];
        float u_mag = (float)sqrt((double)(ur * ur + uz * uz));
        out_data[g * 7 + 2] = u_mag;
        float e_int = (tile.rho[k] > 0.0f) ? ((float)tile.E[k] / (float)tile.rho[k] - 0.5f * u_mag * u_mag) : 0.0f;
        out_data[g * 7 + 3] = e_int;
        out_data[g * 7 + 4] = (float)tile.alpha1[k];
        out_data[g * 7 + 5] = (float)tile.alpha2[k];
        out_data[g * 7 + 6] = (float)(1.0f - tile.alpha1[k] - tile.alpha2[k]);
    }
}

template <typename RealType>
void CFDSolver2DCudaImpl<RealType>::setGauges(const std::vector<Gauge2D>& gauges) {
    if (d_gauge_coords) { cudaFree(d_gauge_coords); d_gauge_coords = nullptr; }
    if (d_gauge_results) { cudaFree(d_gauge_results); d_gauge_results = nullptr; }
    if (host_pinned_gauge_data) { cudaFreeHost(host_pinned_gauge_data); host_pinned_gauge_data = nullptr; }

    num_gauges = gauges.size();
    write_idx = 0;
    host_pinned_times.clear();
    buffered_times.clear();
    buffered_values.clear();

    if (num_gauges == 0) return;

    std::vector<GPUGauge2D> local_gauge_coords(num_gauges);
    for (size_t g = 0; g < gauges.size(); ++g) {
        int i = std::clamp(static_cast<int>(gauges[g].r / dr), 0, nr_cells - 1);
        int j = std::clamp(static_cast<int>(gauges[g].z / dz), 0, nz_cells - 1);

        int tr = i / TILE_SIZE;
        int tz = j / TILE_SIZE;
        int k = (i % TILE_SIZE) * TILE_SIZE + (j % TILE_SIZE);

        local_gauge_coords[g].tr = tr;
        local_gauge_coords[g].tz = tz;
        local_gauge_coords[g].k = k;
    }

    CUDA_CHECK(cudaMalloc(&d_gauge_coords, num_gauges * sizeof(GPUGauge2D)));
    CUDA_CHECK(cudaMemcpy(d_gauge_coords, local_gauge_coords.data(), num_gauges * sizeof(GPUGauge2D), cudaMemcpyHostToDevice));

    CUDA_CHECK(cudaMalloc(&d_gauge_results, num_gauges * 7 * sizeof(float)));
    CUDA_CHECK(cudaHostAlloc(&host_pinned_gauge_data, host_pinned_capacity * num_gauges * 7 * sizeof(float), cudaHostAllocDefault));

    if (!gauge_stream) {
        CUDA_CHECK(cudaStreamCreate((cudaStream_t*)&gauge_stream));
    }
    if (!step_done) {
        CUDA_CHECK(cudaEventCreate((cudaEvent_t*)&step_done));
    }
}

template <typename RealType>
void CFDSolver2DCudaImpl<RealType>::recordGaugesAsync(double t) {
    if (num_gauges == 0) return;

    if (write_idx >= host_pinned_capacity) {
        std::vector<double> dummy_times;
        std::vector<float> dummy_vals;
        retrieveNewGaugeSamples(dummy_times, dummy_vals);
        buffered_times.insert(buffered_times.end(), dummy_times.begin(), dummy_times.end());
        buffered_values.insert(buffered_values.end(), dummy_vals.begin(), dummy_vals.end());
    }

    CUDA_CHECK(cudaEventRecord((cudaEvent_t)step_done, 0));
    CUDA_CHECK(cudaStreamWaitEvent((cudaStream_t)gauge_stream, (cudaEvent_t)step_done, 0));

    int threads_per_block = 256;
    int blocks = (num_gauges + threads_per_block - 1) / threads_per_block;
    batch_sample_gauges_kernel_2d<RealType><<<blocks, threads_per_block, 0, (cudaStream_t)gauge_stream>>>(
        (const PrimitiveTileT<RealType>*)d_states_pool,
        (const int32_t*)d_tile_map,
        (const GPUGauge2D*)d_gauge_coords,
        (float*)d_gauge_results,
        num_tiles_z,
        num_gauges,
        (RealType)ambient_p,
        (RealType)ambient_rho,
        (RealType)gamma,
        is_ideal_gas
    );
    CUDA_CHECK(cudaGetLastError());

    float* dest_ptr = host_pinned_gauge_data + (write_idx * num_gauges * 7);
    CUDA_CHECK(cudaMemcpyAsync(dest_ptr, d_gauge_results, num_gauges * 7 * sizeof(float), cudaMemcpyDeviceToHost, (cudaStream_t)gauge_stream));

    host_pinned_times.push_back(t);
    write_idx++;
}

template <typename RealType>
void CFDSolver2DCudaImpl<RealType>::retrieveNewGaugeSamples(std::vector<double>& times, std::vector<float>& values) {
    if (num_gauges == 0) {
        times.clear();
        values.clear();
        return;
    }

    CUDA_CHECK(cudaStreamSynchronize((cudaStream_t)gauge_stream));

    times = std::move(buffered_times);
    values = std::move(buffered_values);
    buffered_times.clear();
    buffered_values.clear();

    if (write_idx > 0) {
        times.insert(times.end(), host_pinned_times.begin(), host_pinned_times.end());
        size_t total_floats = write_idx * num_gauges * 7;
        values.insert(values.end(), host_pinned_gauge_data, host_pinned_gauge_data + total_floats);
    }

    write_idx = 0;
    host_pinned_times.clear();
}

template <typename RealType>
void CFDSolver2DCudaImpl<RealType>::exportVTK(const std::string& filename) {
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

template <typename RealType>
void CFDSolver2DCudaImpl<RealType>::setSolidMask(const uint8_t* mask) {
    if (!mask) return;
    int total = nr_cells * nz_cells;
    if ((size_t)total > solid_capacity) {
        if (d_solid_mask) CUDA_CHECK(cudaFree(d_solid_mask));
        if (d_solid_velocities) CUDA_CHECK(cudaFree(d_solid_velocities));
        solid_capacity = total * 2;
        CUDA_CHECK(cudaMalloc(&d_solid_mask, solid_capacity * sizeof(uint8_t)));
        CUDA_CHECK(cudaMalloc(&d_solid_velocities, solid_capacity * 2 * sizeof(double)));
    }
    CUDA_CHECK(cudaMemcpy(d_solid_mask, mask, total * sizeof(uint8_t), cudaMemcpyHostToDevice));
}

template <typename RealType>
void CFDSolver2DCudaImpl<RealType>::setSolidVelocities(const double* v) {
    if (!v) return;
    int total = nr_cells * nz_cells;
    if ((size_t)total > solid_capacity) {
        if (d_solid_mask) CUDA_CHECK(cudaFree(d_solid_mask));
        if (d_solid_velocities) CUDA_CHECK(cudaFree(d_solid_velocities));
        solid_capacity = total * 2;
        CUDA_CHECK(cudaMalloc(&d_solid_mask, solid_capacity * sizeof(uint8_t)));
        CUDA_CHECK(cudaMalloc(&d_solid_velocities, solid_capacity * 2 * sizeof(double)));
    }
    CUDA_CHECK(cudaMemcpy(d_solid_velocities, v, total * 2 * sizeof(double), cudaMemcpyHostToDevice));
}

// Explicit template instantiations
template class CFDSolver2DCudaImpl<float>;
template class CFDSolver2DCudaImpl<double>;
