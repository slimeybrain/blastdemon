#include "system_memory_guard.hpp"
#include <iostream>
#include <cassert>

int main() {
    std::cout << "==========================================================" << std::endl;
    std::cout << "      BlastSolver System Memory Guard Unit Test           " << std::endl;
    std::cout << "==========================================================" << std::endl;

    size_t host_ram = Blast::getAvailableHostMemoryBytes();
    size_t vram = Blast::getAvailableCUDAMemoryBytes();

    std::cout << "[INFO] Available Host RAM: " << (host_ram / (1024.0 * 1024.0 * 1024.0)) << " GB" << std::endl;
    std::cout << "[INFO] Available CUDA VRAM: " << (vram / (1024.0 * 1024.0 * 1024.0)) << " GB" << std::endl;

    assert(host_ram > 0);

    // Test 1: Normal reasonable allocation (100 MB)
    try {
        Blast::validateMemoryBudget(100ULL * 1024ULL * 1024ULL, 100ULL * 1024ULL * 1024ULL, false, "Test Normal");
        std::cout << "[PASS] Test 1: Reasonable allocation approved." << std::endl;
    } catch (const std::exception& e) {
        std::cerr << "[FAIL] Test 1 unexpected exception: " << e.what() << std::endl;
        return 1;
    }

    // Test 2: Extreme allocation (1000 TB) - must throw exception!
    bool caught_extreme = false;
    try {
        size_t extreme_bytes = 1000ULL * 1024ULL * 1024ULL * 1024ULL * 1024ULL; // 1000 TB
        Blast::validateMemoryBudget(extreme_bytes, extreme_bytes, false, "Test Extreme");
    } catch (const std::exception& e) {
        caught_extreme = true;
        std::cout << "[PASS] Test 2: Extreme allocation caught as expected -> " << e.what() << std::endl;
    }
    assert(caught_extreme);

    // Test 3: Realistic 100x100x100 MPM 3D on CUDA (500k particles)
    try {
        auto mpm_est = Blast::estimateMPM3DMemory(100, 100, 100, 500000, true);
        std::cout << "[INFO] Test 3 MPM 3D CUDA (100^3 grid, 500k particles): Host RAM = "
                  << (mpm_est.ram_bytes / (1024.0 * 1024.0)) << " MB, GPU VRAM = "
                  << (mpm_est.vram_bytes / (1024.0 * 1024.0)) << " MB" << std::endl;
        assert(mpm_est.ram_bytes < 1ULL * 1024ULL * 1024ULL * 1024ULL); // Must NOT require hundreds of GB!
        assert(mpm_est.vram_bytes < 1ULL * 1024ULL * 1024ULL * 1024ULL); // ~250 MB
        Blast::validateMemoryBudget(mpm_est.ram_bytes, mpm_est.vram_bytes, true, "Test 3 MPM 3D");
        std::cout << "[PASS] Test 3: Realistic MPM 3D model approved without false-positive rejection." << std::endl;
    } catch (const std::exception& e) {
        std::cerr << "[FAIL] Test 3 unexpected exception: " << e.what() << std::endl;
        return 1;
    }

    // Test 4: Runaway MPM model (5000x5000x5000 grid = 125B nodes) - must throw exception!
    bool caught_runaway_mpm = false;
    try {
        auto runaway_est = Blast::estimateMPM3DMemory(5000, 5000, 5000, 10000000, true);
        Blast::validateMemoryBudget(runaway_est.ram_bytes, runaway_est.vram_bytes, true, "Test Runaway MPM");
    } catch (const std::exception& e) {
        caught_runaway_mpm = true;
        std::cout << "[PASS] Test 4: Runaway MPM model caught as expected -> " << e.what() << std::endl;
    }

    if (!caught_runaway_mpm) {
        std::cerr << "[FAIL] Test 4: Runaway MPM model was not caught!" << std::endl;
        return 1;
    }

    std::cout << "==========================================================" << std::endl;
    std::cout << "   ALL SYSTEM MEMORY GUARD TESTS PASSED SUCCESSFULLY!     " << std::endl;
    std::cout << "==========================================================" << std::endl;
    return 0;
}
