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

#include <nlohmann/json.hpp>
#include "cfd_solver.hpp"
#include "cfd_solver_2d.hpp"
#include "cfd_solver_2d_cuda.hpp"
#include "cfd_solver_3d.hpp"
#include "cfd_solver_3d_cuda.hpp"
#include "HDF5Writer.hpp"
#include "XDMFWriter.hpp"


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

// 3D State
std::atomic<bool> sim3d_running{false};
std::atomic<bool> sim3d_paused{false};
std::atomic<bool> sim3d_terminate{false};
std::unique_ptr<CFDSolver3D> global_solver_3d = nullptr;
std::vector<Slice3D> global_slices_3d;
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
};

struct GaugeHistory {
    std::string id;
    std::vector<std::vector<float>> channel_values; // size 7: [p, rho, u, e_int, alpha1, alpha2, air]
};

std::vector<GaugeDef> global_gauges;
std::vector<double> global_gauge_times;
std::vector<GaugeHistory> global_gauges_history;
std::mutex global_gauges_mutex;

void init_gauges(const nlohmann::json& msg) {
    std::lock_guard<std::mutex> lock(global_gauges_mutex);
    global_gauges.clear();
    global_gauge_times.clear();
    global_gauges_history.clear();
    
    if (msg.contains("nodes")) {
        for (const auto& node : msg["nodes"]) {
            if (node.value("type", "") == "VirtualGauges") {
                if (node.contains("parameters") && node["parameters"].contains("gauges")) {
                    for (const auto& gauge : node["parameters"]["gauges"]) {
                        GaugeDef g;
                        g.id = gauge.value("id", "");
                        g.r = gauge.value("r", 0.0);
                        g.z = gauge.value("z", 0.0);
                        global_gauges.push_back(g);
                        
                        GaugeHistory h;
                        h.id = g.id;
                        h.channel_values.resize(7);
                        global_gauges_history.push_back(h);
                    }
                }
            }
        }
    }
}

void record_gauges_1d(double t) {
    std::lock_guard<std::mutex> lock(global_gauges_mutex);
    if (global_gauges.empty() || !global_solver) return;
    int n_cells = global_solver->getNumCells();
    double radius = global_solver->getRadius();
    double dx = radius / n_cells;
    
    global_gauge_times.push_back(t);
    for (size_t g_idx = 0; g_idx < global_gauges.size(); ++g_idx) {
        const auto& g = global_gauges[g_idx];
        int i = std::clamp(static_cast<int>(g.r / dx), 0, n_cells - 1);
        auto vals = global_solver->getCellValues(i);
        for (int ch = 0; ch < 7; ++ch) {
            global_gauges_history[g_idx].channel_values[ch].push_back(vals[ch]);
        }
    }
}

void record_gauges_2d(double t) {
    std::lock_guard<std::mutex> lock(global_gauges_mutex);
    if (global_gauges.empty()) return;
    
    int nr = 0, nz = 0;
    double dr = 0.0, dz = 0.0;
    if (global_solver_2d_cuda) {
        nr = global_solver_2d_cuda->getNr();
        nz = global_solver_2d_cuda->getNz();
        dr = global_solver_2d_cuda->getDr();
        dz = global_solver_2d_cuda->getDz();
    } else if (global_solver_2d) {
        nr = global_solver_2d->getNr();
        nz = global_solver_2d->getNz();
        dr = global_solver_2d->getDr();
        dz = global_solver_2d->getDz();
    } else {
        return;
    }

    global_gauge_times.push_back(t);
    for (size_t g_idx = 0; g_idx < global_gauges.size(); ++g_idx) {
        const auto& g = global_gauges[g_idx];
        int i = std::clamp(static_cast<int>(g.r / dr), 0, nr - 1);
        int j = std::clamp(static_cast<int>(g.z / dz), 0, nz - 1);
        
        std::vector<float> vals(7, 0.0f);
        if (global_solver_2d_cuda) {
            vals = global_solver_2d_cuda->getCellValues(i, j);
        } else if (global_solver_2d) {
            vals = global_solver_2d->getCellValues(i, j);
        }
        
        for (int ch = 0; ch < 7; ++ch) {
            global_gauges_history[g_idx].channel_values[ch].push_back(vals[ch]);
        }
    }
}

