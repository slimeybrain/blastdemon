#include "mpm_solver_2d.hpp"
#include "mpm_solver_3d.hpp"
#include "materials/ConstitutiveDispatcher.hpp"
#include "constitutive_jwl.hpp"
#include "constitutive_lee_tarver.hpp"
#include "constitutive_mixture.hpp"
#include "constitutive_crest_davis.hpp"
#include <cstring>
#include <unordered_map>

namespace Blast {

struct MaterialTable2DHolder {
    std::unordered_map<int, MaterialTable3D> tables;
};

static inline const MaterialTable3D& resolveMaterialTable2D(
    const MPMSolver2D& solver,
    const MPMParticle2D& p,
    MaterialTable3D& scratch
) {
    if (const MaterialTable3D* reg = solver.getMaterialTable(p.object_id)) {
        return *reg;
    }
    scratch.material_model = p.material_model;
    scratch.solid_model = p.solid_model;
    scratch.burn_model = p.burn_model;
    scratch.product_model = p.product_model;
    scratch.density = p.density;
    scratch.youngs_modulus = p.youngs_modulus;
    scratch.poissons_ratio = p.poissons_ratio;
    scratch.yield_stress = p.yield_stress;
    scratch.hardening_modulus = p.hardening_modulus;
    scratch.failure_strain = p.failure_strain;
    scratch.tensile_failure_stress = p.tensile_failure_stress;
    scratch.jc_A = p.jc_A;
    scratch.jc_B = p.jc_B;
    scratch.jc_n = p.jc_n;
    scratch.jc_C = p.jc_C;
    scratch.jc_m = p.jc_m;
    scratch.T_melt = p.T_melt;
    scratch.T_room = p.T_room;
    scratch.Cp = p.Cp;
    scratch.mg_gamma0 = p.mg_gamma0;
    scratch.mg_c0 = p.mg_c0;
    scratch.mg_s = p.mg_s;
    scratch.enable_heterogeneity = p.enable_heterogeneity;
    scratch.weibull_modulus = p.weibull_modulus;
    scratch.weibull_scale = p.weibull_scale;
    scratch.weibull_ref_volume = p.weibull_ref_volume;
    scratch.enable_anisotropy = p.enable_anisotropy;
    scratch.anisotropy_ratio = p.anisotropy_ratio;
    scratch.anisotropy_dir[0] = p.anisotropy_dir[0];
    scratch.anisotropy_dir[1] = p.anisotropy_dir[1];
    scratch.anisotropy_dir[2] = 0.0f;
    scratch.tait_rho0 = p.tait_rho0;
    scratch.tait_B = p.tait_B;
    scratch.tait_gamma = p.tait_gamma;
    scratch.tait_p0 = p.tait_p0;
    scratch.tait_viscosity = p.mu_visc;
    scratch.ideal_gamma = p.ideal_gamma;
    scratch.ideal_R = p.ideal_R;
    scratch.det_vel = p.det_vel;
    scratch.enable_density_erosion = p.enable_density_erosion;
    scratch.erosion_min_density = p.erosion_min_density;
    scratch.erosion_min_density_ratio = p.erosion_min_density_ratio;
    scratch.erode_to_fv_grid = p.erode_to_fv_grid;
    scratch.transfer_scheme = p.transfer_scheme;
    return scratch;
}

MPMSolver2D::MPMSolver2D() {
}

MPMSolver2D::~MPMSolver2D() = default;

void MPMSolver2D::setMaterialTable(int object_id, const MaterialTable3D& mat) {
    if (!m_mat_holder) {
        m_mat_holder = std::make_shared<MaterialTable2DHolder>();
    }
    m_mat_holder->tables[object_id] = mat;
}

const MaterialTable3D* MPMSolver2D::getMaterialTable(int object_id) const {
    if (!m_mat_holder) return nullptr;
    auto it = m_mat_holder->tables.find(object_id);
    return (it != m_mat_holder->tables.end()) ? &it->second : nullptr;
}

void MPMSolver2D::initializeGrid(int nx, int ny, float dx, float dy) {
    m_nx = nx;
    m_ny = ny;
    m_ntx = (m_nx + 7) >> 3;
    m_nty = (m_ny + 7) >> 3;
    m_dx = dx;
    m_dy = dy;

    if (m_sparse_grid_mode) {
        size_t total_tiles = static_cast<size_t>(m_ntx) * m_nty;
        m_tile_table.assign(total_tiles, -1);
        m_active_tiles.clear();
        m_tile_capacity = std::min<size_t>(total_tiles, 64);
        m_grid.clear();
        m_grid.shrink_to_fit();
        m_grid.assign(m_tile_capacity * 64, MPMGridNode2D{});
    } else {
        m_tile_table.clear();
        m_active_tiles.clear();
        m_tile_capacity = 0;
        m_grid.resize(static_cast<size_t>(m_nx) * m_ny);
    }
    m_particles.clear();
    m_terminated = false;
}

float MPMSolver2D::evalLinear_S(float x_p, float x_i, float h) const {
    float q = std::abs(x_p - x_i) / h;
    return (q < 1.0f) ? (1.0f - q) : 0.0f;
}

float MPMSolver2D::evalLinear_dS(float x_p, float x_i, float h) const {
    float diff = x_p - x_i;
    float r = std::abs(diff);
    if (r >= h || r == 0.0f) return 0.0f;
    return (diff > 0.0f) ? (-1.0f / h) : (1.0f / h);
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
    if (particles_per_dim < 1) particles_per_dim = 1;

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

            p.sigma.zero();

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
    if (particles_per_dim < 1) particles_per_dim = 1;

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

            p.sigma.zero();

            p.ep_bar = 0.0f;
            p.object_id = obj_id;

            m_particles.push_back(p);
        }
    }
}

