#include "TelemetryService.hpp"
#include "SolverState.hpp"
#include "GaugeService.hpp"
#include <iostream>
#include <fstream>
#include <sstream>
#include <iomanip>
#include <vector>
#include <string>
#include <algorithm>
#include <cmath>
#include <mutex>
#include <thread>
#include <queue>
#include <condition_variable>
#include <chrono>
#include <unistd.h>
#include <dlfcn.h>
#include <sys/resource.h>

#if defined(__has_include)
  #if __has_include(<cuda_runtime.h>)
    #include <cuda_runtime.h>
  #endif
#endif

void emit_kernel_log(const std::string& level, const std::string& msg, double t, const std::string& scope, int step) {
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



// NVML Dynamic Loading Declarations
typedef int nvmlReturn_t;
#define NVML_SUCCESS 0
#define NVML_ERROR_INSUFFICIENT_SIZE 7

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
    double last_dt_cpu = 0.0;
    double last_dt_wall = 0.0;
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
            last_dt_cpu = 0.0;
            last_dt_wall = 0.0;
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
        last_dt_cpu = dt_cpu;
        last_dt_wall = dt_wall;

        double usage = (dt_cpu / dt_wall / num_cores) * 100.0;
        return std::clamp(usage, 0.0, 100.0);
    }
};

struct SystemCPUMonitor {
    uint64_t prev_user = 0, prev_nice = 0, prev_system = 0, prev_idle = 0;
    uint64_t prev_iowait = 0, prev_irq = 0, prev_softirq = 0, prev_steal = 0;
    bool has_prev = false;

