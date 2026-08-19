#include "system_memory_guard.hpp"
#include <iostream>
#include <fstream>
#include <sstream>
#include <iomanip>
#include <cmath>
#include <algorithm>

#if defined(__linux__)
#include <sys/sysinfo.h>
#elif defined(_WIN32)
#include <windows.h>
#endif

#if defined(__CUDACC__) || defined(USE_CUDA) || __has_include(<cuda_runtime.h>)
#include <cuda_runtime.h>
#define HAS_CUDA_RUNTIME 1
#endif

namespace Blast {

size_t getAvailableHostMemoryBytes() {
#if defined(__linux__)
    std::ifstream file("/proc/meminfo");
    std::string line;
    while (std::getline(file, line)) {
        if (line.rfind("MemAvailable:", 0) == 0) {
            size_t kb = 0;
            std::istringstream iss(line.substr(13));
            if (iss >> kb) {
                return kb * 1024ULL;
            }
        }
    }
    struct sysinfo info;
    if (sysinfo(&info) == 0) {
        return static_cast<size_t>(info.freeram) * static_cast<size_t>(info.mem_unit);
    }
#elif defined(_WIN32)
    MEMORYSTATUSEX status;
    status.dwLength = sizeof(status);
    if (GlobalMemoryStatusEx(&status)) {
        return static_cast<size_t>(status.ullAvailPhys);
    }
#endif
    // Fallback: 8 GB default assumption if unknown
    return 8ULL * 1024ULL * 1024ULL * 1024ULL;
}

size_t getAvailableCUDAMemoryBytes() {
#if defined(HAS_CUDA_RUNTIME)
    size_t free_bytes = 0;
    size_t total_bytes = 0;
    cudaError_t err = cudaMemGetInfo(&free_bytes, &total_bytes);
    if (err == cudaSuccess) {
        return free_bytes;
    }
#endif
    return 0;
}

static std::string formatMBorGB(size_t bytes) {
    double mb = static_cast<double>(bytes) / (1024.0 * 1024.0);
    std::ostringstream oss;
    oss << std::fixed << std::setprecision(2);
    if (mb >= 1024.0) {
        oss << (mb / 1024.0) << " GB";
    } else {
        oss << mb << " MB";
    }
    return oss.str();
}

MemoryEstimate estimateCFD3DMemory(int nx, int ny, int nz, bool is_cuda, bool is_double, bool is_multimat) {
    if (nx <= 0 || ny <= 0 || nz <= 0) return {0, 0};
    int ntx = (nx + 7) / 8;
    int nty = (ny + 7) / 8;
    int ntz = (nz + 7) / 8;
    size_t total_tiles = static_cast<size_t>(ntx) * static_cast<size_t>(nty) * static_cast<size_t>(ntz);
    
    size_t real_size = is_double ? sizeof(double) : sizeof(float);
    size_t num_vars = is_multimat ? 10 : 5;
    
    size_t tile_primitive_bytes = 512 * real_size * num_vars;
    size_t tile_conservative_bytes = 512 * real_size * num_vars;
    size_t tile_geom_bytes = 512 * real_size * 3;
    size_t tile_aux_bytes = 512 * 4; // Flags, indices, predictors
    
    size_t bytes_per_tile = tile_primitive_bytes + tile_conservative_bytes + tile_geom_bytes + tile_aux_bytes;
    
    // CFD 3D double buffers state tiles on both Host and GPU
    size_t host_bytes = static_cast<size_t>(total_tiles * bytes_per_tile * 1.3);
    size_t gpu_bytes = is_cuda ? static_cast<size_t>(total_tiles * bytes_per_tile * 1.5) : 0;
    
    return {host_bytes, gpu_bytes};
}

MemoryEstimate estimateCFD2DMemory(int nr, int nz, bool is_cuda, bool is_double, bool is_multimat) {
    if (nr <= 0 || nz <= 0) return {0, 0};
    size_t total_cells = static_cast<size_t>(nr) * static_cast<size_t>(nz);
    size_t real_size = is_double ? sizeof(double) : sizeof(float);
    size_t num_vars = is_multimat ? 10 : 5;
    size_t cell_bytes = real_size * num_vars * 4; // States, U, dU, aux
    
    size_t host_bytes = static_cast<size_t>(total_cells * cell_bytes * 1.2);
    size_t gpu_bytes = is_cuda ? static_cast<size_t>(total_cells * cell_bytes * 1.4) : 0;
    return {host_bytes, gpu_bytes};
}

MemoryEstimate estimateMPM3DMemory(int nx, int ny, int nz, size_t particle_count, bool is_cuda) {
    if (nx <= 0 || ny <= 0 || nz <= 0) return {0, 0};
    size_t grid_nodes = static_cast<size_t>(nx) * static_cast<size_t>(ny) * static_cast<size_t>(nz);
    size_t node_bytes = 128; // MPMGridNode3D struct size
    size_t particle_bytes = 256; // MPMParticle3D struct size
    
    size_t host_bytes = (grid_nodes * node_bytes) + (particle_count * particle_bytes * 2);
    size_t gpu_bytes = is_cuda ? (grid_nodes * node_bytes) + (particle_count * particle_bytes * 2) : 0;
    return {host_bytes, gpu_bytes};
}

MemoryEstimate estimateFEM3DMemory(size_t element_count, size_t node_count, bool is_cuda) {
    size_t node_bytes = 128;
    size_t elem_bytes = 256;
    size_t host_bytes = (node_count * node_bytes) + (element_count * elem_bytes * 2);
    size_t gpu_bytes = is_cuda ? (node_count * node_bytes) + (element_count * elem_bytes * 2) : 0;
    return {host_bytes, gpu_bytes};
}

void validateMemoryBudget(size_t required_ram_bytes, size_t required_vram_bytes, bool is_cuda, const std::string& solver_name) {
    size_t free_ram = getAvailableHostMemoryBytes();
    
    // Require leaving at least 1.0 GB RAM for OS stability
    size_t ram_safety_headroom = 1024ULL * 1024ULL * 1024ULL;
    size_t max_ram_allocatable = (free_ram > ram_safety_headroom) ? (free_ram - ram_safety_headroom) : (free_ram / 2);
    
    if (required_ram_bytes > max_ram_allocatable) {
        std::string err = "[MEMORY BUDGET EXCEEDED] " + solver_name + " requires " + formatMBorGB(required_ram_bytes) +
                          " Host RAM, but system only has " + formatMBorGB(free_ram) +
                          " available (" + formatMBorGB(max_ram_allocatable) + " safe allocatable limit). " +
                          "Allocation aborted to prevent Linux kernel swapping and system lockup.";
        std::cerr << err << std::endl;
        throw std::runtime_error(err);
    }
    
    if (is_cuda) {
        size_t free_vram = getAvailableCUDAMemoryBytes();
        if (free_vram > 0) {
            // Require leaving at least 512 MB VRAM for GPU driver / desktop display stability
            size_t vram_safety_headroom = 512ULL * 1024ULL * 1024ULL;
            size_t max_vram_allocatable = (free_vram > vram_safety_headroom) ? (free_vram - vram_safety_headroom) : free_vram;
            
            if (required_vram_bytes > max_vram_allocatable) {
                std::string err = "[MEMORY BUDGET EXCEEDED] " + solver_name + " requires " + formatMBorGB(required_vram_bytes) +
                                  " GPU VRAM, but device only has " + formatMBorGB(free_vram) +
                                  " free VRAM (" + formatMBorGB(max_vram_allocatable) + " safe allocatable limit). " +
                                  "Allocation aborted to prevent GPU driver crash.";
                std::cerr << err << std::endl;
                throw std::runtime_error(err);
            }
        }
    }
}

} // namespace Blast
