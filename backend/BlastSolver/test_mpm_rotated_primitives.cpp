#include <iostream>
#include <vector>
#include <cmath>
#include <cassert>
#include "mpm_solver_3d.hpp"
#include "PrimitiveGeometry.hpp"

// Utility to inverse-rotate point via analytical inverse Euler angles
static inline Point3D inv_rotate_point_euler(float u, float v, float w, float ax_deg, float ay_deg, float az_deg) {
    constexpr float deg_to_rad = 3.14159265358979323846f / 180.0f;
    float ax = ax_deg * deg_to_rad;
    float ay = ay_deg * deg_to_rad;
    float az = az_deg * deg_to_rad;

    float cx = std::cos(ax), sx = std::sin(ax);
    float cy = std::cos(ay), sy = std::sin(ay);
    float cz = std::cos(az), sz = std::sin(az);

    // Step 1: Inverse rotation around Z (-az)
    float u1 = cz * u + sz * v;
    float v1 = -sz * u + cz * v;
    float w1 = w;

    // Step 2: Inverse rotation around Y (-ay)
    float u2 = cy * u1 - sy * w1;
    float v2 = v1;
    float w2 = sy * u1 + cy * w1;

    // Step 3: Inverse rotation around X (-ax)
    float u_rot = u2;
    float v_rot = cx * v2 + sx * w2;
    float w_rot = -sx * v2 + cx * w2;

    return { u_rot, v_rot, w_rot };
}

