#include "mpm_solver_3d.hpp"
#include "ImmersedBoundary.hpp"

namespace Blast {

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

void MPMSolver3D::addBoxObject(int obj_id, float pos_x, float pos_y, float pos_z,
                               float size_x, float size_y, float size_z,
                               float vel_x, float vel_y, float vel_z,
                               float angular_vel_x, float angular_vel_y, float angular_vel_z,
                               float density, float E, float nu,
                               float yield_stress, float hardening, float failure_strain,
                               float tensile_failure_stress, int ppc) {
    int particles_per_dim = static_cast<int>(std::round(std::cbrt(static_cast<float>(ppc))));
    if (particles_per_dim < 1) particles_per_dim = 2;

    float p_dx = m_dx / static_cast<float>(particles_per_dim);
    float p_dy = m_dy / static_cast<float>(particles_per_dim);
    float p_dz = m_dz / static_cast<float>(particles_per_dim);

    float min_x = pos_x - 0.5f * size_x;
    float max_x = pos_x + 0.5f * size_x;
    float min_y = pos_y - 0.5f * size_y;
    float max_y = pos_y + 0.5f * size_y;
    float min_z = pos_z - 0.5f * size_z;
    float max_z = pos_z + 0.5f * size_z;

    float p_vol = p_dx * p_dy * p_dz;
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

    for (float x = min_x + 0.5f * p_dx; x < max_x; x += p_dx) {
        for (float y = min_y + 0.5f * p_dy; y < max_y; y += p_dy) {
            for (float z = min_z + 0.5f * p_dz; z < max_z; z += p_dz) {
                MPMParticle3D p{};
                p.x[0] = x; p.x[1] = y; p.x[2] = z;

                float rx = x - pos_x;
                float ry = y - pos_y;
                float rz = z - pos_z;

                // Rigid body velocity v = v_trans + omega x r
                p.v[0] = vel_x + (angular_vel_y * rz - angular_vel_z * ry);
                p.v[1] = vel_y + (angular_vel_z * rx - angular_vel_x * rz);
                p.v[2] = vel_z + (angular_vel_x * ry - angular_vel_y * rx);

                // Skew-symmetric angular velocity matrix B = [  0 -wz  wy]
                //                                            [ wz   0 -wx]
                //                                            [-wy  wx   0]
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
                                  float tensile_failure_stress, int ppc) {
    int particles_per_dim = static_cast<int>(std::round(std::cbrt(static_cast<float>(ppc))));
    if (particles_per_dim < 1) particles_per_dim = 2;

    float p_dx = m_dx / static_cast<float>(particles_per_dim);
    float p_dy = m_dy / static_cast<float>(particles_per_dim);
    float p_dz = m_dz / static_cast<float>(particles_per_dim);

    float min_x = pos_x - radius; float max_x = pos_x + radius;
    float min_y = pos_y - radius; float max_y = pos_y + radius;
    float min_z = pos_z - radius; float max_z = pos_z + radius;

    float r2 = radius * radius;
    float p_vol = p_dx * p_dy * p_dz;
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

    for (float x = min_x + 0.5f * p_dx; x < max_x; x += p_dx) {
        for (float y = min_y + 0.5f * p_dy; y < max_y; y += p_dy) {
            for (float z = min_z + 0.5f * p_dz; z < max_z; z += p_dz) {
                float rx = x - pos_x;
                float ry = y - pos_y;
                float rz = z - pos_z;
                if (rx * rx + ry * ry + rz * rz <= r2) {
                    MPMParticle3D p{};
                    p.x[0] = x; p.x[1] = y; p.x[2] = z;

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

                    m_particles.push_back(p);
                }
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
                                      float tensile_failure_stress, int ppc) {
    int particles_per_dim = static_cast<int>(std::round(std::cbrt(static_cast<float>(ppc))));
    if (particles_per_dim < 1) particles_per_dim = 2;

    float p_dx = m_dx / static_cast<float>(particles_per_dim);
    float p_dy = m_dy / static_cast<float>(particles_per_dim);
    float p_dz = m_dz / static_cast<float>(particles_per_dim);

    float min_x = pos_x - radius; float max_x = pos_x + radius;
    float min_y = pos_y - radius; float max_y = pos_y + radius;
    float half_h = 0.5f * height;
    float min_z = pos_z - half_h; float max_z = pos_z + half_h;

    float r_outer2 = radius * radius;
    float r_inner2 = inner_radius * inner_radius;
    float p_vol = p_dx * p_dy * p_dz;
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

    for (float x = min_x + 0.5f * p_dx; x < max_x; x += p_dx) {
        for (float y = min_y + 0.5f * p_dy; y < max_y; y += p_dy) {
            for (float z = min_z + 0.5f * p_dz; z < max_z; z += p_dz) {
                float rx = x - pos_x;
                float ry = y - pos_y;
                float rz = z - pos_z;
                float r2 = rx * rx + ry * ry;
                if (r2 <= r_outer2 && r2 >= r_inner2 && std::abs(rz) <= half_h) {
                    MPMParticle3D p{};
                    p.x[0] = x; p.x[1] = y; p.x[2] = z;

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

                    m_particles.push_back(p);
                }
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
                              float tensile_failure_stress, int ppc) {
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

    float p_dx = m_dx / static_cast<float>(particles_per_dim);
    float p_dy = m_dy / static_cast<float>(particles_per_dim);
    float p_dz = m_dz / static_cast<float>(particles_per_dim);

    float p_vol = p_dx * p_dy * p_dz;
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

    std::cout << "[INFO] MPMSolver3D::addSTLObject loaded " << triangles.size() << " triangles. Sampling interior particles..." << std::endl;
    size_t particle_count_before = m_particles.size();

    for (float y = min_y + 0.5f * p_dy; y < max_y; y += p_dy) {
        int by = std::clamp(static_cast<int>(std::floor((y - min_y) / p_dy)), 0, ny_bins - 1);
        for (float z = min_z + 0.5f * p_dz; z < max_z; z += p_dz) {
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

            for (float x = min_x + 0.5f * p_dx; x < max_x; x += p_dx) {
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

        for (int offset_i = -1; offset_i <= 2; ++offset_i) {
            int i = base_i + offset_i;
            if (i < 0 || i >= m_nx) continue;
            float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

            float Sx = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                       evalGIMP_S(px, node_x, m_dx, p.lp[0]) :
                       ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_S(px, node_x, m_dx) :
                       std::max(0.0f, 1.0f - std::abs(px - node_x) / m_dx));

            float dSx = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                        evalGIMP_dS(px, node_x, m_dx, p.lp[0]) :
                        ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_dS(px, node_x, m_dx) :
                        (px >= node_x ? -1.0f / m_dx : 1.0f / m_dx));

            if (std::abs(Sx) < 1.0e-7f) continue;

            for (int offset_j = -1; offset_j <= 2; ++offset_j) {
                int j = base_j + offset_j;
                if (j < 0 || j >= m_ny) continue;
                float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                float Sy = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                           evalGIMP_S(py, node_y, m_dy, p.lp[1]) :
                           ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_S(py, node_y, m_dy) :
                           std::max(0.0f, 1.0f - std::abs(py - node_y) / m_dy));

                float dSy = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                            evalGIMP_dS(py, node_y, m_dy, p.lp[1]) :
                            ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_dS(py, node_y, m_dy) :
                            (py >= node_y ? -1.0f / m_dy : 1.0f / m_dy));

                if (std::abs(Sy) < 1.0e-7f) continue;

                for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                    int k = base_k + offset_k;
                    if (k < 0 || k >= m_nz) continue;
                    float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

                    float Sz = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                               evalGIMP_S(pz, node_z, m_dz, p.lp[2]) :
                               ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_S(pz, node_z, m_dz) :
                               std::max(0.0f, 1.0f - std::abs(pz - node_z) / m_dz));

                    float dSz = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                                evalGIMP_dS(pz, node_z, m_dz, p.lp[2]) :
                                ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_dS(pz, node_z, m_dz) :
                                (pz >= node_z ? -1.0f / m_dz : 1.0f / m_dz));

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
                                        float w = 1.0f / static_cast<float>(std::abs(di) + std::abs(dj) + std::abs(dk));
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
        for (size_t idx = 0; idx < m_grid.size(); ++idx) {
            if (m_grid[idx].m > MPMGridNode3D::MIN_MASS) {
                m_grid[idx].plastic_strain = smoothed_ep[idx];
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
    float d_scale = (m_transfer_scheme == MPMTransferScheme::BSpline) ? 4.0f : 3.0f;
    float D_inv_x = d_scale / (m_dx * m_dx);
    float D_inv_y = d_scale / (m_dy * m_dy);
    float D_inv_z = d_scale / (m_dz * m_dz);

    float max_B = 5000.0f / std::min({m_dx, m_dy, m_dz});

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
        float ep_grid_sum = 0.0f;

        // Pass 1: Interpolate PIC velocity, true FLIP acceleration increment & smoothed plastic strain
        for (int offset_i = -1; offset_i <= 2; ++offset_i) {
            int i = base_i + offset_i;
            if (i < 0 || i >= m_nx) continue;
            float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

            float Sx = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                       evalGIMP_S(px, node_x, m_dx, p.lp[0]) :
                       ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_S(px, node_x, m_dx) :
                       std::max(0.0f, 1.0f - std::abs(px - node_x) / m_dx));

            float dSx = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                        evalGIMP_dS(px, node_x, m_dx, p.lp[0]) :
                        ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_dS(px, node_x, m_dx) :
                        (px >= node_x ? -1.0f / m_dx : 1.0f / m_dx));

            if (std::abs(Sx) < 1.0e-7f) continue;

            for (int offset_j = -1; offset_j <= 2; ++offset_j) {
                int j = base_j + offset_j;
                if (j < 0 || j >= m_ny) continue;
                float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                float Sy = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                           evalGIMP_S(py, node_y, m_dy, p.lp[1]) :
                           ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_S(py, node_y, m_dy) :
                           std::max(0.0f, 1.0f - std::abs(py - node_y) / m_dy));

                float dSy = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                            evalGIMP_dS(py, node_y, m_dy, p.lp[1]) :
                            ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_dS(py, node_y, m_dy) :
                            (py >= node_y ? -1.0f / m_dy : 1.0f / m_dy));

                if (std::abs(Sy) < 1.0e-7f) continue;

                for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                    int k = base_k + offset_k;
                    if (k < 0 || k >= m_nz) continue;
                    float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

                    float Sz = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                               evalGIMP_S(pz, node_z, m_dz, p.lp[2]) :
                               ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_S(pz, node_z, m_dz) :
                               std::max(0.0f, 1.0f - std::abs(pz - node_z) / m_dz));

                    float dSz = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                                evalGIMP_dS(pz, node_z, m_dz, p.lp[2]) :
                                ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_dS(pz, node_z, m_dz) :
                                (pz >= node_z ? -1.0f / m_dz : 1.0f / m_dz));

                    if (std::abs(Sz) < 1.0e-7f) continue;

                    float weight = Sx * Sy * Sz;
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

                        ep_grid_sum += weight * node.plastic_strain;
                        weight_sum += weight;
                    }
                }
            }
        }

        if (weight_sum <= 1.0e-7f) {
            v_pic_x = p.v[0]; v_pic_y = p.v[1]; v_pic_z = p.v[2];
            delta_v_grid_x = 0.0f; delta_v_grid_y = 0.0f; delta_v_grid_z = 0.0f;
        } else {
            float inv_w = 1.0f / weight_sum;
            v_pic_x *= inv_w;
            v_pic_y *= inv_w;
            v_pic_z *= inv_w;
            delta_v_grid_x *= inv_w;
            delta_v_grid_y *= inv_w;
            delta_v_grid_z *= inv_w;
        }

        // Pass 2: APIC 3x3 affine velocity matrix B_p and spatial gradient L_grad calculation
        float B_new[3][3] = {{0,0,0},{0,0,0},{0,0,0}};
        float L_new[3][3] = {{0,0,0},{0,0,0},{0,0,0}};

        for (int offset_i = -1; offset_i <= 2; ++offset_i) {
            int i = base_i + offset_i;
            if (i < 0 || i >= m_nx) continue;
            float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

            float Sx = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                       evalGIMP_S(px, node_x, m_dx, p.lp[0]) :
                       ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_S(px, node_x, m_dx) :
                       std::max(0.0f, 1.0f - std::abs(px - node_x) / m_dx));

            float dSx = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                        evalGIMP_dS(px, node_x, m_dx, p.lp[0]) :
                        ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_dS(px, node_x, m_dx) :
                        (px >= node_x ? -1.0f / m_dx : 1.0f / m_dx));

            if (std::abs(Sx) < 1.0e-7f) continue;

            for (int offset_j = -1; offset_j <= 2; ++offset_j) {
                int j = base_j + offset_j;
                if (j < 0 || j >= m_ny) continue;
                float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                float Sy = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                           evalGIMP_S(py, node_y, m_dy, p.lp[1]) :
                           ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_S(py, node_y, m_dy) :
                           std::max(0.0f, 1.0f - std::abs(py - node_y) / m_dy));

                float dSy = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                            evalGIMP_dS(py, node_y, m_dy, p.lp[1]) :
                            ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_dS(py, node_y, m_dy) :
                            (py >= node_y ? -1.0f / m_dy : 1.0f / m_dy));

                if (std::abs(Sy) < 1.0e-7f) continue;

                for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                    int k = base_k + offset_k;
                    if (k < 0 || k >= m_nz) continue;
                    float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

                    float Sz = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                               evalGIMP_S(pz, node_z, m_dz, p.lp[2]) :
                               ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_S(pz, node_z, m_dz) :
                               std::max(0.0f, 1.0f - std::abs(pz - node_z) / m_dz));

