#include "mpm_solver_3d.hpp"
#include "ImmersedBoundary.hpp"

namespace Blast {

static inline uint32_t floatToBits(float f) {
    uint32_t u;
    std::memcpy(&u, &f, sizeof(float));
    return u;
}

static inline float computeWeibullFactor(float x, float y, float z, float weibull_modulus, float weibull_scale) {
    if (weibull_modulus <= 0.001f) return 1.0f;
    uint32_t ix = floatToBits(x);
    uint32_t iy = floatToBits(y);
    uint32_t iz = floatToBits(z);
    uint32_t seed = (ix * 73856093u) ^ (iy * 19349663u) ^ (iz * 83492791u);
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

MPMSolver3D::MPMSolver3D() {
}

void MPMSolver3D::initializeGrid(int nx, int ny, int nz, float dx, float dy, float dz, float xmin, float ymin, float zmin) {
    m_nx = nx;
    m_ny = ny;
    m_nz = nz;
    m_dx = dx;
    m_dy = dy;
    m_dz = dz;
    m_xmin = xmin;
    m_ymin = ymin;
    m_zmin = zmin;

    m_grid.resize(static_cast<size_t>(m_nx) * m_ny * m_nz);
    m_particles.clear();
}

void MPMSolver3D::setBoundaryConditions(MPMBoundaryCondition3D x_min, MPMBoundaryCondition3D x_max,
                                        MPMBoundaryCondition3D y_min, MPMBoundaryCondition3D y_max,
                                        MPMBoundaryCondition3D z_min, MPMBoundaryCondition3D z_max) {
    m_bc_x_min = x_min; m_bc_x_max = x_max;
    m_bc_y_min = y_min; m_bc_y_max = y_max;
    m_bc_z_min = z_min; m_bc_z_max = z_max;
}

float MPMSolver3D::evalGIMP_S(float x_p, float x_i, float h, float l_p) const {
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

float MPMSolver3D::evalGIMP_dS(float x_p, float x_i, float h, float l_p) const {
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

float MPMSolver3D::evalBSpline_S(float x_p, float x_i, float h) const {
    float q = std::abs(x_p - x_i) / h;
    if (q < 0.5f) {
        return 0.75f - q * q;
    } else if (q < 1.5f) {
        return 0.5f * (1.5f - q) * (1.5f - q);
    }
    return 0.0f;
}

float MPMSolver3D::evalBSpline_dS(float x_p, float x_i, float h) const {
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

float MPMSolver3D::evalCubicBSpline_S(float x_p, float x_i, float h) const {
    float q = std::abs(x_p - x_i) / h;
    if (q < 1.0f) {
        return (2.0f / 3.0f) - q * q + 0.5f * q * q * q;
    } else if (q < 2.0f) {
        float term = 2.0f - q;
        return (1.0f / 6.0f) * term * term * term;
    }
    return 0.0f;
}

float MPMSolver3D::evalCubicBSpline_dS(float x_p, float x_i, float h) const {
    float diff = x_p - x_i;
    float q = std::abs(diff) / h;
    float sign = (diff > 0.0f) ? 1.0f : ((diff < 0.0f) ? -1.0f : 0.0f);
    if (q < 1.0f) {
        return (-2.0f * q + 1.5f * q * q) * sign / h;
    } else if (q < 2.0f) {
        float term = 2.0f - q;
        return -3.0f * term * term * sign / (6.0f * h);
    }
    return 0.0f;
}

float MPMSolver3D::evalWendland_C2(float r, float R_supp) const {
    if (r >= R_supp) return 0.0f;
    float q = r / R_supp;
    float term = 1.0f - q;
    return (term * term * term * term) * (1.0f + 4.0f * q);
}

void MPMSolver3D::addBoxObject(int obj_id, float pos_x, float pos_y, float pos_z,
                               float size_x, float size_y, float size_z,
                               float vel_x, float vel_y, float vel_z,
                               float angular_vel_x, float angular_vel_y, float angular_vel_z,
                               float density, float E, float nu,
                               float yield_stress, float hardening, float failure_strain,
                               float tensile_failure_stress, int ppc,
                               MPMParticleDistribution particle_dist,
                               MPMBoundaryFilling boundary_fill) {
    (void)boundary_fill;
    int particles_per_dim = static_cast<int>(std::round(std::cbrt(static_cast<float>(ppc))));
    if (particles_per_dim < 1) particles_per_dim = 2;

    float p_spacing = m_dx / static_cast<float>(particles_per_dim);
    float p_dx = p_spacing;
    float p_dy = (particle_dist == MPMParticleDistribution::Hexagonal) ? (std::sqrt(3.0f) * 0.5f * p_spacing) : (m_dy / static_cast<float>(particles_per_dim));
    float p_dz = (particle_dist == MPMParticleDistribution::Hexagonal) ? (std::sqrt(2.0f / 3.0f) * p_spacing) : (m_dz / static_cast<float>(particles_per_dim));

    float min_x = pos_x - 0.5f * size_x;
    float max_x = pos_x + 0.5f * size_x;
    float min_y = pos_y - 0.5f * size_y;
    float max_y = pos_y + 0.5f * size_y;
    float min_z = pos_z - 0.5f * size_z;
    float max_z = pos_z + 0.5f * size_z;

    float p_vol = (particle_dist == MPMParticleDistribution::Hexagonal) ? ((p_spacing * p_spacing * p_spacing) / std::sqrt(2.0f)) : (p_dx * p_dy * p_dz);
    float p_mass = p_vol * density;

    if (obj_id >= static_cast<int>(m_material_tables.size())) {
        m_material_tables.resize(obj_id + 1);
    }
    auto& mat = m_material_tables[obj_id];
    mat.density = density;
    mat.youngs_modulus = E;
    mat.poissons_ratio = nu;
    mat.yield_stress = yield_stress;
    mat.hardening_modulus = hardening;
    mat.failure_strain = failure_strain;
    mat.tensile_failure_stress = tensile_failure_stress;
    if (failure_strain > 0.0f) {
        mat.enable_strain_erosion = true;
        mat.erosion_strain = failure_strain;
        if (mat.weibull_modulus <= 0.001f) mat.weibull_modulus = 8.0f;
    }

    int layer_k = 0;
    for (float z = min_z + 0.5f * p_dz; z < max_z; z += p_dz, ++layer_k) {
        bool is_layer_b = (particle_dist == MPMParticleDistribution::Hexagonal && (layer_k % 2 == 1));
        float y_layer_offset = is_layer_b ? (p_spacing / (2.0f * std::sqrt(3.0f))) : 0.0f;
        int row_j = 0;
        for (float y = min_y + 0.5f * p_dy + y_layer_offset; y < max_y; y += p_dy, ++row_j) {
            float x_offset = 0.0f;
            if (particle_dist == MPMParticleDistribution::Hexagonal) {
                x_offset = ((row_j + (is_layer_b ? 1 : 0)) % 2 == 1) ? (0.5f * p_spacing) : 0.0f;
            }
            for (float x = min_x + 0.5f * p_dx + x_offset; x < max_x; x += p_dx) {
                MPMParticle3D p{};
                p.x[0] = x; p.x[1] = y; p.x[2] = z;

                float rx = x - pos_x;
                float ry = y - pos_y;
                float rz = z - pos_z;

                p.v[0] = vel_x + (angular_vel_y * rz - angular_vel_z * ry);
                p.v[1] = vel_y + (angular_vel_z * rx - angular_vel_x * rz);
                p.v[2] = vel_z + (angular_vel_x * ry - angular_vel_y * rx);

                p.B[0][0] = 0.0f;             p.B[0][1] = -angular_vel_z; p.B[0][2] =  angular_vel_y;
                p.B[1][0] =  angular_vel_z;   p.B[1][1] = 0.0f;           p.B[1][2] = -angular_vel_x;
                p.B[2][0] = -angular_vel_y;   p.B[2][1] =  angular_vel_x; p.B[2][2] = 0.0f;

                p.lp[0] = 0.5f * p_dx;
                p.lp[1] = 0.5f * p_dy;
                p.lp[2] = 0.5f * p_dz;

                p.m = p_mass;
                p.V0 = p_vol;
                p.V = p_vol;

                p.damage = 0.0f;
                p.has_failed = false;

                for (int i = 0; i < 3; ++i) {
                    for (int j = 0; j < 3; ++j) {
                        p.F[i][j] = (i == j) ? 1.0f : 0.0f;
                        p.sigma[i][j] = 0.0f;
                    }
                }

                p.ep_bar = 0.0f;
                p.object_id = obj_id;
                p.transfer_scheme = mat.transfer_scheme;
                float m_w = (mat.weibull_modulus > 0.001f) ? mat.weibull_modulus : 8.0f;
                p.weibull_factor = computeWeibullFactor(x, y, z, m_w, mat.weibull_scale);

                m_particles.push_back(p);
            }
        }
    }
}

void MPMSolver3D::addSphereObject(int obj_id, float pos_x, float pos_y, float pos_z, float radius,
                                  float vel_x, float vel_y, float vel_z,
                                  float angular_vel_x, float angular_vel_y, float angular_vel_z,
                                  float density, float E, float nu,
                                  float yield_stress, float hardening, float failure_strain,
                                  float tensile_failure_stress, int ppc,
                                  MPMParticleDistribution particle_dist,
                                  MPMBoundaryFilling boundary_fill) {
    int particles_per_dim = static_cast<int>(std::round(std::cbrt(static_cast<float>(ppc))));
    if (particles_per_dim < 1) particles_per_dim = 2;

    float p_spacing = m_dx / static_cast<float>(particles_per_dim);
    float p_dx = p_spacing;
    float p_dy = (particle_dist == MPMParticleDistribution::Hexagonal) ? (std::sqrt(3.0f) * 0.5f * p_spacing) : (m_dy / static_cast<float>(particles_per_dim));
    float p_dz = (particle_dist == MPMParticleDistribution::Hexagonal) ? (std::sqrt(2.0f / 3.0f) * p_spacing) : (m_dz / static_cast<float>(particles_per_dim));

    float min_x = pos_x - radius; float max_x = pos_x + radius;
    float min_y = pos_y - radius; float max_y = pos_y + radius;
    float min_z = pos_z - radius; float max_z = pos_z + radius;

    float r2 = radius * radius;
    float nominal_vol = (particle_dist == MPMParticleDistribution::Hexagonal) ? ((p_spacing * p_spacing * p_spacing) / std::sqrt(2.0f)) : (p_dx * p_dy * p_dz);

    if (obj_id >= static_cast<int>(m_material_tables.size())) {
        m_material_tables.resize(obj_id + 1);
    }
    auto& mat = m_material_tables[obj_id];
    mat.density = density;
    mat.youngs_modulus = E;
    mat.poissons_ratio = nu;
    mat.yield_stress = yield_stress;
    mat.hardening_modulus = hardening;
    mat.failure_strain = failure_strain;
    mat.tensile_failure_stress = tensile_failure_stress;
    if (failure_strain > 0.0f) {
        mat.enable_strain_erosion = true;
        mat.erosion_strain = failure_strain;
        if (mat.weibull_modulus <= 0.001f) mat.weibull_modulus = 8.0f;
    }

    int layer_k = 0;
    for (float z = min_z + 0.5f * p_dz; z < max_z; z += p_dz, ++layer_k) {
        bool is_layer_b = (particle_dist == MPMParticleDistribution::Hexagonal && (layer_k % 2 == 1));
        float y_layer_offset = is_layer_b ? (p_spacing / (2.0f * std::sqrt(3.0f))) : 0.0f;
        int row_j = 0;
        for (float y = min_y + 0.5f * p_dy + y_layer_offset; y < max_y; y += p_dy, ++row_j) {
            float x_offset = 0.0f;
            if (particle_dist == MPMParticleDistribution::Hexagonal) {
                x_offset = ((row_j + (is_layer_b ? 1 : 0)) % 2 == 1) ? (0.5f * p_spacing) : 0.0f;
            }
            for (float x = min_x + 0.5f * p_dx + x_offset; x < max_x; x += p_dx) {
                float final_x = x;
                float final_y = y;
                float final_z = z;
                float f_vol = 1.0f;

                if (boundary_fill == MPMBoundaryFilling::Partial) {
                    int sub_count = 0;
                    float sum_sx = 0.0f, sum_sy = 0.0f, sum_sz = 0.0f;
                    for (int si = -1; si <= 1; ++si) {
                        float sx = x + (static_cast<float>(si) / 3.0f) * p_dx;
                        for (int sj = -1; sj <= 1; ++sj) {
                            float sy = y + (static_cast<float>(sj) / 3.0f) * p_dy;
                            for (int sk = -1; sk <= 1; ++sk) {
                                float sz = z + (static_cast<float>(sk) / 3.0f) * p_dz;
                                float dsx = sx - pos_x;
                                float dsy = sy - pos_y;
                                float dsz = sz - pos_z;
                                if (dsx * dsx + dsy * dsy + dsz * dsz <= r2) {
                                    sub_count++;
                                    sum_sx += sx;
                                    sum_sy += sy;
                                    sum_sz += sz;
                                }
                            }
                        }
                    }
                    if (sub_count == 0) continue;
                    f_vol = static_cast<float>(sub_count) / 27.0f;
                    if (f_vol < 0.10f) continue;
                    if (sub_count < 27) {
                        final_x = sum_sx / static_cast<float>(sub_count);
                        final_y = sum_sy / static_cast<float>(sub_count);
                        final_z = sum_sz / static_cast<float>(sub_count);
                    }
                } else {
                    float rx = x - pos_x;
                    float ry = y - pos_y;
                    float rz = z - pos_z;
                    if (rx * rx + ry * ry + rz * rz > r2) continue;
                }

                float p_vol = f_vol * nominal_vol;
                float p_mass = p_vol * density;

                MPMParticle3D p{};
                p.x[0] = final_x; p.x[1] = final_y; p.x[2] = final_z;

                float rx = final_x - pos_x;
                float ry = final_y - pos_y;
                float rz = final_z - pos_z;

                p.v[0] = vel_x + (angular_vel_y * rz - angular_vel_z * ry);
                p.v[1] = vel_y + (angular_vel_z * rx - angular_vel_x * rz);
                p.v[2] = vel_z + (angular_vel_x * ry - angular_vel_y * rx);

                p.B[0][0] = 0.0f;             p.B[0][1] = -angular_vel_z; p.B[0][2] =  angular_vel_y;
                p.B[1][0] =  angular_vel_z;   p.B[1][1] = 0.0f;           p.B[1][2] = -angular_vel_x;
                p.B[2][0] = -angular_vel_y;   p.B[2][1] =  angular_vel_x; p.B[2][2] = 0.0f;

                p.lp[0] = 0.5f * p_dx;
                p.lp[1] = 0.5f * p_dy;
                p.lp[2] = 0.5f * p_dz;

                p.m = p_mass;
                p.V0 = p_vol;
                p.V = p_vol;

                p.damage = 0.0f;
                p.has_failed = false;

                for (int i = 0; i < 3; ++i) {
                    for (int j = 0; j < 3; ++j) {
                        p.F[i][j] = (i == j) ? 1.0f : 0.0f;
                        p.sigma[i][j] = 0.0f;
                    }
                }

                p.ep_bar = 0.0f;
                p.object_id = obj_id;
                p.transfer_scheme = mat.transfer_scheme;
                float m_w = (mat.weibull_modulus > 0.001f) ? mat.weibull_modulus : 8.0f;
                p.weibull_factor = computeWeibullFactor(final_x, final_y, final_z, m_w, mat.weibull_scale);

                m_particles.push_back(p);
            }
        }
    }
}

void MPMSolver3D::addCylinderObject(int obj_id, float pos_x, float pos_y, float pos_z,
                                      float radius, float inner_radius, float height,
                                      float vel_x, float vel_y, float vel_z,
                                      float angular_vel_x, float angular_vel_y, float angular_vel_z,
                                      float density, float E, float nu,
                                      float yield_stress, float hardening, float failure_strain,
                                      float tensile_failure_stress, int ppc,
                                      MPMParticleDistribution particle_dist,
                                      MPMBoundaryFilling boundary_fill) {
    int particles_per_dim = static_cast<int>(std::round(std::cbrt(static_cast<float>(ppc))));
    if (particles_per_dim < 1) particles_per_dim = 2;

    float p_spacing = m_dx / static_cast<float>(particles_per_dim);
    float p_dx = p_spacing;
    float p_dy = (particle_dist == MPMParticleDistribution::Hexagonal) ? (std::sqrt(3.0f) * 0.5f * p_spacing) : (m_dy / static_cast<float>(particles_per_dim));
    float p_dz = (particle_dist == MPMParticleDistribution::Hexagonal) ? (std::sqrt(2.0f / 3.0f) * p_spacing) : (m_dz / static_cast<float>(particles_per_dim));

    float min_x = pos_x - radius; float max_x = pos_x + radius;
    float min_y = pos_y - radius; float max_y = pos_y + radius;
    float half_h = 0.5f * height;
    float min_z = pos_z - half_h; float max_z = pos_z + half_h;

    float r_outer2 = radius * radius;
    float r_inner2 = inner_radius * inner_radius;
    float nominal_vol = (particle_dist == MPMParticleDistribution::Hexagonal) ? ((p_spacing * p_spacing * p_spacing) / std::sqrt(2.0f)) : (p_dx * p_dy * p_dz);

    if (obj_id >= static_cast<int>(m_material_tables.size())) {
        m_material_tables.resize(obj_id + 1);
    }
    auto& mat = m_material_tables[obj_id];
    mat.density = density;
    mat.youngs_modulus = E;
    mat.poissons_ratio = nu;
    mat.yield_stress = yield_stress;
    mat.hardening_modulus = hardening;
    mat.failure_strain = failure_strain;
    mat.tensile_failure_stress = tensile_failure_stress;
    if (failure_strain > 0.0f) {
        mat.enable_strain_erosion = true;
        mat.erosion_strain = failure_strain;
        if (mat.weibull_modulus <= 0.001f) mat.weibull_modulus = 8.0f;
    }

    int layer_k = 0;
    for (float z = min_z + 0.5f * p_dz; z < max_z; z += p_dz, ++layer_k) {
        bool is_layer_b = (particle_dist == MPMParticleDistribution::Hexagonal && (layer_k % 2 == 1));
        float y_layer_offset = is_layer_b ? (p_spacing / (2.0f * std::sqrt(3.0f))) : 0.0f;
        int row_j = 0;
        for (float y = min_y + 0.5f * p_dy + y_layer_offset; y < max_y; y += p_dy, ++row_j) {
            float x_offset = 0.0f;
            if (particle_dist == MPMParticleDistribution::Hexagonal) {
                x_offset = ((row_j + (is_layer_b ? 1 : 0)) % 2 == 1) ? (0.5f * p_spacing) : 0.0f;
            }
            for (float x = min_x + 0.5f * p_dx + x_offset; x < max_x; x += p_dx) {
                float final_x = x;
                float final_y = y;
                float final_z = z;
                float f_vol = 1.0f;

                if (boundary_fill == MPMBoundaryFilling::Partial) {
                    int sub_count = 0;
                    float sum_sx = 0.0f, sum_sy = 0.0f, sum_sz = 0.0f;
                    for (int si = -1; si <= 1; ++si) {
                        float sx = x + (static_cast<float>(si) / 3.0f) * p_dx;
                        for (int sj = -1; sj <= 1; ++sj) {
                            float sy = y + (static_cast<float>(sj) / 3.0f) * p_dy;
                            for (int sk = -1; sk <= 1; ++sk) {
                                float sz = z + (static_cast<float>(sk) / 3.0f) * p_dz;
                                float dsx = sx - pos_x;
                                float dsy = sy - pos_y;
                                float dsz = sz - pos_z;
                                float sr2 = dsx * dsx + dsy * dsy;
                                if (sr2 <= r_outer2 && sr2 >= r_inner2 && std::abs(dsz) <= half_h) {
                                    sub_count++;
                                    sum_sx += sx;
                                    sum_sy += sy;
                                    sum_sz += sz;
                                }
                            }
                        }
                    }
                    if (sub_count == 0) continue;
                    f_vol = static_cast<float>(sub_count) / 27.0f;
                    if (f_vol < 0.10f) continue;
                    if (sub_count < 27) {
                        final_x = sum_sx / static_cast<float>(sub_count);
                        final_y = sum_sy / static_cast<float>(sub_count);
                        final_z = sum_sz / static_cast<float>(sub_count);
                    }
                } else {
                    float rx = x - pos_x;
                    float ry = y - pos_y;
                    float rz = z - pos_z;
                    float r2 = rx * rx + ry * ry;
                    if (r2 > r_outer2 || r2 < r_inner2 || std::abs(rz) > half_h) continue;
                }

                float p_vol = f_vol * nominal_vol;
                float p_mass = p_vol * density;

                MPMParticle3D p{};
                p.x[0] = final_x; p.x[1] = final_y; p.x[2] = final_z;

                float rx = final_x - pos_x;
                float ry = final_y - pos_y;
                float rz = final_z - pos_z;

                p.v[0] = vel_x + (angular_vel_y * rz - angular_vel_z * ry);
                p.v[1] = vel_y + (angular_vel_z * rx - angular_vel_x * rz);
                p.v[2] = vel_z + (angular_vel_x * ry - angular_vel_y * rx);

                p.B[0][0] = 0.0f;             p.B[0][1] = -angular_vel_z; p.B[0][2] =  angular_vel_y;
                p.B[1][0] =  angular_vel_z;   p.B[1][1] = 0.0f;           p.B[1][2] = -angular_vel_x;
                p.B[2][0] = -angular_vel_y;   p.B[2][1] =  angular_vel_x; p.B[2][2] = 0.0f;

                p.lp[0] = 0.5f * p_dx;
                p.lp[1] = 0.5f * p_dy;
                p.lp[2] = 0.5f * p_dz;

                p.m = p_mass;
                p.V0 = p_vol;
                p.V = p_vol;

                p.damage = 0.0f;
                p.has_failed = false;

                for (int i = 0; i < 3; ++i) {
                    for (int j = 0; j < 3; ++j) {
                        p.F[i][j] = (i == j) ? 1.0f : 0.0f;
                        p.sigma[i][j] = 0.0f;
                    }
                }

                p.ep_bar = 0.0f;
                p.object_id = obj_id;
                p.transfer_scheme = mat.transfer_scheme;
                float m_w = (mat.weibull_modulus > 0.001f) ? mat.weibull_modulus : 8.0f;
                p.weibull_factor = computeWeibullFactor(final_x, final_y, final_z, m_w, mat.weibull_scale);

                m_particles.push_back(p);
            }
        }
    }
}

void MPMSolver3D::addSTLObject(int obj_id, const std::string& stl_filepath,
                              float pos_x, float pos_y, float pos_z,
                              float scale_x, float scale_y, float scale_z,
                              float vel_x, float vel_y, float vel_z,
                              float angular_vel_x, float angular_vel_y, float angular_vel_z,
                              float density, float E, float nu,
                              float yield_stress, float hardening, float failure_strain,
                              float tensile_failure_stress, int ppc,
                              MPMParticleDistribution particle_dist,
                              MPMBoundaryFilling boundary_fill) {
    (void)boundary_fill;
    if (stl_filepath.empty()) return;
    std::vector<Triangle> raw_triangles;
    try {
        raw_triangles = read_stl(stl_filepath);
    } catch (const std::exception& e) {
        std::cerr << "[ERROR] MPMSolver3D::addSTLObject failed to load STL: " << e.what() << std::endl;
        return;
    }
    if (raw_triangles.empty()) return;

    if (scale_x <= 0.0f) scale_x = 1.0f;
    if (scale_y <= 0.0f) scale_y = 1.0f;
    if (scale_z <= 0.0f) scale_z = 1.0f;

    std::vector<Triangle> triangles = raw_triangles;
    float min_x = 1.0e30f, max_x = -1.0e30f;
    float min_y = 1.0e30f, max_y = -1.0e30f;
    float min_z = 1.0e30f, max_z = -1.0e30f;

    for (auto& tri : triangles) {
        tri.v0.x = tri.v0.x * scale_x + pos_x;
        tri.v0.y = tri.v0.y * scale_y + pos_y;
        tri.v0.z = tri.v0.z * scale_z + pos_z;

        tri.v1.x = tri.v1.x * scale_x + pos_x;
        tri.v1.y = tri.v1.y * scale_y + pos_y;
        tri.v1.z = tri.v1.z * scale_z + pos_z;

        tri.v2.x = tri.v2.x * scale_x + pos_x;
        tri.v2.y = tri.v2.y * scale_y + pos_y;
        tri.v2.z = tri.v2.z * scale_z + pos_z;

        min_x = std::min({min_x, tri.v0.x, tri.v1.x, tri.v2.x});
        max_x = std::max({max_x, tri.v0.x, tri.v1.x, tri.v2.x});
        min_y = std::min({min_y, tri.v0.y, tri.v1.y, tri.v2.y});
        max_y = std::max({max_y, tri.v0.y, tri.v1.y, tri.v2.y});
        min_z = std::min({min_z, tri.v0.z, tri.v1.z, tri.v2.z});
        max_z = std::max({max_z, tri.v0.z, tri.v1.z, tri.v2.z});
    }

    int particles_per_dim = static_cast<int>(std::round(std::cbrt(static_cast<float>(ppc))));
    if (particles_per_dim < 1) particles_per_dim = 2;

    float p_spacing = m_dx / static_cast<float>(particles_per_dim);
    float p_dx = p_spacing;
    float p_dy = (particle_dist == MPMParticleDistribution::Hexagonal) ? (std::sqrt(3.0f) * 0.5f * p_spacing) : (m_dy / static_cast<float>(particles_per_dim));
    float p_dz = (particle_dist == MPMParticleDistribution::Hexagonal) ? (std::sqrt(2.0f / 3.0f) * p_spacing) : (m_dz / static_cast<float>(particles_per_dim));

    float p_vol = (particle_dist == MPMParticleDistribution::Hexagonal) ? ((p_spacing * p_spacing * p_spacing) / std::sqrt(2.0f)) : (p_dx * p_dy * p_dz);
    float p_mass = p_vol * density;

    int ny_bins = std::max(1, static_cast<int>(std::ceil((max_y - min_y) / p_dy)));
    int nz_bins = std::max(1, static_cast<int>(std::ceil((max_z - min_z) / p_dz)));
    std::vector<std::vector<int>> yz_bins(ny_bins * nz_bins);

    for (int i = 0; i < static_cast<int>(triangles.size()); ++i) {
        const auto& tri = triangles[i];
        float t_min_y = std::min({tri.v0.y, tri.v1.y, tri.v2.y});
        float t_max_y = std::max({tri.v0.y, tri.v1.y, tri.v2.y});
        float t_min_z = std::min({tri.v0.z, tri.v1.z, tri.v2.z});
        float t_max_z = std::max({tri.v0.z, tri.v1.z, tri.v2.z});

        int by0 = std::clamp(static_cast<int>(std::floor((t_min_y - min_y) / p_dy)), 0, ny_bins - 1);
        int by1 = std::clamp(static_cast<int>(std::floor((t_max_y - min_y) / p_dy)), 0, ny_bins - 1);
        int bz0 = std::clamp(static_cast<int>(std::floor((t_min_z - min_z) / p_dz)), 0, nz_bins - 1);
        int bz1 = std::clamp(static_cast<int>(std::floor((t_max_z - min_z) / p_dz)), 0, nz_bins - 1);

        for (int bz = bz0; bz <= bz1; ++bz) {
            for (int by = by0; by <= by1; ++by) {
                yz_bins[by + bz * ny_bins].push_back(i);
            }
        }
    }

    if (obj_id >= static_cast<int>(m_material_tables.size())) {
        m_material_tables.resize(obj_id + 1);
    }
    auto& mat = m_material_tables[obj_id];
    mat.density = density;
    mat.youngs_modulus = E;
    mat.poissons_ratio = nu;
    mat.yield_stress = yield_stress;
    mat.hardening_modulus = hardening;
    mat.failure_strain = failure_strain;
    mat.tensile_failure_stress = tensile_failure_stress;
    if (failure_strain > 0.0f) {
        mat.enable_strain_erosion = true;
        mat.erosion_strain = failure_strain;
        if (mat.weibull_modulus <= 0.001f) mat.weibull_modulus = 8.0f;
    }

    std::cout << "[INFO] MPMSolver3D::addSTLObject loaded " << triangles.size() << " triangles. Sampling interior particles..." << std::endl;
    size_t particle_count_before = m_particles.size();

    int layer_k = 0;
    for (float z = min_z + 0.5f * p_dz; z < max_z; z += p_dz, ++layer_k) {
        bool is_layer_b = (particle_dist == MPMParticleDistribution::Hexagonal && (layer_k % 2 == 1));
        float y_layer_offset = is_layer_b ? (p_spacing / (2.0f * std::sqrt(3.0f))) : 0.0f;
        int row_j = 0;
        for (float y = min_y + 0.5f * p_dy + y_layer_offset; y < max_y; y += p_dy, ++row_j) {
            float x_offset = 0.0f;
            if (particle_dist == MPMParticleDistribution::Hexagonal) {
                x_offset = ((row_j + (is_layer_b ? 1 : 0)) % 2 == 1) ? (0.5f * p_spacing) : 0.0f;
            }
            int by = std::clamp(static_cast<int>(std::floor((y - min_y) / p_dy)), 0, ny_bins - 1);
            int bz = std::clamp(static_cast<int>(std::floor((z - min_z) / p_dz)), 0, nz_bins - 1);
            const auto& candidate_indices = yz_bins[by + bz * ny_bins];
            if (candidate_indices.empty()) continue;

            float y_ray = y + 1.234e-4f * p_dy;
            float z_ray = z + 5.678e-4f * p_dz;

            Point3D O = { min_x - 1.0f * p_dx, y_ray, z_ray };
            Point3D D = { 1.0f, 0.0f, 0.0f };
            std::vector<float> intersects;

            for (int idx : candidate_indices) {
                const auto& tri = triangles[idx];
                float t;
                if (ray_triangle_intersect(O, D, tri.v0, tri.v1, tri.v2, t)) {
                    intersects.push_back(O.x + t);
                }
            }

            if (intersects.empty()) continue;
            std::sort(intersects.begin(), intersects.end());

            for (float x = min_x + 0.5f * p_dx + x_offset; x < max_x; x += p_dx) {
                int count = 0;
                for (float xi : intersects) {
                    if (xi < x) count++;
                    else break;
                }
                if (count % 2 == 1) {
                    MPMParticle3D p{};
                    p.x[0] = x; p.x[1] = y; p.x[2] = z;

                    float rx = x - pos_x;
                    float ry = y - pos_y;
                    float rz = z - pos_z;

                    p.v[0] = vel_x + (angular_vel_y * rz - angular_vel_z * ry);
                    p.v[1] = vel_y + (angular_vel_z * rx - angular_vel_x * rz);
                    p.v[2] = vel_z + (angular_vel_x * ry - angular_vel_y * rx);

                    p.B[0][0] = 0.0f;             p.B[0][1] = -angular_vel_z; p.B[0][2] =  angular_vel_y;
                    p.B[1][0] =  angular_vel_z;   p.B[1][1] = 0.0f;           p.B[1][2] = -angular_vel_x;
                    p.B[2][0] = -angular_vel_y;   p.B[2][1] =  angular_vel_x; p.B[2][2] = 0.0f;

                    p.lp[0] = 0.5f * p_dx;
                    p.lp[1] = 0.5f * p_dy;
                    p.lp[2] = 0.5f * p_dz;

                    p.m = p_mass;
                    p.V0 = p_vol;
                    p.V = p_vol;

                    p.damage = 0.0f;
                    p.has_failed = false;

                    for (int i = 0; i < 3; ++i) {
                        for (int j = 0; j < 3; ++j) {
                            p.F[i][j] = (i == j) ? 1.0f : 0.0f;
                            p.sigma[i][j] = 0.0f;
                        }
                    }

                    p.ep_bar = 0.0f;
                    p.object_id = obj_id;
                    const auto& mat = getMaterialTable(obj_id);
                    p.transfer_scheme = mat.transfer_scheme;

                    m_particles.push_back(p);
                }
            }
        }
    }
    std::cout << "[INFO] Generated " << (m_particles.size() - particle_count_before) << " MPM particles for STL object " << obj_id << std::endl;
}

void MPMSolver3D::particleToGrid() {
    // Reset 3D grid
    for (auto& node : m_grid) {
        node.m = 0.0f;
        node.p[0] = 0.0f; node.p[1] = 0.0f; node.p[2] = 0.0f;
        node.f_ext[0] = 0.0f; node.f_ext[1] = 0.0f; node.f_ext[2] = 0.0f;
        node.f_int[0] = 0.0f; node.f_int[1] = 0.0f; node.f_int[2] = 0.0f;
        node.plastic_strain = 0.0f;
    }

    // P2G Scatter in 3D
    for (const auto& p : m_particles) {
        float px = p.x[0] - m_xmin;
        float py = p.x[1] - m_ymin;
        float pz = p.x[2] - m_zmin;

        int base_i = static_cast<int>(std::floor(px / m_dx));
        int base_j = static_cast<int>(std::floor(py / m_dy));
        int base_k = static_cast<int>(std::floor(pz / m_dz));

        // Evaluate 3D Cauchy stress & Von Mises equivalent stress
        float s_xx = p.sigma[0][0]; float s_yy = p.sigma[1][1]; float s_zz = p.sigma[2][2];
        float s_xy = p.sigma[0][1]; float s_yz = p.sigma[1][2]; float s_zx = p.sigma[2][0];

        float press = - (s_xx + s_yy + s_zz) / 3.0f;
        float dev_xx = s_xx + press;
        float dev_yy = s_yy + press;
        float dev_zz = s_zz + press;

        // Von Mises stress in 3D: q = sqrt(1/2 * [(sxx-syy)^2 + (syy-szz)^2 + (szz-sxx)^2 + 6*(sxy^2+syz^2+szx^2)])
        float diff_xy = s_xx - s_yy;
        float diff_yz = s_yy - s_zz;
        float diff_zx = s_zz - s_xx;
        float vm_stress = std::sqrt(0.5f * (diff_xy * diff_xy + diff_yz * diff_yz + diff_zx * diff_zx) +
                                    3.0f * (s_xy * s_xy + s_yz * s_yz + s_zx * s_zx));

        int eff_scheme = (p.transfer_scheme >= 0) ? p.transfer_scheme : static_cast<int>(m_transfer_scheme);

        if (eff_scheme == static_cast<int>(MPMTransferScheme::RadialMLS)) {
            float R_supp = 2.0f * std::max({m_dx, m_dy, m_dz});

            // Pass 1: Compute local partition of unity sum and stencil centroid (xc, yc, zc)
            float local_w_sum = 0.0f;
            float cx = 0.0f, cy = 0.0f, cz = 0.0f;

            for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= m_nx) continue;
                float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= m_ny) continue;
                    float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                    for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                        int k = base_k + offset_k;
                        if (k < 0 || k >= m_nz) continue;
                        float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

                        float dist_x = node_x - px;
                        float dist_y = node_y - py;
                        float dist_z = node_z - pz;
                        float r = std::sqrt(dist_x * dist_x + dist_y * dist_y + dist_z * dist_z);
                        if (r >= R_supp) continue;

                        float w = evalWendland_C2(r, R_supp);
                        if (w < 1.0e-7f) continue;

                        local_w_sum += w;
                        cx += w * node_x;
                        cy += w * node_y;
                        cz += w * node_z;
                    }
                }
            }

            if (local_w_sum <= 1.0e-7f) continue;
            float inv_w_sum = 1.0f / local_w_sum;
            float xc = cx * inv_w_sum;
            float yc = cy * inv_w_sum;
            float zc = cz * inv_w_sum;

            float D[3][3] = {{0.0f, 0.0f, 0.0f}, {0.0f, 0.0f, 0.0f}, {0.0f, 0.0f, 0.0f}};
            for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= m_nx) continue;
                float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= m_ny) continue;
                    float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                    for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                        int k = base_k + offset_k;
                        if (k < 0 || k >= m_nz) continue;
                        float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

