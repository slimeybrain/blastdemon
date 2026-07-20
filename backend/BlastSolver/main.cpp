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

std::string get_absolute_path(const std::string& path, const std::string& base_dir) {
    if (path.empty()) return base_dir;
    if (path[0] == '/') return path; // Already absolute
    return base_dir + "/" + path;
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

void emit_telemetry(const CFDSolver& solver, double elapsed, bool is_terminated = false);
void emit_telemetry_2d(double elapsed, bool is_terminated = false);
void emit_telemetry_3d(double elapsed, bool is_terminated = false);
void emit_resource_pulse();

void emit_kernel_log(const std::string& level, const std::string& msg, double t, const std::string& scope = "1d") {
    std::lock_guard<std::mutex> lock(cout_mutex);
    nlohmann::json log;
    log["type"] = "log";
    log["level"] = level;
    log["message"] = msg;
    log["time"] = t;
    log["scope"] = scope;
    std::cout << log.dump() << std::endl;
}

bool has_solver_2d() {
    return global_solver_2d != nullptr || global_solver_2d_cuda != nullptr;
}

void worker_thread_func() {
    if (!global_solver) {
        sim_running = false;
        return;
    }

    auto last_telemetry_time = std::chrono::steady_clock::now();
    int initial_steps = global_target_steps.load();
    int initial_idx = global_solver->getActiveIndex();
    int total_range = global_solver->getNumCells() - initial_idx;

    int step_count = 0;
    double last_vtk_time = global_t;

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
        global_dt_1d = dt;
        global_solver->step(dt);
        auto step_end = std::chrono::steady_clock::now();
        global_wallclock_1d = global_wallclock_1d.load() + std::chrono::duration<double>(step_end - step_start).count();
        global_t += dt;
        
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
            emit_telemetry(*global_solver, global_t, false);
            last_telemetry_time = now;

            nlohmann::json progress_msg;
            progress_msg["type"] = "progress";
            progress_msg["sim_time"] = global_t;
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
    emit_telemetry(*global_solver, global_t, term);
    
    // Emit final 100% progress packet to transition frontend state to paused/complete
    nlohmann::json progress_msg;
    progress_msg["type"] = "progress";
    progress_msg["sim_time"] = global_t;
    progress_msg["scope"] = "1d";
    progress_msg["percent"] = 100;
    progress_msg["mode"] = global_exec_until_end.load() ? "EXEC_ALL" : "STEP";
    {
        std::lock_guard<std::mutex> lock(cout_mutex);
        std::cout << progress_msg.dump() << std::endl;
    }
    
    step_progress = 100;
    emit_kernel_log("INFO", "Worker thread execution cycle ended.", global_t, "1d");
    write_gauge_files();
    write_vtk_outputs(step_count, global_t);
    sim_running = false;
    sim_paused = false;
    sim_terminate = false;
    global_target_steps = 0;
    global_exec_until_end = false;
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
    if (global_obstacle_faces.empty()) return;

    // If the mesh is too large, do not send the full vertices/cells lists to the frontend
    // to prevent memory exhaustion (OOM), WebSocket pipeline blocking, and browser crashes.
    if (global_obstacle_faces.size() > 100000) {
        std::cout << "[INFO] Obstacle mesh is too large (" << global_obstacle_faces.size()
                  << " faces). Skipping transmission to frontend to preserve memory and performance." << std::endl;
        nlohmann::json msg;
        msg["type"] = "obstacles_mesh";
        msg["modelId"] = modelId;
        msg["vertices"] = nlohmann::json::array();
        msg["cells"] = nlohmann::json::array();
        std::cout << msg.dump() << std::endl;
        return;
    }

    std::stringstream ss;
    ss << std::fixed << std::setprecision(5);
    ss << "{\"type\":\"obstacles_mesh\",\"modelId\":\"" << modelId << "\",\"vertices\":[";

    for (size_t f = 0; f < global_obstacle_faces.size(); ++f) {
        const auto& face = global_obstacle_faces[f];
        if (f > 0) ss << ",";
        ss << face.px[0] << "," << face.py[0] << "," << face.pz[0] << ","
           << face.px[1] << "," << face.py[1] << "," << face.pz[1] << ","
           << face.px[2] << "," << face.py[2] << "," << face.pz[2] << ","
           << face.px[3] << "," << face.py[3] << "," << face.pz[3];
    }

    ss << "],\"cells\":[";

    for (size_t f = 0; f < global_obstacle_faces.size(); ++f) {
        const auto& face = global_obstacle_faces[f];
        if (f > 0) ss << ",";
        ss << face.gx_fluid << "," << face.gy_fluid << "," << face.gz_fluid;
    }

    ss << "]}";

    std::cout << ss.str() << std::endl;
}

void init_3d_thread_func(nlohmann::json msg) {
    sim3d_init_in_progress = true;
    try {
        int nx = msg.value("nx", 64);
        int ny = msg.value("ny", 64);
        int nz = msg.value("nz", 64);
        double cellSize = msg.value("cell_size", 0.01);
        double xmin = msg.value("xmin", 0.0);
        double ymin = msg.value("ymin", 0.0);
        double zmin = msg.value("zmin", 0.0);
        std::string device = msg.value("device", "cpu");

        std::string init_mode = msg.value("init_mode", "Multi-Material JWL");
        bool is_multimat = (init_mode == "Multi-Material JWL");

        std::unique_ptr<CFDSolver3D> local_solver_3d = nullptr;
        std::string precision = msg.value("precision", "single");
        if (device == "cuda") {
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
        int temporal_order = msg.value("temporal_order", 2);

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
        cp.height = msg.value("charge_height", 0.1);
        cp.lx = msg.value("charge_lx", 0.1);
        cp.ly = msg.value("charge_ly", 0.1);
        cp.lz = msg.value("charge_lz", 0.1);

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

        std::cout << "[DEBUG] Obstacle faces uploaded. Committing solver..." << std::endl;
        // Commit to global solver
        global_solver_3d = std::move(local_solver_3d);

        std::cout << "[DEBUG] Solver committed. Sending mesh to frontend..." << std::endl;
        // Broadcast obstacle mesh JSON to frontend
        sendObstacleMeshToFrontend(msg.value("modelId", ""));

        std::cout << "[DEBUG] Mesh sent. Initializing gauges..." << std::endl;
        init_gauges(msg);
        emit_kernel_log("SYSTEM", "3D Solver Initialized", 0.0, "3d");
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
    emit_kernel_log("INFO", "3D worker thread started.", global_t3d, "3d");

    if (!global_solver_3d) {
        emit_kernel_log("ERROR", "3D worker: no solver available.", 0.0, "3d");
        sim3d_running = false;
        return;
    }

    auto last_telemetry_time = std::chrono::steady_clock::now();
    int initial_steps = global_target_steps_3d.load();
    int step_count = 0;
    double last_vtk_time = global_t3d;

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
        global_solver_3d->step(dt);
        auto step_end = std::chrono::steady_clock::now();
        global_wallclock_3d = global_wallclock_3d.load() + std::chrono::duration<double>(step_end - step_start).count();
        global_dt_3d = dt;
        global_t3d += dt;

        step_count++;

        record_gauges_3d(global_t3d);

        {
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

        auto now = std::chrono::steady_clock::now();
        auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
        if (elapsed_ms >= global_telemetry_interval_ms.load()) {
            emit_telemetry_3d(global_t3d, false);
            last_telemetry_time = now;

            nlohmann::json progress_msg;
            progress_msg["type"] = "progress";
            progress_msg["sim_time"] = global_t3d;
            progress_msg["scope"] = "3d";
            progress_msg["dt"] = global_dt_3d;

            if (global_exec_until_end_3d.load()) {
                progress_msg["percent"] = 50;
                progress_msg["mode"] = "EXEC_ALL_3D";
            } else {
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

    emit_telemetry_3d(global_t3d, global_solver_3d->is_terminated());

    nlohmann::json progress_msg;
    progress_msg["type"] = "progress";
    progress_msg["sim_time"] = global_t3d;
    progress_msg["scope"] = "3d";
    progress_msg["percent"] = 100;
    progress_msg["mode"] = global_exec_until_end_3d.load() ? "EXEC_ALL_3D" : "STEP_3D";
    {
        std::lock_guard<std::mutex> lock(cout_mutex);
        std::cout << progress_msg.dump() << std::endl;
    }

    step_progress_3d = 100;
    emit_kernel_log("INFO", "3D worker thread execution cycle ended.", global_t3d, "3d");

    write_gauge_files();
    write_vtk_outputs(step_count, global_t3d);

    sim3d_running = false;
    sim3d_paused = false;
    sim3d_terminate = false;
    global_target_steps_3d = 0;
    global_exec_until_end_3d = false;
}

void worker_2d_thread_func() {
    emit_kernel_log("INFO", "2D worker thread started.", global_t2d, "2d");

    if (!has_solver_2d()) {
        emit_kernel_log("ERROR", "2D worker: no solver available.", 0.0, "2d");
        sim2d_running = false;
        return;
    }

    auto last_telemetry_time = std::chrono::steady_clock::now();
    int initial_steps = global_target_steps_2d.load();
    int step_count = 0;
    double last_vtk_time = global_t2d;

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
                dt = global_solver_2d_cuda->getMaxWaveSpeed();
                dt = dt * (global_cfl_2d.load() / 0.35);
            } else {
                double max_s = global_solver_2d_cuda->getMaxWaveSpeed();
                dt = global_cfl_2d.load() * std::min(global_solver_2d_cuda->getDr(), global_solver_2d_cuda->getDz()) / max_s;
            }
            global_solver_2d_cuda->step(dt);
        } else if (global_solver_2d) {
            dt = global_solver_2d->computeStepSize(global_cfl_2d.load());
            global_solver_2d->step(dt);
        }
        auto step_end = std::chrono::steady_clock::now();
        global_wallclock_2d = global_wallclock_2d.load() + std::chrono::duration<double>(step_end - step_start).count();
        global_dt_2d = dt;
        global_t2d += dt;

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
        if (elapsed_ms >= global_telemetry_interval_ms.load()) {
            emit_telemetry_2d(global_t2d, false);
            last_telemetry_time = now;

            nlohmann::json progress_msg;
            progress_msg["type"] = "progress";
            progress_msg["sim_time"] = global_t2d;
            progress_msg["scope"] = "2d";
            progress_msg["dt"] = global_dt_2d;

            if (global_exec_until_end_2d.load()) {
                progress_msg["percent"] = 50; // Indeterminate
                progress_msg["mode"] = "EXEC_ALL_2D";
            } else {
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

    emit_telemetry_2d(global_t2d, false);
    
    // Emit final 100% progress packet to transition frontend state to paused/complete
    nlohmann::json progress_msg;
    progress_msg["type"] = "progress";
    progress_msg["sim_time"] = global_t2d;
    progress_msg["scope"] = "2d";
    progress_msg["percent"] = 100;
    progress_msg["mode"] = global_exec_until_end_2d.load() ? "EXEC_ALL_2D" : "STEP_2D";
    {
        std::lock_guard<std::mutex> lock(cout_mutex);
        std::cout << progress_msg.dump() << std::endl;
    }
    
    step_progress_2d = 100;
    emit_kernel_log("INFO", "2D worker thread execution cycle ended.", global_t2d, "2d");
    write_gauge_files();
    write_vtk_outputs(step_count, global_t2d);
    sim2d_running = false;
    sim2d_paused = false;
    sim2d_terminate = false;
    global_target_steps_2d = 0;
    global_exec_until_end_2d = false;
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
    static CPUMonitor cpu_monitor;
    static GPUMonitor gpu_monitor;
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
    bool nvml_ok = gpu_monitor.get_metrics(gpu_util, gpu_temp);
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
    
    size_t blastdemon_vram = 0;
    unsigned long long nvml_vram = 0;
    if (gpu_monitor.get_process_vram(getpid(), nvml_vram)) {
        blastdemon_vram = nvml_vram;
    } else {
        if (global_solver_2d_cuda != nullptr) {
            blastdemon_vram = global_solver_2d_cuda->getAllocatedVRAM();
        } else if (global_solver_3d != nullptr) {
            blastdemon_vram = global_solver_3d->getAllocatedVRAM();
        }
    }
    pulse["vram_blastdaemon"] = blastdemon_vram;
    pulse["gpu_temp"] = gpu_temp;

    std::cout << pulse.dump() << std::endl;
}

struct TelemetryPayload {
    enum Type { TYPE_1D, TYPE_2D, TYPE_3D, TYPE_2D_AMR } type;
    double elapsed;
    bool is_terminated;
    double wallclock;
    
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
    };
    std::vector<SlicePayload> slices;
    double xmin = 0.0, ymin = 0.0, zmin = 0.0, dx = 0.0;
    int nx = 0, ny = 0, nz = 0;
    double total_mass = 0.0;
    double total_energy = 0.0;

    // Shared grid/frame data
    std::vector<float> grid_data;
    
    // Gauges
    bool has_gauges = false;
    std::vector<double> gauge_times;
    std::vector<GaugeHistory> gauges_history;
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
            envelope["dt"] = payload->dt;
            envelope["is_terminated"] = payload->is_terminated;
            envelope["wallclock"] = payload->wallclock;
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
            envelope["dt"] = payload->dt;
            envelope["is_terminated"] = payload->is_terminated;
            envelope["nr"] = payload->out_nr;
            envelope["nz"] = payload->out_nz;
            envelope["wallclock"] = payload->wallclock;
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
            envelope["dt"] = payload->dt;
            envelope["is_terminated"] = payload->is_terminated;
            envelope["wallclock"] = payload->wallclock;
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
            size_t slice_header_bytes = n_slices * 16; // (axis, offset, w, h) per slice
            size_t total_bytes = header_bytes + slice_header_bytes + total_payload_bytes;

            std::cout << "BIN_FRAME_3D_SLICES " << total_bytes << "\n";
            std::cout.write(reinterpret_cast<const char*>(&magic), 4);
            std::cout.write(reinterpret_cast<const char*>(&time_f), 4);
            std::cout.write(reinterpret_cast<const char*>(&n_slices), 4);

            for (size_t i = 0; i < n_slices; ++i) {
                const auto& s = payload->slices[i];
                uint32_t axis_id = (s.axis == "xy" ? 0 : (s.axis == "xz" ? 1 : (s.axis == "yz" ? 2 : 3)));
                float offset = (float)s.offset;
                uint32_t w = s.w;
                uint32_t h = s.h;

                std::cout.write(reinterpret_cast<const char*>(&axis_id), 4);
                std::cout.write(reinterpret_cast<const char*>(&offset), 4);
                std::cout.write(reinterpret_cast<const char*>(&w), 4);
                std::cout.write(reinterpret_cast<const char*>(&h), 4);
                std::cout.write(reinterpret_cast<const char*>(s.data.data()), s.data.size() * sizeof(float));
            }
            std::cout.flush();
        }
    }
}


void emit_telemetry(const CFDSolver& solver, double elapsed, bool is_terminated) {
    auto payload = std::make_unique<TelemetryPayload>();
    payload->type = TelemetryPayload::TYPE_1D;
    payload->elapsed = elapsed;
    payload->dt = global_dt_1d;
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

void emit_telemetry_2d(double elapsed, bool is_terminated) {
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
    payload->is_terminated = is_terminated;
    payload->out_nr = out_nr;
    payload->out_nz = out_nz;
    payload->wallclock = global_wallclock_2d.load();
    payload->grid_data = std::move(downsampled);

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

void emit_telemetry_3d(double elapsed, bool is_terminated) {
    if (!global_solver_3d) return;

    auto payload = std::make_unique<TelemetryPayload>();
    payload->type = TelemetryPayload::TYPE_3D;
    payload->elapsed = elapsed;
    payload->dt = global_dt_3d;
    payload->is_terminated = is_terminated;
    payload->wallclock = global_wallclock_3d.load();
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

    uint32_t n_slices = global_slices_3d.size();
    payload->slices.reserve(n_slices);

    for (const auto& s : global_slices_3d) {
        TelemetryPayload::SlicePayload sp;
        sp.axis = s.axis;
        sp.offset = s.offset;
        sp.stride = s.stride;
        sp.data = global_solver_3d->extractSlice(s);

        uint32_t axis_id = (s.axis == "xy" ? 0 : (s.axis == "xz" ? 1 : (s.axis == "yz" ? 2 : 3)));
        int stride = s.stride > 0 ? s.stride : 1;
        if (axis_id == 0) {
            sp.w = (global_solver_3d->getNx() + stride - 1) / stride;
            sp.h = (global_solver_3d->getNy() + stride - 1) / stride;
        } else if (axis_id == 1) {
            sp.w = (global_solver_3d->getNx() + stride - 1) / stride;
            sp.h = (global_solver_3d->getNz() + stride - 1) / stride;
        } else if (axis_id == 2) {
            sp.w = (global_solver_3d->getNy() + stride - 1) / stride;
            sp.h = (global_solver_3d->getNz() + stride - 1) / stride;
        } else {
            sp.w = sp.data.size();
            sp.h = 1;
        }
        payload->slices.push_back(std::move(sp));
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
        matSet.products  = { jwl_A, jwl_B, jwl_R1, jwl_R2, jwl_omega, high_rho, 1000.0, 300.0 };

        // Estimate unreacted solid parameters to keep initial state physically correct and stable
        // A typical stable unreacted JWL has:
        // A_u ~ 770 GPa, B_u ~ -4.8 GPa, R1_u ~ 10.5, R2_u ~ 1.1, omega_u ~ 0.89
        // Scaling with density allows handling low/high density custom mixtures/presets correctly.
        double unreacted_A = 770.0e9 * (high_rho / 1800.0);
        double unreacted_B = -4.8e9 * (high_rho / 1800.0);
        double unreacted_R1 = 10.5;
        double unreacted_R2 = 1.1;
        double unreacted_omega = 0.89;
        matSet.unreacted = { unreacted_A, unreacted_B, unreacted_R1, unreacted_R2, unreacted_omega, high_rho, 1000.0, 300.0 };

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

                if (command == "INIT") {
                    sim_terminate = true;
                    while (sim_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    sim_terminate = false;
                    sim_paused = false;
                    step_progress = 0;
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
                    global_target_steps = msg.at("steps").get<int>();
                    global_cfl = msg.value("cfl", 0.4);
                    global_exec_until_end = false;
                    if (!sim_running) {
                        sim_running = true;
                        sim_paused = false;
                        sim_terminate = false;
                        std::thread(worker_thread_func).detach();
                    } else { sim_paused = false; }
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
                    int amr_max_levels = msg.value("amr_max_levels", 3);
                    double amr_threshold = msg.value("amr_threshold", 0.05);
                    double amr_coarsen_ratio = msg.value("amr_coarsen_ratio", 0.2);

                    std::string precision = msg.value("precision", "double");
                    if (device == "cuda") {
                        global_solver_2d.reset();
                        {
                            std::lock_guard<std::mutex> lock(cout_mutex);
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
                            double explosive_z = msg.value("charge_z", msg.value("explosive_z", 0.0));
                            double explosive_radius = msg.value("charge_radius", msg.value("explosive_radius", 0.1));
                            
                            std::string charge_shape = msg.value("charge_shape", "Sphere");
                            if (charge_shape == "Cylinder" || charge_shape == "cylinder") {
                                double charge_radius = msg.value("charge_radius", 0.1);
                                double charge_height = msg.value("charge_height", 0.2);
                                double detonator_r = msg.value("detonator_r", 0.0);
                                double detonator_z = msg.value("detonator_z", explosive_z + charge_height / 2.0);
                                global_solver_2d->setDetonatorLocation(detonator_r, detonator_z);
                                global_solver_2d->setInitialConditionTNTCylinder(explosive_z, charge_radius, charge_height, high_rho, ambient_rho, ambient_p);
                            } else {
                                double detonator_r = msg.value("detonator_r", 0.0);
                                double detonator_z = msg.value("detonator_z", explosive_z);
                                global_solver_2d->setDetonatorLocation(detonator_r, detonator_z);
                                global_solver_2d->setInitialConditionTNT(explosive_z, explosive_radius, high_rho, ambient_rho, ambient_p);
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
                    global_target_steps_2d = msg.at("steps").get<int>();
                    global_cfl_2d = msg.value("cfl", 0.35);
                    global_exec_until_end_2d = false;
                    if (!sim2d_running) {
                        sim2d_running = true;
                        sim2d_paused = false;
                        sim2d_terminate = false;
                        std::thread(worker_2d_thread_func).detach();
                    } else { sim2d_paused = false; }
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
                } else if (command == "REMAP") {
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

                    if (global_solver_3d) {
                        double explosive_x = msg.value("explosive_x", 0.0);
                        double explosive_y = msg.value("explosive_y", 0.0);
                        global_solver_3d->initializeFrom1D(r_1d, states_1d, explosive_x, explosive_y, explosive_z, remap_radius);
                        global_t3d = 0.0;
                        global_wallclock_3d = 0.0;
                    } else if (global_solver_2d) {
                        global_solver_2d->setGamma(gamma);
                        global_solver_2d->setIdealGas(is_ideal_gas);
                        global_solver_2d->setMaterialParameters(matSet);
                        global_solver_2d->setInitialConditionFrom1D(explosive_z, remap_radius, r_1d, states_1d, ambient_rho, ambient_p, explosive_r);
                        global_solver_2d->setTime(0.0);
                    } else if (global_solver_2d_cuda) {
                        global_solver_2d_cuda->setGamma(gamma);
                        global_solver_2d_cuda->setIdealGas(is_ideal_gas);
                        global_solver_2d_cuda->setMaterialParameters(matSet);
                        global_solver_2d_cuda->setInitialConditionFrom1D(explosive_z, remap_radius, r_1d, states_1d, ambient_rho, ambient_p, explosive_r);
                        global_solver_2d_cuda->setTime(0.0);
                    }
                    global_t2d = 0.0;
                    global_wallclock_2d = 0.0;
                    solver2d_initialized = true;
                    emit_kernel_log("REMAP", "1D->2D remap applied successfully.", 0.0, "2d");
                    emit_telemetry_2d(global_t2d, false);
                } else if (command == "STEP_3D") {
                    if (sim3d_init_in_progress.load()) {
                        emit_kernel_log("WARNING", "Cannot step simulation: 3D initialization is in progress.", 0.0, "3d");
                        continue;
                    }
                    if (!global_solver_3d) continue;
                    global_target_steps_3d = msg.at("steps").get<int>();
                    global_cfl_3d = msg.value("cfl", 0.4);
                    global_exec_until_end_3d = false;
                    if (!sim3d_running) {
                        sim3d_running = true;
                        sim3d_paused = false;
                        sim3d_terminate = false;
                        std::thread(worker_3d_thread_func).detach();
                    } else { sim3d_paused = false; }
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
                    global_t3d = 0.0;
                    global_wallclock_3d = 0.0;

                    global_slices_3d.clear();
                    if (msg.contains("slices")) {
                        for (const auto& s_msg : msg["slices"]) {
                            Slice3D s;
                            s.axis = s_msg.value("axis", "xy");
                            s.offset = s_msg.value("offset", 0.5);
                            s.stride = s_msg.value("stride", 1);
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
                        s.quantities.push_back("pressure");
                        global_slices_3d.push_back(s);
                    }

                    // Start the asynchronous initialization thread
                    std::thread(init_3d_thread_func, msg).detach();

                } else if (command == "CONTOUR_CONFIG" || command == "VIEW3D_CONFIG") {
                    global_telemetry_stride = msg.value("stride", 1);
                    double rate = msg.value("refresh_rate", 0.0);
                    global_telemetry_interval_ms = (rate > 0.0) ? static_cast<int>(rate * 1000.0) : 33;
                    if (msg.contains("slices")) {
                        global_slices_3d.clear();
                        for (const auto& s_msg : msg["slices"]) {
                            Slice3D s;
                            s.axis = s_msg.value("axis", "xy");
                            s.offset = s_msg.value("offset", 0.5);
                            s.stride = s_msg.value("stride", 1);
                            if (s.stride < 1) s.stride = 1;
                            if (s_msg.contains("quantities")) {
                                for (const auto& q : s_msg["quantities"]) {
                                    s.quantities.push_back(q.get<std::string>());
                                }
                            }
                            global_slices_3d.push_back(s);
                        }
                    }
                    if (command == "CONTOUR_CONFIG") {
                        if (has_solver_2d()) {
                            emit_telemetry_2d(global_t2d, false);
                        }
                    } else if (command == "VIEW3D_CONFIG") {
                        if (global_solver_3d) {
                            emit_telemetry_3d(global_t3d, false);
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

    return 0;
}
