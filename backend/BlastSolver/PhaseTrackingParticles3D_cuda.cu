#include "PhaseTrackingParticles3D.hpp"
#include "cfd_tile.hpp"
#include <cuda_runtime.h>
#include <iostream>

#define CHECK_CUDA_TRACKER(call) do { \
    cudaError_t err = call; \
    if (err != cudaSuccess) { \
        std::cerr << "[CUDA PhaseTracker Error] " << cudaGetErrorString(err) \
                  << " at " << __FILE__ << ":" << __LINE__ << std::endl; \
    } \
} while(0)

namespace Blast {

// Trilinear interpolation device function from tiled CFD primitive velocity states + exact divergence
template <typename RealType, bool IsMultiMaterial>
__device__ inline void sample_cfd_velocity_and_div_gpu(
    float px, float py, float pz,
    const PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    int nx, int ny, int nz, int ntx, int nty,
    float dx, float dy, float dz,
    float xmin, float ymin, float zmin,
    float& u_out, float& v_out, float& w_out, float& div_out
) {
    float fx = (px - xmin) / dx - 0.5f;
    float fy = (py - ymin) / dy - 0.5f;
    float fz = (pz - zmin) / dz - 0.5f;

    int i = max(0, min(static_cast<int>(floorf(fx)), nx - 2));
    int j = max(0, min(static_cast<int>(floorf(fy)), ny - 2));
    int k = max(0, min(static_cast<int>(floorf(fz)), nz - 2));

    float wx1 = fmaxf(0.0f, fminf(1.0f, fx - static_cast<float>(i)));
    float wy1 = fmaxf(0.0f, fminf(1.0f, fy - static_cast<float>(j)));
    float wz1 = fmaxf(0.0f, fminf(1.0f, fz - static_cast<float>(k)));
    float wx0 = 1.0f - wx1;
    float wy0 = 1.0f - wy1;
    float wz0 = 1.0f - wz1;

    auto sample_at = [&](int gx, int gy, int gz, float& u, float& v, float& w) {
        int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
        int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;
        u = static_cast<float>(d_states[t_idx].ux[c_idx]);
        v = static_cast<float>(d_states[t_idx].uy[c_idx]);
        w = static_cast<float>(d_states[t_idx].uz[c_idx]);
    };

    float u000, v000, w000, u100, v100, w100;
    float u010, v010, w010, u110, v110, w110;
    float u001, v001, w001, u101, v101, w101;
    float u011, v011, w011, u111, v111, w111;

    sample_at(i, j, k, u000, v000, w000);
    sample_at(i+1, j, k, u100, v100, w100);
    sample_at(i, j+1, k, u010, v010, w010);
    sample_at(i+1, j+1, k, u110, v110, w110);
    sample_at(i, j, k+1, u001, v001, w001);
    sample_at(i+1, j, k+1, u101, v101, w101);
    sample_at(i, j+1, k+1, u011, v011, w011);
    sample_at(i+1, j+1, k+1, u111, v111, w111);

    float w000_w = wx0 * wy0 * wz0; float w100_w = wx1 * wy0 * wz0;
    float w010_w = wx0 * wy1 * wz0; float w110_w = wx1 * wy1 * wz0;
    float w001_w = wx0 * wy0 * wz1; float w101_w = wx1 * wy0 * wz1;
    float w011_w = wx0 * wy1 * wz1; float w111_w = wx1 * wy1 * wz1;

    u_out = w000_w * u000 + w100_w * u100 + w010_w * u010 + w110_w * u110 +
            w001_w * u001 + w101_w * u101 + w011_w * u011 + w111_w * u111;
    v_out = w000_w * v000 + w100_w * v100 + w010_w * v010 + w110_w * v110 +
            w001_w * v001 + w101_w * v101 + w011_w * v011 + w111_w * v111;
    w_out = w000_w * w000 + w100_w * w100 + w010_w * w010 + w110_w * w110 +
            w001_w * w001 + w101_w * w101 + w011_w * w011 + w111_w * w111;

    // Exact analytical velocity gradient and divergence
    float du_dx = (1.0f / dx) * (wy0 * wz0 * (u100 - u000) + wy1 * wz0 * (u110 - u010) +
                                 wy0 * wz1 * (u101 - u001) + wy1 * wz1 * (u111 - u011));
    float dv_dy = (1.0f / dy) * (wx0 * wz0 * (v010 - v000) + wx1 * wz0 * (v110 - v100) +
                                 wx0 * wz1 * (v011 - v001) + wx1 * wz1 * (v111 - v101));
    float dw_dz = (1.0f / dz) * (wx0 * wy0 * (w001 - w000) + wx1 * wy0 * (w101 - w100) +
                                 wx0 * wy1 * (w011 - w010) + wx1 * wy1 * (w111 - w110));

    div_out = du_dx + dv_dy + dw_dz;
}

// 2nd-Order Runge-Kutta advection kernel for phase tracking particles on GPU with divergence-conforming volume
template <typename RealType, bool IsMultiMaterial>
__global__ void kernel_advect_phase_particles_rk2_gpu(
    float* px, float* py, float* pz,
    float* pvx, float* pvy, float* pvz,
    float* pV,
    const uint8_t* active,
    int num_particles,
    float dt,
    const PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    int nx, int ny, int nz, int ntx, int nty,
    float dx, float dy, float dz,
    float xmin, float ymin, float zmin
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_particles || !active[idx]) return;

