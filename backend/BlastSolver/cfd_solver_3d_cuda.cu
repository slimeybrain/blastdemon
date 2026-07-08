#include "cfd_solver_3d_cuda.hpp"
#include <cuda_runtime.h>

extern void remap_1d_to_3d(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d,
    CFDSolver3D& solver_3d, double x_expl, double y_expl, double z_expl, double R_remap);
#include <device_launch_parameters.h>
#include <iostream>

#define CHECK_CUDA(call) { \
    cudaError_t err = call; \
    if (err != cudaSuccess) { \
        std::cerr << "CUDA Error: " << cudaGetErrorString(err) << " at " << __FILE__ << ":" << __LINE__ << std::endl; \
    } \
}

// Global constants for GPU
__constant__ double d_gamma;
__constant__ double d_cellSize;
__constant__ int d_nx, d_ny, d_nz;
__constant__ int d_ntx, d_nty, d_ntz;
__constant__ bool d_useAUSM;
__constant__ double d_xmin, d_ymin, d_zmin;
__constant__ int d_bcXmin, d_bcXmax, d_bcYmin, d_bcYmax, d_bcZmin, d_bcZmax;
__constant__ int d_spatialOrder;
__constant__ int d_temporalOrder;
__constant__ double d_ambient_rho;
__constant__ double d_ambient_p;

template <bool IsMultiMaterial>
__global__ void __launch_bounds__(512) commit_states_kernel(PrimitiveTile3D<IsMultiMaterial>* states, ConservativeTile3D<IsMultiMaterial>* U, const uint8_t* active_tiles, int total_tiles) {
    int t_idx = blockIdx.x;
    if (t_idx >= total_tiles) return;
    if (!active_tiles[t_idx]) return;

    int c_idx = threadIdx.x;
    const auto& s = states[t_idx];
    auto& u = U[t_idx];

    u.rho[c_idx] = s.rho[c_idx];
    u.rhoux[c_idx] = s.rho[c_idx] * s.ux[c_idx];
    u.rhouy[c_idx] = s.rho[c_idx] * s.uy[c_idx];
    u.rhouz[c_idx] = s.rho[c_idx] * s.uz[c_idx];
    u.E[c_idx] = s.E[c_idx];

    if constexpr (IsMultiMaterial) {
        u.alpha1[c_idx] = s.alpha1[c_idx];
        u.alpha2[c_idx] = s.alpha2[c_idx];
        u.arho1[c_idx] = s.arho1[c_idx];
        u.arho2[c_idx] = s.arho2[c_idx];
    }
}

struct GPUCellState {
    double rho, ux, uy, uz, p, E;
};

__device__ void applyBC3DHelper_gpu(int& g, bool& r, int d_n, int bcMin, int bcMax) {
    if (g < 0) {
        if (bcMin == 0) { g = -g - 1; r = !r; }
        else { g = 0; }
    } else if (g >= d_n) {
        if (bcMax == 0) { g = 2 * d_n - 1 - g; r = !r; }
        else { g = d_n - 1; }
    }
}

template <bool IsMultiMaterial>
__device__ GPUCellState sample_gpu(const PrimitiveTile3D<IsMultiMaterial>* states, int gx, int gy, int gz) {
    bool rx = false, ry = false, rz = false;

    applyBC3DHelper_gpu(gx, rx, d_nx, d_bcXmin, d_bcXmax);
    applyBC3DHelper_gpu(gy, ry, d_ny, d_bcYmin, d_bcYmax);
    applyBC3DHelper_gpu(gz, rz, d_nz, d_bcZmin, d_bcZmax);

    int tx = gx / TILE_SIZE_3D;
    int ty = gy / TILE_SIZE_3D;
    int tz = gz / TILE_SIZE_3D;
    int t_idx = tx + ty * d_ntx + tz * d_ntx * d_nty;

    int lx = gx % TILE_SIZE_3D;
    int ly = gy % TILE_SIZE_3D;
    int lz = gz % TILE_SIZE_3D;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    const auto& tile = states[t_idx];
    GPUCellState s;
    s.rho = tile.rho[c_idx];
    s.ux = rx ? -tile.ux[c_idx] : tile.ux[c_idx];
    s.uy = ry ? -tile.uy[c_idx] : tile.uy[c_idx];
    s.uz = rz ? -tile.uz[c_idx] : tile.uz[c_idx];
    s.p = tile.p[c_idx];
    s.E = tile.E[c_idx];
    return s;
}

__device__ void getRusanovFluxGPU(const GPUCellState& sL, const GPUCellState& sR, double* flux, int dir, double gamma) {
    double unL = (dir == 0) ? sL.ux : (dir == 1 ? sL.uy : sL.uz);
    double unR = (dir == 0) ? sR.ux : (dir == 1 ? sR.uy : sR.uz);

    double fL[5], fR[5];
    fL[0] = sL.rho * unL;
    fL[1] = sL.rho * unL * sL.ux + (dir == 0 ? sL.p : 0);
    fL[2] = sL.rho * unL * sL.uy + (dir == 1 ? sL.p : 0);
    fL[3] = sL.rho * unL * sL.uz + (dir == 2 ? sL.p : 0);
    fL[4] = unL * (sL.E + sL.p);

    fR[0] = sR.rho * unR;
    fR[1] = sR.rho * unR * sR.ux + (dir == 0 ? sR.p : 0);
    fR[2] = sR.rho * unR * sR.uy + (dir == 1 ? sR.p : 0);
    fR[3] = sR.rho * unR * sR.uz + (dir == 2 ? sR.p : 0);
    fR[4] = unR * (sR.E + sR.p);

    double cL = sqrt(gamma * sL.p / max(1e-6, sL.rho));
    double cR = sqrt(gamma * sR.p / max(1e-6, sR.rho));
    double s_max = fmax(fabs(unL) + cL, fabs(unR) + cR);

    double UL[5] = {sL.rho, sL.rho*sL.ux, sL.rho*sL.uy, sL.rho*sL.uz, sL.E};
    double UR[5] = {sR.rho, sR.rho*sR.ux, sR.rho*sR.uy, sR.rho*sR.uz, sR.E};

    for(int i=0; i<5; ++i) {
        flux[i] = 0.5 * (fL[i] + fR[i]) - 0.5 * s_max * (UR[i] - UL[i]);
    }
}

