export interface StructuredDiagnostic {
    errorCode: string;
    summary: string;
    details: string;
    rawMessage: string;
}

export interface ModelErrorEntry {
    message: string;
    errorCode: string;
    summary: string;
    details: string;
    timestamp: number;
    step?: number;
    simTime?: number;
    dt?: number;
    scope?: string;
    level?: string;
    device?: string;
    precision?: string;
    kernelPhase?: string;
    exitCode?: number;
    signal?: number;
}

/**
 * Classifies any raw solver or frontend error into a structured diagnostic
 * containing an error code, a single-line summary, and a multiline fix guide.
 * If the backend already provided structured fields, preserves them verbatim.
 */
export function classifyError(
    rawMessage: string,
    scope?: string,
    existing?: { errorCode?: string; summary?: string; details?: string }
): StructuredDiagnostic {
    if (existing?.errorCode && existing?.summary && existing?.details) {
        return {
            errorCode: existing.errorCode,
            summary: existing.summary,
            details: existing.details,
            rawMessage
        };
    }

    const lower = (rawMessage || '').toLowerCase();
    const scopeLower = (scope || '').toLowerCase();

    if (lower.includes('illegal memory access') || lower.includes('misaligned address') || lower.includes('illegal instruction')) {
        return {
            errorCode: 'ERR_CUDA_ILLEGAL_ACCESS',
            summary: 'GPU kernel encountered an illegal memory access.',
            details:
                'What happened:\n' +
                'A CUDA kernel attempted to read or write outside allocated GPU memory. This typically occurs when a cell index, active tile lookup, remap coordinate, or particle-to-grid mapping goes out of bounds—or when a numerical NaN/Inf pushes a wave or particle outside the domain.\n\n' +
                'How to fix your model:\n' +
                '1. Verify Domain & Geometry Bounds: Ensure all charges, detonators, STL obstacles, MPM/FEM bodies, and remap origins lie strictly inside the domain.\n' +
                '2. Check Remap Pipelines: If this is a remapped stage (1D→3D or 2D→3D), confirm the upstream stage completed cleanly and its blast radius fits inside the 3D mesh.\n' +
                '3. Reduce CFL / Switch Precision: Lower the CFL number (e.g. 0.2) or switch Precision to Double (float64) on the solver node.\n' +
                '4. Isolate on CPU: Temporarily set Device = CPU on the solver node to test whether the issue is GPU tile-specific or numerical.',
            rawMessage
        };
    }

    if (lower.includes('out of memory') || lower.includes('cudaerrormemoryallocation') || lower.includes('failed to allocate')) {
        return {
            errorCode: 'ERR_CUDA_OOM',
            summary: 'GPU ran out of video memory (VRAM) during allocation.',
            details:
                'What happened:\n' +
                'The requested grid dimensions, active tile buffers, or particle/element arrays exceeded available GPU VRAM.\n\n' +
                'How to fix your model:\n' +
                '1. Coarsen Mesh: Increase cell size (dx) or reduce grid dimensions (Nx, Ny, Nz) on the Domain Mesh node.\n' +
                '2. Use Single Precision: Switch Precision from Double (float64) to Single (float32) to halve memory usage.\n' +
                '3. Reduce Particle/Element Count: Lower MPM particle density or FEM mesh resolution.\n' +
                '4. Switch to CPU: Set Device = CPU on the solver node if system RAM is larger than GPU VRAM.',
            rawMessage
        };
    }

    if (lower.includes('cuda error') || lower.includes('cudaerror') || lower.includes('no cuda-capable') || lower.includes('driver version')) {
        return {
            errorCode: 'ERR_CUDA_DRIVER',
            summary: 'CUDA GPU runtime or driver execution failure.',
            details:
                'What happened:\n' +
                'The CUDA runtime reported an error during kernel launch, memory transfer, or device initialization.\n\n' +
                'How to fix your model:\n' +
                '1. Reset & Re-Initialize: Click "Reset Error State" and re-run Init.\n' +
                '2. Check GPU Health: Verify nvidia-smi shows the GPU is healthy and not out of memory.\n' +
                '3. Fallback to CPU: Switch Device = CPU on the solver node to verify model setup independently of the GPU.',
            rawMessage
        };
    }

    if (lower.includes('nan') || lower.includes('inf') || lower.includes('non-finite') || lower.includes('diverg') || lower.includes('blow-up')) {
        return {
            errorCode: 'ERR_SOLVER_NAN',
            summary: 'Numerical instability (NaN / Inf) detected in solver state.',
            details:
                'What happened:\n' +
                'Field variables (pressure, density, energy, or velocity) became non-finite during time integration.\n\n' +
                'How to fix your model:\n' +
                '1. Lower CFL Number: Reduce CFL (e.g. from 0.5 to 0.2 or 0.15) on the solver node.\n' +
                '2. Check Material EOS: Ensure gamma > 1.0, reference density > 0, and JWL/explosive constants are valid.\n' +
                '3. Use Robust Flux/Order: Try HLLC with 2nd-order ADER-2 or TVD slope limiting near strong shocks.\n' +
                '4. Enable Double Precision: Switch Precision to Double (float64) for stiff multi-material interfaces.',
            rawMessage
        };
    }

    if (lower.includes('dt <=') || lower.includes('timestep') || lower.includes('dt collapsed') || lower.includes('min_dt')) {
        return {
            errorCode: 'ERR_TIMESTEP_COLLAPSE',
            summary: 'Simulation timestep (Δt) collapsed below minimum threshold.',
            details:
                'What happened:\n' +
                'Extreme wave speeds, stiff materials, or inverted/distorted elements drove the adaptive timestep toward zero.\n\n' +
                'How to fix your model:\n' +
                '1. Check Charge & EOS Energy: Verify explosive density and detonation energy are realistic.\n' +
                '2. Inspect Structural Elements: Look for severely distorted FEM/MPM elements or overly stiff contact penalties.\n' +
                '3. Adjust Mesh Size: Slightly increase minimum cell size (dx) if tiny cells are restricting Δt.',
            rawMessage
        };
    }

    if (lower.includes('remap') || lower.includes('source_model') || lower.includes('1d->2d') || lower.includes('1d->3d') || lower.includes('2d->3d')) {
        return {
            errorCode: 'ERR_REMAP_INVALID',
            summary: 'Remap field transfer failed between upstream and target stage.',
            details:
                'What happened:\n' +
                'Transferring flow fields from the upstream stage into this model failed due to missing upstream data, incompatible EOS, or out-of-bounds geometry.\n\n' +
                'How to fix your model:\n' +
                '1. Run Upstream Stage First: Ensure Stage 1 has been initialized and stepped, or use "Run Pipeline".\n' +
                '2. Verify Remap Connections: Confirm the Remap node points to the correct upstream Source Model.\n' +
                '3. Check Domain Overlap: Ensure the target mesh encloses the remapped origin and blast radius.',
            rawMessage
        };
    }

    if (lower.includes('mesh') || lower.includes('grid') || lower.includes('n_cells') || lower.includes('domain_radius') || lower.includes('dx <= 0')) {
        return {
            errorCode: 'ERR_MESH_INVALID',
            summary: 'Invalid or missing computational domain / mesh configuration.',
            details:
                'What happened:\n' +
                'The solver could not construct the spatial grid because required dimensions or cell sizes are missing or non-positive.\n\n' +
                'How to fix your model:\n' +
                '1. Wire Domain Mesh: Confirm a Domain/Mesh node is connected to the solver in the Pipeline Browser.\n' +
                '2. Check Dimensions: Ensure cell counts (Nx, Ny, Nz or n_cells) are positive integers and cell size (dx) > 0.',
            rawMessage
        };
    }

    if (lower.includes('eos') || lower.includes('gamma') || lower.includes('jwl') || lower.includes('material')) {
        return {
            errorCode: 'ERR_EOS_INVALID',
            summary: 'Invalid or missing material / Equation of State (EOS) configuration.',
            details:
                'What happened:\n' +
                'A required material (Air, Explosive JWL/Ideal Gas, Water, or Solid) is missing or has invalid EOS constants.\n\n' +
                'How to fix your model:\n' +
                '1. Check Material Wiring: Verify all material dependency chips in the Pipeline Browser are connected.\n' +
                '2. Validate Constants: Ensure density > 0, pressure > 0, and Ideal Gas gamma > 1.0.',
            rawMessage
        };
    }

    if (lower.includes('no such file') || lower.includes('failed to open') || lower.includes('cannot open') || lower.includes('.stl') || lower.includes('hdf5') || lower.includes('vtk')) {
        return {
            errorCode: 'ERR_FILE_IO',
            summary: 'File I/O error reading geometry/deck or writing output.',
            details:
                'What happened:\n' +
                'The solver could not open, parse, or write a required file on disk.\n\n' +
                'How to fix your model:\n' +
                '1. Verify File Path: Check that any referenced STL geometry or LS-DYNA (.k) deck exists and is readable.\n' +
                '2. Check Disk Permissions: Ensure the output directory is writable and has sufficient free space.',
            rawMessage
        };
    }

    if (lower.includes('fsi') || lower.includes('coupler') || scopeLower === 'fem_3d' || scopeLower === 'mpm_3d' || scopeLower === 'mpm_2d') {
        return {
            errorCode: 'ERR_FSI_COUPLING',
            summary: 'Structural or Fluid-Structure Interaction (FSI) solver error.',
            details:
                'What happened:\n' +
                'An error occurred during structural (FEM/MPM) initialization, constitutive update, or FSI coupling.\n\n' +
                'How to fix your model:\n' +
                '1. Verify Wiring: Confirm CFD Domain, Structural Domain (MPM/FEM), and FSI Coupler are all connected.\n' +
                '2. Check Geometry Placement: Ensure structural parts lie inside the fluid domain with valid positive element Jacobians.\n' +
                '3. Reduce CFL / Coupling Step: Lower CFL if interface forces spike during blast arrival.',
            rawMessage
        };
    }

    if (lower.includes('initialization failed') || lower.includes('init failed') || lower.includes('no solver available') || lower.includes('missing')) {
        return {
            errorCode: 'ERR_SOLVER_INIT',
            summary: 'Solver initialization failed before time integration could start.',
            details:
                'What happened:\n' +
                'The solver could not initialize its state from the current model configuration.\n\n' +
                'How to fix your model:\n' +
                '1. Check Pipeline Browser: Look for INCOMPLETE or unconnected dependency chips (Mesh, Materials, Charge, Detonator).\n' +
                '2. Review Technical Details: Check the raw error below for the specific missing parameter, fix it, and re-run Init.',
            rawMessage
        };
    }

    return {
        errorCode: 'ERR_SOLVER_RUNTIME',
        summary: 'Solver encountered a runtime execution error.',
        details:
            'What happened:\n' +
            'The solver worker reported an unexpected error during execution.\n\n' +
            'How to fix your model:\n' +
            '1. Review the technical error details below to identify the failing stage or component.\n' +
            '2. Verify domain bounds, material EOS parameters, and CFL stability settings.\n' +
            '3. Click "Reset Error State" and re-initialize the model.',
        rawMessage
    };
}