    float x0 = px[idx];
    float y0 = py[idx];
    float z0 = pz[idx];

    // Predictor at t + dt/2
    float u1 = 0.0f, v1 = 0.0f, w1 = 0.0f, div1 = 0.0f;
    sample_cfd_velocity_and_div_gpu(x0, y0, z0, d_states, nx, ny, nz, ntx, nty, dx, dy, dz, xmin, ymin, zmin, u1, v1, w1, div1);

    float x_mid = x0 + 0.5f * dt * u1;
    float y_mid = y0 + 0.5f * dt * v1;
    float z_mid = z0 + 0.5f * dt * w1;

    // Corrector at midpoint velocity
    float u2 = 0.0f, v2 = 0.0f, w2 = 0.0f, div2 = 0.0f;
    sample_cfd_velocity_and_div_gpu(x_mid, y_mid, z_mid, d_states, nx, ny, nz, ntx, nty, dx, dy, dz, xmin, ymin, zmin, u2, v2, w2, div2);

    px[idx] = x0 + dt * u2;
    py[idx] = y0 + dt * v2;
    pz[idx] = z0 + dt * w2;

    pvx[idx] = u2;
    pvy[idx] = v2;
    pvz[idx] = w2;

    // Divergence-conforming volume evolution: dV/dt = V * div(u)
    float dlnV = fmaxf(-5.0f, fminf(5.0f, dt * div2));
    pV[idx] *= expf(dlnV);
}

// Adaptive particle splitting for expanding gas phase
__global__ void kernel_split_phase_particles_gpu(
    float* px, float* py, float* pz,
    float* pvx, float* pvy, float* pvz,
    float* pV, float* pV0, float* pm,
    uint8_t* phase_id, uint8_t* active,
    int num_particles, int max_capacity,
    float split_vol_factor,
    int* d_particle_count
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_particles || !active[idx]) return;

    if (phase_id[idx] == static_cast<uint8_t>(TrackingPhaseID::DetonationGas) &&
        pV[idx] > split_vol_factor * pV0[idx]) {

        int new_idx = atomicAdd(d_particle_count, 1);
        if (new_idx < max_capacity) {
            float half_v = 0.5f * pV[idx];
            float half_m = 0.5f * pm[idx];
            pV[idx] = half_v;
            pm[idx] = half_m;

            pV[new_idx] = half_v;
            pm[new_idx] = half_m;
            pV0[new_idx] = pV0[idx];
            pvx[new_idx] = pvx[idx];
            pvy[new_idx] = pvy[idx];
            pvz[new_idx] = pvz[idx];
            phase_id[new_idx] = phase_id[idx];
            active[new_idx] = 1;

            float offset = 0.25f * cbrtf(half_v);
            px[new_idx] = px[idx] + offset;
            py[new_idx] = py[idx];
            pz[new_idx] = pz[idx];
            px[idx] -= offset;
        }
    }
}