                        float dist_x = node_x - px;
                        float dist_y = node_y - py;
                        float dist_z = node_z - pz;
                        float r = std::sqrt(dist_x * dist_x + dist_y * dist_y + dist_z * dist_z);
                        if (r >= R_supp) continue;

                        float w = evalWendland_C2(r, R_supp);
                        if (w < 1.0e-7f) continue;

                        float dc_x = node_x - xc;
                        float dc_y = node_y - yc;
                        float dc_z = node_z - zc;

                        D[0][0] += w * dc_x * dc_x;
                        D[0][1] += w * dc_x * dc_y;
                        D[0][2] += w * dc_x * dc_z;
                        D[1][1] += w * dc_y * dc_y;
                        D[1][2] += w * dc_y * dc_z;
                        D[2][2] += w * dc_z * dc_z;
                    }
                }
            }

            D[0][0] *= inv_w_sum; D[0][1] *= inv_w_sum; D[0][2] *= inv_w_sum;
            D[1][0] = D[0][1];    D[1][1] *= inv_w_sum; D[1][2] *= inv_w_sum;
            D[2][0] = D[0][2];    D[2][1] = D[1][2];    D[2][2] *= inv_w_sum;

            float D_inv[3][3];
            float det = D[0][0] * (D[1][1] * D[2][2] - D[1][2] * D[1][2]) -
                        D[0][1] * (D[0][1] * D[2][2] - D[1][2] * D[0][2]) +
                        D[0][2] * (D[0][1] * D[1][2] - D[1][1] * D[0][2]);

            if (det > 1.0e-18f) {
                float inv_det = 1.0f / det;
                D_inv[0][0] =  (D[1][1] * D[2][2] - D[1][2] * D[1][2]) * inv_det;
                D_inv[0][1] = -(D[0][1] * D[2][2] - D[1][2] * D[0][2]) * inv_det;
                D_inv[0][2] =  (D[0][1] * D[1][2] - D[1][1] * D[0][2]) * inv_det;
                D_inv[1][0] = D_inv[0][1];
                D_inv[1][1] =  (D[0][0] * D[2][2] - D[0][2] * D[0][2]) * inv_det;
                D_inv[1][2] = -(D[0][0] * D[1][2] - D[0][1] * D[0][2]) * inv_det;
                D_inv[2][0] = D_inv[0][2];
                D_inv[2][1] = D_inv[1][2];
                D_inv[2][2] =  (D[0][0] * D[1][1] - D[0][1] * D[0][1]) * inv_det;
            } else {
                float d_iso = 3.75f / (m_dx * m_dx);
                D_inv[0][0] = d_iso; D_inv[0][1] = 0.0f;  D_inv[0][2] = 0.0f;
                D_inv[1][0] = 0.0f;  D_inv[1][1] = d_iso; D_inv[1][2] = 0.0f;
                D_inv[2][0] = 0.0f;  D_inv[2][1] = 0.0f;  D_inv[2][2] = d_iso;
            }

            // Precompute sigma · D_inv
            float s_Dinv[3][3];
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    s_Dinv[r][c] = p.sigma[r][0] * D_inv[0][c] +
                                   p.sigma[r][1] * D_inv[1][c] +
                                   p.sigma[r][2] * D_inv[2][c];
                }
            }

            // Pass 2: Scatter mass, momentum, internal stress force
            for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= m_nx) continue;
                float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= m_ny) continue;
                    float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                    for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                        int k = base_k + offset_k;
                        if (k < 0 || k >= m_nz) continue;
                        float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

                        float dist_x = node_x - px;
                        float dist_y = node_y - py;
                        float dist_z = node_z - pz;
                        float r = std::sqrt(dist_x * dist_x + dist_y * dist_y + dist_z * dist_z);
                        if (r >= R_supp) continue;

                        float w = evalWendland_C2(r, R_supp);
                        if (w < 1.0e-7f) continue;

                        float weight = w * inv_w_sum;

                        size_t node_idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                        auto& node = m_grid[node_idx];

                        node.m += p.m * weight;

                        float dc_x = node_x - xc;
                        float dc_y = node_y - yc;
                        float dc_z = node_z - zc;

                        float v_apic_x = p.v[0] + (p.B[0][0] * dc_x + p.B[0][1] * dc_y + p.B[0][2] * dc_z);
                        float v_apic_y = p.v[1] + (p.B[1][0] * dc_x + p.B[1][1] * dc_y + p.B[1][2] * dc_z);
                        float v_apic_z = p.v[2] + (p.B[2][0] * dc_x + p.B[2][1] * dc_y + p.B[2][2] * dc_z);

                        node.p[0] += p.m * weight * v_apic_x;
                        node.p[1] += p.m * weight * v_apic_y;
                        node.p[2] += p.m * weight * v_apic_z;

                        // Internal Stress Force: f_int += -V * weight * (s_Dinv · dc)
                        node.f_int[0] -= p.V * weight * (s_Dinv[0][0] * dc_x + s_Dinv[0][1] * dc_y + s_Dinv[0][2] * dc_z);
                        node.f_int[1] -= p.V * weight * (s_Dinv[1][0] * dc_x + s_Dinv[1][1] * dc_y + s_Dinv[1][2] * dc_z);
                        node.f_int[2] -= p.V * weight * (s_Dinv[2][0] * dc_x + s_Dinv[2][1] * dc_y + s_Dinv[2][2] * dc_z);

                        node.plastic_strain += p.m * weight * p.ep_bar;
                    }
                }
            }
        } else if (eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) {
            for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= m_nx) continue;
                float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                float Sx = evalCubicBSpline_S(px, node_x, m_dx);
                float dSx = evalCubicBSpline_dS(px, node_x, m_dx);
                if (std::abs(Sx) < 1.0e-7f) continue;

                for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= m_ny) continue;
                    float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                    float Sy = evalCubicBSpline_S(py, node_y, m_dy);
                    float dSy = evalCubicBSpline_dS(py, node_y, m_dy);
                    if (std::abs(Sy) < 1.0e-7f) continue;

                    for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                        int k = base_k + offset_k;
                        if (k < 0 || k >= m_nz) continue;
                        float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

                        float Sz = evalCubicBSpline_S(pz, node_z, m_dz);
                        float dSz = evalCubicBSpline_dS(pz, node_z, m_dz);
                        if (std::abs(Sz) < 1.0e-7f) continue;

                        float weight = Sx * Sy * Sz;
                        float dN_dx = dSx * Sy * Sz;
                        float dN_dy = Sx * dSy * Sz;
                        float dN_dz = Sx * Sy * dSz;

                        size_t node_idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                        auto& node = m_grid[node_idx];

                        // Mass scatter
                        node.m += p.m * weight;

                        // APIC Momentum scatter in 3D: p_node += m_p * S * (v_p + w_apic * B_p * dist)
                        float dist_x = node_x - px;
                        float dist_y = node_y - py;
                        float dist_z = node_z - pz;

                        float w_apic = 1.0f;
                        float v_apic_x = p.v[0] + w_apic * (p.B[0][0] * dist_x + p.B[0][1] * dist_y + p.B[0][2] * dist_z);
                        float v_apic_y = p.v[1] + w_apic * (p.B[1][0] * dist_x + p.B[1][1] * dist_y + p.B[1][2] * dist_z);
                        float v_apic_z = p.v[2] + w_apic * (p.B[2][0] * dist_x + p.B[2][1] * dist_y + p.B[2][2] * dist_z);

                        node.p[0] += p.m * weight * v_apic_x;
                        node.p[1] += p.m * weight * v_apic_y;
                        node.p[2] += p.m * weight * v_apic_z;

                        // 3D Internal Stress Force scatter: f_int += -V_p * sigma_p * dN
                        node.f_int[0] -= p.V * (p.sigma[0][0] * dN_dx + p.sigma[0][1] * dN_dy + p.sigma[0][2] * dN_dz);
                        node.f_int[1] -= p.V * (p.sigma[1][0] * dN_dx + p.sigma[1][1] * dN_dy + p.sigma[1][2] * dN_dz);
                        node.f_int[2] -= p.V * (p.sigma[2][0] * dN_dx + p.sigma[2][1] * dN_dy + p.sigma[2][2] * dN_dz);

                        // Telemetry scalar scatter
                        node.plastic_strain += p.m * weight * p.ep_bar;
                    }
                }
            }
        } else {
            for (int offset_i = -1; offset_i <= 2; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= m_nx) continue;
                float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                float Sx = 0.0f, dSx = 0.0f;
                if (eff_scheme == static_cast<int>(MPMTransferScheme::GIMP)) {
                    Sx = evalGIMP_S(px, node_x, m_dx, p.lp[0]);
                    dSx = evalGIMP_dS(px, node_x, m_dx, p.lp[0]);
                } else if (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline)) {
                    Sx = evalBSpline_S(px, node_x, m_dx);
                    dSx = evalBSpline_dS(px, node_x, m_dx);
                } else {
                    Sx = std::max(0.0f, 1.0f - std::abs(px - node_x) / m_dx);
                    dSx = (px >= node_x ? -1.0f / m_dx : 1.0f / m_dx);
                }

                if (std::abs(Sx) < 1.0e-7f) continue;

                for (int offset_j = -1; offset_j <= 2; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= m_ny) continue;
                    float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                    float Sy = 0.0f, dSy = 0.0f;
                    if (eff_scheme == static_cast<int>(MPMTransferScheme::GIMP)) {
                        Sy = evalGIMP_S(py, node_y, m_dy, p.lp[1]);
                        dSy = evalGIMP_dS(py, node_y, m_dy, p.lp[1]);
                    } else if (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline)) {
                        Sy = evalBSpline_S(py, node_y, m_dy);
                        dSy = evalBSpline_dS(py, node_y, m_dy);
                    } else {
                        Sy = std::max(0.0f, 1.0f - std::abs(py - node_y) / m_dy);
                        dSy = (py >= node_y ? -1.0f / m_dy : 1.0f / m_dy);
                    }

                    if (std::abs(Sy) < 1.0e-7f) continue;

                    for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                        int k = base_k + offset_k;
                        if (k < 0 || k >= m_nz) continue;
                        float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

                        float Sz = 0.0f, dSz = 0.0f;
                        if (eff_scheme == static_cast<int>(MPMTransferScheme::GIMP)) {
                            Sz = evalGIMP_S(pz, node_z, m_dz, p.lp[2]);
                            dSz = evalGIMP_dS(pz, node_z, m_dz, p.lp[2]);
                        } else if (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline)) {
                            Sz = evalBSpline_S(pz, node_z, m_dz);
                            dSz = evalBSpline_dS(pz, node_z, m_dz);
                        } else {
                            Sz = std::max(0.0f, 1.0f - std::abs(pz - node_z) / m_dz);
                            dSz = (pz >= node_z ? -1.0f / m_dz : 1.0f / m_dz);
                        }

                        if (std::abs(Sz) < 1.0e-7f) continue;

                        float weight = Sx * Sy * Sz;
                        float dN_dx = dSx * Sy * Sz;
                        float dN_dy = Sx * dSy * Sz;
                        float dN_dz = Sx * Sy * dSz;

                        size_t node_idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                        auto& node = m_grid[node_idx];

                        // Mass scatter
                        node.m += p.m * weight;

                        // APIC Momentum scatter in 3D: p_node += m_p * S * (v_p + w_apic * B_p * dist)
                        float dist_x = node_x - px;
                        float dist_y = node_y - py;
                        float dist_z = node_z - pz;

                        float w_apic = 1.0f;
                        float v_apic_x = p.v[0] + w_apic * (p.B[0][0] * dist_x + p.B[0][1] * dist_y + p.B[0][2] * dist_z);
                        float v_apic_y = p.v[1] + w_apic * (p.B[1][0] * dist_x + p.B[1][1] * dist_y + p.B[1][2] * dist_z);
                        float v_apic_z = p.v[2] + w_apic * (p.B[2][0] * dist_x + p.B[2][1] * dist_y + p.B[2][2] * dist_z);

                        node.p[0] += p.m * weight * v_apic_x;
                        node.p[1] += p.m * weight * v_apic_y;
                        node.p[2] += p.m * weight * v_apic_z;

                        // 3D Internal Stress Force scatter: f_int += -V_p * sigma_p * dN
                        node.f_int[0] -= p.V * (p.sigma[0][0] * dN_dx + p.sigma[0][1] * dN_dy + p.sigma[0][2] * dN_dz);
                        node.f_int[1] -= p.V * (p.sigma[1][0] * dN_dx + p.sigma[1][1] * dN_dy + p.sigma[1][2] * dN_dz);
                        node.f_int[2] -= p.V * (p.sigma[2][0] * dN_dx + p.sigma[2][1] * dN_dy + p.sigma[2][2] * dN_dz);

                        // Telemetry scalar scatter
                        node.plastic_strain += p.m * weight * p.ep_bar;
                    }
                }
            }
        }
    }

    // Normalize telemetry scalars
    for (auto& node : m_grid) {
        if (node.m > MPMGridNode3D::MIN_MASS) {
            node.plastic_strain /= node.m;
        }
    }

    if (m_smooth_plastic_strain) {
        std::vector<float> smoothed_ep(m_grid.size(), 0.0f);
        for (int i = 0; i < m_nx; ++i) {
            for (int j = 0; j < m_ny; ++j) {
                for (int k = 0; k < m_nz; ++k) {
                    size_t idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                    if (m_grid[idx].m <= MPMGridNode3D::MIN_MASS) continue;
                    float sum_ep = 2.0f * m_grid[idx].plastic_strain;
                    float weight_sum = 2.0f;
                    for (int di = -1; di <= 1; ++di) {
                        for (int dj = -1; dj <= 1; ++dj) {
                            for (int dk = -1; dk <= 1; ++dk) {
                                if (di == 0 && dj == 0 && dk == 0) continue;
                                int ni = i + di; int nj = j + dj; int nk = k + dk;
                                if (ni >= 0 && ni < m_nx && nj >= 0 && nj < m_ny && nk >= 0 && nk < m_nz) {
                                    size_t n_idx = (static_cast<size_t>(ni) * m_ny + nj) * m_nz + nk;
                                    if (m_grid[n_idx].m > MPMGridNode3D::MIN_MASS) {
                                        float w = 1.0f / std::sqrt(static_cast<float>(di*di + dj*dj + dk*dk));
                                        sum_ep += w * m_grid[n_idx].plastic_strain;
                                        weight_sum += w;
                                    }
                                }
                            }
                        }
                    }
                    smoothed_ep[idx] = sum_ep / weight_sum;
                }
            }
        }
        for (int i = 0; i < m_nx; ++i) {
            for (int j = 0; j < m_ny; ++j) {
                for (int k = 0; k < m_nz; ++k) {
                    size_t idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                    m_grid[idx].plastic_strain = smoothed_ep[idx];
                }
            }
        }
    }
}

