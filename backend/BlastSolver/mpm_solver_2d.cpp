#include "mpm_solver_2d.hpp"
#include <cstring>

namespace Blast {

static inline uint32_t floatToBits2D(float f) {
    uint32_t u;
    std::memcpy(&u, &f, sizeof(float));
    return u;
}

static inline float computeWeibullFactor2D(float x, float y, float weibull_modulus, float weibull_scale) {
    if (weibull_modulus <= 0.001f) return 1.0f;
    uint32_t ix = floatToBits2D(x);
    uint32_t iy = floatToBits2D(y);
    uint32_t seed = (ix * 73856093u) ^ (iy * 19349663u);
    seed = (seed ^ 61u) ^ (seed >> 16);
    seed *= 9u;
    seed = seed ^ (seed >> 4);
    seed *= 0x27d4eb2du;
    seed = seed ^ (seed >> 15);
    float u = std::clamp(static_cast<float>(seed & 0xFFFFu) / 65535.0f, 0.005f, 0.995f);
    float m_w = weibull_modulus;
    float eta_w = (weibull_scale > 0.001f) ? weibull_scale : 1.0f;
    float w = std::pow(-std::log(1.0f - u), 1.0f / m_w) * eta_w;
    return std::clamp(w, 0.20f, 2.50f);
}

MPMSolver2D::MPMSolver2D() {
}

void MPMSolver2D::initializeGrid(int nx, int ny, float dx, float dy) {
    m_nx = nx;
    m_ny = ny;
    m_dx = dx;
    m_dy = dy;

    m_grid.resize(m_nx * m_ny);
    m_particles.clear();
}

float MPMSolver2D::evalGIMP_S(float x_p, float x_i, float h, float l_p) const {
    float r = std::abs(x_p - x_i);
    if (r >= h + l_p) return 0.0f;
    if (r < l_p) {
        return 1.0f - (r * r + l_p * l_p) / (2.0f * h * l_p);
    } else if (r <= h - l_p) {
        return 1.0f - (r / h);
    } else {
        float term = h + l_p - r;
        return (term * term) / (4.0f * h * l_p);
    }
}

float MPMSolver2D::evalGIMP_dS(float x_p, float x_i, float h, float l_p) const {
    float diff = x_p - x_i;
    float r = std::abs(diff);
    if (r >= h + l_p) return 0.0f;
    float sign = (diff > 0.0f) ? 1.0f : ((diff < 0.0f) ? -1.0f : 0.0f);
    if (r < l_p) {
        return -sign * r / (h * l_p);
    } else if (r <= h - l_p) {
        return -sign / h;
    } else {
        float term = h + l_p - r;
        return -sign * term / (2.0f * h * l_p);
    }
}

float MPMSolver2D::evalBSpline_S(float x_p, float x_i, float h) const {
    float q = std::abs(x_p - x_i) / h;
    if (q < 0.5f) {
        return 0.75f - q * q;
    } else if (q < 1.5f) {
        return 0.5f * (1.5f - q) * (1.5f - q);
    }
    return 0.0f;
}

float MPMSolver2D::evalBSpline_dS(float x_p, float x_i, float h) const {
    float diff = x_p - x_i;
    float q = std::abs(diff) / h;
    float sign = (diff > 0.0f) ? 1.0f : ((diff < 0.0f) ? -1.0f : 0.0f);
    if (q < 0.5f) {
        return -2.0f * diff / (h * h);
    } else if (q < 1.5f) {
        return -sign * (1.5f - q) / h;
    }
    return 0.0f;
}

float MPMSolver2D::evalCubicBSpline_S(float x_p, float x_i, float h) const {
    float q = std::abs(x_p - x_i) / h;
    if (q < 1.0f) {
        return (4.0f - 6.0f * q * q + 3.0f * q * q * q) / 6.0f;
    } else if (q < 2.0f) {
        float term = 2.0f - q;
        return (term * term * term) / 6.0f;
    }
    return 0.0f;
}

float MPMSolver2D::evalCubicBSpline_dS(float x_p, float x_i, float h) const {
    float diff = x_p - x_i;
    float q = std::abs(diff) / h;
    float sign = (diff > 0.0f) ? 1.0f : ((diff < 0.0f) ? -1.0f : 0.0f);
    if (q < 1.0f) {
        return (-12.0f * q + 9.0f * q * q) * sign / (6.0f * h);
    } else if (q < 2.0f) {
        float term = 2.0f - q;
        return -3.0f * term * term * sign / (6.0f * h);
    }
    return 0.0f;
}

float MPMSolver2D::evalWendland_C2(float r, float R_supp) const {
    if (r >= R_supp) return 0.0f;
    float q = r / R_supp;
    float term = 1.0f - q;
    return (term * term * term * term) * (1.0f + 4.0f * q);
}

void MPMSolver2D::addRectangleObject(int obj_id, float pos_x, float pos_y, float size_x, float size_y,
                                     float vel_x, float vel_y, float angular_vel, float density, float E, float nu,
                                     float yield_stress, float hardening, float failure_strain, float tensile_failure_stress, int ppc,
                                     MPMParticleDistribution particle_dist, MPMBoundaryFilling boundary_fill) {
    (void)boundary_fill;
    int particles_per_dim = static_cast<int>(std::round(std::sqrt(static_cast<float>(ppc))));
    if (particles_per_dim < 1) particles_per_dim = 2;

    float p_dx = m_dx / static_cast<float>(particles_per_dim);
    float p_dy = (particle_dist == MPMParticleDistribution::Hexagonal) ? 
                 (std::sqrt(3.0f) * 0.5f * p_dx) : (m_dy / static_cast<float>(particles_per_dim));

    float min_x = pos_x - 0.5f * size_x;
    float max_x = pos_x + 0.5f * size_x;
    float min_y = pos_y - 0.5f * size_y;
    float max_y = pos_y + 0.5f * size_y;

    float p_vol = p_dx * p_dy;
    float p_mass = p_vol * density;

    int row_idx = 0;
    for (float y = min_y + 0.5f * p_dy; y < max_y; y += p_dy, ++row_idx) {
        float x_offset = (particle_dist == MPMParticleDistribution::Hexagonal && (row_idx % 2 == 1)) ? 
                         0.5f * p_dx : 0.0f;
        for (float x = min_x + 0.5f * p_dx + x_offset; x < max_x; x += p_dx) {
            MPMParticle2D p{};
            p.x[0] = x;
            p.x[1] = y;

            float rx = x - pos_x;
            float ry = y - pos_y;

            p.v[0] = vel_x - angular_vel * ry;
            p.v[1] = vel_y + angular_vel * rx;

            p.B[0][0] = 0.0f;           p.B[0][1] = -angular_vel;
            p.B[1][0] =  angular_vel;   p.B[1][1] = 0.0f;

            p.lp[0] = 0.5f * p_dx;
            p.lp[1] = 0.5f * p_dy;

            p.m = p_mass;
            p.V0 = p_vol;
            p.V = p_vol;

            p.density = density;
            p.youngs_modulus = E;
            p.poissons_ratio = nu;
            p.yield_stress = yield_stress;
            p.hardening_modulus = hardening;
            p.failure_strain = failure_strain;
            p.tensile_failure_stress = tensile_failure_stress;
            p.damage = 0.0f;
            p.has_failed = false;

            p.F[0][0] = 1.0f; p.F[0][1] = 0.0f;
            p.F[1][0] = 0.0f; p.F[1][1] = 1.0f;

            p.sigma[0][0] = 0.0f; p.sigma[0][1] = 0.0f;
            p.sigma[1][0] = 0.0f; p.sigma[1][1] = 0.0f;

            p.ep_bar = 0.0f;
            p.object_id = obj_id;

            m_particles.push_back(p);
        }
    }
}

void MPMSolver2D::addCircleObject(int obj_id, float pos_x, float pos_y, float radius,
                                  float vel_x, float vel_y, float angular_vel, float density, float E, float nu,
                                  float yield_stress, float hardening, float failure_strain, float tensile_failure_stress, int ppc,
                                  MPMParticleDistribution particle_dist, MPMBoundaryFilling boundary_fill) {
    int particles_per_dim = static_cast<int>(std::round(std::sqrt(static_cast<float>(ppc))));
    if (particles_per_dim < 1) particles_per_dim = 2;

    float p_dx = m_dx / static_cast<float>(particles_per_dim);
    float p_dy = (particle_dist == MPMParticleDistribution::Hexagonal) ? 
                 (std::sqrt(3.0f) * 0.5f * p_dx) : (m_dy / static_cast<float>(particles_per_dim));

    float min_x = pos_x - radius - p_dx;
    float max_x = pos_x + radius + p_dx;
    float min_y = pos_y - radius - p_dy;
    float max_y = pos_y + radius + p_dy;

    float r2 = radius * radius;
    float nominal_vol = p_dx * p_dy;

    int row_idx = 0;
    for (float y = min_y + 0.5f * p_dy; y < max_y; y += p_dy, ++row_idx) {
        float x_offset = (particle_dist == MPMParticleDistribution::Hexagonal && (row_idx % 2 == 1)) ? 
                         0.5f * p_dx : 0.0f;
        for (float x = min_x + 0.5f * p_dx + x_offset; x < max_x; x += p_dx) {
            float final_x = x;
            float final_y = y;
            float f_vol = 1.0f;

            if (boundary_fill == MPMBoundaryFilling::Partial) {
                // 3x3 Sub-sampling for partial cell volume fraction
                int sub_count = 0;
                float sum_sx = 0.0f, sum_sy = 0.0f;
                for (int si = -1; si <= 1; ++si) {
                    float sx = x + (static_cast<float>(si) / 3.0f) * p_dx;
                    for (int sj = -1; sj <= 1; ++sj) {
                        float sy = y + (static_cast<float>(sj) / 3.0f) * p_dy;
                        float dsx = sx - pos_x;
                        float dsy = sy - pos_y;
                        if (dsx * dsx + dsy * dsy <= r2) {
                            sub_count++;
                            sum_sx += sx;
                            sum_sy += sy;
                        }
                    }
                }
                if (sub_count == 0) continue;
                f_vol = static_cast<float>(sub_count) / 9.0f;
                if (f_vol < 0.10f) continue;
                if (sub_count < 9) {
                    final_x = sum_sx / static_cast<float>(sub_count);
                    final_y = sum_sy / static_cast<float>(sub_count);
                }
            } else {
                float rx = x - pos_x;
                float ry = y - pos_y;
                if (rx * rx + ry * ry > r2) continue;
            }

            float p_vol = f_vol * nominal_vol;
            float p_mass = p_vol * density;

            MPMParticle2D p{};
            p.x[0] = final_x;
            p.x[1] = final_y;

            float rx = final_x - pos_x;
            float ry = final_y - pos_y;

            p.v[0] = vel_x - angular_vel * ry;
            p.v[1] = vel_y + angular_vel * rx;

            p.B[0][0] = 0.0f;           p.B[0][1] = -angular_vel;
            p.B[1][0] =  angular_vel;   p.B[1][1] = 0.0f;

            p.lp[0] = 0.5f * p_dx;
            p.lp[1] = 0.5f * p_dy;

            p.m = p_mass;
            p.V0 = p_vol;
            p.V = p_vol;

            p.density = density;
            p.youngs_modulus = E;
            p.poissons_ratio = nu;
            p.yield_stress = yield_stress;
            p.hardening_modulus = hardening;
            p.failure_strain = failure_strain;
            p.tensile_failure_stress = tensile_failure_stress;
            p.damage = 0.0f;
            p.has_failed = false;

            p.F[0][0] = 1.0f; p.F[0][1] = 0.0f;
            p.F[1][0] = 0.0f; p.F[1][1] = 1.0f;

            p.sigma[0][0] = 0.0f; p.sigma[0][1] = 0.0f;
            p.sigma[1][0] = 0.0f; p.sigma[1][1] = 0.0f;

            p.ep_bar = 0.0f;
            p.object_id = obj_id;

            m_particles.push_back(p);
        }
    }
}

void MPMSolver2D::particleToGrid() {
    // Clear background grid
    for (auto& node : m_grid) {
        node.m = 0.0f;
        node.p[0] = 0.0f; node.p[1] = 0.0f;
        node.v[0] = 0.0f; node.v[1] = 0.0f;
        node.f_int[0] = 0.0f; node.f_int[1] = 0.0f;
        node.f_ext[0] = 0.0f; node.f_ext[1] = 0.0f;
        node.von_mises = 0.0f;
        node.plastic_strain = 0.0f;
        node.density = 0.0f;
        node.pressure = 0.0f;
        node.damage = 0.0f;
    }

    // P2G Scatter
    for (const auto& p : m_particles) {
        int base_i = static_cast<int>(std::floor((p.x[0]) / m_dx));
        int base_j = static_cast<int>(std::floor((p.x[1]) / m_dy));

        // Evaluate Cauchy stress & Von Mises equivalent stress for scatter
        float s_xx = p.sigma[0][0];
        float s_yy = p.sigma[1][1];
        float s_xy = p.sigma[0][1];
        float press = -0.5f * (s_xx + s_yy);
        float dev_xx = s_xx + press;
        float dev_yy = s_yy + press;
        float vm_stress = std::sqrt(dev_xx * dev_xx + dev_yy * dev_yy + 2.0f * s_xy * s_xy);

        int eff_scheme = (p.transfer_scheme >= 0) ? p.transfer_scheme : static_cast<int>(m_transfer_scheme);

        if (eff_scheme == static_cast<int>(MPMTransferScheme::RadialMLS)) {
            // Radial Moving Least Squares MPM (Wendland C2 kernel with Centroid-Centered Linear Completeness)
            float R_supp = 2.0f * std::max(m_dx, m_dy);
            float weight_sum = 0.0f;
            float cx = 0.0f, cy = 0.0f;

            for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= m_nx) continue;
                float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= m_ny) continue;
                    float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                    float dist_x = node_x - p.x[0];
                    float dist_y = node_y - p.x[1];
                    float r = std::sqrt(dist_x * dist_x + dist_y * dist_y);
                    if (r >= R_supp) continue;

                    float w = evalWendland_C2(r, R_supp);
                    if (w < 1.0e-7f) continue;

                    weight_sum += w;
                    cx += w * node_x;
                    cy += w * node_y;
                }
            }

            if (weight_sum <= 1.0e-7f) continue;
            float inv_w_sum = 1.0f / weight_sum;
            float xc = cx * inv_w_sum;
            float yc = cy * inv_w_sum;

            float D[2][2] = {{0.0f, 0.0f}, {0.0f, 0.0f}};
            for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= m_nx) continue;
                float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= m_ny) continue;
                    float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                    float dist_x = node_x - p.x[0];
                    float dist_y = node_y - p.x[1];
                    float r = std::sqrt(dist_x * dist_x + dist_y * dist_y);
                    if (r >= R_supp) continue;

                    float w = evalWendland_C2(r, R_supp);
                    if (w < 1.0e-7f) continue;

                    float dc_x = node_x - xc;
                    float dc_y = node_y - yc;

                    D[0][0] += w * dc_x * dc_x;
                    D[0][1] += w * dc_x * dc_y;
                    D[1][1] += w * dc_y * dc_y;
                }
            }

            D[0][0] *= inv_w_sum; D[0][1] *= inv_w_sum;
            D[1][0] = D[0][1];    D[1][1] *= inv_w_sum;

            float D_inv[2][2];
            float det = D[0][0] * D[1][1] - D[0][1] * D[0][1];
            if (det > 1.0e-18f) {
                float inv_det = 1.0f / det;
                D_inv[0][0] =  D[1][1] * inv_det;
                D_inv[0][1] = -D[0][1] * inv_det;
                D_inv[1][0] =  D_inv[0][1];
                D_inv[1][1] =  D[0][0] * inv_det;
            } else {
                float d_iso = 3.6f / (m_dx * m_dx);
                D_inv[0][0] = d_iso; D_inv[0][1] = 0.0f;
                D_inv[1][0] = 0.0f;  D_inv[1][1] = d_iso;
            }

            float s_Dinv[2][2];
            s_Dinv[0][0] = s_xx * D_inv[0][0] + s_xy * D_inv[1][0];
            s_Dinv[0][1] = s_xx * D_inv[0][1] + s_xy * D_inv[1][1];
            s_Dinv[1][0] = s_xy * D_inv[0][0] + s_yy * D_inv[1][0];
            s_Dinv[1][1] = s_xy * D_inv[0][1] + s_yy * D_inv[1][1];

            for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= m_nx) continue;
                float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= m_ny) continue;
                    float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                    float dist_x = node_x - p.x[0];
                    float dist_y = node_y - p.x[1];
                    float r = std::sqrt(dist_x * dist_x + dist_y * dist_y);
                    if (r >= R_supp) continue;

                    float w = evalWendland_C2(r, R_supp);
                    if (w < 1.0e-7f) continue;

                    float weight = w * inv_w_sum;
                    int node_idx = i * m_ny + j;
                    auto& node = m_grid[node_idx];

                    node.m += p.m * weight;

                    float dc_x = node_x - xc;
                    float dc_y = node_y - yc;

                    float v_apic_x = p.v[0] + (p.B[0][0] * dc_x + p.B[0][1] * dc_y);
                    float v_apic_y = p.v[1] + (p.B[1][0] * dc_x + p.B[1][1] * dc_y);

                    node.p[0] += p.m * weight * v_apic_x;
                    node.p[1] += p.m * weight * v_apic_y;

                    // Affine Internal Stress Force: f_int += -V * weight * (s_Dinv · dc)
                    node.f_int[0] -= p.V * weight * (s_Dinv[0][0] * dc_x + s_Dinv[0][1] * dc_y);
                    node.f_int[1] -= p.V * weight * (s_Dinv[1][0] * dc_x + s_Dinv[1][1] * dc_y);

                    node.von_mises += p.m * weight * vm_stress;
                    node.plastic_strain += p.m * weight * p.ep_bar;
                    node.density += p.m * weight * p.density;
                    node.pressure += p.m * weight * press;
                    node.damage += p.m * weight * p.damage;
                }
            }
        } else {
            // Standard / GIMP / BSpline / CubicBSpline
            for (int offset_i = -1; offset_i <= 2; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= m_nx) continue;
                float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                float Sx = 0.0f, dSx = 0.0f;
                if (eff_scheme == static_cast<int>(MPMTransferScheme::GIMP)) {
                    Sx = evalGIMP_S(p.x[0], node_x, m_dx, p.lp[0]);
                    dSx = evalGIMP_dS(p.x[0], node_x, m_dx, p.lp[0]);
                } else if (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline)) {
                    Sx = evalBSpline_S(p.x[0], node_x, m_dx);
                    dSx = evalBSpline_dS(p.x[0], node_x, m_dx);
                } else if (eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) {
                    Sx = evalCubicBSpline_S(p.x[0], node_x, m_dx);
                    dSx = evalCubicBSpline_dS(p.x[0], node_x, m_dx);
                } else {
                    Sx = std::max(0.0f, 1.0f - std::abs(p.x[0] - node_x) / m_dx);
                    dSx = (p.x[0] >= node_x ? -1.0f / m_dx : 1.0f / m_dx);
                }

                if (std::abs(Sx) < 1.0e-7f) continue;

                for (int offset_j = -1; offset_j <= 2; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= m_ny) continue;
                    float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                    float Sy = 0.0f, dSy = 0.0f;
                    if (eff_scheme == static_cast<int>(MPMTransferScheme::GIMP)) {
                        Sy = evalGIMP_S(p.x[1], node_y, m_dy, p.lp[1]);
                        dSy = evalGIMP_dS(p.x[1], node_y, m_dy, p.lp[1]);
                    } else if (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline)) {
                        Sy = evalBSpline_S(p.x[1], node_y, m_dy);
                        dSy = evalBSpline_dS(p.x[1], node_y, m_dy);
                    } else if (eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) {
                        Sy = evalCubicBSpline_S(p.x[1], node_y, m_dy);
                        dSy = evalCubicBSpline_dS(p.x[1], node_y, m_dy);
                    } else {
                        Sy = std::max(0.0f, 1.0f - std::abs(p.x[1] - node_y) / m_dy);
                        dSy = (p.x[1] >= node_y ? -1.0f / m_dy : 1.0f / m_dy);
                    }

                    if (std::abs(Sy) < 1.0e-7f) continue;

                    float weight = Sx * Sy;
                    float dN_dx = dSx * Sy;
                    float dN_dy = Sx * dSy;

                    int node_idx = i * m_ny + j;
                    auto& node = m_grid[node_idx];

                    // Mass scatter
                    node.m += p.m * weight;

                    // APIC Momentum scatter
                    float dist_x = node_x - p.x[0];
                    float dist_y = node_y - p.x[1];

                    float v_apic_x = p.v[0] + (p.B[0][0] * dist_x + p.B[0][1] * dist_y);
                    float v_apic_y = p.v[1] + (p.B[1][0] * dist_x + p.B[1][1] * dist_y);

                    node.p[0] += p.m * weight * v_apic_x;
                    node.p[1] += p.m * weight * v_apic_y;

                    // Internal Stress Force scatter: f_int += -V_p * sigma_p * dN
                    node.f_int[0] += p.V * (p.sigma[0][0] * dN_dx + p.sigma[0][1] * dN_dy);
                    node.f_int[1] += p.V * (p.sigma[1][0] * dN_dx + p.sigma[1][1] * dN_dy);

                    // Telemetry scalar field scatter
                    node.von_mises += p.m * weight * vm_stress;
                    node.plastic_strain += p.m * weight * p.ep_bar;
                    node.density += p.m * weight * p.density;
                    node.pressure += p.m * weight * press;
                    node.damage += p.m * weight * p.damage;
                }
            }
        }
    }

    // Normalize Telemetry Scalars on Grid Nodes
    for (auto& node : m_grid) {
        if (node.m > 1.0e-14f) {
            node.von_mises /= node.m;
            node.plastic_strain /= node.m;
            node.density /= node.m;
            node.pressure /= node.m;
            node.damage /= node.m;
        }
    }

    if (m_smooth_plastic_strain) {
        std::vector<float> smoothed_ep(m_grid.size(), 0.0f);
        for (int i = 0; i < m_nx; ++i) {
            for (int j = 0; j < m_ny; ++j) {
                int idx = i * m_ny + j;
                if (m_grid[idx].m <= 1.0e-14f) continue;
                float sum_ep = 2.0f * m_grid[idx].plastic_strain;
                float weight_sum = 2.0f;
                for (int di = -1; di <= 1; ++di) {
                    for (int dj = -1; dj <= 1; ++dj) {
                        if (di == 0 && dj == 0) continue;
                        int ni = i + di; int nj = j + dj;
                        if (ni >= 0 && ni < m_nx && nj >= 0 && nj < m_ny) {
                            int n_idx = ni * m_ny + nj;
                            if (m_grid[n_idx].m > 1.0e-14f) {
                                float w = 1.0f / static_cast<float>(std::abs(di) + std::abs(dj));
                                sum_ep += w * m_grid[n_idx].plastic_strain;
                                weight_sum += w;
                            }
                        }
                    }
                }
                smoothed_ep[idx] = sum_ep / weight_sum;
            }
        }
        for (size_t idx = 0; idx < m_grid.size(); ++idx) {
            if (m_grid[idx].m > 1.0e-14f) {
                m_grid[idx].plastic_strain = smoothed_ep[idx];
            }
        }
    }
}

