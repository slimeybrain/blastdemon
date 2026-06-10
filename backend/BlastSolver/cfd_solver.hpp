#ifndef CFD_SOLVER_HPP
#define CFD_SOLVER_HPP

#include <vector>
#include <string>
#include <atomic>
#include "materials.hpp"
#include "cfd_states.hpp"


class CFDSolver {
public:
    enum FluxScheme { RUSANOV, AUSM_PLUS };
    enum BCType { REFLECTIVE, TRANSMISSIVE };

    CFDSolver(int num_cells, double domain_radius, double gamma = 1.4);

    void setInitialConditionTNT(double explosive_radius, double high_rho, double ambient_rho, double ambient_p);
    void setInitialConditionIdealGas(double explosive_radius, double high_rho, double detonation_energy, double ambient_rho, double ambient_p);
    void setInitialConditionRoseTNT(double explosive_radius, double high_rho, double chemical_energy, double ambient_rho, double ambient_p, double det_vel);
    void setFluxScheme(const std::string& scheme_name);
    void setSpatialOrder(int order) { spatialOrder = order; }
    void setTemporalOrder(int order) { temporalOrder = order; }
    void setMaterialParameters(const MultiMat::MaterialSet& materials) { currentMaterials = materials; }
    void setCancelFlag(std::atomic<bool>* flag) { cancel_flag = flag; }
    void setProgressRef(std::atomic<int>* ref) { progress_ref = ref; }

    void step(double dt);
    void run(double duration);
    double computeStepSize(double cfl = 0.4) const;

    int getNumCells() const { return n_cells; }
    int getActiveIndex() const { return active_r_idx; }
    bool is_terminated() const { return active_r_idx >= n_cells; }
    double getRadius() const { return radius; }
    double getCellSize() const { return dr; }
    double getTime() const { return currentTime; }
    double getGamma() const { return gamma; }
    FluxScheme getFluxScheme() const { return currentScheme; }
    int getSpatialOrder() const { return spatialOrder; }
    int getTemporalOrder() const { return temporalOrder; }
    void setBCTypes(BCType left, BCType right) { bcLeft = left; bcRight = right; }
    double getAmbientRho() const { return ambient_rho; }
    double getAmbientP() const { return ambient_p; }

    const std::vector<State>& getStates() const { return states; }
    std::vector<double> getLocalTimesteps(double cfl) const;
    void setCustomInitialCondition(const std::vector<State>& initial_states);

    const std::vector<double>& getGeomV() const { return geom_V; }
    const std::vector<double>& getGeomA() const { return geom_A; }

private:
    int n_cells;
    double radius;
    double dr;
    double gamma;
    double currentTime;
    FluxScheme currentScheme;
    int spatialOrder = 1;
    int temporalOrder = 1;
    BCType bcLeft = REFLECTIVE;
    BCType bcRight = TRANSMISSIVE;
    double ambient_rho;
    double ambient_p;
    int active_r_idx;
    MultiMat::MaterialSet currentMaterials = MultiMat::TNT;

    std::vector<State> states;
    std::vector<ConservativeState> U;
    std::vector<double> v_int; // Interface velocities

    std::vector<double> geom_V;
    std::vector<double> geom_A;

    std::atomic<bool>* cancel_flag = nullptr;
    std::atomic<int>* progress_ref = nullptr;

    void updatePrimitiveFromConservative(std::vector<ConservativeState>& U_vec, std::vector<State>& states_vec);
    void updateConservativeFromPrimitive(const std::vector<State>& states_vec, std::vector<ConservativeState>& U_vec);

    ConservativeState flux(const State& s);
    ConservativeState computedUdt(const std::vector<ConservativeState>& U_current, const std::vector<State>& states_current, int i, double dt);

    // Higher-order interface reconstruction
    void reconstruct(const std::vector<State>& states_current, int i, State& s_L, State& s_R, double dt);

    ConservativeState getFlux(const State& sL, const State& sR, const ConservativeState& uL, const ConservativeState& uR, double dt, double& v_face);
    ConservativeState getFluxRusanov(const State& sL, const State& sR, const ConservativeState& uL, const ConservativeState& uR, double& v_face);
    ConservativeState getFluxAUSMPlus(const State& sL, const State& sR, double& v_face);
};

#endif
