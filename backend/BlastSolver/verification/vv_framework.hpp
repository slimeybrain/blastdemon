#pragma once

#include <string>
#include <vector>
#include <cmath>
#include <iostream>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <algorithm>

namespace Blast::VV {

struct BenchmarkResult {
    std::string id;             // e.g. "VV-L1-01"
    std::string title;          // e.g. "Solid Element Topology Patch Tests"
    int level{1};               // 1, 2, 3, or 4
    bool passed{false};
    double error_l2{0.0};
    double tolerance_l2{1.0e-3};
    double error_linf{0.0};
    double tolerance_linf{1.0e-3};
    double r_squared{1.0};
    double tolerance_r2{0.985};
    double energy_drift{0.0};
    double tolerance_energy{1.0e-3};
    double momentum_drift{0.0};
    double tolerance_momentum{1.0e-12};
    double convergence_order{2.0};
    std::string summary;
    std::string details;
    std::string svg_path;
    bool pending{false};
    std::string mesh_svg_path;
    std::string mesh_svg_caption;
};

// --- Mathematical Quantitative Error Norms ---

inline double compute_L2_norm(const std::vector<double>& num, const std::vector<double>& exact) {
    if (num.empty() || num.size() != exact.size()) return 1.0;
    double sum_diff2 = 0.0;
    double sum_exact2 = 0.0;
    for (size_t i = 0; i < num.size(); ++i) {
        double d = num[i] - exact[i];
        sum_diff2 += d * d;
        sum_exact2 += exact[i] * exact[i];
    }
    if (sum_exact2 < 1.0e-20) return std::sqrt(sum_diff2);
    return std::sqrt(sum_diff2) / std::sqrt(sum_exact2);
}

inline double compute_Linf_norm(const std::vector<double>& num, const std::vector<double>& exact) {
    if (num.empty() || num.size() != exact.size()) return 1.0;
    double max_diff = 0.0;
    double max_exact = 0.0;
    for (size_t i = 0; i < num.size(); ++i) {
        double d = std::abs(num[i] - exact[i]);
        if (d > max_diff) max_diff = d;
        double e = std::abs(exact[i]);
        if (e > max_exact) max_exact = e;
    }
    if (max_exact < 1.0e-20) return max_diff;
    return max_diff / max_exact;
}

inline double compute_R2(const std::vector<double>& num, const std::vector<double>& exact) {
    if (num.empty() || num.size() != exact.size()) return 0.0;
    double mean_exact = 0.0;
    for (double val : exact) mean_exact += val;
    mean_exact /= static_cast<double>(exact.size());

    double ss_tot = 0.0;
    double ss_res = 0.0;
    for (size_t i = 0; i < num.size(); ++i) {
        double d_res = num[i] - exact[i];
        double d_tot = exact[i] - mean_exact;
        ss_res += d_res * d_res;
        ss_tot += d_tot * d_tot;
    }
    if (ss_tot < 1.0e-20) return 1.0;
    return 1.0 - (ss_res / ss_tot);
}

inline double compute_energy_drift(const std::vector<double>& E, double E0) {
    if (E.empty() || std::abs(E0) < 1.0e-15) return 0.0;
    double max_drift = 0.0;
    for (double e : E) {
        double d = std::abs(e - E0) / std::abs(E0);
        if (d > max_drift) max_drift = d;
    }
    return max_drift;
}

inline double compute_convergence_order(double err_h, double err_2h) {
    if (err_h <= 1.0e-20 || err_2h <= 1.0e-20) return 2.0;
    return std::log(err_2h / err_h) / std::log(2.0);
}

// --- Zero-Dependency Vector SVG Plot Generator with +/-1% (Green) and +/-5% (Yellow) Shaded Corridors ---

bool generate_svg_plot(
    const std::string& filepath,
    const std::string& title,
    const std::string& x_label,
    const std::string& y_label,
    const std::vector<double>& x_data,
    const std::vector<double>& exact_data,
    const std::vector<double>& num_data,
    double green_pct = 1.0,
    double yellow_pct = 5.0
);

// --- Master Living Compendium Generator ---

bool generate_verification_manual(
    const std::string& output_md_path,
    const std::vector<BenchmarkResult>& results
);

} // namespace Blast::VV
