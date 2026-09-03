/**
 * BlastDemon Parameter & Node Definitions Registry
 * Single Source of Truth (SSOT) for UI Parameter Popovers, Tooltips,
 * Physical Units, Governing Equations, and Node-Type Documentation.
 */

export type SolverScope = 'MPM' | 'FEM' | 'FV' | 'MPM+FEM' | 'MPM+FV' | 'ALL';

export interface ParameterDefinition {
    key: string;
    label: string;
    unit?: string;
    category?: string;
    shortDesc: string;
    detailedDesc: string;
    allowedValues?: string[];
    defaultVal?: any;
    solverScope?: SolverScope;
}

export interface NodeDefinition {
    type: string;
    title: string;
    category: string;
    shortDesc: string;
    fullDescHtml: string;
}

// ============================================================================
// 1. MASTER PARAMETER DEFINITIONS DICTIONARY
// ============================================================================

export const PARAMETER_DEFINITIONS: Record<string, ParameterDefinition> = {
    // --- Identification & Hierarchy ---
    'name': {
        key: 'name',
        label: 'Custom Entity Name',
        category: 'Identification & Hierarchy',
        shortDesc: 'User-defined custom identifier for the pipeline entity',
        detailedDesc: 'Custom alphanumeric name displayed across the Pipeline Browser, Visual Node Graph, and Property Inspector. Independent of immutable internal node IDs.'
    },

    // --- Domain & Mesh Discretization ---
    'dimension': {
        key: 'dimension',
        label: 'Spatial Dimension',
        category: 'Domain & Discretization',
        shortDesc: 'Dimensionality of spatial domain',
        detailedDesc: 'Selects the spatial dimensionality of the Cartesian domain (1D line/radial, 2D planar/axisymmetric, 3D volume). Determines coordinate metric terms and flux divergence operators.'
    },
    'domain_radius': {
        key: 'domain_radius',
        label: 'Domain Radius (R_max)',
        unit: 'm',
        category: 'Domain & Discretization',
        shortDesc: 'Radial extent of 1D domain',
        detailedDesc: 'Maximum spatial coordinate (m) for 1D spherically symmetric or planar blast wave propagation. Must be large enough to contain shock expansion before boundary reflection.'
    },
    'cell_size': {
        key: 'cell_size',
        label: 'Cell Size (Δx / Δr / Δz)',
        unit: 'm',
        category: 'Domain & Discretization',
        shortDesc: 'Spatial grid cell resolution',
        detailedDesc: 'Uniform grid spacing (m) across spatial coordinates. Finer cell sizes resolve high-pressure shock gradients and boundary layers with higher fidelity at the cost of proportional O(Δx^(D+1)) compute time.'
    },
    'left_bc': {
        key: 'left_bc',
        label: 'Left Boundary Condition',
        category: 'Domain & Discretization',
        shortDesc: 'Boundary behavior at x_min / r_min',
        detailedDesc: 'Reflecting (solid wall / symmetry axis where normal velocity u_n = 0), Transmitting (zero-gradient outflow / non-reflecting far-field), or Terminate (absorbing sponge layer).'
    },
    'right_bc': {
        key: 'right_bc',
        label: 'Right Boundary Condition',
        category: 'Domain & Discretization',
        shortDesc: 'Boundary behavior at x_max / r_max',
        detailedDesc: 'Outflow condition at outer boundary. Transmitting allows blast shock waves to exit the domain without spurious artificial wall reflections.'
    },
    'x_min_bc': {
        key: 'x_min_bc',
        label: 'X-Min Boundary Condition',
        category: 'Domain & Discretization',
        shortDesc: 'Left-hand X-axis boundary condition',
        detailedDesc: 'Reflecting (solid wall/symmetry), Transmitting (outflow non-reflecting), or Terminate (absorption).'
    },
    'x_max_bc': {
        key: 'x_max_bc',
        label: 'X-Max Boundary Condition',
        category: 'Domain & Discretization',
        shortDesc: 'Right-hand X-axis boundary condition',
        detailedDesc: 'Reflecting (solid wall), Transmitting (outflow non-reflecting), or Terminate (absorption).'
    },
    'y_min_bc': {
        key: 'y_min_bc',
        label: 'Y-Min Boundary Condition',
        category: 'Domain & Discretization',
        shortDesc: 'Bottom Y-axis boundary condition',
        detailedDesc: 'Reflecting (ground reflection plane), Transmitting (ambient far-field), or Terminate.'
    },
    'y_max_bc': {
        key: 'y_max_bc',
        label: 'Y-Max Boundary Condition',
        category: 'Domain & Discretization',
        shortDesc: 'Top Y-axis boundary condition',
        detailedDesc: 'Reflecting (ceiling), Transmitting (open atmosphere), or Terminate.'
    },
    'z_min_bc': {
        key: 'z_min_bc',
        label: 'Z-Min Boundary Condition',
        category: 'Domain & Discretization',
        shortDesc: 'Axial minimum Z-axis boundary condition',
        detailedDesc: 'Reflecting (symmetry plane or ground), Transmitting (outflow), or Terminate.'
    },
    'z_max_bc': {
        key: 'z_max_bc',
        label: 'Z-Max Boundary Condition',
        category: 'Domain & Discretization',
        shortDesc: 'Axial maximum Z-axis boundary condition',
        detailedDesc: 'Reflecting (wall), Transmitting (open atmosphere), or Terminate.'
    },
    'bc_x_min': {
        key: 'bc_x_min',
        label: 'X-Min Face Boundary',
        category: 'Domain & Discretization',
        shortDesc: '3D Domain X-Min boundary condition',
        detailedDesc: 'Reflecting (solid/symmetry wall), Transmitting (non-reflecting outflow), or Terminate.'
    },
    'bc_x_max': {
        key: 'bc_x_max',
        label: 'X-Max Face Boundary',
        category: 'Domain & Discretization',
        shortDesc: '3D Domain X-Max boundary condition',
        detailedDesc: 'Reflecting (solid/symmetry wall), Transmitting (non-reflecting outflow), or Terminate.'
    },
    'bc_y_min': {
        key: 'bc_y_min',
        label: 'Y-Min Face Boundary',
        category: 'Domain & Discretization',
        shortDesc: '3D Domain Y-Min boundary condition',
        detailedDesc: 'Reflecting (ground reflection plane), Transmitting (far-field), or Terminate.'
    },
    'bc_y_max': {
        key: 'bc_y_max',
        label: 'Y-Max Face Boundary',
        category: 'Domain & Discretization',
        shortDesc: '3D Domain Y-Max boundary condition',
        detailedDesc: 'Reflecting (ceiling), Transmitting (open sky), or Terminate.'
    },
    'bc_z_min': {
        key: 'bc_z_min',
        label: 'Z-Min Face Boundary',
        category: 'Domain & Discretization',
        shortDesc: '3D Domain Z-Min boundary condition',
        detailedDesc: 'Reflecting (symmetry / wall), Transmitting (open far-field), or Terminate.'
    },
    'bc_z_max': {
        key: 'bc_z_max',
        label: 'Z-Max Face Boundary',
        category: 'Domain & Discretization',
        shortDesc: '3D Domain Z-Max boundary condition',
        detailedDesc: 'Reflecting (wall), Transmitting (open atmosphere), or Terminate.'
    },
    'bc_r_min': {
        key: 'bc_r_min',
        label: 'R-Min Boundary (Axis)',
        category: 'Domain & Discretization',
        shortDesc: '2D Axisymmetric symmetry axis (r=0)',
        detailedDesc: 'Must be set to Reflecting for physical axisymmetric symmetry along the central centerline r=0.'
    },
    'bc_r_max': {
        key: 'bc_r_max',
        label: 'R-Max Boundary',
        category: 'Domain & Discretization',
        shortDesc: '2D Radial outer boundary condition',
        detailedDesc: 'Reflecting (outer cylindrical enclosure) or Terminate/Transmitting (open ambient atmosphere).'
    },
    'max_r': {
        key: 'max_r',
        label: 'Max Radius (R_max)',
        unit: 'm',
        category: 'Domain & Discretization',
        shortDesc: '2D Axisymmetric domain radial extent',
        detailedDesc: 'Maximum radial extent of the 2D cylindrical grid (m) from the centerline r=0.'
    },
    'max_z': {
        key: 'max_z',
        label: 'Max Length (Z_max)',
        unit: 'm',
        category: 'Domain & Discretization',
        shortDesc: '2D Axisymmetric domain axial height',
        detailedDesc: 'Maximum axial coordinate extent of the 2D grid (m) along the Z-axis.'
    },
    'xmin': {
        key: 'xmin',
        label: 'X-Min Coordinate',
        unit: 'm',
        category: 'Domain & Discretization',
        shortDesc: '3D Domain lower X bound',
        detailedDesc: 'Minimum spatial coordinate along the Cartesian X-axis in meters.'
    },
    'xmax': {
        key: 'xmax',
        label: 'X-Max Coordinate',
        unit: 'm',
        category: 'Domain & Discretization',
        shortDesc: '3D Domain upper X bound',
        detailedDesc: 'Maximum spatial coordinate along the Cartesian X-axis in meters.'
    },
    'ymin': {
        key: 'ymin',
        label: 'Y-Min Coordinate',
        unit: 'm',
        category: 'Domain & Discretization',
        shortDesc: '3D Domain lower Y bound',
        detailedDesc: 'Minimum spatial coordinate along the Cartesian Y-axis in meters.'
    },
    'ymax': {
        key: 'ymax',
        label: 'Y-Max Coordinate',
        unit: 'm',
        category: 'Domain & Discretization',
        shortDesc: '3D Domain upper Y bound',
        detailedDesc: 'Maximum spatial coordinate along the Cartesian Y-axis in meters.'
    },
    'zmin': {
        key: 'zmin',
        label: 'Z-Min Coordinate',
        unit: 'm',
        category: 'Domain & Discretization',
        shortDesc: '3D Domain lower Z bound',
        detailedDesc: 'Minimum spatial coordinate along the Cartesian Z-axis in meters.'
    },
    'zmax': {
        key: 'zmax',
        label: 'Z-Max Coordinate',
        unit: 'm',
        category: 'Domain & Discretization',
        shortDesc: '3D Domain upper Z bound',
        detailedDesc: 'Maximum spatial coordinate along the Cartesian Z-axis in meters.'
    },
    'coordinate_system': {
        key: 'coordinate_system',
        label: 'Coordinate System',
        category: 'Domain & Discretization',
        shortDesc: '2D Coordinate formulation',
        detailedDesc: 'Axisymmetric (cylindrical r-z coordinates with 2πr geometric metric terms) or Cartesian (planar x-y slab).'
    },

    // --- CFD Solver Numerics & Execution ---
    'cfl': {
        key: 'cfl',
        label: 'CFL Number (Courant Safety)',
        unit: 'dim',
        category: 'Solver Numerics',
        shortDesc: 'Courant-Friedrichs-Lewy stability factor (Universal 0.60 default)',
        detailedDesc: 'Governs adaptive timestep selection Δt = CFL · Δt_critical. Standardized to a universal default of 0.60 across all Eulerian CFD, Lagrangian MPM, and FEM solvers with internal multi-dimensional geometric corrections. In coupled FSI models, the Coupler node serves as the single source of truth for CFL.'
    },
    'init_mode': {
        key: 'init_mode',
        label: 'Initialization Mode',
        category: 'Solver Numerics',
        shortDesc: 'Simulation starting condition source',
        detailedDesc: 'Multi-Material JWL (full multi-component detonation products + unreacted high explosive + ambient air), Ideal Gas (hot compressed gas burst), From1D (remap converged 1D spherical blast wave onto 2D/3D mesh), or From2D (revolve 2D axisymmetric blast onto 3D).'
    },
    'flux_scheme': {
        key: 'flux_scheme',
        label: 'Riemann Flux Splitting',
        category: 'Solver Numerics',
        shortDesc: 'Numerical flux solver across cell interfaces',
        detailedDesc: 'AUSM+ (Advection Upstream Splitting Method - sharp shock resolution, low numerical dissipation, exact contact surface tracking) or Rusanov (Local Lax-Friedrichs - highly robust, diffusive for extreme Mach shocks).'
    },
    'spatial_order': {
        key: 'spatial_order',
        label: 'Spatial Reconstruction Order',
        category: 'Solver Numerics',
        shortDesc: 'Order of spatial polynomial reconstruction',
        detailedDesc: '1st-Order (piecewise constant donor cell), 2nd-Order (piecewise linear MUSCL with Minmod/Van Leer slope limiters), or 3rd-Order (piecewise parabolic/WENO reconstruction).'
    },
    'temporal_order': {
        key: 'temporal_order',
        label: 'Time Integration Order',
        category: 'Solver Numerics',
        shortDesc: 'Temporal integration scheme',
        detailedDesc: '4 = Classical Runge-Kutta 4th-order (RK4), 5 = 2nd-Order ADER Cauchy-Kowalevski space-time predictor, 6 = 3rd-Order ADER-3 space-time predictor.'
    },
    'space_time_scheme': {
        key: 'space_time_scheme',
        label: 'Space-Time Scheme',
        category: 'Solver Numerics',
        shortDesc: 'Coupled spatial-temporal accuracy formulation',
        detailedDesc: 'For CFD: MUSCL-Hancock (2nd-Order Space/Time), ADER-2 (2nd-Order Cauchy-Kowalevski single-stage), or ADER-3 (3rd-Order Space/Time). For MPM: Leapfrog (2nd-Order Symplectic), RK2 (2nd-Order Predictor-Corrector), USL (Update Stress Last), or USF (Update Stress First).'
    },
    'device': {
        key: 'device',
        label: 'Compute Target Device',
        category: 'Hardware & Execution',
        shortDesc: 'Hardware architecture for solver execution',
        detailedDesc: 'CPU (multi-threaded via OpenMP SIMD loops) or CUDA GPU (massively parallel CUDA kernels with coalesced global memory access). Synchronized across coupled multi-physics solvers.'
    },
    'precision': {
        key: 'precision',
        label: 'Floating-Point Precision',
        category: 'Hardware & Execution',
        shortDesc: 'IEEE 754 floating-point format',
        detailedDesc: 'Single (FP32 - 2x faster GPU throughput, half memory footprint) or Double (FP64 - high numerical precision for sensitive conservation metrics).'
    },
    'telemetry_mode': {
        key: 'telemetry_mode',
        label: 'Telemetry Stream Mode',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Websocket telemetry broadcast rate',
        detailedDesc: 'Controls live telemetry streaming frequency: Enabled (full speed ~60 Hz), Throttled (1 Hz / 0.2 Hz for reduced network overhead), or Disabled.'
    },
    'telemetry_interval_ms': {
        key: 'telemetry_interval_ms',
        label: 'Telemetry Interval',
        unit: 'ms',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Milliseconds between telemetry broadcasts',
        detailedDesc: 'Target wall-clock period (ms) between WebSocket live state broadcasts sent to the web interface.'
    },
    'enable_gauges': {
        key: 'enable_gauges',
        label: 'Virtual Sensor Gauges',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Enable point history sensor recording',
        detailedDesc: 'Activates virtual sensor probe recording (pressure, density, impulse, overpressure) at discrete spatial coordinates over time.'
    },
    'enable_vtk': {
        key: 'enable_vtk',
        label: 'VTK Disk Snapshot Export',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Enable saving VTK XML files to disk',
        detailedDesc: 'Enables background streaming of simulation snapshots in VTK XML format (.vtu / .pvd) for ParaView / VisIt post-processing.'
    },

    // --- Material EOS & Explosives ---
    'material': {
        key: 'material',
        label: 'Material Source',
        category: 'Material EOS',
        shortDesc: 'Linked Material node defining thermodynamic and constitutive equation of state',
        detailedDesc: 'Selects the specific Material node providing equation of state (JWL Detonation Gas, Ideal Gas Blast, Elasticity, Plasticity, or Concrete Failure) to this charge or object entity.'
    },
    'material_type': {
        key: 'material_type',
        label: 'Material Formulation',
        category: 'Material EOS',
        shortDesc: 'Equation of state model type',
        detailedDesc: 'Air (Ideal Gas gamma-law EOS), JWL Charge (Jones-Wilkins-Lee empirical explosive expansion EOS), or Ideal Gas Charge (simplified gamma-law hot gas blast source).'
    },
    'composition': {
        key: 'composition',
        label: 'Explosive Composition',
        category: 'Material EOS',
        shortDesc: 'High-explosive chemical formulation',
        detailedDesc: 'Selects pre-calibrated Chapman-Jouguet detonation and JWL parameters from LLNL / Demolition range databases (TNT, C-4, Composition B, PBX 9501, Nitromethane, ANFO, PETN, RDX, etc., or Custom).'
    },
    'atm_pressure': {
        key: 'atm_pressure',
        label: 'Atmospheric Pressure (p_atm)',
        unit: 'Pa',
        category: 'Material EOS',
        shortDesc: 'Ambient initial pressure',
        detailedDesc: 'Ambient baseline atmospheric pressure (Pa). Standard sea-level reference is 101,325 Pa (1.01325 bar / 14.7 psi).'
    },
    'atm_temperature': {
        key: 'atm_temperature',
        label: 'Atmospheric Temperature (T_atm)',
        unit: 'K',
        category: 'Material EOS',
        shortDesc: 'Ambient initial temperature',
        detailedDesc: 'Ambient baseline temperature (K). Standard ambient reference is 288.15 K (15°C).'
    },
    'gamma': {
        key: 'gamma',
        label: 'Adiabatic Ratio of Specific Heats (γ)',
        unit: 'dim',
        category: 'Material EOS',
        shortDesc: 'Specific heat ratio Cp / Cv',
        detailedDesc: 'Dimensionless ratio of specific heats gamma = Cp / Cv. Standard value for dry diatomic air is 1.40; detonation product gases typically range from 1.25 to 1.35.'
    },
    'rho': {
        key: 'rho',
        label: 'Unreacted Solid Density (ρ₀)',
        unit: 'kg/m³',
        category: 'Material EOS',
        shortDesc: 'Initial high-explosive mass density',
        detailedDesc: 'Solid packed density of the high-explosive charge (kg/m³). E.g. TNT = 1630 kg/m³, Composition B = 1717 kg/m³, PBX 9501 = 1830 kg/m³.'
    },
    'detonation_energy': {
        key: 'detonation_energy',
        label: 'Detonation Energy (E₀)',
        unit: 'J/kg',
        category: 'Material EOS',
        shortDesc: 'Specific Chapman-Jouguet heat of detonation',
        detailedDesc: 'Specific chemical energy released per unit mass upon detonation (J/kg). TNT reference is 4.29 × 10⁶ J/kg (4.29 MJ/kg).'
    },
    'det_vel': {
        key: 'det_vel',
        label: 'Detonation Velocity (D_CJ)',
        unit: 'm/s',
        category: 'Material EOS',
        shortDesc: 'Chapman-Jouguet detonation wave speed',
        detailedDesc: 'Steady-state Chapman-Jouguet detonation wave velocity (m/s). Governs the rate of unreacted solid consumption into high-pressure detonation gas.'
    },
    'jwl_A': {
        key: 'jwl_A',
        label: 'JWL Coefficient A',
        unit: 'Pa',
        category: 'Material EOS',
        shortDesc: 'Leading high-pressure JWL exponent coefficient',
        detailedDesc: 'Empirical JWL equation of state leading pressure constant A (Pa). Governs initial ultra-high pressure expansion behavior near the Chapman-Jouguet state.'
    },
    'jwl_B': {
        key: 'jwl_B',
        label: 'JWL Coefficient B',
        unit: 'Pa',
        category: 'Material EOS',
        shortDesc: 'Intermediate expansion JWL coefficient',
        detailedDesc: 'Empirical JWL intermediate pressure constant B (Pa). Governs intermediate pressure regime during product gas volume expansion.'
    },
    'jwl_R1': {
        key: 'jwl_R1',
        label: 'JWL Exponent R₁',
        unit: 'dim',
        category: 'Material EOS',
        shortDesc: 'Primary dimensionless JWL decay rate',
        detailedDesc: 'Dimensionless decay exponent R1 in the term A · exp(-R1 · V). Typically ranges between 4.0 and 5.0.'
    },
    'jwl_R2': {
        key: 'jwl_R2',
        label: 'JWL Exponent R₂',
        unit: 'dim',
        category: 'Material EOS',
        shortDesc: 'Secondary dimensionless JWL decay rate',
        detailedDesc: 'Dimensionless decay exponent R2 in the term B · exp(-R2 · V). Typically ranges between 0.90 and 1.50.'
    },
    'jwl_omega': {
        key: 'jwl_omega',
        label: 'JWL Fractional Grüneisen (ω)',
        unit: 'dim',
        category: 'Material EOS',
        shortDesc: 'Low-pressure asymptotic ideal gas term',
        detailedDesc: 'Dimensionless fractional Grüneisen parameter omega in the JWL EOS term (omega · e / V). Typically 0.25–0.38.'
    },
    'ideal_gamma': {
        key: 'ideal_gamma',
        label: 'Ideal Gas Gamma (γ)',
        unit: 'dim',
        category: 'Material EOS',
        shortDesc: 'Adiabatic index for ideal explosive model',
        detailedDesc: 'Ratio of specific heats for the Ideal Gas Charge model (typically 1.40).'
    },
    'ideal_rho_0': {
        key: 'ideal_rho_0',
        label: 'Ideal Charge Density (ρ₀)',
        unit: 'kg/m³',
        category: 'Material EOS',
        shortDesc: 'Initial density for ideal explosive gas',
        detailedDesc: 'Initial packed gas density (kg/m³) for ideal gas burst models.'
    },
    'ideal_e_0': {
        key: 'ideal_e_0',
        label: 'Ideal Charge Specific Energy (e₀)',
        unit: 'J/kg',
        category: 'Material EOS',
        shortDesc: 'Initial specific internal energy',
        detailedDesc: 'Specific thermal energy (J/kg) in the ideal gas burst initial state.'
    },

    // --- Charge Morphology & Geometry ---
    'charge_mass': {
        key: 'charge_mass',
        label: 'Charge Mass (M)',
        unit: 'kg',
        category: 'Charge Geometry',
        shortDesc: 'Total mass of high-explosive',
        detailedDesc: 'Total mass of explosive material in kilograms (kg). Automatically synchronizes with charge dimensions and material density.'
    },
    'charge_shape': {
        key: 'charge_shape',
        label: 'Charge Shape',
        category: 'Charge Geometry',
        shortDesc: 'Geometric morphology of charge',
        detailedDesc: 'Sphere (isotropic 1D/2D/3D expansion), Cylinder (directional blast with end-jetting), or Block (Cartesian cuboid slab).'
    },
    'charge_radius': {
        key: 'charge_radius',
        label: 'Charge Radius (R)',
        unit: 'm',
        category: 'Charge Geometry',
        shortDesc: 'Radius of sphere or cylinder',
        detailedDesc: 'Physical outer radius of the spherical or cylindrical explosive charge in meters.'
    },
    'charge_height': {
        key: 'charge_height',
        label: 'Charge Length / Height (H)',
        unit: 'm',
        category: 'Charge Geometry',
        shortDesc: 'Axial length of cylindrical charge',
        detailedDesc: 'Total axial length of cylindrical explosive charge in meters.'
    },
    'charge_aspect_ratio': {
        key: 'charge_aspect_ratio',
        label: 'Aspect Ratio (L/D)',
        unit: 'dim',
        category: 'Charge Geometry',
        shortDesc: 'Length-to-diameter ratio',
        detailedDesc: 'Dimensionless ratio of cylinder length to cylinder diameter (L/D).'
    },
    'charge_r': {
        key: 'charge_r',
        label: 'Charge Center R',
        unit: 'm',
        category: 'Charge Geometry',
        shortDesc: 'Radial position of charge centroid',
        detailedDesc: 'Radial coordinate (m) of charge center in 2D axisymmetric domain.'
    },
    'charge_z': {
        key: 'charge_z',
        label: 'Charge Center Z',
        unit: 'm',
        category: 'Charge Geometry',
        shortDesc: 'Axial position of charge centroid',
        detailedDesc: 'Axial coordinate (m) of charge center in 2D or 3D domain.'
    },
    'charge_x': {
        key: 'charge_x',
        label: 'Charge Center X',
        unit: 'm',
        category: 'Charge Geometry',
        shortDesc: 'X-coordinate of charge centroid',
        detailedDesc: 'Cartesian X-coordinate (m) of charge centroid in 3D domain.'
    },
    'charge_y': {
        key: 'charge_y',
        label: 'Charge Center Y',
        unit: 'm',
        category: 'Charge Geometry',
        shortDesc: 'Y-coordinate of charge centroid',
        detailedDesc: 'Cartesian Y-coordinate (m) of charge centroid in 3D domain.'
    },
    'charge_lx': {
        key: 'charge_lx',
        label: 'Charge Dimension X (L_x)',
        unit: 'm',
        category: 'Charge Geometry',
        shortDesc: 'Block charge length along X',
        detailedDesc: 'Full side length of rectangular cuboid charge along X-axis in meters.'
    },
    'charge_ly': {
        key: 'charge_ly',
        label: 'Charge Dimension Y (L_y)',
        unit: 'm',
        category: 'Charge Geometry',
        shortDesc: 'Block charge length along Y',
        detailedDesc: 'Full side length of rectangular cuboid charge along Y-axis in meters.'
    },
    'charge_lz': {
        key: 'charge_lz',
        label: 'Charge Dimension Z (L_z)',
        unit: 'm',
        category: 'Charge Geometry',
        shortDesc: 'Block charge length along Z',
        detailedDesc: 'Full side length of rectangular cuboid charge along Z-axis in meters.'
    },
    'charge_rot_x': {
        key: 'charge_rot_x',
        label: 'Charge Rotation X',
        unit: 'deg',
        category: 'Charge Geometry',
        shortDesc: 'Euler roll angle around X-axis',
        detailedDesc: 'Rotation angle (degrees) of charge principal axis around X-axis.'
    },
    'charge_rot_y': {
        key: 'charge_rot_y',
        label: 'Charge Rotation Y',
        unit: 'deg',
        category: 'Charge Geometry',
        shortDesc: 'Euler pitch angle around Y-axis',
        detailedDesc: 'Rotation angle (degrees) of charge principal axis around Y-axis.'
    },
    'charge_rot_z': {
        key: 'charge_rot_z',
        label: 'Charge Rotation Z',
        unit: 'deg',
        category: 'Charge Geometry',
        shortDesc: 'Euler yaw angle around Z-axis',
        detailedDesc: 'Rotation angle (degrees) of charge principal axis around Z-axis.'
    },

    // --- Detonator Point Sources ---
    'detonator_r': {
        key: 'detonator_r',
        label: 'Detonator R Position',
        unit: 'm',
        category: 'Detonator',
        shortDesc: 'Radial coordinate of detonation initiation',
        detailedDesc: 'Radial position (m) in 2D r-z space where high-explosive ignition kernel is seeded.'
    },
    'detonator_z': {
        key: 'detonator_z',
        label: 'Detonator Z Position',
        unit: 'm',
        category: 'Detonator',
        shortDesc: 'Axial coordinate of detonation initiation',
        detailedDesc: 'Axial position (m) where high-explosive ignition kernel is seeded.'
    },
    'detonator_radius': {
        key: 'detonator_radius',
        label: 'Detonator Kernel Radius',
        unit: 'm',
        category: 'Detonator',
        shortDesc: 'Radius of initial detonation hotspot',
        detailedDesc: 'Initial hot-spot ignition radius (m). Must span at least 1–2 grid cells to ensure smooth numerical wave formation.'
    },
    'detonator_x': {
        key: 'detonator_x',
        label: 'Detonator X Position',
        unit: 'm',
        category: 'Detonator',
        shortDesc: 'Cartesian X coordinate of detonation point',
        detailedDesc: 'X-coordinate (m) of detonation point source in 3D Cartesian space.'
    },
    'detonator_y': {
        key: 'detonator_y',
        label: 'Detonator Y Position',
        unit: 'm',
        category: 'Detonator',
        shortDesc: 'Cartesian Y coordinate of detonation point',
        detailedDesc: 'Y-coordinate (m) of detonation point source in 3D Cartesian space.'
    },

    // --- Solution Remapping ---
    'explosive_r': {
        key: 'explosive_r',
        label: 'Remap Origin R',
        unit: 'm',
        category: 'Remapping Pipeline',
        shortDesc: 'Radial location of remapped blast origin',
        detailedDesc: 'Radial origin coordinate (m) where the 1D spherical blast wave profile is mapped onto the 2D mesh.'
    },
    'explosive_z': {
        key: 'explosive_z',
        label: 'Remap Origin Z',
        unit: 'm',
        category: 'Remapping Pipeline',
        shortDesc: 'Axial location of remapped blast origin',
        detailedDesc: 'Axial origin coordinate (m) where the 1D/2D blast wave profile is mapped onto the destination mesh.'
    },
    'explosive_x': {
        key: 'explosive_x',
        label: 'Remap Origin X',
        unit: 'm',
        category: 'Remapping Pipeline',
        shortDesc: 'X coordinate of remapped blast origin',
        detailedDesc: 'Cartesian X coordinate (m) where the 1D/2D blast profile is centered in 3D space.'
    },
    'explosive_y': {
        key: 'explosive_y',
        label: 'Remap Origin Y',
        unit: 'm',
        category: 'Remapping Pipeline',
        shortDesc: 'Y coordinate of remapped blast origin',
        detailedDesc: 'Cartesian Y coordinate (m) where the 1D/2D blast profile is centered in 3D space.'
    },
    'remap_radius': {
        key: 'remap_radius',
        label: 'Remap Radial Cutoff (R_cut)',
        unit: 'm',
        category: 'Remapping Pipeline',
        shortDesc: 'Maximum radius to interpolate from upstream run',
        detailedDesc: 'Radial distance (m) from the remap origin to copy state variables. Cells outside this radius remain at ambient conditions (0 = remap entire upstream domain).'
    },
    'trigger_type': {
        key: 'trigger_type',
        label: 'Remap / Output Trigger Type',
        category: 'Remapping Pipeline',
        shortDesc: 'Trigger condition for event',
        detailedDesc: 'For Remap: "end" (triggers when upstream solver finishes), "time" (triggers at specific physical simulation time), or "step" (triggers at specific cycle count). For VTK: "Step Interval" or "Time Interval".'
    },
    'trigger_val': {
        key: 'trigger_val',
        label: 'Trigger Value Threshold',
        unit: 's / steps',
        category: 'Remapping Pipeline',
        shortDesc: 'Numerical value for time/step trigger',
        detailedDesc: 'Threshold physical simulation time (seconds) or iteration cycle count that fires the remapping event.'
    },

    // --- CAD & Solid Boundary Obstacles ---
    'stl_file': {
        key: 'stl_file',
        label: 'STL Mesh Filepath',
        category: 'Boundary Geometry',
        shortDesc: 'Path to 3D triangular surface mesh (.stl)',
        detailedDesc: 'Absolute or relative filepath to binary/ASCII STL geometry for solid obstacle Immersed Boundary Method (IBM) rasterization. When saving a model, external STL files are automatically copied alongside the model and updated to portable local relative references (e.g. ./mesh.stl).'
    },
    'k_file': {
        key: 'k_file',
        label: 'LS-DYNA Keyword Filepath',
        category: 'Structural Mechanics',
        shortDesc: 'Path to LS-DYNA Keyword file (*.k / *.key)',
        detailedDesc: 'Filepath to LS-DYNA input deck containing *NODE, *ELEMENT_SOLID, *SECTION, and *MAT keywords for 3D FEM structural simulation. When saving a model, external LS-DYNA decks are automatically copied alongside the model and updated to portable local relative references (e.g. ./structure.k).'
    },
    'geometry_hash': {
        key: 'geometry_hash',
        label: 'Geometry Signature Hash',
        category: 'Boundary Geometry',
        shortDesc: 'Unique cache key for rasterized mask',
        detailedDesc: 'Cryptographic hash identifying the voxelized geometry mask to avoid redundant GPU voxelization across runs.'
    },
    'voxelization_method': {
        key: 'voxelization_method',
        label: 'Voxelization Algorithm',
        category: 'Boundary Geometry',
        shortDesc: 'Algorithm for rasterizing 3D solid triangles into grid',
        detailedDesc: 'watertight_floodfill (fastest, seed-point raycast + 3D flood fill for closed manifolds), watertight_raycast (3-axis Jordan parity raycasting), thin_shell (surface shell triangles only without interior fill), or winding_number (hierarchical solid angle evaluation for open/dirty CAD meshes).'
    },

    // --- MPM Continuum Particle Dynamics ---
    'transfer_scheme': {
        key: 'transfer_scheme',
        label: 'MPM Transfer Kernel',
        category: 'MPM Particle Mechanics',
        shortDesc: 'Particle-grid interpolation shape function',
        detailedDesc: 'Radial MLS (Isotropic Moving Least Squares MPM with Wendland C2 radial kernel - 100% rotationally invariant, zero grid-crossing noise, eliminates cruciform detonation bias), BSpline (quadratic B-splines - smooth), Cubic BSpline (cubic B-splines - extended C2 support), GIMP (Generalized Interpolation Material Point), Standard (Dirac-delta linear interpolation), or Default (Inherit domain transfer scheme).'
    },
    'particle_distribution': {
        key: 'particle_distribution',
        label: 'Particle Seeding Lattice Pattern',
        category: 'MPM Particle Discretization',
        shortDesc: 'Geometric arrangement of initial particle centroids',
        detailedDesc: 'Cartesian (standard orthogonal grid seeding; prone to directional slip planes) or Hexagonal (2D Triangular / 3D Hexagonal Close-Packed HCP lattice with 12-fold coordination symmetry; eliminates Cartesian grid alignment artifacts).'
    },
    'boundary_filling': {
        key: 'boundary_filling',
        label: 'Curved Boundary Discretization Mode',
        category: 'MPM Particle Discretization',
        shortDesc: 'Volume fractioning and centroid alignment on curved boundaries',
        detailedDesc: 'Stairstepped (binary inside/outside voxelization) or Partial (sub-voxel cut-cell integration with centroid alignment; guarantees exact analytical volume and mass conservation on curved primitives).'
    },
    'velocity_scheme': {
        key: 'velocity_scheme',
        label: 'MPM Velocity Scheme',
        category: 'MPM Particle Mechanics',
        shortDesc: 'Particle velocity update algorithm',
        detailedDesc: 'APIC (Affine Particle-in-Cell - preserves angular momentum and vorticity with zero artificial dissipation; recommended default), PIC (Particle-in-Cell - highly dissipative), or FLIP (Fluid-Implicit-Particle - zero dissipation, blended with APIC).'
    },
    'flip_blend': {
        key: 'flip_blend',
        label: 'FLIP / APIC Blending Ratio',
        unit: '%',
        category: 'MPM Particle Mechanics',
        shortDesc: 'Fraction of FLIP velocity vs APIC velocity',
        detailedDesc: 'Blending coefficient (0.0 to 1.0) between FLIP and APIC/PIC momentum updates. 0.95 = 95% FLIP (energy conserving) + 5% APIC (noise damping).'
    },
    'smooth_plastic_strain': {
        key: 'smooth_plastic_strain',
        label: 'Plastic Strain Spatial Smoothing',
        category: 'MPM Particle Mechanics',
        shortDesc: 'Filter plastic strain across background grid',
        detailedDesc: 'Applies background grid smoothing to accumulated effective plastic strain to prevent unphysical localized shear band singularities.'
    },
    'ppc': {
        key: 'ppc',
        label: 'Particles Per Cell (PPC)',
        unit: 'particles',
        category: 'MPM Particle Mechanics',
        shortDesc: 'Initial particle sampling density per cell',
        detailedDesc: 'Number of Lagrangian material points initialized per Eulerian grid cell (typically 4 for 2D, 8 for 3D). Higher PPC resolves complex boundary geometries and fracture fragments with higher fidelity.'
    },
    'shape_type': {
        key: 'shape_type',
        label: 'Structural Shape Type',
        category: 'Structural Mechanics',
        shortDesc: 'Geometry primitive for solid body',
        detailedDesc: 'Selects the primitive geometric shape (Box, Cylinder, Sphere, STL Surface, Rectangle, Circle) for structural discretization.'
    },
    'pos_x': {
        key: 'pos_x',
        label: 'Centroid X Position',
        unit: 'm',
        category: 'Structural Mechanics',
        shortDesc: 'Initial X-coordinate of solid object centroid',
        detailedDesc: 'Spatial X-coordinate (m) of structural body centroid.'
    },
    'pos_y': {
        key: 'pos_y',
        label: 'Centroid Y Position',
        unit: 'm',
        category: 'Structural Mechanics',
        shortDesc: 'Initial Y-coordinate of solid object centroid',
        detailedDesc: 'Spatial Y-coordinate (m) of structural body centroid.'
    },
    'pos_z': {
        key: 'pos_z',
        label: 'Centroid Z Position',
        unit: 'm',
        category: 'Structural Mechanics',
        shortDesc: 'Initial Z-coordinate of solid object centroid',
        detailedDesc: 'Spatial Z-coordinate (m) of structural body centroid.'
    },
    'size_x': {
        key: 'size_x',
        label: 'Dimension X (Size_X)',
        unit: 'm',
        category: 'Structural Mechanics',
        shortDesc: 'Solid box length along X',
        detailedDesc: 'Total physical width of structural box along X-axis in meters.'
    },
    'size_y': {
        key: 'size_y',
        label: 'Dimension Y (Size_Y)',
        unit: 'm',
        category: 'Structural Mechanics',
        shortDesc: 'Solid box length along Y',
        detailedDesc: 'Total physical height of structural box along Y-axis in meters.'
    },
    'size_z': {
        key: 'size_z',
        label: 'Dimension Z (Size_Z)',
        unit: 'm',
        category: 'Structural Mechanics',
        shortDesc: 'Solid box length along Z',
        detailedDesc: 'Total physical depth of structural box along Z-axis in meters.'
    },
    'radius': {
        key: 'radius',
        label: 'Outer Radius (R_out)',
        unit: 'm',
        category: 'Structural Mechanics',
        shortDesc: 'Outer radius of cylinder or sphere',
        detailedDesc: 'Outer physical radius (m) of structural cylinder or sphere.'
    },
    'inner_radius': {
        key: 'inner_radius',
        label: 'Inner Radius (R_in)',
        unit: 'm',
        category: 'Structural Mechanics',
        shortDesc: 'Inner bore radius for hollow tubes/cylinders',
        detailedDesc: 'Internal bore radius (m) for hollow pipe, tube, or ring geometries (0.0 = solid cylinder).'
    },
    'height': {
        key: 'height',
        label: 'Height / Length (H)',
        unit: 'm',
        category: 'Structural Mechanics',
        shortDesc: 'Total height of structural cylinder',
        detailedDesc: 'Total physical length/height (m) of cylindrical solid body along its principal axis.'
    },
    'vel_x': {
        key: 'vel_x',
        label: 'Initial Velocity X (V_x)',
        unit: 'm/s',
        category: 'Structural Mechanics',
        shortDesc: 'Initial translational velocity along X',
        detailedDesc: 'Initial linear velocity component (m/s) along Cartesian X-axis.'
    },
    'vel_y': {
        key: 'vel_y',
        label: 'Initial Velocity Y (V_y)',
        unit: 'm/s',
        category: 'Structural Mechanics',
        shortDesc: 'Initial translational velocity along Y',
        detailedDesc: 'Initial linear velocity component (m/s) along Cartesian Y-axis.'
    },
    'vel_z': {
        key: 'vel_z',
        label: 'Initial Velocity Z (V_z)',
        unit: 'm/s',
        category: 'Structural Mechanics',
        shortDesc: 'Initial translational velocity along Z',
        detailedDesc: 'Initial linear velocity component (m/s) along Cartesian Z-axis.'
    },
    'angular_vel': {
        key: 'angular_vel',
        label: 'Angular Velocity (ω)',
        unit: 'rad/s',
        category: 'Structural Mechanics',
        shortDesc: 'Initial rotational angular speed',
        detailedDesc: 'Initial angular velocity (rad/s) about the center of mass in 2D.'
    },
    'angular_vel_x': {
        key: 'angular_vel_x',
        label: 'Angular Velocity X (ω_x)',
        unit: 'rad/s',
        category: 'Structural Mechanics',
        shortDesc: 'Initial angular spin around X-axis',
        detailedDesc: 'Initial rotational velocity (rad/s) about the centroid X-axis.'
    },
    'angular_vel_y': {
        key: 'angular_vel_y',
        label: 'Angular Velocity Y (ω_y)',
        unit: 'rad/s',
        category: 'Structural Mechanics',
        shortDesc: 'Initial angular spin around Y-axis',
        detailedDesc: 'Initial rotational velocity (rad/s) about the centroid Y-axis.'
    },
    'angular_vel_z': {
        key: 'angular_vel_z',
        label: 'Angular Velocity Z (ω_z)',
        unit: 'rad/s',
        category: 'Structural Mechanics',
        shortDesc: 'Initial angular spin around Z-axis',
        detailedDesc: 'Initial rotational velocity (rad/s) about the centroid Z-axis.'
    },

    // --- Solid Constitutive Models & Materials ---
    'material_model': {
        key: 'material_model',
        label: 'Constitutive Model & Formulation',
        category: 'Material Constitutive',
        shortDesc: 'Universal constitutive formulation or thermodynamic EOS model',
        detailedDesc: 'Selects the constitutive formulation or thermodynamic EOS: Linear Elastic, Hypoelastic (von Mises J2 plasticity), Johnson-Cook + Mie-Grüneisen (viscoplasticity + shock Hugoniot), Concrete Damage (RHT, K&C, CSCM), CREST Reactive Burn (hot-spot SDT), Ideal Gas (ambient atmospheric air), Ideal Gas Charge (simplified gamma-law blast source), or JWL Detonation Gas (Jones-Wilkins-Lee explosive expansion EOS).'
    },
    'preset': {
        key: 'preset',
        label: 'Material Property Preset',
        category: 'Material Constitutive',
        shortDesc: 'Pre-calibrated empirical parameters from literature for the selected model',
        detailedDesc: 'Loads peer-reviewed, laboratory-calibrated material properties dynamically filtered for the active constitutive formulation: structural & armor steels, light alloys, concrete/masonry grades, soils & geomaterials (marine clay, silty clay, saturated mud/slurry, sand, granite, basalt, sandstone, limestone, shale, ice), soft materials & bio-surrogates (10% & 20% ballistic gelatins, hydrodynamic water, silicone tissue simulant, hydrogel), polymers, ceramics, unreacted explosive solids, CFD ideal gases, and JWL detonation products (or Custom).'
    },
    'density': {
        key: 'density',
        label: 'Mass Density (ρ₀)',
        unit: 'kg/m³',
        category: 'Material Constitutive',
        shortDesc: 'Reference mass density',
        detailedDesc: 'Reference initial mass density (kg/m³) of the continuum medium (fluid gas or solid). For Ideal Gas EOS, governed by ρ = p_atm / (R · T_atm). For solid materials, governs inertia, stress wave propagation speeds (c_p, c_s), and dynamic acoustic impedance.'
    },
    'ambient_rho': {
        key: 'ambient_rho',
        label: 'Ambient Gas Density (ρ_amb)',
        unit: 'kg/m³',
        category: 'Atmospheric & Ambient EOS',
        shortDesc: 'Ambient atmospheric gas density',
        detailedDesc: 'Thermodynamic equilibrium mass density (kg/m³) of unperturbed ambient air, calculated via ρ = p_atm / (R · T_atm) with R = 287.058 J/(kg·K).'
    },
    'ambient_p': {
        key: 'ambient_p',
        label: 'Ambient Gas Pressure (p_amb)',
        unit: 'Pa',
        category: 'Atmospheric & Ambient EOS',
        shortDesc: 'Ambient atmospheric static pressure',
        detailedDesc: 'Thermodynamic equilibrium hydrostatic pressure (Pa) of unperturbed ambient air, identical to atmospheric pressure p_atm (101,325 Pa at STP).'
    },
    'enable_heterogeneity': {
        key: 'enable_heterogeneity',
        label: 'Material Heterogeneity',
        category: 'Material Constitutive',
        shortDesc: 'Enable stochastic spatial strength variation',
        detailedDesc: 'Applies Weibull or Gaussian stochastic distribution to material yield strength and failure strain across elements to represent aggregate heterogeneity.'
    },
    'enable_anisotropy': {
        key: 'enable_anisotropy',
        label: 'Transverse Anisotropy',
        category: 'Material Constitutive',
        shortDesc: 'Enable directional strength / stiffness anisotropy',
        detailedDesc: 'Enables transversely isotropic elasticity and directional failure thresholds along a specified material symmetry vector.'
    },
    'anisotropy_ratio': {
        key: 'anisotropy_ratio',
        label: 'Anisotropy Ratio',
        unit: 'dim',
        category: 'Material Constitutive',
        shortDesc: 'Ratio of longitudinal to transverse directional strength',
        detailedDesc: 'Ratio of longitudinal along-axis stiffness/strength to transverse cross-axis properties for laminated composites, geological bedding, or reinforced media.'
    },
    'anisotropy_axis': {
        key: 'anisotropy_axis',
        label: 'Anisotropy Axis',
        category: 'Material Constitutive',
        shortDesc: 'Principal alignment axis for material anisotropy',
        detailedDesc: 'Selects the principal material symmetry vector: X-axis [1,0,0], Y-axis [0,1,0], Z-axis [0,0,1], or Custom user-specified 3D direction vector.'
    },
    'anisotropy_dir_x': {
        key: 'anisotropy_dir_x',
        label: 'Anisotropy Dir X',
        unit: 'dim',
        category: 'Material Constitutive',
        shortDesc: 'X-component of custom anisotropy orientation vector',
        detailedDesc: 'Normalized X-component of the principal material symmetry vector for anisotropic constitutive response.'
    },
    'anisotropy_dir_y': {
        key: 'anisotropy_dir_y',
        label: 'Anisotropy Dir Y',
        unit: 'dim',
        category: 'Material Constitutive',
        shortDesc: 'Y-component of custom anisotropy orientation vector',
        detailedDesc: 'Normalized Y-component of the principal material symmetry vector for anisotropic constitutive response.'
    },
    'anisotropy_dir_z': {
        key: 'anisotropy_dir_z',
        label: 'Anisotropy Dir Z',
        unit: 'dim',
        category: 'Material Constitutive',
        shortDesc: 'Z-component of custom anisotropy orientation vector',
        detailedDesc: 'Normalized Z-component of the principal material symmetry vector for anisotropic constitutive response.'
    },
    'youngs_modulus': {
        key: 'youngs_modulus',
        label: 'Young\'s Modulus (E)',
        unit: 'Pa',
        category: 'Material Constitutive',
        shortDesc: 'Linear elastic tensile stiffness',
        detailedDesc: 'Elastic modulus E (Pa / GPa) relating uniaxial stress to uniaxial strain in the linear elastic regime before yielding.'
    },
    'poissons_ratio': {
        key: 'poissons_ratio',
        label: 'Poisson\'s Ratio (ν)',
        unit: 'dim',
        category: 'Material Constitutive',
        shortDesc: 'Transverse contraction to axial strain ratio',
        detailedDesc: 'Dimensionless ratio nu of lateral contraction to longitudinal extension. Establishes shear modulus G = E / [2(1+nu)] and bulk modulus K = E / [3(1-2nu)].'
    },
    'yield_stress': {
        key: 'yield_stress',
        label: 'Static Yield Strength (σ_y0)',
        unit: 'Pa',
        category: 'Material Constitutive',
        shortDesc: 'Initial von Mises yield stress limit',
        detailedDesc: 'Initial equivalent von Mises yield stress (Pa / MPa) where reversible linear elasticity ends and irreversible plastic deformation begins.'
    },
    'hardening_modulus': {
        key: 'hardening_modulus',
        label: 'Hardening Modulus (H)',
        unit: 'Pa',
        category: 'Material Constitutive',
        shortDesc: 'Linear plastic tangent hardening slope',
        detailedDesc: 'Plastic hardening modulus H (Pa) governing isotropic flow stress evolution: sigma_y = sigma_y0 + H · epsilon_p.'
    },
    'failure_strain': {
        key: 'failure_strain',
        label: 'Failure Plastic Strain (ε_p^f)',
        unit: 'dim',
        category: 'Material Failure',
        shortDesc: 'Maximum equivalent plastic strain before rupture',
        detailedDesc: 'Equivalent plastic strain threshold at which material integrity fails, triggering stress degradation, damage accumulation, or particle erosion.'
    },
    'tensile_failure_stress': {
        key: 'tensile_failure_stress',
        label: 'Spall Tensile Cutoff (σ_cut / P_min)',
        unit: 'Pa',
        category: 'Material Failure',
        shortDesc: 'Maximum hydrostatic tensile stress limit',
        detailedDesc: 'Hydrostatic spall tension limit (Pa). Hydrostatic pressures exceeding this tensile threshold trigger spall micro-void nucleation and cavitation.'
    },
    'enable_strain_erosion': {
        key: 'enable_strain_erosion',
        label: 'Plastic Strain Erosion',
        category: 'Material Failure',
        shortDesc: 'Erode elements exceeding critical strain',
        detailedDesc: 'Deletes/erodes FEM elements or MPM particles once equivalent plastic strain exceeds the erosion_strain threshold.'
    },
    'erosion_strain': {
        key: 'erosion_strain',
        label: 'Erosion Plastic Strain Limit',
        unit: 'dim',
        category: 'Material Failure',
        shortDesc: 'Critical strain threshold for element removal',
        detailedDesc: 'Equivalent plastic strain value at which distorted elements are permanently eroded to prevent hyper-deformation numerical errors.'
    },
    'enable_stress_erosion': {
        key: 'enable_stress_erosion',
        label: 'Tensile Stress Erosion',
        category: 'Material Failure',
        shortDesc: 'Erode elements exceeding tensile limit',
        detailedDesc: 'Deletes/erodes elements experiencing tensile stress beyond the erosion_stress limit.'
    },
    'erosion_stress': {
        key: 'erosion_stress',
        label: 'Erosion Stress Limit',
        unit: 'Pa',
        category: 'Material Failure',
        shortDesc: 'Critical tensile stress for element deletion',
        detailedDesc: 'Maximum principal tensile stress (Pa) triggering immediate element erosion.'
    },
    'enable_timestep_erosion': {
        key: 'enable_timestep_erosion',
        label: 'Timestep Degradation Erosion',
        category: 'Material Failure',
        shortDesc: 'Erode highly compressed elements causing timestep collapse',
        detailedDesc: 'Protects explicit time integration by deleting severely compressed elements whose stable CFL timestep drops below a critical fraction.'
    },
    'timestep_erosion_factor': {
        key: 'timestep_erosion_factor',
        label: 'Timestep Erosion Fraction',
        unit: 'dim',
        category: 'Material Failure',
        shortDesc: 'Timestep reduction threshold factor (e.g. 0.10)',
        detailedDesc: 'Fraction of initial stable timestep (e.g. 0.10 = 10%) below which an element is eroded to avoid grinding solver progress to a halt.'
    },

    // --- Johnson-Cook & Shock EOS ---
    'jc_A': {
        key: 'jc_A',
        label: 'Johnson-Cook Static Yield (A)',
        unit: 'Pa',
        category: 'Johnson-Cook Viscoplasticity',
        shortDesc: 'Initial static yield strength parameter',
        detailedDesc: 'Parameter A (Pa) in the Johnson-Cook model: sigma = [A + B·eps^n]·[1 + C·ln(eps_dot*)]·[1 - T*^m].'
    },
    'jc_B': {
        key: 'jc_B',
        label: 'Johnson-Cook Strain Hardening (B)',
        unit: 'Pa',
        category: 'Johnson-Cook Viscoplasticity',
        shortDesc: 'Strain hardening coefficient',
        detailedDesc: 'Hardening coefficient B (Pa) scaling plastic strain hardening.'
    },
    'jc_n': {
        key: 'jc_n',
        label: 'Johnson-Cook Hardening Exponent (n)',
        unit: 'dim',
        category: 'Johnson-Cook Viscoplasticity',
        shortDesc: 'Nonlinear strain hardening exponent',
        detailedDesc: 'Dimensionless exponent n governing the curvature of work hardening.'
    },
    'jc_C': {
        key: 'jc_C',
        label: 'Johnson-Cook Strain Rate Sensitivity (C)',
        unit: 'dim',
        category: 'Johnson-Cook Viscoplasticity',
        shortDesc: 'Logarithmic strain rate sensitivity parameter',
        detailedDesc: 'Dimensionless parameter C governing dynamic strength enhancement at high strain rates (10²–10⁶ s⁻¹) typical of blast impacts.'
    },
    'jc_m': {
        key: 'jc_m',
        label: 'Johnson-Cook Thermal Softening (m)',
        unit: 'dim',
        category: 'Johnson-Cook Viscoplasticity',
        shortDesc: 'Thermal softening exponent',
        detailedDesc: 'Dimensionless exponent m modeling adiabatic thermal softening as temperature approaches the melting point.'
    },
    'jc_d1': {
        key: 'jc_d1',
        label: 'Johnson-Cook Fracture D1',
        unit: 'dim',
        category: 'Johnson-Cook Damage & Fracture',
        shortDesc: 'Initial damage strain D1 (Recommended: -0.1 to +0.5, Default: 0.0)',
        detailedDesc: 'Constant parameter D1 in the Johnson-Cook triaxial fracture strain equation: eps_f = (D1 + D2*exp(D3*eta))*(1 + D4*ln(eps_dot*))*(1 + D5*T*). Typical values: 0.05 for 4340 steel, 0.54 for OFHC copper, 0.07 for 6061-T6 aluminum. Set all D1-D5 to 0.0 to disable Johnson-Cook triaxial damage accumulation.'
    },
    'jc_d2': {
        key: 'jc_d2',
        label: 'Johnson-Cook Fracture D2',
        unit: 'dim',
        category: 'Johnson-Cook Damage & Fracture',
        shortDesc: 'Triaxiality damage multiplier D2 (Recommended: 0.2 to 5.0)',
        detailedDesc: 'Exponential triaxiality scaling coefficient D2 in the Johnson-Cook fracture criterion. Typical values: 3.44 for 4340 steel, 4.89 for OFHC copper, 1.25 for 6061-T6 aluminum.'
    },
    'jc_d3': {
        key: 'jc_d3',
        label: 'Johnson-Cook Fracture D3',
        unit: 'dim',
        category: 'Johnson-Cook Damage & Fracture',
        shortDesc: 'Triaxiality exponent D3 (Recommended: -3.5 to -0.5)',
        detailedDesc: 'Dimensionless triaxiality exponent D3 governing fracture strain decay under hydrostatic tension (eta = -p/q). Typical values: -2.12 for 4340 steel, -3.03 for OFHC copper, -1.50 for 6061-T6 aluminum.'
    },
    'jc_d4': {
        key: 'jc_d4',
        label: 'Johnson-Cook Fracture D4',
        unit: 'dim',
        category: 'Johnson-Cook Damage & Fracture',
        shortDesc: 'Strain rate damage coefficient D4 (Recommended: 0.001 to 0.02)',
        detailedDesc: 'Logarithmic strain rate sensitivity coefficient D4 in the Johnson-Cook fracture model. Typical values: 0.002 for 4340 steel, 0.014 for OFHC copper, 0.005 for 6061-T6 aluminum.'
    },
    'jc_d5': {
        key: 'jc_d5',
        label: 'Johnson-Cook Fracture D5',
        unit: 'dim',
        category: 'Johnson-Cook Damage & Fracture',
        shortDesc: 'Thermal damage coefficient D5 (Recommended: 0.5 to 4.0)',
        detailedDesc: 'Thermal softening damage coefficient D5 in the Johnson-Cook fracture model. Typical values: 0.61 for 4340 steel, 1.12 for OFHC copper, 1.60 for 6061-T6 aluminum, 3.87 for Ti-6Al-4V.'
    },
    'weibull_modulus': {
        key: 'weibull_modulus',
        label: 'Weibull Modulus (m_w)',
        unit: 'dim',
        category: 'Material Heterogeneity & Fragmentation',
        shortDesc: 'Flaw shape m_w (Recommended: 3.0-15.0, Default: 0.0 disabled)',
        detailedDesc: 'Dimensionless Weibull shape parameter m_w governing initial material flaw variability. Lower values increase microstructural defect scatter for realistic ductile-to-brittle fragmentation. Recommended values: 3.0 to 6.0 for concrete/rock/ceramics, 8.0 to 12.0 for structural steel & aluminum alloys, 15.0+ for ultra-homogeneous metals. Set to 0.0 to disable initial flaw scatter.'
    },
    'weibull_scale': {
        key: 'weibull_scale',
        label: 'Weibull Scale (eta_w)',
        unit: 'dim',
        category: 'Material Heterogeneity & Fragmentation',
        shortDesc: 'Flaw scale eta_w (Recommended: 0.8-1.2, Default: 1.0)',
        detailedDesc: 'Dimensionless Weibull scale parameter eta_w adjusting the mean initial flaw strength distribution across MPM particles. Recommended value: 1.0 (baseline characteristic material strength).'
    },
    'fracture_toughness': {
        key: 'fracture_toughness',
        label: 'Dynamic Fracture Toughness (K_IC)',
        unit: 'Pa·m^0.5',
        category: 'Material Heterogeneity & Fragmentation',
        shortDesc: 'Mode-I toughness K_IC (Recommended: 3e6-140e6 Pa·√m)',
        detailedDesc: 'Dynamic Mode-I fracture toughness K_IC (Pa·m^0.5). Used in Grady dynamic spallation model: sig_spall = (3*rho*c0*K_IC^2 * eps_dot)^(1/3). Recommended values: 3.0e6 Pa·m^0.5 for concrete/rock, 25.0e6 to 35.0e6 Pa·m^0.5 for aluminum alloys, 50.0e6 to 140.0e6 Pa·m^0.5 for armor steels. Set to 0.0 to disable Grady spallation.'
    },
    'debris_bulk_factor': {
        key: 'debris_bulk_factor',
        label: 'Post-Failure Bulk Modulus Factor',
        unit: 'dim',
        category: 'Material Heterogeneity & Fragmentation',
        shortDesc: 'Parent material post-failure bulk stiffness ratio (Default: 0.10)',
        detailedDesc: 'Dimensionless fraction (0.0 to 1.0) of intact bulk modulus retained by completely failed/fragmented parent material when subjected to hydrostatic re-compression (J < 1.0). In the unified parent material framework, particles preserve their parent EOS, density, and shock impedance while using this factor for crushed aggregate re-compaction.'
    },
    'dem_transition_enabled': {
        key: 'dem_transition_enabled',
        label: 'MPM-to-DEM Dynamic Transition',
        category: 'Discrete Fracture & DEM Dynamics',
        shortDesc: 'Transition failed material points into discrete DEM contact grains',
        detailedDesc: 'When enabled, material points reaching full damage (D >= 1.0) dynamically decouple from the background Eulerian grid and transition into discrete Lagrangian DEM grains. This eliminates grid velocity smoothing across crack interfaces and enables discrete, non-smeared fragment flight with pairwise contact and friction.'
    },
    'fragment_distribution': {
        key: 'fragment_distribution',
        label: 'Fragment Size Distribution Model',
        category: 'Discrete Fracture & DEM Dynamics',
        shortDesc: 'Statistical fragment size model (Rosin-Rammler, Mott-Grady, Lognormal, Monodisperse)',
        detailedDesc: 'Selects the statistical probability distribution function used to assign physical fragment grain diameters upon fracture. Rosin-Rammler and Mott-Grady capture multi-scale fragments ranging from fine dust/spall to large macro-fragments.'
    },
    'fragment_min_size': {
        key: 'fragment_min_size',
        label: 'Minimum Fragment Diameter (d_min)',
        unit: 'm',
        category: 'Discrete Fracture & DEM Dynamics',
        shortDesc: 'Smallest fragment grain size (Default: 0.002 m)',
        detailedDesc: 'Lower bound for the fragment size distribution (m). Represents fine spallation grains and dust with high aerodynamic drag.'
    },
    'fragment_max_size': {
        key: 'fragment_max_size',
        label: 'Maximum Fragment Diameter (d_max)',
        unit: 'm',
        category: 'Discrete Fracture & DEM Dynamics',
        shortDesc: 'Largest fragment grain size (Default: 0.040 m)',
        detailedDesc: 'Upper characteristic scale for macro-fragments (m). Governs the size of large structural chunks and casing fragments.'
    },
    'fragment_weibull_n': {
        key: 'fragment_weibull_n',
        label: 'Fragment Dispersion Exponent (n)',
        unit: 'dim',
        category: 'Discrete Fracture & DEM Dynamics',
        shortDesc: 'Rosin-Rammler / Weibull slope exponent n (Recommended: 1.2 to 2.5)',
        detailedDesc: 'Shape parameter n of the Rosin-Rammler cumulative mass distribution F(d) = 1 - exp(-(d/d_0)^n). Lower n produces wide multi-modal fragment dispersion with both very fine dust and large chunks; higher n produces more uniform fragment sizing.'
    },
    'fragment_clumping_radius': {
        key: 'fragment_clumping_radius',
        label: 'Fragment Clumping Radius',
        unit: 'm',
        category: 'Discrete Fracture & DEM Dynamics',
        shortDesc: 'Spatial neighborhood search radius for multi-particle fragment clusters (Default: 0.015 m)',
        detailedDesc: 'Spatial search radius (m) used to group contiguous failed DEM particles into unified rigid/deformable fragment clusters with shared cluster identifiers.'
    },
    'fragment_ejection_jitter': {
        key: 'fragment_ejection_jitter',
        label: 'Strain-Energy Kinetic Ejection Jitter',
        unit: 'dim',
        category: 'Discrete Fracture & DEM Dynamics',
        shortDesc: 'Elastic energy to kinetic breakup velocity fraction (Default: 0.35)',
        detailedDesc: 'Fraction (0.0 to 1.0) of stored elastic strain energy U_e = 0.5 * (sigma : eps_e) instantaneously converted into radial kinetic separation jitter v_kick = jitter * sqrt(2 * U_e / rho) at the moment of fracture.'
    },
    'fragment_contact_friction': {
        key: 'fragment_contact_friction',
        label: 'Fragment Inter-Grain Friction (mu_dem)',
        unit: 'dim',
        category: 'Discrete Fracture & DEM Dynamics',
        shortDesc: 'Coulomb friction coefficient between colliding fragments (Default: 0.55)',
        detailedDesc: 'Coulomb sliding friction coefficient between colliding DEM debris grains and against solid boundaries.'
    },
    'fragment_restitution': {
        key: 'fragment_restitution',
        label: 'Fragment Coefficient of Restitution (e_dem)',
        unit: 'dim',
        category: 'Discrete Fracture & DEM Dynamics',
        shortDesc: 'Normal restitution coefficient for DEM collisions (Default: 0.30)',
        detailedDesc: 'Normal coefficient of restitution (0.0 = fully plastic energy dissipation, 1.0 = perfectly elastic rebound) for DEM grain-to-grain and grain-to-wall collisions.'
    },
    'T_melt': {
        key: 'T_melt',
        label: 'Melting Temperature (T_melt)',
        unit: 'K',
        category: 'Johnson-Cook Viscoplasticity',
        shortDesc: 'Solidus melting temperature',
        detailedDesc: 'Absolute melting temperature (K) where material shear strength drops to zero.'
    },
    'T_room': {
        key: 'T_room',
        label: 'Reference Room Temperature (T_room)',
        unit: 'K',
        category: 'Johnson-Cook Viscoplasticity',
        shortDesc: 'Ambient reference temperature',
        detailedDesc: 'Reference temperature (K) for thermal softening calculations (typically 293.15 K).'
    },
    'Cp': {
        key: 'Cp',
        label: 'Specific Heat Capacity (C_p)',
        unit: 'J/(kg·K)',
        category: 'Johnson-Cook Viscoplasticity',
        shortDesc: 'Specific heat capacity at constant pressure',
        detailedDesc: 'Specific heat capacity Cp [J/(kg·K)] converting plastic work into adiabatic heat: dT = beta·sigma:deps_p / (rho·Cp).'
    },
    'mg_gamma0': {
        key: 'mg_gamma0',
        label: 'Mie-Grüneisen Parameter (Γ₀)',
        unit: 'dim',
        category: 'Mie-Grüneisen Shock EOS',
        shortDesc: 'Dimensionless Grüneisen shock parameter',
        detailedDesc: 'Grüneisen parameter Gamma_0 coupling thermal energy to pressure in shock-compressed solids: p - p_H = Gamma_0·rho·(e - e_H).'
    },
    'mg_c0': {
        key: 'mg_c0',
        label: 'Bulk Sound Speed (c₀)',
        unit: 'm/s',
        category: 'Mie-Grüneisen Shock EOS',
        shortDesc: 'Linear shock Hugoniot intercept sound speed',
        detailedDesc: 'Bulk acoustic sound speed c0 (m/s) in the uncompressed solid: U_s = c_0 + s·u_p.'
    },
    'mg_s': {
        key: 'mg_s',
        label: 'Hugoniot Slope (S)',
        unit: 'dim',
        category: 'Mie-Grüneisen Shock EOS',
        shortDesc: 'Slope of Us-Up shock velocity relationship',
        detailedDesc: 'Dimensionless slope s of the linear shock Hugoniot: U_s = c_0 + s·u_p. Reflects shock compressibility under intense blast loading.'
    },

    // --- Davis Solid Reactant EOS ---
    'davis_c0': {
        key: 'davis_c0',
        label: 'Davis Reactant Sound Speed (c₀)',
        unit: 'm/s',
        category: 'Davis Solid Reactant EOS',
        shortDesc: 'Unshocked acoustic bulk sound speed of solid explosive reactant',
        detailedDesc: 'Bulk sound speed c0 (m/s) in the solid unreacted explosive Hugoniot: U_s = c₀ + s₁(1 - V)u_p.'
    },
    'davis_s1': {
        key: 'davis_s1',
        label: 'Davis Reactant Hugoniot Slope (s₁)',
        unit: 'dim',
        category: 'Davis Solid Reactant EOS',
        shortDesc: 'First-order Hugoniot slope coefficient for unreacted solid',
        detailedDesc: 'Dimensionless slope coefficient s₁ governing nonlinear shock compression in the Davis solid reactant equation of state.'
    },
    'davis_gamma0': {
        key: 'davis_gamma0',
        label: 'Davis Reactant Grüneisen (Γ₀)',
        unit: 'dim',
        category: 'Davis Solid Reactant EOS',
        shortDesc: 'Grüneisen coefficient of unreacted solid explosive',
        detailedDesc: 'Dimensionless Grüneisen parameter Γ₀ coupling thermal energy to pressure in shock-compressed unreacted explosive reactant.'
    },
    'davis_cv': {
        key: 'davis_cv',
        label: 'Davis Reactant Specific Heat (C_v)',
        unit: 'J/(kg·K)',
        category: 'Davis Solid Reactant EOS',
        shortDesc: 'Isochoric specific heat capacity of unreacted solid',
        detailedDesc: 'Specific heat capacity at constant volume Cv [J/(kg·K)] for unreacted solid explosive.'
    },
    'davis_t0': {
        key: 'davis_t0',
        label: 'Davis Reactant Reference Temp (T₀)',
        unit: 'K',
        category: 'Davis Solid Reactant EOS',
        shortDesc: 'Reference initial temperature for unreacted explosive',
        detailedDesc: 'Ambient initial temperature T₀ (K) for unreacted explosive thermodynamics (typically 293.15 K).'
    },
    'davis_rho0': {
        key: 'davis_rho0',
        label: 'Davis Reactant Density (ρ₀)',
        unit: 'kg/m³',
        category: 'Davis Solid Reactant EOS',
        shortDesc: 'Uncompressed density of solid explosive reactant',
        detailedDesc: 'Initial unshocked solid mass density ρ₀ (kg/m³) for unreacted explosive.'
    },

    // --- Davis Product EOS ---
    'davis_a': {
        key: 'davis_a',
        label: 'Davis Product Parameter (a)',
        unit: 'dim',
        category: 'Davis Product Gas EOS',
        shortDesc: 'High-density asymptotic Grüneisen exponent',
        detailedDesc: 'Dimensionless product gas parameter a defining variable Grüneisen coefficient: Γ(v) = k - 1 + (1 - b) / (1 + a·(v/v_c)^(1/2)).'
    },
    'davis_b': {
        key: 'davis_b',
        label: 'Davis Product Parameter (b)',
        unit: 'dim',
        category: 'Davis Product Gas EOS',
        shortDesc: 'Low-density asymptotic Grüneisen parameter',
        detailedDesc: 'Dimensionless product gas parameter b governing Grüneisen transition across high-to-low expansion regimes.'
    },
    'davis_k': {
        key: 'davis_k',
        label: 'Davis Product Ratio of Specific Heats (k)',
        unit: 'dim',
        category: 'Davis Product Gas EOS',
        shortDesc: 'Asymptotic product gas gamma parameter (k = Cp / Cv)',
        detailedDesc: 'Dimensionless adiabatic index k governing expansion thermodynamics of fully reacted detonation product gases.'
    },
    'davis_vc': {
        key: 'davis_vc',
        label: 'Davis Product Characteristic Vol (v_c)',
        unit: 'dim',
        category: 'Davis Product Gas EOS',
        shortDesc: 'Characteristic relative volume scaling factor',
        detailedDesc: 'Dimensionless characteristic relative volume v_c = V / V_0 normalizing expansion along the principal isentrope.'
    },
    'davis_pc': {
        key: 'davis_pc',
        label: 'Davis Product Characteristic Pressure (p_c)',
        unit: 'Pa',
        category: 'Davis Product Gas EOS',
        shortDesc: 'Characteristic pressure scaling parameter',
        detailedDesc: 'Characteristic scaling pressure p_c (Pa) for the Davis detonation product gas isentrope.'
    },
    'davis_q_det': {
        key: 'davis_q_det',
        label: 'Davis Heat of Detonation (Q_det)',
        unit: 'J/kg',
        category: 'Davis Product Gas EOS',
        shortDesc: 'Chemical energy release per unit mass',
        detailedDesc: 'Total chemical detonation energy release Q_det (J/kg) available to drive high-pressure gas expansion upon full conversion (λ = 1.0).'
    },

    // --- CREST Kinetics ---
    'crest_b1': {
        key: 'crest_b1',
        label: 'CREST Ignition Rate (b₁)',
        unit: '1/s',
        category: 'CREST Reactive Burn Kinetics',
        shortDesc: 'Hot-spot ignition rate multiplier',
        detailedDesc: 'Ignition rate constant b₁ (1/s) in CREST model: dλ_ign/dt = b₁·(1 - λ)·(1 - v)^c1·exp(-s₀ / max(0, s - s_th))^m1.'
    },
    'crest_c1': {
        key: 'crest_c1',
        label: 'CREST Ignition Compression Exponent (c₁)',
        unit: 'dim',
        category: 'CREST Reactive Burn Kinetics',
        shortDesc: 'Volumetric compression sensitivity exponent for hot-spot ignition',
        detailedDesc: 'Dimensionless exponent c₁ scaling volumetric strain (1 - v) in the CREST ignition rate.'
    },
    'crest_m1': {
        key: 'crest_m1',
        label: 'CREST Ignition Entropy Exponent (m₁)',
        unit: 'dim',
        category: 'CREST Reactive Burn Kinetics',
        shortDesc: 'Entropy sensitivity exponent for hot-spot ignition',
        detailedDesc: 'Dimensionless exponent m₁ scaling the shock entropy activation barrier in hot-spot ignition.'
    },
    'crest_b2': {
        key: 'crest_b2',
        label: 'CREST Reaction Growth Rate (b₂)',
        unit: '1/s',
        category: 'CREST Reactive Burn Kinetics',
        shortDesc: 'Reaction growth rate multiplier',
        detailedDesc: 'Reaction growth rate constant b₂ (1/s) governing deflagration/growth transition: dλ_grow/dt = b₂·(1 - λ)·λ^c2·(1 - v)^c3·(s / s₀)^m2.'
    },
    'crest_c2': {
        key: 'crest_c2',
        label: 'CREST Progress Exponent (c₂)',
        unit: 'dim',
        category: 'CREST Reactive Burn Kinetics',
        shortDesc: 'Reaction progress surface area exponent',
        detailedDesc: 'Dimensionless exponent c₂ scaling reaction progress λ in the grain burning/growth rate.'
    },
    'crest_c3': {
        key: 'crest_c3',
        label: 'CREST Growth Compression Exponent (c₃)',
        unit: 'dim',
        category: 'CREST Reactive Burn Kinetics',
        shortDesc: 'Volumetric compression sensitivity exponent for reaction growth',
        detailedDesc: 'Dimensionless exponent c₃ scaling volumetric compression (1 - v) in reaction growth kinetics.'
    },
    'crest_m2': {
        key: 'crest_m2',
        label: 'CREST Growth Entropy Exponent (m₂)',
        unit: 'dim',
        category: 'CREST Reactive Burn Kinetics',
        shortDesc: 'Shock entropy sensitivity exponent for reaction growth',
        detailedDesc: 'Dimensionless exponent m₂ scaling shock entropy in the reaction growth regime.'
    },
    'crest_s0': {
        key: 'crest_s0',
        label: 'CREST Reference Entropy (s₀)',
        unit: 'J/(kg·K)',
        category: 'CREST Reactive Burn Kinetics',
        shortDesc: 'Reference specific shock entropy scale',
        detailedDesc: 'Characteristic shock entropy scale s₀ [J/(kg·K)] normalizing entropy accumulation in CREST kinetics.'
    },
    'crest_s_threshold': {
        key: 'crest_s_threshold',
        label: 'CREST Entropy Threshold (s_th)',
        unit: 'J/(kg·K)',
        category: 'CREST Reactive Burn Kinetics',
        shortDesc: 'Critical shock entropy threshold for ignition onset',
        detailedDesc: 'Specific shock entropy threshold s_th [J/(kg·K)] below which hot-spot ignition rate is strictly zero, preventing premature deflagration from acoustic waves.'
    },
    'initiation_radius': {
        key: 'initiation_radius',
        label: 'Detonator Hot-Spot Booster Radius',
        unit: 'm',
        category: 'Detonator & Initiation',
        shortDesc: 'Seed radius for detonator booster hot-spot initiation',
        detailedDesc: 'Radius (m) around detonator seed point where explosive material receives initial entropy/overpressure booster seed to trigger autonomous shock-to-detonation transition (SDT).'
    },
    'booster_overpressure': {
        key: 'booster_overpressure',
        label: 'Detonator Booster Overpressure',
        unit: 'Pa',
        category: 'Detonator & Initiation',
        shortDesc: 'Initial overpressure for detonator booster seed zone',
        detailedDesc: 'Initial shock overpressure (Pa) applied inside initiation radius to seed hot-spots for CREST reactive burn.'
    },

    // --- Concrete Models (RHT, K&C, CSCM) ---
    'fc': {
        key: 'fc',
        label: 'Uniaxial Compressive Strength (f_c\')',
        unit: 'Pa',
        category: 'Concrete Mechanics',
        shortDesc: 'Quasi-static unconfined compressive strength',
        detailedDesc: 'Standard 28-day cylinder compressive strength f_c\' (Pa / MPa). Core calibration parameter for concrete yield and failure surfaces.'
    },
    'ft': {
        key: 'ft',
        label: 'Uniaxial Tensile Strength (f_t)',
        unit: 'Pa',
        category: 'Concrete Mechanics',
        shortDesc: 'Direct tensile fracture strength',
        detailedDesc: 'Direct tensile strength f_t (Pa / MPa), typically 8%–12% of compressive strength f_c\'.'
    },
    'G_f': {
        key: 'G_f',
        label: 'Specific Fracture Energy (G_f)',
        unit: 'N/m',
        category: 'Concrete Mechanics',
        shortDesc: 'Tensile fracture energy release rate',
        detailedDesc: 'Energy dissipated per unit crack area G_f (N/m or J/m²). Regularizes tensile spall softening (ep_f_tensile = 2*G_f / (f_t * h)) via the Bažant crack band model, while preserving hydrodynamic pressure-dependent failure strain under compressive blast loading.'
    },
    'moisture_content': {
        key: 'moisture_content',
        label: 'Concrete Moisture Content',
        unit: '%',
        category: 'Concrete Mechanics',
        shortDesc: 'Pore water saturation percentage',
        detailedDesc: 'Volumetric free moisture content (%). Pore water increases bulk shock stiffness and enhances dynamic rate effects under high shock pressures.'
    },
    'dif_cap_compression': {
        key: 'dif_cap_compression',
        label: 'Compressive DIF Cap',
        unit: 'dim',
        category: 'Concrete Mechanics',
        shortDesc: 'Dynamic Increase Factor limit in compression',
        detailedDesc: 'Maximum multiplier allowed on compressive strength under ultra-high strain rates (typically 2.0 to 4.0).'
    },
    'dif_cap_tension': {
        key: 'dif_cap_tension',
        label: 'Tensile DIF Cap',
        unit: 'dim',
        category: 'Concrete Mechanics',
        shortDesc: 'Dynamic Increase Factor limit in tension',
        detailedDesc: 'Maximum multiplier allowed on tensile strength under blast shock wave strain rates (typically 5.0 to 12.0).'
    },
    'directional_crack_band': {
        key: 'directional_crack_band',
        label: 'Directional Crack Band Normalization',
        category: 'Fracture Mechanics',
        shortDesc: 'Bažant projection angle normalization',
        detailedDesc: 'Normalizes crack band element characteristic length by the projection of crack normal vectors, eliminating the 41% artificial energy penalty on 45° diagonal mesh cracks.'
    },
    'nonlocal_radius': {
        key: 'nonlocal_radius',
        label: 'Non-Local Damage Radius (R_c)',
        unit: 'm',
        category: 'Fracture Mechanics',
        shortDesc: 'Spatial damage smoothing radius',
        detailedDesc: 'Averages damage across elements within physical radius R_c (e.g. 50mm for concrete). Prevents 1-element grid-aligned razor cuts and enables natural branching cracks.'
    },

    // --- FEM Structural Mechanics ---
    'integration_scheme': {
        key: 'integration_scheme',
        label: 'FEM Element Integration Scheme',
        category: 'FEM Structural Dynamics',
        shortDesc: 'Gauss quadrature formulation for hexahedra',
        detailedDesc: 'OnePointFB (1-point reduced integration with Flanagan-Belytschko hourglass stabilization - fastest and standard for explicit blast dynamics), OnePointKF (Kosloff-Frazier), FullGauss8 (8-point exact integration - avoids hourglassing but prone to shear locking), or SelectiveReduced (B-bar formulation).'
    },
    'hourglass_model': {
        key: 'hourglass_model',
        label: 'Hourglass Stabilization Model',
        category: 'FEM Structural Dynamics',
        shortDesc: 'Anti-hourglass zero-energy mode control',
        detailedDesc: 'FlanaganBelytschkoStiffness (orthogonal physical stiffness hourglass control), FlanaganBelytschkoViscous (velocity-based damping), or KosloffFrazier.'
    },
    'hourglass_coeff': {
        key: 'hourglass_coeff',
        label: 'Hourglass Coefficient (q_HG)',
        unit: 'dim',
        category: 'FEM Structural Dynamics',
        shortDesc: 'Hourglass stabilization gain factor',
        detailedDesc: 'Dimensionless hourglass gain (typically 0.05 to 0.15). Suppresses spurious mesh hourglassing without artificially stiffening physical bending modes.'
    },
    'contact_penalty_scale': {
        key: 'contact_penalty_scale',
        label: 'Contact Penalty Scale Multiplier',
        unit: 'dim',
        category: 'FEM Structural Dynamics',
        shortDesc: 'Normalized Courant contact penalty fraction (0.01 to 1.0)',
        detailedDesc: 'Fraction of the maximum Courant-stable penalty stiffness (0.1 = 10% for soft contact, 1.0 = 100% of maximum stable stiffness). Mathematically bounded against explicit timestep divergence.'
    },
    'friction_static': {
        key: 'friction_static',
        label: 'Static Friction Coefficient (μ_s)',
        unit: 'dim',
        category: 'FEM Structural Dynamics',
        shortDesc: 'Coulomb static friction coefficient',
        detailedDesc: 'Dimensionless static friction coefficient mu_s for sliding contact surfaces.'
    },
    'friction_kinetic': {
        key: 'friction_kinetic',
        label: 'Kinetic Friction Coefficient (μ_k)',
        unit: 'dim',
        category: 'FEM Structural Dynamics',
        shortDesc: 'Coulomb dynamic friction coefficient',
        detailedDesc: 'Dimensionless kinetic sliding friction coefficient mu_k.'
    },
    'convert_failed_elements_to_mpm': {
        key: 'convert_failed_elements_to_mpm',
        label: 'FEM-to-MPM Erosion Conversion',
        category: 'Hybrid Multi-Physics',
        shortDesc: 'Convert eroded FEM elements into active parent-material MPM particles',
        detailedDesc: 'Seamlessly converts failed/eroded hexahedral solid elements into active Lagrangian MPM particles of the exact same parent material, preserving parent density, EOS, plastic work, temperature, and kinematic momentum.'
    },
    'mpm_particles_per_failed_element': {
        key: 'mpm_particles_per_failed_element',
        label: 'MPM Particles Per Eroded Element',
        unit: 'particles',
        category: 'Hybrid Multi-Physics',
        shortDesc: 'Parent-material particle spawning resolution',
        detailedDesc: 'Number of discrete MPM particles spawned to represent the fractured volume of one eroded hex element of the parent material (typically 8 particles).'
    },
    'material_heterogeneity': {
        key: 'material_heterogeneity',
        label: 'Weibull Material Heterogeneity (m_v)',
        unit: 'dim',
        category: 'Fracture Mechanics',
        shortDesc: 'Statistical flaw variance across elements',
        detailedDesc: 'Weibull statistical distribution variance (0.0 = perfectly homogeneous, 0.08 = typical reinforced concrete, 0.20 = high variance masonry). Seeds realistic asymmetric fracture patterns.'
    },
    'debris_velocity_smoothing': {
        key: 'debris_velocity_smoothing',
        label: 'Debris Velocity Smoothing',
        unit: 'dim',
        category: 'Hybrid Multi-Physics',
        shortDesc: 'Momentum smoothing factor for eroded debris',
        detailedDesc: 'Diffuses violent shock ejection velocities across freshly spawned MPM debris particles to maintain numeric stability.'
    },
    'debris_clumping': {
        key: 'debris_clumping',
        label: 'Debris Aggregate Clumping',
        unit: 'dim',
        category: 'Hybrid Multi-Physics',
        shortDesc: 'Multi-element cohesion factor (0=sand, 0.4=concrete, 0.8=steel)',
        detailedDesc: 'Fuses adjacent eroding elements into cohesive macro boulders/chunks rather than dispersing as individual fine sand grains.'
    },
    'debris_max_clump_size': {
        key: 'debris_max_clump_size',
        label: 'Maximum Clump Size',
        unit: 'elements',
        category: 'Hybrid Multi-Physics',
        shortDesc: 'Maximum elements fused per cohesive boulder',
        detailedDesc: 'Upper bound on the number of adjacent failed elements merged into a single cohesive macro fragment.'
    },
    'random_seed': {
        key: 'random_seed',
        label: 'Deterministic Random Seed',
        unit: 'dim',
        category: 'Fracture Mechanics',
        shortDesc: 'Seed for reproducible fracture distributions',
        detailedDesc: 'Integer seed ensuring 100% bitwise-identical stochastic flaw distributions and crack paths across repeated runs.'
    },
    'mesh_source': {
        key: 'mesh_source',
        label: 'Mesh Generation Source',
        category: 'Structural Mechanics',
        shortDesc: 'Geometry topology generator',
        detailedDesc: 'Box Generator (analytic hexahedral brick), Cylinder Generator (polar hex mesh), or LS-DYNA Keyword File (imported *.k mesh).'
    },
    'boundary_condition': {
        key: 'boundary_condition',
        label: 'Structural Support Constraint',
        category: 'Structural Mechanics',
        shortDesc: 'Kinematic boundary constraints',
        detailedDesc: 'Free (unconstrained free-flight), Fixed Base (clamped bottom face nodes u = 0), or Fixed Entire (fully encastre).'
    },
    'bulk_viscosity_b1': {
        key: 'bulk_viscosity_b1',
        label: 'Linear Bulk Viscosity (b₁)',
        unit: 'dim',
        category: 'FEM Structural Dynamics',
        shortDesc: 'Linear acoustic damping coefficient',
        detailedDesc: 'Standard linear bulk viscosity b1 (typically 0.06) damping high-frequency element acoustic ringing.'
    },
    'bulk_viscosity_b2': {
        key: 'bulk_viscosity_b2',
        label: 'Quadratic Bulk Viscosity (b₂)',
        unit: 'dim',
        category: 'FEM Structural Dynamics',
        shortDesc: 'Von Neumann quadratic shock viscosity',
        detailedDesc: 'Quadratic shock viscosity b2 (typically 1.20) spreading steep shock fronts over 2–3 element widths to prevent unphysical oscillations.'
    },
    'scale_factor': {
        key: 'scale_factor',
        label: 'Imported Mesh Scale Multiplier',
        unit: 'dim',
        category: 'Structural Mechanics',
        shortDesc: 'Coordinate scaling factor on import',
        detailedDesc: 'Multiplicative scale factor applied to nodal coordinates (e.g. 0.001 to convert mm to meters).'
    },

    // --- Fluid-Structure Interaction (FSI) ---
    'coupling_scheme': {
        key: 'coupling_scheme',
        label: 'FSI Coupling Algorithm',
        category: 'Fluid-Structure Interaction',
        shortDesc: 'Fluid-structure temporal synchronization',
        detailedDesc: 'Two-Way Staggered (high-fidelity 2nd-order alternating substep momentum/pressure coupling) or Sub-Cycling (multiple structural substeps per fluid step).'
    },
    'pressure_integration': {
        key: 'pressure_integration',
        label: 'Interface Pressure Integration',
        category: 'Fluid-Structure Interaction',
        shortDesc: 'Surface quadrature scheme for blast load',
        detailedDesc: '2x2 Gauss Quadrature (high-order pressure integration across element facets) or 1-Point Centroid (fast midpoint pressure).'
    },
    'uncovering_method': {
        key: 'uncovering_method',
        label: 'Fluid Cell Uncovering Formulation',
        category: 'Fluid-Structure Interaction',
        shortDesc: 'Treatment of freshly exposed vacuum cells behind moving solids',
        detailedDesc: 'Conservative IDW + Vacuum Cavity (conservatively redistributes mass/energy with cavitation pressure floor) or Ghost-Fluid Standard.'
    },
    'erosion_venting': {
        key: 'erosion_venting',
        label: 'Structural Erosion Blast Venting',
        category: 'Fluid-Structure Interaction',
        shortDesc: 'Allow blast gas venting through structural holes',
        detailedDesc: 'When structural elements erode or rupture, blast gases dynamically penetrate through the perforated opening.'
    },
    'vacuum_density': {
        key: 'vacuum_density',
        label: 'Vacuum Cavitation Floor Density',
        unit: 'kg/m³',
        category: 'Fluid-Structure Interaction',
        shortDesc: 'Minimum density floor for newly uncovered cells',
        detailedDesc: 'Baseline numerical density floor (e.g. 1.0e-6 kg/m³) applied to freshly uncovered cells before fluid inflow.'
    },
    'vacuum_pressure': {
        key: 'vacuum_pressure',
        label: 'Vacuum Cavitation Floor Pressure',
        unit: 'Pa',
        category: 'Fluid-Structure Interaction',
        shortDesc: 'Minimum pressure floor for cavitation zones',
        detailedDesc: 'Baseline numerical pressure floor (e.g. 1.0e-2 Pa) preventing negative pressures in expanding shock shadow cavities.'
    },

    // --- Virtual Gauges & Output Controls ---
    'telemetry_channel': {
        key: 'telemetry_channel',
        label: 'Telemetry Broadcast Channel',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Numeric telemetry channel index',
        detailedDesc: 'Websocket data channel index (0–3) for multiplexing live chart and contour streams.'
    },
    'plot_stride': {
        key: 'plot_stride',
        label: 'Graph Decimation Stride',
        unit: 'cells',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Spatial cell sampling interval for plots',
        detailedDesc: 'Downsampling stride for live 1D chart telemetry (1 = plot every cell, 10 = plot every 10th cell).'
    },
    'x_axis_mode': {
        key: 'x_axis_mode',
        label: 'Graph X-Axis Mode',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'X-axis coordinate display format',
        detailedDesc: 'radius (physical distance in meters) or cell_id (discrete grid index).'
    },
    'min_y': {
        key: 'min_y',
        label: 'Graph / Color Minimum Clamp',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Lower vertical axis / colormap bound',
        detailedDesc: 'Manual lower bound for telemetry graph axes or colormaps when Auto Scale is disabled.'
    },
    'max_y': {
        key: 'max_y',
        label: 'Graph / Color Maximum Clamp',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Upper vertical axis / colormap bound',
        detailedDesc: 'Manual upper bound for telemetry graph axes or colormaps when Auto Scale is disabled.'
    },
    'auto_scale': {
        key: 'auto_scale',
        label: 'Dynamic Auto-Scale',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Automatically adjust range to live min/max',
        detailedDesc: 'Dynamically fits the graph or contour range to the current minimum and maximum values in the domain.'
    },
    'log_scale': {
        key: 'log_scale',
        label: 'Logarithmic Scaling',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Display values on log10 scale',
        detailedDesc: 'Applies log10 transformation to color mapping and axes, ideal for spanning 5+ orders of blast overpressure.'
    },
    'lock_quantity_ranges': {
        key: 'lock_quantity_ranges',
        label: 'Lock Unified Field Ranges',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Locks colormap range across all slices and 3D meshes displaying the same field',
        detailedDesc: 'When enabled (default: true), all visualization elements (orthogonal slicing planes, CAD STL meshes, and obstacle surfaces) displaying the same physical field (e.g. Peak Overpressure) share a unified, synchronized colormap range, colormap, and lin/log transfer function.'
    },
    'quantity_log_scales': {
        key: 'quantity_log_scales',
        label: 'Per-Field Logarithmic Transfer Maps',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Stores log10 color transfer flags per physical field quantity',
        detailedDesc: 'Map of physical field quantities to boolean log10 scaling states to guarantee synchronized logarithmic color rendering across all active visual representations.'
    },
    'quantity_auto_scales': {
        key: 'quantity_auto_scales',
        label: 'Per-Field Auto/Manual Scale Maps',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Stores auto vs manual dynamic scaling flags per physical field quantity',
        detailedDesc: 'Map of physical field quantities to boolean auto-scaling states to guarantee synchronized automatic or manual scaling across all active visual representations.'
    },
    'quantity_colormaps': {
        key: 'quantity_colormaps',
        label: 'Per-Field Colormap Palette Maps',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Stores active false-color palette per physical field quantity',
        detailedDesc: 'Map of physical field quantities to active colormap palettes to guarantee synchronized false-color mapping across all active visual representations.'
    },
    'colormap': {
        key: 'colormap',
        label: 'Color Palette',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Visual false-color palette',
        detailedDesc: 'rainbow (classic high-contrast spectrum), plasma (perceptually uniform purple-to-yellow), viridis (blue-to-yellow), coolwarm, cividis, inferno, magma, or grayscale.'
    },
    'refresh_rate': {
        key: 'refresh_rate',
        label: 'Viewport Refresh Rate / FPS',
        unit: 's / FPS',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Live 3D viewport update frequency and streaming period',
        detailedDesc: 'Target frame streaming rate (from Max/Uncapped, 1000 FPS down to 0.001 FPS / 1000s period) for live 3D slices, particle data, and structural meshes over the network.'
    },
    'interpolate': {
        key: 'interpolate',
        label: 'Image Interpolation (Smooth)',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Bilinear texture filtering',
        detailedDesc: 'Enables bilinear GPU texture filtering for smooth contour maps instead of pixelated nearest-neighbor cells.'
    },
    'lightingEnabled': {
        key: 'lightingEnabled',
        label: 'Enable Surface Lighting',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Diffuse and specular surface shading in 3D viewport',
        detailedDesc: 'Enables real-time directional diffuse (Lambertian) and specular (Blinn-Phong) lighting across 3D CAD boundaries, fluid slices, FEM structures, and MPM particles.'
    },
    'ambientLevel': {
        key: 'ambientLevel',
        label: 'Ambient Light Level',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Base ambient illumination factor (0.0–1.0)',
        detailedDesc: 'Sets the baseline omnidirectional ambient light intensity. Modulated by Ambient Occlusion (AO) to create deep crevice shadows and contact darkening.'
    },
    'specularIntensity': {
        key: 'specularIntensity',
        label: 'Specular Highlight Intensity',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Specular reflection glossiness multiplier',
        detailedDesc: 'Controls the brightness and glossiness of Blinn-Phong specular highlights reflected off 3D obstacles and particle spheres.'
    },
    'aoEnabled': {
        key: 'aoEnabled',
        label: 'Screen-Space Ambient Occlusion (SSAO)',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Enable multi-pass SSAO depth crevice shadowing',
        detailedDesc: 'Enables multi-pass Screen-Space Ambient Occlusion (SSAO) to calculate realistic soft contact shadows, crevice darkening, and inter-object ambient occlusion across 3D geometry.'
    },
    'aoRadius': {
        key: 'aoRadius',
        label: 'SSAO Sampling Radius',
        unit: 'm',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'World/view-space hemisphere sampling radius for SSAO',
        detailedDesc: 'Controls the spatial reach of the hemispherical sampling kernel in view space. Larger radii capture broader ambient shadows across large structures; smaller radii focus on fine cracks and crevices.'
    },
    'aoIntensity': {
        key: 'aoIntensity',
        label: 'SSAO Shadow Intensity',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Occlusion darkness multiplier and contrast boost',
        detailedDesc: 'Multiplicative gain applied to the calculated occlusion factor. Higher values produce darker, more dramatic contact shadows in tight corners and cavities.'
    },
    'aoBias': {
        key: 'aoBias',
        label: 'SSAO Depth Bias Offset',
        unit: 'm',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Depth comparison bias to prevent self-shadowing acne',
        detailedDesc: 'Tolerance threshold applied during depth buffer comparison to eliminate false-positive self-occlusion artifacts along flat and planar surfaces.'
    },
    'aoSphereImpostor': {
        key: 'aoSphereImpostor',
        label: 'Sphere Impostor AO & Depth',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Raytraced 3D particle sphere shading and self-shadowing',
        detailedDesc: 'Renders MPM particle billboards with raytraced spherical normals, view-space depth displacement, and curvature-based self-ambient occlusion.'
    },
    'mpmParticleDiameter': {
        key: 'mpmParticleDiameter',
        label: 'MPM Particle Diameter',
        unit: 'm',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Physical world-space diameter for MPM particle sphere impostors',
        detailedDesc: 'Sets the physical diameter in meters for Material Point Method (MPM) particle sphere impostors and billboard quads. When non-zero, sphere impostors scale continuously and geometrically with perspective camera distance and zoom. In Auto mode, diameter is automatically derived from the mesh spacing and particle count (Δx / ∛ppc) so that orthogonally adjacent particles in Cartesian meshing touch without overlapping, and particles in close hex packing touch along neighbor contact planes.'
    },
    'mpmParticleSize': {
        key: 'mpmParticleSize',
        label: 'MPM Particle Point Size',
        unit: 'px',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Fixed screen-space point size in pixels for point cloud rendering',
        detailedDesc: 'Sets the fixed screen-space pixel width used when physical particle diameter is set to zero or unscaled screen-space point cloud rendering is selected.'
    },
    'step_interval': {
        key: 'step_interval',
        label: 'Snapshot Step Interval',
        unit: 'steps',
        category: 'VTK Output',
        shortDesc: 'Save disk snapshot every N cycles',
        detailedDesc: 'Writes full simulation VTK snapshots to disk every N solver time integration steps.'
    },
    'time_interval': {
        key: 'time_interval',
        label: 'Snapshot Time Interval',
        unit: 's',
        category: 'VTK Output',
        shortDesc: 'Save disk snapshot every Δt seconds',
        detailedDesc: 'Writes simulation VTK snapshots to disk whenever physical simulation time advances by this duration.'
    },
    'vtk_format': {
        key: 'vtk_format',
        label: 'VTK Encoding Format',
        category: 'VTK Output',
        shortDesc: 'Binary vs ASCII VTK XML',
        detailedDesc: 'Binary (compressed base64 raw binary - 5x smaller, high performance) or ASCII (plain text readable).'
    },
    'custom_filename': {
        key: 'custom_filename',
        label: 'Output File Prefix',
        category: 'VTK Output',
        shortDesc: 'Base filename for saved datasets',
        detailedDesc: 'Custom prefix string for output files (e.g. "blast_run_01" -> "blast_run_01_00010.vtu").'
    },
    'vtk_dir': {
        key: 'vtk_dir',
        label: 'VTK Output Directory',
        category: 'VTK Output',
        shortDesc: 'Destination folder on host disk',
        detailedDesc: 'Directory path where VTK XML files (.vtu / .pvd) and HDF5 datasets are written.'
    },
    'export_slices': {
        key: 'export_slices',
        label: 'Export 2D Slices',
        category: 'VTK Output',
        shortDesc: 'Save 2D planar cut slices to VTK',
        detailedDesc: 'Exports 2D planar cross-sections of the 3D fluid domain to reduce disk storage footprint.'
    },
    'export_volumes': {
        key: 'export_volumes',
        label: 'Export Full 3D Volumes',
        category: 'VTK Output',
        shortDesc: 'Save full 3D volumetric unstructured grid',
        detailedDesc: 'Exports all 3D fluid cells to VTK XML Unstructured Grid format.'
    },
    'export_fem': {
        key: 'export_fem',
        label: 'Export FEM Mesh',
        category: 'VTK Output',
        shortDesc: 'Save Lagrangian FEM elements to VTK',
        detailedDesc: 'Exports deformed hexahedral structural elements, stress tensors, and damage fields.'
    },
    'export_mpm': {
        key: 'export_mpm',
        label: 'Export MPM Particles',
        category: 'VTK Output',
        shortDesc: 'Save Lagrangian MPM points to VTK',
        detailedDesc: 'Exports discrete material point positions, velocities, stress tensors, and temperatures.'
    },
    'export_pvd': {
        key: 'export_pvd',
        label: 'Generate ParaView PVD Collection Index',
        category: 'VTK Output',
        shortDesc: 'Write time-series .pvd manifest',
        detailedDesc: 'Generates a .pvd collection index file for one-click animation playback in ParaView.'
    },
    'export_obstacles': {
        key: 'export_obstacles',
        label: 'Export Obstacle Surfaces (STL/CSG)',
        category: 'VTK Output',
        shortDesc: 'Write 3D obstacle boundary surfaces and pressures to VTU',
        detailedDesc: 'Exports the true polygonal boundary shell of solid obstacles (rasterized from STL CAD geometry or analytic CSG primitives) into an unstructured grid VTU dataset with interpolated boundary pressures, overpressures, and impulses.'
    },
    'export_stl_faces': {
        key: 'export_stl_faces',
        label: 'Export CAD STL Faces',
        category: 'VTK Output',
        shortDesc: 'Map and export CFD results directly onto CAD STL triangles',
        detailedDesc: 'Samples the 3D Eulerian fluid state (pressure, density, peak overpressure, and positive impulse) directly onto the triangular surface facets of the loaded CAD STL geometry, saving smooth building/vehicle geometry to VTU files with a PVD time collection index.'
    },
    'stl_outside_domain': {
        key: 'stl_outside_domain',
        label: 'Outside Domain Handling',
        category: 'VTK Output',
        shortDesc: 'Strategy for CAD STL facets located outside the CFD analysis domain',
        detailedDesc: 'Specifies how fluid state quantities are populated on CAD STL vertices that lie outside the Eulerian simulation domain. "NaN (No Value)" assigns IEEE 754 quiet NaN, rendering unsimulated geometry with ParaView\'s dedicated NaN Color and preserving true blast scale ranges. "Zero (0.0)" outputs zero for all fields. "Omit Outside Faces" excludes external triangles from the exported VTU mesh entirely.'
    },
    'tessellate_stl_faces': {
        key: 'tessellate_stl_faces',
        label: 'Tessellate Large Faces to CFD Grid',
        category: 'VTK Output',
        shortDesc: 'Subdivide large CAD triangles to CFD cell resolution',
        detailedDesc: 'When enabled, CAD triangles whose edges exceed the CFD cell size are adaptively subdivided into coplanar triangles via 1-to-4 midpoint bisection during initialization. This guarantees that blast wave pressure gradients across large walls are captured at full grid resolution without losing shock front details. When disabled, raw CAD facets are exported without subdivision.'
    },
    'tessellation_max_edge': {
        key: 'tessellation_max_edge',
        label: 'Tessellation Max Edge Size',
        unit: 'm',
        category: 'VTK Output',
        shortDesc: 'Maximum allowed triangle edge length for CAD STL export',
        detailedDesc: 'Specifies the maximum permissible triangle edge length (in meters) for CAD STL surface export. Any triangle with an edge exceeding this threshold is subdivided. When set to 0.0, the CFD grid cell size (cellSize) is automatically used as the threshold.'
    },
    'export_cfd_2d': {
        key: 'export_cfd_2d',
        label: 'Export 2D CFD Grid',
        category: 'VTK Output',
        shortDesc: 'Write 2D Eulerian fluid grid to VTU',
        detailedDesc: 'Exports the 2D Cartesian or AMR Eulerian fluid mesh cells and selected thermodynamic/kinematic flow variables into VTU datasets with a ParaView PVD collection index.'
    },
    'roi_enabled': {
        key: 'roi_enabled',
        label: 'Region of Interest (ROI) Cropping',
        category: 'VTK Output',
        shortDesc: 'Crop output volume to bounding box',
        detailedDesc: 'Restricts VTK disk output to cells within specified spatial bounding coordinates, conserving disk I/O.'
    },

    // --- VTK Physical Field Export Toggles ---
    'qty_pressure': {
        key: 'qty_pressure',
        label: 'Fluid Pressure (p)',
        unit: 'Pa',
        category: 'VTK Output Fields',
        shortDesc: 'Include Eulerian fluid pressure in VTK datasets',
        detailedDesc: 'Exports cell-centered fluid pressure p [Pa] into VTK unstructured grid datasets.'
    },
    'qty_density': {
        key: 'qty_density',
        label: 'Fluid Density (ρ)',
        unit: 'kg/m³',
        category: 'VTK Output Fields',
        shortDesc: 'Include Eulerian fluid density in VTK datasets',
        detailedDesc: 'Exports total fluid mixture density rho [kg/m^3] into VTK output files.'
    },
    'qty_velocity': {
        key: 'qty_velocity',
        label: 'Velocity Vector (u)',
        unit: 'm/s',
        category: 'VTK Output Fields',
        shortDesc: 'Include fluid velocity vector field in VTK datasets',
        detailedDesc: 'Exports 3D fluid velocity vector components (ux, uy, uz) [m/s] into VTK datasets.'
    },
    'qty_energy': {
        key: 'qty_energy',
        label: 'Specific Total Energy (E)',
        unit: 'J/kg',
        category: 'VTK Output Fields',
        shortDesc: 'Include specific total energy in VTK datasets',
        detailedDesc: 'Exports total specific internal and kinetic energy E [J/kg] into VTK output files.'
    },
    'qty_reacted': {
        key: 'qty_reacted',
        label: 'Reacted Gas Fraction (α₁)',
        unit: 'fraction',
        category: 'VTK Output Fields',
        shortDesc: 'Include JWL detonation reaction product volume fraction',
        detailedDesc: 'Exports volume fraction alpha_1 of reacted high-explosive gaseous products into VTK datasets.'
    },
    'qty_unreacted': {
        key: 'qty_unreacted',
        label: 'Unreacted Solid Fraction (α₂)',
        unit: 'fraction',
        category: 'VTK Output Fields',
        shortDesc: 'Include solid unreacted explosive volume fraction',
        detailedDesc: 'Exports volume fraction alpha_2 of solid unreacted explosive reactant into VTK datasets.'
    },
    'qty_air': {
        key: 'qty_air',
        label: 'Ambient Air Fraction (α₃)',
        unit: 'fraction',
        category: 'VTK Output Fields',
        shortDesc: 'Include ambient air volume fraction',
        detailedDesc: 'Exports volume fraction alpha_3 = 1 - alpha_1 - alpha_2 of ambient air into VTK datasets.'
    },
    'qty_overpressure': {
        key: 'qty_overpressure',
        label: 'Peak Overpressure (Δp_peak)',
        unit: 'Pa',
        category: 'VTK Output Fields',
        shortDesc: 'Include peak blast overpressure history envelope',
        detailedDesc: 'Exports cumulative peak blast overpressure envelope delta_p_peak [Pa] recorded across the simulation.'
    },
    'qty_impulse': {
        key: 'qty_impulse',
        label: 'Positive Specific Impulse (i_pos)',
        unit: 'Pa·s',
        category: 'VTK Output Fields',
        shortDesc: 'Include positive phase specific impulse integral',
        detailedDesc: 'Exports cumulative positive blast specific impulse integral i_pos = integral(max(0, p - p_0) dt) [Pa·s] into VTK datasets.'
    },
    'qty_fem_stress': {
        key: 'qty_fem_stress',
        label: 'FEM Cauchy Stress & von Mises',
        unit: 'Pa',
        category: 'VTK Output Fields',
        shortDesc: 'Include solid element stress tensor and von Mises equivalent stress',
        detailedDesc: 'Exports full Cauchy stress tensor components (sigma_xx, sigma_yy, sigma_zz, sigma_xy, sigma_yz, sigma_zx) and scalar von Mises stress.'
    },
    'qty_fem_strain': {
        key: 'qty_fem_strain',
        label: 'FEM Equivalent Plastic Strain (ε_p)',
        unit: 'dim',
        category: 'VTK Output Fields',
        shortDesc: 'Include solid element accumulated plastic strain',
        detailedDesc: 'Exports accumulated scalar equivalent plastic strain eps_p for elastoplastic solid elements.'
    },
    'qty_fem_pressure': {
        key: 'qty_fem_pressure',
        label: 'FEM Hydrostatic Pressure (p_solid)',
        unit: 'Pa',
        category: 'VTK Output Fields',
        shortDesc: 'Include solid hydrostatic pressure',
        detailedDesc: 'Exports mean normal hydrostatic pressure p = -trace(sigma)/3 in solid elements.'
    },
    'qty_fem_temp': {
        key: 'qty_fem_temp',
        label: 'FEM Element Temperature (T)',
        unit: 'K',
        category: 'VTK Output Fields',
        shortDesc: 'Include solid element thermodynamic temperature',
        detailedDesc: 'Exports dynamic element temperature T [K] resulting from adiabatic plastic work heating.'
    },
    'qty_fem_damage': {
        key: 'qty_fem_damage',
        label: 'FEM Damage Index (D)',
        unit: 'fraction',
        category: 'VTK Output Fields',
        shortDesc: 'Include scalar damage variable (0 = intact, 1 = fully failed)',
        detailedDesc: 'Exports constitutive damage state variable D [0..1] indicating material degradation, softening, and crack localization.'
    },
    'qty_fem_vel': {
        key: 'qty_fem_vel',
        label: 'FEM Nodal Velocity (v_fem)',
        unit: 'm/s',
        category: 'VTK Output Fields',
        shortDesc: 'Include nodal velocity vector in FEM output',
        detailedDesc: 'Exports nodal velocity vector components (vx, vy, vz) [m/s] on the structural mesh.'
    },
    'qty_fem_disp': {
        key: 'qty_fem_disp',
        label: 'FEM Nodal Displacement (u_fem)',
        unit: 'm',
        category: 'VTK Output Fields',
        shortDesc: 'Include nodal displacement vector in FEM output',
        detailedDesc: 'Exports cumulative nodal displacement vector components (dx, dy, dz) [m] relative to undeformed coordinates.'
    },
    'qty_mpm_stress': {
        key: 'qty_mpm_stress',
        label: 'MPM Particle Stress & von Mises',
        unit: 'Pa',
        category: 'VTK Output Fields',
        shortDesc: 'Include particle stress tensor and von Mises stress',
        detailedDesc: 'Exports Cauchy stress tensor and von Mises equivalent stress on Lagrangian material points.'
    },
    'qty_mpm_strain': {
        key: 'qty_mpm_strain',
        label: 'MPM Plastic Strain (ε_p)',
        unit: 'dim',
        category: 'VTK Output Fields',
        shortDesc: 'Include particle accumulated plastic strain',
        detailedDesc: 'Exports equivalent accumulated plastic strain on Lagrangian MPM debris particles.'
    },
    'qty_mpm_damage': {
        key: 'qty_mpm_damage',
        label: 'MPM Particle Damage (D)',
        unit: 'fraction',
        category: 'VTK Output Fields',
        shortDesc: 'Include particle scalar damage state',
        detailedDesc: 'Exports scalar damage index D [0..1] representing micro-cracking and material spall on particles.'
    },
    'qty_mpm_temp': {
        key: 'qty_mpm_temp',
        label: 'MPM Particle Temperature (T)',
        unit: 'K',
        category: 'VTK Output Fields',
        shortDesc: 'Include particle temperature',
        detailedDesc: 'Exports thermodynamic temperature T [K] of MPM particles.'
    },
    'qty_mpm_vel': {
        key: 'qty_mpm_vel',
        label: 'MPM Particle Velocity (v_mpm)',
        unit: 'm/s',
        category: 'VTK Output Fields',
        shortDesc: 'Include particle velocity vector',
        detailedDesc: 'Exports 3D kinematic velocity vector (vx, vy, vz) [m/s] on Lagrangian material points.'
    },
    'qty_mpm_disp': {
        key: 'qty_mpm_disp',
        label: 'MPM Particle Displacement (u_mpm)',
        unit: 'm',
        category: 'VTK Output Fields',
        shortDesc: 'Include particle displacement vector',
        detailedDesc: 'Exports net spatial displacement vector (dx, dy, dz) [m] of particles from their initial seeding positions.'
    },

    // --- Viewport Charge & Detonator Display ---
    'show_charge': {
        key: 'show_charge',
        label: 'Show Explosive Charge',
        category: '3D Viewport Rendering',
        shortDesc: 'Toggles visibility of explosive charge volume in 3D viewport',
        detailedDesc: 'Controls whether the geometric representation of the explosive charge (sphere, cylinder, or block) is rendered in the 3D viewport canvas.'
    },
    'charge_solid': {
        key: 'charge_solid',
        label: 'Charge Solid Surface',
        category: '3D Viewport Rendering',
        shortDesc: 'Renders filled solid shaded geometry for explosive charge',
        detailedDesc: 'Enables opaque/translucent volumetric surface shading on the explosive charge entity.'
    },
    'charge_wireframe': {
        key: 'charge_wireframe',
        label: 'Charge Wireframe Cage',
        category: '3D Viewport Rendering',
        shortDesc: 'Renders structural wireframe outline for explosive charge',
        detailedDesc: 'Enables wireframe mesh lines around the boundary of the charge geometry.'
    },
    'charge_lighting': {
        key: 'charge_lighting',
        label: 'Charge Directional Lighting',
        category: '3D Viewport Rendering',
        shortDesc: 'Applies specular and diffuse shading to charge geometry',
        detailedDesc: 'Calculates dynamic normals, diffuse reflectance, and specular highlights on the charge surface.'
    },
    'charge_opacity': {
        key: 'charge_opacity',
        label: 'Charge Surface Opacity',
        unit: 'ratio',
        category: '3D Viewport Rendering',
        shortDesc: 'Alpha opacity level for explosive charge (0.0 - 1.0)',
        detailedDesc: 'Specifies the blending opacity of the charge volume, allowing interior structures and detonators to remain visible.'
    },
    'show_detonators': {
        key: 'show_detonators',
        label: 'Show Detonator Points',
        category: '3D Viewport Rendering',
        shortDesc: 'Toggles visibility of point ignition / detonator locations',
        detailedDesc: 'Controls rendering of 3D diamond octahedron detonator markers across the computational domain.'
    },
    'detonators_solid': {
        key: 'detonators_solid',
        label: 'Detonator Solid Core',
        category: '3D Viewport Rendering',
        shortDesc: 'Renders solid shaded core for detonator locations',
        detailedDesc: 'Enables solid diamond faceted marker rendering for detonator initiation points.'
    },
    'detonators_wireframe': {
        key: 'detonators_wireframe',
        label: 'Detonator Wireframe Cage',
        category: '3D Viewport Rendering',
        shortDesc: 'Renders wireframe outline for detonator markers',
        detailedDesc: 'Enables crisp wireframe edges and target ring accents around detonator initiation points.'
    },
    'detonators_lighting': {
        key: 'detonators_lighting',
        label: 'Detonator Specular Lighting',
        category: '3D Viewport Rendering',
        shortDesc: 'Enables dynamic lighting highlights on detonator markers',
        detailedDesc: 'Calculates specular reflectance and surface lighting on 3D detonator geometry.'
    },
    'detonators_size': {
        key: 'detonators_size',
        label: 'Detonator Marker Scale',
        unit: 'scale',
        category: '3D Viewport Rendering',
        shortDesc: 'Visual scale factor for detonator markers in 3D viewport',
        detailedDesc: 'Multiplier for the visual marker radius of detonator points in the 3D canvas.'
    },
    'detonators_opacity': {
        key: 'detonators_opacity',
        label: 'Detonator Marker Opacity',
        unit: 'ratio',
        category: '3D Viewport Rendering',
        shortDesc: 'Alpha opacity level for detonator markers (0.0 - 1.0)',
        detailedDesc: 'Controls transparency and visibility of detonator ignition markers in the 3D viewport.'
    },

    // --- Virtual Gauges & Massive External Probes ---
    'source_mode': {
        key: 'source_mode',
        label: 'Probe Source Mode',
        category: 'Virtual Gauges & Probes',
        shortDesc: 'Source mode for gauge coordinates: manual placement or external dataset file',
        detailedDesc: 'Selects between manual in-graph gauge probe coordinates or high-performance external file streaming (CSV, binary coordinates, HDF5, or structural mesh nodes) for millions of probes.'
    },
    'external_file_path': {
        key: 'external_file_path',
        label: 'External Coordinate File',
        category: 'Virtual Gauges & Probes',
        shortDesc: 'File path to external coordinates dataset',
        detailedDesc: 'Relative or absolute filesystem path to an external coordinate file containing arbitrary probe positions. Loaded directly by BlastSolver via memory mapping.'
    },
    'external_file_format': {
        key: 'external_file_format',
        label: 'External File Format',
        category: 'Virtual Gauges & Probes',
        shortDesc: 'Format of external probe dataset file',
        detailedDesc: 'Auto-detection or explicit format: CSV (x,y,z), Flat Binary Float32 ([x,y,z] contiguous), or HDF5 dataset.'
    },
    'external_probe_count': {
        key: 'external_probe_count',
        label: 'External Probe Count',
        unit: 'count',
        category: 'Virtual Gauges & Probes',
        shortDesc: 'Total number of probes in the external dataset',
        detailedDesc: 'Read-only cached counter of discrete probe coordinates discovered and mapped from the external file.'
    },
    'storage_backend': {
        key: 'storage_backend',
        label: 'Storage Backend',
        category: 'Virtual Gauges & Probes',
        shortDesc: 'Persistence target: HDF5 chunked stream or live WebSocket telemetry',
        detailedDesc: 'Directs whether probe time histories stream directly to disk via asynchronous chunked HDF5 or stream over WebSockets for lightweight setups (< 50 probes).'
    },
    'sampling_stride_steps': {
        key: 'sampling_stride_steps',
        label: 'Sampling Step Stride',
        unit: 'steps',
        category: 'Virtual Gauges & Probes',
        shortDesc: 'Sample probes once every N hydrodynamic time steps',
        detailedDesc: 'Subsampling stride factor along the temporal dimension. Decouples acoustic CFL stability steps (e.g. 0.05 µs) from physical sensor acquisition (e.g. 2.0 µs).'
    },
    'external_bounds_min_x': {
        key: 'external_bounds_min_x',
        label: 'Bounds Min X',
        unit: 'm',
        category: 'Virtual Gauges & Probes',
        shortDesc: 'Minimum X bounding coordinate of probe dataset',
        detailedDesc: 'Lower spatial limit of the bounding box enclosing all active probes along the X axis.'
    },
    'external_bounds_max_x': {
        key: 'external_bounds_max_x',
        label: 'Bounds Max X',
        unit: 'm',
        category: 'Virtual Gauges & Probes',
        shortDesc: 'Maximum X bounding coordinate of probe dataset',
        detailedDesc: 'Upper spatial limit of the bounding box enclosing all active probes along the X axis.'
    },
    'external_bounds_min_y': {
        key: 'external_bounds_min_y',
        label: 'Bounds Min Y',
        unit: 'm',
        category: 'Virtual Gauges & Probes',
        shortDesc: 'Minimum Y bounding coordinate of probe dataset',
        detailedDesc: 'Lower spatial limit of the bounding box enclosing all active probes along the Y axis.'
    },
    'external_bounds_max_y': {
        key: 'external_bounds_max_y',
        label: 'Bounds Max Y',
        unit: 'm',
        category: 'Virtual Gauges & Probes',
        shortDesc: 'Maximum Y bounding coordinate of probe dataset',
        detailedDesc: 'Upper spatial limit of the bounding box enclosing all active probes along the Y axis.'
    },
    'external_bounds_min_z': {
        key: 'external_bounds_min_z',
        label: 'Bounds Min Z',
        unit: 'm',
        category: 'Virtual Gauges & Probes',
        shortDesc: 'Minimum Z bounding coordinate of probe dataset',
        detailedDesc: 'Lower spatial limit of the bounding box enclosing all active probes along the Z axis.'
    },
    'external_bounds_max_z': {
        key: 'external_bounds_max_z',
        label: 'Bounds Max Z',
        unit: 'm',
        category: 'Virtual Gauges & Probes',
        shortDesc: 'Maximum Z bounding coordinate of probe dataset',
        detailedDesc: 'Upper spatial limit of the bounding box enclosing all active probes along the Z axis.'
    },

    // --- Live Text Telemetry & Diagnostics ---
    'stream_layout': {
        key: 'stream_layout',
        label: 'Stream Layout Mode',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Multi-line page, boxed cards, dual-deck, or monospaced columnar formatting',
        detailedDesc: 'Selects telemetry display mode: Live Page (In-Place) for a multi-line curses-style dashboard updating in place; Multi-Line Cards for boxed chronological cards; Dual-Deck (Page + Log) for a pinned top page with scrolling diagnostic logs; Columnar (Fixed-Width) for monospaced tables with sticky headers; Ultra-Compact for narrow side panels; or Standard Log for sequential messages.'
    },
    'filter_level': {
        key: 'filter_level',
        label: 'Terminal Filter Level',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Filters text messages displayed in the terminal stream',
        detailedDesc: 'Filters the live stream: All shows all step metrics and engine log messages; Metrics Only isolates step performance data; Logs Only shows solver diagnostics and event messages.'
    },
    'timestamp_mode': {
        key: 'timestamp_mode',
        label: 'Timestamp Format',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Timestamp prefix format on log lines',
        detailedDesc: 'Configures line prefixes: None for maximal horizontal compactness, Relative (+s.ms) for runtime duration since solver startup, or Clock (HH:MM:SS) for absolute wallclock timestamps.'
    },
    'show_timing_breakdown': {
        key: 'show_timing_breakdown',
        label: 'Show Phase Timing Breakdown',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Displays separate PHYS, IO, and COM timing columns',
        detailedDesc: 'Breaks down per-step wallclock time into physics computation kernel time (PHYS), disk I/O and VTK/HDF5 output time (IO), and telemetry serialization/transmission time (COM).'
    },
    'show_memory': {
        key: 'show_memory',
        label: 'Show Memory Allocation (RAM / VRAM)',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Displays process host RAM and GPU VRAM usage columns',
        detailedDesc: 'Reports resident process host RAM (RSS) and allocated CUDA GPU VRAM in megabytes or gigabytes.'
    },
    'show_wallclock': {
        key: 'show_wallclock',
        label: 'Show Cumulative Wallclock',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Displays total elapsed wallclock time column',
        detailedDesc: 'Shows the cumulative wallclock execution time of the active simulation model in seconds.'
    },
    'show_dt': {
        key: 'show_dt',
        label: 'Show Timestep (dt)',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Displays current numerical timestep column',
        detailedDesc: 'Shows the adaptive time step Δt computed from acoustic, hydrodynamic, or Courant-Friedrichs-Lewy (CFL) stability criteria.'
    },
    'font_size': {
        key: 'font_size',
        label: 'Terminal Font Size',
        unit: 'px',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Monospaced text font size in pixels (8px - 22px)',
        detailedDesc: 'Sets the font size for the terminal viewport. Can also be interactively adjusted by holding Ctrl and scrolling the mouse wheel over the terminal or canvas node.'
    },
    'buffer_capacity': {
        key: 'buffer_capacity',
        label: 'History Buffer Capacity',
        unit: 'lines',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Maximum rolling history lines preserved in memory (25 - 500)',
        detailedDesc: 'Limits the rolling line buffer to prevent browser memory exhaustion during extended simulation runs.'
    },
    'beamRadius': {
        key: 'beamRadius',
        label: 'Beam Outer Tube Radius',
        unit: 'm',
        category: '3D Viewport & Visuals',
        shortDesc: 'Outer radius of visualized 3D structural beam cylinders',
        detailedDesc: 'Specifies the outer cylinder radius (in meters) used when rendering solid 3D structural beam elements in the WebGPU/HTML5 canvas viewport.'
    },
    'rebarRadius': {
        key: 'rebarRadius',
        label: 'Rebar Strand Outer Radius',
        unit: 'm',
        category: '3D Viewport & Visuals',
        shortDesc: 'Outer radius of visualized 3D embedded rebar cylinders',
        detailedDesc: 'Specifies the outer cylinder radius (in meters) used when rendering solid 3D reinforced rebar strands in the WebGPU/HTML5 canvas viewport.'
    },
    'viewport_refresh_rate': {
        key: 'viewport_refresh_rate',
        label: 'Viewport Refresh Frame Rate',
        unit: 'Hz',
        category: '3D Viewport & Visuals',
        shortDesc: 'Target frame rate for viewport 3D rendering',
        detailedDesc: 'Sets the target render loop refresh rate (1 to 60 Hz) for the viewport 3D worker thread to balance frame smoothness against GPU compute load.'
    }
};

