#ifndef CFD_SOLVER_2D_HPP
#define CFD_SOLVER_2D_HPP

#include <vector>
#include <string>
#include <cstdint>
#include "materials.hpp"
#include "cfd_states.hpp"
#include "cfd_tile.hpp"

enum class BCType2D { REFLECTIVE, TRANSMISSIVE, OUTFLOW_RIEMANN };

struct Gauge2D {
    std::string name;
    double r, z;
};

class CFDSolver2D {
public:
    enum FluxScheme { RUSANOV, AUSM_PLUS };
    enum BCType { REFLECTIVE, TRANSMISSIVE, OUTFLOW_RIEMANN };

    virtual ~CFDSolver2D() = default;

    virtual void setInitialConditionTNT(double explosive_z, double explosive_radius, 
                                        double high_rho,
                                        double ambient_rho, double ambient_p) = 0;

    virtual void setInitialConditionIdealGas(double explosive_z, double explosive_radius,
                                             double high_rho, double detonation_energy,
                                             double ambient_rho, double ambient_p) = 0;

    virtual void setInitialConditionTNTCylinder(double explosive_z, double radius, double height,
                                                double high_rho,
                                                double ambient_rho, double ambient_p) = 0;

    virtual void setInitialConditionFrom1D(double explosive_z, double remap_radius,
                                           const std::vector<double>& r_1d,
                                           const std::vector<MultiMaterialState>& states_1d,
                                           double ambient_rho, double ambient_p,
                                           double explosive_r = 0.0) = 0;

    virtual void setFluxScheme(const std::string& scheme_name) = 0;
    virtual void setSpatialOrder(int order) = 0;
    virtual void setTemporalOrder(int order) = 0;
    virtual void setMaterialParameters(const MultiMat::MaterialSet& materials) = 0;
    virtual void setGamma(double g) = 0;
    virtual void setIdealGas(bool val) = 0;

    virtual void step(double dt) = 0;
    virtual void run(double duration) = 0;
    virtual double computeStepSize(double cfl = 0.35) const = 0;
    virtual std::vector<double> getLocalTimesteps(double cfl) const = 0;

    virtual int getNr() const = 0;
    virtual int getNz() const = 0;
    virtual double getDr() const = 0;
    virtual double getDz() const = 0;
    virtual double getTime() const = 0;
    virtual void setTime(double t) = 0;
    virtual double getGamma() const = 0;
    virtual FluxScheme getFluxScheme() const = 0;
    virtual int getSpatialOrder() const = 0;
    virtual int getTemporalOrder() const = 0;
    virtual void setBCTypes(BCType r_min, BCType r_max, BCType z_min, BCType z_max) = 0;
    virtual void setCoordinateSystemCartesian(bool cartesian) = 0;
    virtual void setDetonatorLocation(double r, double z) = 0;

    virtual BCType getBCRmin() const = 0;
    virtual BCType getBCRmax() const = 0;
    virtual BCType getBCZmin() const = 0;
    virtual BCType getBCZmax() const = 0;
    virtual double getAmbientRho() const = 0;
    virtual double getAmbientP() const = 0;
    virtual const MultiMat::MaterialSet& getMaterialParameters() const = 0;
    virtual bool isIdealGas() const = 0;

    virtual bool checkTerminationCondition() const = 0;

    virtual std::vector<State2D> getStates() const = 0;
    virtual std::vector<float> getTelemetry2D(int stride = 1) const = 0;
    virtual std::vector<float> getCellValues(int i, int j) const = 0;

    virtual void setGauges(const std::vector<Gauge2D>& gauges) {}
    virtual void recordGaugesAsync(double t) {}
    virtual void retrieveNewGaugeSamples(std::vector<double>& times, std::vector<float>& values) {}

    virtual void setSolidVelocities(const double* v) = 0;
    virtual void setSolidMask(const uint8_t* mask) = 0;
};

template <typename RealType>
class CFDSolver2DImpl : public CFDSolver2D {
public:
    CFDSolver2DImpl(int nr, int nz, double max_r, double max_z, double gamma = 1.4);

    void setInitialConditionTNT(double explosive_z, double explosive_radius, 
                                double high_rho,
                                double ambient_rho, double ambient_p) override;

    void setInitialConditionIdealGas(double explosive_z, double explosive_radius,
                                     double high_rho, double detonation_energy,
                                     double ambient_rho, double ambient_p) override;

    void setInitialConditionTNTCylinder(double explosive_z, double radius, double height,
                                        double high_rho,
                                        double ambient_rho, double ambient_p) override;

