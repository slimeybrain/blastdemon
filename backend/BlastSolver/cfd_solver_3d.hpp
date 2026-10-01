#ifndef CFD_SOLVER_3D_HPP
#define CFD_SOLVER_3D_HPP

#include <vector>
#include <functional>
#include <string>
#include <atomic>
#include <memory>
#include "materials.hpp"
#include "cfd_states.hpp"
#include "cfd_tile.hpp"
#include "PrimitiveGeometry.hpp"
enum class BCType3D {
    REFLECTIVE = 0,
    TRANSMISSIVE = 1,
    OUTFLOW_RIEMANN = 2
};

struct Charge3DParams {
    int shape_type; // 0=Sphere, 1=Block, 2=Cylinder
    double x, y, z;
    double radius;
    double height;
    double lx, ly, lz;
    double rot_x = 0.0, rot_y = 0.0, rot_z = 0.0;
};

struct Gauge3D {
    std::string name;
    double x, y, z;
};

struct Slice3D {
    std::string axis; // "xy", "yz", "xz"
    double offset;
    std::vector<std::string> quantities;
    int stride = 1;
    bool enabled = true;

    // ROI sub-volume bounds
    bool roi_enabled = false;
    int roi_i_start = 0, roi_i_end = 0;
    int roi_j_start = 0, roi_j_end = 0;
    int roi_k_start = 0, roi_k_end = 0;
};

struct SlicePayload3D {
    std::string axis;
    double offset;
    int stride;
    std::vector<float> data;
    int w = 0;
    int h = 0;
    double xmin = 0.0, xmax = 0.0;
    double ymin = 0.0, ymax = 0.0;
    double zmin = 0.0, zmax = 0.0;
    int level = 0;
};


struct ObstacleFace {
    int gx_fluid, gy_fluid, gz_fluid;
    float px[4], py[4], pz[4];
};

struct GPUObstacleFace {
    int t_idx;
    int c_idx;
};

template <bool IsMultiMaterial>
struct CellState3D {
    Real rho, ux, uy, uz, p, E, alpha1, alpha2, arho1, arho2;
    Real peak_overpressure, peak_impulse;
};

template <bool IsMultiMaterial>
inline double getPressure3D(double E_internal, double rho, const CellState3D<IsMultiMaterial>& s, double gamma, const MultiMat::JWLParams& products, const MultiMat::JWLParams& unreacted, bool is_water = false, const Blast::TaitEOSParams* tait = nullptr) {
    if (is_water && tait) {
        if (tait->variant == Blast::TaitVariant::CaloricGruneisen) {
            double e = E_internal / std::max(1e-6, rho);
            return Blast::TaitEOSWater::compute_pressure_caloric(rho, e, tait->B, tait->gamma, tait->rho0, tait->gruneisen, tait->p_cav, tait->p0);
        } else if (tait->variant == Blast::TaitVariant::ShockHugoniot) {
            double e = E_internal / std::max(1e-6, rho);
            return Blast::TaitEOSWater::compute_pressure_hugoniot(rho, e, tait->c0, tait->s_hugoniot, tait->rho0, tait->gruneisen, tait->p_cav);
        } else {
            return Blast::TaitEOSWater::compute_pressure_isentropic(rho, tait->B, tait->gamma, tait->rho0, tait->p_cav, tait->p0);
        }
    }
    if constexpr (IsMultiMaterial) {
        return MultiMat::getMixturePressure(E_internal, rho, s.alpha1, s.alpha2, s.arho1, s.arho2, gamma, products, unreacted);
    } else {
        return E_internal * (gamma - 1.0);
    }
}

template <bool IsMultiMaterial>
inline double getSoundSpeed3D(double p, double rho, const CellState3D<IsMultiMaterial>& s, double gamma, const MultiMat::JWLParams& products, const MultiMat::JWLParams& unreacted, bool is_water = false, const Blast::TaitEOSParams* tait = nullptr) {
    if (is_water && tait) {
        double e = (tait->variant == Blast::TaitVariant::CaloricGruneisen || tait->variant == Blast::TaitVariant::ShockHugoniot)
                 ? (MultiMat::getEnergy_Tait<double>(p, rho, tait->B, tait->gamma, tait->rho0, tait->gruneisen, true))
                 : 0.0;
        return Blast::TaitEOSWater::compute_sound_speed_unified(rho, p, e, tait->variant, tait->B, tait->gamma, tait->rho0, tait->c0, tait->gruneisen, tait->s_hugoniot);
    }
    if constexpr (IsMultiMaterial) {
        return MultiMat::getMixtureSoundSpeed(p, rho, s.alpha1, s.alpha2, s.arho1, s.arho2, gamma, products, unreacted);
    } else {
        return std::sqrt(gamma * p / std::max(1e-6, rho));
    }
}

template <bool IsMultiMaterial>
inline double getEnergy3D(double p, double rho, const CellState3D<IsMultiMaterial>& s, double gamma, const MultiMat::JWLParams& products, const MultiMat::JWLParams& unreacted, bool is_water = false, const Blast::TaitEOSParams* tait = nullptr) {
    if (is_water && tait) {
        bool is_cal = (tait->variant == Blast::TaitVariant::CaloricGruneisen || tait->variant == Blast::TaitVariant::ShockHugoniot);
        return rho * MultiMat::getEnergy_Tait<double>(p, rho, tait->B, tait->gamma, tait->rho0, tait->gruneisen, is_cal);
    }
    if constexpr (IsMultiMaterial) {
        return MultiMat::getMixtureEnergy(p, rho, s.alpha1, s.alpha2, s.arho1, s.arho2, gamma, products, unreacted);
    } else {
        return p / (gamma - 1.0);
    }
}

struct CFDBulkSnapshot3D {
    int nx = 0, ny = 0, nz = 0;
    double cellSize = 0.0;
    double xmin = 0.0, ymin = 0.0, zmin = 0.0;
    bool has_vel = false;
    bool has_E = false;
    bool has_species = false;
    // Flat dense fields of size nx * ny * nz
    std::vector<float> p;
    std::vector<float> rho;
    std::vector<float> overpressure;
    std::vector<float> impulse;
    std::vector<float> solid;
    std::vector<float> vel;
    std::vector<float> E;
    std::vector<float> alpha1;
    std::vector<float> alpha2;
    std::vector<float> air;

    inline int index(int gx, int gy, int gz) const {
        return gx + gy * nx + gz * nx * ny;
    }
};

class CFDSolver3D {
public:
    virtual ~CFDSolver3D() = default;

    virtual void setInitialCondition(const Charge3DParams& charge, const MultiMat::MaterialSet& materials, double ambient_rho, double ambient_p) = 0;
    virtual void setStratifiedInitialCondition(const Charge3DParams& charge, const MultiMat::MaterialSet& materials, const Blast::Stratified3DParams& strat) {
        setInitialCondition(charge, materials, strat.air_rho, strat.p_atm);
    }
    virtual void setAcousticWavePacket(double /*x0*/, double /*sigma*/, double /*delta_p*/, double /*ambient_rho*/, double /*ambient_p*/) {}
    virtual void setGravity(double /*gx*/, double /*gy*/, double /*gz*/) {}
    virtual void setDetonatorLocation(double x, double y, double z) = 0;
    virtual void setBoundaryConditions(BCType3D xmin, BCType3D xmax, BCType3D ymin, BCType3D ymax, BCType3D zmin, BCType3D zmax) = 0;
    virtual void setFluxScheme(const std::string& scheme_name) = 0;
    virtual void setSpatialOrder(int order) = 0;
    virtual void setTemporalOrder(int order) = 0;
    virtual void setCancelFlag(std::atomic<bool>* flag) = 0;
    virtual void setProgressRef(std::atomic<int>* ref) = 0;

    virtual void step(double dt) = 0;
    virtual double computeStepSize(double cfl = 0.6) const = 0;
    virtual void pause() {}
    virtual void resume() {}
    virtual bool is_terminated() const = 0;
    virtual double getGamma() const = 0;

    virtual double getTime() const = 0;
    virtual int getNx() const = 0;
    virtual int getNy() const = 0;
    virtual int getNz() const = 0;
    virtual double getXMin() const = 0;
    virtual double getYMin() const = 0;
    virtual double getZMin() const = 0;
    virtual double getCellSize() const = 0;
    virtual double getDx() const { return getCellSize(); }
    virtual double getDy() const { return getCellSize(); }
    virtual double getDz() const { return getCellSize(); }

    virtual std::vector<float> sampleGauge(const Gauge3D& gauge) const = 0;
    virtual std::vector<float> extractSlice(const Slice3D& slice) const = 0;
    virtual std::vector<SlicePayload3D> extractAllSlices(const Slice3D& slice) const = 0;
    virtual void sampleSurfacePoints(
        const std::vector<Point3D>& points,
        const std::vector<std::string>& quantities,
        double dom_xmin, double dom_xmax,
        double dom_ymin, double dom_ymax,
        double dom_zmin, double dom_zmax,
        float outside_val,
        std::vector<std::vector<float>>& out_quantities
    ) const = 0;
    virtual void captureBulkSnapshot(CFDBulkSnapshot3D& /*out_snap*/, bool /*need_vel*/ = false, bool /*need_E*/ = false, bool /*need_species*/ = false) const {}
    virtual void getSliceDimensions(const Slice3D& slice, int& w, int& h, int& depth) const {
        int stride = slice.stride > 0 ? slice.stride : 1;
        depth = 1;
        if (slice.axis == "xy" || slice.axis == "obstacles") {
            w = (getNx() + stride - 1) / stride;
            h = (getNy() + stride - 1) / stride;
        } else if (slice.axis == "xz") {
            w = (getNx() + stride - 1) / stride;
            h = (getNz() + stride - 1) / stride;
        } else if (slice.axis == "yz") {
            w = (getNy() + stride - 1) / stride;
            h = (getNz() + stride - 1) / stride;
        } else if (slice.axis == "volume") {
            if (slice.roi_enabled) {
                w = (slice.roi_i_end - slice.roi_i_start + stride - 1) / stride;
                h = (slice.roi_j_end - slice.roi_j_start + stride - 1) / stride;
                depth = (slice.roi_k_end - slice.roi_k_start + stride - 1) / stride;
            } else {
                w = (getNx() + stride - 1) / stride;
                h = (getNy() + stride - 1) / stride;
                depth = (getNz() + stride - 1) / stride;
            }
        } else {
            w = 0; h = 0; depth = 0;
        }
    }
    virtual void getSliceDimensions(const Slice3D& slice, int& w, int& h) const {
        int d = 1;
        getSliceDimensions(slice, w, h, d);
    }
    virtual std::vector<float> getCellValues(int i, int j, int k) const = 0;
    virtual bool getFluidVelocity(int i, int j, int k, float& u, float& v, float& w, float& rho, float& p) const {
        auto vals = getCellValues(i, j, k);
        if (vals.size() < 2) return false;
        p = vals[0];
        rho = vals[1];
        u = 0.0f; v = 0.0f; w = 0.0f;
        return true;
    }
    // Bulk pressure extraction for FSI coupling — one cudaMemcpy for the whole field, not per-cell
    virtual std::vector<float> extractPressureField() const { return {}; }
    virtual void coupleFSIWithMPMGPU(void* /*mpm_solver_cuda*/) {}
    virtual void coupleFSIWithFEMGPU(void* /*fem_solver_cuda*/) {}
    virtual void invalidateTileCache() const {}

    virtual void setGauges(const std::vector<Gauge3D>&) {}
    virtual void recordGaugesAsync(double) {}
    virtual void retrieveNewGaugeSamples(std::vector<double>&, std::vector<float>&) {}