void record_gauges_3d(double t) {
    std::lock_guard<std::mutex> lock(global_gauges_mutex);
    if (global_gauges.empty() || !global_solver_3d) return;

    global_gauge_times.push_back(t);
    for (size_t g_idx = 0; g_idx < global_gauges.size(); ++g_idx) {
        const auto& g = global_gauges[g_idx];
        Gauge3D gauge_def = { g.id, g.r, 0.0, g.z }; // Map 2D r,z to 3D x,z
        auto vals = global_solver_3d->sampleGauge(gauge_def);
        for (int ch = 0; ch < 7; ++ch) {
            global_gauges_history[g_idx].channel_values[ch].push_back(vals[ch]);
        }
    }
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
        global_solver->step(dt);
        auto step_end = std::chrono::steady_clock::now();
        global_wallclock_1d = global_wallclock_1d.load() + std::chrono::duration<double>(step_end - step_start).count();
        global_t += dt;
        record_gauges_1d(global_t);

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
    sim_running = false;
    sim_paused = false;
    sim_terminate = false;
    global_target_steps = 0;
    global_exec_until_end = false;
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

        record_gauges_3d(global_t3d);

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
            double max_s = global_solver_2d_cuda->getMaxWaveSpeed();
            dt = global_cfl_2d.load() * std::min(global_solver_2d_cuda->getDr(), global_solver_2d_cuda->getDz()) / max_s;
            global_solver_2d_cuda->step(dt);
        } else if (global_solver_2d) {
            dt = global_solver_2d->computeStepSize(global_cfl_2d.load());
            global_solver_2d->step(dt);
        }
        auto step_end = std::chrono::steady_clock::now();
        global_wallclock_2d = global_wallclock_2d.load() + std::chrono::duration<double>(step_end - step_start).count();
        global_dt_2d = dt;
        global_t2d += dt;

        record_gauges_2d(global_t2d);

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

typedef void* nvmlDevice_t;

typedef nvmlReturn_t (*nvmlInit_t)();
typedef nvmlReturn_t (*nvmlShutdown_t)();
typedef nvmlReturn_t (*nvmlDeviceGetHandleByIndex_t)(unsigned int index, nvmlDevice_t* device);
typedef nvmlReturn_t (*nvmlDeviceGetUtilizationRates_t)(nvmlDevice_t device, nvmlUtilization_t* rates);
typedef nvmlReturn_t (*nvmlDeviceGetTemperature_t)(nvmlDevice_t device, int sensorType, unsigned int* temp);

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
        if (sim_running || sim2d_running) {
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
    pulse["vram_blastdaemon"] = (global_solver_2d_cuda != nullptr) ? global_solver_2d_cuda->getAllocatedVRAM() : 0;
    pulse["gpu_temp"] = gpu_temp;

    std::cout << pulse.dump() << std::endl;
}


void emit_telemetry(const CFDSolver& solver, double elapsed, bool is_terminated) {
    std::lock_guard<std::mutex> lock(cout_mutex);
    int n = solver.getNumCells();

    nlohmann::json envelope;
    envelope["type"] = "TELEMETRY";
    envelope["time"] = elapsed;
    envelope["is_terminated"] = is_terminated;
    envelope["wallclock"] = global_wallclock_1d.load();

    {
        std::lock_guard<std::mutex> g_lock(global_gauges_mutex);
        if (!global_gauges.empty()) {
            nlohmann::json gh;
            gh["solverTracked"] = true;
            gh["times"] = global_gauge_times;
            nlohmann::json vals_obj = nlohmann::json::object();
            for (const auto& h : global_gauges_history) {
                nlohmann::json ch_arrays = nlohmann::json::array();
                for (int ch = 0; ch < 7; ++ch) {
                    ch_arrays.push_back(h.channel_values[ch]);
                }
                vals_obj[h.id] = ch_arrays;
            }
            gh["values"] = vals_obj;
            envelope["gauges_history"] = gh;
        }
    }

    std::cout << envelope.dump() << std::endl;

    const uint32_t n_cells    = static_cast<uint32_t>(n);
    const uint32_t n_channels = 7;
    std::vector<float> frame = solver.getTelemetryChannels();
    size_t header_bytes  = sizeof(uint32_t) * 2;
    size_t payload_bytes = frame.size() * sizeof(float);
    size_t total_bytes   = header_bytes + payload_bytes;

    std::cout << "BIN_FRAME " << total_bytes << "\n";
    std::cout.write(reinterpret_cast<const char*>(&n_cells),    sizeof(uint32_t));
    std::cout.write(reinterpret_cast<const char*>(&n_channels), sizeof(uint32_t));
    std::cout.write(reinterpret_cast<const char*>(frame.data()), payload_bytes);
    std::cout.flush();
}