    double get_usage() {
        std::ifstream file("/proc/stat");
        if (!file.is_open()) return 0.0;
        std::string cpu;
        uint64_t user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0;
        if (!(file >> cpu >> user >> nice >> system >> idle >> iowait >> irq >> softirq >> steal)) {
            return 0.0;
        }
        if (!has_prev) {
            prev_user = user; prev_nice = nice; prev_system = system; prev_idle = idle;
            prev_iowait = iowait; prev_irq = irq; prev_softirq = softirq; prev_steal = steal;
            has_prev = true;
            return 0.0;
        }
        uint64_t prev_idle_all = prev_idle + prev_iowait;
        uint64_t idle_all = idle + iowait;

        uint64_t prev_non_idle = prev_user + prev_nice + prev_system + prev_irq + prev_softirq + prev_steal;
        uint64_t non_idle = user + nice + system + irq + softirq + steal;

        uint64_t prev_total = prev_idle_all + prev_non_idle;
        uint64_t total = idle_all + non_idle;

        uint64_t totald = (total > prev_total) ? (total - prev_total) : 0;
        uint64_t idled = (idle_all > prev_idle_all) ? (idle_all - prev_idle_all) : 0;

        prev_user = user; prev_nice = nice; prev_system = system; prev_idle = idle;
        prev_iowait = iowait; prev_irq = irq; prev_softirq = softirq; prev_steal = steal;

        if (totald == 0) return 0.0;
        double cpu_pct = (double)(totald - idled) / (double)totald * 100.0;
        return std::clamp(cpu_pct, 0.0, 100.0);
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
            if (ret == NVML_ERROR_INSUFFICIENT_SIZE && info_count > 64) {
                infos.resize(info_count);
                ret = p_nvmlDeviceGetComputeRunningProcesses(device, &info_count, infos.data());
            }
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
            if (ret == NVML_ERROR_INSUFFICIENT_SIZE && info_count > 64) {
                infos.resize(info_count);
                ret = p_nvmlDeviceGetGraphicsRunningProcesses(device, &info_count, infos.data());
            }
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



uint64_t get_process_ram_bytes() {
    std::ifstream statm("/proc/self/statm");
    uint64_t size, resident;
    if (statm >> size >> resident) {
        long page_size = sysconf(_SC_PAGESIZE);
        if (page_size <= 0) page_size = 4096;
        return resident * static_cast<uint64_t>(page_size);
    }
    struct rusage usage;
    if (getrusage(RUSAGE_SELF, &usage) == 0 && usage.ru_maxrss > 0) {
        return static_cast<uint64_t>(usage.ru_maxrss) * 1024ULL;
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

size_t get_active_solvers_allocated_vram() {
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
    for (const auto& [mid, fem] : global_fem_solvers_cuda_float) {
        if (fem) solver_vram += fem->getAllocatedVRAM();
    }
    for (const auto& [mid, fem] : global_fem_solvers_cuda_double) {
        if (fem) solver_vram += fem->getAllocatedVRAM();
    }
    return solver_vram;
}

inline void get_memory_breakdown(double& ram_mb, double& vram_mb) {
    static std::mutex mem_query_mutex;
    static auto last_query = std::chrono::steady_clock::now();
    static bool is_first = true;
    static double cached_ram_mb = 0.0;
    static double cached_vram_mb = 0.0;

    std::lock_guard<std::mutex> lock(mem_query_mutex);
    auto now = std::chrono::steady_clock::now();
    if (is_first || std::chrono::duration_cast<std::chrono::milliseconds>(now - last_query).count() >= 500) {
        is_first = false;
        last_query = now;
        uint64_t ram_bytes = get_process_ram_bytes();
        cached_ram_mb = static_cast<double>(ram_bytes) / (1024.0 * 1024.0);

        size_t solver_vram = get_active_solvers_allocated_vram();

        unsigned long long nvml_vram = 0;
        if (global_gpu_monitor.get_process_vram(getpid(), nvml_vram) && nvml_vram > 0) {
            global_last_valid_nvml_vram = nvml_vram;
            cached_vram_mb = static_cast<double>(std::max<size_t>(nvml_vram, solver_vram)) / (1024.0 * 1024.0);
        } else if (global_last_valid_nvml_vram > 0) {
            cached_vram_mb = static_cast<double>(std::max<size_t>(global_last_valid_nvml_vram, solver_vram)) / (1024.0 * 1024.0);
        } else if (solver_vram > 0) {
            cached_vram_mb = static_cast<double>(solver_vram) / (1024.0 * 1024.0);
        } else {
            size_t free_vram = 0, total_vram = 0;
            get_cuda_vram_info(free_vram, total_vram);
            if (total_vram > free_vram) {
                cached_vram_mb = static_cast<double>(total_vram - free_vram) / (1024.0 * 1024.0);
            } else {
                cached_vram_mb = 0.0;
            }
        }
    }
    ram_mb = cached_ram_mb;
    vram_mb = cached_vram_mb;
}

void emit_resource_pulse() {
    cudaSetDevice(global_cuda_device_index);
    global_gpu_monitor.set_device_index(global_cuda_device_index);
    static CPUMonitor cpu_monitor;
    static SystemCPUMonitor sys_cpu_monitor;
    static uint64_t system_ram = get_system_ram_bytes();

    std::lock_guard<std::mutex> lock(cout_mutex);

    double cpu_usage = cpu_monitor.get_usage();
    double cpu_cores = (cpu_monitor.last_dt_wall > 0.0) ? (cpu_monitor.last_dt_cpu / cpu_monitor.last_dt_wall) * 100.0 : 0.0;
    double cpu_system = sys_cpu_monitor.get_usage();
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
        // If NVML is not available, estimate when any simulation is active
        bool any_sim = sim_running.load() || sim2d_running.load() || sim3d_running.load() ||
                       sim_mpm_running.load() || sim_mpm_3d_running.load() ||
                       sim_fem_3d_running.load() || sim_fsi_running.load() ||
                       sim_fsi_3d_running.load() || sim_fem_fsi_3d_running.load();
        if (any_sim) {
            gpu_util = total_vram > 0 ? 80.0 : 15.0; // GPU active or CPU active mock
            gpu_temp = total_vram > 0 ? 65.0 : 45.0;
        } else {
            gpu_util = 0.0;
            gpu_temp = 35.0;
        }
    }

    size_t solver_vram = get_active_solvers_allocated_vram();
    size_t blastdemon_vram = 0;
    unsigned long long nvml_vram = 0;

    if (global_gpu_monitor.get_process_vram(getpid(), nvml_vram) && nvml_vram > 0) {
        global_last_valid_nvml_vram = nvml_vram;
        blastdemon_vram = std::max<size_t>(nvml_vram, solver_vram);
    } else if (global_last_valid_nvml_vram > 0) {
        blastdemon_vram = std::max<size_t>(global_last_valid_nvml_vram, solver_vram);
    } else {
        blastdemon_vram = solver_vram;
    }

    nlohmann::json pulse;
    pulse["type"] = "resource_pulse";
    pulse["cpu"] = cpu_usage;
    pulse["cpu_cores"] = cpu_cores;
    pulse["cpu_system"] = cpu_system;
    pulse["num_cores"] = cpu_monitor.num_cores;
    pulse["ram_alloc"] = ram_alloc;
    pulse["ram_total"] = system_ram;
    pulse["ram_system"] = get_system_used_ram_bytes();
    pulse["gpu_util"] = gpu_util;
    pulse["vram_alloc"] = total_vram - free_vram;
    pulse["vram_total"] = total_vram;
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
    
    // Timing & memory metrics (Directive 13: zero heap allocation)
    double compute_ms = 0.0;
    double io_ms = 0.0;
    double comms_ms = 0.0;
    double last_vtk_ms = 0.0;
    int last_vtk_step = 0;
    double cum_compute_s = 0.0;
    double cum_io_s = 0.0;
    double cum_comms_s = 0.0;
    double ram_mb = 0.0;
    double vram_mb = 0.0;
    
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
    std::vector<float> phase_particles;

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

inline void populate_timing_payload(TelemetryPayload* payload, double ram_mb, double vram_mb) {
    payload->compute_ms = global_last_compute_ms.load();
    payload->io_ms = global_last_io_ms.load();
    payload->comms_ms = global_last_comms_ms.load();
    payload->last_vtk_ms = global_last_vtk_ms.load();
    payload->last_vtk_step = global_last_vtk_step.load();
    payload->cum_compute_s = global_cum_compute_s.load();
    payload->cum_io_s = global_cum_io_s.load();
    payload->cum_comms_s = global_cum_comms_s.load();
    payload->ram_mb = ram_mb;
    payload->vram_mb = vram_mb;
}

struct AsyncTelemetry {
    std::mutex mutex;
    std::condition_variable cv;
    std::condition_variable flush_cv;
    std::queue<std::unique_ptr<TelemetryPayload>> queue;
    bool in_flight = false;
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
                global_async_telemetry.in_flight = false;
                global_async_telemetry.flush_cv.notify_all();
                break;
            }
            payload = std::move(global_async_telemetry.queue.front());
            global_async_telemetry.queue.pop();
            global_async_telemetry.in_flight = (payload != nullptr);
        }

        if (!payload) continue;

        {
            std::lock_guard<std::mutex> lock(cout_mutex);

        nlohmann::json envelope;
        if (!global_model_id.empty()) {
            envelope["modelId"] = global_model_id;
        }
        envelope["compute_ms"] = payload->compute_ms;
        envelope["io_ms"] = payload->io_ms;
        envelope["comms_ms"] = payload->comms_ms;
        envelope["last_vtk_ms"] = payload->last_vtk_ms;
        envelope["last_vtk_step"] = payload->last_vtk_step;
        envelope["cum_compute_s"] = payload->cum_compute_s;
        envelope["cum_io_s"] = payload->cum_io_s;
        envelope["cum_comms_s"] = payload->cum_comms_s;
        envelope["ram_mb"] = payload->ram_mb;
        envelope["vram_mb"] = payload->vram_mb;

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
            bool has_mpm_2d_particles = !payload->mpm_particles.empty();
            uint32_t n_particles_u = has_mpm_2d_particles ? static_cast<uint32_t>(payload->mpm_particles.size() / 2) : 0;
            size_t particle_hdr_bytes = has_mpm_2d_particles ? sizeof(uint32_t) : 0;
            size_t particle_payload_bytes = has_mpm_2d_particles ? (payload->mpm_particles.size() * sizeof(float)) : 0;
            size_t total_bytes   = header_bytes + payload_bytes + particle_hdr_bytes + particle_payload_bytes;

            std::cout << "BIN_FRAME_2D " << total_bytes << "\n";
            std::cout.write(reinterpret_cast<const char*>(&out_nr_u),     sizeof(uint32_t));
            std::cout.write(reinterpret_cast<const char*>(&out_nz_u),     sizeof(uint32_t));
            std::cout.write(reinterpret_cast<const char*>(&n_channels_u), sizeof(uint32_t));
            std::cout.write(reinterpret_cast<const char*>(payload->grid_data.data()), payload_bytes);
            if (has_mpm_2d_particles) {
                std::cout.write(reinterpret_cast<const char*>(&n_particles_u), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(payload->mpm_particles.data()), particle_payload_bytes);
            }
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
                const uint32_t n_floats_per_particle = 8;
                const uint32_t n_particles = static_cast<uint32_t>(payload->mpm_particles.size() / n_floats_per_particle);
                size_t particle_header_bytes = sizeof(uint32_t) * 3 + sizeof(float);
                size_t particle_payload_bytes = payload->mpm_particles.size() * sizeof(float);
                size_t total_particle_bytes = particle_header_bytes + particle_payload_bytes;

                std::cout << "BIN_MPM_3D_PARTICLES " << total_particle_bytes << "\n";
                std::cout.write(reinterpret_cast<const char*>(&magic), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(&time_f), sizeof(float));
                std::cout.write(reinterpret_cast<const char*>(&n_particles), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(&n_floats_per_particle), sizeof(uint32_t));
                if (particle_payload_bytes > 0 && !payload->mpm_particles.empty()) {
                    std::cout.write(reinterpret_cast<const char*>(payload->mpm_particles.data()), particle_payload_bytes);
                }
                std::cout.flush();
            }

            if (!payload->phase_particles.empty()) {
                const uint32_t magic = 0x50545033; // "PTP3"
                const float time_f = static_cast<float>(payload->elapsed);
                const uint32_t n_floats_per_particle = 8;
                const uint32_t n_particles = static_cast<uint32_t>(payload->phase_particles.size() / n_floats_per_particle);
                size_t particle_header_bytes = sizeof(uint32_t) * 3 + sizeof(float);
                size_t particle_payload_bytes = payload->phase_particles.size() * sizeof(float);
                size_t total_particle_bytes = particle_header_bytes + particle_payload_bytes;

                std::cout << "BIN_PHASE_PARTICLES_3D " << total_particle_bytes << "\n";
                std::cout.write(reinterpret_cast<const char*>(&magic), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(&time_f), sizeof(float));
                std::cout.write(reinterpret_cast<const char*>(&n_particles), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(&n_floats_per_particle), sizeof(uint32_t));
                if (particle_payload_bytes > 0 && !payload->phase_particles.empty()) {
                    std::cout.write(reinterpret_cast<const char*>(payload->phase_particles.data()), particle_payload_bytes);
                }
                std::cout.flush();
            }

            if (payload->fem_n_nodes > 0 && !payload->fem_node_data.empty()) {
                uint32_t magic = 0x46454d33; // "FEM3"
                float time_f = static_cast<float>(payload->elapsed);
                uint32_t n_nodes_u = static_cast<uint32_t>(payload->fem_node_data.size() / 7);
                uint32_t n_facets_u = static_cast<uint32_t>(payload->fem_facet_data.size() / 8);
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
                if (facet_bytes > 0 && !payload->fem_facet_data.empty()) {
                    std::cout.write(reinterpret_cast<const char*>(payload->fem_facet_data.data()), facet_bytes);
                }
                std::cout.flush();
            }
        } else if (payload->type == TelemetryPayload::TYPE_FEM_3D) {
            envelope["type"] = "TELEMETRY_FEM_3D";
            envelope["time"] = payload->elapsed;
            envelope["step"] = payload->step;
            envelope["fem_step"] = payload->fem_step;
            envelope["dt"] = payload->dt;
            envelope["is_terminated"] = payload->is_terminated;
            envelope["v_max"] = payload->fem_v_max;
            envelope["sig_max"] = payload->fem_sig_max;
            envelope["ep_max"] = payload->fem_ep_max;
            if (payload->has_gauges) {
                envelope["gauges_history"] = gh;
            }

            std::cout << envelope.dump() << std::endl;

            if (!payload->mpm_particles.empty()) {
                const uint32_t magic = 0x4d504d33; // "MPM3"
                const float time_f = static_cast<float>(payload->elapsed);
                const uint32_t n_floats_per_particle = 8;
                const uint32_t n_particles = static_cast<uint32_t>(payload->mpm_particles.size() / n_floats_per_particle);
                size_t particle_header_bytes = sizeof(uint32_t) * 3 + sizeof(float);
                size_t particle_payload_bytes = payload->mpm_particles.size() * sizeof(float);
                size_t total_particle_bytes = particle_header_bytes + particle_payload_bytes;

                std::cout << "BIN_MPM_3D_PARTICLES " << total_particle_bytes << "\n";
                std::cout.write(reinterpret_cast<const char*>(&magic), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(&time_f), sizeof(float));
                std::cout.write(reinterpret_cast<const char*>(&n_particles), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(&n_floats_per_particle), sizeof(uint32_t));
                if (particle_payload_bytes > 0 && !payload->mpm_particles.empty()) {
                    std::cout.write(reinterpret_cast<const char*>(payload->mpm_particles.data()), particle_payload_bytes);
                }
                std::cout.flush();
            }

            if (!payload->phase_particles.empty()) {
                const uint32_t magic = 0x50545033; // "PTP3"
                const float time_f = static_cast<float>(payload->elapsed);
                const uint32_t n_floats_per_particle = 8;
                const uint32_t n_particles = static_cast<uint32_t>(payload->phase_particles.size() / n_floats_per_particle);
                size_t particle_header_bytes = sizeof(uint32_t) * 3 + sizeof(float);
                size_t particle_payload_bytes = payload->phase_particles.size() * sizeof(float);
                size_t total_particle_bytes = particle_header_bytes + particle_payload_bytes;

                std::cout << "BIN_PHASE_PARTICLES_3D " << total_particle_bytes << "\n";
                std::cout.write(reinterpret_cast<const char*>(&magic), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(&time_f), sizeof(float));
                std::cout.write(reinterpret_cast<const char*>(&n_particles), sizeof(uint32_t));
                std::cout.write(reinterpret_cast<const char*>(&n_floats_per_particle), sizeof(uint32_t));
                if (particle_payload_bytes > 0 && !payload->phase_particles.empty()) {
                    std::cout.write(reinterpret_cast<const char*>(payload->phase_particles.data()), particle_payload_bytes);
                }
                std::cout.flush();
            }

            if (payload->fem_n_nodes > 0 && !payload->fem_node_data.empty()) {
                uint32_t magic = 0x46454d33; // "FEM3"
                float time_f = static_cast<float>(payload->elapsed);
                uint32_t n_nodes_u = static_cast<uint32_t>(payload->fem_node_data.size() / 7);
                uint32_t n_facets_u = static_cast<uint32_t>(payload->fem_facet_data.size() / 8);
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
                if (facet_bytes > 0 && !payload->fem_facet_data.empty()) {
                    std::cout.write(reinterpret_cast<const char*>(payload->fem_facet_data.data()), facet_bytes);
                }
                std::cout.flush();
            }
        }
        }
        {
            std::lock_guard<std::mutex> lock(global_async_telemetry.mutex);
            global_async_telemetry.in_flight = false;
            global_async_telemetry.flush_cv.notify_all();
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
        double ram_mb = 0.0, vram_mb = 0.0;
        get_memory_breakdown(ram_mb, vram_mb);
        populate_timing_payload(payload.get(), ram_mb, vram_mb);
    }