// Smooth C0 trilinear particle volume accumulation across 8 cell centers
__global__ void kernel_accumulate_phase_particle_volumes_gpu(
    const float* px, const float* py, const float* pz,
    const float* pV,
    const uint8_t* phase_id,
    const uint8_t* active,
    int num_particles,
    float* d_V_gas, float* d_V_he, float* d_V_tot,
    int nx, int ny, int nz,
    float dx, float dy, float dz,
    float xmin, float ymin, float zmin,
    float r_sleeve_sq, float cx, float cy, float cz
) {
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= num_particles || !active[idx]) return;

    float x = px[idx]; float y = py[idx]; float z = pz[idx];
    float rx = x - cx, ry = y - cy, rz = z - cz;
    if (rx*rx + ry*ry + rz*rz > r_sleeve_sq) return;

    float fx = (x - xmin) / dx - 0.5f;
    float fy = (y - ymin) / dy - 0.5f;
    float fz = (z - zmin) / dz - 0.5f;

    int i = max(0, min(static_cast<int>(floorf(fx)), nx - 2));
    int j = max(0, min(static_cast<int>(floorf(fy)), ny - 2));
    int k = max(0, min(static_cast<int>(floorf(fz)), nz - 2));

    float wx1 = fmaxf(0.0f, fminf(1.0f, fx - static_cast<float>(i)));
    float wy1 = fmaxf(0.0f, fminf(1.0f, fy - static_cast<float>(j)));
    float wz1 = fmaxf(0.0f, fminf(1.0f, fz - static_cast<float>(k)));
    float wx0 = 1.0f - wx1;
    float wy0 = 1.0f - wy1;
    float wz0 = 1.0f - wz1;

    float vol = pV[idx];
    uint8_t pid = phase_id[idx];
    bool is_gas = (pid == static_cast<uint8_t>(TrackingPhaseID::DetonationGas));
    bool is_he  = (pid == static_cast<uint8_t>(TrackingPhaseID::UnreactedExplosive));

    #pragma unroll
    for (int di = 0; di <= 1; ++di) {
        float wx = di ? wx1 : wx0;
        int ci = i + di;
        #pragma unroll
        for (int dj = 0; dj <= 1; ++dj) {
            float wy = dj ? wy1 : wy0;
            int cj = j + dj;
            #pragma unroll
            for (int dk = 0; dk <= 1; ++dk) {
                float wz = dk ? wz1 : wz0;
                int ck = k + dk;
                float w = wx * wy * wz;
                float dV = w * vol;

                size_t c_idx = (static_cast<size_t>(ci) * ny + cj) * nz + ck;
                atomicAdd(&d_V_tot[c_idx], dV);
                if (is_gas) {
                    atomicAdd(&d_V_gas[c_idx], dV);
                } else if (is_he) {
                    atomicAdd(&d_V_he[c_idx], dV);
                }
            }
        }
    }
}