__device__ void getAUSMPlusFluxGPU(const GPUCellState& sL, const GPUCellState& sR, double* flux, int dir, double gamma) {
    double aL = sqrt(gamma * sL.p / max(1e-6, sL.rho));
    double aR = sqrt(gamma * sR.p / max(1e-6, sR.rho));
    double a_half = 0.5 * (aL + aR);

    double uL = (dir == 0) ? sL.ux : (dir == 1 ? sL.uy : sL.uz);
    double uR = (dir == 0) ? sR.ux : (dir == 1 ? sR.uy : sR.uz);
    double ML = uL / a_half;
    double MR = uR / a_half;

    double alpha = 3.0 / 16.0;
    double beta = 1.0 / 8.0;

    auto get_M_plus = [beta](double M) {
        if (fabs(M) <= 1.0) {
            double term = 0.25 * (M + 1.0) * (M + 1.0);
            return term + beta * (M * M - 1.0) * (M * M - 1.0);
        } else {
            return 0.5 * (M + fabs(M));
        }
    };
    auto get_M_minus = [beta](double M) {
        if (fabs(M) <= 1.0) {
            double term = -0.25 * (M - 1.0) * (M - 1.0);
            return term - beta * (M * M - 1.0) * (M * M - 1.0);
        } else {
            return 0.5 * (M - fabs(M));
        }
    };
    auto get_P_plus = [alpha](double M) {
        if (fabs(M) <= 1.0) {
            double term = 0.25 * (M + 1.0) * (M + 1.0) * (2.0 - M);
            return term + alpha * M * (M * M - 1.0) * (M * M - 1.0);
        } else {
            return (M >= 0.0) ? 1.0 : 0.0;
        }
    };
    auto get_P_minus = [alpha](double M) {
        if (fabs(M) <= 1.0) {
            double term = 0.25 * (M - 1.0) * (M - 1.0) * (2.0 + M);
            return term - alpha * M * (M * M - 1.0) * (M * M - 1.0);
        } else {
            return (M < 0.0) ? 1.0 : 0.0;
        }
    };

    double M_half = get_M_plus(ML) + get_M_minus(MR);
    double p_half = get_P_plus(ML) * sL.p + get_P_minus(MR) * sR.p;

    if (M_half >= 0.0) {
        flux[0] = M_half * a_half * sL.rho;
        flux[1] = M_half * a_half * sL.rho * sL.ux + (dir == 0 ? p_half : 0);
        flux[2] = M_half * a_half * sL.rho * sL.uy + (dir == 1 ? p_half : 0);
        flux[3] = M_half * a_half * sL.rho * sL.uz + (dir == 2 ? p_half : 0);
        flux[4] = M_half * a_half * (sL.E + sL.p);
    } else {
        flux[0] = M_half * a_half * sR.rho;
        flux[1] = M_half * a_half * sR.rho * sR.ux + (dir == 0 ? p_half : 0);
        flux[2] = M_half * a_half * sR.rho * sR.uy + (dir == 1 ? p_half : 0);
        flux[3] = M_half * a_half * sR.rho * sR.uz + (dir == 2 ? p_half : 0);
        flux[4] = M_half * a_half * (sR.E + sR.p);
    }

    // Entropy fix for expansion shocks (Harten parity)
    double lambda_minus_L = uL - aL;
    double lambda_minus_R = uR - aR;
    if (lambda_minus_L < 0.0 && lambda_minus_R > 0.0) {
        double dlambda = lambda_minus_R - lambda_minus_L;
        double diss = dlambda > 0 ? (dlambda * dlambda) / (4.0 * dlambda) : 0.0;
        flux[0] -= diss * (sR.rho - sL.rho);
        flux[1] -= diss * (sR.rho * sR.ux - sL.rho * sL.ux);
        flux[2] -= diss * (sR.rho * sR.uy - sL.rho * sL.uy);
        flux[3] -= diss * (sR.rho * sR.uz - sL.rho * sL.uz);
        flux[4] -= diss * (sR.E - sL.E);
    }

    double lambda_plus_L = uL + aL;
    double lambda_plus_R = uR + aR;
    if (lambda_plus_L < 0.0 && lambda_plus_R > 0.0) {
        double dlambda = lambda_plus_R - lambda_plus_L;
        double diss = dlambda > 0 ? (dlambda * dlambda) / (4.0 * dlambda) : 0.0;
        flux[0] -= diss * (sR.rho - sL.rho);
        flux[1] -= diss * (sR.rho * sR.ux - sL.rho * sL.ux);
        flux[2] -= diss * (sR.rho * sR.uy - sL.rho * sL.uy);
        flux[3] -= diss * (sR.rho * sR.uz - sL.rho * sL.uz);
        flux[4] -= diss * (sR.E - sL.E);
    }
}

__device__ double minmod_gpu(double a, double b) {
    if (a * b <= 0) return 0;
    return (fabs(a) < fabs(b)) ? a : b;
}

__device__ double weno3_gpu(double vM1, double v0, double vP1) {
    double d0 = v0 - vM1;
    double d1 = vP1 - v0;
    
    double beta0 = d0 * d0;
    double beta1 = d1 * d1;
    
    double eps = 1e-6;
    double alpha0 = 1.0 / (3.0 * (eps + beta0) * (eps + beta0));
    double alpha1 = 2.0 / (3.0 * (eps + beta1) * (eps + beta1));
    
    double sum_alpha = alpha0 + alpha1;
    double w0 = alpha0 / sum_alpha;
    double w1 = alpha1 / sum_alpha;
    
    double p0 = v0 + 0.5 * d0;
    double p1 = v0 + 0.5 * d1;
    
    return w0 * p0 + w1 * p1;
}

template <bool IsMultiMaterial>
__device__ void reconstruct_gpu(const PrimitiveTile3D<IsMultiMaterial>* states, int gx, int gy, int gz, int dir, GPUCellState& sL, GPUCellState& sR) {
    GPUCellState sM2 = sample_gpu(states, gx - (dir == 0 ? 2 : 0), gy - (dir == 1 ? 2 : 0), gz - (dir == 2 ? 2 : 0));
    GPUCellState sM1 = sample_gpu(states, gx - (dir == 0 ? 1 : 0), gy - (dir == 1 ? 1 : 0), gz - (dir == 2 ? 1 : 0));
    GPUCellState sP0 = sample_gpu(states, gx, gy, gz);
    GPUCellState sP1 = sample_gpu(states, gx + (dir == 0 ? 1 : 0), gy + (dir == 1 ? 1 : 0), gz + (dir == 2 ? 1 : 0));

    auto reconstruct_channel = [&](double vM2, double vM1, double vP0, double vP1, double& vL, double& vR) {
        if (d_spatialOrder == 1) {
            vL = vM1;
            vR = vP0;
        } else if (d_spatialOrder == 3) {
            vL = weno3_gpu(vM2, vM1, vP0);
            vR = weno3_gpu(vP1, vP0, vM1);
        } else { // Order 2 or default
            double dL = vM1 - vM2;
            double dC = vP0 - vM1;
            double dR = vP1 - vP0;
            vL = vM1 + 0.5 * minmod_gpu(dL, dC);
            vR = vP0 - 0.5 * minmod_gpu(dC, dR);
        }
    };

    reconstruct_channel(sM2.rho, sM1.rho, sP0.rho, sP1.rho, sL.rho, sR.rho);
    sL.rho = fmax(1e-7, sL.rho);
    sR.rho = fmax(1e-7, sR.rho);
    reconstruct_channel(sM2.ux, sM1.ux, sP0.ux, sP1.ux, sL.ux, sR.ux);
    reconstruct_channel(sM2.uy, sM1.uy, sP0.uy, sP1.uy, sL.uy, sR.uy);
    reconstruct_channel(sM2.uz, sM1.uz, sP0.uz, sP1.uz, sL.uz, sR.uz);
    reconstruct_channel(sM2.p, sM1.p, sP0.p, sP1.p, sL.p, sR.p);
    sL.p = fmax(1e-7, sL.p);
    sR.p = fmax(1e-7, sR.p);

    sL.E = sL.p / (d_gamma - 1.0) + 0.5 * sL.rho * (sL.ux*sL.ux + sL.uy*sL.uy + sL.uz*sL.uz);
    sR.E = sR.p / (d_gamma - 1.0) + 0.5 * sR.rho * (sR.ux*sR.ux + sR.uy*sR.uy + sR.uz*sR.uz);
}

