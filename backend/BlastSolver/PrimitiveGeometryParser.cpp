#include <nlohmann/json.hpp>
#include "PrimitiveGeometryParser.hpp"
#include <string>

std::vector<Triangle> generate_primitives_triangles(const nlohmann::json& primitives_json) {
    std::vector<Triangle> triangles;
    if (!primitives_json.is_array()) return triangles;
    for (const auto& item : primitives_json) {
        std::string type = item.value("type", "");
        if (type == "cuboid") {
            double xmin = item.value("xmin", 0.0);
            double xmax = item.value("xmax", 1.0);
            double ymin = item.value("ymin", 0.0);
            double ymax = item.value("ymax", 1.0);
            double zmin = item.value("zmin", 0.0);
            double zmax = item.value("zmax", 1.0);
            auto prim_tris = generate_cuboid_triangles(xmin, xmax, ymin, ymax, zmin, zmax);
            triangles.insert(triangles.end(), prim_tris.begin(), prim_tris.end());
        } else if (type == "cylinder") {
            double x = item.value("x", 0.0);
            double y = item.value("y", 0.0);
            double z = item.value("z", 0.0);
            double radius = item.value("radius", 0.1);
            double length = item.value("length", 0.2);
            std::string orientation = item.value("orientation", "Z");
            auto prim_tris = generate_cylinder_triangles(x, y, z, radius, length, orientation);
            triangles.insert(triangles.end(), prim_tris.begin(), prim_tris.end());
        } else if (type == "wedge") {
            double xmin = item.value("xmin", 0.0);
            double xmax = item.value("xmax", 1.0);
            double ymin = item.value("ymin", 0.0);
            double ymax = item.value("ymax", 1.0);
            double zmin = item.value("zmin", 0.0);
            double zmax = item.value("zmax", 1.0);
            std::string orientation = item.value("orientation", "+X");
            auto prim_tris = generate_wedge_triangles(xmin, xmax, ymin, ymax, zmin, zmax, orientation);
            triangles.insert(triangles.end(), prim_tris.begin(), prim_tris.end());
        }
    }
    return triangles;
}