    virtual void initializeFrom1D(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d, double x_expl, double y_expl, double z_expl, double R_remap) = 0;
    virtual void initializeFrom2D(int nr, int nz, double dr, double dz, const std::vector<State2D>& states_2d, double x_expl, double y_expl, double z_expl, double R_remap, double source_explosive_z = 0.0) = 0;

    virtual void setCellStateMulti(int i, int j, int k, const CellState3D<true>& s) = 0;
    virtual void setCellStateIdeal(int i, int j, int k, const CellState3D<false>& s) = 0;
    virtual void commitStates() = 0;

    virtual bool isIdealGas() const = 0;
    virtual bool isMultiMaterial() const = 0;
    virtual bool isCUDA() const { return false; }
    virtual void setGamma(double) {}
    virtual void setIdealGas(bool) {}
    virtual bool isWaterTait() const { return false; }
    virtual void setWaterTait(bool) {}
    virtual const Blast::TaitEOSParams& getTaitParams() const { static Blast::TaitEOSParams p; return p; }
    virtual void setTaitParams(const Blast::TaitEOSParams&) {}
    virtual void setMaterialParameters(const MultiMat::MaterialSet&) {}
    virtual const MultiMat::MaterialSet& getMaterialParameters() const = 0;
    virtual double getAmbientP() const = 0;
    virtual double getAmbientRho() const = 0;
    virtual void setAmbientState(double, double) {}
    virtual void setTime(double) {}
    virtual void setChargeRadius(double r) { charge_radius = r; }
    virtual double getChargeRadius() const { return charge_radius; }
    virtual size_t getAllocatedVRAM() const { return 0; }

protected:
    double charge_radius = 0.05;

public:
    virtual void setGeometry(const std::string& stl_filepath, const std::string& geometry_hash, const std::string& voxelization_method,
                             const std::atomic<bool>* terminate_flag = nullptr,
                             std::function<void(double)> progress_callback = nullptr) = 0;
    virtual void setGeometryTriangles(const std::vector<Triangle>& triangles, const std::string& geometry_hash, const std::string& voxelization_method,
                                      const std::atomic<bool>* terminate_flag = nullptr,
                                      std::function<void(double)> progress_callback = nullptr) = 0;
    virtual void setGeometryPrimitives(const nlohmann::json& primitives, const std::string& geometry_hash, const std::string& voxelization_method,
                                       const std::atomic<bool>* terminate_flag = nullptr,
                                       std::function<void(double)> progress_callback = nullptr) = 0;
    virtual void uploadObstacleFaces(const std::vector<ObstacleFace>&) {}
    virtual void setSolidMask(const uint8_t*) {}
    virtual void setSolidVelocities(const double*) {}
    virtual std::pair<double, double> getConservationTotals() const = 0;
};

class CFDSolver3DImplBase : public CFDSolver3D {
protected:
    int nx, ny, nz;
    double lx, ly, lz;
    double xmin, ymin, zmin;
    double detX = 0, detY = 0, detZ = 0;
    double cellSize;
    double currentTime = 0.0;
    double gamma = 1.4;
    double ambient_rho = 1.225;
    double ambient_p = 101325.0;
    bool is_ideal_gas_val = false;
    bool is_water_tait_val = false;
    Blast::TaitEOSParams tait_water_params;
    double gravity_x = 0.0;
    double gravity_y = 0.0;
    double gravity_z = 0.0;
    Blast::Stratified3DParams stratified_params;

    BCType3D bcXmin = BCType3D::REFLECTIVE;
    BCType3D bcXmax = BCType3D::TRANSMISSIVE;
    BCType3D bcYmin = BCType3D::REFLECTIVE;
    BCType3D bcYmax = BCType3D::TRANSMISSIVE;
    BCType3D bcZmin = BCType3D::REFLECTIVE;
    BCType3D bcZmax = BCType3D::TRANSMISSIVE;

    std::atomic<bool>* cancel_flag = nullptr;
    std::atomic<int>* progress_ref = nullptr;

    bool terminated = false;

    std::string currentFluxScheme = "Rusanov";
    int spatialOrder = 2;
    int temporalOrder = 2;
    MultiMat::MaterialSet currentMaterials = MultiMat::TNT;

public:
    bool isIdealGas() const override { return is_ideal_gas_val; }
    const MultiMat::MaterialSet& getMaterialParameters() const override { return currentMaterials; }
    double getAmbientP() const override { return ambient_p; }
    double getAmbientRho() const override { return ambient_rho; }
    void setAmbientState(double rho, double p) override {
        if (rho > 0.0) ambient_rho = rho;
        if (p > 0.0) ambient_p = p;
    }

    CFDSolver3DImplBase(int nx, int ny, int nz, double cellSize, double xmin = 0, double ymin = 0, double zmin = 0)
        : nx(nx), ny(ny), nz(nz), xmin(xmin), ymin(ymin), zmin(zmin), cellSize(cellSize) {
        lx = nx * cellSize;
        ly = ny * cellSize;
        lz = nz * cellSize;
    }

    void setBoundaryConditions(BCType3D xmin, BCType3D xmax, BCType3D ymin, BCType3D ymax, BCType3D zmin, BCType3D zmax) override {
        bcXmin = xmin; bcXmax = xmax;
        bcYmin = ymin; bcYmax = ymax;
        bcZmin = zmin; bcZmax = zmax;
    }

    void setGravity(double gx, double gy, double gz) override {
        gravity_x = gx;
        gravity_y = gy;
        gravity_z = gz;
    }

    void setCancelFlag(std::atomic<bool>* flag) override { cancel_flag = flag; }
    void setProgressRef(std::atomic<int>* ref) override { progress_ref = ref; }

    double getTime() const override { return currentTime; }
    int getNx() const override { return nx; }
    int getNy() const override { return ny; }
    int getNz() const override { return nz; }
    double getXMin() const { return xmin; }
    double getYMin() const { return ymin; }
    double getZMin() const { return zmin; }
    double getCellSize() const override { return cellSize; }
    double getDx() const override { return cellSize; }
    double getDy() const override { return cellSize; }
    double getDz() const override { return cellSize; }
    bool is_terminated() const override { return terminated; }
    double getGamma() const override { return gamma; }
    void setGamma(double g) override { gamma = g; }
    void setIdealGas(bool val) override { is_ideal_gas_val = val; }
    bool isWaterTait() const override { return is_water_tait_val; }
    void setWaterTait(bool val) override { is_water_tait_val = val; }
    const Blast::TaitEOSParams& getTaitParams() const override { return tait_water_params; }
    void setTaitParams(const Blast::TaitEOSParams& p) override {
        tait_water_params = p;
        is_water_tait_val = true;
    }
    void setMaterialParameters(const MultiMat::MaterialSet& materials) override { currentMaterials = materials; }
    void setTime(double t) override { currentTime = t; }
    void setGeometry(const std::string&, const std::string&, const std::string&,
                     const std::atomic<bool>* = nullptr,
                     std::function<void(double)> = nullptr) override {}
    void setGeometryTriangles(const std::vector<Triangle>&, const std::string&, const std::string&,
                              const std::atomic<bool>* = nullptr,
                              std::function<void(double)> = nullptr) override {}
    void setGeometryPrimitives(const nlohmann::json&, const std::string&, const std::string&,
                               const std::atomic<bool>* = nullptr,
                               std::function<void(double)> = nullptr) override {}
    std::pair<double, double> getConservationTotals() const override { return {0.0, 0.0}; }
};

template <typename RealType, bool IsMultiMaterial>
class CFDSolver3DImpl : public CFDSolver3DImplBase {
    std::vector<PrimitiveTile3D<RealType, IsMultiMaterial>> states_pool;
    std::vector<ConservativeTile3D<RealType, IsMultiMaterial>> U_pool;
    std::vector<PrimitiveTile3D<RealType, IsMultiMaterial>> states_pred;
    std::vector<PrimitivePredictorTile3D<RealType, IsMultiMaterial>> dW_dt_pool;
    std::vector<PrimitivePredictorTile3D<RealType, IsMultiMaterial>> states_int;
    std::vector<uint8_t> active_tiles;
    std::vector<int> active_tile_indices;
    std::vector<uint8_t> tile_is_fully_interior;
    std::vector<GeometryTile3D> geom_pool;
    std::vector<UncoveringMaskTile3D> prev_mask_pool;
    std::vector<ObstacleFace> obstacle_faces;
    std::vector<SolidVelocityTile3D> solid_vel_tiles;

    int n_tiles_x, n_tiles_y, n_tiles_z;

public:
    bool isMultiMaterial() const override { return IsMultiMaterial; }
    CFDSolver3DImpl(int nx, int ny, int nz, double cellSize, double xmin = 0, double ymin = 0, double zmin = 0);

    void setBoundaryConditions(BCType3D xmin, BCType3D xmax, BCType3D ymin, BCType3D ymax, BCType3D zmin, BCType3D zmax) override;

    void setInitialCondition(const Charge3DParams& charge, const MultiMat::MaterialSet& materials, double ambient_rho, double ambient_p) override;
    void setStratifiedInitialCondition(const Charge3DParams& charge, const MultiMat::MaterialSet& materials, const Blast::Stratified3DParams& strat) override;
    void setAcousticWavePacket(double x0, double sigma, double delta_p, double ambient_rho, double ambient_p) override;
    void setFluxScheme(const std::string& scheme_name) override;
    void setSpatialOrder(int order) override;
    void setTemporalOrder(int order) override;

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
    void setSolidVelocities(const double* v) override {
        if (!v) { solid_vel_tiles.clear(); return; }
        int total_tiles = n_tiles_x * n_tiles_y * n_tiles_z;
        solid_vel_tiles.resize(total_tiles);
        #pragma omp parallel for collapse(3) schedule(static)
        for (int k = 0; k < nz; ++k) {
            for (int j = 0; j < ny; ++j) {
                for (int i = 0; i < nx; ++i) {
                    int t_idx = (i >> 3) + (j >> 3) * n_tiles_x + (k >> 3) * n_tiles_x * n_tiles_y;
                    int c_idx = (i & 7) + (j & 7) * 8 + (k & 7) * 64;
                    size_t cfd_flat = static_cast<size_t>(i) + static_cast<size_t>(j) * nx + static_cast<size_t>(k) * nx * ny;
                    solid_vel_tiles[t_idx].vx[c_idx] = static_cast<float>(v[3 * cfd_flat + 0]);
                    solid_vel_tiles[t_idx].vy[c_idx] = static_cast<float>(v[3 * cfd_flat + 1]);
                    solid_vel_tiles[t_idx].vz[c_idx] = static_cast<float>(v[3 * cfd_flat + 2]);
                }
            }
        }
    }
    std::pair<double, double> getConservationTotals() const override;