template <bool IsMultiMaterial>
__global__ void __launch_bounds__(512) compute_flux_kernel_3d(const PrimitiveTile3D<IsMultiMaterial>* states, ConservativeTile3D<IsMultiMaterial>* U, const uint8_t* active_tiles, double dt) {
    int tx = blockIdx.x;
    int ty = blockIdx.y;
    int tz = blockIdx.z;
    int t_idx = tx + ty * d_ntx + tz * d_ntx * d_nty;



    if (!active_tiles[t_idx]) return;

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    int gx = tx * TILE_SIZE_3D + lx;
    int gy = ty * TILE_SIZE_3D + ly;
    int gz = tz * TILE_SIZE_3D + lz;

    if (gx >= d_nx || gy >= d_ny || gz >= d_nz) return;

    double fXL[5], fXR[5], fYB[5], fYT[5], fZD[5], fZU[5];
    GPUCellState sL, sR;

    // X Direction
    reconstruct_gpu(states, gx, gy, gz, 0, sL, sR);
    if (d_useAUSM) getAUSMPlusFluxGPU(sL, sR, fXL, 0, d_gamma);
    else getRusanovFluxGPU(sL, sR, fXL, 0, d_gamma);

    reconstruct_gpu(states, gx+1, gy, gz, 0, sL, sR);
    if (d_useAUSM) getAUSMPlusFluxGPU(sL, sR, fXR, 0, d_gamma);
    else getRusanovFluxGPU(sL, sR, fXR, 0, d_gamma);

    // Y Direction
    reconstruct_gpu(states, gx, gy, gz, 1, sL, sR);
    if (d_useAUSM) getAUSMPlusFluxGPU(sL, sR, fYB, 1, d_gamma);
    else getRusanovFluxGPU(sL, sR, fYB, 1, d_gamma);

    reconstruct_gpu(states, gx, gy+1, gz, 1, sL, sR);
    if (d_useAUSM) getAUSMPlusFluxGPU(sL, sR, fYT, 1, d_gamma);
    else getRusanovFluxGPU(sL, sR, fYT, 1, d_gamma);

    // Z Direction
    reconstruct_gpu(states, gx, gy, gz, 2, sL, sR);
    if (d_useAUSM) getAUSMPlusFluxGPU(sL, sR, fZD, 2, d_gamma);
    else getRusanovFluxGPU(sL, sR, fZD, 2, d_gamma);

    reconstruct_gpu(states, gx, gy, gz+1, 2, sL, sR);
    if (d_useAUSM) getAUSMPlusFluxGPU(sL, sR, fZU, 2, d_gamma);
    else getRusanovFluxGPU(sL, sR, fZU, 2, d_gamma);



    double invDx = 1.0 / d_cellSize;
    double dt_dx = dt * invDx;

    U[t_idx].rho[c_idx]   -= dt_dx * (fXR[0] - fXL[0] + fYT[0] - fYB[0] + fZU[0] - fZD[0]);
    U[t_idx].rhoux[c_idx] -= dt_dx * (fXR[1] - fXL[1] + fYT[1] - fYB[1] + fZU[1] - fZD[1]);
    U[t_idx].rhouy[c_idx] -= dt_dx * (fXR[2] - fXL[2] + fYT[2] - fYB[2] + fZU[2] - fZD[2]);
    U[t_idx].rhouz[c_idx] -= dt_dx * (fXR[3] - fXL[3] + fYT[3] - fYB[3] + fZU[3] - fZD[3]);
    U[t_idx].E[c_idx]     -= dt_dx * (fXR[4] - fXL[4] + fYT[4] - fYB[4] + fZU[4] - fZD[4]);
}

template <bool IsMultiMaterial>
__global__ void __launch_bounds__(512) update_primitive_kernel_3d(PrimitiveTile3D<IsMultiMaterial>* states, ConservativeTile3D<IsMultiMaterial>* U, const uint8_t* active_tiles) {
    int tx = blockIdx.x;
    int ty = blockIdx.y;
    int tz = blockIdx.z;
    int t_idx = tx + ty * d_ntx + tz * d_ntx * d_nty;

    if (!active_tiles[t_idx]) return;

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    double u_rho = U[t_idx].rho[c_idx];
    double u_rhoux = U[t_idx].rhoux[c_idx];
    double u_rhouy = U[t_idx].rhouy[c_idx];
    double u_rhouz = U[t_idx].rhouz[c_idx];
    double u_E = U[t_idx].E[c_idx];

    bool bad = isnan(u_rho) || isinf(u_rho) || u_rho < 1e-8 ||
               isnan(u_rhoux) || isinf(u_rhoux) ||
               isnan(u_rhouy) || isinf(u_rhouy) ||
               isnan(u_rhouz) || isinf(u_rhouz) ||
               isnan(u_E) || isinf(u_E);

    if constexpr (IsMultiMaterial) {
        bad = bad || isnan(U[t_idx].alpha1[c_idx]) || isinf(U[t_idx].alpha1[c_idx]) ||
                    isnan(U[t_idx].alpha2[c_idx]) || isinf(U[t_idx].alpha2[c_idx]) ||
                    isnan(U[t_idx].arho1[c_idx]) || isinf(U[t_idx].arho1[c_idx]) ||
                    isnan(U[t_idx].arho2[c_idx]) || isinf(U[t_idx].arho2[c_idx]);
    }

    double rho = d_ambient_rho;
    double ux = 0.0;
    double uy = 0.0;
    double uz = 0.0;
    double p = d_ambient_p;
    double E = d_ambient_p / (d_gamma - 1.0);
    double alpha1 = 0.0;
    double alpha2 = 0.0;
    double arho1 = 0.0;
    double arho2 = 0.0;

    if (!bad) {
        rho = u_rho;
        ux = u_rhoux / rho;
        uy = u_rhouy / rho;
        uz = u_rhouz / rho;
        double ke = 0.5 * rho * (ux*ux + uy*uy + uz*uz);
        double e_int = u_E - ke;

        if constexpr (IsMultiMaterial) {
            alpha1 = fmax(0.0, fmin(1.0, U[t_idx].alpha1[c_idx]));
            alpha2 = fmax(0.0, fmin(1.0, U[t_idx].alpha2[c_idx]));
            arho1 = fmax(0.0, fmin(rho, U[t_idx].arho1[c_idx]));
            arho2 = fmax(0.0, fmin(rho, U[t_idx].arho2[c_idx]));
        }

        double p_val = e_int * (d_gamma - 1.0);
        if (isnan(p_val) || isinf(p_val) || p_val < 1e-8) {
            bad = true;
        } else {
            p = p_val;
            E = u_E;
        }
    }

    if (bad) {
        rho = d_ambient_rho;
        ux = 0.0;
        uy = 0.0;
        uz = 0.0;
        p = d_ambient_p;
        E = d_ambient_p / (d_gamma - 1.0);
        alpha1 = 0.0;
        alpha2 = 0.0;
        arho1 = 0.0;
        arho2 = 0.0;

        U[t_idx].rho[c_idx] = d_ambient_rho;
        U[t_idx].rhoux[c_idx] = 0.0;
        U[t_idx].rhouy[c_idx] = 0.0;
        U[t_idx].rhouz[c_idx] = 0.0;
        U[t_idx].E[c_idx] = E;
        if constexpr (IsMultiMaterial) {
            U[t_idx].alpha1[c_idx] = 0.0;
            U[t_idx].alpha2[c_idx] = 0.0;
            U[t_idx].arho1[c_idx] = 0.0;
            U[t_idx].arho2[c_idx] = 0.0;
        }
    }

    states[t_idx].rho[c_idx] = rho;
    states[t_idx].ux[c_idx] = ux;
    states[t_idx].uy[c_idx] = uy;
    states[t_idx].uz[c_idx] = uz;
    states[t_idx].p[c_idx] = p;
    states[t_idx].E[c_idx] = E;
    states[t_idx].floor_status[c_idx] = bad ? 1 : 0;
    if constexpr (IsMultiMaterial) {
        states[t_idx].alpha1[c_idx] = alpha1;
        states[t_idx].alpha2[c_idx] = alpha2;
        states[t_idx].arho1[c_idx] = arho1;
        states[t_idx].arho2[c_idx] = arho2;
    }
}

