#pragma once
#include <cstddef>
#include <string>
#include <stdexcept>
#include <iostream>

namespace Blast {

/**
 * Returns available physical host RAM in bytes.
 * Reads /proc/meminfo MemAvailable on Linux or GlobalMemoryStatusEx on Windows.
 */
size_t getAvailableHostMemoryBytes();

/**
 * Returns available CUDA GPU VRAM in bytes.
 * Uses cudaMemGetInfo if CUDA is available, otherwise returns 0.
 */
size_t getAvailableCUDAMemoryBytes();

/**
 * Memory footprint estimation helpers (returns estimated bytes required for RAM & VRAM).
 */
struct MemoryEstimate {
    size_t ram_bytes{0};
    size_t vram_bytes{0};
};

MemoryEstimate estimateCFD3DMemory(int nx, int ny, int nz, bool is_cuda, bool is_double, bool is_multimat);
MemoryEstimate estimateCFD2DMemory(int nr, int nz, bool is_cuda, bool is_double, bool is_multimat);
MemoryEstimate estimateMPM3DMemory(int nx, int ny, int nz, size_t particle_count, bool is_cuda);
MemoryEstimate estimateFEM3DMemory(size_t element_count, size_t node_count, bool is_cuda);

/**
 * Validates requested memory allocation against available system resources.
 * Throws std::runtime_error if required memory exceeds available thresholds.
 */
void validateMemoryBudget(size_t required_ram_bytes, size_t required_vram_bytes, bool is_cuda, const std::string& solver_name);

} // namespace Blast