    std::vector<float> sampleGauge(const Gauge3D& gauge) const override;
    std::vector<float> extractSlice(const Slice3D& slice) const override;
    std::vector<SlicePayload3D> extractAllSlices(const Slice3D& slice) const override;
    void sampleSurfacePoints(
        const std::vector<Point3D>& points,
        const std::vector<std::string>& quantities,
        double dom_xmin, double dom_xmax,
        double dom_ymin, double dom_ymax,
        double dom_zmin, double dom_zmax,
        float outside_val,
        std::vector<std::vector<float>>& out_quantities
    ) const override;
    void captureBulkSnapshot(CFDBulkSnapshot3D& out_snap, bool need_vel = false, bool need_E = false, bool need_species = false) const override;
    void getSliceDimensions(const Slice3D& slice, int& w, int& h, int& depth) const override;
    using CFDSolver3D::getSliceDimensions;
    std::vector<float> getCellValues(int i, int j, int k) const override;
    bool getFluidVelocity(int i, int j, int k, float& u, float& v, float& w, float& rho, float& p) const override {
        if (i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k >= nz || states_pool.empty()) return false;
        int t_idx = (i >> 3) + (j >> 3) * n_tiles_x + (k >> 3) * n_tiles_x * n_tiles_y;
        int c_idx = (i & 7) + (j & 7) * 8 + (k & 7) * 64;
        p = static_cast<float>(states_pool[t_idx].p[c_idx]);
        rho = static_cast<float>(states_pool[t_idx].rho[c_idx]);
        u = static_cast<float>(states_pool[t_idx].ux[c_idx]);
        v = static_cast<float>(states_pool[t_idx].uy[c_idx]);
        w = static_cast<float>(states_pool[t_idx].uz[c_idx]);
        return true;
    }
    std::vector<float> extractPressureField() const override {
        std::vector<float> pfield(static_cast<size_t>(nx) * ny * nz);
        for (int i = 0; i < nx; ++i) {
            for (int j = 0; j < ny; ++j) {
                for (int k = 0; k < nz; ++k) {
                    int t_idx = (i >> 3) + (j >> 3) * n_tiles_x + (k >> 3) * n_tiles_x * n_tiles_y;
                    int c_idx = (i & 7) + (j & 7) * 8 + (k & 7) * 64;
                    pfield[static_cast<size_t>(i) + static_cast<size_t>(j) * nx + static_cast<size_t>(k) * nx * ny] = static_cast<float>(states_pool[t_idx].p[c_idx]);
                }
            }
        }
        return pfield;
    }

    void setGauges(const std::vector<Gauge3D>& gauges) override;
    void recordGaugesAsync(double t) override;
    void retrieveNewGaugeSamples(std::vector<double>& times, std::vector<float>& values) override;

    void initializeFrom1D(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d, double x_expl, double y_expl, double z_expl, double R_remap) override;
    void initializeFrom2D(int nr, int nz, double dr, double dz, const std::vector<State2D>& states_2d, double x_expl, double y_expl, double z_expl, double R_remap, double source_explosive_z = 0.0) override;

    void setCellStateMulti(int i, int j, int k, const CellState3D<true>& s) override;
    void setCellStateIdeal(int i, int j, int k, const CellState3D<false>& s) override;
    void commitStates() override;
    void setDetonatorLocation(double x, double y, double z) override;
    
    const std::vector<PrimitiveTile3D<RealType, IsMultiMaterial>>& getStatesPool() const { return states_pool; }
    const std::vector<ConservativeTile3D<RealType, IsMultiMaterial>>& getUPool() const { return U_pool; }
    const std::vector<uint8_t>& getActiveTiles() const { return active_tiles; }
    std::vector<GeometryTile3D>& getGeomPool() { return geom_pool; }

private:
    std::vector<Gauge3D> cpu_gauges;
    std::vector<double> cpu_gauge_times;
    std::vector<float> cpu_gauge_values;

    void updateActiveRegions();
    void computeFluxes(double dt, std::vector<ConservativeTile3D<RealType, IsMultiMaterial>>& target_pool);
    void applyBC();
    void applyProgrammedBurn(double dt);
    void updatePrimitiveFromConservative();
    bool checkTermination();
public:
    template <typename RT, bool MM>
    struct CellState3DT {
        RT rho, ux, uy, uz, p, E, alpha1, alpha2, arho1, arho2;
        RT peak_overpressure, peak_impulse;
    };

