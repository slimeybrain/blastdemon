#include "GaugeService.hpp"
#include "VTKService.hpp"
#include "SolverState.hpp"
#include "HDF5Writer.hpp"

#include <iostream>
#include <fstream>
#include <sstream>
#include <iomanip>
#include <filesystem>
#include <cmath>
#include <algorithm>

std::vector<GaugeDef> global_gauges;
std::vector<double> global_gauge_times;
std::vector<GaugeHistory> global_gauges_history;
std::vector<std::string> global_pinned_gauge_ids;
std::vector<size_t> global_pinned_gauge_indices;
std::mutex global_gauges_mutex;
GaugeOutputConfig global_gauge_config;

void write_gauge_files() {
    std::lock_guard<std::mutex> lock(global_gauges_mutex);
    if (global_gauges.empty()) return;
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
        for (size_t h_idx = 0; h_idx < global_gauges_history.size(); ++h_idx) {
            const auto& hist = global_gauges_history[h_idx];
            std::string filename = out_dir + "/" + global_gauge_config.custom_filename + "_" + hist.id + ".csv";
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
        for (size_t h_idx = 0; h_idx < global_gauges_history.size(); ++h_idx) {
            const auto& hist = global_gauges_history[h_idx];
            std::string filename = out_dir + "/" + global_gauge_config.custom_filename + "_" + hist.id + ".bin";
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

        for (size_t h_idx = 0; h_idx < global_gauges_history.size(); ++h_idx) {
            const auto& hist = global_gauges_history[h_idx];
            gauge_ids.push_back(hist.id);
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

void read_external_gauge_file(const std::string& filepath, const std::string& format) {
    if (!std::filesystem::exists(filepath)) {
        std::cerr << "[WARN] External gauge file not found: " << filepath << std::endl;
        return;
    }

    bool is_bin = (format == "Binary Floats") || (filepath.size() >= 4 && filepath.substr(filepath.size() - 4) == ".bin");

    if (is_bin) {
        std::ifstream file(filepath, std::ios::binary);
        if (file.is_open()) {
            file.seekg(0, std::ios::end);
            size_t bytes = file.tellg();
            file.seekg(0, std::ios::beg);
            size_t num_floats = bytes / sizeof(float);
            size_t num_points = num_floats / 3;
            std::vector<float> coords(num_floats);
            file.read(reinterpret_cast<char*>(coords.data()), bytes);

            global_gauges.reserve(global_gauges.size() + num_points);
            for (size_t i = 0; i < num_points; ++i) {
                GaugeDef g;
                g.id = "P" + std::to_string(i + 1);
                g.x = coords[i * 3 + 0];
                g.y = coords[i * 3 + 1];
                g.z = coords[i * 3 + 2];
                g.r = 0.0;
                g.is_3d = true;
                global_gauges.push_back(g);
            }
            std::cout << "[INFO] Loaded " << num_points << " external binary probes from " << filepath << std::endl;
        }
    } else {
        std::ifstream file(filepath);
        if (file.is_open()) {
            std::string line;
            size_t count = 0;
            while (std::getline(file, line)) {
                if (line.empty() || line[0] == '#' || line[0] == '/' || line[0] == 'x' || line[0] == 'X') continue;
                std::stringstream ss(line);
                std::string token;
                std::vector<double> vals;
                std::string custom_id = "";
                while (std::getline(ss, token, ',')) {
                    if (token.empty()) continue;
                    try {
                        vals.push_back(std::stod(token));
                    } catch (...) {
                        if (custom_id.empty()) custom_id = token;
                    }
                }
                if (vals.size() >= 3) {
                    GaugeDef g;
                    g.id = custom_id.empty() ? ("P" + std::to_string(count + 1)) : custom_id;
                    g.x = vals[0];
                    g.y = vals[1];
                    g.z = vals[2];
                    g.r = 0.0;
                    g.is_3d = true;
                    global_gauges.push_back(g);
                    count++;
                } else if (vals.size() == 2) {
                    GaugeDef g;
                    g.id = custom_id.empty() ? ("P" + std::to_string(count + 1)) : custom_id;
                    g.r = vals[0];
                    g.z = vals[1];
                    g.x = 0.0;
                    g.y = 0.0;
                    g.is_3d = false;
                    global_gauges.push_back(g);
                    count++;
                }
            }
            std::cout << "[INFO] Loaded " << count << " external probes from " << filepath << std::endl;
        }
    }
}

void init_gauges(const nlohmann::json& msg) {
    std::lock_guard<std::mutex> lock(global_gauges_mutex);
    global_gauges.clear();
    global_gauge_times.clear();
    global_gauges_history.clear();
    global_pinned_gauge_ids.clear();
    global_pinned_gauge_indices.clear();

    if (msg.contains("model_filename") && !msg["model_filename"].is_null()) {
        global_model_filename = msg.value("model_filename", "");
    }

    std::string source_mode = "manual";
    std::string ext_file = "";
    std::string ext_format = "Auto";

    if (msg.contains("gauge_source_mode")) source_mode = msg.value("gauge_source_mode", "manual");
    if (msg.contains("external_gauge_file")) ext_file = msg.value("external_gauge_file", "");
    if (msg.contains("external_gauge_format")) ext_format = msg.value("external_gauge_format", "Auto");

    if (msg.contains("pinned_gauge_ids") && msg["pinned_gauge_ids"].is_array()) {
        for (const auto& pid : msg["pinned_gauge_ids"]) {
            if (pid.is_string()) global_pinned_gauge_ids.push_back(pid.get<std::string>());
            else if (pid.is_number()) global_pinned_gauge_ids.push_back(std::to_string(pid.get<int>()));
        }
    }
    
    if (msg.contains("nodes")) {
        for (const auto& node : msg["nodes"]) {
            std::string type = node.value("type", "");
            if (type == "VirtualGauges" || type == "VirtualGauges3D") {
                if (node.contains("parameters")) {
                    const auto& params = node["parameters"];
                    if (params.contains("source_mode")) source_mode = params.value("source_mode", source_mode);
                    if (params.contains("external_file_path")) ext_file = params.value("external_file_path", ext_file);
                    if (params.contains("external_file_format")) ext_format = params.value("external_file_format", ext_format);
                    if (params.contains("pinned_probe_ids") && params["pinned_probe_ids"].is_array()) {
                        for (const auto& pid : params["pinned_probe_ids"]) {
                            if (pid.is_string()) global_pinned_gauge_ids.push_back(pid.get<std::string>());
                            else if (pid.is_number()) global_pinned_gauge_ids.push_back(std::to_string(pid.get<int>()));
                        }
                    }

                    global_gauge_config.export_ascii = get_json_bool(params, "export_ascii", false);
                    global_gauge_config.export_binary = get_json_bool(params, "export_binary", false);
                    global_gauge_config.export_hdf5 = get_json_bool(params, "export_hdf5", false);
                    global_gauge_config.ascii_delimiter = params.value("ascii_delimiter", "Comma");
                    global_gauge_config.ascii_precision = params.value("ascii_precision", 6);
                    global_gauge_config.include_header = get_json_bool(params, "include_header", true);
                    global_gauge_config.output_dir = params.value("output_dir", "");
                    global_gauge_config.custom_filename = params.value("custom_filename", "gauges");
                    global_gauge_config.qty_pressure = get_json_bool(params, "qty_pressure", true);
                    global_gauge_config.qty_density = get_json_bool(params, "qty_density", true);
                    global_gauge_config.qty_velocity = get_json_bool(params, "qty_velocity", true);
                    global_gauge_config.qty_energy = get_json_bool(params, "qty_energy", true);
                    global_gauge_config.qty_reacted = get_json_bool(params, "qty_reacted", true);
                    global_gauge_config.qty_unreacted = get_json_bool(params, "qty_unreacted", true);
                    global_gauge_config.qty_air = get_json_bool(params, "qty_air", true);
                    global_gauge_config.qty_overpressure = get_json_bool(params, "qty_overpressure", true);
                    global_gauge_config.qty_impulse = get_json_bool(params, "qty_impulse", true);
                    global_gauge_config.qty_temperature = get_json_bool(params, "qty_temperature", true);
                    global_gauge_config.qty_afterburn_rate = get_json_bool(params, "qty_afterburn_rate", true);
                    global_gauge_config.qty_fuel_density = get_json_bool(params, "qty_fuel_density", true);
                }
                
                if (source_mode == "manual" && node.contains("parameters") && node["parameters"].contains("gauges")) {
                    for (const auto& gauge : node["parameters"]["gauges"]) {
                        GaugeDef g;
                        if (gauge.contains("x") || gauge.contains("y") || gauge.contains("z")) {
                            g.id = gauge.value("id", gauge.value("name", ""));
                            if (g.id.empty()) g.id = "G" + std::to_string(global_gauges.size() + 1);
                            g.x = gauge.value("x", 0.0);
                            g.y = gauge.value("y", 0.0);
                            g.z = gauge.value("z", 0.0);
                            g.r = 0.0;
                            g.is_3d = true;
                        } else {
                            g.id = gauge.value("id", gauge.value("name", ""));
                            if (g.id.empty()) g.id = "G" + std::to_string(global_gauges.size() + 1);
                            g.r = gauge.value("r", 0.0);
                            g.z = gauge.value("z", 0.0);
                            g.x = 0.0;
                            g.y = 0.0;
                            g.is_3d = false;
                        }
                        global_gauges.push_back(g);
                    }
                }
            }
        }
    }

    if (global_gauges.empty() && msg.contains("gauges") && msg["gauges"].is_array()) {
        for (const auto& gauge : msg["gauges"]) {
            GaugeDef g;
            if (gauge.contains("x") || gauge.contains("y") || gauge.contains("z")) {
                g.id = gauge.value("id", gauge.value("name", ""));
                if (g.id.empty()) g.id = "G" + std::to_string(global_gauges.size() + 1);
                g.x = gauge.value("x", 0.0);
                g.y = gauge.value("y", 0.0);
                g.z = gauge.value("z", 0.0);
                g.r = 0.0;
                g.is_3d = true;
            } else {
                g.id = gauge.value("id", gauge.value("name", ""));
                if (g.id.empty()) g.id = "G" + std::to_string(global_gauges.size() + 1);
                g.r = gauge.value("r", 0.0);
                g.z = gauge.value("z", 0.0);
                g.x = 0.0;
                g.y = 0.0;
                g.is_3d = false;
            }
            global_gauges.push_back(g);
        }
    }

    if (msg.contains("enable_gauges")) {
        global_enable_gauges = (msg.value("enable_gauges", "Enabled") != "Disabled");
    }

    if (msg.contains("modelId") && msg["modelId"].is_string()) {
        global_model_id = msg["modelId"].get<std::string>();
    } else if (msg.contains("model_id") && msg["model_id"].is_string()) {
        global_model_id = msg["model_id"].get<std::string>();
    }

    parse_vtk_config(msg);

    if (source_mode == "external_file" && !ext_file.empty()) {
        read_external_gauge_file(ext_file, ext_format);
    }

    global_pinned_gauge_indices.clear();
    global_gauges_history.clear();

    if (global_gauges.size() <= 32) {
        for (size_t i = 0; i < global_gauges.size(); ++i) {
            global_pinned_gauge_indices.push_back(i);
            GaugeHistory h;
            h.id = global_gauges[i].id;
            h.channel_values.resize(9);
            global_gauges_history.push_back(h);
        }
    } else {
        for (size_t i = 0; i < global_gauges.size(); ++i) {
            bool is_pinned = false;
            for (const auto& pid : global_pinned_gauge_ids) {
                if (pid == global_gauges[i].id || pid == std::to_string(i)) {
                    is_pinned = true;
                    break;
                }
            }
            if (is_pinned || (global_pinned_gauge_ids.empty() && global_pinned_gauge_indices.size() < 16)) {
                global_pinned_gauge_indices.push_back(i);
                GaugeHistory h;
                h.id = global_gauges[i].id;
                h.channel_values.resize(9);
                global_gauges_history.push_back(h);
                if (global_pinned_gauge_indices.size() >= 16) break;
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

    bool has_vtk = false;
    if (msg.contains("nodes")) {
        for (const auto& node : msg["nodes"]) {
            if (node.value("type", "") == "VTKOutput") {
                has_vtk = true;
                break;
            }
        }
    }
    if (!has_vtk && msg.contains("parameters")) {
        const auto& params = msg["parameters"];
        if (params.contains("vtk_format") || params.contains("custom_filename") || params.contains("export_slices") || params.contains("export_fem") || params.contains("export_mpm") || params.contains("export_obstacles") || params.contains("export_stl_faces") || params.contains("export_cfd_2d") || params.contains("trigger_type")) {
            has_vtk = true;
        }
    }
    if (!has_vtk) {
        if (msg.contains("export_cfd_2d") || msg.contains("export_obstacles") || msg.contains("export_stl_faces") || msg.contains("export_slices") || msg.contains("export_volumes") || msg.contains("vtk_dir") || msg.contains("custom_filename")) {
            has_vtk = true;
        }
    }
    if (has_vtk) {
        global_enable_vtk = true;
        bool is_initial = false;
        if (global_solver_3d && global_step_3d.load() == 0) is_initial = true;
        else if ((global_solver_2d || global_solver_2d_cuda) && global_step_2d.load() == 0) is_initial = true;
        else if (global_solver && global_step_1d.load() == 0) is_initial = true;
        else if (!global_fem_solvers_float.empty() || !global_fem_solvers_double.empty() ||
                 !global_fem_solvers_cuda_float.empty() || !global_fem_solvers_cuda_double.empty()) is_initial = true;
        else if (global_solver_mpm_3d || global_solver_mpm_3d_cuda) is_initial = true;
        else if (global_step_1d.load() == 0 && global_step_2d.load() == 0 && global_step_3d.load() == 0 &&
                 global_step_fsi_2d.load() == 0 && global_step_fsi_3d.load() == 0 && global_step_fem_fsi_3d.load() == 0) {
            is_initial = true;
        }

        if (is_initial) {
            write_vtk_outputs(0, 0.0);
            global_last_vtk_time_1d = 0.0;
            global_last_vtk_time_2d = 0.0;
            global_last_vtk_time_3d = 0.0;
            global_last_vtk_time_fsi_2d = 0.0;
            global_last_vtk_time_fsi_3d = 0.0;
            global_last_vtk_time_fem_fsi_3d = 0.0;
            global_last_vtk_time_mpm_3d = 0.0;
            global_last_vtk_time_fem_3d = 0.0;
        }
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
    for (size_t h_idx = 0; h_idx < global_pinned_gauge_indices.size(); ++h_idx) {
        size_t g_idx = global_pinned_gauge_indices[h_idx];
        const auto& g = global_gauges[g_idx];
        int i = std::clamp(static_cast<int>(g.r / dx), 0, n_cells - 1);
        auto vals = global_solver->getCellValues(i);
        for (int ch = 0; ch < 7; ++ch) {
            global_gauges_history[h_idx].channel_values[ch].push_back(vals[ch]);
        }
        double overpressure = vals[0] - p_atm;
        global_gauges_history[h_idx].channel_values[7].push_back(overpressure);

        double impulse = 0.0;
        if (!global_gauges_history[h_idx].channel_values[8].empty()) {
            double prev_imp = global_gauges_history[h_idx].channel_values[8].back();
            double prev_op = global_gauges_history[h_idx].channel_values[7][global_gauges_history[h_idx].channel_values[7].size() - 2];
            impulse = prev_imp + 0.5 * (prev_op + overpressure) * dt;
        }
        global_gauges_history[h_idx].channel_values[8].push_back(impulse);
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

        for (size_t h_idx = 0; h_idx < global_pinned_gauge_indices.size(); ++h_idx) {
            size_t g_idx = global_pinned_gauge_indices[h_idx];
            for (size_t ch = 0; ch < 7; ++ch) {
                float val = flat_vals[s * num_gauges * num_channels + g_idx * num_channels + ch];
                global_gauges_history[h_idx].channel_values[ch].push_back(val);
            }

            double overpressure = global_gauges_history[h_idx].channel_values[0].back() - p_atm;
            global_gauges_history[h_idx].channel_values[7].push_back(overpressure);

            double impulse = 0.0;
            if (!global_gauges_history[h_idx].channel_values[8].empty()) {
                double prev_imp = global_gauges_history[h_idx].channel_values[8].back();
                double prev_op = global_gauges_history[h_idx].channel_values[7][global_gauges_history[h_idx].channel_values[7].size() - 2];
                impulse = prev_imp + 0.5 * (prev_op + overpressure) * dt;
            }
            global_gauges_history[h_idx].channel_values[8].push_back(impulse);
        }
    }
}

void flush_solver_gauges() {
    std::lock_guard<std::mutex> lock(global_gauges_mutex);
    flush_solver_gauges_locked();
}
