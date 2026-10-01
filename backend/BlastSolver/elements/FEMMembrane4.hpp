#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <algorithm>

namespace Blast {

template <typename T>
struct alignas(32) FEMMembrane4Element {
    int node_ids[4];       // 4 corner nodes (3 translational DOFs each)
    T thickness{0.0005f};  // Thin membrane thickness (e.g. 0.5 mm fabric)
    T area0{0.0f};         // Reference area
    T area{0.0f};          // Current area
    T dt0{1.0e30f};
    
    // In-plane Cauchy membrane stress (sigma_xx, sigma_yy, sigma_xy)
    T sigma[3]{0, 0, 0};
    T ep_bar{0.0f};
    T failure_strain{0.40f};
    bool is_eroded{false};
    bool is_wrinkled{false}; // Fabric wrinkling active (compression relaxed)
    int mat_id{0};
    int part_id{0};
    int64_t lsdyna_id{-1};

    // Apply fabric wrinkling criterion: principal stresses cannot sustain compression
    static void apply_wrinkling_relaxation(T& sxx, T& syy, T& sxy) {
        T trace = sxx + syy;
        T diff = sxx - syy;
        T radius = std::sqrt(static_cast<T>(0.25) * diff * diff + sxy * sxy);
        T p1 = static_cast<T>(0.5) * trace + radius; // Maximum principal stress
        T p2 = static_cast<T>(0.5) * trace - radius; // Minimum principal stress

        if (p1 <= 0.0f) {
            // Completely wrinkled (taut in no direction)
            sxx = 0.0f; syy = 0.0f; sxy = 0.0f;
        } else if (p2 < 0.0f) {
            // Uniaxial tension along principal direction 1, relaxed compression along 2
            T theta = static_cast<T>(0.5) * std::atan2(static_cast<T>(2.0) * sxy, diff);
            T cos_t = std::cos(theta);
            T sin_t = std::sin(theta);
            sxx = p1 * cos_t * cos_t;
            syy = p1 * sin_t * sin_t;
            sxy = p1 * sin_t * cos_t;
        }
    }
};

} // namespace Blast
