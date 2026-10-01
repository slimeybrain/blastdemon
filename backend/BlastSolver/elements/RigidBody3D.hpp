#pragma once

#include <vector>
#include <array>
#include <cmath>
#include <cstdint>

namespace Blast {

template <typename T>
struct alignas(64) RigidBody3D {
    int id{0};
    T mass{0.0f};
    T I_body[3][3]{{0}};      // Principal moments of inertia at CoM in body frame
    T I_inv_body[3][3]{{0}};  // Inverse inertia tensor in body frame

    // Translational state at CoM
    T x[3]{0.0f, 0.0f, 0.0f};       // CoM position
    T x0[3]{0.0f, 0.0f, 0.0f};      // Initial CoM position
    T v[3]{0.0f, 0.0f, 0.0f};       // CoM velocity
    T a[3]{0.0f, 0.0f, 0.0f};       // CoM acceleration
    T f_total[3]{0.0f, 0.0f, 0.0f}; // Accumulated external force

    // Rotational state (quaternion q = [w, x, y, z])
    T q[4]{1.0f, 0.0f, 0.0f, 0.0f};
    T omega[3]{0.0f, 0.0f, 0.0f};       // World frame angular velocity
    T omega_body[3]{0.0f, 0.0f, 0.0f};  // Body frame angular velocity
    T alpha[3]{0.0f, 0.0f, 0.0f};       // Angular acceleration
    T torque_total[3]{0.0f, 0.0f, 0.0f};// Accumulated external torque

    // Slave nodes
    struct SlaveNode {
        int node_id;
        T r0[3]; // Local reference offset from CoM at t=0
    };
    std::vector<SlaveNode> slave_nodes;

    // Convert quaternion to 3x3 rotation matrix R
    void get_rotation_matrix(T R[3][3]) const {
        T w = q[0], qx = q[1], qy = q[2], qz = q[3];
        R[0][0] = 1.0f - 2.0f*(qy*qy + qz*qz);
        R[0][1] = 2.0f*(qx*qy - qz*w);
        R[0][2] = 2.0f*(qx*qz + qy*w);

        R[1][0] = 2.0f*(qx*qy + qz*w);
        R[1][1] = 1.0f - 2.0f*(qx*qx + qz*qz);
        R[1][2] = 2.0f*(qy*qz - qx*w);

        R[2][0] = 2.0f*(qx*qz - qy*w);
        R[2][1] = 2.0f*(qy*qz + qx*w);
        R[2][2] = 1.0f - 2.0f*(qx*qx + qy*qy);
    }

    // Update slave nodal coordinates and velocities from CoM kinematics
    void project_to_slaves(T (*nodes_x)[3], T (*nodes_v)[3]) const {
        T R[3][3];
        get_rotation_matrix(R);

        for (const auto& slave : slave_nodes) {
            int nid = slave.node_id;
            // r = R * r0
            T rx = R[0][0]*slave.r0[0] + R[0][1]*slave.r0[1] + R[0][2]*slave.r0[2];
            T ry = R[1][0]*slave.r0[0] + R[1][1]*slave.r0[1] + R[1][2]*slave.r0[2];
            T rz = R[2][0]*slave.r0[0] + R[2][1]*slave.r0[1] + R[2][2]*slave.r0[2];

            nodes_x[nid][0] = x[0] + rx;
            nodes_x[nid][1] = x[1] + ry;
            nodes_x[nid][2] = x[2] + rz;

            // v = V_com + omega x r
            nodes_v[nid][0] = v[0] + (omega[1]*rz - omega[2]*ry);
            nodes_v[nid][1] = v[1] + (omega[2]*rx - omega[0]*rz);
            nodes_v[nid][2] = v[2] + (omega[0]*ry - omega[1]*rx);
        }
    }

    // Accumulate forces and torques from slave nodes
    void accumulate_forces(const T (*nodes_x)[3], const T (*nodes_f)[3]) {
        for (const auto& slave : slave_nodes) {
            int nid = slave.node_id;
            T fx = nodes_f[nid][0];
            T fy = nodes_f[nid][1];
            T fz = nodes_f[nid][2];

            f_total[0] += fx;
            f_total[1] += fy;
            f_total[2] += fz;

            T rx = nodes_x[nid][0] - x[0];
            T ry = nodes_x[nid][1] - x[1];
            T rz = nodes_x[nid][2] - x[2];

            // torque = r x f
            torque_total[0] += (ry * fz - rz * fy);
            torque_total[1] += (rz * fx - rx * fz);
            torque_total[2] += (rx * fy - ry * fx);
        }
    }