void MPMSolver3D::updateGridKinematics(float dt) {
    float avg_p_mass = 0.001f;
    if (!m_particles.empty()) avg_p_mass = m_particles[0].m;
    float m_eff_floor = 0.25f * avg_p_mass;

    for (int i = 0; i < m_nx; ++i) {
        for (int j = 0; j < m_ny; ++j) {
            for (int k = 0; k < m_nz; ++k) {
                size_t node_idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                auto& node = m_grid[node_idx];

                if (node.m > MPMGridNode3D::MIN_MASS) {
                    node.p[0] += dt * (node.f_ext[0] + node.f_int[0]);
                    node.p[1] += dt * (node.f_ext[1] + node.f_int[1]);
                    node.p[2] += dt * (node.f_ext[2] + node.f_int[2]);

                    // Apply 3D Boundary Conditions (x, y, z min/max across physical boundary faces)
                    if ((i <= 3 && m_bc_x_min == MPMBoundaryCondition3D::Sticky) ||
                        (i >= m_nx - 4 && m_bc_x_max == MPMBoundaryCondition3D::Sticky)) {
                        node.p[0] = 0.0f; node.p[1] = 0.0f; node.p[2] = 0.0f;
                    } else if ((i <= 3 && (m_bc_x_min == MPMBoundaryCondition3D::FreeSlip || m_bc_x_min == MPMBoundaryCondition3D::Reflecting)) ||
                               (i >= m_nx - 4 && (m_bc_x_max == MPMBoundaryCondition3D::FreeSlip || m_bc_x_max == MPMBoundaryCondition3D::Reflecting))) {
                        node.p[0] = 0.0f;
                    }

                    if ((j <= 3 && m_bc_y_min == MPMBoundaryCondition3D::Sticky) ||
                        (j >= m_ny - 4 && m_bc_y_max == MPMBoundaryCondition3D::Sticky)) {
                        node.p[0] = 0.0f; node.p[1] = 0.0f; node.p[2] = 0.0f;
                    } else if ((j <= 3 && (m_bc_y_min == MPMBoundaryCondition3D::FreeSlip || m_bc_y_min == MPMBoundaryCondition3D::Reflecting)) ||
                               (j >= m_ny - 4 && (m_bc_y_max == MPMBoundaryCondition3D::FreeSlip || m_bc_y_max == MPMBoundaryCondition3D::Reflecting))) {
                        node.p[1] = 0.0f;
                    }

                    if ((k <= 3 && m_bc_z_min == MPMBoundaryCondition3D::Sticky) ||
                        (k >= m_nz - 4 && m_bc_z_max == MPMBoundaryCondition3D::Sticky)) {
                        node.p[0] = 0.0f; node.p[1] = 0.0f; node.p[2] = 0.0f;
                    } else if ((k <= 3 && (m_bc_z_min == MPMBoundaryCondition3D::FreeSlip || m_bc_z_min == MPMBoundaryCondition3D::Reflecting)) ||
                               (k >= m_nz - 4 && (m_bc_z_max == MPMBoundaryCondition3D::FreeSlip || m_bc_z_max == MPMBoundaryCondition3D::Reflecting))) {
                        node.p[2] = 0.0f;
                    }

                }
            }
        }
    }
}

