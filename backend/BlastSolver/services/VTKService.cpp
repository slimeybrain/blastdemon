#include "VTKService.hpp"
#include "SolverState.hpp"
#include "VTKWriter.hpp"
#include "AsyncVTKWriter.hpp"
#include "HDF5Writer.hpp"
#include "XDMFWriter.hpp"

#include <iostream>
#include <sstream>
#include <iomanip>
#include <filesystem>
#include <cmath>
#include <algorithm>
#include <chrono>

VTKOutputConfig global_vtk_config;

bool should_write_vtk(int step_count, double sim_time, double last_vtk_time) {
    if (global_vtk_config.trigger_type == "time" || global_vtk_config.trigger_type == "Time Interval") {
        if (global_vtk_config.time_interval <= 0.0) return false;
        return (sim_time - last_vtk_time >= global_vtk_config.time_interval - 1e-12);
    } else {
        return (global_vtk_config.step_interval > 0 && (step_count % global_vtk_config.step_interval == 0));
    }
}

void update_last_vtk_time(std::atomic<double>& last_vtk_time_atomic, double current_time) {
    if (global_vtk_config.trigger_type == "time" || global_vtk_config.trigger_type == "Time Interval") {
        double interval = global_vtk_config.time_interval;
        if (interval > 0.0) {
            double last_t = last_vtk_time_atomic.load();
            double nominal_time = std::round(current_time / interval) * interval;
            last_vtk_time_atomic = (nominal_time > last_t) ? nominal_time : current_time;
            return;
        }
    }
    last_vtk_time_atomic = current_time;
}

bool should_write_final_vtk(double final_time, double last_time) {
    if (global_vtk_config.trigger_type == "time" || global_vtk_config.trigger_type == "Time Interval") {
        double interval = global_vtk_config.time_interval;
        if (interval > 0.0) {
            double nominal_final = std::round(final_time / interval) * interval;
            return (nominal_final > last_time + 1e-12);
        }
        return (final_time > last_time + 1e-12);
    } else {
        return (final_time > last_time + 1e-12);
    }
}

std::string get_vtk_frame_tag(int step, double time) {
    if (global_vtk_config.trigger_type == "time" || global_vtk_config.trigger_type == "Time Interval") {
        double interval = global_vtk_config.time_interval;
        double effective_time = time;
        if (interval > 0.0) {
            double nominal_time = std::round(time / interval) * interval;
            if (std::abs(time - nominal_time) <= 0.5 * interval) {
                effective_time = nominal_time;
            }
        }
        // 10 digits zero-padded with 0.1 µs resolution (100 ns = 1e-7 s)
        int64_t stamp_units = static_cast<int64_t>(std::llround(std::max(0.0, effective_time) * 1.0e7));
        std::ostringstream ss;
        ss << std::setw(10) << std::setfill('0') << stamp_units;
        return ss.str();
    } else {
        // Step Interval: 10 digits zero-padded step number for consistent chronological sorting
        std::ostringstream ss;
        ss << std::setw(10) << std::setfill('0') << step;
        return ss.str();
    }
}

