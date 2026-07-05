#include "cfd_solver_2d_cuda.hpp"
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

// Device struct identical to host
struct CellState {
    double rho, ur, uz, p, E, alpha1, alpha2, arho1, arho2;
};

// ... Device kernels ...

__device__ inline void compute_E_device(CellState& s, double gamma, const MultiMat::MaterialSet* d_materials, bool is_ideal_gas);

__device__ inline CellState applyBC_device(CellState s, int bc, double normal_vel, double ambient_rho, double ambient_p, double gamma, const MultiMat::MaterialSet* d_materials, bool is_ideal_gas, bool is_r_axis) {
    if (bc == 0) { // REFLECTIVE is 0
        if (is_r_axis) {
            s.ur = -s.ur;
        } else {
            s.uz = -s.uz;
        }
    } else if (bc == 1) { // TRANSMISSIVE is 1
        // Zero-gradient: copy directly, do nothing
    } else if (bc == 2) { // OUTFLOW_RIEMANN is 2
        double c;
        if (is_ideal_gas) {
            c = sqrt(gamma * s.p / s.rho);
        } else {
            c = MultiMat::getMixtureSoundSpeed(s.p, s.rho, s.alpha1, s.alpha2, s.arho1, s.arho2, gamma, d_materials->products, d_materials->unreacted);
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
            compute_E_device(s, gamma, d_materials, is_ideal_gas);
        }
        // Supersonic outflow (extrapolate as is)
    }
    return s;
}

