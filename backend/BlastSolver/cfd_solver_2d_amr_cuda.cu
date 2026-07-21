#include "cfd_solver_2d_amr_cuda.hpp"
#include "VTKWriter.hpp"
#include <iostream>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <stdint.h>
#include <cuda_runtime.h>
#include <device_launch_parameters.h>

// CUDA Error checking helper
#define checkCudaError(ans) { gpuAssert((ans), __FILE__, __LINE__); }
inline void gpuAssert(cudaError_t code, const char *file, int line, bool abort = true) {
    if (code != cudaSuccess) {
        std::cerr << "GPUassert: " << cudaGetErrorString(code) << " " << file << " " << line << std::endl;
        if (abort) exit(code);
    }
}

// --------------------------------------------------------------------------------------
// CUDA Kernels for AMR Solver
// --------------------------------------------------------------------------------------

template <typename RealType>
__device__ inline RealType minmod_gpu(RealType a, RealType b) {
    if (a * b <= (RealType)0.0) return (RealType)0.0;
    RealType abs_a = (a < (RealType)0.0) ? -a : a;
    RealType abs_b = (b < (RealType)0.0) ? -b : b;
    return (abs_a < abs_b) ? a : b;
}

template <typename RealType>
__device__ inline RealType van_leer_gpu(RealType a, RealType b) {
    if (a * b <= (RealType)0.0) return (RealType)0.0;
    return (RealType)2.0 * a * b / (a + b);
}

__device__ inline int findNodeByCoordsGPU(
    const GPUNode2D* nodes, int total_nodes,
    int level0_tiles_r, int level0_tiles_z,
    int r_idx, int z_idx, int level) {

    if (r_idx < 0 || r_idx >= (level0_tiles_r << level) ||
        z_idx < 0 || z_idx >= (level0_tiles_z << level)) {
        return -1;
    }
    int r0 = r_idx >> level;
    int z0 = z_idx >> level;
    int curr = r0 * level0_tiles_z + z0;
    if (curr < 0 || curr >= total_nodes) return -1;

    for (int l = 0; l < level; ++l) {
        if (nodes[curr].children[0] == -1) {
            return curr;
        }
        int shift = level - 1 - l;
        int bit_r = (r_idx >> shift) & 1;
        int bit_z = (z_idx >> shift) & 1;
        int quadrant = bit_r + 2 * bit_z;
        curr = nodes[curr].children[quadrant];
        if (curr == -1) return -1;
    }
    return curr;
}

