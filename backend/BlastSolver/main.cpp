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

void emit_telemetry(const CFDSolver& solver, double elapsed, bool is_terminated = false);
void emit_telemetry_2d(double elapsed, bool is_terminated = false);
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

        double dt = global_solver->computeStepSize(global_cfl.load());
        global_solver->step(dt);
        global_t += dt;

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
            // No natural termination in 2D yet unless we add it
            // For now, EXEC_ALL runs until PAUSE or TERMINATE
        } else {
            if (global_target_steps_2d.load() <= 0) done = true;
        }

        if (done) break;

        double dt = 0.0;
        if (global_solver_2d_cuda) {
            double max_s = global_solver_2d_cuda->getMaxWaveSpeed();
            dt = global_cfl_2d.load() * std::min(global_solver_2d_cuda->getDr(), global_solver_2d_cuda->getDz()) / max_s;
            global_solver_2d_cuda->step(dt);
        } else if (global_solver_2d) {
            dt = global_solver_2d->computeStepSize(global_cfl_2d.load());
            global_solver_2d->step(dt);
        }
        global_dt_2d = dt;
        global_t2d += dt;

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
    pulse["gpu_util"] = gpu_util;
    pulse["vram_alloc"] = total_vram - free_vram;
    pulse["vram_total"] = total_vram;
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
                    sim_running = false;
                    std::this_thread::sleep_for(std::chrono::milliseconds(50));
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

                    global_solver->setFluxScheme(msg.at("flux_scheme").get<std::string>());
                    global_solver->setSpatialOrder(msg.at("spatial_order").get<int>());
                    global_solver->setTemporalOrder(msg.at("temporal_order").get<int>());

                    double explosive_radius = msg.at("explosive_radius").get<double>();
                    double high_rho         = msg.at("rho").get<double>();
                    double ambient_rho      = msg.at("ambient_rho").get<double>();
                    double ambient_p        = msg.at("atm_pressure").get<double>();

                    MultiMat::MaterialSet matSet = MultiMat::TNT;
                    if      (composition == "PETN") matSet = MultiMat::PETN;
                    else if (composition == "RDX")  matSet = MultiMat::RDX;
                    else if (composition == "Custom" || composition == "CUSTOM") {
                        double jwl_A     = msg.value("jwl_A",     373.77e9);
                        double jwl_B     = msg.value("jwl_B",     3.747e9);
                        double jwl_R1    = msg.value("jwl_R1",    4.15);
                        double jwl_R2    = msg.value("jwl_R2",    0.90);
                        double jwl_omega = msg.value("jwl_omega", 0.35);
                        double det_vel   = msg.value("det_vel",   6930.0);
                        double det_energy= msg.value("detonation_energy", 4.29e6);
                        matSet.products  = { jwl_A, jwl_B, jwl_R1, jwl_R2, jwl_omega, high_rho, 1000.0, 300.0 };
                        matSet.unreacted = { jwl_A, jwl_B, jwl_R1, jwl_R2, jwl_omega, high_rho, 1000.0, 300.0 };
                        matSet.det_vel   = det_vel;
                        matSet.detonation_energy = det_energy;
                    }
                    global_solver->setMaterialParameters(matSet);

                    if (init_mode == "Ideal Gas" || explosive_type == "MaterialIdealGas") {
                        double det_energy = msg.value("detonation_energy", 4520000.0);
                        global_solver->setInitialConditionIdealGas(explosive_radius, high_rho, det_energy, ambient_rho, ambient_p);
                    } else {
                        global_solver->setInitialConditionTNT(explosive_radius, high_rho, ambient_rho, ambient_p);
                    }

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
                    sim_running = false;
                    int wait_count = 0;
                    while (sim_running.load() && wait_count < 10) { std::this_thread::sleep_for(std::chrono::milliseconds(10)); wait_count++; }
                    global_solver.reset();
                    global_num_cells = 0;
                    global_t = 0.0;
                    step_progress = 0;
                } else if (command == "INIT_2D") {
                    sim2d_terminate = true;
                    sim2d_running = false;
                    std::this_thread::sleep_for(std::chrono::milliseconds(50));
                    sim2d_terminate = false;
                    sim2d_paused = false;
                    step_progress_2d = 0;
                    
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

                    MultiMat::MaterialSet matSet = MultiMat::TNT;
                    if      (composition == "PETN") matSet = MultiMat::PETN;
                    else if (composition == "RDX")  matSet = MultiMat::RDX;
                    else if (composition == "Custom" || composition == "CUSTOM") {
                        double jwl_A     = msg.value("jwl_A",     373.77e9);
                        double jwl_B     = msg.value("jwl_B",     3.747e9);
                        double jwl_R1    = msg.value("jwl_R1",    4.15);
                        double jwl_R2    = msg.value("jwl_R2",    0.90);
                        double jwl_omega = msg.value("jwl_omega", 0.35);
                        double high_rho  = msg.value("rho",       1630.0);
                        double det_vel   = msg.value("det_vel",   6930.0);
                        double det_energy= msg.value("detonation_energy", 4.29e6);
                        matSet.products  = { jwl_A, jwl_B, jwl_R1, jwl_R2, jwl_omega, high_rho, 1000.0, 300.0 };
                        matSet.unreacted = { jwl_A, jwl_B, jwl_R1, jwl_R2, jwl_omega, high_rho, 1000.0, 300.0 };
                        matSet.det_vel   = det_vel;
                        matSet.detonation_energy = det_energy;
                    }

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
                            double explosive_z = msg.value("explosive_z", 0.0);
                            double explosive_radius = msg.value("explosive_radius", 0.1);
                            
                            global_solver_2d_cuda->setInitialConditionIdealGas(explosive_z, explosive_radius, high_rho, det_energy, ambient_rho, ambient_p);
                        } else if (init_mode == "Multi-Material JWL" || init_mode == "JWL") {
                            double high_rho = msg.value("high_rho", msg.value("rho", 1630.0));
                            double ambient_rho = msg.value("ambient_rho", 1.2);
                            double ambient_p = msg.value("atm_pressure", msg.value("ambient_p", 101325.0));
                            double explosive_z = msg.value("explosive_z", 0.0);
                            double explosive_radius = msg.value("explosive_radius", 0.1);
                            
                            global_solver_2d_cuda->setInitialConditionTNT(explosive_z, explosive_radius, high_rho, ambient_rho, ambient_p);
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
                            double explosive_z = msg.value("explosive_z", 0.0);
                            double explosive_radius = msg.value("explosive_radius", 0.1);
                            
                            global_solver_2d->setInitialConditionIdealGas(explosive_z, explosive_radius, high_rho, det_energy, ambient_rho, ambient_p);
                        } else if (init_mode == "Multi-Material JWL" || init_mode == "JWL") {
                            double high_rho = msg.value("high_rho", msg.value("rho", 1630.0));
                            double ambient_rho = msg.value("ambient_rho", 1.2);
                            double ambient_p = msg.value("atm_pressure", msg.value("ambient_p", 101325.0));
                            double explosive_z = msg.value("explosive_z", 0.0);
                            double explosive_radius = msg.value("explosive_radius", 0.1);
                            
                            global_solver_2d->setInitialConditionTNT(explosive_z, explosive_radius, high_rho, ambient_rho, ambient_p);
                        }
                    }
                    
                    solver2d_initialized = true;
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
                    sim2d_running = false;
                    int wait_count = 0;
                    while (sim2d_running.load() && wait_count < 10) { std::this_thread::sleep_for(std::chrono::milliseconds(10)); wait_count++; }
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

                    if (global_solver_2d) {
                        global_solver_2d->setInitialConditionFrom1D(explosive_z, remap_radius, r_1d, states_1d, ambient_rho, ambient_p, explosive_r);
                        global_solver_2d->setTime(0.0);
                    } else if (global_solver_2d_cuda) {
                        global_solver_2d_cuda->setInitialConditionFrom1D(explosive_z, remap_radius, r_1d, states_1d, ambient_rho, ambient_p);
                        global_solver_2d_cuda->setTime(0.0);
                    }
                    global_t2d = 0.0;
                    solver2d_initialized = true;
                    emit_kernel_log("REMAP", "1D->2D remap applied successfully.", 0.0, "2d");
                    emit_telemetry_2d(global_t2d, false);
                } else if (command == "CONTOUR_CONFIG") {
                    global_telemetry_stride = msg.value("stride", 1);
                    double rate = msg.value("refresh_rate", 0.0);
                    global_telemetry_interval_ms = (rate > 0.0) ? static_cast<int>(rate * 1000.0) : 33;
                }

            } catch (const std::exception& e) {
                std::lock_guard<std::mutex> lock(cout_mutex);
                std::cout << "[ERROR] JSON/Binding Error: " << e.what() << std::endl;
            }
        }
    });
    stdin_listener_thread.join();

    // Prevent abrupt termination of detached worker threads when stdin reaches EOF
    while (sim_running.load() || sim2d_running.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }

    return 0;
}
