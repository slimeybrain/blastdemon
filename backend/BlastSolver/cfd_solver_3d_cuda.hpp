#ifndef CFD_SOLVER_3D_CUDA_HPP
#define CFD_SOLVER_3D_CUDA_HPP

#include "cfd_solver_3d.hpp"
#include <unordered_map>

struct GPUGauge3D {
    int t_idx;
    int c_idx;
};

template <typename RealType, bool IsMultiMaterial>
class CFDSolver3DCuda : public CFDSolver3DImplBase {
    // GPU pointers and internal state
    mutable void* d_states = nullptr;

    mutable void* d_U = nullptr;
    mutable void* d_geom = nullptr;
    mutable void* d_states_pred = nullptr;
    mutable void* d_dW_dt = nullptr;
    mutable void* d_active_tiles = nullptr;
    mutable void* d_max_s_buf = nullptr;
    mutable void* d_slice_buf = nullptr;
    mutable size_t d_slice_buf_capacity = 0;
    mutable void* d_tile_active_temp = nullptr;
    mutable void* d_active_tile_indices = nullptr;  // int* compact index buffer
    mutable void* d_active_count = nullptr;          // int* device counter
    mutable int h_num_active_tiles = 0;              // host-side cached count
public:
    int getNumActiveTiles() const { return h_num_active_tiles; }
private:
    mutable void* d_tile_mass = nullptr;
    mutable void* d_tile_energy = nullptr;
    GeometryTile3D* d_static_geom = nullptr;
    mutable void* d_tile_is_near_boundary = nullptr;
    mutable void* d_solid_mask_fsi = nullptr;
    mutable size_t d_solid_mask_fsi_capacity = 0;
    mutable SolidVelocityTile3D* d_solid_vel_fsi = nullptr;
    mutable size_t d_solid_vel_fsi_capacity = 0;
    mutable void* d_tile_has_boundary_buf = nullptr;
    mutable size_t d_tile_has_boundary_capacity = 0;
    mutable UncoveringMaskTile3D* d_prev_mask = nullptr;
    mutable bool has_prev_mask = false;
    mutable bool constants_dirty = true;
    mutable int step_count = 0;

    void bind_constants() const;

    // GPU-side gauge variables
    int num_gauges = 0;
    mutable void* d_gauge_coords = nullptr;
    mutable void* d_gauge_results = nullptr;
    void* gauge_stream = nullptr;
    void* step_done = nullptr;
    int num_obstacle_faces = 0;
    mutable void* d_obstacle_faces = nullptr;
    mutable bool has_paged_obstacle_faces = false;
    mutable std::vector<GPUObstacleFace> paged_obstacle_faces;

    // Host pinned circular buffer
    float* host_pinned_gauge_data = nullptr;
    int host_pinned_capacity = 4096;
    int write_idx = 0;
    std::vector<double> host_pinned_times;

    // Buffered history for retrieval
    std::vector<double> buffered_times;
    std::vector<float> buffered_values;

    // Host temporary mirrors during remapping
    PrimitiveTile3D<RealType, IsMultiMaterial>* temp_h_states = nullptr;
    std::vector<PrimitiveTile3D<RealType, IsMultiMaterial>*>* temp_h_tiles_ptr = nullptr;
    uint8_t* temp_h_active = nullptr;

    mutable int last_cached_tile_idx = -1;
    mutable PrimitiveTile3D<RealType, IsMultiMaterial> cached_tile;

    mutable bool is_paged_out = false;
    mutable std::vector<PrimitiveTile3D<RealType, IsMultiMaterial>> paged_states;
    mutable std::vector<ConservativeTile3D<RealType, IsMultiMaterial>> paged_U;
    mutable std::vector<GeometryTile3D> paged_geom;
    mutable bool has_paged_geom = false;
    mutable std::vector<uint8_t> paged_active_tiles;
    mutable std::vector<uint8_t> paged_tile_active_temp;
    mutable std::vector<uint8_t> paged_tile_is_near_boundary;
    mutable bool has_paged_tile_is_near_boundary = false;
    mutable std::vector<GPUGauge3D> paged_gauge_coords;
    mutable bool has_paged_gauges = false;

    mutable bool has_paged_prev_mask = false;
    mutable std::vector<UncoveringMaskTile3D> paged_prev_mask;
    mutable bool has_paged_solid_mask = false;
    mutable std::vector<uint8_t> paged_solid_mask;
    mutable bool has_paged_solid_vel = false;
    mutable std::vector<SolidVelocityTile3D> paged_solid_vel;
    mutable bool has_paged_tile_boundary = false;
    mutable std::vector<uint8_t> paged_tile_boundary;