void MPMSolver2D::updateGridKinematics(float dt) {
    float avg_p_mass = 0.001f;
    if (!m_particles.empty()) {
        avg_p_mass = m_particles[0].m;
    }

    for (int i = 0; i < m_nx; ++i) {
        for (int j = 0; j < m_ny; ++j) {
            int idx = i * m_ny + j;
            auto& node = m_grid[idx];

            if (node.m <= 1.0e-14f) {
                node.v[0] = 0.0f;
                node.v[1] = 0.0f;
                node.v_old[0] = 0.0f;
                node.v_old[1] = 0.0f;
                continue;
            }

            node.v_old[0] = node.p[0] / node.m;
            node.v_old[1] = node.p[1] / node.m;

            float m_eff = std::max(node.m, 0.25f * avg_p_mass);
            float total_fx = -node.f_int[0] + node.f_ext[0];
            float total_fy = -node.f_int[1] + node.f_ext[1];

            node.v[0] = node.v_old[0] + dt * (total_fx / m_eff);
            node.v[1] = node.v_old[1] + dt * (total_fy / m_eff);

            // Domain Boundary Conditions (No-Slip Sticky)
            if (i == 0 || i == m_nx - 1) {
                node.v[0] = 0.0f;
                node.v_old[0] = 0.0f;
            }
            if (j == 0 || j == m_ny - 1) {
                node.v[1] = 0.0f;
                node.v_old[1] = 0.0f;
            }
        }
    }
}

