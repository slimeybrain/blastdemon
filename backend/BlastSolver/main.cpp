#include <poll.h>
#include <unistd.h>
#include <sys/resource.h>
#if defined(__linux__)
#include <malloc.h>
#endif
#include <iostream>
#include <string>
#include <vector>
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <cmath>
#include <limits>
#include <memory>
#include <thread>
#include <atomic>
#include <future>
#include <mutex>
#include <chrono>
#include <fstream>
#include <dlfcn.h>
#include <queue>
#include <condition_variable>

#include <omp.h>
#include <nlohmann/json.hpp>
#include "SolverState.hpp"
#include "GaugeService.hpp"
#include "VTKService.hpp"
#include "TelemetryService.hpp"

using json = nlohmann::json;
#include "PrimitiveGeometry.hpp"
#include "PrimitiveGeometryParser.hpp"
#include "ImmersedBoundary.hpp"
#include <set>
#include <unordered_map>
#include <filesystem>
#include "system_memory_guard.hpp"
#include "cfd_solver.hpp"
#include "cfd_solver_2d.hpp"
#include "cfd_solver_2d_cuda.hpp"
#include "cfd_solver_2d_amr.hpp"
#include "cfd_solver_2d_amr_cuda.hpp"
#include "cfd_solver_3d.hpp"
#include "cfd_solver_3d_cuda.hpp"
#include "HDF5Writer.hpp"
#include "XDMFWriter.hpp"
#include "VTKWriter.hpp"
#include "AsyncVTKWriter.hpp"
#include "PhaseTrackingParticles3D.hpp"
#include "mpm_solver_2d.hpp"
#include "mpm_solver_3d.hpp"
#include "mpm_solver_3d_cuda.hpp"
#include "fsi_coupler_3d.hpp"
#include "fem_solver_3d.hpp"
#include "fem_solver_3d_cuda.hpp"
#include "ls_dyna_reader_3d.hpp"
#include "fem_contact_3d.hpp"
#include "fem_fsi_coupler_3d.hpp"
#include "fem_fsi_coupler_3d_cuda.hpp"
#include <unordered_set>

inline void parse_cfd_space_time_scheme(const nlohmann::json& j, int& spatial_order, int& temporal_order, int default_t_order = 4) {
    if (j.contains("space_time_scheme") && !j["space_time_scheme"].is_null()) {
        std::string sts = j["space_time_scheme"].is_string() ? j["space_time_scheme"].get<std::string>() : "";
        if (sts == "ADER-2 (2nd-Order Space/Time)") {
            spatial_order = 2;
            temporal_order = (default_t_order == 2) ? 2 : 5;
            return;
        } else if (sts == "ADER-3 (3rd-Order Space/Time)") {
            spatial_order = 3;
            temporal_order = (default_t_order == 2) ? 3 : 6;
            return;
        } else if (sts == "MUSCL-Hancock (2nd-Order Space/Time)") {
            spatial_order = 2;
            temporal_order = default_t_order;
            return;
        }
    }
    spatial_order = get_json_int(j, "spatial_order", spatial_order);
    temporal_order = get_json_int(j, "temporal_order", temporal_order);
}

// Single source of truth for the water Tait EOS used by the FV solver. The zonal MPM sleeve
// adopts exactly these parameters (see align_sleeve_tait_with_fv) so both discretisations
// represent the same material.
inline Blast::TaitEOSParams parse_cfd_tait_params(const nlohmann::json& msg) {
    Blast::TaitEOSParams twp;
    twp.B = get_json_double(msg, "tait_B", 3.039e8);
    twp.gamma = get_json_double(msg, "tait_gamma", 7.15);
    twp.rho0 = get_json_double(msg, "tait_rho0", 1000.0);
    twp.c0 = get_json_double(msg, "tait_c0", 1482.0);
    twp.p_cav = get_json_double(msg, "tait_p_cav", -1.0e5);
    twp.gruneisen = get_json_double(msg, "tait_gruneisen", 0.28);
    twp.p0 = get_json_double(msg, "atm_pressure", get_json_double(msg, "p_atm", 101325.0));
    int v_int = get_json_int(msg, "tait_variant", 1);
    if (msg.contains("tait_variant_str")) {
        std::string vs = msg.value("tait_variant_str", "");
        if (vs == "CaloricGruneisen" || vs == "Caloric" || vs == "NearField") v_int = 1;
        else if (vs == "ShockHugoniot" || vs == "Hugoniot") v_int = 2;
        else if (vs == "Isentropic") v_int = 0;
    }
    twp.variant = static_cast<Blast::TaitVariant>(v_int);
    return twp;
}

inline void apply_cfd_tait_config(const nlohmann::json& msg, CFDSolver3D* solver) {
    if (!solver) return;
    bool is_water = get_json_bool(msg, "is_water", false) ||
                    (msg.value("medium_type", "") == "Water") ||
                    (msg.value("fluid_type", "") == "Water") ||
                    (msg.value("eos_type", "") == "Tait") ||
                    (msg.value("eos_type", "") == "TaitWater") ||
                    (msg.value("material", "") == "Water (Tait)") ||
                    (msg.value("init_mode", "") == "Hydrostatic_Stratified_3D") ||
                    (msg.value("init_mode", "") == "hydrostatic_stratified_3d") ||
                    msg.contains("water_surface_z");
    if (is_water) {
        Blast::TaitEOSParams twp = parse_cfd_tait_params(msg);
        solver->setWaterTait(true);
        solver->setTaitParams(twp);
        std::cout << "[BlastSolver] Configured Tait Water EOS for CFDSolver3D: B=" << twp.B
                  << ", gamma=" << twp.gamma << ", rho0=" << twp.rho0 << ", variant=" << static_cast<int>(twp.variant) << std::endl;
    }
}

// Zonal MPM sleeve <-> FV coupling requires both sides to model the SAME water: any mismatch in
// B, gamma, rho0, p0, p_cav, Gruneisen or EOS variant changes the acoustic impedance and wave speed
// across the interface, so waves partially reflect off the sleeve as if it were a different material.
// The FV Tait parameters are the single source of truth; every TaitWater MPM object adopts them.
// Applied to the object JSON BEFORE particles are generated, so particle mass (density * V0) and the
// EOS reference density rho0 remain consistent (hydrostatic equilibrium is preserved).
inline void align_sleeve_tait_with_fv(nlohmann::json& msg) {
    if (!msg.contains("mpm_objects") || !msg["mpm_objects"].is_array()) return;
    const Blast::TaitEOSParams twp = parse_cfd_tait_params(msg);
    const char* vstr = (twp.variant == Blast::TaitVariant::CaloricGruneisen) ? "CaloricGruneisen"
                     : (twp.variant == Blast::TaitVariant::ShockHugoniot) ? "ShockHugoniot" : "Isentropic";
    for (auto& obj : msg["mpm_objects"]) {
        if (obj.value("material_model", std::string()) != "TaitWater") continue;
        std::ostringstream os;
        os << "[BlastSolver] Zonal sleeve '" << obj.value("name", std::string("TaitWater")) << "': MPM water EOS set from FV water"
           << " (B " << get_json_double(obj, "tait_B", 0.0) << " -> " << twp.B
           << ", gamma " << get_json_double(obj, "tait_gamma", 0.0) << " -> " << twp.gamma
           << ", rho0 " << get_json_double(obj, "tait_rho0", 0.0) << " -> " << twp.rho0
           << ", p0 " << get_json_double(obj, "tait_p0", 0.0) << " -> " << twp.p0
           << ", variant " << obj.value("tait_variant_str", std::string("?")) << " -> " << vstr << ")";
        std::cout << os.str() << std::endl;
        obj["tait_B"] = twp.B;
        obj["tait_gamma"] = twp.gamma;
        obj["tait_rho0"] = twp.rho0;
        obj["density"] = twp.rho0;
        obj["tait_c0"] = twp.c0;
        obj["tait_p_cav"] = twp.p_cav;
        obj["tait_p0"] = twp.p0;
        obj["tait_gruneisen"] = twp.gruneisen;
        obj["tait_variant"] = static_cast<int>(twp.variant);
        obj["tait_variant_str"] = vstr;
    }
}

inline Blast::Stratified3DParams parse_stratified_params(const nlohmann::json& msg, double ambient_rho, [[maybe_unused]] double ambient_p) {
    Blast::Stratified3DParams strat;
    strat.enabled = true;
    strat.water_surface_z = get_json_double(msg, "water_surface_z", 10.0);
    strat.seabed_surface_z = get_json_double(msg, "seabed_surface_z", 2.0);
    strat.k0_earth_pressure = get_json_double(msg, "k0_earth_pressure", 0.50);
    strat.gravity_z = get_json_double(msg, "gravity_z", get_json_double(msg, "gz", -9.81));
    const Blast::TaitEOSParams twp = parse_cfd_tait_params(msg);
    strat.tait_B = twp.B;
    strat.tait_gamma = twp.gamma;
    strat.tait_rho0 = twp.rho0;
    strat.air_rho = get_json_double(msg, "air_rho", ambient_rho);
    strat.p_atm = twp.p0;
    strat.soil_density = get_json_double(msg, "soil_density", get_json_double(msg, "seabed_density", 2000.0));
    strat.soil_friction_angle = get_json_double(msg, "soil_friction_angle", get_json_double(msg, "seabed_friction_angle", 30.0));
    strat.soil_cohesion = get_json_double(msg, "soil_cohesion", get_json_double(msg, "seabed_cohesion", 0.0));
    strat.soil_c0 = get_json_double(msg, "soil_c0", get_json_double(msg, "seabed_c0", 2500.0));
    strat.soil_gamma = get_json_double(msg, "soil_gamma", get_json_double(msg, "seabed_gamma", 4.0));
    strat.soil_s = get_json_double(msg, "soil_s", get_json_double(msg, "seabed_s", 1.35));
    strat.soil_gruneisen = get_json_double(msg, "soil_gruneisen", get_json_double(msg, "seabed_gruneisen", 1.45));
    strat.soil_p_cav = get_json_double(msg, "soil_p_cav", get_json_double(msg, "seabed_p_cav", -1.0e5));
    strat.soil_eos_variant = get_json_int(msg, "soil_eos_variant", get_json_int(msg, "seabed_eos_variant", 0));
    strat.initial_temperature = get_json_double(msg, "initial_temperature", 288.15);
    strat.water_temperature = get_json_double(msg, "water_temperature", get_json_double(msg, "initial_temperature", 288.15));
    strat.soil_temperature  = get_json_double(msg, "soil_temperature",  get_json_double(msg, "initial_temperature", 288.15));
    strat.air_temperature   = get_json_double(msg, "air_temperature",   get_json_double(msg, "atm_temperature", get_json_double(msg, "initial_temperature", 288.15)));
    return strat;
}

inline Blast::MPMMaterialModel parseMPMMaterialModel(const std::string& mat_model_str) {
    if (mat_model_str == "Linear Elastic" || mat_model_str == "LinearElastic" || mat_model_str == "Elastic") {
        return Blast::MPMMaterialModel::LinearElastic;
    } else if (mat_model_str == "Johnson-Cook + Mie-Grüneisen" || mat_model_str == "Johnson-Cook + Mie-Gruneisen" ||
               mat_model_str == "Johnson-Cook" || mat_model_str == "JohnsonCook" || mat_model_str == "JohnsonCookMieGruneisen") {
        return Blast::MPMMaterialModel::JohnsonCookMieGruneisen;
    } else if (mat_model_str == "JWL Programmed Burn" || mat_model_str == "JWLProgrammedBurn" || mat_model_str == "Programmed Burn" ||
               mat_model_str == "ProgrammedBurn" || mat_model_str == "Programmed Wavefront Burn" || mat_model_str == "JWL" ||
               mat_model_str == "JWL Charge" || mat_model_str == "JWL Detonation Gas") {
        return Blast::MPMMaterialModel::JWLProgrammedBurn;
    } else if (mat_model_str == "Lee-Tarver Ignition & Growth" || mat_model_str == "Lee-Tarver" || mat_model_str == "LeeTarver" ||
               mat_model_str == "LeeTarverIgnitionGrowth" || mat_model_str == "Ignition & Growth" || mat_model_str == "Ignition and Growth") {
        return Blast::MPMMaterialModel::LeeTarverIgnitionGrowth;
    } else if (mat_model_str == "CREST Reactive Burn" || mat_model_str == "CRESTReactiveBurn" || mat_model_str == "CREST" || mat_model_str == "Davis" || mat_model_str == "CREST (Davis EOS)" ||
               mat_model_str == "CREST Reactive High Explosive" || mat_model_str == "Ideal Gas Charge" || mat_model_str == "High Explosive" || mat_model_str == "Explosive") {
        return Blast::MPMMaterialModel::CRESTReactiveBurn;
    } else if (mat_model_str == "RHT Concrete" || mat_model_str == "RHT") {
        return Blast::MPMMaterialModel::RHTConcrete;
    } else if (mat_model_str == "Karagozian & Case (K&C)" || mat_model_str == "K&C" || mat_model_str == "KC Concrete" || mat_model_str == "Karagozian & Case") {
        return Blast::MPMMaterialModel::KCConcrete;
    } else if (mat_model_str == "CSCM Concrete" || mat_model_str == "CSCM") {
        return Blast::MPMMaterialModel::CSCMConcrete;
    } else if (mat_model_str == "Hyperelastic (Yeoh)" || mat_model_str == "Yeoh" || mat_model_str == "HyperelasticYeoh" || mat_model_str == "Hyperelastic") {
        return Blast::MPMMaterialModel::HyperelasticYeoh;
    } else if (mat_model_str == "Hyperelastic (Mooney-Rivlin)" || mat_model_str == "Mooney-Rivlin" || mat_model_str == "MooneyRivlin" || mat_model_str == "HyperelasticMooneyRivlin") {
        return Blast::MPMMaterialModel::HyperelasticMooneyRivlin;
    } else if (mat_model_str == "Concrete Damage Plasticity (CDP)" || mat_model_str == "CDP" || mat_model_str == "Concrete Damage Plasticity" || mat_model_str == "ConcreteDamagePlasticity") {
        return Blast::MPMMaterialModel::ConcreteDamagePlasticity;
    } else if (mat_model_str == "Hill48 Orthotropic" || mat_model_str == "Hill48" || mat_model_str == "Hill48Orthotropic" || mat_model_str == "Hill 48") {
        return Blast::MPMMaterialModel::Hill48Orthotropic;
    } else if (mat_model_str == "Tait Water" || mat_model_str == "TaitWater" || mat_model_str == "Tait" || mat_model_str == "Water (Tait)" || mat_model_str == "Water") {
        return Blast::MPMMaterialModel::TaitWater;
    } else if (mat_model_str == "Drucker-Prager" || mat_model_str == "DruckerPrager" ||
               mat_model_str == "Mohr-Coulomb" || mat_model_str == "MohrCoulomb" ||
               mat_model_str == "Drucker-Prager Soil" || mat_model_str == "DruckerPragerSoil" ||
               mat_model_str == "Soil" || mat_model_str == "Rock" || mat_model_str == "Geomaterial") {
        return Blast::MPMMaterialModel::DruckerPragerSoil;
    } else {
        return Blast::MPMMaterialModel::Hypoelastic;
    }
}

inline Blast::MaterialTable3D parseMaterialTable3D(const nlohmann::json& obj) {
    Blast::MaterialTable3D mat;
    std::string mat_model_str = obj.value("material_model", "Hypoelastic");
    mat.material_model = parseMPMMaterialModel(mat_model_str);
    // Fail-safe: if model is still Hypoelastic but the preset/category indicates an energetic solid,
    // auto-promote to CRESTReactiveBurn to prevent silent inert detonation failure.
    if (mat.material_model == Blast::MPMMaterialModel::Hypoelastic) {
        std::string preset_name = obj.value("preset", "");
        std::string category    = obj.value("category", "");
        auto contains_ci = [](const std::string& s, const std::string& sub) {
            std::string sl = s, subl = sub;
            std::transform(sl.begin(), sl.end(), sl.begin(), ::tolower);
            std::transform(subl.begin(), subl.end(), subl.begin(), ::tolower);
            return sl.find(subl) != std::string::npos;
        };
        bool is_energetic = contains_ci(category, "energetic solids") ||
                            contains_ci(category, "crest reactive") ||
                            contains_ci(preset_name, "crest davis") ||
                            contains_ci(preset_name, "unreacted") ||
                            contains_ci(preset_name, "pbx") ||
                            contains_ci(preset_name, "rdx") ||
                            contains_ci(preset_name, "hmx") ||
                            contains_ci(preset_name, "tatb") ||
                            contains_ci(preset_name, "lx-") ||
                            contains_ci(preset_name, "c-4") ||
                            contains_ci(preset_name, "comp b") ||
                            contains_ci(preset_name, "composition b") ||
                            contains_ci(preset_name, "anfo") ||
                            contains_ci(preset_name, "petn") ||
                            contains_ci(preset_name, "tnt") ||
                            contains_ci(preset_name, "nitromethane");
        if (is_energetic) {
            mat.material_model = Blast::MPMMaterialModel::CRESTReactiveBurn;
            std::cerr << "[BlastSolver] [WARN] material_model was 'Hypoelastic' but preset='" << preset_name
                      << "' / category='" << category << "' indicates an energetic solid. "
                      << "Auto-promoted to 'CREST Reactive Burn'. Please set material_model explicitly in the UI." << std::endl;
        } else {
            bool is_water = contains_ci(category, "water") || contains_ci(category, "fluid") ||
                            contains_ci(preset_name, "water") || contains_ci(preset_name, "seawater");
            if (is_water) {
                mat.material_model = Blast::MPMMaterialModel::TaitWater;
                std::cout << "[BlastSolver] Detected water/fluid preset '" << preset_name
                          << "': assigned MPMMaterialModel::TaitWater." << std::endl;
            }
        }
    }

    // Three-Pillar Energetic Material Architecture defaults
    if (mat.material_model == Blast::MPMMaterialModel::CRESTReactiveBurn) {
        mat.solid_model = Blast::SolidReactantEOS::DavisSolid;
        mat.burn_model = Blast::ReactionKinetics::CRESTEntropy;
        mat.product_model = Blast::DetonationProductEOS::DavisProduct;
    } else if (mat.material_model == Blast::MPMMaterialModel::LeeTarverIgnitionGrowth) {
        mat.solid_model = Blast::SolidReactantEOS::MieGruneisen;
        mat.burn_model = Blast::ReactionKinetics::LeeTarverODE;
        mat.product_model = Blast::DetonationProductEOS::JWLProductGas;
    } else if (mat.material_model == Blast::MPMMaterialModel::JWLProgrammedBurn) {
        mat.solid_model = Blast::SolidReactantEOS::MieGruneisen;
        mat.burn_model = Blast::ReactionKinetics::ProgrammedBurn;
        mat.product_model = Blast::DetonationProductEOS::JWLProductGas;
    }

    // Explicit Three-Pillar overrides from JSON configuration
    std::string solid_str = obj.value("solid_model", "");
    std::string burn_str = obj.value("burn_model", "");
    std::string prod_str = obj.value("product_model", "");

    if (!solid_str.empty()) {
        if (solid_str.find("Davis") != std::string::npos) mat.solid_model = Blast::SolidReactantEOS::DavisSolid;
        else if (solid_str.find("Mie") != std::string::npos || solid_str.find("Gruneisen") != std::string::npos || solid_str.find("Grüneisen") != std::string::npos) mat.solid_model = Blast::SolidReactantEOS::MieGruneisen;
    }
    if (!burn_str.empty()) {
        if (burn_str.find("CREST") != std::string::npos) mat.burn_model = Blast::ReactionKinetics::CRESTEntropy;
        else if (burn_str.find("Lee-Tarver") != std::string::npos || burn_str.find("LeeTarver") != std::string::npos || burn_str.find("ODE") != std::string::npos) mat.burn_model = Blast::ReactionKinetics::LeeTarverODE;
        else if (burn_str.find("Programmed") != std::string::npos || burn_str.find("Wavefront") != std::string::npos) mat.burn_model = Blast::ReactionKinetics::ProgrammedBurn;
    }
    if (!prod_str.empty()) {
        if (prod_str.find("Davis") != std::string::npos) mat.product_model = Blast::DetonationProductEOS::DavisProduct;
        else if (prod_str.find("JWL") != std::string::npos) mat.product_model = Blast::DetonationProductEOS::JWLProductGas;
    }

    if (mat.material_model == Blast::MPMMaterialModel::Hypoelastic && (!solid_str.empty() || !burn_str.empty() || !prod_str.empty())) {
        mat.material_model = Blast::MPMMaterialModel::JWLProgrammedBurn;
    }

    mat.density = static_cast<float>(get_json_double(obj, "density", 7850.0));
    if ((mat.material_model == Blast::MPMMaterialModel::JWLProgrammedBurn ||
         mat.material_model == Blast::MPMMaterialModel::CRESTReactiveBurn ||
         mat.material_model == Blast::MPMMaterialModel::LeeTarverIgnitionGrowth) && mat.density < 100.0f) {
        float fallback_rho = static_cast<float>(get_json_double(obj, "rho", 0.0));
        if (fallback_rho < 100.0f) fallback_rho = static_cast<float>(get_json_double(obj, "ideal_rho_0", 1630.0));
        if (fallback_rho < 100.0f) fallback_rho = 1630.0f;
        mat.density = fallback_rho;
    }
    mat.youngs_modulus = static_cast<float>(get_json_double(obj, "youngs_modulus", 210.0e9));
    mat.poissons_ratio = static_cast<float>(get_json_double(obj, "poissons_ratio", 0.3));
    mat.yield_stress = static_cast<float>(get_json_double(obj, "yield_stress", 400.0e6));
    mat.hardening_modulus = static_cast<float>(get_json_double(obj, "hardening_modulus", 1.0e9));
    mat.failure_strain = static_cast<float>(get_json_double(obj, "failure_strain", 0.50));
    mat.tensile_failure_stress = static_cast<float>(get_json_double(obj, "tensile_failure_stress", 600.0e6));
    mat.enable_strain_erosion = get_json_bool(obj, "enable_strain_erosion", false);
    float default_erosion_strain = (mat.failure_strain >= 0.02f) ? mat.failure_strain : 0.10f;
    mat.erosion_strain = static_cast<float>(get_json_double(obj, "erosion_strain", default_erosion_strain));
    mat.enable_stress_erosion = get_json_bool(obj, "enable_stress_erosion", false);
    mat.erosion_stress = static_cast<float>(get_json_double(obj, "erosion_stress", mat.tensile_failure_stress));
    mat.enable_timestep_erosion = get_json_bool(obj, "enable_timestep_erosion", false);
    mat.timestep_erosion_factor = static_cast<float>(get_json_double(obj, "timestep_erosion_factor", 0.10));
    
    // JC
    mat.jc_A = static_cast<float>(get_json_double(obj, "jc_A", 792.0e6));
    mat.jc_B = static_cast<float>(get_json_double(obj, "jc_B", 510.0e6));
    mat.jc_n = static_cast<float>(get_json_double(obj, "jc_n", 0.26));
    mat.jc_C = static_cast<float>(get_json_double(obj, "jc_C", 0.014));
    mat.jc_m = static_cast<float>(get_json_double(obj, "jc_m", 1.03));
    mat.T_melt = static_cast<float>(get_json_double(obj, "T_melt", 1793.0));
    mat.T_room = static_cast<float>(get_json_double(obj, "initial_temperature", get_json_double(obj, "T_room", 293.0)));
    mat.Cp = static_cast<float>(get_json_double(obj, "Cp", 477.0));
    mat.mg_gamma0 = static_cast<float>(get_json_double(obj, "mg_gamma0", 1.81));
    mat.mg_c0 = static_cast<float>(get_json_double(obj, "mg_c0", 4570.0));
    mat.mg_s = static_cast<float>(get_json_double(obj, "mg_s", 1.49));
    mat.bulk_viscosity_b1 = static_cast<float>(get_json_double(obj, "bulk_viscosity_b1", 0.06));
    mat.bulk_viscosity_b2 = static_cast<float>(get_json_double(obj, "bulk_viscosity_b2", 1.20));

    // Davis Solid Reactant
    mat.davis_c0 = static_cast<float>(get_json_double(obj, "davis_c0", 2050.0));
    mat.davis_s1 = static_cast<float>(get_json_double(obj, "davis_s1", 2.12));
    mat.davis_gamma0 = static_cast<float>(get_json_double(obj, "davis_gamma0", 0.65));
    mat.davis_cv = static_cast<float>(get_json_double(obj, "davis_cv", 1000.0));
    mat.davis_t0 = static_cast<float>(get_json_double(obj, "initial_temperature", get_json_double(obj, "davis_t0", 293.0)));
    mat.davis_rho0 = static_cast<float>(get_json_double(obj, "davis_rho0", mat.density));

    // Davis Product Gas
    mat.davis_a = static_cast<float>(get_json_double(obj, "davis_a", 2.85));
    mat.davis_b = static_cast<float>(get_json_double(obj, "davis_b", 1.10));
    mat.davis_k = static_cast<float>(get_json_double(obj, "davis_k", 1.35));
    mat.davis_vc = static_cast<float>(get_json_double(obj, "davis_vc", 0.65));
    mat.davis_pc = static_cast<float>(get_json_double(obj, "davis_pc", 12.5e9));
    mat.davis_q_det = static_cast<float>(get_json_double(obj, "davis_q_det", get_json_double(obj, "detonation_energy", 3.90e6)));

    // CREST Reaction Kinetics
    mat.crest_b1 = static_cast<float>(get_json_double(obj, "crest_b1", 1.2e7));
    mat.crest_c1 = static_cast<float>(get_json_double(obj, "crest_c1", 0.67));
    mat.crest_m1 = static_cast<float>(get_json_double(obj, "crest_m1", 2.5));
    mat.crest_b2 = static_cast<float>(get_json_double(obj, "crest_b2", 3.5e6));
    mat.crest_c2 = static_cast<float>(get_json_double(obj, "crest_c2", 0.50));
    mat.crest_c3 = static_cast<float>(get_json_double(obj, "crest_c3", 0.67));
    mat.crest_m2 = static_cast<float>(get_json_double(obj, "crest_m2", 1.5));
    mat.crest_s0 = static_cast<float>(get_json_double(obj, "crest_s0", 100.0));
    mat.crest_s_threshold = static_cast<float>(get_json_double(obj, "crest_s_threshold", 45.0));
    mat.crest_awe_K0s = static_cast<float>(get_json_double(obj, "crest_awe_K0s", 14245250000.0));
    mat.crest_awe_A1 = static_cast<float>(get_json_double(obj, "crest_awe_A1", 2.417494));
    mat.crest_awe_A2 = static_cast<float>(get_json_double(obj, "crest_awe_A2", 2.208027));
    mat.crest_awe_A3 = static_cast<float>(get_json_double(obj, "crest_awe_A3", 0.0));
    mat.crest_awe_B1 = static_cast<float>(get_json_double(obj, "crest_awe_B1", 0.0));
    mat.crest_awe_B2 = static_cast<float>(get_json_double(obj, "crest_awe_B2", 0.0));
    mat.crest_awe_B3 = static_cast<float>(get_json_double(obj, "crest_awe_B3", 0.0));
    mat.crest_awe_fc = static_cast<float>(get_json_double(obj, "crest_awe_fc", 0.0));
    mat.crest_awe_delta = static_cast<float>(get_json_double(obj, "crest_awe_delta", 0.0));
    mat.crest_awe_Gamma1 = static_cast<float>(get_json_double(obj, "crest_awe_Gamma1", 32.33557));
    mat.crest_awe_Gamma2 = static_cast<float>(get_json_double(obj, "crest_awe_Gamma2", 3.596933));
    mat.crest_awe_gamma00 = static_cast<float>(get_json_double(obj, "crest_awe_gamma00", 0.4));
    mat.crest_awe_m = static_cast<float>(get_json_double(obj, "crest_awe_m", 2.0));
    mat.crest_awe_c0 = static_cast<float>(get_json_double(obj, "crest_awe_c0", 0.0));
    mat.crest_awe_c1 = static_cast<float>(get_json_double(obj, "crest_awe_c1", 2.0));
    mat.crest_awe_c2 = static_cast<float>(get_json_double(obj, "crest_awe_c2", 220000000.0));
    mat.crest_awe_c3 = static_cast<float>(get_json_double(obj, "crest_awe_c3", 2.5));
    mat.crest_awe_c6 = static_cast<float>(get_json_double(obj, "crest_awe_c6", 0.0));
    mat.crest_awe_c8 = static_cast<float>(get_json_double(obj, "crest_awe_c8", 0.00016));
    mat.crest_awe_c9 = static_cast<float>(get_json_double(obj, "crest_awe_c9", 1.0));
    mat.crest_awe_c10 = static_cast<float>(get_json_double(obj, "crest_awe_c10", 400000.0));
    mat.crest_awe_c11 = static_cast<float>(get_json_double(obj, "crest_awe_c11", 1.8));
    mat.crest_awe_c12 = static_cast<float>(get_json_double(obj, "crest_awe_c12", 0.0));
    mat.crest_awe_c13 = static_cast<float>(get_json_double(obj, "crest_awe_c13", 0.0));

    // JWL Product Gas EOS & Programmed Burn Parameters
    mat.jwl_A = static_cast<float>(get_json_double(obj, "jwl_A", 373.77e9));
    mat.jwl_B = static_cast<float>(get_json_double(obj, "jwl_B", 3.747e9));
    mat.jwl_R1 = static_cast<float>(get_json_double(obj, "jwl_R1", 4.15));
    mat.jwl_R2 = static_cast<float>(get_json_double(obj, "jwl_R2", 0.90));
    mat.jwl_omega = static_cast<float>(get_json_double(obj, "jwl_omega", 0.35));
    mat.det_vel = static_cast<float>(get_json_double(obj, "det_vel", 6930.0));
    mat.detonation_energy = static_cast<float>(get_json_double(obj, "detonation_energy", 4.29e6));
    mat.burn_zone_cells = get_json_int(obj, "burn_zone_cells", 4);
    mat.tau_burn_min = static_cast<float>(get_json_double(obj, "tau_burn_min", 1.0e-7));

    // Lee-Tarver Ignition & Growth Parameters
    mat.lt_I = static_cast<float>(get_json_double(obj, "lt_I", 4.0e6));
    mat.lt_a = static_cast<float>(get_json_double(obj, "lt_a", 0.24));
    mat.lt_b = static_cast<float>(get_json_double(obj, "lt_b", 0.667));
    mat.lt_x = static_cast<float>(get_json_double(obj, "lt_x", 7.0));
    mat.lt_G1 = static_cast<float>(get_json_double(obj, "lt_G1", 130.0e-6));
    mat.lt_c = static_cast<float>(get_json_double(obj, "lt_c", 0.667));
    mat.lt_d = static_cast<float>(get_json_double(obj, "lt_d", 0.333));
    mat.lt_y = static_cast<float>(get_json_double(obj, "lt_y", 2.0));
    mat.lt_G2 = static_cast<float>(get_json_double(obj, "lt_G2", 400.0e-6));
    mat.lt_e = static_cast<float>(get_json_double(obj, "lt_e", 0.333));
    mat.lt_g = static_cast<float>(get_json_double(obj, "lt_g", 0.667));
    mat.lt_z = static_cast<float>(get_json_double(obj, "lt_z", 3.0));
    mat.lt_ig_max = static_cast<float>(get_json_double(obj, "lt_ig_max", get_json_double(obj, "lt_F_ig_max", 0.02)));
    mat.lt_growth_max = static_cast<float>(get_json_double(obj, "lt_growth_max", get_json_double(obj, "lt_F_G1_max", 0.50)));
    mat.lt_comp_min = static_cast<float>(get_json_double(obj, "lt_comp_min", get_json_double(obj, "lt_F_G2_min", 0.50)));

    // Concrete Base
    mat.fc = static_cast<float>(get_json_double(obj, "fc", 35.0e6));
    mat.ft = static_cast<float>(get_json_double(obj, "ft", 3.5e6));
    mat.G_f = static_cast<float>(get_json_double(obj, "G_f", 100.0));
    mat.moisture_content = static_cast<float>(get_json_double(obj, "moisture_content", 0.04));
    mat.dif_cap_compression = static_cast<float>(get_json_double(obj, "dif_cap_compression", 2.5));
    mat.dif_cap_tension = static_cast<float>(get_json_double(obj, "dif_cap_tension", 5.0));

    // RHT
    mat.rht_A = static_cast<float>(get_json_double(obj, "rht_A", 1.60));
    mat.rht_N = static_cast<float>(get_json_double(obj, "rht_N", 0.61));
    mat.rht_B = static_cast<float>(get_json_double(obj, "rht_B", 0.70));
    mat.rht_M = static_cast<float>(get_json_double(obj, "rht_M", 0.80));
    mat.rht_Q0 = static_cast<float>(get_json_double(obj, "rht_Q0", 0.68));
    mat.rht_BQ = static_cast<float>(get_json_double(obj, "rht_BQ", 0.0105));
    mat.rht_D1 = static_cast<float>(get_json_double(obj, "rht_D1", 0.04));
    mat.rht_D2 = static_cast<float>(get_json_double(obj, "rht_D2", 1.0));
    mat.rht_p_crush = static_cast<float>(get_json_double(obj, "rht_p_crush", 35.0e6 / 3.0));
    mat.rht_p_lock = static_cast<float>(get_json_double(obj, "rht_p_lock", 6.0e9));
    mat.rht_alpha0 = static_cast<float>(get_json_double(obj, "rht_alpha0", 1.25));
    mat.rht_n_comp = static_cast<float>(get_json_double(obj, "rht_n_comp", 3.0));
    mat.rht_betac = static_cast<float>(get_json_double(obj, "rht_betac", 0.032));
    mat.rht_deltat = static_cast<float>(get_json_double(obj, "rht_deltat", 0.036));

    // K&C
    mat.kc_auto_generate = get_json_bool(obj, "kc_auto_generate", true);
    mat.kc_a0 = static_cast<float>(get_json_double(obj, "kc_a0", 11.67e6));
    mat.kc_a1 = static_cast<float>(get_json_double(obj, "kc_a1", 0.44));
    mat.kc_a2 = static_cast<float>(get_json_double(obj, "kc_a2", 0.77e-9));
    mat.kc_a0y = static_cast<float>(get_json_double(obj, "kc_a0y", 9.33e6));
    mat.kc_a1y = static_cast<float>(get_json_double(obj, "kc_a1y", 0.35));
    mat.kc_a2y = static_cast<float>(get_json_double(obj, "kc_a2y", 0.62e-9));
    mat.kc_a1r = static_cast<float>(get_json_double(obj, "kc_a1r", 0.25));
    mat.kc_a2r = static_cast<float>(get_json_double(obj, "kc_a2r", 0.50e-9));
    mat.kc_b1 = static_cast<float>(get_json_double(obj, "kc_b1", 1.60));
    mat.kc_omega = static_cast<float>(get_json_double(obj, "kc_omega", 0.50));

    // CSCM
    mat.cscm_alpha = static_cast<float>(get_json_double(obj, "cscm_alpha", 12.0e6));
    mat.cscm_theta = static_cast<float>(get_json_double(obj, "cscm_theta", 0.40));
    mat.cscm_lambda = static_cast<float>(get_json_double(obj, "cscm_lambda", 8.0e6));
    mat.cscm_beta = static_cast<float>(get_json_double(obj, "cscm_beta", 1.5e-8));
    mat.cscm_R = static_cast<float>(get_json_double(obj, "cscm_R", 4.0));
    mat.cscm_X0 = static_cast<float>(get_json_double(obj, "cscm_X0", 100.0e6));
    mat.cscm_W = static_cast<float>(get_json_double(obj, "cscm_W", 0.05));
    mat.cscm_D1 = static_cast<float>(get_json_double(obj, "cscm_D1", 2.5e-9));
    mat.cscm_D2 = static_cast<float>(get_json_double(obj, "cscm_D2", 1.0));

    // Hyperelastic (Yeoh & Mooney-Rivlin)
    mat.yeoh_c10 = static_cast<float>(get_json_double(obj, "yeoh_c10", 0.57e6));
    mat.yeoh_c20 = static_cast<float>(get_json_double(obj, "yeoh_c20", -0.047e6));
    mat.yeoh_c30 = static_cast<float>(get_json_double(obj, "yeoh_c30", 0.0033e6));
    mat.mr_c10 = static_cast<float>(get_json_double(obj, "mr_c10", 0.40e6));
    mat.mr_c01 = static_cast<float>(get_json_double(obj, "mr_c01", 0.10e6));
    mat.k_bulk = static_cast<float>(get_json_double(obj, "k_bulk", 1.0e8));

    // Concrete Damage Plasticity (CDP)
    mat.cdp_f_t0 = static_cast<float>(get_json_double(obj, "cdp_f_t0", 3.5e6));
    mat.cdp_f_c0 = static_cast<float>(get_json_double(obj, "cdp_f_c0", 35.0e6));
    mat.cdp_g_f = static_cast<float>(get_json_double(obj, "cdp_g_f", 120.0));
    mat.cdp_l_ch = static_cast<float>(get_json_double(obj, "cdp_l_ch", 0.05));

    // Hill48 Orthotropic
    mat.hill_F = static_cast<float>(get_json_double(obj, "hill_F", 0.35));
    mat.hill_G = static_cast<float>(get_json_double(obj, "hill_G", 0.45));
    mat.hill_H = static_cast<float>(get_json_double(obj, "hill_H", 0.55));
    mat.hill_L = static_cast<float>(get_json_double(obj, "hill_L", 1.50));
    mat.hill_M = static_cast<float>(get_json_double(obj, "hill_M", 1.50));
    mat.hill_N = static_cast<float>(get_json_double(obj, "hill_N", 1.60));
    mat.hill_sigma_y0 = static_cast<float>(get_json_double(obj, "hill_sigma_y0", mat.yield_stress));

    // Tait Water & Shock Fluid
    mat.tait_B = static_cast<float>(get_json_double(obj, "tait_B", 3.039e8));
    mat.tait_gamma = static_cast<float>(get_json_double(obj, "tait_gamma", 7.15));
    mat.tait_rho0 = static_cast<float>(get_json_double(obj, "tait_rho0", 1000.0));
    mat.tait_c0 = static_cast<float>(get_json_double(obj, "tait_c0", 1482.0));
    mat.tait_p_cav = static_cast<float>(get_json_double(obj, "tait_p_cav", 0.0));
    mat.tait_p0 = static_cast<float>(get_json_double(obj, "tait_p0", get_json_double(obj, "p0", 0.0)));
    mat.tait_viscosity = static_cast<float>(get_json_double(obj, "tait_viscosity", 1.0e-3));
    mat.tait_gruneisen = static_cast<float>(get_json_double(obj, "tait_gruneisen", 0.28));
    mat.tait_variant = get_json_int(obj, "tait_variant", 0);
    if (obj.contains("tait_variant_str")) {
        std::string vstr = obj.value("tait_variant_str", "");
        if (vstr == "CaloricGruneisen" || vstr == "Caloric" || vstr == "NearField") mat.tait_variant = 1;
        else if (vstr == "ShockHugoniot" || vstr == "Hugoniot") mat.tait_variant = 2;
        else mat.tait_variant = 0;
    }

    bool is_concrete = (mat.material_model == Blast::MPMMaterialModel::RHTConcrete || 
                        mat.material_model == Blast::MPMMaterialModel::KCConcrete || 
                        mat.material_model == Blast::MPMMaterialModel::CSCMConcrete);
    if (is_concrete) {
        // Decouple concrete erosion strain cutoff from compressive yield microstrain fc (mat.failure_strain ~ 0.0035).
        // Concrete element erosion represents physical rubble/mass ejection and must never trigger at microstrains < 2%.
        if (!obj.contains("erosion_strain") || mat.erosion_strain < 0.02f) {
            mat.erosion_strain = 0.10f;
        }
    }
    mat.directional_crack_band = get_json_bool(obj, "directional_crack_band", is_concrete);
    mat.nonlocal_radius = static_cast<float>(get_json_double(obj, "nonlocal_radius", is_concrete ? 0.05 : 0.0));

    std::string ts_str = obj.value("transfer_scheme", "Default");
    int ts_val = -1;
    if (ts_str == "Radial MLS" || ts_str == "RadialMLS") ts_val = 3;
    else if (ts_str == "BSpline" || ts_str == "B-Spline") ts_val = 2;
    else if (ts_str == "Cubic BSpline" || ts_str == "CubicBSpline") ts_val = 4;
    else if (ts_str == "GIMP") ts_val = 1;
    else if (ts_str == "Standard") ts_val = 0;
    mat.transfer_scheme = ts_val;

    // Realistic Fragmentation & Heterogeneity Parameters Parsing
    bool enable_het = get_json_bool(obj, "enable_heterogeneity", false);
    if (!enable_het && obj.contains("weibull_modulus")) {
        double w_m = get_json_double(obj, "weibull_modulus", 0.0);
        if (w_m > 0.001) enable_het = true;
    }
    mat.enable_heterogeneity = enable_het;
    mat.weibull_modulus = static_cast<float>(get_json_double(obj, "weibull_modulus", enable_het ? 8.0 : 0.0));
    if (!enable_het) mat.weibull_modulus = 0.0f;
    mat.weibull_scale = static_cast<float>(get_json_double(obj, "weibull_scale", 1.0));
    mat.weibull_ref_volume = static_cast<float>(get_json_double(obj, "weibull_ref_volume", 1.0e-6));

    // Directional Material Anisotropy Controls
    mat.enable_anisotropy = get_json_bool(obj, "enable_anisotropy", false);
    mat.anisotropy_ratio = static_cast<float>(get_json_double(obj, "anisotropy_ratio", 1.0));
    std::string aniso_axis = obj.value("anisotropy_axis", "X");
    if (aniso_axis == "Y") {
        mat.anisotropy_dir[0] = 0.0f; mat.anisotropy_dir[1] = 1.0f; mat.anisotropy_dir[2] = 0.0f;
    } else if (aniso_axis == "Z") {
        mat.anisotropy_dir[0] = 0.0f; mat.anisotropy_dir[1] = 0.0f; mat.anisotropy_dir[2] = 1.0f;
    } else if (aniso_axis == "Custom") {
        mat.anisotropy_dir[0] = static_cast<float>(get_json_double(obj, "anisotropy_dir_x", 1.0));
        mat.anisotropy_dir[1] = static_cast<float>(get_json_double(obj, "anisotropy_dir_y", 0.0));
        mat.anisotropy_dir[2] = static_cast<float>(get_json_double(obj, "anisotropy_dir_z", 0.0));
        float len = std::sqrt(mat.anisotropy_dir[0]*mat.anisotropy_dir[0] + mat.anisotropy_dir[1]*mat.anisotropy_dir[1] + mat.anisotropy_dir[2]*mat.anisotropy_dir[2]);
        if (len > 1e-6f) { mat.anisotropy_dir[0] /= len; mat.anisotropy_dir[1] /= len; mat.anisotropy_dir[2] /= len; }
    } else {
        mat.anisotropy_dir[0] = 1.0f; mat.anisotropy_dir[1] = 0.0f; mat.anisotropy_dir[2] = 0.0f;
    }

    mat.jc_d1 = static_cast<float>(get_json_double(obj, "jc_d1", 0.05));
    mat.jc_d2 = static_cast<float>(get_json_double(obj, "jc_d2", 3.44));
    mat.jc_d3 = static_cast<float>(get_json_double(obj, "jc_d3", -2.12));
    mat.jc_d4 = static_cast<float>(get_json_double(obj, "jc_d4", 0.002));
    mat.jc_d5 = static_cast<float>(get_json_double(obj, "jc_d5", 0.61));

    // Drucker-Prager & Mohr-Coulomb Soil / Geomaterial Parameters
    mat.dp_cohesion = static_cast<float>(get_json_double(obj, "dp_cohesion", get_json_double(obj, "cohesion", 20.0e3)));
    mat.dp_friction_angle = static_cast<float>(get_json_double(obj, "dp_friction_angle", get_json_double(obj, "friction_angle", 30.0)));
    mat.dp_dilatancy_angle = static_cast<float>(get_json_double(obj, "dp_dilatancy_angle", get_json_double(obj, "dilatancy_angle", 0.0)));
    mat.dp_tensile_cutoff = static_cast<float>(get_json_double(obj, "dp_tensile_cutoff", get_json_double(obj, "tensile_cutoff", 10.0e3)));
    mat.dp_hardening_modulus = static_cast<float>(get_json_double(obj, "dp_hardening_modulus", get_json_double(obj, "hardening_modulus", 0.0)));

    // Statistical Fragment Size Distribution & DEM Parameters Parsing
    return mat;
}

template <typename T>
inline void loadAndTransformLSDynaMesh(
    const std::string& k_file,
    T pos_x, T pos_y, T pos_z,
    T vel_x, T vel_y, T vel_z,
    T scale_x, T scale_y, T scale_z,
    const std::string& bc_cond,
    const Blast::MaterialTable3D& obj_mat,
    std::vector<Blast::FEMNode3D<T>>& out_nodes,
    std::vector<Blast::FEMElement3D<T>>& out_elements,
    std::vector<Blast::FEMTrussElement3D<T>>* out_trusses = nullptr,
    std::vector<Blast::FEMBeam3DElement<T>>* out_beams = nullptr,
    const nlohmann::json* obj_json = nullptr,
    std::vector<Blast::MaterialTable3D>* out_mat_tables = nullptr,
    std::vector<Blast::FEMShell4BTElement<T>>* out_shells = nullptr
) {
    Blast::LSDynaReader3D<T> reader;
    std::vector<Blast::MaterialTable3D> mat_list;
    Blast::MaterialTable3D mutable_mat = obj_mat;
    std::vector<Blast::FEMTrussElement3D<T>> local_trusses;
    std::vector<Blast::FEMBeam3DElement<T>> local_beams;
    std::vector<Blast::FEMShell4BTElement<T>> local_shells;
    auto& trusses_ref = out_trusses ? *out_trusses : local_trusses;
    auto& beams_ref = out_beams ? *out_beams : local_beams;
    auto& shells_ref = out_shells ? *out_shells : local_shells;
    reader.parseFile(k_file, out_nodes, out_elements, trusses_ref, beams_ref, shells_ref, mutable_mat, mat_list);

    int num_canvas_mats = 1;
    if (out_mat_tables) {
        out_mat_tables->clear();
        if (obj_json && obj_json->is_object() && obj_json->contains("fem_materials") &&
            (*obj_json)["fem_materials"].is_array() && !(*obj_json)["fem_materials"].empty()) {
            num_canvas_mats = 0;
            for (const auto& mj : (*obj_json)["fem_materials"]) {
                out_mat_tables->push_back(parseMaterialTable3D(mj));
                num_canvas_mats++;
            }
        } else {
            out_mat_tables->push_back(obj_mat);
            num_canvas_mats = 1;
        }
        for (const auto& m : mat_list) {
            out_mat_tables->push_back(m);
        }
    }

    std::unordered_set<int> suppressed_part_ids;
    std::unordered_map<int, std::array<T, 3>> part_velocities;
    std::unordered_map<int, int> part_mat_remapping;

    if (obj_json && obj_json->is_object()) {
        if (obj_json->contains("fem_parts") && (*obj_json)["fem_parts"].is_array()) {
            for (const auto& p : (*obj_json)["fem_parts"]) {
                int pid = p.value("part_id", 1);
                if (p.value("suppressed", false)) {
                    suppressed_part_ids.insert(pid);
                }
                if (p.contains("initial_velocity") && p["initial_velocity"].is_array() && p["initial_velocity"].size() >= 3) {
                    part_velocities[pid] = {
                        static_cast<T>(p["initial_velocity"][0].template get<double>()),
                        static_cast<T>(p["initial_velocity"][1].template get<double>()),
                        static_cast<T>(p["initial_velocity"][2].template get<double>())
                    };
                }
                if (p.contains("material_id")) {
                    part_mat_remapping[pid] = p["material_id"].template get<int>();
                }
            }
        }
    }

    if (!suppressed_part_ids.empty()) {
        std::vector<Blast::FEMElement3D<T>> kept_elements;
        kept_elements.reserve(out_elements.size());
        for (const auto& e : out_elements) {
            if (suppressed_part_ids.find(e.part_id) == suppressed_part_ids.end()) {
                kept_elements.push_back(e);
            }
        }
        out_elements = std::move(kept_elements);

        std::vector<Blast::FEMTrussElement3D<T>> kept_trusses;
        kept_trusses.reserve(trusses_ref.size());
        for (const auto& t : trusses_ref) {
            if (suppressed_part_ids.find(t.part_id) == suppressed_part_ids.end()) {
                kept_trusses.push_back(t);
            }
        }
        trusses_ref = std::move(kept_trusses);

        std::vector<Blast::FEMBeam3DElement<T>> kept_beams;
        kept_beams.reserve(beams_ref.size());
        for (const auto& b : beams_ref) {
            if (suppressed_part_ids.find(b.part_id) == suppressed_part_ids.end()) {
                kept_beams.push_back(b);
            }
        }
        beams_ref = std::move(kept_beams);

        std::vector<Blast::FEMShell4BTElement<T>> kept_shells;
        kept_shells.reserve(shells_ref.size());
        for (const auto& s : shells_ref) {
            if (suppressed_part_ids.find(s.part_id) == suppressed_part_ids.end()) {
                kept_shells.push_back(s);
            }
        }
        shells_ref = std::move(kept_shells);
    }

    if (!part_mat_remapping.empty()) {
        for (auto& el : out_elements) {
            if (part_mat_remapping.count(el.part_id)) {
                el.mat_id = part_mat_remapping[el.part_id];
            }
        }
        for (auto& tr : trusses_ref) {
            if (part_mat_remapping.count(tr.part_id)) {
                tr.mat_id = part_mat_remapping[tr.part_id];
            }
        }
        for (auto& bm : beams_ref) {
            if (part_mat_remapping.count(bm.part_id)) {
                bm.mat_id = part_mat_remapping[bm.part_id];
            }
        }
        for (auto& sh : shells_ref) {
            if (part_mat_remapping.count(sh.part_id)) {
                sh.mat_id = part_mat_remapping[sh.part_id];
            }
        }
    } else if (num_canvas_mats > 0 && !mat_list.empty()) {
        int total_mats = static_cast<int>(out_mat_tables ? out_mat_tables->size() : 0);
        for (auto& tr : trusses_ref) {
            if (tr.mat_id > 0 && (num_canvas_mats + tr.mat_id) < total_mats) {
                tr.mat_id += num_canvas_mats;
            } else if (num_canvas_mats > 1) {
                tr.mat_id = 1;
            }
        }
        for (auto& bm : beams_ref) {
            if (bm.mat_id > 0 && (num_canvas_mats + bm.mat_id) < total_mats) {
                bm.mat_id += num_canvas_mats;
            } else if (num_canvas_mats > 1) {
                bm.mat_id = 1;
            }
        }
        for (auto& sh : shells_ref) {
            if (sh.mat_id > 0 && (num_canvas_mats + sh.mat_id) < total_mats) {
                sh.mat_id += num_canvas_mats;
            } else if (num_canvas_mats > 1) {
                sh.mat_id = 1;
            }
        }
    }

    T rot_x_deg = static_cast<T>(0), rot_y_deg = static_cast<T>(0), rot_z_deg = static_cast<T>(0);
    if (obj_json && obj_json->is_object()) {
        rot_x_deg = static_cast<T>(get_json_double(*obj_json, "rot_x", 0.0));
        rot_y_deg = static_cast<T>(get_json_double(*obj_json, "rot_y", 0.0));
        rot_z_deg = static_cast<T>(get_json_double(*obj_json, "rot_z", 0.0));
    }
    const bool has_rot = (std::abs(rot_x_deg) > static_cast<T>(1e-6) ||
                          std::abs(rot_y_deg) > static_cast<T>(1e-6) ||
                          std::abs(rot_z_deg) > static_cast<T>(1e-6));
    constexpr double DEG_TO_RAD = 3.14159265358979323846 / 180.0;
    const T cx = static_cast<T>(std::cos(static_cast<double>(rot_x_deg) * DEG_TO_RAD));
    const T sx = static_cast<T>(std::sin(static_cast<double>(rot_x_deg) * DEG_TO_RAD));
    const T cy = static_cast<T>(std::cos(static_cast<double>(rot_y_deg) * DEG_TO_RAD));
    const T sy = static_cast<T>(std::sin(static_cast<double>(rot_y_deg) * DEG_TO_RAD));
    const T cz = static_cast<T>(std::cos(static_cast<double>(rot_z_deg) * DEG_TO_RAD));
    const T sz = static_cast<T>(std::sin(static_cast<double>(rot_z_deg) * DEG_TO_RAD));

    for (auto& nd : out_nodes) {
        T x = nd.x[0] * scale_x;
        T y = nd.x[1] * scale_y;
        T z = nd.x[2] * scale_z;
        if (has_rot) {
            // Rotate X, then Y, then Z
            T y1 = cx * y - sx * z;
            T z1 = sx * y + cx * z;
            T x2 = cy * x + sy * z1;
            T z2 = -sy * x + cy * z1;
            T x3 = cz * x2 - sz * y1;
            T y3 = sz * x2 + cz * y1;
            x = x3; y = y3; z = z2;
        }
        nd.x[0] = x + pos_x;
        nd.x[1] = y + pos_y;
        nd.x[2] = z + pos_z;
        nd.x0[0] = nd.x[0];
        nd.x0[1] = nd.x[1];
        nd.x0[2] = nd.x[2];

        if (vel_x != static_cast<T>(0) || vel_y != static_cast<T>(0) || vel_z != static_cast<T>(0)) {
            nd.v[0] += vel_x;
            nd.v[1] += vel_y;
            nd.v[2] += vel_z;
        }
    }

    bool is_fixed_base = (bc_cond == "Fixed Base");
    bool is_fixed_entire = (bc_cond == "Fixed Entire");
    T min_z = static_cast<T>(1e30);
    if (is_fixed_base) {
        for (const auto& nd : out_nodes) {
            if (nd.x[2] < min_z) min_z = nd.x[2];
        }
    }
    if (is_fixed_base || is_fixed_entire) {
        for (auto& nd : out_nodes) {
            if (is_fixed_entire || (is_fixed_base && std::abs(nd.x[2] - min_z) < static_cast<T>(1e-4))) {
                nd.is_fixed[0] = true;
                nd.is_fixed[1] = true;
                nd.is_fixed[2] = true;
            }
        }
    }

    if (!part_velocities.empty()) {
        std::unordered_set<int> visited_vel_nodes;
        for (const auto& el : out_elements) {
            if (part_velocities.count(el.part_id)) {
                const auto& pv = part_velocities[el.part_id];
                if (pv[0] == static_cast<T>(0) && pv[1] == static_cast<T>(0) && pv[2] == static_cast<T>(0)) continue;
                for (int n = 0; n < 8; ++n) {
                    int nid = el.node_ids[n];
                    if (nid >= 0 && nid < static_cast<int>(out_nodes.size()) && visited_vel_nodes.insert(nid).second) {
                        out_nodes[nid].v[0] += pv[0];
                        out_nodes[nid].v[1] += pv[1];
                        out_nodes[nid].v[2] += pv[2];
                    }
                }
            }
        }
    }

    if (obj_json && obj_json->is_object()) {
        if (obj_json->contains("boundary_conditions") && (*obj_json)["boundary_conditions"].is_array()) {
            for (const auto& bc : (*obj_json)["boundary_conditions"]) {
                if (!bc.value("active", true)) continue;
                std::string bc_type = bc.value("bc_type", "SPC");
                std::string target_type = bc.value("target_type", "NODE_SET");
                bool dofx = false, dofy = false, dofz = false;
                if (bc.contains("dofs") && bc["dofs"].is_array() && bc["dofs"].size() >= 3) {
                    dofx = bc["dofs"][0].template get<bool>();
                    dofy = bc["dofs"][1].template get<bool>();
                    dofz = bc["dofs"][2].template get<bool>();
                }
                T bvx = static_cast<T>(0), bvy = static_cast<T>(0), bvz = static_cast<T>(0);
                if (bc.contains("velocity") && bc["velocity"].is_array() && bc["velocity"].size() >= 3) {
                    bvx = static_cast<T>(bc["velocity"][0].template get<double>());
                    bvy = static_cast<T>(bc["velocity"][1].template get<double>());
                    bvz = static_cast<T>(bc["velocity"][2].template get<double>());
                }

                auto apply_bc_to_node = [&](int idx) {
                    if (idx < 0 || idx >= static_cast<int>(out_nodes.size())) return;
                    if (bc_type == "INITIAL_VELOCITY") {
                        out_nodes[idx].v[0] = bvx;
                        out_nodes[idx].v[1] = bvy;
                        out_nodes[idx].v[2] = bvz;
                    } else if (bc_type == "PRESCRIBED_VELOCITY") {
                        out_nodes[idx].v[0] = bvx;
                        out_nodes[idx].v[1] = bvy;
                        out_nodes[idx].v[2] = bvz;
                        if (dofx) out_nodes[idx].is_fixed[0] = true;
                        if (dofy) out_nodes[idx].is_fixed[1] = true;
                        if (dofz) out_nodes[idx].is_fixed[2] = true;
                    } else {
                        if (dofx) out_nodes[idx].is_fixed[0] = true;
                        if (dofy) out_nodes[idx].is_fixed[1] = true;
                        if (dofz) out_nodes[idx].is_fixed[2] = true;
                    }
                };

                if (target_type == "NODE_SET") {
                    int sid = bc.value("target_id", 1);
                    if (reader.getSets().count(sid)) {
                        for (int64_t lsdyna_nid : reader.getSets().at(sid).ids) {
                            if (reader.getNodeIdToIndex().count(lsdyna_nid)) {
                                apply_bc_to_node(reader.getNodeIdToIndex().at(lsdyna_nid));
                            }
                        }
                    }
                } else if (target_type == "PART") {
                    int pid = bc.value("target_id", 1);
                    for (const auto& el : out_elements) {
                        if (el.part_id == pid) {
                            for (int n = 0; n < 8; ++n) {
                                apply_bc_to_node(el.node_ids[n]);
                            }
                        }
                    }
                } else if (target_type == "GEOMETRIC_PLANE") {
                    std::string plane = bc.value("plane", "z_min");
                    T plane_coord = static_cast<T>(bc.value("plane_coord", 0.0));
                    T tol = static_cast<T>(bc.value("tolerance", 1e-4));
                    for (int idx = 0; idx < static_cast<int>(out_nodes.size()); ++idx) {
                        const auto& nd = out_nodes[idx];
                        bool match = false;
                        if (plane == "z_min" || plane == "z_max") match = std::abs(nd.x[2] - plane_coord) < tol;
                        else if (plane == "x_min" || plane == "x_max") match = std::abs(nd.x[0] - plane_coord) < tol;
                        else if (plane == "y_min" || plane == "y_max") match = std::abs(nd.x[1] - plane_coord) < tol;
                        if (match) apply_bc_to_node(idx);
                    }
                }
            }
        }
    }
}

template <typename T>
inline void populateFEMPhysicsParams(const nlohmann::json& msg, Blast::BlastPhysicsParams<T>& physics_params) {
    physics_params.convert_failed_elements_to_mpm = get_json_bool(msg, "convert_failed_elements_to_mpm", false);
    physics_params.mpm_particles_per_failed_element = get_json_int(msg, "mpm_particles_per_failed_element", 8);

    bool enable_het = get_json_bool(msg, "enable_heterogeneity", false);
    if (!enable_het && msg.contains("material_heterogeneity") && get_json_double(msg, "material_heterogeneity", 0.0) > 1e-4) {
        enable_het = true;
    }
    double w_mod = get_json_double(msg, "weibull_modulus", 0.0);
    if (w_mod > 0.01) enable_het = true;

    double het_val = (w_mod > 0.01) ? (1.0 / w_mod) : get_json_double(msg, "material_heterogeneity", enable_het ? 0.08 : 0.0);
    physics_params.enable_heterogeneity = enable_het;
    physics_params.material_heterogeneity = static_cast<T>(enable_het ? het_val : 0.0);
    physics_params.weibull_modulus = static_cast<T>(w_mod);
    physics_params.weibull_scale = static_cast<T>(get_json_double(msg, "weibull_scale", 1.0));

    physics_params.enable_anisotropy = get_json_bool(msg, "enable_anisotropy", false);
    physics_params.anisotropy_ratio = static_cast<T>(get_json_double(msg, "anisotropy_ratio", 1.0));
    std::string aniso_axis = msg.value("anisotropy_axis", "X");
    if (aniso_axis == "Y") {
        physics_params.anisotropy_dir[0] = static_cast<T>(0.0); physics_params.anisotropy_dir[1] = static_cast<T>(1.0); physics_params.anisotropy_dir[2] = static_cast<T>(0.0);
    } else if (aniso_axis == "Z") {
        physics_params.anisotropy_dir[0] = static_cast<T>(0.0); physics_params.anisotropy_dir[1] = static_cast<T>(0.0); physics_params.anisotropy_dir[2] = static_cast<T>(1.0);
    } else if (aniso_axis == "Custom") {
        double ax = get_json_double(msg, "anisotropy_dir_x", 1.0);
        double ay = get_json_double(msg, "anisotropy_dir_y", 0.0);
        double az = get_json_double(msg, "anisotropy_dir_z", 0.0);
        double len = std::sqrt(ax*ax + ay*ay + az*az);
        if (len > 1e-6) { ax /= len; ay /= len; az /= len; }
        physics_params.anisotropy_dir[0] = static_cast<T>(ax);
        physics_params.anisotropy_dir[1] = static_cast<T>(ay);
        physics_params.anisotropy_dir[2] = static_cast<T>(az);
    } else {
        physics_params.anisotropy_dir[0] = static_cast<T>(1.0); physics_params.anisotropy_dir[1] = static_cast<T>(0.0); physics_params.anisotropy_dir[2] = static_cast<T>(0.0);
    }

    physics_params.debris_velocity_smoothing = static_cast<T>(get_json_double(msg, "debris_velocity_smoothing", 0.25));
    physics_params.debris_clumping = static_cast<T>(get_json_double(msg, "debris_clumping", 0.40));
    physics_params.debris_max_clump_size = get_json_int(msg, "debris_max_clump_size", 8);
    physics_params.random_seed = get_json_int(msg, "random_seed", 42);
    physics_params.enable_directional_crack_band = get_json_bool(msg, "enable_directional_crack_band", true);
    physics_params.enable_nonlocal_damage = get_json_bool(msg, "enable_nonlocal_damage", true);
    physics_params.enable_cohesive_splitting = get_json_bool(msg, "enable_cohesive_splitting", false);
    physics_params.cohesive_fracture_energy = static_cast<T>(get_json_double(msg, "cohesive_fracture_energy", 1000.0));
}


template <typename T>
inline Blast::FEMErosionCriteria<T> populateFEMErosionCriteria(const nlohmann::json& msg) {
    Blast::FEMErosionCriteria<T> erosion{};
    const nlohmann::json* src = &msg;
    const nlohmann::json* obj0 = (msg.contains("fem_objects") && msg["fem_objects"].is_array() && !msg["fem_objects"].empty())
        ? &msg["fem_objects"][0] : nullptr;

    auto get_bool_val = [&](const std::string& k, bool def) -> bool {
        if (src->contains(k)) return get_json_bool(*src, k, def);
        if (obj0 && obj0->contains(k)) return get_json_bool(*obj0, k, def);
        return def;
    };
    auto get_double_val = [&](const std::string& k, double def) -> double {
        if (src->contains(k)) return get_json_double(*src, k, def);
        if (obj0 && obj0->contains(k)) return get_json_double(*obj0, k, def);
        return def;
    };

    erosion.enable_strain_erosion = get_bool_val("enable_strain_erosion", true);
    erosion.enable_timestep_erosion = get_bool_val("enable_timestep_erosion", false);
    erosion.enable_stress_erosion = get_bool_val("enable_stress_erosion", false);
    double default_erosion = get_double_val("erosion_strain", -1.0);
    if (default_erosion > 0.0) {
        erosion.failure_strain = static_cast<T>(default_erosion);
    } else {
        double f_strain = get_double_val("failure_strain", 0.50);
        erosion.failure_strain = static_cast<T>((f_strain >= 0.02) ? f_strain : 0.10);
    }
    erosion.timestep_erosion_factor = static_cast<T>(get_double_val("timestep_erosion_factor", 0.10));
    erosion.min_volume_ratio = static_cast<T>(get_double_val("min_volume_ratio", 0.02));
    erosion.tensile_failure_stress = static_cast<T>(get_double_val("tensile_failure_stress", 600.0e6));

    return erosion;
}

inline Blast::LysmerBoundaryParams populateFEMLysmerParams(const nlohmann::json& m) {
    Blast::LysmerBoundaryParams p;
    p.enabled = m.value("lysmer_enabled", false);
    std::string bc_fem = m.value("bc_fem", "");
    if (bc_fem == "Lysmer" || bc_fem == "LysmerDashpot" || bc_fem == "Absorbing" || bc_fem == "NonReflecting" || bc_fem == "Transmitting" || bc_fem == "TRANSMISSIVE" ||
        m.value("bc_x_min", "") == "Lysmer" || m.value("bc_x_max", "") == "Lysmer" ||
        m.value("bc_y_min", "") == "Lysmer" || m.value("bc_y_max", "") == "Lysmer" ||
        m.value("bc_z_min", "") == "Lysmer" || m.value("bc_z_max", "") == "Lysmer" ||
        m.value("bc_x_min", "") == "Transmitting" || m.value("bc_x_max", "") == "Transmitting" ||
        m.value("bc_y_min", "") == "Transmitting" || m.value("bc_y_max", "") == "Transmitting") {
        p.enabled = true;
    }
    p.rho = static_cast<float>(get_json_double(m, "lysmer_rho", get_json_double(m, "lysmer_density", 2000.0)));
    p.c_p = static_cast<float>(get_json_double(m, "lysmer_cp", get_json_double(m, "lysmer_c_p", 2000.0)));
    p.c_s = static_cast<float>(get_json_double(m, "lysmer_cs", get_json_double(m, "lysmer_c_s", 1000.0)));
    p.normal_relaxation = static_cast<float>(get_json_double(m, "lysmer_normal_relaxation", 1.0));
    p.shear_relaxation = static_cast<float>(get_json_double(m, "lysmer_shear_relaxation", 1.0));
    p.filter_box = m.value("lysmer_filter_box", false);
    if (m.contains("lysmer_x_min")) p.x_min = static_cast<float>(get_json_double(m, "lysmer_x_min", -1e9));
    if (m.contains("lysmer_x_max")) p.x_max = static_cast<float>(get_json_double(m, "lysmer_x_max", 1e9));
    if (m.contains("lysmer_y_min")) p.y_min = static_cast<float>(get_json_double(m, "lysmer_y_min", -1e9));
    if (m.contains("lysmer_y_max")) p.y_max = static_cast<float>(get_json_double(m, "lysmer_y_max", 1e9));
    if (m.contains("lysmer_z_min")) p.z_min = static_cast<float>(get_json_double(m, "lysmer_z_min", -1e9));
    if (m.contains("lysmer_z_max")) p.z_max = static_cast<float>(get_json_double(m, "lysmer_z_max", 1e9));
    if (m.contains("lysmer_tol")) p.tol = static_cast<float>(get_json_double(m, "lysmer_tol", 1e-3));
    return p;
}

template <typename SolverPtr, typename T>
inline void ingestFEMObjectsAndDetonators(SolverPtr& fem, const nlohmann::json& msg) {
    fem->clearDetonators();
    auto parse_fem_detonator = [](const nlohmann::json& d, int default_part_id) -> Blast::FEMDetonator3D {
        Blast::FEMDetonator3D det{};
        det.x = static_cast<float>(get_json_double(d, "trigger_x", get_json_double(d, "detonator_x", get_json_double(d, "det_x", get_json_double(d, "x", 0.5)))));
        det.y = static_cast<float>(get_json_double(d, "trigger_y", get_json_double(d, "detonator_y", get_json_double(d, "det_y", get_json_double(d, "y", 0.5)))));
        det.z = static_cast<float>(get_json_double(d, "trigger_z", get_json_double(d, "detonator_z", get_json_double(d, "det_z", get_json_double(d, "z", 0.5)))));
        det.radius = static_cast<float>(get_json_double(d, "trigger_radius", get_json_double(d, "detonator_radius", get_json_double(d, "initiation_radius", get_json_double(d, "radius", 0.02)))));
        det.time_delay = static_cast<float>(get_json_double(d, "time_delay", get_json_double(d, "start_time", get_json_double(d, "detonation_time", get_json_double(d, "delay", 0.0)))));
        det.target_part_id = get_json_int(d, "target_object_id", get_json_int(d, "object_id", default_part_id));
        det.fired = (det.time_delay <= 0.0f);
        return det;
    };

    std::vector<Blast::FEMDetonator3D> pending_detonators;
    if (msg.contains("triggers") && msg["triggers"].is_array()) {
        for (const auto& d : msg["triggers"]) {
            pending_detonators.push_back(parse_fem_detonator(d, -1));
        }
    } else if (msg.contains("detonators") && msg["detonators"].is_array()) {
        for (const auto& d : msg["detonators"]) {
            pending_detonators.push_back(parse_fem_detonator(d, -1));
        }
    } else if (msg.contains("trigger_x") || msg.contains("detonator_x") || msg.contains("det_x")) {
        pending_detonators.push_back(parse_fem_detonator(msg, -1));
    }

    if (msg.contains("fem_objects") && msg["fem_objects"].is_array() && !msg["fem_objects"].empty()) {
        int obj_part_id = 1;
        for (const auto& obj : msg["fem_objects"]) {
            int nx_fem = get_json_int(obj, "nx", 10);
            int ny_fem = get_json_int(obj, "ny", 10);
            int nz_fem = get_json_int(obj, "nz", 10);
            T lx = static_cast<T>(get_json_double(obj, "size_x", 1.0));
            T ly = static_cast<T>(get_json_double(obj, "size_y", 1.0));
            T lz = static_cast<T>(get_json_double(obj, "size_z", 1.0));
            T pos_x = static_cast<T>(get_json_double(obj, "pos_x", 0.0));
            T pos_y = static_cast<T>(get_json_double(obj, "pos_y", 0.0));
            T pos_z = static_cast<T>(get_json_double(obj, "pos_z", 0.0));
            T vel_x = static_cast<T>(get_json_double(obj, "vel_x", 0.0));
            T vel_y = static_cast<T>(get_json_double(obj, "vel_y", 0.0));
            T vel_z = static_cast<T>(get_json_double(obj, "vel_z", 0.0));
            Blast::MaterialTable3D obj_mat = parseMaterialTable3D(obj);

            std::string k_file = obj.value("k_file", "");
            std::string stl_file = obj.value("stl_file", "");
            std::string mesh_src = obj.value("mesh_source", "Box Generator");
            std::string shape_type = obj.value("shape_type", "Box");
            std::string origin_mode = obj.value("origin_mode", "Center");
            std::string bc_cond = obj.value("boundary_condition", "Free");
            std::string elem_topo = obj.value("element_topology", msg.value("element_topology", "Hex8"));
            bool use_tet4 = (elem_topo == "Tet4_ANP" || elem_topo == "Tet4" || elem_topo == "Tetrahedral");

            if (mesh_src == "Cylinder Generator" || shape_type == "Cylinder") {
                T radius = static_cast<T>(get_json_double(obj, "radius", 0.1));
                if (radius <= static_cast<T>(0.0)) radius = static_cast<T>(get_json_double(obj, "size_x", 0.2) * 0.5);
                T inner_radius = static_cast<T>(get_json_double(obj, "inner_radius", 0.0));
                T height = static_cast<T>(get_json_double(obj, "height", 0.2));
                if (height <= static_cast<T>(0.0)) height = static_cast<T>(get_json_double(obj, "size_z", 0.2));
                T cyl_start_z = (origin_mode == "CAD Origin" || origin_mode == "Min Corner") ? pos_z : (pos_z - static_cast<T>(0.5) * height);
                if (use_tet4) {
                    fem->addStructuredTetCylinderMesh(nx_fem, nz_fem, radius, height, pos_x, pos_y, cyl_start_z, obj_mat, vel_x, vel_y, vel_z, inner_radius, bc_cond);
                } else {
                    fem->addStructuredCylinderMesh(nx_fem, nz_fem, radius, height, pos_x, pos_y, cyl_start_z, obj_mat, vel_x, vel_y, vel_z, inner_radius, bc_cond);
                }
            } else if (mesh_src == "STL File" || shape_type == "STL" || !stl_file.empty()) {
                T scale_x = static_cast<T>(get_json_double(obj, "scale_x", get_json_double(obj, "scale_factor", 1.0)));
                T scale_y = static_cast<T>(get_json_double(obj, "scale_y", get_json_double(obj, "scale_factor", 1.0)));
                T scale_z = static_cast<T>(get_json_double(obj, "scale_z", get_json_double(obj, "scale_factor", 1.0)));
                T rot_x = static_cast<T>(get_json_double(obj, "rot_x", 0.0));
                T rot_y = static_cast<T>(get_json_double(obj, "rot_y", 0.0));
                T rot_z = static_cast<T>(get_json_double(obj, "rot_z", 0.0));
                fem->addSTLMesh(stl_file, nx_fem, ny_fem, nz_fem, pos_x, pos_y, pos_z, scale_x, scale_y, scale_z, rot_x, rot_y, rot_z, origin_mode, obj_mat, vel_x, vel_y, vel_z, use_tet4, bc_cond);
            } else if (mesh_src == "LS-DYNA Keyword File" || shape_type == "LS-DYNA File" || !k_file.empty()) {
                std::vector<Blast::FEMNode3D<T>> nodes;
                std::vector<Blast::FEMElement3D<T>> elements;
                std::vector<Blast::FEMTrussElement3D<T>> trusses;
                std::vector<Blast::FEMBeam3DElement<T>> beams;
                std::vector<Blast::MaterialTable3D> local_mats;
                int base_node_idx = static_cast<int>(fem->getNodes().size());
                int mat_offset = static_cast<int>(fem->getMaterialTables().size());
                T scale_x = static_cast<T>(get_json_double(obj, "scale_x", get_json_double(obj, "scale_factor", 1.0)));
                T scale_y = static_cast<T>(get_json_double(obj, "scale_y", get_json_double(obj, "scale_factor", 1.0)));
                T scale_z = static_cast<T>(get_json_double(obj, "scale_z", get_json_double(obj, "scale_factor", 1.0)));
                loadAndTransformLSDynaMesh<T>(k_file, pos_x, pos_y, pos_z, vel_x, vel_y, vel_z, scale_x, scale_y, scale_z, bc_cond, obj_mat, nodes, elements, &trusses, &beams, &obj, &local_mats);
                fem->appendNodesAndElements(nodes, elements, local_mats);
                const auto& mat_tables = fem->getMaterialTables();
                std::string rebar_form = msg.value("rebar_formulation", "TimoshenkoBeam3D");
                for (const auto& t : trusses) {
                    int mat_idx = t.mat_id + mat_offset;
                    const auto& t_mat = (mat_idx >= 0 && mat_idx < static_cast<int>(mat_tables.size())) ? mat_tables[mat_idx] : obj_mat;
                    if (rebar_form == "TimoshenkoBeam3D") {
                        T d_eq = static_cast<T>(std::sqrt(4.0 * static_cast<double>(t.A) / 3.141592653589793));
                        fem->addBeam3D(t.node_ids[0] + base_node_idx, t.node_ids[1] + base_node_idx, d_eq, t_mat, t.failure_strain, t.lsdyna_id);
                    } else {
                        fem->addTruss(t.node_ids[0] + base_node_idx, t.node_ids[1] + base_node_idx, t.A, t_mat, t.failure_strain, t.lsdyna_id);
                    }
                }
                for (const auto& b : beams) {
                    int mat_idx = b.mat_id + mat_offset;
                    const auto& b_mat = (mat_idx >= 0 && mat_idx < static_cast<int>(mat_tables.size())) ? mat_tables[mat_idx] : obj_mat;
                    if (rebar_form == "AxialTruss1D") {
                        T a_eq = static_cast<T>(0.25 * 3.141592653589793 * static_cast<double>(b.d) * static_cast<double>(b.d));
                        fem->addTruss(b.node_ids[0] + base_node_idx, b.node_ids[1] + base_node_idx, a_eq, b_mat, b.failure_strain, b.lsdyna_id);
                    } else {
                        fem->addBeam3D(b.node_ids[0] + base_node_idx, b.node_ids[1] + base_node_idx, b.d, b_mat, b.failure_strain, b.lsdyna_id);
                    }
                }
                char log_buf[256];
                snprintf(log_buf, sizeof(log_buf), "LS-DYNA Ingested: %zu Nodes, %zu Solids, %zu Trusses, %zu Beams (Rebar Mode: %s)",
                         nodes.size(), elements.size(), trusses.size(), beams.size(), rebar_form.c_str());
                emit_kernel_log("INFO", log_buf, 0.0, "fem_3d", 0);
            } else {
                T start_x = (origin_mode == "CAD Origin" || origin_mode == "Min Corner") ? pos_x : (pos_x - static_cast<T>(0.5) * lx);
                T start_y = (origin_mode == "CAD Origin" || origin_mode == "Min Corner") ? pos_y : (pos_y - static_cast<T>(0.5) * ly);
                T start_z = (origin_mode == "CAD Origin" || origin_mode == "Min Corner") ? pos_z : (pos_z - static_cast<T>(0.5) * lz);
                if (use_tet4) {
                    fem->addStructuredTetBoxMesh(nx_fem, ny_fem, nz_fem, lx, ly, lz, start_x, start_y, start_z, obj_mat, vel_x, vel_y, vel_z, bc_cond);
                } else {
                    fem->addStructuredBoxMesh(nx_fem, ny_fem, nz_fem, lx, ly, lz, start_x, start_y, start_z, obj_mat, vel_x, vel_y, vel_z, bc_cond);
                }
            }

            if (obj.contains("triggers") && obj["triggers"].is_array()) {
                for (const auto& d : obj["triggers"]) {
                    pending_detonators.push_back(parse_fem_detonator(d, obj_part_id));
                }
            } else if (obj.contains("detonators") && obj["detonators"].is_array()) {
                for (const auto& d : obj["detonators"]) {
                    pending_detonators.push_back(parse_fem_detonator(d, obj_part_id));
                }
            } else if (obj.contains("trigger_x") || obj.contains("detonator_x") || obj.contains("det_x")) {
                pending_detonators.push_back(parse_fem_detonator(obj, obj_part_id));
            }

            std::string preset_name = obj.value("preset", "");
            bool is_predetonated = (preset_name.find("Pre-Detonated") != std::string::npos ||
                                    preset_name.find("Instant") != std::string::npos ||
                                    preset_name.find("JWL Detonation Gas") != std::string::npos);
            if (is_predetonated) {
                Blast::FEMDetonator3D pre_det{};
                pre_det.x = static_cast<float>(pos_x);
                pre_det.y = static_cast<float>(pos_y);
                pre_det.z = static_cast<float>(pos_z);
                pre_det.radius = 1.0e6f;
                pre_det.time_delay = 0.0f;
                pre_det.target_part_id = obj_part_id;
                pre_det.fired = true;
                pending_detonators.push_back(pre_det);
            }
            obj_part_id++;
        }
    }

    // Optional Coincident Node Merging across multi-part assembly interfaces
    if (get_json_bool(msg, "merge_coincident_nodes", false)) {
        T merge_tol = static_cast<T>(get_json_double(msg, "node_merge_tolerance", 1.0e-4));
        int merged_count = fem->mergeCoincidentNodes(merge_tol);
        if (merged_count > 0) {
            char log_buf[160];
            snprintf(log_buf, sizeof(log_buf), "FEM Assembly Welder: Merged %d coincident nodes across part boundaries (tol = %.2e m)", merged_count, static_cast<double>(merge_tol));
            emit_kernel_log("INFO", log_buf, 0.0, "fem_3d", 0);
        }
    }

    // Evaluate top-level Entity Sets (fem_sets) and Boundary Conditions (boundary_conditions) across the entire assembled mesh
    if (msg.contains("boundary_conditions") && msg["boundary_conditions"].is_array() && !msg["boundary_conditions"].empty()) {
        auto& all_nodes = fem->getNodes();
        auto& all_elems = fem->getElements();
        std::unordered_map<int, std::vector<int>> assembly_node_sets;
        std::unordered_map<int, std::vector<int>> assembly_elem_sets;

        if (msg.contains("fem_sets") && msg["fem_sets"].is_array()) {
            for (const auto& s : msg["fem_sets"]) {
                int set_id = get_json_int(s, "id", -1);
                if (set_id < 0) continue;
                std::string stype = s.value("type", "NODE");
                std::string src = s.value("source", "deck");
                std::vector<int> matched_indices;

                if (src == "user_plane" && s.contains("filter_params") && s["filter_params"].contains("plane")) {
                    const auto& pl = s["filter_params"]["plane"];
                    std::string axis = pl.value("axis", "Z");
                    T val = static_cast<T>(get_json_double(pl, "val", 0.0));
                    T tol = static_cast<T>(get_json_double(pl, "tol", 0.01));
                    int ax_idx = (axis == "X" || axis == "x") ? 0 : (axis == "Y" || axis == "y") ? 1 : 2;
                    if (stype == "NODE") {
                        for (size_t ni = 0; ni < all_nodes.size(); ++ni) {
                            if (std::abs(all_nodes[ni].x[ax_idx] - val) <= tol) matched_indices.push_back(static_cast<int>(ni));
                        }
                    } else {
                        for (size_t ei = 0; ei < all_elems.size(); ++ei) {
                            T c = static_cast<T>(0);
                            int n_cnt = Blast::isTet4Element(all_elems[ei]) ? 4 : 8;
                            for (int k = 0; k < n_cnt; ++k) c += all_nodes[all_elems[ei].node_ids[k]].x[ax_idx];
                            c /= static_cast<T>(n_cnt);
                            if (std::abs(c - val) <= tol) matched_indices.push_back(static_cast<int>(ei));
                        }
                    }
                } else if (src == "user_box" && s.contains("filter_params") && s["filter_params"].contains("box")) {
                    const auto& bx = s["filter_params"]["box"];
                    if (bx.is_array() && bx.size() >= 6) {
                        T x0 = static_cast<T>(bx[0].get<double>()), y0 = static_cast<T>(bx[1].get<double>()), z0 = static_cast<T>(bx[2].get<double>());
                        T x1 = static_cast<T>(bx[3].get<double>()), y1 = static_cast<T>(bx[4].get<double>()), z1 = static_cast<T>(bx[5].get<double>());
                        if (stype == "NODE") {
                            for (size_t ni = 0; ni < all_nodes.size(); ++ni) {
                                T nx = all_nodes[ni].x[0], ny = all_nodes[ni].x[1], nz = all_nodes[ni].x[2];
                                if (nx >= x0 && nx <= x1 && ny >= y0 && ny <= y1 && nz >= z0 && nz <= z1) matched_indices.push_back(static_cast<int>(ni));
                            }
                        } else {
                            for (size_t ei = 0; ei < all_elems.size(); ++ei) {
                                T cx = 0, cy = 0, cz = 0;
                                int n_cnt = Blast::isTet4Element(all_elems[ei]) ? 4 : 8;
                                for (int k = 0; k < n_cnt; ++k) {
                                    cx += all_nodes[all_elems[ei].node_ids[k]].x[0];
                                    cy += all_nodes[all_elems[ei].node_ids[k]].x[1];
                                    cz += all_nodes[all_elems[ei].node_ids[k]].x[2];
                                }
                                cx /= static_cast<T>(n_cnt); cy /= static_cast<T>(n_cnt); cz /= static_cast<T>(n_cnt);
                                if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1 && cz >= z0 && cz <= z1) matched_indices.push_back(static_cast<int>(ei));
                            }
                        }
                    }
                } else if (src == "user_cylinder" && s.contains("filter_params") && s["filter_params"].contains("cylinder")) {
                    const auto& cyl = s["filter_params"]["cylinder"];
                    std::string axis = cyl.value("axis", "Z");
                    T cx = static_cast<T>(get_json_double(cyl, "cx", 0.0));
                    T cy = static_cast<T>(get_json_double(cyl, "cy", 0.0));
                    T r = static_cast<T>(get_json_double(cyl, "r", 0.5));
                    T min_val = static_cast<T>(get_json_double(cyl, "min_val", -1.0e9));
                    T max_val = static_cast<T>(get_json_double(cyl, "max_val", 1.0e9));
                    auto in_cyl = [&](T px, T py, T pz) -> bool {
                        T d1 = (axis == "X") ? (py - cx) : (px - cx);
                        T d2 = (axis == "Z") ? (py - cy) : (pz - cy);
                        T ax_v = (axis == "X") ? px : (axis == "Y") ? py : pz;
                        return (d1 * d1 + d2 * d2 <= r * r) && (ax_v >= min_val && ax_v <= max_val);
                    };
                    if (stype == "NODE") {
                        for (size_t ni = 0; ni < all_nodes.size(); ++ni) {
                            if (in_cyl(all_nodes[ni].x[0], all_nodes[ni].x[1], all_nodes[ni].x[2])) matched_indices.push_back(static_cast<int>(ni));
                        }
                    } else {
                        for (size_t ei = 0; ei < all_elems.size(); ++ei) {
                            T ex = 0, ey = 0, ez = 0;
                            int n_cnt = Blast::isTet4Element(all_elems[ei]) ? 4 : 8;
                            for (int k = 0; k < n_cnt; ++k) {
                                ex += all_nodes[all_elems[ei].node_ids[k]].x[0];
                                ey += all_nodes[all_elems[ei].node_ids[k]].x[1];
                                ez += all_nodes[all_elems[ei].node_ids[k]].x[2];
                            }
                            ex /= static_cast<T>(n_cnt); ey /= static_cast<T>(n_cnt); ez /= static_cast<T>(n_cnt);
                            if (in_cyl(ex, ey, ez)) matched_indices.push_back(static_cast<int>(ei));
                        }
                    }
                } else if (src == "user_part") {
                    int filter_pid = get_json_int(s, "filter_part_id", 1);
                    if (stype == "NODE") {
                        std::unordered_set<int> p_nodes;
                        for (const auto& el : all_elems) {
                            if (el.part_id == filter_pid) {
                                int n_cnt = Blast::isTet4Element(el) ? 4 : 8;
                                for (int k = 0; k < n_cnt; ++k) p_nodes.insert(el.node_ids[k]);
                            }
                        }
                        matched_indices.assign(p_nodes.begin(), p_nodes.end());
                    } else {
                        for (size_t ei = 0; ei < all_elems.size(); ++ei) {
                            if (all_elems[ei].part_id == filter_pid) matched_indices.push_back(static_cast<int>(ei));
                        }
                    }
                } else if (s.contains("entities") && s["entities"].is_array()) {
                    std::unordered_set<int64_t> id_lookup;
                    for (const auto& ent : s["entities"]) {
                        if (ent.is_number()) id_lookup.insert(ent.get<int64_t>());
                    }
                    if (stype == "NODE") {
                        for (size_t ni = 0; ni < all_nodes.size(); ++ni) {
                            if (id_lookup.count(all_nodes[ni].lsdyna_id) || id_lookup.count(static_cast<int64_t>(ni + 1))) {
                                matched_indices.push_back(static_cast<int>(ni));
                            }
                        }
                    } else {
                        for (size_t ei = 0; ei < all_elems.size(); ++ei) {
                            if (id_lookup.count(all_elems[ei].lsdyna_id) || id_lookup.count(static_cast<int64_t>(ei + 1))) {
                                matched_indices.push_back(static_cast<int>(ei));
                            }
                        }
                    }
                }

                if (stype == "NODE") assembly_node_sets[set_id] = std::move(matched_indices);
                else assembly_elem_sets[set_id] = std::move(matched_indices);
            }
        }

        for (const auto& bc : msg["boundary_conditions"]) {
            std::string btype = bc.value("type", "");
            int target_set = get_json_int(bc, "target_set_id", get_json_int(bc, "set_id", -1));
            if (btype == "SPC") {
                bool fx = false, fy = false, fz = false;
                if (bc.contains("dofs") && bc["dofs"].is_array() && bc["dofs"].size() >= 3) {
                    fx = bc["dofs"][0].is_boolean() ? bc["dofs"][0].get<bool>() : (bc["dofs"][0].get<int>() != 0);
                    fy = bc["dofs"][1].is_boolean() ? bc["dofs"][1].get<bool>() : (bc["dofs"][1].get<int>() != 0);
                    fz = bc["dofs"][2].is_boolean() ? bc["dofs"][2].get<bool>() : (bc["dofs"][2].get<int>() != 0);
                } else if (bc.contains("dofs") && bc["dofs"].is_object()) {
                    fx = bc["dofs"].value("tx", false);
                    fy = bc["dofs"].value("ty", false);
                    fz = bc["dofs"].value("tz", false);
                }
                auto it = assembly_node_sets.find(target_set);
                if (it != assembly_node_sets.end()) {
                    for (int ni : it->second) {
                        if (ni >= 0 && ni < static_cast<int>(all_nodes.size())) {
                            if (fx) { all_nodes[ni].is_fixed[0] = true; all_nodes[ni].v[0] = static_cast<T>(0); }
                            if (fy) { all_nodes[ni].is_fixed[1] = true; all_nodes[ni].v[1] = static_cast<T>(0); }
                            if (fz) { all_nodes[ni].is_fixed[2] = true; all_nodes[ni].v[2] = static_cast<T>(0); }
                        }
                    }
                }
            } else if (btype == "INITIAL_VELOCITY" || btype == "PRESCRIBED_VELOCITY") {
                T bvx = static_cast<T>(0), bvy = static_cast<T>(0), bvz = static_cast<T>(0);
                if (bc.contains("velocity") && bc["velocity"].is_array() && bc["velocity"].size() >= 3) {
                    bvx = static_cast<T>(bc["velocity"][0].get<double>());
                    bvy = static_cast<T>(bc["velocity"][1].get<double>());
                    bvz = static_cast<T>(bc["velocity"][2].get<double>());
                } else if (bc.contains("values") && bc["values"].is_object()) {
                    bvx = static_cast<T>(get_json_double(bc["values"], "vx", 0.0));
                    bvy = static_cast<T>(get_json_double(bc["values"], "vy", 0.0));
                    bvz = static_cast<T>(get_json_double(bc["values"], "vz", 0.0));
                }
                auto it = assembly_node_sets.find(target_set);
                if (it != assembly_node_sets.end()) {
                    for (int ni : it->second) {
                        if (ni >= 0 && ni < static_cast<int>(all_nodes.size())) {
                            all_nodes[ni].v[0] = bvx;
                            all_nodes[ni].v[1] = bvy;
                            all_nodes[ni].v[2] = bvz;
                        }
                    }
                }
            }
        }
    }

    for (const auto& det : pending_detonators) {
        fem->addDetonator(det);
    }
}

template <typename SolverPtr, typename T>
inline void ingestStandaloneBeams(SolverPtr& fem, const nlohmann::json& msg, const std::string& rebar_form) {
    if (!msg.contains("fem_standalone_beams") || !msg["fem_standalone_beams"].is_array()) return;
    size_t beam_count = 0;
    size_t truss_count = 0;
    for (const auto& b : msg["fem_standalone_beams"]) {
        Blast::MaterialTable3D mat = parseMaterialTable3D(b);
        T n1_x = static_cast<T>(get_json_double(b, "node1_x", 0.0));
        T n1_y = static_cast<T>(get_json_double(b, "node1_y", 0.0));
        T n1_z = static_cast<T>(get_json_double(b, "node1_z", 0.0));
        T n2_x = static_cast<T>(get_json_double(b, "node2_x", 1.0));
        T n2_y = static_cast<T>(get_json_double(b, "node2_y", 0.0));
        T n2_z = static_cast<T>(get_json_double(b, "node2_z", 0.0));

        int n1 = fem->addNode(n1_x, n1_y, n1_z);
        int n2 = fem->addNode(n2_x, n2_y, n2_z);

        T failure_strain = static_cast<T>(get_json_double(b, "failure_strain", 0.20));
        std::string b_type = b.value("type", "FEMBeam3D");

        if (b_type == "FEMRebar3D" && rebar_form == "AxialTruss1D") {
            T area = static_cast<T>(get_json_double(b, "cross_section_area", 0.000314));
            fem->addTruss(n1, n2, area, mat, failure_strain);
            truss_count++;
        } else {
            T diameter = static_cast<T>(get_json_double(b, "diameter", 0.02));
            if (b_type == "FEMRebar3D") {
                T area = static_cast<T>(get_json_double(b, "cross_section_area", 0.000314));
                diameter = static_cast<T>(std::sqrt(4.0 * area / 3.141592653589793));
            }
            fem->addBeam3D(n1, n2, diameter, mat, failure_strain);
            beam_count++;
        }
    }
    if (beam_count > 0 || truss_count > 0) {
        char log_buf[256];
        snprintf(log_buf, sizeof(log_buf), "Ingested Standalone Canvas 1D Elements: %zu Beams, %zu Trusses (Rebar Mode: %s)",
                 beam_count, truss_count, rebar_form.c_str());
        emit_kernel_log("INFO", log_buf, 0.0, "fem_3d", 0);
    }
}

template <typename CouplerPtr, typename T>
inline void configureFEMFSICouplerCUDA(CouplerPtr& coupler, const nlohmann::json& msg) {
    std::string integ_str = msg.value("pressure_integration", "Gauss2x2");
    if (integ_str == "Centroid1Pt") {
        coupler->setPressureIntegration(Blast::FSIPressureIntegration::Centroid1Pt);
    } else {
        coupler->setPressureIntegration(Blast::FSIPressureIntegration::Gauss2x2);
    }
    T rho_vac = static_cast<T>(get_json_double(msg, "fsi_rho_vac", 1.0e-6));
    T p_vac = static_cast<T>(get_json_double(msg, "fsi_p_vac", 1.0e-2));
    coupler->setVacuumState(rho_vac, p_vac);
}

template <typename CouplerPtr, typename T>
inline void configureFEMFSICouplerCPU(CouplerPtr& coupler, const nlohmann::json& msg) {
    std::string method_str = msg.value("fsi_method", "TwoWayStaggered");
    if (method_str == "SubCycling") {
        coupler->setMethod(Blast::FSIMethod3D::SubCycling);
    } else {
        coupler->setMethod(Blast::FSIMethod3D::TwoWayStaggered);
    }

    std::string integ_str = msg.value("pressure_integration", "Gauss2x2");
    if (integ_str == "Centroid1Pt") {
        coupler->setPressureIntegration(Blast::FSIPressureIntegration::Centroid1Pt);
    } else {
        coupler->setPressureIntegration(Blast::FSIPressureIntegration::Gauss2x2);
    }

    std::string uncov_str = msg.value("uncovering_method", "ConservativeIDW_VacuumCavity");
    if (uncov_str == "StandardGhostFluid") {
        coupler->setUncoveringMethod(Blast::FSIUncoveringMethod::StandardGhostFluid);
    } else {
        coupler->setUncoveringMethod(Blast::FSIUncoveringMethod::ConservativeIDW_VacuumCavity);
    }

    bool erosion_venting = get_json_bool(msg, "erosion_venting", true);
    coupler->setErosionVenting(erosion_venting);

    T rho_vac = static_cast<T>(get_json_double(msg, "fsi_rho_vac", 1.0e-6));
    T p_vac = static_cast<T>(get_json_double(msg, "fsi_p_vac", 1.0e-2));
    coupler->setVacuumState(rho_vac, p_vac);
}

MultiMat::MaterialSet parseMaterialSet(const nlohmann::json& msg);

inline void setup_phase_tracking_particles_3d(const nlohmann::json& msg) {
    global_phase_particles_3d.reset();

    std::string waterMode = msg.value("water_discretization_mode", "");
    bool enable_lptp = get_json_bool(msg, "enable_phase_tracking", false) ||
                       get_json_bool(msg, "phase_tracking_enabled", false) ||
                       get_json_bool(msg, "enable_lptp", false) ||
                       waterMode.find("LPTP") != std::string::npos ||
                       waterMode.find("Phase_Tracking") != std::string::npos ||
                       waterMode.find("PhaseTracking") != std::string::npos;

    if (!enable_lptp && msg.contains("mpm_objects") && msg["mpm_objects"].is_array()) {
        for (const auto& obj : msg["mpm_objects"]) {
            std::string model = obj.value("material_model", "");
            if (model == "LPTP" || model == "PhaseTracking" || model == "PhaseTrackingParticles") {
                enable_lptp = true;
                break;
            }
        }
    }

    if (!enable_lptp) return;

    bool use_gpu = is_cuda_device(msg.value("device", "cpu"));
    global_phase_particles_3d = std::make_unique<Blast::PhaseTrackingParticles3D>(use_gpu);

    int nx = global_solver_3d ? global_solver_3d->getNx() : get_json_int(msg, "nx", 60);
    int ny = global_solver_3d ? global_solver_3d->getNy() : get_json_int(msg, "ny", 40);
    int nz = global_solver_3d ? global_solver_3d->getNz() : get_json_int(msg, "nz", 120);
    double xmin = global_solver_3d ? global_solver_3d->getXMin() : get_json_double(msg, "xmin", 0.0);
    double ymin = global_solver_3d ? global_solver_3d->getYMin() : get_json_double(msg, "ymin", 0.0);
    double zmin = global_solver_3d ? global_solver_3d->getZMin() : get_json_double(msg, "zmin", 0.0);
    double cell_size = global_solver_3d ? global_solver_3d->getCellSize() : get_json_double(msg, "cell_size", 0.05);
    int max_capacity = get_json_int(msg, "phase_particle_max_capacity", 500000);

    global_phase_particles_3d->initialize(max_capacity, xmin, ymin, zmin, cell_size, cell_size, cell_size, nx, ny, nz);

    float dx = static_cast<float>(cell_size);
    float dy = dx, dz = dx;
    int charge_ppc = std::max(1, get_json_int(msg, "charge_ppc", get_json_int(msg, "phase_particle_ppc", 64)));
    int water_ppc = std::max(1, get_json_int(msg, "nearfield_ppc", 8));

    // 1. Seed High Explosive / JWL Gas particles inside charge geometry
    float chgX = static_cast<float>(get_json_double(msg, "charge_x", 0.0));
    float chgY = static_cast<float>(get_json_double(msg, "charge_y", 0.0));
    float chgZ = static_cast<float>(get_json_double(msg, "charge_z", 0.0));
    if (chgZ == 0.0f && msg.contains("detonator_z")) {
        chgZ = static_cast<float>(get_json_double(msg, "detonator_z", 0.0));
    }
    float chgR = static_cast<float>(get_json_double(msg, "charge_radius", 0.33));
    float sleeveR = static_cast<float>(get_json_double(msg, "nearfield_sleeve_radius", 2.5));
    float waterZ = static_cast<float>(get_json_double(msg, "water_surface_z", 10.0));
    float seabedZ = static_cast<float>(get_json_double(msg, "seabed_surface_z", 2.0));

    // Gas / Unreacted Explosive core
    if (chgR > 0.0f) {
        float gas_rho = static_cast<float>(get_json_double(msg, "charge_density", 1630.0));
        global_phase_particles_3d->seedSphere(
            chgX, chgY, chgZ, chgR, 0.0f,
            Blast::TrackingPhaseID::DetonationProducts,
            dx, dy, dz, charge_ppc, gas_rho,
            -1e30f, 1e30f
        );
    }

    // 2. Seed Surrounding Liquid Water in Near-field Sleeve
    if (sleeveR > chgR) {
        float water_rho = static_cast<float>(get_json_double(msg, "tait_rho0", 1025.0));
        bool is_cylinder = (waterMode.find("Column") != std::string::npos || waterMode.find("Cylinder") != std::string::npos);
        if (is_cylinder) {
            float cylH = std::max(0.1f, waterZ - seabedZ);
            float cylZ = seabedZ + 0.5f * cylH;
            global_phase_particles_3d->seedCylinder(
                chgX, chgY, cylZ, sleeveR, chgR, cylH,
                Blast::TrackingPhaseID::LiquidWater,
                dx, dy, dz, water_ppc, water_rho,
                seabedZ, waterZ
            );
        } else {
            global_phase_particles_3d->seedSphere(
                chgX, chgY, chgZ, sleeveR, chgR,
                Blast::TrackingPhaseID::LiquidWater,
                dx, dy, dz, water_ppc, water_rho,
                seabedZ, waterZ
            );
        }
    }

    // 3. Custom phase regions if present
    if (msg.contains("phase_regions") && msg["phase_regions"].is_array()) {
        for (const auto& reg : msg["phase_regions"]) {
            std::string shape = reg.value("shape", "Box");
            std::string phase_str = reg.value("phase", "LiquidWater");
            Blast::TrackingPhaseID pid = Blast::TrackingPhaseID::LiquidWater;
            if (phase_str == "DetonationProducts" || phase_str == "Gas") pid = Blast::TrackingPhaseID::DetonationProducts;
            else if (phase_str == "UnreactedExplosive") pid = Blast::TrackingPhaseID::UnreactedExplosive;
            else if (phase_str == "CasingSolid" || phase_str == "Solid") pid = Blast::TrackingPhaseID::CasingSolid;
            else if (phase_str == "GranularSoil" || phase_str == "Soil") pid = Blast::TrackingPhaseID::GranularSoil;
            else if (phase_str == "AtmosphericAir" || phase_str == "Air") pid = Blast::TrackingPhaseID::AtmosphericAir;

            float density = static_cast<float>(get_json_double(reg, "density", 1000.0));
            int reg_ppc = std::max(1, get_json_int(reg, "ppc", water_ppc));
            if (shape == "Box") {
                float x0 = static_cast<float>(get_json_double(reg, "min_x", 0.0));
                float x1 = static_cast<float>(get_json_double(reg, "max_x", 1.0));
                float y0 = static_cast<float>(get_json_double(reg, "min_y", 0.0));
                float y1 = static_cast<float>(get_json_double(reg, "max_y", 1.0));
                float z0 = static_cast<float>(get_json_double(reg, "min_z", 0.0));
                float z1 = static_cast<float>(get_json_double(reg, "max_z", 1.0));
                global_phase_particles_3d->seedBox(x0, x1, y0, y1, z0, z1, pid, dx, dy, dz, reg_ppc, density);
            } else if (shape == "Sphere") {
                float sx = static_cast<float>(get_json_double(reg, "pos_x", chgX));
                float sy = static_cast<float>(get_json_double(reg, "pos_y", chgY));
                float sz = static_cast<float>(get_json_double(reg, "pos_z", chgZ));
                float r_out = static_cast<float>(get_json_double(reg, "radius", 1.0));
                float r_in = static_cast<float>(get_json_double(reg, "inner_radius", 0.0));
                global_phase_particles_3d->seedSphere(sx, sy, sz, r_out, r_in, pid, dx, dy, dz, reg_ppc, density);
            }
        }
    }

    if (use_gpu) {
        global_phase_particles_3d->syncToDevice();
    }
    const auto& pts = global_phase_particles_3d->getParticles();
    float minX = 1e30f, maxX = -1e30f, minY = 1e30f, maxY = -1e30f, minZ = 1e30f, maxZ = -1e30f;
    for (const auto& p : pts) {
        if (!p.active) continue;
        minX = std::min(minX, p.x[0]); maxX = std::max(maxX, p.x[0]);
        minY = std::min(minY, p.x[1]); maxY = std::max(maxY, p.x[1]);
        minZ = std::min(minZ, p.x[2]); maxZ = std::max(maxZ, p.x[2]);
    }
    std::cout << "[BlastSolver] PhaseTrackingParticles3D initialized: "
              << global_phase_particles_3d->getParticleCount() << " particles (charge_ppc="
              << charge_ppc << ", water_ppc=" << water_ppc << ", backend="
              << (use_gpu ? "CUDA GPU" : "OpenMP CPU") << ") bounds: ["
              << minX << ", " << maxX << "] x ["
              << minY << ", " << maxY << "] x ["
              << minZ << ", " << maxZ << "]" << std::endl;
}

inline void step_phase_tracking_particles_3d(float dt) {
    if (!global_phase_particles_3d || global_phase_particles_3d->getParticleCount() == 0 || !global_solver_3d) return;

    int nx = global_solver_3d->getNx();
    int ny = global_solver_3d->getNy();
    int nz = global_solver_3d->getNz();
    float dx = static_cast<float>(global_solver_3d->getCellSize());
    float dy = dx, dz = dx;
    float xmin = static_cast<float>(global_solver_3d->getXMin());
    float ymin = static_cast<float>(global_solver_3d->getYMin());
    float zmin = static_cast<float>(global_solver_3d->getZMin());

    bool is_cuda = global_solver_3d->isCUDA() && global_phase_particles_3d->isCUDA();
    bool is_double = global_solver_3d->isDoublePrecision();
    bool is_multimat = global_solver_3d->isMultiMaterial();

    if (is_cuda) {
        const void* d_states = global_solver_3d->getDeviceStates();
        void* d_states_mut = global_solver_3d->getDeviceStatesMutable();
        void* d_U = global_solver_3d->getDeviceUMutable();

        if (d_states) {
            global_phase_particles_3d->advectGPU(dt, nx, ny, nz, dx, dy, dz, xmin, ymin, zmin, d_states, is_double, is_multimat);
            float rho1 = 1630.0f;
            float rho2 = 1025.0f;
            float water_rho = 1025.0f;
            float water_B = 3.039e8f;
            float water_gamma = 7.15f;
            global_phase_particles_3d->remapToCFD_GPU(d_states_mut, d_U, nx, ny, nz, dx, dy, dz, xmin, ymin, zmin,
                                                      is_double, is_multimat, rho1, rho2,
                                                      1e9f, 0.0f, 0.0f, 0.0f,
                                                      water_rho, water_B, water_gamma);
        }
    }
}

static Blast::MPMTransferScheme parseTransferScheme(const std::string& str) {
    if (str == "Standard" || str == "Normal" || str == "Linear") {
        return Blast::MPMTransferScheme::Standard;
    } else if (str == "GIMP") {
        return Blast::MPMTransferScheme::GIMP;
    } else if (str == "Radial MLS" || str == "RadialMLS") {
        return Blast::MPMTransferScheme::RadialMLS;
    } else if (str == "Cubic BSpline" || str == "CubicBSpline") {
        return Blast::MPMTransferScheme::CubicBSpline;
    } else {
        return Blast::MPMTransferScheme::BSpline;
    }
}

void worker_thread_func() {
    if (!global_solver) {
        sim_running = false;
        return;
    }
    try {
        auto last_telemetry_time = std::chrono::steady_clock::now();
    int initial_steps = global_target_steps.load();
    int initial_idx = global_solver->getActiveIndex();
    int total_range = global_solver->getNumCells() - initial_idx;

    int step_count = 0;
    double last_dt = (global_dt_1d > 1.0e-12) ? global_dt_1d : 0.0;
    double interval_compute_ms = 0.0;
    double interval_io_ms = 0.0;
    int interval_steps = 0;

    emit_kernel_log("INFO", "Asynchronous worker thread started.", global_t, "1d");

    while (sim_running) {
        if (sim_terminate) break;

        if (sim_paused) {
            std::this_thread::sleep_for(std::chrono::milliseconds(30));
            continue;
        }

        bool done = false;
        double end_time = global_endtime.load();
        if (end_time > 0.0 && global_t >= end_time - 1e-12) {
            done = true;
        } else if (global_exec_until_end.load()) {
            if (global_solver->is_terminated()) done = true;
        } else {
            if (global_target_steps.load() <= 0) done = true;
        }

        if (done) break;

        auto step_start = std::chrono::steady_clock::now();
        double dt = global_solver->computeStepSize(global_cfl.load());
        if (global_t == 0.0 && step_count == 0) {
            dt = 0.5 * dt;
        } else if (last_dt > 0.0) {
            dt = std::min(dt, 1.5 * last_dt);
        }
        if (end_time > 0.0 && global_t + dt > end_time) {
            dt = std::max(1e-12, end_time - global_t);
        }
        global_dt_1d = dt;
        last_dt = dt;
        global_solver->step(dt);
        auto step_end = std::chrono::steady_clock::now();
        double comp_ms = std::chrono::duration<double, std::milli>(step_end - step_start).count();
        interval_compute_ms += comp_ms;
        global_cum_compute_s = global_cum_compute_s.load() + (comp_ms * 0.001);
        global_wallclock_1d = global_wallclock_1d.load() + (comp_ms * 0.001);
        global_t += dt;
        
        global_step_1d++;
        step_count++;

        auto io_start = std::chrono::steady_clock::now();
        record_gauges_1d(global_t);

        if (global_enable_vtk.load()) {
            double last_time = global_last_vtk_time_1d.load();
            if (should_write_vtk(global_step_1d.load(), global_t, last_time)) {
                write_vtk_outputs(global_step_1d.load(), global_t);
                update_last_vtk_time(global_last_vtk_time_1d, global_t);
            }
        }
        auto io_end = std::chrono::steady_clock::now();
        double io_step_ms = std::chrono::duration<double, std::milli>(io_end - io_start).count();
        interval_io_ms += io_step_ms;
        global_cum_io_s = global_cum_io_s.load() + (io_step_ms * 0.001);
        interval_steps++;

        if (!global_exec_until_end.load()) {
            global_target_steps--;
        }

        auto now = std::chrono::steady_clock::now();
        auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
        if (elapsed_ms >= 33) {
            int steps_in_interval = std::max(1, interval_steps);
            global_last_compute_ms = interval_compute_ms / steps_in_interval;
            global_last_io_ms = interval_io_ms / steps_in_interval;
            interval_compute_ms = 0.0;
            interval_io_ms = 0.0;
            interval_steps = 0;

            auto comms_start = std::chrono::steady_clock::now();
            emit_telemetry(*global_solver, global_t, false, global_step_1d.load());
            auto comms_end = std::chrono::steady_clock::now();
            double comms_ms = std::chrono::duration<double, std::milli>(comms_end - comms_start).count();
            global_last_comms_ms = comms_ms;
            global_cum_comms_s = global_cum_comms_s.load() + (comms_ms * 0.001);
            last_telemetry_time = now;

            nlohmann::json progress_msg;
            progress_msg["type"] = "progress";
            progress_msg["sim_time"] = global_t;
            progress_msg["step"] = global_step_1d.load();
            progress_msg["scope"] = "1d";

            if (global_exec_until_end.load()) {
                if (end_time > 0.0) {
                    int percent = std::clamp((int)((global_t / end_time) * 100.0), 0, 99);
                    step_progress = percent;
                    progress_msg["percent"] = percent;
                    progress_msg["mode"] = "EXEC_ALL";
                } else if (total_range > 0) {
                    int current_range = global_solver->getActiveIndex() - initial_idx;
                    int percent = std::clamp((int)((current_range * 100) / total_range), 0, 99);
                    step_progress = percent;
                    progress_msg["percent"] = percent;
                    progress_msg["mode"] = "EXEC_ALL";
                }
            } else {
                initial_steps = std::max(initial_steps, step_count + global_target_steps.load());
                if (initial_steps > 0) {
                    int completed = initial_steps - global_target_steps.load();
                    int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 99);
                    step_progress = percent;
                    progress_msg["percent"] = percent;
                    progress_msg["completed"] = completed;
                    progress_msg["total"] = initial_steps;
                    progress_msg["mode"] = "STEP";
                }
            }
            std::lock_guard<std::mutex> lock(cout_mutex);
            std::cout << progress_msg.dump() << std::endl;
        }
    }

    double final_end_time = global_endtime.load();
    bool reached_end = (final_end_time > 0.0 && global_t >= final_end_time - 1e-12);
    bool term = !reached_end && global_solver->is_terminated();
    emit_telemetry(*global_solver, global_t, term, global_step_1d.load());
    flush_async_telemetry();
    
    // Emit final 100% progress packet to transition frontend state to paused/complete
    nlohmann::json progress_msg;
    progress_msg["type"] = "progress";
    progress_msg["sim_time"] = global_t;
    progress_msg["step"] = global_step_1d.load();
    progress_msg["scope"] = "1d";
    progress_msg["percent"] = 100;
    progress_msg["mode"] = global_exec_until_end.load() ? "EXEC_ALL" : "STEP";
    {
        std::lock_guard<std::mutex> lock(cout_mutex);
        std::cout << progress_msg.dump() << std::endl;
    }
    
    step_progress = 100;
    if (reached_end) {
        emit_kernel_log("INFO", "Reached simulation end time (" + std::to_string(final_end_time) + " s). Simulation paused.", global_t, "1d", global_step_1d.load());
    } else {
        emit_kernel_log("INFO", "Worker thread execution cycle ended.", global_t, "1d", global_step_1d.load());
    }
    write_gauge_files();
    if (global_enable_vtk.load() && reached_end && should_write_final_vtk(global_t, global_last_vtk_time_1d.load())) {
        write_vtk_outputs(global_step_1d.load(), global_t);
        update_last_vtk_time(global_last_vtk_time_1d, global_t);
    }
    sim_running = false;
        sim_paused = false;
        sim_terminate = false;
        global_target_steps = 0;
        global_exec_until_end = false;
    } catch (const std::exception& e) {
        emit_kernel_log("ERROR", std::string("1D worker thread error: ") + e.what(), global_t, "1d");
        sim_running = false;
        std::exit(1);
    } catch (...) {
        emit_kernel_log("ERROR", "1D worker thread error: unknown exception", global_t, "1d");
        sim_running = false;
        std::exit(1);
    }
}

extern std::vector<GeometryTile3D> global_geometry_tiles;

void generateObstacleMesh(int nx, int ny, int nz, double cellSize, double xmin, double ymin, double zmin) {
    global_obstacle_faces.clear();
    if (global_geometry_tiles.empty()) return;

    std::vector<uint8_t> solid_mask(nx * ny * nz, 0);

    auto is_solid_raw = [&](int i, int j, int k) -> bool {
        int ti = i / 8, tj = j / 8, tk = k / 8;
        int ntx = (nx + 7) / 8;
        int nty = (ny + 7) / 8;
        int t = ti + tj * ntx + tk * ntx * nty;
        int c = (i & 7) + (j & 7) * 8 + (k & 7) * 64;
        if (t < 0 || t >= (int)global_geometry_tiles.size()) return false;
        return global_geometry_tiles[t].cells[c].is_boundary;
    };

#ifdef _OPENMP
    #pragma omp parallel for collapse(3) schedule(static)
#endif
    for (int k = 0; k < nz; ++k) {
        for (int j = 0; j < ny; ++j) {
            for (int i = 0; i < nx; ++i) {
                solid_mask[i + j * nx + k * nx * ny] = is_solid_raw(i, j, k) ? 1 : 0;
            }
        }
    }

#ifdef _OPENMP
    #pragma omp parallel
    {
        std::vector<ObstacleFace> local_faces;
        #pragma omp for schedule(dynamic, 4)
        for (int gz = 0; gz < nz; ++gz) {
            for (int gy = 0; gy < ny; ++gy) {
                for (int gx = 0; gx < nx; ++gx) {
                    size_t idx = gx + gy * nx + gz * nx * ny;
                    if (solid_mask[idx]) continue; // Fluid cell checks neighbors

                    double x0 = xmin + gx * cellSize;
                    double x1 = xmin + (gx + 1) * cellSize;
                    double y0 = ymin + gy * cellSize;
                    double y1 = ymin + (gy + 1) * cellSize;
                    double z0 = zmin + gz * cellSize;
                    double z1 = zmin + (gz + 1) * cellSize;

                    // left (-x)
                    if (gx > 0 && solid_mask[idx - 1]) {
                        ObstacleFace face;
                        face.gx_fluid = gx; face.gy_fluid = gy; face.gz_fluid = gz;
                        face.px[0] = x0; face.px[1] = x0; face.px[2] = x0; face.px[3] = x0;
                        face.py[0] = y0; face.py[1] = y0; face.py[2] = y1; face.py[3] = y1;
                        face.pz[0] = z0; face.pz[1] = z1; face.pz[2] = z1; face.pz[3] = z0;
                        local_faces.push_back(face);
                    }
                    // right (+x)
                    if (gx < nx - 1 && solid_mask[idx + 1]) {
                        ObstacleFace face;
                        face.gx_fluid = gx; face.gy_fluid = gy; face.gz_fluid = gz;
                        face.px[0] = x1; face.px[1] = x1; face.px[2] = x1; face.px[3] = x1;
                        face.py[0] = y0; face.py[1] = y1; face.py[2] = y1; face.py[3] = y0;
                        face.pz[0] = z0; face.pz[1] = z0; face.pz[2] = z1; face.pz[3] = z1;
                        local_faces.push_back(face);
                    }
                    // bottom (-y)
                    if (gy > 0 && solid_mask[idx - nx]) {
                        ObstacleFace face;
                        face.gx_fluid = gx; face.gy_fluid = gy; face.gz_fluid = gz;
                        face.px[0] = x0; face.px[1] = x1; face.px[2] = x1; face.px[3] = x0;
                        face.py[0] = y0; face.py[1] = y0; face.py[2] = y0; face.py[3] = y0;
                        face.pz[0] = z0; face.pz[1] = z0; face.pz[2] = z1; face.pz[3] = z1;
                        local_faces.push_back(face);
                    }
                    // top (+y)
                    if (gy < ny - 1 && solid_mask[idx + nx]) {
                        ObstacleFace face;
                        face.gx_fluid = gx; face.gy_fluid = gy; face.gz_fluid = gz;
                        face.px[0] = x0; face.px[1] = x0; face.px[2] = x1; face.px[3] = x1;
                        face.py[0] = y1; face.py[1] = y1; face.py[2] = y1; face.py[3] = y1;
                        face.pz[0] = z0; face.pz[1] = z1; face.pz[2] = z1; face.pz[3] = z0;
                        local_faces.push_back(face);
                    }
                    // back (-z)
                    if (gz > 0 && solid_mask[idx - nx * ny]) {
                        ObstacleFace face;
                        face.gx_fluid = gx; face.gy_fluid = gy; face.gz_fluid = gz;
                        face.px[0] = x0; face.px[1] = x0; face.px[2] = x1; face.px[3] = x1;
                        face.py[0] = y0; face.py[1] = y1; face.py[2] = y1; face.py[3] = y0;
                        face.pz[0] = z0; face.pz[1] = z0; face.pz[2] = z0; face.pz[3] = z0;
                        local_faces.push_back(face);
                    }
                    // front (+z)
                    if (gz < nz - 1 && solid_mask[idx + nx * ny]) {
                        ObstacleFace face;
                        face.gx_fluid = gx; face.gy_fluid = gy; face.gz_fluid = gz;
                        face.px[0] = x0; face.px[1] = x1; face.px[2] = x1; face.px[3] = x0;
                        face.py[0] = y0; face.py[1] = y0; face.py[2] = y1; face.py[3] = y1;
                        face.pz[0] = z1; face.pz[1] = z1; face.pz[2] = z1; face.pz[3] = z1;
                        local_faces.push_back(face);
                    }
                }
            }
        }
        #pragma omp critical
        global_obstacle_faces.insert(global_obstacle_faces.end(), local_faces.begin(), local_faces.end());
    }
#else
    for (int gz = 0; gz < nz; ++gz) {
        for (int gy = 0; gy < ny; ++gy) {
            for (int gx = 0; gx < nx; ++gx) {
                size_t idx = gx + gy * nx + gz * nx * ny;
                if (solid_mask[idx]) continue;

                double x0 = xmin + gx * cellSize;
                double x1 = xmin + (gx + 1) * cellSize;
                double y0 = ymin + gy * cellSize;
                double y1 = ymin + (gy + 1) * cellSize;
                double z0 = zmin + gz * cellSize;
                double z1 = zmin + (gz + 1) * cellSize;

                if (gx > 0 && solid_mask[idx - 1]) {
                    ObstacleFace face;
                    face.gx_fluid = gx; face.gy_fluid = gy; face.gz_fluid = gz;
                    face.px[0] = x0; face.px[1] = x0; face.px[2] = x0; face.px[3] = x0;
                    face.py[0] = y0; face.py[1] = y0; face.py[2] = y1; face.py[3] = y1;
                    face.pz[0] = z0; face.pz[1] = z1; face.pz[2] = z1; face.pz[3] = z0;
                    global_obstacle_faces.push_back(face);
                }
                if (gx < nx - 1 && solid_mask[idx + 1]) {
                    ObstacleFace face;
                    face.gx_fluid = gx; face.gy_fluid = gy; face.gz_fluid = gz;
                    face.px[0] = x1; face.px[1] = x1; face.px[2] = x1; face.px[3] = x1;
                    face.py[0] = y0; face.py[1] = y1; face.py[2] = y1; face.py[3] = y0;
                    face.pz[0] = z0; face.pz[1] = z0; face.pz[2] = z1; face.pz[3] = z1;
                    global_obstacle_faces.push_back(face);
                }
                if (gy > 0 && solid_mask[idx - nx]) {
                    ObstacleFace face;
                    face.gx_fluid = gx; face.gy_fluid = gy; face.gz_fluid = gz;
                    face.px[0] = x0; face.px[1] = x1; face.px[2] = x1; face.px[3] = x0;
                    face.py[0] = y0; face.py[1] = y0; face.py[2] = y0; face.py[3] = y0;
                    face.pz[0] = z0; face.pz[1] = z0; face.pz[2] = z1; face.pz[3] = z1;
                    global_obstacle_faces.push_back(face);
                }
                if (gy < ny - 1 && solid_mask[idx + nx]) {
                    ObstacleFace face;
                    face.gx_fluid = gx; face.gy_fluid = gy; face.gz_fluid = gz;
                    face.px[0] = x0; face.px[1] = x0; face.px[2] = x1; face.px[3] = x1;
                    face.py[0] = y1; face.py[1] = y1; face.py[2] = y1; face.py[3] = y1;
                    face.pz[0] = z0; face.pz[1] = z1; face.pz[2] = z1; face.pz[3] = z0;
                    global_obstacle_faces.push_back(face);
                }
                if (gz > 0 && solid_mask[idx - nx * ny]) {
                    ObstacleFace face;
                    face.gx_fluid = gx; face.gy_fluid = gy; face.gz_fluid = gz;
                    face.px[0] = x0; face.px[1] = x0; face.px[2] = x1; face.px[3] = x1;
                    face.py[0] = y0; face.py[1] = y1; face.py[2] = y1; face.py[3] = y0;
                    face.pz[0] = z0; face.pz[1] = z0; face.pz[2] = z0; face.pz[3] = z0;
                    global_obstacle_faces.push_back(face);
                }
                if (gz < nz - 1 && solid_mask[idx + nx * ny]) {
                    ObstacleFace face;
                    face.gx_fluid = gx; face.gy_fluid = gy; face.gz_fluid = gz;
                    face.px[0] = x0; face.px[1] = x1; face.px[2] = x1; face.px[3] = x0;
                    face.py[0] = y0; face.py[1] = y0; face.py[2] = y1; face.py[3] = y1;
                    face.pz[0] = z1; face.pz[1] = z1; face.pz[2] = z1; face.pz[3] = z1;
                    global_obstacle_faces.push_back(face);
                }
            }
        }
    }
#endif
}

void sendObstacleMeshToFrontend(const std::string& modelId) {
    (void)modelId;
    if (global_obstacle_faces.empty()) return;

    size_t total_faces = global_obstacle_faces.size();

    std::vector<float> vertices;
    vertices.reserve(total_faces * 12);
    for (size_t f = 0; f < total_faces; ++f) {
        const auto& face = global_obstacle_faces[f];
        vertices.push_back((float)face.px[0]); vertices.push_back((float)face.py[0]); vertices.push_back((float)face.pz[0]);
        vertices.push_back((float)face.px[1]); vertices.push_back((float)face.py[1]); vertices.push_back((float)face.pz[1]);
        vertices.push_back((float)face.px[2]); vertices.push_back((float)face.py[2]); vertices.push_back((float)face.pz[2]);
        vertices.push_back((float)face.px[3]); vertices.push_back((float)face.py[3]); vertices.push_back((float)face.pz[3]);
    }

    std::vector<int32_t> cells;
    cells.reserve(total_faces * 3);
    for (size_t f = 0; f < total_faces; ++f) {
        const auto& face = global_obstacle_faces[f];
        cells.push_back((int32_t)face.gx_fluid);
        cells.push_back((int32_t)face.gy_fluid);
        cells.push_back((int32_t)face.gz_fluid);
    }

    std::string meshId = "default_obstacles";
    uint32_t magic = 0x424f4253; // "BOBS"
    uint32_t meshIdLen = static_cast<uint32_t>(meshId.size());
    uint32_t numVerts = static_cast<uint32_t>(vertices.size());
    uint32_t numCells = static_cast<uint32_t>(cells.size());

    size_t payload_bytes = 4 + 4 + meshIdLen + 4 + 4 + (vertices.size() * sizeof(float)) + (cells.size() * sizeof(int32_t));

    std::cout << "BIN_OBSTACLES " << payload_bytes << "\n";
    std::cout.write(reinterpret_cast<const char*>(&magic), 4);
    std::cout.write(reinterpret_cast<const char*>(&meshIdLen), 4);
    std::cout.write(meshId.data(), meshIdLen);
    std::cout.write(reinterpret_cast<const char*>(&numVerts), 4);
    std::cout.write(reinterpret_cast<const char*>(&numCells), 4);
    std::cout.write(reinterpret_cast<const char*>(vertices.data()), vertices.size() * sizeof(float));
    std::cout.write(reinterpret_cast<const char*>(cells.data()), cells.size() * sizeof(int32_t));
    std::cout.flush();

    std::cout << "[INFO] Emitted binary obstacle surface mesh with " << total_faces << " faces." << std::endl;
}

struct PendingRemap {
    bool has_pending = false;
    std::string type = ""; // "1D" or "2D"
    nlohmann::json msg;
};
static std::mutex g_pending_remap_mutex;
static PendingRemap g_pending_remap;

struct PendingExec3D {
    bool has_pending = false;
    std::string command = ""; // "STEP_3D" or "EXEC_ALL_3D"
    nlohmann::json msg;
};
static std::mutex g_pending_exec_3d_mutex;
static PendingExec3D g_pending_exec_3d;

void apply_remap_payload(const nlohmann::json& msg, const std::string& type, CFDSolver3D* solver_3d, CFDSolver2D* solver_2d, CFDSolver2DCuda* solver_2d_cuda) {
    if (type == "1D") {
        double explosive_z = msg.value("explosive_z", 0.0);
        double remap_radius = msg.value("remap_radius", 0.5);
        double explosive_r = msg.value("explosive_r", 0.0);
        double ambient_rho = msg.value("ambient_rho", 1.225648589);
        double ambient_p = msg.value("ambient_p", 101325.0);
        double gamma = msg.value("gamma", 1.4);
        
        std::string composition = msg.value("composition", "TNT");
        std::string explosive_type = msg.value("explosive_type", "");
        bool is_ideal_gas = (explosive_type == "MaterialIdealGas" || msg.value("init_mode", "") == "Ideal Gas");

        MultiMat::MaterialSet matSet = parseMaterialSet(msg);

        std::vector<double> r_1d = msg.at("r_1d").get<std::vector<double>>();
        std::vector<MultiMaterialState> states_1d;
        if (msg.contains("states_1d")) {
            for (const auto& item : msg.at("states_1d")) {
                MultiMaterialState s;
                s.rho = item.at("rho").get<double>();
                s.u = item.at("u").get<double>();
                s.p = item.at("p").get<double>();
                s.E = item.at("E").get<double>();
                s.alpha1 = item.at("alpha1").get<double>();
                s.alpha2 = item.at("alpha2").get<double>();
                s.arho1 = item.at("arho1").get<double>();
                s.arho2 = item.at("arho2").get<double>();
                s.floor_status = item.value("floor_status", 0);
                states_1d.push_back(s);
            }
        } else if (msg.contains("rho_1d") && msg.contains("ur_1d") && msg.contains("p_1d")) {
            std::vector<double> rho_1d = msg.at("rho_1d").get<std::vector<double>>();
            std::vector<double> ur_1d = msg.at("ur_1d").get<std::vector<double>>();
            std::vector<double> p_1d = msg.at("p_1d").get<std::vector<double>>();
            for (size_t i = 0; i < r_1d.size(); ++i) {
                MultiMaterialState s{};
                s.rho = rho_1d[i];
                s.u = ur_1d[i];
                s.p = p_1d[i];
                s.alpha1 = 0.0;
                s.alpha2 = 0.0;
                s.arho1 = 0.0;
                s.arho2 = 0.0;
                s.E = s.p / (gamma - 1.0) + 0.5 * s.rho * s.u * s.u;
                states_1d.push_back(s);
            }
        }

        if (solver_3d) {
            auto map_bc_3d = [](const std::string& str) {
                if (str == "Terminate" || str == "OUTFLOW_RIEMANN" || str == "Riemann" || str == "NonReflecting" || str == "Absorbing" || str == "Lysmer" || str == "Transmitting" || str == "TRANSMISSIVE") return BCType3D::OUTFLOW_RIEMANN;
                if (str == "Outflow" || str == "Neumann") return BCType3D::TRANSMISSIVE;
                return BCType3D::REFLECTIVE;
            };
            solver_3d->setBoundaryConditions(
                map_bc_3d(msg.value("bc_x_min", "Reflecting")), map_bc_3d(msg.value("bc_x_max", "Transmitting")),
                map_bc_3d(msg.value("bc_y_min", "Reflecting")), map_bc_3d(msg.value("bc_y_max", "Transmitting")),
                map_bc_3d(msg.value("bc_z_min", "Reflecting")), map_bc_3d(msg.value("bc_z_max", "Transmitting"))
            );
            solver_3d->setGamma(gamma);
            solver_3d->setIdealGas(is_ideal_gas);
            solver_3d->setMaterialParameters(matSet);
            solver_3d->setAmbientState(ambient_rho, ambient_p);
            if (msg.contains("charge_radius")) {
                solver_3d->setChargeRadius(msg.value("charge_radius", 0.05));
            }
            double explosive_x = msg.value("explosive_x", 0.5);
            double explosive_y = msg.value("explosive_y", 0.5);
            double start_time = msg.value("time", msg.value("sim_time", 0.0));
            solver_3d->initializeFrom1D(r_1d, states_1d, explosive_x, explosive_y, explosive_z, remap_radius);
            solver_3d->setTime(start_time);
            global_t3d = start_time;
            global_wallclock_3d = 0.0;
            emit_kernel_log("REMAP", "1D->3D remap applied successfully.", start_time, "3d");
            emit_telemetry_3d(global_t3d, false);
        } else if (solver_2d) {
            double start_time = msg.value("time", msg.value("sim_time", 0.0));
            solver_2d->setGamma(gamma);
            solver_2d->setIdealGas(is_ideal_gas);
            solver_2d->setMaterialParameters(matSet);
            if (msg.contains("charge_radius")) {
                solver_2d->setChargeRadius(msg.value("charge_radius", 0.05));
            }
            solver_2d->setInitialConditionFrom1D(explosive_z, remap_radius, r_1d, states_1d, ambient_rho, ambient_p, explosive_r);
            solver_2d->setTime(start_time);
            global_t2d = start_time;
            global_wallclock_2d = 0.0;
            solver2d_initialized = true;
            emit_kernel_log("REMAP", "1D->2D remap applied successfully.", start_time, "2d");
            emit_telemetry_2d(global_t2d, false);
        } else if (solver_2d_cuda) {
            double start_time = msg.value("time", msg.value("sim_time", 0.0));
            solver_2d_cuda->setGamma(gamma);
            solver_2d_cuda->setIdealGas(is_ideal_gas);
            solver_2d_cuda->setMaterialParameters(matSet);
            if (msg.contains("charge_radius")) {
                solver_2d_cuda->setChargeRadius(msg.value("charge_radius", 0.05));
            }
            solver_2d_cuda->setInitialConditionFrom1D(explosive_z, remap_radius, r_1d, states_1d, ambient_rho, ambient_p, explosive_r);
            solver_2d_cuda->setTime(start_time);
            global_t2d = start_time;
            global_wallclock_2d = 0.0;
            solver2d_initialized = true;
            emit_kernel_log("REMAP", "1D->2D remap applied successfully.", start_time, "2d");
            emit_telemetry_2d(global_t2d, false);
        }
    } else if (type == "2D") {
        int nr = msg.value("nr", 100);
        int nz = msg.value("nz", 100);
        double cell_size = msg.value("cell_size", 0.005);
        double max_r = msg.value("max_r", (double)nr * cell_size);
        double max_z = msg.value("max_z", (double)nz * cell_size);
        double dr = max_r / nr;
        double dz = max_z / nz;
        double explosive_x = msg.value("explosive_x", 0.5);
        double explosive_y = msg.value("explosive_y", 0.5);
        double explosive_z = msg.value("explosive_z", 0.5);
        double source_explosive_z = msg.value("source_explosive_z", msg.value("source_z", 0.0));
        double remap_radius = msg.value("remap_radius", 0.0);

        std::vector<State2D> states_2d;
        if (msg.contains("states_2d")) {
            for (const auto& item : msg.at("states_2d")) {
                State2D s{};
                s.rho = item.value("rho", 1.225);
                s.ur = item.value("ur", 0.0);
                s.uz = item.value("uz", 0.0);
                s.p = item.value("p", 101325.0);
                s.E = item.value("E", 253312.5);
                s.alpha1 = item.value("alpha1", 0.0);
                s.alpha2 = item.value("alpha2", 0.0);
                s.arho1 = item.value("arho1", 0.0);
                s.arho2 = item.value("arho2", 0.0);
                states_2d.push_back(s);
            }
        } else if (msg.contains("telemetry_data")) {
            std::vector<double> data = msg.at("telemetry_data").get<std::vector<double>>();
            size_t n_cells = (size_t)nr * (size_t)nz;
            if (n_cells > 0 && data.size() >= n_cells) {
                size_t n_channels = data.size() / n_cells;
                for (size_t i = 0; i < n_cells; ++i) {
                    State2D s{};
                    s.p      = (n_channels > 0) ? data[0 * n_cells + i] : 101325.0;
                    s.rho    = (n_channels > 1) ? data[1 * n_cells + i] : 1.225;
                    s.ur     = (n_channels > 2) ? data[2 * n_cells + i] : 0.0;
                    s.uz     = (n_channels > 3) ? data[3 * n_cells + i] : 0.0;
                    s.E      = (n_channels > 4) ? data[4 * n_cells + i] : 253312.5;
                    s.alpha1 = (n_channels > 5) ? data[5 * n_cells + i] : 0.0;
                    s.alpha2 = (n_channels > 6) ? data[6 * n_cells + i] : 0.0;
                    s.arho1  = s.alpha1 * s.rho;
                    s.arho2  = s.alpha2 * s.rho;
                    states_2d.push_back(s);
                }
            }
        }

        double gamma_val = msg.value("gamma", 1.4);
        std::string explosive_type = msg.value("explosive_type", "");
        std::string material_type = msg.value("material_type", "");
        bool is_ideal_gas_val = (get_json_bool(msg, "is_ideal_gas", false) || explosive_type == "MaterialIdealGas" || msg.value("init_mode", "") == "Ideal Gas" || material_type == "Ideal Gas Charge");
        bool is_multimat_needed = !is_ideal_gas_val;
        MultiMat::MaterialSet matSet_val = parseMaterialSet(msg);

        double amb_p_val = msg.value("ambient_p", msg.value("atm_pressure", 101325.0));
        double amb_rho_val = msg.value("ambient_rho", 1.225);

        int req_nx = msg.value("nx_3d", msg.value("nx", 64));
        int req_ny = msg.value("ny_3d", msg.value("ny", 64));
        int req_nz = msg.value("nz_3d", msg.value("nz", 64));
        double req_cellSize = msg.value("cell_size_3d", msg.value("cell_size", 0.01));

        bool needs_realloc = false;
        std::string req_device = msg.value("device", "cuda");
        if (!solver_3d) {
            needs_realloc = true;
        } else if (solver_3d->isMultiMaterial() != is_multimat_needed) {
            needs_realloc = true;
        } else if (solver_3d->isCUDA() != is_cuda_device(req_device)) {
            needs_realloc = true;
        } else if (solver_3d->getNx() != req_nx || solver_3d->getNy() != req_ny || solver_3d->getNz() != req_nz || std::abs(solver_3d->getCellSize() - req_cellSize) > 1e-6) {
            needs_realloc = true;
        }

        if (needs_realloc) {
            std::cout << "[INFO] Allocating/Reallocating 3D solver for REMAP_2D: current solver=" 
                      << (solver_3d ? (solver_3d->isMultiMaterial() ? "MultiMaterial" : "SingleMaterial") : "null")
                      << " needed IsMultiMaterial=" << is_multimat_needed << std::endl;
            emit_kernel_log("REMAP_2D", std::string("3D Solver Engine allocated: ") + (is_multimat_needed ? "Multi-Material JWL" : "Single-Material Ideal Gas") + " on " + req_device, 0.0, "3d");
            int nx_val = req_nx;
            int ny_val = req_ny;
            int nz_val = req_nz;
            double cellSize = req_cellSize;
            double xmin = msg.value("xmin_3d", msg.value("xmin", 0.0));
            double ymin = msg.value("ymin_3d", msg.value("ymin", 0.0));
            double zmin = msg.value("zmin_3d", msg.value("zmin", 0.0));
            std::string device = msg.value("device", "cuda");
            std::string precision = msg.value("precision", "single");

            select_cuda_device(device);
            if (is_cuda_device(device)) {
                if (precision == "double") {
                    if (is_multimat_needed) global_solver_3d = std::make_unique<CFDSolver3DCuda<double, true>>(nx_val, ny_val, nz_val, cellSize, xmin, ymin, zmin);
                    else global_solver_3d = std::make_unique<CFDSolver3DCuda<double, false>>(nx_val, ny_val, nz_val, cellSize, xmin, ymin, zmin);
                } else {
                    if (is_multimat_needed) global_solver_3d = std::make_unique<CFDSolver3DCuda<float, true>>(nx_val, ny_val, nz_val, cellSize, xmin, ymin, zmin);
                    else global_solver_3d = std::make_unique<CFDSolver3DCuda<float, false>>(nx_val, ny_val, nz_val, cellSize, xmin, ymin, zmin);
                }
            } else {
                if (precision == "double") {
                    if (is_multimat_needed) global_solver_3d = std::make_unique<CFDSolver3DImpl<double, true>>(nx_val, ny_val, nz_val, cellSize, xmin, ymin, zmin);
                    else global_solver_3d = std::make_unique<CFDSolver3DImpl<double, false>>(nx_val, ny_val, nz_val, cellSize, xmin, ymin, zmin);
                } else {
                    if (is_multimat_needed) global_solver_3d = std::make_unique<CFDSolver3DImpl<float, true>>(nx_val, ny_val, nz_val, cellSize, xmin, ymin, zmin);
                    else global_solver_3d = std::make_unique<CFDSolver3DImpl<float, false>>(nx_val, ny_val, nz_val, cellSize, xmin, ymin, zmin);
                }
            }
            solver_3d = global_solver_3d.get();
        }

        if (solver_3d && !states_2d.empty()) {
            auto map_bc_3d = [](const std::string& str) {
                if (str == "Terminate" || str == "OUTFLOW_RIEMANN" || str == "Riemann" || str == "NonReflecting" || str == "Absorbing" || str == "Lysmer" || str == "Transmitting" || str == "TRANSMISSIVE") return BCType3D::OUTFLOW_RIEMANN;
                if (str == "Outflow" || str == "Neumann") return BCType3D::TRANSMISSIVE;
                return BCType3D::REFLECTIVE;
            };
            solver_3d->setBoundaryConditions(
                map_bc_3d(msg.value("bc_x_min", "Reflecting")), map_bc_3d(msg.value("bc_x_max", "Transmitting")),
                map_bc_3d(msg.value("bc_y_min", "Reflecting")), map_bc_3d(msg.value("bc_y_max", "Transmitting")),
                map_bc_3d(msg.value("bc_z_min", "Reflecting")), map_bc_3d(msg.value("bc_z_max", "Transmitting"))
            );

            solver_3d->setGamma(gamma_val);
            solver_3d->setIdealGas(is_ideal_gas_val);
            solver_3d->setMaterialParameters(matSet_val);
            solver_3d->setAmbientState(amb_rho_val, amb_p_val);
            if (msg.contains("charge_radius")) {
                solver_3d->setChargeRadius(msg.value("charge_radius", 0.05));
            }
            double start_time = msg.value("time", msg.value("sim_time", 0.0));
            solver_3d->initializeFrom2D(nr, nz, dr, dz, states_2d, explosive_x, explosive_y, explosive_z, remap_radius, source_explosive_z);
            solver_3d->setTime(start_time);
            global_t3d = start_time;
            global_wallclock_3d = 0.0;
            emit_kernel_log("REMAP_2D", "2D->3D remap applied successfully.", start_time, "3d");
            emit_telemetry_3d(global_t3d, false);
        }
    }
}

void init_3d_thread_func(nlohmann::json msg) {
    sim3d_init_in_progress = true;
    try {
        double cellSize = get_json_double(msg, "cell_size", 0.01);
        double xmin = get_json_double(msg, "xmin", 0.0);
        double ymin = get_json_double(msg, "ymin", 0.0);
        double zmin = get_json_double(msg, "zmin", 0.0);
        double xmax = get_json_double(msg, "xmax", xmin + 1.0);
        double ymax = get_json_double(msg, "ymax", ymin + 1.0);
        double zmax = get_json_double(msg, "zmax", zmin + 1.0);
        int default_nx = std::max(1, static_cast<int>(std::round((xmax - xmin) / cellSize)));
        int default_ny = std::max(1, static_cast<int>(std::round((ymax - ymin) / cellSize)));
        int default_nz = std::max(1, static_cast<int>(std::round((zmax - zmin) / cellSize)));
        int nx = get_json_int(msg, "nx", default_nx);
        int ny = get_json_int(msg, "ny", default_ny);
        int nz = get_json_int(msg, "nz", default_nz);
        if (nx <= 0) nx = default_nx;
        if (ny <= 0) ny = default_ny;
        if (nz <= 0) nz = default_nz;
        std::string device = msg.value("device", "cpu");

        std::string init_mode = msg.value("init_mode", "Multi-Material JWL");
        std::string explosive_type = msg.value("explosive_type", "");
        std::string material_type = msg.value("material_type", "");
        bool is_ideal_gas_3d = (get_json_bool(msg, "is_ideal_gas", false) || init_mode == "Ideal Gas" || explosive_type == "MaterialIdealGas" || material_type == "Ideal Gas Charge");
        bool is_multimat = !is_ideal_gas_3d;

        global_enable_gauges = (msg.value("enable_gauges", "Enabled") != "Disabled");
        global_enable_vtk = (msg.value("enable_vtk", "Disabled") == "Enabled");
        // Parse VTK config early so tessellate_stl_faces / tessellation_max_edge are
        // populated before the subdivision step below.
        parse_vtk_config(msg);
        std::string telem_mode = msg.value("telemetry_mode", "Enabled");
        if (telem_mode == "Disabled") {
            global_telemetry_enabled = false;
        } else if (telem_mode == "Throttled (1 Hz)") {
            global_telemetry_enabled = true;
            global_telemetry_interval_ms = 1000;
        } else if (telem_mode == "Throttled (0.2 Hz)") {
            global_telemetry_enabled = true;
            global_telemetry_interval_ms = 5000;
        } else {
            global_telemetry_enabled = true;
            int interval_param = msg.value("telemetry_interval_ms", 100);
            if (interval_param > 0) global_telemetry_interval_ms = interval_param;
        }

        global_endtime_3d = msg.value("endtime", 1.0);

        std::unique_ptr<CFDSolver3D> local_solver_3d = nullptr;
        std::string precision = msg.value("precision", "single");
        select_cuda_device(device);

        bool is_cuda = is_cuda_device(device);
        bool is_double = (precision != "single" && precision != "float");
        auto est = Blast::estimateCFD3DMemory(nx, ny, nz, is_cuda, is_double, is_multimat);
        Blast::validateMemoryBudget(est.ram_bytes, est.vram_bytes, is_cuda, "3D CFD Solver");

        if (is_cuda) {
            if (precision == "single" || precision == "float") {
                if (is_multimat) {
                    local_solver_3d = std::make_unique<CFDSolver3DCuda<float, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                } else {
                    local_solver_3d = std::make_unique<CFDSolver3DCuda<float, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                }
            } else {
                if (is_multimat) {
                    local_solver_3d = std::make_unique<CFDSolver3DCuda<double, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                } else {
                    local_solver_3d = std::make_unique<CFDSolver3DCuda<double, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                }
            }
        } else {
            if (precision == "single" || precision == "float") {
                if (is_multimat) {
                    local_solver_3d = std::make_unique<CFDSolver3DImpl<float, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                } else {
                    local_solver_3d = std::make_unique<CFDSolver3DImpl<float, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                }
            } else {
                if (is_multimat) {
                    local_solver_3d = std::make_unique<CFDSolver3DImpl<double, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                } else {
                    local_solver_3d = std::make_unique<CFDSolver3DImpl<double, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                }
            }
        }



        std::string flux_scheme = msg.value("flux_scheme", "AUSM+");
        int spatial_order = 2;
        int temporal_order = 4;
        parse_cfd_space_time_scheme(msg, spatial_order, temporal_order, 4);

        local_solver_3d->setFluxScheme(flux_scheme);
        local_solver_3d->setSpatialOrder(spatial_order);
        local_solver_3d->setTemporalOrder(temporal_order);
        apply_cfd_tait_config(msg, local_solver_3d.get());

        Charge3DParams cp;
        std::string shape_str = msg.value("charge_shape", "Sphere");
        if (shape_str == "Sphere") cp.shape_type = 0;
        else if (shape_str == "Block") cp.shape_type = 1;
        else cp.shape_type = 2; // Cylinder
        cp.x = msg.value("charge_x", 0.0);
        cp.y = msg.value("charge_y", 0.0);
        cp.z = msg.value("charge_z", 0.0);
        cp.radius = msg.value("charge_radius", 0.1);
        cp.height = msg.value("charge_height", 0.2);
        if (msg.contains("charge_aspect_ratio") && !msg.contains("charge_height")) {
            double ar = msg.value("charge_aspect_ratio", 1.0);
            if (ar > 0.0) cp.height = 2.0 * cp.radius * ar;
        }
        cp.lx = msg.value("charge_lx", 0.1);
        cp.ly = msg.value("charge_ly", 0.1);
        cp.lz = msg.value("charge_lz", 0.1);
        cp.rot_x = msg.value("charge_rot_x", msg.value("rot_x", 0.0));
        cp.rot_y = msg.value("charge_rot_y", msg.value("rot_y", 0.0));
        cp.rot_z = msg.value("charge_rot_z", msg.value("rot_z", 0.0));

        if (init_mode == "From1D" || init_mode == "From2D") {
            cp.radius = 0.0;
            cp.lx = 0.0;
            cp.ly = 0.0;
            cp.lz = 0.0;
        }

        MultiMat::MaterialSet matSet = parseMaterialSet(msg);

        double ambient_rho = msg.value("ambient_rho", 1.225648589);
        double ambient_p = msg.value("atm_pressure", 101325.0);

        double dx = get_json_double(msg, "trigger_x", get_json_double(msg, "detonator_x", cp.x));
        double dy = get_json_double(msg, "trigger_y", get_json_double(msg, "detonator_y", cp.y));
        double dz = get_json_double(msg, "trigger_z", get_json_double(msg, "detonator_z", cp.z));
        local_solver_3d->setDetonatorLocation(dx, dy, dz);

        if (init_mode == "Hydrostatic_Stratified_3D" || init_mode == "hydrostatic_stratified_3d" || get_json_bool(msg, "stratified_equilibrium", false)) {
            Blast::Stratified3DParams strat = parse_stratified_params(msg, ambient_rho, ambient_p);
            double gx = get_json_double(msg, "gravity_x", get_json_double(msg, "gx", 0.0));
            double gy = get_json_double(msg, "gravity_y", get_json_double(msg, "gy", 0.0));
            double gz = strat.gravity_z;
            local_solver_3d->setGravity(gx, gy, gz);
            local_solver_3d->setStratifiedInitialCondition(cp, matSet, strat);
        } else {
            if (msg.contains("gravity_z") || msg.contains("gz") || msg.contains("gravity_y") || msg.contains("gy") || msg.contains("gravity_x") || msg.contains("gx")) {
                double gx = get_json_double(msg, "gravity_x", get_json_double(msg, "gx", 0.0));
                double gy = get_json_double(msg, "gravity_y", get_json_double(msg, "gy", 0.0));
                double gz = get_json_double(msg, "gravity_z", get_json_double(msg, "gz", 0.0));
                local_solver_3d->setGravity(gx, gy, gz);
            }
            local_solver_3d->setInitialCondition(cp, matSet, ambient_rho, ambient_p);
        }

        auto map_bc_3d = [](const std::string& str) {
            if (str == "Terminate" || str == "TERMINATE" || str == "terminate") return BCType3D::TERMINATE;
            if (str == "OUTFLOW_RIEMANN" || str == "Riemann" || str == "NonReflecting" || str == "Absorbing" || str == "Lysmer" || str == "Transmitting" || str == "TRANSMISSIVE") return BCType3D::OUTFLOW_RIEMANN;
            if (str == "Outflow" || str == "Neumann") return BCType3D::TRANSMISSIVE;
            return BCType3D::REFLECTIVE;
        };
        local_solver_3d->setBoundaryConditions(
            map_bc_3d(msg.value("bc_x_min", "Reflecting")), map_bc_3d(msg.value("bc_x_max", "Transmitting")),
            map_bc_3d(msg.value("bc_y_min", "Reflecting")), map_bc_3d(msg.value("bc_y_max", "Transmitting")),
            map_bc_3d(msg.value("bc_z_min", "Reflecting")), map_bc_3d(msg.value("bc_z_max", "Transmitting"))
        );

        std::string stl_file = msg.value("stl_file", "");
        std::string geometry_hash = msg.value("geometry_hash", "");
        std::string voxel_method = msg.value("voxelization_method", "watertight_floodfill");

        // Progress reporting lambda
        int last_percent_logged = -10;
        auto progress_callback = [&](double progress) {
            int percent = static_cast<int>(progress * 100.0);
            // Send JSON progress report to stdout for the UI
            nlohmann::json prog_report;
            prog_report["type"] = "progress";
            prog_report["percent"] = percent;
            prog_report["scope"] = "3d";
            prog_report["mode"] = "INIT_3D";
            {
                std::lock_guard<std::mutex> lock(cout_mutex);
                std::cout << prog_report.dump() << std::endl;
            }

            // Also output periodic text telemetry system log in 10% steps
            if (percent - last_percent_logged >= 10 || percent == 100) {
                last_percent_logged = percent;
                std::string log_msg = "Voxelization progress: " + std::to_string(percent) + "%";
                emit_kernel_log("SYSTEM", log_msg, 0.0, "3d");
            }
        };

        if (sim3d_terminate.load()) {
            sim3d_init_in_progress = false;
            return;
        }

        global_raw_stl_triangles.clear();
        global_tessellated_stl_triangles.clear();
        clear_vtu_mesh_cache(); // invalidate any stale cached geometry from a previous run
        if (msg.contains("primitives") && msg["primitives"].is_array() && !msg["primitives"].empty()) {
            global_raw_stl_triangles = generate_primitives_triangles(msg["primitives"]);
            local_solver_3d->setGeometryTriangles(global_raw_stl_triangles, geometry_hash, voxel_method, &sim3d_terminate, progress_callback);
        } else {
            if (!stl_file.empty()) {
                try {
                    auto raw_tris = read_stl(stl_file);
                    std::string stl_origin_mode = msg.value("stl_origin_mode", "CAD Origin");
                    float stl_scale_x = static_cast<float>(get_json_double(msg, "stl_scale_x", 1.0));
                    float stl_scale_y = static_cast<float>(get_json_double(msg, "stl_scale_y", 1.0));
                    float stl_scale_z = static_cast<float>(get_json_double(msg, "stl_scale_z", 1.0));
                    float stl_pos_x = static_cast<float>(get_json_double(msg, "stl_pos_x", 0.0));
                    float stl_pos_y = static_cast<float>(get_json_double(msg, "stl_pos_y", 0.0));
                    float stl_pos_z = static_cast<float>(get_json_double(msg, "stl_pos_z", 0.0));
                    float stl_rot_x = static_cast<float>(get_json_double(msg, "stl_rot_x", 0.0));
                    float stl_rot_y = static_cast<float>(get_json_double(msg, "stl_rot_y", 0.0));
                    float stl_rot_z = static_cast<float>(get_json_double(msg, "stl_rot_z", 0.0));

                    global_raw_stl_triangles = transform_triangles(
                        raw_tris,
                        stl_scale_x, stl_scale_y, stl_scale_z,
                        stl_pos_x, stl_pos_y, stl_pos_z,
                        stl_rot_x, stl_rot_y, stl_rot_z,
                        stl_origin_mode
                    );
                    std::cout << "[INFO] Loaded and transformed " << global_raw_stl_triangles.size()
                              << " STL triangles (origin_mode: " << stl_origin_mode
                              << ", scale: [" << stl_scale_x << ", " << stl_scale_y << ", " << stl_scale_z << "]"
                              << ", pos: [" << stl_pos_x << ", " << stl_pos_y << ", " << stl_pos_z << "]"
                              << ", rot: [" << stl_rot_x << ", " << stl_rot_y << ", " << stl_rot_z << "])" << std::endl;
                } catch (const std::exception& e) {
                    std::cerr << "[WARNING] Failed to load/transform STL: " << e.what() << std::endl;
                }
            }
            local_solver_3d->setGeometryTriangles(global_raw_stl_triangles, geometry_hash, voxel_method, &sim3d_terminate, progress_callback);
        }

        if (global_vtk_config.export_stl_faces && global_vtk_config.tessellate_stl_faces && !global_raw_stl_triangles.empty()) {
            double effective_max_edge = (global_vtk_config.tessellation_max_edge > 0.0)
                ? global_vtk_config.tessellation_max_edge
                : cellSize;
            std::cout << "[INFO] Adaptive multi-core tessellation of " << global_raw_stl_triangles.size()
                      << " CAD STL triangles (target max edge: " << effective_max_edge << " m)..." << std::endl;
            global_tessellated_stl_triangles = subdivide_triangles_to_cell_size(global_raw_stl_triangles, effective_max_edge);
            std::cout << "[INFO] STL tessellation completed: " << global_tessellated_stl_triangles.size() << " facets generated." << std::endl;
            emit_kernel_log("SYSTEM", "Tessellated CAD geometry from " + std::to_string(global_raw_stl_triangles.size()) + " to " + std::to_string(global_tessellated_stl_triangles.size()) + " facets.", 0.0, "3d");
        }

        if (sim3d_terminate.load()) {
            std::cout << "[INFO] 3D initialization terminated/cancelled." << std::endl;
            sim3d_init_in_progress = false;
            return;
        }

        std::cout << "[DEBUG] Voxelization finished. Generating obstacle mesh..." << std::endl;
        // Generate obstacle faces mesh and pass them to solver
        generateObstacleMesh(nx, ny, nz, cellSize, xmin, ymin, zmin);
        std::cout << "[DEBUG] Obstacle mesh generated with " << global_obstacle_faces.size() << " faces. Uploading..." << std::endl;
        local_solver_3d->uploadObstacleFaces(global_obstacle_faces);

        // Check if a REMAP command arrived while voxelization was running
        {
            std::lock_guard<std::mutex> lock(g_pending_remap_mutex);
            if (g_pending_remap.has_pending) {
                if (init_mode == "From1D" || init_mode == "From2D") {
                    std::cout << "[INFO] Applying queued pending " << g_pending_remap.type << " remap onto 3D solver..." << std::endl;
                    apply_remap_payload(g_pending_remap.msg, g_pending_remap.type, local_solver_3d.get(), nullptr, nullptr);
                } else {
                    std::cout << "[INFO] Ignoring queued pending remap because solver init_mode is '" << init_mode << "'." << std::endl;
                }
                g_pending_remap.has_pending = false;
            }
        }

        std::cout << "[DEBUG] Obstacle faces uploaded. Committing solver..." << std::endl;
        // Commit to global solver
        global_solver_3d = std::move(local_solver_3d);

        std::cout << "[DEBUG] Solver committed. Sending mesh to frontend..." << std::endl;
        // Broadcast obstacle mesh JSON to frontend
        sendObstacleMeshToFrontend(msg.value("modelId", ""));

        std::cout << "[DEBUG] Mesh sent. Initializing phase tracking particles and gauges..." << std::endl;
        setup_phase_tracking_particles_3d(msg);
        init_gauges(msg);
        std::string precision_str = msg.value("precision", "single");
        std::string device_str = msg.value("device", "cpu");
        std::string engine_str = (is_multimat ? "Multi-Material JWL" : "Single-Material Ideal Gas");
        emit_kernel_log("SYSTEM", "3D Solver Initialized: " + engine_str + " on " + device_str + " (" + precision_str + ")", 0.0, "3d");
        emit_telemetry_3d(0.0, false);
    } catch (const std::exception& e) {
        std::cerr << "[ERROR] Exception in 3D solver initialization thread: " << e.what() << std::endl;
        emit_kernel_log("ERROR", std::string("Initialization failed: ") + e.what(), 0.0, "3d");
        std::lock_guard<std::mutex> lock(g_pending_exec_3d_mutex);
        g_pending_exec_3d.has_pending = false;
    } catch (...) {
        std::cerr << "[ERROR] Unknown exception in 3D solver initialization thread" << std::endl;
        emit_kernel_log("ERROR", "Initialization failed with unknown error", 0.0, "3d");
        std::lock_guard<std::mutex> lock(g_pending_exec_3d_mutex);
        g_pending_exec_3d.has_pending = false;
    }
    sim3d_init_in_progress = false;

    // Check if a STEP_3D or EXEC_ALL_3D command was queued while initialization was running
    {
        std::lock_guard<std::mutex> lock(g_pending_exec_3d_mutex);
        if (g_pending_exec_3d.has_pending && global_solver_3d && !sim3d_terminate.load()) {
            std::string cmd = g_pending_exec_3d.command;
            nlohmann::json p_msg = g_pending_exec_3d.msg;
            g_pending_exec_3d.has_pending = false;
            emit_kernel_log("INFO", "Executing queued " + cmd + " after 3D initialization completed.", 0.0, "3d");
            if (cmd == "STEP_3D") {
                init_gauges(p_msg);
                int steps = p_msg.value("steps", 1);
                global_cfl_3d = p_msg.value("cfl", 0.6);
                if (p_msg.contains("endtime")) global_endtime_3d = p_msg.value("endtime", 1.0);
                global_exec_until_end_3d = false;
                if (!sim3d_running) {
                    global_target_steps_3d = steps;
                    sim3d_running = true;
                    sim3d_paused = false;
                    sim3d_terminate = false;
                    std::thread(worker_3d_thread_func).detach();
                } else {
                    global_target_steps_3d.fetch_add(steps);
                    sim3d_paused = false;
                }
            } else if (cmd == "EXEC_ALL_3D") {
                init_gauges(p_msg);
                global_cfl_3d = p_msg.value("cfl", 0.6);
                if (p_msg.contains("endtime")) global_endtime_3d = p_msg.value("endtime", 1.0);
                global_exec_until_end_3d = true;
                if (!sim3d_running) {
                    sim3d_running = true;
                    sim3d_paused = false;
                    sim3d_terminate = false;
                    std::thread(worker_3d_thread_func).detach();
                } else {
                    sim3d_paused = false;
                }
            }
        }
    }
}

void worker_3d_thread_func() {
    cudaSetDevice(global_cuda_device_index);
    emit_kernel_log("INFO", "3D worker thread started.", global_t3d, "3d");

    if (!global_solver_3d) {
        emit_kernel_log("ERROR", "3D worker: no solver available.", 0.0, "3d");
        sim3d_running = false;
        return;
    }
    try {
        auto last_telemetry_time = std::chrono::steady_clock::now();
    int initial_steps = global_target_steps_3d.load();
    int step_count = 0;
    double last_dt = (global_dt_3d > 1.0e-12) ? global_dt_3d : 0.0;
    double interval_compute_ms = 0.0;
    double interval_io_ms = 0.0;
    int interval_steps = 0;

    while (sim3d_running) {
        if (sim3d_terminate) break;

        if (sim3d_paused) {
            std::this_thread::sleep_for(std::chrono::milliseconds(30));
            continue;
        }

        bool done = false;
        double end_time = global_endtime_3d.load();
        if (end_time > 0.0 && global_t3d >= end_time - 1e-12) {
            done = true;
        } else if (global_solver_3d->is_terminated()) {
            emit_kernel_log("SYSTEM", "Shock wave reached Terminate boundary. Terminating simulation.", global_t3d, "3d");
            done = true;
        } else if (!global_exec_until_end_3d.load()) {
            if (global_target_steps_3d.load() <= 0) done = true;
        }

        if (done) break;

        auto step_start = std::chrono::steady_clock::now();
        double dt = global_solver_3d->computeStepSize(global_cfl_3d.load());
        if (global_step_3d.load() == 0 && step_count == 0) {
            dt = 0.5 * dt;
        } else if (last_dt > 0.0) {
            dt = std::min(dt, 1.5 * last_dt);
        }
        if (end_time > 0.0 && global_t3d + dt > end_time) {
            dt = std::max(1e-12, end_time - global_t3d);
        }
        dt = std::max(dt, 1.0e-11);
        global_solver_3d->step(dt);
        if (global_phase_particles_3d && global_phase_particles_3d->getParticleCount() > 0) {
            step_phase_tracking_particles_3d(static_cast<float>(dt));
        }
        auto step_end = std::chrono::steady_clock::now();
        double comp_ms = std::chrono::duration<double, std::milli>(step_end - step_start).count();
        interval_compute_ms += comp_ms;
        global_cum_compute_s = global_cum_compute_s.load() + (comp_ms * 0.001);
        global_wallclock_3d = global_wallclock_3d.load() + (comp_ms * 0.001);
        global_dt_3d = dt;
        last_dt = dt;
        global_t3d += dt;

        global_step_3d++;
        step_count++;

        auto io_start = std::chrono::steady_clock::now();
        if (global_enable_gauges.load()) {
            record_gauges_3d(global_t3d);
        }

        if (global_enable_vtk.load()) {
            double last_time = global_last_vtk_time_3d.load();
            if (should_write_vtk(global_step_3d.load(), global_t3d, last_time)) {
                write_vtk_outputs(global_step_3d.load(), global_t3d);
                update_last_vtk_time(global_last_vtk_time_3d, global_t3d);
            }
        }
        auto io_end = std::chrono::steady_clock::now();
        double io_step_ms = std::chrono::duration<double, std::milli>(io_end - io_start).count();
        interval_io_ms += io_step_ms;
        global_cum_io_s = global_cum_io_s.load() + (io_step_ms * 0.001);
        interval_steps++;

        if (!global_exec_until_end_3d.load()) {
            global_target_steps_3d--;
        }

        if (global_telemetry_enabled.load()) {
            auto now = std::chrono::steady_clock::now();
            auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
            int target_interval_ms = std::max(16, global_telemetry_interval_ms.load());
            bool should_emit = (elapsed_ms >= target_interval_ms);
            if (should_emit) {
                int steps_in_interval = std::max(1, interval_steps);
                global_last_compute_ms = interval_compute_ms / steps_in_interval;
                global_last_io_ms = interval_io_ms / steps_in_interval;
                interval_compute_ms = 0.0;
                interval_io_ms = 0.0;
                interval_steps = 0;

                auto comms_start = std::chrono::steady_clock::now();
                emit_telemetry_3d(global_t3d, false, global_step_3d.load());
                auto comms_end = std::chrono::steady_clock::now();
                double comms_ms = std::chrono::duration<double, std::milli>(comms_end - comms_start).count();
                global_last_comms_ms = comms_ms;
                global_cum_comms_s = global_cum_comms_s.load() + (comms_ms * 0.001);
                last_telemetry_time = now;

                nlohmann::json progress_msg;
                progress_msg["type"] = "progress";
                progress_msg["sim_time"] = global_t3d;
                progress_msg["step"] = global_step_3d.load();
                progress_msg["scope"] = "3d";
                progress_msg["dt"] = global_dt_3d;

                if (global_exec_until_end_3d.load()) {
                    if (end_time > 0.0) {
                        int percent = std::clamp((int)((global_t3d / end_time) * 100.0), 0, 99);
                        step_progress_3d = percent;
                        progress_msg["percent"] = percent;
                    } else {
                        progress_msg["percent"] = 50;
                    }
                    progress_msg["mode"] = "EXEC_ALL_3D";
                } else {
                    initial_steps = std::max(initial_steps, step_count + global_target_steps_3d.load());
                    if (initial_steps > 0) {
                        int completed = initial_steps - global_target_steps_3d.load();
                        int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 99);
                        step_progress_3d = percent;
                        progress_msg["percent"] = percent;
                        progress_msg["completed"] = completed;
                        progress_msg["total"] = initial_steps;
                        progress_msg["mode"] = "STEP_3D";
                    }
                }
                std::lock_guard<std::mutex> lock(cout_mutex);
                std::cout << progress_msg.dump() << std::endl;
            }
        }
    }

    double final_end_time = global_endtime_3d.load();
    bool reached_end = (final_end_time > 0.0 && global_t3d >= final_end_time - 1e-12);
    bool term_3d = !reached_end && global_solver_3d->is_terminated();
    emit_telemetry_3d(global_t3d, term_3d, global_step_3d.load());
    flush_async_telemetry();

    nlohmann::json progress_msg;
    progress_msg["type"] = "progress";
    progress_msg["sim_time"] = global_t3d;
    progress_msg["step"] = global_step_3d.load();
    progress_msg["scope"] = "3d";
    progress_msg["percent"] = 100;
    progress_msg["is_terminated"] = term_3d;
    progress_msg["mode"] = global_exec_until_end_3d.load() ? "EXEC_ALL_3D" : "STEP_3D";
    {
        std::lock_guard<std::mutex> lock(cout_mutex);
        std::cout << progress_msg.dump() << std::endl;
    }

    step_progress_3d = 100;
    if (term_3d) {
        emit_kernel_log("SYSTEM", "3D simulation terminated at Terminate boundary.", global_t3d, "3d", global_step_3d.load());
    } else if (reached_end) {
        emit_kernel_log("INFO", "Reached simulation end time (" + std::to_string(final_end_time) + " s). Simulation paused.", global_t3d, "3d", global_step_3d.load());
    } else {
        emit_kernel_log("INFO", "3D worker thread execution cycle ended.", global_t3d, "3d", global_step_3d.load());
    }

    write_gauge_files();
    if (global_enable_vtk.load() && reached_end && should_write_final_vtk(global_t3d, global_last_vtk_time_3d.load())) {
        write_vtk_outputs(global_step_3d.load(), global_t3d);
        update_last_vtk_time(global_last_vtk_time_3d, global_t3d);
    }

        sim3d_running = false;
        sim3d_paused = false;
        sim3d_terminate = false;
        global_target_steps_3d = 0;
        global_exec_until_end_3d = false;
    } catch (const std::exception& e) {
        emit_kernel_log("ERROR", std::string("3D worker thread error: ") + e.what(), global_t3d, "3d");
        sim3d_running = false;
        std::exit(1);
    } catch (...) {
        emit_kernel_log("ERROR", "3D worker thread error: unknown exception", global_t3d, "3d");
        sim3d_running = false;
        std::exit(1);
    }
}

void worker_2d_thread_func() {
    cudaSetDevice(global_cuda_device_index);
    emit_kernel_log("INFO", "2D worker thread started.", global_t2d, "2d");

    if (!has_solver_2d()) {
        emit_kernel_log("ERROR", "2D worker: no solver available.", 0.0, "2d");
        sim2d_running = false;
        return;
    }
    try {
        auto last_telemetry_time = std::chrono::steady_clock::now();
    int initial_steps = global_target_steps_2d.load();
    int step_count = 0;
    double last_dt = (global_dt_2d > 1.0e-12) ? global_dt_2d : 0.0;
    double interval_compute_ms = 0.0;
    double interval_io_ms = 0.0;
    int interval_steps = 0;

    while (sim2d_running) {
        if (sim2d_terminate) break;

        if (sim2d_paused) {
            std::this_thread::sleep_for(std::chrono::milliseconds(30));
            continue;
        }

        bool done = false;
        double end_time = global_endtime_2d.load();
        bool terminated_2d = false;
        if (global_solver_2d_cuda) terminated_2d = global_solver_2d_cuda->checkTerminationCondition();
        else if (global_solver_2d) terminated_2d = global_solver_2d->checkTerminationCondition();

        if (end_time > 0.0 && global_t2d >= end_time - 1e-12) {
            done = true;
        } else if (terminated_2d) {
            emit_kernel_log("SYSTEM", "Shock wave reached Terminate boundary. Terminating simulation.", global_t2d, "2d");
            done = true;
        } else if (!global_exec_until_end_2d.load()) {
            if (global_target_steps_2d.load() <= 0) done = true;
        }

        if (done) break;

        auto step_start = std::chrono::steady_clock::now();
        double dt = 0.0;
        int steps_this_batch = 1;
        if (global_solver_2d_cuda) {
            if (global_is_amr_2d) {
                int batch_size = 20;
                if (!global_exec_until_end_2d.load()) {
                    int remaining = global_target_steps_2d.load();
                    if (remaining > 0 && remaining < batch_size) batch_size = remaining;
                }
                dt = global_solver_2d_cuda->stepBatch(batch_size, global_cfl_2d.load());
                steps_this_batch = batch_size;
                step_count += (batch_size - 1);
                global_step_2d += (batch_size - 1);
                if (!global_exec_until_end_2d.load()) {
                    global_target_steps_2d -= (batch_size - 1);
                }
            } else {
                double max_s = global_solver_2d_cuda->getMaxWaveSpeed();
                dt = global_cfl_2d.load() * std::min(global_solver_2d_cuda->getDr(), global_solver_2d_cuda->getDz()) / max_s;
                if (global_step_2d.load() == 0 && step_count == 0) {
                    dt = 0.5 * dt;
                } else if (last_dt > 0.0) {
                    dt = std::min(dt, 1.5 * last_dt);
                }
                if (end_time > 0.0 && global_t2d + dt > end_time) {
                    dt = std::max(1e-12, end_time - global_t2d);
                }
                global_solver_2d_cuda->step(dt);
            }
        } else if (global_solver_2d) {
            dt = global_solver_2d->computeStepSize(global_cfl_2d.load());
            if (global_step_2d.load() == 0 && step_count == 0) {
                dt = 0.5 * dt;
            } else if (last_dt > 0.0) {
                dt = std::min(dt, 1.5 * last_dt);
            }
            if (end_time > 0.0 && global_t2d + dt > end_time) {
                dt = std::max(1e-12, end_time - global_t2d);
            }
            global_solver_2d->step(dt);
        }
        auto step_end = std::chrono::steady_clock::now();
        double comp_ms = std::chrono::duration<double, std::milli>(step_end - step_start).count();
        interval_compute_ms += comp_ms;
        global_cum_compute_s = global_cum_compute_s.load() + (comp_ms * 0.001);
        global_wallclock_2d = global_wallclock_2d.load() + (comp_ms * 0.001);
        global_dt_2d = dt;
        last_dt = dt;
        global_t2d += dt;

        global_step_2d++;
        step_count++;

        auto io_start = std::chrono::steady_clock::now();
        record_gauges_2d(global_t2d);

        if (global_enable_vtk.load()) {
            double last_time = global_last_vtk_time_2d.load();
            if (should_write_vtk(global_step_2d.load(), global_t2d, last_time)) {
                write_vtk_outputs(global_step_2d.load(), global_t2d);
                update_last_vtk_time(global_last_vtk_time_2d, global_t2d);
            }
        }
        auto io_end = std::chrono::steady_clock::now();
        double io_step_ms = std::chrono::duration<double, std::milli>(io_end - io_start).count();
        interval_io_ms += io_step_ms;
        global_cum_io_s = global_cum_io_s.load() + (io_step_ms * 0.001);
        interval_steps += steps_this_batch;

        if (!global_exec_until_end_2d.load()) {
            global_target_steps_2d--;
        }

        auto now = std::chrono::steady_clock::now();
        auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
        int target_interval_ms = std::max(16, global_telemetry_interval_ms.load());
        bool should_emit = (elapsed_ms >= target_interval_ms);
        if (should_emit) {
            int steps_in_interval = std::max(1, interval_steps);
            global_last_compute_ms = interval_compute_ms / steps_in_interval;
            global_last_io_ms = interval_io_ms / steps_in_interval;
            interval_compute_ms = 0.0;
            interval_io_ms = 0.0;
            interval_steps = 0;

            auto comms_start = std::chrono::steady_clock::now();
            emit_telemetry_2d(global_t2d, false, global_step_2d.load());
            auto comms_end = std::chrono::steady_clock::now();
            double comms_ms = std::chrono::duration<double, std::milli>(comms_end - comms_start).count();
            global_last_comms_ms = comms_ms;
            global_cum_comms_s = global_cum_comms_s.load() + (comms_ms * 0.001);
            last_telemetry_time = now;

            nlohmann::json progress_msg;
            progress_msg["type"] = "progress";
            progress_msg["sim_time"] = global_t2d;
            progress_msg["step"] = global_step_2d.load();
            progress_msg["scope"] = "2d";
            progress_msg["dt"] = global_dt_2d;

            if (global_exec_until_end_2d.load()) {
                if (end_time > 0.0) {
                    int percent = std::clamp((int)((global_t2d / end_time) * 100.0), 0, 99);
                    step_progress_2d = percent;
                    progress_msg["percent"] = percent;
                } else {
                    progress_msg["percent"] = 50; // Indeterminate
                }
                progress_msg["mode"] = "EXEC_ALL_2D";
            } else {
                initial_steps = std::max(initial_steps, step_count + global_target_steps_2d.load());
                if (initial_steps > 0) {
                    int completed = initial_steps - global_target_steps_2d.load();
                    int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 99);
                    step_progress_2d = percent;
                    progress_msg["percent"] = percent;
                    progress_msg["completed"] = completed;
                    progress_msg["total"] = initial_steps;
                    progress_msg["mode"] = "STEP_2D";
                }
            }
            std::lock_guard<std::mutex> lock(cout_mutex);
            std::cout << progress_msg.dump() << std::endl;
        }
    }

    double final_end_time = global_endtime_2d.load();
    bool reached_end = (final_end_time > 0.0 && global_t2d >= final_end_time - 1e-12);
    bool term_2d = false;
    if (!reached_end) {
        if (global_solver_2d_cuda) term_2d = global_solver_2d_cuda->checkTerminationCondition();
        else if (global_solver_2d) term_2d = global_solver_2d->checkTerminationCondition();
    }
    emit_telemetry_2d(global_t2d, term_2d, global_step_2d.load());
    flush_async_telemetry();
    
    // Emit final 100% progress packet to transition frontend state to paused/complete/terminated
    nlohmann::json progress_msg;
    progress_msg["type"] = "progress";
    progress_msg["sim_time"] = global_t2d;
    progress_msg["step"] = global_step_2d.load();
    progress_msg["scope"] = "2d";
    progress_msg["percent"] = 100;
    progress_msg["is_terminated"] = term_2d;
    progress_msg["mode"] = global_exec_until_end_2d.load() ? "EXEC_ALL_2D" : "STEP_2D";
    {
        std::lock_guard<std::mutex> lock(cout_mutex);
        std::cout << progress_msg.dump() << std::endl;
    }
    
    step_progress_2d = 100;
    if (term_2d) {
        emit_kernel_log("SYSTEM", "2D simulation terminated at Terminate boundary.", global_t2d, "2d", global_step_2d.load());
    } else if (reached_end) {
        emit_kernel_log("INFO", "Reached simulation end time (" + std::to_string(final_end_time) + " s). Simulation paused.", global_t2d, "2d", global_step_2d.load());
    } else {
        emit_kernel_log("INFO", "2D worker thread execution cycle ended.", global_t2d, "2d", global_step_2d.load());
    }
    write_gauge_files();
    if (global_enable_vtk.load() && reached_end && should_write_final_vtk(global_t2d, global_last_vtk_time_2d.load())) {
        write_vtk_outputs(global_step_2d.load(), global_t2d);
        update_last_vtk_time(global_last_vtk_time_2d, global_t2d);
    }
        sim2d_running = false;
        sim2d_paused = false;
        sim2d_terminate = false;
        global_target_steps_2d = 0;
        global_exec_until_end_2d = false;
    } catch (const std::exception& e) {
        emit_kernel_log("ERROR", std::string("2D worker thread error: ") + e.what(), global_t2d, "2d");
        sim2d_running = false;
        std::exit(1);
    } catch (...) {
        emit_kernel_log("ERROR", "2D worker thread error: unknown exception", global_t2d, "2d");
        sim2d_running = false;
        std::exit(1);
    }
}

std::atomic<bool> sim_mpm_paused{false};
std::atomic<bool> sim_mpm_terminate{false};
std::atomic<bool> global_exec_until_end_mpm{false};
std::atomic<int> global_target_steps_mpm{0};
std::atomic<float> global_cfl_mpm{0.6f};
std::atomic<double> global_endtime_mpm{1.0};
std::atomic<double> global_refresh_rate_mpm{0.0};

void worker_mpm_2d_thread_func() {
    try {
        int step_count = 0;
        int initial_steps = 0;
        double interval_compute_ms = 0.0;
        double interval_io_ms = 0.0;
        int interval_steps = 0;
        auto last_telemetry_time = std::chrono::steady_clock::now();
        emit_kernel_log("INFO", "2D MPM asynchronous worker thread started.", 0.0, "mpm_2d", 0);

    while (!sim_mpm_terminate.load()) {
        if (sim_mpm_paused.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            continue;
        }

        bool done = false;
        double end_time = global_endtime_mpm.load();
        if (end_time > 0.0 && global_solver_mpm_2d && global_solver_mpm_2d->getSimTime() >= end_time - 1e-12) {
            done = true;
        } else if (global_solver_mpm_2d && global_solver_mpm_2d->is_terminated()) {
            done = true;
        } else if (!global_exec_until_end_mpm.load()) {
            if (global_target_steps_mpm.load() <= 0) done = true;
        }

        if (done) break;

        if (global_solver_mpm_2d) {
            auto step_start = std::chrono::steady_clock::now();
            float cfl = global_cfl_mpm.load();
            global_solver_mpm_2d->step(cfl);
            auto step_end = std::chrono::steady_clock::now();
            double comp_ms = std::chrono::duration<double, std::milli>(step_end - step_start).count();
            interval_compute_ms += comp_ms;
            global_cum_compute_s = global_cum_compute_s.load() + (comp_ms * 0.001);
            step_count++;
            interval_steps++;

            if (!global_exec_until_end_mpm.load()) {
                global_target_steps_mpm--;
                if (global_target_steps_mpm.load() <= 0) done = true;
            }
            if (global_solver_mpm_2d->is_terminated()) {
                done = true;
            }

            auto now = std::chrono::steady_clock::now();
            auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
            int user_interval = (global_telemetry_interval_ms.load() > 0) ? global_telemetry_interval_ms.load() : static_cast<int>(global_refresh_rate_mpm.load() * 1000.0);
            int target_interval_ms = std::max(16, user_interval);
            bool should_emit = (elapsed_ms >= target_interval_ms);

            if (should_emit || done) {
                double sim_time = global_solver_mpm_2d->getSimTime();
                int current_step = global_solver_mpm_2d->getStepCount();

                int steps_in_interval = std::max(1, interval_steps);
                global_last_compute_ms = interval_compute_ms / steps_in_interval;
                global_last_io_ms = interval_io_ms / steps_in_interval;
                interval_compute_ms = 0.0;
                interval_io_ms = 0.0;
                interval_steps = 0;

                auto comms_start = std::chrono::steady_clock::now();
                emit_telemetry_mpm_2d(sim_time, false, current_step);
                auto comms_end = std::chrono::steady_clock::now();
                double comms_ms = std::chrono::duration<double, std::milli>(comms_end - comms_start).count();
                global_last_comms_ms = comms_ms;
                global_cum_comms_s = global_cum_comms_s.load() + (comms_ms * 0.001);
                last_telemetry_time = now;

                char log_buf[256];
                snprintf(log_buf, sizeof(log_buf),
                         "Step %d | Time = %.4e s | dt = %.2e s | CFL = %.2f | v_max = %.1f m/s",
                         current_step,
                         sim_time,
                         global_solver_mpm_2d->getLastDt(),
                         global_solver_mpm_2d->getLastCFL(),
                         global_solver_mpm_2d->getMaxVelocity());
                emit_kernel_log("SYSTEM", log_buf, sim_time, "mpm_2d", current_step);

                nlohmann::json progress_msg;
                progress_msg["type"] = "progress";
                progress_msg["sim_time"] = sim_time;
                progress_msg["step"] = current_step;
                progress_msg["scope"] = "mpm_2d";
                progress_msg["dt"] = global_solver_mpm_2d->getLastDt();

                if (global_exec_until_end_mpm.load()) {
                    if (end_time > 0.0) {
                        int percent = std::clamp((int)((sim_time / end_time) * 100.0), 0, 99);
                        progress_msg["percent"] = percent;
                    } else {
                        progress_msg["percent"] = 50; // Indeterminate while running continuously
                    }
                    progress_msg["mode"] = "EXEC_ALL_MPM";
                } else {
                    initial_steps = std::max(initial_steps, step_count + global_target_steps_mpm.load());
                    if (initial_steps > 0) {
                        int completed = initial_steps - global_target_steps_mpm.load();
                        int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 99);
                        progress_msg["percent"] = percent;
                        progress_msg["completed"] = completed;
                        progress_msg["total"] = initial_steps;
                        progress_msg["mode"] = "STEP_MPM";
                    }
                }

                {
                    std::lock_guard<std::mutex> lock(cout_mutex);
                    std::cout << progress_msg.dump() << std::endl;
                }
            }

            // removed sleep
        } else {
            break;
        }
    }

    double final_sim_time = global_solver_mpm_2d ? global_solver_mpm_2d->getSimTime() : 0.0;
    int final_step = global_solver_mpm_2d ? global_solver_mpm_2d->getStepCount() : 0;
    double final_end_time = global_endtime_mpm.load();
    bool reached_end = (final_end_time > 0.0 && final_sim_time >= final_end_time - 1e-12);
    bool term_mpm_2d = !reached_end && global_solver_mpm_2d && global_solver_mpm_2d->is_terminated();
    emit_telemetry_mpm_2d(final_sim_time, term_mpm_2d, final_step);
    flush_async_telemetry();

    nlohmann::json progress_msg;
    progress_msg["type"] = "progress";
    progress_msg["sim_time"] = final_sim_time;
    progress_msg["step"] = final_step;
    progress_msg["scope"] = "mpm_2d";
    progress_msg["percent"] = 100;
    progress_msg["is_terminated"] = term_mpm_2d;
    progress_msg["mode"] = global_exec_until_end_mpm.load() ? "EXEC_ALL_MPM" : "STEP_MPM";
    {
        std::lock_guard<std::mutex> lock(cout_mutex);
        std::cout << progress_msg.dump() << std::endl;
    }

    if (term_mpm_2d) {
        emit_kernel_log("SYSTEM", "MPM particle reached Terminate boundary. Terminating simulation.", final_sim_time, "mpm_2d", final_step);
    } else if (reached_end) {
        emit_kernel_log("INFO", "Reached simulation end time (" + std::to_string(final_end_time) + " s). Simulation paused.", final_sim_time, "mpm_2d", final_step);
    }

        sim_mpm_running = false;
        sim_mpm_paused = false;
        sim_mpm_terminate = false;
        global_target_steps_mpm = 0;
        global_exec_until_end_mpm = false;
    } catch (const std::exception& e) {
        emit_kernel_log("ERROR", std::string("2D MPM worker thread error: ") + e.what(), 0.0, "mpm_2d");
        sim_mpm_running = false;
        std::exit(1);
    } catch (...) {
        emit_kernel_log("ERROR", "2D MPM worker thread error: unknown exception", 0.0, "mpm_2d");
        sim_mpm_running = false;
        std::exit(1);
    }
}

void worker_mpm_3d_thread_func() {
    cudaSetDevice(global_cuda_device_index);
    try {
        int step_count = 0;
        int initial_steps = global_target_steps_mpm_3d.load();
        double interval_compute_ms = 0.0;
        double interval_io_ms = 0.0;
        int interval_steps = 0;
        auto last_telemetry_time = std::chrono::steady_clock::now();

    double start_time = 0.0;
    if (global_solver_mpm_3d_cuda) start_time = global_solver_mpm_3d_cuda->getSimTime();
    else if (global_solver_mpm_3d) start_time = global_solver_mpm_3d->getSimTime();

    emit_kernel_log("INFO", "3D MPM asynchronous worker thread started.", start_time, "mpm_3d");

    while (sim_mpm_3d_running.load()) {
        if (sim_mpm_3d_terminate.load()) break;

        if (sim_mpm_3d_paused.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(30));
            continue;
        }

        bool done = false;
        double end_time = global_endtime_mpm_3d.load();
        double cur_time = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getSimTime() : (global_solver_mpm_3d ? global_solver_mpm_3d->getSimTime() : 0.0);
        bool is_term = (global_solver_mpm_3d_cuda && global_solver_mpm_3d_cuda->is_terminated()) ||
                       (global_solver_mpm_3d && global_solver_mpm_3d->is_terminated());
        if (end_time > 0.0 && cur_time >= end_time - 1e-12) {
            done = true;
        } else if (is_term) {
            done = true;
        } else if (!global_exec_until_end_mpm_3d.load()) {
            if (global_target_steps_mpm_3d.load() <= 0) done = true;
        }

        if (done) break;

        if (global_solver_mpm_3d_cuda) {
            auto step_start = std::chrono::steady_clock::now();
            float cfl = global_cfl_mpm_3d.load();
            global_solver_mpm_3d_cuda->step(cfl);
            auto step_end = std::chrono::steady_clock::now();
            double comp_ms = std::chrono::duration<double, std::milli>(step_end - step_start).count();
            interval_compute_ms += comp_ms;
            global_cum_compute_s = global_cum_compute_s.load() + (comp_ms * 0.001);
            step_count++;

            double sim_time = global_solver_mpm_3d_cuda->getSimTime();
            int current_step = global_solver_mpm_3d_cuda->getStepCount();

            auto io_start = std::chrono::steady_clock::now();
            if (global_enable_vtk.load()) {
                double last_time = global_last_vtk_time_mpm_3d.load();
                if (should_write_vtk(current_step, sim_time, last_time)) {
                    write_vtk_outputs(current_step, sim_time);
                    update_last_vtk_time(global_last_vtk_time_mpm_3d, sim_time);
                }
            }
            auto io_end = std::chrono::steady_clock::now();
            double io_step_ms = std::chrono::duration<double, std::milli>(io_end - io_start).count();
            interval_io_ms += io_step_ms;
            global_cum_io_s = global_cum_io_s.load() + (io_step_ms * 0.001);
            interval_steps++;

            if (!global_exec_until_end_mpm_3d.load()) {
                global_target_steps_mpm_3d--;
                if (global_target_steps_mpm_3d.load() <= 0) done = true;
            }
            if (global_solver_mpm_3d_cuda->is_terminated()) {
                done = true;
            }

            auto now = std::chrono::steady_clock::now();
            auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
            int user_interval = (global_telemetry_interval_ms.load() > 0) ? global_telemetry_interval_ms.load() : static_cast<int>(global_refresh_rate_mpm_3d.load() * 1000.0);
            int target_interval_ms = std::max(16, user_interval);
            bool should_emit = (elapsed_ms >= target_interval_ms);

            if (should_emit || done) {
                int steps_in_interval = std::max(1, interval_steps);
                global_last_compute_ms = interval_compute_ms / steps_in_interval;
                global_last_io_ms = interval_io_ms / steps_in_interval;
                interval_compute_ms = 0.0;
                interval_io_ms = 0.0;
                interval_steps = 0;

                auto comms_start = std::chrono::steady_clock::now();
                emit_telemetry_mpm_3d(sim_time, false, current_step);
                auto comms_end = std::chrono::steady_clock::now();
                double comms_ms = std::chrono::duration<double, std::milli>(comms_end - comms_start).count();
                global_last_comms_ms = comms_ms;
                global_cum_comms_s = global_cum_comms_s.load() + (comms_ms * 0.001);
                last_telemetry_time = now;

                char log_buf[256];
                snprintf(log_buf, sizeof(log_buf),
                         "Step %d | Time = %.4e s | dt = %.2e s | CFL = %.2f | v_max = %.1f m/s | Particles = %zu",
                         current_step,
                         sim_time,
                         global_solver_mpm_3d_cuda->getLastDt(),
                         global_solver_mpm_3d_cuda->getLastCFL(),
                         global_solver_mpm_3d_cuda->getMaxVelocity(),
                         global_solver_mpm_3d_cuda->getParticles().size());
                emit_kernel_log("SYSTEM", log_buf, sim_time, "mpm_3d", current_step);

                nlohmann::json progress_msg;
                progress_msg["type"] = "progress";
                progress_msg["sim_time"] = sim_time;
                progress_msg["step"] = current_step;
                progress_msg["scope"] = "mpm_3d";
                progress_msg["dt"] = global_solver_mpm_3d_cuda->getLastDt();
                if (!global_model_id.empty()) {
                    progress_msg["modelId"] = global_model_id;
                }

                if (global_exec_until_end_mpm_3d.load()) {
                    if (end_time > 0.0) {
                        int percent = std::clamp((int)((sim_time / end_time) * 100.0), 0, 99);
                        progress_msg["percent"] = percent;
                    } else {
                        progress_msg["percent"] = 50;
                    }
                    progress_msg["mode"] = "EXEC_ALL_MPM_3D";
                } else {
                    initial_steps = std::max(initial_steps, step_count + global_target_steps_mpm_3d.load());
                    if (initial_steps > 0) {
                        int completed = initial_steps - global_target_steps_mpm_3d.load();
                        int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 99);
                        progress_msg["percent"] = percent;
                        progress_msg["completed"] = completed;
                        progress_msg["total"] = initial_steps;
                        progress_msg["mode"] = "STEP_MPM_3D";
                    }
                }

                {
                    std::lock_guard<std::mutex> lock(cout_mutex);
                    std::cout << progress_msg.dump() << std::endl;
                }
            }
        } else if (global_solver_mpm_3d) {
            auto step_start = std::chrono::steady_clock::now();
            float cfl = global_cfl_mpm_3d.load();
            global_solver_mpm_3d->step(cfl);
            auto step_end = std::chrono::steady_clock::now();
            double comp_ms = std::chrono::duration<double, std::milli>(step_end - step_start).count();
            interval_compute_ms += comp_ms;
            global_cum_compute_s = global_cum_compute_s.load() + (comp_ms * 0.001);
            step_count++;

            double sim_time = global_solver_mpm_3d->getSimTime();
            int current_step = global_solver_mpm_3d->getStepCount();

            auto io_start = std::chrono::steady_clock::now();
            if (global_enable_vtk.load()) {
                double last_time = global_last_vtk_time_mpm_3d.load();
                if (should_write_vtk(current_step, sim_time, last_time)) {
                    write_vtk_outputs(current_step, sim_time);
                    update_last_vtk_time(global_last_vtk_time_mpm_3d, sim_time);
                }
            }
            auto io_end = std::chrono::steady_clock::now();
            double io_step_ms = std::chrono::duration<double, std::milli>(io_end - io_start).count();
            interval_io_ms += io_step_ms;
            global_cum_io_s = global_cum_io_s.load() + (io_step_ms * 0.001);
            interval_steps++;

            if (!global_exec_until_end_mpm_3d.load()) {
                global_target_steps_mpm_3d--;
                if (global_target_steps_mpm_3d.load() <= 0) done = true;
            }
            if (global_solver_mpm_3d->is_terminated()) {
                done = true;
            }

            auto now = std::chrono::steady_clock::now();
            auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
            int user_interval = (global_telemetry_interval_ms.load() > 0) ? global_telemetry_interval_ms.load() : static_cast<int>(global_refresh_rate_mpm_3d.load() * 1000.0);
            int target_interval_ms = std::max(16, user_interval);
            bool should_emit = (elapsed_ms >= target_interval_ms);

            if (should_emit || done) {
                int steps_in_interval = std::max(1, interval_steps);
                global_last_compute_ms = interval_compute_ms / steps_in_interval;
                global_last_io_ms = interval_io_ms / steps_in_interval;
                interval_compute_ms = 0.0;
                interval_io_ms = 0.0;
                interval_steps = 0;

                auto comms_start = std::chrono::steady_clock::now();
                emit_telemetry_mpm_3d(sim_time, false, current_step);
                auto comms_end = std::chrono::steady_clock::now();
                double comms_ms = std::chrono::duration<double, std::milli>(comms_end - comms_start).count();
                global_last_comms_ms = comms_ms;
                global_cum_comms_s = global_cum_comms_s.load() + (comms_ms * 0.001);
                last_telemetry_time = now;

                char log_buf[256];
                snprintf(log_buf, sizeof(log_buf),
                         "Step %d | Time = %.4e s | dt = %.2e s | CFL = %.2f | v_max = %.1f m/s | Particles = %zu",
                         current_step,
                         sim_time,
                         global_solver_mpm_3d->getLastDt(),
                         global_solver_mpm_3d->getLastCFL(),
                         global_solver_mpm_3d->getMaxVelocity(),
                         global_solver_mpm_3d->getParticles().size());
                emit_kernel_log("SYSTEM", log_buf, sim_time, "mpm_3d", current_step);

                nlohmann::json progress_msg;
                progress_msg["type"] = "progress";
                progress_msg["sim_time"] = sim_time;
                progress_msg["step"] = current_step;
                progress_msg["scope"] = "mpm_3d";
                progress_msg["dt"] = global_solver_mpm_3d->getLastDt();
                if (!global_model_id.empty()) {
                    progress_msg["modelId"] = global_model_id;
                }

                if (global_exec_until_end_mpm_3d.load()) {
                    if (end_time > 0.0) {
                        int percent = std::clamp((int)((sim_time / end_time) * 100.0), 0, 99);
                        progress_msg["percent"] = percent;
                    } else {
                        progress_msg["percent"] = 50;
                    }
                    progress_msg["mode"] = "EXEC_ALL_MPM_3D";
                } else {
                    initial_steps = std::max(initial_steps, step_count + global_target_steps_mpm_3d.load());
                    if (initial_steps > 0) {
                        int completed = initial_steps - global_target_steps_mpm_3d.load();
                        int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 99);
                        progress_msg["percent"] = percent;
                        progress_msg["completed"] = completed;
                        progress_msg["total"] = initial_steps;
                        progress_msg["mode"] = "STEP_MPM_3D";
                    }
                }

                {
                    std::lock_guard<std::mutex> lock(cout_mutex);
                    std::cout << progress_msg.dump() << std::endl;
                }
            }
        } else {
            break;
        }
    }

    double final_sim_time = 0.0;
    if (global_solver_mpm_3d_cuda) final_sim_time = global_solver_mpm_3d_cuda->getSimTime();
    else if (global_solver_mpm_3d) final_sim_time = global_solver_mpm_3d->getSimTime();

    int final_step = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getStepCount() : (global_solver_mpm_3d ? global_solver_mpm_3d->getStepCount() : 0);
    double end_time = global_endtime_mpm_3d.load();
    bool reached_end = (end_time > 0.0 && final_sim_time >= end_time - 1e-12);
    bool term_mpm_3d = !reached_end && ((global_solver_mpm_3d_cuda && global_solver_mpm_3d_cuda->is_terminated()) ||
                                        (global_solver_mpm_3d && global_solver_mpm_3d->is_terminated()));
    if (global_enable_vtk.load() && reached_end && should_write_final_vtk(final_sim_time, global_last_vtk_time_mpm_3d.load())) {
        write_vtk_outputs(final_step, final_sim_time);
        update_last_vtk_time(global_last_vtk_time_mpm_3d, final_sim_time);
    }
    if (interval_steps > 0) {
        int steps_in_interval = std::max(1, interval_steps);
        global_last_compute_ms = interval_compute_ms / steps_in_interval;
        global_last_io_ms = interval_io_ms / steps_in_interval;
    }
    emit_telemetry_mpm_3d(final_sim_time, term_mpm_3d, final_step);
    flush_async_telemetry();

    nlohmann::json progress_msg;
    progress_msg["type"] = "progress";
    progress_msg["sim_time"] = final_sim_time;
    progress_msg["step"] = final_step;
    progress_msg["scope"] = "mpm_3d";
    progress_msg["percent"] = 100;
    progress_msg["is_terminated"] = term_mpm_3d;
    progress_msg["mode"] = global_exec_until_end_mpm_3d.load() ? "EXEC_ALL_MPM_3D" : "STEP_MPM_3D";
    if (!global_model_id.empty()) {
        progress_msg["modelId"] = global_model_id;
    }
    {
        std::lock_guard<std::mutex> lock(cout_mutex);
        std::cout << progress_msg.dump() << std::endl;
    }

    double final_end_time = global_endtime_mpm_3d.load();
    if (term_mpm_3d) {
        emit_kernel_log("SYSTEM", "MPM particle reached Terminate boundary. Terminating simulation.", final_sim_time, "mpm_3d", final_step);
    } else if (final_end_time > 0.0 && final_sim_time >= final_end_time - 1e-12) {
        emit_kernel_log("INFO", "Reached simulation end time (" + std::to_string(final_end_time) + " s). Simulation paused.", final_sim_time, "mpm_3d", final_step);
    }

        sim_mpm_3d_running = false;
        sim_mpm_3d_paused = false;
        sim_mpm_3d_terminate = false;
        global_target_steps_mpm_3d = 0;
        global_exec_until_end_mpm_3d = false;
    } catch (const std::exception& e) {
        emit_kernel_log("ERROR", std::string("3D MPM worker thread error: ") + e.what(), 0.0, "mpm_3d");
        sim_mpm_3d_running = false;
        std::exit(1);
    } catch (...) {
        emit_kernel_log("ERROR", "3D MPM worker thread error: unknown exception", 0.0, "mpm_3d");
        sim_mpm_3d_running = false;
        std::exit(1);
    }
}

void worker_fem_3d_thread_func() {
    try {
        int step_count = 0;
        int initial_steps = global_target_steps_fem_3d.load();
        double interval_compute_ms = 0.0;
        double interval_io_ms = 0.0;
        int interval_steps = 0;
        auto last_telemetry_time = std::chrono::steady_clock::now();
        emit_kernel_log("INFO", "3D FEM asynchronous worker thread started.", 0.0, "fem_3d");

        while (sim_fem_3d_running.load()) {
            if (sim_fem_3d_terminate.load()) break;

            if (sim_fem_3d_paused.load()) {
                std::this_thread::sleep_for(std::chrono::milliseconds(30));
                continue;
            }

            bool done = false;
            double end_time = global_endtime_fem_3d.load();
            std::string m_id_check = global_model_id.empty() ? "default_fem" : global_model_id;
            double cur_sim_time = 0.0;
            if (global_fem_solvers_cuda_float.count(m_id_check) && global_fem_solvers_cuda_float[m_id_check]) {
                cur_sim_time = static_cast<double>(global_fem_solvers_cuda_float[m_id_check]->getSimTime());
            } else if (global_fem_solvers_cuda_double.count(m_id_check) && global_fem_solvers_cuda_double[m_id_check]) {
                cur_sim_time = global_fem_solvers_cuda_double[m_id_check]->getSimTime();
            } else if (global_fem_solvers_float.count(m_id_check) && global_fem_solvers_float[m_id_check]) {
                cur_sim_time = static_cast<double>(global_fem_solvers_float[m_id_check]->getSimTime());
            } else if (global_fem_solvers_double.count(m_id_check) && global_fem_solvers_double[m_id_check]) {
                cur_sim_time = global_fem_solvers_double[m_id_check]->getSimTime();
            } else if (!global_fem_solvers_cuda_float.empty()) {
                cur_sim_time = static_cast<double>(global_fem_solvers_cuda_float.begin()->second->getSimTime());
            } else if (!global_fem_solvers_cuda_double.empty()) {
                cur_sim_time = global_fem_solvers_cuda_double.begin()->second->getSimTime();
            } else if (!global_fem_solvers_float.empty()) {
                cur_sim_time = static_cast<double>(global_fem_solvers_float.begin()->second->getSimTime());
            } else if (!global_fem_solvers_double.empty()) {
                cur_sim_time = global_fem_solvers_double.begin()->second->getSimTime();
            }

            if (end_time > 0.0 && cur_sim_time >= end_time - 1e-12) {
                done = true;
            } else if (!global_exec_until_end_fem_3d.load()) {
                if (global_target_steps_fem_3d.load() <= 0) done = true;
            }

            if (done) break;

            auto step_start = std::chrono::steady_clock::now();
            std::string m_id = global_model_id.empty() ? "default_fem" : global_model_id;
            float cfl = global_cfl_fem_3d.load();
            double sim_time = 0.0;
            double last_dt = 0.0;
            int current_step = 0;
            double max_v = 0.0;
            double max_vm = 0.0;
            double max_ep = 0.0;
            size_t n_nodes = 0;
            size_t n_elems = 0;
            double e_int = 0.0;

            if (global_fem_solvers_cuda_float.count(m_id) && global_fem_solvers_cuda_float[m_id]) {
                auto* fem = global_fem_solvers_cuda_float[m_id].get();
                fem->step(cfl);
                sim_time = static_cast<double>(fem->getSimTime());
                last_dt = static_cast<double>(fem->getLastDt());
            } else if (global_fem_solvers_cuda_double.count(m_id) && global_fem_solvers_cuda_double[m_id]) {
                auto* fem = global_fem_solvers_cuda_double[m_id].get();
                fem->step(static_cast<double>(cfl));
                sim_time = fem->getSimTime();
                last_dt = fem->getLastDt();
            } else if (global_fem_solvers_float.count(m_id) && global_fem_solvers_float[m_id]) {
                auto* fem = global_fem_solvers_float[m_id].get();
                fem->step(cfl);
                sim_time = static_cast<double>(fem->getSimTime());
                last_dt = static_cast<double>(fem->getLastDt());
            } else if (global_fem_solvers_double.count(m_id) && global_fem_solvers_double[m_id]) {
                auto* fem = global_fem_solvers_double[m_id].get();
                fem->step(static_cast<double>(cfl));
                sim_time = fem->getSimTime();
                last_dt = fem->getLastDt();
            } else if (!global_fem_solvers_cuda_float.empty()) {
                auto* fem = global_fem_solvers_cuda_float.begin()->second.get();
                fem->step(cfl);
                sim_time = static_cast<double>(fem->getSimTime());
                last_dt = static_cast<double>(fem->getLastDt());
            } else if (!global_fem_solvers_cuda_double.empty()) {
                auto* fem = global_fem_solvers_cuda_double.begin()->second.get();
                fem->step(static_cast<double>(cfl));
                sim_time = fem->getSimTime();
                last_dt = fem->getLastDt();
            } else if (!global_fem_solvers_float.empty()) {
                auto* fem = global_fem_solvers_float.begin()->second.get();
                fem->step(cfl);
                sim_time = static_cast<double>(fem->getSimTime());
                last_dt = static_cast<double>(fem->getLastDt());
            } else if (!global_fem_solvers_double.empty()) {
                auto* fem = global_fem_solvers_double.begin()->second.get();
                fem->step(static_cast<double>(cfl));
                sim_time = fem->getSimTime();
                last_dt = fem->getLastDt();
            } else {
                break;
            }

            if (global_solver_mpm_3d_cuda && global_solver_mpm_3d_cuda->getParticleCount() > 0) {
                global_solver_mpm_3d_cuda->stepWithDt(static_cast<float>(last_dt));
            } else if (global_solver_mpm_3d && !global_solver_mpm_3d->getParticles().empty()) {
                global_solver_mpm_3d->stepWithDt(static_cast<float>(last_dt));
            }

            auto step_end = std::chrono::steady_clock::now();
            double comp_ms = std::chrono::duration<double, std::milli>(step_end - step_start).count();
            interval_compute_ms += comp_ms;
            global_cum_compute_s = global_cum_compute_s.load() + (comp_ms * 0.001);
            step_count++;

            if (global_fem_solvers_cuda_float.count(m_id) && global_fem_solvers_cuda_float[m_id]) {
                current_step = global_fem_solvers_cuda_float[m_id]->getStepCount();
            } else if (global_fem_solvers_cuda_double.count(m_id) && global_fem_solvers_cuda_double[m_id]) {
                current_step = global_fem_solvers_cuda_double[m_id]->getStepCount();
            } else if (global_fem_solvers_float.count(m_id) && global_fem_solvers_float[m_id]) {
                current_step = global_fem_solvers_float[m_id]->getStepCount();
            } else if (global_fem_solvers_double.count(m_id) && global_fem_solvers_double[m_id]) {
                current_step = global_fem_solvers_double[m_id]->getStepCount();
            } else if (!global_fem_solvers_cuda_float.empty()) {
                current_step = global_fem_solvers_cuda_float.begin()->second->getStepCount();
            } else if (!global_fem_solvers_cuda_double.empty()) {
                current_step = global_fem_solvers_cuda_double.begin()->second->getStepCount();
            } else if (!global_fem_solvers_float.empty()) {
                current_step = global_fem_solvers_float.begin()->second->getStepCount();
            } else if (!global_fem_solvers_double.empty()) {
                current_step = global_fem_solvers_double.begin()->second->getStepCount();
            }

            auto io_start = std::chrono::steady_clock::now();
            if (global_enable_vtk.load()) {
                double last_time = global_last_vtk_time_fem_3d.load();
                if (should_write_vtk(current_step, sim_time, last_time)) {
                    write_vtk_outputs(current_step, sim_time);
                    update_last_vtk_time(global_last_vtk_time_fem_3d, sim_time);
                }
            }
            auto io_end = std::chrono::steady_clock::now();
            double io_step_ms = std::chrono::duration<double, std::milli>(io_end - io_start).count();
            interval_io_ms += io_step_ms;
            global_cum_io_s = global_cum_io_s.load() + (io_step_ms * 0.001);
            interval_steps++;

            if (!global_exec_until_end_fem_3d.load()) {
                global_target_steps_fem_3d--;
            }

            auto now = std::chrono::steady_clock::now();
            auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
            int user_interval = (global_telemetry_interval_ms.load() > 0) ? global_telemetry_interval_ms.load() : static_cast<int>(global_refresh_rate_fem_3d.load() * 1000.0);
            int target_interval_ms = std::max(16, user_interval);
            bool should_emit = (elapsed_ms >= target_interval_ms);

            if (should_emit || done) {
                int steps_in_interval = std::max(1, interval_steps);
                global_last_compute_ms = interval_compute_ms / steps_in_interval;
                global_last_io_ms = interval_io_ms / steps_in_interval;
                interval_compute_ms = 0.0;
                interval_io_ms = 0.0;
                interval_steps = 0;
                if (global_fem_solvers_cuda_float.count(m_id) && global_fem_solvers_cuda_float[m_id]) {
                    auto* fem = global_fem_solvers_cuda_float[m_id].get();
                    current_step = fem->getStepCount();
                    max_v = static_cast<double>(fem->getMaxVelocity());
                    max_vm = static_cast<double>(fem->getMaxVonMisesStress());
                    max_ep = static_cast<double>(fem->getMaxPlasticStrain());
                    n_nodes = fem->getNodeCount();
                    n_elems = fem->getElementCount();
                    e_int = static_cast<double>(fem->getEnergyTracker().E_int);
                } else if (global_fem_solvers_cuda_double.count(m_id) && global_fem_solvers_cuda_double[m_id]) {
                    auto* fem = global_fem_solvers_cuda_double[m_id].get();
                    current_step = fem->getStepCount();
                    max_v = fem->getMaxVelocity();
                    max_vm = fem->getMaxVonMisesStress();
                    max_ep = fem->getMaxPlasticStrain();
                    n_nodes = fem->getNodeCount();
                    n_elems = fem->getElementCount();
                    e_int = fem->getEnergyTracker().E_int;
                } else if (global_fem_solvers_float.count(m_id) && global_fem_solvers_float[m_id]) {
                    auto* fem = global_fem_solvers_float[m_id].get();
                    current_step = fem->getStepCount();
                    max_v = static_cast<double>(fem->getMaxVelocity());
                    max_vm = static_cast<double>(fem->getMaxVonMisesStress());
                    max_ep = static_cast<double>(fem->getMaxPlasticStrain());
                    n_nodes = fem->getNodes().size();
                    n_elems = fem->getElements().size();
                    e_int = static_cast<double>(fem->getEnergyTracker().E_int);
                } else if (global_fem_solvers_double.count(m_id) && global_fem_solvers_double[m_id]) {
                    auto* fem = global_fem_solvers_double[m_id].get();
                    current_step = fem->getStepCount();
                    max_v = fem->getMaxVelocity();
                    max_vm = fem->getMaxVonMisesStress();
                    max_ep = fem->getMaxPlasticStrain();
                    n_nodes = fem->getNodes().size();
                    n_elems = fem->getElements().size();
                    e_int = fem->getEnergyTracker().E_int;
                } else if (!global_fem_solvers_cuda_float.empty()) {
                    auto* fem = global_fem_solvers_cuda_float.begin()->second.get();
                    current_step = fem->getStepCount();
                    max_v = static_cast<double>(fem->getMaxVelocity());
                    max_vm = static_cast<double>(fem->getMaxVonMisesStress());
                    max_ep = static_cast<double>(fem->getMaxPlasticStrain());
                    n_nodes = fem->getNodeCount();
                    n_elems = fem->getElementCount();
                    e_int = static_cast<double>(fem->getEnergyTracker().E_int);
                } else if (!global_fem_solvers_cuda_double.empty()) {
                    auto* fem = global_fem_solvers_cuda_double.begin()->second.get();
                    current_step = fem->getStepCount();
                    max_v = fem->getMaxVelocity();
                    max_vm = fem->getMaxVonMisesStress();
                    max_ep = fem->getMaxPlasticStrain();
                    n_nodes = fem->getNodeCount();
                    n_elems = fem->getElementCount();
                    e_int = fem->getEnergyTracker().E_int;
                } else if (!global_fem_solvers_float.empty()) {
                    auto* fem = global_fem_solvers_float.begin()->second.get();
                    current_step = fem->getStepCount();
                    max_v = static_cast<double>(fem->getMaxVelocity());
                    max_vm = static_cast<double>(fem->getMaxVonMisesStress());
                    max_ep = static_cast<double>(fem->getMaxPlasticStrain());
                    n_nodes = fem->getNodes().size();
                    n_elems = fem->getElements().size();
                    e_int = static_cast<double>(fem->getEnergyTracker().E_int);
                } else if (!global_fem_solvers_double.empty()) {
                    auto* fem = global_fem_solvers_double.begin()->second.get();
                    current_step = fem->getStepCount();
                    max_v = fem->getMaxVelocity();
                    max_vm = fem->getMaxVonMisesStress();
                    max_ep = fem->getMaxPlasticStrain();
                    n_nodes = fem->getNodes().size();
                    n_elems = fem->getElements().size();
                    e_int = fem->getEnergyTracker().E_int;
                }

                auto comms_start = std::chrono::steady_clock::now();
                emit_telemetry_fem_3d(sim_time, false, current_step);
                auto comms_end = std::chrono::steady_clock::now();
                double comms_ms = std::chrono::duration<double, std::milli>(comms_end - comms_start).count();
                global_last_comms_ms = comms_ms;
                global_cum_comms_s = global_cum_comms_s.load() + (comms_ms * 0.001);
                last_telemetry_time = now;

                char log_buf[512];
                snprintf(log_buf, sizeof(log_buf),
                         "Step %d | Time = %.4e s | dt = %.2e s | CFL = %.2f | v_max = %.1f m/s | sig_max = %.2e Pa | ep_max = %.3f | E_int = %.2e J | Nodes = %zu | Hex8 = %zu",
                         current_step,
                         sim_time,
                         last_dt,
                         cfl,
                         max_v,
                         max_vm,
                         max_ep,
                         e_int,
                         n_nodes,
                         n_elems);
                emit_kernel_log("SYSTEM", log_buf, sim_time, "fem_3d", current_step);

                nlohmann::json progress_msg;
                progress_msg["type"] = "progress";
                progress_msg["sim_time"] = sim_time;
                progress_msg["step"] = current_step;
                progress_msg["dt"] = last_dt;
                progress_msg["scope"] = "fem_3d";
                if (global_exec_until_end_fem_3d.load()) {
                    if (end_time > 0.0) {
                        int percent = std::clamp((int)((sim_time / end_time) * 100.0), 0, 99);
                        progress_msg["percent"] = percent;
                    } else {
                        progress_msg["percent"] = 50;
                    }
                    progress_msg["mode"] = "EXEC_ALL_FEM_3D";
                } else {
                    initial_steps = std::max(initial_steps, step_count + global_target_steps_fem_3d.load());
                    if (initial_steps > 0) {
                        int completed = initial_steps - global_target_steps_fem_3d.load();
                        int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 99);
                        progress_msg["percent"] = percent;
                        progress_msg["completed"] = completed;
                        progress_msg["total"] = initial_steps;
                        progress_msg["mode"] = "STEP_FEM_3D";
                    }
                }
                {
                    std::lock_guard<std::mutex> lock(cout_mutex);
                    std::cout << progress_msg.dump() << std::endl;
                }
            }
        }

        double final_sim_time = 0.0;
        int final_step = 0;
        std::string m_id = global_model_id.empty() ? "default_fem" : global_model_id;
        if (global_fem_solvers_cuda_float.count(m_id) && global_fem_solvers_cuda_float[m_id]) {
            final_step = global_fem_solvers_cuda_float[m_id]->getStepCount();
        } else if (global_fem_solvers_cuda_double.count(m_id) && global_fem_solvers_cuda_double[m_id]) {
            final_step = global_fem_solvers_cuda_double[m_id]->getStepCount();
        } else if (global_fem_solvers_float.count(m_id) && global_fem_solvers_float[m_id]) {
            final_step = global_fem_solvers_float[m_id]->getStepCount();
        } else if (global_fem_solvers_double.count(m_id) && global_fem_solvers_double[m_id]) {
            final_step = global_fem_solvers_double[m_id]->getStepCount();
        }

        if (global_fem_solvers_float.count(m_id) && global_fem_solvers_float[m_id]) {
            final_sim_time = static_cast<double>(global_fem_solvers_float[m_id]->getSimTime());
        } else if (global_fem_solvers_double.count(m_id) && global_fem_solvers_double[m_id]) {
            final_sim_time = global_fem_solvers_double[m_id]->getSimTime();
        } else if (!global_fem_solvers_float.empty()) {
            final_sim_time = static_cast<double>(global_fem_solvers_float.begin()->second->getSimTime());
        } else if (!global_fem_solvers_double.empty()) {
            final_sim_time = global_fem_solvers_double.begin()->second->getSimTime();
        }

        double final_end_time = global_endtime_fem_3d.load();
        bool reached_end = (final_end_time > 0.0 && final_sim_time >= final_end_time - 1e-12);
        if (global_enable_vtk.load() && reached_end && should_write_final_vtk(final_sim_time, global_last_vtk_time_fem_3d.load())) {
            write_vtk_outputs(final_step, final_sim_time);
            update_last_vtk_time(global_last_vtk_time_fem_3d, final_sim_time);
        }
        if (interval_steps > 0) {
            int steps_in_interval = std::max(1, interval_steps);
            global_last_compute_ms = interval_compute_ms / steps_in_interval;
            global_last_io_ms = interval_io_ms / steps_in_interval;
        }
        emit_telemetry_fem_3d(final_sim_time, false, final_step);
        flush_async_telemetry();


        if (reached_end) {
            emit_kernel_log("INFO", "Reached simulation end time (" + std::to_string(final_end_time) + " s). Simulation paused.", final_sim_time, "fem_3d", final_step);
        } else {
            emit_kernel_log("INFO", "3D FEM worker thread execution cycle ended.", final_sim_time, "fem_3d", final_step);
        }

        nlohmann::json progress_msg;
        progress_msg["type"] = "progress";
        progress_msg["sim_time"] = final_sim_time;
        progress_msg["step"] = final_step;
        progress_msg["scope"] = "fem_3d";
        progress_msg["percent"] = 100;
        progress_msg["mode"] = global_exec_until_end_fem_3d.load() ? "EXEC_ALL_FEM_3D" : "STEP_FEM_3D";
        {
            std::lock_guard<std::mutex> lock(cout_mutex);
            std::cout << progress_msg.dump() << std::endl;
        }

        sim_fem_3d_running = false;
        sim_fem_3d_paused = false;
        sim_fem_3d_terminate = false;
        global_target_steps_fem_3d = 0;
        global_exec_until_end_fem_3d = false;
    } catch (const std::exception& e) {
        emit_kernel_log("ERROR", std::string("3D FEM worker thread error: ") + e.what(), 0.0, "fem_3d");
        sim_fem_3d_running = false;
    } catch (...) {
        emit_kernel_log("ERROR", "3D FEM worker thread error: unknown exception", 0.0, "fem_3d");
        sim_fem_3d_running = false;
    }
}

std::atomic<bool> sim_fsi_paused{false};
std::atomic<bool> sim_fsi_terminate{false};
std::atomic<bool> global_exec_until_end_fsi{false};
std::atomic<int> global_target_steps_fsi{0};
std::atomic<float> global_cfl_fsi{0.6f};
std::atomic<double> global_endtime_fsi{1.0};

std::atomic<bool> sim_fsi_3d_paused{false};
std::atomic<bool> sim_fsi_3d_terminate{false};
std::atomic<bool> global_exec_until_end_fsi_3d{false};
std::atomic<int> global_target_steps_fsi_3d{0};
std::atomic<float> global_cfl_fsi_3d{0.6f};
std::atomic<double> global_endtime_fsi_3d{1.0};

static std::vector<uint8_t> global_static_obstacle_mask_2d;

void apply_obstacles_2d(const nlohmann::json& msg, int nr, int nz, double max_r, double max_z) {
    global_static_obstacle_mask_2d.assign(nr * nz, 0);
    if (!msg.contains("obstacles_2d") || !msg["obstacles_2d"].is_array() || msg["obstacles_2d"].empty()) {
        return;
    }
    double dr = (nr > 0) ? (max_r / nr) : 1.0;
    double dz = (nz > 0) ? (max_z / nz) : 1.0;
    int solid_cells = 0;
    for (const auto& obs : msg["obstacles_2d"]) {
        double r0 = get_json_double(obs, "r_min", 0.0);
        double r1 = get_json_double(obs, "r_max", 0.0);
        double z0 = get_json_double(obs, "z_min", 0.0);
        double z1 = get_json_double(obs, "z_max", 0.0);
        if (r1 < r0) std::swap(r0, r1);
        if (z1 < z0) std::swap(z0, z1);
        for (int i = 0; i < nr; ++i) {
            double rc = (i + 0.5) * dr;
            if (rc < r0 || rc > r1) continue;
            for (int j = 0; j < nz; ++j) {
                double zc = (j + 0.5) * dz;
                if (zc >= z0 && zc <= z1) {
                    global_static_obstacle_mask_2d[i * nz + j] = 1;
                    solid_cells++;
                }
            }
        }
    }
    if (solid_cells > 0) {
        std::vector<double> zero_vel(2 * nr * nz, 0.0);
        if (global_solver_2d_cuda) {
            global_solver_2d_cuda->setSolidMask(global_static_obstacle_mask_2d.data());
            global_solver_2d_cuda->setSolidVelocities(zero_vel.data());
        }
        if (global_solver_2d) {
            global_solver_2d->setSolidMask(global_static_obstacle_mask_2d.data());
            global_solver_2d->setSolidVelocities(zero_vel.data());
        }
    }
}

void worker_fsi_2d_thread_func() {
    try {
        int step_count = 0;
        int initial_steps = 0;
        double interval_compute_ms = 0.0;
        double interval_io_ms = 0.0;
        int interval_steps = 0;
        auto last_telemetry_time = std::chrono::steady_clock::now();
        double last_dt = (global_dt_2d > 1.0e-12) ? global_dt_2d : 0.0;

    while (!sim_fsi_terminate.load()) {
        if (sim_fsi_paused.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            continue;
        }

        bool done = false;
        double end_time = global_endtime_fsi.load();
        double cur_time = global_solver_mpm_2d ? global_solver_mpm_2d->getSimTime() : global_t2d;
        bool is_term_fsi_2d = (global_solver_mpm_2d && global_solver_mpm_2d->is_terminated()) ||
                              (global_solver_2d_cuda && global_solver_2d_cuda->checkTerminationCondition()) ||
                              (global_solver_2d && global_solver_2d->checkTerminationCondition());
        if (end_time > 0.0 && cur_time >= end_time - 1e-12) {
            done = true;
        } else if (is_term_fsi_2d) {
            done = true;
        } else if (!global_exec_until_end_fsi.load()) {
            if (global_target_steps_fsi.load() <= 0) done = true;
        }

        if (done) break;

        if (global_solver_mpm_2d || has_solver_2d()) {
            auto step_start = std::chrono::steady_clock::now();
            float cfl = global_cfl_fsi.load();

            // Synchronized 2-Way FSI Coupling exchange
            if (global_solver_mpm_2d && has_solver_2d()) {
                // 1. P2G scatter to populate MPM background grid
                global_solver_mpm_2d->particleToGrid();

                // 2. Fetch fluid states from 2D CFD solver
                std::vector<State2D> cfd_states;
                int nr = 0, nz = 0;
                double dr = 0.0, dz = 0.0;
                if (global_solver_2d_cuda) {
                    cfd_states = global_solver_2d_cuda->getStates();
                    nr = global_solver_2d_cuda->getNr();
                    nz = global_solver_2d_cuda->getNz();
                    dr = global_solver_2d_cuda->getDr();
                    dz = global_solver_2d_cuda->getDz();
                } else if (global_solver_2d) {
                    cfd_states = global_solver_2d->getStates();
                    nr = global_solver_2d->getNr();
                    nz = global_solver_2d->getNz();
                    dr = global_solver_2d->getDr();
                    dz = global_solver_2d->getDz();
                }

                if (!cfd_states.empty() && nr > 0 && nz > 0) {
                    auto& mpm_grid = global_solver_mpm_2d->getGrid();
                    int mpm_nx = global_solver_mpm_2d->getNx();
                    int mpm_ny = global_solver_mpm_2d->getNy();

                    std::vector<uint8_t> solid_mask(nr * nz, 0);
                    std::vector<double> solid_vel(2 * nr * nz, 0.0);

                    // Pass 1: Build solid_mask & solid_vel from MPM grid nodes with temporal hysteresis
                    static std::vector<uint8_t> prev_solid_mask;
                    if (prev_solid_mask.size() != static_cast<size_t>(nr * nz)) {
                        prev_solid_mask.assign(nr * nz, 0);
                    }

                    for (int i = 0; i < nr; ++i) {
                        for (int j = 0; j < nz; ++j) {
                            int cfd_idx = i * nz + j;
                            if (cfd_idx < static_cast<int>(global_static_obstacle_mask_2d.size()) && global_static_obstacle_mask_2d[cfd_idx]) {
                                solid_mask[cfd_idx] = 1;
                                solid_vel[2 * cfd_idx + 0] = 0.0;
                                solid_vel[2 * cfd_idx + 1] = 0.0;
                            }
                            if (i < mpm_nx && j < mpm_ny) {
                                int mpm_idx = i * mpm_ny + j;
                                const auto& m_node = mpm_grid[mpm_idx];

                                // Hysteresis threshold: turn solid at mass > 1.0e-8, stay solid until mass < 2.0e-9
                                bool was_solid = (prev_solid_mask[cfd_idx] != 0);
                                float threshold = was_solid ? 2.0e-9f : 1.0e-14f;

                                if (m_node.m > threshold) {
                                    solid_mask[cfd_idx] = 1;
                                    solid_vel[2 * cfd_idx + 0] = m_node.v[0];
                                    solid_vel[2 * cfd_idx + 1] = m_node.v[1];
                                }
                            }
                        }
                    }
                    prev_solid_mask = solid_mask;

                    // Pass 2: Calculate surface fluid pressure forces on MPM boundary grid nodes
                    for (int i = 0; i < nr; ++i) {
                        for (int j = 0; j < nz; ++j) {
                            if (i < mpm_nx && j < mpm_ny) {
                                int mpm_idx = i * mpm_ny + j;
                                auto& m_node = mpm_grid[mpm_idx];

                                if (m_node.m > 1.0e-14f) {
                                    // Check if node is on the surface (adjacent to fluid)
                                    bool is_surface = false;
                                    double f_r = 0.0;
                                    double f_z = 0.0;

                                    if (i > 0 && solid_mask[(i - 1) * nz + j] == 0) {
                                        f_r += cfd_states[(i - 1) * nz + j].p;
                                        is_surface = true;
                                    }
                                    if (i < nr - 1 && solid_mask[(i + 1) * nz + j] == 0) {
                                        f_r -= cfd_states[(i + 1) * nz + j].p;
                                        is_surface = true;
                                    }
                                    if (j > 0 && solid_mask[i * nz + (j - 1)] == 0) {
                                        f_z += cfd_states[i * nz + (j - 1)].p;
                                        is_surface = true;
                                    }
                                    if (j < nz - 1 && solid_mask[i * nz + (j + 1)] == 0) {
                                        f_z -= cfd_states[i * nz + (j + 1)].p;
                                        is_surface = true;
                                    }

                                    if (is_surface) {
                                        m_node.f_ext[0] = static_cast<float>(f_r * dz);
                                        m_node.f_ext[1] = static_cast<float>(f_z * dr);
                                    } else {
                                        m_node.f_ext[0] = 0.0f;
                                        m_node.f_ext[1] = 0.0f;
                                    }
                                }
                            }
                        }
                    }

                    if (global_solver_2d_cuda) {
                        global_solver_2d_cuda->setSolidMask(solid_mask.data());
                        global_solver_2d_cuda->setSolidVelocities(solid_vel.data());
                    } else if (global_solver_2d) {
                        global_solver_2d->setSolidMask(solid_mask.data());
                        global_solver_2d->setSolidVelocities(solid_vel.data());
                    }
                }
            }

            // Calculate coupled CFL stability timestep
            float dt_mpm = global_solver_mpm_2d ? global_solver_mpm_2d->computeStepSize(cfl) : 1.0f;
            double dt_cfd = 1.0;
            if (global_solver_2d_cuda) {
                double c_max = global_solver_2d_cuda->getMaxWaveSpeed();
                double min_h = std::min(global_solver_2d_cuda->getDr(), global_solver_2d_cuda->getDz());
                dt_cfd = cfl * min_h / (c_max > 1e-6 ? c_max : 340.0);
            } else if (global_solver_2d) {
                dt_cfd = global_solver_2d->computeStepSize(cfl);
            }

            double dt_phys = std::min(static_cast<double>(dt_mpm), dt_cfd);
            double dt_common = dt_phys;
            if (global_step_2d.load() == 0 && step_count == 0) {
                dt_common = std::max(1.0e-11, 0.5 * dt_phys);
            } else if (last_dt > 1.0e-11) {
                dt_common = std::min(dt_phys, 1.5 * last_dt);
            } else {
                dt_common = dt_phys;
            }
            if (end_time > 0.0 && cur_time + dt_common > end_time) {
                dt_common = std::max(1e-12, end_time - cur_time);
            }
            dt_common = std::clamp(dt_common, 1.0e-11, 1.0e-4);
            global_dt_2d = dt_common;
            last_dt = dt_common;

            if (global_solver_mpm_2d) {
                global_solver_mpm_2d->stepWithDt(static_cast<float>(dt_common), false);
            }
            if (global_solver_2d_cuda) {
                global_solver_2d_cuda->step(dt_common);
                global_t2d = global_solver_2d_cuda->getTime();
            } else if (global_solver_2d) {
                global_solver_2d->step(dt_common);
                global_t2d += dt_common;
            }

            auto step_end = std::chrono::steady_clock::now();
            double comp_ms = std::chrono::duration<double, std::milli>(step_end - step_start).count();
            interval_compute_ms += comp_ms;
            global_cum_compute_s = global_cum_compute_s.load() + (comp_ms * 0.001);

            global_step_fsi_2d++;
            global_step_2d++;
            step_count++;
            interval_steps++;

            if (global_enable_gauges.load()) {
                record_gauges_2d(global_t2d);
            }

            if (!global_exec_until_end_fsi.load()) {
                global_target_steps_fsi--;
            }

            auto now = std::chrono::steady_clock::now();
            auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
            int target_interval_ms = std::max(16, global_telemetry_interval_ms.load());
            bool should_emit = (elapsed_ms >= target_interval_ms);

            if (should_emit || done) {
                double sim_time = global_solver_mpm_2d ? global_solver_mpm_2d->getSimTime() : global_t2d;

                int steps_in_interval = std::max(1, interval_steps);
                global_last_compute_ms = interval_compute_ms / steps_in_interval;
                global_last_io_ms = interval_io_ms / steps_in_interval;
                interval_compute_ms = 0.0;
                interval_io_ms = 0.0;
                interval_steps = 0;

                auto comms_start = std::chrono::steady_clock::now();
                if (has_solver_2d()) emit_telemetry_2d(global_t2d, false, global_step_fsi_2d.load());
                else if (global_solver_mpm_2d) emit_telemetry_mpm_2d(sim_time, false, global_step_fsi_2d.load());
                auto comms_end = std::chrono::steady_clock::now();
                double comms_ms = std::chrono::duration<double, std::milli>(comms_end - comms_start).count();
                global_last_comms_ms = comms_ms;
                global_cum_comms_s = global_cum_comms_s.load() + (comms_ms * 0.001);
                last_telemetry_time = now;

                nlohmann::json progress_msg;
                progress_msg["type"] = "progress";
                progress_msg["sim_time"] = sim_time;
                progress_msg["step"] = global_step_fsi_2d.load();
                progress_msg["dt"] = dt_common;
                progress_msg["scope"] = "2d";

                if (global_exec_until_end_fsi.load()) {
                    if (end_time > 0.0) {
                        int percent = std::clamp((int)((sim_time / end_time) * 100.0), 0, 99);
                        progress_msg["percent"] = percent;
                    } else {
                        progress_msg["percent"] = 50;
                    }
                    progress_msg["mode"] = "EXEC_ALL_FSI_2D";
                } else {
                    initial_steps = std::max(initial_steps, step_count + global_target_steps_fsi.load());
                    if (initial_steps > 0) {
                        int completed = initial_steps - global_target_steps_fsi.load();
                        int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 99);
                        progress_msg["percent"] = percent;
                        progress_msg["completed"] = completed;
                        progress_msg["total"] = initial_steps;
                        progress_msg["mode"] = "STEP_FSI_2D";
                    }
                }
                std::lock_guard<std::mutex> lock(cout_mutex);
                std::cout << progress_msg.dump() << std::endl;
            }
        }
    }

    double final_sim_time = global_solver_mpm_2d ? global_solver_mpm_2d->getSimTime() : global_t2d;
    if (interval_steps > 0) {
        int steps_in_interval = std::max(1, interval_steps);
        global_last_compute_ms = interval_compute_ms / steps_in_interval;
        global_last_io_ms = interval_io_ms / steps_in_interval;
    }
    double final_end_time = global_endtime_fsi.load();
    bool reached_end = (final_end_time > 0.0 && final_sim_time >= final_end_time - 1e-12);
    bool term_fsi_2d = !reached_end && ((global_solver_mpm_2d && global_solver_mpm_2d->is_terminated()) ||
                                        (global_solver_2d_cuda && global_solver_2d_cuda->checkTerminationCondition()) ||
                                        (global_solver_2d && global_solver_2d->checkTerminationCondition()));
    if (has_solver_2d()) emit_telemetry_2d(global_t2d, term_fsi_2d, global_step_fsi_2d.load());
    else if (global_solver_mpm_2d) emit_telemetry_mpm_2d(final_sim_time, term_fsi_2d, global_step_fsi_2d.load());
    flush_async_telemetry();
    write_gauge_files();
    if (term_fsi_2d) {
        emit_kernel_log("SYSTEM", "2D FSI simulation terminated at Terminate boundary.", final_sim_time, "2d", global_step_fsi_2d.load());
    } else if (reached_end) {
        emit_kernel_log("INFO", "Reached simulation end time (" + std::to_string(final_end_time) + " s). Simulation paused.", final_sim_time, "2d", global_step_fsi_2d.load());
    }

    nlohmann::json progress_msg;
    progress_msg["type"] = "progress";
    progress_msg["sim_time"] = final_sim_time;
    progress_msg["step"] = global_step_fsi_2d.load();
    progress_msg["scope"] = "2d";
    progress_msg["percent"] = 100;
    progress_msg["is_terminated"] = term_fsi_2d;
    progress_msg["mode"] = global_exec_until_end_fsi.load() ? "EXEC_ALL_FSI_2D" : "STEP_FSI_2D";
    {
        std::lock_guard<std::mutex> lock(cout_mutex);
        std::cout << progress_msg.dump() << std::endl;
    }

        sim_fsi_running = false;
        sim_fsi_paused = false;
        sim_fsi_terminate = false;
        global_target_steps_fsi = 0;
        global_exec_until_end_fsi = false;
    } catch (const std::exception& e) {
        emit_kernel_log("ERROR", std::string("2D FSI worker thread error: ") + e.what(), 0.0, "2d");
        sim_fsi_running = false;
        std::exit(1);
    } catch (...) {
        emit_kernel_log("ERROR", "2D FSI worker thread error: unknown exception", 0.0, "2d");
        sim_fsi_running = false;
        std::exit(1);
    }
}

void worker_fsi_3d_thread_func() {
    cudaSetDevice(global_cuda_device_index);
    try {
        int step_count = 0;
        int initial_steps = 0;
        double interval_compute_ms = 0.0;
        double interval_io_ms = 0.0;
        int interval_steps = 0;
        auto last_telemetry_time = std::chrono::steady_clock::now();
        double last_dt = (global_dt_3d > 1.0e-12) ? global_dt_3d : 0.0;

    while (!sim_fsi_3d_terminate.load()) {
        if (sim_fsi_3d_paused.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            continue;
        }

        bool done = false;
        double end_time = global_endtime_fsi_3d.load();
        bool is_term_fsi_3d = (global_solver_3d && global_solver_3d->is_terminated()) ||
                              (global_solver_mpm_3d_cuda && global_solver_mpm_3d_cuda->is_terminated()) ||
                              (global_solver_mpm_3d && global_solver_mpm_3d->is_terminated());
        if (end_time > 0.0 && global_t3d >= end_time - 1e-12) {
            done = true;
        } else if (is_term_fsi_3d) {
            done = true;
        } else if (!global_exec_until_end_fsi_3d.load()) {
            if (global_target_steps_fsi_3d.load() <= 0) done = true;
        }

        if (done) break;

        if ((global_solver_mpm_3d || global_solver_mpm_3d_cuda) && global_solver_3d) {
            auto step_start = std::chrono::steady_clock::now();
            float cfl = global_cfl_fsi_3d.load();

            if (global_solver_mpm_3d_cuda && global_solver_3d && global_solver_3d->isCUDA()) {
                // High-performance GPU-GPU FSI coupling (no CPU transfers, no CPU loops)
                global_solver_mpm_3d_cuda->particleToGridDeviceOnly();
                global_solver_3d->coupleFSIWithMPMGPU(global_solver_mpm_3d_cuda.get());
            } else {
                // Step 1: P2G — scatter particle mass/momentum to grid nodes
                if (global_solver_mpm_3d_cuda) {
                    global_solver_mpm_3d_cuda->particleToGridOnly(); // P2G on GPU, then downloads grid to host
                } else if (global_solver_mpm_3d) {
                    global_solver_mpm_3d->particleToGrid();
                }

                // Step 2: Coupled 3D FSI exchange — use populated grid to build solid mask and inject fluid pressure forces
                if ((global_solver_mpm_3d || global_solver_mpm_3d_cuda) && global_solver_3d) {
                    int nx = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getNx() : global_solver_mpm_3d->getNx();
                    int ny = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getNy() : global_solver_mpm_3d->getNy();
                    int nz = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getNz() : global_solver_mpm_3d->getNz();
                    float dx = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getDx() : global_solver_mpm_3d->getDx();
                    float dy = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getDy() : global_solver_mpm_3d->getDy();
                    float dz = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getDz() : global_solver_mpm_3d->getDz();

                    // Grid is now populated from P2G — read it to build solid mask and inject pressure forces
                    auto& grid = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getGrid() : global_solver_mpm_3d->getGrid();
                    std::vector<uint8_t> solid_mask(static_cast<size_t>(nx) * ny * nz, 0);
                    std::vector<double> solid_vel(3 * static_cast<size_t>(nx) * ny * nz, 0.0);

                    for (int i = 0; i < nx; ++i) {
                        for (int j = 0; j < ny; ++j) {
                            for (int k = 0; k < nz; ++k) {
                                size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                                auto& node = grid[node_idx];
                                size_t cfd_idx = static_cast<size_t>(i) + static_cast<size_t>(j) * nx + static_cast<size_t>(k) * nx * ny;
                                double z_node = global_solver_3d->getZMin() + (static_cast<double>(k) + 0.5) * global_solver_3d->getDz();
                                if (g_is_stratified_fsi.load() && z_node < g_strat_fsi_params.seabed_surface_z) {
                                    continue;
                                }
                                if (node.m_solid > 1.0e-8f) {
                                    solid_mask[cfd_idx] = 1;
                                    solid_vel[3 * cfd_idx + 0] = node.v(0);
                                    solid_vel[3 * cfd_idx + 1] = node.v(1);
                                    solid_vel[3 * cfd_idx + 2] = node.v(2);
                                }
                            }
                        }
                    }

                    // Pass MPM solid mask to 3D CFD solver so fluid shock/pressure reflects off MPM solids
                    global_solver_3d->setSolidMask(solid_mask.data());
                    global_solver_3d->setSolidVelocities(solid_vel.data());

                    // Bulk-download entire pressure field in ONE transfer (avoids per-cell cudaMemcpy)
                    std::vector<float> pfield = global_solver_3d->extractPressureField();
                    // Fall back to per-cell if extractPressureField returns nothing (CPU solver)
                    bool use_bulk = !pfield.empty();

                    // Inject fluid pressure gradient as external force into populated grid nodes
                    for (int i = 0; i < nx; ++i) {
                        for (int j = 0; j < ny; ++j) {
                            for (int k = 0; k < nz; ++k) {
                                size_t node_idx = (static_cast<size_t>(i) * ny + j) * nz + k;
                                auto& node = grid[node_idx];
                                if (node.m > 1.0e-8f) {
                                    auto is_fluid = [&](int xi, int yi, int zi) -> bool {
                                        if (xi < 0 || xi >= nx || yi < 0 || yi >= ny || zi < 0 || zi >= nz) return false;
                                        size_t idx = (static_cast<size_t>(xi) * ny + yi) * nz + zi;
                                        return (grid[idx].m_solid <= 1.0e-8f);
                                    };

                                    auto pidx = [&](int xi, int yi, int zi) -> double {
                                        xi = std::clamp(xi, 0, nx-1);
                                        yi = std::clamp(yi, 0, ny-1);
                                        zi = std::clamp(zi, 0, nz-1);
                                        if (use_bulk) {
                                            return pfield[xi + yi * nx + zi * nx * ny];
                                        } else {
                                            auto cv = global_solver_3d->getCellValues(xi, yi, zi);
                                            return (!cv.empty()) ? cv[0] : 0.0;
                                        }
                                    };

                                    double f_x = 0.0, f_y = 0.0, f_z = 0.0;
                                    if (node.m_solid > 1.0e-8f) {
                                        // Solid boundary node: surface pressure from fluid neighbor cells
                                        if (is_fluid(i-1, j, k)) f_x += pidx(i-1, j, k);
                                        if (is_fluid(i+1, j, k)) f_x -= pidx(i+1, j, k);
                                        if (is_fluid(i, j-1, k)) f_y += pidx(i, j-1, k);
                                        if (is_fluid(i, j+1, k)) f_y -= pidx(i, j+1, k);
                                        if (is_fluid(i, j, k-1)) f_z += pidx(i, j, k-1);
                                        if (is_fluid(i, j, k+1)) f_z -= pidx(i, j, k+1);

                                        node.f_ext[0] = static_cast<float>(f_x * dy * dz);
                                        node.f_ext[1] = static_cast<float>(f_y * dx * dz);
                                        node.f_ext[2] = static_cast<float>(f_z * dx * dy);
                                    } else {
                                        // Fluid sleeve node: in zonal architecture, fluid particles evolve under
                                        // Lagrangian stress divergence without artificial discrete knife-edge surface kicks
                                        node.f_ext[0] = 0.0f;
                                        node.f_ext[1] = 0.0f;
                                        node.f_ext[2] = 0.0f;
                                    }
                                }
                            }
                        }
                    }

                    // Upload the grid with FSI forces back to GPU (for CUDA path) or cache on CPU
                    if (global_solver_mpm_3d_cuda) {
                        global_solver_mpm_3d_cuda->uploadGridToDevice();
                        global_solver_mpm_3d_cuda->storeFSIForces();
                    } else if (global_solver_mpm_3d) {
                        global_solver_mpm_3d->storeFSIForces();
                    }
                }
            }

            // Step 3: Calculate coupled CFL stability timestep
            float dt_mpm = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->computeStepSize(cfl)
                         : (global_solver_mpm_3d ? global_solver_mpm_3d->computeStepSize(cfl) : 1.0e-4f);
            double dt_cfd = global_solver_3d ? global_solver_3d->computeStepSize(cfl) : 1.0e-4;

            double dt_phys = std::min(static_cast<double>(dt_mpm), dt_cfd);
            double dt_common = dt_phys;
            if (global_step_3d.load() == 0 && step_count == 0) {
                // Physical acoustic startup timestep without arbitrary 100ns suppression
                dt_common = std::max(1.0e-11, 0.5 * dt_phys);
            } else if (last_dt > 1.0e-11) {
                dt_common = std::min(dt_phys, 1.5 * last_dt);
            } else {
                dt_common = dt_phys;
            }
            if (end_time > 0.0 && global_t3d + dt_common > end_time) {
                dt_common = std::max(1e-12, end_time - global_t3d);
            }
            dt_common = std::max(dt_common, 1.0e-11);
            last_dt = dt_common;
            global_dt_3d = dt_common; // Ensure telemetry reports the correct timestep

            if (global_solver_mpm_3d_cuda) {
                global_solver_mpm_3d_cuda->stepWithDt(static_cast<float>(dt_common), false);
            } else if (global_solver_mpm_3d) {
                global_solver_mpm_3d->stepWithDt(static_cast<float>(dt_common), false);
            }

            if (global_solver_3d) {
                global_solver_3d->step(dt_common);
                if (global_phase_particles_3d && global_phase_particles_3d->getParticleCount() > 0) {
                    step_phase_tracking_particles_3d(static_cast<float>(dt_common));
                }
                global_t3d += dt_common;
            }

            // Synchronize MPM fluid sleeve particles with updated Eulerian fluid state
            if (global_solver_mpm_3d_cuda && global_solver_3d && global_solver_3d->isCUDA()) {
                global_solver_3d->synchronizeFluidSleeveWithMPMGPU(global_solver_mpm_3d_cuda.get());
            }

            // Direct hydrodynamic / aerodynamic drag coupling onto debris and water sleeve particles
            if (global_solver_mpm_3d && global_solver_3d) {
                auto& particles = global_solver_mpm_3d->getParticles();
                double f_xmin = global_solver_3d->getXMin();
                double f_ymin = global_solver_3d->getYMin();
                double f_zmin = global_solver_3d->getZMin();
                double f_dx = global_solver_3d->getDx();
                double f_dy = global_solver_3d->getDy();
                double f_dz = global_solver_3d->getDz();
                int f_nx = global_solver_3d->getNx();
                int f_ny = global_solver_3d->getNy();
                int f_nz = global_solver_3d->getNz();
                float dt_f = static_cast<float>(dt_common);
                int num_mat_tables = static_cast<int>(global_solver_mpm_3d->getMaterialTables().size());
                for (auto& p : particles) {
                    bool is_fluid_p = (p.object_id >= 0 && p.object_id < num_mat_tables)
                        ? (global_solver_mpm_3d->getMaterialTable(p.object_id).material_model == Blast::MPMMaterialModel::TaitWater)
                        : false;
                    if (is_fluid_p) {
                        int ci = std::clamp(static_cast<int>(std::floor((p.x[0] - f_xmin) / f_dx)), 0, f_nx - 1);
                        int cj = std::clamp(static_cast<int>(std::floor((p.x[1] - f_ymin) / f_dy)), 0, f_ny - 1);
                        int ck = std::clamp(static_cast<int>(std::floor((p.x[2] - f_zmin) / f_dz)), 0, f_nz - 1);
                        float u_f = 0.0f, v_f = 0.0f, w_f = 0.0f, rho_f = 0.0f, p_f = 0.0f;
                        if (global_solver_3d->getFluidVelocity(ci, cj, ck, u_f, v_f, w_f, rho_f, p_f)) {
                            p.v[0] = u_f;
                            p.v[1] = v_f;
                            p.v[2] = w_f;
                            if (rho_f > 1.0e-3f) {
                                p.V = p.m / rho_f;
                            }
                            p.sigma[0][0] = -p_f;
                            p.sigma[1][1] = -p_f;
                            p.sigma[2][2] = -p_f;
                            p.sigma[0][1] = p.sigma[1][0] = 0.0f;
                            p.sigma[0][2] = p.sigma[2][0] = 0.0f;
                            p.sigma[1][2] = p.sigma[2][1] = 0.0f;
                        }
                    } else if (p.has_failed || p.damage >= 1.0f) {
                        int ci = std::clamp(static_cast<int>(std::floor((p.x[0] - f_xmin) / f_dx)), 0, f_nx - 1);
                        int cj = std::clamp(static_cast<int>(std::floor((p.x[1] - f_ymin) / f_dy)), 0, f_ny - 1);
                        int ck = std::clamp(static_cast<int>(std::floor((p.x[2] - f_zmin) / f_dz)), 0, f_nz - 1);
                        float u_f = 0.0f, v_f = 0.0f, w_f = 0.0f, rho_f = 0.0f, p_f = 0.0f;
                        if (global_solver_3d->getFluidVelocity(ci, cj, ck, u_f, v_f, w_f, rho_f, p_f)) {
                            float rel_vx = u_f - p.v[0];
                            float rel_vy = v_f - p.v[1];
                            float rel_vz = w_f - p.v[2];
                            float rel_v = std::sqrt(rel_vx * rel_vx + rel_vy * rel_vy + rel_vz * rel_vz);
                            if (rel_v > 1.0e-4f) {
                                float r_p = (p.contact_radius > 0.0f) ? p.contact_radius : (0.5f * std::cbrt(std::max(1.0e-12f, p.V)));
                                float A_p = 3.14159265f * r_p * r_p;
                                float Cd = 1.2f;
                                float F_drag = 0.5f * Cd * rho_f * A_p * rel_v;
                                float m_p = std::max(1.0e-12f, p.m);
                                float dv_mag = (dt_f * F_drag) / m_p;
                                if (dv_mag > rel_v) dv_mag = rel_v;
                                float factor = dv_mag / rel_v;
                                p.v[0] += factor * rel_vx;
                                p.v[1] += factor * rel_vy;
                                p.v[2] += factor * rel_vz;
                            }
                        }
                    }
                }
            }

            auto step_end = std::chrono::steady_clock::now();
            double comp_ms = std::chrono::duration<double, std::milli>(step_end - step_start).count();
            interval_compute_ms += comp_ms;
            global_cum_compute_s = global_cum_compute_s.load() + (comp_ms * 0.001);

            global_step_fsi_3d++;
            global_step_3d++;
            step_count++;

            // Opt-in numerical health diagnostics (headless stability verification of captured models)
            static const bool diag3d_enabled = (std::getenv("BLAST_DIAG") != nullptr);
            static const int diag3d_every = std::getenv("BLAST_DIAG_EVERY") ? std::max(1, std::atoi(std::getenv("BLAST_DIAG_EVERY"))) : 1;
            if (diag3d_enabled && global_solver_3d && (global_step_fsi_3d.load() % diag3d_every) == 0) {
                std::vector<float> pf = global_solver_3d->extractPressureField();
                double p_max = -1.0e300, p_min = 1.0e300;
                size_t n_nonfinite = 0, n_gt_1e10 = 0, n_gt_1e12 = 0;
                size_t p_max_idx = 0, p_min_idx = 0;
                for (size_t pi = 0; pi < pf.size(); ++pi) {
                    float v = pf[pi];
                    if (!std::isfinite(v)) { ++n_nonfinite; continue; }
                    if (static_cast<double>(v) > p_max) p_max_idx = pi;
                    p_max = std::max(p_max, static_cast<double>(v));
                    if (static_cast<double>(v) < p_min) p_min_idx = pi;
                    p_min = std::min(p_min, static_cast<double>(v));
                    if (v > 1.0e10f) ++n_gt_1e10;
                    if (v > 1.0e12f) ++n_gt_1e12;
                }
                double mpm_vmax = 0.0;
                size_t mpm_active = 0;
                size_t fastest_p_idx = static_cast<size_t>(-1);
                double fastest_vm = 0.0;
                // Opt-in MPM phase statistics (reacted explosive = lambda > 0.5, everything else = water/other)
                size_t g_n = 0, w_n = 0;
                double g_m = 0.0, g_V = 0.0, g_rmax = 0.0, g_J = 0.0, w_m = 0.0, w_V = 0.0, w_Jmin = 1.0e30, g_ke = 0.0, w_ke = 0.0, g_e = 0.0;
                const double zc_diag = std::getenv("BLAST_DIAG_ZC") ? std::atof(std::getenv("BLAST_DIAG_ZC")) : 5.0;
                if (global_solver_mpm_3d_cuda && global_solver_mpm_3d_cuda->getParticleCount() > 0) {
                    global_solver_mpm_3d_cuda->syncParticlesToHost();
                    const auto& parts = global_solver_mpm_3d_cuda->getParticles();
                    for (size_t pi = 0; pi < parts.size(); ++pi) {
                        const auto& p = parts[pi];
                        if (p.m <= 0.0f || p.state == 2) continue;
                        ++mpm_active;
                        {
                            const double v2 = static_cast<double>(p.v[0]) * p.v[0] + static_cast<double>(p.v[1]) * p.v[1] + static_cast<double>(p.v[2]) * p.v[2];
                            if (p.lambda > 0.5f) {
                                ++g_n; g_m += p.m; g_V += p.V; g_J += p.J; g_ke += 0.5 * p.m * v2; g_e += static_cast<double>(p.m) * p.e_int;
                                const double rr = std::sqrt(static_cast<double>(p.x[0]) * p.x[0] + static_cast<double>(p.x[1]) * p.x[1] + (p.x[2] - zc_diag) * (p.x[2] - zc_diag));
                                g_rmax = std::max(g_rmax, rr);
                            } else {
                                ++w_n; w_m += p.m; w_V += p.V; w_Jmin = std::min(w_Jmin, static_cast<double>(p.J)); w_ke += 0.5 * p.m * v2;
                            }
                        }
                        double vm = std::sqrt(static_cast<double>(p.v[0]) * p.v[0] + static_cast<double>(p.v[1]) * p.v[1] + static_cast<double>(p.v[2]) * p.v[2]);
                        if (!std::isfinite(vm)) { ++n_nonfinite; continue; }
                        if (vm > fastest_vm) {
                            fastest_vm = vm;
                            fastest_p_idx = pi;
                        }
                        mpm_vmax = std::max(mpm_vmax, vm);
                    }
                }
                // Point-wise 6-neighbour noise audit: an isolated spike/dip is a cell whose pressure exceeds
                // (or falls below) every face neighbour by more than 3x while above a 10 MPa significance level.
                size_t n_spike = 0, n_dip = 0;
                size_t first_spike_idx = static_cast<size_t>(-1);
                size_t first_dip_idx = static_cast<size_t>(-1);
                {
                    const int snx = global_solver_3d->getNx(), sny = global_solver_3d->getNy(), snz = global_solver_3d->getNz();
                    auto P = [&](int i, int j, int k) { return static_cast<double>(pf[static_cast<size_t>(i) + static_cast<size_t>(j) * snx + static_cast<size_t>(k) * snx * sny]); };
                    for (int k = 1; k < snz - 1; ++k)
                        for (int j = 1; j < sny - 1; ++j)
                            for (int i = 1; i < snx - 1; ++i) {
                                const double c = P(i, j, k);
                                const double nb[6] = {P(i-1,j,k), P(i+1,j,k), P(i,j-1,k), P(i,j+1,k), P(i,j,k-1), P(i,j,k+1)};
                                double nmax = nb[0], nmin = nb[0];
                                for (int q = 1; q < 6; ++q) { nmax = std::max(nmax, nb[q]); nmin = std::min(nmin, nb[q]); }
                                if (c > 1.0e7 && c > 3.0 * nmax) { if (first_spike_idx == static_cast<size_t>(-1)) first_spike_idx = static_cast<size_t>(i) + static_cast<size_t>(j) * snx + static_cast<size_t>(k) * snx * sny; ++n_spike; }
                                if (nmin > 1.0e7 && c < nmin / 5.0) { if (first_dip_idx == static_cast<size_t>(-1)) first_dip_idx = static_cast<size_t>(i) + static_cast<size_t>(j) * snx + static_cast<size_t>(k) * snx * sny; ++n_dip; }
                            }
                }
                std::printf("[DIAG3D_MPM] step=%d t=%.6e gas_n=%zu gas_m=%.5f gas_V=%.5e gas_rho=%.2f gas_Jmean=%.3f gas_rmax=%.3f gas_ke=%.4e gas_eint=%.4e water_n=%zu water_m=%.2f water_V=%.4f water_Jmin=%.4f water_ke=%.4e\n",
                            global_step_fsi_3d.load(), global_t3d, g_n, g_m, g_V, (g_V > 0.0 ? g_m / g_V : 0.0), (g_n ? g_J / g_n : 0.0), g_rmax, g_ke, g_e, w_n, w_m, w_V, w_Jmin, w_ke);
                std::printf("[DIAG3D_NOISE] step=%d n_spike=%zu n_dip=%zu\n", global_step_fsi_3d.load(), n_spike, n_dip);
                std::fflush(stdout);
                std::printf("[DIAG3D] step=%d t=%.6e dt=%.4e p_max=%.4e p_min=%.4e n_nonfinite=%zu n_gt_1e10=%zu n_gt_1e12=%zu mpm_active=%zu mpm_vmax=%.3f n_spike=%zu n_dip=%zu\n",
                            global_step_fsi_3d.load(), global_t3d, dt_common, p_max, p_min, n_nonfinite, n_gt_1e10, n_gt_1e12, mpm_active, mpm_vmax, n_spike, n_dip);
                std::fflush(stdout);
                if (fastest_p_idx != static_cast<size_t>(-1) && fastest_vm > 1000.0) {
                    const auto& fp = global_solver_mpm_3d_cuda->getParticles()[fastest_p_idx];
                    std::printf("[DIAG3D_FAST_P] step=%d idx=%zu obj=%d lam=%.2f x=(%.3f,%.3f,%.3f) v=(%.1f,%.1f,%.1f) vm=%.1f m=%.3e V=%.3e V0=%.3e J=%.3f e=%.3e press=%.3e B00=%.1e\n",
                                global_step_fsi_3d.load(), fastest_p_idx, fp.object_id, fp.lambda,
                                fp.x[0], fp.x[1], fp.x[2], fp.v[0], fp.v[1], fp.v[2], fastest_vm,
                                fp.m, fp.V, fp.V0, fp.J, fp.e_int,
                                -(fp.sigma.data[0] + fp.sigma.data[1] + fp.sigma.data[2]) / 3.0f, fp.B[0][0]);
                    std::fflush(stdout);
                }
                if (n_spike > 0 && std::getenv("BLAST_DIAG_SPIKES")) {
                    int cnx = global_solver_3d->getNx(), cny = global_solver_3d->getNy();
                    int ci = static_cast<int>(first_spike_idx % cnx);
                    int cj = static_cast<int>((first_spike_idx / cnx) % cny);
                    int ck = static_cast<int>(first_spike_idx / (static_cast<size_t>(cnx) * cny));
                    const int off[7][3] = {{0,0,0},{-1,0,0},{1,0,0},{0,-1,0},{0,1,0},{0,0,-1},{0,0,1}};
                    for (int q = 0; q < 7; ++q) {
                        std::vector<float> cv = global_solver_3d->getCellValues(ci + off[q][0], cj + off[q][1], ck + off[q][2]);
                        std::printf("[DIAG3D_SPIKE] step=%d q=%d ijk=%d,%d,%d p=%.4e rho=%.4e |u|=%.4e a1=%.4e a3=%.4e arho1=%.4e arho2=%.4e\n",
                                    global_step_fsi_3d.load(), q, ci + off[q][0], cj + off[q][1], ck + off[q][2],
                                    cv[0], cv[1], cv[2], cv[4], cv[6], cv[10], cv[11]);
                    }
                    std::fflush(stdout);
                }
                if (n_dip > 0) {
                    int cnx = global_solver_3d->getNx(), cny = global_solver_3d->getNy();
                    int ci = static_cast<int>(first_dip_idx % cnx);
                    int cj = static_cast<int>((first_dip_idx / cnx) % cny);
                    int ck = static_cast<int>(first_dip_idx / (static_cast<size_t>(cnx) * cny));
                    const int off[7][3] = {{0,0,0},{-1,0,0},{1,0,0},{0,-1,0},{0,1,0},{0,0,-1},{0,0,1}};
                    for (int q = 0; q < 7; ++q) {
                        std::vector<float> cv = global_solver_3d->getCellValues(ci + off[q][0], cj + off[q][1], ck + off[q][2]);
                        std::printf("[DIAG3D_DIP] step=%d q=%d ijk=%d,%d,%d p=%.4e rho=%.4e |u|=%.4e a1=%.4e a3=%.4e arho1=%.4e arho2=%.4e\n",
                                    global_step_fsi_3d.load(), q, ci + off[q][0], cj + off[q][1], ck + off[q][2],
                                    cv[0], cv[1], cv[2], cv[4], cv[6], cv[10], cv[11]);
                    }
                    std::fflush(stdout);
                }
                if (std::getenv("BLAST_DIAG_PMIN") && (global_step_fsi_3d.load() % 100) == 0) {
                    int cnx = global_solver_3d->getNx(), cny = global_solver_3d->getNy();
                    int ci = static_cast<int>(p_min_idx % cnx);
                    int cj = static_cast<int>((p_min_idx / cnx) % cny);
                    int ck = static_cast<int>(p_min_idx / (static_cast<size_t>(cnx) * cny));
                    const int off[7][3] = {{0,0,0},{-1,0,0},{1,0,0},{0,-1,0},{0,1,0},{0,0,-1},{0,0,1}};
                    for (int q = 0; q < 7; ++q) {
                        std::vector<float> cv = global_solver_3d->getCellValues(ci + off[q][0], cj + off[q][1], ck + off[q][2]);
                        std::printf("[DIAG3D_PMIN] step=%d q=%d ijk=%d,%d,%d p=%.4e rho=%.4e |u|=%.4e a1=%.4e a3=%.4e arho1=%.4e arho2=%.4e\n",
                                    global_step_fsi_3d.load(), q, ci + off[q][0], cj + off[q][1], ck + off[q][2],
                                    cv[0], cv[1], cv[2], cv[4], cv[6], cv[10], cv[11]);
                    }
                    std::fflush(stdout);
                }
                if (std::getenv("BLAST_DIAG_PROFILE")) {
                    // Axis profile through the charge centre (x=0,y=0 column): bubble extent where alpha1 > 0.5,
                    // plus p, rho, uz, alpha1 for the +z half. Opt-in only.
                    const int pnz = global_solver_3d->getNz();
                    double zc = std::getenv("BLAST_DIAG_ZC") ? std::atof(std::getenv("BLAST_DIAG_ZC")) : 5.0;
                    double dz_ = global_solver_3d->getCellSize();
                    double zmin_ = global_solver_3d->getZMin();
                    int kc = static_cast<int>((zc - zmin_) / dz_);
                    double r_bub = 0.0;
                    std::string prof;
                    for (int k = kc; k < pnz; ++k) {
                        std::vector<float> cv = global_solver_3d->getCellValues(0, 0, k);
                        if (cv[4] > 0.05f || cv[1] < 500.0f) r_bub = (k - kc + 1) * dz_;
                        if (((k - kc) % 4) == 0 && (k - kc) < 40) {
                            char b[160];
                            std::snprintf(b, sizeof(b), " [r=%.2f p=%.3e rho=%.1f a1=%.3f u=%.1f]", (k - kc + 0.5) * dz_, cv[0], cv[1], cv[4], cv[2]);
                            prof += b;
                        }
                    }
                    std::printf("[DIAG3D_PROFILE] step=%d t=%.6e r_bubble_axis=%.3f%s\n", global_step_fsi_3d.load(), global_t3d, r_bub, prof.c_str());
                    std::fflush(stdout);
                }
                static const int diag_cells_every = std::getenv("BLAST_DIAG_CELLS") ? std::max(1, std::atoi(std::getenv("BLAST_DIAG_CELLS"))) : 0;
                if (global_solver_3d && (p_max > 1.0e10 || (diag_cells_every > 0 && (global_step_fsi_3d.load() % diag_cells_every) == 0))) {
                    int cnx = global_solver_3d->getNx(), cny = global_solver_3d->getNy();
                    int ci = static_cast<int>(p_max_idx % cnx);
                    int cj = static_cast<int>((p_max_idx / cnx) % cny);
                    int ck = static_cast<int>(p_max_idx / (static_cast<size_t>(cnx) * cny));
                    const int off[7][3] = {{0,0,0},{-1,0,0},{1,0,0},{0,-1,0},{0,1,0},{0,0,-1},{0,0,1}};
                    for (int q = 0; q < 7; ++q) {
                        std::vector<float> cv = global_solver_3d->getCellValues(ci + off[q][0], cj + off[q][1], ck + off[q][2]);
                        std::printf("[DIAG3D_CELL] step=%d q=%d ijk=%d,%d,%d p=%.4e rho=%.4e |u|=%.4e a1=%.4e a2=%.4e a3=%.4e\n",
                                    global_step_fsi_3d.load(), q, ci + off[q][0], cj + off[q][1], ck + off[q][2],
                                    cv[0], cv[1], cv[2], cv[4], cv[5], cv[6]);
                    }
                    std::fflush(stdout);
                }
            }

            if (global_enable_gauges.load() && global_solver_3d) {
                record_gauges_3d(global_t3d);
            }

            auto io_start = std::chrono::steady_clock::now();
            if (global_enable_vtk.load()) {
                double last_time = global_last_vtk_time_fsi_3d.load();
                if (should_write_vtk(global_step_fsi_3d.load(), global_t3d, last_time)) {
                    write_vtk_outputs(global_step_fsi_3d.load(), global_t3d);
                    update_last_vtk_time(global_last_vtk_time_fsi_3d, global_t3d);
                }
            }
            auto io_end = std::chrono::steady_clock::now();
            double io_step_ms = std::chrono::duration<double, std::milli>(io_end - io_start).count();
            interval_io_ms += io_step_ms;
            global_cum_io_s = global_cum_io_s.load() + (io_step_ms * 0.001);
            interval_steps++;

            if (!global_exec_until_end_fsi_3d.load()) {
                global_target_steps_fsi_3d--;
            }

            auto now = std::chrono::steady_clock::now();
            auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
            int target_interval_ms = std::max(16, global_telemetry_interval_ms.load());
            bool should_emit = (elapsed_ms >= target_interval_ms);

            if (should_emit || done) {
                double sim_time = global_t3d;

                int steps_in_interval = std::max(1, interval_steps);
                global_last_compute_ms = interval_compute_ms / steps_in_interval;
                global_last_io_ms = interval_io_ms / steps_in_interval;
                interval_compute_ms = 0.0;
                interval_io_ms = 0.0;
                interval_steps = 0;

                // Emit single unified telemetry frame (emit_telemetry_3d packs CFD slices, MPM particles, and FEM mesh atomically)
                auto comms_start = std::chrono::steady_clock::now();
                if (global_solver_3d) {
                    emit_telemetry_3d(global_t3d, false, global_step_fsi_3d.load());
                } else if ((global_solver_mpm_3d_cuda && global_solver_mpm_3d_cuda->getParticleCount() > 0) || (global_solver_mpm_3d && !global_solver_mpm_3d->getParticles().empty())) {
                    emit_telemetry_mpm_3d(global_t3d, false, global_step_fsi_3d.load());
                }
                auto comms_end = std::chrono::steady_clock::now();
                double comms_ms = std::chrono::duration<double, std::milli>(comms_end - comms_start).count();
                global_last_comms_ms = comms_ms;
                global_cum_comms_s = global_cum_comms_s.load() + (comms_ms * 0.001);
                last_telemetry_time = now;

                nlohmann::json progress_msg;
                progress_msg["type"] = "progress";
                progress_msg["sim_time"] = sim_time;
                progress_msg["step"] = global_step_fsi_3d.load();
                progress_msg["dt"] = dt_common;
                progress_msg["scope"] = "3d";

                if (global_exec_until_end_fsi_3d.load()) {
                    if (end_time > 0.0) {
                        int percent = std::clamp((int)((global_t3d / end_time) * 100.0), 0, 99);
                        progress_msg["percent"] = percent;
                    } else {
                        progress_msg["percent"] = 50;
                    }
                    progress_msg["mode"] = "EXEC_ALL_FSI_3D";
                } else {
                    initial_steps = std::max(initial_steps, step_count + global_target_steps_fsi_3d.load());
                    if (initial_steps > 0) {
                        int completed = initial_steps - global_target_steps_fsi_3d.load();
                        int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 99);
                        progress_msg["percent"] = percent;
                        progress_msg["completed"] = completed;
                        progress_msg["total"] = initial_steps;
                        progress_msg["mode"] = "STEP_FSI_3D";
                    }
                }
                std::lock_guard<std::mutex> lock(cout_mutex);
                std::cout << progress_msg.dump() << std::endl;
            }
        }
    }

    double final_sim_time = global_t3d;
    double final_end_time = global_endtime_fsi_3d.load();
    bool reached_end = (final_end_time > 0.0 && final_sim_time >= final_end_time - 1e-12);
    bool term_fsi_3d = !reached_end && ((global_solver_3d && global_solver_3d->is_terminated()) ||
                                        (global_solver_mpm_3d_cuda && global_solver_mpm_3d_cuda->is_terminated()) ||
                                        (global_solver_mpm_3d && global_solver_mpm_3d->is_terminated()));
    if (global_enable_vtk.load() && reached_end && should_write_final_vtk(final_sim_time, global_last_vtk_time_fsi_3d.load())) {
        write_vtk_outputs(global_step_fsi_3d.load(), final_sim_time);
        update_last_vtk_time(global_last_vtk_time_fsi_3d, final_sim_time);
    }
    if (interval_steps > 0) {
        int steps_in_interval = std::max(1, interval_steps);
        global_last_compute_ms = interval_compute_ms / steps_in_interval;
        global_last_io_ms = interval_io_ms / steps_in_interval;
    }
    if (global_solver_3d) {
        emit_telemetry_3d(global_t3d, term_fsi_3d, global_step_fsi_3d.load());
    } else if ((global_solver_mpm_3d_cuda && global_solver_mpm_3d_cuda->getParticleCount() > 0) || (global_solver_mpm_3d && !global_solver_mpm_3d->getParticles().empty())) {
        emit_telemetry_mpm_3d(global_t3d, term_fsi_3d, global_step_fsi_3d.load());
    }
    flush_async_telemetry();
    write_gauge_files();

    if (term_fsi_3d) {
        emit_kernel_log("SYSTEM", "3D FSI simulation terminated at Terminate boundary.", final_sim_time, "3d", global_step_fsi_3d.load());
    } else if (reached_end) {
        emit_kernel_log("INFO", "Reached simulation end time (" + std::to_string(final_end_time) + " s). Simulation paused.", final_sim_time, "3d", global_step_fsi_3d.load());
    }

    nlohmann::json progress_msg;
    progress_msg["type"] = "progress";
    progress_msg["sim_time"] = final_sim_time;
    progress_msg["step"] = global_step_fsi_3d.load();
    progress_msg["scope"] = "3d";
    progress_msg["percent"] = 100;
    progress_msg["is_terminated"] = term_fsi_3d;
    progress_msg["mode"] = global_exec_until_end_fsi_3d.load() ? "EXEC_ALL_FSI_3D" : "STEP_FSI_3D";
    {
        std::lock_guard<std::mutex> lock(cout_mutex);
        std::cout << progress_msg.dump() << std::endl;
    }

        sim_fsi_3d_running = false;
        sim_fsi_3d_paused = false;
        sim_fsi_3d_terminate = false;
        global_target_steps_fsi_3d = 0;
        global_exec_until_end_fsi_3d = false;
    } catch (const std::exception& e) {
        emit_kernel_log("ERROR", std::string("3D FSI worker thread error: ") + e.what(), 0.0, "3d");
        sim_fsi_3d_running = false;
        std::exit(1);
    } catch (...) {
        emit_kernel_log("ERROR", "3D FSI worker thread error: unknown exception", 0.0, "3d");
        sim_fsi_3d_running = false;
        std::exit(1);
    }
}

std::atomic<bool> sim_fem_fsi_3d_paused{false};
std::atomic<bool> sim_fem_fsi_3d_terminate{false};
std::atomic<bool> global_exec_until_end_fem_fsi_3d{false};
std::atomic<int> global_target_steps_fem_fsi_3d{0};
std::atomic<float> global_cfl_fem_fsi_3d{0.6f};
std::atomic<double> global_endtime_fem_fsi_3d{1.0};

void worker_fem_fsi_3d_thread_func() {
    try {
        int step_count = 0;
        int initial_steps = 0;
        double interval_compute_ms = 0.0;
        double interval_io_ms = 0.0;
        int interval_steps = 0;
        auto last_telemetry_time = std::chrono::steady_clock::now();
        double last_dt = (global_dt_3d > 1.0e-12) ? global_dt_3d : 0.0;

        std::string m_id = global_model_id.empty() ? "default_fem" : global_model_id;

        while (!sim_fem_fsi_3d_terminate.load()) {
            if (sim_fem_fsi_3d_paused.load()) {
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
                continue;
            }

            bool done = false;
            double end_time = global_endtime_fem_fsi_3d.load();
            bool is_term_fem_fsi_3d = (global_solver_3d && global_solver_3d->is_terminated()) ||
                                      (global_solver_mpm_3d_cuda && global_solver_mpm_3d_cuda->is_terminated()) ||
                                      (global_solver_mpm_3d && global_solver_mpm_3d->is_terminated());
            if (end_time > 0.0 && global_t3d >= end_time - 1e-12) {
                done = true;
            } else if (is_term_fem_fsi_3d) {
                done = true;
            } else if (!global_exec_until_end_fem_fsi_3d.load()) {
                if (global_target_steps_fem_fsi_3d.load() <= 0) done = true;
            }

            if (done) break;

            auto step_start = std::chrono::steady_clock::now();
            float cfl = global_cfl_fem_fsi_3d.load();

            // Run appropriate coupler instance
            if (global_fem_fsi_couplers_cuda_float.count(m_id) && global_fem_fsi_couplers_cuda_float[m_id]) {
                auto* coupler = global_fem_fsi_couplers_cuda_float[m_id].get();
                coupler->step(cfl);
                last_dt = static_cast<double>(coupler->getLastDt());
                global_t3d = static_cast<double>(coupler->getSimTime());
            } else if (!global_fem_fsi_couplers_cuda_float.empty()) {
                auto* coupler = global_fem_fsi_couplers_cuda_float.begin()->second.get();
                coupler->step(cfl);
                last_dt = static_cast<double>(coupler->getLastDt());
                global_t3d = static_cast<double>(coupler->getSimTime());
            } else if (global_fem_fsi_couplers_cuda_double.count(m_id) && global_fem_fsi_couplers_cuda_double[m_id]) {
                auto* coupler = global_fem_fsi_couplers_cuda_double[m_id].get();
                coupler->step(static_cast<double>(cfl));
                last_dt = coupler->getLastDt();
                global_t3d = coupler->getSimTime();
            } else if (!global_fem_fsi_couplers_cuda_double.empty()) {
                auto* coupler = global_fem_fsi_couplers_cuda_double.begin()->second.get();
                coupler->step(static_cast<double>(cfl));
                last_dt = coupler->getLastDt();
                global_t3d = coupler->getSimTime();
            } else if (global_fem_fsi_couplers_float.count(m_id) && global_fem_fsi_couplers_float[m_id]) {
                auto* coupler = global_fem_fsi_couplers_float[m_id].get();
                coupler->step(cfl);
                last_dt = static_cast<double>(coupler->getLastDt());
                global_t3d = static_cast<double>(coupler->getSimTime());
            } else if (!global_fem_fsi_couplers_float.empty()) {
                auto* coupler = global_fem_fsi_couplers_float.begin()->second.get();
                coupler->step(cfl);
                last_dt = static_cast<double>(coupler->getLastDt());
                global_t3d = static_cast<double>(coupler->getSimTime());
            } else if (global_fem_fsi_couplers_double.count(m_id) && global_fem_fsi_couplers_double[m_id]) {
                auto* coupler = global_fem_fsi_couplers_double[m_id].get();
                coupler->step(static_cast<double>(cfl));
                last_dt = coupler->getLastDt();
                global_t3d = coupler->getSimTime();
            } else if (!global_fem_fsi_couplers_double.empty()) {
                auto* coupler = global_fem_fsi_couplers_double.begin()->second.get();
                coupler->step(static_cast<double>(cfl));
                last_dt = coupler->getLastDt();
                global_t3d = coupler->getSimTime();
            } else {
                if (global_solver_3d) global_solver_3d->step(last_dt);
            }

            if (global_phase_particles_3d && global_phase_particles_3d->getParticleCount() > 0) {
                step_phase_tracking_particles_3d(static_cast<float>(last_dt));
            }

            // Advance MPM particles (nearfield water sleeve / soil / debris) in coupled multi-physics
            if (global_solver_mpm_3d_cuda && global_solver_mpm_3d_cuda->getParticleCount() > 0) {
                global_solver_mpm_3d_cuda->stepWithDt(static_cast<float>(last_dt));
            } else if (global_solver_mpm_3d && !global_solver_mpm_3d->getParticles().empty()) {
                global_solver_mpm_3d->stepWithDt(static_cast<float>(last_dt));
            }

            auto step_end = std::chrono::steady_clock::now();
            double comp_ms = std::chrono::duration<double, std::milli>(step_end - step_start).count();
            interval_compute_ms += comp_ms;
            global_cum_compute_s = global_cum_compute_s.load() + (comp_ms * 0.001);

            global_dt_3d = last_dt;
            global_step_fem_fsi_3d++;
            global_step_3d++;
            step_count++;

            if (global_enable_gauges.load() && global_solver_3d) {
                record_gauges_3d(global_t3d);
            }

            int current_step = global_step_fem_fsi_3d.load();
            if (global_fem_fsi_couplers_cuda_float.count(m_id) && global_fem_fsi_couplers_cuda_float[m_id]) {
                current_step = std::max(current_step, global_fem_fsi_couplers_cuda_float[m_id]->getStepCount());
            } else if (!global_fem_fsi_couplers_cuda_float.empty()) {
                current_step = std::max(current_step, global_fem_fsi_couplers_cuda_float.begin()->second->getStepCount());
            } else if (global_fem_fsi_couplers_cuda_double.count(m_id) && global_fem_fsi_couplers_cuda_double[m_id]) {
                current_step = std::max(current_step, global_fem_fsi_couplers_cuda_double[m_id]->getStepCount());
            } else if (!global_fem_fsi_couplers_cuda_double.empty()) {
                current_step = std::max(current_step, global_fem_fsi_couplers_cuda_double.begin()->second->getStepCount());
            } else if (global_fem_fsi_couplers_float.count(m_id) && global_fem_fsi_couplers_float[m_id]) {
                current_step = std::max(current_step, global_fem_fsi_couplers_float[m_id]->getStepCount());
            } else if (!global_fem_fsi_couplers_float.empty()) {
                current_step = std::max(current_step, global_fem_fsi_couplers_float.begin()->second->getStepCount());
            } else if (global_fem_fsi_couplers_double.count(m_id) && global_fem_fsi_couplers_double[m_id]) {
                current_step = std::max(current_step, global_fem_fsi_couplers_double[m_id]->getStepCount());
            } else if (!global_fem_fsi_couplers_double.empty()) {
                current_step = std::max(current_step, global_fem_fsi_couplers_double.begin()->second->getStepCount());
            }

            auto io_start = std::chrono::steady_clock::now();
            if (global_enable_vtk.load()) {
                double last_time = global_last_vtk_time_fem_fsi_3d.load();
                if (should_write_vtk(current_step, global_t3d, last_time)) {
                    write_vtk_outputs(current_step, global_t3d);
                    update_last_vtk_time(global_last_vtk_time_fem_fsi_3d, global_t3d);
                }
            }
            auto io_end = std::chrono::steady_clock::now();
            double io_step_ms = std::chrono::duration<double, std::milli>(io_end - io_start).count();
            interval_io_ms += io_step_ms;
            global_cum_io_s = global_cum_io_s.load() + (io_step_ms * 0.001);
            interval_steps++;

            if (!global_exec_until_end_fem_fsi_3d.load()) {
                global_target_steps_fem_fsi_3d.fetch_sub(1);
            }

            auto now = std::chrono::steady_clock::now();
            auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_telemetry_time).count();
            int user_interval = (global_telemetry_interval_ms.load() > 0) ? global_telemetry_interval_ms.load() : static_cast<int>(global_refresh_rate_fem_3d.load() * 1000.0);
            int target_interval_ms = std::max(16, user_interval);
            bool should_emit = (elapsed_ms >= target_interval_ms);
            if (should_emit || (global_target_steps_fem_fsi_3d.load() == 0 && !global_exec_until_end_fem_fsi_3d.load())) {
                int steps_in_interval = std::max(1, interval_steps);
                global_last_compute_ms = interval_compute_ms / steps_in_interval;
                global_last_io_ms = interval_io_ms / steps_in_interval;
                interval_compute_ms = 0.0;
                interval_io_ms = 0.0;
                interval_steps = 0;

                auto comms_start = std::chrono::steady_clock::now();
                if (global_solver_3d) {
                    emit_telemetry_3d(global_t3d, false, current_step);
                } else if ((global_solver_mpm_3d_cuda && global_solver_mpm_3d_cuda->getParticleCount() > 0) || (global_solver_mpm_3d && !global_solver_mpm_3d->getParticles().empty())) {
                    emit_telemetry_mpm_3d(global_t3d, false, current_step);
                }
                emit_telemetry_fem_3d(global_t3d, false, current_step);
                auto comms_end = std::chrono::steady_clock::now();
                double comms_ms = std::chrono::duration<double, std::milli>(comms_end - comms_start).count();
                global_last_comms_ms = comms_ms;
                global_cum_comms_s = global_cum_comms_s.load() + (comms_ms * 0.001);
                last_telemetry_time = now;

                nlohmann::json progress_msg;
                progress_msg["type"] = "progress";
                progress_msg["sim_time"] = global_t3d;
                progress_msg["step"] = current_step;
                progress_msg["scope"] = "3d";
                if (global_exec_until_end_fem_fsi_3d.load()) {
                    if (end_time > 0.0) {
                        int percent = std::clamp((int)((global_t3d / end_time) * 100.0), 0, 99);
                        progress_msg["percent"] = percent;
                    } else {
                        progress_msg["percent"] = 50;
                    }
                    progress_msg["mode"] = "EXEC_ALL_FEM_FSI_3D";
                } else {
                    initial_steps = std::max(initial_steps, step_count + global_target_steps_fem_fsi_3d.load());
                    if (initial_steps > 0) {
                        int completed = initial_steps - global_target_steps_fem_fsi_3d.load();
                        int percent = std::clamp((int)((completed * 100) / initial_steps), 0, 99);
                        progress_msg["percent"] = percent;
                        progress_msg["completed"] = completed;
                        progress_msg["total"] = initial_steps;
                        progress_msg["mode"] = "STEP_FEM_FSI_3D";
                    }
                }
                std::lock_guard<std::mutex> lock(cout_mutex);
                std::cout << progress_msg.dump() << std::endl;
            }
        }

        double final_sim_time = global_t3d;
        int final_step = global_step_fem_fsi_3d.load();
        if (global_fem_fsi_couplers_cuda_float.count(m_id) && global_fem_fsi_couplers_cuda_float[m_id]) {
            final_step = std::max(final_step, global_fem_fsi_couplers_cuda_float[m_id]->getStepCount());
        } else if (!global_fem_fsi_couplers_cuda_float.empty()) {
            final_step = std::max(final_step, global_fem_fsi_couplers_cuda_float.begin()->second->getStepCount());
        } else if (global_fem_fsi_couplers_cuda_double.count(m_id) && global_fem_fsi_couplers_cuda_double[m_id]) {
            final_step = std::max(final_step, global_fem_fsi_couplers_cuda_double[m_id]->getStepCount());
        } else if (!global_fem_fsi_couplers_cuda_double.empty()) {
            final_step = std::max(final_step, global_fem_fsi_couplers_cuda_double.begin()->second->getStepCount());
        } else if (global_fem_fsi_couplers_float.count(m_id) && global_fem_fsi_couplers_float[m_id]) {
            final_step = std::max(final_step, global_fem_fsi_couplers_float[m_id]->getStepCount());
        } else if (!global_fem_fsi_couplers_float.empty()) {
            final_step = std::max(final_step, global_fem_fsi_couplers_float.begin()->second->getStepCount());
        } else if (global_fem_fsi_couplers_double.count(m_id) && global_fem_fsi_couplers_double[m_id]) {
            final_step = std::max(final_step, global_fem_fsi_couplers_double[m_id]->getStepCount());
        } else if (!global_fem_fsi_couplers_double.empty()) {
            final_step = std::max(final_step, global_fem_fsi_couplers_double.begin()->second->getStepCount());
        }
        double final_end_time = global_endtime_fem_fsi_3d.load();
        bool reached_end = (final_end_time > 0.0 && final_sim_time >= final_end_time - 1e-12);
        bool term_fem_fsi_3d = !reached_end && ((global_solver_3d && global_solver_3d->is_terminated()) ||
                                                (global_solver_mpm_3d_cuda && global_solver_mpm_3d_cuda->is_terminated()) ||
                                                (global_solver_mpm_3d && global_solver_mpm_3d->is_terminated()));
        if (global_enable_vtk.load() && reached_end && should_write_final_vtk(final_sim_time, global_last_vtk_time_fem_fsi_3d.load())) {
            write_vtk_outputs(final_step, final_sim_time);
            update_last_vtk_time(global_last_vtk_time_fem_fsi_3d, final_sim_time);
        }
        if (interval_steps > 0) {
            int steps_in_interval = std::max(1, interval_steps);
            global_last_compute_ms = interval_compute_ms / steps_in_interval;
            global_last_io_ms = interval_io_ms / steps_in_interval;
        }
        if (global_solver_3d) {
            emit_telemetry_3d(global_t3d, term_fem_fsi_3d, final_step);
        } else if ((global_solver_mpm_3d_cuda && global_solver_mpm_3d_cuda->getParticleCount() > 0) || (global_solver_mpm_3d && !global_solver_mpm_3d->getParticles().empty())) {
            emit_telemetry_mpm_3d(global_t3d, term_fem_fsi_3d, final_step);
        }
        emit_telemetry_fem_3d(final_sim_time, term_fem_fsi_3d, final_step);
        flush_async_telemetry();
        write_gauge_files();

        if (term_fem_fsi_3d) {
            emit_kernel_log("SYSTEM", "3D FEM-FSI simulation terminated at Terminate boundary.", final_sim_time, "3d", final_step);
        } else if (reached_end) {
            emit_kernel_log("INFO", "Reached simulation end time (" + std::to_string(final_end_time) + " s). Simulation paused.", final_sim_time, "3d", final_step);
        }


        nlohmann::json progress_msg;
        progress_msg["type"] = "progress";
        progress_msg["sim_time"] = final_sim_time;
        progress_msg["step"] = final_step;
        progress_msg["scope"] = "3d";
        progress_msg["percent"] = 100;
        progress_msg["is_terminated"] = term_fem_fsi_3d;
        progress_msg["mode"] = global_exec_until_end_fem_fsi_3d.load() ? "EXEC_ALL_FEM_FSI_3D" : "STEP_FEM_FSI_3D";
        {
            std::lock_guard<std::mutex> lock(cout_mutex);
            std::cout << progress_msg.dump() << std::endl;
        }

        sim_fem_fsi_3d_running = false;
        sim_fem_fsi_3d_paused = false;
        sim_fem_fsi_3d_terminate = false;
        global_target_steps_fem_fsi_3d = 0;
        global_exec_until_end_fem_fsi_3d = false;
    } catch (const std::exception& e) {
        emit_kernel_log("ERROR", std::string("3D FEM FSI worker thread error: ") + e.what(), 0.0, "3d");
        sim_fem_fsi_3d_running = false;
        std::exit(1);
    } catch (...) {
        emit_kernel_log("ERROR", "3D FEM FSI worker thread error: unknown exception", 0.0, "3d");
        sim_fem_fsi_3d_running = false;
        std::exit(1);
    }
}

MultiMat::MaterialSet parseMaterialSet(const nlohmann::json& msg) {
    std::string composition = msg.value("composition", "TNT");
    std::string preset = msg.value("preset", "");
    if (composition.empty() && !preset.empty()) composition = preset;

    MultiMat::MaterialSet matSet = MultiMat::TNT;

    if (composition == "PETN" || composition == "Pentaerythritol Tetranitrate") {
        matSet = MultiMat::PETN;
    } else if (composition == "RDX" || composition == "Hexogen" || composition == "Cyclonite") {
        matSet = MultiMat::RDX;
    } else if (composition == "C-4" || composition == "C4" || composition == "Composition 4" || composition == "Composition C-4") {
        matSet = MultiMat::C4;
    } else if (composition == "Comp B" || composition == "Composition B" || composition == "Comp-B") {
        matSet = MultiMat::CompB;
    } else if (composition == "HMX" || composition == "Octogen" || composition == "EDC37") {
        matSet = MultiMat::HMX;
    } else if (composition == "PBX 9501" || composition == "PBX-9501" || composition == "PBX9501") {
        matSet = MultiMat::PBX9501;
    } else if (composition == "PBX 9502" || composition == "PBX-9502" || composition == "PBX9502") {
        matSet = MultiMat::PBX9502;
    } else if (composition == "Tritonal") {
        matSet = MultiMat::Tritonal;
    } else if (composition == "ANFO") {
        matSet = MultiMat::ANFO;
    } else if (composition == "Nitromethane" || composition == "NM" || composition == "CH3NO2") {
        matSet = MultiMat::Nitromethane;
    } else if (composition == "TNT" || composition == "Trinitrotoluene") {
        matSet = MultiMat::TNT;
    }

    // Allow explicit parameter overrides in JSON message to take precedence
    double rho_val = matSet.products.rho0;
    if (msg.contains("rho")) rho_val = get_json_double(msg, "rho", rho_val);
    else if (msg.contains("density")) rho_val = get_json_double(msg, "density", rho_val);

    if (rho_val > 0.0) {
        matSet.products.rho0 = rho_val;
        matSet.unreacted.rho0 = rho_val;
    }

    if (msg.contains("jwl_A")) matSet.products.A = get_json_double(msg, "jwl_A", matSet.products.A);
    if (msg.contains("jwl_B")) matSet.products.B = get_json_double(msg, "jwl_B", matSet.products.B);
    if (msg.contains("jwl_R1")) matSet.products.R1 = get_json_double(msg, "jwl_R1", matSet.products.R1);
    if (msg.contains("jwl_R2")) matSet.products.R2 = get_json_double(msg, "jwl_R2", matSet.products.R2);
    if (msg.contains("jwl_omega")) matSet.products.omega = get_json_double(msg, "jwl_omega", matSet.products.omega);
    if (msg.contains("det_vel")) matSet.det_vel = get_json_double(msg, "det_vel", matSet.det_vel);
    if (msg.contains("detonation_energy")) matSet.detonation_energy = get_json_double(msg, "detonation_energy", matSet.detonation_energy);
    if (msg.contains("initial_temperature")) {
        double T_init = get_json_double(msg, "initial_temperature", 288.15);
        matSet.unreacted.T0 = T_init;
        matSet.products.T0 = T_init;
    }

    // Afterburn parameters override
    if (msg.contains("afterburn_enabled")) matSet.afterburn.enabled = get_json_bool(msg, "afterburn_enabled", matSet.afterburn.enabled);
    if (msg.contains("afterburn_energy")) matSet.afterburn.Q_ab = get_json_double(msg, "afterburn_energy", matSet.afterburn.Q_ab);
    if (msg.contains("afterburn_fuel_fraction")) matSet.afterburn.f_fuel = get_json_double(msg, "afterburn_fuel_fraction", matSet.afterburn.f_fuel);
    if (msg.contains("afterburn_stoich_ratio")) matSet.afterburn.s_ratio = get_json_double(msg, "afterburn_stoich_ratio", matSet.afterburn.s_ratio);
    if (msg.contains("afterburn_ignition_temp")) matSet.afterburn.T_ign = get_json_double(msg, "afterburn_ignition_temp", matSet.afterburn.T_ign);
    if (msg.contains("afterburn_tau_chem")) matSet.afterburn.tau_chem = get_json_double(msg, "afterburn_tau_chem", matSet.afterburn.tau_chem);
    if (msg.contains("afterburn_c_mix")) matSet.afterburn.C_mix = get_json_double(msg, "afterburn_c_mix", matSet.afterburn.C_mix);
    if (msg.contains("afterburn_c_edc")) matSet.afterburn.C_edc = get_json_double(msg, "afterburn_c_edc", matSet.afterburn.C_edc);
    if (msg.contains("afterburn_tau_expansion")) matSet.afterburn.tau_expansion = get_json_double(msg, "afterburn_tau_expansion", matSet.afterburn.tau_expansion);
    else if (msg.contains("tau_expansion")) matSet.afterburn.tau_expansion = get_json_double(msg, "tau_expansion", matSet.afterburn.tau_expansion);
    else if (msg.contains("t_expansion")) matSet.afterburn.tau_expansion = get_json_double(msg, "t_expansion", matSet.afterburn.tau_expansion);
    if (msg.contains("afterburn_ambient_o2_fraction")) matSet.afterburn.ambient_o2_fraction = get_json_double(msg, "afterburn_ambient_o2_fraction", matSet.afterburn.ambient_o2_fraction);
    else if (msg.contains("ambient_o2_fraction")) matSet.afterburn.ambient_o2_fraction = get_json_double(msg, "ambient_o2_fraction", matSet.afterburn.ambient_o2_fraction);
    else if (msg.contains("ambient_preset") || msg.contains("preset")) {
        std::string amb_pre = msg.value("ambient_preset", msg.value("preset", ""));
        std::string amb_lower = amb_pre;
        std::transform(amb_lower.begin(), amb_lower.end(), amb_lower.begin(), ::tolower);
        if (amb_lower.find("nitrogen") != std::string::npos || amb_lower.find("n2") != std::string::npos ||
            amb_lower.find("argon") != std::string::npos || amb_lower.find("helium") != std::string::npos ||
            amb_lower.find("noble") != std::string::npos || amb_lower.find("vacuum") != std::string::npos) {
            matSet.afterburn.ambient_o2_fraction = 0.0;
        } else if (amb_lower.find("oxygen") != std::string::npos || amb_lower.find("o2") != std::string::npos) {
            matSet.afterburn.ambient_o2_fraction = 1.0;
        } else if (amb_lower.find("air") != std::string::npos) {
            matSet.afterburn.ambient_o2_fraction = 0.233;
        }
    }
    if (msg.contains("afterburn_delay")) matSet.afterburn.induction_delay = get_json_double(msg, "afterburn_delay", matSet.afterburn.induction_delay);
    else if (msg.contains("afterburn_induction_delay")) matSet.afterburn.induction_delay = get_json_double(msg, "afterburn_induction_delay", matSet.afterburn.induction_delay);

    MultiMat::initializePrecalculatedTerms(matSet);
    return matSet;
}

static void populate_mpm_objects_from_json(const nlohmann::json& msg, bool use_gpu, const std::string& scope_tag = "mpm_3d") {
    (void)use_gpu;
    if (!msg.contains("mpm_objects") || !msg["mpm_objects"].is_array() || msg["mpm_objects"].empty()) {
        return;
    }
    align_sleeve_tait_with_fv(const_cast<nlohmann::json&>(msg));
    int domain_ppc = get_json_int(msg, "ppc", 8);
    std::string domain_p_dist_str = msg.value("particle_distribution", "Cartesian");
    std::string domain_b_fill_str = msg.value("boundary_filling", "Stairstepped");

    int obj_idx = 0;
    for (const auto& obj : msg["mpm_objects"]) {
        obj_idx++;
        std::string shape = obj.value("shape_type", obj.value("shape", "Box"));
        float pos_x = static_cast<float>(get_json_double(obj, "pos_x", 0.0));
        float pos_y = static_cast<float>(get_json_double(obj, "pos_y", 0.0));
        float pos_z = static_cast<float>(get_json_double(obj, "pos_z", 0.0));
        float vel_x = static_cast<float>(get_json_double(obj, "vel_x", 0.0));
        float vel_y = static_cast<float>(get_json_double(obj, "vel_y", 0.0));
        float vel_z = static_cast<float>(get_json_double(obj, "vel_z", 0.0));
        float ang_x = static_cast<float>(get_json_double(obj, "angular_vel_x", 0.0));
        float ang_y = static_cast<float>(get_json_double(obj, "angular_vel_y", 0.0));
        float ang_z = static_cast<float>(get_json_double(obj, "angular_vel_z", 0.0));

        float density = static_cast<float>(get_json_double(obj, "density", 7850.0));
        {
            const std::string mm_chk = obj.value("material_model", "");
            if ((mm_chk.find("JWL") != std::string::npos || mm_chk.find("CREST") != std::string::npos || mm_chk.find("LeeTarver") != std::string::npos) && density < 100.0f) {
                float fallback_rho = static_cast<float>(get_json_double(obj, "rho", 0.0));
                if (fallback_rho < 100.0f) fallback_rho = static_cast<float>(get_json_double(obj, "ideal_rho_0", 1630.0));
                if (fallback_rho < 100.0f) fallback_rho = 1630.0f;
                density = fallback_rho;
            }
        }
        float E = static_cast<float>(get_json_double(obj, "E", 210.0e9));
        float nu = static_cast<float>(get_json_double(obj, "nu", 0.3));
        float yield_stress = static_cast<float>(get_json_double(obj, "yield_stress", 400.0e6));
        float hardening = static_cast<float>(get_json_double(obj, "tangent_modulus", 1.0e9));
        float failure_strain = static_cast<float>(get_json_double(obj, "failure_strain", 0.25));
        float tensile_failure_stress = static_cast<float>(get_json_double(obj, "tensile_failure_stress", 600.0e6));

        int ppc = get_json_int(obj, "ppc", domain_ppc);
        std::string p_dist_str = obj.value("particle_distribution", domain_p_dist_str);
        Blast::MPMParticleDistribution particle_dist = Blast::MPMParticleDistribution::Cartesian;
        if (p_dist_str == "Hexagonal") {
            particle_dist = Blast::MPMParticleDistribution::Hexagonal;
        }

        std::string b_fill_str = obj.value("boundary_filling", domain_b_fill_str);
        Blast::MPMBoundaryFilling boundary_fill = Blast::MPMBoundaryFilling::Stairstepped;
        if (b_fill_str == "Partial") {
            boundary_fill = Blast::MPMBoundaryFilling::Partial;
        }

        float rot_x = static_cast<float>(get_json_double(obj, "rot_x", 0.0));
        float rot_y = static_cast<float>(get_json_double(obj, "rot_y", 0.0));
        float rot_z = static_cast<float>(get_json_double(obj, "rot_z", 0.0));
        float clip_z_min = static_cast<float>(get_json_double(obj, "clip_z_min", -1.0e30));
        float clip_z_max = static_cast<float>(get_json_double(obj, "clip_z_max", 1.0e30));

        if (shape == "Sphere") {
            float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
            float inner_radius = static_cast<float>(get_json_double(obj, "inner_radius", 0.0));
            if (global_solver_mpm_3d_cuda) {
                global_solver_mpm_3d_cuda->addSphereObject(obj_idx, pos_x, pos_y, pos_z, radius, inner_radius, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
            } else if (global_solver_mpm_3d) {
                global_solver_mpm_3d->addSphereObject(obj_idx, pos_x, pos_y, pos_z, radius, inner_radius, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
            }
        } else if (shape == "Cylinder") {
            float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
            float inner_radius = static_cast<float>(get_json_double(obj, "inner_radius", 0.0));
            float height = static_cast<float>(get_json_double(obj, "height", 0.2));
            if (global_solver_mpm_3d_cuda) {
                global_solver_mpm_3d_cuda->addCylinderObject(obj_idx, pos_x, pos_y, pos_z, radius, inner_radius, height, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
            } else if (global_solver_mpm_3d) {
                global_solver_mpm_3d->addCylinderObject(obj_idx, pos_x, pos_y, pos_z, radius, inner_radius, height, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
            }
        } else if (shape == "STL") {
            std::string stl_file = obj.contains("stl_file") ? obj["stl_file"].get<std::string>() : "";
            float scale_x = static_cast<float>(get_json_double(obj, "scale_x", 1.0));
            float scale_y = static_cast<float>(get_json_double(obj, "scale_y", 1.0));
            float scale_z = static_cast<float>(get_json_double(obj, "scale_z", 1.0));
            std::string origin_mode = obj.value("origin_mode", "Center");
            std::string voxelization_method = obj.value("voxelization_method", "watertight_raycast");
            if (global_solver_mpm_3d_cuda) {
                global_solver_mpm_3d_cuda->addSTLObject(obj_idx, stl_file, pos_x, pos_y, pos_z, scale_x, scale_y, scale_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, voxelization_method, rot_x, rot_y, rot_z, origin_mode);
            } else if (global_solver_mpm_3d) {
                global_solver_mpm_3d->addSTLObject(obj_idx, stl_file, pos_x, pos_y, pos_z, scale_x, scale_y, scale_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, voxelization_method, rot_x, rot_y, rot_z, origin_mode);
            }
        } else {
            float size_x = static_cast<float>(get_json_double(obj, "size_x", 0.2));
            float size_y = static_cast<float>(get_json_double(obj, "size_y", 0.2));
            float size_z = static_cast<float>(get_json_double(obj, "size_z", 0.2));
            if (global_solver_mpm_3d_cuda) {
                global_solver_mpm_3d_cuda->addBoxObject(obj_idx, pos_x, pos_y, pos_z, size_x, size_y, size_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
            } else if (global_solver_mpm_3d) {
                global_solver_mpm_3d->addBoxObject(obj_idx, pos_x, pos_y, pos_z, size_x, size_y, size_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
            }
        }
    }

    // Phase 2: Material tables for all MPM objects
    obj_idx = 0;
    for (const auto& obj : msg["mpm_objects"]) {
        obj_idx++;
        Blast::MaterialTable3D parsed_mat = parseMaterialTable3D(obj);
        std::string mat_model_str = obj.value("material_model", "Hypoelastic");
        if (global_solver_mpm_3d_cuda) {
            auto& mat_tables = global_solver_mpm_3d_cuda->getMaterialTables();
            if (obj_idx >= static_cast<int>(mat_tables.size())) {
                mat_tables.resize(obj_idx + 1);
            }
            mat_tables[obj_idx] = parsed_mat;
        }
        if (global_solver_mpm_3d) {
            auto& mat_tables = global_solver_mpm_3d->getMaterialTables();
            if (obj_idx >= static_cast<int>(mat_tables.size())) {
                mat_tables.resize(obj_idx + 1);
            }
            mat_tables[obj_idx] = parsed_mat;
        }
    }

    // Phase 3: Material heterogeneity
    obj_idx = 0;
    for (const auto& obj : msg["mpm_objects"]) {
        obj_idx++;
        (void)obj;
        if (global_solver_mpm_3d_cuda) global_solver_mpm_3d_cuda->initMaterialHeterogeneity(obj_idx);
        if (global_solver_mpm_3d) global_solver_mpm_3d->initMaterialHeterogeneity(obj_idx);
    }

    // Phase 4: Contact mapping (supports hybrid Bardenhagen Multi-Velocity + Single-Velocity Bonded Groups)
    std::string grouping_policy = msg.value("bardenhagen_grouping_policy", "Per-Object Independent");
    std::unordered_map<std::string, int> group_key_to_id;
    std::vector<int> obj_to_mat;
    obj_to_mat.push_back(0);
    int next_mat_id = 0;
    size_t map_obj_idx = 0;
    for (const auto& obj : msg["mpm_objects"]) {
        map_obj_idx++;
        std::string vel_group = obj.value("velocity_group", "Independent (Auto)");
        std::string m_name = obj.value("material_name", "");
        if (m_name.empty()) m_name = obj.value("material_id", "mat_" + std::to_string(map_obj_idx));

        std::string group_key;
        if (!vel_group.empty() && vel_group != "Independent (Auto)" && vel_group != "Independent") {
            group_key = "GROUP::" + vel_group;
        } else if (vel_group == "Independent" || grouping_policy == "Per-Object Independent") {
            group_key = "OBJ::" + std::to_string(map_obj_idx);
        } else {
            group_key = "MAT::" + m_name;
        }

        auto it = group_key_to_id.find(group_key);
        if (it == group_key_to_id.end()) {
            int new_id = next_mat_id++;
            group_key_to_id[group_key] = new_id;
            obj_to_mat.push_back(new_id);
        } else {
            obj_to_mat.push_back(it->second);
        }
    }
    int num_unique_materials = std::max(1, next_mat_id);
    std::string contact_method_str = msg.value("contact_method", "Single-Velocity");
    Blast::MPMContactMethod contact_method = Blast::MPMContactMethod::SingleVelocity;
    if (contact_method_str.find("Bardenhagen") != std::string::npos ||
        contact_method_str.find("Multi-Velocity") != std::string::npos ||
        contact_method_str == "MultiVelocityBardenhagen") {
        contact_method = Blast::MPMContactMethod::MultiVelocityBardenhagen;
    } else if (contact_method_str.find("DEM") != std::string::npos) {
        contact_method = Blast::MPMContactMethod::SubGridDEM;
    }
    bool enable_impact_welding = get_json_bool(msg, "enable_impact_welding", false);
    bool enable_frictional_heating = get_json_bool(msg, "enable_frictional_heating", false);
    bool enable_thermal_conduction = get_json_bool(msg, "enable_thermal_conduction", false);
    if (global_solver_mpm_3d_cuda) {
        global_solver_mpm_3d_cuda->setContactMethod(contact_method);
        global_solver_mpm_3d_cuda->setImpactWelding(enable_impact_welding);
        global_solver_mpm_3d_cuda->setFrictionalHeating(enable_frictional_heating);
        global_solver_mpm_3d_cuda->setThermalConduction(enable_thermal_conduction);
        global_solver_mpm_3d_cuda->setInitialContactTie(msg.value("bardenhagen_initial_tie", true));
        global_solver_mpm_3d_cuda->setObjectMaterialMapping(obj_to_mat, num_unique_materials);
        global_solver_mpm_3d_cuda->uploadMaterialTableToDevice();
        global_solver_mpm_3d_cuda->syncToDevice();
    } else if (global_solver_mpm_3d) {
        global_solver_mpm_3d->setContactMethod(contact_method);
        global_solver_mpm_3d->setImpactWelding(enable_impact_welding);
        global_solver_mpm_3d->setFrictionalHeating(enable_frictional_heating);
        global_solver_mpm_3d->setThermalConduction(enable_thermal_conduction);
        global_solver_mpm_3d->setInitialContactTie(msg.value("bardenhagen_initial_tie", true));
        global_solver_mpm_3d->setObjectMaterialMapping(obj_to_mat, num_unique_materials);
        global_solver_mpm_3d->particleToGrid();
    }

    size_t n_p = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getParticles().size() : (global_solver_mpm_3d ? global_solver_mpm_3d->getParticles().size() : 0);
    emit_kernel_log("SYSTEM", "Initialized " + std::to_string(n_p) + " MPM particles (" + std::to_string(obj_idx) + " objects) for coupled 3-way multi-physics.", 0.0, scope_tag, 0);
}

static int build_mpm_object_material_mapping(const nlohmann::json& msg, std::vector<int>& obj_to_mat) {
    obj_to_mat.clear();
    obj_to_mat.push_back(0); // Index 0 dummy so that obj_to_mat[obj_idx] directly matches 1-based p.object_id
    std::string grouping_policy = msg.value("bardenhagen_grouping_policy", "Per-Object Independent");
    std::unordered_map<std::string, int> group_key_to_id;
    int next_mat_id = 0;
    if (msg.contains("mpm_objects") && msg["mpm_objects"].is_array()) {
        size_t obj_idx = 0;
        for (const auto& obj : msg["mpm_objects"]) {
            obj_idx++;
            std::string vel_group = obj.value("velocity_group", "Independent (Auto)");
            std::string m_name = obj.value("material_name", "");
            if (m_name.empty()) {
                m_name = obj.value("material_id", "mat_" + std::to_string(obj_idx));
            }
            std::string group_key;
            if (!vel_group.empty() && vel_group != "Independent (Auto)" && vel_group != "Independent") {
                group_key = "GROUP::" + vel_group;
            } else if (vel_group == "Independent" || grouping_policy == "Per-Object Independent") {
                group_key = "OBJ::" + std::to_string(obj_idx);
            } else {
                group_key = "MAT::" + m_name;
            }
            auto it = group_key_to_id.find(group_key);
            if (it == group_key_to_id.end()) {
                int new_id = next_mat_id++;
                group_key_to_id[group_key] = new_id;
                obj_to_mat.push_back(new_id);
            } else {
                obj_to_mat.push_back(it->second);
            }
        }
    }
    int num_unique_materials = std::max(1, next_mat_id);
    std::cout << "[BlastSolver] Configured " << num_unique_materials << " Bardenhagen velocity field(s) for "
              << (obj_to_mat.size() > 1 ? obj_to_mat.size() - 1 : 0) << " object(s) [Policy: " << grouping_policy << "]." << std::endl;
    for (size_t oi = 1; oi < obj_to_mat.size(); ++oi) {
        std::cout << "  [BlastSolver] Object " << oi << " -> Velocity Field " << obj_to_mat[oi] << std::endl;
    }
    return num_unique_materials;
}

static Blast::MPMBoundaryCondition3D parse_bc_mpm3d(const std::string& str) {
    if (str == "Sticky" || str == "STICKY") return Blast::MPMBoundaryCondition3D::Sticky;
    if (str == "FreeSlip" || str == "Free-Slip" || str == "Slip" || str == "SLIP") return Blast::MPMBoundaryCondition3D::FreeSlip;
    if (str == "Reflecting" || str == "REFLECTING" || str == "Reflective" || str == "REFLECTIVE" || str == "Wall" || str == "WALL") return Blast::MPMBoundaryCondition3D::Reflecting;
    if (str == "Transmitting" || str == "TRANSMISSIVE" || str == "Outflow" || str == "OUTFLOW" || str == "Riemann" || str == "RIEMANN" || str == "OUTFLOW_RIEMANN" || str == "Neumann") return Blast::MPMBoundaryCondition3D::Transmitting;
    if (str == "Lysmer" || str == "LysmerDashpot" || str == "Absorbing" || str == "NonReflecting" || str == "Viscous") return Blast::MPMBoundaryCondition3D::LysmerDashpot;
    if (str == "Terminate" || str == "TERMINATE") return Blast::MPMBoundaryCondition3D::Terminate;
    return Blast::MPMBoundaryCondition3D::FreeSlip;
}

static Blast::MPMBoundaryCondition2D parse_bc_mpm2d(const std::string& str) {
    if (str == "Sticky" || str == "STICKY") return Blast::MPMBoundaryCondition2D::Sticky;
    if (str == "FreeSlip" || str == "Free-Slip" || str == "Slip" || str == "SLIP") return Blast::MPMBoundaryCondition2D::FreeSlip;
    if (str == "Reflecting" || str == "REFLECTING" || str == "Reflective" || str == "REFLECTIVE" || str == "Wall" || str == "WALL") return Blast::MPMBoundaryCondition2D::Reflecting;
    if (str == "Transmitting" || str == "TRANSMISSIVE" || str == "Outflow" || str == "OUTFLOW" || str == "Riemann" || str == "RIEMANN" || str == "OUTFLOW_RIEMANN" || str == "Neumann") return Blast::MPMBoundaryCondition2D::Transmitting;
    if (str == "Lysmer" || str == "LysmerDashpot" || str == "Absorbing" || str == "NonReflecting" || str == "Viscous") return Blast::MPMBoundaryCondition2D::LysmerDashpot;
    if (str == "Terminate" || str == "TERMINATE") return Blast::MPMBoundaryCondition2D::Terminate;
    return Blast::MPMBoundaryCondition2D::FreeSlip;
}

static void ensure_mpm_debris_solver(const nlohmann::json& msg_obj, bool use_gpu = false) {
    bool convert_mpm = get_json_bool(msg_obj, "convert_failed_elements_to_mpm", false);
    bool has_mpm_objects = (msg_obj.contains("mpm_objects") && msg_obj["mpm_objects"].is_array() && !msg_obj["mpm_objects"].empty());
    if (convert_mpm || has_mpm_objects) {
        float xmin_d = 0.0f, ymin_d = 0.0f, zmin_d = 0.0f;
        float cs = 0.02f;
        int nx = 32, ny = 32, nz = 32;

        if (global_solver_3d) {
            xmin_d = static_cast<float>(global_solver_3d->getXMin());
            ymin_d = static_cast<float>(global_solver_3d->getYMin());
            zmin_d = static_cast<float>(global_solver_3d->getZMin());
            cs = static_cast<float>(global_solver_3d->getCellSize());
            nx = global_solver_3d->getNx();
            ny = global_solver_3d->getNy();
            nz = global_solver_3d->getNz();
        } else {
            xmin_d = static_cast<float>(get_json_double(msg_obj, "xmin", -1.0));
            float xmax_d = static_cast<float>(get_json_double(msg_obj, "xmax", 1.0));
            ymin_d = static_cast<float>(get_json_double(msg_obj, "ymin", -1.0));
            float ymax_d = static_cast<float>(get_json_double(msg_obj, "ymax", 1.0));
            zmin_d = static_cast<float>(get_json_double(msg_obj, "zmin", -1.0));
            float zmax_d = static_cast<float>(get_json_double(msg_obj, "zmax", 1.0));
            cs = static_cast<float>(get_json_double(msg_obj, "cell_size", 0.02));
            if (cs <= 0.0f) cs = 0.02f;
            nx = std::max(8, static_cast<int>(std::round((xmax_d - xmin_d) / cs)));
            ny = std::max(8, static_cast<int>(std::round((ymax_d - ymin_d) / cs)));
            nz = std::max(8, static_cast<int>(std::round((zmax_d - zmin_d) / cs)));
        }

        auto mpm_bc1 = parse_bc_mpm3d(msg_obj.value("bc_x_min", "Reflecting"));
        auto mpm_bc2 = parse_bc_mpm3d(msg_obj.value("bc_x_max", "Transmitting"));
        auto mpm_bc3 = parse_bc_mpm3d(msg_obj.value("bc_y_min", "Reflecting"));
        auto mpm_bc4 = parse_bc_mpm3d(msg_obj.value("bc_y_max", "Transmitting"));
        auto mpm_bc5 = parse_bc_mpm3d(msg_obj.value("bc_z_min", "Reflecting"));
        auto mpm_bc6 = parse_bc_mpm3d(msg_obj.value("bc_z_max", "Transmitting"));

        if (!global_solver_mpm_3d) {
            global_solver_mpm_3d = std::make_unique<Blast::MPMSolver3D>();
            global_solver_mpm_3d->initializeGrid(nx, ny, nz, cs, cs, cs, xmin_d, ymin_d, zmin_d);
            global_solver_mpm_3d->setBoundaryConditions(mpm_bc1, mpm_bc2, mpm_bc3, mpm_bc4, mpm_bc5, mpm_bc6);
        } else {
            global_solver_mpm_3d->setBoundaryConditions(mpm_bc1, mpm_bc2, mpm_bc3, mpm_bc4, mpm_bc5, mpm_bc6);
        }

        if (use_gpu && !global_solver_mpm_3d_cuda) {
            global_solver_mpm_3d_cuda = std::make_unique<Blast::MPMSolver3DCUDA>();
            global_solver_mpm_3d_cuda->initializeGrid(nx, ny, nz, cs, cs, cs, xmin_d, ymin_d, zmin_d);
            global_solver_mpm_3d_cuda->setBoundaryConditions(mpm_bc1, mpm_bc2, mpm_bc3, mpm_bc4, mpm_bc5, mpm_bc6);
            emit_kernel_log("INFO", "Auto-initialized background GPU CUDA MPM solver for coupled multi-physics / debris.", 0.0, "fem_3d", 0);
        } else if (use_gpu && global_solver_mpm_3d_cuda) {
            global_solver_mpm_3d_cuda->setBoundaryConditions(mpm_bc1, mpm_bc2, mpm_bc3, mpm_bc4, mpm_bc5, mpm_bc6);
        } else if (!use_gpu) {
            emit_kernel_log("INFO", "Auto-initialized background CPU MPM solver for coupled multi-physics / debris.", 0.0, "fem_3d", 0);
        }

        if (has_mpm_objects) {
            populate_mpm_objects_from_json(msg_obj, use_gpu, "fem_3d");
        }
    }
}

int main() {
    std::string line;

    std::thread telemetry_thread(async_telemetry_thread_func);

    static std::atomic<bool> global_pulse_cancel{false};
    std::thread pulse_thread([]() {
        while (!global_pulse_cancel.load()) {
            for (int i = 0; i < 10 && !global_pulse_cancel.load(); ++i) {
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
            }
            if (!global_pulse_cancel.load()) {
                emit_resource_pulse();
            }
        }
    });

    std::thread stdin_listener_thread([]() {
        std::string line;
        while (std::getline(std::cin, line)) {
            if (line.empty()) continue;

            try {
                nlohmann::json msg = nlohmann::json::parse(line);
                std::string command = msg.value("command", "");
                if (command.rfind("INIT", 0) == 0 || command.rfind("REMAP", 0) == 0 || command.rfind("TERMINATE", 0) == 0) {
                    global_last_valid_nvml_vram = 0;
                }
                if (msg.contains("modelId")) {
                    global_model_id = msg.value("modelId", "");
                }
                if (msg.contains("model_filename") && !msg["model_filename"].is_null()) {
                    global_model_filename = msg.value("model_filename", "");
                }

                if (command.rfind("INIT", 0) == 0) {
                    reset_timing_metrics();
                    // Reproducibility aid: persist the exact INIT payload so the model can be replayed
                    // headlessly (stdin -> BlastSolver) for numerical-stability regression testing.
                    if (!std::getenv("BLAST_NO_CAPTURE")) {
                        std::ofstream capture("blast_last_" + command + ".json", std::ios::trunc);
                        if (capture.is_open()) {
                            capture << line << "\n";
                        }
                    }
                }

                if (command == "INIT") {
                    sim_terminate = true;
                    while (sim_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    sim_terminate = false;
                    sim_paused = false;
                    step_progress = 0;
                    global_step_1d = 0;
                    global_wallclock_1d = 0.0;

                    if (!msg.contains("n_cells") || !msg.contains("domain_radius") || !msg.contains("gamma")) {
                        std::cerr << "[BlastSolver] [ERROR] Invalid 1D INIT payload: missing n_cells, domain_radius, or gamma." << std::endl;
                        emit_kernel_log("ERROR", "1D CFD initialization failed: missing mesh/domain parameters (n_cells, domain_radius, gamma)", 0.0, "1d");
                        continue;
                    }
                    int n_cells = msg["n_cells"].get<int>();
                    double radius = msg["domain_radius"].get<double>();
                    double gamma = msg["gamma"].get<double>();

                    global_num_cells = n_cells;
                    global_t = 0.0;
                    global_endtime = msg.value("endtime", 1.0);

                    std::string init_mode   = msg.value("init_mode",   "Multi-Material JWL");
                    std::string composition  = msg.value("composition", "TNT");
                    std::string explosive_type = msg.value("explosive_type", "");

                    std::string precision = msg.value("precision", "double");
                    if (precision == "single" || precision == "float") {
                        if (init_mode == "Ideal Gas" || explosive_type == "MaterialIdealGas") {
                            global_solver = std::make_unique<CFDSolverImpl<float, false>>(n_cells, radius, gamma);
                        } else {
                            global_solver = std::make_unique<CFDSolverImpl<float, true>>(n_cells, radius, gamma);
                        }
                    } else {
                        if (init_mode == "Ideal Gas" || explosive_type == "MaterialIdealGas") {
                            global_solver = std::make_unique<CFDSolverImpl<double, false>>(n_cells, radius, gamma);
                        } else {
                            global_solver = std::make_unique<CFDSolverImpl<double, true>>(n_cells, radius, gamma);
                        }
                    }

                    // Set boundary conditions
                    std::string left_bc_str = msg.value("left_bc", "Transmitting");
                    std::string right_bc_str = msg.value("right_bc", "Transmitting");
                    auto map_bc_1d = [](const std::string& str) {
                        if (str == "Transmitting" || str == "transmitting" || str == "TRANSMISSIVE" || str == "transmissive" || str == "Terminate" || str == "terminate") {
                            return CFDSolver::TRANSMISSIVE;
                        } else {
                            return CFDSolver::REFLECTIVE;
                        }
                    };
                    global_solver->setBCTypes(map_bc_1d(left_bc_str), map_bc_1d(right_bc_str));

                    int s_order = 2;
                    int t_order = 4;
                    parse_cfd_space_time_scheme(msg, s_order, t_order, 4);

                    global_solver->setFluxScheme(msg.value("flux_scheme", "AUSM+"));
                    global_solver->setSpatialOrder(s_order);
                    global_solver->setTemporalOrder(t_order);

                    // 1D Nodegraph validation check
                    std::vector<std::string> missing_elements;
                    if (!msg.contains("nodes") || !msg.contains("connections")) {
                        missing_elements.push_back("Missing DAG nodes/connections");
                    } else {
                        bool has_solver = false;
                        std::string solver_id = "";
                        for (const auto& node : msg["nodes"]) {
                            if (node.value("type", "") == "CFDSolver") {
                                has_solver = true;
                                solver_id = node.value("id", "");
                                break;
                            }
                        }
                        if (!has_solver) {
                            missing_elements.push_back("CFDSolver node");
                        } else {
                            // Check direct connections to CFDSolver or legacy connections via ThePainter
                            std::string painter_id = "";
                            for (const auto& conn : msg["connections"]) {
                                if (conn.value("toNode", "") == solver_id && conn.value("toPort", "") == "in") {
                                    painter_id = conn.value("fromNode", "");
                                    break;
                                }
                            }

                            bool has_mesh = false;
                            bool has_air = false;
                            bool has_explosive = false;
                            std::string charge_id = "";

                            // 1. Check direct connections to CFDSolver
                            for (const auto& conn : msg["connections"]) {
                                if (conn.value("toNode", "") == solver_id) {
                                    std::string port = conn.value("toPort", "");
                                    std::string from = conn.value("fromNode", "");
                                    if (port == "mesh") {
                                        for (const auto& n : msg["nodes"]) {
                                            if (n.value("id", "") == from && n.value("type", "") == "DomainMesh") {
                                                has_mesh = true;
                                            }
                                        }
                                    } else if (port == "air") {
                                        for (const auto& n : msg["nodes"]) {
                                            if (n.value("id", "") == from && n.value("type", "") == "Material") {
                                                auto params = n.value("parameters", nlohmann::json::object());
                                                std::string mat_type = params.value("material_type", "");
                                                std::string mat_model = params.value("material_model", "");
                                                if (mat_type == "Air" || (mat_model == "Ideal Gas" && mat_type != "Ideal Gas Charge")) {
                                                    has_air = true;
                                                }
                                            }
                                        }
                                    } else if (port == "charge" || port == "explosive") {
                                        for (const auto& n : msg["nodes"]) {
                                            if (n.value("id", "") == from && n.value("type", "") == "Charge1D") {
                                                has_explosive = true;
                                                charge_id = from;
                                            }
                                        }
                                    }
                                }
                            }

                            // 2. Fallback: check legacy connections via ThePainter
                            if ((!has_mesh || !has_air || !has_explosive) && !painter_id.empty()) {
                                for (const auto& conn : msg["connections"]) {
                                    if (conn.value("toNode", "") == painter_id) {
                                        std::string port = conn.value("toPort", "");
                                        std::string from = conn.value("fromNode", "");
                                        if (port == "mesh") {
                                            for (const auto& n : msg["nodes"]) {
                                                if (n.value("id", "") == from && n.value("type", "") == "DomainMesh") {
                                                    has_mesh = true;
                                                }
                                            }
                                        } else if (port == "air") {
                                            for (const auto& n : msg["nodes"]) {
                                                if (n.value("id", "") == from && n.value("type", "") == "Material") {
                                                    auto params = n.value("parameters", nlohmann::json::object());
                                                    std::string mat_type = params.value("material_type", "");
                                                    std::string mat_model = params.value("material_model", "");
                                                    if (mat_type == "Air" || (mat_model == "Ideal Gas" && mat_type != "Ideal Gas Charge")) {
                                                        has_air = true;
                                                    }
                                                }
                                            }
                                        } else if (port == "explosive") {
                                            for (const auto& n : msg["nodes"]) {
                                                if (n.value("id", "") == from && n.value("type", "") == "Charge1D") {
                                                    has_explosive = true;
                                                    charge_id = from;
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            if (!has_mesh) missing_elements.push_back("DomainMesh connected to CFDSolver");
                            if (!has_air) missing_elements.push_back("Material (Air) connected to CFDSolver");
                            if (!has_explosive) {
                                missing_elements.push_back("Charge1D connected to CFDSolver");
                            } else if (!charge_id.empty()) {
                                bool has_charge_material = false;
                                for (const auto& conn : msg["connections"]) {
                                    if (conn.value("toNode", "") == charge_id && conn.value("toPort", "") == "material") {
                                        std::string from = conn.value("fromNode", "");
                                        for (const auto& n : msg["nodes"]) {
                                            if (n.value("id", "") == from && n.value("type", "") == "Material") {
                                                has_charge_material = true;
                                            }
                                        }
                                    }
                                }
                                if (!has_charge_material) missing_elements.push_back("Material connected to Charge1D");
                            }
                        }
                    }
                    if (!missing_elements.empty()) {
                        std::string warn_msg = "Incomplete 1D nodegraph. Missing elements: ";
                        for (size_t i = 0; i < missing_elements.size(); ++i) {
                            warn_msg += missing_elements[i] + (i == missing_elements.size() - 1 ? "" : ", ");
                        }
                        emit_kernel_log("WARNING", warn_msg, global_t, "1d");
                    }

                    double explosive_radius = msg.value("explosive_radius", msg.value("charge_radius", 0.05));
                    double high_rho         = msg.value("rho", 1630.0);
                    double ambient_rho      = msg.value("ambient_rho", 1.225);
                    double ambient_p        = msg.value("atm_pressure", 101325.0);

                    MultiMat::MaterialSet matSet = parseMaterialSet(msg);
                    global_solver->setMaterialParameters(matSet);

                    if (init_mode == "Ideal Gas" || explosive_type == "MaterialIdealGas") {
                        double det_energy = msg.value("detonation_energy", 4520000.0);
                        global_solver->setInitialConditionIdealGas(explosive_radius, high_rho, det_energy, ambient_rho, ambient_p);
                    } else {
                        global_solver->setInitialConditionTNT(explosive_radius, high_rho, ambient_rho, ambient_p);
                    }

                    init_gauges(msg);
                    record_gauges_1d(global_t);

                    emit_telemetry(*global_solver, global_t, false);
                    emit_kernel_log("SYSTEM", "Solver ready. Zero-Omission binding complete.", global_t, "1d");

                } else if (command == "STEP") {
                    if (!global_solver) continue;
                    int steps = msg.value("steps", 1);
                    global_cfl = msg.value("cfl", 0.6);
                    if (msg.contains("endtime")) global_endtime = msg.value("endtime", 1.0);
                    global_exec_until_end = false;
                    if (!sim_running) {
                        global_target_steps = steps;
                        sim_running = true;
                        sim_paused = false;
                        sim_terminate = false;
                        std::thread(worker_thread_func).detach();
                    } else {
                        global_target_steps.fetch_add(steps);
                        sim_paused = false;
                    }
                } else if (command == "EXEC_ALL" || command == "EXEC_END") {
                    if (!global_solver) continue;
                    global_cfl = msg.value("cfl", 0.6);
                    if (msg.contains("endtime")) global_endtime = msg.value("endtime", 1.0);
                    global_exec_until_end = true;
                    if (!sim_running) {
                        sim_running = true;
                        sim_paused = false;
                        sim_terminate = false;
                        std::thread(worker_thread_func).detach();
                    } else { sim_paused = false; }
                } else if (command == "PAUSE") {
                    sim_paused = true;
                    global_target_steps = 0;
                } else if (command == "RESUME") {
                    sim_paused = false;
                } else if (command == "TERMINATE") {
                    sim_terminate = true;
                    while (sim_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver.reset();
                    global_num_cells = 0;
                    global_t = 0.0;
                    global_wallclock_1d = 0.0;
                    step_progress = 0;
                } else if (command == "INIT_2D") {
                    sim2d_terminate = true;
                    while (sim2d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_2d.reset();
                    global_solver_2d_cuda.reset();
                    sim2d_terminate = false;
                    sim2d_paused = false;
                    step_progress_2d = 0;
                    global_step_2d = 0;
                    global_wallclock_2d = 0.0;
                    global_endtime_2d = msg.value("endtime", 1.0);

                    // 2D Nodegraph validation check
                    std::vector<std::string> missing_elements_2d;
                    std::string init_mode_2d = msg.value("init_mode", "From1D");
                    if (!msg.contains("nodes") || !msg.contains("connections")) {
                        missing_elements_2d.push_back("Missing DAG nodes/connections");
                    } else {
                        bool has_solver2d = false;
                        std::string solver2d_id = "";
                        for (const auto& node : msg["nodes"]) {
                            if (node.value("type", "") == "CFDSolver2D") {
                                has_solver2d = true;
                                solver2d_id = node.value("id", "");
                                break;
                            }
                        }
                        if (!has_solver2d) {
                            missing_elements_2d.push_back("CFDSolver2D node");
                        } else {
                            bool has_mesh2d = false;
                            bool has_air2d = false;
                            bool has_charge = false;
                            bool has_detonator = false;
                            bool has_remap = false;
                            std::string charge2d_id = "";
                            std::string remap_id = "";

                            for (const auto& conn : msg["connections"]) {
                                if (conn.value("toNode", "") == solver2d_id) {
                                    std::string port = conn.value("toPort", "");
                                    std::string from = conn.value("fromNode", "");
                                    if (port == "mesh") {
                                        for (const auto& n : msg["nodes"]) {
                                            if (n.value("id", "") == from && n.value("type", "") == "DomainMesh2D") {
                                                has_mesh2d = true;
                                            }
                                        }
                                    } else if (port == "air") {
                                        for (const auto& n : msg["nodes"]) {
                                            if (n.value("id", "") == from && n.value("type", "") == "Material") {
                                                auto params = n.value("parameters", nlohmann::json::object());
                                                std::string mat_type = params.value("material_type", "");
                                                std::string mat_model = params.value("material_model", "");
                                                if (mat_type == "Air" || (mat_model == "Ideal Gas" && mat_type != "Ideal Gas Charge")) {
                                                    has_air2d = true;
                                                }
                                            }
                                        }
                                    } else if (port == "charge" || port == "explosive") {
                                        for (const auto& n : msg["nodes"]) {
                                            if (n.value("id", "") == from && (n.value("type", "") == "Charge2D" || n.value("type", "") == "Charge1D")) {
                                                has_charge = true;
                                                charge2d_id = from;
                                            }
                                        }
                                    } else if (port == "detonator" || port == "trigger") {
                                        for (const auto& n : msg["nodes"]) {
                                            if (n.value("id", "") == from && (n.value("type", "") == "DetonatorLocation" || n.value("type", "") == "TriggerLocation")) {
                                                has_detonator = true;
                                            }
                                        }
                                    } else if (port == "remap") {
                                        for (const auto& n : msg["nodes"]) {
                                            std::string ntype = n.value("type", "");
                                            if (n.value("id", "") == from && (ntype == "RemapNode" || ntype == "Remap1DTo2DNode")) {
                                                has_remap = true;
                                                remap_id = from;
                                            }
                                        }
                                    }
                                }
                            }

                            if (!has_mesh2d) {
                                missing_elements_2d.push_back("DomainMesh2D connected to CFD Solver 2D");
                            }

                            if (init_mode_2d == "From1D") {
                                if (!has_remap) {
                                    missing_elements_2d.push_back("Remap1DTo2DNode connected to CFD Solver 2D");
                                } else {
                                    // Check if RemapNode has connection from CFDSolver (1D) or a cross-model source_model_id
                                    bool remap_has_1d_solver = false;
                                    for (const auto& n : msg["nodes"]) {
                                        if (n.value("id", "") == remap_id && n.contains("parameters") && n["parameters"].is_object()) {
                                            std::string src_mid = n["parameters"].value("source_model_id", "");
                                            if (!src_mid.empty()) remap_has_1d_solver = true;
                                        }
                                    }
                                    for (const auto& conn : msg["connections"]) {
                                        if (conn.value("toNode", "") == remap_id && conn.value("toPort", "") == "in") {
                                            std::string from = conn.value("fromNode", "");
                                            for (const auto& n : msg["nodes"]) {
                                                if (n.value("id", "") == from && n.value("type", "") == "CFDSolver") {
                                                    remap_has_1d_solver = true;
                                                }
                                            }
                                        }
                                    }
                                    if (!remap_has_1d_solver) {
                                        missing_elements_2d.push_back("CFDSolver (1D) or source_model_id configured on Remap1DTo2DNode");
                                    }
                                }
                            } else {
                                if (!has_air2d) {
                                    missing_elements_2d.push_back("Material (Air) connected to CFD Solver 2D");
                                }
                                if (!has_charge) {
                                    missing_elements_2d.push_back("Charge node connected to CFD Solver 2D");
                                } else if (!charge2d_id.empty()) {
                                    bool has_charge_material = false;
                                    for (const auto& conn : msg["connections"]) {
                                        if (conn.value("toNode", "") == charge2d_id && conn.value("toPort", "") == "material") {
                                            std::string from = conn.value("fromNode", "");
                                            for (const auto& n : msg["nodes"]) {
                                                if (n.value("id", "") == from && n.value("type", "") == "Material") {
                                                    has_charge_material = true;
                                                }
                                            }
                                        }
                                    }
                                    if (!has_charge_material) {
                                        missing_elements_2d.push_back("Material connected to Charge node");
                                    }
                                }
                                if (!has_detonator) {
                                    missing_elements_2d.push_back("DetonatorLocation connected to CFD Solver 2D");
                                }
                            }
                        }
                    }
                    if (!missing_elements_2d.empty()) {
                        std::string warn_msg = "Incomplete 2D nodegraph. Missing elements: ";
                        for (size_t i = 0; i < missing_elements_2d.size(); ++i) {
                            warn_msg += missing_elements_2d[i] + (i == missing_elements_2d.size() - 1 ? "" : ", ");
                        }
                        emit_kernel_log("WARNING", warn_msg, global_t2d, "2d");
                    }
                    
                    int nr = msg.value("nr", 100);
                    int nz = msg.value("nz", 100);
                    double max_r = msg.value("max_r", 1.0);
                    double max_z = msg.value("max_z", 1.0);
                    std::string device = msg.value("device", "cpu");
                    double gamma = msg.value("gamma", 1.4);
                    double cfl = msg.value("cfl", 0.6);
                    global_cfl_2d = cfl;
                    
                    std::string flux_scheme = msg.value("flux_scheme", "AUSM+");
                    int spatial_order = 2;
                    int temporal_order = 2;
                    parse_cfd_space_time_scheme(msg, spatial_order, temporal_order, 2);
                    std::string composition = msg.value("composition", "TNT");
                    std::string coord_sys = msg.value("coordinate_system", "Axisymmetric");

                    std::string bc_r_min_str = msg.value("bc_r_min", "Reflecting");
                    std::string bc_r_max_str = msg.value("bc_r_max", "Terminate");
                    std::string bc_z_min_str = msg.value("bc_z_min", "Reflecting");
                    std::string bc_z_max_str = msg.value("bc_z_max", "Terminate");

                    auto map_bc_2d = [](const std::string& str) {
                        if (str == "Transmitting" || str == "transmitting" || str == "TRANSMISSIVE" || str == "transmissive") {
                            return CFDSolver2D::TRANSMISSIVE;
                        } else if (str == "Riemann" || str == "riemann" || str == "Terminate" || str == "terminate" || str == "OUTFLOW_RIEMANN" || str == "outflow_riemann") {
                            return CFDSolver2D::OUTFLOW_RIEMANN;
                        } else {
                            return CFDSolver2D::REFLECTIVE;
                        }
                    };

                    CFDSolver2D::BCType r_min_bc = map_bc_2d(bc_r_min_str);
                    CFDSolver2D::BCType r_max_bc = map_bc_2d(bc_r_max_str);
                    CFDSolver2D::BCType z_min_bc = map_bc_2d(bc_z_min_str);
                    CFDSolver2D::BCType z_max_bc = map_bc_2d(bc_z_max_str);

                    if (coord_sys == "Axisymmetric") {
                        if (r_min_bc != CFDSolver2D::REFLECTIVE) {
                            std::cout << "[INFO] Forcing R-Min boundary to Reflecting (Axisymmetric centerline)." << std::endl;
                            r_min_bc = CFDSolver2D::REFLECTIVE;
                        }
                    }

                    MultiMat::MaterialSet matSet = parseMaterialSet(msg);

                    global_t2d = 0.0;
                    global_dt_2d = 0.0;
                    global_solver_mpm_2d.reset();

                    std::string mesh_type = msg.value("mesh_type", "regular");
                    global_is_amr_2d = (mesh_type == "amr");
                    int amr_max_levels = get_json_int(msg, "amr_max_levels", 3);
                    double amr_threshold = get_json_double(msg, "amr_threshold", 0.05);
                    double amr_coarsen_ratio = get_json_double(msg, "amr_coarsen_ratio", 0.4);

                    amr_max_levels = std::clamp(amr_max_levels, 1, 6);
                    if (amr_threshold <= 0.0 || std::isnan(amr_threshold)) amr_threshold = 0.05;
                    if (amr_coarsen_ratio <= 0.0 || std::isnan(amr_coarsen_ratio)) amr_coarsen_ratio = 0.4;
                    amr_coarsen_ratio = std::clamp(amr_coarsen_ratio, 0.1, 0.9);

                    std::string precision = msg.value("precision", "double");
                    select_cuda_device(device);
                    if (is_cuda_device(device)) {
                        {
                            std::lock_guard<std::mutex> lock(cout_mutex);
                            global_solver_2d.reset();
                            global_solver_2d_cuda.reset();
                            if (precision == "single" || precision == "float") {
                                if (mesh_type == "amr") {
                                    global_solver_2d_cuda = std::make_unique<CFDSolver2DAMRCudaImpl<float>>(nr, nz, max_r, max_z, gamma, amr_max_levels, amr_threshold, amr_coarsen_ratio);
                                } else {
                                    global_solver_2d_cuda = std::make_unique<CFDSolver2DCudaImpl<float>>(nr, nz, max_r, max_z, gamma);
                                }
                            } else {
                                if (mesh_type == "amr") {
                                    global_solver_2d_cuda = std::make_unique<CFDSolver2DAMRCudaImpl<double>>(nr, nz, max_r, max_z, gamma, amr_max_levels, amr_threshold, amr_coarsen_ratio);
                                } else {
                                    global_solver_2d_cuda = std::make_unique<CFDSolver2DCudaImpl<double>>(nr, nz, max_r, max_z, gamma);
                                }
                            }
                        }
                        
                        global_solver_2d_cuda->setFluxScheme(flux_scheme);
                        global_solver_2d_cuda->setSpatialOrder(spatial_order);
                        global_solver_2d_cuda->setTemporalOrder(temporal_order);
                        global_solver_2d_cuda->setBCTypes(
                            static_cast<CFDSolver2DCuda::BCType>(r_min_bc),
                            static_cast<CFDSolver2DCuda::BCType>(r_max_bc),
                            static_cast<CFDSolver2DCuda::BCType>(z_min_bc),
                            static_cast<CFDSolver2DCuda::BCType>(z_max_bc)
                        );
                        global_solver_2d_cuda->setMaterialParameters(matSet);
                        global_solver_2d_cuda->setCoordinateSystemCartesian(coord_sys == "Cartesian");

                        std::string init_mode = msg.value("init_mode", "Ideal Gas");
                        if (init_mode == "From1D") {
                            std::lock_guard<std::mutex> rlock(g_pending_remap_mutex);
                            if (g_pending_remap.has_pending && g_pending_remap.type == "1D") {
                                apply_remap_payload(g_pending_remap.msg, "1D", nullptr, nullptr, global_solver_2d_cuda.get());
                                g_pending_remap.has_pending = false;
                            }
                        } else if (init_mode == "Ideal Gas" || msg.value("explosive_type", "") == "MaterialIdealGas") {
                            double det_energy = msg.value("detonation_energy", 4520000.0);
                            double high_rho = msg.value("high_rho", msg.value("rho", 1630.0));
                            double ambient_rho = msg.value("ambient_rho", 1.225648589);
                            double ambient_p = msg.value("atm_pressure", msg.value("ambient_p", 101325.0));
                            double explosive_r = msg.value("charge_r", msg.value("explosive_r", 0.0));
                            double explosive_z = msg.value("charge_z", msg.value("explosive_z", 0.0));
                            double explosive_radius = msg.value("charge_radius", msg.value("explosive_radius", 0.1));
                            
                            double detonator_r = get_json_double(msg, "trigger_r", get_json_double(msg, "detonator_r", explosive_r));
                            double detonator_z = get_json_double(msg, "trigger_z", get_json_double(msg, "detonator_z", explosive_z));
                            double detonator_delay = get_json_double(msg, "time_delay", get_json_double(msg, "start_time", get_json_double(msg, "detonator_time", 0.0)));
                            global_solver_2d_cuda->setDetonatorLocation(detonator_r, detonator_z, detonator_delay);
                            global_solver_2d_cuda->setInitialConditionIdealGas(explosive_z, explosive_radius, high_rho, det_energy, ambient_rho, ambient_p, explosive_r);
                        } else if (init_mode == "Multi-Material JWL" || init_mode == "JWL") {
                            double high_rho = msg.value("high_rho", msg.value("rho", 1630.0));
                            double ambient_rho = msg.value("ambient_rho", 1.225648589);
                            double ambient_p = msg.value("atm_pressure", msg.value("ambient_p", 101325.0));
                            double explosive_r = msg.value("charge_r", msg.value("explosive_r", 0.0));
                            double explosive_z = msg.value("charge_z", msg.value("explosive_z", 0.0));
                            double explosive_radius = msg.value("charge_radius", msg.value("explosive_radius", 0.1));
                            
                            std::string charge_shape = msg.value("charge_shape", "Sphere");
                            if (charge_shape == "Cylinder" || charge_shape == "cylinder") {
                                double charge_radius = msg.value("charge_radius", 0.1);
                                double charge_height = msg.value("charge_height", 0.2);
                                if (msg.contains("charge_aspect_ratio") && !msg.contains("charge_height")) {
                                    double ar = msg.value("charge_aspect_ratio", 1.0);
                                    if (ar > 0.0) charge_height = 2.0 * charge_radius * ar;
                                }
                                double detonator_r = get_json_double(msg, "trigger_r", get_json_double(msg, "detonator_r", explosive_r));
                                double detonator_z = get_json_double(msg, "trigger_z", get_json_double(msg, "detonator_z", explosive_z + charge_height / 2.0));
                                double detonator_delay = get_json_double(msg, "time_delay", get_json_double(msg, "start_time", get_json_double(msg, "detonator_time", 0.0)));
                                global_solver_2d_cuda->setDetonatorLocation(detonator_r, detonator_z, detonator_delay);
                                global_solver_2d_cuda->setInitialConditionTNTCylinder(explosive_z, charge_radius, charge_height, high_rho, ambient_rho, ambient_p, explosive_r);
                            } else {
                                double detonator_r = get_json_double(msg, "trigger_r", get_json_double(msg, "detonator_r", explosive_r));
                                double detonator_z = get_json_double(msg, "trigger_z", get_json_double(msg, "detonator_z", explosive_z));
                                double detonator_delay = get_json_double(msg, "time_delay", get_json_double(msg, "start_time", get_json_double(msg, "detonator_time", 0.0)));
                                global_solver_2d_cuda->setDetonatorLocation(detonator_r, detonator_z, detonator_delay);
                                global_solver_2d_cuda->setInitialConditionTNT(explosive_z, explosive_radius, high_rho, ambient_rho, ambient_p, explosive_r);
                            }
                        }
                    } else {
                        {
                            std::lock_guard<std::mutex> lock(cout_mutex);
                            global_solver_2d_cuda.reset();
                        }
                        if (precision == "single" || precision == "float") {
                            if (mesh_type == "amr") {
                                global_solver_2d = std::make_unique<CFDSolver2DAMRImpl<float>>(nr, nz, max_r, max_z, gamma, amr_max_levels, amr_threshold, amr_coarsen_ratio);
                            } else {
                                global_solver_2d = std::make_unique<CFDSolver2DImpl<float>>(nr, nz, max_r, max_z, gamma);
                            }
                        } else {
                            if (mesh_type == "amr") {
                                global_solver_2d = std::make_unique<CFDSolver2DAMRImpl<double>>(nr, nz, max_r, max_z, gamma, amr_max_levels, amr_threshold, amr_coarsen_ratio);
                            } else {
                                global_solver_2d = std::make_unique<CFDSolver2DImpl<double>>(nr, nz, max_r, max_z, gamma);
                            }
                        }
                        
                        global_solver_2d->setFluxScheme(flux_scheme);
                        global_solver_2d->setSpatialOrder(spatial_order);
                        global_solver_2d->setTemporalOrder(temporal_order);
                        global_solver_2d->setBCTypes(r_min_bc, r_max_bc, z_min_bc, z_max_bc);
                        global_solver_2d->setMaterialParameters(matSet);
                        global_solver_2d->setCoordinateSystemCartesian(coord_sys == "Cartesian");
 
                        std::string init_mode = msg.value("init_mode", "Ideal Gas");
                        if (init_mode == "From1D") {
                            std::lock_guard<std::mutex> rlock(g_pending_remap_mutex);
                            if (g_pending_remap.has_pending && g_pending_remap.type == "1D") {
                                apply_remap_payload(g_pending_remap.msg, "1D", nullptr, global_solver_2d.get(), nullptr);
                                g_pending_remap.has_pending = false;
                            }
                        } else if (init_mode == "Ideal Gas" || msg.value("explosive_type", "") == "MaterialIdealGas") {
                            double det_energy = msg.value("detonation_energy", 4520000.0);
                            double high_rho = msg.value("high_rho", msg.value("rho", 1630.0));
                            double ambient_rho = msg.value("ambient_rho", 1.225648589);
                            double ambient_p = msg.value("atm_pressure", msg.value("ambient_p", 101325.0));
                            double explosive_r = msg.value("charge_r", msg.value("explosive_r", 0.0));
                            double explosive_z = msg.value("charge_z", msg.value("explosive_z", 0.0));
                            double explosive_radius = msg.value("charge_radius", msg.value("explosive_radius", 0.1));
                            
                            double detonator_r = get_json_double(msg, "trigger_r", get_json_double(msg, "detonator_r", explosive_r));
                            double detonator_z = get_json_double(msg, "trigger_z", get_json_double(msg, "detonator_z", explosive_z));
                            double detonator_delay = get_json_double(msg, "time_delay", get_json_double(msg, "start_time", get_json_double(msg, "detonator_time", 0.0)));
                            global_solver_2d->setDetonatorLocation(detonator_r, detonator_z, detonator_delay);
                            global_solver_2d->setInitialConditionIdealGas(explosive_z, explosive_radius, high_rho, det_energy, ambient_rho, ambient_p, explosive_r);
                        } else if (init_mode == "Multi-Material JWL" || init_mode == "JWL") {
                            double high_rho = msg.value("high_rho", msg.value("rho", 1630.0));
                            double ambient_rho = msg.value("ambient_rho", 1.225648589);
                            double ambient_p = msg.value("atm_pressure", msg.value("ambient_p", 101325.0));
                            double explosive_r = msg.value("charge_r", msg.value("explosive_r", 0.0));
                            double explosive_z = msg.value("charge_z", msg.value("explosive_z", 0.0));
                            double explosive_radius = msg.value("charge_radius", msg.value("explosive_radius", 0.1));
                            
                            std::string charge_shape = msg.value("charge_shape", "Sphere");
                            if (charge_shape == "Cylinder" || charge_shape == "cylinder") {
                                double charge_radius = msg.value("charge_radius", 0.1);
                                double charge_height = msg.value("charge_height", 0.2);
                                if (msg.contains("charge_aspect_ratio") && !msg.contains("charge_height")) {
                                    double ar = msg.value("charge_aspect_ratio", 1.0);
                                    if (ar > 0.0) charge_height = 2.0 * charge_radius * ar;
                                }
                                double detonator_r = get_json_double(msg, "trigger_r", get_json_double(msg, "detonator_r", explosive_r));
                                double detonator_z = get_json_double(msg, "trigger_z", get_json_double(msg, "detonator_z", explosive_z + charge_height / 2.0));
                                double detonator_delay = get_json_double(msg, "time_delay", get_json_double(msg, "start_time", get_json_double(msg, "detonator_time", 0.0)));
                                global_solver_2d->setDetonatorLocation(detonator_r, detonator_z, detonator_delay);
                                global_solver_2d->setInitialConditionTNTCylinder(explosive_z, charge_radius, charge_height, high_rho, ambient_rho, ambient_p, explosive_r);
                            } else {
                                double detonator_r = get_json_double(msg, "trigger_r", get_json_double(msg, "detonator_r", explosive_r));
                                double detonator_z = get_json_double(msg, "trigger_z", get_json_double(msg, "detonator_z", explosive_z));
                                double detonator_delay = get_json_double(msg, "time_delay", get_json_double(msg, "start_time", get_json_double(msg, "detonator_time", 0.0)));
                                global_solver_2d->setDetonatorLocation(detonator_r, detonator_z, detonator_delay);
                                global_solver_2d->setInitialConditionTNT(explosive_z, explosive_radius, high_rho, ambient_rho, ambient_p, explosive_r);
                            }
                        }
                    }
                    
                    apply_obstacles_2d(msg, nr, nz, max_r, max_z);
                    solver2d_initialized = true;
                    init_gauges(msg);
                    record_gauges_2d(global_t2d);
                    emit_kernel_log("SYSTEM", "2D Solver Initialized", global_t2d, "2d");
                    emit_telemetry_2d(global_t2d, false);
                } else if (command == "STEP_2D") {
                    if (!has_solver_2d()) continue;
                    init_gauges(msg);
                    int steps = msg.value("steps", 1);
                    global_cfl_2d = msg.value("cfl", 0.6);
                    if (msg.contains("endtime")) global_endtime_2d = msg.value("endtime", 1.0);
                    global_exec_until_end_2d = false;
                    if (!sim2d_running) {
                        global_target_steps_2d = steps;
                        sim2d_running = true;
                        sim2d_paused = false;
                        sim2d_terminate = false;
                        std::thread(worker_2d_thread_func).detach();
                    } else {
                        global_target_steps_2d.fetch_add(steps);
                        sim2d_paused = false;
                    }
                } else if (command == "EXEC_ALL_2D") {
                    if (!has_solver_2d()) continue;
                    init_gauges(msg);
                    global_cfl_2d = msg.value("cfl", 0.6);
                    if (msg.contains("endtime")) global_endtime_2d = msg.value("endtime", 1.0);
                    global_exec_until_end_2d = true;
                    if (!sim2d_running) {
                        sim2d_running = true;
                        sim2d_paused = false;
                        sim2d_terminate = false;
                        std::thread(worker_2d_thread_func).detach();
                    } else { sim2d_paused = false; }
                } else if (command == "PAUSE_2D") {
                    sim2d_paused = true;
                    global_target_steps_2d = 0;
                } else if (command == "RESUME_2D") {
                    sim2d_paused = false;
                } else if (command == "TERMINATE_2D") {
                    sim2d_terminate = true;
                    while (sim2d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_2d.reset();
                    {
                        std::lock_guard<std::mutex> lock(cout_mutex);
                        global_solver_2d_cuda.reset();
                    }
                    global_t2d = 0.0;
                    global_wallclock_2d = 0.0;
                    step_progress_2d = 0;
                    solver2d_initialized = false;
                } else if (command == "INIT_MPM" || command == "INIT_2D_MPM") {
                    global_solver_mpm_2d = std::make_unique<Blast::MPMSolver2D>();
                    global_endtime_mpm = msg.value("endtime", 1.0);

                    int nx = get_json_int(msg, "nr", get_json_int(msg, "nx", 64));
                    int ny = get_json_int(msg, "nz", get_json_int(msg, "ny", 64));
                    double max_x = get_json_double(msg, "max_r", get_json_double(msg, "max_x", 1.0));
                    double max_y = get_json_double(msg, "max_z", get_json_double(msg, "max_y", 1.0));
                    float dx = static_cast<float>(max_x / nx);
                    float dy = static_cast<float>(max_y / ny);

                    global_solver_mpm_2d->initializeGrid(nx, ny, dx, dy);
                    global_solver_mpm_2d->setBoundaryConditions(
                        parse_bc_mpm2d(msg.value("bc_x_min", msg.value("bc_r_min", "FreeSlip"))),
                        parse_bc_mpm2d(msg.value("bc_x_max", msg.value("bc_r_max", "Transmitting"))),
                        parse_bc_mpm2d(msg.value("bc_y_min", msg.value("bc_z_min", "FreeSlip"))),
                        parse_bc_mpm2d(msg.value("bc_y_max", msg.value("bc_z_max", "Transmitting")))
                    );

                    std::string transfer_scheme = msg.value("transfer_scheme", "BSpline");
                    std::string velocity_scheme = msg.value("velocity_scheme", "APIC");
                    std::string space_time_scheme = msg.value("space_time_scheme", "Leapfrog");
                    bool smooth_ps = get_json_bool(msg, "smooth_plastic_strain", true);

                    global_solver_mpm_2d->setTransferScheme(parseTransferScheme(transfer_scheme));
                    global_solver_mpm_2d->setSmoothPlasticStrain(smooth_ps);

                    auto st_2d = (space_time_scheme == "RK2") ? Blast::MPMTimeIntegrationScheme::RK2 :
                                 ((space_time_scheme == "USF") ? Blast::MPMTimeIntegrationScheme::USF :
                                 ((space_time_scheme == "USL") ? Blast::MPMTimeIntegrationScheme::USL : Blast::MPMTimeIntegrationScheme::Leapfrog));
                    global_solver_mpm_2d->setTimeScheme(st_2d);

                    if (velocity_scheme == "PIC") {
                        global_solver_mpm_2d->setVelocityScheme(Blast::MPMVelocityScheme::PIC);
                    } else if (velocity_scheme == "FLIP") {
                        global_solver_mpm_2d->setVelocityScheme(Blast::MPMVelocityScheme::FLIP);
                    } else {
                        global_solver_mpm_2d->setVelocityScheme(Blast::MPMVelocityScheme::APIC);
                    }

                    int domain_ppc = get_json_int(msg, "ppc", 4);
                    std::string domain_p_dist_str = msg.value("particle_distribution", "Cartesian");
                    std::string domain_b_fill_str = msg.value("boundary_filling", "Stairstepped");

                    if (msg.contains("mpm_objects") && msg["mpm_objects"].is_array()) {
                        int obj_idx = 0;
                        for (const auto& obj : msg["mpm_objects"]) {
                            obj_idx++;
                            std::string shape = obj.value("shape_type", "Rectangle");
                            float pos_x = static_cast<float>(get_json_double(obj, "pos_x", 0.5));
                            float pos_y = static_cast<float>(get_json_double(obj, "pos_y", 0.5));
                            float vel_x = static_cast<float>(get_json_double(obj, "vel_x", 0.0));
                            float vel_y = static_cast<float>(get_json_double(obj, "vel_y", 0.0));
                            float angular_vel = static_cast<float>(get_json_double(obj, "angular_vel", 0.0));
                            float density = static_cast<float>(get_json_double(obj, "density", 7850.0));
                            float E = static_cast<float>(get_json_double(obj, "youngs_modulus", 210.0e9));
                            float nu = static_cast<float>(get_json_double(obj, "poissons_ratio", 0.3));
                            float yield_stress = static_cast<float>(get_json_double(obj, "yield_stress", 400.0e6));
                            float hardening = static_cast<float>(get_json_double(obj, "hardening_modulus", 1.0e9));
                            float failure_strain = static_cast<float>(get_json_double(obj, "failure_strain", 0.25));
                            float tensile_failure_stress = static_cast<float>(get_json_double(obj, "tensile_failure_stress", 600.0e6));
                            int ppc = std::max(1, get_json_int(obj, "ppc", domain_ppc));

                            std::string p_dist_str = obj.value("particle_distribution", domain_p_dist_str);
                            Blast::MPMParticleDistribution particle_dist = Blast::MPMParticleDistribution::Cartesian;
                            if (p_dist_str == "Hexagonal") {
                                particle_dist = Blast::MPMParticleDistribution::Hexagonal;
                            }

                            std::string b_fill_str = obj.value("boundary_filling", domain_b_fill_str);
                            Blast::MPMBoundaryFilling boundary_fill = Blast::MPMBoundaryFilling::Stairstepped;
                            if (b_fill_str == "Partial") {
                                boundary_fill = Blast::MPMBoundaryFilling::Partial;
                            }

                            std::string mat_model_str = obj.value("material_model", "Hypoelastic");
                            Blast::MPMMaterialModel mat_model = parseMPMMaterialModel(mat_model_str);

                            float jc_A = static_cast<float>(get_json_double(obj, "jc_A", 792.0e6));
                            float jc_B = static_cast<float>(get_json_double(obj, "jc_B", 510.0e6));
                            float jc_n = static_cast<float>(get_json_double(obj, "jc_n", 0.26));
                            float jc_C = static_cast<float>(get_json_double(obj, "jc_C", 0.014));
                            float jc_m = static_cast<float>(get_json_double(obj, "jc_m", 1.03));
                            float T_melt = static_cast<float>(get_json_double(obj, "T_melt", 1793.0));
                            float T_room = static_cast<float>(get_json_double(obj, "T_room", 293.0));
                            float Cp = static_cast<float>(get_json_double(obj, "Cp", 477.0));
                            float mg_gamma0 = static_cast<float>(get_json_double(obj, "mg_gamma0", 1.81));
                            float mg_c0 = static_cast<float>(get_json_double(obj, "mg_c0", 4570.0));
                            float mg_s = static_cast<float>(get_json_double(obj, "mg_s", 1.49));

                            std::string solid_str = obj.value("solid_model", "");
                            std::string burn_str = obj.value("burn_model", "");
                            std::string prod_str = obj.value("product_model", "");
                            Blast::SolidReactantEOS solid_model = Blast::SolidReactantEOS::MieGruneisen;
                            Blast::ReactionKinetics burn_model = Blast::ReactionKinetics::ProgrammedBurn;
                            Blast::DetonationProductEOS product_model = Blast::DetonationProductEOS::JWLProductGas;
                            if (mat_model == Blast::MPMMaterialModel::CRESTReactiveBurn) {
                                solid_model = Blast::SolidReactantEOS::DavisSolid;
                                burn_model = Blast::ReactionKinetics::CRESTEntropy;
                                product_model = Blast::DetonationProductEOS::DavisProduct;
                            } else if (mat_model == Blast::MPMMaterialModel::LeeTarverIgnitionGrowth) {
                                solid_model = Blast::SolidReactantEOS::MieGruneisen;
                                burn_model = Blast::ReactionKinetics::LeeTarverODE;
                                product_model = Blast::DetonationProductEOS::JWLProductGas;
                            }
                            if (!solid_str.empty()) {
                                if (solid_str.find("Davis") != std::string::npos) solid_model = Blast::SolidReactantEOS::DavisSolid;
                                else if (solid_str.find("Mie") != std::string::npos || solid_str.find("Gruneisen") != std::string::npos || solid_str.find("Grüneisen") != std::string::npos) solid_model = Blast::SolidReactantEOS::MieGruneisen;
                            }
                            if (!burn_str.empty()) {
                                if (burn_str.find("CREST") != std::string::npos) burn_model = Blast::ReactionKinetics::CRESTEntropy;
                                else if (burn_str.find("Lee-Tarver") != std::string::npos || burn_str.find("LeeTarver") != std::string::npos || burn_str.find("ODE") != std::string::npos) burn_model = Blast::ReactionKinetics::LeeTarverODE;
                                else if (burn_str.find("Programmed") != std::string::npos || burn_str.find("Wavefront") != std::string::npos) burn_model = Blast::ReactionKinetics::ProgrammedBurn;
                            }
                            if (!prod_str.empty()) {
                                if (prod_str.find("Davis") != std::string::npos) product_model = Blast::DetonationProductEOS::DavisProduct;
                                else if (prod_str.find("JWL") != std::string::npos) product_model = Blast::DetonationProductEOS::JWLProductGas;
                            }

                            float jwl_A = static_cast<float>(get_json_double(obj, "jwl_A", 373.77e9));
                            float jwl_B = static_cast<float>(get_json_double(obj, "jwl_B", 3.747e9));
                            float jwl_R1 = static_cast<float>(get_json_double(obj, "jwl_R1", 4.15));
                            float jwl_R2 = static_cast<float>(get_json_double(obj, "jwl_R2", 0.90));
                            float jwl_omega = static_cast<float>(get_json_double(obj, "jwl_omega", 0.35));
                            float det_vel = static_cast<float>(get_json_double(obj, "det_vel", 6930.0));
                            float detonation_energy = static_cast<float>(get_json_double(obj, "detonation_energy", 4.29e6));
                            int burn_zone_cells = get_json_int(obj, "burn_zone_cells", 4);
                            float tau_burn_min = static_cast<float>(get_json_double(obj, "tau_burn_min", 1.0e-7));

                            float lt_I = static_cast<float>(get_json_double(obj, "lt_I", 4.0e6));
                            float lt_a = static_cast<float>(get_json_double(obj, "lt_a", 0.24));
                            float lt_b = static_cast<float>(get_json_double(obj, "lt_b", 0.667));
                            float lt_x = static_cast<float>(get_json_double(obj, "lt_x", 7.0));
                            float lt_G1 = static_cast<float>(get_json_double(obj, "lt_G1", 130.0e-6));
                            float lt_c = static_cast<float>(get_json_double(obj, "lt_c", 0.667));
                            float lt_d = static_cast<float>(get_json_double(obj, "lt_d", 0.333));
                            float lt_y = static_cast<float>(get_json_double(obj, "lt_y", 2.0));
                            float lt_G2 = static_cast<float>(get_json_double(obj, "lt_G2", 400.0e-6));
                            float lt_e = static_cast<float>(get_json_double(obj, "lt_e", 0.333));
                            float lt_g = static_cast<float>(get_json_double(obj, "lt_g", 0.667));
                            float lt_z = static_cast<float>(get_json_double(obj, "lt_z", 3.0));
                            float lt_ig_max = static_cast<float>(get_json_double(obj, "lt_ig_max", get_json_double(obj, "lt_F_ig_max", 0.02)));
                            float lt_growth_max = static_cast<float>(get_json_double(obj, "lt_growth_max", get_json_double(obj, "lt_F_G1_max", 0.50)));
                            float lt_comp_min = static_cast<float>(get_json_double(obj, "lt_comp_min", get_json_double(obj, "lt_F_G2_min", 0.50)));

                            float davis_c0 = static_cast<float>(get_json_double(obj, "davis_c0", 2050.0));
                            float davis_s1 = static_cast<float>(get_json_double(obj, "davis_s1", 2.12));
                            float davis_gamma0 = static_cast<float>(get_json_double(obj, "davis_gamma0", 0.65));
                            float davis_cv = static_cast<float>(get_json_double(obj, "davis_cv", 1000.0));
                            float davis_t0 = static_cast<float>(get_json_double(obj, "davis_t0", 293.0));
                            float davis_rho0 = static_cast<float>(get_json_double(obj, "davis_rho0", 1895.0));

                            float davis_a = static_cast<float>(get_json_double(obj, "davis_a", 2.85));
                            float davis_b = static_cast<float>(get_json_double(obj, "davis_b", 1.10));
                            float davis_k = static_cast<float>(get_json_double(obj, "davis_k", 1.35));
                            float davis_vc = static_cast<float>(get_json_double(obj, "davis_vc", 0.65));
                            float davis_pc = static_cast<float>(get_json_double(obj, "davis_pc", 12.5e9));
                            float davis_q_det = static_cast<float>(get_json_double(obj, "davis_q_det", 3.90e6));

                            float crest_b1 = static_cast<float>(get_json_double(obj, "crest_b1", 1.2e7));
                            float crest_c1 = static_cast<float>(get_json_double(obj, "crest_c1", 0.67));
                            float crest_m1 = static_cast<float>(get_json_double(obj, "crest_m1", 2.5));
                            float crest_b2 = static_cast<float>(get_json_double(obj, "crest_b2", 3.5e6));
                            float crest_c2 = static_cast<float>(get_json_double(obj, "crest_c2", 0.50));
                            float crest_c3 = static_cast<float>(get_json_double(obj, "crest_c3", 0.67));
                            float crest_m2 = static_cast<float>(get_json_double(obj, "crest_m2", 1.5));
                            float crest_s0 = static_cast<float>(get_json_double(obj, "crest_s0", 100.0));
                            float crest_s_threshold = static_cast<float>(get_json_double(obj, "crest_s_threshold", 45.0));
                            float crest_awe_K0s = static_cast<float>(get_json_double(obj, "crest_awe_K0s", 14245250000.0));
                            float crest_awe_A1 = static_cast<float>(get_json_double(obj, "crest_awe_A1", 2.417494));
                            float crest_awe_A2 = static_cast<float>(get_json_double(obj, "crest_awe_A2", 2.208027));
                            float crest_awe_A3 = static_cast<float>(get_json_double(obj, "crest_awe_A3", 0.0));
                            float crest_awe_B1 = static_cast<float>(get_json_double(obj, "crest_awe_B1", 0.0));
                            float crest_awe_B2 = static_cast<float>(get_json_double(obj, "crest_awe_B2", 0.0));
                            float crest_awe_B3 = static_cast<float>(get_json_double(obj, "crest_awe_B3", 0.0));
                            float crest_awe_fc = static_cast<float>(get_json_double(obj, "crest_awe_fc", 0.0));
                            float crest_awe_delta = static_cast<float>(get_json_double(obj, "crest_awe_delta", 0.0));
                            float crest_awe_Gamma1 = static_cast<float>(get_json_double(obj, "crest_awe_Gamma1", 32.33557));
                            float crest_awe_Gamma2 = static_cast<float>(get_json_double(obj, "crest_awe_Gamma2", 3.596933));
                            float crest_awe_gamma00 = static_cast<float>(get_json_double(obj, "crest_awe_gamma00", 0.4));
                            float crest_awe_m = static_cast<float>(get_json_double(obj, "crest_awe_m", 2.0));
                            float crest_awe_c0 = static_cast<float>(get_json_double(obj, "crest_awe_c0", 0.0));
                            float crest_awe_c1 = static_cast<float>(get_json_double(obj, "crest_awe_c1", 2.0));
                            float crest_awe_c2 = static_cast<float>(get_json_double(obj, "crest_awe_c2", 220000000.0));
                            float crest_awe_c3 = static_cast<float>(get_json_double(obj, "crest_awe_c3", 2.5));
                            float crest_awe_c6 = static_cast<float>(get_json_double(obj, "crest_awe_c6", 0.0));
                            float crest_awe_c8 = static_cast<float>(get_json_double(obj, "crest_awe_c8", 0.00016));
                            float crest_awe_c9 = static_cast<float>(get_json_double(obj, "crest_awe_c9", 1.0));
                            float crest_awe_c10 = static_cast<float>(get_json_double(obj, "crest_awe_c10", 400000.0));
                            float crest_awe_c11 = static_cast<float>(get_json_double(obj, "crest_awe_c11", 1.8));
                            float crest_awe_c12 = static_cast<float>(get_json_double(obj, "crest_awe_c12", 0.0));
                            float crest_awe_c13 = static_cast<float>(get_json_double(obj, "crest_awe_c13", 0.0));

                            bool enable_het = get_json_bool(obj, "enable_heterogeneity", false);
                            float weibull_modulus = static_cast<float>(get_json_double(obj, "weibull_modulus", 0.0));
                            if (weibull_modulus > 0.001f) enable_het = true;
                            float weibull_scale = static_cast<float>(get_json_double(obj, "weibull_scale", 1.0));
                            float weibull_ref_volume = static_cast<float>(get_json_double(obj, "weibull_ref_volume", 1.0e-4));

                            bool enable_aniso = get_json_bool(obj, "enable_anisotropy", false);
                            float aniso_ratio = static_cast<float>(get_json_double(obj, "anisotropy_ratio", 1.0));
                            float aniso_dir_x = static_cast<float>(get_json_double(obj, "anisotropy_dir_x", 1.0));
                            float aniso_dir_y = static_cast<float>(get_json_double(obj, "anisotropy_dir_y", 0.0));

                            if (shape == "Circle") {
                                float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
                                global_solver_mpm_2d->addCircleObject(obj_idx, pos_x, pos_y, radius, vel_x, vel_y, angular_vel, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill);
                            } else {
                                float size_x = static_cast<float>(get_json_double(obj, "size_x", 0.2));
                                float size_y = static_cast<float>(get_json_double(obj, "size_y", 0.2));
                                global_solver_mpm_2d->addRectangleObject(obj_idx, pos_x, pos_y, size_x, size_y, vel_x, vel_y, angular_vel, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill);
                            }

                            for (auto& p : global_solver_mpm_2d->getParticles()) {
                                if (p.object_id == obj_idx) {
                                    p.material_model = mat_model;
                                    p.jc_A = jc_A;
                                    p.jc_B = jc_B;
                                    p.jc_n = jc_n;
                                    p.jc_C = jc_C;
                                    p.jc_m = jc_m;
                                    p.T_melt = T_melt;
                                    p.T_room = T_room;
                                    p.Cp = Cp;
                                    p.mg_gamma0 = mg_gamma0;
                                    p.mg_c0 = mg_c0;
                                    p.mg_s = mg_s;
                                    p.solid_model = solid_model;
                                    p.burn_model = burn_model;
                                    p.product_model = product_model;
                                    p.jwl_A = jwl_A;
                                    p.jwl_B = jwl_B;
                                    p.jwl_R1 = jwl_R1;
                                    p.jwl_R2 = jwl_R2;
                                    p.jwl_omega = jwl_omega;
                                    p.det_vel = det_vel;
                                    p.detonation_energy = detonation_energy;
                                    p.burn_zone_cells = burn_zone_cells;
                                    p.tau_burn_min = tau_burn_min;
                                    p.lt_I = lt_I;
                                    p.lt_a = lt_a;
                                    p.lt_b = lt_b;
                                    p.lt_x = lt_x;
                                    p.lt_G1 = lt_G1;
                                    p.lt_c = lt_c;
                                    p.lt_d = lt_d;
                                    p.lt_y = lt_y;
                                    p.lt_G2 = lt_G2;
                                    p.lt_e = lt_e;
                                    p.lt_g = lt_g;
                                    p.lt_z = lt_z;
                                    p.lt_ig_max = lt_ig_max;
                                    p.lt_growth_max = lt_growth_max;
                                    p.lt_comp_min = lt_comp_min;
                                    p.davis_c0 = davis_c0;
                                    p.davis_s1 = davis_s1;
                                    p.davis_gamma0 = davis_gamma0;
                                    p.davis_cv = davis_cv;
                                    p.davis_t0 = davis_t0;
                                    p.davis_rho0 = davis_rho0;
                                    p.davis_a = davis_a;
                                    p.davis_b = davis_b;
                                    p.davis_k = davis_k;
                                    p.davis_vc = davis_vc;
                                    p.davis_pc = davis_pc;
                                    p.davis_q_det = davis_q_det;
                                    p.crest_b1 = crest_b1;
                                    p.crest_c1 = crest_c1;
                                    p.crest_m1 = crest_m1;
                                    p.crest_b2 = crest_b2;
                                    p.crest_c2 = crest_c2;
                                    p.crest_c3 = crest_c3;
                                    p.crest_m2 = crest_m2;
                                    p.crest_s0 = crest_s0;
                                    p.crest_s_threshold = crest_s_threshold;
                                    p.crest_awe_K0s = crest_awe_K0s;
                                    p.crest_awe_A1 = crest_awe_A1;
                                    p.crest_awe_A2 = crest_awe_A2;
                                    p.crest_awe_A3 = crest_awe_A3;
                                    p.crest_awe_B1 = crest_awe_B1;
                                    p.crest_awe_B2 = crest_awe_B2;
                                    p.crest_awe_B3 = crest_awe_B3;
                                    p.crest_awe_fc = crest_awe_fc;
                                    p.crest_awe_delta = crest_awe_delta;
                                    p.crest_awe_Gamma1 = crest_awe_Gamma1;
                                    p.crest_awe_Gamma2 = crest_awe_Gamma2;
                                    p.crest_awe_gamma00 = crest_awe_gamma00;
                                    p.crest_awe_m = crest_awe_m;
                                    p.crest_awe_c0 = crest_awe_c0;
                                    p.crest_awe_c1 = crest_awe_c1;
                                    p.crest_awe_c2 = crest_awe_c2;
                                    p.crest_awe_c3 = crest_awe_c3;
                                    p.crest_awe_c6 = crest_awe_c6;
                                    p.crest_awe_c8 = crest_awe_c8;
                                    p.crest_awe_c9 = crest_awe_c9;
                                    p.crest_awe_c10 = crest_awe_c10;
                                    p.crest_awe_c11 = crest_awe_c11;
                                    p.crest_awe_c12 = crest_awe_c12;
                                    p.crest_awe_c13 = crest_awe_c13;
                                    p.temperature = T_room;
                                    p.e_int = 0.0f;
                                    p.enable_heterogeneity = enable_het;
                                    p.weibull_modulus = weibull_modulus;
                                    p.weibull_scale = weibull_scale;
                                    p.weibull_ref_volume = weibull_ref_volume;
                                    if (enable_het && weibull_modulus > 0.001f) {
                                        p.weibull_factor = Blast::computeWeibullFactor2D(p.x[0], p.x[1], p.V0, weibull_modulus, weibull_scale, weibull_ref_volume);
                                    } else {
                                        p.weibull_factor = 1.0f;
                                    }
                                    p.enable_anisotropy = enable_aniso;
                                    p.anisotropy_ratio = aniso_ratio;
                                    p.anisotropy_dir[0] = aniso_dir_x;
                                    p.anisotropy_dir[1] = aniso_dir_y;
                                }
                            }
                        }

                    } else {
                        // Default steel impact primitives test case
                        global_solver_mpm_2d->addCircleObject(1, 0.3f, 0.5f, 0.1f, 150.0f, 0.0f, 0.0f, 7850.0f, 210.0e9f, 0.3f, 400.0e6f, 1.0e9f, 0.25f, 600.0e6f, domain_ppc);
                        global_solver_mpm_2d->addRectangleObject(2, 0.7f, 0.5f, 0.2f, 0.4f, 0.0f, 0.0f, 0.0f, 7850.0f, 210.0e9f, 0.3f, 400.0e6f, 1.0e9f, 0.25f, 600.0e6f, domain_ppc);
                    }

                    global_solver_mpm_2d->particleToGrid();
                    emit_telemetry_mpm_2d(0.0, false);
                    std::string init_log = "2D MPM Solver Initialized (" + std::to_string(global_solver_mpm_2d->getParticles().size()) + " particles, PPC=" + std::to_string(domain_ppc) + ")";
                    emit_kernel_log("SYSTEM", init_log, 0.0, "mpm_2d");
                } else if (command == "STEP_MPM" || command == "STEP_2D_MPM") {
                    if (!global_solver_mpm_2d) continue;
                    int steps = get_json_int(msg, "steps", 1);
                    global_cfl_mpm = static_cast<float>(get_json_double(msg, "cfl", 0.6));
                    if (msg.contains("endtime")) global_endtime_mpm = msg.value("endtime", 1.0);
                    global_exec_until_end_mpm = false;
                    if (!sim_mpm_running) {
                        global_target_steps_mpm = steps;
                        sim_mpm_running = true;
                        sim_mpm_paused = false;
                        sim_mpm_terminate = false;
                        std::thread(worker_mpm_2d_thread_func).detach();
                    } else {
                        global_target_steps_mpm.fetch_add(steps);
                        sim_mpm_paused = false;
                    }
                } else if (command == "EXEC_ALL_MPM") {
                    if (!global_solver_mpm_2d) continue;
                    global_cfl_mpm = static_cast<float>(get_json_double(msg, "cfl", 0.6));
                    if (msg.contains("endtime")) global_endtime_mpm = msg.value("endtime", 1.0);
                    global_exec_until_end_mpm = true;
                    if (!sim_mpm_running) {
                        sim_mpm_running = true;
                        sim_mpm_paused = false;
                        sim_mpm_terminate = false;
                        std::thread(worker_mpm_2d_thread_func).detach();
                    } else {
                        sim_mpm_paused = false;
                    }
                } else if (command == "PAUSE_MPM") {
                    sim_mpm_paused = true;
                    global_target_steps_mpm = 0;
                } else if (command == "RESUME_MPM") {
                    sim_mpm_paused = false;
                } else if (command == "TERMINATE_MPM") {
                    sim_mpm_terminate = true;
                    while (sim_mpm_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_mpm_2d.reset();
                } else if (command == "INIT_MPM_3D" || command == "INIT_3D_MPM") {
                    try {
                        sim_mpm_3d_terminate = true;
                    while (sim_mpm_3d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_mpm_3d.reset();
                    global_solver_mpm_3d_cuda.reset();
#if defined(HAS_CUDA_RUNTIME)
                    cudaDeviceSynchronize();
#endif
#if defined(__linux__)
                    malloc_trim(0);
#endif
                    sim_mpm_3d_terminate = false;
                    sim_mpm_3d_paused = false;
                    global_endtime_mpm_3d = msg.value("endtime", 1.0);

                    global_slices_3d.clear();
                    if (msg.contains("slices")) {
                        for (const auto& s_msg : msg["slices"]) {
                            Slice3D s;
                            s.axis = s_msg.value("axis", "xy");
                            s.offset = s_msg.value("offset", 0.5);
                            s.stride = s_msg.value("stride", 1);
                            s.enabled = get_json_bool(s_msg, "enabled", true);
                            if (s.stride < 1) s.stride = 1;
                            if (s_msg.contains("quantities") && s_msg["quantities"].is_array()) {
                                for (const auto& q : s_msg["quantities"]) {
                                    if (q.is_string()) s.quantities.push_back(q.get<std::string>());
                                }
                            } else if (s_msg.contains("quantity") && s_msg["quantity"].is_string()) {
                                s.quantities.push_back(s_msg["quantity"].get<std::string>());
                            }
                            global_slices_3d.push_back(s);
                        }
                    }
                    if (msg.contains("refresh_rate")) {
                        global_refresh_rate_mpm_3d = get_json_double(msg, "refresh_rate", 0.5);
                    }
                    if (msg.contains("telemetry_interval_ms")) {
                        global_telemetry_interval_ms = get_json_int(msg, "telemetry_interval_ms", 100);
                    }
                    if (msg.contains("particle_stride")) {
                        global_mpm_particle_stride = std::max(1, msg.value("particle_stride", 1));
                    } else {
                        global_mpm_particle_stride = 1;
                    }

                    std::string device = msg.value("device", "cpu");
                    select_cuda_device(device);
                    if (is_cuda_device(device)) {
                        global_solver_mpm_3d.reset();
                        global_solver_mpm_3d_cuda = std::make_unique<Blast::MPMSolver3DCUDA>();
                    } else {
                        global_solver_mpm_3d_cuda.reset();
                        global_solver_mpm_3d = std::make_unique<Blast::MPMSolver3D>();
                    }

                    float xmin = static_cast<float>(get_json_double(msg, "xmin", 0.0));
                    float xmax = static_cast<float>(get_json_double(msg, "xmax", 1.0));
                    float ymin = static_cast<float>(get_json_double(msg, "ymin", 0.0));
                    float ymax = static_cast<float>(get_json_double(msg, "ymax", 1.0));
                    float zmin = static_cast<float>(get_json_double(msg, "zmin", 0.0));
                    float zmax = static_cast<float>(get_json_double(msg, "zmax", 1.0));

                    int nx, ny, nz;
                    float dx, dy, dz;
                    if (msg.contains("cell_size")) {
                        float cell_size = static_cast<float>(get_json_double(msg, "cell_size", 0.01));
                        dx = cell_size; dy = cell_size; dz = cell_size;
                        nx = std::max(1, static_cast<int>(std::round((xmax - xmin) / cell_size)));
                        ny = std::max(1, static_cast<int>(std::round((ymax - ymin) / cell_size)));
                        nz = std::max(1, static_cast<int>(std::round((zmax - zmin) / cell_size)));
                    } else {
                        nx = get_json_int(msg, "nx", get_json_int(msg, "nr", 32));
                        ny = get_json_int(msg, "ny", 32);
                        nz = get_json_int(msg, "nz", get_json_int(msg, "nz", 32));
                        dx = (xmax - xmin) / static_cast<float>(nx);
                        dy = (ymax - ymin) / static_cast<float>(ny);
                        dz = (zmax - zmin) / static_cast<float>(nz);
                    }

                    bool is_cuda_mpm = is_cuda_device(device);
                    size_t est_particles = estimateMPMTotalParticles(msg, dx, dy, dz);
                    auto est_mpm = Blast::estimateMPM3DMemory(nx, ny, nz, est_particles, is_cuda_mpm);
                    Blast::validateMemoryBudget(est_mpm.ram_bytes, est_mpm.vram_bytes, is_cuda_mpm, "3D MPM Solver");

                    if (global_solver_mpm_3d_cuda) {
                        global_solver_mpm_3d_cuda->initializeGrid(nx, ny, nz, dx, dy, dz, xmin, ymin, zmin);
                    } else {
                        global_solver_mpm_3d->initializeGrid(nx, ny, nz, dx, dy, dz, xmin, ymin, zmin);
                    }

                    std::string transfer_scheme = msg.value("transfer_scheme", "BSpline");
                    std::string velocity_scheme = msg.value("velocity_scheme", "APIC");
                    std::string space_time_scheme = msg.value("space_time_scheme", "Leapfrog");

                    auto ts = parseTransferScheme(transfer_scheme);
                    auto vs = (velocity_scheme == "PIC") ? Blast::MPMVelocityScheme::PIC :
                              ((velocity_scheme == "FLIP") ? Blast::MPMVelocityScheme::FLIP : Blast::MPMVelocityScheme::APIC);
                    float flip_blend = static_cast<float>(get_json_double(msg, "flip_blend", 0.95));
                    auto st = (space_time_scheme == "RK2") ? Blast::MPMTimeIntegrationScheme::RK2 :
                              ((space_time_scheme == "USF") ? Blast::MPMTimeIntegrationScheme::USF :
                              ((space_time_scheme == "USL") ? Blast::MPMTimeIntegrationScheme::USL : Blast::MPMTimeIntegrationScheme::Leapfrog));

                    bool smooth_ps = get_json_bool(msg, "smooth_plastic_strain", true);
                    bool enable_dem_contact = get_json_bool(msg, "enable_dem_contact", false);
                    float dem_friction = static_cast<float>(get_json_double(msg, "dem_friction", 0.20));
                    float dem_restitution = static_cast<float>(get_json_double(msg, "dem_restitution", 0.0));
                    float dem_contact_scale = static_cast<float>(get_json_double(msg, "dem_contact_scale", 1.0));
                    std::string dem_mode_str = msg.value("dem_contact_mode", "Gas-Solid Only");
                    Blast::MPMDEMContactMode dem_mode = Blast::MPMDEMContactMode::GasSolidOnly;
                    if (dem_mode_str == "Ballistic Impacts & Gas" || dem_mode_str == "BallisticAndGas") {
                        dem_mode = Blast::MPMDEMContactMode::BallisticAndGas;
                    } else if (dem_mode_str == "All Dynamic Contacts" || dem_mode_str == "AllDynamic") {
                        dem_mode = Blast::MPMDEMContactMode::AllDynamic;
                    }
                    float dem_v_thresh = static_cast<float>(get_json_double(msg, "dem_velocity_threshold", 1.0));

                    std::string contact_method_str = msg.value("contact_method", "Single-Velocity");
                    Blast::MPMContactMethod contact_method = Blast::MPMContactMethod::SingleVelocity;
                    if (contact_method_str == "Sub-Grid DEM" || contact_method_str == "SubGridDEM" ||
                        contact_method_str == "Discrete Element (DEM)" || contact_method_str == "DiscreteElementDEM" ||
                        contact_method_str.find("DEM") != std::string::npos) {
                        contact_method = Blast::MPMContactMethod::SubGridDEM;
                        enable_dem_contact = true;
                    } else if (contact_method_str.find("Bardenhagen") != std::string::npos ||
                               contact_method_str.find("Multi-Velocity") != std::string::npos ||
                               contact_method_str == "MultiVelocityBardenhagen") {
                        contact_method = Blast::MPMContactMethod::MultiVelocityBardenhagen;
                    } else if (enable_dem_contact) {
                        contact_method = Blast::MPMContactMethod::SubGridDEM;
                    }
                    std::string parsed_contact_name = (contact_method == Blast::MPMContactMethod::MultiVelocityBardenhagen) ? "MultiVelocityBardenhagen" :
                                                      ((contact_method == Blast::MPMContactMethod::SubGridDEM) ? "SubGridDEM" : "SingleVelocity");
                    std::cout << "[BlastSolver] 3D MPM Contact Method: '" << contact_method_str << "' -> " << parsed_contact_name << std::endl;

                    bool enable_sdf_barrier = get_json_bool(msg, "enable_sdf_barrier", true);
                    float sdf_restitution = static_cast<float>(get_json_double(msg, "sdf_barrier_restitution", 0.10));
                    float sdf_friction = static_cast<float>(get_json_double(msg, "sdf_barrier_friction", 0.25));
                    float sdf_skin = static_cast<float>(get_json_double(msg, "sdf_barrier_skin", 0.15));

                    bool enable_impact_welding = get_json_bool(msg, "enable_impact_welding", false);
                    bool enable_frictional_heating = get_json_bool(msg, "enable_frictional_heating", false);
                    bool enable_thermal_conduction = get_json_bool(msg, "enable_thermal_conduction", false);

                    if (global_solver_mpm_3d_cuda) {
                        global_solver_mpm_3d_cuda->setTransferScheme(ts);
                        global_solver_mpm_3d_cuda->setVelocityScheme(vs);
                        global_solver_mpm_3d_cuda->setFlipBlend(flip_blend);
                        global_solver_mpm_3d_cuda->setTimeScheme(st);
                        global_solver_mpm_3d_cuda->setSmoothPlasticStrain(smooth_ps);
                        global_solver_mpm_3d_cuda->setDemContact(enable_dem_contact, dem_friction, dem_restitution, dem_contact_scale, dem_mode, dem_v_thresh);
                        global_solver_mpm_3d_cuda->setContactMethod(contact_method);
                        global_solver_mpm_3d_cuda->setImpactWelding(enable_impact_welding);
                        global_solver_mpm_3d_cuda->setFrictionalHeating(enable_frictional_heating);
                        global_solver_mpm_3d_cuda->setThermalConduction(enable_thermal_conduction);
                        global_solver_mpm_3d_cuda->setSdfBarrier(enable_sdf_barrier, sdf_restitution, sdf_friction, sdf_skin);
                    } else {
                        global_solver_mpm_3d->setTransferScheme(ts);
                        global_solver_mpm_3d->setVelocityScheme(vs);
                        global_solver_mpm_3d->setFlipBlend(flip_blend);
                        global_solver_mpm_3d->setTimeScheme(st);
                        global_solver_mpm_3d->setSmoothPlasticStrain(smooth_ps);
                        global_solver_mpm_3d->setDemContact(enable_dem_contact, dem_friction, dem_restitution, dem_contact_scale, dem_mode, dem_v_thresh);
                        global_solver_mpm_3d->setContactMethod(contact_method);
                        global_solver_mpm_3d->setImpactWelding(enable_impact_welding);
                        global_solver_mpm_3d->setFrictionalHeating(enable_frictional_heating);
                        global_solver_mpm_3d->setThermalConduction(enable_thermal_conduction);
                        global_solver_mpm_3d->setSdfBarrier(enable_sdf_barrier, sdf_restitution, sdf_friction, sdf_skin);
                    }

                    auto bc1 = parse_bc_mpm3d(msg.value("bc_x_min", "Reflecting"));
                    auto bc2 = parse_bc_mpm3d(msg.value("bc_x_max", "Reflecting"));
                    auto bc3 = parse_bc_mpm3d(msg.value("bc_y_min", "Reflecting"));
                    auto bc4 = parse_bc_mpm3d(msg.value("bc_y_max", "Reflecting"));
                    auto bc5 = parse_bc_mpm3d(msg.value("bc_z_min", "Reflecting"));
                    auto bc6 = parse_bc_mpm3d(msg.value("bc_z_max", "Reflecting"));

                    Blast::LysmerDashpotParams mpm_lysmer;
                    mpm_lysmer.rho = static_cast<float>(get_json_double(msg, "lysmer_rho", get_json_double(msg, "lysmer_density", 2000.0)));
                    mpm_lysmer.c_p = static_cast<float>(get_json_double(msg, "lysmer_cp", get_json_double(msg, "lysmer_c_p", 2000.0)));
                    mpm_lysmer.c_s = static_cast<float>(get_json_double(msg, "lysmer_cs", get_json_double(msg, "lysmer_c_s", 1000.0)));
                    mpm_lysmer.normal_relaxation = static_cast<float>(get_json_double(msg, "lysmer_normal_relaxation", 1.0));
                    mpm_lysmer.shear_relaxation = static_cast<float>(get_json_double(msg, "lysmer_shear_relaxation", 1.0));

                    if (global_solver_mpm_3d_cuda) {
                        global_solver_mpm_3d_cuda->setBoundaryConditions(bc1, bc2, bc3, bc4, bc5, bc6);
                        global_solver_mpm_3d_cuda->setLysmerParams(mpm_lysmer);
                    } else {
                        global_solver_mpm_3d->setBoundaryConditions(bc1, bc2, bc3, bc4, bc5, bc6);
                        global_solver_mpm_3d->setLysmerParams(mpm_lysmer);
                    }

                    int domain_ppc = get_json_int(msg, "ppc", 8);
                    std::string domain_p_dist_str = msg.value("particle_distribution", "Cartesian");
                    std::string domain_b_fill_str = msg.value("boundary_filling", "Stairstepped");

                    align_sleeve_tait_with_fv(const_cast<nlohmann::json&>(msg));
                    if (msg.contains("mpm_objects") && msg["mpm_objects"].is_array()) {
                        // Phase 1: Add all object geometries to host particles
                        int obj_idx = 0;
                        for (const auto& obj : msg["mpm_objects"]) {
                            obj_idx++;
                            std::string shape = obj.value("shape_type", "Box");
                            std::string origin_mode = obj.value("origin_mode", "Center");
                            float pos_fallback = (shape == "STL" && origin_mode == "CAD Origin") ? 0.0f : 0.5f;
                            float pos_x = static_cast<float>(get_json_double(obj, "pos_x", pos_fallback));
                            float pos_y = static_cast<float>(get_json_double(obj, "pos_y", pos_fallback));
                            float pos_z = static_cast<float>(get_json_double(obj, "pos_z", pos_fallback));
                            if (shape == "STL" && origin_mode == "CAD Origin" &&
                                std::abs(pos_x - 0.5f) < 1e-4f && std::abs(pos_y - 0.5f) < 1e-4f && std::abs(pos_z - 0.5f) < 1e-4f) {
                                pos_x = 0.0f;
                                pos_y = 0.0f;
                                pos_z = 0.0f;
                            }
                            float vel_x = static_cast<float>(get_json_double(obj, "vel_x", 0.0));
                            float vel_y = static_cast<float>(get_json_double(obj, "vel_y", 0.0));
                            float vel_z = static_cast<float>(get_json_double(obj, "vel_z", 0.0));
                            float ang_x = static_cast<float>(get_json_double(obj, "angular_vel_x", 0.0));
                            float ang_y = static_cast<float>(get_json_double(obj, "angular_vel_y", 0.0));
                            float ang_z = static_cast<float>(get_json_double(obj, "angular_vel_z", 0.0));
                            float density = static_cast<float>(get_json_double(obj, "density", 7850.0));
                            float E = static_cast<float>(get_json_double(obj, "youngs_modulus", 210.0e9));
                            float nu = static_cast<float>(get_json_double(obj, "poissons_ratio", 0.3));
                            float yield_stress = static_cast<float>(get_json_double(obj, "yield_stress", 400.0e6));
                            float hardening = static_cast<float>(get_json_double(obj, "hardening_modulus", 1.0e9));
                            float failure_strain = static_cast<float>(get_json_double(obj, "failure_strain", 0.25));
                            float tensile_failure_stress = static_cast<float>(get_json_double(obj, "tensile_failure_stress", 600.0e6));
                            int ppc = std::max(1, get_json_int(obj, "ppc", domain_ppc));


                            std::string p_dist_str = obj.value("particle_distribution", domain_p_dist_str);
                            Blast::MPMParticleDistribution particle_dist = Blast::MPMParticleDistribution::Cartesian;
                            if (p_dist_str == "Hexagonal") {
                                particle_dist = Blast::MPMParticleDistribution::Hexagonal;
                            }

                            std::string b_fill_str = obj.value("boundary_filling", domain_b_fill_str);
                            Blast::MPMBoundaryFilling boundary_fill = Blast::MPMBoundaryFilling::Stairstepped;
                            if (b_fill_str == "Partial") {
                                boundary_fill = Blast::MPMBoundaryFilling::Partial;
                            }

                            float rot_x = static_cast<float>(get_json_double(obj, "rot_x", 0.0));
                            float rot_y = static_cast<float>(get_json_double(obj, "rot_y", 0.0));
                            float rot_z = static_cast<float>(get_json_double(obj, "rot_z", 0.0));
                            float clip_z_min = static_cast<float>(get_json_double(obj, "clip_z_min", -1.0e30));
                            float clip_z_max = static_cast<float>(get_json_double(obj, "clip_z_max", 1.0e30));

                            if (shape == "Sphere") {
                                float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
                                float inner_radius = static_cast<float>(get_json_double(obj, "inner_radius", 0.0));
                                if (global_solver_mpm_3d_cuda) {
                                    global_solver_mpm_3d_cuda->addSphereObject(obj_idx, pos_x, pos_y, pos_z, radius, inner_radius, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
                                } else {
                                    global_solver_mpm_3d->addSphereObject(obj_idx, pos_x, pos_y, pos_z, radius, inner_radius, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
                                }
                            } else if (shape == "Cylinder") {
                                float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
                                float inner_radius = static_cast<float>(get_json_double(obj, "inner_radius", 0.0));
                                float height = static_cast<float>(get_json_double(obj, "height", 0.2));
                                if (global_solver_mpm_3d_cuda) {
                                    global_solver_mpm_3d_cuda->addCylinderObject(obj_idx, pos_x, pos_y, pos_z, radius, inner_radius, height, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
                                } else {
                                    global_solver_mpm_3d->addCylinderObject(obj_idx, pos_x, pos_y, pos_z, radius, inner_radius, height, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
                                }
                            } else if (shape == "STL") {
                                std::string stl_file = obj.contains("stl_file") ? obj["stl_file"].get<std::string>() : "";
                                float scale_x = static_cast<float>(get_json_double(obj, "scale_x", 1.0));
                                float scale_y = static_cast<float>(get_json_double(obj, "scale_y", 1.0));
                                float scale_z = static_cast<float>(get_json_double(obj, "scale_z", 1.0));
                                std::string origin_mode = obj.value("origin_mode", "Center");
                                std::string voxelization_method = obj.value("voxelization_method", "watertight_raycast");
                                if (global_solver_mpm_3d_cuda) {
                                    global_solver_mpm_3d_cuda->addSTLObject(obj_idx, stl_file, pos_x, pos_y, pos_z, scale_x, scale_y, scale_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, voxelization_method, rot_x, rot_y, rot_z, origin_mode);
                                } else {
                                    global_solver_mpm_3d->addSTLObject(obj_idx, stl_file, pos_x, pos_y, pos_z, scale_x, scale_y, scale_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, voxelization_method, rot_x, rot_y, rot_z, origin_mode);
                                }
                            } else {
                                float size_x = static_cast<float>(get_json_double(obj, "size_x", 0.2));
                                float size_y = static_cast<float>(get_json_double(obj, "size_y", 0.2));
                                float size_z = static_cast<float>(get_json_double(obj, "size_z", 0.2));
                                if (global_solver_mpm_3d_cuda) {
                                    global_solver_mpm_3d_cuda->addBoxObject(obj_idx, pos_x, pos_y, pos_z, size_x, size_y, size_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
                                } else {
                                    global_solver_mpm_3d->addBoxObject(obj_idx, pos_x, pos_y, pos_z, size_x, size_y, size_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
                                }
                            }
                        }

                        // Phase 2: Populate material tables for all objects
                        obj_idx = 0;
                        for (const auto& obj : msg["mpm_objects"]) {
                            obj_idx++;
                            Blast::MaterialTable3D parsed_mat = parseMaterialTable3D(obj);
                            std::string mat_model_str = obj.value("material_model", "Hypoelastic");
                            std::cout << "[BlastSolver] Object " << obj_idx << " Constitutive Model: " << mat_model_str
                                      << " -> Enum=" << static_cast<int>(parsed_mat.material_model) << std::endl;
                            emit_kernel_log("SYSTEM", "Object " + std::to_string(obj_idx) + " Material Model: " + mat_model_str + " (Enum=" + std::to_string(static_cast<int>(parsed_mat.material_model)) + ")", 0.0, "mpm_3d");
                            if (global_solver_mpm_3d_cuda) {
                                auto& mat_tables = global_solver_mpm_3d_cuda->getMaterialTables();
                                if (obj_idx >= static_cast<int>(mat_tables.size())) {
                                    mat_tables.resize(obj_idx + 1);
                                }
                                mat_tables[obj_idx] = parsed_mat;
                            }
                            if (global_solver_mpm_3d) {
                                auto& mat_tables = global_solver_mpm_3d->getMaterialTables();
                                if (obj_idx >= static_cast<int>(mat_tables.size())) {
                                    mat_tables.resize(obj_idx + 1);
                                }
                                mat_tables[obj_idx] = parsed_mat;
                            }
                        }

                        // Phase 3: Material heterogeneity & fragment seeding on host
                        obj_idx = 0;
                        for (const auto& obj : msg["mpm_objects"]) {
                            obj_idx++;
                            (void)obj;
                            if (global_solver_mpm_3d_cuda) {
                                global_solver_mpm_3d_cuda->initMaterialHeterogeneity(obj_idx);
                            }
                            if (global_solver_mpm_3d) {
                                global_solver_mpm_3d->initMaterialHeterogeneity(obj_idx);
                            }
                        }

                        // Phase 4: Trigger / Detonator hotspot ignition and initial temperature
                        if (global_solver_mpm_3d_cuda) {
                            global_solver_mpm_3d_cuda->clearDetonators();
                        }
                        if (global_solver_mpm_3d) {
                            global_solver_mpm_3d->clearDetonators();
                        }

                        struct TriggerSpec3D {
                            float x, y, z, radius;
                            float start_time{0.0f};
                            bool track_mpm_velocity{false};
                            int target_object_id{-1};
                        };
                        std::vector<TriggerSpec3D> global_triggers_3d;
                        auto parse_trigger_obj = [](const nlohmann::json& d) -> TriggerSpec3D {
                            float tx = static_cast<float>(get_json_double(d, "trigger_x", get_json_double(d, "detonator_x", get_json_double(d, "x", 0.5))));
                            float ty = static_cast<float>(get_json_double(d, "trigger_y", get_json_double(d, "detonator_y", get_json_double(d, "y", 0.5))));
                            float tz = static_cast<float>(get_json_double(d, "trigger_z", get_json_double(d, "detonator_z", get_json_double(d, "z", 0.5))));
                            float tr = static_cast<float>(get_json_double(d, "trigger_radius", get_json_double(d, "detonator_radius", get_json_double(d, "initiation_radius", get_json_double(d, "radius", 0.02)))));
                            float t_start = static_cast<float>(get_json_double(d, "time_delay", get_json_double(d, "start_time", get_json_double(d, "detonation_time", get_json_double(d, "delay", 0.0)))));
                            bool track_vel = false;
                            if (d.contains("track_mpm_velocity")) {
                                if (d["track_mpm_velocity"].is_boolean()) track_vel = d["track_mpm_velocity"].get<bool>();
                                else if (d["track_mpm_velocity"].is_number()) track_vel = (d["track_mpm_velocity"].get<int>() != 0);
                                else if (d["track_mpm_velocity"].is_string()) {
                                    std::string s = d["track_mpm_velocity"].get<std::string>();
                                    track_vel = (s == "true" || s == "1" || s == "yes");
                                }
                            }
                            int target_obj = get_json_int(d, "target_object_id", get_json_int(d, "object_id", -1));
                            return {tx, ty, tz, tr, t_start, track_vel, target_obj};
                        };

                        auto register_detonator_to_solvers = [&](const TriggerSpec3D& trig, int obj_id) {
                            Blast::MPMDetonator3D d;
                            d.x = trig.x;
                            d.y = trig.y;
                            d.z = trig.z;
                            d.radius = trig.radius;
                            d.time_delay = trig.start_time;
                            d.track_mpm_velocity = trig.track_mpm_velocity;
                            d.fired = (trig.start_time <= 0.0f);
                            d.target_object_id = (trig.target_object_id >= 0) ? trig.target_object_id : obj_id;
                            if (global_solver_mpm_3d_cuda) global_solver_mpm_3d_cuda->addDetonator(d);
                            if (global_solver_mpm_3d) global_solver_mpm_3d->addDetonator(d);
                        };

                        if (msg.contains("triggers") && msg["triggers"].is_array()) {
                            for (const auto& d : msg["triggers"]) {
                                auto trig = parse_trigger_obj(d);
                                global_triggers_3d.push_back(trig);
                                register_detonator_to_solvers(trig, trig.target_object_id);
                            }
                        } else if (msg.contains("detonators") && msg["detonators"].is_array()) {
                            for (const auto& d : msg["detonators"]) {
                                auto trig = parse_trigger_obj(d);
                                global_triggers_3d.push_back(trig);
                                register_detonator_to_solvers(trig, trig.target_object_id);
                            }
                        } else if (msg.contains("trigger_x") || msg.contains("detonator_x")) {
                            auto trig = parse_trigger_obj(msg);
                            global_triggers_3d.push_back(trig);
                            register_detonator_to_solvers(trig, trig.target_object_id);
                        }

                        auto& particles_ref = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getParticles() : global_solver_mpm_3d->getParticles();
                        const auto& mat_tables = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getMaterialTables() : global_solver_mpm_3d->getMaterialTables();

                        obj_idx = 0;
                        for (const auto& obj : msg["mpm_objects"]) {
                            obj_idx++;
                            const auto& parsed_mat = mat_tables[obj_idx];
                            std::string mat_model_str = obj.value("material_model", "Hypoelastic");
                            bool is_crest = (parsed_mat.material_model == Blast::MPMMaterialModel::CRESTReactiveBurn);
                            bool is_jwl_prog = (parsed_mat.material_model == Blast::MPMMaterialModel::JWLProgrammedBurn);
                            bool is_lee_tarver = (parsed_mat.material_model == Blast::MPMMaterialModel::LeeTarverIgnitionGrowth);
                            bool is_explosive = is_crest || is_jwl_prog || is_lee_tarver;

                            std::string preset_name = obj.value("preset", "");
                            bool is_predetonated = (preset_name.find("Pre-Detonated") != std::string::npos ||
                                                    preset_name.find("Instant") != std::string::npos ||
                                                    preset_name.find("JWL Detonation Gas") != std::string::npos);

                            std::vector<TriggerSpec3D> triggers_3d = global_triggers_3d;
                            if (obj.contains("triggers") && obj["triggers"].is_array()) {
                                for (const auto& d : obj["triggers"]) {
                                    auto trig = parse_trigger_obj(d);
                                    triggers_3d.push_back(trig);
                                    register_detonator_to_solvers(trig, obj_idx);
                                }
                            } else if (obj.contains("detonators") && obj["detonators"].is_array()) {
                                for (const auto& d : obj["detonators"]) {
                                    auto trig = parse_trigger_obj(d);
                                    triggers_3d.push_back(trig);
                                    register_detonator_to_solvers(trig, obj_idx);
                                }
                            } else if (obj.contains("trigger_x") || obj.contains("detonator_x")) {
                                auto trig = parse_trigger_obj(obj);
                                triggers_3d.push_back(trig);
                                register_detonator_to_solvers(trig, obj_idx);
                            }

                            int ignited_count = 0;
                            for (auto& p : particles_ref) {
                                if (p.object_id == obj_idx) {
                                    p.temperature = parsed_mat.T_room;

                                    if (is_jwl_prog) {
                                        if (is_predetonated) {
                                            p.lambda = 1.0f;
                                            p.t_arrival = 0.0f;
                                            p.e_int = parsed_mat.detonation_energy;
                                            float p_init = Blast::JWL::computeJWLProductPressure(p.V0 > 0.0f ? p.V / p.V0 : 1.0f, parsed_mat.detonation_energy, parsed_mat.jwl_A, parsed_mat.jwl_B, parsed_mat.jwl_R1, parsed_mat.jwl_R2, parsed_mat.jwl_omega, parsed_mat.density);
                                            for (int r = 0; r < 3; ++r)
                                                for (int c = 0; c < 3; ++c)
                                                    p.sigma[r][c] = (r == c) ? -p_init : 0.0f;
                                            ignited_count++;
                                        } else if (!triggers_3d.empty()) {
                                            float min_t_arr = 1.0e10f;
                                            bool has_immediate = false;
                                            for (const auto& trig : triggers_3d) {
                                                if (trig.track_mpm_velocity && trig.start_time > 0.0f) {
                                                    continue;
                                                }
                                                if (trig.start_time <= 0.0f) has_immediate = true;
                                                float d_x = p.x[0] - trig.x;
                                                float d_y = p.x[1] - trig.y;
                                                float d_z = p.x[2] - trig.z;
                                                float dist = std::sqrt(d_x * d_x + d_y * d_y + d_z * d_z);
                                                float eff_dist = (trig.radius > 0.0f) ? std::max(0.0f, dist - trig.radius) : dist;
                                                float t_arr = trig.start_time + eff_dist / std::max(parsed_mat.det_vel, 100.0f);
                                                if (t_arr < min_t_arr) min_t_arr = t_arr;
                                            }
                                            p.t_arrival = min_t_arr;
                                            if (min_t_arr <= 0.0f && has_immediate) {
                                                p.lambda = 1.0f;
                                                p.e_int = parsed_mat.detonation_energy;
                                                float p_init = Blast::JWL::computeJWLProductPressure(p.V0 > 0.0f ? p.V / p.V0 : 1.0f, parsed_mat.detonation_energy, parsed_mat.jwl_A, parsed_mat.jwl_B, parsed_mat.jwl_R1, parsed_mat.jwl_R2, parsed_mat.jwl_omega, parsed_mat.density);
                                                for (int r = 0; r < 3; ++r)
                                                    for (int c = 0; c < 3; ++c)
                                                        p.sigma[r][c] = (r == c) ? -p_init : 0.0f;
                                                ignited_count++;
                                            } else {
                                                p.lambda = 0.0f;
                                                p.e_int = 0.0f;
                                            }
                                        } else {
                                            p.t_arrival = 1.0e10f;
                                            p.lambda = 0.0f;
                                        }
                                    } else if (is_crest && !triggers_3d.empty()) {
                                        bool in_trigger_core = false;
                                        for (const auto& trig : triggers_3d) {
                                            if (trig.start_time > 0.0f) continue;
                                            float d_x = p.x[0] - trig.x;
                                            float d_y = p.x[1] - trig.y;
                                            float d_z = p.x[2] - trig.z;
                                            float dist = std::sqrt(d_x * d_x + d_y * d_y + d_z * d_z);
                                            float effective_init_rad = std::max(trig.radius, 2.5f * dx);
                                            if (dist <= effective_init_rad) {
                                                in_trigger_core = true;
                                                break;
                                            }
                                        }
                                        if (in_trigger_core) {
                                            ignited_count++;
                                            p.s_shock = (parsed_mat.crest_awe_c0 > 0.0f) ? std::max(0.02f, 2.0f * parsed_mat.crest_awe_c13) : 1.5f * parsed_mat.crest_s_threshold;
                                            p.lambda = 1.0f;
                                            p.e_int = std::max(parsed_mat.davis_q_det, static_cast<float>(get_json_double(obj, "detonation_energy", 4.29e6)));
                                            p.v_min = (parsed_mat.davis_vc > 0.1f) ? parsed_mat.davis_vc : 0.70f;
                                            p.V = p.v_min * p.V0;
                                            float p_init = ((parsed_mat.davis_pc > 1.0e6f) ? parsed_mat.davis_pc : 15.0e9f);
                                            for (int r = 0; r < 3; ++r) {
                                                for (int c = 0; c < 3; ++c) {
                                                    p.sigma[r][c] = (r == c) ? -p_init : 0.0f;
                                                }
                                            }
                                        } else {
                                            p.s_shock = 0.0f;
                                            p.lambda = 0.0f;
                                            p.e_int = 0.0f;
                                            p.v_min = 1.0f;
                                        }
                                    } else if (is_lee_tarver && !triggers_3d.empty()) {
                                        bool in_trigger_core = false;
                                        for (const auto& trig : triggers_3d) {
                                            if (trig.start_time > 0.0f) continue;
                                            float d_x = p.x[0] - trig.x;
                                            float d_y = p.x[1] - trig.y;
                                            float d_z = p.x[2] - trig.z;
                                            float dist = std::sqrt(d_x * d_x + d_y * d_y + d_z * d_z);
                                            float effective_init_rad = std::max(trig.radius, 2.5f * dx);
                                            if (dist <= effective_init_rad) {
                                                in_trigger_core = true;
                                                break;
                                            }
                                        }
                                        if (in_trigger_core) {
                                            ignited_count++;
                                            p.lambda = 1.0f;
                                            p.e_int = parsed_mat.detonation_energy;
                                            float p_init = 20.0e9f;
                                            for (int r = 0; r < 3; ++r) {
                                                for (int c = 0; c < 3; ++c) {
                                                    p.sigma[r][c] = (r == c) ? -p_init : 0.0f;
                                                }
                                            }
                                        } else {
                                            p.lambda = 0.0f;
                                            p.e_int = 0.0f;
                                        }
                                    }
                                }
                            }
                            if (is_explosive) {
                                if (triggers_3d.empty() && !is_predetonated) {
                                    std::cerr << "[BlastSolver] [WARNING] Object " << obj_idx << " is an energetic material (" << mat_model_str
                                              << "), but NO triggers/detonators were provided or connected!" << std::endl;
                                    emit_kernel_log("WARNING", "Object " + std::to_string(obj_idx) + " is an energetic material (" + mat_model_str + "), but NO TriggerLocation3D / DetonatorLocation3D was connected to MPM Domain!", 0.0, "mpm_3d");
                                } else if (is_jwl_prog) {
                                    std::cout << "[BlastSolver] Object " << obj_idx << " (" << mat_model_str
                                              << "): Programmed detonation wavefront precalculated from " << triggers_3d.size() << " detonator(s)." << std::endl;
                                    emit_kernel_log("SYSTEM", "Object " + std::to_string(obj_idx) + " (" + mat_model_str + "): Programmed wavefront arrival initialized across particles.", 0.0, "mpm_3d");
                                } else if (ignited_count == 0 && !is_predetonated) {
                                    bool has_delayed = false;
                                    for (const auto& trig : triggers_3d) {
                                        if (trig.start_time > 0.0f) { has_delayed = true; break; }
                                    }
                                    if (has_delayed) {
                                        std::cout << "[BlastSolver] Object " << obj_idx << " (" << mat_model_str
                                                  << "): Delayed detonator registered (start_time > 0.0s). Hotspot will trigger dynamically at scheduled delay." << std::endl;
                                        emit_kernel_log("SYSTEM", "Object " + std::to_string(obj_idx) + " (" + mat_model_str + "): Delayed detonator registered. Initiation will occur at specified time delay.", 0.0, "mpm_3d");
                                    } else {
                                        std::cerr << "[BlastSolver] [WARNING] Object " << obj_idx << " (" << mat_model_str
                                                  << "): Trigger did NOT intersect any particles! 0 particles ignited. Check trigger (x,y,z) vs object position." << std::endl;
                                        emit_kernel_log("WARNING", "Object " + std::to_string(obj_idx) + ": Trigger did NOT intersect any particles (0 ignited). Check trigger coordinates vs explosive body.", 0.0, "mpm_3d");
                                    }
                                } else {
                                    std::cout << "[BlastSolver] Object " << obj_idx << " (" << mat_model_str
                                              << "): Trigger hotspot initialized on " << ignited_count << " particles." << std::endl;
                                    emit_kernel_log("SYSTEM", "Object " + std::to_string(obj_idx) + " (" + mat_model_str + "): Hotspot ignited " + std::to_string(ignited_count) + " particles.", 0.0, "mpm_3d");
                                }
                            }
                        }

                    } else {
                        if (global_solver_mpm_3d_cuda) {
                            global_solver_mpm_3d_cuda->addBoxObject(1, 0.5f, 0.5f, 0.5f, 0.2f, 0.2f, 0.2f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 7850.0f, 210.0e9f, 0.3f, 400.0e6f, 1.0e9f, 0.25f, 600.0e6f, domain_ppc);
                        } else {
                            global_solver_mpm_3d->addBoxObject(1, 0.5f, 0.5f, 0.5f, 0.2f, 0.2f, 0.2f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 7850.0f, 210.0e9f, 0.3f, 400.0e6f, 1.0e9f, 0.25f, 600.0e6f, domain_ppc);
                        }
                    }

                    // Material-based / Coupler-based contact mapping (hybrid Bardenhagen Multi-Velocity + Single-Velocity Bonded Groups)
                    std::vector<int> obj_to_mat;
                    int num_unique_materials = build_mpm_object_material_mapping(msg, obj_to_mat);

                    if (global_solver_mpm_3d_cuda) {
                        global_solver_mpm_3d_cuda->setContactMethod(contact_method);
                        global_solver_mpm_3d_cuda->setInitialContactTie(msg.value("bardenhagen_initial_tie", true));
                        global_solver_mpm_3d_cuda->setObjectMaterialMapping(obj_to_mat, num_unique_materials);
                    } else {
                        global_solver_mpm_3d->setContactMethod(contact_method);
                        global_solver_mpm_3d->setInitialContactTie(msg.value("bardenhagen_initial_tie", true));
                        global_solver_mpm_3d->setObjectMaterialMapping(obj_to_mat, num_unique_materials);
                    }

                    // Phase 5: Single synchronized upload of material tables and all particles to GPU
                    if (global_solver_mpm_3d_cuda) {
                        global_solver_mpm_3d_cuda->uploadMaterialTableToDevice();
                        global_solver_mpm_3d_cuda->syncToDevice();
                    } else {
                        global_solver_mpm_3d->particleToGrid();
                    }

                    init_gauges(msg);
                    emit_telemetry_mpm_3d(0.0, false);
                    size_t n_p = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getParticles().size() : global_solver_mpm_3d->getParticles().size();
                    std::string cm_name = (contact_method == Blast::MPMContactMethod::MultiVelocityBardenhagen) ? ("Multi-Velocity (Bardenhagen, " + std::to_string(num_unique_materials) + " mats)") : ((contact_method == Blast::MPMContactMethod::SubGridDEM) ? "Discrete Element (DEM)" : "Single-Velocity");
                    std::string init_log = "3D MPM Solver Initialized (" + std::to_string(n_p) + " particles, PPC=" + std::to_string(domain_ppc) + ", Contact=" + cm_name + ", Device=" + (is_cuda_device(device) ? "CUDA GPU" : "CPU") + ")";
                    emit_kernel_log("SYSTEM", init_log, 0.0, "mpm_3d");
                } catch (const std::exception& e) {
                    std::cerr << "[ERROR] Exception in INIT_MPM_3D: " << e.what() << std::endl;
                    emit_kernel_log("ERROR", std::string("3D MPM initialization failed: ") + e.what(), 0.0, "mpm_3d");
                    std::exit(1);
                } catch (...) {
                    std::cerr << "[ERROR] Unknown exception in INIT_MPM_3D" << std::endl;
                    emit_kernel_log("ERROR", "3D MPM initialization failed with unknown error", 0.0, "mpm_3d");
                    std::exit(1);
                }
            } else if (command == "STEP_MPM_3D" || command == "STEP_3D_MPM") {
                    if (!global_solver_mpm_3d && !global_solver_mpm_3d_cuda) continue;
                    int steps = get_json_int(msg, "steps", 1);
                    global_cfl_mpm_3d = static_cast<float>(get_json_double(msg, "cfl", 0.6));
                    if (msg.contains("endtime")) global_endtime_mpm_3d = msg.value("endtime", 1.0);
                    global_exec_until_end_mpm_3d = false;
                    if (!sim_mpm_3d_running) {
                        global_target_steps_mpm_3d = steps;
                        sim_mpm_3d_running = true;
                        sim_mpm_3d_paused = false;
                        sim_mpm_3d_terminate = false;
                        std::thread(worker_mpm_3d_thread_func).detach();
                    } else {
                        global_target_steps_mpm_3d.fetch_add(steps);
                        sim_mpm_3d_paused = false;
                    }

                } else if (command == "EXEC_ALL_MPM_3D") {
                    if (!global_solver_mpm_3d && !global_solver_mpm_3d_cuda) continue;
                    global_cfl_mpm_3d = static_cast<float>(get_json_double(msg, "cfl", 0.6));
                    if (msg.contains("endtime")) global_endtime_mpm_3d = msg.value("endtime", 1.0);
                    global_exec_until_end_mpm_3d = true;
                    if (!sim_mpm_3d_running) {
                        sim_mpm_3d_running = true;
                        sim_mpm_3d_paused = false;
                        sim_mpm_3d_terminate = false;
                        std::thread(worker_mpm_3d_thread_func).detach();
                    } else {
                        sim_mpm_3d_paused = false;
                    }

                } else if (command == "PAUSE_MPM_3D") {
                    sim_mpm_3d_paused = true;
                    global_target_steps_mpm_3d = 0;

                } else if (command == "RESUME_MPM_3D") {
                    sim_mpm_3d_paused = false;

                } else if (command == "TERMINATE_MPM_3D") {
                    sim_mpm_3d_terminate = true;
                    while (sim_mpm_3d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_mpm_3d.reset();
                    global_solver_mpm_3d_cuda.reset();
                } else if (command == "INIT_FSI_2D" || command == "INIT_FSI") {
                    try {
                        sim2d_terminate = true;
                    while (sim2d_running.load() || sim_fsi_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_2d.reset();
                    global_solver_2d_cuda.reset();
                    global_solver_mpm_2d.reset();
                    sim2d_terminate = false;
                    sim2d_paused = false;
                    sim_fsi_terminate = false;
                    sim_fsi_paused = false;
                    step_progress_2d = 0;
                    global_step_2d = 0;
                    global_step_fsi_2d = 0;
                    global_endtime_fsi = msg.value("endtime", 1.0);
                    global_wallclock_2d = 0.0;

                    int nr = get_json_int(msg, "nr", get_json_int(msg, "nx", 128));
                    int nz = get_json_int(msg, "nz", get_json_int(msg, "ny", 128));
                    double max_r = get_json_double(msg, "max_r", get_json_double(msg, "max_x", 1.0));
                    double max_z = get_json_double(msg, "max_z", get_json_double(msg, "max_y", 1.0));
                    double gamma = get_json_double(msg, "gamma", 1.4);
                    std::string flux_scheme = msg.value("flux_scheme", "AUSM+");
                    int spatial_order = 2;
                    int temporal_order = 2;
                    parse_cfd_space_time_scheme(msg, spatial_order, temporal_order, 2);
                    std::string coord_sys = msg.value("coordinate_system", "Axisymmetric");

                    std::string bc_r_min_str = msg.value("bc_r_min", "Reflecting");
                    std::string bc_r_max_str = msg.value("bc_r_max", "Terminate");
                    std::string bc_z_min_str = msg.value("bc_z_min", "Reflecting");
                    std::string bc_z_max_str = msg.value("bc_z_max", "Terminate");

                    auto map_bc_2d = [](const std::string& str) -> CFDSolver2D::BCType {
                        if (str == "Transmitting" || str == "transmitting" || str == "TRANSMISSIVE" || str == "transmissive") {
                            return CFDSolver2D::TRANSMISSIVE;
                        } else if (str == "Riemann" || str == "riemann" || str == "Terminate" || str == "terminate" || str == "OUTFLOW_RIEMANN" || str == "outflow_riemann") {
                            return CFDSolver2D::OUTFLOW_RIEMANN;
                        } else {
                            return CFDSolver2D::REFLECTIVE;
                        }
                    };

                    CFDSolver2D::BCType r_min_bc = map_bc_2d(bc_r_min_str);
                    CFDSolver2D::BCType r_max_bc = map_bc_2d(bc_r_max_str);
                    CFDSolver2D::BCType z_min_bc = map_bc_2d(bc_z_min_str);
                    CFDSolver2D::BCType z_max_bc = map_bc_2d(bc_z_max_str);

                    MultiMat::MaterialSet matSet = parseMaterialSet(msg);

                    global_solver_2d = std::make_unique<CFDSolver2DImpl<double>>(nr, nz, max_r, max_z, gamma);
                    global_solver_2d->setFluxScheme(flux_scheme);
                    global_solver_2d->setSpatialOrder(spatial_order);
                    global_solver_2d->setTemporalOrder(temporal_order);
                    global_solver_2d->setBCTypes(r_min_bc, r_max_bc, z_min_bc, z_max_bc);
                    global_solver_2d->setMaterialParameters(matSet);
                    global_solver_2d->setCoordinateSystemCartesian(coord_sys == "Cartesian");

                    global_t2d = 0.0;
                    global_dt_2d = 0.0;
                    double explosive_r = msg.value("charge_r", msg.value("explosive_r", 0.0));
                    double explosive_z = msg.value("charge_z", msg.value("explosive_z", 0.1));
                    double high_rho = msg.value("high_rho", msg.value("rho", 1630.0));
                    double ambient_rho = msg.value("ambient_rho", 1.225);
                    double ambient_p = msg.value("atm_pressure", msg.value("ambient_p", 101325.0));
                    double explosive_radius = msg.value("charge_radius", msg.value("explosive_radius", 0.1));

                    std::string init_mode_fsi = msg.value("init_mode", "Multi-Material JWL");
                    if (init_mode_fsi == "From1D") {
                        std::lock_guard<std::mutex> rlock(g_pending_remap_mutex);
                        if (g_pending_remap.has_pending && g_pending_remap.type == "1D") {
                            apply_remap_payload(g_pending_remap.msg, "1D", nullptr, global_solver_2d.get(), nullptr);
                            g_pending_remap.has_pending = false;
                        }
                    } else if (init_mode_fsi == "Ideal Gas" || msg.value("explosive_type", "") == "MaterialIdealGas") {
                        double det_energy = msg.value("detonation_energy", 4520000.0);
                        double detonator_r = get_json_double(msg, "trigger_r", get_json_double(msg, "detonator_r", explosive_r));
                        double detonator_z = get_json_double(msg, "trigger_z", get_json_double(msg, "detonator_z", explosive_z));
                        double detonator_delay = get_json_double(msg, "time_delay", get_json_double(msg, "start_time", get_json_double(msg, "detonator_time", 0.0)));
                        global_solver_2d->setDetonatorLocation(detonator_r, detonator_z, detonator_delay);
                        global_solver_2d->setInitialConditionIdealGas(explosive_z, explosive_radius, high_rho, det_energy, ambient_rho, ambient_p, explosive_r);
                    } else {
                        std::string charge_shape = msg.value("charge_shape", "Sphere");
                        if (charge_shape == "Cylinder" || charge_shape == "cylinder") {
                            double charge_radius = msg.value("charge_radius", 0.1);
                            double charge_height = msg.value("charge_height", 0.2);
                            if (msg.contains("charge_aspect_ratio") && !msg.contains("charge_height")) {
                                double ar = msg.value("charge_aspect_ratio", 1.0);
                                if (ar > 0.0) charge_height = 2.0 * charge_radius * ar;
                            }
                            double detonator_r = get_json_double(msg, "trigger_r", get_json_double(msg, "detonator_r", explosive_r));
                            double detonator_z = get_json_double(msg, "trigger_z", get_json_double(msg, "detonator_z", explosive_z + charge_height / 2.0));
                            double detonator_delay = get_json_double(msg, "time_delay", get_json_double(msg, "start_time", get_json_double(msg, "detonator_time", 0.0)));
                            global_solver_2d->setDetonatorLocation(detonator_r, detonator_z, detonator_delay);
                            global_solver_2d->setInitialConditionTNTCylinder(explosive_z, charge_radius, charge_height, high_rho, ambient_rho, ambient_p, explosive_r);
                        } else {
                            double detonator_r = get_json_double(msg, "trigger_r", get_json_double(msg, "detonator_r", explosive_r));
                            double detonator_z = get_json_double(msg, "trigger_z", get_json_double(msg, "detonator_z", explosive_z));
                            double detonator_delay = get_json_double(msg, "time_delay", get_json_double(msg, "start_time", get_json_double(msg, "detonator_time", 0.0)));
                            global_solver_2d->setDetonatorLocation(detonator_r, detonator_z, detonator_delay);
                            global_solver_2d->setInitialConditionTNT(explosive_z, explosive_radius, high_rho, ambient_rho, ambient_p, explosive_r);
                        }
                    }
                    apply_obstacles_2d(msg, nr, nz, max_r, max_z);
                    solver2d_initialized = true;

                    global_solver_mpm_2d = std::make_unique<Blast::MPMSolver2D>();
                    float dx = static_cast<float>(max_r / nr);
                    float dy = static_cast<float>(max_z / nz);
                    global_solver_mpm_2d->initializeGrid(nr, nz, dx, dy);
                    global_solver_mpm_2d->setBoundaryConditions(
                        parse_bc_mpm2d(msg.value("bc_r_min", msg.value("bc_x_min", "FreeSlip"))),
                        parse_bc_mpm2d(msg.value("bc_r_max", msg.value("bc_x_max", "Transmitting"))),
                        parse_bc_mpm2d(msg.value("bc_z_min", msg.value("bc_y_min", "FreeSlip"))),
                        parse_bc_mpm2d(msg.value("bc_z_max", msg.value("bc_y_max", "Transmitting")))
                    );

                    std::string transfer_scheme = msg.value("transfer_scheme", "BSpline");
                    std::string velocity_scheme = msg.value("velocity_scheme", "APIC");
                    std::string space_time_scheme = msg.value("space_time_scheme", "Leapfrog");
                    global_solver_mpm_2d->setTransferScheme(parseTransferScheme(transfer_scheme));
                    auto st_2d_fsi = (space_time_scheme == "RK2") ? Blast::MPMTimeIntegrationScheme::RK2 :
                                     ((space_time_scheme == "USF") ? Blast::MPMTimeIntegrationScheme::USF :
                                     ((space_time_scheme == "USL") ? Blast::MPMTimeIntegrationScheme::USL : Blast::MPMTimeIntegrationScheme::Leapfrog));
                    global_solver_mpm_2d->setTimeScheme(st_2d_fsi);
                    if (velocity_scheme == "PIC") {
                        global_solver_mpm_2d->setVelocityScheme(Blast::MPMVelocityScheme::PIC);
                    } else if (velocity_scheme == "FLIP") {
                        global_solver_mpm_2d->setVelocityScheme(Blast::MPMVelocityScheme::FLIP);
                    } else {
                        global_solver_mpm_2d->setVelocityScheme(Blast::MPMVelocityScheme::APIC);
                    }

                    int domain_ppc = get_json_int(msg, "ppc", 4);
                    std::string domain_p_dist_str = msg.value("particle_distribution", "Cartesian");
                    std::string domain_b_fill_str = msg.value("boundary_filling", "Stairstepped");

                    if (msg.contains("mpm_objects") && msg["mpm_objects"].is_array()) {
                        int obj_idx = 0;
                        for (const auto& obj : msg["mpm_objects"]) {
                            obj_idx++;
                            std::string shape = obj.value("shape_type", "Rectangle");
                            float pos_x = static_cast<float>(get_json_double(obj, "pos_x", 0.5));
                            float pos_y = static_cast<float>(get_json_double(obj, "pos_y", 0.5));
                            float vel_x = static_cast<float>(get_json_double(obj, "vel_x", 0.0));
                            float vel_y = static_cast<float>(get_json_double(obj, "vel_y", 0.0));
                            float angular_vel = static_cast<float>(get_json_double(obj, "angular_vel", 0.0));
                            float density = static_cast<float>(get_json_double(obj, "density", 7850.0));
                            float E = static_cast<float>(get_json_double(obj, "youngs_modulus", 210.0e9));
                            float nu = static_cast<float>(get_json_double(obj, "poissons_ratio", 0.3));
                            float yield_stress = static_cast<float>(get_json_double(obj, "yield_stress", 400.0e6));
                            float hardening = static_cast<float>(get_json_double(obj, "hardening_modulus", 1.0e9));
                            float failure_strain = static_cast<float>(get_json_double(obj, "failure_strain", 0.25));
                            float tensile_failure_stress = static_cast<float>(get_json_double(obj, "tensile_failure_stress", 600.0e6));
                            int ppc = std::max(1, get_json_int(obj, "ppc", domain_ppc));

                            std::string p_dist_str = obj.value("particle_distribution", domain_p_dist_str);
                            Blast::MPMParticleDistribution particle_dist = Blast::MPMParticleDistribution::Cartesian;
                            if (p_dist_str == "Hexagonal") {
                                particle_dist = Blast::MPMParticleDistribution::Hexagonal;
                            }

                            std::string b_fill_str = obj.value("boundary_filling", domain_b_fill_str);
                            Blast::MPMBoundaryFilling boundary_fill = Blast::MPMBoundaryFilling::Stairstepped;
                            if (b_fill_str == "Partial") {
                                boundary_fill = Blast::MPMBoundaryFilling::Partial;
                            }

                            std::string mat_model_str = obj.value("material_model", "Hypoelastic");
                            Blast::MPMMaterialModel mat_model = parseMPMMaterialModel(mat_model_str);

                            float jc_A = static_cast<float>(get_json_double(obj, "jc_A", 792.0e6));
                            float jc_B = static_cast<float>(get_json_double(obj, "jc_B", 510.0e6));
                            float jc_n = static_cast<float>(get_json_double(obj, "jc_n", 0.26));
                            float jc_C = static_cast<float>(get_json_double(obj, "jc_C", 0.014));
                            float jc_m = static_cast<float>(get_json_double(obj, "jc_m", 1.03));
                            float T_melt = static_cast<float>(get_json_double(obj, "T_melt", 1793.0));
                            float T_room = static_cast<float>(get_json_double(obj, "T_room", 293.0));
                            float Cp = static_cast<float>(get_json_double(obj, "Cp", 477.0));
                            float mg_gamma0 = static_cast<float>(get_json_double(obj, "mg_gamma0", 1.81));
                            float mg_c0 = static_cast<float>(get_json_double(obj, "mg_c0", 4570.0));
                            float mg_s = static_cast<float>(get_json_double(obj, "mg_s", 1.49));

                            std::string solid_str = obj.value("solid_model", "");
                            std::string burn_str = obj.value("burn_model", "");
                            std::string prod_str = obj.value("product_model", "");
                            Blast::SolidReactantEOS solid_model = Blast::SolidReactantEOS::MieGruneisen;
                            Blast::ReactionKinetics burn_model = Blast::ReactionKinetics::ProgrammedBurn;
                            Blast::DetonationProductEOS product_model = Blast::DetonationProductEOS::JWLProductGas;
                            if (mat_model == Blast::MPMMaterialModel::CRESTReactiveBurn) {
                                solid_model = Blast::SolidReactantEOS::DavisSolid;
                                burn_model = Blast::ReactionKinetics::CRESTEntropy;
                                product_model = Blast::DetonationProductEOS::DavisProduct;
                            } else if (mat_model == Blast::MPMMaterialModel::LeeTarverIgnitionGrowth) {
                                solid_model = Blast::SolidReactantEOS::MieGruneisen;
                                burn_model = Blast::ReactionKinetics::LeeTarverODE;
                                product_model = Blast::DetonationProductEOS::JWLProductGas;
                            }
                            if (!solid_str.empty()) {
                                if (solid_str.find("Davis") != std::string::npos) solid_model = Blast::SolidReactantEOS::DavisSolid;
                                else if (solid_str.find("Mie") != std::string::npos || solid_str.find("Gruneisen") != std::string::npos || solid_str.find("Grüneisen") != std::string::npos) solid_model = Blast::SolidReactantEOS::MieGruneisen;
                            }
                            if (!burn_str.empty()) {
                                if (burn_str.find("CREST") != std::string::npos) burn_model = Blast::ReactionKinetics::CRESTEntropy;
                                else if (burn_str.find("Lee-Tarver") != std::string::npos || burn_str.find("LeeTarver") != std::string::npos || burn_str.find("ODE") != std::string::npos) burn_model = Blast::ReactionKinetics::LeeTarverODE;
                                else if (burn_str.find("Programmed") != std::string::npos || burn_str.find("Wavefront") != std::string::npos) burn_model = Blast::ReactionKinetics::ProgrammedBurn;
                            }
                            if (!prod_str.empty()) {
                                if (prod_str.find("Davis") != std::string::npos) product_model = Blast::DetonationProductEOS::DavisProduct;
                                else if (prod_str.find("JWL") != std::string::npos) product_model = Blast::DetonationProductEOS::JWLProductGas;
                            }

                            float jwl_A = static_cast<float>(get_json_double(obj, "jwl_A", 373.77e9));
                            float jwl_B = static_cast<float>(get_json_double(obj, "jwl_B", 3.747e9));
                            float jwl_R1 = static_cast<float>(get_json_double(obj, "jwl_R1", 4.15));
                            float jwl_R2 = static_cast<float>(get_json_double(obj, "jwl_R2", 0.90));
                            float jwl_omega = static_cast<float>(get_json_double(obj, "jwl_omega", 0.35));
                            float det_vel = static_cast<float>(get_json_double(obj, "det_vel", 6930.0));
                            float detonation_energy = static_cast<float>(get_json_double(obj, "detonation_energy", 4.29e6));
                            int burn_zone_cells = get_json_int(obj, "burn_zone_cells", 4);
                            float tau_burn_min = static_cast<float>(get_json_double(obj, "tau_burn_min", 1.0e-7));

                            float lt_I = static_cast<float>(get_json_double(obj, "lt_I", 4.0e6));
                            float lt_a = static_cast<float>(get_json_double(obj, "lt_a", 0.24));
                            float lt_b = static_cast<float>(get_json_double(obj, "lt_b", 0.667));
                            float lt_x = static_cast<float>(get_json_double(obj, "lt_x", 7.0));
                            float lt_G1 = static_cast<float>(get_json_double(obj, "lt_G1", 130.0e-6));
                            float lt_c = static_cast<float>(get_json_double(obj, "lt_c", 0.667));
                            float lt_d = static_cast<float>(get_json_double(obj, "lt_d", 0.333));
                            float lt_y = static_cast<float>(get_json_double(obj, "lt_y", 2.0));
                            float lt_G2 = static_cast<float>(get_json_double(obj, "lt_G2", 400.0e-6));
                            float lt_e = static_cast<float>(get_json_double(obj, "lt_e", 0.333));
                            float lt_g = static_cast<float>(get_json_double(obj, "lt_g", 0.667));
                            float lt_z = static_cast<float>(get_json_double(obj, "lt_z", 3.0));
                            float lt_ig_max = static_cast<float>(get_json_double(obj, "lt_ig_max", get_json_double(obj, "lt_F_ig_max", 0.02)));
                            float lt_growth_max = static_cast<float>(get_json_double(obj, "lt_growth_max", get_json_double(obj, "lt_F_G1_max", 0.50)));
                            float lt_comp_min = static_cast<float>(get_json_double(obj, "lt_comp_min", get_json_double(obj, "lt_F_G2_min", 0.50)));

                            float davis_c0 = static_cast<float>(get_json_double(obj, "davis_c0", 2050.0));
                            float davis_s1 = static_cast<float>(get_json_double(obj, "davis_s1", 2.12));
                            float davis_gamma0 = static_cast<float>(get_json_double(obj, "davis_gamma0", 0.65));
                            float davis_cv = static_cast<float>(get_json_double(obj, "davis_cv", 1000.0));
                            float davis_t0 = static_cast<float>(get_json_double(obj, "davis_t0", 293.0));
                            float davis_rho0 = static_cast<float>(get_json_double(obj, "davis_rho0", 1895.0));

                            float davis_a = static_cast<float>(get_json_double(obj, "davis_a", 2.85));
                            float davis_b = static_cast<float>(get_json_double(obj, "davis_b", 1.10));
                            float davis_k = static_cast<float>(get_json_double(obj, "davis_k", 1.35));
                            float davis_vc = static_cast<float>(get_json_double(obj, "davis_vc", 0.65));
                            float davis_pc = static_cast<float>(get_json_double(obj, "davis_pc", 12.5e9));
                            float davis_q_det = static_cast<float>(get_json_double(obj, "davis_q_det", 3.90e6));

                            float crest_b1 = static_cast<float>(get_json_double(obj, "crest_b1", 1.2e7));
                            float crest_c1 = static_cast<float>(get_json_double(obj, "crest_c1", 0.67));
                            float crest_m1 = static_cast<float>(get_json_double(obj, "crest_m1", 2.5));
                            float crest_b2 = static_cast<float>(get_json_double(obj, "crest_b2", 3.5e6));
                            float crest_c2 = static_cast<float>(get_json_double(obj, "crest_c2", 0.50));
                            float crest_c3 = static_cast<float>(get_json_double(obj, "crest_c3", 0.67));
                            float crest_m2 = static_cast<float>(get_json_double(obj, "crest_m2", 1.5));
                            float crest_s0 = static_cast<float>(get_json_double(obj, "crest_s0", 100.0));
                            float crest_s_threshold = static_cast<float>(get_json_double(obj, "crest_s_threshold", 45.0));
                            float crest_awe_K0s = static_cast<float>(get_json_double(obj, "crest_awe_K0s", 14245250000.0));
                            float crest_awe_A1 = static_cast<float>(get_json_double(obj, "crest_awe_A1", 2.417494));
                            float crest_awe_A2 = static_cast<float>(get_json_double(obj, "crest_awe_A2", 2.208027));
                            float crest_awe_A3 = static_cast<float>(get_json_double(obj, "crest_awe_A3", 0.0));
                            float crest_awe_B1 = static_cast<float>(get_json_double(obj, "crest_awe_B1", 0.0));
                            float crest_awe_B2 = static_cast<float>(get_json_double(obj, "crest_awe_B2", 0.0));
                            float crest_awe_B3 = static_cast<float>(get_json_double(obj, "crest_awe_B3", 0.0));
                            float crest_awe_fc = static_cast<float>(get_json_double(obj, "crest_awe_fc", 0.0));
                            float crest_awe_delta = static_cast<float>(get_json_double(obj, "crest_awe_delta", 0.0));
                            float crest_awe_Gamma1 = static_cast<float>(get_json_double(obj, "crest_awe_Gamma1", 32.33557));
                            float crest_awe_Gamma2 = static_cast<float>(get_json_double(obj, "crest_awe_Gamma2", 3.596933));
                            float crest_awe_gamma00 = static_cast<float>(get_json_double(obj, "crest_awe_gamma00", 0.4));
                            float crest_awe_m = static_cast<float>(get_json_double(obj, "crest_awe_m", 2.0));
                            float crest_awe_c0 = static_cast<float>(get_json_double(obj, "crest_awe_c0", 0.0));
                            float crest_awe_c1 = static_cast<float>(get_json_double(obj, "crest_awe_c1", 2.0));
                            float crest_awe_c2 = static_cast<float>(get_json_double(obj, "crest_awe_c2", 220000000.0));
                            float crest_awe_c3 = static_cast<float>(get_json_double(obj, "crest_awe_c3", 2.5));
                            float crest_awe_c6 = static_cast<float>(get_json_double(obj, "crest_awe_c6", 0.0));
                            float crest_awe_c8 = static_cast<float>(get_json_double(obj, "crest_awe_c8", 0.00016));
                            float crest_awe_c9 = static_cast<float>(get_json_double(obj, "crest_awe_c9", 1.0));
                            float crest_awe_c10 = static_cast<float>(get_json_double(obj, "crest_awe_c10", 400000.0));
                            float crest_awe_c11 = static_cast<float>(get_json_double(obj, "crest_awe_c11", 1.8));
                            float crest_awe_c12 = static_cast<float>(get_json_double(obj, "crest_awe_c12", 0.0));
                            float crest_awe_c13 = static_cast<float>(get_json_double(obj, "crest_awe_c13", 0.0));

                            bool enable_het = get_json_bool(obj, "enable_heterogeneity", false);
                            float weibull_modulus = static_cast<float>(get_json_double(obj, "weibull_modulus", 0.0));
                            if (weibull_modulus > 0.001f) enable_het = true;
                            float weibull_scale = static_cast<float>(get_json_double(obj, "weibull_scale", 1.0));
                            float weibull_ref_volume = static_cast<float>(get_json_double(obj, "weibull_ref_volume", 1.0e-4));

                            bool enable_aniso = get_json_bool(obj, "enable_anisotropy", false);
                            float aniso_ratio = static_cast<float>(get_json_double(obj, "anisotropy_ratio", 1.0));
                            float aniso_dir_x = static_cast<float>(get_json_double(obj, "anisotropy_dir_x", 1.0));
                            float aniso_dir_y = static_cast<float>(get_json_double(obj, "anisotropy_dir_y", 0.0));

                            if (shape == "Circle") {
                                float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
                                global_solver_mpm_2d->addCircleObject(obj_idx, pos_x, pos_y, radius, vel_x, vel_y, angular_vel, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill);
                            } else {
                                float size_x = static_cast<float>(get_json_double(obj, "size_x", 0.2));
                                float size_y = static_cast<float>(get_json_double(obj, "size_y", 0.2));
                                global_solver_mpm_2d->addRectangleObject(obj_idx, pos_x, pos_y, size_x, size_y, vel_x, vel_y, angular_vel, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill);
                            }

                            for (auto& p : global_solver_mpm_2d->getParticles()) {
                                if (p.object_id == obj_idx) {
                                    p.material_model = mat_model;
                                    p.jc_A = jc_A;
                                    p.jc_B = jc_B;
                                    p.jc_n = jc_n;
                                    p.jc_C = jc_C;
                                    p.jc_m = jc_m;
                                    p.T_melt = T_melt;
                                    p.T_room = T_room;
                                    p.Cp = Cp;
                                    p.mg_gamma0 = mg_gamma0;
                                    p.mg_c0 = mg_c0;
                                    p.mg_s = mg_s;
                                    p.solid_model = solid_model;
                                    p.burn_model = burn_model;
                                    p.product_model = product_model;
                                    p.jwl_A = jwl_A;
                                    p.jwl_B = jwl_B;
                                    p.jwl_R1 = jwl_R1;
                                    p.jwl_R2 = jwl_R2;
                                    p.jwl_omega = jwl_omega;
                                    p.det_vel = det_vel;
                                    p.detonation_energy = detonation_energy;
                                    p.burn_zone_cells = burn_zone_cells;
                                    p.tau_burn_min = tau_burn_min;
                                    p.lt_I = lt_I;
                                    p.lt_a = lt_a;
                                    p.lt_b = lt_b;
                                    p.lt_x = lt_x;
                                    p.lt_G1 = lt_G1;
                                    p.lt_c = lt_c;
                                    p.lt_d = lt_d;
                                    p.lt_y = lt_y;
                                    p.lt_G2 = lt_G2;
                                    p.lt_e = lt_e;
                                    p.lt_g = lt_g;
                                    p.lt_z = lt_z;
                                    p.lt_ig_max = lt_ig_max;
                                    p.lt_growth_max = lt_growth_max;
                                    p.lt_comp_min = lt_comp_min;
                                    p.davis_c0 = davis_c0;
                                    p.davis_s1 = davis_s1;
                                    p.davis_gamma0 = davis_gamma0;
                                    p.davis_cv = davis_cv;
                                    p.davis_t0 = davis_t0;
                                    p.davis_rho0 = davis_rho0;
                                    p.davis_a = davis_a;
                                    p.davis_b = davis_b;
                                    p.davis_k = davis_k;
                                    p.davis_vc = davis_vc;
                                    p.davis_pc = davis_pc;
                                    p.davis_q_det = davis_q_det;
                                    p.crest_b1 = crest_b1;
                                    p.crest_c1 = crest_c1;
                                    p.crest_m1 = crest_m1;
                                    p.crest_b2 = crest_b2;
                                    p.crest_c2 = crest_c2;
                                    p.crest_c3 = crest_c3;
                                    p.crest_m2 = crest_m2;
                                    p.crest_s0 = crest_s0;
                                    p.crest_s_threshold = crest_s_threshold;
                                    p.crest_awe_K0s = crest_awe_K0s;
                                    p.crest_awe_A1 = crest_awe_A1;
                                    p.crest_awe_A2 = crest_awe_A2;
                                    p.crest_awe_A3 = crest_awe_A3;
                                    p.crest_awe_B1 = crest_awe_B1;
                                    p.crest_awe_B2 = crest_awe_B2;
                                    p.crest_awe_B3 = crest_awe_B3;
                                    p.crest_awe_fc = crest_awe_fc;
                                    p.crest_awe_delta = crest_awe_delta;
                                    p.crest_awe_Gamma1 = crest_awe_Gamma1;
                                    p.crest_awe_Gamma2 = crest_awe_Gamma2;
                                    p.crest_awe_gamma00 = crest_awe_gamma00;
                                    p.crest_awe_m = crest_awe_m;
                                    p.crest_awe_c0 = crest_awe_c0;
                                    p.crest_awe_c1 = crest_awe_c1;
                                    p.crest_awe_c2 = crest_awe_c2;
                                    p.crest_awe_c3 = crest_awe_c3;
                                    p.crest_awe_c6 = crest_awe_c6;
                                    p.crest_awe_c8 = crest_awe_c8;
                                    p.crest_awe_c9 = crest_awe_c9;
                                    p.crest_awe_c10 = crest_awe_c10;
                                    p.crest_awe_c11 = crest_awe_c11;
                                    p.crest_awe_c12 = crest_awe_c12;
                                    p.crest_awe_c13 = crest_awe_c13;
                                    p.temperature = T_room;
                                    p.e_int = 0.0f;

                                    if (mat_model == Blast::MPMMaterialModel::JWLProgrammedBurn) {
                                        float det_x = static_cast<float>(get_json_double(obj, "detonator_x", get_json_double(msg, "detonator_x", get_json_double(obj, "trigger_x", get_json_double(msg, "trigger_x", 0.5)))));
                                        float det_y = static_cast<float>(get_json_double(obj, "detonator_y", get_json_double(msg, "detonator_y", get_json_double(obj, "trigger_y", get_json_double(msg, "trigger_y", 0.5)))));
                                        float det_r = static_cast<float>(get_json_double(obj, "detonator_radius", get_json_double(msg, "detonator_radius", 0.02)));
                                        float det_t = static_cast<float>(get_json_double(obj, "start_time", get_json_double(msg, "start_time", 0.0)));
                                        float dist = std::sqrt((p.x[0] - det_x)*(p.x[0] - det_x) + (p.x[1] - det_y)*(p.x[1] - det_y));
                                        float eff_dist = std::max(0.0f, dist - det_r);
                                        p.t_arrival = det_t + eff_dist / std::max(det_vel, 100.0f);
                                        if (p.t_arrival <= 0.0f) {
                                            p.lambda = 1.0f;
                                            p.e_int = detonation_energy;
                                        }
                                    }

                                    p.enable_heterogeneity = enable_het;
                                    p.weibull_modulus = weibull_modulus;
                                    p.weibull_scale = weibull_scale;
                                    p.weibull_ref_volume = weibull_ref_volume;
                                    if (enable_het && weibull_modulus > 0.001f) {
                                        p.weibull_factor = Blast::computeWeibullFactor2D(p.x[0], p.x[1], p.V0, weibull_modulus, weibull_scale, weibull_ref_volume);
                                    } else {
                                        p.weibull_factor = 1.0f;
                                    }
                                    p.enable_anisotropy = enable_aniso;
                                    p.anisotropy_ratio = aniso_ratio;
                                    p.anisotropy_dir[0] = aniso_dir_x;
                                    p.anisotropy_dir[1] = aniso_dir_y;
                                }
                            }
                        }
                    } else {
                        global_solver_mpm_2d->addRectangleObject(1, 0.7f, 0.5f, 0.2f, 0.4f, 0.0f, 0.0f, 0.0f, 7850.0f, 210.0e9f, 0.3f, 400.0e6f, 1.0e9f, 0.25f, 600.0e6f, domain_ppc);
                    }

                        global_solver_mpm_2d->particleToGrid();
                        init_gauges(msg);
                        record_gauges_2d(global_t2d);
                        emit_kernel_log("SYSTEM", "2D Coupled FSI Solver (CFD + MPM) Initialized", global_t2d, "2d");
                        emit_telemetry_2d(global_t2d, false);
                    } catch (const std::exception& e) {
                        std::cerr << "[ERROR] Exception in INIT_FSI_2D: " << e.what() << std::endl;
                        emit_kernel_log("ERROR", std::string("FSI 2D initialization failed: ") + e.what(), 0.0, "2d");
                        std::exit(1);
                    } catch (...) {
                        std::cerr << "[ERROR] Unknown exception in INIT_FSI_2D" << std::endl;
                        emit_kernel_log("ERROR", "FSI 2D initialization failed with unknown error", 0.0, "2d");
                        std::exit(1);
                    }
                } else if (command == "STEP_FSI_2D" || command == "STEP_FSI") {
                    int steps = get_json_int(msg, "steps", 1);
                    global_cfl_fsi = static_cast<float>(get_json_double(msg, "cfl", 0.6));
                    if (msg.contains("endtime")) global_endtime_fsi = msg.value("endtime", 1.0);
                    global_exec_until_end_fsi = false;
                    if (!sim_fsi_running) {
                        global_target_steps_fsi = steps;
                        sim_fsi_running = true;
                        sim_fsi_paused = false;
                        sim_fsi_terminate = false;
                        std::thread(worker_fsi_2d_thread_func).detach();
                    } else {
                        global_target_steps_fsi.fetch_add(steps);
                        sim_fsi_paused = false;
                    }
                } else if (command == "EXEC_ALL_FSI_2D" || command == "EXEC_ALL_FSI") {
                    global_cfl_fsi = static_cast<float>(get_json_double(msg, "cfl", 0.6));
                    if (msg.contains("endtime")) global_endtime_fsi = msg.value("endtime", 1.0);
                    global_exec_until_end_fsi = true;
                    if (!sim_fsi_running) {
                        sim_fsi_running = true;
                        sim_fsi_paused = false;
                        sim_fsi_terminate = false;
                        std::thread(worker_fsi_2d_thread_func).detach();
                    } else {
                        sim_fsi_paused = false;
                    }
                } else if (command == "PAUSE_FSI_2D" || command == "PAUSE_FSI") {
                    sim_fsi_paused = true;
                    global_target_steps_fsi = 0;
                } else if (command == "TERMINATE_FSI_2D" || command == "TERMINATE_FSI") {
                    sim_fsi_terminate = true;
                    while (sim_fsi_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_2d.reset();
                    global_solver_mpm_2d.reset();
                    solver2d_initialized = false;
                } else if (command == "INIT_FSI_3D") {
                    try {
                        sim3d_terminate = true;
                    sim_mpm_3d_terminate = true;
                    sim_fsi_3d_terminate = true;
                    while (sim3d_running.load() || sim3d_init_in_progress.load() || sim_mpm_3d_running.load() || sim_fsi_3d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_3d.reset();
                    global_phase_particles_3d.reset();
                    global_solver_mpm_3d.reset();
                    global_solver_mpm_3d_cuda.reset();
                    sim3d_terminate = false;
                    sim3d_paused = false;
                    sim_mpm_3d_terminate = false;
                    sim_mpm_3d_paused = false;
                    sim_fsi_3d_terminate = false;
                    sim_fsi_3d_paused = false;
                    step_progress_3d = 0;
                    global_step_3d = 0;
                    global_step_fsi_3d = 0;
                    global_t3d = 0.0;
                    global_wallclock_3d = 0.0;
                    global_endtime_fsi_3d = msg.value("endtime", 1.0);

                    global_slices_3d.clear();
                    if (msg.contains("slices")) {
                        for (const auto& s_msg : msg["slices"]) {
                            Slice3D s;
                            s.axis = s_msg.value("axis", "xy");
                            s.offset = s_msg.value("offset", 0.5);
                            s.stride = s_msg.value("stride", 1);
                            s.enabled = get_json_bool(s_msg, "enabled", true);
                            if (s.stride < 1) s.stride = 1;
                            if (s_msg.contains("quantities") && s_msg["quantities"].is_array()) {
                                for (const auto& q : s_msg["quantities"]) {
                                    if (q.is_string()) s.quantities.push_back(q.get<std::string>());
                                }
                            } else if (s_msg.contains("quantity") && s_msg["quantity"].is_string()) {
                                s.quantities.push_back(s_msg["quantity"].get<std::string>());
                            }
                            global_slices_3d.push_back(s);
                        }
                    } else {
                        Slice3D s;
                        s.axis = "xy";
                        s.offset = 0.5;
                        s.stride = 1;
                        s.enabled = true;
                        s.quantities.push_back("pressure");
                        global_slices_3d.push_back(s);
                    }
                    if (msg.contains("particle_stride")) {
                        global_mpm_particle_stride = std::max(1, msg.value("particle_stride", 1));
                    } else {
                        global_mpm_particle_stride = 1;
                    }

                    // 1. Initialize CFD 3D solver
                    double cellSize = get_json_double(msg, "cell_size", 0.01);
                    double xmin = get_json_double(msg, "xmin", 0.0);
                    double ymin = get_json_double(msg, "ymin", 0.0);
                    double zmin = get_json_double(msg, "zmin", 0.0);
                    double xmax = get_json_double(msg, "xmax", xmin + 1.0);
                    double ymax = get_json_double(msg, "ymax", ymin + 1.0);
                    double zmax = get_json_double(msg, "zmax", zmin + 1.0);
                    int default_nx = std::max(1, static_cast<int>(std::round((xmax - xmin) / cellSize)));
                    int default_ny = std::max(1, static_cast<int>(std::round((ymax - ymin) / cellSize)));
                    int default_nz = std::max(1, static_cast<int>(std::round((zmax - zmin) / cellSize)));
                    int nx = get_json_int(msg, "nx", default_nx);
                    int ny = get_json_int(msg, "ny", default_ny);
                    int nz = get_json_int(msg, "nz", default_nz);
                    if (nx <= 0) nx = default_nx;
                    if (ny <= 0) ny = default_ny;
                    if (nz <= 0) nz = default_nz;
                    std::string device = msg.value("device", "cpu");
                    std::string precision = msg.value("precision", "single");
                    std::string init_mode = msg.value("init_mode", "Multi-Material JWL");
                    std::string explosive_type = msg.value("explosive_type", "");
                    std::string material_type = msg.value("material_type", "");
                    bool is_ideal_gas_3d = (get_json_bool(msg, "is_ideal_gas", false) || init_mode == "Ideal Gas" || explosive_type == "MaterialIdealGas" || material_type == "Ideal Gas Charge");
                    bool is_multimat = !is_ideal_gas_3d;
                    std::cout << "[DEBUG] INIT_FSI_3D: device=" << device << " init_mode=" << init_mode << " explosive_type=" << explosive_type << " material_type=" << material_type << " is_ideal_gas_3d=" << is_ideal_gas_3d << " is_multimat=" << is_multimat << std::endl;

                    bool is_cuda_cfd = is_cuda_device(device);
                    bool is_double = (precision == "double");
                    auto est_cfd = Blast::estimateCFD3DMemory(nx, ny, nz, is_cuda_cfd, is_double, is_multimat);

                    float mpm_dx = static_cast<float>(cellSize);
                    float mpm_dy = static_cast<float>(cellSize);
                    float mpm_dz = static_cast<float>(cellSize);
                    size_t est_mpm_particles = estimateMPMTotalParticles(msg, mpm_dx, mpm_dy, mpm_dz);
                    auto est_mpm = Blast::estimateMPM3DMemory(nx, ny, nz, est_mpm_particles, is_cuda_cfd);

                    size_t total_ram = est_cfd.ram_bytes + est_mpm.ram_bytes;
                    size_t total_vram = est_cfd.vram_bytes + est_mpm.vram_bytes;
                    Blast::validateMemoryBudget(total_ram, total_vram, is_cuda_cfd, "3D FSI Solver (CFD + MPM)");

                    select_cuda_device(device);
                    if (is_cuda_device(device)) {
                        if (precision == "single" || precision == "float") {
                            if (is_multimat) global_solver_3d = std::make_unique<CFDSolver3DCuda<float, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                            else global_solver_3d = std::make_unique<CFDSolver3DCuda<float, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                        } else {
                            if (is_multimat) global_solver_3d = std::make_unique<CFDSolver3DCuda<double, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                            else global_solver_3d = std::make_unique<CFDSolver3DCuda<double, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                        }
                    } else {
                        if (precision == "single" || precision == "float") {
                            if (is_multimat) global_solver_3d = std::make_unique<CFDSolver3DImpl<float, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                            else global_solver_3d = std::make_unique<CFDSolver3DImpl<float, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                        } else {
                            if (is_multimat) global_solver_3d = std::make_unique<CFDSolver3DImpl<double, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                            else global_solver_3d = std::make_unique<CFDSolver3DImpl<double, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                        }
                    }

                    std::string flux_scheme = msg.value("flux_scheme", "AUSM+");
                    int spatial_order = 2;
                    int temporal_order = 4;
                    parse_cfd_space_time_scheme(msg, spatial_order, temporal_order, 4);

                    global_solver_3d->setFluxScheme(flux_scheme);
                    global_solver_3d->setSpatialOrder(spatial_order);
                    global_solver_3d->setTemporalOrder(temporal_order);
                    apply_cfd_tait_config(msg, global_solver_3d.get());

                    Charge3DParams cp;
                    std::string shape_str = msg.value("charge_shape", "Sphere");
                    if (shape_str == "Sphere") cp.shape_type = 0;
                    else if (shape_str == "Block") cp.shape_type = 1;
                    else cp.shape_type = 2;
                    cp.x = get_json_double(msg, "charge_x", get_json_double(msg, "detonator_x", get_json_double(msg, "trigger_x", 0.0)));
                    cp.y = get_json_double(msg, "charge_y", get_json_double(msg, "detonator_y", get_json_double(msg, "trigger_y", 0.0)));
                    cp.z = get_json_double(msg, "charge_z", get_json_double(msg, "detonator_z", get_json_double(msg, "trigger_z", 0.0)));
                    cp.radius = get_json_double(msg, "charge_radius", 0.1);
                    cp.height = get_json_double(msg, "charge_height", 0.2);
                    if (msg.contains("charge_aspect_ratio") && !msg.contains("charge_height")) {
                        double ar = get_json_double(msg, "charge_aspect_ratio", 1.0);
                        if (ar > 0.0) cp.height = 2.0 * cp.radius * ar;
                    }
                    cp.lx = get_json_double(msg, "charge_lx", 0.1);
                    cp.ly = get_json_double(msg, "charge_ly", 0.1);
                    cp.lz = get_json_double(msg, "charge_lz", 0.1);
                    cp.rot_x = get_json_double(msg, "charge_rot_x", get_json_double(msg, "rot_x", 0.0));
                    cp.rot_y = get_json_double(msg, "charge_rot_y", get_json_double(msg, "rot_y", 0.0));
                    cp.rot_z = get_json_double(msg, "charge_rot_z", get_json_double(msg, "rot_z", 0.0));

                    if (init_mode == "From1D" || init_mode == "From2D") {
                        cp.radius = 0.0;
                        cp.lx = 0.0;
                        cp.ly = 0.0;
                        cp.lz = 0.0;
                    }

                    MultiMat::MaterialSet matSet = parseMaterialSet(msg);
                    double ambient_rho = get_json_double(msg, "ambient_rho", 1.225648589);
                    double ambient_p = get_json_double(msg, "atm_pressure", 101325.0);

                    bool is_stratified_fsi = (init_mode == "Hydrostatic_Stratified_3D" || init_mode == "hydrostatic_stratified_3d" || get_json_bool(msg, "stratified_equilibrium", false));
                    Blast::Stratified3DParams strat_fsi;
                    global_solver_3d->setDetonatorLocation(
                        get_json_double(msg, "trigger_x", get_json_double(msg, "detonator_x", cp.x)),
                        get_json_double(msg, "trigger_y", get_json_double(msg, "detonator_y", cp.y)),
                        get_json_double(msg, "trigger_z", get_json_double(msg, "detonator_z", cp.z)),
                        get_json_double(msg, "time_delay", get_json_double(msg, "start_time", get_json_double(msg, "detonator_time", 0.0)))
                    );

                    std::string water_mode = msg.value("water_discretization_mode", "Pure_FV");
                    double sleeve_r = get_json_double(msg, "nearfield_sleeve_radius", 2.5);
                    bool is_zonal = (water_mode == "Spherical_MPM_Sleeve" || water_mode == "Full_Column_MPM_Cylinder") && (sleeve_r > 0.0);

                    Charge3DParams cp_cfd = cp;
                    if (is_zonal) {
                        // When nearfield water sleeve and explosive charge are discretized by MPM particles,
                        // CFD domain initializes background fluid only (charge radius = 0 to prevent double detonation).
                        cp_cfd.radius = 0.0;
                        cp_cfd.lx = 0.0;
                        cp_cfd.ly = 0.0;
                        cp_cfd.lz = 0.0;
                    }

                    g_is_stratified_fsi.store(is_stratified_fsi);
                    if (is_stratified_fsi) {
                        strat_fsi = parse_stratified_params(msg, ambient_rho, ambient_p);
                        g_strat_fsi_params = strat_fsi;
                        double gx = get_json_double(msg, "gravity_x", get_json_double(msg, "gx", 0.0));
                        double gy = get_json_double(msg, "gravity_y", get_json_double(msg, "gy", 0.0));
                        double gz = strat_fsi.gravity_z;
                        global_solver_3d->setGravity(gx, gy, gz);
                        global_solver_3d->setStratifiedInitialCondition(cp_cfd, matSet, strat_fsi);
                    } else {
                        if (msg.contains("gravity_z") || msg.contains("gz") || msg.contains("gravity_y") || msg.contains("gy") || msg.contains("gravity_x") || msg.contains("gx")) {
                            double gx = get_json_double(msg, "gravity_x", get_json_double(msg, "gx", 0.0));
                            double gy = get_json_double(msg, "gravity_y", get_json_double(msg, "gy", 0.0));
                            double gz = get_json_double(msg, "gravity_z", get_json_double(msg, "gz", 0.0));
                            global_solver_3d->setGravity(gx, gy, gz);
                        }
                        global_solver_3d->setInitialCondition(cp_cfd, matSet, ambient_rho, ambient_p);
                    }

                    double overlap_th = std::max(2.0 * cellSize, 0.15 * sleeve_r);
                    Blast::ZonalHandoff3DParams zonal_params;
                    zonal_params.enabled = is_zonal;
                    zonal_params.is_cylinder = (water_mode == "Full_Column_MPM_Cylinder");
                    zonal_params.center_x = cp.x;
                    zonal_params.center_y = cp.y;
                    zonal_params.center_z = cp.z;
                    zonal_params.sleeve_radius = sleeve_r;
                    zonal_params.overlap_thickness = overlap_th;
                    zonal_params.clip_z_min = get_json_double(msg, "seabed_surface_z", -1.0e30);
                    zonal_params.clip_z_max = get_json_double(msg, "water_surface_z", 1.0e30);
                    global_solver_3d->setZonalHandoffParams(zonal_params);

                    {
                        std::lock_guard<std::mutex> lock(g_pending_remap_mutex);
                        if (g_pending_remap.has_pending) {
                            if (init_mode == "From1D" || init_mode == "From2D") {
                                std::cout << "[INFO] Applying queued pending " << g_pending_remap.type << " remap onto 3D solver in INIT_FSI_3D..." << std::endl;
                                apply_remap_payload(g_pending_remap.msg, g_pending_remap.type, global_solver_3d.get(), nullptr, nullptr);
                            }
                            g_pending_remap.has_pending = false;
                        }
                    }

                    auto map_bc_3d = [](const std::string& str) {
                        if (str == "Terminate" || str == "TERMINATE") return BCType3D::TERMINATE;
                        if (str == "OUTFLOW_RIEMANN" || str == "Riemann" || str == "NonReflecting" || str == "Absorbing" || str == "Lysmer" || str == "Transmitting" || str == "TRANSMISSIVE") return BCType3D::OUTFLOW_RIEMANN;
                        if (str == "Outflow" || str == "Neumann") return BCType3D::TRANSMISSIVE;
                        return BCType3D::REFLECTIVE;
                    };
                    global_solver_3d->setBoundaryConditions(
                        map_bc_3d(msg.value("bc_x_min", "Reflecting")), map_bc_3d(msg.value("bc_x_max", "Transmitting")),
                        map_bc_3d(msg.value("bc_y_min", "Reflecting")), map_bc_3d(msg.value("bc_y_max", "Transmitting")),
                        map_bc_3d(msg.value("bc_z_min", "Reflecting")), map_bc_3d(msg.value("bc_z_max", "Transmitting"))
                    );

                    // 2. Initialize MPM 3D solver
                    float dx = static_cast<float>(cellSize);
                    float dy = static_cast<float>(cellSize);
                    float dz = static_cast<float>(cellSize);
                    if (is_cuda_device(device)) {
                        global_solver_mpm_3d_cuda = std::make_unique<Blast::MPMSolver3DCUDA>();
                        global_solver_mpm_3d_cuda->initializeGrid(nx, ny, nz, dx, dy, dz, xmin, ymin, zmin);
                        global_solver_mpm_3d_cuda->setZonalHandoffParams(zonal_params);
                    } else {
                        global_solver_mpm_3d = std::make_unique<Blast::MPMSolver3D>();
                        global_solver_mpm_3d->initializeGrid(nx, ny, nz, dx, dy, dz, xmin, ymin, zmin);
                    }

                    std::string transfer_scheme = msg.value("transfer_scheme", "BSpline");
                    std::string velocity_scheme = msg.value("velocity_scheme", "APIC");
                    std::string space_time_scheme = msg.value("space_time_scheme", "Leapfrog");
                    auto ts = parseTransferScheme(transfer_scheme);
                    auto vs = (velocity_scheme == "PIC") ? Blast::MPMVelocityScheme::PIC :
                              ((velocity_scheme == "FLIP") ? Blast::MPMVelocityScheme::FLIP : Blast::MPMVelocityScheme::APIC);
                    float flip_blend = static_cast<float>(get_json_double(msg, "flip_blend", 0.95));
                    auto st = (space_time_scheme == "RK2") ? Blast::MPMTimeIntegrationScheme::RK2 :
                              ((space_time_scheme == "USF") ? Blast::MPMTimeIntegrationScheme::USF :
                              ((space_time_scheme == "USL") ? Blast::MPMTimeIntegrationScheme::USL : Blast::MPMTimeIntegrationScheme::Leapfrog));
                    bool smooth_ps = get_json_bool(msg, "smooth_plastic_strain", true);
                    bool enable_dem_contact = get_json_bool(msg, "enable_dem_contact", false);
                    float dem_friction = static_cast<float>(get_json_double(msg, "dem_friction", 0.20));
                    float dem_restitution = static_cast<float>(get_json_double(msg, "dem_restitution", 0.0));
                    float dem_contact_scale = static_cast<float>(get_json_double(msg, "dem_contact_scale", 1.0));
                    std::string dem_mode_str = msg.value("dem_contact_mode", "Gas-Solid Only");
                    Blast::MPMDEMContactMode dem_mode = Blast::MPMDEMContactMode::GasSolidOnly;
                    if (dem_mode_str == "Ballistic Impacts & Gas" || dem_mode_str == "BallisticAndGas") {
                        dem_mode = Blast::MPMDEMContactMode::BallisticAndGas;
                    } else if (dem_mode_str == "All Dynamic Contacts" || dem_mode_str == "AllDynamic") {
                        dem_mode = Blast::MPMDEMContactMode::AllDynamic;
                    }
                    float dem_v_thresh = static_cast<float>(get_json_double(msg, "dem_velocity_threshold", 1.0));

                    std::string contact_method_str = msg.value("contact_method", "Single-Velocity");
                    Blast::MPMContactMethod contact_method = Blast::MPMContactMethod::SingleVelocity;
                    if (contact_method_str == "Sub-Grid DEM" || contact_method_str == "SubGridDEM" ||
                        contact_method_str == "Discrete Element (DEM)" || contact_method_str == "DiscreteElementDEM" ||
                        contact_method_str.find("DEM") != std::string::npos) {
                        contact_method = Blast::MPMContactMethod::SubGridDEM;
                        enable_dem_contact = true;
                    } else if (contact_method_str.find("Bardenhagen") != std::string::npos ||
                               contact_method_str.find("Multi-Velocity") != std::string::npos ||
                               contact_method_str == "MultiVelocityBardenhagen") {
                        contact_method = Blast::MPMContactMethod::MultiVelocityBardenhagen;
                    } else if (enable_dem_contact) {
                        contact_method = Blast::MPMContactMethod::SubGridDEM;
                    }

                    bool enable_impact_welding = get_json_bool(msg, "enable_impact_welding", false);
                    bool enable_frictional_heating = get_json_bool(msg, "enable_frictional_heating", false);
                    bool enable_thermal_conduction = get_json_bool(msg, "enable_thermal_conduction", false);

                    if (global_solver_mpm_3d_cuda) {
                        global_solver_mpm_3d_cuda->setTransferScheme(ts);
                        global_solver_mpm_3d_cuda->setVelocityScheme(vs);
                        global_solver_mpm_3d_cuda->setFlipBlend(flip_blend);
                        global_solver_mpm_3d_cuda->setTimeScheme(st);
                        global_solver_mpm_3d_cuda->setSmoothPlasticStrain(smooth_ps);
                        global_solver_mpm_3d_cuda->setDemContact(enable_dem_contact, dem_friction, dem_restitution, dem_contact_scale, dem_mode, dem_v_thresh);
                        global_solver_mpm_3d_cuda->setContactMethod(contact_method);
                        global_solver_mpm_3d_cuda->setImpactWelding(enable_impact_welding);
                        global_solver_mpm_3d_cuda->setFrictionalHeating(enable_frictional_heating);
                        global_solver_mpm_3d_cuda->setThermalConduction(enable_thermal_conduction);
                    } else {
                        global_solver_mpm_3d->setTransferScheme(ts);
                        global_solver_mpm_3d->setVelocityScheme(vs);
                        global_solver_mpm_3d->setFlipBlend(flip_blend);
                        global_solver_mpm_3d->setTimeScheme(st);
                        global_solver_mpm_3d->setSmoothPlasticStrain(smooth_ps);
                        global_solver_mpm_3d->setDemContact(enable_dem_contact, dem_friction, dem_restitution, dem_contact_scale, dem_mode, dem_v_thresh);
                        global_solver_mpm_3d->setContactMethod(contact_method);
                        global_solver_mpm_3d->setImpactWelding(enable_impact_welding);
                        global_solver_mpm_3d->setFrictionalHeating(enable_frictional_heating);
                        global_solver_mpm_3d->setThermalConduction(enable_thermal_conduction);
                    }

                    auto mpm_bc1 = parse_bc_mpm3d(msg.value("bc_x_min", "Reflecting"));
                    auto mpm_bc2 = parse_bc_mpm3d(msg.value("bc_x_max", "Transmitting"));
                    auto mpm_bc3 = parse_bc_mpm3d(msg.value("bc_y_min", "Reflecting"));
                    auto mpm_bc4 = parse_bc_mpm3d(msg.value("bc_y_max", "Transmitting"));
                    auto mpm_bc5 = parse_bc_mpm3d(msg.value("bc_z_min", "Reflecting"));
                    auto mpm_bc6 = parse_bc_mpm3d(msg.value("bc_z_max", "Transmitting"));

                    Blast::LysmerDashpotParams mpm_fsi_lysmer;
                    mpm_fsi_lysmer.rho = static_cast<float>(get_json_double(msg, "lysmer_rho", get_json_double(msg, "lysmer_density", 2000.0)));
                    mpm_fsi_lysmer.c_p = static_cast<float>(get_json_double(msg, "lysmer_cp", get_json_double(msg, "lysmer_c_p", 2000.0)));
                    mpm_fsi_lysmer.c_s = static_cast<float>(get_json_double(msg, "lysmer_cs", get_json_double(msg, "lysmer_c_s", 1000.0)));
                    mpm_fsi_lysmer.normal_relaxation = static_cast<float>(get_json_double(msg, "lysmer_normal_relaxation", 1.0));
                    mpm_fsi_lysmer.shear_relaxation = static_cast<float>(get_json_double(msg, "lysmer_shear_relaxation", 1.0));

                    if (global_solver_mpm_3d_cuda) {
                        global_solver_mpm_3d_cuda->setBoundaryConditions(mpm_bc1, mpm_bc2, mpm_bc3, mpm_bc4, mpm_bc5, mpm_bc6);
                        global_solver_mpm_3d_cuda->setLysmerParams(mpm_fsi_lysmer);
                    } else {
                        global_solver_mpm_3d->setBoundaryConditions(mpm_bc1, mpm_bc2, mpm_bc3, mpm_bc4, mpm_bc5, mpm_bc6);
                        global_solver_mpm_3d->setLysmerParams(mpm_fsi_lysmer);
                    }

                    int domain_ppc = get_json_int(msg, "ppc", 8);
                    std::string domain_p_dist_str = msg.value("particle_distribution", "Cartesian");
                    std::string domain_b_fill_str = msg.value("boundary_filling", "Stairstepped");

                    align_sleeve_tait_with_fv(const_cast<nlohmann::json&>(msg));
                    if (msg.contains("mpm_objects") && msg["mpm_objects"].is_array()) {
                        // Phase 1: Add all object geometries to host particles
                        int obj_idx = 0;
                        for (const auto& obj : msg["mpm_objects"]) {
                            obj_idx++;
                            std::string shape = obj.value("shape_type", "Box");
                            std::string origin_mode = obj.value("origin_mode", "Center");
                            float pos_fallback = (shape == "STL" && origin_mode == "CAD Origin") ? 0.0f : 0.5f;
                            float pos_x = static_cast<float>(get_json_double(obj, "pos_x", pos_fallback));
                            float pos_y = static_cast<float>(get_json_double(obj, "pos_y", pos_fallback));
                            float pos_z = static_cast<float>(get_json_double(obj, "pos_z", pos_fallback));
                            if (shape == "STL" && origin_mode == "CAD Origin" &&
                                std::abs(pos_x - 0.5f) < 1e-4f && std::abs(pos_y - 0.5f) < 1e-4f && std::abs(pos_z - 0.5f) < 1e-4f) {
                                pos_x = 0.0f;
                                pos_y = 0.0f;
                                pos_z = 0.0f;
                            }
                            float vel_x = static_cast<float>(get_json_double(obj, "vel_x", 0.0));
                            float vel_y = static_cast<float>(get_json_double(obj, "vel_y", 0.0));
                            float vel_z = static_cast<float>(get_json_double(obj, "vel_z", 0.0));
                            float ang_x = static_cast<float>(get_json_double(obj, "angular_vel_x", 0.0));
                            float ang_y = static_cast<float>(get_json_double(obj, "angular_vel_y", 0.0));
                            float ang_z = static_cast<float>(get_json_double(obj, "angular_vel_z", 0.0));
                            float density = static_cast<float>(get_json_double(obj, "density", 7850.0));
                            {
                                const std::string mm_chk = obj.value("material_model", "");
                                if ((mm_chk == "JWLProgrammedBurn" || mm_chk == "JWL Programmed Burn") && density < 100.0f) {
                                    float fallback_rho = static_cast<float>(get_json_double(obj, "rho", 0.0));
                                    if (fallback_rho < 100.0f) fallback_rho = static_cast<float>(get_json_double(obj, "ideal_rho_0", 1630.0));
                                    if (fallback_rho < 100.0f) fallback_rho = 1630.0f;
                                    std::cout << "[BlastSolver] Warning: Explosive MPM object '" << obj.value("name", std::string("?"))
                                              << "' has anomalous density " << density << " kg/m^3. Correcting to solid reference density "
                                              << fallback_rho << " kg/m^3." << std::endl;
                                    density = fallback_rho;
                                }
                            }
                            float E = static_cast<float>(get_json_double(obj, "youngs_modulus", 210.0e9));
                            float nu = static_cast<float>(get_json_double(obj, "poissons_ratio", 0.3));
                            float yield_stress = static_cast<float>(get_json_double(obj, "yield_stress", 400.0e6));
                            float hardening = static_cast<float>(get_json_double(obj, "hardening_modulus", 1.0e9));
                            float failure_strain = static_cast<float>(get_json_double(obj, "failure_strain", 0.25));
                            float tensile_failure_stress = static_cast<float>(get_json_double(obj, "tensile_failure_stress", 600.0e6));
                            int ppc = std::max(1, get_json_int(obj, "ppc", domain_ppc));

                            std::string p_dist_str = obj.value("particle_distribution", domain_p_dist_str);
                            Blast::MPMParticleDistribution particle_dist = Blast::MPMParticleDistribution::Cartesian;
                            if (p_dist_str == "Hexagonal") {
                                particle_dist = Blast::MPMParticleDistribution::Hexagonal;
                            }

                            std::string b_fill_str = obj.value("boundary_filling", domain_b_fill_str);
                            Blast::MPMBoundaryFilling boundary_fill = Blast::MPMBoundaryFilling::Stairstepped;
                            if (b_fill_str == "Partial") {
                                boundary_fill = Blast::MPMBoundaryFilling::Partial;
                            }


                            float rot_x = static_cast<float>(get_json_double(obj, "rot_x", 0.0));
                            float rot_y = static_cast<float>(get_json_double(obj, "rot_y", 0.0));
                            float rot_z = static_cast<float>(get_json_double(obj, "rot_z", 0.0));
                            float clip_z_min = static_cast<float>(get_json_double(obj, "clip_z_min", -1.0e30));
                            float clip_z_max = static_cast<float>(get_json_double(obj, "clip_z_max", 1.0e30));

                            if (shape == "Sphere") {
                                float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
                                float inner_radius = static_cast<float>(get_json_double(obj, "inner_radius", 0.0));
                                if (global_solver_mpm_3d_cuda) {
                                    global_solver_mpm_3d_cuda->addSphereObject(obj_idx, pos_x, pos_y, pos_z, radius, inner_radius, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
                                } else {
                                    global_solver_mpm_3d->addSphereObject(obj_idx, pos_x, pos_y, pos_z, radius, inner_radius, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
                                }
                            } else if (shape == "Cylinder") {
                                float radius = static_cast<float>(get_json_double(obj, "radius", 0.1));
                                float inner_radius = static_cast<float>(get_json_double(obj, "inner_radius", 0.0));
                                float height = static_cast<float>(get_json_double(obj, "height", 0.2));
                                if (global_solver_mpm_3d_cuda) {
                                    global_solver_mpm_3d_cuda->addCylinderObject(obj_idx, pos_x, pos_y, pos_z, radius, inner_radius, height, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
                                } else {
                                    global_solver_mpm_3d->addCylinderObject(obj_idx, pos_x, pos_y, pos_z, radius, inner_radius, height, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
                                }
                            } else if (shape == "STL") {
                                std::string stl_file = obj.contains("stl_file") ? obj["stl_file"].get<std::string>() : "";
                                float scale_x = static_cast<float>(get_json_double(obj, "scale_x", 1.0));
                                float scale_y = static_cast<float>(get_json_double(obj, "scale_y", 1.0));
                                float scale_z = static_cast<float>(get_json_double(obj, "scale_z", 1.0));
                                std::string origin_mode = obj.value("origin_mode", "Center");
                                std::string voxelization_method = obj.value("voxelization_method", "watertight_raycast");
                                if (global_solver_mpm_3d_cuda) {
                                    global_solver_mpm_3d_cuda->addSTLObject(obj_idx, stl_file, pos_x, pos_y, pos_z, scale_x, scale_y, scale_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, voxelization_method, rot_x, rot_y, rot_z, origin_mode);
                                } else {
                                    global_solver_mpm_3d->addSTLObject(obj_idx, stl_file, pos_x, pos_y, pos_z, scale_x, scale_y, scale_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, voxelization_method, rot_x, rot_y, rot_z, origin_mode);
                                }
                            } else {
                                float size_x = static_cast<float>(get_json_double(obj, "size_x", 0.2));
                                float size_y = static_cast<float>(get_json_double(obj, "size_y", 0.2));
                                float size_z = static_cast<float>(get_json_double(obj, "size_z", 0.2));
                                if (global_solver_mpm_3d_cuda) {
                                    global_solver_mpm_3d_cuda->addBoxObject(obj_idx, pos_x, pos_y, pos_z, size_x, size_y, size_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
                                } else {
                                    global_solver_mpm_3d->addBoxObject(obj_idx, pos_x, pos_y, pos_z, size_x, size_y, size_z, vel_x, vel_y, vel_z, ang_x, ang_y, ang_z, density, E, nu, yield_stress, hardening, failure_strain, tensile_failure_stress, ppc, particle_dist, boundary_fill, rot_x, rot_y, rot_z, clip_z_min, clip_z_max);
                                }
                            }
                        }

                        // Phase 2: Populate material tables for all objects
                        obj_idx = 0;
                        for (const auto& obj : msg["mpm_objects"]) {
                            obj_idx++;
                            Blast::MaterialTable3D parsed_mat = parseMaterialTable3D(obj);
                            std::string mat_model_str = obj.value("material_model", "Hypoelastic");
                            std::cout << "[BlastSolver] FSI Object " << obj_idx << " Constitutive Model: " << mat_model_str
                                      << " -> Enum=" << static_cast<int>(parsed_mat.material_model) << std::endl;
                            emit_kernel_log("SYSTEM", "FSI Object " + std::to_string(obj_idx) + " Material Model: " + mat_model_str + " (Enum=" + std::to_string(static_cast<int>(parsed_mat.material_model)) + ")", 0.0, "3d");
                            if (global_solver_mpm_3d_cuda) {
                                auto& mat_tables = global_solver_mpm_3d_cuda->getMaterialTables();
                                if (obj_idx >= static_cast<int>(mat_tables.size())) {
                                    mat_tables.resize(obj_idx + 1);
                                }
                                mat_tables[obj_idx] = parsed_mat;
                            }
                            if (global_solver_mpm_3d) {
                                auto& mat_tables = global_solver_mpm_3d->getMaterialTables();
                                if (obj_idx >= static_cast<int>(mat_tables.size())) {
                                    mat_tables.resize(obj_idx + 1);
                                }
                                mat_tables[obj_idx] = parsed_mat;
                            }
                        }

                        // Phase 3: Material heterogeneity & fragment seeding on host
                        obj_idx = 0;
                        for (const auto& obj : msg["mpm_objects"]) {
                            obj_idx++;
                            (void)obj;
                            if (global_solver_mpm_3d_cuda) {
                                global_solver_mpm_3d_cuda->initMaterialHeterogeneity(obj_idx);
                            }
                            if (global_solver_mpm_3d) {
                                global_solver_mpm_3d->initMaterialHeterogeneity(obj_idx);
                            }
                        }

                        // Phase 4: Detonator hotspot ignition and initial temperature
                        if (global_solver_mpm_3d_cuda) {
                            global_solver_mpm_3d_cuda->clearDetonators();
                        }
                        if (global_solver_mpm_3d) {
                            global_solver_mpm_3d->clearDetonators();
                        }

                        struct TriggerSpec3D_2 {
                            float x, y, z, radius;
                            float start_time{0.0f};
                            bool track_mpm_velocity{false};
                            int target_object_id{-1};
                        };
                        std::vector<TriggerSpec3D_2> global_triggers_3d_2;
                        auto parse_trigger_obj_2 = [](const nlohmann::json& d) -> TriggerSpec3D_2 {
                            float tx = static_cast<float>(get_json_double(d, "trigger_x", get_json_double(d, "detonator_x", get_json_double(d, "x", 0.5))));
                            float ty = static_cast<float>(get_json_double(d, "trigger_y", get_json_double(d, "detonator_y", get_json_double(d, "y", 0.5))));
                            float tz = static_cast<float>(get_json_double(d, "trigger_z", get_json_double(d, "detonator_z", get_json_double(d, "z", 0.5))));
                            float tr = static_cast<float>(get_json_double(d, "trigger_radius", get_json_double(d, "detonator_radius", get_json_double(d, "initiation_radius", get_json_double(d, "radius", 0.02)))));
                            float t_start = static_cast<float>(get_json_double(d, "time_delay", get_json_double(d, "start_time", get_json_double(d, "detonation_time", get_json_double(d, "delay", 0.0)))));
                            bool track_vel = false;
                            if (d.contains("track_mpm_velocity")) {
                                if (d["track_mpm_velocity"].is_boolean()) track_vel = d["track_mpm_velocity"].get<bool>();
                                else if (d["track_mpm_velocity"].is_number()) track_vel = (d["track_mpm_velocity"].get<int>() != 0);
                                else if (d["track_mpm_velocity"].is_string()) {
                                    std::string s = d["track_mpm_velocity"].get<std::string>();
                                    track_vel = (s == "true" || s == "1" || s == "yes");
                                }
                            }
                            int target_obj = get_json_int(d, "target_object_id", get_json_int(d, "object_id", -1));
                            return {tx, ty, tz, tr, t_start, track_vel, target_obj};
                        };

                        auto register_detonator_to_solvers_2 = [&](const TriggerSpec3D_2& trig, int obj_id) {
                            Blast::MPMDetonator3D d;
                            d.x = trig.x;
                            d.y = trig.y;
                            d.z = trig.z;
                            d.radius = trig.radius;
                            d.time_delay = trig.start_time;
                            d.track_mpm_velocity = trig.track_mpm_velocity;
                            d.fired = (trig.start_time <= 0.0f);
                            d.target_object_id = (trig.target_object_id >= 0) ? trig.target_object_id : obj_id;
                            if (global_solver_mpm_3d_cuda) global_solver_mpm_3d_cuda->addDetonator(d);
                            if (global_solver_mpm_3d) global_solver_mpm_3d->addDetonator(d);
                        };

                        if (msg.contains("triggers") && msg["triggers"].is_array()) {
                            for (const auto& d : msg["triggers"]) {
                                auto trig = parse_trigger_obj_2(d);
                                global_triggers_3d_2.push_back(trig);
                                register_detonator_to_solvers_2(trig, trig.target_object_id);
                            }
                        } else if (msg.contains("detonators") && msg["detonators"].is_array()) {
                            for (const auto& d : msg["detonators"]) {
                                auto trig = parse_trigger_obj_2(d);
                                global_triggers_3d_2.push_back(trig);
                                register_detonator_to_solvers_2(trig, trig.target_object_id);
                            }
                        } else if (msg.contains("trigger_x") || msg.contains("detonator_x")) {
                            auto trig = parse_trigger_obj_2(msg);
                            global_triggers_3d_2.push_back(trig);
                            register_detonator_to_solvers_2(trig, trig.target_object_id);
                        }

                        auto& particles_ref = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getParticles() : global_solver_mpm_3d->getParticles();
                        const auto& mat_tables = global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getMaterialTables() : global_solver_mpm_3d->getMaterialTables();

                        obj_idx = 0;
                        for (const auto& obj : msg["mpm_objects"]) {
                            obj_idx++;
                            const auto& parsed_mat = mat_tables[obj_idx];
                            std::string mat_model_str = obj.value("material_model", "Hypoelastic");
                            bool is_crest = (parsed_mat.material_model == Blast::MPMMaterialModel::CRESTReactiveBurn);
                            bool is_jwl_prog = (parsed_mat.material_model == Blast::MPMMaterialModel::JWLProgrammedBurn);
                            bool is_lee_tarver = (parsed_mat.material_model == Blast::MPMMaterialModel::LeeTarverIgnitionGrowth);
                            bool is_explosive = is_crest || is_jwl_prog || is_lee_tarver;

                            std::string preset_name = obj.value("preset", "");
                            bool is_predetonated = (preset_name.find("Pre-Detonated") != std::string::npos ||
                                                    preset_name.find("Instant") != std::string::npos ||
                                                    preset_name.find("JWL Detonation Gas") != std::string::npos);

                            std::vector<TriggerSpec3D_2> triggers_3d_2 = global_triggers_3d_2;
                            if (obj.contains("triggers") && obj["triggers"].is_array()) {
                                for (const auto& d : obj["triggers"]) {
                                    auto trig = parse_trigger_obj_2(d);
                                    triggers_3d_2.push_back(trig);
                                    register_detonator_to_solvers_2(trig, obj_idx);
                                }
                            } else if (obj.contains("detonators") && obj["detonators"].is_array()) {
                                for (const auto& d : obj["detonators"]) {
                                    auto trig = parse_trigger_obj_2(d);
                                    triggers_3d_2.push_back(trig);
                                    register_detonator_to_solvers_2(trig, obj_idx);
                                }
                            } else if (obj.contains("trigger_x") || obj.contains("detonator_x")) {
                                auto trig = parse_trigger_obj_2(obj);
                                triggers_3d_2.push_back(trig);
                                register_detonator_to_solvers_2(trig, obj_idx);
                            }

                            int ignited_count = 0;
                            for (auto& p : particles_ref) {
                                if (p.object_id == obj_idx) {
                                    p.temperature = parsed_mat.T_room;

                                    if (is_jwl_prog) {
                                        if (is_predetonated) {
                                            p.lambda = 1.0f;
                                            p.t_arrival = 0.0f;
                                            p.e_int = parsed_mat.detonation_energy;
                                            float p_init = Blast::JWL::computeJWLProductPressure(p.V0 > 0.0f ? p.V / p.V0 : 1.0f, parsed_mat.detonation_energy, parsed_mat.jwl_A, parsed_mat.jwl_B, parsed_mat.jwl_R1, parsed_mat.jwl_R2, parsed_mat.jwl_omega, parsed_mat.density);
                                            for (int r = 0; r < 3; ++r)
                                                for (int c = 0; c < 3; ++c)
                                                    p.sigma[r][c] = (r == c) ? -p_init : 0.0f;
                                            ignited_count++;
                                        } else if (!triggers_3d_2.empty()) {
                                            float min_t_arr = 1.0e10f;
                                            bool has_immediate = false;
                                            for (const auto& trig : triggers_3d_2) {
                                                if (trig.track_mpm_velocity && trig.start_time > 0.0f) {
                                                    continue;
                                                }
                                                if (trig.start_time <= 0.0f) has_immediate = true;
                                                float d_x = p.x[0] - trig.x;
                                                float d_y = p.x[1] - trig.y;
                                                float d_z = p.x[2] - trig.z;
                                                float dist = std::sqrt(d_x * d_x + d_y * d_y + d_z * d_z);
                                                float eff_dist = (trig.radius > 0.0f) ? std::max(0.0f, dist - trig.radius) : dist;
                                                float t_arr = trig.start_time + eff_dist / std::max(parsed_mat.det_vel, 100.0f);
                                                if (t_arr < min_t_arr) min_t_arr = t_arr;
                                            }
                                            p.t_arrival = min_t_arr;
                                            if (min_t_arr <= 0.0f && has_immediate) {
                                                p.lambda = 1.0f;
                                                p.e_int = parsed_mat.detonation_energy;
                                                float p_init = Blast::JWL::computeJWLProductPressure(p.V0 > 0.0f ? p.V / p.V0 : 1.0f, parsed_mat.detonation_energy, parsed_mat.jwl_A, parsed_mat.jwl_B, parsed_mat.jwl_R1, parsed_mat.jwl_R2, parsed_mat.jwl_omega, parsed_mat.density);
                                                for (int r = 0; r < 3; ++r)
                                                    for (int c = 0; c < 3; ++c)
                                                        p.sigma[r][c] = (r == c) ? -p_init : 0.0f;
                                                ignited_count++;
                                            } else {
                                                p.lambda = 0.0f;
                                                p.e_int = 0.0f;
                                            }
                                        } else {
                                            p.t_arrival = 1.0e10f;
                                            p.lambda = 0.0f;
                                        }
                                    } else if (is_crest && !triggers_3d_2.empty()) {
                                        bool in_trigger_core = false;
                                        for (const auto& trig : triggers_3d_2) {
                                            if (trig.start_time > 0.0f) continue;
                                            float d_x = p.x[0] - trig.x;
                                            float d_y = p.x[1] - trig.y;
                                            float d_z = p.x[2] - trig.z;
                                            float dist = std::sqrt(d_x * d_x + d_y * d_y + d_z * d_z);
                                            float effective_init_rad = std::max(trig.radius, 2.5f * dx);
                                            if (dist <= effective_init_rad) {
                                                in_trigger_core = true;
                                                break;
                                            }
                                        }
                                        if (in_trigger_core) {
                                            ignited_count++;
                                            p.s_shock = (parsed_mat.crest_awe_c0 > 0.0f) ? std::max(0.02f, 2.0f * parsed_mat.crest_awe_c13) : 1.5f * parsed_mat.crest_s_threshold;
                                            p.lambda = 1.0f;
                                            p.e_int = std::max(parsed_mat.davis_q_det, static_cast<float>(get_json_double(obj, "detonation_energy", 4.29e6)));
                                            p.v_min = (parsed_mat.davis_vc > 0.1f) ? parsed_mat.davis_vc : 0.70f;
                                            p.V = p.v_min * p.V0;
                                            float p_init = ((parsed_mat.davis_pc > 1.0e6f) ? parsed_mat.davis_pc : 15.0e9f);
                                            for (int r = 0; r < 3; ++r) {
                                                for (int c = 0; c < 3; ++c) {
                                                    p.sigma[r][c] = (r == c) ? -p_init : 0.0f;
                                                }
                                            }
                                        } else {
                                            p.s_shock = 0.0f;
                                            p.lambda = 0.0f;
                                            p.e_int = 0.0f;
                                            p.v_min = 1.0f;
                                        }
                                    } else if (is_lee_tarver && !triggers_3d_2.empty()) {
                                        bool in_trigger_core = false;
                                        for (const auto& trig : triggers_3d_2) {
                                            if (trig.start_time > 0.0f) continue;
                                            float d_x = p.x[0] - trig.x;
                                            float d_y = p.x[1] - trig.y;
                                            float d_z = p.x[2] - trig.z;
                                            float dist = std::sqrt(d_x * d_x + d_y * d_y + d_z * d_z);
                                            float effective_init_rad = std::max(trig.radius, 2.5f * dx);
                                            if (dist <= effective_init_rad) {
                                                in_trigger_core = true;
                                                break;
                                            }
                                        }
                                        if (in_trigger_core) {
                                            ignited_count++;
                                            p.lambda = 1.0f;
                                            p.e_int = parsed_mat.detonation_energy;
                                            float p_init = 20.0e9f;
                                            for (int r = 0; r < 3; ++r) {
                                                for (int c = 0; c < 3; ++c) {
                                                    p.sigma[r][c] = (r == c) ? -p_init : 0.0f;
                                                }
                                            }
                                        } else {
                                            p.lambda = 0.0f;
                                            p.e_int = 0.0f;
                                        }
                                    }
                                }
                            }
                            if (is_explosive) {
                                if (triggers_3d_2.empty() && !is_predetonated) {
                                    std::cerr << "[BlastSolver] [WARNING] FSI Object " << obj_idx << " is an energetic material (" << mat_model_str
                                              << "), but NO triggers/detonators were provided or connected!" << std::endl;
                                    emit_kernel_log("WARNING", "FSI Object " + std::to_string(obj_idx) + " is an energetic material (" + mat_model_str + "), but NO TriggerLocation3D / DetonatorLocation3D was connected to MPM Domain!", 0.0, "3d");
                                } else if (is_jwl_prog) {
                                    size_t n_obj = 0;
                                    float t_burn_end = 0.0f;
                                    for (const auto& pp : particles_ref) {
                                        if (pp.object_id != obj_idx) continue;
                                        ++n_obj;
                                        if (pp.t_arrival < 1.0e9f) t_burn_end = std::max(t_burn_end, pp.t_arrival);
                                    }
                                    std::ostringstream bl;
                                    bl << "FSI Object " << obj_idx << " (" << mat_model_str << "): programmed burn from "
                                       << triggers_3d_2.size() << " detonator(s); ignited at t=0: " << ignited_count << " / " << n_obj
                                       << " particles; burn front completes at t = " << std::scientific << std::setprecision(3) << t_burn_end << " s"
                                       << (is_predetonated ? " [PRESET IS PRE-DETONATED: whole charge starts burned]" : "");
                                    std::cout << "[BlastSolver] " << bl.str() << std::endl;
                                    emit_kernel_log((is_predetonated || (n_obj > 0 && ignited_count * 2 > static_cast<int>(n_obj))) ? "WARNING" : "SYSTEM", bl.str(), 0.0, "3d");
                                } else if (ignited_count == 0 && !is_predetonated) {
                                    bool has_delayed = false;
                                    for (const auto& trig : triggers_3d_2) {
                                        if (trig.start_time > 0.0f) { has_delayed = true; break; }
                                    }
                                    if (has_delayed) {
                                        std::cout << "[BlastSolver] FSI Object " << obj_idx << " (" << mat_model_str
                                                  << "): Delayed detonator registered (start_time > 0.0s). Hotspot will trigger dynamically at scheduled delay." << std::endl;
                                        emit_kernel_log("SYSTEM", "FSI Object " + std::to_string(obj_idx) + " (" + mat_model_str + "): Delayed detonator registered. Initiation will occur at specified time delay.", 0.0, "3d");
                                    } else {
                                        std::cerr << "[BlastSolver] [WARNING] FSI Object " << obj_idx << " (" << mat_model_str
                                                  << "): Trigger did NOT intersect any particles! 0 particles ignited. Check trigger (x,y,z) vs object position." << std::endl;
                                        emit_kernel_log("WARNING", "FSI Object " + std::to_string(obj_idx) + ": Trigger did NOT intersect any particles (0 ignited). Check trigger coordinates vs explosive body.", 0.0, "3d");
                                    }
                                } else {
                                    std::cout << "[BlastSolver] FSI Object " << obj_idx << " (" << mat_model_str
                                              << "): Trigger hotspot initialized on " << ignited_count << " particles." << std::endl;
                                    emit_kernel_log("SYSTEM", "FSI Object " + std::to_string(obj_idx) + " (" + mat_model_str + "): Hotspot ignited " + std::to_string(ignited_count) + " particles.", 0.0, "3d");
                                }
                            }
                        }
                    } else {
                        std::cout << "[BlastSolver] No MPM objects defined in INIT_FSI_3D payload; MPM domain initialized with 0 particles." << std::endl;
                    }

                    // Material-based / Coupler-based contact mapping (hybrid Bardenhagen Multi-Velocity + Single-Velocity Bonded Groups)
                    std::vector<int> obj_to_mat;
                    int num_unique_materials = build_mpm_object_material_mapping(msg, obj_to_mat);

                    if (global_solver_mpm_3d_cuda) {
                        global_solver_mpm_3d_cuda->setContactMethod(contact_method);
                        global_solver_mpm_3d_cuda->setInitialContactTie(msg.value("bardenhagen_initial_tie", true));
                        global_solver_mpm_3d_cuda->setObjectMaterialMapping(obj_to_mat, num_unique_materials);
                    } else {
                        global_solver_mpm_3d->setContactMethod(contact_method);
                        global_solver_mpm_3d->setInitialContactTie(msg.value("bardenhagen_initial_tie", true));
                        global_solver_mpm_3d->setObjectMaterialMapping(obj_to_mat, num_unique_materials);
                    }
                    if (is_stratified_fsi) {
                        if (global_solver_mpm_3d_cuda) {
                            global_solver_mpm_3d_cuda->applyStratifiedInitialCondition(strat_fsi);
                        } else if (global_solver_mpm_3d) {
                            global_solver_mpm_3d->applyStratifiedInitialCondition(strat_fsi);
                        }
                    } else if (msg.contains("gravity_z") || msg.contains("gz") || msg.contains("gravity_y") || msg.contains("gy") || msg.contains("gravity_x") || msg.contains("gx")) {
                        float gx = static_cast<float>(get_json_double(msg, "gravity_x", get_json_double(msg, "gx", 0.0)));
                        float gy = static_cast<float>(get_json_double(msg, "gravity_y", get_json_double(msg, "gy", 0.0)));
                        float gz = static_cast<float>(get_json_double(msg, "gravity_z", get_json_double(msg, "gz", 0.0)));
                        if (global_solver_mpm_3d_cuda) {
                            global_solver_mpm_3d_cuda->setGravity(gx, gy, gz);
                        } else if (global_solver_mpm_3d) {
                            global_solver_mpm_3d->setGravity(gx, gy, gz);
                        }
                    }

                    // Phase 5: Single synchronized upload of material tables and all particles to GPU
                    if (global_solver_mpm_3d_cuda) {
                        global_solver_mpm_3d_cuda->uploadMaterialTableToDevice();
                        global_solver_mpm_3d_cuda->syncToDevice();
                        global_solver_mpm_3d_cuda->particleToGridDeviceOnly();
                        if (is_zonal && global_solver_3d) {
                            global_solver_3d->coupleZonalHandoffWithMPMGPU(global_solver_mpm_3d_cuda.get());
                            auto cv = global_solver_3d->getCellValues(0, 0, 59);
                            std::printf("[INIT_CHECK ijk=0,0,59] p=%.4e rho=%.4e E=%.4e a1=%.4e a2=%.4e a3=%.4e\n",
                                        cv[0], cv[1], cv[3], cv[4], cv[5], cv[6]);
                        }
                    } else {
                        global_solver_mpm_3d->particleToGrid();
                    }

                    setup_phase_tracking_particles_3d(msg);
                    init_gauges(msg);
                    emit_kernel_log("SYSTEM", "3D Coupled FSI Solver (CFD + MPM) Initialized", 0.0, "3d");

                    emit_telemetry_3d(0.0, false);

                    nlohmann::json prog_report;
                    prog_report["type"] = "progress";
                    prog_report["percent"] = 100;
                    prog_report["scope"] = "3d";
                    prog_report["mode"] = "INIT_FSI_3D";
                    prog_report["sim_time"] = 0.0;
                    prog_report["step"] = 0;
                    {
                        std::lock_guard<std::mutex> lock(cout_mutex);
                        std::cout << prog_report.dump() << std::endl;
                    }
                    } catch (const std::exception& e) {
                        std::cerr << "[ERROR] Exception in INIT_FSI_3D: " << e.what() << std::endl;
                        emit_kernel_log("ERROR", std::string("FSI 3D initialization failed: ") + e.what(), 0.0, "3d");
                        std::exit(1);
                    } catch (...) {
                        std::cerr << "[ERROR] Unknown exception in INIT_FSI_3D" << std::endl;
                        emit_kernel_log("ERROR", "FSI 3D initialization failed with unknown error", 0.0, "3d");
                        std::exit(1);
                    }
                } else if (command == "INIT_FEM_3D" || command == "INIT_3D_FEM") {
                    std::string model_id = msg.value("modelId", msg.value("model_id", global_model_id.empty() ? "default_fem" : global_model_id));
                    global_model_id = model_id;
                    global_endtime_fem_3d = msg.value("endtime", 1.0);
                    std::string precision = msg.value("precision", "single");
                    std::string device = msg.value("device", "cpu");
                    select_cuda_device(device);
                    bool use_gpu = is_cuda_device(device) || device == "gpu" || device == "cuda";

                    global_fem_solvers_float.erase(model_id);
                    global_fem_solvers_double.erase(model_id);
                    global_fem_solvers_cuda_float.erase(model_id);
                    global_fem_solvers_cuda_double.erase(model_id);

                    auto fem_lysmer = populateFEMLysmerParams(msg);

                    if (use_gpu) {
                        if (precision == "double") {
                            auto fem = std::make_unique<Blast::FEMSolver3DCUDA<double>>();
                            fem->setHourglassCoeff(static_cast<double>(get_json_double(msg, "hourglass_coeff", 0.1)));
                            fem->setContactPenaltyScale(static_cast<double>(get_json_double(msg, "contact_penalty_scale", 1.0)));
                            fem->setContactDamping(static_cast<double>(get_json_double(msg, "contact_damping", 0.20)));
                            fem->setFrictionCoefficients(static_cast<double>(get_json_double(msg, "friction_static", 0.3)), static_cast<double>(get_json_double(msg, "friction_kinetic", 0.2)));
                            {
                                std::string search_str = msg.value("contact_search_method", "Hierarchical Octave Hash Grid");
                                if (search_str == "Linear BVH (Morton Code)" || search_str == "LinearBVH" || search_str == "LBVH") {
                                    fem->setContactSearchMethod(Blast::FEMContactSearchMethod::LinearBVH);
                                } else {
                                    fem->setContactSearchMethod(Blast::FEMContactSearchMethod::HierarchicalOctaveGrid);
                                }
                            }

                            std::string hg_model_str = msg.value("hourglass_model", "FlanaganBelytschkoViscous");
                            if (hg_model_str == "FlanaganBelytschkoViscous") {
                                fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoViscous);
                            } else {
                                fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoStiffness);
                            }

                            std::string scheme_str = msg.value("integration_scheme", "OnePointFB");
                            if (scheme_str == "FullGauss8" || scheme_str == "FullIntegration8Pt") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::FullGauss8);
                            } else if (scheme_str == "SelectiveReduced") {
                            fem->setIntegrationScheme(Blast::FEMIntegrationScheme::SelectiveReduced);
                            } else if (scheme_str == "OnePointKF") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointKF);
                            } else {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointFB);
                            }

                            auto physics_params = fem->getPhysicsParams();
                            populateFEMPhysicsParams(msg, physics_params);
                            fem->setPhysicsParams(physics_params);
                            if (physics_params.convert_failed_elements_to_mpm) {
                                ensure_mpm_debris_solver(msg, true);
                            }
                            if (global_solver_mpm_3d) {
                                fem->setMPMSolver(global_solver_mpm_3d.get());
                            }
                            if (global_solver_mpm_3d_cuda) {
                                fem->setCUDAMPMSolver(global_solver_mpm_3d_cuda.get());
                            }

                            auto erosion = populateFEMErosionCriteria<double>(msg);
                            ingestFEMObjectsAndDetonators<decltype(fem), double>(fem, msg);
                            std::string rebar_form = msg.value("rebar_formulation", "TimoshenkoBeam3D");
                            ingestStandaloneBeams<decltype(fem), double>(fem, msg, rebar_form);
                            fem->setErosionCriteria(erosion);
                            fem->setLysmerParams(fem_lysmer);
                            fem->syncToDevice();
                            global_fem_solvers_cuda_double[model_id] = std::move(fem);
                        } else {
                            auto fem = std::make_unique<Blast::FEMSolver3DCUDA<float>>();
                            fem->setHourglassCoeff(static_cast<float>(get_json_double(msg, "hourglass_coeff", 0.1)));
                            fem->setContactPenaltyScale(static_cast<float>(get_json_double(msg, "contact_penalty_scale", 1.0)));
                            fem->setContactDamping(static_cast<float>(get_json_double(msg, "contact_damping", 0.20)));
                            fem->setFrictionCoefficients(static_cast<float>(get_json_double(msg, "friction_static", 0.3)), static_cast<float>(get_json_double(msg, "friction_kinetic", 0.2)));
                            {
                                std::string search_str = msg.value("contact_search_method", "Hierarchical Octave Hash Grid");
                                if (search_str == "Linear BVH (Morton Code)" || search_str == "LinearBVH" || search_str == "LBVH") {
                                    fem->setContactSearchMethod(Blast::FEMContactSearchMethod::LinearBVH);
                                } else {
                                    fem->setContactSearchMethod(Blast::FEMContactSearchMethod::HierarchicalOctaveGrid);
                                }
                            }

                            std::string hg_model_str = msg.value("hourglass_model", "FlanaganBelytschkoViscous");
                            if (hg_model_str == "FlanaganBelytschkoViscous") {
                                fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoViscous);
                            } else if (hg_model_str == "KosloffFrazier") {
                                fem->setHourglassModel(Blast::FEMHourglassModel::KosloffFrazier);
                            } else {
                                fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoStiffness);
                            }

                            std::string scheme_str = msg.value("integration_scheme", "OnePointFB");
                            if (scheme_str == "FullGauss8" || scheme_str == "FullIntegration8Pt") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::FullGauss8);
                            } else if (scheme_str == "SelectiveReduced") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::SelectiveReduced);
                            } else if (scheme_str == "OnePointKF") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointKF);
                            } else {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointFB);
                            }

                            auto physics_params = fem->getPhysicsParams();
                            populateFEMPhysicsParams(msg, physics_params);
                            fem->setPhysicsParams(physics_params);
                            if (physics_params.convert_failed_elements_to_mpm) {
                                ensure_mpm_debris_solver(msg, true);
                            }
                            if (global_solver_mpm_3d) {
                                fem->setMPMSolver(global_solver_mpm_3d.get());
                            }
                            if (global_solver_mpm_3d_cuda) {
                                fem->setCUDAMPMSolver(global_solver_mpm_3d_cuda.get());
                            }

                            auto erosion = populateFEMErosionCriteria<float>(msg);
                            ingestFEMObjectsAndDetonators<decltype(fem), float>(fem, msg);
                            std::string rebar_form = msg.value("rebar_formulation", "TimoshenkoBeam3D");
                            ingestStandaloneBeams<decltype(fem), float>(fem, msg, rebar_form);
                            fem->setErosionCriteria(erosion);
                            fem->setLysmerParams(fem_lysmer);
                            fem->syncToDevice();
                            global_fem_solvers_cuda_float[model_id] = std::move(fem);
                        }
                    } else {
                        if (precision == "double") {
                            auto fem = std::make_unique<Blast::FEMSolver3D<double>>();
                            fem->setHourglassCoeff(static_cast<double>(get_json_double(msg, "hourglass_coeff", 0.1)));
                            fem->setContactPenaltyScale(static_cast<double>(get_json_double(msg, "contact_penalty_scale", 1.0)));
                            fem->setContactDamping(static_cast<double>(get_json_double(msg, "contact_damping", 0.20)));
                            fem->setFrictionCoefficients(static_cast<double>(get_json_double(msg, "friction_static", 0.3)), static_cast<double>(get_json_double(msg, "friction_kinetic", 0.2)));
                            {
                                std::string search_str = msg.value("contact_search_method", "Hierarchical Octave Hash Grid");
                                if (search_str == "Linear BVH (Morton Code)" || search_str == "LinearBVH" || search_str == "LBVH") {
                                    fem->setContactSearchMethod(Blast::FEMContactSearchMethod::LinearBVH);
                                } else {
                                    fem->setContactSearchMethod(Blast::FEMContactSearchMethod::HierarchicalOctaveGrid);
                                }
                            }

                            std::string hg_model_str = msg.value("hourglass_model", "FlanaganBelytschkoViscous");
                            if (hg_model_str == "FlanaganBelytschkoViscous") {
                                fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoViscous);
                            } else {
                                fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoStiffness);
                            }

                            std::string scheme_str = msg.value("integration_scheme", "OnePointFB");
                            if (scheme_str == "FullGauss8" || scheme_str == "FullIntegration8Pt") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::FullGauss8);
                            } else if (scheme_str == "SelectiveReduced") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::SelectiveReduced);
                            } else if (scheme_str == "OnePointKF") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointKF);
                            } else {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointFB);
                            }

                            auto physics_params = fem->getPhysicsParams();
                            populateFEMPhysicsParams(msg, physics_params);
                            fem->setPhysicsParams(physics_params);
                            if (physics_params.convert_failed_elements_to_mpm) {
                                ensure_mpm_debris_solver(msg, true);
                            }
                            if (global_solver_mpm_3d) {
                                fem->setMPMSolver(global_solver_mpm_3d.get());
                            }

                            auto erosion = populateFEMErosionCriteria<double>(msg);
                            ingestFEMObjectsAndDetonators<decltype(fem), double>(fem, msg);
                            std::string rebar_form = msg.value("rebar_formulation", "TimoshenkoBeam3D");
                            ingestStandaloneBeams<decltype(fem), double>(fem, msg, rebar_form);
                            fem->setErosionCriteria(erosion);
                            fem->setLysmerParams(fem_lysmer);
                            global_fem_solvers_double[model_id] = std::move(fem);
                        } else {
                            auto fem = std::make_unique<Blast::FEMSolver3D<float>>();
                            fem->setHourglassCoeff(static_cast<float>(get_json_double(msg, "hourglass_coeff", 0.1)));
                            fem->setContactPenaltyScale(static_cast<float>(get_json_double(msg, "contact_penalty_scale", 1.0)));
                            fem->setContactDamping(static_cast<float>(get_json_double(msg, "contact_damping", 0.20)));
                            fem->setFrictionCoefficients(static_cast<float>(get_json_double(msg, "friction_static", 0.3)), static_cast<float>(get_json_double(msg, "friction_kinetic", 0.2)));
                            {
                                std::string search_str = msg.value("contact_search_method", "Hierarchical Octave Hash Grid");
                                if (search_str == "Linear BVH (Morton Code)" || search_str == "LinearBVH" || search_str == "LBVH") {
                                    fem->setContactSearchMethod(Blast::FEMContactSearchMethod::LinearBVH);
                                } else {
                                    fem->setContactSearchMethod(Blast::FEMContactSearchMethod::HierarchicalOctaveGrid);
                                }
                            }

                            std::string hg_model_str = msg.value("hourglass_model", "FlanaganBelytschkoViscous");
                            if (hg_model_str == "FlanaganBelytschkoViscous") {
                                fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoViscous);
                            } else {
                                fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoStiffness);
                            }

                            std::string scheme_str = msg.value("integration_scheme", "OnePointFB");
                            if (scheme_str == "FullGauss8" || scheme_str == "FullIntegration8Pt") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::FullGauss8);
                            } else if (scheme_str == "SelectiveReduced") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::SelectiveReduced);
                            } else if (scheme_str == "OnePointKF") {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointKF);
                            } else {
                                fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointFB);
                            }

                            auto physics_params = fem->getPhysicsParams();
                            populateFEMPhysicsParams(msg, physics_params);
                            fem->setPhysicsParams(physics_params);
                            if (physics_params.convert_failed_elements_to_mpm) {
                                ensure_mpm_debris_solver(msg, true);
                            }
                            if (global_solver_mpm_3d) {
                                fem->setMPMSolver(global_solver_mpm_3d.get());
                            }

                            auto erosion = populateFEMErosionCriteria<float>(msg);
                            ingestFEMObjectsAndDetonators<decltype(fem), float>(fem, msg);
                            std::string rebar_form = msg.value("rebar_formulation", "TimoshenkoBeam3D");
                            ingestStandaloneBeams<decltype(fem), float>(fem, msg, rebar_form);
                            fem->setErosionCriteria(erosion);
                            fem->setLysmerParams(fem_lysmer);
                            global_fem_solvers_float[model_id] = std::move(fem);
                        }
                    }
                    init_gauges(msg);
                    emit_kernel_log("SYSTEM", "3D Hexahedral Explicit FEM Solver Initialized for model " + model_id, 0.0, "3d");
                    emit_telemetry_fem_3d(0.0, false);
                } else if (command == "STEP_FEM_3D") {
                    if (msg.contains("modelId")) global_model_id = msg["modelId"].get<std::string>();
                    else if (msg.contains("model_id")) global_model_id = msg["model_id"].get<std::string>();
                    int steps = get_json_int(msg, "steps", 1);
                    global_cfl_fem_3d = static_cast<float>(get_json_double(msg, "cfl", 0.6));
                    if (msg.contains("endtime")) global_endtime_fem_3d = msg.value("endtime", 1.0);
                    if (msg.contains("refresh_rate")) {
                        global_refresh_rate_fem_3d = get_json_double(msg, "refresh_rate", 0.5);
                    }
                    global_exec_until_end_fem_3d = false;
                    if (!sim_fem_3d_running) {
                        global_target_steps_fem_3d = steps;
                        sim_fem_3d_running = true;
                        sim_fem_3d_paused = false;
                        sim_fem_3d_terminate = false;
                        std::thread(worker_fem_3d_thread_func).detach();
                    } else {
                        global_target_steps_fem_3d.fetch_add(steps);
                        sim_fem_3d_paused = false;
                    }

                } else if (command == "EXEC_ALL_FEM_3D") {
                    if (msg.contains("modelId")) global_model_id = msg["modelId"].get<std::string>();
                    else if (msg.contains("model_id")) global_model_id = msg["model_id"].get<std::string>();
                    global_cfl_fem_3d = static_cast<float>(get_json_double(msg, "cfl", 0.6));
                    if (msg.contains("endtime")) global_endtime_fem_3d = msg.value("endtime", 1.0);
                    if (msg.contains("refresh_rate")) {
                        global_refresh_rate_fem_3d = get_json_double(msg, "refresh_rate", 0.5);
                    }
                    global_exec_until_end_fem_3d = true;
                    if (!sim_fem_3d_running) {
                        sim_fem_3d_running = true;
                        sim_fem_3d_paused = false;
                        sim_fem_3d_terminate = false;
                        std::thread(worker_fem_3d_thread_func).detach();
                    } else {
                        sim_fem_3d_paused = false;
                    }

                } else if (command == "PAUSE_FEM_3D") {
                    sim_fem_3d_paused = true;
                    global_target_steps_fem_3d = 0;

                } else if (command == "TERMINATE_FEM_3D") {
                    sim_fem_3d_terminate = true;
                    while (sim_fem_3d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_fem_solvers_float.clear();
                    global_fem_solvers_double.clear();
                    global_fem_solvers_cuda_float.clear();
                    global_fem_solvers_cuda_double.clear();
                } else if (command == "STEP_FSI_3D") {
                    int steps = get_json_int(msg, "steps", 1);
                    global_cfl_fsi_3d = static_cast<float>(get_json_double(msg, "cfl", 0.6));
                    if (msg.contains("endtime")) global_endtime_fsi_3d = msg.value("endtime", 1.0);
                    global_exec_until_end_fsi_3d = false;
                    if (!sim_fsi_3d_running) {
                        global_target_steps_fsi_3d = steps;
                        sim_fsi_3d_running = true;
                        sim_fsi_3d_paused = false;
                        sim_fsi_3d_terminate = false;
                        std::thread(worker_fsi_3d_thread_func).detach();
                    } else {
                        global_target_steps_fsi_3d.fetch_add(steps);
                        sim_fsi_3d_paused = false;
                    }

                } else if (command == "EXEC_ALL_FSI_3D") {
                    global_cfl_fsi_3d = static_cast<float>(get_json_double(msg, "cfl", 0.6));
                    if (msg.contains("endtime")) global_endtime_fsi_3d = msg.value("endtime", 1.0);
                    global_exec_until_end_fsi_3d = true;
                    if (!sim_fsi_3d_running) {
                        sim_fsi_3d_running = true;
                        sim_fsi_3d_paused = false;
                        sim_fsi_3d_terminate = false;
                        std::thread(worker_fsi_3d_thread_func).detach();
                    } else {
                        sim_fsi_3d_paused = false;
                    }

                } else if (command == "PAUSE_FSI_3D") {
                    sim_fsi_3d_paused = true;
                    global_target_steps_fsi_3d = 0;

                } else if (command == "TERMINATE_FSI_3D") {
                    sim_fsi_3d_terminate = true;
                    while (sim_fsi_3d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_3d.reset();
                    global_phase_particles_3d.reset();
                    global_solver_mpm_3d.reset();
                    global_solver_mpm_3d_cuda.reset();
                } else if (command == "INIT_FEM_FSI_3D") {
                    try {
                        sim3d_terminate = true;
                        sim_fem_3d_terminate = true;
                        sim_fem_fsi_3d_terminate = true;
                        while (sim3d_running.load() || sim3d_init_in_progress.load() || sim_fem_3d_running.load() || sim_fem_fsi_3d_running.load()) {
                            std::this_thread::sleep_for(std::chrono::milliseconds(5));
                        }
                        global_solver_3d.reset();
                        global_phase_particles_3d.reset();
                        global_fem_solvers_float.clear();
                        global_fem_solvers_double.clear();
                        global_fem_solvers_cuda_float.clear();
                        global_fem_solvers_cuda_double.clear();
                        global_fem_fsi_couplers_float.clear();
                        global_fem_fsi_couplers_double.clear();
                        global_fem_fsi_couplers_cuda_float.clear();
                        global_fem_fsi_couplers_cuda_double.clear();

                        sim3d_terminate = false;
                        sim3d_paused = false;
                        sim_fem_3d_terminate = false;
                        sim_fem_3d_paused = false;
                        sim_fem_fsi_3d_terminate = false;
                        sim_fem_fsi_3d_paused = false;
                        step_progress_3d = 0;
                        global_step_3d = 0;
                        global_step_fem_fsi_3d = 0;
                        global_t3d = 0.0;
                        global_wallclock_3d = 0.0;
                        global_endtime_fem_fsi_3d = msg.value("endtime", 1.0);

                        global_slices_3d.clear();
                        if (msg.contains("slices")) {
                            for (const auto& s_msg : msg["slices"]) {
                                Slice3D s;
                                s.axis = s_msg.value("axis", "xy");
                                s.offset = s_msg.value("offset", 0.5);
                                s.stride = s_msg.value("stride", 1);
                                s.enabled = get_json_bool(s_msg, "enabled", true);
                                if (s.stride < 1) s.stride = 1;
                                if (s_msg.contains("quantities") && s_msg["quantities"].is_array()) {
                                    for (const auto& q : s_msg["quantities"]) {
                                        if (q.is_string()) s.quantities.push_back(q.get<std::string>());
                                    }
                                } else if (s_msg.contains("quantity") && s_msg["quantity"].is_string()) {
                                    s.quantities.push_back(s_msg["quantity"].get<std::string>());
                                }
                                global_slices_3d.push_back(s);
                            }
                        } else {
                            Slice3D s;
                            s.axis = "xy";
                            s.offset = 0.5;
                            s.stride = 1;
                            s.enabled = true;
                            s.quantities.push_back("pressure");
                            global_slices_3d.push_back(s);
                        }

                        // 1. Initialize CFD 3D solver
                        double cellSize = get_json_double(msg, "cell_size", 0.01);
                        double xmin = get_json_double(msg, "xmin", 0.0);
                        double ymin = get_json_double(msg, "ymin", 0.0);
                        double zmin = get_json_double(msg, "zmin", 0.0);
                        double xmax = get_json_double(msg, "xmax", xmin + 1.0);
                        double ymax = get_json_double(msg, "ymax", ymin + 1.0);
                        double zmax = get_json_double(msg, "zmax", zmin + 1.0);
                        int default_nx = std::max(1, static_cast<int>(std::round((xmax - xmin) / cellSize)));
                        int default_ny = std::max(1, static_cast<int>(std::round((ymax - ymin) / cellSize)));
                        int default_nz = std::max(1, static_cast<int>(std::round((zmax - zmin) / cellSize)));
                        int nx = get_json_int(msg, "nx", default_nx);
                        int ny = get_json_int(msg, "ny", default_ny);
                        int nz = get_json_int(msg, "nz", default_nz);
                        if (nx <= 0) nx = default_nx;
                        if (ny <= 0) ny = default_ny;
                        if (nz <= 0) nz = default_nz;
                        std::string device = msg.value("device", "cpu");
                        std::string precision = msg.value("precision", "single");
                        std::string init_mode = msg.value("init_mode", "Multi-Material JWL");
                        std::string explosive_type = msg.value("explosive_type", "");
                        std::string material_type = msg.value("material_type", "");
                        bool is_ideal_gas_3d = (get_json_bool(msg, "is_ideal_gas", false) || init_mode == "Ideal Gas" || explosive_type == "MaterialIdealGas" || material_type == "Ideal Gas Charge");
                        bool is_multimat = !is_ideal_gas_3d;

                        select_cuda_device(device);
                        bool use_gpu = is_cuda_device(device) || device == "gpu" || device == "cuda";

                        if (use_gpu) {
                            if (precision == "single" || precision == "float") {
                                if (is_multimat) global_solver_3d = std::make_unique<CFDSolver3DCuda<float, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                                else global_solver_3d = std::make_unique<CFDSolver3DCuda<float, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                            } else {
                                if (is_multimat) global_solver_3d = std::make_unique<CFDSolver3DCuda<double, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                                else global_solver_3d = std::make_unique<CFDSolver3DCuda<double, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                            }
                        } else {
                            if (precision == "single" || precision == "float") {
                                if (is_multimat) global_solver_3d = std::make_unique<CFDSolver3DImpl<float, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                                else global_solver_3d = std::make_unique<CFDSolver3DImpl<float, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                            } else {
                                if (is_multimat) global_solver_3d = std::make_unique<CFDSolver3DImpl<double, true>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                                else global_solver_3d = std::make_unique<CFDSolver3DImpl<double, false>>(nx, ny, nz, cellSize, xmin, ymin, zmin);
                            }
                        }

                        std::string flux_scheme = msg.value("flux_scheme", "AUSM+");
                        int spatial_order = 2;
                        int temporal_order = 4;
                        parse_cfd_space_time_scheme(msg, spatial_order, temporal_order, 4);

                        global_solver_3d->setFluxScheme(flux_scheme);
                        global_solver_3d->setSpatialOrder(spatial_order);
                        global_solver_3d->setTemporalOrder(temporal_order);
                        apply_cfd_tait_config(msg, global_solver_3d.get());

                        Charge3DParams cp;
                        std::string shape_str = msg.value("charge_shape", "Sphere");
                        if (shape_str == "Sphere") cp.shape_type = 0;
                        else if (shape_str == "Block") cp.shape_type = 1;
                        else cp.shape_type = 2;
                        cp.x = get_json_double(msg, "charge_x", 0.0);
                        cp.y = get_json_double(msg, "charge_y", 0.0);
                        cp.z = get_json_double(msg, "charge_z", 0.0);
                        cp.radius = get_json_double(msg, "charge_radius", 0.1);
                        cp.height = get_json_double(msg, "charge_height", 0.2);
                        if (msg.contains("charge_aspect_ratio") && !msg.contains("charge_height")) {
                            double ar = get_json_double(msg, "charge_aspect_ratio", 1.0);
                            if (ar > 0.0) cp.height = 2.0 * cp.radius * ar;
                        }
                        cp.lx = get_json_double(msg, "charge_lx", 0.1);
                        cp.ly = get_json_double(msg, "charge_ly", 0.1);
                        cp.lz = get_json_double(msg, "charge_lz", 0.1);
                        cp.rot_x = get_json_double(msg, "charge_rot_x", get_json_double(msg, "rot_x", 0.0));
                        cp.rot_y = get_json_double(msg, "charge_rot_y", get_json_double(msg, "rot_y", 0.0));
                        cp.rot_z = get_json_double(msg, "charge_rot_z", get_json_double(msg, "rot_z", 0.0));

                        if (init_mode == "From1D" || init_mode == "From2D") {
                            cp.radius = 0.0;
                            cp.lx = 0.0;
                            cp.ly = 0.0;
                            cp.lz = 0.0;
                        }

                        MultiMat::MaterialSet matSet = parseMaterialSet(msg);
                        double ambient_rho = get_json_double(msg, "ambient_rho", 1.225648589);
                        double ambient_p = get_json_double(msg, "atm_pressure", 101325.0);

                        global_solver_3d->setDetonatorLocation(
                            get_json_double(msg, "trigger_x", get_json_double(msg, "detonator_x", cp.x)),
                            get_json_double(msg, "trigger_y", get_json_double(msg, "detonator_y", cp.y)),
                            get_json_double(msg, "trigger_z", get_json_double(msg, "detonator_z", cp.z)),
                            get_json_double(msg, "time_delay", get_json_double(msg, "start_time", get_json_double(msg, "detonator_time", 0.0)))
                        );

                        if (init_mode == "Hydrostatic_Stratified_3D" || init_mode == "hydrostatic_stratified_3d" || get_json_bool(msg, "stratified_equilibrium", false)) {
                            Blast::Stratified3DParams strat = parse_stratified_params(msg, ambient_rho, ambient_p);
                            double gx = get_json_double(msg, "gravity_x", get_json_double(msg, "gx", 0.0));
                            double gy = get_json_double(msg, "gravity_y", get_json_double(msg, "gy", 0.0));
                            double gz = strat.gravity_z;
                            global_solver_3d->setGravity(gx, gy, gz);
                            global_solver_3d->setStratifiedInitialCondition(cp, matSet, strat);
                        } else {
                            if (msg.contains("gravity_z") || msg.contains("gz") || msg.contains("gravity_y") || msg.contains("gy") || msg.contains("gravity_x") || msg.contains("gx")) {
                                double gx = get_json_double(msg, "gravity_x", get_json_double(msg, "gx", 0.0));
                                double gy = get_json_double(msg, "gravity_y", get_json_double(msg, "gy", 0.0));
                                double gz = get_json_double(msg, "gravity_z", get_json_double(msg, "gz", 0.0));
                                global_solver_3d->setGravity(gx, gy, gz);
                            }
                            global_solver_3d->setInitialCondition(cp, matSet, ambient_rho, ambient_p);
                        }

                        {
                            std::lock_guard<std::mutex> lock(g_pending_remap_mutex);
                            if (g_pending_remap.has_pending) {
                                if (init_mode == "From1D" || init_mode == "From2D") {
                                    std::cout << "[INFO] Applying queued pending " << g_pending_remap.type << " remap onto 3D solver in INIT_FEM_FSI_3D..." << std::endl;
                                    apply_remap_payload(g_pending_remap.msg, g_pending_remap.type, global_solver_3d.get(), nullptr, nullptr);
                                }
                                g_pending_remap.has_pending = false;
                            }
                        }

                        auto map_bc_3d = [](const std::string& str) {
                            if (str == "Terminate" || str == "TERMINATE") return BCType3D::TERMINATE;
                            if (str == "OUTFLOW_RIEMANN" || str == "Riemann" || str == "NonReflecting" || str == "Absorbing" || str == "Lysmer" || str == "Transmitting" || str == "TRANSMISSIVE") return BCType3D::OUTFLOW_RIEMANN;
                            if (str == "Outflow" || str == "Neumann") return BCType3D::TRANSMISSIVE;
                            return BCType3D::REFLECTIVE;
                        };
                        global_solver_3d->setBoundaryConditions(
                            map_bc_3d(msg.value("bc_x_min", "Reflecting")), map_bc_3d(msg.value("bc_x_max", "Transmitting")),
                            map_bc_3d(msg.value("bc_y_min", "Reflecting")), map_bc_3d(msg.value("bc_y_max", "Transmitting")),
                            map_bc_3d(msg.value("bc_z_min", "Reflecting")), map_bc_3d(msg.value("bc_z_max", "Transmitting"))
                        );

                        // 2. Initialize 3D FEM Solver and Coupler
                        std::string model_id = msg.value("modelId", msg.value("model_id", global_model_id.empty() ? "default_fem" : global_model_id));
                        global_model_id = model_id;
                        auto fem_lysmer = populateFEMLysmerParams(msg);

                        if (use_gpu) {
                            if (precision == "double") {
                                auto fem = std::make_unique<Blast::FEMSolver3DCUDA<double>>();
                                fem->setHourglassCoeff(static_cast<double>(get_json_double(msg, "hourglass_coeff", 0.1)));
                                fem->setContactPenaltyScale(static_cast<double>(get_json_double(msg, "contact_penalty_scale", 1.0)));
                                fem->setContactDamping(static_cast<double>(get_json_double(msg, "contact_damping", 0.20)));
                                fem->setFrictionCoefficients(static_cast<double>(get_json_double(msg, "friction_static", 0.3)), static_cast<double>(get_json_double(msg, "friction_kinetic", 0.2)));
                                {
                                    std::string search_str = msg.value("contact_search_method", "Hierarchical Octave Hash Grid");
                                    if (search_str == "Linear BVH (Morton Code)" || search_str == "LinearBVH" || search_str == "LBVH") {
                                        fem->setContactSearchMethod(Blast::FEMContactSearchMethod::LinearBVH);
                                    } else {
                                        fem->setContactSearchMethod(Blast::FEMContactSearchMethod::HierarchicalOctaveGrid);
                                    }
                                }

                                std::string hg_model_str = msg.value("hourglass_model", "FlanaganBelytschkoViscous");
                                if (hg_model_str == "FlanaganBelytschkoViscous") {
                                    fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoViscous);
                                } else if (hg_model_str == "KosloffFrazier") {
                                    fem->setHourglassModel(Blast::FEMHourglassModel::KosloffFrazier);
                                } else {
                                    fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoStiffness);
                                }

                                std::string scheme_str = msg.value("integration_scheme", "OnePointFB");
                                if (scheme_str == "FullGauss8" || scheme_str == "FullIntegration8Pt") {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::FullGauss8);
                                } else if (scheme_str == "SelectiveReduced") {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::SelectiveReduced);
                                } else if (scheme_str == "OnePointKF") {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointKF);
                                } else {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointFB);
                                }

                                auto physics_params = fem->getPhysicsParams();
                                populateFEMPhysicsParams(msg, physics_params);
                                fem->setPhysicsParams(physics_params);
                                if (physics_params.convert_failed_elements_to_mpm || (msg.contains("mpm_objects") && msg["mpm_objects"].is_array() && !msg["mpm_objects"].empty())) {
                                    ensure_mpm_debris_solver(msg, true);
                                }
                                if (global_solver_mpm_3d) {
                                    fem->setMPMSolver(global_solver_mpm_3d.get());
                                }
                                if (global_solver_mpm_3d_cuda) {
                                    fem->setCUDAMPMSolver(global_solver_mpm_3d_cuda.get());
                                }

                                auto erosion = populateFEMErosionCriteria<double>(msg);
                                ingestFEMObjectsAndDetonators<decltype(fem), double>(fem, msg);
                                std::string rebar_form = msg.value("rebar_formulation", "TimoshenkoBeam3D");
                                ingestStandaloneBeams<decltype(fem), double>(fem, msg, rebar_form);
                                fem->setErosionCriteria(erosion);
                                fem->setLysmerParams(fem_lysmer);
                                fem->syncToDevice();

                                auto coupler = std::make_unique<Blast::FEMFSICoupler3DCUDA<double>>();
                                coupler->attachSolvers(global_solver_3d.get(), fem.get());
                                configureFEMFSICouplerCUDA<decltype(coupler), double>(coupler, msg);
                                global_fem_solvers_cuda_double[model_id] = std::move(fem);
                                global_fem_fsi_couplers_cuda_double[model_id] = std::move(coupler);
                            } else {
                                auto fem = std::make_unique<Blast::FEMSolver3DCUDA<float>>();
                                fem->setHourglassCoeff(static_cast<float>(get_json_double(msg, "hourglass_coeff", 0.1)));
                                fem->setContactPenaltyScale(static_cast<float>(get_json_double(msg, "contact_penalty_scale", 1.0)));
                                fem->setContactDamping(static_cast<float>(get_json_double(msg, "contact_damping", 0.20)));
                                fem->setFrictionCoefficients(static_cast<float>(get_json_double(msg, "friction_static", 0.3)), static_cast<float>(get_json_double(msg, "friction_kinetic", 0.2)));
                                {
                                    std::string search_str = msg.value("contact_search_method", "Hierarchical Octave Hash Grid");
                                    if (search_str == "Linear BVH (Morton Code)" || search_str == "LinearBVH" || search_str == "LBVH") {
                                        fem->setContactSearchMethod(Blast::FEMContactSearchMethod::LinearBVH);
                                    } else {
                                        fem->setContactSearchMethod(Blast::FEMContactSearchMethod::HierarchicalOctaveGrid);
                                    }
                                }

                                std::string hg_model_str = msg.value("hourglass_model", "FlanaganBelytschkoViscous");
                                if (hg_model_str == "FlanaganBelytschkoViscous") {
                                    fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoViscous);
                                } else if (hg_model_str == "KosloffFrazier") {
                                    fem->setHourglassModel(Blast::FEMHourglassModel::KosloffFrazier);
                                } else {
                                    fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoStiffness);
                                }

                                std::string scheme_str = msg.value("integration_scheme", "OnePointFB");
                                if (scheme_str == "FullGauss8" || scheme_str == "FullIntegration8Pt") {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::FullGauss8);
                                } else if (scheme_str == "SelectiveReduced") {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::SelectiveReduced);
                                } else if (scheme_str == "OnePointKF") {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointKF);
                                } else {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointFB);
                                }

                                auto physics_params = fem->getPhysicsParams();
                                populateFEMPhysicsParams(msg, physics_params);
                                fem->setPhysicsParams(physics_params);
                                if (physics_params.convert_failed_elements_to_mpm || (msg.contains("mpm_objects") && msg["mpm_objects"].is_array() && !msg["mpm_objects"].empty())) {
                                    ensure_mpm_debris_solver(msg, true);
                                }
                                if (global_solver_mpm_3d) {
                                    fem->setMPMSolver(global_solver_mpm_3d.get());
                                }
                                if (global_solver_mpm_3d_cuda) {
                                    fem->setCUDAMPMSolver(global_solver_mpm_3d_cuda.get());
                                }

                                auto erosion = populateFEMErosionCriteria<float>(msg);
                                ingestFEMObjectsAndDetonators<decltype(fem), float>(fem, msg);
                                std::string rebar_form = msg.value("rebar_formulation", "TimoshenkoBeam3D");
                                ingestStandaloneBeams<decltype(fem), float>(fem, msg, rebar_form);
                                fem->setErosionCriteria(erosion);
                                fem->setLysmerParams(fem_lysmer);
                                fem->syncToDevice();

                                auto coupler = std::make_unique<Blast::FEMFSICoupler3DCUDA<float>>();
                                coupler->attachSolvers(global_solver_3d.get(), fem.get());
                                configureFEMFSICouplerCUDA<decltype(coupler), float>(coupler, msg);
                                global_fem_solvers_cuda_float[model_id] = std::move(fem);
                                global_fem_fsi_couplers_cuda_float[model_id] = std::move(coupler);
                            }
                        } else {
                            if (precision == "double") {
                                auto fem = std::make_unique<Blast::FEMSolver3D<double>>();
                                fem->setHourglassCoeff(static_cast<double>(get_json_double(msg, "hourglass_coeff", 0.1)));
                                fem->setContactPenaltyScale(static_cast<double>(get_json_double(msg, "contact_penalty_scale", 1.0)));
                                fem->setContactDamping(static_cast<double>(get_json_double(msg, "contact_damping", 0.20)));
                                fem->setFrictionCoefficients(static_cast<double>(get_json_double(msg, "friction_static", 0.3)), static_cast<double>(get_json_double(msg, "friction_kinetic", 0.2)));
                                {
                                    std::string search_str = msg.value("contact_search_method", "Hierarchical Octave Hash Grid");
                                    if (search_str == "Linear BVH (Morton Code)" || search_str == "LinearBVH" || search_str == "LBVH") {
                                        fem->setContactSearchMethod(Blast::FEMContactSearchMethod::LinearBVH);
                                    } else {
                                        fem->setContactSearchMethod(Blast::FEMContactSearchMethod::HierarchicalOctaveGrid);
                                    }
                                }

                                std::string hg_model_str = msg.value("hourglass_model", "FlanaganBelytschkoViscous");
                                if (hg_model_str == "FlanaganBelytschkoViscous") {
                                    fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoViscous);
                                } else if (hg_model_str == "KosloffFrazier") {
                                    fem->setHourglassModel(Blast::FEMHourglassModel::KosloffFrazier);
                                } else {
                                    fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoStiffness);
                                }

                                std::string scheme_str = msg.value("integration_scheme", "OnePointFB");
                                if (scheme_str == "FullGauss8" || scheme_str == "FullIntegration8Pt") {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::FullGauss8);
                                } else if (scheme_str == "SelectiveReduced") {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::SelectiveReduced);
                                } else if (scheme_str == "OnePointKF") {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointKF);
                                } else {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointFB);
                                }

                                auto physics_params = fem->getPhysicsParams();
                                populateFEMPhysicsParams(msg, physics_params);
                                fem->setPhysicsParams(physics_params);
                                if (physics_params.convert_failed_elements_to_mpm || (msg.contains("mpm_objects") && msg["mpm_objects"].is_array() && !msg["mpm_objects"].empty())) {
                                    ensure_mpm_debris_solver(msg, false);
                                }
                                if (global_solver_mpm_3d) {
                                    fem->setMPMSolver(global_solver_mpm_3d.get());
                                }

                                auto erosion = populateFEMErosionCriteria<double>(msg);
                                ingestFEMObjectsAndDetonators<decltype(fem), double>(fem, msg);
                                std::string rebar_form = msg.value("rebar_formulation", "TimoshenkoBeam3D");
                                ingestStandaloneBeams<decltype(fem), double>(fem, msg, rebar_form);
                                fem->setErosionCriteria(erosion);
                                fem->setLysmerParams(fem_lysmer);

                                auto coupler = std::make_unique<Blast::FEMFSICoupler3D<double>>();
                                coupler->attachSolvers(global_solver_3d.get(), fem.get());
                                configureFEMFSICouplerCPU<decltype(coupler), double>(coupler, msg);
                                global_fem_solvers_double[model_id] = std::move(fem);
                                global_fem_fsi_couplers_double[model_id] = std::move(coupler);
                            } else {
                                auto fem = std::make_unique<Blast::FEMSolver3D<float>>();
                                fem->setHourglassCoeff(static_cast<float>(get_json_double(msg, "hourglass_coeff", 0.1)));
                                fem->setContactPenaltyScale(static_cast<float>(get_json_double(msg, "contact_penalty_scale", 1.0)));
                                fem->setContactDamping(static_cast<float>(get_json_double(msg, "contact_damping", 0.20)));
                                fem->setFrictionCoefficients(static_cast<float>(get_json_double(msg, "friction_static", 0.3)), static_cast<float>(get_json_double(msg, "friction_kinetic", 0.2)));
                                {
                                    std::string search_str = msg.value("contact_search_method", "Hierarchical Octave Hash Grid");
                                    if (search_str == "Linear BVH (Morton Code)" || search_str == "LinearBVH" || search_str == "LBVH") {
                                        fem->setContactSearchMethod(Blast::FEMContactSearchMethod::LinearBVH);
                                    } else {
                                        fem->setContactSearchMethod(Blast::FEMContactSearchMethod::HierarchicalOctaveGrid);
                                    }
                                }

                                std::string hg_model_str = msg.value("hourglass_model", "FlanaganBelytschkoViscous");
                                if (hg_model_str == "FlanaganBelytschkoViscous") {
                                    fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoViscous);
                                } else if (hg_model_str == "KosloffFrazier") {
                                    fem->setHourglassModel(Blast::FEMHourglassModel::KosloffFrazier);
                                } else {
                                    fem->setHourglassModel(Blast::FEMHourglassModel::FlanaganBelytschkoStiffness);
                                }

                                std::string scheme_str = msg.value("integration_scheme", "OnePointFB");
                                if (scheme_str == "FullGauss8" || scheme_str == "FullIntegration8Pt") {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::FullGauss8);
                                } else if (scheme_str == "SelectiveReduced") {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::SelectiveReduced);
                                } else if (scheme_str == "OnePointKF") {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointKF);
                                } else {
                                    fem->setIntegrationScheme(Blast::FEMIntegrationScheme::OnePointFB);
                                }

                                auto physics_params = fem->getPhysicsParams();
                                populateFEMPhysicsParams(msg, physics_params);
                                fem->setPhysicsParams(physics_params);
                                if (physics_params.convert_failed_elements_to_mpm || (msg.contains("mpm_objects") && msg["mpm_objects"].is_array() && !msg["mpm_objects"].empty())) {
                                    ensure_mpm_debris_solver(msg);
                                }
                                if (global_solver_mpm_3d) {
                                    fem->setMPMSolver(global_solver_mpm_3d.get());
                                }

                                auto erosion = populateFEMErosionCriteria<float>(msg);
                                ingestFEMObjectsAndDetonators<decltype(fem), float>(fem, msg);
                                std::string rebar_form = msg.value("rebar_formulation", "TimoshenkoBeam3D");
                                ingestStandaloneBeams<decltype(fem), float>(fem, msg, rebar_form);
                                fem->setErosionCriteria(erosion);
                                fem->setLysmerParams(fem_lysmer);

                                auto coupler = std::make_unique<Blast::FEMFSICoupler3D<float>>();
                                coupler->attachSolvers(global_solver_3d.get(), fem.get());
                                configureFEMFSICouplerCPU<decltype(coupler), float>(coupler, msg);
                                global_fem_solvers_float[model_id] = std::move(fem);
                                global_fem_fsi_couplers_float[model_id] = std::move(coupler);
                            }
                        }

                        // Prime d_geom with FEM surface facet rasterization BEFORE init_gauges().
                        // Without this, setGauges() sees all-zero geometry and snaps probes
                        // to wrong cells (e.g. into solid wall interior). The coupler normally
                        // rasterizes on the very first timestep, but setGauges must run at init
                        // time with real geometry to position probes correctly.
                        if (global_fem_fsi_couplers_cuda_float.count(model_id) &&
                            global_fem_fsi_couplers_cuda_float[model_id]) {
                            global_fem_fsi_couplers_cuda_float[model_id]->primeInitialGeometry();
                        } else if (!global_fem_fsi_couplers_cuda_float.empty()) {
                            global_fem_fsi_couplers_cuda_float.begin()->second->primeInitialGeometry();
                        } else if (global_fem_fsi_couplers_cuda_double.count(model_id) &&
                                   global_fem_fsi_couplers_cuda_double[model_id]) {
                            global_fem_fsi_couplers_cuda_double[model_id]->primeInitialGeometry();
                        } else if (!global_fem_fsi_couplers_cuda_double.empty()) {
                            global_fem_fsi_couplers_cuda_double.begin()->second->primeInitialGeometry();
                        }

                        setup_phase_tracking_particles_3d(msg);
                        init_gauges(msg);
                        emit_kernel_log("SYSTEM", "3D Coupled Multi-Physics Solver (CFD + MPM + FEM) Initialized", 0.0, "3d");
                        emit_telemetry_3d(0.0, false);
                        emit_telemetry_fem_3d(0.0, false);

                        nlohmann::json prog_report;
                        prog_report["type"] = "progress";
                        prog_report["percent"] = 100;
                        prog_report["scope"] = "3d";
                        prog_report["mode"] = "INIT_FEM_FSI_3D";
                        prog_report["sim_time"] = 0.0;
                        prog_report["step"] = 0;
                        {
                            std::lock_guard<std::mutex> lock(cout_mutex);
                            std::cout << prog_report.dump() << std::endl;
                        }
                    } catch (const std::exception& e) {
                        std::cerr << "[ERROR] Exception in INIT_FEM_FSI_3D: " << e.what() << std::endl;
                        emit_kernel_log("ERROR", std::string("FEM-FSI 3D initialization failed: ") + e.what(), 0.0, "3d");
                        std::exit(1);
                    } catch (...) {
                        std::cerr << "[ERROR] Unknown exception in INIT_FEM_FSI_3D" << std::endl;
                        emit_kernel_log("ERROR", "FEM-FSI 3D initialization failed with unknown error", 0.0, "3d");
                        std::exit(1);
                    }
                } else if (command == "STEP_FEM_FSI_3D") {
                    int steps = get_json_int(msg, "steps", 1);
                    global_cfl_fem_fsi_3d = static_cast<float>(get_json_double(msg, "cfl", 0.6));
                    if (msg.contains("endtime")) global_endtime_fem_fsi_3d = msg.value("endtime", 1.0);
                    global_exec_until_end_fem_fsi_3d = false;
                    if (!sim_fem_fsi_3d_running) {
                        global_target_steps_fem_fsi_3d = steps;
                        sim_fem_fsi_3d_running = true;
                        sim_fem_fsi_3d_paused = false;
                        sim_fem_fsi_3d_terminate = false;
                        std::thread(worker_fem_fsi_3d_thread_func).detach();
                    } else {
                        global_target_steps_fem_fsi_3d.fetch_add(steps);
                        sim_fem_fsi_3d_paused = false;
                    }
                } else if (command == "EXEC_ALL_FEM_FSI_3D") {
                    global_cfl_fem_fsi_3d = static_cast<float>(get_json_double(msg, "cfl", 0.6));
                    if (msg.contains("endtime")) global_endtime_fem_fsi_3d = msg.value("endtime", 1.0);
                    global_exec_until_end_fem_fsi_3d = true;
                    if (!sim_fem_fsi_3d_running) {
                        sim_fem_fsi_3d_running = true;
                        sim_fem_fsi_3d_paused = false;
                        sim_fem_fsi_3d_terminate = false;
                        std::thread(worker_fem_fsi_3d_thread_func).detach();
                    } else {
                        sim_fem_fsi_3d_paused = false;
                    }
                } else if (command == "PAUSE_FEM_FSI_3D") {
                    sim_fem_fsi_3d_paused = true;
                    global_target_steps_fem_fsi_3d = 0;
                } else if (command == "TERMINATE_FEM_FSI_3D") {
                    sim_fem_fsi_3d_terminate = true;
                    while (sim_fem_fsi_3d_running.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_3d.reset();
                    global_fem_solvers_float.clear();
                    global_fem_solvers_double.clear();
                    global_fem_solvers_cuda_float.clear();
                    global_fem_solvers_cuda_double.clear();
                    global_fem_fsi_couplers_float.clear();
                    global_fem_fsi_couplers_double.clear();
                    global_fem_fsi_couplers_cuda_float.clear();
                    global_fem_fsi_couplers_cuda_double.clear();
                } else if (command == "REMAP") {
                    if (sim3d_init_in_progress.load()) {
                        std::lock_guard<std::mutex> lock(g_pending_remap_mutex);
                        g_pending_remap.has_pending = true;
                        g_pending_remap.type = "1D";
                        g_pending_remap.msg = msg;
                        emit_kernel_log("REMAP", "Received 1D remap payload during 3D initialization. Queued for completion.", 0.0, "3d");
                    } else if (global_solver_3d) {
                        apply_remap_payload(msg, "1D", global_solver_3d.get(), nullptr, nullptr);
                    } else if (global_solver_2d) {
                        apply_remap_payload(msg, "1D", nullptr, global_solver_2d.get(), nullptr);
                    } else if (global_solver_2d_cuda) {
                        apply_remap_payload(msg, "1D", nullptr, nullptr, global_solver_2d_cuda.get());
                    } else {
                        std::lock_guard<std::mutex> lock(g_pending_remap_mutex);
                        g_pending_remap.has_pending = true;
                        g_pending_remap.type = "1D";
                        g_pending_remap.msg = msg;
                        emit_kernel_log("REMAP", "Received 1D remap payload before solver creation. Queued for completion.", 0.0, "3d");
                    }
                } else if (command == "REMAP_2D") {
                    if (sim3d_init_in_progress.load()) {
                        std::lock_guard<std::mutex> lock(g_pending_remap_mutex);
                        g_pending_remap.has_pending = true;
                        g_pending_remap.type = "2D";
                        g_pending_remap.msg = msg;
                        emit_kernel_log("REMAP_2D", "Received 2D remap payload during 3D initialization. Queued for completion.", 0.0, "3d");
                    } else if (global_solver_3d) {
                        apply_remap_payload(msg, "2D", global_solver_3d.get(), nullptr, nullptr);
                    } else {
                        std::lock_guard<std::mutex> lock(g_pending_remap_mutex);
                        g_pending_remap.has_pending = true;
                        g_pending_remap.type = "2D";
                        g_pending_remap.msg = msg;
                        emit_kernel_log("REMAP_2D", "Received 2D remap payload before solver creation. Queued for completion.", 0.0, "3d");
                    }
                } else if (command == "STEP_3D") {
                    if (sim3d_init_in_progress.load()) {
                        std::lock_guard<std::mutex> lock(g_pending_exec_3d_mutex);
                        g_pending_exec_3d.has_pending = true;
                        g_pending_exec_3d.command = "STEP_3D";
                        g_pending_exec_3d.msg = msg;
                        emit_kernel_log("INFO", "Received STEP_3D during 3D initialization. Queued for execution upon init completion.", 0.0, "3d");
                        continue;
                    }
                    if (!global_solver_3d) continue;
                    init_gauges(msg);
                    int steps = msg.value("steps", 1);
                    global_cfl_3d = msg.value("cfl", 0.6);
                    if (msg.contains("endtime")) global_endtime_3d = msg.value("endtime", 1.0);
                    global_exec_until_end_3d = false;
                    if (!sim3d_running) {
                        global_target_steps_3d = steps;
                        sim3d_running = true;
                        sim3d_paused = false;
                        sim3d_terminate = false;
                        std::thread(worker_3d_thread_func).detach();
                    } else {
                        global_target_steps_3d.fetch_add(steps);
                        sim3d_paused = false;
                    }
                } else if (command == "EXEC_ALL_3D") {
                    if (sim3d_init_in_progress.load()) {
                        std::lock_guard<std::mutex> lock(g_pending_exec_3d_mutex);
                        g_pending_exec_3d.has_pending = true;
                        g_pending_exec_3d.command = "EXEC_ALL_3D";
                        g_pending_exec_3d.msg = msg;
                        emit_kernel_log("INFO", "Received EXEC_ALL_3D during 3D initialization. Queued for execution upon init completion.", 0.0, "3d");
                        continue;
                    }
                    if (!global_solver_3d) continue;
                    init_gauges(msg);
                    global_cfl_3d = msg.value("cfl", 0.6);
                    if (msg.contains("endtime")) global_endtime_3d = msg.value("endtime", 1.0);
                    global_exec_until_end_3d = true;
                    if (!sim3d_running) {
                        sim3d_running = true;
                        sim3d_paused = false;
                        sim3d_terminate = false;
                        std::thread(worker_3d_thread_func).detach();
                    } else { sim3d_paused = false; }
                } else if (command == "PAUSE_3D") {
                    sim3d_paused = true;
                    global_target_steps_3d = 0;
                } else if (command == "RESUME_3D") {
                    sim3d_paused = false;
                } else if (command == "TERMINATE_3D") {
                    sim3d_terminate = true;
                    {
                        std::lock_guard<std::mutex> lock(g_pending_exec_3d_mutex);
                        g_pending_exec_3d.has_pending = false;
                    }
                    while (sim3d_running.load() || sim3d_init_in_progress.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_3d.reset();
                    global_phase_particles_3d.reset();
                    global_t3d = 0.0;
                    global_dt_3d = 0.0;
                    global_wallclock_3d = 0.0;
                    step_progress_3d = 0;
                } else if (command == "INIT_3D") {
                    sim3d_terminate = true;
                    {
                        std::lock_guard<std::mutex> lock(g_pending_exec_3d_mutex);
                        g_pending_exec_3d.has_pending = false;
                    }
                    while (sim3d_running.load() || sim3d_init_in_progress.load()) {
                        std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    }
                    global_solver_3d.reset();
                    global_phase_particles_3d.reset();
                    sim3d_terminate = false;
                    sim3d_paused = false;
                    sim3d_init_in_progress = true;
                    global_step_3d = 0;
                    global_t3d = 0.0;
                    global_dt_3d = 0.0;
                    global_wallclock_3d = 0.0;

                    global_slices_3d.clear();
                    if (msg.contains("slices")) {
                        for (const auto& s_msg : msg["slices"]) {
                            Slice3D s;
                            s.axis = s_msg.value("axis", "xy");
                            s.offset = s_msg.value("offset", 0.5);
                            s.stride = s_msg.value("stride", 1);
                            s.enabled = get_json_bool(s_msg, "enabled", true);
                            if (s.stride < 1) s.stride = 1;
                            if (s_msg.contains("quantities") && s_msg["quantities"].is_array()) {
                                for (const auto& q : s_msg["quantities"]) {
                                    if (q.is_string()) s.quantities.push_back(q.get<std::string>());
                                }
                            } else if (s_msg.contains("quantity") && s_msg["quantity"].is_string()) {
                                s.quantities.push_back(s_msg["quantity"].get<std::string>());
                            }
                            global_slices_3d.push_back(s);
                        }
                    } else {
                        // Create default XY slice only if "slices" array is completely absent
                        Slice3D s;
                        s.axis = "xy";
                        s.offset = 0.5;
                        s.stride = 1;
                        s.enabled = true;
                        s.quantities.push_back("pressure");
                        global_slices_3d.push_back(s);
                    }

                    // Start the asynchronous initialization thread
                    std::thread(init_3d_thread_func, msg).detach();

                } else if (command == "UPDATE_CFL") {
                    double cfl = msg.value("cfl", 0.6);
                    global_cfl = cfl;
                    global_cfl_2d = cfl;
                    global_cfl_3d = cfl;
                    global_cfl_mpm = static_cast<float>(cfl);
                    global_cfl_mpm_3d = static_cast<float>(cfl);
                    global_cfl_fem_3d = static_cast<float>(cfl);
                    global_cfl_fsi = static_cast<float>(cfl);
                    global_cfl_fsi_3d = static_cast<float>(cfl);
                    global_cfl_fem_fsi_3d = static_cast<float>(cfl);
                    std::string scope = msg.value("scope", "3d");
                    emit_kernel_log("SYSTEM", "CFL updated to " + std::to_string(cfl), 0.0, scope);

                } else if (command == "UPDATE_ENDTIME") {
                    double endtime = msg.value("endtime", 1.0);
                    global_endtime = endtime;
                    global_endtime_2d = endtime;
                    global_endtime_3d = endtime;
                    global_endtime_mpm = endtime;
                    global_endtime_mpm_3d = endtime;
                    global_endtime_fem_3d = endtime;
                    global_endtime_fsi = endtime;
                    global_endtime_fsi_3d = endtime;
                    global_endtime_fem_fsi_3d = endtime;
                    std::string scope = msg.value("scope", "3d");
                    emit_kernel_log("SYSTEM", "End time updated to " + std::to_string(endtime) + " s", 0.0, scope);

                } else if (command == "CONTOUR_CONFIG" || command == "VIEW3D_CONFIG" || command == "REFRESH_STATE" || command == "REFRESH" || command == "POLL_STATE") {
                    global_telemetry_stride = msg.value("stride", 1);
                    if (msg.contains("particle_stride")) {
                        global_mpm_particle_stride = std::max(1, msg.value("particle_stride", 1));
                    }
                    if (msg.contains("refresh_rate")) {
                        double rate = msg.value("refresh_rate", 0.0);
                        int interval = (rate > 0.0) ? static_cast<int>(rate * 1000.0) : 16;
                        if (interval < 16) interval = 16;
                        global_telemetry_interval_ms = interval;
                        global_refresh_rate_mpm = rate;
                        global_refresh_rate_mpm_3d = rate;
                        global_refresh_rate_fem_3d = rate;
                    }
                    if (msg.contains("slices")) {
                        global_slices_3d.clear();
                        for (const auto& s_msg : msg["slices"]) {
                            Slice3D s;
                            s.axis = s_msg.value("axis", "xy");
                            s.offset = s_msg.value("offset", 0.5);
                            s.stride = s_msg.value("stride", 1);
                            s.enabled = get_json_bool(s_msg, "enabled", true);
                            if (s.stride < 1) s.stride = 1;
                            if (s_msg.contains("quantities") && s_msg["quantities"].is_array()) {
                                for (const auto& q : s_msg["quantities"]) {
                                    if (q.is_string()) s.quantities.push_back(q.get<std::string>());
                                }
                            } else if (s_msg.contains("quantity") && s_msg["quantity"].is_string()) {
                                s.quantities.push_back(s_msg["quantity"].get<std::string>());
                            }
                            global_slices_3d.push_back(s);
                        }
                    } else if (command == "VIEW3D_CONFIG") {
                        bool show_stl = get_json_bool(msg, "show_stl", true);
                        bool stl_show_results = get_json_bool(msg, "stl_show_results", true);
                        std::string stl_qty = msg.value("stl_quantity", "pressure");

                        if (show_stl && stl_show_results) {
                            Slice3D vol_slice;
                            vol_slice.axis = "volume";
                            vol_slice.offset = 0.5;
                            vol_slice.stride = msg.value("stride", 1);
                            if (vol_slice.stride < 1) vol_slice.stride = 1;
                            vol_slice.enabled = true;
                            vol_slice.quantities.push_back(stl_qty);
                            global_slices_3d.push_back(vol_slice);
                        }
                    }
                    if (command == "CONTOUR_CONFIG") {
                        if (has_solver_2d()) {
                            emit_telemetry_2d(global_t2d, false);
                        }
                    } else if (command == "VIEW3D_CONFIG") {
                        if (global_solver_3d) {
                            emit_telemetry_3d(global_t3d, false);
                        } else if (global_solver_mpm_3d || global_solver_mpm_3d_cuda) {
                            emit_telemetry_mpm_3d(global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getSimTime() : global_solver_mpm_3d->getSimTime(), false, -1, false);
                        } else if (!global_fem_solvers_cuda_float.empty() || !global_fem_solvers_cuda_double.empty() || !global_fem_solvers_float.empty() || !global_fem_solvers_double.empty()) {
                            emit_telemetry_fem_3d(-1.0, false, -1);
                        }
                    } else if (command == "REFRESH_STATE" || command == "REFRESH" || command == "POLL_STATE") {
                        if (global_solver) {
                            emit_telemetry(*global_solver, global_t, false, global_step_1d.load());
                        }
                        if (has_solver_2d()) {
                            emit_telemetry_2d(global_t2d, false, global_step_2d.load());
                        }
                        if (global_solver_mpm_2d) {
                            emit_telemetry_mpm_2d(global_solver_mpm_2d->getSimTime(), false, global_step_fsi_2d.load());
                        }
                        if (global_solver_3d) {
                            emit_telemetry_3d(global_t3d, false, global_step_3d.load());
                        } else if (global_solver_mpm_3d || global_solver_mpm_3d_cuda) {
                            emit_telemetry_mpm_3d(global_solver_mpm_3d_cuda ? global_solver_mpm_3d_cuda->getSimTime() : global_solver_mpm_3d->getSimTime(), false, global_step_fsi_3d.load());
                        }
                        if (!global_fem_solvers_cuda_float.empty() || !global_fem_solvers_cuda_double.empty() || !global_fem_solvers_float.empty() || !global_fem_solvers_double.empty()) {
                            emit_telemetry_fem_3d(-1.0, false, global_step_fem_fsi_3d.load());
                        }
                    }
                } else if (command == "WRITE_VTK") {
                    write_vtk_outputs(0, 0.0);
                    global_last_vtk_time_1d = 0.0;
                    global_last_vtk_time_2d = 0.0;
                    global_last_vtk_time_3d = 0.0;
                    global_last_vtk_time_fsi_2d = 0.0;
                    global_last_vtk_time_fsi_3d = 0.0;
                    global_last_vtk_time_fem_fsi_3d = 0.0;
                    global_last_vtk_time_mpm_3d = 0.0;
                    global_last_vtk_time_fem_3d = 0.0;
                }

            } catch (const std::exception& e) {
                std::lock_guard<std::mutex> lock(cout_mutex);
                std::cout << "[ERROR] JSON/Binding Error: " << e.what() << std::endl;
            }
        }
    });
    stdin_listener_thread.join();
    while (sim_running.load() || sim2d_running.load() || sim3d_running.load() ||
           sim_mpm_running.load() || sim_mpm_3d_running.load() ||
           sim_fem_3d_running.load() || sim_fsi_running.load() ||
           sim_fsi_3d_running.load() || sim_fem_fsi_3d_running.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }

    global_pulse_cancel.store(true);
    if (pulse_thread.joinable()) {
        pulse_thread.join();
    }

    stop_async_telemetry();
    if (telemetry_thread.joinable()) {
        telemetry_thread.join();
    }

    Blast::AsyncVTKWriter::getInstance().flush();
    Blast::AsyncVTKWriter::getInstance().stop();

    global_solver.reset();
    global_solver_2d.reset();
    global_solver_2d_cuda.reset();
    global_solver_3d.reset();
    global_phase_particles_3d.reset();

    return 0;
}