template <typename RealType>
__global__ void fillGhostCells_AMR_kernel(
    GPUNode2D* nodes,
    int total_nodes,
    int level0_tiles_r,
    int level0_tiles_z,
    int* active_node_ids,
    int active_leaves_count,
    AMRPrimitiveTileT<RealType>* states_pool,
    CFDSolver2DCuda::BCType bc_r_min,
    CFDSolver2DCuda::BCType bc_r_max,
    CFDSolver2DCuda::BCType bc_z_min,
    CFDSolver2DCuda::BCType bc_z_max,
    RealType ambient_rho,
    RealType ambient_p,
    RealType gamma,
    MultiMat::MaterialSet mat,
    bool is_ideal_gas,
    double dr_base,
    double dz_base) {

    int tile_idx = blockIdx.x;
    if (tile_idx >= active_leaves_count) return;

    int node_idx = active_node_ids[tile_idx];
    auto node = nodes[node_idx];
    int pool_idx = node.tile_id;
    auto& T = states_pool[pool_idx];

    int tid = threadIdx.x; // 0..63
    int boundary_id = tid / 16; // 0: Left, 1: Right, 2: Bottom, 3: Top
    int cell_idx = tid % 16;

    int nb_idx = node.neighbors[boundary_id];

    if (nb_idx != -1) {
        auto nb_node = nodes[nb_idx];
        auto& Nb = states_pool[nb_node.tile_id];

        if (nb_node.level == node.level) {
            // Same level copy
            if (boundary_id == 0) { // Left
                int tj = cell_idx + 2;
                T.rho[0 * AMR_TILE_DIM + tj] = Nb.rho[16 * AMR_TILE_DIM + tj];
                T.rho[1 * AMR_TILE_DIM + tj] = Nb.rho[17 * AMR_TILE_DIM + tj];
                T.ur[0 * AMR_TILE_DIM + tj] = Nb.ur[16 * AMR_TILE_DIM + tj];
                T.ur[1 * AMR_TILE_DIM + tj] = Nb.ur[17 * AMR_TILE_DIM + tj];
                T.uz[0 * AMR_TILE_DIM + tj] = Nb.uz[16 * AMR_TILE_DIM + tj];
                T.uz[1 * AMR_TILE_DIM + tj] = Nb.uz[17 * AMR_TILE_DIM + tj];
                T.p[0 * AMR_TILE_DIM + tj] = Nb.p[16 * AMR_TILE_DIM + tj];
                T.p[1 * AMR_TILE_DIM + tj] = Nb.p[17 * AMR_TILE_DIM + tj];
                T.E[0 * AMR_TILE_DIM + tj] = Nb.E[16 * AMR_TILE_DIM + tj];
                T.E[1 * AMR_TILE_DIM + tj] = Nb.E[17 * AMR_TILE_DIM + tj];
                T.alpha1[0 * AMR_TILE_DIM + tj] = Nb.alpha1[16 * AMR_TILE_DIM + tj];
                T.alpha1[1 * AMR_TILE_DIM + tj] = Nb.alpha1[17 * AMR_TILE_DIM + tj];
                T.alpha2[0 * AMR_TILE_DIM + tj] = Nb.alpha2[16 * AMR_TILE_DIM + tj];
                T.alpha2[1 * AMR_TILE_DIM + tj] = Nb.alpha2[17 * AMR_TILE_DIM + tj];
                T.arho1[0 * AMR_TILE_DIM + tj] = Nb.arho1[16 * AMR_TILE_DIM + tj];
                T.arho1[1 * AMR_TILE_DIM + tj] = Nb.arho1[17 * AMR_TILE_DIM + tj];
                T.arho2[0 * AMR_TILE_DIM + tj] = Nb.arho2[16 * AMR_TILE_DIM + tj];
                T.arho2[1 * AMR_TILE_DIM + tj] = Nb.arho2[17 * AMR_TILE_DIM + tj];
            } else if (boundary_id == 1) { // Right
                int tj = cell_idx + 2;
                T.rho[18 * AMR_TILE_DIM + tj] = Nb.rho[2 * AMR_TILE_DIM + tj];
                T.rho[19 * AMR_TILE_DIM + tj] = Nb.rho[3 * AMR_TILE_DIM + tj];
                T.ur[18 * AMR_TILE_DIM + tj] = Nb.ur[2 * AMR_TILE_DIM + tj];
                T.ur[19 * AMR_TILE_DIM + tj] = Nb.ur[3 * AMR_TILE_DIM + tj];
                T.uz[18 * AMR_TILE_DIM + tj] = Nb.uz[2 * AMR_TILE_DIM + tj];
                T.uz[19 * AMR_TILE_DIM + tj] = Nb.uz[3 * AMR_TILE_DIM + tj];
                T.p[18 * AMR_TILE_DIM + tj] = Nb.p[2 * AMR_TILE_DIM + tj];
                T.p[19 * AMR_TILE_DIM + tj] = Nb.p[3 * AMR_TILE_DIM + tj];
                T.E[18 * AMR_TILE_DIM + tj] = Nb.E[2 * AMR_TILE_DIM + tj];
                T.E[19 * AMR_TILE_DIM + tj] = Nb.E[3 * AMR_TILE_DIM + tj];
                T.alpha1[18 * AMR_TILE_DIM + tj] = Nb.alpha1[2 * AMR_TILE_DIM + tj];
                T.alpha1[19 * AMR_TILE_DIM + tj] = Nb.alpha1[3 * AMR_TILE_DIM + tj];
                T.alpha2[18 * AMR_TILE_DIM + tj] = Nb.alpha2[2 * AMR_TILE_DIM + tj];
                T.alpha2[19 * AMR_TILE_DIM + tj] = Nb.alpha2[3 * AMR_TILE_DIM + tj];
                T.arho1[18 * AMR_TILE_DIM + tj] = Nb.arho1[2 * AMR_TILE_DIM + tj];
                T.arho1[19 * AMR_TILE_DIM + tj] = Nb.arho1[3 * AMR_TILE_DIM + tj];
                T.arho2[18 * AMR_TILE_DIM + tj] = Nb.arho2[2 * AMR_TILE_DIM + tj];
                T.arho2[19 * AMR_TILE_DIM + tj] = Nb.arho2[3 * AMR_TILE_DIM + tj];
            } else if (boundary_id == 2) { // Bottom
                int ti = cell_idx + 2;
                T.rho[ti * AMR_TILE_DIM + 0] = Nb.rho[ti * AMR_TILE_DIM + 16];
                T.rho[ti * AMR_TILE_DIM + 1] = Nb.rho[ti * AMR_TILE_DIM + 17];
                T.ur[ti * AMR_TILE_DIM + 0] = Nb.ur[ti * AMR_TILE_DIM + 16];
                T.ur[ti * AMR_TILE_DIM + 1] = Nb.ur[ti * AMR_TILE_DIM + 17];
                T.uz[ti * AMR_TILE_DIM + 0] = Nb.uz[ti * AMR_TILE_DIM + 16];
                T.uz[ti * AMR_TILE_DIM + 1] = Nb.uz[ti * AMR_TILE_DIM + 17];
                T.p[ti * AMR_TILE_DIM + 0] = Nb.p[ti * AMR_TILE_DIM + 16];
                T.p[ti * AMR_TILE_DIM + 1] = Nb.p[ti * AMR_TILE_DIM + 17];
                T.E[ti * AMR_TILE_DIM + 0] = Nb.E[ti * AMR_TILE_DIM + 16];
                T.E[ti * AMR_TILE_DIM + 1] = Nb.E[ti * AMR_TILE_DIM + 17];
                T.alpha1[ti * AMR_TILE_DIM + 0] = Nb.alpha1[ti * AMR_TILE_DIM + 16];
                T.alpha1[ti * AMR_TILE_DIM + 1] = Nb.alpha1[ti * AMR_TILE_DIM + 17];
                T.alpha2[ti * AMR_TILE_DIM + 0] = Nb.alpha2[ti * AMR_TILE_DIM + 16];
                T.alpha2[ti * AMR_TILE_DIM + 1] = Nb.alpha2[ti * AMR_TILE_DIM + 17];
                T.arho1[ti * AMR_TILE_DIM + 0] = Nb.arho1[ti * AMR_TILE_DIM + 16];
                T.arho1[ti * AMR_TILE_DIM + 1] = Nb.arho1[ti * AMR_TILE_DIM + 17];
                T.arho2[ti * AMR_TILE_DIM + 0] = Nb.arho2[ti * AMR_TILE_DIM + 16];
                T.arho2[ti * AMR_TILE_DIM + 1] = Nb.arho2[ti * AMR_TILE_DIM + 17];
            } else if (boundary_id == 3) { // Top
                int ti = cell_idx + 2;
                T.rho[ti * AMR_TILE_DIM + 18] = Nb.rho[ti * AMR_TILE_DIM + 2];
                T.rho[ti * AMR_TILE_DIM + 19] = Nb.rho[ti * AMR_TILE_DIM + 3];
                T.ur[ti * AMR_TILE_DIM + 18] = Nb.ur[ti * AMR_TILE_DIM + 2];
                T.ur[ti * AMR_TILE_DIM + 19] = Nb.ur[ti * AMR_TILE_DIM + 3];
                T.uz[ti * AMR_TILE_DIM + 18] = Nb.uz[ti * AMR_TILE_DIM + 2];
                T.uz[ti * AMR_TILE_DIM + 19] = Nb.uz[ti * AMR_TILE_DIM + 3];
                T.p[ti * AMR_TILE_DIM + 18] = Nb.p[ti * AMR_TILE_DIM + 2];
                T.p[ti * AMR_TILE_DIM + 19] = Nb.p[ti * AMR_TILE_DIM + 3];
                T.E[ti * AMR_TILE_DIM + 18] = Nb.E[ti * AMR_TILE_DIM + 2];
                T.E[ti * AMR_TILE_DIM + 19] = Nb.E[ti * AMR_TILE_DIM + 3];
                T.alpha1[ti * AMR_TILE_DIM + 18] = Nb.alpha1[ti * AMR_TILE_DIM + 2];
                T.alpha1[ti * AMR_TILE_DIM + 19] = Nb.alpha1[ti * AMR_TILE_DIM + 3];
                T.alpha2[ti * AMR_TILE_DIM + 18] = Nb.alpha2[ti * AMR_TILE_DIM + 2];
                T.alpha2[ti * AMR_TILE_DIM + 19] = Nb.alpha2[ti * AMR_TILE_DIM + 3];
                T.arho1[ti * AMR_TILE_DIM + 18] = Nb.arho1[ti * AMR_TILE_DIM + 2];
                T.arho1[ti * AMR_TILE_DIM + 19] = Nb.arho1[ti * AMR_TILE_DIM + 3];
                T.arho2[ti * AMR_TILE_DIM + 18] = Nb.arho2[ti * AMR_TILE_DIM + 2];
                T.arho2[ti * AMR_TILE_DIM + 19] = Nb.arho2[ti * AMR_TILE_DIM + 3];
            }
        } else if (nb_node.level == node.level + 1) {
            // Fine neighbor restriction averaging for CUDA
            int r_sub = node.r_idx % 2;
            int z_sub = node.z_idx % 2;

            if (boundary_id == 0) { // Left
                int tj = cell_idx + 2;
                int fj1 = z_sub * 8 * 2 + cell_idx * 2 + 2;
                int fj2 = fj1 + 1;
                fj1 = max(2, min(17, fj1));
                fj2 = max(2, min(17, fj2));
                int k1 = 16 * AMR_TILE_DIM + fj1;
                int k2 = 16 * AMR_TILE_DIM + fj2;
                int k3 = 17 * AMR_TILE_DIM + fj1;
                int k4 = 17 * AMR_TILE_DIM + fj2;
                RealType avg_rho  = (RealType)(0.25 * ((double)Nb.rho[k1]   + (double)Nb.rho[k2]   + (double)Nb.rho[k3]   + (double)Nb.rho[k4]));
                RealType avg_ur   = (RealType)(0.25 * ((double)Nb.ur[k1]    + (double)Nb.ur[k2]    + (double)Nb.ur[k3]    + (double)Nb.ur[k4]));
                RealType avg_uz   = (RealType)(0.25 * ((double)Nb.uz[k1]    + (double)Nb.uz[k2]    + (double)Nb.uz[k3]    + (double)Nb.uz[k4]));
                RealType avg_p    = (RealType)(0.25 * ((double)Nb.p[k1]     + (double)Nb.p[k2]     + (double)Nb.p[k3]     + (double)Nb.p[k4]));
                RealType avg_E    = (RealType)(0.25 * ((double)Nb.E[k1]     + (double)Nb.E[k2]     + (double)Nb.E[k3]     + (double)Nb.E[k4]));
                RealType avg_a1   = (RealType)(0.25 * ((double)Nb.alpha1[k1] + (double)Nb.alpha1[k2] + (double)Nb.alpha1[k3] + (double)Nb.alpha1[k4]));
                RealType avg_a2   = (RealType)(0.25 * ((double)Nb.alpha2[k1] + (double)Nb.alpha2[k2] + (double)Nb.alpha2[k3] + (double)Nb.alpha2[k4]));
                RealType avg_ar1  = (RealType)(0.25 * ((double)Nb.arho1[k1]  + (double)Nb.arho1[k2]  + (double)Nb.arho1[k3]  + (double)Nb.arho1[k4]));
                RealType avg_ar2  = (RealType)(0.25 * ((double)Nb.arho2[k1]  + (double)Nb.arho2[k2]  + (double)Nb.arho2[k3]  + (double)Nb.arho2[k4]));
                T.rho[0*AMR_TILE_DIM+tj]  = avg_rho;  T.rho[1*AMR_TILE_DIM+tj]  = avg_rho;
                T.ur[0*AMR_TILE_DIM+tj]   = avg_ur;   T.ur[1*AMR_TILE_DIM+tj]   = avg_ur;
                T.uz[0*AMR_TILE_DIM+tj]   = avg_uz;   T.uz[1*AMR_TILE_DIM+tj]   = avg_uz;
                T.p[0*AMR_TILE_DIM+tj]    = avg_p;    T.p[1*AMR_TILE_DIM+tj]    = avg_p;
                T.E[0*AMR_TILE_DIM+tj]    = avg_E;    T.E[1*AMR_TILE_DIM+tj]    = avg_E;
                T.alpha1[0*AMR_TILE_DIM+tj] = avg_a1; T.alpha1[1*AMR_TILE_DIM+tj] = avg_a1;
                T.alpha2[0*AMR_TILE_DIM+tj] = avg_a2; T.alpha2[1*AMR_TILE_DIM+tj] = avg_a2;
                T.arho1[0*AMR_TILE_DIM+tj]  = avg_ar1; T.arho1[1*AMR_TILE_DIM+tj]  = avg_ar1;
                T.arho2[0*AMR_TILE_DIM+tj]  = avg_ar2; T.arho2[1*AMR_TILE_DIM+tj]  = avg_ar2;
            } else if (boundary_id == 1) { // Right
                int tj = cell_idx + 2;
                int fj1 = z_sub * 8 * 2 + cell_idx * 2 + 2;
                int fj2 = fj1 + 1;
                fj1 = max(2, min(17, fj1));
                fj2 = max(2, min(17, fj2));
                int k1 = 2 * AMR_TILE_DIM + fj1;
                int k2 = 2 * AMR_TILE_DIM + fj2;
                int k3 = 3 * AMR_TILE_DIM + fj1;
                int k4 = 3 * AMR_TILE_DIM + fj2;
                RealType avg_rho  = (RealType)(0.25 * ((double)Nb.rho[k1]   + (double)Nb.rho[k2]   + (double)Nb.rho[k3]   + (double)Nb.rho[k4]));
                RealType avg_ur   = (RealType)(0.25 * ((double)Nb.ur[k1]    + (double)Nb.ur[k2]    + (double)Nb.ur[k3]    + (double)Nb.ur[k4]));
                RealType avg_uz   = (RealType)(0.25 * ((double)Nb.uz[k1]    + (double)Nb.uz[k2]    + (double)Nb.uz[k3]    + (double)Nb.uz[k4]));
                RealType avg_p    = (RealType)(0.25 * ((double)Nb.p[k1]     + (double)Nb.p[k2]     + (double)Nb.p[k3]     + (double)Nb.p[k4]));
                RealType avg_E    = (RealType)(0.25 * ((double)Nb.E[k1]     + (double)Nb.E[k2]     + (double)Nb.E[k3]     + (double)Nb.E[k4]));
                RealType avg_a1   = (RealType)(0.25 * ((double)Nb.alpha1[k1] + (double)Nb.alpha1[k2] + (double)Nb.alpha1[k3] + (double)Nb.alpha1[k4]));
                RealType avg_a2   = (RealType)(0.25 * ((double)Nb.alpha2[k1] + (double)Nb.alpha2[k2] + (double)Nb.alpha2[k3] + (double)Nb.alpha2[k4]));
                RealType avg_ar1  = (RealType)(0.25 * ((double)Nb.arho1[k1]  + (double)Nb.arho1[k2]  + (double)Nb.arho1[k3]  + (double)Nb.arho1[k4]));
                RealType avg_ar2  = (RealType)(0.25 * ((double)Nb.arho2[k1]  + (double)Nb.arho2[k2]  + (double)Nb.arho2[k3]  + (double)Nb.arho2[k4]));
                T.rho[18*AMR_TILE_DIM+tj]  = avg_rho;  T.rho[19*AMR_TILE_DIM+tj]  = avg_rho;
                T.ur[18*AMR_TILE_DIM+tj]   = avg_ur;   T.ur[19*AMR_TILE_DIM+tj]   = avg_ur;
                T.uz[18*AMR_TILE_DIM+tj]   = avg_uz;   T.uz[19*AMR_TILE_DIM+tj]   = avg_uz;
                T.p[18*AMR_TILE_DIM+tj]    = avg_p;    T.p[19*AMR_TILE_DIM+tj]    = avg_p;
                T.E[18*AMR_TILE_DIM+tj]    = avg_E;    T.E[19*AMR_TILE_DIM+tj]    = avg_E;
                T.alpha1[18*AMR_TILE_DIM+tj] = avg_a1; T.alpha1[19*AMR_TILE_DIM+tj] = avg_a1;
                T.alpha2[18*AMR_TILE_DIM+tj] = avg_a2; T.alpha2[19*AMR_TILE_DIM+tj] = avg_a2;
                T.arho1[18*AMR_TILE_DIM+tj]  = avg_ar1; T.arho1[19*AMR_TILE_DIM+tj]  = avg_ar1;
                T.arho2[18*AMR_TILE_DIM+tj]  = avg_ar2; T.arho2[19*AMR_TILE_DIM+tj]  = avg_ar2;
            } else if (boundary_id == 2) { // Bottom
                int ti = cell_idx + 2;
                int fi1 = r_sub * 8 * 2 + cell_idx * 2 + 2;
                int fi2 = fi1 + 1;
                fi1 = max(2, min(17, fi1));
                fi2 = max(2, min(17, fi2));
                int k1 = fi1 * AMR_TILE_DIM + 16;
                int k2 = fi1 * AMR_TILE_DIM + 17;
                int k3 = fi2 * AMR_TILE_DIM + 16;
                int k4 = fi2 * AMR_TILE_DIM + 17;
                RealType avg_rho  = (RealType)(0.25 * ((double)Nb.rho[k1]   + (double)Nb.rho[k2]   + (double)Nb.rho[k3]   + (double)Nb.rho[k4]));
                RealType avg_ur   = (RealType)(0.25 * ((double)Nb.ur[k1]    + (double)Nb.ur[k2]    + (double)Nb.ur[k3]    + (double)Nb.ur[k4]));
                RealType avg_uz   = (RealType)(0.25 * ((double)Nb.uz[k1]    + (double)Nb.uz[k2]    + (double)Nb.uz[k3]    + (double)Nb.uz[k4]));
                RealType avg_p    = (RealType)(0.25 * ((double)Nb.p[k1]     + (double)Nb.p[k2]     + (double)Nb.p[k3]     + (double)Nb.p[k4]));
                RealType avg_E    = (RealType)(0.25 * ((double)Nb.E[k1]     + (double)Nb.E[k2]     + (double)Nb.E[k3]     + (double)Nb.E[k4]));
                RealType avg_a1   = (RealType)(0.25 * ((double)Nb.alpha1[k1] + (double)Nb.alpha1[k2] + (double)Nb.alpha1[k3] + (double)Nb.alpha1[k4]));
                RealType avg_a2   = (RealType)(0.25 * ((double)Nb.alpha2[k1] + (double)Nb.alpha2[k2] + (double)Nb.alpha2[k3] + (double)Nb.alpha2[k4]));
                RealType avg_ar1  = (RealType)(0.25 * ((double)Nb.arho1[k1]  + (double)Nb.arho1[k2]  + (double)Nb.arho1[k3]  + (double)Nb.arho1[k4]));
                RealType avg_ar2  = (RealType)(0.25 * ((double)Nb.arho2[k1]  + (double)Nb.arho2[k2]  + (double)Nb.arho2[k3]  + (double)Nb.arho2[k4]));
                T.rho[ti*AMR_TILE_DIM+0]  = avg_rho;  T.rho[ti*AMR_TILE_DIM+1]  = avg_rho;
                T.ur[ti*AMR_TILE_DIM+0]   = avg_ur;   T.ur[ti*AMR_TILE_DIM+1]   = avg_ur;
                T.uz[ti*AMR_TILE_DIM+0]   = avg_uz;   T.uz[ti*AMR_TILE_DIM+1]   = avg_uz;
                T.p[ti*AMR_TILE_DIM+0]    = avg_p;    T.p[ti*AMR_TILE_DIM+1]    = avg_p;
                T.E[ti*AMR_TILE_DIM+0]    = avg_E;    T.E[ti*AMR_TILE_DIM+1]    = avg_E;
                T.alpha1[ti*AMR_TILE_DIM+0] = avg_a1; T.alpha1[ti*AMR_TILE_DIM+1] = avg_a1;
                T.alpha2[ti*AMR_TILE_DIM+0] = avg_a2; T.alpha2[ti*AMR_TILE_DIM+1] = avg_a2;
                T.arho1[ti*AMR_TILE_DIM+0]  = avg_ar1; T.arho1[ti*AMR_TILE_DIM+1]  = avg_ar1;
                T.arho2[ti*AMR_TILE_DIM+0]  = avg_ar2; T.arho2[ti*AMR_TILE_DIM+1]  = avg_ar2;
            } else if (boundary_id == 3) { // Top
                int ti = cell_idx + 2;
                int fi1 = r_sub * 8 * 2 + cell_idx * 2 + 2;
                int fi2 = fi1 + 1;
                fi1 = max(2, min(17, fi1));
                fi2 = max(2, min(17, fi2));
                int k1 = fi1 * AMR_TILE_DIM + 2;
                int k2 = fi1 * AMR_TILE_DIM + 3;
                int k3 = fi2 * AMR_TILE_DIM + 2;
                int k4 = fi2 * AMR_TILE_DIM + 3;
                RealType avg_rho  = (RealType)(0.25 * ((double)Nb.rho[k1]   + (double)Nb.rho[k2]   + (double)Nb.rho[k3]   + (double)Nb.rho[k4]));
                RealType avg_ur   = (RealType)(0.25 * ((double)Nb.ur[k1]    + (double)Nb.ur[k2]    + (double)Nb.ur[k3]    + (double)Nb.ur[k4]));
                RealType avg_uz   = (RealType)(0.25 * ((double)Nb.uz[k1]    + (double)Nb.uz[k2]    + (double)Nb.uz[k3]    + (double)Nb.uz[k4]));
                RealType avg_p    = (RealType)(0.25 * ((double)Nb.p[k1]     + (double)Nb.p[k2]     + (double)Nb.p[k3]     + (double)Nb.p[k4]));
                RealType avg_E    = (RealType)(0.25 * ((double)Nb.E[k1]     + (double)Nb.E[k2]     + (double)Nb.E[k3]     + (double)Nb.E[k4]));
                RealType avg_a1   = (RealType)(0.25 * ((double)Nb.alpha1[k1] + (double)Nb.alpha1[k2] + (double)Nb.alpha1[k3] + (double)Nb.alpha1[k4]));
                RealType avg_a2   = (RealType)(0.25 * ((double)Nb.alpha2[k1] + (double)Nb.alpha2[k2] + (double)Nb.alpha2[k3] + (double)Nb.alpha2[k4]));
                RealType avg_ar1  = (RealType)(0.25 * ((double)Nb.arho1[k1]  + (double)Nb.arho1[k2]  + (double)Nb.arho1[k3]  + (double)Nb.arho1[k4]));
                RealType avg_ar2  = (RealType)(0.25 * ((double)Nb.arho2[k1]  + (double)Nb.arho2[k2]  + (double)Nb.arho2[k3]  + (double)Nb.arho2[k4]));
                T.rho[ti*AMR_TILE_DIM+18]  = avg_rho;  T.rho[ti*AMR_TILE_DIM+19]  = avg_rho;
                T.ur[ti*AMR_TILE_DIM+18]   = avg_ur;   T.ur[ti*AMR_TILE_DIM+19]   = avg_ur;
                T.uz[ti*AMR_TILE_DIM+18]   = avg_uz;   T.uz[ti*AMR_TILE_DIM+19]   = avg_uz;
                T.p[ti*AMR_TILE_DIM+18]    = avg_p;    T.p[ti*AMR_TILE_DIM+19]    = avg_p;
                T.E[ti*AMR_TILE_DIM+18]    = avg_E;    T.E[ti*AMR_TILE_DIM+19]    = avg_E;
                T.alpha1[ti*AMR_TILE_DIM+18] = avg_a1; T.alpha1[ti*AMR_TILE_DIM+19] = avg_a1;
                T.alpha2[ti*AMR_TILE_DIM+18] = avg_a2; T.alpha2[ti*AMR_TILE_DIM+19] = avg_a2;
                T.arho1[ti*AMR_TILE_DIM+18]  = avg_ar1; T.arho1[ti*AMR_TILE_DIM+19]  = avg_ar1;
                T.arho2[ti*AMR_TILE_DIM+18]  = avg_ar2; T.arho2[ti*AMR_TILE_DIM+19]  = avg_ar2;
            }
        } else if (nb_node.level == node.level - 1) {
            // Coarser neighbor prolongation
            auto prolongate_gpu = [&](int ic, int jc, double xfrac, double yfrac, auto field) {
                double v = (Nb.*field)[ic * AMR_TILE_DIM + jc];
                double diff_r_right = (ic >= 17) ? ((Nb.*field)[17 * AMR_TILE_DIM + jc] - (Nb.*field)[16 * AMR_TILE_DIM + jc])
                                                 : ((Nb.*field)[(ic+1) * AMR_TILE_DIM + jc] - v);
                double diff_r_left  = (ic <= 2)  ? ((Nb.*field)[3 * AMR_TILE_DIM + jc] - (Nb.*field)[2 * AMR_TILE_DIM + jc])
                                                 : (v - (Nb.*field)[(ic-1) * AMR_TILE_DIM + jc]);
                double vr = van_leer_gpu(diff_r_right, diff_r_left);

                double diff_z_top    = (jc >= 17) ? ((Nb.*field)[ic * AMR_TILE_DIM + 17] - (Nb.*field)[ic * AMR_TILE_DIM + 16])
                                                  : ((Nb.*field)[ic * AMR_TILE_DIM + jc + 1] - v);
                double diff_z_bottom = (jc <= 2)  ? ((Nb.*field)[ic * AMR_TILE_DIM + 3] - (Nb.*field)[ic * AMR_TILE_DIM + 2])
                                                  : (v - (Nb.*field)[ic * AMR_TILE_DIM + jc - 1]);
                double vz = van_leer_gpu(diff_z_top, diff_z_bottom);

                return (RealType)(v + xfrac * vr + yfrac * vz);
            };

            int r_off = node.r_idx % 2;
            int z_off = node.z_idx % 2;

            if (boundary_id == 0) { // Left
                int ic = 17;
                int jc = (cell_idx / 2) + 2 + z_off * 8;
                double yf = (cell_idx % 2 == 0) ? -0.25 : 0.25;
                #define PROLONG(field) \
                    T.field[1 * AMR_TILE_DIM + (cell_idx+2)] = prolongate_gpu(ic, jc, 0.25, yf, &AMRPrimitiveTileT<RealType>::field); \
                    T.field[0 * AMR_TILE_DIM + (cell_idx+2)] = prolongate_gpu(ic, jc, -0.25, yf, &AMRPrimitiveTileT<RealType>::field);
                PROLONG(rho) PROLONG(ur) PROLONG(uz) PROLONG(p) PROLONG(E) PROLONG(alpha1) PROLONG(alpha2) PROLONG(arho1) PROLONG(arho2)
                #undef PROLONG
            } else if (boundary_id == 1) { // Right
                int ic = 2;
                int jc = (cell_idx / 2) + 2 + z_off * 8;
                double yf = (cell_idx % 2 == 0) ? -0.25 : 0.25;
                #define PROLONG(field) \
                    T.field[18 * AMR_TILE_DIM + (cell_idx+2)] = prolongate_gpu(ic, jc, -0.25, yf, &AMRPrimitiveTileT<RealType>::field); \
                    T.field[19 * AMR_TILE_DIM + (cell_idx+2)] = prolongate_gpu(ic, jc, 0.25, yf, &AMRPrimitiveTileT<RealType>::field);
                PROLONG(rho) PROLONG(ur) PROLONG(uz) PROLONG(p) PROLONG(E) PROLONG(alpha1) PROLONG(alpha2) PROLONG(arho1) PROLONG(arho2)
                #undef PROLONG
            } else if (boundary_id == 2) { // Bottom
                int jc = 17;
                int ic = (cell_idx / 2) + 2 + r_off * 8;
                double xf = (cell_idx % 2 == 0) ? -0.25 : 0.25;
                #define PROLONG(field) \
                    T.field[(cell_idx+2) * AMR_TILE_DIM + 1] = prolongate_gpu(ic, jc, xf, 0.25, &AMRPrimitiveTileT<RealType>::field); \
                    T.field[(cell_idx+2) * AMR_TILE_DIM + 0] = prolongate_gpu(ic, jc, xf, -0.25, &AMRPrimitiveTileT<RealType>::field);
                PROLONG(rho) PROLONG(ur) PROLONG(uz) PROLONG(p) PROLONG(E) PROLONG(alpha1) PROLONG(alpha2) PROLONG(arho1) PROLONG(arho2)
                #undef PROLONG
            } else if (boundary_id == 3) { // Top
                int jc = 2;
                int ic = (cell_idx / 2) + 2 + r_off * 8;
                double xf = (cell_idx % 2 == 0) ? -0.25 : 0.25;
                #define PROLONG(field) \
                    T.field[(cell_idx+2) * AMR_TILE_DIM + 18] = prolongate_gpu(ic, jc, xf, -0.25, &AMRPrimitiveTileT<RealType>::field); \
                    T.field[(cell_idx+2) * AMR_TILE_DIM + 19] = prolongate_gpu(ic, jc, xf, 0.25, &AMRPrimitiveTileT<RealType>::field);
                PROLONG(rho) PROLONG(ur) PROLONG(uz) PROLONG(p) PROLONG(E) PROLONG(alpha1) PROLONG(alpha2) PROLONG(arho1) PROLONG(arho2)
                #undef PROLONG
            }
        }
    } else {
        // Apply Boundary conditions
        int bc = (boundary_id == 0) ? (int)bc_r_min :
                 ((boundary_id == 1) ? (int)bc_r_max :
                  ((boundary_id == 2) ? (int)bc_z_min : (int)bc_z_max));

        if (boundary_id == 0) { // Left
            int tj = cell_idx + 2;
            CellState2DT<RealType> s1 = { T.rho[2*AMR_TILE_DIM+tj], T.ur[2*AMR_TILE_DIM+tj], T.uz[2*AMR_TILE_DIM+tj], T.p[2*AMR_TILE_DIM+tj], T.E[2*AMR_TILE_DIM+tj], T.alpha1[2*AMR_TILE_DIM+tj], T.alpha2[2*AMR_TILE_DIM+tj], T.arho1[2*AMR_TILE_DIM+tj], T.arho2[2*AMR_TILE_DIM+tj] };
            s1 = applyBC_AMR_kernel(s1, bc, s1.ur, ambient_rho, ambient_p, gamma, mat, is_ideal_gas, true);
            T.rho[1*AMR_TILE_DIM+tj] = s1.rho; T.ur[1*AMR_TILE_DIM+tj] = s1.ur; T.uz[1*AMR_TILE_DIM+tj] = s1.uz; T.p[1*AMR_TILE_DIM+tj] = s1.p; T.E[1*AMR_TILE_DIM+tj] = s1.E; T.alpha1[1*AMR_TILE_DIM+tj] = s1.alpha1; T.alpha2[1*AMR_TILE_DIM+tj] = s1.alpha2; T.arho1[1*AMR_TILE_DIM+tj] = s1.arho1; T.arho2[1*AMR_TILE_DIM+tj] = s1.arho2;
            T.rho[0*AMR_TILE_DIM+tj] = s1.rho; T.ur[0*AMR_TILE_DIM+tj] = s1.ur; T.uz[0*AMR_TILE_DIM+tj] = s1.uz; T.p[0*AMR_TILE_DIM+tj] = s1.p; T.E[0*AMR_TILE_DIM+tj] = s1.E; T.alpha1[0*AMR_TILE_DIM+tj] = s1.alpha1; T.alpha2[0*AMR_TILE_DIM+tj] = s1.alpha2; T.arho1[0*AMR_TILE_DIM+tj] = s1.arho1; T.arho2[0*AMR_TILE_DIM+tj] = s1.arho2;
        } else if (boundary_id == 1) { // Right
            int tj = cell_idx + 2;
            CellState2DT<RealType> s1 = { T.rho[17*AMR_TILE_DIM+tj], T.ur[17*AMR_TILE_DIM+tj], T.uz[17*AMR_TILE_DIM+tj], T.p[17*AMR_TILE_DIM+tj], T.E[17*AMR_TILE_DIM+tj], T.alpha1[17*AMR_TILE_DIM+tj], T.alpha2[17*AMR_TILE_DIM+tj], T.arho1[17*AMR_TILE_DIM+tj], T.arho2[17*AMR_TILE_DIM+tj] };
            s1 = applyBC_AMR_kernel(s1, bc, -s1.ur, ambient_rho, ambient_p, gamma, mat, is_ideal_gas, true);
            T.rho[18*AMR_TILE_DIM+tj] = s1.rho; T.ur[18*AMR_TILE_DIM+tj] = s1.ur; T.uz[18*AMR_TILE_DIM+tj] = s1.uz; T.p[18*AMR_TILE_DIM+tj] = s1.p; T.E[18*AMR_TILE_DIM+tj] = s1.E; T.alpha1[18*AMR_TILE_DIM+tj] = s1.alpha1; T.alpha2[18*AMR_TILE_DIM+tj] = s1.alpha2; T.arho1[18*AMR_TILE_DIM+tj] = s1.arho1; T.arho2[18*AMR_TILE_DIM+tj] = s1.arho2;
            T.rho[19*AMR_TILE_DIM+tj] = s1.rho; T.ur[19*AMR_TILE_DIM+tj] = s1.ur; T.uz[19*AMR_TILE_DIM+tj] = s1.uz; T.p[19*AMR_TILE_DIM+tj] = s1.p; T.E[19*AMR_TILE_DIM+tj] = s1.E; T.alpha1[19*AMR_TILE_DIM+tj] = s1.alpha1; T.alpha2[19*AMR_TILE_DIM+tj] = s1.alpha2; T.arho1[19*AMR_TILE_DIM+tj] = s1.arho1; T.arho2[19*AMR_TILE_DIM+tj] = s1.arho2;
        } else if (boundary_id == 2) { // Bottom
            int ti = cell_idx + 2;
            CellState2DT<RealType> s1 = { T.rho[ti*AMR_TILE_DIM+2], T.ur[ti*AMR_TILE_DIM+2], T.uz[ti*AMR_TILE_DIM+2], T.p[ti*AMR_TILE_DIM+2], T.E[ti*AMR_TILE_DIM+2], T.alpha1[ti*AMR_TILE_DIM+2], T.alpha2[ti*AMR_TILE_DIM+2], T.arho1[ti*AMR_TILE_DIM+2], T.arho2[ti*AMR_TILE_DIM+2] };
            s1 = applyBC_AMR_kernel(s1, bc, s1.uz, ambient_rho, ambient_p, gamma, mat, is_ideal_gas, false);
            T.rho[ti*AMR_TILE_DIM+1] = s1.rho; T.ur[ti*AMR_TILE_DIM+1] = s1.ur; T.uz[ti*AMR_TILE_DIM+1] = s1.uz; T.p[ti*AMR_TILE_DIM+1] = s1.p; T.E[ti*AMR_TILE_DIM+1] = s1.E; T.alpha1[ti*AMR_TILE_DIM+1] = s1.alpha1; T.alpha2[ti*AMR_TILE_DIM+1] = s1.alpha2; T.arho1[ti*AMR_TILE_DIM+1] = s1.arho1; T.arho2[ti*AMR_TILE_DIM+1] = s1.arho2;
            T.rho[ti*AMR_TILE_DIM+0] = s1.rho; T.ur[ti*AMR_TILE_DIM+0] = s1.ur; T.uz[ti*AMR_TILE_DIM+0] = s1.uz; T.p[ti*AMR_TILE_DIM+0] = s1.p; T.E[ti*AMR_TILE_DIM+0] = s1.E; T.alpha1[ti*AMR_TILE_DIM+0] = s1.alpha1; T.alpha2[ti*AMR_TILE_DIM+0] = s1.alpha2; T.arho1[ti*AMR_TILE_DIM+0] = s1.arho1; T.arho2[ti*AMR_TILE_DIM+0] = s1.arho2;
        } else if (boundary_id == 3) { // Top
            int ti = cell_idx + 2;
            CellState2DT<RealType> s1 = { T.rho[ti*AMR_TILE_DIM+17], T.ur[ti*AMR_TILE_DIM+17], T.uz[ti*AMR_TILE_DIM+17], T.p[ti*AMR_TILE_DIM+17], T.E[ti*AMR_TILE_DIM+17], T.alpha1[ti*AMR_TILE_DIM+17], T.alpha2[ti*AMR_TILE_DIM+17], T.arho1[ti*AMR_TILE_DIM+17], T.arho2[ti*AMR_TILE_DIM+17] };
            s1 = applyBC_AMR_kernel(s1, bc, -s1.uz, ambient_rho, ambient_p, gamma, mat, is_ideal_gas, false);
            T.rho[ti*AMR_TILE_DIM+18] = s1.rho; T.ur[ti*AMR_TILE_DIM+18] = s1.ur; T.uz[ti*AMR_TILE_DIM+18] = s1.uz; T.p[ti*AMR_TILE_DIM+18] = s1.p; T.E[ti*AMR_TILE_DIM+18] = s1.E; T.alpha1[ti*AMR_TILE_DIM+18] = s1.alpha1; T.alpha2[ti*AMR_TILE_DIM+18] = s1.alpha2; T.arho1[ti*AMR_TILE_DIM+18] = s1.arho1; T.arho2[ti*AMR_TILE_DIM+18] = s1.arho2;
            T.rho[ti*AMR_TILE_DIM+19] = s1.rho; T.ur[ti*AMR_TILE_DIM+19] = s1.ur; T.uz[ti*AMR_TILE_DIM+19] = s1.uz; T.p[ti*AMR_TILE_DIM+19] = s1.p; T.E[ti*AMR_TILE_DIM+19] = s1.E; T.alpha1[ti*AMR_TILE_DIM+19] = s1.alpha1; T.alpha2[ti*AMR_TILE_DIM+19] = s1.alpha2; T.arho1[ti*AMR_TILE_DIM+19] = s1.arho1; T.arho2[ti*AMR_TILE_DIM+19] = s1.arho2;
        }
    }

    __syncthreads();

    if (tid < 16) {
        int corner_id = tid / 4;
        int cell_offset = tid % 4;
        int ci = cell_offset % 2;
        int cj = cell_offset / 2;

        int target_r_off = (corner_id == 1 || corner_id == 3) ? 1 : -1;
        int target_z_off = (corner_id == 2 || corner_id == 3) ? 1 : -1;

        int nb_diag = findNodeByCoordsGPU(nodes, total_nodes, level0_tiles_r, level0_tiles_z,
                                          node.r_idx + target_r_off, node.z_idx + target_z_off, node.level);

        int dst_i = (corner_id == 1 || corner_id == 3) ? (18 + ci) : ci;
        int dst_j = (corner_id == 2 || corner_id == 3) ? (18 + cj) : cj;

        int dst_k = dst_i * AMR_TILE_DIM + dst_j;

        if (nb_diag != -1 && nodes[nb_diag].tile_id != -1) {
            int src_pool = nodes[nb_diag].tile_id;
            auto& Nb = states_pool[src_pool];
            int src_i = (corner_id == 1 || corner_id == 3) ? (2 + ci) : (16 + ci);
            int src_j = (corner_id == 2 || corner_id == 3) ? (2 + cj) : (16 + cj);
            int src_k = src_i * AMR_TILE_DIM + src_j;

            T.rho[dst_k] = Nb.rho[src_k];
            T.ur[dst_k] = Nb.ur[src_k];
            T.uz[dst_k] = Nb.uz[src_k];
            T.p[dst_k] = Nb.p[src_k];
            T.E[dst_k] = Nb.E[src_k];
            T.alpha1[dst_k] = Nb.alpha1[src_k];
            T.alpha2[dst_k] = Nb.alpha2[src_k];
            T.arho1[dst_k] = Nb.arho1[src_k];
            T.arho2[dst_k] = Nb.arho2[src_k];
        } else {
            int adj_i = (dst_i < 2) ? 2 : (dst_i >= 18 ? 17 : dst_i);
            int adj_j = (dst_j < 2) ? 2 : (dst_j >= 18 ? 17 : dst_j);
            int face_r_i = (dst_i < 2) ? 0 : (dst_i >= 18 ? 19 : dst_i);
            int face_z_j = (dst_j < 2) ? 0 : (dst_j >= 18 ? 19 : dst_j);

            int src_r_k = face_r_i * AMR_TILE_DIM + adj_j;
            int src_z_k = adj_i * AMR_TILE_DIM + face_z_j;

            #define AVG_GPU_CORNER(field) T.field[dst_k] = (RealType)0.5 * (T.field[src_r_k] + T.field[src_z_k]);
            AVG_GPU_CORNER(rho) AVG_GPU_CORNER(ur) AVG_GPU_CORNER(uz) AVG_GPU_CORNER(p) AVG_GPU_CORNER(E)
            AVG_GPU_CORNER(alpha1) AVG_GPU_CORNER(alpha2) AVG_GPU_CORNER(arho1) AVG_GPU_CORNER(arho2)
            #undef AVG_GPU_CORNER
        }
    }
}

