#include "mpm_solver_3d.hpp"
#include "ImmersedBoundary.hpp"

namespace Blast {

static inline uint32_t floatToBits(float f) {
    uint32_t u;
    std::memcpy(&u, &f, sizeof(float));
    return u;
}

static inline float computeWeibullFactor(float x, float y, float z, float V0, float weibull_modulus, float weibull_scale, float weibull_ref_volume = 1.0e-6f) {
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
    float u = std::clamp(static_cast<float>(seed & 0xFFFFu) / 65535.0f, 0.001f, 0.999f);
    float m_w = weibull_modulus;
    float eta_w = (weibull_scale > 0.001f) ? weibull_scale : 1.0f;
    float gamma_mean = std::tgamma(1.0f + 1.0f / m_w);

    // Physically-consistent Weibull volume scaling: (V_ref / V0)^(1 / m_w)
    float v_ref = (weibull_ref_volume > 1.0e-18f) ? weibull_ref_volume : 1.0e-6f;
    float v_eff = (V0 > 1.0e-18f) ? V0 : v_ref;
    float size_scale = std::pow(v_ref / v_eff, 1.0f / m_w);

    float w = (std::pow(-std::log(1.0f - u), 1.0f / m_w) / gamma_mean) * eta_w * size_scale;
    return std::clamp(w, 0.10f, 3.0f);
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

    if (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen) {
        size_t num_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
        m_mat_fields.resize(m_num_materials);
        for (int m = 0; m < m_num_materials; ++m) {
            m_mat_fields[m].m.assign(num_nodes, 0.0f);
            for (int c = 0; c < 3; ++c) {
                m_mat_fields[m].p[c].assign(num_nodes, 0.0f);
                m_mat_fields[m].f_int[c].assign(num_nodes, 0.0f);
                m_mat_fields[m].v[c].assign(num_nodes, 0.0f);
                m_mat_fields[m].dv[c].assign(num_nodes, 0.0f);
            }
        }
    } else {
        m_mat_fields.clear();
    }
}

void MPMSolver3D::setContactMethod(MPMContactMethod method) {
    m_contact_method = method;
    if (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen) {
        size_t num_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
        if (num_nodes > 0) {
            m_mat_fields.resize(m_num_materials);
            for (int m = 0; m < m_num_materials; ++m) {
                m_mat_fields[m].m.assign(num_nodes, 0.0f);
                for (int c = 0; c < 3; ++c) {
                    m_mat_fields[m].p[c].assign(num_nodes, 0.0f);
                    m_mat_fields[m].f_int[c].assign(num_nodes, 0.0f);
                    m_mat_fields[m].v[c].assign(num_nodes, 0.0f);
                    m_mat_fields[m].dv[c].assign(num_nodes, 0.0f);
                }
            }
        }
    } else {
        m_mat_fields.clear();
    }
}

void MPMSolver3D::setObjectMaterialMapping(const std::vector<int>& obj_to_mat, int num_materials) {
    m_object_to_mat = obj_to_mat;
    m_num_materials = std::max(1, num_materials);

    for (auto& p : m_particles) {
        if (p.object_id >= 0 && p.object_id < static_cast<int>(m_object_to_mat.size())) {
            p.material_id = m_object_to_mat[p.object_id];
        } else if (p.object_id > 0 && (p.object_id - 1) < static_cast<int>(m_object_to_mat.size())) {
            p.material_id = m_object_to_mat[p.object_id - 1];
        } else {
            p.material_id = 0;
        }
    }

    m_mat_to_obj.assign(m_num_materials, 0);
    for (int m = 0; m < m_num_materials; ++m) {
        m_mat_to_obj[m] = std::max(1, m + 1);
    }
    for (size_t oi = 1; oi < m_object_to_mat.size(); ++oi) {
        int m = m_object_to_mat[oi];
        if (m >= 0 && m < m_num_materials) {
            m_mat_to_obj[m] = static_cast<int>(oi);
        }
    }

    if (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen) {
        size_t num_nodes = static_cast<size_t>(m_nx) * m_ny * m_nz;
        m_mat_fields.resize(m_num_materials);
        for (int m = 0; m < m_num_materials; ++m) {
            m_mat_fields[m].m.assign(num_nodes, 0.0f);
            for (int c = 0; c < 3; ++c) {
                m_mat_fields[m].p[c].assign(num_nodes, 0.0f);
                m_mat_fields[m].f_int[c].assign(num_nodes, 0.0f);
                m_mat_fields[m].v[c].assign(num_nodes, 0.0f);
                m_mat_fields[m].dv[c].assign(num_nodes, 0.0f);
            }
        }
    } else {
        m_mat_fields.clear();
    }
}

void MPMSolver3D::setDomainGeometry(float dx, float dy, float dz, float xmin, float ymin, float zmin) {
    m_dx = dx;
    m_dy = dy;
    m_dz = dz;
    m_xmin = xmin;
    m_ymin = ymin;
    m_zmin = zmin;
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
                               MPMBoundaryFilling boundary_fill,
                               float rot_x, float rot_y, float rot_z) {
    (void)boundary_fill;
    int particles_per_dim = static_cast<int>(std::round(std::cbrt(static_cast<float>(ppc))));
    if (particles_per_dim < 1) particles_per_dim = 1;

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

                float rx = x - pos_x;
                float ry = y - pos_y;
                float rz = z - pos_z;

                Point3D r_rot = rotate_point_euler(rx, ry, rz, rot_x, rot_y, rot_z);
                float final_x = pos_x + r_rot.x;
                float final_y = pos_y + r_rot.y;
                float final_z = pos_z + r_rot.z;
                p.x[0] = final_x; p.x[1] = final_y; p.x[2] = final_z;

                p.v[0] = vel_x + (angular_vel_y * r_rot.z - angular_vel_z * r_rot.y);
                p.v[1] = vel_y + (angular_vel_z * r_rot.x - angular_vel_x * r_rot.z);
                p.v[2] = vel_z + (angular_vel_x * r_rot.y - angular_vel_y * r_rot.x);

                p.B[0][0] = 0.0f;             p.B[0][1] = -angular_vel_z; p.B[0][2] =  angular_vel_y;
                p.B[1][0] =  angular_vel_z;   p.B[1][1] = 0.0f;           p.B[1][2] = -angular_vel_x;
                p.B[2][0] = -angular_vel_y;   p.B[2][1] =  angular_vel_x; p.B[2][2] = 0.0f;

                p.lp[0] = 0.5f * p_dx;
                p.lp[1] = 0.5f * p_dy;
                p.lp[2] = 0.5f * p_dz;

                p.m = p_mass;
                p.V0 = p_vol;
                p.V = p_vol;
                p.contact_radius = 0.5f * std::cbrt(std::max(1.0e-18f, p_vol));

                p.damage = 0.0f;
                p.has_failed = false;

                p.sigma.zero();

                p.ep_bar = 0.0f;
                p.object_id = obj_id;
                p.transfer_scheme = mat.transfer_scheme;
                if (mat.enable_heterogeneity && mat.weibull_modulus > 0.001f) {
                    p.weibull_factor = computeWeibullFactor(final_x, final_y, final_z, p.V0, mat.weibull_modulus, mat.weibull_scale, mat.weibull_ref_volume);
                } else {
                    p.weibull_factor = 1.0f;
                }

                m_particles.push_back(p);
            }
        }
    }
    seedMottGradyFragments(obj_id);
}

void MPMSolver3D::addSphereObject(int obj_id, float pos_x, float pos_y, float pos_z, float radius,
                                  float vel_x, float vel_y, float vel_z,
                                  float angular_vel_x, float angular_vel_y, float angular_vel_z,
                                  float density, float E, float nu,
                                  float yield_stress, float hardening, float failure_strain,
                                  float tensile_failure_stress, int ppc,
                                  MPMParticleDistribution particle_dist,
                                  MPMBoundaryFilling boundary_fill,
                                  float rot_x, float rot_y, float rot_z) {
    int particles_per_dim = static_cast<int>(std::round(std::cbrt(static_cast<float>(ppc))));
    if (particles_per_dim < 1) particles_per_dim = 1;

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

                float rx = final_x - pos_x;
                float ry = final_y - pos_y;
                float rz = final_z - pos_z;

                Point3D r_rot = rotate_point_euler(rx, ry, rz, rot_x, rot_y, rot_z);
                p.x[0] = pos_x + r_rot.x;
                p.x[1] = pos_y + r_rot.y;
                p.x[2] = pos_z + r_rot.z;

                p.v[0] = vel_x + (angular_vel_y * r_rot.z - angular_vel_z * r_rot.y);
                p.v[1] = vel_y + (angular_vel_z * r_rot.x - angular_vel_x * r_rot.z);
                p.v[2] = vel_z + (angular_vel_x * r_rot.y - angular_vel_y * r_rot.x);

                p.B[0][0] = 0.0f;             p.B[0][1] = -angular_vel_z; p.B[0][2] =  angular_vel_y;
                p.B[1][0] =  angular_vel_z;   p.B[1][1] = 0.0f;           p.B[1][2] = -angular_vel_x;
                p.B[2][0] = -angular_vel_y;   p.B[2][1] =  angular_vel_x; p.B[2][2] = 0.0f;

                p.lp[0] = 0.5f * p_dx;
                p.lp[1] = 0.5f * p_dy;
                p.lp[2] = 0.5f * p_dz;

                p.m = p_mass;
                p.V0 = p_vol;
                p.V = p_vol;
                p.contact_radius = 0.5f * std::cbrt(p_vol > 1.0e-20f ? p_vol : nominal_vol);

                p.damage = 0.0f;
                p.has_failed = false;

                p.sigma.zero();

                p.ep_bar = 0.0f;
                p.object_id = obj_id;
                p.transfer_scheme = mat.transfer_scheme;
                if (mat.enable_heterogeneity && mat.weibull_modulus > 0.001f) {
                    p.weibull_factor = computeWeibullFactor(final_x, final_y, final_z, p.V0, mat.weibull_modulus, mat.weibull_scale, mat.weibull_ref_volume);
                } else {
                    p.weibull_factor = 1.0f;
                }

                m_particles.push_back(p);
            }
        }
    }
    seedMottGradyFragments(obj_id);
}