    // Why this works:
    // By projecting the Image Point from the deep solid target, but restricting the IDW sampling strictly to the verified fluid neighborhood of the querying cell, we generate a perfectly continuous, anti-aliased gradient for the WENO3 stencil. This eliminates all lumps and carbuncles. Furthermore, this topology mathematically guarantees that the ray cannot pierce a 1-cell thick wall or sample the wrong side of an urban gap, providing indestructible geometric stability.
    // Specifying the reconstruction direction (dir) decouples normal reflection components at sharp convex corners, eliminating artificial stagnation artifacts.
    inline CellState3DT<RealType, IsMultiMaterial> sampleStateInternalIDW(
        int target_x, int target_y, int target_z,
        int qx, int qy, int qz,
        int dir
    ) const {
        bool is_target_solid = false;
        if (!geom_pool.empty()) {
            int clamped_x = std::clamp(target_x, 0, nx - 1);
            int clamped_y = std::clamp(target_y, 0, ny - 1);
            int clamped_z = std::clamp(target_z, 0, nz - 1);
            int t_idx = (clamped_x >> 3) + (clamped_y >> 3) * n_tiles_x + (clamped_z >> 3) * n_tiles_x * n_tiles_y;
            int c_idx = (clamped_x & 7) + (clamped_y & 7) * 8 + (clamped_z & 7) * 64;
            is_target_solid = geom_pool[t_idx].cells[c_idx].is_boundary;
        }
        if (!is_target_solid) {
            return sampleStateInternal(target_x, target_y, target_z);
        }

        int sign_x = (target_x > qx) - (target_x < qx);
        int sign_y = (target_y > qy) - (target_y < qy);
        int sign_z = (target_z > qz) - (target_z < qz);
        int bx = qx + sign_x;
        int by = qy + sign_y;
        int bz = qz + sign_z;

        float nx_b = 0.0f, ny_b = 0.0f, nz_b = 0.0f;
        if (bx >= 0 && bx < nx && by >= 0 && by < ny && bz >= 0 && bz < nz) {
            int t_idx = (bx >> 3) + (by >> 3) * n_tiles_x + (bz >> 3) * n_tiles_x * n_tiles_y;
            int c_idx = (bx & 7) + (by & 7) * 8 + (bz & 7) * 64;
            const auto& cell = geom_pool[t_idx].cells[c_idx];
            nx_b = cell.nx;
            ny_b = cell.ny;
            nz_b = cell.nz;
        }

        // Auto-Orient the True Normal first:
        float dx_f = (float)(qx - bx);
        float dy_f = (float)(qy - by);
        float dz_f = (float)(qz - bz);
        float dot_d = nx_b * dx_f + ny_b * dy_f + nz_b * dz_f;
        if (dot_d < 0.0f) {
            nx_b = -nx_b;
            ny_b = -ny_b;
            nz_b = -nz_b;
        }

        // Keep the true oriented normal for flat/diagonal walls:
        float nx_true = nx_b;
        float ny_true = ny_b;
        float nz_true = nz_b;
        float n_len_true = std::sqrt(nx_true*nx_true + ny_true*ny_true + nz_true*nz_true);
        if (n_len_true > 1e-3f) {
            nx_true /= n_len_true;
            ny_true /= n_len_true;
            nz_true /= n_len_true;
        } else {
            float dx_dir = (float)(qx - target_x);
            float dy_dir = (float)(qy - target_y);
            float dz_dir = (float)(qz - target_z);
            float len_dir = std::sqrt(dx_dir*dx_dir + dy_dir*dy_dir + dz_dir*dz_dir);
            if (len_dir > 1e-3f) {
                nx_true = dx_dir / len_dir;
                ny_true = dy_dir / len_dir;
                nz_true = dz_dir / len_dir;
            }
        }

        // Option B: Decouple boundary normal components at domain boundaries
        bool decoupled = false;
        if (bx == 0 || bx == nx - 1) { nx_true = 0.0f; decoupled = true; }
        if (by == 0 || by == ny - 1) { ny_true = 0.0f; decoupled = true; }
        if (bz == 0 || bz == nz - 1) { nz_true = 0.0f; decoupled = true; }
        if (decoupled) {
            float n_len_dec = std::sqrt(nx_true*nx_true + ny_true*ny_true + nz_true*nz_true);
            if (n_len_dec > 1e-3f) {
                nx_true /= n_len_dec;
                ny_true /= n_len_dec;
                nz_true /= n_len_dec;
            }
        }

        // Decouple normal for velocity reflection and corner clipping:
        float nx_dec = nx_true;
        float ny_dec = ny_true;
        float nz_dec = nz_true;
        if (dir == 0) {
            ny_dec = 0.0f;
            nz_dec = 0.0f;
        } else if (dir == 1) {
            nx_dec = 0.0f;
            nz_dec = 0.0f;
        } else if (dir == 2) {
            nx_dec = 0.0f;
            ny_dec = 0.0f;
        }
        float n_len_dec = std::sqrt(nx_dec*nx_dec + ny_dec*ny_dec + nz_dec*nz_dec);
        if (n_len_dec > 1e-3f) {
            nx_dec /= n_len_dec;
            ny_dec /= n_len_dec;
            nz_dec /= n_len_dec;
        } else {
            float sign_dir = 0.0f;
            if (dir == 0) sign_dir = (qx >= target_x) ? 1.0f : -1.0f;
            else if (dir == 1) sign_dir = (qy >= target_y) ? 1.0f : -1.0f;
            else if (dir == 2) sign_dir = (qz >= target_z) ? 1.0f : -1.0f;
            nx_dec = (dir == 0) ? sign_dir : 0.0f;
            ny_dec = (dir == 1) ? sign_dir : 0.0f;
            nz_dec = (dir == 2) ? sign_dir : 0.0f;
        }

        // Topological Corner Detection (Thin-Shell & Coplanar Invariant):
        // Count solid cells and coplanar neighbors in 3x3x3 neighborhood of boundary cell bx, by, bz
        int solid_count = 0;
        int coplanar_count = 0;
        for (int sz = -1; sz <= 1; ++sz) {
            int nz_val = bz + sz;
            for (int sy = -1; sy <= 1; ++sy) {
                int ny_val = by + sy;
                for (int sx = -1; sx <= 1; ++sx) {
                    if (sx == 0 && sy == 0 && sz == 0) continue;
                    int nx_val = bx + sx;
                    bool is_solid = false;
                    if (nx_val >= 0 && nx_val < nx && ny_val >= 0 && ny_val < ny && nz_val >= 0 && nz_val < nz) {
                        int t_idx = (nx_val >> 3) + (ny_val >> 3) * n_tiles_x + (nz_val >> 3) * n_tiles_x * n_tiles_y;
                        int c_idx = (nx_val & 7) + (ny_val & 7) * 8 + (nz_val & 7) * 64;
                        if (geom_pool[t_idx].cells[c_idx].is_boundary) {
                            is_solid = true;
                        }
                    } else {
                        is_solid = true; // boundary conditions treat out of bounds as solid
                    }
                    if (is_solid) {
                        solid_count++;
                        float dot_n = (float)sx * nx_true + (float)sy * ny_true + (float)sz * nz_true;
                        if (std::fabs(dot_n) <= 0.707f) {
                            coplanar_count++;
                        }
                    }
                }
            }
        }
        bool is_convex_corner;
        if (solid_count <= 10) {
            // Thin-shell regime: flat 3x3 sheet has ~8 coplanar solid neighbors. A true corner/tip has < 4.
            is_convex_corner = (coplanar_count < 4);
        } else {
            // Volumetric solid regime:
            is_convex_corner = (solid_count <= 14);
        }

        // Adaptive normal selection:
        // Use true normal for flat/diagonal walls (smooth anti-aliased slip)
        // Use decoupled normal for convex corners/edges (prevents multi-dimensional stagnation pressure bleeding)
        float nx_reflect = is_convex_corner ? nx_dec : nx_true;
        float ny_reflect = is_convex_corner ? ny_dec : ny_true;
        float nz_reflect = is_convex_corner ? nz_dec : nz_true;

        // Gap-adaptive projection distance:
        float d_clearance = 1.5f;
        for (int step = 1; step <= 2; ++step) {
            int step_x = qx + (int)std::round(nx_reflect * (float)step);
            int step_y = qy + (int)std::round(ny_reflect * (float)step);
            int step_z = qz + (int)std::round(nz_reflect * (float)step);
            if (step_x >= 0 && step_x < nx && step_y >= 0 && step_y < ny && step_z >= 0 && step_z < nz) {
                int t_s = (step_x >> 3) + (step_y >> 3) * n_tiles_x + (step_z >> 3) * n_tiles_x * n_tiles_y;
                int c_s = (step_x & 7) + (step_y & 7) * 8 + (step_z & 7) * 64;
                if (geom_pool[t_s].cells[c_s].is_boundary) {
                    d_clearance = std::min(d_clearance, (float)step * 0.5f);
                    break;
                }
            }
        }
        float proj_dist = is_convex_corner ? 0.5f : std::max(0.5f, d_clearance);

        // Project along the adaptive normal
        float p_img_x = (float)target_x + nx_reflect * proj_dist;
        float p_img_y = (float)target_y + ny_reflect * proj_dist;
        float p_img_z = (float)target_z + nz_reflect * proj_dist;

        float sum_rho = 0.0f, sum_ux = 0.0f, sum_uy = 0.0f, sum_uz = 0.0f, sum_p = 0.0f;
        float sum_alpha1 = 0.0f, sum_alpha2 = 0.0f, sum_arho1 = 0.0f, sum_arho2 = 0.0f;
        float sum_peak_op = 0.0f, sum_peak_imp = 0.0f;
        float W_total = 0.0f;

        auto is_solid_cpu = [&](int x, int y, int z) {
            if (x < 0) return bcXmin == BCType3D::REFLECTIVE;
            if (x >= nx) return bcXmax == BCType3D::REFLECTIVE;
            if (y < 0) return bcYmin == BCType3D::REFLECTIVE;
            if (y >= ny) return bcYmax == BCType3D::REFLECTIVE;
            if (z < 0) return bcZmin == BCType3D::REFLECTIVE;
            if (z >= nz) return bcZmax == BCType3D::REFLECTIVE;
            int tx = (x >> 3) + (y >> 3) * n_tiles_x + (z >> 3) * n_tiles_x * n_tiles_y;
            int cx = (x & 7) + (y & 7) * 8 + (z & 7) * 64;
            return geom_pool[tx].cells[cx].is_boundary != 0;
        };

        for (int k = -1; k <= 1; ++k) {
            int nz_val = qz + k;
            if (nz_val < 0 || nz_val >= nz) continue;
            for (int j = -1; j <= 1; ++j) {
                int ny_val = qy + j;
                if (ny_val < 0 || ny_val >= ny) continue;
                for (int i = -1; i <= 1; ++i) {
                    int nx_val = qx + i;
                    if (nx_val < 0 || nx_val >= nx) continue;

                    int t_neigh = (nx_val >> 3) + (ny_val >> 3) * n_tiles_x + (nz_val >> 3) * n_tiles_x * n_tiles_y;
                    int c_neigh = (nx_val & 7) + (ny_val & 7) * 8 + (nz_val & 7) * 64;
                    if (geom_pool[t_neigh].cells[c_neigh].is_boundary) continue;

                    // Topological Line-of-Sight Barrier: prevent diagonal cross-wall tunneling
                    int tc_dist = (i != 0 ? 1 : 0) + (j != 0 ? 1 : 0) + (k != 0 ? 1 : 0);
                    if (tc_dist == 2) {
                        if (i != 0 && j != 0) {
                            if (is_solid_cpu(qx + i, qy, qz) && is_solid_cpu(qx, qy + j, qz)) continue;
                        } else if (i != 0 && k != 0) {
                            if (is_solid_cpu(qx + i, qy, qz) && is_solid_cpu(qx, qy, qz + k)) continue;
                        } else if (j != 0 && k != 0) {
                            if (is_solid_cpu(qx, qy + j, qz) && is_solid_cpu(qx, qy, qz + k)) continue;
                        }
                    } else if (tc_dist == 3) {
                        bool b_x = is_solid_cpu(qx + i, qy, qz);
                        bool b_y = is_solid_cpu(qx, qy + j, qz);
                        bool b_z = is_solid_cpu(qx, qy, qz + k);
                        if ((b_x && b_y) || (b_x && b_z) || (b_y && b_z)) continue;
                    }

                    // Visibility Half-Space Clipping using the adaptive normal:
                    float dx_plane = (float)nx_val - (float)target_x;
                    float dy_plane = (float)ny_val - (float)target_y;
                    float dz_plane = (float)nz_val - (float)target_z;
                    float dot_plane = dx_plane * nx_reflect + dy_plane * ny_reflect + dz_plane * nz_reflect;
                    if (dot_plane <= 0.0f) continue;

                    float dx_n = (float)nx_val - p_img_x;
                    float dy_n = (float)ny_val - p_img_y;
                    float dz_n = (float)nz_val - p_img_z;
                    float dist2 = dx_n*dx_n + dy_n*dy_n + dz_n*dz_n;
                    float w = 1.0f / (dist2 + 1e-6f);

                    auto s_neighbor = sampleStateInternal(nx_val, ny_val, nz_val);

                    sum_rho += w * (float)s_neighbor.rho;
                    sum_ux += w * (float)s_neighbor.ux;
                    sum_uy += w * (float)s_neighbor.uy;
                    sum_uz += w * (float)s_neighbor.uz;
                    sum_p += w * (float)s_neighbor.p;
                    sum_peak_op += w * (float)s_neighbor.peak_overpressure;
                    sum_peak_imp += w * (float)s_neighbor.peak_impulse;
                    if constexpr (IsMultiMaterial) {
                        sum_alpha1 += w * (float)s_neighbor.alpha1;
                        sum_alpha2 += w * (float)s_neighbor.alpha2;
                        sum_arho1 += w * (float)s_neighbor.arho1;
                        sum_arho2 += w * (float)s_neighbor.arho2;
                    }
                    W_total += w;
                }
            }
        }

        CellState3DT<RealType, IsMultiMaterial> s_ghost;
        if (W_total == 0.0f) {
            s_ghost = sampleStateInternal(qx, qy, qz);
        } else {
            float inv_W = 1.0f / W_total;
            s_ghost.rho = sum_rho * inv_W;
            s_ghost.ux = sum_ux * inv_W;
            s_ghost.uy = sum_uy * inv_W;
            s_ghost.uz = sum_uz * inv_W;
            s_ghost.p = sum_p * inv_W;
            s_ghost.peak_overpressure = sum_peak_op * inv_W;
            s_ghost.peak_impulse = sum_peak_imp * inv_W;
            s_ghost.alpha1 = sum_alpha1 * inv_W;
            s_ghost.alpha2 = sum_alpha2 * inv_W;
            s_ghost.arho1 = sum_arho1 * inv_W;
            s_ghost.arho2 = sum_arho2 * inv_W;
        }

        // ALWAYS reflect velocity across the TRUE STL normal to ensure smooth slip flow
        double vw_x = 0.0, vw_y = 0.0, vw_z = 0.0;
        if (!solid_vel_tiles.empty()) {
            int t_idx = (target_x >> 3) + (target_y >> 3) * n_tiles_x + (target_z >> 3) * n_tiles_x * n_tiles_y;
            int c_idx = (target_x & 7) + (target_y & 7) * 8 + (target_z & 7) * 64;
            if (t_idx >= 0 && t_idx < (int)solid_vel_tiles.size()) {
                vw_x = (double)solid_vel_tiles[t_idx].vx[c_idx];
                vw_y = (double)solid_vel_tiles[t_idx].vy[c_idx];
                vw_z = (double)solid_vel_tiles[t_idx].vz[c_idx];
            }
        }
        float u_rel_x = (float)s_ghost.ux - (float)vw_x;
        float u_rel_y = (float)s_ghost.uy - (float)vw_y;
        float u_rel_z = (float)s_ghost.uz - (float)vw_z;

        float u_dot_n = u_rel_x * nx_dec + u_rel_y * ny_dec + u_rel_z * nz_dec;
        s_ghost.ux = (RealType)((float)vw_x + u_rel_x - 2.0f * u_dot_n * nx_dec);
        s_ghost.uy = (RealType)((float)vw_y + u_rel_y - 2.0f * u_dot_n * ny_dec);
        s_ghost.uz = (RealType)((float)vw_z + u_rel_z - 2.0f * u_dot_n * nz_dec);

        RealType ke = (RealType)0.5 * s_ghost.rho * (s_ghost.ux*s_ghost.ux + s_ghost.uy*s_ghost.uy + s_ghost.uz*s_ghost.uz);
        if constexpr (IsMultiMaterial) {
            s_ghost.E = (RealType)MultiMat::getMixtureEnergy(s_ghost.p, s_ghost.rho, s_ghost.alpha1, s_ghost.alpha2, s_ghost.arho1, s_ghost.arho2, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted) + ke;
        } else if (this->is_water_tait_val) {
            CellState3D<IsMultiMaterial> s_tmp{};
            s_tmp.rho = s_ghost.rho;
            s_ghost.E = (RealType)getEnergy3D<IsMultiMaterial>((double)s_ghost.p, (double)s_ghost.rho, s_tmp, (double)gamma, currentMaterials.products, currentMaterials.unreacted, true, &this->tait_water_params) + ke;
        } else {
            s_ghost.E = s_ghost.p / ((RealType)gamma - (RealType)1.0) + ke;
        }
        return s_ghost;
    }

    inline CellState3DT<RealType, IsMultiMaterial> sampleStateInternal(int gx, int gy, int gz) const {
        return sampleStateInternalWithMirror(gx, gy, gz, false);
    }

