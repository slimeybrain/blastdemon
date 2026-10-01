#include "AsyncMultiBlockWriter.hpp"
#include <iostream>
#include <fstream>
#include <filesystem>
#include <cassert>
#include <cmath>

namespace fs = std::filesystem;

int main() {
    std::cout << "========================================================================\n";
    std::cout << "  Multi-Block VTK (.vtm) & Asynchronous Writer Verification Test\n";
    std::cout << "========================================================================\n\n";

    fs::path test_dir = "./build/vtm_test";
    fs::create_directories(test_dir);

    // 1. Set up multi-physics test job
    Blast::MarineHarbourMultiBlockJob job;
    job.timestep_index = 450;
    job.sim_time = 0.0450;
    job.base_dir = test_dir.string();
    job.base_prefix = "harbour_step_00450";
    job.pvd_filename = "harbour_simulation.pvd";

    // Block 0: Eulerian CFD Far-Field (Structured Grid .vts)
    job.has_cfd_block = true;
    job.cfd_block_name = "Eulerian CFD Far-Field";
    job.cfd_snap.nx = 4;
    job.cfd_snap.ny = 4;
    job.cfd_snap.nz = 4;
    job.cfd_snap.cellSize = 0.25;
    job.cfd_snap.xmin = -0.5;
    job.cfd_snap.ymin = -0.5;
    job.cfd_snap.zmin = 0.0;
    job.cfd_snap.has_p = true;
    job.cfd_snap.p.resize(4 * 4 * 4, 101325.0f);
    job.cfd_snap.has_rho = true;
    job.cfd_snap.rho.resize(4 * 4 * 4, 1025.0f);
    job.cfd_snap.has_vel = true;
    job.cfd_snap.vel.resize(4 * 4 * 4 * 3, 0.0f);
    job.cfd_snap.has_overpressure = true;
    job.cfd_snap.overpressure.resize(4 * 4 * 4, 2.5e6f);

    // Block 1: Lagrangian MPM Core (PolyData .vtp)
    job.has_mpm_block = true;
    job.mpm_block_name = "Lagrangian MPM Core";
    job.mpm_snap.num_particles = 16;
    job.mpm_snap.points.resize(16 * 3);
    job.mpm_snap.vel.resize(16 * 3, 0.0f);
    job.mpm_snap.von_mises.resize(16, 50.0e6f);
    job.mpm_snap.pressure.resize(16, 12.0e6f);
    job.mpm_snap.ep_bar.resize(16, 0.05f);
    job.mpm_snap.damage.resize(16, 0.0f);
    job.mpm_snap.temp.resize(16, 320.0f);
    job.mpm_snap.obj_id.resize(16, 1.0f);
    for (int p = 0; p < 16; ++p) {
        job.mpm_snap.points[p * 3 + 0] = static_cast<float>(0.1 * (p % 4));
        job.mpm_snap.points[p * 3 + 1] = static_cast<float>(0.1 * ((p / 4) % 4));
        job.mpm_snap.points[p * 3 + 2] = 0.5f;
    }

    // Block 2: Geotechnical Seabed (Unstructured Grid .vtu Hex8)
    job.has_fem_block = true;
    job.fem_block_name = "Geotechnical Seabed";
    job.fem_snap.num_points = 8;
    job.fem_snap.num_cells = 1;
    job.fem_snap.points = {
        0.0f, 0.0f, -1.0f,
        1.0f, 0.0f, -1.0f,
        1.0f, 1.0f, -1.0f,
        0.0f, 1.0f, -1.0f,
        0.0f, 0.0f,  0.0f,
        1.0f, 0.0f,  0.0f,
        1.0f, 1.0f,  0.0f,
        0.0f, 1.0f,  0.0f
    };
    job.fem_snap.connectivity = { 0, 1, 2, 3, 4, 5, 6, 7 };
    job.fem_snap.offsets = { 8 };
    job.fem_snap.types = { 12 }; // VTK_HEXAHEDRON
    job.fem_snap.material_id = { 0 };
    job.fem_snap.part_id = { 1 };
    job.fem_snap.element_type = { 0 };
    job.fem_snap.von_mises = { 8.5e6f };
    job.fem_snap.plastic_strain = { 0.002f };
    job.fem_snap.pressure = { 4.0e6f };
    job.fem_snap.temperature = { 285.0f };
    job.fem_snap.damage = { 0.0f };

    job.format = "Binary";

    // 2. Dispatch to AsyncMultiBlockWriter
    std::cout << "[INFO] Enqueuing multi-block dataset to AsyncMultiBlockWriter...\n";
    Blast::AsyncMultiBlockWriter::getInstance().enqueue(std::move(job));

    // 3. Flush background thread
    std::cout << "[INFO] Flushing asynchronous write queue...\n";
    Blast::AsyncMultiBlockWriter::getInstance().flush();

    // 4. Validate output files
    fs::path b0_path = test_dir / "harbour_step_00450_block0.vts";
    fs::path b1_path = test_dir / "harbour_step_00450_block1.vtp";
    fs::path b2_path = test_dir / "harbour_step_00450_block2.vtu";
    fs::path vtm_path = test_dir / "harbour_step_00450.vtm";
    fs::path pvd_path = test_dir / "harbour_simulation.pvd";

    if (!fs::exists(b0_path)) {
        std::cerr << "[FAIL] Block 0 (.vts) missing: " << b0_path << "\n";
        return 1;
    }
    if (!fs::exists(b1_path)) {
        std::cerr << "[FAIL] Block 1 (.vtp) missing: " << b1_path << "\n";
        return 1;
    }
    if (!fs::exists(b2_path)) {
        std::cerr << "[FAIL] Block 2 (.vtu) missing: " << b2_path << "\n";
        return 1;
    }
    if (!fs::exists(vtm_path)) {
        std::cerr << "[FAIL] Multi-block container (.vtm) missing: " << vtm_path << "\n";
        return 1;
    }
    if (!fs::exists(pvd_path)) {
        std::cerr << "[FAIL] Collection (.pvd) missing: " << pvd_path << "\n";
        return 1;
    }

    std::cout << "[PASS] All 5 multi-block files generated on disk.\n";

    // 5. Verify VTM structure
    std::ifstream vtm_in(vtm_path);
    std::string vtm_content((std::istreambuf_iterator<char>(vtm_in)), std::istreambuf_iterator<char>());
    if (vtm_content.find("type=\"vtkMultiBlockDataSet\"") == std::string::npos ||
        vtm_content.find("harbour_step_00450_block0.vts") == std::string::npos ||
        vtm_content.find("harbour_step_00450_block1.vtp") == std::string::npos ||
        vtm_content.find("harbour_step_00450_block2.vtu") == std::string::npos) {
        std::cerr << "[FAIL] VTM content does not match expected multi-block tree:\n" << vtm_content << "\n";
        return 1;
    }
    std::cout << "[PASS] .vtm references Block 0 (.vts), Block 1 (.vtp), and Block 2 (.vtu).\n";

    // 6. Verify PVD structure
    std::ifstream pvd_in(pvd_path);
    std::string pvd_content((std::istreambuf_iterator<char>(pvd_in)), std::istreambuf_iterator<char>());
    if (pvd_content.find("type=\"Collection\"") == std::string::npos ||
        pvd_content.find("harbour_step_00450.vtm") == std::string::npos) {
        std::cerr << "[FAIL] PVD content does not reference .vtm container:\n" << pvd_content << "\n";
        return 1;
    }
    std::cout << "[PASS] .pvd time series collection references harbour_step_00450.vtm at t=0.045 s.\n";

    // 7. Verify VTS structure
    std::ifstream vts_in(b0_path);
    std::string vts_content((std::istreambuf_iterator<char>(vts_in)), std::istreambuf_iterator<char>());
    if (vts_content.find("type=\"StructuredGrid\"") == std::string::npos ||
        vts_content.find("WholeExtent=\"0 4 0 4 0 4\"") == std::string::npos) {
        std::cerr << "[FAIL] VTS content does not match StructuredGrid:\n" << vts_content << "\n";
        return 1;
    }
    std::cout << "[PASS] .vts StructuredGrid WholeExtent is 0 4 0 4 0 4.\n";

    // 8. Verify VTP structure
    std::ifstream vtp_in(b1_path);
    std::string vtp_content((std::istreambuf_iterator<char>(vtp_in)), std::istreambuf_iterator<char>());
    if (vtp_content.find("type=\"PolyData\"") == std::string::npos ||
        vtp_content.find("NumberOfPoints=\"16\"") == std::string::npos) {
        std::cerr << "[FAIL] VTP content does not match PolyData:\n" << vtp_content << "\n";
        return 1;
    }
    std::cout << "[PASS] .vtp PolyData NumberOfPoints is 16.\n";

    std::cout << "\n========================================================================\n";
    std::cout << "  Multi-Block VTK (.vtm) Pipeline Verification: ALL CHECKS PASSED\n";
    std::cout << "========================================================================\n\n";

    return 0;
}