// Remap accumulated volumes into CFD Primitive and Conservative Tiles
// Thermodynamically consistent state update (Abgrall Invariance)
template <typename RealType, bool IsMultiMaterial>
__global__ void kernel_apply_phase_remap_to_cfd_tiles_gpu(
    PrimitiveTile3D<RealType, IsMultiMaterial>* d_states,
    ConservativeTile3D<RealType, IsMultiMaterial>* d_U,
    const float* d_V_gas, const float* d_V_he, const float* d_V_tot,
    int nx, int ny, int nz, int ntx, int nty,
    float cell_vol,
    float rho1_nominal, float rho2_nominal,
    float rho0_water, float water_B, float water_gamma
) {
    (void)water_B;
    (void)water_gamma;
    int idx = blockIdx.x * blockDim.x + threadIdx.x;
    int total_cells = nx * ny * nz;
    if (idx >= total_cells) return;

    float tot = d_V_tot[idx];
    if (tot <= 1.0e-12f * cell_vol) return;

    int gx = idx / (ny * nz);
    int gy = (idx / nz) % ny;
    int gz = idx % nz;

    int t_idx = (gx >> 3) + (gy >> 3) * ntx + (gz >> 3) * ntx * nty;
    int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

    float a1_part = d_V_gas[idx] / tot;
    float a2_part = d_V_he[idx] / tot;

    float w_part = fminf(1.0f, fmaxf(0.0f, tot / cell_vol));

    float a1_old = static_cast<float>(d_states[t_idx].alpha1[c_idx]);
    float a2_old = static_cast<float>(d_states[t_idx].alpha2[c_idx]);

    float a1_new = w_part * a1_part + (1.0f - w_part) * a1_old;
    float a2_new = w_part * a2_part + (1.0f - w_part) * a2_old;

    float sum_a = a1_new + a2_new;
    if (sum_a > 1.0f) {
        a1_new /= sum_a;
        a2_new /= sum_a;
    }
    float a0_new = fmaxf(0.0f, 1.0f - a1_new - a2_new);

    float cell_rho = static_cast<float>(d_states[t_idx].rho[c_idx]);
    float arho1_old = static_cast<float>(d_states[t_idx].arho1[c_idx]);
    float arho2_old = static_cast<float>(d_states[t_idx].arho2[c_idx]);

    // Current intrinsic material densities
    float gas_rho_cur = (a1_old > 1.0e-4f) ? (arho1_old / a1_old) : fminf(cell_rho, rho1_nominal);
    float he_rho_cur  = (a2_old > 1.0e-4f) ? (arho2_old / a2_old) : fminf(cell_rho, rho2_nominal);
    gas_rho_cur = fmaxf(1.0e-4f, gas_rho_cur);
    he_rho_cur  = fmaxf(1.0e-4f, he_rho_cur);

    // Intrinsic liquid water density: strictly preserve equilibrium water density
    float a0_old = fmaxf(0.0f, 1.0f - a1_old - a2_old);
    float water_rho_cur = (a0_old > 1.0e-4f) ? ((cell_rho - arho1_old - arho2_old) / a0_old) : rho0_water;
    water_rho_cur = fmaxf(0.95f * rho0_water, fminf(1.10f * rho0_water, water_rho_cur));

    float arho1_new = (a1_new > 0.0f) ? (a1_new * gas_rho_cur) : 0.0f;
    float arho2_new = (a2_new > 0.0f) ? (a2_new * he_rho_cur) : 0.0f;
    float arho0_new = (a0_new > 0.0f) ? (a0_new * water_rho_cur) : 0.0f;

    // Thermodynamically consistent mixture density
    float rho_new = arho0_new + arho1_new + arho2_new;

    d_states[t_idx].alpha1[c_idx] = static_cast<RealType>(a1_new);
    d_states[t_idx].alpha2[c_idx] = static_cast<RealType>(a2_new);
    d_states[t_idx].arho1[c_idx]  = static_cast<RealType>(arho1_new);
    d_states[t_idx].arho2[c_idx]  = static_cast<RealType>(arho2_new);
    d_states[t_idx].rho[c_idx]    = static_cast<RealType>(rho_new);

    if (d_U) {
        d_U[t_idx].alpha1[c_idx] = static_cast<RealType>(a1_new);
        d_U[t_idx].alpha2[c_idx] = static_cast<RealType>(a2_new);
        d_U[t_idx].arho1[c_idx]  = static_cast<RealType>(arho1_new);
        d_U[t_idx].arho2[c_idx]  = static_cast<RealType>(arho2_new);
        d_U[t_idx].rho[c_idx]    = static_cast<RealType>(rho_new);

        float ux = static_cast<float>(d_states[t_idx].ux[c_idx]);
        float uy = static_cast<float>(d_states[t_idx].uy[c_idx]);
        float uz = static_cast<float>(d_states[t_idx].uz[c_idx]);
        d_U[t_idx].rhoux[c_idx] = static_cast<RealType>(rho_new * ux);
        d_U[t_idx].rhouy[c_idx] = static_cast<RealType>(rho_new * uy);
        d_U[t_idx].rhouz[c_idx] = static_cast<RealType>(rho_new * uz);

        float old_E = static_cast<float>(d_U[t_idx].E[c_idx]);
        float old_E_kin = 0.5f * cell_rho * (ux*ux + uy*uy + uz*uz);
        float old_E_int = fmaxf(1.0e-3f, old_E - old_E_kin);

        float new_E_kin = 0.5f * rho_new * (ux*ux + uy*uy + uz*uz);
        float new_E_int = old_E_int * (rho_new / fmaxf(1.0e-4f, cell_rho));
        d_U[t_idx].E[c_idx] = static_cast<RealType>(new_E_int + new_E_kin);
    }
}