void emit_telemetry_2d(double elapsed, bool is_terminated) {
    std::lock_guard<std::mutex> lock(cout_mutex);
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
    int n_channels = 7;

    nlohmann::json envelope;
    envelope["type"] = "TELEMETRY_2D";
    envelope["time"] = elapsed;
    envelope["dt"] = global_dt_2d;
    envelope["is_terminated"] = is_terminated;
    envelope["nr"] = out_nr;
    envelope["nz"] = out_nz;
    envelope["wallclock"] = global_wallclock_2d.load();

    {
        std::lock_guard<std::mutex> g_lock(global_gauges_mutex);
        if (!global_gauges.empty()) {
            nlohmann::json gh;
            gh["solverTracked"] = true;
            gh["times"] = global_gauge_times;
            nlohmann::json vals_obj = nlohmann::json::object();
            for (const auto& h : global_gauges_history) {
                nlohmann::json ch_arrays = nlohmann::json::array();
                for (int ch = 0; ch < 7; ++ch) {
                    ch_arrays.push_back(h.channel_values[ch]);
                }
                vals_obj[h.id] = ch_arrays;
            }
            gh["values"] = vals_obj;
            envelope["gauges_history"] = gh;
        }
    }

    std::cout << envelope.dump() << std::endl;

    const uint32_t out_nr_u = static_cast<uint32_t>(out_nr);
    const uint32_t out_nz_u = static_cast<uint32_t>(out_nz);
    const uint32_t n_channels_u = static_cast<uint32_t>(n_channels);
    size_t header_bytes  = sizeof(uint32_t) * 3;
    size_t payload_bytes = downsampled.size() * sizeof(float);
    size_t total_bytes   = header_bytes + payload_bytes;

    std::cout << "BIN_FRAME_2D " << total_bytes << "\n";
    std::cout.write(reinterpret_cast<const char*>(&out_nr_u),     sizeof(uint32_t));
    std::cout.write(reinterpret_cast<const char*>(&out_nz_u),     sizeof(uint32_t));
    std::cout.write(reinterpret_cast<const char*>(&n_channels_u), sizeof(uint32_t));
    std::cout.write(reinterpret_cast<const char*>(downsampled.data()), payload_bytes);
    std::cout.flush();
}

