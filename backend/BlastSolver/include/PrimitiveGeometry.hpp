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

    add_face(p0, p3, p2, p1, {0.f, 0.f, -1.f}); // Bottom (corrected winding)
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
            triangles.push_back({b1, b2, t2, normal_side}); // Corrected winding
            triangles.push_back({b1, t2, t1, normal_side}); // Corrected winding

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
            triangles.push_back({b1, t1, t2, normal_side}); // Corrected winding
            triangles.push_back({b1, t2, b2, normal_side}); // Corrected winding

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
            triangles.push_back({b1, b2, t2, normal_side}); // Corrected winding
            triangles.push_back({b1, t2, t1, normal_side}); // Corrected winding

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

        triangles.push_back({v0, v4, v3, n_bottom});
        triangles.push_back({v0, v1, v4, n_bottom});

        triangles.push_back({v1, v2, v5, n_vertical});
        triangles.push_back({v1, v5, v4, n_vertical});

        triangles.push_back({v0, v3, v5, n_slope});
        triangles.push_back({v0, v5, v2, n_slope});

        triangles.push_back({v0, v2, v1, n_cap1});
        triangles.push_back({v3, v4, v5, n_cap2});
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

        triangles.push_back({v0, v1, v4, n_bottom});
        triangles.push_back({v0, v4, v3, n_bottom});

        triangles.push_back({v1, v2, v5, n_vertical});
        triangles.push_back({v1, v5, v4, n_vertical});

        triangles.push_back({v0, v3, v5, n_slope});
        triangles.push_back({v0, v5, v2, n_slope});

        triangles.push_back({v0, v2, v1, n_cap1});
        triangles.push_back({v3, v4, v5, n_cap2});
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

        triangles.push_back({v0, v4, v1, n_bottom});
        triangles.push_back({v0, v3, v4, n_bottom});

        triangles.push_back({v1, v5, v2, n_vertical});
        triangles.push_back({v1, v4, v5, n_vertical});

        triangles.push_back({v0, v5, v3, n_slope});
        triangles.push_back({v0, v2, v5, n_slope});

        triangles.push_back({v0, v1, v2, n_cap1});
        triangles.push_back({v3, v5, v4, n_cap2});
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

        triangles.push_back({v0, v4, v1, n_bottom});
        triangles.push_back({v0, v3, v4, n_bottom});

        triangles.push_back({v1, v5, v2, n_vertical});
        triangles.push_back({v1, v4, v5, n_vertical});

        triangles.push_back({v0, v5, v3, n_slope});
        triangles.push_back({v0, v2, v5, n_slope});

        triangles.push_back({v0, v1, v2, n_cap1});
        triangles.push_back({v3, v5, v4, n_cap2});
    }

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

inline Point3D rotate_point_euler(float u, float v, float w, float ax_deg, float ay_deg, float az_deg) {
    if (ax_deg == 0.0f && ay_deg == 0.0f && az_deg == 0.0f) {
        return { u, v, w };
    }
    constexpr float deg_to_rad = 3.14159265358979323846f / 180.0f;
    float ax = ax_deg * deg_to_rad;
    float ay = ay_deg * deg_to_rad;
    float az = az_deg * deg_to_rad;

    float cx = std::cos(ax), sx = std::sin(ax);
    float cy = std::cos(ay), sy = std::sin(ay);
    float cz = std::cos(az), sz = std::sin(az);

    // Step 1: Rotate by +ax around X
    float u1 = u;
    float v1 = cx * v - sx * w;
    float w1 = sx * v + cx * w;

    // Step 2: Rotate by +ay around Y
    float u2 = cy * u1 + sy * w1;
    float v2 = v1;
    float w2 = -sy * u1 + cy * w1;

    // Step 3: Rotate by +az around Z
    float u_rot = cz * u2 - sz * v2;
    float v_rot = sz * u2 + cz * v2;
    float w_rot = w2;

    return { u_rot, v_rot, w_rot };
}

inline std::vector<Triangle> transform_triangles(
    const std::vector<Triangle>& raw_triangles,
    float scale_x, float scale_y, float scale_z,
    float pos_x, float pos_y, float pos_z,
    float rot_x, float rot_y, float rot_z,
    const std::string& origin_mode)
{
    if (raw_triangles.empty()) return {};

    if (scale_x == 0.0f) scale_x = 1.0f;
    if (scale_y == 0.0f) scale_y = 1.0f;
    if (scale_z == 0.0f) scale_z = 1.0f;

    float anchor_x = 0.0f, anchor_y = 0.0f, anchor_z = 0.0f;
    if (origin_mode == "Center") {
        float raw_min_x = 1.0e30f, raw_max_x = -1.0e30f;
        float raw_min_y = 1.0e30f, raw_max_y = -1.0e30f;
        float raw_min_z = 1.0e30f, raw_max_z = -1.0e30f;
        for (const auto& tri : raw_triangles) {
            raw_min_x = std::min({raw_min_x, tri.v0.x, tri.v1.x, tri.v2.x});
            raw_max_x = std::max({raw_max_x, tri.v0.x, tri.v1.x, tri.v2.x});
            raw_min_y = std::min({raw_min_y, tri.v0.y, tri.v1.y, tri.v2.y});
            raw_max_y = std::max({raw_max_y, tri.v0.y, tri.v1.y, tri.v2.y});
            raw_min_z = std::min({raw_min_z, tri.v0.z, tri.v1.z, tri.v2.z});
            raw_max_z = std::max({raw_max_z, tri.v0.z, tri.v1.z, tri.v2.z});
        }
        anchor_x = 0.5f * (raw_min_x + raw_max_x);
        anchor_y = 0.5f * (raw_min_y + raw_max_y);
        anchor_z = 0.5f * (raw_min_z + raw_max_z);
    }

    std::vector<Triangle> result;
    result.reserve(raw_triangles.size());

    auto transform_pt = [&](const Point3D& pt) -> Point3D {
        float vx = (pt.x - anchor_x) * scale_x;
        float vy = (pt.y - anchor_y) * scale_y;
        float vz = (pt.z - anchor_z) * scale_z;
        Point3D r = rotate_point_euler(vx, vy, vz, rot_x, rot_y, rot_z);
        return { r.x + pos_x, r.y + pos_y, r.z + pos_z };
    };

    for (const auto& tri : raw_triangles) {
        Triangle t;
        t.v0 = transform_pt(tri.v0);
        t.v1 = transform_pt(tri.v1);
        t.v2 = transform_pt(tri.v2);

        Point3D e1 = { t.v1.x - t.v0.x, t.v1.y - t.v0.y, t.v1.z - t.v0.z };
        Point3D e2 = { t.v2.x - t.v0.x, t.v2.y - t.v0.y, t.v2.z - t.v0.z };
        Point3D n = {
            e1.y * e2.z - e1.z * e2.y,
            e1.z * e2.x - e1.x * e2.z,
            e1.x * e2.y - e1.y * e2.x
        };
        float len = std::sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
        if (len > 1.0e-12f) {
            t.normal = { n.x / len, n.y / len, n.z / len };
        } else {
            t.normal = tri.normal;
        }
        result.push_back(t);
    }
    return result;
}

#endif // PRIMITIVE_GEOMETRY_HPP
