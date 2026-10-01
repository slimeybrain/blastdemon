#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <algorithm>

namespace Blast {

template <typename T>
struct alignas(32) FEMWedge6Element {
    int node_ids[6];       // 6 node indices forming prismatic pentahedron
    T V0{0.0f};            // Reference initial volume
    T V{0.0f};             // Current volume
    T dt0{1.0e30f};        // Baseline stable acoustic timestep
    T F[3][3]{{1,0,0},{0,1,0},{0,0,1}}; // Deformation gradient
    T s_dev[3][3]{0};      // Deviatoric Cauchy stress
    T sigma[3][3]{0};      // Cauchy stress tensor
    T ep_bar{0.0f};        // Equivalent plastic strain
    T temperature{293.0f}; // Temperature (K)
    T damage{0.0f};        // Cumulative damage scalar
    T lambda{0.0f};        // Damage parameter
    T q_visc{0.0f};        // Artificial bulk viscosity pressure
    bool is_eroded{false};
    bool mpm_converted{false};
    int decay_step{0};
    int mat_id{0};
    int part_id{0};
    int64_t lsdyna_id{-1};

    // Evaluate shape functions at natural coordinates (r, s, t) where r,s in [0,1], r+s<=1, t in [-1, 1]
    static void evaluate_shape_functions(T r, T s, T t, T N[6]) {
        T l0 = static_cast<T>(1.0) - r - s;
        T l1 = r;
        T l2 = s;
        T h0 = static_cast<T>(0.5) * (static_cast<T>(1.0) - t);
        T h1 = static_cast<T>(0.5) * (static_cast<T>(1.0) + t);

        N[0] = l0 * h0;
        N[1] = l1 * h0;
        N[2] = l2 * h0;
        N[3] = l0 * h1;
        N[4] = l1 * h1;
        N[5] = l2 * h1;
    }

    // Natural coordinate derivatives dN/dr, dN/ds, dN/dt
    static void evaluate_shape_derivatives(T r, T s, T t, T dN[6][3]) {
        (void)r; (void)s;
        T l0 = static_cast<T>(1.0) - r - s;
        T l1 = r;
        T l2 = s;
        T h0 = static_cast<T>(0.5) * (static_cast<T>(1.0) - t);
        T h1 = static_cast<T>(0.5) * (static_cast<T>(1.0) + t);

        // dN/dr
        dN[0][0] = -h0;  dN[1][0] =  h0;  dN[2][0] = static_cast<T>(0.0);
        dN[3][0] = -h1;  dN[4][0] =  h1;  dN[5][0] = static_cast<T>(0.0);

        // dN/ds
        dN[0][1] = -h0;  dN[1][1] = static_cast<T>(0.0);  dN[2][1] =  h0;
        dN[3][1] = -h1;  dN[4][1] = static_cast<T>(0.0);  dN[5][1] =  h1;

        // dN/dt
        dN[0][2] = -static_cast<T>(0.5) * l0; dN[1][2] = -static_cast<T>(0.5) * l1; dN[2][2] = -static_cast<T>(0.5) * l2;
        dN[3][2] =  static_cast<T>(0.5) * l0; dN[4][2] =  static_cast<T>(0.5) * l1; dN[5][2] =  static_cast<T>(0.5) * l2;
    }

    // Compute volume from nodal coordinates x[6][3]
    static T compute_volume(const T x[6][3]) {
        // 2-point Gauss quadrature: r=1/3, s=1/3, t = +/- 1/sqrt(3), weight = 1.0/2 * 1.0 = 0.5 each
        const T inv_sqrt3 = static_cast<T>(0.5773502691896257);
        const T t_pts[2] = {-inv_sqrt3, inv_sqrt3};
        T total_vol = 0.0f;

        for (int gp = 0; gp < 2; ++gp) {
            T dN[6][3];
            evaluate_shape_derivatives(static_cast<T>(1.0 / 3.0), static_cast<T>(1.0 / 3.0), t_pts[gp], dN);

            // Jacobian matrix J = sum(x_i * dN_i)
            T J[3][3]{0};
            for (int i = 0; i < 6; ++i) {
                for (int d = 0; d < 3; ++d) {
                    J[0][d] += x[i][0] * dN[i][d];
                    J[1][d] += x[i][1] * dN[i][d];
                    J[2][d] += x[i][2] * dN[i][d];
                }
            }

            T detJ = J[0][0] * (J[1][1] * J[2][2] - J[1][2] * J[2][1]) -
                     J[0][1] * (J[1][0] * J[2][2] - J[1][2] * J[2][0]) +
                     J[0][2] * (J[1][0] * J[2][1] - J[1][1] * J[2][0]);

            // Triangle area factor = 0.5, gauss weight = 1.0
            total_vol += static_cast<T>(0.5) * std::abs(detJ);
        }
        return total_vol;
    }
};

} // namespace Blast
