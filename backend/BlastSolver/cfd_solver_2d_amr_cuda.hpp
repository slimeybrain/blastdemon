#ifndef CFD_SOLVER_2D_AMR_CUDA_HPP
#define CFD_SOLVER_2D_AMR_CUDA_HPP

#include "cfd_solver_2d_cuda.hpp"
#include "cfd_solver_2d_amr.hpp"
#include <vector>
#include <string>
#include <memory>

struct GPUNode2D {
    int tile_id;
    int level;
    int neighbors[4];
    int children[4];
    double r_min;
    double z_min;
    int r_idx;
    int z_idx;
};

template <typename RealType>
class CFDSolver2DAMRCudaImpl : public CFDSolver2DCuda {
private:
    // Mirror of the CPU AMR solver configuration and tree
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

    std::string flux_scheme_name;
    int spatial_order_val;
    int temporal_order_val;

    CFDSolver2DCuda::BCType bc_r_min;
    CFDSolver2DCuda::BCType bc_r_max;
    CFDSolver2DCuda::BCType bc_z_min;
    CFDSolver2DCuda::BCType bc_z_max;

    double ambient_rho_val;
    double ambient_p_val;

    MultiMat::MaterialSet materials_val;
    double detonator_r_coord;
    double detonator_z_coord;

    // CPU-side copy of the tree and pools
    std::vector<AMRTileNode> amr_nodes;
    std::vector<AMRPrimitiveTileT<RealType>> states_pool;
    std::vector<AMRConservativeTileT<RealType>> U_pool;
    std::vector<AMRConservativeTileT<RealType>> dU_pool;
    std::vector<int> free_tile_ids;

    // GPU-side mirrors
    AMRPrimitiveTileT<RealType>* d_states_pool;
    AMRConservativeTileT<RealType>* d_U_pool;
    AMRConservativeTileT<RealType>* d_dU_pool;
    size_t allocated_tiles_capacity;

    // Active leaf node IDs list on GPU
    int* d_active_node_ids;
    int* d_active_tile_ids;
    int active_leaves_count;
    int* d_allocated_node_ids;
    int* d_allocated_tile_ids;
    int allocated_nodes_count;

    // GPU tree nodes representation for ghost-cell updates
    GPUNode2D* d_amr_nodes;

    int allocateTile();
    void freeTile(int tile_id);
    void rebuildNeighborPointers();
    int findNeighborNode(int node_idx, int dir);
    int findNodeByCoords(int r_idx, int z_idx, int level);

    void syncPoolsToGPU();
    void syncPoolsToCPU();
    void syncTreeToGPU();

    void fillGhostCellsGPU();
    void computeRHSGPU(double A_coeff, double dt);
    void applyLSRK3StepGPU(int stage, double dt);
    void updatePrimitiveGPU();

    void restrictAllCPU();
    void restrictNodeCPU(int node_idx);
    void adaptMeshCPU();
    bool shouldRefineNodeCPU(int node_idx);
    bool shouldCoarsenNodeCPU(int node_idx);
    void refineNodeCPU(int node_idx);
    void coarsenNodeCPU(int parent_idx);

    void applyInitialConditionToNode(int node_idx, double explosive_z, double explosive_radius, double high_rho, double detonation_energy, double ambient_rho, double ambient_p, bool is_tnt, bool is_cylinder = false, double charge_height = 0.0);

public:
    CFDSolver2DAMRCudaImpl(int nr, int nz, double max_r, double max_z, double gamma, int max_levels = 3, double threshold = 0.05, double coarsen_ratio = 0.2);
    ~CFDSolver2DAMRCudaImpl() override;

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
    void setSpatialOrder(int order) override;
    void setTemporalOrder(int order) override;
    void setMaterialParameters(const MultiMat::MaterialSet& materials) override;
    void setGamma(double g) override;
    void setIdealGas(bool val) override;

    void step(double dt) override;
    void run(double duration) override;

    int getNr() const override { return level0_nr; }
    int getNz() const override { return level0_nz; }
    double getDr() const override { return dr_base; }
    double getDz() const override { return dz_base; }
    double getTime() const override { return time_val; }
    void setTime(double t) override { time_val = t; }
    double getGamma() const override { return gamma_val; }
    FluxScheme getFluxScheme() const override { return flux_scheme_name == "Rusanov" ? RUSANOV : AUSM_PLUS; }
    int getSpatialOrder() const override { return spatial_order_val; }
    int getTemporalOrder() const override { return temporal_order_val; }

    void setBCTypes(BCType r_min, BCType r_max, BCType z_min, BCType z_max) override;
    void setDetonatorLocation(double r, double z) override { detonator_r_coord = r; detonator_z_coord = z; }

    std::vector<State2D> getStates() override;
    std::vector<float> getTelemetry2D(int stride = 1) override;
    std::vector<float> getCellValues(int i, int j) override;

    double getMaxWaveSpeed() override;
    bool checkTerminationCondition() override;
    bool isIdealGas() const override { return is_ideal_gas_val; }
    size_t getAllocatedVRAM() const override;
    double getAmbientP() const override { return ambient_p_val; }

    void exportVTK(const std::string& filename) override;
};

#endif // CFD_SOLVER_2D_AMR_CUDA_HPP