// ============================================================================
// 2. MASTER NODE-TYPE DOCUMENTATION REGISTRY (ALL 38 NODES)
// ============================================================================

export const NODE_DEFINITIONS: Record<string, NodeDefinition> = {
    'DomainMesh': {
        type: 'DomainMesh',
        title: '1D Domain Mesh',
        category: '1D CFD Gas Dynamics',
        shortDesc: 'Structured 1D spatial grid defining boundary conditions and uniform cell discretization.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>1D Domain Mesh</strong> node discretizes a one-dimensional spatial line or spherical radial line into uniform finite-volume cells. It establishes the computational bounds, cell widths (<code>cell_size</code>), and boundary conditions (Reflecting, Transmitting, or Terminate) for 1D high-explosive detonation and shock wave propagation.</p>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Governing Physics & Formulations</div>
                <p>Governed by the 1D compressible Euler equations with geometric source terms for spherical or planar symmetry:</p>
                <div class="node-doc-code">∂U/∂t + ∂F(U)/∂r = -α/r · S(U)</div>
                <p>where <em>α = 2</em> for spherical symmetry and <em>α = 0</em> for planar 1D shock tubes. Boundary conditions enforce zero normal velocity (<em>u = 0</em>) at reflecting walls or non-reflecting ghost extrapolation at transmitting far-fields.</p>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Inputs & Upstream Connections</div>
                <ul>
                    <li>Feeds directly into <strong>ThePainter</strong> to establish the initial physical field values.</li>
                </ul>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Key Parameters & Tuning Guide</div>
                <ul>
                    <li><code>domain_radius</code>: Ensure domain radius is large enough to capture the full blast profile before shock reflection.</li>
                    <li><code>cell_size</code>: Recommended 0.0005–0.001 m (0.5–1 mm) for high-fidelity Chapman-Jouguet spike resolution.</li>
                </ul>
            </div>
        `
    },

    'Material': {
        type: 'Material',
        title: 'Universal Material & Constitutive Model',
        category: 'Material & Thermodynamic Equations of State',
        shortDesc: 'Universal material node supporting Linear Elastic, Hypoelastic, Johnson-Cook, CREST-Davis Reactive Burn, Concrete (RHT/K&C/CSCM), Ideal Gas, and JWL Detonation Gas models across all solvers.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>Material</strong> node is the universal constitutive and Equation of State (EOS) specification node for all solvers (CFD, MPM, and FEM). Selecting a constitutive model dynamically filters the available material presets and configures appropriate physical parameters.</p>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Supported Constitutive & EOS Models</div>
                <ul>
                    <li><strong>Linear Elastic (Baseline):</strong> Hookean isotropic elasticity for structural solids (Steel, Aluminum, Titanium, Glass, Concrete).</li>
                    <li><strong>CREST Reactive Burn (MPM):</strong> Davis solid reactant + Davis product gas EOS with shock entropy-driven hot-spot ignition and grain growth reaction kinetics for autonomous shock-to-detonation transition (SDT).</li>
                    <li><strong>Hypoelastic (Solid):</strong> Jaumann rate-integrated linear elasticity with von Mises J2 plastic yield and isotropic linear hardening.</li>
                    <li><strong>Johnson-Cook + Mie-Grüneisen:</strong> Viscoplastic strain-rate and thermal softening yield model coupled with Mie-Grüneisen shock Hugoniot EOS for armor metals and hypervelocity penetration.</li>
                    <li><strong>RHT Concrete:</strong> Riedel-Hiermaier-Thoma 3-invariant compressive, tensile, and shear yield envelopes with porous P-alpha compaction and shear damage softening.</li>
                    <li><strong>Karagozian & Case (K&C):</strong> 3-surface plasticity model with damage evolution, shear dilation, and tensile softening for concrete structures under blast loading.</li>
                    <li><strong>CSCM Concrete:</strong> Continuous Smooth Cap Model with invariant yield surface and damage softening.</li>
                    <li><strong>Ideal Gas (CFD):</strong> Gamma-law equation of state for ambient air and blast propagation.</li>
                    <li><strong>JWL Detonation Gas (CFD):</strong> Jones-Wilkins-Lee expansion equation of state for programmed burn high explosives.</li>
                </ul>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Inputs & Upstream Connections</div>
                <ul>
                    <li>Connects to <strong>ThePainter</strong>, <strong>Charge1D</strong>, <strong>Charge2D</strong>, <strong>Charge3D</strong>, <strong>MPMObject2D</strong>, <strong>MPMObject3D</strong>, <strong>FEMObject3D</strong>, and Solvers as the single source of truth for material physics.</li>
                </ul>
            </div>
        `
    },

    'Charge1D': {
        type: 'Charge1D',
        title: '1D Explosive Charge',
        category: '1D CFD Gas Dynamics',
        shortDesc: '1D High-explosive spherical charge mass and radius geometry.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>Charge1D</strong> node specifies the physical mass (kg) and radius (m) of a spherical high-explosive charge in 1D space. It automatically couples with the connected <strong>Material</strong> density to ensure mass conservation.</p>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Key Parameters</div>
                <ul>
                    <li><code>charge_mass</code>: Explosive mass in kg (e.g. 1.0 kg TNT equivalent).</li>
                    <li><code>charge_radius</code>: Computed automatically via <em>R = (3M / (4πρ₀))^(1/3)</em> or manually overridden.</li>
                </ul>
            </div>
        `
    },

    'Charge2D': {
        type: 'Charge2D',
        title: '2D Axisymmetric Charge',
        category: '2D Axisymmetric CFD',
        shortDesc: '2D Spherical or cylindrical charge geometry with spatial centroid positioning.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>Charge2D</strong> node defines the spatial positioning and geometry of high-explosive charges in 2D axisymmetric (r-z) or planar domains. Supports spherical and cylindrical geometries with arbitrary aspect ratios.</p>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Key Parameters</div>
                <ul>
                    <li><code>charge_shape</code>: Sphere or Cylinder.</li>
                    <li><code>charge_r</code>, <code>charge_z</code>: Radial and axial centroid coordinates (m).</li>
                    <li><code>charge_aspect_ratio</code>: Length-to-diameter ratio (L/D) for cylindrical charges.</li>
                </ul>
            </div>
        `
    },

    'Charge3D': {
        type: 'Charge3D',
        title: '3D High-Explosive Charge',
        category: '3D Multi-Material CFD',
        shortDesc: '3D Cartesian spherical, cylindrical, or rectangular block charge with 3-axis Euler orientation.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>Charge3D</strong> node defines complex 3D high-explosive charge geometries in full Cartesian space. Supports Spheres, Cylinders with arbitrary orientation, and rectangular Blocks (slabs).</p>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Key Parameters</div>
                <ul>
                    <li><code>charge_shape</code>: Sphere, Cylinder, or Block.</li>
                    <li><code>charge_x</code>, <code>charge_y</code>, <code>charge_z</code>: Cartesian coordinates of charge center.</li>
                    <li><code>charge_rot_x</code>, <code>charge_rot_y</code>, <code>charge_rot_z</code>: 3-axis Euler rotation angles (degrees) to orient directional blast charges.</li>
                </ul>
            </div>
        `
    },

    'ThePainter': {
        type: 'ThePainter',
        title: 'Initial Conditions Painter',
        category: '1D CFD Gas Dynamics',
        shortDesc: 'Maps spatial cells to physical material thermodynamic states for simulation initialization.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>ThePainter</strong> node serves as the initial condition compositor for 1D CFD simulations. It takes a DomainMesh, Air Material, and Charge Material, and paints the initial density, pressure, velocity, and species mass fractions across all grid cells.</p>
            </div>
        `
    },

    'CFDSolver': {
        type: 'CFDSolver',
        title: '1D Compressible CFD Solver',
        category: '1D CFD Gas Dynamics',
        shortDesc: 'High-order 1D compressible Euler solver with multi-material JWL and shock-capturing schemes.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>CFDSolver</strong> node executes the 1D high-order compressible Euler equations. It resolves Chapman-Jouguet detonation wave propagation, unreacted explosive consumption, contact discontinuities, and expanding blast shock waves with extreme efficiency.</p>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Governing Physics</div>
                <p>Solves the multi-material compressible Euler conservation laws:</p>
                <div class="node-doc-code">∂/∂t [ρ, ρu, ρE, ρY₁, ρY₂]ᵀ + ∂/∂r [ρu, ρu² + p, u(ρE + p), ρuY₁, ρuY₂]ᵀ = S_geom + S_det</div>
                <p>Features 2nd-order MUSCL-Hancock and ADER space-time predictor schemes with AUSM+ flux splitting.</p>
            </div>
        `
    },

    'TelemetryText': {
        type: 'TelemetryText',
        title: 'Live Terminal Text Telemetry',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Live monospaced columnar text stream with phase timing breakdowns, memory diagnostics, and font controls.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>TelemetryText</strong> node provides a real-time console log and metric stream from the running solver binary over WebSockets. It organizes simulation telemetry into clean, fixed-width monospaced columns or compact logs, avoiding untidy mid-word line wraps in narrow panels.</p>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Governing Physics & Formulations</div>
                <p>Monitors physical integration steps, current simulation time (<em>t_sim</em>), adaptive acoustic/hydrodynamic CFL time steps (<em>Δt</em>), and phase timing breakdowns:</p>
                <div class="node-doc-code">t_step = t_compute (PHYS) + t_io (IO) + t_comms (COM)</div>
                <p>Simultaneously monitors host RAM (Resident Set Size) and GPU device VRAM allocation to ensure execution within physical memory limits.</p>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Inputs & Upstream Connections</div>
                <ul>
                    <li>Receives telemetry envelopes from <strong>CFDSolver</strong>, <strong>CFDSolver2D</strong>, <strong>CFDSolver3D</strong>, <strong>MPMDomain2D</strong>, <strong>MPMDomain3D</strong>, <strong>FEMDomain3D</strong>, or coupling managers.</li>
                </ul>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Outputs & Telemetry</div>
                <p>Renders live columnar tables with sticky header navigation, customizable zoom levels, and filtered message streams.</p>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Key Parameter Tuning Guide</div>
                <ul>
                    <li><code>stream_layout</code>: Set to <em>Live Page (In-Place)</em> for a full status dashboard, <em>Multi-Line Cards</em> for boxed blocks, <em>Dual-Deck (Page + Log)</em> for pinned status + events, <em>Columnar (Fixed-Width)</em> for fixed tables, or <em>Ultra-Compact</em> for narrow docks.</li>
                    <li><code>show_timing_breakdown</code>: Enable to isolate solver bottlenecks across computation (PHYS), disk write (IO), and telemetry packaging (COM).</li>
                    <li><code>show_memory</code>: Enable to detect particle multiplication or mesh expansion memory growth in RAM and VRAM.</li>
                    <li><code>font_size</code>: Adjust text size between 8px and 22px, or hold <code>Ctrl</code> and scroll the mouse wheel over the viewport.</li>
                </ul>
            </div>
        `
    },

    'TelemetryGraph': {
        type: 'TelemetryGraph',
        title: '1D Line Chart Telemetry',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Real-time 1D spatial profile viewer plotting pressure, density, velocity, and energy profiles.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>TelemetryGraph</strong> node renders live 60 FPS HTML5 Canvas line plots of 1D spatial solution profiles. Visualizes shock wave steepening, overpressure peaks, and rarefaction waves across the spatial domain.</p>
            </div>
        `
    },

    'DomainMesh2D': {
        type: 'DomainMesh2D',
        title: '2D Axisymmetric / Planar Mesh',
        category: '2D Axisymmetric CFD',
        shortDesc: '2D Cylindrical r-z or Cartesian x-y grid domain with structured uniform cell discretization.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>DomainMesh2D</strong> node discretizes a 2D cylindrical axisymmetric (r-z) or Cartesian (x-y) domain into structured uniform finite-volume cells. Defines boundary conditions for r_min (centerline symmetry axis), r_max, z_min, and z_max.</p>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Governing Physics</div>
                <p>For Axisymmetric mode, incorporates cylindrical volume metrics (<em>2πr dr dz</em>) and radial momentum geometric source terms (<em>p/r</em>) to accurately capture 3D spherical blast propagation on a fast 2D computational slice.</p>
            </div>
        `
    },

    'DetonatorLocation': {
        type: 'DetonatorLocation',
        title: '2D Detonation Point Location',
        category: '2D Axisymmetric CFD',
        shortDesc: 'Specifies the spatial point source coordinates and hotspot radius for 2D detonation initiation.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>DetonatorLocation</strong> node establishes the initiation point in 2D space (r, z) where Chapman-Jouguet detonation begins. Sets the initial hot-spot radius to trigger self-sustaining detonation wave expansion.</p>
            </div>
        `
    },

    'DetonatorLocation3D': {
        type: 'DetonatorLocation3D',
        title: '3D Detonation Point Location',
        category: 'Point Detonator & Ignition',
        shortDesc: 'Specifies 3D Cartesian coordinates (x,y,z) and hotspot radius for explosive initiation in CFD and MPM solvers.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>DetonatorLocation3D</strong> node defines the exact 3D Cartesian point (x, y, z) and initiation radius for point-source explosive initiation across both Eulerian CFD and Lagrangian MPM simulation pipelines:</p>
                <ul>
                    <li><strong>3D CFD Solvers (Eulerian):</strong> Seeds initial high-temperature, high-pressure CJ detonation gas kernels in multi-material JWL or ideal gas blast hydrodynamics.</li>
                    <li><strong>3D MPM Solvers (Lagrangian):</strong> Provides hot-spot point ignition for energetic solid materials configured with the <strong>CREST Reactive Burn + Davis EOS</strong> constitutive model. Particles falling within the detonator initiation radius receive shock entropy seeding (s_shock &ge; 1.5 &times; s_threshold), full reaction progress (&lambda; = 1.0), and specific internal energy (e_int = q_det), initiating self-propagating detonation waves across the particle cloud.</li>
                </ul>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Inputs & Upstream Connections</div>
                <p>This node is a standalone spatial source node and does not require upstream inputs.</p>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Outputs & Downstream Connections</div>
                <ul>
                    <li><strong>Detonator Spec (detonator):</strong> Connects to the <code>detonator</code> input port of <code>CFDSolver3D</code> (for Eulerian blast simulations) or <code>MPMDomain3D</code> (for pure MPM CREST reactive burn simulations).</li>
                </ul>
            </div>
        `
    },

    'RemapNode': {
        type: 'RemapNode',
        title: 'Solution Remapper (1D → 2D)',
        category: 'Remap & State Interpolation',
        shortDesc: 'Integrates and maps converged 1D spherical blast states onto the 2D axisymmetric grid.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>RemapNode</strong> (1D → 2D) reads the highly resolved 1D spherical blast solution and maps its conserved density, momentum, energy, and species fractions onto the 2D axisymmetric mesh. Enables high-speed multi-stage simulation workflows where 1D runs handle charge detonation and 2D handles ground reflection.</p>
            </div>
        `
    },

    'Remap1DTo2DNode': {
        type: 'Remap1DTo2DNode',
        title: 'Remapper (1D → 2D)',
        category: 'Remap & State Interpolation',
        shortDesc: 'Maps converged 1D spherical blast solution onto 2D r-z mesh at specified origin.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>Identical to RemapNode; transfers high-resolution 1D spherical blast wave fields into a 2D axisymmetric computational domain centered at explosive coordinates (r, z).</p>
            </div>
        `
    },

    'Remap1DTo3DNode': {
        type: 'Remap1DTo3DNode',
        title: 'Remapper (1D → 3D)',
        category: 'Remap & State Interpolation',
        shortDesc: 'Spherical radial mapping of 1D blast solution onto 3D Cartesian domain.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>Remap1DTo3DNode</strong> reads a 1D spherical shock solution and performs radial 3D interpolation onto a 3D Cartesian grid around a specified origin (x, y, z). Saves orders of magnitude in compute time compared to running 3D detonation from scratch.</p>
            </div>
        `
    },

    'Remap2DTo3DNode': {
        type: 'Remap2DTo3DNode',
        title: 'Remapper (2D → 3D)',
        category: 'Remap & State Interpolation',
        shortDesc: 'Revolves 2D axisymmetric blast state into 3D Cartesian volume around vertical axis.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>Remap2DTo3DNode</strong> revolves a converged 2D axisymmetric blast field (e.g. after ground Mach stem formation) into full 3D Cartesian space around a specified origin for subsequent 3D obstacle interaction or structural loading.</p>
            </div>
        `
    },

    'HardwareConfig': {
        type: 'HardwareConfig',
        title: 'Hardware & Compute Execution Config',
        category: 'Hardware & Architecture',
        shortDesc: 'Selects execution hardware (CPU OpenMP / CUDA GPU) and numeric floating-point precision.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>HardwareConfig</strong> node configures the compute backend (CPU OpenMP vs CUDA GPU) and numeric precision (FP32 Single vs FP64 Double). Synchronizes across all solvers in the model.</p>
            </div>
        `
    },

    'CFDSolver2D': {
        type: 'CFDSolver2D',
        title: '2D Axisymmetric CFD Solver',
        category: '2D Axisymmetric CFD',
        shortDesc: 'High-order 2D axisymmetric / planar compressible Euler CFD solver.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>CFDSolver2D</strong> node solves the 2D multi-material compressible Euler equations on cylindrical r-z or planar x-y meshes. Features 2nd-order MUSCL/TVD and ADER schemes with AUSM+ flux splitting, multi-material JWL detonation, ground reflections, and Mach stem shock interactions.</p>
            </div>
        `
    },

    'TelemetryContour': {
        type: 'TelemetryContour',
        title: '2D Real-Time Heatmap Telemetry',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Real-time 2D color contour heatmap renderer for pressure, density, and velocity fields.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>TelemetryContour</strong> node renders live 60 FPS color contour heatmaps of dynamic physical fields (pressure, density, velocity magnitude, species fractions) streamed live from the 2D solver.</p>
            </div>
        `
    },

    'VTKOutput': {
        type: 'VTKOutput',
        title: 'VTK XML Snapshot Exporter',
        category: 'VTK & Disk I/O',
        shortDesc: 'Exports simulation state snapshots in standard VTK XML format (.vtu / .pvd) for ParaView.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>VTKOutput</strong> node manages high-performance disk streaming of simulation datasets in standard VTK XML Unstructured Grid (.vtu) and ParaView Collection (.pvd) formats. Supports CFD fluid grids, FEM solid meshes, and MPM particle swarms with ROI spatial cropping and stride decimation.</p>
            </div>
        `
    },

    'VirtualGauges': {
        type: 'VirtualGauges',
        title: 'Virtual Sensor Gauge Array',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Records pressure, overpressure, and impulse time-history at discrete spatial probe coordinates or massive external datasets.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>VirtualGauges</strong> node places numerical sensor probes at discrete spatial coordinates (x, y, z) or streams millions of unstructured probes from external files (CSV, binary coordinates, HDF5, or structural mesh nodes). Records continuous time-history series of blast overpressure, peak positive phase duration, specific impulse, density, and velocity. Supports direct asynchronous HDF5 chunked streaming, virtualized windowed UI exploration, and WebGPU point cloud visualization.</p>
            </div>
        `
    },

    'DomainMesh3D': {
        type: 'DomainMesh3D',
        title: '3D Cartesian Domain Mesh',
        category: '3D Multi-Material CFD',
        shortDesc: '3D Uniform structured Cartesian mesh defining 6-face boundary conditions and cell resolution.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>DomainMesh3D</strong> node defines a 3D uniform structured Cartesian grid with bounds (xmin..xmax, ymin..ymax, zmin..zmax) and uniform cell size (<code>cell_size</code>). Sets independent boundary conditions on all six domain faces (X-min, X-max, Y-min, Y-max, Z-min, Z-max).</p>
            </div>
        `
    },

    'CFDSolver3D': {
        type: 'CFDSolver3D',
        title: '3D Multi-Material CFD Solver',
        category: '3D Multi-Material CFD',
        shortDesc: '3D High-order compressible Euler solver with multi-material JWL and shock-capturing schemes.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>CFDSolver3D</strong> node executes 3D multi-material compressible Euler simulation on uniform Cartesian grids. Capable of simulating complex 3D blast waves, urban canyon diffraction, solid obstacle interactions via Immersed Boundary Method, and high-fidelity fluid-structure coupling.</p>
            </div>
        `
    },

    'Telemetry3DViewport': {
        type: 'Telemetry3DViewport',
        title: '3D Interactive Viewport & Visualizer',
        category: 'Telemetry & Diagnostics',
        shortDesc: 'Real-time WebGPU/Canvas 3D interactive volumetric viewport for fluid slices, FEM meshes, and MPM particles.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>Telemetry3DViewport</strong> node provides a high-performance 3D visualizer running in a dedicated Web Worker. Renders interactive orthogonal fluid slices, 3D solid CAD obstacles, deformable FEM structural meshes, and MPM particle swarms with advanced PBR lighting, SSAO, and colormaps.</p>
            </div>
        `
    },

    'STLGeometry': {
        type: 'STLGeometry',
        title: 'STL CAD Surface Boundary',
        category: 'Boundary & CAD Geometry',
        shortDesc: 'Loads 3D STL surface meshes for solid obstacle Immersed Boundary Method (IBM) rasterization.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>STLGeometry</strong> node imports standard 3D STL CAD surface meshes to represent complex rigid solid obstacles (buildings, vehicles, blast walls, terrain) in 3D CFD via the Immersed Boundary Method (IBM).</p>
            </div>
        `
    },

    'PrimitiveGeometry3D': {
        type: 'PrimitiveGeometry3D',
        title: '3D Analytic Primitive Solid Geometry',
        category: 'Boundary & CAD Geometry',
        shortDesc: 'Defines analytic CSG solid primitives (boxes, cylinders, spheres, wedges) for IBM obstacles.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>PrimitiveGeometry3D</strong> node allows users to construct complex 3D solid obstacles using analytic Constructive Solid Geometry (CSG) primitives (Boxes, Cylinders, Spheres, Cones, Wedges) with additive and subtractive boolean operations.</p>
            </div>
        `
    },

    'MPMDomain2D': {
        type: 'MPMDomain2D',
        title: '2D Material Point Method Domain',
        category: 'Lagrangian MPM Solid Mechanics',
        shortDesc: '2D MPM particle dynamics solver settings, transfer schemes (GIMP/BSpline), and velocity schemes.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>MPMDomain2D</strong> node configures the 2D Material Point Method particle solver. Simulates extreme solid deformation, fracture fragmentation, high-velocity projectile penetration, and fluid-structure interaction with zero mesh tangling.</p>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Inputs & Upstream Connections</div>
                <ul>
                    <li><strong>Grid (mesh):</strong> Connects from <code>DomainMesh2D</code> to specify the background grid dimensions and cell size.</li>
                    <li><strong>MPM Objects (objects):</strong> Connects from one or more <code>MPMObject2D</code> nodes.</li>
                    <li><strong>Detonators (detonator, optional):</strong> Connects from one or more <code>DetonatorLocation</code> nodes for multi-point hot-spot initiation.</li>
                </ul>
            </div>
        `
    },

    'MPMDomain3D': {
        type: 'MPMDomain3D',
        title: '3D Material Point Method Domain',
        category: 'Lagrangian MPM Solid Mechanics',
        shortDesc: '3D MPM particle dynamics solver settings, transfer schemes (GIMP/BSpline), and 2nd-order Leapfrog integration.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>MPMDomain3D</strong> node executes 3D Material Point Method continuum particle dynamics. Seamlessly models hyper-velocity impact, ductile tearing, ceramic shattering, and explosive detonation on CPU or CUDA GPU backends.</p>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Inputs & Upstream Connections</div>
                <ul>
                    <li><strong>Grid (mesh):</strong> Connects from <code>DomainMesh3D</code> to specify the background Cartesian grid dimensions, cell size, and boundary conditions.</li>
                    <li><strong>MPM Objects (objects):</strong> Connects from one or more <code>MPMObject3D</code> nodes representing solid bodies, projectiles, or explosive charges.</li>
                    <li><strong>Detonators (detonator, optional):</strong> Connects from one or more <code>DetonatorLocation3D</code> nodes to provide multi-point hot-spot ignition for energetic materials utilizing the <strong>CREST Reactive Burn + Davis EOS</strong> model.</li>
                </ul>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Outputs & Downstream Connections</div>
                <ul>
                    <li><strong>Telemetry (telemetry):</strong> Streams particle states, stresses, and field variables to <code>Telemetry3DViewport</code> or <code>TelemetryText</code>.</li>
                    <li><strong>MPM State (mpm_out):</strong> Connects to <code>FSICoupler3D</code> for coupled fluid-structure interaction simulations.</li>
                </ul>
            </div>
        `
    },

    'MPMObject2D': {
        type: 'MPMObject2D',
        title: '2D MPM Solid Object',
        category: 'Lagrangian MPM Solid Mechanics',
        shortDesc: '2D MPM Primitive Object defining geometry shape, position, initial velocities, and material binding.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>MPMObject2D</strong> node defines a discrete 2D deformable solid body represented by MPM material points. Specifies shape, initial position, linear/angular velocity, and material model bindings.</p>
            </div>
        `
    },

    'MPMObject3D': {
        type: 'MPMObject3D',
        title: '3D MPM Solid Object',
        category: 'Lagrangian MPM Solid Mechanics',
        shortDesc: '3D MPM Continuum Solid Object defining geometry, initial velocities, and material bindings.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>MPMObject3D</strong> node instantiates a 3D deformable solid body discretized into Lagrangian material points. Supports Box, Cylinder, Sphere, and STL CAD surface geometry sources.</p>
            </div>
        `
    },

    'FSICoupler2D': {
        type: 'FSICoupler2D',
        title: '2D Fluid-Structure Interaction Coupler',
        category: 'Fluid-Structure Interaction',
        shortDesc: 'Two-way dynamic coupling between 2D Eulerian CFD gas dynamics and 2D Lagrangian MPM solid particles.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>FSICoupler2D</strong> node establishes two-way fluid-structure interaction between Eulerian CFD gas dynamics and Lagrangian MPM particles. Fluid pressures apply surface loads onto solid particles, while moving solid boundaries displace and compress fluid cells. In coupled models, this node serves as the authoritative single source of truth for the coupled CFL Courant factor.</p>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Governing Physics & Formulations</div>
                <p>Computes synchronized coupled timesteps: Δt_coupled = min(Δt_solid, Δt_fluid), ensuring exact stability across the fluid-solid boundary.</p>
            </div>
        `
    },

    'FSICoupler3D': {
        type: 'FSICoupler3D',
        title: '3D MPM Fluid-Structure Coupler',
        category: 'Fluid-Structure Interaction',
        shortDesc: 'Two-way dynamic coupling between 3D Eulerian CFD blast dynamics and 3D Lagrangian MPM particles.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>FSICoupler3D</strong> node couples 3D Eulerian finite-volume CFD fluid grids with 3D Lagrangian MPM particles on the shared compute device (CPU or CUDA GPU). It provides a unified, single point of configuration for the coupled timestep and CFL Courant stability factor.</p>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Governing Physics & Formulations</div>
                <p>Implements two-way staggered explicit coupling with conservative pressure boundary transmission and adaptive timestep ramping.</p>
            </div>
        `
    },

    'FEMDomain3D': {
        type: 'FEMDomain3D',
        title: '3D FEM Structural Mechanics Domain',
        category: 'Lagrangian FEM Structural Dynamics',
        shortDesc: '3D Explicit Lagrangian FEM solver settings, Flanagan-Belytschko hourglass control, sliding contact, and erosion.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>FEMDomain3D</strong> node executes 3D explicit Lagrangian finite-element structural dynamics. Features 1-point reduced integration with Flanagan-Belytschko stiffness hourglass stabilization, penalty contact, Weibull material heterogeneity, and automatic conversion of failed elements to MPM debris.</p>
            </div>
        `
    },

    'FEMObject3D': {
        type: 'FEMObject3D',
        title: '3D FEM Structural Body',
        category: 'Lagrangian FEM Structural Dynamics',
        shortDesc: '3D FEM Hexahedral solid body defining geometry generator, boundary constraints, and material bindings.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>FEMObject3D</strong> node defines a 3D structural body discretized into 8-node hexahedral solid elements. Supports parametric Box and Cylinder generators as well as imported LS-DYNA keyword meshes.</p>
            </div>
        `
    },

    'FEMBeam3D': {
        type: 'FEMBeam3D',
        title: '3D FEM Structural Beam Framework',
        category: 'Lagrangian FEM Structural Dynamics',
        shortDesc: '3D structural beam elements supporting axial tension/compression, bending moments, and plastic hinge yield.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>FEMBeam3D</strong> node models structural steel and reinforced concrete frame members using 2-node Timoshenko/Euler-Bernoulli beam formulations with 6 degrees of freedom per node. It captures axial, shear, torsional, and bending responses under high-rate blast loading.</p>
            </div>
            <div class="node-doc-section">
                <div class="node-doc-heading">Outputs & Telemetry</div>
                <p>Computes axial force, shear resultant, bending moments (M_y, M_z), and effective plastic strain across integration points.</p>
            </div>
        `
    },

    'FEMRebar3D': {
        type: 'FEMRebar3D',
        title: '3D Embedded Rebar Reinforcement',
        category: 'Lagrangian FEM Structural Dynamics',
        shortDesc: 'Embedded 1D tension-compression reinforcement steel strands kinematic-coupled to host concrete solid elements.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>FEMRebar3D</strong> node models embedded steel rebar cages inside concrete solid elements without requiring conformal meshing. Bond-slip kinematics and tension-stiffening transfer loads directly between concrete and reinforcement bars.</p>
            </div>
        `
    },

    'Obstacle': {
        type: 'Obstacle',
        title: 'Rigid Obstacle Geometry',
        category: 'CFD Geometry & Boundary Obstacles',
        shortDesc: 'Immersed boundary geometric obstacle blocking fluid flow and reflecting shock waves.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>Obstacle</strong> node defines rigid constructive solid geometry primitives (boxes, cylinders, spheres) that act as zero-velocity reflecting immersed boundaries in the CFD Eulerian domain.</p>
            </div>
        `
    },

    'Obstacle3D': {
        type: 'Obstacle3D',
        title: '3D CSG Obstacle Geometry',
        category: 'CFD Geometry & Boundary Obstacles',
        shortDesc: '3D immersed constructive solid geometry obstacle reflecting Eulerian blast waves and sampling surface pressure.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>Obstacle3D</strong> node defines 3D immersed boundary primitives (boxes, cylinders, spheres, wedges) that reflect shock fronts and record surface blast overpressure and impulse histories.</p>
            </div>
        `
    },

    'LSDynaImporter3D': {
        type: 'LSDynaImporter3D',
        title: 'LS-DYNA Keyword File Importer (*.k)',
        category: 'Structural Mechanics',
        shortDesc: 'Imports hexahedral/shell mesh topologies, section properties, and material definitions into 3D FEM.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>LSDynaImporter3D</strong> node parses standard LS-DYNA Keyword decks (*.k, *.key, *.dyn) to import industrial structural meshes, complex part assemblies, and material assignments directly into the 3D FEM solver.</p>
            </div>
        `
    },

    'FEMFSICoupler3D': {
        type: 'FEMFSICoupler3D',
        title: '3D FEM Fluid-Structure Coupler',
        category: 'Fluid-Structure Interaction',
        shortDesc: 'Two-way conservative coupling between 3D Eulerian CFD fluid grids and 3D Lagrangian FEM structural elements.',
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">Overview & Role</div>
                <p>The <strong>FEMFSICoupler3D</strong> node executes high-fidelity conservative two-way fluid-structure coupling between 3D Eulerian CFD and 3D Lagrangian FEM structures using Separating Axis Theorem (SAT) cut-cell aperture rasterization, 2x2 Gauss quadrature pressure integration, and fracture erosion venting.</p>
            </div>
        `
    }
};