void parse_vtk_config(const nlohmann::json& msg) {
    if (msg.contains("nodes")) {
        for (const auto& node : msg["nodes"]) {
            std::string type = node.value("type", "");
            if (type == "VTKOutput") {
                if (node.contains("parameters")) {
                    const auto& params = node["parameters"];
                    global_vtk_config.trigger_type = params.value("trigger_type", "Step Interval");
                    global_vtk_config.vtk_dir = params.value("vtk_dir", "");
                    global_vtk_config.export_slices = get_json_bool(params, "export_slices", true);
                    global_vtk_config.export_volumes = get_json_bool(params, "export_volumes", false);
                    global_vtk_config.export_fem = get_json_bool(params, "export_fem", true);
                    global_vtk_config.export_mpm = get_json_bool(params, "export_mpm", true);
                    global_vtk_config.export_obstacles = get_json_bool(params, "export_obstacles", true);
                    global_vtk_config.export_stl_faces = get_json_bool(params, "export_stl_faces", true);
                    if (params.contains("stl_outside_domain") && params["stl_outside_domain"].is_string()) {
                        global_vtk_config.stl_outside_domain = params["stl_outside_domain"].get<std::string>();
                    }
                    global_vtk_config.tessellate_stl_faces = get_json_bool(params, "tessellate_stl_faces", false);
                    global_vtk_config.tessellation_max_edge = get_json_double(params, "tessellation_max_edge", 0.0);
                    global_vtk_config.export_cfd_2d = get_json_bool(params, "export_cfd_2d", true);
                    global_vtk_config.export_pvd = get_json_bool(params, "export_pvd", true);
                    global_vtk_config.custom_filename = params.value("custom_filename", "vtk_output");
                    global_vtk_config.step_interval = params.value("step_interval", 10);
                    global_vtk_config.time_interval = params.value("time_interval", 0.0001);
                    global_vtk_config.vtk_format = params.value("vtk_format", "Binary");
                    global_vtk_config.compression_level = get_json_int(params, "compression_level", 6);
                    global_vtk_config.float_precision = params.value("float_precision", "12-bit Mantissa (~4 sig. digits)");
                    global_vtk_config.mpm_topology = params.value("mpm_topology", "Individual Vertices");
                    // CFD Fields
                    global_vtk_config.qty_pressure = get_json_bool(params, "qty_pressure", true);
                    global_vtk_config.qty_density = get_json_bool(params, "qty_density", true);
                    global_vtk_config.qty_velocity = get_json_bool(params, "qty_velocity", true);
                    global_vtk_config.qty_energy = get_json_bool(params, "qty_energy", true);
                    global_vtk_config.qty_reacted = get_json_bool(params, "qty_reacted", true);
                    global_vtk_config.qty_unreacted = get_json_bool(params, "qty_unreacted", true);
                    global_vtk_config.qty_air = get_json_bool(params, "qty_air", true);
                    global_vtk_config.qty_materials = get_json_bool(params, "qty_materials", true);
                    global_vtk_config.qty_water = get_json_bool(params, "qty_water", true);
                    global_vtk_config.qty_soil = get_json_bool(params, "qty_soil", true);
                    global_vtk_config.qty_overpressure = get_json_bool(params, "qty_overpressure", true);
                    global_vtk_config.qty_impulse = get_json_bool(params, "qty_impulse", true);
                    global_vtk_config.qty_temperature = get_json_bool(params, "qty_temperature", true);
                    global_vtk_config.qty_afterburn_rate = get_json_bool(params, "qty_afterburn_rate", true);
                    global_vtk_config.qty_fuel_density = get_json_bool(params, "qty_fuel_density", true);
                    // FEM Fields
                    global_vtk_config.qty_fem_stress = get_json_bool(params, "qty_fem_stress", true);
                    global_vtk_config.qty_fem_strain = get_json_bool(params, "qty_fem_strain", true);
                    global_vtk_config.qty_fem_pressure = get_json_bool(params, "qty_fem_pressure", true);
                    global_vtk_config.qty_fem_temp = get_json_bool(params, "qty_fem_temp", true);
                    global_vtk_config.qty_fem_damage = get_json_bool(params, "qty_fem_damage", true);
                    global_vtk_config.qty_fem_vel = get_json_bool(params, "qty_fem_vel", true);
                    global_vtk_config.qty_fem_disp = get_json_bool(params, "qty_fem_disp", true);
                    // MPM Fields
                    global_vtk_config.qty_mpm_stress = get_json_bool(params, "qty_mpm_stress", true);
                    global_vtk_config.qty_mpm_strain = get_json_bool(params, "qty_mpm_strain", true);
                    global_vtk_config.qty_mpm_damage = get_json_bool(params, "qty_mpm_damage", true);
                    global_vtk_config.qty_mpm_temp = get_json_bool(params, "qty_mpm_temp", true);
                    global_vtk_config.qty_mpm_vel = get_json_bool(params, "qty_mpm_vel", true);
                    global_vtk_config.qty_mpm_disp = get_json_bool(params, "qty_mpm_disp", true);
                    global_vtk_config.qty_mpm_pressure = get_json_bool(params, "qty_mpm_pressure", true);
                    global_vtk_config.qty_mpm_material_id = get_json_bool(params, "qty_mpm_material_id", true);
                    global_vtk_config.qty_mpm_object_id = get_json_bool(params, "qty_mpm_object_id", true);
                    global_vtk_config.qty_mpm_particle_density = get_json_bool(params, "qty_mpm_particle_density", true);
                    // Spatial ROI & Strides
                    global_vtk_config.roi_enabled = get_json_bool(params, "roi_enabled", false);
                    global_vtk_config.roi_xmin = params.value("roi_xmin", 0.0);
                    global_vtk_config.roi_xmax = params.value("roi_xmax", 1.0);
                    global_vtk_config.roi_ymin = params.value("roi_ymin", 0.0);
                    global_vtk_config.roi_ymax = params.value("roi_ymax", 1.0);
                    global_vtk_config.roi_zmin = params.value("roi_zmin", 0.0);
                    global_vtk_config.roi_zmax = params.value("roi_zmax", 1.0);
                    global_vtk_config.volume_stride = params.value("volume_stride", 1);
                    global_vtk_config.slice_stride = params.value("slice_stride", 1);
                }
            }
        }
    }

    if (msg.contains("parameters")) {
        const auto& params = msg["parameters"];
        if (params.contains("trigger_type")) global_vtk_config.trigger_type = params.value("trigger_type", global_vtk_config.trigger_type);
        if (params.contains("vtk_dir")) global_vtk_config.vtk_dir = params.value("vtk_dir", global_vtk_config.vtk_dir);
        if (params.contains("export_slices")) global_vtk_config.export_slices = params.value("export_slices", global_vtk_config.export_slices);
        if (params.contains("export_volumes")) global_vtk_config.export_volumes = params.value("export_volumes", global_vtk_config.export_volumes);
        if (params.contains("export_fem")) global_vtk_config.export_fem = params.value("export_fem", global_vtk_config.export_fem);
        if (params.contains("export_mpm")) global_vtk_config.export_mpm = params.value("export_mpm", global_vtk_config.export_mpm);
        if (params.contains("export_obstacles")) global_vtk_config.export_obstacles = params.value("export_obstacles", global_vtk_config.export_obstacles);
        if (params.contains("export_stl_faces")) global_vtk_config.export_stl_faces = params.value("export_stl_faces", global_vtk_config.export_stl_faces);
        if (params.contains("stl_outside_domain")) global_vtk_config.stl_outside_domain = params.value("stl_outside_domain", global_vtk_config.stl_outside_domain);
        if (params.contains("tessellate_stl_faces")) global_vtk_config.tessellate_stl_faces = params.value("tessellate_stl_faces", global_vtk_config.tessellate_stl_faces);
        if (params.contains("tessellation_max_edge")) global_vtk_config.tessellation_max_edge = params.value("tessellation_max_edge", global_vtk_config.tessellation_max_edge);
        if (params.contains("export_cfd_2d")) global_vtk_config.export_cfd_2d = params.value("export_cfd_2d", global_vtk_config.export_cfd_2d);
        if (params.contains("export_pvd")) global_vtk_config.export_pvd = params.value("export_pvd", global_vtk_config.export_pvd);
        if (params.contains("custom_filename")) global_vtk_config.custom_filename = params.value("custom_filename", global_vtk_config.custom_filename);
        if (params.contains("step_interval")) global_vtk_config.step_interval = params.value("step_interval", global_vtk_config.step_interval);
        if (params.contains("time_interval")) global_vtk_config.time_interval = params.value("time_interval", global_vtk_config.time_interval);
        if (params.contains("vtk_format")) global_vtk_config.vtk_format = params.value("vtk_format", global_vtk_config.vtk_format);
        if (params.contains("compression_level")) global_vtk_config.compression_level = get_json_int(params, "compression_level", global_vtk_config.compression_level);
        if (params.contains("float_precision") && params["float_precision"].is_string()) global_vtk_config.float_precision = params["float_precision"].get<std::string>();
        if (params.contains("mpm_topology") && params["mpm_topology"].is_string()) global_vtk_config.mpm_topology = params["mpm_topology"].get<std::string>();
        if (params.contains("roi_enabled")) global_vtk_config.roi_enabled = params.value("roi_enabled", global_vtk_config.roi_enabled);
        if (params.contains("volume_stride")) global_vtk_config.volume_stride = params.value("volume_stride", global_vtk_config.volume_stride);
        if (params.contains("slice_stride")) global_vtk_config.slice_stride = params.value("slice_stride", global_vtk_config.slice_stride);
        if (params.contains("qty_materials")) global_vtk_config.qty_materials = get_json_bool(params, "qty_materials", global_vtk_config.qty_materials);
        if (params.contains("qty_water")) global_vtk_config.qty_water = get_json_bool(params, "qty_water", global_vtk_config.qty_water);
        if (params.contains("qty_soil")) global_vtk_config.qty_soil = get_json_bool(params, "qty_soil", global_vtk_config.qty_soil);
        if (params.contains("qty_mpm_pressure")) global_vtk_config.qty_mpm_pressure = get_json_bool(params, "qty_mpm_pressure", global_vtk_config.qty_mpm_pressure);
        if (params.contains("qty_mpm_material_id")) global_vtk_config.qty_mpm_material_id = get_json_bool(params, "qty_mpm_material_id", global_vtk_config.qty_mpm_material_id);
        if (params.contains("qty_mpm_object_id")) global_vtk_config.qty_mpm_object_id = get_json_bool(params, "qty_mpm_object_id", global_vtk_config.qty_mpm_object_id);
        if (params.contains("qty_mpm_particle_density")) global_vtk_config.qty_mpm_particle_density = get_json_bool(params, "qty_mpm_particle_density", global_vtk_config.qty_mpm_particle_density);
    }

    if (msg.contains("trigger_type") && msg["trigger_type"].is_string()) global_vtk_config.trigger_type = msg["trigger_type"].get<std::string>();
    if (msg.contains("vtk_dir") && msg["vtk_dir"].is_string()) global_vtk_config.vtk_dir = msg["vtk_dir"].get<std::string>();
    if (msg.contains("custom_filename") && msg["custom_filename"].is_string()) global_vtk_config.custom_filename = msg["custom_filename"].get<std::string>();
    if (msg.contains("vtk_format") && msg["vtk_format"].is_string()) global_vtk_config.vtk_format = msg["vtk_format"].get<std::string>();
    if (msg.contains("compression_level")) global_vtk_config.compression_level = get_json_int(msg, "compression_level", global_vtk_config.compression_level);
    if (msg.contains("float_precision") && msg["float_precision"].is_string()) global_vtk_config.float_precision = msg["float_precision"].get<std::string>();
    if (msg.contains("mpm_topology") && msg["mpm_topology"].is_string()) global_vtk_config.mpm_topology = msg["mpm_topology"].get<std::string>();
    if (msg.contains("export_slices")) global_vtk_config.export_slices = get_json_bool(msg, "export_slices", global_vtk_config.export_slices);
    if (msg.contains("export_volumes")) global_vtk_config.export_volumes = get_json_bool(msg, "export_volumes", global_vtk_config.export_volumes);
    if (msg.contains("export_fem")) global_vtk_config.export_fem = get_json_bool(msg, "export_fem", global_vtk_config.export_fem);
    if (msg.contains("export_mpm")) global_vtk_config.export_mpm = get_json_bool(msg, "export_mpm", global_vtk_config.export_mpm);
    if (msg.contains("export_obstacles")) global_vtk_config.export_obstacles = get_json_bool(msg, "export_obstacles", global_vtk_config.export_obstacles);
    if (msg.contains("export_stl_faces")) global_vtk_config.export_stl_faces = get_json_bool(msg, "export_stl_faces", global_vtk_config.export_stl_faces);
    if (msg.contains("stl_outside_domain") && msg["stl_outside_domain"].is_string()) global_vtk_config.stl_outside_domain = msg["stl_outside_domain"].get<std::string>();
    if (msg.contains("tessellate_stl_faces")) global_vtk_config.tessellate_stl_faces = get_json_bool(msg, "tessellate_stl_faces", global_vtk_config.tessellate_stl_faces);
    if (msg.contains("tessellation_max_edge")) global_vtk_config.tessellation_max_edge = get_json_double(msg, "tessellation_max_edge", global_vtk_config.tessellation_max_edge);
    if (msg.contains("export_cfd_2d")) global_vtk_config.export_cfd_2d = get_json_bool(msg, "export_cfd_2d", global_vtk_config.export_cfd_2d);
    if (msg.contains("export_pvd")) global_vtk_config.export_pvd = get_json_bool(msg, "export_pvd", global_vtk_config.export_pvd);
    if (msg.contains("step_interval")) global_vtk_config.step_interval = get_json_int(msg, "step_interval", global_vtk_config.step_interval);
    if (msg.contains("time_interval")) global_vtk_config.time_interval = get_json_double(msg, "time_interval", global_vtk_config.time_interval);
    if (msg.contains("qty_materials")) global_vtk_config.qty_materials = get_json_bool(msg, "qty_materials", global_vtk_config.qty_materials);
    if (msg.contains("qty_water")) global_vtk_config.qty_water = get_json_bool(msg, "qty_water", global_vtk_config.qty_water);
    if (msg.contains("qty_soil")) global_vtk_config.qty_soil = get_json_bool(msg, "qty_soil", global_vtk_config.qty_soil);
    if (msg.contains("qty_mpm_pressure")) global_vtk_config.qty_mpm_pressure = get_json_bool(msg, "qty_mpm_pressure", global_vtk_config.qty_mpm_pressure);
    if (msg.contains("qty_mpm_material_id")) global_vtk_config.qty_mpm_material_id = get_json_bool(msg, "qty_mpm_material_id", global_vtk_config.qty_mpm_material_id);
    if (msg.contains("qty_mpm_object_id")) global_vtk_config.qty_mpm_object_id = get_json_bool(msg, "qty_mpm_object_id", global_vtk_config.qty_mpm_object_id);
    if (msg.contains("qty_mpm_particle_density")) global_vtk_config.qty_mpm_particle_density = get_json_bool(msg, "qty_mpm_particle_density", global_vtk_config.qty_mpm_particle_density);

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
    if (global_vtk_config.vtk_dir.empty()) {
        global_vtk_config.vtk_dir = default_dir;
    }
}

