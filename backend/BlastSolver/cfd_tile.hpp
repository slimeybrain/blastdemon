#ifndef CFD_TILE_HPP
#define CFD_TILE_HPP

#include <cstdint>

typedef double Real;

constexpr int TILE_SIZE = 16;
constexpr int TILE_SIZE_3D = 8;
constexpr int TILE_CELLS_3D = TILE_SIZE_3D * TILE_SIZE_3D * TILE_SIZE_3D;

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

template <bool IsMultiMaterial>
struct ConservativeTile3D;

template <>
struct ConservativeTile3D<false> {
    Real rho[TILE_CELLS_3D];
    Real rhoux[TILE_CELLS_3D];
    Real rhouy[TILE_CELLS_3D];
    Real rhouz[TILE_CELLS_3D];
    Real E[TILE_CELLS_3D];
};

template <>
struct ConservativeTile3D<true> {
    Real rho[TILE_CELLS_3D];
    Real rhoux[TILE_CELLS_3D];
    Real rhouy[TILE_CELLS_3D];
    Real rhouz[TILE_CELLS_3D];
    Real E[TILE_CELLS_3D];
    Real alpha1[TILE_CELLS_3D];
    Real alpha2[TILE_CELLS_3D];
    Real arho1[TILE_CELLS_3D];
    Real arho2[TILE_CELLS_3D];
};

template <bool IsMultiMaterial>
struct PrimitiveTile3D;

template <>
struct PrimitiveTile3D<false> {
    Real rho[TILE_CELLS_3D];
    Real ux[TILE_CELLS_3D];
    Real uy[TILE_CELLS_3D];
    Real uz[TILE_CELLS_3D];
    Real p[TILE_CELLS_3D];
    Real E[TILE_CELLS_3D];
    Real arrival_time[TILE_CELLS_3D];
    int floor_status[TILE_CELLS_3D];
};

template <>
struct PrimitiveTile3D<true> {
    Real rho[TILE_CELLS_3D];
    Real ux[TILE_CELLS_3D];
    Real uy[TILE_CELLS_3D];
    Real uz[TILE_CELLS_3D];
    Real p[TILE_CELLS_3D];
    Real E[TILE_CELLS_3D];
    Real alpha1[TILE_CELLS_3D];
    Real alpha2[TILE_CELLS_3D];
    Real arho1[TILE_CELLS_3D];
    Real arho2[TILE_CELLS_3D];
    Real arrival_time[TILE_CELLS_3D];
    int floor_status[TILE_CELLS_3D];
};

#endif // CFD_TILE_HPP
