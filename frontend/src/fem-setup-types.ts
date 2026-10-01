// ============================================================================
// BlastDemon FEM Preprocessor Data Model & Schema Definitions
// Single Source of Truth (SSOT) data types for components, sets, materials,
// boundary conditions, and contact interfaces.
// ============================================================================

export type FEMSectionType = 
    | 'SolidHex8' 
    | 'SolidHex8_Full' 
    | 'SolidTet4' 
    | 'SolidTet4_ANP' 
    | 'SolidTet10' 
    | 'SolidWedge6' 
    | 'Shell4' 
    | 'Beam3D' 
    | 'Truss1D';

export interface FEMSectionProperties {
    thickness?: number;           // Shell thickness in meters (e.g. 0.005)
    diameter?: number;            // Beam circular diameter in meters (e.g. 0.012)
    area?: number;                // Beam/truss cross-sectional area in m^2
    I2?: number;                  // Second moment of area I2 (m^4)
    I3?: number;                  // Second moment of area I3 (m^4)
    J?: number;                   // Torsional polar constant J (m^4)
    integration_points?: number;  // Gauss through-thickness integration points (shells: 1, 2, 3, 5)
    shear_factor?: number;        // Transverse shear correction factor (default 5/6 = 0.8333)
    beam_profile?: 'Circular_Solid' | 'Circular_Pipe' | 'Rectangular' | 'Rebar_Bar';
    wall_thickness?: number;      // Pipe wall thickness in meters
    width?: number;               // Rectangular beam cross-section width in meters
    height?: number;              // Rectangular beam cross-section height in meters
    hourglass_coeff?: number;     // Hourglass stiffness factor (default 0.10)
    hourglass_type?: 'Flanagan-Belytschko' | 'Standard_Viscous' | 'BBar_SRI';
}

export interface FEMPartConfig {
    part_id: number;
    node_id?: string;             // Linked canvas node ID in model.nodes (e.g. 'node-fem-obj3d')
    name: string;
    section_type: FEMSectionType;
    section_properties: FEMSectionProperties;
    material_assignment: string;  // Node ID of canvas Material node, or 'DECK_MAT_<id>'
    color: string;                // Hex color code (e.g. '#3b82f6')
    visible: boolean;             // 3D rendering visibility toggle
    suppressed: boolean;          // Suppress/omit from solver execution
    initial_velocity: [number, number, number]; // [vx, vy, vz] in m/s
    erosion_override?: {
        failure_strain?: number;
        tensile_failure_stress?: number;
        convert_to_mpm?: boolean;
    };
    num_elements: number;
    num_nodes: number;
    bounds: [number, number, number, number, number, number]; // [minX, maxX, minY, maxY, minZ, maxZ]
    shape_type?: 'Box' | 'Cylinder' | 'Plate' | 'Beam' | 'LS-DYNA File';
    origin_mode?: string;
    pos_x?: number;
    pos_y?: number;
    pos_z?: number;
    size_x?: number;
    size_y?: number;
    size_z?: number;
    radius?: number;
    inner_radius?: number;
    height?: number;
    nx?: number;
    ny?: number;
    nz?: number;
    node1?: [number, number, number];
    node2?: [number, number, number];
    k_file?: string;
    scale_factor?: number;
}

export type FEMSetType = 'NODE' | 'PART' | 'SEGMENT' | 'SOLID' | 'BEAM';

export interface FEMEntitySet {
    set_id: number;
    name: string;
    set_type: FEMSetType;
    entity_ids: number[];
    color?: string;
    source: 'deck' | 'user_box' | 'user_plane' | 'user_manual';
    section_type?: FEMSectionType;
    section_properties?: FEMSectionProperties;
    material_assignment?: string;
    filter_params?: {
        plane?: 'x_min' | 'x_max' | 'y_min' | 'y_max' | 'z_min' | 'z_max' | 'custom';
        plane_coord?: number;
        tolerance?: number;
        box?: [number, number, number, number, number, number];
    };
}

export type FEMBCType = 'SPC' | 'PRESCRIBED_VELOCITY' | 'NON_REFLECTING';
export type FEMBCTargetType = 'NODE_SET' | 'PART' | 'GEOMETRIC_PLANE' | 'COORDINATE_BOX';

export interface FEMBoundaryCondition {
    id: string;
    name: string;
    bc_type: FEMBCType;
    target_type: FEMBCTargetType;
    target_id: number | string;   // Set ID, Part ID, or coordinate plane label
    dofs: [boolean, boolean, boolean, boolean, boolean, boolean]; // [Tx, Ty, Tz, Rx, Ry, Rz]
    velocity?: [number, number, number]; // [vx, vy, vz] for prescribed velocity (m/s)
    active: boolean;
}

export type FEMContactType = 'AUTOMATIC_SINGLE_SURFACE' | 'SURFACE_TO_SURFACE' | 'TIED';

export interface FEMContactConfig {
    id: string;
    name: string;
    contact_type: FEMContactType;
    master_type?: 'PART' | 'SET';
    master_id?: number;
    slave_type?: 'PART' | 'SET';
    slave_id?: number;
    friction_static: number;
    friction_kinetic: number;
    penalty_scale: number;
}

export interface FEMMaterialDefinition {
    mat_id: number;
    name: string;
    source: 'deck' | 'canvas_node' | 'user_custom';
    node_id?: string;
    model_type: string;           // 'Hypoelastic', 'JohnsonCook', 'ConcreteRHT', etc.
    density: number;
    youngs_modulus: number;
    poissons_ratio: number;
    yield_stress?: number;
    hardening_modulus?: number;
    failure_strain?: number;
    tensile_failure_stress?: number;
    parameters: Record<string, any>;
}

export interface FEMSetupConfig {
    parts: FEMPartConfig[];
    sets: FEMEntitySet[];
    boundary_conditions: FEMBoundaryCondition[];
    contacts: FEMContactConfig[];
    materials: FEMMaterialDefinition[];
    material_assignments: Record<number, string>; // part_id -> material key or node ID
}

export const CAD_PALETTE = [
    '#3b82f6', // Bright Blue
    '#ef4444', // Crimson Red
    '#10b981', // Emerald Green
    '#f59e0b', // Amber
    '#8b5cf6', // Violet
    '#06b6d4', // Cyan
    '#ec4899', // Pink
    '#84cc16', // Lime
    '#f97316', // Orange
    '#6366f1', // Indigo
    '#14b8a6', // Teal
    '#e11d48', // Rose
    '#a855f7', // Purple
    '#eab308', // Yellow
    '#64748b', // Slate
];

export function getPartColor(index: number): string {
    return CAD_PALETTE[Math.abs(index) % CAD_PALETTE.length];
}

export function createDefaultFEMSetupConfig(): FEMSetupConfig {
    return {
        parts: [],
        sets: [],
        boundary_conditions: [],
        contacts: [
            {
                id: 'contact_auto_default',
                name: 'Global Self-Contact',
                contact_type: 'AUTOMATIC_SINGLE_SURFACE',
                friction_static: 0.3,
                friction_kinetic: 0.2,
                penalty_scale: 0.10
            }
        ],
        materials: [],
        material_assignments: {}
    };
}
