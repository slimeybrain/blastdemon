#include "vv_mesh_visualizer.hpp"
#include <fstream>
#include <sstream>
#include <iomanip>
#include <cmath>
#include <algorithm>

namespace Blast::VV {

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

RGBColor sample_colormap(double t, ColormapType cmap) {
    t = std::max(0.0, std::min(1.0, t));
    RGBColor color;

    switch (cmap) {
        case ColormapType::RainbowFEA: {
            // Classic FEA Rainbow: Blue (0.0) -> Cyan (0.25) -> Green (0.5) -> Yellow (0.75) -> Red (1.0)
            double r = 0.0, g = 0.0, b = 0.0;
            if (t < 0.25) {
                double s = t / 0.25;
                r = 0.0;
                g = s;
                b = 1.0;
            } else if (t < 0.50) {
                double s = (t - 0.25) / 0.25;
                r = 0.0;
                g = 1.0;
                b = 1.0 - s;
            } else if (t < 0.75) {
                double s = (t - 0.50) / 0.25;
                r = s;
                g = 1.0;
                b = 0.0;
            } else {
                double s = (t - 0.75) / 0.25;
                r = 1.0;
                g = 1.0 - s;
                b = 0.0;
            }
            color.r = static_cast<uint8_t>(std::clamp(r * 255.0, 0.0, 255.0));
            color.g = static_cast<uint8_t>(std::clamp(g * 255.0, 0.0, 255.0));
            color.b = static_cast<uint8_t>(std::clamp(b * 255.0, 0.0, 255.0));
            break;
        }
        case ColormapType::Turbo: {
            // Google Turbo Colormap polynomial approximation
            double x = t;
            double r = 0.1357 + x * ( 4.5974 - x * ( 42.3277 - x * ( 130.5887 - x * ( 150.5668 - x * 58.1375 ) ) ) );
            double g = 0.0914 + x * ( 2.1856 + x * ( 4.8052 - x * ( 14.0195 - x * ( 4.2109 - x * 2.7747 ) ) ) );
            double b = 0.1067 + x * ( 12.5593 - x * ( 60.1971 - x * ( 109.0745 - x * ( 88.5080 - x * 26.8183 ) ) ) );
            color.r = static_cast<uint8_t>(std::clamp(r * 255.0, 0.0, 255.0));
            color.g = static_cast<uint8_t>(std::clamp(g * 255.0, 0.0, 255.0));
            color.b = static_cast<uint8_t>(std::clamp(b * 255.0, 0.0, 255.0));
            break;
        }
        case ColormapType::CoolWarm: {
            // Blue to White to Red
            double r = (t < 0.5) ? 2.0 * t : 1.0;
            double g = (t < 0.5) ? 2.0 * t : 2.0 * (1.0 - t);
            double b = (t < 0.5) ? 1.0 : 2.0 * (1.0 - t);
            color.r = static_cast<uint8_t>(std::clamp(r * 255.0, 0.0, 255.0));
            color.g = static_cast<uint8_t>(std::clamp(g * 255.0, 0.0, 255.0));
            color.b = static_cast<uint8_t>(std::clamp(b * 255.0, 0.0, 255.0));
            break;
        }
        case ColormapType::Grayscale: {
            uint8_t v = static_cast<uint8_t>(std::clamp(t * 255.0, 0.0, 255.0));
            color.r = v; color.g = v; color.b = v;
            break;
        }
    }
    return color;
}

MeshVisualizer::MeshVisualizer(const VisualizerConfig& config)
    : m_config(config) {}

void MeshVisualizer::project_point(
    double x, double y, double z,
    double& px, double& py
) const {
    switch (m_config.projection) {
        case ProjectionMode::PlaneXY:
            px = x;
            py = y;
            break;
        case ProjectionMode::PlaneXZ:
            px = x;
            py = z;
            break;
        case ProjectionMode::PlaneYZ:
            px = y;
            py = z;
            break;
        case ProjectionMode::Isometric3D: {
            // Isometric 30 degree projection
            const double cos30 = std::cos(30.0 * M_PI / 180.0);
            const double sin30 = std::sin(30.0 * M_PI / 180.0);
            px = (x - y) * cos30;
            py = z + (x + y) * sin30 * 0.5;
            break;
        }
    }
}

void MeshVisualizer::compute_bounds_and_range(
    const std::vector<VisualNode>& nodes,
    const std::vector<VisualElement>& elements,
    double& min_x, double& max_x,
    double& min_y, double& max_y,
    double& val_min, double& val_max
) const {
    min_x = 1.0e30; max_x = -1.0e30;
    min_y = 1.0e30; max_y = -1.0e30;
    val_min = 1.0e30; val_max = -1.0e30;

    for (const auto& n : nodes) {
        // Undeformed
        double px0 = 0.0, py0 = 0.0;
        project_point(n.x, n.y, n.z, px0, py0);
        min_x = std::min(min_x, px0); max_x = std::max(max_x, px0);
        min_y = std::min(min_y, py0); max_y = std::max(max_y, py0);

        // Deformed with scale factor
        double px = 0.0, py = 0.0;
        project_point(
            n.x + m_config.scale_factor * n.ux,
            n.y + m_config.scale_factor * n.uy,
            n.z + m_config.scale_factor * n.uz,
            px, py
        );
        min_x = std::min(min_x, px); max_x = std::max(max_x, px);
        min_y = std::min(min_y, py); max_y = std::max(max_y, py);

        if (!elements.empty()) {
            val_min = std::min(val_min, n.scalar);
            val_max = std::max(val_max, n.scalar);
        }
    }

    for (const auto& el : elements) {
        val_min = std::min(val_min, el.scalar);
        val_max = std::max(val_max, el.scalar);
    }

    if (!m_config.auto_range) {
        val_min = m_config.field_min;
        val_max = m_config.field_max;
    }
    if (std::abs(val_max - val_min) < 1.0e-12) {
        val_max = val_min + 1.0;
    }
    if (std::abs(max_x - min_x) < 1.0e-12) max_x = min_x + 1.0;
    if (std::abs(max_y - min_y) < 1.0e-12) max_y = min_y + 1.0;
}

void MeshVisualizer::write_svg_header(std::ostream& os) const {
    os << "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
    os << "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 "
       << m_config.width << " " << m_config.height
       << "\" width=\"" << m_config.width << "\" height=\"" << m_config.height << "\">\n";
    os << "  <style>\n";
    os << "    text { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; fill: #c9d1d9; }\n";
    os << "    .title { font-size: 15px; font-weight: 600; fill: #f0f6fc; }\n";
    os << "    .subtitle { font-size: 11px; fill: #8b949e; }\n";
    os << "    .legend-title { font-size: 11px; font-weight: 600; fill: #e6edf3; }\n";
    os << "    .legend-tick { font-size: 10px; fill: #8b949e; }\n";
    os << "    .mesh-wire { stroke: rgba(13, 17, 23, 0.45); stroke-width: 0.8; }\n";
    os << "    .undeformed-wire { stroke: #58a6ff; stroke-width: 1.0; stroke-dasharray: 4,3; fill: none; opacity: 0.7; }\n";
    os << "  </style>\n";

    // Dark background container
    os << "  <rect width=\"" << m_config.width << "\" height=\"" << m_config.height
       << "\" fill=\"#0d1117\" rx=\"8\" stroke=\"#30363d\" stroke-width=\"1\"/>\n";

    // Title
    os << "  <text x=\"" << (m_config.width / 2) << "\" y=\"28\" text-anchor=\"middle\" class=\"title\">"
       << m_config.title << "</text>\n";
    if (m_config.scale_factor > 1.01) {
        os << "  <text x=\"" << (m_config.width / 2) << "\" y=\"45\" text-anchor=\"middle\" class=\"subtitle\">"
           << "(Displacement Exaggeration: " << std::fixed << std::setprecision(1) << m_config.scale_factor << "x | Dashed Line: Undeformed Reference)"
           << "</text>\n";
    }
}

void MeshVisualizer::write_svg_footer(std::ostream& os) const {
    os << "</svg>\n";
}

void MeshVisualizer::write_colorbar(
    std::ostream& os,
    double min_val, double max_val
) const {
    const int cb_x = m_config.width - m_config.pad_right + 35;
    const int cb_y = m_config.pad_top + 30;
    const int cb_w = 18;
    const int cb_h = m_config.height - m_config.pad_top - m_config.pad_bottom - 50;

    // Gradient definitions
    os << "  <defs>\n";
    os << "    <linearGradient id=\"vv_colorbar_grad\" x1=\"0%\" y1=\"100%\" x2=\"0%\" y2=\"0%\">\n";
    const int num_stops = 10;
    for (int i = 0; i <= num_stops; ++i) {
        double s = static_cast<double>(i) / num_stops;
        RGBColor c = sample_colormap(s, m_config.colormap);
        os << "      <stop offset=\"" << std::fixed << std::setprecision(1) << (s * 100.0) << "%\" stop-color=\"" << c.to_hex() << "\"/>\n";
    }
    os << "    </linearGradient>\n";
    os << "  </defs>\n";

    // Colorbar Rect
    os << "  <!-- Colorbar Container -->\n";
    os << "  <rect x=\"" << cb_x << "\" y=\"" << cb_y << "\" width=\"" << cb_w << "\" height=\"" << cb_h
       << "\" fill=\"url(#vv_colorbar_grad)\" stroke=\"#30363d\" stroke-width=\"1\" rx=\"2\"/>\n";

    // Legend Title (visualized field and units)
    os << "  <text x=\"" << (cb_x + cb_w / 2) << "\" y=\"" << (cb_y - 12)
       << "\" text-anchor=\"middle\" class=\"legend-title\">"
       << m_config.field_name << "</text>\n";
    if (!m_config.field_units.empty()) {
        os << "  <text x=\"" << (cb_x + cb_w / 2) << "\" y=\"" << (cb_y - 2)
           << "\" text-anchor=\"middle\" class=\"legend-tick\">["
           << m_config.field_units << "]</text>\n";
    }

    // Ticks (5 intervals)
    for (int i = 0; i <= 4; ++i) {
        double frac = static_cast<double>(i) / 4.0;
        double val = min_val + frac * (max_val - min_val);
        double py = (cb_y + cb_h) - frac * cb_h;

        os << "  <line x1=\"" << (cb_x + cb_w) << "\" y1=\"" << py
           << "\" x2=\"" << (cb_x + cb_w + 5) << "\" y2=\"" << py
           << "\" stroke=\"#8b949e\" stroke-width=\"1\"/>\n";

        std::ostringstream val_ss;
        if (std::abs(val) >= 1.0e4 || (std::abs(val) > 0.0 && std::abs(val) < 0.01)) {
            val_ss << std::scientific << std::setprecision(2) << val;
        } else {
            val_ss << std::fixed << std::setprecision(2) << val;
        }
        os << "  <text x=\"" << (cb_x + cb_w + 8) << "\" y=\"" << (py + 3.5)
           << "\" class=\"legend-tick\">" << val_ss.str() << "</text>\n";
    }
}

bool MeshVisualizer::render_element_mesh(
    const std::string& filepath,
    const std::vector<VisualNode>& nodes,
    const std::vector<VisualElement>& elements
) {
    if (nodes.empty() || elements.empty()) return false;

    std::ofstream ofs(filepath);
    if (!ofs.is_open()) return false;

    double min_x, max_x, min_y, max_y, val_min, val_max;
    compute_bounds_and_range(nodes, elements, min_x, max_x, min_y, max_y, val_min, val_max);

    // Coordinate mapping with uniform scaling (maintain aspect ratio)
    const double plot_w = m_config.width - m_config.pad_left - m_config.pad_right;
    const double plot_h = m_config.height - m_config.pad_top - m_config.pad_bottom;

    double span_x = max_x - min_x;
    double span_y = max_y - min_y;
    double scale = std::min(plot_w / span_x, plot_h / span_y) * 0.90;

    double cx_mesh = 0.5 * (min_x + max_x);
    double cy_mesh = 0.5 * (min_y + max_y);
    double cx_plot = m_config.pad_left + 0.5 * plot_w;
    double cy_plot = m_config.pad_top + 0.5 * plot_h;

    auto map_to_screen = [&](double px, double py) -> std::pair<double, double> {
        double sx = cx_plot + (px - cx_mesh) * scale;
        double sy = cy_plot - (py - cy_mesh) * scale; // Invert y for SVG
        return {sx, sy};
    };

    write_svg_header(ofs);

    // 1. Render undeformed wireframe overlay if enabled
    if (m_config.show_undeformed_wireframe && m_config.scale_factor > 0.0) {
        ofs << "  <!-- Undeformed Reference Configuration -->\n";
        for (const auto& el : elements) {
            ofs << "  <polygon class=\"undeformed-wire\" points=\"";
            for (int idx : el.node_indices) {
                if (idx < 0 || idx >= static_cast<int>(nodes.size())) continue;
                double px = 0.0, py = 0.0;
                project_point(nodes[idx].x, nodes[idx].y, nodes[idx].z, px, py);
                auto [sx, sy] = map_to_screen(px, py);
                ofs << sx << "," << sy << " ";
            }
            ofs << "\"/>\n";
        }
    }

    // 2. Render deformed element polygons colored by scalar field
    ofs << "  <!-- Deformed Mesh with Field Contour Fill -->\n";
    for (const auto& el : elements) {
        // Element average scalar
        double val = el.scalar;
        if (std::abs(val) < 1.0e-15 && !el.node_indices.empty()) {
            for (int idx : el.node_indices) {
                if (idx >= 0 && idx < static_cast<int>(nodes.size())) {
                    val += nodes[idx].scalar;
                }
            }
            val /= el.node_indices.size();
        }

        double norm_val = (val - val_min) / (val_max - val_min);
        RGBColor fill_col = sample_colormap(norm_val, m_config.colormap);

        ofs << "  <polygon points=\"";
        for (int idx : el.node_indices) {
            if (idx < 0 || idx >= static_cast<int>(nodes.size())) continue;
            const auto& n = nodes[idx];
            double def_x = n.x + m_config.scale_factor * n.ux;
            double def_y = n.y + m_config.scale_factor * n.uy;
            double def_z = n.z + m_config.scale_factor * n.uz;

            double px = 0.0, py = 0.0;
            project_point(def_x, def_y, def_z, px, py);
            auto [sx, sy] = map_to_screen(px, py);
            ofs << sx << "," << sy << " ";
        }
        ofs << "\" fill=\"" << fill_col.to_hex() << "\" class=\"mesh-wire\"/>\n";
    }

    // 3. Write Colorbar Legend
    write_colorbar(ofs, val_min, val_max);

    write_svg_footer(ofs);
    return true;
}

bool MeshVisualizer::render_particle_cloud(
    const std::string& filepath,
    const std::vector<VisualParticle>& particles
) {
    if (particles.empty()) return false;

    std::ofstream ofs(filepath);
    if (!ofs.is_open()) return false;

    double min_x = 1.0e30, max_x = -1.0e30;
    double min_y = 1.0e30, max_y = -1.0e30;
    double val_min = 1.0e30, val_max = -1.0e30;

    for (const auto& p : particles) {
        double px = 0.0, py = 0.0;
        project_point(p.x, p.y, p.z, px, py);
        min_x = std::min(min_x, px); max_x = std::max(max_x, px);
        min_y = std::min(min_y, py); max_y = std::max(max_y, py);
        val_min = std::min(val_min, p.scalar);
        val_max = std::max(val_max, p.scalar);
    }

    if (!m_config.auto_range) {
        val_min = m_config.field_min;
        val_max = m_config.field_max;
    }
    if (std::abs(val_max - val_min) < 1.0e-12) val_max = val_min + 1.0;
    if (std::abs(max_x - min_x) < 1.0e-12) max_x = min_x + 1.0;
    if (std::abs(max_y - min_y) < 1.0e-12) max_y = min_y + 1.0;

    const double plot_w = m_config.width - m_config.pad_left - m_config.pad_right;
    const double plot_h = m_config.height - m_config.pad_top - m_config.pad_bottom;

    double span_x = max_x - min_x;
    double span_y = max_y - min_y;
    double scale = std::min(plot_w / span_x, plot_h / span_y) * 0.90;

    double cx_mesh = 0.5 * (min_x + max_x);
    double cy_mesh = 0.5 * (min_y + max_y);
    double cx_plot = m_config.pad_left + 0.5 * plot_w;
    double cy_plot = m_config.pad_top + 0.5 * plot_h;

    auto map_to_screen = [&](double px, double py) -> std::pair<double, double> {
        double sx = cx_plot + (px - cx_mesh) * scale;
        double sy = cy_plot - (py - cy_mesh) * scale;
        return {sx, sy};
    };

    write_svg_header(ofs);

    // Render particle primitives
    ofs << "  <!-- MPM Particle Cloud Primitives -->\n";
    for (const auto& p : particles) {
        double px = 0.0, py = 0.0;
        project_point(p.x, p.y, p.z, px, py);
        auto [sx, sy] = map_to_screen(px, py);

        double norm_val = (p.scalar - val_min) / (val_max - val_min);
        RGBColor c = sample_colormap(norm_val, m_config.colormap);

        ofs << "  <circle cx=\"" << sx << "\" cy=\"" << sy << "\" r=\""
            << p.radius << "\" fill=\"" << c.to_hex()
            << "\" fill-opacity=\"0.95\" stroke=\"rgba(0,0,0,0.4)\" stroke-width=\"0.5\"/>\n";
    }

    // Write Colorbar
    write_colorbar(ofs, val_min, val_max);

    write_svg_footer(ofs);
    return true;
}

bool MeshVisualizer::render_cfd_1d_grid(
    const std::string& filepath,
    const std::vector<VisualGrid1DCell>& cells,
    const std::string& field_to_color
) {
    if (cells.empty()) return false;

    std::ofstream ofs(filepath);
    if (!ofs.is_open()) return false;

    double x_min = cells.front().x_left;
    double x_max = cells.back().x_right;
    if (std::abs(x_max - x_min) < 1.0e-12) x_max = x_min + 1.0;

    double val_min = 1.0e30, val_max = -1.0e30;
    for (const auto& c : cells) {
        double v = (field_to_color == "pressure") ? c.pressure : c.density;
        val_min = std::min(val_min, v);
        val_max = std::max(val_max, v);
    }
    if (!m_config.auto_range) {
        val_min = m_config.field_min;
        val_max = m_config.field_max;
    }
    if (std::abs(val_max - val_min) < 1.0e-12) val_max = val_min + 1.0;

    const double plot_w = m_config.width - m_config.pad_left - m_config.pad_right;
    const double plot_h = m_config.height - m_config.pad_top - m_config.pad_bottom;

    auto map_x = [&](double x) -> double {
        return m_config.pad_left + ((x - x_min) / (x_max - x_min)) * plot_w;
    };

    write_svg_header(ofs);

    // 1. Upper qualitative/quantitative curve
    const double curve_top = m_config.pad_top + 10;
    const double curve_h = plot_h * 0.65;
    const double curve_bottom = curve_top + curve_h;

    auto map_y_curve = [&](double v) -> double {
        return curve_bottom - ((v - val_min) / (val_max - val_min)) * curve_h;
    };

    // Grid lines for curve
    for (int i = 0; i <= 4; ++i) {
        double frac = static_cast<double>(i) / 4.0;
        double gy = curve_bottom - frac * curve_h;
        double gval = val_min + frac * (val_max - val_min);

        ofs << "  <line x1=\"" << m_config.pad_left << "\" y1=\"" << gy
           << "\" x2=\"" << (m_config.pad_left + plot_w) << "\" y2=\"" << gy
           << "\" stroke=\"#30363d\" stroke-dasharray=\"4,4\" stroke-width=\"1\"/>\n";

        std::ostringstream val_ss;
        val_ss << std::fixed << std::setprecision(2) << gval;
        ofs << "  <text x=\"" << (m_config.pad_left - 8) << "\" y=\"" << (gy + 4)
            << "\" text-anchor=\"end\" class=\"legend-tick\">" << val_ss.str() << "</text>\n";
    }

    // Draw stepped cell-averaged curve
    ofs << "  <!-- 1D CFD Cell Averaged Finite-Volume Profile -->\n";
    ofs << "  <path d=\"";
    for (size_t i = 0; i < cells.size(); ++i) {
        double v = (field_to_color == "pressure") ? cells[i].pressure : cells[i].density;
        double sx1 = map_x(cells[i].x_left);
        double sx2 = map_x(cells[i].x_right);
        double sy = map_y_curve(v);
        if (i == 0) {
            ofs << "M " << sx1 << " " << sy << " ";
        } else {
            ofs << "L " << sx1 << " " << sy << " ";
        }
        ofs << "L " << sx2 << " " << sy << " ";
    }
    ofs << "\" fill=\"none\" stroke=\"#58a6ff\" stroke-width=\"2.5\"/>\n";

    // 2. Lower cell strip contour
    const double strip_top = curve_bottom + 25;
    const double strip_h = 35;

    ofs << "  <!-- 1D CFD Spatial Cell Colormap Strip -->\n";
    for (const auto& c : cells) {
        double v = (field_to_color == "pressure") ? c.pressure : c.density;
        double sx1 = map_x(c.x_left);
        double sx2 = map_x(c.x_right);
        double sw = std::max(1.0, sx2 - sx1);

        double norm_val = (v - val_min) / (val_max - val_min);
        RGBColor col = sample_colormap(norm_val, m_config.colormap);

        ofs << "  <rect x=\"" << sx1 << "\" y=\"" << strip_top
            << "\" width=\"" << sw << "\" height=\"" << strip_h
            << "\" fill=\"" << col.to_hex() << "\" stroke=\"rgba(13,17,23,0.5)\" stroke-width=\"0.5\"/>\n";
    }

    // Ticks on spatial x-axis
    for (int i = 0; i <= 5; ++i) {
        double frac = static_cast<double>(i) / 5.0;
        double x_val = x_min + frac * (x_max - x_min);
        double sx = map_x(x_val);

        ofs << "  <line x1=\"" << sx << "\" y1=\"" << (strip_top + strip_h)
            << "\" x2=\"" << sx << "\" y2=\"" << (strip_top + strip_h + 5)
            << "\" stroke=\"#8b949e\" stroke-width=\"1\"/>\n";
        ofs << "  <text x=\"" << sx << "\" y=\"" << (strip_top + strip_h + 18)
            << "\" text-anchor=\"middle\" class=\"legend-tick\">"
            << std::fixed << std::setprecision(2) << x_val << "</text>\n";
    }
    ofs << "  <text x=\"" << (m_config.pad_left + plot_w / 2) << "\" y=\"" << (strip_top + strip_h + 34)
        << "\" text-anchor=\"middle\" class=\"legend-title\">Spatial Coordinate x (m)</text>\n";

    // Write Colorbar
    write_colorbar(ofs, val_min, val_max);

    write_svg_footer(ofs);
    return true;
}

} // namespace Blast::VV
