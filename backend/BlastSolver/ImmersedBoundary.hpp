#ifndef IMMERSED_BOUNDARY_HPP
#define IMMERSED_BOUNDARY_HPP

#include <vector>
#include <string>
#include <sys/stat.h>
#include <cmath>
#include <algorithm>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <cstdint>
#include "cfd_tile.hpp"

#ifdef __CUDACC__
#define HD_FUNC __host__ __device__
#else
#define HD_FUNC
#endif

#include "PrimitiveGeometry.hpp"

#include <functional>
#include <atomic>

// Global cache
extern std::string global_geometry_hash;
extern std::vector<GeometryTile3D> global_geometry_tiles;
extern int global_geometry_nx;
extern int global_geometry_ny;
extern int global_geometry_nz;
extern double global_geometry_cellSize;
extern std::string global_geometry_stl_filepath;
extern long long global_geometry_stl_size;
extern long long global_geometry_stl_mtime;
extern double global_geometry_xmin;
extern double global_geometry_ymin;
extern double global_geometry_zmin;

inline void get_file_metadata(const std::string& path, long long& size, long long& mtime) {
    struct stat st;
    if (stat(path.c_str(), &st) == 0) {
        size = st.st_size;
        mtime = st.st_mtime;
    } else {
        size = 0;
        mtime = 0;
    }
}

std::vector<Triangle> read_stl(const std::string& filepath);

void voxelize_geometry(
    const std::vector<Triangle>& triangles,
    const std::string& geometry_hash,
    const std::string& voxelization_method,
    std::vector<GeometryTile3D>& geom_pool,
    int nx, int ny, int nz,
    double cellSize,
    double xmin, double ymin, double zmin,
    int n_tiles_x, int n_tiles_y, int n_tiles_z,
    const std::atomic<bool>* terminate_flag = nullptr,
    std::function<void(double)> progress_callback = nullptr
);

void voxelize_stl(
    const std::string& stl_filepath,
    const std::string& geometry_hash,
    const std::string& voxelization_method,
    std::vector<GeometryTile3D>& geom_pool,
    int nx, int ny, int nz,
    double cellSize,
    double xmin, double ymin, double zmin,
    int n_tiles_x, int n_tiles_y, int n_tiles_z,
    const std::atomic<bool>* terminate_flag = nullptr,
    std::function<void(double)> progress_callback = nullptr
);

void voxelize_primitives(
    const nlohmann::json& primitives_json,
    const std::string& geometry_hash,
    const std::string& voxelization_method,
    std::vector<GeometryTile3D>& geom_pool,
    int nx, int ny, int nz,
    double cellSize,
    double xmin, double ymin, double zmin,
    int n_tiles_x, int n_tiles_y, int n_tiles_z,
    const std::atomic<bool>* terminate_flag = nullptr,
    std::function<void(double)> progress_callback = nullptr
);

void voxelize_flat_boundary(
    const std::vector<Triangle>& triangles,
    const std::string& voxelization_method,
    std::vector<uint8_t>& is_boundary,
    int nx, int ny, int nz,
    double cellSize,
    double xmin, double ymin, double zmin
);



HD_FUNC inline GeometryPayload pack_geometry_payload(bool is_boundary, float nx, float ny, float nz) {
    if (!is_boundary) return {0, 0, 0, false};
    float len = sqrtf(nx*nx + ny*ny + nz*nz);
    if (len > 1e-6f) {
        nx /= len; ny /= len; nz /= len;
    } else {
        nx = 1.0f; ny = 0.0f; nz = 0.0f;
    }
    float n_x_scaled = nx * 127.0f;
    float n_y_scaled = ny * 127.0f;
    float n_z_scaled = nz * 127.0f;
    int8_t qx = static_cast<int8_t>(n_x_scaled > 127.0f ? 127.0f : (n_x_scaled < -127.0f ? -127.0f : n_x_scaled));
    int8_t qy = static_cast<int8_t>(n_y_scaled > 127.0f ? 127.0f : (n_y_scaled < -127.0f ? -127.0f : n_y_scaled));
    int8_t qz = static_cast<int8_t>(n_z_scaled > 127.0f ? 127.0f : (n_z_scaled < -127.0f ? -127.0f : n_z_scaled));
    return {qx, qy, qz, true};
}