                    float dSz = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                                evalGIMP_dS(pz, node_z, m_dz, p.lp[2]) :
                                ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_dS(pz, node_z, m_dz) :
                                (pz >= node_z ? -1.0f / m_dz : 1.0f / m_dz));

                    if (std::abs(Sz) < 1.0e-7f) continue;

                    float weight = Sx * Sy * Sz;
                    float dN_dx = dSx * Sy * Sz;
                    float dN_dy = Sx * dSy * Sz;
                    float dN_dz = Sx * Sy * dSz;

                    size_t node_idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                    const auto& node = m_grid[node_idx];

                    if (node.m > MPMGridNode3D::MIN_MASS) {
                        float dist_x = node_x - px;
                        float dist_y = node_y - py;
                        float dist_z = node_z - pz;

                        float w_apic = 1.0f;
                        float diff_vx = node.v(0) - p.v[0];
                        float diff_vy = node.v(1) - p.v[1];
                        float diff_vz = node.v(2) - p.v[2];

                        B_new[0][0] += w_apic * weight * diff_vx * dist_x * D_inv_x;
                        B_new[0][1] += w_apic * weight * diff_vx * dist_y * D_inv_y;
                        B_new[0][2] += w_apic * weight * diff_vx * dist_z * D_inv_z;

                        B_new[1][0] += w_apic * weight * diff_vy * dist_x * D_inv_x;
                        B_new[1][1] += w_apic * weight * diff_vy * dist_y * D_inv_y;
                        B_new[1][2] += w_apic * weight * diff_vy * dist_z * D_inv_z;

                        B_new[2][0] += w_apic * weight * diff_vz * dist_x * D_inv_x;
                        B_new[2][1] += w_apic * weight * diff_vz * dist_y * D_inv_y;
                        B_new[2][2] += w_apic * weight * diff_vz * dist_z * D_inv_z;

                        L_new[0][0] += diff_vx * dN_dx;
                        L_new[0][1] += diff_vx * dN_dy;
                        L_new[0][2] += diff_vx * dN_dz;

                        L_new[1][0] += diff_vy * dN_dx;
                        L_new[1][1] += diff_vy * dN_dy;
                        L_new[1][2] += diff_vy * dN_dz;

                        L_new[2][0] += diff_vz * dN_dx;
                        L_new[2][1] += diff_vz * dN_dy;
                        L_new[2][2] += diff_vz * dN_dz;
                    }
                }
            }
        }

        float target_vx = v_pic_x;
        float target_vy = v_pic_y;
        float target_vz = v_pic_z;

        if (m_velocity_scheme == MPMVelocityScheme::FLIP || p.has_failed) {
            float alpha = (m_velocity_scheme == MPMVelocityScheme::FLIP) ? std::clamp(m_flip_blend, 0.0f, 1.0f) : 0.95f;
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
            if (m_bc_x_min == MPMBoundaryCondition3D::Reflecting) { p.v[0] = std::abs(p.v[0]); }
            else if (p.v[0] < 0) { p.v[0] = 0; }
        } else if (p.x[0] > phys_max_x && m_bc_x_max != MPMBoundaryCondition3D::Terminate) {
            p.x[0] = phys_max_x;
            if (m_bc_x_max == MPMBoundaryCondition3D::Reflecting) { p.v[0] = -std::abs(p.v[0]); }
            else if (p.v[0] > 0) { p.v[0] = 0; }
        }

        if (p.x[1] < phys_min_y && m_bc_y_min != MPMBoundaryCondition3D::Terminate) {
            p.x[1] = phys_min_y;
            if (m_bc_y_min == MPMBoundaryCondition3D::Reflecting) { p.v[1] = std::abs(p.v[1]); }
            else if (p.v[1] < 0) { p.v[1] = 0; }
        } else if (p.x[1] > phys_max_y && m_bc_y_max != MPMBoundaryCondition3D::Terminate) {
            p.x[1] = phys_max_y;
            if (m_bc_y_max == MPMBoundaryCondition3D::Reflecting) { p.v[1] = -std::abs(p.v[1]); }
            else if (p.v[1] > 0) { p.v[1] = 0; }
        }

        if (p.x[2] < phys_min_z && m_bc_z_min != MPMBoundaryCondition3D::Terminate) {
            p.x[2] = phys_min_z;
            if (m_bc_z_min == MPMBoundaryCondition3D::Reflecting) { p.v[2] = std::abs(p.v[2]); }
            else if (p.v[2] < 0) { p.v[2] = 0; }
        } else if (p.x[2] > phys_max_z && m_bc_z_max != MPMBoundaryCondition3D::Terminate) {
            p.x[2] = phys_max_z;
            if (m_bc_z_max == MPMBoundaryCondition3D::Reflecting) { p.v[2] = -std::abs(p.v[2]); }
            else if (p.v[2] > 0) { p.v[2] = 0; }
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

        // --- Option B: Granular Coulomb Debris Model for Eroded/Failed Particles ---
        if (p.has_failed) {
            p.damage = 1.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    p.B[r][c] = 0.0f; // Zero affine velocity gradient to eliminate elastic coupling

            // 1. Bulk Pressure from Volumetric Compression J = V / V0
            const float J = p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f);
            float p_comp = 0.0f;
            if (J < 1.0f) {
                const float E_mod    = mat.youngs_modulus;
                const float nu       = mat.poissons_ratio;
                const float K_intact = E_mod / (3.0f * std::max(1.0e-4f, 1.0f - 2.0f * nu));
                const float K_debris = 0.10f * K_intact; // 10% intact bulk modulus
                p_comp = K_debris * (1.0f - J) / std::max(0.01f, J);
                float p_crush_max = std::max(100.0e6f, (mat.fc > 0.0f ? 5.0f * mat.fc : 2.0f * mat.yield_stress));
                if (p_comp > p_crush_max) p_comp = p_crush_max;
            }

            // 2. Frictional Shear Resistance (Mohr-Coulomb / Drucker-Prager cone limit: q <= M * p_comp)
            const float M_friction = 0.30f;
            const float q_max = M_friction * p_comp;

            const float E_mod = mat.youngs_modulus;
            const float nu = mat.poissons_ratio;
            const float mu_debris = 0.005f * (E_mod / (2.0f * (1.0f + nu)));

            float deps_dev[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c) {
                    deps_dev[r][c] = deps[r][c];
                    if (r == c) deps_dev[r][c] -= tr_deps / 3.0f;
                }

            float s_trial[3][3];
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_trial[r][c] = p.sigma[r][c] + 2.0f * mu_debris * deps_dev[r][c];

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

        // --- Johnson-Cook Plasticity + Mie-Grüneisen Shock EOS Model ---
        if (mat.material_model == MPMMaterialModel::JohnsonCookMieGruneisen) {
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

            // 3. Johnson-Cook Yield Stress
            float double_contraction = 0.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    double_contraction += deps_dev[r][c] * deps_dev[r][c];
            float deps_eq = std::sqrt((2.0f / 3.0f) * double_contraction);
            float ep_dot_star = std::max(1.0f, deps_eq / (dt > 1e-12f ? dt : 1e-12f));
            float T_star = std::clamp((p.temperature - mat.T_room) / (mat.T_melt > mat.T_room ? mat.T_melt - mat.T_room : 1.0f), 0.0f, 1.0f);

            float term_strain = mat.jc_A + mat.jc_B * std::pow(std::max(0.0f, p.ep_bar), mat.jc_n);
            float term_rate   = 1.0f + mat.jc_C * std::log(ep_dot_star);
            float term_temp   = 1.0f - std::pow(T_star, mat.jc_m);
            if (term_temp < 0.0f) term_temp = 0.0f;

            float jc_yield = term_strain * term_rate * term_temp;
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

            // 5. Thermal Re-Welding / Healing Rule:
            // High temp (T >= 80% T_melt) under compression fuses molten interfaces
            if (p.temperature >= 0.80f * mat.T_melt && p_hydro > 0.0f) {
                p.damage = 0.0f;
                p.has_failed = false;
            } else {
                float d_plastic = (mat.failure_strain > 0.0f) ? std::clamp(p.ep_bar / mat.failure_strain, 0.0f, 1.0f) : 0.0f;
                float tensile_stress = -p_hydro;
                float d_tensile = (tensile_stress > 0.0f && mat.tensile_failure_stress > 0.0f)
                    ? std::clamp(tensile_stress / mat.tensile_failure_stress, 0.0f, 1.0f) : 0.0f;

                p.damage = std::max(p.damage, std::max(d_plastic, d_tensile));
                if (p.damage >= 1.0f) {
                    p.has_failed = true;
                    p.damage = 1.0f;
                    for (int r = 0; r < 3; ++r)
                        for (int c = 0; c < 3; ++c)
                            p.B[r][c] = 0.0f;
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
            // Default Hypoelastic J2 Elastoplasticity
            float s_s = 0.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    s_s += s[r][c] * s[r][c];
            const float q_trial   = std::sqrt(1.5f * s_s);
            const float yield_surf = q_trial - (mat.yield_stress + mat.hardening_modulus * p.ep_bar);

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

            // Rate-independent damage: direct mapping from state variable ep_bar.
            const float d_plastic = (mat.failure_strain > 0.0f)
                ? std::clamp(p.ep_bar / mat.failure_strain, 0.0f, 1.0f) : 0.0f;

            const float curr_press    = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
            const float tensile_stress = -curr_press;
            const float d_tensile = (tensile_stress > 0.0f && mat.tensile_failure_stress > 0.0f)
                ? std::clamp(tensile_stress / mat.tensile_failure_stress, 0.0f, 1.0f) : 0.0f;

            p.damage = std::max(p.damage, std::max(d_plastic, d_tensile));
        }

        if (p.damage >= 1.0f) {
            p.has_failed = true;
            p.damage = 1.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    p.B[r][c] = 0.0f;

            p.V = std::clamp(p.V * (1.0f + tr_deps), 0.1f * p.V0, 10.0f * p.V0);

            // Calculate debris stress for this step
            const float J = p.V / (p.V0 > 1.0e-20f ? p.V0 : 1.0e-20f);
            float p_comp = 0.0f;
            if (J < 1.0f) {
                const float E_mod_d  = mat.youngs_modulus;
                const float nu_d     = mat.poissons_ratio;
                const float K_intact = E_mod_d / (3.0f * std::max(1.0e-4f, 1.0f - 2.0f * nu_d));
                const float K_debris = 0.10f * K_intact;
                p_comp = K_debris * (1.0f - J) / J;
            }

            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    p.sigma[r][c] = (r == c) ? -p_comp : 0.0f;

            continue;
        }

        // Partial damage softening: scale deviatoric stress by (1 - damage)
        if (mat.material_model == MPMMaterialModel::Hypoelastic) {
            const float soft_factor = 1.0f - p.damage;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    p.sigma[r][c] *= soft_factor;
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

} // namespace Blast