void MPMSolver3D::gridToParticle(float dt) {
    float max_B = 5000.0f / std::min({m_dx, m_dy, m_dz});
    m_last_v_max = 0.0f;

    for (auto& p : m_particles) {
        float px = p.x[0] - m_xmin;
        float py = p.x[1] - m_ymin;
        float pz = p.x[2] - m_zmin;

        int base_i = static_cast<int>(std::floor(px / m_dx));
        int base_j = static_cast<int>(std::floor(py / m_dy));
        int base_k = static_cast<int>(std::floor(pz / m_dz));

        float v_pic_x = 0.0f; float v_pic_y = 0.0f; float v_pic_z = 0.0f;
        float delta_v_grid_x = 0.0f; float delta_v_grid_y = 0.0f; float delta_v_grid_z = 0.0f;
        float weight_sum = 0.0f;

        float B_new[3][3] = {{0,0,0},{0,0,0},{0,0,0}};
        float L_new[3][3] = {{0,0,0},{0,0,0},{0,0,0}};

        int eff_scheme = (p.transfer_scheme >= 0) ? p.transfer_scheme : static_cast<int>(m_transfer_scheme);
        if (eff_scheme == static_cast<int>(MPMTransferScheme::RadialMLS)) {
            float R_supp = 2.0f * std::max({m_dx, m_dy, m_dz});

            // Pass 1: Compute local partition of unity sum and stencil centroid (xc, yc, zc)
            float local_w_sum = 0.0f;
            float cx = 0.0f, cy = 0.0f, cz = 0.0f;

            for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= m_nx) continue;
                float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= m_ny) continue;
                    float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                    for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                        int k = base_k + offset_k;
                        if (k < 0 || k >= m_nz) continue;
                        float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

                        float dist_x = node_x - px;
                        float dist_y = node_y - py;
                        float dist_z = node_z - pz;
                        float r = std::sqrt(dist_x * dist_x + dist_y * dist_y + dist_z * dist_z);
                        if (r >= R_supp) continue;

                        float w = evalWendland_C2(r, R_supp);
                        if (w < 1.0e-7f) continue;

                        local_w_sum += w;
                        cx += w * node_x;
                        cy += w * node_y;
                        cz += w * node_z;
                    }
                }
            }

            if (local_w_sum > 1.0e-7f) {
                float inv_w_sum = 1.0f / local_w_sum;
                float xc = cx * inv_w_sum;
                float yc = cy * inv_w_sum;
                float zc = cz * inv_w_sum;

                float D[3][3] = {{0.0f, 0.0f, 0.0f}, {0.0f, 0.0f, 0.0f}, {0.0f, 0.0f, 0.0f}};
                for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                    int i = base_i + offset_i;
                    if (i < 0 || i >= m_nx) continue;
                    float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                    for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                        int j = base_j + offset_j;
                        if (j < 0 || j >= m_ny) continue;
                        float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                        for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                            int k = base_k + offset_k;
                            if (k < 0 || k >= m_nz) continue;
                            float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

                            float dist_x = node_x - px;
                            float dist_y = node_y - py;
                            float dist_z = node_z - pz;
                            float r = std::sqrt(dist_x * dist_x + dist_y * dist_y + dist_z * dist_z);
                            if (r >= R_supp) continue;

                            float w = evalWendland_C2(r, R_supp);
                            if (w < 1.0e-7f) continue;

                            float dc_x = node_x - xc;
                            float dc_y = node_y - yc;
                            float dc_z = node_z - zc;

                            D[0][0] += w * dc_x * dc_x;
                            D[0][1] += w * dc_x * dc_y;
                            D[0][2] += w * dc_x * dc_z;
                            D[1][1] += w * dc_y * dc_y;
                            D[1][2] += w * dc_y * dc_z;
                            D[2][2] += w * dc_z * dc_z;
                        }
                    }
                }

                D[0][0] *= inv_w_sum; D[0][1] *= inv_w_sum; D[0][2] *= inv_w_sum;
                D[1][0] = D[0][1];    D[1][1] *= inv_w_sum; D[1][2] *= inv_w_sum;
                D[2][0] = D[0][2];    D[2][1] = D[1][2];    D[2][2] *= inv_w_sum;

                float D_inv[3][3];
                float det = D[0][0] * (D[1][1] * D[2][2] - D[1][2] * D[1][2]) -
                            D[0][1] * (D[0][1] * D[2][2] - D[1][2] * D[0][2]) +
                            D[0][2] * (D[0][1] * D[1][2] - D[1][1] * D[0][2]);

                if (det > 1.0e-18f) {
                    float inv_det = 1.0f / det;
                    D_inv[0][0] =  (D[1][1] * D[2][2] - D[1][2] * D[1][2]) * inv_det;
                    D_inv[0][1] = -(D[0][1] * D[2][2] - D[1][2] * D[0][2]) * inv_det;
                    D_inv[0][2] =  (D[0][1] * D[1][2] - D[1][1] * D[0][2]) * inv_det;
                    D_inv[1][0] = D_inv[0][1];
                    D_inv[1][1] =  (D[0][0] * D[2][2] - D[0][2] * D[0][2]) * inv_det;
                    D_inv[1][2] = -(D[0][0] * D[1][2] - D[0][1] * D[0][2]) * inv_det;
                    D_inv[2][0] = D_inv[0][2];
                    D_inv[2][1] = D_inv[1][2];
                    D_inv[2][2] =  (D[0][0] * D[1][1] - D[0][1] * D[0][1]) * inv_det;
                } else {
                    float d_iso = 3.75f / (m_dx * m_dx);
                    D_inv[0][0] = d_iso; D_inv[0][1] = 0.0f;  D_inv[0][2] = 0.0f;
                    D_inv[1][0] = 0.0f;  D_inv[1][1] = d_iso; D_inv[1][2] = 0.0f;
                    D_inv[2][0] = 0.0f;  D_inv[2][1] = 0.0f;  D_inv[2][2] = d_iso;
                }

                // Pass 2: Interpolate velocity and reconstruct B_new and L_new
                for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                    int i = base_i + offset_i;
                    if (i < 0 || i >= m_nx) continue;
                    float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                    for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                        int j = base_j + offset_j;
                        if (j < 0 || j >= m_ny) continue;
                        float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                        for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                            int k = base_k + offset_k;
                            if (k < 0 || k >= m_nz) continue;
                            float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

                            float dist_x = node_x - px;
                            float dist_y = node_y - py;
                            float dist_z = node_z - pz;
                            float r = std::sqrt(dist_x * dist_x + dist_y * dist_y + dist_z * dist_z);
                            if (r >= R_supp) continue;

                            float w = evalWendland_C2(r, R_supp);
                            if (w < 1.0e-7f) continue;

                            float weight = w * inv_w_sum;

                            size_t node_idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                            const auto& node = m_grid[node_idx];

                            if (node.m > MPMGridNode3D::MIN_MASS) {
                                float inv_m = 1.0f / node.m;
                                float n_vx = node.v(0);
                                float n_vy = node.v(1);
                                float n_vz = node.v(2);

                                v_pic_x += weight * n_vx;
                                v_pic_y += weight * n_vy;
                                v_pic_z += weight * n_vz;

                                float delta_vx = dt * (node.f_ext[0] + node.f_int[0]) * inv_m;
                                float delta_vy = dt * (node.f_ext[1] + node.f_int[1]) * inv_m;
                                float delta_vz = dt * (node.f_ext[2] + node.f_int[2]) * inv_m;

                                delta_v_grid_x += weight * delta_vx;
                                delta_v_grid_y += weight * delta_vy;
                                delta_v_grid_z += weight * delta_vz;

                                weight_sum += weight;

                                float dc_x = node_x - xc;
                                float dc_y = node_y - yc;
                                float dc_z = node_z - zc;

                                // dist_Dinv = D_inv · dc
                                float d_dinv_x = D_inv[0][0] * dc_x + D_inv[0][1] * dc_y + D_inv[0][2] * dc_z;
                                float d_dinv_y = D_inv[1][0] * dc_x + D_inv[1][1] * dc_y + D_inv[1][2] * dc_z;
                                float d_dinv_z = D_inv[2][0] * dc_x + D_inv[2][1] * dc_y + D_inv[2][2] * dc_z;

                                B_new[0][0] += weight * n_vx * d_dinv_x;
                                B_new[0][1] += weight * n_vx * d_dinv_y;
                                B_new[0][2] += weight * n_vx * d_dinv_z;

                                B_new[1][0] += weight * n_vy * d_dinv_x;
                                B_new[1][1] += weight * n_vy * d_dinv_y;
                                B_new[1][2] += weight * n_vy * d_dinv_z;

                                B_new[2][0] += weight * n_vz * d_dinv_x;
                                B_new[2][1] += weight * n_vz * d_dinv_y;
                                B_new[2][2] += weight * n_vz * d_dinv_z;

                                L_new[0][0] += n_vx * weight * d_dinv_x;
                                L_new[0][1] += n_vx * weight * d_dinv_y;
                                L_new[0][2] += n_vx * weight * d_dinv_z;

                                L_new[1][0] += n_vy * weight * d_dinv_x;
                                L_new[1][1] += n_vy * weight * d_dinv_y;
                                L_new[1][2] += n_vy * weight * d_dinv_z;

                                L_new[2][0] += n_vz * weight * d_dinv_x;
                                L_new[2][1] += n_vz * weight * d_dinv_y;
                                L_new[2][2] += n_vz * weight * d_dinv_z;
                            }
                        }
                    }
                }
            }
        } else if (eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) {
            float d_scale = 3.0f;
            float D_inv_x = d_scale / (m_dx * m_dx);
            float D_inv_y = d_scale / (m_dy * m_dy);
            float D_inv_z = d_scale / (m_dz * m_dz);

            for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= m_nx) continue;
                float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                float Sx = evalCubicBSpline_S(px, node_x, m_dx);
                float dSx = evalCubicBSpline_dS(px, node_x, m_dx);
                if (std::abs(Sx) < 1.0e-7f) continue;

                for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= m_ny) continue;
                    float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                    float Sy = evalCubicBSpline_S(py, node_y, m_dy);
                    float dSy = evalCubicBSpline_dS(py, node_y, m_dy);
                    if (std::abs(Sy) < 1.0e-7f) continue;

                    for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                        int k = base_k + offset_k;
                        if (k < 0 || k >= m_nz) continue;
                        float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

                        float Sz = evalCubicBSpline_S(pz, node_z, m_dz);
                        float dSz = evalCubicBSpline_dS(pz, node_z, m_dz);
                        if (std::abs(Sz) < 1.0e-7f) continue;

                        float weight = Sx * Sy * Sz;
                        float dN_dx = dSx * Sy * Sz;
                        float dN_dy = Sx * dSy * Sz;
                        float dN_dz = Sx * Sy * dSz;

                        size_t node_idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                        const auto& node = m_grid[node_idx];

                        if (node.m > MPMGridNode3D::MIN_MASS) {
                            float inv_m = 1.0f / node.m;
                            v_pic_x += weight * node.v(0);
                            v_pic_y += weight * node.v(1);
                            v_pic_z += weight * node.v(2);

                            float delta_vx = dt * (node.f_ext[0] + node.f_int[0]) * inv_m;
                            float delta_vy = dt * (node.f_ext[1] + node.f_int[1]) * inv_m;
                            float delta_vz = dt * (node.f_ext[2] + node.f_int[2]) * inv_m;

                            delta_v_grid_x += weight * delta_vx;
                            delta_v_grid_y += weight * delta_vy;
                            delta_v_grid_z += weight * delta_vz;

                            weight_sum += weight;

                            float dist_x = node_x - px;
                            float dist_y = node_y - py;
                            float dist_z = node_z - pz;

                            float w_apic = 1.0f;
                            B_new[0][0] += w_apic * weight * node.v(0) * dist_x * D_inv_x;
                            B_new[0][1] += w_apic * weight * node.v(0) * dist_y * D_inv_y;
                            B_new[0][2] += w_apic * weight * node.v(0) * dist_z * D_inv_z;

                            B_new[1][0] += w_apic * weight * node.v(1) * dist_x * D_inv_x;
                            B_new[1][1] += w_apic * weight * node.v(1) * dist_y * D_inv_y;
                            B_new[1][2] += w_apic * weight * node.v(1) * dist_z * D_inv_z;

                            B_new[2][0] += w_apic * weight * node.v(2) * dist_x * D_inv_x;
                            B_new[2][1] += w_apic * weight * node.v(2) * dist_y * D_inv_y;
                            B_new[2][2] += w_apic * weight * node.v(2) * dist_z * D_inv_z;

                            L_new[0][0] += node.v(0) * dN_dx;
                            L_new[0][1] += node.v(0) * dN_dy;
                            L_new[0][2] += node.v(0) * dN_dz;

                            L_new[1][0] += node.v(1) * dN_dx;
                            L_new[1][1] += node.v(1) * dN_dy;
                            L_new[1][2] += node.v(1) * dN_dz;

                            L_new[2][0] += node.v(2) * dN_dx;
                            L_new[2][1] += node.v(2) * dN_dy;
                            L_new[2][2] += node.v(2) * dN_dz;
                        }
                    }
                }
            }
        } else {
            float d_scale = (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline)) ? 4.0f : 3.0f;
            float D_inv_x = d_scale / (m_dx * m_dx);
            float D_inv_y = d_scale / (m_dy * m_dy);
            float D_inv_z = d_scale / (m_dz * m_dz);

            for (int offset_i = -1; offset_i <= 2; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= m_nx) continue;
                float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                float Sx = 0.0f, dSx = 0.0f;
                if (eff_scheme == static_cast<int>(MPMTransferScheme::GIMP)) {
                    Sx = evalGIMP_S(px, node_x, m_dx, p.lp[0]);
                    dSx = evalGIMP_dS(px, node_x, m_dx, p.lp[0]);
                } else if (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline)) {
                    Sx = evalBSpline_S(px, node_x, m_dx);
                    dSx = evalBSpline_dS(px, node_x, m_dx);
                } else {
                    Sx = std::max(0.0f, 1.0f - std::abs(px - node_x) / m_dx);
                    dSx = (px >= node_x ? -1.0f / m_dx : 1.0f / m_dx);
                }

                if (std::abs(Sx) < 1.0e-7f) continue;

                for (int offset_j = -1; offset_j <= 2; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= m_ny) continue;
                    float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                    float Sy = 0.0f, dSy = 0.0f;
                    if (eff_scheme == static_cast<int>(MPMTransferScheme::GIMP)) {
                        Sy = evalGIMP_S(py, node_y, m_dy, p.lp[1]);
                        dSy = evalGIMP_dS(py, node_y, m_dy, p.lp[1]);
                    } else if (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline)) {
                        Sy = evalBSpline_S(py, node_y, m_dy);
                        dSy = evalBSpline_dS(py, node_y, m_dy);
                    } else {
                        Sy = std::max(0.0f, 1.0f - std::abs(py - node_y) / m_dy);
                        dSy = (py >= node_y ? -1.0f / m_dy : 1.0f / m_dy);
                    }

                    if (std::abs(Sy) < 1.0e-7f) continue;

                    for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                        int k = base_k + offset_k;
                        if (k < 0 || k >= m_nz) continue;
                        float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

                        float Sz = 0.0f, dSz = 0.0f;
                        if (eff_scheme == static_cast<int>(MPMTransferScheme::GIMP)) {
                            Sz = evalGIMP_S(pz, node_z, m_dz, p.lp[2]);
                            dSz = evalGIMP_dS(pz, node_z, m_dz, p.lp[2]);
                        } else if (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline)) {
                            Sz = evalBSpline_S(pz, node_z, m_dz);
                            dSz = evalBSpline_dS(pz, node_z, m_dz);
                        } else {
                            Sz = std::max(0.0f, 1.0f - std::abs(pz - node_z) / m_dz);
                            dSz = (pz >= node_z ? -1.0f / m_dz : 1.0f / m_dz);
                        }

                        if (std::abs(Sz) < 1.0e-7f) continue;

                        float weight = Sx * Sy * Sz;
                        float dN_dx = dSx * Sy * Sz;
                        float dN_dy = Sx * dSy * Sz;
                        float dN_dz = Sx * Sy * dSz;

                        size_t node_idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                        const auto& node = m_grid[node_idx];

                        if (node.m > MPMGridNode3D::MIN_MASS) {
                            float inv_m = 1.0f / node.m;
                            v_pic_x += weight * node.v(0);
                            v_pic_y += weight * node.v(1);
                            v_pic_z += weight * node.v(2);

                            float delta_vx = dt * (node.f_ext[0] + node.f_int[0]) * inv_m;
                            float delta_vy = dt * (node.f_ext[1] + node.f_int[1]) * inv_m;
                            float delta_vz = dt * (node.f_ext[2] + node.f_int[2]) * inv_m;

                            delta_v_grid_x += weight * delta_vx;
                            delta_v_grid_y += weight * delta_vy;
                            delta_v_grid_z += weight * delta_vz;

                            weight_sum += weight;

                            float dist_x = node_x - px;
                            float dist_y = node_y - py;
                            float dist_z = node_z - pz;

                            float w_apic = 1.0f;
                            B_new[0][0] += w_apic * weight * node.v(0) * dist_x * D_inv_x;
                            B_new[0][1] += w_apic * weight * node.v(0) * dist_y * D_inv_y;
                            B_new[0][2] += w_apic * weight * node.v(0) * dist_z * D_inv_z;

                            B_new[1][0] += w_apic * weight * node.v(1) * dist_x * D_inv_x;
                            B_new[1][1] += w_apic * weight * node.v(1) * dist_y * D_inv_y;
                            B_new[1][2] += w_apic * weight * node.v(1) * dist_z * D_inv_z;

                            B_new[2][0] += w_apic * weight * node.v(2) * dist_x * D_inv_x;
                            B_new[2][1] += w_apic * weight * node.v(2) * dist_y * D_inv_y;
                            B_new[2][2] += w_apic * weight * node.v(2) * dist_z * D_inv_z;

                            L_new[0][0] += node.v(0) * dN_dx;
                            L_new[0][1] += node.v(0) * dN_dy;
                            L_new[0][2] += node.v(0) * dN_dz;

                            L_new[1][0] += node.v(1) * dN_dx;
                            L_new[1][1] += node.v(1) * dN_dy;
                            L_new[1][2] += node.v(1) * dN_dz;

                            L_new[2][0] += node.v(2) * dN_dx;
                            L_new[2][1] += node.v(2) * dN_dy;
                            L_new[2][2] += node.v(2) * dN_dz;
                        }
                    }
                }
            }
        }

        if (weight_sum <= 1.0e-7f) {
            v_pic_x = p.v[0];
            v_pic_y = p.v[1];
            v_pic_z = p.v[2];
            delta_v_grid_x = 0.0f;
            delta_v_grid_y = 0.0f;
            delta_v_grid_z = 0.0f;
        } else {
            float inv_w = 1.0f / weight_sum;
            v_pic_x *= inv_w;
            v_pic_y *= inv_w;
            v_pic_z *= inv_w;
            delta_v_grid_x *= inv_w;
            delta_v_grid_y *= inv_w;
            delta_v_grid_z *= inv_w;
        }

        float target_vx = v_pic_x;
        float target_vy = v_pic_y;
        float target_vz = v_pic_z;

        if (p.has_failed || p.damage >= 1.0f) {
            // Pure FLIP velocity update for failed debris particles (0% PIC grid velocity averaging).
            // Preserves relative particle separation speeds and enables discrete fragment breakup.
            target_vx = p.v[0] + delta_v_grid_x;
            target_vy = p.v[1] + delta_v_grid_y;
            target_vz = p.v[2] + delta_v_grid_z;
        } else if (m_velocity_scheme == MPMVelocityScheme::FLIP) {
            float alpha = std::clamp(m_flip_blend, 0.0f, 1.0f);
            float v_flip_x = p.v[0] + delta_v_grid_x;
            float v_flip_y = p.v[1] + delta_v_grid_y;
            float v_flip_z = p.v[2] + delta_v_grid_z;
            target_vx = alpha * v_flip_x + (1.0f - alpha) * v_pic_x;
            target_vy = alpha * v_flip_y + (1.0f - alpha) * v_pic_y;
            target_vz = alpha * v_flip_z + (1.0f - alpha) * v_pic_z;
        }

        p.v[0] = std::clamp(target_vx, -5000.0f, 5000.0f);
        p.v[1] = std::clamp(target_vy, -5000.0f, 5000.0f);
        p.v[2] = std::clamp(target_vz, -5000.0f, 5000.0f);

        float p_speed = std::sqrt(p.v[0]*p.v[0] + p.v[1]*p.v[1] + p.v[2]*p.v[2]);
        if (p_speed > m_last_v_max) m_last_v_max = p_speed;

        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                p.B[r][c] = (!p.has_failed && m_velocity_scheme == MPMVelocityScheme::APIC) ? std::clamp(B_new[r][c], -max_B, max_B) : 0.0f;
                p.L_grad[r][c] = std::clamp(L_new[r][c], -max_B, max_B);
            }
        }

        // Update Particle Position
        p.x[0] += dt * p.v[0];
        p.x[1] += dt * p.v[1];
        p.x[2] += dt * p.v[2];

        // Domain Boundary Clamping at Physical Domain Boundaries (inside ghost padding)
        float phys_min_x = m_xmin + 3.0f * m_dx; float phys_max_x = m_xmin + (static_cast<float>(m_nx - 4)) * m_dx;
        float phys_min_y = m_ymin + 3.0f * m_dy; float phys_max_y = m_ymin + (static_cast<float>(m_ny - 4)) * m_dy;
        float phys_min_z = m_zmin + 3.0f * m_dz; float phys_max_z = m_zmin + (static_cast<float>(m_nz - 4)) * m_dz;

        if (p.x[0] < phys_min_x && m_bc_x_min != MPMBoundaryCondition3D::Terminate) {
            p.x[0] = phys_min_x;
            if (p.v[0] < 0.0f) { p.v[0] = 0.0f; }
        } else if (p.x[0] > phys_max_x && m_bc_x_max != MPMBoundaryCondition3D::Terminate) {
            p.x[0] = phys_max_x;
            if (p.v[0] > 0.0f) { p.v[0] = 0.0f; }
        }

        if (p.x[1] < phys_min_y && m_bc_y_min != MPMBoundaryCondition3D::Terminate) {
            p.x[1] = phys_min_y;
            if (p.v[1] < 0.0f) { p.v[1] = 0.0f; }
        } else if (p.x[1] > phys_max_y && m_bc_y_max != MPMBoundaryCondition3D::Terminate) {
            p.x[1] = phys_max_y;
            if (p.v[1] > 0.0f) { p.v[1] = 0.0f; }
        }

        if (p.x[2] < phys_min_z && m_bc_z_min != MPMBoundaryCondition3D::Terminate) {
            p.x[2] = phys_min_z;
            if (p.v[2] < 0.0f) { p.v[2] = 0.0f; }
        } else if (p.x[2] > phys_max_z && m_bc_z_max != MPMBoundaryCondition3D::Terminate) {
            p.x[2] = phys_max_z;
            if (p.v[2] > 0.0f) { p.v[2] = 0.0f; }
        }
    }
}

