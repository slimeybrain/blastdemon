#pragma once

#include <string>
#include <atomic>
#include <nlohmann/json.hpp>

struct VTKOutputConfig {
    std::string trigger_type = "Step Interval";
    std::string vtk_dir = "";
    bool export_slices = true;
    bool export_volumes = false;
    bool export_fem = true;
    bool export_mpm = true;
    bool export_mpm_density_grid = false;
    bool export_obstacles = true;
    bool export_stl_faces = true;
    std::string stl_outside_domain = "nan";
    bool tessellate_stl_faces = false;
    double tessellation_max_edge = 0.0;
    bool export_cfd_2d = true;
    bool export_pvd = true;
    std::string custom_filename = "vtk_output";
    int step_interval = 10;
    double time_interval = 0.0001;
    std::string vtk_format = "Binary";
    int compression_level = 6;
    std::string float_precision = "12-bit Mantissa (~4 sig. digits)";
    std::string mpm_topology = "Individual Vertices";
    // FV CFD Quantities
    bool qty_pressure = true;
    bool qty_density = true;
    bool qty_velocity = true;
    bool qty_energy = true;
    bool qty_reacted = true;
    bool qty_unreacted = true;
    bool qty_air = true;
    bool qty_materials = true;
    bool qty_water = true;
    bool qty_soil = true;
    bool qty_overpressure = true;
    bool qty_impulse = true;
    bool qty_temperature = true;
    bool qty_afterburn_rate = true;
    bool qty_fuel_density = true;
    // Solid FEM Quantities
    bool qty_fem_stress = true;
    bool qty_fem_strain = true;
    bool qty_fem_pressure = true;
    bool qty_fem_temp = true;
    bool qty_fem_damage = true;
    bool qty_fem_vel = true;
    bool qty_fem_disp = true;
    // Solid MPM Quantities
    bool qty_mpm_stress = true;
    bool qty_mpm_strain = true;
    bool qty_mpm_damage = true;
    bool qty_mpm_temp = true;
    bool qty_mpm_vel = true;
    bool qty_mpm_disp = true;
    bool qty_mpm_pressure = true;
    bool qty_mpm_material_id = true;
    bool qty_mpm_object_id = true;
    bool qty_mpm_particle_density = true;
    // Spatial ROI & Strides
    bool roi_enabled = false;
    double roi_xmin = 0.0;
    double roi_xmax = 1.0;
    double roi_ymin = 0.0;
    double roi_ymax = 1.0;
    double roi_zmin = 0.0;
    double roi_zmax = 1.0;
    int volume_stride = 1;
    int slice_stride = 1;
};

extern VTKOutputConfig global_vtk_config;

bool should_write_vtk(int step_count, double sim_time, double last_vtk_time);
void update_last_vtk_time(std::atomic<double>& last_vtk_time_atomic, double current_time);
bool should_write_final_vtk(double final_time, double last_time);
std::string get_vtk_frame_tag(int step, double time);
void parse_vtk_config(const nlohmann::json& msg);
void write_vtk_outputs(int step, double time);