    inline CellState3DT<RealType, IsMultiMaterial> sampleStateInternalWithMirror(int gx, int gy, int gz, bool /*enable_mirror*/) const {
        bool reflective_x = false, reflective_y = false, reflective_z = false;
        int orig_gx = gx, orig_gy = gy, orig_gz = gz;

        applyBC3DHelper(gx, nx, bcXmin, bcXmax, reflective_x);
        applyBC3DHelper(gy, ny, bcYmin, bcYmax, reflective_y);
        applyBC3DHelper(gz, nz, bcZmin, bcZmax, reflective_z);

        int clamped_gx = std::clamp(gx, 0, nx - 1);
        int clamped_gy = std::clamp(gy, 0, ny - 1);
        int clamped_gz = std::clamp(gz, 0, nz - 1);

        int t_idx = (clamped_gx >> 3) + (clamped_gy >> 3) * n_tiles_x + (clamped_gz >> 3) * n_tiles_x * n_tiles_y;
        int c_idx = (clamped_gx & 7) + (clamped_gy & 7) * 8 + (clamped_gz & 7) * 64;

        const auto& tile = states_pool[t_idx];
        CellState3DT<RealType, IsMultiMaterial> s;
        s.p = tile.p[c_idx]; s.rho = tile.rho[c_idx];
        s.ux = reflective_x ? -tile.ux[c_idx] : tile.ux[c_idx];
        s.uy = reflective_y ? -tile.uy[c_idx] : tile.uy[c_idx];
        s.uz = reflective_z ? -tile.uz[c_idx] : tile.uz[c_idx];

        RealType ke = (RealType)0.5 * s.rho * (s.ux*s.ux + s.uy*s.uy + s.uz*s.uz);
        s.peak_overpressure = tile.peak_overpressure[c_idx];
        s.peak_impulse = tile.peak_impulse[c_idx];
        if constexpr (IsMultiMaterial) {
            s.alpha1 = tile.alpha1[c_idx]; s.alpha2 = tile.alpha2[c_idx];
            s.arho1 = tile.arho1[c_idx]; s.arho2 = tile.arho2[c_idx];
            s.E = (RealType)MultiMat::getMixtureEnergy(s.p, s.rho, s.alpha1, s.alpha2, s.arho1, s.arho2, (RealType)gamma, currentMaterials.products, currentMaterials.unreacted) + ke;
        } else if (this->is_water_tait_val) {
            CellState3D<IsMultiMaterial> s_tmp{};
            s_tmp.rho = s.rho;
            s.alpha1 = 0.0; s.alpha2 = 0.0; s.arho1 = 0.0; s.arho2 = 0.0;
            s.E = (RealType)getEnergy3D<IsMultiMaterial>((double)s.p, (double)s.rho, s_tmp, (double)gamma, currentMaterials.products, currentMaterials.unreacted, true, &this->tait_water_params) + ke;
        } else {
            s.alpha1 = 0.0; s.alpha2 = 0.0; s.arho1 = 0.0; s.arho2 = 0.0;
            s.E = s.p / ((RealType)gamma - (RealType)1.0) + ke;
        }

        // Bottom floor hydrostatic well-balancing under gravity
        if (orig_gz < 0 && stratified_params.enabled) {
            double g_mag = std::abs(gravity_z);
            if (std::abs(stratified_params.gravity_z) > 1e-6) {
                g_mag = std::abs(stratified_params.gravity_z);
            }
            if (g_mag > 1e-6) {
                double dist_z = (double)(gz - orig_gz) * cellSize;
                s.p += (RealType)(s.rho * g_mag * dist_z);
                double z_c = this->zmin + ((double)orig_gz + 0.5) * this->cellSize;
                bool is_soil = (this->stratified_params.enabled && z_c < this->stratified_params.seabed_surface_z);
                if (is_soil) {
                    double gamma_soil = this->stratified_params.soil_gamma > 0.0 ? this->stratified_params.soil_gamma : 4.0;
                    double rho0_soil = this->stratified_params.soil_density > 0.0 ? this->stratified_params.soil_density : 2000.0;
                    double c0_soil = this->stratified_params.soil_c0 > 0.0 ? this->stratified_params.soil_c0 : 2500.0;
                    double B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
                    double p0_soil = this->stratified_params.p_atm;
                    s.rho = (RealType)Blast::TaitEOSWater::compute_density_isentropic(
                        (double)s.p, B_soil, gamma_soil, rho0_soil, p0_soil);
                    double e_soil = Blast::TaitEOSWater::compute_energy_isentropic(
                        (double)s.rho, B_soil, gamma_soil, rho0_soil);
                    s.E = (RealType)((double)s.rho * e_soil + ke);
                } else if (this->is_water_tait_val || stratified_params.enabled) {
                    s.rho = (RealType)Blast::TaitEOSWater::compute_density_isentropic(
                        (double)s.p, this->tait_water_params.B, this->tait_water_params.gamma,
                        (double)s.rho, this->tait_water_params.p0);
                    double e_w = Blast::TaitEOSWater::compute_energy_dispatcher((double)s.rho, (double)s.p, this->tait_water_params);
                    s.E = (RealType)((double)s.rho * e_w + ke);
                } else {
                    s.E = (RealType)((double)s.p / ((double)gamma - 1.0) + ke);
                }
            }
        }

        // Top boundary hydrostatic pressure profile under gravity
        if (orig_gz >= nz && stratified_params.enabled) {
            double dist_z = (double)(orig_gz - gz) * cellSize;
            double g_z = stratified_params.gravity_z != 0.0 ? stratified_params.gravity_z : gravity_z;
            s.p = (RealType)std::max((double)stratified_params.p_atm, (double)s.p + (double)s.rho * g_z * dist_z);
            double z_c = this->zmin + ((double)orig_gz + 0.5) * this->cellSize;
            bool is_soil = (this->stratified_params.enabled && z_c < this->stratified_params.seabed_surface_z);
            if (is_soil) {
                double gamma_soil = this->stratified_params.soil_gamma > 0.0 ? this->stratified_params.soil_gamma : 4.0;
                double rho0_soil = this->stratified_params.soil_density > 0.0 ? this->stratified_params.soil_density : 2000.0;
                double c0_soil = this->stratified_params.soil_c0 > 0.0 ? this->stratified_params.soil_c0 : 2500.0;
                double B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
                double p0_soil = this->stratified_params.p_atm;
                s.rho = (RealType)Blast::TaitEOSWater::compute_density_isentropic(
                    (double)s.p, B_soil, gamma_soil, rho0_soil, p0_soil);
                double e_soil = Blast::TaitEOSWater::compute_energy_isentropic(
                    (double)s.rho, B_soil, gamma_soil, rho0_soil);
                s.E = (RealType)((double)s.rho * e_soil + ke);
            } else if (this->is_water_tait_val || (stratified_params.enabled && z_c <= this->stratified_params.water_surface_z)) {
                s.rho = (RealType)Blast::TaitEOSWater::compute_density_isentropic(
                    (double)s.p, this->tait_water_params.B, this->tait_water_params.gamma,
                    (double)s.rho, this->tait_water_params.p0);
                double e_w = Blast::TaitEOSWater::compute_energy_dispatcher((double)s.rho, (double)s.p, this->tait_water_params);
                s.E = (RealType)((double)s.rho * e_w + ke);
            } else {
                s.E = (RealType)((double)s.p / ((double)gamma - 1.0) + ke);
            }
        }

        // Non-reflecting characteristic Riemann boundary condition (OUTFLOW_RIEMANN)
        bool is_riemann = (orig_gx < 0 && bcXmin == BCType3D::OUTFLOW_RIEMANN) ||
                          (orig_gx >= nx && bcXmax == BCType3D::OUTFLOW_RIEMANN) ||
                          (orig_gy < 0 && bcYmin == BCType3D::OUTFLOW_RIEMANN) ||
                          (orig_gy >= ny && bcYmax == BCType3D::OUTFLOW_RIEMANN) ||
                          (orig_gz < 0 && bcZmin == BCType3D::OUTFLOW_RIEMANN) ||
                          (orig_gz >= nz && bcZmax == BCType3D::OUTFLOW_RIEMANN);

        if (is_riemann) {
            double nx_out = 0.0, ny_out = 0.0, nz_out = 0.0;
            if (orig_gx < 0 && bcXmin == BCType3D::OUTFLOW_RIEMANN) nx_out = -1.0;
            else if (orig_gx >= nx && bcXmax == BCType3D::OUTFLOW_RIEMANN) nx_out = 1.0;
            else if (orig_gy < 0 && bcYmin == BCType3D::OUTFLOW_RIEMANN) ny_out = -1.0;
            else if (orig_gy >= ny && bcYmax == BCType3D::OUTFLOW_RIEMANN) ny_out = 1.0;
            else if (orig_gz < 0 && bcZmin == BCType3D::OUTFLOW_RIEMANN) nz_out = -1.0;
            else if (orig_gz >= nz && bcZmax == BCType3D::OUTFLOW_RIEMANN) nz_out = 1.0;

            double un_int = (double)s.ux * nx_out + (double)s.uy * ny_out + (double)s.uz * nz_out;

            double p_target = this->ambient_p;
            double rho_target = this->ambient_rho;
            double p_hydro_int = this->ambient_p;
            bool is_water_target = this->is_water_tait_val;
            bool is_soil_target = false;

            if (this->stratified_params.enabled) {
                double z_c = this->zmin + ((double)orig_gz + 0.5) * this->cellSize;
                double z_int = this->zmin + ((double)gz + 0.5) * this->cellSize;
                double g_mag = std::abs(this->stratified_params.gravity_z);
                if (g_mag < 1e-6) g_mag = 9.81;

                auto eval_hydro = [&](double z_eval, double& p_out, double& rho_out, bool& is_w, bool& is_s) {
                    if (z_eval > this->stratified_params.water_surface_z) {
                        double z_air_depth = z_eval - this->stratified_params.water_surface_z;
                        p_out = this->stratified_params.p_atm - this->stratified_params.air_rho * g_mag * z_air_depth;
                        rho_out = this->stratified_params.air_rho;
                        is_w = false; is_s = false;
                    } else if (z_eval >= this->stratified_params.seabed_surface_z) {
                        double p_h = 0.0, rho_h = 0.0, e_h = 0.0;
                        Blast::TaitEOSWater::compute_hydrostatic_state(
                            z_eval, this->stratified_params.water_surface_z, g_mag, this->stratified_params.p_atm,
                            p_h, rho_h, e_h, this->stratified_params.tait_B, this->stratified_params.tait_gamma, this->stratified_params.tait_rho0
                        );
                        p_out = p_h;
                        rho_out = rho_h;
                        is_w = true; is_s = false;
                    } else {
                        double p_bed = 0.0, rho_bed = 0.0, e_bed = 0.0;
                        Blast::TaitEOSWater::compute_hydrostatic_state(
                            this->stratified_params.seabed_surface_z, this->stratified_params.water_surface_z, g_mag, this->stratified_params.p_atm,
                            p_bed, rho_bed, e_bed, this->stratified_params.tait_B, this->stratified_params.tait_gamma, this->stratified_params.tait_rho0
                        );
                        double sig_v = 0.0, u_p = 0.0, sig_h = 0.0;
                        Blast::TaitEOSWater::compute_geostatic_stress(
                            z_eval, this->stratified_params.seabed_surface_z, p_bed, this->stratified_params.soil_density, this->stratified_params.tait_rho0, g_mag, this->stratified_params.k0_earth_pressure,
                            sig_v, u_p, sig_h
                        );
                        p_out = sig_v;
                        double gamma_soil = this->stratified_params.soil_gamma > 0.0 ? this->stratified_params.soil_gamma : 4.0;
                        double rho0_soil = this->stratified_params.soil_density > 0.0 ? this->stratified_params.soil_density : 2000.0;
                        double c0_soil = this->stratified_params.soil_c0 > 0.0 ? this->stratified_params.soil_c0 : 2500.0;
                        double B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
                        double p0_soil = this->stratified_params.p_atm;
                        rho_out = Blast::TaitEOSWater::compute_density_isentropic(
                            sig_v, B_soil, gamma_soil, rho0_soil, p0_soil);
                        is_s = true; is_w = false;
                    }
                };

                bool dummy_w, dummy_s;
                eval_hydro(z_c, p_target, rho_target, is_water_target, is_soil_target);
                eval_hydro(z_int, p_hydro_int, rho_target, dummy_w, dummy_s);
            }

            if (is_soil_target) {
                double gamma_soil = this->stratified_params.soil_gamma > 0.0 ? this->stratified_params.soil_gamma : 4.0;
                double rho0_soil = this->stratified_params.soil_density > 0.0 ? this->stratified_params.soil_density : 2000.0;
                double c0_soil = this->stratified_params.soil_c0 > 0.0 ? this->stratified_params.soil_c0 : 2500.0;
                double B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
                double p0_soil = this->stratified_params.p_atm;
                double p_cav_soil = this->stratified_params.soil_p_cav != 0.0 ? this->stratified_params.soil_p_cav : -1.0e5;

                double c_soil = Blast::TaitEOSWater::compute_sound_speed_isentropic(
                    (double)s.rho, B_soil, gamma_soil, rho0_soil);
                double Z = (double)s.rho * c_soil;
                if (Z < 1.0e-3) Z = rho0_soil * c0_soil;

                double p_pert_int = (double)s.p - p_hydro_int;
                double un_ghost = 0.5 * (un_int + p_pert_int / Z);
                double p_ghost = p_target + 0.5 * (p_pert_int + Z * un_int);
                if (p_ghost < p_cav_soil) p_ghost = p_cav_soil;

                double rho_ghost = Blast::TaitEOSWater::compute_density_isentropic(
                    p_ghost, B_soil, gamma_soil, rho0_soil, p0_soil);

                s.ux += (RealType)((un_ghost - un_int) * nx_out);
                s.uy += (RealType)((un_ghost - un_int) * ny_out);
                s.uz += (RealType)((un_ghost - un_int) * nz_out);
                s.p = (RealType)p_ghost;
                s.rho = (RealType)rho_ghost;

                double e_soil = Blast::TaitEOSWater::compute_energy_isentropic(
                    rho_ghost, B_soil, gamma_soil, rho0_soil);
                double ke_r = 0.5 * (double)s.rho * ((double)s.ux * (double)s.ux + (double)s.uy * (double)s.uy + (double)s.uz * (double)s.uz);
                s.E = (RealType)(rho_ghost * e_soil + ke_r);
            } else if (is_water_target || this->is_water_tait_val) {
                double c_w = Blast::TaitEOSWater::compute_sound_speed_dispatcher(
                    (double)s.rho, (double)s.p, this->tait_water_params, 0.0);
                double Z = (double)s.rho * c_w;
                if (Z < 1.0e-3) Z = 1.0e3 * 1482.0;

                double p_pert_int = (double)s.p - p_hydro_int;
                double un_ghost = 0.5 * (un_int + p_pert_int / Z);
                double p_ghost = p_target + 0.5 * (p_pert_int + Z * un_int);
                if (p_ghost < this->tait_water_params.p_cav) p_ghost = this->tait_water_params.p_cav;

                double rho_ghost = Blast::TaitEOSWater::compute_density_isentropic(
                    p_ghost, this->tait_water_params.B, this->tait_water_params.gamma,
                    rho_target, this->tait_water_params.p0);

                s.ux += (RealType)((un_ghost - un_int) * nx_out);
                s.uy += (RealType)((un_ghost - un_int) * ny_out);
                s.uz += (RealType)((un_ghost - un_int) * nz_out);
                s.p = (RealType)p_ghost;
                s.rho = (RealType)rho_ghost;

                double e_w = Blast::TaitEOSWater::compute_energy_dispatcher(rho_ghost, p_ghost, this->tait_water_params);
                double ke_r = 0.5 * (double)s.rho * ((double)s.ux * (double)s.ux + (double)s.uy * (double)s.uy + (double)s.uz * (double)s.uz);
                s.E = (RealType)(rho_ghost * e_w + ke_r);
            } else {
                double gm1 = (double)gamma - 1.0;
                double c_int = std::sqrt((double)gamma * (double)s.p / std::max(1e-6, (double)s.rho));
                double c_atm = std::sqrt((double)gamma * p_target / std::max(1e-6, rho_target));

                double R_plus = un_int + 2.0 * c_int / gm1;
                double R_minus = - 2.0 * c_atm / gm1;
                double un_ghost = 0.5 * (R_plus + R_minus);
                double c_ghost = std::max(0.1, 0.25 * gm1 * (R_plus - R_minus));

                double c_ratio = c_ghost / c_atm;
                double rho_ghost = rho_target * std::pow(c_ratio, 2.0 / gm1);
                double p_ghost = p_target * std::pow(c_ratio, 2.0 * (double)gamma / gm1);

                s.ux += (RealType)((un_ghost - un_int) * nx_out);
                s.uy += (RealType)((un_ghost - un_int) * ny_out);
                s.uz += (RealType)((un_ghost - un_int) * nz_out);
                s.p = (RealType)p_ghost;
                s.rho = (RealType)rho_ghost;

                double ke_r = 0.5 * (double)s.rho * ((double)s.ux * (double)s.ux + (double)s.uy * (double)s.uy + (double)s.uz * (double)s.uz);
                if constexpr (IsMultiMaterial) {
                    s.E = (RealType)MultiMat::getMixtureEnergy((double)s.p, (double)s.rho, (double)s.alpha1, (double)s.alpha2, (double)s.arho1, (double)s.arho2, (double)gamma, currentMaterials.products, currentMaterials.unreacted) + (RealType)ke_r;
                } else {
                    s.E = (RealType)(s.p / ((double)gamma - 1.0) + ke_r);
                }
            }
        }
        return s;
    }