void MPMSolver2D::gridToParticle(float dt) {
    float max_B = 5000.0f / std::min(m_dx, m_dy);

    for (auto& p : m_particles) {
        int base_i = static_cast<int>(std::floor((p.x[0]) / m_dx));
        int base_j = static_cast<int>(std::floor((p.x[1]) / m_dy));

        float v_pic_x = 0.0f;
        float v_pic_y = 0.0f;
        float v_flip_x = p.v[0];
        float v_flip_y = p.v[1];
        float weight_sum = 0.0f;

        float B_new[2][2] = {{0.0f, 0.0f}, {0.0f, 0.0f}};
        float L_new[2][2] = {{0.0f, 0.0f}, {0.0f, 0.0f}};

        int eff_scheme = (p.transfer_scheme >= 0) ? p.transfer_scheme : static_cast<int>(m_transfer_scheme);
        if (eff_scheme == static_cast<int>(MPMTransferScheme::RadialMLS)) {
            float R_supp = 2.0f * std::max(m_dx, m_dy);
            float weight_sum_local = 0.0f;
            float cx = 0.0f, cy = 0.0f;

            for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= m_nx) continue;
                float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= m_ny) continue;
                    float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                    float dist_x = node_x - p.x[0];
                    float dist_y = node_y - p.x[1];
                    float r = std::sqrt(dist_x * dist_x + dist_y * dist_y);
                    if (r >= R_supp) continue;

                    float w = evalWendland_C2(r, R_supp);
                    if (w < 1.0e-7f) continue;

                    weight_sum_local += w;
                    cx += w * node_x;
                    cy += w * node_y;
                }
            }

            if (weight_sum_local <= 1.0e-7f) {
                v_pic_x = p.v[0]; v_pic_y = p.v[1];
            } else {
                float inv_w_sum = 1.0f / weight_sum_local;
                float xc = cx * inv_w_sum;
                float yc = cy * inv_w_sum;

                float D[2][2] = {{0.0f, 0.0f}, {0.0f, 0.0f}};
                for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                    int i = base_i + offset_i;
                    if (i < 0 || i >= m_nx) continue;
                    float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                    for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                        int j = base_j + offset_j;
                        if (j < 0 || j >= m_ny) continue;
                        float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                        float dist_x = node_x - p.x[0];
                        float dist_y = node_y - p.x[1];
                        float r = std::sqrt(dist_x * dist_x + dist_y * dist_y);
                        if (r >= R_supp) continue;

                        float w = evalWendland_C2(r, R_supp);
                        if (w < 1.0e-7f) continue;

                        float dc_x = node_x - xc;
                        float dc_y = node_y - yc;

                        D[0][0] += w * dc_x * dc_x;
                        D[0][1] += w * dc_x * dc_y;
                        D[1][1] += w * dc_y * dc_y;
                    }
                }

                D[0][0] *= inv_w_sum; D[0][1] *= inv_w_sum;
                D[1][0] = D[0][1];    D[1][1] *= inv_w_sum;

                float D_inv[2][2];
                float det = D[0][0] * D[1][1] - D[0][1] * D[0][1];
                if (det > 1.0e-18f) {
                    float inv_det = 1.0f / det;
                    D_inv[0][0] =  D[1][1] * inv_det;
                    D_inv[0][1] = -D[0][1] * inv_det;
                    D_inv[1][0] =  D_inv[0][1];
                    D_inv[1][1] =  D[0][0] * inv_det;
                } else {
                    float d_iso = 3.6f / (m_dx * m_dx);
                    D_inv[0][0] = d_iso; D_inv[0][1] = 0.0f;
                    D_inv[1][0] = 0.0f;  D_inv[1][1] = d_iso;
                }

                for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                    int i = base_i + offset_i;
                    if (i < 0 || i >= m_nx) continue;
                    float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                    for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                        int j = base_j + offset_j;
                        if (j < 0 || j >= m_ny) continue;
                        float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                        float dist_x = node_x - p.x[0];
                        float dist_y = node_y - p.x[1];
                        float r = std::sqrt(dist_x * dist_x + dist_y * dist_y);
                        if (r >= R_supp) continue;

                        float w = evalWendland_C2(r, R_supp);
                        if (w < 1.0e-7f) continue;

                        float weight = w * inv_w_sum;
                        int node_idx = i * m_ny + j;
                        const auto& node = m_grid[node_idx];

                        if (node.m > 1.0e-14f) {
                            v_pic_x += weight * node.v[0];
                            v_pic_y += weight * node.v[1];
                            v_flip_x += weight * (node.v[0] - node.v_old[0]);
                            v_flip_y += weight * (node.v[1] - node.v_old[1]);
                            weight_sum += weight;

                            float dc_x = node_x - xc;
                            float dc_y = node_y - yc;

                            float d_dinv_x = D_inv[0][0] * dc_x + D_inv[0][1] * dc_y;
                            float d_dinv_y = D_inv[1][0] * dc_x + D_inv[1][1] * dc_y;

                            B_new[0][0] += weight * node.v[0] * d_dinv_x;
                            B_new[0][1] += weight * node.v[0] * d_dinv_y;
                            B_new[1][0] += weight * node.v[1] * d_dinv_x;
                            B_new[1][1] += weight * node.v[1] * d_dinv_y;

                            L_new[0][0] += node.v[0] * weight * d_dinv_x;
                            L_new[0][1] += node.v[0] * weight * d_dinv_y;
                            L_new[1][0] += node.v[1] * weight * d_dinv_x;
                            L_new[1][1] += node.v[1] * weight * d_dinv_y;
                        }
                    }
                }
            }
        } else {
            float d_scale = (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline) ||
                             eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) ? 4.0f : 3.0f;
            float D_inv_x = d_scale / (m_dx * m_dx);
            float D_inv_y = d_scale / (m_dy * m_dy);

            for (int offset_i = -1; offset_i <= 2; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= m_nx) continue;
                float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                float Sx = 0.0f, dSx = 0.0f;
                if (eff_scheme == static_cast<int>(MPMTransferScheme::GIMP)) {
                    Sx = evalGIMP_S(p.x[0], node_x, m_dx, p.lp[0]);
                    dSx = evalGIMP_dS(p.x[0], node_x, m_dx, p.lp[0]);
                } else if (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline)) {
                    Sx = evalBSpline_S(p.x[0], node_x, m_dx);
                    dSx = evalBSpline_dS(p.x[0], node_x, m_dx);
                } else if (eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) {
                    Sx = evalCubicBSpline_S(p.x[0], node_x, m_dx);
                    dSx = evalCubicBSpline_dS(p.x[0], node_x, m_dx);
                } else {
                    Sx = std::max(0.0f, 1.0f - std::abs(p.x[0] - node_x) / m_dx);
                    dSx = (p.x[0] >= node_x ? -1.0f / m_dx : 1.0f / m_dx);
                }

                if (std::abs(Sx) < 1.0e-7f) continue;

                for (int offset_j = -1; offset_j <= 2; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= m_ny) continue;
                    float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                    float Sy = 0.0f, dSy = 0.0f;
                    if (eff_scheme == static_cast<int>(MPMTransferScheme::GIMP)) {
                        Sy = evalGIMP_S(p.x[1], node_y, m_dy, p.lp[1]);
                        dSy = evalGIMP_dS(p.x[1], node_y, m_dy, p.lp[1]);
                    } else if (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline)) {
                        Sy = evalBSpline_S(p.x[1], node_y, m_dy);
                        dSy = evalBSpline_dS(p.x[1], node_y, m_dy);
                    } else if (eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) {
                        Sy = evalCubicBSpline_S(p.x[1], node_y, m_dy);
                        dSy = evalCubicBSpline_dS(p.x[1], node_y, m_dy);
                    } else {
                        Sy = std::max(0.0f, 1.0f - std::abs(p.x[1] - node_y) / m_dy);
                        dSy = (p.x[1] >= node_y ? -1.0f / m_dy : 1.0f / m_dy);
                    }

                    if (std::abs(Sy) < 1.0e-7f) continue;

                    float weight = Sx * Sy;
                    float dN_dx = dSx * Sy;
                    float dN_dy = Sx * dSy;

                    int node_idx = i * m_ny + j;
                    const auto& node = m_grid[node_idx];

                    if (node.m > 1.0e-14f) {
                        v_pic_x += weight * node.v[0];
                        v_pic_y += weight * node.v[1];
                        v_flip_x += weight * (node.v[0] - node.v_old[0]);
                        v_flip_y += weight * (node.v[1] - node.v_old[1]);
                        weight_sum += weight;

                        float dist_x = node_x - p.x[0];
                        float dist_y = node_y - p.x[1];

                        float diff_vx = node.v[0] - p.v[0];
                        float diff_vy = node.v[1] - p.v[1];

                        B_new[0][0] += weight * diff_vx * dist_x * D_inv_x;
                        B_new[0][1] += weight * diff_vx * dist_y * D_inv_y;
                        B_new[1][0] += weight * diff_vy * dist_x * D_inv_x;
                        B_new[1][1] += weight * diff_vy * dist_y * D_inv_y;

                        L_new[0][0] += diff_vx * dN_dx;
                        L_new[0][1] += diff_vx * dN_dy;
                        L_new[1][0] += diff_vy * dN_dx;
                        L_new[1][1] += diff_vy * dN_dy;
                    }
                }
            }
        }

        if (weight_sum <= 1.0e-7f) {
            v_pic_x = p.v[0];
            v_pic_y = p.v[1];
        }

        float target_vx = v_pic_x;
        float target_vy = v_pic_y;

        if (p.has_failed || p.damage >= 1.0f) {
            target_vx = v_flip_x;
            target_vy = v_flip_y;
        } else if (m_velocity_scheme == MPMVelocityScheme::FLIP) {
            float alpha = std::clamp(m_flip_blend, 0.0f, 1.0f);
            target_vx = alpha * v_flip_x + (1.0f - alpha) * v_pic_x;
            target_vy = alpha * v_flip_y + (1.0f - alpha) * v_pic_y;
        }

        p.v[0] = std::clamp(target_vx, -5000.0f, 5000.0f);
        p.v[1] = std::clamp(target_vy, -5000.0f, 5000.0f);

        p.B[0][0] = (m_velocity_scheme == MPMVelocityScheme::APIC) ? std::clamp(B_new[0][0], -max_B, max_B) : 0.0f;
        p.B[0][1] = (m_velocity_scheme == MPMVelocityScheme::APIC) ? std::clamp(B_new[0][1], -max_B, max_B) : 0.0f;
        p.B[1][0] = (m_velocity_scheme == MPMVelocityScheme::APIC) ? std::clamp(B_new[1][0], -max_B, max_B) : 0.0f;
        p.B[1][1] = (m_velocity_scheme == MPMVelocityScheme::APIC) ? std::clamp(B_new[1][1], -max_B, max_B) : 0.0f;

        p.L_grad[0][0] = std::clamp(L_new[0][0], -max_B, max_B);
        p.L_grad[0][1] = std::clamp(L_new[0][1], -max_B, max_B);
        p.L_grad[1][0] = std::clamp(L_new[1][0], -max_B, max_B);
        p.L_grad[1][1] = std::clamp(L_new[1][1], -max_B, max_B);

        // Update Particle Position
        p.x[0] += dt * p.v[0];
        p.x[1] += dt * p.v[1];

        // Domain Boundary Clamping
        float min_margin_x = 1.5f * m_dx;
        float max_margin_x = (static_cast<float>(m_nx) - 1.5f) * m_dx;
        float min_margin_y = 1.5f * m_dy;
        float max_margin_y = (static_cast<float>(m_ny) - 1.5f) * m_dy;

        if (p.x[0] < min_margin_x) {
            p.x[0] = min_margin_x;
            if (p.v[0] < 0.0f) p.v[0] = 0.0f;
            p.B[0][0] = 0.0f; p.B[0][1] = 0.0f;
        } else if (p.x[0] > max_margin_x) {
            p.x[0] = max_margin_x;
            if (p.v[0] > 0.0f) p.v[0] = 0.0f;
            p.B[0][0] = 0.0f; p.B[0][1] = 0.0f;
        }

        if (p.x[1] < min_margin_y) {
            p.x[1] = min_margin_y;
            if (p.v[1] < 0.0f) p.v[1] = 0.0f;
            p.B[1][0] = 0.0f; p.B[1][1] = 0.0f;
        } else if (p.x[1] > max_margin_y) {
            p.x[1] = max_margin_y;
            if (p.v[1] > 0.0f) p.v[1] = 0.0f;
            p.B[1][0] = 0.0f; p.B[1][1] = 0.0f;
        }
    }
}

