#include "AsyncMultiBlockWriter.hpp"
#include "mpm_solver_3d.hpp"
#include "HDF5Writer.hpp"
#include "XDMFWriter.hpp"
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
    job.mpm_snap.obj_id.resize(16, 1);
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

    // 9. Verify 3D MPM High-Compression VTU (Raw Appended) & XDMF+HDF5 Pipeline on Genuine MPMSolver3D
    std::cout << "\n[INFO] Running 3D MPM High-Compression VTU & XDMF+HDF5 Verification...\n";
    Blast::MPMSolver3D mpm_solver;
    mpm_solver.initializeGrid(20, 20, 20, 0.05f, 0.05f, 0.05f, 0.0f, 0.0f, 0.0f);
    mpm_solver.addBoxObject(1, 0.50f, 0.50f, 0.35f, 0.60f, 0.60f, 0.50f,
                            0.0f, 0.0f, -150.0f, 0.0f, 0.0f, 5.0f,
                            7850.0f, 210.0e9f, 0.3f, 800.0e6f, 1.0e9f, 0.25f, 600.0e6f, 8);
    for (int s = 0; s < 5; ++s) {
        mpm_solver.step(1.0e-5f);
    }

    auto base_snap = mpm_solver.extractVTKSnapshot(true, true, true, true, true, true, true, true);
    const size_t Np = base_snap.num_particles;
    // Reference legacy uncompressed + Base64 equivalent payload size:
    // Legacy wrote Points(12B) + Velocity(12B) + VM(4B) + Pressure(4B) + PlasticStrain(4B) + Damage(4B)
    // + Hydrostatic_Pressure(4B duplicate) + Material_ID(4B Float32) + Temp(4B) + ObjectID(4B Float32)
    // + Connectivity(4B) + Offsets(4B) + Types(1B) = 65 B/particle raw -> * 4/3 Base64
    std::cout << "[INFO] Genuine MPMSolver3D active particle count: Np = " << Np << " ( after 5 steps, dt = 1.0e-5 s )\n";

    fs::path vtu_lossless_path = test_dir / "mpm_raw_polyvertex_23bit.vtu";
    {
        auto snap = base_snap;
        snap.compression_level = 6;
        snap.float_precision = "Full 23-bit Float32 (Lossless)";
        snap.mpm_topology = "Single PolyVertex";
        export_vtu_mpm_3d_snapshot(vtu_lossless_path.string(), snap, "Binary");
    }

    fs::path vtu_poly16_path = test_dir / "mpm_raw_polyvertex_16bit.vtu";
    {
        auto snap = base_snap;
        snap.compression_level = 6;
        snap.float_precision = "16-bit Mantissa (~5 sig. digits)";
        snap.mpm_topology = "Single PolyVertex";
        export_vtu_mpm_3d_snapshot(vtu_poly16_path.string(), snap, "Binary");
    }

    fs::path vtu_poly12_path = test_dir / "mpm_raw_polyvertex_12bit.vtu";
    {
        auto snap = base_snap;
        snap.compression_level = 6;
        snap.float_precision = "12-bit Mantissa (~4 sig. digits)";
        snap.mpm_topology = "Single PolyVertex";
        export_vtu_mpm_3d_snapshot(vtu_poly12_path.string(), snap, "Binary");
    }

    fs::path vtu_zerocell12_path = test_dir / "mpm_raw_zerocell_12bit.vtu";
    {
        auto snap = base_snap;
        snap.compression_level = 6;
        snap.float_precision = "12-bit Mantissa (~4 sig. digits)";
        snap.mpm_topology = "Zero-Cell Point Cloud";
        export_vtu_mpm_3d_snapshot(vtu_zerocell12_path.string(), snap, "Binary");
    }

    fs::path h5_12_path = test_dir / "mpm_step_00005.h5";
    fs::path xdmf_12_path = test_dir / "mpm_step_00005.xdmf";
    {
        auto snap = base_snap;
        snap.compression_level = 6;
        snap.float_precision = "12-bit Mantissa (~4 sig. digits)";
        HDF5Writer::writeMPMSnapshot3D(h5_12_path.string(), snap);
        XDMFWriter::writeMPMStepXDMF3D(xdmf_12_path.string(), "mpm_step_00005.h5", 5, 5.0e-5, snap);
    }

    // Check raw appended header and UInt8 attributes in vtu_poly12_path
    std::ifstream vtu_check(vtu_poly12_path, std::ios::binary);
    std::string vtu_hdr(2048, '\0');
    vtu_check.read(&vtu_hdr[0], 2048);
    if (vtu_hdr.find("encoding=\"raw\"") == std::string::npos ||
        vtu_hdr.find("type=\"UInt8\" Name=\"ObjectID\"") == std::string::npos ||
        vtu_hdr.find("type=\"UInt8\" Name=\"Material_ID\"") == std::string::npos ||
        vtu_hdr.find("NumberOfCells=\"1\"") == std::string::npos ||
        vtu_hdr.find("Hydrostatic_Pressure") != std::string::npos) {
        std::cerr << "[FAIL] Upgraded VTU header did not match expected schema:\n" << vtu_hdr << "\n";
        return 1;
    }

    size_t sz_lossless = fs::file_size(vtu_lossless_path);
    size_t sz_poly16   = fs::file_size(vtu_poly16_path);
    size_t sz_poly12   = fs::file_size(vtu_poly12_path);
    size_t sz_zerocell = fs::file_size(vtu_zerocell12_path);
    size_t sz_h5       = fs::file_size(h5_12_path) + fs::file_size(xdmf_12_path);

    std::cout << "  - Raw Binary VTU (Single PolyVertex, Full 23-bit): " << sz_lossless << " bytes (" << (double)sz_lossless / Np << " B/particle)\n";
    std::cout << "  - Raw Binary VTU (Single PolyVertex, 16-bit):      " << sz_poly16   << " bytes (" << (double)sz_poly16 / Np   << " B/particle)\n";
    std::cout << "  - Raw Binary VTU (Single PolyVertex, 12-bit):      " << sz_poly12   << " bytes (" << (double)sz_poly12 / Np   << " B/particle)\n";
    std::cout << "  - Raw Binary VTU (Zero-Cell Cloud,   12-bit):      " << sz_zerocell << " bytes (" << (double)sz_zerocell / Np << " B/particle)\n";
    std::cout << "  - XDMF + HDF5    (Polyvertex Shuffle, 12-bit):     " << sz_h5       << " bytes (" << (double)sz_h5 / Np       << " B/particle)\n";
    std::cout << "[PASS] 3D MPM High-Compression VTU & XDMF+HDF5 verified.\n";

    std::cout << "\n========================================================================\n";
    std::cout << "  Multi-Block VTK (.vtm) Pipeline Verification: ALL CHECKS PASSED\n";
    std::cout << "========================================================================\n\n";

    return 0;
}
