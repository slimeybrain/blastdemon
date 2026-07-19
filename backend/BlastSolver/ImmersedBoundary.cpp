#include "ImmersedBoundary.hpp"
#ifdef _OPENMP
#include <omp.h>
#endif

std::string global_geometry_hash = "";
std::vector<GeometryTile3D> global_geometry_tiles;
int global_geometry_nx = 0;
int global_geometry_ny = 0;
int global_geometry_nz = 0;
double global_geometry_cellSize = 0.0;
std::string global_geometry_stl_filepath = "";
long long global_geometry_stl_size = 0;
long long global_geometry_stl_mtime = 0;
double global_geometry_xmin = 0.0;
double global_geometry_ymin = 0.0;
double global_geometry_zmin = 0.0;

static std::vector<Triangle> read_binary_stl_data(std::ifstream& file, uint32_t num_triangles) {
    std::vector<Triangle> triangles;
    triangles.reserve(num_triangles);
    for (uint32_t i = 0; i < num_triangles; ++i) {
        float data[12];
        file.read(reinterpret_cast<char*>(data), 48);
        uint16_t attr;
        file.read(reinterpret_cast<char*>(&attr), 2);
        
        Triangle t;
        t.normal = {data[0], data[1], data[2]};
        t.v0 = {data[3], data[4], data[5]};
        t.v1 = {data[6], data[7], data[8]};
        t.v2 = {data[9], data[10], data[11]};
        triangles.push_back(t);
    }
    return triangles;
}

static std::vector<Triangle> read_ascii_stl(std::ifstream& file) {
    std::vector<Triangle> triangles;
    std::string word;
    Triangle t;
    int vertex_idx = 0;
    while (file >> word) {
        if (word == "facet") {
            file >> word; // should be "normal"
            file >> t.normal.x >> t.normal.y >> t.normal.z;
            vertex_idx = 0;
        } else if (word == "vertex") {
            if (vertex_idx == 0) {
                file >> t.v0.x >> t.v0.y >> t.v0.z;
                vertex_idx++;
            } else if (vertex_idx == 1) {
                file >> t.v1.x >> t.v1.y >> t.v1.z;
                vertex_idx++;
            } else if (vertex_idx == 2) {
                file >> t.v2.x >> t.v2.y >> t.v2.z;
                vertex_idx++;
            }
        } else if (word == "endfacet") {
            triangles.push_back(t);
        }
    }
    return triangles;
}

std::vector<Triangle> read_stl(const std::string& filepath) {
    std::ifstream file(filepath, std::ios::binary);
    if (!file.is_open()) {
        throw std::runtime_error("Failed to open STL file: " + filepath);
    }

    file.seekg(0, std::ios::end);
    size_t file_size = file.tellg();
    file.seekg(0, std::ios::beg);

    if (file_size < 84) {
        return read_ascii_stl(file);
    }

    char header[80];
    file.read(header, 80);
    
    uint32_t num_triangles = 0;
    file.read(reinterpret_cast<char*>(&num_triangles), 4);

    size_t expected_binary_size = 84 + static_cast<size_t>(num_triangles) * 50;
    bool is_binary = (file_size == expected_binary_size);
    
    std::string header_str(header, 5);
    if (header_str == "solid" && !is_binary) {
        file.seekg(0, std::ios::beg);
        return read_ascii_stl(file);
    }

    if (is_binary) {
        return read_binary_stl_data(file, num_triangles);
    } else {
        file.seekg(0, std::ios::beg);
        return read_ascii_stl(file);
    }
}

#include <unordered_map>
#include <algorithm>