    void setInitialConditionFrom1D(double explosive_z, double remap_radius,
                                   const std::vector<double>& r_1d,
                                   const std::vector<MultiMaterialState>& states_1d,
                                   double ambient_rho, double ambient_p,
                                   double explosive_r = 0.0) override;

    void setFluxScheme(const std::string& scheme_name) override;
    void setSpatialOrder(int order) override { spatialOrder = order; }
    void setTemporalOrder(int order) override { temporalOrder = order; }
    void setMaterialParameters(const MultiMat::MaterialSet& materials) override {
        currentMaterials = materials;
        MultiMat::initializePrecalculatedTerms(currentMaterials);
    }
    void setGamma(double g) override { gamma = g; }
    void setIdealGas(bool val) override { is_ideal_gas = val; }

    void step(double dt) override;
    void run(double duration) override;
    double computeStepSize(double cfl = 0.35) const override;
    std::vector<double> getLocalTimesteps(double cfl) const override;

    int getNr() const override { return nr_cells; }
    int getNz() const override { return nz_cells; }
    double getDr() const override { return dr; }
    double getDz() const override { return dz; }
    double getTime() const override { return currentTime; }
    void setTime(double t) override { currentTime = t; }
    double getGamma() const override { return gamma; }
    FluxScheme getFluxScheme() const override { return currentScheme; }
    int getSpatialOrder() const override { return spatialOrder; }
    int getTemporalOrder() const override { return temporalOrder; }
    void setBCTypes(BCType r_min, BCType r_max, BCType z_min, BCType z_max) override {
        bcRmin = r_min; bcRmax = r_max; bcZmin = z_min; bcZmax = z_max;
    }
    void setCoordinateSystemCartesian(bool cartesian) override { is_cartesian = cartesian; }
    void setDetonatorLocation(double r, double z) override {
        det_x = r;
        det_z = z;
    }

    BCType getBCRmin() const override { return bcRmin; }
    BCType getBCRmax() const override { return bcRmax; }
    BCType getBCZmin() const override { return bcZmin; }
    BCType getBCZmax() const override { return bcZmax; }
    double getAmbientRho() const override { return ambient_rho; }
    double getAmbientP() const override { return ambient_p; }
    const MultiMat::MaterialSet& getMaterialParameters() const override { return currentMaterials; }
    bool isIdealGas() const override { return is_ideal_gas; }

    bool checkTerminationCondition() const override;

    std::vector<State2D> getStates() const override;
    std::vector<float> getTelemetry2D(int stride = 1) const override;
    std::vector<float> getCellValues(int i, int j) const override;

    void setGauges(const std::vector<Gauge2D>& gauges) override;
    void recordGaugesAsync(double t) override;
    void retrieveNewGaugeSamples(std::vector<double>& times, std::vector<float>& values) override;

    void setSolidVelocities(const double* v) override;
    void setSolidMask(const uint8_t* mask) override;

private:
    int nr_cells;
    int nz_cells;
    double max_r;
    double max_z;
    double dr;
    double dz;
    double gamma;
    double currentTime;
    FluxScheme currentScheme;
    int spatialOrder = 1;
    int temporalOrder = 1;
    BCType bcRmin = REFLECTIVE;
    BCType bcRmax = OUTFLOW_RIEMANN;
    BCType bcZmin = REFLECTIVE;
    BCType bcZmax = OUTFLOW_RIEMANN;
    bool is_cartesian = false;
    double ambient_rho;
    double ambient_p;
    MultiMat::MaterialSet currentMaterials = MultiMat::TNT;
    double det_x = 0.0;
    double det_y = 0.0;
    double det_z = 0.0;

    // Tile management
    int num_tiles_r;
    int num_tiles_z;
    std::vector<int32_t> tile_map; // -1 if inactive, else index in pool

    std::vector<PrimitiveTileT<RealType>> states_pool;
    std::vector<ConservativeTileT<RealType>> U_pool;
    std::vector<ConservativeTileT<RealType>> dU_pool;

    int allocateTile(int tr, int tz);
    void updateActiveRegion();
    void initTileToAmbient(int pool_idx);

    bool is_ideal_gas;

    // Helper functions for cell access
    inline bool isValidCell(int i, int j) const {
        return (i >= 0 && i < nr_cells && j >= 0 && j < nz_cells);
    }
    
    // Core physics methods adapted for tile processing
    void computeTileRHS(int pool_idx, int tr, int tz, double A_coeff, double dt);
    void applyLSRK3Step(int stage, double dt);
    
    void updatePrimitiveFromConservative();
    
    std::vector<double> solid_vel;
    std::vector<uint8_t> solid_mask;

    std::vector<Gauge2D> cpu_gauges;
    std::vector<double> cpu_gauge_times;
    std::vector<float> cpu_gauge_values;
};

#endif

