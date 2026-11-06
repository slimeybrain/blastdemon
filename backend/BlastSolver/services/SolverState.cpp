#include "SolverState.hpp"
#include "ImmersedBoundary.hpp"
#include <iostream>
#include <cmath>
#include <algorithm>

#if defined(__has_include)
  #if __has_include(<cuda_runtime.h>)
    #include <cuda_runtime.h>
  #endif
#endif

// CUDA device helpers
void select_cuda_device(const std::string& device) {
    if (device.rfind("cuda:", 0) == 0) {
        try {
            int dev_idx = std::stoi(device.substr(5));
            int dev_count = 0;
            cudaError_t err = cudaGetDeviceCount(&dev_count);
            if (err == cudaSuccess && dev_idx >= 0 && dev_idx < dev_count) {
                cudaSetDevice(dev_idx);
                global_cuda_device_index = dev_idx;
            } else {
                std::cerr << "[WARN] Invalid CUDA device index requested: " << dev_idx << ". Using device 0." << std::endl;
                cudaSetDevice(0);
                global_cuda_device_index = 0;
            }
        } catch (...) {
            cudaSetDevice(0);
            global_cuda_device_index = 0;
        }
    } else if (device == "cuda" || device == "gpu") {
        cudaSetDevice(0);
        global_cuda_device_index = 0;
    }
}

bool is_cuda_device(const std::string& device) {
    return (device.rfind("cuda", 0) == 0 || device == "gpu");
}

std::string get_absolute_path(const std::string& path, const std::string& base_dir) {
    if (path.empty()) return base_dir;
    if (path[0] == '/') return path;
    return base_dir + "/" + path;
}

int get_json_int(const nlohmann::json& j, const std::string& key, int default_val) {
    if (!j.contains(key) || j[key].is_null()) return default_val;
    if (j[key].is_number_integer()) return j[key].get<int>();
    if (j[key].is_number_float()) return static_cast<int>(j[key].get<double>());
    if (j[key].is_string()) {
        try { return std::stoi(j[key].get<std::string>()); }
        catch (...) { return default_val; }
    }
    return default_val;
}

double get_json_double(const nlohmann::json& j, const std::string& key, double default_val) {
    if (!j.contains(key) || j[key].is_null()) return default_val;
    if (j[key].is_number()) return j[key].get<double>();
    if (j[key].is_string()) {
        try { return std::stod(j[key].get<std::string>()); }
        catch (...) { return default_val; }
    }
    return default_val;
}

bool get_json_bool(const nlohmann::json& j, const std::string& key, bool default_val) {
    if (!j.contains(key) || j[key].is_null()) return default_val;
    if (j[key].is_boolean()) return j[key].get<bool>();
    if (j[key].is_number()) return j[key].get<int>() != 0;
    if (j[key].is_string()) {
        std::string s = j[key].get<std::string>();
        return (s == "true" || s == "1" || s == "True" || s == "yes");
    }
    return default_val;
}

// Execution control flags
std::atomic<bool> sim_running{false};
std::atomic<bool> sim_paused{false};
std::atomic<bool> sim_terminate{false};
std::atomic<int> step_progress{0};

std::atomic<bool> sim2d_running{false};
std::atomic<bool> sim2d_paused{false};
std::atomic<bool> sim2d_terminate{false};
std::atomic<bool> solver2d_initialized{false};
std::atomic<int> step_progress_2d{0};

std::atomic<bool> sim3d_running{false};
std::atomic<bool> sim3d_paused{false};
std::atomic<bool> sim3d_terminate{false};
std::atomic<bool> sim3d_init_in_progress{false};
std::atomic<int> step_progress_3d{0};

std::atomic<bool> sim_mpm_running{false};
std::atomic<bool> sim_mpm_3d_running{false};
std::atomic<bool> sim_mpm_3d_paused{false};
std::atomic<bool> sim_mpm_3d_terminate{false};

std::atomic<bool> sim_fem_3d_running{false};
std::atomic<bool> sim_fem_3d_paused{false};
std::atomic<bool> sim_fem_3d_terminate{false};

std::atomic<bool> sim_fsi_running{false};
std::atomic<bool> sim_fsi_3d_running{false};
std::atomic<bool> sim_fem_fsi_3d_running{false};

