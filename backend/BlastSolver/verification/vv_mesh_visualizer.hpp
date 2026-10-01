#pragma once

#include <string>
#include <vector>
#include <array>
#include <cstdint>
#include <cmath>
#include <algorithm>
#include <sstream>
#include <iomanip>

namespace Blast::VV {

enum class ColormapType {
    RainbowFEA, // Blue -> Cyan -> Green -> Yellow -> Red
    Turbo,      // Google Turbo Colormap
    CoolWarm,   // Blue to Red divergence
    Grayscale
};

enum class ProjectionMode {
    PlaneXY,    // 2D projection on X-Y plane
    PlaneXZ,    // 2D projection on X-Z plane
    PlaneYZ,    // 2D projection on Y-Z plane
    Isometric3D // 3D Isometric projection
};

struct RGBColor {
    uint8_t r{0};
    uint8_t g{0};
    uint8_t b{0};

    std::string to_hex() const {
        std::ostringstream ss;
        ss << "#" << std::hex << std::setfill('0')
           << std::setw(2) << static_cast<int>(r)
           << std::setw(2) << static_cast<int>(g)
           << std::setw(2) << static_cast<int>(b);
        return ss.str();
    }
};

// Colormap evaluation functions mapping normalized value in [0, 1] to RGB
RGBColor sample_colormap(double t, ColormapType cmap = ColormapType::RainbowFEA);

// Mesh structures for visualization
struct VisualNode {
    double x{0.0}, y{0.0}, z{0.0};       // Initial reference position
    double ux{0.0}, uy{0.0}, uz{0.0};    // Displacement vector
    double scalar{0.0};                  // Nodal field value
};

struct VisualElement {
    std::vector<int> node_indices;       // Connectivity (e.g. 4 for Quad/Hex face, 3 for Tri, 8 for Hex)
    double scalar{0.0};                  // Element-averaged or centroid field value
};

struct VisualParticle {
    double x{0.0}, y{0.0}, z{0.0};       // Position
    double scalar{0.0};                  // Particle field value (e.g. plastic strain, pressure)
    double radius{2.5};                  // Render radius in SVG pixels
};

struct VisualGrid1DCell {
    double x_left{0.0};
    double x_right{0.0};
    double density{0.0};
    double pressure{0.0};
    double velocity{0.0};
};

struct VisualizerConfig {
    int width{900};
    int height{550};
    int pad_left{80};
    int pad_right{150}; // space for vertical colorbar
    int pad_top{60};
    int pad_bottom{60};
    std::string title;
    std::string field_name;
    std::string field_units;
    ColormapType colormap{ColormapType::RainbowFEA};
    ProjectionMode projection{ProjectionMode::PlaneXY};
    double scale_factor{1.0};           // Displacement exaggeration factor
    bool show_undeformed_wireframe{true};
    bool show_mesh_wireframe{true};
    bool auto_range{true};
    double field_min{0.0};
    double field_max{1.0};
};

// Zero-Dependency SVG Mesh & Field Contour Visualizer
class MeshVisualizer {
public:
    explicit MeshVisualizer(const VisualizerConfig& config = VisualizerConfig{});

    // Render 2D / 3D Solid & Shell Elements with Colormapped Field and Optional Deformed Overlay
    bool render_element_mesh(
        const std::string& filepath,
        const std::vector<VisualNode>& nodes,
        const std::vector<VisualElement>& elements
    );

    // Render MPM Particle Cloud with Colormapped Particle Scalar Field
    bool render_particle_cloud(
        const std::string& filepath,
        const std::vector<VisualParticle>& particles
    );

    // Render 1D CFD Finite-Volume Grid Layout and Density/Pressure Colorband
    bool render_cfd_1d_grid(
        const std::string& filepath,
        const std::vector<VisualGrid1DCell>& cells,
        const std::string& field_to_color = "density" // "density" or "pressure"
    );

private:
    VisualizerConfig m_config;

    void project_point(
        double x, double y, double z,
        double& px, double& py
    ) const;

    void compute_bounds_and_range(
        const std::vector<VisualNode>& nodes,
        const std::vector<VisualElement>& elements,
        double& min_x, double& max_x,
        double& min_y, double& max_y,
        double& val_min, double& val_max
    ) const;

    void write_svg_header(std::ostream& os) const;
    void write_svg_footer(std::ostream& os) const;
    void write_colorbar(
        std::ostream& os,
        double min_val, double max_val
    ) const;
};

} // namespace Blast::VV