    std::vector<ObstacleFace> obstacle_faces;
    void* d_fsi_mpm_grid = nullptr;

private:
    void updateActiveRegions();
    void rebuildActiveIndex();
    void ensure_paged_in() const;
    void ensure_paged_out() const;
    void loadGeometryToGPU(const std::vector<GeometryTile3D>& host_geom, const std::atomic<bool>* terminate_flag);

public:
    bool isMultiMaterial() const override { return IsMultiMaterial; }
    void updateBoundaryConditions();
    CFDSolver3DCuda(int nx, int ny, int nz, double cellSize, double xmin = 0, double ymin = 0, double zmin = 0);
    ~CFDSolver3DCuda();

    void setInitialCondition(const Charge3DParams& charge, const MultiMat::MaterialSet& materials, double ambient_rho, double ambient_p) override;
    void setDetonatorLocation(double x, double y, double z) override;
    void setFluxScheme(const std::string& scheme_name) override;
    void setSpatialOrder(int order) override;
    void setTemporalOrder(int order) override;
    void setBoundaryConditions(BCType3D xmin, BCType3D xmax, BCType3D ymin, BCType3D ymax, BCType3D zmin, BCType3D zmax) override;

    void pause() override;
    void resume() override;

    void step(double dt) override;
    double computeStepSize(double cfl = 0.6) const override;
    void setGeometry(const std::string& stl_filepath, const std::string& geometry_hash, const std::string& voxelization_method,
                     const std::atomic<bool>* terminate_flag = nullptr,
                     std::function<void(double)> progress_callback = nullptr) override;
    void setGeometryTriangles(const std::vector<Triangle>& triangles, const std::string& geometry_hash, const std::string& voxelization_method,
                              const std::atomic<bool>* terminate_flag = nullptr,
                              std::function<void(double)> progress_callback = nullptr) override;
    void setGeometryPrimitives(const nlohmann::json& primitives, const std::string& geometry_hash, const std::string& voxelization_method,
                               const std::atomic<bool>* terminate_flag = nullptr,
                               std::function<void(double)> progress_callback = nullptr) override;
    void uploadObstacleFaces(const std::vector<ObstacleFace>& faces) override;
    void setSolidMask(const uint8_t* mask) override;
    void setSolidVelocities(const double* v) override;
    std::pair<double, double> getConservationTotals() const override;

    std::vector<float> sampleGauge(const Gauge3D& gauge) const override;
    std::vector<float> extractSlice(const Slice3D& slice) const override;
    std::vector<SlicePayload3D> extractAllSlices(const Slice3D& slice) const override;
    void getSliceDimensions(const Slice3D& slice, int& w, int& h, int& depth) const override;
    using CFDSolver3D::getSliceDimensions;
    std::vector<float> getCellValues(int i, int j, int k) const override;
    bool getFluidVelocity(int i, int j, int k, float& u, float& v, float& w, float& rho, float& p) const override;
    std::vector<float> extractPressureField() const override;
    void coupleFSIWithMPMGPU(void* mpm_solver_cuda) override;
    void coupleFSIWithFEMGPU(void* fem_solver_cuda) override;
    void invalidateTileCache() const override { last_cached_tile_idx = -1; }

    void setGauges(const std::vector<Gauge3D>& gauges) override;
    void recordGaugesAsync(double t) override;
    void retrieveNewGaugeSamples(std::vector<double>& times, std::vector<float>& values) override;

    void initializeFrom1D(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d, double x_expl, double y_expl, double z_expl, double R_remap) override;
    void initializeFrom2D(int nr, int nz, double dr, double dz, const std::vector<State2D>& states_2d, double x_expl, double y_expl, double z_expl, double R_remap, double source_explosive_z = 0.0) override;

    void setCellStateMulti(int i, int j, int k, const CellState3D<true>& s) override;
    void setCellStateIdeal(int i, int j, int k, const CellState3D<false>& s) override;
    void commitStates() override;
    size_t getAllocatedVRAM() const override;

    const void* getDeviceStates() const { return d_states; }
    const void* getDeviceU() const { return d_U; }
    const void* getDeviceActiveTiles() const { return d_active_tiles; }
    void* getDeviceGeom() const { return d_geom; }
    bool isCUDA() const override { return true; }
};

#endif
