#pragma once

#include <string>
#include <vector>
#include <mutex>
#include <nlohmann/json.hpp>

struct GaugeDef {
    std::string id;
    double r = 0.0;
    double z = 0.0;
    double x = 0.0;
    double y = 0.0;
    bool is_3d = false;
};

struct GaugeHistory {
    std::string id;
    std::vector<std::vector<float>> channel_values; // size 9: [p, rho, u, e_int, alpha1, alpha2, air, overpressure, impulse]
};

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
    bool qty_temperature = true;
    bool qty_afterburn_rate = true;
    bool qty_fuel_density = true;
};

extern std::vector<GaugeDef> global_gauges;
extern std::vector<double> global_gauge_times;
extern std::vector<GaugeHistory> global_gauges_history;
extern std::vector<std::string> global_pinned_gauge_ids;
extern std::vector<size_t> global_pinned_gauge_indices;
extern std::mutex global_gauges_mutex;
extern GaugeOutputConfig global_gauge_config;

void init_gauges(const nlohmann::json& msg);
void record_gauges_1d(double t);
void record_gauges_2d(double t);
void record_gauges_3d(double t);
void flush_solver_gauges_locked();
void flush_solver_gauges();
void write_gauge_files();
void read_external_gauge_file(const std::string& filepath, const std::string& format);
