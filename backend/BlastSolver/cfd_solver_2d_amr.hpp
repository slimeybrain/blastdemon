#ifndef CFD_SOLVER_2D_AMR_HPP
#define CFD_SOLVER_2D_AMR_HPP

#include "cfd_solver_2d.hpp"
#include "cfd_2d_math_kernels.hpp"
#include <vector>
#include <string>
#include <memory>
#include <mutex>
#include <array>

struct AMRTileNode {
    int tile_id;       // Index in the state/conservative pools (-1 if unallocated)
    int level;         // Refinement level (0 is coarsest)
    int parent;        // Parent node index in the amr_nodes list (-1 if level 0)
    int children[4];   // Children node indices in the amr_nodes list (-1 if leaf)
    int neighbors[4];  // Neighbor node indices in the amr_nodes list (-1 if boundary)
    bool is_active;    // True if active leaf tile
    int r_idx, z_idx;  // Tile coordinates at its level
    double r_min, r_max, z_min, z_max;
};

// Layout of memory block inside AMR tiles (including 2 cells of ghost padding on each side)
constexpr int AMR_TILE_DIM = 20; // 16 + 2 * 2 ghost cells

template <typename RealType>
struct AMRPrimitiveTileT {
    RealType rho[AMR_TILE_DIM * AMR_TILE_DIM];
    RealType ur[AMR_TILE_DIM * AMR_TILE_DIM];
    RealType uz[AMR_TILE_DIM * AMR_TILE_DIM];
    RealType p[AMR_TILE_DIM * AMR_TILE_DIM];
    RealType E[AMR_TILE_DIM * AMR_TILE_DIM];
    RealType alpha1[AMR_TILE_DIM * AMR_TILE_DIM];
    RealType alpha2[AMR_TILE_DIM * AMR_TILE_DIM];
    RealType arho1[AMR_TILE_DIM * AMR_TILE_DIM];
    RealType arho2[AMR_TILE_DIM * AMR_TILE_DIM];
    int floor_status[AMR_TILE_DIM * AMR_TILE_DIM];
};

template <typename RealType>
struct AMRConservativeTileT {
    RealType rho[AMR_TILE_DIM * AMR_TILE_DIM];
    RealType rhour[AMR_TILE_DIM * AMR_TILE_DIM];
    RealType rhouz[AMR_TILE_DIM * AMR_TILE_DIM];
    RealType E[AMR_TILE_DIM * AMR_TILE_DIM];
    RealType alpha1[AMR_TILE_DIM * AMR_TILE_DIM];
    RealType alpha2[AMR_TILE_DIM * AMR_TILE_DIM];
    RealType arho1[AMR_TILE_DIM * AMR_TILE_DIM];
    RealType arho2[AMR_TILE_DIM * AMR_TILE_DIM];
};

// Interface directions
enum AMRDir { AMR_DIR_LEFT = 0, AMR_DIR_RIGHT = 1, AMR_DIR_BOTTOM = 2, AMR_DIR_TOP = 3 };

template <typename RealType>
struct AMRFaceFluxT {
    RealType rho[TILE_SIZE];
    RealType rhour[TILE_SIZE];
    RealType rhouz[TILE_SIZE];
    RealType E[TILE_SIZE];
    RealType alpha1[TILE_SIZE];
    RealType alpha2[TILE_SIZE];
    RealType arho1[TILE_SIZE];
    RealType arho2[TILE_SIZE];
};

template <typename RealType>
class CFDSolver2DAMRImpl : public CFDSolver2D {
    friend int main();
private:
    int level0_nr;
    int level0_nz;
    int level0_num_tiles_r;
    int level0_num_tiles_z;
    double max_r_coord;
    double max_z_coord;
    double dr_base;
    double dz_base;
    double time_val;
    double gamma_val;
    bool is_ideal_gas_val;
    
    int amr_max_levels_val;
    double amr_threshold_val;
    double amr_coarsen_ratio_val;
    int adapt_step_counter;

    std::string flux_scheme_name;
    int spatial_order_val;
    int temporal_order_val;

    CFDSolver2D::BCType bc_r_min;
    CFDSolver2D::BCType bc_r_max;
    CFDSolver2D::BCType bc_z_min;
    CFDSolver2D::BCType bc_z_max;

    bool is_cartesian;
    double detonator_r_coord;
    double detonator_z_coord;

    double ambient_rho_val;
    double ambient_p_val;

    MultiMat::MaterialSet materials_val;

    // Solid obstacle boundaries (not implemented or empty for 2D solvers, but required in virtual interface)
    std::vector<double> solid_vel;
    std::vector<uint8_t> solid_mask;

    // AMR Node tree and pools
    std::vector<AMRTileNode> amr_nodes;
    std::vector<AMRPrimitiveTileT<RealType>> states_pool;
    std::vector<AMRConservativeTileT<RealType>> U_pool;
    std::vector<AMRConservativeTileT<RealType>> dU_pool;
    std::vector<int> free_tile_ids;

    // Boundary flux buffers for flux correction at interfaces
    std::vector<std::array<AMRFaceFluxT<RealType>, 4>> node_boundary_fluxes;