// ============================================================================
// 3. RETRIEVAL HELPERS & POPOVER MANAGEMENT
// ============================================================================

export function getSolverScope(key: string, nodeType?: string): SolverScope {
    const def = PARAMETER_DEFINITIONS[key];
    if (def && def.solverScope) return def.solverScope;

    // Node-type specific inference
    if (nodeType === 'FEMDomain3D' || nodeType === 'FEMObject3D' || nodeType === 'LSDynaImporter3D') {
        return 'FEM';
    }
    if (nodeType === 'MPMDomain2D' || nodeType === 'MPMDomain3D' || nodeType === 'MPMObject2D' || nodeType === 'MPMObject3D') {
        return 'MPM';
    }
    if (nodeType === 'CFDSolver' || nodeType === 'CFDSolver2D' || nodeType === 'CFDSolver3D' || 
        nodeType === 'DomainMesh' || nodeType === 'DomainMesh2D' || nodeType === 'DomainMesh3D' || 
        nodeType === 'Charge1D' || nodeType === 'Charge2D' || nodeType === 'Charge3D' || 
        nodeType === 'DetonatorLocation' || nodeType === 'DetonatorLocation3D') {
        return 'FV';
    }
    if (nodeType === 'FSICoupler2D' || nodeType === 'FSICoupler3D') {
        return 'MPM+FV';
    }
    if (nodeType === 'FEMFSICoupler3D') {
        return 'FEM';
    }

    // Material parameters key-based mapping
    const mpmOnlyKeys = [
        'transfer_scheme', 'weibull_modulus', 'weibull_scale', 'fracture_toughness', 'debris_bulk_factor',
        'dem_transition_enabled', 'fragment_distribution', 'fragment_min_size', 'fragment_max_size',
        'fragment_weibull_n', 'fragment_clumping_radius', 'fragment_ejection_jitter',
        'fragment_contact_friction', 'fragment_restitution'
    ];
    if (mpmOnlyKeys.includes(key)) return 'MPM';

    const femOnlyKeys = [
        'enable_timestep_erosion', 'timestep_erosion_factor', 'hourglass_coeff', 'contact_penalty_scale', 
        'friction_static', 'friction_kinetic', 'integration_scheme', 'hourglass_model', 
        'rebar_formulation', 'mpm_particles_per_failed_element', 'convert_failed_elements_to_mpm', 
        'material_heterogeneity', 'debris_velocity_smoothing', 'debris_clumping', 'debris_max_clump_size', 
        'random_seed', 'k_file'
    ];
    if (femOnlyKeys.includes(key)) return 'FEM';

    const fvOnlyKeys = [
        'atm_pressure', 'atm_temperature', 'gamma',
        'composition', 'rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega',
        'ideal_gamma', 'ideal_rho_0', 'ideal_e_0', 'material_type'
    ];
    if (fvOnlyKeys.includes(key)) return 'FV';

    const mpmFvKeys = [
        'davis_c0', 'davis_s1', 'davis_gamma0', 'davis_cv', 'davis_t0', 'davis_rho0',
        'davis_a', 'davis_b', 'davis_k', 'davis_vc', 'davis_pc', 'davis_q_det',
        'crest_b1', 'crest_c1', 'crest_m1', 'crest_b2', 'crest_c2', 'crest_c3', 'crest_m2', 'crest_s0', 'crest_s_threshold'
    ];
    if (mpmFvKeys.includes(key)) return 'MPM+FV';

    const mpmFemKeys = [
        'density', 'youngs_modulus', 'poissons_ratio', 'yield_stress', 'hardening_modulus',
        'failure_strain', 'tensile_failure_stress', 'directional_crack_band', 'nonlocal_radius',
        'enable_strain_erosion', 'erosion_strain', 'enable_stress_erosion', 'erosion_stress',
        'jc_A', 'jc_B', 'jc_n', 'jc_C', 'jc_m', 'T_melt', 'T_room', 'Cp',
        'jc_d1', 'jc_d2', 'jc_d3', 'jc_d4', 'jc_d5',
        'mg_gamma0', 'mg_c0', 'mg_s',
        'fc', 'ft', 'G_f', 'moisture_content', 'dif_cap_compression', 'dif_cap_tension',
        'rht_A', 'rht_N', 'rht_B', 'rht_M', 'rht_Q0', 'rht_BQ', 'rht_D1', 'rht_D2',
        'rht_p_crush', 'rht_p_lock', 'rht_alpha0', 'rht_n_comp', 'rht_betac', 'rht_deltat',
        'kc_auto_generate', 'kc_a0', 'kc_a1', 'kc_a2', 'kc_a0y', 'kc_a1y', 'kc_a2y', 'kc_a1r', 'kc_a2r', 'kc_b1', 'kc_omega',
        'cscm_alpha', 'cscm_theta', 'cscm_lambda', 'cscm_beta', 'cscm_R', 'cscm_X0', 'cscm_W', 'cscm_D1', 'cscm_D2'
    ];
    if (mpmFemKeys.includes(key)) return 'MPM+FEM';

    if (key === 'material_model' || key === 'preset') return 'ALL';

    return 'ALL';
}

