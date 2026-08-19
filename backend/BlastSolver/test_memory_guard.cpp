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

    if (!caught_extreme) {
        std::cerr << "[FAIL] Test 2: Extreme allocation was not caught!" << std::endl;
        return 1;
    }

    std::cout << "==========================================================" << std::endl;
    std::cout << "   ALL SYSTEM MEMORY GUARD TESTS PASSED SUCCESSFULLY!     " << std::endl;
    std::cout << "==========================================================" << std::endl;
    return 0;
}
