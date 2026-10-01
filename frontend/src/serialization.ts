import { SimulationState, Node } from './types.js';
import { resolveResourcePath, isSeabedMaterialNode } from './state-manager.js';

export function isAirMaterialNode(node: any): boolean {
    if (!node || node.type !== 'Material') return false;
    const model = node.parameters?.material_model;
    const type = node.parameters?.material_type;
    return type === 'Air' || (model === 'Ideal Gas' && type !== 'Ideal Gas Charge');
}

export function isJWLMaterialNode(node: any): boolean {
    if (!node || node.type !== 'Material') return false;
    const model = node.parameters?.material_model;
    const type = node.parameters?.material_type;
    return model === 'JWL Detonation Gas' || type === 'JWL Charge' || model === 'JWL';
}

export function isIdealGasMaterialNode(node: any): boolean {
    if (!node || node.type !== 'Material') return false;
    const model = node.parameters?.material_model;
    const type = node.parameters?.material_type;
    return type === 'Ideal Gas Charge' || (model === 'Ideal Gas' && type !== 'Air');
}

export const JWL_KEYS = [
    'composition', 'preset', 'rho', 'detonation_energy', 'det_vel',
    'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'
];

export const AFTERBURN_KEYS = [
    'afterburn_enabled', 'afterburn_energy', 'afterburn_fuel_fraction',
    'afterburn_stoich_ratio', 'afterburn_ignition_temp', 'afterburn_tau_chem',
    'afterburn_c_edc', 'afterburn_tau_expansion', 'afterburn_ambient_o2_fraction'
];

export const AIR_KEYS = [
    'atm_pressure', 'atm_temperature', 'gamma', 'density', 'ambient_rho', 'ambient_p', 'ambient_o2_fraction'
];

export function extractJWLAndAfterburnParams(matNode: any, target: Record<string, any>, numericKeys: string[], booleanKeys: string[]): void {
    if (!matNode || !matNode.parameters) return;
    [...JWL_KEYS, ...AFTERBURN_KEYS].forEach(key => {
        if (matNode.parameters[key] !== undefined) {
            if (booleanKeys.includes(key)) {
                target[key] = matNode.parameters[key] === true || matNode.parameters[key] === 'true' || matNode.parameters[key] === 'True';
            } else if (numericKeys.includes(key)) {
                target[key] = Number(matNode.parameters[key]);
            } else {
                target[key] = matNode.parameters[key];
            }
        }
    });
    if (target['rho'] === undefined && matNode.parameters['density'] !== undefined) {
        target['rho'] = Number(matNode.parameters['density']);
    }
}

export function extractAirParams(airNode: any, target: Record<string, any>, numericKeys: string[]): void {
    if (!airNode || !airNode.parameters) return;
    AIR_KEYS.forEach(key => {
        if (airNode.parameters[key] !== undefined) {
            target[key] = numericKeys.includes(key) ? Number(airNode.parameters[key]) : airNode.parameters[key];
        }
    });

    if (airNode.parameters['ambient_o2_fraction'] !== undefined) {
        target['ambient_o2_fraction'] = Number(airNode.parameters['ambient_o2_fraction']);
    } else {
        const preset = (airNode.parameters['preset'] || airNode.parameters['name'] || '').toLowerCase();
        if (preset.includes('nitrogen') || preset.includes('n2') || preset.includes('argon') ||
            preset.includes('helium') || preset.includes('noble') || preset.includes('vacuum')) {
            target['ambient_o2_fraction'] = 0.0;
        } else if (preset.includes('oxygen') || preset.includes('o2')) {
            target['ambient_o2_fraction'] = 1.0;
        } else {
            target['ambient_o2_fraction'] = 0.233;
        }
    }
    if (target['afterburn_ambient_o2_fraction'] === undefined) {
        target['afterburn_ambient_o2_fraction'] = target['ambient_o2_fraction'];
    }
}

export function extractUnderwaterParams(
    state: SimulationState,
    solverNode3D: Node,
    flattenedParams: Record<string, any>,
    numericKeys: string[]
): void {
    if (!solverNode3D) return;

    // 1. Water Material (Tait EOS)
    const waterConn = state.connections.find(c => 
        (c.toNode === solverNode3D.id && (c.toPort === 'water' || c.toPort === 'seawater')) ||
        (c.fromNode === solverNode3D.id && (c.fromPort === 'water' || c.fromPort === 'seawater'))
    );
    let waterNode: Node | undefined;
    if (waterConn) {
        const waterId = waterConn.toNode === solverNode3D.id ? waterConn.fromNode : waterConn.toNode;
        waterNode = state.nodes.find(n => n.id === waterId);
    } else if (solverNode3D.parameters?.seawater_material) {
        waterNode = state.nodes.find(n => n.id === solverNode3D.parameters.seawater_material);
    } else if (solverNode3D.type === 'MarineHarbourDomain') {
        waterNode = state.nodes.find(n => n.type === 'Material' && (n.parameters?.material_model === 'Tait Water' || n.parameters?.preset?.includes('Water') || n.parameters?.preset?.includes('Seawater')));
    }

    if (waterNode) {
        flattenedParams['is_water'] = true;
        flattenedParams['water_material'] = (waterNode as any).name || waterNode.parameters?.name || waterNode.id;
        flattenedParams['tait_B'] = Number(waterNode.parameters?.tait_B ?? 3.039e8);
        flattenedParams['tait_gamma'] = Number(waterNode.parameters?.tait_gamma ?? 7.15);
        flattenedParams['tait_rho0'] = Number(waterNode.parameters?.tait_rho0 ?? waterNode.parameters?.density ?? 1025.0);
        flattenedParams['tait_c0'] = Number(waterNode.parameters?.tait_c0 ?? 1482.0);
        flattenedParams['tait_p_cav'] = Number(waterNode.parameters?.tait_p_cav ?? 0.0);
        flattenedParams['tait_p0'] = Number(waterNode.parameters?.tait_p0 ?? waterNode.parameters?.p0 ?? flattenedParams['p_atm'] ?? 101325.0);
        flattenedParams['tait_gruneisen'] = Number(waterNode.parameters?.tait_gruneisen ?? 0.28);
        if (waterNode.parameters?.tait_variant_str) {
            flattenedParams['tait_variant_str'] = waterNode.parameters.tait_variant_str;
        }
    }

    // 2. Seabed Material (Soil / Sediment / Rock)
    const seabedConn = state.connections.find(c => 
        (c.toNode === solverNode3D.id && (c.toPort === 'seabed' || c.toPort === 'seabed_foundation' || c.toPort === 'foundation')) ||
        (c.fromNode === solverNode3D.id && (c.fromPort === 'seabed' || c.fromPort === 'seabed_foundation' || c.fromPort === 'foundation'))
    );
    let seabedNode: Node | undefined;
    if (seabedConn) {
        const seabedId = seabedConn.toNode === solverNode3D.id ? seabedConn.fromNode : seabedConn.toNode;
        seabedNode = state.nodes.find(n => n.id === seabedId);
    } else if (solverNode3D.parameters?.seabed_foundation) {
        seabedNode = state.nodes.find(n => n.id === solverNode3D.parameters.seabed_foundation);
    } else if (solverNode3D.parameters?.seabed_material) {
        seabedNode = state.nodes.find(n => n.id === solverNode3D.parameters.seabed_material);
    } else if (solverNode3D.type === 'MarineHarbourDomain') {
        seabedNode = state.nodes.find(n => n.type === 'Material' && (
            isSeabedMaterialNode(n) || 
            String((n as any).name || n.parameters?.name || n.id).toLowerCase().includes('seabed') ||
            String(n.parameters?.preset || '').toLowerCase().includes('basalt') ||
            String(n.parameters?.preset || '').toLowerCase().includes('rock') ||
            String(n.parameters?.preset || '').toLowerCase().includes('soil')
        ));
    }

    if (seabedNode) {
        const sParams = seabedNode.parameters || {};
        const rho = Number(sParams.density ?? sParams.soil_density ?? 2000.0);
        flattenedParams['soil_density'] = rho;
        flattenedParams['seabed_density'] = rho;

        // Acoustic sound speed c0
        let c0 = 2500.0;
        if (sParams.soil_c0 !== undefined) {
            c0 = Number(sParams.soil_c0);
        } else if (sParams.seabed_c0 !== undefined) {
            c0 = Number(sParams.seabed_c0);
        } else if (sParams.mg_c0 !== undefined) {
            c0 = Number(sParams.mg_c0);
        } else if (sParams.c0 !== undefined) {
            c0 = Number(sParams.c0);
        } else if (sParams.tait_c0 !== undefined) {
            c0 = Number(sParams.tait_c0);
        } else if (sParams.youngs_modulus !== undefined || sParams.E !== undefined) {
            const E = Number(sParams.youngs_modulus ?? sParams.E);
            const nu = Number(sParams.poissons_ratio ?? sParams.nu ?? 0.25);
            const denom = Math.max(0.01, 3.0 * (1.0 - 2.0 * nu) * rho);
            c0 = Math.sqrt(Math.max(100.0, E / denom));
        }
        flattenedParams['soil_c0'] = c0;
        flattenedParams['seabed_c0'] = c0;

        // Gamma (EOS exponent)
        const gamma = Number(sParams.soil_gamma ?? sParams.seabed_gamma ?? sParams.gamma ?? sParams.tait_gamma ?? 4.0);
        flattenedParams['soil_gamma'] = gamma;
        flattenedParams['seabed_gamma'] = gamma;

        // Hugoniot slope s
        const s = Number(sParams.soil_s ?? sParams.seabed_s ?? sParams.mg_s ?? sParams.s ?? 1.35);
        flattenedParams['soil_s'] = s;
        flattenedParams['seabed_s'] = s;

        // Grüneisen parameter
        const gruneisen = Number(sParams.soil_gruneisen ?? sParams.seabed_gruneisen ?? sParams.mg_gamma0 ?? sParams.gruneisen ?? 1.45);
        flattenedParams['soil_gruneisen'] = gruneisen;
        flattenedParams['seabed_gruneisen'] = gruneisen;

        // Cavitation / tensile cutoff pressure (Pa)
        let p_cav = -1.0e5;
        if (sParams.soil_p_cav !== undefined) {
            p_cav = Number(sParams.soil_p_cav);
        } else if (sParams.seabed_p_cav !== undefined) {
            p_cav = Number(sParams.seabed_p_cav);
        } else if (sParams.tensile_failure_stress !== undefined) {
            p_cav = -Math.abs(Number(sParams.tensile_failure_stress));
        } else if (sParams.dp_tensile_cutoff !== undefined) {
            p_cav = -Math.abs(Number(sParams.dp_tensile_cutoff));
        }
        flattenedParams['soil_p_cav'] = p_cav;
        flattenedParams['seabed_p_cav'] = p_cav;

        // EOS variant: 0 = Isentropic Tait, 1 = Caloric Grüneisen, 2 = Shock Hugoniot
        let eosVariant = 0;
        if (solverNode3D.parameters?.soil_eos_variant !== undefined) {
            eosVariant = Number(solverNode3D.parameters.soil_eos_variant);
        } else if (sParams.soil_eos_variant !== undefined) {
            eosVariant = Number(sParams.soil_eos_variant);
        } else if (sParams.mg_c0 !== undefined || sParams.mg_s !== undefined) {
            eosVariant = 2; // Shock Hugoniot
        }
        flattenedParams['soil_eos_variant'] = eosVariant;

        // Friction, cohesion, and plasticity
        const frict = Number(sParams.friction_angle ?? sParams.dp_friction_angle ?? sParams.soil_friction_angle ?? (sParams.yield_stress ? 35.0 : 30.0));
        flattenedParams['soil_friction_angle'] = frict;
        flattenedParams['dp_friction_angle'] = frict;

        const coh = Number(sParams.cohesion ?? sParams.dp_cohesion ?? sParams.soil_cohesion ?? (sParams.yield_stress ? Number(sParams.yield_stress) * 0.5 : 1.0e4));
        flattenedParams['soil_cohesion'] = coh;
        flattenedParams['dp_cohesion'] = coh;

        if (sParams.dilation_angle !== undefined || sParams.dp_dilatancy_angle !== undefined) {
            flattenedParams['dp_dilatancy_angle'] = Number(sParams.dilation_angle ?? sParams.dp_dilatancy_angle);
        }
        if (sParams.tensile_failure_stress !== undefined || sParams.dp_tensile_cutoff !== undefined) {
            flattenedParams['dp_tensile_cutoff'] = Number(sParams.tensile_failure_stress ?? sParams.dp_tensile_cutoff);
        }
        if (sParams.hardening_modulus !== undefined || sParams.dp_hardening_modulus !== undefined) {
            flattenedParams['dp_hardening_modulus'] = Number(sParams.hardening_modulus ?? sParams.dp_hardening_modulus);
        }
    } else if (solverNode3D.type === 'MarineHarbourDomain' || solverNode3D.parameters?.init_mode === 'Hydrostatic_Stratified_3D' || solverNode3D.parameters?.water_surface_z !== undefined) {
        flattenedParams['soil_density'] = Number(solverNode3D.parameters?.soil_density ?? 2000.0);
        flattenedParams['soil_friction_angle'] = Number(solverNode3D.parameters?.soil_friction_angle ?? 30.0);
        flattenedParams['soil_cohesion'] = Number(solverNode3D.parameters?.soil_cohesion ?? 1.0e4);
        flattenedParams['soil_c0'] = Number(solverNode3D.parameters?.soil_c0 ?? 2500.0);
        flattenedParams['soil_gamma'] = Number(solverNode3D.parameters?.soil_gamma ?? 4.0);
        flattenedParams['soil_s'] = Number(solverNode3D.parameters?.soil_s ?? 1.35);
        flattenedParams['soil_gruneisen'] = Number(solverNode3D.parameters?.soil_gruneisen ?? 1.45);
        flattenedParams['soil_p_cav'] = Number(solverNode3D.parameters?.soil_p_cav ?? -1.0e5);
        flattenedParams['soil_eos_variant'] = Number(solverNode3D.parameters?.soil_eos_variant ?? 0);
    }

    // 3. Near-Field Sleeve & Zonal Properties
    if (solverNode3D.type === 'MarineHarbourDomain' || solverNode3D.parameters?.init_mode === 'Hydrostatic_Stratified_3D' || solverNode3D.parameters?.water_surface_z !== undefined) {
        flattenedParams['stratified_equilibrium'] = true;
        let waterMode = solverNode3D.parameters?.water_discretization_mode || 'Spherical_MPM_Sleeve';
        if (waterMode === 'Pure FV') waterMode = 'Pure_FV';
        flattenedParams['water_discretization_mode'] = waterMode;
        flattenedParams['nearfield_ppc'] = Number(solverNode3D.parameters?.nearfield_ppc ?? 8);
        flattenedParams['nearfield_sleeve_radius'] = Number(solverNode3D.parameters?.nearfield_sleeve_radius ?? 2.5);
        flattenedParams['vertical_sleeve_breach'] = solverNode3D.parameters?.vertical_sleeve_breach === true;
        flattenedParams['weber_breakup_threshold'] = Number(solverNode3D.parameters?.weber_breakup_threshold ?? 12.0);
        flattenedParams['seabed_mesh_type'] = solverNode3D.parameters?.seabed_mesh_type || 'Hybrid_MPM_Crater_FEM_FarField';
        flattenedParams['crater_bed_width'] = Number(solverNode3D.parameters?.crater_bed_width ?? 5.0);
        flattenedParams['crater_bed_depth'] = Number(solverNode3D.parameters?.crater_bed_depth ?? 3.0);
        flattenedParams['water_surface_z'] = Number(solverNode3D.parameters?.water_surface_z ?? 10.0);
        flattenedParams['seabed_surface_z'] = Number(solverNode3D.parameters?.seabed_surface_z ?? 2.0);
        flattenedParams['k0_earth_pressure'] = Number(solverNode3D.parameters?.k0_earth_pressure ?? 0.50);
        flattenedParams['gravity_z'] = Number(solverNode3D.parameters?.gravity_z ?? -9.81);
    }
}

export function serializeMPMObjectsWithSleeve(
    state: SimulationState,
    solverNode3D: Node | undefined,
    mpmDomain: Node | undefined,
    flattenedParams: Record<string, any>,
    numericKeys: string[],
    modelFilename?: string | null
): any[] {
    const mpmObjNodes = state.nodes.filter(n => n.type === 'MPMObject3D');
    const waterMode = solverNode3D?.parameters?.water_discretization_mode || 'Spherical_MPM_Sleeve';
    const isPureFV = (waterMode === 'Pure_FV' || waterMode === 'Pure FV');
    const bedType = solverNode3D?.parameters?.seabed_mesh_type || 'Hybrid_MPM_Crater_FEM_FarField';
    const isPureBed = (bedType === 'Pure_Hex8_FEM' || bedType === 'Pure Hex8 FEM' || bedType === 'Pure_FV' || bedType === 'Pure FV');
    const isHarbourWithSleeve = (solverNode3D?.type === 'MarineHarbourDomain' && !isPureFV && (
        (Number(solverNode3D.parameters?.nearfield_sleeve_radius ?? 2.5) > 0) ||
        !isPureBed
    ));
    if (!mpmDomain && mpmObjNodes.length === 0 && !isHarbourWithSleeve) {
        return [];
    }

    const domainPpc = Number(mpmDomain?.parameters?.ppc ?? solverNode3D?.parameters?.nearfield_ppc ?? 8);
    const domainParticleDist = mpmDomain?.parameters?.particle_distribution;
    const domainBoundaryFill = mpmDomain?.parameters?.boundary_filling;
    flattenedParams['ppc'] = domainPpc;

    const mpmObjects: any[] = [];
    const targetMpmNodes = mpmDomain ? (
        state.connections.filter(c => c.toNode === mpmDomain.id && (c.toPort === 'objects' || c.toPort === 'mpm_objects' || c.toPort === 'in'))
            .map(c => state.nodes.find(n => n.id === c.fromNode))
            .filter(n => n && n.type === 'MPMObject3D')
    ) : mpmObjNodes;
    const finalMpmNodes = (targetMpmNodes.length > 0 ? targetMpmNodes : mpmObjNodes);

    for (const objNode of finalMpmNodes) {
        if (!objNode) continue;
        const objParams: any = {};
        Object.entries(objNode.parameters).forEach(([k, v]) => {
            objParams[k] = numericKeys.includes(k) ? Number(v) : v;
        });
        if (!objParams['shape_type'] && objNode.parameters?.shape) {
            objParams['shape_type'] = objNode.parameters.shape;
        }
        const stlConn = state.connections.find(c => c.toNode === objNode.id && c.toPort === 'stl');
        let stlNode = stlConn ? state.nodes.find(n => n.id === stlConn.fromNode) : null;
        if (objNode.parameters?.shape_type === 'STL' && !stlNode) {
            stlNode = state.nodes.find(n => n.type === 'STLGeometry');
        }
        if (stlNode && stlNode.type === 'STLGeometry') {
            objParams['stl_file'] = resolveResourcePath(stlNode.parameters.stl_file || '', modelFilename);
            objParams['shape_type'] = 'STL';
            if (stlNode.parameters.voxelization_method) objParams['voxelization_method'] = stlNode.parameters.voxelization_method;
            if (stlNode.parameters.origin_mode) objParams['origin_mode'] = stlNode.parameters.origin_mode;
            ['scale_x', 'scale_y', 'scale_z', 'pos_x', 'pos_y', 'pos_z', 'rot_x', 'rot_y', 'rot_z'].forEach(k => {
                if (stlNode!.parameters[k] !== undefined) objParams[k] = Number(stlNode!.parameters[k]);
            });
        } else if (objParams['stl_file']) {
            objParams['stl_file'] = resolveResourcePath(objParams['stl_file'], modelFilename);
        }
        let matNode: any = null;
        const matConn = state.connections.find(c => (c.toNode === objNode.id || c.fromNode === objNode.id) && (c.toPort === 'material' || c.fromPort === 'material' || c.toPort === 'in' || c.fromPort === 'out'));
        if (matConn) {
            const otherId = matConn.toNode === objNode.id ? matConn.fromNode : matConn.toNode;
            matNode = state.nodes.find(n => n.id === otherId);
        } else if (objNode.parameters?.material) {
            matNode = state.nodes.find(n => n.id === objNode.parameters.material);
        }
        if (!matNode) {
            matNode = state.nodes.find(n => n.type === 'Material' && !isJWLMaterialNode(n) && !isIdealGasMaterialNode(n)) || state.nodes.find(n => n.type === 'Material');
        }
        if (matNode) {
            objParams['material_id'] = matNode.id;
            objParams['material_name'] = (matNode as any).name || matNode.parameters?.name || matNode.id;
            Object.entries(matNode.parameters).forEach(([mk, mv]) => {
                objParams[mk] = numericKeys.includes(mk) ? Number(mv) : mv;
            });
        }
        if (matNode?.parameters?.['material_model']) {
            objParams['material_model'] = matNode.parameters['material_model'];
        } else if (!objParams['material_model']) {
            objParams['material_model'] = objNode.parameters?.['material_model'] || 'Hypoelastic';
        }
        if (objParams['vel_x'] === undefined && objParams['initial_velocity_x'] !== undefined) objParams['vel_x'] = objParams['initial_velocity_x'];
        if (objParams['vel_y'] === undefined && objParams['initial_velocity_y'] !== undefined) objParams['vel_y'] = objParams['initial_velocity_y'];
        if (objParams['vel_z'] === undefined && objParams['initial_velocity_z'] !== undefined) objParams['vel_z'] = objParams['initial_velocity_z'];
        objParams['ppc'] = Math.max(1, Math.round(Number(objNode.parameters?.ppc ?? domainPpc)));
        if (domainParticleDist && (objParams['particle_distribution'] === undefined || objParams['particle_distribution'] === 'Cartesian')) {
            objParams['particle_distribution'] = domainParticleDist;
        }
        if (domainBoundaryFill && (objParams['boundary_filling'] === undefined || objParams['boundary_filling'] === 'Stairstepped')) {
            objParams['boundary_filling'] = domainBoundaryFill;
        }
        mpmObjects.push(objParams);
    }

    // Auto-synthesize Nearfield Water Sleeve and Seabed Soil for Marine Harbour Domain
    if (solverNode3D?.type === 'MarineHarbourDomain') {
        const waterMode = solverNode3D.parameters?.water_discretization_mode || 'Spherical_MPM_Sleeve';
        const isPureFV = (waterMode === 'Pure_FV' || waterMode === 'Pure FV');
        const sleeveR = Number(solverNode3D.parameters?.nearfield_sleeve_radius ?? 2.5);
        if (!isPureFV && sleeveR > 0) {
            const hasWaterSleeve = mpmObjects.some(o => 
                (o.material_name && String(o.material_name).toLowerCase().includes('water')) ||
                (o.name && String(o.name).toLowerCase().includes('sleeve')) ||
                (o.material_model === 'TaitWater')
            );
            if (!hasWaterSleeve) {
                const sleevePpc = Number(solverNode3D.parameters?.nearfield_ppc ?? 8);
                let chgX = Number(flattenedParams['charge_x'] ?? 0.0);
                let chgY = Number(flattenedParams['charge_y'] ?? 0.0);
                let chgZ = Number(flattenedParams['charge_z'] ?? 0.0);
                const chgNode = state.nodes.find(n => n.type === 'Charge3D' || n.type === 'Charge2D');
                if (chgNode?.parameters) {
                    const cz = chgNode.parameters.charge_z ?? chgNode.parameters.pos_z ?? chgNode.parameters.z;
                    if (cz !== undefined && (flattenedParams['charge_z'] === undefined || isNaN(chgZ) || chgZ === 0.0)) chgZ = Number(cz);
                    const cx = chgNode.parameters.charge_x ?? chgNode.parameters.pos_x ?? chgNode.parameters.x;
                    if (cx !== undefined && (flattenedParams['charge_x'] === undefined || isNaN(chgX) || chgX === 0.0)) chgX = Number(cx);
                    const cy = chgNode.parameters.charge_y ?? chgNode.parameters.pos_y ?? chgNode.parameters.y;
                    if (cy !== undefined && (flattenedParams['charge_y'] === undefined || isNaN(chgY) || chgY === 0.0)) chgY = Number(cy);
                }
                const chgR = Number(flattenedParams['charge_radius'] ?? 0.1);
                const waterZ = Number(solverNode3D.parameters?.water_surface_z ?? flattenedParams['water_surface_z'] ?? 10.0);
                const seabedZ = Number(solverNode3D.parameters?.seabed_surface_z ?? flattenedParams['seabed_surface_z'] ?? 2.0);

                const isCylinder = waterMode === 'Full_Column_MPM_Cylinder';
                const cylHeight = Math.max(0.1, waterZ - seabedZ);
                const cylPosZ = seabedZ + 0.5 * cylHeight;

                mpmObjects.push({
                    name: isCylinder ? 'Water Column MPM Cylinder' : 'Nearfield Water Sleeve',
                    shape_type: isCylinder ? 'Cylinder' : 'Sphere',
                    pos_x: chgX,
                    pos_y: chgY,
                    pos_z: isCylinder ? cylPosZ : chgZ,
                    radius: sleeveR,
                    inner_radius: isCylinder ? 0.0 : chgR,
                    height: isCylinder ? cylHeight : undefined,
                    material_id: 'mat_water_sleeve',
                    material_name: isCylinder ? 'Water Column Cylinder' : 'Nearfield Water Sleeve',
                    material_model: 'TaitWater',
                    density: Number(flattenedParams['tait_rho0'] ?? 1025.0),
                    c0: Number(flattenedParams['tait_c0'] ?? 1482.0),
                    gamma: Number(flattenedParams['tait_gamma'] ?? 7.15),
                    bulk_modulus: Number(flattenedParams['tait_B'] ?? 3.039e8),
                    tait_B: Number(flattenedParams['tait_B'] ?? 3.039e8),
                    tait_gamma: Number(flattenedParams['tait_gamma'] ?? 7.15),
                    tait_rho0: Number(flattenedParams['tait_rho0'] ?? 1025.0),
                    tait_c0: Number(flattenedParams['tait_c0'] ?? 1482.0),
                    tait_p_cav: Number(flattenedParams['tait_p_cav'] ?? 0.0),
                    tait_p0: Number(flattenedParams['tait_p0'] ?? flattenedParams['p_atm'] ?? 101325.0),
                    tait_viscosity: Number(flattenedParams['tait_viscosity'] ?? 1.002e-3),
                    tait_gruneisen: Number(flattenedParams['tait_gruneisen'] ?? 0.28),
                    tait_variant: Number(flattenedParams['tait_variant'] ?? 0),
                    tait_variant_str: flattenedParams['tait_variant_str'] ?? 'Isentropic',
                    E: 2.2e9,
                    nu: 0.499,
                    ppc: sleevePpc,
                    particle_distribution: 'Cartesian',
                    boundary_filling: 'Stairstepped'
                });
            }
        }

        const bedType = solverNode3D.parameters?.seabed_mesh_type || 'Hybrid_MPM_Crater_FEM_FarField';
        const isPureBed = (bedType === 'Pure_Hex8_FEM' || bedType === 'Pure Hex8 FEM' || bedType === 'Pure_FV' || bedType === 'Pure FV');
        if (!isPureFV && !isPureBed) {
            const hasSoilMpm = mpmObjects.some(o => 
                (o.material_name && String(o.material_name).toLowerCase().includes('soil')) ||
                (o.name && String(o.name).toLowerCase().includes('seabed')) ||
                (o.material_model === 'DruckerPrager' || o.material_model === 'MohrCoulomb' || o.material_model === 'Drucker-Prager' || o.material_model === 'Mohr-Coulomb')
            );
            if (!hasSoilMpm) {
                // Find connected or candidate seabed material node
                const seabedConn = state.connections.find(c => 
                    (c.toNode === solverNode3D.id && (c.toPort === 'seabed' || c.toPort === 'seabed_foundation' || c.toPort === 'foundation')) ||
                    (c.fromNode === solverNode3D.id && (c.fromPort === 'seabed' || c.fromPort === 'seabed_foundation' || c.fromPort === 'foundation'))
                );
                let seabedNode: Node | undefined;
                if (seabedConn) {
                    const seabedId = seabedConn.toNode === solverNode3D.id ? seabedConn.fromNode : seabedConn.toNode;
                    seabedNode = state.nodes.find(n => n.id === seabedId);
                } else if (solverNode3D.parameters?.seabed_foundation) {
                    seabedNode = state.nodes.find(n => n.id === solverNode3D.parameters.seabed_foundation);
                } else if (solverNode3D.parameters?.seabed_material) {
                    seabedNode = state.nodes.find(n => n.id === solverNode3D.parameters.seabed_material);
                } else {
                    seabedNode = state.nodes.find(n => n.type === 'Material' && (
                        isSeabedMaterialNode(n) || 
                        String((n as any).name || n.parameters?.name || n.id).toLowerCase().includes('seabed') ||
                        String(n.parameters?.preset || '').toLowerCase().includes('basalt') ||
                        String(n.parameters?.preset || '').toLowerCase().includes('rock') ||
                        String(n.parameters?.preset || '').toLowerCase().includes('soil')
                    ));
                }

                const seabedZ = Number(solverNode3D.parameters?.seabed_surface_z ?? flattenedParams['seabed_surface_z'] ?? 2.0);
                const chgX = Number(flattenedParams['charge_x'] ?? 0.0);
                const chgY = Number(flattenedParams['charge_y'] ?? 0.0);
                const soilDensity = Number(flattenedParams['soil_density'] ?? seabedNode?.parameters?.density ?? 2000.0);
                const soilFriction = Number(flattenedParams['soil_friction_angle'] ?? seabedNode?.parameters?.friction_angle ?? 30.0);
                const soilCohesion = Number(flattenedParams['soil_cohesion'] ?? seabedNode?.parameters?.cohesion ?? 1.0e4);

                let boxX = chgX;
                let boxY = chgY;
                let boxZ = 0.0;
                let sizeX = 5.0;
                let sizeY = 5.0;
                let sizeZ = 3.0;

                const isFullDomain = (bedType === 'Full_Domain_MPM' || bedType === 'Pure_MPM');
                if (isFullDomain) {
                    const xmin = Number(flattenedParams['xmin'] ?? -20.0);
                    const xmax = Number(flattenedParams['xmax'] ?? 20.0);
                    const ymin = Number(flattenedParams['ymin'] ?? -20.0);
                    const ymax = Number(flattenedParams['ymax'] ?? 20.0);
                    const zmin = Number(flattenedParams['zmin'] ?? 0.0);
                    sizeX = Math.max(0.1, xmax - xmin);
                    sizeY = Math.max(0.1, ymax - ymin);
                    sizeZ = Math.max(0.1, seabedZ - zmin);
                    boxX = 0.5 * (xmin + xmax);
                    boxY = 0.5 * (ymin + ymax);
                    boxZ = zmin + 0.5 * sizeZ;
                } else {
                    const sleeveR = Number(solverNode3D.parameters?.nearfield_sleeve_radius ?? 2.5);
                    const widthParam = Number(solverNode3D.parameters?.crater_bed_width ?? Math.max(5.0, 2.0 * sleeveR));
                    const depthParam = Number(solverNode3D.parameters?.crater_bed_depth ?? Math.max(3.0, sleeveR));
                    sizeX = widthParam;
                    sizeY = widthParam;
                    sizeZ = depthParam;
                    boxZ = seabedZ - 0.5 * sizeZ;
                }

                const sMatModel = seabedNode?.parameters?.material_model || 'DruckerPrager';
                const sMatName = (seabedNode as any)?.name || seabedNode?.parameters?.name || (seabedNode?.parameters?.preset ? `Seabed (${seabedNode.parameters.preset})` : 'Seabed Soil');
                const sMatId = seabedNode?.id || 'mat_seabed_soil';

                const soilObj: any = {
                    name: isFullDomain ? 'Full Domain Seabed' : 'Seabed Crater Bed',
                    shape_type: 'Box',
                    pos_x: boxX,
                    pos_y: boxY,
                    pos_z: boxZ,
                    size_x: sizeX,
                    size_y: sizeY,
                    size_z: sizeZ,
                    material_id: sMatId,
                    material_name: sMatName,
                    material_model: sMatModel,
                    density: soilDensity,
                    friction_angle: soilFriction,
                    cohesion: soilCohesion,
                    E: Number(seabedNode?.parameters?.youngs_modulus ?? seabedNode?.parameters?.E ?? 5.0e7),
                    nu: Number(seabedNode?.parameters?.poissons_ratio ?? seabedNode?.parameters?.nu ?? 0.35),
                    ppc: Number(solverNode3D.parameters?.nearfield_ppc ?? 8),
                    particle_distribution: 'Cartesian',
                    boundary_filling: 'Stairstepped'
                };

                if (seabedNode?.parameters) {
                    Object.entries(seabedNode.parameters).forEach(([k, v]) => {
                        soilObj[k] = numericKeys.includes(k) ? Number(v) : v;
                    });
                }
                // Ensure spatial dimensions and identity take precedence over copied parameters
                soilObj.pos_x = boxX;
                soilObj.pos_y = boxY;
                soilObj.pos_z = boxZ;
                soilObj.size_x = sizeX;
                soilObj.size_y = sizeY;
                soilObj.size_z = sizeZ;
                soilObj.shape_type = 'Box';
                soilObj.name = isFullDomain ? 'Full Domain Seabed' : 'Seabed Crater Bed';
                soilObj.material_id = sMatId;
                soilObj.material_name = sMatName;
                if (!soilObj.material_model) soilObj.material_model = sMatModel;

                mpmObjects.push(soilObj);
            }
        }
    }

    if (mpmObjects.length > 0) {
        flattenedParams['mpm_objects'] = mpmObjects;
    }
    return mpmObjects;
}