__device__ inline CellState readState_device(
    const int32_t* tile_map, const PrimitiveTile* states_pool, 
    int i, int j, int nr_cells, int nz_cells, int num_tiles_z,
    double ambient_rho, double ambient_p, double gamma,
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
    
    CellState s;
    if (pool_idx == -1) {
        s = { ambient_rho, 0.0, 0.0, ambient_p, 
              is_ideal_gas ? (ambient_p / (gamma - 1.0)) : 
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
        double normal_vel = (original_i < 0) ? s.ur : -s.ur;
        s = applyBC_device(s, (original_i < 0) ? bcRmin : bcRmax, normal_vel, ambient_rho, ambient_p, gamma, d_materials, is_ideal_gas, true);
    }
    if (is_outside_j) {
        double normal_vel = (original_j < 0) ? s.uz : -s.uz;
        s = applyBC_device(s, (original_j < 0) ? bcZmin : bcZmax, normal_vel, ambient_rho, ambient_p, gamma, d_materials, is_ideal_gas, false);
    }
    
    return s;
}

// Helpers for spatial reconstruction on CUDA device
__device__ inline double minmod_device(double a, double b) {
    if (a * b <= 0) return 0.0;
    return (std::abs(a) < std::abs(b)) ? a : b;
}

__device__ inline double weno3_device(double qm1, double q0, double qp1) {
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

__device__ inline void compute_E_device(CellState& s, double gamma, const MultiMat::MaterialSet* d_materials, bool is_ideal_gas) {
    if (s.rho < 1e-10 || s.p < 1e-10) return;
    if (is_ideal_gas) {
        s.E = s.p / (gamma - 1.0) + 0.5 * s.rho * (s.ur * s.ur + s.uz * s.uz);
    } else {
        s.E = MultiMat::getMixtureEnergy(s.p, s.rho, s.alpha1, s.alpha2, s.arho1, s.arho2, gamma, d_materials->products, d_materials->unreacted) + 0.5 * s.rho * (s.ur * s.ur + s.uz * s.uz);
    }
}

__device__ inline void calcFluxRusanov_device(const CellState& sL, const CellState& sR, double gamma, const MultiMat::MaterialSet& mat, 
                            double& f_rho, double& f_rhour, double& f_rhouz, double& f_E, 
                            double& f_alpha1, double& f_alpha2, double& f_arho1, double& f_arho2, double& v_face) {
    double cL = MultiMat::getMixtureSoundSpeed(sL.p, sL.rho, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, gamma, mat.products, mat.unreacted);
    double cR = MultiMat::getMixtureSoundSpeed(sR.p, sR.rho, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, gamma, mat.products, mat.unreacted);
    double val_L = std::abs(sL.ur) + cL;
    double val_R = std::abs(sR.ur) + cR;
    double s_max = (val_L > val_R) ? val_L : val_R;

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

__device__ inline void calcFluxRusanovZ_device(const CellState& sL, const CellState& sR, double gamma, const MultiMat::MaterialSet& mat, 
                            double& f_rho, double& f_rhour, double& f_rhouz, double& f_E, 
                            double& f_alpha1, double& f_alpha2, double& f_arho1, double& f_arho2, double& v_face) {
    double cL = MultiMat::getMixtureSoundSpeed(sL.p, sL.rho, sL.alpha1, sL.alpha2, sL.arho1, sL.arho2, gamma, mat.products, mat.unreacted);
    double cR = MultiMat::getMixtureSoundSpeed(sR.p, sR.rho, sR.alpha1, sR.alpha2, sR.arho1, sR.arho2, gamma, mat.products, mat.unreacted);
    double val_L = std::abs(sL.uz) + cL;
    double val_R = std::abs(sR.uz) + cR;
    double s_max = (val_L > val_R) ? val_L : val_R;

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

__global__ __launch_bounds__(256, 2) void computeTileRHS_kernel(
    int num_tiles_r, int num_tiles_z, int nr_cells, int nz_cells, 
    double dr, double dz, double gamma, double dt, double A_coeff, MultiMat::MaterialSet* d_materials,
    const int32_t* tile_map, const PrimitiveTile* states_pool, ConservativeTile* dU_pool,
    int spatialOrder, bool is_ideal_gas,
    int bcRmin, int bcRmax, int bcZmin, int bcZmax,
    double ambient_rho, double ambient_p) {
    
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
    
    CellState s_c = readState_device(tile_map, states_pool, i, j, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
    CellState s_L = readState_device(tile_map, states_pool, i - 1, j, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
    CellState s_R = readState_device(tile_map, states_pool, i + 1, j, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
    CellState s_B = readState_device(tile_map, states_pool, i, j - 1, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
    CellState s_T = readState_device(tile_map, states_pool, i, j + 1, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);

    CellState s_faceL_L = s_L;
    CellState s_faceL_R = s_c;
    CellState s_faceR_L = s_c;
    CellState s_faceR_R = s_R;
    CellState s_faceB_L = s_B;
    CellState s_faceB_R = s_c;
    CellState s_faceT_L = s_c;
    CellState s_faceT_R = s_T;

    if (spatialOrder == 2) {
        CellState s_LL = readState_device(tile_map, states_pool, i - 2, j, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
        CellState s_RR = readState_device(tile_map, states_pool, i + 2, j, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
        CellState s_BB = readState_device(tile_map, states_pool, i, j - 2, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
        CellState s_TT = readState_device(tile_map, states_pool, i, j + 2, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);

        // Reconstruct left radial face i - 1/2
        s_faceL_L.rho = s_L.rho + 0.5 * minmod_device(s_L.rho - s_LL.rho, s_c.rho - s_L.rho);
        s_faceL_R.rho = s_c.rho - 0.5 * minmod_device(s_c.rho - s_L.rho, s_R.rho - s_c.rho);
        s_faceL_L.ur  = s_L.ur + 0.5 * minmod_device(s_L.ur - s_LL.ur, s_c.ur - s_L.ur);
        s_faceL_R.ur  = s_c.ur - 0.5 * minmod_device(s_c.ur - s_L.ur, s_R.ur - s_c.ur);
        s_faceL_L.uz  = s_L.uz + 0.5 * minmod_device(s_L.uz - s_LL.uz, s_c.uz - s_L.uz);
        s_faceL_R.uz  = s_c.uz - 0.5 * minmod_device(s_c.uz - s_L.uz, s_R.uz - s_c.uz);
        s_faceL_L.p   = s_L.p + 0.5 * minmod_device(s_L.p - s_LL.p, s_c.p - s_L.p);
        s_faceL_R.p   = s_c.p - 0.5 * minmod_device(s_c.p - s_L.p, s_R.p - s_c.p);

        s_faceL_L.alpha1 = s_L.alpha1 + 0.5 * minmod_device(s_L.alpha1 - s_LL.alpha1, s_c.alpha1 - s_L.alpha1);
        s_faceL_L.alpha2 = s_L.alpha2 + 0.5 * minmod_device(s_L.alpha2 - s_LL.alpha2, s_c.alpha2 - s_L.alpha2);
        s_faceL_L.arho1  = s_L.arho1  + 0.5 * minmod_device(s_L.arho1 - s_LL.arho1, s_c.arho1 - s_L.arho1);
        s_faceL_L.arho2  = s_L.arho2  + 0.5 * minmod_device(s_L.arho2 - s_LL.arho2, s_c.arho2 - s_L.arho2);

        s_faceL_R.alpha1 = s_c.alpha1 - 0.5 * minmod_device(s_c.alpha1 - s_L.alpha1, s_R.alpha1 - s_c.alpha1);
        s_faceL_R.alpha2 = s_c.alpha2 - 0.5 * minmod_device(s_c.alpha2 - s_L.alpha2, s_R.alpha2 - s_c.alpha2);
        s_faceL_R.arho1  = s_c.arho1  - 0.5 * minmod_device(s_c.arho1 - s_L.arho1, s_R.arho1 - s_c.arho1);
        s_faceL_R.arho2  = s_c.arho2  - 0.5 * minmod_device(s_c.arho2 - s_L.arho2, s_R.arho2 - s_c.arho2);

        // Reconstruct right radial face i + 1/2
        s_faceR_L.rho = s_c.rho + 0.5 * minmod_device(s_c.rho - s_L.rho, s_R.rho - s_c.rho);
        s_faceR_R.rho = s_R.rho - 0.5 * minmod_device(s_R.rho - s_c.rho, s_RR.rho - s_R.rho);
        s_faceR_L.ur  = s_c.ur + 0.5 * minmod_device(s_c.ur - s_L.ur, s_R.ur - s_c.ur);
        s_faceR_R.ur  = s_R.ur - 0.5 * minmod_device(s_R.ur - s_c.ur, s_RR.ur - s_R.ur);
        s_faceR_L.uz  = s_c.uz + 0.5 * minmod_device(s_c.uz - s_L.uz, s_R.uz - s_c.uz);
        s_faceR_R.uz  = s_R.uz - 0.5 * minmod_device(s_R.uz - s_c.uz, s_RR.uz - s_R.uz);
        s_faceR_L.p   = s_c.p + 0.5 * minmod_device(s_c.p - s_L.p, s_R.p - s_c.p);
        s_faceR_R.p   = s_R.p - 0.5 * minmod_device(s_R.p - s_c.p, s_RR.p - s_R.p);

        s_faceR_L.alpha1 = s_c.alpha1 + 0.5 * minmod_device(s_c.alpha1 - s_L.alpha1, s_R.alpha1 - s_c.alpha1);
        s_faceR_L.alpha2 = s_c.alpha2 + 0.5 * minmod_device(s_c.alpha2 - s_L.alpha2, s_R.alpha2 - s_c.alpha2);
        s_faceR_L.arho1  = s_c.arho1  + 0.5 * minmod_device(s_c.arho1 - s_L.arho1, s_R.arho1 - s_c.arho1);
        s_faceR_L.arho2  = s_c.arho2  + 0.5 * minmod_device(s_c.arho2 - s_L.arho2, s_R.arho2 - s_c.arho2);

        s_faceR_R.alpha1 = s_R.alpha1 - 0.5 * minmod_device(s_R.alpha1 - s_c.alpha1, s_RR.alpha1 - s_R.alpha1);
        s_faceR_R.alpha2 = s_R.alpha2 - 0.5 * minmod_device(s_R.alpha2 - s_c.alpha2, s_RR.alpha2 - s_R.alpha2);
        s_faceR_R.arho1  = s_R.arho1  - 0.5 * minmod_device(s_R.arho1 - s_c.arho1, s_RR.arho1 - s_R.arho1);
        s_faceR_R.arho2  = s_R.arho2  - 0.5 * minmod_device(s_R.arho2 - s_c.arho2, s_RR.arho2 - s_R.arho2);

        // Reconstruct bottom axial face j - 1/2
        s_faceB_L.rho = s_B.rho + 0.5 * minmod_device(s_B.rho - s_BB.rho, s_c.rho - s_B.rho);
        s_faceB_R.rho = s_c.rho - 0.5 * minmod_device(s_c.rho - s_B.rho, s_T.rho - s_c.rho);
        s_faceB_L.ur  = s_B.ur + 0.5 * minmod_device(s_B.ur - s_BB.ur, s_c.ur - s_B.ur);
        s_faceB_R.ur  = s_c.ur - 0.5 * minmod_device(s_c.ur - s_B.ur, s_T.ur - s_c.ur);
        s_faceB_L.uz  = s_B.uz + 0.5 * minmod_device(s_B.uz - s_BB.uz, s_c.uz - s_B.uz);
        s_faceB_R.uz  = s_c.uz - 0.5 * minmod_device(s_c.uz - s_B.uz, s_T.uz - s_c.uz);
        s_faceB_L.p   = s_B.p + 0.5 * minmod_device(s_B.p - s_BB.p, s_c.p - s_B.p);
        s_faceB_R.p   = s_c.p - 0.5 * minmod_device(s_c.p - s_B.p, s_T.p - s_c.p);

        s_faceB_L.alpha1 = s_B.alpha1 + 0.5 * minmod_device(s_B.alpha1 - s_BB.alpha1, s_c.alpha1 - s_B.alpha1);
        s_faceB_L.alpha2 = s_B.alpha2 + 0.5 * minmod_device(s_B.alpha2 - s_BB.alpha2, s_c.alpha2 - s_B.alpha2);
        s_faceB_L.arho1  = s_B.arho1  + 0.5 * minmod_device(s_B.arho1 - s_BB.arho1, s_c.arho1 - s_B.arho1);
        s_faceB_L.arho2  = s_B.arho2  + 0.5 * minmod_device(s_B.arho2 - s_BB.arho2, s_c.arho2 - s_B.arho2);

        s_faceB_R.alpha1 = s_c.alpha1 - 0.5 * minmod_device(s_c.alpha1 - s_B.alpha1, s_T.alpha1 - s_c.alpha1);
        s_faceB_R.alpha2 = s_c.alpha2 - 0.5 * minmod_device(s_c.alpha2 - s_B.alpha2, s_T.alpha2 - s_c.alpha2);
        s_faceB_R.arho1  = s_c.arho1  - 0.5 * minmod_device(s_c.arho1 - s_B.arho1, s_T.arho1 - s_c.arho1);
        s_faceB_R.arho2  = s_c.arho2  - 0.5 * minmod_device(s_c.arho2 - s_B.arho2, s_T.arho2 - s_c.arho2);

        // Reconstruct top axial face j + 1/2
        s_faceT_L.rho = s_c.rho + 0.5 * minmod_device(s_c.rho - s_B.rho, s_T.rho - s_c.rho);
        s_faceT_R.rho = s_T.rho - 0.5 * minmod_device(s_T.rho - s_c.rho, s_TT.rho - s_T.rho);
        s_faceT_L.ur  = s_c.ur + 0.5 * minmod_device(s_c.ur - s_B.ur, s_T.ur - s_c.ur);
        s_faceT_R.ur  = s_T.ur - 0.5 * minmod_device(s_T.ur - s_c.ur, s_TT.ur - s_T.ur);
        s_faceT_L.uz  = s_c.uz + 0.5 * minmod_device(s_c.uz - s_B.uz, s_T.uz - s_c.uz);
        s_faceT_R.uz  = s_T.uz - 0.5 * minmod_device(s_T.uz - s_c.uz, s_TT.uz - s_T.uz);
        s_faceT_L.p   = s_c.p + 0.5 * minmod_device(s_c.p - s_B.p, s_T.p - s_c.p);
        s_faceT_R.p   = s_T.p - 0.5 * minmod_device(s_T.p - s_c.p, s_TT.p - s_T.p);

        s_faceT_L.alpha1 = s_c.alpha1 + 0.5 * minmod_device(s_c.alpha1 - s_B.alpha1, s_T.alpha1 - s_c.alpha1);
        s_faceT_L.alpha2 = s_c.alpha2 + 0.5 * minmod_device(s_c.alpha2 - s_B.alpha2, s_T.alpha2 - s_c.alpha2);
        s_faceT_L.arho1  = s_c.arho1  + 0.5 * minmod_device(s_c.arho1 - s_B.arho1, s_T.arho1 - s_c.arho1);
        s_faceT_L.arho2  = s_c.arho2  + 0.5 * minmod_device(s_c.arho2 - s_B.arho2, s_T.arho2 - s_c.arho2);

        s_faceT_R.alpha1 = s_T.alpha1 - 0.5 * minmod_device(s_T.alpha1 - s_c.alpha1, s_TT.alpha1 - s_T.alpha1);
        s_faceT_R.alpha2 = s_T.alpha2 - 0.5 * minmod_device(s_T.alpha2 - s_c.alpha2, s_TT.alpha2 - s_T.alpha2);
        s_faceT_R.arho1  = s_T.arho1  - 0.5 * minmod_device(s_T.arho1 - s_c.arho1, s_TT.arho1 - s_T.arho1);
        s_faceT_R.arho2  = s_T.arho2  - 0.5 * minmod_device(s_T.arho2 - s_c.arho2, s_TT.arho2 - s_T.arho2);

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
        CellState s_LL = readState_device(tile_map, states_pool, i - 2, j, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
        CellState s_RR = readState_device(tile_map, states_pool, i + 2, j, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
        CellState s_BB = readState_device(tile_map, states_pool, i, j - 2, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);
        CellState s_TT = readState_device(tile_map, states_pool, i, j + 2, nr_cells, nz_cells, num_tiles_z, ambient_rho, ambient_p, gamma, bcRmin, bcRmax, bcZmin, bcZmax, d_materials, is_ideal_gas);

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
        s_faceL_L.alpha1 = s_L.alpha1 + 0.5 * minmod_device(s_L.alpha1 - s_LL.alpha1, s_c.alpha1 - s_L.alpha1);
        s_faceL_L.alpha2 = s_L.alpha2 + 0.5 * minmod_device(s_L.alpha2 - s_LL.alpha2, s_c.alpha2 - s_L.alpha2);
        s_faceL_L.arho1  = s_L.arho1  + 0.5 * minmod_device(s_L.arho1 - s_LL.arho1, s_c.arho1 - s_L.arho1);
        s_faceL_L.arho2  = s_L.arho2  + 0.5 * minmod_device(s_L.arho2 - s_LL.arho2, s_c.arho2 - s_L.arho2);

        s_faceL_R.alpha1 = s_c.alpha1 - 0.5 * minmod_device(s_c.alpha1 - s_L.alpha1, s_R.alpha1 - s_c.alpha1);
        s_faceL_R.alpha2 = s_c.alpha2 - 0.5 * minmod_device(s_c.alpha2 - s_L.alpha2, s_R.alpha2 - s_c.alpha2);
        s_faceL_R.arho1  = s_c.arho1  - 0.5 * minmod_device(s_c.arho1 - s_L.arho1, s_R.arho1 - s_c.arho1);
        s_faceL_R.arho2  = s_c.arho2  - 0.5 * minmod_device(s_c.arho2 - s_L.arho2, s_R.arho2 - s_c.arho2);

        s_faceR_L.alpha1 = s_c.alpha1 + 0.5 * minmod_device(s_c.alpha1 - s_L.alpha1, s_R.alpha1 - s_c.alpha1);
        s_faceR_L.alpha2 = s_c.alpha2 + 0.5 * minmod_device(s_c.alpha2 - s_L.alpha2, s_R.alpha2 - s_c.alpha2);
        s_faceR_L.arho1  = s_c.arho1  + 0.5 * minmod_device(s_c.arho1 - s_L.arho1, s_R.arho1 - s_c.arho1);
        s_faceR_L.arho2  = s_c.arho2  + 0.5 * minmod_device(s_c.arho2 - s_L.arho2, s_R.arho2 - s_c.arho2);

        s_faceR_R.alpha1 = s_R.alpha1 - 0.5 * minmod_device(s_R.alpha1 - s_c.alpha1, s_RR.alpha1 - s_R.alpha1);
        s_faceR_R.alpha2 = s_R.alpha2 - 0.5 * minmod_device(s_R.alpha2 - s_c.alpha2, s_RR.alpha2 - s_R.alpha2);
        s_faceR_R.arho1  = s_R.arho1  - 0.5 * minmod_device(s_R.arho1 - s_c.arho1, s_RR.arho1 - s_R.arho1);
        s_faceR_R.arho2  = s_R.arho2  - 0.5 * minmod_device(s_R.arho2 - s_c.arho2, s_RR.arho2 - s_R.arho2);

        s_faceB_L.alpha1 = s_B.alpha1 + 0.5 * minmod_device(s_B.alpha1 - s_BB.alpha1, s_c.alpha1 - s_B.alpha1);
        s_faceB_L.alpha2 = s_B.alpha2 + 0.5 * minmod_device(s_B.alpha2 - s_BB.alpha2, s_c.alpha2 - s_B.alpha2);
        s_faceB_L.arho1  = s_B.arho1  + 0.5 * minmod_device(s_B.arho1 - s_BB.arho1, s_c.arho1 - s_B.arho1);
        s_faceB_L.arho2  = s_B.arho2  + 0.5 * minmod_device(s_B.arho2 - s_BB.arho2, s_c.arho2 - s_B.arho2);

        s_faceB_R.alpha1 = s_c.alpha1 - 0.5 * minmod_device(s_c.alpha1 - s_B.alpha1, s_T.alpha1 - s_c.alpha1);
        s_faceB_R.alpha2 = s_c.alpha2 - 0.5 * minmod_device(s_c.alpha2 - s_B.alpha2, s_T.alpha2 - s_c.alpha2);
        s_faceB_R.arho1  = s_c.arho1  - 0.5 * minmod_device(s_c.arho1 - s_B.arho1, s_T.arho1 - s_c.arho1);
        s_faceB_R.arho2  = s_c.arho2  - 0.5 * minmod_device(s_c.arho2 - s_B.arho2, s_T.arho2 - s_c.arho2);

        s_faceT_L.alpha1 = s_c.alpha1 + 0.5 * minmod_device(s_c.alpha1 - s_B.alpha1, s_T.alpha1 - s_c.alpha1);
        s_faceT_L.alpha2 = s_c.alpha2 + 0.5 * minmod_device(s_c.alpha2 - s_B.alpha2, s_T.alpha2 - s_c.alpha2);
        s_faceT_L.arho1  = s_c.arho1  + 0.5 * minmod_device(s_c.arho1 - s_B.arho1, s_T.arho1 - s_c.arho1);
        s_faceT_L.arho2  = s_c.arho2  + 0.5 * minmod_device(s_c.arho2 - s_B.arho2, s_T.arho2 - s_c.arho2);

        s_faceT_R.alpha1 = s_T.alpha1 - 0.5 * minmod_device(s_T.alpha1 - s_c.alpha1, s_TT.alpha1 - s_T.alpha1);
        s_faceT_R.alpha2 = s_T.alpha2 - 0.5 * minmod_device(s_T.alpha2 - s_c.alpha2, s_TT.alpha2 - s_T.alpha2);
        s_faceT_R.arho1  = s_T.arho1  - 0.5 * minmod_device(s_T.arho1 - s_c.arho1, s_TT.arho1 - s_T.arho1);
        s_faceT_R.arho2  = s_T.arho2  - 0.5 * minmod_device(s_T.arho2 - s_c.arho2, s_TT.arho2 - s_T.arho2);

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

    double fr_L_rho, fr_L_rhour, fr_L_rhouz, fr_L_E, fr_L_a1, fr_L_a2, fr_L_ar1, fr_L_ar2, v_face_rL;
    double fr_R_rho, fr_R_rhour, fr_R_rhouz, fr_R_E, fr_R_a1, fr_R_a2, fr_R_ar1, fr_R_ar2, v_face_rR;
    
    calcFluxRusanov_device(s_faceL_L, s_faceL_R, gamma, *d_materials, fr_L_rho, fr_L_rhour, fr_L_rhouz, fr_L_E, fr_L_a1, fr_L_a2, fr_L_ar1, fr_L_ar2, v_face_rL);
    calcFluxRusanov_device(s_faceR_L, s_faceR_R, gamma, *d_materials, fr_R_rho, fr_R_rhour, fr_R_rhouz, fr_R_E, fr_R_a1, fr_R_a2, fr_R_ar1, fr_R_ar2, v_face_rR);
    
    double fz_B_rho, fz_B_rhour, fz_B_rhouz, fz_B_E, fz_B_a1, fz_B_a2, fz_B_ar1, fz_B_ar2, v_face_zB;
    double fz_T_rho, fz_T_rhour, fz_T_rhouz, fz_T_E, fz_T_a1, fz_T_a2, fz_T_ar1, fz_T_ar2, v_face_zT;

    calcFluxRusanovZ_device(s_faceB_L, s_faceB_R, gamma, *d_materials, fz_B_rho, fz_B_rhour, fz_B_rhouz, fz_B_E, fz_B_a1, fz_B_a2, fz_B_ar1, fz_B_ar2, v_face_zB);
    calcFluxRusanovZ_device(s_faceT_L, s_faceT_R, gamma, *d_materials, fz_T_rho, fz_T_rhour, fz_T_rhouz, fz_T_E, fz_T_a1, fz_T_a2, fz_T_ar1, fz_T_ar2, v_face_zT);

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

__global__ void applyLSRK3Step_kernel(
    int current_pool_size, int stage,
    ConservativeTile* d_U_pool, ConservativeTile* d_dU_pool) {
    
    int pool_idx = blockIdx.x;
    if (pool_idx >= current_pool_size) return;
    
    int k = threadIdx.x * TILE_SIZE + threadIdx.y;
    
    const double A[3] = {0.0, -5.0/9.0, -153.0/128.0};
    const double B[3] = {1.0/3.0, 15.0/16.0, 8.0/15.0};
    
    d_U_pool[pool_idx].rho[k] += B[stage] * d_dU_pool[pool_idx].rho[k];
    d_U_pool[pool_idx].rhour[k] += B[stage] * d_dU_pool[pool_idx].rhour[k];
    d_U_pool[pool_idx].rhouz[k] += B[stage] * d_dU_pool[pool_idx].rhouz[k];
    d_U_pool[pool_idx].E[k] += B[stage] * d_dU_pool[pool_idx].E[k];
    d_U_pool[pool_idx].alpha1[k] += B[stage] * d_dU_pool[pool_idx].alpha1[k];
    d_U_pool[pool_idx].alpha2[k] += B[stage] * d_dU_pool[pool_idx].alpha2[k];
    d_U_pool[pool_idx].arho1[k] += B[stage] * d_dU_pool[pool_idx].arho1[k];
    d_U_pool[pool_idx].arho2[k] += B[stage] * d_dU_pool[pool_idx].arho2[k];
}

__global__ void applyEulerStep_kernel(
    int current_pool_size, double dt,
    ConservativeTile* d_U_pool, ConservativeTile* d_dU_pool) {
    
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

__global__ void applyProgrammedBurn_kernel(
    int num_tiles_r, int num_tiles_z, int nr_cells, int nz_cells,
    double dr, double dz, double currentTime, double dt,
    double det_x, double det_y, double det_z,
    MultiMat::MaterialSet* d_materials,
    const int32_t* tile_map,
    ConservativeTile* d_U_pool) {
    
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
    
    double r_c = (i + 0.5) * dr;
    double z_c = (j + 0.5) * dz;
    
    double alpha1 = d_U_pool[pool_idx].alpha1[k];
    double alpha2 = d_U_pool[pool_idx].alpha2[k];
    double arho1 = d_U_pool[pool_idx].arho1[k];
    double arho2 = d_U_pool[pool_idx].arho2[k];
    
    double dF = MultiMat::computeProgrammedBurn(
        currentTime, dt, r_c, 0.0, z_c,
        d_materials->det_vel, 0.0,
        det_x, det_y, det_z,
        fmin(dr, dz),
        d_materials->products.rho0,
        alpha1, alpha2,
        arho1, arho2
    );
    
    if (dF > 0.0) {
        if (d_materials->detonation_energy > 0.0) {
            double rho_expl = arho1 + arho2;
            d_U_pool[pool_idx].E[k] += dF * rho_expl * d_materials->detonation_energy;
        }
        d_U_pool[pool_idx].alpha1[k] = alpha1;
        d_U_pool[pool_idx].alpha2[k] = alpha2;
        d_U_pool[pool_idx].arho1[k] = arho1;
        d_U_pool[pool_idx].arho2[k] = arho2;
    }
}

__global__ void updatePrimitiveFromConservative_kernel(
    int current_pool_size, double gamma, MultiMat::MaterialSet* d_materials,
    double ambient_rho, double ambient_p,
    ConservativeTile* d_U_pool, PrimitiveTile* d_states_pool) {
    
    int pool_idx = blockIdx.x;
    if (pool_idx >= current_pool_size) return;
    
    int k = threadIdx.x * TILE_SIZE + threadIdx.y;
    
    double u_rho = d_U_pool[pool_idx].rho[k];
    double u_rhour = d_U_pool[pool_idx].rhour[k];
    double u_rhouz = d_U_pool[pool_idx].rhouz[k];
    double u_E = d_U_pool[pool_idx].E[k];
    double u_alpha1 = d_U_pool[pool_idx].alpha1[k];
    double u_alpha2 = d_U_pool[pool_idx].alpha2[k];
    double u_arho1 = d_U_pool[pool_idx].arho1[k];
    double u_arho2 = d_U_pool[pool_idx].arho2[k];

    const double rho_floor = 1e-8;
    const double p_floor = 1e-8;

    bool bad = isnan(u_rho) || isinf(u_rho) || u_rho < rho_floor ||
               isnan(u_rhour) || isinf(u_rhour) ||
               isnan(u_rhouz) || isinf(u_rhouz) ||
               isnan(u_E) || isinf(u_E);

    double p = ambient_p;
    double ur = 0.0;
    double uz = 0.0;

    if (!bad) {
        double rho_safe = fmax(u_rho, rho_floor);
        ur = u_rhour / rho_safe;
        uz = u_rhouz / rho_safe;
        double ke = 0.5 * rho_safe * (ur * ur + uz * uz);

        double alpha1 = fmax(0.0, fmin(1.0, u_alpha1));
        double alpha2 = fmax(0.0, fmin(1.0, u_alpha2));
        if (alpha1 + alpha2 > 1.0) {
            double sum = alpha1 + alpha2;
            alpha1 /= sum;
            alpha2 /= sum;
        }

        double arho1 = fmax(0.0, fmin(u_rho, u_arho1));
        double arho2 = fmax(0.0, fmin(u_rho, u_arho2));
        if (arho1 + arho2 > u_rho) {
            double sum = arho1 + arho2;
            arho1 = (arho1 / sum) * u_rho;
            arho2 = (arho2 / sum) * u_rho;
        }

        double e_internal = fmax(u_E - ke, p_floor / (gamma - 1.0));
        p = MultiMat::getMixturePressure(e_internal, u_rho, alpha1, alpha2, arho1, arho2, gamma, d_materials->products, d_materials->unreacted);
        
        if (isnan(p) || isinf(p) || p < p_floor) {
            bad = true;
        } else {
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
        d_states_pool[pool_idx].E[k] = ambient_p / (gamma - 1.0);

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

__global__ void computeMaxWaveSpeed_kernel(
    int current_pool_size, double gamma, MultiMat::MaterialSet* d_materials,
    PrimitiveTile* d_states_pool, double* d_block_maxes) {
    
    int pool_idx = blockIdx.x;
    if (pool_idx >= current_pool_size) return;
    
    int local_i = threadIdx.x;
    int local_j = threadIdx.y;
    int k = local_i * TILE_SIZE + local_j;
    
    double p = d_states_pool[pool_idx].p[k];
    double rho = d_states_pool[pool_idx].rho[k];
    double alpha1 = d_states_pool[pool_idx].alpha1[k];
    double alpha2 = d_states_pool[pool_idx].alpha2[k];
    double arho1 = d_states_pool[pool_idx].arho1[k];
    double arho2 = d_states_pool[pool_idx].arho2[k];
    double ur = d_states_pool[pool_idx].ur[k];
    double uz = d_states_pool[pool_idx].uz[k];
    
    double c = MultiMat::getMixtureSoundSpeed(
        p, rho, alpha1, alpha2, arho1, arho2, gamma,
        d_materials->products, d_materials->unreacted
    );
    double s = fmax(fabs(ur), fabs(uz)) + c;
    
    __shared__ double s_data[256];
    int tid = threadIdx.x * TILE_SIZE + threadIdx.y;
    s_data[tid] = s;
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

__global__ void checkTileActive_kernel(
    int current_pool_size, double ambient_p,
    PrimitiveTile* d_states_pool, uint8_t* d_tile_active_flags) {
    
    int pool_idx = blockIdx.x;
    if (pool_idx >= current_pool_size) return;
    
    int local_i = threadIdx.x;
    int local_j = threadIdx.y;
    int k = local_i * TILE_SIZE + local_j;
    
    double p = d_states_pool[pool_idx].p[k];
    double ur = d_states_pool[pool_idx].ur[k];
    double uz = d_states_pool[pool_idx].uz[k];
    
    bool is_active = (fabs(p - ambient_p) / ambient_p > 1e-4) ||
                     (fabs(ur) > 1e-2) ||
                     (fabs(uz) > 1e-2);
                     
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

// --------------------------------------------------------------------------------------
// Class Implementation

CFDSolver2DCuda::CFDSolver2DCuda(int nr, int nz, double max_r, double max_z, double gamma)
    : nr_cells(nr), nz_cells(nz), max_r(max_r), max_z(max_z), gamma(gamma), currentTime(0.0), currentScheme(RUSANOV),
      ambient_rho(1.2), ambient_p(101325.0), current_pool_size(0), d_block_maxes(nullptr), d_tile_active_flags(nullptr) {
    
    dr = max_r / nr_cells;
    dz = max_z / nz_cells;

    num_tiles_r = (nr_cells + TILE_SIZE - 1) / TILE_SIZE;
    num_tiles_z = (nz_cells + TILE_SIZE - 1) / TILE_SIZE;
    
    // Allocate pool capacity (20% of max tiles + padding)
    max_active_tiles = (num_tiles_r * num_tiles_z) * 0.25; 
    if (max_active_tiles < 10) max_active_tiles = 10;
    
    host_tile_map.resize(num_tiles_r * num_tiles_z, -1);
    host_states_pool.resize(max_active_tiles);
    host_U_pool.resize(max_active_tiles);

    CUDA_CHECK(cudaMalloc(&d_tile_map, num_tiles_r * num_tiles_z * sizeof(int32_t)));
    CUDA_CHECK(cudaMemcpy(d_tile_map, host_tile_map.data(), host_tile_map.size() * sizeof(int32_t), cudaMemcpyHostToDevice));
    
    CUDA_CHECK(cudaMalloc(&d_states_pool, max_active_tiles * sizeof(PrimitiveTile)));
    CUDA_CHECK(cudaMalloc(&d_U_pool, max_active_tiles * sizeof(ConservativeTile)));
    CUDA_CHECK(cudaMalloc(&d_dU_pool, max_active_tiles * sizeof(ConservativeTile)));
    CUDA_CHECK(cudaMalloc(&d_block_maxes, max_active_tiles * sizeof(double)));
    CUDA_CHECK(cudaMalloc(&d_tile_active_flags, max_active_tiles * sizeof(uint8_t)));
    
    CUDA_CHECK(cudaMalloc(&d_materials, sizeof(MultiMat::MaterialSet)));
    CUDA_CHECK(cudaMemcpy(d_materials, &currentMaterials, sizeof(MultiMat::MaterialSet), cudaMemcpyHostToDevice));
    CUDA_CHECK(cudaMalloc(&d_terminated, sizeof(int)));
    int zero = 0;
    CUDA_CHECK(cudaMemcpy(d_terminated, &zero, sizeof(int), cudaMemcpyHostToDevice));
}

CFDSolver2DCuda::~CFDSolver2DCuda() {
    cudaDeviceSynchronize(); // flush all in-flight work before freeing
    cudaFree(d_tile_map);
    cudaFree(d_states_pool);
    cudaFree(d_U_pool);
    cudaFree(d_dU_pool);
    cudaFree(d_materials);
    if (d_block_maxes) cudaFree(d_block_maxes);
    if (d_tile_active_flags) cudaFree(d_tile_active_flags);
    if (d_terminated) cudaFree(d_terminated);
}

void CFDSolver2DCuda::setMaterialParameters(const MultiMat::MaterialSet& materials) {
    currentMaterials = materials;
    CUDA_CHECK(cudaMemcpy(d_materials, &currentMaterials, sizeof(MultiMat::MaterialSet), cudaMemcpyHostToDevice));
}

void CFDSolver2DCuda::growTilePool(int new_max_tiles) {
    if (new_max_tiles <= max_active_tiles) return;

    host_states_pool.resize(new_max_tiles);
    host_U_pool.resize(new_max_tiles);

    PrimitiveTile* d_new_states_pool = nullptr;
    ConservativeTile* d_new_U_pool = nullptr;
    ConservativeTile* d_new_dU_pool = nullptr;
    double* d_new_block_maxes = nullptr;
    uint8_t* d_new_tile_active_flags = nullptr;

    CUDA_CHECK(cudaMalloc(&d_new_states_pool, new_max_tiles * sizeof(PrimitiveTile)));
    CUDA_CHECK(cudaMalloc(&d_new_U_pool, new_max_tiles * sizeof(ConservativeTile)));
    CUDA_CHECK(cudaMalloc(&d_new_dU_pool, new_max_tiles * sizeof(ConservativeTile)));
    CUDA_CHECK(cudaMalloc(&d_new_block_maxes, new_max_tiles * sizeof(double)));
    CUDA_CHECK(cudaMalloc(&d_new_tile_active_flags, new_max_tiles * sizeof(uint8_t)));

    if (current_pool_size > 0) {
        CUDA_CHECK(cudaMemcpy(d_new_states_pool, d_states_pool, current_pool_size * sizeof(PrimitiveTile), cudaMemcpyDeviceToDevice));
        CUDA_CHECK(cudaMemcpy(d_new_U_pool, d_U_pool, current_pool_size * sizeof(ConservativeTile), cudaMemcpyDeviceToDevice));
        CUDA_CHECK(cudaMemcpy(d_new_dU_pool, d_dU_pool, current_pool_size * sizeof(ConservativeTile), cudaMemcpyDeviceToDevice));
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

int CFDSolver2DCuda::allocateTile(int tr, int tz) {
    if (tr < 0 || tr >= num_tiles_r || tz < 0 || tz >= num_tiles_z) return -1;
    int flat_idx = tr * num_tiles_z + tz;
    if (host_tile_map[flat_idx] != -1) return host_tile_map[flat_idx];
    
    if (current_pool_size >= max_active_tiles) {
        int total_tiles = num_tiles_r * num_tiles_z;
        if (max_active_tiles >= total_tiles) {
            std::cerr << "CFDSolver2DCuda ERROR: Tile pool capacity exceeded absolute limit of " << total_tiles << std::endl;
            exit(EXIT_FAILURE);
        }
        int new_max = std::min(total_tiles, max_active_tiles * 2);
        growTilePool(new_max);
    }
    
    int pool_idx = current_pool_size++;

    host_tile_map[flat_idx] = pool_idx;
    initTileToAmbientHost(pool_idx);
    return pool_idx;
}

void CFDSolver2DCuda::initTileToAmbientHost(int pool_idx) {
    for (int k = 0; k < TILE_SIZE * TILE_SIZE; ++k) {
        host_states_pool[pool_idx].rho[k] = ambient_rho;
        host_states_pool[pool_idx].ur[k] = 0.0;
        host_states_pool[pool_idx].uz[k] = 0.0;
        host_states_pool[pool_idx].p[k] = ambient_p;
        host_states_pool[pool_idx].alpha1[k] = 0.0;
        host_states_pool[pool_idx].alpha2[k] = 0.0;
        host_states_pool[pool_idx].arho1[k] = 0.0;
        host_states_pool[pool_idx].arho2[k] = 0.0;
        host_states_pool[pool_idx].floor_status[k] = 0;
        
        if (is_ideal_gas) {
            host_states_pool[pool_idx].E[k] = ambient_p / (gamma - 1.0);
        } else {
            host_states_pool[pool_idx].E[k] = ambient_rho * MultiMat::getEnergy_IdealGas(ambient_p, ambient_rho, gamma);
        }
        
        host_U_pool[pool_idx].rho[k] = ambient_rho;
        host_U_pool[pool_idx].rhour[k] = 0.0;
        host_U_pool[pool_idx].rhouz[k] = 0.0;
        host_U_pool[pool_idx].E[k] = host_states_pool[pool_idx].E[k];
        host_U_pool[pool_idx].alpha1[k] = 0.0;
        host_U_pool[pool_idx].alpha2[k] = 0.0;
        host_U_pool[pool_idx].arho1[k] = 0.0;
        host_U_pool[pool_idx].arho2[k] = 0.0;
    }
}

void CFDSolver2DCuda::syncPoolToDevice() {
    if (current_pool_size > 0) {
        CUDA_CHECK(cudaMemcpy(d_tile_map, host_tile_map.data(), host_tile_map.size() * sizeof(int32_t), cudaMemcpyHostToDevice));
        CUDA_CHECK(cudaMemcpy(d_states_pool, host_states_pool.data(), current_pool_size * sizeof(PrimitiveTile), cudaMemcpyHostToDevice));
        CUDA_CHECK(cudaMemcpy(d_U_pool, host_U_pool.data(), current_pool_size * sizeof(ConservativeTile), cudaMemcpyHostToDevice));
    }
}

void CFDSolver2DCuda::setInitialConditionTNT(double explosive_z, double explosive_radius, 
                                        double high_rho, 
                                        double ambient_rho, double ambient_p) {
    this->ambient_rho = ambient_rho;
    this->ambient_p = ambient_p;
    this->det_x = 0.0;
    this->det_y = 0.0;
    this->det_z = explosive_z;
    this->is_ideal_gas = false;

    // We do initialization entirely on CPU then copy to GPU
    for (int i = 0; i < nr_cells; ++i) {
        for (int j = 0; j < nz_cells; ++j) {
            double sum_w = 0.0;
            double sum_w_inside = 0.0;
            for (int ki = 0; ki < 8; ++ki) {
                double r_sub = i * dr + (ki + 0.5) * (dr / 8.0);
                double w = r_sub;
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
                int k = local_i * TILE_SIZE + local_j;
                
                double alpha2 = f_vol;
                double arho2 = f_vol * high_rho;
                double rho = arho2 + (1.0 - f_vol) * ambient_rho;
                double E = MultiMat::getMixtureEnergy(ambient_p, rho, 0.0, alpha2, 0.0, arho2, gamma, currentMaterials.products, currentMaterials.unreacted);

                host_states_pool[pool_idx].rho[k] = rho;
                host_states_pool[pool_idx].p[k] = ambient_p;
                host_states_pool[pool_idx].alpha1[k] = 0.0; 
                host_states_pool[pool_idx].alpha2[k] = alpha2;
                host_states_pool[pool_idx].arho1[k] = 0.0; 
                host_states_pool[pool_idx].arho2[k] = arho2;
                host_states_pool[pool_idx].ur[k] = 0.0; 
                host_states_pool[pool_idx].uz[k] = 0.0;
                host_states_pool[pool_idx].E[k] = E;
                
                host_U_pool[pool_idx].rho[k] = rho;
                host_U_pool[pool_idx].rhour[k] = 0.0;
                host_U_pool[pool_idx].rhouz[k] = 0.0;
                host_U_pool[pool_idx].E[k] = E;
                host_U_pool[pool_idx].alpha1[k] = 0.0;
                host_U_pool[pool_idx].alpha2[k] = alpha2;
                host_U_pool[pool_idx].arho1[k] = 0.0;
                host_U_pool[pool_idx].arho2[k] = arho2;
            }
        }
    }
    
    // Fill remaining elements in allocated tiles to ambient
    for (int p = 0; p < current_pool_size; ++p) {
        for (int k = 0; k < TILE_SIZE * TILE_SIZE; ++k) {
            if (host_states_pool[p].rho[k] == 0.0) { // Uninitialized
                host_states_pool[p].rho[k] = ambient_rho;
                host_states_pool[p].p[k] = ambient_p;
                host_states_pool[p].E[k] = ambient_rho * MultiMat::getEnergy_IdealGas(ambient_p, ambient_rho, gamma);
                
                host_U_pool[p].rho[k] = ambient_rho;
                host_U_pool[p].E[k] = host_states_pool[p].E[k];
            }
        }
    }
    syncPoolToDevice();
    updateActiveRegionHost();
}

void CFDSolver2DCuda::setInitialConditionFrom1D(double explosive_z, double remap_radius,
                                           const std::vector<double>& r_1d,
                                           const std::vector<MultiMaterialState>& states_1d,
                                           double ambient_rho, double ambient_p,
                                           double explosive_r) {
    this->ambient_rho = ambient_rho;
    this->ambient_p = ambient_p;
    this->det_x = explosive_r;
    this->det_y = 0.0;
    this->det_z = explosive_z;
    this->is_ideal_gas = false;
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

            host_U_pool[pool_idx].rho[local_idx]   = sum_rho_w / sum_w;
            host_U_pool[pool_idx].rhour[local_idx] = sum_rhour_w / sum_w;
            host_U_pool[pool_idx].rhouz[local_idx] = sum_rhouz_w / sum_w;
            host_U_pool[pool_idx].E[local_idx]     = sum_E_w / sum_w;
            host_U_pool[pool_idx].alpha1[local_idx] = sum_alpha1_w / sum_w;
            host_U_pool[pool_idx].alpha2[local_idx] = sum_alpha2_w / sum_w;
            host_U_pool[pool_idx].arho1[local_idx]  = sum_arho1_w / sum_w;
            host_U_pool[pool_idx].arho2[local_idx]  = sum_arho2_w / sum_w;
        }
    }

    // Fill remaining elements in allocated tiles to ambient
    for (int p = 0; p < current_pool_size; ++p) {
        for (int k = 0; k < TILE_SIZE * TILE_SIZE; ++k) {
            if (host_states_pool[p].rho[k] == 0.0) { // Uninitialized
                host_states_pool[p].rho[k] = ambient_rho;
                host_states_pool[p].p[k] = ambient_p;
                host_states_pool[p].E[k] = ambient_rho * MultiMat::getEnergy_IdealGas(ambient_p, ambient_rho, gamma);
                
                host_U_pool[p].rho[k] = ambient_rho;
                host_U_pool[p].E[k] = host_states_pool[p].E[k];
            }
        }
    }

    syncPoolToDevice();
    if (current_pool_size > 0) {
        dim3 threads(TILE_SIZE, TILE_SIZE);
        updatePrimitiveFromConservative_kernel<<<current_pool_size, threads>>>(current_pool_size, gamma, d_materials, ambient_rho, ambient_p, d_U_pool, d_states_pool);
        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaDeviceSynchronize());
    }
    updateActiveRegionHost();
}
void CFDSolver2DCuda::setInitialConditionTNTCylinder(double explosive_z, double radius, double height, double high_rho, double ambient_rho, double ambient_p) {
    this->ambient_rho = ambient_rho;
    this->ambient_p = ambient_p;
    this->det_x = 0.0;
    this->det_y = 0.0;
    this->det_z = explosive_z + height / 2.0;
    this->is_ideal_gas = false;

    for (int i = 0; i < nr_cells; ++i) {
        for (int j = 0; j < nz_cells; ++j) {
            double sum_w = 0.0;
            double sum_w_inside = 0.0;
            for (int ki = 0; ki < 8; ++ki) {
                double r_sub = i * dr + (ki + 0.5) * (dr / 8.0);
                double w = r_sub;
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
                int k = local_i * TILE_SIZE + local_j;
                
                double alpha2 = f_vol;
                double arho2 = f_vol * high_rho;
                double rho = arho2 + (1.0 - f_vol) * ambient_rho;
                double E = MultiMat::getMixtureEnergy(ambient_p, rho, 0.0, alpha2, 0.0, arho2, gamma, currentMaterials.products, currentMaterials.unreacted);

                host_states_pool[pool_idx].rho[k] = rho;
                host_states_pool[pool_idx].p[k] = ambient_p;
                host_states_pool[pool_idx].alpha1[k] = 0.0; 
                host_states_pool[pool_idx].alpha2[k] = alpha2;
                host_states_pool[pool_idx].arho1[k] = 0.0; 
                host_states_pool[pool_idx].arho2[k] = arho2;
                host_states_pool[pool_idx].ur[k] = 0.0; 
                host_states_pool[pool_idx].uz[k] = 0.0;
                host_states_pool[pool_idx].E[k] = E;
                
                host_U_pool[pool_idx].rho[k] = rho;
                host_U_pool[pool_idx].rhour[k] = 0.0;
                host_U_pool[pool_idx].rhouz[k] = 0.0;
                host_U_pool[pool_idx].E[k] = E;
                host_U_pool[pool_idx].alpha1[k] = 0.0;
                host_U_pool[pool_idx].alpha2[k] = alpha2;
                host_U_pool[pool_idx].arho1[k] = 0.0;
                host_U_pool[pool_idx].arho2[k] = arho2;
            }
        }
    }
    
    // Fill remaining elements in allocated tiles to ambient
    for (int p = 0; p < current_pool_size; ++p) {
        for (int k = 0; k < TILE_SIZE * TILE_SIZE; ++k) {
            if (host_states_pool[p].rho[k] == 0.0) { // Uninitialized
                host_states_pool[p].rho[k] = ambient_rho;
                host_states_pool[p].p[k] = ambient_p;
                host_states_pool[p].E[k] = ambient_rho * MultiMat::getEnergy_IdealGas(ambient_p, ambient_rho, gamma);
                
                host_U_pool[p].rho[k] = ambient_rho;
                host_U_pool[p].E[k] = host_states_pool[p].E[k];
            }
        }
    }

    syncPoolToDevice();
    if (current_pool_size > 0) {
        dim3 threads(TILE_SIZE, TILE_SIZE);
        updatePrimitiveFromConservative_kernel<<<current_pool_size, threads>>>(current_pool_size, gamma, d_materials, ambient_rho, ambient_p, d_U_pool, d_states_pool);
        CUDA_CHECK(cudaGetLastError());
        CUDA_CHECK(cudaDeviceSynchronize());
    }
    updateActiveRegionHost();
}

void CFDSolver2DCuda::setInitialConditionIdealGas(double explosive_z, double explosive_radius, double high_rho, double detonation_energy, double ambient_rho, double ambient_p) {
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
                double w = r_sub;
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
                int k = local_i * TILE_SIZE + local_j;
                
                double rho = f_vol * high_rho + (1.0 - f_vol) * ambient_rho;
                double p = f_vol * p_high + (1.0 - f_vol) * ambient_p;
                double E = p / (gamma - 1.0);

                host_states_pool[pool_idx].rho[k] = rho;
                host_states_pool[pool_idx].p[k] = p;
                host_states_pool[pool_idx].alpha1[k] = 0.0; host_states_pool[pool_idx].alpha2[k] = 0.0;
                host_states_pool[pool_idx].arho1[k] = 0.0; host_states_pool[pool_idx].arho2[k] = 0.0;
                host_states_pool[pool_idx].ur[k] = 0.0; host_states_pool[pool_idx].uz[k] = 0.0;
                host_states_pool[pool_idx].E[k] = E;
                
                host_U_pool[pool_idx].rho[k] = rho;
                host_U_pool[pool_idx].rhour[k] = 0.0;
                host_U_pool[pool_idx].rhouz[k] = 0.0;
                host_U_pool[pool_idx].E[k] = E;
                host_U_pool[pool_idx].alpha1[k] = 0.0; host_U_pool[pool_idx].alpha2[k] = 0.0;
                host_U_pool[pool_idx].arho1[k] = 0.0; host_U_pool[pool_idx].arho2[k] = 0.0;
            }
        }
    }
    syncPoolToDevice();
    updateActiveRegionHost();
}
void CFDSolver2DCuda::setFluxScheme(const std::string& scheme_name) {}
void CFDSolver2DCuda::run(double duration) {}

void CFDSolver2DCuda::updateActiveRegionHost() {
    if (current_pool_size == 0) return;
    
    // Launch kernel to check tile active states
    dim3 threads(TILE_SIZE, TILE_SIZE);
    checkTileActive_kernel<<<current_pool_size, threads>>>(current_pool_size, ambient_p, d_states_pool, d_tile_active_flags);
    CUDA_CHECK(cudaGetLastError());
    
    // Copy active flags to host
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
            // Contiguous copy of newly allocated tiles to device
            CUDA_CHECK(cudaMemcpy(d_states_pool + initial_pool_size, host_states_pool.data() + initial_pool_size, num_new_tiles * sizeof(PrimitiveTile), cudaMemcpyHostToDevice));
            CUDA_CHECK(cudaMemcpy(d_U_pool + initial_pool_size, host_U_pool.data() + initial_pool_size, num_new_tiles * sizeof(ConservativeTile), cudaMemcpyHostToDevice));
            
            // Sync the updated tile map
            CUDA_CHECK(cudaMemcpy(d_tile_map, host_tile_map.data(), host_tile_map.size() * sizeof(int32_t), cudaMemcpyHostToDevice));
        }
    }
}

void CFDSolver2DCuda::step(double dt) {
    dim3 threads(TILE_SIZE, TILE_SIZE);
    dim3 blocks(num_tiles_r, num_tiles_z);
    
    if (temporalOrder == 1) {
        computeTileRHS_kernel<<<blocks, threads>>>(
            num_tiles_r, num_tiles_z, nr_cells, nz_cells, dr, dz, gamma, 1.0, 0.0, d_materials, d_tile_map, d_states_pool, d_dU_pool, spatialOrder, is_ideal_gas,
            static_cast<int>(bcRmin), static_cast<int>(bcRmax), static_cast<int>(bcZmin), static_cast<int>(bcZmax),
            ambient_rho, ambient_p
        );
        CUDA_CHECK(cudaGetLastError());
        
        applyEulerStep_kernel<<<current_pool_size, threads>>>(current_pool_size, dt, d_U_pool, d_dU_pool);
        CUDA_CHECK(cudaGetLastError());
        
        updatePrimitiveFromConservative_kernel<<<current_pool_size, threads>>>(current_pool_size, gamma, d_materials, ambient_rho, ambient_p, d_U_pool, d_states_pool);
        CUDA_CHECK(cudaGetLastError());
    } else {
        for (int stage = 0; stage < 3; ++stage) {
            const double A[3] = {0.0, -5.0/9.0, -153.0/128.0};
            computeTileRHS_kernel<<<blocks, threads>>>(
                num_tiles_r, num_tiles_z, nr_cells, nz_cells, dr, dz, gamma, dt, A[stage], d_materials, d_tile_map, d_states_pool, d_dU_pool, spatialOrder, is_ideal_gas,
                static_cast<int>(bcRmin), static_cast<int>(bcRmax), static_cast<int>(bcZmin), static_cast<int>(bcZmax),
                ambient_rho, ambient_p
            );
            CUDA_CHECK(cudaGetLastError());
            
            applyLSRK3Step_kernel<<<current_pool_size, threads>>>(current_pool_size, stage, d_U_pool, d_dU_pool);
            CUDA_CHECK(cudaGetLastError());
            
            updatePrimitiveFromConservative_kernel<<<current_pool_size, threads>>>(current_pool_size, gamma, d_materials, ambient_rho, ambient_p, d_U_pool, d_states_pool);
            CUDA_CHECK(cudaGetLastError());
        }
    }
    
    if (!is_ideal_gas) {
        applyProgrammedBurn_kernel<<<blocks, threads>>>(num_tiles_r, num_tiles_z, nr_cells, nz_cells, dr, dz, currentTime, dt, det_x, det_y, det_z, d_materials, d_tile_map, d_U_pool);
        CUDA_CHECK(cudaGetLastError());
        
        updatePrimitiveFromConservative_kernel<<<current_pool_size, threads>>>(current_pool_size, gamma, d_materials, ambient_rho, ambient_p, d_U_pool, d_states_pool);
        CUDA_CHECK(cudaGetLastError());
    }
    
    currentTime += dt;
    step_count++;
    // Sync active region (tile pool expansion) every step to prevent the shock front
    // from outrunning the active tile pool.
    CUDA_CHECK(cudaDeviceSynchronize());
    updateActiveRegionHost();
}

std::vector<State2D> CFDSolver2DCuda::getStates() {
    CUDA_CHECK(cudaMemcpy(host_states_pool.data(), d_states_pool, current_pool_size * sizeof(PrimitiveTile), cudaMemcpyDeviceToHost));
    std::vector<State2D> out(nr_cells * nz_cells);
    // Expand to out... omitted for brevity
    return out;
}

std::vector<float> CFDSolver2DCuda::getTelemetry2D(int stride) {
    if (stride < 1) stride = 1;
    int out_nr = (nr_cells + stride - 1) / stride;
    int out_nz = (nz_cells + stride - 1) / stride;
    int n_ch = 7;
    std::vector<float> out(n_ch * out_nr * out_nz);
    float* data = out.data();
    int dest_stride = out_nr * out_nz;

    if (current_pool_size > 0) {
        CUDA_CHECK(cudaMemcpy(host_states_pool.data(), d_states_pool, current_pool_size * sizeof(PrimitiveTile), cudaMemcpyDeviceToHost));
    }

    #pragma omp parallel for collapse(2)
    for (int i = 0; i < out_nr; ++i) {
        for (int j = 0; j < out_nz; ++j) {
            int src_i = std::min(nr_cells - 1, i * stride);
            int src_j = std::min(nz_cells - 1, j * stride);
            
            int tr = src_i / TILE_SIZE;
            int tz = src_j / TILE_SIZE;
            int pool_idx = host_tile_map[tr * num_tiles_z + tz];
            int idx = i * out_nz + j;

            if (pool_idx == -1) {
                data[0 * dest_stride + idx] = ambient_p;
                data[1 * dest_stride + idx] = ambient_rho;
                data[2 * dest_stride + idx] = 0.0;
                data[3 * dest_stride + idx] = 0.0;
                data[4 * dest_stride + idx] = ambient_p / 0.4;
                data[5 * dest_stride + idx] = 0.0;
                data[6 * dest_stride + idx] = 0.0;
            } else {
                int k = (src_i % TILE_SIZE) * TILE_SIZE + (src_j % TILE_SIZE);
                data[0 * dest_stride + idx] = host_states_pool[pool_idx].p[k];
                data[1 * dest_stride + idx] = host_states_pool[pool_idx].rho[k];
                data[2 * dest_stride + idx] = host_states_pool[pool_idx].ur[k];
                data[3 * dest_stride + idx] = host_states_pool[pool_idx].uz[k];
                data[4 * dest_stride + idx] = host_states_pool[pool_idx].E[k];
                data[5 * dest_stride + idx] = host_states_pool[pool_idx].alpha1[k];
                data[6 * dest_stride + idx] = host_states_pool[pool_idx].alpha2[k];
            }
        }
    }
    return out;
}

double CFDSolver2DCuda::getMaxWaveSpeed() {
    if (current_pool_size == 0) return 340.0;
    
    dim3 threads(TILE_SIZE, TILE_SIZE);
    computeMaxWaveSpeed_kernel<<<current_pool_size, threads>>>(current_pool_size, gamma, d_materials, d_states_pool, d_block_maxes);
    CUDA_CHECK(cudaGetLastError());
    
    std::vector<double> host_block_maxes(current_pool_size);
    CUDA_CHECK(cudaMemcpy(host_block_maxes.data(), d_block_maxes, current_pool_size * sizeof(double), cudaMemcpyDeviceToHost));
    
    double max_speed = 1e-6;
    for (int p = 0; p < current_pool_size; ++p) {
        if (host_block_maxes[p] > max_speed) max_speed = host_block_maxes[p];
    }
    return max_speed;
}

__global__ void checkTerminationCudaKernel(
    const int32_t* tile_map, const PrimitiveTile* states_pool,
    int nr_cells, int nz_cells, int num_tiles_z, double ambient_p, double threshold,
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

bool CFDSolver2DCuda::checkTerminationCondition() {
    int h_terminated = 0;
    CUDA_CHECK(cudaMemcpy(d_terminated, &h_terminated, sizeof(int), cudaMemcpyHostToDevice));
    
    double threshold = 1.05 * ambient_p;
    int max_threads = std::max(nr_cells, nz_cells);
    int threads_per_block = 256;
    int num_blocks = (max_threads + threads_per_block - 1) / threads_per_block;
    
    checkTerminationCudaKernel<<<num_blocks, threads_per_block>>>(
        d_tile_map, d_states_pool, nr_cells, nz_cells, num_tiles_z, ambient_p, threshold,
        static_cast<int>(bcRmin), static_cast<int>(bcRmax), static_cast<int>(bcZmin), static_cast<int>(bcZmax),
        d_terminated
    );
    CUDA_CHECK(cudaGetLastError());
    CUDA_CHECK(cudaDeviceSynchronize());
    
    CUDA_CHECK(cudaMemcpy(&h_terminated, d_terminated, sizeof(int), cudaMemcpyDeviceToHost));
    return h_terminated == 1;
}

std::vector<float> CFDSolver2DCuda::getCellValues(int i, int j) {
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
        double h_rho = 0.0, h_ur = 0.0, h_uz = 0.0, h_p = 0.0, h_E = 0.0, h_a1 = 0.0, h_a2 = 0.0;
        
        CUDA_CHECK(cudaMemcpy(&h_rho, &(d_states_pool[pool_idx].rho[k]), sizeof(double), cudaMemcpyDeviceToHost));
        CUDA_CHECK(cudaMemcpy(&h_ur,  &(d_states_pool[pool_idx].ur[k]),  sizeof(double), cudaMemcpyDeviceToHost));
        CUDA_CHECK(cudaMemcpy(&h_uz,  &(d_states_pool[pool_idx].uz[k]),  sizeof(double), cudaMemcpyDeviceToHost));
        CUDA_CHECK(cudaMemcpy(&h_p,   &(d_states_pool[pool_idx].p[k]),   sizeof(double), cudaMemcpyDeviceToHost));
        CUDA_CHECK(cudaMemcpy(&h_E,   &(d_states_pool[pool_idx].E[k]),   sizeof(double), cudaMemcpyDeviceToHost));
        CUDA_CHECK(cudaMemcpy(&h_a1,  &(d_states_pool[pool_idx].alpha1[k]), sizeof(double), cudaMemcpyDeviceToHost));
        CUDA_CHECK(cudaMemcpy(&h_a2,  &(d_states_pool[pool_idx].alpha2[k]), sizeof(double), cudaMemcpyDeviceToHost));
        
        vals[0] = static_cast<float>(h_p);
        vals[1] = static_cast<float>(h_rho);
        double u_mag = std::sqrt(h_ur * h_ur + h_uz * h_uz);
        vals[2] = static_cast<float>(u_mag);
        
        double e_int = (h_rho > 0.0) ? (h_E / h_rho - 0.5 * u_mag * u_mag) : 0.0;
        vals[3] = static_cast<float>(e_int);
        
        vals[4] = static_cast<float>(std::clamp(h_a1, 0.0, 1.0));
        vals[5] = static_cast<float>(std::clamp(h_a2, 0.0, 1.0));
        double air_frac = 1.0 - h_a1 - h_a2;
        vals[6] = static_cast<float>(std::clamp(air_frac, 0.0, 1.0));
    }
    return vals;
}

void get_cuda_vram_info(size_t& free_bytes, size_t& total_bytes) {
    if (cudaMemGetInfo(&free_bytes, &total_bytes) != cudaSuccess) {
        free_bytes = 0;
        total_bytes = 0;
    }
}