template <typename RealType>
__global__ void computeTileRHS_AMR_kernel(
    GPUNode2D* nodes,
    int* active_node_ids,
    int active_leaves_count,
    AMRPrimitiveTileT<RealType>* states_pool,
    AMRConservativeTileT<RealType>* dU_pool,
    AMRFaceFluxT<RealType>* node_boundary_fluxes,
    RealType A_coeff,
    RealType dt,
    RealType gamma,
    MultiMat::MaterialSet mat,
    bool is_ideal_gas,
    double dr_base,
    double dz_base,
    int spatial_order) {

    int tile_idx = blockIdx.x;
    if (tile_idx >= active_leaves_count) return;

    int node_idx = active_node_ids[tile_idx];
    auto node = nodes[node_idx];
    int pool_idx = node.tile_id;
    const auto& T = states_pool[pool_idx];
    auto& dU = dU_pool[pool_idx];
    __shared__ RealType sm_rho[AMR_TILE_DIM * AMR_TILE_DIM];
    __shared__ RealType sm_ur[AMR_TILE_DIM * AMR_TILE_DIM];
    __shared__ RealType sm_uz[AMR_TILE_DIM * AMR_TILE_DIM];
    __shared__ RealType sm_p[AMR_TILE_DIM * AMR_TILE_DIM];
    __shared__ RealType sm_E[AMR_TILE_DIM * AMR_TILE_DIM];
    __shared__ RealType sm_alpha1[AMR_TILE_DIM * AMR_TILE_DIM];
    __shared__ RealType sm_alpha2[AMR_TILE_DIM * AMR_TILE_DIM];
    __shared__ RealType sm_arho1[AMR_TILE_DIM * AMR_TILE_DIM];
    __shared__ RealType sm_arho2[AMR_TILE_DIM * AMR_TILE_DIM];

    int flat_tid = threadIdx.y * 16 + threadIdx.x; // 0..255
    for (int idx = flat_tid; idx < AMR_TILE_DIM * AMR_TILE_DIM; idx += 256) {
        sm_rho[idx]    = T.rho[idx];
        sm_ur[idx]     = T.ur[idx];
        sm_uz[idx]     = T.uz[idx];
        sm_p[idx]      = T.p[idx];
        sm_E[idx]      = T.E[idx];
        sm_alpha1[idx] = T.alpha1[idx];
        sm_alpha2[idx] = T.alpha2[idx];
        sm_arho1[idx]  = T.arho1[idx];
        sm_arho2[idx]  = T.arho2[idx];
    }
    __syncthreads();

    int i = threadIdx.x; // 0..15
    int j = threadIdx.y; // 0..15

    int ti = i + 2;
    int tj = j + 2;

    double factor = 1.0 / (1 << node.level);
    RealType dr_r = (RealType)(dr_base * factor);
    RealType dz_r = (RealType)(dz_base * factor);
    double global_r = node.r_min + (i + 0.5) * dr_base * factor;

    auto readStateLocal = [&](int ii, int jj) {
        int idx = ii * AMR_TILE_DIM + jj;
        CellState2DT<RealType> s = { sm_rho[idx], sm_ur[idx], sm_uz[idx], sm_p[idx], sm_E[idx], sm_alpha1[idx], sm_alpha2[idx], sm_arho1[idx], sm_arho2[idx] };
        return s;
    };

    CellState2DT<RealType> s_c = readStateLocal(ti, tj);
    CellState2DT<RealType> s_L = readStateLocal(ti - 1, tj);
    CellState2DT<RealType> s_R = readStateLocal(ti + 1, tj);
    CellState2DT<RealType> s_B = readStateLocal(ti, tj - 1);
    CellState2DT<RealType> s_T = readStateLocal(ti, tj + 1);

    CellState2DT<RealType> s_faceL_L = s_L;
    CellState2DT<RealType> s_faceL_R = s_c;
    CellState2DT<RealType> s_faceR_L = s_c;
    CellState2DT<RealType> s_faceR_R = s_R;
    CellState2DT<RealType> s_faceB_L = s_B;
    CellState2DT<RealType> s_faceB_R = s_c;
    CellState2DT<RealType> s_faceT_L = s_c;
    CellState2DT<RealType> s_faceT_R = s_T;

    if (spatial_order == 2) {
        CellState2DT<RealType> s_LL = readStateLocal(ti - 2, tj);
        CellState2DT<RealType> s_RR = readStateLocal(ti + 2, tj);
        CellState2DT<RealType> s_BB = readStateLocal(ti, tj - 2);
        CellState2DT<RealType> s_TT = readStateLocal(ti, tj + 2);

        #define RECONSTRUCT(L, R, LL, RR, fl_L, fl_R, fr_L, fr_R, field) \
            fl_L.field = L.field + (RealType)0.5 * minmod_gpu(L.field - LL.field, s_c.field - L.field); \
            fl_R.field = s_c.field - (RealType)0.5 * minmod_gpu(s_c.field - L.field, R.field - s_c.field); \
            fr_L.field = s_c.field + (RealType)0.5 * minmod_gpu(s_c.field - L.field, R.field - s_c.field); \
            fr_R.field = R.field - (RealType)0.5 * minmod_gpu(R.field - s_c.field, RR.field - R.field);

        RECONSTRUCT(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, rho)
        RECONSTRUCT(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, ur)
        RECONSTRUCT(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, uz)
        RECONSTRUCT(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, p)
        RECONSTRUCT(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, alpha1)
        RECONSTRUCT(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, alpha2)
        RECONSTRUCT(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, arho1)
        RECONSTRUCT(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, arho2)

        RECONSTRUCT(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, rho)
        RECONSTRUCT(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, ur)
        RECONSTRUCT(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, uz)
        RECONSTRUCT(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, p)
        RECONSTRUCT(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, alpha1)
        RECONSTRUCT(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, alpha2)
        RECONSTRUCT(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, arho1)
        RECONSTRUCT(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, arho2)
        #undef RECONSTRUCT

        #define CLAMP(face) \
            face.alpha1 = math_max((RealType)0.0, math_min((RealType)1.0, face.alpha1)); \
            face.alpha2 = math_max((RealType)0.0, math_min((RealType)1.0, face.alpha2)); \
            compute_E_kernel(face, gamma, mat, is_ideal_gas);

        CLAMP(s_faceL_L) CLAMP(s_faceL_R) CLAMP(s_faceR_L) CLAMP(s_faceR_R)
        CLAMP(s_faceB_L) CLAMP(s_faceB_R) CLAMP(s_faceT_L) CLAMP(s_faceT_R)
        #undef CLAMP
    } else if (spatial_order == 3) {
        CellState2DT<RealType> s_LL = readStateLocal(ti - 2, tj);
        CellState2DT<RealType> s_RR = readStateLocal(ti + 2, tj);
        CellState2DT<RealType> s_BB = readStateLocal(ti, tj - 2);
        CellState2DT<RealType> s_TT = readStateLocal(ti, tj + 2);

        #define RECONSTRUCT_WENO(L, R, LL, RR, fl_L, fl_R, fr_L, fr_R, field) \
            fl_L.field = weno3_kernel(LL.field, L.field, s_c.field); \
            fl_R.field = weno3_kernel(R.field, s_c.field, L.field); \
            fr_L.field = weno3_kernel(L.field, s_c.field, R.field); \
            fr_R.field = weno3_kernel(RR.field, R.field, s_c.field);

        RECONSTRUCT_WENO(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, rho)
        RECONSTRUCT_WENO(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, ur)
        RECONSTRUCT_WENO(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, uz)
        RECONSTRUCT_WENO(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, p)

        RECONSTRUCT_WENO(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, rho)
        RECONSTRUCT_WENO(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, ur)
        RECONSTRUCT_WENO(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, uz)
        RECONSTRUCT_WENO(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, p)
        #undef RECONSTRUCT_WENO

        #define RECONSTRUCT_MM(L, R, LL, RR, fl_L, fl_R, fr_L, fr_R, field) \
            fl_L.field = L.field + (RealType)0.5 * minmod_gpu(L.field - LL.field, s_c.field - L.field); \
            fl_R.field = s_c.field - (RealType)0.5 * minmod_gpu(s_c.field - L.field, R.field - s_c.field); \
            fr_L.field = s_c.field + (RealType)0.5 * minmod_gpu(s_c.field - L.field, R.field - s_c.field); \
            fr_R.field = R.field - (RealType)0.5 * minmod_gpu(R.field - s_c.field, RR.field - R.field);

        RECONSTRUCT_MM(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, alpha1)
        RECONSTRUCT_MM(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, alpha2)
        RECONSTRUCT_MM(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, arho1)
        RECONSTRUCT_MM(s_L, s_R, s_LL, s_RR, s_faceL_L, s_faceL_R, s_faceR_L, s_faceR_R, arho2)

        RECONSTRUCT_MM(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, alpha1)
        RECONSTRUCT_MM(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, alpha2)
        RECONSTRUCT_MM(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, arho1)
        RECONSTRUCT_MM(s_B, s_T, s_BB, s_TT, s_faceB_L, s_faceB_R, s_faceT_L, s_faceT_R, arho2)
        #undef RECONSTRUCT_MM

        #define CLAMP(face) \
            face.alpha1 = math_max((RealType)0.0, math_min((RealType)1.0, face.alpha1)); \
            face.alpha2 = math_max((RealType)0.0, math_min((RealType)1.0, face.alpha2)); \
            compute_E_kernel(face, gamma, mat, is_ideal_gas);

        CLAMP(s_faceL_L) CLAMP(s_faceL_R) CLAMP(s_faceR_L) CLAMP(s_faceR_R)
        CLAMP(s_faceB_L) CLAMP(s_faceB_R) CLAMP(s_faceT_L) CLAMP(s_faceT_R)
        #undef CLAMP
    }

    RealType fr_L_rho, fr_L_rhour, fr_L_rhouz, fr_L_E, fr_L_a1, fr_L_a2, fr_L_ar1, fr_L_ar2, v_face_rL;
    RealType fr_R_rho, fr_R_rhour, fr_R_rhouz, fr_R_E, fr_R_a1, fr_R_a2, fr_R_ar1, fr_R_ar2, v_face_rR;
    
    calcFluxRusanov_kernel(s_faceL_L, s_faceL_R, gamma, mat, fr_L_rho, fr_L_rhour, fr_L_rhouz, fr_L_E, fr_L_a1, fr_L_a2, fr_L_ar1, fr_L_ar2, v_face_rL, is_ideal_gas);
    calcFluxRusanov_kernel(s_faceR_L, s_faceR_R, gamma, mat, fr_R_rho, fr_R_rhour, fr_R_rhouz, fr_R_E, fr_R_a1, fr_R_a2, fr_R_ar1, fr_R_ar2, v_face_rR, is_ideal_gas);
    
    RealType fz_B_rho, fz_B_rhour, fz_B_rhouz, fz_B_E, fz_B_a1, fz_B_a2, fz_B_ar1, fz_B_ar2, v_face_zB;
    RealType fz_T_rho, fz_T_rhour, fz_T_rhouz, fz_T_E, fz_T_a1, fz_T_a2, fz_T_ar1, fz_T_ar2, v_face_zT;
 
    calcFluxRusanovZ_kernel(s_faceB_L, s_faceB_R, gamma, mat, fz_B_rho, fz_B_rhour, fz_B_rhouz, fz_B_E, fz_B_a1, fz_B_a2, fz_B_ar1, fz_B_ar2, v_face_zB, is_ideal_gas);
    calcFluxRusanovZ_kernel(s_faceT_L, s_faceT_R, gamma, mat, fz_T_rho, fz_T_rhour, fz_T_rhouz, fz_T_E, fz_T_a1, fz_T_a2, fz_T_ar1, fz_T_ar2, v_face_zT, is_ideal_gas);

    RealType r_center = (RealType)global_r;
    RealType r_left = (RealType)(global_r - 0.5 * dr_r);
    RealType r_right = (RealType)(global_r + 0.5 * dr_r);

    RealType p_face_R = (RealType)0.5 * (s_faceR_L.p + s_faceR_R.p);
    RealType p_face_L = (RealType)0.5 * (s_faceL_L.p + s_faceL_R.p);
    RealType p_face_avg = (RealType)0.5 * (p_face_R + p_face_L);

    RealType dU_rho = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_rho - r_left * fr_L_rho) - ((RealType)1.0 / dz_r) * (fz_T_rho - fz_B_rho);
    RealType dU_rhour = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_rhour - r_left * fr_L_rhour) - ((RealType)1.0 / dz_r) * (fz_T_rhour - fz_B_rhour) + p_face_avg / r_center;
    RealType dU_rhouz = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_rhouz - r_left * fr_L_rhouz) - ((RealType)1.0 / dz_r) * (fz_T_rhouz - fz_B_rhouz);
    RealType dU_E = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_E - r_left * fr_L_E) - ((RealType)1.0 / dz_r) * (fz_T_E - fz_B_E);

    RealType div_u = ((RealType)1.0 / (r_center * dr_r)) * (r_right * v_face_rR - r_left * v_face_rL) + ((RealType)1.0 / dz_r) * (v_face_zT - v_face_zB);
    
    RealType dU_alpha1 = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_a1 - r_left * fr_L_a1) - ((RealType)1.0 / dz_r) * (fz_T_a1 - fz_B_a1) + s_c.alpha1 * div_u;
    RealType dU_alpha2 = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_a2 - r_left * fr_L_a2) - ((RealType)1.0 / dz_r) * (fz_T_a2 - fz_B_a2) + s_c.alpha2 * div_u;
    RealType dU_arho1 = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_ar1 - r_left * fr_L_ar1) - ((RealType)1.0 / dz_r) * (fz_T_ar1 - fz_B_ar1);
    RealType dU_arho2 = -((RealType)1.0 / (r_center * dr_r)) * (r_right * fr_R_ar2 - r_left * fr_L_ar2) - ((RealType)1.0 / dz_r) * (fz_T_ar2 - fz_B_ar2);

        int k_20 = ti * AMR_TILE_DIM + tj;
    dU.rho[k_20] = A_coeff * dU.rho[k_20] + dt * dU_rho;
    dU.rhour[k_20] = A_coeff * dU.rhour[k_20] + dt * dU_rhour;
    dU.rhouz[k_20] = A_coeff * dU.rhouz[k_20] + dt * dU_rhouz;
    dU.E[k_20] = A_coeff * dU.E[k_20] + dt * dU_E;
    dU.alpha1[k_20] = A_coeff * dU.alpha1[k_20] + dt * dU_alpha1;
    dU.alpha2[k_20] = A_coeff * dU.alpha2[k_20] + dt * dU_alpha2;
    dU.arho1[k_20] = A_coeff * dU.arho1[k_20] + dt * dU_arho1;
    dU.arho2[k_20] = A_coeff * dU.arho2[k_20] + dt * dU_arho2;

    if (node_boundary_fluxes) {
        if (i == 0) {
            auto& f = node_boundary_fluxes[node_idx * 4 + 0];
            f.rho[j] = fr_L_rho; f.rhour[j] = fr_L_rhour; f.rhouz[j] = fr_L_rhouz; f.E[j] = fr_L_E;
            f.alpha1[j] = fr_L_a1; f.alpha2[j] = fr_L_a2; f.arho1[j] = fr_L_ar1; f.arho2[j] = fr_L_ar2;
        }
        if (i == 15) {
            auto& f = node_boundary_fluxes[node_idx * 4 + 1];
            f.rho[j] = fr_R_rho; f.rhour[j] = fr_R_rhour; f.rhouz[j] = fr_R_rhouz; f.E[j] = fr_R_E;
            f.alpha1[j] = fr_R_a1; f.alpha2[j] = fr_R_a2; f.arho1[j] = fr_R_ar1; f.arho2[j] = fr_R_ar2;
        }
        if (j == 0) {
            auto& f = node_boundary_fluxes[node_idx * 4 + 2];
            f.rho[i] = fz_B_rho; f.rhour[i] = fz_B_rhour; f.rhouz[i] = fz_B_rhouz; f.E[i] = fz_B_E;
            f.alpha1[i] = fz_B_a1; f.alpha2[i] = fz_B_a2; f.arho1[i] = fz_B_ar1; f.arho2[i] = fz_B_ar2;
        }
        if (j == 15) {
            auto& f = node_boundary_fluxes[node_idx * 4 + 3];
            f.rho[i] = fz_T_rho; f.rhour[i] = fz_T_rhour; f.rhouz[i] = fz_T_rhouz; f.E[i] = fz_T_E;
            f.alpha1[i] = fz_T_a1; f.alpha2[i] = fz_T_a2; f.arho1[i] = fz_T_ar1; f.arho2[i] = fz_T_ar2;
        }
    }
}

template <typename RealType>
__global__ void updateConservativeRKStage_AMR_kernel(
    int* active_tile_ids,
    int active_leaves_count,
    AMRConservativeTileT<RealType>* U_pool,
    AMRConservativeTileT<RealType>* dU_pool,
    RealType B_coeff) {

    int tile_idx = blockIdx.x;
    if (tile_idx >= active_leaves_count) return;

    int pool_idx = active_tile_ids[tile_idx];
    auto& U = U_pool[pool_idx];
    const auto& dU = dU_pool[pool_idx];

    int i = threadIdx.x;
    int j = threadIdx.y;
    int k = (i + 2) * AMR_TILE_DIM + (j + 2);

    U.rho[k] += B_coeff * dU.rho[k];
    U.rhour[k] += B_coeff * dU.rhour[k];
    U.rhouz[k] += B_coeff * dU.rhouz[k];
    U.E[k] += B_coeff * dU.E[k];
    U.alpha1[k] += B_coeff * dU.alpha1[k];
    U.alpha2[k] += B_coeff * dU.alpha2[k];
    U.arho1[k] += B_coeff * dU.arho1[k];
    U.arho2[k] += B_coeff * dU.arho2[k];
}

template <typename RealType>
__global__ void restrictNode_AMR_kernel(
    GPUNode2D* nodes,
    int* level_parent_node_ids,
    int level_parents_count,
    AMRConservativeTileT<RealType>* U_pool,
    double dr_base,
    bool is_cartesian) {

    int p_idx = blockIdx.x;
    if (p_idx >= level_parents_count) return;

    int parent_node_idx = level_parent_node_ids[p_idx];
    auto node = nodes[parent_node_idx];
    auto& U_parent = U_pool[node.tile_id];

    int child_bl = nodes[node.children[0]].tile_id;
    int child_br = nodes[node.children[1]].tile_id;
    int child_tl = nodes[node.children[2]].tile_id;
    int child_tr = nodes[node.children[3]].tile_id;

    int i = threadIdx.x; // 0..15 -> pi = i + 2
    int j = threadIdx.y; // 0..15 -> pj = j + 2

    int pi = i + 2;
    int pj = j + 2;
    int pk = pi * AMR_TILE_DIM + pj;

    int child_tile_r = (pi >= 10) ? 1 : 0;
    int local_pi = (pi < 10) ? (pi - 2) : (pi - 10);
    int ci1 = 2 * local_pi + 2;
    int ci2 = 2 * local_pi + 3;

    int child_tile_z = (pj >= 10) ? 2 : 0;
    int quadrant = child_tile_r + child_tile_z;

    int active_child_tile_id = -1;
    if (quadrant == 0) active_child_tile_id = child_bl;
    else if (quadrant == 1) active_child_tile_id = child_br;
    else if (quadrant == 2) active_child_tile_id = child_tl;
    else active_child_tile_id = child_tr;

    int local_pj = (pj < 10) ? (pj - 2) : (pj - 10);
    int cj1 = 2 * local_pj + 2;
    int cj2 = 2 * local_pj + 3;

    double factor = 1.0 / (1 << node.level);
    RealType dr_r = (RealType)(dr_base * factor);
    RealType r_P = (RealType)(node.r_min + (pi - 2 + 0.5) * dr_r);
    RealType w1, w2;
    if (is_cartesian) {
        w1 = (RealType)0.5;
        w2 = (RealType)0.5;
    } else {
        RealType w_calc = (RealType)(dr_r / (8.0 * r_P));
        w1 = max((RealType)0.05, min((RealType)0.95, (RealType)0.5 - w_calc));
        w2 = max((RealType)0.05, min((RealType)0.95, (RealType)0.5 + w_calc));
    }

    auto get_child_val = [&](int child_id, int local_i, int local_j, auto field) {
        int k = local_i * AMR_TILE_DIM + local_j;
        return (U_pool[child_id].*field)[k];
    };

    #define RESTRICT_FIELD(field) \
    { \
        RealType val_bl = get_child_val(active_child_tile_id, ci1, cj1, &AMRConservativeTileT<RealType>::field); \
        RealType val_br = get_child_val(active_child_tile_id, ci2, cj1, &AMRConservativeTileT<RealType>::field); \
        RealType val_tl = get_child_val(active_child_tile_id, ci1, cj2, &AMRConservativeTileT<RealType>::field); \
        RealType val_tr = get_child_val(active_child_tile_id, ci2, cj2, &AMRConservativeTileT<RealType>::field); \
        U_parent.field[pk] = (RealType)(0.5 * (w1 * (val_bl + val_tl) + w2 * (val_br + val_tr))); \
    }

    RESTRICT_FIELD(rho) RESTRICT_FIELD(rhour) RESTRICT_FIELD(rhouz)
    RESTRICT_FIELD(alpha1) RESTRICT_FIELD(alpha2) RESTRICT_FIELD(arho1) RESTRICT_FIELD(arho2)
    #undef RESTRICT_FIELD

    auto get_fine_internal_e = [&](int ci, int cj) {
        RealType rho_f = get_child_val(active_child_tile_id, ci, cj, &AMRConservativeTileT<RealType>::rho);
        RealType rhour_f = get_child_val(active_child_tile_id, ci, cj, &AMRConservativeTileT<RealType>::rhour);
        RealType rhouz_f = get_child_val(active_child_tile_id, ci, cj, &AMRConservativeTileT<RealType>::rhouz);
        RealType E_f = get_child_val(active_child_tile_id, ci, cj, &AMRConservativeTileT<RealType>::E);
        RealType rho_safe = max(rho_f, (RealType)1e-10);
        RealType ke_f = (RealType)0.5 * (rhour_f * rhour_f + rhouz_f * rhouz_f) / rho_safe;
        return E_f - ke_f;
    };

    RealType e_bl = get_fine_internal_e(ci1, cj1);
    RealType e_br = get_fine_internal_e(ci2, cj1);
    RealType e_tl = get_fine_internal_e(ci1, cj2);
    RealType e_tr = get_fine_internal_e(ci2, cj2);

    RealType e_internal_avg = (RealType)(0.5 * (w1 * (e_bl + e_tl) + w2 * (e_br + e_tr)));
    RealType parent_rho_safe = max(U_parent.rho[pk], (RealType)1e-10);
    RealType parent_ke = (RealType)0.5 * (U_parent.rhour[pk] * U_parent.rhour[pk] + U_parent.rhouz[pk] * U_parent.rhouz[pk]) / parent_rho_safe;

    U_parent.E[pk] = e_internal_avg + parent_ke;
}