export function getSolverBadgeHTML(scope: SolverScope, compact = false): string {
    let cls = 'solver-badge-all';
    let text = 'ALL';
    let title = 'Universal parameter: active across all physics engines';

    if (scope === 'MPM') {
        cls = 'solver-badge-mpm';
        text = compact ? 'MPM' : 'MPM ONLY';
        title = 'Material Point Method ONLY (Particle Continuum)';
    } else if (scope === 'FEM') {
        cls = 'solver-badge-fem';
        text = compact ? 'FEM' : 'FEM ONLY';
        title = 'Finite Element Method ONLY (Solid Elements)';
    } else if (scope === 'FV') {
        cls = 'solver-badge-fv';
        text = compact ? 'FV' : 'FV ONLY';
        title = 'Finite Volume CFD ONLY (Eulerian Fluid / Gas / JWL)';
    } else if (scope === 'MPM+FEM') {
        cls = 'solver-badge-mpm-fem';
        text = compact ? 'MPM·FEM' : 'MPM · FEM';
        title = 'Shared: MPM Particle Continuum & FEM Solid Elements';
    } else if (scope === 'MPM+FV') {
        cls = 'solver-badge-mpm-fv';
        text = compact ? 'MPM·FV' : 'MPM · FV';
        title = 'Shared: MPM Particle Reactive Burn & FV Eulerian Reactive CFD';
    }

    return `<span class="solver-scope-badge ${cls}" title="${title}">${text}</span>`;
}