void MPMSolver2D::particleToGrid() {
    if (m_sparse_grid_mode) {
        size_t active_node_limit = m_active_tiles.size() * 64;
        for (size_t idx = 0; idx < active_node_limit && idx < m_grid.size(); ++idx) {
            auto& node = m_grid[idx];
            node.m = 0.0f;
            node.p[0] = 0.0f; node.p[1] = 0.0f;
            node.v[0] = 0.0f; node.v[1] = 0.0f;
            node.v_old[0] = 0.0f; node.v_old[1] = 0.0f;
            node.f_int[0] = 0.0f; node.f_int[1] = 0.0f;
            node.f_ext[0] = 0.0f; node.f_ext[1] = 0.0f;
            node.von_mises = 0.0f;
            node.plastic_strain = 0.0f;
            node.density = 0.0f;
            node.pressure = 0.0f;
            node.damage = 0.0f;
        }
        for (int t_id : m_active_tiles) {
            if (t_id >= 0 && static_cast<size_t>(t_id) < m_tile_table.size()) {
                m_tile_table[t_id] = -1;
            }
        }
        m_active_tiles.clear();

        // Activate 8x8 tiles within [-3, +3] cell halo around each particle
        for (const auto& p : m_particles) {
            if (p.m <= 0.0f) continue;
            int base_i = static_cast<int>(std::floor(p.x[0] / m_dx));
            int base_j = static_cast<int>(std::floor(p.x[1] / m_dy));
            int i0 = std::max(0, base_i - 3);
            int i1 = std::min(m_nx - 1, base_i + 3);
            int j0 = std::max(0, base_j - 3);
            int j1 = std::min(m_ny - 1, base_j + 3);
            if (i0 > i1 || j0 > j1) continue;
            for (int tx = (i0 >> 3); tx <= (i1 >> 3); ++tx) {
                for (int ty = (j0 >> 3); ty <= (j1 >> 3); ++ty) {
                    int t_id = tx * m_nty + ty;
                    if (m_tile_table[t_id] < 0) {
                        int slot = static_cast<int>(m_active_tiles.size());
                        m_tile_table[t_id] = slot;
                        m_active_tiles.push_back(t_id);
                    }
                }
            }
        }

        if (m_active_tiles.size() > m_tile_capacity) {
            size_t total_tiles = static_cast<size_t>(m_ntx) * m_nty;
            m_tile_capacity = std::min<size_t>(
                total_tiles,
                std::max(m_active_tiles.size() + 16, m_tile_capacity + (m_tile_capacity >> 1))
            );
            // Free-before-reallocate to avoid transient double-allocation spike
            m_grid.clear();
            m_grid.shrink_to_fit();
            m_grid.assign(m_tile_capacity * 64, MPMGridNode2D{});
        }
    } else {
        // Clear dense background grid
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
    }

    const MPMGridView2D gv = getGridView();

    // P2G Scatter
    for (const auto& p : m_particles) {
        if (p.m <= 0.0f) continue;
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

        const MaterialTable3D* mat_ptr = getMaterialTable(p.object_id);
        int eff_scheme = (p.transfer_scheme >= 0) ? p.transfer_scheme
                       : ((mat_ptr && mat_ptr->transfer_scheme >= 0) ? mat_ptr->transfer_scheme : static_cast<int>(m_transfer_scheme));

        if (eff_scheme == static_cast<int>(MPMTransferScheme::RadialMLS)) {
            // Radial Moving Least Squares MPM (Wendland C2 ellipsoidal per-axis normalized kernel with Centroid-Centered Linear Completeness)
            const float inv_dx = 1.0f / m_dx;
            const float inv_dy = 1.0f / m_dy;
            // Pass 1: Local partition of unity sum, centroid displacement, and 2nd-moment tensor via Parallel-Axis Theorem
            float weight_sum = 0.0f;
            float sum_wx = 0.0f, sum_wy = 0.0f;
            float sum_wxx = 0.0f, sum_wxy = 0.0f, sum_wyy = 0.0f;

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
                    float rxn = dist_x * inv_dx;
                    float ryn = dist_y * inv_dy;
                    float r_norm = std::sqrt(rxn * rxn + ryn * ryn);
                    if (r_norm >= 2.0f) continue;

                    float w = evalWendland_C2(r_norm, 2.0f);
                    if (w < 1.0e-7f) continue;

                    weight_sum += w;
                    sum_wx += w * dist_x;
                    sum_wy += w * dist_y;

                    sum_wxx += w * dist_x * dist_x;
                    sum_wxy += w * dist_x * dist_y;
                    sum_wyy += w * dist_y * dist_y;
                }
            }

            if (weight_sum <= 1.0e-7f) continue;
            float inv_w_sum = 1.0f / weight_sum;
            float delta_x = sum_wx * inv_w_sum;
            float delta_y = sum_wy * inv_w_sum;
            float xc = p.x[0] + delta_x;
            float yc = p.x[1] + delta_y;

            // Parallel-Axis Moment Tensor: D = sum(w * (x - xc)(x - xc)^T) / w_sum
            //                                = sum(w * (x - p)(x - p)^T) / w_sum - delta * delta^T
            float D[2][2];
            D[0][0] = sum_wxx * inv_w_sum - delta_x * delta_x;
            D[0][1] = sum_wxy * inv_w_sum - delta_x * delta_y;
            D[1][0] = D[0][1];
            D[1][1] = sum_wyy * inv_w_sum - delta_y * delta_y;

            float Dn00 = D[0][0] * inv_dx * inv_dx;
            float Dn01 = D[0][1] * inv_dx * inv_dy;
            float Dn11 = D[1][1] * inv_dy * inv_dy;

            float D_inv[2][2];
            float det_norm = Dn00 * Dn11 - Dn01 * Dn01;
            if (det_norm > 1.0e-5f) {
                float inv_det = 1.0f / det_norm;
                D_inv[0][0] =  Dn11 * inv_det * inv_dx * inv_dx;
                D_inv[0][1] = -Dn01 * inv_det * inv_dx * inv_dy;
                D_inv[1][0] =  D_inv[0][1];
                D_inv[1][1] =  Dn00 * inv_det * inv_dy * inv_dy;
            } else {
                D_inv[0][0] = 5.5f * inv_dx * inv_dx; D_inv[0][1] = 0.0f;
                D_inv[1][0] = 0.0f;                   D_inv[1][1] = 5.5f * inv_dy * inv_dy;
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
                    float rxn = dist_x * inv_dx;
                    float ryn = dist_y * inv_dy;
                    float r_norm = std::sqrt(rxn * rxn + ryn * ryn);
                    if (r_norm >= 2.0f) continue;

                    float w = evalWendland_C2(r_norm, 2.0f);
                    if (w < 1.0e-7f) continue;

                    float weight = w * inv_w_sum;
                    long long node_idx = gv.slotIndex(i, j);
                    if (node_idx < 0) continue;
                    auto& node = m_grid[node_idx];

                    node.m += p.m * weight;

                    float dc_x = node_x - xc;
                    float dc_y = node_y - yc;

                    float v_apic_x = p.v[0] + (p.B[0][0] * dc_x + p.B[0][1] * dc_y);
                    float v_apic_y = p.v[1] + (p.B[1][0] * dc_x + p.B[1][1] * dc_y);

                    node.p[0] += p.m * weight * v_apic_x;
                    node.p[1] += p.m * weight * v_apic_y;

                    // Internal Stress Force scatter (total_f = -f_int): matches tensor-product sign convention
                    node.f_int[0] += p.V * weight * (s_Dinv[0][0] * dc_x + s_Dinv[0][1] * dc_y);
                    node.f_int[1] += p.V * weight * (s_Dinv[1][0] * dc_x + s_Dinv[1][1] * dc_y);

                    node.von_mises += p.m * weight * vm_stress;
                    node.plastic_strain += p.m * weight * p.ep_bar;
                    node.density += p.m * weight * p.density;
                    node.pressure += p.m * weight * press;
                    node.damage += p.m * weight * p.damage;
                }
            }
        } else {
            // Standard / GIMP / BSpline / CubicBSpline
            const int min_offset = (eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) ? -2 : -1;
            const int max_offset = 2;
            float Sx_arr[5] = {}, dSx_arr[5] = {}, Sy_arr[5] = {}, dSy_arr[5] = {};
            if (eff_scheme == static_cast<int>(MPMTransferScheme::GIMP)) {
                for (int offset = min_offset; offset <= max_offset; ++offset) {
                    int idx = offset - min_offset;
                    float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * m_dx;
                    Sx_arr[idx] = evalGIMP_S(p.x[0], nx_val, m_dx, p.lp[0]);
                    dSx_arr[idx] = evalGIMP_dS(p.x[0], nx_val, m_dx, p.lp[0]);

                    float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * m_dy;
                    Sy_arr[idx] = evalGIMP_S(p.x[1], ny_val, m_dy, p.lp[1]);
                    dSy_arr[idx] = evalGIMP_dS(p.x[1], ny_val, m_dy, p.lp[1]);
                }
            } else if (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline)) {
                for (int offset = min_offset; offset <= max_offset; ++offset) {
                    int idx = offset - min_offset;
                    float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * m_dx;
                    Sx_arr[idx] = evalBSpline_S(p.x[0], nx_val, m_dx);
                    dSx_arr[idx] = evalBSpline_dS(p.x[0], nx_val, m_dx);

                    float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * m_dy;
                    Sy_arr[idx] = evalBSpline_S(p.x[1], ny_val, m_dy);
                    dSy_arr[idx] = evalBSpline_dS(p.x[1], ny_val, m_dy);
                }
            } else if (eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) {
                for (int offset = min_offset; offset <= max_offset; ++offset) {
                    int idx = offset - min_offset;
                    float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * m_dx;
                    Sx_arr[idx] = evalCubicBSpline_S(p.x[0], nx_val, m_dx);
                    dSx_arr[idx] = evalCubicBSpline_dS(p.x[0], nx_val, m_dx);

                    float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * m_dy;
                    Sy_arr[idx] = evalCubicBSpline_S(p.x[1], ny_val, m_dy);
                    dSy_arr[idx] = evalCubicBSpline_dS(p.x[1], ny_val, m_dy);
                }
            } else {
                for (int offset = min_offset; offset <= max_offset; ++offset) {
                    int idx = offset - min_offset;
                    float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * m_dx;
                    Sx_arr[idx] = evalLinear_S(p.x[0], nx_val, m_dx);
                    dSx_arr[idx] = evalLinear_dS(p.x[0], nx_val, m_dx);

                    float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * m_dy;
                    Sy_arr[idx] = evalLinear_S(p.x[1], ny_val, m_dy);
                    dSy_arr[idx] = evalLinear_dS(p.x[1], ny_val, m_dy);
                }
            }

            for (int offset_i = min_offset; offset_i <= max_offset; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= m_nx) continue;
                int i_idx = offset_i - min_offset;
                float Sx = Sx_arr[i_idx];
                if (std::abs(Sx) < 1.0e-7f) continue;
                float dSx = dSx_arr[i_idx];
                float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                for (int offset_j = min_offset; offset_j <= max_offset; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= m_ny) continue;
                    int j_idx = offset_j - min_offset;
                    float Sy = Sy_arr[j_idx];
                    if (std::abs(Sy) < 1.0e-7f) continue;
                    float dSy = dSy_arr[j_idx];
                    float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                    float weight = Sx * Sy;
                    float dN_dx = dSx * Sy;
                    float dN_dy = Sx * dSy;

                    long long node_idx = gv.slotIndex(i, j);
                    if (node_idx < 0) continue;
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
    size_t active_limit = m_sparse_grid_mode ? std::min(m_grid.size(), m_active_tiles.size() * 64) : m_grid.size();
    for (size_t idx = 0; idx < active_limit; ++idx) {
        auto& node = m_grid[idx];
        if (node.m > 1.0e-14f) {
            node.von_mises /= node.m;
            node.plastic_strain /= node.m;
            node.density /= node.m;
            node.pressure /= node.m;
            node.damage /= node.m;
        }
    }

    if (m_smooth_plastic_strain) {
        std::vector<float> smoothed_ep(active_limit, 0.0f);
        auto smooth_node = [&](int i, int j, long long idx) {
            if (idx < 0 || static_cast<size_t>(idx) >= active_limit) return;
            if (m_grid[idx].m <= 1.0e-14f) return;
            float sum_ep = 2.0f * m_grid[idx].plastic_strain;
            float weight_sum = 2.0f;
            for (int di = -1; di <= 1; ++di) {
                for (int dj = -1; dj <= 1; ++dj) {
                    if (di == 0 && dj == 0) continue;
                    int ni = i + di; int nj = j + dj;
                    long long n_idx = gv.slotIndex(ni, nj);
                    if (n_idx >= 0 && static_cast<size_t>(n_idx) < active_limit && m_grid[n_idx].m > 1.0e-14f) {
                        float w = 1.0f / static_cast<float>(std::abs(di) + std::abs(dj));
                        sum_ep += w * m_grid[n_idx].plastic_strain;
                        weight_sum += w;
                    }
                }
            }
            smoothed_ep[idx] = sum_ep / weight_sum;
        };

        if (m_sparse_grid_mode) {
            for (size_t t_slot = 0; t_slot < m_active_tiles.size(); ++t_slot) {
                int t_id = m_active_tiles[t_slot];
                int tx = t_id / m_nty;
                int ty = t_id % m_nty;
                for (int lx = 0; lx < 8; ++lx) {
                    int i = (tx << 3) | lx;
                    if (i >= m_nx) continue;
                    for (int ly = 0; ly < 8; ++ly) {
                        int j = (ty << 3) | ly;
                        if (j >= m_ny) continue;
                        long long idx = (static_cast<long long>(t_slot) << 6) | (lx << 3) | ly;
                        smooth_node(i, j, idx);
                    }
                }
            }
        } else {
            for (int i = 0; i < m_nx; ++i) {
                for (int j = 0; j < m_ny; ++j) {
                    smooth_node(i, j, static_cast<long long>(i) * m_ny + j);
                }
            }
        }
        for (size_t idx = 0; idx < active_limit; ++idx) {
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

    auto update_single_node = [&](int i, int j, MPMGridNode2D& node) {
        if (node.m <= 1.0e-14f) {
            node.v[0] = 0.0f;
            node.v[1] = 0.0f;
            node.v_old[0] = 0.0f;
            node.v_old[1] = 0.0f;
            return;
        }

        node.v_old[0] = node.p[0] / node.m;
        node.v_old[1] = node.p[1] / node.m;

        float m_eff = std::max(node.m, 0.25f * avg_p_mass);
        float total_fx = -node.f_int[0] + node.f_ext[0];
        float total_fy = -node.f_int[1] + node.f_ext[1];

        node.v[0] = node.v_old[0] + dt * (total_fx / m_eff);
        node.v[1] = node.v_old[1] + dt * (total_fy / m_eff);

        // Domain Boundary Conditions
        if (i == 0) {
            if (m_bc_x_min == MPMBoundaryCondition2D::Sticky) {
                node.v[0] = 0.0f; node.v[1] = 0.0f;
                node.v_old[0] = 0.0f; node.v_old[1] = 0.0f;
            } else if (m_bc_x_min == MPMBoundaryCondition2D::FreeSlip ||
                       m_bc_x_min == MPMBoundaryCondition2D::Reflecting) {
                if (node.v[0] < 0.0f) node.v[0] = 0.0f;
                if (node.v_old[0] < 0.0f) node.v_old[0] = 0.0f;
            }
        } else if (i == m_nx - 1) {
            if (m_bc_x_max == MPMBoundaryCondition2D::Sticky) {
                node.v[0] = 0.0f; node.v[1] = 0.0f;
                node.v_old[0] = 0.0f; node.v_old[1] = 0.0f;
            } else if (m_bc_x_max == MPMBoundaryCondition2D::FreeSlip ||
                       m_bc_x_max == MPMBoundaryCondition2D::Reflecting) {
                if (node.v[0] > 0.0f) node.v[0] = 0.0f;
                if (node.v_old[0] > 0.0f) node.v_old[0] = 0.0f;
            }
        }
        if (j == 0) {
            if (m_bc_y_min == MPMBoundaryCondition2D::Sticky) {
                node.v[0] = 0.0f; node.v[1] = 0.0f;
                node.v_old[0] = 0.0f; node.v_old[1] = 0.0f;
            } else if (m_bc_y_min == MPMBoundaryCondition2D::FreeSlip ||
                       m_bc_y_min == MPMBoundaryCondition2D::Reflecting) {
                if (node.v[1] < 0.0f) node.v[1] = 0.0f;
                if (node.v_old[1] < 0.0f) node.v_old[1] = 0.0f;
            }
        } else if (j == m_ny - 1) {
            if (m_bc_y_max == MPMBoundaryCondition2D::Sticky) {
                node.v[0] = 0.0f; node.v[1] = 0.0f;
                node.v_old[0] = 0.0f; node.v_old[1] = 0.0f;
            } else if (m_bc_y_max == MPMBoundaryCondition2D::FreeSlip ||
                       m_bc_y_max == MPMBoundaryCondition2D::Reflecting) {
                if (node.v[1] > 0.0f) node.v[1] = 0.0f;
                if (node.v_old[1] > 0.0f) node.v_old[1] = 0.0f;
            }
        }
    };

    if (m_sparse_grid_mode) {
        const size_t num_active_tiles = m_active_tiles.size();
        #pragma omp parallel for schedule(static)
        for (size_t t_slot = 0; t_slot < num_active_tiles; ++t_slot) {
            int t_id = m_active_tiles[t_slot];
            int tx = t_id / m_nty;
            int ty = t_id % m_nty;
            for (int lx = 0; lx < 8; ++lx) {
                int i = (tx << 3) | lx;
                if (i >= m_nx) continue;
                for (int ly = 0; ly < 8; ++ly) {
                    int j = (ty << 3) | ly;
                    if (j >= m_ny) continue;
                    size_t slot = (t_slot << 6) | (lx << 3) | ly;
                    update_single_node(i, j, m_grid[slot]);
                }
            }
        }
    } else {
        #pragma omp parallel for collapse(2) schedule(static)
        for (int i = 0; i < m_nx; ++i) {
            for (int j = 0; j < m_ny; ++j) {
                int idx = i * m_ny + j;
                update_single_node(i, j, m_grid[idx]);
            }
        }
    }
}

template <bool FUSE_STRESS>
void MPMSolver2D::gridToParticleInternal(float dt) {
    float max_B = 25000.0f / std::min(m_dx, m_dy);
    const size_t num_particles = m_particles.size();
    const MPMGridView2D gv = getGridView();

    #pragma omp parallel for schedule(dynamic, 64)
    for (size_t p_idx = 0; p_idx < num_particles; ++p_idx) {
        auto& p = m_particles[p_idx];
        if (p.m <= 0.0f) continue;
        int base_i = static_cast<int>(std::floor((p.x[0]) / m_dx));
        int base_j = static_cast<int>(std::floor((p.x[1]) / m_dy));

        float v_pic_x = 0.0f;
        float v_pic_y = 0.0f;
        float delta_v_grid_x = 0.0f;
        float delta_v_grid_y = 0.0f;
        float weight_sum = 0.0f;

        float B_new[2][2] = {{0.0f, 0.0f}, {0.0f, 0.0f}};
        float L_new[2][2] = {{0.0f, 0.0f}, {0.0f, 0.0f}};

        const MaterialTable3D* mat_ptr = getMaterialTable(p.object_id);
        int eff_scheme = (p.transfer_scheme >= 0) ? p.transfer_scheme
                       : ((mat_ptr && mat_ptr->transfer_scheme >= 0) ? mat_ptr->transfer_scheme : static_cast<int>(m_transfer_scheme));
        if (eff_scheme == static_cast<int>(MPMTransferScheme::RadialMLS)) {
            const float inv_dx = 1.0f / m_dx;
            const float inv_dy = 1.0f / m_dy;

            float geom_w_sum = 0.0f;
            float geom_wx = 0.0f, geom_wy = 0.0f;
            float sum_wdx = 0.0f, sum_wdy = 0.0f;
            float sum_wxx = 0.0f, sum_wxy = 0.0f, sum_wyy = 0.0f;
            float sum_wdvx = 0.0f, sum_wdvy = 0.0f;
            float A_raw[2][2] = {{0.0f, 0.0f}, {0.0f, 0.0f}};
            bool has_v_ref = false;
            float v_ref_x = 0.0f, v_ref_y = 0.0f;

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
                    float rxn = dist_x * inv_dx;
                    float ryn = dist_y * inv_dy;
                    float r_norm = std::sqrt(rxn * rxn + ryn * ryn);
                    if (r_norm >= 2.0f) continue;

                    float w = evalWendland_C2(r_norm, 2.0f);
                    if (w < 1.0e-7f) continue;

                    geom_w_sum += w;
                    geom_wx += w * dist_x;
                    geom_wy += w * dist_y;

                    long long node_idx = gv.slotIndex(i, j);
                    if (node_idx < 0) continue;
                    const auto& node = m_grid[node_idx];

                    if (node.m > 1.0e-14f) {
                        if (!has_v_ref) {
                            v_ref_x = node.v[0];
                            v_ref_y = node.v[1];
                            has_v_ref = true;
                        }
                        v_pic_x += w * node.v[0];
                        v_pic_y += w * node.v[1];
                        delta_v_grid_x += w * (node.v[0] - node.v_old[0]);
                        delta_v_grid_y += w * (node.v[1] - node.v_old[1]);
                        weight_sum += w;

                        float dv_x = node.v[0] - v_ref_x;
                        float dv_y = node.v[1] - v_ref_y;
                        sum_wdx += w * dist_x;
                        sum_wdy += w * dist_y;
                        sum_wxx += w * dist_x * dist_x;
                        sum_wxy += w * dist_x * dist_y;
                        sum_wyy += w * dist_y * dist_y;
                        sum_wdvx += w * dv_x;
                        sum_wdvy += w * dv_y;

                        A_raw[0][0] += dv_x * w * dist_x;
                        A_raw[0][1] += dv_x * w * dist_y;
                        A_raw[1][0] += dv_y * w * dist_x;
                        A_raw[1][1] += dv_y * w * dist_y;
                    }
                }
            }

            if (weight_sum > 1.0e-7f) {
                float inv_w = 1.0f / weight_sum;
                float delta_act_x = sum_wdx * inv_w;
                float delta_act_y = sum_wdy * inv_w;
                float dv_mean_x = sum_wdvx * inv_w;
                float dv_mean_y = sum_wdvy * inv_w;

                float A_c[2][2];
                A_c[0][0] = A_raw[0][0] * inv_w - dv_mean_x * delta_act_x;
                A_c[0][1] = A_raw[0][1] * inv_w - dv_mean_x * delta_act_y;
                A_c[1][0] = A_raw[1][0] * inv_w - dv_mean_y * delta_act_x;
                A_c[1][1] = A_raw[1][1] * inv_w - dv_mean_y * delta_act_y;

                float D00 = sum_wxx * inv_w - delta_act_x * delta_act_x;
                float D01 = sum_wxy * inv_w - delta_act_x * delta_act_y;
                float D11 = sum_wyy * inv_w - delta_act_y * delta_act_y;

                float Dn00 = D00 * inv_dx * inv_dx;
                float Dn01 = D01 * inv_dx * inv_dy;
                float Dn11 = D11 * inv_dy * inv_dy;
                float det_norm = Dn00 * Dn11 - Dn01 * Dn01;
                float Dn_min = std::min(Dn00, Dn11);
                float Dn_max = std::max(Dn00, Dn11);

                if (det_norm > 1.0e-3f * 0.0625f && Dn_min > 0.05f * 0.25f && Dn_min > 0.12f * Dn_max) {
                    float inv_det = 1.0f / det_norm;
                    float D_inv[2][2];
                    D_inv[0][0] =  Dn11 * inv_det * inv_dx * inv_dx;
                    D_inv[0][1] = -Dn01 * inv_det * inv_dx * inv_dy;
                    D_inv[1][0] =  D_inv[0][1];
                    D_inv[1][1] =  Dn00 * inv_det * inv_dy * inv_dy;
                    B_new[0][0] = A_c[0][0] * D_inv[0][0] + A_c[0][1] * D_inv[1][0];
                    B_new[0][1] = A_c[0][0] * D_inv[0][1] + A_c[0][1] * D_inv[1][1];
                    B_new[1][0] = A_c[1][0] * D_inv[0][0] + A_c[1][1] * D_inv[1][0];
                    B_new[1][1] = A_c[1][0] * D_inv[0][1] + A_c[1][1] * D_inv[1][1];
                    L_new[0][0] = B_new[0][0]; L_new[0][1] = B_new[0][1];
                    L_new[1][0] = B_new[1][0]; L_new[1][1] = B_new[1][1];
                } else {
                    float tr_Dn = Dn00 + Dn11;
                    if (tr_Dn > 0.0125f) {
                        // Rank-1 collinear fallback: exact orthogonal Moore-Penrose pseudoinverse Dn+ = Dn / tr(Dn)^2
                        float inv_tr2 = 1.0f / (tr_Dn * tr_Dn);
                        float D_pinv[2][2];
                        D_pinv[0][0] = Dn00 * inv_tr2 * inv_dx * inv_dx;
                        D_pinv[0][1] = Dn01 * inv_tr2 * inv_dx * inv_dy;
                        D_pinv[1][0] = D_pinv[0][1];
                        D_pinv[1][1] = Dn11 * inv_tr2 * inv_dy * inv_dy;
                        B_new[0][0] = A_c[0][0] * D_pinv[0][0] + A_c[0][1] * D_pinv[1][0];
                        B_new[0][1] = A_c[0][0] * D_pinv[0][1] + A_c[0][1] * D_pinv[1][1];
                        B_new[1][0] = A_c[1][0] * D_pinv[0][0] + A_c[1][1] * D_pinv[1][0];
                        B_new[1][1] = A_c[1][0] * D_pinv[0][1] + A_c[1][1] * D_pinv[1][1];
                        L_new[0][0] = B_new[0][0]; L_new[0][1] = B_new[0][1];
                        L_new[1][0] = B_new[1][0]; L_new[1][1] = B_new[1][1];
                    }
                }

                // Linearly complete particle velocity reconstruction accounting for geometric P2G center offset
                float inv_geom_w = (geom_w_sum > 1.0e-7f) ? (1.0f / geom_w_sum) : 0.0f;
                float shift_x = delta_act_x - geom_wx * inv_geom_w;
                float shift_y = delta_act_y - geom_wy * inv_geom_w;
                v_pic_x -= weight_sum * (B_new[0][0] * shift_x + B_new[0][1] * shift_y);
                v_pic_y -= weight_sum * (B_new[1][0] * shift_x + B_new[1][1] * shift_y);
            }
        } else {
            const bool is_standard = (eff_scheme == static_cast<int>(MPMTransferScheme::Standard));
            const int min_offset = (eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) ? -2 : -1;
            const int max_offset = 2;

            float Sx_arr[5] = {}, dSx_arr[5] = {}, Sy_arr[5] = {}, dSy_arr[5] = {};
            if (eff_scheme == static_cast<int>(MPMTransferScheme::GIMP)) {
                for (int offset = min_offset; offset <= max_offset; ++offset) {
                    int idx = offset - min_offset;
                    float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * m_dx;
                    Sx_arr[idx] = evalGIMP_S(p.x[0], nx_val, m_dx, p.lp[0]);
                    dSx_arr[idx] = evalGIMP_dS(p.x[0], nx_val, m_dx, p.lp[0]);

                    float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * m_dy;
                    Sy_arr[idx] = evalGIMP_S(p.x[1], ny_val, m_dy, p.lp[1]);
                    dSy_arr[idx] = evalGIMP_dS(p.x[1], ny_val, m_dy, p.lp[1]);
                }
            } else if (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline)) {
                for (int offset = min_offset; offset <= max_offset; ++offset) {
                    int idx = offset - min_offset;
                    float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * m_dx;
                    Sx_arr[idx] = evalBSpline_S(p.x[0], nx_val, m_dx);
                    dSx_arr[idx] = evalBSpline_dS(p.x[0], nx_val, m_dx);

                    float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * m_dy;
                    Sy_arr[idx] = evalBSpline_S(p.x[1], ny_val, m_dy);
                    dSy_arr[idx] = evalBSpline_dS(p.x[1], ny_val, m_dy);
                }
            } else if (eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) {
                for (int offset = min_offset; offset <= max_offset; ++offset) {
                    int idx = offset - min_offset;
                    float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * m_dx;
                    Sx_arr[idx] = evalCubicBSpline_S(p.x[0], nx_val, m_dx);
                    dSx_arr[idx] = evalCubicBSpline_dS(p.x[0], nx_val, m_dx);

                    float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * m_dy;
                    Sy_arr[idx] = evalCubicBSpline_S(p.x[1], ny_val, m_dy);
                    dSy_arr[idx] = evalCubicBSpline_dS(p.x[1], ny_val, m_dy);
                }
            } else {
                for (int offset = min_offset; offset <= max_offset; ++offset) {
                    int idx = offset - min_offset;
                    float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * m_dx;
                    Sx_arr[idx] = evalLinear_S(p.x[0], nx_val, m_dx);
                    dSx_arr[idx] = evalLinear_dS(p.x[0], nx_val, m_dx);

                    float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * m_dy;
                    Sy_arr[idx] = evalLinear_S(p.x[1], ny_val, m_dy);
                    dSy_arr[idx] = evalLinear_dS(p.x[1], ny_val, m_dy);
                }
            }

            float sum_wdx = 0.0f, sum_wdy = 0.0f;
            float sum_wxx = 0.0f, sum_wxy = 0.0f, sum_wyy = 0.0f;
            float sum_wdvx = 0.0f, sum_wdvy = 0.0f;
            float A_raw[2][2] = {{0.0f, 0.0f}, {0.0f, 0.0f}};
            float L_raw[2][2] = {{0.0f, 0.0f}, {0.0f, 0.0f}};
            bool has_v_ref = false;
            float v_ref_x = 0.0f, v_ref_y = 0.0f;

            for (int offset_i = min_offset; offset_i <= max_offset; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= m_nx) continue;
                int i_idx = offset_i - min_offset;
                float Sx = Sx_arr[i_idx];
                if (std::abs(Sx) < 1.0e-7f) continue;
                float dSx = dSx_arr[i_idx];
                float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                for (int offset_j = min_offset; offset_j <= max_offset; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= m_ny) continue;
                    int j_idx = offset_j - min_offset;
                    float Sy = Sy_arr[j_idx];
                    if (std::abs(Sy) < 1.0e-7f) continue;
                    float dSy = dSy_arr[j_idx];
                    float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                    float weight = Sx * Sy;
                    float dN_dx = dSx * Sy;
                    float dN_dy = Sx * dSy;

                    long long node_idx = gv.slotIndex(i, j);
                    if (node_idx < 0) continue;
                    const auto& node = m_grid[node_idx];

                    if (node.m > 1.0e-14f) {
                        float eff_vx = node.v[0];
                        float eff_vy = node.v[1];
                        float eff_dvx = node.v[0] - node.v_old[0];
                        float eff_dvy = node.v[1] - node.v_old[1];

                        if (is_standard) {
                            float p_m_ref = std::max(p.m, 1.0e-12f);
                            float reg_dv = std::min(1.0f, node.m / p_m_ref);
                            float v_old_x = eff_vx - eff_dvx;
                            float v_old_y = eff_vy - eff_dvy;
                            eff_dvx *= reg_dv;
                            eff_dvy *= reg_dv;
                            eff_vx = v_old_x + eff_dvx;
                            eff_vy = v_old_y + eff_dvy;
                        }

                        if (!has_v_ref) {
                            v_ref_x = eff_vx;
                            v_ref_y = eff_vy;
                            has_v_ref = true;
                        }

                        v_pic_x += weight * eff_vx;
                        v_pic_y += weight * eff_vy;
                        delta_v_grid_x += weight * eff_dvx;
                        delta_v_grid_y += weight * eff_dvy;
                        weight_sum += weight;

                        float dist_x = node_x - p.x[0];
                        float dist_y = node_y - p.x[1];
                        float dv_x = eff_vx - v_ref_x;
                        float dv_y = eff_vy - v_ref_y;

                        sum_wdx += weight * dist_x;
                        sum_wdy += weight * dist_y;
                        sum_wxx += weight * dist_x * dist_x;
                        sum_wxy += weight * dist_x * dist_y;
                        sum_wyy += weight * dist_y * dist_y;
                        sum_wdvx += weight * dv_x;
                        sum_wdvy += weight * dv_y;

                        A_raw[0][0] += dv_x * weight * dist_x;
                        A_raw[0][1] += dv_x * weight * dist_y;
                        A_raw[1][0] += dv_y * weight * dist_x;
                        A_raw[1][1] += dv_y * weight * dist_y;

                        L_raw[0][0] += dv_x * dN_dx;
                        L_raw[0][1] += dv_x * dN_dy;
                        L_raw[1][0] += dv_y * dN_dx;
                        L_raw[1][1] += dv_y * dN_dy;
                    }
                }
            }

            if (weight_sum > 1.0e-7f) {
                const float inv_dx = 1.0f / m_dx;
                const float inv_dy = 1.0f / m_dy;
                float inv_w = 1.0f / weight_sum;
                float dx_c = sum_wdx * inv_w;
                float dy_c = sum_wdy * inv_w;
                float dv_mean_x = sum_wdvx * inv_w;
                float dv_mean_y = sum_wdvy * inv_w;

                float A_c[2][2];
                A_c[0][0] = A_raw[0][0] * inv_w - dv_mean_x * dx_c;
                A_c[0][1] = A_raw[0][1] * inv_w - dv_mean_x * dy_c;
                A_c[1][0] = A_raw[1][0] * inv_w - dv_mean_y * dx_c;
                A_c[1][1] = A_raw[1][1] * inv_w - dv_mean_y * dy_c;

                float D00 = sum_wxx * inv_w - dx_c * dx_c;
                float D01 = sum_wxy * inv_w - dx_c * dy_c;
                float D11 = sum_wyy * inv_w - dy_c * dy_c;

                float Dn00 = D00 * inv_dx * inv_dx;
                float Dn01 = D01 * inv_dx * inv_dy;
                float Dn11 = D11 * inv_dy * inv_dy;
                float det_norm = Dn00 * Dn11 - Dn01 * Dn01;
                float Dn_min = std::min(Dn00, Dn11);
                float Dn_max = std::max(Dn00, Dn11);

                bool is_well_conditioned = (weight_sum > 0.25f) &&
                                           (det_norm > 1.0e-3f * 0.0625f) &&
                                           (Dn_min > 0.05f * 0.25f) &&
                                           (Dn_min > 0.12f * Dn_max);

                if (is_well_conditioned) {
                    float inv_det = 1.0f / det_norm;
                    float D_inv[2][2];
                    D_inv[0][0] =  Dn11 * inv_det * inv_dx * inv_dx;
                    D_inv[0][1] = -Dn01 * inv_det * inv_dx * inv_dy;
                    D_inv[1][0] =  D_inv[0][1];
                    D_inv[1][1] =  Dn00 * inv_det * inv_dy * inv_dy;
                    B_new[0][0] = A_c[0][0] * D_inv[0][0] + A_c[0][1] * D_inv[1][0];
                    B_new[0][1] = A_c[0][0] * D_inv[0][1] + A_c[0][1] * D_inv[1][1];
                    B_new[1][0] = A_c[1][0] * D_inv[0][0] + A_c[1][1] * D_inv[1][0];
                    B_new[1][1] = A_c[1][0] * D_inv[0][1] + A_c[1][1] * D_inv[1][1];
                    if (is_standard && weight_sum > 0.99f) {
                        L_new[0][0] = L_raw[0][0]; L_new[0][1] = L_raw[0][1];
                        L_new[1][0] = L_raw[1][0]; L_new[1][1] = L_raw[1][1];
                    } else {
                        L_new[0][0] = B_new[0][0]; L_new[0][1] = B_new[0][1];
                        L_new[1][0] = B_new[1][0]; L_new[1][1] = B_new[1][1];
                    }
                } else if (is_standard && weight_sum > 0.99f) {
                    B_new[0][0] = L_raw[0][0]; B_new[0][1] = L_raw[0][1];
                    B_new[1][0] = L_raw[1][0]; B_new[1][1] = L_raw[1][1];
                    L_new[0][0] = L_raw[0][0]; L_new[0][1] = L_raw[0][1];
                    L_new[1][0] = L_raw[1][0]; L_new[1][1] = L_raw[1][1];
                } else {
                    float tr_Dn = Dn00 + Dn11;
                    if (tr_Dn > 0.0125f && weight_sum > 0.25f) {
                        float inv_tr2 = 1.0f / (tr_Dn * tr_Dn);
                        float D_pinv[2][2];
                        D_pinv[0][0] = Dn00 * inv_tr2 * inv_dx * inv_dx;
                        D_pinv[0][1] = Dn01 * inv_tr2 * inv_dx * inv_dy;
                        D_pinv[1][0] = D_pinv[0][1];
                        D_pinv[1][1] = Dn11 * inv_tr2 * inv_dy * inv_dy;
                        B_new[0][0] = A_c[0][0] * D_pinv[0][0] + A_c[0][1] * D_pinv[1][0];
                        B_new[0][1] = A_c[0][0] * D_pinv[0][1] + A_c[0][1] * D_pinv[1][1];
                        B_new[1][0] = A_c[1][0] * D_pinv[0][0] + A_c[1][1] * D_pinv[1][0];
                        B_new[1][1] = A_c[1][0] * D_pinv[0][1] + A_c[1][1] * D_pinv[1][1];
                        L_new[0][0] = B_new[0][0]; L_new[0][1] = B_new[0][1];
                        L_new[1][0] = B_new[1][0]; L_new[1][1] = B_new[1][1];
                    } else if (is_standard) {
                        B_new[0][0] = 0.9f * p.B[0][0]; B_new[0][1] = 0.9f * p.B[0][1];
                        B_new[1][0] = 0.9f * p.B[1][0]; B_new[1][1] = 0.9f * p.B[1][1];
                    }
                }
            }
        }

        float v_flip_x = p.v[0];
        float v_flip_y = p.v[1];
        if (weight_sum <= 1.0e-7f) {
            v_pic_x = p.v[0];
            v_pic_y = p.v[1];
        } else {
            float inv_w = 1.0f / weight_sum;
            v_pic_x *= inv_w;
            v_pic_y *= inv_w;
            v_flip_x = p.v[0] + delta_v_grid_x * inv_w;
            v_flip_y = p.v[1] + delta_v_grid_y * inv_w;
        }

        float target_vx = v_pic_x;
        float target_vy = v_pic_y;

        bool is_melted = (p.T_melt > p.T_room && p.temperature >= p.T_melt);
        if (p.has_failed || p.damage >= 1.0f || is_melted) {
            target_vx = v_flip_x;
            target_vy = v_flip_y;
        } else if (m_velocity_scheme == MPMVelocityScheme::FLIP) {
            float alpha = std::clamp(m_flip_blend, 0.0f, 1.0f);
            target_vx = alpha * v_flip_x + (1.0f - alpha) * v_pic_x;
            target_vy = alpha * v_flip_y + (1.0f - alpha) * v_pic_y;
        }

        p.v[0] = std::clamp(target_vx, -25000.0f, 25000.0f);
        p.v[1] = std::clamp(target_vy, -25000.0f, 25000.0f);

        p.B[0][0] = (!p.has_failed && !is_melted && m_velocity_scheme == MPMVelocityScheme::APIC) ? std::clamp(B_new[0][0], -max_B, max_B) : 0.0f;
        p.B[0][1] = (!p.has_failed && !is_melted && m_velocity_scheme == MPMVelocityScheme::APIC) ? std::clamp(B_new[0][1], -max_B, max_B) : 0.0f;
        p.B[1][0] = (!p.has_failed && !is_melted && m_velocity_scheme == MPMVelocityScheme::APIC) ? std::clamp(B_new[1][0], -max_B, max_B) : 0.0f;
        p.B[1][1] = (!p.has_failed && !is_melted && m_velocity_scheme == MPMVelocityScheme::APIC) ? std::clamp(B_new[1][1], -max_B, max_B) : 0.0f;

        p.L_grad[0][0] = std::clamp(L_new[0][0], -max_B, max_B);
        p.L_grad[0][1] = std::clamp(L_new[0][1], -max_B, max_B);
        p.L_grad[1][0] = std::clamp(L_new[1][0], -max_B, max_B);
        p.L_grad[1][1] = std::clamp(L_new[1][1], -max_B, max_B);

        // Update Particle Position
        p.x[0] += dt * p.v[0];
        p.x[1] += dt * p.v[1];

        // Domain Boundary Conditions at Physical Domain Limits
        float phys_min_x = 0.0f;
        float phys_max_x = static_cast<float>(m_nx) * m_dx;
        float phys_min_y = 0.0f;
        float phys_max_y = static_cast<float>(m_ny) * m_dy;
        float min_margin_x = 1.5f * m_dx;
        float max_margin_x = (static_cast<float>(m_nx) - 1.5f) * m_dx;
        float min_margin_y = 1.5f * m_dy;
        float max_margin_y = (static_cast<float>(m_ny) - 1.5f) * m_dy;

        bool passed_out = false;
        if (m_bc_x_min == MPMBoundaryCondition2D::Terminate) {
            if (p.x[0] < phys_min_x) { m_terminated = true; passed_out = true; }
        } else if (m_bc_x_min == MPMBoundaryCondition2D::Transmitting ||
                   m_bc_x_min == MPMBoundaryCondition2D::LysmerDashpot) {
            if (p.x[0] < phys_min_x) { passed_out = true; }
        } else if (m_bc_x_min == MPMBoundaryCondition2D::Reflecting) {
            if (p.x[0] < phys_min_x) {
                p.x[0] = 2.0f * phys_min_x - p.x[0];
                if (p.x[0] < phys_min_x) p.x[0] = phys_min_x;
                p.v[0] = std::abs(p.v[0]);
            }
        } else if (p.x[0] < min_margin_x) {
            p.x[0] = min_margin_x;
            if (p.v[0] < 0.0f) p.v[0] = 0.0f;
            p.B[0][0] = 0.0f; p.B[0][1] = 0.0f;
        }

        if (m_bc_x_max == MPMBoundaryCondition2D::Terminate) {
            if (p.x[0] > phys_max_x) { m_terminated = true; passed_out = true; }
        } else if (m_bc_x_max == MPMBoundaryCondition2D::Transmitting ||
                   m_bc_x_max == MPMBoundaryCondition2D::LysmerDashpot) {
            if (p.x[0] > phys_max_x) { passed_out = true; }
        } else if (m_bc_x_max == MPMBoundaryCondition2D::Reflecting) {
            if (p.x[0] > phys_max_x) {
                p.x[0] = 2.0f * phys_max_x - p.x[0];
                if (p.x[0] > phys_max_x) p.x[0] = phys_max_x;
                p.v[0] = -std::abs(p.v[0]);
            }
        } else if (p.x[0] > max_margin_x) {
            p.x[0] = max_margin_x;
            if (p.v[0] > 0.0f) p.v[0] = 0.0f;
            p.B[0][0] = 0.0f; p.B[0][1] = 0.0f;
        }

        if (m_bc_y_min == MPMBoundaryCondition2D::Terminate) {
            if (p.x[1] < phys_min_y) { m_terminated = true; passed_out = true; }
        } else if (m_bc_y_min == MPMBoundaryCondition2D::Transmitting ||
                   m_bc_y_min == MPMBoundaryCondition2D::LysmerDashpot) {
            if (p.x[1] < phys_min_y) { passed_out = true; }
        } else if (m_bc_y_min == MPMBoundaryCondition2D::Reflecting) {
            if (p.x[1] < phys_min_y) {
                p.x[1] = 2.0f * phys_min_y - p.x[1];
                if (p.x[1] < phys_min_y) p.x[1] = phys_min_y;
                p.v[1] = std::abs(p.v[1]);
            }
        } else if (p.x[1] < min_margin_y) {
            p.x[1] = min_margin_y;
            if (p.v[1] < 0.0f) p.v[1] = 0.0f;
            p.B[1][0] = 0.0f; p.B[1][1] = 0.0f;
        }

        if (m_bc_y_max == MPMBoundaryCondition2D::Terminate) {
            if (p.x[1] > phys_max_y) { m_terminated = true; passed_out = true; }
        } else if (m_bc_y_max == MPMBoundaryCondition2D::Transmitting ||
                   m_bc_y_max == MPMBoundaryCondition2D::LysmerDashpot) {
            if (p.x[1] > phys_max_y) { passed_out = true; }
        } else if (m_bc_y_max == MPMBoundaryCondition2D::Reflecting) {
            if (p.x[1] > phys_max_y) {
                p.x[1] = 2.0f * phys_max_y - p.x[1];
                if (p.x[1] > phys_max_y) p.x[1] = phys_max_y;
                p.v[1] = -std::abs(p.v[1]);
            }
        } else if (p.x[1] > max_margin_y) {
            p.x[1] = max_margin_y;
            if (p.v[1] > 0.0f) p.v[1] = 0.0f;
            p.B[1][0] = 0.0f; p.B[1][1] = 0.0f;
        }

        // Domain Boundary Escape Check
        if (passed_out ||
            p.x[0] < 0.0f || p.x[0] >= static_cast<float>(m_nx) * m_dx ||
            p.x[1] < 0.0f || p.x[1] >= static_cast<float>(m_ny) * m_dy) {
            p.m = 0.0f;
            p.v[0] = 0.0f; p.v[1] = 0.0f;
            p.B[0][0] = 0.0f; p.B[0][1] = 0.0f; p.B[1][0] = 0.0f; p.B[1][1] = 0.0f;
            p.L_grad[0][0] = 0.0f; p.L_grad[0][1] = 0.0f; p.L_grad[1][0] = 0.0f; p.L_grad[1][1] = 0.0f;
            continue;
        }

        if constexpr (FUSE_STRESS) {
            updateParticleStress(p, dt, p.L_grad);
        }

        // Density-Based Particle Erosion (2D)
        MaterialTable3D mat_erode_scratch;
        const MaterialTable3D& mat_erode = resolveMaterialTable2D(*this, p, mat_erode_scratch);
        if (mat_erode.enable_density_erosion && p.state != 2 && p.m > 0.0f) {
            const bool is_energetic_p = isEnergeticModel(mat_erode.material_model);
            const bool is_fluid_or_energetic = isFluidModel(mat_erode.material_model) || is_energetic_p;
            const bool defer_to_fv = m_defer_fv_erosion_to_coupler && mat_erode.erode_to_fv_grid && is_fluid_or_energetic;
            if (!defer_to_fv) {
                const float rho_p = p.m / std::max(p.V, 1.0e-30f);
                const float rho0 = (mat_erode.material_model == MPMMaterialModel::TaitWater && mat_erode.tait_rho0 > 0.0f)
                    ? mat_erode.tait_rho0 : mat_erode.density;
                const float rho_thresh = std::max(mat_erode.erosion_min_density, mat_erode.erosion_min_density_ratio * rho0);
                const bool burn_ready = !is_energetic_p || (p.lambda >= 0.5f || p.V > 1.05f * p.V0);
                if (rho_thresh > 0.0f && burn_ready && rho_p < rho_thresh) {
                    p.state = 2;
                    p.m = 0.0f;
                    p.v[0] = 0.0f; p.v[1] = 0.0f;
                    p.B[0][0] = 0.0f; p.B[0][1] = 0.0f; p.B[1][0] = 0.0f; p.B[1][1] = 0.0f;
                    p.L_grad[0][0] = 0.0f; p.L_grad[0][1] = 0.0f; p.L_grad[1][0] = 0.0f; p.L_grad[1][1] = 0.0f;
                    p.sigma.setIsotropic(0.0f);
                    p.sigma_zz = 0.0f;
                }
            }
        }
    }

    // In-place zero-allocation compaction of terminated particles
    auto it = std::remove_if(m_particles.begin(), m_particles.end(), [](const MPMParticle2D& pt) {
        return pt.state == 2 || pt.m <= 0.0f;
    });
    if (it != m_particles.end()) {
        m_particles.erase(it, m_particles.end());
    }
}

