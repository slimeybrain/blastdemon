#ifndef CFD_SOLVER_2D_HPP
#define CFD_SOLVER_2D_HPP

#include <vector>
#include <string>
#include <cstdint>
#include "materials.hpp"
#include "cfd_states.hpp"
#include "cfd_tile.hpp"

class CFDSolver2D {
public:
    enum FluxScheme { RUSANOV, AUSM_PLUS };
    enum BCType { REFLECTIVE, TRANSMISSIVE, OUTFLOW_RIEMANN };

    CFDSolver2D(int nr, int nz, double max_r, double max_z, double gamma = 1.4);

    void setInitialConditionTNT(double explosive_z, double explosive_radius, 
                                double high_rho,
                                double ambient_rho, double ambient_p);

    void setInitialConditionIdealGas(double explosive_z, double explosive_radius,
                                     double high_rho, double detonation_energy,
                                     double ambient_rho, double ambient_p);

    void setInitialConditionTNTCylinder(double explosive_z, double radius, double height,
                                        double high_rho,
                                        double ambient_rho, double ambient_p);

    void setInitialConditionFrom1D(double explosive_z, double remap_radius,
                                   const std::vector<double>& r_1d,
                                   const std::vector<MultiMaterialState>& states_1d,
                                   double ambient_rho, double ambient_p,
                                   double explosive_r = 0.0);

    void setFluxScheme(const std::string& scheme_name);
    void setSpatialOrder(int order) { spatialOrder = order; }
    void setTemporalOrder(int order) { temporalOrder = order; }
    void setMaterialParameters(const MultiMat::MaterialSet& materials) { currentMaterials = materials; }

    void step(double dt);
    void run(double duration);
    double computeStepSize(double cfl = 0.35) const;
    std::vector<double> getLocalTimesteps(double cfl) const;

    int getNr() const { return nr_cells; }
    int getNz() const { return nz_cells; }
    double getDr() const { return dr; }
    double getDz() const { return dz; }
    double getTime() const { return currentTime; }
    void setTime(double t) { currentTime = t; }
    double getGamma() const { return gamma; }
    FluxScheme getFluxScheme() const { return currentScheme; }
    int getSpatialOrder() const { return spatialOrder; }
    int getTemporalOrder() const { return temporalOrder; }
    void setBCTypes(BCType r_min, BCType r_max, BCType z_min, BCType z_max) {
        bcRmin = r_min; bcRmax = r_max; bcZmin = z_min; bcZmax = z_max;
    }
    void setCoordinateSystemCartesian(bool cartesian) { is_cartesian = cartesian; }
    void setDetonatorLocation(double r, double z) {
        det_x = r;
        det_z = z;
    }

    BCType getBCRmin() const { return bcRmin; }
    BCType getBCRmax() const { return bcRmax; }
    BCType getBCZmin() const { return bcZmin; }
    BCType getBCZmax() const { return bcZmax; }
    double getAmbientRho() const { return ambient_rho; }
    double getAmbientP() const { return ambient_p; }
    const MultiMat::MaterialSet& getMaterialParameters() const { return currentMaterials; }
    bool isIdealGas() const { return is_ideal_gas; }

    bool checkTerminationCondition() const;

    // Telemetry and export (Needs conversion from Sparse SoA to expected format)
    std::vector<State2D> getStates() const;
    std::vector<float> getTelemetry2D(int stride = 1) const;
    std::vector<float> getCellValues(int i, int j) const;

    void setSolidVelocities(const double* v);
    void setSolidMask(const uint8_t* mask);

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

    std::vector<PrimitiveTile> states_pool;
    std::vector<ConservativeTile> U_pool;
    std::vector<ConservativeTile> dU_pool;

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
};

#endif

