#ifndef CFD_SOLVER_2D_CUDA_HPP
#define CFD_SOLVER_2D_CUDA_HPP

#include <vector>
#include <string>
#include <cstdint>
#include "materials.hpp"
#include "cfd_states.hpp"
#include "cfd_tile.hpp"

class CFDSolver2DCuda {
public:
    enum FluxScheme { RUSANOV, AUSM_PLUS };
    enum BCType { REFLECTIVE, TRANSMISSIVE, OUTFLOW_RIEMANN };

    CFDSolver2DCuda(int nr, int nz, double max_r, double max_z, double gamma = 1.4);
    ~CFDSolver2DCuda();

    void setInitialConditionFrom1D(double explosive_z, double remap_radius,
                                   const std::vector<double>& r_1d,
                                   const std::vector<MultiMaterialState>& states_1d,
                                   double ambient_rho, double ambient_p,
                                   double explosive_r = 0.0);
    void setInitialConditionTNTCylinder(double explosive_z, double radius, double height,
                                        double high_rho,
                                        double ambient_rho, double ambient_p);
    void setInitialConditionTNT(double explosive_z, double explosive_radius,
                                double high_rho,
                                double ambient_rho, double ambient_p);
    void setInitialConditionIdealGas(double explosive_z, double explosive_radius,
                                     double high_rho, double detonation_energy,
                                     double ambient_rho, double ambient_p);
    
    void setFluxScheme(const std::string& scheme_name);
    void setSpatialOrder(int order) { spatialOrder = order; }
    void setTemporalOrder(int order) { temporalOrder = order; }
    void setMaterialParameters(const MultiMat::MaterialSet& materials);

    void step(double dt);
    void run(double duration);

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

    std::vector<State2D> getStates();
    std::vector<float> getTelemetry2D(int stride = 1);
    double getMaxWaveSpeed();

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
    double ambient_rho;
    double ambient_p;
    MultiMat::MaterialSet currentMaterials = MultiMat::TNT;
    MultiMat::MaterialSet* d_materials = nullptr;
    double det_x = 0.0;
    double det_y = 0.0;
    double det_z = 0.0;

    bool is_ideal_gas;

    // Tile management
    int num_tiles_r;
    int num_tiles_z;
    int max_active_tiles;

    std::vector<int32_t> host_tile_map;
    int current_pool_size;
    int step_count = 0; // for throttling updateActiveRegionHost

    int32_t* d_tile_map;
    PrimitiveTile* d_states_pool;
    ConservativeTile* d_U_pool;
    ConservativeTile* d_dU_pool;

    double* d_wave_speeds;
    double* d_block_maxes;
    double* d_block_p_ratios;
    uint8_t* d_tile_active_flags;
    
    // CPU fallback arrays for initialization
    std::vector<PrimitiveTile> host_states_pool;
    std::vector<ConservativeTile> host_U_pool;

    int allocateTile(int tr, int tz);
    void growTilePool(int new_max_tiles);
    void initTileToAmbientHost(int pool_idx);
    void syncPoolToDevice();
    void updateActiveRegionHost();
};

void get_cuda_vram_info(size_t& free_bytes, size_t& total_bytes);

#endif