inline bool tri_box_overlap(const Point3D& boxcenter, float boxhalfsize, const Triangle& tri) {
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

#define TEST_CROSS_AXIS(p0, p1, p2, rad_val) \
    min_val = std::min({p0, p1, p2}); \
    max_val = std::max({p0, p1, p2}); \
    if (min_val > rad_val || max_val < -rad_val) return false;

    // Axis a00: (0, -e0z, e0y)
    {
        float p0 = -v0y * e0z + v0z * e0y;
        float p2 = -v2y * e0z + v2z * e0y;
        float rad = boxhalfsize * (std::abs(e0z) + std::abs(e0y));
        TEST_CROSS_AXIS(p0, p0, p2, rad);
    }
    // Axis a01: (0, -e1z, e1y)
    {
        float p0 = -v0y * e1z + v0z * e1y;
        float p2 = -v2y * e1z + v2z * e1y;
        float rad = boxhalfsize * (std::abs(e1z) + std::abs(e1y));
        TEST_CROSS_AXIS(p0, p2, p2, rad);
    }
    // Axis a02: (0, -e2z, e2y)
    {
        float p0 = -v0y * e2z + v0z * e2y;
        float p1 = -v1y * e2z + v1z * e2y;
        float rad = boxhalfsize * (std::abs(e2z) + std::abs(e2y));
        TEST_CROSS_AXIS(p0, p1, p0, rad);
    }

    // Axis a10: (e0z, 0, -e0x)
    {
        float p0 = v0x * e0z - v0z * e0x;
        float p2 = v2x * e0z - v2z * e0x;
        float rad = boxhalfsize * (std::abs(e0z) + std::abs(e0x));
        TEST_CROSS_AXIS(p0, p0, p2, rad);
    }
    // Axis a11: (e1z, 0, -e1x)
    {
        float p0 = v0x * e1z - v0z * e1x;
        float p2 = v2x * e1z - v2z * e1x;
        float rad = boxhalfsize * (std::abs(e1z) + std::abs(e1x));
        TEST_CROSS_AXIS(p0, p2, p2, rad);
    }
    // Axis a12: (e2z, 0, -e2x)
    {
        float p0 = v0x * e2z - v0z * e2x;
        float p1 = v1x * e2z - v1z * e2x;
        float rad = boxhalfsize * (std::abs(e2z) + std::abs(e2x));
        TEST_CROSS_AXIS(p0, p1, p0, rad);
    }

    // Axis a20: (-e0y, e0x, 0)
    {
        float p0 = -v0x * e0y + v0y * e0x;
        float p2 = -v2x * e0y + v2y * e0x;
        float rad = boxhalfsize * (std::abs(e0y) + std::abs(e0x));
        TEST_CROSS_AXIS(p0, p0, p2, rad);
    }
    // Axis a21: (-e1y, e1x, 0)
    {
        float p0 = -v0x * e1y + v0y * e1x;
        float p2 = -v2x * e1y + v2y * e1x;
        float rad = boxhalfsize * (std::abs(e1y) + std::abs(e1x));
        TEST_CROSS_AXIS(p0, p2, p2, rad);
    }
    // Axis a22: (-e2y, e2x, 0)
    {
        float p0 = -v0x * e2y + v0y * e2x;
        float p1 = -v1x * e2y + v1y * e2x;
        float rad = boxhalfsize * (std::abs(e2y) + std::abs(e2x));
        TEST_CROSS_AXIS(p0, p1, p0, rad);
    }

    if (std::min({v0x, v1x, v2x}) > boxhalfsize || std::max({v0x, v1x, v2x}) < -boxhalfsize) return false;
    if (std::min({v0y, v1y, v2y}) > boxhalfsize || std::max({v0y, v1y, v2y}) < -boxhalfsize) return false;
    if (std::min({v0z, v1z, v2z}) > boxhalfsize || std::max({v0z, v1z, v2z}) < -boxhalfsize) return false;

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

    if (nx * vmin_x + ny * vmin_y + nz * vmin_z + d > 0.0f) return false;
    if (nx * vmax_x + ny * vmax_y + nz * vmax_z + d < 0.0f) return false;

    return true;
}

inline float signed_solid_angle(const Point3D& p, const Point3D& v0, const Point3D& v1, const Point3D& v2) {
    float ax = v0.x - p.x, ay = v0.y - p.y, az = v0.z - p.z;
    float bx = v1.x - p.x, by = v1.y - p.y, bz = v1.z - p.z;
    float cx = v2.x - p.x, cy = v2.y - p.y, cz = v2.z - p.z;

    float al = std::sqrt(ax*ax + ay*ay + az*az);
    float bl = std::sqrt(bx*bx + by*by + bz*bz);
    float cl = std::sqrt(cx*cx + cy*cy + cz*cz);

    if (al < 1e-9f || bl < 1e-9f || cl < 1e-9f) return 0.0f;

    float det = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    float dotAB = ax*bx + ay*by + az*bz;
    float dotBC = bx*cx + by*cy + bz*cz;
    float dotCA = cx*ax + cy*ay + cz*az;

    float denom = al * bl * cl + dotAB * cl + dotBC * al + dotCA * bl;
    return 2.0f * std::atan2(det, denom);
}