export function inheritFrom1DUpstream(
    state: SimulationState,
    remapNode2D: Node,
    modelId: string | undefined,
    flattenedParams: Record<string, any>,
    numericKeys: string[],
    booleanKeys: string[]
): void {
    const globalSM = (typeof window !== 'undefined' && (window as any).stateManager) ? (window as any).stateManager : null;
    const allModels: SimulationState[] = globalSM ? globalSM.getAllModels() : [state];
    const allNodes: any[] = allModels.flatMap(m => m.nodes);
    const allConns: any[] = allModels.flatMap(m => m.connections);

    // 1. Explicit source_model_id configured on remap node takes top precedence
    let sourceModel: SimulationState | undefined = undefined;
    if (remapNode2D.parameters?.source_model_id) {
        sourceModel = allModels.find(m => ((m as any).id || (m as any).modelId) === remapNode2D.parameters.source_model_id);
    }

    let source1DSolverNode: any = null;
    if (sourceModel) {
        source1DSolverNode = sourceModel.nodes.find(n => n.type === 'CFDSolver');
    }
    if (!source1DSolverNode && globalSM && globalSM.getAllPipes) {
        const pipes = globalSM.getAllPipes();
        const pipe = pipes.find((p: any) => p.targetModelId === modelId || p.toNodeId === remapNode2D.id);
        if (pipe) {
            const pipeSourceModel = allModels.find(m => ((m as any).id || (m as any).modelId) === (pipe.sourceModelId || pipe.model1dId));
            if (pipeSourceModel) {
                source1DSolverNode = pipeSourceModel.nodes.find(n => n.type === 'CFDSolver');
                if (!sourceModel) sourceModel = pipeSourceModel;
            }
        }
    }
    if (!source1DSolverNode) {
        const inConn = allConns.find(c => c.toNode === remapNode2D.id);
        if (inConn) {
            source1DSolverNode = allNodes.find(n => n.id === inConn.fromNode && n.type === 'CFDSolver');
        }
    }
    // Zero fallback: If no source 1D solver is specified or wired, do not inherit
    if (!source1DSolverNode && !sourceModel) {
        return;
    }
    if (!sourceModel && source1DSolverNode) {
        sourceModel = allModels.find(m => m.nodes.some(n => n.id === source1DSolverNode.id));
    }

    if (source1DSolverNode) {
        const sourceChargeNode = sourceModel?.nodes.find(n => n.type === 'Charge1D');
        const sourceMatNode = sourceModel?.nodes.find(n => n.type === 'Material' && (isJWLMaterialNode(n) || isIdealGasMaterialNode(n))) || sourceModel?.nodes.find(n => n.type === 'Material' && !isAirMaterialNode(n));
        const sourceAirNode = sourceModel?.nodes.find(n => n.type === 'Material' && isAirMaterialNode(n));

        if (sourceChargeNode && sourceChargeNode.parameters) {
            Object.entries(sourceChargeNode.parameters).forEach(([k, v]) => {
                if (flattenedParams[k] === undefined) {
                    flattenedParams[k] = numericKeys.includes(k) ? Number(v) : v;
                }
            });
            const r = Number(sourceChargeNode.parameters.charge_radius ?? 0.05);
            if (flattenedParams['charge_radius'] === undefined) flattenedParams['charge_radius'] = r;
            if (flattenedParams['explosive_radius'] === undefined) flattenedParams['explosive_radius'] = r;
        }

        if (sourceMatNode && sourceMatNode.parameters) {
            if (isJWLMaterialNode(sourceMatNode)) {
                if (!flattenedParams['explosive_type']) flattenedParams['explosive_type'] = 'MaterialExplosive';
                if (!flattenedParams['material_type']) flattenedParams['material_type'] = 'JWL Charge';
                flattenedParams['is_ideal_gas'] = false;
                extractJWLAndAfterburnParams(sourceMatNode, flattenedParams, numericKeys, booleanKeys);
            } else if (isIdealGasMaterialNode(sourceMatNode)) {
                if (!flattenedParams['explosive_type']) flattenedParams['explosive_type'] = 'MaterialIdealGas';
                if (!flattenedParams['material_type']) flattenedParams['material_type'] = 'Ideal Gas Charge';
                flattenedParams['is_ideal_gas'] = true;
                if (flattenedParams['gamma'] === undefined) flattenedParams['gamma'] = Number(sourceMatNode.parameters.gamma ?? sourceMatNode.parameters.ideal_gamma ?? 1.4);
                if (flattenedParams['rho'] === undefined) flattenedParams['rho'] = Number(sourceMatNode.parameters.density ?? sourceMatNode.parameters.ideal_rho_0 ?? 1630.0);
                if (flattenedParams['detonation_energy'] === undefined) flattenedParams['detonation_energy'] = Number(sourceMatNode.parameters.detonation_energy ?? sourceMatNode.parameters.ideal_e_0 ?? 4290000);
                if (sourceMatNode.parameters.composition !== undefined && flattenedParams['composition'] === undefined) {
                    flattenedParams['composition'] = sourceMatNode.parameters.composition;
                }
            }
        }

        if (sourceAirNode && sourceAirNode.parameters) {
            extractAirParams(sourceAirNode, flattenedParams, numericKeys);
        }
    }
}

export function inheritRemap3DUpstream(
    state: SimulationState,
    remapNode3D: Node,
    solverNode3D: Node | undefined,
    modelId: string | undefined,
    flattenedParams: Record<string, any>,
    numericKeys: string[],
    booleanKeys: string[]
): void {
    Object.entries(remapNode3D.parameters).forEach(([key, value]) => {
        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
    });

    // Find incoming connection to remap node (workspace-wide search across models & pipes)
    const globalSM = (typeof window !== 'undefined' && (window as any).stateManager) ? (window as any).stateManager : null;
    const allModels: SimulationState[] = globalSM ? globalSM.getAllModels() : [state];
    const allNodes: any[] = allModels.flatMap(m => m.nodes);
    const allConns: any[] = allModels.flatMap(m => m.connections);

    // 1. Explicit source_model_id configured on remap node takes top precedence
    let sourceModel: SimulationState | undefined = undefined;
    if (remapNode3D.parameters?.source_model_id) {
        sourceModel = allModels.find(m => ((m as any).id || (m as any).modelId) === remapNode3D.parameters.source_model_id);
    }

    let remapInConn = allConns.find(c => c.toNode === remapNode3D.id);
    let sourceSolverNode = remapInConn ? allNodes.find(n => n.id === remapInConn.fromNode) : null;

    if (!sourceSolverNode && sourceModel) {
        sourceSolverNode = sourceModel.nodes.find(n => n.type === 'CFDSolver2D' || n.type === 'CFDSolver') || null;
    }

    // If not found in standard connections, check model pipes
    if (!sourceSolverNode && globalSM && globalSM.getAllPipes) {
        const pipes = globalSM.getAllPipes();
        const pipe = pipes.find((p: any) => p.targetModelId === modelId || p.toNodeId === remapNode3D.id);
        if (pipe) {
            const pipeSourceModel = allModels.find(m => ((m as any).id || (m as any).modelId) === (pipe.sourceModelId || pipe.model2dId || pipe.model1dId));
            if (pipeSourceModel) {
                sourceSolverNode = pipeSourceModel.nodes.find(n => n.type === 'CFDSolver2D' || n.type === 'CFDSolver');
                if (!sourceModel) sourceModel = pipeSourceModel;
            }
        }
    }

    // Zero fallback: If no upstream solver or model is specified, do NOT guess or inherit
    if (!sourceSolverNode && !sourceModel) {
        return;
    }

    if (!sourceModel && sourceSolverNode) {
        sourceModel = allModels.find(m => m.nodes.some(n => n.id === sourceSolverNode.id));
    }

    let sourceChargeNode: any = null;
    let sourceMatNode: any = null;
    if (sourceModel) {
        const chargeConn = sourceModel.connections?.find(c =>
            sourceSolverNode && c.toNode === sourceSolverNode.id && (c.toPort === 'charge' || c.toPort === 'explosive')
        );
        sourceChargeNode = chargeConn ? sourceModel.nodes.find(n => n.id === chargeConn.fromNode) : sourceModel.nodes.find(n => n.type === 'Charge2D' || n.type === 'Charge1D');

        if (sourceChargeNode) {
            const matConn = sourceModel.connections?.find(c =>
                (c.toNode === sourceChargeNode.id && c.toPort === 'material') ||
                (c.fromNode === sourceChargeNode.id && c.fromPort === 'material')
            );
            sourceMatNode = matConn ? (matConn.toNode === sourceChargeNode.id ? sourceModel.nodes.find(n => n.id === matConn.fromNode) : sourceModel.nodes.find(n => n.id === matConn.toNode)) : null;
            if (!sourceMatNode && sourceChargeNode.parameters?.material) {
                sourceMatNode = sourceModel.nodes.find(n => n.id === sourceChargeNode.parameters.material);
            }
            if (!sourceMatNode) {
                sourceMatNode = sourceModel.nodes.find(n => n.type === 'Material' && (isJWLMaterialNode(n) || isIdealGasMaterialNode(n))) || sourceModel.nodes.find(n => n.type === 'Material' && !isAirMaterialNode(n));
            }
        }
    } else if (sourceSolverNode) {
        const chargeConn = allConns.find(c => c.toNode === sourceSolverNode.id && (c.toPort === 'charge' || c.toPort === 'explosive'));
        sourceChargeNode = chargeConn ? allNodes.find(n => n.id === chargeConn.fromNode) : null;
        if (!sourceChargeNode) {
            const sm = allModels.find(m => m.nodes.some(n => n.id === sourceSolverNode.id));
            sourceChargeNode = sm?.nodes.find(n => n.type === 'Charge2D' || n.type === 'Charge1D');
        }

        if (sourceChargeNode) {
            const matConn = allConns.find(c => (c.toNode === sourceChargeNode.id && c.toPort === 'material') || (c.fromNode === sourceChargeNode.id && c.fromPort === 'material'));
            sourceMatNode = matConn ? (matConn.toNode === sourceChargeNode.id ? allNodes.find(n => n.id === matConn.fromNode) : allNodes.find(n => n.id === matConn.toNode)) : null;
            if (!sourceMatNode && sourceChargeNode.parameters?.material) {
                sourceMatNode = allNodes.find(n => n.id === sourceChargeNode.parameters.material);
            }
            if (!sourceMatNode) {
                const sm = allModels.find(m => m.nodes.some(n => n.id === sourceChargeNode.id));
                sourceMatNode = sm?.nodes.find(n => n.type === 'Material' && (isJWLMaterialNode(n) || isIdealGasMaterialNode(n))) || sm?.nodes.find(n => n.type === 'Material');
            }
        }
    }

    // Copy over charge parameters from source charge node if present
    if (sourceChargeNode && sourceChargeNode.parameters) {
        Object.entries(sourceChargeNode.parameters).forEach(([key, value]) => {
            if (flattenedParams[key] === undefined) {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            }
        });
        const r = Number(sourceChargeNode.parameters.charge_radius ?? sourceChargeNode.parameters.explosive_radius ?? 0.05);
        if (flattenedParams['charge_radius'] === undefined) flattenedParams['charge_radius'] = r;
        if (flattenedParams['explosive_radius'] === undefined) flattenedParams['explosive_radius'] = r;
    }

    // Copy over material parameters from source material node if present
    if (sourceMatNode && sourceMatNode.parameters) {
        if (isIdealGasMaterialNode(sourceMatNode)) {
            flattenedParams['explosive_type'] = 'MaterialIdealGas';
            flattenedParams['material_type'] = 'Ideal Gas Charge';
            flattenedParams['is_ideal_gas'] = true;
            flattenedParams['gamma'] = Number(sourceMatNode.parameters.gamma ?? sourceMatNode.parameters.ideal_gamma ?? 1.4);
            flattenedParams['rho'] = Number(sourceMatNode.parameters.density ?? sourceMatNode.parameters.ideal_rho_0 ?? 1630.0);
            flattenedParams['detonation_energy'] = Number(sourceMatNode.parameters.detonation_energy ?? sourceMatNode.parameters.ideal_e_0 ?? 4290000);
            if (sourceMatNode.parameters.composition !== undefined) {
                flattenedParams['composition'] = sourceMatNode.parameters.composition;
            }
        } else if (isJWLMaterialNode(sourceMatNode)) {
            flattenedParams['explosive_type'] = 'MaterialExplosive';
            flattenedParams['material_type'] = 'JWL Charge';
            flattenedParams['is_ideal_gas'] = false;
            extractJWLAndAfterburnParams(sourceMatNode, flattenedParams, numericKeys, booleanKeys);
        }
    }

    // Inherit air and atmosphere parameters from source model if present
    let sourceAirNode: any = null;
    if (sourceModel) {
        const airConn = sourceModel.connections?.find(c => sourceSolverNode && c.toNode === sourceSolverNode.id && c.toPort === 'air');
        sourceAirNode = airConn ? sourceModel.nodes.find(n => n.id === airConn.fromNode) : sourceModel.nodes.find(n => n.type === 'Material' && isAirMaterialNode(n));
    } else if (sourceSolverNode) {
        const airConn = allConns.find(c => c.toNode === sourceSolverNode.id && c.toPort === 'air');
        sourceAirNode = airConn ? allNodes.find(n => n.id === airConn.fromNode) : null;
        if (!sourceAirNode) {
            const sm = allModels.find(m => m.nodes.some(n => n.id === sourceSolverNode.id));
            sourceAirNode = sm?.nodes.find(n => n.type === 'Material' && isAirMaterialNode(n));
        }
    }
    if (sourceAirNode && sourceAirNode.parameters) {
        extractAirParams(sourceAirNode, flattenedParams, numericKeys);
    }

    // Also check source solver parameters as fallback
    const sourceInitMode = sourceSolverNode?.parameters?.init_mode;
    const sourceExpType = sourceSolverNode?.parameters?.explosive_type;
    const isIdealGasSource = (
        sourceInitMode === 'Ideal Gas' ||
        sourceExpType === 'MaterialIdealGas' ||
        flattenedParams['explosive_type'] === 'MaterialIdealGas' ||
        flattenedParams['material_type'] === 'Ideal Gas Charge'
    );

    if (isIdealGasSource) {
        flattenedParams['explosive_type'] = 'MaterialIdealGas';
        flattenedParams['material_type'] = 'Ideal Gas Charge';
        flattenedParams['is_ideal_gas'] = true;
    } else {
        if (!flattenedParams['explosive_type']) flattenedParams['explosive_type'] = 'MaterialExplosive';
        flattenedParams['is_ideal_gas'] = false;
    }

    if (remapNode3D.type === 'Remap2DTo3DNode') {
        flattenedParams['init_mode'] = 'From2D';
    } else {
        flattenedParams['init_mode'] = 'From1D';
    }
}


export function serializeSimulationState(state: SimulationState): string {
    const strippedNodes = state.nodes.map(({ x, y, ...rest }) => rest);
    const dag = {
        nodes: strippedNodes,
        connections: state.connections
    };
    return JSON.stringify({
        command: "EXECUTE",
        dag: dag
    });
}