template <typename RealType>
__global__ void prolongateChildTiles_AMR_kernel(
    const RefineJobGPU* jobs,
    int num_jobs,
    AMRConservativeTileT<RealType>* d_U_pool) {

    int job_idx = blockIdx.x;
    if (job_idx >= num_jobs) return;

    RefineJobGPU job = jobs[job_idx];
    int p_id = job.parent_tile_id;
    if (p_id == -1) return;

    int i = threadIdx.x;
    int j = threadIdx.y;
    int child_k = (i + 2) * AMR_TILE_DIM + (j + 2);

    for (int q = 0; q < 4; ++q) {
        int c_id = job.child_tile_ids[q];
        if (c_id == -1) continue;

        int r_off = (q & 1) ? 8 : 0;
        int z_off = (q >= 2) ? 8 : 0;

        int pi = 2 + r_off + i / 2;
        int pj = 2 + z_off + j / 2;
        int parent_k = pi * AMR_TILE_DIM + pj;

        d_U_pool[c_id].rho[child_k]     = d_U_pool[p_id].rho[parent_k];
        d_U_pool[c_id].rhour[child_k]   = d_U_pool[p_id].rhour[parent_k];
        d_U_pool[c_id].rhouz[child_k]   = d_U_pool[p_id].rhouz[parent_k];
        d_U_pool[c_id].E[child_k]       = d_U_pool[p_id].E[parent_k];
        d_U_pool[c_id].alpha1[child_k]  = d_U_pool[p_id].alpha1[parent_k];
        d_U_pool[c_id].alpha2[child_k]  = d_U_pool[p_id].alpha2[parent_k];
        d_U_pool[c_id].arho1[child_k]   = d_U_pool[p_id].arho1[parent_k];
        d_U_pool[c_id].arho2[child_k]   = d_U_pool[p_id].arho2[parent_k];
    }
}

template <typename RealType>
__global__ void computeTileMinDt_AMR_kernel(
    GPUNode2D* nodes,
    int* active_node_ids,
    int active_leaves_count,
    const AMRPrimitiveTileT<RealType>* states_pool,
    RealType gamma,
    MultiMat::MaterialSet mat,
    bool is_ideal_gas,
    double dr_base,
    double dz_base,
    double cfl,
    float* tile_min_dts) {

    int tile_idx = blockIdx.x;
    if (tile_idx >= active_leaves_count) return;

    int node_idx = active_node_ids[tile_idx];
    auto node = nodes[node_idx];
    const auto& S = states_pool[node.tile_id];

    int i = threadIdx.x;
    int j = threadIdx.y;
    int k = (i + 2) * AMR_TILE_DIM + (j + 2);

    double factor = 1.0 / (1 << node.level);
    double dr = dr_base * factor;
    double dz = dz_base * factor;

    double cell_dt = 1e20;
    if (S.rho[k] >= (RealType)1e-10) {
        double c;
        if (is_ideal_gas) {
            c = math_sqrt(gamma * math_max(S.p[k], (RealType)1e-8) / math_max(S.rho[k], (RealType)1e-8));
        } else {
            c = MultiMat::getMixtureSoundSpeed(S.p[k], S.rho[k], S.alpha1[k], S.alpha2[k], S.arho1[k], S.arho2[k], gamma, mat.products, mat.unreacted);
        }
        double speed_r = math_abs(S.ur[k]) + c;
        double speed_z = math_abs(S.uz[k]) + c;
        cell_dt = cfl * math_min(dr / (speed_r + 1e-12), dz / (speed_z + 1e-12));
    }

    __shared__ float sm_min_dt[256];
    int tid = j * 16 + i;
    sm_min_dt[tid] = (float)cell_dt;
    __syncthreads();

    for (int stride = 128; stride > 0; stride >>= 1) {
        if (tid < stride) {
            sm_min_dt[tid] = fminf(sm_min_dt[tid], sm_min_dt[tid + stride]);
        }
        __syncthreads();
    }

    if (tid == 0) {
        tile_min_dts[tile_idx] = sm_min_dt[0];
    }
}

__global__ void reduceMinDt_AMR_kernel(const float* tile_min_dts, int count, float* global_min_dt) {
    __shared__ float sm[256];
    int tid = threadIdx.x;
    float val = 1e20f;

    for (int i = tid; i < count; i += blockDim.x) {
        float t_val = tile_min_dts[i];
        if (t_val < val) val = t_val;
    }
    sm[tid] = val;
    __syncthreads();

    for (int stride = 128; stride > 0; stride >>= 1) {
        if (tid < stride) {
            sm[tid] = fminf(sm[tid], sm[tid + stride]);
        }
        __syncthreads();
    }

    if (tid == 0) {
        *global_min_dt = sm[0];
    }
}

inline void launchReduceMinDt_AMR(const float* tile_min_dts, int count, float* global_min_dt) {
    reduceMinDt_AMR_kernel<<<1, 256>>>(tile_min_dts, count, global_min_dt);
}

inline void launchComputeTileMinDt_AMR(
    GPUNode2D* nodes, int* active_node_ids, int active_leaves_count,
    const AMRPrimitiveTileT<float>* states_pool, float gamma,
    MultiMat::MaterialSet mat, bool is_ideal_gas, double dr_base, double dz_base,
    double cfl, float* tile_min_dts) {
    computeTileMinDt_AMR_kernel<float><<<active_leaves_count, dim3(16, 16)>>>(
        nodes, active_node_ids, active_leaves_count, states_pool, gamma, mat, is_ideal_gas, dr_base, dz_base, cfl, tile_min_dts
    );
}

inline void launchComputeTileMinDt_AMR(
    GPUNode2D* nodes, int* active_node_ids, int active_leaves_count,
    const AMRPrimitiveTileT<double>* states_pool, double gamma,
    MultiMat::MaterialSet mat, bool is_ideal_gas, double dr_base, double dz_base,
    double cfl, float* tile_min_dts) {
    computeTileMinDt_AMR_kernel<double><<<active_leaves_count, dim3(16, 16)>>>(
        nodes, active_node_ids, active_leaves_count, states_pool, gamma, mat, is_ideal_gas, dr_base, dz_base, cfl, tile_min_dts
    );
}

template <typename RealType>
__global__ void updatePrimitiveFromConservative_AMR_kernel(
    int* active_tile_ids,
    int active_leaves_count,
    AMRConservativeTileT<RealType>* U_pool,
    AMRPrimitiveTileT<RealType>* states_pool,
    RealType gamma,
    MultiMat::MaterialSet mat,
    bool is_ideal_gas,
    RealType ambient_rho,
    RealType ambient_p) {

    int tile_idx = blockIdx.x;
    if (tile_idx >= active_leaves_count) return;

    int pool_idx = active_tile_ids[tile_idx];
    auto& U = U_pool[pool_idx];
    auto& S = states_pool[pool_idx];

    int i = threadIdx.x;
    int j = threadIdx.y;
    int k = (i + 2) * AMR_TILE_DIM + (j + 2);

    const RealType rho_floor = (RealType)1e-8;
    const RealType p_floor = (RealType)1e-8;

    RealType u_rho = U.rho[k];
    RealType u_rhour = U.rhour[k];
    RealType u_rhouz = U.rhouz[k];
    RealType u_E = U.E[k];
    RealType u_alpha1 = U.alpha1[k];
    RealType u_alpha2 = U.alpha2[k];
    RealType u_arho1 = U.arho1[k];
    RealType u_arho2 = U.arho2[k];

    bool bad = isnan(u_rho) || isinf(u_rho) || u_rho < rho_floor ||
               isnan(u_rhour) || isinf(u_rhour) ||
               isnan(u_rhouz) || isinf(u_rhouz) ||
               isnan(u_E) || isinf(u_E);

    RealType p = ambient_p;
    RealType ur = 0.0;
    RealType uz = 0.0;

    if (bad) {
        u_rho = ambient_rho;
        u_rhour = (RealType)0.0;
        u_rhouz = (RealType)0.0;
        u_E = is_ideal_gas ? (ambient_p / (gamma - (RealType)1.0)) : 
              (ambient_rho * MultiMat::getEnergy_IdealGas(ambient_p, ambient_rho, gamma));
        u_alpha1 = (RealType)0.0;
        u_alpha2 = (RealType)1.0;
        u_arho1 = (RealType)0.0;
        u_arho2 = ambient_rho;

        U.rho[k] = u_rho;
        U.rhour[k] = u_rhour;
        U.rhouz[k] = u_rhouz;
        U.E[k] = u_E;
        U.alpha1[k] = u_alpha1;
        U.alpha2[k] = u_alpha2;
        U.arho1[k] = u_arho1;
        U.arho2[k] = u_arho2;

        p = ambient_p;
        ur = 0.0;
        uz = 0.0;
    } else {
        RealType rho_safe = max(u_rho, rho_floor);
        U.rho[k] = rho_safe;
        ur = u_rhour / rho_safe;
        uz = u_rhouz / rho_safe;
        RealType ke = 0.5 * rho_safe * (ur * ur + uz * uz);

        RealType alpha1 = max((RealType)0.0, min((RealType)1.0, u_alpha1));
        RealType alpha2 = max((RealType)0.0, min((RealType)1.0, u_alpha2));
        if (alpha1 + alpha2 > (RealType)1.0) {
            RealType sum = alpha1 + alpha2;
            alpha1 /= sum;
            alpha2 /= sum;
        }

        RealType arho1 = max((RealType)0.0, min(rho_safe, u_arho1));
        RealType arho2 = max((RealType)0.0, min(rho_safe, u_arho2));
        if (arho1 + arho2 > rho_safe) {
            RealType sum = arho1 + arho2;
            arho1 = (arho1 / sum) * rho_safe;
            arho2 = (arho2 / sum) * rho_safe;
        }

        RealType e_internal = u_E - ke;
        RealType e_min = (RealType)1e-4 * abs(u_E);
        if (e_internal < e_min) {
            RealType p_prev = max((RealType)S.p[k], (RealType)ambient_p);
            if (isnan(p_prev) || isinf(p_prev)) p_prev = (RealType)ambient_p;
            e_internal = is_ideal_gas ? (p_prev / (gamma - (RealType)1.0)) : 
                         (rho_safe * MultiMat::getEnergy_IdealGas(p_prev, rho_safe, gamma));
            U.E[k] = ke + e_internal;
        } else {
            U.E[k] = u_E;
        }

        if (is_ideal_gas) {
            p = e_internal * (gamma - (RealType)1.0);
        } else {
            p = MultiMat::getMixturePressure(e_internal, rho_safe, alpha1, alpha2, arho1, arho2, gamma, mat.products, mat.unreacted);
        }

        if (isnan(p) || isinf(p) || p < p_floor) {
            bad = true;
        } else {
            S.rho[k] = rho_safe;
            S.ur[k] = ur;
            S.uz[k] = uz;
            S.E[k] = u_E;
            S.alpha1[k] = alpha1;
            S.alpha2[k] = alpha2;
            S.arho1[k] = arho1;
            S.arho2[k] = arho2;
            S.p[k] = p;
        }
    }

    if (bad) {
        S.rho[k] = ambient_rho;
        S.ur[k] = 0.0;
        S.uz[k] = 0.0;
        S.p[k] = ambient_p;
        S.alpha1[k] = 0.0;
        S.alpha2[k] = 0.0;
        S.arho1[k] = 0.0;
        S.arho2[k] = 0.0;
        S.E[k] = ambient_p / (gamma - (RealType)1.0);
        
        U.rho[k] = ambient_rho;
        U.rhour[k] = 0.0;
        U.rhouz[k] = 0.0;
        U.E[k] = S.E[k];
        U.alpha1[k] = 0.0;
        U.alpha2[k] = 0.0;
        U.arho1[k] = 0.0;
        U.arho2[k] = 0.0;
    }
}

template <typename RealType>
__global__ void applyFluxCorrectionGPU_kernel(
    GPUNode2D* nodes, int* active_node_ids, int active_leaves_count,
    AMRConservativeTileT<RealType>* U_pool, AMRFaceFluxT<RealType>* node_boundary_fluxes,
    double B_coeff, double dt, double dr_base, double dz_base, bool is_cartesian);

template <typename RealType>
__global__ void computeTileLoehnerError_AMR_kernel(
    const GPUNode2D* nodes, const int* active_node_ids, int active_leaves_count,
    const AMRPrimitiveTileT<RealType>* states_pool, float* tile_errors);

inline void launchFillGhostCells_AMR(
    GPUNode2D* nodes, int total_nodes, int level0_tiles_r, int level0_tiles_z,
    int* active_node_ids, int active_leaves_count, AMRPrimitiveTileT<float>* states_pool,
    CFDSolver2DCuda::BCType bc_r_min, CFDSolver2DCuda::BCType bc_r_max,
    CFDSolver2DCuda::BCType bc_z_min, CFDSolver2DCuda::BCType bc_z_max,
    float ambient_rho, float ambient_p, float gamma, MultiMat::MaterialSet mat,
    bool is_ideal_gas, double dr_base, double dz_base) {
    fillGhostCells_AMR_kernel<float><<<active_leaves_count, 64>>>(
        nodes, total_nodes, level0_tiles_r, level0_tiles_z, active_node_ids, active_leaves_count,
        states_pool, bc_r_min, bc_r_max, bc_z_min, bc_z_max, ambient_rho, ambient_p, gamma, mat, is_ideal_gas, dr_base, dz_base);
}

inline void launchFillGhostCells_AMR(
    GPUNode2D* nodes, int total_nodes, int level0_tiles_r, int level0_tiles_z,
    int* active_node_ids, int active_leaves_count, AMRPrimitiveTileT<double>* states_pool,
    CFDSolver2DCuda::BCType bc_r_min, CFDSolver2DCuda::BCType bc_r_max,
    CFDSolver2DCuda::BCType bc_z_min, CFDSolver2DCuda::BCType bc_z_max,
    double ambient_rho, double ambient_p, double gamma, MultiMat::MaterialSet mat,
    bool is_ideal_gas, double dr_base, double dz_base) {
    fillGhostCells_AMR_kernel<double><<<active_leaves_count, 64>>>(
        nodes, total_nodes, level0_tiles_r, level0_tiles_z, active_node_ids, active_leaves_count,
        states_pool, bc_r_min, bc_r_max, bc_z_min, bc_z_max, ambient_rho, ambient_p, gamma, mat, is_ideal_gas, dr_base, dz_base);
}

inline void launchComputeTileRHS_AMR(
    GPUNode2D* nodes, int* active_node_ids, int active_leaves_count,
    AMRPrimitiveTileT<float>* states_pool, AMRConservativeTileT<float>* dU_pool,
    AMRFaceFluxT<float>* node_boundary_fluxes, float A_coeff, float dt, float gamma, MultiMat::MaterialSet mat,
    bool is_ideal_gas, double dr_base, double dz_base, int order) {
    computeTileRHS_AMR_kernel<float><<<active_leaves_count, dim3(16, 16)>>>(
        nodes, active_node_ids, active_leaves_count, states_pool, dU_pool, node_boundary_fluxes, A_coeff, dt, gamma, mat, is_ideal_gas, dr_base, dz_base, order);
}
inline void launchComputeTileRHS_AMR(
    GPUNode2D* nodes, int* active_node_ids, int active_leaves_count,
    AMRPrimitiveTileT<double>* states_pool, AMRConservativeTileT<double>* dU_pool,
    AMRFaceFluxT<double>* node_boundary_fluxes, double A_coeff, double dt, double gamma, MultiMat::MaterialSet mat,
    bool is_ideal_gas, double dr_base, double dz_base, int order) {
    computeTileRHS_AMR_kernel<double><<<active_leaves_count, dim3(16, 16)>>>(
        nodes, active_node_ids, active_leaves_count, states_pool, dU_pool, node_boundary_fluxes, A_coeff, dt, gamma, mat, is_ideal_gas, dr_base, dz_base, order);
}

inline void launchUpdateConservativeRKStage_AMR(
    int count, int* active_tile_ids, AMRConservativeTileT<float>* U_pool,
    AMRConservativeTileT<float>* dU_pool, float dt) {
    updateConservativeRKStage_AMR_kernel<float><<<count, dim3(16, 16)>>>(active_tile_ids, count, U_pool, dU_pool, dt);
}
inline void launchUpdateConservativeRKStage_AMR(
    int count, int* active_tile_ids, AMRConservativeTileT<double>* U_pool,
    AMRConservativeTileT<double>* dU_pool, double dt) {
    updateConservativeRKStage_AMR_kernel<double><<<count, dim3(16, 16)>>>(active_tile_ids, count, U_pool, dU_pool, dt);
}

inline void launchApplyFluxCorrectionGPU(
    int flux_blocks, GPUNode2D* nodes, int* active_node_ids, int active_leaves_count,
    AMRConservativeTileT<float>* U_pool, AMRFaceFluxT<float>* node_boundary_fluxes,
    double B_coeff, double dt, double dr_base, double dz_base, bool is_cartesian) {
    applyFluxCorrectionGPU_kernel<float><<<flux_blocks, 256>>>(
        nodes, active_node_ids, active_leaves_count, U_pool, node_boundary_fluxes, B_coeff, dt, dr_base, dz_base, is_cartesian);
}
inline void launchApplyFluxCorrectionGPU(
    int flux_blocks, GPUNode2D* nodes, int* active_node_ids, int active_leaves_count,
    AMRConservativeTileT<double>* U_pool, AMRFaceFluxT<double>* node_boundary_fluxes,
    double B_coeff, double dt, double dr_base, double dz_base, bool is_cartesian) {
    applyFluxCorrectionGPU_kernel<double><<<flux_blocks, 256>>>(
        nodes, active_node_ids, active_leaves_count, U_pool, node_boundary_fluxes, B_coeff, dt, dr_base, dz_base, is_cartesian);
}

inline void launchUpdatePrimitiveFromConservative_AMR(
    int* active_tile_ids, int active_leaves_count,
    AMRConservativeTileT<float>* U_pool, AMRPrimitiveTileT<float>* states_pool,
    float gamma, MultiMat::MaterialSet mat, bool is_ideal_gas, float ambient_rho, float ambient_p) {
    updatePrimitiveFromConservative_AMR_kernel<float><<<active_leaves_count, dim3(16, 16)>>>(
        active_tile_ids, active_leaves_count, U_pool, states_pool, gamma, mat, is_ideal_gas, ambient_rho, ambient_p);
}
inline void launchUpdatePrimitiveFromConservative_AMR(
    int* active_tile_ids, int active_leaves_count,
    AMRConservativeTileT<double>* U_pool, AMRPrimitiveTileT<double>* states_pool,
    double gamma, MultiMat::MaterialSet mat, bool is_ideal_gas, double ambient_rho, double ambient_p) {
    updatePrimitiveFromConservative_AMR_kernel<double><<<active_leaves_count, dim3(16, 16)>>>(
        active_tile_ids, active_leaves_count, U_pool, states_pool, gamma, mat, is_ideal_gas, ambient_rho, ambient_p);
}

inline void launchRestrictNode_AMR(
    GPUNode2D* nodes, int* parent_node_ids, int count, AMRConservativeTileT<float>* U_pool, double dr_base, bool is_cartesian) {
    restrictNode_AMR_kernel<float><<<count, dim3(16, 16)>>>(nodes, parent_node_ids, count, U_pool, dr_base, is_cartesian);
}
inline void launchRestrictNode_AMR(
    GPUNode2D* nodes, int* parent_node_ids, int count, AMRConservativeTileT<double>* U_pool, double dr_base, bool is_cartesian) {
    restrictNode_AMR_kernel<double><<<count, dim3(16, 16)>>>(nodes, parent_node_ids, count, U_pool, dr_base, is_cartesian);
}

inline void launchComputeTileLoehnerError_AMR(
    const GPUNode2D* nodes, const int* active_node_ids, int active_leaves_count,
    const AMRPrimitiveTileT<float>* states_pool, float* tile_errors) {
    computeTileLoehnerError_AMR_kernel<float><<<active_leaves_count, dim3(16, 16)>>>(
        nodes, active_node_ids, active_leaves_count, states_pool, tile_errors);
}
inline void launchComputeTileLoehnerError_AMR(
    const GPUNode2D* nodes, const int* active_node_ids, int active_leaves_count,
    const AMRPrimitiveTileT<double>* states_pool, float* tile_errors) {
    computeTileLoehnerError_AMR_kernel<double><<<active_leaves_count, dim3(16, 16)>>>(
        nodes, active_node_ids, active_leaves_count, states_pool, tile_errors);
}

inline void launchProlongateChildTiles_AMR(
    int count, const RefineJobGPU* refine_jobs, AMRConservativeTileT<float>* U_pool) {
    prolongateChildTiles_AMR_kernel<float><<<count, dim3(16, 16)>>>(refine_jobs, count, U_pool);
}
inline void launchProlongateChildTiles_AMR(
    int count, const RefineJobGPU* refine_jobs, AMRConservativeTileT<double>* U_pool) {
    prolongateChildTiles_AMR_kernel<double><<<count, dim3(16, 16)>>>(refine_jobs, count, U_pool);
}

// --------------------------------------------------------------------------------------
// Host Class Methods for CFDSolver2DAMRCudaImpl
// --------------------------------------------------------------------------------------

