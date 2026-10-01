#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <algorithm>

namespace Blast {

template <typename T>
struct alignas(32) FEMTet4ANPElement {
    int node_ids[4];       // 4 node indices
    T V0{0.0f};
    T V{0.0f};
    T dt0{1.0e30f};
    T F[3][3]{{1,0,0},{0,1,0},{0,0,1}};
    T s_dev[3][3]{0};
    T sigma[3][3]{0};
    T p_anp{0.0f};         // Average Nodal Pressure (ANP anti-locking)
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

    static T compute_volume(const T x[4][3]) {
        T v1[3] = {x[1][0] - x[0][0], x[1][1] - x[0][1], x[1][2] - x[0][2]};
        T v2[3] = {x[2][0] - x[0][0], x[2][1] - x[0][1], x[2][2] - x[0][2]};
        T v3[3] = {x[3][0] - x[0][0], x[3][1] - x[0][1], x[3][2] - x[0][2]};

        T det = v1[0] * (v2[1] * v3[2] - v2[2] * v3[1]) -
                v1[1] * (v2[0] * v3[2] - v2[2] * v3[0]) +
                v1[2] * (v2[0] * v3[1] - v2[1] * v3[0]);
        return std::abs(det) / static_cast<T>(6.0);
    }

    // Compute shape function spatial gradients b_i = grad(N_i)
    static void compute_shape_gradients(const T x[4][3], T b[4][3], T& vol) {
        vol = compute_volume(x);
        T six_vol = static_cast<T>(6.0) * vol;
        if (six_vol < static_cast<T>(1e-15)) {
            six_vol = static_cast<T>(1e-15);
        }

        // Face 1-2-3 normal facing node 0
        auto cross = [](const T a[3], const T b_v[3], T out[3]) {
            out[0] = a[1] * b_v[2] - a[2] * b_v[1];
            out[1] = a[2] * b_v[0] - a[0] * b_v[2];
            out[2] = a[0] * b_v[1] - a[1] * b_v[0];
        };

        T v12[3] = {x[2][0] - x[1][0], x[2][1] - x[1][1], x[2][2] - x[1][2]};
        T v13[3] = {x[3][0] - x[1][0], x[3][1] - x[1][1], x[3][2] - x[1][2]};
        T n0[3]; cross(v12, v13, n0);

        T v20[3] = {x[0][0] - x[2][0], x[0][1] - x[2][1], x[0][2] - x[2][2]};
        T v23[3] = {x[3][0] - x[2][0], x[3][1] - x[2][1], x[3][2] - x[2][2]};
        T n1[3]; cross(v20, v23, n1);

        T v30[3] = {x[0][0] - x[3][0], x[0][1] - x[3][1], x[0][2] - x[3][2]};
        T v31[3] = {x[1][0] - x[3][0], x[1][1] - x[3][1], x[1][2] - x[3][2]};
        T n2[3]; cross(v30, v31, n2);

        T inv_6V = static_cast<T>(1.0) / six_vol;
        for (int d = 0; d < 3; ++d) {
            b[0][d] = -n0[d] * inv_6V;
            b[1][d] = -n1[d] * inv_6V;
            b[2][d] = -n2[d] * inv_6V;
            b[3][d] = -(b[0][d] + b[1][d] + b[2][d]);
        }
    }
};

} // namespace Blast
