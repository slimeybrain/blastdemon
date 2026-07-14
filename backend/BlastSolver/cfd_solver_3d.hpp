#ifndef CFD_SOLVER_3D_HPP
#define CFD_SOLVER_3D_HPP

#include <vector>
#include <string>
#include <atomic>
#include <memory>
#include "materials.hpp"
#include "cfd_states.hpp"
#include "cfd_tile.hpp"

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
};

template <bool IsMultiMaterial>
struct CellState3D {
    Real rho, ux, uy, uz, p, E, alpha1, alpha2, arho1, arho2;
};

template <bool IsMultiMaterial>
inline double getPressure3D(double E_internal, double rho, const CellState3D<IsMultiMaterial>& s, double gamma, const MultiMat::JWLParams& products, const MultiMat::JWLParams& unreacted) {
    if constexpr (IsMultiMaterial) {
        return MultiMat::getMixturePressure(E_internal, rho, s.alpha1, s.alpha2, s.arho1, s.arho2, gamma, products, unreacted);
    } else {
        return E_internal * (gamma - 1.0);
    }
}

template <bool IsMultiMaterial>
inline double getSoundSpeed3D(double p, double rho, const CellState3D<IsMultiMaterial>& s, double gamma, const MultiMat::JWLParams& products, const MultiMat::JWLParams& unreacted) {
    if constexpr (IsMultiMaterial) {
        return MultiMat::getMixtureSoundSpeed(p, rho, s.alpha1, s.alpha2, s.arho1, s.arho2, gamma, products, unreacted);
    } else {
        return std::sqrt(gamma * p / std::max(1e-6, rho));
    }
}

template <bool IsMultiMaterial>
inline double getEnergy3D(double p, double rho, const CellState3D<IsMultiMaterial>& s, double gamma, const MultiMat::JWLParams& products, const MultiMat::JWLParams& unreacted) {
    if constexpr (IsMultiMaterial) {
        return MultiMat::getMixtureEnergy(p, rho, s.alpha1, s.alpha2, s.arho1, s.arho2, gamma, products, unreacted);
    } else {
        return p / (gamma - 1.0);
    }
}

class CFDSolver3D {
public:
    virtual ~CFDSolver3D() = default;

    virtual void setInitialCondition(const Charge3DParams& charge, const MultiMat::MaterialSet& materials, double ambient_rho, double ambient_p) = 0;
    virtual void setDetonatorLocation(double x, double y, double z) = 0;
    virtual void setBoundaryConditions(BCType3D xmin, BCType3D xmax, BCType3D ymin, BCType3D ymax, BCType3D zmin, BCType3D zmax) = 0;
    virtual void setFluxScheme(const std::string& scheme_name) = 0;
    virtual void setSpatialOrder(int order) = 0;
    virtual void setTemporalOrder(int order) = 0;
    virtual void setCancelFlag(std::atomic<bool>* flag) = 0;
    virtual void setProgressRef(std::atomic<int>* ref) = 0;

    virtual void step(double dt) = 0;
    virtual double computeStepSize(double cfl = 0.4) const = 0;
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

    virtual std::vector<float> sampleGauge(const Gauge3D& gauge) const = 0;
    virtual std::vector<float> extractSlice(const Slice3D& slice) const = 0;
    virtual std::vector<float> getCellValues(int i, int j, int k) const = 0;

    virtual void initializeFrom1D(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d, double x_expl, double y_expl, double z_expl, double R_remap) = 0;

    virtual void setCellStateMulti(int i, int j, int k, const CellState3D<true>& s) = 0;
    virtual void setCellStateIdeal(int i, int j, int k, const CellState3D<false>& s) = 0;
    virtual void commitStates() = 0;

    virtual bool isIdealGas() const = 0;
    virtual const MultiMat::MaterialSet& getMaterialParameters() const = 0;
    virtual double getAmbientP() const = 0;
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
    bool is_terminated() const override { return terminated; }
    double getGamma() const override { return gamma; }
    void setGamma(double g) { gamma = g; }
};

template <typename RealType, bool IsMultiMaterial>
class CFDSolver3DImpl : public CFDSolver3DImplBase {
    std::vector<PrimitiveTile3D<RealType, IsMultiMaterial>> states_pool;
    std::vector<ConservativeTile3D<RealType, IsMultiMaterial>> U_pool;
    std::vector<ConservativeTile3D<RealType, IsMultiMaterial>> U_prev_pool;
    std::vector<uint8_t> active_tiles;

    int n_tiles_x, n_tiles_y, n_tiles_z;

public:
    CFDSolver3DImpl(int nx, int ny, int nz, double cellSize, double xmin = 0, double ymin = 0, double zmin = 0);