template <bool IsMultiMaterial>
__global__ void __launch_bounds__(512) apply_bc_kernel_3d(PrimitiveTile3D<IsMultiMaterial>* states, int nx, int ny, int nz) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    int j = blockIdx.y * blockDim.y + threadIdx.y;
    int k = blockIdx.z * blockDim.z + threadIdx.z;

    if (i >= nx || j >= ny || k >= nz) return;

    // Simple ghost-cell copy or reflective BC on boundaries
    // This is a placeholder for more complex BC logic if needed
}

template <bool IsMultiMaterial>
__global__ void __launch_bounds__(512) set_initial_condition_kernel(PrimitiveTile3D<IsMultiMaterial>* states, ConservativeTile3D<IsMultiMaterial>* U, uint8_t* active_tiles,
                                            int nx, int ny, int nz, double cellSize, double xmin, double ymin, double zmin,
                                            double amb_rho, double amb_p, double gamma,
                                            Charge3DParams charge, double high_rho, double det_energy, double det_vel) {
    int tx = blockIdx.x;
    int ty = blockIdx.y;
    int tz = blockIdx.z;
    int t_idx = tx + ty * d_ntx + tz * d_ntx * d_nty;

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    int gx = tx * TILE_SIZE_3D + lx;
    int gy = ty * TILE_SIZE_3D + ly;
    int gz = tz * TILE_SIZE_3D + lz;

    if (gx >= nx || gy >= ny || gz >= nz) return;

    double x_c = xmin + (gx + 0.5) * cellSize;
    double y_c = ymin + (gy + 0.5) * cellSize;
    double z_c = zmin + (gz + 0.5) * cellSize;

    int points_inside = 0;
    for (double ox : {-0.25, 0.25}) {
        for (double oy : {-0.25, 0.25}) {
            for (double oz : {-0.25, 0.25}) {
                double px = x_c + ox * cellSize;
                double py = y_c + oy * cellSize;
                double pz = z_c + oz * cellSize;
                double dx_p = px - charge.x;
                double dy_p = py - charge.y;
                double dz_p = pz - charge.z;
                double dist_sq_p = dx_p*dx_p + dy_p*dy_p + dz_p*dz_p;
                bool inside = false;
                if (charge.shape_type == 0) { // Sphere
                    if (dist_sq_p <= charge.radius * charge.radius) inside = true;
                } else if (charge.shape_type == 1) { // Block
                    if (fabs(dx_p) <= charge.lx*0.5 && fabs(dy_p) <= charge.ly*0.5 && fabs(dz_p) <= charge.lz*0.5) inside = true;
                } else if (charge.shape_type == 2) { // Cylinder
                    double dr_sq_p = dx_p*dx_p + dy_p*dy_p;
                    if (dr_sq_p <= charge.radius*charge.radius && fabs(dz_p) <= charge.height*0.5) inside = true;
                }
                if (inside) points_inside++;
            }
        }
    }
    double f_vol = points_inside / 8.0;

    double rho = amb_rho;
    double p = amb_p;
    double arrival_time = -1.0;
    double alpha1 = 0.0;
    double alpha2 = 0.0;
    double arho1 = 0.0;
    double arho2 = 0.0;

    if (f_vol > 0.0) {
        if constexpr (IsMultiMaterial) {
            alpha1 = 1.0 - f_vol;
            alpha2 = f_vol;
            arho1 = alpha1 * amb_rho;
            arho2 = alpha2 * high_rho;
            rho = arho1 + arho2;
            p = amb_p;
            double dx = x_c - charge.x;
            double dy = y_c - charge.y;
            double dz = z_c - charge.z;
            double dist = sqrt(dx*dx + dy*dy + dz*dz);
            arrival_time = dist / det_vel;
        } else {
            rho = f_vol * high_rho + (1.0 - f_vol) * amb_rho;
            double p_high = (gamma - 1.0) * high_rho * det_energy;
            p = f_vol * p_high + (1.0 - f_vol) * amb_p;
        }
        active_tiles[t_idx] = 1;
    }

    states[t_idx].rho[c_idx] = rho;
    states[t_idx].ux[c_idx] = 0;
    states[t_idx].uy[c_idx] = 0;
    states[t_idx].uz[c_idx] = 0;
    states[t_idx].p[c_idx] = p;
    states[t_idx].E[c_idx] = p / (gamma - 1.0);
    states[t_idx].arrival_time[c_idx] = arrival_time;
    if constexpr (IsMultiMaterial) {
        states[t_idx].alpha1[c_idx] = alpha1;
        states[t_idx].alpha2[c_idx] = alpha2;
        states[t_idx].arho1[c_idx] = arho1;
        states[t_idx].arho2[c_idx] = arho2;
    }

    U[t_idx].rho[c_idx] = rho;
    U[t_idx].rhoux[c_idx] = 0;
    U[t_idx].rhouy[c_idx] = 0;
    U[t_idx].rhouz[c_idx] = 0;
    U[t_idx].E[c_idx] = states[t_idx].E[c_idx];
    if constexpr (IsMultiMaterial) {
        U[t_idx].alpha1[c_idx] = alpha1;
        U[t_idx].alpha2[c_idx] = alpha2;
        U[t_idx].arho1[c_idx] = arho1;
        U[t_idx].arho2[c_idx] = arho2;
    }
}

template <bool IsMultiMaterial>
__device__ float get_value_by_qty(const PrimitiveTile3D<IsMultiMaterial>& tile, int c_idx, int qty_id) {
    if (qty_id == 1) return (float)tile.rho[c_idx];
    if (qty_id == 2) {
        double ux = tile.ux[c_idx];
        double uy = tile.uy[c_idx];
        double uz = tile.uz[c_idx];
        return (float)sqrt(ux*ux + uy*uy + uz*uz);
    }
    if (qty_id == 3) return (float)(tile.E[c_idx] / max(1e-6, tile.rho[c_idx]));
    return (float)tile.p[c_idx];
}

