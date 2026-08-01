#include "mpm_solver_3d.hpp"

namespace Blast {

MPMSolver3D::MPMSolver3D() {
}

void MPMSolver3D::initializeGrid(int nx, int ny, int nz, float dx, float dy, float dz) {
    m_nx = nx;
    m_ny = ny;
    m_nz = nz;
    m_dx = dx;
    m_dy = dy;
    m_dz = dz;

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

                p.density = density;
                p.youngs_modulus = E;
                p.poissons_ratio = nu;
                p.yield_stress = yield_stress;
                p.hardening_modulus = hardening;
                p.failure_strain = failure_strain;
                p.tensile_failure_stress = tensile_failure_stress;
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

                    p.density = density;
                    p.youngs_modulus = E;
                    p.poissons_ratio = nu;
                    p.yield_stress = yield_stress;
                    p.hardening_modulus = hardening;
                    p.failure_strain = failure_strain;
                    p.tensile_failure_stress = tensile_failure_stress;
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

void MPMSolver3D::particleToGrid() {
    // Reset 3D grid
    for (auto& node : m_grid) {
        node.m = 0.0f;
        node.p[0] = 0.0f; node.p[1] = 0.0f; node.p[2] = 0.0f;
        node.v[0] = 0.0f; node.v[1] = 0.0f; node.v[2] = 0.0f;
        node.v_old[0] = 0.0f; node.v_old[1] = 0.0f; node.v_old[2] = 0.0f;
        node.f_int[0] = 0.0f; node.f_int[1] = 0.0f; node.f_int[2] = 0.0f;
        node.f_ext[0] = 0.0f; node.f_ext[1] = 0.0f; node.f_ext[2] = 0.0f;
        node.von_mises = 0.0f;
        node.plastic_strain = 0.0f;
        node.density = 0.0f;
        node.pressure = 0.0f;
        node.damage = 0.0f;
    }

    // P2G Scatter in 3D
    for (const auto& p : m_particles) {
        int base_i = static_cast<int>(std::floor(p.x[0] / m_dx));
        int base_j = static_cast<int>(std::floor(p.x[1] / m_dy));
        int base_k = static_cast<int>(std::floor(p.x[2] / m_dz));

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
                       evalGIMP_S(p.x[0], node_x, m_dx, p.lp[0]) :
                       ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_S(p.x[0], node_x, m_dx) :
                       std::max(0.0f, 1.0f - std::abs(p.x[0] - node_x) / m_dx));

            float dSx = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                        evalGIMP_dS(p.x[0], node_x, m_dx, p.lp[0]) :
                        ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_dS(p.x[0], node_x, m_dx) :
                        (p.x[0] >= node_x ? -1.0f / m_dx : 1.0f / m_dx));

            if (std::abs(Sx) < 1.0e-7f) continue;

            for (int offset_j = -1; offset_j <= 2; ++offset_j) {
                int j = base_j + offset_j;
                if (j < 0 || j >= m_ny) continue;
                float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                float Sy = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                           evalGIMP_S(p.x[1], node_y, m_dy, p.lp[1]) :
                           ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_S(p.x[1], node_y, m_dy) :
                           std::max(0.0f, 1.0f - std::abs(p.x[1] - node_y) / m_dy));

                float dSy = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                            evalGIMP_dS(p.x[1], node_y, m_dy, p.lp[1]) :
                            ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_dS(p.x[1], node_y, m_dy) :
                            (p.x[1] >= node_y ? -1.0f / m_dy : 1.0f / m_dy));

                if (std::abs(Sy) < 1.0e-7f) continue;

                for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                    int k = base_k + offset_k;
                    if (k < 0 || k >= m_nz) continue;
                    float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

