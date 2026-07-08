#ifndef CFD_STATES_HPP
#define CFD_STATES_HPP

template <typename RealType>
struct IdealGasStateT {
    RealType rho;
    RealType u;
    RealType p;
    RealType E; // Total energy per unit volume
    int floor_status; // Flag indicating if a floor was active
};

template <typename RealType>
struct MultiMaterialStateT {
    RealType rho;
    RealType u;
    RealType p;
    RealType E; // Total energy per unit volume
    RealType alpha1;
    RealType alpha2;
    RealType arho1;
    RealType arho2;
    int floor_status; // Flag indicating if a floor was active
};

template <typename RealType>
struct IdealGasConservativeStateT {
    RealType rho;
    RealType rhou;
    RealType E;
};

template <typename RealType>
struct MultiMaterialConservativeStateT {
    RealType rho;
    RealType rhou;
    RealType E;
    RealType alpha1;
    RealType alpha2;
    RealType arho1;
    RealType arho2;
};

using IdealGasState = IdealGasStateT<double>;
using MultiMaterialState = MultiMaterialStateT<double>;
using IdealGasConservativeState = IdealGasConservativeStateT<double>;
using MultiMaterialConservativeState = MultiMaterialConservativeStateT<double>;

template <typename RealType, bool IsMultiMaterial>
struct StateTypes;

template <typename RealType>
struct StateTypes<RealType, false> {
    using PrimitiveState = IdealGasStateT<RealType>;
    using ConservedState = IdealGasConservativeStateT<RealType>;
};

template <typename RealType>
struct StateTypes<RealType, true> {
    using PrimitiveState = MultiMaterialStateT<RealType>;
    using ConservedState = MultiMaterialConservativeStateT<RealType>;
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

#ifndef STATE_3D_DEFINED
#define STATE_3D_DEFINED
struct State3D {
    double rho;
    double ux;
    double uy;
    double uz;
    double p;
    double E;
    double alpha1;
    double alpha2;
    double arho1;
    double arho2;
    int floor_status;
};

struct ConservativeState3D {
    double rho;
    double rhoux;
    double rhouy;
    double rhouz;
    double E;
    double alpha1;
    double alpha2;
    double arho1;
    double arho2;
};
#endif

#endif // CFD_STATES_HPP