HD_FUNC inline void unpack_geometry_payload(const GeometryPayload& payload, bool& is_boundary, float& nx, float& ny, float& nz) {
    is_boundary = payload.is_boundary;
    if (!is_boundary) {
        nx = 0.0f; ny = 0.0f; nz = 0.0f;
        return;
    }
    nx = static_cast<float>(payload.nx) / 127.0f;
    ny = static_cast<float>(payload.ny) / 127.0f;
    nz = static_cast<float>(payload.nz) / 127.0f;
}

HD_FUNC inline bool ray_triangle_intersect(
    const Point3D& O, const Point3D& D,
    const Point3D& V0, const Point3D& V1, const Point3D& V2,
    float& t
) {
    const float EPSILON = 1e-6f;
    Point3D edge1 = { V1.x - V0.x, V1.y - V0.y, V1.z - V0.z };
    Point3D edge2 = { V2.x - V0.x, V2.y - V0.y, V2.z - V0.z };
    Point3D h = { D.y * edge2.z - D.z * edge2.y,
                  D.z * edge2.x - D.x * edge2.z,
                  D.x * edge2.y - D.y * edge2.x };
    float a = edge1.x * h.x + edge1.y * h.y + edge1.z * h.z;
    if (a > -EPSILON && a < EPSILON) return false;
    
    float f = 1.0f / a;
    Point3D s = { O.x - V0.x, O.y - V0.y, O.z - V0.z };
    float u = f * (s.x * h.x + s.y * h.y + s.z * h.z);
    if (u < 0.0f || u > 1.0f) return false;
    
    Point3D q = { s.y * edge1.z - s.z * edge1.y,
                  s.z * edge1.x - s.x * edge1.z,
                  s.x * edge1.y - s.y * edge1.x };
    float v = f * (D.x * q.x + D.y * q.y + D.z * q.z);
    if (v < 0.0f || u + v > 1.0f) return false;
    
    t = f * (edge2.x * q.x + edge2.y * q.y + edge2.z * q.z);
    return true;
}