// General Model and Hardware Identifiers
size_t global_last_valid_nvml_vram = 0;
int global_cuda_device_index = 0;
std::string global_model_id = "";
std::string global_model_filename = "";
std::mutex cout_mutex;

// 1D CFD State
std::atomic<int> global_num_cells{0};
std::atomic<int> global_target_steps{0};
std::atomic<bool> global_exec_until_end{false};
std::atomic<double> global_cfl{0.6};
std::atomic<double> global_endtime{1.0};
std::atomic<double> global_wallclock_1d{0.0};
std::unique_ptr<CFDSolver> global_solver = nullptr;
double global_t = 0.0;
double global_dt_1d = 0.0;

// 2D CFD State
std::atomic<int> global_target_steps_2d{0};
std::atomic<bool> global_exec_until_end_2d{false};
std::atomic<double> global_cfl_2d{0.6};
std::atomic<double> global_endtime_2d{1.0};
std::atomic<double> global_wallclock_2d{0.0};
std::unique_ptr<CFDSolver2D> global_solver_2d = nullptr;
std::unique_ptr<CFDSolver2DCuda> global_solver_2d_cuda = nullptr;
double global_t2d = 0.0;
double global_dt_2d = 0.0;
std::atomic<bool> global_is_amr_2d{false};

bool has_solver_2d() {
    return (global_solver_2d || global_solver_2d_cuda);
}

// 3D CFD State
std::unique_ptr<CFDSolver3D> global_solver_3d = nullptr;
std::unique_ptr<Blast::PhaseTrackingParticles3D> global_phase_particles_3d = nullptr;
std::vector<Slice3D> global_slices_3d;
std::vector<ObstacleFace> global_obstacle_faces;
std::vector<Triangle> global_raw_stl_triangles;
std::vector<Triangle> global_tessellated_stl_triangles;
double global_t3d = 0.0;
double global_dt_3d = 0.0;
std::atomic<int> global_target_steps_3d{0};
std::atomic<bool> global_exec_until_end_3d{false};
std::atomic<double> global_cfl_3d{0.6};
std::atomic<double> global_endtime_3d{1.0};
std::atomic<double> global_wallclock_3d{0.0};
Blast::Stratified3DParams g_strat_fsi_params;
std::atomic<bool> g_is_stratified_fsi{false};

// 2D & 3D MPM State
std::unique_ptr<Blast::MPMSolver2D> global_solver_mpm_2d = nullptr;
std::unique_ptr<Blast::MPMSolver3D> global_solver_mpm_3d = nullptr;
std::unique_ptr<Blast::MPMSolver3DCUDA> global_solver_mpm_3d_cuda = nullptr;
std::atomic<bool> global_exec_until_end_mpm_3d{false};
std::atomic<int> global_target_steps_mpm_3d{0};
std::atomic<float> global_cfl_mpm_3d{0.6f};
std::atomic<double> global_endtime_mpm_3d{1.0};
std::atomic<double> global_refresh_rate_mpm_3d{0.5};

// 3D FEM State
std::unordered_map<std::string, std::unique_ptr<Blast::FEMSolver3D<float>>> global_fem_solvers_float;
std::unordered_map<std::string, std::unique_ptr<Blast::FEMSolver3D<double>>> global_fem_solvers_double;
std::unordered_map<std::string, std::unique_ptr<Blast::FEMSolver3DCUDA<float>>> global_fem_solvers_cuda_float;
std::unordered_map<std::string, std::unique_ptr<Blast::FEMSolver3DCUDA<double>>> global_fem_solvers_cuda_double;
std::atomic<bool> global_exec_until_end_fem_3d{false};
std::atomic<int> global_target_steps_fem_3d{0};
std::atomic<float> global_cfl_fem_3d{0.6f};
std::atomic<double> global_endtime_fem_3d{1.0};
std::atomic<double> global_refresh_rate_fem_3d{0.5};