                    float Sz = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                               evalGIMP_S(p.x[2], node_z, m_dz, p.lp[2]) :
                               ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_S(p.x[2], node_z, m_dz) :
                               std::max(0.0f, 1.0f - std::abs(p.x[2] - node_z) / m_dz));

                    float dSz = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                                evalGIMP_dS(p.x[2], node_z, m_dz, p.lp[2]) :
                                ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_dS(p.x[2], node_z, m_dz) :
                                (p.x[2] >= node_z ? -1.0f / m_dz : 1.0f / m_dz));

                    if (std::abs(Sz) < 1.0e-7f) continue;

                    float weight = Sx * Sy * Sz;
                    float dN_dx = dSx * Sy * Sz;
                    float dN_dy = Sx * dSy * Sz;
                    float dN_dz = Sx * Sy * dSz;

                    size_t node_idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                    auto& node = m_grid[node_idx];

                    // Mass scatter
                    node.m += p.m * weight;

                    // APIC Momentum scatter in 3D: p_node += m_p * S * (v_p + B_p * dist)
                    float dist_x = node_x - p.x[0];
                    float dist_y = node_y - p.x[1];
                    float dist_z = node_z - p.x[2];

                    float v_apic_x = p.v[0] + (p.B[0][0] * dist_x + p.B[0][1] * dist_y + p.B[0][2] * dist_z);
                    float v_apic_y = p.v[1] + (p.B[1][0] * dist_x + p.B[1][1] * dist_y + p.B[1][2] * dist_z);
                    float v_apic_z = p.v[2] + (p.B[2][0] * dist_x + p.B[2][1] * dist_y + p.B[2][2] * dist_z);

                    node.p[0] += p.m * weight * v_apic_x;
                    node.p[1] += p.m * weight * v_apic_y;
                    node.p[2] += p.m * weight * v_apic_z;

                    // 3D Internal Stress Force scatter: f_int += V_p * sigma_p * dN
                    node.f_int[0] += p.V * (p.sigma[0][0] * dN_dx + p.sigma[0][1] * dN_dy + p.sigma[0][2] * dN_dz);
                    node.f_int[1] += p.V * (p.sigma[1][0] * dN_dx + p.sigma[1][1] * dN_dy + p.sigma[1][2] * dN_dz);
                    node.f_int[2] += p.V * (p.sigma[2][0] * dN_dx + p.sigma[2][1] * dN_dy + p.sigma[2][2] * dN_dz);

                    // Telemetry scalar scatter
                    node.von_mises += p.m * weight * vm_stress;
                    node.plastic_strain += p.m * weight * p.ep_bar;
                    node.density += p.m * weight * p.density;
                    node.pressure += p.m * weight * press;
                    node.damage += p.m * weight * p.damage;
                }
            }
        }
    }

    // Normalize telemetry scalars
    for (auto& node : m_grid) {
        if (node.m > 1.0e-8f) {
            node.von_mises /= node.m;
            node.plastic_strain /= node.m;
            node.density /= node.m;
            node.pressure /= node.m;
            node.damage /= node.m;
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

                if (node.m > 1.0e-8f) {
                    node.v[0] = node.p[0] / node.m;
                    node.v[1] = node.p[1] / node.m;
                    node.v[2] = node.p[2] / node.m;
                    node.v_old[0] = node.v[0];
                    node.v_old[1] = node.v[1];
                    node.v_old[2] = node.v[2];

                    // Total Force = External (FSI) - Internal
                    float f_tot_x = node.f_ext[0] - node.f_int[0];
                    float f_tot_y = node.f_ext[1] - node.f_int[1];
                    float f_tot_z = node.f_ext[2] - node.f_int[2];

                    float m_eff = std::max(node.m, m_eff_floor);
                    node.v[0] += dt * (f_tot_x / m_eff);
                    node.v[1] += dt * (f_tot_y / m_eff);
                    node.v[2] += dt * (f_tot_z / m_eff);

                    // Clamp node velocity
                    node.v[0] = std::clamp(node.v[0], -5000.0f, 5000.0f);
                    node.v[1] = std::clamp(node.v[1], -5000.0f, 5000.0f);
                    node.v[2] = std::clamp(node.v[2], -5000.0f, 5000.0f);

                    // Apply 3D Boundary Conditions (x, y, z min/max)
                    if ((i == 0 && m_bc_x_min == MPMBoundaryCondition3D::Sticky) ||
                        (i == m_nx - 1 && m_bc_x_max == MPMBoundaryCondition3D::Sticky)) {
                        node.v[0] = 0.0f; node.v[1] = 0.0f; node.v[2] = 0.0f;
                    } else if ((i == 0 && m_bc_x_min == MPMBoundaryCondition3D::FreeSlip) ||
                               (i == m_nx - 1 && m_bc_x_max == MPMBoundaryCondition3D::FreeSlip)) {
                        node.v[0] = 0.0f;
                    }

                    if ((j == 0 && m_bc_y_min == MPMBoundaryCondition3D::Sticky) ||
                        (j == m_ny - 1 && m_bc_y_max == MPMBoundaryCondition3D::Sticky)) {
                        node.v[0] = 0.0f; node.v[1] = 0.0f; node.v[2] = 0.0f;
                    } else if ((j == 0 && m_bc_y_min == MPMBoundaryCondition3D::FreeSlip) ||
                               (j == m_ny - 1 && m_bc_y_max == MPMBoundaryCondition3D::FreeSlip)) {
                        node.v[1] = 0.0f;
                    }

                    if ((k == 0 && m_bc_z_min == MPMBoundaryCondition3D::Sticky) ||
                        (k == m_nz - 1 && m_bc_z_max == MPMBoundaryCondition3D::Sticky)) {
                        node.v[0] = 0.0f; node.v[1] = 0.0f; node.v[2] = 0.0f;
                    } else if ((k == 0 && m_bc_z_min == MPMBoundaryCondition3D::FreeSlip) ||
                               (k == m_nz - 1 && m_bc_z_max == MPMBoundaryCondition3D::FreeSlip)) {
                        node.v[2] = 0.0f;
                    }
                }
            }
        }
    }
}