template <bool IsMultiMaterial>
__global__ void extract_slice_kernel(const PrimitiveTile3D<IsMultiMaterial>* states, float* data, int nx, int ny, int nz, int axis, double offset, double xmin, double ymin, double zmin, double dx, int qty_id, int stride) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;
    int j = blockIdx.y * blockDim.y + threadIdx.y;

    int w = 0, h = 0;
    if (axis == 0) { w = (nx + stride - 1) / stride; h = (ny + stride - 1) / stride; }
    else if (axis == 1) { w = (nx + stride - 1) / stride; h = (nz + stride - 1) / stride; }
    else { w = (ny + stride - 1) / stride; h = (nz + stride - 1) / stride; }

    if (i >= w || j >= h) return;

    int gx = i * stride;
    int gy = j * stride;
    int gz = 0;

    if (axis == 0) {
        gz = round((offset - zmin) / dx - 0.5);
        gz = max(0, min(nz - 1, gz));
    } else if (axis == 1) {
        gz = j * stride;
        gy = round((offset - ymin) / dx - 0.5);
        gy = max(0, min(ny - 1, gy));
    } else {
        gz = j * stride;
        gy = i * stride;
        gx = round((offset - xmin) / dx - 0.5);
        gx = max(0, min(nx - 1, gx));
    }

    int tx = gx / TILE_SIZE_3D, ty = gy / TILE_SIZE_3D, tz = gz / TILE_SIZE_3D;
    int ntx = (nx + 7) / 8;
    int nty = (ny + 7) / 8;
    int t_idx = tx + ty * ntx + tz * ntx * nty;
    int lx = gx % TILE_SIZE_3D, ly = gy % TILE_SIZE_3D, lz = gz % TILE_SIZE_3D;
    int c_idx = lx + ly * 8 + lz * 64;

    data[i + j * w] = get_value_by_qty(states[t_idx], c_idx, qty_id);
}
template <bool IsMultiMaterial>

CFDSolver3DCuda<IsMultiMaterial>::CFDSolver3DCuda(int nx, int ny, int nz, double cellSize, double xmin, double ymin, double zmin)
    : CFDSolver3DImplBase(nx, ny, nz, cellSize, xmin, ymin, zmin) {

    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    CHECK_CUDA(cudaMalloc(&d_states, total_tiles * sizeof(PrimitiveTile3D<IsMultiMaterial>)));
    CHECK_CUDA(cudaMalloc(&d_U, total_tiles * sizeof(ConservativeTile3D<IsMultiMaterial>)));
    CHECK_CUDA(cudaMalloc(&d_U_prev, total_tiles * sizeof(ConservativeTile3D<IsMultiMaterial>)));
    CHECK_CUDA(cudaMalloc(&d_active_tiles, total_tiles * sizeof(uint8_t)));

    // Pre-allocate auxiliary buffers
    CHECK_CUDA(cudaMalloc(&d_max_s_buf, total_tiles * sizeof(double)));
    CHECK_CUDA(cudaMalloc(&d_slice_buf, nx * ny * nz * sizeof(float))); // Large enough for any slice

    CHECK_CUDA(cudaMemcpyToSymbol(d_nx, &nx, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_ny, &ny, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_nz, &nz, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_ntx, &ntx, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_nty, &nty, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_ntz, &ntz, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_cellSize, &cellSize, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_xmin, &xmin, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_ymin, &ymin, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_zmin, &zmin, sizeof(double)));
    double g = gamma;
    CHECK_CUDA(cudaMemcpyToSymbol(d_gamma, &g, sizeof(double)));
    bool useAUSM = false;
    CHECK_CUDA(cudaMemcpyToSymbol(d_useAUSM, &useAUSM, sizeof(bool)));

    is_ideal_gas_val = !IsMultiMaterial;
    updateBoundaryConditions();
}

template <bool IsMultiMaterial>
void CFDSolver3DCuda<IsMultiMaterial>::updateBoundaryConditions() {
    int b1 = (int)bcXmin, b2 = (int)bcXmax, b3 = (int)bcYmin, b4 = (int)bcYmax, b5 = (int)bcZmin, b6 = (int)bcZmax;
    CHECK_CUDA(cudaMemcpyToSymbol(d_bcXmin, &b1, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_bcXmax, &b2, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_bcYmin, &b3, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_bcYmax, &b4, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_bcZmin, &b5, sizeof(int)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_bcZmax, &b6, sizeof(int)));
}
template <bool IsMultiMaterial>

CFDSolver3DCuda<IsMultiMaterial>::~CFDSolver3DCuda() {
    if (d_states) cudaFree(d_states);
    if (d_U) cudaFree(d_U);
    if (d_U_prev) cudaFree(d_U_prev);
    if (d_active_tiles) cudaFree(d_active_tiles);
    if (d_max_s_buf) cudaFree(d_max_s_buf);
    if (d_slice_buf) cudaFree(d_slice_buf);
}

template <bool IsMultiMaterial>
void CFDSolver3DCuda<IsMultiMaterial>::setDetonatorLocation(double x, double y, double z) {
    detX = x; detY = y; detZ = z;
}

template <bool IsMultiMaterial>
void CFDSolver3DCuda<IsMultiMaterial>::setInitialCondition(const Charge3DParams& charge, const MultiMat::MaterialSet& materials, double amb_rho, double amb_p) {
    currentMaterials = materials;
    CHECK_CUDA(cudaMemcpyToSymbol(d_ambient_rho, &amb_rho, sizeof(double)));
    CHECK_CUDA(cudaMemcpyToSymbol(d_ambient_p, &amb_p, sizeof(double)));
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    CHECK_CUDA(cudaMemset(d_active_tiles, 0, total_tiles * sizeof(uint8_t)));

    dim3 blocks(ntx, nty, ntz);
    dim3 threads(TILE_SIZE_3D, TILE_SIZE_3D, TILE_SIZE_3D);

    set_initial_condition_kernel<IsMultiMaterial><<<blocks, threads>>>(
        (PrimitiveTile3D<IsMultiMaterial>*)d_states, (ConservativeTile3D<IsMultiMaterial>*)d_U, (uint8_t*)d_active_tiles,
        nx, ny, nz, cellSize, xmin, ymin, zmin,
        amb_rho, amb_p, gamma, charge,
        materials.unreacted.rho0, materials.detonation_energy, materials.det_vel
    );
    CHECK_CUDA(cudaDeviceSynchronize());
    updateActiveRegions();
}

template <bool IsMultiMaterial>
__global__ void __launch_bounds__(512) average_U_kernel_3d(ConservativeTile3D<IsMultiMaterial>* U, const ConservativeTile3D<IsMultiMaterial>* U_prev, const uint8_t* active_tiles, double w0, double w1) {
    int tx = blockIdx.x;
    int ty = blockIdx.y;
    int tz = blockIdx.z;
    int t_idx = tx + ty * d_ntx + tz * d_ntx * d_nty;

    if (!active_tiles[t_idx]) return;

    int lx = threadIdx.x;
    int ly = threadIdx.y;
    int lz = threadIdx.z;
    int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

    U[t_idx].rho[c_idx] = w0 * U_prev[t_idx].rho[c_idx] + w1 * U[t_idx].rho[c_idx];
    U[t_idx].rhoux[c_idx] = w0 * U_prev[t_idx].rhoux[c_idx] + w1 * U[t_idx].rhoux[c_idx];
    U[t_idx].rhouy[c_idx] = w0 * U_prev[t_idx].rhouy[c_idx] + w1 * U[t_idx].rhouy[c_idx];
    U[t_idx].rhouz[c_idx] = w0 * U_prev[t_idx].rhouz[c_idx] + w1 * U[t_idx].rhouz[c_idx];
    U[t_idx].E[c_idx] = w0 * U_prev[t_idx].E[c_idx] + w1 * U[t_idx].E[c_idx];
    if constexpr (IsMultiMaterial) {
        U[t_idx].alpha1[c_idx] = w0 * U_prev[t_idx].alpha1[c_idx] + w1 * U[t_idx].alpha1[c_idx];
        U[t_idx].alpha2[c_idx] = w0 * U_prev[t_idx].alpha2[c_idx] + w1 * U[t_idx].alpha2[c_idx];
        U[t_idx].arho1[c_idx] = w0 * U_prev[t_idx].arho1[c_idx] + w1 * U[t_idx].arho1[c_idx];
        U[t_idx].arho2[c_idx] = w0 * U_prev[t_idx].arho2[c_idx] + w1 * U[t_idx].arho2[c_idx];
    }
}

