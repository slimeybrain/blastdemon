#pragma once

#include <string>
#include <vector>
#include <memory>
#include <atomic>
#include <mutex>
#include <unordered_map>
#include <nlohmann/json.hpp>

#include "cfd_solver.hpp"
#include "cfd_solver_2d.hpp"
#include "cfd_solver_2d_cuda.hpp"
#include "cfd_solver_3d.hpp"
#include "cfd_solver_3d_cuda.hpp"
#include "mpm_solver_2d.hpp"
#include "mpm_solver_3d.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include "fem_solver_3d.hpp"
#include "fem_solver_3d_cuda.hpp"
#include "fem_fsi_coupler_3d.hpp"
#include "fem_fsi_coupler_3d_cuda.hpp"
#include "fsi_coupler_3d.hpp"
#include "coupling/DynamicHybridCoupler3D.hpp"
#include "PhaseTrackingParticles3D.hpp"

#if defined(__has_include)
  #if __has_include(<cuda_runtime.h>)
    #include <cuda_runtime.h>
  #endif
#endif

// CUDA device helpers
void select_cuda_device(const std::string& device);
bool is_cuda_device(const std::string& device);

// Path and JSON helpers
std::string get_absolute_path(const std::string& path, const std::string& base_dir);
int get_json_int(const nlohmann::json& j, const std::string& key, int default_val);
double get_json_double(const nlohmann::json& j, const std::string& key, double default_val);
bool get_json_bool(const nlohmann::json& j, const std::string& key, bool default_val);
size_t estimateMPMTotalParticles(const nlohmann::json& msg, float dx, float dy, float dz);

// Worker thread forward declarations
void worker_3d_thread_func();

// Execution control flags
extern std::atomic<bool> sim_running;
extern std::atomic<bool> sim_paused;
extern std::atomic<bool> sim_terminate;
extern std::atomic<int> step_progress;

extern std::atomic<bool> sim2d_running;
extern std::atomic<bool> sim2d_paused;
extern std::atomic<bool> sim2d_terminate;
extern std::atomic<bool> solver2d_initialized;
extern std::atomic<int> step_progress_2d;

extern std::atomic<bool> sim3d_running;
extern std::atomic<bool> sim3d_paused;
extern std::atomic<bool> sim3d_terminate;
extern std::atomic<bool> sim3d_init_in_progress;
extern std::atomic<int> step_progress_3d;

extern std::atomic<bool> sim_mpm_running;
extern std::atomic<bool> sim_mpm_3d_running;
extern std::atomic<bool> sim_mpm_3d_paused;
extern std::atomic<bool> sim_mpm_3d_terminate;

extern std::atomic<bool> sim_fem_3d_running;
extern std::atomic<bool> sim_fem_3d_paused;
extern std::atomic<bool> sim_fem_3d_terminate;

extern std::atomic<bool> sim_fsi_running;
extern std::atomic<bool> sim_fsi_3d_running;
extern std::atomic<bool> sim_fem_fsi_3d_running;

// General Model and Hardware Identifiers
extern size_t global_last_valid_nvml_vram;
extern int global_cuda_device_index;
extern std::string global_model_id;
extern std::string global_model_filename;
extern std::mutex cout_mutex;

// 1D CFD State
extern std::atomic<int> global_num_cells;
extern std::atomic<int> global_target_steps;
extern std::atomic<bool> global_exec_until_end;
extern std::atomic<double> global_cfl;
extern std::atomic<double> global_endtime;
extern std::atomic<double> global_wallclock_1d;
extern std::unique_ptr<CFDSolver> global_solver;
extern double global_t;
extern double global_dt_1d;

// 2D CFD State
extern std::atomic<int> global_target_steps_2d;
extern std::atomic<bool> global_exec_until_end_2d;
extern std::atomic<double> global_cfl_2d;
extern std::atomic<double> global_endtime_2d;
extern std::atomic<double> global_wallclock_2d;
extern std::unique_ptr<CFDSolver2D> global_solver_2d;
extern std::unique_ptr<CFDSolver2DCuda> global_solver_2d_cuda;
extern double global_t2d;
extern double global_dt_2d;
extern std::atomic<bool> global_is_amr_2d;
bool has_solver_2d();