int main() {
    std::cout << "========================================================\n";
    std::cout << " MPM Rotated Primitives Unit Test Suite\n";
    std::cout << "========================================================\n";

    // -------------------------------------------------------------
    // Test 1: Box Rotation Parity & Coordinate Transformation
    // -------------------------------------------------------------
    {
        std::cout << "\n[Test 1] Box: 0 deg vs 90 deg Z-rotation...\n";
        Blast::MPMSolver3D solver_unrot;
        solver_unrot.setDomainGeometry(0.01f, 0.01f, 0.01f, 0.0f, 0.0f, 0.0f);
        // Size: 0.40m in X, 0.20m in Y, 0.10m in Z
        solver_unrot.addBoxObject(1, 0.5f, 0.5f, 0.5f, 0.4f, 0.2f, 0.1f,
                                 0, 0, 0, 0, 0, 0,
                                 7850.0f, 210.0e9f, 0.3f, 400.0e6f, 1.0e9f, 0.25f, 600.0e6f, 8,
                                 Blast::MPMParticleDistribution::Cartesian,
                                 Blast::MPMBoundaryFilling::Stairstepped,
                                 0.0f, 0.0f, 0.0f);

        const auto& p_unrot = solver_unrot.getParticles();
        size_t n_particles = p_unrot.size();
        std::cout << "  Unrotated box generated " << n_particles << " particles.\n";
        assert(n_particles > 0);

        Blast::MPMSolver3D solver_rot90z;
        solver_rot90z.setDomainGeometry(0.01f, 0.01f, 0.01f, 0.0f, 0.0f, 0.0f);
        solver_rot90z.addBoxObject(1, 0.5f, 0.5f, 0.5f, 0.4f, 0.2f, 0.1f,
                                  0, 0, 0, 0, 0, 0,
                                  7850.0f, 210.0e9f, 0.3f, 400.0e6f, 1.0e9f, 0.25f, 600.0e6f, 8,
                                  Blast::MPMParticleDistribution::Cartesian,
                                  Blast::MPMBoundaryFilling::Stairstepped,
                                  0.0f, 0.0f, 90.0f);

        const auto& p_rot90z = solver_rot90z.getParticles();
        std::cout << "  90 deg rotated box generated " << p_rot90z.size() << " particles.\n";
        assert(p_rot90z.size() == n_particles);

        // Compute bounding box for rotated particles
        float min_x = 1e9f, max_x = -1e9f;
        float min_y = 1e9f, max_y = -1e9f;
        float min_z = 1e9f, max_z = -1e9f;
        float sum_x = 0.0f, sum_y = 0.0f, sum_z = 0.0f;

        for (const auto& p : p_rot90z) {
            min_x = std::min(min_x, p.x[0]); max_x = std::max(max_x, p.x[0]);
            min_y = std::min(min_y, p.x[1]); max_y = std::max(max_y, p.x[1]);
            min_z = std::min(min_z, p.x[2]); max_z = std::max(max_z, p.x[2]);
            sum_x += p.x[0]; sum_y += p.x[1]; sum_z += p.x[2];
        }

        float mean_x = sum_x / static_cast<float>(n_particles);
        float mean_y = sum_y / static_cast<float>(n_particles);
        float mean_z = sum_z / static_cast<float>(n_particles);

        std::cout << "  Centroid of rotated box: (" << mean_x << ", " << mean_y << ", " << mean_z << ")\n";
        assert(std::abs(mean_x - 0.5f) < 1e-4f);
        assert(std::abs(mean_y - 0.5f) < 1e-4f);
        assert(std::abs(mean_z - 0.5f) < 1e-4f);

        // After +90 deg Z rotation, X dimension (0.4m) becomes Y dimension, and Y dimension (0.2m) becomes X dimension!
        float span_x = max_x - min_x;
        float span_y = max_y - min_y;
        std::cout << "  Rotated bounds: span_x = " << span_x << " m (expected ~0.2m), span_y = " << span_y << " m (expected ~0.4m)\n";
        assert(span_x < 0.21f && span_x > 0.18f);
        assert(span_y < 0.41f && span_y > 0.38f);
        std::cout << "  -> PASSED: 90 deg rotation matches analytical geometry.\n";
    }

    // -------------------------------------------------------------
    // Test 2: Arbitrary 3-Axis Euler Rotation (30, 45, 60 deg)
    // -------------------------------------------------------------
    {
        std::cout << "\n[Test 2] Box: General 3-Axis Rotation (30 deg, 45 deg, 60 deg)...\n";
        float rot_x = 30.0f, rot_y = 45.0f, rot_z = 60.0f;
        float pos_x = 0.5f, pos_y = 0.4f, pos_z = 0.3f;
        float sx = 0.3f, sy = 0.2f, sz = 0.15f;

        Blast::MPMSolver3D solver;
        solver.setDomainGeometry(0.01f, 0.01f, 0.01f, 0.0f, 0.0f, 0.0f);
        solver.addBoxObject(1, pos_x, pos_y, pos_z, sx, sy, sz,
                            1.0f, -2.0f, 0.5f, 0.1f, 0.2f, 0.3f,
                            7850.0f, 210.0e9f, 0.3f, 400.0e6f, 1.0e9f, 0.25f, 600.0e6f, 8,
                            Blast::MPMParticleDistribution::Cartesian,
                            Blast::MPMBoundaryFilling::Stairstepped,
                            rot_x, rot_y, rot_z);

        const auto& particles = solver.getParticles();
        assert(!particles.empty());

        float sum_x = 0.0f, sum_y = 0.0f, sum_z = 0.0f;
        for (const auto& p : particles) {
            sum_x += p.x[0]; sum_y += p.x[1]; sum_z += p.x[2];

            // Verify inverse rotation maps point back inside local unrotated box bounds
            float rel_x = p.x[0] - pos_x;
            float rel_y = p.x[1] - pos_y;
            float rel_z = p.x[2] - pos_z;

            Point3D loc = inv_rotate_point_euler(rel_x, rel_y, rel_z, rot_x, rot_y, rot_z);
            assert(std::abs(loc.x) <= (0.5f * sx + 1e-4f));
            assert(std::abs(loc.y) <= (0.5f * sy + 1e-4f));
            assert(std::abs(loc.z) <= (0.5f * sz + 1e-4f));

            // Verify angular velocity cross product v = v0 + omega x r
            float expected_vx = 1.0f + (0.2f * rel_z - 0.3f * rel_y);
            float expected_vy = -2.0f + (0.3f * rel_x - 0.1f * rel_z);
            float expected_vz = 0.5f + (0.1f * rel_y - 0.2f * rel_x);
            assert(std::abs(p.v[0] - expected_vx) < 1e-4f);
            assert(std::abs(p.v[1] - expected_vy) < 1e-4f);
            assert(std::abs(p.v[2] - expected_vz) < 1e-4f);
            (void)loc; (void)expected_vx; (void)expected_vy; (void)expected_vz;
        }

        float mean_x = sum_x / static_cast<float>(particles.size());
        float mean_y = sum_y / static_cast<float>(particles.size());
        float mean_z = sum_z / static_cast<float>(particles.size());
        std::cout << "  Centroid error: dx=" << std::abs(mean_x - pos_x)
                  << ", dy=" << std::abs(mean_y - pos_y)
                  << ", dz=" << std::abs(mean_z - pos_z) << "\n";
        assert(std::abs(mean_x - pos_x) < 1e-3f);
        assert(std::abs(mean_y - pos_y) < 1e-3f);
        assert(std::abs(mean_z - pos_z) < 1e-3f);
        std::cout << "  -> PASSED: All particles map exactly into local rotated domain with correct kinematics.\n";
    }

    // -------------------------------------------------------------
    // Test 3: Cylinder 90 deg Y-Rotation (Z-aligned -> X-aligned)
    // -------------------------------------------------------------
    {
        std::cout << "\n[Test 3] Cylinder: 90 deg Y-rotation (reorient axis from Z to X)...\n";
        float radius = 0.1f;
        float height = 0.4f;
        float pos_x = 0.5f, pos_y = 0.5f, pos_z = 0.5f;

        Blast::MPMSolver3D solver_cyl;
        solver_cyl.setDomainGeometry(0.01f, 0.01f, 0.01f, 0.0f, 0.0f, 0.0f);
        solver_cyl.addCylinderObject(1, pos_x, pos_y, pos_z, radius, 0.0f, height,
                                    0, 0, 0, 0, 0, 0,
                                    7850.0f, 210.0e9f, 0.3f, 400.0e6f, 1.0e9f, 0.25f, 600.0e6f, 8,
                                    Blast::MPMParticleDistribution::Cartesian,
                                    Blast::MPMBoundaryFilling::Stairstepped,
                                    0.0f, 90.0f, 0.0f);

        const auto& particles = solver_cyl.getParticles();
        std::cout << "  Rotated cylinder generated " << particles.size() << " particles.\n";
        assert(!particles.empty());

        float min_x = 1e9f, max_x = -1e9f;
        float min_y = 1e9f, max_y = -1e9f;
        float min_z = 1e9f, max_z = -1e9f;

        for (const auto& p : particles) {
            min_x = std::min(min_x, p.x[0]); max_x = std::max(max_x, p.x[0]);
            min_y = std::min(min_y, p.x[1]); max_y = std::max(max_y, p.x[1]);
            min_z = std::min(min_z, p.x[2]); max_z = std::max(max_z, p.x[2]);

            // Inverse rotation maps to canonical Z-cylinder
            float rel_x = p.x[0] - pos_x;
            float rel_y = p.x[1] - pos_y;
            float rel_z = p.x[2] - pos_z;
            Point3D loc = inv_rotate_point_euler(rel_x, rel_y, rel_z, 0.0f, 90.0f, 0.0f);

            float r2 = loc.x * loc.x + loc.y * loc.y;
            assert(r2 <= (radius * radius + 1e-4f));
            assert(std::abs(loc.z) <= (0.5f * height + 1e-4f));
            (void)r2;
        }

        float span_x = max_x - min_x;
        float span_y = max_y - min_y;
        float span_z = max_z - min_z;
        std::cout << "  Rotated cylinder bounds: span_x=" << span_x
                  << " (axis, expected ~0.4m), span_y=" << span_y
                  << " (radial, expected ~0.2m), span_z=" << span_z
                  << " (radial, expected ~0.2m)\n";
        assert(span_x > 0.38f && span_x < 0.41f);
        assert(span_y > 0.18f && span_y < 0.21f);
        assert(span_z > 0.18f && span_z < 0.21f);
        std::cout << "  -> PASSED: Cylinder successfully oriented along X axis under Euler rotation.\n";
    }

    std::cout << "\n========================================================\n";
    std::cout << " ALL ROTATED PRIMITIVE TESTS PASSED PERFECTLY!\n";
    std::cout << "========================================================\n";
    return 0;
}