    {
        std::lock_guard<std::mutex> g_lock(global_gauges_mutex);
        if (!global_gauges.empty()) {
            static auto last_gauge_emit_time = std::chrono::steady_clock::now();
            auto now = std::chrono::steady_clock::now();
            bool emit_gauges = is_terminated || (step >= 0) || (std::chrono::duration_cast<std::chrono::milliseconds>(now - last_gauge_emit_time).count() >= 100);
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

    if (global_solver_mpm_2d) {
        const auto& particles = global_solver_mpm_2d->getParticles();
        if (!particles.empty()) {
            payload->mpm_particles.resize(particles.size() * 2);
            for (size_t k = 0; k < particles.size(); ++k) {
                payload->mpm_particles[k * 2 + 0] = particles[k].x[0];
                payload->mpm_particles[k * 2 + 1] = particles[k].x[1];
            }
        }
    }

    {
        double ram_mb = 0.0, vram_mb = 0.0;
        get_memory_breakdown(ram_mb, vram_mb);
        populate_timing_payload(payload.get(), ram_mb, vram_mb);
    }

    {
        std::lock_guard<std::mutex> g_lock(global_gauges_mutex);
        if (!global_gauges.empty()) {
            static auto last_gauge_emit_time = std::chrono::steady_clock::now();
            auto now = std::chrono::steady_clock::now();
            bool emit_gauges = is_terminated || (step >= 0) || (std::chrono::duration_cast<std::chrono::milliseconds>(now - last_gauge_emit_time).count() >= 100);
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
    {
        double ram_mb = 0.0, vram_mb = 0.0;
        get_memory_breakdown(ram_mb, vram_mb);
        envelope["compute_ms"] = global_last_compute_ms.load();
        envelope["io_ms"] = global_last_io_ms.load();
        envelope["comms_ms"] = global_last_comms_ms.load();
        envelope["last_vtk_ms"] = global_last_vtk_ms.load();
        envelope["last_vtk_step"] = global_last_vtk_step.load();
        envelope["cum_compute_s"] = global_cum_compute_s.load();
        envelope["cum_io_s"] = global_cum_io_s.load();
        envelope["cum_comms_s"] = global_cum_comms_s.load();
        envelope["ram_mb"] = ram_mb;
        envelope["vram_mb"] = vram_mb;
    }
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
    if (qty == "pressure") return node.pressure;
    if (qty == "velocity") {
        float vx = node.v(0), vy = node.v(1), vz = node.v(2);
        return std::sqrt(vx * vx + vy * vy + vz * vz);
    }
    return node.plastic_strain;
}

static inline void appendCompactMPMParticle(
    std::vector<float>& out,
    float x, float y, float z,
    float vx, float vy, float vz,
    float von_mises, float press, float ep_or_lambda, float den,
    float damage, bool has_failed, int object_id, int cluster_id)
{
    auto packHalf = [](float val) -> uint16_t {
        uint32_t fbits = 0;
        std::memcpy(&fbits, &val, sizeof(float));
        uint32_t sign = (fbits >> 16) & 0x8000u;
        int32_t exp = static_cast<int32_t>((fbits >> 23) & 0xFFu) - 127 + 15;
        uint32_t mant = fbits & 0x007FFFFFu;
        if (exp <= 0) {
            if (exp < -10) return static_cast<uint16_t>(sign);
            mant = (mant | 0x00800000u) >> (1 - exp);
            return static_cast<uint16_t>(sign | (mant >> 13));
        } else if (exp == 0xFF - 127 + 15) {
            return static_cast<uint16_t>(sign | 0x7C00u | (mant ? 0x0200u : 0u));
        } else if (exp > 30) {
            return static_cast<uint16_t>(sign | 0x7BFFu);
        }
        return static_cast<uint16_t>(sign | (static_cast<uint32_t>(exp) << 10) | (mant >> 13));
    };
    auto bitsToFloat = [](uint32_t u) -> float {
        float f = 0.0f;
        std::memcpy(&f, &u, sizeof(float));
        return f;
    };
    float speed = std::sqrt(vx * vx + vy * vy + vz * vz);
    uint32_t word6 = static_cast<uint32_t>(packHalf(ep_or_lambda)) | (static_cast<uint32_t>(packHalf(den)) << 16);
    uint32_t dmg_u8 = static_cast<uint32_t>(std::clamp(std::lround(std::clamp(damage, 0.0f, 1.0f) * 255.0f), 0l, 255l));
    uint32_t obj_u7 = static_cast<uint32_t>(std::max(0, object_id)) & 0x7Fu;
    uint32_t fail_u1 = has_failed ? 0x80u : 0x00u;
    uint32_t clus_u16 = static_cast<uint32_t>(std::max(0, cluster_id)) & 0xFFFFu;
    uint32_t word7 = dmg_u8 | ((obj_u7 | fail_u1) << 8) | (clus_u16 << 16);

    out.push_back(x);
    out.push_back(y);
    out.push_back(z);
    out.push_back(von_mises);
    out.push_back(press);
    out.push_back(speed);
    out.push_back(bitsToFloat(word6));
    out.push_back(bitsToFloat(word7));
}

void emit_telemetry_mpm_3d(double elapsed, bool is_terminated, int step, bool include_particles) {
    if (!global_solver_mpm_3d && !global_solver_mpm_3d_cuda) return;

    if (include_particles && global_solver_mpm_3d_cuda && global_solver_mpm_3d_cuda->getStepCount() > 0) {
        global_solver_mpm_3d_cuda->downloadSoA2AoS();
    }

    double sim_time = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getSimTime() : (global_solver_mpm_3d ? global_solver_mpm_3d->getSimTime() : global_t3d);
    int mpm_step = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getStepCount() : (global_solver_mpm_3d ? global_solver_mpm_3d->getStepCount() : 0);
    int current_step = (step >= 0) ? step : std::max({mpm_step, global_step_fsi_3d.load(), global_step_3d.load()});
    float dt = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getLastDt() : global_solver_mpm_3d->getLastDt();
    float cfl = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getLastCFL() : global_solver_mpm_3d->getLastCFL();
    float v_max = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getMaxVelocity() : global_solver_mpm_3d->getMaxVelocity();
    size_t num_particles = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getParticleCount() : (global_solver_mpm_3d ? global_solver_mpm_3d->getParticles().size() : 0);
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
                 current_step, sim_time, dt, cfl, v_max, num_particles, mpm_vram / (1024.0 * 1024.0));
    } else {
        snprintf(log_buf, sizeof(log_buf),
                 "Step %d | Time = %.4e s | dt = %.2e s | CFL = %.2f | v_max = %.1f m/s | Particles = %zu",
                 current_step, sim_time, dt, cfl, v_max, num_particles);
    }
    emit_kernel_log("SYSTEM", log_buf, sim_time, "mpm_3d", current_step);

    auto payload = std::make_unique<TelemetryPayload>();
    payload->type = TelemetryPayload::TYPE_3D;
    payload->elapsed = (elapsed > 0.0) ? elapsed : sim_time;
    payload->step = current_step;
    payload->dt = dt;
    payload->is_terminated = is_terminated;
    payload->wallclock = 0.0;
    payload->is_ideal_gas = false;

    {
        double ram_mb = 0.0, vram_mb = 0.0;
        get_memory_breakdown(ram_mb, vram_mb);
        populate_timing_payload(payload.get(), ram_mb, vram_mb);
    }
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

        if (global_solver_mpm_3d_cuda) {
            if (s.axis == "xy") { sp.w = nx; sp.h = ny; }
            else if (s.axis == "xz") { sp.w = nx; sp.h = nz; }
            else { sp.w = ny; sp.h = nz; }
            global_solver_mpm_3d_cuda->extractSliceToHost(sp.data, s.axis, static_cast<float>(s.offset), req_qty);
        } else if (global_solver_mpm_3d) {
            const auto& grid = global_solver_mpm_3d->getGrid();
            if (s.axis == "xy") {
                int k = std::clamp(static_cast<int>(s.offset / dz), 0, nz - 1);
                sp.w = nx; sp.h = ny; sp.data.resize(nx * ny);
                for (int j = 0; j < ny; ++j) {
                    for (int i = 0; i < nx; ++i) {
                        int idx = (i * ny + j) * nz + k;
                        sp.data[i + j * nx] = (idx < (int)grid.size()) ? getMPMGridQuantity(grid[idx], req_qty) : 0.0f;
                    }
                }
            } else if (s.axis == "xz") {
                int j_slice = std::clamp(static_cast<int>(s.offset / dy), 0, ny - 1);
                sp.w = nx; sp.h = nz; sp.data.resize(nx * nz);
                for (int k = 0; k < nz; ++k) {
                    for (int i = 0; i < nx; ++i) {
                        int idx = (i * ny + j_slice) * nz + k;
                        sp.data[i + k * nx] = (idx < (int)grid.size()) ? getMPMGridQuantity(grid[idx], req_qty) : 0.0f;
                    }
                }
            } else {
                int i_slice = std::clamp(static_cast<int>(s.offset / dx), 0, nx - 1);
                sp.w = ny; sp.h = nz; sp.data.resize(ny * nz);
                for (int k = 0; k < nz; ++k) {
                    for (int j = 0; j < ny; ++j) {
                        int idx = (i_slice * ny + j) * nz + k;
                        sp.data[j + k * ny] = (idx < (int)grid.size()) ? getMPMGridQuantity(grid[idx], req_qty) : 0.0f;
                    }
                }
            }
        }
        payload->slices.push_back(std::move(sp));
    }

    if (include_particles) {
        const auto& particles = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getParticles() : global_solver_mpm_3d->getParticles();
        size_t total_particles = particles.size();
        size_t stride = 1;
        int user_stride = global_mpm_particle_stride.load();
        if (user_stride > 1) {
            stride = static_cast<size_t>(user_stride);
        }
        size_t visual_count = (total_particles + stride - 1) / stride;
        payload->mpm_particles.reserve(visual_count * 8);
        for (size_t idx = 0; idx < total_particles; idx += stride) {
            const auto& p = particles[idx];
            if (p.m <= 0.0f || p.state == 2) continue;
            float s00 = p.sigma[0][0], s11 = p.sigma[1][1], s22 = p.sigma[2][2];
            float s01 = p.sigma[0][1], s02 = p.sigma[0][2], s12 = p.sigma[1][2];
            float press = -(s00 + s11 + s22) / 3.0f;
            float dev00 = s00 + press, dev11 = s11 + press, dev22 = s22 + press;
            float vm_sq = dev00 * dev00 + dev11 * dev11 + dev22 * dev22 + 2.0f * (s01 * s01 + s02 * s02 + s12 * s12);
            float von_mises = std::sqrt(std::max(0.0f, 1.5f * vm_sq));

            const auto& mat_tbl = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getMaterialTable(p.object_id) : global_solver_mpm_3d->getMaterialTable(p.object_id);
            float den = mat_tbl.density;
            bool is_energetic = (mat_tbl.material_model == Blast::MPMMaterialModel::JWLProgrammedBurn ||
                                 mat_tbl.material_model == Blast::MPMMaterialModel::CRESTReactiveBurn ||
                                 mat_tbl.material_model == Blast::MPMMaterialModel::LeeTarverIgnitionGrowth);
            float ep_or_lambda = is_energetic ? p.lambda : p.ep_bar;
            appendCompactMPMParticle(payload->mpm_particles,
                p.x[0], p.x[1], p.x[2],
                p.v[0], p.v[1], p.v[2],
                von_mises, press, ep_or_lambda, den,
                p.damage, p.has_failed, p.object_id, p.cluster_id);
        }
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
        payload->elapsed = (elapsed > 0.0) ? elapsed : static_cast<double>(cuda_fem_float->getSimTime());
        payload->dt = static_cast<double>(cuda_fem_float->getLastDt());
        payload->step = (step >= 0) ? step : std::max(cuda_fem_float->getStepCount(), global_step_fem_fsi_3d.load());
        payload->fem_step = payload->step;
        payload->is_terminated = is_terminated;
        if (!global_model_id.empty()) {
            payload->fem_model_id = global_model_id;
        }

        {
            double ram_mb = 0.0, vram_mb = 0.0;
            get_memory_breakdown(ram_mb, vram_mb);
            populate_timing_payload(payload.get(), ram_mb, vram_mb);
        }
        size_t n_nodes = cuda_fem_float->getNodeCount();
        if (n_nodes > 0) {
            cuda_fem_float->extractTelemetry(payload->fem_node_data, payload->fem_facet_data);
            payload->fem_n_nodes = static_cast<uint32_t>(payload->fem_node_data.size() / 7);
            payload->fem_n_facets = static_cast<uint32_t>(payload->fem_facet_data.size() / 8);
        } else {
            payload->fem_n_nodes = 0;
            payload->fem_n_facets = 0;
        }
        payload->fem_v_max = static_cast<double>(cuda_fem_float->getMaxVelocity());
        payload->fem_sig_max = static_cast<double>(cuda_fem_float->getMaxVonMisesStress());
        payload->fem_ep_max = static_cast<double>(cuda_fem_float->getMaxPlasticStrain());

        Blast::MPMSolver3DCUDA* mpm_sol_cuda = cuda_fem_float->getCUDAMPMSolver() ? cuda_fem_float->getCUDAMPMSolver() : global_solver_mpm_3d_cuda.get();
        Blast::MPMSolver3D* mpm_sol = cuda_fem_float->getMPMSolver() ? cuda_fem_float->getMPMSolver() : global_solver_mpm_3d.get();
        if (mpm_sol_cuda && mpm_sol_cuda->getParticleCount() > 0) {
            mpm_sol_cuda->syncParticlesToHost();
            const auto& pts = mpm_sol_cuda->getParticles();
            payload->mpm_particles.clear();
            payload->mpm_particles.reserve(pts.size() * 8);
            for (size_t i = 0; i < pts.size(); ++i) {
                if (pts[i].m <= 0.0f || pts[i].state == 2) continue;
                float sxx = pts[i].sigma[0][0], syy = pts[i].sigma[1][1], szz = pts[i].sigma[2][2];
                float sxy = pts[i].sigma[0][1], syz = pts[i].sigma[1][2], sxz = pts[i].sigma[0][2];
                float diff_xy = sxx - syy, diff_yz = syy - szz, diff_zx = szz - sxx;
                float p_vm = std::sqrt(std::max(0.0f, 0.5f * (diff_xy * diff_xy + diff_yz * diff_yz + diff_zx * diff_zx) + 3.0f * (sxy * sxy + syz * syz + sxz * sxz)));
                float p_press = -(sxx + syy + szz) / 3.0f;
                float den = 2400.0f;
                if (pts[i].object_id >= 0 && pts[i].object_id < static_cast<int>(mpm_sol_cuda->getMaterialTables().size())) {
                    den = mpm_sol_cuda->getMaterialTables()[pts[i].object_id].density;
                }
                appendCompactMPMParticle(payload->mpm_particles,
                    pts[i].x[0], pts[i].x[1], pts[i].x[2],
                    pts[i].v[0], pts[i].v[1], pts[i].v[2],
                    p_vm, p_press, pts[i].ep_bar, den,
                    pts[i].damage, pts[i].has_failed, pts[i].object_id, pts[i].cluster_id);
            }
        } else if (mpm_sol && !mpm_sol->getParticles().empty()) {
            const auto& pts = mpm_sol->getParticles();
            payload->mpm_particles.clear();
            payload->mpm_particles.reserve(pts.size() * 8);
            for (size_t i = 0; i < pts.size(); ++i) {
                if (pts[i].m <= 0.0f || pts[i].state == 2) continue;
                float sxx = pts[i].sigma[0][0], syy = pts[i].sigma[1][1], szz = pts[i].sigma[2][2];
                float sxy = pts[i].sigma[0][1], syz = pts[i].sigma[1][2], sxz = pts[i].sigma[0][2];
                float diff_xy = sxx - syy, diff_yz = syy - szz, diff_zx = szz - sxx;
                float p_vm = std::sqrt(std::max(0.0f, 0.5f * (diff_xy * diff_xy + diff_yz * diff_yz + diff_zx * diff_zx) + 3.0f * (sxy * sxy + syz * syz + sxz * sxz)));
                float p_press = -(sxx + syy + szz) / 3.0f;
                float den = 2400.0f;
                if (pts[i].object_id >= 0 && pts[i].object_id < static_cast<int>(mpm_sol->getMaterialTables().size())) {
                    den = mpm_sol->getMaterialTables()[pts[i].object_id].density;
                }
                appendCompactMPMParticle(payload->mpm_particles,
                    pts[i].x[0], pts[i].x[1], pts[i].x[2],
                    pts[i].v[0], pts[i].v[1], pts[i].v[2],
                    p_vm, p_press, pts[i].ep_bar, den,
                    pts[i].damage, pts[i].has_failed, pts[i].object_id, pts[i].cluster_id);
            }
        }

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
        payload->elapsed = (elapsed > 0.0) ? elapsed : cuda_fem_double->getSimTime();
        payload->dt = cuda_fem_double->getLastDt();
        payload->step = (step >= 0) ? step : std::max(cuda_fem_double->getStepCount(), global_step_fem_fsi_3d.load());
        payload->fem_step = payload->step;
        payload->is_terminated = is_terminated;
        if (!global_model_id.empty()) {
            payload->fem_model_id = global_model_id;
        }

        {
            double ram_mb = 0.0, vram_mb = 0.0;
            get_memory_breakdown(ram_mb, vram_mb);
            populate_timing_payload(payload.get(), ram_mb, vram_mb);
        }
        size_t n_nodes = cuda_fem_double->getNodeCount();
        if (n_nodes > 0) {
            cuda_fem_double->extractTelemetry(payload->fem_node_data, payload->fem_facet_data);
            payload->fem_n_nodes = static_cast<uint32_t>(payload->fem_node_data.size() / 7);
            payload->fem_n_facets = static_cast<uint32_t>(payload->fem_facet_data.size() / 8);
        } else {
            payload->fem_n_nodes = 0;
            payload->fem_n_facets = 0;
        }
        payload->fem_v_max = cuda_fem_double->getMaxVelocity();
        payload->fem_sig_max = cuda_fem_double->getMaxVonMisesStress();
        payload->fem_ep_max = cuda_fem_double->getMaxPlasticStrain();

        Blast::MPMSolver3DCUDA* mpm_sol_cuda = cuda_fem_double->getCUDAMPMSolver() ? cuda_fem_double->getCUDAMPMSolver() : global_solver_mpm_3d_cuda.get();
        Blast::MPMSolver3D* mpm_sol = cuda_fem_double->getMPMSolver() ? cuda_fem_double->getMPMSolver() : global_solver_mpm_3d.get();
        if (mpm_sol_cuda && mpm_sol_cuda->getParticleCount() > 0) {
            mpm_sol_cuda->syncParticlesToHost();
            const auto& pts = mpm_sol_cuda->getParticles();
            payload->mpm_particles.clear();
            payload->mpm_particles.reserve(pts.size() * 8);
            for (size_t i = 0; i < pts.size(); ++i) {
                if (pts[i].m <= 0.0f || pts[i].state == 2) continue;
                float sxx = pts[i].sigma[0][0], syy = pts[i].sigma[1][1], szz = pts[i].sigma[2][2];
                float sxy = pts[i].sigma[0][1], syz = pts[i].sigma[1][2], sxz = pts[i].sigma[0][2];
                float diff_xy = sxx - syy, diff_yz = syy - szz, diff_zx = szz - sxx;
                float p_vm = std::sqrt(std::max(0.0f, 0.5f * (diff_xy * diff_xy + diff_yz * diff_yz + diff_zx * diff_zx) + 3.0f * (sxy * sxy + syz * syz + sxz * sxz)));
                float p_press = -(sxx + syy + szz) / 3.0f;
                float den = 2400.0f;
                if (pts[i].object_id >= 0 && pts[i].object_id < static_cast<int>(mpm_sol_cuda->getMaterialTables().size())) {
                    den = mpm_sol_cuda->getMaterialTables()[pts[i].object_id].density;
                }
                appendCompactMPMParticle(payload->mpm_particles,
                    pts[i].x[0], pts[i].x[1], pts[i].x[2],
                    pts[i].v[0], pts[i].v[1], pts[i].v[2],
                    p_vm, p_press, pts[i].ep_bar, den,
                    pts[i].damage, pts[i].has_failed, pts[i].object_id, pts[i].cluster_id);
            }
        } else if (mpm_sol && !mpm_sol->getParticles().empty()) {
            const auto& pts = mpm_sol->getParticles();
            payload->mpm_particles.clear();
            payload->mpm_particles.reserve(pts.size() * 8);
            for (size_t i = 0; i < pts.size(); ++i) {
                if (pts[i].m <= 0.0f || pts[i].state == 2) continue;
                float sxx = pts[i].sigma[0][0], syy = pts[i].sigma[1][1], szz = pts[i].sigma[2][2];
                float sxy = pts[i].sigma[0][1], syz = pts[i].sigma[1][2], sxz = pts[i].sigma[0][2];
                float diff_xy = sxx - syy, diff_yz = syy - szz, diff_zx = szz - sxx;
                float p_vm = std::sqrt(std::max(0.0f, 0.5f * (diff_xy * diff_xy + diff_yz * diff_yz + diff_zx * diff_zx) + 3.0f * (sxy * sxy + syz * syz + sxz * sxz)));
                float p_press = -(sxx + syy + szz) / 3.0f;
                float den = 2400.0f;
                if (pts[i].object_id >= 0 && pts[i].object_id < static_cast<int>(mpm_sol->getMaterialTables().size())) {
                    den = mpm_sol->getMaterialTables()[pts[i].object_id].density;
                }
                appendCompactMPMParticle(payload->mpm_particles,
                    pts[i].x[0], pts[i].x[1], pts[i].x[2],
                    pts[i].v[0], pts[i].v[1], pts[i].v[2],
                    p_vm, p_press, pts[i].ep_bar, den,
                    pts[i].damage, pts[i].has_failed, pts[i].object_id, pts[i].cluster_id);
            }
        }

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
    payload->elapsed = (elapsed > 0.0) ? elapsed : (fem_float ? static_cast<double>(fem_float->getSimTime()) : fem_double->getSimTime());
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

    {
        double ram_mb = 0.0, vram_mb = 0.0;
        get_memory_breakdown(ram_mb, vram_mb);
        payload->compute_ms = global_last_compute_ms.load();
        payload->io_ms = global_last_io_ms.load();
        payload->comms_ms = global_last_comms_ms.load();
        payload->ram_mb = ram_mb;
        payload->vram_mb = vram_mb;
    }

    size_t n_nodes = fem_float ? fem_float->getNodes().size() : fem_double->getNodes().size();
    size_t n_facets = fem_float ? fem_float->getSurfaceFacets().size() : fem_double->getSurfaceFacets().size();
    size_t n_trusses = fem_float ? fem_float->getTrusses().size() : fem_double->getTrusses().size();
    size_t n_beams = fem_float ? fem_float->getBeams().size() : fem_double->getBeams().size();
    size_t total_facets = n_facets + n_trusses + n_beams;
    payload->fem_n_nodes = static_cast<uint32_t>(n_nodes);
    payload->fem_n_facets = static_cast<uint32_t>(total_facets);

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

        payload->fem_facet_data.resize(total_facets * 8);
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

            size_t offset = n_facets;
            const auto& trusses = fem_float->getTrusses();
            for (size_t t = 0; t < n_trusses; ++t) {
                const auto& tr = trusses[t];
                payload->fem_facet_data[(offset + t) * 8 + 0] = static_cast<float>(tr.node_ids[0]);
                payload->fem_facet_data[(offset + t) * 8 + 1] = static_cast<float>(tr.node_ids[1]);
                payload->fem_facet_data[(offset + t) * 8 + 2] = -1.0f;
                payload->fem_facet_data[(offset + t) * 8 + 3] = -1.0f;
                payload->fem_facet_data[(offset + t) * 8 + 4] = static_cast<float>(std::abs(tr.sigma));
                payload->fem_facet_data[(offset + t) * 8 + 5] = static_cast<float>(tr.ep_bar);
                payload->fem_facet_data[(offset + t) * 8 + 6] = static_cast<float>(std::abs(tr.sigma * tr.A));
                payload->fem_facet_data[(offset + t) * 8 + 7] = tr.is_eroded ? 1.0f : 0.0f;
            }
            offset += n_trusses;
            const auto& beams = fem_float->getBeams();
            for (size_t b = 0; b < n_beams; ++b) {
                const auto& bm = beams[b];
                float sig = static_cast<float>(bm.ep_bar > 0.0f ? (500.0e6f + 2.0e9f * bm.ep_bar) : 0.0f);
                float moment = static_cast<float>(bm.kappa2 * bm.kappa2 + bm.kappa3 * bm.kappa3);
                if (moment > 0.0f) moment = std::sqrt(moment);
                payload->fem_facet_data[(offset + b) * 8 + 0] = static_cast<float>(bm.node_ids[0]);
                payload->fem_facet_data[(offset + b) * 8 + 1] = static_cast<float>(bm.node_ids[1]);
                payload->fem_facet_data[(offset + b) * 8 + 2] = -1.0f;
                payload->fem_facet_data[(offset + b) * 8 + 3] = -1.0f;
                payload->fem_facet_data[(offset + b) * 8 + 4] = sig;
                payload->fem_facet_data[(offset + b) * 8 + 5] = static_cast<float>(bm.ep_bar);
                payload->fem_facet_data[(offset + b) * 8 + 6] = moment;
                payload->fem_facet_data[(offset + b) * 8 + 7] = bm.is_eroded ? 1.0f : 0.0f;
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

            size_t offset = n_facets;
            const auto& trusses = fem_double->getTrusses();
            for (size_t t = 0; t < n_trusses; ++t) {
                const auto& tr = trusses[t];
                payload->fem_facet_data[(offset + t) * 8 + 0] = static_cast<float>(tr.node_ids[0]);
                payload->fem_facet_data[(offset + t) * 8 + 1] = static_cast<float>(tr.node_ids[1]);
                payload->fem_facet_data[(offset + t) * 8 + 2] = -1.0f;
                payload->fem_facet_data[(offset + t) * 8 + 3] = -1.0f;
                payload->fem_facet_data[(offset + t) * 8 + 4] = static_cast<float>(std::abs(tr.sigma));
                payload->fem_facet_data[(offset + t) * 8 + 5] = static_cast<float>(tr.ep_bar);
                payload->fem_facet_data[(offset + t) * 8 + 6] = static_cast<float>(std::abs(tr.sigma * tr.A));
                payload->fem_facet_data[(offset + t) * 8 + 7] = tr.is_eroded ? 1.0f : 0.0f;
            }
            offset += n_trusses;
            const auto& beams = fem_double->getBeams();
            for (size_t b = 0; b < n_beams; ++b) {
                const auto& bm = beams[b];
                float sig = static_cast<float>(bm.ep_bar > 0.0 ? (500.0e6 + 2.0e9 * bm.ep_bar) : 0.0);
                float moment = static_cast<float>(bm.kappa2 * bm.kappa2 + bm.kappa3 * bm.kappa3);
                if (moment > 0.0f) moment = std::sqrt(moment);
                payload->fem_facet_data[(offset + b) * 8 + 0] = static_cast<float>(bm.node_ids[0]);
                payload->fem_facet_data[(offset + b) * 8 + 1] = static_cast<float>(bm.node_ids[1]);
                payload->fem_facet_data[(offset + b) * 8 + 2] = -1.0f;
                payload->fem_facet_data[(offset + b) * 8 + 3] = -1.0f;
                payload->fem_facet_data[(offset + b) * 8 + 4] = sig;
                payload->fem_facet_data[(offset + b) * 8 + 5] = static_cast<float>(bm.ep_bar);
                payload->fem_facet_data[(offset + b) * 8 + 6] = moment;
                payload->fem_facet_data[(offset + b) * 8 + 7] = bm.is_eroded ? 1.0f : 0.0f;
            }
        }
    }

    Blast::MPMSolver3DCUDA* mpm_sol_cuda = global_solver_mpm_3d_cuda.get();
    Blast::MPMSolver3D* mpm_sol = fem_float ? fem_float->getMPMSolver() : (fem_double ? fem_double->getMPMSolver() : global_solver_mpm_3d.get());
    if (mpm_sol_cuda && mpm_sol_cuda->getParticleCount() > 0) {
        mpm_sol_cuda->syncParticlesToHost();
        const auto& pts = mpm_sol_cuda->getParticles();
        payload->mpm_particles.clear();
        payload->mpm_particles.reserve(pts.size() * 8);
        for (size_t i = 0; i < pts.size(); ++i) {
            if (pts[i].m <= 0.0f || pts[i].state == 2) continue;
            float sxx = pts[i].sigma[0][0], syy = pts[i].sigma[1][1], szz = pts[i].sigma[2][2];
            float sxy = pts[i].sigma[0][1], syz = pts[i].sigma[1][2], sxz = pts[i].sigma[0][2];
            float diff_xy = sxx - syy, diff_yz = syy - szz, diff_zx = szz - sxx;
            float p_vm = std::sqrt(std::max(0.0f, 0.5f * (diff_xy * diff_xy + diff_yz * diff_yz + diff_zx * diff_zx) + 3.0f * (sxy * sxy + syz * syz + sxz * sxz)));
            float p_press = -(sxx + syy + szz) / 3.0f;
            float den = 2400.0f;
            if (pts[i].object_id >= 0 && pts[i].object_id < static_cast<int>(mpm_sol_cuda->getMaterialTables().size())) {
                den = mpm_sol_cuda->getMaterialTables()[pts[i].object_id].density;
            }
            appendCompactMPMParticle(payload->mpm_particles,
                pts[i].x[0], pts[i].x[1], pts[i].x[2],
                pts[i].v[0], pts[i].v[1], pts[i].v[2],
                p_vm, p_press, pts[i].ep_bar, den,
                pts[i].damage, pts[i].has_failed, pts[i].object_id, pts[i].cluster_id);
        }
    } else if (mpm_sol && !mpm_sol->getParticles().empty()) {
        const auto& pts = mpm_sol->getParticles();
        payload->mpm_particles.clear();
        payload->mpm_particles.reserve(pts.size() * 8);
        for (size_t i = 0; i < pts.size(); ++i) {
            if (pts[i].m <= 0.0f || pts[i].state == 2) continue;
            float sxx = pts[i].sigma[0][0], syy = pts[i].sigma[1][1], szz = pts[i].sigma[2][2];
            float sxy = pts[i].sigma[0][1], syz = pts[i].sigma[1][2], sxz = pts[i].sigma[0][2];
            float diff_xy = sxx - syy, diff_yz = syy - szz, diff_zx = szz - sxx;
            float p_vm = std::sqrt(std::max(0.0f, 0.5f * (diff_xy * diff_xy + diff_yz * diff_yz + diff_zx * diff_zx) + 3.0f * (sxy * sxy + syz * syz + sxz * sxz)));
            float p_press = -(sxx + syy + szz) / 3.0f;
            float den = 2400.0f;
            if (pts[i].object_id >= 0 && pts[i].object_id < static_cast<int>(mpm_sol->getMaterialTables().size())) {
                den = mpm_sol->getMaterialTables()[pts[i].object_id].density;
            }
            appendCompactMPMParticle(payload->mpm_particles,
                pts[i].x[0], pts[i].x[1], pts[i].x[2],
                pts[i].v[0], pts[i].v[1], pts[i].v[2],
                p_vm, p_press, pts[i].ep_bar, den,
                pts[i].damage, pts[i].has_failed, pts[i].object_id, pts[i].cluster_id);
        }
    }

    global_async_telemetry.push(std::move(payload));
}

void emit_telemetry_3d(double elapsed, bool is_terminated, int step) {
    if (!global_solver_3d) return;

    auto payload = std::make_unique<TelemetryPayload>();
    payload->type = TelemetryPayload::TYPE_3D;
    payload->elapsed = (elapsed > 0.0) ? elapsed : global_t3d;
    payload->dt = (global_dt_3d > 1.0e-14) ? global_dt_3d : (global_solver_3d ? global_solver_3d->computeStepSize(global_cfl_3d.load()) : 0.0);
    payload->step = (step >= 0) ? step : std::max({global_step_3d.load(), global_step_fsi_3d.load(), global_step_fem_fsi_3d.load()});
    payload->is_terminated = is_terminated;
    payload->wallclock = global_wallclock_3d.load();
    payload->is_ideal_gas = global_solver_3d ? global_solver_3d->isIdealGas() : false;

    {
        double ram_mb = 0.0, vram_mb = 0.0;
        get_memory_breakdown(ram_mb, vram_mb);
        populate_timing_payload(payload.get(), ram_mb, vram_mb);
    }

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

    if ((global_solver_mpm_3d_cuda && global_solver_mpm_3d_cuda->getParticleCount() > 0) ||
        (global_solver_mpm_3d && !global_solver_mpm_3d->getParticles().empty())) {
        if (global_solver_mpm_3d_cuda && global_solver_mpm_3d_cuda->getParticleCount() > 0 && global_solver_mpm_3d_cuda->getStepCount() > 0) {
            global_solver_mpm_3d_cuda->syncParticlesToHost();
        }
        const auto& particles = (global_solver_mpm_3d_cuda && global_solver_mpm_3d_cuda->getParticleCount() > 0) ?
            global_solver_mpm_3d_cuda->getParticles() : global_solver_mpm_3d->getParticles();
        if (!particles.empty()) {
            size_t total_particles = particles.size();
            size_t stride = 1;
            int user_stride = global_mpm_particle_stride.load();
            if (user_stride > 1) {
                stride = static_cast<size_t>(user_stride);
            }
            size_t visual_count = (total_particles + stride - 1) / stride;
            payload->mpm_particles.reserve(visual_count * 8);
            for (size_t idx = 0; idx < total_particles; idx += stride) {
                const auto& p = particles[idx];
                if (p.m <= 0.0f || p.state == 2) continue;
                float diff_xy = p.sigma[0][0] - p.sigma[1][1];
                float diff_yz = p.sigma[1][1] - p.sigma[2][2];
                float diff_zx = p.sigma[2][2] - p.sigma[0][0];
                float s_xy = p.sigma[0][1]; float s_yz = p.sigma[1][2]; float s_zx = p.sigma[2][0];
                float von_mises = std::sqrt(0.5f * (diff_xy * diff_xy + diff_yz * diff_yz + diff_zx * diff_zx) +
                                            3.0f * (s_xy * s_xy + s_yz * s_yz + s_zx * s_zx));
                float press = - (p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
                const auto& mat_tbl = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getMaterialTable(p.object_id) : global_solver_mpm_3d->getMaterialTable(p.object_id);
                float den = mat_tbl.density;
                bool is_energetic = (mat_tbl.material_model == Blast::MPMMaterialModel::JWLProgrammedBurn ||
                                     mat_tbl.material_model == Blast::MPMMaterialModel::CRESTReactiveBurn ||
                                     mat_tbl.material_model == Blast::MPMMaterialModel::LeeTarverIgnitionGrowth);
                appendCompactMPMParticle(payload->mpm_particles,
                    p.x[0], p.x[1], p.x[2],
                    p.v[0], p.v[1], p.v[2],
                    von_mises, press, is_energetic ? p.lambda : p.ep_bar, den,
                    p.damage, p.has_failed, p.object_id, p.cluster_id);
            }
        }
    }

    if (global_phase_particles_3d && global_phase_particles_3d->getParticleCount() > 0) {
        if (global_phase_particles_3d->isCUDA()) {
            global_phase_particles_3d->syncToHost();
        }
        global_phase_particles_3d->extractTelemetry(payload->phase_particles);
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
        if (n_nodes > 0) {
            cuda_fem_float->extractTelemetry(payload->fem_node_data, payload->fem_facet_data);
            payload->fem_n_nodes = static_cast<uint32_t>(payload->fem_node_data.size() / 7);
            payload->fem_n_facets = static_cast<uint32_t>(payload->fem_facet_data.size() / 8);
        } else {
            payload->fem_n_nodes = 0;
            payload->fem_n_facets = 0;
        }
        payload->fem_v_max = static_cast<double>(cuda_fem_float->getMaxVelocity());
        payload->fem_sig_max = static_cast<double>(cuda_fem_float->getMaxVonMisesStress());
        payload->fem_ep_max = static_cast<double>(cuda_fem_float->getMaxPlasticStrain());
    } else if (cuda_fem_double) {
        size_t n_nodes = cuda_fem_double->getNodeCount();
        if (n_nodes > 0) {
            cuda_fem_double->extractTelemetry(payload->fem_node_data, payload->fem_facet_data);
            payload->fem_n_nodes = static_cast<uint32_t>(payload->fem_node_data.size() / 7);
            payload->fem_n_facets = static_cast<uint32_t>(payload->fem_facet_data.size() / 8);
        } else {
            payload->fem_n_nodes = 0;
            payload->fem_n_facets = 0;
        }
        payload->fem_v_max = cuda_fem_double->getMaxVelocity();
        payload->fem_sig_max = cuda_fem_double->getMaxVonMisesStress();
        payload->fem_ep_max = cuda_fem_double->getMaxPlasticStrain();
    } else if (fem_float) {
        size_t n_nodes = fem_float->getNodes().size();
        size_t n_facets = fem_float->getSurfaceFacets().size();
        const auto& trusses = fem_float->getTrusses();
        const auto& beams = fem_float->getBeams();
        size_t total_facets = n_facets + trusses.size() + beams.size();
        payload->fem_n_nodes = static_cast<uint32_t>(n_nodes);
        payload->fem_n_facets = static_cast<uint32_t>(total_facets);
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
            payload->fem_facet_data.resize(total_facets * 8);
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
            for (size_t t = 0; t < trusses.size(); ++t) {
                const auto& tr = trusses[t];
                payload->fem_facet_data[(n_facets + t) * 8 + 0] = static_cast<float>(tr.node_ids[0]);
                payload->fem_facet_data[(n_facets + t) * 8 + 1] = static_cast<float>(tr.node_ids[1]);
                payload->fem_facet_data[(n_facets + t) * 8 + 2] = -1.0f;
                payload->fem_facet_data[(n_facets + t) * 8 + 3] = -1.0f;
                payload->fem_facet_data[(n_facets + t) * 8 + 4] = static_cast<float>(std::abs(tr.sigma));
                payload->fem_facet_data[(n_facets + t) * 8 + 5] = static_cast<float>(tr.ep_bar);
                payload->fem_facet_data[(n_facets + t) * 8 + 6] = static_cast<float>(std::abs(tr.sigma * tr.A));
                payload->fem_facet_data[(n_facets + t) * 8 + 7] = tr.is_eroded ? 1.0f : 0.0f;
            }
            size_t beam_offset = n_facets + trusses.size();
            for (size_t b = 0; b < beams.size(); ++b) {
                const auto& bm = beams[b];
                float sig = static_cast<float>(bm.ep_bar > 0.0f ? (500.0e6f + 2.0e9f * bm.ep_bar) : 0.0f);
                float moment = static_cast<float>(bm.kappa2 * bm.kappa2 + bm.kappa3 * bm.kappa3);
                if (moment > 0.0f) moment = std::sqrt(moment);
                payload->fem_facet_data[(beam_offset + b) * 8 + 0] = static_cast<float>(bm.node_ids[0]);
                payload->fem_facet_data[(beam_offset + b) * 8 + 1] = static_cast<float>(bm.node_ids[1]);
                payload->fem_facet_data[(beam_offset + b) * 8 + 2] = -1.0f;
                payload->fem_facet_data[(beam_offset + b) * 8 + 3] = -1.0f;
                payload->fem_facet_data[(beam_offset + b) * 8 + 4] = sig;
                payload->fem_facet_data[(beam_offset + b) * 8 + 5] = static_cast<float>(bm.ep_bar);
                payload->fem_facet_data[(beam_offset + b) * 8 + 6] = moment;
                payload->fem_facet_data[(beam_offset + b) * 8 + 7] = bm.is_eroded ? 1.0f : 0.0f;
            }
        }
        payload->fem_v_max = static_cast<double>(fem_float->getMaxVelocity());
        payload->fem_sig_max = static_cast<double>(fem_float->getMaxVonMisesStress());
        payload->fem_ep_max = static_cast<double>(fem_float->getMaxPlasticStrain());
    } else if (fem_double) {
        size_t n_nodes = fem_double->getNodes().size();
        size_t n_facets = fem_double->getSurfaceFacets().size();
        const auto& trusses = fem_double->getTrusses();
        const auto& beams = fem_double->getBeams();
        size_t total_facets = n_facets + trusses.size() + beams.size();
        payload->fem_n_nodes = static_cast<uint32_t>(n_nodes);
        payload->fem_n_facets = static_cast<uint32_t>(total_facets);
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
            payload->fem_facet_data.resize(total_facets * 8);
            const auto& facets = fem_double->getSurfaceFacets();
            const auto& elements = fem_double->getElements();
            for (size_t f = 0; f < n_facets; ++f) {
                const auto& facet = facets[f];
                int elem_idx = facet.element_id;
                float vm = 0.0f, ep = 0.0f, press = 0.0f, dmg = 0.0f;
                if (elem_idx >= 0 && elem_idx < (int)elements.size()) {
                    const auto& elem = elements[elem_idx];
                    float s00 = static_cast<float>(elem.sigma[0][0]), s11 = static_cast<float>(elem.sigma[1][1]), s22 = static_cast<float>(elem.sigma[2][2]);
                    float s01 = static_cast<float>(elem.sigma[0][1]), s02 = static_cast<float>(elem.sigma[0][2]), s12 = static_cast<float>(elem.sigma[1][2]);
                    press = -(s00 + s11 + s22) / 3.0f;
                    float dev00 = s00 + press, dev11 = s11 + press, dev22 = s22 + press;
                    float vm_sq = dev00 * dev00 + dev11 * dev11 + dev22 * dev22 + 2.0f * (s01 * s01 + s02 * s02 + s12 * s12);
                    vm = std::sqrt(std::max(0.0f, 1.5f * vm_sq));
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
            for (size_t t = 0; t < trusses.size(); ++t) {
                const auto& tr = trusses[t];
                payload->fem_facet_data[(n_facets + t) * 8 + 0] = static_cast<float>(tr.node_ids[0]);
                payload->fem_facet_data[(n_facets + t) * 8 + 1] = static_cast<float>(tr.node_ids[1]);
                payload->fem_facet_data[(n_facets + t) * 8 + 2] = -1.0f;
                payload->fem_facet_data[(n_facets + t) * 8 + 3] = -1.0f;
                payload->fem_facet_data[(n_facets + t) * 8 + 4] = static_cast<float>(std::abs(tr.sigma));
                payload->fem_facet_data[(n_facets + t) * 8 + 5] = static_cast<float>(tr.ep_bar);
                payload->fem_facet_data[(n_facets + t) * 8 + 6] = static_cast<float>(std::abs(tr.sigma * tr.A));
                payload->fem_facet_data[(n_facets + t) * 8 + 7] = tr.is_eroded ? 1.0f : 0.0f;
            }
            size_t beam_offset = n_facets + trusses.size();
            for (size_t b = 0; b < beams.size(); ++b) {
                const auto& bm = beams[b];
                float sig = static_cast<float>(bm.ep_bar > 0.0 ? (500.0e6 + 2.0e9 * bm.ep_bar) : 0.0);
                float moment = static_cast<float>(bm.kappa2 * bm.kappa2 + bm.kappa3 * bm.kappa3);
                if (moment > 0.0f) moment = std::sqrt(moment);
                payload->fem_facet_data[(beam_offset + b) * 8 + 0] = static_cast<float>(bm.node_ids[0]);
                payload->fem_facet_data[(beam_offset + b) * 8 + 1] = static_cast<float>(bm.node_ids[1]);
                payload->fem_facet_data[(beam_offset + b) * 8 + 2] = -1.0f;
                payload->fem_facet_data[(beam_offset + b) * 8 + 3] = -1.0f;
                payload->fem_facet_data[(beam_offset + b) * 8 + 4] = sig;
                payload->fem_facet_data[(beam_offset + b) * 8 + 5] = static_cast<float>(bm.ep_bar);
                payload->fem_facet_data[(beam_offset + b) * 8 + 6] = moment;
                payload->fem_facet_data[(beam_offset + b) * 8 + 7] = bm.is_eroded ? 1.0f : 0.0f;
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
            bool emit_gauges = is_terminated || (step >= 0) || (std::chrono::duration_cast<std::chrono::milliseconds>(now - last_gauge_emit_time).count() >= 100);
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

void flush_async_telemetry() {
    std::unique_lock<std::mutex> lock(global_async_telemetry.mutex);
    global_async_telemetry.flush_cv.wait(lock, []() {
        return (global_async_telemetry.queue.empty() && !global_async_telemetry.in_flight) || global_async_telemetry.exit_flag;
    });
}

void stop_async_telemetry() {
    {
        std::lock_guard<std::mutex> lock(global_async_telemetry.mutex);
        global_async_telemetry.exit_flag = true;
    }
    global_async_telemetry.cv.notify_all();
    global_async_telemetry.flush_cv.notify_all();
}
