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
    std::string shape; // "Sphere", "Cylinder", "Block"
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
};

template <bool IsMultiMaterial>
struct CellState3D {
    Real rho, ux, uy, uz, p, E, alpha1, alpha2, arho1, arho2;
};

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

    virtual void initializeFrom1D(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d, double x_expl, double y_expl, double z_expl, double R_remap) = 0;

    virtual void setCellStateMulti(int i, int j, int k, const CellState3D<true>& s) = 0;
    virtual void setCellStateIdeal(int i, int j, int k, const CellState3D<false>& s) = 0;
    virtual void commitStates() = 0;
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

template <bool IsMultiMaterial>
class CFDSolver3DImpl : public CFDSolver3DImplBase {
    std::vector<PrimitiveTile3D<IsMultiMaterial>> states_pool;
    std::vector<ConservativeTile3D<IsMultiMaterial>> U_pool;
    std::vector<bool> active_tiles;

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

    void initializeFrom1D(const std::vector<double>& r_1d, const std::vector<MultiMaterialState>& states_1d, double x_expl, double y_expl, double z_expl, double R_remap) override;

    void setCellStateMulti(int i, int j, int k, const CellState3D<true>& s) override;
    void setCellStateIdeal(int i, int j, int k, const CellState3D<false>& s) override;
    void commitStates() override;
    void setDetonatorLocation(double x, double y, double z) override;

private:
    void updateActiveRegions();
    void computeFluxes(double dt);
    void applyBC();
    bool checkTermination();
    CellState3D<IsMultiMaterial> sampleState(int i, int j, int k) const;
};

#endif
