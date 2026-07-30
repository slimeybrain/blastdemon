#ifndef SUBMESH_3D_HPP
#define SUBMESH_3D_HPP

#include <vector>
#include <memory>
#include <string>
#include <cmath>
#include <algorithm>
#include "cfd_states.hpp"
#include "materials.hpp"
#include "cfd_solver_3d.hpp"

template <typename RealType, bool IsMultiMaterial>
struct SubMeshCellState3D {
    RealType rho, ux, uy, uz, p, E;
    RealType alpha1, alpha2, arho1, arho2;
    RealType peak_overpressure, peak_impulse;
};

template <typename RealType, bool IsMultiMaterial>
class SubMesh3D {
public:
    std::string id;
    // ID of direct parent: "root" means the domain root mesh, otherwise another submesh ID
    std::string parent_id;
    int level;
    
    // Physical bounds
    RealType xmin, xmax;
    RealType ymin, ymax;
    RealType zmin, zmax;
    
    // Grid resolution
    int nx, ny, nz;
    RealType cellSize;
    
    // State buffers (flat 3D linear memory: i + j*nx + k*nx*ny)
    std::vector<RealType> rho;
    std::vector<RealType> ux;
    std::vector<RealType> uy;
    std::vector<RealType> uz;
    std::vector<RealType> p;
    std::vector<RealType> E;
    
    // RK2 buffers
    std::vector<RealType> rk_rho;
    std::vector<RealType> rk_ux;
    std::vector<RealType> rk_uy;
    std::vector<RealType> rk_uz;
    std::vector<RealType> rk_p;
    std::vector<RealType> rk_E;
    
    std::vector<RealType> peak_overpressure;
    std::vector<RealType> peak_impulse;
    
    // Multi-material buffers (only allocated if IsMultiMaterial == true)
    std::vector<RealType> alpha1;
    std::vector<RealType> alpha2;
    std::vector<RealType> arho1;
    std::vector<RealType> arho2;

    std::vector<RealType> rk_alpha1;
    std::vector<RealType> rk_alpha2;
    std::vector<RealType> rk_arho1;
    std::vector<RealType> rk_arho2;

    // Geometry boundary flags (0 = fluid, 1 = solid obstacle)
    std::vector<uint8_t> is_boundary;

    // Initialization flag
    bool is_initialized = false;

    SubMesh3D(const std::string& submesh_id, int level, RealType xmin, RealType ymin, RealType zmin, RealType size_x, RealType size_y, RealType size_z, RealType cellSize, const std::string& parent_id = "root")
        : id(submesh_id), parent_id(parent_id), level(level), xmin(xmin), ymin(ymin), zmin(zmin), cellSize(cellSize), is_initialized(false) {
        xmax = xmin + size_x;
        ymax = ymin + size_y;
        zmax = zmin + size_z;
        
        nx = std::max(4, static_cast<int>(std::round(size_x / cellSize)));
        ny = std::max(4, static_cast<int>(std::round(size_y / cellSize)));
        nz = std::max(4, static_cast<int>(std::round(size_z / cellSize)));
        
        size_t total_cells = static_cast<size_t>(nx) * ny * nz;
        rho.resize(total_cells, static_cast<RealType>(1.225));
        ux.resize(total_cells, static_cast<RealType>(0.0));
        uy.resize(total_cells, static_cast<RealType>(0.0));
        uz.resize(total_cells, static_cast<RealType>(0.0));
        p.resize(total_cells, static_cast<RealType>(101325.0));
        E.resize(total_cells, static_cast<RealType>(101325.0 / 0.4));
        
        rk_rho.resize(total_cells, static_cast<RealType>(1.225));
        rk_ux.resize(total_cells, static_cast<RealType>(0.0));
        rk_uy.resize(total_cells, static_cast<RealType>(0.0));
        rk_uz.resize(total_cells, static_cast<RealType>(0.0));
        rk_p.resize(total_cells, static_cast<RealType>(101325.0));
        rk_E.resize(total_cells, static_cast<RealType>(101325.0 / 0.4));
        
        peak_overpressure.resize(total_cells, static_cast<RealType>(0.0));
        peak_impulse.resize(total_cells, static_cast<RealType>(0.0));
        is_boundary.resize(total_cells, 0);

        if constexpr (IsMultiMaterial) {
            alpha1.resize(total_cells, static_cast<RealType>(0.0));
            alpha2.resize(total_cells, static_cast<RealType>(0.0));
            arho1.resize(total_cells, static_cast<RealType>(0.0));
            arho2.resize(total_cells, static_cast<RealType>(0.0));
            
            rk_alpha1.resize(total_cells, static_cast<RealType>(0.0));
            rk_alpha2.resize(total_cells, static_cast<RealType>(0.0));
            rk_arho1.resize(total_cells, static_cast<RealType>(0.0));
            rk_arho2.resize(total_cells, static_cast<RealType>(0.0));
        }
    }

    inline size_t getIndex(int i, int j, int k) const {
        return static_cast<size_t>(i) + static_cast<size_t>(j) * nx + static_cast<size_t>(k) * nx * ny;
    }

    inline bool containsPoint(RealType x, RealType y, RealType z) const {
        return (x >= xmin && x <= xmax && y >= ymin && y <= ymax && z >= zmin && z <= zmax);
    }

    inline bool containsInteriorPoint(RealType x, RealType y, RealType z) const {
        RealType ghost_margin = static_cast<RealType>(2.0) * cellSize;
        return (x >= xmin + ghost_margin && x <= xmax - ghost_margin &&
                y >= ymin + ghost_margin && y <= ymax - ghost_margin &&
                z >= zmin + ghost_margin && z <= zmax - ghost_margin);
    }

    inline RealType getValue(const std::string& qty, size_t idx) const {
        if (idx >= rho.size()) return static_cast<RealType>(0.0);
        if (qty == "solid" || qty == "solid_cells") return is_boundary[idx] ? static_cast<RealType>(1.0) : static_cast<RealType>(0.0);
        if (qty == "density" || qty == "rho") return rho[idx];
        if (qty == "velocity" || qty == "speed") return std::sqrt(ux[idx]*ux[idx] + uy[idx]*uy[idx] + uz[idx]*uz[idx]);
        if (qty == "energy" || qty == "internal_energy") return E[idx] / std::max(rho[idx], static_cast<RealType>(1e-6));
        if constexpr (IsMultiMaterial) {
            if (!alpha1.empty()) {
                if (qty == "species1" || qty == "alpha1") return alpha1[idx];
                if (qty == "species2" || qty == "alpha2") return alpha2[idx];
                if (qty == "species3") return static_cast<RealType>(1.0) - alpha1[idx] - alpha2[idx];
            }
        }
        if (qty == "overpressure" || qty == "peak_overpressure") return peak_overpressure[idx];
        if (qty == "impulse" || qty == "peak_impulse") return peak_impulse[idx];
        return p[idx];
    }
};

#endif // SUBMESH_3D_HPP
