#ifndef CFD_STATES_HPP
#define CFD_STATES_HPP

struct IdealGasState {
    double rho;
    double u;
    double p;
    double E; // Total energy per unit volume
    int floor_status; // Flag indicating if a floor was active
};

struct MultiMaterialState {
    double rho;
    double u;
    double p;
    double E; // Total energy per unit volume
    double alpha1;
    double alpha2;
    double arho1;
    double arho2;
    int floor_status; // Flag indicating if a floor was active
};

struct IdealGasConservativeState {
    double rho;
    double rhou;
    double E;
};

struct MultiMaterialConservativeState {
    double rho;
    double rhou;
    double E;
    double alpha1;
    double alpha2;
    double arho1;
    double arho2;
};

template <bool IsMultiMaterial>
struct StateTypes;

template <>
struct StateTypes<false> {
    using PrimitiveState = IdealGasState;
    using ConservedState = IdealGasConservativeState;
};

template <>
struct StateTypes<true> {
    using PrimitiveState = MultiMaterialState;
    using ConservedState = MultiMaterialConservativeState;
};

#ifndef STATE_2D_DEFINED
#define STATE_2D_DEFINED
struct State2D {
    double rho;
    double ur; // Velocity in radial direction
    double uz; // Velocity in axial direction
    double p;
    double E;  // Total energy per unit volume
    double alpha1;
    double alpha2;
    double arho1;
    double arho2;
    int floor_status; // Flag indicating if a floor was active
};

struct ConservativeState2D {
    double rho;
    double rhour;
    double rhouz;
    double E;
    double alpha1;
    double alpha2;
    double arho1;
    double arho2;
};
#endif

#endif // CFD_STATES_HPP
