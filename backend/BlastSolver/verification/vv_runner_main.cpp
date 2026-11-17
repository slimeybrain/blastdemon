#include <string>
#include "vv_framework.hpp"
#include "vv_l1_unit_elements.hpp"
#include "vv_l2_canonical_benchmarks.hpp"
#include "vv_l3_component_tests.hpp"
#include "vv_l4_full_scale_systems.hpp"
#include "vv_mpm_compact_contact.hpp"
#include "vv_mpm_sparse_grid.hpp"
#include "vv_lee_tarver.hpp"
#include "vv_mat_audit.hpp"
#include "vv_fem_coupling_fixes.hpp"
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

    if (argc > 4 && std::string(argv[1]) == "--lt-trace") {
        Blast::VV::run_lee_tarver_trace(std::atoi(argv[2]), std::atof(argv[3]), std::atof(argv[4]), !(argc > 5 && std::atoi(argv[5]) == 0));
        return 0;
    }
    if (argc > 1 && std::string(argv[1]) == "--lee-tarver") {
        for (const auto& b : Blast::VV::run_lee_tarver_benchmarks()) {
            std::cout << b.id << " " << (b.pending ? "PENDING" : (b.passed ? "PASS" : "FAIL")) << " | " << b.summary << "\n" << b.details << "\n";
        }
        return 0;
    }

    if (argc > 1 && std::string(argv[1]) == "--mat-audit") {
        int mat_fail = 0;
        for (const auto& b : Blast::VV::run_material_audit_benchmarks()) {
            if (!b.pending && !b.passed) mat_fail++;
            std::cout << b.id << " " << (b.pending ? "PENDING" : (b.passed ? "PASS" : "FAIL")) << " | " << b.summary << "\n" << b.details << "\n\n";
        }
        return (mat_fail == 0) ? 0 : 1;
    }

    if (argc > 1 && std::string(argv[1]) == "--fem-coupling") {
        int fem_fail = 0;
        for (const auto& b : Blast::VV::run_fem_coupling_fixes_benchmarks()) {
            if (!b.pending && !b.passed) fem_fail++;
            std::cout << b.id << " " << (b.pending ? "PENDING" : (b.passed ? "PASS" : "FAIL")) << " | " << b.summary << "\n" << b.details << "\n\n";
        }
        return (fem_fail == 0) ? 0 : 1;
    }

    // Run Level 1
    std::cout << "[RUNNING] Level 1: Unit & Single-Element / Constitutive Benchmarks...\n";
    auto l1 = Blast::VV::run_level_1_benchmarks();
    all_results.insert(all_results.end(), l1.begin(), l1.end());

    // Run Material & Constitutive Audit Suite (VV-MAT-01 .. VV-MAT-12)
    std::cout << "[RUNNING] Material Constitutive & 5-Solver Parity Suite (VV-MAT-AUDIT)...\n";
    auto ma = Blast::VV::run_material_audit_benchmarks();
    all_results.insert(all_results.end(), ma.begin(), ma.end());

    // Run Level 2
    std::cout << "[RUNNING] Level 2: Canonical Mesoscale Benchmarks...\n";
    auto l2 = Blast::VV::run_level_2_benchmarks();
    all_results.insert(all_results.end(), l2.begin(), l2.end());

    // Level 2 (GPU MPM): compact vs dense Bardenhagen multi-material storage parity
    std::cout << "[RUNNING] Level 2: GPU MPM compact multi-material storage parity...\n";
    auto l2_cmp = Blast::VV::run_mpm_compact_contact_benchmarks();
    all_results.insert(all_results.end(), l2_cmp.begin(), l2_cmp.end());

    // Level 2 (MPM Sparse Grid): 2D CPU, 3D CPU, and 3D GPU sparse vs dense grid parity
    std::cout << "[RUNNING] Level 2: MPM block-sparse vs dense grid parity...\n";
    auto l2_spr = Blast::VV::run_mpm_sparse_grid_benchmarks();
    all_results.insert(all_results.end(), l2_spr.begin(), l2_spr.end());

    // Level 1/2 (Lee-Tarver): SI rate constants, JWLReactant EOS, mixture rule (pop-plot pending)
    std::cout << "[RUNNING] Lee-Tarver Ignition & Growth / JWLReactant / mixture-rule verification...\n";
    auto lt = Blast::VV::run_lee_tarver_benchmarks();
    all_results.insert(all_results.end(), lt.begin(), lt.end());

    // Run Level 3
    std::cout << "[RUNNING] Level 3: Component & Subsystem Impact/Blast Tests...\n";
    auto l3 = Blast::VV::run_level_3_benchmarks();
    all_results.insert(all_results.end(), l3.begin(), l3.end());

    // Coupled MPM-FEM contact, Tet4/KosloffFrazier, and per-part isolation verification
    std::cout << "[RUNNING] Level 2/3: FEM-MPM Coupling, Tet4/ANP/KF & Per-Part Isolation...\n";
    auto fc = Blast::VV::run_fem_coupling_fixes_benchmarks();
    all_results.insert(all_results.end(), fc.begin(), fc.end());

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