void MPMSolver2D::updateStressState(float dt) {
    for (auto& p : m_particles) {
        // True velocity gradient L evaluated from exact shape function derivatives L_grad
        float L[2][2] = {
            { p.L_grad[0][0], p.L_grad[0][1] },
            { p.L_grad[1][0], p.L_grad[1][1] }
        };

        // Strain rate D = 0.5 * (L + L^T)
        float deps_xx = L[0][0] * dt;
        float deps_yy = L[1][1] * dt;
        float deps_xy = 0.5f * (L[0][1] + L[1][0]) * dt;
        float tr_deps = deps_xx + deps_yy;

        // --- Option B: Granular Coulomb Debris Model for Eroded/Failed Particles ---
        if (p.has_failed) {
            p.damage = 1.0f;
            p.B[0][0] = 0.0f; p.B[0][1] = 0.0f;
            p.B[1][0] = 0.0f; p.B[1][1] = 0.0f;

            p.V = std::clamp(p.V * (1.0f + tr_deps), 0.1f * p.V0, 10.0f * p.V0);

            // 1. Bulk Pressure from Volumetric Compression J = V / V0
            const float J = p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f);
            float p_comp = 0.0f;
            if (J < 1.0f) {
                const float E_mod    = p.youngs_modulus;
                const float nu       = p.poissons_ratio;
                const float K_intact = E_mod / (2.0f * std::max(1.0e-4f, 1.0f - nu)); // 2D bulk modulus
                const float K_debris = 0.10f * K_intact;
                p_comp = K_debris * (1.0f - J) / J;
            }

            // 2. Frictional Shear Resistance (Drucker-Prager cone limit: q <= M * p_comp)
            const float M_friction = 1.0f;
            const float q_max = M_friction * p_comp;

            const float E_mod = p.youngs_modulus;
            const float nu = p.poissons_ratio;
            const float mu_debris = 0.05f * (E_mod / (2.0f * (1.0f + nu)));

            float s_xx_trial = p.sigma[0][0] + 2.0f * mu_debris * (deps_xx - 0.5f * tr_deps);
            float s_yy_trial = p.sigma[1][1] + 2.0f * mu_debris * (deps_yy - 0.5f * tr_deps);
            float s_xy_trial = p.sigma[0][1] + 2.0f * mu_debris * deps_xy;

            float press_s = -0.5f * (s_xx_trial + s_yy_trial);
            s_xx_trial += press_s;
            s_yy_trial += press_s;

            float q_trial = std::sqrt(s_xx_trial * s_xx_trial + s_yy_trial * s_yy_trial + 2.0f * s_xy_trial * s_xy_trial);

            if (q_trial > q_max && q_trial > 1.0e-7f) {
                float scale = q_max / q_trial;
                p.sigma[0][0] = scale * s_xx_trial - p_comp;
                p.sigma[1][1] = scale * s_yy_trial - p_comp;
                p.sigma[0][1] = scale * s_xy_trial;
                p.sigma[1][0] = p.sigma[0][1];
            } else {
                p.sigma[0][0] = s_xx_trial - p_comp;
                p.sigma[1][1] = s_yy_trial - p_comp;
                p.sigma[0][1] = s_xy_trial;
                p.sigma[1][0] = p.sigma[0][1];
            }

            continue;
        }

        // --- Johnson-Cook Plasticity + Mie-Grüneisen Shock EOS Model ---
        if (p.material_model == MPMMaterialModel::JohnsonCookMieGruneisen) {
            float w_factor = 1.0f;
            if (p.weibull_modulus > 0.001f) {
                w_factor = computeWeibullFactor2D(p.x[0], p.x[1], p.weibull_modulus, p.weibull_scale);
            }

            p.V = std::clamp(p.V * (1.0f + tr_deps), 0.1f * p.V0, 10.0f * p.V0);
            const float J = p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f);
            const float mu_vol = (1.0f - J) / J;

            // 1. Mie-Grüneisen Shock EOS Hydrostatic Pressure
            float p_hydro = 0.0f;
            if (mu_vol > 0.0f) {
                float denom = 1.0f - (p.mg_s - 1.0f) * mu_vol;
                if (denom < 0.1f) denom = 0.1f;
                float p_H = (p.density * p.mg_c0 * p.mg_c0 * mu_vol * (1.0f + mu_vol)) / (denom * denom);
                float e_H = (p_H * mu_vol) / (2.0f * p.density * (1.0f + mu_vol));
                p_hydro = p_H + p.mg_gamma0 * p.density * (p.e_int - e_H);
            } else {
                p_hydro = p.density * p.mg_c0 * p.mg_c0 * mu_vol;
            }

            // 2. Jaumann Stress Rate Rotation
            float W_xy = 0.5f * (L[0][1] - L[1][0]);
            float rot_xx =  2.0f * W_xy * p.sigma[0][1] * dt;
            float rot_yy = -2.0f * W_xy * p.sigma[0][1] * dt;
            float rot_xy =  W_xy * (p.sigma[1][1] - p.sigma[0][0]) * dt;

            float sig_xx_base = p.sigma[0][0] + rot_xx;
            float sig_yy_base = p.sigma[1][1] + rot_yy;
            float sig_xy_base = p.sigma[0][1] + rot_xy;

            float E = p.youngs_modulus;
            float nu = p.poissons_ratio;
            float mu_shear = E / (2.0f * (1.0f + nu));

            float s_xx_trial = sig_xx_base + 2.0f * mu_shear * (deps_xx - 0.5f * tr_deps);
            float s_yy_trial = sig_yy_base + 2.0f * mu_shear * (deps_yy - 0.5f * tr_deps);
            float s_xy_trial = sig_xy_base + 2.0f * mu_shear * deps_xy;

            float press_s = -0.5f * (s_xx_trial + s_yy_trial);
            s_xx_trial += press_s;
            s_yy_trial += press_s;

            float q_trial = std::sqrt(s_xx_trial * s_xx_trial + s_yy_trial * s_yy_trial + 2.0f * s_xy_trial * s_xy_trial);

            // 3. Johnson-Cook Yield Stress with Weibull Flaw Scatter
            float dev_xx = deps_xx - 0.5f * tr_deps;
            float dev_yy = deps_yy - 0.5f * tr_deps;
            float dev_xy = deps_xy;
            float deps_eq = std::sqrt(dev_xx * dev_xx + dev_yy * dev_yy + 2.0f * dev_xy * dev_xy);
            float ep_dot_star = std::max(1.0f, deps_eq / (dt > 1e-12f ? dt : 1e-12f));
            float T_star = std::clamp((p.temperature - p.T_room) / (p.T_melt > p.T_room ? p.T_melt - p.T_room : 1.0f), 0.0f, 1.0f);

            float term_strain = (p.jc_A * w_factor) + p.jc_B * std::pow(std::max(0.0f, p.ep_bar), p.jc_n);
            float term_rate   = 1.0f + p.jc_C * std::log(ep_dot_star);
            float term_temp   = 1.0f - std::pow(T_star, p.jc_m);
            if (term_temp < 0.0f) term_temp = 0.0f;

            float jc_yield = term_strain * term_rate * term_temp;
            if (T_star >= 1.0f) jc_yield = 0.0f; // Liquid state

            // 4. Radial Return Mapping & Plastic Work Dissipation
            float delta_ep = 0.0f;
            if (q_trial > 1.0e-5f && q_trial > jc_yield) {
                delta_ep = (q_trial - jc_yield) / (2.0f * mu_shear + p.hardening_modulus);
                float scale = (q_trial > 1e-12f) ? (jc_yield / q_trial) : 0.0f;
                p.sigma[0][0] = scale * s_xx_trial - p_hydro;
                p.sigma[1][1] = scale * s_yy_trial - p_hydro;
                p.sigma[0][1] = scale * s_xy_trial;
                p.sigma[1][0] = p.sigma[0][1];
                p.ep_bar += delta_ep;
            } else {
                p.sigma[0][0] = s_xx_trial - p_hydro;
                p.sigma[1][1] = s_yy_trial - p_hydro;
                p.sigma[0][1] = s_xy_trial;
                p.sigma[1][0] = p.sigma[0][1];
            }

            if (delta_ep > 0.0f && p.density > 0.0f && p.Cp > 0.0f) {
                float dw_p = jc_yield * delta_ep;
                float de_p = (0.90f * dw_p) / p.density;
                p.e_int += de_p;
                p.temperature = p.T_room + p.e_int / p.Cp;
            }

            // 5. Thermal Re-Welding / Healing Rule or Damage Accumulation
            if (p.temperature >= 0.80f * p.T_melt && p_hydro > 0.0f) {
                p.damage = 0.0f;
                p.has_failed = false;
            } else {
                const float fail_strain_base = (p.failure_strain > 0.0f) ? p.failure_strain * w_factor : 0.0f;
                const float tensile_fail_base = (p.tensile_failure_stress > 0.0f) ? p.tensile_failure_stress * w_factor : 0.0f;

                float d_plastic = (fail_strain_base > 0.0f) ? std::clamp(p.ep_bar / fail_strain_base, 0.0f, 1.0f) : 0.0f;
                float tensile_stress = -p_hydro;
                float d_tensile = (tensile_stress > 0.0f && tensile_fail_base > 0.0f)
                    ? std::clamp(tensile_stress / tensile_fail_base, 0.0f, 1.0f) : 0.0f;

                p.damage = std::max(p.damage, std::max(d_plastic, d_tensile));
                if (p.damage >= 1.0f) {
                    p.has_failed = true;
                    p.damage = 1.0f;
                    p.B[0][0] = 0.0f; p.B[0][1] = 0.0f;
                    p.B[1][0] = 0.0f; p.B[1][1] = 0.0f;

                    float p_comp = 0.0f;
                    if (J < 1.0f) {
                        const float K_intact = E / (2.0f * std::max(1.0e-4f, 1.0f - nu));
                        const float K_debris = 0.10f * K_intact;
                        p_comp = K_debris * (1.0f - J) / J;
                    }

                    p.sigma[0][0] = -p_comp;
                    p.sigma[1][1] = -p_comp;
                    p.sigma[0][1] = 0.0f;
                    p.sigma[1][0] = 0.0f;

                    continue;
                }
            }

            if (p.damage > 0.0f) {
                float soft_factor = std::clamp(1.0f - p.damage, 0.0f, 1.0f);
                p.sigma[0][0] *= soft_factor;
                p.sigma[1][1] *= soft_factor;
                p.sigma[0][1] *= soft_factor;
                p.sigma[1][0] *= soft_factor;
            }

            continue;
        }


        // Vorticity W = 0.5 * (L - L^T)
        float W_xy = 0.5f * (L[0][1] - L[1][0]);

        // Jaumann objective stress rate rotation: dSigma_rot = (W * Sigma - Sigma * W) * dt
        float rot_xx =  2.0f * W_xy * p.sigma[0][1] * dt;
        float rot_yy = -2.0f * W_xy * p.sigma[0][1] * dt;
        float rot_xy =  W_xy * (p.sigma[1][1] - p.sigma[0][0]) * dt;

        float sig_xx_base = p.sigma[0][0] + rot_xx;
        float sig_yy_base = p.sigma[1][1] + rot_yy;
        float sig_xy_base = p.sigma[0][1] + rot_xy;

        float w_factor = 1.0f;
        if (p.weibull_modulus > 0.001f) {
            w_factor = computeWeibullFactor2D(p.x[0], p.x[1], p.weibull_modulus, p.weibull_scale);
        }

        // Lame Elastic Parameters
        float E = p.youngs_modulus;
        float nu = p.poissons_ratio;
        float mu = E / (2.0f * (1.0f + nu));
        float lambda = (E * nu) / ((1.0f + nu) * (1.0f - 2.0f * nu));

        // Trial Elastic Stress Update
        float sig_xx_trial = sig_xx_base + lambda * tr_deps + 2.0f * mu * deps_xx;
        float sig_yy_trial = sig_yy_base + lambda * tr_deps + 2.0f * mu * deps_yy;
        float sig_xy_trial = sig_xy_base + 2.0f * mu * deps_xy;

        // Hydrostatic Pressure & Deviatoric Stress
        float press = -0.5f * (sig_xx_trial + sig_yy_trial);
        float s_xx = sig_xx_trial + press;
        float s_yy = sig_yy_trial + press;
        float s_xy = sig_xy_trial;

        // Von Mises Equivalent Stress
        float q_trial = std::sqrt(s_xx * s_xx + s_yy * s_yy + 2.0f * s_xy * s_xy);
        float yield_base = p.yield_stress * w_factor;
        float yield_surf = q_trial - (yield_base + p.hardening_modulus * p.ep_bar);

        if (q_trial > 1.0e-5f && yield_surf > 0.0f) {
            // Radial Return Plastic Correction
            float delta_ep = yield_surf / (2.0f * mu + p.hardening_modulus);
            float scale = 1.0f - (2.0f * mu * delta_ep) / q_trial;
            if (scale < 0.0f) scale = 0.0f;

            p.sigma[0][0] = scale * s_xx - press;
            p.sigma[1][1] = scale * s_yy - press;
            p.sigma[0][1] = scale * s_xy;
            p.sigma[1][0] = p.sigma[0][1];

            p.ep_bar += delta_ep;
        } else {
            p.sigma[0][0] = sig_xx_trial;
            p.sigma[1][1] = sig_yy_trial;
            p.sigma[0][1] = sig_xy_trial;
            p.sigma[1][0] = sig_xy_trial;
        }

        // Evaluate Material Damage & Failure Criteria with Weibull Scatter
        float fail_strain_base = (p.failure_strain > 0.0f) ? p.failure_strain * w_factor : 0.0f;
        float tensile_fail_base = (p.tensile_failure_stress > 0.0f) ? p.tensile_failure_stress * w_factor : 0.0f;

        float d_plastic = (fail_strain_base > 0.0f) ? std::clamp(p.ep_bar / fail_strain_base, 0.0f, 1.0f) : 0.0f;
        float curr_press = -0.5f * (p.sigma[0][0] + p.sigma[1][1]);
        float tensile_stress = -curr_press; // Hydrostatic tension (negative pressure)
        float d_tensile = (tensile_stress > 0.0f && tensile_fail_base > 0.0f)
            ? std::clamp(tensile_stress / tensile_fail_base, 0.0f, 1.0f) : 0.0f;

        float target_damage = std::max(d_plastic, d_tensile);
        p.damage = std::max(p.damage, target_damage);
        if (p.damage >= 1.0f) {
            p.has_failed = true;
            p.damage = 1.0f;
            p.B[0][0] = 0.0f; p.B[0][1] = 0.0f;
            p.B[1][0] = 0.0f; p.B[1][1] = 0.0f;

            p.V = std::clamp(p.V * (1.0f + tr_deps), 0.1f * p.V0, 10.0f * p.V0);

            const float J = p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f);
            float p_comp = 0.0f;
            if (J < 1.0f) {
                const float K_intact = E / (2.0f * std::max(1.0e-4f, 1.0f - nu));
                const float K_debris = 0.10f * K_intact;
                p_comp = K_debris * (1.0f - J) / J;
            }

            p.sigma[0][0] = -p_comp;
            p.sigma[1][1] = -p_comp;
            p.sigma[0][1] = 0.0f;
            p.sigma[1][0] = 0.0f;

            continue;
        }

        // Stress Tensor Softening & Degradation
        float soft_factor = std::clamp(1.0f - p.damage, 0.0f, 1.0f);
        if (soft_factor < 0.0f) soft_factor = 0.0f;

        p.sigma[0][0] *= soft_factor;
        p.sigma[1][1] *= soft_factor;
        p.sigma[0][1] *= soft_factor;
        p.sigma[1][0] *= soft_factor;

        // Update Volume incrementally using det(F) = 1 + tr(deps)
        p.V = std::clamp(p.V * (1.0f + tr_deps), 0.1f * p.V0, 10.0f * p.V0);
    }
}


