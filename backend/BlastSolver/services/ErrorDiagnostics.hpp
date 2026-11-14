#pragma once

#include <algorithm>
#include <atomic>
#include <cctype>
#include <string>

namespace BlastDiagnostics {

inline thread_local const char* tl_kernel_phase = nullptr;
inline std::atomic<const char*> g_last_kernel_phase{nullptr};
inline std::atomic<double> g_last_dt{0.0};
inline std::string g_active_device;
inline std::string g_active_precision;

inline void set_kernel_phase(const char* phase) noexcept {
    tl_kernel_phase = phase;
    g_last_kernel_phase.store(phase, std::memory_order_relaxed);
}

inline std::string get_kernel_phase() {
    const char* p = tl_kernel_phase ? tl_kernel_phase : g_last_kernel_phase.load(std::memory_order_relaxed);
    return p ? std::string(p) : std::string();
}

inline void set_solver_context(const std::string& device, const std::string& precision) {
    g_active_device = device;
    g_active_precision = precision;
}

inline void set_last_dt(double dt) noexcept {
    g_last_dt.store(dt, std::memory_order_relaxed);
}

struct StructuredError {
    std::string error_code;
    std::string summary;
    std::string details;
};

inline std::string to_lower_copy(const std::string& s) {
    std::string out = s;
    std::transform(out.begin(), out.end(), out.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return out;
}

inline bool contains_any(const std::string& haystack_lower, std::initializer_list<const char*> needles) {
    for (const char* n : needles) {
        if (haystack_lower.find(n) != std::string::npos) {
            return true;
        }
    }
    return false;
}

/**
 * Classifies a raw solver error message and scope into a structured diagnostic
 * with an error code, a single-line summary, and a multiline troubleshooting guide.
 */
inline StructuredError classify_error(const std::string& raw_msg, const std::string& scope = "") {
    const std::string lower = to_lower_copy(raw_msg);
    const std::string scope_lower = to_lower_copy(scope);

    if (contains_any(lower, {"illegal memory access", "misaligned address", "illegal instruction", "an illegal"})) {
        return {
            "ERR_CUDA_ILLEGAL_ACCESS",
            "GPU kernel encountered an illegal memory access.",
            "What happened:\n"
            "A CUDA kernel attempted to read or write outside allocated GPU memory. This typically occurs when a cell index, active tile lookup, remap coordinate, or particle-to-grid mapping goes out of bounds—or when a numerical NaN/Inf pushes a wave or particle outside the domain.\n\n"
            "How to fix your model:\n"
            "1. Verify Domain & Geometry Bounds: Ensure all charges, detonators, STL obstacles, MPM/FEM bodies, and remap origins lie strictly inside the domain.\n"
            "2. Check Remap Pipelines: If this is a remapped stage (1D->3D or 2D->3D), confirm the upstream stage completed cleanly and its blast radius fits inside the 3D mesh.\n"
            "3. Reduce CFL / Switch Precision: Lower the CFL number (e.g. 0.2) or switch Precision to Double (float64) on the solver node.\n"
            "4. Isolate on CPU: Temporarily set Device = CPU on the solver node to test whether the issue is GPU tile-specific or numerical."
        };
    }

    if (contains_any(lower, {"out of memory", "cudaerrormemoryallocation", "failed to allocate"})) {
        return {
            "ERR_CUDA_OOM",
            "GPU ran out of video memory (VRAM) during allocation.",
            "What happened:\n"
            "The requested grid dimensions, active tile buffers, or particle/element arrays exceeded available GPU VRAM.\n\n"
            "How to fix your model:\n"
            "1. Coarsen Mesh: Increase cell size (dx) or reduce grid dimensions (Nx, Ny, Nz) on the Domain Mesh node.\n"
            "2. Use Single Precision: Switch Precision from Double (float64) to Single (float32) to halve memory usage.\n"
            "3. Reduce Particle/Element Count: Lower MPM particle density or FEM mesh resolution.\n"
            "4. Switch to CPU: Set Device = CPU on the solver node if system RAM is larger than GPU VRAM."
        };
    }

    if (contains_any(lower, {"cuda error", "cudaerror", "no cuda-capable", "driver version"})) {
        return {
            "ERR_CUDA_DRIVER",
            "CUDA GPU runtime or driver execution failure.",
            "What happened:\n"
            "The CUDA runtime reported an error during kernel launch, memory transfer, or device initialization.\n\n"
            "How to fix your model:\n"
            "1. Reset & Re-Initialize: Click 'Reset Error State' and re-run Init.\n"
            "2. Check GPU Health: Verify nvidia-smi shows the GPU is healthy and not out of memory.\n"
            "3. Fallback to CPU: Switch Device = CPU on the solver node to verify model setup independently of the GPU."
        };
    }

    if (contains_any(lower, {"nan", "-nan", "inf", "non-finite", "diverg", "blow-up", "blowup"})) {
        return {
            "ERR_SOLVER_NAN",
            "Numerical instability (NaN / Inf) detected in solver state.",
            "What happened:\n"
            "Field variables (pressure, density, energy, or velocity) became non-finite during time integration.\n\n"
            "How to fix your model:\n"
            "1. Lower CFL Number: Reduce CFL (e.g. from 0.5 to 0.2 or 0.15) on the solver node.\n"
            "2. Check Material EOS: Ensure gamma > 1.0, reference density > 0, and JWL/explosive constants are valid.\n"
            "3. Use Robust Flux/Order: Try HLLC with 2nd-order ADER-2 or TVD slope limiting near strong shocks.\n"
            "4. Enable Double Precision: Switch Precision to Double (float64) for stiff multi-material interfaces."
        };
    }

    if (contains_any(lower, {"dt <=", "timestep", "dt collapsed", "min_dt", "cfl <= 0"})) {
        return {
            "ERR_TIMESTEP_COLLAPSE",
            "Simulation timestep (dt) collapsed below minimum threshold.",
            "What happened:\n"
            "Extreme wave speeds, stiff materials, or inverted/distorted elements drove the adaptive timestep toward zero.\n\n"
            "How to fix your model:\n"
            "1. Check Charge & EOS Energy: Verify explosive density and detonation energy are realistic.\n"
            "2. Inspect Structural Elements: Look for severely distorted FEM/MPM elements or overly stiff contact penalties.\n"
            "3. Adjust Mesh Size: Slightly increase minimum cell size (dx) if tiny cells are restricting dt."
        };
    }

    if (contains_any(lower, {"remap", "source_model", "1d->2d", "1d->3d", "2d->3d"})) {
        return {
            "ERR_REMAP_INVALID",
            "Remap field transfer failed between upstream and target stage.",
            "What happened:\n"
            "Transferring flow fields from the upstream stage into this model failed due to missing upstream data, incompatible EOS, or out-of-bounds geometry.\n\n"
            "How to fix your model:\n"
            "1. Run Upstream Stage First: Ensure Stage 1 has been initialized and stepped, or use 'Run Pipeline'.\n"
            "2. Verify Remap Connections: Confirm the Remap node points to the correct upstream Source Model.\n"
            "3. Check Domain Overlap: Ensure the target mesh encloses the remapped origin and blast radius."
        };
    }

    if (contains_any(lower, {"mesh", "grid", "n_cells", "domain_radius", "nx", "ny", "nz", "dx <= 0"})) {
        return {
            "ERR_MESH_INVALID",
            "Invalid or missing computational domain / mesh configuration.",
            "What happened:\n"
            "The solver could not construct the spatial grid because required dimensions or cell sizes are missing or non-positive.\n\n"
            "How to fix your model:\n"
            "1. Wire Domain Mesh: Confirm a Domain/Mesh node is connected to the solver in the Pipeline Browser.\n"
            "2. Check Dimensions: Ensure cell counts (Nx, Ny, Nz or n_cells) are positive integers and cell size (dx) > 0."
        };
    }

    if (contains_any(lower, {"eos", "gamma", "jwl", "material", "ambient_p", "ambient_rho"})) {
        return {
            "ERR_EOS_INVALID",
            "Invalid or missing material / Equation of State (EOS) configuration.",
            "What happened:\n"
            "A required material (Air, Explosive JWL/Ideal Gas, Water, or Solid) is missing or has invalid EOS constants.\n\n"
            "How to fix your model:\n"
            "1. Check Material Wiring: Verify all material dependency chips in the Pipeline Browser are connected.\n"
            "2. Validate Constants: Ensure density > 0, pressure > 0, and Ideal Gas gamma > 1.0."
        };
    }

    if (contains_any(lower, {"no such file", "failed to open", "cannot open", "stl", ".k", "hdf5", "vtk", "permission denied"})) {
        return {
            "ERR_FILE_IO",
            "File I/O error reading geometry/deck or writing output.",
            "What happened:\n"
            "The solver could not open, parse, or write a required file on disk.\n\n"
            "How to fix your model:\n"
            "1. Verify File Path: Check that any referenced STL geometry or LS-DYNA (.k) deck exists and is readable.\n"
            "2. Check Disk Permissions: Ensure the output directory is writable and has sufficient free space."
        };
    }

    if (contains_any(lower, {"fsi", "coupler"}) || scope_lower == "fem_3d" || scope_lower == "mpm_3d" || scope_lower == "mpm_2d") {
        return {
            "ERR_FSI_COUPLING",
            "Structural or Fluid-Structure Interaction (FSI) solver error.",
            "What happened:\n"
            "An error occurred during structural (FEM/MPM) initialization, constitutive update, or FSI coupling.\n\n"
            "How to fix your model:\n"
            "1. Verify Wiring: Confirm CFD Domain, Structural Domain (MPM/FEM), and FSI Coupler are all connected.\n"
            "2. Check Geometry Placement: Ensure structural parts lie inside the fluid domain with valid positive element Jacobians.\n"
            "3. Reduce CFL / Coupling Step: Lower CFL if interface forces spike during blast arrival."
        };
    }

    if (contains_any(lower, {"initialization failed", "init failed", "no solver available", "missing"})) {
        return {
            "ERR_SOLVER_INIT",
            "Solver initialization failed before time integration could start.",
            "What happened:\n"
            "The solver could not initialize its state from the current model configuration.\n\n"
            "How to fix your model:\n"
            "1. Check Pipeline Browser: Look for INCOMPLETE or unconnected dependency chips (Mesh, Materials, Charge, Detonator).\n"
            "2. Review Technical Details: Check the raw error below for the specific missing parameter, fix it, and re-run Init."
        };
    }

    return {
        "ERR_SOLVER_RUNTIME",
        "Solver encountered a runtime execution error.",
        "What happened:\n"
        "The solver worker reported an unexpected error during execution.\n\n"
        "How to fix your model:\n"
        "1. Review the technical error details below to identify the failing stage or component.\n"
        "2. Verify domain bounds, material EOS parameters, and CFL stability settings.\n"
        "3. Click 'Reset Error State' and re-initialize the model."
    };
}

} // namespace BlastDiagnostics