template <bool IsMultiMaterial>
void CFDSolver3DCuda<IsMultiMaterial>::step(double dt) {
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;

    dim3 blocks(ntx, nty, ntz);
    dim3 threads(TILE_SIZE_3D, TILE_SIZE_3D, TILE_SIZE_3D);

    if (temporalOrder == 1) {
        compute_flux_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((const PrimitiveTile3D<IsMultiMaterial>*)d_states, (ConservativeTile3D<IsMultiMaterial>*)d_U, (const uint8_t*)d_active_tiles, dt);
        update_primitive_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((PrimitiveTile3D<IsMultiMaterial>*)d_states, (ConservativeTile3D<IsMultiMaterial>*)d_U, (const uint8_t*)d_active_tiles);
        apply_bc_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((PrimitiveTile3D<IsMultiMaterial>*)d_states, nx, ny, nz);
    } else if (temporalOrder == 2) {
        // Copy U_pool to U_prev_pool
        int total_tiles = ntx * nty * ntz;
        CHECK_CUDA(cudaMemcpy(d_U_prev, d_U, total_tiles * sizeof(ConservativeTile3D<IsMultiMaterial>), cudaMemcpyDeviceToDevice));
        
        // Stage 1
        compute_flux_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((const PrimitiveTile3D<IsMultiMaterial>*)d_states, (ConservativeTile3D<IsMultiMaterial>*)d_U, (const uint8_t*)d_active_tiles, dt);
        update_primitive_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((PrimitiveTile3D<IsMultiMaterial>*)d_states, (ConservativeTile3D<IsMultiMaterial>*)d_U, (const uint8_t*)d_active_tiles);
        apply_bc_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((PrimitiveTile3D<IsMultiMaterial>*)d_states, nx, ny, nz);

        // Stage 2
        compute_flux_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((const PrimitiveTile3D<IsMultiMaterial>*)d_states, (ConservativeTile3D<IsMultiMaterial>*)d_U, (const uint8_t*)d_active_tiles, dt);
        average_U_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((ConservativeTile3D<IsMultiMaterial>*)d_U, (const ConservativeTile3D<IsMultiMaterial>*)d_U_prev, (const uint8_t*)d_active_tiles, 0.5, 0.5);
        update_primitive_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((PrimitiveTile3D<IsMultiMaterial>*)d_states, (ConservativeTile3D<IsMultiMaterial>*)d_U, (const uint8_t*)d_active_tiles);
        apply_bc_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((PrimitiveTile3D<IsMultiMaterial>*)d_states, nx, ny, nz);
    } else { // SSP-RK3
        // Copy U_pool to U_prev_pool
        int total_tiles = ntx * nty * ntz;
        CHECK_CUDA(cudaMemcpy(d_U_prev, d_U, total_tiles * sizeof(ConservativeTile3D<IsMultiMaterial>), cudaMemcpyDeviceToDevice));
        
        // Stage 1
        compute_flux_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((const PrimitiveTile3D<IsMultiMaterial>*)d_states, (ConservativeTile3D<IsMultiMaterial>*)d_U, (const uint8_t*)d_active_tiles, dt);
        CHECK_CUDA(cudaGetLastError());
        update_primitive_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((PrimitiveTile3D<IsMultiMaterial>*)d_states, (ConservativeTile3D<IsMultiMaterial>*)d_U, (const uint8_t*)d_active_tiles);
        CHECK_CUDA(cudaGetLastError());
        apply_bc_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((PrimitiveTile3D<IsMultiMaterial>*)d_states, nx, ny, nz);
        CHECK_CUDA(cudaGetLastError());

        // Stage 2
        compute_flux_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((const PrimitiveTile3D<IsMultiMaterial>*)d_states, (ConservativeTile3D<IsMultiMaterial>*)d_U, (const uint8_t*)d_active_tiles, dt);
        CHECK_CUDA(cudaGetLastError());
        average_U_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((ConservativeTile3D<IsMultiMaterial>*)d_U, (const ConservativeTile3D<IsMultiMaterial>*)d_U_prev, (const uint8_t*)d_active_tiles, 0.75, 0.25);
        CHECK_CUDA(cudaGetLastError());
        update_primitive_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((PrimitiveTile3D<IsMultiMaterial>*)d_states, (ConservativeTile3D<IsMultiMaterial>*)d_U, (const uint8_t*)d_active_tiles);
        CHECK_CUDA(cudaGetLastError());
        apply_bc_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((PrimitiveTile3D<IsMultiMaterial>*)d_states, nx, ny, nz);
        CHECK_CUDA(cudaGetLastError());
        
        // Stage 3
        compute_flux_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((const PrimitiveTile3D<IsMultiMaterial>*)d_states, (ConservativeTile3D<IsMultiMaterial>*)d_U, (const uint8_t*)d_active_tiles, dt);
        CHECK_CUDA(cudaGetLastError());
        average_U_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((ConservativeTile3D<IsMultiMaterial>*)d_U, (const ConservativeTile3D<IsMultiMaterial>*)d_U_prev, (const uint8_t*)d_active_tiles, 1.0/3.0, 2.0/3.0);
        CHECK_CUDA(cudaGetLastError());
        update_primitive_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((PrimitiveTile3D<IsMultiMaterial>*)d_states, (ConservativeTile3D<IsMultiMaterial>*)d_U, (const uint8_t*)d_active_tiles);
        CHECK_CUDA(cudaGetLastError());
        apply_bc_kernel_3d<IsMultiMaterial><<<blocks, threads>>>((PrimitiveTile3D<IsMultiMaterial>*)d_states, nx, ny, nz);
        CHECK_CUDA(cudaGetLastError());
    }
    
    CHECK_CUDA(cudaDeviceSynchronize());
    currentTime += dt;
    updateActiveRegions();
}

template <bool IsMultiMaterial>
void CFDSolver3DCuda<IsMultiMaterial>::setFluxScheme(const std::string& name) {
    currentFluxScheme = name;
    bool useAUSM = (name == "AUSM+");
    CHECK_CUDA(cudaMemcpyToSymbol(d_useAUSM, &useAUSM, sizeof(bool)));
}

template <bool IsMultiMaterial>
__global__ void __launch_bounds__(512) compute_max_speed_kernel_3d(const PrimitiveTile3D<IsMultiMaterial>* states, const uint8_t* active_tiles, double gamma, double* max_s_block) {
    int tx = blockIdx.x;
    int ty = blockIdx.y;
    int tz = blockIdx.z;
    int t_idx = tx + ty * d_ntx + tz * d_ntx * d_nty;

    extern __shared__ double sdata[];
    int tid = threadIdx.x + threadIdx.y * blockDim.x + threadIdx.z * blockDim.x * blockDim.y;

    double max_s = 1e-6;
    if (active_tiles[t_idx]) {
        int lx = threadIdx.x;
        int ly = threadIdx.y;
        int lz = threadIdx.z;
        int c_idx = lx + ly * TILE_SIZE_3D + lz * TILE_SIZE_3D * TILE_SIZE_3D;

        double rho = states[t_idx].rho[c_idx];
        double ux = states[t_idx].ux[c_idx];
        double uy = states[t_idx].uy[c_idx];
        double uz = states[t_idx].uz[c_idx];
        double p = states[t_idx].p[c_idx];

        double u_mag = sqrt(ux*ux + uy*uy + uz*uz);
        double c = sqrt(gamma * p / max(1e-6, rho));
        max_s = u_mag + c;
    }

    sdata[tid] = max_s;
    __syncthreads();

    for (unsigned int s = blockDim.x * blockDim.y * blockDim.z / 2; s > 0; s >>= 1) {
        if (tid < s) {
            sdata[tid] = fmax(sdata[tid], sdata[tid + s]);
        }
        __syncthreads();
    }

    if (tid == 0) max_s_block[t_idx] = sdata[tid];
}

