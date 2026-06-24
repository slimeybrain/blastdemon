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

    virtual ~CFDSolver() = default;

    virtual void setInitialConditionTNT(double explosive_radius, double high_rho, double ambient_rho, double ambient_p) = 0;
    virtual void setInitialConditionIdealGas(double explosive_radius, double high_rho, double detonation_energy, double ambient_rho, double ambient_p) = 0;
    virtual void setInitialConditionRoseTNT(double explosive_radius, double high_rho, double chemical_energy, double ambient_rho, double ambient_p, double det_vel) = 0;
    virtual void setFluxScheme(const std::string& scheme_name) = 0;
    virtual void setSpatialOrder(int order) = 0;
    virtual void setTemporalOrder(int order) = 0;
    virtual void setMaterialParameters(const MultiMat::MaterialSet& materials) = 0;
    virtual void setCancelFlag(std::atomic<bool>* flag) = 0;
    virtual void setProgressRef(std::atomic<int>* ref) = 0;

    virtual void step(double dt) = 0;
    virtual void run(double duration) = 0;
    virtual double computeStepSize(double cfl = 0.4) const = 0;

    virtual int getNumCells() const = 0;
    virtual int getActiveIndex() const = 0;
    virtual bool is_terminated() const = 0;
    virtual double getRadius() const = 0;
    virtual double getCellSize() const = 0;
    virtual double getTime() const = 0;
    virtual double getGamma() const = 0;
    virtual FluxScheme getFluxScheme() const = 0;
    virtual int getSpatialOrder() const = 0;
    virtual int getTemporalOrder() const = 0;
    virtual void setBCTypes(BCType left, BCType right) = 0;
    virtual double getAmbientRho() const = 0;
    virtual double getAmbientP() const = 0;

    virtual std::vector<float> getTelemetryChannels() const = 0;
    virtual std::vector<double> getLocalTimesteps(double cfl) const = 0;

    virtual const std::vector<double>& getGeomV() const = 0;
    virtual const std::vector<double>& getGeomA() const = 0;
};

template <bool IsMultiMaterial>
class CFDSolverImpl : public CFDSolver {
public:
    using PrimitiveState = typename StateTypes<IsMultiMaterial>::PrimitiveState;
    using ConservedState = typename StateTypes<IsMultiMaterial>::ConservedState;

    CFDSolverImpl(int num_cells, double domain_radius, double gamma = 1.4);

    void setInitialConditionTNT(double explosive_radius, double high_rho, double ambient_rho, double ambient_p) override;
    void setInitialConditionIdealGas(double explosive_radius, double high_rho, double detonation_energy, double ambient_rho, double ambient_p) override;
    void setInitialConditionRoseTNT(double explosive_radius, double high_rho, double chemical_energy, double ambient_rho, double ambient_p, double det_vel) override;
    void setFluxScheme(const std::string& scheme_name) override;
    void setSpatialOrder(int order) override { spatialOrder = order; }
    void setTemporalOrder(int order) override { temporalOrder = order; }
    void setMaterialParameters(const MultiMat::MaterialSet& materials) override { currentMaterials = materials; }
    void setCancelFlag(std::atomic<bool>* flag) override { cancel_flag = flag; }
    void setProgressRef(std::atomic<int>* ref) override { progress_ref = ref; }

    void step(double dt) override;
    void run(double duration) override;
    double computeStepSize(double cfl = 0.4) const override;

    int getNumCells() const override { return n_cells; }
    int getActiveIndex() const override { return active_r_idx; }
    bool is_terminated() const override { return active_r_idx >= n_cells; }
    double getRadius() const override { return radius; }
    double getCellSize() const override { return dr; }
    double getTime() const override { return currentTime; }
    double getGamma() const override { return gamma; }
    FluxScheme getFluxScheme() const override { return currentScheme; }
    int getSpatialOrder() const override { return spatialOrder; }
    int getTemporalOrder() const override { return temporalOrder; }
    void setBCTypes(BCType left, BCType right) override { bcLeft = left; bcRight = right; }
    double getAmbientRho() const override { return ambient_rho; }
    double getAmbientP() const override { return ambient_p; }

    std::vector<float> getTelemetryChannels() const override;
    std::vector<double> getLocalTimesteps(double cfl) const override;

    const std::vector<double>& getGeomV() const override { return geom_V; }
    const std::vector<double>& getGeomA() const override { return geom_A; }

    const std::vector<PrimitiveState>& getStates() const { return states; }

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

    std::vector<PrimitiveState> states;
    std::vector<ConservedState> U;
    std::vector<double> v_int; // Interface velocities

    std::vector<double> geom_V;
    std::vector<double> geom_A;

    std::atomic<bool>* cancel_flag = nullptr;
    std::atomic<int>* progress_ref = nullptr;

    void updatePrimitiveFromConservative(std::vector<ConservedState>& U_vec, std::vector<PrimitiveState>& states_vec);
    void updateConservativeFromPrimitive(const std::vector<PrimitiveState>& states_vec, std::vector<ConservedState>& U_vec);

    ConservedState flux(const PrimitiveState& s);
    ConservedState computedUdt(const std::vector<ConservedState>& U_current, const std::vector<PrimitiveState>& states_current, int i, double dt);

    void reconstruct(const std::vector<PrimitiveState>& states_current, int i, PrimitiveState& s_L, PrimitiveState& s_R, double dt);

    ConservedState getFlux(const PrimitiveState& sL, const PrimitiveState& sR, const ConservedState& uL, const ConservedState& uR, double dt, double& v_face);
    ConservedState getFluxRusanov(const PrimitiveState& sL, const PrimitiveState& sR, const ConservedState& uL, const ConservedState& uR, double& v_face);
    ConservedState getFluxAUSMPlus(const PrimitiveState& sL, const PrimitiveState& sR, double& v_face);
};

#endif
