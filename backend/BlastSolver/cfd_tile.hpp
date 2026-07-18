#ifndef CFD_TILE_HPP
#define CFD_TILE_HPP

#include <cstdint>

typedef double Real;

constexpr int TILE_SIZE = 16;
constexpr int TILE_SIZE_3D = 8;
constexpr int TILE_CELLS_3D = TILE_SIZE_3D * TILE_SIZE_3D * TILE_SIZE_3D;

// Structure of Arrays (SoA) for a single Tile (Conservative Variables)
template <typename RealType>
struct ConservativeTileT {
    RealType rho[TILE_SIZE * TILE_SIZE];
    RealType rhour[TILE_SIZE * TILE_SIZE];
    RealType rhouz[TILE_SIZE * TILE_SIZE];
    RealType E[TILE_SIZE * TILE_SIZE];
    RealType alpha1[TILE_SIZE * TILE_SIZE];
    RealType alpha2[TILE_SIZE * TILE_SIZE];
    RealType arho1[TILE_SIZE * TILE_SIZE];
    RealType arho2[TILE_SIZE * TILE_SIZE];
};

// Structure of Arrays (SoA) for a single Tile (Primitive Variables)
template <typename RealType>
struct PrimitiveTileT {
    RealType rho[TILE_SIZE * TILE_SIZE];
    RealType ur[TILE_SIZE * TILE_SIZE];
    RealType uz[TILE_SIZE * TILE_SIZE];
    RealType p[TILE_SIZE * TILE_SIZE];
    RealType E[TILE_SIZE * TILE_SIZE];
    RealType alpha1[TILE_SIZE * TILE_SIZE];
    RealType alpha2[TILE_SIZE * TILE_SIZE];
    RealType arho1[TILE_SIZE * TILE_SIZE];
    RealType arho2[TILE_SIZE * TILE_SIZE];
    int floor_status[TILE_SIZE * TILE_SIZE];
};

using ConservativeTile = ConservativeTileT<double>;
using PrimitiveTile = PrimitiveTileT<double>;

template <typename RealType, bool IsMultiMaterial>
struct ConservativeTile3D;

template <typename RealType>
struct ConservativeTile3D<RealType, false> {
    RealType rho[TILE_CELLS_3D];
    RealType rhoux[TILE_CELLS_3D];
    RealType rhouy[TILE_CELLS_3D];
    RealType rhouz[TILE_CELLS_3D];
    RealType E[TILE_CELLS_3D];
};

template <typename RealType>
struct ConservativeTile3D<RealType, true> {
    RealType rho[TILE_CELLS_3D];
    RealType rhoux[TILE_CELLS_3D];
    RealType rhouy[TILE_CELLS_3D];
    RealType rhouz[TILE_CELLS_3D];
    RealType E[TILE_CELLS_3D];
    RealType alpha1[TILE_CELLS_3D];
    RealType alpha2[TILE_CELLS_3D];
    RealType arho1[TILE_CELLS_3D];
    RealType arho2[TILE_CELLS_3D];
};

template <typename RealType, bool IsMultiMaterial>
struct PrimitiveTile3D;

template <typename RealType>
struct PrimitiveTile3D<RealType, false> {
    RealType rho[TILE_CELLS_3D];
    RealType ux[TILE_CELLS_3D];
    RealType uy[TILE_CELLS_3D];
    RealType uz[TILE_CELLS_3D];
    RealType p[TILE_CELLS_3D];
    int floor_status[TILE_CELLS_3D];
};

template <typename RealType>
struct PrimitiveTile3D<RealType, true> {
    RealType rho[TILE_CELLS_3D];
    RealType ux[TILE_CELLS_3D];
    RealType uy[TILE_CELLS_3D];
    RealType uz[TILE_CELLS_3D];
    RealType p[TILE_CELLS_3D];
    RealType alpha1[TILE_CELLS_3D];
    RealType alpha2[TILE_CELLS_3D];
    RealType arho1[TILE_CELLS_3D];
    RealType arho2[TILE_CELLS_3D];
    int floor_status[TILE_CELLS_3D];
};

struct GeometryPayload {
    float nx;
    float ny;
    float nz;
    bool is_boundary;
};

struct GeometryTile3D {
    GeometryPayload cells[TILE_CELLS_3D];
};

#endif // CFD_TILE_HPP