export function serializeForSolver(state: SimulationState, command: string = "INIT", modelId?: string, modelFilename?: string | null): string {
    const strippedNodes = state.nodes.map(({ x, y, ...rest }) => rest);

    const numericKeys = [
        'domain_radius', 'cell_size', 'atm_pressure', 'atm_temperature',
        'charge_mass', 'rho', 'detonation_energy', 'jwl_A', 'jwl_B',
        'jwl_R1', 'jwl_R2', 'jwl_omega', 'det_vel', 'cfl', 'endtime',
        'spatial_order', 'temporal_order', 'gamma', 'plot_stride', 'refresh_rate', 'fps',
        'ascii_precision', 'step_interval', 'time_interval', 'downsample_stride', 'tessellation_max_edge',
        'telemetry_channel', 'telemetry_interval_ms', 'vtk_step_interval',
        // 2D CFD keys
        'nr', 'nz', 'max_r', 'max_z', 'explosive_x', 'explosive_y', 'explosive_z', 'explosive_radius', 'remap_radius', 'explosive_r', 'trigger_val',
        'charge_r', 'charge_z', 'charge_radius', 'charge_height', 'charge_aspect_ratio',
        'detonator_r', 'detonator_z', 'detonator_radius', 'detonator_x', 'detonator_y',
        'trigger_r', 'trigger_z', 'trigger_radius', 'trigger_x', 'trigger_y',
        'ideal_gamma', 'ideal_rho_0', 'ideal_e_0', 'high_rho', 'ambient_rho', 'ambient_p',
        // 3D CFD keys
        'nx', 'ny', 'nz', 'xmax', 'ymax', 'zmax',
        'charge_x', 'charge_y', 'charge_z', 'charge_lx', 'charge_ly', 'charge_lz',
        'charge_rot_x', 'charge_rot_y', 'charge_rot_z',
        'detonator_x', 'detonator_y', 'detonator_z', 'trigger_x', 'trigger_y', 'trigger_z', 'xmin', 'ymin', 'zmin',
        'scale_factor',
        'min_y', 'max_y', 'min_val', 'max_val', 'stl_min_val', 'stl_max_val', 'obstacles_min_val', 'obstacles_max_val', 'ambientLevel', 'specularIntensity', 'aoRadius', 'aoIntensity', 'aoBias', 'gauge_size', 'gauge_opacity', 'stl_opacity', 'obstacles_opacity', 'grid_opacity',
        'charge_opacity', 'detonators_size', 'detonator_size', 'detonators_opacity', 'detonator_opacity', 'triggers_size', 'trigger_size', 'triggers_opacity', 'trigger_opacity',
        'amr_max_levels', 'amr_threshold', 'amr_coarsen_ratio', 'amr_tile_size',
        'center_x', 'center_y', 'center_z', 'size_x', 'size_y', 'size_z', 'radius', 'height', 'length',
        'offset', 'stride',
        // MPM keys
        'pos_x', 'pos_y', 'pos_z', 'size_x', 'size_y', 'size_z', 'vel_x', 'vel_y', 'vel_z', 'initial_velocity_x', 'initial_velocity_y', 'initial_velocity_z', 'initial_velocity_r', 'radius', 'inner_radius',
        'scale_x', 'scale_y', 'scale_z',
        'rot_x', 'rot_y', 'rot_z',
        'stl_scale_x', 'stl_scale_y', 'stl_scale_z', 'stl_pos_x', 'stl_pos_y', 'stl_pos_z', 'stl_rot_x', 'stl_rot_y', 'stl_rot_z',
        'angular_vel', 'angular_vel_x', 'angular_vel_y', 'angular_vel_z',
        'density', 'youngs_modulus', 'poissons_ratio', 'yield_stress', 'hardening_modulus',
        'failure_strain', 'tensile_failure_stress', 'erosion_strain', 'erosion_stress',
        'jc_A', 'jc_B', 'jc_n', 'jc_C', 'jc_m', 'jc_d1', 'jc_d2', 'jc_d3', 'jc_d4', 'jc_d5', 'T_melt', 'T_room', 'Cp',
        'weibull_modulus', 'weibull_scale', 'weibull_ref_volume',
        'anisotropy_ratio', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z',
        'mg_gamma0', 'mg_c0', 'mg_s',
        'ppc',
        'mpmParticleDiameter', 'mpmParticleSize', 'mpmParticleMinVal', 'mpmParticleMaxVal', 'mpmParticleOpacity', 'flip_blend',
        'dem_friction', 'dem_restitution', 'dem_contact_scale', 'dem_velocity_threshold',
        'sdf_barrier_restitution', 'sdf_barrier_friction', 'sdf_barrier_skin',
        // FEM keys
        'hourglass_coeff', 'bulk_viscosity_b1', 'bulk_viscosity_b2', 'timestep_erosion_factor', 'min_volume_ratio', 'contact_stiffness', 'contact_penalty_scale', 'friction_static', 'friction_kinetic', 'contact_damping',
        'mpm_particles_per_failed_element', 'material_heterogeneity', 'debris_velocity_smoothing', 'debris_clumping', 'debris_max_clump_size', 'random_seed', 'rebar_diameter', 'rebar_area', 'beamRadius', 'beam_radius', 'beam_area', 'beamMinVal', 'beamMaxVal',
        'rebarRadius', 'viewport_refresh_rate', 'node1_x', 'node1_y', 'node1_z', 'node2_x', 'node2_y', 'node2_z',
        'femMinVal', 'femMaxVal', 'femOpacity', 'femContourLevels', 'sliceContourLevels', 'beamContourLevels', 'mpmContourLevels', 'vacuum_density', 'vacuum_pressure', 'uncovering_tolerance',
        // Concrete Core & Models (RHT, K&C, CSCM)
        'fc', 'ft', 'G_f', 'moisture_content', 'dif_cap_compression', 'dif_cap_tension',
        'rht_A', 'rht_N', 'rht_B', 'rht_M', 'rht_Q0', 'rht_BQ', 'rht_D1', 'rht_D2',
        'rht_p_crush', 'rht_p_lock', 'rht_alpha0', 'rht_n_comp', 'rht_betac', 'rht_deltat',
        'kc_a0', 'kc_a1', 'kc_a2', 'kc_a0y', 'kc_a1y', 'kc_a2y', 'kc_a1r', 'kc_a2r', 'kc_b1', 'kc_omega',
        'cscm_alpha', 'cscm_theta', 'cscm_lambda', 'cscm_beta', 'cscm_R', 'cscm_X0', 'cscm_W', 'cscm_D1', 'cscm_D2',
        // Hyperelastic, CDP, and Hill48 Keys
        'yeoh_c10', 'yeoh_c20', 'yeoh_c30', 'mr_c10', 'mr_c01', 'k_bulk',
        'cdp_f_t0', 'cdp_f_c0', 'cdp_g_f', 'cdp_l_ch',
        'hill_F', 'hill_G', 'hill_H', 'hill_L', 'hill_M', 'hill_N', 'hill_sigma_y0',
        // Tait Water & Shock Fluid Keys
        'tait_gamma', 'tait_B', 'tait_rho0', 'tait_c0', 'tait_p_cav', 'tait_p0', 'tait_viscosity', 'tait_gruneisen', 'tait_variant',
        // Davis & CREST Reactive Burn
        'davis_c0', 'davis_s1', 'davis_gamma0', 'davis_cv', 'davis_t0', 'davis_rho0',
        'davis_a', 'davis_b', 'davis_k', 'davis_vc', 'davis_pc', 'davis_q_det',
        'crest_b1', 'crest_c1', 'crest_m1', 'crest_b2', 'crest_c2', 'crest_c3', 'crest_m2', 'crest_s0', 'crest_s_threshold',
        'initiation_radius', 'booster_overpressure',
        // JWL Programmed Burn & Lee-Tarver Ignition & Growth
        'burn_zone_cells', 'tau_burn_min',
        'lt_I', 'lt_a', 'lt_b', 'lt_x',
        'lt_G1', 'lt_c', 'lt_d', 'lt_y',
        'lt_G2', 'lt_e', 'lt_g', 'lt_z',
        'lt_F_ig_max', 'lt_F_G1_max', 'lt_F_G2_min',
        // Afterburn & Aerobic Combustion
        'afterburn_energy', 'afterburn_fuel_fraction', 'afterburn_stoich_ratio',
        'afterburn_ignition_temp', 'afterburn_tau_chem', 'afterburn_c_edc', 'afterburn_tau_expansion',
        'afterburn_ambient_o2_fraction', 'ambient_o2_fraction',
        // VTK ROI & Strides
        'roi_xmin', 'roi_xmax', 'roi_ymin', 'roi_ymax', 'roi_zmin', 'roi_zmax', 'volume_stride', 'slice_stride',
        'nonlocal_radius', 'opacity',
        // Lysmer-Kuhlemeyer Absorbing Boundaries
        'lysmer_rho', 'lysmer_cp', 'lysmer_cs', 'lysmer_normal_relaxation', 'lysmer_shear_relaxation',
        'lysmer_x_min', 'lysmer_x_max', 'lysmer_y_min', 'lysmer_y_max', 'lysmer_z_min', 'lysmer_z_max', 'lysmer_tol',
        // Zonal MPM-to-FV Water Handoff Sleeve & Symplectic Multi-Rate Subcycling
        'hybrid_sleeve_radius', 'hybrid_overlap_thickness', 'hybrid_subcycles', 'hybrid_macro_dt',
        // Virtual Gauges Massive & External Dataset Keys
        'sampling_stride_steps', 'external_probe_count',
        'external_bounds_min_x', 'external_bounds_max_x',
        'external_bounds_min_y', 'external_bounds_max_y',
        'external_bounds_min_z', 'external_bounds_max_z',
        // TelemetryText Keys
        'font_size', 'buffer_capacity',
        // Camera & Viewport Navigation Keys
        'camera_fov', 'camera_pitch', 'camera_yaw', 'camera_distance',
        'target_x', 'target_y', 'target_z',
        // Marine Blast & UNDEX Zonal Keys
        'water_surface_z', 'seabed_surface_z', 'gravity_z', 'k0_earth_pressure', 'nearfield_sleeve_radius', 'nearfield_ppc', 'weber_breakup_threshold',
        'soil_density', 'soil_friction_angle', 'soil_cohesion', 'crater_bed_width', 'crater_bed_depth',
        'friction_angle', 'cohesion', 'dilation_angle', 'tensile_cutoff',
        'soil_c0', 'seabed_c0', 'soil_gamma', 'seabed_gamma', 'soil_s', 'seabed_s', 'soil_gruneisen', 'seabed_gruneisen', 'soil_p_cav', 'seabed_p_cav', 'soil_eos_variant',
        'dp_cohesion', 'dp_friction_angle', 'dp_dilatancy_angle', 'dp_tensile_cutoff', 'dp_hardening_modulus'
    ];

    const booleanKeys = [
        'enabled', 'afterburn_enabled', 'smooth_plastic_strain', 'enable_sdf_barrier', 'enable_dem_contact', 'export_ascii', 'export_binary', 'export_hdf5',
        'include_header', 'qty_pressure', 'qty_density', 'qty_velocity', 'qty_energy',
        'qty_reacted', 'qty_unreacted', 'qty_air', 'qty_materials', 'qty_water', 'qty_soil',
        'qty_mpm_pressure', 'qty_mpm_material_id',
        'qty_overpressure', 'qty_impulse',
        'export_slices', 'export_volumes', 'export_fem', 'export_mpm', 'export_pvd',
        'roi_enabled', 'is_ideal_gas', 'directional_crack_band', 'enable_heterogeneity',
        'enable_anisotropy', 'enable_strain_erosion', 'enable_stress_erosion',
        'enable_timestep_erosion', 'kc_auto_generate',
        'convert_failed_elements_to_mpm', 'use_pvd_collection', 'enable_compression',
        'export_raw_binary', 'show_stl', 'stl_show_results',
        'show_timing_breakdown', 'show_memory', 'show_wallclock', 'show_dt',
        'vertical_sleeve_breach'
    ];

    const castParam = (key: string, value: any): any => {
        if (value === 'true' || value === 'True') return true;
        if (value === 'false' || value === 'False') return false;
        if (numericKeys.includes(key)) {
            const num = Number(value);
            return isNaN(num) ? value : num;
        }
        if (booleanKeys.includes(key)) {
            return value === true || value === 'true' || value === 'True' || value === 1 || value === '1';
        }
        return value;
    };

    const flattenedParams: Record<string, any> = {};

    // 1. Trace 1D Solver if it exists
    const solverNode = state.nodes.find(n => n.type === 'CFDSolver');
    if (solverNode) {
        Object.entries(solverNode.parameters).forEach(([key, value]) => {
            flattenedParams[key] = castParam(key, value);
        });

        // 1. Direct connections on 1D CFDSolver (mesh, air, charge)
        const directMeshConn = state.connections.find(c => c.toNode === solverNode.id && c.toPort === 'mesh');
        if (directMeshConn) {
            const meshNode = state.nodes.find(n => n.id === directMeshConn.fromNode);
            if (meshNode) {
                Object.entries(meshNode.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = castParam(key, value);
                });
            }
        }

        const directAirConn = state.connections.find(c => c.toNode === solverNode.id && c.toPort === 'air');
        if (directAirConn) {
            const airNode = state.nodes.find(n => n.id === directAirConn.fromNode);
            if (airNode && isAirMaterialNode(airNode)) {
                extractAirParams(airNode, flattenedParams, numericKeys);
            }
        }

        const directChargeConn = state.connections.find(c => c.toNode === solverNode.id && (c.toPort === 'charge' || c.toPort === 'explosive'));
        if (directChargeConn) {
            const chargeNode = state.nodes.find(n => n.id === directChargeConn.fromNode);
            if (chargeNode && chargeNode.type === 'Charge1D') {
                Object.entries(chargeNode.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
                const radius = Number(chargeNode.parameters?.charge_radius ?? 0.05);
                flattenedParams['charge_radius'] = radius;
                flattenedParams['explosive_radius'] = radius;

                let matNode: Node | undefined;
                const matConn = state.connections.find(c => (c.toNode === chargeNode.id && c.toPort === 'material') || (c.fromNode === chargeNode.id && c.fromPort === 'material'));
                if (matConn) {
                    const otherId = matConn.toNode === chargeNode.id ? matConn.fromNode : matConn.toNode;
                    matNode = state.nodes.find(n => n.id === otherId);
                } else if (chargeNode.parameters?.material) {
                    matNode = state.nodes.find(n => n.id === chargeNode.parameters.material);
                }
                if (!matNode) {
                    matNode = state.nodes.find(n => n.type === 'Material' && (isJWLMaterialNode(n) || isIdealGasMaterialNode(n)));
                }
                if (matNode) {
                    if (isJWLMaterialNode(matNode)) {
                        flattenedParams['explosive_type'] = 'MaterialExplosive';
                        flattenedParams['material_type'] = 'JWL Charge';
                        extractJWLAndAfterburnParams(matNode, flattenedParams, numericKeys, booleanKeys);
                    } else if (isIdealGasMaterialNode(matNode)) {
                        flattenedParams['explosive_type'] = 'MaterialIdealGas';
                        flattenedParams['material_type'] = 'Ideal Gas Charge';
                        flattenedParams['gamma'] = Number(matNode.parameters?.gamma ?? matNode.parameters?.ideal_gamma ?? 1.4);
                        flattenedParams['rho'] = Number(matNode.parameters?.density ?? matNode.parameters?.ideal_rho_0 ?? 1630.0);
                        flattenedParams['detonation_energy'] = Number(matNode.parameters?.detonation_energy ?? matNode.parameters?.ideal_e_0 ?? 4290000);
                        flattenedParams['ideal_gamma'] = Number(matNode.parameters?.gamma ?? matNode.parameters?.ideal_gamma ?? 1.4);
                        flattenedParams['ideal_rho_0'] = Number(matNode.parameters?.density ?? matNode.parameters?.ideal_rho_0 ?? 1630.0);
                        flattenedParams['ideal_e_0'] = Number(matNode.parameters?.detonation_energy ?? matNode.parameters?.ideal_e_0 ?? 4290000);
                        if (matNode.parameters?.composition !== undefined) {
                            flattenedParams['composition'] = matNode.parameters.composition;
                        }
                    }
                }
            }
        }

        // 2. Legacy ThePainter connection on port 'in'
        const solverConn = state.connections.find(c => c.toNode === solverNode.id && c.toPort === 'in');
        if (solverConn) {
            const painterNode = state.nodes.find(n => n.id === solverConn.fromNode);
            if (painterNode && painterNode.type === 'ThePainter') {
                const meshConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'mesh');
                if (meshConn) {
                    const meshNode = state.nodes.find(n => n.id === meshConn.fromNode);
                    if (meshNode) {
                        Object.entries(meshNode.parameters).forEach(([key, value]) => {
                            flattenedParams[key] = castParam(key, value);
                        });
                    }
                }

                const airConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'air');
                if (airConn) {
                    const airNode = state.nodes.find(n => n.id === airConn.fromNode);
                    if (airNode && isAirMaterialNode(airNode)) {
                        extractAirParams(airNode, flattenedParams, numericKeys);
                    }
                }

                const expConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'explosive');
                if (expConn) {
                    const chargeNode = state.nodes.find(n => n.id === expConn.fromNode);
                    if (chargeNode && chargeNode.type === 'Charge1D') {
                        // Copy all parameters (e.g. charge_mass)
                        Object.entries(chargeNode.parameters).forEach(([key, value]) => {
                            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                        });
                        // Radius comes from Charge1D parameter
                        const radius = Number(chargeNode.parameters?.charge_radius ?? 0.05);
                        flattenedParams['charge_radius'] = radius;
                        flattenedParams['explosive_radius'] = radius;

                        // Trace to Material node
                        let matNode: Node | undefined;
                        const matConn = state.connections.find(c => (c.toNode === chargeNode.id && c.toPort === 'material') || (c.fromNode === chargeNode.id && c.fromPort === 'material'));
                        if (matConn) {
                            const otherId = matConn.toNode === chargeNode.id ? matConn.fromNode : matConn.toNode;
                            matNode = state.nodes.find(n => n.id === otherId);
                        } else if (chargeNode.parameters?.material) {
                            matNode = state.nodes.find(n => n.id === chargeNode.parameters.material);
                        }
                        if (!matNode) {
                            matNode = state.nodes.find(n => n.type === 'Material' && (isJWLMaterialNode(n) || isIdealGasMaterialNode(n)));
                        }
                        if (matNode) {
                            if (isJWLMaterialNode(matNode)) {
                                flattenedParams['explosive_type'] = 'MaterialExplosive';
                                flattenedParams['material_type'] = 'JWL Charge';
                                extractJWLAndAfterburnParams(matNode, flattenedParams, numericKeys, booleanKeys);
                            } else if (isIdealGasMaterialNode(matNode)) {
                                flattenedParams['explosive_type'] = 'MaterialIdealGas';
                                flattenedParams['material_type'] = 'Ideal Gas Charge';
                                flattenedParams['gamma'] = Number(matNode.parameters?.gamma ?? matNode.parameters?.ideal_gamma ?? 1.4);
                                flattenedParams['rho'] = Number(matNode.parameters?.density ?? matNode.parameters?.ideal_rho_0 ?? 1630.0);
                                flattenedParams['detonation_energy'] = Number(matNode.parameters?.detonation_energy ?? matNode.parameters?.ideal_e_0 ?? 4290000);
                                flattenedParams['ideal_gamma'] = Number(matNode.parameters?.gamma ?? matNode.parameters?.ideal_gamma ?? 1.4);
                                flattenedParams['ideal_rho_0'] = Number(matNode.parameters?.density ?? matNode.parameters?.ideal_rho_0 ?? 1630.0);
                                flattenedParams['ideal_e_0'] = Number(matNode.parameters?.detonation_energy ?? matNode.parameters?.ideal_e_0 ?? 4290000);
                                if (matNode.parameters?.composition !== undefined) {
                                    flattenedParams['composition'] = matNode.parameters.composition;
                                }
                            }
                        }
                    }
                }
            }
        }

        // Direct-connection fallback: if ThePainter was not used, extract from DomainMesh, Charge1D, and Material directly
        if (flattenedParams['domain_radius'] === undefined || flattenedParams['cell_size'] === undefined) {
            const meshNode = state.nodes.find(n => n.type === 'DomainMesh');
            if (meshNode) {
                Object.entries(meshNode.parameters).forEach(([key, value]) => {
                    if (flattenedParams[key] === undefined) {
                        flattenedParams[key] = castParam(key, value);
                    }
                });
            }
        }
        if (flattenedParams['charge_mass'] === undefined) {
            const chargeNode = state.nodes.find(n => n.type === 'Charge1D');
            if (chargeNode) {
                Object.entries(chargeNode.parameters).forEach(([key, value]) => {
                    if (flattenedParams[key] === undefined) {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    }
                });
                const radius = Number(chargeNode.parameters?.charge_radius ?? 0.05);
                if (flattenedParams['charge_radius'] === undefined) flattenedParams['charge_radius'] = radius;
                if (flattenedParams['explosive_radius'] === undefined) flattenedParams['explosive_radius'] = radius;
            }
        }
        if (flattenedParams['explosive_type'] === undefined && flattenedParams['material_type'] === undefined) {
            const matNode = state.nodes.find(n => n.type === 'Material' && (isJWLMaterialNode(n) || isIdealGasMaterialNode(n)));
            if (matNode) {
                if (isJWLMaterialNode(matNode)) {
                    flattenedParams['explosive_type'] = 'MaterialExplosive';
                    flattenedParams['material_type'] = 'JWL Charge';
                    extractJWLAndAfterburnParams(matNode, flattenedParams, numericKeys, booleanKeys);
                } else if (isIdealGasMaterialNode(matNode)) {
                    flattenedParams['explosive_type'] = 'MaterialIdealGas';
                    flattenedParams['material_type'] = 'Ideal Gas Charge';
                    flattenedParams['gamma'] = Number(matNode.parameters?.gamma ?? matNode.parameters?.ideal_gamma ?? 1.4);
                    flattenedParams['rho'] = Number(matNode.parameters?.density ?? matNode.parameters?.ideal_rho_0 ?? 1630.0);
                    flattenedParams['detonation_energy'] = Number(matNode.parameters?.detonation_energy ?? matNode.parameters?.ideal_e_0 ?? 4290000);
                }
            }
        }
        if (flattenedParams['atm_pressure'] === undefined) {
            const airNode = state.nodes.find(n => n.type === 'Material' && isAirMaterialNode(n));
            if (airNode) {
                extractAirParams(airNode, flattenedParams, numericKeys);
            }
        }
    }

    // 3. Trace 3D Solver if it exists
    const solverNode3D = state.nodes.find(n => n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain');
    if (solverNode3D) {
        Object.entries(solverNode3D.parameters).forEach(([key, value]) => {
            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
        });

        // Trace STL or Primitive Geometry for CFD Solver 3D
        const stlConn = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'stl');
        if (stlConn) {
            const stlNode = state.nodes.find(n => n.id === stlConn.fromNode);
            if (stlNode && stlNode.type === 'STLGeometry') {
                flattenedParams['stl_file'] = resolveResourcePath(stlNode.parameters.stl_file || '', modelFilename);
                const baseHash = stlNode.parameters.geometry_hash || '';
                const transformSig = `${stlNode.parameters.origin_mode || 'CAD Origin'}_${stlNode.parameters.scale_x ?? 1}_${stlNode.parameters.scale_y ?? 1}_${stlNode.parameters.scale_z ?? 1}_${stlNode.parameters.pos_x ?? 0}_${stlNode.parameters.pos_y ?? 0}_${stlNode.parameters.pos_z ?? 0}_${stlNode.parameters.rot_x ?? 0}_${stlNode.parameters.rot_y ?? 0}_${stlNode.parameters.rot_z ?? 0}`;
                flattenedParams['geometry_hash'] = baseHash ? `${baseHash}_${transformSig}` : transformSig;
                flattenedParams['voxelization_method'] = stlNode.parameters.voxelization_method || 'watertight_floodfill';
                flattenedParams['stl_origin_mode'] = stlNode.parameters.origin_mode || 'CAD Origin';
                flattenedParams['stl_scale_x'] = Number(stlNode.parameters.scale_x ?? 1.0);
                flattenedParams['stl_scale_y'] = Number(stlNode.parameters.scale_y ?? 1.0);
                flattenedParams['stl_scale_z'] = Number(stlNode.parameters.scale_z ?? 1.0);
                flattenedParams['stl_pos_x'] = Number(stlNode.parameters.pos_x ?? 0.0);
                flattenedParams['stl_pos_y'] = Number(stlNode.parameters.pos_y ?? 0.0);
                flattenedParams['stl_pos_z'] = Number(stlNode.parameters.pos_z ?? 0.0);
                flattenedParams['stl_rot_x'] = Number(stlNode.parameters.rot_x ?? 0.0);
                flattenedParams['stl_rot_y'] = Number(stlNode.parameters.rot_y ?? 0.0);
                flattenedParams['stl_rot_z'] = Number(stlNode.parameters.rot_z ?? 0.0);
            } else if (stlNode && stlNode.type === 'PrimitiveGeometry3D') {
                flattenedParams['primitives'] = stlNode.parameters.primitives || [];
                const primsStr = JSON.stringify(stlNode.parameters.primitives || []) + '_' + (stlNode.parameters.voxelization_method || 'watertight_floodfill');
                let hash = 5381;
                for (let i = 0; i < primsStr.length; i++) {
                    hash = ((hash << 5) + hash) + primsStr.charCodeAt(i);
                    hash = hash & hash;
                }
                flattenedParams['geometry_hash'] = 'prims_' + Math.abs(hash).toString(16);
                flattenedParams['voxelization_method'] = stlNode.parameters.voxelization_method || 'watertight_floodfill';
            }
        } else {
            flattenedParams['stl_file'] = '';
            flattenedParams['primitives'] = [];
            flattenedParams['geometry_hash'] = '';
        }

        // Find the DomainMesh3D connected to CFDSolver3D.mesh
        const meshConn3D = state.connections.find(c => 
            (c.toNode === solverNode3D.id && c.toPort === 'mesh') ||
            (c.fromNode === solverNode3D.id && c.fromPort === 'mesh')
        );
        if (meshConn3D) {
            const meshId = meshConn3D.toNode === solverNode3D.id ? meshConn3D.fromNode : meshConn3D.toNode;
            const rootDomainNode = state.nodes.find(n => n.id === meshId);
            if (rootDomainNode && rootDomainNode.type === 'DomainMesh3D') {
                Object.entries(rootDomainNode.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }

        // Fallback: if xmin/xmax is still undefined, check for any DomainMesh3D in the graph
        if (flattenedParams['xmin'] === undefined && flattenedParams['xmax'] === undefined) {
            const rootDomainMesh = state.nodes.find(n => n.type === 'DomainMesh3D');
            if (rootDomainMesh) {
                Object.entries(rootDomainMesh.parameters).forEach(([key, value]) => {
                    if (flattenedParams[key] === undefined) {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    }
                });
            }
        }

        // Trace Air for CFD Solver 3D
        const airConn3D = state.connections.find(c => 
            (c.toNode === solverNode3D.id && c.toPort === 'air') ||
            (c.fromNode === solverNode3D.id && c.fromPort === 'air')
        );
        if (airConn3D) {
            const airId = airConn3D.toNode === solverNode3D.id ? airConn3D.fromNode : airConn3D.toNode;
            const airNode3D = state.nodes.find(n => n.id === airId);
            if (airNode3D && isAirMaterialNode(airNode3D)) {
                extractAirParams(airNode3D, flattenedParams, numericKeys);
            }
        }

        // Trace Water and Seabed for CFD Solver 3D / Marine Harbour Domain
        extractUnderwaterParams(state, solverNode3D, flattenedParams, numericKeys);

        // Trace Charge 3D
        let chargeNode3D: Node | undefined;
        const chargeConn3D = state.connections.find(c => 
            (c.toNode === solverNode3D.id && (c.toPort === 'charge' || c.toPort === 'explosive')) ||
            (c.fromNode === solverNode3D.id && (c.fromPort === 'charge' || c.fromPort === 'explosive'))
        );
        if (chargeConn3D) {
            const otherId = chargeConn3D.toNode === solverNode3D.id ? chargeConn3D.fromNode : chargeConn3D.toNode;
            chargeNode3D = state.nodes.find(n => n.id === otherId);
        } else {
            chargeNode3D = state.nodes.find(n => n.type === 'Charge3D');
        }

        if (chargeNode3D) {
            Object.entries(chargeNode3D.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });
            const cZ = chargeNode3D.parameters?.charge_z ?? chargeNode3D.parameters?.pos_z ?? chargeNode3D.parameters?.z;
            if (cZ !== undefined) {
                flattenedParams['charge_z'] = Number(cZ);
            }
            const cX = chargeNode3D.parameters?.charge_x ?? chargeNode3D.parameters?.pos_x ?? chargeNode3D.parameters?.x;
            if (cX !== undefined) {
                flattenedParams['charge_x'] = Number(cX);
            }
            const cY = chargeNode3D.parameters?.charge_y ?? chargeNode3D.parameters?.pos_y ?? chargeNode3D.parameters?.y;
            if (cY !== undefined) {
                flattenedParams['charge_y'] = Number(cY);
            }

            // Trace Material for Charge 3D
            let matNode: Node | undefined;
            const matConn = state.connections.find(c => (c.toNode === chargeNode3D!.id && (c.toPort === 'material' || c.fromPort === 'material')) || (c.fromNode === chargeNode3D!.id && (c.fromPort === 'material' || c.toPort === 'material')));
            if (matConn) {
                const otherId = matConn.toNode === chargeNode3D.id ? matConn.fromNode : matConn.toNode;
                matNode = state.nodes.find(n => n.id === otherId);
            } else if (chargeNode3D.parameters?.material) {
                matNode = state.nodes.find(n => n.id === chargeNode3D!.parameters.material);
            }
            if (!matNode) {
                matNode = state.nodes.find(n => n.type === 'Material' && (isJWLMaterialNode(n) || isIdealGasMaterialNode(n)));
            }
            if (matNode) {
                if (isJWLMaterialNode(matNode)) {
                    flattenedParams['explosive_type'] = 'MaterialExplosive';
                    flattenedParams['material_type'] = 'JWL Charge';
                    extractJWLAndAfterburnParams(matNode, flattenedParams, numericKeys, booleanKeys);
                } else if (isIdealGasMaterialNode(matNode)) {
                    flattenedParams['explosive_type'] = 'MaterialIdealGas';
                    flattenedParams['material_type'] = 'Ideal Gas Charge';
                    flattenedParams['gamma'] = Number(matNode.parameters?.gamma ?? matNode.parameters?.ideal_gamma ?? 1.4);
                    flattenedParams['rho'] = Number(matNode.parameters?.density ?? matNode.parameters?.ideal_rho_0 ?? 1630.0);
                    flattenedParams['detonation_energy'] = Number(matNode.parameters?.detonation_energy ?? matNode.parameters?.ideal_e_0 ?? 4290000);
                    flattenedParams['ideal_gamma'] = Number(matNode.parameters?.gamma ?? matNode.parameters?.ideal_gamma ?? 1.4);
                    flattenedParams['ideal_rho_0'] = Number(matNode.parameters?.density ?? matNode.parameters?.ideal_rho_0 ?? 1630.0);
                    flattenedParams['ideal_e_0'] = Number(matNode.parameters?.detonation_energy ?? matNode.parameters?.ideal_e_0 ?? 4290000);
                    if (matNode.parameters?.composition !== undefined) {
                        flattenedParams['composition'] = matNode.parameters.composition;
                    }
                } else {
                    Object.entries(matNode.parameters).forEach(([key, value]) => {
                        if (key !== 'material_type') {
                            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                        }
                    });
                }
            }
        }

        // Trace Detonator / Trigger for CFD Solver 3D
        const detConn3D = state.connections.find(c => c.toNode === solverNode3D.id && (c.toPort === 'detonator' || c.toPort === 'trigger'));
        if (detConn3D) {
            const detNode3D = state.nodes.find(n => n.id === detConn3D.fromNode);
            if (detNode3D && (detNode3D.type === 'DetonatorLocation3D' || detNode3D.type === 'TriggerLocation3D')) {
                Object.entries(detNode3D.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }

        // Trace Remap 3D
        const remapConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'remap');
        const remapNode3D = remapConn3D ? state.nodes.find(n => n.id === remapConn3D.fromNode) : state.nodes.find(n => n.type === 'Remap1DTo3DNode' || n.type === 'Remap2DTo3DNode');
        if (remapNode3D) {
            inheritRemap3DUpstream(state, remapNode3D, solverNode3D, modelId, flattenedParams, numericKeys, booleanKeys);
        }

        const gaugeConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'gauges');
        if (gaugeConn3D) {
            const gaugeNode3D = state.nodes.find(n => n.id === gaugeConn3D.fromNode);
            if (gaugeNode3D) {
                const sourceMode = gaugeNode3D.parameters.source_mode || 'manual';
                flattenedParams['gauge_source_mode'] = sourceMode;
                flattenedParams['external_gauge_file'] = resolveResourcePath(gaugeNode3D.parameters.external_file_path || '', modelFilename);
                flattenedParams['external_gauge_format'] = gaugeNode3D.parameters.external_file_format || 'Auto';
                flattenedParams['gauge_storage_backend'] = gaugeNode3D.parameters.storage_backend || 'HDF5 Stream';
                flattenedParams['gauge_stride_steps'] = Number(gaugeNode3D.parameters.sampling_stride_steps || 1);
                flattenedParams['pinned_gauge_ids'] = gaugeNode3D.parameters.pinned_probe_ids || [];
                if (sourceMode === 'manual') {
                    flattenedParams['gauges'] = gaugeNode3D.parameters.gauges || [];
                } else {
                    flattenedParams['gauges'] = [];
                }
                ['export_ascii', 'export_binary', 'export_hdf5', 'ascii_delimiter', 'ascii_precision', 'include_header', 'custom_filename', 'output_dir'].forEach(k => {
                    if (gaugeNode3D.parameters[k] !== undefined) {
                        flattenedParams[k] = numericKeys.includes(k) ? Number(gaugeNode3D.parameters[k]) : gaugeNode3D.parameters[k];
                    }
                });
            }
        }

        // Trace Telemetry3DViewport slices and VTK configuration
        const telemetryConns = state.connections.filter(c => c.fromNode === solverNode3D.id && c.fromPort === 'telemetry');
        for (const conn of telemetryConns) {
            const viewNode = state.nodes.find(n => n.id === conn.toNode);
            if (viewNode && viewNode.type === 'Telemetry3DViewport') {
                if (viewNode.parameters.slices) {
                    flattenedParams['slices'] = viewNode.parameters.slices;
                }
                // Trace file output options
                Object.entries(viewNode.parameters).forEach(([key, value]) => {
                    if (key !== 'slices' && key !== 'colormap' && key !== 'refresh_rate' && key !== 'log_scale' && key !== 'auto_scale' && key !== 'min_val' && key !== 'max_val' && key !== 'show_grid' && key !== 'interpolate') {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    }
                });
            }
        }

        // Trace VTKOutput connected to CFDSolver3D
        const vtkConns3D = state.connections.filter(c => c.fromNode === solverNode3D.id || c.toNode === solverNode3D.id);
        for (const conn of vtkConns3D) {
            const otherId = conn.fromNode === solverNode3D.id ? conn.toNode : conn.fromNode;
            const vtkNode = state.nodes.find(n => n.id === otherId);
            if (vtkNode && vtkNode.type === 'VTKOutput') {
                Object.entries(vtkNode.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }
    }

    // 2. Trace 2D Solver if it exists
    const solverNode2D = state.nodes.find(n => n.type === 'CFDSolver2D');
    if (solverNode2D) {
        // Apply CFDSolver2D parameters
        Object.entries(solverNode2D.parameters).forEach(([key, value]) => {
            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
        });

        // Trace mesh input
        const meshConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'mesh');
        if (meshConn2D) {
            const meshNode2D = state.nodes.find(n => n.id === meshConn2D.fromNode);
            if (meshNode2D) {
                Object.entries(meshNode2D.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }

        // Trace remap input
        const remapConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'remap');
        if (remapConn2D) {
            const remapNode2D = state.nodes.find(n => n.id === remapConn2D.fromNode);
            if (remapNode2D) {
                Object.entries(remapNode2D.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }

        // Trace detonator / trigger input
        const detConn2D = state.connections.find(c => c.toNode === solverNode2D.id && (c.toPort === 'detonator' || c.toPort === 'trigger'));
        if (detConn2D) {
            const detNode2D = state.nodes.find(n => n.id === detConn2D.fromNode);
            if (detNode2D && (detNode2D.type === 'DetonatorLocation' || detNode2D.type === 'TriggerLocation')) {
                Object.entries(detNode2D.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }

        // Trace hardware config
        const hwConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'hardware');
        if (hwConn2D) {
            const hwNode2D = state.nodes.find(n => n.id === hwConnConnNode(hwConn2D.fromNode));
            function hwConnConnNode(id: string) { return id; } // helper
            const hwNode = state.nodes.find(n => n.id === hwConn2D.fromNode);
            if (hwNode) {
                Object.entries(hwNode.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }

        // Trace air input
        const airConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'air');
        if (airConn2D) {
            const airNode = state.nodes.find(n => n.id === airConn2D.fromNode);
            if (airNode && isAirMaterialNode(airNode)) {
                extractAirParams(airNode, flattenedParams, numericKeys);
            }
        }

        // Trace charge input (Charge2D or Charge1D)
        let expConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'charge');
        if (!expConn2D) {
            expConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'explosive');
        }
        if (expConn2D) {
            const chargeNode = state.nodes.find(n => n.id === expConn2D.fromNode);
            if (chargeNode && (chargeNode.type === 'Charge2D' || chargeNode.type === 'Charge1D')) {
                // Charge geometry parameters
                Object.entries(chargeNode.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });

                // Trace material node connected to Charge
                let matNode: Node | undefined;
                const matConn = state.connections.find(c => (c.toNode === chargeNode.id && c.toPort === 'material') || (c.fromNode === chargeNode.id && c.fromPort === 'material'));
                if (matConn) {
                    const otherId = matConn.toNode === chargeNode.id ? matConn.fromNode : matConn.toNode;
                    matNode = state.nodes.find(n => n.id === otherId);
                } else if (chargeNode.parameters?.material) {
                    matNode = state.nodes.find(n => n.id === chargeNode.parameters.material);
                }
                if (!matNode) {
                    matNode = state.nodes.find(n => n.type === 'Material' && (isJWLMaterialNode(n) || isIdealGasMaterialNode(n)));
                }
                if (matNode) {
                    if (isJWLMaterialNode(matNode)) {
                        flattenedParams['explosive_type'] = 'MaterialExplosive';
                        flattenedParams['material_type'] = 'JWL Charge';
                        extractJWLAndAfterburnParams(matNode, flattenedParams, numericKeys, booleanKeys);
                    } else if (isIdealGasMaterialNode(matNode)) {
                        flattenedParams['explosive_type'] = 'MaterialIdealGas';
                        flattenedParams['material_type'] = 'Ideal Gas Charge';
                        flattenedParams['gamma'] = Number(matNode.parameters?.gamma ?? matNode.parameters?.ideal_gamma ?? 1.4);
                        flattenedParams['rho'] = Number(matNode.parameters?.density ?? matNode.parameters?.ideal_rho_0 ?? 1630.0);
                        flattenedParams['detonation_energy'] = Number(matNode.parameters?.detonation_energy ?? matNode.parameters?.ideal_e_0 ?? 4290000);
                        flattenedParams['ideal_gamma'] = Number(matNode.parameters?.gamma ?? matNode.parameters?.ideal_gamma ?? 1.4);
                        flattenedParams['ideal_rho_0'] = Number(matNode.parameters?.density ?? matNode.parameters?.ideal_rho_0 ?? 1630.0);
                        flattenedParams['ideal_e_0'] = Number(matNode.parameters?.detonation_energy ?? matNode.parameters?.ideal_e_0 ?? 4290000);
                        if (matNode.parameters?.composition !== undefined) {
                            flattenedParams['composition'] = matNode.parameters.composition;
                        }
                    }
                }
            }
        }
        // Trace gauges and VTK output connected to CFDSolver2D
        const solver2DConns = state.connections.filter(c => c.fromNode === solverNode2D.id || c.toNode === solverNode2D.id);
        for (const conn of solver2DConns) {
            const otherId = conn.fromNode === solverNode2D.id ? conn.toNode : conn.fromNode;
            const targetNode = state.nodes.find(n => n.id === otherId);
            if (targetNode && targetNode.type === 'VirtualGauges') {
                const sourceMode = targetNode.parameters?.source_mode || 'manual';
                flattenedParams['gauge_source_mode'] = sourceMode;
                flattenedParams['external_gauge_file'] = resolveResourcePath(targetNode.parameters?.external_file_path || '', modelFilename);
                flattenedParams['external_gauge_format'] = targetNode.parameters?.external_file_format || 'Auto';
                flattenedParams['gauge_storage_backend'] = targetNode.parameters?.storage_backend || 'HDF5 Stream';
                flattenedParams['gauge_stride_steps'] = Number(targetNode.parameters?.sampling_stride_steps || 1);
                flattenedParams['pinned_gauge_ids'] = targetNode.parameters?.pinned_probe_ids || [];
                if (sourceMode === 'manual') {
                    flattenedParams['gauges'] = targetNode.parameters?.gauges || [];
                } else {
                    flattenedParams['gauges'] = [];
                }
                ['export_ascii', 'export_binary', 'export_hdf5', 'ascii_delimiter', 'ascii_precision', 'include_header', 'custom_filename', 'output_dir'].forEach(k => {
                    if (targetNode.parameters?.[k] !== undefined) {
                        flattenedParams[k] = numericKeys.includes(k) ? Number(targetNode.parameters[k]) : targetNode.parameters[k];
                    }
                });
            }
            if (targetNode && targetNode.type === 'VTKOutput') {
                Object.entries(targetNode.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
        }
    }

    // Derived parameters for backend (Zero-Omission Phase)
    if (command === "INIT") {
        const radius = flattenedParams['domain_radius'] || 1.0;
        const dx = flattenedParams['cell_size'] || 0.001;
        flattenedParams['n_cells'] = Math.round(radius / dx);

        // gamma comes from MaterialAir's gamma parameter (default 1.4 if not set)
        if (!flattenedParams['gamma']) flattenedParams['gamma'] = 1.4;

        const mass = flattenedParams['charge_mass'] !== undefined ? flattenedParams['charge_mass'] : 0.0;
        const rho = flattenedParams['rho'] || 1630.0;
        flattenedParams['charge_mass'] = mass;
        flattenedParams['rho'] = rho;
        flattenedParams['explosive_radius'] = mass > 0 ? Math.pow((3.0 * mass) / (4.0 * Math.PI * rho), 1.0/3.0) : 0.0;

        const p = flattenedParams['atm_pressure'] || 101325.0;
        const t = flattenedParams['atm_temperature'] || 288.0;
        flattenedParams['ambient_rho'] = p / (287.058 * t);

        // Ensure init_mode and composition are present with safe defaults
        if (!flattenedParams['init_mode']) flattenedParams['init_mode'] = 'Multi-Material JWL';
        if (flattenedParams['init_mode'] === 'Multi-Material JWL' && !flattenedParams['composition']) {
            flattenedParams['composition'] = 'TNT';
        }
    } else if (command === "INIT_2D") {
        if (!flattenedParams['gamma']) flattenedParams['gamma'] = 1.4;

        const p = flattenedParams['atm_pressure'] || 101325.0;
        const t = flattenedParams['atm_temperature'] || 288.0;
        flattenedParams['ambient_rho'] = p / (287.058 * t);

        // Map and heal detonator / trigger locations if old naming is present
        if (flattenedParams['detonator_r'] === undefined && flattenedParams['trigger_r'] === undefined) {
            flattenedParams['detonator_r'] = flattenedParams['explosive_r'] !== undefined ? flattenedParams['explosive_r'] : 0.0;
        }
        if (flattenedParams['detonator_z'] === undefined && flattenedParams['trigger_z'] === undefined) {
            flattenedParams['detonator_z'] = flattenedParams['explosive_z'] !== undefined ? flattenedParams['explosive_z'] : 0.1;
        }
        if (flattenedParams['detonator_radius'] === undefined && flattenedParams['trigger_radius'] === undefined) {
            flattenedParams['detonator_radius'] = flattenedParams['explosive_radius'] !== undefined ? flattenedParams['explosive_radius'] : 0.001;
        }

        if (flattenedParams['charge_shape'] === undefined) {
            flattenedParams['charge_shape'] = 'Sphere';
        }
        if (flattenedParams['charge_r'] === undefined) {
            flattenedParams['charge_r'] = 0.0;
        }
        if (flattenedParams['charge_z'] === undefined) {
            flattenedParams['charge_z'] = flattenedParams['explosive_z'] !== undefined ? flattenedParams['explosive_z'] : 0.1;
        }
        if (flattenedParams['charge_radius'] === undefined) {
            flattenedParams['charge_radius'] = flattenedParams['explosive_radius'] !== undefined ? flattenedParams['explosive_radius'] : 0.05;
        }
        if (flattenedParams['charge_height'] === undefined) {
            flattenedParams['charge_height'] = 0.1;
        }

        const mass = flattenedParams['charge_mass'] !== undefined ? flattenedParams['charge_mass'] : 0.0;
        flattenedParams['charge_mass'] = mass;
        const rho = flattenedParams['rho'] || 1630.0;
        flattenedParams['rho'] = rho;

        if (mass > 0) {
            if (flattenedParams['charge_shape'] === 'Cylinder') {
                const ar = flattenedParams['charge_aspect_ratio'] || (flattenedParams['charge_height'] && flattenedParams['charge_radius'] ? flattenedParams['charge_height'] / (2.0 * flattenedParams['charge_radius']) : 1.0);
                if (!flattenedParams['charge_radius'] || flattenedParams['charge_radius'] === 0.0) {
                    flattenedParams['charge_radius'] = Math.cbrt(mass / (2.0 * Math.PI * rho * ar));
                }
                flattenedParams['charge_height'] = 2.0 * flattenedParams['charge_radius'] * ar;
                flattenedParams['charge_aspect_ratio'] = ar;
            } else {
                flattenedParams['charge_radius'] = Math.pow((3.0 * mass) / (4.0 * Math.PI * rho), 1.0/3.0);
            }
        } else if (flattenedParams['charge_radius'] === undefined || flattenedParams['charge_radius'] === 0.0) {
            flattenedParams['charge_radius'] = 0.05;
        }

        // Respect user node setting for init_mode; if no remap node exists, auto-heal From1D default to direct JWL/Ideal Gas
        const remapConn2D = solverNode2D ? state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'remap') : null;
        const remapNode2D = remapConn2D ? state.nodes.find(n => n.id === remapConn2D.fromNode) : state.nodes.find(n => n.type === 'RemapNode' || n.type === 'Remap1DTo2DNode');
        if (remapNode2D) {
            flattenedParams['init_mode'] = 'From1D';
            inheritFrom1DUpstream(state, remapNode2D, modelId, flattenedParams, numericKeys, booleanKeys);
        } else if (!flattenedParams['init_mode'] || flattenedParams['init_mode'] === 'From1D') {
            if (flattenedParams['explosive_type'] === 'MaterialIdealGas') {
                flattenedParams['init_mode'] = 'Ideal Gas';
            } else {
                flattenedParams['init_mode'] = 'JWL';
            }
        }

        if (!flattenedParams['composition']) flattenedParams['composition'] = 'TNT';
        if (!flattenedParams['device']) flattenedParams['device'] = 'cpu';

        const cellSize = flattenedParams['cell_size'] || 0.005;
        const maxR = flattenedParams['max_r'] || 1.0;
        const maxZ = flattenedParams['max_z'] || 1.0;

        if (flattenedParams['mesh_type'] === 'amr') {
            flattenedParams['nr'] = Math.ceil((Math.round(maxR / cellSize) || 128) / 16) * 16;
            flattenedParams['nz'] = Math.ceil((Math.round(maxZ / cellSize) || 128) / 16) * 16;
        } else {
            flattenedParams['nr'] = Math.round(maxR / cellSize);
            flattenedParams['nz'] = Math.round(maxZ / cellSize);
        }
        flattenedParams['max_r'] = maxR;
        flattenedParams['max_z'] = maxZ;
    } else if (command === "INIT_FSI_2D" || command === "INIT_FSI") {
        // 1. Serialize 2D CFD Solver part
        const solverNode2D = state.nodes.find(n => n.type === 'CFDSolver2D');
        if (solverNode2D) {
            Object.entries(solverNode2D.parameters).forEach(([key, value]) => {
                if (key !== 'cfl' && key !== 'endtime') {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                }
            });
            const meshConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'mesh');
            if (meshConn2D) {
                const meshNode2D = state.nodes.find(n => n.id === meshConn2D.fromNode);
                if (meshNode2D) {
                    Object.entries(meshNode2D.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }
            const airConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'air');
            if (airConn2D) {
                const airNode = state.nodes.find(n => n.id === airConn2D.fromNode);
                if (airNode && isAirMaterialNode(airNode)) {
                    extractAirParams(airNode, flattenedParams, numericKeys);
                }
            }
            let expConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'charge') || state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'explosive');
            if (expConn2D) {
                const chargeNode = state.nodes.find(n => n.id === expConn2D.fromNode);
                if (chargeNode && (chargeNode.type === 'Charge2D' || chargeNode.type === 'Charge1D')) {
                    Object.entries(chargeNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                    let matNode: Node | undefined;
                    const matConn = state.connections.find(c => (c.toNode === chargeNode.id && c.toPort === 'material') || (c.fromNode === chargeNode.id && c.fromPort === 'material'));
                    if (matConn) {
                        const otherId = matConn.toNode === chargeNode.id ? matConn.fromNode : matConn.toNode;
                        matNode = state.nodes.find(n => n.id === otherId);
                    } else if (chargeNode.parameters?.material) {
                        matNode = state.nodes.find(n => n.id === chargeNode.parameters.material);
                    }
                    if (!matNode) {
                        matNode = state.nodes.find(n => n.type === 'Material' && (isJWLMaterialNode(n) || isIdealGasMaterialNode(n)));
                    }
                    if (matNode) {
                        if (isJWLMaterialNode(matNode)) {
                            flattenedParams['explosive_type'] = 'MaterialExplosive';
                            flattenedParams['material_type'] = 'JWL Charge';
                            extractJWLAndAfterburnParams(matNode, flattenedParams, numericKeys, booleanKeys);
                        } else if (isIdealGasMaterialNode(matNode)) {
                            flattenedParams['explosive_type'] = 'MaterialIdealGas';
                            flattenedParams['material_type'] = 'Ideal Gas Charge';
                            flattenedParams['gamma'] = Number(matNode.parameters?.gamma ?? matNode.parameters?.ideal_gamma ?? 1.4);
                            flattenedParams['rho'] = Number(matNode.parameters?.density ?? matNode.parameters?.ideal_rho_0 ?? 1630.0);
                            flattenedParams['detonation_energy'] = Number(matNode.parameters?.detonation_energy ?? matNode.parameters?.ideal_e_0 ?? 4290000);
                            flattenedParams['ideal_gamma'] = Number(matNode.parameters?.gamma ?? matNode.parameters?.ideal_gamma ?? 1.4);
                            flattenedParams['ideal_rho_0'] = Number(matNode.parameters?.density ?? matNode.parameters?.ideal_rho_0 ?? 1630.0);
                            flattenedParams['ideal_e_0'] = Number(matNode.parameters?.detonation_energy ?? matNode.parameters?.ideal_e_0 ?? 4290000);
                        }
                    }
                }
            }

            const remapConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'remap');
            const remapNode2D = remapConn2D ? state.nodes.find(n => n.id === remapConn2D.fromNode) : state.nodes.find(n => n.type === 'RemapNode' || n.type === 'Remap1DTo2DNode');
            if (remapNode2D) {
                flattenedParams['init_mode'] = 'From1D';
                inheritFrom1DUpstream(state, remapNode2D, modelId, flattenedParams, numericKeys, booleanKeys);
            }
        }

        // 2. Serialize MPM Domain part
        const mpmDomain = state.nodes.find(n => n.type === 'MPMDomain2D');
        if (mpmDomain) {
            Object.entries(mpmDomain.parameters).forEach(([key, value]) => {
                if (key !== 'cfl' && key !== 'endtime') {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                }
            });
            const domainPpc = Number(mpmDomain.parameters?.ppc ?? 4);
            const domainParticleDist = mpmDomain.parameters?.particle_distribution;
            const domainBoundaryFill = mpmDomain.parameters?.boundary_filling;
            flattenedParams['ppc'] = domainPpc;

            const objConns = state.connections.filter(c => c.toNode === mpmDomain.id && c.toPort === 'objects');
            const mpmObjects: any[] = [];
            for (const conn of objConns) {
                const objNode = state.nodes.find(n => n.id === conn.fromNode);
                if (objNode && objNode.type === 'MPMObject2D') {
                    const objParams: any = {};
                    Object.entries(objNode.parameters).forEach(([k, v]) => {
                        objParams[k] = numericKeys.includes(k) ? Number(v) : v;
                    });
                    let matNode: any = null;
                    const matConn = state.connections.find(c => (c.toNode === objNode.id || c.fromNode === objNode.id) && (c.toPort === 'material' || c.fromPort === 'material' || c.toPort === 'in' || c.fromPort === 'out'));
                    if (matConn) {
                        const otherId = matConn.toNode === objNode.id ? matConn.fromNode : matConn.toNode;
                        matNode = state.nodes.find(n => n.id === otherId);
                    } else if (objNode.parameters?.material) {
                        matNode = state.nodes.find(n => n.id === objNode.parameters.material);
                    }
                    if (!matNode) {
                        matNode = state.nodes.find(n => n.type === 'Material' && !isJWLMaterialNode(n) && !isIdealGasMaterialNode(n)) || state.nodes.find(n => n.type === 'Material');
                    }
                    if (matNode) {
                        Object.entries(matNode.parameters).forEach(([k, v]) => {
                            objParams[k] = numericKeys.includes(k) ? Number(v) : v;
                        });
                    }
                    if (matNode?.parameters?.['material_model']) {
                        objParams['material_model'] = matNode.parameters['material_model'];
                    } else if (!objParams['material_model']) {
                        objParams['material_model'] = objNode.parameters?.['material_model'] || 'Hypoelastic';
                    }
                    if (matNode?.parameters?.['solid_model'] !== undefined) {
                        objParams['solid_model'] = matNode.parameters['solid_model'];
                    } else if (objNode.parameters?.['solid_model'] !== undefined) {
                        objParams['solid_model'] = objNode.parameters['solid_model'];
                    }
                    if (matNode?.parameters?.['burn_model'] !== undefined) {
                        objParams['burn_model'] = matNode.parameters['burn_model'];
                    } else if (objNode.parameters?.['burn_model'] !== undefined) {
                        objParams['burn_model'] = objNode.parameters['burn_model'];
                    }
                    if (matNode?.parameters?.['product_model'] !== undefined) {
                        objParams['product_model'] = matNode.parameters['product_model'];
                    } else if (objNode.parameters?.['product_model'] !== undefined) {
                        objParams['product_model'] = objNode.parameters['product_model'];
                    }
                    if (objParams['vel_x'] === undefined && objParams['initial_velocity_x'] !== undefined) objParams['vel_x'] = objParams['initial_velocity_x'];
                    if (objParams['vel_y'] === undefined && objParams['initial_velocity_y'] !== undefined) objParams['vel_y'] = objParams['initial_velocity_y'];
                    objParams['ppc'] = Math.max(1, Math.round(Number(objNode.parameters?.ppc ?? domainPpc)));
                    if (domainParticleDist && (objParams['particle_distribution'] === undefined || objParams['particle_distribution'] === 'Cartesian')) {
                        objParams['particle_distribution'] = domainParticleDist;
                    }
                    if (domainBoundaryFill && (objParams['boundary_filling'] === undefined || objParams['boundary_filling'] === 'Stairstepped')) {
                        objParams['boundary_filling'] = domainBoundaryFill;
                    }
                    mpmObjects.push(objParams);
                }
            }
            flattenedParams['mpm_objects'] = mpmObjects;
        }

        // 3. Serialize FSICoupler2D parameters
        const couplerNode = state.nodes.find(n => n.type === 'FSICoupler2D');
        if (couplerNode) {
            Object.entries(couplerNode.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });
        }

        const cellSize = flattenedParams['cell_size'] || 0.005;
        const maxR = flattenedParams['max_r'] || 1.0;
        const maxZ = flattenedParams['max_z'] || 1.0;
        flattenedParams['nr'] = Math.round(maxR / cellSize);
        flattenedParams['nz'] = Math.round(maxZ / cellSize);
        flattenedParams['max_r'] = maxR;
        flattenedParams['max_z'] = maxZ;
        if (!flattenedParams['gamma']) flattenedParams['gamma'] = 1.4;
        const p = flattenedParams['atm_pressure'] || 101325.0;
        const t = flattenedParams['atm_temperature'] || 288.0;
    } else if (command === "INIT_FSI_3D") {
        const couplerNode = state.nodes.find(n => n.type === 'FSICoupler3D');
        // 1. Serialize 3D CFD Solver part
        const cfdConn = couplerNode ? state.connections.find(c => c.toNode === couplerNode.id && (c.toPort === 'cfd' || c.toPort === 'cfd_solver')) : null;
        const solverNode3D = cfdConn ? state.nodes.find(n => n.id === cfdConn.fromNode) : state.nodes.find(n => n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain');
        if (solverNode3D) {
            Object.entries(solverNode3D.parameters).forEach(([key, value]) => {
                if (key !== 'cfl' && key !== 'endtime') {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                }
            });
            const stlConn = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'stl');
            if (stlConn) {
                const stlNode = state.nodes.find(n => n.id === stlConn.fromNode);
                if (stlNode && stlNode.type === 'STLGeometry') {
                    flattenedParams['stl_file'] = resolveResourcePath(stlNode.parameters.stl_file || '', modelFilename);
                    const baseHash = stlNode.parameters.geometry_hash || '';
                    const transformSig = `${stlNode.parameters.origin_mode || 'CAD Origin'}_${stlNode.parameters.scale_x ?? 1}_${stlNode.parameters.scale_y ?? 1}_${stlNode.parameters.scale_z ?? 1}_${stlNode.parameters.pos_x ?? 0}_${stlNode.parameters.pos_y ?? 0}_${stlNode.parameters.pos_z ?? 0}_${stlNode.parameters.rot_x ?? 0}_${stlNode.parameters.rot_y ?? 0}_${stlNode.parameters.rot_z ?? 0}`;
                    flattenedParams['geometry_hash'] = baseHash ? `${baseHash}_${transformSig}` : transformSig;
                    flattenedParams['voxelization_method'] = stlNode.parameters.voxelization_method || 'watertight_floodfill';
                    flattenedParams['stl_origin_mode'] = stlNode.parameters.origin_mode || 'CAD Origin';
                    flattenedParams['stl_scale_x'] = Number(stlNode.parameters.scale_x ?? 1.0);
                    flattenedParams['stl_scale_y'] = Number(stlNode.parameters.scale_y ?? 1.0);
                    flattenedParams['stl_scale_z'] = Number(stlNode.parameters.scale_z ?? 1.0);
                    flattenedParams['stl_pos_x'] = Number(stlNode.parameters.pos_x ?? 0.0);
                    flattenedParams['stl_pos_y'] = Number(stlNode.parameters.pos_y ?? 0.0);
                    flattenedParams['stl_pos_z'] = Number(stlNode.parameters.pos_z ?? 0.0);
                    flattenedParams['stl_rot_x'] = Number(stlNode.parameters.rot_x ?? 0.0);
                    flattenedParams['stl_rot_y'] = Number(stlNode.parameters.rot_y ?? 0.0);
                    flattenedParams['stl_rot_z'] = Number(stlNode.parameters.rot_z ?? 0.0);
                } else if (stlNode && stlNode.type === 'PrimitiveGeometry3D') {
                    flattenedParams['primitives'] = stlNode.parameters.primitives || [];
                    const primsStr = JSON.stringify(stlNode.parameters.primitives || []) + '_' + (stlNode.parameters.voxelization_method || 'watertight_floodfill');
                    let hash = 5381;
                    for (let i = 0; i < primsStr.length; i++) {
                        hash = ((hash << 5) + hash) + primsStr.charCodeAt(i);
                        hash = hash & hash;
                    }
                    flattenedParams['geometry_hash'] = 'prims_' + Math.abs(hash).toString(16);
                    flattenedParams['voxelization_method'] = stlNode.parameters.voxelization_method || 'watertight_floodfill';
                }
            }
            const meshConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'mesh');
            if (meshConn3D) {
                const rootDomainNode = state.nodes.find(n => n.id === meshConn3D.fromNode);
                if (rootDomainNode && rootDomainNode.type === 'DomainMesh3D') {
                    Object.entries(rootDomainNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }
            const airConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'air');
            if (airConn3D) {
                const airNode3D = state.nodes.find(n => n.id === airConn3D.fromNode);
                if (airNode3D && isAirMaterialNode(airNode3D)) {
                    extractAirParams(airNode3D, flattenedParams, numericKeys);
                }
            }
            extractUnderwaterParams(state, solverNode3D, flattenedParams, numericKeys);
            const chargeConn3D = state.connections.find(c => c.toNode === solverNode3D.id && (c.toPort === 'charge' || c.toPort === 'explosive'));
            if (chargeConn3D) {
                const chargeNode3D = state.nodes.find(n => n.id === chargeConn3D.fromNode);
                if (chargeNode3D) {
                    Object.entries(chargeNode3D.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                    const cZ = chargeNode3D.parameters?.charge_z ?? chargeNode3D.parameters?.pos_z ?? chargeNode3D.parameters?.z;
                    if (cZ !== undefined) {
                        flattenedParams['charge_z'] = Number(cZ);
                    }
                    const cX = chargeNode3D.parameters?.charge_x ?? chargeNode3D.parameters?.pos_x ?? chargeNode3D.parameters?.x;
                    if (cX !== undefined) {
                        flattenedParams['charge_x'] = Number(cX);
                    }
                    const cY = chargeNode3D.parameters?.charge_y ?? chargeNode3D.parameters?.pos_y ?? chargeNode3D.parameters?.y;
                    if (cY !== undefined) {
                        flattenedParams['charge_y'] = Number(cY);
                    }
                    let matNode: Node | undefined;
                    const matConn = state.connections.find(c => (c.toNode === chargeNode3D.id && c.toPort === 'material') || (c.fromNode === chargeNode3D.id && c.fromPort === 'material'));
                    if (matConn) {
                        const otherId = matConn.toNode === chargeNode3D.id ? matConn.fromNode : matConn.toNode;
                        matNode = state.nodes.find(n => n.id === otherId);
                    } else if (chargeNode3D.parameters?.material) {
                        matNode = state.nodes.find(n => n.id === chargeNode3D.parameters.material);
                    }
                    if (!matNode) {
                        matNode = state.nodes.find(n => n.type === 'Material' && (isJWLMaterialNode(n) || isIdealGasMaterialNode(n)));
                    }
                    if (matNode) {
                        if (isJWLMaterialNode(matNode)) {
                            flattenedParams['explosive_type'] = 'MaterialExplosive';
                            flattenedParams['material_type'] = 'JWL Charge';
                            extractJWLAndAfterburnParams(matNode, flattenedParams, numericKeys, booleanKeys);
                        } else if (isIdealGasMaterialNode(matNode)) {
                            flattenedParams['explosive_type'] = 'MaterialIdealGas';
                            flattenedParams['material_type'] = 'Ideal Gas Charge';
                            flattenedParams['gamma'] = Number(matNode.parameters?.gamma ?? matNode.parameters?.ideal_gamma ?? 1.4);
                            flattenedParams['rho'] = Number(matNode.parameters?.density ?? matNode.parameters?.ideal_rho_0 ?? 1630.0);
                            flattenedParams['detonation_energy'] = Number(matNode.parameters?.detonation_energy ?? matNode.parameters?.ideal_e_0 ?? 4290000);
                            flattenedParams['ideal_gamma'] = Number(matNode.parameters?.gamma ?? matNode.parameters?.ideal_gamma ?? 1.4);
                            flattenedParams['ideal_rho_0'] = Number(matNode.parameters?.density ?? matNode.parameters?.ideal_rho_0 ?? 1630.0);
                            flattenedParams['ideal_e_0'] = Number(matNode.parameters?.detonation_energy ?? matNode.parameters?.ideal_e_0 ?? 4290000);
                        }
                    }
                }
            }
            const detConn3D = state.connections.find(c => c.toNode === solverNode3D.id && (c.toPort === 'detonator' || c.toPort === 'trigger'));
            if (detConn3D) {
                const detNode3D = state.nodes.find(n => n.id === detConn3D.fromNode);
                if (detNode3D && (detNode3D.type === 'DetonatorLocation3D' || detNode3D.type === 'TriggerLocation3D')) {
                    Object.entries(detNode3D.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }
            const telemetryConns = state.connections.filter(c => c.fromNode === solverNode3D.id && c.fromPort === 'telemetry');
            for (const conn of telemetryConns) {
                const viewNode = state.nodes.find(n => n.id === conn.toNode);
                if (viewNode && viewNode.type === 'Telemetry3DViewport') {
                    if (viewNode.parameters.slices) {
                        flattenedParams['slices'] = viewNode.parameters.slices;
                    }
                }
            }

            // Trace Remap 3D
            const remapConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'remap');
            const remapNode3D = remapConn3D ? state.nodes.find(n => n.id === remapConn3D.fromNode) : state.nodes.find(n => n.type === 'Remap1DTo3DNode' || n.type === 'Remap2DTo3DNode');
            if (remapNode3D) {
                inheritRemap3DUpstream(state, remapNode3D, solverNode3D, modelId, flattenedParams, numericKeys, booleanKeys);
            }
        }

        // 2. Serialize 3D MPM Domain part
        const mpmConn = couplerNode ? state.connections.find(c => c.toNode === couplerNode.id && (c.toPort === 'mpm' || c.toPort === 'mpm_domain')) : null;
        const mpmDomain = mpmConn ? state.nodes.find(n => n.id === mpmConn.fromNode) : state.nodes.find(n => n.type === 'MPMDomain3D');
        if (mpmDomain) {
            Object.entries(mpmDomain.parameters).forEach(([key, value]) => {
                if (key !== 'cfl' && key !== 'endtime') {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                }
            });

            const meshConn = state.connections.find(c => c.toNode === mpmDomain.id && c.toPort === 'mesh');
            if (meshConn) {
                const meshNode = state.nodes.find(n => n.id === meshConn.fromNode);
                if (meshNode) {
                    Object.entries(meshNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }

            const domainPpc = Number(mpmDomain.parameters?.ppc ?? 8);
            flattenedParams['ppc'] = domainPpc;
        }

        serializeMPMObjectsWithSleeve(state, solverNode3D, mpmDomain, flattenedParams, numericKeys, modelFilename);

        // 3. Serialize FSICoupler3D parameters
        if (couplerNode) {
            Object.entries(couplerNode.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });
            const telemetryConns = state.connections.filter(c => c.fromNode === couplerNode.id && c.fromPort === 'telemetry');
            for (const conn of telemetryConns) {
                const viewNode = state.nodes.find(n => n.id === conn.toNode);
                if (viewNode && viewNode.type === 'Telemetry3DViewport') {
                    if (viewNode.parameters.slices) {
                        flattenedParams['slices'] = viewNode.parameters.slices;
                    }
                    // Trace file output options and other view options
                    Object.entries(viewNode.parameters).forEach(([key, value]) => {
                        if (key !== 'slices' && key !== 'colormap' && key !== 'refresh_rate' && key !== 'log_scale' && key !== 'auto_scale' && key !== 'min_val' && key !== 'max_val' && key !== 'show_grid' && key !== 'interpolate') {
                            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                        }
                    });
                }
            }

            // Trace VTKOutput connected to FSICoupler3D
            const vtkConns = state.connections.filter(c => c.fromNode === couplerNode.id || c.toNode === couplerNode.id);
            for (const conn of vtkConns) {
                const otherId = conn.fromNode === couplerNode.id ? conn.toNode : conn.fromNode;
                const vtkNode = state.nodes.find(n => n.id === otherId);
                if (vtkNode && vtkNode.type === 'VTKOutput') {
                    Object.entries(vtkNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }
        }

        const cellSize = flattenedParams['cell_size'] || 0.01;
        const xmin = flattenedParams['xmin'] !== undefined ? flattenedParams['xmin'] : 0.0;
        const xmax = flattenedParams['xmax'] !== undefined ? flattenedParams['xmax'] : 1.0;
        const ymin = flattenedParams['ymin'] !== undefined ? flattenedParams['ymin'] : 0.0;
        const ymax = flattenedParams['ymax'] !== undefined ? flattenedParams['ymax'] : 1.0;
        const zmin = flattenedParams['zmin'] !== undefined ? flattenedParams['zmin'] : 0.0;
        const zmax = flattenedParams['zmax'] !== undefined ? flattenedParams['zmax'] : 1.0;
        flattenedParams['nx'] = Math.round((xmax - xmin) / cellSize);
        flattenedParams['ny'] = Math.round((ymax - ymin) / cellSize);
        flattenedParams['nz'] = Math.round((zmax - zmin) / cellSize);
        flattenedParams['xmin'] = xmin;
        flattenedParams['ymin'] = ymin;
        flattenedParams['zmin'] = zmin;

        const hasChargeConn3D = solverNode3D ? Boolean(state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'charge')) : false;
        const isStratified3D = flattenedParams['init_mode'] === 'Hydrostatic_Stratified_3D' || solverNode3D?.parameters?.init_mode === 'Hydrostatic_Stratified_3D' || solverNode3D?.type === 'MarineHarbourDomain';
        const isRemap3D = flattenedParams['init_mode'] === 'From1D' || flattenedParams['init_mode'] === 'From2D';
        if (!isRemap3D && !isStratified3D) {
            if (!hasChargeConn3D || flattenedParams['init_mode'] === 'Ideal Gas' || flattenedParams['explosive_type'] === 'MaterialIdealGas' || flattenedParams['material_type'] === 'Ideal Gas Charge') {
                flattenedParams['init_mode'] = 'Ideal Gas';
                flattenedParams['is_ideal_gas'] = true;
            } else if (flattenedParams['init_mode'] === 'Multi-Material JWL' || flattenedParams['material_type'] === 'JWL Charge' || flattenedParams['explosive_type'] === 'MaterialExplosive') {
                flattenedParams['init_mode'] = 'Multi-Material JWL';
                flattenedParams['is_ideal_gas'] = false;
            }
        }

        if (!flattenedParams['gamma']) flattenedParams['gamma'] = 1.4;
        const p = flattenedParams['atm_pressure'] || 101325.0;
        const t = flattenedParams['atm_temperature'] || 288.0;
        flattenedParams['ambient_rho'] = p / (287.058 * t);
        if (!flattenedParams['device']) flattenedParams['device'] = 'cpu';

        // Re-apply CFD solver's device/precision/init_mode parameters to ensure they take precedence
        if (solverNode3D) {
            if (!isRemap3D && solverNode3D.parameters.init_mode !== undefined) {
                flattenedParams['init_mode'] = solverNode3D.parameters.init_mode;
                if (flattenedParams['init_mode'] === 'Ideal Gas') {
                    flattenedParams['is_ideal_gas'] = true;
                } else if (flattenedParams['init_mode'] === 'Multi-Material JWL') {
                    flattenedParams['is_ideal_gas'] = false;
                }
            }
            if (solverNode3D.parameters.device !== undefined) {
                flattenedParams['device'] = solverNode3D.parameters.device;
            }
            if (solverNode3D.parameters.precision !== undefined) {
                flattenedParams['precision'] = solverNode3D.parameters.precision;
            }
        }
    } else if (command === "INIT_FEM_FSI_3D") {
        const couplerNode = state.nodes.find(n => n.type === 'FEMFSICoupler3D');
        // 1. Serialize 3D CFD Solver part
        const cfdConn = couplerNode ? state.connections.find(c => c.toNode === couplerNode.id && (c.toPort === 'cfd' || c.toPort === 'cfd_solver')) : null;
        const solverNode3D = cfdConn ? state.nodes.find(n => n.id === cfdConn.fromNode) : state.nodes.find(n => n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain');
        if (solverNode3D) {
            Object.entries(solverNode3D.parameters).forEach(([key, value]) => {
                if (key !== 'cfl' && key !== 'endtime') {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                }
            });
            const stlConn = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'stl');
            if (stlConn) {
                const stlNode = state.nodes.find(n => n.id === stlConn.fromNode);
                if (stlNode && stlNode.type === 'STLGeometry') {
                    flattenedParams['stl_file'] = resolveResourcePath(stlNode.parameters.stl_file || '', modelFilename);
                    const baseHash = stlNode.parameters.geometry_hash || '';
                    const transformSig = `${stlNode.parameters.origin_mode || 'CAD Origin'}_${stlNode.parameters.scale_x ?? 1}_${stlNode.parameters.scale_y ?? 1}_${stlNode.parameters.scale_z ?? 1}_${stlNode.parameters.pos_x ?? 0}_${stlNode.parameters.pos_y ?? 0}_${stlNode.parameters.pos_z ?? 0}_${stlNode.parameters.rot_x ?? 0}_${stlNode.parameters.rot_y ?? 0}_${stlNode.parameters.rot_z ?? 0}`;
                    flattenedParams['geometry_hash'] = baseHash ? `${baseHash}_${transformSig}` : transformSig;
                    flattenedParams['voxelization_method'] = stlNode.parameters.voxelization_method || 'watertight_floodfill';
                    flattenedParams['stl_origin_mode'] = stlNode.parameters.origin_mode || 'CAD Origin';
                    flattenedParams['stl_scale_x'] = Number(stlNode.parameters.scale_x ?? 1.0);
                    flattenedParams['stl_scale_y'] = Number(stlNode.parameters.scale_y ?? 1.0);
                    flattenedParams['stl_scale_z'] = Number(stlNode.parameters.scale_z ?? 1.0);
                    flattenedParams['stl_pos_x'] = Number(stlNode.parameters.pos_x ?? 0.0);
                    flattenedParams['stl_pos_y'] = Number(stlNode.parameters.pos_y ?? 0.0);
                    flattenedParams['stl_pos_z'] = Number(stlNode.parameters.pos_z ?? 0.0);
                    flattenedParams['stl_rot_x'] = Number(stlNode.parameters.rot_x ?? 0.0);
                    flattenedParams['stl_rot_y'] = Number(stlNode.parameters.rot_y ?? 0.0);
                    flattenedParams['stl_rot_z'] = Number(stlNode.parameters.rot_z ?? 0.0);
                } else if (stlNode && stlNode.type === 'PrimitiveGeometry3D') {
                    flattenedParams['primitives'] = stlNode.parameters.primitives || [];
                    const primsStr = JSON.stringify(stlNode.parameters.primitives || []) + '_' + (stlNode.parameters.voxelization_method || 'watertight_floodfill');
                    let hash = 5381;
                    for (let i = 0; i < primsStr.length; i++) {
                        hash = ((hash << 5) + hash) + primsStr.charCodeAt(i);
                        hash = hash & hash;
                    }
                    flattenedParams['geometry_hash'] = 'prims_' + Math.abs(hash).toString(16);
                    flattenedParams['voxelization_method'] = stlNode.parameters.voxelization_method || 'watertight_floodfill';
                }
            }
            const meshConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'mesh');
            if (meshConn3D) {
                const rootDomainNode = state.nodes.find(n => n.id === meshConn3D.fromNode);
                if (rootDomainNode && rootDomainNode.type === 'DomainMesh3D') {
                    Object.entries(rootDomainNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }
            const airConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'air');
            if (airConn3D) {
                const airNode3D = state.nodes.find(n => n.id === airConn3D.fromNode);
                if (airNode3D && isAirMaterialNode(airNode3D)) {
                    extractAirParams(airNode3D, flattenedParams, numericKeys);
                }
            }
            extractUnderwaterParams(state, solverNode3D, flattenedParams, numericKeys);
            const chargeConn3D = state.connections.find(c => c.toNode === solverNode3D.id && (c.toPort === 'charge' || c.toPort === 'explosive'));
            if (chargeConn3D) {
                const chargeNode3D = state.nodes.find(n => n.id === chargeConn3D.fromNode);
                if (chargeNode3D) {
                    Object.entries(chargeNode3D.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                    let matNode: Node | undefined;
                    const matConn = state.connections.find(c => (c.toNode === chargeNode3D.id && c.toPort === 'material') || (c.fromNode === chargeNode3D.id && c.fromPort === 'material'));
                    if (matConn) {
                        const otherId = matConn.toNode === chargeNode3D.id ? matConn.fromNode : matConn.toNode;
                        matNode = state.nodes.find(n => n.id === otherId);
                    } else if (chargeNode3D.parameters?.material) {
                        matNode = state.nodes.find(n => n.id === chargeNode3D.parameters.material);
                    }
                    if (!matNode) {
                        matNode = state.nodes.find(n => n.type === 'Material' && (isJWLMaterialNode(n) || isIdealGasMaterialNode(n)));
                    }
                    if (matNode) {
                        if (isJWLMaterialNode(matNode)) {
                            flattenedParams['explosive_type'] = 'MaterialExplosive';
                            flattenedParams['material_type'] = 'JWL Charge';
                            extractJWLAndAfterburnParams(matNode, flattenedParams, numericKeys, booleanKeys);
                        } else if (isIdealGasMaterialNode(matNode)) {
                            flattenedParams['explosive_type'] = 'MaterialIdealGas';
                            flattenedParams['material_type'] = 'Ideal Gas Charge';
                            flattenedParams['gamma'] = Number(matNode.parameters?.gamma ?? matNode.parameters?.ideal_gamma ?? 1.4);
                            flattenedParams['rho'] = Number(matNode.parameters?.density ?? matNode.parameters?.ideal_rho_0 ?? 1630.0);
                            flattenedParams['detonation_energy'] = Number(matNode.parameters?.detonation_energy ?? matNode.parameters?.ideal_e_0 ?? 4290000);
                            flattenedParams['ideal_gamma'] = Number(matNode.parameters?.gamma ?? matNode.parameters?.ideal_gamma ?? 1.4);
                            flattenedParams['ideal_rho_0'] = Number(matNode.parameters?.density ?? matNode.parameters?.ideal_rho_0 ?? 1630.0);
                            flattenedParams['ideal_e_0'] = Number(matNode.parameters?.detonation_energy ?? matNode.parameters?.ideal_e_0 ?? 4290000);
                        }
                    }
                }
            }
            const detConn3D = state.connections.find(c => c.toNode === solverNode3D.id && (c.toPort === 'detonator' || c.toPort === 'trigger'));
            if (detConn3D) {
                const detNode3D = state.nodes.find(n => n.id === detConn3D.fromNode);
                if (detNode3D && (detNode3D.type === 'DetonatorLocation3D' || detNode3D.type === 'TriggerLocation3D')) {
                    Object.entries(detNode3D.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }
            const telemetryConns = state.connections.filter(c => c.fromNode === solverNode3D.id && c.fromPort === 'telemetry');
            for (const conn of telemetryConns) {
                const viewNode = state.nodes.find(n => n.id === conn.toNode);
                if (viewNode && viewNode.type === 'Telemetry3DViewport') {
                    if (viewNode.parameters.slices) {
                        flattenedParams['slices'] = viewNode.parameters.slices;
                    }
                }
            }

            // Trace Remap 3D
            const remapConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'remap');
            const remapNode3D = remapConn3D ? state.nodes.find(n => n.id === remapConn3D.fromNode) : state.nodes.find(n => n.type === 'Remap1DTo3DNode' || n.type === 'Remap2DTo3DNode');
            if (remapNode3D) {
                inheritRemap3DUpstream(state, remapNode3D, solverNode3D, modelId, flattenedParams, numericKeys, booleanKeys);
            }
        }

        // 2. Serialize 3D FEM Domain part
        const femConn = couplerNode ? state.connections.find(c => c.toNode === couplerNode.id && (c.toPort === 'fem' || c.toPort === 'fem_domain' || c.toPort === 'fem_solver')) : null;
        const femDomain = femConn ? state.nodes.find(n => n.id === femConn.fromNode) : state.nodes.find(n => n.type === 'FEMDomain3D');
        if (femDomain) {
            Object.entries(femDomain.parameters).forEach(([key, value]) => {
                if (key !== 'cfl' && key !== 'endtime') {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                }
            });
        }

        const femObjects: any[] = [];
        const processedNodeIds = new Set<string>();

            const processObjNode = (objNode: any) => {
                if (!objNode || (objNode.type !== 'FEMObject3D' && objNode.type !== 'LSDynaImporter3D') || processedNodeIds.has(objNode.id)) return;
                processedNodeIds.add(objNode.id);

                const objParams: any = {};
                Object.entries(objNode.parameters).forEach(([k, v]) => {
                    objParams[k] = numericKeys.includes(k) ? Number(v) : v;
                });
                if (objNode.type === 'LSDynaImporter3D') {
                    objParams['k_file'] = resolveResourcePath(objNode.parameters.k_file || '', modelFilename);
                    objParams['mesh_source'] = 'LS-DYNA Keyword File';
                    objParams['shape_type'] = 'LS-DYNA File';
                    if (objNode.parameters.scale_factor !== undefined) {
                        objParams['scale_factor'] = Number(objNode.parameters.scale_factor);
                    }
                } else {
                    const impConn = state.connections.find(c => c.toNode === objNode.id && c.toPort === 'importer');
                    if (impConn) {
                        const impNode = state.nodes.find(n => n.id === impConn.fromNode);
                        if (impNode && impNode.type === 'LSDynaImporter3D') {
                            objParams['k_file'] = resolveResourcePath(impNode.parameters.k_file || '', modelFilename);
                            objParams['mesh_source'] = 'LS-DYNA Keyword File';
                            objParams['shape_type'] = 'LS-DYNA File';
                            if (impNode.parameters.scale_factor !== undefined) {
                                objParams['scale_factor'] = Number(impNode.parameters.scale_factor);
                            }
                        }
                    } else if (objParams['k_file']) {
                        objParams['k_file'] = resolveResourcePath(objParams['k_file'], modelFilename);
                    }
                }
                if (objParams['stl_file']) {
                    objParams['stl_file'] = resolveResourcePath(objParams['stl_file'], modelFilename);
                }
                let matNode: any = null;
                const matConn = state.connections.find(c => {
                    const otherId = c.toNode === objNode.id ? c.fromNode : (c.fromNode === objNode.id ? c.toNode : null);
                    if (!otherId) return false;
                    const other = state.nodes.find(n => n.id === otherId);
                    return other && other.type === 'Material';
                });
                if (matConn) {
                    const otherId = matConn.toNode === objNode.id ? matConn.fromNode : matConn.toNode;
                    matNode = state.nodes.find(n => n.id === otherId && n.type === 'Material');
                } else if (objNode.parameters?.material) {
                    matNode = state.nodes.find(n => n.id === objNode.parameters.material && n.type === 'Material');
                }
                if (!matNode && femDomain) {
                    const domMatConn = state.connections.find(c => {
                        const otherId = c.toNode === femDomain.id ? c.fromNode : (c.fromNode === femDomain.id ? c.toNode : null);
                        if (!otherId) return false;
                        const other = state.nodes.find(n => n.id === otherId);
                        return other && other.type === 'Material';
                    });
                    if (domMatConn) {
                        const domMatId = domMatConn.toNode === femDomain.id ? domMatConn.fromNode : domMatConn.toNode;
                        matNode = state.nodes.find(n => n.id === domMatId && n.type === 'Material');
                    }
                }
                if (!matNode) {
                    matNode = state.nodes.find(n => n.type === 'Material' && !isJWLMaterialNode(n) && !isIdealGasMaterialNode(n)) || state.nodes.find(n => n.type === 'Material');
                }
                if (matNode) {
                    Object.entries(matNode.parameters).forEach(([mk, mv]) => {
                        objParams[mk] = numericKeys.includes(mk) ? Number(mv) : mv;
                    });
                }
                if (matNode?.parameters?.['material_model']) {
                    objParams['material_model'] = matNode.parameters['material_model'];
                } else if (!objParams['material_model']) {
                    objParams['material_model'] = objNode.parameters?.['material_model'] || 'Hypoelastic';
                }
                const shapeType = objParams['shape_type'] || (objParams['mesh_source'] === 'Cylinder Generator' ? 'Cylinder' : (objParams['mesh_source'] === 'LS-DYNA Keyword File' ? 'LS-DYNA File' : 'Box'));
                objParams['shape_type'] = shapeType;
                objParams['mesh_source'] = shapeType === 'Cylinder' ? 'Cylinder Generator' : (shapeType === 'LS-DYNA File' ? 'LS-DYNA Keyword File' : 'Box Generator');
                objParams['origin_mode'] = objParams['origin_mode'] || objNode.parameters?.origin_mode || 'Center';

                if (objParams['failure_strain'] === undefined) objParams['failure_strain'] = 0.20;
                if (objParams['tensile_failure_stress'] === undefined) objParams['tensile_failure_stress'] = 400.0e6;

                const canvasMats: any[] = [];
                const matIdMap = new Map<string, number>();
                if (matNode) {
                    canvasMats.push(matNode);
                    matIdMap.set(matNode.id, 0);
                }
                const otherMatNodes = state.nodes.filter(n => n.type === 'Material' && !isJWLMaterialNode(n) && !isIdealGasMaterialNode(n) && n.id !== matNode?.id);
                for (const omn of otherMatNodes) {
                    matIdMap.set(omn.id, canvasMats.length);
                    canvasMats.push(omn);
                }

                if (canvasMats.length > 0) {
                    objParams['fem_materials'] = canvasMats.map(mn => {
                        const mp: any = {};
                        Object.entries(mn.parameters || {}).forEach(([k, v]) => {
                            mp[k] = numericKeys.includes(k) ? Number(v) : v;
                        });
                        if (mn.parameters?.['material_model']) {
                            mp['material_model'] = mn.parameters['material_model'];
                        }
                        return mp;
                    });
                }

                const setup = objNode.parameters?.['fem_setup'] || (femDomain ? femDomain.parameters?.['fem_setup'] : undefined);
                if (setup) {
                    if (setup.parts && Array.isArray(setup.parts)) {
                        const primaryPart = setup.parts.find((p: any) => p.node_id === objNode.id || p.id === objNode.id || p.name === objNode.parameters?.name) || setup.parts[0];
                        if (primaryPart) {
                            if (objNode.parameters?.['nx'] !== undefined) {
                                objParams['nx'] = Number(objNode.parameters['nx']);
                                primaryPart.nx = objParams['nx'];
                            } else if (primaryPart.nx !== undefined) {
                                objParams['nx'] = Number(primaryPart.nx);
                            }
                            if (objNode.parameters?.['ny'] !== undefined) {
                                objParams['ny'] = Number(objNode.parameters['ny']);
                                primaryPart.ny = objParams['ny'];
                            } else if (primaryPart.ny !== undefined) {
                                objParams['ny'] = Number(primaryPart.ny);
                            }
                            if (objNode.parameters?.['nz'] !== undefined) {
                                objParams['nz'] = Number(objNode.parameters['nz']);
                                primaryPart.nz = objParams['nz'];
                            } else if (primaryPart.nz !== undefined) {
                                objParams['nz'] = Number(primaryPart.nz);
                            }
                            if (objNode.parameters?.['size_x'] !== undefined) {
                                objParams['size_x'] = Number(objNode.parameters['size_x']);
                                primaryPart.size_x = objParams['size_x'];
                            } else if (primaryPart.size_x !== undefined) {
                                objParams['size_x'] = Number(primaryPart.size_x);
                            }
                            if (objNode.parameters?.['size_y'] !== undefined) {
                                objParams['size_y'] = Number(objNode.parameters['size_y']);
                                primaryPart.size_y = objParams['size_y'];
                            } else if (primaryPart.size_y !== undefined) {
                                objParams['size_y'] = Number(primaryPart.size_y);
                            }
                            if (objNode.parameters?.['size_z'] !== undefined) {
                                objParams['size_z'] = Number(objNode.parameters['size_z']);
                                primaryPart.size_z = objParams['size_z'];
                            } else if (primaryPart.size_z !== undefined) {
                                objParams['size_z'] = Number(primaryPart.size_z);
                            }
                            if (objNode.parameters?.['pos_x'] !== undefined) {
                                objParams['pos_x'] = Number(objNode.parameters['pos_x']);
                                primaryPart.pos_x = objParams['pos_x'];
                            } else if (primaryPart.pos_x !== undefined) {
                                objParams['pos_x'] = Number(primaryPart.pos_x);
                            }
                            if (objNode.parameters?.['pos_y'] !== undefined) {
                                objParams['pos_y'] = Number(objNode.parameters['pos_y']);
                                primaryPart.pos_y = objParams['pos_y'];
                            } else if (primaryPart.pos_y !== undefined) {
                                objParams['pos_y'] = Number(primaryPart.pos_y);
                            }
                            if (objNode.parameters?.['pos_z'] !== undefined) {
                                objParams['pos_z'] = Number(objNode.parameters['pos_z']);
                                primaryPart.pos_z = objParams['pos_z'];
                            } else if (primaryPart.pos_z !== undefined) {
                                objParams['pos_z'] = Number(primaryPart.pos_z);
                            }
                            if (objNode.parameters?.['origin_mode']) {
                                objParams['origin_mode'] = objNode.parameters['origin_mode'];
                                primaryPart.origin_mode = objParams['origin_mode'];
                            } else if (primaryPart.origin_mode) {
                                objParams['origin_mode'] = primaryPart.origin_mode;
                            }
                            if (objNode.parameters?.['shape_type']) {
                                objParams['shape_type'] = objNode.parameters['shape_type'];
                                primaryPart.shape_type = objParams['shape_type'];
                            } else if (primaryPart.shape_type) {
                                objParams['shape_type'] = primaryPart.shape_type;
                            }
                        }
                        objParams['fem_parts'] = setup.parts.map((p: any) => {
                            const isSelfPart = (setup.parts.length === 1 || p.node_id === objNode.id || p.id === objNode.id);
                            let mappedMatId: number | undefined = undefined;
                            if (typeof p.material_assignment === 'string') {
                                if (matIdMap.has(p.material_assignment)) {
                                    mappedMatId = matIdMap.get(p.material_assignment);
                                } else if (p.material_assignment.startsWith('DECK_MAT_')) {
                                    mappedMatId = canvasMats.length + parseInt(p.material_assignment.replace('DECK_MAT_', ''), 10) - 1;
                                }
                            } else if (typeof p.material_assignment === 'number') {
                                mappedMatId = p.material_assignment;
                            }
                            return {
                                part_id: Number(p.part_id),
                                name: String(p.name || ''),
                                suppressed: p.suppressed === true,
                                visible: p.visible !== false,
                                color: String(p.color || '#3b82f6'),
                                initial_velocity: Array.isArray(p.initial_velocity) ? p.initial_velocity.map(Number) : [0, 0, 0],
                                material_id: mappedMatId,
                                material_assignment: p.material_assignment,
                                failure_strain: p.erosion_override?.failure_strain !== undefined ? Number(p.erosion_override.failure_strain) : undefined,
                                convert_to_mpm: p.erosion_override?.convert_to_mpm === true,
                                shape_type: p.shape_type || objParams['shape_type'] || 'Box',
                                origin_mode: p.origin_mode || objParams['origin_mode'] || 'Center',
                                nx: Number((isSelfPart ? objParams['nx'] : p.nx) ?? objParams['nx'] ?? 10),
                                ny: Number((isSelfPart ? objParams['ny'] : p.ny) ?? objParams['ny'] ?? 10),
                                nz: Number((isSelfPart ? objParams['nz'] : p.nz) ?? objParams['nz'] ?? 10),
                                pos_x: Number((isSelfPart ? objParams['pos_x'] : p.pos_x) ?? objParams['pos_x'] ?? 0),
                                pos_y: Number((isSelfPart ? objParams['pos_y'] : p.pos_y) ?? objParams['pos_y'] ?? 0),
                                pos_z: Number((isSelfPart ? objParams['pos_z'] : p.pos_z) ?? objParams['pos_z'] ?? 0),
                                size_x: Number((isSelfPart ? objParams['size_x'] : p.size_x) ?? objParams['size_x'] ?? 1.0),
                                size_y: Number((isSelfPart ? objParams['size_y'] : p.size_y) ?? objParams['size_y'] ?? 1.0),
                                size_z: Number((isSelfPart ? objParams['size_z'] : p.size_z) ?? objParams['size_z'] ?? 1.0),
                                radius: Number((isSelfPart ? objParams['radius'] : p.radius) ?? objParams['radius'] ?? 0.1),
                                inner_radius: Number((isSelfPart ? objParams['inner_radius'] : p.inner_radius) ?? objParams['inner_radius'] ?? 0.0),
                                height: Number((isSelfPart ? objParams['height'] : p.height) ?? objParams['height'] ?? 0.2)
                            };
                        });
                    }
                    if (setup.sets && Array.isArray(setup.sets)) {
                        objParams['fem_sets'] = setup.sets;
                    }
                    if (setup.boundary_conditions && Array.isArray(setup.boundary_conditions)) {
                        objParams['boundary_conditions'] = setup.boundary_conditions.map((bc: any) => ({
                            id: String(bc.id),
                            name: String(bc.name),
                            bc_type: String(bc.bc_type),
                            target_type: String(bc.target_type),
                            target_id: bc.target_id,
                            dofs: Array.isArray(bc.dofs) ? bc.dofs : [true, true, true, true, true, true],
                            velocity: Array.isArray(bc.velocity) ? bc.velocity.map(Number) : [0, 0, 0],
                            active: bc.active !== false
                        }));
                    }
                    if (setup.contacts && Array.isArray(setup.contacts)) {
                        objParams['fem_contacts'] = setup.contacts;
                    }
                }

                femObjects.push(objParams);
            };

            const objConns = femDomain ? state.connections.filter(c => c.toNode === femDomain.id && (c.toPort === 'objects' || c.toPort === 'mesh' || c.toPort === 'parts' || c.toPort === 'elements' || c.toPort === 'in')) : [];
            for (const conn of objConns) {
                const objNode = state.nodes.find(n => n.id === conn.fromNode);
                processObjNode(objNode);
            }

            state.nodes.filter(n => n.type === 'FEMObject3D' || n.type === 'LSDynaImporter3D').forEach(processObjNode);
            if (femObjects.length > 0) {
                flattenedParams['fem_objects'] = femObjects;
            }

            // Promote global erosion criteria to top-level: prefer explicit object/material erosion parameters over domain defaults
            if (femObjects.length > 0 && femObjects[0]['erosion_strain'] !== undefined) {
                flattenedParams['erosion_strain'] = Number(femObjects[0]['erosion_strain']);
            } else if (femDomain && femDomain.parameters?.['erosion_strain'] !== undefined) {
                flattenedParams['erosion_strain'] = Number(femDomain.parameters['erosion_strain']);
            }
            if (femObjects.length > 0 && femObjects[0]['failure_strain'] !== undefined) {
                flattenedParams['failure_strain'] = Number(femObjects[0]['failure_strain']);
            } else if (femDomain && femDomain.parameters?.['failure_strain'] !== undefined) {
                flattenedParams['failure_strain'] = Number(femDomain.parameters['failure_strain']);
            }
            if (femObjects.length > 0 && femObjects[0]['tensile_failure_stress'] !== undefined) {
                flattenedParams['tensile_failure_stress'] = Number(femObjects[0]['tensile_failure_stress']);
            } else if (femDomain && femDomain.parameters?.['tensile_failure_stress'] !== undefined) {
                flattenedParams['tensile_failure_stress'] = Number(femDomain.parameters['tensile_failure_stress']);
            }
            if (femObjects.length > 0 && femObjects[0]['enable_strain_erosion'] !== undefined) {
                flattenedParams['enable_strain_erosion'] = femObjects[0]['enable_strain_erosion'];
            } else if (femDomain && femDomain.parameters?.['enable_strain_erosion'] !== undefined) {
                flattenedParams['enable_strain_erosion'] = femDomain.parameters['enable_strain_erosion'];
            }
            if (femDomain && femDomain.parameters?.['timestep_erosion_factor'] !== undefined) {
                flattenedParams['timestep_erosion_factor'] = Number(femDomain.parameters['timestep_erosion_factor']);
            }
            if (femDomain && femDomain.parameters?.['min_volume_ratio'] !== undefined) {
                flattenedParams['min_volume_ratio'] = Number(femDomain.parameters['min_volume_ratio']);
            }

            // Serialize standalone FEMBeam3D and FEMRebar3D nodes
            const standaloneBeams: any[] = [];
            const beamNodes = state.nodes.filter(n => n.type === 'FEMBeam3D' || n.type === 'FEMRebar3D');
            for (const bNode of beamNodes) {
                const bParams: any = { ...bNode.parameters, node_type: bNode.type };
                const matConn = state.connections.find(c => c.toNode === bNode.id && (c.toPort === 'material' || c.toPort === 'in'));
                if (matConn) {
                    const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                    if (matNode && matNode.parameters) {
                        Object.entries(matNode.parameters).forEach(([mk, mv]) => {
                            bParams[mk] = numericKeys.includes(mk) ? Number(mv) : mv;
                        });
                    }
                }
                bParams['node1_x'] = Number(bParams['node1_x'] ?? 0.0);
                bParams['node1_y'] = Number(bParams['node1_y'] ?? 0.0);
                bParams['node1_z'] = Number(bParams['node1_z'] ?? 0.0);
                bParams['node2_x'] = Number(bParams['node2_x'] ?? 1.0);
                bParams['node2_y'] = Number(bParams['node2_y'] ?? 0.0);
                bParams['node2_z'] = Number(bParams['node2_z'] ?? 0.0);
                bParams['radius'] = Number(bParams['radius'] ?? (bNode.type === 'FEMRebar3D' ? 0.008 : 0.01));
                bParams['diameter'] = Number(bParams['diameter'] ?? (2.0 * bParams['radius']));
                bParams['failure_strain'] = Number(bParams['failure_strain'] ?? 0.20);
                standaloneBeams.push(bParams);
            }
            if (standaloneBeams.length > 0) {
                flattenedParams['fem_standalone_beams'] = standaloneBeams;
            }

        // 2b. Serialize MPM objects if present (e.g. nearfield water sleeve, soil, debris in multi-physics harbor)
        const mpmDomain = state.nodes.find(n => n.type === 'MPMDomain3D');
        serializeMPMObjectsWithSleeve(state, solverNode3D, mpmDomain, flattenedParams, numericKeys, modelFilename);

        // 3. Serialize FEMFSICoupler3D parameters
        if (couplerNode) {
            Object.entries(couplerNode.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });
            const telemetryConns = state.connections.filter(c => c.fromNode === couplerNode.id && c.fromPort === 'telemetry');
            for (const conn of telemetryConns) {
                const viewNode = state.nodes.find(n => n.id === conn.toNode);
                if (viewNode && viewNode.type === 'Telemetry3DViewport') {
                    if (viewNode.parameters.slices) {
                        flattenedParams['slices'] = viewNode.parameters.slices;
                    }
                    // Trace file output options and other view options
                    Object.entries(viewNode.parameters).forEach(([key, value]) => {
                        if (key !== 'slices' && key !== 'colormap' && key !== 'refresh_rate' && key !== 'log_scale' && key !== 'auto_scale' && key !== 'min_val' && key !== 'max_val' && key !== 'show_grid' && key !== 'interpolate') {
                            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                        }
                    });
                }
            }

            // Trace VTKOutput connected to FEMFSICoupler3D
            const vtkConns = state.connections.filter(c => c.fromNode === couplerNode.id || c.toNode === couplerNode.id);
            for (const conn of vtkConns) {
                const otherId = conn.fromNode === couplerNode.id ? conn.toNode : conn.fromNode;
                const vtkNode = state.nodes.find(n => n.id === otherId);
                if (vtkNode && vtkNode.type === 'VTKOutput') {
                    Object.entries(vtkNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }
        }

        // Fallback: if slices not found from direct connections, search DomainMesh3D or Telemetry3DViewport in the model
        if (!flattenedParams['slices']) {
            const domainMesh = state.nodes.find(n => n.type === 'DomainMesh3D' || n.type === 'DomainMesh');
            if (domainMesh && domainMesh.parameters?.slices) {
                flattenedParams['slices'] = domainMesh.parameters.slices;
            } else {
                const vpNode = state.nodes.find(n => n.type === 'Telemetry3DViewport');
                if (vpNode && vpNode.parameters?.slices) {
                    flattenedParams['slices'] = vpNode.parameters.slices;
                }
            }
        }

        const cellSize = flattenedParams['cell_size'] || 0.01;
        const xmin = flattenedParams['xmin'] !== undefined ? flattenedParams['xmin'] : (flattenedParams['x_min'] !== undefined ? flattenedParams['x_min'] : 0.0);
        const xmax = flattenedParams['xmax'] !== undefined ? flattenedParams['xmax'] : (flattenedParams['x_max'] !== undefined ? flattenedParams['x_max'] : 1.0);
        const ymin = flattenedParams['ymin'] !== undefined ? flattenedParams['ymin'] : (flattenedParams['y_min'] !== undefined ? flattenedParams['y_min'] : 0.0);
        const ymax = flattenedParams['ymax'] !== undefined ? flattenedParams['ymax'] : (flattenedParams['y_max'] !== undefined ? flattenedParams['y_max'] : 1.0);
        const zmin = flattenedParams['zmin'] !== undefined ? flattenedParams['zmin'] : (flattenedParams['z_min'] !== undefined ? flattenedParams['z_min'] : 0.0);
        const zmax = flattenedParams['zmax'] !== undefined ? flattenedParams['zmax'] : (flattenedParams['z_max'] !== undefined ? flattenedParams['z_max'] : 1.0);
        const dimX = xmax - xmin;
        const dimY = ymax - ymin;
        const dimZ = zmax - zmin;
        flattenedParams['nx'] = Math.round(dimX / cellSize);
        flattenedParams['ny'] = Math.round(dimY / cellSize);
        flattenedParams['nz'] = Math.round(dimZ / cellSize);
        flattenedParams['xmin'] = xmin;
        flattenedParams['ymin'] = ymin;
        flattenedParams['zmin'] = zmin;
        flattenedParams['xmax'] = xmax;
        flattenedParams['ymax'] = ymax;
        flattenedParams['zmax'] = zmax;
        flattenedParams['cell_size'] = cellSize;

        const hasChargeConn3D = solverNode3D ? Boolean(state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'charge')) : false;
        const isStratified3D = flattenedParams['init_mode'] === 'Hydrostatic_Stratified_3D' || solverNode3D?.parameters?.init_mode === 'Hydrostatic_Stratified_3D' || solverNode3D?.type === 'MarineHarbourDomain';
        const isRemap3D = flattenedParams['init_mode'] === 'From1D' || flattenedParams['init_mode'] === 'From2D';
        if (!isRemap3D && !isStratified3D) {
            if (!hasChargeConn3D || flattenedParams['init_mode'] === 'Ideal Gas' || flattenedParams['explosive_type'] === 'MaterialIdealGas' || flattenedParams['material_type'] === 'Ideal Gas Charge') {
                flattenedParams['init_mode'] = 'Ideal Gas';
                flattenedParams['is_ideal_gas'] = true;
            } else if (flattenedParams['init_mode'] === 'Multi-Material JWL' || flattenedParams['material_type'] === 'JWL Charge' || flattenedParams['explosive_type'] === 'MaterialExplosive') {
                flattenedParams['init_mode'] = 'Multi-Material JWL';
                flattenedParams['is_ideal_gas'] = false;
            }
        }

        if (!flattenedParams['gamma']) flattenedParams['gamma'] = 1.4;
        const p = flattenedParams['atm_pressure'] || 101325.0;
        const t = flattenedParams['atm_temperature'] || 288.0;
        flattenedParams['ambient_rho'] = p / (287.058 * t);
        if (!flattenedParams['device']) flattenedParams['device'] = 'cpu';

        // 4. Ensure solver parameters from CFDSolver3D have precedence for hardware device/precision/init_mode
        if (solverNode3D) {
            if (!isRemap3D && solverNode3D.parameters.init_mode !== undefined) {
                flattenedParams['init_mode'] = solverNode3D.parameters.init_mode;
                if (flattenedParams['init_mode'] === 'Ideal Gas') {
                    flattenedParams['is_ideal_gas'] = true;
                } else if (flattenedParams['init_mode'] === 'Multi-Material JWL') {
                    flattenedParams['is_ideal_gas'] = false;
                } else if (flattenedParams['init_mode'] === 'Hydrostatic_Stratified_3D') {
                    flattenedParams['is_ideal_gas'] = false;
                    flattenedParams['stratified_equilibrium'] = true;
                }
            }
            if (solverNode3D.parameters.device !== undefined) {
                flattenedParams['device'] = solverNode3D.parameters.device;
            }
            if (solverNode3D.parameters.precision !== undefined) {
                flattenedParams['precision'] = solverNode3D.parameters.precision;
            }
            const cflCandidates = [
                solverNode3D.parameters.cfl !== undefined ? Number(solverNode3D.parameters.cfl) : undefined,
                femDomain?.parameters?.cfl !== undefined ? Number(femDomain.parameters.cfl) : undefined,
                couplerNode?.parameters?.cfl !== undefined ? Number(couplerNode.parameters.cfl) : undefined
            ].filter((v): v is number => v !== undefined && !isNaN(v) && v > 0);
            if (cflCandidates.length > 0) {
                flattenedParams['cfl'] = couplerNode?.parameters?.cfl !== undefined ? Number(couplerNode.parameters.cfl) : Math.min(...cflCandidates);
            }
            if (couplerNode?.parameters?.endtime !== undefined) {
                flattenedParams['endtime'] = Number(couplerNode.parameters.endtime);
            } else if (solverNode3D?.parameters?.endtime !== undefined) {
                flattenedParams['endtime'] = Number(solverNode3D.parameters.endtime);
            }
        }
    } else if (command === "INIT_MPM" || command === "INIT_2D_MPM") {
        const mpmDomain = state.nodes.find(n => n.type === 'MPMDomain2D');
        if (mpmDomain) {
            Object.entries(mpmDomain.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });

            const meshConn = state.connections.find(c => 
                (c.toNode === mpmDomain.id && (c.toPort === 'mesh' || c.toPort === 'in' || c.toPort === 'grid')) ||
                (c.fromNode === mpmDomain.id && (c.fromPort === 'mesh' || c.fromPort === 'grid'))
            );
            const meshId = meshConn ? (meshConn.toNode === mpmDomain.id ? meshConn.fromNode : meshConn.toNode) : '';
            const meshNode = meshId ? state.nodes.find(n => n.id === meshId) : state.nodes.find(n => n.type === 'DomainMesh2D');
            if (meshNode) {
                Object.entries(meshNode.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
                const cellSize = Number(meshNode.parameters?.cell_size ?? 0.005);
                const maxR = Number(meshNode.parameters?.max_r ?? 1.0);
                const maxZ = Number(meshNode.parameters?.max_z ?? 1.0);
                flattenedParams['nr'] = Math.round(maxR / cellSize);
                flattenedParams['nz'] = Math.round(maxZ / cellSize);
                flattenedParams['max_r'] = maxR;
                flattenedParams['max_z'] = maxZ;
            }

            const domainPpc = Number(mpmDomain.parameters?.ppc ?? 4);
            const domainParticleDist = mpmDomain.parameters?.particle_distribution;
            const domainBoundaryFill = mpmDomain.parameters?.boundary_filling;
            flattenedParams['ppc'] = domainPpc;

            const objConns = state.connections.filter(c => c.toNode === mpmDomain.id && c.toPort === 'objects');
            const mpmObjects: any[] = [];
            for (const conn of objConns) {
                const objNode = state.nodes.find(n => n.id === conn.fromNode);
                if (objNode && objNode.type === 'MPMObject2D') {
                    const objParams: any = {};
                    Object.entries(objNode.parameters).forEach(([k, v]) => {
                        objParams[k] = numericKeys.includes(k) ? Number(v) : v;
                    });
                    let matNode: any = null;
                    const matConn = state.connections.find(c => (c.toNode === objNode.id || c.fromNode === objNode.id) && (c.toPort === 'material' || c.fromPort === 'material' || c.toPort === 'in' || c.fromPort === 'out'));
                    if (matConn) {
                        const otherId = matConn.toNode === objNode.id ? matConn.fromNode : matConn.toNode;
                        matNode = state.nodes.find(n => n.id === otherId);
                    } else if (objNode.parameters?.material) {
                        matNode = state.nodes.find(n => n.id === objNode.parameters.material);
                    }
                    if (!matNode) {
                        matNode = state.nodes.find(n => n.type === 'Material' && !isJWLMaterialNode(n) && !isIdealGasMaterialNode(n)) || state.nodes.find(n => n.type === 'Material');
                    }
                    if (matNode) {
                        objParams['material_id'] = matNode.id;
                        objParams['material_name'] = (matNode as any).name || matNode.parameters?.name || matNode.id;
                        Object.entries(matNode.parameters).forEach(([k, v]) => {
                            objParams[k] = numericKeys.includes(k) ? Number(v) : v;
                        });
                    } else {
                        objParams['material_id'] = objNode.parameters?.material || ('mat_' + objNode.id);
                        objParams['material_name'] = objNode.parameters?.material || ('mat_' + objNode.id);
                    }
                    if (matNode?.parameters?.['material_model']) {
                        objParams['material_model'] = matNode.parameters['material_model'];
                    } else if (!objParams['material_model']) {
                        objParams['material_model'] = objNode.parameters?.['material_model'] || 'Hypoelastic';
                    }
                    if (matNode?.parameters?.['solid_model'] !== undefined) {
                        objParams['solid_model'] = matNode.parameters['solid_model'];
                    } else if (objNode.parameters?.['solid_model'] !== undefined) {
                        objParams['solid_model'] = objNode.parameters['solid_model'];
                    }
                    if (matNode?.parameters?.['burn_model'] !== undefined) {
                        objParams['burn_model'] = matNode.parameters['burn_model'];
                    } else if (objNode.parameters?.['burn_model'] !== undefined) {
                        objParams['burn_model'] = objNode.parameters['burn_model'];
                    }
                    if (matNode?.parameters?.['product_model'] !== undefined) {
                        objParams['product_model'] = matNode.parameters['product_model'];
                    } else if (objNode.parameters?.['product_model'] !== undefined) {
                        objParams['product_model'] = objNode.parameters['product_model'];
                    }
                    if (objParams['vel_x'] === undefined && objParams['initial_velocity_x'] !== undefined) objParams['vel_x'] = objParams['initial_velocity_x'];
                    if (objParams['vel_y'] === undefined && objParams['initial_velocity_y'] !== undefined) objParams['vel_y'] = objParams['initial_velocity_y'];
                    objParams['ppc'] = Math.max(1, Math.round(Number(objNode.parameters?.ppc ?? domainPpc)));
                    if (domainParticleDist && (objParams['particle_distribution'] === undefined || objParams['particle_distribution'] === 'Cartesian')) {
                        objParams['particle_distribution'] = domainParticleDist;
                    }
                    if (domainBoundaryFill && (objParams['boundary_filling'] === undefined || objParams['boundary_filling'] === 'Stairstepped')) {
                        objParams['boundary_filling'] = domainBoundaryFill;
                    }
                    mpmObjects.push(objParams);
                }
            }

            const detConns = state.connections.filter(c => c.toNode === mpmDomain.id && (c.toPort === 'detonator' || c.toPort === 'trigger'));
            const detonators: any[] = [];
            for (const conn of detConns) {
                const detNode = state.nodes.find(n => n.id === conn.fromNode);
                if (detNode && (detNode.type === 'DetonatorLocation' || detNode.type === 'TriggerLocation')) {
                    const detParams: any = {};
                    Object.entries(detNode.parameters).forEach(([key, value]) => {
                        detParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                    detonators.push(detParams);
                }
            }
            if (detonators.length === 0) {
                const fallbackDets = state.nodes.filter(n => n.type === 'DetonatorLocation' || n.type === 'TriggerLocation');
                for (const detNode of fallbackDets) {
                    const detParams: any = {};
                    Object.entries(detNode.parameters).forEach(([key, value]) => {
                        detParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                    detonators.push(detParams);
                }
            }
            if (detonators.length > 0) {
                flattenedParams['detonators'] = detonators;
                flattenedParams['triggers'] = detonators;
                Object.entries(detonators[0]).forEach(([key, value]) => {
                    flattenedParams[key] = value;
                });
            }

            let chosenTransferScheme2D = mpmDomain.parameters?.['transfer_scheme'] || 'BSpline';
            if ((!mpmDomain.parameters?.['transfer_scheme'] || mpmDomain.parameters?.['transfer_scheme'] === 'Default') &&
                mpmObjects.length > 0 && mpmObjects[0].transfer_scheme && mpmObjects[0].transfer_scheme !== 'Default') {
                chosenTransferScheme2D = mpmObjects[0].transfer_scheme;
            }
            flattenedParams['transfer_scheme'] = chosenTransferScheme2D;

            flattenedParams['mpm_objects'] = mpmObjects;
        }
    } else if (command === "INIT_MPM_3D" || command === "INIT_3D_MPM") {
        const mpmDomain = state.nodes.find(n => n.type === 'MPMDomain3D');
        if (mpmDomain) {
            let meshConn = state.connections.find(c => 
                (c.toNode === mpmDomain.id && (c.toPort === 'mesh' || c.toPort === 'in' || c.toPort === 'grid')) ||
                (c.fromNode === mpmDomain.id && (c.fromPort === 'mesh' || c.fromPort === 'grid'))
            );
            let meshId = meshConn ? (meshConn.toNode === mpmDomain.id ? meshConn.fromNode : meshConn.toNode) : '';
            let meshNode = meshId ? state.nodes.find(n => n.id === meshId) : state.nodes.find(n => n.type === 'DomainMesh3D');
            if (!meshNode) {
                throw new Error("Cannot initialize MPM 3D: No DomainMesh3D background grid connected to MPM Domain 3D. You must define a background grid.");
            }
            Object.entries(meshNode.parameters).forEach(([key, value]) => {
                flattenedParams[key] = castParam(key, value);
            });

            // MPMDomain3D parameters MUST HAVE ABSOLUTE PRECEDENCE
            Object.entries(mpmDomain.parameters).forEach(([key, value]) => {
                flattenedParams[key] = castParam(key, value);
            });

            const cellSize = Number(mpmDomain.parameters?.cell_size ?? meshNode?.parameters?.cell_size ?? 0.01);
            const xmin = Number(mpmDomain.parameters?.xmin ?? mpmDomain.parameters?.x_min ?? meshNode?.parameters?.xmin ?? meshNode?.parameters?.x_min ?? 0.0);
            const xmax = Number(mpmDomain.parameters?.xmax ?? mpmDomain.parameters?.x_max ?? meshNode?.parameters?.xmax ?? meshNode?.parameters?.x_max ?? 1.0);
            const ymin = Number(mpmDomain.parameters?.ymin ?? mpmDomain.parameters?.y_min ?? meshNode?.parameters?.ymin ?? meshNode?.parameters?.y_min ?? 0.0);
            const ymax = Number(mpmDomain.parameters?.ymax ?? mpmDomain.parameters?.y_max ?? meshNode?.parameters?.ymax ?? meshNode?.parameters?.y_max ?? 1.0);
            const zmin = Number(mpmDomain.parameters?.zmin ?? mpmDomain.parameters?.z_min ?? meshNode?.parameters?.zmin ?? meshNode?.parameters?.z_min ?? 0.0);
            const zmax = Number(mpmDomain.parameters?.zmax ?? mpmDomain.parameters?.z_max ?? meshNode?.parameters?.zmax ?? meshNode?.parameters?.z_max ?? 1.0);

            flattenedParams['cell_size'] = cellSize;
            flattenedParams['xmin'] = xmin;
            flattenedParams['xmax'] = xmax;
            flattenedParams['ymin'] = ymin;
            flattenedParams['ymax'] = ymax;
            flattenedParams['zmin'] = zmin;
            flattenedParams['zmax'] = zmax;
            flattenedParams['nx'] = Math.round((xmax - xmin) / cellSize);
            flattenedParams['ny'] = Math.round((ymax - ymin) / cellSize);
            flattenedParams['nz'] = Math.round((zmax - zmin) / cellSize);

            const domainPpc = Number(mpmDomain.parameters?.ppc ?? 8);
            const domainParticleDist = mpmDomain.parameters?.particle_distribution;
            const domainBoundaryFill = mpmDomain.parameters?.boundary_filling;
            flattenedParams['ppc'] = domainPpc;
            flattenedParams['device'] = mpmDomain.parameters?.device || 'gpu';

            const objConns = state.connections.filter(c => c.toNode === mpmDomain.id && (c.toPort === 'objects' || c.toPort === 'mpm_objects' || c.toPort === 'in'));
            let targetObjNodes = objConns.map(c => state.nodes.find(n => n.id === c.fromNode)).filter(n => n && n.type === 'MPMObject3D');
            if (targetObjNodes.length === 0) {
                targetObjNodes = state.nodes.filter(n => n.type === 'MPMObject3D');
            }

            const mpmObjects: any[] = [];
            for (const objNode of targetObjNodes) {
                if (!objNode) continue;
                const objParams: any = {};
                Object.entries(objNode.parameters).forEach(([k, v]) => {
                    objParams[k] = castParam(k, v);
                });
                if (!objParams['shape_type'] && objNode.parameters?.shape) {
                    objParams['shape_type'] = objNode.parameters.shape;
                }
                const stlConn = state.connections.find(c => c.toNode === objNode.id && c.toPort === 'stl');
                let stlNode = stlConn ? state.nodes.find(n => n.id === stlConn.fromNode) : null;
                if (objNode.parameters?.shape_type === 'STL' && !stlNode) {
                    stlNode = state.nodes.find(n => n.type === 'STLGeometry');
                }
                if (stlNode && stlNode.type === 'STLGeometry' && (stlConn || objNode.parameters?.shape_type === 'STL')) {
                    objParams['stl_file'] = resolveResourcePath(stlNode.parameters.stl_file || '', modelFilename);
                    objParams['shape_type'] = 'STL';
                    if (stlNode.parameters.voxelization_method) {
                        objParams['voxelization_method'] = stlNode.parameters.voxelization_method;
                    }
                    if (stlNode.parameters.origin_mode) {
                        objParams['origin_mode'] = stlNode.parameters.origin_mode;
                    }
                    ['scale_x', 'scale_y', 'scale_z', 'pos_x', 'pos_y', 'pos_z', 'rot_x', 'rot_y', 'rot_z'].forEach(k => {
                        if (stlNode!.parameters[k] !== undefined) {
                            objParams[k] = Number(stlNode!.parameters[k]);
                        }
                    });
                } else if (objParams['stl_file']) {
                    objParams['stl_file'] = resolveResourcePath(objParams['stl_file'], modelFilename);
                }
                if (objNode.parameters?.voxelization_method && !stlConn) {
                    objParams['voxelization_method'] = objNode.parameters.voxelization_method;
                }
                let matNode: any = null;
                const matConn = state.connections.find(c => (c.toNode === objNode.id || c.fromNode === objNode.id) && (c.toPort === 'material' || c.fromPort === 'material'));
                if (matConn) {
                    const otherId = matConn.toNode === objNode.id ? matConn.fromNode : matConn.toNode;
                    matNode = state.nodes.find(n => n.id === otherId);
                } else if (objNode.parameters?.material) {
                    const candidateByParam = state.nodes.find(n => n.id === objNode.parameters.material) || null;
                    if (candidateByParam) {
                        // Pre-compute if this object looks explosive so we can validate the stored pointer
                        const _preIdentifiers = [
                            objNode.id,
                            (objNode as any).name || '',
                            objNode.parameters?.name || '',
                            objNode.parameters?.stl_file || '',
                            objNode.parameters?.shape_type || ''
                        ].join(' ').toLowerCase();
                        const _preIsExplosive = _preIdentifiers.includes('explosive') || _preIdentifiers.includes('charge') ||
                            _preIdentifiers.includes('c4') || _preIdentifiers.includes('c-4') ||
                            _preIdentifiers.includes('lx14') || _preIdentifiers.includes('lx-14') ||
                            _preIdentifiers.includes('comp b') || _preIdentifiers.includes('tnt') ||
                            _preIdentifiers.includes('rdx') || _preIdentifiers.includes('hmx') ||
                            _preIdentifiers.includes('petn');

                        if (_preIsExplosive) {
                            // Only trust the stored pointer if it leads to an explosive material
                            const _cMatName = [candidateByParam.id, (candidateByParam as any).name || '', candidateByParam.parameters?.name || '', candidateByParam.parameters?.preset || ''].join(' ').toLowerCase();
                            const _cIsExplosive = _cMatName.includes('explosive') || _cMatName.includes('lx-14') || _cMatName.includes('c-4') ||
                                candidateByParam.parameters?.material_model === 'CREST Reactive Burn' || isJWLMaterialNode(candidateByParam);
                            if (_cIsExplosive) {
                                matNode = candidateByParam;
                            }
                            // else: stale pointer to a non-explosive material — fall through to heuristic below
                        } else {
                            matNode = candidateByParam;
                        }
                    }
                }
                if (!matNode) {
                    const objIdentifiers = [
                        objNode.id,
                        (objNode as any).name || '',
                        objNode.parameters?.name || '',
                        objNode.parameters?.stl_file || '',
                        objNode.parameters?.shape_type || ''
                    ].join(' ').toLowerCase();

                    const isObjExplosive = objIdentifiers.includes('explosive') ||
                                           objIdentifiers.includes('charge') ||
                                           objIdentifiers.includes('c4') ||
                                           objIdentifiers.includes('c-4') ||
                                           objIdentifiers.includes('lx14') ||
                                           objIdentifiers.includes('lx-14') ||
                                           objIdentifiers.includes('comp b') ||
                                           objIdentifiers.includes('tnt') ||
                                           objIdentifiers.includes('rdx') ||
                                           objIdentifiers.includes('hmx') ||
                                           objIdentifiers.includes('petn');

                    if (isObjExplosive) {
                        matNode = state.nodes.find(n => n.type === 'Material' && (
                            [n.id, (n as any).name || '', n.parameters?.name || '', n.parameters?.preset || ''].join(' ').toLowerCase().includes('explosive') ||
                            n.parameters?.material_model === 'CREST Reactive Burn' ||
                            isJWLMaterialNode(n)
                        ));
                    }
                    if (!matNode) {
                        // Match by name if possible (e.g. Casing -> Casing Material, Projectile -> Projectile Material)
                        const objBaseName = ((objNode as any).name || objNode.parameters?.name || '').toLowerCase().trim();
                        if (objBaseName) {
                            matNode = state.nodes.find(n => n.type === 'Material' && (
                                [(n as any).name || '', n.parameters?.name || '', n.parameters?.preset || ''].join(' ').toLowerCase().includes(objBaseName)
                            ));
                        }
                    }
                    if (!matNode && !isObjExplosive) {
                        matNode = state.nodes.find(n => n.type === 'Material' && !isJWLMaterialNode(n) && !isIdealGasMaterialNode(n)) || state.nodes.find(n => n.type === 'Material');
                    }
                }
                if (matNode) {
                    if (matConn || objNode.parameters?.material) {
                        objParams['material_id'] = matNode.id;
                        objParams['material_name'] = (matNode as any).name || matNode.parameters?.name || matNode.id;
                    } else {
                        // Inherited constitutive parameters from fallback material, but retain unique material identity
                        // per object so unconnected bodies do not unintentionally fuse into a single velocity field
                        objParams['material_id'] = 'mat_' + objNode.id;
                        objParams['material_name'] = ((matNode as any).name || matNode.parameters?.name || 'Material') + '_' + objNode.id;
                    }
                    Object.entries(matNode.parameters).forEach(([k, v]) => {
                        objParams[k] = castParam(k, v);
                    });
                } else {
                    objParams['material_id'] = objNode.parameters?.material || ('mat_' + objNode.id);
                    objParams['material_name'] = objNode.parameters?.material || ('mat_' + objNode.id);
                }

                // Re-apply explicit objNode parameters to ensure geometric precedence over material defaults
                const nonConstitutiveKeys = [
                    'name', 'shape', 'shape_type', 'pos_x', 'pos_y', 'pos_z',
                    'scale_x', 'scale_y', 'scale_z', 'rot_x', 'rot_y', 'rot_z',
                    'size_x', 'size_y', 'size_z', 'radius', 'inner_radius', 'height',
                    'vel_x', 'vel_y', 'vel_z', 'angular_vel_x', 'angular_vel_y', 'angular_vel_z',
                    'initial_velocity_x', 'initial_velocity_y', 'initial_velocity_z',
                    'ppc', 'particle_distribution', 'boundary_filling', 'origin_mode',
                    'voxelization_method', 'stl_file', 'stl_volume'
                ];
                Object.entries(objNode.parameters).forEach(([k, v]) => {
                    if (nonConstitutiveKeys.includes(k) || !matNode) {
                        objParams[k] = castParam(k, v);
                    }
                });

                // When linked to an STLGeometry node, re-apply STL transform and mesh parameters
                // so they are not clobbered by default MPMObject3D geometric properties
                if (stlNode && stlNode.type === 'STLGeometry' && (stlConn || objNode.parameters?.shape_type === 'STL')) {
                    objParams['stl_file'] = resolveResourcePath(stlNode.parameters.stl_file || '', modelFilename);
                    objParams['shape_type'] = 'STL';
                    if (stlNode.parameters.voxelization_method) {
                        objParams['voxelization_method'] = stlNode.parameters.voxelization_method;
                    }
                    if (stlNode.parameters.origin_mode) {
                        objParams['origin_mode'] = stlNode.parameters.origin_mode;
                    }
                    ['scale_x', 'scale_y', 'scale_z', 'pos_x', 'pos_y', 'pos_z', 'rot_x', 'rot_y', 'rot_z'].forEach(k => {
                        if (stlNode!.parameters[k] !== undefined) {
                            objParams[k] = Number(stlNode!.parameters[k]);
                        }
                    });
                }

                if (matNode?.parameters?.['material_model']) {
                    objParams['material_model'] = matNode.parameters['material_model'];
                } else if (!objParams['material_model']) {
                    objParams['material_model'] = objNode.parameters?.['material_model'] || 'Hypoelastic';
                }
                if (matNode?.parameters?.['solid_model'] !== undefined) {
                    objParams['solid_model'] = matNode.parameters['solid_model'];
                } else if (objNode.parameters?.['solid_model'] !== undefined) {
                    objParams['solid_model'] = objNode.parameters['solid_model'];
                }
                if (matNode?.parameters?.['burn_model'] !== undefined) {
                    objParams['burn_model'] = matNode.parameters['burn_model'];
                } else if (objNode.parameters?.['burn_model'] !== undefined) {
                    objParams['burn_model'] = objNode.parameters['burn_model'];
                }
                if (matNode?.parameters?.['product_model'] !== undefined) {
                    objParams['product_model'] = matNode.parameters['product_model'];
                } else if (objNode.parameters?.['product_model'] !== undefined) {
                    objParams['product_model'] = objNode.parameters['product_model'];
                }

                // Only overwrite shape_type/position if NOT already set by a connected STLGeometry node
                if (objParams['shape_type'] === undefined) {
                    objParams['shape_type'] = objNode.parameters?.shape_type || objNode.parameters?.shape || 'Box';
                }
                const isSTL = (objParams['shape_type'] === 'STL' || objNode.parameters?.shape_type === 'STL');
                const isCADOrigin = (objParams['origin_mode'] === 'CAD Origin' || objNode.parameters?.origin_mode === 'CAD Origin' || !objParams['origin_mode']);
                if (isSTL && isCADOrigin) {
                    if (objParams['pos_x'] === undefined || objParams['pos_x'] === 0.5) objParams['pos_x'] = 0.0;
                    if (objParams['pos_y'] === undefined || objParams['pos_y'] === 0.5) objParams['pos_y'] = 0.0;
                    if (objParams['pos_z'] === undefined || objParams['pos_z'] === 0.5) objParams['pos_z'] = 0.0;
                } else {
                    if (objParams['pos_x'] === undefined) objParams['pos_x'] = Number(objNode.parameters?.pos_x ?? 0.0);
                    if (objParams['pos_y'] === undefined) objParams['pos_y'] = Number(objNode.parameters?.pos_y ?? 0.0);
                    if (objParams['pos_z'] === undefined) objParams['pos_z'] = Number(objNode.parameters?.pos_z ?? 0.0);
                }
                objParams['radius'] = Number(objNode.parameters?.radius ?? (objNode.parameters?.size_x !== undefined ? Number(objNode.parameters.size_x) / 2.0 : 0.1));
                objParams['inner_radius'] = Number(objNode.parameters?.inner_radius ?? 0.0);
                objParams['height'] = Number(objNode.parameters?.height ?? objNode.parameters?.length ?? objNode.parameters?.size_z ?? 0.2);
                objParams['vel_x'] = Number(objNode.parameters?.vel_x ?? objNode.parameters?.initial_velocity_x ?? 0.0);
                objParams['vel_y'] = Number(objNode.parameters?.vel_y ?? objNode.parameters?.initial_velocity_y ?? 0.0);
                objParams['vel_z'] = Number(objNode.parameters?.vel_z ?? objNode.parameters?.initial_velocity_z ?? 0.0);
                objParams['ppc'] = Math.max(1, Math.round(Number(objNode.parameters?.ppc ?? domainPpc)));

                if (domainParticleDist && (objParams['particle_distribution'] === undefined || objParams['particle_distribution'] === 'Cartesian')) {
                    objParams['particle_distribution'] = domainParticleDist;
                }
                if (domainBoundaryFill && (objParams['boundary_filling'] === undefined || objParams['boundary_filling'] === 'Stairstepped')) {
                    objParams['boundary_filling'] = domainBoundaryFill;
                }
                mpmObjects.push(objParams);
            }

            const detConns = state.connections.filter(c => c.toNode === mpmDomain.id && (c.toPort === 'detonator' || c.toPort === 'trigger'));
            const detonators: any[] = [];
            for (const conn of detConns) {
                const detNode = state.nodes.find(n => n.id === conn.fromNode);
                if (detNode && (detNode.type === 'DetonatorLocation3D' || detNode.type === 'DetonatorLocation' || detNode.type === 'TriggerLocation3D' || detNode.type === 'TriggerLocation')) {
                    const detParams: any = {};
                    Object.entries(detNode.parameters).forEach(([key, value]) => {
                        detParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                    detonators.push(detParams);
                }
            }
            if (detonators.length === 0) {
                // Scope fallback detonator search to nodes connected to this MPMDomain only (avoid cross-model contamination)
                const mpmDomainConnectedIds = new Set<string>(
                    state.connections
                        .filter(c => c.toNode === mpmDomain.id || c.fromNode === mpmDomain.id)
                        .flatMap(c => [c.fromNode, c.toNode])
                );
                mpmDomainConnectedIds.add(mpmDomain.id);
                const fallbackDets = state.nodes.filter(n => (n.type === 'DetonatorLocation3D' || n.type === 'DetonatorLocation' || n.type === 'TriggerLocation3D' || n.type === 'TriggerLocation') && mpmDomainConnectedIds.has(n.id));
                for (const detNode of fallbackDets) {
                    const detParams: any = {};
                    Object.entries(detNode.parameters).forEach(([key, value]) => {
                        detParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                    detonators.push(detParams);
                }
            }
            if (detonators.length > 0) {
                flattenedParams['detonators'] = detonators;
                flattenedParams['triggers'] = detonators;
                Object.entries(detonators[0]).forEach(([key, value]) => {
                    flattenedParams[key] = value;
                });
            }

            let chosenTransferScheme3D = mpmDomain.parameters?.['transfer_scheme'] || 'BSpline';
            if ((!mpmDomain.parameters?.['transfer_scheme'] || mpmDomain.parameters?.['transfer_scheme'] === 'Default') &&
                mpmObjects.length > 0 && mpmObjects[0].transfer_scheme && mpmObjects[0].transfer_scheme !== 'Default') {
                chosenTransferScheme3D = mpmObjects[0].transfer_scheme;
            }
            flattenedParams['transfer_scheme'] = chosenTransferScheme3D;

            flattenedParams['mpm_objects'] = mpmObjects;

            // Trace VTKOutput connected to MPMDomain3D
            const vtkConns = state.connections.filter(c => c.fromNode === mpmDomain.id || c.toNode === mpmDomain.id);
            for (const conn of vtkConns) {
                const otherId = conn.fromNode === mpmDomain.id ? conn.toNode : conn.fromNode;
                const vtkNode = state.nodes.find(n => n.id === otherId);
                if (vtkNode && vtkNode.type === 'VTKOutput') {
                    Object.entries(vtkNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }

            // Trace Telemetry3DViewport connected to MPMDomain3D
            const telemetryConns = state.connections.filter(c => (c.fromNode === mpmDomain.id || c.toNode === mpmDomain.id) && (c.fromPort === 'telemetry' || c.toPort === 'telemetry' || c.fromPort === 'in' || c.toPort === 'in'));
            for (const conn of telemetryConns) {
                const otherId = conn.fromNode === mpmDomain.id ? conn.toNode : conn.fromNode;
                const viewNode = state.nodes.find(n => n.id === otherId);
                if (viewNode && viewNode.type === 'Telemetry3DViewport') {
                    if (viewNode.parameters.slices) {
                        flattenedParams['slices'] = viewNode.parameters.slices;
                    }
                    Object.entries(viewNode.parameters).forEach(([key, value]) => {
                        if (key !== 'slices' && key !== 'colormap' && key !== 'refresh_rate' && key !== 'log_scale' && key !== 'auto_scale' && key !== 'min_val' && key !== 'max_val' && key !== 'show_grid' && key !== 'interpolate') {
                            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                        }
                    });
                }
            }

            // Fallback: if slices not found from direct connections, search DomainMesh3D or Telemetry3DViewport in the model
            if (!flattenedParams['slices']) {
                const domainMesh = state.nodes.find(n => n.type === 'DomainMesh3D' || n.type === 'DomainMesh');
                if (domainMesh && domainMesh.parameters?.slices) {
                    flattenedParams['slices'] = domainMesh.parameters.slices;
                } else {
                    const vpNode = state.nodes.find(n => n.type === 'Telemetry3DViewport');
                    if (vpNode && vpNode.parameters?.slices) {
                        flattenedParams['slices'] = vpNode.parameters.slices;
                    }
                }
            }
        }
    } else if (command === "INIT_FEM_3D" || command === "INIT_3D_FEM") {
        const femDomain = state.nodes.find(n => n.type === 'FEMDomain3D');
        if (femDomain) {
            Object.entries(femDomain.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });

            const femObjects: any[] = [];
            const processedNodeIds = new Set<string>();

            const processObjNode = (objNode: any) => {
                if (!objNode || (objNode.type !== 'FEMObject3D' && objNode.type !== 'LSDynaImporter3D') || processedNodeIds.has(objNode.id)) return;
                processedNodeIds.add(objNode.id);

                const objParams: any = {};
                Object.entries(objNode.parameters).forEach(([k, v]) => {
                    objParams[k] = numericKeys.includes(k) ? Number(v) : v;
                });
                if (objNode.type === 'LSDynaImporter3D') {
                    objParams['k_file'] = resolveResourcePath(objNode.parameters.k_file || '', modelFilename);
                    objParams['mesh_source'] = 'LS-DYNA Keyword File';
                    objParams['shape_type'] = 'LS-DYNA File';
                    if (objNode.parameters.scale_factor !== undefined) {
                        objParams['scale_factor'] = Number(objNode.parameters.scale_factor);
                    }
                } else {
                    const impConn = state.connections.find(c => c.toNode === objNode.id && c.toPort === 'importer');
                    if (impConn) {
                        const impNode = state.nodes.find(n => n.id === impConn.fromNode);
                        if (impNode && impNode.type === 'LSDynaImporter3D') {
                            objParams['k_file'] = resolveResourcePath(impNode.parameters.k_file || '', modelFilename);
                            objParams['mesh_source'] = 'LS-DYNA Keyword File';
                            objParams['shape_type'] = 'LS-DYNA File';
                            if (impNode.parameters.scale_factor !== undefined) {
                                objParams['scale_factor'] = Number(impNode.parameters.scale_factor);
                            }
                        }
                    } else if (objParams['k_file']) {
                        objParams['k_file'] = resolveResourcePath(objParams['k_file'], modelFilename);
                    }
                }
                if (objParams['stl_file']) {
                    objParams['stl_file'] = resolveResourcePath(objParams['stl_file'], modelFilename);
                }
                let matNode: any = null;
                const matConn = state.connections.find(c => {
                    const otherId = c.toNode === objNode.id ? c.fromNode : (c.fromNode === objNode.id ? c.toNode : null);
                    if (!otherId) return false;
                    const other = state.nodes.find(n => n.id === otherId);
                    return other && other.type === 'Material';
                });
                if (matConn) {
                    const otherId = matConn.toNode === objNode.id ? matConn.fromNode : matConn.toNode;
                    matNode = state.nodes.find(n => n.id === otherId && n.type === 'Material');
                } else if (objNode.parameters?.material) {
                    matNode = state.nodes.find(n => n.id === objNode.parameters.material && n.type === 'Material');
                }
                if (!matNode) {
                    const domMatConn = state.connections.find(c => {
                        const otherId = c.toNode === femDomain.id ? c.fromNode : (c.fromNode === femDomain.id ? c.toNode : null);
                        if (!otherId) return false;
                        const other = state.nodes.find(n => n.id === otherId);
                        return other && other.type === 'Material';
                    });
                    if (domMatConn) {
                        const domMatId = domMatConn.toNode === femDomain.id ? domMatConn.fromNode : domMatConn.toNode;
                        matNode = state.nodes.find(n => n.id === domMatId && n.type === 'Material');
                    }
                }
                if (!matNode) {
                    matNode = state.nodes.find(n => n.type === 'Material' && !isJWLMaterialNode(n) && !isIdealGasMaterialNode(n)) || state.nodes.find(n => n.type === 'Material');
                }
                if (matNode) {
                    Object.entries(matNode.parameters).forEach(([mk, mv]) => {
                        objParams[mk] = numericKeys.includes(mk) ? Number(mv) : mv;
                    });
                }
                if (matNode?.parameters?.['material_model']) {
                    objParams['material_model'] = matNode.parameters['material_model'];
                } else if (!objParams['material_model']) {
                    objParams['material_model'] = objNode.parameters?.['material_model'] || 'Hypoelastic';
                }
                const shapeType = objParams['shape_type'] || (objParams['mesh_source'] === 'Cylinder Generator' ? 'Cylinder' : (objParams['mesh_source'] === 'LS-DYNA Keyword File' ? 'LS-DYNA File' : 'Box'));
                objParams['shape_type'] = shapeType;
                objParams['mesh_source'] = shapeType === 'Cylinder' ? 'Cylinder Generator' : (shapeType === 'LS-DYNA File' ? 'LS-DYNA Keyword File' : 'Box Generator');
                objParams['origin_mode'] = objParams['origin_mode'] || objNode.parameters?.origin_mode || 'Center';

                if (objParams['failure_strain'] === undefined) objParams['failure_strain'] = 0.20;
                if (objParams['tensile_failure_stress'] === undefined) objParams['tensile_failure_stress'] = 400.0e6;

                const canvasMats: any[] = [];
                const matIdMap = new Map<string, number>();
                if (matNode) {
                    canvasMats.push(matNode);
                    matIdMap.set(matNode.id, 0);
                }
                const otherMatNodes = state.nodes.filter(n => n.type === 'Material' && !isJWLMaterialNode(n) && !isIdealGasMaterialNode(n) && n.id !== matNode?.id);
                for (const omn of otherMatNodes) {
                    matIdMap.set(omn.id, canvasMats.length);
                    canvasMats.push(omn);
                }

                if (canvasMats.length > 0) {
                    objParams['fem_materials'] = canvasMats.map(mn => {
                        const mp: any = {};
                        Object.entries(mn.parameters || {}).forEach(([k, v]) => {
                            mp[k] = numericKeys.includes(k) ? Number(v) : v;
                        });
                        if (mn.parameters?.['material_model']) {
                            mp['material_model'] = mn.parameters['material_model'];
                        }
                        return mp;
                    });
                }

                const setup = objNode.parameters?.['fem_setup'] || femDomain.parameters?.['fem_setup'];
                if (setup) {
                    if (setup.parts && Array.isArray(setup.parts)) {
                        const primaryPart = setup.parts.find((p: any) => p.node_id === objNode.id || p.id === objNode.id || p.name === objNode.parameters?.name) || setup.parts[0];
                        if (primaryPart) {
                            if (objNode.parameters?.['nx'] !== undefined) {
                                objParams['nx'] = Number(objNode.parameters['nx']);
                                primaryPart.nx = objParams['nx'];
                            } else if (primaryPart.nx !== undefined) {
                                objParams['nx'] = Number(primaryPart.nx);
                            }
                            if (objNode.parameters?.['ny'] !== undefined) {
                                objParams['ny'] = Number(objNode.parameters['ny']);
                                primaryPart.ny = objParams['ny'];
                            } else if (primaryPart.ny !== undefined) {
                                objParams['ny'] = Number(primaryPart.ny);
                            }
                            if (objNode.parameters?.['nz'] !== undefined) {
                                objParams['nz'] = Number(objNode.parameters['nz']);
                                primaryPart.nz = objParams['nz'];
                            } else if (primaryPart.nz !== undefined) {
                                objParams['nz'] = Number(primaryPart.nz);
                            }
                            if (objNode.parameters?.['size_x'] !== undefined) {
                                objParams['size_x'] = Number(objNode.parameters['size_x']);
                                primaryPart.size_x = objParams['size_x'];
                            } else if (primaryPart.size_x !== undefined) {
                                objParams['size_x'] = Number(primaryPart.size_x);
                            }
                            if (objNode.parameters?.['size_y'] !== undefined) {
                                objParams['size_y'] = Number(objNode.parameters['size_y']);
                                primaryPart.size_y = objParams['size_y'];
                            } else if (primaryPart.size_y !== undefined) {
                                objParams['size_y'] = Number(primaryPart.size_y);
                            }
                            if (objNode.parameters?.['size_z'] !== undefined) {
                                objParams['size_z'] = Number(objNode.parameters['size_z']);
                                primaryPart.size_z = objParams['size_z'];
                            } else if (primaryPart.size_z !== undefined) {
                                objParams['size_z'] = Number(primaryPart.size_z);
                            }
                            if (objNode.parameters?.['pos_x'] !== undefined) {
                                objParams['pos_x'] = Number(objNode.parameters['pos_x']);
                                primaryPart.pos_x = objParams['pos_x'];
                            } else if (primaryPart.pos_x !== undefined) {
                                objParams['pos_x'] = Number(primaryPart.pos_x);
                            }
                            if (objNode.parameters?.['pos_y'] !== undefined) {
                                objParams['pos_y'] = Number(objNode.parameters['pos_y']);
                                primaryPart.pos_y = objParams['pos_y'];
                            } else if (primaryPart.pos_y !== undefined) {
                                objParams['pos_y'] = Number(primaryPart.pos_y);
                            }
                            if (objNode.parameters?.['pos_z'] !== undefined) {
                                objParams['pos_z'] = Number(objNode.parameters['pos_z']);
                                primaryPart.pos_z = objParams['pos_z'];
                            } else if (primaryPart.pos_z !== undefined) {
                                objParams['pos_z'] = Number(primaryPart.pos_z);
                            }
                            if (objNode.parameters?.['origin_mode']) {
                                objParams['origin_mode'] = objNode.parameters['origin_mode'];
                                primaryPart.origin_mode = objParams['origin_mode'];
                            } else if (primaryPart.origin_mode) {
                                objParams['origin_mode'] = primaryPart.origin_mode;
                            }
                            if (objNode.parameters?.['shape_type']) {
                                objParams['shape_type'] = objNode.parameters['shape_type'];
                                primaryPart.shape_type = objParams['shape_type'];
                            } else if (primaryPart.shape_type) {
                                objParams['shape_type'] = primaryPart.shape_type;
                            }
                        }
                        objParams['fem_parts'] = setup.parts.map((p: any) => {
                            const isSelfPart = (setup.parts.length === 1 || p.node_id === objNode.id || p.id === objNode.id);
                            let mappedMatId: number | undefined = undefined;
                            if (typeof p.material_assignment === 'string') {
                                if (matIdMap.has(p.material_assignment)) {
                                    mappedMatId = matIdMap.get(p.material_assignment);
                                } else if (p.material_assignment.startsWith('DECK_MAT_')) {
                                    mappedMatId = canvasMats.length + parseInt(p.material_assignment.replace('DECK_MAT_', ''), 10) - 1;
                                }
                            } else if (typeof p.material_assignment === 'number') {
                                mappedMatId = p.material_assignment;
                            }
                            return {
                                part_id: Number(p.part_id),
                                name: String(p.name || ''),
                                suppressed: p.suppressed === true,
                                visible: p.visible !== false,
                                color: String(p.color || '#3b82f6'),
                                initial_velocity: Array.isArray(p.initial_velocity) ? p.initial_velocity.map(Number) : [0, 0, 0],
                                material_id: mappedMatId,
                                material_assignment: p.material_assignment,
                                failure_strain: p.erosion_override?.failure_strain !== undefined ? Number(p.erosion_override.failure_strain) : undefined,
                                convert_to_mpm: p.erosion_override?.convert_to_mpm === true,
                                shape_type: p.shape_type || objParams['shape_type'] || 'Box',
                                origin_mode: p.origin_mode || objParams['origin_mode'] || 'Center',
                                nx: Number((isSelfPart ? objParams['nx'] : p.nx) ?? objParams['nx'] ?? 10),
                                ny: Number((isSelfPart ? objParams['ny'] : p.ny) ?? objParams['ny'] ?? 10),
                                nz: Number((isSelfPart ? objParams['nz'] : p.nz) ?? objParams['nz'] ?? 10),
                                pos_x: Number((isSelfPart ? objParams['pos_x'] : p.pos_x) ?? objParams['pos_x'] ?? 0),
                                pos_y: Number((isSelfPart ? objParams['pos_y'] : p.pos_y) ?? objParams['pos_y'] ?? 0),
                                pos_z: Number((isSelfPart ? objParams['pos_z'] : p.pos_z) ?? objParams['pos_z'] ?? 0),
                                size_x: Number((isSelfPart ? objParams['size_x'] : p.size_x) ?? objParams['size_x'] ?? 1.0),
                                size_y: Number((isSelfPart ? objParams['size_y'] : p.size_y) ?? objParams['size_y'] ?? 1.0),
                                size_z: Number((isSelfPart ? objParams['size_z'] : p.size_z) ?? objParams['size_z'] ?? 1.0),
                                radius: Number((isSelfPart ? objParams['radius'] : p.radius) ?? objParams['radius'] ?? 0.1),
                                inner_radius: Number((isSelfPart ? objParams['inner_radius'] : p.inner_radius) ?? objParams['inner_radius'] ?? 0.0),
                                height: Number((isSelfPart ? objParams['height'] : p.height) ?? objParams['height'] ?? 0.2)
                            };
                        });
                    }
                    if (setup.sets && Array.isArray(setup.sets)) {
                        objParams['fem_sets'] = setup.sets;
                    }
                    if (setup.boundary_conditions && Array.isArray(setup.boundary_conditions)) {
                        objParams['boundary_conditions'] = setup.boundary_conditions.map((bc: any) => ({
                            id: String(bc.id),
                            name: String(bc.name),
                            bc_type: String(bc.bc_type),
                            target_type: String(bc.target_type),
                            target_id: bc.target_id,
                            dofs: Array.isArray(bc.dofs) ? bc.dofs : [true, true, true, true, true, true],
                            velocity: Array.isArray(bc.velocity) ? bc.velocity.map(Number) : [0, 0, 0],
                            active: bc.active !== false
                        }));
                    }
                    if (setup.contacts && Array.isArray(setup.contacts)) {
                        objParams['fem_contacts'] = setup.contacts;
                    }
                }

                femObjects.push(objParams);
            };

            const objConns = state.connections.filter(c => c.toNode === femDomain.id && (c.toPort === 'objects' || c.toPort === 'mesh' || c.toPort === 'parts' || c.toPort === 'elements' || c.toPort === 'in'));
            for (const conn of objConns) {
                const objNode = state.nodes.find(n => n.id === conn.fromNode);
                processObjNode(objNode);
            }

            state.nodes.filter(n => n.type === 'FEMObject3D' || n.type === 'LSDynaImporter3D').forEach(processObjNode);
            flattenedParams['fem_objects'] = femObjects;

            // Promote global erosion criteria to top-level: prefer explicit object/material erosion parameters over domain defaults
            if (femObjects.length > 0 && femObjects[0]['erosion_strain'] !== undefined) {
                flattenedParams['erosion_strain'] = Number(femObjects[0]['erosion_strain']);
            } else if (femDomain.parameters?.['erosion_strain'] !== undefined) {
                flattenedParams['erosion_strain'] = Number(femDomain.parameters['erosion_strain']);
            }
            if (femObjects.length > 0 && femObjects[0]['failure_strain'] !== undefined) {
                flattenedParams['failure_strain'] = Number(femObjects[0]['failure_strain']);
            } else if (femDomain.parameters?.['failure_strain'] !== undefined) {
                flattenedParams['failure_strain'] = Number(femDomain.parameters['failure_strain']);
            }
            if (femObjects.length > 0 && femObjects[0]['tensile_failure_stress'] !== undefined) {
                flattenedParams['tensile_failure_stress'] = Number(femObjects[0]['tensile_failure_stress']);
            } else if (femDomain.parameters?.['tensile_failure_stress'] !== undefined) {
                flattenedParams['tensile_failure_stress'] = Number(femDomain.parameters['tensile_failure_stress']);
            }
            if (femObjects.length > 0 && femObjects[0]['enable_strain_erosion'] !== undefined) {
                flattenedParams['enable_strain_erosion'] = femObjects[0]['enable_strain_erosion'];
            } else if (femDomain.parameters?.['enable_strain_erosion'] !== undefined) {
                flattenedParams['enable_strain_erosion'] = femDomain.parameters['enable_strain_erosion'];
            }
            if (femDomain.parameters?.['timestep_erosion_factor'] !== undefined) {
                flattenedParams['timestep_erosion_factor'] = Number(femDomain.parameters['timestep_erosion_factor']);
            }
            if (femDomain.parameters?.['min_volume_ratio'] !== undefined) {
                flattenedParams['min_volume_ratio'] = Number(femDomain.parameters['min_volume_ratio']);
            }

            // Serialize standalone FEMBeam3D and FEMRebar3D nodes
            const standaloneBeams: any[] = [];
            const beamNodes = state.nodes.filter(n => n.type === 'FEMBeam3D' || n.type === 'FEMRebar3D');
            for (const bNode of beamNodes) {
                const bParams: any = { ...bNode.parameters, node_type: bNode.type };
                const matConn = state.connections.find(c => c.toNode === bNode.id && (c.toPort === 'material' || c.toPort === 'in'));
                if (matConn) {
                    const matNode = state.nodes.find(n => n.id === matConn.fromNode);
                    if (matNode && matNode.parameters) {
                        Object.entries(matNode.parameters).forEach(([mk, mv]) => {
                            bParams[mk] = numericKeys.includes(mk) ? Number(mv) : mv;
                        });
                    }
                }
                bParams['node1_x'] = Number(bParams['node1_x'] ?? 0.0);
                bParams['node1_y'] = Number(bParams['node1_y'] ?? 0.0);
                bParams['node1_z'] = Number(bParams['node1_z'] ?? 0.0);
                bParams['node2_x'] = Number(bParams['node2_x'] ?? 1.0);
                bParams['node2_y'] = Number(bParams['node2_y'] ?? 0.0);
                bParams['node2_z'] = Number(bParams['node2_z'] ?? 0.0);
                bParams['radius'] = Number(bParams['radius'] ?? (bNode.type === 'FEMRebar3D' ? 0.008 : 0.01));
                bParams['diameter'] = Number(bParams['diameter'] ?? (2.0 * bParams['radius']));
                bParams['failure_strain'] = Number(bParams['failure_strain'] ?? 0.20);
                standaloneBeams.push(bParams);
            }
            if (standaloneBeams.length > 0) {
                flattenedParams['fem_standalone_beams'] = standaloneBeams;
            }

            // Trace VTKOutput connected to FEMDomain3D
            const vtkConns = state.connections.filter(c => c.fromNode === femDomain.id || c.toNode === femDomain.id);
            for (const conn of vtkConns) {
                const otherId = conn.fromNode === femDomain.id ? conn.toNode : conn.fromNode;
                const vtkNode = state.nodes.find(n => n.id === otherId);
                if (vtkNode && vtkNode.type === 'VTKOutput') {
                    Object.entries(vtkNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                }
            }
        }
    } else if (command === "INIT_3D") {
        const cellSize = flattenedParams['cell_size'] || 0.01;
        const xmin = flattenedParams['xmin'] !== undefined ? flattenedParams['xmin'] : (flattenedParams['x_min'] !== undefined ? flattenedParams['x_min'] : 0.0);
        const xmax = flattenedParams['xmax'] !== undefined ? flattenedParams['xmax'] : (flattenedParams['x_max'] !== undefined ? flattenedParams['x_max'] : 1.0);
        const ymin = flattenedParams['ymin'] !== undefined ? flattenedParams['ymin'] : (flattenedParams['y_min'] !== undefined ? flattenedParams['y_min'] : 0.0);
        const ymax = flattenedParams['ymax'] !== undefined ? flattenedParams['ymax'] : (flattenedParams['y_max'] !== undefined ? flattenedParams['y_max'] : 1.0);
        const zmin = flattenedParams['zmin'] !== undefined ? flattenedParams['zmin'] : (flattenedParams['z_min'] !== undefined ? flattenedParams['z_min'] : 0.0);
        const zmax = flattenedParams['zmax'] !== undefined ? flattenedParams['zmax'] : (flattenedParams['z_max'] !== undefined ? flattenedParams['z_max'] : 1.0);
        const dimX = xmax - xmin;
        const dimY = ymax - ymin;
        const dimZ = zmax - zmin;

        flattenedParams['nx'] = Math.round(dimX / cellSize);
        flattenedParams['ny'] = Math.round(dimY / cellSize);
        flattenedParams['nz'] = Math.round(dimZ / cellSize);
        flattenedParams['xmin'] = xmin;
        flattenedParams['ymin'] = ymin;
        flattenedParams['zmin'] = zmin;

        const centerX = xmin + dimX * 0.5;
        const centerY = ymin + dimY * 0.5;
        const centerZ = zmin + dimZ * 0.5;
        if (flattenedParams['charge_x'] === undefined) flattenedParams['charge_x'] = centerX;
        if (flattenedParams['charge_y'] === undefined) flattenedParams['charge_y'] = centerY;
        if (flattenedParams['charge_z'] === undefined) flattenedParams['charge_z'] = centerZ;

        const mass3D = flattenedParams['charge_mass'] !== undefined ? Number(flattenedParams['charge_mass']) : 0.0;
        const rho3D = flattenedParams['rho'] || 1630.0;
        if (mass3D > 0) {
            if (flattenedParams['charge_shape'] === 'Cylinder') {
                const ar = flattenedParams['charge_aspect_ratio'] || (flattenedParams['charge_height'] && flattenedParams['charge_radius'] ? flattenedParams['charge_height'] / (2.0 * flattenedParams['charge_radius']) : 1.0);
                if (!flattenedParams['charge_radius'] || flattenedParams['charge_radius'] === 0.0) {
                    flattenedParams['charge_radius'] = Math.cbrt(mass3D / (2.0 * Math.PI * rho3D * ar));
                }
                flattenedParams['charge_height'] = 2.0 * flattenedParams['charge_radius'] * ar;
                flattenedParams['charge_aspect_ratio'] = ar;
            } else if (!flattenedParams['charge_radius'] || flattenedParams['charge_radius'] === 0.0) {
                flattenedParams['charge_radius'] = Math.pow((3.0 * mass3D) / (4.0 * Math.PI * rho3D), 1.0 / 3.0);
            }
        }

        if (!flattenedParams['gamma']) flattenedParams['gamma'] = 1.4;
        const p = flattenedParams['atm_pressure'] || 101325.0;
        const t = flattenedParams['atm_temperature'] || 288.0;
        flattenedParams['ambient_rho'] = p / (287.058 * t);

        if (!flattenedParams['device']) flattenedParams['device'] = 'cpu';

        // Check if there is an explosive Material node in the 3D model only if not already traced
        if (!flattenedParams['explosive_type'] && !flattenedParams['material_type']) {
            const localMatNode = state.nodes.find(n => n.type === 'Material' && (isJWLMaterialNode(n) || isIdealGasMaterialNode(n)));
            if (localMatNode && localMatNode.parameters) {
                if (isJWLMaterialNode(localMatNode)) {
                    flattenedParams['explosive_type'] = 'MaterialExplosive';
                    flattenedParams['material_type'] = 'JWL Charge';
                    extractJWLAndAfterburnParams(localMatNode, flattenedParams, numericKeys, booleanKeys);
                } else if (isIdealGasMaterialNode(localMatNode)) {
                    flattenedParams['explosive_type'] = 'MaterialIdealGas';
                    flattenedParams['material_type'] = 'Ideal Gas Charge';
                    flattenedParams['is_ideal_gas'] = true;
                    flattenedParams['gamma'] = Number(localMatNode.parameters.gamma ?? localMatNode.parameters.ideal_gamma ?? 1.4);
                    flattenedParams['rho'] = Number(localMatNode.parameters.density ?? localMatNode.parameters.ideal_rho_0 ?? 1630.0);
                    flattenedParams['detonation_energy'] = Number(localMatNode.parameters.detonation_energy ?? localMatNode.parameters.ideal_e_0 ?? 4290000);
                }
            }
        }

        const remapConn3D = solverNode3D ? state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'remap') : null;
        const remapNode3D = remapConn3D ? state.nodes.find(n => n.id === remapConn3D.fromNode) : state.nodes.find(n => n.type === 'Remap1DTo3DNode' || n.type === 'Remap2DTo3DNode');
        if (remapNode3D) {
            inheritRemap3DUpstream(state, remapNode3D, solverNode3D, modelId, flattenedParams, numericKeys, booleanKeys);
        } else if (solverNode3D?.type === 'MarineHarbourDomain') {
            flattenedParams['init_mode'] = 'Hydrostatic_Stratified_3D';
        } else if (!flattenedParams['init_mode'] || flattenedParams['init_mode'] === 'From1D' || flattenedParams['init_mode'] === 'From2D') {
            if (flattenedParams['explosive_type'] === 'MaterialIdealGas') {
                flattenedParams['init_mode'] = 'Ideal Gas';
            } else {
                flattenedParams['init_mode'] = 'Multi-Material JWL';
            }
        }
        if (!flattenedParams['flux_scheme']) flattenedParams['flux_scheme'] = 'AUSM+';
        if (flattenedParams['space_time_scheme']) {
            const sts = flattenedParams['space_time_scheme'];
            if (sts === 'ADER-2 (2nd-Order Space/Time)') {
                flattenedParams['spatial_order'] = 2;
                flattenedParams['temporal_order'] = 5;
            } else if (sts === 'ADER-3 (3rd-Order Space/Time)') {
                flattenedParams['spatial_order'] = 3;
                flattenedParams['temporal_order'] = 6;
            } else if (sts === 'MUSCL-Hancock (2nd-Order Space/Time)') {
                flattenedParams['spatial_order'] = 2;
                flattenedParams['temporal_order'] = 4;
            }
        }
        if (flattenedParams['spatial_order'] === undefined) flattenedParams['spatial_order'] = 2;
        if (flattenedParams['temporal_order'] === undefined) flattenedParams['temporal_order'] = 4;
        if (!flattenedParams['precision']) flattenedParams['precision'] = 'single';
    }

    // Fallback: If VTKOutput node is in the graph, ensure its parameters are included even without direct wire
    const anyVtkNode = state.nodes.find(n => n.type === 'VTKOutput');
    if (anyVtkNode && anyVtkNode.parameters) {
        flattenedParams['enable_vtk'] = 'Enabled';
        Object.entries(anyVtkNode.parameters).forEach(([key, value]) => {
            flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
        });
    }

    // Fallback: If VirtualGauges node is in the graph, ensure its parameters are included even without direct wire
    const anyGaugeNode = state.nodes.find(n => n.type === 'VirtualGauges' || (n.type as string) === 'VirtualGauges3D');
    if (anyGaugeNode && anyGaugeNode.parameters) {
        const sourceMode = anyGaugeNode.parameters.source_mode || 'manual';
        if (flattenedParams['gauge_source_mode'] === undefined) {
            flattenedParams['gauge_source_mode'] = sourceMode;
        }
        if (flattenedParams['external_gauge_file'] === undefined) {
            flattenedParams['external_gauge_file'] = resolveResourcePath(anyGaugeNode.parameters.external_file_path || '', modelFilename);
        }
        if (flattenedParams['external_gauge_format'] === undefined) {
            flattenedParams['external_gauge_format'] = anyGaugeNode.parameters.external_file_format || 'Auto';
        }
        if (flattenedParams['gauge_storage_backend'] === undefined) {
            flattenedParams['gauge_storage_backend'] = anyGaugeNode.parameters.storage_backend || 'HDF5 Stream';
        }
        if (flattenedParams['gauge_stride_steps'] === undefined) {
            flattenedParams['gauge_stride_steps'] = Number(anyGaugeNode.parameters.sampling_stride_steps || 1);
        }
        if (flattenedParams['pinned_gauge_ids'] === undefined) {
            flattenedParams['pinned_gauge_ids'] = anyGaugeNode.parameters.pinned_probe_ids || [];
        }
        if (sourceMode === 'manual' && (!flattenedParams['gauges'] || (Array.isArray(flattenedParams['gauges']) && flattenedParams['gauges'].length === 0))) {
            flattenedParams['gauges'] = anyGaugeNode.parameters.gauges || [];
        }
        ['export_ascii', 'export_binary', 'export_hdf5', 'ascii_delimiter', 'ascii_precision', 'include_header', 'custom_filename', 'output_dir'].forEach(k => {
            if (anyGaugeNode.parameters[k] !== undefined && flattenedParams[k] === undefined) {
                flattenedParams[k] = numericKeys.includes(k) ? Number(anyGaugeNode.parameters[k]) : anyGaugeNode.parameters[k];
            }
        });
    }

    return JSON.stringify({
        command: command,
        modelId: modelId,
        model_filename: modelFilename || null,
        ...flattenedParams,
        // Full DAG for Broker tracking
        nodes: strippedNodes,
        connections: state.connections
    });
}

export function serializeToBinary(state: SimulationState): ArrayBuffer {
    const jsonString = JSON.stringify(state);
    const encoder = new TextEncoder();
    const jsonBytes = encoder.encode(jsonString);
    
    const buffer = new ArrayBuffer(4 + 1 + 1 + 4 + jsonBytes.length + 4);
    const view = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);
    
    // Magic: 'BLST'
    view.setUint8(0, 0x42); // B
    view.setUint8(1, 0x4c); // L
    view.setUint8(2, 0x53); // S
    view.setUint8(3, 0x54); // T
    
    // Version: 1
    view.setUint8(4, 1);
    
    // Flags: 0
    view.setUint8(5, 0);
    
    // JSON Length (Big Endian)
    view.setUint32(6, jsonBytes.length, false);
    
    // JSON Bytes
    uint8.set(jsonBytes, 10);
    
    // Simple sum checksum
    let checksum = 0;
    for (let i = 0; i < jsonBytes.length; i++) {
        checksum = (checksum + jsonBytes[i]) & 0xFFFFFFFF;
    }
    view.setUint32(10 + jsonBytes.length, checksum, false);
    
    return buffer;
}

export function deserializeFromBinary(buffer: ArrayBuffer): SimulationState {
    const view = new DataView(buffer);
    if (buffer.byteLength < 14) {
        throw new Error("Invalid model: buffer too short");
    }
    
    // Verify Magic
    const m0 = view.getUint8(0);
    const m1 = view.getUint8(1);
    const m2 = view.getUint8(2);
    const m3 = view.getUint8(3);
    if (m0 !== 0x42 || m1 !== 0x4c || m2 !== 0x53 || m3 !== 0x54) {
        throw new Error("Invalid model: missing magic header");
    }
    
    const version = view.getUint8(4);
    if (version !== 1) {
        throw new Error(`Unsupported model version: ${version}`);
    }
    
    const jsonLength = view.getUint32(6, false);
    if (buffer.byteLength < 10 + jsonLength + 4) {
        throw new Error("Invalid model: payload truncated");
    }
    
    const uint8 = new Uint8Array(buffer);
    const jsonBytes = uint8.subarray(10, 10 + jsonLength);
    
    // Verify checksum
    let checksum = 0;
    for (let i = 0; i < jsonBytes.length; i++) {
        checksum = (checksum + jsonBytes[i]) & 0xFFFFFFFF;
    }
    const savedChecksum = view.getUint32(10 + jsonLength, false);
    if (checksum !== savedChecksum) {
        throw new Error("Invalid model: checksum mismatch");
    }
    
    const decoder = new TextDecoder();
    const jsonString = decoder.decode(jsonBytes);
    return JSON.parse(jsonString) as SimulationState;
}