void MPMSolver3D::gridToParticle(float dt) {
    float D_inv_x = 3.0f / (m_dx * m_dx);
    float D_inv_y = 3.0f / (m_dy * m_dy);
    float D_inv_z = 3.0f / (m_dz * m_dz);

    float max_B = 5000.0f / std::min({m_dx, m_dy, m_dz});

    for (auto& p : m_particles) {
        int base_i = static_cast<int>(std::floor(p.x[0] / m_dx));
        int base_j = static_cast<int>(std::floor(p.x[1] / m_dy));
        int base_k = static_cast<int>(std::floor(p.x[2] / m_dz));

        float v_pic_x = 0.0f; float v_pic_y = 0.0f; float v_pic_z = 0.0f;
        float v_flip_x = p.v[0]; float v_flip_y = p.v[1]; float v_flip_z = p.v[2];
        float weight_sum = 0.0f;

        // Pass 1: Interpolate PIC velocity
        for (int offset_i = -1; offset_i <= 2; ++offset_i) {
            int i = base_i + offset_i;
            if (i < 0 || i >= m_nx) continue;
            float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

            float Sx = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                       evalGIMP_S(p.x[0], node_x, m_dx, p.lp[0]) :
                       ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_S(p.x[0], node_x, m_dx) :
                       std::max(0.0f, 1.0f - std::abs(p.x[0] - node_x) / m_dx));

            if (std::abs(Sx) < 1.0e-7f) continue;

            for (int offset_j = -1; offset_j <= 2; ++offset_j) {
                int j = base_j + offset_j;
                if (j < 0 || j >= m_ny) continue;
                float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                float Sy = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                           evalGIMP_S(p.x[1], node_y, m_dy, p.lp[1]) :
                           ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_S(p.x[1], node_y, m_dy) :
                           std::max(0.0f, 1.0f - std::abs(p.x[1] - node_y) / m_dy));

                if (std::abs(Sy) < 1.0e-7f) continue;

                for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                    int k = base_k + offset_k;
                    if (k < 0 || k >= m_nz) continue;
                    float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

                    float Sz = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                               evalGIMP_S(p.x[2], node_z, m_dz, p.lp[2]) :
                               ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_S(p.x[2], node_z, m_dz) :
                               std::max(0.0f, 1.0f - std::abs(p.x[2] - node_z) / m_dz));

                    if (std::abs(Sz) < 1.0e-7f) continue;

                    float weight = Sx * Sy * Sz;
                    size_t node_idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                    const auto& node = m_grid[node_idx];

                    if (node.m > 1.0e-8f) {
                        v_pic_x += weight * node.v[0];
                        v_pic_y += weight * node.v[1];
                        v_pic_z += weight * node.v[2];
                        v_flip_x += weight * (node.v[0] - node.v_old[0]);
                        v_flip_y += weight * (node.v[1] - node.v_old[1]);
                        v_flip_z += weight * (node.v[2] - node.v_old[2]);
                        weight_sum += weight;
                    }
                }
            }
        }

        if (weight_sum <= 1.0e-7f) {
            v_pic_x = p.v[0]; v_pic_y = p.v[1]; v_pic_z = p.v[2];
        }

        // Pass 2: APIC 3x3 affine velocity matrix B_p calculation
        float B_new[3][3] = {{0,0,0},{0,0,0},{0,0,0}};

        for (int offset_i = -1; offset_i <= 2; ++offset_i) {
            int i = base_i + offset_i;
            if (i < 0 || i >= m_nx) continue;
            float node_x = (static_cast<float>(i) + 0.5f) * m_dx;

            float Sx = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                       evalGIMP_S(p.x[0], node_x, m_dx, p.lp[0]) :
                       ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_S(p.x[0], node_x, m_dx) :
                       std::max(0.0f, 1.0f - std::abs(p.x[0] - node_x) / m_dx));

            if (std::abs(Sx) < 1.0e-7f) continue;

            for (int offset_j = -1; offset_j <= 2; ++offset_j) {
                int j = base_j + offset_j;
                if (j < 0 || j >= m_ny) continue;
                float node_y = (static_cast<float>(j) + 0.5f) * m_dy;

                float Sy = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                           evalGIMP_S(p.x[1], node_y, m_dy, p.lp[1]) :
                           ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_S(p.x[1], node_y, m_dy) :
                           std::max(0.0f, 1.0f - std::abs(p.x[1] - node_y) / m_dy));

                if (std::abs(Sy) < 1.0e-7f) continue;

                for (int offset_k = -1; offset_k <= 2; ++offset_k) {
                    int k = base_k + offset_k;
                    if (k < 0 || k >= m_nz) continue;
                    float node_z = (static_cast<float>(k) + 0.5f) * m_dz;

                    float Sz = (m_transfer_scheme == MPMTransferScheme::GIMP) ?
                               evalGIMP_S(p.x[2], node_z, m_dz, p.lp[2]) :
                               ((m_transfer_scheme == MPMTransferScheme::BSpline) ? evalBSpline_S(p.x[2], node_z, m_dz) :
                               std::max(0.0f, 1.0f - std::abs(p.x[2] - node_z) / m_dz));

                    if (std::abs(Sz) < 1.0e-7f) continue;

                    float weight = Sx * Sy * Sz;
                    size_t node_idx = (static_cast<size_t>(i) * m_ny + j) * m_nz + k;
                    const auto& node = m_grid[node_idx];

                    if (node.m > 1.0e-8f) {
                        float dist_x = node_x - p.x[0];
                        float dist_y = node_y - p.x[1];
                        float dist_z = node_z - p.x[2];

                        B_new[0][0] += weight * node.v[0] * dist_x * D_inv_x;
                        B_new[0][1] += weight * node.v[0] * dist_y * D_inv_y;
                        B_new[0][2] += weight * node.v[0] * dist_z * D_inv_z;

                        B_new[1][0] += weight * node.v[1] * dist_x * D_inv_x;
                        B_new[1][1] += weight * node.v[1] * dist_y * D_inv_y;
                        B_new[1][2] += weight * node.v[1] * dist_z * D_inv_z;

                        B_new[2][0] += weight * node.v[2] * dist_x * D_inv_x;
                        B_new[2][1] += weight * node.v[2] * dist_y * D_inv_y;
                        B_new[2][2] += weight * node.v[2] * dist_z * D_inv_z;
                    }
                }
            }
        }

        float target_vx = v_pic_x;
        float target_vy = v_pic_y;
        float target_vz = v_pic_z;

        if (m_velocity_scheme == MPMVelocityScheme::FLIP || m_velocity_scheme == MPMVelocityScheme::APIC) {
            // CFL-normalized FLIP blend.
            // The raw m_flip_blend is a per-acoustic-transit-time damping coefficient:
            //   blend_per_tau = m_flip_blend  (e.g. 0.95 = 5% PIC per tau)
            // The per-step blend is: blend^(dt/tau), where tau = dx/c_s.
            // This makes total dissipation over physical time T equal to
            //   blend^(T/tau), fully CFL-independent.
            // Without this normalization, low-CFL runs (many small steps) would
            // accumulate far more PIC dissipation than high-CFL runs.
            const float c_s_p = (p.youngs_modulus > 0.0f && p.density > 1.0f)
                ? std::sqrt(p.youngs_modulus / p.density) : 5000.0f;
            const float tau_acoustic = std::min({m_dx, m_dy, m_dz}) / c_s_p;
            float per_step_blend = m_flip_blend;
            if (dt > 1.0e-12f && tau_acoustic > 1.0e-12f) {
                per_step_blend = std::pow(m_flip_blend, dt / tau_acoustic);
                per_step_blend = std::clamp(per_step_blend, 0.0f, 1.0f);
            }
            target_vx = per_step_blend * v_flip_x + (1.0f - per_step_blend) * v_pic_x;
            target_vy = per_step_blend * v_flip_y + (1.0f - per_step_blend) * v_pic_y;
            target_vz = per_step_blend * v_flip_z + (1.0f - per_step_blend) * v_pic_z;
        }

        p.v[0] = std::clamp(target_vx, -5000.0f, 5000.0f);
        p.v[1] = std::clamp(target_vy, -5000.0f, 5000.0f);
        p.v[2] = std::clamp(target_vz, -5000.0f, 5000.0f);

        for (int r = 0; r < 3; ++r) {
            for (int c = 0; c < 3; ++c) {
                p.B[r][c] = std::clamp(B_new[r][c], -max_B, max_B);
            }
        }

        // Update Particle Position
        p.x[0] += dt * p.v[0];
        p.x[1] += dt * p.v[1];
        p.x[2] += dt * p.v[2];

        // Domain Boundary Clamping
        float min_x = 1.5f * m_dx; float max_x = (static_cast<float>(m_nx) - 1.5f) * m_dx;
        float min_y = 1.5f * m_dy; float max_y = (static_cast<float>(m_ny) - 1.5f) * m_dy;
        float min_z = 1.5f * m_dz; float max_z = (static_cast<float>(m_nz) - 1.5f) * m_dz;

        if (p.x[0] < min_x) { p.x[0] = min_x; if (p.v[0] < 0) p.v[0] = 0; }
        else if (p.x[0] > max_x) { p.x[0] = max_x; if (p.v[0] > 0) p.v[0] = 0; }

        if (p.x[1] < min_y) { p.x[1] = min_y; if (p.v[1] < 0) p.v[1] = 0; }
        else if (p.x[1] > max_y) { p.x[1] = max_y; if (p.v[1] > 0) p.v[1] = 0; }

        if (p.x[2] < min_z) { p.x[2] = min_z; if (p.v[2] < 0) p.v[2] = 0; }
        else if (p.x[2] > max_z) { p.x[2] = max_z; if (p.v[2] > 0) p.v[2] = 0; }
    }
}

