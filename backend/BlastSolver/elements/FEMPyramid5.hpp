#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <algorithm>

namespace Blast {

template <typename T>
struct alignas(32) FEMPyramid5Element {
    int node_ids[5];       // 5 node indices (0..3 quad base, 4 apex)
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

    // Evaluate dual-tet sub-volume: TetA (0,1,2,4) and TetB (0,2,3,4)
    static T compute_volume(const T x[5][3]) {
        auto tet_vol = [](const T p0[3], const T p1[3], const T p2[3], const T p3[3]) -> T {
            T v1[3] = {p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]};
            T v2[3] = {p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]};
            T v3[3] = {p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]};

            T det = v1[0] * (v2[1] * v3[2] - v2[2] * v3[1]) -
                    v1[1] * (v2[0] * v3[2] - v2[2] * v3[0]) +
                    v1[2] * (v2[0] * v3[1] - v2[1] * v3[0]);
            return std::abs(det) / static_cast<T>(6.0);
        };

        T vol_a = tet_vol(x[0], x[1], x[2], x[4]);
        T vol_b = tet_vol(x[0], x[2], x[3], x[4]);
        return vol_a + vol_b;
    }
};

} // namespace Blast
