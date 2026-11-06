// ============================================================================
// BlastDemon FEM Preprocessor Data Model & Schema Definitions
// Single Source of Truth (SSOT) data types for components, sets, materials,
// boundary conditions, and contact interfaces.
// ============================================================================

export type FEMSectionType = 
    | 'SolidHex8' 
    | 'SolidHex8_Full' 
    | 'SolidHex8_SRI'
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
    deck_part_id?: number;        // Original Part ID inside an imported LS-DYNA deck
    node_id?: string;             // Linked canvas node ID in model.nodes (e.g. 'node-fem-obj3d')
    source?: 'canvas_node' | 'deck' | 'user_custom';
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
    shape_type?: 'Box' | 'Cylinder' | 'Plate' | 'Beam' | 'LS-DYNA File' | 'STL File';
    origin_mode?: string;
    pos_x?: number;
    pos_y?: number;
    pos_z?: number;
    rot_x?: number;
    rot_y?: number;
    rot_z?: number;
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
    stl_file?: string;
    scale_factor?: number;
}

export type FEMSetType = 'NODE' | 'PART' | 'SEGMENT' | 'SOLID' | 'BEAM';

export interface FEMEntitySet {
    set_id: number;
    name: string;
    set_type: FEMSetType;
    entity_ids: number[];
    color?: string;
    source: 'deck' | 'user_box' | 'user_plane' | 'user_cylinder' | 'user_part' | 'user_manual';
    section_type?: FEMSectionType;
    section_properties?: FEMSectionProperties;
    material_assignment?: string;
    filter_part_id?: number;
    filter_params?: {
        plane?: 'x_min' | 'x_max' | 'y_min' | 'y_max' | 'z_min' | 'z_max' | 'custom';
        plane_coord?: number;
        tolerance?: number;
        box?: [number, number, number, number, number, number];
        cylinder?: {
            cx: number;
            cy: number;
            zmin: number;
            zmax: number;
            r_min: number;
            r_max: number;
        };
    };
}

export type FEMBCType = 'SPC' | 'PRESCRIBED_VELOCITY' | 'INITIAL_VELOCITY' | 'NON_REFLECTING' | 'PRESSURE_LOAD';
export type FEMBCTargetType = 'NODE_SET' | 'PART' | 'GEOMETRIC_PLANE' | 'COORDINATE_BOX';

export interface FEMBoundaryCondition {
    id: string;
    name: string;
    bc_type: FEMBCType;
    target_type: FEMBCTargetType;
    target_id: number | string;   // Set ID, Part ID, or coordinate plane label
    dofs: [boolean, boolean, boolean, boolean, boolean, boolean]; // [Tx, Ty, Tz, Rx, Ry, Rz]
    velocity?: [number, number, number]; // [vx, vy, vz] for prescribed/initial velocity (m/s)
    pressure?: number;            // Uniform pressure load (Pa)
    active: boolean;
}

export type FEMContactType = 
    | 'AUTOMATIC_SINGLE_SURFACE' 
    | 'SURFACE_TO_SURFACE' 
    | 'TIED' 
    | 'ERODING_SINGLE_SURFACE' 
    | 'EMBEDDED_REBAR';

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
    active?: boolean;
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
    merge_coincident_nodes?: boolean;
    node_merge_tolerance?: number;
    embedded_rebar_coupling?: boolean;
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
                penalty_scale: 0.10,
                active: true
            }
        ],
        materials: [],
        material_assignments: {},
        merge_coincident_nodes: false,
        node_merge_tolerance: 1.0e-4,
        embedded_rebar_coupling: true
    };
}

/**
 * Synchronizes a Model's DAG nodes (FEMObject3D, LSDynaImporter3D, FEMBeam3D, FEMRebar3D, Material)
 * with its unified FEMSetupConfig SSOT, preserving all user overrides, custom parts, sets, BCs, and contacts.
 */