void MPMSolver3D::updateStressState(float dt) {
    for (auto& p : m_particles) {
        const auto& mat = getMaterialTable(p.object_id);

        // Fully failed particles: erase stress and APIC affine matrix.
        // This prevents failed debris from elastically coupling back to intact material.
        // Velocity gradient L evaluated from exact shape function derivatives L_grad
        float L[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                L[r][c] = p.L_grad[r][c];

        // Symmetric strain increment D*dt and spin tensor W
        float deps[3][3], W[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c) {
                deps[r][c] = 0.5f * (L[r][c] + L[c][r]) * dt;
                W[r][c]    = 0.5f * (L[r][c] - L[c][r]);
            }
        const float tr_deps = deps[0][0] + deps[1][1] + deps[2][2];

        p.V = std::clamp(p.V * (1.0f + tr_deps), 0.1f * p.V0, 10.0f * p.V0);
        if (m_transfer_scheme == MPMTransferScheme::GIMP) {
            float lp_val = 0.5f * std::cbrt(p.V);
            p.lp[0] = lp_val; p.lp[1] = lp_val; p.lp[2] = lp_val;
        }

        // --- Unified Parent Material Response for Eroded / Failed / Fractured Particles ---
        if (p.has_failed || p.damage >= 1.0f) {
            p.has_failed = true;
            p.damage = 1.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    p.B[r][c] = 0.0f; // Zero affine velocity gradient to eliminate elastic tensile coupling

            // 1. Bulk Pressure from Volumetric Compression J = V / V0 using Parent EOS
            const float J = p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f);
            float p_comp = 0.0f;
            if (J < 1.0f) {
                if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen && mat.mg_c0 > 0.0f) {
                    const float mu_vol = (1.0f - J) / std::max(0.01f, J);
                    const float denom = std::max(0.1f, 1.0f - (mat.mg_s - 1.0f) * mu_vol);
                    const float p_hugoniot = (mat.density * mat.mg_c0 * mat.mg_c0 * mu_vol * (1.0f + (1.0f - 0.5f * mat.mg_gamma0) * mu_vol)) / (denom * denom);
                    p_comp = std::max(0.0f, p_hugoniot + mat.mg_gamma0 * mat.density * p.e_int);
                } else {
                    const float E_mod    = mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f;
                    const float nu       = std::clamp(mat.poissons_ratio, 0.01f, 0.49f);
                    const float K_parent = E_mod / (3.0f * (1.0f - 2.0f * nu));
                    p_comp = K_parent * (1.0f - J) / std::max(0.01f, J);
                }
            }

            // 2. Frictional Shear Resistance under Confinement (Mohr-Coulomb / Drucker-Prager: q <= M * p_comp)
            float M_friction = 0.30f;
            if (mat.material_model == MPMMaterialModel::RHTConcrete ||
                mat.material_model == MPMMaterialModel::KCConcrete ||
                mat.material_model == MPMMaterialModel::CSCMConcrete) {
                M_friction = 0.60f; // Concrete/rock aggregate friction
            } else if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen) {
                M_friction = 0.15f; // Ductile metal shear resistance under high pressure
            }
            const float q_max = M_friction * p_comp;

            const float E_mod = mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f;
            const float nu = std::clamp(mat.poissons_ratio, 0.01f, 0.49f);
            const float mu_parent = E_mod / (2.0f * (1.0f + nu));

            float deps_dev[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c) {
                    deps_dev[r][c] = deps[r][c];
                    if (r == c) deps_dev[r][c] -= tr_deps / 3.0f;
                }

            float s_trial[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_trial[r][c] = p.sigma[r][c] + 2.0f * mu_parent * deps_dev[r][c];

            float press_s = -(s_trial[0][0] + s_trial[1][1] + s_trial[2][2]) / 3.0f;
            for (int r = 0; r < 3; ++r)
                s_trial[r][r] += press_s;

            float s_s = 0.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_s += s_trial[r][c] * s_trial[r][c];
            float q_trial = std::sqrt(1.5f * s_s);

            if (q_trial > q_max && q_trial > 1.0e-7f) {
                float scale = q_max / q_trial;
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        p.sigma[r][c] = scale * s_trial[r][c];
            } else {
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        p.sigma[r][c] = s_trial[r][c];
            }

            for (int r = 0; r < 3; ++r)
                p.sigma[r][r] -= p_comp;

            continue;
        }

        // --- Linear Elastic Model (Hooke's Law with Jaumann Rotation) ---
        if (mat.material_model == MPMMaterialModel::LinearElastic) {
            p.V = std::clamp(p.V * (1.0f + tr_deps), 0.1f * p.V0, 10.0f * p.V0);
            const float J = p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f);

            // 1. Jaumann Stress Rotation
            float W_sig[3][3] = {}, sig_W[3][3] = {};
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    for (int k = 0; k < 3; ++k) {
                        W_sig[r][c] += W[r][k] * p.sigma[k][c];
                        sig_W[r][c] += p.sigma[r][k] * W[k][c];
                    }

            float sig_base[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    sig_base[r][c] = p.sigma[r][c] + (W_sig[r][c] - sig_W[r][c]) * dt;

            const float E_mod    = mat.youngs_modulus;
            const float nu_val   = mat.poissons_ratio;
            const float mu_shear = E_mod / (2.0f * (1.0f + nu_val));
            const float K_bulk   = E_mod / (3.0f * std::max(0.01f, 1.0f - 2.0f * nu_val));

            float deps_dev[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c) {
                    deps_dev[r][c] = deps[r][c];
                    if (r == c) deps_dev[r][c] -= tr_deps / 3.0f;
                }

            float s_trial[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_trial[r][c] = sig_base[r][c] + 2.0f * mu_shear * deps_dev[r][c];

            float p_s = -(s_trial[0][0] + s_trial[1][1] + s_trial[2][2]) / 3.0f;
            for (int r = 0; r < 3; ++r)
                s_trial[r][r] += p_s;

            // Hydrostatic elastic pressure
            float p_hydro = K_bulk * (1.0f - J) / std::max(0.01f, J);
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    p.sigma[r][c] = s_trial[r][c] - (r == c ? p_hydro : 0.0f);

            continue;
        }

        // --- CREST Reactive Burn Model with Davis Reactant & Product EOS ---
        if (mat.material_model == MPMMaterialModel::CRESTReactiveBurn) {
            const float v_rel = p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f);
            p.v_min = std::min(p.v_min, v_rel);

            // 1. Peak Shock Entropy Latching (Kinematic Volume, Cauchy Pressure, Reactant Pressure & Temperature)
            float s_calc = CrestDavis::computeDavisShockEntropy(p.v_min, mat.davis_c0, mat.davis_s1, mat.davis_gamma0, mat.davis_cv, mat.davis_t0, mat.davis_rho0);
            p.s_shock = std::max(p.s_shock, s_calc);

            float p_curr_comp = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
            float p_react_trial = CrestDavis::computeDavisReactantPressure(v_rel, p.e_int, mat.davis_c0, mat.davis_s1, mat.davis_gamma0, mat.davis_cv, mat.davis_t0, mat.davis_rho0);
            float p_eff_comp = std::max(p_curr_comp, p_react_trial);
            if (p_eff_comp > 1.0e6f) {
                float s_p = CrestDavis::computeDavisShockEntropyFromPressure(p_eff_comp, mat.davis_c0, mat.davis_s1, mat.davis_cv, mat.davis_t0, mat.davis_rho0);
                p.s_shock = std::max(p.s_shock, s_p);
            }

            if (p.temperature > mat.davis_t0) {
                float s_therm = mat.davis_cv * std::log(p.temperature / mat.davis_t0);
                p.s_shock = std::max(p.s_shock, s_therm);
            }

            // 2. CREST Reaction Kinetics ODE Advance
            float lam_curr = p.lambda;
            p.lambda = CrestDavis::advanceCRESTProgress(dt, p.s_shock, p.lambda, mat.crest_b1, mat.crest_c1, mat.crest_m1, mat.crest_b2, mat.crest_c2, mat.crest_c3, mat.crest_m2, mat.crest_s0, mat.crest_s_threshold);
            float d_lam = std::max(0.0f, p.lambda - lam_curr);

            // 3. Two-Phase Pressures
            float p_react = CrestDavis::computeDavisReactantPressure(v_rel, p.e_int, mat.davis_c0, mat.davis_s1, mat.davis_gamma0, mat.davis_cv, mat.davis_t0, mat.davis_rho0);
            float p_prod  = CrestDavis::computeDavisProductPressure(v_rel, p.e_int + mat.davis_q_det, mat.davis_a, mat.davis_b, mat.davis_k, mat.davis_vc, mat.davis_pc, mat.davis_q_det, mat.davis_rho0);
            float p_mix   = (1.0f - p.lambda) * p_react + p.lambda * p_prod;
            if (p_mix < 1.0e-6f) p_mix = 1.0e-6f;

            // 4. Energy Conservation: Shock Work & Chemical Heat Release
            float rho_eff = (mat.density > 10.0f) ? mat.density : 1895.0f;
            float de_comp = (tr_deps < 0.0f) ? -(p_mix / rho_eff) * tr_deps : 0.0f;
            float de_chem = d_lam * mat.davis_q_det;
            p.e_int += de_comp + de_chem;
            p.temperature = mat.davis_t0 + p.e_int / (mat.davis_cv > 1.0f ? mat.davis_cv : 1000.0f);
            if (p.temperature > mat.davis_t0) {
                float s_therm = mat.davis_cv * std::log(p.temperature / mat.davis_t0);
                p.s_shock = std::max(p.s_shock, s_therm);
            }

            // 4. Solid Shear Stress Relaxation as lambda -> 1
            float W_sig[3][3] = {}, sig_W[3][3] = {};
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    for (int k = 0; k < 3; ++k) {
                        W_sig[r][c] += W[r][k] * p.sigma[k][c];
                        sig_W[r][c] += p.sigma[r][k] * W[k][c];
                    }

            float sig_base[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    sig_base[r][c] = p.sigma[r][c] + (W_sig[r][c] - sig_W[r][c]) * dt;

            const float E_mod    = mat.youngs_modulus;
            const float nu_val   = mat.poissons_ratio;
            const float mu_shear = (1.0f - p.lambda) * (E_mod / (2.0f * (1.0f + nu_val)));

            float deps_dev[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c) {
                    deps_dev[r][c] = deps[r][c];
                    if (r == c) deps_dev[r][c] -= tr_deps / 3.0f;
                }

            float s_trial[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_trial[r][c] = (1.0f - p.lambda) * (sig_base[r][c] + 2.0f * mu_shear * deps_dev[r][c]);

            float p_s = -(s_trial[0][0] + s_trial[1][1] + s_trial[2][2]) / 3.0f;
            for (int r = 0; r < 3; ++r)
                s_trial[r][r] += p_s;

            // Radial return plasticity for solid phase
            float s_mag_sq = 0.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_mag_sq += s_trial[r][c] * s_trial[r][c];
            float q_trial = std::sqrt(1.5f * s_mag_sq);
            float q_yield = (1.0f - p.lambda) * (mat.yield_stress > 1.0e5f ? mat.yield_stress : 100.0e6f);
            if (q_trial > q_yield && q_trial > 1.0e-6f) {
                float scale = q_yield / q_trial;
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        s_trial[r][c] *= scale;
            }

            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    p.sigma[r][c] = s_trial[r][c] - (r == c ? p_mix : 0.0f);

            continue;
        }

        // --- Johnson-Cook Plasticity + Mie-Grüneisen Shock EOS Model ---
        if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen) {
            float w_factor = (p.weibull_factor > 0.001f) ? p.weibull_factor : 1.0f;
            if (w_factor <= 0.001f && mat.weibull_modulus > 0.001f) {
                w_factor = computeWeibullFactor(p.x[0], p.x[1], p.x[2], mat.weibull_modulus, mat.weibull_scale);
            }

            p.V = std::clamp(p.V * (1.0f + tr_deps), 0.1f * p.V0, 10.0f * p.V0);
            const float J = p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f);
            const float mu_vol = (1.0f - J) / J;

            // 1. Mie-Grüneisen Shock EOS Hydrostatic Pressure
            float p_hydro = 0.0f;
            if (mu_vol > 0.0f) {
                float denom = 1.0f - (mat.mg_s - 1.0f) * mu_vol;
                if (denom < 0.1f) denom = 0.1f;
                float p_H = (mat.density * mat.mg_c0 * mat.mg_c0 * mu_vol * (1.0f + mu_vol)) / (denom * denom);
                float e_H = (p_H * mu_vol) / (2.0f * mat.density * (1.0f + mu_vol));
                p_hydro = p_H + mat.mg_gamma0 * mat.density * (p.e_int - e_H);
            } else {
                p_hydro = mat.density * mat.mg_c0 * mat.mg_c0 * mu_vol;
            }

            // 2. Jaumann Stress Rotation
            float W_sig[3][3] = {}, sig_W[3][3] = {};
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    for (int k = 0; k < 3; ++k) {
                        W_sig[r][c] += W[r][k] * p.sigma[k][c];
                        sig_W[r][c] += p.sigma[r][k] * W[k][c];
                    }

            float sig_base[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    sig_base[r][c] = p.sigma[r][c] + (W_sig[r][c] - sig_W[r][c]) * dt;

            const float E_mod    = mat.youngs_modulus;
            const float nu_val   = mat.poissons_ratio;
            const float mu_shear = E_mod / (2.0f * (1.0f + nu_val));

            float deps_dev[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c) {
                    deps_dev[r][c] = deps[r][c];
                    if (r == c) deps_dev[r][c] -= tr_deps / 3.0f;
                }

            float s_trial[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_trial[r][c] = sig_base[r][c] + 2.0f * mu_shear * deps_dev[r][c];

            float p_s = -(s_trial[0][0] + s_trial[1][1] + s_trial[2][2]) / 3.0f;
            for (int r = 0; r < 3; ++r)
                s_trial[r][r] += p_s;

            float s_s = 0.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_s += s_trial[r][c] * s_trial[r][c];
            const float q_trial = std::sqrt(1.5f * s_s);

            // 3. Johnson-Cook Yield Stress with Weibull Flaw Scatter
            float double_contraction = 0.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    double_contraction += deps_dev[r][c] * deps_dev[r][c];
            float deps_eq = std::sqrt((2.0f / 3.0f) * double_contraction);
            float ep_dot_star = std::max(1.0f, deps_eq / (dt > 1e-12f ? dt : 1e-12f));
            float T_star = std::clamp((p.temperature - mat.T_room) / (mat.T_melt > mat.T_room ? mat.T_melt - mat.T_room : 1.0f), 0.0f, 1.0f);

            float term_strain = (mat.jc_A * w_factor) + mat.jc_B * std::pow(std::max(0.0f, p.ep_bar), mat.jc_n);
            float term_rate   = 1.0f + mat.jc_C * std::log(ep_dot_star);
            float term_temp   = 1.0f - std::pow(T_star, mat.jc_m);
            if (term_temp < 0.0f) term_temp = 0.0f;

            float soft_damage = std::clamp(1.0f - p.damage, 0.05f, 1.0f);
            float jc_yield = term_strain * term_rate * term_temp * soft_damage;
            if (T_star >= 1.0f) jc_yield = 0.0f; // Liquid hydrodynamic state

            // 4. Radial Return Mapping & Plastic Work Conversion
            float H_jc = (mat.jc_n > 0.0f && p.ep_bar > 1.0e-6f)
                ? (mat.jc_n * mat.jc_B * std::pow(p.ep_bar, mat.jc_n - 1.0f) * term_rate * term_temp)
                : mat.hardening_modulus;
            float delta_ep = 0.0f;
            if (q_trial > 1.0e-5f && q_trial > jc_yield) {
                delta_ep = (q_trial - jc_yield) / (3.0f * mu_shear + H_jc);
                float scale = (q_trial > 1e-12f) ? (jc_yield / q_trial) : 0.0f;
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c) {
                        p.sigma[r][c] = scale * s_trial[r][c];
                        if (r == c) p.sigma[r][c] -= p_hydro;
                    }
                p.ep_bar += delta_ep;
            } else {
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c) {
                        p.sigma[r][c] = s_trial[r][c];
                        if (r == c) p.sigma[r][c] -= p_hydro;
                    }
            }

            if (delta_ep > 0.0f && mat.density > 0.0f && mat.Cp > 0.0f) {
                float dw_p = jc_yield * delta_ep;
                float de_p = (0.90f * dw_p) / mat.density;
                p.e_int += de_p;
                p.temperature = mat.T_room + p.e_int / mat.Cp;
            }

            // 5. Thermal Re-Welding / Healing Rule or Damage Accumulation
            if (p.temperature >= 0.80f * mat.T_melt && p_hydro > 0.0f) {
                p.damage = 0.0f;
                p.has_failed = false;
            } else {
                const float fail_strain_base = (mat.failure_strain > 0.0f) ? mat.failure_strain * w_factor : 0.0f;
                const float tensile_fail_base = (mat.tensile_failure_stress > 0.0f) ? mat.tensile_failure_stress * w_factor : 0.0f;

                float d_plastic = 0.0f;
                if (mat.enable_strain_erosion) {
                    float fail_strain = (mat.erosion_strain > 0.0f) ? mat.erosion_strain : fail_strain_base;
                    if (fail_strain > 0.0f) {
                        d_plastic = std::clamp(p.ep_bar / fail_strain, 0.0f, 1.0f);
                    }
                }

                float d_tensile = 0.0f;
                if (mat.enable_stress_erosion) {
                    float fail_stress = (mat.erosion_stress > 0.0f) ? mat.erosion_stress : tensile_fail_base;
                    float tensile_stress = -p_hydro;
                    if (tensile_stress > 0.0f && fail_stress > 0.0f) {
                        d_tensile = std::clamp(tensile_stress / fail_stress, 0.0f, 1.0f);
                    }
                }

                p.damage = std::max(p.damage, std::max(d_plastic, d_tensile));
                if (p.damage >= 1.0f && (mat.enable_strain_erosion || mat.enable_stress_erosion)) {
                    p.has_failed = true;
                    p.damage = 1.0f;
                    for (int r = 0; r < 3; ++r)
                        for (int c = 0; c < 3; ++c)
                            p.B[r][c] = 0.0f;

                    // Relax failed particles: zero shear/tensile stress, retain compressive hydrostatic pressure from parent EOS
                    float p_comp = 0.0f;
                    if (J < 1.0f) {
                        if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen && mat.mg_c0 > 0.0f) {
                            const float mu_vol = (1.0f - J) / std::max(0.01f, J);
                            const float denom = std::max(0.1f, 1.0f - (mat.mg_s - 1.0f) * mu_vol);
                            const float p_hugoniot = (mat.density * mat.mg_c0 * mat.mg_c0 * mu_vol * (1.0f + (1.0f - 0.5f * mat.mg_gamma0) * mu_vol)) / (denom * denom);
                            p_comp = std::max(0.0f, p_hugoniot + mat.mg_gamma0 * mat.density * p.e_int);
                        } else {
                            const float E_mod_d  = mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f;
                            const float nu_d     = std::clamp(mat.poissons_ratio, 0.01f, 0.49f);
                            const float K_parent = E_mod_d / (3.0f * (1.0f - 2.0f * nu_d));
                            p_comp = K_parent * (1.0f - J) / std::max(0.01f, J);
                        }
                    }
                    for (int r = 0; r < 3; ++r)
                        for (int c = 0; c < 3; ++c)
                            p.sigma[r][c] = (r == c) ? -p_comp : 0.0f;

                    continue;
                }
            }

            continue;
        }


        // Jaumann objective stress rotation: sig_base = sig + (W*sig - sig*W)*dt
        float W_sig[3][3] = {}, sig_W[3][3] = {};
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                for (int k = 0; k < 3; ++k) {
                    W_sig[r][c] += W[r][k] * p.sigma[k][c];
                    sig_W[r][c] += p.sigma[r][k] * W[k][c];
                }

        float sig_base[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                sig_base[r][c] = p.sigma[r][c] + (W_sig[r][c] - sig_W[r][c]) * dt;

        // Lame constants
        const float E_mod  = mat.youngs_modulus;
        const float nu     = mat.poissons_ratio;
        const float mu     = E_mod / (2.0f * (1.0f + nu));
        const float lambda = (E_mod * nu) / ((1.0f + nu) * (1.0f - 2.0f * nu));
        const float K_bulk = E_mod / (3.0f * (1.0f - 2.0f * nu));

        // Trial elastic stress update
        float sig_trial[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c) {
                sig_trial[r][c] = sig_base[r][c] + 2.0f * mu * deps[r][c];
                if (r == c) sig_trial[r][c] += lambda * tr_deps;
            }

        // Deviatoric stress and pressure
        float press = -(sig_trial[0][0] + sig_trial[1][1] + sig_trial[2][2]) / 3.0f;
        float s[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c) {
                s[r][c] = sig_trial[r][c];
                if (r == c) s[r][c] += press;
            }

        float char_len_p = std::cbrt(p.V > 1.0e-20f ? p.V : 1.0e-6f);
        float deps_norm = 0.0f;
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                deps_norm += deps[r][c] * deps[r][c];
        float ep_dot = std::sqrt((2.0f / 3.0f) * deps_norm) / (dt > 1.0e-12f ? dt : 1.0e-12f);

        if (mat.material_model == MPMMaterialModel::RHTConcrete) {
            RHTStateVariables<float> rht_state;
            rht_state.damage = p.damage;
            rht_state.ep_bar = p.ep_bar;
            rht_state.p_hydro = press;
            updateRHTStress<float>(
                s, press, tr_deps, dt, char_len_p, ep_dot,
                mat.fc, mat.ft, mu, K_bulk,
                mat.G_f, mat.moisture_content,
                mat.rht_A, mat.rht_N,
                mat.rht_B, mat.rht_M,
                mat.rht_Q0, mat.rht_BQ,
                mat.rht_D1, mat.rht_D2,
                mat.rht_p_crush, mat.rht_p_lock,
                mat.rht_alpha0, mat.rht_n_comp,
                mat.rht_betac, mat.rht_deltat,
                mat.dif_cap_compression, mat.dif_cap_tension,
                rht_state
            );
            p.damage = rht_state.damage;
            p.ep_bar = rht_state.ep_bar;
            press = rht_state.p_hydro;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c) {
                    p.sigma[r][c] = s[r][c];
                    if (r == c) p.sigma[r][c] -= press;
                }
        } else if (mat.material_model == MPMMaterialModel::KCConcrete) {
            KCStateVariables<float> kc_state;
            kc_state.damage = p.damage;
            kc_state.lambda = p.lambda;
            kc_state.ep_bar = p.ep_bar;
            kc_state.p_hydro = press;
            updateKCStress<float>(
                s, press, tr_deps, dt, char_len_p, ep_dot,
                mat.fc, mat.ft, mu, K_bulk,
                mat.G_f, mat.moisture_content,
                mat.kc_auto_generate,
                mat.kc_a0, mat.kc_a1, mat.kc_a2,
                mat.kc_a0y, mat.kc_a1y, mat.kc_a2y,
                mat.kc_a1r, mat.kc_a2r,
                mat.kc_b1, mat.kc_omega,
                mat.dif_cap_compression, mat.dif_cap_tension,
                kc_state
            );
            p.damage = kc_state.damage;
            p.lambda = kc_state.lambda;
            p.ep_bar = kc_state.ep_bar;
            press = kc_state.p_hydro;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c) {
                    p.sigma[r][c] = s[r][c];
                    if (r == c) p.sigma[r][c] -= press;
                }
        } else if (mat.material_model == MPMMaterialModel::CSCMConcrete) {
            CSCMStateVariables<float> cscm_state;
            cscm_state.damage = p.damage;
            cscm_state.kappa = p.lambda;
            cscm_state.ep_bar = p.ep_bar;
            cscm_state.p_hydro = press;
            updateCSCMStress<float>(
                s, press, tr_deps, dt, char_len_p, ep_dot,
                mat.fc, mat.ft, mu, K_bulk,
                mat.G_f,
                mat.cscm_alpha, mat.cscm_theta,
                mat.cscm_lambda, mat.cscm_beta,
                mat.cscm_R, mat.cscm_X0,
                mat.cscm_W, mat.cscm_D1,
                mat.cscm_D2,
                mat.dif_cap_compression, mat.dif_cap_tension,
                cscm_state
            );
            p.damage = cscm_state.damage;
            p.lambda = cscm_state.kappa;
            p.ep_bar = cscm_state.ep_bar;
            press = cscm_state.p_hydro;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c) {
                    p.sigma[r][c] = s[r][c];
                    if (r == c) p.sigma[r][c] -= press;
                }
        } else {
            // Default Hypoelastic J2 Elastoplasticity with Weibull flaw scatter & plastic damage softening
            float w_factor = (p.weibull_factor > 0.001f) ? p.weibull_factor : 1.0f;
            if (w_factor <= 0.001f && mat.weibull_modulus > 0.001f) {
                w_factor = computeWeibullFactor(p.x[0], p.x[1], p.x[2], mat.weibull_modulus, mat.weibull_scale);
            }
            const float yield_base = mat.yield_stress * w_factor;
            const float fail_strain_base = (mat.failure_strain > 0.0f) ? mat.failure_strain * w_factor : 0.0f;
            const float soft_factor = std::clamp(1.0f - 0.70f * p.damage, 0.10f, 1.0f);
            const float yield_eff = yield_base * soft_factor + mat.hardening_modulus * p.ep_bar;

            float s_s = 0.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_s += s[r][c] * s[r][c];
            const float q_trial   = std::sqrt(1.5f * s_s);
            const float yield_surf = q_trial - yield_eff;

            if (q_trial > 1.0e-5f && yield_surf > 0.0f) {
                // Radial return mapping
                const float delta_ep = yield_surf / (3.0f * mu + mat.hardening_modulus);
                float scale = 1.0f - (3.0f * mu * delta_ep) / q_trial;
                if (scale < 0.0f) scale = 0.0f;
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c) {
                        p.sigma[r][c] = scale * s[r][c];
                        if (r == c) p.sigma[r][c] -= press;
                    }
                p.ep_bar += delta_ep;
            } else {
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        p.sigma[r][c] = sig_trial[r][c];
            }

            float d_plastic = 0.0f;
            if (mat.enable_strain_erosion) {
                float fail_strain = (mat.erosion_strain > 0.0f) ? mat.erosion_strain : fail_strain_base;
                if (fail_strain > 0.0f) {
                    d_plastic = std::clamp(p.ep_bar / fail_strain, 0.0f, 1.0f);
                }
            }

            float d_tensile = 0.0f;
            if (mat.enable_stress_erosion) {
                float fail_stress = (mat.erosion_stress > 0.0f) ? mat.erosion_stress : mat.tensile_failure_stress;
                const float curr_press    = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
                const float tensile_stress = -curr_press;
                if (tensile_stress > 0.0f && fail_stress > 0.0f) {
                    d_tensile = std::clamp(tensile_stress / (fail_stress * w_factor), 0.0f, 1.0f);
                }
            }

            p.damage = std::max(p.damage, std::max(d_plastic, d_tensile));
        }

        if (p.damage >= 1.0f && (mat.enable_strain_erosion || mat.enable_stress_erosion)) {
            p.has_failed = true;
            p.damage = 1.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    p.B[r][c] = 0.0f;

            p.V = std::clamp(p.V * (1.0f + tr_deps), 0.1f * p.V0, 10.0f * p.V0);

            // Calculate compressive hydrostatic pressure from parent EOS for this step
            const float J = p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f);
            float p_comp = 0.0f;
            if (J < 1.0f) {
                if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen && mat.mg_c0 > 0.0f) {
                    const float mu_vol = (1.0f - J) / std::max(0.01f, J);
                    const float denom = std::max(0.1f, 1.0f - (mat.mg_s - 1.0f) * mu_vol);
                    const float p_hugoniot = (mat.density * mat.mg_c0 * mat.mg_c0 * mu_vol * (1.0f + (1.0f - 0.5f * mat.mg_gamma0) * mu_vol)) / (denom * denom);
                    p_comp = std::max(0.0f, p_hugoniot + mat.mg_gamma0 * mat.density * p.e_int);
                } else {
                    const float E_mod_d  = mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f;
                    const float nu_d     = std::clamp(mat.poissons_ratio, 0.01f, 0.49f);
                    const float K_parent = E_mod_d / (3.0f * (1.0f - 2.0f * nu_d));
                    p_comp = K_parent * (1.0f - J) / std::max(0.01f, J);
                }
            }

            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    p.sigma[r][c] = (r == c) ? -p_comp : 0.0f;

            continue;
        }

        // Volume update
        p.V = std::clamp(p.V * (1.0f + tr_deps), 0.1f * p.V0, 10.0f * p.V0);

    }
}