void MPMSolver3D::updateStressState(float dt) {
    for (auto& p : m_particles) {
        // Fully failed particles: erase stress and APIC affine matrix.
        // This prevents failed debris from elastically coupling back to intact material
        // and the penetrator, which is the primary source of CFL-dependence in the
        // penetration result. Failed particles still carry mass and momentum.
        if (p.has_failed) {
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c) {
                    p.sigma[r][c] = 0.0f;
                    p.B[r][c]     = 0.0f;
                }
            continue;
        }

        // Velocity gradient L = B_p (1/s, via D_inv absorbed into B)
        float L[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                L[r][c] = p.B[r][c];

        // Symmetric strain increment D*dt and spin tensor W
        float deps[3][3], W[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c) {
                deps[r][c] = 0.5f * (L[r][c] + L[c][r]) * dt;
                W[r][c]    = 0.5f * (L[r][c] - L[c][r]);
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
        const float E_mod  = p.youngs_modulus;
        const float nu     = p.poissons_ratio;
        const float mu     = E_mod / (2.0f * (1.0f + nu));
        const float lambda = (E_mod * nu) / ((1.0f + nu) * (1.0f - 2.0f * nu));
        const float tr_deps = deps[0][0] + deps[1][1] + deps[2][2];

        // Trial elastic stress update
        float sig_trial[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c) {
                sig_trial[r][c] = sig_base[r][c] + 2.0f * mu * deps[r][c];
                if (r == c) sig_trial[r][c] += lambda * tr_deps;
            }

        // Deviatoric stress and Von Mises equivalent
        const float press = -(sig_trial[0][0] + sig_trial[1][1] + sig_trial[2][2]) / 3.0f;
        float s[3][3];
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c) {
                s[r][c] = sig_trial[r][c];
                if (r == c) s[r][c] += press;
            }

        float s_s = 0.0f;
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                s_s += s[r][c] * s[r][c];
        const float q_trial   = std::sqrt(1.5f * s_s);
        const float yield_surf = q_trial - (p.yield_stress + p.hardening_modulus * p.ep_bar);

        if (q_trial > 1.0e-5f && yield_surf > 0.0f) {
            // Radial return mapping
            const float delta_ep = yield_surf / (3.0f * mu + p.hardening_modulus);
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
        // p.damage is a monotonically non-decreasing state variable.
        // No exponential relaxation - that was dt/CFL-dependent and is now removed.
        const float d_plastic = (p.failure_strain > 0.0f)
            ? std::clamp(p.ep_bar / p.failure_strain, 0.0f, 1.0f) : 0.0f;

        const float curr_press    = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
        const float tensile_stress = -curr_press;
        const float d_tensile = (tensile_stress > 0.0f && p.tensile_failure_stress > 0.0f)
            ? std::clamp(tensile_stress / p.tensile_failure_stress, 0.0f, 1.0f) : 0.0f;

        p.damage = std::max(p.damage, std::max(d_plastic, d_tensile));

        if (p.damage >= 1.0f) {
            // Particle fully failed this step: erase stress and B immediately.
            // This makes the failure event and its effect on momentum transfer
            // identical regardless of CFL.
            p.has_failed = true;
            p.damage = 1.0f;
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c) {
                    p.sigma[r][c] = 0.0f;
                    p.B[r][c]     = 0.0f;
                }
            p.V = std::clamp(p.V * (1.0f + tr_deps), 0.1f * p.V0, 10.0f * p.V0);
            continue;
        }

        // Partial damage: scale stress by (1 - damage)
        const float soft_factor = 1.0f - p.damage;
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                p.sigma[r][c] *= soft_factor;

        // Volume update (first-order volumetric, stable for moderate strains)
        p.V = std::clamp(p.V * (1.0f + tr_deps), 0.1f * p.V0, 10.0f * p.V0);
    }
}

float MPMSolver3D::computeStepSize(float cfl) const {
    if (m_particles.empty()) return 1.0e-6f;
    float max_speed = 100.0f;
    for (const auto& p : m_particles) {
        if (std::isnan(p.v[0]) || std::isnan(p.v[1]) || std::isnan(p.v[2])) continue;
        float E = p.youngs_modulus;
        float rho = std::max(10.0f, p.density);
        float c_s = std::sqrt(E / rho);
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
    m_last_cfl = cfl;
    stepWithDt(dt);
}

} // namespace Blast