void emit_telemetry_3d(double elapsed, bool is_terminated) {
    std::lock_guard<std::mutex> lock(cout_mutex);
    if (!global_solver_3d) return;

    nlohmann::json envelope;
    envelope["type"] = "TELEMETRY_3D";
    envelope["time"] = elapsed;
    envelope["dt"] = global_dt_3d;
    envelope["is_terminated"] = is_terminated;
    envelope["wallclock"] = global_wallclock_3d.load();
    envelope["xmin"] = global_solver_3d->getXMin();
    envelope["ymin"] = global_solver_3d->getYMin();
    envelope["zmin"] = global_solver_3d->getZMin();
    envelope["dx"] = global_solver_3d->getCellSize();
    envelope["nx"] = global_solver_3d->getNx();
    envelope["ny"] = global_solver_3d->getNy();
    envelope["nz"] = global_solver_3d->getNz();

    {
        std::lock_guard<std::mutex> g_lock(global_gauges_mutex);
        if (!global_gauges.empty()) {
            nlohmann::json gh;
            gh["solverTracked"] = true;
            gh["times"] = global_gauge_times;
            nlohmann::json vals_obj = nlohmann::json::object();
            for (const auto& h : global_gauges_history) {
                nlohmann::json ch_arrays = nlohmann::json::array();
                for (int ch = 0; ch < 7; ++ch) {
                    ch_arrays.push_back(h.channel_values[ch]);
                }
                vals_obj[h.id] = ch_arrays;
            }
            gh["values"] = vals_obj;
            envelope["gauges_history"] = gh;
        }
    }

    std::cout << envelope.dump() << std::endl;

    // BIN_FRAME_3D_SLICES implementation
    // Format: "SLIC" magic, time, n_slices, [axis, offset, w, h, data...]
    uint32_t magic = 0x43494c53; // "SLIC"
    float time_f = (float)elapsed;
    uint32_t n_slices = global_slices_3d.size();



    std::vector<std::vector<float>> slice_datas;
    size_t total_payload_bytes = 0;
    for (const auto& s : global_slices_3d) {
        auto data = global_solver_3d->extractSlice(s);
        total_payload_bytes += data.size() * sizeof(float);
        slice_datas.push_back(std::move(data));
    }

    size_t header_bytes = 12; // magic (4) + time (4) + n_slices (4)
    size_t slice_header_bytes = n_slices * 16; // (axis, offset, w, h) per slice
    size_t total_bytes = header_bytes + slice_header_bytes + total_payload_bytes;

    std::cout << "BIN_FRAME_3D_SLICES " << total_bytes << "\n";
    std::cout.write(reinterpret_cast<const char*>(&magic), 4);
    std::cout.write(reinterpret_cast<const char*>(&time_f), 4);
    std::cout.write(reinterpret_cast<const char*>(&n_slices), 4);

    for (size_t i = 0; i < n_slices; ++i) {
        const auto& s = global_slices_3d[i];
        const auto& data = slice_datas[i];
        uint32_t axis_id = (s.axis == "xy" ? 0 : (s.axis == "xz" ? 1 : 2));
        float offset = (float)s.offset;
        uint32_t w = 0, h = 0;
        int stride = s.stride > 0 ? s.stride : 1;
        if (axis_id == 0) { w = (global_solver_3d->getNx() + stride - 1) / stride; h = (global_solver_3d->getNy() + stride - 1) / stride; }
        else if (axis_id == 1) { w = (global_solver_3d->getNx() + stride - 1) / stride; h = (global_solver_3d->getNz() + stride - 1) / stride; }
        else { w = (global_solver_3d->getNy() + stride - 1) / stride; h = (global_solver_3d->getNz() + stride - 1) / stride; }

        std::cout.write(reinterpret_cast<const char*>(&axis_id), 4);
        std::cout.write(reinterpret_cast<const char*>(&offset), 4);
        std::cout.write(reinterpret_cast<const char*>(&w), 4);
        std::cout.write(reinterpret_cast<const char*>(&h), 4);
        std::cout.write(reinterpret_cast<const char*>(data.data()), data.size() * sizeof(float));
    }
    std::cout.flush();
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
    return matSet;
}

