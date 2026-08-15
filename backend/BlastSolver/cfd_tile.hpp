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
    uint8_t floor_status[TILE_CELLS_3D];
    RealType peak_overpressure[TILE_CELLS_3D];
    RealType running_impulse[TILE_CELLS_3D];
    RealType peak_impulse[TILE_CELLS_3D];
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
    uint8_t floor_status[TILE_CELLS_3D];
    RealType peak_overpressure[TILE_CELLS_3D];
    RealType running_impulse[TILE_CELLS_3D];
    RealType peak_impulse[TILE_CELLS_3D];
};

struct GeometryPayload {
    int8_t nx;
    int8_t ny;
    int8_t nz;
    uint8_t solid_fraction : 7;
    uint8_t is_boundary : 1;
};

struct GeometryTile3D {
    GeometryPayload cells[TILE_CELLS_3D];
};

struct UncoveringMaskTile3D {
    uint64_t words[8]; // 512 bits per tile for 1-bit boundary state (64 bytes vs 2048 bytes)
};

#endif // CFD_TILE_HPP