float MPMSolver3D::computeStepSize(float cfl) const {
    if (m_particles.empty()) return 1.0e-6f;
    float max_speed = 100.0f;
    for (const auto& p : m_particles) {
        if (std::isnan(p.v[0]) || std::isnan(p.v[1]) || std::isnan(p.v[2])) continue;
        const auto& mat = getMaterialTable(p.object_id);
        float E = mat.youngs_modulus;
        float rho = std::max(10.0f, mat.density);
        float nu = mat.poissons_ratio;
        float c_s = 0.0f;
        if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen) {
            float C0 = mat.mg_c0;
            c_s = std::sqrt(C0 * C0 + (2.0f / 3.0f) * E / (rho * (1.0f + nu)));
        } else if (mat.material_model == MPMMaterialModel::CRESTReactiveBurn) {
            float C0 = mat.davis_c0;
            float c_solid = std::sqrt(C0 * C0 + (2.0f / 3.0f) * E / (rho * (1.0f + nu)));
            float c_det = (mat.davis_pc > 1.0e6f) ? 7500.0f : 6000.0f;
            c_s = std::max(c_solid, c_det);
        } else if (mat.material_model == MPMMaterialModel::RHTConcrete || mat.material_model == MPMMaterialModel::KCConcrete || mat.material_model == MPMMaterialModel::CSCMConcrete) {
            float G = E / (2.0f * (1.0f + nu));
            float K = 1.6f * (E / (3.0f * std::max(0.02f, 1.0f - 2.0f * nu)));
            c_s = std::sqrt((K + 4.0f / 3.0f * G) / rho);
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
        float v_mag = std::sqrt(p.v[0] * p.v[0] + p.v[1] * p.v[1] + p.v[2] * p.v[2]);
        v_mag = std::min(5000.0f, v_mag);
        float total_speed = c_s + v_mag;
        if (total_speed > max_speed) max_speed = total_speed;
    }
    float min_h = std::min({m_dx, m_dy, m_dz});
    float dt_crit = min_h / max_speed;
    float stability_factor = 1.0f / std::sqrt(3.0f); // 3D Courant stability factor (~0.577)
    return std::max(1.0e-8f, cfl * stability_factor * dt_crit);
}