void PhaseTrackingParticles3D::syncToDevice() {
    size_t count = m_particles.size();
    if (count == 0) return;

    if (d_capacity < count) {
        if (d_x) {
            cudaFree(d_x); cudaFree(d_y); cudaFree(d_z);
            cudaFree(d_vx); cudaFree(d_vy); cudaFree(d_vz);
            cudaFree(d_V); cudaFree(d_V0); cudaFree(d_m); cudaFree(d_phase); cudaFree(d_active);
            if (d_count) cudaFree(d_count);
        }
        size_t alloc_count = std::max(static_cast<size_t>(m_max_capacity), count * 2);
        CHECK_CUDA_TRACKER(cudaMalloc(&d_x, alloc_count * sizeof(float)));
        CHECK_CUDA_TRACKER(cudaMalloc(&d_y, alloc_count * sizeof(float)));
        CHECK_CUDA_TRACKER(cudaMalloc(&d_z, alloc_count * sizeof(float)));
        CHECK_CUDA_TRACKER(cudaMalloc(&d_vx, alloc_count * sizeof(float)));
        CHECK_CUDA_TRACKER(cudaMalloc(&d_vy, alloc_count * sizeof(float)));
        CHECK_CUDA_TRACKER(cudaMalloc(&d_vz, alloc_count * sizeof(float)));
        CHECK_CUDA_TRACKER(cudaMalloc(&d_V, alloc_count * sizeof(float)));
        CHECK_CUDA_TRACKER(cudaMalloc(&d_V0, alloc_count * sizeof(float)));
        CHECK_CUDA_TRACKER(cudaMalloc(&d_m, alloc_count * sizeof(float)));
        CHECK_CUDA_TRACKER(cudaMalloc(&d_phase, alloc_count * sizeof(uint8_t)));
        CHECK_CUDA_TRACKER(cudaMalloc(&d_active, alloc_count * sizeof(uint8_t)));
        CHECK_CUDA_TRACKER(cudaMalloc(&d_count, sizeof(int)));
        d_capacity = alloc_count;
    }

    std::vector<float> h_x(count), h_y(count), h_z(count);
    std::vector<float> h_vx(count), h_vy(count), h_vz(count);
    std::vector<float> h_V(count), h_V0(count), h_m(count);
    std::vector<uint8_t> h_phase(count), h_active(count);

    for (size_t i = 0; i < count; ++i) {
        h_x[i] = m_particles[i].x[0];
        h_y[i] = m_particles[i].x[1];
        h_z[i] = m_particles[i].x[2];
        h_vx[i] = m_particles[i].v[0];
        h_vy[i] = m_particles[i].v[1];
        h_vz[i] = m_particles[i].v[2];
        h_V[i] = m_particles[i].V;
        h_V0[i] = m_particles[i].V0;
        h_m[i] = m_particles[i].m;
        h_phase[i] = m_particles[i].phase_id;
        h_active[i] = m_particles[i].active;
    }

    int c_int = static_cast<int>(count);
    CHECK_CUDA_TRACKER(cudaMemcpy(d_x, h_x.data(), count * sizeof(float), cudaMemcpyHostToDevice));
    CHECK_CUDA_TRACKER(cudaMemcpy(d_y, h_y.data(), count * sizeof(float), cudaMemcpyHostToDevice));
    CHECK_CUDA_TRACKER(cudaMemcpy(d_z, h_z.data(), count * sizeof(float), cudaMemcpyHostToDevice));
    CHECK_CUDA_TRACKER(cudaMemcpy(d_vx, h_vx.data(), count * sizeof(float), cudaMemcpyHostToDevice));
    CHECK_CUDA_TRACKER(cudaMemcpy(d_vy, h_vy.data(), count * sizeof(float), cudaMemcpyHostToDevice));
    CHECK_CUDA_TRACKER(cudaMemcpy(d_vz, h_vz.data(), count * sizeof(float), cudaMemcpyHostToDevice));
    CHECK_CUDA_TRACKER(cudaMemcpy(d_V, h_V.data(), count * sizeof(float), cudaMemcpyHostToDevice));
    CHECK_CUDA_TRACKER(cudaMemcpy(d_V0, h_V0.data(), count * sizeof(float), cudaMemcpyHostToDevice));
    CHECK_CUDA_TRACKER(cudaMemcpy(d_m, h_m.data(), count * sizeof(float), cudaMemcpyHostToDevice));
    CHECK_CUDA_TRACKER(cudaMemcpy(d_phase, h_phase.data(), count * sizeof(uint8_t), cudaMemcpyHostToDevice));
    CHECK_CUDA_TRACKER(cudaMemcpy(d_active, h_active.data(), count * sizeof(uint8_t), cudaMemcpyHostToDevice));
    CHECK_CUDA_TRACKER(cudaMemcpy(d_count, &c_int, sizeof(int), cudaMemcpyHostToDevice));
}