export function syncModelFEMSetup(
    model: { id?: string; name?: string; nodes: any[]; connections: any[] },
    getDeckMeta?: (kFile: string) => any
): FEMSetupConfig {
    if (!model || !Array.isArray(model.nodes)) {
        return createDefaultFEMSetupConfig();
    }

    const domainNode = model.nodes.find((n: any) => n.type === 'FEMDomain3D' || n.type === 'FEMFSICoupler3D');
    const structuralNodes = model.nodes.filter((n: any) =>
        ['FEMObject3D', 'LSDynaImporter3D', 'FEMBeam3D', 'FEMRebar3D'].includes(n.type)
    );

    let existingSetup: FEMSetupConfig | null = null;
    if (domainNode?.parameters?.fem_setup && typeof domainNode.parameters.fem_setup === 'object') {
        existingSetup = domainNode.parameters.fem_setup;
    } else {
        for (const sn of structuralNodes) {
            if (sn.parameters?.fem_setup && typeof sn.parameters.fem_setup === 'object') {
                existingSetup = sn.parameters.fem_setup;
                break;
            }
        }
    }

    const config: FEMSetupConfig = existingSetup
        ? JSON.parse(JSON.stringify(existingSetup))
        : createDefaultFEMSetupConfig();

    if (!Array.isArray(config.parts)) config.parts = [];
    if (!Array.isArray(config.sets)) config.sets = [];
    if (!Array.isArray(config.boundary_conditions)) config.boundary_conditions = [];
    if (!Array.isArray(config.contacts)) config.contacts = [];
    if (!Array.isArray(config.materials)) config.materials = [];
    if (!config.material_assignments) config.material_assignments = {};

    if (domainNode?.parameters) {
        if (domainNode.parameters.merge_coincident_nodes !== undefined) {
            config.merge_coincident_nodes = Boolean(domainNode.parameters.merge_coincident_nodes);
        }
        if (domainNode.parameters.node_merge_tolerance !== undefined) {
            config.node_merge_tolerance = Number(domainNode.parameters.node_merge_tolerance);
        }
        if (domainNode.parameters.embedded_rebar_coupling !== undefined) {
            config.embedded_rebar_coupling = Boolean(domainNode.parameters.embedded_rebar_coupling);
        }
    }

    // 1. Synchronize Canvas Material nodes into config.materials
    for (const node of model.nodes) {
        if (
            node.type.includes('Material') ||
            node.type.includes('Constitutive') ||
            String(node.type) === 'MaterialTable' ||
            node.parameters?.model_type !== undefined
        ) {
            const p = node.parameters || {};
            const nodeName = String(p.name || p.material_name || p.preset || node.id);
            const existing = config.materials.find(
                m => m.node_id === node.id || (m.parameters as any)?.node_id === node.id || m.name === nodeName
            );
            if (existing) {
                existing.node_id = node.id;
                existing.name = nodeName;
                if (p.material_model || p.model_type) {
                    existing.model_type = String(p.material_model || p.model_type);
                }
                if (p.density !== undefined) existing.density = Number(p.density);
                if (p.youngs_modulus !== undefined || p.e !== undefined) {
                    existing.youngs_modulus = Number(p.youngs_modulus ?? p.e);
                }
                if (p.poissons_ratio !== undefined || p.nu !== undefined) {
                    existing.poissons_ratio = Number(p.poissons_ratio ?? p.nu);
                }
                if (p.yield_stress !== undefined) existing.yield_stress = Number(p.yield_stress);
                if (p.hardening_modulus !== undefined) existing.hardening_modulus = Number(p.hardening_modulus);
                if (p.failure_strain !== undefined) existing.failure_strain = Number(p.failure_strain);
                existing.parameters = { ...existing.parameters, ...p, node_id: node.id };
            } else {
                const nextId = Math.max(0, ...config.materials.map(m => m.mat_id)) + 1;
                config.materials.push({
                    mat_id: nextId,
                    name: nodeName,
                    source: 'canvas_node',
                    node_id: node.id,
                    model_type: String(p.material_model || p.model_type || 'PiecewiseLinearPlasticity'),
                    density: Number(p.density ?? 7850),
                    youngs_modulus: Number(p.youngs_modulus ?? (p.e ?? 210e9)),
                    poissons_ratio: Number(p.poissons_ratio ?? (p.nu ?? 0.30)),
                    yield_stress: Number(p.yield_stress ?? 400e6),
                    hardening_modulus: Number(p.hardening_modulus ?? 1e9),
                    failure_strain: Number(p.failure_strain ?? 0.25),
                    parameters: { ...p, node_id: node.id }
                });
            }
        }
    }

    // 2. Remove orphaned canvas-linked parts whose node was deleted from the graph,
    // while keeping user_custom parts and deck sub-parts whose parent node still exists.
    if (structuralNodes.length > 0) {
        const validNodeIds = new Set(structuralNodes.map((n: any) => n.id));
        config.parts = config.parts.filter(pt => {
            if (pt.source === 'user_custom') return true;
            if (pt.node_id && validNodeIds.has(pt.node_id)) return true;
            if (!pt.node_id && structuralNodes.some((n: any) => (n.parameters?.name || n.id) === pt.name)) return true;
            // Also keep deck sub-parts (e.g. Part 2 Internal Rebar Cage) if any LSDyna node matches k_file
            if (pt.shape_type === 'LS-DYNA File' && structuralNodes.some((n: any) => n.type === 'LSDynaImporter3D' || n.parameters?.k_file === pt.k_file)) {
                return true;
            }
            return false;
        });
    }

    // 3. Synchronize each structural node into config.parts
    for (let idx = 0; idx < structuralNodes.length; idx++) {
        const node = structuralNodes[idx];
        const p = node.parameters || {};

        let matAssignment = String(p.material || 'DEFAULT');
        const matConn = (model.connections || []).find((c: any) =>
            (c.toNode === node.id || c.fromNode === node.id) &&
            (c.toPort === 'material' || c.fromPort === 'material' || c.toPort === 'importer')
        );
        if (matConn) {
            matAssignment = matConn.toNode === node.id ? matConn.fromNode : matConn.toNode;
        }

        const isLSDyna = node.type === 'LSDynaImporter3D' || !!p.k_file || p.mesh_source === 'LS-DYNA Keyword File' || p.shape_type === 'LS-DYNA File';
        const kFile = p.k_file || p.filename || p.file_path || (node.type === 'LSDynaImporter3D' ? 'concrete_cubicle_30mm.k' : undefined);
        const deckMeta = (isLSDyna && kFile && getDeckMeta) ? getDeckMeta(kFile) : undefined;

        if (isLSDyna && deckMeta && deckMeta.numSolidElements > 0 && deckMeta.numBeamElements > 0) {
            // Known multi-part LS-DYNA deck (e.g. concrete cubicle with solid concrete + rebar beams)
            const b = deckMeta.bounds || [0, 3.0, 0, 2.66, 0, 3.60];
            const baseTitle = String(p.name || model.name || 'LS-DYNA Concrete Cubicle');

            // Ensure deck materials exist
            if (!config.materials.some(m => m.mat_id === 1 || m.name === 'Concrete_Damage_Rel3')) {
                config.materials.push({
                    mat_id: 1,
                    name: 'Concrete_Damage_Rel3',
                    source: 'deck',
                    model_type: 'ConcreteDamageRel3',
                    density: 2400.0,
                    youngs_modulus: 28.0e9,
                    poissons_ratio: 0.18,
                    yield_stress: 31.0e6,
                    parameters: { compressive_strength: 31.0e6 }
                });
            }
            if (!config.materials.some(m => m.mat_id === 2 || m.name === 'Steel_PiecewiseLinearPlasticity')) {
                config.materials.push({
                    mat_id: 2,
                    name: 'Steel_PiecewiseLinearPlasticity',
                    source: 'deck',
                    model_type: 'PiecewiseLinearPlasticity',
                    density: 7850.0,
                    youngs_modulus: 200.0e9,
                    poissons_ratio: 0.30,
                    yield_stress: 400.0e6,
                    failure_strain: 0.20,
                    parameters: { diameter: deckMeta.rebarDiameter || 0.00953 }
                });
            }

            // Ensure default support pad set and BC exist if none configured yet
            if (config.sets.length === 0) {
                config.sets.push({
                    set_id: 1,
                    name: 'SET_NODE_SUPPORT_PADS',
                    set_type: 'NODE',
                    entity_ids: [],
                    source: 'deck'
                });
            }
            if (config.boundary_conditions.length === 0) {
                config.boundary_conditions.push({
                    id: 'bc_support_pads_fixed',
                    name: 'Fixed Corner Support Pads (Z=0)',
                    bc_type: 'SPC',
                    target_type: 'NODE_SET',
                    target_id: 1,
                    dofs: [true, true, true, true, true, true],
                    active: true
                });
            }

            // Solid Part (Deck Part 1)
            let solidPart = config.parts.find(pt =>
                (pt.node_id === node.id && (pt.deck_part_id === 1 || pt.section_type !== 'Beam3D')) ||
                (pt.k_file === kFile && pt.section_type !== 'Beam3D' && pt.part_id === 1)
            );
            if (!solidPart) {
                const nextPid = Math.max(0, ...config.parts.map(pt => pt.part_id)) + 1;
                solidPart = {
                    part_id: nextPid,
                    deck_part_id: 1,
                    node_id: node.id,
                    source: 'deck',
                    name: `${baseTitle} (Solid Concrete)`,
                    section_type: 'SolidHex8',
                    section_properties: { thickness: 0.16, hourglass_type: 'Flanagan-Belytschko', hourglass_coeff: 0.10 },
                    material_assignment: matAssignment !== 'DEFAULT' ? matAssignment : 'DECK_MAT_1',
                    color: '#38bdf8',
                    visible: true,
                    suppressed: false,
                    initial_velocity: [Number(p.vel_x ?? 0), Number(p.vel_y ?? 0), Number(p.vel_z ?? 0)],
                    num_elements: deckMeta.numSolidElements,
                    num_nodes: deckMeta.numNodes,
                    bounds: b,
                    shape_type: 'LS-DYNA File',
                    pos_x: Number(p.pos_x ?? b[0]),
                    pos_y: Number(p.pos_y ?? b[2]),
                    pos_z: Number(p.pos_z ?? b[4]),
                    rot_x: Number(p.rot_x ?? 0),
                    rot_y: Number(p.rot_y ?? 0),
                    rot_z: Number(p.rot_z ?? 0),
                    size_x: b[1] - b[0],
                    size_y: b[3] - b[2],
                    size_z: b[5] - b[4],
                    k_file: kFile,
                    scale_factor: Number(p.scale_factor ?? 1.0)
                };
                config.parts.push(solidPart);
            } else {
                solidPart.node_id = node.id;
                solidPart.deck_part_id = 1;
                solidPart.k_file = kFile;
                solidPart.num_elements = deckMeta.numSolidElements;
                solidPart.num_nodes = deckMeta.numNodes;
                solidPart.bounds = b;
                if (p.scale_factor !== undefined) solidPart.scale_factor = Number(p.scale_factor);
                if (p.pos_x !== undefined) solidPart.pos_x = Number(p.pos_x);
                if (p.pos_y !== undefined) solidPart.pos_y = Number(p.pos_y);
                if (p.pos_z !== undefined) solidPart.pos_z = Number(p.pos_z);
                if (p.rot_x !== undefined) solidPart.rot_x = Number(p.rot_x);
                if (p.rot_y !== undefined) solidPart.rot_y = Number(p.rot_y);
                if (p.rot_z !== undefined) solidPart.rot_z = Number(p.rot_z);
            }

            // Rebar Part (Deck Part 2)
            let rebarPart = config.parts.find(pt =>
                (pt.node_id === node.id && (pt.deck_part_id === 2 || pt.section_type === 'Beam3D')) ||
                (pt.k_file === kFile && pt.section_type === 'Beam3D')
            );
            if (!rebarPart) {
                const nextPid = Math.max(0, ...config.parts.map(pt => pt.part_id)) + 1;
                const rDiam = deckMeta.rebarDiameter || 0.00953;
                rebarPart = {
                    part_id: nextPid,
                    deck_part_id: 2,
                    node_id: node.id,
                    source: 'deck',
                    name: 'Internal Rebar Cage (Beams)',
                    section_type: 'Beam3D',
                    section_properties: {
                        diameter: rDiam,
                        area: Math.PI * rDiam * rDiam * 0.25,
                        hourglass_type: 'Flanagan-Belytschko',
                        hourglass_coeff: 0.10
                    },
                    material_assignment: 'DECK_MAT_2',
                    color: '#f59e0b',
                    visible: true,
                    suppressed: false,
                    initial_velocity: [Number(p.vel_x ?? 0), Number(p.vel_y ?? 0), Number(p.vel_z ?? 0)],
                    num_elements: deckMeta.numBeamElements,
                    num_nodes: deckMeta.numNodes,
                    bounds: b,
                    shape_type: 'LS-DYNA File',
                    pos_x: Number(p.pos_x ?? b[0]),
                    pos_y: Number(p.pos_y ?? b[2]),
                    pos_z: Number(p.pos_z ?? b[4]),
                    rot_x: Number(p.rot_x ?? 0),
                    rot_y: Number(p.rot_y ?? 0),
                    rot_z: Number(p.rot_z ?? 0),
                    size_x: b[1] - b[0],
                    size_y: b[3] - b[2],
                    size_z: b[5] - b[4],
                    k_file: kFile,
                    scale_factor: Number(p.scale_factor ?? 1.0)
                };
                config.parts.push(rebarPart);
            } else {
                rebarPart.node_id = node.id;
                rebarPart.deck_part_id = 2;
                rebarPart.k_file = kFile;
                rebarPart.num_elements = deckMeta.numBeamElements;
                rebarPart.num_nodes = deckMeta.numNodes;
                rebarPart.bounds = b;
            }
            continue;
        }

        // Standard single-part or primitive structural node
        let existingPart = config.parts.find(pt => pt.node_id === node.id || pt.name === (p.name || node.id));
        let secType: FEMSectionType = 'SolidHex8';
        if (node.type === 'FEMBeam3D') secType = 'Beam3D';
        else if (node.type === 'FEMRebar3D') secType = 'Truss1D';
        else if (p.shape_type === 'Plate' || p.shape_type === 'Shell') secType = 'Shell4';
        else if (p.section_type) secType = p.section_type as FEMSectionType;
        else if (p.element_type === 'Tet4') secType = 'SolidTet4';
        else if (p.element_type === 'Tet4_ANP') secType = 'SolidTet4_ANP';
        else if (p.element_type === 'Hex8_SRI' || p.hourglass_model === 'BBar_SRI') secType = 'SolidHex8_SRI';
        else if (p.element_type === 'Hex8_Full') secType = 'SolidHex8_Full';
        else if (p.element_type === 'Wedge6') secType = 'SolidWedge6';

        const nx = Math.max(1, Math.min(200, Number(p.nx ?? 10)));
        const ny = Math.max(1, Math.min(200, Number(p.ny ?? 10)));
        const nz = Math.max(1, Math.min(200, Number(p.nz ?? 10)));
        const sx = Number(p.size_x ?? 1.0);
        const sy = Number(p.size_y ?? 1.0);
        const sz = Number(p.size_z ?? 1.0);
        const px = Number(p.pos_x ?? 0.0);
        const py = Number(p.pos_y ?? 0.0);
        const pz = Number(p.pos_z ?? 0.0);
        const isCAD = p.origin_mode === 'CAD Origin' || p.origin_mode === 'Min Corner';
        const calcBounds: [number, number, number, number, number, number] = isCAD
            ? [px, px + sx, py, py + sy, pz, pz + sz]
            : [px - 0.5 * sx, px + 0.5 * sx, py - 0.5 * sy, py + 0.5 * sy, pz - 0.5 * sz, pz + 0.5 * sz];
        const estElements = secType === 'Shell4' ? (nx * ny) : ((secType === 'Beam3D' || secType === 'Truss1D') ? nz : (nx * ny * nz));
        const estNodes = secType === 'Shell4' ? ((nx + 1) * (ny + 1)) : ((secType === 'Beam3D' || secType === 'Truss1D') ? (nz + 1) : ((nx + 1) * (ny + 1) * (nz + 1)));

        if (existingPart) {
            existingPart.node_id = node.id;
            existingPart.name = String(p.name || existingPart.name || node.id);
            if (matAssignment !== 'DEFAULT' || !existingPart.material_assignment) {
                existingPart.material_assignment = matAssignment;
            }
            if (isLSDyna) {
                existingPart.shape_type = 'LS-DYNA File';
                if (kFile) existingPart.k_file = kFile;
                if (p.scale_factor !== undefined) existingPart.scale_factor = Number(p.scale_factor);
                if (deckMeta) {
                    existingPart.bounds = deckMeta.bounds;
                    existingPart.num_elements = deckMeta.totalElements;
                    existingPart.num_nodes = deckMeta.numNodes;
                }
            } else {
                existingPart.pos_x = px;
                existingPart.pos_y = py;
                existingPart.pos_z = pz;
                if (p.rot_x !== undefined) existingPart.rot_x = Number(p.rot_x);
                if (p.rot_y !== undefined) existingPart.rot_y = Number(p.rot_y);
                if (p.rot_z !== undefined) existingPart.rot_z = Number(p.rot_z);
                existingPart.size_x = sx;
                existingPart.size_y = sy;
                existingPart.size_z = sz;
                if (p.radius !== undefined) existingPart.radius = Number(p.radius);
                if (p.inner_radius !== undefined) existingPart.inner_radius = Number(p.inner_radius);
                if (p.height !== undefined) existingPart.height = Number(p.height);
                existingPart.nx = nx;
                existingPart.ny = ny;
                existingPart.nz = nz;
                if (p.origin_mode) existingPart.origin_mode = p.origin_mode;
                if (p.shape_type) existingPart.shape_type = p.shape_type as any;
                if (!existingPart.num_elements) existingPart.num_elements = estElements;
                if (!existingPart.num_nodes) existingPart.num_nodes = estNodes;
                existingPart.bounds = calcBounds;
            }
            if (p.section_type) existingPart.section_type = p.section_type as any;
            if (p.node1_x !== undefined) existingPart.node1 = [Number(p.node1_x), Number(p.node1_y ?? 0), Number(p.node1_z ?? 0)];
            if (p.node2_x !== undefined) existingPart.node2 = [Number(p.node2_x), Number(p.node2_y ?? 0), Number(p.node2_z ?? 0)];
            if (p.vel_x !== undefined || p.vel_y !== undefined || p.vel_z !== undefined) {
                existingPart.initial_velocity = [
                    Number(p.vel_x ?? 0),
                    Number(p.vel_y ?? 0),
                    Number(p.vel_z ?? 0)
                ];
            }
        } else {
            const partId = Math.max(0, ...config.parts.map(pt => pt.part_id)) + 1;
            const newPart: FEMPartConfig = {
                part_id: partId,
                deck_part_id: 1,
                node_id: node.id,
                source: isLSDyna ? 'deck' : 'canvas_node',
                name: String(p.name || p.title || node.id),
                section_type: secType,
                section_properties: {
                    thickness: Number(p.thickness ?? (isLSDyna ? 0.04 : 0.005)),
                    diameter: Number(p.diameter ?? (p.radius ? p.radius * 2 : 0.00953)),
                    hourglass_type: (p.hourglass_model as any) || 'Flanagan-Belytschko',
                    hourglass_coeff: Number(p.hourglass_coeff ?? 0.10)
                },
                material_assignment: matAssignment,
                color: p.color || getPartColor(idx),
                visible: p.visible !== false && !p.hidden,
                suppressed: p.suppressed === true,
                initial_velocity: [
                    Number(p.vel_x ?? p.vx ?? 0),
                    Number(p.vel_y ?? p.vy ?? 0),
                    Number(p.vel_z ?? p.vz ?? 0)
                ],
                num_elements: deckMeta?.totalElements ?? (isLSDyna ? 211010 : estElements),
                num_nodes: deckMeta?.numNodes ?? (isLSDyna ? 213270 : estNodes),
                bounds: deckMeta?.bounds ?? (isLSDyna ? [0, 3.68, 0, 3.68, 0, 2.68] : calcBounds),
                shape_type: (isLSDyna ? 'LS-DYNA File' : (p.shape_type || (node.type === 'FEMBeam3D' ? 'Beam' : 'Box'))) as any,
                pos_x: deckMeta ? deckMeta.bounds[0] : px,
                pos_y: deckMeta ? deckMeta.bounds[2] : py,
                pos_z: deckMeta ? deckMeta.bounds[4] : pz,
                rot_x: Number(p.rot_x ?? 0),
                rot_y: Number(p.rot_y ?? 0),
                rot_z: Number(p.rot_z ?? 0),
                size_x: deckMeta ? (deckMeta.bounds[1] - deckMeta.bounds[0]) : sx,
                size_y: deckMeta ? (deckMeta.bounds[3] - deckMeta.bounds[2]) : sy,
                size_z: deckMeta ? (deckMeta.bounds[5] - deckMeta.bounds[4]) : sz,
                radius: Number(p.radius ?? 0.1),
                inner_radius: Number(p.inner_radius ?? 0.0),
                height: Number(p.height ?? 0.2),
                origin_mode: p.origin_mode || 'Center',
                nx,
                ny,
                nz,
                node1: [Number(p.node1_x ?? 0), Number(p.node1_y ?? 0), Number(p.node1_z ?? 0)],
                node2: [Number(p.node2_x ?? 1), Number(p.node2_y ?? 0), Number(p.node2_z ?? 0)],
                k_file: kFile,
                stl_file: p.stl_file,
                scale_factor: Number(p.scale_factor ?? 1.0)
            };
            config.parts.push(newPart);
        }
    }

    // Store synced config onto domainNode in-memory so downstream readers always see the synchronized SSOT
    if (domainNode && domainNode.parameters) {
        domainNode.parameters.fem_setup = config;
    }

    return config;
}