float MPMSolver2D::computeStepSize(float cfl) const {
    if (m_particles.empty()) return 1.0e-6f;
    float max_speed = 100.0f;
    float max_v = 0.0f;
    for (const auto& p : m_particles) {
        if (std::isnan(p.v[0]) || std::isnan(p.v[1]) || std::isinf(p.v[0]) || std::isinf(p.v[1])) continue;
        float E = p.youngs_modulus;
        float rho = std::max(10.0f, p.density);
        float nu = p.poissons_ratio;
        float c_s = 0.0f;
        if (p.material_model == MPMMaterialModel::JohnsonCookMieGruneisen) {
            float C0 = p.mg_c0;
            c_s = std::sqrt(C0 * C0 + (2.0f / 3.0f) * E / (rho * (1.0f + nu)));
        } else {
            if (nu >= 0.0f && nu < 0.5f) {
                float denom = (1.0f + nu) * std::max(0.02f, 1.0f - 2.0f * nu);
                float factor = (1.0f - nu) / denom;
                c_s = std::sqrt(E * factor / rho);
            } else {
                c_s = std::sqrt(E / rho);
            }
        }
        if (std::isnan(c_s) || std::isinf(c_s)) continue;
        float v_mag = std::sqrt(p.v[0] * p.v[0] + p.v[1] * p.v[1]);
        if (v_mag > 5000.0f) v_mag = 5000.0f;
        if (v_mag > max_v) max_v = v_mag;
        float total_speed = c_s + v_mag;
        if (total_speed > max_speed) max_speed = total_speed;
    }
    float min_h = std::min(m_dx, m_dy);
    float dt_crit = min_h / max_speed;
    float stability_factor = 1.0f / std::sqrt(2.0f); // 2D Courant stability factor (~0.707)
    return std::max(1.0e-14f, cfl * stability_factor * dt_crit);
}

