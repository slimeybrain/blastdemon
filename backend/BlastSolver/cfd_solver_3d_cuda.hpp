#ifndef     CFD_SOLVER_3D_CUDA_HPP
#define     CFD_SOLVER_3D_CUDA_HPP

#include "cfd_solver_3d.hpp"
#include "grid_manager_3d.hpp"
#include <unordered_map>

struct GPUGauge3D {
    int t_idx;
    int c_idx;
    int submesh_idx; // -1 if not in submesh, otherwise submesh index in gpu_submeshes
    int sm_idx;      // flat linear index inside the submesh
};

template <typename RealType>
struct GPUSubMeshDevicePointer3D {
    RealType* rho;
    RealType* ux;
    RealType* uy;
    RealType* uz;
    RealType* p;
    RealType* E;
    RealType* alpha1;
    RealType* alpha2;
};

template <typename RealType>
struct GPUSubMeshBuffer3D {
    std::string id;
    std::string parent_id = "root";
    int parent_idx = -1;
    int level = 0;
    int nx = 0, ny = 0, nz = 0;
    RealType xmin = 0, xmax = 0;
    RealType ymin = 0, ymax = 0;
    RealType zmin = 0, zmax = 0;
    RealType cellSize = 0;

    RealType* d_rho = nullptr;
    RealType* d_ux = nullptr;
    RealType* d_uy = nullptr;
    RealType* d_uz = nullptr;
    RealType* d_p = nullptr;
    RealType* d_E = nullptr;

    RealType* d_new_rho = nullptr;
    RealType* d_new_ux = nullptr;
    RealType* d_new_uy = nullptr;
    RealType* d_new_uz = nullptr;
    RealType* d_new_p = nullptr;
    RealType* d_new_E = nullptr;

    RealType* d_alpha1 = nullptr;
    RealType* d_alpha2 = nullptr;
    RealType* d_arho1 = nullptr;
    RealType* d_arho2 = nullptr;

    RealType* d_new_alpha1 = nullptr;
    RealType* d_new_alpha2 = nullptr;
    RealType* d_new_arho1 = nullptr;
    RealType* d_new_arho2 = nullptr;

    RealType* d_rk_rho = nullptr;
    RealType* d_rk_ux = nullptr;
    RealType* d_rk_uy = nullptr;
    RealType* d_rk_uz = nullptr;
    RealType* d_rk_p = nullptr;
    RealType* d_rk_E = nullptr;

    RealType* d_rk_alpha1 = nullptr;
    RealType* d_rk_alpha2 = nullptr;
    RealType* d_rk_arho1 = nullptr;
    RealType* d_rk_arho2 = nullptr;

    RealType* d_rho_old = nullptr;
    RealType* d_ux_old = nullptr;
    RealType* d_uy_old = nullptr;
    RealType* d_uz_old = nullptr;
    RealType* d_p_old = nullptr;
    RealType* d_E_old = nullptr;

    RealType* d_alpha1_old = nullptr;
    RealType* d_alpha2_old = nullptr;
    RealType* d_arho1_old = nullptr;
    RealType* d_arho2_old = nullptr;

    RealType* d_peak_overpressure = nullptr;
    RealType* d_peak_impulse = nullptr;

    uint8_t* d_is_boundary = nullptr;

    bool is_allocated = false;
};

template <typename RealType, bool IsMultiMaterial>
class CFDSolver3DCuda : public CFDSolver3DImplBase {
    // GPU pointers and internal state
    mutable void* d_states = nullptr;
    mutable void* d_states_old = nullptr;
    mutable void* d_U = nullptr;
    mutable void* d_dU = nullptr;
    mutable void* d_geom = nullptr;
    mutable void* d_active_tiles = nullptr;
    mutable void* d_max_s_buf = nullptr;
    mutable void* d_slice_buf = nullptr;
    mutable size_t d_slice_buf_capacity = 0;
    mutable void* d_tile_active_temp = nullptr;
    mutable void* d_active_tile_indices = nullptr;  // int* compact index buffer
    mutable void* d_active_count = nullptr;          // int* device counter
    mutable int h_num_active_tiles = 0;              // host-side cached count
    mutable void* d_tile_mass = nullptr;
    mutable void* d_tile_energy = nullptr;
    mutable void* d_tile_is_near_boundary = nullptr;

    // GPU-side submesh device buffers
    mutable std::vector<GPUSubMeshBuffer3D<RealType>> gpu_submeshes;
    void allocateGPUSubMeshes() const;
    void freeGPUSubMeshes() const;
    void syncSubMeshesToGPU() const;
    void syncSubMeshesToHost() const;
    void bind_constants() const;

    // GPU-side gauge variables
    int num_gauges = 0;
    mutable void* d_gauge_coords = nullptr;
    mutable void* d_gauge_results = nullptr;
    mutable void* d_submesh_buffers_gauge = nullptr;
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
    uint8_t* temp_h_active = nullptr;

    mutable int last_cached_tile_idx = -1;
    mutable PrimitiveTile3D<RealType, IsMultiMaterial> cached_tile;

    mutable bool is_paged_out = false;
    mutable std::vector<PrimitiveTile3D<RealType, IsMultiMaterial>> paged_states;
    mutable std::vector<ConservativeTile3D<RealType, IsMultiMaterial>> paged_U;
    mutable std::vector<ConservativeTile3D<RealType, IsMultiMaterial>> paged_dU;
    mutable bool has_paged_dU = false;
    mutable std::vector<GeometryTile3D> paged_geom;
    mutable bool has_paged_geom = false;
    mutable std::vector<uint8_t> paged_active_tiles;
    mutable std::vector<uint8_t> paged_tile_active_temp;
    mutable std::vector<uint8_t> paged_tile_is_near_boundary;
    mutable bool has_paged_tile_is_near_boundary = false;
    mutable std::vector<GPUGauge3D> paged_gauge_coords;
    mutable bool has_paged_gauges = false;

    std::unique_ptr<GridManager3D<RealType, IsMultiMaterial>> grid_manager;
    std::vector<ObstacleFace> obstacle_faces;

public:
    void addSubMesh(const SubMeshParams3D& submesh) override;
    std::vector<PrimitiveTile3D<RealType, IsMultiMaterial>> temp_h_tiles;
    std::vector<PrimitiveTile3D<RealType, IsMultiMaterial>*>* temp_h_tiles_ptr = nullptr;

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
    double computeStepSize(double cfl = 0.4) const override;
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
    void appendSubMeshObstacleFaces(std::vector<ObstacleFace>& faces) override;
    std::pair<double, double> getConservationTotals() const override;

    std::vector<float> sampleGauge(const Gauge3D& gauge) const override;
    std::vector<float> extractSlice(const Slice3D& slice) const override;
    std::vector<SlicePayload3D> extractAllSlices(const Slice3D& slice) const override;
    void getSliceDimensions(const Slice3D& slice, int& w, int& h, int& depth) const override;
    using CFDSolver3D::getSliceDimensions;
    std::vector<float> getCellValues(int i, int j, int k) const override;

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
};

#endif