HD_FUNC inline bool tri_box_overlap(const Point3D& boxcenter, float boxhalfsize, const Triangle& tri) {
    float v0x = tri.v0.x - boxcenter.x;
    float v0y = tri.v0.y - boxcenter.y;
    float v0z = tri.v0.z - boxcenter.z;
    float v1x = tri.v1.x - boxcenter.x;
    float v1y = tri.v1.y - boxcenter.y;
    float v1z = tri.v1.z - boxcenter.z;
    float v2x = tri.v2.x - boxcenter.x;
    float v2y = tri.v2.y - boxcenter.y;
    float v2z = tri.v2.z - boxcenter.z;

    float e0x = v1x - v0x, e0y = v1y - v0y, e0z = v1z - v0z;
    float e1x = v2x - v1x, e1y = v2y - v1y, e1z = v2z - v1z;
    float e2x = v0x - v2x, e2y = v0y - v2y, e2z = v0z - v2z;

    float min_val, max_val;
    const float eps = 1e-5f * boxhalfsize;

#define TEST_CROSS_AXIS(p0, p1, p2, rad_val) \
    min_val = std::min({p0, p1, p2}); \
    max_val = std::max({p0, p1, p2}); \
    if (min_val > (rad_val) + eps || max_val < -(rad_val) - eps) return false;

    {
        float p0 = -v0y * e0z + v0z * e0y;
        float p2 = -v2y * e0z + v2z * e0y;
        float rad = boxhalfsize * (std::abs(e0z) + std::abs(e0y));
        TEST_CROSS_AXIS(p0, p0, p2, rad);
    }
    {
        float p0 = -v0y * e1z + v0z * e1y;
        float p2 = -v2y * e1z + v2z * e1y;
        float rad = boxhalfsize * (std::abs(e1z) + std::abs(e1y));
        TEST_CROSS_AXIS(p0, p2, p2, rad);
    }
    {
        float p0 = -v0y * e2z + v0z * e2y;
        float p1 = -v1y * e2z + v1z * e2y;
        float rad = boxhalfsize * (std::abs(e2z) + std::abs(e2y));
        TEST_CROSS_AXIS(p0, p1, p0, rad);
    }
    {
        float p0 = v0x * e0z - v0z * e0x;
        float p2 = v2x * e0z - v2z * e0x;
        float rad = boxhalfsize * (std::abs(e0z) + std::abs(e0x));
        TEST_CROSS_AXIS(p0, p0, p2, rad);
    }
    {
        float p0 = v0x * e1z - v0z * e1x;
        float p2 = v2x * e1z - v2z * e1x;
        float rad = boxhalfsize * (std::abs(e1z) + std::abs(e1x));
        TEST_CROSS_AXIS(p0, p2, p2, rad);
    }
    {
        float p0 = v0x * e2z - v0z * e2x;
        float p1 = v1x * e2z - v1z * e2x;
        float rad = boxhalfsize * (std::abs(e2z) + std::abs(e2x));
        TEST_CROSS_AXIS(p0, p1, p0, rad);
    }
    {
        float p0 = -v0x * e0y + v0y * e0x;
        float p2 = -v2x * e0y + v2y * e0x;
        float rad = boxhalfsize * (std::abs(e0y) + std::abs(e0x));
        TEST_CROSS_AXIS(p0, p0, p2, rad);
    }
    {
        float p0 = -v0x * e1y + v0y * e1x;
        float p2 = -v2x * e1y + v2y * e1x;
        float rad = boxhalfsize * (std::abs(e1y) + std::abs(e1x));
        TEST_CROSS_AXIS(p0, p2, p2, rad);
    }
    {
        float p0 = -v0x * e2y + v0y * e2x;
        float p1 = -v1x * e2y + v1y * e2x;
        float rad = boxhalfsize * (std::abs(e2y) + std::abs(e2x));
        TEST_CROSS_AXIS(p0, p1, p0, rad);
    }

    if (std::min({v0x, v1x, v2x}) > boxhalfsize + eps || std::max({v0x, v1x, v2x}) < -boxhalfsize - eps) return false;
    if (std::min({v0y, v1y, v2y}) > boxhalfsize + eps || std::max({v0y, v1y, v2y}) < -boxhalfsize - eps) return false;
    if (std::min({v0z, v1z, v2z}) > boxhalfsize + eps || std::max({v0z, v1z, v2z}) < -boxhalfsize - eps) return false;

    float nx = e0y * e1z - e0z * e1y;
    float ny = e0z * e1x - e0x * e1z;
    float nz = e0x * e1y - e0y * e1x;
    float d = -(nx * v0x + ny * v0y + nz * v0z);

    float vmin_x = (nx > 0.0f) ? -boxhalfsize : boxhalfsize;
    float vmax_x = (nx > 0.0f) ? boxhalfsize : -boxhalfsize;
    float vmin_y = (ny > 0.0f) ? -boxhalfsize : boxhalfsize;
    float vmax_y = (ny > 0.0f) ? boxhalfsize : -boxhalfsize;
    float vmin_z = (nz > 0.0f) ? -boxhalfsize : boxhalfsize;
    float vmax_z = (nz > 0.0f) ? boxhalfsize : -boxhalfsize;

    if (nx * vmin_x + ny * vmin_y + nz * vmin_z + d > eps) return false;
    if (nx * vmax_x + ny * vmax_y + nz * vmax_z + d < -eps) return false;

    return true;
}

#endif