    // 2nd-order Symplectic Leapfrog Time Integration
    void step_leapfrog(T dt) {
        if (mass <= static_cast<T>(1e-12)) return;

        // Linear motion
        a[0] = f_total[0] / mass;
        a[1] = f_total[1] / mass;
        a[2] = f_total[2] / mass;

        v[0] += a[0] * dt;
        v[1] += a[1] * dt;
        v[2] += a[2] * dt;

        x[0] += v[0] * dt;
        x[1] += v[1] * dt;
        x[2] += v[2] * dt;

        // Rotational motion via Euler equations in body frame
        T R[3][3];
        get_rotation_matrix(R);

        // Body torque = R^T * torque_world
        T tau_b[3] = {
            R[0][0]*torque_total[0] + R[1][0]*torque_total[1] + R[2][0]*torque_total[2],
            R[0][1]*torque_total[0] + R[1][1]*torque_total[1] + R[2][1]*torque_total[2],
            R[0][2]*torque_total[0] + R[1][2]*torque_total[1] + R[2][2]*torque_total[2]
        };

        // Body omega = R^T * omega_world
        omega_body[0] = R[0][0]*omega[0] + R[1][0]*omega[1] + R[2][0]*omega[2];
        omega_body[1] = R[0][1]*omega[0] + R[1][1]*omega[1] + R[2][1]*omega[2];
        omega_body[2] = R[0][2]*omega[0] + R[1][2]*omega[1] + R[2][2]*omega[2];

        // 2nd-order Symplectic Implicit Midpoint for Euler rigid body equations:
        // Guarantees exact Hamiltonian kinetic energy conservation: dE/dt = 0
        T w_mid[3] = {omega_body[0], omega_body[1], omega_body[2]};
        for (int iter = 0; iter < 4; ++iter) {
            T Iw[3] = {
                I_body[0][0]*w_mid[0],
                I_body[1][1]*w_mid[1],
                I_body[2][2]*w_mid[2]
            };
            T gyro[3] = {
                w_mid[1]*Iw[2] - w_mid[2]*Iw[1],
                w_mid[2]*Iw[0] - w_mid[0]*Iw[2],
                w_mid[0]*Iw[1] - w_mid[1]*Iw[0]
            };
            T alpha[3] = {
                I_inv_body[0][0] * (tau_b[0] - gyro[0]),
                I_inv_body[1][1] * (tau_b[1] - gyro[1]),
                I_inv_body[2][2] * (tau_b[2] - gyro[2])
            };
            w_mid[0] = omega_body[0] + static_cast<T>(0.5) * alpha[0] * dt;
            w_mid[1] = omega_body[1] + static_cast<T>(0.5) * alpha[1] * dt;
            w_mid[2] = omega_body[2] + static_cast<T>(0.5) * alpha[2] * dt;
        }

        T Iw[3] = {
            I_body[0][0]*w_mid[0],
            I_body[1][1]*w_mid[1],
            I_body[2][2]*w_mid[2]
        };
        T gyro[3] = {
            w_mid[1]*Iw[2] - w_mid[2]*Iw[1],
            w_mid[2]*Iw[0] - w_mid[0]*Iw[2],
            w_mid[0]*Iw[1] - w_mid[1]*Iw[0]
        };
        T alpha_b[3] = {
            I_inv_body[0][0] * (tau_b[0] - gyro[0]),
            I_inv_body[1][1] * (tau_b[1] - gyro[1]),
            I_inv_body[2][2] * (tau_b[2] - gyro[2])
        };

        omega_body[0] += alpha_b[0] * dt;
        omega_body[1] += alpha_b[1] * dt;
        omega_body[2] += alpha_b[2] * dt;

        // Transform back to world frame
        omega[0] = R[0][0]*omega_body[0] + R[0][1]*omega_body[1] + R[0][2]*omega_body[2];
        omega[1] = R[1][0]*omega_body[0] + R[1][1]*omega_body[1] + R[1][2]*omega_body[2];
        omega[2] = R[2][0]*omega_body[0] + R[2][1]*omega_body[1] + R[2][2]*omega_body[2];

        // Quaternion update: dq/dt = 0.5 * omega_quat * q
        T qw = q[0], qx = q[1], qy = q[2], qz = q[3];
        T dq[4] = {
            static_cast<T>(0.5) * (-qx*omega[0] - qy*omega[1] - qz*omega[2]),
            static_cast<T>(0.5) * ( qw*omega[0] + qy*omega[2] - qz*omega[1]),
            static_cast<T>(0.5) * ( qw*omega[1] - qx*omega[2] + qz*omega[0]),
            static_cast<T>(0.5) * ( qw*omega[2] + qx*omega[1] - qy*omega[0])
        };

        q[0] += dq[0] * dt;
        q[1] += dq[1] * dt;
        q[2] += dq[2] * dt;
        q[3] += dq[3] * dt;

        // Normalize quaternion
        T q_norm = std::sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]);
        if (q_norm > static_cast<T>(1e-12)) {
            q[0] /= q_norm; q[1] /= q_norm; q[2] /= q_norm; q[3] /= q_norm;
        }

        // Reset accumulators
        f_total[0] = f_total[1] = f_total[2] = 0.0f;
        torque_total[0] = torque_total[1] = torque_total[2] = 0.0f;
    }

    T get_kinetic_energy() const {
        T E_trans = static_cast<T>(0.5) * mass * (v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
        T R[3][3];
        get_rotation_matrix(R);
        T wb[3] = {
            R[0][0]*omega[0] + R[1][0]*omega[1] + R[2][0]*omega[2],
            R[0][1]*omega[0] + R[1][1]*omega[1] + R[2][1]*omega[2],
            R[0][2]*omega[0] + R[1][2]*omega[1] + R[2][2]*omega[2]
        };
        T E_rot = static_cast<T>(0.5) * (
            I_body[0][0]*wb[0]*wb[0] +
            I_body[1][1]*wb[1]*wb[1] +
            I_body[2][2]*wb[2]*wb[2]
        );
        return E_trans + E_rot;
    }
};

} // namespace Blast