void PhaseTrackingParticles3D::syncToHost() {
    if (!d_x || !d_count) return;

    int cur_count = static_cast<int>(m_particles.size());
    CHECK_CUDA_TRACKER(cudaMemcpy(&cur_count, d_count, sizeof(int), cudaMemcpyDeviceToHost));
    cur_count = std::max(0, std::min(cur_count, static_cast<int>(d_capacity)));
    if (cur_count == 0) return;

    size_t count = static_cast<size_t>(cur_count);
    if (m_particles.size() != count) {
        m_particles.resize(count);
    }

    std::vector<float> h_x(count), h_y(count), h_z(count);
    std::vector<float> h_vx(count), h_vy(count), h_vz(count);
    std::vector<float> h_V(count), h_V0(count), h_m(count);
    std::vector<uint8_t> h_phase(count), h_active(count);

    CHECK_CUDA_TRACKER(cudaMemcpy(h_x.data(), d_x, count * sizeof(float), cudaMemcpyDeviceToHost));
    CHECK_CUDA_TRACKER(cudaMemcpy(h_y.data(), d_y, count * sizeof(float), cudaMemcpyDeviceToHost));
    CHECK_CUDA_TRACKER(cudaMemcpy(h_z.data(), d_z, count * sizeof(float), cudaMemcpyDeviceToHost));
    CHECK_CUDA_TRACKER(cudaMemcpy(h_vx.data(), d_vx, count * sizeof(float), cudaMemcpyDeviceToHost));
    CHECK_CUDA_TRACKER(cudaMemcpy(h_vy.data(), d_vy, count * sizeof(float), cudaMemcpyDeviceToHost));
    CHECK_CUDA_TRACKER(cudaMemcpy(h_vz.data(), d_vz, count * sizeof(float), cudaMemcpyDeviceToHost));
    CHECK_CUDA_TRACKER(cudaMemcpy(h_V.data(), d_V, count * sizeof(float), cudaMemcpyDeviceToHost));
    CHECK_CUDA_TRACKER(cudaMemcpy(h_V0.data(), d_V0, count * sizeof(float), cudaMemcpyDeviceToHost));
    CHECK_CUDA_TRACKER(cudaMemcpy(h_m.data(), d_m, count * sizeof(float), cudaMemcpyDeviceToHost));
    CHECK_CUDA_TRACKER(cudaMemcpy(h_phase.data(), d_phase, count * sizeof(uint8_t), cudaMemcpyDeviceToHost));
    CHECK_CUDA_TRACKER(cudaMemcpy(h_active.data(), d_active, count * sizeof(uint8_t), cudaMemcpyDeviceToHost));

    for (size_t i = 0; i < count; ++i) {
        m_particles[i].x[0] = h_x[i];
        m_particles[i].x[1] = h_y[i];
        m_particles[i].x[2] = h_z[i];
        m_particles[i].v[0] = h_vx[i];
        m_particles[i].v[1] = h_vy[i];
        m_particles[i].v[2] = h_vz[i];
        m_particles[i].V = h_V[i];
        m_particles[i].V0 = h_V0[i];
        m_particles[i].m = h_m[i];
        m_particles[i].phase_id = h_phase[i];
        m_particles[i].active = h_active[i];
    }
}

