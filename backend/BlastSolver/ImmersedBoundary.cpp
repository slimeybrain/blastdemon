#include "ImmersedBoundary.hpp"

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

static bool is_cell_intersected(const Point3D& P, const Point3D& V0, const Point3D& V1, const Point3D& V2, const Point3D& N, float threshold) {
    // 1. Plane distance
    float d_perp = (P.x - V0.x)*N.x + (P.y - V0.y)*N.y + (P.z - V0.z)*N.z;
    if (std::abs(d_perp) > threshold) return false;

    // 2. Project P onto plane
    Point3D P_proj = { P.x - d_perp * N.x, P.y - d_perp * N.y, P.z - d_perp * N.z };

    // 3. Barycentric check
    Point3D e0 = { V1.x - V0.x, V1.y - V0.y, V1.z - V0.z };
    Point3D e1 = { V2.x - V0.x, V2.y - V0.y, V2.z - V0.z };
    Point3D v2_p = { P_proj.x - V0.x, P_proj.y - V0.y, P_proj.z - V0.z };

    float dot00 = e0.x*e0.x + e0.y*e0.y + e0.z*e0.z;
    float dot01 = e0.x*e1.x + e0.y*e1.y + e0.z*e1.z;
    float dot02 = e0.x*v2_p.x + e0.y*v2_p.y + e0.z*v2_p.z;
    float dot11 = e1.x*e1.x + e1.y*e1.y + e1.z*e1.z;
    float dot12 = e1.x*v2_p.x + e1.y*v2_p.y + e1.z*v2_p.z;

    float denom = dot00 * dot11 - dot01 * dot01;
    if (std::abs(denom) > 1e-8f) {
        float u = (dot11 * dot02 - dot01 * dot12) / denom;
        float v = (dot00 * dot12 - dot01 * dot02) / denom;
        if (u >= -0.05f && v >= -0.05f && u + v <= 1.05f) {
            return true;
        }
    }

    // 4. Edge distance check
    auto dist_to_segment = [](const Point3D& pt, const Point3D& a, const Point3D& b) -> float {
        Point3D ab = { b.x - a.x, b.y - a.y, b.z - a.z };
        Point3D ap = { pt.x - a.x, pt.y - a.y, pt.z - a.z };
        float ab2 = ab.x*ab.x + ab.y*ab.y + ab.z*ab.z;
        if (ab2 < 1e-8f) return std::sqrt(ap.x*ap.x + ap.y*ap.y + ap.z*ap.z);
        float t = (ap.x*ab.x + ap.y*ab.y + ap.z*ab.z) / ab2;
        t = std::clamp(t, 0.0f, 1.0f);
        Point3D closest = { a.x + t * ab.x, a.y + t * ab.y, a.z + t * ab.z };
        Point3D diff = { pt.x - closest.x, pt.y - closest.y, pt.z - closest.z };
        return std::sqrt(diff.x*diff.x + diff.y*diff.y + diff.z*diff.z);
    };

    if (dist_to_segment(P, V0, V1) <= threshold) return true;
    if (dist_to_segment(P, V1, V2) <= threshold) return true;
    if (dist_to_segment(P, V2, V0) <= threshold) return true;

    return false;
}