void MPMSolver3D::addCylinderObject(int obj_id, float pos_x, float pos_y, float pos_z,
                                      float radius, float inner_radius, float height,
                                      float vel_x, float vel_y, float vel_z,
                                      float angular_vel_x, float angular_vel_y, float angular_vel_z,
                                      float density, float E, float nu,
                                      float yield_stress, float hardening, float failure_strain,
                                      float tensile_failure_stress, int ppc,
                                      MPMParticleDistribution particle_dist,
                                      MPMBoundaryFilling boundary_fill,
                                      float rot_x, float rot_y, float rot_z) {
    int particles_per_dim = static_cast<int>(std::round(std::cbrt(static_cast<float>(ppc))));
    if (particles_per_dim < 1) particles_per_dim = 1;

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

                float rx = final_x - pos_x;
                float ry = final_y - pos_y;
                float rz = final_z - pos_z;

                Point3D r_rot = rotate_point_euler(rx, ry, rz, rot_x, rot_y, rot_z);
                p.x[0] = pos_x + r_rot.x;
                p.x[1] = pos_y + r_rot.y;
                p.x[2] = pos_z + r_rot.z;

                p.v[0] = vel_x + (angular_vel_y * r_rot.z - angular_vel_z * r_rot.y);
                p.v[1] = vel_y + (angular_vel_z * r_rot.x - angular_vel_x * r_rot.z);
                p.v[2] = vel_z + (angular_vel_x * r_rot.y - angular_vel_y * r_rot.x);

                p.B[0][0] = 0.0f;             p.B[0][1] = -angular_vel_z; p.B[0][2] =  angular_vel_y;
                p.B[1][0] =  angular_vel_z;   p.B[1][1] = 0.0f;           p.B[1][2] = -angular_vel_x;
                p.B[2][0] = -angular_vel_y;   p.B[2][1] =  angular_vel_x; p.B[2][2] = 0.0f;

                p.lp[0] = 0.5f * p_dx;
                p.lp[1] = 0.5f * p_dy;
                p.lp[2] = 0.5f * p_dz;

                p.m = p_mass;
                p.V0 = p_vol;
                p.V = p_vol;
                p.contact_radius = 0.5f * std::cbrt(p_vol > 1.0e-20f ? p_vol : nominal_vol);

                p.damage = 0.0f;
                p.has_failed = false;

                p.sigma.zero();

                p.ep_bar = 0.0f;
                p.object_id = obj_id;
                p.transfer_scheme = mat.transfer_scheme;
                if (mat.enable_heterogeneity && mat.weibull_modulus > 0.001f) {
                    p.weibull_factor = computeWeibullFactor(p.x[0], p.x[1], p.x[2], p.V0, mat.weibull_modulus, mat.weibull_scale, mat.weibull_ref_volume);
                } else {
                    p.weibull_factor = 1.0f;
                }

                m_particles.push_back(p);
            }
        }
    }
    seedMottGradyFragments(obj_id);
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
                              MPMBoundaryFilling boundary_fill,
                              const std::string& voxelization_method,
                              float rot_x, float rot_y, float rot_z,
                              const std::string& origin_mode) {
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

    std::vector<Triangle> triangles = transform_triangles(
        raw_triangles, scale_x, scale_y, scale_z,
        pos_x, pos_y, pos_z,
        rot_x, rot_y, rot_z,
        origin_mode
    );

    float min_x = 1.0e30f, max_x = -1.0e30f;
    float min_y = 1.0e30f, max_y = -1.0e30f;
    float min_z = 1.0e30f, max_z = -1.0e30f;

    for (auto& tri : triangles) {
        min_x = std::min({min_x, tri.v0.x, tri.v1.x, tri.v2.x});
        max_x = std::max({max_x, tri.v0.x, tri.v1.x, tri.v2.x});
        min_y = std::min({min_y, tri.v0.y, tri.v1.y, tri.v2.y});
        max_y = std::max({max_y, tri.v0.y, tri.v1.y, tri.v2.y});
        min_z = std::min({min_z, tri.v0.z, tri.v1.z, tri.v2.z});
        max_z = std::max({max_z, tri.v0.z, tri.v1.z, tri.v2.z});
    }

    float final_center_x = 0.5f * (min_x + max_x);
    float final_center_y = 0.5f * (min_y + max_y);
    float final_center_z = 0.5f * (min_z + max_z);

    int particles_per_dim = static_cast<int>(std::round(std::cbrt(static_cast<float>(ppc))));
    if (particles_per_dim < 1) particles_per_dim = 1;

    float p_spacing = m_dx / static_cast<float>(particles_per_dim);
    float p_dx = p_spacing;
    float p_dy = (particle_dist == MPMParticleDistribution::Hexagonal) ? (std::sqrt(3.0f) * 0.5f * p_spacing) : (m_dy / static_cast<float>(particles_per_dim));
    float p_dz = (particle_dist == MPMParticleDistribution::Hexagonal) ? (std::sqrt(2.0f / 3.0f) * p_spacing) : (m_dz / static_cast<float>(particles_per_dim));

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
    }

    std::cout << "[INFO] MPMSolver3D::addSTLObject loaded " << triangles.size() << " triangles. Sampling interior particles using method: "
              << voxelization_method << "..." << std::endl;
    size_t particle_count_before = m_particles.size();

    auto createParticle = [&](float x, float y, float z) -> MPMParticle3D {
        MPMParticle3D p{};
        p.x[0] = x; p.x[1] = y; p.x[2] = z;

        float rx = x - final_center_x;
        float ry = y - final_center_y;
        float rz = z - final_center_z;

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
        p.contact_radius = 0.5f * std::cbrt(std::max(1.0e-18f, p_vol));

        p.damage = 0.0f;
        p.has_failed = false;

        p.sigma.zero();

        p.ep_bar = 0.0f;
        p.object_id = obj_id;
        const auto& mat_tbl = getMaterialTable(obj_id);
        p.transfer_scheme = mat_tbl.transfer_scheme;
        if (mat_tbl.enable_heterogeneity && mat_tbl.weibull_modulus > 0.001f) {
            p.weibull_factor = computeWeibullFactor(x, y, z, p.V0, mat_tbl.weibull_modulus, mat_tbl.weibull_scale, mat_tbl.weibull_ref_volume);
        } else {
            p.weibull_factor = 1.0f;
        }
        return p;
    };

    if (voxelization_method == "winding_number") {
        int nz_steps = std::max(1, static_cast<int>(std::ceil((max_z - min_z) / p_dz)));
        int ny_steps = std::max(1, static_cast<int>(std::ceil((max_y - min_y) / p_dy)));

        std::vector<MPMParticle3D> new_particles;
        #pragma omp parallel
        {
            std::vector<MPMParticle3D> local_particles;
            #pragma omp for schedule(dynamic)
            for (int layer_k = 0; layer_k < nz_steps; ++layer_k) {
                float z = min_z + (layer_k + 0.5f) * p_dz;
                if (z >= max_z) continue;
                bool is_layer_b = (particle_dist == MPMParticleDistribution::Hexagonal && (layer_k % 2 == 1));
                float y_layer_offset = is_layer_b ? (p_spacing / (2.0f * std::sqrt(3.0f))) : 0.0f;

                for (int row_j = 0; row_j < ny_steps; ++row_j) {
                    float y = min_y + (row_j + 0.5f) * p_dy + y_layer_offset;
                    if (y >= max_y) continue;
                    float x_offset = 0.0f;
                    if (particle_dist == MPMParticleDistribution::Hexagonal) {
                        x_offset = ((row_j + (is_layer_b ? 1 : 0)) % 2 == 1) ? (0.5f * p_spacing) : 0.0f;
                    }

                    for (float x = min_x + 0.5f * p_dx + x_offset; x < max_x; x += p_dx) {
                        Point3D P = { x, y, z };
                        float sum_solid_angle = 0.0f;
                        for (const auto& tri : triangles) {
                            sum_solid_angle += signed_solid_angle(P, tri.v0, tri.v1, tri.v2);
                        }
                        float w = sum_solid_angle / (4.0f * static_cast<float>(M_PI));
                        if (std::abs(w) > 0.5f) {
                            local_particles.push_back(createParticle(x, y, z));
                        }
                    }
                }
            }
            #pragma omp critical
            {
                new_particles.insert(new_particles.end(), local_particles.begin(), local_particles.end());
            }
        }
        m_particles.insert(m_particles.end(), new_particles.begin(), new_particles.end());
    } else {
        // Hardened 1D Ray-Casting: 3x3 halo candidate lookup, epsilon clustering, secondary perturbed ray fallback, and paired interval clamping
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

        int nz_steps = std::max(1, static_cast<int>(std::ceil((max_z - min_z) / p_dz)));
        int ny_steps = std::max(1, static_cast<int>(std::ceil((max_y - min_y) / p_dy)));

        std::vector<MPMParticle3D> new_particles;
        #pragma omp parallel
        {
            std::vector<MPMParticle3D> local_particles;
            #pragma omp for schedule(dynamic)
            for (int layer_k = 0; layer_k < nz_steps; ++layer_k) {
                float z = min_z + (layer_k + 0.5f) * p_dz;
                if (z >= max_z) continue;
                bool is_layer_b = (particle_dist == MPMParticleDistribution::Hexagonal && (layer_k % 2 == 1));
                float y_layer_offset = is_layer_b ? (p_spacing / (2.0f * std::sqrt(3.0f))) : 0.0f;

                for (int row_j = 0; row_j < ny_steps; ++row_j) {
                    float y = min_y + (row_j + 0.5f) * p_dy + y_layer_offset;
                    if (y >= max_y) continue;
                    float x_offset = 0.0f;
                    if (particle_dist == MPMParticleDistribution::Hexagonal) {
                        x_offset = ((row_j + (is_layer_b ? 1 : 0)) % 2 == 1) ? (0.5f * p_spacing) : 0.0f;
                    }

                    int by = std::clamp(static_cast<int>(std::floor((y - min_y) / p_dy)), 0, ny_bins - 1);
                    int bz = std::clamp(static_cast<int>(std::floor((z - min_z) / p_dz)), 0, nz_bins - 1);

                    // Collect candidates from a 3x3 halo neighborhood around (by, bz) to prevent missing boundary triangles
                    std::vector<int> candidate_indices;
                    int by_start = std::max(0, by - 1);
                    int by_end = std::min(ny_bins - 1, by + 1);
                    int bz_start = std::max(0, bz - 1);
                    int bz_end = std::min(nz_bins - 1, bz + 1);

                    for (int cbz = bz_start; cbz <= bz_end; ++cbz) {
                        for (int cby = by_start; cby <= by_end; ++cby) {
                            const auto& bin_tris = yz_bins[cby + cbz * ny_bins];
                            candidate_indices.insert(candidate_indices.end(), bin_tris.begin(), bin_tris.end());
                        }
                    }

                    if (candidate_indices.empty()) continue;
                    std::sort(candidate_indices.begin(), candidate_indices.end());
                    candidate_indices.erase(std::unique(candidate_indices.begin(), candidate_indices.end()), candidate_indices.end());

                    auto traceRay = [&](float y_pos, float z_pos, std::vector<float>& out_intersects) {
                        out_intersects.clear();
                        Point3D O = { min_x - 1.0f * p_dx, y_pos, z_pos };
                        Point3D D = { 1.0f, 0.0f, 0.0f };
                        for (int idx : candidate_indices) {
                            const auto& tri = triangles[idx];
                            float t;
                            if (ray_triangle_intersect(O, D, tri.v0, tri.v1, tri.v2, t)) {
                                if (t >= 0.0f) {
                                    out_intersects.push_back(O.x + t);
                                }
                            }
                        }
                        if (out_intersects.empty()) return;
                        std::sort(out_intersects.begin(), out_intersects.end());

                        // Epsilon clustering to merge near-duplicate hits from shared edges and vertices
                        std::vector<float> clustered;
                        const float eps_merge = std::max(1e-3f * p_dx, 1e-5f);
                        for (float xi : out_intersects) {
                            if (clustered.empty() || (xi - clustered.back() > eps_merge)) {
                                clustered.push_back(xi);
                            }
                        }
                        out_intersects = std::move(clustered);
                    };

                    float y_ray = y + 1.234e-4f * p_dy;
                    float z_ray = z + 5.678e-4f * p_dz;
                    std::vector<float> intersects;
                    traceRay(y_ray, z_ray, intersects);

                    // If parity is odd (leaking ray), try multi-angle perturbed rays to resolve edge/vertex degeneracy
                    if (intersects.size() % 2 != 0) {
                        const float perturb_offsets[4][2] = {
                            { -0.05f * p_dy,  0.03f * p_dz },
                            {  0.07f * p_dy, -0.04f * p_dz },
                            { -0.03f * p_dy, -0.06f * p_dz },
                            {  0.06f * p_dy,  0.07f * p_dz }
                        };
                        for (int off_i = 0; off_i < 4; ++off_i) {
                            std::vector<float> alt_intersects;
                            traceRay(y + perturb_offsets[off_i][0], z + perturb_offsets[off_i][1], alt_intersects);
                            if (!alt_intersects.empty() && alt_intersects.size() % 2 == 0) {
                                intersects = std::move(alt_intersects);
                                break;
                            }
                        }
                    }

                    if (intersects.empty()) continue;

                    // Paired interval evaluation: strictly tests inside intervals [x_2k, x_{2k+1}].
                    // Any trailing unpaired intersection from non-watertight openings is clamped out,
                    // guaranteeing particles NEVER leak beyond the outermost surface intersection (zero streams).
                    size_t num_pairs = intersects.size() / 2;
                    for (float x = min_x + 0.5f * p_dx + x_offset; x < max_x; x += p_dx) {
                        bool inside = false;
                        for (size_t p_idx = 0; p_idx < num_pairs; ++p_idx) {
                            float x_entry = intersects[2 * p_idx];
                            float x_exit  = intersects[2 * p_idx + 1];
                            if (x >= x_entry && x <= x_exit) {
                                inside = true;
                                break;
                            }
                        }
                        if (inside) {
                            local_particles.push_back(createParticle(x, y, z));
                        }
                    }
                }
            }
            #pragma omp critical
            {
                new_particles.insert(new_particles.end(), local_particles.begin(), local_particles.end());
            }
        }
        m_particles.insert(m_particles.end(), new_particles.begin(), new_particles.end());
    }
    seedMottGradyFragments(obj_id);
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

    if (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen) {
        size_t num_nodes = m_grid.size();
        if (m_mat_fields.size() != static_cast<size_t>(m_num_materials) ||
            (!m_mat_fields.empty() && m_mat_fields[0].m.size() != num_nodes)) {
            m_mat_fields.resize(m_num_materials);
            for (int m = 0; m < m_num_materials; ++m) {
                m_mat_fields[m].m.assign(num_nodes, 0.0f);
                for (int c = 0; c < 3; ++c) {
                    m_mat_fields[m].p[c].assign(num_nodes, 0.0f);
                    m_mat_fields[m].f_int[c].assign(num_nodes, 0.0f);
                    m_mat_fields[m].v[c].assign(num_nodes, 0.0f);
                    m_mat_fields[m].dv[c].assign(num_nodes, 0.0f);
                }
            }
        } else {
            for (int m = 0; m < m_num_materials; ++m) {
                std::fill(m_mat_fields[m].m.begin(), m_mat_fields[m].m.end(), 0.0f);
                for (int c = 0; c < 3; ++c) {
                    std::fill(m_mat_fields[m].p[c].begin(), m_mat_fields[m].p[c].end(), 0.0f);
                    std::fill(m_mat_fields[m].f_int[c].begin(), m_mat_fields[m].f_int[c].end(), 0.0f);
                    std::fill(m_mat_fields[m].v[c].begin(), m_mat_fields[m].v[c].end(), 0.0f);
                    std::fill(m_mat_fields[m].dv[c].begin(), m_mat_fields[m].dv[c].end(), 0.0f);
                }
            }
        }
    }

    // P2G Scatter in 3D
    for (const auto& p : m_particles) {
        if (p.state == 2 || p.m <= 0.0f) continue;
        int p_mat_id = std::clamp(p.material_id, 0, std::max(0, m_num_materials - 1));
        bool is_multi_mat = (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen && !m_mat_fields.empty());
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

            // Pass 1: Local partition of unity sum, centroid displacement, and 2nd-moment tensor via Parallel-Axis Theorem
            float local_w_sum = 0.0f;
            float sum_wx = 0.0f, sum_wy = 0.0f, sum_wz = 0.0f;
            float sum_wxx = 0.0f, sum_wxy = 0.0f, sum_wxz = 0.0f;
            float sum_wyy = 0.0f, sum_wyz = 0.0f, sum_wzz = 0.0f;

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
                        sum_wx += w * dist_x;
                        sum_wy += w * dist_y;
                        sum_wz += w * dist_z;

                        sum_wxx += w * dist_x * dist_x;
                        sum_wxy += w * dist_x * dist_y;
                        sum_wxz += w * dist_x * dist_z;
                        sum_wyy += w * dist_y * dist_y;
                        sum_wyz += w * dist_y * dist_z;
                        sum_wzz += w * dist_z * dist_z;
                    }
                }
            }

            if (local_w_sum <= 1.0e-7f) continue;
            float inv_w_sum = 1.0f / local_w_sum;
            float delta_x = sum_wx * inv_w_sum;
            float delta_y = sum_wy * inv_w_sum;
            float delta_z = sum_wz * inv_w_sum;
            float xc = px + delta_x;
            float yc = py + delta_y;
            float zc = pz + delta_z;

            // Parallel-Axis Moment Tensor: D = sum(w * (x - xc)(x - xc)^T) / w_sum
            //                                = sum(w * (x - p)(x - p)^T) / w_sum - delta * delta^T
            float D[3][3];
            D[0][0] = sum_wxx * inv_w_sum - delta_x * delta_x;
            D[0][1] = sum_wxy * inv_w_sum - delta_x * delta_y;
            D[0][2] = sum_wxz * inv_w_sum - delta_x * delta_z;
            D[1][0] = D[0][1];
            D[1][1] = sum_wyy * inv_w_sum - delta_y * delta_y;
            D[1][2] = sum_wyz * inv_w_sum - delta_y * delta_z;
            D[2][0] = D[0][2];
            D[2][1] = D[1][2];
            D[2][2] = sum_wzz * inv_w_sum - delta_z * delta_z;

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
                        float f_stress_x = - p.V * weight * (s_Dinv[0][0] * dc_x + s_Dinv[0][1] * dc_y + s_Dinv[0][2] * dc_z);
                        float f_stress_y = - p.V * weight * (s_Dinv[1][0] * dc_x + s_Dinv[1][1] * dc_y + s_Dinv[1][2] * dc_z);
                        float f_stress_z = - p.V * weight * (s_Dinv[2][0] * dc_x + s_Dinv[2][1] * dc_y + s_Dinv[2][2] * dc_z);

                        node.f_int[0] += f_stress_x;
                        node.f_int[1] += f_stress_y;
                        node.f_int[2] += f_stress_z;

                        node.plastic_strain += p.m * weight * p.ep_bar;

                        if (is_multi_mat) {
                            auto& mf = m_mat_fields[p_mat_id];
                            mf.m[node_idx] += p.m * weight;
                            mf.p[0][node_idx] += p.m * weight * v_apic_x;
                            mf.p[1][node_idx] += p.m * weight * v_apic_y;
                            mf.p[2][node_idx] += p.m * weight * v_apic_z;
                            mf.f_int[0][node_idx] += f_stress_x;
                            mf.f_int[1][node_idx] += f_stress_y;
                            mf.f_int[2][node_idx] += f_stress_z;
                        }
                    }
                }
            }
        } else if (eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) {
            float Sx_arr[5], dSx_arr[5], Sy_arr[5], dSy_arr[5], Sz_arr[5], dSz_arr[5];
            for (int offset = -2; offset <= 2; ++offset) {
                int idx = offset + 2;
                float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * m_dx;
                Sx_arr[idx] = evalCubicBSpline_S(px, nx_val, m_dx);
                dSx_arr[idx] = evalCubicBSpline_dS(px, nx_val, m_dx);

                float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * m_dy;
                Sy_arr[idx] = evalCubicBSpline_S(py, ny_val, m_dy);
                dSy_arr[idx] = evalCubicBSpline_dS(py, ny_val, m_dy);

                float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * m_dz;
                Sz_arr[idx] = evalCubicBSpline_S(pz, nz_val, m_dz);
                dSz_arr[idx] = evalCubicBSpline_dS(pz, nz_val, m_dz);
            }

            for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= m_nx) continue;
                int i_idx = offset_i + 2;
                float Sx = Sx_arr[i_idx];
                if (std::abs(Sx) < 1.0e-7f) continue;
                float dSx = dSx_arr[i_idx];
                float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= m_ny) continue;
                    int j_idx = offset_j + 2;
                    float Sy = Sy_arr[j_idx];
                    if (std::abs(Sy) < 1.0e-7f) continue;
                    float dSy = dSy_arr[j_idx];
                    float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                    for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                        int k = base_k + offset_k;
                        if (k < 0 || k >= m_nz) continue;
                        int k_idx = offset_k + 2;
                        float Sz = Sz_arr[k_idx];
                        if (std::abs(Sz) < 1.0e-7f) continue;
                        float dSz = dSz_arr[k_idx];
                        float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

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
                        float f_stress_x = - p.V * (p.sigma[0][0] * dN_dx + p.sigma[0][1] * dN_dy + p.sigma[0][2] * dN_dz);
                        float f_stress_y = - p.V * (p.sigma[1][0] * dN_dx + p.sigma[1][1] * dN_dy + p.sigma[1][2] * dN_dz);
                        float f_stress_z = - p.V * (p.sigma[2][0] * dN_dx + p.sigma[2][1] * dN_dy + p.sigma[2][2] * dN_dz);

                        node.f_int[0] += f_stress_x;
                        node.f_int[1] += f_stress_y;
                        node.f_int[2] += f_stress_z;

                        // Telemetry scalar scatter
                        node.plastic_strain += p.m * weight * p.ep_bar;

                        if (is_multi_mat) {
                            auto& mf = m_mat_fields[p_mat_id];
                            mf.m[node_idx] += p.m * weight;
                            mf.p[0][node_idx] += p.m * weight * v_apic_x;
                            mf.p[1][node_idx] += p.m * weight * v_apic_y;
                            mf.p[2][node_idx] += p.m * weight * v_apic_z;
                            mf.f_int[0][node_idx] += f_stress_x;
                            mf.f_int[1][node_idx] += f_stress_y;
                            mf.f_int[2][node_idx] += f_stress_z;
                        }
                    }
                }
            }
        } else {
            float Sx_arr[4], dSx_arr[4], Sy_arr[4], dSy_arr[4], Sz_arr[4], dSz_arr[4];
            if (eff_scheme == static_cast<int>(MPMTransferScheme::GIMP)) {
                for (int offset = -1; offset <= 2; ++offset) {
                    int idx = offset + 1;
                    float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * m_dx;
                    Sx_arr[idx] = evalGIMP_S(px, nx_val, m_dx, p.lp[0]);
                    dSx_arr[idx] = evalGIMP_dS(px, nx_val, m_dx, p.lp[0]);

                    float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * m_dy;
                    Sy_arr[idx] = evalGIMP_S(py, ny_val, m_dy, p.lp[1]);
                    dSy_arr[idx] = evalGIMP_dS(py, ny_val, m_dy, p.lp[1]);

                    float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * m_dz;
                    Sz_arr[idx] = evalGIMP_S(pz, nz_val, m_dz, p.lp[2]);
                    dSz_arr[idx] = evalGIMP_dS(pz, nz_val, m_dz, p.lp[2]);
                }
            } else if (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline)) {
                for (int offset = -1; offset <= 2; ++offset) {
                    int idx = offset + 1;
                    float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * m_dx;
                    Sx_arr[idx] = evalBSpline_S(px, nx_val, m_dx);
                    dSx_arr[idx] = evalBSpline_dS(px, nx_val, m_dx);

                    float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * m_dy;
                    Sy_arr[idx] = evalBSpline_S(py, ny_val, m_dy);
                    dSy_arr[idx] = evalBSpline_dS(py, ny_val, m_dy);

                    float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * m_dz;
                    Sz_arr[idx] = evalBSpline_S(pz, nz_val, m_dz);
                    dSz_arr[idx] = evalBSpline_dS(pz, nz_val, m_dz);
                }
            } else {
                for (int offset = -1; offset <= 2; ++offset) {
                    int idx = offset + 1;
                    float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * m_dx;
                    Sx_arr[idx] = std::max(0.0f, 1.0f - std::abs(px - nx_val) / m_dx);
                    dSx_arr[idx] = (px >= nx_val ? -1.0f / m_dx : 1.0f / m_dx);

                    float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * m_dy;
                    Sy_arr[idx] = std::max(0.0f, 1.0f - std::abs(py - ny_val) / m_dy);
                    dSy_arr[idx] = (py >= ny_val ? -1.0f / m_dy : 1.0f / m_dy);

                    float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * m_dz;
                    Sz_arr[idx] = std::max(0.0f, 1.0f - std::abs(pz - nz_val) / m_dz);
                    dSz_arr[idx] = (pz >= nz_val ? -1.0f / m_dz : 1.0f / m_dz);
                }
            }

            for (int offset_i = -1; offset_i <= 2; ++offset_i) {
                int i = base_i + offset_i;
                if (i < 0 || i >= m_nx) continue;
                int i_idx = offset_i + 1;
                float Sx = Sx_arr[i_idx];
                if (std::abs(Sx) < 1.0e-7f) continue;
                float dSx = dSx_arr[i_idx];
                float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

                for (int offset_j = -1; offset_j <= 2; ++offset_j) {
                    int j = base_j + offset_j;
                    if (j < 0 || j >= m_ny) continue;
                    int j_idx = offset_j + 1;
                    float Sy = Sy_arr[j_idx];
                    if (std::abs(Sy) < 1.0e-7f) continue;
                    float dSy = dSy_arr[j_idx];
                    float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                    for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                        int k = base_k + offset_k;
                        if (k < 0 || k >= m_nz) continue;
                        int k_idx = offset_k + 1;
                        float Sz = Sz_arr[k_idx];
                        if (std::abs(Sz) < 1.0e-7f) continue;
                        float dSz = dSz_arr[k_idx];
                        float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

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
                        float f_stress_x = - p.V * (p.sigma[0][0] * dN_dx + p.sigma[0][1] * dN_dy + p.sigma[0][2] * dN_dz);
                        float f_stress_y = - p.V * (p.sigma[1][0] * dN_dx + p.sigma[1][1] * dN_dy + p.sigma[1][2] * dN_dz);
                        float f_stress_z = - p.V * (p.sigma[2][0] * dN_dx + p.sigma[2][1] * dN_dy + p.sigma[2][2] * dN_dz);

                        node.f_int[0] += f_stress_x;
                        node.f_int[1] += f_stress_y;
                        node.f_int[2] += f_stress_z;

                        // Telemetry scalar scatter
                        node.plastic_strain += p.m * weight * p.ep_bar;

                        if (is_multi_mat) {
                            auto& mf = m_mat_fields[p_mat_id];
                            mf.m[node_idx] += p.m * weight;
                            mf.p[0][node_idx] += p.m * weight * v_apic_x;
                            mf.p[1][node_idx] += p.m * weight * v_apic_y;
                            mf.p[2][node_idx] += p.m * weight * v_apic_z;
                            mf.f_int[0][node_idx] += f_stress_x;
                            mf.f_int[1][node_idx] += f_stress_y;
                            mf.f_int[2][node_idx] += f_stress_z;
                        }
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

    #pragma omp parallel for collapse(2) schedule(static)
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

void MPMSolver3D::updateGridKinematicsBardenhagen(float dt) {
    if (m_num_materials <= 0 || m_mat_fields.empty()) {
        updateGridKinematics(dt);
        return;
    }

    float avg_p_mass = 0.001f;
    if (!m_particles.empty()) avg_p_mass = m_particles[0].m;

    #pragma omp parallel for collapse(2) schedule(static)
    for (int i = 0; i < m_nx; ++i) {
        for (int j = 0; j < m_ny; ++j) {
            for (int k = 0; k < m_nz; ++k) {
                size_t node_idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                auto& node = m_grid[node_idx];

                // 1. Unconstrained acceleration for each material field
                float m_cm = 0.0f;
                float p_cm[3] = {0.0f, 0.0f, 0.0f};
                int active_count = 0;                for (int m = 0; m < m_num_materials; ++m) {
                    auto& mf = m_mat_fields[m];
                    float mat_mass = mf.m[node_idx];
                    if (mat_mass > MPMGridNode3D::MIN_MASS) {
                        active_count++;
                        m_cm += mat_mass;

                        // Cache pre-update velocity v_old in dv
                        float inv_m = 1.0f / mat_mass;
                        mf.dv[0][node_idx] = mf.p[0][node_idx] * inv_m;
                        mf.dv[1][node_idx] = mf.p[1][node_idx] * inv_m;
                        mf.dv[2][node_idx] = mf.p[2][node_idx] * inv_m;

                        // Include external force apportioned by mass
                        float f_ext_x = (node.m > MPMGridNode3D::MIN_MASS) ? (node.f_ext[0] * (mat_mass / node.m)) : 0.0f;
                        float f_ext_y = (node.m > MPMGridNode3D::MIN_MASS) ? (node.f_ext[1] * (mat_mass / node.m)) : 0.0f;
                        float f_ext_z = (node.m > MPMGridNode3D::MIN_MASS) ? (node.f_ext[2] * (mat_mass / node.m)) : 0.0f;

                        mf.p[0][node_idx] += dt * (mf.f_int[0][node_idx] + f_ext_x);
                        mf.p[1][node_idx] += dt * (mf.f_int[1][node_idx] + f_ext_y);
                        mf.p[2][node_idx] += dt * (mf.f_int[2][node_idx] + f_ext_z);

                        p_cm[0] += mf.p[0][node_idx];
                        p_cm[1] += mf.p[1][node_idx];
                        p_cm[2] += mf.p[2][node_idx];
                    }
                }

                if (active_count == 0 || m_cm <= MPMGridNode3D::MIN_MASS) {
                    node.p[0] = 0.0f; node.p[1] = 0.0f; node.p[2] = 0.0f;
                    continue;
                }

                float inv_m_cm = 1.0f / m_cm;
                float v_cm[3] = {p_cm[0] * inv_m_cm, p_cm[1] * inv_m_cm, p_cm[2] * inv_m_cm};

                // Helper to apply boundary conditions
                auto applyBC = [&](float& vx, float& vy, float& vz) {
                    if ((i <= 3 && m_bc_x_min == MPMBoundaryCondition3D::Sticky) ||
                        (i >= m_nx - 4 && m_bc_x_max == MPMBoundaryCondition3D::Sticky)) {
                        vx = 0.0f; vy = 0.0f; vz = 0.0f;
                    } else if ((i <= 3 && (m_bc_x_min == MPMBoundaryCondition3D::FreeSlip || m_bc_x_min == MPMBoundaryCondition3D::Reflecting)) ||
                               (i >= m_nx - 4 && (m_bc_x_max == MPMBoundaryCondition3D::FreeSlip || m_bc_x_max == MPMBoundaryCondition3D::Reflecting))) {
                        vx = 0.0f;
                    }

                    if ((j <= 3 && m_bc_y_min == MPMBoundaryCondition3D::Sticky) ||
                        (j >= m_ny - 4 && m_bc_y_max == MPMBoundaryCondition3D::Sticky)) {
                        vx = 0.0f; vy = 0.0f; vz = 0.0f;
                    } else if ((j <= 3 && (m_bc_y_min == MPMBoundaryCondition3D::FreeSlip || m_bc_y_min == MPMBoundaryCondition3D::Reflecting)) ||
                               (j >= m_ny - 4 && (m_bc_y_max == MPMBoundaryCondition3D::FreeSlip || m_bc_y_max == MPMBoundaryCondition3D::Reflecting))) {
                        vy = 0.0f;
                    }

                    if ((k <= 3 && m_bc_z_min == MPMBoundaryCondition3D::Sticky) ||
                        (k >= m_nz - 4 && m_bc_z_max == MPMBoundaryCondition3D::Sticky)) {
                        vx = 0.0f; vy = 0.0f; vz = 0.0f;
                    } else if ((k <= 3 && (m_bc_z_min == MPMBoundaryCondition3D::FreeSlip || m_bc_z_min == MPMBoundaryCondition3D::Reflecting)) ||
                               (k >= m_nz - 4 && (m_bc_z_max == MPMBoundaryCondition3D::FreeSlip || m_bc_z_max == MPMBoundaryCondition3D::Reflecting))) {
                        vz = 0.0f;
                    }
                };

                // Identify materials with physical mass presence on this node
                int sig_count = 0;
                float sig_threshold = 1.0e-11f;

                for (int m = 0; m < m_num_materials; ++m) {
                    auto& mf = m_mat_fields[m];
                    float mat_mass = mf.m[node_idx];
                    if (mat_mass > sig_threshold) {
                        sig_count++;
                    }
                }

                if (sig_count <= 1) {
                    for (int m = 0; m < m_num_materials; ++m) {
                        auto& mf = m_mat_fields[m];
                        float mat_mass = mf.m[node_idx];
                        if (mat_mass > MPMGridNode3D::MIN_MASS) {
                            float inv_m = 1.0f / mat_mass;
                            float vx = mf.p[0][node_idx] * inv_m;
                            float vy = mf.p[1][node_idx] * inv_m;
                            float vz = mf.p[2][node_idx] * inv_m;
                            applyBC(vx, vy, vz);
                            mf.v[0][node_idx] = vx;
                            mf.v[1][node_idx] = vy;
                            mf.v[2][node_idx] = vz;
                            mf.dv[0][node_idx] = vx - mf.dv[0][node_idx];
                            mf.dv[1][node_idx] = vy - mf.dv[1][node_idx];
                            mf.dv[2][node_idx] = vz - mf.dv[2][node_idx];
                        } else {
                            mf.v[0][node_idx] = 0.0f;
                            mf.v[1][node_idx] = 0.0f;
                            mf.v[2][node_idx] = 0.0f;
                            mf.dv[0][node_idx] = 0.0f;
                            mf.dv[1][node_idx] = 0.0f;
                            mf.dv[2][node_idx] = 0.0f;
                        }
                    }
                    float p0 = p_cm[0], p1 = p_cm[1], p2 = p_cm[2];
                    applyBC(p0, p1, p2);
                    node.p[0] = p0; node.p[1] = p1; node.p[2] = p2;
                    continue;
                }

                // On-the-fly 2nd-order finite difference normals (evaluated strictly on multi-material interface cells)
                float inv_2dx = 0.5f / m_dx;
                float inv_2dy = 0.5f / m_dy;
                float inv_2dz = 0.5f / m_dz;
                float G_norm_total[3] = {0.0f, 0.0f, 0.0f};

                size_t idx_ip = (i + 1 < m_nx) ? ((static_cast<size_t>(i + 1) * m_ny + j) * m_nz + k) : node_idx;
                size_t idx_im = (i > 0)        ? ((static_cast<size_t>(i - 1) * m_ny + j) * m_nz + k) : node_idx;
                size_t idx_jp = (j + 1 < m_ny) ? ((static_cast<size_t>(i) * m_ny + (j + 1)) * m_nz + k) : node_idx;
                size_t idx_jm = (j > 0)        ? ((static_cast<size_t>(i) * m_ny + (j - 1)) * m_nz + k) : node_idx;
                size_t idx_kp = (k + 1 < m_nz) ? ((static_cast<size_t>(i) * m_ny + j) * m_nz + (k + 1)) : node_idx;
                size_t idx_km = (k > 0)        ? ((static_cast<size_t>(i) * m_ny + j) * m_nz + (k - 1)) : node_idx;

                for (int m = 0; m < m_num_materials; ++m) {
                    auto& mf = m_mat_fields[m];
                    float mat_mass = mf.m[node_idx];
                    if (mat_mass > sig_threshold) {
                        float gm_x = (mf.m[idx_im] - mf.m[idx_ip]) * inv_2dx;
                        float gm_y = (mf.m[idx_jm] - mf.m[idx_jp]) * inv_2dy;
                        float gm_z = (mf.m[idx_km] - mf.m[idx_kp]) * inv_2dz;

                        float inv_mat_mass = 1.0f / mat_mass;
                        G_norm_total[0] += gm_x * inv_mat_mass;
                        G_norm_total[1] += gm_y * inv_mat_mass;
                        G_norm_total[2] += gm_z * inv_mat_mass;
                    }
                }

                float mu = m_dem_friction;
                float rest = std::clamp(m_dem_restitution, 0.0f, 1.0f);
                float grad_thresh = 0.05f / std::max(m_dx, 1.0e-4f);

                for (int m = 0; m < m_num_materials; ++m) {
                    auto& mf = m_mat_fields[m];
                    float mat_mass = mf.m[node_idx];
                    if (mat_mass <= MPMGridNode3D::MIN_MASS) {
                        mf.v[0][node_idx] = 0.0f;
                        mf.v[1][node_idx] = 0.0f;
                        mf.v[2][node_idx] = 0.0f;
                        mf.dv[0][node_idx] = 0.0f;
                        mf.dv[1][node_idx] = 0.0f;
                        mf.dv[2][node_idx] = 0.0f;
                        continue;
                    }

                    // Fluid/gas materials experience zero Coulomb friction along boundaries
                    bool is_fluid_mat = false;
                    float eff_friction = mu;
                    int obj_id = (m < static_cast<int>(m_mat_to_obj.size())) ? m_mat_to_obj[m] : (m + 1);
                    if (obj_id < static_cast<int>(m_material_tables.size())) {
                        auto m_model = m_material_tables[obj_id].material_model;
                        if (m_model == MPMMaterialModel::CRESTReactiveBurn ||
                            m_model == MPMMaterialModel::JWLProgrammedBurn ||
                            m_model == MPMMaterialModel::LeeTarverIgnitionGrowth) {
                            eff_friction = 0.0f;
                            is_fluid_mat = true;
                        }
                    }

                    float inv_m = 1.0f / mat_mass;
                    float v_star[3] = {mf.p[0][node_idx] * inv_m,
                                       mf.p[1][node_idx] * inv_m,
                                       mf.p[2][node_idx] * inv_m};

                    float v_corr[3] = {v_star[0], v_star[1], v_star[2]};

                    if (mat_mass >= sig_threshold) {
                        float gm_x = (mf.m[idx_im] - mf.m[idx_ip]) * inv_2dx;
                        float gm_y = (mf.m[idx_jm] - mf.m[idx_jp]) * inv_2dy;
                        float gm_z = (mf.m[idx_km] - mf.m[idx_kp]) * inv_2dz;

                        float inv_mat_mass = 1.0f / mat_mass;
                        float g_hat[3] = {
                            gm_x * inv_mat_mass,
                            gm_y * inv_mat_mass,
                            gm_z * inv_mat_mass
                        };
                        float inv_other = 1.0f / static_cast<float>(sig_count - 1);
                        float factor_self = static_cast<float>(sig_count) * inv_other;
                        float G_m[3] = {
                            factor_self * g_hat[0] - inv_other * G_norm_total[0],
                            factor_self * g_hat[1] - inv_other * G_norm_total[1],
                            factor_self * g_hat[2] - inv_other * G_norm_total[2]
                        };
                        float g_len = std::sqrt(G_m[0] * G_m[0] + G_m[1] * G_m[1] + G_m[2] * G_m[2]);

                        if (g_len > grad_thresh) {
                            float inv_g = 1.0f / g_len;
                            float n[3] = {G_m[0] * inv_g, G_m[1] * inv_g, G_m[2] * inv_g};

                            float v_rel[3] = {v_star[0] - v_cm[0],
                                              v_star[1] - v_cm[1],
                                              v_star[2] - v_cm[2]};
                            float v_approach = v_rel[0] * n[0] + v_rel[1] * n[1] + v_rel[2] * n[2];

                            if (v_approach > 0.0f) {
                                float v_cm_n = v_cm[0] * n[0] + v_cm[1] * n[1] + v_cm[2] * n[2];
                                float v_norm = v_cm_n - rest * v_approach;

                                float v_star_n = v_star[0] * n[0] + v_star[1] * n[1] + v_star[2] * n[2];
                                float v_tang[3] = {v_star[0] - v_star_n * n[0],
                                                   v_star[1] - v_star_n * n[1],
                                                   v_star[2] - v_star_n * n[2]};
                                float v_cm_tang[3] = {v_cm[0] - v_cm_n * n[0],
                                                      v_cm[1] - v_cm_n * n[1],
                                                      v_cm[2] - v_cm_n * n[2]};

                                float v_slip[3] = {v_tang[0] - v_cm_tang[0],
                                                   v_tang[1] - v_cm_tang[1],
                                                   v_tang[2] - v_cm_tang[2]};
                                float slip_speed = std::sqrt(v_slip[0] * v_slip[0] + v_slip[1] * v_slip[1] + v_slip[2] * v_slip[2]);

                                float max_friction_dv = eff_friction * v_approach;
                                float v_tang_corr[3];
                                if (slip_speed <= max_friction_dv || slip_speed < 1.0e-7f) {
                                    v_tang_corr[0] = v_cm_tang[0];
                                    v_tang_corr[1] = v_cm_tang[1];
                                    v_tang_corr[2] = v_cm_tang[2];
                                } else {
                                    float factor = (eff_friction > 0.0f) ? (1.0f - max_friction_dv / slip_speed) : 1.0f;
                                    v_tang_corr[0] = v_cm_tang[0] + factor * v_slip[0];
                                    v_tang_corr[1] = v_cm_tang[1] + factor * v_slip[1];
                                    v_tang_corr[2] = v_cm_tang[2] + factor * v_slip[2];
                                }

                                v_corr[0] = v_norm * n[0] + v_tang_corr[0];
                                v_corr[1] = v_norm * n[1] + v_tang_corr[1];
                                v_corr[2] = v_norm * n[2] + v_tang_corr[2];
                            }
                        } else {
                            v_corr[0] = v_cm[0];
                            v_corr[1] = v_cm[1];
                            v_corr[2] = v_cm[2];
                        }
                    }

                    applyBC(v_corr[0], v_corr[1], v_corr[2]);

                    mf.v[0][node_idx] = v_corr[0];
                    mf.v[1][node_idx] = v_corr[1];
                    mf.v[2][node_idx] = v_corr[2];
                    mf.dv[0][node_idx] = v_corr[0] - mf.dv[0][node_idx];
                    mf.dv[1][node_idx] = v_corr[1] - mf.dv[1][node_idx];
                    mf.dv[2][node_idx] = v_corr[2] - mf.dv[2][node_idx];
                }

                float p0 = p_cm[0], p1 = p_cm[1], p2 = p_cm[2];
                applyBC(p0, p1, p2);
                node.p[0] = p0;
                node.p[1] = p1;
                node.p[2] = p2;
            }
        }
    }
}

MPMSolver3D::MPMGatheredKinematics3D MPMSolver3D::gatherParticleKinematics(const MPMParticle3D& p, float dt) const {
    MPMGatheredKinematics3D kin;
    int p_mat = std::clamp(p.material_id, 0, std::max(0, m_num_materials - 1));
    bool is_multi_mat = (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen && !m_mat_fields.empty());
    float px = p.x[0] - m_xmin;
    float py = p.x[1] - m_ymin;
    float pz = p.x[2] - m_zmin;

    int base_i = static_cast<int>(std::floor(px / m_dx));
    int base_j = static_cast<int>(std::floor(py / m_dy));
    int base_k = static_cast<int>(std::floor(pz / m_dz));

    float v_pic_x = 0.0f; float v_pic_y = 0.0f; float v_pic_z = 0.0f;
    float delta_v_grid_x = 0.0f; float delta_v_grid_y = 0.0f; float delta_v_grid_z = 0.0f;
    float weight_sum = 0.0f;

    int eff_scheme = (p.transfer_scheme >= 0) ? p.transfer_scheme : static_cast<int>(m_transfer_scheme);
    if (eff_scheme == static_cast<int>(MPMTransferScheme::RadialMLS)) {
        float R_supp = 2.0f * std::max({m_dx, m_dy, m_dz});

        float local_w_sum = 0.0f;
        float sum_wx = 0.0f, sum_wy = 0.0f, sum_wz = 0.0f;
        float sum_wxx = 0.0f, sum_wxy = 0.0f, sum_wxz = 0.0f;
        float sum_wyy = 0.0f, sum_wyz = 0.0f, sum_wzz = 0.0f;

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
                    sum_wx += w * dist_x; sum_wy += w * dist_y; sum_wz += w * dist_z;
                    sum_wxx += w * dist_x * dist_x; sum_wxy += w * dist_x * dist_y; sum_wxz += w * dist_x * dist_z;
                    sum_wyy += w * dist_y * dist_y; sum_wyz += w * dist_y * dist_z; sum_wzz += w * dist_z * dist_z;
                }
            }
        }

        if (local_w_sum > 1.0e-7f) {
            float inv_w_sum = 1.0f / local_w_sum;
            float delta_x = sum_wx * inv_w_sum;
            float delta_y = sum_wy * inv_w_sum;
            float delta_z = sum_wz * inv_w_sum;
            float xc = px + delta_x;
            float yc = py + delta_y;
            float zc = pz + delta_z;

            float D[3][3];
            D[0][0] = sum_wxx * inv_w_sum - delta_x * delta_x;
            D[0][1] = sum_wxy * inv_w_sum - delta_x * delta_y;
            D[0][2] = sum_wxz * inv_w_sum - delta_x * delta_z;
            D[1][0] = D[0][1];
            D[1][1] = sum_wyy * inv_w_sum - delta_y * delta_y;
            D[1][2] = sum_wyz * inv_w_sum - delta_y * delta_z;
            D[2][0] = D[0][2];
            D[2][1] = D[1][2];
            D[2][2] = sum_wzz * inv_w_sum - delta_z * delta_z;

            float detD = D[0][0] * (D[1][1] * D[2][2] - D[1][2] * D[2][1]) -
                         D[0][1] * (D[1][0] * D[2][2] - D[1][2] * D[2][0]) +
                         D[0][2] * (D[1][0] * D[2][1] - D[1][1] * D[2][0]);

            float D_inv[3][3] = {{0,0,0},{0,0,0},{0,0,0}};
            if (std::abs(detD) > 1.0e-14f) {
                float invDet = 1.0f / detD;
                D_inv[0][0] =  (D[1][1] * D[2][2] - D[1][2] * D[2][1]) * invDet;
                D_inv[0][1] = -(D[0][1] * D[2][2] - D[0][2] * D[2][1]) * invDet;
                D_inv[0][2] =  (D[0][1] * D[1][2] - D[0][2] * D[1][1]) * invDet;
                D_inv[1][0] = -(D[1][0] * D[2][2] - D[1][2] * D[2][0]) * invDet;
                D_inv[1][1] =  (D[0][0] * D[2][2] - D[0][2] * D[2][0]) * invDet;
                D_inv[1][2] = -(D[0][0] * D[1][2] - D[0][2] * D[1][0]) * invDet;
                D_inv[2][0] =  (D[1][0] * D[2][1] - D[1][1] * D[2][0]) * invDet;
                D_inv[2][1] = -(D[0][0] * D[2][1] - D[0][1] * D[2][0]) * invDet;
                D_inv[2][2] =  (D[0][0] * D[1][1] - D[0][1] * D[1][0]) * invDet;
            } else {
                float h2 = (m_dx * m_dx + m_dy * m_dy + m_dz * m_dz) / 3.0f;
                float inv_diag = 4.0f / (h2 > 1.0e-12f ? h2 : 1.0e-12f);
                D_inv[0][0] = inv_diag; D_inv[1][1] = inv_diag; D_inv[2][2] = inv_diag;
            }

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

                        float weight = evalWendland_C2(r, R_supp);
                        if (weight < 1.0e-7f) continue;

                        size_t node_idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                        const auto& node = m_grid[node_idx];

                        float n_vx = 0.0f, n_vy = 0.0f, n_vz = 0.0f;
                        float delta_vx = 0.0f, delta_vy = 0.0f, delta_vz = 0.0f;
                        bool node_valid = false;

                        if (is_multi_mat) {
                            if (m_mat_fields[p_mat].m[node_idx] > MPMGridNode3D::MIN_MASS) {
                                n_vx = m_mat_fields[p_mat].v[0][node_idx];
                                n_vy = m_mat_fields[p_mat].v[1][node_idx];
                                n_vz = m_mat_fields[p_mat].v[2][node_idx];
                                delta_vx = m_mat_fields[p_mat].dv[0][node_idx];
                                delta_vy = m_mat_fields[p_mat].dv[1][node_idx];
                                delta_vz = m_mat_fields[p_mat].dv[2][node_idx];
                                node_valid = true;
                            }
                        } else if (node.m > MPMGridNode3D::MIN_MASS) {
                            float inv_m = 1.0f / node.m;
                            n_vx = node.v(0);
                            n_vy = node.v(1);
                            n_vz = node.v(2);
                            delta_vx = dt * (node.f_ext[0] + node.f_int[0]) * inv_m;
                            delta_vy = dt * (node.f_ext[1] + node.f_int[1]) * inv_m;
                            delta_vz = dt * (node.f_ext[2] + node.f_int[2]) * inv_m;
                            node_valid = true;
                        }

                        if (node_valid) {
                            v_pic_x += weight * n_vx;
                            v_pic_y += weight * n_vy;
                            v_pic_z += weight * n_vz;

                            delta_v_grid_x += weight * delta_vx;
                            delta_v_grid_y += weight * delta_vy;
                            delta_v_grid_z += weight * delta_vz;

                            weight_sum += weight;

                            float dc_x = node_x - xc;
                            float dc_y = node_y - yc;
                            float dc_z = node_z - zc;

                            float d_dinv_x = D_inv[0][0] * dc_x + D_inv[0][1] * dc_y + D_inv[0][2] * dc_z;
                            float d_dinv_y = D_inv[1][0] * dc_x + D_inv[1][1] * dc_y + D_inv[1][2] * dc_z;
                            float d_dinv_z = D_inv[2][0] * dc_x + D_inv[2][1] * dc_y + D_inv[2][2] * dc_z;

                            kin.B_new[0][0] += weight * n_vx * d_dinv_x;
                            kin.B_new[0][1] += weight * n_vx * d_dinv_y;
                            kin.B_new[0][2] += weight * n_vx * d_dinv_z;

                            kin.B_new[1][0] += weight * n_vy * d_dinv_x;
                            kin.B_new[1][1] += weight * n_vy * d_dinv_y;
                            kin.B_new[1][2] += weight * n_vy * d_dinv_z;

                            kin.B_new[2][0] += weight * n_vz * d_dinv_x;
                            kin.B_new[2][1] += weight * n_vz * d_dinv_y;
                            kin.B_new[2][2] += weight * n_vz * d_dinv_z;

                            kin.L_new[0][0] += n_vx * weight * d_dinv_x;
                            kin.L_new[0][1] += n_vx * weight * d_dinv_y;
                            kin.L_new[0][2] += n_vx * weight * d_dinv_z;

                            kin.L_new[1][0] += n_vy * weight * d_dinv_x;
                            kin.L_new[1][1] += n_vy * weight * d_dinv_y;
                            kin.L_new[1][2] += n_vy * weight * d_dinv_z;

                            kin.L_new[2][0] += n_vz * weight * d_dinv_x;
                            kin.L_new[2][1] += n_vz * weight * d_dinv_y;
                            kin.L_new[2][2] += n_vz * weight * d_dinv_z;
                        }
                    }
                }
            }
        }
    } else {
        float d_scale = (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline) ||
                         eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) ? 4.0f : 3.0f;
        float D_inv_x = d_scale / (m_dx * m_dx);
        float D_inv_y = d_scale / (m_dy * m_dy);
        float D_inv_z = d_scale / (m_dz * m_dz);

        int min_offset = -1;
        int max_offset = 2;
        if (eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) {
            min_offset = -2;
            max_offset = 2;
        }

        float Sx_arr[5], dSx_arr[5], Sy_arr[5], dSy_arr[5], Sz_arr[5], dSz_arr[5];
        for (int offset = min_offset; offset <= max_offset; ++offset) {
            int idx = offset - min_offset;
            float nx = (static_cast<float>(base_i + offset) + 0.5f) * m_dx;
            if (eff_scheme == static_cast<int>(MPMTransferScheme::GIMP)) {
                Sx_arr[idx] = evalGIMP_S(px, nx, m_dx, p.lp[0]);
                dSx_arr[idx] = evalGIMP_dS(px, nx, m_dx, p.lp[0]);
            } else if (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline)) {
                Sx_arr[idx] = evalBSpline_S(px, nx, m_dx);
                dSx_arr[idx] = evalBSpline_dS(px, nx, m_dx);
            } else if (eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) {
                Sx_arr[idx] = evalCubicBSpline_S(px, nx, m_dx);
                dSx_arr[idx] = evalCubicBSpline_dS(px, nx, m_dx);
            } else {
                Sx_arr[idx] = std::max(0.0f, 1.0f - std::abs(px - nx) / m_dx);
                dSx_arr[idx] = (px >= nx ? -1.0f / m_dx : 1.0f / m_dx);
            }

            float ny = (static_cast<float>(base_j + offset) + 0.5f) * m_dy;
            if (eff_scheme == static_cast<int>(MPMTransferScheme::GIMP)) {
                Sy_arr[idx] = evalGIMP_S(py, ny, m_dy, p.lp[1]);
                dSy_arr[idx] = evalGIMP_dS(py, ny, m_dy, p.lp[1]);
            } else if (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline)) {
                Sy_arr[idx] = evalBSpline_S(py, ny, m_dy);
                dSy_arr[idx] = evalBSpline_dS(py, ny, m_dy);
            } else if (eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) {
                Sy_arr[idx] = evalCubicBSpline_S(py, ny, m_dy);
                dSy_arr[idx] = evalCubicBSpline_dS(py, ny, m_dy);
            } else {
                Sy_arr[idx] = std::max(0.0f, 1.0f - std::abs(py - ny) / m_dy);
                dSy_arr[idx] = (py >= ny ? -1.0f / m_dy : 1.0f / m_dy);
            }

            float nz = (static_cast<float>(base_k + offset) + 0.5f) * m_dz;
            if (eff_scheme == static_cast<int>(MPMTransferScheme::GIMP)) {
                Sz_arr[idx] = evalGIMP_S(pz, nz, m_dz, p.lp[2]);
                dSz_arr[idx] = evalGIMP_dS(pz, nz, m_dz, p.lp[2]);
            } else if (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline)) {
                Sz_arr[idx] = evalBSpline_S(pz, nz, m_dz);
                dSz_arr[idx] = evalBSpline_dS(pz, nz, m_dz);
            } else if (eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) {
                Sz_arr[idx] = evalCubicBSpline_S(pz, nz, m_dz);
                dSz_arr[idx] = evalCubicBSpline_dS(pz, nz, m_dz);
            } else {
                Sz_arr[idx] = std::max(0.0f, 1.0f - std::abs(pz - nz) / m_dz);
                dSz_arr[idx] = (pz >= nz ? -1.0f / m_dz : 1.0f / m_dz);
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

                for (int offset_k = min_offset; offset_k <= max_offset; ++offset_k) {
                    int k = base_k + offset_k;
                    if (k < 0 || k >= m_nz) continue;
                    int k_idx = offset_k - min_offset;
                    float Sz = Sz_arr[k_idx];
                    if (std::abs(Sz) < 1.0e-7f) continue;
                    float dSz = dSz_arr[k_idx];
                    float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

                    float weight = Sx * Sy * Sz;
                    float dN_dx = dSx * Sy * Sz;
                    float dN_dy = Sx * dSy * Sz;
                    float dN_dz = Sx * Sy * dSz;

                    size_t node_idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                    const auto& node = m_grid[node_idx];

                    if (node.m > MPMGridNode3D::MIN_MASS) {
                        float n_vx = 0.0f, n_vy = 0.0f, n_vz = 0.0f;
                        float delta_vx = 0.0f, delta_vy = 0.0f, delta_vz = 0.0f;
                        bool node_valid = false;

                        if (is_multi_mat) {
                            if (m_mat_fields[p_mat].m[node_idx] > MPMGridNode3D::MIN_MASS) {
                                n_vx = m_mat_fields[p_mat].v[0][node_idx];
                                n_vy = m_mat_fields[p_mat].v[1][node_idx];
                                n_vz = m_mat_fields[p_mat].v[2][node_idx];
                                delta_vx = m_mat_fields[p_mat].dv[0][node_idx];
                                delta_vy = m_mat_fields[p_mat].dv[1][node_idx];
                                delta_vz = m_mat_fields[p_mat].dv[2][node_idx];
                                node_valid = true;
                            }
                        } else if (node.m > MPMGridNode3D::MIN_MASS) {
                            float inv_m = 1.0f / node.m;
                            n_vx = node.v(0);
                            n_vy = node.v(1);
                            n_vz = node.v(2);
                            delta_vx = dt * (node.f_ext[0] + node.f_int[0]) * inv_m;
                            delta_vy = dt * (node.f_ext[1] + node.f_int[1]) * inv_m;
                            delta_vz = dt * (node.f_ext[2] + node.f_int[2]) * inv_m;
                            node_valid = true;
                        }

                        if (node_valid) {
                            v_pic_x += weight * n_vx;
                            v_pic_y += weight * n_vy;
                            v_pic_z += weight * n_vz;

                            delta_v_grid_x += weight * delta_vx;
                            delta_v_grid_y += weight * delta_vy;
                            delta_v_grid_z += weight * delta_vz;

                            weight_sum += weight;

                            float dist_x = node_x - px;
                            float dist_y = node_y - py;
                            float dist_z = node_z - pz;

                            float w_apic = 1.0f;
                            kin.B_new[0][0] += w_apic * weight * n_vx * dist_x * D_inv_x;
                            kin.B_new[0][1] += w_apic * weight * n_vx * dist_y * D_inv_y;
                            kin.B_new[0][2] += w_apic * weight * n_vx * dist_z * D_inv_z;

                            kin.B_new[1][0] += w_apic * weight * n_vy * dist_x * D_inv_x;
                            kin.B_new[1][1] += w_apic * weight * n_vy * dist_y * D_inv_y;
                            kin.B_new[1][2] += w_apic * weight * n_vy * dist_z * D_inv_z;

                            kin.B_new[2][0] += w_apic * weight * n_vz * dist_x * D_inv_x;
                            kin.B_new[2][1] += w_apic * weight * n_vz * dist_y * D_inv_y;
                            kin.B_new[2][2] += w_apic * weight * n_vz * dist_z * D_inv_z;

                            kin.L_new[0][0] += n_vx * dN_dx;
                            kin.L_new[0][1] += n_vx * dN_dy;
                            kin.L_new[0][2] += n_vx * dN_dz;

                            kin.L_new[1][0] += n_vy * dN_dx;
                            kin.L_new[1][1] += n_vy * dN_dy;
                            kin.L_new[1][2] += n_vy * dN_dz;

                            kin.L_new[2][0] += n_vz * dN_dx;
                            kin.L_new[2][1] += n_vz * dN_dy;
                            kin.L_new[2][2] += n_vz * dN_dz;
                        }
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

    const auto& mat = getMaterialTable(p.object_id);
    bool is_melted = (mat.T_melt > mat.T_room && p.temperature >= mat.T_melt);
    bool is_fluid_p = is_melted || (p.lambda >= 0.1f) ||
                      (mat.material_model == MPMMaterialModel::CRESTReactiveBurn) ||
                      (mat.material_model == MPMMaterialModel::JWLProgrammedBurn) ||
                      (mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);
    if (p.has_failed || p.damage >= 1.0f || is_fluid_p) {
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

    kin.target_v[0] = target_vx;
    kin.target_v[1] = target_vy;
    kin.target_v[2] = target_vz;
    return kin;
}

template <bool FUSE_STRESS>
void MPMSolver3D::gridToParticleInternal(float dt) {
    float max_B = 25000.0f / std::min({m_dx, m_dy, m_dz});
    float v_max_global = 0.0f;
    const size_t num_particles = m_particles.size();

    // Clean Single-Grid G2P Gather for all particles (Momentum-conserving continuum mechanics)
    #pragma omp parallel for reduction(max:v_max_global) schedule(dynamic, 64)
    for (size_t p_idx = 0; p_idx < num_particles; ++p_idx) {
        auto& p = m_particles[p_idx];
        if (p.state == 2 || p.m <= 0.0f) continue;
        const auto& mat = getMaterialTable(p.object_id);
        bool is_melted = (mat.T_melt > mat.T_room && p.temperature >= mat.T_melt);
        bool is_fluid_p = is_melted || (p.lambda >= 0.1f) ||
                          (mat.material_model == MPMMaterialModel::CRESTReactiveBurn) ||
                          (mat.material_model == MPMMaterialModel::JWLProgrammedBurn) ||
                          (mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);

        auto kin = gatherParticleKinematics(p, dt);
        p.v[0] = std::clamp(kin.target_v[0], -25000.0f, 25000.0f);
        p.v[1] = std::clamp(kin.target_v[1], -25000.0f, 25000.0f);
        p.v[2] = std::clamp(kin.target_v[2], -25000.0f, 25000.0f);

        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                p.B[r][c] = (!p.has_failed && !is_fluid_p && m_velocity_scheme == MPMVelocityScheme::APIC) ? std::clamp(kin.B_new[r][c], -max_B, max_B) : 0.0f;
                p.L_grad[r][c] = std::clamp(kin.L_new[r][c], -max_B, max_B);
            }
        }

        float p_speed = std::sqrt(p.v[0]*p.v[0] + p.v[1]*p.v[1] + p.v[2]*p.v[2]);
        if (p_speed > v_max_global) v_max_global = p_speed;

        // Update Particle Position
        p.x[0] += dt * p.v[0];
        p.x[1] += dt * p.v[1];
        p.x[2] += dt * p.v[2];

        // Domain Boundary Clamping at Physical Domain Boundaries (inside ghost padding)
        float phys_min_x = m_xmin + 3.0f * m_dx; float phys_max_x = m_xmin + (static_cast<float>(m_nx - 4)) * m_dx;
        float phys_min_y = m_ymin + 3.0f * m_dy; float phys_max_y = m_ymin + (static_cast<float>(m_ny - 4)) * m_dy;
        float phys_min_z = m_zmin + 3.0f * m_dz; float phys_max_z = m_zmin + (static_cast<float>(m_nz - 4)) * m_dz;

        bool terminated = false;
        if (p.x[0] < phys_min_x) {
            if (m_bc_x_min == MPMBoundaryCondition3D::Terminate) terminated = true;
            else { p.x[0] = phys_min_x; if (p.v[0] < 0.0f) { p.v[0] = 0.0f; } }
        } else if (p.x[0] > phys_max_x) {
            if (m_bc_x_max == MPMBoundaryCondition3D::Terminate) terminated = true;
            else { p.x[0] = phys_max_x; if (p.v[0] > 0.0f) { p.v[0] = 0.0f; } }
        }

        if (p.x[1] < phys_min_y) {
            if (m_bc_y_min == MPMBoundaryCondition3D::Terminate) terminated = true;
            else { p.x[1] = phys_min_y; if (p.v[1] < 0.0f) { p.v[1] = 0.0f; } }
        } else if (p.x[1] > phys_max_y) {
            if (m_bc_y_max == MPMBoundaryCondition3D::Terminate) terminated = true;
            else { p.x[1] = phys_max_y; if (p.v[1] > 0.0f) { p.v[1] = 0.0f; } }
        }

        if (p.x[2] < phys_min_z) {
            if (m_bc_z_min == MPMBoundaryCondition3D::Terminate) terminated = true;
            else { p.x[2] = phys_min_z; if (p.v[2] < 0.0f) { p.v[2] = 0.0f; } }
        } else if (p.x[2] > phys_max_z) {
            if (m_bc_z_max == MPMBoundaryCondition3D::Terminate) terminated = true;
            else { p.x[2] = phys_max_z; if (p.v[2] > 0.0f) { p.v[2] = 0.0f; } }
        }

        // Global domain escape check
        if (p.x[0] < m_xmin || p.x[0] >= m_xmin + m_nx * m_dx ||
            p.x[1] < m_ymin || p.x[1] >= m_ymin + m_ny * m_dy ||
            p.x[2] < m_zmin || p.x[2] >= m_zmin + m_nz * m_dz) {
            terminated = true;
        }

        if (terminated) {
            p.state = 2; // Inactive / Terminated
            p.m = 0.0f;
            p.v[0] = 0.0f; p.v[1] = 0.0f; p.v[2] = 0.0f;
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    p.B[r][c] = 0.0f;
                    p.L_grad[r][c] = 0.0f;
                    p.sigma[r][c] = 0.0f;
                }
            }
            continue;
        }

        if constexpr (FUSE_STRESS) {
            updateParticleStress(p, dt, p.L_grad, mat);
        }
    }
    m_last_v_max = v_max_global;

    // In-place zero-allocation compaction of terminated particles
    auto it = std::remove_if(m_particles.begin(), m_particles.end(), [](const MPMParticle3D& pt) {
        return pt.state == 2 || pt.m <= 0.0f;
    });
    if (it != m_particles.end()) {
        m_particles.erase(it, m_particles.end());
    }
}

