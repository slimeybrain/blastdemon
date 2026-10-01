#include "vv_framework.hpp"
#include <fstream>
#include <sstream>
#include <iomanip>
#include <cmath>

namespace Blast::VV {

bool generate_svg_plot(
    const std::string& filepath,
    const std::string& title,
    const std::string& x_label,
    const std::string& y_label,
    const std::vector<double>& x_data,
    const std::vector<double>& exact_data,
    const std::vector<double>& num_data,
    double green_pct,
    double yellow_pct
) {
    if (x_data.empty() || exact_data.size() != x_data.size()) {
        return false;
    }

    std::ofstream ofs(filepath);
    if (!ofs.is_open()) return false;

    // Viewport dimensions
    const int W = 800;
    const int H = 450;
    const int pad_left = 75;
    const int pad_right = 35;
    const int pad_top = 50;
    const int pad_bottom = 60;
    const int plot_w = W - pad_left - pad_right;
    const int plot_h = H - pad_top - pad_bottom;

    // Determine data ranges
    double x_min = x_data.front();
    double x_max = x_data.back();
    if (x_max <= x_min) x_max = x_min + 1.0;

    double y_min = exact_data.front();
    double y_max = exact_data.front();
    for (size_t i = 0; i < exact_data.size(); ++i) {
        y_min = std::min(y_min, exact_data[i]);
        y_max = std::max(y_max, exact_data[i]);
        if (i < num_data.size()) {
            y_min = std::min(y_min, num_data[i]);
            y_max = std::max(y_max, num_data[i]);
        }
    }

    double y_margin = (y_max - y_min) * 0.10;
    if (y_margin < 1.0e-9) y_margin = 1.0;
    y_min -= y_margin;
    y_max += y_margin;

    auto map_x = [&](double x) -> double {
        return pad_left + ((x - x_min) / (x_max - x_min)) * plot_w;
    };
    auto map_y = [&](double y) -> double {
        return pad_top + (1.0 - (y - y_min) / (y_max - y_min)) * plot_h;
    };

    ofs << "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
    ofs << "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 " << W << " " << H << "\" width=\"" << W << "\" height=\"" << H << "\">\n";
    ofs << "  <style>\n";
    ofs << "    text { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #c9d1d9; }\n";
    ofs << "    .title { font-size: 16px; font-weight: 600; fill: #f0f6fc; }\n";
    ofs << "    .axis-label { font-size: 12px; fill: #8b949e; }\n";
    ofs << "    .tick { font-size: 10px; fill: #8b949e; }\n";
    ofs << "    .grid { stroke: #30363d; stroke-width: 1; stroke-dasharray: 4,4; }\n";
    ofs << "    .axis-line { stroke: #484f58; stroke-width: 1.5; }\n";
    ofs << "    .exact-curve { fill: none; stroke: #58a6ff; stroke-width: 2.5; }\n";
    ofs << "    .num-curve { fill: none; stroke: #f0883e; stroke-width: 2.0; stroke-dasharray: 6,3; }\n";
    ofs << "    .corridor-yellow { fill: rgba(210, 153, 34, 0.18); }\n";
    ofs << "    .corridor-green { fill: rgba(46, 160, 67, 0.30); }\n";
    ofs << "  </style>\n";

    // Background
    ofs << "  <rect width=\"" << W << "\" height=\"" << H << "\" fill=\"#0d1117\" rx=\"8\"/>\n";

    // Title
    ofs << "  <text x=\"" << (W / 2) << "\" y=\"30\" text-anchor=\"middle\" class=\"title\">" << title << "</text>\n";

    // Grid lines
    for (int i = 0; i <= 5; ++i) {
        double y_val = y_min + (static_cast<double>(i) / 5.0) * (y_max - y_min);
        double py = map_y(y_val);
        ofs << "  <line x1=\"" << pad_left << "\" y1=\"" << py << "\" x2=\"" << (W - pad_right) << "\" y2=\"" << py << "\" class=\"grid\"/>\n";
        ofs << "  <text x=\"" << (pad_left - 8) << "\" y=\"" << (py + 4) << "\" text-anchor=\"end\" class=\"tick\">"
            << std::setprecision(3) << y_val << "</text>\n";
    }

    for (int i = 0; i <= 5; ++i) {
        double x_val = x_min + (static_cast<double>(i) / 5.0) * (x_max - x_min);
        double px = map_x(x_val);
        ofs << "  <line x1=\"" << px << "\" y1=\"" << pad_top << "\" x2=\"" << px << "\" y2=\"" << (H - pad_bottom) << "\" class=\"grid\"/>\n";
        ofs << "  <text x=\"" << px << "\" y=\"" << (H - pad_bottom + 18) << "\" text-anchor=\"middle\" class=\"tick\">"
            << std::setprecision(3) << x_val << "</text>\n";
    }

    // Yellow Corridor (+/- 5%)
    ofs << "  <path class=\"corridor-yellow\" d=\"";
    for (size_t i = 0; i < x_data.size(); ++i) {
        double factor = 1.0 + (yellow_pct / 100.0);
        double val = exact_data[i] * factor;
        ofs << (i == 0 ? "M " : "L ") << map_x(x_data[i]) << " " << map_y(val) << " ";
    }
    for (int i = static_cast<int>(x_data.size()) - 1; i >= 0; --i) {
        double factor = 1.0 - (yellow_pct / 100.0);
        double val = exact_data[i] * factor;
        ofs << "L " << map_x(x_data[i]) << " " << map_y(val) << " ";
    }
    ofs << "Z\"/>\n";

    // Green Corridor (+/- 1%)
    ofs << "  <path class=\"corridor-green\" d=\"";
    for (size_t i = 0; i < x_data.size(); ++i) {
        double factor = 1.0 + (green_pct / 100.0);
        double val = exact_data[i] * factor;
        ofs << (i == 0 ? "M " : "L ") << map_x(x_data[i]) << " " << map_y(val) << " ";
    }
    for (int i = static_cast<int>(x_data.size()) - 1; i >= 0; --i) {
        double factor = 1.0 - (green_pct / 100.0);
        double val = exact_data[i] * factor;
        ofs << "L " << map_x(x_data[i]) << " " << map_y(val) << " ";
    }
    ofs << "Z\"/>\n";

    // Exact analytical curve
    ofs << "  <path class=\"exact-curve\" d=\"";
    for (size_t i = 0; i < x_data.size(); ++i) {
        ofs << (i == 0 ? "M " : "L ") << map_x(x_data[i]) << " " << map_y(exact_data[i]) << " ";
    }
    ofs << "\"/>\n";

    // Numerical simulation curve
    if (!num_data.empty()) {
        ofs << "  <path class=\"num-curve\" d=\"";
        for (size_t i = 0; i < num_data.size() && i < x_data.size(); ++i) {
            ofs << (i == 0 ? "M " : "L ") << map_x(x_data[i]) << " " << map_y(num_data[i]) << " ";
        }
        ofs << "\"/>\n";

        // Draw points
        for (size_t i = 0; i < num_data.size() && i < x_data.size(); ++i) {
            ofs << "  <circle cx=\"" << map_x(x_data[i]) << "\" cy=\"" << map_y(num_data[i]) << "\" r=\"3.5\" fill=\"#f0883e\"/>\n";
        }
    }

    // Axes lines
    ofs << "  <line x1=\"" << pad_left << "\" y1=\"" << (H - pad_bottom) << "\" x2=\"" << (W - pad_right) << "\" y2=\"" << (H - pad_bottom) << "\" class=\"axis-line\"/>\n";
    ofs << "  <line x1=\"" << pad_left << "\" y1=\"" << pad_top << "\" x2=\"" << pad_left << "\" y2=\"" << (H - pad_bottom) << "\" class=\"axis-line\"/>\n";

    // Axis labels
    ofs << "  <text x=\"" << (W / 2) << "\" y=\"" << (H - 15) << "\" text-anchor=\"middle\" class=\"axis-label\">" << x_label << "</text>\n";
    ofs << "  <text x=\"20\" y=\"" << (H / 2) << "\" text-anchor=\"middle\" transform=\"rotate(-90 20 " << (H/2) << ")\" class=\"axis-label\">" << y_label << "</text>\n";

    // Legend
    int leg_x = W - 230;
    int leg_y = 55;
    ofs << "  <rect x=\"" << leg_x << "\" y=\"" << leg_y << "\" width=\"195\" height=\"85\" fill=\"#161b22\" stroke=\"#30363d\" rx=\"4\"/>\n";
    // Exact
    ofs << "  <line x1=\"" << (leg_x + 10) << "\" y1=\"" << (leg_y + 18) << "\" x2=\"" << (leg_x + 35) << "\" y2=\"" << (leg_y + 18) << "\" stroke=\"#58a6ff\" stroke-width=\"2.5\"/>\n";
    ofs << "  <text x=\"" << (leg_x + 42) << "\" y=\"" << (leg_y + 22) << "\" font-size=\"11\">Analytical / Exact</text>\n";
    // Numerical
    ofs << "  <line x1=\"" << (leg_x + 10) << "\" y1=\"" << (leg_y + 38) << "\" x2=\"" << (leg_x + 35) << "\" y2=\"" << (leg_y + 38) << "\" stroke=\"#f0883e\" stroke-width=\"2.0\" stroke-dasharray=\"4,2\"/>\n";
    ofs << "  <circle cx=\"" << (leg_x + 22) << "\" cy=\"" << (leg_y + 38) << "\" r=\"3\" fill=\"#f0883e\"/>\n";
    ofs << "  <text x=\"" << (leg_x + 42) << "\" y=\"" << (leg_y + 42) << "\" font-size=\"11\">Numerical Result</text>\n";
    // Green corridor
    ofs << "  <rect x=\"" << (leg_x + 10) << "\" y=\"" << (leg_y + 52) << "\" width=\"25\" height=\"10\" fill=\"rgba(46,160,67,0.5)\"/>\n";
    ofs << "  <text x=\"" << (leg_x + 42) << "\" y=\"" << (leg_y + 61) << "\" font-size=\"10\">Acceptance Corridor ±" << green_pct << "%</text>\n";
    // Yellow corridor
    ofs << "  <rect x=\"" << (leg_x + 10) << "\" y=\"" << (leg_y + 68) << "\" width=\"25\" height=\"10\" fill=\"rgba(210,153,34,0.3)\"/>\n";
    ofs << "  <text x=\"" << (leg_x + 42) << "\" y=\"" << (leg_y + 77) << "\" font-size=\"10\">Tolerance Corridor ±" << yellow_pct << "%</text>\n";

    ofs << "</svg>\n";
    return true;
}

bool generate_verification_manual(
    const std::string& output_md_path,
    const std::vector<BenchmarkResult>& results
) {
    std::ofstream ofs(output_md_path);
    if (!ofs.is_open()) return false;

    int total_benchmarks = static_cast<int>(results.size());
    int total_passed = 0;
    int total_pending = 0;
    int total_failed = 0;
    for (const auto& r : results) {
        if (r.pending) total_pending++;
        else if (r.passed) total_passed++;
        else total_failed++;
    }

    ofs << "# BlastDaemon Living Verification & Validation Compendium\n\n";
    ofs << "> Autonomous Continuous Verification & Validation Engine per Master Directive 16 & 17.\n\n";

    // Status Summary Banner
    ofs << "## Verification Status Overview\n\n";
    ofs << "| Total Benchmarks | Verified & Passed | Pending Integration | Failed | Active Pass Rate |\n";
    ofs << "| :--- | :---: | :---: | :---: | :---: |\n";
    int active_benchmarks = total_passed + total_failed;
    double pass_rate = (active_benchmarks > 0) ? (100.0 * total_passed / active_benchmarks) : 100.0;
    ofs << "| **" << total_benchmarks << "** | **" << total_passed << "** | **" 
        << total_pending << "** | **" << total_failed << "** | **" 
        << std::fixed << std::setprecision(1) << pass_rate << "%** |\n\n";

    // Summary Table
    ofs << "### Master Benchmark Matrix\n\n";
    ofs << "| Benchmark ID | Level | Benchmark Title | Observed Metric | Tolerance | Status |\n";
    ofs << "| :--- | :---: | :--- | :--- | :--- | :---: |\n";

    for (const auto& r : results) {
        std::string badge = r.pending
            ? "<span style=\"color:#d29922;font-weight:bold;\">PENDING</span>"
            : (r.passed 
                ? "<span style=\"color:#2ea043;font-weight:bold;\">PASS</span>"
                : "<span style=\"color:#f85149;font-weight:bold;\">FAIL</span>");

        std::ostringstream obs, tol;
        if (r.pending) {
            obs << "STATUS: PENDING INTEGRATION";
            tol << "Full Multi-Scale Integration";
        } else if (r.error_l2 > 0.0) {
            obs << "e_L2 = " << std::scientific << std::setprecision(2) << r.error_l2;
            tol << "e_L2 <= " << std::scientific << std::setprecision(2) << r.tolerance_l2;
        } else if (r.r_squared < 1.0) {
            obs << "R^2 = " << std::fixed << std::setprecision(4) << r.r_squared;
            tol << "R^2 >= " << std::fixed << std::setprecision(3) << r.tolerance_r2;
        } else if (r.energy_drift > 0.0) {
            obs << "e_energy = " << std::scientific << std::setprecision(2) << r.energy_drift;
            tol << "e_energy <= " << std::scientific << std::setprecision(2) << r.tolerance_energy;
        } else {
            obs << "e_Linf = " << std::scientific << std::setprecision(2) << r.error_linf;
            tol << "e_Linf <= " << std::scientific << std::setprecision(2) << r.tolerance_linf;
        }

        ofs << "| **" << r.id << "** | Level " << r.level << " | " << r.title 
            << " | `" << obs.str() << "` | `" << tol.str() << "` | " << badge << " |\n";
    }
    ofs << "\n---\n\n";

    // Group by levels
    for (int lvl = 1; lvl <= 4; ++lvl) {
        std::string lvl_title = (lvl == 1 ? "Level 1: Unit & Single-Element Verification (Microscale)" :
                                (lvl == 2 ? "Level 2: Canonical Mesoscale Benchmarks" :
                                (lvl == 3 ? "Level 3: Component & Subsystem Impact/Blast Tests (Macroscale)" :
                                            "Level 4: Full-Scale 3D Multi-Physics System Test Cases (Mega-Scale)")));

        ofs << "## " << lvl_title << "\n\n";

        for (const auto& r : results) {
            if (r.level != lvl) continue;

            ofs << "### " << r.id << ": " << r.title << "\n\n";
            std::string status_label = r.pending ? "**STATUS: PENDING FULL INTEGRATION**" : (r.passed ? "**PASSED**" : "**FAILED**");
            ofs << "- **Status:** " << status_label << "\n";
            ofs << "- **Summary:** " << r.summary << "\n\n";

            if (!r.details.empty()) {
                ofs << "#### Governing Formulation & Technical Details\n\n";
                ofs << r.details << "\n\n";
            }

            if (!r.pending && !r.svg_path.empty()) {
                ofs << "#### Numerical vs. Exact Verification Plot\n\n";
                ofs << "![" << r.title << "](" << r.svg_path << ")\n\n";
            }

            if (!r.pending && !r.mesh_svg_path.empty()) {
                std::string caption = r.mesh_svg_caption.empty() ? (r.title + " Mesh and Field Contour Map") : r.mesh_svg_caption;
                ofs << "#### Computational Discretization & Field Contour Map\n\n";
                ofs << "![" << caption << "](" << r.mesh_svg_path << ")\n\n";
            }

            if (r.pending) {
                ofs << "#### Simulation Status & Verification Notice\n\n";
                ofs << "> **Simulation Deferred to Multi-Scale Pipeline:** Full numerical simulation for this benchmark requires coupled multi-physics execution. Per Master Directive 17 (Prime Directive), synthetic, mocked, or scaled simulation curves are strictly prohibited. Genuine numerical datasets will be reported upon complete solver pipeline integration.\n\n";
            }
            ofs << "---\n\n";
        }
    }

    return true;
}

} // namespace Blast::VV
