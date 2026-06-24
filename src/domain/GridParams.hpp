#pragma once

/**
 * SimulationState: Flat memory structure for high-performance CFD execution.
 * Adheres to Data-Oriented Design (DOD) principles.
 */
struct SimulationState {
    // Grid Parameters
    int nx;
    int ny;
    float dx;
    float dy;

    // Solver State (Flat Device Pointers)
    float* d_density;
    float* d_energy;
    float* d_momentum_x; // Split for vectorized access if needed
    float* d_momentum_y;

    // Explosive Data (Flat Device Pointers)
    float* d_exp_x;
    float* d_exp_y;
    float* d_exp_mass;
    int num_explosives;

    // Default constructor for safety
    SimulationState()
        : nx(0), ny(0), dx(0.0f), dy(0.0f),
          d_density(nullptr), d_energy(nullptr), d_momentum_x(nullptr), d_momentum_y(nullptr),
          d_exp_x(nullptr), d_exp_y(nullptr), d_exp_mass(nullptr), num_explosives(0) {}
};