    void setInitialCondition(const Charge3DParams& charge, const MultiMat::MaterialSet& materials, double ambient_rho, double ambient_p) override;
    void setFluxScheme(const std::string& scheme_name) override;
    void setSpatialOrder(int order) override;
    void setTemporalOrder(int order) override;

    void step(double dt) override;
    double computeStepSize(double cfl = 0.4) const override;

    std::vector<float> sampleGauge(const Gauge3D& gauge) const override;
    std::vector<float> extractSlice(const Slice3D& slice) const override;
    std::vector<float> getCellValues(int i, int j, int k) const override;

    void initializeFrom1D(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d, double x_expl, double y_expl, double z_expl, double R_remap) override;

    void setCellStateMulti(int i, int j, int k, const CellState3D<true>& s) override;
    void setCellStateIdeal(int i, int j, int k, const CellState3D<false>& s) override;
    void commitStates() override;
    void setDetonatorLocation(double x, double y, double z) override;
    
    const std::vector<PrimitiveTile3D<RealType, IsMultiMaterial>>& getStatesPool() const { return states_pool; }
    const std::vector<ConservativeTile3D<RealType, IsMultiMaterial>>& getUPool() const { return U_pool; }
    const std::vector<uint8_t>& getActiveTiles() const { return active_tiles; }

private:
    void updateActiveRegions();
    void computeFluxes(double dt);
    void applyBC();
    void applyProgrammedBurn(double dt);
    void updatePrimitiveFromConservative();
    bool checkTermination();
public:
    template <typename RT, bool MM>
    struct CellState3DT {
        RT rho, ux, uy, uz, p, E, alpha1, alpha2, arho1, arho2;
    };

    inline CellState3DT<RealType, IsMultiMaterial> sampleStateInternal(int gx, int gy, int gz) const {
        bool reflective_x = false, reflective_y = false, reflective_z = false;

        applyBC3DHelper(gx, nx, bcXmin, bcXmax, reflective_x);
        applyBC3DHelper(gy, ny, bcYmin, bcYmax, reflective_y);
        applyBC3DHelper(gz, nz, bcZmin, bcZmax, reflective_z);

        gx = std::clamp(gx, 0, nx - 1);
        gy = std::clamp(gy, 0, ny - 1);
        gz = std::clamp(gz, 0, nz - 1);

        int t_idx = (gx >> 3) + (gy >> 3) * n_tiles_x + (gz >> 3) * n_tiles_x * n_tiles_y;
        const auto& tile = states_pool[t_idx];
        int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

        CellState3DT<RealType, IsMultiMaterial> s;
        s.p = tile.p[c_idx]; s.rho = tile.rho[c_idx]; s.E = tile.E[c_idx];
        s.ux = reflective_x ? -tile.ux[c_idx] : tile.ux[c_idx];
        s.uy = reflective_y ? -tile.uy[c_idx] : tile.uy[c_idx];
        s.uz = reflective_z ? -tile.uz[c_idx] : tile.uz[c_idx];

        if constexpr (IsMultiMaterial) {
            s.alpha1 = tile.alpha1[c_idx]; s.alpha2 = tile.alpha2[c_idx];
            s.arho1 = tile.arho1[c_idx]; s.arho2 = tile.arho2[c_idx];
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
        bool reflective_x = false, reflective_y = false, reflective_z = false;

        applyBC3DHelper(gx, nx, bcXmin, bcXmax, reflective_x);
        applyBC3DHelper(gy, ny, bcYmin, bcYmax, reflective_y);
        applyBC3DHelper(gz, nz, bcZmin, bcZmax, reflective_z);

        gx = std::clamp(gx, 0, nx - 1);
        gy = std::clamp(gy, 0, ny - 1);
        gz = std::clamp(gz, 0, nz - 1);

        int t_idx = (gx >> 3) + (gy >> 3) * n_tiles_x + (gz >> 3) * n_tiles_x * n_tiles_y;
        const auto& tile = states_pool[t_idx];
        int c_idx = (gx & 7) + (gy & 7) * 8 + (gz & 7) * 64;

        CellState3D<IsMultiMaterial> s;
        s.p = (double)tile.p[c_idx]; s.rho = (double)tile.rho[c_idx]; s.E = (double)tile.E[c_idx];
        s.ux = reflective_x ? -(double)tile.ux[c_idx] : (double)tile.ux[c_idx];
        s.uy = reflective_y ? -(double)tile.uy[c_idx] : (double)tile.uy[c_idx];
        s.uz = reflective_z ? -(double)tile.uz[c_idx] : (double)tile.uz[c_idx];

        if constexpr (IsMultiMaterial) {
            s.alpha1 = (double)tile.alpha1[c_idx]; s.alpha2 = (double)tile.alpha2[c_idx];
            s.arho1 = (double)tile.arho1[c_idx]; s.arho2 = (double)tile.arho2[c_idx];
        }
        return s;
    }
};

#endif