// FSI State
std::unique_ptr<Blast::FSICoupler3D> global_fsi_coupler_3d = nullptr;
std::unique_ptr<Blast::DynamicHybridCoupler3D> global_hybrid_coupler_3d = nullptr;
std::unordered_map<std::string, std::unique_ptr<Blast::FEMFSICoupler3D<float>>> global_fem_fsi_couplers_float;
std::unordered_map<std::string, std::unique_ptr<Blast::FEMFSICoupler3D<double>>> global_fem_fsi_couplers_double;
std::unordered_map<std::string, std::unique_ptr<Blast::FEMFSICoupler3DCUDA<float>>> global_fem_fsi_couplers_cuda_float;
std::unordered_map<std::string, std::unique_ptr<Blast::FEMFSICoupler3DCUDA<double>>> global_fem_fsi_couplers_cuda_double;

// Telemetry & Timing Metrics
std::atomic<int> global_telemetry_stride{1};
std::atomic<int> global_mpm_particle_stride{1};
std::atomic<int> global_telemetry_interval_ms{100};
std::atomic<bool> global_telemetry_enabled{true};
std::atomic<double> global_last_compute_ms{0.0};
std::atomic<double> global_last_io_ms{0.0};
std::atomic<double> global_last_comms_ms{0.0};
std::atomic<double> global_cum_compute_s{0.0};
std::atomic<double> global_cum_io_s{0.0};
std::atomic<double> global_cum_comms_s{0.0};
std::atomic<double> global_last_vtk_ms{0.0};
std::atomic<int> global_last_vtk_step{0};
std::atomic<bool> global_enable_gauges{true};
std::atomic<bool> global_enable_vtk{false};

// Step counters
std::atomic<int> global_step_1d{0};
std::atomic<int> global_step_2d{0};
std::atomic<int> global_step_3d{0};
std::atomic<int> global_step_fsi_2d{0};
std::atomic<int> global_step_fsi_3d{0};
std::atomic<int> global_step_fem_fsi_3d{0};

// VTK last time stamps
std::atomic<double> global_last_vtk_time_1d{0.0};
std::atomic<double> global_last_vtk_time_2d{0.0};
std::atomic<double> global_last_vtk_time_3d{0.0};
std::atomic<double> global_last_vtk_time_fsi_2d{0.0};
std::atomic<double> global_last_vtk_time_fsi_3d{0.0};
std::atomic<double> global_last_vtk_time_fem_fsi_3d{0.0};
std::atomic<double> global_last_vtk_time_mpm_3d{0.0};
std::atomic<double> global_last_vtk_time_fem_3d{0.0};

void reset_timing_metrics() {
    global_cum_compute_s = 0.0;
    global_cum_io_s = 0.0;
    global_cum_comms_s = 0.0;
    global_last_compute_ms = 0.0;
    global_last_io_ms = 0.0;
    global_last_comms_ms = 0.0;
    global_last_vtk_ms = 0.0;
    global_last_vtk_step = 0;
}