// 3D CFD State
extern std::unique_ptr<CFDSolver3D> global_solver_3d;
extern std::unique_ptr<Blast::PhaseTrackingParticles3D> global_phase_particles_3d;
extern std::vector<Slice3D> global_slices_3d;
extern std::vector<ObstacleFace> global_obstacle_faces;
extern std::vector<Triangle> global_raw_stl_triangles;
extern std::vector<Triangle> global_tessellated_stl_triangles;
extern double global_t3d;
extern double global_dt_3d;
extern std::atomic<int> global_target_steps_3d;
extern std::atomic<bool> global_exec_until_end_3d;
extern std::atomic<double> global_cfl_3d;
extern std::atomic<double> global_endtime_3d;
extern std::atomic<double> global_wallclock_3d;
extern Blast::Stratified3DParams g_strat_fsi_params;
extern std::atomic<bool> g_is_stratified_fsi;

// 2D & 3D MPM State
extern std::unique_ptr<Blast::MPMSolver2D> global_solver_mpm_2d;
extern std::unique_ptr<Blast::MPMSolver3D> global_solver_mpm_3d;
extern std::unique_ptr<Blast::MPMSolver3DCUDA> global_solver_mpm_3d_cuda;
extern std::atomic<bool> global_exec_until_end_mpm_3d;
extern std::atomic<int> global_target_steps_mpm_3d;
extern std::atomic<float> global_cfl_mpm_3d;
extern std::atomic<double> global_endtime_mpm_3d;
extern std::atomic<double> global_refresh_rate_mpm_3d;

// 3D FEM State
extern std::unordered_map<std::string, std::unique_ptr<Blast::FEMSolver3D<float>>> global_fem_solvers_float;
extern std::unordered_map<std::string, std::unique_ptr<Blast::FEMSolver3D<double>>> global_fem_solvers_double;
extern std::unordered_map<std::string, std::unique_ptr<Blast::FEMSolver3DCUDA<float>>> global_fem_solvers_cuda_float;
extern std::unordered_map<std::string, std::unique_ptr<Blast::FEMSolver3DCUDA<double>>> global_fem_solvers_cuda_double;
extern std::atomic<bool> global_exec_until_end_fem_3d;
extern std::atomic<int> global_target_steps_fem_3d;
extern std::atomic<float> global_cfl_fem_3d;
extern std::atomic<double> global_endtime_fem_3d;
extern std::atomic<double> global_refresh_rate_fem_3d;

// FSI State
extern std::unique_ptr<Blast::FSICoupler3D> global_fsi_coupler_3d;
extern std::unique_ptr<Blast::DynamicHybridCoupler3D> global_hybrid_coupler_3d;
extern std::unordered_map<std::string, std::unique_ptr<Blast::FEMFSICoupler3D<float>>> global_fem_fsi_couplers_float;
extern std::unordered_map<std::string, std::unique_ptr<Blast::FEMFSICoupler3D<double>>> global_fem_fsi_couplers_double;
extern std::unordered_map<std::string, std::unique_ptr<Blast::FEMFSICoupler3DCUDA<float>>> global_fem_fsi_couplers_cuda_float;
extern std::unordered_map<std::string, std::unique_ptr<Blast::FEMFSICoupler3DCUDA<double>>> global_fem_fsi_couplers_cuda_double;

// Telemetry & Timing Metrics
extern std::atomic<int> global_telemetry_stride;
extern std::atomic<int> global_mpm_particle_stride;
extern std::atomic<int> global_telemetry_interval_ms;
extern std::atomic<bool> global_telemetry_enabled;
extern std::atomic<double> global_last_compute_ms;
extern std::atomic<double> global_last_io_ms;
extern std::atomic<double> global_last_comms_ms;
extern std::atomic<double> global_cum_compute_s;
extern std::atomic<double> global_cum_io_s;
extern std::atomic<double> global_cum_comms_s;
extern std::atomic<double> global_last_vtk_ms;
extern std::atomic<int> global_last_vtk_step;
extern std::atomic<bool> global_enable_gauges;
extern std::atomic<bool> global_enable_vtk;

// Step counters
extern std::atomic<int> global_step_1d;
extern std::atomic<int> global_step_2d;
extern std::atomic<int> global_step_3d;
extern std::atomic<int> global_step_fsi_2d;
extern std::atomic<int> global_step_fsi_3d;
extern std::atomic<int> global_step_fem_fsi_3d;

// VTK last time stamps
extern std::atomic<double> global_last_vtk_time_1d;
extern std::atomic<double> global_last_vtk_time_2d;
extern std::atomic<double> global_last_vtk_time_3d;
extern std::atomic<double> global_last_vtk_time_fsi_2d;
extern std::atomic<double> global_last_vtk_time_fsi_3d;
extern std::atomic<double> global_last_vtk_time_fem_fsi_3d;
extern std::atomic<double> global_last_vtk_time_mpm_3d;
extern std::atomic<double> global_last_vtk_time_fem_3d;

void reset_timing_metrics();
