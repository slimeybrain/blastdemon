#ifndef CFD_TILE_HPP
#define CFD_TILE_HPP

#include <cstdint>

constexpr int TILE_SIZE = 16;

// Structure of Arrays (SoA) for a single Tile (Conservative Variables)
struct ConservativeTile {
    double rho[TILE_SIZE * TILE_SIZE];
    double rhour[TILE_SIZE * TILE_SIZE];
    double rhouz[TILE_SIZE * TILE_SIZE];
    double E[TILE_SIZE * TILE_SIZE];
    double alpha1[TILE_SIZE * TILE_SIZE];
    double alpha2[TILE_SIZE * TILE_SIZE];
    double arho1[TILE_SIZE * TILE_SIZE];
    double arho2[TILE_SIZE * TILE_SIZE];
};

// Structure of Arrays (SoA) for a single Tile (Primitive Variables)
struct PrimitiveTile {
    double rho[TILE_SIZE * TILE_SIZE];
    double ur[TILE_SIZE * TILE_SIZE];
    double uz[TILE_SIZE * TILE_SIZE];
    double p[TILE_SIZE * TILE_SIZE];
    double E[TILE_SIZE * TILE_SIZE];
    double alpha1[TILE_SIZE * TILE_SIZE];
    double alpha2[TILE_SIZE * TILE_SIZE];
    double arho1[TILE_SIZE * TILE_SIZE];
    double arho2[TILE_SIZE * TILE_SIZE];
    int floor_status[TILE_SIZE * TILE_SIZE];
};

#endif // CFD_TILE_HPP
