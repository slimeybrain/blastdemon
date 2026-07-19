#ifndef PRIMITIVE_GEOMETRY_HPP
#define PRIMITIVE_GEOMETRY_HPP

#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <nlohmann/json.hpp>

struct Point3D {
    float x, y, z;
};

struct Triangle {
    Point3D v0, v1, v2;
    Point3D normal;
};

inline std::vector<Triangle> generate_cuboid_triangles(double xmin, double xmax, double ymin, double ymax, double zmin, double zmax) {
    std::vector<Triangle> triangles;
    Point3D p0 = {(float)xmin, (float)ymin, (float)zmin};
    Point3D p1 = {(float)xmax, (float)ymin, (float)zmin};
    Point3D p2 = {(float)xmax, (float)ymax, (float)zmin};
    Point3D p3 = {(float)xmin, (float)ymax, (float)zmin};
    Point3D p4 = {(float)xmin, (float)ymin, (float)zmax};
    Point3D p5 = {(float)xmax, (float)ymin, (float)zmax};
    Point3D p6 = {(float)xmax, (float)ymax, (float)zmax};
    Point3D p7 = {(float)xmin, (float)ymax, (float)zmax};

    auto add_face = [&](Point3D v0, Point3D v1, Point3D v2, Point3D v3, Point3D normal) {
        triangles.push_back({v0, v1, v2, normal});
        triangles.push_back({v0, v2, v3, normal});
    };

    add_face(p0, p1, p2, p3, {0.f, 0.f, -1.f}); // Bottom
    add_face(p4, p5, p6, p7, {0.f, 0.f, 1.f});  // Top
    add_face(p0, p1, p5, p4, {0.f, -1.f, 0.f}); // Front
    add_face(p2, p3, p7, p6, {0.f, 1.f, 0.f});  // Back
    add_face(p3, p0, p4, p7, {-1.f, 0.f, 0.f}); // Left
    add_face(p1, p2, p6, p5, {1.f, 0.f, 0.f});  // Right

    return triangles;
}

inline std::vector<Triangle> generate_cylinder_triangles(double x_c, double y_c, double z_c, double radius, double length, const std::string& orientation) {
    std::vector<Triangle> triangles;
    const int N = 32;
    const double PI = 3.141592653589793;

    if (orientation == "X" || orientation == "x") {
        float x_min = (float)(x_c - length/2.0);
        float x_max = (float)(x_c + length/2.0);
        for (int i = 0; i < N; ++i) {
            double theta1 = 2.0 * PI * i / N;
            double theta2 = 2.0 * PI * (i + 1) / N;
            float y1 = (float)(y_c + radius * cos(theta1));
            float z1 = (float)(z_c + radius * sin(theta1));
            float y2 = (float)(y_c + radius * cos(theta2));
            float z2 = (float)(z_c + radius * sin(theta2));

            Point3D b1 = {x_min, y1, z1};
            Point3D b2 = {x_min, y2, z2};
            Point3D t1 = {x_max, y1, z1};
            Point3D t2 = {x_max, y2, z2};

            float ny = (float)cos((theta1 + theta2)/2.0);
            float nz = (float)sin((theta1 + theta2)/2.0);
            Point3D normal_side = {0.0f, ny, nz};
            triangles.push_back({b1, t1, t2, normal_side});
            triangles.push_back({b1, t2, b2, normal_side});

            Point3D bc = {x_min, (float)y_c, (float)z_c};
            triangles.push_back({bc, b2, b1, {-1.f, 0.f, 0.f}});

            Point3D tc = {x_max, (float)y_c, (float)z_c};
            triangles.push_back({tc, t1, t2, {1.f, 0.f, 0.f}});
        }
    } else if (orientation == "Y" || orientation == "y") {
        float y_min = (float)(y_c - length/2.0);
        float y_max = (float)(y_c + length/2.0);
        for (int i = 0; i < N; ++i) {
            double theta1 = 2.0 * PI * i / N;
            double theta2 = 2.0 * PI * (i + 1) / N;
            float x1 = (float)(x_c + radius * cos(theta1));
            float z1 = (float)(z_c + radius * sin(theta1));
            float x2 = (float)(x_c + radius * cos(theta2));
            float z2 = (float)(z_c + radius * sin(theta2));

            Point3D b1 = {x1, y_min, z1};
            Point3D b2 = {x2, y_min, z2};
            Point3D t1 = {x1, y_max, z1};
            Point3D t2 = {x2, y_max, z2};

            float nx = (float)cos((theta1 + theta2)/2.0);
            float nz = (float)sin((theta1 + theta2)/2.0);
            Point3D normal_side = {nx, 0.0f, nz};
            triangles.push_back({b1, t2, t1, normal_side});
            triangles.push_back({b1, b2, t2, normal_side});

            Point3D bc = {(float)x_c, y_min, (float)z_c};
            triangles.push_back({bc, b1, b2, {0.f, -1.f, 0.f}});

            Point3D tc = {(float)x_c, y_max, (float)z_c};
            triangles.push_back({tc, t2, t1, {0.f, 1.f, 0.f}});
        }
    } else { // Z
        float z_min = (float)(z_c - length/2.0);
        float z_max = (float)(z_c + length/2.0);
        for (int i = 0; i < N; ++i) {
            double theta1 = 2.0 * PI * i / N;
            double theta2 = 2.0 * PI * (i + 1) / N;
            float x1 = (float)(x_c + radius * cos(theta1));
            float y1 = (float)(y_c + radius * sin(theta1));
            float x2 = (float)(x_c + radius * cos(theta2));
            float y2 = (float)(y_c + radius * sin(theta2));

            Point3D b1 = {x1, y1, z_min};
            Point3D b2 = {x2, y2, z_min};
            Point3D t1 = {x1, y1, z_max};
            Point3D t2 = {x2, y2, z_max};

            float nx = (float)cos((theta1 + theta2)/2.0);
            float ny = (float)sin((theta1 + theta2)/2.0);
            Point3D normal_side = {nx, ny, 0.0f};
            triangles.push_back({b1, t1, t2, normal_side});
            triangles.push_back({b1, t2, b2, normal_side});

            Point3D bc = {(float)x_c, (float)y_c, z_min};
            triangles.push_back({bc, b2, b1, {0.f, 0.f, -1.f}});

            Point3D tc = {(float)x_c, (float)y_c, z_max};
            triangles.push_back({tc, t1, t2, {0.f, 0.f, 1.f}});
        }
    }
    return triangles;
}

