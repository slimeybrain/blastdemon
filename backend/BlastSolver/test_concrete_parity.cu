#include <iostream>
#include <vector>
#include <cmath>
#include <cassert>
#include <cuda_runtime.h>
#include "constitutive_concrete_models.hpp"
#include "mpm_solver_3d.hpp"

using namespace Blast;

template <typename Real>
__global__ void kernelTestConcreteStress(
    Real* d_sig,
    const Real* d_deps,
    Real* d_ep,
    Real* d_lambda,
    Real* d_damage,
    MaterialTable3D mat,
    Real dt,
    Real h_c,
    int model_type, // 0 = RHT, 1 = KC, 2 = CSCM
    int num_points
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_points) return;

    Real sig[6];
    Real deps[6];
    for (int k = 0; k < 6; ++k) {
        sig[k] = d_sig[idx * 6 + k];
        deps[k] = d_deps[idx * 6 + k];
    }
    Real ep = d_ep[idx];
    Real lambda = d_lambda[idx];
    Real damage = d_damage[idx];

    if (model_type == 0) {
        ConcreteModels::updateRHTStress<Real>(sig, deps, ep, damage, mat, dt, h_c);
    } else if (model_type == 1) {
        ConcreteModels::updateKCStress<Real>(sig, deps, ep, lambda, damage, mat, dt, h_c);
    } else if (model_type == 2) {
        Real eps_v_p = 0;
        ConcreteModels::updateCSCMStress<Real>(sig, deps, ep, lambda, eps_v_p, damage, mat, dt, h_c);
    }

    for (int k = 0; k < 6; ++k) {
        d_sig[idx * 6 + k] = sig[k];
    }
    d_ep[idx] = ep;
    d_lambda[idx] = lambda;
    d_damage[idx] = damage;
}

