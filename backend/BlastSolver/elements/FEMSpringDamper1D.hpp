#pragma once

#include <cmath>
#include <vector>
#include <algorithm>

namespace Blast {

template <typename T>
struct alignas(32) FEMSpringDamper1DElement {
    int node_ids[2];       // 2 connected node indices
    T k{1.0e6f};           // Linear spring stiffness (N/m)
    T c{1.0e3f};           // Damping coefficient (N*s/m)
    T L0{0.0f};            // Free length at rest
    T current_length{0.0f};
    T force{0.0f};         // Current axial force (+ tension, - compression)
    bool is_nonlinear{false};
    std::vector<std::pair<T, T>> f_disp_curve; // Piecewise nonlinear force-displacement table F(delta_L)

    static void compute_force(const T x0[3], const T x1[3], const T v0[3], const T v1[3],
                              FEMSpringDamper1DElement<T>& elem, T f0[3], T f1[3]) {
        T dx[3] = {x1[0] - x0[0], x1[1] - x0[1], x1[2] - x0[2]};
        T L = std::sqrt(dx[0]*dx[0] + dx[1]*dx[1] + dx[2]*dx[2]);
        elem.current_length = L;

        if (L < static_cast<T>(1e-9)) {
            f0[0] = f0[1] = f0[2] = 0.0f;
            f1[0] = f1[1] = f1[2] = 0.0f;
            elem.force = 0.0f;
            return;
        }

        T dir[3] = {dx[0] / L, dx[1] / L, dx[2] / L};
        T delta_L = L - elem.L0;

        // Relative velocity along spring axis
        T dv[3] = {v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]};
        T v_rel = dv[0]*dir[0] + dv[1]*dir[1] + dv[2]*dir[2];

        T f_spring = 0.0f;
        if (elem.is_nonlinear && !elem.f_disp_curve.empty()) {
            // Piecewise linear interpolation
            if (delta_L <= elem.f_disp_curve.front().first) {
                f_spring = elem.f_disp_curve.front().second;
            } else if (delta_L >= elem.f_disp_curve.back().first) {
                f_spring = elem.f_disp_curve.back().second;
            } else {
                for (size_t i = 0; i + 1 < elem.f_disp_curve.size(); ++i) {
                    if (delta_L >= elem.f_disp_curve[i].first && delta_L <= elem.f_disp_curve[i+1].first) {
                        T t = (delta_L - elem.f_disp_curve[i].first) / (elem.f_disp_curve[i+1].first - elem.f_disp_curve[i].first);
                        f_spring = elem.f_disp_curve[i].second * (1.0f - t) + elem.f_disp_curve[i+1].second * t;
                        break;
                    }
                }
            }
        } else {
            f_spring = elem.k * delta_L;
        }

        T f_damper = elem.c * v_rel;
        T total_f = f_spring + f_damper;
        elem.force = total_f;

        // Force on node 0 is in direction towards node 1 (+tension pulls 0 towards 1)
        f0[0] = total_f * dir[0];
        f0[1] = total_f * dir[1];
        f0[2] = total_f * dir[2];

        // Equal and opposite on node 1
        f1[0] = -f0[0];
        f1[1] = -f0[1];
        f1[2] = -f0[2];
    }
};

} // namespace Blast