void voxelize_geometry(
    const std::vector<Triangle>& triangles,
    const std::string& geometry_hash,
    const std::string& voxelization_method,
    std::vector<GeometryTile3D>& geom_pool,
    int nx, int ny, int nz,
    double cellSize,
    double xmin, double ymin, double zmin,
    int n_tiles_x, int n_tiles_y, int n_tiles_z,
    const std::atomic<bool>* terminate_flag,
    std::function<void(double)> progress_callback
) {
    if (progress_callback) progress_callback(0.01);

    if (geometry_hash == global_geometry_hash &&
        !global_geometry_tiles.empty() &&
        global_geometry_tiles.size() == (size_t)geom_pool.size() &&
        global_geometry_nx == nx &&
        global_geometry_ny == ny &&
        global_geometry_nz == nz &&
        std::abs(global_geometry_cellSize - cellSize) < 1e-9 &&
        std::abs(global_geometry_xmin - xmin) < 1e-9 &&
        std::abs(global_geometry_ymin - ymin) < 1e-9 &&
        std::abs(global_geometry_zmin - zmin) < 1e-9) {
        #pragma omp parallel for
        for (int t = 0; t < (int)geom_pool.size(); ++t) {
            geom_pool[t] = global_geometry_tiles[t];
        }
        std::cout << "[INFO] Loaded 3D geometry from cache (hash: " << geometry_hash << ")" << std::endl;
        return;
    }

    if (triangles.empty()) {
        int total_tiles = n_tiles_x * n_tiles_y * n_tiles_z;
        #pragma omp parallel for
        for (int t = 0; t < total_tiles; ++t) {
            std::fill(geom_pool[t].cells, geom_pool[t].cells + TILE_CELLS_3D, GeometryPayload{0, 0, 0, false});
        }
        return;
    }

    if (terminate_flag && terminate_flag->load()) return;
    if (progress_callback) progress_callback(0.1);

    std::cout << "[INFO] Voxelizing 3D geometry (" << triangles.size() << " triangles) using method: " << voxelization_method << std::endl;

    int total_tiles = n_tiles_x * n_tiles_y * n_tiles_z;
    #pragma omp parallel for
    for (int t = 0; t < total_tiles; ++t) {
        std::fill(geom_pool[t].cells, geom_pool[t].cells + TILE_CELLS_3D, GeometryPayload{0, 0, 0, false});
    }

    float box_half = 0.5f * (float)cellSize;

    // Normal accumulator and boundary flag vectors
    std::vector<Point3D> accumulated_normals(total_tiles * TILE_CELLS_3D, Point3D{0.0f, 0.0f, 0.0f});
    std::vector<uint8_t> has_boundary(total_tiles * TILE_CELLS_3D, 0);

    for (int i = 0; i < (int)triangles.size(); ++i) {
        if (terminate_flag && terminate_flag->load()) return;
        if (progress_callback && (i % 2000 == 0 || i == (int)triangles.size() - 1)) {
            progress_callback(0.1 + 0.3 * (double)i / std::max(1, (int)triangles.size() - 1));
        }
        const auto& tri = triangles[i];
        
        float min_x = std::min({tri.v0.x, tri.v1.x, tri.v2.x});
        float max_x = std::max({tri.v0.x, tri.v1.x, tri.v2.x});
        float min_y = std::min({tri.v0.y, tri.v1.y, tri.v2.y});
        float max_y = std::max({tri.v0.y, tri.v1.y, tri.v2.y});
        float min_z = std::min({tri.v0.z, tri.v1.z, tri.v2.z});
        float max_z = std::max({tri.v0.z, tri.v1.z, tri.v2.z});

        int gx_min = std::clamp(static_cast<int>((min_x - cellSize - xmin) / cellSize), 0, nx - 1);
        int gx_max = std::clamp(static_cast<int>((max_x + cellSize - xmin) / cellSize), 0, nx - 1);
        int gy_min = std::clamp(static_cast<int>((min_y - cellSize - ymin) / cellSize), 0, ny - 1);
        int gy_max = std::clamp(static_cast<int>((max_y + cellSize - ymin) / cellSize), 0, ny - 1);
        int gz_min = std::clamp(static_cast<int>((min_z - cellSize - zmin) / cellSize), 0, nz - 1);
        int gz_max = std::clamp(static_cast<int>((max_z + cellSize - zmin) / cellSize), 0, nz - 1);

        Point3D N_accum = tri.normal;
        float nlen_accum = std::sqrt(N_accum.x*N_accum.x + N_accum.y*N_accum.y + N_accum.z*N_accum.z);
        if (nlen_accum <= 1e-6f) {
            float ex1 = tri.v1.x - tri.v0.x, ey1 = tri.v1.y - tri.v0.y, ez1 = tri.v1.z - tri.v0.z;
            float ex2 = tri.v2.x - tri.v0.x, ey2 = tri.v2.y - tri.v0.y, ez2 = tri.v2.z - tri.v0.z;
            N_accum.x = ey1 * ez2 - ez1 * ey2;
            N_accum.y = ez1 * ex2 - ex1 * ez2;
            N_accum.z = ex1 * ey2 - ey1 * ex2;
        }

        Point3D N_unit = N_accum;
        float nlen2 = std::sqrt(N_unit.x*N_unit.x + N_unit.y*N_unit.y + N_unit.z*N_unit.z);
        if (nlen2 > 1e-6f) {
            N_unit.x /= nlen2; N_unit.y /= nlen2; N_unit.z /= nlen2;
        } else {
            N_unit = {1.0f, 0.0f, 0.0f};
        }

        std::vector<int> updated_cells;
        updated_cells.reserve(32);

        auto add_cell_boundary = [&](int gx, int gy, int gz) {
            if (gx < 0 || gx >= nx || gy < 0 || gy >= ny || gz < 0 || gz >= nz) return;
            int tx = gx / TILE_SIZE_3D;
            int ty = gy / TILE_SIZE_3D;
            int tz = gz / TILE_SIZE_3D;
            int t_idx = tx + ty * n_tiles_x + tz * n_tiles_x * n_tiles_y;
            int cx = gx % TILE_SIZE_3D;
            int cy = gy % TILE_SIZE_3D;
            int cz = gz % TILE_SIZE_3D;
            int idx = cx + cy * TILE_SIZE_3D + cz * TILE_SIZE_3D * TILE_SIZE_3D;
            int linear_idx = t_idx * TILE_CELLS_3D + idx;
            
            if (std::find(updated_cells.begin(), updated_cells.end(), linear_idx) == updated_cells.end()) {
                accumulated_normals[linear_idx].x += N_accum.x;
                accumulated_normals[linear_idx].y += N_accum.y;
                accumulated_normals[linear_idx].z += N_accum.z;
                has_boundary[linear_idx] = 1;
                updated_cells.push_back(linear_idx);
            }
        };

        // 1. Mark cells containing the three vertices (stl nodes) of the triangle
        int gv0_x = static_cast<int>(std::floor((tri.v0.x - xmin) / cellSize));
        int gv0_y = static_cast<int>(std::floor((tri.v0.y - ymin) / cellSize));
        int gv0_z = static_cast<int>(std::floor((tri.v0.z - zmin) / cellSize));
        add_cell_boundary(gv0_x, gv0_y, gv0_z);

        int gv1_x = static_cast<int>(std::floor((tri.v1.x - xmin) / cellSize));
        int gv1_y = static_cast<int>(std::floor((tri.v1.y - ymin) / cellSize));
        int gv1_z = static_cast<int>(std::floor((tri.v1.z - zmin) / cellSize));
        add_cell_boundary(gv1_x, gv1_y, gv1_z);

        int gv2_x = static_cast<int>(std::floor((tri.v2.x - xmin) / cellSize));
        int gv2_y = static_cast<int>(std::floor((tri.v2.y - ymin) / cellSize));
        int gv2_z = static_cast<int>(std::floor((tri.v2.z - zmin) / cellSize));
        add_cell_boundary(gv2_x, gv2_y, gv2_z);

        // 2. Mark cells overlapping with the triangle
        for (int gz = gz_min; gz <= gz_max; ++gz) {
            float z_c = (float)(zmin + (gz + 0.5) * cellSize);
            for (int gy = gy_min; gy <= gy_max; ++gy) {
                float y_c = (float)(ymin + (gy + 0.5) * cellSize);
                for (int gx = gx_min; gx <= gx_max; ++gx) {
                    float x_c = (float)(xmin + (gx + 0.5) * cellSize);
                    Point3D P = {x_c, y_c, z_c};
                    if (tri_box_overlap(P, box_half, tri)) {
                        add_cell_boundary(gx, gy, gz);
                    }
                }
            }
        }
    }

    std::vector<uint8_t> is_inside(total_tiles * TILE_CELLS_3D, 0);

    if (voxelization_method == "watertight_floodfill") {
        std::cout << "[INFO] Performing 6-connectivity boundary flood fill..." << std::endl;
        std::vector<uint8_t> visited(nx * ny * nz, 0);
        std::vector<int> queue;
        queue.reserve(nx * ny * 6);

        auto get_linear_idx = [&](int gx, int gy, int gz) {
            int tx = gx / TILE_SIZE_3D;
            int ty = gy / TILE_SIZE_3D;
            int tz = gz / TILE_SIZE_3D;
            int t_idx = tx + ty * n_tiles_x + tz * n_tiles_x * n_tiles_y;
            int cx = gx % TILE_SIZE_3D;
            int cy = gy % TILE_SIZE_3D;
            int cz = gz % TILE_SIZE_3D;
            return t_idx * TILE_CELLS_3D + (cx + cy * TILE_SIZE_3D + cz * TILE_SIZE_3D * TILE_SIZE_3D);
        };

        // Seed domain boundary cells
        for (int gz = 0; gz < nz; ++gz) {
            for (int gy = 0; gy < ny; ++gy) {
                for (int gx : {0, nx - 1}) {
                    int idx = gx + gy * nx + gz * nx * ny;
                    int l_idx = get_linear_idx(gx, gy, gz);
                    if (!has_boundary[l_idx]) {
                        visited[idx] = 1;
                        queue.push_back(idx);
                    }
                }
            }
        }
        for (int gz = 0; gz < nz; ++gz) {
            for (int gx = 0; gx < nx; ++gx) {
                for (int gy : {0, ny - 1}) {
                    int idx = gx + gy * nx + gz * nx * ny;
                    if (!visited[idx]) {
                        int l_idx = get_linear_idx(gx, gy, gz);
                        if (!has_boundary[l_idx]) {
                            visited[idx] = 1;
                            queue.push_back(idx);
                        }
                    }
                }
            }
        }
        for (int gy = 0; gy < ny; ++gy) {
            for (int gx = 0; gx < nx; ++gx) {
                for (int gz : {0, nz - 1}) {
                    int idx = gx + gy * nx + gz * nx * ny;
                    if (!visited[idx]) {
                        int l_idx = get_linear_idx(gx, gy, gz);
                        if (!has_boundary[l_idx]) {
                            visited[idx] = 1;
                            queue.push_back(idx);
                        }
                    }
                }
            }
        }

        // BFS traversal
        size_t head = 0;
        while (head < queue.size()) {
            if (terminate_flag && terminate_flag->load()) return;
            if (progress_callback && (head % 10000 == 0 || head == queue.size() - 1)) {
                progress_callback(0.4 + 0.3 * (double)head / std::max(1, (int)queue.size() - 1));
            }
            int curr = queue[head++];
            int gz = curr / (nx * ny);
            int rem = curr % (nx * ny);
            int gy = rem / nx;
            int gx = rem % nx;

            const int dx[] = {1, -1, 0, 0, 0, 0};
            const int dy[] = {0, 0, 1, -1, 0, 0};
            const int dz[] = {0, 0, 0, 0, 1, -1};

            for (int d = 0; d < 6; ++d) {
                int nx_val = gx + dx[d];
                int ny_val = gy + dy[d];
                int nz_val = gz + dz[d];

                if (nx_val >= 0 && nx_val < nx && ny_val >= 0 && ny_val < ny && nz_val >= 0 && nz_val < nz) {
                    int n_idx = nx_val + ny_val * nx + nz_val * nx * ny;
                    if (!visited[n_idx]) {
                        int l_idx = get_linear_idx(nx_val, ny_val, nz_val);
                        if (!has_boundary[l_idx]) {
                            visited[n_idx] = 1;
                            queue.push_back(n_idx);
                        }
                    }
                }
            }
        }

        #pragma omp parallel for collapse(3)
        for (int gz = 0; gz < nz; ++gz) {
            for (int gy = 0; gy < ny; ++gy) {
                for (int gx = 0; gx < nx; ++gx) {
                    if (terminate_flag && terminate_flag->load()) continue;
                    int idx = gx + gy * nx + gz * nx * ny;
                    if (!visited[idx]) {
                        int l_idx = get_linear_idx(gx, gy, gz);
                        if (!has_boundary[l_idx]) {
                            is_inside[l_idx] = 1;
                        }
                    }
                }
            }
        }
    } else if (voxelization_method == "watertight_raycast") {
        std::cout << "[INFO] Binning triangles into Y-Z grid..." << std::endl;
        std::vector<std::vector<int>> grid_triangles(ny * nz);
        for (int i = 0; i < (int)triangles.size(); ++i) {
            const auto& tri = triangles[i];
            float min_y = std::min({tri.v0.y, tri.v1.y, tri.v2.y});
            float max_y = std::max({tri.v0.y, tri.v1.y, tri.v2.y});
            float min_z = std::min({tri.v0.z, tri.v1.z, tri.v2.z});
            float max_z = std::max({tri.v0.z, tri.v1.z, tri.v2.z});

            int gy_min = std::clamp(static_cast<int>(std::floor((min_y - ymin) / cellSize)), 0, ny - 1);
            int gy_max = std::clamp(static_cast<int>(std::floor((max_y - ymin) / cellSize)), 0, ny - 1);
            int gz_min = std::clamp(static_cast<int>(std::floor((min_z - zmin) / cellSize)), 0, nz - 1);
            int gz_max = std::clamp(static_cast<int>(std::floor((max_z - zmin) / cellSize)), 0, nz - 1);

            for (int gz = gz_min; gz <= gz_max; ++gz) {
                for (int gy = gy_min; gy <= gy_max; ++gy) {
                    grid_triangles[gy + gz * ny].push_back(i);
                }
            }
        }

        std::cout << "[INFO] Performing watertight interior voxelization..." << std::endl;
        std::atomic<int> completed_rays{0};
        #pragma omp parallel for collapse(2)
        for (int gz = 0; gz < nz; ++gz) {
            for (int gy = 0; gy < ny; ++gy) {
                if (terminate_flag && terminate_flag->load()) continue;
                float y_ray = (float)(ymin + (gy + 0.5f + 1.234e-4f) * cellSize);
                float z_ray = (float)(zmin + (gz + 0.5f + 5.678e-4f) * cellSize);

                const auto& candidate_indices = grid_triangles[gy + gz * ny];
                if (!candidate_indices.empty()) {
                    std::vector<float> intersects;
                    Point3D O = { (float)xmin - (float)cellSize, y_ray, z_ray };
                    Point3D D = { 1.0f, 0.0f, 0.0f };
                    for (int idx : candidate_indices) {
                        const auto& tri = triangles[idx];
                        float t;
                        if (ray_triangle_intersect(O, D, tri.v0, tri.v1, tri.v2, t)) {
                            intersects.push_back(O.x + t);
                        }
                    }

                    if (!intersects.empty()) {
                        std::sort(intersects.begin(), intersects.end());

                        for (int gx = 0; gx < nx; ++gx) {
                            float x_c = (float)(xmin + (gx + 0.5f) * cellSize);
                            int count = 0;
                            for (float xi : intersects) {
                                  if (xi < x_c) count++;
                                  else break;
                            }
                            if (count % 2 == 1) {
                                int tx = gx / TILE_SIZE_3D;
                                int ty = gy / TILE_SIZE_3D;
                                int tz = gz / TILE_SIZE_3D;
                                int t_idx = tx + ty * n_tiles_x + tz * n_tiles_x * n_tiles_y;
                                int cx = gx % TILE_SIZE_3D;
                                int cy = gy % TILE_SIZE_3D;
                                int cz = gz % TILE_SIZE_3D;
                                int idx = cx + cy * TILE_SIZE_3D + cz * TILE_SIZE_3D * TILE_SIZE_3D;
                                is_inside[t_idx * TILE_CELLS_3D + idx] = 1;
                            }
                        }
                    }
                }
                int comp = ++completed_rays;
                if (progress_callback && (comp % 100 == 0 || comp == ny * nz)) {
                    #ifdef _OPENMP
                    int thread_num = omp_get_thread_num();
                    #else
                    int thread_num = 0;
                    #endif
                    if (thread_num == 0) {
                        progress_callback(0.4 + 0.5 * (double)comp / (ny * nz));
                    }
                }
            }
        }
    } else if (voxelization_method == "winding_number") {
        std::cout << "[INFO] Performing generalized winding number interior voxelization..." << std::endl;
        if (triangles.size() > 50000) {
            std::cout << "[WARNING] Mesh size (" << triangles.size() << " triangles) is very large. Winding number computation may take a few seconds..." << std::endl;
        }

        std::atomic<int> completed_cells{0};
        int total_cells = nx * ny * nz;
        #pragma omp parallel for collapse(3)
        for (int gz = 0; gz < nz; ++gz) {
            for (int gy = 0; gy < ny; ++gy) {
                for (int gx = 0; gx < nx; ++gx) {
                    if (terminate_flag && terminate_flag->load()) continue;
                    int tx = gx / TILE_SIZE_3D;
                    int ty = gy / TILE_SIZE_3D;
                    int tz = gz / TILE_SIZE_3D;
                    int t_idx = tx + ty * n_tiles_x + tz * n_tiles_x * n_tiles_y;
                    int cx = gx % TILE_SIZE_3D;
                    int cy = gy % TILE_SIZE_3D;
                    int cz = gz % TILE_SIZE_3D;
                    int idx = cx + cy * TILE_SIZE_3D + cz * TILE_SIZE_3D * TILE_SIZE_3D;
                    int linear_idx = t_idx * TILE_CELLS_3D + idx;

                    if (!has_boundary[linear_idx]) {
                        float x_c = (float)(xmin + (gx + 0.5) * cellSize);
                        float y_c = (float)(ymin + (gy + 0.5) * cellSize);
                        float z_c = (float)(zmin + (gz + 0.5) * cellSize);
                        Point3D P = {x_c, y_c, z_c};

                        float sum = 0.0f;
                        for (int i = 0; i < (int)triangles.size(); ++i) {
                            sum += signed_solid_angle(P, triangles[i].v0, triangles[i].v1, triangles[i].v2);
                        }
                        float w = sum / (4.0f * (float)M_PI);
                        if (std::abs(w) > 0.5f) {
                            is_inside[linear_idx] = 1;
                        }
                    }
                    int comp = ++completed_cells;
                    if (progress_callback && (comp % 500 == 0 || comp == total_cells)) {
                        #ifdef _OPENMP
                        int thread_num = omp_get_thread_num();
                        #else
                        int thread_num = 0;
                        #endif
                        if (thread_num == 0) {
                            progress_callback(0.4 + 0.5 * (double)comp / total_cells);
                        }
                    }
                }
            }
        }
    }

    #pragma omp parallel for
    for (int t = 0; t < total_tiles; ++t) {
        for (int i = 0; i < TILE_CELLS_3D; ++i) {
            int linear_idx = t * TILE_CELLS_3D + i;
            if (has_boundary[linear_idx]) {
                float nx_val = accumulated_normals[linear_idx].x;
                float ny_val = accumulated_normals[linear_idx].y;
                float nz_val = accumulated_normals[linear_idx].z;
                float nlen = std::sqrt(nx_val*nx_val + ny_val*ny_val + nz_val*nz_val);
                if (nlen > 1e-6f) {
                    nx_val /= nlen; ny_val /= nlen; nz_val /= nlen;
                } else {
                    nx_val = 1.0f; ny_val = 0.0f; nz_val = 0.0f;
                }
                geom_pool[t].cells[i] = pack_geometry_payload(true, nx_val, ny_val, nz_val);
            } else if (is_inside[linear_idx]) {
                geom_pool[t].cells[i] = pack_geometry_payload(true, 0.0f, 0.0f, 0.0f);
            }
        }
    }

    std::cout << "[INFO] Cleaning up voxelized geometry (removing isolated fluid cells)..." << std::endl;
    int num_removed = 0;
    for (int iter = 0; iter < 3; ++iter) {
        int removed_this_iter = 0;
        std::vector<GeometryTile3D> new_geom_pool = geom_pool;
        
        #pragma omp parallel for reduction(+:removed_this_iter)
        for (int gz = 0; gz < nz; ++gz) {
            for (int gy = 0; gy < ny; ++gy) {
                for (int gx = 0; gx < nx; ++gx) {
                    int tx = gx / TILE_SIZE_3D;
                    int ty = gy / TILE_SIZE_3D;
                    int tz = gz / TILE_SIZE_3D;
                    int t_idx = tx + ty * n_tiles_x + tz * n_tiles_x * n_tiles_y;
                    int cx = gx % TILE_SIZE_3D;
                    int cy = gy % TILE_SIZE_3D;
                    int cz = gz % TILE_SIZE_3D;
                    int idx = cx + cy * TILE_SIZE_3D + cz * TILE_SIZE_3D * TILE_SIZE_3D;
                    
                    if (!geom_pool[t_idx].cells[idx].is_boundary) {
                        int solid_neighbors = 0;
                        
                        auto is_solid = [&](int x, int y, int z) {
                            if (x < 0 || x >= nx || y < 0 || y >= ny || z < 0 || z >= nz) return false;
                            int ntx = x / TILE_SIZE_3D;
                            int nty = y / TILE_SIZE_3D;
                            int ntz = z / TILE_SIZE_3D;
                            int nt_idx = ntx + nty * n_tiles_x + ntz * n_tiles_x * n_tiles_y;
                            int ncx = x % TILE_SIZE_3D;
                            int ncy = y % TILE_SIZE_3D;
                            int ncz = z % TILE_SIZE_3D;
                            int nidx = ncx + ncy * TILE_SIZE_3D + ncz * TILE_SIZE_3D * TILE_SIZE_3D;
                            return geom_pool[nt_idx].cells[nidx].is_boundary;
                        };
                        
                        if (is_solid(gx+1, gy, gz)) solid_neighbors++;
                        if (is_solid(gx-1, gy, gz)) solid_neighbors++;
                        if (is_solid(gx, gy+1, gz)) solid_neighbors++;
                        if (is_solid(gx, gy-1, gz)) solid_neighbors++;
                        if (is_solid(gx, gy, gz+1)) solid_neighbors++;
                        if (is_solid(gx, gy, gz-1)) solid_neighbors++;
                        
                        if (solid_neighbors >= 5) {
                            new_geom_pool[t_idx].cells[idx] = pack_geometry_payload(true, 0.0f, 0.0f, 0.0f);
                            removed_this_iter++;
                        }
                    }
                }
            }
        }
        geom_pool = new_geom_pool;
        num_removed += removed_this_iter;
        if (removed_this_iter == 0) break;
    }
    
    if (num_removed > 0) {
        std::cout << "[INFO] Removed " << num_removed << " isolated fluid cells / dead ends to improve stability." << std::endl;
    }

    global_geometry_tiles = geom_pool;
    global_geometry_hash = geometry_hash;
    global_geometry_nx = nx;
    global_geometry_ny = ny;
    global_geometry_nz = nz;
    global_geometry_cellSize = cellSize;
    global_geometry_xmin = xmin;
    global_geometry_ymin = ymin;
    global_geometry_zmin = zmin;
    if (progress_callback) progress_callback(1.0);
    std::cout << "[INFO] Voxelization complete. Geometry cached with hash: " << geometry_hash << std::endl;
}

