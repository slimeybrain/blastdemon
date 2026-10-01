#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <algorithm>

namespace Blast {

template <typename T>
struct alignas(64) FEMShell4BTElement {
    int node_ids[4];       // 4 corner nodes
    T thickness{0.0015f};  // Shell thickness (m), e.g. 1.5mm automotive sheet metal
    T area0{0.0f};         // Initial reference surface area
    T area{0.0f};          // Current surface area
    T dt0{1.0e30f};        // Stable acoustic timestep
    
    // Co-rotational triad (e1, e2, e3=normal)
    T e1[3]{1, 0, 0};
    T e2[3]{0, 1, 0};
    T e3[3]{0, 0, 1};

    // Generalized stress resultants
    T N_mem[3]{0, 0, 0};   // Membrane forces: Nxx, Nyy, Nxy (N/m)
    T M_bnd[3]{0, 0, 0};   // Bending moments: Mxx, Myy, Mxy (N*m/m)
    T Q_shr[2]{0, 0};      // Transverse shear forces: Qx, Qy (N/m)

    // Through-thickness Simpson integration (default 3 points: bottom, mid, top)
    static constexpr int NUM_THROUGH_THICKNESS_PTS = 3;
    T ep_bar_layer[NUM_THROUGH_THICKNESS_PTS]{0.0f};
    T sigma_layer[NUM_THROUGH_THICKNESS_PTS][3]{{0}}; // sigma_xx, sigma_yy, sigma_xy at each layer

    T ep_bar_max{0.0f};    // Max plastic strain through thickness
    T failure_strain{0.30f};
    bool is_eroded{false};
    int mat_id{0};
    int part_id{0};
    int64_t lsdyna_id{-1};

    // Flanagan-Belytschko warping hourglass stiffness coefficient
    T hg_factor{0.05f};

    static void compute_corotational_triad(const T x[4][3], T e1[3], T e2[3], T e3[3], T& area) {
        // Diagonal vectors
        T r13[3] = {x[2][0] - x[0][0], x[2][1] - x[0][1], x[2][2] - x[0][2]};
        T r24[3] = {x[3][0] - x[1][0], x[3][1] - x[1][1], x[3][2] - x[1][2]};

        // Normal vector e3 = r13 x r24
        e3[0] = r13[1] * r24[2] - r13[2] * r24[1];
        e3[1] = r13[2] * r24[0] - r13[0] * r24[2];
        e3[2] = r13[0] * r24[1] - r13[1] * r24[0];

        T n_len = std::sqrt(e3[0]*e3[0] + e3[1]*e3[1] + e3[2]*e3[2]);
        area = static_cast<T>(0.5) * n_len;

        if (n_len > static_cast<T>(1e-12)) {
            e3[0] /= n_len;
            e3[1] /= n_len;
            e3[2] /= n_len;
        } else {
            e3[0] = 0; e3[1] = 0; e3[2] = 1;
        }

        // e1 aligned with side 0-1 projected onto shell plane
        T s01[3] = {x[1][0] - x[0][0], x[1][1] - x[0][1], x[1][2] - x[0][2]};
        T s01_dot_e3 = s01[0]*e3[0] + s01[1]*e3[1] + s01[2]*e3[2];
        e1[0] = s01[0] - s01_dot_e3 * e3[0];
        e1[1] = s01[1] - s01_dot_e3 * e3[1];
        e1[2] = s01[2] - s01_dot_e3 * e3[2];

        T e1_len = std::sqrt(e1[0]*e1[0] + e1[1]*e1[1] + e1[2]*e1[2]);
        if (e1_len > static_cast<T>(1e-12)) {
            e1[0] /= e1_len;
            e1[1] /= e1_len;
            e1[2] /= e1_len;
        } else {
            e1[0] = 1; e1[1] = 0; e1[2] = 0;
        }

        // e2 = e3 x e1
        e2[0] = e3[1]*e1[2] - e3[2]*e1[1];
        e2[1] = e3[2]*e1[0] - e3[0]*e1[2];
        e2[2] = e3[0]*e1[1] - e3[1]*e1[0];
    }
};

} // namespace Blast