void write_vtk_outputs(int step, double time) {
    auto vtk_start = std::chrono::steady_clock::now();
    std::string tag = get_vtk_frame_tag(step, time);
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
    if (!global_model_id.empty() && (global_vtk_config.vtk_dir.empty() || global_vtk_config.vtk_dir == "." || global_vtk_config.vtk_dir == "./vtk_output")) {
        out_dir = out_dir + "/" + global_model_id;
    }

    try {
        std::filesystem::create_directories(out_dir);
    } catch (const std::exception& e) {
        std::cerr << "[ERROR] Failed to create directory: " << out_dir << " - " << e.what() << std::endl;
    }

    // 1. CFD 3D Domain
    if (global_solver_3d) {
        bool has_p = global_vtk_config.qty_pressure;
        bool has_rho = global_vtk_config.qty_density;
        bool has_vel = global_vtk_config.qty_velocity;
        bool has_E = global_vtk_config.qty_energy;
        bool has_reacted = global_vtk_config.qty_reacted;
        bool has_unreacted = global_vtk_config.qty_unreacted;
        bool has_air = global_vtk_config.qty_air;
        bool has_materials = global_vtk_config.qty_materials;
        bool has_water = global_vtk_config.qty_water;
        bool has_soil = global_vtk_config.qty_soil;
        bool has_overpressure = global_vtk_config.qty_overpressure;
        bool has_impulse = global_vtk_config.qty_impulse;
        bool has_temp = global_vtk_config.qty_temperature;
        bool has_ab_rate = global_vtk_config.qty_afterburn_rate;
        bool has_fuel_rho = global_vtk_config.qty_fuel_density;

        const auto& active_stl_triangles = (!global_tessellated_stl_triangles.empty())
            ? global_tessellated_stl_triangles
            : global_raw_stl_triangles;

        // 1A. Slices
        if (global_vtk_config.export_slices) {
            for (size_t i = 0; i < global_slices_3d.size(); ++i) {
                if (!global_slices_3d[i].enabled) continue;
                if (global_slices_3d[i].axis != "xy" && global_slices_3d[i].axis != "xz" && global_slices_3d[i].axis != "yz") continue;
                std::string rel_filename = global_vtk_config.custom_filename + "_slice_" + global_slices_3d[i].axis + "_" + std::to_string(i) + "_" + tag + ".vtu";
                std::string filename = out_dir + "/" + rel_filename;
                std::string pvd_filename = out_dir + "/" + global_vtk_config.custom_filename + "_cfd_slice_" + std::to_string(i) + ".pvd";
                bool export_pvd = global_vtk_config.export_pvd;
                std::string format = global_vtk_config.vtk_format;

                CFDSliceSnapshot3D snap;
                snap.axis = global_slices_3d[i].axis;
                snap.offset = global_slices_3d[i].offset;
                snap.stride = (global_vtk_config.slice_stride > 0) ? global_vtk_config.slice_stride : (global_slices_3d[i].stride > 0 ? global_slices_3d[i].stride : 1);
                snap.nx = global_solver_3d->getNx();
                snap.ny = global_solver_3d->getNy();
                snap.nz = global_solver_3d->getNz();
                snap.dx = global_solver_3d->getCellSize();
                snap.xmin = global_solver_3d->getXMin();
                snap.ymin = global_solver_3d->getYMin();
                snap.zmin = global_solver_3d->getZMin();

                snap.has_p = has_p;
                snap.has_rho = has_rho;
                snap.has_vel = has_vel;
                snap.has_E = has_E;
                snap.has_reacted = has_reacted;
                snap.has_unreacted = has_unreacted;
                snap.has_air = has_air;
                snap.has_solid = true;
                snap.has_materials = has_materials;
                snap.has_water = has_water;
                snap.has_soil = has_soil;
                snap.has_overpressure = has_overpressure;
                snap.has_impulse = has_impulse;
                snap.has_temp = has_temp;
                snap.has_afterburn_rate = has_ab_rate;
                snap.has_fuel_density = has_fuel_rho;

                Slice3D slice_query = global_slices_3d[i];
                slice_query.stride = snap.stride;

                if (has_rho) { slice_query.quantities = { "density" }; snap.rho = global_solver_3d->extractSlice(slice_query); }
                if (has_p) { slice_query.quantities = { "pressure" }; snap.p = global_solver_3d->extractSlice(slice_query); }
                if (has_vel) { slice_query.quantities = { "velocity" }; snap.vel = global_solver_3d->extractSlice(slice_query); }
                if (has_E) { slice_query.quantities = { "energy" }; snap.E = global_solver_3d->extractSlice(slice_query); }
                if (has_reacted) { slice_query.quantities = { "species1" }; snap.reacted = global_solver_3d->extractSlice(slice_query); }
                if (has_unreacted) { slice_query.quantities = { "species2" }; snap.unreacted = global_solver_3d->extractSlice(slice_query); }
                if (has_air) { slice_query.quantities = { "species3" }; snap.air = global_solver_3d->extractSlice(slice_query); }
                if (snap.has_solid) { slice_query.quantities = { "solid" }; snap.solid = global_solver_3d->extractSlice(slice_query); }
                if (has_materials) { slice_query.quantities = { "materials" }; snap.materials = global_solver_3d->extractSlice(slice_query); }
                if (has_water) { slice_query.quantities = { "water" }; snap.water = global_solver_3d->extractSlice(slice_query); }
                if (has_soil) { slice_query.quantities = { "soil" }; snap.soil = global_solver_3d->extractSlice(slice_query); }
                if (has_overpressure) { slice_query.quantities = { "overpressure" }; snap.overpressure = global_solver_3d->extractSlice(slice_query); }
                if (has_impulse) { slice_query.quantities = { "impulse" }; snap.impulse = global_solver_3d->extractSlice(slice_query); }
                if (has_temp) { slice_query.quantities = { "temperature" }; snap.temp = global_solver_3d->extractSlice(slice_query); }
                if (has_ab_rate) { slice_query.quantities = { "afterburn_rate" }; snap.afterburn_rate = global_solver_3d->extractSlice(slice_query); }
                if (has_fuel_rho) { slice_query.quantities = { "fuel_density" }; snap.fuel_density = global_solver_3d->extractSlice(slice_query); }

                Blast::AsyncVTKWriter::getInstance().enqueue([filename, snap = std::move(snap), format, export_pvd, pvd_filename, time, rel_filename]() {
                    export_vtu_slice_3d_snapshot(filename, snap, format);
                    if (export_pvd) {
                        append_pvd_timestep(pvd_filename, time, rel_filename);
                    }
                });
            }
        }

        // 1B. Volumes
        if (global_vtk_config.export_volumes) {
            std::string rel_filename = global_vtk_config.custom_filename + "_volume_" + tag + ".vtu";
            std::string filename = out_dir + "/" + rel_filename;
            std::string pvd_filename = out_dir + "/" + global_vtk_config.custom_filename + "_cfd_volume.pvd";
            bool export_pvd = global_vtk_config.export_pvd;
            std::string format = global_vtk_config.vtk_format;

            CFDVolumeSnapshot3D snap;
            snap.nx = global_solver_3d->getNx();
            snap.ny = global_solver_3d->getNy();
            snap.nz = global_solver_3d->getNz();
            snap.cellSize = global_solver_3d->getCellSize();
            snap.xmin = global_solver_3d->getXMin();
            snap.ymin = global_solver_3d->getYMin();
            snap.zmin = global_solver_3d->getZMin();
            snap.stride = std::max(1, global_vtk_config.volume_stride);
            snap.roi_enabled = global_vtk_config.roi_enabled;
            snap.roi_xmin = global_vtk_config.roi_xmin; snap.roi_xmax = global_vtk_config.roi_xmax;
            snap.roi_ymin = global_vtk_config.roi_ymin; snap.roi_ymax = global_vtk_config.roi_ymax;
            snap.roi_zmin = global_vtk_config.roi_zmin; snap.roi_zmax = global_vtk_config.roi_zmax;

            snap.has_p = has_p;
            snap.has_rho = has_rho;
            snap.has_vel = has_vel;
            snap.has_E = has_E;
            snap.has_reacted = has_reacted;
            snap.has_unreacted = has_unreacted;
            snap.has_air = has_air;
            snap.has_solid = true;
            snap.has_materials = has_materials;
            snap.has_water = has_water;
            snap.has_soil = has_soil;
            snap.has_overpressure = has_overpressure;
            snap.has_impulse = has_impulse;

            Slice3D vol_query;
            vol_query.axis = "volume";
            vol_query.stride = snap.stride;
            vol_query.roi_enabled = snap.roi_enabled;

            if (snap.roi_enabled) {
                snap.i_start = std::clamp(static_cast<int>(std::floor((snap.roi_xmin - snap.xmin) / snap.cellSize)), 0, snap.nx - 1);
                snap.i_end   = std::clamp(static_cast<int>(std::ceil((snap.roi_xmax - snap.xmin) / snap.cellSize)), snap.i_start + 1, snap.nx);
                snap.j_start = std::clamp(static_cast<int>(std::floor((snap.roi_ymin - snap.ymin) / snap.cellSize)), 0, snap.ny - 1);
                snap.j_end   = std::clamp(static_cast<int>(std::ceil((snap.roi_ymax - snap.ymin) / snap.cellSize)), snap.j_start + 1, snap.ny);
                snap.k_start = std::clamp(static_cast<int>(std::floor((snap.roi_zmin - snap.zmin) / snap.cellSize)), 0, snap.nz - 1);
                snap.k_end   = std::clamp(static_cast<int>(std::ceil((snap.roi_zmax - snap.zmin) / snap.cellSize)), snap.k_start + 1, snap.nz);

                snap.nx_sub = (snap.i_end - snap.i_start + snap.stride - 1) / snap.stride;
                snap.ny_sub = (snap.j_end - snap.j_start + snap.stride - 1) / snap.stride;
                snap.nz_sub = (snap.k_end - snap.k_start + snap.stride - 1) / snap.stride;

                vol_query.roi_i_start = snap.i_start; vol_query.roi_i_end = snap.i_end;
                vol_query.roi_j_start = snap.j_start; vol_query.roi_j_end = snap.j_end;
                vol_query.roi_k_start = snap.k_start; vol_query.roi_k_end = snap.k_end;
            }

            if (has_rho) { vol_query.quantities = { "density" }; snap.rho = global_solver_3d->extractSlice(vol_query); }
            if (has_p) { vol_query.quantities = { "pressure" }; snap.p = global_solver_3d->extractSlice(vol_query); }
            if (has_vel) { vol_query.quantities = { "velocity" }; snap.vel = global_solver_3d->extractSlice(vol_query); }
            if (has_E) { vol_query.quantities = { "energy" }; snap.E = global_solver_3d->extractSlice(vol_query); }
            if (has_reacted) { vol_query.quantities = { "species1" }; snap.reacted = global_solver_3d->extractSlice(vol_query); }
            if (has_unreacted) { vol_query.quantities = { "species2" }; snap.unreacted = global_solver_3d->extractSlice(vol_query); }
            if (has_air) { vol_query.quantities = { "species3" }; snap.air = global_solver_3d->extractSlice(vol_query); }
            if (snap.has_solid) { vol_query.quantities = { "solid" }; snap.solid = global_solver_3d->extractSlice(vol_query); }
            if (has_materials) { vol_query.quantities = { "materials" }; snap.materials = global_solver_3d->extractSlice(vol_query); }
            if (has_water) { vol_query.quantities = { "water" }; snap.water = global_solver_3d->extractSlice(vol_query); }
            if (has_soil) { vol_query.quantities = { "soil" }; snap.soil = global_solver_3d->extractSlice(vol_query); }
            if (has_overpressure) { vol_query.quantities = { "overpressure" }; snap.overpressure = global_solver_3d->extractSlice(vol_query); }
            if (has_impulse) { vol_query.quantities = { "impulse" }; snap.impulse = global_solver_3d->extractSlice(vol_query); }
            snap.has_temp = has_temp;
            snap.has_afterburn_rate = has_ab_rate;
            snap.has_fuel_density = has_fuel_rho;
            if (has_temp) { vol_query.quantities = { "temperature" }; snap.temp = global_solver_3d->extractSlice(vol_query); }
            if (has_ab_rate) { vol_query.quantities = { "afterburn_rate" }; snap.afterburn_rate = global_solver_3d->extractSlice(vol_query); }
            if (has_fuel_rho) { vol_query.quantities = { "fuel_density" }; snap.fuel_density = global_solver_3d->extractSlice(vol_query); }

            Blast::AsyncVTKWriter::getInstance().enqueue([filename, snap = std::move(snap), format, export_pvd, pvd_filename, time, rel_filename]() {
                export_vtu_volume_3d_snapshot(filename, snap, format);
                if (export_pvd) {
                    append_pvd_timestep(pvd_filename, time, rel_filename);
                }
            });
        }

        // 1C. Obstacle Surfaces (STL / CSG Primitives)
        if (global_vtk_config.export_obstacles && !global_obstacle_faces.empty()) {
            std::string rel_filename = global_vtk_config.custom_filename + "_obstacles_" + tag + ".vtu";
            std::string filename = out_dir + "/" + rel_filename;
            std::string pvd_filename = out_dir + "/" + global_vtk_config.custom_filename + "_obstacles.pvd";
            bool export_pvd = global_vtk_config.export_pvd;
            std::string format = global_vtk_config.vtk_format;

            ObstacleSurfaceSnapshot3D snap;
            snap.num_faces = static_cast<int>(global_obstacle_faces.size());
            snap.num_points = snap.num_faces * 4;
            snap.points.resize(snap.num_points * 3);
            snap.connectivity.resize(snap.num_faces * 4);
            snap.offsets.resize(snap.num_faces);
            snap.types.resize(snap.num_faces, 9); // VTK_QUAD

            snap.has_p = global_vtk_config.qty_pressure;
            snap.has_rho = global_vtk_config.qty_density;
            snap.has_overpressure = global_vtk_config.qty_overpressure;
            snap.has_impulse = global_vtk_config.qty_impulse;

            Slice3D obs_query;
            obs_query.axis = "obstacles";
            if (snap.has_p) { obs_query.quantities = { "pressure" }; snap.p = global_solver_3d->extractSlice(obs_query); }
            if (snap.has_rho) { obs_query.quantities = { "density" }; snap.rho = global_solver_3d->extractSlice(obs_query); }
            if (snap.has_overpressure) { obs_query.quantities = { "overpressure" }; snap.overpressure = global_solver_3d->extractSlice(obs_query); }
            if (snap.has_impulse) { obs_query.quantities = { "impulse" }; snap.impulse = global_solver_3d->extractSlice(obs_query); }

#ifdef _OPENMP
            #pragma omp parallel for schedule(static)
#endif
            for (int f = 0; f < snap.num_faces; ++f) {
                const auto& face = global_obstacle_faces[f];
                int pt_base = f * 12;
                int conn_base = f * 4;
                for (int v = 0; v < 4; ++v) {
                    snap.points[pt_base + v * 3 + 0] = face.px[v];
                    snap.points[pt_base + v * 3 + 1] = face.py[v];
                    snap.points[pt_base + v * 3 + 2] = face.pz[v];
                    snap.connectivity[conn_base + v] = conn_base + v;
                }
                snap.offsets[f] = (f + 1) * 4;
            }

            Blast::AsyncVTKWriter::getInstance().enqueue([filename, snap = std::move(snap), format, export_pvd, pvd_filename, time, rel_filename]() {
                export_vtu_obstacle_surface_snapshot(filename, snap, format);
                if (export_pvd) {
                    append_pvd_timestep(pvd_filename, time, rel_filename);
                }
            });
        }

        // 1D. True CAD STL Faces (Mapped CFD Results)
        if (global_vtk_config.export_stl_faces && !active_stl_triangles.empty()) {
            std::string rel_filename = global_vtk_config.custom_filename + "_stl_faces_" + tag + ".vtu";
            std::string filename = out_dir + "/" + rel_filename;
            std::string pvd_filename = out_dir + "/" + global_vtk_config.custom_filename + "_stl_faces.pvd";
            bool export_pvd = global_vtk_config.export_pvd;
            std::string format = global_vtk_config.vtk_format;

            double cs = global_solver_3d->getCellSize();
            double xmin = global_solver_3d->getXMin();
            double ymin = global_solver_3d->getYMin();
            double zmin = global_solver_3d->getZMin();
            int nx = global_solver_3d->getNx();
            int ny = global_solver_3d->getNy();
            int nz = global_solver_3d->getNz();

            double xmax = xmin + nx * cs;
            double ymax = ymin + ny * cs;
            double zmax = zmin + nz * cs;

            double dom_xmin = (global_vtk_config.roi_enabled) ? std::max(xmin, global_vtk_config.roi_xmin) : xmin;
            double dom_xmax = (global_vtk_config.roi_enabled) ? std::min(xmax, global_vtk_config.roi_xmax) : xmax;
            double dom_ymin = (global_vtk_config.roi_enabled) ? std::max(ymin, global_vtk_config.roi_ymin) : ymin;
            double dom_ymax = (global_vtk_config.roi_enabled) ? std::min(ymax, global_vtk_config.roi_ymax) : ymax;
            double dom_zmin = (global_vtk_config.roi_enabled) ? std::max(zmin, global_vtk_config.roi_zmin) : zmin;
            double dom_zmax = (global_vtk_config.roi_enabled) ? std::min(zmax, global_vtk_config.roi_zmax) : zmax;

            const double tol = 1e-4 * cs;
            std::string out_mode = global_vtk_config.stl_outside_domain;
            std::transform(out_mode.begin(), out_mode.end(), out_mode.begin(), ::tolower);
            bool mode_omit = (out_mode.find("omit") != std::string::npos);
            bool mode_zero = (out_mode.find("zero") != std::string::npos || out_mode == "0");
            float outside_p = mode_zero ? 0.0f : std::numeric_limits<float>::quiet_NaN();

            std::vector<int> kept_indices;
            int export_num_faces = static_cast<int>(active_stl_triangles.size());
            if (mode_omit) {
                kept_indices.reserve(active_stl_triangles.size());
                for (int f = 0; f < static_cast<int>(active_stl_triangles.size()); ++f) {
                    const auto& tri = active_stl_triangles[f];
                    bool tri_outside = (std::max({tri.v0.x, tri.v1.x, tri.v2.x}) < dom_xmin - tol ||
                                        std::min({tri.v0.x, tri.v1.x, tri.v2.x}) > dom_xmax + tol ||
                                        std::max({tri.v0.y, tri.v1.y, tri.v2.y}) < dom_ymin - tol ||
                                        std::min({tri.v0.y, tri.v1.y, tri.v2.y}) > dom_ymax + tol ||
                                        std::max({tri.v0.z, tri.v1.z, tri.v2.z}) < dom_zmin - tol ||
                                        std::min({tri.v0.z, tri.v1.z, tri.v2.z}) > dom_zmax + tol);
                    if (!tri_outside) {
                        kept_indices.push_back(f);
                    }
                }
                export_num_faces = static_cast<int>(kept_indices.size());
            }

            if (export_num_faces > 0) {
                STLFacesSnapshot3D snap;
                snap.num_faces = export_num_faces;
                snap.num_points = snap.num_faces * 3;
                snap.points.resize(snap.num_points * 3);
                snap.connectivity.resize(snap.num_points);
                snap.offsets.resize(snap.num_faces);
                snap.types.resize(snap.num_faces, 5); // VTK_TRIANGLE = 5

                snap.has_p = global_vtk_config.qty_pressure;
                snap.has_rho = global_vtk_config.qty_density;
                snap.has_overpressure = global_vtk_config.qty_overpressure;
                snap.has_impulse = global_vtk_config.qty_impulse;

                std::vector<Point3D> sample_pts(snap.num_points);

#ifdef _OPENMP
                #pragma omp parallel for schedule(static)
#endif
                for (int f = 0; f < snap.num_faces; ++f) {
                    int tri_idx = mode_omit ? kept_indices[f] : f;
                    const auto& tri = active_stl_triangles[tri_idx];
                    Point3D pts[3] = { tri.v0, tri.v1, tri.v2 };
                    int pt_base = f * 9;
                    int conn_base = f * 3;
                    snap.offsets[f] = (f + 1) * 3;

                    double nx_ = tri.normal.x, ny_ = tri.normal.y, nz_ = tri.normal.z;
                    double nlen = std::sqrt(nx_*nx_ + ny_*ny_ + nz_*nz_);
                    if (nlen < 1e-6) {
                        double ex1 = tri.v1.x - tri.v0.x, ey1 = tri.v1.y - tri.v0.y, ez1 = tri.v1.z - tri.v0.z;
                        double ex2 = tri.v2.x - tri.v0.x, ey2 = tri.v2.y - tri.v0.y, ez2 = tri.v2.z - tri.v0.z;
                        nx_ = ey1 * ez2 - ez1 * ey2;
                        ny_ = ez1 * ex2 - ex1 * ez2;
                        nz_ = ex1 * ey2 - ey1 * ex2;
                        nlen = std::sqrt(nx_*nx_ + ny_*ny_ + nz_*nz_);
                        if (nlen < 1e-12) { nx_ = 0.0; ny_ = 0.0; nz_ = 1.0; }
                        else { nx_ /= nlen; ny_ /= nlen; nz_ /= nlen; }
                    } else {
                        nx_ /= nlen; ny_ /= nlen; nz_ /= nlen;
                    }

                    for (int v = 0; v < 3; ++v) {
                        int v_idx = conn_base + v;
                        snap.points[pt_base + v * 3 + 0] = pts[v].x;
                        snap.points[pt_base + v * 3 + 1] = pts[v].y;
                        snap.points[pt_base + v * 3 + 2] = pts[v].z;
                        snap.connectivity[v_idx] = v_idx;

                        sample_pts[v_idx] = Point3D{
                            static_cast<float>(pts[v].x + 0.8 * cs * nx_),
                            static_cast<float>(pts[v].y + 0.8 * cs * ny_),
                            static_cast<float>(pts[v].z + 0.8 * cs * nz_)
                        };
                    }
                }

                std::vector<std::string> req_qtys;
                if (snap.has_p) req_qtys.push_back("pressure");
                if (snap.has_rho) req_qtys.push_back("density");
                if (snap.has_overpressure) req_qtys.push_back("overpressure");
                if (snap.has_impulse) req_qtys.push_back("impulse");

                std::vector<std::vector<float>> sampled_data;
                global_solver_3d->sampleSurfacePoints(
                    sample_pts, req_qtys,
                    dom_xmin, dom_xmax, dom_ymin, dom_ymax, dom_zmin, dom_zmax,
                    outside_p, sampled_data
                );

                size_t q_idx = 0;
                if (snap.has_p) snap.p = std::move(sampled_data[q_idx++]);
                if (snap.has_rho) snap.rho = std::move(sampled_data[q_idx++]);
                if (snap.has_overpressure) snap.overpressure = std::move(sampled_data[q_idx++]);
                if (snap.has_impulse) snap.impulse = std::move(sampled_data[q_idx++]);

                Blast::AsyncVTKWriter::getInstance().enqueue([filename, snap = std::move(snap), format, export_pvd, pvd_filename, time, rel_filename]() {
                    export_vtu_stl_faces_snapshot(filename, snap, format);
                    if (export_pvd) {
                        append_pvd_timestep(pvd_filename, time, rel_filename);
                    }
                });
            }
        }
    }

    // 2. FEM 3D Solid Domain
    if (global_vtk_config.export_fem) {
        auto export_fem_instance = [&](const std::string& key, auto* fem_ptr) {
            if (!fem_ptr || (fem_ptr->getElements().empty() && fem_ptr->getTrusses().empty() && fem_ptr->getBeams().empty())) return;
            std::string rel_filename = global_vtk_config.custom_filename + "_fem_" + key + "_" + tag + ".vtu";
            std::string filename = out_dir + "/" + rel_filename;
            std::string pvd_filename = out_dir + "/" + global_vtk_config.custom_filename + "_fem_" + key + ".pvd";
            bool export_pvd = global_vtk_config.export_pvd;
            std::string format = global_vtk_config.vtk_format;
            auto vtk_cfg = global_vtk_config;

            auto fem_snap = std::make_shared<std::decay_t<decltype(*fem_ptr)>>(*fem_ptr);

            Blast::AsyncVTKWriter::getInstance().enqueue([filename, fem_snap, format, vtk_cfg, export_pvd, pvd_filename, time, rel_filename]() {
                export_vtu_fem_3d(filename, *fem_snap, format,
                                  vtk_cfg.qty_fem_stress, vtk_cfg.qty_fem_strain,
                                  vtk_cfg.qty_fem_pressure, vtk_cfg.qty_fem_temp,
                                  vtk_cfg.qty_fem_damage, vtk_cfg.qty_fem_vel,
                                  vtk_cfg.qty_fem_disp);
                if (export_pvd) {
                    append_pvd_timestep(pvd_filename, time, rel_filename);
                }
            });
        };

        for (const auto& [k, v] : global_fem_solvers_cuda_float) {
            if (v) {
                v->syncToHost();
                export_fem_instance(k, &(v->getCpuSolver()));
            }
        }
        for (const auto& [k, v] : global_fem_solvers_cuda_double) {
            if (v) {
                v->syncToHost();
                export_fem_instance(k, &(v->getCpuSolver()));
            }
        }
        for (const auto& [k, v] : global_fem_solvers_float) {
            if (v) export_fem_instance(k, v.get());
        }
        for (const auto& [k, v] : global_fem_solvers_double) {
            if (v) export_fem_instance(k, v.get());
        }
    }

    // 3. MPM 3D Particle & Debris Domain
    if (global_vtk_config.export_mpm) {
        auto enqueue_mpm_snap = [&](MPMVTKSnapshot3D snap) {
            if (snap.num_particles <= 0) return;
            snap.has_material_id = global_vtk_config.qty_mpm_material_id;
            snap.has_pressure = global_vtk_config.qty_mpm_pressure;
            snap.has_object_id = global_vtk_config.qty_mpm_object_id;
            snap.has_particle_density = global_vtk_config.qty_mpm_particle_density;
            snap.compression_level = global_vtk_config.compression_level;
            snap.float_precision = global_vtk_config.float_precision;
            snap.mpm_topology = global_vtk_config.mpm_topology;

            bool export_pvd = global_vtk_config.export_pvd;
            std::string format = global_vtk_config.vtk_format;

            if (format == "XDMF + HDF5") {
                std::string rel_h5_filename = global_vtk_config.custom_filename + "_mpm_" + tag + ".h5";
                std::string h5_filename = out_dir + "/" + rel_h5_filename;
                std::string step_xdmf_filename = out_dir + "/" + global_vtk_config.custom_filename + "_mpm_" + tag + ".xdmf";
                std::string master_xdmf_filename = out_dir + "/" + global_vtk_config.custom_filename + "_mpm.xdmf";

                Blast::AsyncVTKWriter::getInstance().enqueue([h5_filename, step_xdmf_filename, master_xdmf_filename, rel_h5_filename, snap = std::move(snap), export_pvd, step, time]() mutable {
                    apply_mpm_bit_grooming(snap);
                    if (HDF5Writer::writeMPMSnapshot3D(h5_filename, snap)) {
                        XDMFWriter::writeMPMStepXDMF3D(step_xdmf_filename, rel_h5_filename, step, time, snap);
                        if (export_pvd) {
                            XDMFWriter::appendMPMTimestep3D(master_xdmf_filename, rel_h5_filename, step, time, snap, step == 0);
                        }
                    }
                });
            } else {
                std::string rel_filename = global_vtk_config.custom_filename + "_mpm_" + tag + ".vtu";
                std::string filename = out_dir + "/" + rel_filename;
                std::string pvd_filename = out_dir + "/" + global_vtk_config.custom_filename + "_mpm.pvd";

                Blast::AsyncVTKWriter::getInstance().enqueue([filename, snap = std::move(snap), format, export_pvd, pvd_filename, time, rel_filename]() mutable {
                    if (format != "ASCII") {
                        apply_mpm_bit_grooming(snap);
                    }
                    export_vtu_mpm_3d_snapshot(filename, snap, format);
                    if (export_pvd) {
                        append_pvd_timestep(pvd_filename, time, rel_filename);
                    }
                });
            }
        };

        if (global_solver_mpm_3d_cuda) {
            enqueue_mpm_snap(global_solver_mpm_3d_cuda->extractVTKSnapshot(
                global_vtk_config.qty_mpm_vel,
                global_vtk_config.qty_mpm_stress,
                global_vtk_config.qty_mpm_strain,
                global_vtk_config.qty_mpm_damage,
                global_vtk_config.qty_mpm_temp,
                global_vtk_config.qty_mpm_pressure,
                global_vtk_config.qty_mpm_material_id,
                global_vtk_config.qty_mpm_object_id,
                global_vtk_config.qty_mpm_particle_density
            ));
        } else if (global_solver_mpm_3d) {
            enqueue_mpm_snap(global_solver_mpm_3d->extractVTKSnapshot(
                global_vtk_config.qty_mpm_vel,
                global_vtk_config.qty_mpm_stress,
                global_vtk_config.qty_mpm_strain,
                global_vtk_config.qty_mpm_damage,
                global_vtk_config.qty_mpm_temp,
                global_vtk_config.qty_mpm_pressure,
                global_vtk_config.qty_mpm_material_id,
                global_vtk_config.qty_mpm_object_id,
                global_vtk_config.qty_mpm_particle_density
            ));
        }
    }

    // 3B. Phase Tracking Particles (LPTP)
    if (global_phase_particles_3d && global_phase_particles_3d->getParticleCount() > 0) {
        if (global_phase_particles_3d->isCUDA()) {
            global_phase_particles_3d->syncToHost();
        }
        Blast::PhaseTrackingVTKSnapshot3D snap;
        global_phase_particles_3d->extractVTKSnapshot(snap);
        std::string rel_filename = global_vtk_config.custom_filename + "_phase_particles_" + tag + ".vtu";
        std::string filename = out_dir + "/" + rel_filename;
        std::string pvd_filename = out_dir + "/" + global_vtk_config.custom_filename + "_phase_particles.pvd";
        bool export_pvd = global_vtk_config.export_pvd;
        std::string format = global_vtk_config.vtk_format;

        Blast::AsyncVTKWriter::getInstance().enqueue([filename, snap = std::move(snap), format, export_pvd, pvd_filename, time, rel_filename]() {
            export_vtu_phase_particles_3d_snapshot(filename, snap, format);
            if (export_pvd) {
                append_pvd_timestep(pvd_filename, time, rel_filename);
            }
        });
    }

    // 4. 2D Domain
    if (global_vtk_config.export_cfd_2d && (global_solver_2d_cuda || global_solver_2d)) {
        std::string rel_filename = global_vtk_config.custom_filename + "_" + tag + ".vtu";
        std::string filename = out_dir + "/" + rel_filename;
        std::string pvd_filename = out_dir + "/" + global_vtk_config.custom_filename + "_cfd_2d.pvd";
        if (global_solver_2d_cuda) {
            global_solver_2d_cuda->exportVTK(filename);
        } else if (global_solver_2d) {
            global_solver_2d->exportVTK(filename);
        }
        if (global_vtk_config.export_pvd) {
            append_pvd_timestep(pvd_filename, time, rel_filename);
        }
    }

    auto vtk_end = std::chrono::steady_clock::now();
    double vtk_ms = std::chrono::duration<double, std::milli>(vtk_end - vtk_start).count();
    global_last_vtk_ms = vtk_ms;
    global_last_vtk_step = step;
}