void voxelize_stl(
    const std::string& stl_filepath,
    const std::string& geometry_hash,
    const std::string& voxelization_method,
    std::vector<GeometryTile3D>& geom_pool,
    int nx, int ny, int nz,
    double cellSize,
    double xmin, double ymin, double zmin,
    int n_tiles_x, int n_tiles_y, int n_tiles_z,
    const std::atomic<bool>* terminate_flag,
    std::function<void(double)> progress_callback
) {
    if (progress_callback) progress_callback(0.01);
    long long current_size = 0;
    long long current_mtime = 0;
    if (!stl_filepath.empty()) {
        get_file_metadata(stl_filepath, current_size, current_mtime);
    }

    if (geometry_hash == global_geometry_hash &&
        stl_filepath == global_geometry_stl_filepath &&
        current_size == global_geometry_stl_size &&
        current_mtime == global_geometry_stl_mtime &&
        !global_geometry_tiles.empty() &&
        global_geometry_tiles.size() == (size_t)geom_pool.size() &&
        global_geometry_nx == nx &&
        global_geometry_ny == ny &&
        global_geometry_nz == nz &&
        std::abs(global_geometry_cellSize - cellSize) < 1e-9 &&
        std::abs(global_geometry_xmin - xmin) < 1e-9 &&
        std::abs(global_geometry_ymin - ymin) < 1e-9 &&
        std::abs(global_geometry_zmin - zmin) < 1e-9) {
        #pragma omp parallel for
        for (int t = 0; t < (int)geom_pool.size(); ++t) {
            geom_pool[t] = global_geometry_tiles[t];
        }
        std::cout << "[INFO] Loaded 3D geometry from cache (hash: " << geometry_hash << ", path: " << stl_filepath << ")" << std::endl;
        return;
    }

    if (stl_filepath.empty()) {
        int total_tiles = n_tiles_x * n_tiles_y * n_tiles_z;
        #pragma omp parallel for
        for (int t = 0; t < total_tiles; ++t) {
            std::fill(geom_pool[t].cells, geom_pool[t].cells + TILE_CELLS_3D, GeometryPayload{0, 0, 0, false});
        }
        return;
    }

    std::vector<Triangle> triangles;
    try {
        triangles = read_stl(stl_filepath);
    } catch (const std::exception& e) {
        std::cerr << "[ERROR] Failed to load STL: " << e.what() << std::endl;
        return;
    }

    voxelize_geometry(
        triangles,
        geometry_hash,
        voxelization_method,
        geom_pool,
        nx, ny, nz,
        cellSize,
        xmin, ymin, zmin,
        n_tiles_x, n_tiles_y, n_tiles_z,
        terminate_flag,
        progress_callback
    );

    global_geometry_stl_filepath = stl_filepath;
    global_geometry_stl_size = current_size;
    global_geometry_stl_mtime = current_mtime;
}


