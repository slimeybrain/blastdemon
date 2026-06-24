#include <cuda_runtime.h>
#include <device_launch_parameters.h>
#include <math.h>

/**
 * JWL Equation of State reference values
 */
#define JWL_RHO_TNT 1630.0f
#define JWL_E0_TNT 4.29e6f

__global__ void stamp_explosives_kernel(
    float* d_density,
    float* d_energy,
    const float* d_exp_x,
    const float* d_exp_y,
    const float* d_exp_mass,
    int num_explosives,
    int nx,
    int ny,
    float dx,
    float dy
) {
    int ix = blockIdx.x * blockDim.x + threadIdx.x;
    int iy = blockIdx.y * blockDim.y + threadIdx.y;

    if (ix >= nx || iy >= ny) return;

    int idx = iy * nx + ix;
    float px = ix * dx;
    float py = iy * dy;

    for (int i = 0; i < num_explosives; ++i) {
        float ex = d_exp_x[i];
        float ey = d_exp_y[i];
        float mass = d_exp_mass[i];

        // Deriving radius from mass: M = rho * (4/3 * PI * R^3) => R = (3M / (4 * PI * rho))^(1/3)
        // For 2D stamping, we use R = sqrt(M / (PI * rho * thickness))
        float radius = sqrtf(mass / (3.14159f * JWL_RHO_TNT));

        float dist = sqrtf((px - ex) * (px - ex) + (py - ey) * (py - ey));

        if (dist <= radius) {
            d_density[idx] = JWL_RHO_TNT;
            d_energy[idx] = JWL_E0_TNT;
        }
    }
}