void MPMSolver2D::gridToParticle(float dt) {
    gridToParticleInternal<false>(dt);
}

void MPMSolver2D::gridToParticleAndStress(float dt) {
    gridToParticleInternal<true>(dt);
}

void MPMSolver2D::updateParticleStress(MPMParticle2D& p, float dt, const float L[2][2]) {
    MaterialTable3D mat_scratch;
    const MaterialTable3D& mat = resolveMaterialTable2D(*this, p, mat_scratch);

    // Symmetric strain increment (plane strain: deps_zz = 0, L_zz = 0)
    const float deps_xx = L[0][0] * dt;
    const float deps_yy = L[1][1] * dt;
    const float deps_xy = 0.5f * (L[0][1] + L[1][0]) * dt;
    const float tr_deps = deps_xx + deps_yy;

    const bool is_energetic_p = isEnergeticModel(mat.material_model);
    const bool dispatch_energetic = is_energetic_p && !p.has_failed && (p.damage < 1.0f);

    if (!dispatch_energetic) {
        const bool is_fluid_or_gas = isFluidModel(mat.material_model);
        const bool is_solid_mat = (!is_fluid_or_gas && !is_energetic_p);
        const float V0_safe = (p.V0 > 1.0e-20f) ? p.V0 : 1.0e-20f;
        const float V_prev = std::max(1.0e-20f, p.V);
        const float V_min_limit = is_solid_mat ? (0.25f * V0_safe) : (1.0e-4f * V0_safe);
        const float V_max_limit = is_solid_mat ? (3.0f * V0_safe)  : (1.0e4f * V0_safe);
        if (!p.has_failed) {
            p.V = std::clamp(p.V * std::exp(std::clamp(tr_deps, -0.5f, 0.5f)), V_min_limit, V_max_limit);
        } else {
            p.V = std::max(p.V * std::exp(std::clamp(tr_deps, -0.5f, 0.5f)), 1.0e-4f * V0_safe);
        }

        float w_factor = (mat.enable_heterogeneity && p.weibull_factor > 0.001f) ? p.weibull_factor : 1.0f;
        if (mat.enable_heterogeneity && p.weibull_factor <= 0.001f && mat.weibull_modulus > 0.001f) {
            p.weibull_factor = computeWeibullFactor2D(p.x[0], p.x[1], p.V0, mat.weibull_modulus, mat.weibull_scale, mat.weibull_ref_volume);
            w_factor = p.weibull_factor;
        }

        const float W_xy = 0.5f * (L[0][1] - L[1][0]);
        const float deps3[3][3] = {
            {deps_xx, deps_xy, 0.0f},
            {deps_xy, deps_yy, 0.0f},
            {0.0f,    0.0f,    0.0f}
        };
        const float W3[3][3] = {
            { 0.0f, W_xy, 0.0f},
            {-W_xy, 0.0f, 0.0f},
            { 0.0f, 0.0f, 0.0f}
        };
        const float L3[3][3] = {
            {L[0][0], L[0][1], 0.0f},
            {L[1][0], L[1][1], 0.0f},
            {0.0f,    0.0f,    0.0f}
        };

        Blast::Materials::ConstitutiveState3D<float> st{};
        st.sigma[0][0] = p.sigma[0][0];
        st.sigma[0][1] = p.sigma[0][1];
        st.sigma[1][0] = p.sigma[1][0];
        st.sigma[1][1] = p.sigma[1][1];
        st.sigma[2][2] = p.sigma_zz;

        st.F_total[0][0] = p.F[0][0];
        st.F_total[0][1] = p.F[0][1];
        st.F_total[1][0] = p.F[1][0];
        st.F_total[1][1] = p.F[1][1];
        st.F_total[2][2] = 1.0f;

        float ax = p.hill_dir[0], ay = p.hill_dir[1];
        float an = std::sqrt(ax * ax + ay * ay);
        if (an <= 1.0e-6f) {
            ax = mat.anisotropy_dir[0];
            ay = mat.anisotropy_dir[1];
            an = std::sqrt(ax * ax + ay * ay);
        }
        if (an > 1.0e-6f) {
            st.hill_a[0] = ax / an;
            st.hill_a[1] = ay / an;
        } else {
            st.hill_a[0] = 1.0f;
            st.hill_a[1] = 0.0f;
        }
        st.hill_a[2] = 0.0f;
        st.hill_b[0] = -st.hill_a[1];
        st.hill_b[1] = st.hill_a[0];
        st.hill_b[2] = 0.0f;

        st.ep_bar = p.ep_bar;
        st.damage = p.damage;
        st.lambda = p.lambda;
        st.e_internal = p.e_int;
        st.temperature = p.temperature;
        st.has_failed = p.has_failed;
        st.J = p.V / V0_safe;

        const float h_elem = (mat.cell_dx > 0.0f)
            ? mat.cell_dx
            : ((m_dx > 0.0f && m_dy > 0.0f) ? std::sqrt(m_dx * m_dy) : std::sqrt(std::max(1.0e-18f, p.V0)));

        Blast::Materials::ConstitutiveDispatcher3D<float>::step(
            mat, st, deps3, W3, L3, dt, h_elem, w_factor, true
        );

        p.sigma.set(st.sigma[0][0], st.sigma[1][1], 0.5f * (st.sigma[0][1] + st.sigma[1][0]));
        p.sigma_zz = st.sigma[2][2];
        p.F[0][0] = st.F_total[0][0];
        p.F[0][1] = st.F_total[0][1];
        p.F[1][0] = st.F_total[1][0];
        p.F[1][1] = st.F_total[1][1];
        const float ha_norm = std::sqrt(st.hill_a[0] * st.hill_a[0] + st.hill_a[1] * st.hill_a[1]);
        if (ha_norm > 1.0e-6f) {
            p.hill_dir[0] = st.hill_a[0] / ha_norm;
            p.hill_dir[1] = st.hill_a[1] / ha_norm;
        }
        p.ep_bar = st.ep_bar;
        p.damage = st.damage;
        p.lambda = st.lambda;
        p.e_int = st.e_internal;
        p.temperature = st.temperature;
        p.has_failed = st.has_failed;

        if (p.has_failed || (usesMieGruneisenEOS(mat.material_model) && mat.T_melt > mat.T_room && p.temperature >= mat.T_melt)) {
            p.B[0][0] = 0.0f; p.B[0][1] = 0.0f;
            p.B[1][0] = 0.0f; p.B[1][1] = 0.0f;
        }
        if (isHyperelasticModel(mat.material_model)) {
            p.V = std::clamp(st.J * V0_safe, V_min_limit, V_max_limit);
        }
        const int eff_scheme = (p.transfer_scheme >= 0) ? p.transfer_scheme
                             : ((mat.transfer_scheme >= 0) ? mat.transfer_scheme : static_cast<int>(m_transfer_scheme));
        if (eff_scheme == static_cast<int>(MPMTransferScheme::GIMP) &&
            (is_fluid_or_gas || isHyperelasticModel(mat.material_model) || p.has_failed) &&
            m_dx > 0.0f && m_dy > 0.0f) {
            const float lp_scale = std::sqrt(std::max(0.25f, p.V / V_prev));
            p.lp[0] = std::clamp(p.lp[0] * lp_scale, 0.1f * m_dx, 2.0f * m_dx);
            p.lp[1] = std::clamp(p.lp[1] * lp_scale, 0.1f * m_dy, 2.0f * m_dy);
        }
        return;
    }

        // --- Three-Pillar Energetic Material Architecture ---
        // Pillar 1: Solid Reactant EOS (Mie-Grüneisen / Davis Solid)
        // Pillar 2: Reaction Kinetics (Programmed Wavefront / Lee-Tarver 3-Stage ODE / CREST Entropy)
        // Pillar 3: Detonation Products EOS (JWL Product Gas / Davis Detonation Product)
        if (p.material_model == MPMMaterialModel::CRESTReactiveBurn ||
            p.material_model == MPMMaterialModel::JWLProgrammedBurn ||
            p.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth) {

            p.V = std::max(p.V * std::exp(std::clamp(tr_deps, -0.5f, 0.5f)), 1.0e-4f * p.V0);
            const float v_rel = std::max(p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f), 0.02f);
            float lam_curr = p.lambda;
            float lam_new = lam_curr;

            const bool awe = (p.burn_model == ReactionKinetics::CRESTEntropy) && p.crest_awe_c0 > 0.0f;
            CrestDavis::CRESTSolidParams awe_q{};
            float awe_vtmd = 1.0f;
            if (awe) {
                const float rho0s = (p.davis_rho0 > 0.0f) ? p.davis_rho0 : p.density;
                awe_q = {p.density, rho0s, p.crest_awe_K0s, p.detonation_energy,
                         p.crest_awe_A1, p.crest_awe_A2, p.crest_awe_A3,
                         p.crest_awe_B1, p.crest_awe_B2, p.crest_awe_B3,
                         p.crest_awe_fc, p.crest_awe_delta,
                         p.crest_awe_Gamma1, p.crest_awe_Gamma2, p.crest_awe_gamma00, p.crest_awe_m};
                awe_vtmd = rho0s / p.density;
            }
            // Pillar 2: Reaction Kinetics Rate Law
            if (awe) {
                p.v_min = std::min(p.v_min, v_rel);
                p.s_shock = std::max(p.s_shock, static_cast<float>(CrestDavis::computeCRESTShockEntropy(p.v_min, awe_q)));
                float e_th_trial = std::max(0.0f, p.e_int - lam_curr * p.detonation_energy);
                float p_curr_comp = -0.5f * (p.sigma[0][0] + p.sigma[1][1]);
                float p_react_trial = static_cast<float>(CrestDavis::computeCRESTSolidPressure(v_rel, e_th_trial, awe_q));
                float p_eff_comp = (lam_curr <= 1.0e-5f) ? std::max(p_curr_comp, p_react_trial) : p_react_trial;
                if (p_eff_comp > 1.0e6f)
                    p.s_shock = std::max(p.s_shock, static_cast<float>(CrestDavis::computeCRESTShockEntropyFromPressure(p_eff_comp, awe_q)));
                lam_new = static_cast<float>(CrestDavis::advanceAWECRESTProgress(dt, p.s_shock, p.lambda,
                    p.crest_awe_c0, p.crest_awe_c1, p.crest_awe_c2, p.crest_awe_c3, p.crest_awe_c6,
                    p.crest_awe_c8, p.crest_awe_c9, p.crest_awe_c10, p.crest_awe_c11, p.crest_awe_c12, p.crest_awe_c13));
            } else if (p.burn_model == ReactionKinetics::CRESTEntropy) {
                p.v_min = std::min(p.v_min, v_rel);
                float s_calc = CrestDavis::computeDavisShockEntropy(p.v_min, p.davis_c0, p.davis_s1, p.davis_gamma0, p.davis_cv, p.davis_t0, p.davis_rho0);
                p.s_shock = std::max(p.s_shock, s_calc);

                float q_heat_trial = (p.product_model == DetonationProductEOS::DavisProduct) ? p.davis_q_det : p.detonation_energy;
                float e_th_trial = std::max(0.0f, p.e_int - lam_curr * q_heat_trial);
                float p_curr_comp = -0.5f * (p.sigma[0][0] + p.sigma[1][1]);
                float p_react_trial = (p.solid_model == SolidReactantEOS::DavisSolid)
                    ? CrestDavis::computeDavisReactantPressure(v_rel, e_th_trial, p.davis_c0, p.davis_s1, p.davis_gamma0, p.davis_cv, p.davis_t0, p.davis_rho0)
                    : JWL::computeSolidReactantPressure(v_rel, e_th_trial, p.mg_c0, p.mg_s, p.mg_gamma0, p.density);
                float p_eff_comp = (lam_curr <= 1.0e-5f) ? std::max(p_curr_comp, p_react_trial) : p_react_trial;
                if (p_eff_comp > 1.0e6f) {
                    float s_p = CrestDavis::computeDavisShockEntropyFromPressure(p_eff_comp, p.davis_c0, p.davis_s1, p.davis_cv, p.davis_t0, p.davis_rho0);
                    p.s_shock = std::max(p.s_shock, s_p);
                }


                lam_new = CrestDavis::advanceCRESTProgress(dt, p.s_shock, p.lambda, p.crest_b1, p.crest_c1, p.crest_m1, p.crest_b2, p.crest_c2, p.crest_c3, p.crest_m2, p.crest_s0, p.crest_s_threshold);
            } else if (p.burn_model == ReactionKinetics::LeeTarverODE) {
                float p_curr = -0.5f * (p.sigma[0][0] + p.sigma[1][1]);
                if (p_curr < 0.0f) p_curr = 0.0f;

                lam_new = LeeTarver::advanceLeeTarver(dt, lam_curr, v_rel, p_curr,
                    p.lt_I, p.lt_a, p.lt_b, p.lt_x, p.lt_ig_max,
                    p.lt_G1, p.lt_c, p.lt_d, p.lt_y, p.lt_growth_max,
                    p.lt_G2, p.lt_e, p.lt_g, p.lt_z, p.lt_comp_min);
            } else {
                // Programmed Wavefront Burn
                float t_arr = p.t_arrival;
                float h_min = std::min(m_dx, m_dy);
                float tau_burn = std::max(static_cast<float>(p.burn_zone_cells) * h_min / std::max(p.det_vel, 100.0f), p.tau_burn_min);
                float lam_prog = JWL::computeProgrammedProgress(static_cast<float>(m_sim_time), t_arr, tau_burn);
                lam_new = std::max(lam_curr, lam_prog);
            }

            p.lambda = lam_new;
            float d_lam = std::max(0.0f, lam_new - lam_curr);

            float q_heat = (!awe && p.product_model == DetonationProductEOS::DavisProduct) ? p.davis_q_det : p.detonation_energy;
            float e_th = p.e_int - lam_curr * q_heat;
            float e_prod = e_th + q_heat;

            // Pillar 1: Solid Reactant EOS
            auto solid_pressure_at = [&](float v) -> float {
                if (awe) return static_cast<float>(CrestDavis::computeCRESTSolidPressure(v, std::max(0.0f, e_th), awe_q));
                if (p.solid_model == SolidReactantEOS::JWLReactant)
                    return JWL::computeJWLReactantPressure(v, e_th, p.jwlr_A, p.jwlr_B, p.jwlr_R1, p.jwlr_R2, p.jwlr_omega, p.jwlr_Cv, p.jwlr_T0, p.density);
                if (p.solid_model == SolidReactantEOS::DavisSolid)
                    return CrestDavis::computeDavisReactantPressure(v, e_th, p.davis_c0, p.davis_s1, p.davis_gamma0, p.davis_cv, p.davis_t0, p.davis_rho0);
                return JWL::computeSolidReactantPressure(v, e_th, p.mg_c0, p.mg_s, p.mg_gamma0, p.density);
            };

            // Pillar 3: Detonation Products EOS
            auto product_pressure_at = [&](float v) -> float {
                if (awe) return JWL::computeJWLProductPressure(v * awe_vtmd, e_prod, p.jwl_A, p.jwl_B, p.jwl_R1, p.jwl_R2, p.jwl_omega, static_cast<float>(awe_q.rho0s));
                if (p.product_model == DetonationProductEOS::DavisProduct)
                    return CrestDavis::computeDavisProductPressure(v, e_prod, p.davis_a, p.davis_b, p.davis_k, p.davis_vc, p.davis_pc, p.davis_q_det, p.davis_rho0);
                return JWL::computeJWLProductPressure(v, e_prod, p.jwl_A, p.jwl_B, p.jwl_R1, p.jwl_R2, p.jwl_omega, p.density);
            };

            // Lee-Tarver kinetics use the selectable mixture rule (default: pressure equilibrium, volume
            // additive); all other reactive models keep the linear blend.
            const Mixture::Rule mix_rule = (p.burn_model == ReactionKinetics::LeeTarverODE)
                ? static_cast<Mixture::Rule>(p.mixture_rule) : Mixture::Rule::LinearBlend;
            const Mixture::Result mix = Mixture::mixturePressure(mix_rule, static_cast<double>(v_rel), static_cast<double>(lam_new),
                [&](double v) { return static_cast<double>(solid_pressure_at(static_cast<float>(v))); },
                [&](double v) { return static_cast<double>(product_pressure_at(static_cast<float>(v))); });
            float p_mix = static_cast<float>(mix.p);
            if (!std::isfinite(p_mix)) p_mix = 0.0f;   // numerical guard only; tension is physical and is not clipped
            // Phase pressures at the phase volumes chosen by the mixture rule (used by sound-speed/CFL closures)
            [[maybe_unused]] const float p_solid = solid_pressure_at(static_cast<float>(mix.v_s));
            [[maybe_unused]] const float p_prod = product_pressure_at(static_cast<float>(mix.v_p));

            // Energy conservation: compression work & chemical heat release
            float rho_eff = (p.density > 10.0f) ? p.density : ((p.solid_model == SolidReactantEOS::DavisSolid) ? p.davis_rho0 : 1630.0f);
            float de_comp = -(p_mix / rho_eff) * tr_deps * v_rel;   // PdV work in BOTH directions, current-volume weighted
            float de_chem = d_lam * q_heat;
            p.e_int += de_comp + de_chem;

            float cv_eff = (p.solid_model == SolidReactantEOS::DavisSolid) ? (p.davis_cv > 1.0f ? p.davis_cv : 1000.0f) : (p.Cp > 1.0f ? p.Cp : 1000.0f);
            float t0_eff = (p.solid_model == SolidReactantEOS::DavisSolid) ? p.davis_t0 : p.T_room;
            p.temperature = t0_eff + p.e_int / cv_eff;


            // Jaumann rotation
            float W_xy = 0.5f * (L[0][1] - L[1][0]);
            float rot_xx =  2.0f * W_xy * p.sigma[0][1] * dt;
            float rot_yy = -2.0f * W_xy * p.sigma[0][1] * dt;
            float rot_xy =  W_xy * (p.sigma[1][1] - p.sigma[0][0]) * dt;

            float sig_xx_base = p.sigma[0][0] + rot_xx;
            float sig_yy_base = p.sigma[1][1] + rot_yy;
            float sig_xy_base = p.sigma[0][1] + rot_xy;

            const float E_mod    = p.youngs_modulus;
            const float nu_val   = p.poissons_ratio;
            const float mu_shear = E_mod / (2.0f * (1.0f + nu_val));   // solid-phase shear modulus (unscaled)
            const float solid_ratio = (1.0f - lam_new) / std::max(1.0f - lam_curr, 1.0e-6f);

            float deps_xx_dev = deps_xx - 0.5f * tr_deps;
            float deps_yy_dev = deps_yy - 0.5f * tr_deps;
            float deps_xy_dev = deps_xy;

            float s_xx_trial = solid_ratio * sig_xx_base + (1.0f - lam_new) * 2.0f * mu_shear * deps_xx_dev;
            float s_yy_trial = solid_ratio * sig_yy_base + (1.0f - lam_new) * 2.0f * mu_shear * deps_yy_dev;
            float s_xy_trial = solid_ratio * sig_xy_base + (1.0f - lam_new) * 2.0f * mu_shear * deps_xy_dev;

            float press_s = -0.5f * (s_xx_trial + s_yy_trial);
            s_xx_trial += press_s;
            s_yy_trial += press_s;

            // Radial return plasticity for solid phase
            float s_mag_sq = s_xx_trial * s_xx_trial + s_yy_trial * s_yy_trial + 2.0f * s_xy_trial * s_xy_trial;
            float q_trial = std::sqrt(1.5f * s_mag_sq);
            float q_yield = (1.0f - lam_new) * (p.yield_stress > 1.0e5f ? p.yield_stress : 100.0e6f);
            if (q_trial > q_yield && q_trial > 1.0e-6f) {
                float scale = q_yield / q_trial;
                s_xx_trial *= scale;
                s_yy_trial *= scale;
                s_xy_trial *= scale;
            }

            p.sigma.set(s_xx_trial - p_mix, s_yy_trial - p_mix, s_xy_trial);
            p.sigma_zz = -p_mix;
            return;
        }
}