void voxelize_stl(
    const std::string& stl_filepath,
    const std::string& geometry_hash,
    std::vector<GeometryTile3D>& geom_pool,
    int nx, int ny, int nz,
    double cellSize,
    double xmin, double ymin, double zmin,
    int n_tiles_x, int n_tiles_y, int n_tiles_z
) {
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
            std::fill(geom_pool[t].cells, geom_pool[t].cells + TILE_CELLS_3D, GeometryPayload{0.0f, 0.0f, 0.0f, false});
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

    std::cout << "[INFO] Loaded STL geometry: " << stl_filepath << " (" << triangles.size() << " triangles)" << std::endl;

    int total_tiles = n_tiles_x * n_tiles_y * n_tiles_z;
    #pragma omp parallel for
    for (int t = 0; t < total_tiles; ++t) {
        std::fill(geom_pool[t].cells, geom_pool[t].cells + TILE_CELLS_3D, GeometryPayload{0.0f, 0.0f, 0.0f, false});
    }

    float threshold = 0.8f * (float)cellSize;

    // Normal accumulator for boundary cells
    std::unordered_map<int, Point3D> temp_normals;

    for (int i = 0; i < (int)triangles.size(); ++i) {
        const auto& tri = triangles[i];
        
        float min_x = std::min({tri.v0.x, tri.v1.x, tri.v2.x});
        float max_x = std::max({tri.v0.x, tri.v1.x, tri.v2.x});
        float min_y = std::min({tri.v0.y, tri.v1.y, tri.v2.y});
        float max_y = std::max({tri.v0.y, tri.v1.y, tri.v2.y});
        float min_z = std::min({tri.v0.z, tri.v1.z, tri.v2.z});
        float max_z = std::max({tri.v0.z, tri.v1.z, tri.v2.z});

        int gx_min = std::clamp(static_cast<int>((min_x - threshold - xmin) / cellSize), 0, nx - 1);
        int gx_max = std::clamp(static_cast<int>((max_x + threshold - xmin) / cellSize), 0, nx - 1);
        int gy_min = std::clamp(static_cast<int>((min_y - threshold - ymin) / cellSize), 0, ny - 1);
        int gy_max = std::clamp(static_cast<int>((max_y + threshold - ymin) / cellSize), 0, ny - 1);
        int gz_min = std::clamp(static_cast<int>((min_z - threshold - zmin) / cellSize), 0, nz - 1);
        int gz_max = std::clamp(static_cast<int>((max_z + threshold - zmin) / cellSize), 0, nz - 1);

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

        for (int gz = gz_min; gz <= gz_max; ++gz) {
            float z_c = (float)(zmin + (gz + 0.5) * cellSize);
            for (int gy = gy_min; gy <= gy_max; ++gy) {
                float y_c = (float)(ymin + (gy + 0.5) * cellSize);
                for (int gx = gx_min; gx <= gx_max; ++gx) {
                    float x_c = (float)(xmin + (gx + 0.5) * cellSize);
                    Point3D P = {x_c, y_c, z_c};
                    if (is_cell_intersected(P, tri.v0, tri.v1, tri.v2, N_unit, threshold)) {
                        int tx = gx / TILE_SIZE_3D;
                        int ty = gy / TILE_SIZE_3D;
                        int tz = gz / TILE_SIZE_3D;
                        int t_idx = tx + ty * n_tiles_x + tz * n_tiles_x * n_tiles_y;
                        int cx = gx % TILE_SIZE_3D;
                        int cy = gy % TILE_SIZE_3D;
                        int cz = gz % TILE_SIZE_3D;
                        int idx = cx + cy * TILE_SIZE_3D + cz * TILE_SIZE_3D * TILE_SIZE_3D;
                        
                        int linear_idx = t_idx * TILE_CELLS_3D + idx;
                        temp_normals[linear_idx].x += N_accum.x;
                        temp_normals[linear_idx].y += N_accum.y;
                        temp_normals[linear_idx].z += N_accum.z;
                    }
                }
            }
        }
    }

    // Watertight interior voxelization via ray-casting
    std::cout << "[INFO] Performing watertight interior voxelization..." << std::endl;
    std::vector<bool> is_inside(total_tiles * TILE_CELLS_3D, false);

    #pragma omp parallel for collapse(2)
    for (int gz = 0; gz < nz; ++gz) {
        for (int gy = 0; gy < ny; ++gy) {
            float y_ray = (float)(ymin + (gy + 0.5f + 1.234e-4f) * cellSize);
            float z_ray = (float)(zmin + (gz + 0.5f + 5.678e-4f) * cellSize);

            std::vector<Triangle> candidates;
            for (const auto& tri : triangles) {
                float min_y = std::min({tri.v0.y, tri.v1.y, tri.v2.y});
                float max_y = std::max({tri.v0.y, tri.v1.y, tri.v2.y});
                float min_z = std::min({tri.v0.z, tri.v1.z, tri.v2.z});
                float max_z = std::max({tri.v0.z, tri.v1.z, tri.v2.z});
                if (y_ray >= min_y && y_ray <= max_y && z_ray >= min_z && z_ray <= max_z) {
                    candidates.push_back(tri);
                }
            }

            if (candidates.empty()) continue;

            std::vector<float> intersects;
            Point3D O = { (float)xmin - (float)cellSize, y_ray, z_ray };
            Point3D D = { 1.0f, 0.0f, 0.0f };
            for (const auto& tri : candidates) {
                float t;
                if (ray_triangle_intersect(O, D, tri.v0, tri.v1, tri.v2, t)) {
                    intersects.push_back(O.x + t);
                }
            }

            if (intersects.empty()) continue;

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
                    is_inside[t_idx * TILE_CELLS_3D + idx] = true;
                }
            }
        }
    }

    #pragma omp parallel for
    for (int t = 0; t < total_tiles; ++t) {
        for (int i = 0; i < TILE_CELLS_3D; ++i) {
            int linear_idx = t * TILE_CELLS_3D + i;
            auto it = temp_normals.find(linear_idx);
            if (it != temp_normals.end()) {
                float nx_val = it->second.x;
                float ny_val = it->second.y;
                float nz_val = it->second.z;
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

    global_geometry_tiles = geom_pool;
    global_geometry_hash = geometry_hash;
    global_geometry_nx = nx;
    global_geometry_ny = ny;
    global_geometry_nz = nz;
    global_geometry_cellSize = cellSize;
    global_geometry_stl_filepath = stl_filepath;
    long long written_size = 0;
    long long written_mtime = 0;
    if (!stl_filepath.empty()) {
        get_file_metadata(stl_filepath, written_size, written_mtime);
    }
    global_geometry_stl_size = written_size;
    global_geometry_stl_mtime = written_mtime;
    global_geometry_xmin = xmin;
    global_geometry_ymin = ymin;
    global_geometry_zmin = zmin;
    std::cout << "[INFO] Voxelization complete. Geometry cached with hash: " << geometry_hash << std::endl;
}
