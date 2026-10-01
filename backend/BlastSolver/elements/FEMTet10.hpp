#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <algorithm>

namespace Blast {

template <typename T>
struct alignas(32) FEMTet10Element {
    int node_ids[10];      // 10 node indices (0..3 corners, 4..9 edge midpoints)
    T V0{0.0f};
    T V{0.0f};
    T dt0{1.0e30f};
    T F[3][3]{{1,0,0},{0,1,0},{0,0,1}};
    T s_dev[3][3]{0};
    T sigma[3][3]{0};
    T ep_bar{0.0f};
    T temperature{293.0f};
    T damage{0.0f};
    T lambda{0.0f};
    T q_visc{0.0f};
    bool is_eroded{false};
    bool mpm_converted{false};
    int decay_step{0};
    int mat_id{0};
    int part_id{0};
    int64_t lsdyna_id{-1};

    // Quadratic volume from 4-point Keast quadrature
    static T compute_volume(const T x[10][3]) {
        // Evaluate volume using 4-point symmetric tetrahedron Gauss rule
        const T a = static_cast<T>(0.5854101966249685);
        const T b = static_cast<T>(0.1381966011250105);
        const T w = static_cast<T>(0.25); // each weight 1/4 of tet volume

        const T quad_pts[4][4] = {
            {a, b, b, b},
            {b, a, b, b},
            {b, b, a, b},
            {b, b, b, a}
        };

        T total_vol = 0.0f;
        for (int q = 0; q < 4; ++q) {
            T L0 = quad_pts[q][0];
            T L1 = quad_pts[q][1];
            T L2 = quad_pts[q][2];
            T L3 = quad_pts[q][3];

            // Shape function derivatives for Tet10:
            // N0 = L0*(2*L0 - 1), N4 = 4*L0*L1, etc.
            // Derivatives w.r.t volume coordinates (L1, L2, L3) with L0 = 1 - L1 - L2 - L3
            T dN[10][3];
            // dN/dL1
            dN[0][0] = -(4.0f * L0 - 1.0f);
            dN[1][0] = 4.0f * L1 - 1.0f;
            dN[2][0] = 0.0f;
            dN[3][0] = 0.0f;
            dN[4][0] = 4.0f * (L0 - L1);
            dN[5][0] = 4.0f * L2;
            dN[6][0] = -4.0f * L2;
            dN[7][0] = -4.0f * L3;
            dN[8][0] = 4.0f * L3;
            dN[9][0] = 0.0f;

            // dN/dL2
            dN[0][1] = -(4.0f * L0 - 1.0f);
            dN[1][1] = 0.0f;
            dN[2][1] = 4.0f * L2 - 1.0f;
            dN[3][1] = 0.0f;
            dN[4][1] = -4.0f * L1;
            dN[5][1] = 4.0f * L1;
            dN[6][1] = 4.0f * (L0 - L2);
            dN[7][1] = -4.0f * L3;
            dN[8][1] = 0.0f;
            dN[9][1] = 4.0f * L3;

            // dN/dL3
            dN[0][2] = -(4.0f * L0 - 1.0f);
            dN[1][2] = 0.0f;
            dN[2][2] = 0.0f;
            dN[3][2] = 4.0f * L3 - 1.0f;
            dN[4][2] = -4.0f * L1;
            dN[5][2] = 0.0f;
            dN[6][2] = -4.0f * L2;
            dN[7][2] = 4.0f * (L0 - L3);
            dN[8][2] = 4.0f * L1;
            dN[9][2] = 4.0f * L2;

            T J[3][3]{0};
            for (int i = 0; i < 10; ++i) {
                for (int d = 0; d < 3; ++d) {
                    J[0][d] += x[i][0] * dN[i][d];
                    J[1][d] += x[i][1] * dN[i][d];
                    J[2][d] += x[i][2] * dN[i][d];
                }
            }

            T detJ = J[0][0] * (J[1][1] * J[2][2] - J[1][2] * J[2][1]) -
                     J[0][1] * (J[1][0] * J[2][2] - J[1][2] * J[2][0]) +
                     J[0][2] * (J[1][0] * J[2][1] - J[1][1] * J[2][0]);

            total_vol += (std::abs(detJ) / static_cast<T>(6.0)) * w;
        }
        return total_vol;
    }
};

} // namespace Blast
