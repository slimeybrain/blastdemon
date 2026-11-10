#pragma once

#include <string>
#include "cfd_solver.hpp"

// Logging and Resource Monitoring
void emit_kernel_log(const std::string& level, const std::string& msg, double t, const std::string& scope = "1d", int step = -1);
void emit_resource_pulse();

// Telemetry Streaming
void emit_telemetry(const CFDSolver& solver, double elapsed, bool is_terminated = false, int step = -1);
void emit_telemetry_2d(double elapsed, bool is_terminated = false, int step = -1);
void emit_telemetry_3d(double elapsed, bool is_terminated = false, int step = -1);
void emit_telemetry_mpm_2d(double elapsed = 0.0, bool is_terminated = false, int step = -1);
void emit_telemetry_mpm_3d(double elapsed, bool is_terminated = false, int step = -1, bool include_particles = true);
void emit_telemetry_fem_3d(double elapsed = 0.0, bool is_terminated = false, int step = -1);

// Async Telemetry Thread Lifecycle
void async_telemetry_thread_func();
void flush_async_telemetry();
void stop_async_telemetry();
