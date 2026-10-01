#pragma once

#include <cmath>
#include <array>
#include <algorithm>

namespace Blast {

template <typename T>
struct alignas(64) FEMCohesiveCZM8Element {
    int node_ids[8]; // 4 bottom nodes (0..3), 4 top nodes (4..7)
    T area{0.0f};    // Mid-plane surface area
    
    // Bilinear traction-separation law parameters
    T Kn{1.0e13f};   // Normal stiffness (N/m^3)
    T Ks{1.0e13f};   // Shear stiffness (N/m^3)
    T sigma_max{30.0e6f}; // Peak normal strength (Pa)
    T tau_max{20.0e6f};   // Peak shear strength (Pa)
    T G_Ic{300.0f};  // Mode I fracture energy (J/m^2)
    T G_IIc{800.0f}; // Mode II fracture energy (J/m^2)

    T delta_n_open{0.0f};  // Current normal separation (opening)
    T delta_s_slide{0.0f}; // Current shear separation
    T damage{0.0f};        // Scalar cohesive damage in [0, 1]
    bool is_failed{false};

    // Evaluate traction vector [t_n, t_s1, t_s2]
    static void evaluate_traction(
        T delta_n, T delta_s1, T delta_s2,
        FEMCohesiveCZM8Element<T>& elem,
        T& tn, T& ts1, T& ts2
    ) {
        if (elem.is_failed) {
            tn = (delta_n < 0.0f) ? elem.Kn * delta_n : 0.0f; // Contact penalty in compression
            ts1 = ts2 = 0.0f;
            return;
        }

        elem.delta_n_open = std::max(static_cast<T>(0.0), delta_n);
        T delta_s = std::sqrt(delta_s1 * delta_s1 + delta_s2 * delta_s2);
        elem.delta_s_slide = delta_s;

        // Normal displacement at damage initiation
        T delta_0n = elem.sigma_max / elem.Kn;
        T delta_fn = (2.0f * elem.G_Ic) / elem.sigma_max;

        // Mixed-mode equivalent separation
        T delta_m = std::sqrt(elem.delta_n_open * elem.delta_n_open + delta_s * delta_s);
        T delta_0m = delta_0n; // simplified quadratic initiation
        T delta_fm = delta_fn;

        if (delta_m > delta_0m) {
            T d = (delta_fm * (delta_m - delta_0m)) / (delta_m * (delta_fm - delta_0m) + 1e-12f);
            elem.damage = std::min(static_cast<T>(1.0), std::max(elem.damage, d));
            if (elem.damage >= 1.0f || delta_m >= delta_fm) {
                elem.damage = 1.0f;
                elem.is_failed = true;
            }
        }

        T one_minus_d = 1.0f - elem.damage;
        // Compression has no damage penalty
        tn = (delta_n >= 0.0f) ? one_minus_d * elem.Kn * delta_n : elem.Kn * delta_n;
        ts1 = one_minus_d * elem.Ks * delta_s1;
        ts2 = one_minus_d * elem.Ks * delta_s2;
    }
};

} // namespace Blast