template <bool IsMultiMaterial>
double CFDSolver3DCuda<IsMultiMaterial>::computeStepSize(double cfl) const {
    int total_tiles = ((nx+7)/8)*((ny+7)/8)*((nz+7)/8);

    dim3 blocks((nx+7)/8, (ny+7)/8, (nz+7)/8);
    dim3 threads(8, 8, 8);
    compute_max_speed_kernel_3d<IsMultiMaterial><<<blocks, threads, 512 * sizeof(double)>>>((const PrimitiveTile3D<IsMultiMaterial>*)d_states, (const uint8_t*)d_active_tiles, gamma, (double*)d_max_s_buf);

    std::vector<double> h_max_s(total_tiles);
    cudaMemcpy(h_max_s.data(), d_max_s_buf, total_tiles * sizeof(double), cudaMemcpyDeviceToHost);

    double max_s = 1e-6;
    for (double s : h_max_s) max_s = std::max(max_s, s);

    return cfl * cellSize / max_s;
}

template <bool IsMultiMaterial>
std::vector<float> CFDSolver3DCuda<IsMultiMaterial>::sampleGauge(const Gauge3D& gauge) const {
    int gx = std::clamp((int)((gauge.x - xmin) / cellSize), 0, nx - 1);
    int gy = std::clamp((int)((gauge.y - ymin) / cellSize), 0, ny - 1);
    int gz = std::clamp((int)((gauge.z - zmin) / cellSize), 0, nz - 1);

    int tx = gx / TILE_SIZE_3D, ty = gy / TILE_SIZE_3D, tz = gz / TILE_SIZE_3D;
    int t_idx = tx + ty * ((nx+7)/8) + tz * ((nx+7)/8) * ((ny+7)/8);
    int lx = gx % TILE_SIZE_3D, ly = gy % TILE_SIZE_3D, lz = gz % TILE_SIZE_3D;
    int c_idx = lx + ly * 8 + lz * 64;

    PrimitiveTile3D<IsMultiMaterial> h_tile;
    CHECK_CUDA(cudaMemcpy(&h_tile, (PrimitiveTile3D<IsMultiMaterial>*)d_states + t_idx, sizeof(PrimitiveTile3D<IsMultiMaterial>), cudaMemcpyDeviceToHost));

    std::vector<float> vals(7, 0.0f);
    vals[0] = h_tile.p[c_idx]; vals[1] = h_tile.rho[c_idx];
    vals[2] = sqrt(h_tile.ux[c_idx]*h_tile.ux[c_idx] + h_tile.uy[c_idx]*h_tile.uy[c_idx] + h_tile.uz[c_idx]*h_tile.uz[c_idx]);
    vals[3] = h_tile.E[c_idx] / max(1e-6, h_tile.rho[c_idx]);
    vals[6] = 1.0f;
    return vals;
}

template <bool IsMultiMaterial>
std::vector<float> CFDSolver3DCuda<IsMultiMaterial>::extractSlice(const Slice3D& slice) const {
    std::vector<float> h_data;
    int axis = (slice.axis == "xy" ? 0 : (slice.axis == "xz" ? 1 : 2));
    int stride = slice.stride > 0 ? slice.stride : 1;
    int w = 0, h = 0;
    if (axis == 0) { w = (nx + stride - 1) / stride; h = (ny + stride - 1) / stride; }
    else if (axis == 1) { w = (nx + stride - 1) / stride; h = (nz + stride - 1) / stride; }
    else { w = (ny + stride - 1) / stride; h = (nz + stride - 1) / stride; }

    h_data.resize(w * h, 0.0f);
    dim3 blocks((w+15)/16, (h+15)/16);
    dim3 threads(16, 16);

    std::string qty = (slice.quantities.empty()) ? "pressure" : slice.quantities[0];
    int qty_id = 0;
    if (qty == "density" || qty == "rho") qty_id = 1;
    else if (qty == "velocity" || qty == "speed") qty_id = 2;
    else if (qty == "energy" || qty == "internal_energy") qty_id = 3;
    else if (qty == "species1" || qty == "alpha1") qty_id = 4;
    else if (qty == "species2" || qty == "alpha2") qty_id = 5;
    else if (qty == "species3") qty_id = 6;

    extract_slice_kernel<IsMultiMaterial><<<blocks, threads>>>((const PrimitiveTile3D<IsMultiMaterial>*)d_states, (float*)d_slice_buf, nx, ny, nz, axis, slice.offset, xmin, ymin, zmin, cellSize, qty_id, stride);
    CHECK_CUDA(cudaDeviceSynchronize());
    CHECK_CUDA(cudaMemcpy(h_data.data(), d_slice_buf, w * h * sizeof(float), cudaMemcpyDeviceToHost));

    return h_data;
}

template <bool IsMultiMaterial>
void CFDSolver3DCuda<IsMultiMaterial>::updateActiveRegions() {
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    std::vector<uint8_t> host_active(total_tiles);
    CHECK_CUDA(cudaMemcpy(host_active.data(), d_active_tiles, total_tiles * sizeof(uint8_t), cudaMemcpyDeviceToHost));

    std::vector<uint8_t> next_active = host_active;
    for (int tz = 0; tz < ntz; ++tz) {
        for (int ty = 0; ty < nty; ++ty) {
            for (int tx = 0; tx < ntx; ++tx) {
                int idx = tx + ty * ntx + tz * ntx * nty;
                if (host_active[idx]) {
                    if (tx > 0) next_active[idx - 1] = 1;
                    if (tx < ntx - 1) next_active[idx + 1] = 1;
                    if (ty > 0) next_active[idx - ntx] = 1;
                    if (ty < nty - 1) next_active[idx + ntx] = 1;
                    if (tz > 0) next_active[idx - ntx * nty] = 1;
                    if (tz < ntz - 1) next_active[idx + ntx * nty] = 1;
                }
            }
        }
    }

    CHECK_CUDA(cudaMemcpy(d_active_tiles, next_active.data(), total_tiles * sizeof(uint8_t), cudaMemcpyHostToDevice));
}

template <bool IsMultiMaterial>
void CFDSolver3DCuda<IsMultiMaterial>::initializeFrom1D(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d, double x_expl, double y_expl, double z_expl, double R_remap) {
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    std::vector<PrimitiveTile3D<IsMultiMaterial>> h_states(total_tiles);
    std::vector<uint8_t> h_active_tiles(total_tiles, 0);

    CHECK_CUDA(cudaMemcpy(h_states.data(), d_states, total_tiles * sizeof(PrimitiveTile3D<IsMultiMaterial>), cudaMemcpyDeviceToHost));
    CHECK_CUDA(cudaMemcpy(h_active_tiles.data(), d_active_tiles, total_tiles * sizeof(uint8_t), cudaMemcpyDeviceToHost));

    temp_h_states = h_states.data();
    temp_h_active = h_active_tiles.data();

    remap_1d_to_3d(r_1d, states_1d, *this, x_expl, y_expl, z_expl, R_remap);

    temp_h_states = nullptr;
    temp_h_active = nullptr;
}

