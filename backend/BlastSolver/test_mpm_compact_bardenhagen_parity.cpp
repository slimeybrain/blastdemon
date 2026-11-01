// Standalone driver for the compact vs dense Bardenhagen storage parity benchmarks
// (same code as the blast_verify Level 2 entries VV-L2-CMP-00 .. 03).
// Build: cmake -DBUILD_TESTS=ON .. && make test_mpm_compact_bardenhagen_parity
// Requires a free GPU (small grids, a few tens of MB of VRAM).
#include "verification/vv_mpm_compact_contact.hpp"

#include <iostream>

int main() {
    std::cout << "========================================================\n";
    std::cout << " GPU MPM compact vs dense Bardenhagen storage parity\n";
    std::cout << "========================================================\n\n";

    auto results = Blast::VV::run_mpm_compact_contact_benchmarks();
    int failed = 0;
    for (const auto& r : results) {
        std::cout << (r.passed ? "[PASS] " : "[FAIL] ") << r.id << "  " << r.title << "\n"
                  << "  " << r.summary << "\n"
                  << "  " << r.details << "\n\n";
        if (!r.passed) failed++;
    }
    std::cout << (failed == 0 ? "ALL PARITY CHECKS PASSED\n" : "PARITY CHECKS FAILED\n");
    return failed == 0 ? 0 : 1;
}
