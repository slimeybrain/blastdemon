import { SimulationState, Model, Node, isDomainMesh3DNode, isDomainMesh2DNode } from './types.js';
import { resolveResourcePath, isSeabedMaterialNode, getLSDynaDeckMeta } from './state-manager.js';
import { syncModelFEMSetup } from './fem-setup-types.js';

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
    'atm_pressure', 'atm_temperature', 'initial_temperature', 'gamma', 'density', 'ambient_rho', 'ambient_p', 'ambient_o2_fraction'
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
        if (waterNode.parameters?.initial_temperature !== undefined) {
            flattenedParams['water_temperature'] = Number(waterNode.parameters.initial_temperature);
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
        if (sParams.initial_temperature !== undefined) {
            flattenedParams['soil_temperature'] = Number(sParams.initial_temperature);
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
        let waterMode = solverNode3D.parameters?.water_discretization_mode || 'Pure_FV';
        if (waterMode === 'Pure FV') waterMode = 'Pure_FV';
        flattenedParams['water_discretization_mode'] = waterMode;
        if (waterMode === 'LPTP_Phase_Tracking_Sleeve' || waterMode === 'Full_Column_LPTP_Cylinder') {
            flattenedParams['enable_phase_tracking'] = true;
        }
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
        const chgNode = state.nodes.find(n => n.type === 'Charge3D');
        if (chgNode && chgNode.parameters?.ppc !== undefined) {
            flattenedParams['charge_ppc'] = Number(chgNode.parameters.ppc);
        } else if (flattenedParams['charge_ppc'] === undefined) {
            flattenedParams['charge_ppc'] = 64;
        }
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
    const waterMode = solverNode3D?.parameters?.water_discretization_mode || 'Pure_FV';
    const isPureWater = (waterMode === 'Pure_FV' || waterMode === 'Pure FV' || waterMode === 'LPTP_Phase_Tracking_Sleeve' || waterMode === 'Full_Column_LPTP_Cylinder');
    const sleeveR = Number(solverNode3D?.parameters?.nearfield_sleeve_radius ?? 2.5);
    const isHarbourWithWater = (solverNode3D?.type === 'MarineHarbourDomain' && !isPureWater && sleeveR > 0);
    const bedType = solverNode3D?.parameters?.seabed_mesh_type || 'Hybrid_MPM_Crater_FEM_FarField';
    const isPureBed = (bedType === 'Pure_Hex8_FEM' || bedType === 'Pure Hex8 FEM' || bedType === 'Pure_FV' || bedType === 'Pure FV');
    const isHarbourWithSoil = (solverNode3D?.type === 'MarineHarbourDomain' && !isPureBed);
    if (!mpmDomain && mpmObjNodes.length === 0 && !isHarbourWithSoil && !isHarbourWithWater) {
        return [];
    }

    const domainPpc = Number(mpmDomain?.parameters?.ppc ?? solverNode3D?.parameters?.nearfield_ppc ?? 8);
    const domainParticleDist = mpmDomain?.parameters?.particle_distribution;
    const domainBoundaryFill = mpmDomain?.parameters?.boundary_filling;
    flattenedParams['ppc'] = domainPpc;
    flattenedParams['bardenhagen_grouping_policy'] = mpmDomain?.parameters?.bardenhagen_grouping_policy || 'Per-Object Independent';
    flattenedParams['bardenhagen_initial_tie'] = mpmDomain?.parameters?.bardenhagen_initial_tie ?? true;

    const mpmObjects: any[] = [];
    let targetMpmNodes: (Node | undefined)[] = [];
    if (mpmDomain) {
        const directObjs = state.connections
            .filter(c => c.toNode === mpmDomain.id && (c.toPort === 'objects' || c.toPort === 'mpm_objects' || c.toPort === 'in'))
            .map(c => state.nodes.find(n => n.id === c.fromNode))
            .filter(n => n && n.type === 'MPMObject3D');
        const domainCouplers = state.nodes.filter(n =>
            n.type === 'MPMContactCoupler3D' && (
                state.connections.some(c => c.fromNode === n.id && c.toNode === mpmDomain.id) ||
                n.parameters?.target_domain === mpmDomain.id
            )
        );
        const couplerIds = new Set(domainCouplers.map(c => c.id));
        const couplerObjs = state.connections
            .filter(c => couplerIds.has(c.toNode))
            .map(c => state.nodes.find(n => n.id === c.fromNode))
            .filter(n => n && n.type === 'MPMObject3D');
        const seenIds = new Set<string>();
        for (const o of [...directObjs, ...couplerObjs]) {
            if (o && !seenIds.has(o.id)) {
                seenIds.add(o.id);
                targetMpmNodes.push(o);
            }
        }
    } else {
        targetMpmNodes = mpmObjNodes;
    }
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
            const skipMatKeys = new Set([
                'visible', 'hidden', 'name', 'label', 'id',
                'pos_x', 'pos_y', 'pos_z', 'rot_x', 'rot_y', 'rot_z',
                'scale_x', 'scale_y', 'scale_z', 'size_x', 'size_y', 'size_z',
                'radius', 'inner_radius', 'height', 'shape', 'shape_type',
                'stl_file', 'origin_mode', 'ppc', 'voxelization_method'
            ]);
            Object.entries(matNode.parameters).forEach(([mk, mv]) => {
                if (!skipMatKeys.has(mk)) {
                    objParams[mk] = numericKeys.includes(mk) ? Number(mv) : mv;
                }
            });
        }
        if (matNode?.parameters?.['material_model']) {
            objParams['material_model'] = matNode.parameters['material_model'];
        } else if (!objParams['material_model']) {
            objParams['material_model'] = objNode.parameters?.['material_model'] || 'Hypoelastic';
        }
        const domainTransferScheme = mpmDomain?.parameters?.transfer_scheme || 'BSpline';
        const objTransferScheme = objNode.parameters?.transfer_scheme;
        const matTransferScheme = matNode?.parameters?.transfer_scheme;
        if (objTransferScheme && objTransferScheme !== 'Default') {
            objParams['transfer_scheme'] = objTransferScheme;
        } else if (matTransferScheme && matTransferScheme !== 'Default') {
            objParams['transfer_scheme'] = matTransferScheme;
        } else if (domainTransferScheme && domainTransferScheme !== 'Default') {
            objParams['transfer_scheme'] = domainTransferScheme;
        } else {
            objParams['transfer_scheme'] = 'BSpline';
        }
        if (!objParams['particle_distribution'] && domainParticleDist) {
            objParams['particle_distribution'] = domainParticleDist;
        }
        if (!objParams['boundary_filling'] && domainBoundaryFill) {
            objParams['boundary_filling'] = domainBoundaryFill;
        }
        if (objParams['vel_x'] === undefined && objParams['initial_velocity_x'] !== undefined) objParams['vel_x'] = objParams['initial_velocity_x'];
        if (objParams['vel_y'] === undefined && objParams['initial_velocity_y'] !== undefined) objParams['vel_y'] = objParams['initial_velocity_y'];
        if (objParams['vel_z'] === undefined && objParams['initial_velocity_z'] !== undefined) objParams['vel_z'] = objParams['initial_velocity_z'];
        objParams['ppc'] = Math.max(1, Math.round(Number(objNode.parameters?.ppc ?? domainPpc)));

        // Resolve effective velocity_group from connected MPMContactCoupler3D or node parameter
        const couplerConn = state.connections.find(c => c.fromNode === objNode.id && state.nodes.some(n => n.id === c.toNode && n.type === 'MPMContactCoupler3D'));
        const couplerNode = couplerConn ? state.nodes.find(n => n.id === couplerConn.toNode) : undefined;
        if (couplerNode) {
            const cMode = String(couplerNode.parameters?.coupler_mode || 'Bonded (Single-Velocity)');
            if (cMode.includes('Independent')) {
                objParams['velocity_group'] = 'Independent';
            } else {
                objParams['velocity_group'] = String(couplerNode.parameters?.coupler_group_tag || `Coupler_${couplerNode.id}`);
            }
        } else {
            objParams['velocity_group'] = String(objNode.parameters?.velocity_group || 'Independent (Auto)');
        }

        mpmObjects.push(objParams);
    }

    // Auto-synthesize Nearfield Water Sleeve, Charge, and Seabed Soil for Marine Harbour Domain
    if (solverNode3D?.type === 'MarineHarbourDomain') {
        const waterMode = solverNode3D.parameters?.water_discretization_mode || 'Pure_FV';
        const isPureFV = (waterMode === 'Pure_FV' || waterMode === 'Pure FV' || waterMode === 'LPTP_Phase_Tracking_Sleeve' || waterMode === 'Full_Column_LPTP_Cylinder');
        const sleeveR = Number(solverNode3D.parameters?.nearfield_sleeve_radius ?? 2.5);

        // Find connected Charge node and Detonator node
        const chargeConn = state.connections.find(c => (c.toNode === solverNode3D.id && (c.toPort === 'charge' || c.toPort === 'explosive')) || (c.fromNode === solverNode3D.id && (c.fromPort === 'charge' || c.fromPort === 'explosive')));
        let chgNode = chargeConn ? state.nodes.find(n => n.id === (chargeConn.toNode === solverNode3D.id ? chargeConn.fromNode : chargeConn.toNode)) : null;
        if (!chgNode && solverNode3D.parameters?.explosive_charge) {
            chgNode = state.nodes.find(n => n.id === solverNode3D.parameters.explosive_charge || (n as any).name === solverNode3D.parameters.explosive_charge);
        }
        if (!chgNode) {
            chgNode = state.nodes.find(n => n.type === 'Charge3D' || n.type === 'Charge2D');
        }

        const detConn = state.connections.find(c => (c.toNode === solverNode3D.id && (c.toPort === 'detonator' || c.toPort === 'trigger')) || (c.fromNode === solverNode3D.id && (c.fromPort === 'detonator' || c.fromPort === 'trigger')));
        let detNode = detConn ? state.nodes.find(n => n.id === (detConn.toNode === solverNode3D.id ? detConn.fromNode : detConn.toNode)) : null;
        if (!detNode && solverNode3D.parameters?.connected_detonators) {
            detNode = state.nodes.find(n => n.id === solverNode3D.parameters.connected_detonators || (n as any).name === solverNode3D.parameters.connected_detonators);
        }
        if (!detNode) {
            detNode = state.nodes.find(n => n.type === 'DetonatorLocation3D' || n.type === 'TriggerLocation3D');
        }

        let chgX = Number(flattenedParams['charge_x'] ?? chgNode?.parameters?.charge_x ?? chgNode?.parameters?.pos_x ?? chgNode?.parameters?.x ?? detNode?.parameters?.detonator_x ?? 0.0);
        let chgY = Number(flattenedParams['charge_y'] ?? chgNode?.parameters?.charge_y ?? chgNode?.parameters?.pos_y ?? chgNode?.parameters?.y ?? detNode?.parameters?.detonator_y ?? 0.0);
        let chgZ = Number(flattenedParams['charge_z'] ?? chgNode?.parameters?.charge_z ?? chgNode?.parameters?.pos_z ?? chgNode?.parameters?.z ?? 0.0);
        if (isNaN(chgZ) || chgZ === 0.0) {
            chgZ = Number(detNode?.parameters?.detonator_z ?? detNode?.parameters?.trigger_z ?? detNode?.parameters?.z ?? flattenedParams['detonator_z'] ?? 0.0);
        }
        const chgR = Number(flattenedParams['charge_radius'] ?? chgNode?.parameters?.radius ?? chgNode?.parameters?.charge_radius ?? 0.1);
        const waterZ = Number(solverNode3D.parameters?.water_surface_z ?? flattenedParams['water_surface_z'] ?? 10.0);
        const seabedZ = Number(solverNode3D.parameters?.seabed_surface_z ?? flattenedParams['seabed_surface_z'] ?? 2.0);

        if (!isPureFV && sleeveR > 0) {
            const hasWaterSleeve = mpmObjects.some(o => 
                (o.material_name && String(o.material_name).toLowerCase().includes('water')) ||
                (o.name && String(o.name).toLowerCase().includes('sleeve')) ||
                (o.material_model === 'TaitWater')
            );
            if (!hasWaterSleeve) {
                const domainCellSize = Number(solverNode3D.parameters?.cell_size ?? flattenedParams['cell_size'] ?? 0.05);
                const overlapTh = Math.max(2.0 * domainCellSize, 0.15 * sleeveR);
                const sleevePpc = Number(solverNode3D.parameters?.nearfield_ppc ?? 8);
                const isCylinder = (waterMode === 'Full_Column_MPM_Cylinder');
                const cylHeight = Math.max(0.1, waterZ - seabedZ);
                const cylPosZ = seabedZ + 0.5 * cylHeight;

                mpmObjects.push({
                    name: isCylinder ? 'Water Column MPM Cylinder' : 'Nearfield Water Sleeve',
                    shape_type: isCylinder ? 'Cylinder' : 'Sphere',
                    pos_x: chgX,
                    pos_y: chgY,
                    pos_z: isCylinder ? cylPosZ : chgZ,
                    radius: sleeveR + overlapTh,
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
                    enable_density_erosion: Boolean(flattenedParams['enable_density_erosion'] ?? false),
                    erosion_min_density: Number(flattenedParams['erosion_min_density'] ?? 0.0),
                    erosion_min_density_ratio: Number(flattenedParams['erosion_min_density_ratio'] ?? 0.05),
                    erode_to_fv_grid: Boolean(flattenedParams['erode_to_fv_grid'] ?? true),
                    E: 2.2e9,
                    nu: 0.499,
                    ppc: sleevePpc,
                    particle_distribution: 'Cartesian',
                    boundary_filling: 'Stairstepped'
                });

                const hasChargeMpm = mpmObjects.some(o =>
                    (o.material_model && (o.material_model.includes('JWL') || o.material_model.includes('Explosive'))) ||
                    (o.name && o.name.toLowerCase().includes('charge'))
                );
                if (!hasChargeMpm && chgR > 0) {
                    let chgMatNode: Node | undefined;
                    if (chgNode) {
                        const chgMatConn = state.connections.find(c => 
                            (c.toNode === chgNode.id && (c.toPort === 'material' || c.toPort === 'in')) ||
                            (c.fromNode === chgNode.id && (c.fromPort === 'material' || c.fromPort === 'out'))
                        );
                        if (chgMatConn) {
                            const matId = chgMatConn.toNode === chgNode.id ? chgMatConn.fromNode : chgMatConn.toNode;
                            chgMatNode = state.nodes.find(n => n.id === matId);
                        } else if (chgNode.parameters?.material) {
                            chgMatNode = state.nodes.find(n => n.id === chgNode.parameters.material || (n as any).name === chgNode.parameters.material);
                        }
                    }
                    const chgMatModel = chgMatNode?.parameters?.material_model ?? flattenedParams['material_model'] ?? 'JWL Programmed Burn';
                    const chgDensity = Number(chgMatNode?.parameters?.density ?? flattenedParams['rho'] ?? 1630.0);
                    const chgDetVel = Number(chgMatNode?.parameters?.det_vel ?? flattenedParams['det_vel'] ?? 6930.0);
                    const chgDetEnergy = Number(chgMatNode?.parameters?.detonation_energy ?? flattenedParams['detonation_energy'] ?? 4.29e6);
                    const chgJwlA = Number(chgMatNode?.parameters?.jwl_A ?? flattenedParams['jwl_A'] ?? 3.7377e11);
                    const chgJwlB = Number(chgMatNode?.parameters?.jwl_B ?? flattenedParams['jwl_B'] ?? 3.747e9);
                    const chgJwlR1 = Number(chgMatNode?.parameters?.jwl_R1 ?? flattenedParams['jwl_R1'] ?? 4.15);
                    const chgJwlR2 = Number(chgMatNode?.parameters?.jwl_R2 ?? flattenedParams['jwl_R2'] ?? 0.9);
                    const chgJwlOmega = Number(chgMatNode?.parameters?.jwl_omega ?? flattenedParams['jwl_omega'] ?? 0.35);

                    const chgPpc = Math.max(sleevePpc, Number(flattenedParams['charge_ppc'] ?? 64));
                    mpmObjects.push({
                        name: 'Nearfield Explosive Charge',
                        shape_type: 'Sphere',
                        pos_x: chgX,
                        pos_y: chgY,
                        pos_z: chgZ,
                        radius: chgR,
                        inner_radius: 0.0,
                        material_id: chgMatNode ? chgMatNode.id : 'mat_explosive_charge',
                        material_name: chgMatNode?.parameters?.name ?? 'Explosive Charge',
                        material_model: chgMatModel,
                        preset: chgMatNode?.parameters?.preset,
                        density: chgDensity,
                        det_vel: chgDetVel,
                        detonation_energy: chgDetEnergy,
                        jwl_A: chgJwlA,
                        jwl_B: chgJwlB,
                        jwl_R1: chgJwlR1,
                        jwl_R2: chgJwlR2,
                        jwl_omega: chgJwlOmega,
                        enable_density_erosion: Boolean(chgMatNode?.parameters?.enable_density_erosion ?? flattenedParams['enable_density_erosion'] ?? false),
                        erosion_min_density: Number(chgMatNode?.parameters?.erosion_min_density ?? flattenedParams['erosion_min_density'] ?? 0.0),
                        erosion_min_density_ratio: Number(chgMatNode?.parameters?.erosion_min_density_ratio ?? flattenedParams['erosion_min_density_ratio'] ?? 0.05),
                        erode_to_fv_grid: Boolean(chgMatNode?.parameters?.erode_to_fv_grid ?? flattenedParams['erode_to_fv_grid'] ?? true),
                        ppc: chgPpc,
                        particle_distribution: 'Cartesian',
                        boundary_filling: 'Stairstepped'
                    });
                }
            }
        }

        const bedType = solverNode3D.parameters?.seabed_mesh_type || 'Hybrid_MPM_Crater_FEM_FarField';
        const isPureBed = (bedType === 'Pure_Hex8_FEM' || bedType === 'Pure Hex8 FEM' || bedType === 'Pure_FV' || bedType === 'Pure FV');
        if (!isPureBed) {
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

export interface InheritedRemapSummary {
    hasRemap: boolean;
    remapNode: Node | null;
    remapTypeLabel: string;
    initMode: 'From1D' | 'From2D' | 'From3D' | null;
    sourceModelId: string | null;
    sourceModelName: string | null;
    chargeSourceModelId: string | null;
    chargeSourceModelName: string | null;
    chargeNode: Node | null;
    chargeMaterialNode: Node | null;
    chargeParams: {
        charge_mass: number;
        charge_radius: number;
        explosive_type: string;
        material_type: string;
        is_ideal_gas: boolean;
        composition: string;
        preset?: string;
        rho: number;
        detonation_energy: number;
        det_vel: number;
        jwl_A: number;
        jwl_B: number;
        jwl_R1: number;
        jwl_R2: number;
        jwl_omega: number;
        gamma: number;
        afterburn_enabled: boolean;
        afterburn_energy: number;
        afterburn_fuel_fraction: number;
        afterburn_stoich_ratio: number;
        afterburn_ignition_temp: number;
        afterburn_tau_chem: number;
        afterburn_c_edc: number;
        afterburn_tau_expansion: number;
        afterburn_ambient_o2_fraction: number;
    };
    airSourceModelId: string | null;
    airSourceModelName: string | null;
    airIsLocalOverride: boolean;
    airNode: Node | null;
    airParams: {
        preset: string;
        gamma: number;
        atm_pressure: number;
        atm_temperature: number;
        ambient_rho: number;
        ambient_p: number;
    };
    sourceExplosiveOrigin: { x: number; y: number; z: number };
}

function findUpstreamModelForRemap(
    remapNode: Node,
    owningModelId: string | undefined,
    allModels: (SimulationState | Model)[]
): (SimulationState | Model) | undefined {
    const allNodes: any[] = allModels.flatMap(m => m.nodes || []);
    const allConns: any[] = allModels.flatMap(m => m.connections || []);

    if (remapNode.parameters?.source_model_id) {
        const m = allModels.find(mod => ((mod as any).id || (mod as any).modelId) === remapNode.parameters.source_model_id);
        if (m) return m;
    }

    const remapInConn = allConns.find(c => c.toNode === remapNode.id);
    if (remapInConn) {
        const srcSolver = allNodes.find(n => n.id === remapInConn.fromNode);
        if (srcSolver) {
            const m = allModels.find(mod => (mod.nodes || []).some(n => n.id === srcSolver.id));
            if (m) return m;
        }
    }

    const globalSM = (typeof window !== 'undefined' && (window as any).stateManager) ? (window as any).stateManager : null;
    if (globalSM && globalSM.getAllPipes) {
        const pipes = globalSM.getAllPipes();
        const pipe = pipes.find((p: any) => p.targetModelId === owningModelId || p.toNodeId === remapNode.id);
        if (pipe) {
            const srcId = pipe.sourceModelId || pipe.model2dId || pipe.model1dId;
            if (srcId) {
                const m = allModels.find(mod => ((mod as any).id || (mod as any).modelId) === srcId);
                if (m) return m;
            }
        }
    }

    return undefined;
}

export function resolveRemapInheritance(
    state: SimulationState | Model,
    modelId?: string,
    allModelsOverride?: (SimulationState | Model)[]
): InheritedRemapSummary {
    const globalSM = (typeof window !== 'undefined' && (window as any).stateManager) ? (window as any).stateManager : null;
    const allModels: (SimulationState | Model)[] = allModelsOverride || (globalSM ? globalSM.getAllModels() : [state]);
    const effectiveModelId = modelId || (state as any).id || (state as any).modelId;

    const targetSolver = state.nodes.find(n => n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' || n.type === 'CFDSolver2D');
    const remapConn = targetSolver
        ? state.connections.find(c => c.toNode === targetSolver.id && (c.toPort === 'remap' || c.toPort === 'in'))
        : undefined;
    const remapNode = (remapConn ? state.nodes.find(n => n.id === remapConn.fromNode) : null)
        || state.nodes.find(n => n.type === 'Remap1DTo3DNode' || n.type === 'Remap2DTo3DNode' || n.type === 'Remap3DTo3DNode' || n.type === 'Remap1DTo2DNode' || n.type === 'RemapNode')
        || null;

    const emptySummary: InheritedRemapSummary = {
        hasRemap: false,
        remapNode: null,
        remapTypeLabel: '',
        initMode: null,
        sourceModelId: null,
        sourceModelName: null,
        chargeSourceModelId: null,
        chargeSourceModelName: null,
        chargeNode: null,
        chargeMaterialNode: null,
        chargeParams: {
            charge_mass: 0.85,
            charge_radius: 0.05,
            explosive_type: 'MaterialExplosive',
            material_type: 'JWL Charge',
            is_ideal_gas: false,
            composition: 'TNT',
            rho: 1630.0,
            detonation_energy: 4290000,
            det_vel: 6930,
            jwl_A: 373.77e9,
            jwl_B: 3.747e9,
            jwl_R1: 4.15,
            jwl_R2: 0.90,
            jwl_omega: 0.35,
            gamma: 1.4,
            afterburn_enabled: false,
            afterburn_energy: 1.5e7,
            afterburn_fuel_fraction: 0.25,
            afterburn_stoich_ratio: 3.0,
            afterburn_ignition_temp: 700.0,
            afterburn_tau_chem: 1.0e-5,
            afterburn_c_edc: 0.15,
            afterburn_tau_expansion: 0.0,
            afterburn_ambient_o2_fraction: 0.233,
        },
        airSourceModelId: null,
        airSourceModelName: null,
        airIsLocalOverride: false,
        airNode: null,
        airParams: {
            preset: 'Air',
            gamma: 1.4,
            atm_pressure: 101325.0,
            atm_temperature: 288.15,
            ambient_rho: 101325.0 / (287.058 * 288.15),
            ambient_p: 101325.0,
        },
        sourceExplosiveOrigin: { x: 0.5, y: 0.5, z: 0.0 },
    };

    if (!remapNode) return emptySummary;

    const remapTypeLabel = remapNode.type === 'Remap3DTo3DNode' ? '3D ➔ 3D'
        : (remapNode.type === 'Remap2DTo3DNode' ? '2D ➔ 3D'
            : (remapNode.type === 'Remap1DTo3DNode' ? '1D ➔ 3D' : '1D ➔ 2D'));
    const initMode: 'From1D' | 'From2D' | 'From3D' = remapNode.type === 'Remap3DTo3DNode' ? 'From3D'
        : (remapNode.type === 'Remap2DTo3DNode' ? 'From2D' : 'From1D');

    // Walk upstream chain recursively (nearest upstream -> root)
    const chain: (SimulationState | Model)[] = [];
    const visited = new Set<string>();
    if (effectiveModelId) visited.add(effectiveModelId);

    let currRemap: Node | null = remapNode;
    let currOwnerId: string | undefined = effectiveModelId;
    while (currRemap) {
        const upModel = findUpstreamModelForRemap(currRemap, currOwnerId, allModels);
        if (!upModel) break;
        const upId = (upModel as any).id || (upModel as any).modelId || '';
        if (upId && visited.has(upId)) break;
        if (upId) visited.add(upId);
        chain.push(upModel);
        currOwnerId = upId;
        currRemap = upModel.nodes.find(n =>
            n.type === 'Remap1DTo2DNode' || n.type === 'RemapNode' ||
            n.type === 'Remap1DTo3DNode' || n.type === 'Remap2DTo3DNode' || n.type === 'Remap3DTo3DNode'
        ) || null;
    }

    const immediateSource = chain[0];
    emptySummary.hasRemap = true;
    emptySummary.remapNode = remapNode;
    emptySummary.remapTypeLabel = remapTypeLabel;
    emptySummary.initMode = initMode;
    emptySummary.sourceModelId = immediateSource ? ((immediateSource as any).id || (immediateSource as any).modelId || null) : (remapNode.parameters?.source_model_id || null);
    emptySummary.sourceModelName = immediateSource ? ((immediateSource as any).name || emptySummary.sourceModelId) : emptySummary.sourceModelId;

    // 1. Resolve authoritative Charge & Material/EOS from the nearest upstream stage that defines them
    for (const m of chain) {
        const mId = (m as any).id || (m as any).modelId || null;
        const mName = (m as any).name || mId;
        const mSolver = m.nodes.find(n => n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver');
        const chgConn = mSolver ? m.connections?.find(c => c.toNode === mSolver.id && (c.toPort === 'charge' || c.toPort === 'explosive')) : undefined;
        const chgNode = (chgConn ? m.nodes.find(n => n.id === chgConn.fromNode) : null)
            || m.nodes.find(n => n.type === 'Charge1D' || n.type === 'Charge2D' || n.type === 'Charge3D')
            || null;

        let matNode: Node | null = null;
        if (chgNode) {
            const matConn = m.connections?.find(c =>
                (c.toNode === chgNode.id && c.toPort === 'material') ||
                (c.fromNode === chgNode.id && c.fromPort === 'material')
            );
            matNode = matConn
                ? m.nodes.find(n => n.id === (matConn.toNode === chgNode.id ? matConn.fromNode : matConn.toNode)) || null
                : null;
            if (!matNode && chgNode.parameters?.material) {
                matNode = m.nodes.find(n => n.id === chgNode.parameters.material) || null;
            }
        }
        if (!matNode) {
            matNode = m.nodes.find(n => n.type === 'Material' && (isJWLMaterialNode(n) || isIdealGasMaterialNode(n)))
                || m.nodes.find(n => n.type === 'Material' && !isAirMaterialNode(n))
                || null;
        }

        if (chgNode || matNode) {
            emptySummary.chargeSourceModelId = mId;
            emptySummary.chargeSourceModelName = mName;
            emptySummary.chargeNode = chgNode;
            emptySummary.chargeMaterialNode = matNode;

            const isIdeal = !!(
                (matNode && isIdealGasMaterialNode(matNode)) ||
                matNode?.parameters?.material_type === 'Ideal Gas Charge' ||
                matNode?.parameters?.material_model === 'Ideal Gas' ||
                mSolver?.parameters?.init_mode === 'Ideal Gas' ||
                mSolver?.parameters?.explosive_type === 'MaterialIdealGas'
            );
            const rho = Number(matNode?.parameters?.rho ?? matNode?.parameters?.density ?? matNode?.parameters?.ideal_rho_0 ?? 1630.0);
            let charge_radius = Number(chgNode?.parameters?.charge_radius ?? chgNode?.parameters?.explosive_radius ?? chgNode?.parameters?.radius ?? 0.0);
            const charge_mass = Number(chgNode?.parameters?.charge_mass ?? 0.85);
            if ((!charge_radius || charge_radius <= 0) && charge_mass > 0 && rho > 0) {
                charge_radius = Math.cbrt((3.0 * charge_mass) / (4.0 * Math.PI * rho));
            }
            if (!charge_radius || charge_radius <= 0) charge_radius = 0.05;

            const abEnabled = matNode?.parameters?.afterburn_enabled === true || matNode?.parameters?.afterburn_enabled === 'true' || matNode?.parameters?.afterburn_enabled === 'True';
            emptySummary.chargeParams = {
                charge_mass,
                charge_radius,
                explosive_type: isIdeal ? 'MaterialIdealGas' : 'MaterialExplosive',
                material_type: isIdeal ? 'Ideal Gas Charge' : (matNode?.parameters?.material_type ?? 'JWL Charge'),
                is_ideal_gas: isIdeal,
                composition: String(matNode?.parameters?.composition ?? 'TNT'),
                preset: matNode?.parameters?.preset ?? matNode?.parameters?.composition,
                rho,
                detonation_energy: Number(matNode?.parameters?.detonation_energy ?? matNode?.parameters?.ideal_e_0 ?? 4290000),
                det_vel: Number(matNode?.parameters?.det_vel ?? 6930),
                jwl_A: Number(matNode?.parameters?.jwl_A ?? 373.77e9),
                jwl_B: Number(matNode?.parameters?.jwl_B ?? 3.747e9),
                jwl_R1: Number(matNode?.parameters?.jwl_R1 ?? 4.15),
                jwl_R2: Number(matNode?.parameters?.jwl_R2 ?? 0.90),
                jwl_omega: Number(matNode?.parameters?.jwl_omega ?? 0.35),
                gamma: Number(matNode?.parameters?.gamma ?? matNode?.parameters?.ideal_gamma ?? 1.4),
                afterburn_enabled: abEnabled,
                afterburn_energy: Number(matNode?.parameters?.afterburn_energy ?? 1.5e7),
                afterburn_fuel_fraction: Number(matNode?.parameters?.afterburn_fuel_fraction ?? 0.25),
                afterburn_stoich_ratio: Number(matNode?.parameters?.afterburn_stoich_ratio ?? 3.0),
                afterburn_ignition_temp: Number(matNode?.parameters?.afterburn_ignition_temp ?? 700.0),
                afterburn_tau_chem: Number(matNode?.parameters?.afterburn_tau_chem ?? 1.0e-5),
                afterburn_c_edc: Number(matNode?.parameters?.afterburn_c_edc ?? 0.15),
                afterburn_tau_expansion: Number(matNode?.parameters?.afterburn_tau_expansion ?? 0.0),
                afterburn_ambient_o2_fraction: Number(matNode?.parameters?.afterburn_ambient_o2_fraction ?? 0.233),
            };
            break;
        }
    }

    // 2. Resolve Ambient Air: local wired Air node overrides upstream; otherwise inherit from nearest upstream Air node
    const localAirConn = targetSolver
        ? state.connections.find(c => c.toNode === targetSolver.id && c.toPort === 'air')
        : undefined;
    const localAirNode = localAirConn ? state.nodes.find(n => n.id === localAirConn.fromNode) : null;

    if (localAirNode && localAirNode.parameters) {
        const atm_p = Number(localAirNode.parameters.atm_pressure ?? 101325.0);
        const atm_t = Number(localAirNode.parameters.atm_temperature ?? 288.15);
        const gamma = Number(localAirNode.parameters.gamma ?? 1.4);
        const ambient_rho = Number(localAirNode.parameters.density ?? localAirNode.parameters.ambient_rho ?? (atm_p / (287.058 * atm_t)));
        emptySummary.airIsLocalOverride = true;
        emptySummary.airNode = localAirNode;
        emptySummary.airSourceModelId = effectiveModelId || null;
        emptySummary.airSourceModelName = (state as any).name || effectiveModelId || 'Current Model';
        emptySummary.airParams = {
            preset: String(localAirNode.parameters.preset || localAirNode.parameters.material_model || 'Air'),
            gamma,
            atm_pressure: atm_p,
            atm_temperature: atm_t,
            ambient_rho,
            ambient_p: atm_p,
        };
    } else {
        for (const m of chain) {
            const mId = (m as any).id || (m as any).modelId || null;
            const mName = (m as any).name || mId;
            const mSolver = m.nodes.find(n => n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver');
            const airConn = mSolver ? m.connections?.find(c => c.toNode === mSolver.id && c.toPort === 'air') : undefined;
            const airNode = (airConn ? m.nodes.find(n => n.id === airConn.fromNode) : null)
                || m.nodes.find(n => n.type === 'Material' && isAirMaterialNode(n))
                || null;
            if (airNode && airNode.parameters) {
                const atm_p = Number(airNode.parameters.atm_pressure ?? mSolver?.parameters?.atm_pressure ?? 101325.0);
                const atm_t = Number(airNode.parameters.atm_temperature ?? mSolver?.parameters?.atm_temperature ?? 288.15);
                const gamma = Number(airNode.parameters.gamma ?? mSolver?.parameters?.gamma ?? 1.4);
                const ambient_rho = Number(airNode.parameters.density ?? airNode.parameters.ambient_rho ?? (atm_p / (287.058 * atm_t)));
                emptySummary.airIsLocalOverride = false;
                emptySummary.airNode = airNode;
                emptySummary.airSourceModelId = mId;
                emptySummary.airSourceModelName = mName;
                emptySummary.airParams = {
                    preset: String(airNode.parameters.preset || airNode.parameters.material_model || 'Air'),
                    gamma,
                    atm_pressure: atm_p,
                    atm_temperature: atm_t,
                    ambient_rho,
                    ambient_p: atm_p,
                };
                break;
            }
        }
    }

    // 3. Resolve immediate source explosive origin (for 2D->3D and 3D->3D alignment)
    if (immediateSource) {
        const sSolver = immediateSource.nodes.find(n => n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' || n.type === 'CFDSolver2D');
        const sDetConn = sSolver ? immediateSource.connections?.find(c => c.toNode === sSolver.id && (c.toPort === 'detonator' || c.toPort === 'detonator_location')) : undefined;
        const sDetNode = sDetConn ? immediateSource.nodes.find(n => n.id === sDetConn.fromNode) : null;
        const sChgConn = sSolver ? immediateSource.connections?.find(c => c.toNode === sSolver.id && (c.toPort === 'charge' || c.toPort === 'explosive')) : undefined;
        const sChgNode = sChgConn ? immediateSource.nodes.find(n => n.id === sChgConn.fromNode) : null;
        const sRemapNode = immediateSource.nodes.find(n =>
            n.type === 'Remap1DTo2DNode' || n.type === 'RemapNode' ||
            n.type === 'Remap1DTo3DNode' || n.type === 'Remap2DTo3DNode' || n.type === 'Remap3DTo3DNode'
        );
        if (sDetNode?.parameters) {
            emptySummary.sourceExplosiveOrigin = {
                x: Number(sDetNode.parameters.detonator_x ?? sDetNode.parameters.x ?? 0.5),
                y: Number(sDetNode.parameters.detonator_y ?? sDetNode.parameters.y ?? 0.5),
                z: Number(sDetNode.parameters.detonator_z ?? sDetNode.parameters.z ?? 0.0),
            };
        } else if (sChgNode?.parameters) {
            emptySummary.sourceExplosiveOrigin = {
                x: Number(sChgNode.parameters.charge_x ?? sChgNode.parameters.x ?? 0.5),
                y: Number(sChgNode.parameters.charge_y ?? sChgNode.parameters.y ?? 0.5),
                z: Number(sChgNode.parameters.charge_z ?? sChgNode.parameters.z ?? 0.0),
            };
        } else if (sRemapNode?.parameters) {
            emptySummary.sourceExplosiveOrigin = {
                x: Number(sRemapNode.parameters.explosive_x ?? sRemapNode.parameters.center_x ?? 0.5),
                y: Number(sRemapNode.parameters.explosive_y ?? sRemapNode.parameters.center_y ?? 0.5),
                z: Number(sRemapNode.parameters.explosive_z ?? sRemapNode.parameters.z_offset ?? 0.0),
            };
        }
    }

    return emptySummary;
}

function applyInheritedSummaryToParams(
    summary: InheritedRemapSummary,
    flattenedParams: Record<string, any>
): void {
    if (!summary.hasRemap) return;
    if (summary.sourceModelId && !flattenedParams['source_model_id']) {
        flattenedParams['source_model_id'] = summary.sourceModelId;
    }

    const cp = summary.chargeParams;
    if (flattenedParams['charge_mass'] === undefined) flattenedParams['charge_mass'] = cp.charge_mass;
    if (flattenedParams['charge_radius'] === undefined) flattenedParams['charge_radius'] = cp.charge_radius;
    if (flattenedParams['explosive_radius'] === undefined) flattenedParams['explosive_radius'] = cp.charge_radius;
    flattenedParams['explosive_type'] = cp.explosive_type;
    flattenedParams['material_type'] = cp.material_type;
    flattenedParams['is_ideal_gas'] = cp.is_ideal_gas;
    flattenedParams['composition'] = cp.composition;
    if (cp.preset !== undefined) flattenedParams['preset'] = cp.preset;
    flattenedParams['rho'] = cp.rho;
    flattenedParams['high_rho'] = cp.rho;
    flattenedParams['detonation_energy'] = cp.detonation_energy;
    flattenedParams['det_vel'] = cp.det_vel;
    flattenedParams['jwl_A'] = cp.jwl_A;
    flattenedParams['jwl_B'] = cp.jwl_B;
    flattenedParams['jwl_R1'] = cp.jwl_R1;
    flattenedParams['jwl_R2'] = cp.jwl_R2;
    flattenedParams['jwl_omega'] = cp.jwl_omega;
    flattenedParams['afterburn_enabled'] = cp.afterburn_enabled;
    flattenedParams['afterburn_energy'] = cp.afterburn_energy;
    flattenedParams['afterburn_fuel_fraction'] = cp.afterburn_fuel_fraction;
    flattenedParams['afterburn_stoich_ratio'] = cp.afterburn_stoich_ratio;
    flattenedParams['afterburn_ignition_temp'] = cp.afterburn_ignition_temp;
    flattenedParams['afterburn_tau_chem'] = cp.afterburn_tau_chem;
    flattenedParams['afterburn_c_edc'] = cp.afterburn_c_edc;
    flattenedParams['afterburn_tau_expansion'] = cp.afterburn_tau_expansion;
    flattenedParams['afterburn_ambient_o2_fraction'] = cp.afterburn_ambient_o2_fraction;

    const ap = summary.airParams;
    if (!summary.airIsLocalOverride) {
        flattenedParams['gamma'] = cp.is_ideal_gas ? cp.gamma : ap.gamma;
        flattenedParams['atm_pressure'] = ap.atm_pressure;
        flattenedParams['atm_temperature'] = ap.atm_temperature;
        flattenedParams['ambient_rho'] = ap.ambient_rho;
        flattenedParams['ambient_p'] = ap.ambient_p;
    } else if (cp.is_ideal_gas) {
        flattenedParams['gamma'] = cp.gamma;
    }

    if (summary.initMode) {
        flattenedParams['init_mode'] = summary.initMode;
    }
}

export function inheritFrom1DUpstream(
    state: SimulationState,
    remapNode2D: Node,
    modelId: string | undefined,
    flattenedParams: Record<string, any>,
    _numericKeys: string[],
    _booleanKeys: string[]
): void {
    if (remapNode2D.parameters) {
        const er = remapNode2D.parameters.explosive_r;
        const ez = remapNode2D.parameters.explosive_z ?? remapNode2D.parameters.z_offset;
        const rr = remapNode2D.parameters.remap_radius;
        if (er !== undefined) flattenedParams['explosive_r'] = Number(er);
        if (ez !== undefined) flattenedParams['explosive_z'] = Number(ez);
        if (rr !== undefined) flattenedParams['remap_radius'] = Number(rr);
        if (remapNode2D.parameters.source_model_id) {
            flattenedParams['source_model_id'] = String(remapNode2D.parameters.source_model_id);
        }
    }
    const summary = resolveRemapInheritance(state, modelId);
    applyInheritedSummaryToParams(summary, flattenedParams);
}

export function inheritRemap3DUpstream(
    state: SimulationState,
    remapNode3D: Node,
    _solverNode3D: Node | undefined,
    modelId: string | undefined,
    flattenedParams: Record<string, any>,
    _numericKeys: string[],
    _booleanKeys: string[]
): void {
    if (remapNode3D.parameters) {
        const ex = remapNode3D.parameters.explosive_x ?? remapNode3D.parameters.center_x;
        const ey = remapNode3D.parameters.explosive_y ?? remapNode3D.parameters.center_y;
        const ez = remapNode3D.parameters.explosive_z ?? remapNode3D.parameters.center_z ?? remapNode3D.parameters.z_offset;
        const rr = remapNode3D.parameters.remap_radius;
        if (ex !== undefined) flattenedParams['explosive_x'] = Number(ex);
        if (ey !== undefined) flattenedParams['explosive_y'] = Number(ey);
        if (ez !== undefined) flattenedParams['explosive_z'] = Number(ez);
        if (rr !== undefined) flattenedParams['remap_radius'] = Number(rr);
        if (remapNode3D.parameters.source_model_id) {
            flattenedParams['source_model_id'] = String(remapNode3D.parameters.source_model_id);
        }
    }
    const summary = resolveRemapInheritance(state, modelId);
    applyInheritedSummaryToParams(summary, flattenedParams);
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
        'domain_radius', 'cell_size', 'atm_pressure', 'atm_temperature', 'initial_temperature',
        'water_temperature', 'soil_temperature', 'air_temperature',
        'charge_mass', 'rho', 'detonation_energy', 'jwl_A', 'jwl_B',
        'jwl_R1', 'jwl_R2', 'jwl_omega', 'det_vel', 'cfl', 'endtime',
        'spatial_order', 'temporal_order', 'gamma', 'plot_stride', 'refresh_rate', 'fps',
        'ascii_precision', 'step_interval', 'time_interval', 'downsample_stride', 'tessellation_max_edge',
        'telemetry_channel', 'telemetry_interval_ms', 'vtk_step_interval',
        // 2D CFD keys
        'nr', 'nz', 'min_r', 'min_z', 'max_r', 'max_z', 'explosive_x', 'explosive_y', 'explosive_z', 'explosive_radius', 'remap_radius', 'explosive_r',
        'charge_r', 'charge_z', 'charge_radius', 'charge_height', 'charge_aspect_ratio',
        'detonator_r', 'detonator_z', 'detonator_radius', 'detonator_x', 'detonator_y', 'time_delay', 'detonator_time',
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
        'clip_z_min', 'clip_z_max',
        'stl_scale_x', 'stl_scale_y', 'stl_scale_z', 'stl_pos_x', 'stl_pos_y', 'stl_pos_z', 'stl_rot_x', 'stl_rot_y', 'stl_rot_z',
        'angular_vel', 'angular_vel_x', 'angular_vel_y', 'angular_vel_z',
        'density', 'youngs_modulus', 'poissons_ratio', 'yield_stress', 'hardening_modulus',
        'failure_strain', 'tensile_failure_stress', 'erosion_strain', 'erosion_stress', 'erosion_min_density', 'erosion_min_density_ratio',
        'mpm_cell_size', 'mpm_xmin', 'mpm_xmax', 'mpm_ymin', 'mpm_ymax', 'mpm_zmin', 'mpm_zmax',
        'jc_A', 'jc_B', 'jc_n', 'jc_C', 'jc_m', 'jc_d1', 'jc_d2', 'jc_d3', 'jc_d4', 'jc_d5', 'T_melt', 'T_room', 'Cp',
        'weibull_modulus', 'weibull_scale', 'weibull_ref_volume',
        'anisotropy_ratio', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z',
        'mg_gamma0', 'mg_c0', 'mg_s',
        'ppc', 'phase_particle_ppc', 'charge_ppc',
        'mpmParticleDiameter', 'mpmParticleSize', 'mpmParticleMinVal', 'mpmParticleMaxVal', 'mpmParticleOpacity', 'flip_blend',
        'phaseParticleDiameter', 'phaseParticleSize', 'phaseParticleOpacity', 'phaseParticleStride',
        'dem_friction', 'dem_restitution', 'dem_contact_scale', 'dem_velocity_threshold',
        'sdf_barrier_restitution', 'sdf_barrier_friction', 'sdf_barrier_skin',
        // FEM keys
        'hourglass_coeff', 'bulk_viscosity_b1', 'bulk_viscosity_b2', 'timestep_erosion_factor', 'min_volume_ratio', 'contact_stiffness', 'contact_penalty_scale', 'friction_static', 'friction_kinetic', 'contact_damping', 'cohesive_fracture_energy', 'node_merge_tolerance',
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
        'crest_b1', 'crest_c1', 'crest_m1', 'crest_b2', 'crest_c2', 'crest_c3', 'crest_m2', 'crest_s0', 'crest_s_threshold', 'crest_awe_K0s', 'crest_awe_A1', 'crest_awe_A2', 'crest_awe_A3', 'crest_awe_B1', 'crest_awe_B2', 'crest_awe_B3', 'crest_awe_fc', 'crest_awe_delta', 'crest_awe_Gamma1', 'crest_awe_Gamma2', 'crest_awe_gamma00', 'crest_awe_m', 'crest_awe_c0', 'crest_awe_c1', 'crest_awe_c2', 'crest_awe_c3', 'crest_awe_c6', 'crest_awe_c8', 'crest_awe_c9', 'crest_awe_c10', 'crest_awe_c11', 'crest_awe_c12', 'crest_awe_c13',
        'initiation_radius', 'booster_overpressure',
        // JWL Programmed Burn & Lee-Tarver Ignition & Growth
        'burn_zone_cells', 'tau_burn_min',
        'lt_I', 'lt_a', 'lt_b', 'lt_x',
        'lt_G1', 'lt_c', 'lt_d', 'lt_y',
        'lt_G2', 'lt_e', 'lt_g', 'lt_z',
        'lt_F_ig_max', 'lt_F_G1_max', 'lt_F_G2_min', 'jwlr_A', 'jwlr_B', 'jwlr_R1', 'jwlr_R2', 'jwlr_omega', 'jwlr_Cv', 'jwlr_T0',
        // Afterburn & Aerobic Combustion
        'afterburn_energy', 'afterburn_fuel_fraction', 'afterburn_stoich_ratio',
        'afterburn_ignition_temp', 'afterburn_tau_chem', 'afterburn_c_edc', 'afterburn_tau_expansion',
        'afterburn_ambient_o2_fraction', 'ambient_o2_fraction',
        // VTK ROI & Strides
        'roi_xmin', 'roi_xmax', 'roi_ymin', 'roi_ymax', 'roi_zmin', 'roi_zmax', 'volume_stride', 'slice_stride', 'compression_level',
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
        'enabled', 'afterburn_enabled', 'smooth_plastic_strain', 'enable_sdf_barrier', 'enable_dem_contact', 'bardenhagen_initial_tie',
        'enable_impact_welding', 'enable_frictional_heating', 'enable_thermal_conduction',
        'export_ascii', 'export_binary', 'export_hdf5',
        'include_header', 'qty_pressure', 'qty_density', 'qty_velocity', 'qty_energy',
        'qty_reacted', 'qty_unreacted', 'qty_air', 'qty_materials', 'qty_water', 'qty_soil',
        'qty_mpm_pressure', 'qty_mpm_material_id', 'qty_mpm_object_id', 'qty_mpm_particle_density',
        'qty_overpressure', 'qty_impulse',
        'export_slices', 'export_volumes', 'export_fem', 'export_mpm', 'export_mpm_density_grid', 'export_pvd',
        'roi_enabled', 'is_ideal_gas', 'directional_crack_band', 'enable_heterogeneity',
        'enable_anisotropy', 'enable_strain_erosion', 'enable_stress_erosion',
        'enable_timestep_erosion', 'enable_density_erosion', 'erode_to_fv_grid', 'kc_auto_generate', 'enable_cohesive_splitting',
        'convert_failed_elements_to_mpm', 'use_pvd_collection', 'enable_compression',
        'export_raw_binary', 'show_stl', 'stl_show_results',
        'show_timing_breakdown', 'show_memory', 'show_wallclock', 'show_dt',
        'vertical_sleeve_breach', 'track_mpm_velocity'
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

        // Find the DomainMesh3D / SparseDomainMesh3D connected to CFDSolver3D.mesh
        const meshConn3D = state.connections.find(c => 
            (c.toNode === solverNode3D.id && c.toPort === 'mesh') ||
            (c.fromNode === solverNode3D.id && c.fromPort === 'mesh')
        );
        if (meshConn3D) {
            const meshId = meshConn3D.toNode === solverNode3D.id ? meshConn3D.fromNode : meshConn3D.toNode;
            const rootDomainNode = state.nodes.find(n => n.id === meshId);
            if (rootDomainNode && isDomainMesh3DNode(rootDomainNode.type)) {
                Object.entries(rootDomainNode.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
                if (rootDomainNode.type === 'SparseDomainMesh3D') {
                    flattenedParams['mpm_sparse_grid'] = true;
                    flattenedParams['sparse_grid'] = true;
                }
            }
        }

        // Fallback: if xmin/xmax is still undefined, check for any DomainMesh3D / SparseDomainMesh3D in the graph
        if (flattenedParams['xmin'] === undefined && flattenedParams['xmax'] === undefined) {
            const rootDomainMesh = state.nodes.find(n => isDomainMesh3DNode(n.type));
            if (rootDomainMesh) {
                Object.entries(rootDomainMesh.parameters).forEach(([key, value]) => {
                    if (flattenedParams[key] === undefined) {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    }
                });
                if (rootDomainMesh.type === 'SparseDomainMesh3D') {
                    flattenedParams['mpm_sparse_grid'] = true;
                    flattenedParams['sparse_grid'] = true;
                }
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
            const cPpc = chargeNode3D.parameters?.ppc;
            if (cPpc !== undefined) {
                flattenedParams['charge_ppc'] = Number(cPpc);
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
        const detConn3D = state.connections.find(c => 
            (c.toNode === solverNode3D.id || c.fromNode === solverNode3D.id) && 
            (c.toPort === 'detonator' || c.toPort === 'trigger' || c.fromPort === 'detonator' || c.fromPort === 'trigger')
        );
        let detNode3D = detConn3D ? state.nodes.find(n => (n.id === detConn3D.fromNode || n.id === detConn3D.toNode) && (n.type === 'DetonatorLocation3D' || n.type === 'TriggerLocation3D')) : null;
        if (!detNode3D) {
            detNode3D = state.nodes.find(n => n.type === 'DetonatorLocation3D' || n.type === 'TriggerLocation3D') || null;
        }
        if (detNode3D) {
            Object.entries(detNode3D.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : (booleanKeys.includes(key) ? Boolean(value) : value);
            });
            const tDelay = Number(detNode3D.parameters?.time_delay ?? detNode3D.parameters?.detonator_time ?? detNode3D.parameters?.start_time ?? 0.0);
            flattenedParams['time_delay'] = tDelay;
            flattenedParams['detonator_time'] = tDelay;
            flattenedParams['start_time'] = tDelay;
            flattenedParams['track_mpm_velocity'] = Boolean(detNode3D.parameters?.track_mpm_velocity);
            const dX = Number(flattenedParams['detonator_x'] ?? flattenedParams['trigger_x'] ?? flattenedParams['charge_x'] ?? 0.0);
            const dY = Number(flattenedParams['detonator_y'] ?? flattenedParams['trigger_y'] ?? flattenedParams['charge_y'] ?? 0.0);
            const dZ = Number(flattenedParams['detonator_z'] ?? flattenedParams['trigger_z'] ?? flattenedParams['charge_z'] ?? 0.0);
            const dR = Number(flattenedParams['detonator_radius'] ?? flattenedParams['trigger_radius'] ?? 0.02);
            const detObj = { trigger_x: dX, trigger_y: dY, trigger_z: dZ, trigger_radius: dR, start_time: tDelay, time_delay: tDelay, track_mpm_velocity: Boolean(detNode3D.parameters?.track_mpm_velocity) };
            flattenedParams['detonators'] = [detObj];
            flattenedParams['triggers'] = [detObj];
        }

        // Trace Remap 3D
        const remapConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'remap');
        const remapNode3D = remapConn3D ? state.nodes.find(n => n.id === remapConn3D.fromNode) : state.nodes.find(n => n.type === 'Remap1DTo3DNode' || n.type === 'Remap2DTo3DNode' || n.type === 'Remap3DTo3DNode');
        if (remapNode3D) {
            inheritRemap3DUpstream(state, remapNode3D, solverNode3D, modelId, flattenedParams, numericKeys, booleanKeys);
        }

        const gaugeExportAndQtyKeys = [
            'export_ascii', 'export_binary', 'export_hdf5', 'ascii_delimiter', 'ascii_precision',
            'include_header', 'custom_filename', 'output_dir',
            'qty_pressure', 'qty_overpressure', 'qty_impulse', 'qty_density', 'qty_velocity', 'qty_energy',
            'qty_reacted', 'qty_unreacted', 'qty_air', 'qty_water', 'qty_soil', 'qty_materials',
            'qty_mpm_pressure', 'qty_mpm_material_id', 'qty_mpm_object_id', 'qty_mpm_particle_density'
        ];

        const gaugeConn3D = state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'gauges');
        if (gaugeConn3D) {
            const gaugeNode3D = state.nodes.find(n => n.id === gaugeConn3D.fromNode);
            if (gaugeNode3D) {
                const sourceMode = gaugeNode3D.parameters.source_mode || 'manual';
                flattenedParams['gauge_source_mode'] = sourceMode;
                flattenedParams['external_gauge_file'] = resolveResourcePath(gaugeNode3D.parameters.external_file_path || '', modelFilename);
                flattenedParams['external_gauge_format'] = gaugeNode3D.parameters.external_file_format || 'Auto';
                flattenedParams['gauge_stride_steps'] = Number(gaugeNode3D.parameters.sampling_stride_steps || 1);
                flattenedParams['sampling_stride_steps'] = Number(gaugeNode3D.parameters.sampling_stride_steps || 1);
                flattenedParams['pinned_gauge_ids'] = gaugeNode3D.parameters.pinned_probe_ids || [];
                if (sourceMode === 'manual') {
                    flattenedParams['gauges'] = gaugeNode3D.parameters.gauges || [];
                } else {
                    flattenedParams['gauges'] = [];
                }
                gaugeExportAndQtyKeys.forEach(k => {
                    if (gaugeNode3D.parameters[k] !== undefined) {
                        flattenedParams[k] = castParam(k, gaugeNode3D.parameters[k]);
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

        // Trace remap input (whitelist geometric remap parameters only)
        const remapConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'remap');
        if (remapConn2D) {
            const remapNode2D = state.nodes.find(n => n.id === remapConn2D.fromNode);
            if (remapNode2D && remapNode2D.parameters) {
                const er = remapNode2D.parameters.explosive_r;
                const ez = remapNode2D.parameters.explosive_z ?? remapNode2D.parameters.z_offset;
                const rr = remapNode2D.parameters.remap_radius;
                if (er !== undefined) flattenedParams['explosive_r'] = Number(er);
                if (ez !== undefined) flattenedParams['explosive_z'] = Number(ez);
                if (rr !== undefined) flattenedParams['remap_radius'] = Number(rr);
                if (remapNode2D.parameters.source_model_id) {
                    flattenedParams['source_model_id'] = String(remapNode2D.parameters.source_model_id);
                }
            }
        }

        // Trace detonator / trigger input
        const detConn2D = state.connections.find(c => 
            (c.toNode === solverNode2D.id || c.fromNode === solverNode2D.id) && 
            (c.toPort === 'detonator' || c.toPort === 'trigger' || c.fromPort === 'detonator' || c.fromPort === 'trigger')
        );
        let detNode2D = detConn2D ? state.nodes.find(n => (n.id === detConn2D.fromNode || n.id === detConn2D.toNode) && (n.type === 'DetonatorLocation' || n.type === 'TriggerLocation')) : null;
        if (!detNode2D) {
            detNode2D = state.nodes.find(n => n.type === 'DetonatorLocation' || n.type === 'TriggerLocation') || null;
        }
        if (detNode2D) {
            Object.entries(detNode2D.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : (booleanKeys.includes(key) ? Boolean(value) : value);
            });
            const tDelay = Number(detNode2D.parameters?.time_delay ?? detNode2D.parameters?.detonator_time ?? detNode2D.parameters?.start_time ?? 0.0);
            flattenedParams['time_delay'] = tDelay;
            flattenedParams['detonator_time'] = tDelay;
            flattenedParams['start_time'] = tDelay;
            flattenedParams['track_mpm_velocity'] = Boolean(detNode2D.parameters?.track_mpm_velocity);
            const dR = Number(flattenedParams['detonator_r'] ?? flattenedParams['trigger_r'] ?? flattenedParams['charge_r'] ?? 0.0);
            const dZ = Number(flattenedParams['detonator_z'] ?? flattenedParams['trigger_z'] ?? flattenedParams['charge_z'] ?? 0.1);
            const dRad = Number(flattenedParams['detonator_radius'] ?? flattenedParams['trigger_radius'] ?? 0.001);
            const detObj = { trigger_r: dR, trigger_z: dZ, trigger_radius: dRad, start_time: tDelay, time_delay: tDelay, track_mpm_velocity: Boolean(detNode2D.parameters?.track_mpm_velocity) };
            flattenedParams['detonators'] = [detObj];
            flattenedParams['triggers'] = [detObj];
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
                flattenedParams['gauge_stride_steps'] = Number(targetNode.parameters?.sampling_stride_steps || 1);
                flattenedParams['sampling_stride_steps'] = Number(targetNode.parameters?.sampling_stride_steps || 1);
                flattenedParams['pinned_gauge_ids'] = targetNode.parameters?.pinned_probe_ids || [];
                if (sourceMode === 'manual') {
                    flattenedParams['gauges'] = targetNode.parameters?.gauges || [];
                } else {
                    flattenedParams['gauges'] = [];
                }
                const gauge2DKeys = [
                    'export_ascii', 'export_binary', 'export_hdf5', 'ascii_delimiter', 'ascii_precision',
                    'include_header', 'custom_filename', 'output_dir',
                    'qty_pressure', 'qty_overpressure', 'qty_impulse', 'qty_density', 'qty_velocity', 'qty_energy',
                    'qty_reacted', 'qty_unreacted', 'qty_air', 'qty_water', 'qty_soil', 'qty_materials',
                    'qty_mpm_pressure', 'qty_mpm_material_id', 'qty_mpm_object_id', 'qty_mpm_particle_density'
                ];
                gauge2DKeys.forEach(k => {
                    if (targetNode.parameters?.[k] !== undefined) {
                        flattenedParams[k] = castParam(k, targetNode.parameters[k]);
                    }
                });
            }
            if (targetNode && targetNode.type === 'VTKOutput') {
                Object.entries(targetNode.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
            }
            if (targetNode && targetNode.type === 'Obstacle') {
                if (!flattenedParams['obstacles_2d']) flattenedParams['obstacles_2d'] = [];
                const op = targetNode.parameters || {};
                flattenedParams['obstacles_2d'].push({
                    r1: Number(op.r1 ?? 0.2),
                    r2: Number(op.r2 ?? 0.4),
                    z1: Number(op.z1 ?? 0.2),
                    z2: Number(op.z2 ?? 0.4),
                    is_destructible: Boolean(op.is_destructible),
                    yield_stress: Number(op.yield_stress ?? 250e6),
                    rho: Number(op.rho ?? 7800.0)
                });
            }
        }
    }

    // Derived parameters for backend (Zero-Omission Phase)
    if (command === "INIT") {
        const radius = flattenedParams['domain_radius'] || 1.0;
        const dx = flattenedParams['cell_size'] || 0.001;
        flattenedParams['n_cells'] = Math.max(1, Math.round(radius / dx));

        // gamma comes from MaterialAir's gamma parameter (default 1.4 if not set)
        if (!flattenedParams['gamma']) flattenedParams['gamma'] = 1.4;

        const mass = flattenedParams['charge_mass'] !== undefined ? Number(flattenedParams['charge_mass']) : 0.0;
        const rho = flattenedParams['rho'] || 1630.0;
        flattenedParams['charge_mass'] = mass;
        flattenedParams['rho'] = rho;
        if (mass > 0) {
            flattenedParams['explosive_radius'] = Math.pow((3.0 * mass) / (4.0 * Math.PI * rho), 1.0/3.0);
        } else if (!flattenedParams['explosive_radius'] && flattenedParams['charge_radius']) {
            flattenedParams['explosive_radius'] = Number(flattenedParams['charge_radius']);
        } else if (!flattenedParams['explosive_radius']) {
            flattenedParams['explosive_radius'] = 0.05;
        }

        const p = flattenedParams['atm_pressure'] || 101325.0;
        const t = flattenedParams['atm_temperature'] || 288.0;
        flattenedParams['ambient_rho'] = p / (287.058 * t);

        // Ensure init_mode and composition are present with safe defaults
        if (!flattenedParams['init_mode'] || flattenedParams['init_mode'] === 'From1D' || flattenedParams['init_mode'] === 'From2D' || flattenedParams['init_mode'] === 'From3D') {
            flattenedParams['init_mode'] = 'Multi-Material JWL';
        }
        if (flattenedParams['init_mode'] === 'Multi-Material JWL' && !flattenedParams['composition']) {
            flattenedParams['composition'] = 'TNT';
        }

        // Re-apply 1D CFDSolver precedence (Directive 11 & 12) and translate space_time_scheme
        if (solverNode && solverNode.parameters) {
            if (solverNode.parameters.cfl !== undefined) flattenedParams['cfl'] = Number(solverNode.parameters.cfl);
            if (solverNode.parameters.endtime !== undefined) flattenedParams['endtime'] = Number(solverNode.parameters.endtime);
            if (solverNode.parameters.flux_scheme !== undefined) flattenedParams['flux_scheme'] = solverNode.parameters.flux_scheme;
            if (solverNode.parameters.precision !== undefined) flattenedParams['precision'] = solverNode.parameters.precision;
            if (solverNode.parameters.device !== undefined) flattenedParams['device'] = solverNode.parameters.device;
            if (solverNode.parameters.space_time_scheme !== undefined) flattenedParams['space_time_scheme'] = solverNode.parameters.space_time_scheme;
        }
        if (flattenedParams['space_time_scheme']) {
            const sts = flattenedParams['space_time_scheme'];
            if (sts === 'ADER-2 (2nd-Order Space/Time)') {
                flattenedParams['spatial_order'] = 2;
                flattenedParams['temporal_order'] = 2;
            } else if (sts === 'ADER-3 (3rd-Order Space/Time)') {
                flattenedParams['spatial_order'] = 3;
                flattenedParams['temporal_order'] = 3;
            } else if (sts === 'MUSCL-Hancock (2nd-Order Space/Time)') {
                flattenedParams['spatial_order'] = 2;
                flattenedParams['temporal_order'] = 2;
            }
        }
        if (flattenedParams['spatial_order'] === undefined) flattenedParams['spatial_order'] = 2;
        if (flattenedParams['temporal_order'] === undefined) flattenedParams['temporal_order'] = 2;
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
        if (solverNode2D && solverNode2D.parameters) {
            if (solverNode2D.parameters.device !== undefined) flattenedParams['device'] = solverNode2D.parameters.device;
            if (solverNode2D.parameters.precision !== undefined) flattenedParams['precision'] = solverNode2D.parameters.precision;
            if (solverNode2D.parameters.cfl !== undefined) flattenedParams['cfl'] = Number(solverNode2D.parameters.cfl);
            if (solverNode2D.parameters.endtime !== undefined) flattenedParams['endtime'] = Number(solverNode2D.parameters.endtime);
            if (solverNode2D.parameters.space_time_scheme !== undefined) flattenedParams['space_time_scheme'] = solverNode2D.parameters.space_time_scheme;
        }
        if (!flattenedParams['device']) flattenedParams['device'] = 'cpu';
        if (flattenedParams['space_time_scheme']) {
            const sts = flattenedParams['space_time_scheme'];
            if (sts === 'ADER-2 (2nd-Order Space/Time)') {
                flattenedParams['spatial_order'] = 2;
                flattenedParams['temporal_order'] = 2;
            } else if (sts === 'ADER-3 (3rd-Order Space/Time)') {
                flattenedParams['spatial_order'] = 3;
                flattenedParams['temporal_order'] = 3;
            } else if (sts === 'MUSCL-Hancock (2nd-Order Space/Time)') {
                flattenedParams['spatial_order'] = 2;
                flattenedParams['temporal_order'] = 2;
            }
        }

        const cellSize = flattenedParams['cell_size'] || 0.005;
        const minR = Number(flattenedParams['min_r'] ?? 0.0);
        const maxR = Number(flattenedParams['max_r'] ?? 1.0);
        const minZ = Number(flattenedParams['min_z'] ?? 0.0);
        const maxZ = Number(flattenedParams['max_z'] ?? 1.0);
        const spanR = Math.max(cellSize, maxR - minR);
        const spanZ = Math.max(cellSize, maxZ - minZ);

        if (flattenedParams['mesh_type'] === 'amr') {
            flattenedParams['nr'] = Math.ceil((Math.round(spanR / cellSize) || 128) / 16) * 16;
            flattenedParams['nz'] = Math.ceil((Math.round(spanZ / cellSize) || 128) / 16) * 16;
        } else {
            flattenedParams['nr'] = Math.max(1, Math.round(spanR / cellSize));
            flattenedParams['nz'] = Math.max(1, Math.round(spanZ / cellSize));
        }
        flattenedParams['min_r'] = minR;
        flattenedParams['max_r'] = maxR;
        flattenedParams['min_z'] = minZ;
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

            // Trace Detonator / Trigger for 2D FSI
            const detConn2D = state.connections.find(c =>
                (c.toNode === solverNode2D.id || c.fromNode === solverNode2D.id) &&
                (c.toPort === 'detonator' || c.toPort === 'trigger' || c.fromPort === 'detonator' || c.fromPort === 'trigger')
            );
            let detNode2D = detConn2D ? state.nodes.find(n => (n.id === detConn2D.fromNode || n.id === detConn2D.toNode) && (n.type === 'DetonatorLocation' || n.type === 'TriggerLocation')) : null;
            if (!detNode2D) {
                detNode2D = state.nodes.find(n => n.type === 'DetonatorLocation' || n.type === 'TriggerLocation') || null;
            }
            if (detNode2D) {
                Object.entries(detNode2D.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : (booleanKeys.includes(key) ? Boolean(value) : value);
                });
                const tDelay = Number(detNode2D.parameters?.time_delay ?? detNode2D.parameters?.detonator_time ?? detNode2D.parameters?.start_time ?? 0.0);
                flattenedParams['time_delay'] = tDelay;
                flattenedParams['detonator_time'] = tDelay;
                flattenedParams['start_time'] = tDelay;
            }

            // Trace Obstacles, Gauges, VTK on solverNode2D
            const solver2DConns = state.connections.filter(c => c.fromNode === solverNode2D.id || c.toNode === solverNode2D.id);
            for (const conn of solver2DConns) {
                const otherId = conn.fromNode === solverNode2D.id ? conn.toNode : conn.fromNode;
                const targetNode = state.nodes.find(n => n.id === otherId);
                if (targetNode && targetNode.type === 'Obstacle') {
                    if (!flattenedParams['obstacles_2d']) flattenedParams['obstacles_2d'] = [];
                    const op = targetNode.parameters || {};
                    flattenedParams['obstacles_2d'].push({
                        r1: Number(op.r1 ?? 0.2),
                        r2: Number(op.r2 ?? 0.4),
                        z1: Number(op.z1 ?? 0.2),
                        z2: Number(op.z2 ?? 0.4),
                        is_destructible: Boolean(op.is_destructible),
                        yield_stress: Number(op.yield_stress ?? 250e6),
                        rho: Number(op.rho ?? 7800.0)
                    });
                }
                if (targetNode && targetNode.type === 'VirtualGauges') {
                    flattenedParams['gauges'] = targetNode.parameters?.gauges || [];
                }
            }

            const remapConn2D = state.connections.find(c => c.toNode === solverNode2D.id && c.toPort === 'remap');
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
        }

        // 2. Serialize MPM Domain part
        const mpmDomain = state.nodes.find(n => n.type === 'MPMDomain2D');
        if (mpmDomain) {
            Object.entries(mpmDomain.parameters).forEach(([key, value]) => {
                if (key !== 'cfl' && key !== 'endtime') {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                }
            });
            const mpmMeshConn2D = state.connections.find(c => c.toNode === mpmDomain.id && c.toPort === 'mesh');
            const mpmMeshNode2D = mpmMeshConn2D ? state.nodes.find(n => n.id === mpmMeshConn2D.fromNode) : state.nodes.find(n => isDomainMesh2DNode(n.type));
            if (mpmMeshNode2D) {
                Object.entries(mpmMeshNode2D.parameters).forEach(([key, value]) => {
                    if (flattenedParams[key] === undefined) {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    }
                });
                if (mpmMeshNode2D.type === 'SparseDomainMesh2D') {
                    flattenedParams['mpm_sparse_grid'] = true;
                    flattenedParams['sparse_grid'] = true;
                }
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
                    if (matNode?.parameters?.['mixture_rule'] !== undefined) {
                        objParams['mixture_rule'] = matNode.parameters['mixture_rule'];
                    } else if (objNode.parameters?.['mixture_rule'] !== undefined) {
                        objParams['mixture_rule'] = objNode.parameters['mixture_rule'];
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
        if (state.nodes.some(n => n.type === 'SparseDomainMesh2D')) {
            flattenedParams['mpm_sparse_grid'] = true;
            flattenedParams['sparse_grid'] = true;
        }

        // 3. Serialize FSICoupler2D parameters
        const couplerNode = state.nodes.find(n => n.type === 'FSICoupler2D');
        if (couplerNode) {
            Object.entries(couplerNode.parameters).forEach(([key, value]) => {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            });
        }

        // 4. Derive charge geometry & ambient state for 2D FSI
        if (!flattenedParams['gamma']) flattenedParams['gamma'] = 1.4;
        const p = flattenedParams['atm_pressure'] || 101325.0;
        const t = flattenedParams['atm_temperature'] || 288.0;
        flattenedParams['ambient_rho'] = p / (287.058 * t);

        const mass = flattenedParams['charge_mass'] !== undefined ? Number(flattenedParams['charge_mass']) : 0.0;
        const rho = flattenedParams['rho'] || 1630.0;
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
        } else if (!flattenedParams['charge_radius']) {
            flattenedParams['charge_radius'] = Number(flattenedParams['explosive_radius'] ?? 0.05);
        }

        const cellSize = flattenedParams['cell_size'] || 0.005;
        const minR = Number(flattenedParams['min_r'] ?? 0.0);
        const maxR = Number(flattenedParams['max_r'] ?? 1.0);
        const minZ = Number(flattenedParams['min_z'] ?? 0.0);
        const maxZ = Number(flattenedParams['max_z'] ?? 1.0);
        const spanR = Math.max(cellSize, maxR - minR);
        const spanZ = Math.max(cellSize, maxZ - minZ);
        if (flattenedParams['mesh_type'] === 'amr') {
            flattenedParams['nr'] = Math.ceil((Math.round(spanR / cellSize) || 128) / 16) * 16;
            flattenedParams['nz'] = Math.ceil((Math.round(spanZ / cellSize) || 128) / 16) * 16;
        } else {
            flattenedParams['nr'] = Math.max(1, Math.round(spanR / cellSize));
            flattenedParams['nz'] = Math.max(1, Math.round(spanZ / cellSize));
        }
        flattenedParams['min_r'] = minR;
        flattenedParams['max_r'] = maxR;
        flattenedParams['min_z'] = minZ;
        flattenedParams['max_z'] = maxZ;

        // 5. Re-apply CFDSolver2D solver config keys for strict precedence (Directive 11 & 12)
        if (solverNode2D) {
            if (solverNode2D.parameters.device !== undefined) flattenedParams['device'] = solverNode2D.parameters.device;
            if (solverNode2D.parameters.precision !== undefined) flattenedParams['precision'] = solverNode2D.parameters.precision;
            if (solverNode2D.parameters.space_time_scheme !== undefined) flattenedParams['space_time_scheme'] = solverNode2D.parameters.space_time_scheme;
            if (couplerNode?.parameters?.cfl === undefined && solverNode2D.parameters.cfl !== undefined) {
                flattenedParams['cfl'] = Number(solverNode2D.parameters.cfl);
            }
            if (couplerNode?.parameters?.endtime === undefined && solverNode2D.parameters.endtime !== undefined) {
                flattenedParams['endtime'] = Number(solverNode2D.parameters.endtime);
            }
        }
    } else if (command === "INIT_FSI_3D") {
        const couplerNode = state.nodes.find(n => n.type === 'FSICoupler3D');
        // 1. Serialize 3D CFD Solver part
        const cfdConn = couplerNode ? state.connections.find(c => c.toNode === couplerNode.id && (c.toPort === 'cfd' || c.toPort === 'cfd_solver')) : null;
        const solverNode3D = cfdConn ? state.nodes.find(n => n.id === cfdConn.fromNode) : state.nodes.find(n => n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain');
        let detNode3D: any = null;
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
                if (rootDomainNode && isDomainMesh3DNode(rootDomainNode.type)) {
                    Object.entries(rootDomainNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                    if (rootDomainNode.type === 'SparseDomainMesh3D') {
                        flattenedParams['mpm_sparse_grid'] = true;
                        flattenedParams['sparse_grid'] = true;
                    }
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
                    const cPpc = chargeNode3D.parameters?.ppc;
                    if (cPpc !== undefined) {
                        flattenedParams['charge_ppc'] = Number(cPpc);
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
            detNode3D = detConn3D ? state.nodes.find(n => n.id === detConn3D.fromNode) : null;
            if (!detNode3D && solverNode3D.parameters?.connected_detonators) {
                detNode3D = state.nodes.find(n => n.id === solverNode3D.parameters.connected_detonators || (n as any).name === solverNode3D.parameters.connected_detonators || n.parameters?.name === solverNode3D.parameters.connected_detonators);
            }
            if (!detNode3D) {
                detNode3D = state.nodes.find(n => n.type === 'DetonatorLocation3D' || n.type === 'TriggerLocation3D');
            }
            if (detNode3D && (detNode3D.type === 'DetonatorLocation3D' || detNode3D.type === 'TriggerLocation3D')) {
                Object.entries(detNode3D.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : (booleanKeys.includes(key) ? Boolean(value) : value);
                });
                const dX = Number(detNode3D.parameters.detonator_x ?? detNode3D.parameters.trigger_x ?? detNode3D.parameters.x ?? flattenedParams['charge_x'] ?? 0.0);
                const dY = Number(detNode3D.parameters.detonator_y ?? detNode3D.parameters.trigger_y ?? detNode3D.parameters.y ?? flattenedParams['charge_y'] ?? 0.0);
                const dZ = Number(detNode3D.parameters.detonator_z ?? detNode3D.parameters.trigger_z ?? detNode3D.parameters.z ?? flattenedParams['charge_z'] ?? 6.0);
                const dR = Number(detNode3D.parameters.detonator_radius ?? detNode3D.parameters.trigger_radius ?? detNode3D.parameters.radius ?? 0.05);
                const tDelay = Number(detNode3D.parameters.time_delay ?? detNode3D.parameters.detonator_time ?? detNode3D.parameters.start_time ?? 0.0);
                const trackVel = Boolean(detNode3D.parameters.track_mpm_velocity);
                const detObj = { trigger_x: dX, trigger_y: dY, trigger_z: dZ, trigger_radius: dR, start_time: tDelay, time_delay: tDelay, track_mpm_velocity: trackVel };
                flattenedParams['detonators'] = [detObj];
                flattenedParams['triggers'] = [detObj];
            } else if (flattenedParams['detonator_x'] !== undefined || flattenedParams['charge_x'] !== undefined) {
                const dX = Number(flattenedParams['detonator_x'] ?? flattenedParams['charge_x'] ?? 0.0);
                const dY = Number(flattenedParams['detonator_y'] ?? flattenedParams['charge_y'] ?? 0.0);
                const dZ = Number(flattenedParams['detonator_z'] ?? flattenedParams['charge_z'] ?? 6.0);
                const dR = Number(flattenedParams['detonator_radius'] ?? 0.05);
                const tDelay = Number(flattenedParams['time_delay'] ?? flattenedParams['detonator_time'] ?? flattenedParams['start_time'] ?? 0.0);
                const trackVel = Boolean(flattenedParams['track_mpm_velocity']);
                const detObj = { trigger_x: dX, trigger_y: dY, trigger_z: dZ, trigger_radius: dR, start_time: tDelay, time_delay: tDelay, track_mpm_velocity: trackVel };
                flattenedParams['detonators'] = [detObj];
                flattenedParams['triggers'] = [detObj];
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
            const remapNode3D = remapConn3D ? state.nodes.find(n => n.id === remapConn3D.fromNode) : state.nodes.find(n => n.type === 'Remap1DTo3DNode' || n.type === 'Remap2DTo3DNode' || n.type === 'Remap3DTo3DNode');
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
                    const cfdHasMesh = Boolean(solverNode3D && state.connections.some(c => c.toNode === solverNode3D.id && c.toPort === 'mesh'));
                    const meshKeySet = new Set(['cell_size', 'xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax', 'nx', 'ny', 'nz']);
                    Object.entries(meshNode.parameters).forEach(([key, value]) => {
                        const castVal = numericKeys.includes(key) ? Number(value) : value;
                        if (key === 'cell_size') flattenedParams['mpm_cell_size'] = Number(value);
                        else if (key === 'xmin') flattenedParams['mpm_xmin'] = Number(value);
                        else if (key === 'xmax') flattenedParams['mpm_xmax'] = Number(value);
                        else if (key === 'ymin') flattenedParams['mpm_ymin'] = Number(value);
                        else if (key === 'ymax') flattenedParams['mpm_ymax'] = Number(value);
                        else if (key === 'zmin') flattenedParams['mpm_zmin'] = Number(value);
                        else if (key === 'zmax') flattenedParams['mpm_zmax'] = Number(value);
                        if (!cfdHasMesh || !meshKeySet.has(key) || flattenedParams[key] === undefined) {
                            flattenedParams[key] = castVal;
                        }
                    });
                    if (meshNode.type === 'SparseDomainMesh3D') {
                        flattenedParams['mpm_sparse_grid'] = true;
                        flattenedParams['sparse_grid'] = true;
                    }
                }
            }

            const domainPpc = Number(mpmDomain.parameters?.ppc ?? 8);
            flattenedParams['ppc'] = domainPpc;
        }
        if (state.nodes.some(n => n.type === 'SparseDomainMesh3D')) {
            flattenedParams['mpm_sparse_grid'] = true;
            flattenedParams['sparse_grid'] = true;
        }
        if (flattenedParams['xmin'] === undefined && flattenedParams['xmax'] === undefined) {
            const fallbackMesh3D = state.nodes.find(n => isDomainMesh3DNode(n.type));
            if (fallbackMesh3D) {
                Object.entries(fallbackMesh3D.parameters).forEach(([key, value]) => {
                    if (flattenedParams[key] === undefined) {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    }
                });
            }
        }

        serializeMPMObjectsWithSleeve(state, solverNode3D, mpmDomain, flattenedParams, numericKeys, modelFilename);

        if (mpmDomain) {
            const isDetNode = (n: any) => n && (n.type === 'DetonatorLocation3D' || n.type === 'DetonatorLocation' || n.type === 'TriggerLocation3D' || n.type === 'TriggerLocation');
            const mpmDetConns = state.connections.filter(c => 
                ((c.toNode === mpmDomain.id || c.fromNode === mpmDomain.id) ||
                 state.nodes.some(n => n.type === 'MPMObject3D' && (n.id === c.toNode || n.id === c.fromNode))) &&
                (c.toPort === 'detonator' || c.toPort === 'trigger' || c.toPort === 'detonators' || c.fromPort === 'detonator' || c.fromPort === 'trigger')
            );
            const mpmDetonators: any[] = [];
            for (const conn of mpmDetConns) {
                const otherId = (conn.toNode === mpmDomain.id || state.nodes.some(n => n.type === 'MPMObject3D' && n.id === conn.toNode)) ? conn.fromNode : conn.toNode;
                const detNode = state.nodes.find(n => n.id === otherId && isDetNode(n));
                if (detNode && !mpmDetonators.some(d => d._id === detNode.id)) {
                    const detParams: any = { _id: detNode.id };
                    Object.entries(detNode.parameters).forEach(([key, value]) => {
                        detParams[key] = numericKeys.includes(key) ? Number(value) : (booleanKeys.includes(key) ? Boolean(value) : value);
                    });
                    const tDelay = Number(detParams.time_delay ?? detParams.detonator_time ?? detParams.start_time ?? 0.0);
                    detParams.time_delay = tDelay;
                    detParams.detonator_time = tDelay;
                    detParams.start_time = tDelay;
                    detParams.track_mpm_velocity = Boolean(detParams.track_mpm_velocity);
                    mpmDetonators.push(detParams);
                }
            }
            if (mpmDetonators.length === 0 && !flattenedParams['detonators']) {
                const fallbackDets = state.nodes.filter(isDetNode);
                for (const detNode of fallbackDets) {
                    if (detNode3D && detNode.id === detNode3D.id) continue;
                    const detParams: any = { _id: detNode.id };
                    Object.entries(detNode.parameters).forEach(([key, value]) => {
                        detParams[key] = numericKeys.includes(key) ? Number(value) : (booleanKeys.includes(key) ? Boolean(value) : value);
                    });
                    const tDelay = Number(detParams.time_delay ?? detParams.detonator_time ?? detParams.start_time ?? 0.0);
                    detParams.time_delay = tDelay;
                    detParams.detonator_time = tDelay;
                    detParams.start_time = tDelay;
                    detParams.track_mpm_velocity = Boolean(detParams.track_mpm_velocity);
                    mpmDetonators.push(detParams);
                }
            }
            if (mpmDetonators.length > 0) {
                const existing = Array.isArray(flattenedParams['detonators']) ? flattenedParams['detonators'] : [];
                flattenedParams['detonators'] = [...existing, ...mpmDetonators.map(({ _id, ...rest }) => rest)];
                flattenedParams['triggers'] = flattenedParams['detonators'];
                Object.entries(mpmDetonators[0]).forEach(([key, value]) => {
                    if (key !== '_id' && flattenedParams[key] === undefined) flattenedParams[key] = value;
                });
            }
        }

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

        const isHarbourSolver = (solverNode3D?.type === 'MarineHarbourDomain');
        const cellSize = flattenedParams['cell_size'] || (isHarbourSolver ? 0.125 : 0.01);
        const xmin = flattenedParams['xmin'] !== undefined ? flattenedParams['xmin'] : (isHarbourSolver ? -10.0 : 0.0);
        const xmax = flattenedParams['xmax'] !== undefined ? flattenedParams['xmax'] : (isHarbourSolver ? 10.0 : 1.0);
        const ymin = flattenedParams['ymin'] !== undefined ? flattenedParams['ymin'] : (isHarbourSolver ? -10.0 : 0.0);
        const ymax = flattenedParams['ymax'] !== undefined ? flattenedParams['ymax'] : (isHarbourSolver ? 10.0 : 1.0);
        const zmin = flattenedParams['zmin'] !== undefined ? flattenedParams['zmin'] : 0.0;
        const zmax = flattenedParams['zmax'] !== undefined ? flattenedParams['zmax'] : (isHarbourSolver ? 15.0 : 1.0);
        flattenedParams['nx'] = Math.round((xmax - xmin) / cellSize);
        flattenedParams['ny'] = Math.round((ymax - ymin) / cellSize);
        flattenedParams['nz'] = Math.round((zmax - zmin) / cellSize);
        flattenedParams['xmin'] = xmin;
        flattenedParams['ymin'] = ymin;
        flattenedParams['zmin'] = zmin;

        const hasChargeConn3D = solverNode3D ? Boolean(state.connections.find(c => c.toNode === solverNode3D.id && c.toPort === 'charge')) : false;
        const isStratified3D = flattenedParams['init_mode'] === 'Hydrostatic_Stratified_3D' || solverNode3D?.parameters?.init_mode === 'Hydrostatic_Stratified_3D' || solverNode3D?.type === 'MarineHarbourDomain';
        const isRemap3D = flattenedParams['init_mode'] === 'From1D' || flattenedParams['init_mode'] === 'From2D' || flattenedParams['init_mode'] === 'From3D';
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
                if (rootDomainNode && isDomainMesh3DNode(rootDomainNode.type)) {
                    Object.entries(rootDomainNode.parameters).forEach(([key, value]) => {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    });
                    if (rootDomainNode.type === 'SparseDomainMesh3D') {
                        flattenedParams['mpm_sparse_grid'] = true;
                        flattenedParams['sparse_grid'] = true;
                    }
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
                    const cPpc = chargeNode3D.parameters?.ppc;
                    if (cPpc !== undefined) {
                        flattenedParams['charge_ppc'] = Number(cPpc);
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
            const remapNode3D = remapConn3D ? state.nodes.find(n => n.id === remapConn3D.fromNode) : state.nodes.find(n => n.type === 'Remap1DTo3DNode' || n.type === 'Remap2DTo3DNode' || n.type === 'Remap3DTo3DNode');
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
                    const stlConn = state.connections.find(c => c.toNode === objNode.id && c.toPort === 'stl');
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
                    } else if (stlConn) {
                        const stlNode = state.nodes.find(n => n.id === stlConn.fromNode);
                        if (stlNode && stlNode.type === 'STLGeometry') {
                            objParams['stl_file'] = resolveResourcePath(stlNode.parameters.stl_file || '', modelFilename);
                            objParams['mesh_source'] = 'STL File';
                            objParams['shape_type'] = 'STL';
                            objParams['element_topology'] = 'Tet4_ANP';
                            if (stlNode.parameters.scale_x !== undefined && objNode.parameters.scale_x === undefined) objParams['scale_x'] = Number(stlNode.parameters.scale_x);
                            if (stlNode.parameters.scale_y !== undefined && objNode.parameters.scale_y === undefined) objParams['scale_y'] = Number(stlNode.parameters.scale_y);
                            if (stlNode.parameters.scale_z !== undefined && objNode.parameters.scale_z === undefined) objParams['scale_z'] = Number(stlNode.parameters.scale_z);
                            if (stlNode.parameters.rot_x !== undefined && objNode.parameters.rot_x === undefined) objParams['rot_x'] = Number(stlNode.parameters.rot_x);
                            if (stlNode.parameters.rot_y !== undefined && objNode.parameters.rot_y === undefined) objParams['rot_y'] = Number(stlNode.parameters.rot_y);
                            if (stlNode.parameters.rot_z !== undefined && objNode.parameters.rot_z === undefined) objParams['rot_z'] = Number(stlNode.parameters.rot_z);
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
                const shapeType = objParams['shape_type'] || (objParams['mesh_source'] === 'Cylinder Generator' ? 'Cylinder' : (objParams['mesh_source'] === 'STL File' ? 'STL' : (objParams['mesh_source'] === 'Plate Generator' ? 'Plate' : (objParams['mesh_source'] === 'LS-DYNA Keyword File' ? 'LS-DYNA File' : 'Box'))));
                objParams['shape_type'] = shapeType;
                objParams['mesh_source'] = shapeType === 'Cylinder' ? 'Cylinder Generator' : (shapeType === 'STL' ? 'STL File' : (shapeType === 'Plate' ? 'Plate Generator' : (shapeType === 'LS-DYNA File' ? 'LS-DYNA Keyword File' : 'Box Generator')));
                objParams['origin_mode'] = objParams['origin_mode'] || objNode.parameters?.origin_mode || 'Center';
                objParams['element_topology'] = objParams['element_topology'] || objNode.parameters?.element_topology || (shapeType === 'STL' ? 'Tet4_ANP' : 'Hex8');

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

                const setup = objNode.parameters?.['fem_setup'] || (femDomain ? femDomain.parameters?.['fem_setup'] : undefined) || syncModelFEMSetup(state, getLSDynaDeckMeta);
                if (setup) {
                    if (setup.parts && Array.isArray(setup.parts)) {
                        const primaryPart = setup.parts.find((p: any) => p.canvas_node_id === objNode.id || p.node_id === objNode.id || p.id === objNode.id || p.name === objNode.parameters?.name) || setup.parts[0];
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
                            if (objNode.parameters?.['element_topology']) {
                                objParams['element_topology'] = objNode.parameters['element_topology'];
                                primaryPart.element_topology = objParams['element_topology'];
                            } else if (primaryPart.element_topology) {
                                objParams['element_topology'] = primaryPart.element_topology;
                            }
                        }
                        objParams['fem_parts'] = setup.parts.map((p: any) => {
                            const isSelfPart = (setup.parts.length === 1 || p.canvas_node_id === objNode.id || p.node_id === objNode.id || p.id === objNode.id);
                            let mappedMatId: number | undefined = undefined;
                            const matDef = Array.isArray(setup.materials) ? setup.materials.find((m: any) => m.mat_id === p.material_id) : undefined;
                            if (matDef?.canvas_node_id && matIdMap.has(matDef.canvas_node_id)) {
                                mappedMatId = matIdMap.get(matDef.canvas_node_id);
                            } else if (typeof p.material_assignment === 'string') {
                                if (matIdMap.has(p.material_assignment)) {
                                    mappedMatId = matIdMap.get(p.material_assignment);
                                } else if (p.material_assignment.startsWith('DECK_MAT_')) {
                                    mappedMatId = canvasMats.length + parseInt(p.material_assignment.replace('DECK_MAT_', ''), 10) - 1;
                                }
                            } else if (typeof p.material_assignment === 'number') {
                                mappedMatId = p.material_assignment;
                            } else if (typeof p.material_id === 'number' && p.material_id >= 1) {
                                mappedMatId = Math.max(0, p.material_id - 1);
                            }
                            const secToTopo: Record<string, string> = {
                                'SolidHex8': 'Hex8', 'SolidHex8_SRI': 'Hex8_SRI', 'SolidHex8_Full': 'Hex8_Full',
                                'SolidTet4': 'Tet4', 'SolidTet4_ANP': 'Tet4_ANP', 'SolidWedge6': 'Wedge6',
                                'Shell4': 'Shell4', 'Beam3D': 'Beam3D', 'Truss1D': 'Truss1D'
                            };
                            return {
                                part_id: Number(p.part_id),
                                deck_part_id: p.deck_part_id !== undefined ? Number(p.deck_part_id) : Number(p.part_id),
                                canvas_node_id: p.canvas_node_id || '',
                                name: String(p.name || ''),
                                section_type: String(p.section_type || 'SolidHex8'),
                                thickness_or_area: Number(p.thickness_or_area ?? 0.01),
                                hourglass_coeff: Number(p.hourglass_coeff ?? 0.03),
                                suppressed: p.suppressed === true,
                                visible: p.visible !== false,
                                color: String(p.color || '#3b82f6'),
                                initial_velocity: Array.isArray(p.initial_velocity) ? p.initial_velocity.map(Number) : [0, 0, 0],
                                material_id: mappedMatId,
                                material_assignment: p.material_assignment,
                                failure_strain: p.erosion_override?.failure_strain !== undefined ? Number(p.erosion_override.failure_strain) : undefined,
                                convert_to_mpm: p.erosion_override?.convert_to_mpm === true,
                                shape_type: p.shape_type || objParams['shape_type'] || 'Box',
                                element_topology: secToTopo[p.section_type] || p.element_topology || objParams['element_topology'] || 'Hex8',
                                stl_file: p.stl_file || objParams['stl_file'] || '',
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
                            dofs: Array.isArray(bc.dofs)
                                ? bc.dofs.map(Boolean)
                                : [
                                    bc.dofs?.tx !== false,
                                    bc.dofs?.ty !== false,
                                    bc.dofs?.tz !== false,
                                    bc.dofs?.rx === true,
                                    bc.dofs?.ry === true,
                                    bc.dofs?.rz === true
                                  ],
                            velocity: Array.isArray(bc.values)
                                ? bc.values.map(Number)
                                : (Array.isArray(bc.velocity) ? bc.velocity.map(Number) : [0, 0, 0]),
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
                if (femObjects[0]['fem_parts']) flattenedParams['fem_parts'] = femObjects[0]['fem_parts'];
                if (femObjects[0]['fem_sets']) flattenedParams['fem_sets'] = femObjects[0]['fem_sets'];
                if (femObjects[0]['boundary_conditions']) flattenedParams['boundary_conditions'] = femObjects[0]['boundary_conditions'];
                if (femObjects[0]['fem_contacts']) flattenedParams['fem_contacts'] = femObjects[0]['fem_contacts'];
                if (femObjects[0]['fem_materials']) flattenedParams['fem_materials'] = femObjects[0]['fem_materials'];
            }
            if (femDomain) {
                if (femDomain.parameters?.['merge_coincident_nodes'] !== undefined) {
                    flattenedParams['merge_coincident_nodes'] = Boolean(femDomain.parameters['merge_coincident_nodes']);
                }
                if (femDomain.parameters?.['node_merge_tolerance'] !== undefined) {
                    flattenedParams['node_merge_tolerance'] = Number(femDomain.parameters['node_merge_tolerance']);
                }
                if (femDomain.parameters?.['embedded_rebar_coupling'] !== undefined) {
                    flattenedParams['embedded_rebar_coupling'] = Boolean(femDomain.parameters['embedded_rebar_coupling']);
                }
            }

            if (femDomain) {
                const femDetConns = state.connections.filter(c => c.toNode === femDomain.id && (c.toPort === 'detonator' || c.toPort === 'trigger'));
                const femDetonators: any[] = Array.isArray(flattenedParams['triggers']) ? [...flattenedParams['triggers']] : [];
                for (const conn of femDetConns) {
                    const detNode = state.nodes.find(n => n.id === conn.fromNode);
                    if (detNode && (detNode.type === 'DetonatorLocation3D' || detNode.type === 'DetonatorLocation' || detNode.type === 'TriggerLocation3D' || detNode.type === 'TriggerLocation')) {
                        const detParams: any = {};
                        Object.entries(detNode.parameters).forEach(([key, value]) => {
                            detParams[key] = numericKeys.includes(key) ? Number(value) : (booleanKeys.includes(key) ? Boolean(value) : value);
                        });
                        if (detParams.time_delay === undefined && detParams.detonator_time !== undefined) detParams.time_delay = detParams.detonator_time;
                        if (detParams.detonator_time === undefined && detParams.time_delay !== undefined) detParams.detonator_time = detParams.time_delay;
                        femDetonators.push(detParams);
                    }
                }
                if (femDetonators.length > 0) {
                    flattenedParams['detonators'] = femDetonators;
                    flattenedParams['triggers'] = femDetonators;
                }
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
            const domainMesh = state.nodes.find(n => isDomainMesh3DNode(n.type) || n.type === 'DomainMesh');
            if (domainMesh && domainMesh.parameters?.slices) {
                flattenedParams['slices'] = domainMesh.parameters.slices;
            } else {
                const vpNode = state.nodes.find(n => n.type === 'Telemetry3DViewport');
                if (vpNode && vpNode.parameters?.slices) {
                    flattenedParams['slices'] = vpNode.parameters.slices;
                }
            }
        }
        if (state.nodes.some(n => n.type === 'SparseDomainMesh3D')) {
            flattenedParams['mpm_sparse_grid'] = true;
            flattenedParams['sparse_grid'] = true;
        }
        if (flattenedParams['xmin'] === undefined && flattenedParams['xmax'] === undefined) {
            const fallbackMesh3D = state.nodes.find(n => isDomainMesh3DNode(n.type));
            if (fallbackMesh3D) {
                Object.entries(fallbackMesh3D.parameters).forEach(([key, value]) => {
                    if (flattenedParams[key] === undefined) {
                        flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                    }
                });
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
        const isRemap3D = flattenedParams['init_mode'] === 'From1D' || flattenedParams['init_mode'] === 'From2D' || flattenedParams['init_mode'] === 'From3D';
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
            const meshNode = meshId ? state.nodes.find(n => n.id === meshId) : state.nodes.find(n => isDomainMesh2DNode(n.type));
            if (meshNode) {
                Object.entries(meshNode.parameters).forEach(([key, value]) => {
                    flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
                });
                if (meshNode.type === 'SparseDomainMesh2D') {
                    flattenedParams['mpm_sparse_grid'] = true;
                    flattenedParams['sparse_grid'] = true;
                }
                const cellSize = Math.max(1e-6, Number(meshNode.parameters?.cell_size ?? 0.005));
                const minR = Number(meshNode.parameters?.min_r ?? 0.0);
                const maxR = Number(meshNode.parameters?.max_r ?? 1.0);
                const minZ = Number(meshNode.parameters?.min_z ?? 0.0);
                const maxZ = Number(meshNode.parameters?.max_z ?? 1.0);
                const spanR = Math.max(cellSize, maxR - minR);
                const spanZ = Math.max(cellSize, maxZ - minZ);
                const nr = Math.max(1, Math.round(spanR / cellSize));
                const nz = Math.max(1, Math.round(spanZ / cellSize));
                flattenedParams['nr'] = nr;
                flattenedParams['nz'] = nz;
                flattenedParams['nx'] = nr;
                flattenedParams['ny'] = nz;
                flattenedParams['min_r'] = minR;
                flattenedParams['max_r'] = maxR;
                flattenedParams['min_z'] = minZ;
                flattenedParams['max_z'] = maxZ;
                flattenedParams['max_x'] = spanR;
                flattenedParams['max_y'] = spanZ;
                flattenedParams['domain_x'] = spanR;
                flattenedParams['domain_y'] = spanZ;
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
                    if (matNode?.parameters?.['mixture_rule'] !== undefined) {
                        objParams['mixture_rule'] = matNode.parameters['mixture_rule'];
                    } else if (objNode.parameters?.['mixture_rule'] !== undefined) {
                        objParams['mixture_rule'] = objNode.parameters['mixture_rule'];
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

            const isDetNode2D = (n: any) => n && (n.type === 'DetonatorLocation' || n.type === 'TriggerLocation');
            const detConns = state.connections.filter(c => 
                ((c.toNode === mpmDomain.id || c.fromNode === mpmDomain.id) ||
                 state.nodes.some(n => n.type === 'MPMObject2D' && (n.id === c.toNode || n.id === c.fromNode))) &&
                (c.toPort === 'detonator' || c.toPort === 'trigger' || c.toPort === 'detonators' || c.fromPort === 'detonator' || c.fromPort === 'trigger')
            );
            const detonators: any[] = [];
            for (const conn of detConns) {
                const otherId = (conn.toNode === mpmDomain.id || state.nodes.some(n => n.type === 'MPMObject2D' && n.id === conn.toNode)) ? conn.fromNode : conn.toNode;
                const detNode = state.nodes.find(n => n.id === otherId && isDetNode2D(n));
                if (detNode && !detonators.some(d => d._id === detNode.id)) {
                    const detParams: any = { _id: detNode.id };
                    Object.entries(detNode.parameters).forEach(([key, value]) => {
                        detParams[key] = numericKeys.includes(key) ? Number(value) : (booleanKeys.includes(key) ? Boolean(value) : value);
                    });
                    const tDelay = Number(detParams.time_delay ?? detParams.detonator_time ?? detParams.start_time ?? 0.0);
                    detParams.time_delay = tDelay;
                    detParams.detonator_time = tDelay;
                    detParams.start_time = tDelay;
                    detParams.track_mpm_velocity = Boolean(detParams.track_mpm_velocity);
                    detonators.push(detParams);
                }
            }
            if (detonators.length === 0) {
                const fallbackDets = state.nodes.filter(isDetNode2D);
                for (const detNode of fallbackDets) {
                    if (detonators.some(d => d._id === detNode.id)) continue;
                    const detParams: any = { _id: detNode.id };
                    Object.entries(detNode.parameters).forEach(([key, value]) => {
                        detParams[key] = numericKeys.includes(key) ? Number(value) : (booleanKeys.includes(key) ? Boolean(value) : value);
                    });
                    const tDelay = Number(detParams.time_delay ?? detParams.detonator_time ?? detParams.start_time ?? 0.0);
                    detParams.time_delay = tDelay;
                    detParams.detonator_time = tDelay;
                    detParams.start_time = tDelay;
                    detParams.track_mpm_velocity = Boolean(detParams.track_mpm_velocity);
                    detonators.push(detParams);
                }
            }
            if (detonators.length > 0) {
                flattenedParams['detonators'] = detonators.map(({ _id, ...rest }) => rest);
                flattenedParams['triggers'] = flattenedParams['detonators'];
                Object.entries(detonators[0]).forEach(([key, value]) => {
                    if (key !== '_id') flattenedParams[key] = value;
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
            let meshNode = meshId ? state.nodes.find(n => n.id === meshId) : state.nodes.find(n => isDomainMesh3DNode(n.type));
            if (!meshNode) {
                throw new Error("Cannot initialize MPM 3D: No DomainMesh3D / SparseDomainMesh3D background grid connected to MPM Domain 3D. You must define a background grid.");
            }
            Object.entries(meshNode.parameters).forEach(([key, value]) => {
                flattenedParams[key] = castParam(key, value);
            });
            if (meshNode.type === 'SparseDomainMesh3D') {
                flattenedParams['mpm_sparse_grid'] = true;
                flattenedParams['sparse_grid'] = true;
            }

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
            flattenedParams['bardenhagen_grouping_policy'] = mpmDomain.parameters?.bardenhagen_grouping_policy || 'Per-Object Independent';
            flattenedParams['bardenhagen_initial_tie'] = mpmDomain.parameters?.bardenhagen_initial_tie ?? true;

            const objConns = state.connections.filter(c => c.toNode === mpmDomain.id && (c.toPort === 'objects' || c.toPort === 'mpm_objects' || c.toPort === 'in'));
            const directObjNodes = objConns.map(c => state.nodes.find(n => n.id === c.fromNode)).filter(n => n && n.type === 'MPMObject3D');
            const domainCouplers = state.nodes.filter(n =>
                n.type === 'MPMContactCoupler3D' && (
                    state.connections.some(c => c.fromNode === n.id && c.toNode === mpmDomain.id) ||
                    n.parameters?.target_domain === mpmDomain.id
                )
            );
            const couplerIds = new Set(domainCouplers.map(c => c.id));
            const couplerObjNodes = state.connections
                .filter(c => couplerIds.has(c.toNode))
                .map(c => state.nodes.find(n => n.id === c.fromNode))
                .filter(n => n && n.type === 'MPMObject3D');
            let targetObjNodes: (Node | undefined)[] = [];
            const seenObjIds = new Set<string>();
            for (const o of [...directObjNodes, ...couplerObjNodes]) {
                if (o && !seenObjIds.has(o.id)) {
                    seenObjIds.add(o.id);
                    targetObjNodes.push(o);
                }
            }
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
                    const skipMatKeys = new Set(['visible', 'hidden', 'name', 'label', 'id']);
                    Object.entries(matNode.parameters).forEach(([k, v]) => {
                        if (!skipMatKeys.has(k)) {
                            objParams[k] = castParam(k, v);
                        }
                    });
                } else {
                    objParams['material_id'] = objNode.parameters?.material || ('mat_' + objNode.id);
                    objParams['material_name'] = objNode.parameters?.material || ('mat_' + objNode.id);
                }

                // Re-apply explicit objNode parameters to ensure geometric precedence over material defaults
                const nonConstitutiveKeys = [
                    'name', 'label', 'id', 'visible', 'hidden', 'shape', 'shape_type', 'pos_x', 'pos_y', 'pos_z',
                    'scale_x', 'scale_y', 'scale_z', 'rot_x', 'rot_y', 'rot_z',
                    'size_x', 'size_y', 'size_z', 'radius', 'inner_radius', 'height',
                    'vel_x', 'vel_y', 'vel_z', 'angular_vel_x', 'angular_vel_y', 'angular_vel_z',
                    'initial_velocity_x', 'initial_velocity_y', 'initial_velocity_z',
                    'ppc', 'particle_distribution', 'boundary_filling', 'origin_mode',
                    'voxelization_method', 'stl_file', 'stl_volume', 'velocity_group'
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
                if (matNode?.parameters?.['mixture_rule'] !== undefined) {
                    objParams['mixture_rule'] = matNode.parameters['mixture_rule'];
                } else if (objNode.parameters?.['mixture_rule'] !== undefined) {
                    objParams['mixture_rule'] = objNode.parameters['mixture_rule'];
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

                const domainTransferScheme = mpmDomain?.parameters?.transfer_scheme || 'BSpline';
                const objTransferScheme = objNode.parameters?.transfer_scheme;
                const matTransferScheme = matNode?.parameters?.transfer_scheme;
                if (objTransferScheme && objTransferScheme !== 'Default') {
                    objParams['transfer_scheme'] = objTransferScheme;
                } else if (matTransferScheme && matTransferScheme !== 'Default') {
                    objParams['transfer_scheme'] = matTransferScheme;
                } else if (domainTransferScheme && domainTransferScheme !== 'Default') {
                    objParams['transfer_scheme'] = domainTransferScheme;
                } else {
                    objParams['transfer_scheme'] = 'BSpline';
                }
                if (!objParams['particle_distribution'] && domainParticleDist) {
                    objParams['particle_distribution'] = domainParticleDist;
                }
                if (!objParams['boundary_filling'] && domainBoundaryFill) {
                    objParams['boundary_filling'] = domainBoundaryFill;
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

                // Resolve effective velocity_group from connected MPMContactCoupler3D or node parameter
                const couplerConn = state.connections.find(c => c.fromNode === objNode.id && state.nodes.some(n => n.id === c.toNode && n.type === 'MPMContactCoupler3D'));
                const couplerNode = couplerConn ? state.nodes.find(n => n.id === couplerConn.toNode) : undefined;
                if (couplerNode) {
                    const cMode = String(couplerNode.parameters?.coupler_mode || 'Bonded (Single-Velocity)');
                    if (cMode.includes('Independent')) {
                        objParams['velocity_group'] = 'Independent';
                    } else {
                        objParams['velocity_group'] = String(couplerNode.parameters?.coupler_group_tag || `Coupler_${couplerNode.id}`);
                    }
                } else {
                    objParams['velocity_group'] = String(objNode.parameters?.velocity_group || 'Independent (Auto)');
                }

                mpmObjects.push(objParams);
            }

            const isDetNode = (n: any) => n && (n.type === 'DetonatorLocation3D' || n.type === 'DetonatorLocation' || n.type === 'TriggerLocation3D' || n.type === 'TriggerLocation');
            const detConns = state.connections.filter(c => 
                ((c.toNode === mpmDomain.id || c.fromNode === mpmDomain.id) ||
                 targetObjNodes.some(o => o && (o.id === c.toNode || o.id === c.fromNode))) &&
                (c.toPort === 'detonator' || c.toPort === 'trigger' || c.toPort === 'detonators' || c.fromPort === 'detonator' || c.fromPort === 'trigger')
            );
            const detonators: any[] = [];
            for (const conn of detConns) {
                const otherId = (conn.toNode === mpmDomain.id || targetObjNodes.some(o => o && o.id === conn.toNode)) ? conn.fromNode : conn.toNode;
                const detNode = state.nodes.find(n => n.id === otherId && isDetNode(n));
                if (detNode && !detonators.some(d => d._id === detNode.id)) {
                    const detParams: any = { _id: detNode.id };
                    Object.entries(detNode.parameters).forEach(([key, value]) => {
                        detParams[key] = numericKeys.includes(key) ? Number(value) : (booleanKeys.includes(key) ? Boolean(value) : value);
                    });
                    const tDelay = Number(detParams.time_delay ?? detParams.detonator_time ?? detParams.start_time ?? 0.0);
                    detParams.time_delay = tDelay;
                    detParams.detonator_time = tDelay;
                    detParams.start_time = tDelay;
                    detParams.track_mpm_velocity = Boolean(detParams.track_mpm_velocity);
                    const targetObjNode = targetObjNodes.find(o => o && (o.id === conn.toNode || o.id === conn.fromNode) && o.id !== detNode.id);
                    if (targetObjNode) {
                        const objIdx = targetObjNodes.findIndex(o => o && o.id === targetObjNode.id) + 1;
                        if (objIdx > 0) detParams.target_object_id = objIdx;
                    }
                    detonators.push(detParams);
                }
            }
            if (detonators.length === 0) {
                const fallbackDets = state.nodes.filter(isDetNode);
                for (const detNode of fallbackDets) {
                    if (detonators.some(d => d._id === detNode.id)) continue;
                    const detParams: any = { _id: detNode.id };
                    Object.entries(detNode.parameters).forEach(([key, value]) => {
                        detParams[key] = numericKeys.includes(key) ? Number(value) : (booleanKeys.includes(key) ? Boolean(value) : value);
                    });
                    const tDelay = Number(detParams.time_delay ?? detParams.detonator_time ?? detParams.start_time ?? 0.0);
                    detParams.time_delay = tDelay;
                    detParams.detonator_time = tDelay;
                    detParams.start_time = tDelay;
                    detParams.track_mpm_velocity = Boolean(detParams.track_mpm_velocity);
                    detonators.push(detParams);
                }
            }
            if (detonators.length > 0) {
                flattenedParams['detonators'] = detonators.map(({ _id, ...rest }) => rest);
                flattenedParams['triggers'] = flattenedParams['detonators'];
                Object.entries(detonators[0]).forEach(([key, value]) => {
                    if (key !== '_id') flattenedParams[key] = value;
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
                const domainMesh = state.nodes.find(n => isDomainMesh3DNode(n.type) || n.type === 'DomainMesh');
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
                    const stlConn = state.connections.find(c => c.toNode === objNode.id && c.toPort === 'stl');
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
                    } else if (stlConn) {
                        const stlNode = state.nodes.find(n => n.id === stlConn.fromNode);
                        if (stlNode && stlNode.type === 'STLGeometry') {
                            objParams['stl_file'] = resolveResourcePath(stlNode.parameters.stl_file || '', modelFilename);
                            objParams['mesh_source'] = 'STL File';
                            objParams['shape_type'] = 'STL';
                            objParams['element_topology'] = 'Tet4_ANP';
                            if (stlNode.parameters.scale_x !== undefined && objNode.parameters.scale_x === undefined) objParams['scale_x'] = Number(stlNode.parameters.scale_x);
                            if (stlNode.parameters.scale_y !== undefined && objNode.parameters.scale_y === undefined) objParams['scale_y'] = Number(stlNode.parameters.scale_y);
                            if (stlNode.parameters.scale_z !== undefined && objNode.parameters.scale_z === undefined) objParams['scale_z'] = Number(stlNode.parameters.scale_z);
                            if (stlNode.parameters.rot_x !== undefined && objNode.parameters.rot_x === undefined) objParams['rot_x'] = Number(stlNode.parameters.rot_x);
                            if (stlNode.parameters.rot_y !== undefined && objNode.parameters.rot_y === undefined) objParams['rot_y'] = Number(stlNode.parameters.rot_y);
                            if (stlNode.parameters.rot_z !== undefined && objNode.parameters.rot_z === undefined) objParams['rot_z'] = Number(stlNode.parameters.rot_z);
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
                    const skipMatKeys = new Set([
                        'visible', 'hidden', 'name', 'label', 'id',
                        'pos_x', 'pos_y', 'pos_z', 'rot_x', 'rot_y', 'rot_z',
                        'scale_x', 'scale_y', 'scale_z', 'size_x', 'size_y', 'size_z',
                        'nx', 'ny', 'nz', 'shape', 'shape_type', 'stl_file', 'origin_mode'
                    ]);
                    Object.entries(matNode.parameters).forEach(([mk, mv]) => {
                        if (!skipMatKeys.has(mk)) {
                            objParams[mk] = numericKeys.includes(mk) ? Number(mv) : mv;
                        }
                    });
                }
                if (matNode?.parameters?.['material_model']) {
                    objParams['material_model'] = matNode.parameters['material_model'];
                } else if (!objParams['material_model']) {
                    objParams['material_model'] = objNode.parameters?.['material_model'] || 'Hypoelastic';
                }
                const shapeType = objParams['shape_type'] || (objParams['mesh_source'] === 'Cylinder Generator' ? 'Cylinder' : (objParams['mesh_source'] === 'STL File' ? 'STL' : (objParams['mesh_source'] === 'Plate Generator' ? 'Plate' : (objParams['mesh_source'] === 'LS-DYNA Keyword File' ? 'LS-DYNA File' : 'Box'))));
                objParams['shape_type'] = shapeType;
                objParams['mesh_source'] = shapeType === 'Cylinder' ? 'Cylinder Generator' : (shapeType === 'STL' ? 'STL File' : (shapeType === 'Plate' ? 'Plate Generator' : (shapeType === 'LS-DYNA File' ? 'LS-DYNA Keyword File' : 'Box Generator')));
                objParams['origin_mode'] = objParams['origin_mode'] || objNode.parameters?.origin_mode || 'Center';
                objParams['element_topology'] = objParams['element_topology'] || objNode.parameters?.element_topology || (shapeType === 'STL' ? 'Tet4_ANP' : 'Hex8');

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

                const setup = objNode.parameters?.['fem_setup'] || femDomain.parameters?.['fem_setup'] || syncModelFEMSetup(state, getLSDynaDeckMeta);
                if (setup) {
                    if (setup.parts && Array.isArray(setup.parts)) {
                        const primaryPart = setup.parts.find((p: any) => p.canvas_node_id === objNode.id || p.node_id === objNode.id || p.id === objNode.id || p.name === objNode.parameters?.name) || setup.parts[0];
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
                            if (objNode.parameters?.['element_topology']) {
                                objParams['element_topology'] = objNode.parameters['element_topology'];
                                primaryPart.element_topology = objParams['element_topology'];
                            } else if (primaryPart.element_topology) {
                                objParams['element_topology'] = primaryPart.element_topology;
                            }
                        }
                        objParams['fem_parts'] = setup.parts.map((p: any) => {
                            const isSelfPart = (setup.parts.length === 1 || p.canvas_node_id === objNode.id || p.node_id === objNode.id || p.id === objNode.id);
                            let mappedMatId: number | undefined = undefined;
                            const matDef = Array.isArray(setup.materials) ? setup.materials.find((m: any) => m.mat_id === p.material_id) : undefined;
                            if (matDef?.canvas_node_id && matIdMap.has(matDef.canvas_node_id)) {
                                mappedMatId = matIdMap.get(matDef.canvas_node_id);
                            } else if (typeof p.material_assignment === 'string') {
                                if (matIdMap.has(p.material_assignment)) {
                                    mappedMatId = matIdMap.get(p.material_assignment);
                                } else if (p.material_assignment.startsWith('DECK_MAT_')) {
                                    mappedMatId = canvasMats.length + parseInt(p.material_assignment.replace('DECK_MAT_', ''), 10) - 1;
                                }
                            } else if (typeof p.material_assignment === 'number') {
                                mappedMatId = p.material_assignment;
                            } else if (typeof p.material_id === 'number' && p.material_id >= 1) {
                                mappedMatId = Math.max(0, p.material_id - 1);
                            }
                            const secToTopo: Record<string, string> = {
                                'SolidHex8': 'Hex8', 'SolidHex8_SRI': 'Hex8_SRI', 'SolidHex8_Full': 'Hex8_Full',
                                'SolidTet4': 'Tet4', 'SolidTet4_ANP': 'Tet4_ANP', 'SolidWedge6': 'Wedge6',
                                'Shell4': 'Shell4', 'Beam3D': 'Beam3D', 'Truss1D': 'Truss1D'
                            };
                            return {
                                part_id: Number(p.part_id),
                                deck_part_id: p.deck_part_id !== undefined ? Number(p.deck_part_id) : Number(p.part_id),
                                canvas_node_id: p.canvas_node_id || '',
                                name: String(p.name || ''),
                                section_type: String(p.section_type || 'SolidHex8'),
                                thickness_or_area: Number(p.thickness_or_area ?? 0.01),
                                hourglass_coeff: Number(p.hourglass_coeff ?? 0.03),
                                suppressed: p.suppressed === true,
                                visible: p.visible !== false,
                                color: String(p.color || '#3b82f6'),
                                initial_velocity: Array.isArray(p.initial_velocity) ? p.initial_velocity.map(Number) : [0, 0, 0],
                                material_id: mappedMatId,
                                material_assignment: p.material_assignment,
                                failure_strain: p.erosion_override?.failure_strain !== undefined ? Number(p.erosion_override.failure_strain) : undefined,
                                convert_to_mpm: p.erosion_override?.convert_to_mpm === true,
                                shape_type: p.shape_type || objParams['shape_type'] || 'Box',
                                element_topology: secToTopo[p.section_type] || p.element_topology || objParams['element_topology'] || 'Hex8',
                                stl_file: p.stl_file || objParams['stl_file'] || '',
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
                            dofs: Array.isArray(bc.dofs)
                                ? bc.dofs.map(Boolean)
                                : [
                                    bc.dofs?.tx !== false,
                                    bc.dofs?.ty !== false,
                                    bc.dofs?.tz !== false,
                                    bc.dofs?.rx === true,
                                    bc.dofs?.ry === true,
                                    bc.dofs?.rz === true
                                  ],
                            velocity: Array.isArray(bc.values)
                                ? bc.values.map(Number)
                                : (Array.isArray(bc.velocity) ? bc.velocity.map(Number) : [0, 0, 0]),
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
            if (femObjects.length > 0) {
                if (femObjects[0]['fem_parts']) flattenedParams['fem_parts'] = femObjects[0]['fem_parts'];
                if (femObjects[0]['fem_sets']) flattenedParams['fem_sets'] = femObjects[0]['fem_sets'];
                if (femObjects[0]['boundary_conditions']) flattenedParams['boundary_conditions'] = femObjects[0]['boundary_conditions'];
                if (femObjects[0]['fem_contacts']) flattenedParams['fem_contacts'] = femObjects[0]['fem_contacts'];
                if (femObjects[0]['fem_materials']) flattenedParams['fem_materials'] = femObjects[0]['fem_materials'];
            }
            if (femDomain.parameters?.['merge_coincident_nodes'] !== undefined) {
                flattenedParams['merge_coincident_nodes'] = Boolean(femDomain.parameters['merge_coincident_nodes']);
            }
            if (femDomain.parameters?.['node_merge_tolerance'] !== undefined) {
                flattenedParams['node_merge_tolerance'] = Number(femDomain.parameters['node_merge_tolerance']);
            }
            if (femDomain.parameters?.['embedded_rebar_coupling'] !== undefined) {
                flattenedParams['embedded_rebar_coupling'] = Boolean(femDomain.parameters['embedded_rebar_coupling']);
            }

            const detConns = state.connections.filter(c => c.toNode === femDomain.id && (c.toPort === 'detonator' || c.toPort === 'trigger'));
            const detonators: any[] = [];
            for (const conn of detConns) {
                const detNode = state.nodes.find(n => n.id === conn.fromNode);
                if (detNode && (detNode.type === 'DetonatorLocation3D' || detNode.type === 'DetonatorLocation' || detNode.type === 'TriggerLocation3D' || detNode.type === 'TriggerLocation')) {
                    const detParams: any = {};
                    Object.entries(detNode.parameters).forEach(([key, value]) => {
                        detParams[key] = numericKeys.includes(key) ? Number(value) : (booleanKeys.includes(key) ? Boolean(value) : value);
                    });
                    if (detParams.time_delay === undefined && detParams.detonator_time !== undefined) detParams.time_delay = detParams.detonator_time;
                    if (detParams.detonator_time === undefined && detParams.time_delay !== undefined) detParams.detonator_time = detParams.time_delay;
                    detonators.push(detParams);
                }
            }
            if (detonators.length === 0) {
                const fallbackDets = state.nodes.filter(n => n.type === 'DetonatorLocation3D' || n.type === 'DetonatorLocation' || n.type === 'TriggerLocation3D' || n.type === 'TriggerLocation');
                for (const detNode of fallbackDets) {
                    const detParams: any = {};
                    Object.entries(detNode.parameters).forEach(([key, value]) => {
                        detParams[key] = numericKeys.includes(key) ? Number(value) : (booleanKeys.includes(key) ? Boolean(value) : value);
                    });
                    if (detParams.time_delay === undefined && detParams.detonator_time !== undefined) detParams.time_delay = detParams.detonator_time;
                    if (detParams.detonator_time === undefined && detParams.time_delay !== undefined) detParams.detonator_time = detParams.time_delay;
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
        const remapNode3D = remapConn3D ? state.nodes.find(n => n.id === remapConn3D.fromNode) : state.nodes.find(n => n.type === 'Remap1DTo3DNode' || n.type === 'Remap2DTo3DNode' || n.type === 'Remap3DTo3DNode');
        if (remapNode3D) {
            inheritRemap3DUpstream(state, remapNode3D, solverNode3D, modelId, flattenedParams, numericKeys, booleanKeys);
        } else if (solverNode3D?.type === 'MarineHarbourDomain') {
            flattenedParams['init_mode'] = 'Hydrostatic_Stratified_3D';
        } else if (!flattenedParams['init_mode'] || flattenedParams['init_mode'] === 'From1D' || flattenedParams['init_mode'] === 'From2D' || flattenedParams['init_mode'] === 'From3D') {
            if (flattenedParams['explosive_type'] === 'MaterialIdealGas') {
                flattenedParams['init_mode'] = 'Ideal Gas';
            } else {
                flattenedParams['init_mode'] = 'Multi-Material JWL';
            }
        }
        // Strict primary solver precedence (Directive 11 & 12)
        if (solverNode3D && solverNode3D.parameters) {
            if (solverNode3D.parameters.device !== undefined) flattenedParams['device'] = solverNode3D.parameters.device;
            if (solverNode3D.parameters.precision !== undefined) flattenedParams['precision'] = solverNode3D.parameters.precision;
            if (solverNode3D.parameters.cfl !== undefined) flattenedParams['cfl'] = Number(solverNode3D.parameters.cfl);
            if (solverNode3D.parameters.endtime !== undefined) flattenedParams['endtime'] = Number(solverNode3D.parameters.endtime);
            if (solverNode3D.parameters.flux_scheme !== undefined) flattenedParams['flux_scheme'] = solverNode3D.parameters.flux_scheme;
            if (solverNode3D.parameters.space_time_scheme !== undefined) flattenedParams['space_time_scheme'] = solverNode3D.parameters.space_time_scheme;
        }
        if (!flattenedParams['device']) flattenedParams['device'] = 'cpu';
        if (!flattenedParams['flux_scheme']) flattenedParams['flux_scheme'] = 'AUSM+';
        if (flattenedParams['space_time_scheme']) {
            const sts = flattenedParams['space_time_scheme'];
            if (sts === 'ADER-2 (2nd-Order Space/Time)') {
                flattenedParams['spatial_order'] = 2;
                flattenedParams['temporal_order'] = 2;
            } else if (sts === 'ADER-3 (3rd-Order Space/Time)') {
                flattenedParams['spatial_order'] = 3;
                flattenedParams['temporal_order'] = 3;
            } else if (sts === 'MUSCL-Hancock (2nd-Order Space/Time)') {
                flattenedParams['spatial_order'] = 2;
                flattenedParams['temporal_order'] = 2;
            }
        }
        if (flattenedParams['spatial_order'] === undefined) flattenedParams['spatial_order'] = 2;
        if (flattenedParams['temporal_order'] === undefined) flattenedParams['temporal_order'] = 2;
        if (!flattenedParams['precision']) flattenedParams['precision'] = 'single';
    }

    // Fallback: If VTKOutput node is in the graph, ensure its parameters are included even without direct wire
    const anyVtkNode = state.nodes.find(n => n.type === 'VTKOutput');
    if (anyVtkNode && anyVtkNode.parameters) {
        if (flattenedParams['enable_vtk'] === undefined) {
            flattenedParams['enable_vtk'] = 'Enabled';
        }
        Object.entries(anyVtkNode.parameters).forEach(([key, value]) => {
            if (flattenedParams[key] === undefined) {
                flattenedParams[key] = numericKeys.includes(key) ? Number(value) : value;
            }
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
        if (flattenedParams['gauge_stride_steps'] === undefined) {
            flattenedParams['gauge_stride_steps'] = Number(anyGaugeNode.parameters.sampling_stride_steps || 1);
        }
        if (flattenedParams['sampling_stride_steps'] === undefined) {
            flattenedParams['sampling_stride_steps'] = Number(anyGaugeNode.parameters.sampling_stride_steps || 1);
        }
        if (flattenedParams['pinned_gauge_ids'] === undefined) {
            flattenedParams['pinned_gauge_ids'] = anyGaugeNode.parameters.pinned_probe_ids || [];
        }
        if (sourceMode === 'manual' && (!flattenedParams['gauges'] || (Array.isArray(flattenedParams['gauges']) && flattenedParams['gauges'].length === 0))) {
            flattenedParams['gauges'] = anyGaugeNode.parameters.gauges || [];
        }
        const fallbackGaugeExportAndQtyKeys: string[] = [
            'export_ascii', 'export_binary', 'export_hdf5', 'ascii_delimiter', 'ascii_precision',
            'include_header', 'custom_filename', 'output_dir',
            'qty_pressure', 'qty_overpressure', 'qty_impulse', 'qty_density', 'qty_velocity', 'qty_energy',
            'qty_reacted', 'qty_unreacted', 'qty_air', 'qty_water', 'qty_soil', 'qty_materials',
            'qty_mpm_pressure', 'qty_mpm_material_id', 'qty_mpm_object_id', 'qty_mpm_particle_density'
        ];
        fallbackGaugeExportAndQtyKeys.forEach((k: string) => {
            if (anyGaugeNode.parameters[k] !== undefined && flattenedParams[k] === undefined) {
                flattenedParams[k] = castParam(k, anyGaugeNode.parameters[k]);
            }
        });
    }

    // Fallback: If gauges are embedded directly on a Domain Mesh node without a standalone VirtualGauges node, serialize them
    if (!flattenedParams['gauges'] || (Array.isArray(flattenedParams['gauges']) && flattenedParams['gauges'].length === 0)) {
        const domainGaugeNode = state.nodes.find(n =>
            (n.type === 'DomainMesh' || n.type === 'DomainMesh2D' || n.type === 'SparseDomainMesh2D' ||
             n.type === 'DomainMesh3D' || n.type === 'SparseDomainMesh3D' || n.type === 'MarineHarbourDomain' ||
             n.type === 'MPMDomain2D' || n.type === 'MPMDomain3D') &&
            Array.isArray(n.parameters?.gauges) && n.parameters.gauges.length > 0
        );
        if (domainGaugeNode && domainGaugeNode.parameters) {
            flattenedParams['gauges'] = domainGaugeNode.parameters.gauges;
            if (flattenedParams['gauge_source_mode'] === undefined) {
                flattenedParams['gauge_source_mode'] = 'manual';
            }
        }
    }

    // Auto-mirror downstream Stage 2 (2D/3D Remap) VirtualGauges radial probes into 1D Stage 1 INIT
    // so Stage 1 seamlessly captures exact [0, t_remap) early-time waveforms without mutating Stage 1's UI node.
    if (command === "INIT" && modelId) {
        const globalSM = (typeof window !== 'undefined' && (window as any).stateManager) ? (window as any).stateManager : null;
        if (globalSM && typeof globalSM.getAllModels === 'function') {
            const allModels = globalSM.getAllModels() || [];
            const ws = globalSM.getActiveWorkspace?.();
            const domainRadius = Number(flattenedParams['domain_radius'] ?? 1.0);
            const baseGauges = Array.isArray(flattenedParams['gauges']) ? [...flattenedParams['gauges']] : [];
            const existingIds = new Set<string>(
                baseGauges.map((g: any, idx: number) => String(g.id || g.name || `G${idx + 1}`))
            );
            let appendedAny = false;

            for (const m of allModels) {
                if (!m || m.id === modelId || !Array.isArray(m.nodes)) continue;
                const remapNodes = m.nodes.filter((n: any) =>
                    n.type === 'RemapNode' || n.type === 'Remap1DTo2DNode' || n.type === 'Remap1DTo3DNode'
                );
                for (const rNode of remapNodes) {
                    let isLinkedToThis1D = rNode.parameters?.source_model_id === modelId;
                    if (!isLinkedToThis1D && ws && Array.isArray(ws.connections)) {
                        const wsConn = ws.connections.find((c: any) => c.toNode === rNode.id);
                        if (wsConn && state.nodes.some(sn => sn.id === wsConn.fromNode)) {
                            isLinkedToThis1D = true;
                        }
                    }
                    if (!isLinkedToThis1D) continue;

                    const dsGaugeNode = m.nodes.find((n: any) => n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D');
                    const dsDomainGaugeNode = m.nodes.find((n: any) =>
                        (n.type === 'DomainMesh2D' || n.type === 'SparseDomainMesh2D' ||
                         n.type === 'DomainMesh3D' || n.type === 'SparseDomainMesh3D' ||
                         n.type === 'MarineHarbourDomain' || n.type === 'MPMDomain2D' || n.type === 'MPMDomain3D') &&
                        Array.isArray(n.parameters?.gauges) && n.parameters.gauges.length > 0
                    );
                    const dsGauges: any[] = (dsGaugeNode && (dsGaugeNode.parameters?.source_mode || 'manual') === 'manual')
                        ? (dsGaugeNode.parameters?.gauges || [])
                        : (dsDomainGaugeNode?.parameters?.gauges || []);
                    if (!Array.isArray(dsGauges) || dsGauges.length === 0) continue;

                    const is3DRemap = rNode.type === 'Remap1DTo3DNode';
                    const bx = Number(rNode.parameters?.explosive_x ?? 0.5);
                    const by = Number(rNode.parameters?.explosive_y ?? 0.5);
                    const bz3 = Number(rNode.parameters?.explosive_z ?? 0.5);
                    const br2 = Number(rNode.parameters?.explosive_r ?? 0.0);
                    const bz2 = Number(rNode.parameters?.explosive_z ?? 0.1);

                    dsGauges.forEach((g: any, idx: number) => {
                        const gId = String(g.id || g.name || `G${idx + 1}`);
                        if (existingIds.has(gId)) return;
                        let rStandoff = -1;
                        if (is3DRemap) {
                            const dx = Number(g.x ?? 0.5) - bx;
                            const dy = Number(g.y ?? 0.5) - by;
                            const dz = Number(g.z ?? 0.5) - bz3;
                            rStandoff = Math.hypot(dx, dy, dz);
                        } else {
                            const gr = Number(g.r ?? g.x ?? 0.0);
                            const gz = Number(g.z ?? g.y ?? 0.0);
                            rStandoff = Math.hypot(gr - br2, gz - bz2);
                        }
                        if (Number.isFinite(rStandoff) && rStandoff >= 0 && rStandoff <= domainRadius) {
                            baseGauges.push({
                                id: gId,
                                name: g.name || gId,
                                r: rStandoff,
                                x: rStandoff,
                                y: 0,
                                z: 0
                            });
                            existingIds.add(gId);
                            appendedAny = true;
                        }
                    });
                }
            }

            if (appendedAny) {
                flattenedParams['gauges'] = baseGauges;
                if (flattenedParams['gauge_source_mode'] === undefined) {
                    flattenedParams['gauge_source_mode'] = 'manual';
                }
            }
        }
    }

    // Normalize relative output directories (vtk_dir, output_dir) against the saved model path
    if (typeof flattenedParams['vtk_dir'] === 'string' && flattenedParams['vtk_dir'].trim() !== '') {
        flattenedParams['vtk_dir'] = resolveResourcePath(flattenedParams['vtk_dir'], modelFilename);
    } else if (flattenedParams['enable_vtk'] === 'Enabled' && modelFilename && modelFilename.includes('/')) {
        flattenedParams['vtk_dir'] = resolveResourcePath('./vtk_output', modelFilename);
    }

    if (typeof flattenedParams['output_dir'] === 'string' && flattenedParams['output_dir'].trim() !== '') {
        flattenedParams['output_dir'] = resolveResourcePath(flattenedParams['output_dir'], modelFilename);
    } else if (modelFilename && modelFilename.includes('/')) {
        flattenedParams['output_dir'] = resolveResourcePath('.', modelFilename);
    }

    if (state.refresh_rate !== undefined && !isNaN(Number(state.refresh_rate)) && Number(state.refresh_rate) > 0) {
        const rate = Number(state.refresh_rate);
        flattenedParams['refresh_rate'] = rate;
        flattenedParams['telemetry_interval_ms'] = Math.max(16, Math.round(rate * 1000));
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

export function serializeToBinary(payload: SimulationState | Record<string, any>): ArrayBuffer {
    const jsonString = JSON.stringify(payload);
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

export function deserializeFromBinary(buffer: ArrayBuffer): SimulationState & Record<string, any> {
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
    return JSON.parse(jsonString) as SimulationState & Record<string, any>;
}