void MPMSolver3D::gridToParticle(float dt) {
    gridToParticleInternal<false>(dt);
}

void MPMSolver3D::gridToParticleAndStress(float dt) {
    gridToParticleInternal<true>(dt);
}

void MPMSolver3D::updateParticleStress(MPMParticle3D& p, float dt, const float L[3][3], const MaterialTable3D& mat) {
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

            bool is_concrete_model = (mat.material_model == MPMMaterialModel::RHTConcrete ||
                                      mat.material_model == MPMMaterialModel::KCConcrete ||
                                      mat.material_model == MPMMaterialModel::CSCMConcrete);

            // For ductile metals, zero affine gradient. For concrete rubble, damp affine momentum to maintain chunk coherence.
            if (is_concrete_model) {
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        p.B[r][c] *= 0.85f;
            } else {
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        p.B[r][c] = 0.0f; // Zero affine velocity gradient to eliminate elastic tensile coupling
            }

            // 1. Bulk Pressure from Volumetric Compression J = V / V0 using Parent EOS
            const float J = p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f);
            float p_comp = 0.0f;

            float c_residual = 0.0f;
            float sigma_t_rubble = 0.0f;
            if (is_concrete_model) {
                // Aggregate interlocking and unbroken mortar cohesion with post-failure plastic strain softening
                float c0 = std::max(0.04f * mat.fc, 0.8e6f);
                float ep_debris = std::max(0.0f, p.ep_bar - 0.01f);
                c_residual = c0 * std::exp(-ep_debris / 0.08f);
                sigma_t_rubble = std::min(c_residual * 0.20f, 0.10f * mat.ft);
            }

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
            } else if (is_concrete_model && sigma_t_rubble > 0.0f) {
                // Softened tensile resistance for cohesive rubble chunks
                const float E_mod    = mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 30.0e9f;
                const float nu       = std::clamp(mat.poissons_ratio, 0.01f, 0.49f);
                const float K_parent = E_mod / (3.0f * (1.0f - 2.0f * nu));
                float p_unconfined   = K_parent * (1.0f - J) / std::max(0.01f, J);
                p_comp = std::max(p_unconfined, -sigma_t_rubble);
            }

            // 2. Frictional Shear Resistance under Confinement (Mohr-Coulomb / Drucker-Prager: q <= c_res + M * p_comp)
            // Hydrodynamic shear response for failed or melted metals: zero shear resistance (q_max = 0)
            float M_friction = 0.0f;
            if (is_concrete_model) {
                M_friction = 0.60f; // Concrete/rock aggregate friction
            } else if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen ||
                       mat.material_model == MPMMaterialModel::Hypoelastic ||
                       mat.material_model == MPMMaterialModel::LinearElastic) {
                M_friction = 0.0f; // Pure hydrodynamic fluid response for failed or melted metals
            }
            const float q_max = c_residual + M_friction * std::max(0.0f, p_comp);

            if (q_max <= 0.0f && std::abs(p_comp) <= 1.0e-5f) {
                p.sigma.setIsotropic(p_comp);
                return;
            }

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
                        s_trial[r][c] *= scale;
            }

            for (int r = 0; r < 3; ++r)
                s_trial[r][r] -= p_comp;
            p.sigma = s_trial;

            return;
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
                s_trial[r][r] -= p_hydro;
            p.sigma = s_trial;

            return;
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
                s_trial[r][r] -= p_mix;
            p.sigma = s_trial;

            return;
        }

        // --- JWL Programmed Wavefront Burn Model ---
        if (mat.material_model == MPMMaterialModel::JWLProgrammedBurn) {
            const float v_rel = std::clamp(p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f), 0.02f, 50.0f);
            float t_arr = p.t_arrival;
            float lam_curr = p.lambda;

            // Kinematic wavefront arrival
            float tau_burn = std::max(static_cast<float>(mat.burn_zone_cells) * 0.01f / std::max(mat.det_vel, 100.0f), mat.tau_burn_min);
            float lam_prog = JWL::computeProgrammedProgress(static_cast<float>(m_sim_time), t_arr, tau_burn);
            float lam_new = std::max(lam_curr, lam_prog);
            p.lambda = lam_new;
            float d_lam = std::max(0.0f, lam_new - lam_curr);

            // Two-phase EOS pressures
            float p_solid = JWL::computeSolidReactantPressure(v_rel, p.e_int, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mat.density);
            float p_prod  = JWL::computeJWLProductPressure(v_rel, p.e_int + mat.detonation_energy, mat.jwl_A, mat.jwl_B, mat.jwl_R1, mat.jwl_R2, mat.jwl_omega, mat.density);
            float p_mix   = (1.0f - lam_new) * p_solid + lam_new * p_prod;
            if (p_mix < 1.0e-6f) p_mix = 1.0e-6f;

            // Chemical energy deposition & compression work
            float rho_eff = (mat.density > 10.0f) ? mat.density : 1630.0f;
            float de_comp = (tr_deps < 0.0f) ? -(p_mix / rho_eff) * tr_deps : 0.0f;
            float de_chem = d_lam * mat.detonation_energy;
            p.e_int += de_comp + de_chem;
            p.temperature = mat.T_room + p.e_int / (mat.Cp > 1.0f ? mat.Cp : 1000.0f);

            // Deviatoric shear stress relaxation
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
            const float mu_shear = (1.0f - lam_new) * (E_mod / (2.0f * (1.0f + nu_val)));

            float deps_dev[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c) {
                    deps_dev[r][c] = deps[r][c];
                    if (r == c) deps_dev[r][c] -= tr_deps / 3.0f;
                }

            float s_trial[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_trial[r][c] = (1.0f - lam_new) * (sig_base[r][c] + 2.0f * mu_shear * deps_dev[r][c]);

            float p_s = -(s_trial[0][0] + s_trial[1][1] + s_trial[2][2]) / 3.0f;
            for (int r = 0; r < 3; ++r)
                s_trial[r][r] += p_s;

            // Radial return plasticity for solid phase
            float s_mag_sq = 0.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_mag_sq += s_trial[r][c] * s_trial[r][c];
            float q_trial = std::sqrt(1.5f * s_mag_sq);
            float q_yield = (1.0f - lam_new) * (mat.yield_stress > 1.0e5f ? mat.yield_stress : 100.0e6f);
            if (q_trial > q_yield && q_trial > 1.0e-6f) {
                float scale = q_yield / q_trial;
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        s_trial[r][c] *= scale;
            }

            for (int r = 0; r < 3; ++r)
                s_trial[r][r] -= p_mix;
            p.sigma = s_trial;
            return;
        }

        // --- Lee-Tarver Ignition & Growth Model ---
        if (mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth) {
            const float v_rel = std::clamp(p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f), 0.02f, 50.0f);
            float lam_curr = p.lambda;
            float p_curr = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
            if (p_curr < 0.0f) p_curr = 0.0f;

            float lam_new = LeeTarver::advanceLeeTarver(dt, lam_curr, v_rel, p_curr,
                mat.lt_I, mat.lt_a, mat.lt_b, mat.lt_x, mat.lt_ig_max,
                mat.lt_G1, mat.lt_c, mat.lt_d, mat.lt_y, mat.lt_growth_max,
                mat.lt_G2, mat.lt_e, mat.lt_g, mat.lt_z, mat.lt_comp_min);
            p.lambda = lam_new;
            float d_lam = std::max(0.0f, lam_new - lam_curr);

            // Two-phase EOS pressures
            float p_solid = JWL::computeSolidReactantPressure(v_rel, p.e_int, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mat.density);
            float p_prod  = JWL::computeJWLProductPressure(v_rel, p.e_int + mat.detonation_energy, mat.jwl_A, mat.jwl_B, mat.jwl_R1, mat.jwl_R2, mat.jwl_omega, mat.density);
            float p_mix   = (1.0f - lam_new) * p_solid + lam_new * p_prod;
            if (p_mix < 1.0e-6f) p_mix = 1.0e-6f;

            // Chemical energy deposition & compression work
            float rho_eff = (mat.density > 10.0f) ? mat.density : 1840.0f;
            float de_comp = (tr_deps < 0.0f) ? -(p_mix / rho_eff) * tr_deps : 0.0f;
            float de_chem = d_lam * mat.detonation_energy;
            p.e_int += de_comp + de_chem;
            p.temperature = mat.T_room + p.e_int / (mat.Cp > 1.0f ? mat.Cp : 1000.0f);

            // Deviatoric shear stress relaxation
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
            const float mu_shear = (1.0f - lam_new) * (E_mod / (2.0f * (1.0f + nu_val)));

            float deps_dev[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c) {
                    deps_dev[r][c] = deps[r][c];
                    if (r == c) deps_dev[r][c] -= tr_deps / 3.0f;
                }

            float s_trial[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_trial[r][c] = (1.0f - lam_new) * (sig_base[r][c] + 2.0f * mu_shear * deps_dev[r][c]);

            float p_s = -(s_trial[0][0] + s_trial[1][1] + s_trial[2][2]) / 3.0f;
            for (int r = 0; r < 3; ++r)
                s_trial[r][r] += p_s;

            float s_mag_sq = 0.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_mag_sq += s_trial[r][c] * s_trial[r][c];
            float q_trial = std::sqrt(1.5f * s_mag_sq);
            float q_yield = (1.0f - lam_new) * (mat.yield_stress > 1.0e5f ? mat.yield_stress : 100.0e6f);
            if (q_trial > q_yield && q_trial > 1.0e-6f) {
                float scale = q_yield / q_trial;
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        s_trial[r][c] *= scale;
            }

            for (int r = 0; r < 3; ++r)
                s_trial[r][r] -= p_mix;
            p.sigma = s_trial;
            return;
        }

        // --- Johnson-Cook Plasticity + Mie-Grüneisen Shock EOS Model ---
        if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen) {
            float w_factor = (mat.enable_heterogeneity && p.weibull_factor > 0.001f) ? p.weibull_factor : 1.0f;

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

            // 3. Johnson-Cook Yield Stress Calculation
            const float A = mat.jc_A;
            const float B = mat.jc_B;
            const float n = mat.jc_n;
            const float C = mat.jc_C;
            const float m = mat.jc_m;

            float eps_dot = std::sqrt(std::max(0.0f, (2.0f / 3.0f) * (deps_dev[0][0]*deps_dev[0][0] + deps_dev[1][1]*deps_dev[1][1] + deps_dev[2][2]*deps_dev[2][2] +
                                     2.0f * (deps_dev[0][1]*deps_dev[0][1] + deps_dev[0][2]*deps_dev[0][2] + deps_dev[1][2]*deps_dev[1][2])))) / dt;
            float eps_dot_star = std::max(1.0e-5f, eps_dot / 1.0f);

            float T_star = (p.temperature - mat.T_room) / std::max(1.0f, mat.T_melt - mat.T_room);
            T_star = std::clamp(T_star, 0.0f, 1.0f);

            if (T_star >= 1.0f) {
                // Melted metal behaves hydrodynamically: zero deviatoric shear stress and zero affine B
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c) {
                        p.sigma[r][c] = (r == c) ? -p_hydro : 0.0f;
                        p.B[r][c] = 0.0f;
                    }
                return;
            }

            float strain_term = A + B * std::pow(std::max(1.0e-6f, p.ep_bar), n);
            float rate_term   = (eps_dot_star > 1.0f) ? (1.0f + C * std::log(eps_dot_star)) : 1.0f;
            float temp_term   = 1.0f - std::pow(T_star, m);

            float aniso_factor = 1.0f;
            if (mat.enable_anisotropy && std::abs(mat.anisotropy_ratio - 1.0f) > 0.001f) {
                float ax = mat.anisotropy_dir[0], ay = mat.anisotropy_dir[1], az = mat.anisotropy_dir[2];
                float sigma_a = ax * (s_trial[0][0]*ax + s_trial[0][1]*ay + s_trial[0][2]*az) +
                                ay * (s_trial[1][0]*ax + s_trial[1][1]*ay + s_trial[1][2]*az) +
                                az * (s_trial[2][0]*ax + s_trial[2][1]*ay + s_trial[2][2]*az);
                float q_norm = (q_trial > 1e-12f) ? q_trial : 1.0f;
                float xi = std::clamp(std::abs(sigma_a) / q_norm, 0.0f, 1.0f);
                aniso_factor = 1.0f + (mat.anisotropy_ratio - 1.0f) * (1.0f - xi * xi);
            }

            float jc_yield = strain_term * rate_term * temp_term * w_factor * aniso_factor;

            // 4. Radial Return Mapping for JC
            float delta_ep = 0.0f;
            if (q_trial > jc_yield) {
                float H_jc = B * n * std::pow(std::max(1.0e-6f, p.ep_bar), n - 1.0f) * rate_term * temp_term;
                delta_ep = (q_trial - jc_yield) / (3.0f * mu_shear + H_jc);
                float scale = (q_trial > 1e-12f) ? (jc_yield / q_trial) : 0.0f;
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        s_trial[r][c] *= scale;
                p.ep_bar += delta_ep;
            }
            for (int r = 0; r < 3; ++r)
                s_trial[r][r] -= p_hydro;
            p.sigma = s_trial;

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
                const float fail_strain_base = ((mat.erosion_strain > 0.0f) ? mat.erosion_strain : mat.failure_strain) * w_factor * aniso_factor;
                const float tensile_fail_base = ((mat.erosion_stress > 0.0f) ? mat.erosion_stress : mat.tensile_failure_stress) * w_factor * aniso_factor;

                float d_plastic = 0.0f;
                if (mat.enable_strain_erosion && fail_strain_base > 0.0f) {
                    d_plastic = std::clamp(p.ep_bar / fail_strain_base, 0.0f, 1.0f);
                }

                float d_tensile = 0.0f;
                if (mat.enable_stress_erosion && tensile_fail_base > 0.0f) {
                    float tensile_stress = -p_hydro;
                    if (tensile_stress > 0.0f) {
                        d_tensile = std::clamp(tensile_stress / tensile_fail_base, 0.0f, 1.0f);
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
                p.sigma.setIsotropic(p_comp);
                return;
            }

            return;
        }

        // --- Concrete / Geotechnical / Generic Hypoelastic Plasticity Models ---
        // 1. Jaumann Stress Rate Rotation
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

        // 2. Elastic Trial Stress
        const float E  = mat.youngs_modulus;
        const float nu = mat.poissons_ratio;
        const float mu     = E / (2.0f * (1.0f + nu));
        const float lambda = (E * nu) / ((1.0f + nu) * (1.0f - 2.0f * nu));
        const float K_bulk = E / (3.0f * (1.0f - 2.0f * nu));

        float sig_trial[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c) {
                sig_trial[r][c] = sig_base[r][c] + 2.0f * mu * deps[r][c];
                if (r == c) sig_trial[r][c] += lambda * tr_deps;
            }

        // 3. Pressure & Deviatoric Stress
        float press = -(sig_trial[0][0] + sig_trial[1][1] + sig_trial[2][2]) / 3.0f;
        float s[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c) {
                s[r][c] = sig_trial[r][c];
                if (r == c) s[r][c] += press;
            }

        float char_len_p = std::max(std::cbrt(p.V > 1.0e-20f ? p.V : 1.0e-6f), 1.25f * std::cbrt(p.V0 > 1.0e-20f ? p.V0 : 1.0e-6f));
        float deps_norm = 0.0f;
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                deps_norm += deps[r][c] * deps[r][c];
        float ep_dot = std::sqrt((2.0f / 3.0f) * deps_norm) / (dt > 1.0e-12f ? dt : 1.0e-12f);
        float w_factor = (mat.enable_heterogeneity && p.weibull_factor > 0.001f) ? p.weibull_factor : 1.0f;

        // 4. Concrete Core Formulations or Hypoelastic
        if (mat.material_model == MPMMaterialModel::RHTConcrete) {
            Blast::ConcreteModels::RHTStateVariables<float> rht_state;
            rht_state.damage = p.damage;
            rht_state.ep_bar = p.ep_bar;
            rht_state.p_hydro = press;

            Blast::ConcreteModels::updateRHTStress<float>(
                s, press, tr_deps, dt, char_len_p, ep_dot,
                mat.fc * w_factor, mat.ft * w_factor, mu, K_bulk,
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
                s[r][r] -= press;
            p.sigma = s;
            return;
        } else if (mat.material_model == MPMMaterialModel::KCConcrete) {
            Blast::ConcreteModels::KCStateVariables<float> kc_state;
            kc_state.damage = p.damage;
            kc_state.lambda = p.lambda;
            kc_state.ep_bar = p.ep_bar;
            kc_state.p_hydro = press;

            Blast::ConcreteModels::updateKCStress<float>(
                s, press, tr_deps, dt, char_len_p, ep_dot,
                mat.fc * w_factor, mat.ft * w_factor, mu, K_bulk,
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
                s[r][r] -= press;
            p.sigma = s;
            return;
        } else if (mat.material_model == MPMMaterialModel::CSCMConcrete) {
            Blast::ConcreteModels::CSCMStateVariables<float> cscm_state;
            cscm_state.damage = p.damage;
            cscm_state.kappa = p.lambda;
            cscm_state.ep_bar = p.ep_bar;
            cscm_state.p_hydro = press;

            Blast::ConcreteModels::updateCSCMStress<float>(
                s, press, tr_deps, dt, char_len_p, ep_dot,
                mat.fc * w_factor, mat.ft * w_factor, mu, K_bulk,
                mat.G_f,
                mat.cscm_alpha * w_factor, mat.cscm_theta,
                mat.cscm_lambda * w_factor, mat.cscm_beta,
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
                s[r][r] -= press;
            p.sigma = s;
            return;
        } else {
            // Default Hypoelastic J2 Elastoplasticity with Weibull flaw scatter & plastic damage softening
            float w_factor = (mat.enable_heterogeneity && p.weibull_factor > 0.001f) ? p.weibull_factor : 1.0f;
            if (mat.enable_heterogeneity && w_factor <= 0.001f && mat.weibull_modulus > 0.001f) {
                w_factor = computeWeibullFactor(p.x[0], p.x[1], p.x[2], p.V0, mat.weibull_modulus, mat.weibull_scale, mat.weibull_ref_volume);
            }

            float s_s = 0.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_s += s[r][c] * s[r][c];
            const float q_trial_hypo = std::sqrt(1.5f * s_s);

            float aniso_factor = 1.0f;
            if (mat.enable_anisotropy && std::abs(mat.anisotropy_ratio - 1.0f) > 0.001f) {
                float ax = mat.anisotropy_dir[0], ay = mat.anisotropy_dir[1], az = mat.anisotropy_dir[2];
                float sigma_a = ax * (s[0][0]*ax + s[0][1]*ay + s[0][2]*az) +
                                ay * (s[1][0]*ax + s[1][1]*ay + s[1][2]*az) +
                                az * (s[2][0]*ax + s[2][1]*ay + s[2][2]*az);
                float q_norm = (q_trial_hypo > 1e-12f) ? q_trial_hypo : 1.0f;
                float xi = std::clamp(std::abs(sigma_a) / q_norm, 0.0f, 1.0f);
                aniso_factor = 1.0f + (mat.anisotropy_ratio - 1.0f) * (1.0f - xi * xi);
            }
            const float yield_base = mat.yield_stress * w_factor;
            const float fail_strain_base = (mat.failure_strain > 0.0f) ? mat.failure_strain * w_factor * aniso_factor : 0.0f;
            const float soft_factor = std::clamp(1.0f - 0.70f * p.damage, 0.10f, 1.0f);
            const float yield_eff = (yield_base * soft_factor + mat.hardening_modulus * p.ep_bar) * aniso_factor;
            const float yield_surf = q_trial_hypo - yield_eff;

            if (q_trial_hypo > 1.0e-5f && yield_surf > 0.0f) {
                // Radial return mapping
                const float delta_ep = yield_surf / (3.0f * mu + mat.hardening_modulus);
                float scale = 1.0f - (3.0f * mu * delta_ep) / q_trial_hypo;
                if (scale < 0.0f) scale = 0.0f;
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        s[r][c] *= scale;
                for (int r = 0; r < 3; ++r)
                    s[r][r] -= press;
                p.sigma = s;
                p.ep_bar += delta_ep;
            } else {
                p.sigma = sig_trial;
            }

            float d_plastic = 0.0f;
            if (mat.enable_strain_erosion) {
                float fail_strain = ((mat.erosion_strain > 0.0f) ? mat.erosion_strain : mat.failure_strain) * w_factor * aniso_factor;
                if (fail_strain > 0.0f) {
                    d_plastic = std::clamp(p.ep_bar / fail_strain, 0.0f, 1.0f);
                }
            }

            float d_tensile = 0.0f;
            if (mat.enable_stress_erosion) {
                float fail_stress = ((mat.erosion_stress > 0.0f) ? mat.erosion_stress : mat.tensile_failure_stress) * w_factor * aniso_factor;
                const float curr_press    = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
                const float tensile_stress = -curr_press;
                if (tensile_stress > 0.0f && fail_stress > 0.0f) {
                    d_tensile = std::clamp(tensile_stress / fail_stress, 0.0f, 1.0f);
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

            p.sigma.setIsotropic(p_comp);
            return;
        }

        // Volume update
        p.V = std::clamp(p.V * (1.0f + tr_deps), 0.1f * p.V0, 10.0f * p.V0);
}

void MPMSolver3D::updateStressState(float dt) {
    const size_t num_particles = m_particles.size();
    #pragma omp parallel for schedule(dynamic, 64)
    for (size_t p_idx = 0; p_idx < num_particles; ++p_idx) {
        auto& p = m_particles[p_idx];
        const auto& mat = getMaterialTable(p.object_id);
        float L[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                L[r][c] = p.L_grad[r][c];
        updateParticleStress(p, dt, L, mat);
    }
}

float MPMSolver3D::computeStepSize(float cfl) const {
    if (m_particles.empty()) return 1.0e-6f;
    float max_speed = 100.0f;
    const size_t num_particles = m_particles.size();

    #pragma omp parallel for reduction(max:max_speed) schedule(static)
    for (size_t p_idx = 0; p_idx < num_particles; ++p_idx) {
        const auto& p = m_particles[p_idx];
        if (p.state == 2 || p.m <= 0.0f) continue;
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
        } else if (mat.material_model == MPMMaterialModel::JWLProgrammedBurn || mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth) {
            float C0 = mat.mg_c0 > 100.0f ? mat.mg_c0 : 2500.0f;
            float c_solid = std::sqrt(C0 * C0 + (2.0f / 3.0f) * E / (rho * (1.0f + nu)));
            float c_det = mat.det_vel > 1000.0f ? mat.det_vel : 7000.0f;
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
        v_mag = std::min(25000.0f, v_mag);
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

    auto doGridKinematics = [this](float sub_dt) {
        if (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen) {
            updateGridKinematicsBardenhagen(sub_dt);
        } else {
            updateGridKinematics(sub_dt);
        }
    };

    if (m_time_scheme == MPMTimeIntegrationScheme::RK2) {
        // --- 2nd-Order Midpoint RK2 Scheme ---
        // 1. Predictor Stage (Half-step dt/2)
        if (run_p2g) {
            for (auto& node : m_grid) {
                node.f_ext[0] = 0.0f; node.f_ext[1] = 0.0f; node.f_ext[2] = 0.0f;
            }
            particleToGrid();
        }
        doGridKinematics(0.5f * dt);
        gridToParticleAndStress(0.5f * dt);

        // 2. Corrector Stage: full step from t^{n+1/2} state to t^{n+1}
        // Grid kinematics uses full dt for acceleration; particles advance by dt/2
        // (midpoint rule: position updated once at dt/2 in predictor, once at dt/2 here).
        particleToGrid();
        doGridKinematics(dt);
        gridToParticleAndStress(dt * 0.5f);
    } else {
        // --- 2nd-Order Symplectic Staggered Leapfrog / USL (Single-pass) ---
        if (run_p2g) {
            for (auto& node : m_grid) {
                node.f_ext[0] = 0.0f; node.f_ext[1] = 0.0f; node.f_ext[2] = 0.0f;
            }
            particleToGrid();
        }
        
        if (m_time_scheme == MPMTimeIntegrationScheme::USF) {
            // USF: Update Stress First
            doGridKinematics(dt);
            gridToParticleAndStress(dt);
        } else {
            // USL: Update Stress Last (default)
            doGridKinematics(dt);
            gridToParticleAndStress(dt);
        }
    }

    // 3. Resolve Discrete Element (DEM) Contact & Collisions
    if (m_contact_method == MPMContactMethod::SubGridDEM || (m_contact_method == MPMContactMethod::SingleVelocity && m_enable_dem_contact)) {
        evaluateDEMContact(dt);
    }

    if (m_step_count % 10 == 0) {
        updateFragmentClusters();
    }
}

void MPMSolver3D::evaluateDEMContact(float dt) {
    if (!m_enable_dem_contact || m_particles.empty() || dt <= 1.0e-12f) return;

    const size_t num_particles = m_particles.size();
    if (m_dem_particle_next.size() < num_particles) {
        m_dem_particle_next.resize(num_particles, -1);
    }

    constexpr uint32_t HASH_TABLE_SIZE = 65536u;
    if (m_dem_cell_head.size() != HASH_TABLE_SIZE) {
        m_dem_cell_head.assign(HASH_TABLE_SIZE, -1);
    } else {
        std::fill(m_dem_cell_head.begin(), m_dem_cell_head.end(), -1);
    }

    // Determine spatial hash bin size: twice the characteristic grid cell spacing
    float max_cell_size = std::max({m_dx, m_dy, m_dz});
    if (max_cell_size < 1.0e-4f) max_cell_size = 0.02f;
    float h_bin = std::max(max_cell_size, 1.25f * m_dem_contact_scale * max_cell_size);
    float inv_h_bin = 1.0f / h_bin;

    auto hashCoords = [](int cx, int cy, int cz) -> uint32_t {
        return ((static_cast<uint32_t>(cx) * 73856093u) ^
                (static_cast<uint32_t>(cy) * 19349663u) ^
                (static_cast<uint32_t>(cz) * 83492791u)) & (HASH_TABLE_SIZE - 1u);
    };

    // Pass 1: Insert all active particles into uniform spatial hash table
    for (size_t i = 0; i < num_particles; ++i) {
        const auto& p = m_particles[i];
        if (p.state == 2 || p.m <= 0.0f) {
            m_dem_particle_next[i] = -1;
            continue;
        }

        int cx = static_cast<int>(std::floor((p.x[0] - m_xmin) * inv_h_bin));
        int cy = static_cast<int>(std::floor((p.x[1] - m_ymin) * inv_h_bin));
        int cz = static_cast<int>(std::floor((p.x[2] - m_zmin) * inv_h_bin));

        uint32_t bucket = hashCoords(cx, cy, cz);
        m_dem_particle_next[i] = m_dem_cell_head[bucket];
        m_dem_cell_head[bucket] = static_cast<int>(i);
    }

    const float contact_scale = std::max(0.1f, m_dem_contact_scale);
    const float restitution   = std::clamp(m_dem_restitution, 0.0f, 1.0f);
    const float friction_coef = std::max(0.0f, m_dem_friction);
    const float min_h = std::min({m_dx, m_dy, m_dz});

    // Pass 2: Evaluate pairwise kinematic impulse contact across 27 neighbor bins
    #pragma omp parallel for schedule(dynamic, 64)
    for (size_t i = 0; i < num_particles; ++i) {
        auto& p = m_particles[i];
        if (p.state == 2 || p.m <= 0.0f) continue;

        float p_vx = p.v[0];
        float p_vy = p.v[1];
        float p_vz = p.v[2];
        float total_dv_p = 0.0f;

        int cx = static_cast<int>(std::floor((p.x[0] - m_xmin) * inv_h_bin));
        int cy = static_cast<int>(std::floor((p.x[1] - m_ymin) * inv_h_bin));
        int cz = static_cast<int>(std::floor((p.x[2] - m_zmin) * inv_h_bin));

        float r_p = (p.contact_radius > 1.0e-6f) ? p.contact_radius : (0.5f * std::cbrt(std::max(1.0e-18f, p.V0)));

        for (int dz_idx = -1; dz_idx <= 1; ++dz_idx) {
            for (int dy_idx = -1; dy_idx <= 1; ++dy_idx) {
                for (int dx_idx = -1; dx_idx <= 1; ++dx_idx) {
                    uint32_t bucket = hashCoords(cx + dx_idx, cy + dy_idx, cz + dz_idx);
                    int j = m_dem_cell_head[bucket];

                    while (j != -1) {
                        // Symmetric pair filtering: evaluate pair (i, j) only when i < j
                        if (static_cast<size_t>(j) > i) {
                            auto& q = m_particles[j];
                            if (q.state != 2 && q.m > 0.0f) {
                                // Multi-scenario material eligibility filter:
                                // Intra-object contact is strictly excluded to prevent continuum popcorn fragmentation
                                if (p.object_id != q.object_id) {
                                    auto isGasParticle = [this](const MPMParticle3D& pt) -> bool {
                                        if (pt.state == 1) return true;
                                        if (pt.object_id >= 0 && static_cast<size_t>(pt.object_id) < m_material_tables.size()) {
                                            const auto& mat = m_material_tables[pt.object_id];
                                            bool is_energetic = (mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
                                                                 mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
                                                                 mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);
                                            if (is_energetic) return pt.lambda > 0.5f;
                                        }
                                        return false;
                                    };

                                    bool p_is_gas = isGasParticle(p);
                                    bool q_is_gas = isGasParticle(q);
                                    bool p_is_solid = !p_is_gas;
                                    bool q_is_solid = !q_is_gas;

                                    bool eligible = false;
                                    if (m_dem_contact_mode == MPMDEMContactMode::GasSolidOnly) {
                                        eligible = (p_is_gas && q_is_solid) || (p_is_solid && q_is_gas);
                                    } else if (m_dem_contact_mode == MPMDEMContactMode::BallisticAndGas) {
                                        bool is_gas_solid = (p_is_gas && q_is_solid) || (p_is_solid && q_is_gas);
                                        bool is_solid_solid = p_is_solid && q_is_solid;
                                        eligible = is_gas_solid || is_solid_solid;
                                    } else { // AllDynamic
                                        eligible = true;
                                    }

                                    if (eligible) {
                                        float r_q = (q.contact_radius > 1.0e-6f) ? q.contact_radius : (0.5f * std::cbrt(std::max(1.0e-18f, q.V0)));
                                        float R_sum = contact_scale * (r_p + r_q);
                                        float R_sum_sq = R_sum * R_sum;

                                        float rx = p.x[0] - q.x[0];
                                        float ry = p.x[1] - q.x[1];
                                        float rz = p.x[2] - q.x[2];
                                        float dist_sq = rx * rx + ry * ry + rz * rz;

                                        if (dist_sq < R_sum_sq && dist_sq > 1.0e-14f) {
                                            float dist = std::sqrt(dist_sq);
                                            float inv_dist = 1.0f / dist;
                                            float nx = rx * inv_dist;
                                            float ny = ry * inv_dist;
                                            float nz = rz * inv_dist;

                                            // Relative velocity v_rel = v_p - v_q
                                            float vx_rel = p_vx - q.v[0];
                                            float vy_rel = p_vy - q.v[1];
                                            float vz_rel = p_vz - q.v[2];

                                            float v_n = vx_rel * nx + vy_rel * ny + vz_rel * nz;

                                            // Strict Approach Velocity Gate:
                                            // Only dynamic active approach faster than threshold generates impulse.
                                            // Static proximity at rest (v_n >= 0 or |v_n| <= v_thresh) generates IDENTICALLY ZERO force!
                                            if (v_n < -m_dem_velocity_threshold) {
                                                // Reduced effective mass: mu = (m_p * m_q) / (m_p + m_q)
                                                float m_eff = (p.m * q.m) / (p.m + q.m);

                                                float target_vn = - restitution * v_n;
                                                float dv_n = target_vn - v_n;
                                                float max_dvn = (1.0f + restitution) * (-v_n);
                                                dv_n = std::min(std::max(dv_n, 0.0f), max_dvn);
                                                float J_n = m_eff * dv_n;

                                                if (J_n > 0.0f) {
                                                    // Tangential Coulomb friction
                                                    float v_tx = vx_rel - v_n * nx;
                                                    float v_ty = vy_rel - v_n * ny;
                                                    float v_tz = vz_rel - v_n * nz;
                                                    float v_t_mag = std::sqrt(v_tx * v_tx + v_ty * v_ty + v_tz * v_tz);

                                                    float J_tx = 0.0f, J_ty = 0.0f, J_tz = 0.0f;
                                                    if (v_t_mag > 1.0e-5f && friction_coef > 0.0f) {
                                                        float J_t_limit = std::min(friction_coef * J_n, m_eff * v_t_mag);
                                                        float inv_vt = J_t_limit / v_t_mag;
                                                        J_tx = v_tx * inv_vt;
                                                        J_ty = v_ty * inv_vt;
                                                        J_tz = v_tz * inv_vt;
                                                    }

                                                    // Total impulse on particle p: J_total = J_n * n - J_t
                                                    float Jx = J_n * nx - J_tx;
                                                    float Jy = J_n * ny - J_ty;
                                                    float Jz = J_n * nz - J_tz;

                                                    float inv_mp = 1.0f / p.m;
                                                    float inv_mq = 1.0f / q.m;

                                                    float dv_p_x = Jx * inv_mp;
                                                    float dv_p_y = Jy * inv_mp;
                                                    float dv_p_z = Jz * inv_mp;

                                                    #pragma omp atomic
                                                    p.v[0] += dv_p_x;
                                                    #pragma omp atomic
                                                    p.v[1] += dv_p_y;
                                                    #pragma omp atomic
                                                    p.v[2] += dv_p_z;

                                                    #pragma omp atomic
                                                    q.v[0] -= Jx * inv_mq;
                                                    #pragma omp atomic
                                                    q.v[1] -= Jy * inv_mq;
                                                    #pragma omp atomic
                                                    q.v[2] -= Jz * inv_mq;

                                                    p_vx += dv_p_x;
                                                    p_vy += dv_p_y;
                                                    p_vz += dv_p_z;
                                                    total_dv_p += std::sqrt(dv_p_x * dv_p_x + dv_p_y * dv_p_y + dv_p_z * dv_p_z);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        j = m_dem_particle_next[j];
                    }
                }
            }
        }

        if (total_dv_p > 25.0f) {
            float relax = std::max(0.2f, 1.0f - (total_dv_p - 25.0f) * 0.005f);
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    p.B[r][c] *= relax;
                }
            }
        }
    }
}

void MPMSolver3D::updateFragmentClusters() {
    float clump_r = 0.015f;
    float clump_r_sq = clump_r * clump_r;
    float inv_clump = 1.0f / clump_r;

    std::unordered_map<int64_t, std::vector<size_t>> hash_grid;
    std::vector<size_t> failed_indices;
    failed_indices.reserve(m_particles.size() / 4);

    for (size_t i = 0; i < m_particles.size(); ++i) {
        if (m_particles[i].state == 1 || m_particles[i].has_failed) {
            failed_indices.push_back(i);
            int64_t h = (static_cast<int64_t>(std::floor(m_particles[i].x[0] * inv_clump)) * 73856093) ^
                        (static_cast<int64_t>(std::floor(m_particles[i].x[1] * inv_clump)) * 19349663) ^
                        (static_cast<int64_t>(std::floor(m_particles[i].x[2] * inv_clump)) * 83492791);
            hash_grid[h].push_back(i);
            m_particles[i].cluster_id = 0;
        }
    }

    int next_cluster_id = 1;
    for (size_t idx : failed_indices) {
        if (m_particles[idx].cluster_id != 0) continue;
        int current_id = next_cluster_id++;
        m_particles[idx].cluster_id = current_id;

        std::vector<size_t> queue = { idx };
        size_t head = 0;
        while (head < queue.size() && queue.size() < 64) {
            size_t curr = queue[head++];
            int64_t bx = static_cast<int64_t>(std::floor(m_particles[curr].x[0] * inv_clump));
            int64_t by = static_cast<int64_t>(std::floor(m_particles[curr].x[1] * inv_clump));
            int64_t bz = static_cast<int64_t>(std::floor(m_particles[curr].x[2] * inv_clump));

            for (int64_t dx = -1; dx <= 1; ++dx) {
                for (int64_t dy = -1; dy <= 1; ++dy) {
                    for (int64_t dz = -1; dz <= 1; ++dz) {
                        int64_t h = ((bx + dx) * 73856093) ^ ((by + dy) * 19349663) ^ ((bz + dz) * 83492791);
                        auto it = hash_grid.find(h);
                        if (it == hash_grid.end()) continue;
                        for (size_t neighbor : it->second) {
                            if (m_particles[neighbor].cluster_id == 0) {
                                float dist_sq = (m_particles[curr].x[0] - m_particles[neighbor].x[0])*(m_particles[curr].x[0] - m_particles[neighbor].x[0]) +
                                                (m_particles[curr].x[1] - m_particles[neighbor].x[1])*(m_particles[curr].x[1] - m_particles[neighbor].x[1]) +
                                                (m_particles[curr].x[2] - m_particles[neighbor].x[2])*(m_particles[curr].x[2] - m_particles[neighbor].x[2]);
                                if (dist_sq <= clump_r_sq) {
                                    m_particles[neighbor].cluster_id = current_id;
                                    queue.push_back(neighbor);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

void MPMSolver3D::initMaterialHeterogeneity(int obj_id) {
    if (obj_id < 0 || obj_id >= static_cast<int>(m_material_tables.size())) return;
    const auto& mat = m_material_tables[obj_id];
    for (auto& p : m_particles) {
        if (p.object_id == obj_id) {
            if (mat.enable_heterogeneity && mat.weibull_modulus > 0.001f) {
                p.weibull_factor = computeWeibullFactor(p.x[0], p.x[1], p.x[2], p.V0, mat.weibull_modulus, mat.weibull_scale, mat.weibull_ref_volume);
            } else {
                p.weibull_factor = 1.0f;
            }
        }
    }
}

void MPMSolver3D::seedMottGradyFragments(int obj_id) {
    (void)obj_id;
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
