#include "cfd_solver_2d_amr_cuda.hpp"
#include "VTKWriter.hpp"
#include <iostream>
#include <algorithm>
#include <cmath>
#include <cuda_runtime.h>
#include <device_launch_parameters.h>

// CUDA Error checking helper
#define checkCudaError(val) check((val), #val, __FILE__, __LINE__)
inline void check(cudaError_t result, char const *const func, const char *const file, int const line) {
    if (result != cudaSuccess) {
        std::cerr << "CUDA error at " << file << ":" << line << " code=" << result << " \"" << cudaGetErrorString(result) << "\" in " << func << std::endl;
        exit(EXIT_FAILURE);
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
                double vr = minmod_gpu(diff_r_right, diff_r_left);

                double diff_z_top    = (jc >= 17) ? ((Nb.*field)[ic * AMR_TILE_DIM + 17] - (Nb.*field)[ic * AMR_TILE_DIM + 16])
                                                  : ((Nb.*field)[ic * AMR_TILE_DIM + jc + 1] - v);
                double diff_z_bottom = (jc <= 2)  ? ((Nb.*field)[ic * AMR_TILE_DIM + 3] - (Nb.*field)[ic * AMR_TILE_DIM + 2])
                                                  : (v - (Nb.*field)[ic * AMR_TILE_DIM + jc - 1]);
                double vz = minmod_gpu(diff_z_top, diff_z_bottom);

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
    auto& T = states_pool[pool_idx];
    auto& dU = dU_pool[pool_idx];

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
        CellState2DT<RealType> s = { T.rho[idx], T.ur[idx], T.uz[idx], T.p[idx], T.E[idx], T.alpha1[idx], T.alpha2[idx], T.arho1[idx], T.arho2[idx] };
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
            face.alpha1 = max((RealType)0.0, min((RealType)1.0, face.alpha1)); \
            face.alpha2 = max((RealType)0.0, min((RealType)1.0, face.alpha2)); \
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
            face.alpha1 = max((RealType)0.0, min((RealType)1.0, face.alpha1)); \
            face.alpha2 = max((RealType)0.0, min((RealType)1.0, face.alpha2)); \
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

    // Extrapolate to ghost cells for parent node
    if (i == 0) {
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
    if (j == 0) {
        for (int gc = 0; gc < 2; ++gc) {
            int k_dest = (i + 2) * AMR_TILE_DIM + gc;
            int k_src = (i + 2) * AMR_TILE_DIM + 2;
            U_parent.rho[k_dest] = U_parent.rho[k_src];
            U_parent.rhour[k_dest] = U_parent.rhour[k_src];
            U_parent.rhouz[k_dest] = U_parent.rhouz[k_src];
            U_parent.E[k_dest] = U_parent.E[k_src];
            U_parent.alpha1[k_dest] = U_parent.alpha1[k_src];
            U_parent.alpha2[k_dest] = U_parent.alpha2[k_src];
            U_parent.arho1[k_dest] = U_parent.arho1[k_src];
            U_parent.arho2[k_dest] = U_parent.arho2[k_src];
        }
        for (int gc = 18; gc < 20; ++gc) {
            int k_dest = (i + 2) * AMR_TILE_DIM + gc;
            int k_src = (i + 2) * AMR_TILE_DIM + 17;
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
      d_allocated_node_ids(nullptr), d_allocated_tile_ids(nullptr), allocated_nodes_count(0), d_amr_nodes(nullptr),
      current_active_capacity(0), current_allocated_capacity(0), current_tree_capacity(0) {

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
    }

    checkCudaError(cudaMemcpy(d_amr_nodes, gpu_nodes.data(), gpu_nodes.size() * sizeof(GPUNode2D), cudaMemcpyHostToDevice));
    checkCudaError(cudaMemcpy(d_active_node_ids, active_node_ids.data(), active_leaves_count * sizeof(int), cudaMemcpyHostToDevice));
    checkCudaError(cudaMemcpy(d_active_tile_ids, active_tile_ids.data(), active_leaves_count * sizeof(int), cudaMemcpyHostToDevice));
    checkCudaError(cudaMemcpy(d_allocated_node_ids, allocated_node_ids.data(), allocated_nodes_count * sizeof(int), cudaMemcpyHostToDevice));
    checkCudaError(cudaMemcpy(d_allocated_tile_ids, allocated_tile_ids.data(), allocated_nodes_count * sizeof(int), cudaMemcpyHostToDevice));
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::fillGhostCellsGPU() {
    fillGhostCells_AMR_kernel<RealType><<<allocated_nodes_count, 64>>>(
        d_amr_nodes, (int)amr_nodes.size(), level0_num_tiles_r, level0_num_tiles_z,
        d_allocated_node_ids, allocated_nodes_count, d_states_pool,
        bc_r_min, bc_r_max, bc_z_min, bc_z_max,
        (RealType)ambient_rho_val, (RealType)ambient_p_val, (RealType)gamma_val,
        materials_val, is_ideal_gas_val, dr_base, dz_base
    );
    checkCudaError(cudaDeviceSynchronize());
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
    double dz_base)
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
                atomicAdd(&U_pool[node.tile_id].field[ck], (RealType)B_coeff * sign * (RealType)(dt / dr_c) * (r_face / r_c) * (c_flux.field[c] - fine_sum)); \
            } else { \
                fine_sum = (RealType)0.5 * (f_flux.field[f_idx1] * r_f1 + f_flux.field[f_idx2] * r_f2) / r_c; \
                atomicAdd(&U_pool[node.tile_id].field[ck], (RealType)B_coeff * sign * (RealType)(dt / dz_c) * (c_flux.field[c] - fine_sum)); \
            } \
        }

        CORRECT(rho) CORRECT(rhour) CORRECT(rhouz) CORRECT(E) CORRECT(alpha1) CORRECT(alpha2) CORRECT(arho1) CORRECT(arho2)
        #undef CORRECT
    }
}



template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::computeRHSGPU(double A_coeff, double dt) {
    computeTileRHS_AMR_kernel<RealType><<<active_leaves_count, dim3(16, 16)>>>(
        d_amr_nodes, d_active_node_ids, active_leaves_count, d_states_pool, d_dU_pool, d_node_boundary_fluxes,
        (RealType)A_coeff, (RealType)dt, (RealType)gamma_val, materials_val, is_ideal_gas_val,
        dr_base, dz_base, spatial_order_val
    );
    checkCudaError(cudaDeviceSynchronize());

    // Flux correction is no longer applied here. It is applied after updateConservative.
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::applyLSRK3StepGPU(int stage, double dt) {
    const double A[3] = {0.0, -5.0/9.0, -153.0/128.0};
    const double B[3] = {1.0/3.0, 15.0/16.0, 8.0/15.0};

    restrictAllGPU();
    updatePrimitiveGPU();

    fillGhostCellsGPU();
    computeRHSGPU(A[stage], dt);

    updateConservativeRKStage_AMR_kernel<RealType><<<active_leaves_count, dim3(16, 16)>>>(
        d_active_tile_ids, active_leaves_count, d_U_pool, d_dU_pool, (RealType)B[stage]
    );
    checkCudaError(cudaDeviceSynchronize());

    int total_flux_threads = active_leaves_count * 4 * 16;
    int flux_blocks = (total_flux_threads + 255) / 256;
    if (flux_blocks > 0) {
        applyFluxCorrectionGPU_kernel<RealType><<<flux_blocks, 256>>>(
            d_amr_nodes,
            d_active_node_ids,
            active_leaves_count,
            d_U_pool,
            d_node_boundary_fluxes,
            B[stage],
            dt,
            dr_base,
            dz_base
        );
        checkCudaError(cudaDeviceSynchronize());
    }
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::updatePrimitiveGPU() {
    updatePrimitiveFromConservative_AMR_kernel<RealType><<<allocated_nodes_count, dim3(16, 16)>>>(
        d_allocated_tile_ids, allocated_nodes_count, d_U_pool, d_states_pool,
        (RealType)gamma_val, materials_val, is_ideal_gas_val,
        (RealType)ambient_rho_val, (RealType)ambient_p_val
    );
    checkCudaError(cudaDeviceSynchronize());
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::restrictAllGPU() {
    for (int lvl = amr_max_levels_val - 2; lvl >= 0; --lvl) {
        std::vector<int> level_parent_node_ids;
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            if (amr_nodes[n].level == lvl && amr_nodes[n].children[0] != -1) {
                level_parent_node_ids.push_back((int)n);
            }
        }
        if (level_parent_node_ids.empty()) continue;

        int* d_level_parent_ids = nullptr;
        checkCudaError(cudaMalloc(&d_level_parent_ids, level_parent_node_ids.size() * sizeof(int)));
        checkCudaError(cudaMemcpy(d_level_parent_ids, level_parent_node_ids.data(), level_parent_node_ids.size() * sizeof(int), cudaMemcpyHostToDevice));

        restrictNode_AMR_kernel<RealType><<<level_parent_node_ids.size(), dim3(16, 16)>>>(
            d_amr_nodes,
            d_level_parent_ids,
            (int)level_parent_node_ids.size(),
            d_U_pool,
            dr_base,
            is_cartesian_val
        );
        checkCudaError(cudaDeviceSynchronize());
        cudaFree(d_level_parent_ids);
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
}

template <typename RealType>
double CFDSolver2DAMRCudaImpl<RealType>::computeTileLoehnerErrorCPU(int tile_id) const {
    if (tile_id == -1 || tile_id >= (int)states_pool.size()) return 0.0;
    const auto& S = states_pool[tile_id];

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
    return max_err;
}

template <typename RealType>
bool CFDSolver2DAMRCudaImpl<RealType>::shouldRefineNodeCPU(int node_idx) {
    const auto& node = amr_nodes[node_idx];
    if (node.r_min >= max_r_coord || node.z_min >= max_z_coord) return false;
    if (node.level >= amr_max_levels_val - 1) return false;
    if (node.tile_id == -1) return false;

    double error = computeTileLoehnerErrorCPU(node.tile_id);
    
    // Gradient-proportional level capping
    if (error > 0.8) {
        // Severe shock, allow up to max resolution
        return true;
    } else if (error > 0.4) {
        // Moderate gradient, cap at level 3
        return node.level < std::min((int)amr_max_levels_val - 1, 3);
    } else if (error > amr_threshold_val) {
        // Mild wave, cap at level 2
        return node.level < std::min((int)amr_max_levels_val - 1, 2);
    }

    return false;
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
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        const auto& node = amr_nodes[n];
        if (node.is_active && node.tile_id != -1 &&
            r >= node.r_min && r < node.r_max &&
            z >= node.z_min && z < node.z_max) {
            return (int)n;
        }
    }
    return -1;
}

template <typename RealType>
bool CFDSolver2DAMRCudaImpl<RealType>::canCoarsenParentCPU(int parent_idx) const {
    const auto& parent = amr_nodes[parent_idx];
    if (parent.tile_id == -1 || parent.children[0] == -1) return false;

    int parent_level = parent.level;

    double mid_r = 0.5 * (parent.r_min + parent.r_max);
    double mid_z = 0.5 * (parent.z_min + parent.z_max);
    double tile_dr = parent.r_max - parent.r_min;
    double tile_dz = parent.z_max - parent.z_min;

    double sample_r[4] = { parent.r_min - 0.25 * tile_dr, parent.r_max + 0.25 * tile_dr, mid_r, mid_r };
    double sample_z[4] = { mid_z, mid_z, parent.z_min - 0.25 * tile_dz, parent.z_max + 0.25 * tile_dz };

    for (int d = 0; d < 4; ++d) {
        if (sample_r[d] < 0.0 || sample_r[d] >= max_r_coord || sample_z[d] < 0.0 || sample_z[d] >= max_z_coord) continue;
        int nb_idx = findLeafNodeAtCoordsCPU(sample_r[d], sample_z[d]);
        if (nb_idx != -1 && amr_nodes[nb_idx].tile_id != -1 && amr_nodes[nb_idx].is_active) {
            int nb_level = amr_nodes[nb_idx].level;
            if (nb_level > parent_level + 1) return false;
        }
    }
    return true;
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::adaptMeshCPU() {
    syncPoolsToCPU();

    // 1. Run restriction sweep first so parent nodes have up-to-date conservative variables
    for (int lvl = amr_max_levels_val - 2; lvl >= 0; --lvl) {
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            if (amr_nodes[n].level == lvl && amr_nodes[n].children[0] != -1) {
                restrictNodeCPU(n);
            }
        }
    }

    // Sync restricted conservative variables to GPU, compute primitives, fill ghost cells, and sync back to CPU
    syncPoolsToGPU();
    updatePrimitiveGPU();
    fillGhostCellsGPU();
    syncPoolsToCPU();

    std::vector<bool> to_refine(amr_nodes.size(), false);
    std::vector<bool> flagged_by_error(amr_nodes.size(), false);

    // 2. Direct refinement triggering
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        const auto& node = amr_nodes[n];
        if (node.tile_id == -1 || !node.is_active) continue;

        if (shouldRefineNodeCPU(n)) {
            flagged_by_error[n] = true;
            to_refine[n] = true;
        }
    }

    // Add 1-tile safety buffer ring ONLY around SAME-LEVEL active neighbors of error-flagged nodes
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        if (!flagged_by_error[n]) continue;
        const auto& node = amr_nodes[n];

        double mid_r = 0.5 * (node.r_min + node.r_max);
        double mid_z = 0.5 * (node.z_min + node.z_max);
        double tile_dr = node.r_max - node.r_min;
        double tile_dz = node.z_max - node.z_min;

        double sample_r[8] = { node.r_min - 0.25 * tile_dr, node.r_max + 0.25 * tile_dr, mid_r, mid_r,
                               node.r_min - 0.25 * tile_dr, node.r_max + 0.25 * tile_dr, node.r_min - 0.25 * tile_dr, node.r_max + 0.25 * tile_dr };
        double sample_z[8] = { mid_z, mid_z, node.z_min - 0.25 * tile_dz, node.z_max + 0.25 * tile_dz,
                               node.z_min - 0.25 * tile_dz, node.z_min - 0.25 * tile_dz, node.z_max + 0.25 * tile_dz, node.z_max + 0.25 * tile_dz };

        for (int d = 0; d < 8; ++d) {
            if (sample_r[d] < 0.0 || sample_r[d] >= max_r_coord || sample_z[d] < 0.0 || sample_z[d] >= max_z_coord) continue;
            int nb_idx = findLeafNodeAtCoordsCPU(sample_r[d], sample_z[d]);
            if (nb_idx != -1 && amr_nodes[nb_idx].tile_id != -1 && amr_nodes[nb_idx].is_active) {
                if (amr_nodes[nb_idx].level == node.level && !to_refine[nb_idx]) {
                    to_refine[nb_idx] = true;
                }
            }
        }
    }

    // 3. Graded 2:1 Level Balance Enforcer using exact spatial leaf lookup across all 8 neighbor directions
    bool changed = true;
    while (changed) {
        changed = false;
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            if (!to_refine[n]) continue;
            const auto& node = amr_nodes[n];
            if (node.tile_id == -1) continue;

            int target_level = node.level + 1;
            if (target_level >= amr_max_levels_val) continue;

            double mid_r = 0.5 * (node.r_min + node.r_max);
            double mid_z = 0.5 * (node.z_min + node.z_max);
            double tile_dr = node.r_max - node.r_min;
            double tile_dz = node.z_max - node.z_min;

            double sample_r[8] = { node.r_min - 0.25 * tile_dr, node.r_max + 0.25 * tile_dr, mid_r, mid_r,
                                   node.r_min - 0.25 * tile_dr, node.r_max + 0.25 * tile_dr, node.r_min - 0.25 * tile_dr, node.r_max + 0.25 * tile_dr };
            double sample_z[8] = { mid_z, mid_z, node.z_min - 0.25 * tile_dz, node.z_max + 0.25 * tile_dz,
                                   node.z_min - 0.25 * tile_dz, node.z_min - 0.25 * tile_dz, node.z_max + 0.25 * tile_dz, node.z_max + 0.25 * tile_dz };

            for (int d = 0; d < 8; ++d) {
                if (sample_r[d] < 0.0 || sample_r[d] >= max_r_coord || sample_z[d] < 0.0 || sample_z[d] >= max_z_coord) continue;
                int nb_idx = findLeafNodeAtCoordsCPU(sample_r[d], sample_z[d]);
                if (nb_idx != -1 && amr_nodes[nb_idx].tile_id != -1 && amr_nodes[nb_idx].is_active) {
                    const auto& nb_node = amr_nodes[nb_idx];
                    if (nb_node.level < node.level && !to_refine[nb_idx]) {
                        to_refine[nb_idx] = true;
                        changed = true;
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

    // 4. Multi-pass Bottom-Up Coarsening Sweep
    std::vector<int> parents_to_coarsen;
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        const auto& node = amr_nodes[n];
        if (node.children[0] != -1 && node.tile_id != -1) {
            bool all_children_leaves = true;
            bool any_child_refining = false;
            for (int c = 0; c < 4; ++c) {
                int child_idx = node.children[c];
                if (child_idx == -1 || amr_nodes[child_idx].children[0] != -1) {
                    all_children_leaves = false;
                }
                if (child_idx != -1 && to_refine[child_idx]) {
                    any_child_refining = true;
                }
            }
            if (all_children_leaves && !any_child_refining && shouldCoarsenNodeCPU(n) && canCoarsenParentCPU(n)) {
                parents_to_coarsen.push_back(n);
            }
        }
    }

    for (int idx : nodes_to_refine) refineNodeCPU(idx);
    for (int idx : parents_to_coarsen) coarsenNodeCPU(idx);

    if (!nodes_to_refine.empty() || !parents_to_coarsen.empty()) {
        rebuildNeighborPointers();
        syncTreeToGPU();
    }
    syncPoolsToGPU();
    if (!nodes_to_refine.empty() || !parents_to_coarsen.empty()) {
        updatePrimitiveGPU();
        fillGhostCellsGPU();
    }
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::refineNodeCPU(int node_idx) {
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

    int start_idx = amr_nodes.size();
    for (int c = 0; c < 4; ++c) {
        AMRTileNode child;
        child.tile_id = allocateTile();
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
    auto prolongate_node_field = [&](int child_idx, int quadrant, auto field) {
        auto& U_child = U_pool[amr_nodes[child_idx].tile_id];
        int r_quad = (quadrant == 1 || quadrant == 3) ? 1 : 0;
        int z_quad = (quadrant == 2 || quadrant == 3) ? 1 : 0;
        for (int ci = 0; ci < AMR_TILE_DIM; ++ci) {
            int local_ci = std::max(0, std::min(15, ci - 2));
            int pi = (ci < 2) ? 1 : ((ci > 17) ? 18 : (local_ci / 2) + r_quad * 8 + 2);
            double xfrac = (ci % 2 == 0) ? -0.25 : 0.25;
            for (int cj = 0; cj < AMR_TILE_DIM; ++cj) {
                int local_cj = std::max(0, std::min(15, cj - 2));
                int pj = (cj < 2) ? 1 : ((cj > 17) ? 18 : (local_cj / 2) + z_quad * 8 + 2);
                double yfrac = (cj % 2 == 0) ? -0.25 : 0.25;
                int pk = pi * AMR_TILE_DIM + pj;
                int ck = ci * AMR_TILE_DIM + cj;
                RealType v = (U_parent.*field)[pk];
                RealType vr = (pi >= 18) ? (v - (U_parent.*field)[(pi-1)*AMR_TILE_DIM+pj]) :
                              ((pi <= 1)  ? ((U_parent.*field)[(pi+1)*AMR_TILE_DIM+pj] - v) :
                              minmod_kernel((U_parent.*field)[(pi+1)*AMR_TILE_DIM+pj] - v, v - (U_parent.*field)[(pi-1)*AMR_TILE_DIM+pj]));
                RealType vz = (pj >= 18) ? (v - (U_parent.*field)[pi*AMR_TILE_DIM+pj-1]) :
                              ((pj <= 1)  ? ((U_parent.*field)[pi*AMR_TILE_DIM+pj+1] - v) :
                              minmod_kernel((U_parent.*field)[pi*AMR_TILE_DIM+pj+1] - v, v - (U_parent.*field)[pi*AMR_TILE_DIM+pj-1]));
                (U_child.*field)[ck] = (RealType)(v + xfrac * vr + yfrac * vz);
            }
        }
    };

    #define PROLONG_CHILD(c) \
        prolongate_node_field(amr_nodes[node_idx].children[c], c, &AMRConservativeTileT<RealType>::rho); \
        prolongate_node_field(amr_nodes[node_idx].children[c], c, &AMRConservativeTileT<RealType>::rhour); \
        prolongate_node_field(amr_nodes[node_idx].children[c], c, &AMRConservativeTileT<RealType>::rhouz); \
        prolongate_node_field(amr_nodes[node_idx].children[c], c, &AMRConservativeTileT<RealType>::E); \
        prolongate_node_field(amr_nodes[node_idx].children[c], c, &AMRConservativeTileT<RealType>::alpha1); \
        prolongate_node_field(amr_nodes[node_idx].children[c], c, &AMRConservativeTileT<RealType>::alpha2); \
        prolongate_node_field(amr_nodes[node_idx].children[c], c, &AMRConservativeTileT<RealType>::arho1); \
        prolongate_node_field(amr_nodes[node_idx].children[c], c, &AMRConservativeTileT<RealType>::arho2);

    PROLONG_CHILD(0) PROLONG_CHILD(1) PROLONG_CHILD(2) PROLONG_CHILD(3)
    #undef PROLONG_CHILD
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

    for (int i = 0; i < 16; ++i) {
        double cell_r = node.r_min + (i + 0.5) * dr_base * factor;
        for (int j = 0; j < 16; ++j) {
            double cell_z = node.z_min + (j + 0.5) * dz_base * factor;
            int k = (i + 2) * AMR_TILE_DIM + (j + 2);

            bool inside_charge = false;
            if (is_cylinder) {
                inside_charge = (cell_r <= explosive_radius) && (std::abs(cell_z - explosive_z) <= charge_height / 2.0);
            } else {
                double dist = std::sqrt(cell_r * cell_r + (cell_z - explosive_z) * (cell_z - explosive_z));
                inside_charge = (dist <= explosive_radius);
            }

            if (inside_charge) {
                if (is_tnt) {
                    U.rho[k] = (RealType)high_rho;
                    U.rhour[k] = 0.0;
                    U.rhouz[k] = 0.0;
                    U.alpha1[k] = 1.0;
                    U.alpha2[k] = 0.0;
                    U.arho1[k] = (RealType)high_rho;
                    U.arho2[k] = 0.0;
                    U.E[k] = (RealType)(high_rho * MultiMat::getEnergy_IdealGas(ambient_p, high_rho, gamma_val));
                } else {
                    U.rho[k] = (RealType)high_rho;
                    U.rhour[k] = 0.0;
                    U.rhouz[k] = 0.0;
                    U.alpha1[k] = 0.0;
                    U.alpha2[k] = 1.0;
                    U.arho1[k] = 0.0;
                    U.arho2[k] = (RealType)high_rho;
                    U.E[k] = (RealType)(high_rho * detonation_energy);
                }
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
    ambient_rho_val = ambient_rho;
    ambient_p_val = ambient_p;
    is_ideal_gas_val = false;

    for (int step = 0; step < amr_max_levels_val - 1; ++step) {
        bool changed = false;
        std::vector<int> to_refine;
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            const auto& node = amr_nodes[n];
            if (node.is_active && node.level < amr_max_levels_val - 1) {
                double dist_z1 = std::max(node.z_min, std::min(explosive_z, node.z_max)) - explosive_z;
                double dist_r1 = std::max(node.r_min, std::min(detonator_r_coord, node.r_max)) - detonator_r_coord;
                double dist = std::sqrt(dist_r1 * dist_r1 + dist_z1 * dist_z1);
                
                if (dist <= explosive_radius * 1.5 ||
                    (detonator_r_coord >= node.r_min && detonator_r_coord <= node.r_max &&
                     detonator_z_coord >= node.z_min && detonator_z_coord <= node.z_max)) {
                    to_refine.push_back(n);
                    changed = true;
                }
            }
        }
        for (int idx : to_refine) refineNodeCPU(idx);
        if (changed) rebuildNeighborPointers();
    }

    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        if (amr_nodes[n].tile_id != -1 && amr_nodes[n].is_active) {
            applyInitialConditionToNode(n, explosive_z, explosive_radius, high_rho, 0.0, ambient_rho, ambient_p, true);
        }
    }

    restrictAllCPU();
    syncTreeToGPU();
    syncPoolsToGPU();
    updatePrimitiveGPU();
    fillGhostCellsGPU();
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::setInitialConditionIdealGas(double explosive_z, double explosive_radius, double high_rho, double detonation_energy, double ambient_rho, double ambient_p) {
    ambient_rho_val = ambient_rho;
    ambient_p_val = ambient_p;
    is_ideal_gas_val = true;

    for (int step = 0; step < amr_max_levels_val - 1; ++step) {
        bool changed = false;
        std::vector<int> to_refine;
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            const auto& node = amr_nodes[n];
            if (node.is_active && node.level < amr_max_levels_val - 1) {
                double dist_z1 = std::max(node.z_min, std::min(explosive_z, node.z_max)) - explosive_z;
                double dist_r1 = std::max(node.r_min, std::min(detonator_r_coord, node.r_max)) - detonator_r_coord;
                double dist = std::sqrt(dist_r1 * dist_r1 + dist_z1 * dist_z1);
                
                if (dist <= explosive_radius * 1.5 ||
                    (detonator_r_coord >= node.r_min && detonator_r_coord <= node.r_max &&
                     detonator_z_coord >= node.z_min && detonator_z_coord <= node.z_max)) {
                    to_refine.push_back(n);
                    changed = true;
                }
            }
        }
        for (int idx : to_refine) refineNodeCPU(idx);
        if (changed) rebuildNeighborPointers();
    }

    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        if (amr_nodes[n].tile_id != -1 && amr_nodes[n].is_active) {
            applyInitialConditionToNode(n, explosive_z, explosive_radius, high_rho, detonation_energy, ambient_rho, ambient_p, false);
        }
    }

    restrictAllCPU();
    syncTreeToGPU();
    syncPoolsToGPU();
    updatePrimitiveGPU();
    fillGhostCellsGPU();
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::setInitialConditionTNTCylinder(double explosive_z, double radius, double height, double high_rho, double ambient_rho, double ambient_p) {
    ambient_rho_val = ambient_rho;
    ambient_p_val = ambient_p;
    is_ideal_gas_val = false;

    for (int step = 0; step < amr_max_levels_val - 1; ++step) {
        bool changed = false;
        std::vector<int> to_refine;
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            const auto& node = amr_nodes[n];
            if (node.is_active && node.level < amr_max_levels_val - 1) {
                double dz = std::max(node.z_min, std::min(explosive_z + height / 2.0, node.z_max)) - (explosive_z + height / 2.0);
                double dr = std::max(node.r_min, std::min(0.0, node.r_max));
                double dist = std::sqrt(dr * dr + dz * dz);

                if (dist <= radius * 1.5 ||
                    (detonator_r_coord >= node.r_min && detonator_r_coord <= node.r_max &&
                     detonator_z_coord >= node.z_min && detonator_z_coord <= node.z_max)) {
                    to_refine.push_back(n);
                    changed = true;
                }
            }
        }
        for (int idx : to_refine) refineNodeCPU(idx);
        if (changed) rebuildNeighborPointers();
    }

    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        if (amr_nodes[n].tile_id != -1 && amr_nodes[n].is_active) {
            applyInitialConditionToNode(n, explosive_z, radius, high_rho, 0.0, ambient_rho, ambient_p, true, true, height);
        }
    }

    restrictAllCPU();
    syncTreeToGPU();
    syncPoolsToGPU();
    updatePrimitiveGPU();
    fillGhostCellsGPU();
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::setInitialConditionFrom1D(double explosive_z, double remap_radius, const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d, double ambient_rho, double ambient_p, double explosive_r) {
    ambient_rho_val = ambient_rho;
    ambient_p_val = ambient_p;
    is_ideal_gas_val = false;

    for (int step = 0; step < amr_max_levels_val - 1; ++step) {
        bool changed = false;
        std::vector<int> to_refine;
        for (size_t n = 0; n < amr_nodes.size(); ++n) {
            const auto& node = amr_nodes[n];
            if (node.is_active && node.level < amr_max_levels_val - 1) {
                double dist_z1 = std::max(node.z_min, std::min(explosive_z, node.z_max)) - explosive_z;
                double dist_r1 = std::max(node.r_min, std::min(explosive_r, node.r_max)) - explosive_r;
                double dist = std::sqrt(dist_r1 * dist_r1 + dist_z1 * dist_z1);

                if (dist <= remap_radius * 1.5 ||
                    (detonator_r_coord >= node.r_min && detonator_r_coord <= node.r_max &&
                     detonator_z_coord >= node.z_min && detonator_z_coord <= node.z_max)) {
                    to_refine.push_back(n);
                    changed = true;
                }
            }
        }
        for (int idx : to_refine) refineNodeCPU(idx);
        if (changed) rebuildNeighborPointers();
    }

    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        const auto& node = amr_nodes[n];
        if (node.tile_id == -1 || !node.is_active) continue;
        auto& U = U_pool[node.tile_id];
        double factor = 1.0 / (1 << node.level);

        for (int i = 0; i < 16; ++i) {
            double cell_r = node.r_min + (i + 0.5) * dr_base * factor;
            for (int j = 0; j < 16; ++j) {
                double cell_z = node.z_min + (j + 0.5) * dz_base * factor;
                double r_dist = std::sqrt((cell_r - explosive_r)*(cell_r - explosive_r) + (cell_z - explosive_z)*(cell_z - explosive_z));
                int k = (i + 2) * AMR_TILE_DIM + (j + 2);

                auto it = std::lower_bound(r_1d.begin(), r_1d.end(), r_dist);
                size_t idx = std::distance(r_1d.begin(), it);
                if (idx >= r_1d.size()) idx = r_1d.size() - 1;

                const auto& state = states_1d[idx];
                U.rho[k] = (RealType)state.rho;
                U.rhour[k] = (RealType)(state.rho * state.u * (cell_r - explosive_r) / (r_dist + 1e-12));
                U.rhouz[k] = (RealType)(state.rho * state.u * (cell_z - explosive_z) / (r_dist + 1e-12));
                U.E[k] = (RealType)(state.p / (gamma_val - 1.0) + 0.5 * state.rho * state.u * state.u);
                U.alpha1[k] = (RealType)state.alpha1;
                U.alpha2[k] = (RealType)state.alpha2;
                U.arho1[k] = (RealType)state.arho1;
                U.arho2[k] = (RealType)state.arho2;
            }
        }
    }

    restrictAllCPU();
    syncTreeToGPU();
    syncPoolsToGPU();
    updatePrimitiveGPU();
    fillGhostCellsGPU();
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
        updateConservativeRKStage_AMR_kernel<RealType><<<active_leaves_count, dim3(16, 16)>>>(
            d_active_tile_ids, active_leaves_count, d_U_pool, d_dU_pool, (RealType)dt
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
    adaptMeshCPU();
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
    // Standard dt calculation performed on CPU to guarantee precision & tree level bounds
    syncPoolsToCPU();
    double min_dt = 1e20;
    double cfl = 0.35;

    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        const auto& node = amr_nodes[n];
        if (node.tile_id != -1 && node.is_active) {
            double factor = 1.0 / (1 << node.level);
            double dr = dr_base * factor;
            double dz = dz_base * factor;
            const auto& S = states_pool[node.tile_id];

            for (int i = 0; i < 16; ++i) {
                int ti = i + 2;
                for (int j = 0; j < 16; ++j) {
                    int tj = j + 2;
                    int k = ti * AMR_TILE_DIM + tj;
                    if (S.rho[k] < 1e-10) continue;
                    double c;
                    if (is_ideal_gas_val) {
                        c = std::sqrt(gamma_val * S.p[k] / S.rho[k]);
                    } else {
                        c = MultiMat::getMixtureSoundSpeed(S.p[k], S.rho[k], S.alpha1[k], S.alpha2[k], S.arho1[k], S.arho2[k], (RealType)gamma_val, materials_val.products, materials_val.unreacted);
                    }
                    double speed_r = std::abs(S.ur[k]) + c;
                    double speed_z = std::abs(S.uz[k]) + c;
                    double cell_dt = cfl * std::min(dr / (speed_r + 1e-12), dz / (speed_z + 1e-12));
                    if (cell_dt < min_dt) min_dt = cell_dt;
                }
            }
        }
    }
    return min_dt;
}

template <typename RealType>
bool CFDSolver2DAMRCudaImpl<RealType>::checkTerminationCondition() {
    syncPoolsToCPU();
    double threshold = 1.05 * ambient_p_val;
    for (size_t n = 0; n < amr_nodes.size(); ++n) {
        const auto& node = amr_nodes[n];
        if (node.tile_id != -1 && node.is_active) {
            const auto& S = states_pool[node.tile_id];

            if (bc_r_min == static_cast<CFDSolver2DCuda::BCType>(CFDSolver2D::OUTFLOW_RIEMANN) && node.r_min <= 1e-5) {
                int ti = 2; // Innermost boundary interior cell
                for (int j = 0; j < 16; ++j) {
                    int tj = j + 2;
                    int k = ti * AMR_TILE_DIM + tj;
                    if (S.p[k] > threshold) return true;
                }
            }
            if (bc_r_max == static_cast<CFDSolver2DCuda::BCType>(CFDSolver2D::OUTFLOW_RIEMANN) && node.r_max >= max_r_coord - 1e-5) {
                int ti = 17; // Outermost boundary interior cell
                for (int j = 0; j < 16; ++j) {
                    int tj = j + 2;
                    int k = ti * AMR_TILE_DIM + tj;
                    if (S.p[k] > threshold) return true;
                }
            }
            if (bc_z_min == static_cast<CFDSolver2DCuda::BCType>(CFDSolver2D::OUTFLOW_RIEMANN) && node.z_min <= 1e-5) {
                int tj = 2; // Innermost boundary interior cell
                for (int i = 0; i < 16; ++i) {
                    int ti = i + 2;
                    int k = ti * AMR_TILE_DIM + tj;
                    if (S.p[k] > threshold) return true;
                }
            }
            if (bc_z_max == static_cast<CFDSolver2DCuda::BCType>(CFDSolver2D::OUTFLOW_RIEMANN) && node.z_max >= max_z_coord - 1e-5) {
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
    syncPoolsToCPU();
    std::vector<State2D> states(level0_nr * level0_nz);
    double dr = dr_base;
    double dz = dz_base;

    for (int i = 0; i < level0_nr; ++i) {
        for (int j = 0; j < level0_nz; ++j) {
            double cell_r = (i + 0.5) * dr;
            double cell_z = (j + 0.5) * dz;

            int best_node = -1;
            int best_level = -1;
            for (size_t n = 0; n < amr_nodes.size(); ++n) {
                const auto& node = amr_nodes[n];
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

            int idx = i * level0_nz + j;
            if (best_node == -1) {
                states[idx] = { (float)ambient_rho_val, 0.0f, 0.0f, (float)ambient_p_val, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f };
            } else {
                const auto& node = amr_nodes[best_node];
                const auto& S = states_pool[node.tile_id];
                double factor = 1.0 / (1 << node.level);
                int local_i = (int)((cell_r - node.r_min) / (dr_base * factor));
                int local_j = (int)((cell_z - node.z_min) / (dz_base * factor));
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
    std::vector<State2D> states = getStates();
    int idx = i * level0_nz + j;
    if (idx >= (int)states.size()) return std::vector<float>(8, 0.0f);
    const auto& s = states[idx];
    return { (float)s.rho, (float)s.ur, (float)s.uz, (float)s.p, (float)s.alpha1, (float)s.alpha2, (float)s.arho1, (float)s.arho2 };
}

template <typename RealType>
std::vector<float> CFDSolver2DAMRCudaImpl<RealType>::getTelemetry2D(int stride) {
    syncPoolsToCPU();
    std::vector<float> data;
    uint32_t num_leaves = 0;
    for (const auto& node : amr_nodes) {
        if (node.tile_id != -1 && node.is_active) num_leaves++;
    }

    uint32_t n_channels = 7;
    data.push_back(*(float*)&num_leaves);
    data.push_back(*(float*)&n_channels);

    for (const auto& node : amr_nodes) {
        if (node.tile_id != -1 && node.is_active) {
            const auto& S = states_pool[node.tile_id];
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
    return states_pool.size() * (sizeof(AMRPrimitiveTileT<RealType>) + 2 * sizeof(AMRConservativeTileT<RealType>));
}

template <typename RealType>
void CFDSolver2DAMRCudaImpl<RealType>::exportVTK(const std::string& filename) {
    // 1. Sync pools to CPU to get latest cell data
    syncPoolsToCPU();

    // 2. Count active leaf cells
    std::vector<int> leaf_indices;
    for (int idx = 0; idx < (int)amr_nodes.size(); ++idx) {
        if (amr_nodes[idx].is_active) {
            leaf_indices.push_back(idx);
        }
    }

    int num_cells = leaf_indices.size() * 256;
    int num_points = num_cells * 4;

    std::vector<double> points;
    points.reserve(num_points * 3);

    std::vector<int32_t> connectivity;
    connectivity.reserve(num_cells * 4);

    std::vector<int32_t> offsets;
    offsets.reserve(num_cells);

    std::vector<uint8_t> types(num_cells, 9); // VTK_QUAD

    std::vector<double> rho;
    rho.reserve(num_cells);
    std::vector<double> ur;
    ur.reserve(num_cells);
    std::vector<double> uz;
    uz.reserve(num_cells);
    std::vector<double> p;
    p.reserve(num_cells);
    std::vector<double> level;
    level.reserve(num_cells);

    int cell_global_idx = 0;

    for (int node_idx : leaf_indices) {
        const auto& node = amr_nodes[node_idx];
        const auto& S = states_pool[node.tile_id];

        double factor = 1.0 / (1 << node.level);
        double dr = dr_base * factor;
        double dz = dz_base * factor;

        double tile_r_min = node.r_idx * 16 * dr;
        double tile_z_min = node.z_idx * 16 * dz;

        for (int i = 0; i < 16; ++i) {
            double c_rMin = tile_r_min + i * dr;
            double c_rMax = tile_r_min + (i + 1) * dr;
            int ti = i + 2;

            for (int j = 0; j < 16; ++j) {
                double c_zMin = tile_z_min + j * dz;
                double c_zMax = tile_z_min + (j + 1) * dz;
                int tj = j + 2;
                int k = ti * AMR_TILE_DIM + tj;

                // Add 4 corner points
                points.push_back(c_rMin); points.push_back(c_zMin); points.push_back(0.0);
                points.push_back(c_rMax); points.push_back(c_zMin); points.push_back(0.0);
                points.push_back(c_rMax); points.push_back(c_zMax); points.push_back(0.0);
                points.push_back(c_rMin); points.push_back(c_zMax); points.push_back(0.0);

                // Add connectivity
                int p0 = cell_global_idx * 4;
                connectivity.push_back(p0);
                connectivity.push_back(p0 + 1);
                connectivity.push_back(p0 + 2);
                connectivity.push_back(p0 + 3);

                offsets.push_back(p0 + 4);

                // Add cell data
                rho.push_back((double)S.rho[k]);
                ur.push_back((double)S.ur[k]);
                uz.push_back((double)S.uz[k]);
                p.push_back((double)S.p[k]);
                level.push_back((double)node.level);

                cell_global_idx++;
            }
        }
    }

    export_vtu_amr_2d(filename, points, connectivity, offsets, types, rho, ur, uz, p, level);
}

// Explicit instantiation for float and double
template class CFDSolver2DAMRCudaImpl<float>;
template class CFDSolver2DAMRCudaImpl<double>;