inline std::vector<Triangle> generate_wedge_triangles(double xmin, double xmax, double ymin, double ymax, double zmin, double zmax, const std::string& orientation) {
    std::vector<Triangle> triangles;
    float x1 = (float)xmin, x2 = (float)xmax;
    float y1 = (float)ymin, y2 = (float)ymax;
    float z1 = (float)zmin, z2 = (float)zmax;

    Point3D v0, v1, v2, v3, v4, v5;
    Point3D n_bottom, n_vertical, n_slope, n_cap1, n_cap2;

    if (orientation == "+Y" || orientation == "+y") {
        v0 = {x1, y1, z1}; v1 = {x1, y2, z1}; v2 = {x1, y2, z2};
        v3 = {x2, y1, z1}; v4 = {x2, y2, z1}; v5 = {x2, y2, z2};
        
        n_bottom = {0.f, 0.f, -1.f};
        n_vertical = {0.f, 1.f, 0.f};
        n_cap1 = {-1.f, 0.f, 0.f};
        n_cap2 = {1.f, 0.f, 0.f};
        
        float dy = y2 - y1;
        float dz = z2 - z1;
        float len = sqrt(dy*dy + dz*dz);
        n_slope = {0.f, -dz/len, dy/len};
    } else if (orientation == "-X" || orientation == "-x") {
        v0 = {x2, y1, z1}; v1 = {x1, y1, z1}; v2 = {x1, y1, z2};
        v3 = {x2, y2, z1}; v4 = {x1, y2, z1}; v5 = {x1, y2, z2};
        
        n_bottom = {0.f, 0.f, -1.f};
        n_vertical = {-1.f, 0.f, 0.f};
        n_cap1 = {0.f, -1.f, 0.f};
        n_cap2 = {0.f, 1.f, 0.f};
        
        float dx = x2 - x1;
        float dz = z2 - z1;
        float len = sqrt(dx*dx + dz*dz);
        n_slope = {dz/len, 0.f, dx/len};
    } else if (orientation == "-Y" || orientation == "-y") {
        v0 = {x1, y2, z1}; v1 = {x1, y1, z1}; v2 = {x1, y1, z2};
        v3 = {x2, y2, z1}; v4 = {x2, y1, z1}; v5 = {x2, y1, z2};
        
        n_bottom = {0.f, 0.f, -1.f};
        n_vertical = {0.f, -1.f, 0.f};
        n_cap1 = {-1.f, 0.f, 0.f};
        n_cap2 = {1.f, 0.f, 0.f};
        
        float dy = y2 - y1;
        float dz = z2 - z1;
        float len = sqrt(dy*dy + dz*dz);
        n_slope = {0.f, dz/len, dy/len};
    } else { // "+X" and fallback
        v0 = {x1, y1, z1}; v1 = {x2, y1, z1}; v2 = {x2, y1, z2};
        v3 = {x1, y2, z1}; v4 = {x2, y2, z1}; v5 = {x2, y2, z2};
        
        n_bottom = {0.f, 0.f, -1.f};
        n_vertical = {1.f, 0.f, 0.f};
        n_cap1 = {0.f, -1.f, 0.f};
        n_cap2 = {0.f, 1.f, 0.f};
        
        float dx = x2 - x1;
        float dz = z2 - z1;
        float len = sqrt(dx*dx + dz*dz);
        n_slope = {-dz/len, 0.f, dx/len};
    }

    triangles.push_back({v0, v4, v1, n_bottom});
    triangles.push_back({v0, v3, v4, n_bottom});

    triangles.push_back({v1, v5, v2, n_vertical});
    triangles.push_back({v1, v4, v5, n_vertical});

    triangles.push_back({v0, v2, v5, n_slope});
    triangles.push_back({v0, v5, v3, n_slope});

    triangles.push_back({v0, v1, v2, n_cap1});
    triangles.push_back({v3, v5, v4, n_cap2});

    return triangles;
}

inline std::vector<Triangle> generate_primitives_triangles(const nlohmann::json& primitives_json) {
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

#endif // PRIMITIVE_GEOMETRY_HPP