void MPMSolver2D::updateStressState(float dt) {
    const size_t num_particles = m_particles.size();
    #pragma omp parallel for schedule(dynamic, 64)
    for (size_t p_idx = 0; p_idx < num_particles; ++p_idx) {
        auto& p = m_particles[p_idx];
        float L[2][2] = {
            { p.L_grad[0][0], p.L_grad[0][1] },
            { p.L_grad[1][0], p.L_grad[1][1] }
        };
        updateParticleStress(p, dt, L);
    }
}


float MPMSolver2D::computeStepSize(float cfl) const {
    if (m_particles.empty()) return 1.0e-6f;
    float max_speed = 100.0f;
    float max_v = 0.0f;
    const size_t num_particles = m_particles.size();

    #pragma omp parallel for reduction(max:max_speed, max_v) schedule(static)
    for (size_t p_idx = 0; p_idx < num_particles; ++p_idx) {
        const auto& p = m_particles[p_idx];
        if (p.m <= 0.0f) continue;
        if (std::isnan(p.v[0]) || std::isnan(p.v[1]) || std::isinf(p.v[0]) || std::isinf(p.v[1])) continue;
        MaterialTable3D mat_scratch;
        const MaterialTable3D& mat = resolveMaterialTable2D(*this, p, mat_scratch);
        float c_s = 0.0f;
        if (isEnergeticModel(mat.material_model)) {
            float E = mat.youngs_modulus;
            float rho = std::max(10.0f, mat.density);
            float nu = mat.poissons_ratio;
            float C0 = mat.mg_c0 > 100.0f ? mat.mg_c0 : 2500.0f;
            float c_solid = std::sqrt(C0 * C0 + (2.0f / 3.0f) * E / (rho * (1.0f + nu)));
            float c_det = mat.det_vel > 1000.0f ? mat.det_vel : 7000.0f;
            c_s = std::max(c_solid, c_det);
        } else {
            float J_val = p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f);
            float p_hydro = -0.33333334f * (p.sigma[0][0] + p.sigma[1][1] + p.sigma_zz);
            c_s = Blast::Materials::computeInstantaneousSoundSpeed<float>(mat, J_val, p_hydro, p.e_int);
        }
        if (std::isnan(c_s) || std::isinf(c_s)) continue;
        float v_mag = std::sqrt(p.v[0] * p.v[0] + p.v[1] * p.v[1]);
        if (v_mag > 25000.0f) v_mag = 25000.0f;
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
        gridToParticleAndStress(0.5f * dt);

        particleToGrid();
        updateGridKinematics(dt);
        gridToParticleAndStress(dt * 0.5f);
    } else {
        // Default: 2nd-Order Symplectic Staggered Leapfrog / USL (Single-pass)
        if (run_p2g) {
            particleToGrid();
        }
        updateGridKinematics(dt);
        gridToParticleAndStress(dt);
    }
}