export function getParameterInfo(key: string, nodeType?: string): ParameterDefinition {
    const scope = getSolverScope(key, nodeType);

    if (PARAMETER_DEFINITIONS[key]) {
        const def = PARAMETER_DEFINITIONS[key];
        return {
            ...def,
            solverScope: def.solverScope || scope
        };
    }
    
    // Format fallback for uncatalogued or custom keys
    const formattedLabel = key
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

    return {
        key: key,
        label: formattedLabel,
        category: 'General Parameter',
        solverScope: scope,
        shortDesc: `Parameter ${formattedLabel} for ${nodeType || 'node'}`,
        detailedDesc: `Configuration property "${key}" controlling simulation behavior in ${nodeType || 'this node'}.`
    };
}

export function getNodeDefinition(nodeType: string): NodeDefinition {
    if (NODE_DEFINITIONS[nodeType]) {
        return NODE_DEFINITIONS[nodeType];
    }

    return {
        type: nodeType,
        title: nodeType,
        category: 'Simulation Node',
        shortDesc: `Simulation graph node (${nodeType})`,
        fullDescHtml: `
            <div class="node-doc-section">
                <div class="node-doc-heading">${nodeType}</div>
                <p>Standard computation graph node of type <strong>${nodeType}</strong> in the BlastDemon multi-physics framework.</p>
            </div>
        `
    };
}