template <typename RealType>
CFDSolver2DAMRCudaImpl<RealType>::CFDSolver2DAMRCudaImpl(int nr, int nz, double max_r, double max_z, double gamma, int max_levels, double threshold, double coarsen_ratio)
    : level0_nr(nr), level0_nz(nz), max_r_coord(max_r), max_z_coord(max_z),
      time_val(0.0), gamma_val(gamma), is_ideal_gas_val(true), is_cartesian_val(false),
      amr_max_levels_val(max_levels), amr_threshold_val(threshold), amr_coarsen_ratio_val(coarsen_ratio),
      flux_scheme_name("AUSM+"), spatial_order_val(2), temporal_order_val(2),
      bc_r_min(static_cast<CFDSolver2DCuda::BCType>(CFDSolver2D::REFLECTIVE)),
      bc_r_max(static_cast<CFDSolver2DCuda::BCType>(CFDSolver2D::OUTFLOW_RIEMANN)),
      bc_z_min(static_cast<CFDSolver2DCuda::BCType>(CFDSolver2D::REFLECTIVE)),
      bc_z_max(static_cast<CFDSolver2DCuda::BCType>(CFDSolver2D::OUTFLOW_RIEMANN)),
      ambient_rho_val(1.225), ambient_p_val(101325.0), detonator_r_coord(0.0), detonator_z_coord(0.0),
      d_states_pool(nullptr), d_U_pool(nullptr), d_dU_pool(nullptr), allocated_tiles_capacity(0),
      d_active_node_ids(nullptr), d_active_tile_ids(nullptr), active_leaves_count(0),
      d_allocated_node_ids(nullptr), d_allocated_tile_ids(nullptr), allocated_nodes_count(0),
      current_active_capacity(0), current_allocated_capacity(0), current_tree_capacity(0),
       d_level_parent_node_ids(nullptr), d_level_parent_offsets(nullptr), d_level_parent_counts(nullptr), current_level_parent_capacity(0),
       d_tile_min_dts(nullptr), d_global_min_dt(nullptr), current_tile_dts_capacity(0), adapt_step_counter(0), d_amr_nodes(nullptr) {

    level0_num_tiles_r = (nr + TILE_SIZE - 1) / TILE_SIZE;
    dr_base = max_r / (level0_num_tiles_r * TILE_SIZE);
    
    // Enforce square base cell aspect ratio (dz = dr)
    dz_base = dr_base;
    level0_num_tiles_z = std::max(1, (int)std::round(max_z / (dz_base * TILE_SIZE)));
    max_z_coord = level0_num_tiles_z * TILE_SIZE * dz_base;

    // Allocate Level 0 grid on host
    for (int r = 0; r < level0_num_tiles_r; ++r) {
        for (int z = 0; z < level0_num_tiles_z; ++z) {
            AMRTileNode node;
            node.tile_id = allocateTile();
            node.level = 0;
            node.parent = -1;
            std::fill(std::begin(node.children), std::end(node.children), -1);
            std::fill(std::begin(node.neighbors), std::end(node.neighbors), -1);
            node.r_min = r * TILE_SIZE * dr_base;
            node.r_max = (r + 1) * TILE_SIZE * dr_base;
            node.z_min = z * TILE_SIZE * dz_base;
            node.z_max = (z + 1) * TILE_SIZE * dz_base;
            node.r_idx = r;
            node.z_idx = z;
            node.is_active = true;
            amr_nodes.push_back(node);
        }
    }

    rebuildNeighborPointers();
}

