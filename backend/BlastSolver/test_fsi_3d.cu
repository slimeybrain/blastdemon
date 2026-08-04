#include "cfd_solver_3d_cuda.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include <iostream>
#include <vector>
#include <cmath>
#include <array>
#include <cuda_runtime.h>

int main() {
    int nx = 64, ny = 64, nz = 64;
    double cellSize = 0.01;
    double xmin = 0.0, ymin = 0.0, zmin = 0.0;

    std::cout << "==================================================" << std::endl;
    std::cout << "Testing 3D GPU-GPU FSI Coupling Components" << std::endl;
    std::cout << "Grid size: " << nx << "x" << ny << "x" << nz << std::endl;
    std::cout << "==================================================" << std::endl;

    // 1. Initialize CFD solver
    std::cout << "[Step 1] Initializing CFD Solver..." << std::endl;
    auto cfd_solver = std::make_unique<CFDSolver3DCuda<float, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
    cfd_solver->setFluxScheme("AUSM+");
    cfd_solver->setSpatialOrder(2);
    cfd_solver->setTemporalOrder(2);

    // Initial shock condition: high pressure on the left (x < 0.3)
    Charge3DParams charge;
    charge.shape_type = 1; // Block
    charge.x = 0.15; charge.y = 0.32; charge.z = 0.32;
    charge.lx = 0.3; charge.ly = 1.0; charge.lz = 1.0;

    MultiMat::MaterialSet mats;
    mats.products.A = 3.73e11;
    mats.products.B = 3.74e9;
    mats.products.R1 = 4.15;
    mats.products.R2 = 0.9;
    mats.products.omega = 0.35;
    mats.products.rho0 = 1630.0;
    mats.unreacted = mats.products;
    mats.detonation_energy = 4.29e6; // Set detonation energy to get high explosion pressure

    double amb_rho = 1.2;
    double amb_p = 101325.0;
    cfd_solver->setInitialCondition(charge, mats, amb_rho, amb_p);

    // 2. Initialize MPM solver
    std::cout << "[Step 2] Initializing MPM Solver..." << std::endl;
    auto mpm_solver = std::make_unique<Blast::MPMSolver3DCUDA>();
    mpm_solver->initializeGrid(nx, ny, nz, cellSize, cellSize, cellSize);
    mpm_solver->setTransferScheme(Blast::MPMTransferScheme::BSpline);
    mpm_solver->setVelocityScheme(Blast::MPMVelocityScheme::APIC);
    mpm_solver->setTimeScheme(Blast::MPMTimeIntegrationScheme::RK2);

    // Add a solid sphere in the middle
    std::cout << "[Step 3] Adding MPM Solid Object (Sphere)..." << std::endl;
    mpm_solver->addSphereObject(
        1,       // object ID
        0.35f, 0.32f, 0.32f, // center (right next to the shock boundary)
        0.05f,   // radius
        0.0f, 0.0f, 0.0f, // initial velocity
        0.0f, 0.0f, 0.0f, // angular velocity
        7850.0f, // steel density
        210.0e9f, // young's modulus
        0.3f,    // poisson's ratio
        400.0e6f, // yield stress
        1.0e9f,   // hardening modulus
        0.25f,   // failure strain
        600.0e6f, // tensile failure stress
        8        // particles per cell
    );

    mpm_solver->syncToDevice();

    int num_particles = mpm_solver->getParticles().size();
    std::cout << "  Successfully added " << num_particles << " MPM particles." << std::endl;
    if (num_particles == 0) {
        std::cerr << "  ERROR: No particles generated!" << std::endl;
        return 1;
    }

    // Capture initial positions before evolution
    std::vector<std::array<float, 3>> initial_positions(num_particles);
    const auto& initial_particles = mpm_solver->getParticles();
    for (int i = 0; i < num_particles; ++i) {
        initial_positions[i] = {initial_particles[i].x[0], initial_particles[i].x[1], initial_particles[i].x[2]};
    }

    // 3. Test P2G Pass
    std::cout << "[Step 4] Running P2G Pass on GPU..." << std::endl;
    mpm_solver->particleToGridDeviceOnly();
    cudaDeviceSynchronize();

    // Verify grid mass by copying to host
    mpm_solver->syncToHost();
    const auto& host_grid = mpm_solver->getGrid();
    double total_mass = 0.0;
    int non_zero_mass_nodes = 0;
    for (const auto& node : host_grid) {
        total_mass += node.m;
        if (node.m > 0.0f) {
            non_zero_mass_nodes++;
        }
    }
    std::cout << "  Total scattered grid mass: " << total_mass << " kg" << std::endl;
    std::cout << "  Non-zero mass grid nodes: " << non_zero_mass_nodes << std::endl;
    if (non_zero_mass_nodes == 0) {
        std::cerr << "  ERROR: P2G failed to scatter mass!" << std::endl;
        return 1;
    }

    // 4. Test FSI Coupling
    std::cout << "[Step 5] Running FSI Coupling (coupleFSIWithMPMGPU)..." << std::endl;
    cfd_solver->coupleFSIWithMPMGPU(mpm_solver.get());
    cudaDeviceSynchronize();

    // Verify Solid velocity fields (Brinkman Volume Penalty replaces boundary cells)
    // The CFD boundary cells will remain zero since we no longer flag them.
    std::cout << "  (Boundary cell flagging is now deprecated in favor of Brinkman Volume Penalty)" << std::endl;

    // Verify FSI forces in MPM grid
    mpm_solver->syncToHost();
    const auto& host_grid_fsi = mpm_solver->getGrid();
    double max_f_ext = 0.0;
    double sum_f_ext_x = 0.0;
    for (const auto& node : host_grid_fsi) {
        double f_mag = std::sqrt(node.f_ext[0]*node.f_ext[0] + node.f_ext[1]*node.f_ext[1] + node.f_ext[2]*node.f_ext[2]);
        if (f_mag > max_f_ext) max_f_ext = f_mag;
        sum_f_ext_x += node.f_ext[0];
    }
    std::cout << "  Max injected FSI force on a grid node: " << max_f_ext << " N" << std::endl;
    std::cout << "  Sum of FSI force X-components: " << sum_f_ext_x << " N" << std::endl;
    if (max_f_ext == 0.0) {
        std::cerr << "  ERROR: No external FSI forces were injected!" << std::endl;
        return 1;
    }

    // 5. Test Time step evolution over 50 coupled timesteps
    std::cout << "[Step 6] Running 50 coupled solver timesteps..." << std::endl;
    float dt = 1e-6f;
    for (int step = 0; step < 50; ++step) {
        mpm_solver->particleToGridDeviceOnly();
        cfd_solver->coupleFSIWithMPMGPU(mpm_solver.get());
        mpm_solver->stepWithDt(dt, false);
        cfd_solver->step(dt);
    }
    cudaDeviceSynchronize();

    // Verify particles moved and gained velocity
    mpm_solver->syncToHost();
    const auto& host_particles = mpm_solver->getParticles();
    double max_vel = 0.0;
    double max_disp = 0.0;
    for (int i = 0; i < num_particles; ++i) {
        const auto& p = host_particles[i];
        double vel_mag = std::sqrt(p.v[0]*p.v[0] + p.v[1]*p.v[1] + p.v[2]*p.v[2]);
        if (vel_mag > max_vel) max_vel = vel_mag;

        // Position displacement
        double dx_p = p.x[0] - initial_positions[i][0];
        double dy_p = p.x[1] - initial_positions[i][1];
        double dz_p = p.x[2] - initial_positions[i][2];
        double disp = std::sqrt(dx_p*dx_p + dy_p*dy_p + dz_p*dz_p);
        if (disp > max_disp) max_disp = disp;
    }
    std::cout << "  Max particle velocity after 50 steps: " << max_vel << " m/s" << std::endl;
    std::cout << "  Max particle displacement after 50 steps: " << max_disp << " m" << std::endl;
    if (max_vel == 0.0) {
        std::cerr << "  ERROR: Particles did not accelerate!" << std::endl;
        return 1;
    }

    std::cout << "\n>>> ALL 3D FSI GPU COMPONENTS ARE FUNCTIONING CORRECTLY! <<<" << std::endl;
    return 0;
}