size_t estimateMPMTotalParticles(const nlohmann::json& msg, float dx, float dy, float dz) {
    if (dx <= 0.0f || dy <= 0.0f || dz <= 0.0f) return 100000;
    size_t total_particles = 0;
    int domain_ppc = get_json_int(msg, "ppc", 8);
    float cell_vol = dx * dy * dz;
    if (cell_vol <= 1e-12f) return 100000;

    float xmin = static_cast<float>(get_json_double(msg, "xmin", 0.0));
    float xmax = static_cast<float>(get_json_double(msg, "xmax", 1.0));
    float ymin = static_cast<float>(get_json_double(msg, "ymin", 0.0));
    float ymax = static_cast<float>(get_json_double(msg, "ymax", 1.0));
    float zmin = static_cast<float>(get_json_double(msg, "zmin", 0.0));
    float zmax = static_cast<float>(get_json_double(msg, "zmax", 1.0));
    float domain_vol = std::max(0.0f, xmax - xmin) * std::max(0.0f, ymax - ymin) * std::max(0.0f, zmax - zmin);
    size_t max_domain_particles = (domain_vol > 0.0f && cell_vol > 0.0f)
        ? static_cast<size_t>(std::ceil((domain_vol / cell_vol) * domain_ppc))
        : 10000000ULL;

    if (msg.contains("mpm_objects") && msg["mpm_objects"].is_array() && !msg["mpm_objects"].empty()) {
        for (const auto& obj : msg["mpm_objects"]) {
            std::string shape = obj.value("shape_type", "Box");
            int ppc = get_json_int(obj, "ppc", domain_ppc);
            if (ppc < 1) ppc = std::max(1, domain_ppc);
            int particles_per_dim = static_cast<int>(std::round(std::cbrt(static_cast<float>(ppc))));
            if (particles_per_dim < 1) particles_per_dim = 1;

            float p_dx = dx / static_cast<float>(particles_per_dim);
            float p_dy = dy / static_cast<float>(particles_per_dim);
            float p_dz = dz / static_cast<float>(particles_per_dim);
            float p_vol = p_dx * p_dy * p_dz;
            if (p_vol <= 1e-15f) p_vol = cell_vol / static_cast<float>(ppc);

            float obj_vol = 0.0f;
            if (shape == "Sphere") {
                float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
                obj_vol = (4.0f / 3.0f) * 3.14159265f * radius * radius * radius;
            } else if (shape == "Cylinder") {
                float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
                float inner_radius = static_cast<float>(get_json_double(obj, "inner_radius", 0.0));
                float height = static_cast<float>(get_json_double(obj, "height", 0.2));
                obj_vol = 3.14159265f * (radius * radius - inner_radius * inner_radius) * height;
            } else if (shape == "STL") {
                std::string stl_file = obj.contains("stl_file") ? obj["stl_file"].get<std::string>() : "";
                float scale_x = static_cast<float>(get_json_double(obj, "scale_x", 1.0));
                float scale_y = static_cast<float>(get_json_double(obj, "scale_y", 1.0));
                float scale_z = static_cast<float>(get_json_double(obj, "scale_z", 1.0));
                if (scale_x <= 0.0f) scale_x = 1.0f;
                if (scale_y <= 0.0f) scale_y = 1.0f;
                if (scale_z <= 0.0f) scale_z = 1.0f;

                if (!stl_file.empty()) {
                    try {
                        auto raw_triangles = read_stl(stl_file);
                        if (!raw_triangles.empty()) {
                            float min_x = 1.0e30f, max_x = -1.0e30f;
                            float min_y = 1.0e30f, max_y = -1.0e30f;
                            float min_z = 1.0e30f, max_z = -1.0e30f;
                            for (const auto& tri : raw_triangles) {
                                min_x = std::min({min_x, tri.v0.x, tri.v1.x, tri.v2.x});
                                max_x = std::max({max_x, tri.v0.x, tri.v1.x, tri.v2.x});
                                min_y = std::min({min_y, tri.v0.y, tri.v1.y, tri.v2.y});
                                max_y = std::max({max_y, tri.v0.y, tri.v1.y, tri.v2.y});
                                min_z = std::min({min_z, tri.v0.z, tri.v1.z, tri.v2.z});
                                max_z = std::max({max_z, tri.v0.z, tri.v1.z, tri.v2.z});
                            }
                            float bb_x = (max_x - min_x) * scale_x;
                            float bb_y = (max_y - min_y) * scale_y;
                            float bb_z = (max_z - min_z) * scale_z;
                            if (bb_x > 0.0f && bb_y > 0.0f && bb_z > 0.0f) {
                                obj_vol = bb_x * bb_y * bb_z * 0.3f;
                            }
                        }
                    } catch (...) {
                        // Fallback below
                    }
                }
                if (obj_vol <= 0.0f) {
                    obj_vol = (domain_vol > 0.0f) ? (domain_vol * 0.02f) : 0.001f;
                }
            } else {
                float size_x = static_cast<float>(get_json_double(obj, "size_x", 0.2));
                float size_y = static_cast<float>(get_json_double(obj, "size_y", 0.2));
                float size_z = static_cast<float>(get_json_double(obj, "size_z", 0.2));
                obj_vol = size_x * size_y * size_z;
            }
            if (obj_vol > 0.0f && p_vol > 0.0f) {
                total_particles += static_cast<size_t>(std::ceil(obj_vol / p_vol));
            }
        }
    }
    total_particles = std::min(total_particles, max_domain_particles);
    return std::max<size_t>(total_particles, 1000);
}
