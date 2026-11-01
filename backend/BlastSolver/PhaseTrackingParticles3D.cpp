#include "PhaseTrackingParticles3D.hpp"
#include <cmath>
#include <algorithm>
#include <iostream>

namespace Blast {

PhaseTrackingParticles3D::PhaseTrackingParticles3D(bool is_cuda) : m_is_cuda(is_cuda) {}

PhaseTrackingParticles3D::~PhaseTrackingParticles3D() {
    reset();
}

void PhaseTrackingParticles3D::initialize(int max_capacity, double xmin, double ymin, double zmin,
                                          double dx, double dy, double dz, int nx, int ny, int nz) {
    m_max_capacity = max_capacity;
    m_xmin = xmin; m_ymin = ymin; m_zmin = zmin;
    m_dx = dx; m_dy = dy; m_dz = dz;
    m_nx = nx; m_ny = ny; m_nz = nz;
    m_particles.clear();
    m_particles.reserve(std::min(max_capacity, 250000));
}

void PhaseTrackingParticles3D::reset() {
    m_particles.clear();
}

void PhaseTrackingParticles3D::seedSphere(float cx, float cy, float cz,
                                          float radius_outer, float radius_inner,
                                          TrackingPhaseID phase, float dx, float dy, float dz,
                                          int ppc, float density,
                                          float z_min_clip, float z_max_clip) {
    if (dx > 0) m_dx = dx;
    if (dy > 0) m_dy = dy;
    if (dz > 0) m_dz = dz;
    if (m_nx <= 0 || m_ny <= 0 || m_nz <= 0) {
        if (m_dx > 0) {
            m_nx = std::max(1, static_cast<int>(std::ceil((cx + radius_outer - m_xmin) / m_dx)));
            m_ny = std::max(1, static_cast<int>(std::ceil((cy + radius_outer - m_ymin) / m_dy)));
            m_nz = std::max(1, static_cast<int>(std::ceil((cz + radius_outer - m_zmin) / m_dz)));
        }
    }
    int ppc_1d = static_cast<int>(std::round(std::cbrt(static_cast<double>(ppc))));
    if (ppc_1d < 1) ppc_1d = 2;
    float sub_dx = static_cast<float>(m_dx) / static_cast<float>(ppc_1d);
    float sub_dy = static_cast<float>(m_dy) / static_cast<float>(ppc_1d);
    float sub_dz = static_cast<float>(m_dz) / static_cast<float>(ppc_1d);
    float p_vol = sub_dx * sub_dy * sub_dz;
    float p_mass = density * p_vol;

    int i_min = std::max(0, static_cast<int>(std::floor((cx - radius_outer - m_xmin) / m_dx)));
    int i_max = (m_nx > 0) ? std::min(m_nx - 1, static_cast<int>(std::ceil((cx + radius_outer - m_xmin) / m_dx)))
                           : std::max(i_min, static_cast<int>(std::ceil((cx + radius_outer - m_xmin) / m_dx)));
    int j_min = std::max(0, static_cast<int>(std::floor((cy - radius_outer - m_ymin) / m_dy)));
    int j_max = (m_ny > 0) ? std::min(m_ny - 1, static_cast<int>(std::ceil((cy + radius_outer - m_ymin) / m_dy)))
                           : std::max(j_min, static_cast<int>(std::ceil((cy + radius_outer - m_ymin) / m_dy)));
    int k_min = std::max(0, static_cast<int>(std::floor((cz - radius_outer - m_zmin) / m_dz)));
    int k_max = (m_nz > 0) ? std::min(m_nz - 1, static_cast<int>(std::ceil((cz + radius_outer - m_zmin) / m_dz)))
                           : std::max(k_min, static_cast<int>(std::ceil((cz + radius_outer - m_zmin) / m_dz)));

    float r_out_sq = radius_outer * radius_outer;
    float r_in_sq = radius_inner * radius_inner;

    for (int k = k_min; k <= k_max; ++k) {
        for (int j = j_min; j <= j_max; ++j) {
            for (int i = i_min; i <= i_max; ++i) {
                for (int sz = 0; sz < ppc_1d; ++sz) {
                    float pz = static_cast<float>(m_zmin) + (static_cast<float>(k) + (sz + 0.5f) / ppc_1d) * static_cast<float>(m_dz);
                    if (pz < z_min_clip || pz > z_max_clip) continue;
                    float dz_p = pz - cz;
                    for (int sy = 0; sy < ppc_1d; ++sy) {
                        float py = static_cast<float>(m_ymin) + (static_cast<float>(j) + (sy + 0.5f) / ppc_1d) * static_cast<float>(m_dy);
                        float dy_p = py - cy;
                        for (int sx = 0; sx < ppc_1d; ++sx) {
                            float px = static_cast<float>(m_xmin) + (static_cast<float>(i) + (sx + 0.5f) / ppc_1d) * static_cast<float>(m_dx);
                            float dx_p = px - cx;
                            float dist_sq = dx_p * dx_p + dy_p * dy_p + dz_p * dz_p;

                            if (dist_sq <= r_out_sq && dist_sq >= r_in_sq) {
                                if (m_particles.size() >= static_cast<size_t>(m_max_capacity)) {
                                    return;
                                }
                                PhaseTrackingParticle3D p{};
                                p.x[0] = px; p.x[1] = py; p.x[2] = pz;
                                p.v[0] = 0.0f; p.v[1] = 0.0f; p.v[2] = 0.0f;
                                p.V = p_vol;
                                p.V0 = p_vol;
                                p.m = p_mass;
                                p.phase_id = static_cast<uint8_t>(phase);
                                p.active = 1;
                                m_particles.push_back(p);
                            }
                        }
                    }
                }
            }
        }
    }
}

void PhaseTrackingParticles3D::seedCylinder(float cx, float cy, float cz,
                                            float radius_outer, float radius_inner, float height,
                                            TrackingPhaseID phase, float dx, float dy, float dz,
                                            int ppc, float density,
                                            float z_min_clip, float z_max_clip) {
    if (dx > 0) m_dx = dx;
    if (dy > 0) m_dy = dy;
    if (dz > 0) m_dz = dz;
    float half_h = 0.5f * height;
    float cyl_zmin = std::max(cz - half_h, z_min_clip);
    float cyl_zmax = std::min(cz + half_h, z_max_clip);
    if (m_nx <= 0 || m_ny <= 0 || m_nz <= 0) {
        if (m_dx > 0) {
            m_nx = std::max(1, static_cast<int>(std::ceil((cx + radius_outer - m_xmin) / m_dx)));
            m_ny = std::max(1, static_cast<int>(std::ceil((cy + radius_outer - m_ymin) / m_dy)));
            m_nz = std::max(1, static_cast<int>(std::ceil((cyl_zmax - m_zmin) / m_dz)));
        }
    }
    int ppc_1d = static_cast<int>(std::round(std::cbrt(static_cast<double>(ppc))));
    if (ppc_1d < 1) ppc_1d = 2;
    float sub_dx = static_cast<float>(m_dx) / static_cast<float>(ppc_1d);
    float sub_dy = static_cast<float>(m_dy) / static_cast<float>(ppc_1d);
    float sub_dz = static_cast<float>(m_dz) / static_cast<float>(ppc_1d);
    float p_vol = sub_dx * sub_dy * sub_dz;
    float p_mass = density * p_vol;

    int i_min = std::max(0, static_cast<int>(std::floor((cx - radius_outer - m_xmin) / m_dx)));
    int i_max = (m_nx > 0) ? std::min(m_nx - 1, static_cast<int>(std::ceil((cx + radius_outer - m_xmin) / m_dx)))
                           : std::max(i_min, static_cast<int>(std::ceil((cx + radius_outer - m_xmin) / m_dx)));
    int j_min = std::max(0, static_cast<int>(std::floor((cy - radius_outer - m_ymin) / m_dy)));
    int j_max = (m_ny > 0) ? std::min(m_ny - 1, static_cast<int>(std::ceil((cy + radius_outer - m_ymin) / m_dy)))
                           : std::max(j_min, static_cast<int>(std::ceil((cy + radius_outer - m_ymin) / m_dy)));
    int k_min = std::max(0, static_cast<int>(std::floor((cyl_zmin - m_zmin) / m_dz)));
    int k_max = (m_nz > 0) ? std::min(m_nz - 1, static_cast<int>(std::ceil((cyl_zmax - m_zmin) / m_dz)))
                           : std::max(k_min, static_cast<int>(std::ceil((cyl_zmax - m_zmin) / m_dz)));

    float r_out_sq = radius_outer * radius_outer;
    float r_in_sq = radius_inner * radius_inner;

    for (int k = k_min; k <= k_max; ++k) {
        for (int j = j_min; j <= j_max; ++j) {
            for (int i = i_min; i <= i_max; ++i) {
                for (int sz = 0; sz < ppc_1d; ++sz) {
                    float pz = static_cast<float>(m_zmin) + (static_cast<float>(k) + (sz + 0.5f) / ppc_1d) * static_cast<float>(m_dz);
                    if (pz < cyl_zmin || pz > cyl_zmax) continue;
                    for (int sy = 0; sy < ppc_1d; ++sy) {
                        float py = static_cast<float>(m_ymin) + (static_cast<float>(j) + (sy + 0.5f) / ppc_1d) * static_cast<float>(m_dy);
                        float dy_p = py - cy;
                        for (int sx = 0; sx < ppc_1d; ++sx) {
                            float px = static_cast<float>(m_xmin) + (static_cast<float>(i) + (sx + 0.5f) / ppc_1d) * static_cast<float>(m_dx);
                            float dx_p = px - cx;
                            float r_sq = dx_p * dx_p + dy_p * dy_p;

                            if (r_sq <= r_out_sq && r_sq >= r_in_sq) {
                                if (m_particles.size() >= static_cast<size_t>(m_max_capacity)) {
                                    return;
                                }
                                PhaseTrackingParticle3D p{};
                                p.x[0] = px; p.x[1] = py; p.x[2] = pz;
                                p.v[0] = 0.0f; p.v[1] = 0.0f; p.v[2] = 0.0f;
                                p.V = p_vol;
                                p.V0 = p_vol;
                                p.m = p_mass;
                                p.phase_id = static_cast<uint8_t>(phase);
                                p.active = 1;
                                m_particles.push_back(p);
                            }
                        }
                    }
                }
            }
        }
    }
}

void PhaseTrackingParticles3D::seedSphere(float cx, float cy, float cz,
                                          float radius_outer, float radius_inner,
                                          TrackingPhaseID phase, float density, int ppc_1d) {
    if (ppc_1d < 1) ppc_1d = 2;
    if (m_nx <= 0 || m_ny <= 0 || m_nz <= 0) {
        if (m_dx > 0) {
            m_nx = std::max(1, static_cast<int>(std::ceil((cx + radius_outer - m_xmin) / m_dx)));
            m_ny = std::max(1, static_cast<int>(std::ceil((cy + radius_outer - m_ymin) / m_dy)));
            m_nz = std::max(1, static_cast<int>(std::ceil((cz + radius_outer - m_zmin) / m_dz)));
        }
    }
    float sub_dx = static_cast<float>(m_dx) / static_cast<float>(ppc_1d);
    float sub_dy = static_cast<float>(m_dy) / static_cast<float>(ppc_1d);
    float sub_dz = static_cast<float>(m_dz) / static_cast<float>(ppc_1d);
    float p_vol = sub_dx * sub_dy * sub_dz;
    float p_mass = density * p_vol;

    int i_min = std::max(0, static_cast<int>(std::floor((cx - radius_outer - m_xmin) / m_dx)));
    int i_max = (m_nx > 0) ? std::min(m_nx - 1, static_cast<int>(std::ceil((cx + radius_outer - m_xmin) / m_dx)))
                           : std::max(i_min, static_cast<int>(std::ceil((cx + radius_outer - m_xmin) / m_dx)));
    int j_min = std::max(0, static_cast<int>(std::floor((cy - radius_outer - m_ymin) / m_dy)));
    int j_max = (m_ny > 0) ? std::min(m_ny - 1, static_cast<int>(std::ceil((cy + radius_outer - m_ymin) / m_dy)))
                           : std::max(j_min, static_cast<int>(std::ceil((cy + radius_outer - m_ymin) / m_dy)));
    int k_min = std::max(0, static_cast<int>(std::floor((cz - radius_outer - m_zmin) / m_dz)));
    int k_max = (m_nz > 0) ? std::min(m_nz - 1, static_cast<int>(std::ceil((cz + radius_outer - m_zmin) / m_dz)))
                           : std::max(k_min, static_cast<int>(std::ceil((cz + radius_outer - m_zmin) / m_dz)));

    float r_out_sq = radius_outer * radius_outer;
    float r_in_sq = radius_inner * radius_inner;

    for (int k = k_min; k <= k_max; ++k) {
        for (int j = j_min; j <= j_max; ++j) {
            for (int i = i_min; i <= i_max; ++i) {
                for (int sz = 0; sz < ppc_1d; ++sz) {
                    float pz = static_cast<float>(m_zmin) + (static_cast<float>(k) + (sz + 0.5f) / ppc_1d) * static_cast<float>(m_dz);
                    float dz = pz - cz;
                    for (int sy = 0; sy < ppc_1d; ++sy) {
                        float py = static_cast<float>(m_ymin) + (static_cast<float>(j) + (sy + 0.5f) / ppc_1d) * static_cast<float>(m_dy);
                        float dy = py - cy;
                        for (int sx = 0; sx < ppc_1d; ++sx) {
                            float px = static_cast<float>(m_xmin) + (static_cast<float>(i) + (sx + 0.5f) / ppc_1d) * static_cast<float>(m_dx);
                            float dx = px - cx;
                            float dist_sq = dx * dx + dy * dy + dz * dz;

                            if (dist_sq <= r_out_sq && dist_sq >= r_in_sq) {
                                if (m_particles.size() >= static_cast<size_t>(m_max_capacity)) {
                                    std::cerr << "[WARNING PhaseTracker] Particle capacity reached (" << m_max_capacity << ")." << std::endl;
                                    return;
                                }
                                PhaseTrackingParticle3D p{};
                                p.x[0] = px; p.x[1] = py; p.x[2] = pz;
                                p.v[0] = 0.0f; p.v[1] = 0.0f; p.v[2] = 0.0f;
                                p.V = p_vol;
                                p.V0 = p_vol;
                                p.m = p_mass;
                                p.phase_id = static_cast<uint8_t>(phase);
                                p.active = 1;
                                m_particles.push_back(p);
                            }
                        }
                    }
                }
            }
        }
    }
}

void PhaseTrackingParticles3D::seedBox(float b_xmin, float b_xmax, float b_ymin, float b_ymax, float b_zmin, float b_zmax,
                                       TrackingPhaseID phase, float density, int ppc_1d) {
    if (ppc_1d < 1) ppc_1d = 2;
    if (m_nx <= 0 || m_ny <= 0 || m_nz <= 0) {
        if (m_dx > 0) {
            m_nx = std::max(1, static_cast<int>(std::ceil((b_xmax - m_xmin) / m_dx)));
            m_ny = std::max(1, static_cast<int>(std::ceil((b_ymax - m_ymin) / m_dy)));
            m_nz = std::max(1, static_cast<int>(std::ceil((b_zmax - m_zmin) / m_dz)));
        }
    }
    float sub_dx = static_cast<float>(m_dx) / static_cast<float>(ppc_1d);
    float sub_dy = static_cast<float>(m_dy) / static_cast<float>(ppc_1d);
    float sub_dz = static_cast<float>(m_dz) / static_cast<float>(ppc_1d);
    float p_vol = sub_dx * sub_dy * sub_dz;
    float p_mass = density * p_vol;

    int i_min = std::max(0, static_cast<int>(std::floor((b_xmin - m_xmin) / m_dx)));
    int i_max = (m_nx > 0) ? std::min(m_nx - 1, static_cast<int>(std::ceil((b_xmax - m_xmin) / m_dx)))
                           : std::max(i_min, static_cast<int>(std::ceil((b_xmax - m_xmin) / m_dx)));
    int j_min = std::max(0, static_cast<int>(std::floor((b_ymin - m_ymin) / m_dy)));
    int j_max = (m_ny > 0) ? std::min(m_ny - 1, static_cast<int>(std::ceil((b_ymax - m_ymin) / m_dy)))
                           : std::max(j_min, static_cast<int>(std::ceil((b_ymax - m_ymin) / m_dy)));
    int k_min = std::max(0, static_cast<int>(std::floor((b_zmin - m_zmin) / m_dz)));
    int k_max = (m_nz > 0) ? std::min(m_nz - 1, static_cast<int>(std::ceil((b_zmax - m_zmin) / m_dz)))
                           : std::max(k_min, static_cast<int>(std::ceil((b_zmax - m_zmin) / m_dz)));

    for (int k = k_min; k <= k_max; ++k) {
        for (int j = j_min; j <= j_max; ++j) {
            for (int i = i_min; i <= i_max; ++i) {
                for (int sz = 0; sz < ppc_1d; ++sz) {
                    float pz = static_cast<float>(m_zmin) + (static_cast<float>(k) + (sz + 0.5f) / ppc_1d) * static_cast<float>(m_dz);
                    if (pz < b_zmin || pz > b_zmax) continue;
                    for (int sy = 0; sy < ppc_1d; ++sy) {
                        float py = static_cast<float>(m_ymin) + (static_cast<float>(j) + (sy + 0.5f) / ppc_1d) * static_cast<float>(m_dy);
                        if (py < b_ymin || py > b_ymax) continue;
                        for (int sx = 0; sx < ppc_1d; ++sx) {
                            float px = static_cast<float>(m_xmin) + (static_cast<float>(i) + (sx + 0.5f) / ppc_1d) * static_cast<float>(m_dx);
                            if (px < b_xmin || px > b_xmax) continue;

                            if (m_particles.size() >= static_cast<size_t>(m_max_capacity)) return;

                            PhaseTrackingParticle3D p{};
                            p.x[0] = px; p.x[1] = py; p.x[2] = pz;
                            p.v[0] = 0.0f; p.v[1] = 0.0f; p.v[2] = 0.0f;
                            p.V = p_vol;
                            p.V0 = p_vol;
                            p.m = p_mass;
                            p.phase_id = static_cast<uint8_t>(phase);
                            p.active = 1;
                            m_particles.push_back(p);
                        }
                    }
                }
            }
        }
    }
}

void PhaseTrackingParticles3D::seedBox(float b_xmin, float b_xmax, float b_ymin, float b_ymax, float b_zmin, float b_zmax,
                                       TrackingPhaseID phase, float dx, float dy, float dz, int ppc, float density) {
    if (dx > 0) m_dx = dx;
    if (dy > 0) m_dy = dy;
    if (dz > 0) m_dz = dz;
    int ppc_1d = static_cast<int>(std::round(std::cbrt(static_cast<double>(ppc))));
    if (ppc_1d < 1) ppc_1d = 2;
    seedBox(b_xmin, b_xmax, b_ymin, b_ymax, b_zmin, b_zmax, phase, density, ppc_1d);
}

// Trilinear interpolation helper for velocity field and velocity divergence (div u)
static inline void sample_grid_velocity_and_div(float px, float py, float pz,
                                                int nx, int ny, int nz, float dx, float dy, float dz,
                                                float xmin, float ymin, float zmin,
                                                const float* u_grid, const float* v_grid, const float* w_grid,
                                                float& u_out, float& v_out, float& w_out, float& div_out) {
    float fx = (px - xmin) / dx - 0.5f;
    float fy = (py - ymin) / dy - 0.5f;
    float fz = (pz - zmin) / dz - 0.5f;

    int i = std::clamp(static_cast<int>(std::floor(fx)), 0, nx - 2);
    int j = std::clamp(static_cast<int>(std::floor(fy)), 0, ny - 2);
    int k = std::clamp(static_cast<int>(std::floor(fz)), 0, nz - 2);

    float wx1 = std::clamp(fx - static_cast<float>(i), 0.0f, 1.0f);
    float wy1 = std::clamp(fy - static_cast<float>(j), 0.0f, 1.0f);
    float wz1 = std::clamp(fz - static_cast<float>(k), 0.0f, 1.0f);
    float wx0 = 1.0f - wx1;
    float wy0 = 1.0f - wy1;
    float wz0 = 1.0f - wz1;

    auto at = [&](int ci, int cj, int ck) -> size_t {
        return (static_cast<size_t>(ci) * ny + cj) * nz + ck;
    };

    float w000 = wx0 * wy0 * wz0; float w100 = wx1 * wy0 * wz0;
    float w010 = wx0 * wy1 * wz0; float w110 = wx1 * wy1 * wz0;
    float w001 = wx0 * wy0 * wz1; float w101 = wx1 * wy0 * wz1;
    float w011 = wx0 * wy1 * wz1; float w111 = wx1 * wy1 * wz1;

    size_t i000 = at(i, j, k),     i100 = at(i+1, j, k);
    size_t i010 = at(i, j+1, k),   i110 = at(i+1, j+1, k);
    size_t i001 = at(i, j, k+1),   i101 = at(i+1, j, k+1);
    size_t i011 = at(i, j+1, k+1), i111 = at(i+1, j+1, k+1);

    float u000 = u_grid[i000], u100 = u_grid[i100];
    float u010 = u_grid[i010], u110 = u_grid[i110];
    float u001 = u_grid[i001], u101 = u_grid[i101];
    float u011 = u_grid[i011], u111 = u_grid[i111];

    float v000 = v_grid[i000], v100 = v_grid[i100];
    float v010 = v_grid[i010], v110 = v_grid[i110];
    float v001 = v_grid[i001], v101 = v_grid[i101];
    float v011 = v_grid[i011], v111 = v_grid[i111];

    float w000_v = w_grid[i000], w100_v = w_grid[i100];
    float w010_v = w_grid[i010], w110_v = w_grid[i110];
    float w001_v = w_grid[i001], w101_v = w_grid[i101];
    float w011_v = w_grid[i011], w111_v = w_grid[i111];

    u_out = w000 * u000 + w100 * u100 + w010 * u010 + w110 * u110 +
            w001 * u001 + w101 * u101 + w011 * u011 + w111 * u111;
    v_out = w000 * v000 + w100 * v100 + w010 * v010 + w110 * v110 +
            w001 * v001 + w101 * v101 + w011 * v011 + w111 * v111;
    w_out = w000 * w000_v + w100 * w100_v + w010 * w010_v + w110 * w110_v +
            w001 * w001_v + w101 * w101_v + w011 * w011_v + w111 * w111_v;

    // Exact analytical velocity gradient of trilinear field (zero extra memory traffic)
    float du_dx = (1.0f / dx) * (wy0 * wz0 * (u100 - u000) + wy1 * wz0 * (u110 - u010) +
                                 wy0 * wz1 * (u101 - u001) + wy1 * wz1 * (u111 - u011));
    float dv_dy = (1.0f / dy) * (wx0 * wz0 * (v010 - v000) + wx1 * wz0 * (v110 - v100) +
                                 wx0 * wz1 * (v011 - v001) + wx1 * wz1 * (v111 - v101));
    float dw_dz = (1.0f / dz) * (wx0 * wy0 * (w100_v - w000_v) + wx1 * wy0 * (w110_v - w010_v) +
                                 wx0 * wy1 * (w101_v - w001_v) + wx1 * wy1 * (w111_v - w011_v));

    div_out = du_dx + dv_dy + dw_dz;
}

void PhaseTrackingParticles3D::adaptParticlesCPU() {
    if (!m_adaptive || m_particles.empty()) return;

    size_t count = m_particles.size();
    size_t max_cap = static_cast<size_t>(m_max_capacity);

    // Adaptive splitting for expanding gas particles (prevents inter-particle gaps)
    for (size_t i = 0; i < count; ++i) {
        auto& p = m_particles[i];
        if (!p.active) continue;

        if (p.phase_id == static_cast<uint8_t>(TrackingPhaseID::DetonationGas) &&
            p.V > m_split_vol_factor * p.V0 && m_particles.size() < max_cap) {

            float half_v = 0.5f * p.V;
            float half_m = 0.5f * p.m;
            p.V = half_v;
            p.m = half_m;

            PhaseTrackingParticle3D child = p;
            float offset = 0.25f * std::cbrt(half_v);
            p.x[0] -= offset;
            child.x[0] += offset;
            m_particles.push_back(child);
        }
    }
}

void PhaseTrackingParticles3D::advectCPU(float dt,
                                         int nx, int ny, int nz, float dx, float dy, float dz,
                                         float xmin, float ymin, float zmin,
                                         const float* u_grid, const float* v_grid, const float* w_grid) {
    if (m_particles.empty() || !u_grid || !v_grid || !w_grid) return;

    size_t num = m_particles.size();
#ifdef _OPENMP
    #pragma omp parallel for schedule(static)
#endif
    for (size_t p_idx = 0; p_idx < num; ++p_idx) {
        auto& p = m_particles[p_idx];
        if (!p.active) continue;

        // Stage 1 (Predictor at t + dt/2)
        float u1 = 0.0f, v1 = 0.0f, w1 = 0.0f, div1 = 0.0f;
        sample_grid_velocity_and_div(p.x[0], p.x[1], p.x[2], nx, ny, nz, dx, dy, dz, xmin, ymin, zmin,
                                     u_grid, v_grid, w_grid, u1, v1, w1, div1);

        float x_mid = p.x[0] + 0.5f * dt * u1;
        float y_mid = p.x[1] + 0.5f * dt * v1;
        float z_mid = p.x[2] + 0.5f * dt * w1;

        // Stage 2 (Corrector at midpoint velocity)
        float u2 = 0.0f, v2 = 0.0f, w2 = 0.0f, div2 = 0.0f;
        sample_grid_velocity_and_div(x_mid, y_mid, z_mid, nx, ny, nz, dx, dy, dz, xmin, ymin, zmin,
                                     u_grid, v_grid, w_grid, u2, v2, w2, div2);

        p.x[0] += dt * u2;
        p.x[1] += dt * v2;
        p.x[2] += dt * w2;

        p.v[0] = u2;
        p.v[1] = v2;
        p.v[2] = w2;

        // Divergence-conforming volume evolution: dV/dt = V * div(u)
        // Monotonic exponential update guarantees strict volume positivity (V > 0)
        float dlnV = std::clamp(dt * div2, -5.0f, 5.0f);
        p.V *= std::exp(dlnV);
    }

    if (m_adaptive) {
        adaptParticlesCPU();
    }
}

void PhaseTrackingParticles3D::remapToCFD_CPU(int nx, int ny, int nz, float dx, float dy, float dz,
                                              float xmin, float ymin, float zmin,
                                              float sleeve_radius, float center_x, float center_y, float center_z,
                                              float* cfd_alpha1, float* cfd_alpha2,
                                              float* cfd_arho1, float* cfd_arho2,
                                              float rho1_nominal, float rho2_nominal,
                                              float* cfd_rho,
                                              float* cfd_ux, float* cfd_uy, float* cfd_uz,
                                              float* cfd_E,
                                              float rho0_water, float water_B, float water_gamma) {
    (void)water_B;
    (void)water_gamma;
    if (m_particles.empty() || !cfd_alpha1 || !cfd_alpha2) return;

    size_t total_cells = static_cast<size_t>(nx) * ny * nz;
    float cell_vol = dx * dy * dz;
    float r_sleeve_sq = sleeve_radius * sleeve_radius;

    std::vector<float> V_gas(total_cells, 0.0f);
    std::vector<float> V_he(total_cells, 0.0f);
    std::vector<float> V_tot(total_cells, 0.0f);

    // Smooth C0 trilinear particle volume accumulation across 8 cell centers
    for (const auto& p : m_particles) {
        if (!p.active) continue;

        float rx = p.x[0] - center_x;
        float ry = p.x[1] - center_y;
        float rz = p.x[2] - center_z;
        if (rx*rx + ry*ry + rz*rz > r_sleeve_sq) continue;

        float fx = (p.x[0] - xmin) / dx - 0.5f;
        float fy = (p.x[1] - ymin) / dy - 0.5f;
        float fz = (p.x[2] - zmin) / dz - 0.5f;

        int i = std::clamp(static_cast<int>(std::floor(fx)), 0, nx - 2);
        int j = std::clamp(static_cast<int>(std::floor(fy)), 0, ny - 2);
        int k = std::clamp(static_cast<int>(std::floor(fz)), 0, nz - 2);

        float wx1 = std::clamp(fx - static_cast<float>(i), 0.0f, 1.0f);
        float wy1 = std::clamp(fy - static_cast<float>(j), 0.0f, 1.0f);
        float wz1 = std::clamp(fz - static_cast<float>(k), 0.0f, 1.0f);
        float wx0 = 1.0f - wx1;
        float wy0 = 1.0f - wy1;
        float wz0 = 1.0f - wz1;

        float vol = p.V;
        bool is_gas = (p.phase_id == static_cast<uint8_t>(TrackingPhaseID::DetonationGas));
        bool is_he  = (p.phase_id == static_cast<uint8_t>(TrackingPhaseID::UnreactedExplosive));

        for (int di = 0; di <= 1; ++di) {
            float wx = di ? wx1 : wx0;
            int ci = i + di;
            for (int dj = 0; dj <= 1; ++dj) {
                float wy = dj ? wy1 : wy0;
                int cj = j + dj;
                for (int dk = 0; dk <= 1; ++dk) {
                    float wz = dk ? wz1 : wz0;
                    int ck = k + dk;
                    float w = wx * wy * wz;
                    float dV = w * vol;

                    size_t c_idx = (static_cast<size_t>(ci) * ny + cj) * nz + ck;
                    V_tot[c_idx] += dV;
                    if (is_gas) {
                        V_gas[c_idx] += dV;
                    } else if (is_he) {
                        V_he[c_idx] += dV;
                    }
                }
            }
        }
    }

    // Thermodynamically Consistent Multi-Phase Remap (Abgrall Principle)
#ifdef _OPENMP
    #pragma omp parallel for schedule(static)
#endif
    for (size_t c = 0; c < total_cells; ++c) {
        float tot = V_tot[c];
        if (tot <= 1.0e-12f * cell_vol) continue;

        // Partition-of-unity phase fractions
        float a1_part = V_gas[c] / tot;
        float a2_part = V_he[c] / tot;

        // Sparsity safeguard weight
        float w_part = std::clamp(tot / cell_vol, 0.0f, 1.0f);

        // Dual blend
        float a1_old = cfd_alpha1[c];
        float a2_old = cfd_alpha2[c];
        float a1_new = w_part * a1_part + (1.0f - w_part) * a1_old;
        float a2_new = w_part * a2_part + (1.0f - w_part) * a2_old;

        // Ensure partition of unity bounds: sum(alpha) <= 1.0
        float sum_a = a1_new + a2_new;
        if (sum_a > 1.0f) {
            a1_new /= sum_a;
            a2_new /= sum_a;
        }
        float a0_new = std::max(0.0f, 1.0f - a1_new - a2_new);

        float cell_rho = cfd_rho ? cfd_rho[c] : rho1_nominal;
        float arho1_old = cfd_arho1 ? cfd_arho1[c] : 0.0f;
        float arho2_old = cfd_arho2 ? cfd_arho2[c] : 0.0f;

        // Current intrinsic material densities
        float gas_rho_cur = (a1_old > 1.0e-4f) ? (arho1_old / a1_old) : std::min(cell_rho, rho1_nominal);
        float he_rho_cur  = (a2_old > 1.0e-4f) ? (arho2_old / a2_old) : std::min(cell_rho, rho2_nominal);
        gas_rho_cur = std::max(1.0e-4f, gas_rho_cur);
        he_rho_cur  = std::max(1.0e-4f, he_rho_cur);

        // Intrinsic liquid water density: strictly preserve equilibrium water density
        float a0_old = std::max(0.0f, 1.0f - a1_old - a2_old);
        float water_rho_cur = (a0_old > 1.0e-4f) ? ((cell_rho - arho1_old - arho2_old) / a0_old) : rho0_water;
        water_rho_cur = std::clamp(water_rho_cur, 0.95f * rho0_water, 1.10f * rho0_water);

        float arho1_new = (a1_new > 0.0f) ? (a1_new * gas_rho_cur) : 0.0f;
        float arho2_new = (a2_new > 0.0f) ? (a2_new * he_rho_cur) : 0.0f;
        float arho0_new = (a0_new > 0.0f) ? (a0_new * water_rho_cur) : 0.0f;

        // Thermodynamically consistent mixture density
        float rho_new = arho0_new + arho1_new + arho2_new;

        cfd_alpha1[c] = a1_new;
        cfd_alpha2[c] = a2_new;
        if (cfd_arho1) cfd_arho1[c] = arho1_new;
        if (cfd_arho2) cfd_arho2[c] = arho2_new;
        if (cfd_rho)   cfd_rho[c]   = rho_new;

        // Scale energy and momentum consistently if buffers are provided
        if (cfd_E && cfd_ux && cfd_uy && cfd_uz) {
            float ux = cfd_ux[c], uy = cfd_uy[c], uz = cfd_uz[c];
            float old_E = cfd_E[c];
            float old_E_kin = 0.5f * cell_rho * (ux*ux + uy*uy + uz*uz);
            float old_E_int = std::max(1.0e-3f, old_E - old_E_kin);

            float new_E_kin = 0.5f * rho_new * (ux*ux + uy*uy + uz*uz);
            float new_E_int = old_E_int * (rho_new / std::max(1.0e-4f, cell_rho));
            cfd_E[c] = new_E_int + new_E_kin;
        }
    }
}

void PhaseTrackingParticles3D::extractTelemetry(std::vector<float>& out_buffer, int max_visual_particles) const {
    size_t count = m_particles.size();
    if (count == 0) {
        out_buffer.clear();
        return;
    }

    size_t stride = (count > static_cast<size_t>(max_visual_particles)) ? (count / max_visual_particles) : 1;
    size_t vis_count = (count + stride - 1) / stride;

    out_buffer.clear();
    out_buffer.reserve(vis_count * 8);

    for (size_t i = 0; i < count; i += stride) {
        const auto& p = m_particles[i];
        if (!p.active) continue;
        out_buffer.push_back(p.x[0]);
        out_buffer.push_back(p.x[1]);
        out_buffer.push_back(p.x[2]);
        out_buffer.push_back(p.v[0]);
        out_buffer.push_back(p.v[1]);
        out_buffer.push_back(p.v[2]);
        out_buffer.push_back(static_cast<float>(p.phase_id));
        out_buffer.push_back(p.V);
    }
}

PhaseTrackingVTKSnapshot3D PhaseTrackingParticles3D::extractSnapshot() const {
    PhaseTrackingVTKSnapshot3D snap;
    snap.num_particles = static_cast<int>(m_particles.size());
    if (snap.num_particles <= 0) return snap;

    snap.points.resize(snap.num_particles * 3);
    snap.vel.resize(snap.num_particles * 3);
    snap.phase_id.resize(snap.num_particles);
    snap.volume.resize(snap.num_particles);
    snap.mass.resize(snap.num_particles);

    for (int i = 0; i < snap.num_particles; ++i) {
        const auto& p = m_particles[i];
        snap.points[i * 3 + 0] = p.x[0];
        snap.points[i * 3 + 1] = p.x[1];
        snap.points[i * 3 + 2] = p.x[2];
        snap.vel[i * 3 + 0] = p.v[0];
        snap.vel[i * 3 + 1] = p.v[1];
        snap.vel[i * 3 + 2] = p.v[2];
        snap.phase_id[i] = static_cast<int32_t>(p.phase_id);
        snap.volume[i] = p.V;
        snap.mass[i] = p.m;
    }
    return snap;
}

} // namespace Blast