void MPMSolver3D::stepWithDt(float dt, bool run_p2g) {
    if (m_particles.empty()) return;
    m_last_dt = dt;
    m_sim_time += static_cast<double>(dt);
    m_step_count++;

    if (m_time_scheme == MPMTimeIntegrationScheme::RK2) {
        // --- 2nd-Order Midpoint RK2 Scheme ---
        // 1. Predictor Stage (Half-step dt/2)
        if (run_p2g) {
            for (auto& node : m_grid) {
                node.f_ext[0] = 0.0f; node.f_ext[1] = 0.0f; node.f_ext[2] = 0.0f;
            }
            particleToGrid();
        }
        updateGridKinematics(0.5f * dt);
        gridToParticle(0.5f * dt);
        updateStressState(0.5f * dt);

        // 2. Corrector Stage: full step from t^{n+1/2} state to t^{n+1}
        // Grid kinematics uses full dt for acceleration; particles advance by dt/2
        // (midpoint rule: position updated once at dt/2 in predictor, once at dt/2 here).
        particleToGrid();
        updateGridKinematics(dt);
        gridToParticle(dt * 0.5f);
        updateStressState(dt * 0.5f);
    } else {
        // --- 1st-Order USL / USF ---
        if (run_p2g) {
            for (auto& node : m_grid) {
                node.f_ext[0] = 0.0f; node.f_ext[1] = 0.0f; node.f_ext[2] = 0.0f;
            }
            particleToGrid();
        }
        
        if (m_time_scheme == MPMTimeIntegrationScheme::USF) {
            // USF: Update Stress First
            // In USF, stress is updated using the kinematics from the previous step/initial grid scatter
            updateGridKinematics(dt);
            gridToParticle(dt);
            updateStressState(dt);
        } else {
            // USL: Update Stress Last (default)
            updateGridKinematics(dt);
            gridToParticle(dt);
            updateStressState(dt);
        }
    }
}

