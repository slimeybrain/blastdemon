#pragma once

#include <cmath>
#include <algorithm>

namespace Blast {

template <typename T>
struct alignas(32) Spotweld3D {
    int node_ids[2];           // Connected node indices (e.g. on sheet 1 and sheet 2)
    T Sn{5000.0f};             // Normal failure force capacity (N)
    T Ss{4000.0f};             // Shear failure force capacity (N)
    T a_exp{2.0f};             // Normal exponent 'a' (typically 2.0)
    T b_exp{2.0f};             // Shear exponent 'b' (typically 2.0)
    T penalty_stiffness{1.0e8f}; // Elastic spring penalty (N/m)

    T normal[3]{0.0f, 0.0f, 1.0f}; // Weld normal vector
    T current_Fn{0.0f};        // Current normal force
    T current_Fs{0.0f};        // Current shear force
    bool is_ruptured{false};   // Ruptured flag

    // Check failure envelope and compute connection forces
    bool evaluate(const T x0[3], const T x1[3], T f0[3], T f1[3]) {
        f0[0] = f0[1] = f0[2] = 0.0f;
        f1[0] = f1[1] = f1[2] = 0.0f;
        if (is_ruptured) return false;

        T dx[3] = {x1[0] - x0[0], x1[1] - x0[1], x1[2] - x0[2]};
        // Normal elongation: delta_n = dx . normal
        T delta_n = dx[0]*normal[0] + dx[1]*normal[1] + dx[2]*normal[2];
        T dx_tang[3] = {dx[0] - delta_n*normal[0], dx[1] - delta_n*normal[1], dx[2] - delta_n*normal[2]};
        T delta_s = std::sqrt(dx_tang[0]*dx_tang[0] + dx_tang[1]*dx_tang[1] + dx_tang[2]*dx_tang[2]);

        current_Fn = std::max(static_cast<T>(0.0), penalty_stiffness * delta_n);
        current_Fs = penalty_stiffness * delta_s;

        // Quadratic failure criterion: (Fn/Sn)^a + (Fs/Ss)^b >= 1.0
        T term_n = std::pow(current_Fn / (Sn + 1e-12f), a_exp);
        T term_s = std::pow(current_Fs / (Ss + 1e-12f), b_exp);
        if (term_n + term_s >= 1.0f) {
            is_ruptured = true;
            return false;
        }

        // Restoring force pulls node 0 towards node 1
        f0[0] = penalty_stiffness * dx[0];
        f0[1] = penalty_stiffness * dx[1];
        f0[2] = penalty_stiffness * dx[2];

        f1[0] = -f0[0];
        f1[1] = -f0[1];
        f1[2] = -f0[2];
        return true;
    }
};

} // namespace Blast
