#pragma once

#include "cfd_solver_3d.hpp"
#include "mpm_solver_3d.hpp"
#include "cfd_eos_water.hpp"
#include <vector>
#include <cmath>
#include <algorithm>
#include <iostream>
#include <memory>

namespace Blast {

// Configuration for zonal water-to-water handoff sleeve
struct ZonalHandoffConfig {
    double center_x{0.0};
    double center_y{0.0};
    double center_z{0.0};
    double sleeve_radius{0.15};      // R_sleeve (m)
    double overlap_thickness{0.03};  // Delta R_overlap (m)
    double p_ambient{101325.0};      // Ambient static pressure (Pa)
    double rho_ambient{1000.0};      // Ambient liquid density (kg/m^3)
    double c_sound{1482.0};          // Ambient water sound speed (m/s)
    int num_subcycles{5};            // Default subcycle count N_subcycles
    bool is_planar{false};           // Planar slice along X vs concentric spherical shell
};

// Configuration for Eulerian gas cavity to Lagrangian casing immersed boundary & venting
struct CavityCasingConfig {
    double center_x{0.0};
    double center_y{0.0};
    double center_z{0.0};
    double gas_radius{0.025};              // Initial gas core radius R_0 (m)
    double casing_inner_radius{0.025};     // Casing inner radius (m)
    double casing_outer_radius{0.028};     // Casing outer radius (m)
    double casing_length{0.050};           // Cylinder length L (m)
    double casing_density{8960.0};         // Metal casing density (kg/m^3)
    double gas_density{1600.0};            // High-pressure gas density (kg/m^3)
    double gas_specific_energy{4.5e6};     // Specific internal energy E_0 (J/kg)
    double gas_gamma{2.75};                // High-pressure gas expansion exponent (CJ / JWL equivalent)
    double venting_discharge_coeff{0.75};  // Orifice discharge coefficient C_d
    double rupture_strain{0.35};           // Tensile hoop failure strain
    double dynamic_fracture_energy{5.0e4}; // Fracture energy (J/m^2)
};

// Pre-allocated cell mapping descriptor (Directive 13: Zero allocations in hot step loops)
struct OverlapCellMapping {
    int ci{0}, cj{0}, ck{0};
    double x{0.0}, y{0.0}, z{0.0};
    double r{0.0};
    double weight{0.0}; // Hermite blend weight: 0.0 at R_inner, 1.0 at R_outer
};

class DynamicHybridCoupler3D {
public:
    DynamicHybridCoupler3D() = default;
    ~DynamicHybridCoupler3D() = default;

    // Initialize mapping and pre-allocate all hot-path buffers for water handoff
    void initialize(const ZonalHandoffConfig& config, CFDSolver3D* cfd, MPMSolver3D* mpm);

    // Initialize Eulerian gas cavity to Lagrangian casing immersed boundary coupling
    void initialize_cavity_casing(const CavityCasingConfig& config, CFDSolver3D* cfd, MPMSolver3D* mpm);

    // Orchestrate multi-rate subcycling time step
    void execute_subcycled_step(double dt_macro);

    // Two-way handoff routines
    void synchronize_feedback_fv_to_mpm(double dt_micro);
    void accumulate_handoff_fluxes(double dt_micro);
    void inject_accumulated_fluxes_into_cfd();

    // Cavity-to-casing immersed boundary and venting routines
    void couple_gas_cavity_to_casing(double dt);
    void evaluate_casing_rupture_and_venting(double dt);

    // Diagnostics and metric accessors (Phase 3 Zonal Handoff)
    const ZonalHandoffConfig& getConfig() const { return config_; }
    double getTransmissionCoeff() const { return transmission_coeff_; }
    double getReflectionRatio() const { return reflection_ratio_; }
    int getSubcycleCount() const { return actual_subcycles_; }
    size_t getOverlapCellCount() const { return cell_mappings_.size(); }

    void recordDiagnostics(double p_incident, double p_trans, double p_refl) {
        if (p_incident > 1.0e-3) {
            transmission_coeff_ = p_trans / p_incident;
            reflection_ratio_ = std::abs(p_refl) / p_incident;
        }
    }

    // Diagnostics and metric accessors (Phase 4 Cavity Casing & Gurney)
    const CavityCasingConfig& getCavityConfig() const { return cavity_config_; }
    double getCasingRadialVelocity() const { return current_casing_velocity_; }
    double getCasingRadius() const { return current_casing_radius_; }
    double getGurneyVelocity() const { return gurney_velocity_; }
    bool isCasingRuptured() const { return casing_ruptured_; }
    double getVentedGasMass() const { return vented_gas_mass_; }
    double getApertureArea() const { return aperture_area_; }
    double getMottCorrelationR2() const { return mott_r2_; }
    double getExpansionErrorL2() const {
        return std::abs(current_casing_velocity_ - gurney_velocity_) / (gurney_velocity_ + 1e-12);
    }

private:
    ZonalHandoffConfig config_;
    CavityCasingConfig cavity_config_;
    CFDSolver3D* cfd_{nullptr};
    MPMSolver3D* mpm_{nullptr};

    std::vector<OverlapCellMapping> cell_mappings_;
    std::vector<int> cell_to_map_index_;

    // Pre-allocated accumulators for thread-safe zero-allocation flux accumulation
    std::vector<double> accumulated_mass_flux_;
    std::vector<double> accumulated_mom_x_;
    std::vector<double> accumulated_mom_y_;
    std::vector<double> accumulated_mom_z_;
    std::vector<double> accumulated_energy_flux_;
    std::vector<int> sample_counts_;

    double transmission_coeff_{1.0};
    double reflection_ratio_{0.0};
    int actual_subcycles_{1};

    // Cavity-casing coupling state
    double current_casing_velocity_{0.0};
    double current_casing_radius_{0.025};
    double gurney_velocity_{0.0};
    bool casing_ruptured_{false};
    double vented_gas_mass_{0.0};
    double aperture_area_{0.0};
    double mott_r2_{1.0};
};

} // namespace Blast
