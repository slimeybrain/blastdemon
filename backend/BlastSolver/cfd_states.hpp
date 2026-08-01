#ifndef CFD_STATES_HPP
#define CFD_STATES_HPP

template <typename RealType>
struct IdealGasStateT {
    RealType rho = 0;
    RealType u = 0;
    RealType p = 0;
    RealType E = 0; // Total energy per unit volume
    int floor_status = 0; // Flag indicating if a floor was active
};

template <typename RealType>
struct MultiMaterialStateT {
    RealType rho = 0;
    RealType u = 0;
    RealType p = 0;
    RealType E = 0; // Total energy per unit volume
    RealType alpha1 = 0;
    RealType alpha2 = 0;
    RealType arho1 = 0;
    RealType arho2 = 0;
    int floor_status = 0; // Flag indicating if a floor was active
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
    double rho = 0;
    double ur = 0; // Velocity in radial direction
    double uz = 0; // Velocity in axial direction
    double p = 0;
    double E = 0;  // Total energy per unit volume
    double alpha1 = 0;
    double alpha2 = 0;
    double arho1 = 0;
    double arho2 = 0;
    int floor_status = 0; // Flag indicating if a floor was active
};

struct ConservativeState2D {
    double rho = 0;
    double rhour = 0;
    double rhouz = 0;
    double E = 0;
    double alpha1 = 0;
    double alpha2 = 0;
    double arho1 = 0;
    double arho2 = 0;
};
#endif

#ifndef STATE_3D_DEFINED
#define STATE_3D_DEFINED
struct State3D {
    double rho = 0;
    double ux = 0;
    double uy = 0;
    double uz = 0;
    double p = 0;
    double E = 0;
    double alpha1 = 0;
    double alpha2 = 0;
    double arho1 = 0;
    double arho2 = 0;
    int floor_status = 0;
};

struct ConservativeState3D {
    double rho = 0;
    double rhoux = 0;
    double rhouy = 0;
    double rhouz = 0;
    double E = 0;
    double alpha1 = 0;
    double alpha2 = 0;
    double arho1 = 0;
    double arho2 = 0;
};
#endif

#endif // CFD_STATES_HPP
