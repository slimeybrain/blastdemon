#ifndef CFD_SOLVER_2D_CUDA_HPP
#define CFD_SOLVER_2D_CUDA_HPP

#include <vector>
#include <string>
#include <cstdint>
#include "materials.hpp"
#include "cfd_states.hpp"
#include "cfd_tile.hpp"
#include "cfd_solver_2d.hpp"

class CFDSolver2DCuda {
public:
    enum FluxScheme { RUSANOV, AUSM_PLUS };
    enum BCType { REFLECTIVE, TRANSMISSIVE, OUTFLOW_RIEMANN };

    virtual ~CFDSolver2DCuda() = default;

    virtual void setInitialConditionFrom1D(double explosive_z, double remap_radius,
                                           const std::vector<double>& r_1d,
                                           const std::vector<MultiMaterialState>& states_1d,
                                           double ambient_rho, double ambient_p,
                                           double explosive_r = 0.0) = 0;
    virtual void setInitialConditionTNTCylinder(double explosive_z, double radius, double height,
                                                double high_rho,
                                                double ambient_rho, double ambient_p) = 0;
    virtual void setInitialConditionTNT(double explosive_z, double explosive_radius,
                                        double high_rho,
                                        double ambient_rho, double ambient_p) = 0;
    virtual void setInitialConditionIdealGas(double explosive_z, double explosive_radius,
                                             double high_rho, double detonation_energy,
                                             double ambient_rho, double ambient_p) = 0;
    
    virtual void setFluxScheme(const std::string& scheme_name) = 0;
    virtual void setSpatialOrder(int order) = 0;
    virtual void setTemporalOrder(int order) = 0;
    virtual void setMaterialParameters(const MultiMat::MaterialSet& materials) = 0;
    virtual void setGamma(double g) = 0;
    virtual void setIdealGas(bool val) = 0;

    virtual void step(double dt) = 0;
    virtual void run(double duration) = 0;

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
    virtual void setDetonatorLocation(double r, double z) = 0;

    virtual std::vector<State2D> getStates() = 0;
    virtual std::vector<float> getTelemetry2D(int stride = 1) = 0;
    virtual std::vector<float> getCellValues(int i, int j) = 0;

    virtual void setGauges(const std::vector<Gauge2D>& gauges) {}
    virtual void recordGaugesAsync(double t) {}
    virtual void retrieveNewGaugeSamples(std::vector<double>& times, std::vector<float>& values) {}

    virtual double getMaxWaveSpeed() = 0;
    virtual bool checkTerminationCondition() = 0;
    virtual bool isIdealGas() const = 0;
    virtual size_t getAllocatedVRAM() const = 0;
    virtual double getAmbientP() const = 0;
};

struct GPUGauge2D {
    int tr;
    int tz;
    int k;
};

template <typename RealType>
class CFDSolver2DCudaImpl : public CFDSolver2DCuda {
public:
    CFDSolver2DCudaImpl(int nr, int nz, double max_r, double max_z, double gamma = 1.4);
    ~CFDSolver2DCudaImpl() override;

    void setInitialConditionFrom1D(double explosive_z, double remap_radius,
                                   const std::vector<double>& r_1d,
                                   const std::vector<MultiMaterialState>& states_1d,
                                   double ambient_rho, double ambient_p,
                                   double explosive_r = 0.0) override;
    void setInitialConditionTNTCylinder(double explosive_z, double radius, double height,
                                        double high_rho,
                                        double ambient_rho, double ambient_p) override;
    void setInitialConditionTNT(double explosive_z, double explosive_radius,
                                double high_rho,
                                double ambient_rho, double ambient_p) override;
    void setInitialConditionIdealGas(double explosive_z, double explosive_radius,
                                     double high_rho, double detonation_energy,
                                     double ambient_rho, double ambient_p) override;
    
    void setFluxScheme(const std::string& scheme_name) override;
    void setSpatialOrder(int order) override { spatialOrder = order; }
    void setTemporalOrder(int order) override { temporalOrder = order; }
    void setMaterialParameters(const MultiMat::MaterialSet& materials) override;
    void setGamma(double g) override { gamma = g; }
    void setIdealGas(bool val) override { is_ideal_gas = val; }

    void step(double dt) override;
    void run(double duration) override;

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
    void setDetonatorLocation(double r, double z) override {
        det_x = r;
        det_z = z;
    }

    std::vector<State2D> getStates() override;
    std::vector<float> getTelemetry2D(int stride = 1) override;
    std::vector<float> getCellValues(int i, int j) override;

    void setGauges(const std::vector<Gauge2D>& gauges) override;
    void recordGaugesAsync(double t) override;
    void retrieveNewGaugeSamples(std::vector<double>& times, std::vector<float>& values) override;

    double getMaxWaveSpeed() override;
    bool checkTerminationCondition() override;
    bool isIdealGas() const override { return is_ideal_gas; }
    size_t getAllocatedVRAM() const override;
    double getAmbientP() const override { return ambient_p; }

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

    // GPU-side gauge variables
    int num_gauges = 0;
    void* d_gauge_coords = nullptr;
    void* d_gauge_results = nullptr;
    void* gauge_stream = nullptr;
    void* step_done = nullptr;

    // Host pinned circular buffer
    float* host_pinned_gauge_data = nullptr;
    int host_pinned_capacity = 4096;
    int write_idx = 0;
    std::vector<double> host_pinned_times;

    // Buffered history for retrieval
    std::vector<double> buffered_times;
    std::vector<float> buffered_values;

    // Tile management
    int num_tiles_r;
    int num_tiles_z;
    int max_active_tiles;

    std::vector<int32_t> host_tile_map;
    int current_pool_size;
    int step_count = 0; // for throttling updateActiveRegionHost

    int32_t* d_tile_map;
    PrimitiveTileT<RealType>* d_states_pool;
    ConservativeTileT<RealType>* d_U_pool;
    ConservativeTileT<RealType>* d_dU_pool;

    RealType* d_wave_speeds;
    RealType* d_block_maxes;
    RealType* d_block_p_ratios;
    uint8_t* d_tile_active_flags;
    int* d_terminated = nullptr;
    
    // CPU fallback arrays for initialization
    std::vector<PrimitiveTileT<RealType>> host_states_pool;
    std::vector<ConservativeTileT<RealType>> host_U_pool;

    int allocateTile(int tr, int tz);
    void growTilePool(int new_max_tiles);
    void initTileToAmbientHost(int pool_idx);
    void syncPoolToDevice();
    void updateActiveRegionHost();
};

void get_cuda_vram_info(size_t& free_bytes, size_t& total_bytes);

#endif