template <typename RealType>
CFDSolver2DAMRCudaImpl<RealType>::~CFDSolver2DAMRCudaImpl() {
    if (d_states_pool) checkCudaError(cudaFree(d_states_pool));
    if (d_U_pool) checkCudaError(cudaFree(d_U_pool));
    if (d_dU_pool) checkCudaError(cudaFree(d_dU_pool));
    if (d_active_node_ids) checkCudaError(cudaFree(d_active_node_ids));
    if (d_active_tile_ids) checkCudaError(cudaFree(d_active_tile_ids));
    if (d_allocated_node_ids) checkCudaError(cudaFree(d_allocated_node_ids));
    if (d_allocated_tile_ids) checkCudaError(cudaFree(d_allocated_tile_ids));
    if (d_amr_nodes) checkCudaError(cudaFree(d_amr_nodes));
    if (d_node_boundary_fluxes) checkCudaError(cudaFree(d_node_boundary_fluxes));
    if (d_level_parent_node_ids) checkCudaError(cudaFree(d_level_parent_node_ids));
    if (d_level_parent_offsets) checkCudaError(cudaFree(d_level_parent_offsets));
    if (d_level_parent_counts) checkCudaError(cudaFree(d_level_parent_counts));
    if (d_tile_min_dts) checkCudaError(cudaFree(d_tile_min_dts));
    if (d_global_min_dt) checkCudaError(cudaFree(d_global_min_dt));
    if (host_pinned_min_dt) checkCudaError(cudaFreeHost(host_pinned_min_dt));
    if (d_tile_errors) checkCudaError(cudaFree(d_tile_errors));
    if (host_pinned_tile_errors) checkCudaError(cudaFreeHost(host_pinned_tile_errors));
    for (auto& lvl : level_active_tiles) {
        if (lvl.d_tile_ids) checkCudaError(cudaFree(lvl.d_tile_ids));
        if (lvl.d_node_ids) checkCudaError(cudaFree(lvl.d_node_ids));
    }
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::growTilePoolsGPU() {
    if (states_pool.size() <= allocated_tiles_capacity) return;

    size_t old_cap = allocated_tiles_capacity;
    size_t new_cap = states_pool.size() * 2;

    AMRPrimitiveTileT<RealType>* new_d_states = nullptr;
    AMRConservativeTileT<RealType>* new_d_U = nullptr;
    AMRConservativeTileT<RealType>* new_d_dU = nullptr;

    checkCudaError(cudaMalloc(&new_d_states, new_cap * sizeof(AMRPrimitiveTileT<RealType>)));
    checkCudaError(cudaMalloc(&new_d_U, new_cap * sizeof(AMRConservativeTileT<RealType>)));
    checkCudaError(cudaMalloc(&new_d_dU, new_cap * sizeof(AMRConservativeTileT<RealType>)));

    if (old_cap > 0 && d_states_pool) {
        checkCudaError(cudaMemcpy(new_d_states, d_states_pool, old_cap * sizeof(AMRPrimitiveTileT<RealType>), cudaMemcpyDeviceToDevice));
        checkCudaError(cudaMemcpy(new_d_U, d_U_pool, old_cap * sizeof(AMRConservativeTileT<RealType>), cudaMemcpyDeviceToDevice));
        checkCudaError(cudaMemcpy(new_d_dU, d_dU_pool, old_cap * sizeof(AMRConservativeTileT<RealType>), cudaMemcpyDeviceToDevice));

        checkCudaError(cudaFree(d_states_pool));
        checkCudaError(cudaFree(d_U_pool));
        checkCudaError(cudaFree(d_dU_pool));
    }

    d_states_pool = new_d_states;
    d_U_pool = new_d_U;
    d_dU_pool = new_d_dU;
    allocated_tiles_capacity = new_cap;
}

template <typename RealType>
int CFDSolver2DAMRCudaImpl<RealType>::allocateTile() {
    int id;
    if (!free_tile_ids.empty()) {
        id = free_tile_ids.back();
        free_tile_ids.pop_back();
    } else {
        id = states_pool.size();
        states_pool.emplace_back();
        U_pool.emplace_back();
        dU_pool.emplace_back();
    }

    auto& S = states_pool[id];
    auto& U = U_pool[id];
    auto& dU = dU_pool[id];

    for (int k = 0; k < AMR_TILE_DIM * AMR_TILE_DIM; ++k) {
        S.rho[k] = (RealType)ambient_rho_val;
        S.ur[k] = 0.0;
        S.uz[k] = 0.0;
        S.p[k] = (RealType)ambient_p_val;
        S.E[k] = (RealType)(ambient_p_val / (gamma_val - 1.0));
        S.alpha1[k] = 0.0;
        S.alpha2[k] = 0.0;
        S.arho1[k] = 0.0;
        S.arho2[k] = 0.0;
        S.floor_status[k] = 0;

        U.rho[k] = (RealType)ambient_rho_val;
        U.rhour[k] = 0.0;
        U.rhouz[k] = 0.0;
        U.E[k] = (RealType)(ambient_p_val / (gamma_val - 1.0));
        U.alpha1[k] = 0.0;
        U.alpha2[k] = 0.0;
        U.arho1[k] = 0.0;
        U.arho2[k] = 0.0;

        dU.rho[k] = 0.0;
        dU.rhour[k] = 0.0;
        dU.rhouz[k] = 0.0;
        dU.E[k] = 0.0;
        dU.alpha1[k] = 0.0;
        dU.alpha2[k] = 0.0;
        dU.arho1[k] = 0.0;
        dU.arho2[k] = 0.0;
    }
    return id;
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::freeTile(int tile_id) {
    free_tile_ids.push_back(tile_id);
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::rebuildNeighborPointers() {
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        if (amr_nodes[n].tile_id == -1 && amr_nodes[n].children[0] == -1) continue;
        for (int d = 0; d < 4; ++d) {
            amr_nodes[n].neighbors[d] = findNeighborNode(n, d);
        }
    }
}

template <typename RealType>
int CFDSolver2DAMRCudaImpl<RealType>::findNeighborNode(int node_idx, int dir) {
    const auto& node = amr_nodes[node_idx];
    if (node.level == 0) {
        int r = node.r_idx;
        int z = node.z_idx;
        if (dir == AMR_DIR_LEFT)   return (r > 0) ? (r - 1) * level0_num_tiles_z + z : -1;
        if (dir == AMR_DIR_RIGHT)  return (r < level0_num_tiles_r - 1) ? (r + 1) * level0_num_tiles_z + z : -1;
        if (dir == AMR_DIR_BOTTOM) return (z > 0) ? r * level0_num_tiles_z + (z - 1) : -1;
        if (dir == AMR_DIR_TOP)    return (z < level0_num_tiles_z - 1) ? r * level0_num_tiles_z + (z + 1) : -1;
        return -1;
    }

    int parent_idx = node.parent;
    int child_quadrant = -1;
    for (int c = 0; c < 4; ++c) {
        if (amr_nodes[parent_idx].children[c] == node_idx) {
            child_quadrant = c;
            break;
        }
    }

    if (dir == AMR_DIR_LEFT) {
        if (child_quadrant == 1) return amr_nodes[parent_idx].children[0];
        if (child_quadrant == 3) return amr_nodes[parent_idx].children[2];
    }
    if (dir == AMR_DIR_RIGHT) {
        if (child_quadrant == 0) return amr_nodes[parent_idx].children[1];
        if (child_quadrant == 2) return amr_nodes[parent_idx].children[3];
    }
    if (dir == AMR_DIR_BOTTOM) {
        if (child_quadrant == 2) return amr_nodes[parent_idx].children[0];
        if (child_quadrant == 3) return amr_nodes[parent_idx].children[1];
    }
    if (dir == AMR_DIR_TOP) {
        if (child_quadrant == 0) return amr_nodes[parent_idx].children[2];
        if (child_quadrant == 1) return amr_nodes[parent_idx].children[3];
    }

    int nb_parent = findNeighborNode(parent_idx, dir);
    if (nb_parent == -1) return -1;

    const auto& nb_node = amr_nodes[nb_parent];
    if (nb_node.children[0] == -1) {
        return nb_parent;
    }

    if (dir == AMR_DIR_LEFT) {
        if (child_quadrant == 0) return nb_node.children[1];
        if (child_quadrant == 2) return nb_node.children[3];
    }
    if (dir == AMR_DIR_RIGHT) {
        if (child_quadrant == 1) return nb_node.children[0];
        if (child_quadrant == 3) return nb_node.children[2];
    }
    if (dir == AMR_DIR_BOTTOM) {
        if (child_quadrant == 0) return nb_node.children[2];
        if (child_quadrant == 1) return nb_node.children[3];
    }
    if (dir == AMR_DIR_TOP) {
        if (child_quadrant == 2) return nb_node.children[0];
        if (child_quadrant == 3) return nb_node.children[1];
    }
    return -1;
}

template <typename RealType>
int CFDSolver2DAMRCudaImpl<RealType>::findNodeByCoords(int r_idx, int z_idx, int level) {
    if (r_idx < 0 || r_idx >= (level0_num_tiles_r << level) ||
        z_idx < 0 || z_idx >= (level0_num_tiles_z << level)) {
        return -1;
    }
    int r0 = r_idx >> level;
    int z0 = z_idx >> level;
    int curr = r0 * level0_num_tiles_z + z0;
    if (curr < 0 || curr >= (int)amr_nodes.size()) return -1;

    for (int l = 0; l < level; ++l) {
        if (amr_nodes[curr].children[0] == -1) {
            return curr;
        }
        int shift = level - 1 - l;
        int bit_r = (r_idx >> shift) & 1;
        int bit_z = (z_idx >> shift) & 1;
        int quadrant = bit_r + 2 * bit_z;
        curr = amr_nodes[curr].children[quadrant];
        if (curr == -1) return -1;
    }
    return curr;
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::syncPoolsToGPU() {
    if (states_pool.size() > allocated_tiles_capacity) {
        if (d_states_pool) checkCudaError(cudaFree(d_states_pool));
        if (d_U_pool) checkCudaError(cudaFree(d_U_pool));
        if (d_dU_pool) checkCudaError(cudaFree(d_dU_pool));

        allocated_tiles_capacity = states_pool.size() * 2;
        checkCudaError(cudaMalloc(&d_states_pool, allocated_tiles_capacity * sizeof(AMRPrimitiveTileT<RealType>)));
        checkCudaError(cudaMalloc(&d_U_pool, allocated_tiles_capacity * sizeof(AMRConservativeTileT<RealType>)));
        checkCudaError(cudaMalloc(&d_dU_pool, allocated_tiles_capacity * sizeof(AMRConservativeTileT<RealType>)));
    }

    checkCudaError(cudaMemcpy(d_states_pool, states_pool.data(), states_pool.size() * sizeof(AMRPrimitiveTileT<RealType>), cudaMemcpyHostToDevice));
    checkCudaError(cudaMemcpy(d_U_pool, U_pool.data(), U_pool.size() * sizeof(AMRConservativeTileT<RealType>), cudaMemcpyHostToDevice));
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::syncPoolsToCPU() {
    if (!d_states_pool || states_pool.empty()) return;
    checkCudaError(cudaMemcpy(states_pool.data(), d_states_pool, states_pool.size() * sizeof(AMRPrimitiveTileT<RealType>), cudaMemcpyDeviceToHost));
    checkCudaError(cudaMemcpy(U_pool.data(), d_U_pool, U_pool.size() * sizeof(AMRConservativeTileT<RealType>), cudaMemcpyDeviceToHost));
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::syncTreeToGPU() {
    std::vector<GPUNode2D> gpu_nodes(amr_nodes.size());
    std::vector<int> active_node_ids;
    std::vector<int> active_tile_ids;
    std::vector<int> allocated_node_ids;
    std::vector<int> allocated_tile_ids;

    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        gpu_nodes[n].tile_id = amr_nodes[n].tile_id;
        gpu_nodes[n].level = amr_nodes[n].level;
        std::copy(std::begin(amr_nodes[n].neighbors), std::end(amr_nodes[n].neighbors), gpu_nodes[n].neighbors);
        std::copy(std::begin(amr_nodes[n].children), std::end(amr_nodes[n].children), gpu_nodes[n].children);
        gpu_nodes[n].r_min = amr_nodes[n].r_min;
        gpu_nodes[n].z_min = amr_nodes[n].z_min;
        gpu_nodes[n].r_idx = amr_nodes[n].r_idx;
        gpu_nodes[n].z_idx = amr_nodes[n].z_idx;

        if (amr_nodes[n].tile_id != -1) {
            allocated_node_ids.push_back(n);
            allocated_tile_ids.push_back(amr_nodes[n].tile_id);
            if (amr_nodes[n].is_active) {
                active_node_ids.push_back(n);
                active_tile_ids.push_back(amr_nodes[n].tile_id);
            }
        }
    }

    active_leaves_count = active_node_ids.size();
    allocated_nodes_count = allocated_node_ids.size();

    // Reallocate active lists on GPU if needed
    
    if (active_leaves_count > (int)current_active_capacity) {
        if (d_active_node_ids) checkCudaError(cudaFree(d_active_node_ids));
        if (d_active_tile_ids) checkCudaError(cudaFree(d_active_tile_ids));
        current_active_capacity = active_leaves_count * 2;
        checkCudaError(cudaMalloc(&d_active_node_ids, current_active_capacity * sizeof(int)));
        checkCudaError(cudaMalloc(&d_active_tile_ids, current_active_capacity * sizeof(int)));
    }

    // Reallocate allocated lists on GPU if needed
    
    if (allocated_nodes_count > (int)current_allocated_capacity) {
        if (d_allocated_node_ids) checkCudaError(cudaFree(d_allocated_node_ids));
        if (d_allocated_tile_ids) checkCudaError(cudaFree(d_allocated_tile_ids));
        current_allocated_capacity = allocated_nodes_count * 2;
        checkCudaError(cudaMalloc(&d_allocated_node_ids, current_allocated_capacity * sizeof(int)));
        checkCudaError(cudaMalloc(&d_allocated_tile_ids, current_allocated_capacity * sizeof(int)));
    }

        
    if (amr_nodes.size() > current_tree_capacity) {
        if (d_amr_nodes) checkCudaError(cudaFree(d_amr_nodes));
        if (d_node_boundary_fluxes) checkCudaError(cudaFree(d_node_boundary_fluxes));
        current_tree_capacity = amr_nodes.size() * 2;
        checkCudaError(cudaMalloc(&d_amr_nodes, current_tree_capacity * sizeof(GPUNode2D)));
        checkCudaError(cudaMalloc(&d_node_boundary_fluxes, current_tree_capacity * 4 * sizeof(AMRFaceFluxT<RealType>)));
        checkCudaError(cudaMemset(d_node_boundary_fluxes, 0, current_tree_capacity * 4 * sizeof(AMRFaceFluxT<RealType>)));
    }

    checkCudaError(cudaMemcpy(d_amr_nodes, gpu_nodes.data(), gpu_nodes.size() * sizeof(GPUNode2D), cudaMemcpyHostToDevice));
    checkCudaError(cudaMemcpy(d_active_node_ids, active_node_ids.data(), active_leaves_count * sizeof(int), cudaMemcpyHostToDevice));
    checkCudaError(cudaMemcpy(d_active_tile_ids, active_tile_ids.data(), active_leaves_count * sizeof(int), cudaMemcpyHostToDevice));
    checkCudaError(cudaMemcpy(d_allocated_node_ids, allocated_node_ids.data(), allocated_nodes_count * sizeof(int), cudaMemcpyHostToDevice));
    checkCudaError(cudaMemcpy(d_allocated_tile_ids, allocated_tile_ids.data(), allocated_nodes_count * sizeof(int), cudaMemcpyHostToDevice));

    // Precalculate persistent level parent arrays for fast GPU restriction
    h_level_parent_offsets_cached.assign(amr_max_levels_val, 0);
    h_level_parent_counts_cached.assign(amr_max_levels_val, 0);
    std::vector<int> h_all_level_parents;

    for (int lvl = amr_max_levels_val - 2; lvl >= 0; --lvl) {
        h_level_parent_offsets_cached[lvl] = (int)h_all_level_parents.size();
        int count = 0;
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            if (amr_nodes[n].level == lvl && amr_nodes[n].children[0] != -1) {
                h_all_level_parents.push_back((int)n);
                count++;
            }
        }
        h_level_parent_counts_cached[lvl] = count;
    }

    if (h_all_level_parents.size() > current_level_parent_capacity) {
        if (d_level_parent_node_ids) checkCudaError(cudaFree(d_level_parent_node_ids));
        current_level_parent_capacity = std::max((size_t)1, h_all_level_parents.size() * 2);
        checkCudaError(cudaMalloc(&d_level_parent_node_ids, current_level_parent_capacity * sizeof(int)));
    }

    if (!h_all_level_parents.empty()) {
        checkCudaError(cudaMemcpy(d_level_parent_node_ids, h_all_level_parents.data(), h_all_level_parents.size() * sizeof(int), cudaMemcpyHostToDevice));
    }

    // Populate level_active_tiles for level subcycling
    level_active_tiles.resize(amr_max_levels_val);
    std::vector<std::vector<int>> h_level_active_tile_ids(amr_max_levels_val);
    std::vector<std::vector<int>> h_level_active_node_ids(amr_max_levels_val);

    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        if (amr_nodes[n].tile_id != -1 && amr_nodes[n].is_active) {
            int lvl = amr_nodes[n].level;
            if (lvl >= 0 && lvl < amr_max_levels_val) {
                h_level_active_tile_ids[lvl].push_back(amr_nodes[n].tile_id);
                h_level_active_node_ids[lvl].push_back((int)n);
            }
        }
    }

    for (int lvl = 0; lvl < amr_max_levels_val; ++lvl) {
        int cnt = (int)h_level_active_tile_ids[lvl].size();
        level_active_tiles[lvl].count = cnt;
        if ((size_t)cnt > level_active_tiles[lvl].capacity) {
            if (level_active_tiles[lvl].d_tile_ids) checkCudaError(cudaFree(level_active_tiles[lvl].d_tile_ids));
            if (level_active_tiles[lvl].d_node_ids) checkCudaError(cudaFree(level_active_tiles[lvl].d_node_ids));
            level_active_tiles[lvl].capacity = std::max((size_t)1, (size_t)cnt * 2);
            checkCudaError(cudaMalloc(&level_active_tiles[lvl].d_tile_ids, level_active_tiles[lvl].capacity * sizeof(int)));
            checkCudaError(cudaMalloc(&level_active_tiles[lvl].d_node_ids, level_active_tiles[lvl].capacity * sizeof(int)));
        }
        if (cnt > 0) {
            checkCudaError(cudaMemcpy(level_active_tiles[lvl].d_tile_ids, h_level_active_tile_ids[lvl].data(), cnt * sizeof(int), cudaMemcpyHostToDevice));
            checkCudaError(cudaMemcpy(level_active_tiles[lvl].d_node_ids, h_level_active_node_ids[lvl].data(), cnt * sizeof(int), cudaMemcpyHostToDevice));
        }
    }
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::fillGhostCellsGPU() {
    launchFillGhostCells_AMR(
        this->d_amr_nodes, (int)this->amr_nodes.size(), this->level0_num_tiles_r, this->level0_num_tiles_z,
        this->d_allocated_node_ids, this->allocated_nodes_count, this->d_states_pool,
        this->bc_r_min, this->bc_r_max, this->bc_z_min, this->bc_z_max,
        (RealType)this->ambient_rho_val, (RealType)this->ambient_p_val, (RealType)this->gamma_val,
        this->materials_val, this->is_ideal_gas_val, this->dr_base, this->dz_base
    );
}

template <typename RealType>
__global__ void applyFluxCorrectionGPU_kernel(
    GPUNode2D* nodes,
    int* active_node_ids,
    int active_leaves_count,
    AMRConservativeTileT<RealType>* U_pool,
    AMRFaceFluxT<RealType>* node_boundary_fluxes,
    double B_coeff,
    double dt,
    double dr_base,
    double dz_base,
    bool is_cartesian)
{
    int tid = blockIdx.x * blockDim.x + threadIdx.x;
    if (tid >= active_leaves_count * 4 * 16) return;

    int n_idx = tid / (4 * 16);
    int d_and_c = tid % (4 * 16);
    int d = d_and_c / 16;
    int c = d_and_c % 16;

    int node_idx = active_node_ids[n_idx];
    const auto& node = nodes[node_idx];
    int nb_idx = node.neighbors[d];
    if (nb_idx == -1) return;

    const auto& nb_node = nodes[nb_idx];
    if (nb_node.children[0] != -1) {
        RealType sign = (d == 1 || d == 3) ? (RealType)1.0 : (RealType)-1.0;

        int child1 = -1, child2 = -1;
        int fine_dir = -1;
        if (d == 0) {
            child1 = nb_node.children[1]; child2 = nb_node.children[3]; fine_dir = 1;
        } else if (d == 1) {
            child1 = nb_node.children[0]; child2 = nb_node.children[2]; fine_dir = 0;
        } else if (d == 2) {
            child1 = nb_node.children[2]; child2 = nb_node.children[3]; fine_dir = 3;
        } else if (d == 3) {
            child1 = nb_node.children[0]; child2 = nb_node.children[1]; fine_dir = 2;
        }

        if (child1 == -1 || child2 == -1) return;

        int fc1 = (c * 2);
        int fc2 = (c * 2) + 1;
        int f_idx1 = fc1 % 16;
        int f_idx2 = fc2 % 16;
        int fine_node_idx = (fc1 < 16) ? child1 : child2;
        if (nodes[fine_node_idx].children[0] != -1) return;

        const auto& f_flux = node_boundary_fluxes[fine_node_idx * 4 + fine_dir];

        int ci = (d == 0) ? 2 : ((d == 1) ? 17 : c + 2);
        int cj = (d == 2) ? 2 : ((d == 3) ? 17 : c + 2);
        int ck = ci * 20 + cj;

        const auto& c_flux = node_boundary_fluxes[node_idx * 4 + d];

        double factor = 1.0 / (1 << node.level);
        RealType dr_c = (RealType)(dr_base * factor);
        RealType dz_c = (RealType)(dz_base * factor);

        RealType r_c = (RealType)(node.r_min + (ci - 2 + 0.5) * dr_c);
        RealType r_face = (RealType)(node.r_min + ((d == 0) ? 0.0 : ((d == 1) ? 16.0 : (ci - 2 + 0.5))) * dr_c);
        RealType r_f1 = (RealType)(node.r_min + ((d == 0 || d == 1) ? ((d == 0) ? 0.0 : 16.0) * dr_c : (fc1 + 0.5) * 0.5 * dr_c));
        RealType r_f2 = (RealType)(node.r_min + ((d == 0 || d == 1) ? ((d == 0) ? 0.0 : 16.0) * dr_c : (fc2 + 0.5) * 0.5 * dr_c));

        #define CORRECT(field) \
        { \
            RealType fine_sum; \
            if (d == 0 || d == 1) { \
                fine_sum = (RealType)0.5 * (f_flux.field[f_idx1] + f_flux.field[f_idx2]); \
                RealType r_scale = is_cartesian ? (RealType)1.0 : (r_face / r_c); \
                atomicAdd(&U_pool[node.tile_id].field[ck], (RealType)B_coeff * sign * (RealType)(dt / dr_c) * r_scale * (c_flux.field[c] - fine_sum)); \
            } else { \
                if (is_cartesian) { \
                    fine_sum = (RealType)0.5 * (f_flux.field[f_idx1] + f_flux.field[f_idx2]); \
                } else { \
                    fine_sum = (RealType)0.5 * (f_flux.field[f_idx1] * r_f1 + f_flux.field[f_idx2] * r_f2) / r_c; \
                } \
                atomicAdd(&U_pool[node.tile_id].field[ck], (RealType)B_coeff * sign * (RealType)(dt / dz_c) * (c_flux.field[c] - fine_sum)); \
            } \
        }

        CORRECT(rho) CORRECT(rhour) CORRECT(rhouz) CORRECT(E) CORRECT(alpha1) CORRECT(alpha2) CORRECT(arho1) CORRECT(arho2)
        #undef CORRECT
    }
}



template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::computeRHSGPU(double A_coeff, double dt) {
    launchComputeTileRHS_AMR(
        this->d_amr_nodes, this->d_active_node_ids, this->active_leaves_count, this->d_states_pool, this->d_dU_pool, this->d_node_boundary_fluxes,
        (RealType)A_coeff, (RealType)dt, (RealType)this->gamma_val, this->materials_val, this->is_ideal_gas_val,
        this->dr_base, this->dz_base, this->spatial_order_val
    );
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::applyLSRK3StepGPU(int stage, double dt, int target_level) {
    const double A[3] = {0.0, -5.0/9.0, -153.0/128.0};
    const double B[3] = {1.0/3.0, 15.0/16.0, 8.0/15.0};

    restrictAllGPU();
    updatePrimitiveGPU();

    fillGhostCellsGPU();
    computeRHSGPU(A[stage], dt);

    if (target_level >= 0 && target_level < amr_max_levels_val) {
        int cnt = level_active_tiles[target_level].count;
        if (cnt > 0) {
            launchUpdateConservativeRKStage_AMR(
                cnt, level_active_tiles[target_level].d_tile_ids, this->d_U_pool, this->d_dU_pool, (RealType)B[stage]
            );
        }
    } else {
        launchUpdateConservativeRKStage_AMR(
            this->active_leaves_count, this->d_active_tile_ids, this->d_U_pool, this->d_dU_pool, (RealType)B[stage]
        );
    }

    int total_flux_threads = active_leaves_count * 4 * 16;
    int flux_blocks = (total_flux_threads + 255) / 256;
    if (flux_blocks > 0) {
        launchApplyFluxCorrectionGPU(
            flux_blocks,
            this->d_amr_nodes,
            this->d_active_node_ids,
            this->active_leaves_count,
            this->d_U_pool,
            this->d_node_boundary_fluxes,
            B[stage],
            dt,
            this->dr_base,
            this->dz_base,
            this->is_cartesian_val
        );
    }
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::updatePrimitiveGPU() {
    launchUpdatePrimitiveFromConservative_AMR(
        this->d_allocated_tile_ids, this->allocated_nodes_count, this->d_U_pool, this->d_states_pool,
        (RealType)this->gamma_val, this->materials_val, this->is_ideal_gas_val,
        (RealType)this->ambient_rho_val, (RealType)this->ambient_p_val
    );
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::restrictAllGPU() {
    if (!d_level_parent_node_ids || h_level_parent_counts_cached.empty()) return;

    for (int lvl = amr_max_levels_val - 2; lvl >= 0; --lvl) {
        int count = h_level_parent_counts_cached[lvl];
        if (count == 0) continue;
        int offset = h_level_parent_offsets_cached[lvl];

        launchRestrictNode_AMR(
            this->d_amr_nodes,
            this->d_level_parent_node_ids + offset,
            count,
            this->d_U_pool,
            this->dr_base,
            this->is_cartesian_val
        );
    }
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::restrictAllCPU() {
    syncPoolsToCPU();
    for (int lvl = amr_max_levels_val - 2; lvl >= 0; --lvl) {
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            if (amr_nodes[n].level == lvl && amr_nodes[n].children[0] != -1) {
                restrictNodeCPU(n);
            }
        }
    }
    syncPoolsToGPU();
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::restrictNodeCPU(int node_idx) {
    const auto& node = amr_nodes[node_idx];
    auto& U_parent = U_pool[node.tile_id];

    int child_bl = amr_nodes[node.children[0]].tile_id;
    int child_br = amr_nodes[node.children[1]].tile_id;
    int child_tl = amr_nodes[node.children[2]].tile_id;
    int child_tr = amr_nodes[node.children[3]].tile_id;

    // Only restrict internal cells (2 to 17). Ghost cells will be updated by fillGhostCells.
    for (int pi = 2; pi < 18; ++pi) {
        int child_tile_r = (pi >= 10) ? 1 : 0;
        int local_pi = (pi < 10) ? (pi - 2) : (pi - 10);
        int ci1 = 2 * local_pi + 2;
        int ci2 = 2 * local_pi + 3;

        for (int pj = 2; pj < 18; ++pj) {
            int pk = pi * AMR_TILE_DIM + pj;
            int child_tile_z = (pj >= 10) ? 2 : 0;
            int quadrant = child_tile_r + child_tile_z;

            int active_child_tile_id = -1;
            if (quadrant == 0) active_child_tile_id = child_bl;
            else if (quadrant == 1) active_child_tile_id = child_br;
            else if (quadrant == 2) active_child_tile_id = child_tl;
            else active_child_tile_id = child_tr;

            int local_pj = (pj < 10) ? (pj - 2) : (pj - 10);
            int cj1 = 2 * local_pj + 2;
            int cj2 = 2 * local_pj + 3;

            auto get_child_val = [&](int child_id, int local_i, int local_j, auto field) {
                int k = local_i * AMR_TILE_DIM + local_j;
                return (U_pool[child_id].*field)[k];
            };

            double factor = 1.0 / (1 << node.level);
            RealType dr_r = (RealType)(dr_base * factor);
            RealType r_P = (RealType)(node.r_min + (pi - 2 + 0.5) * dr_r);
            RealType w1, w2;
            if (is_cartesian_val) {
                w1 = (RealType)0.5;
                w2 = (RealType)0.5;
            } else {
                RealType w_calc = (RealType)(dr_r / (8.0 * r_P));
                w1 = std::max((RealType)0.05, std::min((RealType)0.95, (RealType)0.5 - w_calc));
                w2 = std::max((RealType)0.05, std::min((RealType)0.95, (RealType)0.5 + w_calc));
            }

            #define RESTRICT_FIELD(field) \
            { \
                RealType val_bl = get_child_val(active_child_tile_id, ci1, cj1, &AMRConservativeTileT<RealType>::field); \
                RealType val_br = get_child_val(active_child_tile_id, ci2, cj1, &AMRConservativeTileT<RealType>::field); \
                RealType val_tl = get_child_val(active_child_tile_id, ci1, cj2, &AMRConservativeTileT<RealType>::field); \
                RealType val_tr = get_child_val(active_child_tile_id, ci2, cj2, &AMRConservativeTileT<RealType>::field); \
                U_parent.field[pk] = (RealType)(0.5 * (w1 * (val_bl + val_tl) + w2 * (val_br + val_tr))); \
            }

            RESTRICT_FIELD(rho) RESTRICT_FIELD(rhour) RESTRICT_FIELD(rhouz)
            RESTRICT_FIELD(alpha1) RESTRICT_FIELD(alpha2) RESTRICT_FIELD(arho1) RESTRICT_FIELD(arho2)
            #undef RESTRICT_FIELD

            // Pressure-preserving internal energy restriction to prevent spurious pressure spikes on coarsening
            auto get_fine_internal_e_gpu = [&](int ci, int cj) {
                RealType rho_f = get_child_val(active_child_tile_id, ci, cj, &AMRConservativeTileT<RealType>::rho);
                RealType rhour_f = get_child_val(active_child_tile_id, ci, cj, &AMRConservativeTileT<RealType>::rhour);
                RealType rhouz_f = get_child_val(active_child_tile_id, ci, cj, &AMRConservativeTileT<RealType>::rhouz);
                RealType E_f = get_child_val(active_child_tile_id, ci, cj, &AMRConservativeTileT<RealType>::E);
                RealType rho_safe = std::max(rho_f, (RealType)1e-10);
                RealType ke_f = (RealType)0.5 * (rhour_f * rhour_f + rhouz_f * rhouz_f) / rho_safe;
                return E_f - ke_f;
            };

            RealType e_bl = get_fine_internal_e_gpu(ci1, cj1);
            RealType e_br = get_fine_internal_e_gpu(ci2, cj1);
            RealType e_tl = get_fine_internal_e_gpu(ci1, cj2);
            RealType e_tr = get_fine_internal_e_gpu(ci2, cj2);

            RealType e_internal_avg = (RealType)(0.5 * (w1 * (e_bl + e_tl) + w2 * (e_br + e_tr)));
            RealType parent_rho_safe = std::max(U_parent.rho[pk], (RealType)1e-10);
            RealType parent_ke = (RealType)0.5 * (U_parent.rhour[pk] * U_parent.rhour[pk] + U_parent.rhouz[pk] * U_parent.rhouz[pk]) / parent_rho_safe;

            U_parent.E[pk] = e_internal_avg + parent_ke;
        }
    }

    // Zero-order extrapolation on boundary to avoid garbage states in coarse neighbor
    for (int j = 0; j < 16; ++j) {
        // Left
        for (int gc = 0; gc < 2; ++gc) {
            int k_dest = gc * AMR_TILE_DIM + (j + 2);
            int k_src = 2 * AMR_TILE_DIM + (j + 2);
            U_parent.rho[k_dest] = U_parent.rho[k_src];
            U_parent.rhour[k_dest] = U_parent.rhour[k_src];
            U_parent.rhouz[k_dest] = U_parent.rhouz[k_src];
            U_parent.E[k_dest] = U_parent.E[k_src];
            U_parent.alpha1[k_dest] = U_parent.alpha1[k_src];
            U_parent.alpha2[k_dest] = U_parent.alpha2[k_src];
            U_parent.arho1[k_dest] = U_parent.arho1[k_src];
            U_parent.arho2[k_dest] = U_parent.arho2[k_src];
        }
        // Right
        for (int gc = 18; gc < 20; ++gc) {
            int k_dest = gc * AMR_TILE_DIM + (j + 2);
            int k_src = 17 * AMR_TILE_DIM + (j + 2);
            U_parent.rho[k_dest] = U_parent.rho[k_src];
            U_parent.rhour[k_dest] = U_parent.rhour[k_src];
            U_parent.rhouz[k_dest] = U_parent.rhouz[k_src];
            U_parent.E[k_dest] = U_parent.E[k_src];
            U_parent.alpha1[k_dest] = U_parent.alpha1[k_src];
            U_parent.alpha2[k_dest] = U_parent.alpha2[k_src];
            U_parent.arho1[k_dest] = U_parent.arho1[k_src];
            U_parent.arho2[k_dest] = U_parent.arho2[k_src];
        }
    }
    for (int i = 0; i < 20; ++i) {
        // Bottom
        for (int gc = 0; gc < 2; ++gc) {
            int k_dest = i * AMR_TILE_DIM + gc;
            int k_src = i * AMR_TILE_DIM + 2;
            U_parent.rho[k_dest] = U_parent.rho[k_src];
            U_parent.rhour[k_dest] = U_parent.rhour[k_src];
            U_parent.rhouz[k_dest] = U_parent.rhouz[k_src];
            U_parent.E[k_dest] = U_parent.E[k_src];
            U_parent.alpha1[k_dest] = U_parent.alpha1[k_src];
            U_parent.alpha2[k_dest] = U_parent.alpha2[k_src];
            U_parent.arho1[k_dest] = U_parent.arho1[k_src];
            U_parent.arho2[k_dest] = U_parent.arho2[k_src];
        }
        // Top
        for (int gc = 18; gc < 20; ++gc) {
            int k_dest = i * AMR_TILE_DIM + gc;
            int k_src = i * AMR_TILE_DIM + 17;
            U_parent.rho[k_dest] = U_parent.rho[k_src];
            U_parent.rhour[k_dest] = U_parent.rhour[k_src];
            U_parent.rhouz[k_dest] = U_parent.rhouz[k_src];
            U_parent.E[k_dest] = U_parent.E[k_src];
            U_parent.alpha1[k_dest] = U_parent.alpha1[k_src];
            U_parent.alpha2[k_dest] = U_parent.alpha2[k_src];
            U_parent.arho1[k_dest] = U_parent.arho1[k_src];
            U_parent.arho2[k_dest] = U_parent.arho2[k_src];
        }
    }

    auto& S_parent = states_pool[node.tile_id];
    for (int k = 0; k < AMR_TILE_DIM * AMR_TILE_DIM; ++k) {
        RealType r_rho = U_parent.rho[k];
        RealType r_rhour = U_parent.rhour[k];
        RealType r_rhouz = U_parent.rhouz[k];
        RealType r_E = U_parent.E[k];
        RealType r_a1 = U_parent.alpha1[k];
        RealType r_a2 = U_parent.alpha2[k];

        RealType rho_safe = std::max(r_rho, (RealType)1e-10);
        RealType ur = r_rhour / rho_safe;
        RealType uz = r_rhouz / rho_safe;
        RealType ke = (RealType)0.5 * rho_safe * (ur * ur + uz * uz);
        RealType e_int = std::max((RealType)1e-8, r_E - ke);

        RealType p;
        if (is_ideal_gas_val) {
            p = e_int * ((RealType)gamma_val - (RealType)1.0);
        } else {
            p = MultiMat::getMixturePressure(e_int, rho_safe, r_a1, r_a2, U_parent.arho1[k], U_parent.arho2[k], (RealType)gamma_val, materials_val.products, materials_val.unreacted);
        }

        S_parent.rho[k] = rho_safe;
        S_parent.ur[k] = ur;
        S_parent.uz[k] = uz;
        S_parent.p[k] = std::max((RealType)ambient_p_val, p);
        S_parent.E[k] = r_E;
        S_parent.alpha1[k] = r_a1;
        S_parent.alpha2[k] = r_a2;
        S_parent.arho1[k] = U_parent.arho1[k];
        S_parent.arho2[k] = U_parent.arho2[k];
    }
}

template <typename RealType>
double CFDSolver2DAMRCudaImpl<RealType>::computeTileLoehnerErrorCPU(int tile_id) const {
    if (tile_id == -1 || tile_id >= (int)states_pool.size()) return 0.0;
    const auto& S = states_pool[tile_id];

    // 1. Compute maximum single-cell neighbor relative jump across internal cells (i=2..17, j=2..17)
    double max_cell_jump = 0.0;

    for (int i = 2; i < 18; ++i) {
        for (int j = 2; j < 18; ++j) {
            int k   = i * AMR_TILE_DIM + j;
            int kr1 = (i + 1) * AMR_TILE_DIM + j;
            int kz1 = i * AMR_TILE_DIM + (j + 1);

            double p_c = (double)S.p[k];
            double rho_c = (double)S.rho[k];
            double a1_c = (double)S.alpha1[k];

            double p_r = (double)S.p[kr1];
            double rho_r = (double)S.rho[kr1];
            double a1_r = (double)S.alpha1[kr1];

            double p_z = (double)S.p[kz1];
            double rho_z = (double)S.rho[kz1];
            double a1_z = (double)S.alpha1[kz1];

            double jump_p = std::max(std::abs(p_r - p_c), std::abs(p_z - p_c)) / (p_c + 1e-5);
            double jump_rho = std::max(std::abs(rho_r - rho_c), std::abs(rho_z - rho_c)) / (rho_c + 1e-5);
            double jump_a1 = std::max(std::abs(a1_r - a1_c), std::abs(a1_z - a1_c));

            double cell_jump = std::max({jump_p, jump_rho, jump_a1});
            if (cell_jump > max_cell_jump) max_cell_jump = cell_jump;
        }
    }

    // Cell-level shock jump cutoff:
    // A true shock front or material interface has a cell-to-cell jump >= 3% (0.03).
    // Smooth expansion waves and ambient sound waves have cell-to-cell jumps < 0.5% (0.005).
    if (max_cell_jump < 0.03) {
        return 0.0;
    }

    const double eps = 0.02;
    double max_err = 0.0;

    for (int i = 3; i < 17; ++i) {
        for (int j = 3; j < 17; ++j) {
            int k = i * AMR_TILE_DIM + j;

            // Density Löhner Error
            double rho_c  = (double)S.rho[k];
            double rho_r1 = (double)S.rho[(i + 1) * AMR_TILE_DIM + j];
            double rho_l1 = (double)S.rho[(i - 1) * AMR_TILE_DIM + j];
            double rho_t1 = (double)S.rho[i * AMR_TILE_DIM + (j + 1)];
            double rho_b1 = (double)S.rho[i * AMR_TILE_DIM + (j - 1)];

            double d2_r_rho = std::abs(rho_r1 - 2.0 * rho_c + rho_l1);
            double d1_r_rho = std::abs(rho_r1 - rho_c) + std::abs(rho_c - rho_l1) + eps * std::abs(rho_c);
            double err_r_rho = d2_r_rho / (d1_r_rho + 1e-12);

            double d2_z_rho = std::abs(rho_t1 - 2.0 * rho_c + rho_b1);
            double d1_z_rho = std::abs(rho_t1 - rho_c) + std::abs(rho_c - rho_b1) + eps * std::abs(rho_c);
            double err_z_rho = d2_z_rho / (d1_z_rho + 1e-12);

            // Pressure Löhner Error
            double p_c  = (double)S.p[k];
            double p_r1 = (double)S.p[(i + 1) * AMR_TILE_DIM + j];
            double p_l1 = (double)S.p[(i - 1) * AMR_TILE_DIM + j];
            double p_t1 = (double)S.p[i * AMR_TILE_DIM + (j + 1)];
            double p_b1 = (double)S.p[i * AMR_TILE_DIM + (j - 1)];

            double d2_r_p = std::abs(p_r1 - 2.0 * p_c + p_l1);
            double d1_r_p = std::abs(p_r1 - p_c) + std::abs(p_c - p_l1) + eps * std::abs(p_c);
            double err_r_p = d2_r_p / (d1_r_p + 1e-12);

            double d2_z_p = std::abs(p_t1 - 2.0 * p_c + p_b1);
            double d1_z_p = std::abs(p_t1 - p_c) + std::abs(p_c - p_b1) + eps * std::abs(p_c);
            double err_z_p = d2_z_p / (d1_z_p + 1e-12);

            double cell_err = std::max({err_r_rho, err_z_rho, err_r_p, err_z_p});
            if (cell_err > max_err) max_err = cell_err;
        }
    }

    double shock_weight = std::min(1.0, max_cell_jump / 0.03);
    return max_err * shock_weight;
}

template <typename RealType>
bool CFDSolver2DAMRCudaImpl<RealType>::shouldRefineNodeCPU(int node_idx) {
    const auto& node = amr_nodes[node_idx];
    if (node.r_min >= max_r_coord || node.z_min >= max_z_coord) return false;
    if (node.level >= amr_max_levels_val - 1) return false;
    if (node.tile_id == -1) return false;

    double error = computeTileLoehnerErrorCPU(node.tile_id);
    return (error > amr_threshold_val);
}

template <typename RealType>
bool CFDSolver2DAMRCudaImpl<RealType>::shouldCoarsenNodeCPU(int parent_idx) {
    const auto& parent = amr_nodes[parent_idx];
    if (parent.tile_id == -1 || parent.children[0] == -1) return false;

    double max_child_err = 0.0;
    for (int c = 0; c < 4; ++c) {
        int child_idx = parent.children[c];
        if (child_idx == -1) return false;
        const auto& child = amr_nodes[child_idx];
        if (child.children[0] != -1) return false; // Child must be a leaf
        if (child.tile_id != -1) {
            double err = computeTileLoehnerErrorCPU(child.tile_id);
            if (err > max_child_err) max_child_err = err;
        }
    }

    double coarsen_threshold = amr_threshold_val * amr_coarsen_ratio_val;
    return (max_child_err < coarsen_threshold);
}

template <typename RealType>
int CFDSolver2DAMRCudaImpl<RealType>::findLeafNodeAtCoordsCPU(double r, double z) const {
    if (r < 0.0 || r >= max_r_coord || z < 0.0 || z >= max_z_coord) return -1;
    double tile_w = TILE_SIZE * dr_base;
    double tile_h = TILE_SIZE * dz_base;
    int r0 = (int)(r / tile_w);
    int z0 = (int)(z / tile_h);
    if (r0 < 0 || r0 >= level0_num_tiles_r || z0 < 0 || z0 >= level0_num_tiles_z) return -1;

    int curr = r0 * level0_num_tiles_z + z0;
    while (curr != -1 && curr < (int)amr_nodes.size()) {
        if (amr_nodes[curr].children[0] == -1) {
            if (amr_nodes[curr].is_active && amr_nodes[curr].tile_id != -1) {
                return curr;
            }
            return -1;
        }
        double mid_r = 0.5 * (amr_nodes[curr].r_min + amr_nodes[curr].r_max);
        double mid_z = 0.5 * (amr_nodes[curr].z_min + amr_nodes[curr].z_max);
        int bit_r = (r >= mid_r) ? 1 : 0;
        int bit_z = (z >= mid_z) ? 1 : 0;
        int quadrant = bit_r + 2 * bit_z;
        curr = amr_nodes[curr].children[quadrant];
    }
    return -1;
}

template <typename RealType>
bool CFDSolver2DAMRCudaImpl<RealType>::canCoarsenParentCPU(int parent_idx) const {
    const auto& parent = amr_nodes[parent_idx];
    if (parent.tile_id == -1 || parent.children[0] == -1) return false;

    int parent_level = parent.level;
    double tile_dr = parent.r_max - parent.r_min;
    double tile_dz = parent.z_max - parent.z_min;

    for (int edge = 0; edge < 4; ++edge) {
        for (int s = 0; s < 4; ++s) {
            double frac = (s + 0.5) / 4.0;
            double sr = 0.0, sz = 0.0;
            if (edge == 0) { // Left
                sr = parent.r_min - 0.1 * tile_dr;
                sz = parent.z_min + frac * tile_dz;
            } else if (edge == 1) { // Right
                sr = parent.r_max + 0.1 * tile_dr;
                sz = parent.z_min + frac * tile_dz;
            } else if (edge == 2) { // Bottom
                sr = parent.r_min + frac * tile_dr;
                sz = parent.z_min - 0.1 * tile_dz;
            } else if (edge == 3) { // Top
                sr = parent.r_min + frac * tile_dr;
                sz = parent.z_max + 0.1 * tile_dz;
            }

            if (sr < 0.0 || sr >= max_r_coord || sz < 0.0 || sz >= max_z_coord) continue;
            int nb_idx = findLeafNodeAtCoordsCPU(sr, sz);
            if (nb_idx != -1 && amr_nodes[nb_idx].tile_id != -1 && amr_nodes[nb_idx].is_active) {
                int nb_level = amr_nodes[nb_idx].level;
                if (nb_level > parent_level + 1) return false;
            }
        }
    }
    return true;
}

template <typename RealType>
__global__ void computeTileLoehnerError_AMR_kernel(
    const GPUNode2D* nodes,
    const int* active_node_ids,
    int active_leaves_count,
    const AMRPrimitiveTileT<RealType>* states_pool,
    float* tile_errors) {

    int tile_idx = blockIdx.x;
    if (tile_idx >= active_leaves_count) return;

    int node_idx = active_node_ids[tile_idx];
    auto node = nodes[node_idx];
    const auto& S = states_pool[node.tile_id];

    int i = threadIdx.x;
    int j = threadIdx.y;
    int ti = i + 2;
    int tj = j + 2;
    int k = ti * AMR_TILE_DIM + tj;

    double p_c = (double)S.p[k];
    double p_e = (double)S.p[(ti + 1) * AMR_TILE_DIM + tj];
    double p_w = (double)S.p[(ti - 1) * AMR_TILE_DIM + tj];
    double p_n = (double)S.p[ti * AMR_TILE_DIM + (tj + 1)];
    double p_s = (double)S.p[ti * AMR_TILE_DIM + (tj - 1)];

    double rho_c = (double)S.rho[k];
    double rho_e = (double)S.rho[(ti + 1) * AMR_TILE_DIM + tj];
    double rho_w = (double)S.rho[(ti - 1) * AMR_TILE_DIM + tj];
    double rho_n = (double)S.rho[ti * AMR_TILE_DIM + (tj + 1)];
    double rho_s = (double)S.rho[ti * AMR_TILE_DIM + (tj - 1)];

    double cell_jump_p = math_max(math_max(math_abs(p_e - p_c), math_abs(p_w - p_c)), math_max(math_abs(p_n - p_c), math_abs(p_s - p_c))) / (p_c + 1e-12);
    double cell_jump_rho = math_max(math_max(math_abs(rho_e - rho_c), math_abs(rho_w - rho_c)), math_max(math_abs(rho_n - rho_c), math_abs(rho_s - rho_c))) / (rho_c + 1e-12);
    double max_cell_jump = math_max(cell_jump_p, cell_jump_rho);

    double cell_err = 0.0;
    if (max_cell_jump >= 0.03) {
        double eps = 0.01;
        double d2_r_p = math_abs(p_e - 2.0 * p_c + p_w);
        double d1_r_p = math_abs(p_e - p_c) + math_abs(p_c - p_w) + eps * math_abs(p_c);
        double err_r_p = d2_r_p / (d1_r_p + 1e-12);

        double d2_z_p = math_abs(p_n - 2.0 * p_c + p_s);
        double d1_z_p = math_abs(p_n - p_c) + math_abs(p_c - p_s) + eps * math_abs(p_c);
        double err_z_p = d2_z_p / (d1_z_p + 1e-12);

        double d2_r_rho = math_abs(rho_e - 2.0 * rho_c + rho_w);
        double d1_r_rho = math_abs(rho_e - rho_c) + math_abs(rho_c - rho_w) + eps * math_abs(rho_c);
        double err_r_rho = d2_r_rho / (d1_r_rho + 1e-12);

        double d2_z_rho = math_abs(rho_n - 2.0 * rho_c + rho_s);
        double d1_z_rho = math_abs(rho_n - rho_c) + math_abs(rho_c - rho_s) + eps * math_abs(rho_c);
        double err_z_rho = d2_z_rho / (d1_z_rho + 1e-12);

        cell_err = math_max(math_max(err_r_p, err_z_p), math_max(err_r_rho, err_z_rho));
        double shock_weight = math_min(1.0, max_cell_jump / 0.03);
        cell_err *= shock_weight;
    }

    __shared__ float sm_err[256];
    int tid = j * 16 + i;
    sm_err[tid] = (float)cell_err;
    __syncthreads();

    for (int stride = 128; stride > 0; stride >>= 1) {
        if (tid < stride) {
            sm_err[tid] = fmaxf(sm_err[tid], sm_err[tid + stride]);
        }
        __syncthreads();
    }

    if (tid == 0) {
        tile_errors[tile_idx] = sm_err[0];
    }
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::adaptMeshCPU() {
    if (active_leaves_count == 0) return;

    restrictAllCPU();

    if (active_leaves_count > (int)current_tile_errors_capacity) {
        if (d_tile_errors) checkCudaError(cudaFree(d_tile_errors));
        current_tile_errors_capacity = active_leaves_count * 2;
        checkCudaError(cudaMalloc(&d_tile_errors, current_tile_errors_capacity * sizeof(float)));
        if (host_pinned_tile_errors) checkCudaError(cudaFreeHost(host_pinned_tile_errors));
        checkCudaError(cudaMallocHost(&host_pinned_tile_errors, current_tile_errors_capacity * sizeof(float)));
    }

    launchComputeTileLoehnerError_AMR(
        this->d_amr_nodes, this->d_active_node_ids, this->active_leaves_count, this->d_states_pool, this->d_tile_errors
    );

    checkCudaError(cudaMemcpy(host_pinned_tile_errors, d_tile_errors, active_leaves_count * sizeof(float), cudaMemcpyDeviceToHost));

    std::vector<float> node_errors(amr_nodes.size(), 0.0f);
    int leaf_idx = 0;
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        if (amr_nodes[n].tile_id != -1 && amr_nodes[n].is_active) {
            if (leaf_idx < active_leaves_count) {
                node_errors[n] = host_pinned_tile_errors[leaf_idx++];
            }
        }
    }

    std::vector<RefineJobGPU> refine_jobs;
    bool topology_changed = true;
    while (topology_changed) {
        topology_changed = false;

        std::vector<bool> to_refine(amr_nodes.size(), false);
        std::vector<bool> flagged_by_error(amr_nodes.size(), false);

        // 2. Direct refinement triggering using GPU-evaluated error array
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            const auto& node = amr_nodes[n];
            if (node.tile_id == -1 || !node.is_active) continue;
            if (node.r_min >= max_r_coord || node.z_min >= max_z_coord) continue;
            if (node.level >= amr_max_levels_val - 1) continue;

            if (node_errors[n] > amr_threshold_val) {
                flagged_by_error[n] = true;
                to_refine[n] = true;
            }
        }

        // Add 1-tile safety buffer ring around error-flagged nodes
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            if (!flagged_by_error[n]) continue;
            const auto& node = amr_nodes[n];

            double tile_dr = node.r_max - node.r_min;
            double tile_dz = node.z_max - node.z_min;

            for (int edge = 0; edge < 4; ++edge) {
                for (int s = 0; s < 4; ++s) {
                    double frac = (s + 0.5) / 4.0;
                    double sr = 0.0, sz = 0.0;
                    if (edge == 0) { sr = node.r_min - 0.1 * tile_dr; sz = node.z_min + frac * tile_dz; }
                    else if (edge == 1) { sr = node.r_max + 0.1 * tile_dr; sz = node.z_min + frac * tile_dz; }
                    else if (edge == 2) { sr = node.r_min + frac * tile_dr; sz = node.z_min - 0.1 * tile_dz; }
                    else if (edge == 3) { sr = node.r_min + frac * tile_dr; sz = node.z_max + 0.1 * tile_dz; }

                    if (sr < 0.0 || sr >= max_r_coord || sz < 0.0 || sz >= max_z_coord) continue;
                    int nb_idx = findLeafNodeAtCoordsCPU(sr, sz);
                    if (nb_idx != -1 && amr_nodes[nb_idx].tile_id != -1 && amr_nodes[nb_idx].is_active) {
                        if (amr_nodes[nb_idx].level == node.level && !to_refine[nb_idx]) {
                            to_refine[nb_idx] = true;
                        }
                    }
                }
            }
        }

        // 3. Absolute 2:1 Level Balance Enforcer across ALL active leaves
        bool changed = true;
        while (changed) {
            changed = false;
            for (size_t n = 0; n < amr_nodes.size(); ++n) {
                const auto& node = amr_nodes[n];
                if (node.tile_id == -1 || !node.is_active) continue;

                int eff_level = node.level + (to_refine[n] ? 1 : 0);
                if (eff_level >= amr_max_levels_val) continue;

                double tile_dr = node.r_max - node.r_min;
                double tile_dz = node.z_max - node.z_min;

                for (int edge = 0; edge < 4; ++edge) {
                    for (int s = 0; s < 4; ++s) {
                        double frac = (s + 0.5) / 4.0;
                        double sr = 0.0, sz = 0.0;
                        if (edge == 0) { sr = node.r_min - 0.1 * tile_dr; sz = node.z_min + frac * tile_dz; }
                        else if (edge == 1) { sr = node.r_max + 0.1 * tile_dr; sz = node.z_min + frac * tile_dz; }
                        else if (edge == 2) { sr = node.r_min + frac * tile_dr; sz = node.z_min - 0.1 * tile_dz; }
                        else if (edge == 3) { sr = node.r_min + frac * tile_dr; sz = node.z_max + 0.1 * tile_dz; }

                        if (sr < 0.0 || sr >= max_r_coord || sz < 0.0 || sz >= max_z_coord) continue;
                        int nb_idx = findLeafNodeAtCoordsCPU(sr, sz);
                        if (nb_idx != -1 && amr_nodes[nb_idx].tile_id != -1 && amr_nodes[nb_idx].is_active) {
                            int nb_eff_level = amr_nodes[nb_idx].level + (to_refine[nb_idx] ? 1 : 0);
                            if (eff_level - nb_eff_level > 1 && !to_refine[nb_idx]) {
                                to_refine[nb_idx] = true;
                                changed = true;
                            }
                        }
                    }
                }
            }
        }

        std::vector<int> nodes_to_refine;
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            if (to_refine[n] && amr_nodes[n].level < amr_max_levels_val - 1 && amr_nodes[n].is_active) {
                nodes_to_refine.push_back(n);
            }
        }

        if (!nodes_to_refine.empty()) {
            for (int idx : nodes_to_refine) {
                refine_jobs.push_back(refineNodeCPU(idx));
            }
            rebuildNeighborPointers();
            topology_changed = true;
        }
    }

    // 4. Multi-pass Bottom-Up Coarsening Sweep
    std::vector<int> parents_to_coarsen;
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        const auto& node = amr_nodes[n];
        if (node.children[0] != -1 && node.tile_id != -1) {
            bool all_children_leaves = true;
            double max_child_err = 0.0;
            for (int c = 0; c < 4; ++c) {
                int child_idx = node.children[c];
                if (child_idx == -1 || amr_nodes[child_idx].children[0] != -1) {
                    all_children_leaves = false;
                } else {
                    if (node_errors[child_idx] > max_child_err) {
                        max_child_err = node_errors[child_idx];
                    }
                }
            }
            if (all_children_leaves && max_child_err < (amr_threshold_val * amr_coarsen_ratio_val) && canCoarsenParentCPU(n)) {
                parents_to_coarsen.push_back(n);
            }
        }
    }

    for (int idx : parents_to_coarsen) coarsenNodeCPU(idx);

    growTilePoolsGPU();
    rebuildNeighborPointers();
    syncTreeToGPU();
    syncPoolsToGPU();
    updatePrimitiveGPU();
    fillGhostCellsGPU();
}

template <typename RealType>
RefineJobGPU CFDSolver2DAMRCudaImpl<RealType>::refineNodeCPU(int node_idx) {
    int parent_tile_id = amr_nodes[node_idx].tile_id;
    double p_r_min = amr_nodes[node_idx].r_min;
    double p_r_max = amr_nodes[node_idx].r_max;
    double p_z_min = amr_nodes[node_idx].z_min;
    double p_z_max = amr_nodes[node_idx].z_max;
    int p_level = amr_nodes[node_idx].level;

    int p_r_idx = amr_nodes[node_idx].r_idx;
    int p_z_idx = amr_nodes[node_idx].z_idx;

    amr_nodes[node_idx].is_active = false;
    double mid_r = 0.5 * (p_r_min + p_r_max);
    double mid_z = 0.5 * (p_z_min + p_z_max);

    RefineJobGPU job;
    job.parent_tile_id = parent_tile_id;

    int start_idx = amr_nodes.size();
    for (int c = 0; c < 4; ++c) {
        AMRTileNode child;
        child.tile_id = allocateTile();
        job.child_tile_ids[c] = child.tile_id;

        child.level = p_level + 1;
        child.parent = node_idx;
        std::fill(std::begin(child.children), std::end(child.children), -1);
        std::fill(std::begin(child.neighbors), std::end(child.neighbors), -1);
        child.is_active = true;

        if (c == 0) {
            child.r_min = p_r_min; child.r_max = mid_r; child.z_min = p_z_min; child.z_max = mid_z;
            child.r_idx = p_r_idx * 2;
            child.z_idx = p_z_idx * 2;
        }
        else if (c == 1) {
            child.r_min = mid_r; child.r_max = p_r_max; child.z_min = p_z_min; child.z_max = mid_z;
            child.r_idx = p_r_idx * 2 + 1;
            child.z_idx = p_z_idx * 2;
        }
        else if (c == 2) {
            child.r_min = p_r_min; child.r_max = mid_r; child.z_min = mid_z; child.z_max = p_z_max;
            child.r_idx = p_r_idx * 2;
            child.z_idx = p_z_idx * 2 + 1;
        }
        else if (c == 3) {
            child.r_min = mid_r; child.r_max = p_r_max; child.z_min = mid_z; child.z_max = p_z_max;
            child.r_idx = p_r_idx * 2 + 1;
            child.z_idx = p_z_idx * 2 + 1;
        }

        amr_nodes.push_back(child);
        amr_nodes[node_idx].children[c] = start_idx + c;
    }

    const auto& U_parent = U_pool[parent_tile_id];
    for (int c = 0; c < 4; ++c) {
        int child_tile_id = job.child_tile_ids[c];
        auto& U_child = U_pool[child_tile_id];
        int r_off = (c & 1) ? 8 : 0;
        int z_off = (c >= 2) ? 8 : 0;

        for (int i = 0; i < 16; ++i) {
            int pi = 2 + r_off + i / 2;
            for (int j = 0; j < 16; ++j) {
                int pj = 2 + z_off + j / 2;
                int parent_k = pi * AMR_TILE_DIM + pj;
                int child_k = (i + 2) * AMR_TILE_DIM + (j + 2);

                U_child.rho[child_k]    = U_parent.rho[parent_k];
                U_child.rhour[child_k]  = U_parent.rhour[parent_k];
                U_child.rhouz[child_k]  = U_parent.rhouz[parent_k];
                U_child.E[child_k]      = U_parent.E[parent_k];
                U_child.alpha1[child_k] = U_parent.alpha1[parent_k];
                U_child.alpha2[child_k] = U_parent.alpha2[parent_k];
                U_child.arho1[child_k]  = U_parent.arho1[parent_k];
                U_child.arho2[child_k]  = U_parent.arho2[parent_k];
            }
        }
    }

    return job;
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::coarsenNodeCPU(int parent_idx) {
    auto& parent = amr_nodes[parent_idx];
    parent.is_active = true;
    for (int c = 0; c < 4; ++c) {
        int child_idx = parent.children[c];
        freeTile(amr_nodes[child_idx].tile_id);
        amr_nodes[child_idx].tile_id = -1;
        amr_nodes[child_idx].is_active = false;
        parent.children[c] = -1;
    }
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::applyInitialConditionToNode(int node_idx, double explosive_z, double explosive_radius, double high_rho, double detonation_energy, double ambient_rho, double ambient_p, bool is_tnt, bool is_cylinder, double charge_height) {
    const auto& node = amr_nodes[node_idx];
    auto& U = U_pool[node.tile_id];
    double factor = 1.0 / (1 << node.level);
    double dr_cell = dr_base * factor;
    double dz_cell = dz_base * factor;

    for (int i = 0; i < 16; ++i) {
        double r_left = node.r_min + i * dr_cell;
        for (int j = 0; j < 16; ++j) {
            double z_bottom = node.z_min + j * dz_cell;
            int k = (i + 2) * AMR_TILE_DIM + (j + 2);

            double sum_w = 0.0;
            double sum_w_inside = 0.0;
            for (int ki = 0; ki < 8; ++ki) {
                double r_sub = r_left + (ki + 0.5) * (dr_cell / 8.0);
                double w = is_cartesian_val ? 1.0 : r_sub;
                for (int kj = 0; kj < 8; ++kj) {
                    double z_sub = z_bottom + (kj + 0.5) * (dz_cell / 8.0);
                    bool inside = false;
                    if (is_cylinder) {
                        inside = (r_sub <= explosive_radius) && (std::abs(z_sub - explosive_z) <= charge_height / 2.0);
                    } else {
                        double dist = std::sqrt(r_sub * r_sub + (z_sub - explosive_z) * (z_sub - explosive_z));
                        inside = (dist <= explosive_radius);
                    }
                    if (inside) sum_w_inside += w;
                    sum_w += w;
                }
            }
            double f_vol = sum_w_inside / sum_w;

            if (f_vol > 0.0) {
                double alpha_expl = f_vol;
                double arho_expl = f_vol * high_rho;
                double rho = arho_expl + (1.0 - f_vol) * ambient_rho;
                double E_expl = is_tnt ? (high_rho * MultiMat::getEnergy_IdealGas(ambient_p, high_rho, gamma_val)) : (high_rho * detonation_energy);
                double E_air = ambient_p / (gamma_val - 1.0);
                double E_total = f_vol * E_expl + (1.0 - f_vol) * E_air;

                U.rho[k] = (RealType)rho;
                U.rhour[k] = 0.0;
                U.rhouz[k] = 0.0;
                if (is_tnt) {
                    U.alpha1[k] = (RealType)alpha_expl;
                    U.alpha2[k] = 0.0;
                    U.arho1[k] = (RealType)arho_expl;
                    U.arho2[k] = 0.0;
                } else {
                    U.alpha1[k] = 0.0;
                    U.alpha2[k] = (RealType)alpha_expl;
                    U.arho1[k] = 0.0;
                    U.arho2[k] = (RealType)arho_expl;
                }
                U.E[k] = (RealType)E_total;
            } else {
                U.rho[k] = (RealType)ambient_rho;
                U.rhour[k] = 0.0;
                U.rhouz[k] = 0.0;
                U.alpha1[k] = 0.0;
                U.alpha2[k] = 0.0;
                U.arho1[k] = 0.0;
                U.arho2[k] = 0.0;
                U.E[k] = (RealType)(ambient_p / (gamma_val - 1.0));
            }
        }
    }
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::setInitialConditionTNT(double explosive_z, double explosive_radius, double high_rho, double ambient_rho, double ambient_p) {
    this->ambient_rho_val = ambient_rho;
    this->ambient_p_val = ambient_p;
    this->is_ideal_gas_val = false;

    for (int step = 0; step < this->amr_max_levels_val - 1; ++step) {
        bool changed = false;
        std::vector<int> to_refine;
        for (size_t n = 0; n < this->amr_nodes.size(); ++n) {
            const auto& node = this->amr_nodes[n];
            if (node.is_active && node.level < this->amr_max_levels_val - 1) {
                double dist_z1 = std::max(node.z_min, std::min(explosive_z, node.z_max)) - explosive_z;
                double dist_r1 = std::max(node.r_min, std::min(this->detonator_r_coord, node.r_max)) - this->detonator_r_coord;
                double dist = std::sqrt(dist_r1 * dist_r1 + dist_z1 * dist_z1);
                
                if (dist <= explosive_radius * 1.5 ||
                    (this->detonator_r_coord >= node.r_min && this->detonator_r_coord <= node.r_max &&
                     this->detonator_z_coord >= node.z_min && this->detonator_z_coord <= node.z_max)) {
                    to_refine.push_back(n);
                    changed = true;
                }
            }
        }
        for (int idx : to_refine) this->refineNodeCPU(idx);
        if (changed) this->rebuildNeighborPointers();
    }

    for (size_t n = 0; n < this->amr_nodes.size(); ++n) {
        if (this->amr_nodes[n].tile_id != -1 && this->amr_nodes[n].is_active) {
            this->applyInitialConditionToNode(n, explosive_z, explosive_radius, high_rho, 0.0, ambient_rho, ambient_p, true);
        }
    }

    this->restrictAllCPU();
    this->syncTreeToGPU();
    this->syncPoolsToGPU();
    this->updatePrimitiveGPU();
    this->fillGhostCellsGPU();
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::setInitialConditionIdealGas(double explosive_z, double explosive_radius, double high_rho, double detonation_energy, double ambient_rho, double ambient_p) {
    this->ambient_rho_val = ambient_rho;
    this->ambient_p_val = ambient_p;
    this->is_ideal_gas_val = true;

    for (int step = 0; step < this->amr_max_levels_val - 1; ++step) {
        bool changed = false;
        std::vector<int> to_refine;
        for (size_t n = 0; n < this->amr_nodes.size(); ++n) {
            const auto& node = this->amr_nodes[n];
            if (node.is_active && node.level < this->amr_max_levels_val - 1) {
                double dist_z1 = std::max(node.z_min, std::min(explosive_z, node.z_max)) - explosive_z;
                double dist_r1 = std::max(node.r_min, std::min(this->detonator_r_coord, node.r_max)) - this->detonator_r_coord;
                double dist = std::sqrt(dist_r1 * dist_r1 + dist_z1 * dist_z1);
                
                if (dist <= explosive_radius * 1.5 ||
                    (this->detonator_r_coord >= node.r_min && this->detonator_r_coord <= node.r_max &&
                     this->detonator_z_coord >= node.z_min && this->detonator_z_coord <= node.z_max)) {
                    to_refine.push_back(n);
                    changed = true;
                }
            }
        }
        for (int idx : to_refine) this->refineNodeCPU(idx);
        if (changed) this->rebuildNeighborPointers();
    }

    for (size_t n = 0; n < this->amr_nodes.size(); ++n) {
        if (this->amr_nodes[n].tile_id != -1 && this->amr_nodes[n].is_active) {
            this->applyInitialConditionToNode(n, explosive_z, explosive_radius, high_rho, detonation_energy, ambient_rho, ambient_p, false);
        }
    }

    this->restrictAllCPU();
    this->syncTreeToGPU();
    this->syncPoolsToGPU();
    this->updatePrimitiveGPU();
    this->fillGhostCellsGPU();
    this->syncPoolsToCPU();
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::setInitialConditionTNTCylinder(double explosive_z, double radius, double height, double high_rho, double ambient_rho, double ambient_p) {
    this->ambient_rho_val = ambient_rho;
    this->ambient_p_val = ambient_p;
    this->is_ideal_gas_val = false;

    for (int step = 0; step < this->amr_max_levels_val - 1; ++step) {
        bool changed = false;
        std::vector<int> to_refine;
        for (size_t n = 0; n < this->amr_nodes.size(); ++n) {
            const auto& node = this->amr_nodes[n];
            if (node.is_active && node.level < this->amr_max_levels_val - 1) {
                double dz = std::max(node.z_min, std::min(explosive_z + height / 2.0, node.z_max)) - (explosive_z + height / 2.0);
                double dr = std::max(node.r_min, std::min(0.0, node.r_max));
                double dist = std::sqrt(dr * dr + dz * dz);

                if (dist <= radius * 1.5 ||
                    (this->detonator_r_coord >= node.r_min && this->detonator_r_coord <= node.r_max &&
                     this->detonator_z_coord >= node.z_min && this->detonator_z_coord <= node.z_max)) {
                    to_refine.push_back(n);
                    changed = true;
                }
            }
        }
        for (int idx : to_refine) this->refineNodeCPU(idx);
        if (changed) this->rebuildNeighborPointers();
    }

    for (size_t n = 0; n < this->amr_nodes.size(); ++n) {
        if (this->amr_nodes[n].tile_id != -1 && this->amr_nodes[n].is_active) {
            this->applyInitialConditionToNode(n, explosive_z, radius, high_rho, 0.0, ambient_rho, ambient_p, true, true, height);
        }
    }

    this->restrictAllCPU();
    this->syncTreeToGPU();
    this->syncPoolsToGPU();
    this->updatePrimitiveGPU();
    this->fillGhostCellsGPU();
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::setInitialConditionFrom1D(double explosive_z, double remap_radius, const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d, double ambient_rho, double ambient_p, double explosive_r) {
    this->ambient_rho_val = ambient_rho;
    this->ambient_p_val = ambient_p;
    this->is_ideal_gas_val = false;

    for (int step = 0; step < this->amr_max_levels_val - 1; ++step) {
        bool changed = false;
        std::vector<int> to_refine;
        for (size_t n = 0; n < this->amr_nodes.size(); ++n) {
            const auto& node = this->amr_nodes[n];
            if (node.is_active && node.level < this->amr_max_levels_val - 1) {
                double dist_z1 = std::max(node.z_min, std::min(explosive_z, node.z_max)) - explosive_z;
                double dist_r1 = std::max(node.r_min, std::min(explosive_r, node.r_max)) - explosive_r;
                double dist = std::sqrt(dist_r1 * dist_r1 + dist_z1 * dist_z1);

                if (dist <= remap_radius * 1.5 ||
                    (this->detonator_r_coord >= node.r_min && this->detonator_r_coord <= node.r_max &&
                     this->detonator_z_coord >= node.z_min && this->detonator_z_coord <= node.z_max)) {
                    to_refine.push_back(n);
                    changed = true;
                }
            }
        }
        for (int idx : to_refine) this->refineNodeCPU(idx);
        if (changed) this->rebuildNeighborPointers();
    }

    for (size_t n = 0; n < this->amr_nodes.size(); ++n) {
        const auto& node = this->amr_nodes[n];
        if (node.tile_id == -1 || !node.is_active) continue;
        auto& U = this->U_pool[node.tile_id];
        double factor = 1.0 / (1 << node.level);

        for (int i = 0; i < 16; ++i) {
            double cell_r = node.r_min + (i + 0.5) * this->dr_base * factor;
            for (int j = 0; j < 16; ++j) {
                double cell_z = node.z_min + (j + 0.5) * this->dz_base * factor;
                double r_dist = std::sqrt((cell_r - explosive_r)*(cell_r - explosive_r) + (cell_z - explosive_z)*(cell_z - explosive_z));
                int k = (i + 2) * AMR_TILE_DIM + (j + 2);

                size_t idx = 0;
                while (idx + 1 < r_1d.size() && r_1d[idx] < r_dist) {
                    idx++;
                }

                const auto& state = states_1d[idx];
                U.rho[k] = (RealType)state.rho;
                U.rhour[k] = (RealType)(state.rho * state.u * (cell_r - explosive_r) / (r_dist + 1e-12));
                U.rhouz[k] = (RealType)(state.rho * state.u * (cell_z - explosive_z) / (r_dist + 1e-12));
                U.E[k] = (RealType)(state.p / (this->gamma_val - 1.0) + 0.5 * state.rho * state.u * state.u);
                U.alpha1[k] = (RealType)state.alpha1;
                U.alpha2[k] = (RealType)state.alpha2;
                U.arho1[k] = (RealType)state.arho1;
                U.arho2[k] = (RealType)state.arho2;
            }
        }
    }

    this->restrictAllCPU();
    this->syncTreeToGPU();
    this->syncPoolsToGPU();
    this->updatePrimitiveGPU();
    this->fillGhostCellsGPU();
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::setFluxScheme(const std::string& scheme_name) { flux_scheme_name = scheme_name; }

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::setSpatialOrder(int order) { spatial_order_val = order; }

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::setTemporalOrder(int order) { temporal_order_val = order; }

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::setMaterialParameters(const MultiMat::MaterialSet& materials) { materials_val = materials; }

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::setGamma(double g) { gamma_val = g; }

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::setIdealGas(bool val) { is_ideal_gas_val = val; }

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::setBCTypes(BCType r_min, BCType r_max, BCType z_min, BCType z_max) {
    bc_r_min = r_min; bc_r_max = r_max;
    bc_z_min = z_min; bc_z_max = z_max;
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::step(double dt) {
    if (temporal_order_val == 1) {
        fillGhostCellsGPU();
        computeRHSGPU(0.0, 1.0);
        launchUpdateConservativeRKStage_AMR(
            this->active_leaves_count, this->d_active_tile_ids, this->d_U_pool, this->d_dU_pool, (RealType)dt
        );
        checkCudaError(cudaDeviceSynchronize());
        updatePrimitiveGPU();
        
        restrictAllGPU();
        updatePrimitiveGPU();
    } else {
        for (int stage = 0; stage < 3; ++stage) {
            applyLSRK3StepGPU(stage, dt);
            updatePrimitiveGPU();
            
            restrictAllGPU();
            updatePrimitiveGPU();
        }
    }

    time_val += dt;

    // Adapt mesh periodically (every 20 steps) to minimize CPU-GPU memory copy overhead
    adapt_step_counter++;
    if (adapt_step_counter % 20 == 0) {
        adaptMeshCPU();
    }
}

template <typename RealType>
double CFDSolver2DAMRCudaImpl<RealType>::stepBatch(int num_steps, double cfl) {
    double last_dt = 1e-4;
    for (int s = 0; s < num_steps; ++s) {
        double dt = getMaxWaveSpeed();
        dt = dt * (cfl / 0.35);
        if (dt <= 0.0 || std::isnan(dt)) dt = 1e-6;
        step(dt);
        last_dt = dt;
    }
    return last_dt;
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::run(double duration) {
    double target_time = time_val + duration;
    while (time_val < target_time) {
        double dt = getMaxWaveSpeed();
        if (time_val + dt > target_time) dt = target_time - time_val;
        step(dt);
    }
}

template <typename RealType>
double CFDSolver2DAMRCudaImpl<RealType>::getMaxWaveSpeed() {
    if (this->active_leaves_count == 0) return 1e-4;

    if (this->active_leaves_count > (int)this->current_tile_dts_capacity) {
        if (this->d_tile_min_dts) checkCudaError(cudaFree(this->d_tile_min_dts));
        this->current_tile_dts_capacity = this->active_leaves_count * 2;
        checkCudaError(cudaMalloc(&this->d_tile_min_dts, this->current_tile_dts_capacity * sizeof(float)));
    }
    if (!this->d_global_min_dt) {
        checkCudaError(cudaMalloc(&this->d_global_min_dt, sizeof(float)));
    }
    if (!this->host_pinned_min_dt) {
        checkCudaError(cudaMallocHost(&this->host_pinned_min_dt, sizeof(float)));
    }

    launchComputeTileMinDt_AMR(
        this->d_amr_nodes, this->d_active_node_ids, this->active_leaves_count,
        this->d_states_pool, (RealType)this->gamma_val, this->materials_val, this->is_ideal_gas_val,
        this->dr_base, this->dz_base, 0.35, this->d_tile_min_dts
    );

    launchReduceMinDt_AMR(this->d_tile_min_dts, this->active_leaves_count, this->d_global_min_dt);

    checkCudaError(cudaMemcpy(this->host_pinned_min_dt, this->d_global_min_dt, sizeof(float), cudaMemcpyDeviceToHost));

    float min_dt = *this->host_pinned_min_dt;
    if (min_dt <= 0.0f || std::isnan(min_dt)) min_dt = 1e-4f;
    return (double)min_dt;
}

template <typename RealType>
bool CFDSolver2DAMRCudaImpl<RealType>::checkTerminationCondition() {
    this->syncPoolsToCPU();
    double threshold = 1.05 * this->ambient_p_val;
    for (size_t n = 0; n < this->amr_nodes.size(); ++n) {
        const auto& node = this->amr_nodes[n];
        if (node.tile_id != -1 && node.is_active) {
            const auto& S = this->states_pool[node.tile_id];

            if (this->bc_r_min == static_cast<CFDSolver2DCuda::BCType>(CFDSolver2D::OUTFLOW_RIEMANN) && node.r_min <= 1e-5) {
                int ti = 2; // Innermost boundary interior cell
                for (int j = 0; j < 16; ++j) {
                    int tj = j + 2;
                    int k = ti * AMR_TILE_DIM + tj;
                    if (S.p[k] > threshold) return true;
                }
            }
            if (this->bc_r_max == static_cast<CFDSolver2DCuda::BCType>(CFDSolver2D::OUTFLOW_RIEMANN) && node.r_max >= this->max_r_coord - 1e-5) {
                int ti = 17; // Outermost boundary interior cell
                for (int j = 0; j < 16; ++j) {
                    int tj = j + 2;
                    int k = ti * AMR_TILE_DIM + tj;
                    if (S.p[k] > threshold) return true;
                }
            }
            if (this->bc_z_min == static_cast<CFDSolver2DCuda::BCType>(CFDSolver2D::OUTFLOW_RIEMANN) && node.z_min <= 1e-5) {
                int tj = 2; // Innermost boundary interior cell
                for (int i = 0; i < 16; ++i) {
                    int ti = i + 2;
                    int k = ti * AMR_TILE_DIM + tj;
                    if (S.p[k] > threshold) return true;
                }
            }
            if (this->bc_z_max == static_cast<CFDSolver2DCuda::BCType>(CFDSolver2D::OUTFLOW_RIEMANN) && node.z_max >= this->max_z_coord - 1e-5) {
                int tj = 17; // Outermost boundary interior cell
                for (int i = 0; i < 16; ++i) {
                    int ti = i + 2;
                    int k = ti * AMR_TILE_DIM + tj;
                    if (S.p[k] > threshold) return true;
                }
            }
        }
    }
    return false;
}

template <typename RealType>
std::vector<State2D> CFDSolver2DAMRCudaImpl<RealType>::getStates() {
    this->syncPoolsToCPU();
    std::vector<State2D> states(this->level0_nr * this->level0_nz);
    double dr = this->dr_base;
    double dz = this->dz_base;

    for (int i = 0; i < this->level0_nr; ++i) {
        for (int j = 0; j < this->level0_nz; ++j) {
            double cell_r = (i + 0.5) * dr;
            double cell_z = (j + 0.5) * dz;

            int best_node = -1;
            int best_level = -1;
            for (size_t n = 0; n < this->amr_nodes.size(); ++n) {
                const auto& node = this->amr_nodes[n];
                if (node.tile_id != -1 && node.is_active) {
                    if (cell_r >= node.r_min && cell_r <= node.r_max &&
                        cell_z >= node.z_min && cell_z <= node.z_max) {
                        if (node.level > best_level) {
                            best_level = node.level;
                            best_node = n;
                        }
                    }
                }
            }

            int idx = i * this->level0_nz + j;
            if (best_node == -1) {
                states[idx] = { (float)this->ambient_rho_val, 0.0f, 0.0f, (float)this->ambient_p_val, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f };
            } else {
                const auto& node = this->amr_nodes[best_node];
                const auto& S = this->states_pool[node.tile_id];
                double factor = 1.0 / (1 << node.level);
                int local_i = (int)((cell_r - node.r_min) / (this->dr_base * factor));
                int local_j = (int)((cell_z - node.z_min) / (this->dz_base * factor));
                local_i = std::max(0, std::min(15, local_i));
                local_j = std::max(0, std::min(15, local_j));
                int k = (local_i + 2) * AMR_TILE_DIM + (local_j + 2);
                states[idx] = {
                    (float)S.rho[k], (float)S.ur[k], (float)S.uz[k], (float)S.p[k],
                    0.0f, (float)S.alpha1[k], (float)S.alpha2[k], (float)S.arho1[k], (float)S.arho2[k]
                };
            }
        }
    }
    return states;
}

template <typename RealType>
std::vector<float> CFDSolver2DAMRCudaImpl<RealType>::getCellValues(int i, int j) {
    std::vector<State2D> states = this->getStates();
    int idx = i * this->level0_nz + j;
    if (idx >= (int)states.size()) return std::vector<float>(8, 0.0f);
    const auto& s = states[idx];
    return { (float)s.rho, (float)s.ur, (float)s.uz, (float)s.p, (float)s.alpha1, (float)s.alpha2, (float)s.arho1, (float)s.arho2 };
}

template <typename RealType>
std::vector<float> CFDSolver2DAMRCudaImpl<RealType>::getTelemetry2D(int stride) {
    this->syncPoolsToCPU();
    std::vector<float> data;
    uint32_t num_leaves = 0;
    for (const auto& node : this->amr_nodes) {
        if (node.tile_id != -1 && node.is_active) num_leaves++;
    }

    uint32_t n_channels = 7;
    data.push_back(*(float*)&num_leaves);
    data.push_back(*(float*)&n_channels);

    for (const auto& node : this->amr_nodes) {
        if (node.tile_id != -1 && node.is_active) {
            const auto& S = this->states_pool[node.tile_id];
            uint16_t r_idx = node.r_idx;
            uint16_t z_idx = node.z_idx;
            uint8_t lvl = node.level;
            uint8_t padding = 0;
            uint32_t meta1 = (r_idx << 16) | z_idx;
            uint32_t meta2 = (lvl << 8) | padding;
            
            data.push_back(*(float*)&meta1);
            data.push_back(*(float*)&meta2);

            for (int i = 0; i < 16; ++i) {
                int ti = i + 2;
                for (int j = 0; j < 16; ++j) {
                    int tj = j + 2;
                    int k = ti * AMR_TILE_DIM + tj;
                    data.push_back((float)S.p[k]);
                    data.push_back((float)S.rho[k]);
                    data.push_back((float)S.ur[k]);
                    data.push_back((float)S.uz[k]);
                    data.push_back((float)S.E[k]);
                    data.push_back((float)S.alpha1[k]);
                    data.push_back((float)S.alpha2[k]);
                }
            }
        }
    }
    return data;
}

template <typename RealType>
size_t CFDSolver2DAMRCudaImpl<RealType>::getAllocatedVRAM() const {
    return this->states_pool.size() * (sizeof(AMRPrimitiveTileT<RealType>) + 2 * sizeof(AMRConservativeTileT<RealType>));
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::exportVTK(const std::string& filename) {
    (void)filename;
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::setGauges(const std::vector<Gauge2D>& gauges) {
    this->cpu_gauges = gauges;
    this->cpu_gauge_times.clear();
    this->cpu_gauge_values.clear();
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::recordGaugesAsync(double t) {
    if (this->cpu_gauges.empty()) return;
    this->syncPoolsToCPU();
    this->cpu_gauge_times.push_back(t);
    for (const auto& gauge : this->cpu_gauges) {
        int n_idx = this->findLeafNodeAtCoordsCPU(gauge.r, gauge.z);
        if (n_idx == -1) {
            this->cpu_gauge_values.push_back((float)this->ambient_p_val);
            this->cpu_gauge_values.push_back((float)this->ambient_rho_val);
            this->cpu_gauge_values.push_back(0.0f);
            this->cpu_gauge_values.push_back(0.0f);
            this->cpu_gauge_values.push_back((float)(this->ambient_p_val / (this->gamma_val - 1.0)));
            this->cpu_gauge_values.push_back(0.0f);
            this->cpu_gauge_values.push_back(0.0f);
        } else {
            const auto& node = this->amr_nodes[n_idx];
            const auto& S = this->states_pool[node.tile_id];
            double factor = 1.0 / (1 << node.level);
            int local_i = (int)((gauge.r - node.r_min) / (this->dr_base * factor));
            int local_j = (int)((gauge.z - node.z_min) / (this->dz_base * factor));
            local_i = std::max(0, std::min(15, local_i));
            local_j = std::max(0, std::min(15, local_j));
            int k = (local_i + 2) * AMR_TILE_DIM + (local_j + 2);

            this->cpu_gauge_values.push_back((float)S.p[k]);
            this->cpu_gauge_values.push_back((float)S.rho[k]);
            this->cpu_gauge_values.push_back((float)S.ur[k]);
            this->cpu_gauge_values.push_back((float)S.uz[k]);
            this->cpu_gauge_values.push_back((float)S.E[k]);
            this->cpu_gauge_values.push_back((float)S.alpha1[k]);
            this->cpu_gauge_values.push_back((float)S.alpha2[k]);
        }
    }
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::retrieveNewGaugeSamples(std::vector<double>& times, std::vector<float>& values) {
    times = std::move(this->cpu_gauge_times);
    values = std::move(this->cpu_gauge_values);
    this->cpu_gauge_times.clear();
    this->cpu_gauge_values.clear();
}

// Explicit instantiation for float and double
template class CFDSolver2DAMRCudaImpl<float>;
template class CFDSolver2DAMRCudaImpl<double>;
