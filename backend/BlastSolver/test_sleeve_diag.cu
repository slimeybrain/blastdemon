#include <iostream>
#include <iomanip>
#include <vector>
#include <cmath>
#include "cfd_solver_3d_cuda.hpp"
#include "mpm_solver_3d_cuda.hpp"

int main() {
    double cellSize = 0.2;
    double xmin = -4.0, xmax = 4.0;
    double ymin = -4.0, ymax = 4.0;
    double zmin = 0.0, zmax = 10.0;

    int nx = (int)round((xmax - xmin) / cellSize);
    int ny = (int)round((ymax - ymin) / cellSize);
    int nz = (int)round((zmax - zmin) / cellSize);

    std::cout << "==========================================================" << std::endl;
    std::cout << "DIAGNOSTIC TEST: Marine Harbour Sleeve Stratified Coupling" << std::endl;
    std::cout << "Grid: " << nx << " x " << ny << " x " << nz << ", dx=" << cellSize << std::endl;

    Blast::Stratified3DParams strat;
    strat.enabled = true;
    strat.air_rho = 1.225;
    strat.p_atm = 101325.0;
    strat.gravity_z = -9.81;
    strat.water_surface_z = 10.0;
    strat.seabed_surface_z = 2.0;
    strat.k0_earth_pressure = 0.50;
    strat.tait_B = 3.039e8;
    strat.tait_gamma = 7.15;
    strat.tait_rho0 = 1025.0;
    strat.soil_density = 2000.0;
    strat.soil_c0 = 2500.0;
    strat.soil_gamma = 4.0;
    strat.soil_s = 1.35;
    strat.soil_gruneisen = 1.45;
    strat.soil_p_cav = -1.0e5;
    strat.soil_eos_variant = 0;

    // 1. Initialize CFD Solver
    CFDSolver3DCuda<float, true> cfd(nx, ny, nz, cellSize, xmin, ymin, zmin);
    cfd.setFluxScheme("AUSM+");
    cfd.setSpatialOrder(2);
    cfd.setTemporalOrder(5); // ADER-2
    cfd.setBoundaryConditions(
        BCType3D::REFLECTIVE, BCType3D::REFLECTIVE,
        BCType3D::REFLECTIVE, BCType3D::REFLECTIVE,
        BCType3D::REFLECTIVE, BCType3D::OUTFLOW_RIEMANN
    );
    cfd.setGravity(0.0, 0.0, strat.gravity_z);

    Charge3DParams cp;
    cp.radius = 0.0; // Quiescent baseline first
    MultiMat::MaterialSet matSet;
    cfd.setStratifiedInitialCondition(cp, matSet, strat);

    // 2. Initialize MPM Solver
    Blast::MPMSolver3DCUDA mpm;
    mpm.initializeGrid(nx, ny, nz, static_cast<float>(cellSize), static_cast<float>(cellSize), static_cast<float>(cellSize), static_cast<float>(xmin), static_cast<float>(ymin), static_cast<float>(zmin));
    mpm.setGravity(0.0f, 0.0f, static_cast<float>(strat.gravity_z));

    // Add water sleeve sphere at (0, 0, 5), radius 2.5m
    int obj_idx = 1;
    float chgX = 0.0f, chgY = 0.0f, chgZ = 5.0f;
    float sleeveR = 2.5f;
    int ppc = 8;
    mpm.addSphereObject(
        obj_idx, chgX, chgY, chgZ, sleeveR, 0.0f,
        0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
        static_cast<float>(strat.tait_rho0),
        2.2e9f, 0.499f, 0.0f, 0.0f, 0.0f, 0.0f,
        ppc, Blast::MPMParticleDistribution::Cartesian, Blast::MPMBoundaryFilling::Stairstepped,
        0.0f, 0.0f, 0.0f, 2.0f, static_cast<float>(strat.water_surface_z)
    );

    // Set material table for TaitWater
    Blast::MaterialTable3D water_mat;
    water_mat.material_model = Blast::MPMMaterialModel::TaitWater;
    water_mat.density = static_cast<float>(strat.tait_rho0);
    water_mat.tait_B = static_cast<float>(strat.tait_B);
    water_mat.tait_gamma = static_cast<float>(strat.tait_gamma);
    water_mat.tait_rho0 = static_cast<float>(strat.tait_rho0);
    water_mat.tait_c0 = 1482.0f;
    water_mat.tait_p_cav = 0.0f;
    water_mat.tait_p0 = static_cast<float>(strat.p_atm);
    water_mat.tait_viscosity = 1.0e-3f;

    auto& mat_tables = mpm.getMaterialTables();
    if (mat_tables.size() <= static_cast<size_t>(obj_idx)) {
        mat_tables.resize(obj_idx + 1);
    }
    mat_tables[obj_idx] = water_mat;

    std::vector<int> obj_to_mat = {0, 0}; // obj 1 maps to mat 0
    mpm.setObjectMaterialMapping(obj_to_mat, 1);

    // Apply Stratified Initial Condition
    mpm.applyStratifiedInitialCondition(strat);
    mpm.uploadMaterialTableToDevice();
    mpm.syncToDevice();

    Blast::ZonalHandoff3DParams zonal_params;
    zonal_params.enabled = true;
    zonal_params.center_x = chgX;
    zonal_params.center_y = chgY;
    zonal_params.center_z = chgZ;
    zonal_params.sleeve_radius = sleeveR;
    zonal_params.overlap_thickness = 0.4;
    cfd.setZonalHandoffParams(zonal_params);
    mpm.setZonalHandoffParams(zonal_params);

    mpm.particleToGridDeviceOnly();
    cfd.coupleZonalHandoffWithMPMGPU(&mpm);

    std::cout << "MPM Particles Created: " << mpm.getParticleCount() << std::endl;

    // 3. Inspect Initial Pressures Across Elevation z
    std::cout << "\n--- STEP 0: Initial Pressure Comparison ---" << std::endl;
    std::cout << std::setw(8) << "z (m)" 
              << std::setw(15) << "P_exact (Pa)" 
              << std::setw(15) << "P_CFD (Pa)" 
              << std::setw(15) << "P_MPM (Pa)" 
              << std::setw(15) << "Err_CFD (%)" 
              << std::setw(15) << "Err_MPM (%)" << std::endl;

    mpm.syncParticlesToHost();
    const auto& particles = mpm.getParticles();

    Slice3D slice_p;
    slice_p.axis = "xz";
    slice_p.offset = 0.0;
    slice_p.quantities = {"pressure"};
    std::vector<float> p_cfd_slice = cfd.extractSlice(slice_p);

    for (float test_z = 2.6f; test_z <= 7.4f; test_z += 0.8f) {
        float depth = static_cast<float>(strat.water_surface_z) - test_z;
        float p_exact = static_cast<float>(strat.p_atm) + static_cast<float>(strat.tait_rho0) * 9.81f * depth;

        // Sample CFD pressure at (0, 0, test_z)
        int gx = (int)floor((0.0 - xmin) / cellSize);
        int gz = (int)floor((test_z - zmin) / cellSize);
        float p_cfd_val = p_cfd_slice[gx + gz * nx];

        // Sample MPM particles near test_z
        float p_mpm_sum = 0.0f;
        int mpm_count = 0;
        for (const auto& p : particles) {
            if (std::abs(p.x[2] - test_z) < cellSize * 0.5f &&
                std::sqrt(p.x[0]*p.x[0] + p.x[1]*p.x[1]) < 0.5f) {
                float press = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
                p_mpm_sum += press;
                mpm_count++;
            }
        }
        float p_mpm_val = mpm_count > 0 ? (p_mpm_sum / mpm_count) : 0.0f;

        float err_cfd = 100.0f * std::abs(p_cfd_val - p_exact) / p_exact;
        float err_mpm = mpm_count > 0 ? (100.0f * std::abs(p_mpm_val - p_exact) / p_exact) : -1.0f;

        std::cout << std::fixed << std::setprecision(2)
                  << std::setw(8) << test_z
                  << std::setprecision(1)
                  << std::setw(15) << p_exact
                  << std::setw(15) << p_cfd_val
                  << std::setw(15) << p_mpm_val
                  << std::setprecision(3)
                  << std::setw(15) << err_cfd
                  << std::setw(15) << err_mpm << std::endl;
    }

    // 4. Time Stepping Diagnostics
    std::cout << "\n--- Stepping Coupled FSI (20 steps) ---" << std::endl;
    double dt = 2.0e-5;
    auto print_p_max = [&](const char* tag) {
        mpm.syncParticlesToHost();
        float p_max_val = -1e20f, r_at_pmax = 0.0f;
        for (const auto& p : mpm.getParticles()) {
            float pr = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
            if (pr > p_max_val) {
                p_max_val = pr;
                r_at_pmax = std::sqrt(p.x[0]*p.x[0] + p.x[1]*p.x[1] + (p.x[2]-5.0f)*(p.x[2]-5.0f));
            }
        }
        std::cout << "  [Diag " << tag << "] max_p: " << p_max_val << " Pa at r=" << r_at_pmax << " m\n";
        for (const auto& p : mpm.getParticles()) {
            float pr = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
            if (std::abs(pr - p_max_val) < 1.0f) {
                std::cout << "     Particle pos=(" << p.x[0] << ", " << p.x[1] << ", " << p.x[2] 
                          << ") V=" << p.V << " m=" << p.m << " obj=" << p.object_id 
                          << " rho=" << (p.m / p.V) << "\n";
                // Sample CFD at this pos
                int cgx = (int)floor((p.x[0] - xmin) / cellSize);
                int cgy = (int)floor((p.x[1] - ymin) / cellSize);
                int cgz = (int)floor((p.x[2] - zmin) / cellSize);
                Slice3D sl;
                sl.axis = "xz";
                sl.offset = (cgy + 0.5f) * cellSize + ymin;
                sl.quantities = {"pressure", "density"};
                auto p_sl = cfd.extractSlice(sl);
                float p_cfd_at_cell = (cgx >= 0 && cgx < nx && cgz >= 0 && cgz < nz) ? p_sl[cgx + cgz * nx] : -999.0f;
                std::cout << "     CFD cell (" << cgx << "," << cgy << "," << cgz << ") p_cfd=" << p_cfd_at_cell << "\n";
                break;
            }
        }
    };

    auto print_cfd_p_max = [&](const char* tag) {
        auto p_field = cfd.extractPressureField();
        float p_max_val = -1e20f;
        int max_idx = -1;
        for (size_t i = 0; i < p_field.size(); ++i) {
            if (p_field[i] > p_max_val) {
                p_max_val = p_field[i];
                max_idx = static_cast<int>(i);
            }
        }
        int cz = max_idx / (nx * ny);
        int rem = max_idx % (nx * ny);
        int cy = rem / nx;
        int cx = rem % nx;
        float x = xmin + (cx + 0.5f) * cellSize;
        float y = ymin + (cy + 0.5f) * cellSize;
        float z = zmin + (cz + 0.5f) * cellSize;
        float r = std::sqrt(x*x + y*y + (z - 5.0f)*(z - 5.0f));
        std::cout << "  [CFD Diag " << tag << "] max_p: " << p_max_val << " Pa at (" << cx << "," << cy << "," << cz << ") r=" << r << " m\n";

        // Print cell (17, 17, 13)
        auto vals = cfd.getCellValues(17, 17, 13);
        if (vals.size() >= 5) {
            std::cout << "     Cell(17,17,13) [" << tag << "]: rho=" << vals[0] << " p=" << vals[1] 
                      << " u=(" << vals[2] << "," << vals[3] << "," << vals[4] << ")\n";
        }
    };

    print_cfd_p_max("before step 1");

    for (int step = 1; step <= 20; ++step) {
        mpm.particleToGridDeviceOnly();
        cfd.coupleFSIWithMPMGPU(&mpm);
        if (step == 1) {
            print_p_max("after coupleFSIWithMPMGPU");
            print_cfd_p_max("after coupleFSIWithMPMGPU");
        }
        mpm.stepWithDt(static_cast<float>(dt), false);
        if (step == 1) {
            print_p_max("after mpm.stepWithDt");
            print_cfd_p_max("after mpm.stepWithDt");
        }
        cfd.step(dt);
        if (step == 1) {
            print_p_max("after cfd.step");
            print_cfd_p_max("after cfd.step");
        }
        cfd.synchronizeFluidSleeveWithMPMGPU(&mpm);
        if (step == 1) {
            print_p_max("after synchronizeFluidSleeve");
            print_cfd_p_max("after synchronizeFluidSleeve");
        }

        if (step == 1 || step == 5 || step == 10 || step == 20) {
            mpm.syncParticlesToHost();
            const auto& pts = mpm.getParticles();
            float max_v = 0.0f;
            float min_p = 1.0e20f, max_p = -1.0e20f;
            float max_abs_vz = 0.0f;
            float max_v_interior = 0.0f;
            float max_vz_interior = 0.0f;
            for (const auto& p : pts) {
                float v_mag = std::sqrt(p.v[0]*p.v[0] + p.v[1]*p.v[1] + p.v[2]*p.v[2]);
                if (v_mag > max_v) max_v = v_mag;
                if (std::abs(p.v[2]) > max_abs_vz) max_abs_vz = std::abs(p.v[2]);
                float press = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
                if (press < min_p) min_p = press;
                if (press > max_p) max_p = press;

                float r_c = std::sqrt(p.x[0]*p.x[0] + p.x[1]*p.x[1] + (p.x[2]-5.0f)*(p.x[2]-5.0f));
                if (r_c < 1.5f) {
                    if (v_mag > max_v_interior) max_v_interior = v_mag;
                    if (std::abs(p.v[2]) > max_vz_interior) max_vz_interior = std::abs(p.v[2]);
                }
            }
            std::cout << "Step " << std::setw(3) << step 
                      << " | Max |V|: " << std::fixed << std::setprecision(4) << max_v << " m/s"
                      << " | Max |Vz|: " << max_abs_vz << " m/s"
                      << " | Interior |V|: " << max_v_interior << " m/s"
                      << " | Interior |Vz|: " << max_vz_interior << " m/s"
                      << " | P_min: " << std::setprecision(1) << min_p << " Pa"
                      << " | P_max: " << max_p << " Pa" << std::endl;

            if (step == 20) {
                if (max_v_interior > 0.05f) {
                    std::cerr << "FAIL: Interior velocity exceeded quiescent bound (got " << max_v_interior << " m/s > 0.05 m/s)" << std::endl;
                    return 1;
                }
                if (max_p > 2.0e5f) {
                    std::cerr << "FAIL: Max pressure exceeded physical hydrostatic bound (got " << max_p << " Pa > 200,000 Pa)" << std::endl;
                    return 1;
                }
            }
        }
    }

    std::cout << "\nPASS Part 1: Stratified MPM sleeve initial pressure and quiescent FSI coupling verified." << std::endl;

    // =========================================================================
    // PART 2: Blast Detonation Progression in MPM Water Sleeve
    // =========================================================================
    std::cout << "\n==========================================================" << std::endl;
    std::cout << "PART 2: Blast Detonation Progression in MPM Water Sleeve" << std::endl;
    std::cout << "==========================================================" << std::endl;

    cp.shape_type = 0; // Sphere
    cp.radius = 0.33; // TNT explosive charge
    cp.x = 0.0; cp.y = 0.0; cp.z = 5.0;

    MultiMat::MaterialSet matSet_blast;
    matSet_blast.products.A = 3.712e11;
    matSet_blast.products.B = 3.23e9;
    matSet_blast.products.R1 = 4.15;
    matSet_blast.products.R2 = 0.95;
    matSet_blast.products.omega = 0.30;
    matSet_blast.products.rho0 = 1630.0;
    matSet_blast.unreacted = matSet_blast.products;
    matSet_blast.det_vel = 6930.0;
    matSet_blast.detonation_energy = 4.29e6;

    CFDSolver3DCuda<float, true> cfd_blast(nx, ny, nz, cellSize, xmin, ymin, zmin);
    cfd_blast.setFluxScheme("AUSM+");
    cfd_blast.setSpatialOrder(2);
    cfd_blast.setTemporalOrder(5);
    cfd_blast.setBoundaryConditions(
        BCType3D::REFLECTIVE, BCType3D::REFLECTIVE,
        BCType3D::REFLECTIVE, BCType3D::REFLECTIVE,
        BCType3D::REFLECTIVE, BCType3D::OUTFLOW_RIEMANN
    );
    cfd_blast.setGravity(0.0, 0.0, strat.gravity_z);
    cfd_blast.setDetonatorLocation(0.0, 0.0, 5.0);
    cfd_blast.setStratifiedInitialCondition(cp, matSet_blast, strat);

    Slice3D slice_a2;
    slice_a2.axis = "xz";
    slice_a2.offset = 0.0;
    slice_a2.quantities = {"alpha2"};
    std::vector<float> a2_slice = cfd_blast.extractSlice(slice_a2);
    float max_a2 = 0.0f;
    for (float v : a2_slice) if (v > max_a2) max_a2 = v;
    std::cout << "DEBUG: Max alpha2 in CFD at t=0: " << max_a2 << std::endl;

    Blast::MPMSolver3DCUDA mpm_blast;
    mpm_blast.initializeGrid(nx, ny, nz, static_cast<float>(cellSize), static_cast<float>(cellSize), static_cast<float>(cellSize), static_cast<float>(xmin), static_cast<float>(ymin), static_cast<float>(zmin));
    mpm_blast.setGravity(0.0f, 0.0f, static_cast<float>(strat.gravity_z));

    mpm_blast.addSphereObject(
        obj_idx, chgX, chgY, chgZ, sleeveR, 0.0f,
        0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
        static_cast<float>(strat.tait_rho0),
        2.2e9f, 0.499f, 0.0f, 0.0f, 0.0f, 0.0f,
        ppc, Blast::MPMParticleDistribution::Cartesian, Blast::MPMBoundaryFilling::Stairstepped,
        0.0f, 0.0f, 0.0f, 2.0f, static_cast<float>(strat.water_surface_z)
    );

    auto& mat_tables_blast = mpm_blast.getMaterialTables();
    if (mat_tables_blast.size() <= static_cast<size_t>(obj_idx)) {
        mat_tables_blast.resize(obj_idx + 1);
    }
    mat_tables_blast[obj_idx] = water_mat;
    mpm_blast.setObjectMaterialMapping(obj_to_mat, 1);
    mpm_blast.applyStratifiedInitialCondition(strat);
    mpm_blast.uploadMaterialTableToDevice();
    mpm_blast.syncToDevice();

    std::cout << "Stepping blast simulation (10 steps)..." << std::endl;
    double dt_blast = 1.0e-5;
    for (int step = 1; step <= 10; ++step) {
        mpm_blast.particleToGridDeviceOnly();
        cfd_blast.coupleFSIWithMPMGPU(&mpm_blast);
        mpm_blast.stepWithDt(static_cast<float>(dt_blast), false);
        cfd_blast.step(dt_blast);
        cfd_blast.synchronizeFluidSleeveWithMPMGPU(&mpm_blast);

        mpm_blast.syncParticlesToHost();
        const auto& blast_pts = mpm_blast.getParticles();
        float p_max_blast = 0.0f, p_min_blast = 1.0e20f;
        float v_max_blast = 0.0f;
        for (const auto& p : blast_pts) {
            float press = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
            if (press > p_max_blast) p_max_blast = press;
            if (press < p_min_blast) p_min_blast = press;
            float vm = std::sqrt(p.v[0]*p.v[0] + p.v[1]*p.v[1] + p.v[2]*p.v[2]);
            if (vm > v_max_blast) v_max_blast = vm;
        }

        // Sample CFD peak pressure
        std::vector<float> p_field = cfd_blast.extractPressureField();
        float p_max_cfd = 0.0f;
        for (float val : p_field) {
            if (val > p_max_cfd) p_max_cfd = val;
        }

        Slice3D s_a1; s_a1.axis = "xz"; s_a1.offset = 0.0; s_a1.quantities = {"alpha1"};
        auto v_a1 = cfd_blast.extractSlice(s_a1);
        float max_a1 = 0.0f;
        for (float v : v_a1) if (v > max_a1) max_a1 = v;

        Slice3D s_a2; s_a2.axis = "xz"; s_a2.offset = 0.0; s_a2.quantities = {"alpha2"};
        auto v_a2 = cfd_blast.extractSlice(s_a2);
        float max_a2 = 0.0f;
        for (float v : v_a2) if (v > max_a2) max_a2 = v;

        double dt_cfd_calc = cfd_blast.computeStepSize(0.6);
        float dt_mpm_calc = mpm_blast.computeStepSize(0.6f);
        std::cout << "Step " << std::setw(2) << step
                  << " | P_max CFD: " << std::scientific << std::setprecision(3) << p_max_cfd << " Pa"
                  << " | P_max MPM: " << p_max_blast << " Pa"
                  << " | dt_cfd: " << dt_cfd_calc << " s"
                  << " | dt_mpm: " << dt_mpm_calc << " s"
                  << " | a1: " << std::fixed << std::setprecision(3) << max_a1
                  << " | a2: " << max_a2
                  << " | V_max MPM: " << std::setprecision(1) << v_max_blast << " m/s"
                  << std::endl;
        if (p_min_blast < 0.0f) {
            std::cerr << "FAIL: MPM particles experienced unphysical negative pressure (cavitation floor violation): "
                      << p_min_blast << " Pa" << std::endl;
            return 1;
        }
    }

    // =========================================================================
    // PART 3: Exact Harbour_1 Quarter-Symmetry Setup (Sleeve + JWL in MPM)
    // =========================================================================
    std::cout << "\n==========================================================" << std::endl;
    std::cout << "PART 3: Harbour_1 Quarter-Symmetry Setup (dx=0.125m, Reflecting xmin/ymin)" << std::endl;
    std::cout << "==========================================================" << std::endl;

    double q_dx = 0.125;
    double q_xmin = 0.0, q_xmax = 2.5;
    double q_ymin = 0.0, q_ymax = 2.5;
    double q_zmin = 0.0, q_zmax = 6.0;
    int q_nx = (int)round((q_xmax - q_xmin) / q_dx);
    int q_ny = (int)round((q_ymax - q_ymin) / q_dx);
    int q_nz = (int)round((q_zmax - q_zmin) / q_dx);

    std::cout << "Domain: " << q_nx << " x " << q_ny << " x " << q_nz << ", dx=" << q_dx << std::endl;

    Blast::Stratified3DParams q_strat;
    q_strat.enabled = true;
    q_strat.air_rho = 1.225;
    q_strat.p_atm = 101325.0;
    q_strat.gravity_z = -9.81;
    q_strat.water_surface_z = 10.0;
    q_strat.seabed_surface_z = 2.0;
    q_strat.k0_earth_pressure = 0.50;
    q_strat.tait_B = 3.039e8;
    q_strat.tait_gamma = 7.15;
    q_strat.tait_rho0 = 1025.0;
    q_strat.soil_density = 2000.0;
    q_strat.soil_c0 = 2500.0;
    q_strat.soil_gamma = 4.0;
    q_strat.soil_s = 1.35;
    q_strat.soil_gruneisen = 1.45;
    q_strat.soil_p_cav = 0.0;
    q_strat.soil_eos_variant = 0;

    CFDSolver3DCuda<float, true> q_cfd(q_nx, q_ny, q_nz, q_dx, q_xmin, q_ymin, q_zmin);
    q_cfd.setFluxScheme("AUSM+");
    q_cfd.setSpatialOrder(2);
    q_cfd.setTemporalOrder(5);
    q_cfd.setBoundaryConditions(
        BCType3D::REFLECTIVE, BCType3D::OUTFLOW_RIEMANN,
        BCType3D::REFLECTIVE, BCType3D::OUTFLOW_RIEMANN,
        BCType3D::REFLECTIVE, BCType3D::OUTFLOW_RIEMANN
    );
    q_cfd.setGravity(0.0, 0.0, q_strat.gravity_z);

    Charge3DParams q_cp;
    q_cp.radius = 0.0; // In zonal coupling, CFD has no charge
    MultiMat::MaterialSet q_matSet;
    q_cfd.setStratifiedInitialCondition(q_cp, q_matSet, q_strat);

    Blast::MPMSolver3DCUDA q_mpm;
    q_mpm.initializeGrid(q_nx, q_ny, q_nz, static_cast<float>(q_dx), static_cast<float>(q_dx), static_cast<float>(q_dx),
                         static_cast<float>(q_xmin), static_cast<float>(q_ymin), static_cast<float>(q_zmin));
    q_mpm.setGravity(0.0f, 0.0f, static_cast<float>(q_strat.gravity_z));
    q_mpm.setBoundaryConditions(
        Blast::MPMBoundaryCondition3D::Reflecting, Blast::MPMBoundaryCondition3D::LysmerDashpot,
        Blast::MPMBoundaryCondition3D::Reflecting, Blast::MPMBoundaryCondition3D::LysmerDashpot,
        Blast::MPMBoundaryCondition3D::Reflecting, Blast::MPMBoundaryCondition3D::LysmerDashpot
    );

    // Add Object 1: Water Sleeve
    float q_chgX = 0.0f, q_chgY = 0.0f, q_chgZ = 5.0f;
    float q_sleeveR = 1.2f;
    float q_chargeR = 0.090f;
    int q_ppc = 27;

    q_mpm.addSphereObject(
        1, q_chgX, q_chgY, q_chgZ, q_sleeveR, q_chargeR,
        0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
        static_cast<float>(q_strat.tait_rho0),
        2.2e9f, 0.499f, 0.0f, 0.0f, 0.0f, 0.0f,
        q_ppc, Blast::MPMParticleDistribution::Cartesian, Blast::MPMBoundaryFilling::Stairstepped,
        0.0f, 0.0f, 0.0f, static_cast<float>(q_strat.seabed_surface_z), static_cast<float>(q_strat.water_surface_z)
    );

    // Add Object 2: JWL Explosive Charge
    q_mpm.addSphereObject(
        2, q_chgX, q_chgY, q_chgZ, q_chargeR, 0.0f,
        0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f,
        1630.0f, 6.0e9f, 0.35f, 2.0e7f, 1.2e8f, 0.07f, 5.0e6f,
        q_ppc, Blast::MPMParticleDistribution::Cartesian, Blast::MPMBoundaryFilling::Stairstepped,
        0.0f, 0.0f, 0.0f, static_cast<float>(q_strat.seabed_surface_z), static_cast<float>(q_strat.water_surface_z)
    );

    auto& q_mat_tables = q_mpm.getMaterialTables();
    q_mat_tables.resize(3);
    // Mat 1: TaitWater
    q_mat_tables[1].material_model = Blast::MPMMaterialModel::TaitWater;
    q_mat_tables[1].density = static_cast<float>(q_strat.tait_rho0);
    q_mat_tables[1].tait_B = static_cast<float>(q_strat.tait_B);
    q_mat_tables[1].tait_gamma = static_cast<float>(q_strat.tait_gamma);
    q_mat_tables[1].tait_rho0 = static_cast<float>(q_strat.tait_rho0);
    q_mat_tables[1].tait_c0 = 1482.0f;
    q_mat_tables[1].tait_p_cav = 0.0f;
    q_mat_tables[1].tait_p0 = static_cast<float>(q_strat.p_atm);

    // Mat 2: JWL Programmed Burn
    q_mat_tables[2].material_model = Blast::MPMMaterialModel::JWLProgrammedBurn;
    q_mat_tables[2].density = 1630.0f;
    q_mat_tables[2].det_vel = 6930.0f;
    q_mat_tables[2].detonation_energy = 4.29e6f;
    q_mat_tables[2].jwl_A = 3.712e11f;
    q_mat_tables[2].jwl_B = 3.23e9f;
    q_mat_tables[2].jwl_R1 = 4.15f;
    q_mat_tables[2].jwl_R2 = 0.95f;
    q_mat_tables[2].jwl_omega = 0.30f;
    q_mat_tables[2].burn_zone_cells = 4;
    q_mat_tables[2].tau_burn_min = 1.0e-7f;

    std::vector<int> q_obj_to_mat = {0, 0, 1}; // obj 1 -> mat 0 (water), obj 2 -> mat 1 (jwl)
    q_mpm.setObjectMaterialMapping(q_obj_to_mat, 2);
    q_mpm.applyStratifiedInitialCondition(q_strat);

    // Detonator hotspot ignition at (0, 0, 3) with radius 0.05
    auto& q_pts = q_mpm.getParticles();
    int ignited_count = 0;
    for (auto& p : q_pts) {
        if (p.object_id == 2) {
            float dist = std::sqrt((p.x[0]-q_chgX)*(p.x[0]-q_chgX) + (p.x[1]-q_chgY)*(p.x[1]-q_chgY) + (p.x[2]-q_chgZ)*(p.x[2]-q_chgZ));
            float t_arr = dist / 6930.0f;
            p.t_arrival = t_arr;
            p.lambda = 0.0f;
            p.e_int = 0.0f;
        }
    }
    std::cout << "Detonator programmed burn initialized (0 particles burned at t=0)" << std::endl;

    q_mpm.uploadMaterialTableToDevice();
    q_mpm.syncToDevice();

    Blast::ZonalHandoff3DParams q_zonal;
    q_zonal.enabled = true;
    q_zonal.center_x = q_chgX;
    q_zonal.center_y = q_chgY;
    q_zonal.center_z = q_chgZ;
    q_zonal.sleeve_radius = q_sleeveR;
    q_zonal.overlap_thickness = 2.0 * q_dx;
    q_zonal.clip_z_min = 2.0;
    q_zonal.clip_z_max = 6.0;
    q_cfd.setZonalHandoffParams(q_zonal);
    q_mpm.setZonalHandoffParams(q_zonal);

    // Initial handoff at t=0
    q_mpm.particleToGridDeviceOnly();
    q_cfd.coupleZonalHandoffWithMPMGPU(&q_mpm);

    // Check initial state at t=0
    float t0_max_p_cfd = 0.0f;
    for (int i = 0; i < q_nx; ++i) {
        for (int j = 0; j < q_ny; ++j) {
            for (int k = 0; k < q_nz; ++k) {
                float u, v, w, rho, p;
                if (q_cfd.getFluidVelocity(i, j, k, u, v, w, rho, p)) {
                    if (p > t0_max_p_cfd) t0_max_p_cfd = p;
                }
            }
        }
    }
    std::cout << ">>> Initial state at t=0: Max CFD Pressure = " << std::scientific << std::setprecision(2)
              << t0_max_p_cfd << " Pa (hydrostatic target ~1.65e5 Pa)" << std::endl;

    std::cout << "\nStepping Harbour_1 quarter-symmetry coupled simulation..." << std::endl;
    double sim_t = 0.0;
    double last_dt = 1.0e-7;
    int n_steps_diag = 150;
    if (const char* env_steps = std::getenv("BLAST_DIAG_STEPS")) {
        n_steps_diag = std::max(1, std::atoi(env_steps));
    }
    for (int step = 0; step < n_steps_diag; ++step) {
        q_mpm.particleToGridDeviceOnly();
        auto inspect_k_band = [&](const char* stage_name) {
            q_cfd.invalidateTileCache();
            std::cout << "         [" << stage_name << "] k=45..47 P_cfd: ";
            for (int kk = 45; kk <= 47; ++kk) {
                float u, v, w, rho, p;
                q_cfd.getFluidVelocity(0, 0, kk, u, v, w, rho, p);
                std::cout << "k" << kk << "=" << std::scientific << std::setprecision(2) << p << "(u=" << std::fixed << std::setprecision(0) << w << ") ";
            }
            std::cout << "\n";
        };

        if (step >= 73 && step <= 77) {
            inspect_k_band("before coupleFSI");
        }
        q_cfd.coupleFSIWithMPMGPU(&q_mpm);
        if (step >= 73 && step <= 77) {
            inspect_k_band("after coupleFSI");
        }

        double dt_cfd_c = q_cfd.computeStepSize(0.6);
        float dt_mpm_c = q_mpm.computeStepSize(0.6f);
        double dt_c = std::min(static_cast<double>(dt_mpm_c), dt_cfd_c);
        if (step == 0) dt_c = 0.5 * dt_c;
        else dt_c = std::min(dt_c, 1.5 * last_dt);
        last_dt = dt_c;

        std::cout << "Step " << std::setw(2) << step
                  << " | t: " << std::scientific << std::setprecision(2) << sim_t << " s"
                  << " | dt_cfd: " << dt_cfd_c << " s"
                  << " | dt_mpm: " << dt_mpm_c << " s"
                  << " | dt_used: " << dt_c << " s";

        // Find max speed and max pressure in CFD
        float max_u_cfd = 0.0f, max_p_cfd = 0.0f, min_rho_cfd = 1e9f;
        int max_u_i = 0, max_u_j = 0, max_u_k = 0;
        int max_p_i = 0, max_p_j = 0, max_p_k = 0;
        for (int i = 0; i < q_nx; ++i) {
            for (int j = 0; j < q_ny; ++j) {
                for (int k = 0; k < q_nz; ++k) {
                    float u, v, w, rho, p;
                    if (q_cfd.getFluidVelocity(i, j, k, u, v, w, rho, p)) {
                        float v_mag = std::sqrt(u*u + v*v + w*w);
                        if (v_mag > max_u_cfd) {
                            max_u_cfd = v_mag;
                            max_u_i = i; max_u_j = j; max_u_k = k;
                        }
                        if (p > max_p_cfd) {
                            max_p_cfd = p;
                            max_p_i = i; max_p_j = j; max_p_k = k;
                        }
                        if (rho < min_rho_cfd) min_rho_cfd = rho;
                    }
                }
            }
        }
        std::cout << " | max |u_cfd|: " << std::fixed << std::setprecision(1) << max_u_cfd << " m/s at ("
                  << max_u_i << "," << max_u_j << "," << max_u_k << ")"
                  << " | P_max: " << std::scientific << std::setprecision(2) << max_p_cfd << " Pa at ("
                  << max_p_i << "," << max_p_j << "," << max_p_k << ")"
                  << " | rho_min: " << std::fixed << std::setprecision(2) << min_rho_cfd << " kg/m3"
                  << std::endl;

        if (step >= 73 && step <= 77) inspect_k_band("before mpm.step");
        q_mpm.stepWithDt(static_cast<float>(dt_c), false);
        if (step >= 73 && step <= 77) inspect_k_band("after mpm.step");
        q_cfd.step(dt_c);
        if (step >= 73 && step <= 77) inspect_k_band("after cfd.step");
        q_cfd.synchronizeFluidSleeveWithMPMGPU(&q_mpm);
        if (step >= 73 && step <= 77) inspect_k_band("after syncFluidSleeve");
        sim_t += dt_c;

        if (step == 73) {
            q_mpm.syncParticlesToHost();
            const auto& pts = q_mpm.getParticles();
            std::cout << "--- MPM Particles near (0,0,6.0) at step 73 ---\n";
            int count_k47 = 0;
            for (const auto& p : pts) {
                if (p.x[2] >= 5.75f && p.x[0] <= 0.25f && p.x[1] <= 0.25f) {
                    float pr = -(p.sigma[0][0] + p.sigma[1][1] + p.sigma[2][2]) / 3.0f;
                    std::cout << "  p pos=(" << p.x[0] << "," << p.x[1] << "," << p.x[2]
                              << ") v=(" << p.v[0] << "," << p.v[1] << "," << p.v[2]
                              << ") pr=" << std::scientific << std::setprecision(2) << pr
                              << " rho=" << std::fixed << std::setprecision(1) << (p.m / p.V)
                              << " obj=" << p.object_id << "\n";
                    count_k47++;
                    if (count_k47 >= 10) { std::cout << "  ... (more)\n"; break; }
                }
            }
            std::cout << "Total near corner: " << count_k47 << "\n";
        }

        if (step % 5 == 0 || (step >= 58 && step <= 72)) {
            q_mpm.syncParticlesToHost();
            const auto& pts = q_mpm.getParticles();
            float max_v_water = 0.0f, max_v_jwl = 0.0f;
            int count_outside = 0;
            float max_v_outside = 0.0f;
            const Blast::MPMParticle3D* fast_water = nullptr;
            for (const auto& p : pts) {
                float v_mag = std::sqrt(p.v[0]*p.v[0] + p.v[1]*p.v[1] + p.v[2]*p.v[2]);
                if (p.object_id == 1 && v_mag > max_v_water) {
                    max_v_water = v_mag;
                    fast_water = &p;
                }
                if (p.object_id == 2 && v_mag > max_v_jwl) max_v_jwl = v_mag;
                float r_p = std::sqrt((p.x[0]-q_chgX)*(p.x[0]-q_chgX) + (p.x[1]-q_chgY)*(p.x[1]-q_chgY) + (p.x[2]-q_chgZ)*(p.x[2]-q_chgZ));
                if (r_p > q_sleeveR) {
                    count_outside++;
                    if (v_mag > max_v_outside) max_v_outside = v_mag;
                }
            }
            std::cout << "       --> [MPM Diag] max V_water: " << std::fixed << std::setprecision(1) << max_v_water
                      << " m/s | max V_jwl: " << max_v_jwl
                      << " m/s | Pts outside sleeve (r>" << q_sleeveR << "): " << count_outside
                      << " (max V=" << max_v_outside << " m/s)" << std::endl;
            if (fast_water) {
                float r_fw = std::sqrt((fast_water->x[0]-q_chgX)*(fast_water->x[0]-q_chgX) +
                                       (fast_water->x[1]-q_chgY)*(fast_water->x[1]-q_chgY) +
                                       (fast_water->x[2]-q_chgZ)*(fast_water->x[2]-q_chgZ));
                float p_fw = -(fast_water->sigma[0][0] + fast_water->sigma[1][1] + fast_water->sigma[2][2]) / 3.0f;
                int cgx = static_cast<int>(floor((fast_water->x[0] - q_xmin) / q_dx));
                int cgy = static_cast<int>(floor((fast_water->x[1] - q_ymin) / q_dx));
                int cgz = static_cast<int>(floor((fast_water->x[2] - q_zmin) / q_dx));
                float cfd_u=0, cfd_v=0, cfd_w=0, cfd_rho=0, cfd_p=0;
                q_cfd.getFluidVelocity(cgx, cgy, cgz, cfd_u, cfd_v, cfd_w, cfd_rho, cfd_p);
                std::cout << "           FastWater pos=(" << fast_water->x[0] << "," << fast_water->x[1] << "," << fast_water->x[2]
                          << ") r=" << r_fw << " m | J=" << (fast_water->V / fast_water->V0)
                          << " | P_mpm=" << std::scientific << std::setprecision(2) << p_fw << " Pa"
                          << " | CFD cell(" << cgx << "," << cgy << "," << cgz << ") P=" << cfd_p
                          << " rho=" << std::fixed << std::setprecision(1) << cfd_rho
                          << " u=(" << cfd_u << "," << cfd_v << "," << cfd_w << ")\n";
            }
        }
    }

    std::cout << "\nHarbour_1 diagnostic run completed." << std::endl;
    return 0;
}

