#include "vv_framework.hpp"
#include "vv_l1_unit_elements.hpp"
#include "vv_l2_canonical_benchmarks.hpp"
#include "vv_l3_component_tests.hpp"
#include "vv_l4_full_scale_systems.hpp"
#include <iostream>
#include <vector>
#include <iomanip>

int main(int argc, char** argv) {
    (void)argc; (void)argv;
    std::cout << "========================================================================\n";
    std::cout << "  BlastDaemon Autonomous Living V&V Engine (Master Directive 16)\n";
    std::cout << "  Executing Multi-Scale Multi-Physics Pyramid (Levels 1 through 4)\n";
    std::cout << "========================================================================\n\n";

    std::vector<Blast::VV::BenchmarkResult> all_results;

    // Run Level 1
    std::cout << "[RUNNING] Level 1: Unit & Single-Element / Constitutive Benchmarks...\n";
    auto l1 = Blast::VV::run_level_1_benchmarks();
    all_results.insert(all_results.end(), l1.begin(), l1.end());

    // Run Level 2
    std::cout << "[RUNNING] Level 2: Canonical Mesoscale Benchmarks...\n";
    auto l2 = Blast::VV::run_level_2_benchmarks();
    all_results.insert(all_results.end(), l2.begin(), l2.end());

    // Run Level 3
    std::cout << "[RUNNING] Level 3: Component & Subsystem Impact/Blast Tests...\n";
    auto l3 = Blast::VV::run_level_3_benchmarks();
    all_results.insert(all_results.end(), l3.begin(), l3.end());

    // Run Level 4
    std::cout << "[RUNNING] Level 4: Full-Scale 3D Multi-Physics System Test Cases...\n";
    auto l4 = Blast::VV::run_level_4_benchmarks();
    all_results.insert(all_results.end(), l4.begin(), l4.end());

    // Report Summary
    int passed = 0;
    int pending = 0;
    int failed = 0;
    std::cout << "\n========================================================================\n";
    std::cout << "  Benchmark Execution Summary\n";
    std::cout << "========================================================================\n";
    for (const auto& r : all_results) {
        if (r.pending) pending++;
        else if (r.passed) passed++;
        else failed++;
        std::string status_str = r.pending ? "[PENDING]" : (r.passed ? "[PASS]" : "[FAIL]");
        std::cout << "  " << std::left << std::setw(12) << r.id 
                  << std::setw(11) << status_str 
                  << " Level " << r.level << " - " << r.title << "\n";
    }

    std::cout << "\n------------------------------------------------------------------------\n";
    std::cout << "  Total: " << all_results.size() 
              << " | Passed: " << passed 
              << " | Pending: " << pending 
              << " | Failed: " << failed 
              << " | Active Pass Rate: " << std::fixed << std::setprecision(1) 
              << ((passed + failed > 0) ? (100.0 * passed / (passed + failed)) : 100.0) << "%\n";
    std::cout << "========================================================================\n\n";

    // Generate VERIFICATION_MANUAL.md in current directory and repository root
    std::string manual_path = "VERIFICATION_MANUAL.md";
    std::cout << "[OUTPUT] Compiling living verification compendium to: " << manual_path << "\n";
    Blast::VV::generate_verification_manual(manual_path, all_results);
    Blast::VV::generate_verification_manual("../VERIFICATION_MANUAL.md", all_results);

    return (failed == 0) ? 0 : 1;
}