export function getNodeDescription(nodeType: string): string {
    const def = getNodeDefinition(nodeType);
    return def.shortDesc;
}

// Active Popover Global Reference
let activePopoverEl: HTMLElement | null = null;
let activePopoverTriggerEl: HTMLElement | null = null;
let popoverTimeoutId: any = null;

export function closeActiveParameterPopover(): void {
    if (popoverTimeoutId) {
        clearTimeout(popoverTimeoutId);
        popoverTimeoutId = null;
    }
    if (activePopoverEl) {
        activePopoverEl.remove();
        activePopoverEl = null;
        activePopoverTriggerEl = null;
    }
}

export function showParameterPopover(
    targetEl: HTMLElement,
    key: string,
    nodeType?: string,
    event?: MouseEvent
): void {
    // If popover for this same element is already open, do nothing
    if (activePopoverTriggerEl === targetEl && activePopoverEl) {
        return;
    }
    closeActiveParameterPopover();

    const info = getParameterInfo(key, nodeType);
    const scope = info.solverScope || getSolverScope(key, nodeType);
    const badgeHTML = getSolverBadgeHTML(scope, false);

    let scopeDesc = 'Universal parameter: evaluated across all active solvers.';
    if (scope === 'MPM') scopeDesc = 'Active strictly for Material Point Method (MPM) particle continuum dynamics.';
    else if (scope === 'FEM') scopeDesc = 'Active strictly for Finite Element Method (FEM) Lagrangian structural elements.';
    else if (scope === 'FV') scopeDesc = 'Active strictly for Finite Volume (FV) Eulerian fluid / blast gas dynamics.';
    else if (scope === 'MPM+FEM') scopeDesc = 'Shared solid mechanics formulation: active for both MPM particles and FEM hex elements.';
    else if (scope === 'MPM+FV') scopeDesc = 'Shared reactive burn formulation: active for both MPM particles and FV Eulerian explosive dynamics.';

    const popover = document.createElement('div');
    popover.className = 'param-popover';
    popover.style.position = 'fixed';
    popover.style.zIndex = '999999';

    popover.innerHTML = `
        <div class="param-popover-header">
            <div class="param-popover-title-row">
                <span class="param-popover-title">${info.label}</span>
                ${info.unit && info.unit !== 'dim' ? `<span class="param-popover-unit">${info.unit}</span>` : ''}
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;">
                ${info.category ? `<div class="param-popover-category">${info.category}</div>` : '<div></div>'}
                ${badgeHTML}
            </div>
        </div>
        <div class="param-popover-body">
            <div class="param-popover-scope-row">
                <span class="param-popover-scope-label">Solver Scope:</span>
                <span style="font-size:9.5px; color:#ddd;">${scopeDesc}</span>
            </div>
            <div class="param-popover-short">${info.shortDesc}</div>
            <div class="param-popover-details">${info.detailedDesc}</div>
        </div>
    `;

    document.body.appendChild(popover);
    activePopoverEl = popover;
    activePopoverTriggerEl = targetEl;

    // Positioning
    const targetRect = targetEl.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    const padding = 10;

    let left = targetRect.right + 10;
    let top = targetRect.top - 5;

    // If overflowing right of screen, position to the left of target
    if (left + popRect.width > window.innerWidth - padding) {
        left = targetRect.left - popRect.width - 10;
    }
    // If overflowing left, clamp
    if (left < padding) {
        left = padding;
    }
    // If overflowing bottom, clamp upward
    if (top + popRect.height > window.innerHeight - padding) {
        top = window.innerHeight - padding - popRect.height;
    }
    if (top < padding) {
        top = padding;
    }

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;

    // Close listener on mouse leave
    const cleanup = () => {
        closeActiveParameterPopover();
    };

    targetEl.addEventListener('mouseleave', () => {
        popoverTimeoutId = setTimeout(cleanup, 250);
    }, { once: true });

    popover.addEventListener('mouseenter', () => {
        if (popoverTimeoutId) {
            clearTimeout(popoverTimeoutId);
            popoverTimeoutId = null;
        }
    });

    popover.addEventListener('mouseleave', () => {
        closeActiveParameterPopover();
    }, { once: true });
}