void MPMSolver2D::step(float cfl) {
    if (m_particles.empty()) return;
    float dt = computeStepSize(cfl);
    if (m_step_count == 0) {
        dt = 0.5f * dt;
    } else {
        dt = std::min(dt, 1.5f * (m_last_dt > 0.0f ? m_last_dt : dt));
    }
    m_last_cfl = cfl;
    stepWithDt(dt);
}

std::vector<float> MPMSolver2D::getGridScalarField(const std::string& quantity) const {
    std::vector<float> field(static_cast<size_t>(m_nx) * m_ny, 0.0f);
    const MPMGridView2D gv = getGridView();
    for (int i = 0; i < m_nx; ++i) {
        for (int j = 0; j < m_ny; ++j) {
            long long slot = gv.slotIndex(i, j);
            if (slot < 0 || static_cast<size_t>(slot) >= m_grid.size()) continue;
            size_t out_idx = static_cast<size_t>(i) * m_ny + j;
            const auto& node = m_grid[slot];
            if (quantity == "von_mises") {
                field[out_idx] = node.von_mises;
            } else if (quantity == "plastic_strain") {
                field[out_idx] = node.plastic_strain;
            } else if (quantity == "density") {
                field[out_idx] = node.density;
            } else if (quantity == "pressure") {
                field[out_idx] = node.pressure;
            } else if (quantity == "damage") {
                field[out_idx] = node.damage;
            } else if (quantity == "velocity") {
                float vx = node.v[0];
                float vy = node.v[1];
                field[out_idx] = std::sqrt(vx * vx + vy * vy);
            }
        }
    }
    return field;
}

} // namespace Blast
