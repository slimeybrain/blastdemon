#pragma once

#include <cmath>
#include <algorithm>

namespace Blast {

enum class JointType {
    Spherical,  // 3 rotational DOFs free, 3 translational DOFs locked
    Revolute,   // 1 rotational DOF free around axis, all others locked
    Prismatic,  // 1 translational DOF free along axis, all others locked
    Cylindrical // 1 translational + 1 rotational DOF along axis free
};

template <typename T>
struct alignas(64) KinematicJoint3D {
    JointType type{JointType::Spherical};
    int node_ids[2];             // 2 connected nodes
    T axis[3]{0.0f, 0.0f, 1.0f}; // Joint hinge/slide axis
    T penalty_trans{1.0e8f};     // Translational penalty stiffness (N/m)
    T penalty_rot{1.0e6f};       // Rotational penalty stiffness (N*m/rad)

    void evaluate(
        const T x0[3], const T x1[3],
        const T omega0[3], const T omega1[3],
        T f0[3], T f1[3], T m0[3], T m1[3]
    ) const {
        f0[0] = f0[1] = f0[2] = 0.0f;
        f1[0] = f1[1] = f1[2] = 0.0f;
        m0[0] = m0[1] = m0[2] = 0.0f;
        m1[0] = m1[1] = m1[2] = 0.0f;

        T dx[3] = {x1[0] - x0[0], x1[1] - x0[1], x1[2] - x0[2]};

        if (type == JointType::Spherical) {
            // Lock all 3 translations
            for (int i = 0; i < 3; ++i) {
                f0[i] = penalty_trans * dx[i];
                f1[i] = -f0[i];
            }
        } else if (type == JointType::Revolute) {
            // Lock 3 translations
            for (int i = 0; i < 3; ++i) {
                f0[i] = penalty_trans * dx[i];
                f1[i] = -f0[i];
            }
            // Lock relative rotations orthogonal to joint axis
            T domega[3] = {omega1[0] - omega0[0], omega1[1] - omega0[1], omega1[2] - omega0[2]};
            T domega_axial = domega[0]*axis[0] + domega[1]*axis[1] + domega[2]*axis[2];
            T domega_orth[3] = {
                domega[0] - domega_axial*axis[0],
                domega[1] - domega_axial*axis[1],
                domega[2] - domega_axial*axis[2]
            };
            for (int i = 0; i < 3; ++i) {
                m0[i] = penalty_rot * domega_orth[i];
                m1[i] = -m0[i];
            }
        } else if (type == JointType::Prismatic) {
            // Free along axis, lock 2 orthogonal translations
            T dx_axial = dx[0]*axis[0] + dx[1]*axis[1] + dx[2]*axis[2];
            T dx_orth[3] = {
                dx[0] - dx_axial*axis[0],
                dx[1] - dx_axial*axis[1],
                dx[2] - dx_axial*axis[2]
            };
            for (int i = 0; i < 3; ++i) {
                f0[i] = penalty_trans * dx_orth[i];
                f1[i] = -f0[i];
            }
            // Lock all 3 rotations
            T domega[3] = {omega1[0] - omega0[0], omega1[1] - omega0[1], omega1[2] - omega0[2]};
            for (int i = 0; i < 3; ++i) {
                m0[i] = penalty_rot * domega[i];
                m1[i] = -m0[i];
            }
        }
    }
};

} // namespace Blast