export function showNodeDetailsModal(nodeType: string, customTitle?: string): void {
    const existing = document.querySelector('.node-modal-backdrop');
    if (existing) existing.remove();

    const def = getNodeDefinition(nodeType);

    const backdrop = document.createElement('div');
    backdrop.className = 'node-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'node-modal-dialog';

    modal.innerHTML = `
        <div class="node-modal-header">
            <div class="node-modal-title-group">
                <div class="node-modal-title">${customTitle || def.title}</div>
                <div class="node-modal-category">${def.category}</div>
            </div>
            <button class="node-modal-close" title="Close">✕</button>
        </div>
        <div class="node-modal-body">
            ${def.fullDescHtml}
        </div>
    `;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const closeBtn = modal.querySelector('.node-modal-close') as HTMLElement;
    closeBtn?.addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.remove();
    });

    const keyListener = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            backdrop.remove();
            document.removeEventListener('keydown', keyListener);
        }
    };
    document.addEventListener('keydown', keyListener);
}

// ============================================================================
// 4. SSOT PARAMETER KEYS, GATING & SECTION ACCORDIONS
// ============================================================================

export interface NodeSectionInfo {
    title: string;
    color: string;
    defaultCollapsed: boolean;
}

export function getParamKeysForNode(
    nodeType: string,
    parameters: Record<string, any>,
    is3D: boolean = false,
    isCoupled: boolean = false
): string[] {
    let keys: string[] = [];

    if (nodeType === 'Material') {
        const matModel = parameters['material_model'] || 'Hypoelastic';
        if (matModel === 'Ideal Gas') {
            keys = ['material_model', 'preset', 'atm_pressure', 'atm_temperature', 'gamma', 'density'];
        } else if (matModel === 'JWL Detonation Gas') {
            keys = ['material_model', 'preset', 'rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'];
        } else if (matModel === 'Ideal Gas Charge') {
            keys = ['material_model', 'preset', 'ideal_rho_0', 'ideal_e_0', 'ideal_gamma'];
        } else if (matModel === 'Linear Elastic') {
            keys = [
                'material_model', 'preset', 'transfer_scheme',
                'density', 'youngs_modulus', 'poissons_ratio',
                'tensile_failure_stress',
                'enable_heterogeneity', 'weibull_modulus', 'weibull_scale', 'fracture_toughness', 'debris_bulk_factor',
                'enable_anisotropy', 'anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z',
                'dem_transition_enabled', 'fragment_distribution', 'fragment_min_size', 'fragment_max_size', 'fragment_weibull_n', 'fragment_clumping_radius', 'fragment_ejection_jitter', 'fragment_contact_friction', 'fragment_restitution'
            ];
        } else if (matModel === 'Johnson-Cook + Mie-Grüneisen') {
            keys = [
                'material_model', 'preset', 'transfer_scheme',
                'density', 'youngs_modulus', 'poissons_ratio',
                'failure_strain', 'tensile_failure_stress',
                'jc_A', 'jc_B', 'jc_n', 'jc_C', 'jc_m',
                'jc_d1', 'jc_d2', 'jc_d3', 'jc_d4', 'jc_d5',
                'T_melt', 'T_room', 'Cp',
                'mg_gamma0', 'mg_c0', 'mg_s',
                'enable_strain_erosion', 'erosion_strain',
                'enable_stress_erosion', 'erosion_stress',
                'enable_timestep_erosion', 'timestep_erosion_factor',
                'enable_heterogeneity', 'weibull_modulus', 'weibull_scale', 'fracture_toughness', 'debris_bulk_factor',
                'enable_anisotropy', 'anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z',
                'dem_transition_enabled', 'fragment_distribution', 'fragment_min_size', 'fragment_max_size', 'fragment_weibull_n', 'fragment_clumping_radius', 'fragment_ejection_jitter', 'fragment_contact_friction', 'fragment_restitution'
            ];
        } else if (matModel === 'CREST Reactive Burn') {
            keys = [
                'material_model', 'preset', 'transfer_scheme',
                'density', 'youngs_modulus', 'poissons_ratio',
                'yield_stress', 'hardening_modulus',
                'failure_strain', 'tensile_failure_stress',
                'davis_c0', 'davis_s1', 'davis_gamma0', 'davis_cv', 'davis_t0', 'davis_rho0',
                'davis_a', 'davis_b', 'davis_k', 'davis_vc', 'davis_pc', 'davis_q_det',
                'crest_b1', 'crest_c1', 'crest_m1', 'crest_b2', 'crest_c2', 'crest_c3', 'crest_m2', 'crest_s0', 'crest_s_threshold',
                'enable_heterogeneity', 'weibull_modulus', 'weibull_scale', 'fracture_toughness', 'debris_bulk_factor',
                'enable_anisotropy', 'anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z'
            ];
        } else if (matModel === 'RHT Concrete') {
            keys = [
                'material_model', 'preset', 'transfer_scheme',
                'density', 'youngs_modulus', 'poissons_ratio',
                'fc', 'ft', 'G_f', 'moisture_content', 'dif_cap_compression', 'dif_cap_tension',
                'directional_crack_band', 'nonlocal_radius',
                'failure_strain', 'tensile_failure_stress',
                'rht_A', 'rht_N', 'rht_B', 'rht_M', 'rht_Q0', 'rht_BQ', 'rht_D1', 'rht_D2',
                'rht_p_crush', 'rht_p_lock', 'rht_alpha0', 'rht_n_comp', 'rht_betac', 'rht_deltat',
                'enable_strain_erosion', 'erosion_strain',
                'enable_stress_erosion', 'erosion_stress',
                'enable_timestep_erosion', 'timestep_erosion_factor',
                'enable_heterogeneity', 'weibull_modulus', 'weibull_scale', 'fracture_toughness', 'debris_bulk_factor',
                'enable_anisotropy', 'anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z',
                'dem_transition_enabled', 'fragment_distribution', 'fragment_min_size', 'fragment_max_size', 'fragment_weibull_n', 'fragment_clumping_radius', 'fragment_ejection_jitter', 'fragment_contact_friction', 'fragment_restitution'
            ];
        } else if (matModel === 'Karagozian & Case (K&C)' || matModel === 'Karagozian & Case') {
            keys = [
                'material_model', 'preset', 'transfer_scheme',
                'density', 'youngs_modulus', 'poissons_ratio',
                'fc', 'ft', 'G_f', 'moisture_content', 'dif_cap_compression', 'dif_cap_tension',
                'directional_crack_band', 'nonlocal_radius',
                'failure_strain', 'tensile_failure_stress',
                'kc_auto_generate', 'kc_a0', 'kc_a1', 'kc_a2', 'kc_a0y', 'kc_a1y', 'kc_a2y', 'kc_a1r', 'kc_a2r', 'kc_b1', 'kc_omega',
                'enable_strain_erosion', 'erosion_strain',
                'enable_stress_erosion', 'erosion_stress',
                'enable_timestep_erosion', 'timestep_erosion_factor',
                'enable_heterogeneity', 'weibull_modulus', 'weibull_scale', 'fracture_toughness', 'debris_bulk_factor',
                'enable_anisotropy', 'anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z',
                'dem_transition_enabled', 'fragment_distribution', 'fragment_min_size', 'fragment_max_size', 'fragment_weibull_n', 'fragment_clumping_radius', 'fragment_ejection_jitter', 'fragment_contact_friction', 'fragment_restitution'
            ];
        } else if (matModel === 'CSCM Concrete') {
            keys = [
                'material_model', 'preset', 'transfer_scheme',
                'density', 'youngs_modulus', 'poissons_ratio',
                'fc', 'ft', 'G_f', 'moisture_content', 'dif_cap_compression', 'dif_cap_tension',
                'directional_crack_band', 'nonlocal_radius',
                'failure_strain', 'tensile_failure_stress',
                'cscm_alpha', 'cscm_theta', 'cscm_lambda', 'cscm_beta', 'cscm_R', 'cscm_X0', 'cscm_W', 'cscm_D1', 'cscm_D2',
                'enable_strain_erosion', 'erosion_strain',
                'enable_stress_erosion', 'erosion_stress',
                'enable_timestep_erosion', 'timestep_erosion_factor',
                'enable_heterogeneity', 'weibull_modulus', 'weibull_scale', 'fracture_toughness', 'debris_bulk_factor',
                'enable_anisotropy', 'anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z',
                'dem_transition_enabled', 'fragment_distribution', 'fragment_min_size', 'fragment_max_size', 'fragment_weibull_n', 'fragment_clumping_radius', 'fragment_ejection_jitter', 'fragment_contact_friction', 'fragment_restitution'
            ];
        } else {
            // Default Hypoelastic
            keys = [
                'material_model', 'preset', 'transfer_scheme',
                'density', 'youngs_modulus', 'poissons_ratio',
                'yield_stress', 'hardening_modulus',
                'failure_strain', 'tensile_failure_stress',
                'directional_crack_band', 'nonlocal_radius',
                'enable_strain_erosion', 'erosion_strain',
                'enable_stress_erosion', 'erosion_stress',
                'enable_timestep_erosion', 'timestep_erosion_factor',
                'enable_heterogeneity', 'weibull_modulus', 'weibull_scale', 'fracture_toughness', 'debris_bulk_factor',
                'enable_anisotropy', 'anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z',
                'dem_transition_enabled', 'fragment_distribution', 'fragment_min_size', 'fragment_max_size', 'fragment_weibull_n', 'fragment_clumping_radius', 'fragment_ejection_jitter', 'fragment_contact_friction', 'fragment_restitution'
            ];
        }
    } else if (nodeType === 'DomainMesh') {
        keys = ['dimension', 'domain_radius', 'cell_size', 'left_bc', 'right_bc'];
    } else if (nodeType === 'DomainMesh2D') {
        const isAxisym = parameters['coordinate_system'] === 'Axisymmetric';
        keys = isAxisym
            ? ['coordinate_system', 'min_r', 'max_r', 'min_z', 'max_z', 'cell_size', 'nx', 'ny', 'bc_r_min', 'bc_r_max', 'bc_y_min', 'bc_y_max']
            : ['coordinate_system', 'xmin', 'xmax', 'ymin', 'ymax', 'cell_size', 'nx', 'ny', 'bc_x_min', 'bc_x_max', 'bc_y_min', 'bc_y_max'];
    } else if (nodeType === 'DomainMesh3D') {
        keys = ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax', 'cell_size', 'nx', 'ny', 'nz', 'bc_x_min', 'bc_x_max', 'bc_y_min', 'bc_y_max', 'bc_z_min', 'bc_z_max'];
    } else if (nodeType === 'Charge1D') {
        keys = ['material', 'charge_mass', 'charge_radius'];
    } else if (nodeType === 'Charge2D') {
        keys = ['material', 'charge_mass', 'charge_shape', 'charge_r', 'charge_z', 'charge_radius', 'charge_height', 'charge_aspect_ratio'];
    } else if (nodeType === 'Charge3D') {
        keys = ['material', 'charge_mass', 'charge_shape', 'charge_x', 'charge_y', 'charge_z', 'charge_radius', 'charge_height', 'charge_lx', 'charge_ly', 'charge_lz', 'charge_rot_x', 'charge_rot_y', 'charge_rot_z'];
    } else if (nodeType === 'DetonatorLocation') {
        keys = ['detonator_r', 'detonator_z', 'detonator_radius'];
    } else if (nodeType === 'DetonatorLocation3D') {
        keys = ['detonator_x', 'detonator_y', 'detonator_z', 'detonator_radius'];
    } else if (nodeType === 'CFDSolver3D') {
        keys = ['device', 'precision', 'init_mode', 'space_time_scheme', 'flux_scheme', 'cfl', 'endtime', 'plot_stride', 'refresh_rate'];
    } else if (nodeType === 'CFDSolver2D' || nodeType === 'CFDSolver') {
        keys = ['init_mode', 'space_time_scheme', 'flux_scheme', 'cfl', 'endtime', 'plot_stride', 'refresh_rate'];
    } else if (nodeType === 'MPMDomain3D') {
        keys = ['device', 'precision', 'particle_distribution', 'boundary_filling', 'ppc', 'velocity_scheme', 'flip_blend', 'space_time_scheme', 'smooth_plastic_strain', 'cfl', 'endtime'];
    } else if (nodeType === 'MPMDomain2D') {
        keys = ['precision', 'particle_distribution', 'boundary_filling', 'ppc', 'velocity_scheme', 'flip_blend', 'space_time_scheme', 'smooth_plastic_strain', 'cfl', 'endtime'];
    } else if (nodeType === 'MPMObject2D') {
        keys = ['material', 'shape_type', 'particle_distribution', 'boundary_filling', 'pos_x', 'pos_y', 'size_x', 'size_y', 'radius', 'vel_x', 'vel_y', 'angular_vel'];
    } else if (nodeType === 'MPMObject3D') {
        keys = ['material', 'shape_type', 'particle_distribution', 'boundary_filling', 'pos_x', 'pos_y', 'pos_z', 'size_x', 'size_y', 'size_z', 'radius', 'inner_radius', 'height', 'stl_file', 'scale_x', 'scale_y', 'scale_z', 'vel_x', 'vel_y', 'vel_z', 'angular_vel_x', 'angular_vel_y', 'angular_vel_z'];
    } else if (nodeType === 'FEMDomain3D') {
        keys = [
            'device', 'precision', 'cfl', 'endtime',
            'integration_scheme', 'hourglass_model', 'hourglass_coeff',
            'enable_directional_crack_band', 'enable_nonlocal_damage',
            'rebar_formulation', 'convert_failed_elements_to_mpm', 'mpm_particles_per_failed_element',
            'contact_penalty_scale', 'friction_static', 'friction_kinetic',
            'enable_heterogeneity', 'material_heterogeneity', 'debris_velocity_smoothing', 'debris_clumping', 'debris_max_clump_size', 'random_seed',
            'enable_anisotropy', 'anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z'
        ];
    } else if (nodeType === 'FEMObject3D') {
        keys = [
            'material', 'mesh_source', 'boundary_condition',
            'pos_x', 'pos_y', 'pos_z', 'size_x', 'size_y', 'size_z',
            'radius', 'inner_radius', 'height', 'nx', 'ny', 'nz',
            'k_file', 'scale_x', 'scale_y', 'scale_z',
            'vel_x', 'vel_y', 'vel_z', 'bulk_viscosity_b1', 'bulk_viscosity_b2', 'timestep_erosion_factor'
        ];
    } else if (nodeType === 'FEMFSICoupler3D') {
        keys = ['cfl', 'endtime', 'steps', 'coupling_scheme', 'pressure_integration', 'uncovering_method', 'erosion_venting', 'vacuum_density', 'vacuum_pressure'];
    } else if (nodeType === 'FSICoupler2D' || nodeType === 'FSICoupler3D') {
        keys = ['cfl', 'endtime'];
    } else if (nodeType === 'VTKOutput') {
        keys = [
            'trigger_type', 'step_interval', 'time_interval', 'vtk_format', 'custom_filename', 'vtk_dir',
            'export_cfd_2d', 'export_slices', 'export_volumes', 'export_obstacles', 'export_stl_faces', 'stl_outside_domain', 'tessellate_stl_faces', 'tessellation_max_edge', 'export_fem', 'export_mpm', 'export_pvd',
            'qty_pressure', 'qty_density', 'qty_velocity', 'qty_energy', 'qty_reacted', 'qty_unreacted', 'qty_air', 'qty_overpressure', 'qty_impulse',
            'qty_fem_stress', 'qty_fem_strain', 'qty_fem_pressure', 'qty_fem_temp', 'qty_fem_damage', 'qty_fem_vel', 'qty_fem_disp',
            'qty_mpm_stress', 'qty_mpm_strain', 'qty_mpm_damage', 'qty_mpm_temp', 'qty_mpm_vel', 'qty_mpm_disp',
            'roi_enabled', 'roi_xmin', 'roi_xmax', 'roi_ymin', 'roi_ymax', 'roi_zmin', 'roi_zmax', 'volume_stride', 'slice_stride'
        ];
    } else if (nodeType === 'STLGeometry') {
        keys = ['stl_file', 'scale_x', 'scale_y', 'scale_z', 'center_x', 'center_y', 'center_z', 'voxelization_method'];
    } else if (nodeType === 'LSDynaImporter3D') {
        keys = ['k_file', 'scale_factor'];
    } else if (nodeType === 'RemapNode' || nodeType === 'Remap1DTo2DNode' || nodeType === 'Remap1DTo3DNode' || nodeType === 'Remap2DTo3DNode') {
        keys = ['remap_radius', 'trigger_val'];
    } else if (nodeType === 'VirtualGauges') {
        keys = ['enable_gauges', 'telemetry_mode', 'refresh_rate'];
    } else if (nodeType === 'TelemetryText') {
        keys = [
            'stream_layout', 'filter_level', 'timestamp_mode',
            'show_timing_breakdown', 'show_memory', 'show_wallclock', 'show_dt',
            'font_size', 'buffer_capacity'
        ];
    } else {
        keys = Object.keys(parameters).filter(k => k !== 'spatial_order' && k !== 'temporal_order' && k !== 'gauges' && k !== 'slices' && k !== 'primitives');
    }

    if (isCoupled && (nodeType === 'CFDSolver' || nodeType === 'CFDSolver2D' || nodeType === 'CFDSolver3D' || nodeType === 'MPMDomain2D' || nodeType === 'MPMDomain3D' || nodeType === 'FEMDomain3D')) {
        keys = keys.filter(k => k !== 'cfl' && k !== 'endtime');
    }

    return keys;
}

