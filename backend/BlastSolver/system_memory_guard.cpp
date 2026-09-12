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

size_t getTotalHostMemoryBytes() {
#if defined(__linux__)
    struct sysinfo info;
    if (sysinfo(&info) == 0) {
        return static_cast<size_t>(info.totalram) * static_cast<size_t>(info.mem_unit);
    }
#elif defined(_WIN32)
    MEMORYSTATUSEX status;
    status.dwLength = sizeof(status);
    if (GlobalMemoryStatusEx(&status)) {
        return static_cast<size_t>(status.ullTotalPhys);
    }
#endif
    return 16ULL * 1024ULL * 1024ULL * 1024ULL;
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

size_t getTotalCUDAMemoryBytes() {
#if defined(HAS_CUDA_RUNTIME)
    size_t free_bytes = 0;
    size_t total_bytes = 0;
    cudaError_t err = cudaMemGetInfo(&free_bytes, &total_bytes);
    if (err == cudaSuccess) {
        return total_bytes;
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
    
    if (is_cuda) {
        // CUDA MPM Solver accurate VRAM breakdown:
        //   d_grid           = sizeof(MPMGridNode3D) = alignas(32) struct: 44B padded to 64B
        //   d_grid_n         = sizeof(float)          = 4B
        //   d_active_nodes   = sizeof(int)            = 4B
        //                    Total per grid node      = 72B
        //   d_soa_buffer     = 34 floats + 4 ints     = 152B  }
        //   d_compaction_indices = 2 ints              = 8B    } per particle = 160B
        //   Base buffers & scratch overhead = 64 MB
        size_t gpu_bytes = (grid_nodes * 72ULL) + (particle_count * 160ULL) + (64ULL * 1024ULL * 1024ULL);
        // Host RAM: Particle staging buffer during init + solver base overhead (~64 MB)
        // Note: m_host_grid is lazy and not allocated during simulation execution.
        size_t host_bytes = (particle_count * 256ULL) + (64ULL * 1024ULL * 1024ULL);
        return {host_bytes, gpu_bytes};
    } else {
        // CPU MPM Solver:
        // Host RAM: grid nodes (128B) + particle list with dynamic growth headroom (256B * 2)
        size_t host_bytes = (grid_nodes * 128ULL) + (particle_count * 256ULL * 2);
        return {host_bytes, 0};
    }
}

MemoryEstimate estimateFEM3DMemory(size_t element_count, size_t node_count, bool is_cuda) {
    size_t node_bytes = 128;
    size_t elem_bytes = 256;
    if (is_cuda) {
        size_t gpu_bytes = (node_count * node_bytes) + (element_count * elem_bytes) + (64ULL * 1024ULL * 1024ULL);
        size_t host_bytes = (node_count * node_bytes) + (element_count * elem_bytes) + (64ULL * 1024ULL * 1024ULL);
        return {host_bytes, gpu_bytes};
    } else {
        size_t host_bytes = (node_count * node_bytes) + (element_count * elem_bytes * 2);
        return {host_bytes, 0};
    }
}

void validateMemoryBudget(size_t required_ram_bytes, size_t required_vram_bytes, bool is_cuda, const std::string& solver_name) {
    size_t free_ram = getAvailableHostMemoryBytes();
    size_t total_ram = getTotalHostMemoryBytes();
    
    // Safety headroom for OS & system stability (leave at least 2.0 GB host RAM)
    size_t ram_safety_headroom = 2048ULL * 1024ULL * 1024ULL;
    size_t max_safe_total_ram = (total_ram > ram_safety_headroom) ? (total_ram - ram_safety_headroom) : (total_ram * 3 / 4);
    
    if (required_ram_bytes > max_safe_total_ram) {
        std::string err = "[MEMORY BUDGET EXCEEDED] " + solver_name + " requires " + formatMBorGB(required_ram_bytes) +
                          " Host RAM, exceeding safe physical system memory capacity (" + formatMBorGB(total_ram) +
                          " total, " + formatMBorGB(max_safe_total_ram) + " safe allocatable limit). " +
                          "Allocation aborted to prevent Linux kernel swapping and system lockup.";
        std::cerr << err << std::endl;
        throw std::runtime_error(err);
    }
    
    if (required_ram_bytes > free_ram) {
        std::cout << "[MEMORY NOTICE] " << solver_name << " requires " << formatMBorGB(required_ram_bytes) <<
                     " Host RAM, which temporarily exceeds currently available unbuffered RAM (" << formatMBorGB(free_ram) <<
                     "). Proceeding against physical capacity (" << formatMBorGB(total_ram) << ")." << std::endl;
    }
    
    if (is_cuda) {
#if defined(HAS_CUDA_RUNTIME)
        size_t free_vram = 0;
        size_t total_vram = 0;
        cudaError_t err = cudaMemGetInfo(&free_vram, &total_vram);
        if (err == cudaSuccess && total_vram > 0) {
            // Hard-reject only if the pre-flight estimate clearly exceeds physical capacity by a
            // significant margin (>150% total VRAM). Memory estimates are inherently conservative;
            // the actual cudaMalloc already throws a clean CUDA_CHECK_ALLOC exception if truly OOM.
            size_t hard_reject_threshold = total_vram + (total_vram / 2); // 1.5x total VRAM
            if (required_vram_bytes > hard_reject_threshold) {
                std::string err_msg = "[MEMORY BUDGET EXCEEDED] " + solver_name + " estimated " + formatMBorGB(required_vram_bytes) +
                                  " GPU VRAM, which is clearly impossible on this device (" + formatMBorGB(total_vram) +
                                  " total). Allocation aborted to prevent GPU driver crash.";
                std::cerr << err_msg << std::endl;
                throw std::runtime_error(err_msg);
            }

            // Soft-warn when estimate exceeds the conservative safe-headroom limit but is
            // within the hard-reject threshold. The actual allocator will catch a true OOM.
            size_t vram_safety_headroom = 1536ULL * 1024ULL * 1024ULL;
            size_t max_vram_allocatable = (total_vram > vram_safety_headroom) ? (total_vram - vram_safety_headroom) : (total_vram * 3 / 4);
            if (required_vram_bytes > max_vram_allocatable) {
                std::cout << "[MEMORY WARNING] " << solver_name << " estimated " << formatMBorGB(required_vram_bytes) <<
                             " GPU VRAM, exceeding the conservative safe limit (" << formatMBorGB(max_vram_allocatable) <<
                             ") on a " << formatMBorGB(total_vram) << " device. Proceeding — actual allocation will"
                             " throw a clean error if the device is truly OOM." << std::endl;
            } else if (required_vram_bytes > free_vram) {
                std::cout << "[MEMORY NOTICE] " << solver_name << " requires " << formatMBorGB(required_vram_bytes) <<
                             " GPU VRAM. Device currently has " << formatMBorGB(free_vram) << " free / " <<
                             formatMBorGB(total_vram) << " total VRAM. Proceeding with allocation." << std::endl;
            }
        } else if (required_vram_bytes > (96ULL * 1024ULL * 1024ULL * 1024ULL)) {
            std::string err_msg = "[MEMORY BUDGET EXCEEDED] " + solver_name + " requires " + formatMBorGB(required_vram_bytes) +
                              " GPU VRAM, exceeding maximum physical enterprise GPU capacity (96 GB). Allocation aborted.";
            std::cerr << err_msg << std::endl;
            throw std::runtime_error(err_msg);
        }
#else
        if (required_vram_bytes > (96ULL * 1024ULL * 1024ULL * 1024ULL)) {
            std::string err_msg = "[MEMORY BUDGET EXCEEDED] " + solver_name + " requires " + formatMBorGB(required_vram_bytes) +
                              " GPU VRAM, exceeding maximum physical enterprise GPU capacity (96 GB). Allocation aborted.";
            std::cerr << err_msg << std::endl;
            throw std::runtime_error(err_msg);
        }
#endif
    }
}

} // namespace Blast