template <typename Real>
void runParityTest(const std::string& model_name, int model_type) {
    std::cout << "Testing CPU vs GPU Parity for " << model_name << " (" << (sizeof(Real) == 4 ? "Float" : "Double") << ")..." << std::endl;

    MaterialTable3D mat;
    mat.density = 2400.0f;
    mat.youngs_modulus = 30.0e9f;
    mat.poissons_ratio = 0.20f;
    mat.fc = 30.0e6f;
    mat.ft = 3.0e6f;
    mat.G_f = 100.0f;
    mat.dif_cap_compression = 2.5f;
    mat.dif_cap_tension = 5.0f;

    mat.rht_A = 1.60f; mat.rht_N = 0.61f; mat.rht_B = 0.70f; mat.rht_M = 0.80f;
    mat.rht_Q0 = 0.68f; mat.rht_BQ = 0.0105f; mat.rht_D1 = 0.04f; mat.rht_D2 = 1.0f;
    mat.rht_p_crush = 10.0e6f; mat.rht_p_lock = 6.0e9f; mat.rht_alpha0 = 1.25f; mat.rht_n_comp = 3.0f;

    mat.kc_auto_generate = true;
    mat.kc_a0 = 10.0e6f; mat.kc_a1 = 0.44f; mat.kc_a2 = 0.77e-9f;
    mat.kc_a0y = 8.0e6f; mat.kc_a1y = 0.35f; mat.kc_a2y = 0.62e-9f;
    mat.kc_a1r = 0.25f; mat.kc_a2r = 0.50e-9f; mat.kc_b1 = 1.60f; mat.kc_omega = 0.50f;

    mat.cscm_alpha = 10.5e6f; mat.cscm_theta = 0.40f; mat.cscm_lambda = 7.0e6f; mat.cscm_beta = 1.5e-8f;
    mat.cscm_R = 4.0f; mat.cscm_X0 = 85.0e6f; mat.cscm_W = 0.05f; mat.cscm_D1 = 2.5e-9f; mat.cscm_D2 = 1.0f;

    const int num_points = 512;
    const int num_steps = 100;
    Real dt = static_cast<Real>(1.0e-5);
    Real h_c = static_cast<Real>(0.01);

    std::vector<Real> cpu_sig(num_points * 6, 0);
    std::vector<Real> cpu_deps(num_points * 6, 0);
    std::vector<Real> cpu_ep(num_points, 0);
    std::vector<Real> cpu_lambda(num_points, 0);
    std::vector<Real> cpu_damage(num_points, 0);

    for (int i = 0; i < num_points; ++i) {
        Real rate = static_cast<Real>(1.0 + (i % 20) * 5.0); // vary strain rate across points
        Real de_axial = (i % 2 == 0) ? -rate * dt : rate * dt * static_cast<Real>(0.1);
        cpu_deps[i * 6 + 0] = de_axial;
        cpu_deps[i * 6 + 1] = -mat.poissons_ratio * de_axial;
        cpu_deps[i * 6 + 2] = -mat.poissons_ratio * de_axial;
    }

    std::vector<Real> gpu_sig = cpu_sig;
    std::vector<Real> gpu_deps = cpu_deps;
    std::vector<Real> gpu_ep = cpu_ep;
    std::vector<Real> gpu_lambda = cpu_lambda;
    std::vector<Real> gpu_damage = cpu_damage;

    // Run CPU loop
    for (int s = 0; s < num_steps; ++s) {
        for (int i = 0; i < num_points; ++i) {
            Real sig[6];
            Real deps[6];
            for (int k = 0; k < 6; ++k) {
                sig[k] = cpu_sig[i * 6 + k];
                deps[k] = cpu_deps[i * 6 + k];
            }
            Real ep = cpu_ep[i];
            Real lambda = cpu_lambda[i];
            Real damage = cpu_damage[i];

            if (model_type == 0) {
                ConcreteModels::updateRHTStress<Real>(sig, deps, ep, damage, mat, dt, h_c);
            } else if (model_type == 1) {
                ConcreteModels::updateKCStress<Real>(sig, deps, ep, lambda, damage, mat, dt, h_c);
            } else if (model_type == 2) {
                Real eps_v_p = 0;
                ConcreteModels::updateCSCMStress<Real>(sig, deps, ep, lambda, eps_v_p, damage, mat, dt, h_c);
            }

            for (int k = 0; k < 6; ++k) cpu_sig[i * 6 + k] = sig[k];
            cpu_ep[i] = ep;
            cpu_lambda[i] = lambda;
            cpu_damage[i] = damage;
        }
    }

    // Run GPU loop
    Real* d_sig;
    Real* d_deps;
    Real* d_ep;
    Real* d_lambda;
    Real* d_damage;

    cudaMalloc(&d_sig, num_points * 6 * sizeof(Real));
    cudaMalloc(&d_deps, num_points * 6 * sizeof(Real));
    cudaMalloc(&d_ep, num_points * sizeof(Real));
    cudaMalloc(&d_lambda, num_points * sizeof(Real));
    cudaMalloc(&d_damage, num_points * sizeof(Real));

    cudaMemcpy(d_sig, gpu_sig.data(), num_points * 6 * sizeof(Real), cudaMemcpyHostToDevice);
    cudaMemcpy(d_deps, gpu_deps.data(), num_points * 6 * sizeof(Real), cudaMemcpyHostToDevice);
    cudaMemcpy(d_ep, gpu_ep.data(), num_points * sizeof(Real), cudaMemcpyHostToDevice);
    cudaMemcpy(d_lambda, gpu_lambda.data(), num_points * sizeof(Real), cudaMemcpyHostToDevice);
    cudaMemcpy(d_damage, gpu_damage.data(), num_points * sizeof(Real), cudaMemcpyHostToDevice);

    int blockSize = 128;
    int numBlocks = (num_points + blockSize - 1) / blockSize;

    for (int s = 0; s < num_steps; ++s) {
        kernelTestConcreteStress<Real><<<numBlocks, blockSize>>>(
            d_sig, d_deps, d_ep, d_lambda, d_damage, mat, dt, h_c, model_type, num_points
        );
    }
    cudaDeviceSynchronize();

    cudaMemcpy(gpu_sig.data(), d_sig, num_points * 6 * sizeof(Real), cudaMemcpyDeviceToHost);
    cudaMemcpy(gpu_ep.data(), d_ep, num_points * sizeof(Real), cudaMemcpyDeviceToHost);
    cudaMemcpy(gpu_lambda.data(), d_lambda, num_points * sizeof(Real), cudaMemcpyDeviceToHost);
    cudaMemcpy(gpu_damage.data(), d_damage, num_points * sizeof(Real), cudaMemcpyDeviceToHost);

    cudaFree(d_sig);
    cudaFree(d_deps);
    cudaFree(d_ep);
    cudaFree(d_lambda);
    cudaFree(d_damage);

    // Check Parity
    Real max_stress_diff = 0;
    Real max_damage_diff = 0;
    for (int i = 0; i < num_points; ++i) {
        for (int k = 0; k < 6; ++k) {
            Real diff = std::abs(cpu_sig[i * 6 + k] - gpu_sig[i * 6 + k]);
            if (diff > max_stress_diff) max_stress_diff = diff;
        }
        Real d_diff = std::abs(cpu_damage[i] - gpu_damage[i]);
        if (d_diff > max_damage_diff) max_damage_diff = d_diff;
    }

    std::cout << "  Max Stress Difference: " << max_stress_diff << " Pa, Max Damage Difference: " << max_damage_diff << std::endl;
    Real tol = sizeof(Real) == 4 ? static_cast<Real>(1.0e-2) : static_cast<Real>(1.0e-5);
    Real stress_tol = sizeof(Real) == 4 ? static_cast<Real>(1.0e4) : static_cast<Real>(1.0); // 10 kPa for float (0.01% of 100 MPa), 1 Pa for double
    assert(max_damage_diff < tol);
    assert(max_stress_diff < stress_tol);
    std::cout << "  [PASS] CPU vs GPU Parity for " << model_name << " verified.\n" << std::endl;
}

int main() {
    std::cout << "=================================================================" << std::endl;
    std::cout << "   BlastSolver Concrete CPU vs GPU Parity Tests                  " << std::endl;
    std::cout << "=================================================================\n" << std::endl;

    int deviceCount = 0;
    cudaGetDeviceCount(&deviceCount);
    if (deviceCount == 0) {
        std::cout << "No CUDA device available. Skipping GPU parity test." << std::endl;
        return 0;
    }

    // 1. RHT
    runParityTest<float>("RHT Concrete", 0);
    runParityTest<double>("RHT Concrete", 0);

    // 2. K&C
    runParityTest<float>("Karagozian & Case (K&C)", 1);
    runParityTest<double>("Karagozian & Case (K&C)", 1);

    // 3. CSCM
    runParityTest<float>("CSCM Concrete", 2);
    runParityTest<double>("CSCM Concrete", 2);

    std::cout << "=================================================================" << std::endl;
    std::cout << "   ALL CONCRETE CPU vs GPU PARITY TESTS PASSED!                 " << std::endl;
    std::cout << "=================================================================" << std::endl;
    return 0;
}