export function shouldSkipNodeParameter(
    key: string,
    nodeType: string,
    parameters: Record<string, any>,
    is3D: boolean = false
): boolean {
    if (key === 'gauges' || key === 'slices' || key === 'primitives' || key === 'nr' || key === 'n_cells' || key === 'nz') {
        if (nodeType !== 'DomainMesh3D' && nodeType !== 'FEMObject3D') {
            return true;
        }
    }
    if (nodeType === 'VirtualGauges' && key === 'telemetry_channel') return true;

    if (nodeType === 'Material') {
        if (key === 'erosion_strain' && !parameters['enable_strain_erosion']) return true;
        if (key === 'erosion_stress' && !parameters['enable_stress_erosion']) return true;
        if (key === 'timestep_erosion_factor' && !parameters['enable_timestep_erosion']) return true;
        if (key === 'nonlocal_radius' && !parameters['directional_crack_band']) return true;
        if ((key === 'weibull_modulus' || key === 'weibull_scale' || key === 'fracture_toughness' || key === 'debris_bulk_factor') && !parameters['enable_heterogeneity']) return true;
        if ((key === 'anisotropy_ratio' || key === 'anisotropy_axis' || key === 'anisotropy_dir_x' || key === 'anisotropy_dir_y' || key === 'anisotropy_dir_z') && !parameters['enable_anisotropy']) return true;
        if ((key === 'anisotropy_dir_x' || key === 'anisotropy_dir_y' || key === 'anisotropy_dir_z') && parameters['anisotropy_axis'] !== 'Custom') return true;
        if (['kc_a0', 'kc_a1', 'kc_a2', 'kc_a0y', 'kc_a1y', 'kc_a2y', 'kc_a1r', 'kc_a2r', 'kc_b1', 'kc_omega'].includes(key) && parameters['kc_auto_generate'] !== false) return true;
        if (['fragment_distribution', 'fragment_min_size', 'fragment_max_size', 'fragment_weibull_n', 'fragment_clumping_radius', 'fragment_ejection_jitter', 'fragment_contact_friction', 'fragment_restitution'].includes(key) && !parameters['dem_transition_enabled']) return true;
    } else if (nodeType === 'Charge2D' || nodeType === 'Charge1D') {
        const shape = parameters['charge_shape'] || 'Sphere';
        if ((key === 'charge_height' || key === 'charge_aspect_ratio') && shape !== 'Cylinder') return true;
    } else if (nodeType === 'Charge3D') {
        const shape = parameters['charge_shape'] || 'Sphere';
        if (shape === 'Sphere') {
            if (['charge_height', 'charge_aspect_ratio', 'charge_lx', 'charge_ly', 'charge_lz', 'charge_rot_x', 'charge_rot_y', 'charge_rot_z'].includes(key)) return true;
        } else if (shape === 'Cylinder') {
            if (['charge_lx', 'charge_ly', 'charge_lz'].includes(key)) return true;
        } else if (shape === 'Block') {
            if (['charge_radius', 'charge_height', 'charge_aspect_ratio'].includes(key)) return true;
        }
    } else if (nodeType === 'MPMDomain2D' || nodeType === 'MPMDomain3D') {
        if (key === 'flip_blend' && parameters['velocity_scheme'] !== 'FLIP') return true;
    } else if (nodeType === 'MPMObject2D') {
        const shape = parameters['shape_type'] || 'Rectangle';
        if (shape === 'Rectangle' && key === 'radius') return true;
        if (shape === 'Circle' && (key === 'size_x' || key === 'size_y')) return true;
    } else if (nodeType === 'MPMObject3D') {
        const shape = parameters['shape_type'] || 'Box';
        if (shape === 'Box') {
            if (['radius', 'inner_radius', 'height', 'stl_file', 'scale_x', 'scale_y', 'scale_z'].includes(key)) return true;
        } else if (shape === 'Sphere') {
            if (['size_x', 'size_y', 'size_z', 'inner_radius', 'height', 'stl_file', 'scale_x', 'scale_y', 'scale_z'].includes(key)) return true;
        } else if (shape === 'Cylinder') {
            if (['size_x', 'size_y', 'size_z', 'stl_file', 'scale_x', 'scale_y', 'scale_z'].includes(key)) return true;
        } else if (shape === 'STL') {
            if (['size_x', 'size_y', 'size_z', 'radius', 'inner_radius', 'height'].includes(key)) return true;
        }
    } else if (nodeType === 'FEMDomain3D') {
        const scheme = parameters['integration_scheme'] || 'OnePointFB';
        if ((scheme === 'FullGauss8' || scheme === 'SelectiveReduced') && (key === 'hourglass_model' || key === 'hourglass_coeff')) return true;
        if (key === 'mpm_particles_per_failed_element' && !parameters['convert_failed_elements_to_mpm']) return true;
        if (['material_heterogeneity', 'debris_velocity_smoothing', 'debris_clumping', 'debris_max_clump_size'].includes(key) && !parameters['enable_heterogeneity']) return true;
        if (['anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z'].includes(key) && !parameters['enable_anisotropy']) return true;
        if (['anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z'].includes(key) && parameters['anisotropy_axis'] !== 'Custom') return true;
    } else if (nodeType === 'FEMObject3D') {
        const source = parameters['mesh_source'] || 'Box Generator';
        if (source === 'Box Generator') {
            if (['radius', 'inner_radius', 'height', 'k_file', 'scale_x', 'scale_y', 'scale_z'].includes(key)) return true;
        } else if (source === 'Cylinder Generator') {
            if (['size_x', 'size_y', 'size_z', 'ny', 'k_file', 'scale_x', 'scale_y', 'scale_z'].includes(key)) return true;
        } else if (source === 'LS-DYNA Keyword File') {
            if (['size_x', 'size_y', 'size_z', 'radius', 'inner_radius', 'height', 'nx', 'ny', 'nz'].includes(key)) return true;
        }
    } else if (nodeType === 'FEMFSICoupler3D') {
        if ((key === 'vacuum_density' || key === 'vacuum_pressure') && !parameters['erosion_venting']) return true;
    } else if (nodeType === 'VTKOutput') {
        const triggerType = parameters['trigger_type'] || 'Step Interval';
        if ((triggerType === 'Step Interval' || triggerType === 'step') && key === 'time_interval') return true;
        if ((triggerType === 'Time Interval' || triggerType === 'time') && key === 'step_interval') return true;
        if (!is3D && (
            key === 'export_slices' || key === 'export_volumes' || key === 'export_obstacles' || key === 'export_stl_faces' || key === 'stl_outside_domain' || key === 'tessellate_stl_faces' || key === 'tessellation_max_edge' || key === 'export_fem' || key === 'export_mpm' ||
            key.startsWith('qty_fem_') || key.startsWith('qty_mpm_') ||
            key.startsWith('roi_') || key === 'volume_stride' || key === 'slice_stride'
        )) return true;
        if (is3D && key === 'export_cfd_2d') return true;
        if ((key === 'stl_outside_domain' || key === 'tessellate_stl_faces') && parameters['export_stl_faces'] === false) return true;
        if (key === 'tessellation_max_edge' && (!parameters['export_stl_faces'] || !parameters['tessellate_stl_faces'])) return true;
        if (['roi_xmin', 'roi_xmax', 'roi_ymin', 'roi_ymax', 'roi_zmin', 'roi_zmax', 'volume_stride', 'slice_stride'].includes(key) && !parameters['roi_enabled']) return true;
    } else if (nodeType === 'DomainMesh') {
        const dim = parameters['dimension'] || '1D';
        if ((key === 'y_min_bc' || key === 'y_max_bc' || key === 'z_min_bc' || key === 'z_max_bc') && dim === '1D') return true;
    }

    return false;
}

export function getNodeSectionInfo(
    key: string,
    nodeType: string,
    parameters: Record<string, any>,
    is3D: boolean = false
): NodeSectionInfo | null {
    if (nodeType === 'Material') {
        if (key === 'transfer_scheme') return { title: 'MPM TRANSFER SCHEME [MPM ONLY]', color: '#c084fc', defaultCollapsed: false };
        if (key === 'atm_pressure') return { title: 'AMBIENT THERMODYNAMICS [FV ONLY]', color: '#fbbf24', defaultCollapsed: false };
        if (key === 'rho') return { title: 'JWL DETONATION STATE [FV ONLY]', color: '#fbbf24', defaultCollapsed: false };
        if (key === 'jwl_A') return { title: 'JWL EQUATION OF STATE [FV ONLY]', color: '#fbbf24', defaultCollapsed: false };
        if (key === 'ideal_rho_0') return { title: 'IDEAL GAS BLAST CHARGE [FV ONLY]', color: '#fbbf24', defaultCollapsed: false };
        if (key === 'density') return { title: 'ELASTICITY & MASS [MPM · FEM]', color: '#60a5fa', defaultCollapsed: false };
        if (key === 'yield_stress') return { title: 'PLASTIC YIELD & HARDENING [MPM · FEM]', color: '#60a5fa', defaultCollapsed: false };
        if (key === 'fc') return { title: 'CONCRETE CORE & FRACTURE [MPM · FEM]', color: '#60a5fa', defaultCollapsed: false };
        if (key === 'failure_strain' || (key === 'tensile_failure_stress' && parameters['material_model'] === 'Linear Elastic')) {
            return { title: 'CONSTITUTIVE FAILURE & SPALL [MPM · FEM]', color: '#60a5fa', defaultCollapsed: false };
        }
        if (key === 'jc_A') return { title: 'JOHNSON-COOK VISCOPLASTICITY [MPM · FEM]', color: '#60a5fa', defaultCollapsed: false };
        if (key === 'mg_gamma0') return { title: 'MIE-GRÜNEISEN SHOCK EOS [MPM · FEM]', color: '#60a5fa', defaultCollapsed: true };
        if (key === 'davis_c0') return { title: 'DAVIS SOLID REACTANT EOS [MPM · FV]', color: '#22d3ee', defaultCollapsed: true };
        if (key === 'davis_a') return { title: 'DAVIS DETONATION PRODUCT EOS [MPM · FV]', color: '#22d3ee', defaultCollapsed: true };
        if (key === 'crest_b1') return { title: 'CREST REACTION KINETICS [MPM · FV]', color: '#22d3ee', defaultCollapsed: true };
        if (key === 'rht_A') return { title: 'RHT ENVELOPES & POROUS EOS [MPM · FEM]', color: '#60a5fa', defaultCollapsed: true };
        if (key === 'kc_auto_generate' || key === 'kc_a0') return { title: 'K&C DAMAGE PLASTICITY [MPM · FEM]', color: '#60a5fa', defaultCollapsed: true };
        if (key === 'cscm_alpha') return { title: 'CSCM SMOOTH CAP & DAMAGE [MPM · FEM]', color: '#60a5fa', defaultCollapsed: true };
        if (key === 'enable_strain_erosion') return { title: 'ELEMENT & PARTICLE EROSION [FEM · MPM]', color: '#f59e0b', defaultCollapsed: true };
        if (key === 'enable_heterogeneity') return { title: 'WEIBULL HETEROGENEITY [MPM · FEM]', color: '#c084fc', defaultCollapsed: true };
        if (key === 'enable_anisotropy') return { title: 'DIRECTIONAL ANISOTROPY [MPM · FEM]', color: '#38bdf8', defaultCollapsed: true };
        if (key === 'dem_transition_enabled') return { title: 'STATISTICAL FRAGMENTATION & DEM [MPM]', color: '#f43f5e', defaultCollapsed: true };
    } else if (nodeType === 'DomainMesh' || nodeType === 'DomainMesh2D' || nodeType === 'DomainMesh3D') {
        if (key === 'cell_size' || key === 'nx') return { title: 'GRID RESOLUTION', color: '#569cd6', defaultCollapsed: false };
        if (key === 'left_bc' || key === 'bc_x_min' || key === 'bc_r_min' || key === 'x_min_bc') return { title: 'BOUNDARY CONDITIONS', color: '#569cd6', defaultCollapsed: true };
    } else if (nodeType === 'Charge1D' || nodeType === 'Charge2D' || nodeType === 'Charge3D') {
        if (key === 'charge_r' || key === 'charge_x' || key === 'charge_radius') return { title: 'GEOMETRY & POSITIONING', color: '#fbbf24', defaultCollapsed: false };
    } else if (nodeType === 'CFDSolver' || nodeType === 'CFDSolver2D' || nodeType === 'CFDSolver3D') {
        if (key === 'space_time_scheme') return { title: 'NUMERICAL INTEGRATION', color: '#569cd6', defaultCollapsed: false };
        if (key === 'plot_stride') return { title: 'TELEMETRY & REFRESH', color: '#569cd6', defaultCollapsed: true };
    } else if (nodeType === 'MPMDomain2D' || nodeType === 'MPMDomain3D') {
        if (key === 'particle_distribution') return { title: 'PARTICLE DISCRETIZATION', color: '#c084fc', defaultCollapsed: false };
        if (key === 'velocity_scheme') return { title: 'KINEMATICS & TIME STEPPING', color: '#c084fc', defaultCollapsed: false };
    } else if (nodeType === 'MPMObject2D' || nodeType === 'MPMObject3D') {
        if (key === 'pos_x' || key === 'size_x' || key === 'radius' || key === 'stl_file') return { title: 'SPATIAL EXTENT & GEOMETRY', color: '#c084fc', defaultCollapsed: false };
        if (key === 'vel_x') return { title: 'INITIAL VELOCITY & MOTION', color: '#c084fc', defaultCollapsed: true };
    } else if (nodeType === 'FEMDomain3D') {
        if (key === 'integration_scheme') return { title: 'ELEMENT FORMULATION', color: '#38bdf8', defaultCollapsed: false };
        if (key === 'enable_directional_crack_band') return { title: 'DAMAGE REGULARIZATION', color: '#38bdf8', defaultCollapsed: true };
        if (key === 'rebar_formulation') return { title: 'CONTACT & REBAR', color: '#38bdf8', defaultCollapsed: true };
        if (key === 'enable_heterogeneity') return { title: 'MICROSTRUCTURE & DEBRIS', color: '#c084fc', defaultCollapsed: true };
        if (key === 'enable_anisotropy') return { title: 'DIRECTIONAL ANISOTROPY', color: '#38bdf8', defaultCollapsed: true };
    } else if (nodeType === 'FEMObject3D') {
        if (key === 'pos_x' || key === 'k_file') return { title: 'GEOMETRY & MESH GENERATION', color: '#38bdf8', defaultCollapsed: false };
        if (key === 'vel_x') return { title: 'INITIAL VELOCITY & VISCOSITY', color: '#38bdf8', defaultCollapsed: true };
    } else if (nodeType === 'FEMFSICoupler3D' || nodeType === 'FSICoupler2D' || nodeType === 'FSICoupler3D') {
        if (key === 'coupling_scheme') return { title: 'FSI INTERFACE FORMULATION', color: '#22d3ee', defaultCollapsed: false };
        if (key === 'erosion_venting') return { title: 'EROSION VENTING & CAVITY', color: '#22d3ee', defaultCollapsed: true };
    } else if (nodeType === 'VTKOutput') {
        if (key === 'export_slices') return { title: 'DOMAINS & TARGETS', color: '#00e5ff', defaultCollapsed: true };
        if (key === 'qty_pressure') return { title: 'CFD EULERIAN FIELDS', color: '#00e5ff', defaultCollapsed: true };
        if (key === 'qty_fem_stress') return { title: 'SOLID FEM FIELDS', color: '#00e5ff', defaultCollapsed: true };
        if (key === 'qty_mpm_stress') return { title: 'SOLID MPM FIELDS', color: '#00e5ff', defaultCollapsed: true };
        if (key === 'roi_enabled') return { title: 'ROI BOUNDS & STRIDES', color: '#00e5ff', defaultCollapsed: true };
    } else if (nodeType === 'TelemetryText') {
        if (key === 'stream_layout') return { title: 'LAYOUT & STREAM DENSITY', color: '#38bdf8', defaultCollapsed: false };
        if (key === 'show_timing_breakdown') return { title: 'METRIC & TIMING BREAKDOWN COLUMNS', color: '#34d399', defaultCollapsed: false };
        if (key === 'font_size') return { title: 'TYPOGRAPHY & BUFFER SIZING', color: '#a78bfa', defaultCollapsed: false };
    }
    return null;
}