int main() {
    std::string line;

    std::thread pulse_thread([]() {
        while (true) {
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
            emit_resource_pulse();
        }
    });
    pulse_thread.detach();

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

                    int n_cells = msg.at("n_cells").get<int>();
                    double radius = msg.at("domain_radius").get<double>();
                    double gamma = msg.at("gamma").get<double>();

                    global_num_cells = n_cells;
                    global_t = 0.0;

                    std::string init_mode   = msg.value("init_mode",   "Multi-Material JWL");
                    std::string composition  = msg.value("composition", "TNT");
                    std::string explosive_type = msg.value("explosive_type", "");

                    if (init_mode == "Ideal Gas" || explosive_type == "MaterialIdealGas") {
                        global_solver = std::make_unique<CFDSolverImpl<false>>(n_cells, radius, gamma);
                    } else {
                        global_solver = std::make_unique<CFDSolverImpl<true>>(n_cells, radius, gamma);
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
                    step_progress = 0;
                } else if (command == "INIT_2D") {
                    sim2d_terminate = true;
                    while (sim2d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    sim2d_terminate = false;
                    sim2d_paused = false;
                    step_progress_2d = 0;

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

                    if (device == "cuda") {
                        global_solver_2d.reset();
                        global_solver_2d_cuda = std::make_unique<CFDSolver2DCuda>(nr, nz, max_r, max_z, gamma);
                        
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
                            double ambient_rho = msg.value("ambient_rho", 1.2);
                            double ambient_p = msg.value("atm_pressure", msg.value("ambient_p", 101325.0));
                            double explosive_z = msg.value("charge_z", msg.value("explosive_z", 0.0));
                            double explosive_radius = msg.value("charge_radius", msg.value("explosive_radius", 0.1));
                            
                            global_solver_2d_cuda->setInitialConditionIdealGas(explosive_z, explosive_radius, high_rho, det_energy, ambient_rho, ambient_p);
                            double detonator_r = msg.value("detonator_r", 0.0);
                            double detonator_z = msg.value("detonator_z", explosive_z);
                            global_solver_2d_cuda->setDetonatorLocation(detonator_r, detonator_z);
                        } else if (init_mode == "Multi-Material JWL" || init_mode == "JWL") {
                            double high_rho = msg.value("high_rho", msg.value("rho", 1630.0));
                            double ambient_rho = msg.value("ambient_rho", 1.2);
                            double ambient_p = msg.value("atm_pressure", msg.value("ambient_p", 101325.0));
                            double explosive_z = msg.value("charge_z", msg.value("explosive_z", 0.0));
                            double explosive_radius = msg.value("charge_radius", msg.value("explosive_radius", 0.1));
                            
                            std::string charge_shape = msg.value("charge_shape", "Sphere");
                            if (charge_shape == "Cylinder" || charge_shape == "cylinder") {
                                double charge_radius = msg.value("charge_radius", 0.1);
                                double charge_height = msg.value("charge_height", 0.2);
                                global_solver_2d_cuda->setInitialConditionTNTCylinder(explosive_z, charge_radius, charge_height, high_rho, ambient_rho, ambient_p);
                                double detonator_r = msg.value("detonator_r", 0.0);
                                double detonator_z = msg.value("detonator_z", explosive_z + charge_height / 2.0);
                                global_solver_2d_cuda->setDetonatorLocation(detonator_r, detonator_z);
                            } else {
                                global_solver_2d_cuda->setInitialConditionTNT(explosive_z, explosive_radius, high_rho, ambient_rho, ambient_p);
                                double detonator_r = msg.value("detonator_r", 0.0);
                                double detonator_z = msg.value("detonator_z", explosive_z);
                                global_solver_2d_cuda->setDetonatorLocation(detonator_r, detonator_z);
                            }
                        }
                    } else {
                        global_solver_2d_cuda.reset();
                        global_solver_2d = std::make_unique<CFDSolver2D>(nr, nz, max_r, max_z, gamma);
                        
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
                            double ambient_rho = msg.value("ambient_rho", 1.2);
                            double ambient_p = msg.value("atm_pressure", msg.value("ambient_p", 101325.0));
                            double explosive_z = msg.value("charge_z", msg.value("explosive_z", 0.0));
                            double explosive_radius = msg.value("charge_radius", msg.value("explosive_radius", 0.1));
                            
                            global_solver_2d->setInitialConditionIdealGas(explosive_z, explosive_radius, high_rho, det_energy, ambient_rho, ambient_p);
                            double detonator_r = msg.value("detonator_r", 0.0);
                            double detonator_z = msg.value("detonator_z", explosive_z);
                            global_solver_2d->setDetonatorLocation(detonator_r, detonator_z);
                        } else if (init_mode == "Multi-Material JWL" || init_mode == "JWL") {
                            double high_rho = msg.value("high_rho", msg.value("rho", 1630.0));
                            double ambient_rho = msg.value("ambient_rho", 1.2);
                            double ambient_p = msg.value("atm_pressure", msg.value("ambient_p", 101325.0));
                            double explosive_z = msg.value("charge_z", msg.value("explosive_z", 0.0));
                            double explosive_radius = msg.value("charge_radius", msg.value("explosive_radius", 0.1));
                            
                            std::string charge_shape = msg.value("charge_shape", "Sphere");
                            if (charge_shape == "Cylinder" || charge_shape == "cylinder") {
                                double charge_radius = msg.value("charge_radius", 0.1);
                                double charge_height = msg.value("charge_height", 0.2);
                                global_solver_2d->setInitialConditionTNTCylinder(explosive_z, charge_radius, charge_height, high_rho, ambient_rho, ambient_p);
                                double detonator_r = msg.value("detonator_r", 0.0);
                                double detonator_z = msg.value("detonator_z", explosive_z + charge_height / 2.0);
                                global_solver_2d->setDetonatorLocation(detonator_r, detonator_z);
                            } else {
                                global_solver_2d->setInitialConditionTNT(explosive_z, explosive_radius, high_rho, ambient_rho, ambient_p);
                                double detonator_r = msg.value("detonator_r", 0.0);
                                double detonator_z = msg.value("detonator_z", explosive_z);
                                global_solver_2d->setDetonatorLocation(detonator_r, detonator_z);
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
                    global_solver_2d_cuda.reset();
                    global_t2d = 0.0;
                    step_progress_2d = 0;
                    solver2d_initialized = false;
                } else if (command == "REMAP") {
                    double explosive_z = msg.value("explosive_z", 0.0);
                    double remap_radius = msg.value("remap_radius", 0.5);
                    double explosive_r = msg.value("explosive_r", 0.0);
                    double ambient_rho = msg.value("ambient_rho", 1.2);
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
                    solver2d_initialized = true;
                    emit_kernel_log("REMAP", "1D->2D remap applied successfully.", 0.0, "2d");
                    emit_telemetry_2d(global_t2d, false);
                } else if (command == "STEP_3D") {
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
                    while (sim3d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_3d.reset();
                    global_t3d = 0.0;
                    step_progress_3d = 0;
                } else if (command == "INIT_3D") {
                    sim3d_terminate = true;
                    while (sim3d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    sim3d_terminate = false;
                    sim3d_paused = false;
                    global_t3d = 0.0;
                    global_wallclock_3d = 0.0;

                    int nx = msg.value("nx", 64);
                    int ny = msg.value("ny", 64);
                    int nz = msg.value("nz", 64);
                    double cellSize = msg.value("cell_size", 0.01);
                    double xmin = msg.value("xmin", 0.0);
                    double ymin = msg.value("ymin", 0.0);
                    double zmin = msg.value("zmin", 0.0);
                    std::string device = msg.value("device", "cpu");

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

                    std::string init_mode = msg.value("init_mode", "Multi-Material JWL");
                    bool is_multimat = (init_mode == "Multi-Material JWL");

                    if (device == "cuda") {
                        if (is_multimat) {
                            global_solver_3d = std::make_unique<CFDSolver3DCuda<true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                        } else {
                            global_solver_3d = std::make_unique<CFDSolver3DCuda<false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                        }
                    } else {
                        if (is_multimat) {
                            global_solver_3d = std::make_unique<CFDSolver3DImpl<true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                        } else {
                            global_solver_3d = std::make_unique<CFDSolver3DImpl<false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                        }
                    }

                    std::string flux_scheme = msg.value("flux_scheme", "AUSM+");
                    int spatial_order = msg.value("spatial_order", 2);
                    int temporal_order = msg.value("temporal_order", 2);
                    std::string precision = msg.value("precision", "single");

                    global_solver_3d->setFluxScheme(flux_scheme);
                    global_solver_3d->setSpatialOrder(spatial_order);
                    global_solver_3d->setTemporalOrder(temporal_order);
                    // Note: C++ solver is inherently double-precision, 'precision' param is parsed but not templated yet for performance.

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

                    double ambient_rho = msg.value("ambient_rho", 1.225);
                    double ambient_p = msg.value("atm_pressure", 101325.0);

                    global_solver_3d->setInitialCondition(cp, matSet, ambient_rho, ambient_p);

                    if (msg.contains("detonator_x")) {
                        double dx = msg.value("detonator_x", cp.x);
                        double dy = msg.value("detonator_y", cp.y);
                        double dz = msg.value("detonator_z", cp.z);
                        global_solver_3d->setDetonatorLocation(dx, dy, dz);
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

                    init_gauges(msg);
                    emit_kernel_log("SYSTEM", "3D Solver Initialized", 0.0, "3d");
                    emit_telemetry_3d(0.0, false);

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
                }

            } catch (const std::exception& e) {
                std::lock_guard<std::mutex> lock(cout_mutex);
                std::cout << "[ERROR] JSON/Binding Error: " << e.what() << std::endl;
            }
        }
    });
    stdin_listener_thread.join();

    return 0;
}