void MPMSolver2D::stepWithDt(float dt, bool run_p2g) {
    if (m_particles.empty()) return;
    m_last_dt = dt;
    m_sim_time += static_cast<double>(dt);
    m_step_count++;

    if (m_time_scheme == MPMTimeIntegrationScheme::RK2) {
        // --- 2nd-Order Midpoint RK2 ---
        if (run_p2g) {
            particleToGrid();
        }
        updateGridKinematics(0.5f * dt);
        gridToParticle(0.5f * dt);
        updateStressState(0.5f * dt);

        particleToGrid();
        updateGridKinematics(dt);
        gridToParticle(dt * 0.5f);
        updateStressState(dt * 0.5f);
    } else {
        // Default: 2nd-Order Symplectic Staggered Leapfrog / USL (Single-pass)
        if (run_p2g) {
            particleToGrid();
        }
        updateGridKinematics(dt);
        gridToParticle(dt);
        updateStressState(dt);
    }
}

void MPMSolver2D::step(float cfl) {
    if (m_particles.empty()) return;
    float dt = computeStepSize(cfl);
    if (m_step_count == 0) {
        dt = std::min(dt, 1.0e-7f);
    } else {
        dt = std::min(dt, 1.3f * (m_last_dt > 0.0f ? m_last_dt : 1.0e-7f));
    }
    m_last_cfl = cfl;
    stepWithDt(dt);
}

std::vector<float> MPMSolver2D::getGridScalarField(const std::string& quantity) const {
    std::vector<float> field(m_nx * m_ny, 0.0f);
    for (size_t i = 0; i < m_grid.size(); ++i) {
        if (quantity == "von_mises") {
            field[i] = m_grid[i].von_mises;
        } else if (quantity == "plastic_strain") {
            field[i] = m_grid[i].plastic_strain;
        } else if (quantity == "density") {
            field[i] = m_grid[i].density;
        } else if (quantity == "pressure") {
            field[i] = m_grid[i].pressure;
        } else if (quantity == "damage") {
            field[i] = m_grid[i].damage;
        } else if (quantity == "velocity") {
            float vx = m_grid[i].v[0];
            float vy = m_grid[i].v[1];
            field[i] = std::sqrt(vx * vx + vy * vy);
        }
    }
    return field;
}

} // namespace Blast
