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

struct Point3D {
    float x, y, z;
};

struct Triangle {
    Point3D v0, v1, v2;
    Point3D normal;
};

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
#ifdef _WIN32
    // Windows stat implementation if needed, but since we are on Linux:
#endif
    struct stat st;
    if (stat(path.c_str(), &st) == 0) {
        size = st.st_size;
        mtime = st.st_mtime;
    } else {
        size = 0;
        mtime = 0;
    }
}

#include <functional>
#include <atomic>

std::vector<Triangle> read_stl(const std::string& filepath);

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

#endif
