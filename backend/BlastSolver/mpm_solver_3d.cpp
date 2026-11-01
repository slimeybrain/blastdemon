#include "mpm_solver_3d.hpp"
#include "ImmersedBoundary.hpp"
#include "materials/ConstitutiveSolids.hpp"
#include "materials/ConstitutiveGeomaterials.hpp"

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

// Cell-centered grid ghost node resolution for Method of Images (Symmetry / Reflecting / FreeSlip / Sticky)
inline bool resolve_ghost_node_3d(
    int& i, float& sign_v,
    int nx, Blast::MPMBoundaryCondition3D bc_min, Blast::MPMBoundaryCondition3D bc_max)
{
    sign_v = 1.0f;
    if (i < 0) {
        if (bc_min == Blast::MPMBoundaryCondition3D::FreeSlip ||
            bc_min == Blast::MPMBoundaryCondition3D::Reflecting ||
            bc_min == Blast::MPMBoundaryCondition3D::Sticky) {
            i = -1 - i;
            sign_v = -1.0f;
            return (i >= 0 && i < nx);
        }
        return false;
    } else if (i >= nx) {
        if (bc_max == Blast::MPMBoundaryCondition3D::FreeSlip ||
            bc_max == Blast::MPMBoundaryCondition3D::Reflecting ||
            bc_max == Blast::MPMBoundaryCondition3D::Sticky) {
            i = 2 * nx - 1 - i;
            sign_v = -1.0f;
            return (i >= 0 && i < nx);
        }
        return false;
    }
    return true;
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
    m_terminated = false;

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

void MPMSolver3D::setDomainGeometry(float dx, float dy, float dz, float xmin, float ymin, float zmin, int nx, int ny, int nz) {
    m_dx = dx;
    m_dy = dy;
    m_dz = dz;
    m_xmin = xmin;
    m_ymin = ymin;
    m_zmin = zmin;
    m_nx = nx;
    m_ny = ny;
    m_nz = nz;
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
                                float rot_x, float rot_y, float rot_z,
                                float clip_z_min, float clip_z_max) {
    (void)boundary_fill;
    int particles_per_dim = static_cast<int>(std::round(std::cbrt(static_cast<float>(ppc))));
    if (particles_per_dim < 1) particles_per_dim = 1;

    float p_dx = m_dx / static_cast<float>(particles_per_dim);
    float p_dy = m_dy / static_cast<float>(particles_per_dim);
    float p_dz = m_dz / static_cast<float>(particles_per_dim);

    float min_x = pos_x - 0.5f * size_x;
    float max_x = pos_x + 0.5f * size_x;
    float min_y = pos_y - 0.5f * size_y;
    float max_y = pos_y + 0.5f * size_y;
    float min_z = pos_z - 0.5f * size_z;
    float max_z = pos_z + 0.5f * size_z;

    float dom_min_x = m_xmin; float dom_max_x = m_xmin + static_cast<float>(m_nx) * m_dx;
    float dom_min_y = m_ymin; float dom_max_y = m_ymin + static_cast<float>(m_ny) * m_dy;
    float dom_min_z = m_zmin; float dom_max_z = m_zmin + static_cast<float>(m_nz) * m_dz;

    if (rot_x == 0.0f && rot_y == 0.0f && rot_z == 0.0f) {
        min_x = std::max(min_x, dom_min_x); max_x = std::min(max_x, dom_max_x);
        min_y = std::max(min_y, dom_min_y); max_y = std::min(max_y, dom_max_y);
        min_z = std::max(min_z, dom_min_z); max_z = std::min(max_z, dom_max_z);
    }

    (void)particle_dist;
    int nx_p = std::max(1, static_cast<int>(std::round((max_x - min_x) / p_dx)));
    int ny_p = std::max(1, static_cast<int>(std::round((max_y - min_y) / p_dy)));
    int nz_p = std::max(1, static_cast<int>(std::round((max_z - min_z) / p_dz)));
    float step_x = (max_x - min_x) / static_cast<float>(nx_p);
    float step_y = (max_y - min_y) / static_cast<float>(ny_p);
    float step_z = (max_z - min_z) / static_cast<float>(nz_p);

    float p_vol = step_x * step_y * step_z;
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

    for (int iz = 0; iz < nz_p; ++iz) {
        float z = min_z + (static_cast<float>(iz) + 0.5f) * step_z;
        for (int iy = 0; iy < ny_p; ++iy) {
            float y = min_y + (static_cast<float>(iy) + 0.5f) * step_y;
            for (int ix = 0; ix < nx_p; ++ix) {
                float x = min_x + (static_cast<float>(ix) + 0.5f) * step_x;
                MPMParticle3D p{};

                float rx = x - pos_x;
                float ry = y - pos_y;
                float rz = z - pos_z;

                Point3D r_rot = rotate_point_euler(rx, ry, rz, rot_x, rot_y, rot_z);
                float final_x = pos_x + r_rot.x;
                float final_y = pos_y + r_rot.y;
                float final_z = pos_z + r_rot.z;
                if (final_x < dom_min_x || final_x > dom_max_x ||
                    final_y < dom_min_y || final_y > dom_max_y ||
                    final_z < dom_min_z || final_z > dom_max_z ||
                    final_z < clip_z_min || final_z > clip_z_max) {
                    continue;
                }
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

void MPMSolver3D::addSphereObject(int obj_id, float pos_x, float pos_y, float pos_z, float radius, float inner_radius,
                                  float vel_x, float vel_y, float vel_z,
                                  float angular_vel_x, float angular_vel_y, float angular_vel_z,
                                  float density, float E, float nu,
                                  float yield_stress, float hardening, float failure_strain,
                                  float tensile_failure_stress, int ppc,
                                  MPMParticleDistribution particle_dist,
                                  MPMBoundaryFilling boundary_fill,
                                  float rot_x, float rot_y, float rot_z,
                                  float clip_z_min, float clip_z_max) {
    int particles_per_dim = static_cast<int>(std::round(std::cbrt(static_cast<float>(ppc))));
    if (particles_per_dim < 1) particles_per_dim = 1;

    float p_spacing = m_dx / static_cast<float>(particles_per_dim);
    float p_dx = p_spacing;
    float p_dy = (particle_dist == MPMParticleDistribution::Hexagonal) ? (std::sqrt(3.0f) * 0.5f * p_spacing) : (m_dy / static_cast<float>(particles_per_dim));
    float p_dz = (particle_dist == MPMParticleDistribution::Hexagonal) ? (std::sqrt(2.0f / 3.0f) * p_spacing) : (m_dz / static_cast<float>(particles_per_dim));

    float min_x = pos_x - radius; float max_x = pos_x + radius;
    float min_y = pos_y - radius; float max_y = pos_y + radius;
    float min_z = pos_z - radius; float max_z = pos_z + radius;

    float dom_min_x = m_xmin; float dom_max_x = m_xmin + static_cast<float>(m_nx) * m_dx;
    float dom_min_y = m_ymin; float dom_max_y = m_ymin + static_cast<float>(m_ny) * m_dy;
    float dom_min_z = m_zmin; float dom_max_z = m_zmin + static_cast<float>(m_nz) * m_dz;

    if (rot_x == 0.0f && rot_y == 0.0f && rot_z == 0.0f) {
        min_x = std::max(min_x, dom_min_x); max_x = std::min(max_x, dom_max_x);
        min_y = std::max(min_y, dom_min_y); max_y = std::min(max_y, dom_max_y);
        min_z = std::max(min_z, dom_min_z); max_z = std::min(max_z, dom_max_z);
        min_z = std::max(min_z, clip_z_min); max_z = std::min(max_z, clip_z_max);
    }

    float r2 = radius * radius;
    float r_in2 = (inner_radius > 0.0f) ? (inner_radius * inner_radius) : 0.0f;
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
                                float dist_sq = dsx * dsx + dsy * dsy + dsz * dsz;
                                if (dist_sq <= r2 && dist_sq >= r_in2) {
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
                    float dist_sq = rx * rx + ry * ry + rz * rz;
                    if (dist_sq > r2 || dist_sq < r_in2) continue;
                }

                float p_vol = f_vol * nominal_vol;
                float p_mass = p_vol * density;

                MPMParticle3D p{};

                float rx = final_x - pos_x;
                float ry = final_y - pos_y;
                float rz = final_z - pos_z;

                Point3D r_rot = rotate_point_euler(rx, ry, rz, rot_x, rot_y, rot_z);
                float final_px = pos_x + r_rot.x;
                float final_py = pos_y + r_rot.y;
                float final_pz = pos_z + r_rot.z;
                if (final_px < dom_min_x || final_px > dom_max_x ||
                    final_py < dom_min_y || final_py > dom_max_y ||
                    final_pz < dom_min_z || final_pz > dom_max_z ||
                    final_pz < clip_z_min || final_pz > clip_z_max) {
                    continue;
                }
                p.x[0] = final_px;
                p.x[1] = final_py;
                p.x[2] = final_pz;

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
                                      float rot_x, float rot_y, float rot_z,
                                      float clip_z_min, float clip_z_max) {
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

    float dom_min_x = m_xmin; float dom_max_x = m_xmin + static_cast<float>(m_nx) * m_dx;
    float dom_min_y = m_ymin; float dom_max_y = m_ymin + static_cast<float>(m_ny) * m_dy;
    float dom_min_z = m_zmin; float dom_max_z = m_zmin + static_cast<float>(m_nz) * m_dz;

    if (rot_x == 0.0f && rot_y == 0.0f && rot_z == 0.0f) {
        min_x = std::max(min_x, dom_min_x); max_x = std::min(max_x, dom_max_x);
        min_y = std::max(min_y, dom_min_y); max_y = std::min(max_y, dom_max_y);
        min_z = std::max(min_z, dom_min_z); max_z = std::min(max_z, dom_max_z);
        min_z = std::max(min_z, clip_z_min); max_z = std::min(max_z, clip_z_max);
    }

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
                float final_px = pos_x + r_rot.x;
                float final_py = pos_y + r_rot.y;
                float final_pz = pos_z + r_rot.z;
                if (final_px < dom_min_x || final_px > dom_max_x ||
                    final_py < dom_min_y || final_py > dom_max_y ||
                    final_pz < dom_min_z || final_pz > dom_max_z ||
                    final_pz < clip_z_min || final_pz > clip_z_max) {
                    continue;
                }
                p.x[0] = final_px;
                p.x[1] = final_py;
                p.x[2] = final_pz;

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

    float final_center_x = (origin_mode == "CAD Origin") ? pos_x : 0.5f * (min_x + max_x);
    float final_center_y = (origin_mode == "CAD Origin") ? pos_y : 0.5f * (min_y + max_y);
    float final_center_z = (origin_mode == "CAD Origin") ? pos_z : 0.5f * (min_z + max_z);

    // Preserve true leftmost STL coordinate for ray origin so entry/exit parity remains exact,
    // while clipping the particle sampling box strictly to the computational domain.
    const float stl_min_x = min_x;
    const float dom_min_x = m_xmin, dom_max_x = m_xmin + static_cast<float>(m_nx) * m_dx;
    const float dom_min_y = m_ymin, dom_max_y = m_ymin + static_cast<float>(m_ny) * m_dy;
    const float dom_min_z = m_zmin, dom_max_z = m_zmin + static_cast<float>(m_nz) * m_dz;
    min_x = std::max(min_x, dom_min_x); max_x = std::min(max_x, dom_max_x);
    min_y = std::max(min_y, dom_min_y); max_y = std::min(max_y, dom_max_y);
    min_z = std::max(min_z, dom_min_z); max_z = std::min(max_z, dom_max_z);
    if (min_x >= max_x || min_y >= max_y || min_z >= max_z) {
        std::cout << "[WARN] MPMSolver3D::addSTLObject object " << obj_id << " bounding box lies outside computational domain." << std::endl;
        return;
    }

    int particles_per_dim = static_cast<int>(std::round(std::cbrt(static_cast<float>(ppc))));
    if (particles_per_dim < 1) particles_per_dim = 1;

    float p_spacing = m_dx / static_cast<float>(particles_per_dim);
    float p_dx = p_spacing;
    float p_dy = (particle_dist == MPMParticleDistribution::Hexagonal) ? (std::sqrt(3.0f) * 0.5f * p_spacing) : (m_dy / static_cast<float>(particles_per_dim));
    float p_dz = (particle_dist == MPMParticleDistribution::Hexagonal) ? (std::sqrt(2.0f / 3.0f) * p_spacing) : (m_dz / static_cast<float>(particles_per_dim));

    // Guard against excessive particle counts (> 20M particles per object) to prevent system OOM
    const double est_nx = std::ceil((max_x - min_x) / std::max(p_dx, 1.0e-9f));
    const double est_ny = std::ceil((max_y - min_y) / std::max(p_dy, 1.0e-9f));
    const double est_nz = std::ceil((max_z - min_z) / std::max(p_dz, 1.0e-9f));
    if (est_nx * est_ny * est_nz > 5.0e7) {
        throw std::runtime_error("MPMSolver3D::addSTLObject: Estimated sampling grid exceeds 50M points. Check cell_size and STL scale.");
    }

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
        int ny_bins = std::clamp(static_cast<int>(std::ceil((max_y - min_y) / p_dy)), 1, 2048);
        int nz_bins = std::clamp(static_cast<int>(std::ceil((max_z - min_z) / p_dz)), 1, 2048);
        const float bin_dy = (max_y - min_y) / static_cast<float>(ny_bins);
        const float bin_dz = (max_z - min_z) / static_cast<float>(nz_bins);
        std::vector<std::vector<int>> yz_bins(static_cast<size_t>(ny_bins) * nz_bins);

        for (int i = 0; i < static_cast<int>(triangles.size()); ++i) {
            const auto& tri = triangles[i];
            float t_min_y = std::min({tri.v0.y, tri.v1.y, tri.v2.y});
            float t_max_y = std::max({tri.v0.y, tri.v1.y, tri.v2.y});
            float t_min_z = std::min({tri.v0.z, tri.v1.z, tri.v2.z});
            float t_max_z = std::max({tri.v0.z, tri.v1.z, tri.v2.z});
            if (t_max_y < min_y || t_min_y > max_y || t_max_z < min_z || t_min_z > max_z) continue;

            int by0 = std::clamp(static_cast<int>(std::floor((t_min_y - min_y) / bin_dy)), 0, ny_bins - 1);
            int by1 = std::clamp(static_cast<int>(std::floor((t_max_y - min_y) / bin_dy)), 0, ny_bins - 1);
            int bz0 = std::clamp(static_cast<int>(std::floor((t_min_z - min_z) / bin_dz)), 0, nz_bins - 1);
            int bz1 = std::clamp(static_cast<int>(std::floor((t_max_z - min_z) / bin_dz)), 0, nz_bins - 1);

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
            std::vector<float> intersects;
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

                    intersects.clear();
                    int by = std::clamp(static_cast<int>(std::floor((y - min_y) / bin_dy)), 0, ny_bins - 1);
                    int bz = std::clamp(static_cast<int>(std::floor((z - min_z) / bin_dz)), 0, nz_bins - 1);

                    // 1. Gather candidate triangles from 3x3 bin neighborhood to prevent boundary-grazing misses
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
                        Point3D O = { stl_min_x - 1.0f * p_dx, y_pos, z_pos };
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

                        // 2. Cluster duplicate edge/vertex hits within physical tolerance
                        std::vector<float> clustered;
                        const float eps_merge = std::max(1e-3f * p_dx, 1e-5f);
                        for (float xi : out_intersects) {
                            if (clustered.empty() || (xi - clustered.back() > eps_merge)) {
                                clustered.push_back(xi);
                            }
                        }
                        out_intersects = std::move(clustered);
                    };

                    // Primary ray with irrational sub-pixel jitter
                    float y_ray = y + 1.234e-4f * p_dy;
                    float z_ray = z + 5.678e-4f * p_dz;
                    traceRay(y_ray, z_ray, intersects);

                    // 3. Secondary Perturbed Ray Fallback if parity is odd (non-manifold gap or grazing tangent)
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

                    // 4. Pairwise entry/exit interval clamping (prevents infinite leak to max_x on unclosed meshes)
                    size_t num_pairs = intersects.size() / 2;
                    if (num_pairs == 0) continue;

                    for (float x = min_x + 0.5f * p_dx + x_offset; x < max_x; x += p_dx) {
                        bool inside = false;
                        for (size_t p_idx = 0; p_idx < num_pairs; ++p_idx) {
                            if (x >= intersects[2 * p_idx] && x <= intersects[2 * p_idx + 1]) {
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
        node.m_solid = 0.0f;
        node.m_energetic = 0.0f;
        node.m_reacted = 0.0f;
        node.v_energetic = 0.0f;
        node.v_reacted = 0.0f;
        node.p[0] = 0.0f; node.p[1] = 0.0f; node.p[2] = 0.0f;
        node.f_ext[0] = 0.0f; node.f_ext[1] = 0.0f; node.f_ext[2] = 0.0f;
        node.f_int[0] = 0.0f; node.f_int[1] = 0.0f; node.f_int[2] = 0.0f;
        node.plastic_strain = 0.0f;
        node.pressure = 0.0f;
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
        MPMMaterialModel model = (p_mat_id < static_cast<int>(m_material_tables.size()))
            ? m_material_tables[p_mat_id].material_model : MPMMaterialModel::LinearElastic;
        bool is_fluid_water = (model == MPMMaterialModel::TaitWater);
        bool is_energetic = (model == MPMMaterialModel::JWLProgrammedBurn ||
                             model == MPMMaterialModel::CRESTReactiveBurn ||
                             model == MPMMaterialModel::LeeTarverIgnitionGrowth);
        bool is_solid_mat = !is_fluid_water && !is_energetic && (model != MPMMaterialModel::DruckerPragerSoil);
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
            float h2 = (m_dx * m_dx + m_dy * m_dy + m_dz * m_dz) / 3.0f;
            float inv_h2 = 1.0f / std::max(h2, 1.0e-18f);
            float Dn[3][3] = {
                {D[0][0] * inv_h2, D[0][1] * inv_h2, D[0][2] * inv_h2},
                {D[1][0] * inv_h2, D[1][1] * inv_h2, D[1][2] * inv_h2},
                {D[2][0] * inv_h2, D[2][1] * inv_h2, D[2][2] * inv_h2}
            };
            float det_norm = Dn[0][0] * (Dn[1][1] * Dn[2][2] - Dn[1][2] * Dn[1][2]) -
                             Dn[0][1] * (Dn[0][1] * Dn[2][2] - Dn[1][2] * Dn[0][2]) +
                             Dn[0][2] * (Dn[0][1] * Dn[1][2] - Dn[1][1] * Dn[0][2]);

            if (det_norm > 1.0e-5f) {
                float inv_det_scaled = inv_h2 / det_norm;
                D_inv[0][0] =  (Dn[1][1] * Dn[2][2] - Dn[1][2] * Dn[1][2]) * inv_det_scaled;
                D_inv[0][1] = -(Dn[0][1] * Dn[2][2] - Dn[1][2] * Dn[0][2]) * inv_det_scaled;
                D_inv[0][2] =  (Dn[0][1] * Dn[1][2] - Dn[1][1] * Dn[0][2]) * inv_det_scaled;
                D_inv[1][0] = D_inv[0][1];
                D_inv[1][1] =  (Dn[0][0] * Dn[2][2] - Dn[0][2] * Dn[0][2]) * inv_det_scaled;
                D_inv[1][2] = -(Dn[0][0] * Dn[1][2] - Dn[0][1] * Dn[0][2]) * inv_det_scaled;
                D_inv[2][0] = D_inv[0][2];
                D_inv[2][1] = D_inv[1][2];
                D_inv[2][2] =  (Dn[0][0] * Dn[1][1] - Dn[0][1] * Dn[0][1]) * inv_det_scaled;
            } else {
                float d_iso = 3.75f * inv_h2;
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
                        if (is_solid_mat) {
                            node.m_solid += p.m * weight;
                        }
                        if (is_energetic) {
                            node.m_energetic += p.m * weight;
                            node.m_reacted += p.m * weight * p.lambda;
                            node.v_energetic += p.V * weight;
                            node.v_reacted += p.V * weight * p.lambda;
                        }

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

                        float p_press = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
                        node.pressure += p.m * weight * p_press;
                        if (is_solid_mat && p.ep_bar > 0.0f) {
                            node.plastic_strain += p.m * weight * p.ep_bar;
                        }

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
            const float D_inv_x = 3.0f / (m_dx * m_dx);
            const float D_inv_y = 3.0f / (m_dy * m_dy);
            const float D_inv_z = 3.0f / (m_dz * m_dz);
            float Sx_arr[5], dSx_arr[5], Sy_arr[5], dSy_arr[5], Sz_arr[5], dSz_arr[5];
            for (int offset = -2; offset <= 2; ++offset) {
                int idx = offset + 2;
                float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * m_dx;
                Sx_arr[idx] = evalCubicBSpline_S(px, nx_val, m_dx);
                dSx_arr[idx] = Sx_arr[idx] * D_inv_x * (nx_val - px);

                float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * m_dy;
                Sy_arr[idx] = evalCubicBSpline_S(py, ny_val, m_dy);
                dSy_arr[idx] = Sy_arr[idx] * D_inv_y * (ny_val - py);

                float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * m_dz;
                Sz_arr[idx] = evalCubicBSpline_S(pz, nz_val, m_dz);
                dSz_arr[idx] = Sz_arr[idx] * D_inv_z * (nz_val - pz);
            }

            for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                int raw_i = base_i + offset_i;
                int i = raw_i;
                float sign_x = 1.0f;
                if (!resolve_ghost_node_3d(i, sign_x, m_nx, m_bc_x_min, m_bc_x_max)) continue;
                int i_idx = offset_i + 2;
                float Sx = Sx_arr[i_idx];
                if (std::abs(Sx) < 1.0e-7f) continue;
                float dSx = dSx_arr[i_idx];
                float node_x = (static_cast<float>(raw_i) + 0.5f) * m_dx;

                for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                    int raw_j = base_j + offset_j;
                    int j = raw_j;
                    float sign_y = 1.0f;
                    if (!resolve_ghost_node_3d(j, sign_y, m_ny, m_bc_y_min, m_bc_y_max)) continue;
                    int j_idx = offset_j + 2;
                    float Sy = Sy_arr[j_idx];
                    if (std::abs(Sy) < 1.0e-7f) continue;
                    float dSy = dSy_arr[j_idx];
                    float node_y = (static_cast<float>(raw_j) + 0.5f) * m_dy;

                    for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                        int raw_k = base_k + offset_k;
                        int k = raw_k;
                        float sign_z = 1.0f;
                        if (!resolve_ghost_node_3d(k, sign_z, m_nz, m_bc_z_min, m_bc_z_max)) continue;
                        int k_idx = offset_k + 2;
                        float Sz = Sz_arr[k_idx];
                        if (std::abs(Sz) < 1.0e-7f) continue;
                        float dSz = dSz_arr[k_idx];
                        float node_z = (static_cast<float>(raw_k) + 0.5f) * m_dz;

                        float weight = Sx * Sy * Sz;
                        if (weight < 1.0e-7f) continue;
                        float dN_dx = dSx * Sy * Sz;
                        float dN_dy = Sx * dSy * Sz;
                        float dN_dz = Sx * Sy * dSz;

                        size_t node_idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                        auto& node = m_grid[node_idx];

                        // Mass scatter
                        node.m += p.m * weight;
                        if (is_solid_mat) {
                            node.m_solid += p.m * weight;
                        }
                        if (is_energetic) {
                            node.m_energetic += p.m * weight;
                            node.m_reacted += p.m * weight * p.lambda;
                            node.v_energetic += p.V * weight;
                            node.v_reacted += p.V * weight * p.lambda;
                        }

                        // APIC Momentum scatter in 3D: p_node += m_p * S * (v_p + w_apic * B_p * dist)
                        float dist_x = node_x - px;
                        float dist_y = node_y - py;
                        float dist_z = node_z - pz;

                        float w_apic = 1.0f;
                        float v_apic_x = p.v[0] + w_apic * (p.B[0][0] * dist_x + p.B[0][1] * dist_y + p.B[0][2] * dist_z);
                        float v_apic_y = p.v[1] + w_apic * (p.B[1][0] * dist_x + p.B[1][1] * dist_y + p.B[1][2] * dist_z);
                        float v_apic_z = p.v[2] + w_apic * (p.B[2][0] * dist_x + p.B[2][1] * dist_y + p.B[2][2] * dist_z);

                        node.p[0] += sign_x * p.m * weight * v_apic_x;
                        node.p[1] += sign_y * p.m * weight * v_apic_y;
                        node.p[2] += sign_z * p.m * weight * v_apic_z;

                        // 3D Internal Stress Force scatter: f_int += -V_p * sigma_p * dN
                        float f_stress_x = - p.V * (p.sigma[0][0] * dN_dx + p.sigma[0][1] * dN_dy + p.sigma[0][2] * dN_dz);
                        float f_stress_y = - p.V * (p.sigma[1][0] * dN_dx + p.sigma[1][1] * dN_dy + p.sigma[1][2] * dN_dz);
                        float f_stress_z = - p.V * (p.sigma[2][0] * dN_dx + p.sigma[2][1] * dN_dy + p.sigma[2][2] * dN_dz);

                        node.f_int[0] += sign_x * f_stress_x;
                        node.f_int[1] += sign_y * f_stress_y;
                        node.f_int[2] += sign_z * f_stress_z;

                        float p_press = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
                        node.pressure += p.m * weight * p_press;
                        if (is_solid_mat && p.ep_bar > 0.0f) {
                            node.plastic_strain += p.m * weight * p.ep_bar;
                        }

                        if (is_multi_mat) {
                            auto& mf = m_mat_fields[p_mat_id];
                            mf.m[node_idx] += p.m * weight;
                            mf.p[0][node_idx] += sign_x * p.m * weight * v_apic_x;
                            mf.p[1][node_idx] += sign_y * p.m * weight * v_apic_y;
                            mf.p[2][node_idx] += sign_z * p.m * weight * v_apic_z;
                            mf.f_int[0][node_idx] += sign_x * f_stress_x;
                            mf.f_int[1][node_idx] += sign_y * f_stress_y;
                            mf.f_int[2][node_idx] += sign_z * f_stress_z;
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
                const float D_inv_x = 4.0f / (m_dx * m_dx);
                const float D_inv_y = 4.0f / (m_dy * m_dy);
                const float D_inv_z = 4.0f / (m_dz * m_dz);
                for (int offset = -1; offset <= 2; ++offset) {
                    int idx = offset + 1;
                    float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * m_dx;
                    Sx_arr[idx] = evalBSpline_S(px, nx_val, m_dx);
                    dSx_arr[idx] = Sx_arr[idx] * D_inv_x * (nx_val - px);

                    float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * m_dy;
                    Sy_arr[idx] = evalBSpline_S(py, ny_val, m_dy);
                    dSy_arr[idx] = Sy_arr[idx] * D_inv_y * (ny_val - py);

                    float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * m_dz;
                    Sz_arr[idx] = evalBSpline_S(pz, nz_val, m_dz);
                    dSz_arr[idx] = Sz_arr[idx] * D_inv_z * (nz_val - pz);
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
                int raw_i = base_i + offset_i;
                int i = raw_i;
                float sign_x = 1.0f;
                if (!resolve_ghost_node_3d(i, sign_x, m_nx, m_bc_x_min, m_bc_x_max)) continue;
                int i_idx = offset_i + 1;
                float Sx = Sx_arr[i_idx];
                if (std::abs(Sx) < 1.0e-7f) continue;
                float dSx = dSx_arr[i_idx];
                float node_x = (static_cast<float>(raw_i) + 0.5f) * m_dx;

                for (int offset_j = -1; offset_j <= 2; ++offset_j) {
                    int raw_j = base_j + offset_j;
                    int j = raw_j;
                    float sign_y = 1.0f;
                    if (!resolve_ghost_node_3d(j, sign_y, m_ny, m_bc_y_min, m_bc_y_max)) continue;
                    int j_idx = offset_j + 1;
                    float Sy = Sy_arr[j_idx];
                    if (std::abs(Sy) < 1.0e-7f) continue;
                    float dSy = dSy_arr[j_idx];
                    float node_y = (static_cast<float>(raw_j) + 0.5f) * m_dy;

                    for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                        int raw_k = base_k + offset_k;
                        int k = raw_k;
                        float sign_z = 1.0f;
                        if (!resolve_ghost_node_3d(k, sign_z, m_nz, m_bc_z_min, m_bc_z_max)) continue;
                        int k_idx = offset_k + 1;
                        float Sz = Sz_arr[k_idx];
                        if (std::abs(Sz) < 1.0e-7f) continue;
                        float dSz = dSz_arr[k_idx];
                        float node_z = (static_cast<float>(raw_k) + 0.5f) * m_dz;

                        float weight = Sx * Sy * Sz;
                        if (weight < 1.0e-7f) continue;
                        float dN_dx = dSx * Sy * Sz;
                        float dN_dy = Sx * dSy * Sz;
                        float dN_dz = Sx * Sy * dSz;

                        size_t node_idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                        auto& node = m_grid[node_idx];

                        // Mass scatter
                        node.m += p.m * weight;
                        if (is_solid_mat) {
                            node.m_solid += p.m * weight;
                        }
                        if (is_energetic) {
                            node.m_energetic += p.m * weight;
                            node.m_reacted += p.m * weight * p.lambda;
                            node.v_energetic += p.V * weight;
                            node.v_reacted += p.V * weight * p.lambda;
                        }

                        // APIC Momentum scatter in 3D: p_node += m_p * S * (v_p + w_apic * B_p * dist)
                        float dist_x = node_x - px;
                        float dist_y = node_y - py;
                        float dist_z = node_z - pz;

                        float w_apic = 1.0f;
                        float v_apic_x = p.v[0] + w_apic * (p.B[0][0] * dist_x + p.B[0][1] * dist_y + p.B[0][2] * dist_z);
                        float v_apic_y = p.v[1] + w_apic * (p.B[1][0] * dist_x + p.B[1][1] * dist_y + p.B[1][2] * dist_z);
                        float v_apic_z = p.v[2] + w_apic * (p.B[2][0] * dist_x + p.B[2][1] * dist_y + p.B[2][2] * dist_z);

                        node.p[0] += sign_x * p.m * weight * v_apic_x;
                        node.p[1] += sign_y * p.m * weight * v_apic_y;
                        node.p[2] += sign_z * p.m * weight * v_apic_z;

                        // 3D Internal Stress Force scatter: f_int += -V_p * sigma_p * dN
                        float f_stress_x = - p.V * (p.sigma[0][0] * dN_dx + p.sigma[0][1] * dN_dy + p.sigma[0][2] * dN_dz);
                        float f_stress_y = - p.V * (p.sigma[1][0] * dN_dx + p.sigma[1][1] * dN_dy + p.sigma[1][2] * dN_dz);
                        float f_stress_z = - p.V * (p.sigma[2][0] * dN_dx + p.sigma[2][1] * dN_dy + p.sigma[2][2] * dN_dz);

                        node.f_int[0] += sign_x * f_stress_x;
                        node.f_int[1] += sign_y * f_stress_y;
                        node.f_int[2] += sign_z * f_stress_z;

                        float p_press = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
                        node.pressure += p.m * weight * p_press;
                        if (is_solid_mat && p.ep_bar > 0.0f) {
                            node.plastic_strain += p.m * weight * p.ep_bar;
                        }

                        if (is_multi_mat) {
                            auto& mf = m_mat_fields[p_mat_id];
                            mf.m[node_idx] += p.m * weight;
                            mf.p[0][node_idx] += sign_x * p.m * weight * v_apic_x;
                            mf.p[1][node_idx] += sign_y * p.m * weight * v_apic_y;
                            mf.p[2][node_idx] += sign_z * p.m * weight * v_apic_z;
                            mf.f_int[0][node_idx] += sign_x * f_stress_x;
                            mf.f_int[1][node_idx] += sign_y * f_stress_y;
                            mf.f_int[2][node_idx] += sign_z * f_stress_z;
                        }
                    }
                }
            }
        }
    }

    // Normalize telemetry scalars
    for (auto& node : m_grid) {
        if (node.m > MPMGridNode3D::MIN_MASS) {
            node.plastic_strain = (node.m_solid > MPMGridNode3D::MIN_MASS) ? (node.plastic_strain / node.m_solid) : 0.0f;
            node.pressure /= node.m;
        }
    }

    if (m_smooth_plastic_strain) {
        std::vector<float> smoothed_ep(m_grid.size(), 0.0f);
        for (int i = 0; i < m_nx; ++i) {
            for (int j = 0; j < m_ny; ++j) {
                for (int k = 0; k < m_nz; ++k) {
                    size_t idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                    if (m_grid[idx].m_solid <= MPMGridNode3D::MIN_MASS) continue;
                    float sum_ep = 2.0f * m_grid[idx].plastic_strain;
                    float weight_sum = 2.0f;
                    for (int di = -1; di <= 1; ++di) {
                        for (int dj = -1; dj <= 1; ++dj) {
                            for (int dk = -1; dk <= 1; ++dk) {
                                if (di == 0 && dj == 0 && dk == 0) continue;
                                int ni = i + di; int nj = j + dj; int nk = k + dk;
                                if (ni >= 0 && ni < m_nx && nj >= 0 && nj < m_ny && nk >= 0 && nk < m_nz) {
                                    size_t n_idx = (static_cast<size_t>(ni) * m_ny + nj) * m_nz + nk;
                                    if (m_grid[n_idx].m_solid > MPMGridNode3D::MIN_MASS) {
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
                    if (m_grid[idx].m_solid > MPMGridNode3D::MIN_MASS) {
                        m_grid[idx].plastic_strain = smoothed_ep[idx];
                    }
                }
            }
        }
    }
}

void MPMSolver3D::updateGridKinematics(float dt) {
    float avg_p_mass = 0.001f;
    if (!m_particles.empty()) avg_p_mass = m_particles[0].m;
    float m_ref = std::max(avg_p_mass, 1.0e-12f);
    float m_tol = 1.0e-8f * m_ref;

    #pragma omp parallel for collapse(2) schedule(static)
    for (int i = 0; i < m_nx; ++i) {
        for (int j = 0; j < m_ny; ++j) {
            for (int k = 0; k < m_nz; ++k) {
                size_t node_idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                auto& node = m_grid[node_idx];

                if (node.m > MPMGridNode3D::MIN_MASS) {
                    float reg = (node.m * node.m) / (node.m * node.m + m_tol * m_tol);
                    node.p[0] += dt * (node.f_ext[0] + reg * node.f_int[0]);
                    node.p[1] += dt * (node.f_ext[1] + reg * node.f_int[1]);
                    node.p[2] += dt * (node.f_ext[2] + reg * node.f_int[2]);

                    // Apply 3D Boundary Conditions (x, y, z min/max across physical boundary faces)
                    if ((i == 0 && m_bc_x_min == MPMBoundaryCondition3D::Sticky) ||
                        (i == m_nx - 1 && m_bc_x_max == MPMBoundaryCondition3D::Sticky)) {
                        node.p[0] = 0.0f; node.p[1] = 0.0f; node.p[2] = 0.0f;
                    } else if ((i == 0 && m_bc_x_min == MPMBoundaryCondition3D::LysmerDashpot) ||
                               (i == m_nx - 1 && m_bc_x_max == MPMBoundaryCondition3D::LysmerDashpot)) {
                        float A_trib = m_dy * m_dz;
                        float C_n = A_trib * m_lysmer_params.rho * m_lysmer_params.c_p * m_lysmer_params.normal_relaxation;
                        float C_s = A_trib * m_lysmer_params.rho * m_lysmer_params.c_s * m_lysmer_params.shear_relaxation;
                        node.p[0] *= std::exp(- (C_n / node.m) * dt);
                        node.p[1] *= std::exp(- (C_s / node.m) * dt);
                        node.p[2] *= std::exp(- (C_s / node.m) * dt);
                    }

                    if ((j == 0 && m_bc_y_min == MPMBoundaryCondition3D::Sticky) ||
                        (j == m_ny - 1 && m_bc_y_max == MPMBoundaryCondition3D::Sticky)) {
                        node.p[0] = 0.0f; node.p[1] = 0.0f; node.p[2] = 0.0f;
                    } else if ((j == 0 && m_bc_y_min == MPMBoundaryCondition3D::LysmerDashpot) ||
                               (j == m_ny - 1 && m_bc_y_max == MPMBoundaryCondition3D::LysmerDashpot)) {
                        float A_trib = m_dx * m_dz;
                        float C_n = A_trib * m_lysmer_params.rho * m_lysmer_params.c_p * m_lysmer_params.normal_relaxation;
                        float C_s = A_trib * m_lysmer_params.rho * m_lysmer_params.c_s * m_lysmer_params.shear_relaxation;
                        node.p[1] *= std::exp(- (C_n / node.m) * dt);
                        node.p[0] *= std::exp(- (C_s / node.m) * dt);
                        node.p[2] *= std::exp(- (C_s / node.m) * dt);
                    }

                    if ((k == 0 && m_bc_z_min == MPMBoundaryCondition3D::Sticky) ||
                        (k == m_nz - 1 && m_bc_z_max == MPMBoundaryCondition3D::Sticky)) {
                        node.p[0] = 0.0f; node.p[1] = 0.0f; node.p[2] = 0.0f;
                    } else if ((k == 0 && m_bc_z_min == MPMBoundaryCondition3D::LysmerDashpot) ||
                               (k == m_nz - 1 && m_bc_z_max == MPMBoundaryCondition3D::LysmerDashpot)) {
                        float A_trib = m_dx * m_dy;
                        float C_n = A_trib * m_lysmer_params.rho * m_lysmer_params.c_p * m_lysmer_params.normal_relaxation;
                        float C_s = A_trib * m_lysmer_params.rho * m_lysmer_params.c_s * m_lysmer_params.shear_relaxation;
                        node.p[2] *= std::exp(- (C_n / node.m) * dt);
                        node.p[0] *= std::exp(- (C_s / node.m) * dt);
                        node.p[1] *= std::exp(- (C_s / node.m) * dt);
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
                auto applyBC = [&](float& vx, float& vy, float& vz, float mass = 0.0f) {
                    if (mass <= 1.0e-12f) mass = (m_cm > 1.0e-12f ? m_cm : 1.0f);
                    if ((i == 0 && m_bc_x_min == MPMBoundaryCondition3D::Sticky) ||
                        (i == m_nx - 1 && m_bc_x_max == MPMBoundaryCondition3D::Sticky)) {
                        vx = 0.0f; vy = 0.0f; vz = 0.0f;
                    } else if ((i == 0 && m_bc_x_min == MPMBoundaryCondition3D::LysmerDashpot) ||
                               (i == m_nx - 1 && m_bc_x_max == MPMBoundaryCondition3D::LysmerDashpot)) {
                        float A_trib = m_dy * m_dz;
                        float C_n = A_trib * m_lysmer_params.rho * m_lysmer_params.c_p * m_lysmer_params.normal_relaxation;
                        float C_s = A_trib * m_lysmer_params.rho * m_lysmer_params.c_s * m_lysmer_params.shear_relaxation;
                        vx *= std::exp(- (C_n / mass) * dt);
                        vy *= std::exp(- (C_s / mass) * dt);
                        vz *= std::exp(- (C_s / mass) * dt);
                    }

                    if ((j == 0 && m_bc_y_min == MPMBoundaryCondition3D::Sticky) ||
                        (j == m_ny - 1 && m_bc_y_max == MPMBoundaryCondition3D::Sticky)) {
                        vx = 0.0f; vy = 0.0f; vz = 0.0f;
                    } else if ((j == 0 && m_bc_y_min == MPMBoundaryCondition3D::LysmerDashpot) ||
                               (j == m_ny - 1 && m_bc_y_max == MPMBoundaryCondition3D::LysmerDashpot)) {
                        float A_trib = m_dx * m_dz;
                        float C_n = A_trib * m_lysmer_params.rho * m_lysmer_params.c_p * m_lysmer_params.normal_relaxation;
                        float C_s = A_trib * m_lysmer_params.rho * m_lysmer_params.c_s * m_lysmer_params.shear_relaxation;
                        vy *= std::exp(- (C_n / mass) * dt);
                        vx *= std::exp(- (C_s / mass) * dt);
                        vz *= std::exp(- (C_s / mass) * dt);
                    }

                    if ((k == 0 && m_bc_z_min == MPMBoundaryCondition3D::Sticky) ||
                        (k == m_nz - 1 && m_bc_z_max == MPMBoundaryCondition3D::Sticky)) {
                        vx = 0.0f; vy = 0.0f; vz = 0.0f;
                    } else if ((k == 0 && m_bc_z_min == MPMBoundaryCondition3D::LysmerDashpot) ||
                               (k == m_nz - 1 && m_bc_z_max == MPMBoundaryCondition3D::LysmerDashpot)) {
                        float A_trib = m_dx * m_dy;
                        float C_n = A_trib * m_lysmer_params.rho * m_lysmer_params.c_p * m_lysmer_params.normal_relaxation;
                        float C_s = A_trib * m_lysmer_params.rho * m_lysmer_params.c_s * m_lysmer_params.shear_relaxation;
                        vz *= std::exp(- (C_n / mass) * dt);
                        vx *= std::exp(- (C_s / mass) * dt);
                        vy *= std::exp(- (C_s / mass) * dt);
                    }
                };

                // Identify materials with physical mass presence on this node
                int sig_count = 0;
                float sig_threshold = MPMGridNode3D::MIN_MASS;

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
                float G_weighted_total[3] = {0.0f, 0.0f, 0.0f};
                float G_unit_sum[3] = {0.0f, 0.0f, 0.0f};

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

                        float gm_len = std::sqrt(gm_x * gm_x + gm_y * gm_y + gm_z * gm_z);
                        if (gm_len > 1.0e-20f) {
                            float inv_gm = 1.0f / gm_len;
                            float gh_x = gm_x * inv_gm;
                            float gh_y = gm_y * inv_gm;
                            float gh_z = gm_z * inv_gm;
                            G_weighted_total[0] += mat_mass * gh_x;
                            G_weighted_total[1] += mat_mass * gh_y;
                            G_weighted_total[2] += mat_mass * gh_z;
                            G_unit_sum[0] += gh_x;
                            G_unit_sum[1] += gh_y;
                            G_unit_sum[2] += gh_z;
                        }
                    }
                }

                float mu = m_dem_friction;
                float rest = std::clamp(m_dem_restitution, 0.0f, 1.0f);
                float grad_thresh = 1.0e-4f;

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
                    float eff_friction = mu;
                    int obj_id = (m < static_cast<int>(m_mat_to_obj.size())) ? m_mat_to_obj[m] : (m + 1);
                    if (obj_id < static_cast<int>(m_material_tables.size())) {
                        auto m_model = m_material_tables[obj_id].material_model;
                        if (m_model == MPMMaterialModel::CRESTReactiveBurn ||
                            m_model == MPMMaterialModel::JWLProgrammedBurn ||
                            m_model == MPMMaterialModel::LeeTarverIgnitionGrowth) {
                            eff_friction = 0.0f;
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

                        float gm_len = std::sqrt(gm_x * gm_x + gm_y * gm_y + gm_z * gm_z);
                        float inv_gm = (gm_len > 1.0e-20f) ? (1.0f / gm_len) : 0.0f;
                        float g_hat[3] = {
                            gm_x * inv_gm,
                            gm_y * inv_gm,
                            gm_z * inv_gm
                        };
                        float m_other = m_cm - mat_mass;
                        float G_m[3];
                        if (m_other > 1.0e-20f) {
                            float inv_m_other = 1.0f / m_other;
                            G_m[0] = g_hat[0] - (G_weighted_total[0] - mat_mass * g_hat[0]) * inv_m_other;
                            G_m[1] = g_hat[1] - (G_weighted_total[1] - mat_mass * g_hat[1]) * inv_m_other;
                            G_m[2] = g_hat[2] - (G_weighted_total[2] - mat_mass * g_hat[2]) * inv_m_other;
                        } else {
                            float inv_other = 1.0f / static_cast<float>(sig_count - 1);
                            float factor_self = static_cast<float>(sig_count) * inv_other;
                            G_m[0] = factor_self * g_hat[0] - inv_other * G_unit_sum[0];
                            G_m[1] = factor_self * g_hat[1] - inv_other * G_unit_sum[1];
                            G_m[2] = factor_self * g_hat[2] - inv_other * G_unit_sum[2];
                        }
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
    float ep_grid = 0.0f;
    float sum_wd_x = 0.0f, sum_wd_y = 0.0f, sum_wd_z = 0.0f;
    float sum_b_grad_x = 0.0f, sum_b_grad_y = 0.0f, sum_b_grad_z = 0.0f;
    float sum_l_grad_x = 0.0f, sum_l_grad_y = 0.0f, sum_l_grad_z = 0.0f;
    bool truncated_open_bc = false;

    int eff_scheme = (p.transfer_scheme >= 0) ? p.transfer_scheme : static_cast<int>(m_transfer_scheme);
    if (eff_scheme == static_cast<int>(MPMTransferScheme::RadialMLS)) {
        float R_supp = 2.0f * std::max({m_dx, m_dy, m_dz});

        float local_w_sum = 0.0f;
        float sum_wx = 0.0f, sum_wy = 0.0f, sum_wz = 0.0f;
        float sum_wxx = 0.0f, sum_wxy = 0.0f, sum_wxz = 0.0f;
        float sum_wyy = 0.0f, sum_wyz = 0.0f, sum_wzz = 0.0f;

        for (int offset_i = -2; offset_i <= 2; ++offset_i) {
            int i = base_i + offset_i;
            if (i < 0 || i >= m_nx) { truncated_open_bc = true; continue; }
            float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

            for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                int j = base_j + offset_j;
                if (j < 0 || j >= m_ny) { truncated_open_bc = true; continue; }
                float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                    int k = base_k + offset_k;
                    if (k < 0 || k >= m_nz) { truncated_open_bc = true; continue; }
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

            float h2 = (m_dx * m_dx + m_dy * m_dy + m_dz * m_dz) / 3.0f;
            float inv_h2 = 1.0f / std::max(h2, 1.0e-18f);
            float Dn[3][3] = {
                {D[0][0] * inv_h2, D[0][1] * inv_h2, D[0][2] * inv_h2},
                {D[1][0] * inv_h2, D[1][1] * inv_h2, D[1][2] * inv_h2},
                {D[2][0] * inv_h2, D[2][1] * inv_h2, D[2][2] * inv_h2}
            };
            float det_norm = Dn[0][0] * (Dn[1][1] * Dn[2][2] - Dn[1][2] * Dn[2][1]) -
                             Dn[0][1] * (Dn[1][0] * Dn[2][2] - Dn[1][2] * Dn[2][0]) +
                             Dn[0][2] * (Dn[1][0] * Dn[2][1] - Dn[1][1] * Dn[2][0]);

            float D_inv[3][3] = {{0,0,0},{0,0,0},{0,0,0}};
            if (det_norm > 1.0e-5f) {
                float invDetScaled = inv_h2 / det_norm;
                D_inv[0][0] =  (Dn[1][1] * Dn[2][2] - Dn[1][2] * Dn[2][1]) * invDetScaled;
                D_inv[0][1] = -(Dn[0][1] * Dn[2][2] - Dn[0][2] * Dn[2][1]) * invDetScaled;
                D_inv[0][2] =  (Dn[0][1] * Dn[1][2] - Dn[0][2] * Dn[1][1]) * invDetScaled;
                D_inv[1][0] = -(Dn[1][0] * Dn[2][2] - Dn[1][2] * Dn[2][0]) * invDetScaled;
                D_inv[1][1] =  (Dn[0][0] * Dn[2][2] - Dn[0][2] * Dn[2][0]) * invDetScaled;
                D_inv[1][2] = -(Dn[0][0] * Dn[1][2] - Dn[0][2] * Dn[1][0]) * invDetScaled;
                D_inv[2][0] =  (Dn[1][0] * Dn[2][1] - Dn[1][1] * Dn[2][0]) * invDetScaled;
                D_inv[2][1] = -(Dn[0][0] * Dn[2][1] - Dn[0][1] * Dn[2][0]) * invDetScaled;
                D_inv[2][2] =  (Dn[0][0] * Dn[1][1] - Dn[0][1] * Dn[1][0]) * invDetScaled;
            } else {
                float inv_diag = 3.75f * inv_h2;
                D_inv[0][0] = inv_diag; D_inv[1][1] = inv_diag; D_inv[2][2] = inv_diag;
            }

            for (int offset_i = -2; offset_i <= 2; ++offset_i) {
                int raw_i = base_i + offset_i;
                int i = raw_i;
                float sign_x = 1.0f;
                if (!resolve_ghost_node_3d(i, sign_x, m_nx, m_bc_x_min, m_bc_x_max)) { truncated_open_bc = true; continue; }
                float node_x = (static_cast<float>(raw_i) + 0.5f) * m_dx;

                for (int offset_j = -2; offset_j <= 2; ++offset_j) {
                    int raw_j = base_j + offset_j;
                    int j = raw_j;
                    float sign_y = 1.0f;
                    if (!resolve_ghost_node_3d(j, sign_y, m_ny, m_bc_y_min, m_bc_y_max)) { truncated_open_bc = true; continue; }
                    float node_y = (static_cast<float>(raw_j) + 0.5f) * m_dy;

                    for (int offset_k = -2; offset_k <= 2; ++offset_k) {
                        int raw_k = base_k + offset_k;
                        int k = raw_k;
                        float sign_z = 1.0f;
                        if (!resolve_ghost_node_3d(k, sign_z, m_nz, m_bc_z_min, m_bc_z_max)) { truncated_open_bc = true; continue; }
                        float node_z = (static_cast<float>(raw_k) + 0.5f) * m_dz;

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
                            float m_tol = 1.0e-8f * std::max(p.m, 1.0e-12f);
                            float inv_m = 1.0f / node.m;
                            float reg = (node.m * node.m) / (node.m * node.m + m_tol * m_tol);
                            n_vx = node.p[0] * inv_m;
                            n_vy = node.p[1] * inv_m;
                            n_vz = node.p[2] * inv_m;
                            delta_vx = dt * (node.f_ext[0] + reg * node.f_int[0]) * inv_m;
                            delta_vy = dt * (node.f_ext[1] + reg * node.f_int[1]) * inv_m;
                            delta_vz = dt * (node.f_ext[2] + reg * node.f_int[2]) * inv_m;
                            node_valid = true;
                        }

                        if (node_valid) {
                            float eff_vx = sign_x * n_vx;
                            float eff_vy = sign_y * n_vy;
                            float eff_vz = sign_z * n_vz;
                            float eff_dvx = sign_x * delta_vx;
                            float eff_dvy = sign_y * delta_vy;
                            float eff_dvz = sign_z * delta_vz;

                            v_pic_x += weight * eff_vx;
                            v_pic_y += weight * eff_vy;
                            v_pic_z += weight * eff_vz;

                            delta_v_grid_x += weight * eff_dvx;
                            delta_v_grid_y += weight * eff_dvy;
                            delta_v_grid_z += weight * eff_dvz;

                            weight_sum += weight;
                            if (node.m_solid > 1.0e-8f) {
                                ep_grid += weight * node.plastic_strain;
                            }

                            float dc_x = node_x - xc;
                            float dc_y = node_y - yc;
                            float dc_z = node_z - zc;

                            float d_dinv_x = D_inv[0][0] * dc_x + D_inv[0][1] * dc_y + D_inv[0][2] * dc_z;
                            float d_dinv_y = D_inv[1][0] * dc_x + D_inv[1][1] * dc_y + D_inv[1][2] * dc_z;
                            float d_dinv_z = D_inv[2][0] * dc_x + D_inv[2][1] * dc_y + D_inv[2][2] * dc_z;

                            sum_wd_x += weight * dist_x;
                            sum_wd_y += weight * dist_y;
                            sum_wd_z += weight * dist_z;
                            sum_b_grad_x += weight * d_dinv_x;
                            sum_b_grad_y += weight * d_dinv_y;
                            sum_b_grad_z += weight * d_dinv_z;
                            sum_l_grad_x += weight * d_dinv_x;
                            sum_l_grad_y += weight * d_dinv_y;
                            sum_l_grad_z += weight * d_dinv_z;

                            float rel_vx = eff_vx - p.v[0];
                            float rel_vy = eff_vy - p.v[1];
                            float rel_vz = eff_vz - p.v[2];

                            kin.B_new[0][0] += weight * rel_vx * d_dinv_x;
                            kin.B_new[0][1] += weight * rel_vx * d_dinv_y;
                            kin.B_new[0][2] += weight * rel_vx * d_dinv_z;

                            kin.B_new[1][0] += weight * rel_vy * d_dinv_x;
                            kin.B_new[1][1] += weight * rel_vy * d_dinv_y;
                            kin.B_new[1][2] += weight * rel_vy * d_dinv_z;

                            kin.B_new[2][0] += weight * rel_vz * d_dinv_x;
                            kin.B_new[2][1] += weight * rel_vz * d_dinv_y;
                            kin.B_new[2][2] += weight * rel_vz * d_dinv_z;

                            kin.L_new[0][0] += rel_vx * weight * d_dinv_x;
                            kin.L_new[0][1] += rel_vx * weight * d_dinv_y;
                            kin.L_new[0][2] += rel_vx * weight * d_dinv_z;

                            kin.L_new[1][0] += rel_vy * weight * d_dinv_x;
                            kin.L_new[1][1] += rel_vy * weight * d_dinv_y;
                            kin.L_new[1][2] += rel_vy * weight * d_dinv_z;

                            kin.L_new[2][0] += rel_vz * weight * d_dinv_x;
                            kin.L_new[2][1] += rel_vz * weight * d_dinv_y;
                            kin.L_new[2][2] += rel_vz * weight * d_dinv_z;
                        }
                    }
                }
            }
        }
    } else {
        float d_scale = (eff_scheme == static_cast<int>(MPMTransferScheme::BSpline)) ? 4.0f : 3.0f;
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
                dSx_arr[idx] = Sx_arr[idx] * D_inv_x * (nx - px);
            } else if (eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) {
                Sx_arr[idx] = evalCubicBSpline_S(px, nx, m_dx);
                dSx_arr[idx] = Sx_arr[idx] * D_inv_x * (nx - px);
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
                dSy_arr[idx] = Sy_arr[idx] * D_inv_y * (ny - py);
            } else if (eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) {
                Sy_arr[idx] = evalCubicBSpline_S(py, ny, m_dy);
                dSy_arr[idx] = Sy_arr[idx] * D_inv_y * (ny - py);
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
                dSz_arr[idx] = Sz_arr[idx] * D_inv_z * (nz - pz);
            } else if (eff_scheme == static_cast<int>(MPMTransferScheme::CubicBSpline)) {
                Sz_arr[idx] = evalCubicBSpline_S(pz, nz, m_dz);
                dSz_arr[idx] = Sz_arr[idx] * D_inv_z * (nz - pz);
            } else {
                Sz_arr[idx] = std::max(0.0f, 1.0f - std::abs(pz - nz) / m_dz);
                dSz_arr[idx] = (pz >= nz ? -1.0f / m_dz : 1.0f / m_dz);
            }
        }

        for (int offset_i = min_offset; offset_i <= max_offset; ++offset_i) {
            int i_idx = offset_i - min_offset;
            float Sx = Sx_arr[i_idx];
            if (std::abs(Sx) < 1.0e-7f) continue;
            int raw_i = base_i + offset_i;
            int i = raw_i;
            float sign_x = 1.0f;
            if (!resolve_ghost_node_3d(i, sign_x, m_nx, m_bc_x_min, m_bc_x_max)) { truncated_open_bc = true; continue; }
            float dSx = dSx_arr[i_idx];
            float node_x = (static_cast<float>(raw_i) + 0.5f) * m_dx;

            for (int offset_j = min_offset; offset_j <= max_offset; ++offset_j) {
                int j_idx = offset_j - min_offset;
                float Sy = Sy_arr[j_idx];
                if (std::abs(Sy) < 1.0e-7f) continue;
                int raw_j = base_j + offset_j;
                int j = raw_j;
                float sign_y = 1.0f;
                if (!resolve_ghost_node_3d(j, sign_y, m_ny, m_bc_y_min, m_bc_y_max)) { truncated_open_bc = true; continue; }
                float dSy = dSy_arr[j_idx];
                float node_y = (static_cast<float>(raw_j) + 0.5f) * m_dy;

                for (int offset_k = min_offset; offset_k <= max_offset; ++offset_k) {
                    int k_idx = offset_k - min_offset;
                    float Sz = Sz_arr[k_idx];
                    if (std::abs(Sz) < 1.0e-7f) continue;
                    int raw_k = base_k + offset_k;
                    int k = raw_k;
                    float sign_z = 1.0f;
                    if (!resolve_ghost_node_3d(k, sign_z, m_nz, m_bc_z_min, m_bc_z_max)) { truncated_open_bc = true; continue; }
                    float dSz = dSz_arr[k_idx];
                    float node_z = (static_cast<float>(raw_k) + 0.5f) * m_dz;

                    float weight = Sx * Sy * Sz;
                    if (weight < 1.0e-7f) continue;
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
                            float m_tol = 1.0e-8f * std::max(p.m, 1.0e-12f);
                            float inv_m = 1.0f / node.m;
                            float reg = (node.m * node.m) / (node.m * node.m + m_tol * m_tol);
                            n_vx = node.p[0] * inv_m;
                            n_vy = node.p[1] * inv_m;
                            n_vz = node.p[2] * inv_m;
                            delta_vx = dt * (node.f_ext[0] + reg * node.f_int[0]) * inv_m;
                            delta_vy = dt * (node.f_ext[1] + reg * node.f_int[1]) * inv_m;
                            delta_vz = dt * (node.f_ext[2] + reg * node.f_int[2]) * inv_m;
                            node_valid = true;
                        }

                        if (node_valid) {
                            float eff_vx = sign_x * n_vx;
                            float eff_vy = sign_y * n_vy;
                            float eff_vz = sign_z * n_vz;
                            float eff_dvx = sign_x * delta_vx;
                            float eff_dvy = sign_y * delta_vy;
                            float eff_dvz = sign_z * delta_vz;

                            v_pic_x += weight * eff_vx;
                            v_pic_y += weight * eff_vy;
                            v_pic_z += weight * eff_vz;

                            delta_v_grid_x += weight * eff_dvx;
                            delta_v_grid_y += weight * eff_dvy;
                            delta_v_grid_z += weight * eff_dvz;

                            weight_sum += weight;
                            if (node.m_solid > 1.0e-8f) {
                                ep_grid += weight * node.plastic_strain;
                            }

                            float dist_x = node_x - px;
                            float dist_y = node_y - py;
                            float dist_z = node_z - pz;

                            sum_wd_x += weight * dist_x;
                            sum_wd_y += weight * dist_y;
                            sum_wd_z += weight * dist_z;
                            sum_b_grad_x += weight * dist_x * D_inv_x;
                            sum_b_grad_y += weight * dist_y * D_inv_y;
                            sum_b_grad_z += weight * dist_z * D_inv_z;
                            sum_l_grad_x += dN_dx;
                            sum_l_grad_y += dN_dy;
                            sum_l_grad_z += dN_dz;

                            float rel_vx = eff_vx - p.v[0];
                            float rel_vy = eff_vy - p.v[1];
                            float rel_vz = eff_vz - p.v[2];

                            float w_apic = 1.0f;
                            kin.B_new[0][0] += w_apic * weight * rel_vx * dist_x * D_inv_x;
                            kin.B_new[0][1] += w_apic * weight * rel_vx * dist_y * D_inv_y;
                            kin.B_new[0][2] += w_apic * weight * rel_vx * dist_z * D_inv_z;

                            kin.B_new[1][0] += w_apic * weight * rel_vy * dist_x * D_inv_x;
                            kin.B_new[1][1] += w_apic * weight * rel_vy * dist_y * D_inv_y;
                            kin.B_new[1][2] += w_apic * weight * rel_vy * dist_z * D_inv_z;

                            kin.B_new[2][0] += w_apic * weight * rel_vz * dist_x * D_inv_x;
                            kin.B_new[2][1] += w_apic * weight * rel_vz * dist_y * D_inv_y;
                            kin.B_new[2][2] += w_apic * weight * rel_vz * dist_z * D_inv_z;

                            kin.L_new[0][0] += rel_vx * dN_dx;
                            kin.L_new[0][1] += rel_vx * dN_dy;
                            kin.L_new[0][2] += rel_vx * dN_dz;

                            kin.L_new[1][0] += rel_vy * dN_dx;
                            kin.L_new[1][1] += rel_vy * dN_dy;
                            kin.L_new[1][2] += rel_vy * dN_dz;

                            kin.L_new[2][0] += rel_vz * dN_dx;
                            kin.L_new[2][1] += rel_vz * dN_dy;
                            kin.L_new[2][2] += rel_vz * dN_dz;
                        }
                    }
                }
            }
        }
    }

    float ep_smoothed = (weight_sum > 1.0e-7f) ? (ep_grid / weight_sum) : 0.0f;

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

        if (truncated_open_bc) {
            float dcx = sum_wd_x * inv_w;
            float dcy = sum_wd_y * inv_w;
            float dcz = sum_wd_z * inv_w;
            if (m_velocity_scheme == MPMVelocityScheme::APIC) {
                v_pic_x -= p.B[0][0] * dcx + p.B[0][1] * dcy + p.B[0][2] * dcz;
                v_pic_y -= p.B[1][0] * dcx + p.B[1][1] * dcy + p.B[1][2] * dcz;
                v_pic_z -= p.B[2][0] * dcx + p.B[2][1] * dcy + p.B[2][2] * dcz;
            }
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    kin.B_new[r][c] = p.B[r][c];
                    kin.L_new[r][c] = 0.0f;
                }
            }
        } else {
            float dv_p[3] = {v_pic_x - p.v[0], v_pic_y - p.v[1], v_pic_z - p.v[2]};
            float bg[3] = {sum_b_grad_x, sum_b_grad_y, sum_b_grad_z};
            float lg[3] = {sum_l_grad_x, sum_l_grad_y, sum_l_grad_z};
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    kin.B_new[r][c] -= dv_p[r] * bg[c];
                    kin.L_new[r][c] -= dv_p[r] * lg[c];
                }
            }
        }
    }

    float target_vx = v_pic_x;
    float target_vy = v_pic_y;
    float target_vz = v_pic_z;

    if (m_velocity_scheme == MPMVelocityScheme::APIC) {
        target_vx = v_pic_x;
        target_vy = v_pic_y;
        target_vz = v_pic_z;
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
    kin.ep_smoothed = ep_smoothed;
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
                          (mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth) ||
                          (mat.material_model == MPMMaterialModel::TaitWater);
        (void)is_fluid_p;

        auto kin = gatherParticleKinematics(p, dt);
        p.v[0] = std::clamp(kin.target_v[0], -25000.0f, 25000.0f);
        p.v[1] = std::clamp(kin.target_v[1], -25000.0f, 25000.0f);
        p.v[2] = std::clamp(kin.target_v[2], -25000.0f, 25000.0f);

        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                p.B[r][c] = (m_velocity_scheme == MPMVelocityScheme::APIC) ? std::clamp(kin.B_new[r][c], -max_B, max_B) : 0.0f;
                p.L_grad[r][c] = std::clamp(kin.L_new[r][c], -max_B, max_B);
            }
        }

        float p_speed = std::sqrt(p.v[0]*p.v[0] + p.v[1]*p.v[1] + p.v[2]*p.v[2]);
        if (p_speed > v_max_global) v_max_global = p_speed;

        // Update Particle Position
        p.x[0] += dt * p.v[0];
        p.x[1] += dt * p.v[1];
        p.x[2] += dt * p.v[2];

        // Domain Boundary Clamping at Physical Domain Boundaries
        float phys_min_x = m_xmin;
        float phys_max_x = m_xmin + static_cast<float>(m_nx) * m_dx;
        float phys_min_y = m_ymin;
        float phys_max_y = m_ymin + static_cast<float>(m_ny) * m_dy;
        float phys_min_z = m_zmin;
        float phys_max_z = m_zmin + static_cast<float>(m_nz) * m_dz;

        bool passed_out = false;
        if (p.x[0] < phys_min_x) {
            if (m_bc_x_min == MPMBoundaryCondition3D::Reflecting) {
                p.x[0] = 2.0f * phys_min_x - p.x[0];
                if (p.x[0] < phys_min_x) p.x[0] = phys_min_x;
                p.v[0] = std::abs(p.v[0]);
            } else if (m_bc_x_min == MPMBoundaryCondition3D::Terminate) {
                m_terminated = true;
                passed_out = true;
            } else if (m_bc_x_min == MPMBoundaryCondition3D::Transmitting ||
                       m_bc_x_min == MPMBoundaryCondition3D::LysmerDashpot) {
                passed_out = true;
            } else {
                p.x[0] = phys_min_x;
                if (p.v[0] < 0.0f) { p.v[0] = 0.0f; }
            }
        } else if (p.x[0] > phys_max_x) {
            if (m_bc_x_max == MPMBoundaryCondition3D::Reflecting) {
                p.x[0] = 2.0f * phys_max_x - p.x[0];
                if (p.x[0] > phys_max_x) p.x[0] = phys_max_x;
                p.v[0] = -std::abs(p.v[0]);
            } else if (m_bc_x_max == MPMBoundaryCondition3D::Terminate) {
                m_terminated = true;
                passed_out = true;
            } else if (m_bc_x_max == MPMBoundaryCondition3D::Transmitting ||
                       m_bc_x_max == MPMBoundaryCondition3D::LysmerDashpot) {
                passed_out = true;
            } else {
                p.x[0] = phys_max_x;
                if (p.v[0] > 0.0f) { p.v[0] = 0.0f; }
            }
        }

        if (p.x[1] < phys_min_y) {
            if (m_bc_y_min == MPMBoundaryCondition3D::Reflecting) {
                p.x[1] = 2.0f * phys_min_y - p.x[1];
                if (p.x[1] < phys_min_y) p.x[1] = phys_min_y;
                p.v[1] = std::abs(p.v[1]);
            } else if (m_bc_y_min == MPMBoundaryCondition3D::Terminate) {
                m_terminated = true;
                passed_out = true;
            } else if (m_bc_y_min == MPMBoundaryCondition3D::Transmitting ||
                       m_bc_y_min == MPMBoundaryCondition3D::LysmerDashpot) {
                passed_out = true;
            } else {
                p.x[1] = phys_min_y;
                if (p.v[1] < 0.0f) { p.v[1] = 0.0f; }
            }
        } else if (p.x[1] > phys_max_y) {
            if (m_bc_y_max == MPMBoundaryCondition3D::Reflecting) {
                p.x[1] = 2.0f * phys_max_y - p.x[1];
                if (p.x[1] > phys_max_y) p.x[1] = phys_max_y;
                p.v[1] = -std::abs(p.v[1]);
            } else if (m_bc_y_max == MPMBoundaryCondition3D::Terminate) {
                m_terminated = true;
                passed_out = true;
            } else if (m_bc_y_max == MPMBoundaryCondition3D::Transmitting ||
                       m_bc_y_max == MPMBoundaryCondition3D::LysmerDashpot) {
                passed_out = true;
            } else {
                p.x[1] = phys_max_y;
                if (p.v[1] > 0.0f) { p.v[1] = 0.0f; }
            }
        }

        if (p.x[2] < phys_min_z) {
            if (m_bc_z_min == MPMBoundaryCondition3D::Reflecting) {
                p.x[2] = 2.0f * phys_min_z - p.x[2];
                if (p.x[2] < phys_min_z) p.x[2] = phys_min_z;
                p.v[2] = std::abs(p.v[2]);
            } else if (m_bc_z_min == MPMBoundaryCondition3D::Terminate) {
                m_terminated = true;
                passed_out = true;
            } else if (m_bc_z_min == MPMBoundaryCondition3D::Transmitting ||
                       m_bc_z_min == MPMBoundaryCondition3D::LysmerDashpot) {
                passed_out = true;
            } else {
                p.x[2] = phys_min_z;
                if (p.v[2] < 0.0f) { p.v[2] = 0.0f; }
            }
        } else if (p.x[2] > phys_max_z) {
            if (m_bc_z_max == MPMBoundaryCondition3D::Reflecting) {
                p.x[2] = 2.0f * phys_max_z - p.x[2];
                if (p.x[2] > phys_max_z) p.x[2] = phys_max_z;
                p.v[2] = -std::abs(p.v[2]);
            } else if (m_bc_z_max == MPMBoundaryCondition3D::Terminate) {
                m_terminated = true;
                passed_out = true;
            } else if (m_bc_z_max == MPMBoundaryCondition3D::Transmitting ||
                       m_bc_z_max == MPMBoundaryCondition3D::LysmerDashpot) {
                passed_out = true;
            } else {
                p.x[2] = phys_max_z;
                if (p.v[2] > 0.0f) { p.v[2] = 0.0f; }
            }
        }

        // Global domain escape check
        if (p.x[0] < m_xmin - 2.0f * m_dx || p.x[0] >= m_xmin + (m_nx + 2.0f) * m_dx ||
            p.x[1] < m_ymin - 2.0f * m_dy || p.x[1] >= m_ymin + (m_ny + 2.0f) * m_dy ||
            p.x[2] < m_zmin - 2.0f * m_dz || p.x[2] >= m_zmin + (m_nz + 2.0f) * m_dz) {
            passed_out = true;
        }

        if (passed_out) {
            p.state = 2; // Inactive / Passed out of domain
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
            updateParticleStress(p, dt, p.L_grad, mat, kin.ep_smoothed);
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

void MPMSolver3D::updateParticleStress(MPMParticle3D& p, float dt, const float L[3][3], const MaterialTable3D& mat, float ep_smoothed) {
    // Symmetric strain increment D*dt and spin tensor W
        float deps[3][3], W[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c) {
                deps[r][c] = 0.5f * (L[r][c] + L[c][r]) * dt;
                W[r][c]    = 0.5f * (L[r][c] - L[c][r]);
            }
        const float tr_deps = deps[0][0] + deps[1][1] + deps[2][2];

        // Physical logarithmic strain volume evolution with scale-isolated realizability bounds (Directive 19)
        const bool is_fluid_water = (mat.material_model == MPMMaterialModel::TaitWater);
        const bool is_energetic_p = (mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
                                     mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
                                     mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);
        const bool is_solid_mat = (!is_fluid_water && !is_energetic_p);
        const float V_min_limit = is_solid_mat ? (0.25f * p.V0) : (1.0e-4f * p.V0);
        const float V_max_limit = is_solid_mat ? (3.0f * p.V0)  : (1.0e4f * p.V0);
        p.V = std::clamp(p.V * std::exp(std::clamp(tr_deps, -0.5f, 0.5f)), V_min_limit, V_max_limit);
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

            if (is_solid_mat && !is_concrete_model && p.V > p.V0) {
                p.V = p.V0;
                if (m_transfer_scheme == MPMTransferScheme::GIMP) {
                    float lp_f = 0.5f * std::cbrt(p.V);
                    p.lp[0] = lp_f; p.lp[1] = lp_f; p.lp[2] = lp_f;
                }
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
                    const float mu_vol = (1.0f - J) / std::max(0.25f, J);
                    p_comp = std::max(0.0f, Blast::Materials::mie_gruneisen_compression_pressure<float>(
                        mat.density, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mu_vol, p.e_int));
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
            //    Concrete rubble: aggregate friction M = 0.6 plus decaying cohesion.
            //    Fractured metals: intergranular Coulomb friction under compression, capped by the intact
            //    quasi-static yield; zero shear in tension (open cracks) and zero shear once molten.
            float q_max = c_residual;
            if (is_concrete_model) {
                q_max = c_residual + 0.60f * std::max(0.0f, p_comp);
            } else if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen ||
                       mat.material_model == MPMMaterialModel::Hypoelastic ||
                       mat.material_model == MPMMaterialModel::LinearElastic) {
                const bool is_jc = (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen);
                const float sigma_y_intact = is_jc ? mat.jc_A : mat.yield_stress;
                const bool melted = is_jc && (mat.T_melt > mat.T_room) && (p.temperature >= mat.T_melt);
                q_max = Blast::Materials::fractured_metal_residual_strength<float>(p_comp, sigma_y_intact, melted);
            }

            if (q_max <= 1.0e-5f) {
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

            float sig_rot_f[3][3];
            rotate_stress_cayley_3d(p.sigma, W, dt, sig_rot_f);

            float s_trial[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_trial[r][c] = sig_rot_f[r][c] + 2.0f * mu_parent * deps_dev[r][c];

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

        // --- Tait Fluid Model (Weakly Compressible & Shock Water) ---
        if (mat.material_model == MPMMaterialModel::TaitWater) {
            const float J = p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f);
            float h_elem = m_dx;
            float p_hydro = 0.0f;
            float sig_tait[3][3] = {};

            Blast::Materials::update_constitutive_tait_fluid(
                mat.tait_B, mat.tait_gamma, mat.tait_rho0, mat.tait_viscosity, mat.tait_p_cav,
                mat.tait_gruneisen, mat.tait_variant,
                J, dt, h_elem, p.e_int, deps, sig_tait, p_hydro,
                mat.bulk_viscosity_b1 > 0.0f ? mat.bulk_viscosity_b1 : 0.06f,
                mat.bulk_viscosity_b2 > 0.0f ? mat.bulk_viscosity_b2 : 1.20f,
                mat.tait_p0
            );

            // Energy update for caloric coupling: de = (sigma : D / rho) * dt
            float rho_p = mat.tait_rho0 / std::max(0.05f, J);
            float work_rate = 0.0f;
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    work_rate += sig_tait[r][c] * (deps[r][c] / std::max(1e-12f, dt));
                }
            }
            p.e_int += (work_rate / rho_p) * dt;
            if (p.e_int < 0.0f) p.e_int = 0.0f;

            p.sigma = sig_tait;
            return;
        }

        // --- Linear Elastic Model (Hooke's Law with Orthogonal Cayley Stress Rotation) ---
        if (mat.material_model == MPMMaterialModel::LinearElastic) {
            const float J = p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f);

            float sig_base[3][3];
            rotate_stress_cayley_3d(p.sigma, W, dt, sig_base);

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

        // --- Drucker-Prager Soil Mechanics with Conical Return Mapping ---
        if (mat.material_model == MPMMaterialModel::DruckerPragerSoil) {
            float sig_base[3][3];
            rotate_stress_cayley_3d(p.sigma, W, dt, sig_base);

            // Extract deviatoric stress and pressure (compression positive)
            float p_hydro = -(sig_base[0][0] + sig_base[1][1] + sig_base[2][2]) / 3.0f;
            float s_dev[3][3];
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    s_dev[r][c] = sig_base[r][c] + (r == c ? p_hydro : 0.0f);
                }
            }

            Blast::Materials::DruckerPragerParams<float> dp_p;
            dp_p.cohesion = mat.dp_cohesion;
            dp_p.friction_angle = mat.dp_friction_angle * 3.14159265f / 180.0f;
            dp_p.dilatancy_angle = mat.dp_dilatancy_angle * 3.14159265f / 180.0f;
            dp_p.tensile_cutoff = mat.dp_tensile_cutoff;
            dp_p.H_plastic = mat.dp_hardening_modulus;

            float ep_bar_p = p.damage;
            Blast::Materials::update_constitutive_drucker_prager<float>(
                mat.youngs_modulus, mat.poissons_ratio, dp_p,
                deps, s_dev, p_hydro, ep_bar_p
            );
            p.damage = ep_bar_p;

            // Reassemble Cauchy stress: sigma = s_dev - p_hydro * I
            for (int r = 0; r < 3; ++r) {
                for (int c = 0; c < 3; ++c) {
                    p.sigma[r][c] = s_dev[r][c] - (r == c ? p_hydro : 0.0f);
                }
            }

            return;
        }

        // --- Hyperelastic Model: Yeoh Strain Energy Function ---
        if (mat.material_model == MPMMaterialModel::HyperelasticYeoh) {
            float sig_base[3][3];
            rotate_stress_cayley_3d(p.sigma, W, dt, sig_base);

            float F_inc[3][3] = {
                {1.0f + deps[0][0], deps[0][1], deps[0][2]},
                {deps[1][0], 1.0f + deps[1][1], deps[1][2]},
                {deps[2][0], deps[2][1], 1.0f + deps[2][2]}
            };
            float s_yeoh[3][3] = {};
            Blast::Materials::update_constitutive_yeoh(
                mat.yeoh_c10, mat.yeoh_c20, mat.yeoh_c30, mat.k_bulk, F_inc, s_yeoh
            );

            float s_updated[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_updated[r][c] = sig_base[r][c] + s_yeoh[r][c];

            p.sigma = s_updated;
            return;
        }

        // --- Hyperelastic Model: Mooney-Rivlin Strain Energy Function ---
        if (mat.material_model == MPMMaterialModel::HyperelasticMooneyRivlin) {
            float sig_base[3][3];
            rotate_stress_cayley_3d(p.sigma, W, dt, sig_base);

            float F_inc[3][3] = {
                {1.0f + deps[0][0], deps[0][1], deps[0][2]},
                {deps[1][0], 1.0f + deps[1][1], deps[1][2]},
                {deps[2][0], deps[2][1], 1.0f + deps[2][2]}
            };
            float s_mr[3][3] = {};
            Blast::Materials::update_constitutive_mooney_rivlin(
                mat.mr_c10, mat.mr_c01, mat.k_bulk, F_inc, s_mr
            );

            float s_updated[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_updated[r][c] = sig_base[r][c] + s_mr[r][c];

            p.sigma = s_updated;
            return;
        }

        // --- Concrete Damage Plasticity (CDP) Model ---
        if (mat.material_model == MPMMaterialModel::ConcreteDamagePlasticity) {
            float d_t = p.damage;
            float d_c = 0.0f;
            float ep_t = p.ep_bar;
            float ep_c = 0.0f;

            float sig_mat[3][3];
            rotate_stress_cayley_3d(p.sigma, W, dt, sig_mat);

            Blast::Materials::update_constitutive_cdp(
                mat.youngs_modulus, mat.poissons_ratio, mat.cdp_f_t0, mat.cdp_f_c0, mat.cdp_g_f, mat.cdp_l_ch,
                deps, sig_mat, d_t, d_c, ep_t, ep_c
            );

            p.damage = std::max(d_t, d_c);
            p.ep_bar = ep_t + ep_c;
            p.sigma = sig_mat;
            return;
        }

        // --- Hill48 Orthotropic Plasticity Model ---
        if (mat.material_model == MPMMaterialModel::Hill48Orthotropic) {
            (void)ep_smoothed;
            float sig_rot[3][3];
            rotate_stress_cayley_3d(p.sigma, W, dt, sig_rot);

            float s_dev[3][3];
            float p_mean = (sig_rot[0][0] + sig_rot[1][1] + sig_rot[2][2]) / 3.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_dev[r][c] = sig_rot[r][c] - (r == c ? p_mean : 0.0f);

            Blast::Materials::update_constitutive_hill48(
                mat.hill_F, mat.hill_G, mat.hill_H, mat.hill_L, mat.hill_M, mat.hill_N,
                mat.hill_sigma_y0, deps, s_dev, p.ep_bar
            );

            float s_final[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_final[r][c] = s_dev[r][c] + (r == c ? p_mean : 0.0f);

            p.sigma = s_final;
            return;
        }

        // --- Three-Pillar Energetic Material Architecture ---
        // Pillar 1: Solid Reactant EOS (Mie-Grüneisen / Davis Solid)
        // Pillar 2: Reaction Kinetics (Programmed Wavefront / Lee-Tarver 3-Stage ODE / CREST Entropy)
        // Pillar 3: Detonation Products EOS (JWL Product Gas / Davis Detonation Product)
        if (mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
            mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
            mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth) {

            const float v_rel = std::max(p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f), 0.02f);
            float lam_curr = p.lambda;
            float lam_new = lam_curr;

            // Pillar 2: Reaction Kinetics Rate Law
            bool is_crest_kinetics = (mat.burn_model == ReactionKinetics::CRESTEntropy) ||
                                     (mat.material_model == MPMMaterialModel::CRESTReactiveBurn && mat.burn_model != ReactionKinetics::LeeTarverODE);
            bool is_lt_kinetics = (mat.burn_model == ReactionKinetics::LeeTarverODE) ||
                                  (mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth && mat.burn_model != ReactionKinetics::CRESTEntropy);

            bool use_davis_solid = (mat.solid_model == SolidReactantEOS::DavisSolid) ||
                                   (mat.material_model == MPMMaterialModel::CRESTReactiveBurn);
            bool use_davis_prod = (mat.product_model == DetonationProductEOS::DavisProduct) ||
                                  (mat.material_model == MPMMaterialModel::CRESTReactiveBurn);

            if (is_crest_kinetics) {
                p.v_min = std::min(p.v_min, v_rel);
                float s_calc = CrestDavis::computeDavisShockEntropy(p.v_min, mat.davis_c0, mat.davis_s1, mat.davis_gamma0, mat.davis_cv, mat.davis_t0, mat.davis_rho0);
                p.s_shock = std::max(p.s_shock, s_calc);

                float q_heat_trial = use_davis_prod ? mat.davis_q_det : mat.detonation_energy;
                float e_th_trial = std::max(0.0f, p.e_int - lam_curr * q_heat_trial);
                float p_curr_comp = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
                float p_react_trial = use_davis_solid
                    ? CrestDavis::computeDavisReactantPressure(v_rel, e_th_trial, mat.davis_c0, mat.davis_s1, mat.davis_gamma0, mat.davis_cv, mat.davis_t0, mat.davis_rho0)
                    : JWL::computeSolidReactantPressure(v_rel, e_th_trial, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mat.density);
                float p_eff_comp = (lam_curr <= 1.0e-5f) ? std::max(p_curr_comp, p_react_trial) : p_react_trial;
                if (p_eff_comp > 1.0e6f) {
                    float s_p = CrestDavis::computeDavisShockEntropyFromPressure(p_eff_comp, mat.davis_c0, mat.davis_s1, mat.davis_cv, mat.davis_t0, mat.davis_rho0);
                    p.s_shock = std::max(p.s_shock, s_p);
                }


                lam_new = CrestDavis::advanceCRESTProgress(dt, p.s_shock, p.lambda, mat.crest_b1, mat.crest_c1, mat.crest_m1, mat.crest_b2, mat.crest_c2, mat.crest_c3, mat.crest_m2, mat.crest_s0, mat.crest_s_threshold);
            } else if (is_lt_kinetics) {
                float p_curr = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
                if (p_curr < 0.0f) p_curr = 0.0f;

                lam_new = LeeTarver::advanceLeeTarver(dt, lam_curr, v_rel, p_curr,
                    mat.lt_I, mat.lt_a, mat.lt_b, mat.lt_x, mat.lt_ig_max,
                    mat.lt_G1, mat.lt_c, mat.lt_d, mat.lt_y, mat.lt_growth_max,
                    mat.lt_G2, mat.lt_e, mat.lt_g, mat.lt_z, mat.lt_comp_min);
            } else {
                // Programmed Wavefront Burn
                float t_arr = p.t_arrival;
                float eff_dx = (mat.cell_dx > 0.0f) ? mat.cell_dx : std::max(2.0f * std::cbrt(p.V0), 0.01f);
                float tau_burn = std::max(static_cast<float>(mat.burn_zone_cells) * eff_dx / std::max(mat.det_vel, 100.0f), mat.tau_burn_min);
                float lam_prog = JWL::computeProgrammedProgress(static_cast<float>(m_sim_time), t_arr, tau_burn);
                lam_new = std::max(lam_curr, lam_prog);
            }

            p.lambda = lam_new;
            float d_lam = std::max(0.0f, lam_new - lam_curr);

            float q_heat = use_davis_prod ? mat.davis_q_det : mat.detonation_energy;
            float e_th = p.e_int - lam_curr * q_heat;
            float e_prod = e_th + q_heat;

            // Pillar 1: Solid Reactant EOS
            float p_solid = use_davis_solid
                ? CrestDavis::computeDavisReactantPressure(v_rel, e_th, mat.davis_c0, mat.davis_s1, mat.davis_gamma0, mat.davis_cv, mat.davis_t0, mat.davis_rho0)
                : JWL::computeSolidReactantPressure(v_rel, e_th, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mat.density);

            // Pillar 3: Detonation Products EOS
            float p_prod = use_davis_prod
                ? CrestDavis::computeDavisProductPressure(v_rel, e_prod, mat.davis_a, mat.davis_b, mat.davis_k, mat.davis_vc, mat.davis_pc, mat.davis_q_det, mat.davis_rho0)
                : JWL::computeJWLProductPressure(v_rel, e_prod, mat.jwl_A, mat.jwl_B, mat.jwl_R1, mat.jwl_R2, mat.jwl_omega, mat.density);

            // Two-phase pressure blend
            float p_mix = (1.0f - lam_new) * p_solid + lam_new * p_prod;
            if (p_mix < 1.0e-6f) p_mix = 1.0e-6f;

            // Energy conservation: compression work & chemical heat release
            float rho_eff = (mat.density > 10.0f) ? mat.density : (use_davis_solid ? mat.davis_rho0 : 1630.0f);
            float de_comp = (tr_deps < 0.0f) ? -(p_mix / rho_eff) * tr_deps : 0.0f;
            float de_chem = d_lam * q_heat;
            p.e_int += de_comp + de_chem;

            float cv_eff = use_davis_solid ? (mat.davis_cv > 1.0f ? mat.davis_cv : 1000.0f) : (mat.Cp > 1.0f ? mat.Cp : 1000.0f);
            float t0_eff = use_davis_solid ? mat.davis_t0 : mat.T_room;
            p.temperature = t0_eff + p.e_int / cv_eff;


            // Deviatoric shear stress relaxation with radial return plasticity
            float sig_base[3][3];
            rotate_stress_cayley_3d(p.sigma, W, dt, sig_base);

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

        // --- Johnson-Cook Plasticity + Mie-Grüneisen Shock EOS Model ---
        if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen) {
            float w_factor = (mat.enable_heterogeneity && p.weibull_factor > 0.001f) ? p.weibull_factor : 1.0f;

            const float J = std::max(0.25f, p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f));
            const float mu_vol = (1.0f - J) / J;

            // 1. Mie-Grüneisen Shock EOS Hydrostatic Pressure
            float p_hydro = 0.0f;
            if (mu_vol > 0.0f) {
                p_hydro = Blast::Materials::mie_gruneisen_compression_pressure<float>(
                    mat.density, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mu_vol, p.e_int);
            } else {
                p_hydro = mat.density * mat.mg_c0 * mat.mg_c0 * mu_vol;
            }

            // 2. Orthogonal Cayley Stress Rotation
            float sig_base[3][3];
            rotate_stress_cayley_3d(p.sigma, W, dt, sig_base);

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
                // Melted metal behaves hydrodynamically: zero deviatoric shear stress while preserving affine B_p
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c) {
                        p.sigma[r][c] = (r == c) ? -p_hydro : 0.0f;
                    }
                return;
            }

            float strain_term = A + B * std::pow(std::max(0.0f, p.ep_bar), n);
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

            const float fail_strain_base = ((mat.enable_strain_erosion && mat.erosion_strain > 0.0f) ? mat.erosion_strain : mat.failure_strain) * w_factor * aniso_factor;
            const float tensile_fail_base = ((mat.enable_stress_erosion && mat.erosion_stress > 0.0f) ? mat.erosion_stress : mat.tensile_failure_stress) * w_factor * aniso_factor;
            const float p_spall_limit = std::max(tensile_fail_base, 1.5f * mat.jc_A * w_factor * aniso_factor);
            const float p_hydro_raw = p_hydro;
            if (p_spall_limit > 0.0f && p_hydro < 0.0f) {
                p_hydro = std::max(p_hydro, -p_spall_limit * std::max(0.0f, 1.0f - p.damage));
            }

            // Johnson-Cook flow stress: damage uncoupled until fracture (D = 1); Weibull scatter applies to
            // fracture thresholds only, never to ductile plastic flow.
            float jc_yield = strain_term * rate_term * temp_term * aniso_factor;

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
            (void)ep_smoothed;

            if (delta_ep > 0.0f && mat.density > 0.0f && mat.Cp > 0.0f) {
                float dw_p = jc_yield * delta_ep;
                float de_p = (0.90f * dw_p) / mat.density;
                p.e_int += de_p;
                p.temperature = mat.T_room + p.e_int / mat.Cp;
            }

            // 5. Thermal Re-Welding / Healing Rule or Johnson-Cook Damage Accumulation
            if (p.temperature >= 0.80f * mat.T_melt && p_hydro > 0.0f) {
                p.damage = 0.0f;
                p.has_failed = false;
            } else {
                const float jc_flow_undamaged = std::max(strain_term * rate_term * temp_term * aniso_factor, 1.0e6f);
                const float sigma_star = std::clamp(-p_hydro_raw / jc_flow_undamaged, -2.5f, 2.5f);
                const float jc_triax = std::max(0.02f, mat.jc_d1 + mat.jc_d2 * std::exp(mat.jc_d3 * sigma_star));
                const float triax_ratio = Blast::Materials::jc_fracture_triaxiality_ratio<float>(mat.jc_d1, mat.jc_d2, mat.jc_d3, sigma_star);
                const float jc_rate_f = std::max(0.1f, 1.0f + mat.jc_d4 * std::log( std::max(1.0f, eps_dot_star) ));
                const float jc_temp_f = std::max(0.1f, 1.0f + mat.jc_d5 * T_star);
                const float eps_f = (fail_strain_base > 0.0f && mat.jc_d1 <= 0.20f)
                    ? std::max(0.01f, fail_strain_base * triax_ratio * jc_rate_f * jc_temp_f)
                    : std::max(0.01f, jc_triax * jc_rate_f * jc_temp_f * w_factor * aniso_factor);

                if (delta_ep > 0.0f && eps_f > 0.0f) {
                    p.damage = std::min(1.0f, p.damage + delta_ep / eps_f);
                }
                if (mat.enable_strain_erosion && fail_strain_base > 0.0f) {
                    p.damage = std::max(p.damage, std::clamp(p.ep_bar / fail_strain_base, 0.0f, 1.0f));
                }

                if (p_spall_limit > 0.0f && (-p_hydro_raw) > p_spall_limit) {
                    if (mat.enable_stress_erosion) {
                        p.damage = std::max(p.damage, std::min((-p_hydro_raw) / p_spall_limit, 1.0f));
                    } else if (J > 1.025f && tr_deps > 0.0f) {
                        float spall_over = ((-p_hydro_raw) - p_spall_limit) / p_spall_limit;
                        p.damage = std::min(1.0f, p.damage + 0.5f * spall_over);
                    }
                }
            }

            if (p_spall_limit > 0.0f && p_hydro < 0.0f) {
                p_hydro = std::max(p_hydro, -p_spall_limit * std::max(0.0f, 1.0f - p.damage));
            }

            if (p.damage >= 1.0f) {
                p.has_failed = true;
                p.damage = 1.0f;
                if (p.V > p.V0) {
                    p.V = p.V0;
                    if (m_transfer_scheme == MPMTransferScheme::GIMP) {
                        float lp_f = 0.5f * std::cbrt(p.V);
                        p.lp[0] = lp_f; p.lp[1] = lp_f; p.lp[2] = lp_f;
                    }
                }

                // Fractured metal: compressive parent-EOS pressure plus confined Coulomb residual shear
                const float J_eff = p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f);
                float p_comp = 0.0f;
                if (J_eff < 1.0f) {
                    if (mat.mg_c0 > 0.0f) {
                        const float mu_vol = (1.0f - J_eff) / std::max(0.25f, J_eff);
                        p_comp = std::max(0.0f, Blast::Materials::mie_gruneisen_compression_pressure<float>(
                            mat.density, mat.mg_c0, mat.mg_s, mat.mg_gamma0, mu_vol, p.e_int));
                    } else {
                        const float E_mod_d  = mat.youngs_modulus > 0.0f ? mat.youngs_modulus : 200.0e9f;
                        const float nu_d     = std::clamp(mat.poissons_ratio, 0.01f, 0.49f);
                        const float K_parent = E_mod_d / (3.0f * (1.0f - 2.0f * nu_d));
                        p_comp = K_parent * (1.0f - J_eff) / std::max(0.01f, J_eff);
                    }
                }
                const float q_res = Blast::Materials::fractured_metal_residual_strength<float>(p_comp, mat.jc_A, false);
                float s_s_f = 0.0f;
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        s_s_f += s_trial[r][c] * s_trial[r][c];
                const float q_cur = std::sqrt(1.5f * s_s_f);
                const float s_scale = (q_cur > q_res && q_cur > 1.0e-7f) ? (q_res / q_cur) : 1.0f;
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        s_trial[r][c] *= s_scale;
                for (int r = 0; r < 3; ++r)
                    s_trial[r][r] -= p_comp;
                p.sigma = s_trial;
                return;
            }

            for (int r = 0; r < 3; ++r)
                s_trial[r][r] -= p_hydro;
            p.sigma = s_trial;
            return;
        }

        // --- Concrete / Geotechnical / Generic Hypoelastic Plasticity Models ---
        // 1. Orthogonal Cayley Stress Rotation
        float sig_base[3][3];
        rotate_stress_cayley_3d(p.sigma, W, dt, sig_base);

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
            const float fail_strain_base = ((mat.enable_strain_erosion && mat.erosion_strain > 0.0f) ? mat.erosion_strain : mat.failure_strain) * w_factor * aniso_factor;
            const float fail_stress = ((mat.enable_stress_erosion && mat.erosion_stress > 0.0f) ? mat.erosion_stress : mat.tensile_failure_stress) * w_factor * aniso_factor;
            const float p_spall_hypo = std::max(fail_stress, 1.5f * yield_base * aniso_factor);
            const float press_raw = press;
            if (p_spall_hypo > 0.0f && press < 0.0f) {
                press = std::max(press, -p_spall_hypo * std::max(0.0f, 1.0f - p.damage));
            }

            const float soft_factor = std::clamp(1.0f - 0.70f * p.damage, 0.10f, 1.0f);
            const float yield_eff = (yield_base * soft_factor + mat.hardening_modulus * p.ep_bar) * aniso_factor;
            const float yield_surf = q_trial_hypo - yield_eff;

            float delta_ep = 0.0f;
            if (q_trial_hypo > 1.0e-5f && yield_surf > 0.0f) {
                // Radial return mapping
                delta_ep = yield_surf / (3.0f * mu + mat.hardening_modulus);
                float scale = 1.0f - (3.0f * mu * delta_ep) / q_trial_hypo;
                if (scale < 0.0f) scale = 0.0f;
                for (int r = 0; r < 3; ++r)
                    for (int c = 0; c < 3; ++c)
                        s[r][c] *= scale;
                p.ep_bar += delta_ep;
            }
            for (int r = 0; r < 3; ++r)
                s[r][r] -= press;
            p.sigma = s;

            if (delta_ep > 0.0f && fail_strain_base > 0.0f) {
                const float sigma_star_h = std::clamp(-press_raw / std::max(yield_base * aniso_factor, 1.0e6f), -2.5f, 2.5f);
                const float triax_mult = (sigma_star_h >= 0.33f) ? 1.0f : ((sigma_star_h >= 0.0f) ? (2.0f - 3.0f * sigma_star_h) : 4.0f);
                p.damage = std::min(1.0f, p.damage + delta_ep / std::max(0.01f, fail_strain_base * triax_mult));
            }
            if (mat.enable_strain_erosion && fail_strain_base > 0.0f) {
                p.damage = std::max(p.damage, std::clamp(p.ep_bar / fail_strain_base, 0.0f, 1.0f));
            }
            if (p_spall_hypo > 0.0f && (-press_raw) > p_spall_hypo) {
                if (mat.enable_stress_erosion) {
                    p.damage = std::max(p.damage, std::min((-press_raw) / p_spall_hypo, 1.0f));
                } else if (p.ep_bar > 0.005f || (p.V > 1.03f * p.V0)) {
                    float spall_over = ((-press_raw) - p_spall_hypo) / p_spall_hypo;
                    p.damage = std::min(1.0f, p.damage + 0.5f * spall_over);
                }
            }
        }

        if (p.damage >= 1.0f) {
            p.has_failed = true;
            p.damage = 1.0f;
            if (p.V > p.V0) {
                p.V = p.V0;
                if (m_transfer_scheme == MPMTransferScheme::GIMP) {
                    float lp_f = 0.5f * std::cbrt(p.V);
                    p.lp[0] = lp_f; p.lp[1] = lp_f; p.lp[2] = lp_f;
                }
            }

            // Calculate compressive hydrostatic pressure from parent EOS for this step
            const float J = p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f);
            float p_comp = 0.0f;
            if (J < 1.0f) {
                if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen && mat.mg_c0 > 0.0f) {
                    const float s_minus_1 = std::max(mat.mg_s - 1.0f, 0.05f);
                    const float mu_max = 0.85f / s_minus_1;
                    const float mu_vol = (1.0f - J) / std::max(0.25f, J);
                    const float mu_eff = std::min(mu_vol, mu_max);
                    float denom = 1.0f - s_minus_1 * mu_eff;
                    if (denom < 0.15f) denom = 0.15f;
                    float p_hugoniot = (mat.density * mat.mg_c0 * mat.mg_c0 * mu_eff * (1.0f + (1.0f - 0.5f * mat.mg_gamma0) * mu_eff)) / (denom * denom);
                    if (mu_vol > mu_max) {
                        float K_high = mat.density * mat.mg_c0 * mat.mg_c0 * (1.0f + 2.0f * mat.mg_s * mu_max);
                        p_hugoniot += K_high * (mu_vol - mu_max);
                    }
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
        if (mat.material_model == MPMMaterialModel::TaitWater) {
            float J_val = p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f);
            float rho_p = mat.tait_rho0 / std::max(0.05f, J_val);
            c_s = Blast::TaitEOSWater::compute_sound_speed_unified(rho_p, p.sigma[0][0], p.e_int, static_cast<Blast::TaitVariant>(mat.tait_variant), mat.tait_B, mat.tait_gamma, mat.tait_rho0, mat.tait_c0, mat.tait_gruneisen);
        } else if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen) {
            float C0 = mat.mg_c0;
            c_s = std::sqrt(C0 * C0 + (2.0f / 3.0f) * E / (rho * (1.0f + nu)));
        } else if (mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
                   mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
                   mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth) {
            float C0 = (mat.solid_model == SolidReactantEOS::DavisSolid) ? mat.davis_c0 : (mat.mg_c0 > 100.0f ? mat.mg_c0 : 2500.0f);
            float c_det = (mat.product_model == DetonationProductEOS::DavisProduct) ? ((mat.davis_pc > 1.0e6f) ? 7500.0f : 6000.0f) : (mat.det_vel > 1000.0f ? mat.det_vel : 6930.0f);
            float lam = p.lambda;
            if (lam >= 1.0f) {
                float v_rel = std::max(p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f), 0.02f);
                float p_p = -0.33333334f * (p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]);
                p_p = std::max(1.0f, p_p);
                bool use_davis_solid = (mat.solid_model == SolidReactantEOS::DavisSolid) || (mat.material_model == MPMMaterialModel::CRESTReactiveBurn);
                bool use_davis_prod = (mat.product_model == DetonationProductEOS::DavisProduct) || (mat.material_model == MPMMaterialModel::CRESTReactiveBurn);
                float rho_ref = (mat.density > 10.0f) ? mat.density : (use_davis_solid ? mat.davis_rho0 : 1630.0f);
                if (use_davis_prod) {
                    float gamma_eff = mat.davis_k + 1.0f;
                    float rho_cur = rho_ref / v_rel;
                    c_s = std::sqrt(std::max(100.0f, gamma_eff * p_p / rho_cur));
                } else {
                    c_s = JWL::computeJWLSoundSpeed(v_rel, p_p, mat.jwl_A, mat.jwl_B, mat.jwl_R1, mat.jwl_R2, mat.jwl_omega, rho_ref);
                }
            } else if (lam > 0.0f) {
                c_s = c_det;
            } else {
                c_s = C0;
            }
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

void MPMSolver3D::storeFSIForces() {
    size_t num_nodes = m_grid.size();
    if (m_f_ext_fsi.size() != num_nodes * 3) {
        m_f_ext_fsi.resize(num_nodes * 3, 0.0f);
    }
    for (size_t i = 0; i < num_nodes; ++i) {
        m_f_ext_fsi[i * 3 + 0] = m_grid[i].f_ext[0];
        m_f_ext_fsi[i * 3 + 1] = m_grid[i].f_ext[1];
        m_f_ext_fsi[i * 3 + 2] = m_grid[i].f_ext[2];
    }
}

void MPMSolver3D::restoreFSIForces() {
    size_t num_nodes = m_grid.size();
    if (m_f_ext_fsi.size() != num_nodes * 3) return;
    for (size_t i = 0; i < num_nodes; ++i) {
        m_grid[i].f_ext[0] = m_f_ext_fsi[i * 3 + 0];
        m_grid[i].f_ext[1] = m_f_ext_fsi[i * 3 + 1];
        m_grid[i].f_ext[2] = m_f_ext_fsi[i * 3 + 2];
    }
}

void MPMSolver3D::clearFSIForces() {
    std::fill(m_f_ext_fsi.begin(), m_f_ext_fsi.end(), 0.0f);
}

void MPMSolver3D::stepWithDt(float dt, bool run_p2g) {
    if (m_particles.empty()) return;
    for (auto& mat : m_material_tables) {
        mat.synchronizePillars();
    }
    m_last_dt = dt;
    m_sim_time += static_cast<double>(dt);
    m_step_count++;

    auto doGridKinematics = [this](float sub_dt) {
        if (m_contact_method == MPMContactMethod::MultiVelocityBardenhagen) {
            updateGridKinematicsBardenhagen(sub_dt);
        } else {
            updateGridKinematics(sub_dt);
        }
        if (m_grid_kinematics_callback) {
            m_grid_kinematics_callback(sub_dt);
        }
    };

    auto applyGravityToGrid = [this]() {
        if (m_has_gravity) {
            for (auto& node : m_grid) {
                if (node.m > MPMGridNode3D::MIN_MASS) {
                    node.f_ext[0] += node.m * m_gravity[0];
                    node.f_ext[1] += node.m * m_gravity[1];
                    node.f_ext[2] += node.m * m_gravity[2];
                }
            }
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
        if (!m_f_ext_fsi.empty()) {
            restoreFSIForces();
        }
        applyGravityToGrid();
        doGridKinematics(0.5f * dt);
        gridToParticleAndStress(0.5f * dt);

        // 2. Corrector Stage: full step from t^{n+1/2} state to t^{n+1}
        // Grid kinematics uses full dt for acceleration; particles advance by dt/2
        // (midpoint rule: position updated once at dt/2 in predictor, once at dt/2 here).
        particleToGrid();
        if (!m_f_ext_fsi.empty()) {
            restoreFSIForces();
        }
        applyGravityToGrid();
        doGridKinematics(dt);
        updateDetonators(dt);
        gridToParticleAndStress(dt * 0.5f);
    } else {
        // --- 2nd-Order Symplectic Staggered Leapfrog / USL (Single-pass) ---
        if (run_p2g) {
            for (auto& node : m_grid) {
                node.f_ext[0] = 0.0f; node.f_ext[1] = 0.0f; node.f_ext[2] = 0.0f;
            }
            particleToGrid();
        }
        if (!m_f_ext_fsi.empty()) {
            restoreFSIForces();
        }
        applyGravityToGrid();
        
        if (m_time_scheme == MPMTimeIntegrationScheme::USF) {
            // USF: Update Stress First
            doGridKinematics(dt);
            updateDetonators(dt);
            gridToParticleAndStress(dt);
        } else {
            // USL: Update Stress Last (default)
            doGridKinematics(dt);
            updateDetonators(dt);
            gridToParticleAndStress(dt);
        }
    }

    // 3. Resolve Discrete Element (DEM) Contact & Collisions
    if (m_contact_method == MPMContactMethod::SubGridDEM || m_enable_dem_contact) {
        evaluateDEMContact(dt);
    }

    if (m_step_count % 10 == 0) {
        updateFragmentClusters();
    }
}

void MPMSolver3D::evaluateDEMContact(float dt) {
    if ((!m_enable_dem_contact && m_contact_method != MPMContactMethod::SubGridDEM) || m_particles.empty() || dt <= 1.0e-12f) return;

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
        if (p.object_id >= 0 && static_cast<size_t>(p.object_id) < m_material_tables.size()) {
            if (m_material_tables[p.object_id].material_model == MPMMaterialModel::TaitWater) continue;
        }

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
                                if (q.object_id >= 0 && static_cast<size_t>(q.object_id) < m_material_tables.size()) {
                                    if (m_material_tables[q.object_id].material_model == MPMMaterialModel::TaitWater) {
                                        j = m_dem_particle_next[j];
                                        continue;
                                    }
                                }
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

                                                    float dv_mag_p = std::sqrt(dv_p_x * dv_p_x + dv_p_y * dv_p_y + dv_p_z * dv_p_z);
                                                    float cell_dx = std::min({m_dx, m_dy, m_dz});
                                                    if (cell_dx < 1.0e-4f) cell_dx = 0.004f;
                                                    float dv_limit = std::min(std::abs(v_n), 0.5f * (cell_dx / std::max(dt, 1.0e-12f)));
                                                    if (dv_mag_p > dv_limit && dv_mag_p > 1.0e-7f) {
                                                        float scale = dv_limit / dv_mag_p;
                                                        dv_p_x *= scale;
                                                        dv_p_y *= scale;
                                                        dv_p_z *= scale;
                                                        Jx *= scale;
                                                        Jy *= scale;
                                                        Jz *= scale;
                                                    }

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
    auto& mat = m_material_tables[obj_id];
    int eff_ts = mat.transfer_scheme;
    if (m_transfer_scheme != MPMTransferScheme::Standard) {
        if (eff_ts < 0 || eff_ts == static_cast<int>(MPMTransferScheme::BSpline)) {
            eff_ts = static_cast<int>(m_transfer_scheme);
        }
    } else if (eff_ts < 0) {
        eff_ts = static_cast<int>(MPMTransferScheme::BSpline);
    }
    mat.transfer_scheme = eff_ts;
    for (auto& p : m_particles) {
        if (p.object_id == obj_id) {
            p.transfer_scheme = eff_ts;
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
    for (auto& mat : m_material_tables) {
        mat.synchronizePillars();
    }
    float dt = computeStepSize(cfl);
    if (m_step_count == 0) {
        dt = 0.5f * dt;
    } else {
        dt = std::min(dt, 1.5f * (m_last_dt > 0.0f ? m_last_dt : dt));
    }
    m_last_cfl = cfl;
    stepWithDt(dt);
}

MPMVTKSnapshot3D MPMSolver3D::extractVTKSnapshot(bool has_vel, bool has_stress, bool has_strain, bool has_damage, bool has_temp, bool has_pressure, bool has_material_id, bool has_object_id) const {
    MPMVTKSnapshot3D snap;
    size_t count = m_particles.size();
    snap.num_particles = static_cast<int>(count);
    snap.has_vel = has_vel;
    snap.has_stress = has_stress;
    snap.has_strain = has_strain;
    snap.has_damage = has_damage;
    snap.has_temp = has_temp;
    snap.has_pressure = has_pressure;
    snap.has_material_id = has_material_id;
    snap.has_object_id = has_object_id;

    if (count == 0) return snap;

    snap.points.resize(count * 3);
    if (has_vel) snap.vel.resize(count * 3);
    if (has_stress) snap.von_mises.resize(count);
    if (has_pressure) snap.pressure.resize(count);
    if (has_strain) snap.ep_bar.resize(count);
    if (has_damage) snap.damage.resize(count);
    if (has_temp) snap.temp.resize(count);
    if (has_object_id) snap.obj_id.resize(count);
    if (has_material_id) snap.material_id.resize(count);

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
        if (has_stress || has_pressure) {
            double mean_s = (p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0;
            if (has_stress) {
                double s00 = p.sigma[0][0] - mean_s;
                double s11 = p.sigma[1][1] - mean_s;
                double s22 = p.sigma[2][2] - mean_s;
                double s01 = p.sigma[0][1];
                double s12 = p.sigma[1][2];
                double s20 = p.sigma[2][0];
                snap.von_mises[i] = static_cast<float>(std::sqrt(1.5 * (s00*s00 + s11*s11 + s22*s22 + 2.0*(s01*s01 + s12*s12 + s20*s20))));
            }
            if (has_pressure) {
                snap.pressure[i] = static_cast<float>(-mean_s);
            }
        }
        if (has_strain) snap.ep_bar[i] = static_cast<float>(p.ep_bar);
        if (has_damage) snap.damage[i] = static_cast<float>(p.damage);
        if (has_temp) snap.temp[i] = static_cast<float>(p.temperature);
        if (has_object_id) snap.obj_id[i] = static_cast<uint8_t>(std::clamp(p.object_id, 0, 255));
        if (has_material_id) snap.material_id[i] = static_cast<uint8_t>(std::clamp(p.material_id, 0, 255));
    }
    return snap;
}

void MPMSolver3D::applyStratifiedInitialCondition(const Blast::Stratified3DParams& strat) {
    if (strat.gravity_z != 0.0) {
        setGravity(0.0f, 0.0f, static_cast<float>(strat.gravity_z));
    }
    float g_mag = std::abs(static_cast<float>(strat.gravity_z));
    if (g_mag < 1.0e-6f) g_mag = 9.81f;

    for (auto& mat : m_material_tables) {
        if (mat.material_model == MPMMaterialModel::TaitWater) {
            mat.tait_p0 = static_cast<float>(strat.p_atm);
        }
    }

    float p_atm = static_cast<float>(strat.p_atm);
    float z_surf = static_cast<float>(strat.water_surface_z);
    float z_bed = static_cast<float>(strat.seabed_surface_z);

    for (auto& p : m_particles) {
        float z_c = p.x[2];
        const MaterialTable3D* mat_ptr = nullptr;
        if (p.object_id >= 0 && static_cast<size_t>(p.object_id) < m_material_tables.size()) {
            mat_ptr = &m_material_tables[p.object_id];
        } else if (p.material_id >= 0 && static_cast<size_t>(p.material_id) < m_material_tables.size()) {
            mat_ptr = &m_material_tables[p.material_id];
        } else if (!m_material_tables.empty()) {
            mat_ptr = &m_material_tables[0];
        }

        float rho_water = (mat_ptr && mat_ptr->tait_rho0 > 0.0f) ? mat_ptr->tait_rho0 : static_cast<float>(strat.tait_rho0);
        float tait_B = (mat_ptr && mat_ptr->tait_B > 0.0f) ? mat_ptr->tait_B : static_cast<float>(strat.tait_B);
        float tait_gamma = (mat_ptr && mat_ptr->tait_gamma > 0.0f) ? mat_ptr->tait_gamma : static_cast<float>(strat.tait_gamma);

        bool is_water = (mat_ptr && mat_ptr->material_model == MPMMaterialModel::TaitWater);
        bool is_soil = (mat_ptr && mat_ptr->material_model == MPMMaterialModel::DruckerPragerSoil);
        bool is_energetic = (mat_ptr && (
            mat_ptr->material_model == MPMMaterialModel::CRESTReactiveBurn ||
            mat_ptr->material_model == MPMMaterialModel::JWLProgrammedBurn ||
            mat_ptr->material_model == MPMMaterialModel::LeeTarverIgnitionGrowth
        ));

        if (is_water) {
            if (z_c > z_surf) {
                p.sigma.setIsotropic(p_atm);
                p.rho = rho_water;
                p.J = 1.0f;
                p.V = p.V0;
            } else {
                float p_h = 0.0f, rho_h = 0.0f, e_h = 0.0f;
                Blast::TaitEOSWater::compute_hydrostatic_state(
                    z_c, z_surf, g_mag, p_atm,
                    p_h, rho_h, e_h, tait_B, tait_gamma, rho_water
                );
                p.rho = rho_h;
                p.J = rho_water / rho_h;
                p.V = p.V0 * p.J;
                p.sigma.setIsotropic(p_h);
                p.e_int = e_h;
            }
        } else if (is_soil) {
            double p_bed = static_cast<double>(p_atm + rho_water * g_mag * std::max(0.0f, z_surf - z_bed));
            double sig_v = 0.0, u_p = 0.0, sig_h = 0.0;
            Blast::TaitEOSWater::compute_geostatic_stress(
                static_cast<double>(z_c), static_cast<double>(z_bed), p_bed, strat.soil_density, static_cast<double>(rho_water),
                static_cast<double>(g_mag), strat.k0_earth_pressure,
                sig_v, u_p, sig_h
            );
            p.sigma[0][0] = -static_cast<float>(sig_h);
            p.sigma[1][1] = -static_cast<float>(sig_h);
            p.sigma[2][2] = -static_cast<float>(sig_v);
            p.sigma[0][1] = 0.0f;
            p.sigma[1][2] = 0.0f;
            p.sigma[2][0] = 0.0f;
            p.rho = static_cast<float>(strat.soil_density);
            p.J = 1.0f;
            p.V = p.V0;
        } else if (is_energetic) {
            // Energetic materials: protect detonation state and reference density.
            // If particle was already ignited at t=0, keep its detonation energy and CJ stress intact.
            // If unreacted solid, assign ambient hydrostatic confining stress from water column without overwriting density or volume.
            if (p.lambda <= 0.0f && p.e_int < 1.0e4f) {
                float p_h = p_atm;
                if (z_c <= z_surf) {
                    p_h += rho_water * g_mag * std::max(0.0f, z_surf - z_c);
                }
                p.sigma.setIsotropic(p_h);
            }
        } else {
            // Structural solid: maintain material reference density, apply ambient confining pressure if submerged.
            if (z_c <= z_surf) {
                float p_h = p_atm + rho_water * g_mag * std::max(0.0f, z_surf - z_c);
                p.sigma.setIsotropic(p_h);
            }
        }
    }
}

void MPMSolver3D::addDetonator(float x, float y, float z, float radius, float time_delay, bool track_velocity, int target_object_id) {
    MPMDetonator3D det;
    det.x = x;
    det.y = y;
    det.z = z;
    det.radius = radius;
    det.time_delay = time_delay;
    det.track_mpm_velocity = track_velocity;
    det.fired = false;
    det.target_object_id = target_object_id;
    m_detonators.push_back(det);
}

bool MPMSolver3D::interpolateGridVelocity(float x, float y, float z, float& vx, float& vy, float& vz) const {
    vx = 0.0f; vy = 0.0f; vz = 0.0f;
    if (m_grid.empty()) return false;

    float px = x - m_xmin;
    float py = y - m_ymin;
    float pz = z - m_zmin;

    if (px < 0.0f || px >= static_cast<float>(m_nx) * m_dx ||
        py < 0.0f || py >= static_cast<float>(m_ny) * m_dy ||
        pz < 0.0f || pz >= static_cast<float>(m_nz) * m_dz) {
        return false;
    }

    int base_i = static_cast<int>(std::floor(px / m_dx));
    int base_j = static_cast<int>(std::floor(py / m_dy));
    int base_k = static_cast<int>(std::floor(pz / m_dz));

    float Sx_arr[4], Sy_arr[4], Sz_arr[4];
    for (int offset = -1; offset <= 2; ++offset) {
        int idx = offset + 1;
        float nx_val = (static_cast<float>(base_i + offset) + 0.5f) * m_dx;
        Sx_arr[idx] = evalBSpline_S(px, nx_val, m_dx);

        float ny_val = (static_cast<float>(base_j + offset) + 0.5f) * m_dy;
        Sy_arr[idx] = evalBSpline_S(py, ny_val, m_dy);

        float nz_val = (static_cast<float>(base_k + offset) + 0.5f) * m_dz;
        Sz_arr[idx] = evalBSpline_S(pz, nz_val, m_dz);
    }

    float weight_sum = 0.0f;
    float sum_vx = 0.0f, sum_vy = 0.0f, sum_vz = 0.0f;

    for (int offset_i = -1; offset_i <= 2; ++offset_i) {
        int raw_i = base_i + offset_i;
        int i = raw_i;
        float sign_x = 1.0f;
        if (!resolve_ghost_node_3d(i, sign_x, m_nx, m_bc_x_min, m_bc_x_max)) continue;
        int i_idx = offset_i + 1;
        float Sx = Sx_arr[i_idx];
        if (std::abs(Sx) < 1.0e-7f) continue;

        for (int offset_j = -1; offset_j <= 2; ++offset_j) {
            int raw_j = base_j + offset_j;
            int j = raw_j;
            float sign_y = 1.0f;
            if (!resolve_ghost_node_3d(j, sign_y, m_ny, m_bc_y_min, m_bc_y_max)) continue;
            int j_idx = offset_j + 1;
            float Sy = Sy_arr[j_idx];
            if (std::abs(Sy) < 1.0e-7f) continue;

            for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                int raw_k = base_k + offset_k;
                int k = raw_k;
                float sign_z = 1.0f;
                if (!resolve_ghost_node_3d(k, sign_z, m_nz, m_bc_z_min, m_bc_z_max)) continue;
                int k_idx = offset_k + 1;
                float Sz = Sz_arr[k_idx];
                if (std::abs(Sz) < 1.0e-7f) continue;

                float weight = Sx * Sy * Sz;
                size_t node_idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                const auto& node = m_grid[node_idx];

                if (node.m > MPMGridNode3D::MIN_MASS) {
                    float n_vx = sign_x * node.v(0);
                    float n_vy = sign_y * node.v(1);
                    float n_vz = sign_z * node.v(2);
                    sum_vx += weight * n_vx;
                    sum_vy += weight * n_vy;
                    sum_vz += weight * n_vz;
                    weight_sum += weight;
                }
            }
        }
    }

    if (weight_sum > 1.0e-6f) {
        vx = sum_vx / weight_sum;
        vy = sum_vy / weight_sum;
        vz = sum_vz / weight_sum;
        return true;
    }
    return false;
}

void MPMSolver3D::updateDetonators(float dt) {
    if (m_detonators.empty()) return;

    for (auto& det : m_detonators) {
        // If tracking velocity and not yet fired, advect with grid velocity
        if (det.track_mpm_velocity && !det.fired) {
            float vx = 0.0f, vy = 0.0f, vz = 0.0f;
            if (interpolateGridVelocity(det.x, det.y, det.z, vx, vy, vz)) {
                det.x += vx * dt;
                det.y += vy * dt;
                det.z += vz * dt;
            }
        }

        // Check if ignition delay has expired
        if (!det.fired && static_cast<float>(m_sim_time) >= det.time_delay) {
            fireDetonator(det);
            det.fired = true;
        }
    }
}

void MPMSolver3D::fireDetonator(MPMDetonator3D& det) {
    float det_x = det.x;
    float det_y = det.y;
    float det_z = det.z;
    float det_r = det.radius;

    for (auto& p : m_particles) {
        if (det.target_object_id >= 0 && p.object_id != det.target_object_id) {
            continue;
        }

        const MaterialTable3D* mat_ptr = nullptr;
        if (p.object_id >= 0 && static_cast<size_t>(p.object_id) < m_material_tables.size()) {
            mat_ptr = &m_material_tables[p.object_id];
        } else if (p.material_id >= 0 && static_cast<size_t>(p.material_id) < m_material_tables.size()) {
            mat_ptr = &m_material_tables[p.material_id];
        } else if (!m_material_tables.empty()) {
            mat_ptr = &m_material_tables[0];
        }
        if (!mat_ptr) continue;
        const auto& mat = *mat_ptr;

        bool is_energetic = (mat.material_model == MPMMaterialModel::JWLProgrammedBurn ||
                             mat.material_model == MPMMaterialModel::CRESTReactiveBurn ||
                             mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth);
        if (!is_energetic) continue;

        float dx = p.x[0] - det_x;
        float dy = p.x[1] - det_y;
        float dz = p.x[2] - det_z;
        float dist = std::sqrt(dx * dx + dy * dy + dz * dz);
        float eff_dist = (det_r > 0.0f) ? std::max(0.0f, dist - det_r) : dist;

        if (mat.material_model == MPMMaterialModel::JWLProgrammedBurn) {
            float det_v = std::max(mat.det_vel, 100.0f);
            float t_arr = static_cast<float>(m_sim_time) + eff_dist / det_v;
            p.t_arrival = std::min(p.t_arrival, t_arr);

            float core_radius = std::max(det_r, 1.5f * m_dx);
            if (dist <= core_radius) {
                p.lambda = 1.0f;
                p.e_int = mat.detonation_energy;
                float v_ratio = (p.V0 > 0.0f) ? (p.V / p.V0) : 1.0f;
                float p_init = Blast::JWL::computeJWLProductPressure(
                    v_ratio, mat.detonation_energy,
                    mat.jwl_A, mat.jwl_B, mat.jwl_R1, mat.jwl_R2,
                    mat.jwl_omega, mat.density
                );
                p.sigma.setIsotropic(-p_init);
            }
        } else if (mat.material_model == MPMMaterialModel::CRESTReactiveBurn) {
            float trigger_radius = std::max(det_r, 2.5f * m_dx);
            if (dist <= trigger_radius) {
                p.s_shock = 1.5f * mat.crest_s_threshold;
                p.lambda = 1.0f;
                p.e_int = std::max(mat.davis_q_det, mat.detonation_energy);
                p.v_min = (mat.davis_vc > 0.1f) ? mat.davis_vc : 0.70f;
                p.V = p.v_min * p.V0;
                float p_init = ((mat.davis_pc > 1.0e6f) ? mat.davis_pc : 15.0e9f);
                p.sigma.setIsotropic(-p_init);
                p.t_arrival = static_cast<float>(m_sim_time);
            }
        } else if (mat.material_model == MPMMaterialModel::LeeTarverIgnitionGrowth) {
            float trigger_radius = std::max(det_r, 2.5f * m_dx);
            if (dist <= trigger_radius) {
                p.lambda = 1.0f;
                p.e_int = mat.detonation_energy;
                p.sigma.setIsotropic(-20.0e9f);
                p.t_arrival = static_cast<float>(m_sim_time);
            }
        }
    }
}

} // namespace Blast