    int allocateTile();
    void freeTile(int tile_id);
    void rebuildNeighborPointers();
    int findNeighborNode(int node_idx, int dir);
    int findNodeByCoords(int r_idx, int z_idx, int level);
    int findLeafNodeAtCoords(double r, double z) const;

    void fillGhostCells();
    void computeTileRHS(int node_idx, double A_coeff, double dt);
    void applyLSRK3Step(int stage, double dt);
    void applyFluxCorrection(int stage, double dt);
    void updatePrimitiveFromConservative();
    void restrictAll();
    void restrictNode(int node_idx);
    void adaptMesh();
    double computeTileLoehnerError(int tile_id) const;
    bool shouldRefineNode(int node_idx);
    bool shouldCoarsenNode(int parent_idx);
    bool canCoarsenParent(int parent_idx) const;
    void refineNode(int node_idx);
    void coarsenNode(int parent_idx);

    // Initial Condition helpers
    void applyInitialConditionToNode(int node_idx, double explosive_z, double explosive_radius, double high_rho, double detonation_energy, double ambient_rho, double ambient_p, bool is_tnt, bool is_cylinder = false, double charge_height = 0.0);

public:
    CFDSolver2DAMRImpl(int nr, int nz, double max_r, double max_z, double gamma, int max_levels = 3, double threshold = 0.05, double coarsen_ratio = 0.2);
    virtual ~CFDSolver2DAMRImpl() = default;

    virtual void setInitialConditionTNT(double explosive_z, double explosive_radius, 
                                        double high_rho,
                                        double ambient_rho, double ambient_p, double explosive_r = 0.0) override;

    virtual void setInitialConditionIdealGas(double explosive_z, double explosive_radius,
                                             double high_rho, double detonation_energy,
                                             double ambient_rho, double ambient_p, double explosive_r = 0.0) override;

    virtual void setInitialConditionTNTCylinder(double explosive_z, double radius, double height,
                                                double high_rho,
                                                double ambient_rho, double ambient_p, double explosive_r = 0.0) override;

    virtual void setInitialConditionFrom1D(double explosive_z, double remap_radius,
                                           const std::vector<double>& r_1d,
                                           const std::vector<MultiMaterialState>& states_1d,
                                           double ambient_rho, double ambient_p,
                                           double explosive_r = 0.0) override;

    virtual void setFluxScheme(const std::string& scheme_name) override;
    virtual void setSpatialOrder(int order) override;
    virtual void setTemporalOrder(int order) override;
    virtual void setMaterialParameters(const MultiMat::MaterialSet& materials) override;
    virtual void setGamma(double g) override;
    virtual void setIdealGas(bool val) override;

    virtual void step(double dt) override;
    virtual void run(double duration) override;
    virtual double computeStepSize(double cfl = 0.35) const override;
    virtual std::vector<double> getLocalTimesteps(double cfl) const override;

    virtual int getNr() const override { return level0_nr; }
    virtual int getNz() const override { return level0_nz; }
    virtual double getDr() const override { return dr_base; }
    virtual double getDz() const override { return dz_base; }
    virtual double getTime() const override { return time_val; }
    virtual void setTime(double t) override { time_val = t; }
    virtual double getGamma() const override { return gamma_val; }
    virtual FluxScheme getFluxScheme() const override { return flux_scheme_name == "Rusanov" ? RUSANOV : AUSM_PLUS; }
    virtual int getSpatialOrder() const override { return spatial_order_val; }
    virtual int getTemporalOrder() const override { return temporal_order_val; }
    virtual void setBCTypes(BCType r_min, BCType r_max, BCType z_min, BCType z_max) override;
    virtual void setCoordinateSystemCartesian(bool cartesian) override { is_cartesian = cartesian; }
    virtual void setDetonatorLocation(double r, double z) override { detonator_r_coord = r; detonator_z_coord = z; }

    virtual BCType getBCRmin() const override { return bc_r_min; }
    virtual BCType getBCRmax() const override { return bc_r_max; }
    virtual BCType getBCZmin() const override { return bc_z_min; }
    virtual BCType getBCZmax() const override { return bc_z_max; }
    virtual double getAmbientRho() const override { return ambient_rho_val; }
    virtual double getAmbientP() const override { return ambient_p_val; }
    virtual const MultiMat::MaterialSet& getMaterialParameters() const override { return materials_val; }
    virtual bool isIdealGas() const override { return is_ideal_gas_val; }

    virtual bool checkTerminationCondition() const override;

    virtual std::vector<State2D> getStates() const override;
    virtual std::vector<float> getTelemetry2D(int stride = 1) const override;
    virtual std::vector<float> getCellValues(int i, int j) const override;

    virtual void setGauges(const std::vector<Gauge2D>& gauges) override;
    virtual void recordGaugesAsync(double t) override;
    virtual void retrieveNewGaugeSamples(std::vector<double>& times, std::vector<float>& values) override;

    virtual void setSolidVelocities(const double* v) override;
    virtual void setSolidMask(const uint8_t* mask) override;

    virtual void exportVTK(const std::string& filename) const override;

private:
    std::vector<Gauge2D> cpu_gauges;
    std::vector<double> cpu_gauge_times;
    std::vector<float> cpu_gauge_values;
};

#endif // CFD_SOLVER_2D_AMR_HPP