void PhaseTrackingParticles3D::adaptParticlesGPU() {
    if (!m_adaptive || !d_x || !d_count) return;

    int cur_count = 0;
    CHECK_CUDA_TRACKER(cudaMemcpy(&cur_count, d_count, sizeof(int), cudaMemcpyDeviceToHost));
    if (cur_count <= 0) return;

    int threads = 256;
    int blocks = (cur_count + threads - 1) / threads;
    kernel_split_phase_particles_gpu<<<blocks, threads>>>(
        static_cast<float*>(d_x), static_cast<float*>(d_y), static_cast<float*>(d_z),
        static_cast<float*>(d_vx), static_cast<float*>(d_vy), static_cast<float*>(d_vz),
        static_cast<float*>(d_V), static_cast<float*>(d_V0), static_cast<float*>(d_m),
        static_cast<uint8_t*>(d_phase), static_cast<uint8_t*>(d_active),
        cur_count, static_cast<int>(d_capacity), m_split_vol_factor, d_count
    );
    CHECK_CUDA_TRACKER(cudaGetLastError());
}

void PhaseTrackingParticles3D::advectGPU(float dt, int nx, int ny, int nz, float dx, float dy, float dz,
                                         float xmin, float ymin, float zmin,
                                         const void* d_states, bool is_double, bool is_multimat) {
    if (!d_x || !d_states || !d_count) return;

    int count = 0;
    CHECK_CUDA_TRACKER(cudaMemcpy(&count, d_count, sizeof(int), cudaMemcpyDeviceToHost));
    if (count <= 0) return;

    int ntx = (nx + 7) / 8;
    int nty = (ny + 7) / 8;
    int threads = 256;
    int blocks = (count + threads - 1) / threads;

    if (!is_double && is_multimat) {
        using TileT = PrimitiveTile3D<float, true>;
        kernel_advect_phase_particles_rk2_gpu<float, true><<<blocks, threads>>>(
            static_cast<float*>(d_x), static_cast<float*>(d_y), static_cast<float*>(d_z),
            static_cast<float*>(d_vx), static_cast<float*>(d_vy), static_cast<float*>(d_vz),
            static_cast<float*>(d_V),
            static_cast<const uint8_t*>(d_active),
            count, dt,
            static_cast<const TileT*>(d_states),
            nx, ny, nz, ntx, nty, dx, dy, dz, xmin, ymin, zmin
        );
    } else if (is_double && is_multimat) {
        using TileT = PrimitiveTile3D<double, true>;
        kernel_advect_phase_particles_rk2_gpu<double, true><<<blocks, threads>>>(
            static_cast<float*>(d_x), static_cast<float*>(d_y), static_cast<float*>(d_z),
            static_cast<float*>(d_vx), static_cast<float*>(d_vy), static_cast<float*>(d_vz),
            static_cast<float*>(d_V),
            static_cast<const uint8_t*>(d_active),
            count, dt,
            static_cast<const TileT*>(d_states),
            nx, ny, nz, ntx, nty, dx, dy, dz, xmin, ymin, zmin
        );
    } else if (!is_double && !is_multimat) {
        using TileT = PrimitiveTile3D<float, false>;
        kernel_advect_phase_particles_rk2_gpu<float, false><<<blocks, threads>>>(
            static_cast<float*>(d_x), static_cast<float*>(d_y), static_cast<float*>(d_z),
            static_cast<float*>(d_vx), static_cast<float*>(d_vy), static_cast<float*>(d_vz),
            static_cast<float*>(d_V),
            static_cast<const uint8_t*>(d_active),
            count, dt,
            static_cast<const TileT*>(d_states),
            nx, ny, nz, ntx, nty, dx, dy, dz, xmin, ymin, zmin
        );
    } else {
        using TileT = PrimitiveTile3D<double, false>;
        kernel_advect_phase_particles_rk2_gpu<double, false><<<blocks, threads>>>(
            static_cast<float*>(d_x), static_cast<float*>(d_y), static_cast<float*>(d_z),
            static_cast<float*>(d_vx), static_cast<float*>(d_vy), static_cast<float*>(d_vz),
            static_cast<float*>(d_V),
            static_cast<const uint8_t*>(d_active),
            count, dt,
            static_cast<const TileT*>(d_states),
            nx, ny, nz, ntx, nty, dx, dy, dz, xmin, ymin, zmin
        );
    }
    CHECK_CUDA_TRACKER(cudaGetLastError());

    if (m_adaptive) {
        adaptParticlesGPU();
    }
}