    inline void applyBC3DHelper(int& g, int n, BCType3D bc_min, BCType3D bc_max, bool& reflect) const {
        if (g < 0) {
            if (bc_min == BCType3D::REFLECTIVE) { g = -g - 1; reflect = !reflect; }
            else g = 0;
        } else if (g >= n) {
            if (bc_max == BCType3D::REFLECTIVE) { g = 2 * n - 1 - g; reflect = !reflect; }
            else g = n - 1;
        }
    }

    inline CellState3D<IsMultiMaterial> sampleState(int gx, int gy, int gz) const {
        return sampleStateWithMirror(gx, gy, gz, true);
    }

    inline CellState3D<IsMultiMaterial> sampleStateWithMirror(int gx, int gy, int gz, bool enable_mirror) const {
        bool reflective_x = false, reflective_y = false, reflective_z = false;
        int orig_gx = gx, orig_gy = gy, orig_gz = gz;

        applyBC3DHelper(gx, nx, bcXmin, bcXmax, reflective_x);
        applyBC3DHelper(gy, ny, bcYmin, bcYmax, reflective_y);
        applyBC3DHelper(gz, nz, bcZmin, bcZmax, reflective_z);

        int clamped_gx = std::clamp(gx, 0, nx - 1);
        int clamped_gy = std::clamp(gy, 0, ny - 1);
        int clamped_gz = std::clamp(gz, 0, nz - 1);

        int t_idx = (clamped_gx >> 3) + (clamped_gy >> 3) * n_tiles_x + (clamped_gz >> 3) * n_tiles_x * n_tiles_y;
        int c_idx = (clamped_gx & 7) + (clamped_gy & 7) * 8 + (clamped_gz & 7) * 64;

        if (enable_mirror && !geom_pool.empty() && geom_pool[t_idx].cells[c_idx].is_boundary) {
            float nx_b = geom_pool[t_idx].cells[c_idx].nx;
            float ny_b = geom_pool[t_idx].cells[c_idx].ny;
            float nz_b = geom_pool[t_idx].cells[c_idx].nz;

            float n_len = std::sqrt(nx_b*nx_b + ny_b*ny_b + nz_b*nz_b);
            if (n_len > 1e-3f) {
                float nx_u = nx_b / n_len;
                float ny_u = ny_b / n_len;
                float nz_u = nz_b / n_len;

                // Option B: Decouple boundary normal components at domain boundaries
                bool decoupled = false;
                if (clamped_gx == 0 || clamped_gx == nx - 1) { nx_u = 0.0f; decoupled = true; }
                if (clamped_gy == 0 || clamped_gy == ny - 1) { ny_u = 0.0f; decoupled = true; }
                if (clamped_gz == 0 || clamped_gz == nz - 1) { nz_u = 0.0f; decoupled = true; }
                if (decoupled) {
                    float n_len_dec = std::sqrt(nx_u*nx_u + ny_u*ny_u + nz_u*nz_u);
                    if (n_len_dec > 1e-3f) {
                        nx_u /= n_len_dec;
                        ny_u /= n_len_dec;
                        nz_u /= n_len_dec;
                    }
                }

                double x_G = xmin + (gx + 0.5) * cellSize;
                double y_G = ymin + (gy + 0.5) * cellSize;
                double z_G = zmin + (gz + 0.5) * cellSize;

                double x_IP = x_G + 1.5 * cellSize * nx_u;
                double y_IP = y_G + 1.5 * cellSize * ny_u;
                double z_IP = z_G + 1.5 * cellSize * nz_u;

                double x_nd = (x_IP - xmin) / cellSize - 0.5;
                double y_nd = (y_IP - ymin) / cellSize - 0.5;
                double z_nd = (z_IP - zmin) / cellSize - 0.5;

                int i0 = (int)std::floor(x_nd);
                int j0 = (int)std::floor(y_nd);
                int k0 = (int)std::floor(z_nd);
                int i1 = i0 + 1;
                int j1 = j0 + 1;
                int k1 = k0 + 1;

                double wx = x_nd - i0;
                double wy = y_nd - j0;
                double wz = z_nd - k0;

                auto is_solid = [&](int i, int j, int k) {
                    if (geom_pool.empty()) return false;
                    int ci = std::clamp(i, 0, nx - 1);
                    int cj = std::clamp(j, 0, ny - 1);
                    int ck = std::clamp(k, 0, nz - 1);
                    int t = (ci >> 3) + (cj >> 3) * n_tiles_x + (ck >> 3) * n_tiles_x * n_tiles_y;
                    int c = (ci & 7) + (cj & 7) * 8 + (ck & 7) * 64;
                    return geom_pool[t].cells[c].is_boundary != 0;
                };

                double w[8];
                w[0] = (1.0 - wx) * (1.0 - wy) * (1.0 - wz);
                w[1] = wx * (1.0 - wy) * (1.0 - wz);
                w[2] = (1.0 - wx) * wy * (1.0 - wz);
                w[3] = wx * wy * (1.0 - wz);
                w[4] = (1.0 - wx) * (1.0 - wy) * wz;
                w[5] = wx * (1.0 - wy) * wz;
                w[6] = (1.0 - wx) * wy * wz;
                w[7] = wx * wy * wz;

                bool solid_mask[8];
                solid_mask[0] = is_solid(i0, j0, k0);
                solid_mask[1] = is_solid(i1, j0, k0);
                solid_mask[2] = is_solid(i0, j1, k0);
                solid_mask[3] = is_solid(i1, j1, k0);
                solid_mask[4] = is_solid(i0, j0, k1);
                solid_mask[5] = is_solid(i1, j0, k1);
                solid_mask[6] = is_solid(i0, j1, k1);
                solid_mask[7] = is_solid(i1, j1, k1);

                double sum_w = 0.0;
                for (int c = 0; c < 8; ++c) {
                    if (solid_mask[c]) {
                        w[c] = 0.0;
                    } else {
                        sum_w += w[c];
                    }
                }

                if (sum_w > 1e-6) {
                    double inv_sum = 1.0 / sum_w;
                    for (int c = 0; c < 8; ++c) w[c] *= inv_sum;

                    auto s000 = sampleStateWithMirror(i0, j0, k0, false);
                    auto s100 = sampleStateWithMirror(i1, j0, k0, false);
                    auto s010 = sampleStateWithMirror(i0, j1, k0, false);
                    auto s110 = sampleStateWithMirror(i1, j1, k0, false);
                    auto s001 = sampleStateWithMirror(i0, j0, k1, false);
                    auto s101 = sampleStateWithMirror(i1, j0, k1, false);
                    auto s011 = sampleStateWithMirror(i0, j1, k1, false);
                    auto s111 = sampleStateWithMirror(i1, j1, k1, false);

                    double rho_i = w[0]*s000.rho + w[1]*s100.rho + w[2]*s010.rho + w[3]*s110.rho +
                                   w[4]*s001.rho + w[5]*s101.rho + w[6]*s011.rho + w[7]*s111.rho;
                    double ux_i = w[0]*s000.ux + w[1]*s100.ux + w[2]*s010.ux + w[3]*s110.ux +
                                  w[4]*s001.ux + w[5]*s101.ux + w[6]*s011.ux + w[7]*s111.ux;
                    double uy_i = w[0]*s000.uy + w[1]*s100.uy + w[2]*s010.uy + w[3]*s110.uy +
                                  w[4]*s001.uy + w[5]*s101.uy + w[6]*s011.uy + w[7]*s111.uy;
                    double uz_i = w[0]*s000.uz + w[1]*s100.uz + w[2]*s010.uz + w[3]*s110.uz +
                                  w[4]*s001.uz + w[5]*s101.uz + w[6]*s011.uz + w[7]*s111.uz;
                    double p_i = w[0]*s000.p + w[1]*s100.p + w[2]*s010.p + w[3]*s110.p +
                                 w[4]*s001.p + w[5]*s101.p + w[6]*s011.p + w[7]*s111.p;
                    double peak_op_i = w[0]*s000.peak_overpressure + w[1]*s100.peak_overpressure + w[2]*s010.peak_overpressure + w[3]*s110.peak_overpressure +
                                       w[4]*s001.peak_overpressure + w[5]*s101.peak_overpressure + w[6]*s011.peak_overpressure + w[7]*s111.peak_overpressure;
                    double peak_imp_i = w[0]*s000.peak_impulse + w[1]*s100.peak_impulse + w[2]*s010.peak_impulse + w[3]*s110.peak_impulse +
                                        w[4]*s001.peak_impulse + w[5]*s101.peak_impulse + w[6]*s011.peak_impulse + w[7]*s111.peak_impulse;

                    CellState3D<IsMultiMaterial> s_ghost;
                    s_ghost.rho = rho_i;
                    s_ghost.p = p_i;
                    s_ghost.peak_overpressure = peak_op_i;
                    s_ghost.peak_impulse = peak_imp_i;

                    double vw_x = 0.0, vw_y = 0.0, vw_z = 0.0;
                    if (!solid_vel_tiles.empty()) {
                        int t_idx = (clamped_gx >> 3) + (clamped_gy >> 3) * n_tiles_x + (clamped_gz >> 3) * n_tiles_x * n_tiles_y;
                        int c_idx = (clamped_gx & 7) + (clamped_gy & 7) * 8 + (clamped_gz & 7) * 64;
                        if (t_idx >= 0 && t_idx < (int)solid_vel_tiles.size()) {
                            vw_x = (double)solid_vel_tiles[t_idx].vx[c_idx];
                            vw_y = (double)solid_vel_tiles[t_idx].vy[c_idx];
                            vw_z = (double)solid_vel_tiles[t_idx].vz[c_idx];
                        }
                    }
                    double u_rel_x = ux_i - vw_x;
                    double u_rel_y = uy_i - vw_y;
                    double u_rel_z = uz_i - vw_z;
                    double u_dot_n = u_rel_x * nx_u + u_rel_y * ny_u + u_rel_z * nz_u;
                    s_ghost.ux = vw_x + u_rel_x - 2.0 * u_dot_n * nx_u;
                    s_ghost.uy = vw_y + u_rel_y - 2.0 * u_dot_n * ny_u;
                    s_ghost.uz = vw_z + u_rel_z - 2.0 * u_dot_n * nz_u;

                    if constexpr (IsMultiMaterial) {
                        s_ghost.alpha1 = w[0]*s000.alpha1 + w[1]*s100.alpha1 + w[2]*s010.alpha1 + w[3]*s110.alpha1 +
                                         w[4]*s001.alpha1 + w[5]*s101.alpha1 + w[6]*s011.alpha1 + w[7]*s111.alpha1;
                        s_ghost.alpha2 = w[0]*s000.alpha2 + w[1]*s100.alpha2 + w[2]*s010.alpha2 + w[3]*s110.alpha2 +
                                         w[4]*s001.alpha2 + w[5]*s101.alpha2 + w[6]*s011.alpha2 + w[7]*s111.alpha2;
                        s_ghost.arho1 = w[0]*s000.arho1 + w[1]*s100.arho1 + w[2]*s010.arho1 + w[3]*s110.arho1 +
                                        w[4]*s001.arho1 + w[5]*s101.arho1 + w[6]*s011.arho1 + w[7]*s111.arho1;
                        s_ghost.arho2 = w[0]*s000.arho2 + w[1]*s100.arho2 + w[2]*s010.arho2 + w[3]*s110.arho2 +
                                        w[4]*s001.arho2 + w[5]*s101.arho2 + w[6]*s011.arho2 + w[7]*s111.arho2;
                    } else {
                        s_ghost.alpha1 = 0.0; s_ghost.alpha2 = 0.0; s_ghost.arho1 = 0.0; s_ghost.arho2 = 0.0;
                    }

                    double ke = 0.5 * s_ghost.rho * (s_ghost.ux*s_ghost.ux + s_ghost.uy*s_ghost.uy + s_ghost.uz*s_ghost.uz);
                    if constexpr (IsMultiMaterial) {
                        s_ghost.E = MultiMat::getMixtureEnergy(s_ghost.p, s_ghost.rho, s_ghost.alpha1, s_ghost.alpha2, s_ghost.arho1, s_ghost.arho2, gamma, currentMaterials.products, currentMaterials.unreacted) + ke;
                    } else {
                        s_ghost.E = s_ghost.p / (gamma - 1.0) + ke;
                    }
                    return s_ghost;
                }
            }

            int best_dx = 0, best_dy = 0, best_dz = 0;
            float max_dot = -1e9f;
            const int dirs[6][3] = {
                {1, 0, 0}, {-1, 0, 0},
                {0, 1, 0}, {0, -1, 0},
                {0, 0, 1}, {0, 0, -1}
            };
            for (int d = 0; d < 6; ++d) {
                int ngx = gx + dirs[d][0];
                int ngy = gy + dirs[d][1];
                int ngz = gz + dirs[d][2];
                if (ngx >= 0 && ngx < nx && ngy >= 0 && ngy < ny && ngz >= 0 && ngz < nz) {
                    int nt_idx = (ngx >> 3) + (ngy >> 3) * n_tiles_x + (ngz >> 3) * n_tiles_x * n_tiles_y;
                    int nc_idx = (ngx & 7) + (ngy & 7) * 8 + (ngz & 7) * 64;
                    if (!geom_pool[nt_idx].cells[nc_idx].is_boundary) {
                        float dot = dirs[d][0] * nx_b + dirs[d][1] * ny_b + dirs[d][2] * nz_b;
                        if (dot > max_dot) {
                            max_dot = dot;
                            best_dx = dirs[d][0];
                            best_dy = dirs[d][1];
                            best_dz = dirs[d][2];
                        }
                    }
                }
            }

            if (max_dot > -1e8f) {
                auto s_fluid = sampleStateWithMirror(gx + best_dx, gy + best_dy, gz + best_dz, false);
                auto s_ghost = s_fluid;
                float nx_dec = nx_b;
                float ny_dec = ny_b;
                float nz_dec = nz_b;
                bool decoupled = false;
                if (clamped_gx == 0 || clamped_gx == nx - 1) { nx_dec = 0.0f; decoupled = true; }
                if (clamped_gy == 0 || clamped_gy == ny - 1) { ny_dec = 0.0f; decoupled = true; }
                if (clamped_gz == 0 || clamped_gz == nz - 1) { nz_dec = 0.0f; decoupled = true; }
                if (decoupled) {
                    float n_len_dec = std::sqrt(nx_dec*nx_dec + ny_dec*ny_dec + nz_dec*nz_dec);
                    if (n_len_dec > 1e-3f) {
                        nx_dec /= n_len_dec;
                        ny_dec /= n_len_dec;
                        nz_dec /= n_len_dec;
                    }
                }
                double vw_x = 0.0, vw_y = 0.0, vw_z = 0.0;
                if (!solid_vel_tiles.empty()) {
                    int t_idx = (clamped_gx >> 3) + (clamped_gy >> 3) * n_tiles_x + (clamped_gz >> 3) * n_tiles_x * n_tiles_y;
                    int c_idx = (clamped_gx & 7) + (clamped_gy & 7) * 8 + (clamped_gz & 7) * 64;
                    if (t_idx >= 0 && t_idx < (int)solid_vel_tiles.size()) {
                        vw_x = (double)solid_vel_tiles[t_idx].vx[c_idx];
                        vw_y = (double)solid_vel_tiles[t_idx].vy[c_idx];
                        vw_z = (double)solid_vel_tiles[t_idx].vz[c_idx];
                    }
                }
                double u_rel_x = s_fluid.ux - vw_x;
                double u_rel_y = s_fluid.uy - vw_y;
                double u_rel_z = s_fluid.uz - vw_z;
                double u_dot_n = u_rel_x * nx_dec + u_rel_y * ny_dec + u_rel_z * nz_dec;
                s_ghost.ux = vw_x + u_rel_x - 2.0 * u_dot_n * nx_dec;
                s_ghost.uy = vw_y + u_rel_y - 2.0 * u_dot_n * ny_dec;
                s_ghost.uz = vw_z + u_rel_z - 2.0 * u_dot_n * nz_dec;
                return s_ghost;
            }
        }

        const auto& tile = states_pool[t_idx];
        CellState3D<IsMultiMaterial> s;
        s.p = (double)tile.p[c_idx]; s.rho = (double)tile.rho[c_idx];
        s.ux = reflective_x ? -(double)tile.ux[c_idx] : (double)tile.ux[c_idx];
        s.uy = reflective_y ? -(double)tile.uy[c_idx] : (double)tile.uy[c_idx];
        s.uz = reflective_z ? -(double)tile.uz[c_idx] : (double)tile.uz[c_idx];
        s.peak_overpressure = (double)tile.peak_overpressure[c_idx];
        s.peak_impulse = (double)tile.peak_impulse[c_idx];

        double ke = 0.5 * s.rho * (s.ux*s.ux + s.uy*s.uy + s.uz*s.uz);
        if constexpr (IsMultiMaterial) {
            s.alpha1 = (double)tile.alpha1[c_idx]; s.alpha2 = (double)tile.alpha2[c_idx];
            s.arho1 = (double)tile.arho1[c_idx]; s.arho2 = (double)tile.arho2[c_idx];
            s.E = (double)MultiMat::getMixtureEnergy(s.p, s.rho, s.alpha1, s.alpha2, s.arho1, s.arho2, (double)gamma, currentMaterials.products, currentMaterials.unreacted) + ke;
        } else {
            s.alpha1 = 0.0; s.alpha2 = 0.0; s.arho1 = 0.0; s.arho2 = 0.0;
            s.E = s.p / ((double)gamma - 1.0) + ke;
        }

        // Bottom floor hydrostatic well-balancing under gravity
        if (orig_gz < 0 && stratified_params.enabled) {
            double g_mag = std::abs(gravity_z);
            if (std::abs(stratified_params.gravity_z) > 1e-6) {
                g_mag = std::abs(stratified_params.gravity_z);
            }
            if (g_mag > 1e-6) {
                double dist_z = (double)(gz - orig_gz) * cellSize;
                s.p += (RealType)(s.rho * g_mag * dist_z);
                double z_c = this->zmin + ((double)orig_gz + 0.5) * this->cellSize;
                bool is_soil = (this->stratified_params.enabled && z_c < this->stratified_params.seabed_surface_z);
                if (is_soil) {
                    double gamma_soil = this->stratified_params.soil_gamma > 0.0 ? this->stratified_params.soil_gamma : 4.0;
                    double rho0_soil = this->stratified_params.soil_density > 0.0 ? this->stratified_params.soil_density : 2000.0;
                    double c0_soil = this->stratified_params.soil_c0 > 0.0 ? this->stratified_params.soil_c0 : 2500.0;
                    double B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
                    double p0_soil = this->stratified_params.p_atm;
                    s.rho = (RealType)Blast::TaitEOSWater::compute_density_isentropic(
                        (double)s.p, B_soil, gamma_soil, rho0_soil, p0_soil);
                    double e_soil = Blast::TaitEOSWater::compute_energy_isentropic(
                        (double)s.rho, B_soil, gamma_soil, rho0_soil);
                    s.E = (RealType)((double)s.rho * e_soil + ke);
                } else if (this->is_water_tait_val || stratified_params.enabled) {
                    s.rho = (RealType)Blast::TaitEOSWater::compute_density_isentropic(
                        (double)s.p, this->tait_water_params.B, this->tait_water_params.gamma,
                        (double)s.rho, this->tait_water_params.p0);
                    double e_w = Blast::TaitEOSWater::compute_energy_dispatcher((double)s.rho, (double)s.p, this->tait_water_params);
                    s.E = (RealType)((double)s.rho * e_w + ke);
                } else {
                    s.E = (RealType)((double)s.p / ((double)gamma - 1.0) + ke);
                }
            }
        }

        // Top boundary hydrostatic pressure profile under gravity
        if (orig_gz >= nz && stratified_params.enabled) {
            double dist_z = (double)(orig_gz - gz) * cellSize;
            double g_z = stratified_params.gravity_z != 0.0 ? stratified_params.gravity_z : gravity_z;
            s.p = (RealType)std::max((double)stratified_params.p_atm, (double)s.p + (double)s.rho * g_z * dist_z);
            double z_c = this->zmin + ((double)orig_gz + 0.5) * this->cellSize;
            bool is_soil = (this->stratified_params.enabled && z_c < this->stratified_params.seabed_surface_z);
            if (is_soil) {
                double gamma_soil = this->stratified_params.soil_gamma > 0.0 ? this->stratified_params.soil_gamma : 4.0;
                double rho0_soil = this->stratified_params.soil_density > 0.0 ? this->stratified_params.soil_density : 2000.0;
                double c0_soil = this->stratified_params.soil_c0 > 0.0 ? this->stratified_params.soil_c0 : 2500.0;
                double B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
                double p0_soil = this->stratified_params.p_atm;
                s.rho = (RealType)Blast::TaitEOSWater::compute_density_isentropic(
                    (double)s.p, B_soil, gamma_soil, rho0_soil, p0_soil);
                double e_soil = Blast::TaitEOSWater::compute_energy_isentropic(
                    (double)s.rho, B_soil, gamma_soil, rho0_soil);
                s.E = (RealType)((double)s.rho * e_soil + ke);
            } else if (this->is_water_tait_val || (stratified_params.enabled && z_c <= this->stratified_params.water_surface_z)) {
                s.rho = (RealType)Blast::TaitEOSWater::compute_density_isentropic(
                    (double)s.p, this->tait_water_params.B, this->tait_water_params.gamma,
                    (double)s.rho, this->tait_water_params.p0);
                double e_w = Blast::TaitEOSWater::compute_energy_dispatcher((double)s.rho, (double)s.p, this->tait_water_params);
                s.E = (RealType)((double)s.rho * e_w + ke);
            } else {
                s.E = (RealType)((double)s.p / ((double)gamma - 1.0) + ke);
            }
        }

        // Non-reflecting characteristic Riemann boundary condition (OUTFLOW_RIEMANN)
        bool is_riemann = (orig_gx < 0 && bcXmin == BCType3D::OUTFLOW_RIEMANN) ||
                          (orig_gx >= nx && bcXmax == BCType3D::OUTFLOW_RIEMANN) ||
                          (orig_gy < 0 && bcYmin == BCType3D::OUTFLOW_RIEMANN) ||
                          (orig_gy >= ny && bcYmax == BCType3D::OUTFLOW_RIEMANN) ||
                          (orig_gz < 0 && bcZmin == BCType3D::OUTFLOW_RIEMANN) ||
                          (orig_gz >= nz && bcZmax == BCType3D::OUTFLOW_RIEMANN);

        if (is_riemann) {
            double nx_out = 0.0, ny_out = 0.0, nz_out = 0.0;
            if (orig_gx < 0 && bcXmin == BCType3D::OUTFLOW_RIEMANN) nx_out = -1.0;
            else if (orig_gx >= nx && bcXmax == BCType3D::OUTFLOW_RIEMANN) nx_out = 1.0;
            else if (orig_gy < 0 && bcYmin == BCType3D::OUTFLOW_RIEMANN) ny_out = -1.0;
            else if (orig_gy >= ny && bcYmax == BCType3D::OUTFLOW_RIEMANN) ny_out = 1.0;
            else if (orig_gz < 0 && bcZmin == BCType3D::OUTFLOW_RIEMANN) nz_out = -1.0;
            else if (orig_gz >= nz && bcZmax == BCType3D::OUTFLOW_RIEMANN) nz_out = 1.0;

            double un_int = (double)s.ux * nx_out + (double)s.uy * ny_out + (double)s.uz * nz_out;

            double p_target = this->ambient_p;
            double rho_target = this->ambient_rho;
            bool is_water_target = this->is_water_tait_val;
            bool is_soil_target = false;

            if (this->stratified_params.enabled) {
                double z_c = this->zmin + ((double)orig_gz + 0.5) * this->cellSize;
                double g_mag = std::abs(this->stratified_params.gravity_z);
                if (g_mag < 1e-6) g_mag = 9.81;

                if (z_c > this->stratified_params.water_surface_z) {
                    p_target = this->stratified_params.p_atm;
                    rho_target = this->stratified_params.air_rho;
                    is_water_target = false;
                } else if (z_c >= this->stratified_params.seabed_surface_z) {
                    double p_h = 0.0, rho_h = 0.0, e_h = 0.0;
                    Blast::TaitEOSWater::compute_hydrostatic_state(
                        z_c, this->stratified_params.water_surface_z, g_mag, this->stratified_params.p_atm,
                        p_h, rho_h, e_h, this->stratified_params.tait_B, this->stratified_params.tait_gamma, this->stratified_params.tait_rho0
                    );
                    p_target = p_h;
                    rho_target = rho_h;
                    is_water_target = true;
                } else {
                    double p_bed = 0.0, rho_bed = 0.0, e_bed = 0.0;
                    Blast::TaitEOSWater::compute_hydrostatic_state(
                        this->stratified_params.seabed_surface_z, this->stratified_params.water_surface_z, g_mag, this->stratified_params.p_atm,
                        p_bed, rho_bed, e_bed, this->stratified_params.tait_B, this->stratified_params.tait_gamma, this->stratified_params.tait_rho0
                    );
                    double sig_v = 0.0, u_p = 0.0, sig_h = 0.0;
                    Blast::TaitEOSWater::compute_geostatic_stress(
                        z_c, this->stratified_params.seabed_surface_z, p_bed, this->stratified_params.soil_density, this->stratified_params.tait_rho0, g_mag, this->stratified_params.k0_earth_pressure,
                        sig_v, u_p, sig_h
                    );
                    p_target = sig_v;
                    double gamma_soil = this->stratified_params.soil_gamma > 0.0 ? this->stratified_params.soil_gamma : 4.0;
                    double rho0_soil = this->stratified_params.soil_density > 0.0 ? this->stratified_params.soil_density : 2000.0;
                    double c0_soil = this->stratified_params.soil_c0 > 0.0 ? this->stratified_params.soil_c0 : 2500.0;
                    double B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
                    double p0_soil = this->stratified_params.p_atm;
                    rho_target = Blast::TaitEOSWater::compute_density_isentropic(
                        sig_v, B_soil, gamma_soil, rho0_soil, p0_soil);
                    is_soil_target = true;
                    is_water_target = false;
                }
            }

            if (is_soil_target) {
                double gamma_soil = this->stratified_params.soil_gamma > 0.0 ? this->stratified_params.soil_gamma : 4.0;
                double rho0_soil = this->stratified_params.soil_density > 0.0 ? this->stratified_params.soil_density : 2000.0;
                double c0_soil = this->stratified_params.soil_c0 > 0.0 ? this->stratified_params.soil_c0 : 2500.0;
                double B_soil = (rho0_soil * c0_soil * c0_soil) / gamma_soil;
                double p0_soil = this->stratified_params.p_atm;
                double p_cav_soil = this->stratified_params.soil_p_cav != 0.0 ? this->stratified_params.soil_p_cav : -1.0e5;

                double c_soil = Blast::TaitEOSWater::compute_sound_speed_isentropic(
                    (double)s.rho, B_soil, gamma_soil, rho0_soil);
                double Z = (double)s.rho * c_soil;
                if (Z < 1.0e-3) Z = rho0_soil * c0_soil;

                double un_ghost = 0.5 * (un_int + ((double)s.p - p_target) / Z);
                double p_ghost = 0.5 * ((double)s.p + p_target + Z * un_int);
                if (p_ghost < p_cav_soil) p_ghost = p_cav_soil;

                double rho_ghost = Blast::TaitEOSWater::compute_density_isentropic(
                    p_ghost, B_soil, gamma_soil, rho0_soil, p0_soil);

                s.ux += (RealType)((un_ghost - un_int) * nx_out);
                s.uy += (RealType)((un_ghost - un_int) * ny_out);
                s.uz += (RealType)((un_ghost - un_int) * nz_out);
                s.p = (RealType)p_ghost;
                s.rho = (RealType)rho_ghost;

                double e_soil = Blast::TaitEOSWater::compute_energy_isentropic(
                    rho_ghost, B_soil, gamma_soil, rho0_soil);
                double ke_r = 0.5 * (double)s.rho * ((double)s.ux * (double)s.ux + (double)s.uy * (double)s.uy + (double)s.uz * (double)s.uz);
                s.E = (RealType)(rho_ghost * e_soil + ke_r);
            } else if (is_water_target || this->is_water_tait_val) {
                double c_w = Blast::TaitEOSWater::compute_sound_speed_dispatcher(
                    (double)s.rho, (double)s.p, this->tait_water_params, 0.0);
                double Z = (double)s.rho * c_w;
                if (Z < 1.0e-3) Z = 1.0e3 * 1482.0;

                double un_ghost = 0.5 * (un_int + ((double)s.p - p_target) / Z);
                double p_ghost = 0.5 * ((double)s.p + p_target + Z * un_int);
                if (p_ghost < this->tait_water_params.p_cav) p_ghost = this->tait_water_params.p_cav;

                double rho_ghost = Blast::TaitEOSWater::compute_density_isentropic(
                    p_ghost, this->tait_water_params.B, this->tait_water_params.gamma,
                    rho_target, this->tait_water_params.p0);

                s.ux += (RealType)((un_ghost - un_int) * nx_out);
                s.uy += (RealType)((un_ghost - un_int) * ny_out);
                s.uz += (RealType)((un_ghost - un_int) * nz_out);
                s.p = (RealType)p_ghost;
                s.rho = (RealType)rho_ghost;

                double e_w = Blast::TaitEOSWater::compute_energy_dispatcher(rho_ghost, p_ghost, this->tait_water_params);
                double ke_r = 0.5 * (double)s.rho * ((double)s.ux * (double)s.ux + (double)s.uy * (double)s.uy + (double)s.uz * (double)s.uz);
                s.E = (RealType)(rho_ghost * e_w + ke_r);
            } else {
                double gm1 = (double)gamma - 1.0;
                double c_int = std::sqrt((double)gamma * (double)s.p / std::max(1e-6, (double)s.rho));
                double c_atm = std::sqrt((double)gamma * p_target / std::max(1e-6, rho_target));

                double R_plus = un_int + 2.0 * c_int / gm1;
                double R_minus = - 2.0 * c_atm / gm1;
                double un_ghost = 0.5 * (R_plus + R_minus);
                double c_ghost = std::max(0.1, 0.25 * gm1 * (R_plus - R_minus));

                double c_ratio = c_ghost / c_atm;
                double rho_ghost = rho_target * std::pow(c_ratio, 2.0 / gm1);
                double p_ghost = p_target * std::pow(c_ratio, 2.0 * (double)gamma / gm1);

                s.ux += (RealType)((un_ghost - un_int) * nx_out);
                s.uy += (RealType)((un_ghost - un_int) * ny_out);
                s.uz += (RealType)((un_ghost - un_int) * nz_out);
                s.p = (RealType)p_ghost;
                s.rho = (RealType)rho_ghost;

                double ke_r = 0.5 * (double)s.rho * ((double)s.ux * (double)s.ux + (double)s.uy * (double)s.uy + (double)s.uz * (double)s.uz);
                s.E = (RealType)(p_ghost / gm1 + ke_r);
            }
        }
        return s;
    }
};

#endif

