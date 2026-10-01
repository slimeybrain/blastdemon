#pragma once

#include <cmath>
#include <array>

namespace Blast {

template <typename T>
struct alignas(64) FEMBushing3DElement {
    int node_ids[2];       // 2 connected nodes (each with translational + rotational DOFs)
    
    // Translational stiffness (N/m) and damping (N*s/m) along local bushing triad
    T K_trans[3]{1.0e7f, 1.0e7f, 1.0e7f};
    T C_trans[3]{1.0e4f, 1.0e4f, 1.0e4f};

    // Rotational stiffness (N*m/rad) and damping (N*m*s/rad)
    T K_rot[3]{1.0e5f, 1.0e5f, 1.0e5f};
    T C_rot[3]{1.0e3f, 1.0e3f, 1.0e3f};

    // Local bushing coordinate axes
    T e1[3]{1, 0, 0};
    T e2[3]{0, 1, 0};
    T e3[3]{0, 0, 1};

    // Current output generalized forces
    T f_trans[3]{0}; // Force along local axes
    T m_rot[3]{0};   // Moment about local axes

    static void evaluate(
        const T x0[3], const T x1[3], const T v0[3], const T v1[3],
        const T omega0[3], const T omega1[3],
        FEMBushing3DElement<T>& elem,
        T f0[3], T f1[3], T m0[3], T m1[3]
    ) {
        // Relative translation
        T dx_global[3] = {x1[0] - x0[0], x1[1] - x0[1], x1[2] - x0[2]};
        T dv_global[3] = {v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]};

        // Project into local triad
        T dx_loc[3] = {
            dx_global[0]*elem.e1[0] + dx_global[1]*elem.e1[1] + dx_global[2]*elem.e1[2],
            dx_global[0]*elem.e2[0] + dx_global[1]*elem.e2[1] + dx_global[2]*elem.e2[2],
            dx_global[0]*elem.e3[0] + dx_global[1]*elem.e3[1] + dx_global[2]*elem.e3[2]
        };

        T dv_loc[3] = {
            dv_global[0]*elem.e1[0] + dv_global[1]*elem.e1[1] + dv_global[2]*elem.e1[2],
            dv_global[0]*elem.e2[0] + dv_global[1]*elem.e2[1] + dv_global[2]*elem.e2[2],
            dv_global[0]*elem.e3[0] + dv_global[1]*elem.e3[1] + dv_global[2]*elem.e3[2]
        };

        // Local forces
        T f_loc[3];
        for (int i = 0; i < 3; ++i) {
            f_loc[i] = elem.K_trans[i] * dx_loc[i] + elem.C_trans[i] * dv_loc[i];
            elem.f_trans[i] = f_loc[i];
        }

        // Project back to global force on node 0 (+ force pulls node 0 towards node 1)
        f0[0] = f_loc[0]*elem.e1[0] + f_loc[1]*elem.e2[0] + f_loc[2]*elem.e3[0];
        f0[1] = f_loc[0]*elem.e1[1] + f_loc[1]*elem.e2[1] + f_loc[2]*elem.e3[1];
        f0[2] = f_loc[0]*elem.e1[2] + f_loc[1]*elem.e2[2] + f_loc[2]*elem.e3[2];

        f1[0] = -f0[0]; f1[1] = -f0[1]; f1[2] = -f0[2];

        // Relative rotation rate
        T domega_global[3] = {omega1[0] - omega0[0], omega1[1] - omega0[1], omega1[2] - omega0[2]};
        T domega_loc[3] = {
            domega_global[0]*elem.e1[0] + domega_global[1]*elem.e1[1] + domega_global[2]*elem.e1[2],
            domega_global[0]*elem.e2[0] + domega_global[1]*elem.e2[1] + domega_global[2]*elem.e2[2],
            domega_global[0]*elem.e3[0] + domega_global[1]*elem.e3[1] + domega_global[2]*elem.e3[2]
        };

        T m_loc[3];
        for (int i = 0; i < 3; ++i) {
            m_loc[i] = elem.C_rot[i] * domega_loc[i]; // Rotational damping
            elem.m_rot[i] = m_loc[i];
        }

        m0[0] = m_loc[0]*elem.e1[0] + m_loc[1]*elem.e2[0] + m_loc[2]*elem.e3[0];
        m0[1] = m_loc[0]*elem.e1[1] + m_loc[1]*elem.e2[1] + m_loc[2]*elem.e3[1];
        m0[2] = m_loc[0]*elem.e1[2] + m_loc[1]*elem.e2[2] + m_loc[2]*elem.e3[2];

        m1[0] = -m0[0]; m1[1] = -m0[1]; m1[2] = -m0[2];
    }
};

} // namespace Blast
