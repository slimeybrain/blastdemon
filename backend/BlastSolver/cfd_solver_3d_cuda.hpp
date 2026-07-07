#ifndef     CFD_SOLVER_3D_CUDA_HPP
#define     CFD_SOLVER_3D_CUDA_HPP

#include "cfd_solver_3d.hpp"

class CFDSolver3DCuda : public CFDSolver3DImplBase {
    // GPU pointers and internal state
    void* d_states = nullptr;
    void* d_U = nullptr;
    void* d_active_tiles = nullptr;
    void* d_max_s_buf = nullptr;
    void* d_slice_buf = nullptr;

public:
    void updateBoundaryConditions();
    CFDSolver3DCuda(int nx, int ny, int nz, double cellSize, double xmin = 0, double ymin = 0, double zmin = 0);
    ~CFDSolver3DCuda();

    void setInitialCondition(const Charge3DParams& charge, const MultiMat::MaterialSet& materials, double ambient_rho, double ambient_p) override;
    void setDetonatorLocation(double x, double y, double z) override;
    void setFluxScheme(const std::string& scheme_name) override;
    void setSpatialOrder(int order) override;
    void setTemporalOrder(int order) override;

    void step(double dt) override;
    double computeStepSize(double cfl = 0.4) const override;

    std::vector<float> sampleGauge(const Gauge3D& gauge) const override;
    std::vector<float> extractSlice(const Slice3D& slice) const override;

    void initializeFrom1D(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d, double x_expl, double y_expl, double z_expl, double R_remap) override;

    void setCellStateMulti(int i, int j, int k, const CellState3D<true>& s) override;
    void setCellStateIdeal(int i, int j, int k, const CellState3D<false>& s) override;
    void commitStates() override;
};

#endif