void MPMSolver3D::step(float cfl) {
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

MPMVTKSnapshot3D MPMSolver3D::extractVTKSnapshot(bool has_vel, bool has_stress, bool has_strain, bool has_damage, bool has_temp) const {
    MPMVTKSnapshot3D snap;
    size_t count = m_particles.size();
    snap.num_particles = static_cast<int>(count);
    snap.has_vel = has_vel;
    snap.has_stress = has_stress;
    snap.has_strain = has_strain;
    snap.has_damage = has_damage;
    snap.has_temp = has_temp;

    if (count == 0) return snap;

    snap.points.resize(count * 3);
    if (has_vel) snap.vel.resize(count * 3);
    if (has_stress) { snap.von_mises.resize(count); snap.pressure.resize(count); }
    if (has_strain) snap.ep_bar.resize(count);
    if (has_damage) snap.damage.resize(count);
    if (has_temp) snap.temp.resize(count);
    snap.obj_id.resize(count);

    #pragma omp parallel for schedule(static)
    for (size_t i = 0; i < count; ++i) {
        const auto& p = m_particles[i];
        snap.points[i * 3 + 0] = static_cast<float>(p.x[0]);
        snap.points[i * 3 + 1] = static_cast<float>(p.x[1]);
        snap.points[i * 3 + 2] = static_cast<float>(p.x[2]);

        if (has_vel) {
            snap.vel[i * 3 + 0] = static_cast<float>(p.v[0]);
            snap.vel[i * 3 + 1] = static_cast<float>(p.v[1]);
            snap.vel[i * 3 + 2] = static_cast<float>(p.v[2]);
        }
        if (has_stress) {
            double mean_s = (p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0;
            double s00 = p.sigma[0][0] - mean_s;
            double s11 = p.sigma[1][1] - mean_s;
            double s22 = p.sigma[2][2] - mean_s;
            double s01 = p.sigma[0][1];
            double s12 = p.sigma[1][2];
            double s20 = p.sigma[2][0];
            snap.von_mises[i] = static_cast<float>(std::sqrt(1.5 * (s00*s00 + s11*s11 + s22*s22 + 2.0*(s01*s01 + s12*s12 + s20*s20))));
            snap.pressure[i] = static_cast<float>(-mean_s);
        }
        if (has_strain) snap.ep_bar[i] = static_cast<float>(p.ep_bar);
        if (has_damage) snap.damage[i] = static_cast<float>(p.damage);
        if (has_temp) snap.temp[i] = static_cast<float>(p.temperature);
        snap.obj_id[i] = static_cast<float>(p.object_id);
    }
    return snap;
}

} // namespace Blast
