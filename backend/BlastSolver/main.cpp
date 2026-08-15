#include <poll.h>
#include <unistd.h>
#include <iostream>
#include <string>
#include <vector>
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <cmath>
#include <memory>
#include <thread>
#include <atomic>
#include <future>
#include <mutex>
#include <chrono>
#include <fstream>
#include <dlfcn.h>
#include <queue>
#include <condition_variable>

#include <omp.h>
#include <nlohmann/json.hpp>
#include "PrimitiveGeometry.hpp"
#include "ImmersedBoundary.hpp"
#include <unordered_map>
#include <filesystem>
#include "cfd_solver.hpp"
#include "cfd_solver_2d.hpp"
#include "cfd_solver_2d_cuda.hpp"
#include "cfd_solver_2d_amr.hpp"
#include "cfd_solver_2d_amr_cuda.hpp"
#include "cfd_solver_3d.hpp"
#include "cfd_solver_3d_cuda.hpp"
#include "HDF5Writer.hpp"
#include "XDMFWriter.hpp"
#include "VTKWriter.hpp"
#include "mpm_solver_2d.hpp"
#include "mpm_solver_3d.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include "fsi_coupler_3d.hpp"
#include "fem_solver_3d.hpp"
#include "fem_solver_3d_cuda.hpp"
#include "ls_dyna_reader_3d.hpp"
#include "fem_contact_3d.hpp"
#include "fem_fsi_coupler_3d.hpp"
#include "fem_fsi_coupler_3d_cuda.hpp"

void select_cuda_device(const std::string& device);
bool is_cuda_device(const std::string& device);
extern "C" int cudaSetDevice(int device);

size_t global_last_valid_nvml_vram = 0;
int global_cuda_device_index = 0;

std::unique_ptr<Blast::MPMSolver2D> global_solver_mpm_2d = nullptr;
std::unique_ptr<Blast::MPMSolver3D> global_solver_mpm_3d = nullptr;
std::unique_ptr<Blast::MPMSolver3DCUDA> global_solver_mpm_3d_cuda = nullptr;

std::unordered_map<std::string, std::unique_ptr<Blast::FEMSolver3D<float>>> global_fem_solvers_float;
std::unordered_map<std::string, std::unique_ptr<Blast::FEMSolver3D<double>>> global_fem_solvers_double;
std::unordered_map<std::string, std::unique_ptr<Blast::FEMSolver3DCUDA<float>>> global_fem_solvers_cuda_float;
std::unordered_map<std::string, std::unique_ptr<Blast::FEMSolver3DCUDA<double>>> global_fem_solvers_cuda_double;
std::unordered_map<std::string, std::unique_ptr<Blast::FEMFSICoupler3D<float>>> global_fem_fsi_couplers_float;
std::unordered_map<std::string, std::unique_ptr<Blast::FEMFSICoupler3D<double>>> global_fem_fsi_couplers_double;
std::unordered_map<std::string, std::unique_ptr<Blast::FEMFSICoupler3DCUDA<float>>> global_fem_fsi_couplers_cuda_float;
std::unordered_map<std::string, std::unique_ptr<Blast::FEMFSICoupler3DCUDA<double>>> global_fem_fsi_couplers_cuda_double;

std::string get_absolute_path(const std::string& path, const std::string& base_dir) {
    if (path.empty()) return base_dir;
    if (path[0] == '/') return path; // Already absolute
    return base_dir + "/" + path;
}

inline int get_json_int(const nlohmann::json& j, const std::string& key, int default_val) {
    if (!j.contains(key) || j[key].is_null()) return default_val;
    if (j[key].is_number_integer()) return j[key].get<int>();
    if (j[key].is_number_float()) return static_cast<int>(j[key].get<double>());
    if (j[key].is_string()) {
        try { return std::stoi(j[key].get<std::string>()); }
        catch (...) { return default_val; }
    }
    return default_val;
}

inline double get_json_double(const nlohmann::json& j, const std::string& key, double default_val) {
    if (!j.contains(key) || j[key].is_null()) return default_val;
    if (j[key].is_number()) return j[key].get<double>();
    if (j[key].is_string()) {
        try { return std::stod(j[key].get<std::string>()); }
        catch (...) { return default_val; }
    }
    return default_val;
}

inline bool get_json_bool(const nlohmann::json& j, const std::string& key, bool default_val) {
    if (!j.contains(key) || j[key].is_null()) return default_val;
    if (j[key].is_boolean()) return j[key].get<bool>();
    if (j[key].is_number()) return j[key].get<double>() != 0.0;
    if (j[key].is_string()) {
        std::string s = j[key].get<std::string>();
        if (s == "true" || s == "True" || s == "1" || s == "enabled" || s == "Enabled" || s == "yes" || s == "Yes") return true;
        if (s == "false" || s == "False" || s == "0" || s == "disabled" || s == "Disabled" || s == "no" || s == "No") return false;
    }
    return default_val;
}

inline Blast::MaterialTable3D parseMaterialTable3D(const nlohmann::json& obj) {
    Blast::MaterialTable3D mat;
    std::string mat_model_str = obj.value("material_model", "Hypoelastic");
    if (mat_model_str == "Johnson-Cook + Mie-Grüneisen" || mat_model_str == "Johnson-Cook") {
        mat.material_model = Blast::MPMMaterialModel::JohnsonCookMieGruneisen;
    } else if (mat_model_str == "RHT Concrete" || mat_model_str == "RHT") {
        mat.material_model = Blast::MPMMaterialModel::RHTConcrete;
    } else if (mat_model_str == "Karagozian & Case (K&C)" || mat_model_str == "K&C" || mat_model_str == "KC Concrete" || mat_model_str == "Karagozian & Case") {
        mat.material_model = Blast::MPMMaterialModel::KCConcrete;
    } else if (mat_model_str == "CSCM Concrete" || mat_model_str == "CSCM") {
        mat.material_model = Blast::MPMMaterialModel::CSCMConcrete;
    } else {
        mat.material_model = Blast::MPMMaterialModel::Hypoelastic;
    }
    mat.density = static_cast<float>(get_json_double(obj, "density", 7850.0));
    mat.youngs_modulus = static_cast<float>(get_json_double(obj, "youngs_modulus", 210.0e9));
    mat.poissons_ratio = static_cast<float>(get_json_double(obj, "poissons_ratio", 0.3));
    mat.yield_stress = static_cast<float>(get_json_double(obj, "yield_stress", 400.0e6));
    mat.hardening_modulus = static_cast<float>(get_json_double(obj, "hardening_modulus", 1.0e9));
    mat.failure_strain = static_cast<float>(get_json_double(obj, "failure_strain", 0.50));
    mat.tensile_failure_stress = static_cast<float>(get_json_double(obj, "tensile_failure_stress", 600.0e6));
    mat.enable_strain_erosion = get_json_bool(obj, "enable_strain_erosion", false);
    mat.erosion_strain = static_cast<float>(get_json_double(obj, "erosion_strain", mat.failure_strain));
    mat.enable_stress_erosion = get_json_bool(obj, "enable_stress_erosion", false);
    mat.erosion_stress = static_cast<float>(get_json_double(obj, "erosion_stress", mat.tensile_failure_stress));
    mat.enable_timestep_erosion = get_json_bool(obj, "enable_timestep_erosion", false);
    mat.timestep_erosion_factor = static_cast<float>(get_json_double(obj, "timestep_erosion_factor", 0.10));
    
    // JC
    mat.jc_A = static_cast<float>(get_json_double(obj, "jc_A", 792.0e6));
    mat.jc_B = static_cast<float>(get_json_double(obj, "jc_B", 510.0e6));
    mat.jc_n = static_cast<float>(get_json_double(obj, "jc_n", 0.26));
    mat.jc_C = static_cast<float>(get_json_double(obj, "jc_C", 0.014));
    mat.jc_m = static_cast<float>(get_json_double(obj, "jc_m", 1.03));
    mat.T_melt = static_cast<float>(get_json_double(obj, "T_melt", 1793.0));
    mat.T_room = static_cast<float>(get_json_double(obj, "T_room", 293.0));
    mat.Cp = static_cast<float>(get_json_double(obj, "Cp", 477.0));
    mat.mg_gamma0 = static_cast<float>(get_json_double(obj, "mg_gamma0", 1.81));
    mat.mg_c0 = static_cast<float>(get_json_double(obj, "mg_c0", 4570.0));
    mat.mg_s = static_cast<float>(get_json_double(obj, "mg_s", 1.49));
    mat.bulk_viscosity_b1 = static_cast<float>(get_json_double(obj, "bulk_viscosity_b1", 0.06));
    mat.bulk_viscosity_b2 = static_cast<float>(get_json_double(obj, "bulk_viscosity_b2", 1.20));

    // Concrete Base
    mat.fc = static_cast<float>(get_json_double(obj, "fc", 35.0e6));
    mat.ft = static_cast<float>(get_json_double(obj, "ft", 3.5e6));
    mat.G_f = static_cast<float>(get_json_double(obj, "G_f", 100.0));
    mat.moisture_content = static_cast<float>(get_json_double(obj, "moisture_content", 0.04));
    mat.dif_cap_compression = static_cast<float>(get_json_double(obj, "dif_cap_compression", 2.5));
    mat.dif_cap_tension = static_cast<float>(get_json_double(obj, "dif_cap_tension", 5.0));

    // RHT
    mat.rht_A = static_cast<float>(get_json_double(obj, "rht_A", 1.60));
    mat.rht_N = static_cast<float>(get_json_double(obj, "rht_N", 0.61));
    mat.rht_B = static_cast<float>(get_json_double(obj, "rht_B", 0.70));
    mat.rht_M = static_cast<float>(get_json_double(obj, "rht_M", 0.80));
    mat.rht_Q0 = static_cast<float>(get_json_double(obj, "rht_Q0", 0.68));
    mat.rht_BQ = static_cast<float>(get_json_double(obj, "rht_BQ", 0.0105));
    mat.rht_D1 = static_cast<float>(get_json_double(obj, "rht_D1", 0.04));
    mat.rht_D2 = static_cast<float>(get_json_double(obj, "rht_D2", 1.0));
    mat.rht_p_crush = static_cast<float>(get_json_double(obj, "rht_p_crush", 35.0e6 / 3.0));
    mat.rht_p_lock = static_cast<float>(get_json_double(obj, "rht_p_lock", 6.0e9));
    mat.rht_alpha0 = static_cast<float>(get_json_double(obj, "rht_alpha0", 1.25));
    mat.rht_n_comp = static_cast<float>(get_json_double(obj, "rht_n_comp", 3.0));
    mat.rht_betac = static_cast<float>(get_json_double(obj, "rht_betac", 0.032));
    mat.rht_deltat = static_cast<float>(get_json_double(obj, "rht_deltat", 0.036));

    // K&C
    mat.kc_auto_generate = get_json_bool(obj, "kc_auto_generate", true);
    mat.kc_a0 = static_cast<float>(get_json_double(obj, "kc_a0", 11.67e6));
    mat.kc_a1 = static_cast<float>(get_json_double(obj, "kc_a1", 0.44));
    mat.kc_a2 = static_cast<float>(get_json_double(obj, "kc_a2", 0.77e-9));
    mat.kc_a0y = static_cast<float>(get_json_double(obj, "kc_a0y", 9.33e6));
    mat.kc_a1y = static_cast<float>(get_json_double(obj, "kc_a1y", 0.35));
    mat.kc_a2y = static_cast<float>(get_json_double(obj, "kc_a2y", 0.62e-9));
    mat.kc_a1r = static_cast<float>(get_json_double(obj, "kc_a1r", 0.25));
    mat.kc_a2r = static_cast<float>(get_json_double(obj, "kc_a2r", 0.50e-9));
    mat.kc_b1 = static_cast<float>(get_json_double(obj, "kc_b1", 1.60));
    mat.kc_omega = static_cast<float>(get_json_double(obj, "kc_omega", 0.50));

    // CSCM
    mat.cscm_alpha = static_cast<float>(get_json_double(obj, "cscm_alpha", 12.0e6));
    mat.cscm_theta = static_cast<float>(get_json_double(obj, "cscm_theta", 0.40));
    mat.cscm_lambda = static_cast<float>(get_json_double(obj, "cscm_lambda", 8.0e6));
    mat.cscm_beta = static_cast<float>(get_json_double(obj, "cscm_beta", 1.5e-8));
    mat.cscm_R = static_cast<float>(get_json_double(obj, "cscm_R", 4.0));
    mat.cscm_X0 = static_cast<float>(get_json_double(obj, "cscm_X0", 100.0e6));
    mat.cscm_W = static_cast<float>(get_json_double(obj, "cscm_W", 0.05));
    mat.cscm_D1 = static_cast<float>(get_json_double(obj, "cscm_D1", 2.5e-9));
    mat.cscm_D2 = static_cast<float>(get_json_double(obj, "cscm_D2", 1.0));

    return mat;
}

template <typename T>
inline void loadAndTransformLSDynaMesh(
    const std::string& k_file,
    T pos_x, T pos_y, T pos_z,
    T vel_x, T vel_y, T vel_z,
    T scale_x, T scale_y, T scale_z,
    const std::string& bc_cond,
    const Blast::MaterialTable3D& obj_mat,
    std::vector<Blast::FEMNode3D<T>>& out_nodes,
    std::vector<Blast::FEMElement3D<T>>& out_elements
) {
    Blast::LSDynaReader3D<T> reader;
    std::vector<Blast::MaterialTable3D> mat_list;
    Blast::MaterialTable3D mutable_mat = obj_mat;
    reader.parseFile(k_file, out_nodes, out_elements, mutable_mat, mat_list);

    bool is_fixed_base = (bc_cond == "Fixed Base");
    bool is_fixed_entire = (bc_cond == "Fixed Entire");
    T min_z = static_cast<T>(1e30);
    if (is_fixed_base) {
        for (const auto& nd : out_nodes) {
            T z_val = nd.x[2] * scale_z + pos_z;
            if (z_val < min_z) min_z = z_val;
        }
    }

    for (auto& nd : out_nodes) {
        nd.x[0] = nd.x[0] * scale_x + pos_x;
        nd.x[1] = nd.x[1] * scale_y + pos_y;
        nd.x[2] = nd.x[2] * scale_z + pos_z;
        nd.x0[0] = nd.x[0];
        nd.x0[1] = nd.x[1];
        nd.x0[2] = nd.x[2];

        if (vel_x != static_cast<T>(0) || vel_y != static_cast<T>(0) || vel_z != static_cast<T>(0)) {
            nd.v[0] += vel_x;
            nd.v[1] += vel_y;
            nd.v[2] += vel_z;
        }

        if (is_fixed_entire || (is_fixed_base && std::abs(nd.x[2] - min_z) < static_cast<T>(1e-4))) {
            nd.is_fixed[0] = true;
            nd.is_fixed[1] = true;
            nd.is_fixed[2] = true;
        }
    }
}

// Global shared state for Phase 16.0 - Zero-Omission Architecture
std::atomic<bool> sim_running{false};
std::atomic<bool> sim_paused{false};
std::atomic<bool> sim_terminate{false};
std::atomic<int> step_progress{0};
std::atomic<int> global_num_cells{0};
std::atomic<int> global_target_steps{0};
std::atomic<bool> global_exec_until_end{false};
std::atomic<double> global_cfl{0.4};
std::atomic<double> global_wallclock_1d{0.0};
std::atomic<double> global_wallclock_2d{0.0};
std::mutex cout_mutex;

std::unique_ptr<CFDSolver> global_solver = nullptr;
double global_t = 0.0;
double global_dt_1d = 0.0;

// 2D State
std::atomic<bool> sim2d_running{false};
std::atomic<bool> sim2d_paused{false};
std::atomic<int> global_telemetry_stride{1};
std::atomic<int> global_telemetry_interval_ms{33};
std::atomic<bool> sim2d_terminate{false};
std::atomic<bool> solver2d_initialized{false};
std::atomic<int> step_progress_2d{0};
std::atomic<int> global_target_steps_2d{0};
std::atomic<bool> global_exec_until_end_2d{false};
std::atomic<double> global_cfl_2d{0.35};

std::unique_ptr<CFDSolver2D> global_solver_2d = nullptr;
std::unique_ptr<CFDSolver2DCuda> global_solver_2d_cuda = nullptr;
double global_t2d = 0.0;
double global_dt_2d = 0.0;
std::atomic<bool> global_is_amr_2d{false};

// 3D State
std::atomic<bool> sim3d_running{false};
std::atomic<bool> sim3d_paused{false};
std::atomic<bool> sim3d_terminate{false};
std::atomic<bool> sim3d_init_in_progress{false};
std::unique_ptr<CFDSolver3D> global_solver_3d = nullptr;
std::vector<Slice3D> global_slices_3d;
std::vector<ObstacleFace> global_obstacle_faces;
double global_t3d = 0.0;
double global_dt_3d = 0.0;
std::atomic<int> step_progress_3d{0};
std::atomic<int> global_target_steps_3d{0};
std::atomic<bool> global_exec_until_end_3d{false};
std::atomic<double> global_cfl_3d{0.4};
std::atomic<double> global_wallclock_3d{0.0};
std::atomic<bool> global_enable_gauges{true};
std::atomic<bool> global_enable_vtk{false};
std::atomic<bool> global_telemetry_enabled{true};

std::atomic<bool> sim_mpm_3d_running{false};
std::atomic<bool> sim_mpm_3d_paused{false};
std::atomic<bool> sim_mpm_3d_terminate{false};
std::atomic<bool> global_exec_until_end_mpm_3d{false};
std::atomic<int> global_target_steps_mpm_3d{0};
std::atomic<float> global_cfl_mpm_3d{0.3f};
std::atomic<double> global_refresh_rate_mpm_3d{0.033};

std::atomic<bool> sim_fem_3d_running{false};
std::atomic<bool> sim_fem_3d_paused{false};
std::atomic<bool> sim_fem_3d_terminate{false};
std::atomic<bool> global_exec_until_end_fem_3d{false};
std::atomic<int> global_target_steps_fem_3d{0};
std::atomic<float> global_cfl_fem_3d{0.3f};
std::atomic<double> global_refresh_rate_fem_3d{0.033};

std::atomic<int> global_step_1d{0};
std::atomic<int> global_step_2d{0};
std::atomic<int> global_step_3d{0};
std::atomic<int> global_step_fsi_2d{0};
std::atomic<int> global_step_fsi_3d{0};
std::atomic<int> global_step_fem_fsi_3d{0};

struct GaugeDef {
    std::string id;
    double r;
    double z;
    double x = 0.0;
    double y = 0.0;
    bool is_3d = false;
};

MultiMat::MaterialSet parseMaterialSet(const nlohmann::json& msg);

struct GaugeHistory {
    std::string id;
    std::vector<std::vector<float>> channel_values; // size 7: [p, rho, u, e_int, alpha1, alpha2, air]
};

std::vector<GaugeDef> global_gauges;
std::vector<double> global_gauge_times;
std::vector<GaugeHistory> global_gauges_history;
std::mutex global_gauges_mutex;

struct GaugeOutputConfig {
    bool export_ascii = false;
    bool export_binary = false;
    bool export_hdf5 = false;
    std::string ascii_delimiter = "Comma";
    int ascii_precision = 6;
    bool include_header = true;
    std::string output_dir = "";
    std::string custom_filename = "gauges";
    bool qty_pressure = true;
    bool qty_density = true;
    bool qty_velocity = true;
    bool qty_energy = true;
    bool qty_reacted = true;
    bool qty_unreacted = true;
    bool qty_air = true;
    bool qty_overpressure = true;
    bool qty_impulse = true;
} global_gauge_config;

struct VTKOutputConfig {
    std::string vtk_dir = "";
    bool export_slices = true;
    bool export_volumes = false;
    std::string custom_filename = "vtk_output";
    int step_interval = 10;
    double time_interval = 0.0;
    std::string vtk_format = "Binary";
    bool qty_pressure = true;
    bool qty_density = true;
    bool qty_velocity = true;
    bool qty_energy = true;
    bool qty_reacted = true;
    bool qty_unreacted = true;
    bool qty_air = true;
    bool qty_overpressure = true;
    bool qty_impulse = true;
} global_vtk_config;

std::string global_model_filename = "";
std::string global_model_id = "";

static Blast::MPMTransferScheme parseTransferScheme(const std::string& str) {
    if (str == "Standard" || str == "Normal" || str == "Linear") {
        return Blast::MPMTransferScheme::Standard;
    } else if (str == "GIMP") {
        return Blast::MPMTransferScheme::GIMP;
    } else {
        return Blast::MPMTransferScheme::BSpline;
    }
}

void write_gauge_files() {
    std::lock_guard<std::mutex> lock(global_gauges_mutex);
    if (global_gauges.empty()) return;
    void flush_solver_gauges_locked();
    flush_solver_gauges_locked();

    std::string default_dir = ".";
    try {
        if (std::filesystem::current_path().filename() == "build") {
            default_dir = "..";
        }
    } catch (...) {}
    if (!global_model_filename.empty()) {
        size_t lastSlash = global_model_filename.find_last_of('/');
        if (lastSlash != std::string::npos) {
            default_dir = global_model_filename.substr(0, lastSlash);
        }
    }
    std::string out_dir = get_absolute_path(global_gauge_config.output_dir, default_dir);
    if (!global_model_id.empty()) {
        out_dir = out_dir + "/" + global_model_id;
    }

    try {
        std::filesystem::create_directories(out_dir);
    } catch (const std::exception& e) {
        std::cerr << "[ERROR] Failed to create directory: " << out_dir << " - " << e.what() << std::endl;
    }

    std::string delimiter = ", ";
    if (global_gauge_config.ascii_delimiter == "Tab") delimiter = "\t";
    else if (global_gauge_config.ascii_delimiter == "Space") delimiter = " ";

    bool has_p = global_gauge_config.qty_pressure;
    bool has_rho = global_gauge_config.qty_density;
    bool has_vel = global_gauge_config.qty_velocity;
    bool has_E = global_gauge_config.qty_energy;
    bool has_reacted = global_gauge_config.qty_reacted;
    bool has_unreacted = global_gauge_config.qty_unreacted;
    bool has_air = global_gauge_config.qty_air;
    bool has_op = global_gauge_config.qty_overpressure;
    bool has_imp = global_gauge_config.qty_impulse;

    // 1. Export ASCII
    if (global_gauge_config.export_ascii) {
        for (size_t g_idx = 0; g_idx < global_gauges.size(); ++g_idx) {
            const auto& g = global_gauges[g_idx];
            const auto& hist = global_gauges_history[g_idx];
            std::string filename = out_dir + "/" + global_gauge_config.custom_filename + "_" + g.id + ".csv";
            std::ofstream out(filename);
            if (!out.is_open()) {
                std::cerr << "[ERROR] Failed to open ASCII gauge file: " << filename << std::endl;
                continue;
            }

            out << std::scientific << std::setprecision(global_gauge_config.ascii_precision);

            if (global_gauge_config.include_header) {
                out << "Time";
                if (has_p) out << delimiter << "Pressure";
                if (has_op) out << delimiter << "Overpressure";
                if (has_imp) out << delimiter << "Impulse";
                if (has_rho) out << delimiter << "Density";
                if (has_vel) out << delimiter << "Velocity";
                if (has_E) out << delimiter << "InternalEnergy";
                if (has_reacted) out << delimiter << "Reacted_Explosive";
                if (has_unreacted) out << delimiter << "Unreacted_Explosive";
                if (has_air) out << delimiter << "Air";
                out << "\n";
            }

            for (size_t t = 0; t < global_gauge_times.size(); ++t) {
                out << global_gauge_times[t];
                if (has_p) out << delimiter << hist.channel_values[0][t];
                if (has_op) out << delimiter << hist.channel_values[7][t];
                if (has_imp) out << delimiter << hist.channel_values[8][t];
                if (has_rho) out << delimiter << hist.channel_values[1][t];
                if (has_vel) out << delimiter << hist.channel_values[2][t];
                if (has_E) out << delimiter << hist.channel_values[3][t];
                if (has_reacted) out << delimiter << hist.channel_values[4][t];
                if (has_unreacted) out << delimiter << hist.channel_values[5][t];
                if (has_air) out << delimiter << hist.channel_values[6][t];
                out << "\n";
            }
            out.close();
            std::cout << "[INFO] Exported ASCII gauge: " << filename << std::endl;
        }
    }

    // 2. Export Binary
    if (global_gauge_config.export_binary) {
        for (size_t g_idx = 0; g_idx < global_gauges.size(); ++g_idx) {
            const auto& g = global_gauges[g_idx];
            const auto& hist = global_gauges_history[g_idx];
            std::string filename = out_dir + "/" + global_gauge_config.custom_filename + "_" + g.id + ".bin";
            std::ofstream out(filename, std::ios::binary);
            if (!out.is_open()) {
                std::cerr << "[ERROR] Failed to open Binary gauge file: " << filename << std::endl;
                continue;
            }

            char magic[4] = {'B', 'G', 'D', 'G'};
            out.write(magic, 4);

            uint32_t num_times = global_gauge_times.size();
            out.write(reinterpret_cast<const char*>(&num_times), sizeof(num_times));

            uint32_t bitmask = 0;
            if (has_p) bitmask |= 1;
            if (has_rho) bitmask |= 2;
            if (has_vel) bitmask |= 4;
            if (has_E) bitmask |= 8;
            if (has_reacted) bitmask |= 16;
            if (has_unreacted) bitmask |= 32;
            if (has_air) bitmask |= 64;
            if (has_op) bitmask |= 128;
            if (has_imp) bitmask |= 256;

            out.write(reinterpret_cast<const char*>(&bitmask), sizeof(bitmask));

            for (size_t t = 0; t < global_gauge_times.size(); ++t) {
                double time_val = global_gauge_times[t];
                out.write(reinterpret_cast<const char*>(&time_val), sizeof(time_val));

                if (has_p) { double v = hist.channel_values[0][t]; out.write(reinterpret_cast<const char*>(&v), sizeof(v)); }
                if (has_rho) { double v = hist.channel_values[1][t]; out.write(reinterpret_cast<const char*>(&v), sizeof(v)); }
                if (has_vel) { double v = hist.channel_values[2][t]; out.write(reinterpret_cast<const char*>(&v), sizeof(v)); }
                if (has_E) { double v = hist.channel_values[3][t]; out.write(reinterpret_cast<const char*>(&v), sizeof(v)); }
                if (has_reacted) { double v = hist.channel_values[4][t]; out.write(reinterpret_cast<const char*>(&v), sizeof(v)); }
                if (has_unreacted) { double v = hist.channel_values[5][t]; out.write(reinterpret_cast<const char*>(&v), sizeof(v)); }
                if (has_air) { double v = hist.channel_values[6][t]; out.write(reinterpret_cast<const char*>(&v), sizeof(v)); }
                if (has_op) { double v = hist.channel_values[7][t]; out.write(reinterpret_cast<const char*>(&v), sizeof(v)); }
                if (has_imp) { double v = hist.channel_values[8][t]; out.write(reinterpret_cast<const char*>(&v), sizeof(v)); }
            }
            out.close();
            std::cout << "[INFO] Exported Binary gauge: " << filename << std::endl;
        }
    }

    // 3. Export HDF5
    if (global_gauge_config.export_hdf5) {
        std::string filename = out_dir + "/" + global_gauge_config.custom_filename + ".h5";
        std::vector<std::string> gauge_ids;
        std::vector<std::vector<float>> p_data, rho_data, vel_data, E_data, reacted_data, unreacted_data, air_data, op_data, imp_data;

        for (size_t g_idx = 0; g_idx < global_gauges.size(); ++g_idx) {
            gauge_ids.push_back(global_gauges[g_idx].id);
            const auto& hist = global_gauges_history[g_idx];
            p_data.push_back(hist.channel_values[0]);
            rho_data.push_back(hist.channel_values[1]);
            vel_data.push_back(hist.channel_values[2]);
            E_data.push_back(hist.channel_values[3]);
            reacted_data.push_back(hist.channel_values[4]);
            unreacted_data.push_back(hist.channel_values[5]);
            air_data.push_back(hist.channel_values[6]);
            op_data.push_back(hist.channel_values[7]);
            imp_data.push_back(hist.channel_values[8]);
        }

        HDF5Writer::writeGauges(filename, global_gauge_times, gauge_ids,
                                p_data, rho_data, vel_data, E_data, reacted_data, unreacted_data, air_data, op_data, imp_data,
                                has_p, has_rho, has_vel, has_E, has_reacted, has_unreacted, has_air, has_op, has_imp);
        std::cout << "[INFO] Exported HDF5 gauge file: " << filename << std::endl;
    }
}

void write_vtk_outputs(int step, double time) {
    (void)time;
    std::string default_dir = ".";
    try {
        if (std::filesystem::current_path().filename() == "build") {
            default_dir = "..";
        }
    } catch (...) {}
    if (!global_model_filename.empty()) {
        size_t lastSlash = global_model_filename.find_last_of('/');
        if (lastSlash != std::string::npos) {
            default_dir = global_model_filename.substr(0, lastSlash);
        }
    }
    std::string out_dir = get_absolute_path(global_vtk_config.vtk_dir, default_dir);
    if (!global_model_id.empty()) {
        out_dir = out_dir + "/" + global_model_id;
    }

    try {
        std::filesystem::create_directories(out_dir);
    } catch (const std::exception& e) {
        std::cerr << "[ERROR] Failed to create directory: " << out_dir << " - " << e.what() << std::endl;
    }

    if (global_solver_3d) {
        bool has_p = global_vtk_config.qty_pressure;
        bool has_rho = global_vtk_config.qty_density;
        bool has_vel = global_vtk_config.qty_velocity;
        bool has_E = global_vtk_config.qty_energy;
        bool has_reacted = global_vtk_config.qty_reacted;
        bool has_unreacted = global_vtk_config.qty_unreacted;
        bool has_air = global_vtk_config.qty_air;
        bool has_overpressure = global_vtk_config.qty_overpressure;
        bool has_impulse = global_vtk_config.qty_impulse;

        // 1. Slices
        if (global_vtk_config.export_slices) {
            for (size_t i = 0; i < global_slices_3d.size(); ++i) {
                std::string filename = out_dir + "/" + global_vtk_config.custom_filename + "_slice_" + global_slices_3d[i].axis + "_" + std::to_string(i) + "_" + std::to_string(step) + ".vtu";
                export_vtu_slice_3d(filename, *global_solver_3d, global_slices_3d[i], global_vtk_config.vtk_format,
                                    has_p, has_rho, has_vel, has_E, has_reacted, has_unreacted, has_air,
                                    true, has_overpressure, has_impulse);
            }
        }

        // 2. Volumes
        if (global_vtk_config.export_volumes) {
            std::string filename = out_dir + "/" + global_vtk_config.custom_filename + "_volume_" + std::to_string(step) + ".vtu";
            export_vtu_volume_3d(filename, *global_solver_3d, global_vtk_config.vtk_format,
                                 has_p, has_rho, has_vel, has_E, has_reacted, has_unreacted, has_air,
                                 true, has_overpressure, has_impulse);
        }
    } else if (global_solver_2d_cuda || global_solver_2d) {
        std::string filename = out_dir + "/" + global_vtk_config.custom_filename + "_" + std::to_string(step) + ".vtu";
        if (global_solver_2d_cuda) {
            global_solver_2d_cuda->exportVTK(filename);
        } else if (global_solver_2d) {
            global_solver_2d->exportVTK(filename);
        }
    } else if (global_solver) {
        // Do not output VTU files for 1D models
    }
}

void init_gauges(const nlohmann::json& msg) {
    std::lock_guard<std::mutex> lock(global_gauges_mutex);
    global_gauges.clear();
    global_gauge_times.clear();
    global_gauges_history.clear();

    if (msg.contains("model_filename") && !msg["model_filename"].is_null()) {
        global_model_filename = msg.value("model_filename", "");
    }
    
    if (msg.contains("nodes")) {
        for (const auto& node : msg["nodes"]) {
            std::string type = node.value("type", "");
            if (type == "VirtualGauges" || type == "VirtualGauges3D") {
                if (node.contains("parameters")) {
                    const auto& params = node["parameters"];
                    global_gauge_config.export_ascii = params.value("export_ascii", false);
                    global_gauge_config.export_binary = params.value("export_binary", false);
                    global_gauge_config.export_hdf5 = params.value("export_hdf5", false);
                    global_gauge_config.ascii_delimiter = params.value("ascii_delimiter", "Comma");
                    global_gauge_config.ascii_precision = params.value("ascii_precision", 6);
                    global_gauge_config.include_header = params.value("include_header", true);
                    global_gauge_config.output_dir = params.value("output_dir", "");
                    global_gauge_config.custom_filename = params.value("custom_filename", "gauges");
                    global_gauge_config.qty_pressure = params.value("qty_pressure", true);
                    global_gauge_config.qty_density = params.value("qty_density", true);
                    global_gauge_config.qty_velocity = params.value("qty_velocity", true);
                    global_gauge_config.qty_energy = params.value("qty_energy", true);
                    global_gauge_config.qty_reacted = params.value("qty_reacted", true);
                    global_gauge_config.qty_unreacted = params.value("qty_unreacted", true);
                    global_gauge_config.qty_air = params.value("qty_air", true);
                    global_gauge_config.qty_overpressure = params.value("qty_overpressure", true);
                    global_gauge_config.qty_impulse = params.value("qty_impulse", true);
                }
                
                if (node.contains("parameters") && node["parameters"].contains("gauges")) {
                    for (const auto& gauge : node["parameters"]["gauges"]) {
                        GaugeDef g;
                        if (gauge.contains("x") || gauge.contains("y")) {
                            g.id = gauge.value("id", gauge.value("name", ""));
                            g.x = gauge.value("x", 0.0);
                            g.y = gauge.value("y", 0.0);
                            g.z = gauge.value("z", 0.0);
                            g.r = 0.0;
                            g.is_3d = true;
                        } else {
                            g.id = gauge.value("id", gauge.value("name", ""));
                            g.r = gauge.value("r", 0.0);
                            g.z = gauge.value("z", 0.0);
                            g.x = 0.0;
                            g.y = 0.0;
                            g.is_3d = false;
                        }
                        global_gauges.push_back(g);
                        
                        GaugeHistory h;
                        h.id = g.id;
                        h.channel_values.resize(9);
                        global_gauges_history.push_back(h);
                    }
                }
            } else if (type == "VTKOutput") {
                if (node.contains("parameters")) {
                    const auto& params = node["parameters"];
                    global_vtk_config.vtk_dir = params.value("vtk_dir", "");
                    global_vtk_config.export_slices = params.value("export_slices", true);
                    global_vtk_config.export_volumes = params.value("export_volumes", false);
                    global_vtk_config.custom_filename = params.value("custom_filename", "vtk_output");
                    global_vtk_config.step_interval = params.value("step_interval", 10);
                    global_vtk_config.time_interval = params.value("time_interval", 0.0);
                    global_vtk_config.vtk_format = params.value("vtk_format", "Binary");
                    global_vtk_config.qty_pressure = params.value("qty_pressure", true);
                    global_vtk_config.qty_density = params.value("qty_density", true);
                    global_vtk_config.qty_velocity = params.value("qty_velocity", true);
                    global_vtk_config.qty_energy = params.value("qty_energy", true);
                    global_vtk_config.qty_reacted = params.value("qty_reacted", true);
                    global_vtk_config.qty_unreacted = params.value("qty_unreacted", true);
                    global_vtk_config.qty_air = params.value("qty_air", true);
                    global_vtk_config.qty_overpressure = params.value("qty_overpressure", true);
                    global_vtk_config.qty_impulse = params.value("qty_impulse", true);
                }
            }
        }
    }

    std::string default_dir = ".";
    try {
        if (std::filesystem::current_path().filename() == "build") {
            default_dir = "..";
        }
    } catch (...) {}
    if (!global_model_filename.empty()) {
        size_t lastSlash = global_model_filename.find_last_of('/');
        if (lastSlash != std::string::npos) {
            default_dir = global_model_filename.substr(0, lastSlash);
        }
    }
    if (global_gauge_config.output_dir.empty()) {
        global_gauge_config.output_dir = default_dir;
    }
    if (global_vtk_config.vtk_dir.empty()) {
        global_vtk_config.vtk_dir = default_dir;
    }

    if (global_solver_3d) {
        std::vector<Gauge3D> g3d;
        for (const auto& g : global_gauges) {
            if (g.is_3d) g3d.push_back({ g.id, g.x, g.y, g.z });
            else g3d.push_back({ g.id, g.r, 0.0, g.z });
        }
        global_solver_3d->setGauges(g3d);
    }
    if (global_solver_2d_cuda) {
        std::vector<Gauge2D> g2d;
        for (const auto& g : global_gauges) {
            g2d.push_back({ g.id, g.r, g.z });
        }
        global_solver_2d_cuda->setGauges(g2d);
    } else if (global_solver_2d) {
        std::vector<Gauge2D> g2d;
        for (const auto& g : global_gauges) {
            g2d.push_back({ g.id, g.r, g.z });
        }
        global_solver_2d->setGauges(g2d);
    }
}

void record_gauges_1d(double t) {
    std::lock_guard<std::mutex> lock(global_gauges_mutex);
    if (global_gauges.empty() || !global_solver) return;
    int n_cells = global_solver->getNumCells();
    double radius = global_solver->getRadius();
    double dx = radius / n_cells;
    double p_atm = global_solver->getAmbientP();
    
    double dt = 0.0;
    if (!global_gauge_times.empty()) {
        dt = t - global_gauge_times.back();
    }
    global_gauge_times.push_back(t);
    for (size_t g_idx = 0; g_idx < global_gauges.size(); ++g_idx) {
        const auto& g = global_gauges[g_idx];
        int i = std::clamp(static_cast<int>(g.r / dx), 0, n_cells - 1);
        auto vals = global_solver->getCellValues(i);
        for (int ch = 0; ch < 7; ++ch) {
            global_gauges_history[g_idx].channel_values[ch].push_back(vals[ch]);
        }
        double overpressure = vals[0] - p_atm;
        global_gauges_history[g_idx].channel_values[7].push_back(overpressure);

        double impulse = 0.0;
        if (!global_gauges_history[g_idx].channel_values[8].empty()) {
            double prev_imp = global_gauges_history[g_idx].channel_values[8].back();
            double prev_op = global_gauges_history[g_idx].channel_values[7][global_gauges_history[g_idx].channel_values[7].size() - 2];
            impulse = prev_imp + 0.5 * (prev_op + overpressure) * dt;
        }
        global_gauges_history[g_idx].channel_values[8].push_back(impulse);
    }
}

void record_gauges_2d(double t) {
    std::lock_guard<std::mutex> lock(global_gauges_mutex);
    if (global_gauges.empty()) return;
    if (global_solver_2d_cuda) {
        global_solver_2d_cuda->recordGaugesAsync(t);
    } else if (global_solver_2d) {
        global_solver_2d->recordGaugesAsync(t);
    }
}

void record_gauges_3d(double t) {
    std::lock_guard<std::mutex> lock(global_gauges_mutex);
    if (global_gauges.empty() || !global_solver_3d) return;
    global_solver_3d->recordGaugesAsync(t);
}

void flush_solver_gauges_locked() {
    if (global_gauges.empty()) return;

    std::vector<double> times;
    std::vector<float> flat_vals;

    if (global_solver_3d) {
        global_solver_3d->retrieveNewGaugeSamples(times, flat_vals);
    } else if (global_solver_2d_cuda) {
        global_solver_2d_cuda->retrieveNewGaugeSamples(times, flat_vals);
    } else if (global_solver_2d) {
        global_solver_2d->retrieveNewGaugeSamples(times, flat_vals);
    } else {
        return;
    }

    if (times.empty()) return;

    size_t num_gauges = global_gauges.size();
    size_t num_channels = 7;
    double p_atm = 101325.0;
    if (global_solver_3d) {
        p_atm = global_solver_3d->getAmbientP();
    } else if (global_solver_2d_cuda) {
        p_atm = global_solver_2d_cuda->getAmbientP();
    } else if (global_solver_2d) {
        p_atm = global_solver_2d->getAmbientP();
    }

    for (size_t s = 0; s < times.size(); ++s) {
        double t = times[s];
        double dt = 0.0;
        if (!global_gauge_times.empty()) {
            dt = t - global_gauge_times.back();
        }
        global_gauge_times.push_back(t);

        for (size_t g_idx = 0; g_idx < num_gauges; ++g_idx) {
            for (size_t ch = 0; ch < 7; ++ch) {
                float val = flat_vals[s * num_gauges * num_channels + g_idx * num_channels + ch];
                global_gauges_history[g_idx].channel_values[ch].push_back(val);
            }

            double overpressure = global_gauges_history[g_idx].channel_values[0].back() - p_atm;
            global_gauges_history[g_idx].channel_values[7].push_back(overpressure);

            double impulse = 0.0;
            if (!global_gauges_history[g_idx].channel_values[8].empty()) {
                double prev_imp = global_gauges_history[g_idx].channel_values[8].back();
                double prev_op = global_gauges_history[g_idx].channel_values[7][global_gauges_history[g_idx].channel_values[7].size() - 2];
                impulse = prev_imp + 0.5 * (prev_op + overpressure) * dt;
            }
            global_gauges_history[g_idx].channel_values[8].push_back(impulse);
        }
    }
}

void flush_solver_gauges() {
    std::lock_guard<std::mutex> lock(global_gauges_mutex);
    flush_solver_gauges_locked();
}

void emit_telemetry(const CFDSolver& solver, double elapsed, bool is_terminated = false, int step = -1);
void emit_telemetry_2d(double elapsed, bool is_terminated = false, int step = -1);
void emit_telemetry_3d(double elapsed, bool is_terminated = false, int step = -1);
void emit_telemetry_mpm_2d(double elapsed = 0.0, bool is_terminated = false, int step = -1);
void emit_telemetry_mpm_3d(double elapsed, bool is_terminated = false, int step = -1);
void emit_telemetry_fem_3d(double elapsed = 0.0, bool is_terminated = false, int step = -1);
void emit_resource_pulse();

void emit_kernel_log(const std::string& level, const std::string& msg, double t, const std::string& scope = "1d", int step = -1) {
    std::lock_guard<std::mutex> lock(cout_mutex);
    nlohmann::json log;
    log["type"] = "log";
    log["level"] = level;
    log["message"] = msg;
    log["time"] = t;
    log["scope"] = scope;
    if (step >= 0) {
        log["step"] = step;
    } else {
        if (scope == "1d") {
            log["step"] = global_step_1d.load();
        } else if (scope == "2d") {
            log["step"] = std::max(global_step_2d.load(), global_step_fsi_2d.load());
        } else if (scope == "3d") {
            log["step"] = std::max({global_step_3d.load(), global_step_fsi_3d.load(), global_step_fem_fsi_3d.load()});
        } else if (scope == "mpm_2d") {
            int mpm_s = global_solver_mpm_2d ? global_solver_mpm_2d->getStepCount() : 0;
            log["step"] = std::max(mpm_s, global_step_fsi_2d.load());
        } else if (scope == "mpm_3d") {
            int mpm_s = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getStepCount() : (global_solver_mpm_3d ? global_solver_mpm_3d->getStepCount() : 0);
            log["step"] = std::max({mpm_s, global_step_fsi_3d.load(), global_step_3d.load()});
        } else if (scope == "fem_3d" || scope == "fem") {
            std::string m_id = global_model_id.empty() ? "default_fem" : global_model_id;
            int fem_s = 0;
            if (global_fem_solvers_cuda_float.count(m_id) && global_fem_solvers_cuda_float[m_id]) fem_s = global_fem_solvers_cuda_float[m_id]->getStepCount();
            else if (!global_fem_solvers_cuda_float.empty()) fem_s = global_fem_solvers_cuda_float.begin()->second->getStepCount();
            else if (global_fem_solvers_cuda_double.count(m_id) && global_fem_solvers_cuda_double[m_id]) fem_s = global_fem_solvers_cuda_double[m_id]->getStepCount();
            else if (!global_fem_solvers_cuda_double.empty()) fem_s = global_fem_solvers_cuda_double.begin()->second->getStepCount();
            else if (global_fem_solvers_float.count(m_id) && global_fem_solvers_float[m_id]) fem_s = global_fem_solvers_float[m_id]->getStepCount();
            else if (!global_fem_solvers_float.empty()) fem_s = global_fem_solvers_float.begin()->second->getStepCount();
            else if (global_fem_solvers_double.count(m_id) && global_fem_solvers_double[m_id]) fem_s = global_fem_solvers_double[m_id]->getStepCount();
            else if (!global_fem_solvers_double.empty()) fem_s = global_fem_solvers_double.begin()->second->getStepCount();
            log["step"] = std::max({fem_s, global_step_fem_fsi_3d.load(), global_step_3d.load()});
        } else {
            log["step"] = std::max({global_step_1d.load(), global_step_2d.load(), global_step_3d.load(), global_step_fsi_2d.load(), global_step_fsi_3d.load(), global_step_fem_fsi_3d.load()});
        }
    }
    if (!global_model_id.empty()) {
        log["modelId"] = global_model_id;
    }
    std::cout << log.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace) << std::endl;
}

bool has_solver_2d() {
    return global_solver_2d != nullptr || global_solver_2d_cuda != nullptr;
}

void worker_thread_func() {
    if (!global_solver) {
        sim_running = false;
        return;
    }
    try {
        auto last_telemetry_time = std::chrono::steady_clock::now();
    int initial_steps = global_target_steps.load();
    int initial_idx = global_solver->getActiveIndex();
    int total_range = global_solver->getNumCells() - initial_idx;

    int step_count = 0;
    double last_vtk_time = global_t;
    double last_dt = 1.0e-7;

    emit_kernel_log("INFO", "Asynchronous worker thread started.", global_t, "1d");

    while (sim_running) {
        if (sim_terminate) break;

        if (sim_paused) {
            std::this_thread::sleep_for(std::chrono::milliseconds(30));
            continue;
        }

        bool done = false;
        if (global_exec_until_end.load()) {
            if (global_solver->is_terminated()) done = true;
        } else {
            if (global_target_steps.load() <= 0) done = true;
        }

        if (done) break;

        auto step_start = std::chrono::steady_clock::now();
        double dt = global_solver->computeStepSize(global_cfl.load());
        if (step_count == 0) {
            dt = std::min(dt, 1.0e-7);
        } else {
            dt = std::min(dt, 1.3 * last_dt);
        }
        global_dt_1d = dt;
        last_dt = dt;
        global_solver->step(dt);
        auto step_end = std::chrono::steady_clock::now();
        global_wallclock_1d = global_wallclock_1d.load() + std::chrono::duration<double>(step_end - step_start).count();
        global_t += dt;
        
        global_step_1d++;
        step_count++;
        record_gauges_1d(global_t);

        {
            bool trigger_vtk = false;
            if (global_vtk_config.step_interval > 0 && (step_count % global_vtk_config.step_interval == 0)) {
                trigger_vtk = true;
            }
            if (global_vtk_config.time_interval > 0.0 && (global_t - last_vtk_time >= global_vtk_config.time_interval)) {
                trigger_vtk = true;
                last_vtk_time = global_t;
            }
            if (trigger_vtk) {
                write_vtk_outputs(step_count, global_t);
            }
        }

        if (!global_exec_until_end.load()) {
            global_target_steps--;
        }

        auto now = std::chrono::steady_clock::now();
        auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
        if (elapsed_ms >= 33) {
            emit_telemetry(*global_solver, global_t, false, global_step_1d.load());
            last_telemetry_time = now;

            nlohmann::json progress_msg;
            progress_msg["type"] = "progress";
            progress_msg["sim_time"] = global_t;
            progress_msg["step"] = global_step_1d.load();
            progress_msg["scope"] = "1d";

            if (global_exec_until_end.load()) {
                if (total_range > 0) {
                    int current_range = global_solver->getActiveIndex() - initial_idx;
                    int percent = std::clamp((int)((current_range * 100) / total_range), 0, 100);
                    step_progress = percent;
                    progress_msg["percent"] = percent;
                    progress_msg["mode"] = "EXEC_ALL";
                }
            } else {
                initial_steps = std::max(initial_steps, step_count + global_target_steps.load());
                if (initial_steps > 0) {
                    int completed = initial_steps - global_target_steps.load();
                    int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 100);
                    step_progress = percent;
                    progress_msg["percent"] = percent;
                    progress_msg["completed"] = completed;
                    progress_msg["total"] = initial_steps;
                    progress_msg["mode"] = "STEP";
                }
            }
            std::lock_guard<std::mutex> lock(cout_mutex);
            std::cout << progress_msg.dump() << std::endl;
        }
    }

    bool term = global_solver->is_terminated();
    emit_telemetry(*global_solver, global_t, term, global_step_1d.load());
    
    // Emit final 100% progress packet to transition frontend state to paused/complete
    nlohmann::json progress_msg;
    progress_msg["type"] = "progress";
    progress_msg["sim_time"] = global_t;
    progress_msg["step"] = global_step_1d.load();
    progress_msg["scope"] = "1d";
    progress_msg["percent"] = 100;
    progress_msg["mode"] = global_exec_until_end.load() ? "EXEC_ALL" : "STEP";
    {
        std::lock_guard<std::mutex> lock(cout_mutex);
        std::cout << progress_msg.dump() << std::endl;
    }
    
    step_progress = 100;
    emit_kernel_log("INFO", "Worker thread execution cycle ended.", global_t, "1d", global_step_1d.load());
    write_gauge_files();
        write_vtk_outputs(step_count, global_t);
        sim_running = false;
        sim_paused = false;
        sim_terminate = false;
        global_target_steps = 0;
        global_exec_until_end = false;
    } catch (const std::exception& e) {
        emit_kernel_log("ERROR", std::string("1D worker thread error: ") + e.what(), global_t, "1d");
        sim_running = false;
        std::exit(1);
    } catch (...) {
        emit_kernel_log("ERROR", "1D worker thread error: unknown exception", global_t, "1d");
        sim_running = false;
        std::exit(1);
    }
}

extern std::vector<GeometryTile3D> global_geometry_tiles;

void generateObstacleMesh(int nx, int ny, int nz, double cellSize, double xmin, double ymin, double zmin) {
    global_obstacle_faces.clear();
    if (global_geometry_tiles.empty()) return;

    // 1. Flatten the solid cell lookup into a contiguous 1D vector (Single-threaded)
    std::vector<uint8_t> solid_mask(nx * ny * nz, 0);

    auto is_solid_raw = [&](int i, int j, int k) -> bool {
        int ti = i / 8, tj = j / 8, tk = k / 8;
        int ntx = (nx + 7) / 8;
        int nty = (ny + 7) / 8;
        int t = ti + tj * ntx + tk * ntx * nty;
        int c = (i & 7) + (j & 7) * 8 + (k & 7) * 64;
        if (t < 0 || t >= (int)global_geometry_tiles.size()) return false;
        return global_geometry_tiles[t].cells[c].is_boundary;
    };

    for (int k = 0; k < nz; ++k) {
        for (int j = 0; j < ny; ++j) {
            for (int i = 0; i < nx; ++i) {
                solid_mask[i + j * nx + k * nx * ny] = is_solid_raw(i, j, k) ? 1 : 0;
            }
        }
    }

    // 2. Sequential face generation
    for (int gz = 0; gz < nz; ++gz) {
        for (int gy = 0; gy < ny; ++gy) {
            for (int gx = 0; gx < nx; ++gx) {
                size_t idx = gx + gy * nx + gz * nx * ny;
                if (solid_mask[idx]) continue; // Fluid cell checks neighbors

                double x0 = xmin + gx * cellSize;
                double x1 = xmin + (gx + 1) * cellSize;
                double y0 = ymin + gy * cellSize;
                double y1 = ymin + (gy + 1) * cellSize;
                double z0 = zmin + gz * cellSize;
                double z1 = zmin + (gz + 1) * cellSize;

                // left (-x)
                if (gx > 0 && solid_mask[idx - 1]) {
                    ObstacleFace face;
                    face.gx_fluid = gx; face.gy_fluid = gy; face.gz_fluid = gz;
                    face.px[0] = x0; face.px[1] = x0; face.px[2] = x0; face.px[3] = x0;
                    face.py[0] = y0; face.py[1] = y0; face.py[2] = y1; face.py[3] = y1;
                    face.pz[0] = z0; face.pz[1] = z1; face.pz[2] = z1; face.pz[3] = z0;
                    global_obstacle_faces.push_back(face);
                }
                // right (+x)
                if (gx < nx - 1 && solid_mask[idx + 1]) {
                    ObstacleFace face;
                    face.gx_fluid = gx; face.gy_fluid = gy; face.gz_fluid = gz;
                    face.px[0] = x1; face.px[1] = x1; face.px[2] = x1; face.px[3] = x1;
                    face.py[0] = y0; face.py[1] = y1; face.py[2] = y1; face.py[3] = y0;
                    face.pz[0] = z0; face.pz[1] = z0; face.pz[2] = z1; face.pz[3] = z1;
                    global_obstacle_faces.push_back(face);
                }
                // bottom (-y)
                if (gy > 0 && solid_mask[idx - nx]) {
                    ObstacleFace face;
                    face.gx_fluid = gx; face.gy_fluid = gy; face.gz_fluid = gz;
                    face.px[0] = x0; face.px[1] = x1; face.px[2] = x1; face.px[3] = x0;
                    face.py[0] = y0; face.py[1] = y0; face.py[2] = y0; face.py[3] = y0;
                    face.pz[0] = z0; face.pz[1] = z0; face.pz[2] = z1; face.pz[3] = z1;
                    global_obstacle_faces.push_back(face);
                }
                // top (+y)
                if (gy < ny - 1 && solid_mask[idx + nx]) {
                    ObstacleFace face;
                    face.gx_fluid = gx; face.gy_fluid = gy; face.gz_fluid = gz;
                    face.px[0] = x0; face.px[1] = x0; face.px[2] = x1; face.px[3] = x1;
                    face.py[0] = y1; face.py[1] = y1; face.py[2] = y1; face.py[3] = y1;
                    face.pz[0] = z0; face.pz[1] = z1; face.pz[2] = z1; face.pz[3] = z0;
                    global_obstacle_faces.push_back(face);
                }
                // back (-z)
                if (gz > 0 && solid_mask[idx - nx * ny]) {
                    ObstacleFace face;
                    face.gx_fluid = gx; face.gy_fluid = gy; face.gz_fluid = gz;
                    face.px[0] = x0; face.px[1] = x0; face.px[2] = x1; face.px[3] = x1;
                    face.py[0] = y0; face.py[1] = y1; face.py[2] = y1; face.py[3] = y0;
                    face.pz[0] = z0; face.pz[1] = z0; face.pz[2] = z0; face.pz[3] = z0;
                    global_obstacle_faces.push_back(face);
                }
                // front (+z)
                if (gz < nz - 1 && solid_mask[idx + nx * ny]) {
                    ObstacleFace face;
                    face.gx_fluid = gx; face.gy_fluid = gy; face.gz_fluid = gz;
                    face.px[0] = x0; face.px[1] = x1; face.px[2] = x1; face.px[3] = x0;
                    face.py[0] = y0; face.py[1] = y0; face.py[2] = y1; face.py[3] = y1;
                    face.pz[0] = z1; face.pz[1] = z1; face.pz[2] = z1; face.pz[3] = z1;
                    global_obstacle_faces.push_back(face);
                }
            }
        }
    }
}

void sendObstacleMeshToFrontend(const std::string& modelId) {
    (void)modelId;
    if (global_obstacle_faces.empty()) return;

    size_t total_faces = global_obstacle_faces.size();

    std::vector<float> vertices;
    vertices.reserve(total_faces * 12);
    for (size_t f = 0; f < total_faces; ++f) {
        const auto& face = global_obstacle_faces[f];
        vertices.push_back((float)face.px[0]); vertices.push_back((float)face.py[0]); vertices.push_back((float)face.pz[0]);
        vertices.push_back((float)face.px[1]); vertices.push_back((float)face.py[1]); vertices.push_back((float)face.pz[1]);
        vertices.push_back((float)face.px[2]); vertices.push_back((float)face.py[2]); vertices.push_back((float)face.pz[2]);
        vertices.push_back((float)face.px[3]); vertices.push_back((float)face.py[3]); vertices.push_back((float)face.pz[3]);
    }

    std::vector<int32_t> cells;
    cells.reserve(total_faces * 3);
    for (size_t f = 0; f < total_faces; ++f) {
        const auto& face = global_obstacle_faces[f];
        cells.push_back((int32_t)face.gx_fluid);
        cells.push_back((int32_t)face.gy_fluid);
        cells.push_back((int32_t)face.gz_fluid);
    }

    std::string meshId = "default_obstacles";
    uint32_t magic = 0x424f4253; // "BOBS"
    uint32_t meshIdLen = static_cast<uint32_t>(meshId.size());
    uint32_t numVerts = static_cast<uint32_t>(vertices.size());
    uint32_t numCells = static_cast<uint32_t>(cells.size());

    size_t payload_bytes = 4 + 4 + meshIdLen + 4 + 4 + (vertices.size() * sizeof(float)) + (cells.size() * sizeof(int32_t));

    std::cout << "BIN_OBSTACLES " << payload_bytes << "\n";
    std::cout.write(reinterpret_cast<const char*>(&magic), 4);
    std::cout.write(reinterpret_cast<const char*>(&meshIdLen), 4);
    std::cout.write(meshId.data(), meshIdLen);
    std::cout.write(reinterpret_cast<const char*>(&numVerts), 4);
    std::cout.write(reinterpret_cast<const char*>(&numCells), 4);
    std::cout.write(reinterpret_cast<const char*>(vertices.data()), vertices.size() * sizeof(float));
    std::cout.write(reinterpret_cast<const char*>(cells.data()), cells.size() * sizeof(int32_t));
    std::cout.flush();

    std::cout << "[INFO] Emitted binary obstacle surface mesh with " << total_faces << " faces." << std::endl;
}

struct PendingRemap {
    bool has_pending = false;
    std::string type = ""; // "1D" or "2D"
    nlohmann::json msg;
};
static std::mutex g_pending_remap_mutex;
static PendingRemap g_pending_remap;

void apply_remap_payload(const nlohmann::json& msg, const std::string& type, CFDSolver3D* solver_3d, CFDSolver2D* solver_2d, CFDSolver2DCuda* solver_2d_cuda) {
    if (type == "1D") {
        double explosive_z = msg.value("explosive_z", 0.0);
        double remap_radius = msg.value("remap_radius", 0.5);
        double explosive_r = msg.value("explosive_r", 0.0);
        double ambient_rho = msg.value("ambient_rho", 1.225648589);
        double ambient_p = msg.value("ambient_p", 101325.0);
        double gamma = msg.value("gamma", 1.4);
        
        std::string composition = msg.value("composition", "TNT");
        std::string explosive_type = msg.value("explosive_type", "");
        bool is_ideal_gas = (explosive_type == "MaterialIdealGas" || msg.value("init_mode", "") == "Ideal Gas");

        MultiMat::MaterialSet matSet = parseMaterialSet(msg);

        std::vector<double> r_1d = msg.at("r_1d").get<std::vector<double>>();
        std::vector<MultiMaterialState> states_1d;
        if (msg.contains("states_1d")) {
            for (const auto& item : msg.at("states_1d")) {
                MultiMaterialState s;
                s.rho = item.at("rho").get<double>();
                s.u = item.at("u").get<double>();
                s.p = item.at("p").get<double>();
                s.E = item.at("E").get<double>();
                s.alpha1 = item.at("alpha1").get<double>();
                s.alpha2 = item.at("alpha2").get<double>();
                s.arho1 = item.at("arho1").get<double>();
                s.arho2 = item.at("arho2").get<double>();
                s.floor_status = item.value("floor_status", 0);
                states_1d.push_back(s);
            }
        } else if (msg.contains("rho_1d") && msg.contains("ur_1d") && msg.contains("p_1d")) {
            std::vector<double> rho_1d = msg.at("rho_1d").get<std::vector<double>>();
            std::vector<double> ur_1d = msg.at("ur_1d").get<std::vector<double>>();
            std::vector<double> p_1d = msg.at("p_1d").get<std::vector<double>>();
            for (size_t i = 0; i < r_1d.size(); ++i) {
                MultiMaterialState s{};
                s.rho = rho_1d[i];
                s.u = ur_1d[i];
                s.p = p_1d[i];
                s.alpha1 = 0.0;
                s.alpha2 = 0.0;
                s.arho1 = 0.0;
                s.arho2 = 0.0;
                s.E = s.p / (gamma - 1.0) + 0.5 * s.rho * s.u * s.u;
                states_1d.push_back(s);
            }
        }

        if (solver_3d) {
            auto map_bc_3d = [](const std::string& str) {
                if (str == "Transmitting" || str == "TRANSMISSIVE") return BCType3D::TRANSMISSIVE;
                if (str == "Terminate" || str == "OUTFLOW_RIEMANN") return BCType3D::OUTFLOW_RIEMANN;
                return BCType3D::REFLECTIVE;
            };
            solver_3d->setBoundaryConditions(
                map_bc_3d(msg.value("bc_x_min", "Reflecting")), map_bc_3d(msg.value("bc_x_max", "Transmitting")),
                map_bc_3d(msg.value("bc_y_min", "Reflecting")), map_bc_3d(msg.value("bc_y_max", "Transmitting")),
                map_bc_3d(msg.value("bc_z_min", "Reflecting")), map_bc_3d(msg.value("bc_z_max", "Transmitting"))
            );
            solver_3d->setGamma(gamma);
            solver_3d->setIdealGas(is_ideal_gas);
            solver_3d->setMaterialParameters(matSet);
            double explosive_x = msg.value("explosive_x", 0.5);
            double explosive_y = msg.value("explosive_y", 0.5);
            double start_time = msg.value("time", msg.value("sim_time", 0.0));
            solver_3d->initializeFrom1D(r_1d, states_1d, explosive_x, explosive_y, explosive_z, remap_radius);
            solver_3d->setTime(start_time);
            global_t3d = start_time;
            global_wallclock_3d = 0.0;
            emit_kernel_log("REMAP", "1D->3D remap applied successfully.", start_time, "3d");
            emit_telemetry_3d(global_t3d, false);
        } else if (solver_2d) {
            solver_2d->setGamma(gamma);
            solver_2d->setIdealGas(is_ideal_gas);
            solver_2d->setMaterialParameters(matSet);
            solver_2d->setInitialConditionFrom1D(explosive_z, remap_radius, r_1d, states_1d, ambient_rho, ambient_p, explosive_r);
            solver_2d->setTime(0.0);
            global_t2d = 0.0;
            global_wallclock_2d = 0.0;
            solver2d_initialized = true;
            emit_kernel_log("REMAP", "1D->2D remap applied successfully.", 0.0, "2d");
            emit_telemetry_2d(global_t2d, false);
        } else if (solver_2d_cuda) {
            solver_2d_cuda->setGamma(gamma);
            solver_2d_cuda->setIdealGas(is_ideal_gas);
            solver_2d_cuda->setMaterialParameters(matSet);
            solver_2d_cuda->setInitialConditionFrom1D(explosive_z, remap_radius, r_1d, states_1d, ambient_rho, ambient_p, explosive_r);
            solver_2d_cuda->setTime(0.0);
            global_t2d = 0.0;
            global_wallclock_2d = 0.0;
            solver2d_initialized = true;
            emit_kernel_log("REMAP", "1D->2D remap applied successfully.", 0.0, "2d");
            emit_telemetry_2d(global_t2d, false);
        }
    } else if (type == "2D") {
        int nr = msg.value("nr", 100);
        int nz = msg.value("nz", 100);
        double cell_size = msg.value("cell_size", 0.005);
        double max_r = msg.value("max_r", (double)nr * cell_size);
        double max_z = msg.value("max_z", (double)nz * cell_size);
        double dr = max_r / nr;
        double dz = max_z / nz;
        double explosive_x = msg.value("explosive_x", 0.5);
        double explosive_y = msg.value("explosive_y", 0.5);
        double explosive_z = msg.value("explosive_z", 0.5);
        double source_explosive_z = msg.value("source_explosive_z", msg.value("source_z", 0.0));
        double remap_radius = msg.value("remap_radius", 0.0);

        std::vector<State2D> states_2d;
        if (msg.contains("states_2d")) {
            for (const auto& item : msg.at("states_2d")) {
                State2D s{};
                s.rho = item.value("rho", 1.225);
                s.ur = item.value("ur", 0.0);
                s.uz = item.value("uz", 0.0);
                s.p = item.value("p", 101325.0);
                s.E = item.value("E", 253312.5);
                s.alpha1 = item.value("alpha1", 0.0);
                s.alpha2 = item.value("alpha2", 0.0);
                s.arho1 = item.value("arho1", 0.0);
                s.arho2 = item.value("arho2", 0.0);
                states_2d.push_back(s);
            }
        } else if (msg.contains("telemetry_data")) {
            std::vector<double> data = msg.at("telemetry_data").get<std::vector<double>>();
            size_t n_cells = (size_t)nr * (size_t)nz;
            if (n_cells > 0 && data.size() >= n_cells) {
                size_t n_channels = data.size() / n_cells;
                for (size_t i = 0; i < n_cells; ++i) {
                    State2D s{};
                    s.p      = (n_channels > 0) ? data[0 * n_cells + i] : 101325.0;
                    s.rho    = (n_channels > 1) ? data[1 * n_cells + i] : 1.225;
                    s.ur     = (n_channels > 2) ? data[2 * n_cells + i] : 0.0;
                    s.uz     = (n_channels > 3) ? data[3 * n_cells + i] : 0.0;
                    s.E      = (n_channels > 4) ? data[4 * n_cells + i] : 253312.5;
                    s.alpha1 = (n_channels > 5) ? data[5 * n_cells + i] : 0.0;
                    s.alpha2 = (n_channels > 6) ? data[6 * n_cells + i] : 0.0;
                    s.arho1  = s.alpha1 * s.rho;
                    s.arho2  = s.alpha2 * s.rho;
                    states_2d.push_back(s);
                }
            }
        }

        double gamma_val = msg.value("gamma", 1.4);
        std::string explosive_type = msg.value("explosive_type", "");
        std::string material_type = msg.value("material_type", "");
        bool is_ideal_gas_val = (msg.value("is_ideal_gas", false) || explosive_type == "MaterialIdealGas" || msg.value("init_mode", "") == "Ideal Gas" || material_type == "Ideal Gas Charge");
        bool is_multimat_needed = !is_ideal_gas_val;
        MultiMat::MaterialSet matSet_val = parseMaterialSet(msg);

        double amb_p_val = msg.value("ambient_p", msg.value("atm_pressure", 101325.0));
        double amb_rho_val = msg.value("ambient_rho", 1.225);

        int req_nx = msg.value("nx_3d", msg.value("nx", 64));
        int req_ny = msg.value("ny_3d", msg.value("ny", 64));
        int req_nz = msg.value("nz_3d", msg.value("nz", 64));
        double req_cellSize = msg.value("cell_size_3d", msg.value("cell_size", 0.01));

        bool needs_realloc = false;
        std::string req_device = msg.value("device", "cuda");
        if (!solver_3d) {
            needs_realloc = true;
        } else if (solver_3d->isMultiMaterial() != is_multimat_needed) {
            needs_realloc = true;
        } else if (solver_3d->isCUDA() != is_cuda_device(req_device)) {
            needs_realloc = true;
        } else if (solver_3d->getNx() != req_nx || solver_3d->getNy() != req_ny || solver_3d->getNz() != req_nz || std::abs(solver_3d->getCellSize() - req_cellSize) > 1e-6) {
            needs_realloc = true;
        }

        if (needs_realloc) {
            std::cout << "[INFO] Allocating/Reallocating 3D solver for REMAP_2D: current solver=" 
                      << (solver_3d ? (solver_3d->isMultiMaterial() ? "MultiMaterial" : "SingleMaterial") : "null")
                      << " needed IsMultiMaterial=" << is_multimat_needed << std::endl;
            emit_kernel_log("REMAP_2D", std::string("3D Solver Engine allocated: ") + (is_multimat_needed ? "Multi-Material JWL" : "Single-Material Ideal Gas") + " on " + req_device, 0.0, "3d");
            int nx_val = req_nx;
            int ny_val = req_ny;
            int nz_val = req_nz;
            double cellSize = req_cellSize;
            double xmin = msg.value("xmin_3d", msg.value("xmin", 0.0));
            double ymin = msg.value("ymin_3d", msg.value("ymin", 0.0));
            double zmin = msg.value("zmin_3d", msg.value("zmin", 0.0));
            std::string device = msg.value("device", "cuda");
            std::string precision = msg.value("precision", "single");

            select_cuda_device(device);
            if (is_cuda_device(device)) {
                if (precision == "double") {
                    if (is_multimat_needed) global_solver_3d = std::make_unique<CFDSolver3DCuda<double, true>>(nx_val, ny_val, nz_val, cellSize, xmin, ymin, zmin);
                    else global_solver_3d = std::make_unique<CFDSolver3DCuda<double, false>>(nx_val, ny_val, nz_val, cellSize, xmin, ymin, zmin);
                } else {
                    if (is_multimat_needed) global_solver_3d = std::make_unique<CFDSolver3DCuda<float, true>>(nx_val, ny_val, nz_val, cellSize, xmin, ymin, zmin);
                    else global_solver_3d = std::make_unique<CFDSolver3DCuda<float, false>>(nx_val, ny_val, nz_val, cellSize, xmin, ymin, zmin);
                }
            } else {
                if (precision == "double") {
                    if (is_multimat_needed) global_solver_3d = std::make_unique<CFDSolver3DImpl<double, true>>(nx_val, ny_val, nz_val, cellSize, xmin, ymin, zmin);
                    else global_solver_3d = std::make_unique<CFDSolver3DImpl<double, false>>(nx_val, ny_val, nz_val, cellSize, xmin, ymin, zmin);
                } else {
                    if (is_multimat_needed) global_solver_3d = std::make_unique<CFDSolver3DImpl<float, true>>(nx_val, ny_val, nz_val, cellSize, xmin, ymin, zmin);
                    else global_solver_3d = std::make_unique<CFDSolver3DImpl<float, false>>(nx_val, ny_val, nz_val, cellSize, xmin, ymin, zmin);
                }
            }
            solver_3d = global_solver_3d.get();
        }

        if (solver_3d && !states_2d.empty()) {
            auto map_bc_3d = [](const std::string& str) {
                if (str == "Transmitting" || str == "TRANSMISSIVE") return BCType3D::TRANSMISSIVE;
                if (str == "Terminate" || str == "OUTFLOW_RIEMANN") return BCType3D::OUTFLOW_RIEMANN;
                return BCType3D::REFLECTIVE;
            };
            solver_3d->setBoundaryConditions(
                map_bc_3d(msg.value("bc_x_min", "Reflecting")), map_bc_3d(msg.value("bc_x_max", "Transmitting")),
                map_bc_3d(msg.value("bc_y_min", "Reflecting")), map_bc_3d(msg.value("bc_y_max", "Transmitting")),
                map_bc_3d(msg.value("bc_z_min", "Reflecting")), map_bc_3d(msg.value("bc_z_max", "Transmitting"))
            );

            solver_3d->setGamma(gamma_val);
            solver_3d->setIdealGas(is_ideal_gas_val);
            solver_3d->setMaterialParameters(matSet_val);
            solver_3d->setAmbientState(amb_rho_val, amb_p_val);
            double start_time = msg.value("time", msg.value("sim_time", 0.0));
            solver_3d->initializeFrom2D(nr, nz, dr, dz, states_2d, explosive_x, explosive_y, explosive_z, remap_radius, source_explosive_z);
            solver_3d->setTime(start_time);
            global_t3d = start_time;
            global_wallclock_3d = 0.0;
            emit_kernel_log("REMAP_2D", "2D->3D remap applied successfully.", start_time, "3d");
            emit_telemetry_3d(global_t3d, false);
        }
    }
}

void init_3d_thread_func(nlohmann::json msg) {
    sim3d_init_in_progress = true;
    try {
        double cellSize = get_json_double(msg, "cell_size", 0.01);
        double xmin = get_json_double(msg, "xmin", 0.0);
        double ymin = get_json_double(msg, "ymin", 0.0);
        double zmin = get_json_double(msg, "zmin", 0.0);
        double xmax = get_json_double(msg, "xmax", xmin + 1.0);
        double ymax = get_json_double(msg, "ymax", ymin + 1.0);
        double zmax = get_json_double(msg, "zmax", zmin + 1.0);
        int default_nx = std::max(1, static_cast<int>(std::round((xmax - xmin) / cellSize)));
        int default_ny = std::max(1, static_cast<int>(std::round((ymax - ymin) / cellSize)));
        int default_nz = std::max(1, static_cast<int>(std::round((zmax - zmin) / cellSize)));
        int nx = get_json_int(msg, "nx", default_nx);
        int ny = get_json_int(msg, "ny", default_ny);
        int nz = get_json_int(msg, "nz", default_nz);
        if (nx <= 0) nx = default_nx;
        if (ny <= 0) ny = default_ny;
        if (nz <= 0) nz = default_nz;
        std::string device = msg.value("device", "cpu");

        std::string init_mode = msg.value("init_mode", "Multi-Material JWL");
        std::string explosive_type = msg.value("explosive_type", "");
        std::string material_type = msg.value("material_type", "");
        bool is_ideal_gas_3d = (msg.value("is_ideal_gas", false) || init_mode == "Ideal Gas" || explosive_type == "MaterialIdealGas" || material_type == "Ideal Gas Charge");
        bool is_multimat = !is_ideal_gas_3d;

        global_enable_gauges = (msg.value("enable_gauges", "Enabled") != "Disabled");
        global_enable_vtk = (msg.value("enable_vtk", "Disabled") == "Enabled");
        std::string telem_mode = msg.value("telemetry_mode", "Enabled");
        if (telem_mode == "Disabled") {
            global_telemetry_enabled = false;
        } else if (telem_mode == "Throttled (1 Hz)") {
            global_telemetry_enabled = true;
            global_telemetry_interval_ms = 1000;
        } else if (telem_mode == "Throttled (0.2 Hz)") {
            global_telemetry_enabled = true;
            global_telemetry_interval_ms = 5000;
        } else {
            global_telemetry_enabled = true;
            int interval_param = msg.value("telemetry_interval_ms", 100);
            if (interval_param > 0) global_telemetry_interval_ms = interval_param;
        }

        std::unique_ptr<CFDSolver3D> local_solver_3d = nullptr;
        std::string precision = msg.value("precision", "single");
        select_cuda_device(device);
        if (is_cuda_device(device)) {
            if (precision == "single" || precision == "float") {
                if (is_multimat) {
                    local_solver_3d = std::make_unique<CFDSolver3DCuda<float, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                } else {
                    local_solver_3d = std::make_unique<CFDSolver3DCuda<float, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                }
            } else {
                if (is_multimat) {
                    local_solver_3d = std::make_unique<CFDSolver3DCuda<double, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                } else {
                    local_solver_3d = std::make_unique<CFDSolver3DCuda<double, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                }
            }
        } else {
            if (precision == "single" || precision == "float") {
                if (is_multimat) {
                    local_solver_3d = std::make_unique<CFDSolver3DImpl<float, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                } else {
                    local_solver_3d = std::make_unique<CFDSolver3DImpl<float, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                }
            } else {
                if (is_multimat) {
                    local_solver_3d = std::make_unique<CFDSolver3DImpl<double, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                } else {
                    local_solver_3d = std::make_unique<CFDSolver3DImpl<double, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                }
            }
        }



        std::string flux_scheme = msg.value("flux_scheme", "AUSM+");
        int spatial_order = msg.value("spatial_order", 2);
        int temporal_order = msg.value("temporal_order", 4);

        local_solver_3d->setFluxScheme(flux_scheme);
        local_solver_3d->setSpatialOrder(spatial_order);
        local_solver_3d->setTemporalOrder(temporal_order);

        Charge3DParams cp;
        std::string shape_str = msg.value("charge_shape", "Sphere");
        if (shape_str == "Sphere") cp.shape_type = 0;
        else if (shape_str == "Block") cp.shape_type = 1;
        else cp.shape_type = 2; // Cylinder
        cp.x = msg.value("charge_x", 0.0);
        cp.y = msg.value("charge_y", 0.0);
        cp.z = msg.value("charge_z", 0.0);
        cp.radius = msg.value("charge_radius", 0.1);
        cp.height = msg.value("charge_height", 0.2);
        if (msg.contains("charge_aspect_ratio") && !msg.contains("charge_height")) {
            double ar = msg.value("charge_aspect_ratio", 1.0);
            if (ar > 0.0) cp.height = 2.0 * cp.radius * ar;
        }
        cp.lx = msg.value("charge_lx", 0.1);
        cp.ly = msg.value("charge_ly", 0.1);
        cp.lz = msg.value("charge_lz", 0.1);
        cp.rot_x = msg.value("charge_rot_x", msg.value("rot_x", 0.0));
        cp.rot_y = msg.value("charge_rot_y", msg.value("rot_y", 0.0));
        cp.rot_z = msg.value("charge_rot_z", msg.value("rot_z", 0.0));

        MultiMat::MaterialSet matSet = parseMaterialSet(msg);

        double ambient_rho = msg.value("ambient_rho", 1.225648589);
        double ambient_p = msg.value("atm_pressure", 101325.0);

        local_solver_3d->setInitialCondition(cp, matSet, ambient_rho, ambient_p);

        if (msg.contains("detonator_x")) {
            double dx = msg.value("detonator_x", cp.x);
            double dy = msg.value("detonator_y", cp.y);
            double dz = msg.value("detonator_z", cp.z);
            local_solver_3d->setDetonatorLocation(dx, dy, dz);
        }

        auto map_bc_3d = [](const std::string& str) {
            if (str == "Transmitting" || str == "TRANSMISSIVE") return BCType3D::TRANSMISSIVE;
            if (str == "Terminate" || str == "OUTFLOW_RIEMANN") return BCType3D::OUTFLOW_RIEMANN;
            return BCType3D::REFLECTIVE;
        };
        local_solver_3d->setBoundaryConditions(
            map_bc_3d(msg.value("bc_x_min", "Reflecting")), map_bc_3d(msg.value("bc_x_max", "Transmitting")),
            map_bc_3d(msg.value("bc_y_min", "Reflecting")), map_bc_3d(msg.value("bc_y_max", "Transmitting")),
            map_bc_3d(msg.value("bc_z_min", "Reflecting")), map_bc_3d(msg.value("bc_z_max", "Transmitting"))
        );

        std::string stl_file = msg.value("stl_file", "");
        std::string geometry_hash = msg.value("geometry_hash", "");
        std::string voxel_method = msg.value("voxelization_method", "watertight_floodfill");

        // Progress reporting lambda
        int last_percent_logged = -10;
        auto progress_callback = [&](double progress) {
            int percent = static_cast<int>(progress * 100.0);
            // Send JSON progress report to stdout for the UI
            nlohmann::json prog_report;
            prog_report["type"] = "progress";
            prog_report["percent"] = percent;
            prog_report["scope"] = "3d";
            prog_report["mode"] = "INIT_3D";
            {
                std::lock_guard<std::mutex> lock(cout_mutex);
                std::cout << prog_report.dump() << std::endl;
            }

            // Also output periodic text telemetry system log in 10% steps
            if (percent - last_percent_logged >= 10 || percent == 100) {
                last_percent_logged = percent;
                std::string log_msg = "Voxelization progress: " + std::to_string(percent) + "%";
                emit_kernel_log("SYSTEM", log_msg, 0.0, "3d");
            }
        };

        if (sim3d_terminate.load()) {
            sim3d_init_in_progress = false;
            return;
        }

        if (msg.contains("primitives") && msg["primitives"].is_array() && !msg["primitives"].empty()) {
            local_solver_3d->setGeometryPrimitives(msg["primitives"], geometry_hash, voxel_method, &sim3d_terminate, progress_callback);
        } else {
            local_solver_3d->setGeometry(stl_file, geometry_hash, voxel_method, &sim3d_terminate, progress_callback);
        }

        if (sim3d_terminate.load()) {
            std::cout << "[INFO] 3D initialization terminated/cancelled." << std::endl;
            sim3d_init_in_progress = false;
            return;
        }

        std::cout << "[DEBUG] Voxelization finished. Generating obstacle mesh..." << std::endl;
        // Generate obstacle faces mesh and pass them to solver
        generateObstacleMesh(nx, ny, nz, cellSize, xmin, ymin, zmin);
        std::cout << "[DEBUG] Obstacle mesh generated with " << global_obstacle_faces.size() << " faces. Uploading..." << std::endl;
        local_solver_3d->uploadObstacleFaces(global_obstacle_faces);

        // Check if a REMAP command arrived while voxelization was running
        {
            std::lock_guard<std::mutex> lock(g_pending_remap_mutex);
            if (g_pending_remap.has_pending) {
                if (init_mode == "From1D" || init_mode == "From2D") {
                    std::cout << "[INFO] Applying queued pending " << g_pending_remap.type << " remap onto 3D solver..." << std::endl;
                    apply_remap_payload(g_pending_remap.msg, g_pending_remap.type, local_solver_3d.get(), nullptr, nullptr);
                } else {
                    std::cout << "[INFO] Ignoring queued pending remap because solver init_mode is '" << init_mode << "'." << std::endl;
                }
                g_pending_remap.has_pending = false;
            }
        }

        std::cout << "[DEBUG] Obstacle faces uploaded. Committing solver..." << std::endl;
        // Commit to global solver
        global_solver_3d = std::move(local_solver_3d);

        std::cout << "[DEBUG] Solver committed. Sending mesh to frontend..." << std::endl;
        // Broadcast obstacle mesh JSON to frontend
        sendObstacleMeshToFrontend(msg.value("modelId", ""));

        std::cout << "[DEBUG] Mesh sent. Initializing gauges..." << std::endl;
        init_gauges(msg);
        std::string precision_str = msg.value("precision", "single");
        std::string device_str = msg.value("device", "cpu");
        std::string engine_str = (is_multimat ? "Multi-Material JWL" : "Single-Material Ideal Gas");
        emit_kernel_log("SYSTEM", "3D Solver Initialized: " + engine_str + " on " + device_str + " (" + precision_str + ")", 0.0, "3d");
        emit_telemetry_3d(0.0, false);
    } catch (const std::exception& e) {
        std::cerr << "[ERROR] Exception in 3D solver initialization thread: " << e.what() << std::endl;
        emit_kernel_log("ERROR", std::string("Initialization failed: ") + e.what(), 0.0, "3d");
    } catch (...) {
        std::cerr << "[ERROR] Unknown exception in 3D solver initialization thread" << std::endl;
        emit_kernel_log("ERROR", "Initialization failed with unknown error", 0.0, "3d");
    }
    sim3d_init_in_progress = false;
}

void worker_3d_thread_func() {
    cudaSetDevice(global_cuda_device_index);
    emit_kernel_log("INFO", "3D worker thread started.", global_t3d, "3d");

    if (!global_solver_3d) {
        emit_kernel_log("ERROR", "3D worker: no solver available.", 0.0, "3d");
        sim3d_running = false;
        return;
    }
    try {
        auto last_telemetry_time = std::chrono::steady_clock::now();
    int initial_steps = global_target_steps_3d.load();
    int step_count = 0;
    double last_vtk_time = global_t3d;
    double last_dt = 1.0e-7;

    while (sim3d_running) {
        if (sim3d_terminate) break;

        if (sim3d_paused) {
            std::this_thread::sleep_for(std::chrono::milliseconds(30));
            continue;
        }

        bool done = false;
        if (global_exec_until_end_3d.load()) {
            if (global_solver_3d->is_terminated()) {
                emit_kernel_log("SYSTEM", "3D termination condition reached.", global_t3d, "3d");
                done = true;
            }
        } else {
            if (global_target_steps_3d.load() <= 0) done = true;
        }

        if (done) break;

        auto step_start = std::chrono::steady_clock::now();
        double dt = global_solver_3d->computeStepSize(global_cfl_3d.load());
        if (step_count == 0) {
            dt = std::min(dt, 1.0e-7);
        } else {
            dt = std::min(dt, 1.3 * last_dt);
        }
        global_solver_3d->step(dt);
        auto step_end = std::chrono::steady_clock::now();
        global_wallclock_3d = global_wallclock_3d.load() + std::chrono::duration<double>(step_end - step_start).count();
        global_dt_3d = dt;
        last_dt = dt;
        global_t3d += dt;

        global_step_3d++;
        step_count++;

        if (global_enable_gauges.load()) {
            record_gauges_3d(global_t3d);
        }

        if (global_enable_vtk.load()) {
            bool trigger_vtk = false;
            if (global_vtk_config.step_interval > 0 && (step_count % global_vtk_config.step_interval == 0)) {
                trigger_vtk = true;
            }
            if (global_vtk_config.time_interval > 0.0 && (global_t3d - last_vtk_time >= global_vtk_config.time_interval)) {
                trigger_vtk = true;
                last_vtk_time = global_t3d;
            }
            if (trigger_vtk) {
                write_vtk_outputs(step_count, global_t3d);
            }
        }

        if (!global_exec_until_end_3d.load()) {
            global_target_steps_3d--;
        }

        if (global_telemetry_enabled.load()) {
            auto now = std::chrono::steady_clock::now();
            auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
            int target_interval_ms = global_telemetry_interval_ms.load();
            bool should_emit = (target_interval_ms > 0) ? (elapsed_ms >= target_interval_ms) : true;
            if (should_emit) {
                emit_telemetry_3d(global_t3d, false, global_step_3d.load());
                last_telemetry_time = now;

                nlohmann::json progress_msg;
                progress_msg["type"] = "progress";
                progress_msg["sim_time"] = global_t3d;
                progress_msg["step"] = global_step_3d.load();
                progress_msg["scope"] = "3d";
                progress_msg["dt"] = global_dt_3d;

                if (global_exec_until_end_3d.load()) {
                    progress_msg["percent"] = 50;
                    progress_msg["mode"] = "EXEC_ALL_3D";
                } else {
                    initial_steps = std::max(initial_steps, step_count + global_target_steps_3d.load());
                    if (initial_steps > 0) {
                        int completed = initial_steps - global_target_steps_3d.load();
                        int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 100);
                        step_progress_3d = percent;
                        progress_msg["percent"] = percent;
                        progress_msg["completed"] = completed;
                        progress_msg["total"] = initial_steps;
                        progress_msg["mode"] = "STEP_3D";
                    }
                }
                std::lock_guard<std::mutex> lock(cout_mutex);
                std::cout << progress_msg.dump() << std::endl;
            }
        }
    }

    emit_telemetry_3d(global_t3d, global_solver_3d->is_terminated(), global_step_3d.load());

    nlohmann::json progress_msg;
    progress_msg["type"] = "progress";
    progress_msg["sim_time"] = global_t3d;
    progress_msg["step"] = global_step_3d.load();
    progress_msg["scope"] = "3d";
    progress_msg["percent"] = 100;
    progress_msg["mode"] = global_exec_until_end_3d.load() ? "EXEC_ALL_3D" : "STEP_3D";
    {
        std::lock_guard<std::mutex> lock(cout_mutex);
        std::cout << progress_msg.dump() << std::endl;
    }

    step_progress_3d = 100;
    emit_kernel_log("INFO", "3D worker thread execution cycle ended.", global_t3d, "3d", global_step_3d.load());

    write_gauge_files();
    write_vtk_outputs(step_count, global_t3d);

        sim3d_running = false;
        sim3d_paused = false;
        sim3d_terminate = false;
        global_target_steps_3d = 0;
        global_exec_until_end_3d = false;
    } catch (const std::exception& e) {
        emit_kernel_log("ERROR", std::string("3D worker thread error: ") + e.what(), global_t3d, "3d");
        sim3d_running = false;
        std::exit(1);
    } catch (...) {
        emit_kernel_log("ERROR", "3D worker thread error: unknown exception", global_t3d, "3d");
        sim3d_running = false;
        std::exit(1);
    }
}

void worker_2d_thread_func() {
    cudaSetDevice(global_cuda_device_index);
    emit_kernel_log("INFO", "2D worker thread started.", global_t2d, "2d");

    if (!has_solver_2d()) {
        emit_kernel_log("ERROR", "2D worker: no solver available.", 0.0, "2d");
        sim2d_running = false;
        return;
    }
    try {
        auto last_telemetry_time = std::chrono::steady_clock::now();
    int initial_steps = global_target_steps_2d.load();
    int step_count = 0;
    double last_vtk_time = global_t2d;
    double last_dt = 1.0e-7;

    while (sim2d_running) {
        if (sim2d_terminate) break;

        if (sim2d_paused) {
            std::this_thread::sleep_for(std::chrono::milliseconds(30));
            continue;
        }

        bool done = false;
        if (global_exec_until_end_2d.load()) {
            bool terminated = false;
            if (global_solver_2d_cuda) terminated = global_solver_2d_cuda->checkTerminationCondition();
            else if (global_solver_2d) terminated = global_solver_2d->checkTerminationCondition();
            if (terminated) {
                emit_kernel_log("SYSTEM", "Shock wave reached outflow boundary. Terminating simulation.", global_t2d, "2d");
                done = true;
            }
        } else {
            if (global_target_steps_2d.load() <= 0) done = true;
        }

        if (done) break;

        auto step_start = std::chrono::steady_clock::now();
        double dt = 0.0;
        if (global_solver_2d_cuda) {
            if (global_is_amr_2d) {
                int batch_size = 20;
                if (!global_exec_until_end_2d.load()) {
                    int remaining = global_target_steps_2d.load();
                    if (remaining > 0 && remaining < batch_size) batch_size = remaining;
                }
                dt = global_solver_2d_cuda->stepBatch(batch_size, global_cfl_2d.load());
                step_count += (batch_size - 1);
                global_step_2d += (batch_size - 1);
                if (!global_exec_until_end_2d.load()) {
                    global_target_steps_2d -= (batch_size - 1);
                }
            } else {
                double max_s = global_solver_2d_cuda->getMaxWaveSpeed();
                dt = global_cfl_2d.load() * std::min(global_solver_2d_cuda->getDr(), global_solver_2d_cuda->getDz()) / max_s;
                if (step_count == 0) {
                    dt = std::min(dt, 1.0e-7);
                } else {
                    dt = std::min(dt, 1.3 * last_dt);
                }
                global_solver_2d_cuda->step(dt);
            }
        } else if (global_solver_2d) {
            dt = global_solver_2d->computeStepSize(global_cfl_2d.load());
            if (step_count == 0) {
                dt = std::min(dt, 1.0e-7);
            } else {
                dt = std::min(dt, 1.3 * last_dt);
            }
            global_solver_2d->step(dt);
        }
        auto step_end = std::chrono::steady_clock::now();
        global_wallclock_2d = global_wallclock_2d.load() + std::chrono::duration<double>(step_end - step_start).count();
        global_dt_2d = dt;
        last_dt = dt;
        global_t2d += dt;

        global_step_2d++;
        step_count++;
        record_gauges_2d(global_t2d);

        {
            bool trigger_vtk = false;
            if (global_vtk_config.step_interval > 0 && (step_count % global_vtk_config.step_interval == 0)) {
                trigger_vtk = true;
            }
            if (global_vtk_config.time_interval > 0.0 && (global_t2d - last_vtk_time >= global_vtk_config.time_interval)) {
                trigger_vtk = true;
                last_vtk_time = global_t2d;
            }
            if (trigger_vtk) {
                write_vtk_outputs(step_count, global_t2d);
            }
        }

        if (!global_exec_until_end_2d.load()) {
            global_target_steps_2d--;
        }

        auto now = std::chrono::steady_clock::now();
        auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
        int target_interval_ms = global_telemetry_interval_ms.load();
        bool should_emit = (target_interval_ms > 0) ? (elapsed_ms >= target_interval_ms) : true;
        if (should_emit) {
            emit_telemetry_2d(global_t2d, false, global_step_2d.load());
            last_telemetry_time = now;

            nlohmann::json progress_msg;
            progress_msg["type"] = "progress";
            progress_msg["sim_time"] = global_t2d;
            progress_msg["step"] = global_step_2d.load();
            progress_msg["scope"] = "2d";
            progress_msg["dt"] = global_dt_2d;

            if (global_exec_until_end_2d.load()) {
                progress_msg["percent"] = 50; // Indeterminate
                progress_msg["mode"] = "EXEC_ALL_2D";
            } else {
                initial_steps = std::max(initial_steps, step_count + global_target_steps_2d.load());
                if (initial_steps > 0) {
                    int completed = initial_steps - global_target_steps_2d.load();
                    int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 100);
                    step_progress_2d = percent;
                    progress_msg["percent"] = percent;
                    progress_msg["completed"] = completed;
                    progress_msg["total"] = initial_steps;
                    progress_msg["mode"] = "STEP_2D";
                }
            }
            std::lock_guard<std::mutex> lock(cout_mutex);
            std::cout << progress_msg.dump() << std::endl;
        }
    }

    emit_telemetry_2d(global_t2d, false, global_step_2d.load());
    
    // Emit final 100% progress packet to transition frontend state to paused/complete
    nlohmann::json progress_msg;
    progress_msg["type"] = "progress";
    progress_msg["sim_time"] = global_t2d;
    progress_msg["step"] = global_step_2d.load();
    progress_msg["scope"] = "2d";
    progress_msg["percent"] = 100;
    progress_msg["mode"] = global_exec_until_end_2d.load() ? "EXEC_ALL_2D" : "STEP_2D";
    {
        std::lock_guard<std::mutex> lock(cout_mutex);
        std::cout << progress_msg.dump() << std::endl;
    }
    
    step_progress_2d = 100;
    emit_kernel_log("INFO", "2D worker thread execution cycle ended.", global_t2d, "2d", global_step_2d.load());
    write_gauge_files();
    write_vtk_outputs(step_count, global_t2d);
        sim2d_running = false;
        sim2d_paused = false;
        sim2d_terminate = false;
        global_target_steps_2d = 0;
        global_exec_until_end_2d = false;
    } catch (const std::exception& e) {
        emit_kernel_log("ERROR", std::string("2D worker thread error: ") + e.what(), global_t2d, "2d");
        sim2d_running = false;
        std::exit(1);
    } catch (...) {
        emit_kernel_log("ERROR", "2D worker thread error: unknown exception", global_t2d, "2d");
        sim2d_running = false;
        std::exit(1);
    }
}

std::atomic<bool> sim_mpm_running{false};
std::atomic<bool> sim_mpm_paused{false};
std::atomic<bool> sim_mpm_terminate{false};
std::atomic<bool> global_exec_until_end_mpm{false};
std::atomic<int> global_target_steps_mpm{0};
std::atomic<float> global_cfl_mpm{0.3f};
std::atomic<double> global_refresh_rate_mpm{0.0};

void worker_mpm_2d_thread_func() {
    try {
        int step_count = 0;
        int initial_steps = 0;
        auto last_telemetry_time = std::chrono::steady_clock::now();
        emit_kernel_log("INFO", "2D MPM asynchronous worker thread started.", 0.0, "mpm_2d", 0);

    while (!sim_mpm_terminate.load()) {
        if (sim_mpm_paused.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            continue;
        }

        bool done = false;
        if (!global_exec_until_end_mpm.load()) {
            if (global_target_steps_mpm.load() <= 0) done = true;
        }

        if (done) break;

        if (global_solver_mpm_2d) {
            float cfl = global_cfl_mpm.load();
            global_solver_mpm_2d->step(cfl);
            step_count++;

            if (!global_exec_until_end_mpm.load()) {
                global_target_steps_mpm--;
            }

            auto now = std::chrono::steady_clock::now();
            auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
            int target_interval_ms = (global_telemetry_interval_ms.load() > 0) ? global_telemetry_interval_ms.load() : static_cast<int>(global_refresh_rate_mpm.load() * 1000.0);
            bool should_emit = (target_interval_ms > 0) ? (elapsed_ms >= target_interval_ms) : true;

            if (should_emit || done) {
                double sim_time = global_solver_mpm_2d->getSimTime();
                int current_step = global_solver_mpm_2d->getStepCount();

                emit_telemetry_mpm_2d(sim_time, false, current_step);
                last_telemetry_time = now;

                char log_buf[256];
                snprintf(log_buf, sizeof(log_buf),
                         "Step %d | Time = %.4e s | dt = %.2e s | CFL = %.2f | v_max = %.1f m/s",
                         current_step,
                         sim_time,
                         global_solver_mpm_2d->getLastDt(),
                         global_solver_mpm_2d->getLastCFL(),
                         global_solver_mpm_2d->getMaxVelocity());
                emit_kernel_log("SYSTEM", log_buf, sim_time, "mpm_2d", current_step);

                nlohmann::json progress_msg;
                progress_msg["type"] = "progress";
                progress_msg["sim_time"] = sim_time;
                progress_msg["step"] = current_step;
                progress_msg["scope"] = "mpm_2d";
                progress_msg["dt"] = global_solver_mpm_2d->getLastDt();

                if (global_exec_until_end_mpm.load()) {
                    progress_msg["percent"] = 50; // Indeterminate while running continuously
                    progress_msg["mode"] = "EXEC_ALL_MPM";
                } else {
                    initial_steps = std::max(initial_steps, step_count + global_target_steps_mpm.load());
                    if (initial_steps > 0) {
                        int completed = initial_steps - global_target_steps_mpm.load();
                        int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 99);
                        progress_msg["percent"] = percent;
                        progress_msg["completed"] = completed;
                        progress_msg["total"] = initial_steps;
                        progress_msg["mode"] = "STEP_MPM";
                    }
                }

                {
                    std::lock_guard<std::mutex> lock(cout_mutex);
                    std::cout << progress_msg.dump() << std::endl;
                }
            }

            // removed sleep
        } else {
            break;
        }
    }

    double final_sim_time = global_solver_mpm_2d ? global_solver_mpm_2d->getSimTime() : 0.0;
    int final_step = global_solver_mpm_2d ? global_solver_mpm_2d->getStepCount() : 0;
    emit_telemetry_mpm_2d(final_sim_time, false, final_step);

    nlohmann::json progress_msg;
    progress_msg["type"] = "progress";
    progress_msg["sim_time"] = final_sim_time;
    progress_msg["step"] = final_step;
    progress_msg["scope"] = "mpm_2d";
    progress_msg["percent"] = 100;
    progress_msg["mode"] = global_exec_until_end_mpm.load() ? "EXEC_ALL_MPM" : "STEP_MPM";
    {
        std::lock_guard<std::mutex> lock(cout_mutex);
        std::cout << progress_msg.dump() << std::endl;
    }

        sim_mpm_running = false;
        sim_mpm_paused = false;
        sim_mpm_terminate = false;
        global_target_steps_mpm = 0;
        global_exec_until_end_mpm = false;
    } catch (const std::exception& e) {
        emit_kernel_log("ERROR", std::string("2D MPM worker thread error: ") + e.what(), 0.0, "mpm_2d");
        sim_mpm_running = false;
        std::exit(1);
    } catch (...) {
        emit_kernel_log("ERROR", "2D MPM worker thread error: unknown exception", 0.0, "mpm_2d");
        sim_mpm_running = false;
        std::exit(1);
    }
}

void worker_mpm_3d_thread_func() {
    cudaSetDevice(global_cuda_device_index);
    try {
        int step_count = 0;
        int initial_steps = global_target_steps_mpm_3d.load();
        auto last_telemetry_time = std::chrono::steady_clock::now();

    double start_time = 0.0;
    if (global_solver_mpm_3d_cuda) start_time = global_solver_mpm_3d_cuda->getSimTime();
    else if (global_solver_mpm_3d) start_time = global_solver_mpm_3d->getSimTime();

    emit_kernel_log("INFO", "3D MPM asynchronous worker thread started.", start_time, "mpm_3d");

    while (sim_mpm_3d_running.load()) {
        if (sim_mpm_3d_terminate.load()) break;

        if (sim_mpm_3d_paused.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(30));
            continue;
        }

        bool done = false;
        if (!global_exec_until_end_mpm_3d.load()) {
            if (global_target_steps_mpm_3d.load() <= 0) done = true;
        }

        if (done) break;

        if (global_solver_mpm_3d_cuda) {
            float cfl = global_cfl_mpm_3d.load();
            global_solver_mpm_3d_cuda->step(cfl);
            step_count++;

            if (!global_exec_until_end_mpm_3d.load()) {
                global_target_steps_mpm_3d--;
            }

            auto now = std::chrono::steady_clock::now();
            auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
            int target_interval_ms = (global_telemetry_interval_ms.load() > 0) ? global_telemetry_interval_ms.load() : static_cast<int>(global_refresh_rate_mpm_3d.load() * 1000.0);
            bool should_emit = (target_interval_ms > 0) ? (elapsed_ms >= target_interval_ms) : true;

            if (should_emit || done) {
                double sim_time = global_solver_mpm_3d_cuda->getSimTime();
                int current_step = global_solver_mpm_3d_cuda->getStepCount();

                emit_telemetry_mpm_3d(sim_time, false, current_step);
                last_telemetry_time = now;

                char log_buf[256];
                snprintf(log_buf, sizeof(log_buf),
                         "Step %d | Time = %.4e s | dt = %.2e s | CFL = %.2f | v_max = %.1f m/s | Particles = %zu",
                         current_step,
                         sim_time,
                         global_solver_mpm_3d_cuda->getLastDt(),
                         global_solver_mpm_3d_cuda->getLastCFL(),
                         global_solver_mpm_3d_cuda->getMaxVelocity(),
                         global_solver_mpm_3d_cuda->getParticles().size());
                emit_kernel_log("SYSTEM", log_buf, sim_time, "mpm_3d", current_step);

                nlohmann::json progress_msg;
                progress_msg["type"] = "progress";
                progress_msg["sim_time"] = sim_time;
                progress_msg["step"] = current_step;
                progress_msg["scope"] = "mpm_3d";
                progress_msg["dt"] = global_solver_mpm_3d_cuda->getLastDt();

                if (global_exec_until_end_mpm_3d.load()) {
                    progress_msg["percent"] = 50;
                    progress_msg["mode"] = "EXEC_ALL_MPM_3D";
                } else {
                    initial_steps = std::max(initial_steps, step_count + global_target_steps_mpm_3d.load());
                    if (initial_steps > 0) {
                        int completed = initial_steps - global_target_steps_mpm_3d.load();
                        int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 99);
                        progress_msg["percent"] = percent;
                        progress_msg["completed"] = completed;
                        progress_msg["total"] = initial_steps;
                        progress_msg["mode"] = "STEP_MPM_3D";
                    }
                }

                {
                    std::lock_guard<std::mutex> lock(cout_mutex);
                    std::cout << progress_msg.dump() << std::endl;
                }
            }
        } else if (global_solver_mpm_3d) {
            float cfl = global_cfl_mpm_3d.load();
            global_solver_mpm_3d->step(cfl);
            step_count++;

            if (!global_exec_until_end_mpm_3d.load()) {
                global_target_steps_mpm_3d--;
            }

            auto now = std::chrono::steady_clock::now();
            auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
            int target_interval_ms = (global_telemetry_interval_ms.load() > 0) ? global_telemetry_interval_ms.load() : static_cast<int>(global_refresh_rate_mpm_3d.load() * 1000.0);
            bool should_emit = (target_interval_ms > 0) ? (elapsed_ms >= target_interval_ms) : true;

            if (should_emit || done) {
                double sim_time = global_solver_mpm_3d->getSimTime();
                int current_step = global_solver_mpm_3d->getStepCount();

                emit_telemetry_mpm_3d(sim_time, false, current_step);
                last_telemetry_time = now;

                char log_buf[256];
                snprintf(log_buf, sizeof(log_buf),
                         "Step %d | Time = %.4e s | dt = %.2e s | CFL = %.2f | v_max = %.1f m/s | Particles = %zu",
                         current_step,
                         sim_time,
                         global_solver_mpm_3d->getLastDt(),
                         global_solver_mpm_3d->getLastCFL(),
                         global_solver_mpm_3d->getMaxVelocity(),
                         global_solver_mpm_3d->getParticles().size());
                emit_kernel_log("SYSTEM", log_buf, sim_time, "mpm_3d", current_step);

                nlohmann::json progress_msg;
                progress_msg["type"] = "progress";
                progress_msg["sim_time"] = sim_time;
                progress_msg["step"] = current_step;
                progress_msg["scope"] = "mpm_3d";
                progress_msg["dt"] = global_solver_mpm_3d->getLastDt();

                if (global_exec_until_end_mpm_3d.load()) {
                    progress_msg["percent"] = 50;
                    progress_msg["mode"] = "EXEC_ALL_MPM_3D";
                } else {
                    initial_steps = std::max(initial_steps, step_count + global_target_steps_mpm_3d.load());
                    if (initial_steps > 0) {
                        int completed = initial_steps - global_target_steps_mpm_3d.load();
                        int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 99);
                        progress_msg["percent"] = percent;
                        progress_msg["completed"] = completed;
                        progress_msg["total"] = initial_steps;
                        progress_msg["mode"] = "STEP_MPM_3D";
                    }
                }

                {
                    std::lock_guard<std::mutex> lock(cout_mutex);
                    std::cout << progress_msg.dump() << std::endl;
                }
            }
        } else {
            break;
        }
    }

    double final_sim_time = 0.0;
    if (global_solver_mpm_3d_cuda) final_sim_time = global_solver_mpm_3d_cuda->getSimTime();
    else if (global_solver_mpm_3d) final_sim_time = global_solver_mpm_3d->getSimTime();

    int final_step = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getStepCount() : (global_solver_mpm_3d ? global_solver_mpm_3d->getStepCount() : 0);
    emit_telemetry_mpm_3d(final_sim_time, false, final_step);

    nlohmann::json progress_msg;
    progress_msg["type"] = "progress";
    progress_msg["sim_time"] = final_sim_time;
    progress_msg["step"] = final_step;
    progress_msg["scope"] = "mpm_3d";
    progress_msg["percent"] = 100;
    progress_msg["mode"] = global_exec_until_end_mpm_3d.load() ? "EXEC_ALL_MPM_3D" : "STEP_MPM_3D";
    {
        std::lock_guard<std::mutex> lock(cout_mutex);
        std::cout << progress_msg.dump() << std::endl;
    }

        sim_mpm_3d_running = false;
        sim_mpm_3d_paused = false;
        sim_mpm_3d_terminate = false;
        global_target_steps_mpm_3d = 0;
        global_exec_until_end_mpm_3d = false;
    } catch (const std::exception& e) {
        emit_kernel_log("ERROR", std::string("3D MPM worker thread error: ") + e.what(), 0.0, "mpm_3d");
        sim_mpm_3d_running = false;
        std::exit(1);
    } catch (...) {
        emit_kernel_log("ERROR", "3D MPM worker thread error: unknown exception", 0.0, "mpm_3d");
        sim_mpm_3d_running = false;
        std::exit(1);
    }
}

void worker_fem_3d_thread_func() {
    try {
        int step_count = 0;
        int initial_steps = global_target_steps_fem_3d.load();
        auto last_telemetry_time = std::chrono::steady_clock::now();
        emit_kernel_log("INFO", "3D FEM asynchronous worker thread started.", 0.0, "fem_3d");

        while (sim_fem_3d_running.load()) {
            if (sim_fem_3d_terminate.load()) break;

            if (sim_fem_3d_paused.load()) {
                std::this_thread::sleep_for(std::chrono::milliseconds(30));
                continue;
            }

            bool done = false;
            if (!global_exec_until_end_fem_3d.load()) {
                if (global_target_steps_fem_3d.load() <= 0) done = true;
            }

            if (done) break;

            std::string m_id = global_model_id.empty() ? "default_fem" : global_model_id;
            float cfl = global_cfl_fem_3d.load();
            double sim_time = 0.0;
            double last_dt = 0.0;
            int current_step = 0;
            double max_v = 0.0;
            double max_vm = 0.0;
            double max_ep = 0.0;
            size_t n_nodes = 0;
            size_t n_elems = 0;
            double e_int = 0.0;

            if (global_fem_solvers_cuda_float.count(m_id) && global_fem_solvers_cuda_float[m_id]) {
                auto* fem = global_fem_solvers_cuda_float[m_id].get();
                fem->step(cfl);
                sim_time = static_cast<double>(fem->getSimTime());
                last_dt = static_cast<double>(fem->getLastDt());
            } else if (global_fem_solvers_cuda_double.count(m_id) && global_fem_solvers_cuda_double[m_id]) {
                auto* fem = global_fem_solvers_cuda_double[m_id].get();
                fem->step(static_cast<double>(cfl));
                sim_time = fem->getSimTime();
                last_dt = fem->getLastDt();
            } else if (global_fem_solvers_float.count(m_id) && global_fem_solvers_float[m_id]) {
                auto* fem = global_fem_solvers_float[m_id].get();
                fem->step(cfl);
                sim_time = static_cast<double>(fem->getSimTime());
                last_dt = static_cast<double>(fem->getLastDt());
            } else if (global_fem_solvers_double.count(m_id) && global_fem_solvers_double[m_id]) {
                auto* fem = global_fem_solvers_double[m_id].get();
                fem->step(static_cast<double>(cfl));
                sim_time = fem->getSimTime();
                last_dt = fem->getLastDt();
            } else if (!global_fem_solvers_cuda_float.empty()) {
                auto* fem = global_fem_solvers_cuda_float.begin()->second.get();
                fem->step(cfl);
                sim_time = static_cast<double>(fem->getSimTime());
                last_dt = static_cast<double>(fem->getLastDt());
            } else if (!global_fem_solvers_cuda_double.empty()) {
                auto* fem = global_fem_solvers_cuda_double.begin()->second.get();
                fem->step(static_cast<double>(cfl));
                sim_time = fem->getSimTime();
                last_dt = fem->getLastDt();
            } else if (!global_fem_solvers_float.empty()) {
                auto* fem = global_fem_solvers_float.begin()->second.get();
                fem->step(cfl);
                sim_time = static_cast<double>(fem->getSimTime());
                last_dt = static_cast<double>(fem->getLastDt());
            } else if (!global_fem_solvers_double.empty()) {
                auto* fem = global_fem_solvers_double.begin()->second.get();
                fem->step(static_cast<double>(cfl));
                sim_time = fem->getSimTime();
                last_dt = fem->getLastDt();
            } else {
                break;
            }

            step_count++;
            if (!global_exec_until_end_fem_3d.load()) {
                global_target_steps_fem_3d--;
            }

            auto now = std::chrono::steady_clock::now();
            auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
            int target_interval_ms = (global_telemetry_interval_ms.load() > 0) ? global_telemetry_interval_ms.load() : static_cast<int>(global_refresh_rate_fem_3d.load() * 1000.0);
            bool should_emit = (target_interval_ms > 0) ? (elapsed_ms >= target_interval_ms) : true;

            if (should_emit || done) {
                if (global_fem_solvers_cuda_float.count(m_id) && global_fem_solvers_cuda_float[m_id]) {
                    auto* fem = global_fem_solvers_cuda_float[m_id].get();
                    current_step = fem->getStepCount();
                    max_v = static_cast<double>(fem->getMaxVelocity());
                    max_vm = static_cast<double>(fem->getMaxVonMisesStress());
                    max_ep = static_cast<double>(fem->getMaxPlasticStrain());
                    n_nodes = fem->getNodeCount();
                    n_elems = fem->getElementCount();
                    e_int = static_cast<double>(fem->getEnergyTracker().E_int);
                } else if (global_fem_solvers_cuda_double.count(m_id) && global_fem_solvers_cuda_double[m_id]) {
                    auto* fem = global_fem_solvers_cuda_double[m_id].get();
                    current_step = fem->getStepCount();
                    max_v = fem->getMaxVelocity();
                    max_vm = fem->getMaxVonMisesStress();
                    max_ep = fem->getMaxPlasticStrain();
                    n_nodes = fem->getNodeCount();
                    n_elems = fem->getElementCount();
                    e_int = fem->getEnergyTracker().E_int;
                } else if (global_fem_solvers_float.count(m_id) && global_fem_solvers_float[m_id]) {
                    auto* fem = global_fem_solvers_float[m_id].get();
                    current_step = fem->getStepCount();
                    max_v = static_cast<double>(fem->getMaxVelocity());
                    max_vm = static_cast<double>(fem->getMaxVonMisesStress());
                    max_ep = static_cast<double>(fem->getMaxPlasticStrain());
                    n_nodes = fem->getNodes().size();
                    n_elems = fem->getElements().size();
                    e_int = static_cast<double>(fem->getEnergyTracker().E_int);
                } else if (global_fem_solvers_double.count(m_id) && global_fem_solvers_double[m_id]) {
                    auto* fem = global_fem_solvers_double[m_id].get();
                    current_step = fem->getStepCount();
                    max_v = fem->getMaxVelocity();
                    max_vm = fem->getMaxVonMisesStress();
                    max_ep = fem->getMaxPlasticStrain();
                    n_nodes = fem->getNodes().size();
                    n_elems = fem->getElements().size();
                    e_int = fem->getEnergyTracker().E_int;
                } else if (!global_fem_solvers_cuda_float.empty()) {
                    auto* fem = global_fem_solvers_cuda_float.begin()->second.get();
                    current_step = fem->getStepCount();
                    max_v = static_cast<double>(fem->getMaxVelocity());
                    max_vm = static_cast<double>(fem->getMaxVonMisesStress());
                    max_ep = static_cast<double>(fem->getMaxPlasticStrain());
                    n_nodes = fem->getNodeCount();
                    n_elems = fem->getElementCount();
                    e_int = static_cast<double>(fem->getEnergyTracker().E_int);
                } else if (!global_fem_solvers_cuda_double.empty()) {
                    auto* fem = global_fem_solvers_cuda_double.begin()->second.get();
                    current_step = fem->getStepCount();
                    max_v = fem->getMaxVelocity();
                    max_vm = fem->getMaxVonMisesStress();
                    max_ep = fem->getMaxPlasticStrain();
                    n_nodes = fem->getNodeCount();
                    n_elems = fem->getElementCount();
                    e_int = fem->getEnergyTracker().E_int;
                } else if (!global_fem_solvers_float.empty()) {
                    auto* fem = global_fem_solvers_float.begin()->second.get();
                    current_step = fem->getStepCount();
                    max_v = static_cast<double>(fem->getMaxVelocity());
                    max_vm = static_cast<double>(fem->getMaxVonMisesStress());
                    max_ep = static_cast<double>(fem->getMaxPlasticStrain());
                    n_nodes = fem->getNodes().size();
                    n_elems = fem->getElements().size();
                    e_int = static_cast<double>(fem->getEnergyTracker().E_int);
                } else if (!global_fem_solvers_double.empty()) {
                    auto* fem = global_fem_solvers_double.begin()->second.get();
                    current_step = fem->getStepCount();
                    max_v = fem->getMaxVelocity();
                    max_vm = fem->getMaxVonMisesStress();
                    max_ep = fem->getMaxPlasticStrain();
                    n_nodes = fem->getNodes().size();
                    n_elems = fem->getElements().size();
                    e_int = fem->getEnergyTracker().E_int;
                }

                emit_telemetry_fem_3d(sim_time, false, current_step);
                last_telemetry_time = now;

                char log_buf[512];
                snprintf(log_buf, sizeof(log_buf),
                         "Step %d | Time = %.4e s | dt = %.2e s | CFL = %.2f | v_max = %.1f m/s | sig_max = %.2e Pa | ep_max = %.3f | E_int = %.2e J | Nodes = %zu | Hex8 = %zu",
                         current_step,
                         sim_time,
                         last_dt,
                         cfl,
                         max_v,
                         max_vm,
                         max_ep,
                         e_int,
                         n_nodes,
                         n_elems);
                emit_kernel_log("SYSTEM", log_buf, sim_time, "fem_3d", current_step);

                nlohmann::json progress_msg;
                progress_msg["type"] = "progress";
                progress_msg["sim_time"] = sim_time;
                progress_msg["step"] = current_step;
                progress_msg["dt"] = last_dt;
                progress_msg["scope"] = "fem_3d";
                if (global_exec_until_end_fem_3d.load()) {
                    progress_msg["percent"] = 50;
                    progress_msg["mode"] = "EXEC_ALL_FEM_3D";
                } else {
                    initial_steps = std::max(initial_steps, step_count + global_target_steps_fem_3d.load());
                    if (initial_steps > 0) {
                        int completed = initial_steps - global_target_steps_fem_3d.load();
                        int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 99);
                        progress_msg["percent"] = percent;
                        progress_msg["completed"] = completed;
                        progress_msg["total"] = initial_steps;
                        progress_msg["mode"] = "STEP_FEM_3D";
                    }
                }
                {
                    std::lock_guard<std::mutex> lock(cout_mutex);
                    std::cout << progress_msg.dump() << std::endl;
                }
            }
        }

        double final_sim_time = 0.0;
        int final_step = 0;
        std::string m_id = global_model_id.empty() ? "default_fem" : global_model_id;
        if (global_fem_solvers_cuda_float.count(m_id) && global_fem_solvers_cuda_float[m_id]) {
            final_step = global_fem_solvers_cuda_float[m_id]->getStepCount();
        } else if (global_fem_solvers_cuda_double.count(m_id) && global_fem_solvers_cuda_double[m_id]) {
            final_step = global_fem_solvers_cuda_double[m_id]->getStepCount();
        } else if (global_fem_solvers_float.count(m_id) && global_fem_solvers_float[m_id]) {
            final_step = global_fem_solvers_float[m_id]->getStepCount();
        } else if (global_fem_solvers_double.count(m_id) && global_fem_solvers_double[m_id]) {
            final_step = global_fem_solvers_double[m_id]->getStepCount();
        }

        if (global_fem_solvers_float.count(m_id) && global_fem_solvers_float[m_id]) {
            final_sim_time = static_cast<double>(global_fem_solvers_float[m_id]->getSimTime());
        } else if (global_fem_solvers_double.count(m_id) && global_fem_solvers_double[m_id]) {
            final_sim_time = global_fem_solvers_double[m_id]->getSimTime();
        } else if (!global_fem_solvers_float.empty()) {
            final_sim_time = static_cast<double>(global_fem_solvers_float.begin()->second->getSimTime());
        } else if (!global_fem_solvers_double.empty()) {
            final_sim_time = global_fem_solvers_double.begin()->second->getSimTime();
        }

        emit_telemetry_fem_3d(final_sim_time, false, final_step);

        emit_kernel_log("INFO", "3D FEM worker thread execution cycle ended.", final_sim_time, "fem_3d", final_step);

        nlohmann::json progress_msg;
        progress_msg["type"] = "progress";
        progress_msg["sim_time"] = final_sim_time;
        progress_msg["step"] = final_step;
        progress_msg["scope"] = "fem_3d";
        progress_msg["percent"] = 100;
        progress_msg["mode"] = global_exec_until_end_fem_3d.load() ? "EXEC_ALL_FEM_3D" : "STEP_FEM_3D";
        {
            std::lock_guard<std::mutex> lock(cout_mutex);
            std::cout << progress_msg.dump() << std::endl;
        }

        sim_fem_3d_running = false;
        sim_fem_3d_paused = false;
        sim_fem_3d_terminate = false;
        global_target_steps_fem_3d = 0;
        global_exec_until_end_fem_3d = false;
    } catch (const std::exception& e) {
        emit_kernel_log("ERROR", std::string("3D FEM worker thread error: ") + e.what(), 0.0, "fem_3d");
        sim_fem_3d_running = false;
    } catch (...) {
        emit_kernel_log("ERROR", "3D FEM worker thread error: unknown exception", 0.0, "fem_3d");
        sim_fem_3d_running = false;
    }
}

std::atomic<bool> sim_fsi_running{false};
std::atomic<bool> sim_fsi_paused{false};
std::atomic<bool> sim_fsi_terminate{false};
std::atomic<bool> global_exec_until_end_fsi{false};
std::atomic<int> global_target_steps_fsi{0};
std::atomic<float> global_cfl_fsi{0.35f};

std::atomic<bool> sim_fsi_3d_running{false};
std::atomic<bool> sim_fsi_3d_paused{false};
std::atomic<bool> sim_fsi_3d_terminate{false};
std::atomic<bool> global_exec_until_end_fsi_3d{false};
std::atomic<int> global_target_steps_fsi_3d{0};
std::atomic<float> global_cfl_fsi_3d{0.35f};

void worker_fsi_2d_thread_func() {
    try {
        int step_count = 0;
        int initial_steps = 0;
        auto last_telemetry_time = std::chrono::steady_clock::now();
        double last_dt = 1.0e-7;

    while (!sim_fsi_terminate.load()) {
        if (sim_fsi_paused.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            continue;
        }

        bool done = false;
        if (!global_exec_until_end_fsi.load()) {
            if (global_target_steps_fsi.load() <= 0) done = true;
        }

        if (done) break;

        if (global_solver_mpm_2d || has_solver_2d()) {
            float cfl = global_cfl_fsi.load();

            // Synchronized 2-Way FSI Coupling exchange
            if (global_solver_mpm_2d && has_solver_2d()) {
                // 1. P2G scatter to populate MPM background grid
                global_solver_mpm_2d->particleToGrid();

                // 2. Fetch fluid states from 2D CFD solver
                std::vector<State2D> cfd_states;
                int nr = 0, nz = 0;
                double dr = 0.0, dz = 0.0;
                if (global_solver_2d_cuda) {
                    cfd_states = global_solver_2d_cuda->getStates();
                    nr = global_solver_2d_cuda->getNr();
                    nz = global_solver_2d_cuda->getNz();
                    dr = global_solver_2d_cuda->getDr();
                    dz = global_solver_2d_cuda->getDz();
                } else if (global_solver_2d) {
                    cfd_states = global_solver_2d->getStates();
                    nr = global_solver_2d->getNr();
                    nz = global_solver_2d->getNz();
                    dr = global_solver_2d->getDr();
                    dz = global_solver_2d->getDz();
                }

                if (!cfd_states.empty() && nr > 0 && nz > 0) {
                    auto& mpm_grid = global_solver_mpm_2d->getGrid();
                    int mpm_nx = global_solver_mpm_2d->getNx();
                    int mpm_ny = global_solver_mpm_2d->getNy();

                    std::vector<uint8_t> solid_mask(nr * nz, 0);
                    std::vector<double> solid_vel(2 * nr * nz, 0.0);

                    // Pass 1: Build solid_mask & solid_vel from MPM grid nodes with temporal hysteresis
                    static std::vector<uint8_t> prev_solid_mask;
                    if (prev_solid_mask.size() != static_cast<size_t>(nr * nz)) {
                        prev_solid_mask.assign(nr * nz, 0);
                    }

                    for (int i = 0; i < nr; ++i) {
                        for (int j = 0; j < nz; ++j) {
                            if (i < mpm_nx && j < mpm_ny) {
                                int mpm_idx = i * mpm_ny + j;
                                const auto& m_node = mpm_grid[mpm_idx];
                                int cfd_idx = i * nz + j;

                                // Hysteresis threshold: turn solid at mass > 1.0e-8, stay solid until mass < 2.0e-9
                                bool was_solid = (prev_solid_mask[cfd_idx] != 0);
                                float threshold = was_solid ? 2.0e-9f : 1.0e-14f;

                                if (m_node.m > threshold) {
                                    solid_mask[cfd_idx] = 1;
                                    solid_vel[2 * cfd_idx + 0] = m_node.v[0];
                                    solid_vel[2 * cfd_idx + 1] = m_node.v[1];
                                }
                            }
                        }
                    }
                    prev_solid_mask = solid_mask;

                    // Pass 2: Calculate surface fluid pressure forces on MPM boundary grid nodes
                    for (int i = 0; i < nr; ++i) {
                        for (int j = 0; j < nz; ++j) {
                            if (i < mpm_nx && j < mpm_ny) {
                                int mpm_idx = i * mpm_ny + j;
                                auto& m_node = mpm_grid[mpm_idx];
                                int cfd_idx = i * nz + j;

                                if (m_node.m > 1.0e-14f) {
                                    // Check if node is on the surface (adjacent to fluid)
                                    bool is_surface = false;
                                    double f_r = 0.0;
                                    double f_z = 0.0;

                                    if (i > 0 && solid_mask[(i - 1) * nz + j] == 0) {
                                        f_r += cfd_states[(i - 1) * nz + j].p;
                                        is_surface = true;
                                    }
                                    if (i < nr - 1 && solid_mask[(i + 1) * nz + j] == 0) {
                                        f_r -= cfd_states[(i + 1) * nz + j].p;
                                        is_surface = true;
                                    }
                                    if (j > 0 && solid_mask[i * nz + (j - 1)] == 0) {
                                        f_z += cfd_states[i * nz + (j - 1)].p;
                                        is_surface = true;
                                    }
                                    if (j < nz - 1 && solid_mask[i * nz + (j + 1)] == 0) {
                                        f_z -= cfd_states[i * nz + (j + 1)].p;
                                        is_surface = true;
                                    }

                                    if (is_surface) {
                                        m_node.f_ext[0] = static_cast<float>(f_r * dz);
                                        m_node.f_ext[1] = static_cast<float>(f_z * dr);
                                    } else {
                                        m_node.f_ext[0] = 0.0f;
                                        m_node.f_ext[1] = 0.0f;
                                    }
                                }
                            }
                        }
                    }

                    if (global_solver_2d_cuda) {
                        global_solver_2d_cuda->setSolidMask(solid_mask.data());
                        global_solver_2d_cuda->setSolidVelocities(solid_vel.data());
                    } else if (global_solver_2d) {
                        global_solver_2d->setSolidMask(solid_mask.data());
                        global_solver_2d->setSolidVelocities(solid_vel.data());
                    }
                }
            }

            // Calculate coupled CFL stability timestep
            float dt_mpm = global_solver_mpm_2d ? global_solver_mpm_2d->computeStepSize(cfl) : 1.0f;
            double dt_cfd = 1.0;
            if (global_solver_2d_cuda) {
                double c_max = global_solver_2d_cuda->getMaxWaveSpeed();
                double min_h = std::min(global_solver_2d_cuda->getDr(), global_solver_2d_cuda->getDz());
                dt_cfd = cfl * min_h / (c_max > 1e-6 ? c_max : 340.0);
            } else if (global_solver_2d) {
                dt_cfd = global_solver_2d->computeStepSize(cfl);
            }

            double dt_common = std::min(static_cast<double>(dt_mpm), dt_cfd);
            if (step_count == 0) {
                dt_common = std::min(dt_common, 1.0e-7);
            } else {
                dt_common = std::min(dt_common, 1.3 * last_dt);
            }
            dt_common = std::clamp(dt_common, 1.0e-11, 1.0e-4);
            global_dt_2d = dt_common;
            last_dt = dt_common;

            if (global_solver_mpm_2d) {
                global_solver_mpm_2d->stepWithDt(static_cast<float>(dt_common), false);
            }
            if (global_solver_2d_cuda) {
                global_solver_2d_cuda->step(dt_common);
                global_t2d = global_solver_2d_cuda->getTime();
            } else if (global_solver_2d) {
                global_solver_2d->step(dt_common);
                global_t2d += dt_common;
            }

            global_step_fsi_2d++;
            global_step_2d++;
            step_count++;

            if (!global_exec_until_end_fsi.load()) {
                global_target_steps_fsi--;
            }

            auto now = std::chrono::steady_clock::now();
            auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
            int target_interval_ms = global_telemetry_interval_ms.load();
            bool should_emit = (target_interval_ms > 0) ? (elapsed_ms >= target_interval_ms) : true;

            if (should_emit || done) {
                double sim_time = global_solver_mpm_2d ? global_solver_mpm_2d->getSimTime() : global_t2d;

                if (global_solver_mpm_2d) emit_telemetry_mpm_2d(sim_time, false, global_step_fsi_2d.load());
                if (has_solver_2d()) emit_telemetry_2d(global_t2d, false, global_step_fsi_2d.load());
                last_telemetry_time = now;

                nlohmann::json progress_msg;
                progress_msg["type"] = "progress";
                progress_msg["sim_time"] = sim_time;
                progress_msg["step"] = global_step_fsi_2d.load();
                progress_msg["dt"] = dt_common;
                progress_msg["scope"] = "2d";

                if (global_exec_until_end_fsi.load()) {
                    progress_msg["percent"] = 50;
                    progress_msg["mode"] = "EXEC_ALL_FSI_2D";
                } else {
                    initial_steps = std::max(initial_steps, step_count + global_target_steps_fsi.load());
                    if (initial_steps > 0) {
                        int completed = initial_steps - global_target_steps_fsi.load();
                        int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 99);
                        progress_msg["percent"] = percent;
                        progress_msg["completed"] = completed;
                        progress_msg["total"] = initial_steps;
                        progress_msg["mode"] = "STEP_FSI_2D";
                    }
                }
                std::lock_guard<std::mutex> lock(cout_mutex);
                std::cout << progress_msg.dump() << std::endl;
            }
        }
    }

    double final_sim_time = global_solver_mpm_2d ? global_solver_mpm_2d->getSimTime() : global_t2d;
    if (global_solver_mpm_2d) emit_telemetry_mpm_2d(final_sim_time, true, global_step_fsi_2d.load());
    if (has_solver_2d()) emit_telemetry_2d(global_t2d, true, global_step_fsi_2d.load());

    nlohmann::json progress_msg;
    progress_msg["type"] = "progress";
    progress_msg["sim_time"] = final_sim_time;
    progress_msg["step"] = global_step_fsi_2d.load();
    progress_msg["scope"] = "2d";
    progress_msg["percent"] = 100;
    progress_msg["mode"] = global_exec_until_end_fsi.load() ? "EXEC_ALL_FSI_2D" : "STEP_FSI_2D";
    {
        std::lock_guard<std::mutex> lock(cout_mutex);
        std::cout << progress_msg.dump() << std::endl;
    }

        sim_fsi_running = false;
        sim_fsi_paused = false;
        sim_fsi_terminate = false;
        global_target_steps_fsi = 0;
        global_exec_until_end_fsi = false;
    } catch (const std::exception& e) {
        emit_kernel_log("ERROR", std::string("2D FSI worker thread error: ") + e.what(), 0.0, "2d");
        sim_fsi_running = false;
        std::exit(1);
    } catch (...) {
        emit_kernel_log("ERROR", "2D FSI worker thread error: unknown exception", 0.0, "2d");
        sim_fsi_running = false;
        std::exit(1);
    }
}

void worker_fsi_3d_thread_func() {
    cudaSetDevice(global_cuda_device_index);
    try {
        int step_count = 0;
        int initial_steps = 0;
        auto last_telemetry_time = std::chrono::steady_clock::now();
        double last_dt = 1.0e-7;

    while (!sim_fsi_3d_terminate.load()) {
        if (sim_fsi_3d_paused.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            continue;
        }

        bool done = false;
        if (!global_exec_until_end_fsi_3d.load()) {
            if (global_target_steps_fsi_3d.load() <= 0) done = true;
        }

        if (done) break;

        if ((global_solver_mpm_3d || global_solver_mpm_3d_cuda) && global_solver_3d) {
            float cfl = global_cfl_fsi_3d.load();

            if (global_solver_mpm_3d_cuda && global_solver_3d && global_solver_3d->isCUDA()) {
                // High-performance GPU-GPU FSI coupling (no CPU transfers, no CPU loops)
                global_solver_mpm_3d_cuda->particleToGridDeviceOnly();
                global_solver_3d->coupleFSIWithMPMGPU(global_solver_mpm_3d_cuda.get());

                if (step_count % 200 == 0) {
                    global_solver_mpm_3d_cuda->syncGridToHost();
                    auto& grid = global_solver_mpm_3d_cuda->getGrid();
                    double max_mass = 0.0, max_force = 0.0;
                    int num_solid = 0;
                    for (const auto& node : grid) {
                        if (node.m > max_mass) max_mass = node.m;
                        if (node.m > 1.0e-14f) num_solid++;
                        double f_mag = std::sqrt(node.f_ext[0]*node.f_ext[0] + node.f_ext[1]*node.f_ext[1] + node.f_ext[2]*node.f_ext[2]);
                        if (f_mag > max_force) max_force = f_mag;
                    }
                    std::cout << "[FSI DIAG] Step " << step_count 
                              << " | Solid nodes = " << num_solid 
                              << " | Max mass = " << max_mass 
                              << " | Max FSI force = " << max_force << " N" << std::endl;
                }
            } else {
                // Step 1: P2G — scatter particle mass/momentum to grid nodes
                if (global_solver_mpm_3d_cuda) {
                    global_solver_mpm_3d_cuda->particleToGridOnly(); // P2G on GPU, then downloads grid to host
                } else if (global_solver_mpm_3d) {
                    global_solver_mpm_3d->particleToGrid();
                }

                // Step 2: Coupled 3D FSI exchange — use populated grid to build solid mask and inject fluid pressure forces
                if ((global_solver_mpm_3d || global_solver_mpm_3d_cuda) && global_solver_3d) {
                    int nx = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getNx() : global_solver_mpm_3d->getNx();
                    int ny = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getNy() : global_solver_mpm_3d->getNy();
                    int nz = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getNz() : global_solver_mpm_3d->getNz();
                    float dx = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getDx() : global_solver_mpm_3d->getDx();
                    float dy = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getDy() : global_solver_mpm_3d->getDy();
                    float dz = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getDz() : global_solver_mpm_3d->getDz();

                    // Grid is now populated from P2G — read it to build solid mask and inject pressure forces
                    auto& grid = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getGrid() : global_solver_mpm_3d->getGrid();
                    std::vector<uint8_t> solid_mask(static_cast<size_t>(nx) * ny * nz, 0);
                    std::vector<double> solid_vel(3 * static_cast<size_t>(nx) * ny * nz, 0.0);

                    for (int i = 0; i < nx; ++i) {
                        for (int j = 0; j < ny; ++j) {
                            for (int k = 0; k < nz; ++k) {
                                size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                                auto& node = grid[node_idx];
                                size_t cfd_idx = static_cast<size_t>(i) + static_cast<size_t>(j) * nx + static_cast<size_t>(k) * nx * ny;
                                if (node.m > 1.0e-8f) {
                                    solid_mask[cfd_idx] = 1;
                                    solid_vel[3 * cfd_idx + 0] = node.v(0);
                                    solid_vel[3 * cfd_idx + 1] = node.v(1);
                                    solid_vel[3 * cfd_idx + 2] = node.v(2);
                                }
                            }
                        }
                    }

                    // Pass MPM solid mask to 3D CFD solver so fluid shock/pressure reflects off MPM solids
                    global_solver_3d->setSolidMask(solid_mask.data());
                    global_solver_3d->setSolidVelocities(solid_vel.data());

                    // Bulk-download entire pressure field in ONE transfer (avoids per-cell cudaMemcpy)
                    std::vector<float> pfield = global_solver_3d->extractPressureField();
                    // Fall back to per-cell if extractPressureField returns nothing (CPU solver)
                    bool use_bulk = !pfield.empty();

                    // Inject fluid pressure gradient as external force into populated grid nodes
                    for (int i = 0; i < nx; ++i) {
                        for (int j = 0; j < ny; ++j) {
                            for (int k = 0; k < nz; ++k) {
                                size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                                auto& node = grid[node_idx];
                                if (node.m > 1.0e-8f) {
                                    auto is_fluid = [&](int xi, int yi, int zi) -> bool {
                                        if (xi < 0 || xi >= nx || yi < 0 || yi >= ny || zi < 0 || zi >= nz) return false;
                                        size_t idx = (static_cast<size_t>(xi) * ny + yi) * nz + zi;
                                        return grid[idx].m <= 1.0e-8f;
                                    };

                                    double f_x = 0.0, f_y = 0.0, f_z = 0.0;
                                    if (use_bulk) {
                                        auto pidx = [&](int xi, int yi, int zi) -> double {
                                            xi = std::clamp(xi, 0, nx-1);
                                            yi = std::clamp(yi, 0, ny-1);
                                            zi = std::clamp(zi, 0, nz-1);
                                            return pfield[xi + yi * nx + zi * nx * ny];
                                        };
                                        if (is_fluid(i-1, j, k)) f_x += pidx(i-1, j, k);
                                        if (is_fluid(i+1, j, k)) f_x -= pidx(i+1, j, k);
                                        if (is_fluid(i, j-1, k)) f_y += pidx(i, j-1, k);
                                        if (is_fluid(i, j+1, k)) f_y -= pidx(i, j+1, k);
                                        if (is_fluid(i, j, k-1)) f_z += pidx(i, j, k-1);
                                        if (is_fluid(i, j, k+1)) f_z -= pidx(i, j, k+1);
                                    } else {
                                        if (i > 0 && is_fluid(i-1, j, k)) {
                                            auto cv = global_solver_3d->getCellValues(i-1, j, k);
                                            if (!cv.empty()) f_x += cv[0];
                                        }
                                        if (i < nx-1 && is_fluid(i+1, j, k)) {
                                            auto cv = global_solver_3d->getCellValues(i+1, j, k);
                                            if (!cv.empty()) f_x -= cv[0];
                                        }
                                        if (j > 0 && is_fluid(i, j-1, k)) {
                                            auto cv = global_solver_3d->getCellValues(i, j-1, k);
                                            if (!cv.empty()) f_y += cv[0];
                                        }
                                        if (j < ny-1 && is_fluid(i, j+1, k)) {
                                            auto cv = global_solver_3d->getCellValues(i, j+1, k);
                                            if (!cv.empty()) f_y -= cv[0];
                                        }
                                        if (k > 0 && is_fluid(i, j, k-1)) {
                                            auto cv = global_solver_3d->getCellValues(i, j, k-1);
                                            if (!cv.empty()) f_z += cv[0];
                                        }
                                        if (k < nz-1 && is_fluid(i, j, k+1)) {
                                            auto cv = global_solver_3d->getCellValues(i, j, k+1);
                                            if (!cv.empty()) f_z -= cv[0];
                                        }
                                    }

                                    node.f_ext[0] = static_cast<float>(f_x * dy * dz);
                                    node.f_ext[1] = static_cast<float>(f_y * dx * dz);
                                    node.f_ext[2] = static_cast<float>(f_z * dx * dy);
                                }
                            }
                        }
                    }

                    // Upload the grid with FSI forces back to GPU (for CUDA path)
                    if (global_solver_mpm_3d_cuda) {
                        global_solver_mpm_3d_cuda->uploadGridToDevice();
                        global_solver_mpm_3d_cuda->storeFSIForces();
                    }
                }
            }

            // Step 3: Calculate coupled CFL stability timestep
            float dt_mpm = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->computeStepSize(cfl)
                         : (global_solver_mpm_3d ? global_solver_mpm_3d->computeStepSize(cfl) : 1.0e-4f);
            double dt_cfd = global_solver_3d ? global_solver_3d->computeStepSize(cfl) : 1.0e-4;

            double dt_common = std::min(static_cast<double>(dt_mpm), dt_cfd);
            if (step_count == 0) {
                dt_common = std::min(dt_common, 1.0e-7);
            } else {
                dt_common = std::min(dt_common, 1.05 * last_dt);
            }
            dt_common = std::clamp(dt_common, 1.0e-11, 1.0e-4);
            last_dt = dt_common;
            global_dt_3d = dt_common; // Ensure telemetry reports the correct timestep

            if (global_solver_mpm_3d_cuda) {
                global_solver_mpm_3d_cuda->stepWithDt(static_cast<float>(dt_common), false);
            } else if (global_solver_mpm_3d) {
                global_solver_mpm_3d->stepWithDt(static_cast<float>(dt_common), false);
            }

            if (global_solver_3d) {
                global_solver_3d->step(dt_common);
                global_t3d += dt_common;
            }

            global_step_fsi_3d++;
            global_step_3d++;
            step_count++;

            if (!global_exec_until_end_fsi_3d.load()) {
                global_target_steps_fsi_3d--;
            }

            auto now = std::chrono::steady_clock::now();
            auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
            int target_interval_ms = global_telemetry_interval_ms.load();
            bool should_emit = (target_interval_ms > 0) ? (elapsed_ms >= target_interval_ms) : true;

            if (should_emit || done) {
                double sim_time = global_t3d;

                // Emit single unified telemetry frame to eliminate 3D viewport flickering
                if (global_solver_3d) emit_telemetry_3d(global_t3d, false, global_step_fsi_3d.load());
                last_telemetry_time = now;

                nlohmann::json progress_msg;
                progress_msg["type"] = "progress";
                progress_msg["sim_time"] = sim_time;
                progress_msg["step"] = global_step_fsi_3d.load();
                progress_msg["dt"] = dt_common;
                progress_msg["scope"] = "3d";

                if (global_exec_until_end_fsi_3d.load()) {
                    progress_msg["percent"] = 50;
                    progress_msg["mode"] = "EXEC_ALL_FSI_3D";
                } else {
                    initial_steps = std::max(initial_steps, step_count + global_target_steps_fsi_3d.load());
                    if (initial_steps > 0) {
                        int completed = initial_steps - global_target_steps_fsi_3d.load();
                        int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 99);
                        progress_msg["percent"] = percent;
                        progress_msg["completed"] = completed;
                        progress_msg["total"] = initial_steps;
                        progress_msg["mode"] = "STEP_FSI_3D";
                    }
                }
                std::lock_guard<std::mutex> lock(cout_mutex);
                std::cout << progress_msg.dump() << std::endl;
            }
        }
    }

    double final_sim_time = global_t3d;
    if (global_solver_3d) emit_telemetry_3d(global_t3d, true, global_step_fsi_3d.load());

    nlohmann::json progress_msg;
    progress_msg["type"] = "progress";
    progress_msg["sim_time"] = final_sim_time;
    progress_msg["step"] = global_step_fsi_3d.load();
    progress_msg["scope"] = "3d";
    progress_msg["percent"] = 100;
    progress_msg["mode"] = global_exec_until_end_fsi_3d.load() ? "EXEC_ALL_FSI_3D" : "STEP_FSI_3D";
    {
        std::lock_guard<std::mutex> lock(cout_mutex);
        std::cout << progress_msg.dump() << std::endl;
    }

        sim_fsi_3d_running = false;
        sim_fsi_3d_paused = false;
        sim_fsi_3d_terminate = false;
        global_target_steps_fsi_3d = 0;
        global_exec_until_end_fsi_3d = false;
    } catch (const std::exception& e) {
        emit_kernel_log("ERROR", std::string("3D FSI worker thread error: ") + e.what(), 0.0, "3d");
        sim_fsi_3d_running = false;
        std::exit(1);
    } catch (...) {
        emit_kernel_log("ERROR", "3D FSI worker thread error: unknown exception", 0.0, "3d");
        sim_fsi_3d_running = false;
        std::exit(1);
    }
}

std::atomic<bool> sim_fem_fsi_3d_running{false};
std::atomic<bool> sim_fem_fsi_3d_paused{false};
std::atomic<bool> sim_fem_fsi_3d_terminate{false};
std::atomic<bool> global_exec_until_end_fem_fsi_3d{false};
std::atomic<int> global_target_steps_fem_fsi_3d{0};
std::atomic<float> global_cfl_fem_fsi_3d{0.30f};

void worker_fem_fsi_3d_thread_func() {
    try {
        int step_count = 0;
        int initial_steps = 0;
        auto last_telemetry_time = std::chrono::steady_clock::now();
        double last_dt = 1.0e-7;

        std::string m_id = global_model_id.empty() ? "default_fem" : global_model_id;

        while (!sim_fem_fsi_3d_terminate.load()) {
            if (sim_fem_fsi_3d_paused.load()) {
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
                continue;
            }

            bool done = false;
            if (!global_exec_until_end_fem_fsi_3d.load()) {
                if (global_target_steps_fem_fsi_3d.load() <= 0) done = true;
            }

            if (done) break;

            float cfl = global_cfl_fem_fsi_3d.load();

            // Run appropriate coupler instance
            if (global_fem_fsi_couplers_cuda_float.count(m_id) && global_fem_fsi_couplers_cuda_float[m_id]) {
                auto* coupler = global_fem_fsi_couplers_cuda_float[m_id].get();
                coupler->step(cfl);
                last_dt = static_cast<double>(coupler->getLastDt());
                global_t3d = static_cast<double>(coupler->getSimTime());
            } else if (!global_fem_fsi_couplers_cuda_float.empty()) {
                auto* coupler = global_fem_fsi_couplers_cuda_float.begin()->second.get();
                coupler->step(cfl);
                last_dt = static_cast<double>(coupler->getLastDt());
                global_t3d = static_cast<double>(coupler->getSimTime());
            } else if (global_fem_fsi_couplers_cuda_double.count(m_id) && global_fem_fsi_couplers_cuda_double[m_id]) {
                auto* coupler = global_fem_fsi_couplers_cuda_double[m_id].get();
                coupler->step(static_cast<double>(cfl));
                last_dt = coupler->getLastDt();
                global_t3d = coupler->getSimTime();
            } else if (!global_fem_fsi_couplers_cuda_double.empty()) {
                auto* coupler = global_fem_fsi_couplers_cuda_double.begin()->second.get();
                coupler->step(static_cast<double>(cfl));
                last_dt = coupler->getLastDt();
                global_t3d = coupler->getSimTime();
            } else if (global_fem_fsi_couplers_float.count(m_id) && global_fem_fsi_couplers_float[m_id]) {
                auto* coupler = global_fem_fsi_couplers_float[m_id].get();
                coupler->step(cfl);
                last_dt = static_cast<double>(coupler->getLastDt());
                global_t3d = static_cast<double>(coupler->getSimTime());
            } else if (!global_fem_fsi_couplers_float.empty()) {
                auto* coupler = global_fem_fsi_couplers_float.begin()->second.get();
                coupler->step(cfl);
                last_dt = static_cast<double>(coupler->getLastDt());
                global_t3d = static_cast<double>(coupler->getSimTime());
            } else if (global_fem_fsi_couplers_double.count(m_id) && global_fem_fsi_couplers_double[m_id]) {
                auto* coupler = global_fem_fsi_couplers_double[m_id].get();
                coupler->step(static_cast<double>(cfl));
                last_dt = coupler->getLastDt();
                global_t3d = coupler->getSimTime();
            } else if (!global_fem_fsi_couplers_double.empty()) {
                auto* coupler = global_fem_fsi_couplers_double.begin()->second.get();
                coupler->step(static_cast<double>(cfl));
                last_dt = coupler->getLastDt();
                global_t3d = coupler->getSimTime();
            } else {
                if (global_solver_3d) global_solver_3d->step(last_dt);
            }

            global_dt_3d = last_dt;
            global_step_fem_fsi_3d++;
            global_step_3d++;
            step_count++;
            if (!global_exec_until_end_fem_fsi_3d.load()) {
                global_target_steps_fem_fsi_3d.fetch_sub(1);
            }

            auto now = std::chrono::steady_clock::now();
            auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
            int target_interval_ms = (global_telemetry_interval_ms.load() > 0) ? global_telemetry_interval_ms.load() : static_cast<int>(global_refresh_rate_fem_3d.load() * 1000.0);
            bool should_emit = (target_interval_ms > 0) ? (elapsed_ms >= target_interval_ms) : true;
            if (should_emit || (global_target_steps_fem_fsi_3d.load() == 0 && !global_exec_until_end_fem_fsi_3d.load())) {
                last_telemetry_time = now;
                int current_step = global_step_fem_fsi_3d.load();
                if (global_fem_fsi_couplers_cuda_float.count(m_id) && global_fem_fsi_couplers_cuda_float[m_id]) {
                    current_step = std::max(current_step, global_fem_fsi_couplers_cuda_float[m_id]->getStepCount());
                } else if (!global_fem_fsi_couplers_cuda_float.empty()) {
                    current_step = std::max(current_step, global_fem_fsi_couplers_cuda_float.begin()->second->getStepCount());
                } else if (global_fem_fsi_couplers_cuda_double.count(m_id) && global_fem_fsi_couplers_cuda_double[m_id]) {
                    current_step = std::max(current_step, global_fem_fsi_couplers_cuda_double[m_id]->getStepCount());
                } else if (!global_fem_fsi_couplers_cuda_double.empty()) {
                    current_step = std::max(current_step, global_fem_fsi_couplers_cuda_double.begin()->second->getStepCount());
                } else if (global_fem_fsi_couplers_float.count(m_id) && global_fem_fsi_couplers_float[m_id]) {
                    current_step = std::max(current_step, global_fem_fsi_couplers_float[m_id]->getStepCount());
                } else if (!global_fem_fsi_couplers_float.empty()) {
                    current_step = std::max(current_step, global_fem_fsi_couplers_float.begin()->second->getStepCount());
                } else if (global_fem_fsi_couplers_double.count(m_id) && global_fem_fsi_couplers_double[m_id]) {
                    current_step = std::max(current_step, global_fem_fsi_couplers_double[m_id]->getStepCount());
                } else if (!global_fem_fsi_couplers_double.empty()) {
                    current_step = std::max(current_step, global_fem_fsi_couplers_double.begin()->second->getStepCount());
                }
                if (global_solver_3d) emit_telemetry_3d(global_t3d, false, current_step);

                nlohmann::json progress_msg;
                progress_msg["type"] = "progress";
                progress_msg["sim_time"] = global_t3d;
                progress_msg["step"] = current_step;
                progress_msg["scope"] = "3d";
                if (global_exec_until_end_fem_fsi_3d.load()) {
                    progress_msg["percent"] = 50;
                    progress_msg["mode"] = "EXEC_ALL_FEM_FSI_3D";
                } else {
                    initial_steps = std::max(initial_steps, step_count + global_target_steps_fem_fsi_3d.load());
                    if (initial_steps > 0) {
                        int completed = initial_steps - global_target_steps_fem_fsi_3d.load();
                        int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 99);
                        progress_msg["percent"] = percent;
                        progress_msg["completed"] = completed;
                        progress_msg["total"] = initial_steps;
                        progress_msg["mode"] = "STEP_FEM_FSI_3D";
                    }
                }
                std::lock_guard<std::mutex> lock(cout_mutex);
                std::cout << progress_msg.dump() << std::endl;
            }
        }

        double final_sim_time = global_t3d;
        int final_step = global_step_fem_fsi_3d.load();
        if (global_fem_fsi_couplers_cuda_float.count(m_id) && global_fem_fsi_couplers_cuda_float[m_id]) {
            final_step = std::max(final_step, global_fem_fsi_couplers_cuda_float[m_id]->getStepCount());
        } else if (!global_fem_fsi_couplers_cuda_float.empty()) {
            final_step = std::max(final_step, global_fem_fsi_couplers_cuda_float.begin()->second->getStepCount());
        } else if (global_fem_fsi_couplers_cuda_double.count(m_id) && global_fem_fsi_couplers_cuda_double[m_id]) {
            final_step = std::max(final_step, global_fem_fsi_couplers_cuda_double[m_id]->getStepCount());
        } else if (!global_fem_fsi_couplers_cuda_double.empty()) {
            final_step = std::max(final_step, global_fem_fsi_couplers_cuda_double.begin()->second->getStepCount());
        } else if (global_fem_fsi_couplers_float.count(m_id) && global_fem_fsi_couplers_float[m_id]) {
            final_step = std::max(final_step, global_fem_fsi_couplers_float[m_id]->getStepCount());
        } else if (!global_fem_fsi_couplers_float.empty()) {
            final_step = std::max(final_step, global_fem_fsi_couplers_float.begin()->second->getStepCount());
        } else if (global_fem_fsi_couplers_double.count(m_id) && global_fem_fsi_couplers_double[m_id]) {
            final_step = std::max(final_step, global_fem_fsi_couplers_double[m_id]->getStepCount());
        } else if (!global_fem_fsi_couplers_double.empty()) {
            final_step = std::max(final_step, global_fem_fsi_couplers_double.begin()->second->getStepCount());
        }
        if (global_solver_3d) emit_telemetry_3d(global_t3d, true, final_step);

        nlohmann::json progress_msg;
        progress_msg["type"] = "progress";
        progress_msg["sim_time"] = final_sim_time;
        progress_msg["step"] = final_step;
        progress_msg["scope"] = "3d";
        progress_msg["percent"] = 100;
        progress_msg["mode"] = global_exec_until_end_fem_fsi_3d.load() ? "EXEC_ALL_FEM_FSI_3D" : "STEP_FEM_FSI_3D";
        {
            std::lock_guard<std::mutex> lock(cout_mutex);
            std::cout << progress_msg.dump() << std::endl;
        }

        sim_fem_fsi_3d_running = false;
        sim_fem_fsi_3d_paused = false;
        sim_fem_fsi_3d_terminate = false;
        global_target_steps_fem_fsi_3d = 0;
        global_exec_until_end_fem_fsi_3d = false;
    } catch (const std::exception& e) {
        emit_kernel_log("ERROR", std::string("3D FEM FSI worker thread error: ") + e.what(), 0.0, "3d");
        sim_fem_fsi_3d_running = false;
        std::exit(1);
    } catch (...) {
        emit_kernel_log("ERROR", "3D FEM FSI worker thread error: unknown exception", 0.0, "3d");
        sim_fem_fsi_3d_running = false;
        std::exit(1);
    }
}

// NVML Dynamic Loading Declarations
typedef int nvmlReturn_t;
#define NVML_SUCCESS 0

typedef struct nvmlUtilization_st {
    unsigned int device;
    unsigned int memory;
} nvmlUtilization_t;

typedef struct nvmlProcessInfo_st {
    unsigned int pid;
    unsigned long long usedGpuMemory;
} nvmlProcessInfo_t;

typedef void* nvmlDevice_t;

typedef nvmlReturn_t (*nvmlInit_t)();
typedef nvmlReturn_t (*nvmlShutdown_t)();
typedef nvmlReturn_t (*nvmlDeviceGetHandleByIndex_t)(unsigned int index, nvmlDevice_t* device);
typedef nvmlReturn_t (*nvmlDeviceGetUtilizationRates_t)(nvmlDevice_t device, nvmlUtilization_t* rates);
typedef nvmlReturn_t (*nvmlDeviceGetTemperature_t)(nvmlDevice_t device, int sensorType, unsigned int* temp);
typedef nvmlReturn_t (*nvmlDeviceGetComputeRunningProcesses_t)(nvmlDevice_t device, unsigned int* infoCount, nvmlProcessInfo_t* infos);
typedef nvmlReturn_t (*nvmlDeviceGetGraphicsRunningProcesses_t)(nvmlDevice_t device, unsigned int* infoCount, nvmlProcessInfo_t* infos);

struct CPUMonitor {
    double last_cpu_time = 0.0;
    double last_wall_time = 0.0;
    int num_cores = 1;

    CPUMonitor() {
        num_cores = std::max(1, (int)sysconf(_SC_NPROCESSORS_ONLN));
        reset();
    }

    void reset() {
        struct timespec ts, tw;
        if (clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &ts) == 0 && clock_gettime(CLOCK_MONOTONIC, &tw) == 0) {
            last_cpu_time = ts.tv_sec + ts.tv_nsec * 1e-9;
            last_wall_time = tw.tv_sec + tw.tv_nsec * 1e-9;
        }
    }

    double get_usage() {
        struct timespec ts, tw;
        if (clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &ts) != 0 || clock_gettime(CLOCK_MONOTONIC, &tw) != 0) {
            return 0.0;
        }
        double cpu_time = ts.tv_sec + ts.tv_nsec * 1e-9;
        double wall_time = tw.tv_sec + tw.tv_nsec * 1e-9;

        double dt_cpu = cpu_time - last_cpu_time;
        double dt_wall = wall_time - last_wall_time;

        if (dt_wall <= 0.0) return 0.0;

        last_cpu_time = cpu_time;
        last_wall_time = wall_time;

        double usage = (dt_cpu / dt_wall / num_cores) * 100.0;
        return std::clamp(usage, 0.0, 100.0);
    }
};

struct GPUMonitor {
    void* handle = nullptr;
    nvmlDevice_t device = nullptr;
    bool initialized = false;

    nvmlInit_t p_nvmlInit = nullptr;
    nvmlShutdown_t p_nvmlShutdown = nullptr;
    nvmlDeviceGetHandleByIndex_t p_nvmlDeviceGetHandleByIndex = nullptr;
    nvmlDeviceGetUtilizationRates_t p_nvmlDeviceGetUtilizationRates = nullptr;
    nvmlDeviceGetTemperature_t p_nvmlDeviceGetTemperature = nullptr;
    nvmlDeviceGetComputeRunningProcesses_t p_nvmlDeviceGetComputeRunningProcesses = nullptr;
    nvmlDeviceGetGraphicsRunningProcesses_t p_nvmlDeviceGetGraphicsRunningProcesses = nullptr;

    GPUMonitor() {
        handle = dlopen("libnvidia-ml.so.1", RTLD_LAZY);
        if (!handle) {
            handle = dlopen("libnvidia-ml.so", RTLD_LAZY);
        }

        if (handle) {
            p_nvmlInit = (nvmlInit_t)dlsym(handle, "nvmlInit");
            p_nvmlShutdown = (nvmlShutdown_t)dlsym(handle, "nvmlShutdown");
            p_nvmlDeviceGetHandleByIndex = (nvmlDeviceGetHandleByIndex_t)dlsym(handle, "nvmlDeviceGetHandleByIndex");
            p_nvmlDeviceGetUtilizationRates = (nvmlDeviceGetUtilizationRates_t)dlsym(handle, "nvmlDeviceGetUtilizationRates");
            p_nvmlDeviceGetTemperature = (nvmlDeviceGetTemperature_t)dlsym(handle, "nvmlDeviceGetTemperature");
            p_nvmlDeviceGetComputeRunningProcesses = (nvmlDeviceGetComputeRunningProcesses_t)dlsym(handle, "nvmlDeviceGetComputeRunningProcesses");
            p_nvmlDeviceGetGraphicsRunningProcesses = (nvmlDeviceGetGraphicsRunningProcesses_t)dlsym(handle, "nvmlDeviceGetGraphicsRunningProcesses");

            if (p_nvmlInit && p_nvmlShutdown && p_nvmlDeviceGetHandleByIndex &&
                p_nvmlDeviceGetUtilizationRates && p_nvmlDeviceGetTemperature) {
                if (p_nvmlInit() == NVML_SUCCESS) {
                    if (p_nvmlDeviceGetHandleByIndex(0, &device) == NVML_SUCCESS) {
                        initialized = true;
                    } else {
                        p_nvmlShutdown();
                    }
                }
            }
        }
    }

    ~GPUMonitor() {
        if (initialized && p_nvmlShutdown) {
            p_nvmlShutdown();
        }
        if (handle) {
            dlclose(handle);
        }
    }

    bool get_metrics(double& gpu_util, double& gpu_temp) {
        if (!initialized) return false;
        
        nvmlUtilization_t rates;
        unsigned int temp = 0;
        bool success = true;

        if (p_nvmlDeviceGetUtilizationRates(device, &rates) == NVML_SUCCESS) {
            gpu_util = rates.device;
        } else {
            success = false;
        }

        if (p_nvmlDeviceGetTemperature(device, 0, &temp) == NVML_SUCCESS) {
            gpu_temp = temp;
        } else {
            success = false;
        }

        return success;
    }

    unsigned int current_device_index = 0;

    void set_device_index(unsigned int index) {
        current_device_index = index;
        if (initialized && p_nvmlDeviceGetHandleByIndex) {
            p_nvmlDeviceGetHandleByIndex(index, &device);
        }
    }

    unsigned int get_device_index() const {
        return current_device_index;
    }

    bool get_process_vram(unsigned int pid, unsigned long long& vram_bytes) {
        if (!initialized) return false;

        if (p_nvmlDeviceGetComputeRunningProcesses) {
            unsigned int info_count = 64;
            std::vector<nvmlProcessInfo_t> infos(info_count);
            nvmlReturn_t ret = p_nvmlDeviceGetComputeRunningProcesses(device, &info_count, infos.data());
            if (ret == NVML_SUCCESS) {
                for (unsigned int i = 0; i < info_count; ++i) {
                    if (infos[i].pid == pid) {
                        vram_bytes = infos[i].usedGpuMemory;
                        return true;
                    }
                }
            }
        }

        if (p_nvmlDeviceGetGraphicsRunningProcesses) {
            unsigned int info_count = 64;
            std::vector<nvmlProcessInfo_t> infos(info_count);
            nvmlReturn_t ret = p_nvmlDeviceGetGraphicsRunningProcesses(device, &info_count, infos.data());
            if (ret == NVML_SUCCESS) {
                for (unsigned int i = 0; i < info_count; ++i) {
                    if (infos[i].pid == pid) {
                        vram_bytes = infos[i].usedGpuMemory;
                        return true;
                    }
                }
            }
        }

        return false;
    }
};

GPUMonitor global_gpu_monitor;

extern "C" int cudaSetDevice(int device);

bool is_cuda_device(const std::string& device) {
    return device.rfind("cuda", 0) == 0;
}

void select_cuda_device(const std::string& device) {
    if (is_cuda_device(device)) {
        int index = 0;
        if (device.length() > 5 && device[4] == ':') {
            try {
                index = std::stoi(device.substr(5));
            } catch (...) {
                index = 0;
            }
        }
        global_cuda_device_index = index;
        cudaSetDevice(index);
        global_gpu_monitor.set_device_index(index);
    }
}

uint64_t get_process_ram_bytes() {
    std::ifstream statm("/proc/self/statm");
    uint64_t size, resident;
    if (statm >> size >> resident) {
        return resident * sysconf(_SC_PAGESIZE);
    }
    return 0;
}

uint64_t get_system_ram_bytes() {
    std::ifstream meminfo("/proc/meminfo");
    std::string key;
    uint64_t value;
    while (meminfo >> key >> value) {
        if (key == "MemTotal:") {
            return value * 1024; // KB to bytes
        }
        std::string dummy;
        std::getline(meminfo, dummy);
    }
    return 0;
}

uint64_t get_system_used_ram_bytes() {
    std::ifstream meminfo("/proc/meminfo");
    std::string key;
    uint64_t value;
    uint64_t total = 0;
    uint64_t available = 0;
    while (meminfo >> key >> value) {
        if (key == "MemTotal:") {
            total = value * 1024;
        } else if (key == "MemAvailable:") {
            available = value * 1024;
        }
        std::string dummy;
        std::getline(meminfo, dummy);
    }
    if (total > 0 && available > 0 && total >= available) {
        return total - available;
    }
    return total - available; // fallback if available is 0, though unlikely
}

void emit_resource_pulse() {
    cudaSetDevice(global_cuda_device_index);
    static CPUMonitor cpu_monitor;
    static uint64_t system_ram = get_system_ram_bytes();

    std::lock_guard<std::mutex> lock(cout_mutex);

    double cpu_usage = cpu_monitor.get_usage();
    uint64_t ram_alloc = get_process_ram_bytes();
    
    // Default fallback values
    double gpu_util = 0.0;
    double gpu_temp = 35.0;
    size_t free_vram = 0;
    size_t total_vram = 0;

    // VRAM via CUDA helper
    get_cuda_vram_info(free_vram, total_vram);

    // NVML query
    bool nvml_ok = global_gpu_monitor.get_metrics(gpu_util, gpu_temp);
    if (!nvml_ok) {
        // If NVML is not available, we can mock it when the simulation is active
        if (sim_running || sim2d_running || sim3d_running) {
            gpu_util = total_vram > 0 ? 80.0 : 15.0; // GPU active or CPU active mock
            gpu_temp = total_vram > 0 ? 65.0 : 45.0;
        } else {
            gpu_util = 0.0;
            gpu_temp = 35.0;
        }
    }

    nlohmann::json pulse;
    pulse["type"] = "resource_pulse";
    pulse["cpu"] = cpu_usage;
    pulse["ram_alloc"] = ram_alloc;
    pulse["ram_total"] = system_ram;
    pulse["ram_system"] = get_system_used_ram_bytes();
    pulse["gpu_util"] = gpu_util;
    pulse["vram_alloc"] = total_vram - free_vram;
    pulse["vram_total"] = total_vram;
    
    size_t solver_vram = 0;
    if (global_solver_mpm_3d_cuda != nullptr) {
        solver_vram += global_solver_mpm_3d_cuda->getAllocatedVRAM();
    }
    if (global_solver_2d_cuda != nullptr) {
        solver_vram += global_solver_2d_cuda->getAllocatedVRAM();
    }
    if (global_solver_3d != nullptr) {
        solver_vram += global_solver_3d->getAllocatedVRAM();
    }

    size_t blastdemon_vram = 0;
    unsigned long long nvml_vram = 0;
    static std::vector<unsigned long long> vram_window;

    if (global_gpu_monitor.get_process_vram(getpid(), nvml_vram) && nvml_vram > 0) {
        vram_window.push_back(nvml_vram);
        if (vram_window.size() > 10) {
            vram_window.erase(vram_window.begin());
        }
        unsigned long long min_vram = vram_window[0];
        for (auto v : vram_window) {
            if (v < min_vram) min_vram = v;
        }
        global_last_valid_nvml_vram = min_vram;
        blastdemon_vram = min_vram;
    } else if (global_last_valid_nvml_vram > 0) {
        blastdemon_vram = std::max<size_t>(global_last_valid_nvml_vram, solver_vram);
    } else {
        blastdemon_vram = solver_vram;
    }
    pulse["vram_blastdaemon"] = blastdemon_vram;
    pulse["gpu_temp"] = gpu_temp;

    std::cout << pulse.dump() << std::endl;
}

struct TelemetryPayload {
    enum Type { TYPE_1D, TYPE_2D, TYPE_3D, TYPE_2D_AMR, TYPE_FEM_3D } type;
    double elapsed;
    bool is_terminated;
    double wallclock;
    int step = 0;
    
    // 1D specific
    int n_cells = 0;
    double dt = 0.0;
    
    // 2D specific
    int out_nr = 0;
    int out_nz = 0;
    
    // 3D specific
    struct SlicePayload {
        std::string axis;
        double offset;
        int stride;
        std::vector<float> data;
        int w = 0;
        int h = 0;
        float xmin = 0.0f, xmax = 0.0f;
        float ymin = 0.0f, ymax = 0.0f;
        float zmin = 0.0f, zmax = 0.0f;
        int level = 0;
        bool is_submesh = false;
    };
    std::vector<SlicePayload> slices;
    double xmin = 0.0, ymin = 0.0, zmin = 0.0, dx = 0.0;
    int nx = 0, ny = 0, nz = 0;
    double total_mass = 0.0;
    double total_energy = 0.0;

    // Shared grid/frame data
    std::vector<float> grid_data;
    std::vector<float> mpm_particles;

    // FEM 3D specific
    int fem_step = 0;
    double fem_v_max = 0.0;
    double fem_sig_max = 0.0;
    double fem_ep_max = 0.0;
    std::string fem_model_id;
    uint32_t fem_n_nodes = 0;
    uint32_t fem_n_facets = 0;
    std::vector<float> fem_node_data;
    std::vector<float> fem_facet_data;
    
    // Gauges
    bool has_gauges = false;
    std::vector<double> gauge_times;
    std::vector<GaugeHistory> gauges_history;
    bool is_ideal_gas = false;
};

struct AsyncTelemetry {
    std::mutex mutex;
    std::condition_variable cv;
    std::queue<std::unique_ptr<TelemetryPayload>> queue;
    bool exit_flag = false;

    void push(std::unique_ptr<TelemetryPayload> payload) {
        std::lock_guard<std::mutex> lock(mutex);
        if (queue.size() >= 2 && !payload->is_terminated) {
            if (!queue.front()->is_terminated) {
                queue.pop();
            }
        }
        queue.push(std::move(payload));
        cv.notify_one();
    }
};

static AsyncTelemetry global_async_telemetry;
std::thread global_telemetry_thread;

void async_telemetry_thread_func() {
    while (true) {
        std::unique_ptr<TelemetryPayload> payload;
        {
            std::unique_lock<std::mutex> lock(global_async_telemetry.mutex);
            global_async_telemetry.cv.wait(lock, []() {
                return !global_async_telemetry.queue.empty() || global_async_telemetry.exit_flag;
            });
            if (global_async_telemetry.exit_flag && global_async_telemetry.queue.empty()) {
                break;
            }
            payload = std::move(global_async_telemetry.queue.front());
            global_async_telemetry.queue.pop();
        }

        if (!payload) continue;

        std::lock_guard<std::mutex> lock(cout_mutex);

        nlohmann::json envelope;
        if (!global_model_id.empty()) {
            envelope["modelId"] = global_model_id;
        }

        nlohmann::json gh;
        if (payload->has_gauges) {
            gh["solverTracked"] = true;
            gh["times"] = payload->gauge_times;
            nlohmann::json vals_obj = nlohmann::json::object();
            for (const auto& h : payload->gauges_history) {
                nlohmann::json ch_arrays = nlohmann::json::array();
                int limit = h.channel_values.size();
                for (int ch = 0; ch < limit; ++ch) {
                    ch_arrays.push_back(h.channel_values[ch]);
                }
                vals_obj[h.id] = ch_arrays;
            }
            gh["values"] = vals_obj;
        }

        if (payload->type == TelemetryPayload::TYPE_1D) {
            envelope["type"] = "TELEMETRY";
            envelope["time"] = payload->elapsed;
            envelope["step"] = payload->step;
            envelope["dt"] = payload->dt;
            envelope["is_terminated"] = payload->is_terminated;
            envelope["wallclock"] = payload->wallclock;
            envelope["is_ideal_gas"] = payload->is_ideal_gas;
            if (payload->has_gauges) {
                envelope["gauges_history"] = gh;
            }

            std::cout << envelope.dump() << std::endl;

            const uint32_t n_cells    = static_cast<uint32_t>(payload->n_cells);
            const uint32_t n_channels = 7;
            size_t header_bytes  = sizeof(uint32_t) * 2;
            size_t payload_bytes = payload->grid_data.size() * sizeof(float);
            size_t total_bytes   = header_bytes + payload_bytes;

            std::cout << "BIN_FRAME " << total_bytes << "\n";
            std::cout.write(reinterpret_cast<const char*>(&n_cells),    sizeof(uint32_t));
            std::cout.write(reinterpret_cast<const char*>(&n_channels), sizeof(uint32_t));
            std::cout.write(reinterpret_cast<const char*>(payload->grid_data.data()), payload_bytes);
            std::cout.flush();

        } else if (payload->type == TelemetryPayload::TYPE_2D) {
            envelope["type"] = "TELEMETRY_2D";
            envelope["time"] = payload->elapsed;
            envelope["step"] = payload->step;
            envelope["dt"] = payload->dt;
            envelope["is_terminated"] = payload->is_terminated;
            envelope["nr"] = payload->out_nr;
            envelope["nz"] = payload->out_nz;
            envelope["wallclock"] = payload->wallclock;
            envelope["is_ideal_gas"] = payload->is_ideal_gas;
            if (payload->has_gauges) {
                envelope["gauges_history"] = gh;
            }

            std::cout << envelope.dump() << std::endl;

            const uint32_t out_nr_u = static_cast<uint32_t>(payload->out_nr);
            const uint32_t out_nz_u = static_cast<uint32_t>(payload->out_nz);
            const uint32_t n_channels_u = 7;
            size_t header_bytes  = sizeof(uint32_t) * 3;
            size_t payload_bytes = payload->grid_data.size() * sizeof(float);
            size_t total_bytes   = header_bytes + payload_bytes;

            std::cout << "BIN_FRAME_2D " << total_bytes << "\n";
            std::cout.write(reinterpret_cast<const char*>(&out_nr_u),     sizeof(uint32_t));
            std::cout.write(reinterpret_cast<const char*>(&out_nz_u),     sizeof(uint32_t));
            std::cout.write(reinterpret_cast<const char*>(&n_channels_u), sizeof(uint32_t));
            std::cout.write(reinterpret_cast<const char*>(payload->grid_data.data()), payload_bytes);
            std::cout.flush();

        } else if (payload->type == TelemetryPayload::TYPE_2D_AMR) {
            envelope["type"] = "TELEMETRY_2D";
            envelope["time"] = payload->elapsed;
            envelope["step"] = payload->step;
            envelope["dt"] = payload->dt;
            envelope["is_terminated"] = payload->is_terminated;
            envelope["wallclock"] = payload->wallclock;
            envelope["is_ideal_gas"] = payload->is_ideal_gas;
            if (payload->has_gauges) {
                envelope["gauges_history"] = gh;
            }

            std::cout << envelope.dump() << std::endl;

            size_t payload_bytes = payload->grid_data.size() * sizeof(float);
            std::cout << "BIN2D_AMR_FRAME " << payload_bytes << "\n";
            std::cout.write(reinterpret_cast<const char*>(payload->grid_data.data()), payload_bytes);
            std::cout.flush();

        } else if (payload->type == TelemetryPayload::TYPE_3D) {
            envelope["type"] = "TELEMETRY_3D";
            envelope["time"] = payload->elapsed;
            envelope["step"] = payload->step;
            envelope["dt"] = payload->dt;
            envelope["is_terminated"] = payload->is_terminated;
            envelope["wallclock"] = payload->wallclock;
            envelope["xmin"] = payload->xmin;
            envelope["ymin"] = payload->ymin;
            envelope["zmin"] = payload->zmin;
            envelope["dx"] = payload->dx;
            envelope["nx"] = payload->nx;
            envelope["ny"] = payload->ny;
            envelope["nz"] = payload->nz;
            envelope["total_mass"] = payload->total_mass;
            envelope["total_energy"] = payload->total_energy;
            envelope["is_ideal_gas"] = payload->is_ideal_gas;
            if (payload->has_gauges) {
                envelope["gauges_history"] = gh;
            }

            std::cout << envelope.dump() << std::endl;

            uint32_t magic = 0x43494c53; // "SLIC"
            float time_f = (float)payload->elapsed;
            uint32_t n_slices = payload->slices.size();

            size_t total_payload_bytes = 0;
            for (const auto& s : payload->slices) {
                total_payload_bytes += s.data.size() * sizeof(float);
            }

            size_t header_bytes = 12; // magic (4) + time (4) + n_slices (4)
            size_t slice_header_bytes = n_slices * 48; // (axis_id(4), offset(4), w(4), h(4), xmin(4), xmax(4), ymin(4), ymax(4), zmin(4), zmax(4), level(4), is_submesh(4))
            size_t total_bytes = header_bytes + slice_header_bytes + total_payload_bytes;

            std::cout << "BIN_FRAME_3D_SLICES " << total_bytes << "\n";
            std::cout.write(reinterpret_cast<const char*>(&magic), 4);
            std::cout.write(reinterpret_cast<const char*>(&time_f), 4);
            std::cout.write(reinterpret_cast<const char*>(&n_slices), 4);

            for (size_t i = 0; i < n_slices; ++i) {
                const auto& s = payload->slices[i];
                uint32_t axis_id = (s.axis == "xy" ? 0 : (s.axis == "xz" ? 1 : (s.axis == "yz" ? 2 : (s.axis == "obstacles" ? 3 : 4))));
                float offset = (float)s.offset;
                uint32_t w = s.w;
                uint32_t h = s.h;
                float xmin = s.xmin;
                float xmax = s.xmax;
                float ymin = s.ymin;
                float ymax = s.ymax;
                float zmin = s.zmin;
                float zmax = s.zmax;
                uint32_t level = s.level;
                uint32_t is_submesh = s.is_submesh ? 1 : 0;

                std::cout.write(reinterpret_cast<const char*>(&axis_id), 4);
                std::cout.write(reinterpret_cast<const char*>(&offset), 4);
                std::cout.write(reinterpret_cast<const char*>(&w), 4);
                std::cout.write(reinterpret_cast<const char*>(&h), 4);
                std::cout.write(reinterpret_cast<const char*>(&xmin), 4);
                std::cout.write(reinterpret_cast<const char*>(&xmax), 4);
                std::cout.write(reinterpret_cast<const char*>(&ymin), 4);
                std::cout.write(reinterpret_cast<const char*>(&ymax), 4);
                std::cout.write(reinterpret_cast<const char*>(&zmin), 4);
                std::cout.write(reinterpret_cast<const char*>(&zmax), 4);
                std::cout.write(reinterpret_cast<const char*>(&level), 4);
                std::cout.write(reinterpret_cast<const char*>(&is_submesh), 4);
                std::cout.write(reinterpret_cast<const char*>(s.data.data()), s.data.size() * sizeof(float));
            }
            std::cout.flush();

            if (!payload->mpm_particles.empty()) {
                const uint32_t magic = 0x4d504d33; // "MPM3"
                const float time_f = static_cast<float>(payload->elapsed);
                const uint32_t n_particles = static_cast<uint32_t>(payload->mpm_particles.size() / 13);
                const uint32_t n_floats_per_particle = 13;
                size_t particle_header_bytes = sizeof(uint32_t) * 3 + sizeof(float);
                size_t particle_payload_bytes = payload->mpm_particles.size() * sizeof(float);
                size_t total_particle_bytes = particle_header_bytes + particle_payload_bytes;

                std::cout << "BIN_MPM_3D_PARTICLES " << total_particle_bytes << "\n";
                std::cout.write(reinterpret_cast<const char*>(&magic), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(&time_f), sizeof(float));
                std::cout.write(reinterpret_cast<const char*>(&n_particles), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(&n_floats_per_particle), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(payload->mpm_particles.data()), particle_payload_bytes);
                std::cout.flush();
            }

            if (payload->fem_n_nodes > 0) {
                uint32_t magic = 0x46454d33; // "FEM3"
                float time_f = static_cast<float>(payload->elapsed);
                uint32_t n_nodes_u = payload->fem_n_nodes;
                uint32_t n_facets_u = payload->fem_n_facets;
                uint32_t n_floats_per_node = 7;
                uint32_t n_floats_per_facet = 8;
                size_t node_bytes = n_nodes_u * n_floats_per_node * sizeof(float);
                size_t facet_bytes = n_facets_u * n_floats_per_facet * sizeof(float);
                size_t header_bytes = sizeof(uint32_t) * 6;
                size_t total_bytes = header_bytes + node_bytes + facet_bytes;

                std::cout << "BIN_FEM_3D_MESH " << total_bytes << "\n";
                std::cout.write(reinterpret_cast<const char*>(&magic), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(&time_f), sizeof(float));
                std::cout.write(reinterpret_cast<const char*>(&n_nodes_u), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(&n_facets_u), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(&n_floats_per_node), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(&n_floats_per_facet), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(payload->fem_node_data.data()), node_bytes);
                std::cout.write(reinterpret_cast<const char*>(payload->fem_facet_data.data()), facet_bytes);
                std::cout.flush();
            }
        } else if (payload->type == TelemetryPayload::TYPE_FEM_3D) {
            envelope["type"] = "TELEMETRY_FEM_3D";
            envelope["time"] = payload->elapsed;
            envelope["dt"] = payload->dt;
            envelope["step"] = payload->fem_step;
            envelope["v_max"] = payload->fem_v_max;
            envelope["sig_max"] = payload->fem_sig_max;
            envelope["ep_max"] = payload->fem_ep_max;
            envelope["is_terminated"] = payload->is_terminated;
            if (!payload->fem_model_id.empty()) {
                envelope["modelId"] = payload->fem_model_id;
            }

            std::cout << envelope.dump() << std::endl;

            if (payload->fem_n_nodes > 0) {
                uint32_t magic = 0x46454d33; // "FEM3"
                float time_f = static_cast<float>(payload->elapsed);
                uint32_t n_nodes_u = payload->fem_n_nodes;
                uint32_t n_facets_u = payload->fem_n_facets;
                uint32_t n_floats_per_node = 7;
                uint32_t n_floats_per_facet = 8;
                size_t node_bytes = n_nodes_u * n_floats_per_node * sizeof(float);
                size_t facet_bytes = n_facets_u * n_floats_per_facet * sizeof(float);
                size_t header_bytes = sizeof(uint32_t) * 6;
                size_t total_bytes = header_bytes + node_bytes + facet_bytes;

                std::cout << "BIN_FEM_3D_MESH " << total_bytes << "\n";
                std::cout.write(reinterpret_cast<const char*>(&magic), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(&time_f), sizeof(float));
                std::cout.write(reinterpret_cast<const char*>(&n_nodes_u), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(&n_facets_u), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(&n_floats_per_node), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(&n_floats_per_facet), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(payload->fem_node_data.data()), node_bytes);
                std::cout.write(reinterpret_cast<const char*>(payload->fem_facet_data.data()), facet_bytes);
                std::cout.flush();
            }
        }
    }
}


void emit_telemetry(const CFDSolver& solver, double elapsed, bool is_terminated, int step) {
    auto payload = std::make_unique<TelemetryPayload>();
    payload->type = TelemetryPayload::TYPE_1D;
    payload->elapsed = elapsed;
    payload->dt = global_dt_1d;
    payload->step = (step >= 0) ? step : global_step_1d.load();
    payload->is_terminated = is_terminated;
    payload->wallclock = global_wallclock_1d.load();
    payload->n_cells = solver.getNumCells();
    payload->grid_data = solver.getTelemetryChannels();

    {
        std::lock_guard<std::mutex> g_lock(global_gauges_mutex);
        if (!global_gauges.empty()) {
            static auto last_gauge_emit_time = std::chrono::steady_clock::now();
            auto now = std::chrono::steady_clock::now();
            bool emit_gauges = is_terminated || (std::chrono::duration_cast<std::chrono::milliseconds>(now - last_gauge_emit_time).count() >= 250);
            if (emit_gauges) {
                payload->has_gauges = true;
                payload->gauge_times = global_gauge_times;
                payload->gauges_history = global_gauges_history;
                last_gauge_emit_time = now;
            }
        }
    }

    global_async_telemetry.push(std::move(payload));
}

void emit_telemetry_2d(double elapsed, bool is_terminated, int step) {
    if (!has_solver_2d()) return;

    int stride = global_telemetry_stride.load();
    if (stride < 1) stride = 1;

    int nr = 0, nz = 0;
    std::vector<float> downsampled;
    
    if (global_solver_2d_cuda) {
        downsampled = global_solver_2d_cuda->getTelemetry2D(stride);
        nr = global_solver_2d_cuda->getNr();
        nz = global_solver_2d_cuda->getNz();
    } else if (global_solver_2d) {
        downsampled = global_solver_2d->getTelemetry2D(stride);
        nr = global_solver_2d->getNr();
        nz = global_solver_2d->getNz();
    }

    int out_nr = (nr + stride - 1) / stride;
    int out_nz = (nz + stride - 1) / stride;

    auto payload = std::make_unique<TelemetryPayload>();
    payload->type = global_is_amr_2d ? TelemetryPayload::TYPE_2D_AMR : TelemetryPayload::TYPE_2D;
    payload->elapsed = elapsed;
    payload->dt = global_dt_2d;
    payload->step = (step >= 0) ? step : std::max(global_step_2d.load(), global_step_fsi_2d.load());
    payload->is_terminated = is_terminated;
    payload->out_nr = out_nr;
    payload->out_nz = out_nz;
    payload->wallclock = global_wallclock_2d.load();
    payload->grid_data = std::move(downsampled);
    payload->is_ideal_gas = global_solver_2d_cuda ? global_solver_2d_cuda->isIdealGas() : (global_solver_2d ? global_solver_2d->isIdealGas() : false);

    {
        std::lock_guard<std::mutex> g_lock(global_gauges_mutex);
        if (!global_gauges.empty()) {
            static auto last_gauge_emit_time = std::chrono::steady_clock::now();
            auto now = std::chrono::steady_clock::now();
            bool emit_gauges = is_terminated || (std::chrono::duration_cast<std::chrono::milliseconds>(now - last_gauge_emit_time).count() >= 250);
            if (emit_gauges) {
                void flush_solver_gauges_locked();
                flush_solver_gauges_locked();
                payload->has_gauges = true;
                payload->gauge_times = global_gauge_times;
                payload->gauges_history = global_gauges_history;
                last_gauge_emit_time = now;
            }
        }
    }

    global_async_telemetry.push(std::move(payload));
}

void emit_telemetry_mpm_2d(double elapsed, bool is_terminated, int step) {
    if (!global_solver_mpm_2d) return;

    int current_step = (step >= 0) ? step : std::max((global_solver_mpm_2d ? global_solver_mpm_2d->getStepCount() : 0), global_step_fsi_2d.load());

    nlohmann::json envelope;
    envelope["type"] = "TELEMETRY_MPM_2D";
    envelope["time"] = elapsed;
    envelope["step"] = current_step;
    envelope["dt"] = global_solver_mpm_2d->getLastDt();
    envelope["is_terminated"] = is_terminated;
    envelope["wallclock"] = 0.0;
    if (!global_model_id.empty()) {
        envelope["modelId"] = global_model_id;
    }
    {
        std::lock_guard<std::mutex> lock(cout_mutex);
        std::cout << envelope.dump() << std::endl;
    }

    int nr = global_solver_mpm_2d->getNx();
    int nz = global_solver_mpm_2d->getNy();
    if (nr <= 0 || nz <= 0) return;

    int n_ch = 7;
    size_t dest_stride = static_cast<size_t>(nr) * static_cast<size_t>(nz);
    std::vector<float> grid_data(n_ch * dest_stride, 0.0f);

    std::vector<float> press = global_solver_mpm_2d->getGridScalarField("pressure");
    std::vector<float> rho = global_solver_mpm_2d->getGridScalarField("density");
    std::vector<float> vm = global_solver_mpm_2d->getGridScalarField("von_mises");
    std::vector<float> ep = global_solver_mpm_2d->getGridScalarField("plastic_strain");
    std::vector<float> vel = global_solver_mpm_2d->getGridScalarField("velocity");

    for (int i = 0; i < nr; ++i) {
        for (int j = 0; j < nz; ++j) {
            int idx = i * nz + j;
            grid_data[0 * dest_stride + idx] = (idx < (int)press.size()) ? press[idx] : 0.0f;
            grid_data[1 * dest_stride + idx] = (idx < (int)rho.size()) ? rho[idx] : 0.0f;
            grid_data[2 * dest_stride + idx] = (idx < (int)vel.size()) ? vel[idx] : 0.0f;
            grid_data[3 * dest_stride + idx] = 0.0f;
            grid_data[4 * dest_stride + idx] = (idx < (int)vm.size()) ? vm[idx] : 0.0f;
            grid_data[5 * dest_stride + idx] = (idx < (int)ep.size()) ? ep[idx] : 0.0f;
            grid_data[6 * dest_stride + idx] = 0.0f;
        }
    }

    const auto& particles = global_solver_mpm_2d->getParticles();
    uint32_t n_particles_u = static_cast<uint32_t>(particles.size());
    std::vector<float> particle_data(n_particles_u * 2);
    for (size_t k = 0; k < particles.size(); ++k) {
        particle_data[k * 2 + 0] = particles[k].x[0];
        particle_data[k * 2 + 1] = particles[k].x[1];
    }

    const uint32_t out_nr_u = static_cast<uint32_t>(nr);
    const uint32_t out_nz_u = static_cast<uint32_t>(nz);
    const uint32_t n_channels_u = static_cast<uint32_t>(n_ch);
    size_t header_bytes  = sizeof(uint32_t) * 3;
    size_t payload_bytes = grid_data.size() * sizeof(float);
    size_t particle_hdr_bytes = sizeof(uint32_t);
    size_t particle_payload_bytes = particle_data.size() * sizeof(float);
    size_t total_bytes   = header_bytes + payload_bytes + particle_hdr_bytes + particle_payload_bytes;

    std::lock_guard<std::mutex> lock(cout_mutex);
    std::cout << "BIN_FRAME_2D " << total_bytes << "\n";
    std::cout.write(reinterpret_cast<const char*>(&out_nr_u),     sizeof(uint32_t));
    std::cout.write(reinterpret_cast<const char*>(&out_nz_u),     sizeof(uint32_t));
    std::cout.write(reinterpret_cast<const char*>(&n_channels_u), sizeof(uint32_t));
    std::cout.write(reinterpret_cast<const char*>(grid_data.data()), payload_bytes);
    std::cout.write(reinterpret_cast<const char*>(&n_particles_u), sizeof(uint32_t));
    if (n_particles_u > 0) {
        std::cout.write(reinterpret_cast<const char*>(particle_data.data()), particle_payload_bytes);
    }
    std::cout.flush();
}

static inline float getMPMGridQuantity(const Blast::MPMGridNode3D& node, const std::string& qty) {
    if (node.m <= 1.0e-14f) return 0.0f;
    if (qty == "plastic_strain") return node.plastic_strain;
    if (qty == "velocity") {
        float vx = node.v(0), vy = node.v(1), vz = node.v(2);
        return std::sqrt(vx * vx + vy * vy + vz * vz);
    }
    return node.plastic_strain;
}

void emit_telemetry_mpm_3d(double elapsed, bool is_terminated, int step) {
    if (!global_solver_mpm_3d && !global_solver_mpm_3d_cuda) return;

    if (global_solver_mpm_3d_cuda) {
        global_solver_mpm_3d_cuda->syncToHost();
    }

    double sim_time = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getSimTime() : (global_solver_mpm_3d ? global_solver_mpm_3d->getSimTime() : global_t3d);
    int mpm_step = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getStepCount() : (global_solver_mpm_3d ? global_solver_mpm_3d->getStepCount() : 0);
    int current_step = (step >= 0) ? step : std::max({mpm_step, global_step_fsi_3d.load(), global_step_3d.load()});
    float dt = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getLastDt() : global_solver_mpm_3d->getLastDt();
    float cfl = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getLastCFL() : global_solver_mpm_3d->getLastCFL();
    float v_max = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getMaxVelocity() : global_solver_mpm_3d->getMaxVelocity();
    const auto& particles = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getParticles() : global_solver_mpm_3d->getParticles();
    const auto& grid = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getGrid() : global_solver_mpm_3d->getGrid();
    int nx = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getNx() : global_solver_mpm_3d->getNx();
    int ny = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getNy() : global_solver_mpm_3d->getNy();
    int nz = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getNz() : global_solver_mpm_3d->getNz();
    float dx = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getDx() : global_solver_mpm_3d->getDx();
    float dy = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getDy() : global_solver_mpm_3d->getDy();
    float dz = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getDz() : global_solver_mpm_3d->getDz();

    size_t mpm_vram = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getAllocatedVRAM() : 0;
    char log_buf[256];
    if (mpm_vram > 0) {
        snprintf(log_buf, sizeof(log_buf),
                 "Step %d | Time = %.4e s | dt = %.2e s | CFL = %.2f | v_max = %.1f m/s | Particles = %zu (VRAM: %.2f MB)",
                 current_step, sim_time, dt, cfl, v_max, particles.size(), mpm_vram / (1024.0 * 1024.0));
    } else {
        snprintf(log_buf, sizeof(log_buf),
                 "Step %d | Time = %.4e s | dt = %.2e s | CFL = %.2f | v_max = %.1f m/s | Particles = %zu",
                 current_step, sim_time, dt, cfl, v_max, particles.size());
    }
    emit_kernel_log("SYSTEM", log_buf, sim_time, "mpm_3d", current_step);

    auto payload = std::make_unique<TelemetryPayload>();
    payload->type = TelemetryPayload::TYPE_3D;
    payload->elapsed = elapsed;
    payload->step = current_step;
    payload->dt = dt;
    payload->is_terminated = is_terminated;
    payload->wallclock = 0.0;
    payload->is_ideal_gas = false;
    float xmin_val = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getXMin() : global_solver_mpm_3d->getXMin();
    float ymin_val = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getYMin() : global_solver_mpm_3d->getYMin();
    float zmin_val = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getZMin() : global_solver_mpm_3d->getZMin();
    payload->xmin = xmin_val;
    payload->ymin = ymin_val;
    payload->zmin = zmin_val;
    payload->dx = dx;
    payload->nx = nx;
    payload->ny = ny;
    payload->nz = nz;

    std::vector<Slice3D> slices_to_use = global_slices_3d;
    if (slices_to_use.empty()) {
        Slice3D s;
        s.axis = "xy";
        s.offset = 0.5 * nz * dz;
        s.stride = 1;
        s.enabled = true;
        slices_to_use.push_back(s);
    }

    for (const auto& s : slices_to_use) {
        TelemetryPayload::SlicePayload sp;
        sp.axis = s.axis;
        sp.offset = s.offset;
        sp.stride = s.stride;
        float xmin_val = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getXMin() : global_solver_mpm_3d->getXMin();
        float ymin_val = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getYMin() : global_solver_mpm_3d->getYMin();
        float zmin_val = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getZMin() : global_solver_mpm_3d->getZMin();
        sp.xmin = xmin_val;
        sp.xmax = xmin_val + nx * dx;
        sp.ymin = ymin_val;
        sp.ymax = ymin_val + ny * dy;
        sp.zmin = zmin_val;
        sp.zmax = zmin_val + nz * dz;
        sp.level = 0;
        sp.is_submesh = false;

        std::string req_qty = (!s.quantities.empty()) ? s.quantities[0] : "von_mises";

        if (s.axis == "xy") {
            int k = std::clamp(static_cast<int>(s.offset / dz), 0, nz - 1);
            sp.w = nx;
            sp.h = ny;
            sp.data.resize(nx * ny);
            for (int j = 0; j < ny; ++j) {
                for (int i = 0; i < nx; ++i) {
                    int idx = (i * ny + j) * nz + k;
                    float val = (idx < (int)grid.size()) ? getMPMGridQuantity(grid[idx], req_qty) : 0.0f;
                    sp.data[i + j * nx] = val;
                }
            }
        } else if (s.axis == "xz") {
            int j_slice = std::clamp(static_cast<int>(s.offset / dy), 0, ny - 1);
            sp.w = nx;
            sp.h = nz;
            sp.data.resize(nx * nz);
            for (int k = 0; k < nz; ++k) {
                for (int i = 0; i < nx; ++i) {
                    int idx = (i * ny + j_slice) * nz + k;
                    float val = (idx < (int)grid.size()) ? getMPMGridQuantity(grid[idx], req_qty) : 0.0f;
                    sp.data[i + k * nx] = val;
                }
            }
        } else { // "yz" or volume fallback
            int i_slice = std::clamp(static_cast<int>(s.offset / dx), 0, nx - 1);
            sp.w = ny;
            sp.h = nz;
            sp.data.resize(ny * nz);
            for (int k = 0; k < nz; ++k) {
                for (int j = 0; j < ny; ++j) {
                    int idx = (i_slice * ny + j) * nz + k;
                    float val = (idx < (int)grid.size()) ? getMPMGridQuantity(grid[idx], req_qty) : 0.0f;
                    sp.data[j + k * ny] = val;
                }
            }
        }
        payload->slices.push_back(std::move(sp));
    }

    payload->mpm_particles.reserve(particles.size() * 10);
    for (const auto& p : particles) {
        float s00 = p.sigma[0][0], s11 = p.sigma[1][1], s22 = p.sigma[2][2];
        float s01 = p.sigma[0][1], s02 = p.sigma[0][2], s12 = p.sigma[1][2];
        float press = -(s00 + s11 + s22) / 3.0f;
        float dev00 = s00 + press, dev11 = s11 + press, dev22 = s22 + press;
        float vm_sq = dev00 * dev00 + dev11 * dev11 + dev22 * dev22 + 2.0f * (s01 * s01 + s02 * s02 + s12 * s12);
        float von_mises = std::sqrt(std::max(0.0f, 1.5f * vm_sq));

        float den = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getMaterialTable(p.object_id).density : global_solver_mpm_3d->getMaterialTable(p.object_id).density;
        payload->mpm_particles.push_back(p.x[0]);
        payload->mpm_particles.push_back(p.x[1]);
        payload->mpm_particles.push_back(p.x[2]);
        payload->mpm_particles.push_back(p.v[0]);
        payload->mpm_particles.push_back(p.v[1]);
        payload->mpm_particles.push_back(p.v[2]);
        payload->mpm_particles.push_back(von_mises);
        payload->mpm_particles.push_back(p.ep_bar);
        payload->mpm_particles.push_back(den);
        payload->mpm_particles.push_back(press);
        payload->mpm_particles.push_back(p.damage);
        payload->mpm_particles.push_back(p.has_failed ? 1.0f : 0.0f);
        payload->mpm_particles.push_back(static_cast<float>(p.object_id));
    }

    global_async_telemetry.push(std::move(payload));
}

void emit_telemetry_fem_3d(double elapsed, bool is_terminated, int step) {
    std::string m_id = global_model_id.empty() ? "default_fem" : global_model_id;

    Blast::FEMSolver3DCUDA<float>* cuda_fem_float = nullptr;
    if (global_fem_solvers_cuda_float.count(m_id) && global_fem_solvers_cuda_float[m_id]) {
        cuda_fem_float = global_fem_solvers_cuda_float[m_id].get();
    } else if (!global_fem_solvers_cuda_float.empty()) {
        cuda_fem_float = global_fem_solvers_cuda_float.begin()->second.get();
    }

    if (cuda_fem_float) {
        auto payload = std::make_unique<TelemetryPayload>();
        payload->type = TelemetryPayload::TYPE_FEM_3D;
        payload->elapsed = elapsed;
        payload->dt = static_cast<double>(cuda_fem_float->getLastDt());
        payload->step = (step >= 0) ? step : std::max(cuda_fem_float->getStepCount(), global_step_fem_fsi_3d.load());
        payload->fem_step = payload->step;
        payload->is_terminated = is_terminated;
        if (!global_model_id.empty()) {
            payload->fem_model_id = global_model_id;
        }
        size_t n_nodes = cuda_fem_float->getNodeCount();
        size_t n_facets = cuda_fem_float->getSurfaceFacetCount();
        payload->fem_n_nodes = static_cast<uint32_t>(n_nodes);
        payload->fem_n_facets = static_cast<uint32_t>(n_facets);
        if (n_nodes > 0) {
            cuda_fem_float->extractTelemetry(payload->fem_node_data, payload->fem_facet_data);
        }
        payload->fem_v_max = static_cast<double>(cuda_fem_float->getMaxVelocity());
        payload->fem_sig_max = static_cast<double>(cuda_fem_float->getMaxVonMisesStress());
        payload->fem_ep_max = static_cast<double>(cuda_fem_float->getMaxPlasticStrain());
        global_async_telemetry.push(std::move(payload));
        return;
    }

    Blast::FEMSolver3DCUDA<double>* cuda_fem_double = nullptr;
    if (global_fem_solvers_cuda_double.count(m_id) && global_fem_solvers_cuda_double[m_id]) {
        cuda_fem_double = global_fem_solvers_cuda_double[m_id].get();
    } else if (!global_fem_solvers_cuda_double.empty()) {
        cuda_fem_double = global_fem_solvers_cuda_double.begin()->second.get();
    }

    if (cuda_fem_double) {
        auto payload = std::make_unique<TelemetryPayload>();
        payload->type = TelemetryPayload::TYPE_FEM_3D;
        payload->elapsed = elapsed;
        payload->dt = cuda_fem_double->getLastDt();
        payload->step = (step >= 0) ? step : std::max(cuda_fem_double->getStepCount(), global_step_fem_fsi_3d.load());
        payload->fem_step = payload->step;
        payload->is_terminated = is_terminated;
        if (!global_model_id.empty()) {
            payload->fem_model_id = global_model_id;
        }
        size_t n_nodes = cuda_fem_double->getNodeCount();
        size_t n_facets = cuda_fem_double->getSurfaceFacetCount();
        payload->fem_n_nodes = static_cast<uint32_t>(n_nodes);
        payload->fem_n_facets = static_cast<uint32_t>(n_facets);
        if (n_nodes > 0) {
            cuda_fem_double->extractTelemetry(payload->fem_node_data, payload->fem_facet_data);
        }
        payload->fem_v_max = cuda_fem_double->getMaxVelocity();
        payload->fem_sig_max = cuda_fem_double->getMaxVonMisesStress();
        payload->fem_ep_max = cuda_fem_double->getMaxPlasticStrain();
        global_async_telemetry.push(std::move(payload));
        return;
    }

    Blast::FEMSolver3D<float>* fem_float = nullptr;
    Blast::FEMSolver3D<double>* fem_double = nullptr;

    if (global_fem_solvers_float.count(m_id) && global_fem_solvers_float[m_id]) {
        fem_float = global_fem_solvers_float[m_id].get();
    } else if (!global_fem_solvers_float.empty()) {
        fem_float = global_fem_solvers_float.begin()->second.get();
    }

    if (!fem_float && !fem_double) {
        if (global_fem_solvers_double.count(m_id) && global_fem_solvers_double[m_id]) {
            fem_double = global_fem_solvers_double[m_id].get();
        } else if (!global_fem_solvers_double.empty()) {
            fem_double = global_fem_solvers_double.begin()->second.get();
        }
    }

    if (!fem_float && !fem_double) return;

    auto payload = std::make_unique<TelemetryPayload>();
    payload->type = TelemetryPayload::TYPE_FEM_3D;
    payload->elapsed = elapsed;
    payload->dt = fem_float ? static_cast<double>(fem_float->getLastDt()) : fem_double->getLastDt();
    int fem_s = fem_float ? fem_float->getStepCount() : fem_double->getStepCount();
    payload->step = (step >= 0) ? step : std::max(fem_s, global_step_fem_fsi_3d.load());
    payload->fem_step = payload->step;
    payload->fem_v_max = fem_float ? static_cast<double>(fem_float->getMaxVelocity()) : fem_double->getMaxVelocity();
    payload->fem_sig_max = fem_float ? static_cast<double>(fem_float->getMaxVonMisesStress()) : fem_double->getMaxVonMisesStress();
    payload->fem_ep_max = fem_float ? static_cast<double>(fem_float->getMaxPlasticStrain()) : fem_double->getMaxPlasticStrain();
    payload->is_terminated = is_terminated;
    if (!global_model_id.empty()) {
        payload->fem_model_id = global_model_id;
    }

    size_t n_nodes = fem_float ? fem_float->getNodes().size() : fem_double->getNodes().size();
    size_t n_facets = fem_float ? fem_float->getSurfaceFacets().size() : fem_double->getSurfaceFacets().size();
    payload->fem_n_nodes = static_cast<uint32_t>(n_nodes);
    payload->fem_n_facets = static_cast<uint32_t>(n_facets);

    if (n_nodes > 0) {
        payload->fem_node_data.resize(n_nodes * 7);
        if (fem_float) {
            const auto& nodes = fem_float->getNodes();
            for (size_t i = 0; i < n_nodes; ++i) {
                float vx = static_cast<float>(nodes[i].v[0]);
                float vy = static_cast<float>(nodes[i].v[1]);
                float vz = static_cast<float>(nodes[i].v[2]);
                float v_mag = std::sqrt(vx * vx + vy * vy + vz * vz);
                payload->fem_node_data[i * 7 + 0] = static_cast<float>(nodes[i].x[0]);
                payload->fem_node_data[i * 7 + 1] = static_cast<float>(nodes[i].x[1]);
                payload->fem_node_data[i * 7 + 2] = static_cast<float>(nodes[i].x[2]);
                payload->fem_node_data[i * 7 + 3] = vx;
                payload->fem_node_data[i * 7 + 4] = vy;
                payload->fem_node_data[i * 7 + 5] = vz;
                payload->fem_node_data[i * 7 + 6] = v_mag;
            }
        } else {
            const auto& nodes = fem_double->getNodes();
            for (size_t i = 0; i < n_nodes; ++i) {
                float vx = static_cast<float>(nodes[i].v[0]);
                float vy = static_cast<float>(nodes[i].v[1]);
                float vz = static_cast<float>(nodes[i].v[2]);
                float v_mag = std::sqrt(vx * vx + vy * vy + vz * vz);
                payload->fem_node_data[i * 7 + 0] = static_cast<float>(nodes[i].x[0]);
                payload->fem_node_data[i * 7 + 1] = static_cast<float>(nodes[i].x[1]);
                payload->fem_node_data[i * 7 + 2] = static_cast<float>(nodes[i].x[2]);
                payload->fem_node_data[i * 7 + 3] = vx;
                payload->fem_node_data[i * 7 + 4] = vy;
                payload->fem_node_data[i * 7 + 5] = vz;
                payload->fem_node_data[i * 7 + 6] = v_mag;
            }
        }

        payload->fem_facet_data.resize(n_facets * 8);
        if (fem_float) {
            const auto& facets = fem_float->getSurfaceFacets();
            const auto& elements = fem_float->getElements();
            for (size_t f = 0; f < n_facets; ++f) {
                const auto& facet = facets[f];
                int elem_idx = facet.element_id;
                float vm = 0.0f, ep = 0.0f, press = 0.0f, dmg = 0.0f;
                if (elem_idx >= 0 && elem_idx < (int)elements.size()) {
                    const auto& elem = elements[elem_idx];
                    float s00 = elem.sigma[0][0], s11 = elem.sigma[1][1], s22 = elem.sigma[2][2];
                    float s01 = elem.sigma[0][1], s02 = elem.sigma[0][2], s12 = elem.sigma[1][2];
                    press = -(s00 + s11 + s22) / 3.0f;
                    float dev00 = s00 + press, dev11 = s11 + press, dev22 = s22 + press;
                    float vm_sq = dev00 * dev00 + dev11 * dev11 + dev22 * dev22 + 2.0f * (s01 * s01 + s02 * s02 + s12 * s12);
                    vm = std::sqrt(std::max(0.0f, 1.5f * vm_sq));
                    ep = elem.ep_bar;
                    dmg = elem.damage;
                }
                payload->fem_facet_data[f * 8 + 0] = static_cast<float>(facet.node_ids[0]);
                payload->fem_facet_data[f * 8 + 1] = static_cast<float>(facet.node_ids[1]);
                payload->fem_facet_data[f * 8 + 2] = static_cast<float>(facet.node_ids[2]);
                payload->fem_facet_data[f * 8 + 3] = static_cast<float>(facet.node_ids[3]);
                payload->fem_facet_data[f * 8 + 4] = vm;
                payload->fem_facet_data[f * 8 + 5] = ep;
                payload->fem_facet_data[f * 8 + 6] = press;
                payload->fem_facet_data[f * 8 + 7] = dmg;
            }
        } else {
            const auto& facets = fem_double->getSurfaceFacets();
            const auto& elements = fem_double->getElements();
            for (size_t f = 0; f < n_facets; ++f) {
                const auto& facet = facets[f];
                int elem_idx = facet.element_id;
                float vm = 0.0f, ep = 0.0f, press = 0.0f, dmg = 0.0f;
                if (elem_idx >= 0 && elem_idx < (int)elements.size()) {
                    const auto& elem = elements[elem_idx];
                    double s00 = elem.sigma[0][0], s11 = elem.sigma[1][1], s22 = elem.sigma[2][2];
                    double s01 = elem.sigma[0][1], s02 = elem.sigma[0][2], s12 = elem.sigma[1][2];
                    press = static_cast<float>(-(s00 + s11 + s22) / 3.0);
                    double dev00 = s00 + press, dev11 = s11 + press, dev22 = s22 + press;
                    double vm_sq = dev00 * dev00 + dev11 * dev11 + dev22 * dev22 + 2.0 * (s01 * s01 + s02 * s02 + s12 * s12);
                    vm = static_cast<float>(std::sqrt(std::max(0.0, 1.5 * vm_sq)));
                    ep = static_cast<float>(elem.ep_bar);
                    dmg = static_cast<float>(elem.damage);
                }
                payload->fem_facet_data[f * 8 + 0] = static_cast<float>(facet.node_ids[0]);
                payload->fem_facet_data[f * 8 + 1] = static_cast<float>(facet.node_ids[1]);
                payload->fem_facet_data[f * 8 + 2] = static_cast<float>(facet.node_ids[2]);
                payload->fem_facet_data[f * 8 + 3] = static_cast<float>(facet.node_ids[3]);
                payload->fem_facet_data[f * 8 + 4] = vm;
                payload->fem_facet_data[f * 8 + 5] = ep;
                payload->fem_facet_data[f * 8 + 6] = press;
                payload->fem_facet_data[f * 8 + 7] = dmg;
            }
        }
    }

    global_async_telemetry.push(std::move(payload));
}

void emit_telemetry_3d(double elapsed, bool is_terminated, int step) {
    if (!global_solver_3d) return;

    auto payload = std::make_unique<TelemetryPayload>();
    payload->type = TelemetryPayload::TYPE_3D;
    payload->elapsed = elapsed;
    payload->dt = global_dt_3d;
    payload->step = (step >= 0) ? step : std::max({global_step_3d.load(), global_step_fsi_3d.load(), global_step_fem_fsi_3d.load()});
    payload->is_terminated = is_terminated;
    payload->wallclock = global_wallclock_3d.load();
    payload->is_ideal_gas = global_solver_3d ? global_solver_3d->isIdealGas() : false;
    payload->xmin = global_solver_3d->getXMin();
    payload->ymin = global_solver_3d->getYMin();
    payload->zmin = global_solver_3d->getZMin();
    payload->dx = global_solver_3d->getCellSize();
    payload->nx = global_solver_3d->getNx();
    payload->ny = global_solver_3d->getNy();
    payload->nz = global_solver_3d->getNz();

    auto totals = global_solver_3d->getConservationTotals();
    payload->total_mass = totals.first;
    payload->total_energy = totals.second;

    if (global_solver_mpm_3d_cuda || global_solver_mpm_3d) {
        const auto& particles = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getParticles() : global_solver_mpm_3d->getParticles();
        if (!particles.empty()) {
            if (global_solver_mpm_3d_cuda) {
                global_solver_mpm_3d_cuda->syncParticlesToHost();
            }
            payload->mpm_particles.reserve(particles.size() * 13);
            for (const auto& p : particles) {
                float diff_xy = p.sigma[0][0] - p.sigma[1][1];
                float diff_yz = p.sigma[1][1] - p.sigma[2][2];
                float diff_zx = p.sigma[2][2] - p.sigma[0][0];
                float s_xy = p.sigma[0][1]; float s_yz = p.sigma[1][2]; float s_zx = p.sigma[2][0];
                float von_mises = std::sqrt(0.5f * (diff_xy * diff_xy + diff_yz * diff_yz + diff_zx * diff_zx) +
                                            3.0f * (s_xy * s_xy + s_yz * s_yz + s_zx * s_zx));
                float press = - (p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
                float den = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getMaterialTable(p.object_id).density : global_solver_mpm_3d->getMaterialTable(p.object_id).density;
                payload->mpm_particles.push_back(p.x[0]);
                payload->mpm_particles.push_back(p.x[1]);
                payload->mpm_particles.push_back(p.x[2]);
                payload->mpm_particles.push_back(p.v[0]);
                payload->mpm_particles.push_back(p.v[1]);
                payload->mpm_particles.push_back(p.v[2]);
                payload->mpm_particles.push_back(von_mises);
                payload->mpm_particles.push_back(p.ep_bar);
                payload->mpm_particles.push_back(den);
                payload->mpm_particles.push_back(press);
                payload->mpm_particles.push_back(p.damage);
                payload->mpm_particles.push_back(p.has_failed ? 1.0f : 0.0f);
                payload->mpm_particles.push_back(static_cast<float>(p.object_id));
            }
        }
    }

    std::string fem_m_id = global_model_id.empty() ? "default_fem" : global_model_id;
    Blast::FEMSolver3DCUDA<float>* cuda_fem_float = nullptr;
    Blast::FEMSolver3DCUDA<double>* cuda_fem_double = nullptr;
    Blast::FEMSolver3D<float>* fem_float = nullptr;
    Blast::FEMSolver3D<double>* fem_double = nullptr;

    if (global_fem_solvers_cuda_float.count(fem_m_id)) cuda_fem_float = global_fem_solvers_cuda_float[fem_m_id].get();
    else if (!global_fem_solvers_cuda_float.empty()) cuda_fem_float = global_fem_solvers_cuda_float.begin()->second.get();

    if (global_fem_solvers_cuda_double.count(fem_m_id)) cuda_fem_double = global_fem_solvers_cuda_double[fem_m_id].get();
    else if (!global_fem_solvers_cuda_double.empty()) cuda_fem_double = global_fem_solvers_cuda_double.begin()->second.get();

    if (global_fem_solvers_float.count(fem_m_id)) fem_float = global_fem_solvers_float[fem_m_id].get();
    else if (!global_fem_solvers_float.empty()) fem_float = global_fem_solvers_float.begin()->second.get();

    if (global_fem_solvers_double.count(fem_m_id)) fem_double = global_fem_solvers_double[fem_m_id].get();
    else if (!global_fem_solvers_double.empty()) fem_double = global_fem_solvers_double.begin()->second.get();

    if (cuda_fem_float) {
        size_t n_nodes = cuda_fem_float->getNodeCount();
        size_t n_facets = cuda_fem_float->getSurfaceFacetCount();
        payload->fem_n_nodes = static_cast<uint32_t>(n_nodes);
        payload->fem_n_facets = static_cast<uint32_t>(n_facets);
        if (n_nodes > 0) {
            cuda_fem_float->extractTelemetry(payload->fem_node_data, payload->fem_facet_data);
        }
        payload->fem_v_max = static_cast<double>(cuda_fem_float->getMaxVelocity());
        payload->fem_sig_max = static_cast<double>(cuda_fem_float->getMaxVonMisesStress());
        payload->fem_ep_max = static_cast<double>(cuda_fem_float->getMaxPlasticStrain());
    } else if (cuda_fem_double) {
        size_t n_nodes = cuda_fem_double->getNodeCount();
        size_t n_facets = cuda_fem_double->getSurfaceFacetCount();
        payload->fem_n_nodes = static_cast<uint32_t>(n_nodes);
        payload->fem_n_facets = static_cast<uint32_t>(n_facets);
        if (n_nodes > 0) {
            cuda_fem_double->extractTelemetry(payload->fem_node_data, payload->fem_facet_data);
        }
        payload->fem_v_max = cuda_fem_double->getMaxVelocity();
        payload->fem_sig_max = cuda_fem_double->getMaxVonMisesStress();
        payload->fem_ep_max = cuda_fem_double->getMaxPlasticStrain();
    } else if (fem_float) {
        size_t n_nodes = fem_float->getNodes().size();
        size_t n_facets = fem_float->getSurfaceFacets().size();
        payload->fem_n_nodes = static_cast<uint32_t>(n_nodes);
        payload->fem_n_facets = static_cast<uint32_t>(n_facets);
        if (n_nodes > 0) {
            payload->fem_node_data.resize(n_nodes * 7);
            const auto& nodes = fem_float->getNodes();
            for (size_t i = 0; i < n_nodes; ++i) {
                float vx = static_cast<float>(nodes[i].v[0]);
                float vy = static_cast<float>(nodes[i].v[1]);
                float vz = static_cast<float>(nodes[i].v[2]);
                float v_mag = std::sqrt(vx * vx + vy * vy + vz * vz);
                payload->fem_node_data[i * 7 + 0] = static_cast<float>(nodes[i].x[0]);
                payload->fem_node_data[i * 7 + 1] = static_cast<float>(nodes[i].x[1]);
                payload->fem_node_data[i * 7 + 2] = static_cast<float>(nodes[i].x[2]);
                payload->fem_node_data[i * 7 + 3] = vx;
                payload->fem_node_data[i * 7 + 4] = vy;
                payload->fem_node_data[i * 7 + 5] = vz;
                payload->fem_node_data[i * 7 + 6] = v_mag;
            }
            payload->fem_facet_data.resize(n_facets * 8);
            const auto& facets = fem_float->getSurfaceFacets();
            for (size_t i = 0; i < n_facets; ++i) {
                payload->fem_facet_data[i * 8 + 0] = static_cast<float>(facets[i].node_ids[0]);
                payload->fem_facet_data[i * 8 + 1] = static_cast<float>(facets[i].node_ids[1]);
                payload->fem_facet_data[i * 8 + 2] = static_cast<float>(facets[i].node_ids[2]);
                payload->fem_facet_data[i * 8 + 3] = static_cast<float>(facets[i].node_ids[3]);
                payload->fem_facet_data[i * 8 + 4] = facets[i].normal[0];
                payload->fem_facet_data[i * 8 + 5] = facets[i].normal[1];
                payload->fem_facet_data[i * 8 + 6] = facets[i].normal[2];
                payload->fem_facet_data[i * 8 + 7] = facets[i].area;
            }
        }
        payload->fem_v_max = static_cast<double>(fem_float->getMaxVelocity());
        payload->fem_sig_max = static_cast<double>(fem_float->getMaxVonMisesStress());
        payload->fem_ep_max = static_cast<double>(fem_float->getMaxPlasticStrain());
    } else if (fem_double) {
        size_t n_nodes = fem_double->getNodes().size();
        size_t n_facets = fem_double->getSurfaceFacets().size();
        payload->fem_n_nodes = static_cast<uint32_t>(n_nodes);
        payload->fem_n_facets = static_cast<uint32_t>(n_facets);
        if (n_nodes > 0) {
            payload->fem_node_data.resize(n_nodes * 7);
            const auto& nodes = fem_double->getNodes();
            for (size_t i = 0; i < n_nodes; ++i) {
                float vx = static_cast<float>(nodes[i].v[0]);
                float vy = static_cast<float>(nodes[i].v[1]);
                float vz = static_cast<float>(nodes[i].v[2]);
                float v_mag = std::sqrt(vx * vx + vy * vy + vz * vz);
                payload->fem_node_data[i * 7 + 0] = static_cast<float>(nodes[i].x[0]);
                payload->fem_node_data[i * 7 + 1] = static_cast<float>(nodes[i].x[1]);
                payload->fem_node_data[i * 7 + 2] = static_cast<float>(nodes[i].x[2]);
                payload->fem_node_data[i * 7 + 3] = vx;
                payload->fem_node_data[i * 7 + 4] = vy;
                payload->fem_node_data[i * 7 + 5] = vz;
                payload->fem_node_data[i * 7 + 6] = v_mag;
            }
            payload->fem_facet_data.resize(n_facets * 8);
            const auto& facets = fem_double->getSurfaceFacets();
            for (size_t i = 0; i < n_facets; ++i) {
                payload->fem_facet_data[i * 8 + 0] = static_cast<float>(facets[i].node_ids[0]);
                payload->fem_facet_data[i * 8 + 1] = static_cast<float>(facets[i].node_ids[1]);
                payload->fem_facet_data[i * 8 + 2] = static_cast<float>(facets[i].node_ids[2]);
                payload->fem_facet_data[i * 8 + 3] = static_cast<float>(facets[i].node_ids[3]);
                payload->fem_facet_data[i * 8 + 4] = static_cast<float>(facets[i].normal[0]);
                payload->fem_facet_data[i * 8 + 5] = static_cast<float>(facets[i].normal[1]);
                payload->fem_facet_data[i * 8 + 6] = static_cast<float>(facets[i].normal[2]);
                payload->fem_facet_data[i * 8 + 7] = static_cast<float>(facets[i].area);
            }
        }
        payload->fem_v_max = fem_double->getMaxVelocity();
        payload->fem_sig_max = fem_double->getMaxVonMisesStress();
        payload->fem_ep_max = fem_double->getMaxPlasticStrain();
    }

    {
        std::lock_guard<std::mutex> g_lock(global_gauges_mutex);
        if (!global_gauges.empty()) {
            static auto last_gauge_emit_time = std::chrono::steady_clock::now();
            auto now = std::chrono::steady_clock::now();
            bool emit_gauges = is_terminated || (std::chrono::duration_cast<std::chrono::milliseconds>(now - last_gauge_emit_time).count() >= 250);
            if (emit_gauges) {
                void flush_solver_gauges_locked();
                flush_solver_gauges_locked();
                payload->has_gauges = true;
                payload->gauge_times = global_gauge_times;
                payload->gauges_history = global_gauges_history;
                last_gauge_emit_time = now;
            }
        }
    }

    for (const auto& s : global_slices_3d) {
        uint32_t axis_id = (s.axis == "xy" ? 0 : (s.axis == "xz" ? 1 : (s.axis == "yz" ? 2 : (s.axis == "obstacles" ? 3 : 4))));
        if (axis_id == 3) {
            TelemetryPayload::SlicePayload sp;
            sp.axis = s.axis;
            sp.offset = s.offset;
            sp.stride = s.stride;
            sp.data = global_solver_3d->extractSlice(s);
            sp.w = sp.data.size();
            sp.h = 1;
            sp.xmin = (float)global_solver_3d->getXMin();
            sp.xmax = (float)(global_solver_3d->getXMin() + global_solver_3d->getNx() * global_solver_3d->getCellSize());
            sp.ymin = (float)global_solver_3d->getYMin();
            sp.ymax = (float)(global_solver_3d->getYMin() + global_solver_3d->getNy() * global_solver_3d->getCellSize());
            sp.zmin = (float)global_solver_3d->getZMin();
            sp.zmax = (float)(global_solver_3d->getZMin() + global_solver_3d->getNz() * global_solver_3d->getCellSize());
            sp.level = 0;
            sp.is_submesh = false;
            payload->slices.push_back(std::move(sp));
        } else if (axis_id == 4) {
            TelemetryPayload::SlicePayload sp;
            sp.axis = s.axis;
            sp.offset = s.offset;
            sp.stride = s.stride;
            sp.data = global_solver_3d->extractSlice(s);
            int w = 0, h = 0, depth = 1;
            global_solver_3d->getSliceDimensions(s, w, h, depth);
            sp.w = w;
            sp.h = h;
            sp.offset = (double)depth;
            sp.xmin = (float)global_solver_3d->getXMin();
            sp.xmax = (float)(global_solver_3d->getXMin() + global_solver_3d->getNx() * global_solver_3d->getCellSize());
            sp.ymin = (float)global_solver_3d->getYMin();
            sp.ymax = (float)(global_solver_3d->getYMin() + global_solver_3d->getNy() * global_solver_3d->getCellSize());
            sp.zmin = (float)global_solver_3d->getZMin();
            sp.zmax = (float)(global_solver_3d->getZMin() + global_solver_3d->getNz() * global_solver_3d->getCellSize());
            sp.level = 0;
            sp.is_submesh = false;
            payload->slices.push_back(std::move(sp));
        } else {
            std::vector<SlicePayload3D> all_slices = global_solver_3d->extractAllSlices(s);
            for (auto& ps : all_slices) {
                TelemetryPayload::SlicePayload sp;
                sp.axis = ps.axis;
                sp.offset = ps.offset;
                sp.stride = ps.stride;
                sp.data = std::move(ps.data);
                sp.w = ps.w;
                sp.h = ps.h;
                sp.xmin = (float)ps.xmin;
                sp.xmax = (float)ps.xmax;
                sp.ymin = (float)ps.ymin;
                sp.ymax = (float)ps.ymax;
                sp.zmin = (float)ps.zmin;
                sp.zmax = (float)ps.zmax;
                sp.level = ps.level;
                sp.is_submesh = false;
                payload->slices.push_back(std::move(sp));
            }
        }
    }

    global_async_telemetry.push(std::move(payload));
}

MultiMat::MaterialSet parseMaterialSet(const nlohmann::json& msg) {
    std::string composition = msg.value("composition", "TNT");
    MultiMat::MaterialSet matSet = MultiMat::TNT;
    if      (composition == "PETN") matSet = MultiMat::PETN;
    else if (composition == "RDX")  matSet = MultiMat::RDX;
    else if (composition == "TNT")  matSet = MultiMat::TNT;
    else {
        double jwl_A     = msg.value("jwl_A",     373.77e9);
        double jwl_B     = msg.value("jwl_B",     3.747e9);
        double jwl_R1    = msg.value("jwl_R1",    4.15);
        double jwl_R2    = msg.value("jwl_R2",    0.90);
        double jwl_omega = msg.value("jwl_omega", 0.35);
        double high_rho  = msg.value("rho",       1630.0);
        double det_vel   = msg.value("det_vel",   6930.0);
        double det_energy= msg.value("detonation_energy", 4.29e6);
        MultiMat::JWLParams products = { jwl_A, jwl_B, jwl_R1, jwl_R2, jwl_omega, high_rho, 1000.0, 300.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0 };
        matSet.products = products;

        // Estimate unreacted solid parameters to keep initial state physically correct and stable
        // A typical stable unreacted JWL has:
        // A_u ~ 770 GPa, B_u ~ -4.8 GPa, R1_u ~ 10.5, R2_u ~ 1.1, omega_u ~ 0.89
        // Scaling with density allows handling low/high density custom mixtures/presets correctly.
        double unreacted_A = 770.0e9 * (high_rho / 1800.0);
        double unreacted_B = -4.8e9 * (high_rho / 1800.0);
        double unreacted_R1 = 10.5;
        double unreacted_R2 = 1.1;
        double unreacted_omega = 0.89;
        MultiMat::JWLParams unreacted = { unreacted_A, unreacted_B, unreacted_R1, unreacted_R2, unreacted_omega, high_rho, 1000.0, 300.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0 };
        matSet.unreacted = unreacted;

        matSet.det_vel   = det_vel;
        matSet.detonation_energy = det_energy;
    }
    MultiMat::initializePrecalculatedTerms(matSet);
    return matSet;
}

int main() {
    std::string line;

    std::thread telemetry_thread(async_telemetry_thread_func);

    static std::atomic<bool> global_pulse_cancel{false};
    std::thread pulse_thread([]() {
        while (!global_pulse_cancel.load()) {
            for (int i = 0; i < 10 && !global_pulse_cancel.load(); ++i) {
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
            }
            if (!global_pulse_cancel.load()) {
                emit_resource_pulse();
            }
        }
    });

    std::thread stdin_listener_thread([]() {
        std::string line;
        while (std::getline(std::cin, line)) {
            if (line.empty()) continue;

            try {
                nlohmann::json msg = nlohmann::json::parse(line);
                std::string command = msg.value("command", "");
                if (command.rfind("INIT", 0) == 0 || command.rfind("REMAP", 0) == 0) {
                    global_last_valid_nvml_vram = 0;
                }
                if (msg.contains("modelId")) {
                    global_model_id = msg.value("modelId", "");
                }

                if (command == "INIT") {
                    sim_terminate = true;
                    while (sim_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    sim_terminate = false;
                    sim_paused = false;
                    step_progress = 0;
                    global_step_1d = 0;
                    global_wallclock_1d = 0.0;

                    int n_cells = msg.at("n_cells").get<int>();
                    double radius = msg.at("domain_radius").get<double>();
                    double gamma = msg.at("gamma").get<double>();

                    global_num_cells = n_cells;
                    global_t = 0.0;

                    std::string init_mode   = msg.value("init_mode",   "Multi-Material JWL");
                    std::string composition  = msg.value("composition", "TNT");
                    std::string explosive_type = msg.value("explosive_type", "");

                    std::string precision = msg.value("precision", "double");
                    if (precision == "single" || precision == "float") {
                        if (init_mode == "Ideal Gas" || explosive_type == "MaterialIdealGas") {
                            global_solver = std::make_unique<CFDSolverImpl<float, false>>(n_cells, radius, gamma);
                        } else {
                            global_solver = std::make_unique<CFDSolverImpl<float, true>>(n_cells, radius, gamma);
                        }
                    } else {
                        if (init_mode == "Ideal Gas" || explosive_type == "MaterialIdealGas") {
                            global_solver = std::make_unique<CFDSolverImpl<double, false>>(n_cells, radius, gamma);
                        } else {
                            global_solver = std::make_unique<CFDSolverImpl<double, true>>(n_cells, radius, gamma);
                        }
                    }

                    // Set boundary conditions
                    std::string left_bc_str = msg.value("left_bc", "Transmitting");
                    std::string right_bc_str = msg.value("right_bc", "Transmitting");
                    auto map_bc_1d = [](const std::string& str) {
                        if (str == "Transmitting" || str == "transmitting" || str == "TRANSMISSIVE" || str == "transmissive" || str == "Terminate" || str == "terminate") {
                            return CFDSolver::TRANSMISSIVE;
                        } else {
                            return CFDSolver::REFLECTIVE;
                        }
                    };
                    global_solver->setBCTypes(map_bc_1d(left_bc_str), map_bc_1d(right_bc_str));

                    global_solver->setFluxScheme(msg.at("flux_scheme").get<std::string>());
                    global_solver->setSpatialOrder(msg.at("spatial_order").get<int>());
                    global_solver->setTemporalOrder(msg.at("temporal_order").get<int>());

                    // 1D Nodegraph validation check
                    std::vector<std::string> missing_elements;
                    if (!msg.contains("nodes") || !msg.contains("connections")) {
                        missing_elements.push_back("Missing DAG nodes/connections");
                    } else {
                        bool has_solver = false;
                        std::string solver_id = "";
                        for (const auto& node : msg["nodes"]) {
                            if (node.value("type", "") == "CFDSolver") {
                                has_solver = true;
                                solver_id = node.value("id", "");
                                break;
                            }
                        }
                        if (!has_solver) {
                            missing_elements.push_back("CFDSolver node");
                        } else {
                            std::string painter_id = "";
                            for (const auto& conn : msg["connections"]) {
                                if (conn.value("toNode", "") == solver_id && conn.value("toPort", "") == "in") {
                                    painter_id = conn.value("fromNode", "");
                                    break;
                                }
                            }
                            if (painter_id.empty()) {
                                missing_elements.push_back("Connection from ThePainter to CFDSolver");
                            } else {
                                bool has_painter = false;
                                for (const auto& node : msg["nodes"]) {
                                    if (node.value("id", "") == painter_id && node.value("type", "") == "ThePainter") {
                                        has_painter = true;
                                        break;
                                    }
                                }
                                if (!has_painter) {
                                    missing_elements.push_back("ThePainter node");
                                } else {
                                    bool has_mesh = false;
                                    bool has_air = false;
                                    bool has_explosive = false;
                                    std::string charge_id = "";
                                    for (const auto& conn : msg["connections"]) {
                                        if (conn.value("toNode", "") == painter_id) {
                                            std::string port = conn.value("toPort", "");
                                            std::string from = conn.value("fromNode", "");
                                            if (port == "mesh") {
                                                for (const auto& n : msg["nodes"]) {
                                                    if (n.value("id", "") == from && n.value("type", "") == "DomainMesh") {
                                                        has_mesh = true;
                                                    }
                                                }
                                            } else if (port == "air") {
                                                for (const auto& n : msg["nodes"]) {
                                                    if (n.value("id", "") == from && n.value("type", "") == "Material" && n.value("parameters", nlohmann::json::object()).value("material_type", "") == "Air") {
                                                        has_air = true;
                                                    }
                                                }
                                            } else if (port == "explosive") {
                                                for (const auto& n : msg["nodes"]) {
                                                    if (n.value("id", "") == from && n.value("type", "") == "Charge1D") {
                                                        has_explosive = true;
                                                        charge_id = from;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    if (!has_mesh) missing_elements.push_back("DomainMesh connected to ThePainter");
                                    if (!has_air) missing_elements.push_back("Material (Air) connected to ThePainter");
                                    if (!has_explosive) {
                                        missing_elements.push_back("Charge1D connected to ThePainter");
                                    } else if (!charge_id.empty()) {
                                        bool has_charge_material = false;
                                        for (const auto& conn : msg["connections"]) {
                                            if (conn.value("toNode", "") == charge_id && conn.value("toPort", "") == "material") {
                                                std::string from = conn.value("fromNode", "");
                                                for (const auto& n : msg["nodes"]) {
                                                    if (n.value("id", "") == from && n.value("type", "") == "Material") {
                                                        has_charge_material = true;
                                                    }
                                                }
                                            }
                                        }
                                        if (!has_charge_material) missing_elements.push_back("Material connected to Charge1D");
                                    }
                                }
                            }
                        }
                    }
                    if (!missing_elements.empty()) {
                        std::string warn_msg = "Incomplete 1D nodegraph. Missing elements: ";
                        for (size_t i = 0; i < missing_elements.size(); ++i) {
                            warn_msg += missing_elements[i] + (i == missing_elements.size() - 1 ? "" : ", ");
                        }
                        emit_kernel_log("WARNING", warn_msg, global_t, "1d");
                    }

                    double explosive_radius = msg.at("explosive_radius").get<double>();
                    double high_rho         = msg.at("rho").get<double>();
                    double ambient_rho      = msg.at("ambient_rho").get<double>();
                    double ambient_p        = msg.at("atm_pressure").get<double>();

                    MultiMat::MaterialSet matSet = parseMaterialSet(msg);
                    global_solver->setMaterialParameters(matSet);

                    if (init_mode == "Ideal Gas" || explosive_type == "MaterialIdealGas") {
                        double det_energy = msg.value("detonation_energy", 4520000.0);
                        global_solver->setInitialConditionIdealGas(explosive_radius, high_rho, det_energy, ambient_rho, ambient_p);
                    } else {
                        global_solver->setInitialConditionTNT(explosive_radius, high_rho, ambient_rho, ambient_p);
                    }

                    init_gauges(msg);
                    record_gauges_1d(global_t);

                    emit_telemetry(*global_solver, global_t, false);
                    emit_kernel_log("SYSTEM", "Solver ready. Zero-Omission binding complete.", global_t, "1d");

                } else if (command == "STEP") {
                    if (!global_solver) continue;
                    int steps = msg.at("steps").get<int>();
                    global_cfl = msg.value("cfl", 0.4);
                    global_exec_until_end = false;
                    if (!sim_running) {
                        global_target_steps = steps;
                        sim_running = true;
                        sim_paused = false;
                        sim_terminate = false;
                        std::thread(worker_thread_func).detach();
                    } else {
                        global_target_steps.fetch_add(steps);
                        sim_paused = false;
                    }
                } else if (command == "EXEC_ALL" || command == "EXEC_END") {
                    if (!global_solver) continue;
                    global_cfl = msg.value("cfl", 0.4);
                    global_exec_until_end = true;
                    if (!sim_running) {
                        sim_running = true;
                        sim_paused = false;
                        sim_terminate = false;
                        std::thread(worker_thread_func).detach();
                    } else { sim_paused = false; }
                } else if (command == "PAUSE") {
                    sim_paused = true;
                    global_target_steps = 0;
                } else if (command == "RESUME") {
                    sim_paused = false;
                } else if (command == "TERMINATE") {
                    sim_terminate = true;
                    while (sim_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver.reset();
                    global_num_cells = 0;
                    global_t = 0.0;
                    global_wallclock_1d = 0.0;
                    step_progress = 0;
                } else if (command == "INIT_2D") {
                    sim2d_terminate = true;
                    while (sim2d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_2d.reset();
                    global_solver_2d_cuda.reset();
                    sim2d_terminate = false;
                    sim2d_paused = false;
                    step_progress_2d = 0;
                    global_step_2d = 0;
                    global_wallclock_2d = 0.0;

                    // 2D Nodegraph validation check
                    std::vector<std::string> missing_elements_2d;
                    std::string init_mode_2d = msg.value("init_mode", "From1D");
                    if (!msg.contains("nodes") || !msg.contains("connections")) {
                        missing_elements_2d.push_back("Missing DAG nodes/connections");
                    } else {
                        bool has_solver2d = false;
                        std::string solver2d_id = "";
                        for (const auto& node : msg["nodes"]) {
                            if (node.value("type", "") == "CFDSolver2D") {
                                has_solver2d = true;
                                solver2d_id = node.value("id", "");
                                break;
                            }
                        }
                        if (!has_solver2d) {
                            missing_elements_2d.push_back("CFDSolver2D node");
                        } else {
                            bool has_mesh2d = false;
                            bool has_air2d = false;
                            bool has_charge = false;
                            bool has_detonator = false;
                            bool has_remap = false;
                            std::string charge2d_id = "";
                            std::string remap_id = "";

                            for (const auto& conn : msg["connections"]) {
                                if (conn.value("toNode", "") == solver2d_id) {
                                    std::string port = conn.value("toPort", "");
                                    std::string from = conn.value("fromNode", "");
                                    if (port == "mesh") {
                                        for (const auto& n : msg["nodes"]) {
                                            if (n.value("id", "") == from && n.value("type", "") == "DomainMesh2D") {
                                                has_mesh2d = true;
                                            }
                                        }
                                    } else if (port == "air") {
                                        for (const auto& n : msg["nodes"]) {
                                            if (n.value("id", "") == from && n.value("type", "") == "Material" && n.value("parameters", nlohmann::json::object()).value("material_type", "") == "Air") {
                                                has_air2d = true;
                                            }
                                        }
                                    } else if (port == "charge" || port == "explosive") {
                                        for (const auto& n : msg["nodes"]) {
                                            if (n.value("id", "") == from && (n.value("type", "") == "Charge2D" || n.value("type", "") == "Charge1D")) {
                                                has_charge = true;
                                                charge2d_id = from;
                                            }
                                        }
                                    } else if (port == "detonator") {
                                        for (const auto& n : msg["nodes"]) {
                                            if (n.value("id", "") == from && n.value("type", "") == "DetonatorLocation") {
                                                has_detonator = true;
                                            }
                                        }
                                    } else if (port == "remap") {
                                        for (const auto& n : msg["nodes"]) {
                                            if (n.value("id", "") == from && n.value("type", "") == "RemapNode") {
                                                has_remap = true;
                                                remap_id = from;
                                            }
                                        }
                                    }
                                }
                            }

                            if (!has_mesh2d) {
                                missing_elements_2d.push_back("DomainMesh2D connected to CFD Solver 2D");
                            }

                            if (init_mode_2d == "From1D") {
                                if (!has_remap) {
                                    missing_elements_2d.push_back("RemapNode connected to CFD Solver 2D");
                                } else {
                                    // Check if RemapNode has connection from CFDSolver (1D)
                                    bool remap_has_1d_solver = false;
                                    for (const auto& conn : msg["connections"]) {
                                        if (conn.value("toNode", "") == remap_id && conn.value("toPort", "") == "in") {
                                            std::string from = conn.value("fromNode", "");
                                            for (const auto& n : msg["nodes"]) {
                                                if (n.value("id", "") == from && n.value("type", "") == "CFDSolver") {
                                                    remap_has_1d_solver = true;
                                                }
                                            }
                                        }
                                    }
                                    if (!remap_has_1d_solver) {
                                        missing_elements_2d.push_back("CFDSolver (1D) connected to RemapNode");
                                    }
                                }
                            } else {
                                if (!has_air2d) {
                                    missing_elements_2d.push_back("Material (Air) connected to CFD Solver 2D");
                                }
                                if (!has_charge) {
                                    missing_elements_2d.push_back("Charge node connected to CFD Solver 2D");
                                } else if (!charge2d_id.empty()) {
                                    bool has_charge_material = false;
                                    for (const auto& conn : msg["connections"]) {
                                        if (conn.value("toNode", "") == charge2d_id && conn.value("toPort", "") == "material") {
                                            std::string from = conn.value("fromNode", "");
                                            for (const auto& n : msg["nodes"]) {
                                                if (n.value("id", "") == from && n.value("type", "") == "Material") {
                                                    has_charge_material = true;
                                                }
                                            }
                                        }
                                    }
                                    if (!has_charge_material) {
                                        missing_elements_2d.push_back("Material connected to Charge node");
                                    }
                                }
                                if (!has_detonator) {
                                    missing_elements_2d.push_back("DetonatorLocation connected to CFD Solver 2D");
                                }
                            }
                        }
                    }
                    if (!missing_elements_2d.empty()) {
                        std::string warn_msg = "Incomplete 2D nodegraph. Missing elements: ";
                        for (size_t i = 0; i < missing_elements_2d.size(); ++i) {
                            warn_msg += missing_elements_2d[i] + (i == missing_elements_2d.size() - 1 ? "" : ", ");
                        }
                        emit_kernel_log("WARNING", warn_msg, global_t2d, "2d");
                    }
                    
                    int nr = msg.value("nr", 100);
                    int nz = msg.value("nz", 100);
                    double max_r = msg.value("max_r", 1.0);
                    double max_z = msg.value("max_z", 1.0);
                    std::string device = msg.value("device", "cpu");
                    double gamma = msg.value("gamma", 1.4);
                    double cfl = msg.value("cfl", 0.35);
                    global_cfl_2d = cfl;
                    
                    std::string flux_scheme = msg.value("flux_scheme", "AUSM+");
                    int spatial_order = msg.value("spatial_order", 2);
                    int temporal_order = msg.value("temporal_order", 2);
                    std::string composition = msg.value("composition", "TNT");
                    std::string coord_sys = msg.value("coordinate_system", "Axisymmetric");

                    std::string bc_r_min_str = msg.value("bc_r_min", "Reflecting");
                    std::string bc_r_max_str = msg.value("bc_r_max", "Terminate");
                    std::string bc_z_min_str = msg.value("bc_z_min", "Reflecting");
                    std::string bc_z_max_str = msg.value("bc_z_max", "Terminate");

                    auto map_bc_2d = [](const std::string& str) {
                        if (str == "Transmitting" || str == "transmitting" || str == "TRANSMISSIVE" || str == "transmissive") {
                            return CFDSolver2D::TRANSMISSIVE;
                        } else if (str == "Riemann" || str == "riemann" || str == "Terminate" || str == "terminate" || str == "OUTFLOW_RIEMANN" || str == "outflow_riemann") {
                            return CFDSolver2D::OUTFLOW_RIEMANN;
                        } else {
                            return CFDSolver2D::REFLECTIVE;
                        }
                    };

                    CFDSolver2D::BCType r_min_bc = map_bc_2d(bc_r_min_str);
                    CFDSolver2D::BCType r_max_bc = map_bc_2d(bc_r_max_str);
                    CFDSolver2D::BCType z_min_bc = map_bc_2d(bc_z_min_str);
                    CFDSolver2D::BCType z_max_bc = map_bc_2d(bc_z_max_str);

                    if (coord_sys == "Axisymmetric") {
                        if (r_min_bc != CFDSolver2D::REFLECTIVE) {
                            std::cout << "[INFO] Forcing R-Min boundary to Reflecting (Axisymmetric centerline)." << std::endl;
                            r_min_bc = CFDSolver2D::REFLECTIVE;
                        }
                    }

                    MultiMat::MaterialSet matSet = parseMaterialSet(msg);

                    global_t2d = 0.0;
                    global_dt_2d = 0.0;

                    std::string mesh_type = msg.value("mesh_type", "regular");
                    global_is_amr_2d = (mesh_type == "amr");
                    int amr_max_levels = get_json_int(msg, "amr_max_levels", 3);
                    double amr_threshold = get_json_double(msg, "amr_threshold", 0.05);
                    double amr_coarsen_ratio = get_json_double(msg, "amr_coarsen_ratio", 0.4);

                    amr_max_levels = std::clamp(amr_max_levels, 1, 6);
                    if (amr_threshold <= 0.0 || std::isnan(amr_threshold)) amr_threshold = 0.05;
                    if (amr_coarsen_ratio <= 0.0 || std::isnan(amr_coarsen_ratio)) amr_coarsen_ratio = 0.4;
                    amr_coarsen_ratio = std::clamp(amr_coarsen_ratio, 0.1, 0.9);

                    std::string precision = msg.value("precision", "double");
                    select_cuda_device(device);
                    if (is_cuda_device(device)) {
                        {
                            std::lock_guard<std::mutex> lock(cout_mutex);
                            global_solver_2d.reset();
                            global_solver_2d_cuda.reset();
                            if (precision == "single" || precision == "float") {
                                if (mesh_type == "amr") {
                                    global_solver_2d_cuda = std::make_unique<CFDSolver2DAMRCudaImpl<float>>(nr, nz, max_r, max_z, gamma, amr_max_levels, amr_threshold, amr_coarsen_ratio);
                                } else {
                                    global_solver_2d_cuda = std::make_unique<CFDSolver2DCudaImpl<float>>(nr, nz, max_r, max_z, gamma);
                                }
                            } else {
                                if (mesh_type == "amr") {
                                    global_solver_2d_cuda = std::make_unique<CFDSolver2DAMRCudaImpl<double>>(nr, nz, max_r, max_z, gamma, amr_max_levels, amr_threshold, amr_coarsen_ratio);
                                } else {
                                    global_solver_2d_cuda = std::make_unique<CFDSolver2DCudaImpl<double>>(nr, nz, max_r, max_z, gamma);
                                }
                            }
                        }
                        
                        global_solver_2d_cuda->setFluxScheme(flux_scheme);
                        global_solver_2d_cuda->setSpatialOrder(spatial_order);
                        global_solver_2d_cuda->setTemporalOrder(temporal_order);
                        global_solver_2d_cuda->setBCTypes(
                            static_cast<CFDSolver2DCuda::BCType>(r_min_bc),
                            static_cast<CFDSolver2DCuda::BCType>(r_max_bc),
                            static_cast<CFDSolver2DCuda::BCType>(z_min_bc),
                            static_cast<CFDSolver2DCuda::BCType>(z_max_bc)
                        );
                        global_solver_2d_cuda->setMaterialParameters(matSet);

                        std::string init_mode = msg.value("init_mode", "Ideal Gas");
                        if (init_mode == "Ideal Gas" || msg.value("explosive_type", "") == "MaterialIdealGas") {
                            double det_energy = msg.value("detonation_energy", 4520000.0);
                            double high_rho = msg.value("high_rho", msg.value("rho", 1630.0));
                            double ambient_rho = msg.value("ambient_rho", 1.225648589);
                            double ambient_p = msg.value("atm_pressure", msg.value("ambient_p", 101325.0));
                            double explosive_z = msg.value("charge_z", msg.value("explosive_z", 0.0));
                            double explosive_radius = msg.value("charge_radius", msg.value("explosive_radius", 0.1));
                            
                            double detonator_r = msg.value("detonator_r", 0.0);
                            double detonator_z = msg.value("detonator_z", explosive_z);
                            global_solver_2d_cuda->setDetonatorLocation(detonator_r, detonator_z);
                            global_solver_2d_cuda->setInitialConditionIdealGas(explosive_z, explosive_radius, high_rho, det_energy, ambient_rho, ambient_p);
                        } else if (init_mode == "Multi-Material JWL" || init_mode == "JWL") {
                            double high_rho = msg.value("high_rho", msg.value("rho", 1630.0));
                            double ambient_rho = msg.value("ambient_rho", 1.225648589);
                            double ambient_p = msg.value("atm_pressure", msg.value("ambient_p", 101325.0));
                            double explosive_z = msg.value("charge_z", msg.value("explosive_z", 0.0));
                            double explosive_radius = msg.value("charge_radius", msg.value("explosive_radius", 0.1));
                            
                            std::string charge_shape = msg.value("charge_shape", "Sphere");
                            if (charge_shape == "Cylinder" || charge_shape == "cylinder") {
                                double charge_radius = msg.value("charge_radius", 0.1);
                                double charge_height = msg.value("charge_height", 0.2);
                                if (msg.contains("charge_aspect_ratio") && !msg.contains("charge_height")) {
                                    double ar = msg.value("charge_aspect_ratio", 1.0);
                                    if (ar > 0.0) charge_height = 2.0 * charge_radius * ar;
                                }
                                double detonator_r = msg.value("detonator_r", 0.0);
                                double detonator_z = msg.value("detonator_z", explosive_z + charge_height / 2.0);
                                global_solver_2d_cuda->setDetonatorLocation(detonator_r, detonator_z);
                                global_solver_2d_cuda->setInitialConditionTNTCylinder(explosive_z, charge_radius, charge_height, high_rho, ambient_rho, ambient_p);
                            } else {
                                double detonator_r = msg.value("detonator_r", 0.0);
                                double detonator_z = msg.value("detonator_z", explosive_z);
                                global_solver_2d_cuda->setDetonatorLocation(detonator_r, detonator_z);
                                global_solver_2d_cuda->setInitialConditionTNT(explosive_z, explosive_radius, high_rho, ambient_rho, ambient_p);
                            }
                        }
                    } else {
                        {
                            std::lock_guard<std::mutex> lock(cout_mutex);
                            global_solver_2d_cuda.reset();
                        }
                        if (precision == "single" || precision == "float") {
                            if (mesh_type == "amr") {
                                global_solver_2d = std::make_unique<CFDSolver2DAMRImpl<float>>(nr, nz, max_r, max_z, gamma, amr_max_levels, amr_threshold, amr_coarsen_ratio);
                            } else {
                                global_solver_2d = std::make_unique<CFDSolver2DImpl<float>>(nr, nz, max_r, max_z, gamma);
                            }
                        } else {
                            if (mesh_type == "amr") {
                                global_solver_2d = std::make_unique<CFDSolver2DAMRImpl<double>>(nr, nz, max_r, max_z, gamma, amr_max_levels, amr_threshold, amr_coarsen_ratio);
                            } else {
                                global_solver_2d = std::make_unique<CFDSolver2DImpl<double>>(nr, nz, max_r, max_z, gamma);
                            }
                        }
                        
                        global_solver_2d->setFluxScheme(flux_scheme);
                        global_solver_2d->setSpatialOrder(spatial_order);
                        global_solver_2d->setTemporalOrder(temporal_order);
                        global_solver_2d->setBCTypes(r_min_bc, r_max_bc, z_min_bc, z_max_bc);
                        global_solver_2d->setMaterialParameters(matSet);
                        global_solver_2d->setCoordinateSystemCartesian(coord_sys == "Cartesian");
 
                        std::string init_mode = msg.value("init_mode", "Ideal Gas");
                        if (init_mode == "Ideal Gas" || msg.value("explosive_type", "") == "MaterialIdealGas") {
                            double det_energy = msg.value("detonation_energy", 4520000.0);
                            double high_rho = msg.value("high_rho", msg.value("rho", 1630.0));
                            double ambient_rho = msg.value("ambient_rho", 1.225648589);
                            double ambient_p = msg.value("atm_pressure", msg.value("ambient_p", 101325.0));
                            double explosive_z = msg.value("charge_z", msg.value("explosive_z", 0.0));
                            double explosive_radius = msg.value("charge_radius", msg.value("explosive_radius", 0.1));
                            
                            double detonator_r = msg.value("detonator_r", 0.0);
                            double detonator_z = msg.value("detonator_z", explosive_z);
                            global_solver_2d->setDetonatorLocation(detonator_r, detonator_z);
                            global_solver_2d->setInitialConditionIdealGas(explosive_z, explosive_radius, high_rho, det_energy, ambient_rho, ambient_p);
                        } else if (init_mode == "Multi-Material JWL" || init_mode == "JWL") {
                            double high_rho = msg.value("high_rho", msg.value("rho", 1630.0));
                            double ambient_rho = msg.value("ambient_rho", 1.225648589);
                            double ambient_p = msg.value("atm_pressure", msg.value("ambient_p", 101325.0));
                            double explosive_r = msg.value("charge_r", msg.value("explosive_r", 0.0));
                            double explosive_z = msg.value("charge_z", msg.value("explosive_z", 0.0));
                            double explosive_radius = msg.value("charge_radius", msg.value("explosive_radius", 0.1));
                            
                            std::string charge_shape = msg.value("charge_shape", "Sphere");
                            if (charge_shape == "Cylinder" || charge_shape == "cylinder") {
                                double charge_radius = msg.value("charge_radius", 0.1);
                                double charge_height = msg.value("charge_height", 0.2);
                                if (msg.contains("charge_aspect_ratio") && !msg.contains("charge_height")) {
                                    double ar = msg.value("charge_aspect_ratio", 1.0);
                                    if (ar > 0.0) charge_height = 2.0 * charge_radius * ar;
                                }
                                double detonator_r = msg.value("detonator_r", explosive_r);
                                double detonator_z = msg.value("detonator_z", explosive_z + charge_height / 2.0);
                                global_solver_2d->setDetonatorLocation(detonator_r, detonator_z);
                                global_solver_2d->setInitialConditionTNTCylinder(explosive_z, charge_radius, charge_height, high_rho, ambient_rho, ambient_p, explosive_r);
                            } else {
                                double detonator_r = msg.value("detonator_r", explosive_r);
                                double detonator_z = msg.value("detonator_z", explosive_z);
                                global_solver_2d->setDetonatorLocation(detonator_r, detonator_z);
                                global_solver_2d->setInitialConditionTNT(explosive_z, explosive_radius, high_rho, ambient_rho, ambient_p, explosive_r);
                            }
                        }
                    }
                    
                    solver2d_initialized = true;
                    init_gauges(msg);
                    record_gauges_2d(global_t2d);
                    emit_kernel_log("SYSTEM", "2D Solver Initialized", global_t2d, "2d");
                    emit_telemetry_2d(global_t2d, false);
                } else if (command == "STEP_2D") {
                    if (!has_solver_2d()) continue;
                    int steps = msg.at("steps").get<int>();
                    global_cfl_2d = msg.value("cfl", 0.35);
                    global_exec_until_end_2d = false;
                    if (!sim2d_running) {
                        global_target_steps_2d = steps;
                        sim2d_running = true;
                        sim2d_paused = false;
                        sim2d_terminate = false;
                        std::thread(worker_2d_thread_func).detach();
                    } else {
                        global_target_steps_2d.fetch_add(steps);
                        sim2d_paused = false;
                    }
                } else if (command == "EXEC_ALL_2D") {
                    if (!has_solver_2d()) continue;
                    global_cfl_2d = msg.value("cfl", 0.35);
                    global_exec_until_end_2d = true;
                    if (!sim2d_running) {
                        sim2d_running = true;
                        sim2d_paused = false;
                        sim2d_terminate = false;
                        std::thread(worker_2d_thread_func).detach();
                    } else { sim2d_paused = false; }
                } else if (command == "PAUSE_2D") {
                    sim2d_paused = true;
                    global_target_steps_2d = 0;
                } else if (command == "RESUME_2D") {
                    sim2d_paused = false;
                } else if (command == "TERMINATE_2D") {
                    sim2d_terminate = true;
                    while (sim2d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_2d.reset();
                    {
                        std::lock_guard<std::mutex> lock(cout_mutex);
                        global_solver_2d_cuda.reset();
                    }
                    global_t2d = 0.0;
                    global_wallclock_2d = 0.0;
                    step_progress_2d = 0;
                    solver2d_initialized = false;
                } else if (command == "INIT_MPM" || command == "INIT_2D_MPM") {
                    global_solver_mpm_2d = std::make_unique<Blast::MPMSolver2D>();

                    int nx = get_json_int(msg, "nr", get_json_int(msg, "nx", 64));
                    int ny = get_json_int(msg, "nz", get_json_int(msg, "ny", 64));
                    double max_x = get_json_double(msg, "max_r", get_json_double(msg, "max_x", 1.0));
                    double max_y = get_json_double(msg, "max_z", get_json_double(msg, "max_y", 1.0));
                    float dx = static_cast<float>(max_x / nx);
                    float dy = static_cast<float>(max_y / ny);

                    global_solver_mpm_2d->initializeGrid(nx, ny, dx, dy);

                    std::string transfer_scheme = msg.value("transfer_scheme", "BSpline");
                    std::string velocity_scheme = msg.value("velocity_scheme", "APIC");
                    bool smooth_ps = msg.value("smooth_plastic_strain", true);

                    global_solver_mpm_2d->setTransferScheme(parseTransferScheme(transfer_scheme));
                    global_solver_mpm_2d->setSmoothPlasticStrain(smooth_ps);

                    if (velocity_scheme == "PIC") {
                        global_solver_mpm_2d->setVelocityScheme(Blast::MPMVelocityScheme::PIC);
                    } else if (velocity_scheme == "FLIP") {
                        global_solver_mpm_2d->setVelocityScheme(Blast::MPMVelocityScheme::FLIP);
                    } else {
                        global_solver_mpm_2d->setVelocityScheme(Blast::MPMVelocityScheme::APIC);
                    }

                    int domain_ppc = get_json_int(msg, "ppc", 4);

                    if (msg.contains("mpm_objects") && msg["mpm_objects"].is_array()) {
                        int obj_idx = 0;
                        for (const auto& obj : msg["mpm_objects"]) {
                            obj_idx++;
                            std::string shape = obj.value("shape_type", "Rectangle");
                            float pos_x = static_cast<float>(get_json_double(obj, "pos_x", 0.5));
                            float pos_y = static_cast<float>(get_json_double(obj, "pos_y", 0.5));
                            float vel_x = static_cast<float>(get_json_double(obj, "vel_x", 0.0));
                            float vel_y = static_cast<float>(get_json_double(obj, "vel_y", 0.0));
                            float angular_vel = static_cast<float>(get_json_double(obj, "angular_vel", 0.0));
                            float density = static_cast<float>(get_json_double(obj, "density", 7850.0));
                            float E = static_cast<float>(get_json_double(obj, "youngs_modulus", 210.0e9));
                            float nu = static_cast<float>(get_json_double(obj, "poissons_ratio", 0.3));
                            float yield_stress = static_cast<float>(get_json_double(obj, "yield_stress", 400.0e6));
                            float hardening = static_cast<float>(get_json_double(obj, "hardening_modulus", 1.0e9));
                            float failure_strain = static_cast<float>(get_json_double(obj, "failure_strain", 0.25));
                            float tensile_failure_stress = static_cast<float>(get_json_double(obj, "tensile_failure_stress", 600.0e6));
                            int ppc = get_json_int(obj, "ppc", domain_ppc);

                            std::string mat_model_str = obj.value("material_model", "Hypoelastic");
                            Blast::MPMMaterialModel mat_model = Blast::MPMMaterialModel::HypoelasticSteel;
                            if (mat_model_str == "Johnson-Cook + Mie-Grüneisen") {
                                mat_model = Blast::MPMMaterialModel::JohnsonCookMieGruneisen;
                            }

                            float jc_A = static_cast<float>(get_json_double(obj, "jc_A", 792.0e6));
                            float jc_B = static_cast<float>(get_json_double(obj, "jc_B", 510.0e6));
                            float jc_n = static_cast<float>(get_json_double(obj, "jc_n", 0.26));
                            float jc_C = static_cast<float>(get_json_double(obj, "jc_C", 0.014));
                            float jc_m = static_cast<float>(get_json_double(obj, "jc_m", 1.03));
                            float T_melt = static_cast<float>(get_json_double(obj, "T_melt", 1793.0));
                            float T_room = static_cast<float>(get_json_double(obj, "T_room", 293.0));
                            float Cp = static_cast<float>(get_json_double(obj, "Cp", 477.0));
                            float mg_gamma0 = static_cast<float>(get_json_double(obj, "mg_gamma0", 1.81));
                            float mg_c0 = static_cast<float>(get_json_double(obj, "mg_c0", 4570.0));
                            float mg_s = static_cast<float>(get_json_double(obj, "mg_s", 1.49));

                            if (shape == "Circle") {
                                float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
                                global_solver_mpm_2d->addCircleObject(obj_idx, pos_x, pos_y, radius, vel_x, vel_y, angular_vel, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                            } else {
                                float size_x = static_cast<float>(get_json_double(obj, "size_x", 0.2));
                                float size_y = static_cast<float>(get_json_double(obj, "size_y", 0.2));
                                global_solver_mpm_2d->addRectangleObject(obj_idx, pos_x, pos_y, size_x, size_y, vel_x, vel_y, angular_vel, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                            }

                            for (auto& p : global_solver_mpm_2d->getParticles()) {
                                if (p.object_id == obj_idx) {
                                    p.material_model = mat_model;
                                    p.jc_A = jc_A;
                                    p.jc_B = jc_B;
                                    p.jc_n = jc_n;
                                    p.jc_C = jc_C;
                                    p.jc_m = jc_m;
                                    p.T_melt = T_melt;
                                    p.T_room = T_room;
                                    p.Cp = Cp;
                                    p.mg_gamma0 = mg_gamma0;
                                    p.mg_c0 = mg_c0;
                                    p.mg_s = mg_s;
                                    p.temperature = T_room;
                                    p.e_int = 0.0f;
                                }
                            }
                        }

                    } else {
                        // Default steel impact primitives test case
                        global_solver_mpm_2d->addCircleObject(1, 0.3f, 0.5f, 0.1f, 150.0f, 0.0f, 0.0f, 7850.0f, 210.0e9f, 0.3f, 400.0e6f, 1.0e9f, 0.25f, 600.0e6f, domain_ppc);
                        global_solver_mpm_2d->addRectangleObject(2, 0.7f, 0.5f, 0.2f, 0.4f, 0.0f, 0.0f, 0.0f, 7850.0f, 210.0e9f, 0.3f, 400.0e6f, 1.0e9f, 0.25f, 600.0e6f, domain_ppc);
                    }

                    global_solver_mpm_2d->particleToGrid();
                    emit_telemetry_mpm_2d(0.0, false);
                    std::string init_log = "2D MPM Solver Initialized (" + std::to_string(global_solver_mpm_2d->getParticles().size()) + " particles, PPC=" + std::to_string(domain_ppc) + ")";
                    emit_kernel_log("SYSTEM", init_log, 0.0, "mpm_2d");
                } else if (command == "STEP_MPM" || command == "STEP_2D_MPM") {
                    if (!global_solver_mpm_2d) continue;
                    int steps = get_json_int(msg, "steps", 1);
                    global_cfl_mpm = static_cast<float>(get_json_double(msg, "cfl", 0.3));
                    global_exec_until_end_mpm = false;
                    if (!sim_mpm_running) {
                        global_target_steps_mpm = steps;
                        sim_mpm_running = true;
                        sim_mpm_paused = false;
                        sim_mpm_terminate = false;
                        std::thread(worker_mpm_2d_thread_func).detach();
                    } else {
                        global_target_steps_mpm.fetch_add(steps);
                        sim_mpm_paused = false;
                    }
                } else if (command == "EXEC_ALL_MPM") {
                    if (!global_solver_mpm_2d) continue;
                    global_cfl_mpm = static_cast<float>(get_json_double(msg, "cfl", 0.3));
                    global_exec_until_end_mpm = true;
                    if (!sim_mpm_running) {
                        sim_mpm_running = true;
                        sim_mpm_paused = false;
                        sim_mpm_terminate = false;
                        std::thread(worker_mpm_2d_thread_func).detach();
                    } else {
                        sim_mpm_paused = false;
                    }
                } else if (command == "PAUSE_MPM") {
                    sim_mpm_paused = true;
                    global_target_steps_mpm = 0;
                } else if (command == "RESUME_MPM") {
                    sim_mpm_paused = false;
                } else if (command == "TERMINATE_MPM") {
                    sim_mpm_terminate = true;
                    while (sim_mpm_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_mpm_2d.reset();
                } else if (command == "INIT_MPM_3D" || command == "INIT_3D_MPM") {
                    sim_mpm_3d_terminate = true;
                    while (sim_mpm_3d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    sim_mpm_3d_terminate = false;
                    sim_mpm_3d_paused = false;

                    std::string device = msg.value("device", "cpu");
                    select_cuda_device(device);
                    if (is_cuda_device(device)) {
                        global_solver_mpm_3d.reset();
                        global_solver_mpm_3d_cuda = std::make_unique<Blast::MPMSolver3DCUDA>();
                    } else {
                        global_solver_mpm_3d_cuda.reset();
                        global_solver_mpm_3d = std::make_unique<Blast::MPMSolver3D>();
                    }

                    float xmin = static_cast<float>(get_json_double(msg, "xmin", 0.0));
                    float xmax = static_cast<float>(get_json_double(msg, "xmax", 1.0));
                    float ymin = static_cast<float>(get_json_double(msg, "ymin", 0.0));
                    float ymax = static_cast<float>(get_json_double(msg, "ymax", 1.0));
                    float zmin = static_cast<float>(get_json_double(msg, "zmin", 0.0));
                    float zmax = static_cast<float>(get_json_double(msg, "zmax", 1.0));

                    int nx, ny, nz;
                    float dx, dy, dz;
                    if (msg.contains("cell_size")) {
                        float cell_size = static_cast<float>(get_json_double(msg, "cell_size", 0.01));
                        dx = cell_size; dy = cell_size; dz = cell_size;
                        int pad = 3; // Ghost cells for B-Spline stencil
                        nx = std::max(1, static_cast<int>(std::round((xmax - xmin) / cell_size))) + 2 * pad;
                        ny = std::max(1, static_cast<int>(std::round((ymax - ymin) / cell_size))) + 2 * pad;
                        nz = std::max(1, static_cast<int>(std::round((zmax - zmin) / cell_size))) + 2 * pad;
                        xmin -= pad * cell_size;
                        ymin -= pad * cell_size;
                        zmin -= pad * cell_size;
                    } else {
                        nx = get_json_int(msg, "nx", get_json_int(msg, "nr", 32));
                        ny = get_json_int(msg, "ny", 32);
                        nz = get_json_int(msg, "nz", get_json_int(msg, "nz", 32));
                        dx = (xmax - xmin) / static_cast<float>(nx);
                        dy = (ymax - ymin) / static_cast<float>(ny);
                        dz = (zmax - zmin) / static_cast<float>(nz);
                    }

                    if (global_solver_mpm_3d_cuda) {
                        global_solver_mpm_3d_cuda->initializeGrid(nx, ny, nz, dx, dy, dz, xmin, ymin, zmin);
                    } else {
                        global_solver_mpm_3d->initializeGrid(nx, ny, nz, dx, dy, dz, xmin, ymin, zmin);
                    }

                    std::string transfer_scheme = msg.value("transfer_scheme", "BSpline");
                    std::string velocity_scheme = msg.value("velocity_scheme", "APIC");
                    std::string space_time_scheme = msg.value("space_time_scheme", "RK2");

                    auto ts = parseTransferScheme(transfer_scheme);
                    auto vs = (velocity_scheme == "PIC") ? Blast::MPMVelocityScheme::PIC :
                              ((velocity_scheme == "FLIP") ? Blast::MPMVelocityScheme::FLIP : Blast::MPMVelocityScheme::APIC);
                    float flip_blend = static_cast<float>(get_json_double(msg, "flip_blend", 0.95));
                    auto st = (space_time_scheme == "USL") ? Blast::MPMTimeIntegrationScheme::USL :
                              ((space_time_scheme == "USF") ? Blast::MPMTimeIntegrationScheme::USF : Blast::MPMTimeIntegrationScheme::RK2);

                    bool smooth_ps = msg.value("smooth_plastic_strain", true);

                    if (global_solver_mpm_3d_cuda) {
                        global_solver_mpm_3d_cuda->setTransferScheme(ts);
                        global_solver_mpm_3d_cuda->setVelocityScheme(vs);
                        global_solver_mpm_3d_cuda->setFlipBlend(flip_blend);
                        global_solver_mpm_3d_cuda->setTimeScheme(st);
                        global_solver_mpm_3d_cuda->setSmoothPlasticStrain(smooth_ps);
                    } else {
                        global_solver_mpm_3d->setTransferScheme(ts);
                        global_solver_mpm_3d->setVelocityScheme(vs);
                        global_solver_mpm_3d->setFlipBlend(flip_blend);
                        global_solver_mpm_3d->setTimeScheme(st);
                        global_solver_mpm_3d->setSmoothPlasticStrain(smooth_ps);
                    }

                    auto parse_bc_3d = [](const std::string& str) {
                        if (str == "Sticky") return Blast::MPMBoundaryCondition3D::Sticky;
                        if (str == "FreeSlip" || str == "Free-Slip") return Blast::MPMBoundaryCondition3D::FreeSlip;
                        if (str == "Reflecting") return Blast::MPMBoundaryCondition3D::Reflecting;
                        return Blast::MPMBoundaryCondition3D::Terminate;
                    };

                    auto bc1 = parse_bc_3d(msg.value("bc_x_min", "Reflecting"));
                    auto bc2 = parse_bc_3d(msg.value("bc_x_max", "Reflecting"));
                    auto bc3 = parse_bc_3d(msg.value("bc_y_min", "Reflecting"));
                    auto bc4 = parse_bc_3d(msg.value("bc_y_max", "Reflecting"));
                    auto bc5 = parse_bc_3d(msg.value("bc_z_min", "Reflecting"));
                    auto bc6 = parse_bc_3d(msg.value("bc_z_max", "Reflecting"));

                    if (global_solver_mpm_3d_cuda) {
                        global_solver_mpm_3d_cuda->setBoundaryConditions(bc1, bc2, bc3, bc4, bc5, bc6);
                    } else {
                        global_solver_mpm_3d->setBoundaryConditions(bc1, bc2, bc3, bc4, bc5, bc6);
                    }

                    int domain_ppc = get_json_int(msg, "ppc", 8);

                    if (msg.contains("mpm_objects") && msg["mpm_objects"].is_array()) {
                        int obj_idx = 0;
                        for (const auto& obj : msg["mpm_objects"]) {
                            obj_idx++;
                            std::string shape = obj.value("shape_type", "Box");
                            float pos_x = static_cast<float>(get_json_double(obj, "pos_x", 0.5));
                            float pos_y = static_cast<float>(get_json_double(obj, "pos_y", 0.5));
                            float pos_z = static_cast<float>(get_json_double(obj, "pos_z", 0.5));
                            float vel_x = static_cast<float>(get_json_double(obj, "vel_x", 0.0));
                            float vel_y = static_cast<float>(get_json_double(obj, "vel_y", 0.0));
                            float vel_z = static_cast<float>(get_json_double(obj, "vel_z", 0.0));
                            float ang_x = static_cast<float>(get_json_double(obj, "angular_vel_x", 0.0));
                            float ang_y = static_cast<float>(get_json_double(obj, "angular_vel_y", 0.0));
                            float ang_z = static_cast<float>(get_json_double(obj, "angular_vel_z", 0.0));
                            float density = static_cast<float>(get_json_double(obj, "density", 7850.0));
                            float E = static_cast<float>(get_json_double(obj, "youngs_modulus", 210.0e9));
                            float nu = static_cast<float>(get_json_double(obj, "poissons_ratio", 0.3));
                            float yield_stress = static_cast<float>(get_json_double(obj, "yield_stress", 400.0e6));
                            float hardening = static_cast<float>(get_json_double(obj, "hardening_modulus", 1.0e9));
                            float failure_strain = static_cast<float>(get_json_double(obj, "failure_strain", 0.25));
                            float tensile_failure_stress = static_cast<float>(get_json_double(obj, "tensile_failure_stress", 600.0e6));
                            int ppc = get_json_int(obj, "ppc", domain_ppc);

                            std::string mat_model_str = obj.value("material_model", "Hypoelastic");
                            Blast::MPMMaterialModel mat_model = Blast::MPMMaterialModel::HypoelasticSteel;
                            if (mat_model_str == "Johnson-Cook + Mie-Grüneisen") {
                                mat_model = Blast::MPMMaterialModel::JohnsonCookMieGruneisen;
                            }

                            float jc_A = static_cast<float>(get_json_double(obj, "jc_A", 792.0e6));
                            float jc_B = static_cast<float>(get_json_double(obj, "jc_B", 510.0e6));
                            float jc_n = static_cast<float>(get_json_double(obj, "jc_n", 0.26));
                            float jc_C = static_cast<float>(get_json_double(obj, "jc_C", 0.014));
                            float jc_m = static_cast<float>(get_json_double(obj, "jc_m", 1.03));
                            float T_melt = static_cast<float>(get_json_double(obj, "T_melt", 1793.0));
                            float T_room = static_cast<float>(get_json_double(obj, "T_room", 293.0));
                            float Cp = static_cast<float>(get_json_double(obj, "Cp", 477.0));
                            float mg_gamma0 = static_cast<float>(get_json_double(obj, "mg_gamma0", 1.81));
                            float mg_c0 = static_cast<float>(get_json_double(obj, "mg_c0", 4570.0));
                            float mg_s = static_cast<float>(get_json_double(obj, "mg_s", 1.49));

                            if (shape == "Sphere") {
                                float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
                                if (global_solver_mpm_3d_cuda) {
                                    global_solver_mpm_3d_cuda->addSphereObject(obj_idx, pos_x, pos_y, pos_z, radius, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                                } else {
                                    global_solver_mpm_3d->addSphereObject(obj_idx, pos_x, pos_y, pos_z, radius, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                                }
                            } else if (shape == "Cylinder") {
                                float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
                                float inner_radius = static_cast<float>(get_json_double(obj, "inner_radius", 0.0));
                                float height = static_cast<float>(get_json_double(obj, "height", 0.2));
                                if (global_solver_mpm_3d_cuda) {
                                    global_solver_mpm_3d_cuda->addCylinderObject(obj_idx, pos_x, pos_y, pos_z, radius, inner_radius, height, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                                } else {
                                    global_solver_mpm_3d->addCylinderObject(obj_idx, pos_x, pos_y, pos_z, radius, inner_radius, height, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                                }
                            } else if (shape == "STL") {
                                std::string stl_file = obj.contains("stl_file") ? obj["stl_file"].get<std::string>() : "";
                                float scale_x = static_cast<float>(get_json_double(obj, "scale_x", 1.0));
                                float scale_y = static_cast<float>(get_json_double(obj, "scale_y", 1.0));
                                float scale_z = static_cast<float>(get_json_double(obj, "scale_z", 1.0));
                                if (global_solver_mpm_3d_cuda) {
                                    global_solver_mpm_3d_cuda->addSTLObject(obj_idx, stl_file, pos_x, pos_y, pos_z, scale_x, scale_y, scale_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                                } else {
                                    global_solver_mpm_3d->addSTLObject(obj_idx, stl_file, pos_x, pos_y, pos_z, scale_x, scale_y, scale_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                                }
                            } else {
                                float size_x = static_cast<float>(get_json_double(obj, "size_x", 0.2));
                                float size_y = static_cast<float>(get_json_double(obj, "size_y", 0.2));
                                float size_z = static_cast<float>(get_json_double(obj, "size_z", 0.2));
                                if (global_solver_mpm_3d_cuda) {
                                    global_solver_mpm_3d_cuda->addBoxObject(obj_idx, pos_x, pos_y, pos_z, size_x, size_y, size_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                                } else {
                                    global_solver_mpm_3d->addBoxObject(obj_idx, pos_x, pos_y, pos_z, size_x, size_y, size_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                                }
                            }

                            if (global_solver_mpm_3d_cuda) {
                                auto& mat_tables = global_solver_mpm_3d_cuda->getMaterialTables();
                                if (obj_idx >= 0 && obj_idx < static_cast<int>(mat_tables.size())) {
                                    auto& mat = mat_tables[obj_idx];
                                    mat.material_model = mat_model;
                                    mat.jc_A = jc_A; mat.jc_B = jc_B; mat.jc_n = jc_n; mat.jc_C = jc_C; mat.jc_m = jc_m;
                                    mat.T_melt = T_melt; mat.T_room = T_room; mat.Cp = Cp;
                                    mat.mg_gamma0 = mg_gamma0; mat.mg_c0 = mg_c0; mat.mg_s = mg_s;
                                }
                                global_solver_mpm_3d_cuda->uploadMaterialTableToDevice();
                            }
                            if (global_solver_mpm_3d) {
                                auto& mat_tables = global_solver_mpm_3d->getMaterialTables();
                                if (obj_idx >= 0 && obj_idx < static_cast<int>(mat_tables.size())) {
                                    auto& mat = mat_tables[obj_idx];
                                    mat.material_model = mat_model;
                                    mat.jc_A = jc_A; mat.jc_B = jc_B; mat.jc_n = jc_n; mat.jc_C = jc_C; mat.jc_m = jc_m;
                                    mat.T_melt = T_melt; mat.T_room = T_room; mat.Cp = Cp;
                                    mat.mg_gamma0 = mg_gamma0; mat.mg_c0 = mg_c0; mat.mg_s = mg_s;
                                }
                            }
                            auto& particles_ref = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getParticles() : global_solver_mpm_3d->getParticles();
                            for (auto& p : particles_ref) {
                                if (p.object_id == obj_idx) {
                                    p.temperature = T_room;
                                    p.e_int = 0.0f;
                                }
                            }
                        }

                    } else {
                        if (global_solver_mpm_3d_cuda) {
                            global_solver_mpm_3d_cuda->addBoxObject(1, 0.5f, 0.5f, 0.5f, 0.2f, 0.2f, 0.2f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 7850.0f, 210.0e9f, 0.3f, 400.0e6f, 1.0e9f, 0.25f, 600.0e6f, domain_ppc);
                        } else {
                            global_solver_mpm_3d->addBoxObject(1, 0.5f, 0.5f, 0.5f, 0.2f, 0.2f, 0.2f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 7850.0f, 210.0e9f, 0.3f, 400.0e6f, 1.0e9f, 0.25f, 600.0e6f, domain_ppc);
                        }
                    }

                    if (global_solver_mpm_3d_cuda) {
                        global_solver_mpm_3d_cuda->syncToDevice();
                        global_solver_mpm_3d_cuda->syncToHost();
                    } else {
                        global_solver_mpm_3d->particleToGrid();
                    }

                    emit_telemetry_mpm_3d(0.0, false);
                    size_t n_p = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getParticles().size() : global_solver_mpm_3d->getParticles().size();
                    std::string init_log = "3D MPM Solver Initialized (" + std::to_string(n_p) + " particles, PPC=" + std::to_string(domain_ppc) + ", Device=" + (is_cuda_device(device) ? "CUDA GPU" : "CPU") + ")";
                    emit_kernel_log("SYSTEM", init_log, 0.0, "mpm_3d");

                } else if (command == "STEP_MPM_3D" || command == "STEP_3D_MPM") {
                    if (!global_solver_mpm_3d && !global_solver_mpm_3d_cuda) continue;
                    int steps = get_json_int(msg, "steps", 1);
                    global_cfl_mpm_3d = static_cast<float>(get_json_double(msg, "cfl", 0.3));
                    global_exec_until_end_mpm_3d = false;
                    if (!sim_mpm_3d_running) {
                        global_target_steps_mpm_3d = steps;
                        sim_mpm_3d_running = true;
                        sim_mpm_3d_paused = false;
                        sim_mpm_3d_terminate = false;
                        std::thread(worker_mpm_3d_thread_func).detach();
                    } else {
                        global_target_steps_mpm_3d.fetch_add(steps);
                        sim_mpm_3d_paused = false;
                    }

                } else if (command == "EXEC_ALL_MPM_3D") {
                    if (!global_solver_mpm_3d && !global_solver_mpm_3d_cuda) continue;
                    global_cfl_mpm_3d = static_cast<float>(get_json_double(msg, "cfl", 0.3));
                    global_exec_until_end_mpm_3d = true;
                    if (!sim_mpm_3d_running) {
                        sim_mpm_3d_running = true;
                        sim_mpm_3d_paused = false;
                        sim_mpm_3d_terminate = false;
                        std::thread(worker_mpm_3d_thread_func).detach();
                    } else {
                        sim_mpm_3d_paused = false;
                    }

                } else if (command == "PAUSE_MPM_3D") {
                    sim_mpm_3d_paused = true;
                    global_target_steps_mpm_3d = 0;

                } else if (command == "RESUME_MPM_3D") {
                    sim_mpm_3d_paused = false;

                } else if (command == "TERMINATE_MPM_3D") {
                    sim_mpm_3d_terminate = true;
                    while (sim_mpm_3d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_mpm_3d.reset();
                    global_solver_mpm_3d_cuda.reset();
                } else if (command == "INIT_FSI_2D" || command == "INIT_FSI") {
                    try {
                        sim2d_terminate = true;
                    while (sim2d_running.load() || sim_fsi_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_2d.reset();
                    global_solver_2d_cuda.reset();
                    global_solver_mpm_2d.reset();
                    sim2d_terminate = false;
                    sim2d_paused = false;
                    sim_fsi_terminate = false;
                    sim_fsi_paused = false;
                    step_progress_2d = 0;
                    global_step_2d = 0;
                    global_step_fsi_2d = 0;
                    global_wallclock_2d = 0.0;

                    int nr = get_json_int(msg, "nr", get_json_int(msg, "nx", 128));
                    int nz = get_json_int(msg, "nz", get_json_int(msg, "ny", 128));
                    double max_r = get_json_double(msg, "max_r", get_json_double(msg, "max_x", 1.0));
                    double max_z = get_json_double(msg, "max_z", get_json_double(msg, "max_y", 1.0));
                    double gamma = get_json_double(msg, "gamma", 1.4);
                    std::string flux_scheme = msg.value("flux_scheme", "AUSM+");
                    int spatial_order = get_json_int(msg, "spatial_order", 2);
                    int temporal_order = get_json_int(msg, "temporal_order", 2);
                    std::string coord_sys = msg.value("coordinate_system", "Axisymmetric");

                    std::string bc_r_min_str = msg.value("bc_r_min", "Reflecting");
                    std::string bc_r_max_str = msg.value("bc_r_max", "Terminate");
                    std::string bc_z_min_str = msg.value("bc_z_min", "Reflecting");
                    std::string bc_z_max_str = msg.value("bc_z_max", "Terminate");

                    auto map_bc_2d = [](const std::string& str) -> CFDSolver2D::BCType {
                        if (str == "Transmitting" || str == "transmitting" || str == "TRANSMISSIVE" || str == "transmissive") {
                            return CFDSolver2D::TRANSMISSIVE;
                        } else if (str == "Riemann" || str == "riemann" || str == "Terminate" || str == "terminate" || str == "OUTFLOW_RIEMANN" || str == "outflow_riemann") {
                            return CFDSolver2D::OUTFLOW_RIEMANN;
                        } else {
                            return CFDSolver2D::REFLECTIVE;
                        }
                    };

                    CFDSolver2D::BCType r_min_bc = map_bc_2d(bc_r_min_str);
                    CFDSolver2D::BCType r_max_bc = map_bc_2d(bc_r_max_str);
                    CFDSolver2D::BCType z_min_bc = map_bc_2d(bc_z_min_str);
                    CFDSolver2D::BCType z_max_bc = map_bc_2d(bc_z_max_str);

                    MultiMat::MaterialSet matSet = parseMaterialSet(msg);

                    global_solver_2d = std::make_unique<CFDSolver2DImpl<double>>(nr, nz, max_r, max_z, gamma);
                    global_solver_2d->setFluxScheme(flux_scheme);
                    global_solver_2d->setSpatialOrder(spatial_order);
                    global_solver_2d->setTemporalOrder(temporal_order);
                    global_solver_2d->setBCTypes(r_min_bc, r_max_bc, z_min_bc, z_max_bc);
                    global_solver_2d->setMaterialParameters(matSet);
                    global_solver_2d->setCoordinateSystemCartesian(coord_sys == "Cartesian");

                    double explosive_r = msg.value("charge_r", msg.value("explosive_r", 0.0));
                    double explosive_z = msg.value("charge_z", msg.value("explosive_z", 0.1));
                    double high_rho = msg.value("high_rho", msg.value("rho", 1630.0));
                    double ambient_rho = msg.value("ambient_rho", 1.225);
                    double ambient_p = msg.value("atm_pressure", msg.value("ambient_p", 101325.0));
                    double explosive_radius = msg.value("charge_radius", msg.value("explosive_radius", 0.1));

                    double detonator_r = msg.value("detonator_r", explosive_r);
                    double detonator_z = msg.value("detonator_z", explosive_z);
                    global_solver_2d->setDetonatorLocation(detonator_r, detonator_z);
                    global_solver_2d->setInitialConditionTNT(explosive_z, explosive_radius, high_rho, ambient_rho, ambient_p, explosive_r);
                    solver2d_initialized = true;

                    global_solver_mpm_2d = std::make_unique<Blast::MPMSolver2D>();
                    float dx = static_cast<float>(max_r / nr);
                    float dy = static_cast<float>(max_z / nz);
                    global_solver_mpm_2d->initializeGrid(nr, nz, dx, dy);

                    std::string transfer_scheme = msg.value("transfer_scheme", "BSpline");
                    std::string velocity_scheme = msg.value("velocity_scheme", "APIC");
                    global_solver_mpm_2d->setTransferScheme(parseTransferScheme(transfer_scheme));
                    if (velocity_scheme == "PIC") {
                        global_solver_mpm_2d->setVelocityScheme(Blast::MPMVelocityScheme::PIC);
                    } else if (velocity_scheme == "FLIP") {
                        global_solver_mpm_2d->setVelocityScheme(Blast::MPMVelocityScheme::FLIP);
                    } else {
                        global_solver_mpm_2d->setVelocityScheme(Blast::MPMVelocityScheme::APIC);
                    }

                    int domain_ppc = get_json_int(msg, "ppc", 4);
                    if (msg.contains("mpm_objects") && msg["mpm_objects"].is_array()) {
                        int obj_idx = 0;
                        for (const auto& obj : msg["mpm_objects"]) {
                            obj_idx++;
                            std::string shape = obj.value("shape_type", "Rectangle");
                            float pos_x = static_cast<float>(get_json_double(obj, "pos_x", 0.5));
                            float pos_y = static_cast<float>(get_json_double(obj, "pos_y", 0.5));
                            float vel_x = static_cast<float>(get_json_double(obj, "vel_x", 0.0));
                            float vel_y = static_cast<float>(get_json_double(obj, "vel_y", 0.0));
                            float angular_vel = static_cast<float>(get_json_double(obj, "angular_vel", 0.0));
                            float density = static_cast<float>(get_json_double(obj, "density", 7850.0));
                            float E = static_cast<float>(get_json_double(obj, "youngs_modulus", 210.0e9));
                            float nu = static_cast<float>(get_json_double(obj, "poissons_ratio", 0.3));
                            float yield_stress = static_cast<float>(get_json_double(obj, "yield_stress", 400.0e6));
                            float hardening = static_cast<float>(get_json_double(obj, "hardening_modulus", 1.0e9));
                            float failure_strain = static_cast<float>(get_json_double(obj, "failure_strain", 0.25));
                            float tensile_failure_stress = static_cast<float>(get_json_double(obj, "tensile_failure_stress", 600.0e6));
                            int ppc = get_json_int(obj, "ppc", domain_ppc);

                            if (shape == "Circle") {
                                float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
                                global_solver_mpm_2d->addCircleObject(obj_idx, pos_x, pos_y, radius, vel_x, vel_y, angular_vel, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                            } else {
                                float size_x = static_cast<float>(get_json_double(obj, "size_x", 0.2));
                                float size_y = static_cast<float>(get_json_double(obj, "size_y", 0.2));
                                global_solver_mpm_2d->addRectangleObject(obj_idx, pos_x, pos_y, size_x, size_y, vel_x, vel_y, angular_vel, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                            }
                        }
                    } else {
                        global_solver_mpm_2d->addRectangleObject(1, 0.7f, 0.5f, 0.2f, 0.4f, 0.0f, 0.0f, 0.0f, 7850.0f, 210.0e9f, 0.3f, 400.0e6f, 1.0e9f, 0.25f, 600.0e6f, domain_ppc);
                    }

                        global_solver_mpm_2d->particleToGrid();
                        init_gauges(msg);
                        emit_kernel_log("SYSTEM", "2D Coupled FSI Solver (CFD + MPM) Initialized", 0.0, "2d");
                        emit_telemetry_2d(0.0, false);
                        emit_telemetry_mpm_2d(0.0, false);
                    } catch (const std::exception& e) {
                        std::cerr << "[ERROR] Exception in INIT_FSI_2D: " << e.what() << std::endl;
                        emit_kernel_log("ERROR", std::string("FSI 2D initialization failed: ") + e.what(), 0.0, "2d");
                        std::exit(1);
                    } catch (...) {
                        std::cerr << "[ERROR] Unknown exception in INIT_FSI_2D" << std::endl;
                        emit_kernel_log("ERROR", "FSI 2D initialization failed with unknown error", 0.0, "2d");
                        std::exit(1);
                    }
                } else if (command == "STEP_FSI_2D" || command == "STEP_FSI") {
                    int steps = get_json_int(msg, "steps", 1);
                    global_cfl_fsi = static_cast<float>(get_json_double(msg, "cfl", 0.35));
                    global_exec_until_end_fsi = false;
                    if (!sim_fsi_running) {
                        global_target_steps_fsi = steps;
                        sim_fsi_running = true;
                        sim_fsi_paused = false;
                        sim_fsi_terminate = false;
                        std::thread(worker_fsi_2d_thread_func).detach();
                    } else {
                        global_target_steps_fsi.fetch_add(steps);
                        sim_fsi_paused = false;
                    }
                } else if (command == "EXEC_ALL_FSI_2D" || command == "EXEC_ALL_FSI") {
                    global_cfl_fsi = static_cast<float>(get_json_double(msg, "cfl", 0.35));
                    global_exec_until_end_fsi = true;
                    if (!sim_fsi_running) {
                        sim_fsi_running = true;
                        sim_fsi_paused = false;
                        sim_fsi_terminate = false;
                        std::thread(worker_fsi_2d_thread_func).detach();
                    } else {
                        sim_fsi_paused = false;
                    }
                } else if (command == "PAUSE_FSI_2D" || command == "PAUSE_FSI") {
                    sim_fsi_paused = true;
                    global_target_steps_fsi = 0;
                } else if (command == "TERMINATE_FSI_2D" || command == "TERMINATE_FSI") {
                    sim_fsi_terminate = true;
                    while (sim_fsi_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_2d.reset();
                    global_solver_mpm_2d.reset();
                    solver2d_initialized = false;
                } else if (command == "INIT_FSI_3D") {
                    try {
                        sim3d_terminate = true;
                    sim_mpm_3d_terminate = true;
                    sim_fsi_3d_terminate = true;
                    while (sim3d_running.load() || sim3d_init_in_progress.load() || sim_mpm_3d_running.load() || sim_fsi_3d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_3d.reset();
                    global_solver_mpm_3d.reset();
                    global_solver_mpm_3d_cuda.reset();
                    sim3d_terminate = false;
                    sim3d_paused = false;
                    sim_mpm_3d_terminate = false;
                    sim_mpm_3d_paused = false;
                    sim_fsi_3d_terminate = false;
                    sim_fsi_3d_paused = false;
                    step_progress_3d = 0;
                    global_step_3d = 0;
                    global_step_fsi_3d = 0;
                    global_t3d = 0.0;
                    global_wallclock_3d = 0.0;

                    global_slices_3d.clear();
                    if (msg.contains("slices")) {
                        for (const auto& s_msg : msg["slices"]) {
                            Slice3D s;
                            s.axis = s_msg.value("axis", "xy");
                            s.offset = s_msg.value("offset", 0.5);
                            s.stride = s_msg.value("stride", 1);
                            s.enabled = s_msg.value("enabled", true);
                            if (s.stride < 1) s.stride = 1;
                            if (s_msg.contains("quantities")) {
                                for (const auto& q : s_msg["quantities"]) {
                                    s.quantities.push_back(q.get<std::string>());
                                }
                            }
                            global_slices_3d.push_back(s);
                        }
                    } else {
                        Slice3D s;
                        s.axis = "xy";
                        s.offset = 0.5;
                        s.stride = 1;
                        s.enabled = true;
                        s.quantities.push_back("pressure");
                        global_slices_3d.push_back(s);
                    }

                    // 1. Initialize CFD 3D solver
                    double cellSize = get_json_double(msg, "cell_size", 0.01);
                    double xmin = get_json_double(msg, "xmin", 0.0);
                    double ymin = get_json_double(msg, "ymin", 0.0);
                    double zmin = get_json_double(msg, "zmin", 0.0);
                    double xmax = get_json_double(msg, "xmax", xmin + 1.0);
                    double ymax = get_json_double(msg, "ymax", ymin + 1.0);
                    double zmax = get_json_double(msg, "zmax", zmin + 1.0);
                    int default_nx = std::max(1, static_cast<int>(std::round((xmax - xmin) / cellSize)));
                    int default_ny = std::max(1, static_cast<int>(std::round((ymax - ymin) / cellSize)));
                    int default_nz = std::max(1, static_cast<int>(std::round((zmax - zmin) / cellSize)));
                    int nx = get_json_int(msg, "nx", default_nx);
                    int ny = get_json_int(msg, "ny", default_ny);
                    int nz = get_json_int(msg, "nz", default_nz);
                    if (nx <= 0) nx = default_nx;
                    if (ny <= 0) ny = default_ny;
                    if (nz <= 0) nz = default_nz;
                    std::string device = msg.value("device", "cpu");
                    std::string precision = msg.value("precision", "single");
                    std::string init_mode = msg.value("init_mode", "Multi-Material JWL");
                    std::string explosive_type = msg.value("explosive_type", "");
                    std::string material_type = msg.value("material_type", "");
                    bool is_ideal_gas_3d = (msg.value("is_ideal_gas", false) || init_mode == "Ideal Gas" || explosive_type == "MaterialIdealGas" || material_type == "Ideal Gas Charge");
                    bool is_multimat = !is_ideal_gas_3d;
                    std::cout << "[DEBUG] INIT_FSI_3D: device=" << device << " init_mode=" << init_mode << " explosive_type=" << explosive_type << " material_type=" << material_type << " is_ideal_gas_3d=" << is_ideal_gas_3d << " is_multimat=" << is_multimat << std::endl;

                    select_cuda_device(device);
                    if (is_cuda_device(device)) {
                        if (precision == "single" || precision == "float") {
                            if (is_multimat) global_solver_3d = std::make_unique<CFDSolver3DCuda<float, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                            else global_solver_3d = std::make_unique<CFDSolver3DCuda<float, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                        } else {
                            if (is_multimat) global_solver_3d = std::make_unique<CFDSolver3DCuda<double, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                            else global_solver_3d = std::make_unique<CFDSolver3DCuda<double, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                        }
                    } else {
                        if (precision == "single" || precision == "float") {
                            if (is_multimat) global_solver_3d = std::make_unique<CFDSolver3DImpl<float, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                            else global_solver_3d = std::make_unique<CFDSolver3DImpl<float, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                        } else {
                            if (is_multimat) global_solver_3d = std::make_unique<CFDSolver3DImpl<double, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                            else global_solver_3d = std::make_unique<CFDSolver3DImpl<double, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                        }
                    }

                    global_solver_3d->setFluxScheme(msg.value("flux_scheme", "AUSM+"));
                    global_solver_3d->setSpatialOrder(get_json_int(msg, "spatial_order", 2));
                    global_solver_3d->setTemporalOrder(get_json_int(msg, "temporal_order", 4));

                    Charge3DParams cp;
                    std::string shape_str = msg.value("charge_shape", "Sphere");
                    if (shape_str == "Sphere") cp.shape_type = 0;
                    else if (shape_str == "Block") cp.shape_type = 1;
                    else cp.shape_type = 2;
                    cp.x = get_json_double(msg, "charge_x", 0.0);
                    cp.y = get_json_double(msg, "charge_y", 0.0);
                    cp.z = get_json_double(msg, "charge_z", 0.0);
                    cp.radius = get_json_double(msg, "charge_radius", 0.1);
                    cp.height = get_json_double(msg, "charge_height", 0.2);
                    if (msg.contains("charge_aspect_ratio") && !msg.contains("charge_height")) {
                        double ar = get_json_double(msg, "charge_aspect_ratio", 1.0);
                        if (ar > 0.0) cp.height = 2.0 * cp.radius * ar;
                    }
                    cp.lx = get_json_double(msg, "charge_lx", 0.1);
                    cp.ly = get_json_double(msg, "charge_ly", 0.1);
                    cp.lz = get_json_double(msg, "charge_lz", 0.1);
                    cp.rot_x = get_json_double(msg, "charge_rot_x", get_json_double(msg, "rot_x", 0.0));
                    cp.rot_y = get_json_double(msg, "charge_rot_y", get_json_double(msg, "rot_y", 0.0));
                    cp.rot_z = get_json_double(msg, "charge_rot_z", get_json_double(msg, "rot_z", 0.0));

                    MultiMat::MaterialSet matSet = parseMaterialSet(msg);
                    double ambient_rho = get_json_double(msg, "ambient_rho", 1.225648589);
                    double ambient_p = get_json_double(msg, "atm_pressure", 101325.0);
                    global_solver_3d->setInitialCondition(cp, matSet, ambient_rho, ambient_p);

                    if (msg.contains("detonator_x")) {
                        global_solver_3d->setDetonatorLocation(get_json_double(msg, "detonator_x", cp.x), get_json_double(msg, "detonator_y", cp.y), get_json_double(msg, "detonator_z", cp.z));
                    }

                    auto map_bc_3d = [](const std::string& str) {
                        if (str == "Transmitting" || str == "TRANSMISSIVE") return BCType3D::TRANSMISSIVE;
                        if (str == "Terminate" || str == "OUTFLOW_RIEMANN") return BCType3D::OUTFLOW_RIEMANN;
                        return BCType3D::REFLECTIVE;
                    };
                    global_solver_3d->setBoundaryConditions(
                        map_bc_3d(msg.value("bc_x_min", "Reflecting")), map_bc_3d(msg.value("bc_x_max", "Transmitting")),
                        map_bc_3d(msg.value("bc_y_min", "Reflecting")), map_bc_3d(msg.value("bc_y_max", "Transmitting")),
                        map_bc_3d(msg.value("bc_z_min", "Reflecting")), map_bc_3d(msg.value("bc_z_max", "Transmitting"))
                    );

                    // 2. Initialize MPM 3D solver
                    float dx = static_cast<float>(cellSize);
                    float dy = static_cast<float>(cellSize);
                    float dz = static_cast<float>(cellSize);
                    if (is_cuda_device(device)) {
                        global_solver_mpm_3d_cuda = std::make_unique<Blast::MPMSolver3DCUDA>();
                        global_solver_mpm_3d_cuda->initializeGrid(nx, ny, nz, dx, dy, dz, xmin, ymin, zmin);
                    } else {
                        global_solver_mpm_3d = std::make_unique<Blast::MPMSolver3D>();
                        global_solver_mpm_3d->initializeGrid(nx, ny, nz, dx, dy, dz, xmin, ymin, zmin);
                    }

                    std::string transfer_scheme = msg.value("transfer_scheme", "BSpline");
                    std::string velocity_scheme = msg.value("velocity_scheme", "APIC");
                    std::string space_time_scheme = msg.value("space_time_scheme", "RK2");
                    auto ts = parseTransferScheme(transfer_scheme);
                    auto vs = (velocity_scheme == "PIC") ? Blast::MPMVelocityScheme::PIC :
                              ((velocity_scheme == "FLIP") ? Blast::MPMVelocityScheme::FLIP : Blast::MPMVelocityScheme::APIC);
                    float flip_blend = static_cast<float>(get_json_double(msg, "flip_blend", 0.95));
                    auto st = (space_time_scheme == "USL") ? Blast::MPMTimeIntegrationScheme::USL :
                              ((space_time_scheme == "USF") ? Blast::MPMTimeIntegrationScheme::USF : Blast::MPMTimeIntegrationScheme::RK2);
                    bool smooth_ps = msg.value("smooth_plastic_strain", true);

                    if (global_solver_mpm_3d_cuda) {
                        global_solver_mpm_3d_cuda->setTransferScheme(ts);
                        global_solver_mpm_3d_cuda->setVelocityScheme(vs);
                        global_solver_mpm_3d_cuda->setFlipBlend(flip_blend);
                        global_solver_mpm_3d_cuda->setTimeScheme(st);
                        global_solver_mpm_3d_cuda->setSmoothPlasticStrain(smooth_ps);
                    } else {
                        global_solver_mpm_3d->setTransferScheme(ts);
                        global_solver_mpm_3d->setVelocityScheme(vs);
                        global_solver_mpm_3d->setFlipBlend(flip_blend);
                        global_solver_mpm_3d->setTimeScheme(st);
                        global_solver_mpm_3d->setSmoothPlasticStrain(smooth_ps);
                    }

                    auto parse_bc_mpm3d = [](const std::string& str) {
                        if (str == "Sticky") return Blast::MPMBoundaryCondition3D::Sticky;
                        if (str == "FreeSlip" || str == "Free-Slip") return Blast::MPMBoundaryCondition3D::FreeSlip;
                        if (str == "Reflecting") return Blast::MPMBoundaryCondition3D::Reflecting;
                        return Blast::MPMBoundaryCondition3D::Terminate;
                    };
                    auto mpm_bc1 = parse_bc_mpm3d(msg.value("bc_x_min", "Reflecting"));
                    auto mpm_bc2 = parse_bc_mpm3d(msg.value("bc_x_max", "Reflecting"));
                    auto mpm_bc3 = parse_bc_mpm3d(msg.value("bc_y_min", "Reflecting"));
                    auto mpm_bc4 = parse_bc_mpm3d(msg.value("bc_y_max", "Reflecting"));
                    auto mpm_bc5 = parse_bc_mpm3d(msg.value("bc_z_min", "Reflecting"));
                    auto mpm_bc6 = parse_bc_mpm3d(msg.value("bc_z_max", "Reflecting"));

                    if (global_solver_mpm_3d_cuda) global_solver_mpm_3d_cuda->setBoundaryConditions(mpm_bc1, mpm_bc2, mpm_bc3, mpm_bc4, mpm_bc5, mpm_bc6);
                    else global_solver_mpm_3d->setBoundaryConditions(mpm_bc1, mpm_bc2, mpm_bc3, mpm_bc4, mpm_bc5, mpm_bc6);

                    int domain_ppc = get_json_int(msg, "ppc", 8);
                    if (msg.contains("mpm_objects") && msg["mpm_objects"].is_array()) {
                        int obj_idx = 0;
                        for (const auto& obj : msg["mpm_objects"]) {
                            obj_idx++;
                            std::string shape = obj.value("shape_type", "Box");
                            float pos_x = static_cast<float>(get_json_double(obj, "pos_x", 0.5));
                            float pos_y = static_cast<float>(get_json_double(obj, "pos_y", 0.5));
                            float pos_z = static_cast<float>(get_json_double(obj, "pos_z", 0.5));
                            float vel_x = static_cast<float>(get_json_double(obj, "vel_x", 0.0));
                            float vel_y = static_cast<float>(get_json_double(obj, "vel_y", 0.0));
                            float vel_z = static_cast<float>(get_json_double(obj, "vel_z", 0.0));
                            float ang_x = static_cast<float>(get_json_double(obj, "angular_vel_x", 0.0));
                            float ang_y = static_cast<float>(get_json_double(obj, "angular_vel_y", 0.0));
                            float ang_z = static_cast<float>(get_json_double(obj, "angular_vel_z", 0.0));
                            float density = static_cast<float>(get_json_double(obj, "density", 7850.0));
                            float E = static_cast<float>(get_json_double(obj, "youngs_modulus", 210.0e9));
                            float nu = static_cast<float>(get_json_double(obj, "poissons_ratio", 0.3));
                            float yield_stress = static_cast<float>(get_json_double(obj, "yield_stress", 400.0e6));
                            float hardening = static_cast<float>(get_json_double(obj, "hardening_modulus", 1.0e9));
                            float failure_strain = static_cast<float>(get_json_double(obj, "failure_strain", 0.25));
                            float tensile_failure_stress = static_cast<float>(get_json_double(obj, "tensile_failure_stress", 600.0e6));
                            int ppc = get_json_int(obj, "ppc", domain_ppc);

                            std::string mat_model_str = obj.value("material_model", "Hypoelastic");
                            Blast::MPMMaterialModel mat_model = Blast::MPMMaterialModel::HypoelasticSteel;
                            if (mat_model_str == "Johnson-Cook + Mie-Grüneisen") {
                                mat_model = Blast::MPMMaterialModel::JohnsonCookMieGruneisen;
                            }
                            float jc_A = static_cast<float>(get_json_double(obj, "jc_A", 792.0e6));
                            float jc_B = static_cast<float>(get_json_double(obj, "jc_B", 510.0e6));
                            float jc_n = static_cast<float>(get_json_double(obj, "jc_n", 0.26));
                            float jc_C = static_cast<float>(get_json_double(obj, "jc_C", 0.014));
                            float jc_m = static_cast<float>(get_json_double(obj, "jc_m", 1.03));
                            float T_melt = static_cast<float>(get_json_double(obj, "T_melt", 1793.0));
                            float T_room = static_cast<float>(get_json_double(obj, "T_room", 293.0));
                            float Cp = static_cast<float>(get_json_double(obj, "Cp", 477.0));
                            float mg_gamma0 = static_cast<float>(get_json_double(obj, "mg_gamma0", 1.81));
                            float mg_c0 = static_cast<float>(get_json_double(obj, "mg_c0", 4570.0));
                            float mg_s = static_cast<float>(get_json_double(obj, "mg_s", 1.49));

                            if (shape == "Sphere") {
                                float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
                                if (global_solver_mpm_3d_cuda) {
                                    global_solver_mpm_3d_cuda->addSphereObject(obj_idx, pos_x, pos_y, pos_z, radius, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                                } else {
                                    global_solver_mpm_3d->addSphereObject(obj_idx, pos_x, pos_y, pos_z, radius, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                                }
                            } else if (shape == "Cylinder") {
                                float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
                                float inner_radius = static_cast<float>(get_json_double(obj, "inner_radius", 0.0));
                                float height = static_cast<float>(get_json_double(obj, "height", 0.2));
                                if (global_solver_mpm_3d_cuda) {
                                    global_solver_mpm_3d_cuda->addCylinderObject(obj_idx, pos_x, pos_y, pos_z, radius, inner_radius, height, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                                } else {
                                    global_solver_mpm_3d->addCylinderObject(obj_idx, pos_x, pos_y, pos_z, radius, inner_radius, height, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                                }
                            } else if (shape == "STL") {
                                std::string stl_file = obj.contains("stl_file") ? obj["stl_file"].get<std::string>() : "";
                                float scale_x = static_cast<float>(get_json_double(obj, "scale_x", 1.0));
                                float scale_y = static_cast<float>(get_json_double(obj, "scale_y", 1.0));
                                float scale_z = static_cast<float>(get_json_double(obj, "scale_z", 1.0));
                                if (global_solver_mpm_3d_cuda) {
                                    global_solver_mpm_3d_cuda->addSTLObject(obj_idx, stl_file, pos_x, pos_y, pos_z, scale_x, scale_y, scale_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                                } else {
                                    global_solver_mpm_3d->addSTLObject(obj_idx, stl_file, pos_x, pos_y, pos_z, scale_x, scale_y, scale_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                                }
                            } else {
                                float size_x = static_cast<float>(get_json_double(obj, "size_x", 0.2));
                                float size_y = static_cast<float>(get_json_double(obj, "size_y", 0.2));
                                float size_z = static_cast<float>(get_json_double(obj, "size_z", 0.2));
                                if (global_solver_mpm_3d_cuda) {
                                    global_solver_mpm_3d_cuda->addBoxObject(obj_idx, pos_x, pos_y, pos_z, size_x, size_y, size_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                                } else {
                                    global_solver_mpm_3d->addBoxObject(obj_idx, pos_x, pos_y, pos_z, size_x, size_y, size_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc);
                                }
                            }

                            Blast::MaterialTable3D parsed_mat = parseMaterialTable3D(obj);
                            if (global_solver_mpm_3d_cuda) {
                                auto& mat_tables = global_solver_mpm_3d_cuda->getMaterialTables();
                                if (obj_idx >= 0 && obj_idx < static_cast<int>(mat_tables.size())) {
                                    mat_tables[obj_idx] = parsed_mat;
                                }
                                global_solver_mpm_3d_cuda->uploadMaterialTableToDevice();
                            }
                            if (global_solver_mpm_3d) {
                                auto& mat_tables = global_solver_mpm_3d->getMaterialTables();
                                if (obj_idx >= 0 && obj_idx < static_cast<int>(mat_tables.size())) {
                                    mat_tables[obj_idx] = parsed_mat;
                                }
                            }
                            auto& particles_ref = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getParticles() : global_solver_mpm_3d->getParticles();
                            for (auto& p : particles_ref) {
                                if (p.object_id == obj_idx) {
                                    p.temperature = T_room; p.e_int = 0.0f;
                                }
                            }
                        }
                    } else {
                        if (global_solver_mpm_3d_cuda) {
                            global_solver_mpm_3d_cuda->addBoxObject(1, 0.5f, 0.5f, 0.5f, 0.2f, 0.2f, 0.2f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 7850.0f, 210.0e9f, 0.3f, 400.0e6f, 1.0e9f, 0.25f, 600.0e6f, domain_ppc);
                        } else {
                            global_solver_mpm_3d->addBoxObject(1, 0.5f, 0.5f, 0.5f, 0.2f, 0.2f, 0.2f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 7850.0f, 210.0e9f, 0.3f, 400.0e6f, 1.0e9f, 0.25f, 600.0e6f, domain_ppc);
                        }
                    }

                    if (global_solver_mpm_3d_cuda) {
                        global_solver_mpm_3d_cuda->syncToDevice();
                        global_solver_mpm_3d_cuda->syncToHost();
                    } else {
                        global_solver_mpm_3d->particleToGrid();
                    }

                    init_gauges(msg);
                    emit_kernel_log("SYSTEM", "3D Coupled FSI Solver (CFD + MPM) Initialized", 0.0, "3d");

                    emit_telemetry_3d(0.0, false);
                    emit_telemetry_mpm_3d(0.0, false);

                    nlohmann::json prog_report;
                    prog_report["type"] = "progress";
                    prog_report["percent"] = 100;
                    prog_report["scope"] = "3d";
                    prog_report["mode"] = "INIT_FSI_3D";
                    {
                        std::lock_guard<std::mutex> lock(cout_mutex);
                        std::cout << prog_report.dump() << std::endl;
                    }
                    } catch (const std::exception& e) {
                        std::cerr << "[ERROR] Exception in INIT_FSI_3D: " << e.what() << std::endl;
                        emit_kernel_log("ERROR", std::string("FSI 3D initialization failed: ") + e.what(), 0.0, "3d");
                        std::exit(1);
                    } catch (...) {
                        std::cerr << "[ERROR] Unknown exception in INIT_FSI_3D" << std::endl;
                        emit_kernel_log("ERROR", "FSI 3D initialization failed with unknown error", 0.0, "3d");
                        std::exit(1);
                    }
                } else if (command == "INIT_FEM_3D" || command == "INIT_3D_FEM") {
                    std::string model_id = msg.value("modelId", msg.value("model_id", global_model_id.empty() ? "default_fem" : global_model_id));
                    global_model_id = model_id;
                    std::string precision = msg.value("precision", "single");
                    std::string device = msg.value("device", "cpu");
                    select_cuda_device(device);
                    bool use_gpu = is_cuda_device(device) || device == "gpu" || device == "cuda";

                    global_fem_solvers_float.erase(model_id);
                    global_fem_solvers_double.erase(model_id);
                    global_fem_solvers_cuda_float.erase(model_id);
                    global_fem_solvers_cuda_double.erase(model_id);

                    if (use_gpu) {
                        if (precision == "double") {
                            auto fem = std::make_unique<Blast::FEMSolver3DCUDA<double>>();
                            fem->setHourglassCoeff(static_cast<double>(get_json_double(msg, "hourglass_coeff", 0.1)));
                            fem->setContactPenaltyScale(static_cast<double>(get_json_double(msg, "contact_penalty_scale", 1.0)));
                            fem->setContactDamping(static_cast<double>(get_json_double(msg, "contact_damping", 0.20)));
                            fem->setFrictionCoefficients(static_cast<double>(get_json_double(msg, "friction_static", 0.3)), static_cast<double>(get_json_double(msg, "friction_kinetic", 0.2)));

                            std::string hg_model_str = msg.value("hourglass_model", "FlanaganBelytschkoStiffness");
                            if (hg_model_str == "FlanaganBelytschkoViscous") {
                                fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoViscous);
                            } else {
                                fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoStiffness);
                            }

                            std::string scheme_str = msg.value("integration_scheme", "OnePointFB");
                            if (scheme_str == "FullGauss8" || scheme_str == "FullIntegration8Pt") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::FullGauss8);
                            } else if (scheme_str == "SelectiveReduced") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::SelectiveReduced);
                            } else if (scheme_str == "OnePointKF") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointKF);
                            } else {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointFB);
                            }

                            Blast::FEMErosionCriteria<double> erosion{};
                            erosion.enable_strain_erosion = false;
                            erosion.enable_timestep_erosion = false;
                            erosion.enable_stress_erosion = false;
                            erosion.failure_strain = static_cast<double>(get_json_double(msg, "failure_strain", 0.50));
                            erosion.timestep_erosion_factor = static_cast<double>(get_json_double(msg, "timestep_erosion_factor", 0.10));
                            erosion.min_volume_ratio = static_cast<double>(get_json_double(msg, "min_volume_ratio", 0.02));
                            erosion.tensile_failure_stress = static_cast<double>(get_json_double(msg, "tensile_failure_stress", 600.0e6));

                            Blast::MaterialTable3D def_mat;
                            if (msg.contains("fem_objects") && msg["fem_objects"].is_array() && !msg["fem_objects"].empty()) {
                                for (const auto& obj : msg["fem_objects"]) {
                                    int nx = get_json_int(obj, "nx", 10);
                                    int ny = get_json_int(obj, "ny", 10);
                                    int nz = get_json_int(obj, "nz", 10);
                                    double lx = get_json_double(obj, "size_x", 1.0);
                                    double ly = get_json_double(obj, "size_y", 1.0);
                                    double lz = get_json_double(obj, "size_z", 1.0);
                                    double pos_x = get_json_double(obj, "pos_x", 0.0);
                                    double pos_y = get_json_double(obj, "pos_y", 0.0);
                                    double pos_z = get_json_double(obj, "pos_z", 0.0);
                                    double vel_x = get_json_double(obj, "vel_x", 0.0);
                                    double vel_y = get_json_double(obj, "vel_y", 0.0);
                                    double vel_z = get_json_double(obj, "vel_z", 0.0);
                                    Blast::MaterialTable3D obj_mat = parseMaterialTable3D(obj);

                                    std::string k_file = obj.value("k_file", "");
                                    std::string mesh_src = obj.value("mesh_source", "Box Generator");
                                    std::string shape_type = obj.value("shape_type", "Box");
                                    std::string bc_cond = obj.value("boundary_condition", "Free");
                                    if (mesh_src == "Cylinder Generator" || shape_type == "Cylinder") {
                                        double radius = get_json_double(obj, "radius", 0.1);
                                        if (radius <= 0.0) radius = get_json_double(obj, "size_x", 0.2) * 0.5;
                                        double inner_radius = get_json_double(obj, "inner_radius", 0.0);
                                        double height = get_json_double(obj, "height", 0.2);
                                        if (height <= 0.0) height = get_json_double(obj, "size_z", 0.2);
                                        fem->addStructuredCylinderMesh(nx, nz, radius, height, pos_x, pos_y, pos_z, obj_mat, vel_x, vel_y, vel_z, inner_radius, bc_cond);
                                    } else if (mesh_src == "LS-DYNA Keyword File" || shape_type == "LS-DYNA File" || !k_file.empty()) {
                                        std::vector<Blast::FEMNode3D<double>> nodes;
                                        std::vector<Blast::FEMElement3D<double>> elements;
                                        double scale_x = get_json_double(obj, "scale_x", get_json_double(obj, "scale_factor", 1.0));
                                        double scale_y = get_json_double(obj, "scale_y", get_json_double(obj, "scale_factor", 1.0));
                                        double scale_z = get_json_double(obj, "scale_z", get_json_double(obj, "scale_factor", 1.0));
                                        loadAndTransformLSDynaMesh<double>(k_file, pos_x, pos_y, pos_z, vel_x, vel_y, vel_z, scale_x, scale_y, scale_z, bc_cond, obj_mat, nodes, elements);
                                        fem->appendNodesAndElements(nodes, elements, obj_mat);
                                    } else {
                                        fem->addStructuredBoxMesh(nx, ny, nz, lx, ly, lz, pos_x, pos_y, pos_z, obj_mat, vel_x, vel_y, vel_z, bc_cond);
                                    }
                                }
                            } else if (msg.contains("k_file") && !msg["k_file"].get<std::string>().empty()) {
                                std::vector<Blast::FEMNode3D<double>> nodes;
                                std::vector<Blast::FEMElement3D<double>> elements;
                                double pos_x = get_json_double(msg, "pos_x", 0.0);
                                double pos_y = get_json_double(msg, "pos_y", 0.0);
                                double pos_z = get_json_double(msg, "pos_z", 0.0);
                                double vel_x = get_json_double(msg, "vel_x", 0.0);
                                double vel_y = get_json_double(msg, "vel_y", 0.0);
                                double vel_z = get_json_double(msg, "vel_z", 0.0);
                                double scale_x = get_json_double(msg, "scale_x", get_json_double(msg, "scale_factor", 1.0));
                                double scale_y = get_json_double(msg, "scale_y", get_json_double(msg, "scale_factor", 1.0));
                                double scale_z = get_json_double(msg, "scale_z", get_json_double(msg, "scale_factor", 1.0));
                                std::string bc_cond = msg.value("boundary_condition", "Free");
                                loadAndTransformLSDynaMesh<double>(msg["k_file"].get<std::string>(), pos_x, pos_y, pos_z, vel_x, vel_y, vel_z, scale_x, scale_y, scale_z, bc_cond, def_mat, nodes, elements);
                                fem->setNodesAndElements(nodes, elements, def_mat);
                            }
                            fem->setErosionCriteria(erosion);
                            global_fem_solvers_cuda_double[model_id] = std::move(fem);
                        } else {
                            auto fem = std::make_unique<Blast::FEMSolver3DCUDA<float>>();
                            fem->setHourglassCoeff(static_cast<float>(get_json_double(msg, "hourglass_coeff", 0.1)));
                            fem->setContactPenaltyScale(static_cast<float>(get_json_double(msg, "contact_penalty_scale", 1.0)));
                            fem->setContactDamping(static_cast<float>(get_json_double(msg, "contact_damping", 0.20)));
                            fem->setFrictionCoefficients(static_cast<float>(get_json_double(msg, "friction_static", 0.3)), static_cast<float>(get_json_double(msg, "friction_kinetic", 0.2)));

                            std::string hg_model_str = msg.value("hourglass_model", "FlanaganBelytschkoStiffness");
                            if (hg_model_str == "FlanaganBelytschkoViscous") {
                                fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoViscous);
                            } else {
                                fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoStiffness);
                            }

                            std::string scheme_str = msg.value("integration_scheme", "OnePointFB");
                            if (scheme_str == "FullGauss8" || scheme_str == "FullIntegration8Pt") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::FullGauss8);
                            } else if (scheme_str == "SelectiveReduced") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::SelectiveReduced);
                            } else if (scheme_str == "OnePointKF") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointKF);
                            } else {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointFB);
                            }

                            Blast::FEMErosionCriteria<float> erosion{};
                            erosion.enable_strain_erosion = false;
                            erosion.enable_timestep_erosion = false;
                            erosion.enable_stress_erosion = false;
                            erosion.failure_strain = static_cast<float>(get_json_double(msg, "failure_strain", 0.50));
                            erosion.timestep_erosion_factor = static_cast<float>(get_json_double(msg, "timestep_erosion_factor", 0.10));
                            erosion.min_volume_ratio = static_cast<float>(get_json_double(msg, "min_volume_ratio", 0.02));
                            erosion.tensile_failure_stress = static_cast<float>(get_json_double(msg, "tensile_failure_stress", 600.0e6));

                            Blast::MaterialTable3D def_mat;
                            if (msg.contains("fem_objects") && msg["fem_objects"].is_array() && !msg["fem_objects"].empty()) {
                                for (const auto& obj : msg["fem_objects"]) {
                                    int nx = get_json_int(obj, "nx", 10);
                                    int ny = get_json_int(obj, "ny", 10);
                                    int nz = get_json_int(obj, "nz", 10);
                                    float lx = static_cast<float>(get_json_double(obj, "size_x", 1.0));
                                    float ly = static_cast<float>(get_json_double(obj, "size_y", 1.0));
                                    float lz = static_cast<float>(get_json_double(obj, "size_z", 1.0));
                                    float pos_x = static_cast<float>(get_json_double(obj, "pos_x", 0.0));
                                    float pos_y = static_cast<float>(get_json_double(obj, "pos_y", 0.0));
                                    float pos_z = static_cast<float>(get_json_double(obj, "pos_z", 0.0));
                                    float vel_x = static_cast<float>(get_json_double(obj, "vel_x", 0.0));
                                    float vel_y = static_cast<float>(get_json_double(obj, "vel_y", 0.0));
                                    float vel_z = static_cast<float>(get_json_double(obj, "vel_z", 0.0));
                                    Blast::MaterialTable3D obj_mat = parseMaterialTable3D(obj);

                                    std::string k_file = obj.value("k_file", "");
                                    std::string mesh_src = obj.value("mesh_source", "Box Generator");
                                    std::string shape_type = obj.value("shape_type", "Box");
                                    std::string bc_cond = obj.value("boundary_condition", "Free");
                                    if (mesh_src == "Cylinder Generator" || shape_type == "Cylinder") {
                                        float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
                                        if (radius <= 0.0f) radius = static_cast<float>(get_json_double(obj, "size_x", 0.2)) * 0.5f;
                                        float inner_radius = static_cast<float>(get_json_double(obj, "inner_radius", 0.0));
                                        float height = static_cast<float>(get_json_double(obj, "height", 0.2));
                                        if (height <= 0.0f) height = static_cast<float>(get_json_double(obj, "size_z", 0.2));
                                        fem->addStructuredCylinderMesh(nx, nz, radius, height, pos_x, pos_y, pos_z, obj_mat, vel_x, vel_y, vel_z, inner_radius, bc_cond);
                                    } else if (mesh_src == "LS-DYNA Keyword File" || shape_type == "LS-DYNA File" || !k_file.empty()) {
                                        std::vector<Blast::FEMNode3D<float>> nodes;
                                        std::vector<Blast::FEMElement3D<float>> elements;
                                        float scale_x = static_cast<float>(get_json_double(obj, "scale_x", get_json_double(obj, "scale_factor", 1.0)));
                                        float scale_y = static_cast<float>(get_json_double(obj, "scale_y", get_json_double(obj, "scale_factor", 1.0)));
                                        float scale_z = static_cast<float>(get_json_double(obj, "scale_z", get_json_double(obj, "scale_factor", 1.0)));
                                        loadAndTransformLSDynaMesh<float>(k_file, pos_x, pos_y, pos_z, vel_x, vel_y, vel_z, scale_x, scale_y, scale_z, bc_cond, obj_mat, nodes, elements);
                                        fem->appendNodesAndElements(nodes, elements, obj_mat);
                                    } else {
                                        fem->addStructuredBoxMesh(nx, ny, nz, lx, ly, lz, pos_x, pos_y, pos_z, obj_mat, vel_x, vel_y, vel_z, bc_cond);
                                    }
                                }
                            } else if (msg.contains("k_file") && !msg["k_file"].get<std::string>().empty()) {
                                std::vector<Blast::FEMNode3D<float>> nodes;
                                std::vector<Blast::FEMElement3D<float>> elements;
                                float pos_x = static_cast<float>(get_json_double(msg, "pos_x", 0.0));
                                float pos_y = static_cast<float>(get_json_double(msg, "pos_y", 0.0));
                                float pos_z = static_cast<float>(get_json_double(msg, "pos_z", 0.0));
                                float vel_x = static_cast<float>(get_json_double(msg, "vel_x", 0.0));
                                float vel_y = static_cast<float>(get_json_double(msg, "vel_y", 0.0));
                                float vel_z = static_cast<float>(get_json_double(msg, "vel_z", 0.0));
                                float scale_x = static_cast<float>(get_json_double(msg, "scale_x", get_json_double(msg, "scale_factor", 1.0)));
                                float scale_y = static_cast<float>(get_json_double(msg, "scale_y", get_json_double(msg, "scale_factor", 1.0)));
                                float scale_z = static_cast<float>(get_json_double(msg, "scale_z", get_json_double(msg, "scale_factor", 1.0)));
                                std::string bc_cond = msg.value("boundary_condition", "Free");
                                loadAndTransformLSDynaMesh<float>(msg["k_file"].get<std::string>(), pos_x, pos_y, pos_z, vel_x, vel_y, vel_z, scale_x, scale_y, scale_z, bc_cond, def_mat, nodes, elements);
                                fem->setNodesAndElements(nodes, elements, def_mat);
                            }
                            fem->setErosionCriteria(erosion);
                            global_fem_solvers_cuda_float[model_id] = std::move(fem);
                        }
                    } else {
                        if (precision == "double") {
                            auto fem = std::make_unique<Blast::FEMSolver3D<double>>();
                            fem->setHourglassCoeff(static_cast<double>(get_json_double(msg, "hourglass_coeff", 0.1)));
                            fem->setContactPenaltyScale(static_cast<double>(get_json_double(msg, "contact_penalty_scale", 1.0)));
                            fem->setContactDamping(static_cast<double>(get_json_double(msg, "contact_damping", 0.20)));
                            fem->setFrictionCoefficients(static_cast<double>(get_json_double(msg, "friction_static", 0.3)), static_cast<double>(get_json_double(msg, "friction_kinetic", 0.2)));

                            std::string hg_model_str = msg.value("hourglass_model", "FlanaganBelytschkoStiffness");
                            if (hg_model_str == "FlanaganBelytschkoViscous") {
                                fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoViscous);
                            } else {
                                fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoStiffness);
                            }

                            std::string scheme_str = msg.value("integration_scheme", "OnePointFB");
                            if (scheme_str == "FullGauss8" || scheme_str == "FullIntegration8Pt") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::FullGauss8);
                            } else if (scheme_str == "SelectiveReduced") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::SelectiveReduced);
                            } else if (scheme_str == "OnePointKF") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointKF);
                            } else {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointFB);
                            }

                            auto physics_params = fem->getPhysicsParams();
                            physics_params.convert_failed_elements_to_mpm = msg.value("convert_failed_elements_to_mpm", false);
                            physics_params.mpm_particles_per_failed_element = get_json_int(msg, "mpm_particles_per_failed_element", 8);
                            fem->setPhysicsParams(physics_params);
                            if (global_solver_mpm_3d) {
                                fem->setMPMSolver(global_solver_mpm_3d.get());
                            }

                            Blast::FEMErosionCriteria<double> erosion{};
                            erosion.enable_strain_erosion = false;
                            erosion.enable_timestep_erosion = false;
                            erosion.enable_stress_erosion = false;
                            erosion.failure_strain = static_cast<double>(get_json_double(msg, "failure_strain", 0.50));
                            erosion.timestep_erosion_factor = static_cast<double>(get_json_double(msg, "timestep_erosion_factor", 0.10));
                            erosion.min_volume_ratio = static_cast<double>(get_json_double(msg, "min_volume_ratio", 0.02));
                            erosion.tensile_failure_stress = static_cast<double>(get_json_double(msg, "tensile_failure_stress", 600.0e6));

                            Blast::MaterialTable3D def_mat;
                            if (msg.contains("fem_objects") && msg["fem_objects"].is_array() && !msg["fem_objects"].empty()) {
                                for (const auto& obj : msg["fem_objects"]) {
                                    int nx = get_json_int(obj, "nx", 10);
                                    int ny = get_json_int(obj, "ny", 10);
                                    int nz = get_json_int(obj, "nz", 10);
                                    double lx = get_json_double(obj, "size_x", 1.0);
                                    double ly = get_json_double(obj, "size_y", 1.0);
                                    double lz = get_json_double(obj, "size_z", 1.0);
                                    double pos_x = get_json_double(obj, "pos_x", 0.0);
                                    double pos_y = get_json_double(obj, "pos_y", 0.0);
                                    double pos_z = get_json_double(obj, "pos_z", 0.0);
                                    double vel_x = get_json_double(obj, "vel_x", 0.0);
                                    double vel_y = get_json_double(obj, "vel_y", 0.0);
                                    double vel_z = get_json_double(obj, "vel_z", 0.0);
                                    Blast::MaterialTable3D obj_mat = parseMaterialTable3D(obj);

                                    std::string k_file = obj.value("k_file", "");
                                    std::string mesh_src = obj.value("mesh_source", "Box Generator");
                                    std::string shape_type = obj.value("shape_type", "Box");
                                    std::string bc_cond = obj.value("boundary_condition", "Free");
                                    if (mesh_src == "Cylinder Generator" || shape_type == "Cylinder") {
                                        double radius = get_json_double(obj, "radius", 0.1);
                                        if (radius <= 0.0) radius = get_json_double(obj, "size_x", 0.2) * 0.5;
                                        double inner_radius = get_json_double(obj, "inner_radius", 0.0);
                                        double height = get_json_double(obj, "height", 0.2);
                                        if (height <= 0.0) height = get_json_double(obj, "size_z", 0.2);
                                        fem->addStructuredCylinderMesh(nx, nz, radius, height, pos_x, pos_y, pos_z, obj_mat, vel_x, vel_y, vel_z, inner_radius, bc_cond);
                                    } else if (mesh_src == "LS-DYNA Keyword File" || shape_type == "LS-DYNA File" || !k_file.empty()) {
                                        std::vector<Blast::FEMNode3D<double>> nodes;
                                        std::vector<Blast::FEMElement3D<double>> elements;
                                        double scale_x = get_json_double(obj, "scale_x", get_json_double(obj, "scale_factor", 1.0));
                                        double scale_y = get_json_double(obj, "scale_y", get_json_double(obj, "scale_factor", 1.0));
                                        double scale_z = get_json_double(obj, "scale_z", get_json_double(obj, "scale_factor", 1.0));
                                        loadAndTransformLSDynaMesh<double>(k_file, pos_x, pos_y, pos_z, vel_x, vel_y, vel_z, scale_x, scale_y, scale_z, bc_cond, obj_mat, nodes, elements);
                                        fem->appendNodesAndElements(nodes, elements, obj_mat);
                                    } else {
                                        fem->addStructuredBoxMesh(nx, ny, nz, lx, ly, lz, pos_x, pos_y, pos_z, obj_mat, vel_x, vel_y, vel_z, bc_cond);
                                    }
                                }
                            } else if (msg.contains("k_file") && !msg["k_file"].get<std::string>().empty()) {
                                std::vector<Blast::FEMNode3D<double>> nodes;
                                std::vector<Blast::FEMElement3D<double>> elements;
                                double pos_x = get_json_double(msg, "pos_x", 0.0);
                                double pos_y = get_json_double(msg, "pos_y", 0.0);
                                double pos_z = get_json_double(msg, "pos_z", 0.0);
                                double vel_x = get_json_double(msg, "vel_x", 0.0);
                                double vel_y = get_json_double(msg, "vel_y", 0.0);
                                double vel_z = get_json_double(msg, "vel_z", 0.0);
                                double scale_x = get_json_double(msg, "scale_x", get_json_double(msg, "scale_factor", 1.0));
                                double scale_y = get_json_double(msg, "scale_y", get_json_double(msg, "scale_factor", 1.0));
                                double scale_z = get_json_double(msg, "scale_z", get_json_double(msg, "scale_factor", 1.0));
                                std::string bc_cond = msg.value("boundary_condition", "Free");
                                loadAndTransformLSDynaMesh<double>(msg["k_file"].get<std::string>(), pos_x, pos_y, pos_z, vel_x, vel_y, vel_z, scale_x, scale_y, scale_z, bc_cond, def_mat, nodes, elements);
                                fem->setNodesAndElements(nodes, elements, def_mat);
                            }
                            fem->setErosionCriteria(erosion);
                            global_fem_solvers_double[model_id] = std::move(fem);
                        } else {
                            auto fem = std::make_unique<Blast::FEMSolver3D<float>>();
                            fem->setHourglassCoeff(static_cast<float>(get_json_double(msg, "hourglass_coeff", 0.1)));
                            fem->setContactPenaltyScale(static_cast<float>(get_json_double(msg, "contact_penalty_scale", 1.0)));
                            fem->setContactDamping(static_cast<float>(get_json_double(msg, "contact_damping", 0.20)));
                            fem->setFrictionCoefficients(static_cast<float>(get_json_double(msg, "friction_static", 0.3)), static_cast<float>(get_json_double(msg, "friction_kinetic", 0.2)));

                            std::string hg_model_str = msg.value("hourglass_model", "FlanaganBelytschkoStiffness");
                            if (hg_model_str == "FlanaganBelytschkoViscous") {
                                fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoViscous);
                            } else {
                                fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoStiffness);
                            }

                            std::string scheme_str = msg.value("integration_scheme", "OnePointFB");
                            if (scheme_str == "FullGauss8" || scheme_str == "FullIntegration8Pt") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::FullGauss8);
                            } else if (scheme_str == "SelectiveReduced") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::SelectiveReduced);
                            } else if (scheme_str == "OnePointKF") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointKF);
                            } else {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointFB);
                            }

                            auto physics_params = fem->getPhysicsParams();
                            physics_params.convert_failed_elements_to_mpm = msg.value("convert_failed_elements_to_mpm", false);
                            physics_params.mpm_particles_per_failed_element = get_json_int(msg, "mpm_particles_per_failed_element", 8);
                            fem->setPhysicsParams(physics_params);
                            if (global_solver_mpm_3d) {
                                fem->setMPMSolver(global_solver_mpm_3d.get());
                            }

                            Blast::FEMErosionCriteria<float> erosion{};
                            erosion.enable_strain_erosion = false;
                            erosion.enable_timestep_erosion = false;
                            erosion.enable_stress_erosion = false;
                            erosion.failure_strain = static_cast<float>(get_json_double(msg, "failure_strain", 0.50));
                            erosion.timestep_erosion_factor = static_cast<float>(get_json_double(msg, "timestep_erosion_factor", 0.10));
                            erosion.min_volume_ratio = static_cast<float>(get_json_double(msg, "min_volume_ratio", 0.02));
                            erosion.tensile_failure_stress = static_cast<float>(get_json_double(msg, "tensile_failure_stress", 600.0e6));

                            Blast::MaterialTable3D def_mat;
                            if (msg.contains("fem_objects") && msg["fem_objects"].is_array() && !msg["fem_objects"].empty()) {
                                for (const auto& obj : msg["fem_objects"]) {
                                    int nx = get_json_int(obj, "nx", 10);
                                    int ny = get_json_int(obj, "ny", 10);
                                    int nz = get_json_int(obj, "nz", 10);
                                    float lx = static_cast<float>(get_json_double(obj, "size_x", 1.0));
                                    float ly = static_cast<float>(get_json_double(obj, "size_y", 1.0));
                                    float lz = static_cast<float>(get_json_double(obj, "size_z", 1.0));
                                    float pos_x = static_cast<float>(get_json_double(obj, "pos_x", 0.0));
                                    float pos_y = static_cast<float>(get_json_double(obj, "pos_y", 0.0));
                                    float pos_z = static_cast<float>(get_json_double(obj, "pos_z", 0.0));
                                    float vel_x = static_cast<float>(get_json_double(obj, "vel_x", 0.0));
                                    float vel_y = static_cast<float>(get_json_double(obj, "vel_y", 0.0));
                                    float vel_z = static_cast<float>(get_json_double(obj, "vel_z", 0.0));
                                    Blast::MaterialTable3D obj_mat = parseMaterialTable3D(obj);

                                    std::string k_file = obj.value("k_file", "");
                                    std::string mesh_src = obj.value("mesh_source", "Box Generator");
                                    std::string shape_type = obj.value("shape_type", "Box");
                                    std::string bc_cond = obj.value("boundary_condition", "Free");
                                    if (mesh_src == "Cylinder Generator" || shape_type == "Cylinder") {
                                        float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
                                        if (radius <= 0.0f) radius = static_cast<float>(get_json_double(obj, "size_x", 0.2)) * 0.5f;
                                        float inner_radius = static_cast<float>(get_json_double(obj, "inner_radius", 0.0));
                                        float height = static_cast<float>(get_json_double(obj, "height", 0.2));
                                        if (height <= 0.0f) height = static_cast<float>(get_json_double(obj, "size_z", 0.2));
                                        fem->addStructuredCylinderMesh(nx, nz, radius, height, pos_x, pos_y, pos_z, obj_mat, vel_x, vel_y, vel_z, inner_radius, bc_cond);
                                    } else if (mesh_src == "LS-DYNA Keyword File" || shape_type == "LS-DYNA File" || !k_file.empty()) {
                                        std::vector<Blast::FEMNode3D<float>> nodes;
                                        std::vector<Blast::FEMElement3D<float>> elements;
                                        float scale_x = static_cast<float>(get_json_double(obj, "scale_x", get_json_double(obj, "scale_factor", 1.0)));
                                        float scale_y = static_cast<float>(get_json_double(obj, "scale_y", get_json_double(obj, "scale_factor", 1.0)));
                                        float scale_z = static_cast<float>(get_json_double(obj, "scale_z", get_json_double(obj, "scale_factor", 1.0)));
                                        loadAndTransformLSDynaMesh<float>(k_file, pos_x, pos_y, pos_z, vel_x, vel_y, vel_z, scale_x, scale_y, scale_z, bc_cond, obj_mat, nodes, elements);
                                        fem->appendNodesAndElements(nodes, elements, obj_mat);
                                    } else {
                                        fem->addStructuredBoxMesh(nx, ny, nz, lx, ly, lz, pos_x, pos_y, pos_z, obj_mat, vel_x, vel_y, vel_z, bc_cond);
                                    }
                                }
                            } else if (msg.contains("k_file") && !msg["k_file"].get<std::string>().empty()) {
                                std::vector<Blast::FEMNode3D<float>> nodes;
                                std::vector<Blast::FEMElement3D<float>> elements;
                                float pos_x = static_cast<float>(get_json_double(msg, "pos_x", 0.0));
                                float pos_y = static_cast<float>(get_json_double(msg, "pos_y", 0.0));
                                float pos_z = static_cast<float>(get_json_double(msg, "pos_z", 0.0));
                                float vel_x = static_cast<float>(get_json_double(msg, "vel_x", 0.0));
                                float vel_y = static_cast<float>(get_json_double(msg, "vel_y", 0.0));
                                float vel_z = static_cast<float>(get_json_double(msg, "vel_z", 0.0));
                                float scale_x = static_cast<float>(get_json_double(msg, "scale_x", get_json_double(msg, "scale_factor", 1.0)));
                                float scale_y = static_cast<float>(get_json_double(msg, "scale_y", get_json_double(msg, "scale_factor", 1.0)));
                                float scale_z = static_cast<float>(get_json_double(msg, "scale_z", get_json_double(msg, "scale_factor", 1.0)));
                                std::string bc_cond = msg.value("boundary_condition", "Free");
                                loadAndTransformLSDynaMesh<float>(msg["k_file"].get<std::string>(), pos_x, pos_y, pos_z, vel_x, vel_y, vel_z, scale_x, scale_y, scale_z, bc_cond, def_mat, nodes, elements);
                                fem->setNodesAndElements(nodes, elements, def_mat);
                            }
                            fem->setErosionCriteria(erosion);
                            global_fem_solvers_float[model_id] = std::move(fem);
                        }
                    }
                    emit_kernel_log("SYSTEM", "3D Hexahedral Explicit FEM Solver Initialized for model " + model_id, 0.0, "3d");
                    emit_telemetry_fem_3d(0.0, false);
                } else if (command == "STEP_FEM_3D") {
                    if (msg.contains("modelId")) global_model_id = msg["modelId"].get<std::string>();
                    else if (msg.contains("model_id")) global_model_id = msg["model_id"].get<std::string>();
                    int steps = get_json_int(msg, "steps", 1);
                    global_cfl_fem_3d = static_cast<float>(get_json_double(msg, "cfl", 0.3));
                    if (msg.contains("refresh_rate")) {
                        global_refresh_rate_fem_3d = get_json_double(msg, "refresh_rate", 0.033);
                    }
                    global_exec_until_end_fem_3d = false;
                    if (!sim_fem_3d_running) {
                        global_target_steps_fem_3d = steps;
                        sim_fem_3d_running = true;
                        sim_fem_3d_paused = false;
                        sim_fem_3d_terminate = false;
                        std::thread(worker_fem_3d_thread_func).detach();
                    } else {
                        global_target_steps_fem_3d.fetch_add(steps);
                        sim_fem_3d_paused = false;
                    }

                } else if (command == "EXEC_ALL_FEM_3D") {
                    if (msg.contains("modelId")) global_model_id = msg["modelId"].get<std::string>();
                    else if (msg.contains("model_id")) global_model_id = msg["model_id"].get<std::string>();
                    global_cfl_fem_3d = static_cast<float>(get_json_double(msg, "cfl", 0.3));
                    if (msg.contains("refresh_rate")) {
                        global_refresh_rate_fem_3d = get_json_double(msg, "refresh_rate", 0.033);
                    }
                    global_exec_until_end_fem_3d = true;
                    if (!sim_fem_3d_running) {
                        sim_fem_3d_running = true;
                        sim_fem_3d_paused = false;
                        sim_fem_3d_terminate = false;
                        std::thread(worker_fem_3d_thread_func).detach();
                    } else {
                        sim_fem_3d_paused = false;
                    }

                } else if (command == "PAUSE_FEM_3D") {
                    sim_fem_3d_paused = true;
                    global_target_steps_fem_3d = 0;

                } else if (command == "TERMINATE_FEM_3D") {
                    sim_fem_3d_terminate = true;
                    while (sim_fem_3d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_fem_solvers_float.clear();
                    global_fem_solvers_double.clear();
                    global_fem_solvers_cuda_float.clear();
                    global_fem_solvers_cuda_double.clear();
                } else if (command == "STEP_FSI_3D") {
                    int steps = get_json_int(msg, "steps", 1);
                    global_cfl_fsi_3d = static_cast<float>(get_json_double(msg, "cfl", 0.35));
                    global_exec_until_end_fsi_3d = false;
                    if (!sim_fsi_3d_running) {
                        global_target_steps_fsi_3d = steps;
                        sim_fsi_3d_running = true;
                        sim_fsi_3d_paused = false;
                        sim_fsi_3d_terminate = false;
                        std::thread(worker_fsi_3d_thread_func).detach();
                    } else {
                        global_target_steps_fsi_3d.fetch_add(steps);
                        sim_fsi_3d_paused = false;
                    }

                } else if (command == "EXEC_ALL_FSI_3D") {
                    global_cfl_fsi_3d = static_cast<float>(get_json_double(msg, "cfl", 0.35));
                    global_exec_until_end_fsi_3d = true;
                    if (!sim_fsi_3d_running) {
                        sim_fsi_3d_running = true;
                        sim_fsi_3d_paused = false;
                        sim_fsi_3d_terminate = false;
                        std::thread(worker_fsi_3d_thread_func).detach();
                    } else {
                        sim_fsi_3d_paused = false;
                    }

                } else if (command == "PAUSE_FSI_3D") {
                    sim_fsi_3d_paused = true;
                    global_target_steps_fsi_3d = 0;

                } else if (command == "TERMINATE_FSI_3D") {
                    sim_fsi_3d_terminate = true;
                    while (sim_fsi_3d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_3d.reset();
                    global_solver_mpm_3d.reset();
                    global_solver_mpm_3d_cuda.reset();
                } else if (command == "INIT_FEM_FSI_3D") {
                    try {
                        sim3d_terminate = true;
                        sim_fem_3d_terminate = true;
                        sim_fem_fsi_3d_terminate = true;
                        while (sim3d_running.load() || sim3d_init_in_progress.load() || sim_fem_3d_running.load() || sim_fem_fsi_3d_running.load()) {
                            std::this_thread::sleep_for(std::chrono::milliseconds(5));
                        }
                        global_solver_3d.reset();
                        global_fem_solvers_float.clear();
                        global_fem_solvers_double.clear();
                        global_fem_solvers_cuda_float.clear();
                        global_fem_solvers_cuda_double.clear();
                        global_fem_fsi_couplers_float.clear();
                        global_fem_fsi_couplers_double.clear();
                        global_fem_fsi_couplers_cuda_float.clear();
                        global_fem_fsi_couplers_cuda_double.clear();

                        sim3d_terminate = false;
                        sim3d_paused = false;
                        sim_fem_3d_terminate = false;
                        sim_fem_3d_paused = false;
                        sim_fem_fsi_3d_terminate = false;
                        sim_fem_fsi_3d_paused = false;
                        step_progress_3d = 0;
                        global_step_3d = 0;
                        global_step_fem_fsi_3d = 0;
                        global_t3d = 0.0;
                        global_wallclock_3d = 0.0;

                        global_slices_3d.clear();
                        if (msg.contains("slices")) {
                            for (const auto& s_msg : msg["slices"]) {
                                Slice3D s;
                                s.axis = s_msg.value("axis", "xy");
                                s.offset = s_msg.value("offset", 0.5);
                                s.stride = s_msg.value("stride", 1);
                                s.enabled = s_msg.value("enabled", true);
                                if (s.stride < 1) s.stride = 1;
                                if (s_msg.contains("quantities")) {
                                    for (const auto& q : s_msg["quantities"]) {
                                        s.quantities.push_back(q.get<std::string>());
                                    }
                                }
                                global_slices_3d.push_back(s);
                            }
                        } else {
                            Slice3D s;
                            s.axis = "xy";
                            s.offset = 0.5;
                            s.stride = 1;
                            s.enabled = true;
                            s.quantities.push_back("pressure");
                            global_slices_3d.push_back(s);
                        }

                        // 1. Initialize CFD 3D solver
                        double cellSize = get_json_double(msg, "cell_size", 0.01);
                        double xmin = get_json_double(msg, "xmin", 0.0);
                        double ymin = get_json_double(msg, "ymin", 0.0);
                        double zmin = get_json_double(msg, "zmin", 0.0);
                        double xmax = get_json_double(msg, "xmax", xmin + 1.0);
                        double ymax = get_json_double(msg, "ymax", ymin + 1.0);
                        double zmax = get_json_double(msg, "zmax", zmin + 1.0);
                        int default_nx = std::max(1, static_cast<int>(std::round((xmax - xmin) / cellSize)));
                        int default_ny = std::max(1, static_cast<int>(std::round((ymax - ymin) / cellSize)));
                        int default_nz = std::max(1, static_cast<int>(std::round((zmax - zmin) / cellSize)));
                        int nx = get_json_int(msg, "nx", default_nx);
                        int ny = get_json_int(msg, "ny", default_ny);
                        int nz = get_json_int(msg, "nz", default_nz);
                        if (nx <= 0) nx = default_nx;
                        if (ny <= 0) ny = default_ny;
                        if (nz <= 0) nz = default_nz;
                        std::string device = msg.value("device", "cpu");
                        std::string precision = msg.value("precision", "single");
                        std::string init_mode = msg.value("init_mode", "Multi-Material JWL");
                        std::string explosive_type = msg.value("explosive_type", "");
                        std::string material_type = msg.value("material_type", "");
                        bool is_ideal_gas_3d = (msg.value("is_ideal_gas", false) || init_mode == "Ideal Gas" || explosive_type == "MaterialIdealGas" || material_type == "Ideal Gas Charge");
                        bool is_multimat = !is_ideal_gas_3d;

                        select_cuda_device(device);
                        bool use_gpu = is_cuda_device(device) || device == "gpu" || device == "cuda";

                        if (use_gpu) {
                            if (precision == "single" || precision == "float") {
                                if (is_multimat) global_solver_3d = std::make_unique<CFDSolver3DCuda<float, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                                else global_solver_3d = std::make_unique<CFDSolver3DCuda<float, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                            } else {
                                if (is_multimat) global_solver_3d = std::make_unique<CFDSolver3DCuda<double, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                                else global_solver_3d = std::make_unique<CFDSolver3DCuda<double, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                            }
                        } else {
                            if (precision == "single" || precision == "float") {
                                if (is_multimat) global_solver_3d = std::make_unique<CFDSolver3DImpl<float, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                                else global_solver_3d = std::make_unique<CFDSolver3DImpl<float, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                            } else {
                                if (is_multimat) global_solver_3d = std::make_unique<CFDSolver3DImpl<double, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                                else global_solver_3d = std::make_unique<CFDSolver3DImpl<double, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                            }
                        }

                        global_solver_3d->setFluxScheme(msg.value("flux_scheme", "AUSM+"));
                        global_solver_3d->setSpatialOrder(get_json_int(msg, "spatial_order", 2));
                        global_solver_3d->setTemporalOrder(get_json_int(msg, "temporal_order", 4));

                        Charge3DParams cp;
                        std::string shape_str = msg.value("charge_shape", "Sphere");
                        if (shape_str == "Sphere") cp.shape_type = 0;
                        else if (shape_str == "Block") cp.shape_type = 1;
                        else cp.shape_type = 2;
                        cp.x = get_json_double(msg, "charge_x", 0.0);
                        cp.y = get_json_double(msg, "charge_y", 0.0);
                        cp.z = get_json_double(msg, "charge_z", 0.0);
                        cp.radius = get_json_double(msg, "charge_radius", 0.1);
                        cp.height = get_json_double(msg, "charge_height", 0.2);
                        if (msg.contains("charge_aspect_ratio") && !msg.contains("charge_height")) {
                            double ar = get_json_double(msg, "charge_aspect_ratio", 1.0);
                            if (ar > 0.0) cp.height = 2.0 * cp.radius * ar;
                        }
                        cp.lx = get_json_double(msg, "charge_lx", 0.1);
                        cp.ly = get_json_double(msg, "charge_ly", 0.1);
                        cp.lz = get_json_double(msg, "charge_lz", 0.1);
                        cp.rot_x = get_json_double(msg, "charge_rot_x", get_json_double(msg, "rot_x", 0.0));
                        cp.rot_y = get_json_double(msg, "charge_rot_y", get_json_double(msg, "rot_y", 0.0));
                        cp.rot_z = get_json_double(msg, "charge_rot_z", get_json_double(msg, "rot_z", 0.0));

                        MultiMat::MaterialSet matSet = parseMaterialSet(msg);
                        double ambient_rho = get_json_double(msg, "ambient_rho", 1.225648589);
                        double ambient_p = get_json_double(msg, "atm_pressure", 101325.0);
                        global_solver_3d->setInitialCondition(cp, matSet, ambient_rho, ambient_p);

                        if (msg.contains("detonator_x")) {
                            global_solver_3d->setDetonatorLocation(get_json_double(msg, "detonator_x", cp.x), get_json_double(msg, "detonator_y", cp.y), get_json_double(msg, "detonator_z", cp.z));
                        }

                        auto map_bc_3d = [](const std::string& str) {
                            if (str == "Transmitting" || str == "TRANSMISSIVE") return BCType3D::TRANSMISSIVE;
                            if (str == "Terminate" || str == "OUTFLOW_RIEMANN") return BCType3D::OUTFLOW_RIEMANN;
                            return BCType3D::REFLECTIVE;
                        };
                        global_solver_3d->setBoundaryConditions(
                            map_bc_3d(msg.value("bc_x_min", "Reflecting")), map_bc_3d(msg.value("bc_x_max", "Transmitting")),
                            map_bc_3d(msg.value("bc_y_min", "Reflecting")), map_bc_3d(msg.value("bc_y_max", "Transmitting")),
                            map_bc_3d(msg.value("bc_z_min", "Reflecting")), map_bc_3d(msg.value("bc_z_max", "Transmitting"))
                        );

                        // 2. Initialize 3D FEM Solver and Coupler
                        std::string model_id = msg.value("modelId", msg.value("model_id", global_model_id.empty() ? "default_fem" : global_model_id));
                        global_model_id = model_id;

                        if (use_gpu) {
                            if (precision == "double") {
                                auto fem = std::make_unique<Blast::FEMSolver3DCUDA<double>>();
                                fem->setHourglassCoeff(static_cast<double>(get_json_double(msg, "hourglass_coeff", 0.1)));
                                fem->setContactPenaltyScale(static_cast<double>(get_json_double(msg, "contact_penalty_scale", 1.0)));
                                fem->setContactDamping(static_cast<double>(get_json_double(msg, "contact_damping", 0.20)));
                                fem->setFrictionCoefficients(static_cast<double>(get_json_double(msg, "friction_static", 0.3)), static_cast<double>(get_json_double(msg, "friction_kinetic", 0.2)));

                                std::string scheme_str = msg.value("integration_scheme", "OnePointFB");
                                if (scheme_str == "FullGauss8" || scheme_str == "FullIntegration8Pt") {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::FullGauss8);
                                } else if (scheme_str == "SelectiveReduced") {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::SelectiveReduced);
                                } else if (scheme_str == "OnePointKF") {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointKF);
                                } else {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointFB);
                                }

                                Blast::FEMErosionCriteria<double> erosion{};
                                erosion.failure_strain = static_cast<double>(get_json_double(msg, "failure_strain", 0.50));
                                erosion.timestep_erosion_factor = static_cast<double>(get_json_double(msg, "timestep_erosion_factor", 0.10));
                                erosion.min_volume_ratio = static_cast<double>(get_json_double(msg, "min_volume_ratio", 0.02));
                                erosion.tensile_failure_stress = static_cast<double>(get_json_double(msg, "tensile_failure_stress", 600.0e6));

                                if (msg.contains("fem_objects") && msg["fem_objects"].is_array() && !msg["fem_objects"].empty()) {
                                    for (const auto& obj : msg["fem_objects"]) {
                                        int nx_fem = get_json_int(obj, "nx", 10);
                                        int ny_fem = get_json_int(obj, "ny", 10);
                                        int nz_fem = get_json_int(obj, "nz", 10);
                                        double lx = get_json_double(obj, "size_x", 1.0);
                                        double ly = get_json_double(obj, "size_y", 1.0);
                                        double lz = get_json_double(obj, "size_z", 1.0);
                                        double pos_x = get_json_double(obj, "pos_x", 0.0);
                                        double pos_y = get_json_double(obj, "pos_y", 0.0);
                                        double pos_z = get_json_double(obj, "pos_z", 0.0);
                                        double vel_x = get_json_double(obj, "vel_x", 0.0);
                                        double vel_y = get_json_double(obj, "vel_y", 0.0);
                                        double vel_z = get_json_double(obj, "vel_z", 0.0);
                                        Blast::MaterialTable3D obj_mat = parseMaterialTable3D(obj);
                                        std::string k_file = obj.value("k_file", "");
                                        std::string mesh_src = obj.value("mesh_source", "Box Generator");
                                        std::string shape_type = obj.value("shape_type", "Box");
                                        std::string bc_cond = obj.value("boundary_condition", "Free");

                                        if (mesh_src == "Cylinder Generator" || shape_type == "Cylinder") {
                                            double radius = get_json_double(obj, "radius", 0.1);
                                            if (radius <= 0.0) radius = get_json_double(obj, "size_x", 0.2) * 0.5;
                                            double inner_radius = get_json_double(obj, "inner_radius", 0.0);
                                            double height = get_json_double(obj, "height", 0.2);
                                            if (height <= 0.0) height = get_json_double(obj, "size_z", 0.2);
                                            fem->addStructuredCylinderMesh(nx_fem, nz_fem, radius, height, pos_x, pos_y, pos_z, obj_mat, vel_x, vel_y, vel_z, inner_radius, bc_cond);
                                        } else if (mesh_src == "LS-DYNA Keyword File" || shape_type == "LS-DYNA File" || !k_file.empty()) {
                                            std::vector<Blast::FEMNode3D<double>> nodes;
                                            std::vector<Blast::FEMElement3D<double>> elements;
                                            double scale_x = get_json_double(obj, "scale_x", get_json_double(obj, "scale_factor", 1.0));
                                            double scale_y = get_json_double(obj, "scale_y", get_json_double(obj, "scale_factor", 1.0));
                                            double scale_z = get_json_double(obj, "scale_z", get_json_double(obj, "scale_factor", 1.0));
                                            loadAndTransformLSDynaMesh<double>(k_file, pos_x, pos_y, pos_z, vel_x, vel_y, vel_z, scale_x, scale_y, scale_z, bc_cond, obj_mat, nodes, elements);
                                            fem->setNodesAndElements(nodes, elements, obj_mat);
                                        } else {
                                            fem->addStructuredBoxMesh(nx_fem, ny_fem, nz_fem, lx, ly, lz, pos_x, pos_y, pos_z, obj_mat, vel_x, vel_y, vel_z, bc_cond);
                                        }
                                    }
                                }
                                fem->setErosionCriteria(erosion);

                                auto coupler = std::make_unique<Blast::FEMFSICoupler3DCUDA<double>>();
                                coupler->attachSolvers(global_solver_3d.get(), fem.get());
                                global_fem_solvers_cuda_double[model_id] = std::move(fem);
                                global_fem_fsi_couplers_cuda_double[model_id] = std::move(coupler);
                            } else {
                                auto fem = std::make_unique<Blast::FEMSolver3DCUDA<float>>();
                                fem->setHourglassCoeff(static_cast<float>(get_json_double(msg, "hourglass_coeff", 0.1)));
                                fem->setContactPenaltyScale(static_cast<float>(get_json_double(msg, "contact_penalty_scale", 1.0)));
                                fem->setContactDamping(static_cast<float>(get_json_double(msg, "contact_damping", 0.20)));
                                fem->setFrictionCoefficients(static_cast<float>(get_json_double(msg, "friction_static", 0.3)), static_cast<float>(get_json_double(msg, "friction_kinetic", 0.2)));

                                std::string scheme_str = msg.value("integration_scheme", "OnePointFB");
                                if (scheme_str == "FullGauss8" || scheme_str == "FullIntegration8Pt") {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::FullGauss8);
                                } else if (scheme_str == "SelectiveReduced") {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::SelectiveReduced);
                                } else if (scheme_str == "OnePointKF") {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointKF);
                                } else {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointFB);
                                }

                                Blast::FEMErosionCriteria<float> erosion{};
                                erosion.failure_strain = static_cast<float>(get_json_double(msg, "failure_strain", 0.50));
                                erosion.timestep_erosion_factor = static_cast<float>(get_json_double(msg, "timestep_erosion_factor", 0.10));
                                erosion.min_volume_ratio = static_cast<float>(get_json_double(msg, "min_volume_ratio", 0.02));
                                erosion.tensile_failure_stress = static_cast<float>(get_json_double(msg, "tensile_failure_stress", 600.0e6));

                                if (msg.contains("fem_objects") && msg["fem_objects"].is_array() && !msg["fem_objects"].empty()) {
                                    for (const auto& obj : msg["fem_objects"]) {
                                        int nx_fem = get_json_int(obj, "nx", 10);
                                        int ny_fem = get_json_int(obj, "ny", 10);
                                        int nz_fem = get_json_int(obj, "nz", 10);
                                        float lx = static_cast<float>(get_json_double(obj, "size_x", 1.0));
                                        float ly = static_cast<float>(get_json_double(obj, "size_y", 1.0));
                                        float lz = static_cast<float>(get_json_double(obj, "size_z", 1.0));
                                        float pos_x = static_cast<float>(get_json_double(obj, "pos_x", 0.0));
                                        float pos_y = static_cast<float>(get_json_double(obj, "pos_y", 0.0));
                                        float pos_z = static_cast<float>(get_json_double(obj, "pos_z", 0.0));
                                        float vel_x = static_cast<float>(get_json_double(obj, "vel_x", 0.0));
                                        float vel_y = static_cast<float>(get_json_double(obj, "vel_y", 0.0));
                                        float vel_z = static_cast<float>(get_json_double(obj, "vel_z", 0.0));
                                        Blast::MaterialTable3D obj_mat = parseMaterialTable3D(obj);
                                        std::string k_file = obj.value("k_file", "");
                                        std::string mesh_src = obj.value("mesh_source", "Box Generator");
                                        std::string shape_type = obj.value("shape_type", "Box");
                                        std::string bc_cond = obj.value("boundary_condition", "Free");

                                        if (mesh_src == "Cylinder Generator" || shape_type == "Cylinder") {
                                            float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
                                            if (radius <= 0.0f) radius = static_cast<float>(get_json_double(obj, "size_x", 0.2) * 0.5);
                                            float inner_radius = static_cast<float>(get_json_double(obj, "inner_radius", 0.0));
                                            float height = static_cast<float>(get_json_double(obj, "height", 0.2));
                                            if (height <= 0.0f) height = static_cast<float>(get_json_double(obj, "size_z", 0.2));
                                            fem->addStructuredCylinderMesh(nx_fem, nz_fem, radius, height, pos_x, pos_y, pos_z, obj_mat, vel_x, vel_y, vel_z, inner_radius, bc_cond);
                                        } else if (mesh_src == "LS-DYNA Keyword File" || shape_type == "LS-DYNA File" || !k_file.empty()) {
                                            std::vector<Blast::FEMNode3D<float>> nodes;
                                            std::vector<Blast::FEMElement3D<float>> elements;
                                            float scale_x = static_cast<float>(get_json_double(obj, "scale_x", get_json_double(obj, "scale_factor", 1.0)));
                                            float scale_y = static_cast<float>(get_json_double(obj, "scale_y", get_json_double(obj, "scale_factor", 1.0)));
                                            float scale_z = static_cast<float>(get_json_double(obj, "scale_z", get_json_double(obj, "scale_factor", 1.0)));
                                            loadAndTransformLSDynaMesh<float>(k_file, pos_x, pos_y, pos_z, vel_x, vel_y, vel_z, scale_x, scale_y, scale_z, bc_cond, obj_mat, nodes, elements);
                                            fem->setNodesAndElements(nodes, elements, obj_mat);
                                        } else {
                                            fem->addStructuredBoxMesh(nx_fem, ny_fem, nz_fem, lx, ly, lz, pos_x, pos_y, pos_z, obj_mat, vel_x, vel_y, vel_z, bc_cond);
                                        }
                                    }
                                }
                                fem->setErosionCriteria(erosion);

                                auto coupler = std::make_unique<Blast::FEMFSICoupler3DCUDA<float>>();
                                coupler->attachSolvers(global_solver_3d.get(), fem.get());
                                global_fem_solvers_cuda_float[model_id] = std::move(fem);
                                global_fem_fsi_couplers_cuda_float[model_id] = std::move(coupler);
                            }
                        } else {
                            if (precision == "double") {
                                auto fem = std::make_unique<Blast::FEMSolver3D<double>>();
                                fem->setHourglassCoeff(static_cast<double>(get_json_double(msg, "hourglass_coeff", 0.1)));
                                fem->setContactPenaltyScale(static_cast<double>(get_json_double(msg, "contact_penalty_scale", 1.0)));
                                fem->setContactDamping(static_cast<double>(get_json_double(msg, "contact_damping", 0.20)));
                                fem->setFrictionCoefficients(static_cast<double>(get_json_double(msg, "friction_static", 0.3)), static_cast<double>(get_json_double(msg, "friction_kinetic", 0.2)));

                                Blast::FEMErosionCriteria<double> erosion{};
                                erosion.failure_strain = static_cast<double>(get_json_double(msg, "failure_strain", 0.50));
                                erosion.timestep_erosion_factor = static_cast<double>(get_json_double(msg, "timestep_erosion_factor", 0.10));
                                erosion.min_volume_ratio = static_cast<double>(get_json_double(msg, "min_volume_ratio", 0.02));
                                erosion.tensile_failure_stress = static_cast<double>(get_json_double(msg, "tensile_failure_stress", 600.0e6));

                                if (msg.contains("fem_objects") && msg["fem_objects"].is_array() && !msg["fem_objects"].empty()) {
                                    for (const auto& obj : msg["fem_objects"]) {
                                        int nx_fem = get_json_int(obj, "nx", 10);
                                        int ny_fem = get_json_int(obj, "ny", 10);
                                        int nz_fem = get_json_int(obj, "nz", 10);
                                        double lx = get_json_double(obj, "size_x", 1.0);
                                        double ly = get_json_double(obj, "size_y", 1.0);
                                        double lz = get_json_double(obj, "size_z", 1.0);
                                        double pos_x = get_json_double(obj, "pos_x", 0.0);
                                        double pos_y = get_json_double(obj, "pos_y", 0.0);
                                        double pos_z = get_json_double(obj, "pos_z", 0.0);
                                        double vel_x = get_json_double(obj, "vel_x", 0.0);
                                        double vel_y = get_json_double(obj, "vel_y", 0.0);
                                        double vel_z = get_json_double(obj, "vel_z", 0.0);
                                        Blast::MaterialTable3D obj_mat = parseMaterialTable3D(obj);
                                        std::string k_file = obj.value("k_file", "");
                                        std::string mesh_src = obj.value("mesh_source", "Box Generator");
                                        std::string shape_type = obj.value("shape_type", "Box");
                                        std::string bc_cond = obj.value("boundary_condition", "Free");

                                        if (mesh_src == "Cylinder Generator" || shape_type == "Cylinder") {
                                            double radius = get_json_double(obj, "radius", 0.1);
                                            if (radius <= 0.0) radius = get_json_double(obj, "size_x", 0.2) * 0.5;
                                            double inner_radius = get_json_double(obj, "inner_radius", 0.0);
                                            double height = get_json_double(obj, "height", 0.2);
                                            if (height <= 0.0) height = get_json_double(obj, "size_z", 0.2);
                                            fem->addStructuredCylinderMesh(nx_fem, nz_fem, radius, height, pos_x, pos_y, pos_z, obj_mat, vel_x, vel_y, vel_z, inner_radius, bc_cond);
                                        } else if (mesh_src == "LS-DYNA Keyword File" || shape_type == "LS-DYNA File" || !k_file.empty()) {
                                            std::vector<Blast::FEMNode3D<double>> nodes;
                                            std::vector<Blast::FEMElement3D<double>> elements;
                                            double scale_x = get_json_double(obj, "scale_x", get_json_double(obj, "scale_factor", 1.0));
                                            double scale_y = get_json_double(obj, "scale_y", get_json_double(obj, "scale_factor", 1.0));
                                            double scale_z = get_json_double(obj, "scale_z", get_json_double(obj, "scale_factor", 1.0));
                                            loadAndTransformLSDynaMesh<double>(k_file, pos_x, pos_y, pos_z, vel_x, vel_y, vel_z, scale_x, scale_y, scale_z, bc_cond, obj_mat, nodes, elements);
                                            fem->setNodesAndElements(nodes, elements, obj_mat);
                                        } else {
                                            fem->addStructuredBoxMesh(nx_fem, ny_fem, nz_fem, lx, ly, lz, pos_x, pos_y, pos_z, obj_mat, vel_x, vel_y, vel_z, bc_cond);
                                        }
                                    }
                                }
                                fem->setErosionCriteria(erosion);

                                auto coupler = std::make_unique<Blast::FEMFSICoupler3D<double>>();
                                coupler->attachSolvers(global_solver_3d.get(), fem.get());
                                global_fem_solvers_double[model_id] = std::move(fem);
                                global_fem_fsi_couplers_double[model_id] = std::move(coupler);
                            } else {
                                auto fem = std::make_unique<Blast::FEMSolver3D<float>>();
                                fem->setHourglassCoeff(static_cast<float>(get_json_double(msg, "hourglass_coeff", 0.1)));
                                fem->setContactPenaltyScale(static_cast<float>(get_json_double(msg, "contact_penalty_scale", 1.0)));
                                fem->setContactDamping(static_cast<float>(get_json_double(msg, "contact_damping", 0.20)));
                                fem->setFrictionCoefficients(static_cast<float>(get_json_double(msg, "friction_static", 0.3)), static_cast<float>(get_json_double(msg, "friction_kinetic", 0.2)));

                                Blast::FEMErosionCriteria<float> erosion{};
                                erosion.failure_strain = static_cast<float>(get_json_double(msg, "failure_strain", 0.50));
                                erosion.timestep_erosion_factor = static_cast<float>(get_json_double(msg, "timestep_erosion_factor", 0.10));
                                erosion.min_volume_ratio = static_cast<float>(get_json_double(msg, "min_volume_ratio", 0.02));
                                erosion.tensile_failure_stress = static_cast<float>(get_json_double(msg, "tensile_failure_stress", 600.0e6));

                                if (msg.contains("fem_objects") && msg["fem_objects"].is_array() && !msg["fem_objects"].empty()) {
                                    for (const auto& obj : msg["fem_objects"]) {
                                        int nx_fem = get_json_int(obj, "nx", 10);
                                        int ny_fem = get_json_int(obj, "ny", 10);
                                        int nz_fem = get_json_int(obj, "nz", 10);
                                        float lx = static_cast<float>(get_json_double(obj, "size_x", 1.0));
                                        float ly = static_cast<float>(get_json_double(obj, "size_y", 1.0));
                                        float lz = static_cast<float>(get_json_double(obj, "size_z", 1.0));
                                        float pos_x = static_cast<float>(get_json_double(obj, "pos_x", 0.0));
                                        float pos_y = static_cast<float>(get_json_double(obj, "pos_y", 0.0));
                                        float pos_z = static_cast<float>(get_json_double(obj, "pos_z", 0.0));
                                        float vel_x = static_cast<float>(get_json_double(obj, "vel_x", 0.0));
                                        float vel_y = static_cast<float>(get_json_double(obj, "vel_y", 0.0));
                                        float vel_z = static_cast<float>(get_json_double(obj, "vel_z", 0.0));
                                        Blast::MaterialTable3D obj_mat = parseMaterialTable3D(obj);
                                        std::string k_file = obj.value("k_file", "");
                                        std::string mesh_src = obj.value("mesh_source", "Box Generator");
                                        std::string shape_type = obj.value("shape_type", "Box");
                                        std::string bc_cond = obj.value("boundary_condition", "Free");

                                        if (mesh_src == "Cylinder Generator" || shape_type == "Cylinder") {
                                            float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
                                            if (radius <= 0.0f) radius = static_cast<float>(get_json_double(obj, "size_x", 0.2) * 0.5);
                                            float inner_radius = static_cast<float>(get_json_double(obj, "inner_radius", 0.0));
                                            float height = static_cast<float>(get_json_double(obj, "height", 0.2));
                                            if (height <= 0.0f) height = static_cast<float>(get_json_double(obj, "size_z", 0.2));
                                            fem->addStructuredCylinderMesh(nx_fem, nz_fem, radius, height, pos_x, pos_y, pos_z, obj_mat, vel_x, vel_y, vel_z, inner_radius, bc_cond);
                                        } else if (mesh_src == "LS-DYNA Keyword File" || shape_type == "LS-DYNA File" || !k_file.empty()) {
                                            std::vector<Blast::FEMNode3D<float>> nodes;
                                            std::vector<Blast::FEMElement3D<float>> elements;
                                            float scale_x = static_cast<float>(get_json_double(obj, "scale_x", get_json_double(obj, "scale_factor", 1.0)));
                                            float scale_y = static_cast<float>(get_json_double(obj, "scale_y", get_json_double(obj, "scale_factor", 1.0)));
                                            float scale_z = static_cast<float>(get_json_double(obj, "scale_z", get_json_double(obj, "scale_factor", 1.0)));
                                            loadAndTransformLSDynaMesh<float>(k_file, pos_x, pos_y, pos_z, vel_x, vel_y, vel_z, scale_x, scale_y, scale_z, bc_cond, obj_mat, nodes, elements);
                                            fem->setNodesAndElements(nodes, elements, obj_mat);
                                        } else {
                                            fem->addStructuredBoxMesh(nx_fem, ny_fem, nz_fem, lx, ly, lz, pos_x, pos_y, pos_z, obj_mat, vel_x, vel_y, vel_z, bc_cond);
                                        }
                                    }
                                }
                                fem->setErosionCriteria(erosion);

                                auto coupler = std::make_unique<Blast::FEMFSICoupler3D<float>>();
                                coupler->attachSolvers(global_solver_3d.get(), fem.get());
                                global_fem_solvers_float[model_id] = std::move(fem);
                                global_fem_fsi_couplers_float[model_id] = std::move(coupler);
                            }
                        }

                        emit_kernel_log("SYSTEM", "3D Coupled FV-FEM Solver Initialized", 0.0, "3d");
                        emit_telemetry_3d(0.0, false);

                        nlohmann::json prog_report;
                        prog_report["type"] = "progress";
                        prog_report["percent"] = 100;
                        prog_report["scope"] = "3d";
                        prog_report["mode"] = "INIT_FEM_FSI_3D";
                        {
                            std::lock_guard<std::mutex> lock(cout_mutex);
                            std::cout << prog_report.dump() << std::endl;
                        }
                    } catch (const std::exception& e) {
                        std::cerr << "[ERROR] Exception in INIT_FEM_FSI_3D: " << e.what() << std::endl;
                        emit_kernel_log("ERROR", std::string("FEM-FSI 3D initialization failed: ") + e.what(), 0.0, "3d");
                        std::exit(1);
                    } catch (...) {
                        std::cerr << "[ERROR] Unknown exception in INIT_FEM_FSI_3D" << std::endl;
                        emit_kernel_log("ERROR", "FEM-FSI 3D initialization failed with unknown error", 0.0, "3d");
                        std::exit(1);
                    }
                } else if (command == "STEP_FEM_FSI_3D") {
                    int steps = get_json_int(msg, "steps", 1);
                    global_cfl_fem_fsi_3d = static_cast<float>(get_json_double(msg, "cfl", 0.30));
                    global_exec_until_end_fem_fsi_3d = false;
                    if (!sim_fem_fsi_3d_running) {
                        global_target_steps_fem_fsi_3d = steps;
                        sim_fem_fsi_3d_running = true;
                        sim_fem_fsi_3d_paused = false;
                        sim_fem_fsi_3d_terminate = false;
                        std::thread(worker_fem_fsi_3d_thread_func).detach();
                    } else {
                        global_target_steps_fem_fsi_3d.fetch_add(steps);
                        sim_fem_fsi_3d_paused = false;
                    }
                } else if (command == "EXEC_ALL_FEM_FSI_3D") {
                    global_cfl_fem_fsi_3d = static_cast<float>(get_json_double(msg, "cfl", 0.30));
                    global_exec_until_end_fem_fsi_3d = true;
                    if (!sim_fem_fsi_3d_running) {
                        sim_fem_fsi_3d_running = true;
                        sim_fem_fsi_3d_paused = false;
                        sim_fem_fsi_3d_terminate = false;
                        std::thread(worker_fem_fsi_3d_thread_func).detach();
                    } else {
                        sim_fem_fsi_3d_paused = false;
                    }
                } else if (command == "PAUSE_FEM_FSI_3D") {
                    sim_fem_fsi_3d_paused = true;
                    global_target_steps_fem_fsi_3d = 0;
                } else if (command == "TERMINATE_FEM_FSI_3D") {
                    sim_fem_fsi_3d_terminate = true;
                    while (sim_fem_fsi_3d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_3d.reset();
                    global_fem_solvers_float.clear();
                    global_fem_solvers_double.clear();
                    global_fem_solvers_cuda_float.clear();
                    global_fem_solvers_cuda_double.clear();
                    global_fem_fsi_couplers_float.clear();
                    global_fem_fsi_couplers_double.clear();
                    global_fem_fsi_couplers_cuda_float.clear();
                    global_fem_fsi_couplers_cuda_double.clear();
                } else if (command == "REMAP") {
                    if (sim3d_init_in_progress.load()) {
                        std::lock_guard<std::mutex> lock(g_pending_remap_mutex);
                        g_pending_remap.has_pending = true;
                        g_pending_remap.type = "1D";
                        g_pending_remap.msg = msg;
                        emit_kernel_log("REMAP", "Received 1D remap payload during 3D initialization. Queued for completion.", 0.0, "3d");
                    } else if (global_solver_3d) {
                        apply_remap_payload(msg, "1D", global_solver_3d.get(), nullptr, nullptr);
                    } else if (global_solver_2d) {
                        apply_remap_payload(msg, "1D", nullptr, global_solver_2d.get(), nullptr);
                    } else if (global_solver_2d_cuda) {
                        apply_remap_payload(msg, "1D", nullptr, nullptr, global_solver_2d_cuda.get());
                    } else {
                        std::lock_guard<std::mutex> lock(g_pending_remap_mutex);
                        g_pending_remap.has_pending = true;
                        g_pending_remap.type = "1D";
                        g_pending_remap.msg = msg;
                        emit_kernel_log("REMAP", "Received 1D remap payload before solver creation. Queued for completion.", 0.0, "3d");
                    }
                } else if (command == "REMAP_2D") {
                    if (sim3d_init_in_progress.load()) {
                        std::lock_guard<std::mutex> lock(g_pending_remap_mutex);
                        g_pending_remap.has_pending = true;
                        g_pending_remap.type = "2D";
                        g_pending_remap.msg = msg;
                        emit_kernel_log("REMAP_2D", "Received 2D remap payload during 3D initialization. Queued for completion.", 0.0, "3d");
                    } else if (global_solver_3d) {
                        apply_remap_payload(msg, "2D", global_solver_3d.get(), nullptr, nullptr);
                    } else {
                        std::lock_guard<std::mutex> lock(g_pending_remap_mutex);
                        g_pending_remap.has_pending = true;
                        g_pending_remap.type = "2D";
                        g_pending_remap.msg = msg;
                        emit_kernel_log("REMAP_2D", "Received 2D remap payload before solver creation. Queued for completion.", 0.0, "3d");
                    }
                } else if (command == "STEP_3D") {
                    if (sim3d_init_in_progress.load()) {
                        emit_kernel_log("WARNING", "Cannot step simulation: 3D initialization is in progress.", 0.0, "3d");
                        continue;
                    }
                    if (!global_solver_3d) continue;
                    int steps = msg.at("steps").get<int>();
                    global_cfl_3d = msg.value("cfl", 0.4);
                    global_exec_until_end_3d = false;
                    if (!sim3d_running) {
                        global_target_steps_3d = steps;
                        sim3d_running = true;
                        sim3d_paused = false;
                        sim3d_terminate = false;
                        std::thread(worker_3d_thread_func).detach();
                    } else {
                        global_target_steps_3d.fetch_add(steps);
                        sim3d_paused = false;
                    }
                } else if (command == "EXEC_ALL_3D") {
                    if (sim3d_init_in_progress.load()) {
                        emit_kernel_log("WARNING", "Cannot run simulation: 3D initialization is in progress.", 0.0, "3d");
                        continue;
                    }
                    if (!global_solver_3d) continue;
                    global_cfl_3d = msg.value("cfl", 0.4);
                    global_exec_until_end_3d = true;
                    if (!sim3d_running) {
                        sim3d_running = true;
                        sim3d_paused = false;
                        sim3d_terminate = false;
                        std::thread(worker_3d_thread_func).detach();
                    } else { sim3d_paused = false; }
                } else if (command == "PAUSE_3D") {
                    sim3d_paused = true;
                    global_target_steps_3d = 0;
                } else if (command == "RESUME_3D") {
                    sim3d_paused = false;
                } else if (command == "TERMINATE_3D") {
                    sim3d_terminate = true;
                    while (sim3d_running.load() || sim3d_init_in_progress.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_3d.reset();
                    global_t3d = 0.0;
                    global_wallclock_3d = 0.0;
                    step_progress_3d = 0;
                } else if (command == "INIT_3D") {
                    sim3d_terminate = true;
                    while (sim3d_running.load() || sim3d_init_in_progress.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_3d.reset();
                    sim3d_terminate = false;
                    sim3d_paused = false;
                    sim3d_init_in_progress = true;
                    global_step_3d = 0;
                    global_t3d = 0.0;
                    global_wallclock_3d = 0.0;

                    global_slices_3d.clear();
                    if (msg.contains("slices")) {
                        for (const auto& s_msg : msg["slices"]) {
                            Slice3D s;
                            s.axis = s_msg.value("axis", "xy");
                            s.offset = s_msg.value("offset", 0.5);
                            s.stride = s_msg.value("stride", 1);
                            s.enabled = s_msg.value("enabled", true);
                            if (s.stride < 1) s.stride = 1;
                            if (s_msg.contains("quantities")) {
                                    for (const auto& q : s_msg["quantities"]) {
                                        s.quantities.push_back(q.get<std::string>());
                                    }
                            }
                            global_slices_3d.push_back(s);
                        }
                    } else {
                        // Create default XY slice only if "slices" array is completely absent
                        Slice3D s;
                        s.axis = "xy";
                        s.offset = 0.5;
                        s.stride = 1;
                        s.enabled = true;
                        s.quantities.push_back("pressure");
                        global_slices_3d.push_back(s);
                    }

                    // Start the asynchronous initialization thread
                    std::thread(init_3d_thread_func, msg).detach();

                } else if (command == "UPDATE_CFL") {
                    double cfl = msg.value("cfl", 0.4);
                    global_cfl = cfl;
                    global_cfl_2d = cfl;
                    global_cfl_3d = cfl;
                    global_cfl_mpm = static_cast<float>(cfl);
                    global_cfl_mpm_3d = static_cast<float>(cfl);
                    global_cfl_fsi = static_cast<float>(cfl);
                    std::string scope = msg.value("scope", "3d");
                    emit_kernel_log("SYSTEM", "CFL updated to " + std::to_string(cfl), 0.0, scope);

                } else if (command == "CONTOUR_CONFIG" || command == "VIEW3D_CONFIG") {
                    global_telemetry_stride = msg.value("stride", 1);
                    double rate = msg.value("refresh_rate", 0.0);
                    global_telemetry_interval_ms = (rate > 0.0) ? static_cast<int>(rate * 1000.0) : 0;
                    global_refresh_rate_mpm = rate;
                    global_refresh_rate_mpm_3d = rate;
                    global_refresh_rate_fem_3d = rate;
                    if (msg.contains("slices")) {
                        global_slices_3d.clear();
                        for (const auto& s_msg : msg["slices"]) {
                            Slice3D s;
                            s.axis = s_msg.value("axis", "xy");
                            s.offset = s_msg.value("offset", 0.5);
                            s.stride = s_msg.value("stride", 1);
                            s.enabled = s_msg.value("enabled", true);
                            if (s.stride < 1) s.stride = 1;
                            if (s_msg.contains("quantities")) {
                                for (const auto& q : s_msg["quantities"]) {
                                    s.quantities.push_back(q.get<std::string>());
                                }
                            }
                            global_slices_3d.push_back(s);
                        }
                    } else if (command == "VIEW3D_CONFIG") {
                        bool show_stl = msg.value("show_stl", true);
                        bool stl_show_results = msg.value("stl_show_results", true);
                        std::string stl_qty = msg.value("stl_quantity", "pressure");

                        if (show_stl && stl_show_results) {
                            Slice3D vol_slice;
                            vol_slice.axis = "volume";
                            vol_slice.offset = 0.5;
                            vol_slice.stride = msg.value("stride", 1);
                            if (vol_slice.stride < 1) vol_slice.stride = 1;
                            vol_slice.enabled = true;
                            vol_slice.quantities.push_back(stl_qty);
                            global_slices_3d.push_back(vol_slice);
                        }
                    }
                    if (command == "CONTOUR_CONFIG") {
                        if (has_solver_2d()) {
                            emit_telemetry_2d(global_t2d, false);
                        }
                    } else if (command == "VIEW3D_CONFIG") {
                        if (global_solver_3d) {
                            emit_telemetry_3d(global_t3d, false);
                        } else if (global_solver_mpm_3d) {
                            emit_telemetry_mpm_3d(global_solver_mpm_3d->getSimTime(), false);
                        } else if (!global_fem_solvers_cuda_float.empty() || !global_fem_solvers_cuda_double.empty() || !global_fem_solvers_float.empty() || !global_fem_solvers_double.empty()) {
                            emit_telemetry_fem_3d(0.0, false);
                        }
                    }
                } else if (command == "WRITE_VTK") {
                    write_vtk_outputs(0, 0.0);
                }

            } catch (const std::exception& e) {
                std::lock_guard<std::mutex> lock(cout_mutex);
                std::cout << "[ERROR] JSON/Binding Error: " << e.what() << std::endl;
            }
        }
    });
    stdin_listener_thread.join();
    while (sim_running.load() || sim2d_running.load() || sim3d_running.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }

    global_pulse_cancel.store(true);
    if (pulse_thread.joinable()) {
        pulse_thread.join();
    }

    {
        std::lock_guard<std::mutex> lock(global_async_telemetry.mutex);
        global_async_telemetry.exit_flag = true;
        global_async_telemetry.cv.notify_all();
    }
    if (telemetry_thread.joinable()) {
        telemetry_thread.join();
    }

    global_solver.reset();
    global_solver_2d.reset();
    global_solver_2d_cuda.reset();
    global_solver_3d.reset();

    return 0;
}