void PhaseTrackingParticles3D::remapToCFD_GPU(void* d_states, void* d_U, int nx, int ny, int nz, float dx, float dy, float dz,
                                              float xmin, float ymin, float zmin,
                                              bool is_double, bool is_multimat,
                                              float rho1_nominal, float rho2_nominal,
                                              float sleeve_radius, float cx, float cy, float cz,
                                              float rho0_water, float water_B, float water_gamma) {
    if (!d_x || !d_states || !is_multimat || !d_count) return;

    int count = 0;
    CHECK_CUDA_TRACKER(cudaMemcpy(&count, d_count, sizeof(int), cudaMemcpyDeviceToHost));
    if (count <= 0) return;

    size_t total_cells = static_cast<size_t>(nx) * ny * nz;
    if (total_cells == 0) return;

    if (d_grid_capacity < total_cells) {
        if (d_grid_V_tot) {
            cudaFree(d_grid_V_tot);
            cudaFree(d_grid_V_gas);
            cudaFree(d_grid_V_he);
        }
        CHECK_CUDA_TRACKER(cudaMalloc(&d_grid_V_tot, total_cells * sizeof(float)));
        CHECK_CUDA_TRACKER(cudaMalloc(&d_grid_V_gas, total_cells * sizeof(float)));
        CHECK_CUDA_TRACKER(cudaMalloc(&d_grid_V_he,  total_cells * sizeof(float)));
        d_grid_capacity = total_cells;
    }

    CHECK_CUDA_TRACKER(cudaMemset(d_grid_V_tot, 0, total_cells * sizeof(float)));
    CHECK_CUDA_TRACKER(cudaMemset(d_grid_V_gas, 0, total_cells * sizeof(float)));
    CHECK_CUDA_TRACKER(cudaMemset(d_grid_V_he,  0, total_cells * sizeof(float)));

    int threads = 256;
    int blocks_p = (count + threads - 1) / threads;
    float r_sleeve_sq = sleeve_radius * sleeve_radius;

    kernel_accumulate_phase_particle_volumes_gpu<<<blocks_p, threads>>>(
        static_cast<const float*>(d_x), static_cast<const float*>(d_y), static_cast<const float*>(d_z),
        static_cast<const float*>(d_V),
        static_cast<const uint8_t*>(d_phase),
        static_cast<const uint8_t*>(d_active),
        count,
        d_grid_V_gas, d_grid_V_he, d_grid_V_tot,
        nx, ny, nz, dx, dy, dz, xmin, ymin, zmin,
        r_sleeve_sq, cx, cy, cz
    );
    CHECK_CUDA_TRACKER(cudaGetLastError());

    int ntx = (nx + 7) / 8;
    int nty = (ny + 7) / 8;
    int blocks_c = (static_cast<int>(total_cells) + threads - 1) / threads;
    float cell_vol = dx * dy * dz;

    if (!is_double) {
        using PrimTile = PrimitiveTile3D<float, true>;
        using ConsTile = ConservativeTile3D<float, true>;
        kernel_apply_phase_remap_to_cfd_tiles_gpu<float, true><<<blocks_c, threads>>>(
            static_cast<PrimTile*>(d_states),
            static_cast<ConsTile*>(d_U),
            d_grid_V_gas, d_grid_V_he, d_grid_V_tot,
            nx, ny, nz, ntx, nty,
            cell_vol, rho1_nominal, rho2_nominal,
            rho0_water, water_B, water_gamma
        );
    } else {
        using PrimTile = PrimitiveTile3D<double, true>;
        using ConsTile = ConservativeTile3D<double, true>;
        kernel_apply_phase_remap_to_cfd_tiles_gpu<double, true><<<blocks_c, threads>>>(
            static_cast<PrimTile*>(d_states),
            static_cast<ConsTile*>(d_U),
            d_grid_V_gas, d_grid_V_he, d_grid_V_tot,
            nx, ny, nz, ntx, nty,
            cell_vol, rho1_nominal, rho2_nominal,
            rho0_water, water_B, water_gamma
        );
    }
    CHECK_CUDA_TRACKER(cudaGetLastError());
}

} // namespace Blast