template <bool IsMultiMaterial>
void CFDSolver3DCuda<IsMultiMaterial>::setCellStateMulti(int i, int j, int k, const CellState3D<true>& s) {
    int ntx = (nx + 7) / 8;
    int nty = (ny + 7) / 8;
    int tx = i / TILE_SIZE_3D, ty = j / TILE_SIZE_3D, tz = k / TILE_SIZE_3D;
    int t_idx = tx + ty * ntx + tz * ntx * nty;
    int lx = i % TILE_SIZE_3D, ly = j % TILE_SIZE_3D, lz = k % TILE_SIZE_3D;
    int c_idx = lx + ly * 8 + lz * 64;

    if (temp_h_states) {
        temp_h_states[t_idx].rho[c_idx] = s.rho;
        temp_h_states[t_idx].ux[c_idx] = s.ux;
        temp_h_states[t_idx].uy[c_idx] = s.uy;
        temp_h_states[t_idx].uz[c_idx] = s.uz;
        temp_h_states[t_idx].p[c_idx] = s.p;
        temp_h_states[t_idx].E[c_idx] = s.E;
        if constexpr (IsMultiMaterial) {
            temp_h_states[t_idx].alpha1[c_idx] = s.alpha1;
            temp_h_states[t_idx].alpha2[c_idx] = s.alpha2;
            temp_h_states[t_idx].arho1[c_idx] = s.arho1;
            temp_h_states[t_idx].arho2[c_idx] = s.arho2;
        }
        temp_h_active[t_idx] = 1;
    } else {
        PrimitiveTile3D<IsMultiMaterial> h_tile;
        CHECK_CUDA(cudaMemcpy(&h_tile, (PrimitiveTile3D<IsMultiMaterial>*)d_states + t_idx, sizeof(PrimitiveTile3D<IsMultiMaterial>), cudaMemcpyDeviceToHost));
        h_tile.rho[c_idx] = s.rho; h_tile.ux[c_idx] = s.ux; h_tile.uy[c_idx] = s.uy; h_tile.uz[c_idx] = s.uz;
        h_tile.p[c_idx] = s.p; h_tile.E[c_idx] = s.E;
        if constexpr (IsMultiMaterial) {
            h_tile.alpha1[c_idx] = s.alpha1;
            h_tile.alpha2[c_idx] = s.alpha2;
            h_tile.arho1[c_idx] = s.arho1;
            h_tile.arho2[c_idx] = s.arho2;
        }
        CHECK_CUDA(cudaMemcpy((PrimitiveTile3D<IsMultiMaterial>*)d_states + t_idx, &h_tile, sizeof(PrimitiveTile3D<IsMultiMaterial>), cudaMemcpyHostToDevice));

        uint8_t active = 1;
        CHECK_CUDA(cudaMemcpy((uint8_t*)d_active_tiles + t_idx, &active, 1, cudaMemcpyHostToDevice));
    }
}

template <bool IsMultiMaterial>
void CFDSolver3DCuda<IsMultiMaterial>::setCellStateIdeal(int i, int j, int k, const CellState3D<false>& s) {
    int tx = i / TILE_SIZE_3D;
    int ty = j / TILE_SIZE_3D;
    int tz = k / TILE_SIZE_3D;
    int ntx = (nx + 7) / 8;
    int nty = (ny + 7) / 8;
    int t_idx = tx + ty * ntx + tz * ntx * nty;
    int lx = i % TILE_SIZE_3D, ly = j % TILE_SIZE_3D, lz = k % TILE_SIZE_3D;
    int c_idx = lx + ly * 8 + lz * 64;

    if (temp_h_states) {
        temp_h_states[t_idx].rho[c_idx] = s.rho;
        temp_h_states[t_idx].ux[c_idx] = s.ux;
        temp_h_states[t_idx].uy[c_idx] = s.uy;
        temp_h_states[t_idx].uz[c_idx] = s.uz;
        temp_h_states[t_idx].p[c_idx] = s.p;
        temp_h_states[t_idx].E[c_idx] = s.E;
        if (!temp_h_active[t_idx]) {
            temp_h_active[t_idx] = 1;
            std::cout << "[CUDA TILE ACTIVE] " << t_idx << " (tx=" << tx << ", ty=" << ty << ", tz=" << tz << ")\n";
        }
    } else {
        PrimitiveTile3D<IsMultiMaterial> h_tile;
        CHECK_CUDA(cudaMemcpy(&h_tile, (PrimitiveTile3D<IsMultiMaterial>*)d_states + t_idx, sizeof(PrimitiveTile3D<IsMultiMaterial>), cudaMemcpyDeviceToHost));
        h_tile.rho[c_idx] = s.rho; h_tile.ux[c_idx] = s.ux; h_tile.uy[c_idx] = s.uy; h_tile.uz[c_idx] = s.uz;
        h_tile.p[c_idx] = s.p; h_tile.E[c_idx] = s.E;
        CHECK_CUDA(cudaMemcpy((PrimitiveTile3D<IsMultiMaterial>*)d_states + t_idx, &h_tile, sizeof(PrimitiveTile3D<IsMultiMaterial>), cudaMemcpyHostToDevice));

        uint8_t active = 1;
        CHECK_CUDA(cudaMemcpy((uint8_t*)d_active_tiles + t_idx, &active, 1, cudaMemcpyHostToDevice));
    }
}

template <bool IsMultiMaterial>
void CFDSolver3DCuda<IsMultiMaterial>::commitStates() {
    int ntx = (nx + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int nty = (ny + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int ntz = (nz + TILE_SIZE_3D - 1) / TILE_SIZE_3D;
    int total_tiles = ntx * nty * ntz;

    if (temp_h_states && temp_h_active) {
        CHECK_CUDA(cudaMemcpy(d_states, temp_h_states, total_tiles * sizeof(PrimitiveTile3D<IsMultiMaterial>), cudaMemcpyHostToDevice));
        CHECK_CUDA(cudaMemcpy(d_active_tiles, temp_h_active, total_tiles * sizeof(uint8_t), cudaMemcpyHostToDevice));
    }

    updateActiveRegions();

    commit_states_kernel<<<total_tiles, 512>>>((PrimitiveTile3D<IsMultiMaterial>*)d_states, (ConservativeTile3D<IsMultiMaterial>*)d_U, (const uint8_t*)d_active_tiles, total_tiles);
    CHECK_CUDA(cudaDeviceSynchronize());
}

template <bool IsMultiMaterial>
void CFDSolver3DCuda<IsMultiMaterial>::setSpatialOrder(int order) { 
    spatialOrder = order; 
    CHECK_CUDA(cudaMemcpyToSymbol(d_spatialOrder, &order, sizeof(int)));
}
template <bool IsMultiMaterial>
void CFDSolver3DCuda<IsMultiMaterial>::setTemporalOrder(int order) { temporalOrder = order; }

template <bool IsMultiMaterial>
void CFDSolver3DCuda<IsMultiMaterial>::setBoundaryConditions(BCType3D xmin, BCType3D xmax, BCType3D ymin, BCType3D ymax, BCType3D zmin, BCType3D zmax) {
    CFDSolver3DImplBase::setBoundaryConditions(xmin, xmax, ymin, ymax, zmin, zmax);
    updateBoundaryConditions();
}



template class CFDSolver3DCuda<true>;
template class CFDSolver3DCuda<false>;
