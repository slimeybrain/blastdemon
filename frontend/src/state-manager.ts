import { SimulationState, SimulationStatus, LayoutNode, PanelNode, SplitNode, LayoutDirection, PanelType, Model, Workspace, AppState, Node, Connection, NodeType, Port, ModelViewConfig, ModelViewCamera, ModelViewSlice, ModelViewToggles } from './types.js';
import { MPM_MATERIAL_PRESETS, getPresetsForConstitutiveModel, getDefaultPresetForModel } from './mpm-presets.js';

export function syncMPMMaterialParameters(node: Node, parameters: Record<string, any>, updatedKey?: string): void {
    if (node.type !== 'Material' && (node.type as any) !== 'MPMMaterialSteel' && (node.type as any) !== 'MPMMaterial' && (node.type as any) !== 'MaterialSteel') {
        return;
    }
    if (node.type !== 'Material') {
        node.type = 'Material';
    }

    // Normalize material_model from legacy material_type if not explicitly set
    if (parameters['material_model'] === undefined) {
        const legacyType = parameters['material_type'];
        if (legacyType === 'Air') {
            parameters['material_model'] = 'Ideal Gas';
        } else if (legacyType === 'JWL Charge') {
            parameters['material_model'] = 'JWL Detonation Gas';
        } else if (legacyType === 'Ideal Gas Charge') {
            parameters['material_model'] = 'Ideal Gas Charge';
        } else {
            parameters['material_model'] = 'Hypoelastic';
        }
    } else if (parameters['material_model'] === 'JWL Charge') {
        parameters['material_model'] = 'JWL Detonation Gas';
    } else if (parameters['material_model'] === 'Air') {
        parameters['material_model'] = 'Ideal Gas';
    }

    const modelName = parameters['material_model'];
    const validPresets = getPresetsForConstitutiveModel(modelName);

    // 1. High-Explosive JWL Detonation Gas
    if (modelName === 'JWL Detonation Gas') {
        parameters['material_type'] = 'JWL Charge';

        // Check if preset is valid or needs defaulting
        if (!parameters['preset'] || !validPresets.includes(parameters['preset'])) {
            const comp = parameters['composition'];
            if (comp && MPM_MATERIAL_PRESETS[comp]) {
                parameters['preset'] = comp;
            } else {
                parameters['preset'] = 'TNT (Trinitrotoluene)';
            }
        }

        const currentPreset = parameters['preset'];
        if (updatedKey === 'material_model' || updatedKey === 'preset' || (updatedKey === undefined && currentPreset !== 'Custom')) {
            if (currentPreset !== 'Custom' && MPM_MATERIAL_PRESETS[currentPreset]) {
                const pData = MPM_MATERIAL_PRESETS[currentPreset];
                for (const [k, v] of Object.entries(pData)) {
                    if (k !== 'reference' && k !== 'category') parameters[k] = v;
                }
                if (pData.composition) {
                    parameters['composition'] = pData.composition;
                }
            }
        }

        // Enforce guaranteed defaults for JWL parameters
        if (parameters['rho'] === undefined) parameters['rho'] = 1630.0;
        if (parameters['detonation_energy'] === undefined) parameters['detonation_energy'] = 4.29e6;
        if (parameters['det_vel'] === undefined) parameters['det_vel'] = 6930.0;
        if (parameters['jwl_A'] === undefined) parameters['jwl_A'] = 373.77e9;
        if (parameters['jwl_B'] === undefined) parameters['jwl_B'] = 3.747e9;
        if (parameters['jwl_R1'] === undefined) parameters['jwl_R1'] = 4.15;
        if (parameters['jwl_R2'] === undefined) parameters['jwl_R2'] = 0.90;
        if (parameters['jwl_omega'] === undefined) parameters['jwl_omega'] = 0.35;
        if (!parameters['composition']) parameters['composition'] = 'TNT';

        const jwlKeys = ['rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'];
        if (updatedKey && jwlKeys.includes(updatedKey)) {
            parameters['preset'] = 'Custom';
        }
        return;
    }

    // 2. Atmospheric & Ambient Air (Ideal Gas EOS)
    if (modelName === 'Ideal Gas') {
        parameters['material_type'] = 'Air';

        if (!parameters['preset'] || !validPresets.includes(parameters['preset'])) {
            parameters['preset'] = 'Air (Standard STP, gamma=1.4)';
        }

        const currentPreset = parameters['preset'];
        if (updatedKey === 'material_model' || updatedKey === 'preset' || (updatedKey === undefined && currentPreset !== 'Custom')) {
            if (currentPreset !== 'Custom' && MPM_MATERIAL_PRESETS[currentPreset]) {
                const pData = MPM_MATERIAL_PRESETS[currentPreset];
                for (const [k, v] of Object.entries(pData)) {
                    if (k !== 'reference' && k !== 'category') parameters[k] = v;
                }
            }
        }

        if (parameters['atm_pressure'] === undefined) parameters['atm_pressure'] = 101325.0;
        if (parameters['atm_temperature'] === undefined) parameters['atm_temperature'] = 288.15;
        if (parameters['gamma'] === undefined) parameters['gamma'] = 1.4;

        if (updatedKey === 'atm_pressure' || updatedKey === 'atm_temperature' || parameters['density'] === undefined) {
            parameters['density'] = parameters['atm_pressure'] / (287.058 * parameters['atm_temperature']);
        }
        parameters['ambient_p'] = parameters['atm_pressure'];
        parameters['ambient_rho'] = parameters['density'];

        const airKeys = ['atm_pressure', 'atm_temperature', 'gamma', 'density'];
        if (updatedKey && airKeys.includes(updatedKey)) {
            parameters['preset'] = 'Custom';
        }
        return;
    }

    // 3. Ideal Gas Blast Charge
    if (modelName === 'Ideal Gas Charge') {
        parameters['material_type'] = 'Ideal Gas Charge';

        if (!parameters['preset'] || !validPresets.includes(parameters['preset'])) {
            parameters['preset'] = 'TNT (Ideal Gas Equivalent)';
        }

        const currentPreset = parameters['preset'];
        if (updatedKey === 'material_model' || updatedKey === 'preset' || (updatedKey === undefined && currentPreset !== 'Custom')) {
            if (currentPreset !== 'Custom' && MPM_MATERIAL_PRESETS[currentPreset]) {
                const pData = MPM_MATERIAL_PRESETS[currentPreset];
                for (const [k, v] of Object.entries(pData)) {
                    if (k !== 'reference' && k !== 'category') parameters[k] = v;
                }
                if (pData.composition) {
                    parameters['composition'] = pData.composition;
                }
            }
        }

        if (parameters['ideal_rho_0'] === undefined) parameters['ideal_rho_0'] = 1630.0;
        if (parameters['ideal_e_0'] === undefined) parameters['ideal_e_0'] = 4.29e6;
        if (parameters['ideal_gamma'] === undefined) parameters['ideal_gamma'] = 1.4;
        if (!parameters['composition']) parameters['composition'] = 'TNT';

        const igKeys = ['ideal_rho_0', 'ideal_e_0', 'ideal_gamma'];
        if (updatedKey && igKeys.includes(updatedKey)) {
            parameters['preset'] = 'Custom';
        }
        return;
    }

    // 4. Solid Continuum Mechanics (MPM & FEM)
    delete parameters['material_type'];
    delete parameters['composition'];

    if (!parameters['preset'] || !validPresets.includes(parameters['preset'])) {
        parameters['preset'] = getDefaultPresetForModel(modelName);
    }

    const presetName = parameters['preset'];
    if (updatedKey === 'material_model' || updatedKey === 'preset' || (updatedKey === undefined && presetName !== 'Custom')) {
        if (presetName !== 'Custom' && MPM_MATERIAL_PRESETS[presetName]) {
            const presetData = MPM_MATERIAL_PRESETS[presetName];
            for (const [k, v] of Object.entries(presetData)) {
                if (k !== 'reference' && k !== 'category') {
                    parameters[k] = v;
                }
            }
        }
    } else {
        const materialKeys = [
            'transfer_scheme', 'enable_heterogeneity', 'weibull_modulus', 'weibull_scale', 'fracture_toughness', 'debris_bulk_factor',
            'enable_anisotropy', 'anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z',
            'dem_transition_enabled', 'fragment_distribution', 'fragment_min_size', 'fragment_max_size', 'fragment_weibull_n', 'fragment_clumping_radius', 'fragment_ejection_jitter', 'fragment_contact_friction', 'fragment_restitution',
            'density', 'youngs_modulus', 'poissons_ratio', 'yield_stress', 'hardening_modulus',
            'failure_strain', 'tensile_failure_stress',
            'jc_A', 'jc_B', 'jc_n', 'jc_C', 'jc_m',
            'jc_d1', 'jc_d2', 'jc_d3', 'jc_d4', 'jc_d5', 'T_melt', 'T_room', 'Cp',
            'fc', 'ft', 'G_f', 'moisture_content', 'dif_cap_compression', 'dif_cap_tension',
            'rht_A', 'rht_N', 'rht_B', 'rht_M', 'rht_Q0', 'rht_BQ', 'rht_D1', 'rht_D2',
            'rht_p_crush', 'rht_p_lock', 'rht_alpha0', 'rht_n_comp', 'rht_betac', 'rht_deltat',
            'kc_auto_generate', 'kc_a0', 'kc_a1', 'kc_a2', 'kc_a0y', 'kc_a1y', 'kc_a2y', 'kc_a1r', 'kc_a2r', 'kc_b1', 'kc_omega',
            'cscm_alpha', 'cscm_theta', 'cscm_lambda', 'cscm_beta', 'cscm_R', 'cscm_X0', 'cscm_W', 'cscm_D1', 'cscm_D2',
            'davis_c0', 'davis_s1', 'davis_gamma0', 'davis_cv', 'davis_t0', 'davis_rho0',
            'davis_a', 'davis_b', 'davis_k', 'davis_vc', 'davis_pc', 'davis_q_det',
            'crest_b1', 'crest_c1', 'crest_m1', 'crest_b2', 'crest_c2', 'crest_c3', 'crest_m2', 'crest_s0', 'crest_s_threshold',
            'directional_crack_band', 'nonlocal_radius'
        ];
        if (updatedKey && materialKeys.includes(updatedKey)) {
            parameters['preset'] = 'Custom';
        }
    }

    if (parameters['transfer_scheme'] === undefined) parameters['transfer_scheme'] = 'BSpline';
    if (parameters['enable_heterogeneity'] === undefined) parameters['enable_heterogeneity'] = false;
    if (parameters['weibull_modulus'] === undefined) parameters['weibull_modulus'] = 0.0;
    if (parameters['weibull_scale'] === undefined) parameters['weibull_scale'] = 1.0;
    if (parameters['fracture_toughness'] === undefined) parameters['fracture_toughness'] = 0.0;
    if (parameters['debris_bulk_factor'] === undefined) parameters['debris_bulk_factor'] = 0.1;
    if (parameters['dem_transition_enabled'] === undefined) parameters['dem_transition_enabled'] = true;
    if (parameters['fragment_distribution'] === undefined) parameters['fragment_distribution'] = 'Rosin-Rammler';
    if (parameters['fragment_min_size'] === undefined) parameters['fragment_min_size'] = 0.002;
    if (parameters['fragment_max_size'] === undefined) parameters['fragment_max_size'] = 0.040;
    if (parameters['fragment_weibull_n'] === undefined) parameters['fragment_weibull_n'] = 1.80;
    if (parameters['fragment_clumping_radius'] === undefined) parameters['fragment_clumping_radius'] = 0.015;
    if (parameters['fragment_ejection_jitter'] === undefined) parameters['fragment_ejection_jitter'] = 0.35;
    if (parameters['fragment_contact_friction'] === undefined) parameters['fragment_contact_friction'] = 0.55;
    if (parameters['fragment_restitution'] === undefined) parameters['fragment_restitution'] = 0.30;
    if (parameters['jc_d1'] === undefined) parameters['jc_d1'] = 0.0;
    if (parameters['jc_d2'] === undefined) parameters['jc_d2'] = 0.0;
    if (parameters['jc_d3'] === undefined) parameters['jc_d3'] = 0.0;
    if (parameters['jc_d4'] === undefined) parameters['jc_d4'] = 0.0;
    if (parameters['jc_d5'] === undefined) parameters['jc_d5'] = 0.0;
}

export function syncFEMObjectParameters(node: Node, parameters: Record<string, any>, _updatedKey?: string): void {
    if (node.type !== 'FEMObject3D') {
        return;
    }

    if (!parameters['mesh_source']) {
        parameters['mesh_source'] = 'Box Generator';
    }

    const src = parameters['mesh_source'];
    if (src === 'Cylinder Generator') {
        parameters['shape_type'] = 'Cylinder';
    } else if (src === 'LS-DYNA Keyword File') {
        parameters['shape_type'] = 'LS-DYNA File';
    } else {
        parameters['mesh_source'] = 'Box Generator';
        parameters['shape_type'] = 'Box';
    }
}

export function isExplosiveMaterialNode(node: Node | undefined): boolean {
    if (!node || node.type !== 'Material') return false;
    const type = node.parameters?.material_type;
    const model = node.parameters?.material_model;
    if (type === 'JWL Charge' || type === 'Ideal Gas Charge') return true;
    if (model === 'JWL Detonation Gas' || model === 'Ideal Gas Charge' || model === 'CREST Reactive High Explosive') return true;
    if (type === 'Air' || model === 'Ideal Gas') return false;
    const comp = String(node.parameters?.composition || '').toLowerCase();
    const preset = String(node.parameters?.preset || '').toLowerCase();
    const explosiveNames = ['tnt', 'c-4', 'c4', 'comp b', 'composition b', 'petn', 'hmx', 'rdx', 'pbx', 'anfo', 'ammonal', 'tritonal', 'pentolite', 'semtex', 'tetryl', 'emulsion', 'nitromethane', 'nm'];
    if (explosiveNames.some(e => comp.includes(e) || preset.includes(e))) {
        return true;
    }
    return false;
}

export function isSolidMaterialNode(node: Node | undefined): boolean {
    if (!node || node.type !== 'Material') return false;
    const type = node.parameters?.material_type;
    const model = node.parameters?.material_model;
    if (type === 'Air' || type === 'JWL Charge' || type === 'Ideal Gas Charge') return false;
    if (model === 'Ideal Gas' || model === 'JWL Detonation Gas' || model === 'Ideal Gas Charge') return false;
    return true;
}

export function getCompatibleMaterialsForNode(targetNode: Node, candidateNodes: Node[]): Node[] {
    const isCharge = ['Charge1D', 'Charge2D', 'Charge3D'].includes(targetNode.type);
    const isSolid = ['MPMObject2D', 'MPMObject3D', 'FEMObject3D'].includes(targetNode.type);
    const currentMatId = targetNode.parameters?.material;

    return candidateNodes.filter(n => {
        if (n.type !== 'Material') return false;
        if (currentMatId && n.id === currentMatId) return true;
        if (isCharge) return isExplosiveMaterialNode(n);
        if (isSolid) return isSolidMaterialNode(n);
        return true;
    });
}

const HARDWARE_TARGET_NODE_TYPES = new Set([
    'CFDSolver3D',
    'FEMDomain3D',
    'MPMDomain3D',
    'HardwareConfig',
    'CFDSolver2D',
    'MPMDomain2D'
]);

export function syncCoupledHardwareParameters(model: Model, updatedNode: Node, updatedKey?: string): boolean {
    if (!HARDWARE_TARGET_NODE_TYPES.has(updatedNode.type)) {
        return false;
    }
    if (updatedKey !== 'device' && updatedKey !== 'precision' && updatedKey !== undefined) {
        return false;
    }

    const deviceVal = updatedNode.parameters['device'];
    const precVal = updatedNode.parameters['precision'];
    let changed = false;

    for (const node of model.nodes) {
        if (node.id === updatedNode.id) continue;
        if (HARDWARE_TARGET_NODE_TYPES.has(node.type)) {
            if (deviceVal !== undefined && node.parameters['device'] !== undefined && node.parameters['device'] !== deviceVal) {
                node.parameters['device'] = deviceVal;
                changed = true;
            }
            if (precVal !== undefined && node.parameters['precision'] !== undefined && node.parameters['precision'] !== precVal) {
                node.parameters['precision'] = precVal;
                changed = true;
            }
        }
    }
    return changed;
}


export const NON_PHYSICAL_NODE_TYPES = new Set<string>([
    'TelemetryText',
    'TelemetryGraph',
    'TelemetryContour',
    'Telemetry3DViewport',
    'VirtualGauges',
    'VirtualGauges3D',
    'VirtualGauge'
]);

export const DISPLAY_ONLY_KEYS = new Set([
    // Meta / Identification / UI state
    'name', 'label', 'description', 'title', 'active', 'enabled', 'visible', 'visibility',
    'show', 'disabled', 'selected', 'collapsed', 'displayMode', 'highlighted',
    'is_selected', 'is_active', 'is_visible', 'hidden', 'representation_mode',

    // Colormaps & Fields
    'colormap', 'quantity_colormaps', 'quantity_ranges', 'quantity_log_scales', 'quantity_auto_scales', 'lock_quantity_ranges', 'locked_quantities', 'focusedQuantity', 'quantity',
    'active_quantity', 'colorbar_source', 'show_color_bar', 'showColorbar',
    'color_bar_position', 'color', 'colormap_preset',

    // Ranges & Scaling
    'min_val', 'max_val', 'minVal', 'maxVal', 'min_y', 'max_y',
    'auto_scale', 'autoScale', 'auto_range', 'log_scale', 'logScale', 'interpolate',

    // Slices
    'slices', 'focusedSliceIndex', 'selectedSliceIndex', 'selected_slice',
    'selected_slice_index', 'active_slice_index', 'slice_plane', 'slice_offset', 'slice_axis',

    // Grid & Meshes
    'show_grid', 'show_grid_box', 'grid_meshlines', 'grid_opacity', 'cell_edges',
    'show_grid_user_enabled', 'show_grid_box_user_enabled', 'show_gridlines', 'showMeshLines',
    'show_mesh', 'gridlines', 'gridBox', 'grid_box',

    // Shading & Lighting
    'lightingEnabled', 'aoEnabled', 'ambientLevel', 'specularIntensity', 'aoRadius', 'aoIntensity', 'aoBias', 'aoSphereImpostor',
    'shading_mode', 'wireframe_mode', 'lighting_mode',

    // Obstacles Display
    'show_obstacles', 'obstacles_colormap', 'obstacles_gridlines', 'obstacles_solid',
    'obstacles_lighting', 'obstacles_opacity', 'obstacles_quantity', 'obstacles_auto_scale',
    'obstacles_log_scale', 'obstacles_show_colorbar', 'obstacles_interpolate',
    'obstacles_min_val', 'obstacles_max_val',

    // STL / CAD Display
    'show_stl', 'stl_colormap', 'stl_wireframe', 'stl_solids', 'stl_opacity',
    'stl_show_results', 'stl_quantity', 'stl_sampling_mode', 'stl_auto_scale',
    'stl_log_scale', 'stl_show_colorbar', 'stl_min_val', 'stl_max_val',

    // MPM Display
    'showMPMParticles', 'mpmParticleDiameter', 'mpmParticleSize', 'mpmParticleQuantity', 'mpmParticleColormap',
    'mpmParticleAutoScale', 'mpmParticleLogScale', 'mpmParticleShowColorbar',
    'mpmParticleOpacity', 'mpmParticleMinVal', 'mpmParticleMaxVal', 'mpmParticleWireframe',

    // FEM Display
    'showFEMMesh', 'femSolid', 'femWireframe', 'femResults', 'femQuantity',
    'femColormap', 'femOpacity', 'femLighting', 'femAutoScale', 'femLogScale',
    'femShowColorbar', 'femMinVal', 'femMaxVal',

    // Beams & Rebar Display
    'showBeams', 'showRebar', 'beamSolid', 'beamWireframe', 'rebarSolid', 'rebarWireframe',
    'beamOpacity', 'rebarOpacity', 'beamRadius', 'rebarRadius', 'beamQuantity', 'beamColormap',
    'beamAutoScale', 'beamLogScale', 'beamMinVal', 'beamMaxVal',

    // Charge Display
    'show_charge', 'charge_solid', 'charge_wireframe', 'charge_lighting', 'charge_opacity', 'chargeColor', 'charge_color',

    // Detonator Display
    'show_detonators', 'show_detonator', 'detonator_solid', 'detonators_solid', 'detonator_wireframe', 'detonators_wireframe',
    'detonator_lighting', 'detonators_lighting', 'detonator_size', 'detonators_size', 'detonator_opacity', 'detonators_opacity',
    'detonatorSolid', 'detonatorWireframe', 'detonatorLighting', 'detonatorSize', 'detonatorOpacity',

    // Virtual Gauges & Probes
    'show_gauges', 'gauge_size', 'gauge_opacity', 'gauge_quantity', 'gauge_solid',
    'gauges', 'selected_probe_id', 'active_probe_id',

    // Camera & Navigation
    'camera_pos', 'camera_target', 'camera_mode', 'persp_fov', 'ortho_scale',
    'camera_fov', 'camera_pitch', 'camera_yaw', 'camera_distance',
    'target_x', 'target_y', 'target_z',

    // Telemetry & Refresh
    'refresh_rate', 'viewport_refresh_rate', 'fps', 'fps_limit', 'plot_stride', 'downsample_stride', 'x_axis_mode',
    'telemetry_channel', 'telemetry_source', 'active_tab', 'view_mode', 'view_type', 'viewType',
    'output_frequency', 'binary_mode', 'compress', 'ascii_delimiter', 'ascii_precision',
    'custom_filename', 'output_dir', 'vtk_dir',

    // ROI & Particle Filters
    'roi', 'roi_box', 'roi_enabled', 'roi_x_min', 'roi_x_max', 'roi_y_min', 'roi_y_max',
    'roi_z_min', 'roi_z_max', 'roi_stride', 'particle_filter', 'particle_stride', 'particle_max_count',

    // Visual Styling & Opacity
    'opacity'
]);

export interface ExternalResourceRef {
    nodeId: string;
    key: string;
    originalValue: string;
    resolvedSourcePath: string;
    filename: string;
    localRef: string;
}

export interface ResourceCopyTask {
    sourcePath: string;
    targetPath: string;
}

export interface PreparedModelSave {
    modelJson: string;
    clonedModel: Model;
    resources: ResourceCopyTask[];
    localParamUpdates: { nodeId: string; key: string; localRef: string }[];
}

/**
 * Resolves a potentially relative resource path (e.g. ./cube.stl or cube.stl)
 * against the model's directory on disk or the project root.
 */
export function resolveResourcePath(rawPath: string, modelFilename?: string | null): string {
    if (!rawPath || typeof rawPath !== 'string') return '';
    const trimmed = rawPath.trim();
    if (trimmed === '' || trimmed === 'None specified') return '';

    // If already absolute or windows drive
    if (trimmed.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(trimmed)) {
        return trimmed;
    }

    const cleanRel = trimmed.startsWith('./') ? trimmed.substring(2) : trimmed;

    if (modelFilename && typeof modelFilename === 'string' && modelFilename.includes('/')) {
        const lastSlash = modelFilename.lastIndexOf('/');
        const dir = lastSlash !== -1 ? modelFilename.substring(0, lastSlash) : '.';
        return `${dir}/${cleanRel}`;
    }

    return `/home/chris/antigrav/blastdemon/${cleanRel}`;
}

/**
 * Extracts all external resource file references (STL files, LS-DYNA decks)
 * from a model's nodes.
 */
export function extractModelResources(model: Model, currentModelPath?: string | null): ExternalResourceRef[] {
    const resources: ExternalResourceRef[] = [];
    if (!model || !model.nodes || !Array.isArray(model.nodes)) return resources;

    const resourceKeys = ['stl_file', 'k_file', 'external_file_path', 'file_path'];

    for (const node of model.nodes) {
        if (!node || !node.parameters) continue;

        for (const key of resourceKeys) {
            const val = node.parameters[key];
            if (val !== undefined && val !== null) {
                const strVal = String(val).trim();
                if (strVal !== '' && strVal !== 'None specified') {
                    const resolved = resolveResourcePath(strVal, currentModelPath || model.filename);
                    
                    // Extract clean basename
                    const lastSlash = strVal.lastIndexOf('/');
                    let filename = lastSlash !== -1 ? strVal.substring(lastSlash + 1) : strVal;
                    if (filename.startsWith('./')) filename = filename.substring(2);
                    if (!filename) continue;

                    resources.push({
                        nodeId: node.id,
                        key,
                        originalValue: strVal,
                        resolvedSourcePath: resolved,
                        filename,
                        localRef: `./${filename}`
                    });
                }
            }
        }
    }

    return resources;
}

/**
 * Prepares a model for saving to targetFilePath:
 * 1. Clones the model graph.
 * 2. Updates node parameters with local relative references (e.g. ./bracket.stl).
 * 3. Builds a deduplicated list of resource copy operations for the Broker.
 * 4. Serializes the updated model to JSON.
 */
export function prepareModelSavePayload(model: Model, targetFilePath: string): PreparedModelSave {
    const lastSlash = targetFilePath.lastIndexOf('/');
    const targetDir = lastSlash !== -1 ? targetFilePath.substring(0, lastSlash) : '.';

    const resources = extractModelResources(model, model.filename);
    const clonedNodes: Node[] = JSON.parse(JSON.stringify(model.nodes || []));
    const clonedConnections: Connection[] = JSON.parse(JSON.stringify(model.connections || []));

    const copyTasks: ResourceCopyTask[] = [];
    const seenTargets = new Set<string>();
    const localParamUpdates: { nodeId: string; key: string; localRef: string }[] = [];

    for (const res of resources) {
        const targetPath = `${targetDir}/${res.filename}`;

        // Queue copy task if source is valid and different from target
        if (res.resolvedSourcePath && res.resolvedSourcePath !== targetPath) {
            if (!seenTargets.has(targetPath)) {
                seenTargets.add(targetPath);
                copyTasks.push({
                    sourcePath: res.resolvedSourcePath,
                    targetPath
                });
            }
        }

        // Update cloned node parameter
        const targetNode = clonedNodes.find(n => n.id === res.nodeId);
        if (targetNode) {
            targetNode.parameters = targetNode.parameters || {};
            targetNode.parameters[res.key] = res.localRef;
        }

        localParamUpdates.push({
            nodeId: res.nodeId,
            key: res.key,
            localRef: res.localRef
        });
    }

    const clonedModel: Model = {
        id: model.id,
        name: model.name,
        filename: targetFilePath,
        nodes: clonedNodes,
        connections: clonedConnections,
        views: model.views ? JSON.parse(JSON.stringify(model.views)) : undefined,
        activeViewId: model.activeViewId || undefined
    };

    const modelJson = JSON.stringify({
        name: clonedModel.name,
        nodes: clonedModel.nodes,
        connections: clonedModel.connections,
        views: clonedModel.views,
        activeViewId: clonedModel.activeViewId
    }, null, 2);

    return {
        modelJson,
        clonedModel,
        resources: copyTasks,
        localParamUpdates
    };
}

export const NODE_DEFAULT_PARAMETERS: Record<string, Record<string, any>> = {
    'DomainMesh': {
        domain_radius: 1.0,
        cell_size: 0.001,
        left_bc: 'Transmitting',
        right_bc: 'Transmitting'
    },
    'Material': {
        material_model: 'Hypoelastic',
        preset: 'Structural Steel (A36)',
        density: 7850.0,
        youngs_modulus: 200.0e9,
        poissons_ratio: 0.26,
        yield_stress: 250.0e6,
        hardening_modulus: 1.0e9,
        failure_strain: 0.20,
        tensile_failure_stress: 400.0e6,
        enable_strain_erosion: false,
        erosion_strain: 0.20,
        enable_stress_erosion: false,
        erosion_stress: 400.0e6,
        enable_timestep_erosion: false,
        timestep_erosion_factor: 0.10,
        enable_heterogeneity: false,
        weibull_modulus: 0.0,
        weibull_scale: 1.0,
        fracture_toughness: 0.0,
        debris_bulk_factor: 0.10,
        enable_anisotropy: false,
        anisotropy_ratio: 1.0,
        anisotropy_axis: 'X',
        anisotropy_dir_x: 1.0,
        anisotropy_dir_y: 0.0,
        anisotropy_dir_z: 0.0,
        dem_transition_enabled: true,
        fragment_distribution: 'Rosin-Rammler',
        fragment_min_size: 0.002,
        fragment_max_size: 0.040,
        fragment_weibull_n: 1.80,
        fragment_clumping_radius: 0.015,
        fragment_ejection_jitter: 0.35,
        fragment_contact_friction: 0.55,
        fragment_restitution: 0.30,
        jc_A: 250.0e6,
        jc_B: 510.0e6,
        jc_n: 0.26,
        jc_C: 0.014,
        jc_m: 1.03,
        T_melt: 1793.0,
        T_room: 293.0,
        Cp: 486.0,
        mg_gamma0: 1.81,
        mg_c0: 4570.0,
        mg_s: 1.49,
        // Davis Solid Reactant
        davis_c0: 2050.0,
        davis_s1: 2.12,
        davis_gamma0: 0.65,
        davis_cv: 1000.0,
        davis_t0: 293.0,
        davis_rho0: 1895.0,
        // Davis Product Gas
        davis_a: 2.85,
        davis_b: 1.10,
        davis_k: 1.35,
        davis_vc: 0.65,
        davis_pc: 12.5e9,
        davis_q_det: 3.90e6,
        // CREST Kinetics
        crest_b1: 1.2e7,
        crest_c1: 0.67,
        crest_m1: 2.5,
        crest_b2: 3.5e6,
        crest_c2: 0.50,
        crest_c3: 0.67,
        crest_m2: 1.5,
        crest_s0: 15.0,
        crest_s_threshold: 2.0,
        // Concrete Base
        fc: 35.0e6,
        ft: 3.2e6,
        G_f: 150.0,
        moisture_content: 0.0,
        dif_cap_compression: 2.5,
        dif_cap_tension: 8.0,
        // RHT
        rht_A: 1.60,
        rht_N: 0.61,
        rht_B: 0.70,
        rht_M: 0.80,
        rht_Q0: 0.680,
        rht_BQ: 0.0105,
        rht_D1: 0.04,
        rht_D2: 1.0,
        rht_p_crush: 17.0e6,
        rht_p_lock: 600.0e6,
        rht_alpha0: 1.22,
        rht_n_comp: 3.0,
        rht_betac: 0.032,
        rht_deltat: 0.036,
        // K&C
        kc_auto_generate: true,
        kc_a0: 11.6e6,
        kc_a1: 0.45,
        kc_a2: 4.28e-9,
        kc_a0y: 5.2e6,
        kc_a1y: 0.45,
        kc_a2y: 4.28e-9,
        kc_a1r: 0.75,
        kc_a2r: 5.71e-9,
        kc_b1: 1.60,
        kc_omega: 0.50,
        // CSCM
        cscm_alpha: 14.0e6,
        cscm_theta: 0.15,
        cscm_lambda: 10.5e6,
        cscm_beta: 2.85e-9,
        cscm_R: 5.0,
        cscm_X0: 87.5e6,
        cscm_W: 0.05,
        cscm_D1: 2.5e-9,
        cscm_D2: 3.0e-17,
        directional_crack_band: false,
        nonlocal_radius: 0.0,
        // Ideal Gas CFD
        atm_pressure: 101325.0,
        atm_temperature: 288.15,
        gamma: 1.4,
        ambient_p: 101325.0,
        ambient_rho: 1.225,
        // JWL CFD
        composition: 'TNT',
        rho: 1630,
        detonation_energy: 4290000,
        det_vel: 6930,
        jwl_A: 373.77e9,
        jwl_B: 3.747e9,
        jwl_R1: 4.15,
        jwl_R2: 0.90,
        jwl_omega: 0.35,
        ideal_gamma: 1.4,
        ideal_rho_0: 1630,
        ideal_e_0: 4290000
    },
    'Charge1D': {
        material: '',
        charge_mass: 0.853479,
        charge_radius: 0.05
    },
    'Charge2D': {
        material: '',
        charge_shape: 'Sphere',
        charge_mass: 0.853479,
        charge_radius: 0.05,
        charge_height: 0.1,
        charge_aspect_ratio: 1.0,
        charge_r: 0.0,
        charge_z: 0.1
    },
    'VirtualGauges': {
        gauges: [],
        source_mode: 'manual',
        external_file_path: '',
        external_file_format: 'Auto',
        external_probe_count: 0,
        external_bounds_min_x: 0,
        external_bounds_max_x: 0,
        external_bounds_min_y: 0,
        external_bounds_max_y: 0,
        external_bounds_min_z: 0,
        external_bounds_max_z: 0,
        pinned_probe_ids: [],
        storage_backend: 'HDF5 Stream',
        sampling_stride_steps: 1,
        telemetry_channel: 0,
        enable_gauges: 'Enabled',
        export_ascii: false,
        export_binary: false,
        export_hdf5: false,
        ascii_delimiter: 'Comma',
        ascii_precision: 6,
        include_header: true,
        output_dir: '',
        custom_filename: 'gauges',
        qty_pressure: true,
        qty_density: true,
        qty_velocity: true,
        qty_energy: true,
        qty_reacted: true,
        qty_unreacted: true,
        qty_air: true,
        qty_overpressure: true,
        qty_impulse: true
    },
    'CFDSolver': {
        init_mode: 'Multi-Material JWL',
        cfl: 0.6,
        endtime: 1.0,
        flux_scheme: 'AUSM+',
        space_time_scheme: 'MUSCL-Hancock (2nd-Order Space/Time)',
        spatial_order: 2,
        temporal_order: 4,
        precision: 'single'
    },
    'TelemetryGraph': {
        telemetry_channel: 0,
        x_axis_mode: 'radius',
        plot_stride: 1,
        min_y: 0,
        max_y: 1,
        show_grid: true,
        colormap: 'rainbow'
    },
    'DomainMesh2D': {
        cell_size: 0.005,
        max_r: 1.0,
        max_z: 1.0,
        bc_r_min: 'Reflecting',
        bc_r_max: 'Terminate',
        bc_z_min: 'Reflecting',
        bc_z_max: 'Terminate',
        coordinate_system: 'Axisymmetric'
    },
    'DetonatorLocation': {
        detonator_r: 0.0,
        detonator_z: 0.1,
        detonator_radius: 0.001
    },
    'DetonatorLocation3D': {
        detonator_x: 0.5,
        detonator_y: 0.5,
        detonator_z: 0.5,
        detonator_radius: 0.01
    },
    'STLGeometry': {
        stl_file: '',
        geometry_hash: '',
        voxelization_method: 'watertight_floodfill'
    },
    'PrimitiveGeometry3D': {
        primitives: [],
        voxelization_method: 'watertight_floodfill'
    },
    'RemapNode': {
        explosive_r: 0.0,
        explosive_z: 0.1,
        remap_radius: 0.5,
        trigger_type: 'end',
        trigger_val: 0.0
    },
    'Remap1DTo2DNode': {
        explosive_r: 0.0,
        explosive_z: 0.1,
        remap_radius: 0.5,
        trigger_type: 'end',
        trigger_val: 0.0
    },
    'Remap1DTo3DNode': {
        explosive_x: 0.5,
        explosive_y: 0.5,
        explosive_z: 0.5,
        remap_radius: 0.0,
        trigger_type: 'end',
        trigger_val: 0.0
    },
    'Remap2DTo3DNode': {
        explosive_x: 0.5,
        explosive_y: 0.5,
        explosive_z: 0.5,
        remap_radius: 0.0,
        trigger_type: 'end',
        trigger_val: 0.0
    },
    'HardwareConfig': {
        device: 'cpu',
        precision: 'single'
    },
    'CFDSolver2D': {
        init_mode: 'From1D',
        cfl: 0.6,
        endtime: 1.0,
        flux_scheme: 'AUSM+',
        space_time_scheme: 'MUSCL-Hancock (2nd-Order Space/Time)',
        spatial_order: 2,
        temporal_order: 4,
        mesh_type: 'regular',
        amr_max_levels: 3,
        amr_threshold: 0.05,
        amr_coarsen_ratio: 0.2
    },
    'TelemetryContour': {
        telemetry_channel: 0,
        auto_scale: true,
        log_scale: false,
        colormap: 'rainbow',
        min_y: 0,
        max_y: 1,
        downsample_stride: 1,
        refresh_rate: 0.5,
        interpolate: true
    },
    'VTKOutput': {
        trigger_type: 'Step Interval',
        vtk_dir: './vtk_output',
        export_cfd_2d: true,
        export_slices: true,
        export_volumes: false,
        export_obstacles: true,
        export_stl_faces: true,
        stl_outside_domain: 'nan',
        tessellate_stl_faces: false,
        tessellation_max_edge: 0.0,
        export_fem: true,
        export_mpm: true,
        export_pvd: true,
        custom_filename: 'vtk_output',
        step_interval: 10,
        time_interval: 0.0001,
        vtk_format: 'Binary',
        qty_pressure: true,
        qty_density: true,
        qty_velocity: true,
        qty_energy: true,
        qty_reacted: true,
        qty_unreacted: true,
        qty_air: true,
        qty_overpressure: true,
        qty_impulse: true,
        qty_fem_stress: true,
        qty_fem_strain: true,
        qty_fem_pressure: true,
        qty_fem_temp: true,
        qty_fem_damage: true,
        qty_fem_vel: true,
        qty_fem_disp: true,
        qty_mpm_stress: true,
        qty_mpm_strain: true,
        qty_mpm_damage: true,
        qty_mpm_temp: true,
        qty_mpm_vel: true,
        qty_mpm_disp: true,
        roi_enabled: false,
        roi_xmin: 0.0,
        roi_xmax: 1.0,
        roi_ymin: 0.0,
        roi_ymax: 1.0,
        roi_zmin: 0.0,
        roi_zmax: 1.0,
        volume_stride: 1,
        slice_stride: 1
    },
    'DomainMesh3D': {
        xmin: 0.0, xmax: 1.0,
        ymin: 0.0, ymax: 1.0,
        zmin: 0.0, zmax: 1.0,
        cell_size: 0.01,
        bc_x_min: 'Reflecting', bc_x_max: 'Transmitting',
        bc_y_min: 'Reflecting', bc_y_max: 'Transmitting',
        bc_z_min: 'Reflecting', bc_z_max: 'Transmitting',
        slices: []
    },
    'Charge3D': {
        material: '',
        charge_shape: 'Sphere',
        charge_mass: 6.8277,
        charge_x: 0.5, charge_y: 0.5, charge_z: 0.5,
        charge_radius: 0.1,
        charge_height: 0.2,
        charge_aspect_ratio: 1.0,
        charge_lx: 0.2, charge_ly: 0.2, charge_lz: 0.2,
        charge_rot_x: 0.0,
        charge_rot_y: 0.0,
        charge_rot_z: 0.0
    },
    'CFDSolver3D': {
        cfl: 0.6,
        endtime: 1.0,
        device: 'cpu',
        init_mode: 'From1D',
        flux_scheme: 'AUSM+',
        space_time_scheme: 'MUSCL-Hancock (2nd-Order Space/Time)',
        spatial_order: 2,
        temporal_order: 4,
        precision: 'single',
        telemetry_mode: 'Enabled',
        telemetry_interval_ms: 100,
        enable_gauges: 'Enabled',
        enable_vtk: 'Disabled'
    },
    'Telemetry3DViewport': {
        colormap: 'rainbow',
        quantity_colormaps: {
            pressure: 'rainbow',
            density: 'rainbow',
            velocity: 'rainbow',
            energy: 'rainbow',
            species1: 'rainbow',
            species2: 'rainbow',
            species3: 'rainbow',
            solid: 'rainbow',
            overpressure: 'rainbow',
            impulse: 'rainbow',
            peak_overpressure: 'rainbow',
            peak_impulse: 'rainbow',
            vonMises: 'rainbow',
            von_mises: 'rainbow',
            plasticStrain: 'rainbow',
            plastic_strain: 'rainbow',
            damage: 'rainbow',
            has_failed: 'rainbow',
            cluster_id: 'rainbow',
            object_id: 'rainbow',
            temperature: 'rainbow',
            displacement: 'rainbow',
            momentOrForce: 'rainbow'
        },
        quantity_ranges: {
            pressure: [101325.0, 1013250.0],
            density: [1.2, 100.0],
            velocity: [0.0, 1000.0],
            energy: [200000.0, 10000000.0],
            species1: [0.0, 1.0],
            species2: [0.0, 1.0],
            species3: [0.0, 1.0],
            solid: [0.0, 1.0],
            overpressure: [0.0, 101325.0 * 99.0],
            impulse: [0.0, 10000.0],
            peak_overpressure: [0.0, 101325.0 * 99.0],
            peak_impulse: [0.0, 10000.0],
            vonMises: [0.0, 500000000.0],
            von_mises: [0.0, 500000000.0],
            plasticStrain: [0.0, 1.0],
            plastic_strain: [0.0, 1.0],
            damage: [0.0, 1.0],
            has_failed: [0.0, 1.0],
            cluster_id: [0.0, 50.0],
            object_id: [0.0, 10.0],
            temperature: [300.0, 3000.0],
            displacement: [0.0, 0.1],
            momentOrForce: [0.0, 1000.0]
        },
        quantity_log_scales: {},
        quantity_auto_scales: {},
        lock_quantity_ranges: true,
        refresh_rate: 0.5,
        slices: [],
        log_scale: false,
        auto_scale: true,
        min_val: 101325.0,
        max_val: 101325.0 * 100.0,
        show_color_bar: false,
        color_bar_position: 'left-center',
        colorbar_source: 'slice',
        show_grid: true,
        grid_meshlines: true,
        show_grid_box: true,
        grid_opacity: 1.0,
        cell_edges: false,
        interpolate: false,
        // Lighting — explicit defaults so overlay sliders initialise correctly
        lightingEnabled: true,
        aoEnabled: true,
        ambientLevel: 0.3,
        specularIntensity: 0.4,
        aoRadius: 0.15,
        aoIntensity: 1.2,
        aoBias: 0.005,
        aoSphereImpostor: true,
        // MPM Particles Defaults
        showMPMParticles: true,
        mpmParticleDiameter: 0,
        mpmParticleSize: 4.0,
        mpmParticleQuantity: 'vonMises',
        mpmParticleColormap: 'rainbow',
        mpmParticleAutoScale: true,
        mpmParticleLogScale: false,
        mpmParticleShowColorbar: false,
        mpmParticleOpacity: 1.0,
        mpmParticleMinVal: 0.0,
        mpmParticleMaxVal: 500000000.0,
        // FEM Mesh Defaults
        showFEMMesh: true,
        femSolid: true,
        femWireframe: true,
        femResults: true,
        femQuantity: 'vonMises',
        femColormap: 'rainbow',
        femAutoScale: true,
        femLogScale: false,
        femShowColorbar: false,
        femOpacity: 1.0,
        femMinVal: 0.0,
        // Beams & 1D Elements Defaults
        showBeams: true,
        beamSolid: true,
        beamWireframe: true,
        beamRadius: 0.008,
        beamQuantity: 'plasticStrain',
        beamColormap: 'rainbow',
        beamAutoScale: true,
        beamLogScale: false,
        beamShowColorbar: false,
        beamMinVal: 0.0,
        beamMaxVal: 0.05,
        show_stl: true,
        stl_colormap: 'rainbow',
        stl_wireframe: false,
        stl_solids: true,
        stl_opacity: 0.5,
        stl_show_results: false,
        stl_quantity: 'pressure',
        stl_sampling_mode: 'nearest',
        stl_auto_scale: true,
        stl_log_scale: false,
        stl_show_colorbar: false,
        stl_min_val: 101325.0,
        stl_max_val: 1013250.0,
        show_gauges: true,
        gauge_size: 1.0,
        gauge_opacity: 1.0,
        gauge_quantity: 'pressure',
        gauge_solid: true,
        show_obstacles: true,
        obstacles_colormap: 'rainbow',
        obstacles_gridlines: true,
        obstacles_solid: true,
        obstacles_lighting: true,
        obstacles_opacity: 1.0,
        obstacles_quantity: 'pressure',
        obstacles_auto_scale: true,
        obstacles_log_scale: false,
        obstacles_show_colorbar: false,
        obstacles_interpolate: false,
        obstacles_min_val: 101325.0,
        obstacles_max_val: 101325.0 * 10.0,
        // Charge & Detonator Display Defaults
        show_charge: true,
        charge_solid: true,
        charge_wireframe: true,
        charge_lighting: true,
        charge_opacity: 0.65,
        show_detonators: true,
        show_detonator: true,
        detonator_solid: true,
        detonators_solid: true,
        detonator_wireframe: true,
        detonators_wireframe: true,
        detonator_lighting: true,
        detonators_lighting: true,
        detonator_size: 1.0,
        detonators_size: 1.0,
        detonator_opacity: 1.0,
        detonators_opacity: 1.0
    },
    'MPMDomain2D': {
        precision: 'single',
        particle_distribution: 'Cartesian',
        boundary_filling: 'Stairstepped',
        velocity_scheme: 'APIC',
        space_time_scheme: 'Leapfrog',
        flip_blend: 0.95,
        smooth_plastic_strain: true,
        ppc: 4,
        cfl: 0.6,
        endtime: 1.0
    },
    'MPMDomain3D': {
        device: 'gpu',
        precision: 'single',
        particle_distribution: 'Cartesian',
        boundary_filling: 'Stairstepped',
        velocity_scheme: 'APIC',
        space_time_scheme: 'Leapfrog',
        flip_blend: 0.95,
        smooth_plastic_strain: true,
        ppc: 8,
        cfl: 0.6,
        endtime: 1.0
    },
    'MPMObject2D': {
        material: '',
        shape_type: 'Rectangle',
        particle_distribution: 'Cartesian',
        boundary_filling: 'Stairstepped',
        pos_x: 0.5,
        pos_y: 0.5,
        size_x: 0.2,
        size_y: 0.2,
        radius: 0.1,
        vel_x: 0.0,
        vel_y: 0.0,
        angular_vel: 0.0
    },
    'MPMObject3D': {
        material: '',
        shape_type: 'Box',
        particle_distribution: 'Cartesian',
        boundary_filling: 'Stairstepped',
        pos_x: 0.5, pos_y: 0.5, pos_z: 0.5,
        size_x: 0.2, size_y: 0.2, size_z: 0.2,
        radius: 0.1, inner_radius: 0.0, height: 0.2,
        stl_file: '', scale_x: 1.0, scale_y: 1.0, scale_z: 1.0,
        angular_vel_x: 0.0, angular_vel_y: 0.0, angular_vel_z: 0.0
    },
    'FSICoupler2D': {
        cfl: 0.6,
        endtime: 1.0
    },
    'FSICoupler3D': {
        cfl: 0.6,
        endtime: 1.0
    },
    'FEMDomain3D': {
        device: 'cpu',
        precision: 'single',
        integration_scheme: 'OnePointFB',
        hourglass_model: 'FlanaganBelytschkoStiffness',
        hourglass_coeff: 0.10,
        contact_penalty_scale: 0.1,
        friction_static: 0.3,
        friction_kinetic: 0.2,
        convert_failed_elements_to_mpm: false,
        mpm_particles_per_failed_element: 8,
        material_heterogeneity: 0.08,
        enable_heterogeneity: false,
        enable_anisotropy: false,
        anisotropy_ratio: 1.0,
        anisotropy_axis: 'X',
        anisotropy_dir_x: 1.0,
        anisotropy_dir_y: 0.0,
        anisotropy_dir_z: 0.0,
        debris_velocity_smoothing: 0.50,
        debris_clumping: 0.60,
        debris_max_clump_size: 8,
        random_seed: 42,
        enable_directional_crack_band: true,
        enable_nonlocal_damage: true,
        cfl: 0.6,
        endtime: 1.0
    },
    'FEMObject3D': {
        material: '',
        shape_type: 'Box',
        boundary_condition: 'Free',
        pos_x: 0.0, pos_y: 0.0, pos_z: 0.0,
        size_x: 1.0, size_y: 1.0, size_z: 1.0,
        radius: 0.1, inner_radius: 0.0, height: 0.2,
        nx: 10, ny: 10, nz: 10,
        vel_x: 0.0, vel_y: 0.0, vel_z: 0.0,
        k_file: ''
    },
    'LSDynaImporter3D': {
        k_file: '',
        scale_factor: 1.0
    },
    'FEMFSICoupler3D': {
        cfl: 0.6,
        endtime: 1.0,
        coupling_scheme: 'Two-Way Staggered',
        pressure_integration: '2x2 Gauss Quadrature',
        uncovering_method: 'Conservative IDW + Vacuum Cavity',
        erosion_venting: true,
        vacuum_density: 1.0e-6,
        vacuum_pressure: 1.0e-2
    },
    'ThePainter': {},
    'TelemetryText': {
        stream_layout: 'Columnar (Fixed-Width)',
        show_timing_breakdown: true,
        show_memory: true,
        show_wallclock: true,
        show_dt: true,
        timestamp_mode: 'None',
        font_size: 11,
        buffer_capacity: 100,
        filter_level: 'All'
    }
};

export class StateManager {
    private appState: AppState;
    private history: AppState[] = [];
    private currentIndex: number = -1;
    private listeners: ((state: SimulationState) => void)[] = [];
    private simulationStatus: SimulationStatus = 'UNINITIALIZED';
    private statusListeners: ((status: SimulationStatus) => void)[] = [];
    private pendingSteps: number = 0;
    public telemetryStore: Map<string, any> = new Map();
    public rawTelemetryStore: Map<string, Array<{ data: any; modelId?: string }>> = new Map();
    public latestMetricStore: Map<string, { data: any; modelId?: string }> = new Map();
    private telemetryListeners: ((nodeId: string, data: any) => void)[] = [];
    public selectedNodeId: string | null = null;
    private selectionListeners: ((nodeId: string | null) => void)[] = [];
    public selectedSliceIndex: number | null = null;
    private sliceSelectionListeners: ((sliceIdx: number | null) => void)[] = [];
    public selectedGaugeIndex: number | null = null;
    private gaugeSelectionListeners: ((gaugeIdx: number | null) => void)[] = [];
    public hoveredNodeId: string | null = null;
    public hoveredSliceIndex: number | null = null;
    private hoverListeners: ((nodeId: string | null, sliceIdx: number | null) => void)[] = [];
    public focusedViewportNodeId: string | null = null;
    public focusedViewportPanelId: string | null = null;
    private focusedViewportListeners: ((viewportNodeId: string | null, panelId: string | null) => void)[] = [];

    private modelStatuses: Map<string, SimulationStatus> = new Map();
    private modelProgresses: Map<string, number> = new Map();
    private modelSimTimes: Map<string, number> = new Map();
    private modelSteps: Map<string, number> = new Map();
    private modelDts: Map<string, number> = new Map();
    private modelTelemetryTiming: Map<string, {
        lastStep: number;
        lastTimeMs: number;
        stepDelta: number;
        smoothedThroughput: number;
        smoothedComputeMs?: number;
        smoothedIoMs?: number;
        smoothedCommsMs?: number;
        lastVtkMs?: number;
        lastVtkStep?: number;
        cumComputeS?: number;
        cumIoS?: number;
        cumCommsS?: number;
    }> = new Map();
    private modelStatusListeners: ((modelId: string, status: SimulationStatus) => void)[] = [];
    private inPlaceParameterListeners: ((nodeId: string, parameters: Record<string, any>) => void)[] = [];
    private saveTimeout: any = null;
    private clipboardModel: Model | null = null;

    constructor(initialState?: SimulationState) {
        const defaultModelId = 'model-default';
        const defaultModel: Model = {
            id: defaultModelId,
            name: 'Default Model',
            filename: null,
            nodes: initialState ? JSON.parse(JSON.stringify(initialState.nodes)) : [],
            connections: initialState ? JSON.parse(JSON.stringify(initialState.connections)) : []
        };
        const defaultWorkspaceId = 'ws-default';
        const defaultWorkspace: Workspace = {
            id: defaultWorkspaceId,
            name: 'Workspace 1',
            modelIds: [defaultModelId],
            activeModelId: defaultModelId,
            layout: initialState?.layout ? JSON.parse(JSON.stringify(initialState.layout)) : createDefaultWorkstationLayout(defaultWorkspaceId),
            connections: []
        };

        this.appState = {
            models: { [defaultModelId]: defaultModel },
            workspaces: [defaultWorkspace],
            activeWorkspaceId: defaultWorkspaceId,
            workspaceCounter: 1
        };

        this.healModelGraph(defaultModel);
        this.pushAppState(this.appState, false);
    }

    // Shims for legacy/external code
    get workspaces(): SimulationState[] {
        return this.appState.workspaces.map(ws => this.synthesizeWorkspaceState(ws));
    }

    get activeWorkspaceIndex(): number {
        return this.appState.workspaces.findIndex(ws => ws.id === this.appState.activeWorkspaceId);
    }

    // Removed runTarget methods

    getModelStatus(modelId: string): SimulationStatus {
        return this.modelStatuses.get(modelId) || 'UNINITIALIZED';
    }

    setModelStatus(modelId: string, status: SimulationStatus): void {
        const oldStatus = this.modelStatuses.get(modelId);
        if (oldStatus !== status) {
            this.modelStatuses.set(modelId, status);
            this.modelStatusListeners.forEach(l => l(modelId, status));
            
            if (status === 'UNINITIALIZED' || status === 'INITIALIZED') {
                this.modelSteps.set(modelId, 0);
                this.modelSimTimes.set(modelId, 0.0);
                this.modelDts.set(modelId, 0.0);
                this.modelTelemetryTiming.delete(modelId);
            }

            if (status === 'PAUSED' && oldStatus === 'RUNNING') {
                this.pushTelemetry('Simulation Interrupted/Paused', undefined, modelId);
            } else if (status === 'TERMINATED') {
                this.pushTelemetry('Simulation Terminated', undefined, modelId);
            }
            
            const activeWs = this.getActiveWorkspace();
            if (activeWs && activeWs.activeModelId === modelId) {
                this.setStatus(status);
            }
        }
    }

    onModelStatusChange(listener: (modelId: string, status: SimulationStatus) => void): void {
        this.modelStatusListeners.push(listener);
    }

    offModelStatusChange(listener: (modelId: string, status: SimulationStatus) => void): void {
        this.modelStatusListeners = this.modelStatusListeners.filter(l => l !== listener);
    }

    getModelProgress(modelId: string): number {
        return this.modelProgresses.get(modelId) || 0;
    }

    setModelProgress(modelId: string, percent: number): void {
        this.modelProgresses.set(modelId, percent);
    }

    getModelSimTime(modelId: string): number {
        return this.modelSimTimes.get(modelId) || 0.0;
    }

    setModelSimTime(modelId: string, simTime: number): void {
        this.modelSimTimes.set(modelId, simTime);
    }

    getModelStep(modelId?: string): number {
        if (!modelId) {
            const activeWs = this.getActiveWorkspace();
            modelId = activeWs?.activeModelId || Object.keys(this.appState.models)[0] || undefined;
        }
        if (modelId && this.modelSteps.has(modelId)) {
            return this.modelSteps.get(modelId)!;
        }
        for (const val of this.modelSteps.values()) {
            if (val > 0) return val;
        }
        return 0;
    }

    setModelStep(modelId: string, step: number): void {
        if (step > 0) {
            this.modelSteps.set(modelId, step);
        } else if (step === 0) {
            const current = this.modelSteps.get(modelId) ?? 0;
            const status = this.getModelStatus(modelId);
            if (status === 'UNINITIALIZED' || status === 'INITIALIZED' || current === 0) {
                this.modelSteps.set(modelId, 0);
            }
        }
    }

    getModelDt(modelId?: string): number {
        if (!modelId) {
            const activeWs = this.getActiveWorkspace();
            modelId = activeWs?.activeModelId || Object.keys(this.appState.models)[0] || undefined;
        }
        if (modelId && this.modelDts.has(modelId)) {
            return this.modelDts.get(modelId)!;
        }
        for (const val of this.modelDts.values()) {
            if (val > 0) return val;
        }
        return 0;
    }

    setModelDt(modelId: string, dt: number): void {
        if (Number.isFinite(dt) && dt >= 0) {
            this.modelDts.set(modelId, dt);
        }
    }

    getModelTelemetryTiming(modelId?: string): {
        stepDelta: number;
        smoothedThroughput: number;
        smoothedComputeMs?: number;
        smoothedIoMs?: number;
        smoothedCommsMs?: number;
        lastVtkMs?: number;
        lastVtkStep?: number;
        cumComputeS?: number;
        cumIoS?: number;
        cumCommsS?: number;
    } {
        if (!modelId) {
            const activeWs = this.getActiveWorkspace();
            modelId = activeWs?.activeModelId || Object.keys(this.appState.models)[0] || undefined;
        }
        if (modelId) {
            const t = this.modelTelemetryTiming.get(modelId);
            if (t) return { ...t };
        }
        return { stepDelta: 1, smoothedThroughput: 0 };
    }

    // Workspace management
    getActiveWorkspace(): Workspace {
        return this.appState.workspaces.find(ws => ws.id === this.appState.activeWorkspaceId) || this.appState.workspaces[0];
    }

    getActiveModelId(): string | null {
        const ws = this.getActiveWorkspace();
        if (ws && ws.activeModelId && this.appState.models[ws.activeModelId]) {
            return ws.activeModelId;
        }
        if (ws && ws.modelIds && ws.modelIds.length > 0 && this.appState.models[ws.modelIds[0]]) {
            return ws.modelIds[0];
        }
        const all = Object.keys(this.appState.models);
        return all.length > 0 ? all[0] : null;
    }

    getActiveModel(): Model | null {
        const id = this.getActiveModelId();
        return id ? (this.appState.models[id] || null) : null;
    }

    getModel(modelId: string): Model | null {
        return this.appState.models[modelId] || null;
    }

    getModelForNode(nodeId: string): Model | null {
        for (const mId in this.appState.models) {
            const m = this.appState.models[mId];
            if (m && m.nodes && m.nodes.some(n => n.id === nodeId)) {
                return m;
            }
        }
        return null;
    }

    getWorkspaceModels(wsId?: string): Model[] {
        const targetId = wsId || this.appState.activeWorkspaceId;
        const ws = this.appState.workspaces.find(w => w.id === targetId);
        if (!ws) return [];
        return ws.modelIds.map(id => this.appState.models[id]).filter(m => !!m);
    }

    getAllModels(): Model[] {
        return Object.values(this.appState.models);
    }

    getModelViews(modelId: string): ModelViewConfig[] {
        const model = this.appState.models[modelId];
        return model && model.views ? model.views : [];
    }

    getModelActiveView(modelId: string): ModelViewConfig | null {
        const model = this.appState.models[modelId];
        if (!model || !model.views || model.views.length === 0) return null;
        const activeId = model.activeViewId || model.views[0].id;
        return model.views.find(v => v.id === activeId) || model.views[0];
    }

    setModelActiveViewId(modelId: string, viewId: string): void {
        const model = this.appState.models[modelId];
        if (!model || !model.views) return;
        const found = model.views.find(v => v.id === viewId);
        if (found) {
            model.activeViewId = viewId;
            this.pushAppState(this.appState);
        }
    }

    updateModelActiveViewCamera(modelId: string, camera: ModelViewCamera): void {
        const model = this.appState.models[modelId];
        if (!model || !model.views || model.views.length === 0) return;
        const activeView = this.getModelActiveView(modelId);
        if (activeView) {
            activeView.camera = { ...(activeView.camera || {}), ...camera };
            this.saveWorkspaceDebounced();
        }
    }

    updateModelActiveViewSlices(modelId: string, slices: ModelViewSlice[]): void {
        const model = this.appState.models[modelId];
        if (!model || !model.views || model.views.length === 0) return;
        const activeView = this.getModelActiveView(modelId);
        if (activeView) {
            activeView.slices = slices;
            this.saveWorkspaceDebounced();
        }
    }

    updateModelActiveViewToggles(modelId: string, toggles: Partial<ModelViewToggles>): void {
        const model = this.appState.models[modelId];
        if (!model || !model.views || model.views.length === 0) return;
        const activeView = this.getModelActiveView(modelId);
        if (activeView) {
            activeView.toggles = { ...(activeView.toggles || {}), ...toggles };
            this.saveWorkspaceDebounced();
        }
    }

    addModelView(modelId: string, name: string, camera?: ModelViewCamera, slices?: ModelViewSlice[], toggles?: ModelViewToggles): ModelViewConfig | null {
        const model = this.appState.models[modelId];
        if (!model) return null;
        if (!model.views) model.views = [];
        const currentActive = this.getModelActiveView(modelId);
        const newView: ModelViewConfig = {
            id: 'view-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 4),
            name: name || `View ${model.views.length + 1}`,
            camera: camera || (currentActive?.camera ? JSON.parse(JSON.stringify(currentActive.camera)) : { pitch: 0.42, yaw: 2.356, distance: 1.35, target: [0, 0, 0], usePerspective: true, fov: 45.0 }),
            slices: slices || (currentActive?.slices ? JSON.parse(JSON.stringify(currentActive.slices)) : [{ axis: 'xy', offset: 0.5, quantity: 'pressure', enabled: true, colormap: 'rainbow', opacity: 1.0, stride: 1 }]),
            toggles: toggles || (currentActive?.toggles ? JSON.parse(JSON.stringify(currentActive.toggles)) : { show_grid: true, show_grid_box: true, cell_edges: false, show_stl: true, stl_opacity: 0.5, show_obstacles: true, obstacles_opacity: 1.0 })
        };
        model.views.push(newView);
        model.activeViewId = newView.id;
        this.pushAppState(this.appState);
        return newView;
    }

    deleteModelView(modelId: string, viewId: string): boolean {
        const model = this.appState.models[modelId];
        if (!model || !model.views || model.views.length <= 1) return false;
        model.views = model.views.filter(v => v.id !== viewId);
        if (model.activeViewId === viewId) {
            model.activeViewId = model.views[0].id;
        }
        this.pushAppState(this.appState);
        return true;
    }

    getAllWorkspaces(): Workspace[] {
        return this.appState.workspaces;
    }

    switchWorkspace(idOrIndex: string | number) {
        let targetWorkspace: Workspace | undefined;
        if (typeof idOrIndex === 'number') {
            targetWorkspace = this.appState.workspaces[idOrIndex];
        } else {
            targetWorkspace = this.appState.workspaces.find(ws => ws.id === idOrIndex);
        }

        if (targetWorkspace) {
            this.appState.activeWorkspaceId = targetWorkspace.id;
            if (!targetWorkspace.activeModelId || !targetWorkspace.modelIds.includes(targetWorkspace.activeModelId)) {
                targetWorkspace.activeModelId = targetWorkspace.modelIds[0] || null;
            }
            if (targetWorkspace.activeModelId) {
                localStorage.setItem('blast_pipeline_active_model_id', targetWorkspace.activeModelId);
            }
            this.selectedNodeId = null;
            this.selectedSliceIndex = null;
            this.selectedGaugeIndex = null;
            this.pushAppState(this.appState);
        }
    }

    createWorkspace(name?: string): void {
        this.appState.workspaceCounter++;
        const newId = `ws-${Math.random().toString(36).substr(2, 9)}`;
        const newModel = this.createModel(`Model 1`);
        
        const newWorkspace: Workspace = {
            id: newId,
            name: name || `Workspace ${this.appState.workspaceCounter}`,
            modelIds: [newModel.id],
            activeModelId: newModel.id,
            layout: createDefaultWorkstationLayout(newId),
            connections: []
        };

        this.appState.workspaces.push(newWorkspace);
        this.appState.activeWorkspaceId = newId;
        this.pushAppState(this.appState);
    }

    deleteWorkspace(wsId: string): void {
        if (this.appState.workspaces.length <= 1) return;
        const index = this.appState.workspaces.findIndex(ws => ws.id === wsId);
        if (index !== -1) {
            this.appState.workspaces = this.appState.workspaces.filter(ws => ws.id !== wsId);
            if (this.appState.activeWorkspaceId === wsId) {
                const nextActiveIdx = Math.max(0, index - 1);
                this.appState.activeWorkspaceId = this.appState.workspaces[nextActiveIdx].id;
            }
            this.pushAppState(this.appState);
        }
    }


    renameWorkspace(id: string, name: string): void {
        const ws = this.appState.workspaces.find(w => w.id === id);
        if (ws) {
            ws.name = name;
            this.pushAppState(this.appState);
        }
    }

    getModelColors(modelId: string): { base: string, faint: string } {
        const allModels = this.getAllModels();
        const idx = allModels.findIndex(m => m.id === modelId);
        
        const palette = [
            { h: 217, s: 90, l: 60 }, // Blue
            { h: 0, s: 85, l: 60 },   // Red
            { h: 142, s: 70, l: 50 }, // Emerald
            { h: 38, s: 90, l: 50 },  // Amber
            { h: 262, s: 80, l: 60 }, // Purple
            { h: 327, s: 75, l: 55 }, // Pink
            { h: 187, s: 90, l: 45 }, // Cyan
            { h: 25, s: 95, l: 55 },  // Orange
            { h: 171, s: 75, l: 45 }, // Teal
            { h: 84, s: 80, l: 48 },  // Lime
            { h: 200, s: 85, l: 65 }, // Light Blue
            { h: 345, s: 80, l: 55 }, // Crimson
            { h: 105, s: 65, l: 45 }, // Forest Green
            { h: 45, s: 95, l: 55 },  // Yellow-Orange
            { h: 280, s: 70, l: 65 }, // Violet
            { h: 310, s: 70, l: 50 }, // Magenta
            { h: 160, s: 85, l: 40 }, // Mint
            { h: 15, s: 85, l: 50 },  // Rust
            { h: 230, s: 75, l: 65 }, // Indigo
            { h: 65, s: 80, l: 45 }   // Olive
        ];
        
        const color = idx !== -1 ? palette[idx % palette.length] : { h: 0, s: 0, l: 50 };
        return {
            base: `hsl(${color.h}, ${color.s}%, ${color.l}%)`,
            faint: `hsla(${color.h}, ${color.s}%, ${color.l}%, 0.04)`
        };
    }

    // Model management
    createModel(name?: string): Model {
        const modelId = `model-${Math.random().toString(36).substr(2, 9)}`;
        const newModel: Model = {
            id: modelId,
            name: name || `Model ${Object.keys(this.appState.models).length + 1}`,
            filename: null,
            nodes: [],
            connections: []
        };
        this.appState.models[modelId] = newModel;
        
        const activeWs = this.getActiveWorkspace();
        activeWs.modelIds.push(modelId);
        activeWs.activeModelId = modelId;

        this.pushAppState(this.appState);
        return newModel;
    }

    setModelFilename(modelId: string, filename: string): void {
        const model = this.appState.models[modelId];
        if (model) {
            model.filename = filename;
            this.pushAppState(this.appState);
        }
    }

    addModelToWorkspace(model: Model, wsId?: string): void {
        const targetWsId = wsId || this.appState.activeWorkspaceId;
        const ws = this.appState.workspaces.find(w => w.id === targetWsId);
        if (ws) {
            this.healModelGraph(model);
            this.healNodes(model.nodes, model);
            if (!this.appState.models[model.id]) {
                this.appState.models[model.id] = model;
            }
            if (!ws.modelIds.includes(model.id)) {
                ws.modelIds.push(model.id);
            }
            if (!ws.activeModelId) {
                ws.activeModelId = model.id;
            }
            this.pushAppState(this.appState);
        }
    }

    removeModelFromWorkspace(modelId: string, wsId?: string): void {
        const targetWsId = wsId || this.appState.activeWorkspaceId;
        const ws = this.appState.workspaces.find(w => w.id === targetWsId);
        if (ws) {
            ws.modelIds = ws.modelIds.filter(id => id !== modelId);
            if (ws.activeModelId === modelId) {
                ws.activeModelId = ws.modelIds.length > 0 ? ws.modelIds[0] : null;
            }
            // Clean up workspace level connections that referenced this model's nodes
            const model = this.appState.models[modelId];
            if (model) {
                const nodeIds = new Set(model.nodes.map(n => n.id));
                ws.connections = ws.connections.filter(c => !nodeIds.has(c.fromNode) && !nodeIds.has(c.toNode));
            }
            // Clean up model from appState if not referenced by any workspace
            const isUsed = this.appState.workspaces.some(w => w.modelIds.includes(modelId));
            if (!isUsed) {
                delete this.appState.models[modelId];
            }
            this.pushAppState(this.appState);
        }
    }

    setActiveModel(modelId: string): void {
        const ws = this.getActiveWorkspace();
        if (ws) {
            let changed = false;
            if (!ws.modelIds.includes(modelId) && this.appState.models[modelId]) {
                ws.modelIds.push(modelId);
                changed = true;
            }
            if (this.appState.models[modelId]) {
                if (ws.activeModelId !== modelId) {
                    ws.activeModelId = modelId;
                    changed = true;
                }
                const activeNodes = this.appState.models[modelId].nodes || [];
                if (this.selectedNodeId && !activeNodes.some(n => n.id === this.selectedNodeId)) {
                    this.selectedNodeId = null;
                }
                try {
                    localStorage.setItem('blast_pipeline_active_model_id', modelId);
                } catch (e) {}
                if (changed) {
                    this.pushAppState(this.appState);
                }
            }
        }
    }

    renameModel(modelId: string, name: string): void {
        const model = this.appState.models[modelId];
        if (model) {
            model.name = name;
            this.pushAppState(this.appState);
        }
    }

    moveModelInWorkspace(modelId: string, direction: 'top' | 'up' | 'down' | 'bottom'): void {
        const ws = this.getActiveWorkspace();
        if (!ws) return;

        const idx = ws.modelIds.indexOf(modelId);
        if (idx === -1) return;

        const newModelIds = [...ws.modelIds];
        if (direction === 'top') {
            if (idx === 0) return;
            const [item] = newModelIds.splice(idx, 1);
            newModelIds.unshift(item);
        } else if (direction === 'up') {
            if (idx === 0) return;
            const [item] = newModelIds.splice(idx, 1);
            newModelIds.splice(idx - 1, 0, item);
        } else if (direction === 'down') {
            if (idx === newModelIds.length - 1) return;
            const [item] = newModelIds.splice(idx, 1);
            newModelIds.splice(idx + 1, 0, item);
        } else if (direction === 'bottom') {
            if (idx === newModelIds.length - 1) return;
            const [item] = newModelIds.splice(idx, 1);
            newModelIds.push(item);
        }

        ws.modelIds = newModelIds;
        this.pushAppState(this.appState);
    }

    reorderModelsInWorkspace(reorderedIds: string[]): void {
        const ws = this.getActiveWorkspace();
        if (!ws) return;

        const currentSet = new Set(ws.modelIds);
        const filtered = reorderedIds.filter(id => currentSet.has(id));
        ws.modelIds.forEach(id => {
            if (!filtered.includes(id)) filtered.push(id);
        });

        ws.modelIds = filtered;
        this.pushAppState(this.appState);
    }

    copyModelToClipboard(modelId: string): void {
        const model = this.appState.models[modelId];
        if (model) {
            this.clipboardModel = JSON.parse(JSON.stringify(model));
        }
    }

    private getUniqueNodeIdFromBase(baseId: string, tempExistingIds: Set<string>): string {
        const prefix = baseId.replace(/-\d+$/, '');
        let newId = baseId;
        if (tempExistingIds.has(newId)) {
            let index = 1;
            newId = `${prefix}-${index}`;
            while (tempExistingIds.has(newId)) {
                index++;
                newId = `${prefix}-${index}`;
            }
        }
        tempExistingIds.add(newId);
        return newId;
    }

    getClipboardModel(): Model | null {
        return this.clipboardModel;
    }

    private getUniqueNodeId(type: NodeType, tempExistingIds: Set<string>): string {
        const prefixMap: Record<NodeType, string> = {
            'DomainMesh': 'node-mesh',
            'Material': 'node-material',
            'Charge1D': 'node-charge1d',
            'Charge2D': 'node-charge2d',
            'ThePainter': 'node-painter',
            'CFDSolver': 'node-solver',
            'TelemetryText': 'node-log',
            'TelemetryGraph': 'node-chart',
            'DomainMesh2D': 'node-mesh2d',
            'DetonatorLocation': 'node-detonator',
            'DetonatorLocation3D': 'node-detonator',
            'RemapNode': 'node-remap',
            'Remap1DTo2DNode': 'node-remap',
            'Remap1DTo3DNode': 'node-remap',
            'Remap2DTo3DNode': 'node-remap',
            'HardwareConfig': 'node-hardware',
            'CFDSolver2D': 'node-solver2d',
            'TelemetryContour': 'node-contour',
            'VTKOutput': 'node-vtk',
            'VirtualGauges': 'node-gauges',
            'DomainMesh3D': 'node-mesh3d',
            'Charge3D': 'node-charge3d',
            'CFDSolver3D': 'node-solver3d',
            'Telemetry3DViewport': 'node-viewport3d',
            'STLGeometry': 'node-stl',
            'PrimitiveGeometry3D': 'node-stl',
            'MPMDomain2D': 'node-mpm-domain',
            'MPMDomain3D': 'node-mpm-domain3d',
            'MPMObject2D': 'node-mpm-obj',
            'MPMObject3D': 'node-mpm-obj3d',
            'FSICoupler2D': 'node-fsi-coupler',
            'FSICoupler3D': 'node-fsi-coupler3d',
            'RefinementMesh3D': 'node-refinement3d',
            'FEMDomain3D': 'node-fem-domain3d',
            'FEMObject3D': 'node-fem-obj3d',
            'FEMBeam3D': 'node-fem-beam3d',
            'FEMRebar3D': 'node-fem-rebar3d',
            'Obstacle': 'node-obstacle',
            'Obstacle3D': 'node-obstacle3d',
            'LSDynaImporter3D': 'node-lsdyna-importer3d',
            'FEMFSICoupler3D': 'node-fem-fsi-coupler3d'
        };
        const prefix = prefixMap[type] || `node-${type.toLowerCase()}`;

        let index = 1;
        if (tempExistingIds.has(prefix)) {
            index = 2;
        }
        while (tempExistingIds.has(`${prefix}-${index}`)) {
            index++;
        }
        const newId = index === 1 && !tempExistingIds.has(prefix) ? prefix : `${prefix}-${index}`;
        tempExistingIds.add(newId);
        return newId;
    }

    cloneModelFromClipboard(offsetX: number = 100, offsetY: number = 100): Model | null {
        if (!this.clipboardModel) return null;

        const newModelId = `model-${Math.random().toString(36).substr(2, 9)}`;

        // Unique name
        let newModelName = `${this.clipboardModel.name} (Copy)`;
        let nameConflict = Object.values(this.appState.models).some(m => m.name === newModelName);
        let counter = 1;
        while (nameConflict) {
            newModelName = `${this.clipboardModel.name} (Copy) ${counter}`;
            nameConflict = Object.values(this.appState.models).some(m => m.name === newModelName);
            counter++;
        }

        const modelCount = Object.keys(this.appState.models).length;
        const calcOffsetX = offsetX === 100 ? Math.max(100, modelCount * 550) : offsetX;

        const tempExistingIds = new Set<string>();
        Object.values(this.appState.models).forEach(model => {
            model.nodes.forEach(n => tempExistingIds.add(n.id));
        });

        const idMapping: Record<string, string> = {};
        const duplicatedNodes: Node[] = this.clipboardModel.nodes.map(node => {
            const newNodeId = this.getUniqueNodeIdFromBase(node.id, tempExistingIds);
            idMapping[node.id] = newNodeId;
            return {
                ...JSON.parse(JSON.stringify(node)),
                id: newNodeId,
                x: node.x + calcOffsetX,
                y: node.y + (offsetY !== 0 ? offsetY : 0)
            };
        });

        const duplicatedConnections: Connection[] = this.clipboardModel.connections.map(conn => {
            return {
                fromNode: idMapping[conn.fromNode] || conn.fromNode,
                fromPort: conn.fromPort,
                toNode: idMapping[conn.toNode] || conn.toNode,
                toPort: conn.toPort
            };
        });

        const newModel: Model = {
            id: newModelId,
            name: newModelName,
            filename: this.clipboardModel.filename ? `${this.clipboardModel.filename.replace(/\.[^/.]+$/, "")}_copy.json` : null,
            nodes: duplicatedNodes,
            connections: duplicatedConnections
        };

        this.appState.models[newModelId] = newModel;

        // Initialize statuses
        this.modelStatuses.set(newModelId, 'UNINITIALIZED');
        this.modelProgresses.set(newModelId, 0);
        this.modelSimTimes.set(newModelId, 0.0);
        this.modelDts.set(newModelId, 0.0);

        return newModel;
    }

    pasteModelFromClipboard(offsetX: number = 100, offsetY: number = 100): Model | null {
        const newModel = this.cloneModelFromClipboard(offsetX, offsetY);
        if (!newModel) return null;

        const activeWs = this.getActiveWorkspace();
        if (activeWs) {
            activeWs.modelIds.push(newModel.id);
            activeWs.activeModelId = newModel.id;
        }

        this.pushAppState(this.appState);

        return newModel;
    }

    // Core state sync and history
    getCurrentState(): SimulationState | null {
        const ws = this.getActiveWorkspace();
        if (!ws) return null;
        return this.synthesizeWorkspaceState(ws);
    }

    getSimulationState(targetModelId: string | 'all'): SimulationState | null {
        if (targetModelId === 'all') {
            const ws = this.getActiveWorkspace();
            return ws ? this.synthesizeWorkspaceState(ws) : null;
        }
        const model = this.appState.models[targetModelId];
        const ws = this.getActiveWorkspace();
        if (!ws) return null;
        return {
            nodes: model ? JSON.parse(JSON.stringify(model.nodes)) : [],
            connections: model ? JSON.parse(JSON.stringify(model.connections)) : [],
            layout: JSON.parse(JSON.stringify(ws.layout))
        };
    }

    private synthesizeWorkspaceState(ws: Workspace): SimulationState {
        const nodes: Node[] = [];
        const connections: Connection[] = [];

        ws.modelIds.forEach(mId => {
            const model = this.appState.models[mId];
            if (model) {
                nodes.push(...JSON.parse(JSON.stringify(model.nodes)));
                connections.push(...JSON.parse(JSON.stringify(model.connections)));
            }
        });

        connections.push(...JSON.parse(JSON.stringify(ws.connections)));

        return {
            nodes,
            connections,
            layout: JSON.parse(JSON.stringify(ws.layout))
        };
    }

    pushAppState(newAppState: AppState, autoSave: boolean = true): void {
        const stateCopy = JSON.parse(JSON.stringify(newAppState)) as AppState;
        
        // Heal duplicate node IDs & un-smerge cross-contaminated models
        this.healDuplicateNodeIds(stateCopy);

        // Ensure menu bar exists on all layouts
        stateCopy.workspaces.forEach(ws => {
            ws.layout = ensureMenuBar(ws.layout);
            ws.modelIds = Array.from(new Set(ws.modelIds));
        });

        // Constrain all slices to their domain boundaries
        Object.values(stateCopy.models).forEach(model => {
            constrainAllSlices(model);
        });

        if (this.currentIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.currentIndex + 1);
        }

        this.history.push(stateCopy);
        if (this.history.length > 50) {
            this.history.shift();
        } else {
            this.currentIndex++;
        }
        this.appState = stateCopy;

        this.notifyListeners();
        if (autoSave) this.saveWorkspace();
    }

    pushState(newState: SimulationState, autoSave: boolean = true): void {
        this.healNodes(newState.nodes, newState);
        const appStateCopy = JSON.parse(JSON.stringify(this.appState)) as AppState;
        const ws = appStateCopy.workspaces.find(w => w.id === appStateCopy.activeWorkspaceId);
        if (!ws) return;

        ws.layout = JSON.parse(JSON.stringify(newState.layout));

        const activeModelId = ws.activeModelId || (ws.modelIds.length > 0 ? ws.modelIds[0] : null);
        if (!activeModelId) {
            this.pushAppState(appStateCopy, autoSave);
            return;
        }

        // Heal duplicate node IDs first so that node IDs are strictly unique across all models
        this.healDuplicateNodeIds(appStateCopy);

        // Build a mapping of which model owns which existing node ID
        const nodeOwnerMap = new Map<string, string>();
        Object.entries(appStateCopy.models).forEach(([mId, model]) => {
            model.nodes.forEach(n => nodeOwnerMap.set(n.id, mId));
        });

        // Group incoming nodes by their owner model (or default to activeModel if newly created)
        const modelNodesMap = new Map<string, Node[]>();
        ws.modelIds.forEach(mId => {
            modelNodesMap.set(mId, []);
        });

        newState.nodes.forEach(node => {
            const ownerModelId = nodeOwnerMap.get(node.id) || activeModelId;
            if (modelNodesMap.has(ownerModelId)) {
                modelNodesMap.get(ownerModelId)!.push(node);
            } else if (appStateCopy.models[ownerModelId]) {
                if (!modelNodesMap.has(ownerModelId)) {
                    modelNodesMap.set(ownerModelId, []);
                }
                modelNodesMap.get(ownerModelId)!.push(node);
            } else {
                if (modelNodesMap.has(activeModelId)) {
                    modelNodesMap.get(activeModelId)!.push(node);
                }
            }
        });

        // Update each workspace model's nodes and internal connections
        const allWorkspaceNodeIds = new Set<string>();

        ws.modelIds.forEach(mId => {
            const model = appStateCopy.models[mId];
            if (!model) return;

            const updatedNodes = modelNodesMap.get(mId) || [];
            if (updatedNodes.length > 0) {
                model.nodes = updatedNodes;
                const modelNodeIds = new Set(updatedNodes.map(n => n.id));
                updatedNodes.forEach(n => allWorkspaceNodeIds.add(n.id));

                // Internal connections
                model.connections = newState.connections.filter(c => modelNodeIds.has(c.fromNode) && modelNodeIds.has(c.toNode));
            } else {
                model.nodes.forEach(n => allWorkspaceNodeIds.add(n.id));
            }
        });

        // Cross-model connections within the workspace
        const wsConnections: Connection[] = [];
        newState.connections.forEach(conn => {
            if (allWorkspaceNodeIds.has(conn.fromNode) && allWorkspaceNodeIds.has(conn.toNode)) {
                // Check if it's already an internal connection of any model
                const isInternal = ws.modelIds.some(mId => {
                    const model = appStateCopy.models[mId];
                    if (!model) return false;
                    const nodeIds = new Set(model.nodes.map(n => n.id));
                    return nodeIds.has(conn.fromNode) && nodeIds.has(conn.toNode);
                });
                if (!isInternal) {
                    const exists = wsConnections.some(c =>
                        c.fromNode === conn.fromNode && c.fromPort === conn.fromPort &&
                        c.toNode === conn.toNode && c.toPort === conn.toPort
                    );
                    if (!exists) {
                        wsConnections.push(conn);
                    }
                }
            }
        });

        ws.connections = wsConnections;

        this.pushAppState(appStateCopy, autoSave);
    }

    updateState(state: SimulationState, pushToHistory: boolean = true): void {
        if (pushToHistory) {
            this.pushState(state);
        } else {
            this.pushState(state, false);
        }
    }

    undo(): SimulationState | null {
        if (this.currentIndex > 0) {
            this.currentIndex--;
            this.appState = JSON.parse(JSON.stringify(this.history[this.currentIndex]));
            this.notifyListeners();
            this.saveWorkspace();
            return this.getCurrentState();
        }
        return null;
    }

    redo(): SimulationState | null {
        if (this.currentIndex < this.history.length - 1) {
            this.currentIndex++;
            this.appState = JSON.parse(JSON.stringify(this.history[this.currentIndex]));
            this.notifyListeners();
            this.saveWorkspace();
            return this.getCurrentState();
        }
        return null;
    }

    updateNodeParameters(nodeId: string, parameters: Record<string, any>): void {
        console.log("[DEBUG] updateNodeParameters called for node:", nodeId, "params:", parameters);
        const appStateCopy = JSON.parse(JSON.stringify(this.appState)) as AppState;
        let found = false;
        let targetModelId: string | null = null;
        let isPhysicalChange = false;
        
        for (const model of Object.values(appStateCopy.models)) {
            const node = model.nodes.find(n => n.id === nodeId);
            if (node) {
                targetModelId = model.id;
                const merged = { ...node.parameters, ...parameters };
                const updatedKey = Object.keys(parameters).find(k => k === 'material_model' || k === 'preset' || k === 'composition' || k === 'charge_mass' || k === 'device' || k === 'precision') || Object.keys(parameters)[0];
                syncExplosiveParameters(node, merged, model, updatedKey);
                syncMPMMaterialParameters(node, merged, updatedKey);
                syncFEMObjectParameters(node, merged, updatedKey);
                syncQuantityRanges(node, parameters, merged);
                node.parameters = merged;
                syncCoupledHardwareParameters(model, node, updatedKey);
                console.log("[DEBUG] Node parameters updated in memory. New parameters:", node.parameters);
                
                if (node.type === 'Material') {
                    const dependentConns = model.connections.filter(c => c.fromNode === node.id && c.toPort === 'material');
                    dependentConns.forEach(c => {
                        const depNode = model.nodes.find(n => n.id === c.toNode);
                        if (depNode && (depNode.type === 'Charge1D' || depNode.type === 'Charge2D' || depNode.type === 'Charge3D')) {
                            syncExplosiveParameters(depNode, depNode.parameters, model, 'rho');
                        }
                    });
                }
                
                if (!NON_PHYSICAL_NODE_TYPES.has(node.type)) {
                    for (const key of Object.keys(parameters)) {
                        if (!DISPLAY_ONLY_KEYS.has(key)) {
                            isPhysicalChange = true;
                            break;
                        }
                    }
                }
                
                found = true;
                break;
            }
        }

        if (found) {
            if (targetModelId && isPhysicalChange) {
                this.setModelStatus(targetModelId, 'UNINITIALIZED');
                this.setModelProgress(targetModelId, 0);
            }
            const activeNode = this.getCurrentState()?.nodes.find(n => n.id === nodeId);
            if (activeNode?.type === 'TelemetryText') {
                this.reformatTelemetryTextNode(nodeId);
            }
            this.pushAppState(appStateCopy);
        } else {
            console.error("[DEBUG] Node NOT found for parameter update:", nodeId);
        }
    }

    updateNodeParametersInPlace(nodeId: string, parameters: Record<string, any>): void {
        let found = false;
        let changed = false;
        let targetModelId: string | null = null;
        let isPhysicalChange = false;
        
        for (const model of Object.values(this.appState.models)) {
            const node = model.nodes.find(n => n.id === nodeId);
            if (node) {
                targetModelId = model.id;
                const merged = { ...node.parameters, ...parameters };
                const updatedKey = Object.keys(parameters).find(k => k === 'material_model' || k === 'preset' || k === 'composition' || k === 'charge_mass' || k === 'device' || k === 'precision') || Object.keys(parameters)[0];
                syncExplosiveParameters(node, merged, model, updatedKey);
                syncMPMMaterialParameters(node, merged, updatedKey);
                syncFEMObjectParameters(node, merged, updatedKey);
                syncQuantityRanges(node, parameters, merged);
                
                for (const [key, value] of Object.entries(merged)) {
                    if (node.parameters[key] !== value) {
                        node.parameters[key] = value;
                        changed = true;
                    }
                }

                if (!NON_PHYSICAL_NODE_TYPES.has(node.type)) {
                    for (const key of Object.keys(parameters)) {
                        if (!DISPLAY_ONLY_KEYS.has(key)) {
                            isPhysicalChange = true;
                            break;
                        }
                    }
                }

                if (syncCoupledHardwareParameters(model, node, updatedKey)) {
                    changed = true;
                    if (updatedKey === 'device' || updatedKey === 'precision') {
                        isPhysicalChange = true;
                    }
                }

                if (constrainAllSlices(model)) {
                    changed = true;
                }
                
                if (node.type === 'Material') {
                    const dependentConns = model.connections.filter(c => c.fromNode === node.id && c.toPort === 'material');
                    dependentConns.forEach(c => {
                        const depNode = model.nodes.find(n => n.id === c.toNode);
                        if (depNode && (depNode.type === 'Charge1D' || depNode.type === 'Charge2D' || depNode.type === 'Charge3D')) {
                            const oldRadius = depNode.parameters['charge_radius'];
                            syncExplosiveParameters(depNode, depNode.parameters, model, 'rho');
                            if (depNode.parameters['charge_radius'] !== oldRadius) {
                                changed = true;
                                isPhysicalChange = true;
                            }
                        }
                    });
                }
                
                found = true;
                break;
            }
        }

        if (found && changed) {
            if (targetModelId && isPhysicalChange) {
                this.setModelStatus(targetModelId, 'UNINITIALIZED');
                this.setModelProgress(targetModelId, 0);
            }
            const activeNode = this.getCurrentState()?.nodes.find(n => n.id === nodeId);
            if (activeNode?.type === 'TelemetryText') {
                this.reformatTelemetryTextNode(nodeId);
            }
            this.saveWorkspaceDebounced();
            this.notifyInPlaceParameterListeners(nodeId, parameters);
        }
    }

    public reformatTelemetryTextNode(nodeId: string): void {
        const rawList = this.rawTelemetryStore.get(nodeId) || [];
        const state = this.getCurrentState();
        const node = state?.nodes.find(n => n.id === nodeId);
        if (!node) return;
        const newLogs: string[] = [];
        for (const item of rawList) {
            const line = this.formatTelemetry(item.data, item.modelId, node);
            if (line) newLogs.push(line);
        }
        const cap = Number(node.parameters?.buffer_capacity || 100);
        while (newLogs.length > cap) newLogs.shift();
        this.telemetryStore.set(nodeId, newLogs);
        this.notifyTelemetryUpdate(nodeId, newLogs);
    }

    toggleNodeDisplayMode(nodeId: string): void {
        const state = this.getCurrentState();
        if (!state) return;

        const node = state.nodes.find(n => n.id === nodeId);
        if (node) {
            const modes: ('compact' | 'normal' | 'expanded')[] = ['normal', 'expanded', 'compact'];
            const currentMode = (node.displayMode === 'full-panel' ? 'expanded' : node.displayMode) || 'expanded';
            const nextIndex = (modes.indexOf(currentMode) + 1) % modes.length;
            const nextMode = modes[nextIndex];
            node.displayMode = nextMode;

            if (node.type === 'TelemetryText' || node.type === 'TelemetryGraph' || node.type === 'TelemetryContour') {
                if (nextMode === 'compact') {
                    node.width = 180;
                    node.height = 40;
                } else if (nextMode === 'normal') {
                    node.width = node.type === 'TelemetryContour' ? 420 : 250;
                    if (node.type === 'TelemetryContour') {
                        node.height = 300;
                    } else {
                        node.height = node.type === 'TelemetryGraph' ? 150 : 130;
                    }
                } else if (nextMode === 'expanded') {
                    node.width = node.type === 'TelemetryContour' ? 420 : 350;
                    if (node.type === 'TelemetryContour') {
                        node.height = 300;
                    } else {
                        node.height = 220;
                    }
                }
            } else {
                delete node.width;
                delete node.height;
            }

            this.pushState(state);
        }
    }

    onStateChange(listener: (state: SimulationState) => void): void {
        this.listeners.push(listener);
    }

    offStateChange(listener: (state: SimulationState) => void): void {
        this.listeners = this.listeners.filter(l => l !== listener);
    }

    getStatus(): SimulationStatus {
        return this.simulationStatus;
    }

    setStatus(status: SimulationStatus): void {
        if (this.simulationStatus !== status) {
            this.simulationStatus = status;
            this.notifyStatusListeners();
        }
    }

    onStatusChange(listener: (status: SimulationStatus) => void): void {
        this.statusListeners.push(listener);
    }

    offStatusChange(listener: (status: SimulationStatus) => void): void {
        this.statusListeners = this.statusListeners.filter(l => l !== listener);
    }

    onTelemetryUpdate(listener: (nodeId: string, data: any) => void): void {
        this.telemetryListeners.push(listener);
    }

    offTelemetryUpdate(listener: (nodeId: string, data: any) => void): void {
        this.telemetryListeners = this.telemetryListeners.filter(l => l !== listener);
    }

    onSelectionChange(listener: (nodeId: string | null) => void): void {
        this.selectionListeners.push(listener);
    }

    offSelectionChange(listener: (nodeId: string | null) => void): void {
        this.selectionListeners = this.selectionListeners.filter(l => l !== listener);
    }

    onInPlaceParameterChange(listener: (nodeId: string, parameters: Record<string, any>) => void): void {
        this.inPlaceParameterListeners.push(listener);
    }

    offInPlaceParameterChange(listener: (nodeId: string, parameters: Record<string, any>) => void): void {
        this.inPlaceParameterListeners = this.inPlaceParameterListeners.filter(l => l !== listener);
    }

    private notifyInPlaceParameterListeners(nodeId: string, parameters: Record<string, any>): void {
        this.inPlaceParameterListeners.forEach(l => {
            try { l(nodeId, parameters); } catch (e) { console.error(e); }
        });
    }

    onSliceSelectionChange(listener: (sliceIdx: number | null) => void): void {
        this.sliceSelectionListeners.push(listener);
    }

    offSliceSelectionChange(listener: (sliceIdx: number | null) => void): void {
        this.sliceSelectionListeners = this.sliceSelectionListeners.filter(l => l !== listener);
    }

    setSelectedNode(nodeId: string | null): void {
        if (this.selectedNodeId !== nodeId) {
            this.selectedNodeId = nodeId;
            if (nodeId) {
                const allModels = this.getWorkspaceModels();
                const owningModel = allModels.find(m => m.nodes.some(n => n.id === nodeId));
                const ws = this.getActiveWorkspace();
                if (owningModel && ws && ws.activeModelId !== owningModel.id) {
                    this.setActiveModel(owningModel.id);
                }
            }
            this.selectionListeners.forEach(l => l(nodeId));
            if (nodeId !== this.selectedNodeId) {
                this.selectedGaugeIndex = null;
            }
        }
    }

    setSelectedSliceIndex(sliceIdx: number | null): void {
        if (this.selectedSliceIndex !== sliceIdx) {
            this.selectedSliceIndex = sliceIdx;
            this.sliceSelectionListeners.forEach(l => l(sliceIdx));
        }
    }

    setSelectedGaugeIndex(gaugeIdx: number | null): void {
        if (this.selectedGaugeIndex !== gaugeIdx) {
            this.selectedGaugeIndex = gaugeIdx;
            this.gaugeSelectionListeners.forEach(l => l(gaugeIdx));
        }
    }

    onGaugeSelectionChange(listener: (gaugeIdx: number | null) => void): void {
        this.gaugeSelectionListeners.push(listener);
    }

    offGaugeSelectionChange(listener: (gaugeIdx: number | null) => void): void {
        this.gaugeSelectionListeners = this.gaugeSelectionListeners.filter(l => l !== listener);
    }

    getSelectedNodeId(): string | null {
        return this.selectedNodeId;
    }

    getSelectedSliceIndex(): number | null {
        return this.selectedSliceIndex;
    }

    getSelectedGaugeIndex(): number | null {
        return this.selectedGaugeIndex;
    }

    onHoverChange(listener: (nodeId: string | null, sliceIdx: number | null) => void): void {
        this.hoverListeners.push(listener);
    }

    offHoverChange(listener: (nodeId: string | null, sliceIdx: number | null) => void): void {
        this.hoverListeners = this.hoverListeners.filter(l => l !== listener);
    }

    setHoveredNode(nodeId: string | null, sliceIdx: number | null = null): void {
        if (this.hoveredNodeId !== nodeId || this.hoveredSliceIndex !== sliceIdx) {
            this.hoveredNodeId = nodeId;
            this.hoveredSliceIndex = sliceIdx;
            this.hoverListeners.forEach(l => l(nodeId, sliceIdx));
        }
    }

    getHoveredNodeId(): string | null {
        return this.hoveredNodeId;
    }

    getHoveredSliceIndex(): number | null {
        return this.hoveredSliceIndex;
    }

    onFocusedViewportChange(listener: (viewportNodeId: string | null, panelId: string | null) => void): void {
        this.focusedViewportListeners.push(listener);
    }

    offFocusedViewportChange(listener: (viewportNodeId: string | null, panelId: string | null) => void): void {
        this.focusedViewportListeners = this.focusedViewportListeners.filter(l => l !== listener);
    }

    setFocusedViewport(viewportNodeId: string | null, panelId: string | null = null): void {
        if (this.focusedViewportNodeId !== viewportNodeId || this.focusedViewportPanelId !== panelId) {
            this.focusedViewportNodeId = viewportNodeId;
            this.focusedViewportPanelId = panelId;
            this.focusedViewportListeners.forEach(l => l(viewportNodeId, panelId));
        }
    }

    getFocusedViewportId(): string | null {
        return this.focusedViewportNodeId;
    }

    getFocusedViewportPanelId(): string | null {
        return this.focusedViewportPanelId;
    }

    getTelemetry(nodeId: string): any {
        return this.telemetryStore.get(nodeId);
    }

    addPendingSteps(steps: number): void {
        this.pendingSteps += steps;
    }

    getPendingSteps(): number {
        return this.pendingSteps;
    }

    clearPendingSteps(): void {
        this.pendingSteps = 0;
    }

    private notifyStatusListeners(): void {
        this.statusListeners.forEach(listener => listener(this.simulationStatus));
    }

    private notifyTelemetryUpdate(nodeId: string, data: any): void {
        this.telemetryListeners.forEach(listener => listener(nodeId, data));
    }

    public getLatestMetric(nodeId: string): { data: any; modelId?: string } | null {
        return this.latestMetricStore.get(nodeId) || null;
    }

    public formatTelemetryCard(data: any, modelId?: string, textNode?: Node | null): string {
        const step = data.step ?? (data.fem_step ?? this.getModelStep(modelId));
        const timeVal = Number(data.time ?? 0);
        const timeStr = timeVal.toExponential(4);
        const dtVal = data.dt !== undefined ? Number(data.dt) : (this.getModelDt(modelId) || 0);
        const dtStr = dtVal > 0 ? dtVal.toExponential(3) : '---';
        const timestamp = new Date().toLocaleTimeString();

        const timing = this.getModelTelemetryTiming(modelId);
        const stepDelta = Math.max(1, timing.stepDelta);

        const physMs = timing.smoothedComputeMs !== undefined && timing.smoothedComputeMs > 0
            ? timing.smoothedComputeMs
            : Number(data.compute_ms || 0);
        const ioMs = timing.smoothedIoMs !== undefined
            ? timing.smoothedIoMs
            : Number(data.io_ms || 0);
        const commsMs = timing.smoothedCommsMs !== undefined
            ? timing.smoothedCommsMs
            : Number(data.comms_ms || 0);
        const commsPerStep = commsMs / stepDelta;
        const totalMs = physMs + ioMs + commsPerStep;

        const physStr = physMs >= 100 ? physMs.toFixed(0) : physMs.toFixed(1);
        const ioStr = ioMs >= 100 ? ioMs.toFixed(0) : ioMs.toFixed(1);
        const commsStr = commsPerStep >= 100 ? commsPerStep.toFixed(0) : commsPerStep.toFixed(1);

        const throughputVal = timing.smoothedThroughput > 0
            ? Math.round(timing.smoothedThroughput)
            : (totalMs > 0 ? Math.round(1000 / totalMs) : 0);
        const throughputStr = throughputVal > 0 ? `${throughputVal} step/s` : '--';

        const ramStr = Number(data?.ram_mb) > 0 ? (data.ram_mb >= 1024 ? (data.ram_mb / 1024).toFixed(1) + 'G' : Math.round(data.ram_mb) + 'M') : '--';
        const vramStr = Number(data?.vram_mb) > 0 ? (data.vram_mb >= 1024 ? (data.vram_mb / 1024).toFixed(1) + 'G' : Math.round(data.vram_mb) + 'M') : '--';
        const wallStr = data.wallclock !== undefined ? `${Number(data.wallclock).toFixed(2)}s` : '--';

        const line1 = `┌── STEP ${String(step).padEnd(6)} ── Time: ${timeStr} s ── (dt: ${dtStr} s) ─── ${timestamp} ──┐`;
        const innerLen = line1.length - 2;
        const line2 = `│  TIMING:   Phys: ${(physStr + 'ms').padEnd(8)} │ IO: ${(ioStr + 'ms').padEnd(8)} │ Read: ${(commsStr + 'ms').padEnd(8)} │ Total: ${totalMs.toFixed(1)}ms (${throughputStr})`.padEnd(innerLen + 1) + '│';
        const line3 = `│  HARDWARE: Host RAM: ${ramStr.padEnd(8)} │ GPU VRAM: ${vramStr.padEnd(8)} │ Wallclock: ${wallStr}`.padEnd(innerLen + 1) + '│';
        const line4 = `└` + '─'.repeat(innerLen) + `┘`;

        return `${line1}\n${line2}\n${line3}\n${line4}`;
    }

    public formatTelemetryPage(data: any, modelId?: string, textNode?: Node | null): string {
        const model = modelId ? this.getModel(modelId) : this.getActiveModel();
        const modelName = model?.name || 'Model';
        const step = data?.step ?? (data?.fem_step ?? this.getModelStep(modelId));
        const timeVal = Number(data?.time ?? 0);
        const timeStr = timeVal.toExponential(4);
        const dtVal = data?.dt !== undefined ? Number(data.dt) : (this.getModelDt(modelId) || 0);
        const dtStr = dtVal > 0 ? dtVal.toExponential(3) + ' s' : '--';
        const status = (model ? this.getModelStatus(model.id) : 'READY') || 'READY';

        const timing = this.getModelTelemetryTiming(modelId);
        const stepDelta = Math.max(1, timing.stepDelta);

        const physMs = timing.smoothedComputeMs !== undefined && timing.smoothedComputeMs > 0
            ? timing.smoothedComputeMs
            : Number(data?.compute_ms ?? 0);
        const ioMs = timing.smoothedIoMs !== undefined
            ? timing.smoothedIoMs
            : Number(data?.io_ms ?? 0);
        const commsMs = timing.smoothedCommsMs !== undefined
            ? timing.smoothedCommsMs
            : Number(data?.comms_ms ?? 0);
        const commsPerStep = commsMs / stepDelta;
        const totalMs = physMs + ioMs + commsPerStep;

        const throughputVal = timing.smoothedThroughput > 0
            ? Math.round(timing.smoothedThroughput)
            : (totalMs > 0 ? Math.round(1000 / totalMs) : 0);
        const throughput = throughputVal > 0 ? `${throughputVal} step/s` : '--';

        const makeBar = (val: number, total: number, width: number = 16): string => {
            if (total <= 0 || val <= 0) return '░'.repeat(width);
            const ratio = Math.min(1, Math.max(0, val / total));
            const filled = Math.round(ratio * width);
            return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
        };

        const physPct = totalMs > 0 ? ((physMs / totalMs) * 100).toFixed(1) : '0.0';
        const ioPct = totalMs > 0 ? ((ioMs / totalMs) * 100).toFixed(1) : '0.0';
        const commsPct = totalMs > 0 ? ((commsPerStep / totalMs) * 100).toFixed(1) : '0.0';

        const lastVtkMs = timing.lastVtkMs ?? Number(data?.last_vtk_ms ?? 0);
        const lastVtkStep = timing.lastVtkStep ?? Number(data?.last_vtk_step ?? 0);
        const vtkBurstStr = lastVtkMs > 0
            ? `(Last VTK: ${lastVtkMs >= 100 ? lastVtkMs.toFixed(0) : lastVtkMs.toFixed(1)} ms @ st${lastVtkStep})`
            : '';

        const cumComputeS = timing.cumComputeS ?? Number(data?.cum_compute_s ?? 0);
        const cumIoS = timing.cumIoS ?? Number(data?.cum_io_s ?? 0);
        const cumCommsS = timing.cumCommsS ?? Number(data?.cum_comms_s ?? 0);
        const cumTotalS = cumComputeS + cumIoS + cumCommsS;
        const cumPhysPct = cumTotalS > 0 ? ((cumComputeS / cumTotalS) * 100).toFixed(1) : '0.0';
        const cumIoPct = cumTotalS > 0 ? ((cumIoS / cumTotalS) * 100).toFixed(1) : '0.0';
        const cumCommsPct = cumTotalS > 0 ? ((cumCommsS / cumTotalS) * 100).toFixed(1) : '0.0';

        const ramMb = Number(data?.ram_mb ?? 0);
        const vramMb = Number(data?.vram_mb ?? 0);

        const solverNode = model?.nodes.find(n => n.type === 'CFDSolver' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver3D' || n.type === 'MPMDomain2D' || n.type === 'MPMDomain3D' || n.type === 'FEMDomain3D' || n.type === 'FSICoupler2D' || n.type === 'FSICoupler3D' || n.type === 'FEMFSICoupler3D');
        const devParam = solverNode?.parameters?.device;
        const isCuda = devParam === 'cuda' || devParam === 'GPU' || devParam === 'gpu' || (devParam === undefined && solverNode !== undefined);

        const ramStr = ramMb >= 1024 ? (ramMb / 1024).toFixed(2) + ' GB' : (ramMb > 0 ? Math.round(ramMb) + ' MB' : '--');
        const vramStr = vramMb >= 1024 ? (vramMb / 1024).toFixed(2) + ' GB' : (vramMb > 0 ? Math.round(vramMb) + ' MB' : (isCuda ? '--' : 'N/A (CPU)'));

        const wallVal = data?.wallclock !== undefined ? Number(data.wallclock) : 0;
        const mins = Math.floor(wallVal / 60);
        const secs = (wallVal % 60).toFixed(2);
        const wallStr = `${String(mins).padStart(2, '0')}:${Number(secs) < 10 ? '0' : ''}${secs}`;

        const deviceStr = (devParam === 'cuda' ? 'CUDA (GPU)' : (devParam === 'cpu' ? 'CPU' : (isCuda ? 'CUDA (GPU)' : 'Auto'))) + ` [${solverNode?.parameters?.precision || 'single'}]`;

        const W = 68;
        const padLine = (content: string) => `│ ${content.padEnd(W - 4)} │`;

        const lines = [
            `┌─ SIMULATION STATE ` + '─'.repeat(W - 21) + `┐`,
            padLine(`Model: ${modelName.padEnd(20)} Status: ${status} (${deviceStr})`),
            padLine(`Step: ${String(step).padEnd(10)} Sim Time: ${timeStr} s       dt: ${dtStr}`),
            padLine(`Throughput: ${throughput.padEnd(14)} Wallclock: ${wallStr}`),
            `├─ PHASE TIMING (Amortized per step) ` + '─'.repeat(W - 38) + `┤`,
            padLine(`Physics Kernel:     ${physMs.toFixed(1).padStart(5)} ms (${physPct.padStart(5)}%) [${makeBar(physMs, totalMs, 14)}]`),
            padLine(`File / Disk I/O:    ${ioMs.toFixed(1).padStart(5)} ms (${ioPct.padStart(5)}%) [${makeBar(ioMs, totalMs, 14)}]`),
            padLine(stepDelta > 1
                ? `Telemetry Readback: ${commsPerStep.toFixed(1).padStart(5)} ms (${commsPct.padStart(5)}%) [${makeBar(commsPerStep, totalMs, 14)}] /${stepDelta}st`
                : `Telemetry Readback: ${commsPerStep.toFixed(1).padStart(5)} ms (${commsPct.padStart(5)}%) [${makeBar(commsPerStep, totalMs, 14)}]`),
            padLine(vtkBurstStr.length > 0
                ? `Total Step Latency: ${totalMs.toFixed(1).padStart(5)} ms   ${vtkBurstStr}`
                : `Total Step Latency: ${totalMs.toFixed(1).padStart(5)} ms`),
            `├─ CUMULATIVE RUNTIME PROFILE ` + '─'.repeat(W - 31) + `┤`,
            padLine(`Phys: ${cumPhysPct}% │ IO: ${cumIoPct}% │ Read: ${cumCommsPct}% (${cumTotalS.toFixed(2)}s total)`),
            `├─ HARDWARE & MEMORY ` + '─'.repeat(W - 22) + `┤`,
            padLine(`Host System RAM:   ${ramStr.padEnd(12)} (RSS Process Memory)`),
            padLine(`Device GPU VRAM:   ${vramStr.padEnd(12)} (Allocated Context Memory)`),
            `└` + '─'.repeat(W - 2) + `┘`
        ];

        return lines.join('\n');
    }

    public formatTelemetry(data: any, modelId?: string, textNode?: Node | null): string | null {
        const timestamp = new Date().toLocaleTimeString();

        if (data instanceof ArrayBuffer) {
            return `[${timestamp}] [BINARY] ArrayBuffer(${data.byteLength})`;
        }

        const currentStep = this.getModelStep(modelId);
        const filterLevel = textNode?.parameters?.filter_level || 'All';

        if (typeof data === 'string') {
            if (data.startsWith('{')) {
                try {
                    const parsed = JSON.parse(data);
                    return this.formatTelemetry(parsed, modelId, textNode);
                } catch (e) {
                    // Fallthrough to string formatting
                }
            }
            if (filterLevel === 'Metrics Only') return null;
            if (data.includes('Step ') || data.includes('step ') || data.includes('STEP ')) {
                return `[${timestamp}] [TEXT] ${data}`;
            }
            return `[${timestamp}] [TEXT] [Step ${currentStep}] ${data}`;
        }

        if (typeof data === 'object' && data !== null) {
            let step = data.step !== undefined ? data.step : (data.fem_step !== undefined ? data.fem_step : currentStep);
            if (step <= 0 && currentStep > 0) {
                step = currentStep;
            }
            if (step > 0 && modelId) {
                this.setModelStep(modelId, step);

                const now = performance.now();
                let timing = this.modelTelemetryTiming.get(modelId);
                if (timing) {
                    if (step > timing.lastStep && now > timing.lastTimeMs) {
                        const stepDelta = step - timing.lastStep;
                        const elapsedSec = (now - timing.lastTimeMs) / 1000.0;
                        if (elapsedSec > 0) {
                            const instantThroughput = stepDelta / elapsedSec;
                            timing.smoothedThroughput = timing.smoothedThroughput > 0
                                ? (0.7 * timing.smoothedThroughput + 0.3 * instantThroughput)
                                : instantThroughput;
                        }
                        timing.stepDelta = Math.max(1, stepDelta);
                        timing.lastStep = step;
                        timing.lastTimeMs = now;
                    }
                } else {
                    timing = { lastStep: step, lastTimeMs: now, stepDelta: 1, smoothedThroughput: 0 };
                    this.modelTelemetryTiming.set(modelId, timing);
                }

                if (data.compute_ms !== undefined) {
                    const cMs = Number(data.compute_ms);
                    timing.smoothedComputeMs = (timing.smoothedComputeMs !== undefined && timing.smoothedComputeMs > 0)
                        ? (0.85 * timing.smoothedComputeMs + 0.15 * cMs)
                        : cMs;
                }
                if (data.io_ms !== undefined) {
                    const iMs = Number(data.io_ms);
                    timing.smoothedIoMs = (timing.smoothedIoMs !== undefined)
                        ? (0.85 * timing.smoothedIoMs + 0.15 * iMs)
                        : iMs;
                }
                if (data.comms_ms !== undefined) {
                    const cmMs = Number(data.comms_ms);
                    timing.smoothedCommsMs = (timing.smoothedCommsMs !== undefined)
                        ? (0.85 * timing.smoothedCommsMs + 0.15 * cmMs)
                        : cmMs;
                }
                if (data.last_vtk_ms !== undefined) {
                    timing.lastVtkMs = Number(data.last_vtk_ms);
                }
                if (data.last_vtk_step !== undefined) {
                    timing.lastVtkStep = Number(data.last_vtk_step);
                }
                if (data.cum_compute_s !== undefined) {
                    timing.cumComputeS = Number(data.cum_compute_s);
                }
                if (data.cum_io_s !== undefined) {
                    timing.cumIoS = Number(data.cum_io_s);
                }
                if (data.cum_comms_s !== undefined) {
                    timing.cumCommsS = Number(data.cum_comms_s);
                }
            }
            if (data.time !== undefined && modelId) {
                this.setModelSimTime(modelId, Number(data.time));
            }
            if (data.dt !== undefined && modelId) {
                this.setModelDt(modelId, Number(data.dt));
            }

            const isMetric = (data.type === 'TELEMETRY' || data.type === 'TELEMETRY_2D' || data.type === 'TELEMETRY_3D' || data.type === 'TELEMETRY_MPM_2D' || data.type === 'TELEMETRY_FEM_3D');

            if (isMetric) {
                if (filterLevel === 'Logs Only') return null;

                const params = textNode?.parameters || {};
                const streamLayout = params.stream_layout || 'Columnar (Fixed-Width)';

                if (streamLayout === 'Multi-Line Cards') {
                    return this.formatTelemetryCard(data, modelId, textNode);
                }

                if (streamLayout === 'Live Page (In-Place)') {
                    return this.formatTelemetryPage(data, modelId, textNode);
                }

                const timing = this.getModelTelemetryTiming(modelId);
                const stepDelta = Math.max(1, timing.stepDelta);

                if (streamLayout === 'Dual-Deck (Page + Log)') {
                    const physVal = timing.smoothedComputeMs !== undefined && timing.smoothedComputeMs > 0
                        ? timing.smoothedComputeMs
                        : Number(data.compute_ms ?? 0);
                    const physStr = data.compute_ms !== undefined ? `${physVal.toFixed(1)}ms` : '--';
                    const vramStr = Number(data.vram_mb) > 0 ? (data.vram_mb >= 1024 ? (data.vram_mb / 1024).toFixed(1) + 'G' : Math.round(data.vram_mb) + 'M') : '--';
                    return `[${timestamp}] [STEP ${step}] Time: ${Number(data.time ?? 0).toExponential(4)}s, dt: ${data.dt !== undefined ? Number(data.dt).toExponential(3) + 's' : '--'}, Phys: ${physStr}, VRAM: ${vramStr}`;
                }

                if (streamLayout === 'Standard Log') {
                    const tag = data.type === 'TELEMETRY_2D' ? 'CFD' : (data.type === 'TELEMETRY_3D' ? '3D' : (data.type === 'TELEMETRY_MPM_2D' ? 'MPM' : (data.type === 'TELEMETRY_FEM_3D' ? 'FEM' : 'SOLVER')));
                    const wcStr = data.wallclock !== undefined ? `, Wallclock: ${Number(data.wallclock).toFixed(4)}s` : '';
                    const dtStr = data.dt !== undefined ? `, dt: ${Number(data.dt).toExponential(6)}s` : '';
                    return `[${timestamp}] [${tag}] Time: ${Number(data.time ?? 0).toExponential(6)}, Step: ${step}${dtStr}${wcStr}`;
                }

                // Columnar formatting
                const showDt = params.show_dt ?? true;
                const showBreakdown = params.show_timing_breakdown ?? true;
                const showMemory = params.show_memory ?? true;
                const showWall = params.show_wallclock ?? true;
                const tsMode = params.timestamp_mode || 'None';

                let cols: string[] = [];
                if (tsMode === 'Clock') {
                    cols.push(timestamp);
                } else if (tsMode === 'Relative') {
                    cols.push(`+${(performance.now() / 1000).toFixed(2)}s`);
                }

                const physVal = timing.smoothedComputeMs !== undefined && timing.smoothedComputeMs > 0
                    ? timing.smoothedComputeMs
                    : Number(data.compute_ms ?? 0);
                const ioVal = timing.smoothedIoMs !== undefined
                    ? timing.smoothedIoMs
                    : Number(data.io_ms ?? 0);
                const commsMs = timing.smoothedCommsMs !== undefined
                    ? timing.smoothedCommsMs
                    : Number(data.comms_ms ?? 0);
                const commsVal = commsMs / stepDelta;

                if (streamLayout === 'Ultra-Compact') {
                    cols.push(String(step).padStart(6));
                    cols.push(Number(data.time ?? 0).toExponential(2).padStart(8));
                    if (showDt) cols.push((data.dt !== undefined ? Number(data.dt).toExponential(2) : '   ---  ').padStart(8));
                    if (showBreakdown) {
                        const physStr = data.compute_ms !== undefined ? (physVal >= 100 ? physVal.toFixed(0) : physVal.toFixed(1)) + 'm' : '  --  ';
                        const ioStr = data.io_ms !== undefined ? (ioVal >= 100 ? ioVal.toFixed(0) : ioVal.toFixed(1)) + 'm' : '  --  ';
                        cols.push(physStr.padStart(6), ioStr.padStart(6));
                    }
                    if (showMemory) {
                        const vramStr = Number(data.vram_mb) > 0 ? (data.vram_mb >= 1024 ? (data.vram_mb / 1024).toFixed(1) + 'G' : Math.round(data.vram_mb) + 'M') : '  --  ';
                        cols.push(vramStr.padStart(6));
                    }
                    return cols.join(' │ ');
                }

                // Standard Columnar (Fixed-Width)
                cols.push(String(step).padStart(6));
                cols.push(Number(data.time ?? 0).toExponential(3).padStart(10));
                if (showDt) cols.push((data.dt !== undefined ? Number(data.dt).toExponential(2) : '   ---  ').padStart(9));
                if (showBreakdown) {
                    const physStr = data.compute_ms !== undefined ? (physVal >= 100 ? physVal.toFixed(0) : physVal.toFixed(1)) + 'm' : '  --  ';
                    const ioStr = data.io_ms !== undefined ? (ioVal >= 100 ? ioVal.toFixed(0) : ioVal.toFixed(1)) + 'm' : '  --  ';
                    const commsStr = data.comms_ms !== undefined ? (commsVal >= 100 ? commsVal.toFixed(0) : commsVal.toFixed(1)) + 'm' : '  --  ';
                    cols.push(physStr.padStart(6), ioStr.padStart(6), commsStr.padStart(6));
                }
                if (showMemory) {
                    const ramStr = Number(data.ram_mb) > 0 ? (data.ram_mb >= 1024 ? (data.ram_mb / 1024).toFixed(1) + 'G' : Math.round(data.ram_mb) + 'M') : '  --  ';
                    const vramStr = Number(data.vram_mb) > 0 ? (data.vram_mb >= 1024 ? (data.vram_mb / 1024).toFixed(1) + 'G' : Math.round(data.vram_mb) + 'M') : '  --  ';
                    cols.push(ramStr.padStart(6), vramStr.padStart(6));
                }
                if (showWall) {
                    const wallStr = data.wallclock !== undefined ? (Number(data.wallclock).toFixed(2) + 's') : '   --  ';
                    cols.push(wallStr.padStart(7));
                }
                return cols.join(' │ ');
            }

            if (data.type === 'log') {
                if (filterLevel === 'Metrics Only') return null;
                const level = data.level || 'INFO';
                const scope = data.scope ? `[${data.scope}] ` : '';
                const msg = data.message || '';
                const hasStepInMsg = msg.includes('Step ') || msg.includes('step ') || msg.includes('STEP ');
                const stepStr = (!hasStepInMsg && step > 0) ? `[Step ${step}] ` : '';
                const timeStr = data.time !== undefined ? `[t=${Number(data.time).toExponential(4)}s] ` : '';
                const tsMode = textNode?.parameters?.timestamp_mode || 'None';
                const tsStr = (tsMode !== 'None') ? `[${timestamp}] ` : '';
                return `${tsStr}[${level}] ${scope}${stepStr}${timeStr}${msg}`;
            }

            if (data.type === 'progress' || data.type === 'progress_2d' || data.command === 'PROGRESS') {
                const percent = data.percent !== undefined ? data.percent : (data.value || 0);
                const wcStr = data.wallclock !== undefined ? `, Wallclock: ${Number(data.wallclock).toFixed(4)}s` : '';
                return `[${timestamp}] [PROGRESS] ${percent}% complete, Step: ${step}${wcStr}`;
            }

            if (data.type === 'resource_pulse') {
                return `[${timestamp}] [RESOURCES] CPU: ${data.metrics?.cpu?.toFixed(1)}%, RAM: ${data.metrics?.ram?.toFixed(1)}%`;
            }

            return `[${timestamp}] [JSON] ${JSON.stringify(data, null, 2)}`;
        }

        return `[${timestamp}] [DATA] [Step ${currentStep}] ${String(data)}`;
    }

    pushTelemetry(nodeIdOrData: any, optionalData?: any, modelId?: string): void {
        let nodeId: string | null = null;
        let data: any = null;

        const state = this.getCurrentState();
        if (!state) return;

        const model = modelId ? this.appState.models[modelId] : null;
        const nodes = model ? model.nodes : state.nodes;
        const connections = model ? model.connections : state.connections;

        if (typeof nodeIdOrData === 'string' && optionalData !== undefined) {
            nodeId = nodeIdOrData;
            data = optionalData;
        } else if (typeof nodeIdOrData === 'string') {
            const solverNode = nodes.find(n => n.type === 'CFDSolver' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver3D' || n.type === 'MPMDomain2D' || n.type === 'MPMDomain3D' || n.type === 'FSICoupler2D' || n.type === 'FSICoupler3D' || n.type === 'FEMDomain3D' || n.type === 'FEMFSICoupler3D');
            if (!solverNode) return;
            nodeId = solverNode.id;
            data = nodeIdOrData;
        } else {
            const solverNode = nodes.find(n => n.id === 'node-solver') || nodes.find(n => n.type === 'CFDSolver' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver3D' || n.type === 'MPMDomain2D' || n.type === 'MPMDomain3D' || n.type === 'FSICoupler2D' || n.type === 'FSICoupler3D' || n.type === 'FEMDomain3D' || n.type === 'FEMFSICoupler3D');
            if (!solverNode) return;
            nodeId = solverNode.id;
            data = nodeIdOrData;
        }

        if (!nodeId) return;

        const targetNode = nodes.find(n => n.id === nodeId);
        let telemetryToStore = data;
        if ((targetNode?.type === 'TelemetryText' || targetNode?.type === 'CFDSolver' || targetNode?.type === 'CFDSolver2D' || targetNode?.type === 'CFDSolver3D' || targetNode?.type === 'MPMDomain2D' || targetNode?.type === 'MPMDomain3D' || targetNode?.type === 'FSICoupler2D' || targetNode?.type === 'FSICoupler3D' || targetNode?.type === 'FEMDomain3D' || targetNode?.type === 'FEMFSICoupler3D') && !(data instanceof ArrayBuffer)) {
            if (data && typeof data === 'object' && (data.type === 'progress' || data.type === 'progress_2d' || data.type === 'resource_pulse')) {
                 // Skip
            } else {
                let log = this.telemetryStore.get(nodeId);
                if (!Array.isArray(log)) log = [];
                log.push(this.formatTelemetry(data, modelId));
                if (log.length > 100) log.shift();
                telemetryToStore = log;
            }
        }

        this.telemetryStore.set(nodeId, telemetryToStore);
        this.notifyTelemetryUpdate(nodeId, telemetryToStore);

        const telemetryConnections = connections.filter(e => e.fromNode === nodeId);
        const updatedNodeIds = new Set<string>();

        telemetryConnections.forEach(connection => {
            const connectedNode = nodes.find(n => n.id === connection.toNode);
            if (connectedNode) {
                updatedNodeIds.add(connectedNode.id);
                if (connectedNode.type === 'TelemetryGraph') {
                    const is3DBuf = data instanceof ArrayBuffer && data.byteLength >= 4 && (() => {
                        const m = new DataView(data).getUint32(0, true);
                        return m === 0x46454d33 || m === 0x4d504d33 || m === 0x43494c53 || m === 0x4253544c || m === 0x424f4253;
                    })();
                    if ((data instanceof ArrayBuffer && !is3DBuf) || (data && (data.type === 'TELEMETRY' || data.type === 'TELEMETRY_2D' || data.type === 'TELEMETRY_3D' || data.type === 'TELEMETRY_MPM_2D' || data.type === 'TELEMETRY_FEM_3D'))) {
                         this.telemetryStore.set(connectedNode.id, data);
                         this.notifyTelemetryUpdate(connectedNode.id, data);
                    }
                } else if (connectedNode.type === 'VirtualGauges') {
                    if (data && !(data instanceof ArrayBuffer) && data.gauges_history) {
                         this.telemetryStore.set(connectedNode.id, data.gauges_history);
                         this.notifyTelemetryUpdate(connectedNode.id, data.gauges_history);
                    }
                } else if (connectedNode.type === 'TelemetryContour' || connectedNode.type === 'Telemetry3DViewport') {
                    if (data instanceof ArrayBuffer || (data && (data.type === 'TELEMETRY_3D' || data.type === 'TELEMETRY_2D' || data.type === 'TELEMETRY_MPM_2D' || data.type === 'TELEMETRY_FEM_3D'))) {
                         this.telemetryStore.set(connectedNode.id, data);
                         if (data && (data.type === 'TELEMETRY_3D' || data.type === 'TELEMETRY_FEM_3D')) {
                             this.telemetryStore.set(connectedNode.id + "-config-3d", data);
                         }
                         this.notifyTelemetryUpdate(connectedNode.id, data);
                    }
                } else if (connectedNode.type === 'TelemetryText') {
                    if (data instanceof ArrayBuffer) return;
                    if (data && typeof data === 'object' && data.type === 'resource_pulse') {
                        return;
                    }

                    if (data && typeof data === 'object' && (data.type === 'TELEMETRY' || data.type === 'TELEMETRY_2D' || data.type === 'TELEMETRY_3D' || data.type === 'TELEMETRY_MPM_2D' || data.type === 'TELEMETRY_FEM_3D')) {
                        this.latestMetricStore.set(connectedNode.id, { data, modelId });
                    }

                    let rawList = this.rawTelemetryStore.get(connectedNode.id);
                    if (!Array.isArray(rawList)) rawList = [];
                    rawList.push({ data, modelId });
                    const bufferCap = Number(connectedNode.parameters?.buffer_capacity || 100);
                    if (rawList.length > bufferCap) rawList.shift();
                    this.rawTelemetryStore.set(connectedNode.id, rawList);

                    let log = this.telemetryStore.get(connectedNode.id);
                    if (!Array.isArray(log)) log = [];

                    const formattedMsg = this.formatTelemetry(data, modelId, connectedNode);
                    if (formattedMsg !== null) {
                        if (log.length > 0 && log[log.length - 1] === formattedMsg) return;
                        log.push(formattedMsg);
                        if (log.length > bufferCap) log.shift();
                        this.telemetryStore.set(connectedNode.id, log);
                        this.notifyTelemetryUpdate(connectedNode.id, log);
                    }
                }
            }
        });

        // Cache binary particle/mesh/contour frames in telemetry store for Telemetry3DViewport and TelemetryContour nodes
        if (data instanceof ArrayBuffer) {
            const visualNodes = nodes.filter(n => n.type === 'Telemetry3DViewport' || n.type === 'TelemetryContour');
            visualNodes.forEach(vNode => {
                this.telemetryStore.set(vNode.id, data);
                this.notifyTelemetryUpdate(vNode.id, data);
            });
        }

        // Ensure text logs and telemetry events are broadcast to all TelemetryText nodes in the model
        if (!(data instanceof ArrayBuffer) && !(data && typeof data === 'object' && (data.type === 'resource_pulse' || data.type === 'progress' || data.type === 'progress_2d'))) {
            const textNodes = nodes.filter(n => n.type === 'TelemetryText');
            textNodes.forEach(textNode => {
                if (textNode.id === nodeId || updatedNodeIds.has(textNode.id)) return;
                if (data && typeof data === 'object' && (data.type === 'TELEMETRY' || data.type === 'TELEMETRY_2D' || data.type === 'TELEMETRY_3D' || data.type === 'TELEMETRY_MPM_2D' || data.type === 'TELEMETRY_FEM_3D')) {
                    this.latestMetricStore.set(textNode.id, { data, modelId });
                }
                let rawList = this.rawTelemetryStore.get(textNode.id);
                if (!Array.isArray(rawList)) rawList = [];
                rawList.push({ data, modelId });
                const bufferCap = Number(textNode.parameters?.buffer_capacity || 100);
                if (rawList.length > bufferCap) rawList.shift();
                this.rawTelemetryStore.set(textNode.id, rawList);

                let log = this.telemetryStore.get(textNode.id);
                if (!Array.isArray(log)) log = [];
                const formattedMsg = this.formatTelemetry(data, modelId, textNode);
                if (formattedMsg !== null) {
                    if (log.length > 0 && log[log.length - 1] === formattedMsg) return;
                    log.push(formattedMsg);
                    if (log.length > bufferCap) log.shift();
                    this.telemetryStore.set(textNode.id, log);
                    this.notifyTelemetryUpdate(textNode.id, log);
                }
            });
        }

        // Also check for virtual gauge nodes connected to the solver in the reverse direction (VirtualGauges3D -> CFDSolver3D)
        const reverseGaugeConnections = connections.filter(e => e.toNode === nodeId);
        reverseGaugeConnections.forEach(connection => {
            const connectedNode = nodes.find(n => n.id === connection.fromNode);
            if (connectedNode && !updatedNodeIds.has(connectedNode.id)) {
                if (connectedNode.type === 'VirtualGauges') {
                    if (data && !(data instanceof ArrayBuffer) && data.gauges_history) {
                         this.telemetryStore.set(connectedNode.id, data.gauges_history);
                         this.notifyTelemetryUpdate(connectedNode.id, data.gauges_history);
                    }
                }
            }
        });
    }

    private notifyListeners(): void {
        const currentState = this.getCurrentState();
        if (currentState) {
            this.listeners.forEach(listener => listener(currentState));
        }
    }

    // --- Layout Mutators ---
    splitPanel(panelId: string, direction: LayoutDirection): void {
        const state = this.getCurrentState();
        if (!state) return;

        const findAndSplit = (node: LayoutNode): LayoutNode => {
            if (node.type === 'panel' && node.id === panelId) {
                const newPanelId = `panel-${Math.random().toString(36).substr(2, 9)}`;
                return {
                    type: 'split',
                    id: `split-${Math.random().toString(36).substr(2, 9)}`,
                    direction,
                    ratio: 0.5,
                    firstChild: JSON.parse(JSON.stringify(node)),
                    secondChild: {
                        type: 'panel',
                        id: newPanelId,
                        panelType: node.panelType,
                        targetNodeId: node.targetNodeId
                    }
                };
            }
            if (node.type === 'split') {
                node.firstChild = findAndSplit(node.firstChild);
                node.secondChild = findAndSplit(node.secondChild);
            }
            return node;
        };

        state.layout = findAndSplit(state.layout);
        this.pushState(state);
    }

    closePanel(panelId: string): void {
        const state = this.getCurrentState();
        if (!state) return;

        if (panelId === 'panel-menu-bar') return;
        if (state.layout.type === 'panel') return;

        const findAndClose = (node: LayoutNode): LayoutNode => {
            if (node.type === 'split') {
                if (node.firstChild.type === 'panel' && node.firstChild.id === panelId) {
                    return node.secondChild;
                }
                if (node.secondChild.type === 'panel' && node.secondChild.id === panelId) {
                    return node.firstChild;
                }
                node.firstChild = findAndClose(node.firstChild);
                node.secondChild = findAndClose(node.secondChild);
            }
            return node;
        };

        state.layout = findAndClose(state.layout);
        this.pushState(state);
    }

    setPanelRatioSilent(splitId: string, newRatio: number): void {
        const ws = this.appState.workspaces.find(w => w.id === this.appState.activeWorkspaceId);
        if (!ws) return;

        const clamped = Math.max(0.01, Math.min(0.99, newRatio));
        const updateRatio = (node: LayoutNode): LayoutNode => {
            if (node.type === 'split') {
                if (node.id === splitId) {
                    node.ratio = clamped;
                } else {
                    node.firstChild = updateRatio(node.firstChild);
                    node.secondChild = updateRatio(node.secondChild);
                }
            }
            return node;
        };

        ws.layout = updateRatio(ws.layout);
    }

    setPanelRatio(splitId: string, newRatio: number): void {
        this.setPanelRatioSilent(splitId, newRatio);
        const state = this.getCurrentState();
        if (state) {
            this.updateState(state, false);
        }
    }

    commitPanelRatio(splitId?: string, finalRatio?: number): void {
        if (splitId !== undefined && finalRatio !== undefined) {
            this.setPanelRatioSilent(splitId, finalRatio);
        }
        const state = this.getCurrentState();
        if (state) {
            this.pushState(state, true);
        }
    }

    setPanelType(panelId: string, newType: PanelType, targetId: string | null = null): void {
        const state = this.getCurrentState();
        if (!state) return;

        const updateType = (node: LayoutNode): LayoutNode => {
            if (node.type === 'panel' && node.id === panelId) {
                node.panelType = newType;
                node.targetNodeId = targetId;
            } else if (node.type === 'split') {
                node.firstChild = updateType(node.firstChild);
                node.secondChild = updateType(node.secondChild);
            }
            return node;
        };

        state.layout = updateType(state.layout);
        this.pushState(state);
    }

    updatePanelOptions(panelId: string, options: Record<string, any>): void {
        const state = this.getCurrentState();
        if (!state) return;

        const updateOpts = (node: LayoutNode): LayoutNode => {
            if (node.type === 'panel' && node.id === panelId) {
                node.options = { ...node.options, ...options };
            } else if (node.type === 'split') {
                node.firstChild = updateOpts(node.firstChild);
                node.secondChild = updateOpts(node.secondChild);
            }
            return node;
        };

        state.layout = updateOpts(state.layout);
        this.pushState(state);
    }

    // --- Persistence ---
    saveWorkspace(): void {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        localStorage.setItem('blast_app_state', JSON.stringify(this.appState));
    }

    saveWorkspaceDebounced(): void {
        if (this.saveTimeout) clearTimeout(this.saveTimeout);
        this.saveTimeout = setTimeout(() => {
            this.saveTimeout = null;
            this.saveWorkspace();
        }, 500);
    }

    loadWorkspace(initialFallback?: SimulationState): SimulationState | null {
        try {
            const saved = localStorage.getItem('blast_app_state');
            if (saved) {
                this.appState = JSON.parse(saved);
                this.healDuplicateNodeIds();
                let anyChanged = false;
                Object.values(this.appState.models).forEach(model => {
                    if (this.healModelGraph(model)) {
                        anyChanged = true;
                    }
                    this.healNodes(model.nodes, model);
                    if (constrainAllSlices(model)) {
                        anyChanged = true;
                    }
                });
                const savedActiveModel = localStorage.getItem('blast_pipeline_active_model_id');
                this.appState.workspaces.forEach(ws => {
                    if (savedActiveModel && this.appState.models[savedActiveModel] && ws.modelIds.includes(savedActiveModel)) {
                        ws.activeModelId = savedActiveModel;
                    } else if (!ws.activeModelId || !this.appState.models[ws.activeModelId]) {
                        ws.activeModelId = (ws.modelIds && ws.modelIds.length > 0 && this.appState.models[ws.modelIds[0]])
                            ? ws.modelIds[0]
                            : (Object.keys(this.appState.models)[0] || null);
                        anyChanged = true;
                    }
                    const layoutStr = JSON.stringify(ws.layout);
                    const isOldSplit = layoutStr.includes('split-main');
                    const hasViewportPanel = hasPanelType(ws.layout, 'VIEWPORT') || hasPanelType(ws.layout, 'MULTI_VIEW_STAGE');
                    if (isOldSplit || !hasPanelType(ws.layout, 'PIPELINE_BROWSER') || !hasViewportPanel || !hasPanelType(ws.layout, 'TRANSPORT_BAR') || !hasPanelType(ws.layout, 'MENU_BAR')) {
                        ws.layout = createDefaultWorkstationLayout(ws.id);
                        anyChanged = true;
                    } else if (normalizeLayoutPanels(ws.layout)) {
                        anyChanged = true;
                    }
                });
                if (anyChanged) {
                    this.saveWorkspace();
                }
                this.history = [JSON.parse(JSON.stringify(this.appState))];
                this.currentIndex = 0;
                this.notifyListeners();
                console.log('[System] AppState hydrated successfully.');
                return this.getCurrentState();
            }
            
            // Legacy fallback
            const legacy = localStorage.getItem('blast_workspace');
            if (legacy) {
                const parsed = JSON.parse(legacy);
                if (parsed.workspaces && parsed.workspaces.length > 0) {
                    const ws1 = parsed.workspaces[0];
                    const defaultModelId = 'model-default';
                    this.appState = {
                        models: {
                            [defaultModelId]: {
                                id: defaultModelId,
                                name: 'Default Model',
                                filename: null,
                                nodes: ws1.nodes || [],
                                connections: ws1.connections || []
                            }
                        },
                        workspaces: parsed.workspaces.map((ws: any, idx: number) => ({
                            id: `ws-${idx}`,
                            name: ws.name || `Workspace ${idx + 1}`,
                            modelIds: [defaultModelId],
                            activeModelId: defaultModelId,
                            layout: ws.layout,
                            connections: []
                        })),
                        activeWorkspaceId: `ws-${parsed.activeIndex || 0}`,
                        workspaceCounter: parsed.workspaces.length
                    };
                    // Self-healing for legacy loaded nodes
                    Object.values(this.appState.models).forEach(model => {
                        this.healModelGraph(model);
                        this.healNodes(model.nodes, model);
                    });
                    this.history = [JSON.parse(JSON.stringify(this.appState))];
                    this.currentIndex = 0;

                    this.notifyListeners();
                    console.log('[System] Legacy workspace converted.');
                    return this.getCurrentState();
                }
            }
        } catch (e) {
            console.error('[System] AppState hydration failed:', e);
        }

        if (initialFallback) {
            const defaultModelId = 'model-default';
            const defaultModel: Model = {
                id: defaultModelId,
                name: 'Default Model',
                filename: null,
                nodes: JSON.parse(JSON.stringify(initialFallback.nodes)),
                connections: JSON.parse(JSON.stringify(initialFallback.connections))
            };
            const defaultWorkspaceId = 'ws-default';
            const defaultWorkspace: Workspace = {
                id: defaultWorkspaceId,
                name: 'Workspace 1',
                modelIds: [defaultModelId],
                activeModelId: defaultModelId,
                layout: JSON.parse(JSON.stringify(initialFallback.layout)),
                connections: []
            };

            this.healModelGraph(defaultModel);
            this.appState = {
                models: { [defaultModelId]: defaultModel },
                workspaces: [defaultWorkspace],
                activeWorkspaceId: defaultWorkspaceId,
                workspaceCounter: 1
            };
            this.history = [JSON.parse(JSON.stringify(this.appState))];
            this.currentIndex = 0;
            this.notifyListeners();
            return this.getCurrentState();
        }
        return null;
    }

    duplicateWorkspaceLayout(): void {
        const activeWs = this.getActiveWorkspace();
        this.appState.workspaceCounter++;
        const newWsId = `ws-${Math.random().toString(36).substr(2, 9)}`;

        const newModelIds: string[] = [];
        let newActiveModelId: string | null = null;

        activeWs.modelIds.forEach(mId => {
            const originalModel = this.appState.models[mId];
            if (originalModel) {
                this.copyModelToClipboard(mId);
                const clonedModel = this.cloneModelFromClipboard(0, 0);
                if (clonedModel) {
                    newModelIds.push(clonedModel.id);
                    if (activeWs.activeModelId === mId) {
                        newActiveModelId = clonedModel.id;
                    }
                }
            }
        });

        const duplicatedWs: Workspace = {
            id: newWsId,
            name: `${activeWs.name} (Copy)`,
            modelIds: newModelIds.length > 0 ? newModelIds : [...activeWs.modelIds],
            activeModelId: newActiveModelId || (newModelIds[0] ?? activeWs.activeModelId),
            layout: JSON.parse(JSON.stringify(activeWs.layout)),
            connections: JSON.parse(JSON.stringify(activeWs.connections))
        };

        this.appState.workspaces.push(duplicatedWs);
        this.appState.activeWorkspaceId = newWsId;
        this.pushAppState(this.appState);
    }

    duplicateModel(modelId?: string): Model | null {
        const activeWs = this.getActiveWorkspace();
        const targetModelId = modelId || activeWs.activeModelId;
        if (!targetModelId) return null;
        this.copyModelToClipboard(targetModelId);
        return this.pasteModelFromClipboard(150, 150);
    }

    getAppState(): AppState {
        return this.appState;
    }

    loadAppState(newAppState: AppState): void {
        this.appState = newAppState;
        this.healDuplicateNodeIds();
        Object.values(this.appState.models).forEach(model => {
            this.healModelGraph(model);
            this.healNodes(model.nodes, model);
        });
        this.pushAppState(this.appState);
    }

    clearWorkspace(): void {
        localStorage.removeItem('blast_app_state');
        localStorage.removeItem('blast_workspace');
        console.log('[System] Local workspace and AppState cleared.');
    }

    generateUniqueNodeId(type: NodeType): string {
        const existingIds = new Set<string>();
        Object.values(this.appState.models).forEach(model => {
            model.nodes.forEach(n => existingIds.add(n.id));
        });
        return this.getUniqueNodeId(type, existingIds);
    }

    public healModelGraph(model: Model): boolean {
        let changed = false;
        if (!model || !model.nodes) return false;

        const tempExistingIds = new Set<string>();
        Object.values(this.appState.models).forEach(m => {
            m.nodes.forEach(n => tempExistingIds.add(n.id));
        });

        // 1. If model has MPMDomain3D
        const mpmDomain3D = model.nodes.find(n => n.type === 'MPMDomain3D');
        if (mpmDomain3D) {
            let meshNode = model.nodes.find(n => n.type === 'DomainMesh3D');
            if (!meshNode) {
                const existingMesh1D = model.nodes.find(n => n.type === 'DomainMesh');
                if (existingMesh1D) {
                    existingMesh1D.type = 'DomainMesh3D';
                    const cellSize = existingMesh1D.parameters?.cell_size ?? 0.01;
                    existingMesh1D.parameters = {
                        ...this.getDefaultParameters('DomainMesh3D'),
                        cell_size: cellSize
                    };
                    existingMesh1D.inputs = this.getDefaultInputs('DomainMesh3D');
                    existingMesh1D.outputs = this.getDefaultOutputs('DomainMesh3D');
                    meshNode = existingMesh1D;
                    changed = true;
                } else {
                    const meshId = this.getUniqueNodeId('DomainMesh3D', tempExistingIds);
                    meshNode = {
                        id: meshId,
                        type: 'DomainMesh3D',
                        x: mpmDomain3D.x - 280,
                        y: mpmDomain3D.y - 100,
                        parameters: this.getDefaultParameters('DomainMesh3D'),
                        inputs: this.getDefaultInputs('DomainMesh3D'),
                        outputs: this.getDefaultOutputs('DomainMesh3D')
                    };
                    model.nodes.push(meshNode);
                    changed = true;
                }
            }
            const hasMeshConn = model.connections.some(c => c.toNode === mpmDomain3D.id && c.toPort === 'mesh');
            if (!hasMeshConn) {
                model.connections.push({
                    fromNode: meshNode.id,
                    fromPort: 'mesh',
                    toNode: mpmDomain3D.id,
                    toPort: 'mesh'
                });
                changed = true;
            }

            let objNode = model.nodes.find(n => n.type === 'MPMObject3D');
            if (!objNode) {
                const objId = this.getUniqueNodeId('MPMObject3D', tempExistingIds);
                objNode = {
                    id: objId,
                    type: 'MPMObject3D',
                    x: mpmDomain3D.x - 280,
                    y: mpmDomain3D.y + 100,
                    parameters: this.getDefaultParameters('MPMObject3D'),
                    inputs: this.getDefaultInputs('MPMObject3D'),
                    outputs: this.getDefaultOutputs('MPMObject3D')
                };
                model.nodes.push(objNode);
                changed = true;
            }
            const hasObjConn = model.connections.some(c => c.toNode === mpmDomain3D.id && (c.toPort === 'objects' || c.toPort === 'mpm_objects' || c.toPort === 'in'));
            if (!hasObjConn) {
                model.connections.push({
                    fromNode: objNode.id,
                    fromPort: 'object',
                    toNode: mpmDomain3D.id,
                    toPort: 'objects'
                });
                changed = true;
            }

            let matNode = model.nodes.find(n => n.type === 'Material');
            if (!matNode) {
                const matId = this.getUniqueNodeId('Material', tempExistingIds);
                matNode = {
                    id: matId,
                    type: 'Material',
                    x: objNode.x - 280,
                    y: objNode.y,
                    parameters: this.getDefaultParameters('Material'),
                    inputs: this.getDefaultInputs('Material'),
                    outputs: this.getDefaultOutputs('Material')
                };
                model.nodes.push(matNode);
                changed = true;
            }
            const hasMatConn = model.connections.some(c => c.toNode === objNode.id && c.toPort === 'material');
            if (!hasMatConn) {
                model.connections.push({
                    fromNode: matNode.id,
                    fromPort: 'material',
                    toNode: objNode.id,
                    toPort: 'material'
                });
                changed = true;
            }
        }

        // 2. If model has CFDSolver3D
        const cfdSolver3D = model.nodes.find(n => n.type === 'CFDSolver3D');
        if (cfdSolver3D) {
            let meshNode = model.nodes.find(n => n.type === 'DomainMesh3D');
            if (!meshNode) {
                const meshId = this.getUniqueNodeId('DomainMesh3D', tempExistingIds);
                meshNode = {
                    id: meshId,
                    type: 'DomainMesh3D',
                    x: cfdSolver3D.x - 280,
                    y: cfdSolver3D.y - 120,
                    parameters: {
                        xmin: 0.0, xmax: 1.0,
                        ymin: 0.0, ymax: 1.0,
                        zmin: 0.0, zmax: 1.0,
                        cell_size: 0.02,
                        bc_xmin: 'Transmitting', bc_xmax: 'Transmitting',
                        bc_ymin: 'Transmitting', bc_ymax: 'Transmitting',
                        bc_zmin: 'Transmitting', bc_zmax: 'Transmitting'
                    },
                    inputs: this.getDefaultInputs('DomainMesh3D'),
                    outputs: this.getDefaultOutputs('DomainMesh3D')
                };
                model.nodes.push(meshNode);
                changed = true;
            }
            const hasMeshConn = model.connections.some(c => c.toNode === cfdSolver3D.id && c.toPort === 'mesh');
            if (!hasMeshConn) {
                model.connections.push({
                    fromNode: meshNode.id,
                    fromPort: 'mesh',
                    toNode: cfdSolver3D.id,
                    toPort: 'mesh'
                });
                changed = true;
            }
        }

        // 3. If model has CFDSolver2D
        const cfdSolver2D = model.nodes.find(n => n.type === 'CFDSolver2D');
        if (cfdSolver2D) {
            let meshNode = model.nodes.find(n => n.type === 'DomainMesh2D');
            if (!meshNode) {
                const meshId = this.getUniqueNodeId('DomainMesh2D', tempExistingIds);
                meshNode = {
                    id: meshId,
                    type: 'DomainMesh2D',
                    x: cfdSolver2D.x - 280,
                    y: cfdSolver2D.y - 120,
                    parameters: {
                        domain_width: 1.0,
                        domain_height: 1.0,
                        cell_size: 0.01,
                        bc_left: 'Transmitting', bc_right: 'Transmitting',
                        bc_top: 'Transmitting', bc_bottom: 'Transmitting'
                    },
                    inputs: this.getDefaultInputs('DomainMesh2D'),
                    outputs: this.getDefaultOutputs('DomainMesh2D')
                };
                model.nodes.push(meshNode);
                changed = true;
            }
            const hasMeshConn = model.connections.some(c => c.toNode === cfdSolver2D.id && c.toPort === 'mesh');
            if (!hasMeshConn) {
                model.connections.push({
                    fromNode: meshNode.id,
                    fromPort: 'mesh',
                    toNode: cfdSolver2D.id,
                    toPort: 'mesh'
                });
                changed = true;
            }
        }

        // 4. If model has 1D CFDSolver
        const cfdSolver1D = model.nodes.find(n => n.type === 'CFDSolver');
        if (cfdSolver1D) {
            let meshNode = model.nodes.find(n => n.type === 'DomainMesh');
            if (!meshNode) {
                const meshId = this.getUniqueNodeId('DomainMesh', tempExistingIds);
                meshNode = {
                    id: meshId,
                    type: 'DomainMesh',
                    x: cfdSolver1D.x - 280,
                    y: cfdSolver1D.y - 120,
                    parameters: {
                        domain_radius: 1.0,
                        cell_size: 0.001,
                        left_bc: 'Transmitting', right_bc: 'Transmitting'
                    },
                    inputs: this.getDefaultInputs('DomainMesh'),
                    outputs: this.getDefaultOutputs('DomainMesh')
                };
                model.nodes.push(meshNode);
                changed = true;
            }
            const hasMeshConn = model.connections.some(c => c.toNode === cfdSolver1D.id && c.toPort === 'mesh');
            if (!hasMeshConn) {
                model.connections.push({
                    fromNode: meshNode.id,
                    fromPort: 'mesh',
                    toNode: cfdSolver1D.id,
                    toPort: 'mesh'
                });
                changed = true;
            }
        }

        // Clean up connections pointing to non-existent nodes
        const nodeIds = new Set(model.nodes.map(n => n.id));
        const validConns = model.connections.filter(c => nodeIds.has(c.fromNode) && nodeIds.has(c.toNode));
        if (validConns.length !== model.connections.length) {
            model.connections = validConns;
            changed = true;
        }

        // Ensure model has valid views and activeViewId
        if (!model.views || !Array.isArray(model.views) || model.views.length === 0) {
            const vpNode = model.nodes.find(n => n.type === 'Telemetry3DViewport');
            const meshNode = model.nodes.find(n => n.type === 'DomainMesh3D' || n.type === 'DomainMesh');
            const solverNode = model.nodes.find(n => n.type === 'CFDSolver3D');

            const carrierSlices = (vpNode?.parameters?.slices && Array.isArray(vpNode.parameters.slices))
                ? vpNode.parameters.slices
                : ((meshNode?.parameters?.slices && Array.isArray(meshNode.parameters.slices))
                    ? meshNode.parameters.slices
                    : ((solverNode?.parameters?.slices && Array.isArray(solverNode.parameters.slices))
                        ? solverNode.parameters.slices
                        : null));

            const defaultSlices: ModelViewSlice[] = carrierSlices && carrierSlices.length > 0
                ? carrierSlices.map((s: any) => ({
                    axis: s.axis || 'xy',
                    offset: s.offset !== undefined ? Number(s.offset) : 0.5,
                    quantity: s.quantity || (s.quantities?.[0]) || 'pressure',
                    colormap: s.colormap || 'rainbow',
                    opacity: s.opacity !== undefined ? Number(s.opacity) : 1.0,
                    enabled: s.enabled !== false,
                    stride: s.stride !== undefined ? Number(s.stride) : 1
                }))
                : [
                    { axis: 'xy', offset: 0.5, quantity: 'pressure', colormap: 'rainbow', opacity: 1.0, enabled: true, stride: 1 }
                ];

            const pitch = vpNode?.parameters?.camera_pitch !== undefined ? Number(vpNode.parameters.camera_pitch) : 0.42;
            const yaw = vpNode?.parameters?.camera_yaw !== undefined ? Number(vpNode.parameters.camera_yaw) : 2.356;
            const distance = vpNode?.parameters?.camera_distance !== undefined ? Number(vpNode.parameters.camera_distance) : 1.35;
            const targetX = vpNode?.parameters?.target_x !== undefined ? Number(vpNode.parameters.target_x) : 0.0;
            const targetY = vpNode?.parameters?.target_y !== undefined ? Number(vpNode.parameters.target_y) : 0.0;
            const targetZ = vpNode?.parameters?.target_z !== undefined ? Number(vpNode.parameters.target_z) : 0.0;
            const fov = vpNode?.parameters?.camera_fov !== undefined ? Number(vpNode.parameters.camera_fov) : 45.0;

            const toggles: ModelViewToggles = {
                show_grid: vpNode?.parameters?.show_grid !== false,
                show_grid_box: vpNode?.parameters?.show_grid_box !== false,
                cell_edges: Boolean(vpNode?.parameters?.cell_edges),
                show_stl: vpNode?.parameters?.show_stl !== false,
                stl_opacity: vpNode?.parameters?.stl_opacity !== undefined ? Number(vpNode.parameters.stl_opacity) : 0.5,
                show_obstacles: vpNode?.parameters?.show_obstacles !== false,
                obstacles_opacity: vpNode?.parameters?.obstacles_opacity !== undefined ? Number(vpNode.parameters.obstacles_opacity) : 1.0,
                refresh_rate: vpNode?.parameters?.refresh_rate !== undefined ? Number(vpNode.parameters.refresh_rate) : 0.5
            };

            model.views = [
                {
                    id: 'view-default',
                    name: 'Default View',
                    camera: {
                        pitch,
                        yaw,
                        distance,
                        target: [targetX, targetY, targetZ],
                        usePerspective: true,
                        fov
                    },
                    slices: defaultSlices,
                    toggles
                }
            ];
            model.activeViewId = 'view-default';
            changed = true;
        } else if (!model.activeViewId || !model.views.some(v => v.id === model.activeViewId)) {
            model.activeViewId = model.views[0].id;
            changed = true;
        }

        return changed;
    }

    public healDuplicateNodeIds(targetAppState: AppState = this.appState): void {
        const seenIds = new Set<string>();
        const allRenames = new Map<string, string>();

        Object.values(targetAppState.models).forEach(model => {
            const modelIdMap = new Map<string, string>();

            model.nodes.forEach(node => {
                if (seenIds.has(node.id)) {
                    const prefix = node.id.replace(/-\d+$/, '');
                    let index = 1;
                    let newId = `${prefix}-${index}`;
                    while (seenIds.has(newId)) {
                        index++;
                        newId = `${prefix}-${index}`;
                    }
                    console.warn(`[HEAL] Renaming duplicate node ID ${node.id} to ${newId} in model "${model.name}"`);
                    modelIdMap.set(node.id, newId);
                    allRenames.set(node.id, newId);
                    
                    if (this.selectedNodeId === node.id) {
                        this.selectedNodeId = newId;
                    }
                    
                    node.id = newId;
                }
                seenIds.add(node.id);
            });

            if (modelIdMap.size > 0) {
                model.connections.forEach(conn => {
                    if (modelIdMap.has(conn.fromNode)) {
                        conn.fromNode = modelIdMap.get(conn.fromNode)!;
                    }
                    if (modelIdMap.has(conn.toNode)) {
                        conn.toNode = modelIdMap.get(conn.toNode)!;
                    }
                });
            }
        });

        if (allRenames.size > 0) {
            targetAppState.workspaces.forEach(ws => {
                ws.connections.forEach(conn => {
                    if (allRenames.has(conn.fromNode)) {
                        conn.fromNode = allRenames.get(conn.fromNode)!;
                    }
                    if (allRenames.has(conn.toNode)) {
                        conn.toNode = allRenames.get(conn.toNode)!;
                    }
                });

                const updatePanelTargetId = (layoutNode: LayoutNode) => {
                    if (!layoutNode) return;
                    if (layoutNode.type === 'panel') {
                        if (layoutNode.targetNodeId && allRenames.has(layoutNode.targetNodeId)) {
                            layoutNode.targetNodeId = allRenames.get(layoutNode.targetNodeId)!;
                        }
                    } else if (layoutNode.type === 'split') {
                        updatePanelTargetId(layoutNode.firstChild);
                        updatePanelTargetId(layoutNode.secondChild);
                    }
                };
                updatePanelTargetId(ws.layout);
            });
        }

        this.unSmergeWorkspaceModels(targetAppState);
    }

    public unSmergeWorkspaceModels(targetAppState: AppState = this.appState): void {
        const solverTypes = ['CFDSolver', 'CFDSolver2D', 'CFDSolver3D', 'MPMDomain2D', 'MPMDomain3D', 'FEMDomain3D', 'FSICoupler2D', 'FSICoupler3D', 'FEMFSICoupler3D', 'DomainMesh', 'DomainMesh2D', 'DomainMesh3D'];

        Object.values(targetAppState.models).forEach(model => {
            const seenTypes = new Set<string>();
            const duplicateIds = new Set<string>();

            model.nodes.forEach(n => {
                if (solverTypes.includes(n.type)) {
                    if (seenTypes.has(n.type)) {
                        duplicateIds.add(n.id);
                    } else {
                        seenTypes.add(n.type);
                    }
                }
            });

            if (duplicateIds.size > 0) {
                console.warn(`[UNSMERGE] Purging ${duplicateIds.size} duplicate solver/mesh nodes from model "${model.name}"`);
                model.nodes = model.nodes.filter(n => !duplicateIds.has(n.id));
                model.connections = model.connections.filter(c => !duplicateIds.has(c.fromNode) && !duplicateIds.has(c.toNode));
            }

            const nodeIdsInModel = new Set(model.nodes.map(n => n.id));
            model.connections = model.connections.filter(c => nodeIdsInModel.has(c.fromNode) && nodeIdsInModel.has(c.toNode));
        });
    }

    private healNodes(nodes: Node[], stateObj?: { nodes: Node[], connections: Connection[] }): void {
        nodes.forEach(node => {
            if ((node.type as any) === 'VirtualGauges3D') {
                node.type = 'VirtualGauges';
            }
            if ((node.type as any) === 'MPMMaterialSteel' || (node.type as any) === 'MPMMaterial' || (node.type as any) === 'MaterialSteel') {
                node.type = 'Material';
            }
            node.inputs = this.getDefaultInputs(node.type);
            node.outputs = this.getDefaultOutputs(node.type);
        });

        // Auto-heal: re-route CFDSolver3D.mesh connections that point to a RefinementMesh3D
        // (old scene format). Trace back to the DomainMesh3D and re-wire directly.
        const model = stateObj || Object.values(this.appState.models).find(m => m.nodes === nodes);
        if (model) {
            const solverNodes = model.nodes.filter(n => n.type === 'CFDSolver3D');
            for (const solver of solverNodes) {
                const meshConnIdx = model.connections.findIndex(
                    c => c.toNode === solver.id && c.toPort === 'mesh'
                );
                if (meshConnIdx === -1) continue;
                const meshConn = model.connections[meshConnIdx];
                const srcNode = model.nodes.find(n => n.id === meshConn.fromNode);
                if (!srcNode || srcNode.type !== 'RefinementMesh3D') continue;

                // Trace the parent_mesh chain to find the DomainMesh3D root
                let curr: Node | undefined = srcNode;
                let depth = 0;
                while (curr && curr.type === 'RefinementMesh3D' && depth < 20) {
                    const parentConn = model.connections.find(c => c.toNode === curr!.id && c.toPort === 'parent_mesh');
                    if (!parentConn) break;
                    curr = model.nodes.find(n => n.id === parentConn.fromNode);
                    depth++;
                }
                if (curr && curr.type === 'DomainMesh3D') {
                    console.warn(`[HEAL] Re-routing CFDSolver3D.mesh from RefinementMesh3D "${meshConn.fromNode}" to DomainMesh3D "${curr.id}"`);
                    model.connections[meshConnIdx] = {
                        fromNode: curr.id,
                        fromPort: 'mesh',
                        toNode: solver.id,
                        toPort: 'mesh'
                    };
                }
            }
        }

        const defaults = NODE_DEFAULT_PARAMETERS;

        // Auto-heal RemapNode -> Remap1DTo2DNode
        nodes.forEach(node => {
            if (node.type === 'RemapNode') {
                node.type = 'Remap1DTo2DNode';
            }
        });

        nodes.forEach(node => {
            if (!node.parameters) {
                node.parameters = {};
            }
            if (node.type === 'PrimitiveGeometry3D') {
                const prims = node.parameters.primitives || [];
                prims.forEach((prim: any, idx: number) => {
                    if (prim.name === undefined) {
                        prim.name = `${prim.type.charAt(0).toUpperCase() + prim.type.slice(1)} ${idx + 1}`;
                    }
                    if (prim.subtractive === undefined) {
                        prim.subtractive = false;
                    }
                    if (prim.voxelization_method === undefined) {
                        prim.voxelization_method = 'use_node_default';
                    }
                });
            }
            if (node.type === 'MPMDomain2D' || node.type === 'MPMDomain3D') {
                delete node.parameters['time_step'];
            }
            if (node.type === 'CFDSolver' || node.type === 'CFDSolver2D' || node.type === 'CFDSolver3D') {
                delete node.parameters['output_mode'];
                delete node.parameters['output_interval'];
            }
            if (node.type === 'CFDSolver3D') {
                delete node.parameters['stl_file'];
                delete node.parameters['geometry_hash'];
                delete node.parameters['mesh_type'];
                delete node.parameters['amr_max_levels'];
                delete node.parameters['amr_threshold'];
                delete node.parameters['amr_coarsen_ratio'];
                delete node.parameters['amr_tile_size'];
            }
            if (node.type === 'FEMDomain3D') {
                delete node.parameters['failure_strain'];
                delete node.parameters['tensile_failure_stress'];
                delete node.parameters['bulk_viscosity_b1'];
                delete node.parameters['bulk_viscosity_b2'];
                delete node.parameters['timestep_erosion_factor'];
                delete node.parameters['contact_stiffness'];
            }
            if (node.type === 'FEMFSICoupler3D') {
                delete node.parameters['steps'];
            }
            if (node.type === 'FEMObject3D') {
                delete node.parameters['failure_strain'];
                delete node.parameters['tensile_failure_stress'];
                delete node.parameters['bulk_viscosity_b1'];
                delete node.parameters['bulk_viscosity_b2'];
                delete node.parameters['timestep_erosion_factor'];
                delete node.parameters['length'];

                // Migrate mesh_source -> shape_type
                if (node.parameters['mesh_source']) {
                    const src = node.parameters['mesh_source'];
                    if (src === 'LS-DYNA Keyword File') node.parameters['shape_type'] = 'LS-DYNA File';
                    else if (src === 'Cylinder Generator') node.parameters['shape_type'] = 'Cylinder';
                    else if (src === 'Box Generator') node.parameters['shape_type'] = 'Box';
                    delete node.parameters['mesh_source'];
                }
                if (!node.parameters['shape_type']) node.parameters['shape_type'] = 'Box';
            }
            if (node.type === 'DomainMesh') {
                delete node.parameters['dimension'];
                delete node.parameters['y_min_bc'];
                delete node.parameters['y_max_bc'];
                delete node.parameters['z_min_bc'];
                delete node.parameters['z_max_bc'];
                if (node.parameters['x_min_bc'] !== undefined) {
                    node.parameters['left_bc'] = node.parameters['x_min_bc'];
                    delete node.parameters['x_min_bc'];
                }
                if (node.parameters['x_max_bc'] !== undefined) {
                    node.parameters['right_bc'] = node.parameters['x_max_bc'];
                    delete node.parameters['x_max_bc'];
                }
            }
            if (node.type === 'DomainMesh3D') {
                if (node.parameters['xmin'] === undefined && node.parameters['origin_x'] !== undefined) {
                    const ox = Number(node.parameters['origin_x'] ?? 0.0);
                    const dx = Number(node.parameters['dim_x'] ?? 1.0);
                    node.parameters['xmin'] = ox;
                    node.parameters['xmax'] = ox + dx;
                }
                if (node.parameters['ymin'] === undefined && node.parameters['origin_y'] !== undefined) {
                    const oy = Number(node.parameters['origin_y'] ?? 0.0);
                    const dy = Number(node.parameters['dim_y'] ?? 1.0);
                    node.parameters['ymin'] = oy;
                    node.parameters['ymax'] = oy + dy;
                }
                if (node.parameters['zmin'] === undefined && node.parameters['origin_z'] !== undefined) {
                    const oz = Number(node.parameters['origin_z'] ?? 0.0);
                    const dz = Number(node.parameters['dim_z'] ?? 1.0);
                    node.parameters['zmin'] = oz;
                    node.parameters['zmax'] = oz + dz;
                }
                delete node.parameters['dim_x'];
                delete node.parameters['dim_y'];
                delete node.parameters['dim_z'];
                delete node.parameters['origin_x'];
                delete node.parameters['origin_y'];
                delete node.parameters['origin_z'];
            }
            if (node.type === 'Telemetry3DViewport') {
                if (node.parameters['rebarRadius'] !== undefined && node.parameters['beamRadius'] === undefined) {
                    node.parameters['beamRadius'] = node.parameters['rebarRadius'];
                }
                if (node.parameters['rebarSolid'] !== undefined && node.parameters['beamSolid'] === undefined) {
                    node.parameters['beamSolid'] = node.parameters['rebarSolid'];
                }
                if (node.parameters['rebarWireframe'] !== undefined && node.parameters['beamWireframe'] === undefined) {
                    node.parameters['beamWireframe'] = node.parameters['rebarWireframe'];
                }
                delete node.parameters['rebarRadius'];
                delete node.parameters['rebarSolid'];
                delete node.parameters['rebarWireframe'];
                delete node.parameters['vtk_dir'];
                delete node.parameters['export_slices'];
                delete node.parameters['export_volumes'];
                delete node.parameters['custom_filename'];
                delete node.parameters['step_interval'];
                delete node.parameters['time_interval'];
                delete node.parameters['vtk_format'];
            }

            // Clean residual submesh keys
            delete node.parameters['submesh_x'];
            delete node.parameters['submesh_y'];
            delete node.parameters['submesh_z'];
            delete node.parameters['submesh_size_x'];
            delete node.parameters['submesh_size_y'];
            delete node.parameters['submesh_size_z'];
            delete node.parameters['refinement_level'];
            delete node.parameters['refinement_opacity'];

            if (!node.displayMode) {
                node.displayMode = 'expanded';
            }
            // Self-healing: Mass always dominates charge definition.
            // If charge_mass is missing or <= 0, compute charge_mass from geometry and density.
            if (node.type === 'Charge1D' || node.type === 'Charge2D' || node.type === 'Charge3D') {
                let rho = 1630.0;
                let model: { nodes: Node[], connections: Connection[] } | null = stateObj || null;
                if (!model) {
                    model = Object.values(this.appState.models).find(m => m.nodes.some(n => n.id === node.id)) || null;
                }
                if (model) {
                    const conn = model.connections.find(c => c.toNode === node.id && c.toPort === 'material');
                    const matNode = conn ? model.nodes.find(n => n.id === conn.fromNode) : null;
                    if (matNode && matNode.type === 'Material') {
                        const matType = matNode.parameters?.material_type || 'Air';
                        if (matType === 'Ideal Gas Charge') {
                            rho = Number(matNode.parameters?.ideal_rho_0 ?? 1630.0);
                        } else {
                            rho = Number(matNode.parameters?.rho ?? 1630.0);
                        }
                    }
                }
                const shape = node.parameters['charge_shape'] || 'Sphere';
                const currentMass = Number(node.parameters['charge_mass']);
                if (isNaN(currentMass) || currentMass <= 0) {
                    if (shape === 'Sphere') {
                        const radius = Number(node.parameters['charge_radius'] !== undefined ? node.parameters['charge_radius'] : 0.1);
                        node.parameters['charge_mass'] = (4.0 / 3.0) * Math.PI * Math.pow(radius, 3.0) * rho;
                    } else if (shape === 'Cylinder') {
                        const radius = Number(node.parameters['charge_radius'] !== undefined ? node.parameters['charge_radius'] : 0.1);
                        const height = Number(node.parameters['charge_height'] !== undefined ? node.parameters['charge_height'] : 0.2);
                        node.parameters['charge_mass'] = Math.PI * radius * radius * height * rho;
                        if (node.parameters['charge_aspect_ratio'] === undefined && radius > 0) {
                            node.parameters['charge_aspect_ratio'] = height / (2.0 * radius);
                        }
                    } else if (shape === 'Block') {
                        const lx = Number(node.parameters['charge_lx'] !== undefined ? node.parameters['charge_lx'] : 0.2);
                        const ly = Number(node.parameters['charge_ly'] !== undefined ? node.parameters['charge_ly'] : 0.2);
                        const lz = Number(node.parameters['charge_lz'] !== undefined ? node.parameters['charge_lz'] : 0.2);
                        node.parameters['charge_mass'] = lx * ly * lz * rho;
                    }
                }
            }
            if ((node.type === 'Charge2D' || node.type === 'Charge3D') && node.parameters['charge_aspect_ratio'] === undefined) {
                const radius = Number(node.parameters['charge_radius'] !== undefined ? node.parameters['charge_radius'] : 0.1);
                const height = Number(node.parameters['charge_height'] !== undefined ? node.parameters['charge_height'] : 0.2);
                node.parameters['charge_aspect_ratio'] = (radius > 0 && height > 0) ? (height / (2.0 * radius)) : 1.0;
            }
            const nodeDefaults = defaults[node.type];
            if (nodeDefaults) {
                for (const [key, val] of Object.entries(nodeDefaults)) {
                    if (node.parameters[key] === undefined) {
                        node.parameters[key] = val;
                    }
                }
            }
            // Sync logic
            let model: { nodes: Node[], connections: Connection[] } | null = stateObj || null;
            if (!model) {
                model = Object.values(this.appState.models).find(m => m.nodes.some(n => n.id === node.id)) || null;
            }
            syncExplosiveParameters(node, node.parameters, model);
            syncMPMMaterialParameters(node, node.parameters);
            syncFEMObjectParameters(node, node.parameters);
        });
    }

    importWorkspace(workspace: Workspace, models: Model[]): void {
        const appStateCopy = JSON.parse(JSON.stringify(this.appState)) as AppState;
        
        models.forEach(model => {
            appStateCopy.models[model.id] = model;
        });

        const existingWsIdx = appStateCopy.workspaces.findIndex(w => w.id === workspace.id);
        if (existingWsIdx !== -1) {
            appStateCopy.workspaces[existingWsIdx] = workspace;
        } else {
            appStateCopy.workspaces.push(workspace);
        }

        appStateCopy.activeWorkspaceId = workspace.id;

        this.loadAppState(appStateCopy);
    }

    getDefaultInputs(type: NodeType): Port[] {
        switch (type) {
            case 'ThePainter': return [{ id: 'mesh', label: 'Mesh' }, { id: 'air', label: 'Air' }, { id: 'explosive', label: 'Charge' }];
            case 'CFDSolver': return [{ id: 'in', label: 'Initial State' }];
            case 'TelemetryText': return [
                { id: 'in', label: 'Stream 1' },
                { id: 'in_2', label: 'Stream 2' }
            ];
            case 'TelemetryGraph': return [{ id: 'in', label: 'Data Stream' }];
            case 'CFDSolver2D': return [
                { id: 'mesh', label: 'Mesh' },
                { id: 'detonator', label: 'Detonator' },
                { id: 'explosive', label: 'Charge' },
                { id: 'hardware', label: 'Hardware' },
                { id: 'air', label: 'Air' },
                { id: 'remap', label: 'Remap' }
            ];
            case 'Charge1D':
            case 'Charge2D': return [{ id: 'material', label: 'Material' }];
            case 'RemapNode':
            case 'Remap1DTo2DNode':
            case 'Remap1DTo3DNode': return [{ id: 'in', label: '1D Solver' }];
            case 'Remap2DTo3DNode': return [{ id: 'in', label: '2D Solver' }];
            case 'TelemetryContour': return [
                { id: 'in', label: 'CFD Stream' },
                { id: 'mpm_in', label: 'MPM Stream' }
            ];
            case 'VTKOutput': return [{ id: 'in', label: 'Solver' }];
            case 'VirtualGauges': return [{ id: 'in', label: 'Solver Output' }];
            case 'CFDSolver3D': return [
                { id: 'mesh', label: 'Mesh' },
                { id: 'air', label: 'Air' },
                { id: 'charge', label: 'Charge' },
                { id: 'detonator', label: 'Detonator' },
                { id: 'stl', label: 'STL Geometry' },
                { id: 'gauges', label: 'Gauges' },
                { id: 'remap', label: 'Remap' }
            ];
            case 'RefinementMesh3D': return [{ id: 'parent_mesh', label: 'Parent Mesh' }];
            case 'Charge3D': return [{ id: 'material', label: 'Material' }];
            case 'Telemetry3DViewport': return [{ id: 'in', label: 'Data Stream' }];
            case 'MPMDomain2D': return [{ id: 'mesh', label: 'Grid' }, { id: 'detonator', label: 'Detonator' }, { id: 'objects', label: 'MPM Objects' }];
            case 'MPMDomain3D': return [{ id: 'mesh', label: 'Grid' }, { id: 'detonator', label: 'Detonator' }, { id: 'objects', label: 'MPM Objects' }];
            case 'MPMObject2D': return [{ id: 'material', label: 'Material' }];
            case 'MPMObject3D': return [{ id: 'material', label: 'Material' }, { id: 'stl', label: 'STL Geometry' }];
            case 'FSICoupler2D': return [{ id: 'cfd', label: 'CFD Solver' }, { id: 'mpm', label: 'MPM Solver' }];
            case 'FSICoupler3D': return [{ id: 'cfd', label: 'CFD Solver 3D' }, { id: 'mpm', label: 'MPM Solver 3D' }];
            case 'FEMDomain3D': return [{ id: 'mesh', label: 'Hex Mesh' }, { id: 'objects', label: 'FEM Objects' }];
            case 'FEMObject3D': return [{ id: 'material', label: 'Material' }, { id: 'importer', label: 'LS-DYNA File' }];
            case 'LSDynaImporter3D': return [];
            case 'FEMFSICoupler3D': return [{ id: 'cfd', label: 'CFD Solver 3D' }, { id: 'fem', label: 'FEM Solver 3D' }];
            default: return [];
        }
    }

    getDefaultOutputs(type: NodeType): Port[] {
        switch (type) {
            case 'DomainMesh': return [{ id: 'out', label: 'Mesh' }];
            case 'Material': return [{ id: 'out', label: 'Material' }];
            case 'Charge1D':
            case 'Charge2D': return [{ id: 'out', label: 'Charge' }];
            case 'ThePainter': return [{ id: 'out', label: 'State' }];
            case 'CFDSolver': return [{ id: 'telemetry', label: 'Telemetry' }];
            case 'DomainMesh2D': return [{ id: 'mesh', label: 'Mesh Spec' }];
            case 'DetonatorLocation':
            case 'DetonatorLocation3D': return [{ id: 'detonator', label: 'Detonator Spec' }];
            case 'RemapNode':
            case 'Remap1DTo2DNode':
            case 'Remap1DTo3DNode':
            case 'Remap2DTo3DNode': return [{ id: 'remap', label: 'Remap Spec' }];
            case 'HardwareConfig': return [{ id: 'hardware', label: 'Hardware Spec' }];
            case 'CFDSolver2D': return [{ id: 'telemetry', label: 'Telemetry' }];
            case 'DomainMesh3D': return [{ id: 'mesh', label: 'Mesh Spec' }];
            case 'RefinementMesh3D': return [{ id: 'mesh', label: 'Mesh Spec' }];
            case 'Charge3D': return [{ id: 'out', label: 'Charge Spec' }];
            case 'CFDSolver3D': return [{ id: 'telemetry', label: 'Telemetry' }];
            case 'VirtualGauges': return [{ id: 'out', label: 'Gauges Spec' }];
            case 'MPMDomain2D':
            case 'MPMDomain3D': return [{ id: 'telemetry', label: 'Telemetry' }, { id: 'mpm_out', label: 'MPM State' }];
            case 'MPMObject2D':
            case 'MPMObject3D': return [{ id: 'out', label: 'Object Spec' }];
            case 'FSICoupler2D':
            case 'FSICoupler3D': return [{ id: 'telemetry', label: 'Telemetry' }];
            case 'FEMDomain3D': return [{ id: 'telemetry', label: 'Telemetry' }, { id: 'fem_out', label: 'FEM State' }];
            case 'FEMObject3D': return [{ id: 'out', label: 'Object Spec' }];
            case 'LSDynaImporter3D': return [{ id: 'out', label: 'Mesh Spec' }];
            case 'FEMFSICoupler3D': return [{ id: 'telemetry', label: 'Telemetry' }];
            case 'STLGeometry':
            case 'PrimitiveGeometry3D': return [{ id: 'stl', label: 'STL Geometry' }];
            default: return [];
        }
    }

    registerSTLVertices(filePath: string, vertices: Float32Array): STLGeometryMeta {
        return registerSTLVertices(filePath, vertices);
    }

    selectNode(modelId: string, nodeId: string | null): void {
        if (modelId) {
            this.setActiveModel(modelId);
        }
        this.setSelectedNode(nodeId);
    }

    getDefaultParameters(type: NodeType): Record<string, any> {
        if (NODE_DEFAULT_PARAMETERS[type]) {
            return JSON.parse(JSON.stringify(NODE_DEFAULT_PARAMETERS[type]));
        }
        return {};
    }
}


export function createDefaultWorkstationLayout(suffix: string = ''): LayoutNode {
    const s = suffix ? `-${suffix}` : '';
    return {
        type: 'split',
        id: `split-menu-root${s}`,
        direction: 'vertical',
        ratio: 0.035,
        firstChild: {
            type: 'panel',
            id: `panel-menu-bar${s}`,
            panelType: 'MENU_BAR',
            targetNodeId: null
        },
        secondChild: {
            type: 'split',
            id: `split-root${s}`,
            direction: 'horizontal',
            ratio: 0.24,
            firstChild: {
                type: 'split',
                id: `split-left${s}`,
                direction: 'vertical',
                ratio: 0.45,
                firstChild: {
                    type: 'panel',
                    id: `panel-pipeline${s}`,
                    panelType: 'PIPELINE_BROWSER',
                    targetNodeId: null
                },
                secondChild: {
                    type: 'panel',
                    id: `panel-property-grid${s}`,
                    panelType: 'PROPERTY_GRID',
                    targetNodeId: null
                }
            },
            secondChild: {
                type: 'split',
                id: `split-right${s}`,
                direction: 'vertical',
                ratio: 0.85,
                firstChild: {
                    type: 'panel',
                    id: `panel-stage${s}`,
                    panelType: 'VIEWPORT',
                    targetNodeId: null
                },
                secondChild: {
                    type: 'panel',
                    id: `panel-transport${s}`,
                    panelType: 'TRANSPORT_BAR',
                    targetNodeId: null
                }
            }
        }
    };
}

function normalizeLayoutPanels(node: LayoutNode): boolean {
    if (!node) return false;
    let changed = false;
    if (node.type === 'panel') {
        if ((node.panelType as any) === 'MULTI_VIEW_STAGE') {
            node.panelType = 'VIEWPORT';
            changed = true;
        }
    } else if (node.type === 'split') {
        changed = normalizeLayoutPanels(node.firstChild) || changed;
        changed = normalizeLayoutPanels(node.secondChild) || changed;
    }
    return changed;
}

function hasPanelType(node: LayoutNode, type: PanelType): boolean {
    if (node.type === 'panel') {
        return node.panelType === type;
    }
    return hasPanelType(node.firstChild, type) || hasPanelType(node.secondChild, type);
}

function ensureMenuBar(node: LayoutNode): LayoutNode {
    if (hasPanelType(node, 'MENU_BAR')) {
        return node;
    }
    return {
        type: 'split',
        id: 'split-menu-root',
        direction: 'vertical',
        ratio: 0.035,
        firstChild: {
            type: 'panel',
            id: 'panel-menu-bar',
            panelType: 'MENU_BAR',
            targetNodeId: null
        },
        secondChild: node
    };
}

export function canonicalizeQuantity(q: string | undefined | null): string {
    if (!q) return 'pressure';
    const s = q.trim().toLowerCase();
    if (s === 'overpressure' || s === 'peak_overpressure' || s === 'peak_pressure' || s === 'pk_press') return 'peak_overpressure';
    if (s === 'impulse' || s === 'peak_impulse' || s === 'pk_impulse') return 'peak_impulse';
    if (s === 'species1' || s === 'species_1' || s === 'species' || s === 'products' || s === 'detonation_products' || s === 'detonation' || s === 'reacted' || s === 'reacted_gas' || s === 'alpha1' || s === 'alpha_1') return 'species1';
    if (s === 'species2' || s === 'species_2' || s === 'unreacted' || s === 'unreacted_solid' || s === 'solid_he' || s === 'alpha2' || s === 'alpha_2') return 'species2';
    if (s === 'species3' || s === 'species_3' || s === 'air' || s === 'ambient_air' || s === 'alpha3' || s === 'alpha_3') return 'species3';
    if (s === 'plastic_strain' || s === 'plasticstrain' || s === 'eps_p' || s === 'ep' || s === 'fem_strain' || s === 'mpm_strain') return 'plastic_strain';
    if (s === 'vonmises' || s === 'von_mises' || s === 'vm_stress' || s === 'stress' || s === 'fem_stress' || s === 'mpm_stress') return 'vonMises';
    if (s === 'temperature' || s === 'temp' || s === 'fem_temp' || s === 'mpm_temp') return 'temperature';
    if (s === 'displacement' || s === 'disp' || s === 'fem_disp' || s === 'mpm_disp') return 'displacement';
    if (s === 'damage' || s === 'fem_damage' || s === 'mpm_damage') return 'damage';
    if (s === 'has_failed' || s === 'failure' || s === 'failed') return 'has_failed';
    if (s === 'cluster_id' || s === 'cluster' || s === 'fragment_id' || s === 'fragments') return 'cluster_id';
    if (s === 'object_id' || s === 'obj_id' || s === 'object') return 'object_id';
    if (s === 'pressure' || s === 'density' || s === 'velocity' || s === 'energy' || s === 'solid' || s === 'amr_level') return s;
    return s;
}

export const DEFAULT_QUANTITY_RANGES: Record<string, [number, number]> = {
    pressure: [101325.0, 101325.0 * 100.0],
    density: [1.2, 100.0],
    velocity: [0.0, 1000.0],
    energy: [200000.0, 10000000.0],
    species1: [0.0, 1.0],
    species2: [0.0, 1.0],
    species3: [0.0, 1.0],
    solid: [0.0, 1.0],
    overpressure: [0.0, 101325.0 * 99.0],
    impulse: [0.0, 10000.0],
    peak_overpressure: [0.0, 101325.0 * 99.0],
    peak_impulse: [0.0, 10000.0],
    vonMises: [0.0, 500000000.0],
    von_mises: [0.0, 500000000.0],
    plasticStrain: [0.0, 1.0],
    plastic_strain: [0.0, 1.0],
    damage: [0.0, 1.0],
    has_failed: [0.0, 1.0],
    cluster_id: [0.0, 50.0],
    object_id: [0.0, 10.0],
    temperature: [300.0, 3000.0],
    displacement: [0.0, 0.1],
    momentOrForce: [0.0, 1000.0]
};

function syncQuantityRanges(node: Node, parameters: Record<string, any>, merged: Record<string, any>) {
    if (node.type !== 'Telemetry3DViewport') return;

    if (!merged.quantity_ranges) {
        merged.quantity_ranges = { ...DEFAULT_QUANTITY_RANGES };
    }

    const slices = merged.slices || [];
    const focusedIdx = merged.focusedSliceIndex !== undefined ? merged.focusedSliceIndex : 0;
    const slice = slices[focusedIdx] || slices[0] || { quantities: ['pressure'] };
    const rawQty = slice.quantities?.[0] || 'pressure';
    const cQty = canonicalizeQuantity(rawQty);

    if (parameters.min_val !== undefined || parameters.max_val !== undefined) {
        const currentMin = parameters.min_val !== undefined ? parameters.min_val : merged.min_val;
        const currentMax = parameters.max_val !== undefined ? parameters.max_val : merged.max_val;
        merged.quantity_ranges[cQty] = [currentMin, currentMax];
        merged.quantity_ranges[rawQty] = [currentMin, currentMax];
        if (cQty === 'peak_overpressure') merged.quantity_ranges['overpressure'] = [currentMin, currentMax];
        if (cQty === 'peak_impulse') merged.quantity_ranges['impulse'] = [currentMin, currentMax];
        if (cQty === 'plastic_strain') merged.quantity_ranges['plasticStrain'] = [currentMin, currentMax];
        if (cQty === 'vonMises') merged.quantity_ranges['von_mises'] = [currentMin, currentMax];
    } else {
        const range = merged.quantity_ranges[cQty] || merged.quantity_ranges[rawQty] || DEFAULT_QUANTITY_RANGES[cQty] || [0.0, 1.0];
        merged.min_val = range[0];
        merged.max_val = range[1];
    }
}

function constrainAllSlices(model: any): boolean {
    const meshNode = model.nodes.find((n: any) => n.type === 'DomainMesh3D');
    if (!meshNode) return false;

    const xmin = Number(meshNode.parameters?.xmin ?? 0.0);
    const xmax = Number(meshNode.parameters?.xmax ?? 1.0);
    const ymin = Number(meshNode.parameters?.ymin ?? 0.0);
    const ymax = Number(meshNode.parameters?.ymax ?? 1.0);
    const zmin = Number(meshNode.parameters?.zmin ?? 0.0);
    const zmax = Number(meshNode.parameters?.zmax ?? 1.0);

    let totalChanged = false;
    model.nodes.forEach((node: any) => {
        if (node.type === 'Telemetry3DViewport') {
            if (!node.parameters.quantity_ranges) {
                node.parameters.quantity_ranges = {
                    pressure: [101325.0, 101325.0 * 100.0],
                    density: [1.2, 100.0],
                    velocity: [0.0, 1000.0],
                    energy: [200000.0, 10000000.0],
                    species1: [0.0, 1.0],
                    species2: [0.0, 1.0],
                    species3: [0.0, 1.0],
                    solid: [0.0, 1.0]
                };
                totalChanged = true;
            }
        }

        if (node.parameters?.slices && Array.isArray(node.parameters.slices)) {
            let changed = false;
            const slices = node.parameters.slices.map((slice: any) => {
                let minVal = 0.0;
                let maxVal = 1.0;
                if (slice.axis === 'xy') {
                    minVal = zmin;
                    maxVal = zmax;
                } else if (slice.axis === 'xz') {
                    minVal = ymin;
                    maxVal = ymax;
                } else if (slice.axis === 'yz') {
                    minVal = xmin;
                    maxVal = xmax;
                }

                const offset = slice.offset !== undefined ? Number(slice.offset) : (minVal + maxVal) / 2;
                const clamped = Math.max(minVal, Math.min(maxVal, offset));
                if (Math.abs(clamped - offset) > 1e-6) {
                    changed = true;
                    return { ...slice, offset: clamped };
                }
                return slice;
            });

            if (changed) {
                node.parameters.slices = slices;
                totalChanged = true;
            }
        }
    });
    return totalChanged;
}

function syncExplosiveParameters(node: Node, parameters: Record<string, any>, state: { nodes: Node[], connections: Connection[] } | null, updatedKey?: string): void {
    if (node.type !== 'Charge1D' && node.type !== 'Charge2D' && node.type !== 'Charge3D') {
        return;
    }

    const shape = parameters['charge_shape'] || 'Sphere';
    
    let rho = 1630.0;
    if (state) {
        let matNode: any = null;
        const conn = state.connections.find(c => (c.toNode === node.id && (c.toPort === 'material' || c.toPort === 'explosive')) || (c.fromNode === node.id && (c.fromPort === 'material' || c.fromPort === 'explosive')));
        if (conn) {
            const otherId = conn.toNode === node.id ? conn.fromNode : conn.toNode;
            matNode = state.nodes.find(n => n.id === otherId);
        } else if (parameters['material']) {
            matNode = state.nodes.find(n => n.id === parameters['material']);
        }
        if (!matNode) {
            matNode = state.nodes.find(n => n.type === 'Material' && n.parameters?.material_type !== 'Air');
        }
        if (matNode && matNode.type === 'Material') {
            const matType = matNode.parameters?.material_type || 'Air';
            if (matType === 'Ideal Gas Charge') {
                rho = Number(matNode.parameters?.density ?? matNode.parameters?.ideal_rho_0 ?? 1630.0);
            } else {
                rho = Number(matNode.parameters?.rho ?? matNode.parameters?.density ?? 1630.0);
            }
        }
    }

    let height = Number(parameters['charge_height'] !== undefined ? parameters['charge_height'] : 0.2);
    let radius = Number(parameters['charge_radius'] !== undefined ? parameters['charge_radius'] : 0.1);
    let mass = Number(parameters['charge_mass'] !== undefined ? parameters['charge_mass'] : 0.0);
    let ar = Number(parameters['charge_aspect_ratio'] !== undefined ? parameters['charge_aspect_ratio'] : (height > 0 && radius > 0 ? height / (2.0 * radius) : 1.0));
    if (isNaN(ar) || ar <= 0) ar = 1.0;

    const lx = Number(parameters['charge_lx'] !== undefined ? parameters['charge_lx'] : 0.2);
    const ly = Number(parameters['charge_ly'] !== undefined ? parameters['charge_ly'] : 0.2);
    const lz = Number(parameters['charge_lz'] !== undefined ? parameters['charge_lz'] : 0.2);

    if (shape === 'Cylinder') {
        // Mass is dominant for Cylinder:
        // Changing radius or aspect ratio does NOT change mass, but changes the complementary parameter.
        if (updatedKey === 'charge_aspect_ratio') {
            ar = Number(parameters['charge_aspect_ratio']);
            if (ar > 0 && mass > 0 && rho > 0) {
                // R = (M / (2 * pi * rho * AR))^(1/3)
                radius = Math.cbrt(mass / (2.0 * Math.PI * rho * ar));
                height = 2.0 * radius * ar;
                parameters['charge_radius'] = radius;
                parameters['charge_height'] = height;
                parameters['charge_aspect_ratio'] = ar;
            }
        } else if (updatedKey === 'charge_radius') {
            radius = Number(parameters['charge_radius']);
            if (radius > 0 && mass > 0 && rho > 0) {
                // H = M / (pi * rho * R^2)
                height = mass / (Math.PI * rho * radius * radius);
                ar = height / (2.0 * radius);
                parameters['charge_height'] = height;
                parameters['charge_aspect_ratio'] = ar;
                parameters['charge_radius'] = radius;
            }
        } else if (updatedKey === 'charge_height') {
            height = Number(parameters['charge_height']);
            if (height > 0 && mass > 0 && rho > 0) {
                // R = sqrt(M / (pi * rho * H))
                radius = Math.sqrt(mass / (Math.PI * rho * height));
                ar = height / (2.0 * radius);
                parameters['charge_radius'] = radius;
                parameters['charge_aspect_ratio'] = ar;
                parameters['charge_height'] = height;
            }
        } else if (updatedKey === 'charge_mass') {
            mass = Number(parameters['charge_mass']);
            if (mass > 0 && rho > 0 && ar > 0) {
                radius = Math.cbrt(mass / (2.0 * Math.PI * rho * ar));
                height = 2.0 * radius * ar;
                parameters['charge_radius'] = radius;
                parameters['charge_height'] = height;
                parameters['charge_aspect_ratio'] = ar;
            }
        } else {
            // General sync (initial load, shape change, rho change, etc.)
            if (mass > 0 && rho > 0) {
                if (ar <= 0) ar = (height > 0 && radius > 0) ? height / (2.0 * radius) : 1.0;
                radius = Math.cbrt(mass / (2.0 * Math.PI * rho * ar));
                height = 2.0 * radius * ar;
                parameters['charge_radius'] = radius;
                parameters['charge_height'] = height;
                parameters['charge_aspect_ratio'] = ar;
            } else if (radius > 0 && height > 0) {
                mass = Math.PI * radius * radius * height * rho;
                ar = height / (2.0 * radius);
                parameters['charge_mass'] = mass;
                parameters['charge_aspect_ratio'] = ar;
            }
        }
    } else if (shape === 'Block') {
        if (updatedKey === 'charge_lx' || updatedKey === 'charge_ly' || updatedKey === 'charge_lz') {
            parameters['charge_mass'] = lx * ly * lz * rho;
        } else {
            if (mass > 0 && rho > 0) {
                const currentVolume = lx * ly * lz;
                if (currentVolume > 0) {
                    const targetVolume = mass / rho;
                    const scaleFactor = Math.cbrt(targetVolume / currentVolume);
                    parameters['charge_lx'] = lx * scaleFactor;
                    parameters['charge_ly'] = ly * scaleFactor;
                    parameters['charge_lz'] = lz * scaleFactor;
                } else {
                    const size = Math.cbrt(mass / rho);
                    parameters['charge_lx'] = size;
                    parameters['charge_ly'] = size;
                    parameters['charge_lz'] = size;
                }
            }
        }
    } else { // Sphere
        if (updatedKey === 'charge_radius') {
            parameters['charge_mass'] = (4.0 / 3.0) * Math.PI * Math.pow(radius, 3.0) * rho;
        } else {
            if (mass > 0 && rho > 0) {
                parameters['charge_radius'] = Math.cbrt((3.0 * mass) / (4.0 * Math.PI * rho));
            }
        }
    }
}

export function calculateRefinementMeshInfo(_node?: Node, _state?: SimulationState) {
    return {
        subNx: 0, subNy: 0, subNz: 0,
        subTotalCells: 0,
        parentTotalCells: 0,
        allSubgridCells: 0,
        newTotalCells: 0,
        hasParent: false
    };
}

export interface MeshCounts {
    dimension: string;
    n_cells: number;
    nr: number;
    nz: number;
    nx: number;
    ny: number;
    totalCells: number;
    cellSize: number;
    radius?: number;
    max_r?: number;
    max_z?: number;
    xmin?: number;
    xmax?: number;
    ymin?: number;
    ymax?: number;
    zmin?: number;
    zmax?: number;
    dim_x: number;
    dim_y: number;
    dim_z: number;
    volume: number;
}

export function resolveMeshCounts(node: Node, state?: SimulationState): MeshCounts {
    const cellSize = Number(node.parameters['cell_size'] ?? 0.001);
    if (node.type === 'DomainMesh') {
        const radius = Number(node.parameters['domain_radius'] ?? 1.0);
        const n_cells = Math.max(1, Math.round(radius / cellSize));
        return { dimension: '1D', n_cells, nr: 0, nz: 0, nx: 0, ny: 0, totalCells: n_cells, cellSize, radius, dim_x: radius, dim_y: 0, dim_z: 0, volume: 0 };
    } else if (node.type === 'DomainMesh2D') {
        const max_r = Number(node.parameters['max_r'] ?? 1.0);
        const max_z = Number(node.parameters['max_z'] ?? 1.0);
        const nr = Math.max(1, Math.round(max_r / cellSize));
        const nz = Math.max(1, Math.round(max_z / cellSize));
        return { dimension: '2D', n_cells: nr * nz, nr, nz, nx: 0, ny: 0, totalCells: nr * nz, cellSize, max_r, max_z, dim_x: max_r, dim_y: 0, dim_z: max_z, volume: 0 };
    } else if (node.type === 'DomainMesh3D') {
        const xmin = Number(node.parameters['xmin'] ?? 0.0);
        const xmax = Number(node.parameters['xmax'] ?? 1.0);
        const ymin = Number(node.parameters['ymin'] ?? 0.0);
        const ymax = Number(node.parameters['ymax'] ?? 1.0);
        const zmin = Number(node.parameters['zmin'] ?? 0.0);
        const zmax = Number(node.parameters['zmax'] ?? 1.0);

        const dim_x = Math.max(0.0001, xmax - xmin);
        const dim_y = Math.max(0.0001, ymax - ymin);
        const dim_z = Math.max(0.0001, zmax - zmin);
        const nx = Math.max(1, Math.round(dim_x / cellSize));
        const ny = Math.max(1, Math.round(dim_y / cellSize));
        const nz = Math.max(1, Math.round(dim_z / cellSize));
        const totalCells = nx * ny * nz;
        const volume = dim_x * dim_y * dim_z;

        return { dimension: '3D', n_cells: totalCells, nr: 0, nz, nx, ny, totalCells, cellSize, xmin, xmax, ymin, ymax, zmin, zmax, dim_x, dim_y, dim_z, volume };
    } else if (node.type === 'CFDSolver' || node.type === 'CFDSolver2D' || node.type === 'CFDSolver3D') {
        let meshNode: Node | undefined;
        if (state) {
            const meshConn = state.connections.find(c => c.toNode === node.id && (c.toPort === 'mesh' || c.toPort === 'in'));
            if (meshConn) meshNode = state.nodes.find(n => n.id === meshConn.fromNode);
            if (!meshNode) {
                const targetMeshType = node.type === 'CFDSolver3D' ? 'DomainMesh3D' : (node.type === 'CFDSolver2D' ? 'DomainMesh2D' : 'DomainMesh');
                meshNode = state.nodes.find(n => n.type === targetMeshType);
            }
        }
        if (meshNode) {
            return resolveMeshCounts(meshNode, state);
        }
        return { dimension: node.type === 'CFDSolver3D' ? '3D' : (node.type === 'CFDSolver2D' ? '2D' : '1D'), n_cells: 0, nr: 0, nz: 0, nx: 0, ny: 0, totalCells: 0, cellSize: 0.001, dim_x: 0, dim_y: 0, dim_z: 0, volume: 0 };
    }
    return { dimension: '3D', n_cells: 0, nr: 0, nz: 0, nx: 0, ny: 0, totalCells: 0, cellSize: 0.001, dim_x: 0, dim_y: 0, dim_z: 0, volume: 0 };
}

export interface CFDMemoryBreakdown {
    bytesPerCell: number;
    totalBytes: number;
    memoryMB: number;
    memoryGB: number;
    formattedMemory: string;
    isCpu: boolean;
    isDouble: boolean;
    isMultiMat: boolean;
    schemeName: string;
    fluxScheme: string;
    precisionLabel: string;
    deviceLabel: string;
    schemeShort: string;
    matShort: string;
    fluxShort: string;
    precShort: string;
}

export function calculateCFDMemory(node: Node, state?: SimulationState, totalCells?: number): CFDMemoryBreakdown {
    // 1. Resolve fresh target CFD solver node & mesh node
    let solverNode: Node | undefined;
    if (['CFDSolver3D', 'CFDSolver2D', 'CFDSolver', 'FSICoupler3D', 'FEMFSICoupler3D', 'FSICoupler2D'].includes(node.type)) {
        solverNode = node;
    } else if (state) {
        const conn = state.connections.find(c => (c.fromNode === node.id && (c.toPort === 'mesh' || c.toPort === 'in')) || (c.toNode === node.id && (c.fromPort === 'mesh' || c.fromPort === 'in')));
        if (conn) {
            const otherId = conn.fromNode === node.id ? conn.toNode : conn.fromNode;
            solverNode = state.nodes.find(n => n.id === otherId && ['CFDSolver3D', 'CFDSolver2D', 'CFDSolver', 'FSICoupler3D', 'FEMFSICoupler3D', 'FSICoupler2D'].includes(n.type));
        }
        if (!solverNode) {
            const targetType = node.type === 'DomainMesh3D' ? 'CFDSolver3D' : (node.type === 'DomainMesh2D' ? 'CFDSolver2D' : 'CFDSolver');
            solverNode = state.nodes.find(n => n.type === targetType || (targetType === 'CFDSolver3D' && (n.type === 'FSICoupler3D' || n.type === 'FEMFSICoupler3D')));
        }
    }

    const is3D = node.type === 'DomainMesh3D' || node.type === 'CFDSolver3D' || node.type === 'FSICoupler3D' || node.type === 'FEMFSICoupler3D';
    const is2D = node.type === 'DomainMesh2D' || node.type === 'CFDSolver2D' || node.type === 'FSICoupler2D';
    const is1D = !is3D && !is2D;

    // Resolve freshest parameters from state or node
    const freshNode = state?.nodes.find(n => n.id === node.id) || node;
    const freshSolver = solverNode ? (state?.nodes.find(n => n.id === solverNode.id) || solverNode) : freshNode;
    const params = { ...(freshNode.parameters || {}), ...(freshSolver.parameters || {}) };
    
    // Precision
    const precision = String(params['precision'] ?? 'single').toLowerCase();
    const isDouble = precision === 'double' || precision === 'float64';
    const realBytes = (isDouble || is1D) ? 8 : 4;
    const precShort = isDouble ? 'Float64' : 'Float32';
    const precisionLabel = isDouble ? 'Double Precision (FP64)' : 'Single Precision (FP32)';

    // Device
    const device = String(params['device'] ?? 'cuda').toLowerCase();
    const isCpu = device === 'cpu';
    const deviceLabel = isCpu ? 'CPU RAM' : 'CUDA VRAM';

    // Multi-Material vs Single-Material (Ideal Gas)
    // Matches backend BlastSolver: Single-Material Ideal Gas is instantiated if init_mode is Ideal Gas,
    // explosive_type is MaterialIdealGas, material_type is Ideal Gas Charge, or multi_material is Disabled.
    const initMode = String(params['init_mode'] ?? '');
    const explosiveType = String(params['explosive_type'] ?? '');
    const materialType = String(params['material_type'] ?? '');
    const isIdealGasExplicit = params['is_ideal_gas'] === true || 
                               params['is_ideal_gas'] === 'true' || 
                               initMode === 'Ideal Gas' || 
                               initMode === 'Single-Material Ideal Gas' || 
                               explosiveType === 'MaterialIdealGas' || 
                               materialType === 'Ideal Gas Charge' ||
                               params['multi_material'] === false ||
                               params['multi_material'] === 'Disabled';

    let isMultiMat = false;
    if (isIdealGasExplicit) {
        isMultiMat = false;
    } else if (params['multi_material'] === true || params['multi_material'] === 'Enabled' || initMode === 'Multi-Material JWL' || initMode.toLowerCase().includes('multi')) {
        isMultiMat = true;
    } else {
        // Check graph topology if init_mode is not explicitly forced
        const hasCharge = state ? state.nodes.some(n => n.type === 'Charge3D' || n.type === 'Charge2D' || n.type === 'Charge1D') : false;
        const hasJwlMaterial = state ? state.nodes.some(n => n.type === 'Material' && ['JWL Detonation Gas', 'JWL Charge'].includes(n.parameters?.material_model || n.parameters?.material_type)) : false;
        const nonAirMaterialCount = state ? state.nodes.filter(n => n.type === 'Material' && n.parameters?.material_model !== 'Ideal Gas' && n.parameters?.material_type !== 'Air').length : 0;
        
        isMultiMat = hasCharge || hasJwlMaterial || nonAirMaterialCount > 0;
    }

    const matShort = isMultiMat ? 'Multi-Mat' : 'Ideal Gas (Single-Mat)';

    // Space-Time Scheme
    let schemeName = String(params['space_time_scheme'] ?? '');
    if (!schemeName) {
        const so = Number(params['spatial_order'] ?? 2);
        const to = Number(params['temporal_order'] ?? 4);
        if (so === 3 && (to === 6 || to === 3)) schemeName = 'ADER-3 (3rd-Order Space/Time)';
        else if (so === 2 && (to === 5 || to === 2)) schemeName = 'ADER-2 (2nd-Order Space/Time)';
        else schemeName = 'MUSCL-Hancock (2nd-Order Space/Time)';
    }

    let schemeShort = 'ADER-2';
    let schemeMultiplier = 2; // Default ADER-2: d_states_pred + d_dW_dt (2 tiles)
    if (schemeName.includes('ADER-3')) {
        schemeShort = 'ADER-3';
        schemeMultiplier = 3; // ADER-3: d_states_pred + d_dW_dt + d2W_dt2 tensor scratch (3 tiles)
    } else if (schemeName.includes('ADER-2')) {
        schemeShort = 'ADER-2';
        schemeMultiplier = 2; // ADER-2: d_states_pred + d_dW_dt (2 tiles)
    } else if (schemeName.includes('MUSCL')) {
        schemeShort = 'MUSCL';
        schemeMultiplier = 1; // MUSCL-Hancock: d_states_pred half-step state (1 tile)
    } else if (schemeName.includes('RK') || schemeName.includes('TVD')) {
        schemeShort = 'RK2';
        schemeMultiplier = 1; // RK2 / TVD: U_stage intermediate buffer (1 tile)
    }

    // Flux Scheme
    const rawFlux = String(params['flux_scheme'] ?? 'AUSM+');
    const fluxShort = rawFlux.toLowerCase().includes('rusanov') ? 'Rusanov' :
                      (rawFlux.toLowerCase().includes('ausm') ? 'AUSM+' :
                      (rawFlux.toLowerCase().includes('roe') ? 'Roe' :
                      (rawFlux.toLowerCase().includes('exact') ? 'Exact' :
                      (rawFlux.toLowerCase().includes('hllc') ? 'HLLC' : 'AUSM+'))));

    // Exact Memory Calculation (Bytes per Cell)
    let bytesPerCell = 0;
    if (is3D) {
        // Conservative State
        const numConsVars = isMultiMat ? 9 : 5;
        const consBytes = numConsVars * realBytes;

        // Primitive State + floor status
        const numPrimVars = isMultiMat ? 12 : 8;
        const primBytes = numPrimVars * realBytes + 1;

        // Scheme space-time prediction / staging buffer:
        // ADER-3 = 3 tiles (states_pred, dW_dt, d2W_dt2 tensor scratch)
        // ADER-2 = 2 tiles (states_pred, dW_dt)
        // MUSCL = 1 tile (states_pred)
        // RK2 = 1 tile (U_stage)
        const schemeVars = schemeMultiplier * (isMultiMat ? 9 : 5);
        const schemeBytes = schemeVars * realBytes;

        // Geometry Tile (nx, ny, nz, solid_fraction)
        const geomBytes = 4;

        // Flux workspace scratch:
        // AUSM+ = 0 B (pure interface splitting evaluated in registers)
        // Rusanov = 0.5 B (spectral radius dissipation buffer)
        // Roe / Exact = 4.0 B (matrix eigenvalues / Roe averaged scratch)
        // HLLC = 2.0 B (star region wave speeds)
        let fluxBytes = 0;
        if (fluxShort === 'Rusanov') fluxBytes = 0.5;
        else if (fluxShort === 'Roe' || fluxShort === 'Exact') fluxBytes = 4.0;
        else if (fluxShort === 'HLLC') fluxBytes = 2.0;

        // Tile flags, active indices, UncoveringMaskTile3D, boundary buffers
        const overheadBytes = 0.5;

        bytesPerCell = consBytes + primBytes + schemeBytes + geomBytes + fluxBytes + overheadBytes;
    } else if (is2D) {
        // 2D Axisymmetric / Planar
        const numConsVars = isMultiMat ? 8 : 4;
        const consBytes = numConsVars * realBytes;
        const numPrimVars = isMultiMat ? 9 : 5;
        const primBytes = numPrimVars * realBytes + 1;
        const schemeVars = schemeMultiplier * (isMultiMat ? 8 : 4);
        const schemeBytes = schemeVars * realBytes;
        const geomBytes = 2;
        let fluxBytes = 0;
        if (fluxShort === 'Rusanov') fluxBytes = 0.5;
        else if (fluxShort === 'Roe' || fluxShort === 'Exact') fluxBytes = 2.0;
        else if (fluxShort === 'HLLC') fluxBytes = 1.0;
        const overheadBytes = 0.5;
        bytesPerCell = consBytes + primBytes + schemeBytes + geomBytes + fluxBytes + overheadBytes;
    } else {
        // 1D Radial / Planar (Double Precision FP64)
        const numVars = isMultiMat ? 7 : 4;
        bytesPerCell = (numVars * 2 + 5) * 8; // Cons + Prim + Predictor/Limiter
    }

    const cells = totalCells ?? (resolveMeshCounts(node, state).totalCells);
    const totalBytes = cells * bytesPerCell;
    const memoryMB = totalBytes / (1024 * 1024);
    const memoryGB = totalBytes / (1024 * 1024 * 1024);

    let formattedMemory: string;
    if (memoryMB >= 1024) {
        formattedMemory = `${memoryGB.toFixed(2)} GB (${memoryMB.toFixed(1)} MB)`;
    } else {
        formattedMemory = `${memoryMB.toFixed(2)} MB`;
    }

    return {
        bytesPerCell,
        totalBytes,
        memoryMB,
        memoryGB,
        formattedMemory,
        isCpu,
        isDouble,
        isMultiMat,
        schemeName,
        fluxScheme: rawFlux,
        precisionLabel,
        deviceLabel,
        schemeShort,
        matShort,
        fluxShort,
        precShort
    };
}

export function getMeshDisplayHTML(node: Node, state?: SimulationState): string {
    const counts = resolveMeshCounts(node, state);
    const mem = calculateCFDMemory(node, state, counts.totalCells);

    if (counts.dimension === '1D') {
        const n_cells = counts.n_cells;
        return `<div style="background: rgba(56, 189, 248, 0.08); border: 1px solid #38bdf8; border-radius: 4px; padding: 6px 8px; font-size: 11px;">` +
               `<div style="color: #38bdf8; font-weight: bold; margin-bottom: 2px;">📐 1D Radial Mesh Specification</div>` +
               `<div>Calculated Grid: <b style="color: #fff;">${n_cells.toLocaleString()} cells</b> (dx = ${(counts.cellSize * 1000).toFixed(2)} mm)</div>` +
               `<div>Domain Radius: <b>${(counts.radius ?? 1.0).toFixed(3)} m</b></div>` +
               `<div>Est. CFD State Memory: <b style="color: #4ec9b0;">${mem.formattedMemory}</b> <span style="font-size: 10px; color: #94a3b8;">(${mem.matShort} · FP64)</span></div>` +
               `</div>`;
    } else if (counts.dimension === '2D') {
        const nr = counts.nr;
        const nz = counts.nz;
        const total = counts.totalCells;
        return `<div style="background: rgba(56, 189, 248, 0.08); border: 1px solid #38bdf8; border-radius: 4px; padding: 6px 8px; font-size: 11px;">` +
               `<div style="color: #38bdf8; font-weight: bold; margin-bottom: 2px;">📐 2D Axisymmetric Grid Specification</div>` +
               `<div>Grid Discretization: <b style="color: #fff;">${nr} x ${nz} cells</b> (Total: <b style="color: #38bdf8;">${total.toLocaleString()}</b>)</div>` +
               `<div>Cell Resolution: <b>dr = dz = ${(counts.cellSize * 1000).toFixed(2)} mm</b></div>` +
               `<div>Domain Bounds: <b>R = ${(counts.max_r ?? 1.0).toFixed(2)} m</b> × <b>Z = ${(counts.max_z ?? 1.0).toFixed(2)} m</b></div>` +
               `<div>Est. CFD State ${mem.isCpu ? 'RAM (CPU)' : 'VRAM'}: <b style="color: #4ec9b0;">${mem.formattedMemory}</b> <span style="font-size: 10px; color: #94a3b8;">(${mem.schemeShort} · ${mem.matShort} · ${mem.precShort} · ${mem.fluxShort})</span></div>` +
               `</div>`;
    } else if (counts.dimension === '3D') {
        const nx = counts.nx;
        const ny = counts.ny;
        const nz = counts.nz;
        const total = counts.totalCells;
        const vol = counts.volume;

        return `<div style="background: rgba(56, 189, 248, 0.08); border: 1px solid #38bdf8; border-radius: 4px; padding: 6px 8px; font-size: 11px;">` +
               `<div style="color: #38bdf8; font-weight: bold; margin-bottom: 2px;">📐 3D Cartesian Grid Specification</div>` +
               `<div>Grid Discretization: <b style="color: #fff;">${nx} x ${ny} x ${nz} cells</b> (Total: <b style="color: #38bdf8;">${total.toLocaleString()}</b>)</div>` +
               `<div>Cell Size: <b>dx = dy = dz = ${(counts.cellSize * 1000).toFixed(2)} mm</b></div>` +
               `<div>Domain Box: <b>${(counts.dim_x ?? 1).toFixed(2)}m × ${(counts.dim_y ?? 1).toFixed(2)}m × ${(counts.dim_z ?? 1).toFixed(2)}m</b> (Vol: ${vol.toFixed(4)} m³)</div>` +
               `<div>Est. CFD State ${mem.isCpu ? 'RAM (CPU)' : 'VRAM'}: <b style="color: #4ec9b0;">${mem.formattedMemory}</b> <span style="font-size: 10px; color: #94a3b8;">(${mem.schemeShort} · ${mem.matShort} · ${mem.precShort} · ${mem.fluxShort})</span></div>` +
               `</div>`;
    }
    return '';
}

export interface DomainBounds3D {
    xmin: number;
    xmax: number;
    ymin: number;
    ymax: number;
    zmin: number;
    zmax: number;
    dim_x: number;
    dim_y: number;
    dim_z: number;
    cellSize: number;
}

export function resolveDomain3DBounds(node?: Node | null, state?: SimulationState | null, model?: Model | null): DomainBounds3D {
    let xmin = 0.0, xmax = 1.0;
    let ymin = 0.0, ymax = 1.0;
    let zmin = 0.0, zmax = 1.0;
    let cellSize = 0.01;

    // 1. If node is directly a DomainMesh3D
    if (node && node.type === 'DomainMesh3D') {
        xmin = Number(node.parameters?.xmin ?? node.parameters?.x_min ?? node.parameters?.origin_x ?? 0.0);
        xmax = Number(node.parameters?.xmax ?? node.parameters?.x_max ?? (xmin + Number(node.parameters?.length_x ?? 1.0)));
        ymin = Number(node.parameters?.ymin ?? node.parameters?.y_min ?? node.parameters?.origin_y ?? 0.0);
        ymax = Number(node.parameters?.ymax ?? node.parameters?.y_max ?? (ymin + Number(node.parameters?.length_y ?? 1.0)));
        zmin = Number(node.parameters?.zmin ?? node.parameters?.z_min ?? node.parameters?.origin_z ?? 0.0);
        zmax = Number(node.parameters?.zmax ?? node.parameters?.z_max ?? (zmin + Number(node.parameters?.length_z ?? 1.0)));
        cellSize = Number(node.parameters?.cell_size ?? node.parameters?.dx ?? 0.01);
        return { xmin, xmax, ymin, ymax, zmin, zmax, dim_x: Math.max(1e-5, xmax - xmin), dim_y: Math.max(1e-5, ymax - ymin), dim_z: Math.max(1e-5, zmax - zmin), cellSize };
    }

    // 2. Find target nodes collection
    const nodes = model?.nodes || state?.nodes || [];
    const connections = model?.connections || state?.connections || [];

    // Check upstream connection from node if provided
    if (node) {
        const incoming = connections.filter(c => c.toNode === node.id);
        for (const conn of incoming) {
            const upNode = nodes.find(n => n.id === conn.fromNode);
            if (upNode && upNode.type === 'DomainMesh3D') {
                return resolveDomain3DBounds(upNode, state, model);
            }
            if (upNode && (upNode.type === 'CFDSolver3D' || upNode.type === 'MPMDomain3D' || upNode.type === 'FEMDomain3D')) {
                const solverMeshConn = connections.find(c => c.toNode === upNode.id && (c.toPort === 'mesh' || c.toPort === 'in'));
                if (solverMeshConn) {
                    const meshNode = nodes.find(n => n.id === solverMeshConn.fromNode);
                    if (meshNode && meshNode.type === 'DomainMesh3D') {
                        return resolveDomain3DBounds(meshNode, state, model);
                    }
                }
            }
        }
    }

    // Search model/state for DomainMesh3D
    const meshNode3D = nodes.find(n => n.type === 'DomainMesh3D');
    if (meshNode3D) {
        return resolveDomain3DBounds(meshNode3D, state, model);
    }

    // Search model/state for MPMDomain3D
    const mpmDomain = nodes.find(n => n.type === 'MPMDomain3D');
    if (mpmDomain && mpmDomain.parameters?.xmin !== undefined && mpmDomain.parameters?.xmax !== undefined) {
        xmin = Number(mpmDomain.parameters.xmin ?? 0.0);
        xmax = Number(mpmDomain.parameters.xmax ?? 1.0);
        ymin = Number(mpmDomain.parameters.ymin ?? 0.0);
        ymax = Number(mpmDomain.parameters.ymax ?? 1.0);
        zmin = Number(mpmDomain.parameters.zmin ?? 0.0);
        zmax = Number(mpmDomain.parameters.zmax ?? 1.0);
        cellSize = Number(mpmDomain.parameters.cell_size ?? 0.01);
        return { xmin, xmax, ymin, ymax, zmin, zmax, dim_x: Math.max(1e-5, xmax - xmin), dim_y: Math.max(1e-5, ymax - ymin), dim_z: Math.max(1e-5, zmax - zmin), cellSize };
    }

    // Search model/state for DomainMesh2D
    const meshNode2D = nodes.find(n => n.type === 'DomainMesh2D');
    if (meshNode2D) {
        const max_r = Number(meshNode2D.parameters?.max_r ?? 1.0);
        const max_z = Number(meshNode2D.parameters?.max_z ?? 1.0);
        cellSize = Number(meshNode2D.parameters?.cell_size ?? 0.01);
        return { xmin: 0.0, xmax: max_r, ymin: 0.0, ymax: max_r, zmin: 0.0, zmax: max_z, dim_x: max_r, dim_y: max_r, dim_z: max_z, cellSize };
    }

    // Search model/state for DomainMesh 1D
    const meshNode1D = nodes.find(n => n.type === 'DomainMesh');
    if (meshNode1D) {
        const radius = Number(meshNode1D.parameters?.domain_radius ?? 1.0);
        cellSize = Number(meshNode1D.parameters?.cell_size ?? 0.001);
        return { xmin: -radius, xmax: radius, ymin: -radius, ymax: radius, zmin: -radius, zmax: radius, dim_x: 2 * radius, dim_y: 2 * radius, dim_z: 2 * radius, cellSize };
    }

    // Fallback: Check geometric objects in model
    const geoNodes = nodes.filter(n => ['FEMObject3D', 'MPMObject3D', 'PrimitiveGeometry3D', 'Charge3D'].includes(n.type));
    if (geoNodes.length > 0) {
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        for (const obj of geoNodes) {
            const px = Number(obj.parameters?.pos_x ?? obj.parameters?.charge_x ?? 0.0);
            const py = Number(obj.parameters?.pos_y ?? obj.parameters?.charge_y ?? 0.0);
            const pz = Number(obj.parameters?.pos_z ?? obj.parameters?.charge_z ?? 0.0);
            const sx = Number(obj.parameters?.size_x ?? obj.parameters?.charge_lx ?? obj.parameters?.radius ?? 0.1);
            const sy = Number(obj.parameters?.size_y ?? obj.parameters?.charge_ly ?? obj.parameters?.radius ?? 0.1);
            const sz = Number(obj.parameters?.size_z ?? obj.parameters?.charge_lz ?? obj.parameters?.height ?? 0.1);
            minX = Math.min(minX, px - sx, px);
            maxX = Math.max(maxX, px + sx);
            minY = Math.min(minY, py - sy, py);
            maxY = Math.max(maxY, py + sy);
            minZ = Math.min(minZ, pz - sz, pz);
            maxZ = Math.max(maxZ, pz + sz);
        }
        if (isFinite(minX) && isFinite(maxX) && maxX > minX) {
            return { xmin: minX, xmax: maxX, ymin: minY, ymax: maxY, zmin: minZ, zmax: maxZ, dim_x: maxX - minX, dim_y: maxY - minY, dim_z: maxZ - minZ, cellSize };
        }
    }

    return { xmin: 0.0, xmax: 1.0, ymin: 0.0, ymax: 1.0, zmin: 0.0, zmax: 1.0, dim_x: 1.0, dim_y: 1.0, dim_z: 1.0, cellSize: 0.01 };
}

/**
 * Standardized single convention for slice normal directions across the entire application:
 * - "X-Normal" (YZ cross-section cutting at an X coordinate)
 * - "Y-Normal" (XZ cross-section cutting at a Y coordinate)
 * - "Z-Normal" (XY cross-section cutting at a Z coordinate)
 */
export function getSliceAxisLabel(axis: string | number | undefined | null): 'X-Normal' | 'Y-Normal' | 'Z-Normal' {
    const ax = String(axis ?? 'xy').toLowerCase().trim();
    if (ax === 'yz' || ax === '2' || ax === 'x' || ax.startsWith('x-norm') || ax === 'normal x' || ax === 'x normal') {
        return 'X-Normal';
    } else if (ax === 'xz' || ax === '1' || ax === 'y' || ax.startsWith('y-norm') || ax === 'normal y' || ax === 'y normal') {
        return 'Y-Normal';
    } else {
        return 'Z-Normal';
    }
}

export function resolveSliceDomainBounds(axis: string, node?: Node | null, state?: SimulationState | null, model?: Model | null): { min: number, max: number, step: number } {
    const domain = resolveDomain3DBounds(node, state, model);
    const ax = String(axis || 'xy').toLowerCase().trim();
    let min = domain.zmin;
    let max = domain.zmax;

    if (ax === 'yz' || ax === '2' || ax === 'x' || ax.startsWith('x-norm') || ax === 'normal x' || ax === 'x normal') {
        min = domain.xmin;
        max = domain.xmax;
    } else if (ax === 'xz' || ax === '1' || ax === 'y' || ax.startsWith('y-norm') || ax === 'normal y' || ax === 'y normal') {
        min = domain.ymin;
        max = domain.ymax;
    } else {
        min = domain.zmin;
        max = domain.zmax;
    }

    if (max <= min) {
        max = min + 1.0;
    }

    const span = max - min;
    const step = Math.max(0.00001, Math.min(0.01, span / 200.0));
    return { min, max, step };
}

export interface STLGeometryMeta {
    volume: number; // Volume in m^3 (unscaled)
    bounds: [number, number, number, number, number, number]; // [minX, maxX, minY, maxY, minZ, maxZ]
    triangleCount: number;
}

const stlGeometryCache = new Map<string, STLGeometryMeta>();

export function registerSTLVertices(filePath: string, vertices: Float32Array): STLGeometryMeta {
    if (!filePath || vertices.length < 9) {
        const meta: STLGeometryMeta = { volume: 0.001, bounds: [-0.05, 0.05, -0.05, 0.05, -0.05, 0.05], triangleCount: 0 };
        return meta;
    }

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    let signedVolumeSum = 0.0;

    const numTriangles = Math.floor(vertices.length / 9);
    for (let i = 0; i < numTriangles; i++) {
        const x0 = vertices[i * 9 + 0], y0 = vertices[i * 9 + 1], z0 = vertices[i * 9 + 2];
        const x1 = vertices[i * 9 + 3], y1 = vertices[i * 9 + 4], z1 = vertices[i * 9 + 5];
        const x2 = vertices[i * 9 + 6], y2 = vertices[i * 9 + 7], z2 = vertices[i * 9 + 8];

        minX = Math.min(minX, x0, x1, x2); maxX = Math.max(maxX, x0, x1, x2);
        minY = Math.min(minY, y0, y1, y2); maxY = Math.max(maxY, y0, y1, y2);
        minZ = Math.min(minZ, z0, z1, z2); maxZ = Math.max(maxZ, z0, z1, z2);

        // Signed volume of tetrahedron formed with origin: (1/6) * (v0 . (v1 x v2))
        const v3 = x0 * (y1 * z2 - z1 * y2) - y0 * (x1 * z2 - z1 * x2) + z0 * (x1 * y2 - y1 * x2);
        signedVolumeSum += v3;
    }

    let volume = Math.abs(signedVolumeSum) / 6.0;
    const bboxVolume = (maxX - minX) * (maxY - minY) * (maxZ - minZ);

    // Fallback if mesh is non-watertight or degenerate signed volume
    if (volume <= 1e-12 && bboxVolume > 0) {
        volume = bboxVolume * 0.5;
    }

    const meta: STLGeometryMeta = {
        volume,
        bounds: [minX, maxX, minY, maxY, minZ, maxZ],
        triangleCount: numTriangles
    };

    stlGeometryCache.set(filePath, meta);
    return meta;
}

export function getSTLGeometryMeta(filePath: string): STLGeometryMeta | undefined {
    return stlGeometryCache.get(filePath);
}

export function getMPMObjectVolume(node: Node, state?: SimulationState): { volume: number, isStlEstimated: boolean } {
    const is3D = node.type === 'MPMObject3D';
    const shapeType = String(node.parameters['shape_type'] || (is3D ? 'Box' : 'Rectangle'));
    let isStlEstimated = false;
    let volume = 0.0;

    if (shapeType === 'Box') {
        const sx = Number(node.parameters['size_x'] ?? 0.2);
        const sy = Number(node.parameters['size_y'] ?? 0.2);
        const sz = Number(node.parameters['size_z'] ?? 0.2);
        volume = sx * sy * sz;
    } else if (shapeType === 'Sphere') {
        const r = Number(node.parameters['radius'] ?? 0.1);
        volume = (4.0 / 3.0) * Math.PI * Math.pow(r, 3);
    } else if (shapeType === 'Cylinder') {
        const r = Number(node.parameters['radius'] ?? 0.1);
        const ir = Number(node.parameters['inner_radius'] ?? 0.0);
        const h = Number(node.parameters['height'] ?? 0.2);
        volume = Math.max(0.0, Math.PI * (r * r - ir * ir) * h);
    } else if (shapeType === 'STL') {
        const scx = Number(node.parameters['scale_x'] ?? 1.0);
        const scy = Number(node.parameters['scale_y'] ?? 1.0);
        const scz = Number(node.parameters['scale_z'] ?? 1.0);
        let stlFile = String(node.parameters['stl_file'] || '');
        if (!stlFile && state) {
            const stlConn = state.connections.find(c => c.toNode === node.id && c.toPort === 'stl');
            if (stlConn) {
                const stlNode = state.nodes.find(n => n.id === stlConn.fromNode);
                if (stlNode && stlNode.type === 'STLGeometry') {
                    stlFile = String(stlNode.parameters['stl_file'] || '');
                }
            }
        }
        const meta = getSTLGeometryMeta(stlFile);

        if (meta && meta.volume > 0) {
            volume = meta.volume * scx * scy * scz;
        } else if (node.parameters['stl_volume'] !== undefined && Number(node.parameters['stl_volume']) > 0) {
            volume = Number(node.parameters['stl_volume']) * scx * scy * scz;
        } else {
            // Representative default volume (10cm cube) when STL file geometry is not yet fetched
            volume = 0.001 * scx * scy * scz;
            isStlEstimated = true;
        }
    } else if (shapeType === 'Rectangle') {
        const sx = Number(node.parameters['size_x'] ?? 0.2);
        const sy = Number(node.parameters['size_y'] ?? 0.2);
        volume = sx * sy;
    } else if (shapeType === 'Circle' || shapeType === 'Disk') {
        const r = Number(node.parameters['radius'] ?? 0.1);
        volume = Math.PI * r * r;
    } else if (shapeType === 'Ring') {
        const r = Number(node.parameters['radius'] ?? 0.1);
        const ir = Number(node.parameters['inner_radius'] ?? 0.0);
        volume = Math.max(0.0, Math.PI * (r * r - ir * ir));
    } else {
        const sx = Number(node.parameters['size_x'] ?? 0.2);
        const sy = Number(node.parameters['size_y'] ?? 0.2);
        const sz = Number(node.parameters['size_z'] ?? 0.2);
        volume = sx * sy * sz;
    }

    return { volume: Math.max(1e-9, volume), isStlEstimated };
}

export interface FEMCounts {
    shapeType: string;
    meshSource: string;
    numElements: number;
    numNodes: number;
    dx: number;
    dy: number;
    dz: number;
    volume: number;
    vramMB: number;
    objCount: number;
    totalElements: number;
    totalNodes: number;
    convertToMpm: boolean;
    mpmParticlesPerElem: number;
    maxDebrisParticles: number;
    totalVramMB: number;
    kFile: string;
    scaleFactor: number;
}

export function resolveFEMCounts(node: Node, state?: SimulationState): FEMCounts {
    let numElements = 0;
    let numNodes = 0;
    let totalElements = 0;
    let totalNodes = 0;
    let objCount = 0;
    let shapeType = 'Box';
    let meshSource = 'Box Generator';
    let dx = 0.01, dy = 0.01, dz = 0.01;
    let volume = 0.0;
    let vramMB = 0.0;
    let totalVramMB = 0.0;
    let convertToMpm = false;
    let mpmParticlesPerElem = 8;
    let maxDebrisParticles = 0;
    let kFile = '';
    let scaleFactor = 1.0;

    if (node.type === 'FEMObject3D') {
        meshSource = String(node.parameters['mesh_source'] || 'Box Generator');
        shapeType = String(node.parameters['shape_type'] || 'Box');

        if (shapeType === 'Cylinder' || meshSource === 'Cylinder Generator') {
            const nr = Math.max(1, Number(node.parameters['nr'] ?? 6));
            const ntheta = Math.max(4, Number(node.parameters['ntheta'] ?? 16));
            const nz = Math.max(1, Number(node.parameters['nz'] ?? 10));
            numElements = nr * ntheta * nz;
            numNodes = (nr + 1) * ntheta * (nz + 1);

            const r = Number(node.parameters['radius'] ?? 0.1);
            const h = Number(node.parameters['height'] ?? 0.2);
            volume = Math.PI * r * r * h;
            dx = r / nr;
            dy = r / nr;
            dz = h / nz;
        } else if (shapeType === 'LS-DYNA File' || meshSource === 'LS-DYNA Keyword File') {
            if (node.parameters['k_file']) {
                kFile = String(node.parameters['k_file']);
            } else if (state) {
                const impConn = state.connections.find(c => c.toNode === node.id && c.toPort === 'importer');
                if (impConn) {
                    const impNode = state.nodes.find(n => n.id === impConn.fromNode);
                    if (impNode) kFile = String(impNode.parameters['k_file'] || '');
                }
            }
            numElements = 8000;
            numNodes = 9261;
            volume = 0.008;
            dx = 0.02; dy = 0.02; dz = 0.02;
        } else {
            // Box
            const nx = Math.max(1, Number(node.parameters['nx'] ?? 10));
            const ny = Math.max(1, Number(node.parameters['ny'] ?? 10));
            const nz = Math.max(1, Number(node.parameters['nz'] ?? 10));
            numElements = nx * ny * nz;
            numNodes = (nx + 1) * (ny + 1) * (nz + 1);

            const sx = Number(node.parameters['size_x'] ?? 0.2);
            const sy = Number(node.parameters['size_y'] ?? 0.2);
            const sz = Number(node.parameters['size_z'] ?? 0.2);
            volume = sx * sy * sz;
            dx = sx / nx;
            dy = sy / ny;
            dz = sz / nz;
        }

        const bytesPerElement = 1024;
        vramMB = (numElements * bytesPerElement + numNodes * 128) / (1024 * 1024);
        totalElements = numElements;
        totalNodes = numNodes;
        totalVramMB = vramMB;
    } else if (node.type === 'FEMDomain3D') {
        if (state) {
            const objConns = state.connections.filter(c => c.toNode === node.id && c.toPort === 'objects');
            objCount = objConns.length;
            for (const conn of objConns) {
                const objNode = state.nodes.find(n => n.id === conn.fromNode);
                if (objNode && objNode.type === 'FEMObject3D') {
                    const objCounts = resolveFEMCounts(objNode, state);
                    totalElements += objCounts.numElements;
                    totalNodes += objCounts.numNodes;
                }
            }
        }

        convertToMpm = node.parameters['convert_failed_elements_to_mpm'] === true;
        mpmParticlesPerElem = Number(node.parameters['mpm_particles_per_failed_element'] ?? 8);
        maxDebrisParticles = totalElements * mpmParticlesPerElem;
        totalVramMB = (totalElements * 1024 + totalNodes * 128) / (1024 * 1024);
        numElements = totalElements;
        numNodes = totalNodes;
        vramMB = totalVramMB;
    } else if (node.type === 'LSDynaImporter3D') {
        kFile = String(node.parameters['k_file'] || '');
        scaleFactor = Number(node.parameters['scale_factor'] ?? 1.0);
        totalElements = 8000;
        totalNodes = 9261;
        numElements = 8000;
        numNodes = 9261;
        vramMB = (8000 * 1024 + 9261 * 128) / (1024 * 1024);
        totalVramMB = vramMB;
    }

    return {
        shapeType,
        meshSource,
        numElements,
        numNodes,
        dx,
        dy,
        dz,
        volume,
        vramMB,
        objCount,
        totalElements,
        totalNodes,
        convertToMpm,
        mpmParticlesPerElem,
        maxDebrisParticles,
        totalVramMB,
        kFile,
        scaleFactor
    };
}

export function resolveMPMCounts(node: Node, state?: SimulationState) {
    const is3D = node.type === 'MPMObject3D' || node.type === 'MPMDomain3D';
    const { cellSize, domainPpc } = resolveMPMGridAndDomain(node, state);

    if (node.type === 'MPMObject3D' || node.type === 'MPMObject2D') {
        const shapeType = String(node.parameters['shape_type'] || (is3D ? 'Box' : 'Rectangle'));
        const ppc = Number(node.parameters['ppc'] ?? domainPpc);
        const particlesPerDim = is3D ? Math.max(1, Math.round(Math.cbrt(ppc))) : Math.max(1, Math.round(Math.sqrt(ppc)));
        const p_dx = cellSize / particlesPerDim;
        const p_vol = is3D ? Math.pow(p_dx, 3) : Math.pow(p_dx, 2);

        const { volume, isStlEstimated } = getMPMObjectVolume(node, state);
        const estParticles = Math.max(1, Math.round(volume / (p_vol > 0 ? p_vol : 1e-9)));
        const bytesPerParticle = is3D ? 292 : 128;
        const ramMB = (estParticles * bytesPerParticle) / (1024 * 1024);
        const vramMB = (estParticles * bytesPerParticle) / (1024 * 1024);

        let stlFile = String(node.parameters['stl_file'] || '');
        if (!stlFile && state) {
            const stlConn = state.connections.find(c => c.toNode === node.id && c.toPort === 'stl');
            if (stlConn) {
                const stlNode = state.nodes.find(n => n.id === stlConn.fromNode);
                if (stlNode && stlNode.type === 'STLGeometry') {
                    stlFile = String(stlNode.parameters['stl_file'] || '');
                }
            }
        }
        const stlMeta = shapeType === 'STL' && stlFile ? getSTLGeometryMeta(stlFile) : undefined;

        return { is3D, shapeType, ppc, p_dx, p_vol, volume, estParticles, ramMB, vramMB, stlFile, stlMeta, isStlEstimated };
    } else {
        // MPMDomain3D or MPMDomain2D
        const ppc = Number(node.parameters['ppc'] ?? domainPpc);
        const particlesPerDim = is3D ? Math.max(1, Math.round(Math.cbrt(ppc))) : Math.max(1, Math.round(Math.sqrt(ppc)));
        const p_dx = cellSize / particlesPerDim;
        const p_vol = is3D ? Math.pow(p_dx, 3) : Math.pow(p_dx, 2);

        let connectedParticles = 0;
        let objCount = 0;
        if (state) {
            const objConns = state.connections.filter(c => c.toNode === node.id && (c.toPort === 'objects' || c.toPort === 'mpm'));
            objCount = objConns.length;
            for (const conn of objConns) {
                const objNode = state.nodes.find(n => n.id === conn.fromNode);
                if (objNode) {
                    const { volume } = getMPMObjectVolume(objNode, state);
                    connectedParticles += Math.max(1, Math.round(volume / (p_vol > 0 ? p_vol : 1e-9)));
                }
            }
        }

        const bytesPerParticle = is3D ? 292 : 128;
        const totalVramMB = (connectedParticles * bytesPerParticle) / (1024 * 1024);

        return { is3D, ppc, p_dx, p_vol, objCount, connectedParticles, cellSize, totalVramMB };
    }
}

function resolveMPMGridAndDomain(node: Node, state?: SimulationState) {
    let cellSize = 0.01;
    let domainPpc = 8;
    if (!state) return { cellSize, domainPpc };

    const is3D = node.type === 'MPMObject3D' || node.type === 'MPMDomain3D';
    const domainType = is3D ? 'MPMDomain3D' : 'MPMDomain2D';
    const meshType = is3D ? 'DomainMesh3D' : 'DomainMesh2D';

    let domainNode: Node | undefined;
    if (node.type === domainType) {
        domainNode = node;
    } else {
        const conn = state.connections.find(c => c.fromNode === node.id && (c.toPort === 'objects' || c.toPort === 'mpm'));
        if (conn) {
            domainNode = state.nodes.find(n => n.id === conn.toNode);
        }
        if (!domainNode) {
            domainNode = state.nodes.find(n => n.type === domainType);
        }
    }

    if (domainNode && domainNode.parameters['ppc'] !== undefined) {
        domainPpc = Number(domainNode.parameters['ppc']);
    }

    let meshNode: Node | undefined;
    if (domainNode) {
        const meshConn = state.connections.find(c => c.toNode === domainNode!.id && c.toPort === 'mesh');
        if (meshConn) {
            meshNode = state.nodes.find(n => n.id === meshConn.fromNode);
        }
    }

    if (!meshNode) {
        meshNode = state.nodes.find(n => n.type === meshType);
    }
    if (meshNode && meshNode.parameters['cell_size'] !== undefined) {
        cellSize = Number(meshNode.parameters['cell_size']);
    }

    return { cellSize, domainPpc };
}

export function getMPMDisplayHTML(node: Node, state?: SimulationState): string {
    const is3D = node.type === 'MPMObject3D' || node.type === 'MPMDomain3D';
    const info = resolveMPMCounts(node, state);

    if (node.type === 'MPMObject3D' || node.type === 'MPMObject2D') {
        let stlInfo = '';
        if (info.shapeType === 'STL' && info.stlFile) {
            const fileName = info.stlFile.split('/').pop();
            const estTag = info.isStlEstimated ? ` <span style="color: #e5c07b;">(Unloaded STL)</span>` : ` <span style="color: #98c379;">(${info.stlMeta ? info.stlMeta.triangleCount.toLocaleString() : 0} tris)</span>`;
            stlInfo = `<div style="color: #aaa; margin-bottom: 3px; font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">STL: ${fileName}${estTag}</div>`;
        }

        return `<div style="background: rgba(168, 85, 247, 0.08); border: 1px solid #a855f7; border-radius: 4px; padding: 6px 8px; font-size: 11px;">` +
               `<div style="color: #c084fc; font-weight: bold; margin-bottom: 3px;">🔮 MPM Particle Discretization (${(info.shapeType || 'BOX').toUpperCase()})</div>` +
               stlInfo +
               `<div>Discretized Particles: <b style="color: #fff;">${info.estParticles?.toLocaleString()}</b> (PPC = ${info.ppc})</div>` +
               `<div>Particle Spacing: <b style="color: #4ec9b0;">${((info.p_dx ?? 0.01) * 1000).toFixed(2)} mm</b></div>` +
               `<div>Est. Footprint: <b>RAM ${(info.ramMB ?? 0).toFixed(2)} MB</b> | <b>VRAM ${(info.vramMB ?? 0).toFixed(2)} MB</b></div>` +
               `</div>`;
    } else if (node.type === 'MPMDomain3D' || node.type === 'MPMDomain2D') {
        return `<div style="background: rgba(78, 201, 176, 0.08); border: 1px solid #4ec9b0; border-radius: 4px; padding: 6px 8px; font-size: 11px;">` +
               `<div style="color: #4ec9b0; font-weight: bold; margin-bottom: 3px;">⚡ MPM Domain & Particle Status</div>` +
               `<div>Connected Bodies: <b style="color: #fff;">${info.objCount}</b> (${(info.connectedParticles ?? 0).toLocaleString()} particles)</div>` +
               `<div>Background Grid Spacing: <b>${((info.cellSize ?? 0.01) * 1000).toFixed(2)} mm</b></div>` +
               `<div>Est. Particle VRAM: <b style="color: #38bdf8;">${(info.totalVramMB ?? 0).toFixed(2)} MB</b></div>` +
               `</div>`;
    }
    return '';
}



export function getFEMDisplayHTML(node: Node, state?: SimulationState): string {
    if (node.type === 'FEMObject3D') {
        const counts = resolveFEMCounts(node, state);
        return `<div style="background: rgba(34, 197, 94, 0.08); border: 1px solid #22c55e; border-radius: 4px; padding: 6px 8px; font-size: 11px;">` +
               `<div style="color: #4ade80; font-weight: bold; margin-bottom: 3px;">🧱 3D FEM Hex8 Structural Mesh Spec</div>` +
               `<div>Discretized Elements: <b style="color: #fff;">${counts.numElements.toLocaleString()} Hex8</b></div>` +
               `<div>Nodal Vertices: <b style="color: #4ade80;">${counts.numNodes.toLocaleString()} nodes</b></div>` +
               `<div>Element Dimensions: <b>${((counts.dx ?? 0.01) * 1000).toFixed(2)} × ${((counts.dy ?? 0.01) * 1000).toFixed(2)} × ${((counts.dz ?? 0.01) * 1000).toFixed(2)} mm</b></div>` +
               `<div>Discretized Volume: <b>${(counts.volume ?? 0.001).toFixed(6)} m³</b> | VRAM: <b>${(counts.vramMB ?? 0).toFixed(2)} MB</b></div>` +
               `</div>`;
    } else if (node.type === 'FEMDomain3D') {
        const counts = resolveFEMCounts(node, state);
        let debrisInfo = '';
        if (counts.convertToMpm) {
            debrisInfo = `<div>Debris Particle Conversion: <b style="color: #eab308;">${counts.mpmParticlesPerElem} pts/elem</b> (Max: ${counts.maxDebrisParticles.toLocaleString()} particles)</div>`;
        }
        return `<div style="background: rgba(34, 197, 94, 0.08); border: 1px solid #22c55e; border-radius: 4px; padding: 6px 8px; font-size: 11px;">` +
               `<div style="color: #4ade80; font-weight: bold; margin-bottom: 3px;">🏛️ 3D FEM Structural Domain Status</div>` +
               `<div>Connected Bodies: <b style="color: #fff;">${counts.objCount}</b> (${counts.totalElements.toLocaleString()} total Hex8 elements)</div>` +
               `<div>Structural Nodes: <b style="color: #4ade80;">~${counts.totalNodes.toLocaleString()} nodes</b></div>` +
               debrisInfo +
               `<div>Est. FEM VRAM: <b style="color: #38bdf8;">${counts.totalVramMB.toFixed(2)} MB</b></div>` +
               `</div>`;
    } else if (node.type === 'LSDynaImporter3D') {
        const kFile = String(node.parameters['k_file'] || 'None specified');
        const fileName = kFile.split('/').pop();
        return `<div style="background: rgba(34, 197, 94, 0.08); border: 1px solid #22c55e; border-radius: 4px; padding: 6px 8px; font-size: 11px;">` +
               `<div style="color: #4ade80; font-weight: bold; margin-bottom: 3px;">📑 LS-DYNA Keyword Mesh Deck</div>` +
               `<div style="color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Deck: <b>${fileName}</b></div>` +
               `<div>Scale Factor: <b>${Number(node.parameters['scale_factor'] ?? 1.0)}x</b></div>` +
               `</div>`;
    }
    return '';
}

export function resolveGeometryCounts(node: Node, _state?: SimulationState) {
    if (node.type === 'STLGeometry') {
        const stlFile = String(node.parameters['stl_file'] || '');
        const meta = getSTLGeometryMeta(stlFile);
        const triangleCount = meta ? meta.triangleCount : 0;
        const volume = meta ? meta.volume : 0.001;
        const bounds = meta ? meta.bounds : [-0.05, 0.05, -0.05, 0.05, -0.05, 0.05];
        return { stlFile, triangleCount, volume, bounds };
    } else if (node.type === 'PrimitiveGeometry3D') {
        const primitives = Array.isArray(node.parameters['primitives']) ? node.parameters['primitives'] : [];
        const count = primitives.length;
        const spheres = primitives.filter((p: any) => p.type === 'sphere').length;
        const boxes = primitives.filter((p: any) => p.type === 'box').length;
        const cylinders = primitives.filter((p: any) => p.type === 'cylinder').length;
        return { count, spheres, boxes, cylinders, primitives };
    }
    return { count: 0 };
}

export function getGeometryDisplayHTML(node: Node, state?: SimulationState): string {
    if (node.type === 'STLGeometry') {
        const counts = resolveGeometryCounts(node, state);
        const fileName = (counts.stlFile || 'No file selected').split('/').pop();
        const b = counts.bounds ?? [-0.05, 0.05, -0.05, 0.05, -0.05, 0.05];
        const dx = Math.abs(b[1] - b[0]);
        const dy = Math.abs(b[3] - b[2]);
        const dz = Math.abs(b[5] - b[4]);

        return `<div style="background: rgba(234, 179, 8, 0.08); border: 1px solid #eab308; border-radius: 4px; padding: 6px 8px; font-size: 11px;">` +
               `<div style="color: #facc15; font-weight: bold; margin-bottom: 3px;">📐 STL CAD Surface Geometry</div>` +
               `<div style="color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">File: <b>${fileName}</b></div>` +
               `<div>Surface Triangles: <b style="color: #fff;">${(counts.triangleCount ?? 0).toLocaleString()} tris</b></div>` +
               `<div>Bounding Box: <b>${(dx * 1000).toFixed(1)} × ${(dy * 1000).toFixed(1)} × ${(dz * 1000).toFixed(1)} mm</b></div>` +
               `<div>Watertight Volume: <b>${((counts.volume ?? 0.001) * 1e6).toFixed(2)} cm³</b></div>` +
               `</div>`;
    } else if (node.type === 'PrimitiveGeometry3D') {
        const counts = resolveGeometryCounts(node, state);
        return `<div style="background: rgba(234, 179, 8, 0.08); border: 1px solid #eab308; border-radius: 4px; padding: 6px 8px; font-size: 11px;">` +
               `<div style="color: #facc15; font-weight: bold; margin-bottom: 3px;">🔷 CSG Primitives Composite Spec</div>` +
               `<div>Total Primitives: <b style="color: #fff;">${counts.count} shapes</b></div>` +
               `<div>Breakdown: <b>${counts.boxes ?? 0} Boxes</b> · <b>${counts.spheres ?? 0} Spheres</b> · <b>${counts.cylinders ?? 0} Cylinders</b></div>` +
               `</div>`;
    }
    return '';
}

export function resolveCouplerCounts(node: Node, state?: SimulationState) {
    let fluidCells = 0;
    let solidElements = 0;
    let solidParticles = 0;

    if (state) {
        const meshNode = state.nodes.find(n => n.type === 'DomainMesh3D' || n.type === 'DomainMesh2D' || n.type === 'DomainMesh');
        if (meshNode) {
            const meshCounts = resolveMeshCounts(meshNode, state);
            fluidCells = meshCounts.totalCells;
        }

        const femNodes = state.nodes.filter(n => n.type === 'FEMObject3D');
        femNodes.forEach(n => {
            const femCounts = resolveFEMCounts(n, state);
            solidElements += femCounts.numElements;
        });

        const mpmNodes = state.nodes.filter(n => n.type === 'MPMObject3D' || n.type === 'MPMObject2D');
        mpmNodes.forEach(n => {
            const mpmCounts = resolveMPMCounts(n, state);
            solidParticles += mpmCounts.estParticles ?? 0;
        });
    }

    return { fluidCells, solidElements, solidParticles };
}

export function getCouplerDisplayHTML(node: Node, state?: SimulationState): string {
    const counts = resolveCouplerCounts(node, state);
    if (node.type === 'FEMFSICoupler3D') {
        return `<div style="background: rgba(14, 165, 233, 0.08); border: 1px solid #0ea5e9; border-radius: 4px; padding: 6px 8px; font-size: 11px;">` +
               `<div style="color: #38bdf8; font-weight: bold; margin-bottom: 3px;">🌊 FSI Coupling Infrastructure (Eulerian CFD ⇄ Lagrangian FEM)</div>` +
               `<div>Fluid Discretization: <b style="color: #fff;">${counts.fluidCells.toLocaleString()} Eulerian cells</b></div>` +
               `<div>Structural Discretization: <b style="color: #4ade80;">${counts.solidElements.toLocaleString()} Hex8 solid elements</b></div>` +
               `<div>Coupling Mode: <b>Conservative SAT Cut-Cell Aperture</b></div>` +
               `</div>`;
    } else if (node.type === 'FSICoupler2D' || node.type === 'FSICoupler3D') {
        return `<div style="background: rgba(14, 165, 233, 0.08); border: 1px solid #0ea5e9; border-radius: 4px; padding: 6px 8px; font-size: 11px;">` +
               `<div style="color: #38bdf8; font-weight: bold; margin-bottom: 3px;">🌊 FSI Coupling Infrastructure (Eulerian CFD ⇄ Lagrangian MPM)</div>` +
               `<div>Fluid Discretization: <b style="color: #fff;">${counts.fluidCells.toLocaleString()} cells</b></div>` +
               `<div>Structure Discretization: <b style="color: #c084fc;">${counts.solidParticles.toLocaleString()} MPM particles</b></div>` +
               `</div>`;
    }
    return '';
}

export function resolveTelemetryCounts(node: Node, _state?: SimulationState) {
    if (node.type === 'VirtualGauges') {
        const gauges = Array.isArray(node.parameters['gauges']) ? node.parameters['gauges'] : [];
        const activeFields = ['qty_pressure', 'qty_density', 'qty_velocity', 'qty_energy', 'qty_overpressure', 'qty_impulse'].filter(k => node.parameters[k] !== false);
        return { gaugeCount: gauges.length, activeFieldsCount: activeFields.length };
    } else if (node.type === 'VTKOutput') {
        const domains: string[] = [];
        const is3D = _state ? _state.nodes.some(n => n.type === 'CFDSolver3D' || n.type === 'DomainMesh3D' || n.type === 'Telemetry3DViewport' || n.type === 'MPMDomain3D' || n.type === 'FEMDomain3D') : true;
        if (!is3D) {
            if (node.parameters['export_cfd_2d'] !== false) domains.push('2D CFD Grid');
            if (node.parameters['export_fem'] && _state?.nodes.some(n => n.type === 'FEMDomain3D' || n.type === 'FEMObject3D')) domains.push('FEM Elements');
            if (node.parameters['export_mpm'] && _state?.nodes.some(n => n.type === 'MPMDomain2D' || n.type === 'MPMObject2D')) domains.push('MPM Particles');
        } else {
            if (node.parameters['export_slices'] !== false) domains.push('Slices');
            if (node.parameters['export_volumes'] !== false) domains.push('3D Volume');
            if (node.parameters['export_obstacles'] !== false) domains.push('Voxel Shell');
            if (node.parameters['export_stl_faces'] !== false) domains.push(node.parameters['tessellate_stl_faces'] !== false ? 'STL (Tessellated)' : 'STL Faces');
            if (node.parameters['export_fem'] !== false && (!_state || _state.nodes.some(n => n.type === 'FEMDomain3D' || n.type === 'FEMObject3D' || n.type === 'LSDynaImporter3D'))) domains.push('FEM Elements');
            if (node.parameters['export_mpm'] !== false && (!_state || _state.nodes.some(n => n.type === 'MPMDomain3D' || n.type === 'MPMObject3D'))) domains.push('MPM Particles');
        }
        return { exportDomains: domains };
    } else if (node.type === 'Telemetry3DViewport') {
        const slices = Array.isArray(node.parameters['slices']) ? node.parameters['slices'] : [];
        const activeSlices = slices.filter((s: any) => s.enabled !== false).length;
        return { sliceCount: slices.length, activeSlices };
    }
    return {};
}

export function getTelemetryDisplayHTML(node: Node, state?: SimulationState): string {
    if (node.type === 'VirtualGauges') {
        const counts = resolveTelemetryCounts(node, state);
        return `<div style="background: rgba(249, 115, 22, 0.08); border: 1px solid #f97316; border-radius: 4px; padding: 6px 8px; font-size: 11px;">` +
               `<div style="color: #fb923c; font-weight: bold; margin-bottom: 3px;">📊 Virtual Gauges Telemetry Probes</div>` +
               `<div>Active Sensor Probes: <b style="color: #fff;">${counts.gaugeCount ?? 0} probe points</b></div>` +
               `<div>Monitored Quantities: <b>${counts.activeFieldsCount ?? 0} physical channels</b></div>` +
               `</div>`;
    } else if (node.type === 'VTKOutput') {
        const counts = resolveTelemetryCounts(node, state);
        return `<div style="background: rgba(249, 115, 22, 0.08); border: 1px solid #f97316; border-radius: 4px; padding: 6px 8px; font-size: 11px;">` +
               `<div style="color: #fb923c; font-weight: bold; margin-bottom: 3px;">💾 VTK ParaView Exporter Pipeline</div>` +
               `<div>Export Domains: <b style="color: #fff;">${(counts.exportDomains ?? []).join(', ') || 'None'}</b></div>` +
               `<div>Format: <b>${node.parameters['vtk_format'] || 'Appended Binary XML'}</b></div>` +
               `</div>`;
    } else if (node.type === 'Telemetry3DViewport') {
        const counts = resolveTelemetryCounts(node, state);
        return `<div style="background: rgba(249, 115, 22, 0.08); border: 1px solid #f97316; border-radius: 4px; padding: 6px 8px; font-size: 11px;">` +
               `<div style="color: #fb923c; font-weight: bold; margin-bottom: 3px;">🖥️ 3D Viewport Telemetry Pipeline</div>` +
               `<div>Active Slices: <b style="color: #fff;">${counts.activeSlices ?? 0} / ${counts.sliceCount ?? 0} cut-planes</b></div>` +
               `<div>Refresh Rate: <b>${node.parameters['viewport_refresh_rate'] ?? 30} FPS</b></div>` +
               `</div>`;
    } else if (node.type === 'TelemetryText') {
        const layout = node.parameters['stream_layout'] || 'Columnar (Fixed-Width)';
        const filter = node.parameters['filter_level'] || 'All';
        const fontSize = node.parameters['font_size'] ?? 11;
        const cap = node.parameters['buffer_capacity'] ?? 100;
        return `<div style="background: rgba(14, 165, 233, 0.08); border: 1px solid #0ea5e9; border-radius: 4px; padding: 6px 8px; font-size: 11px;">` +
               `<div style="color: #38bdf8; font-weight: bold; margin-bottom: 3px;">📟 Live Terminal Text Telemetry</div>` +
               `<div>Layout: <b style="color: #fff;">${layout}</b> · Filter: <b style="color: #fff;">${filter}</b></div>` +
               `<div>Font Size: <b style="color: #4ade80;">${fontSize}px</b> · Buffer: <b>${cap} lines</b></div>` +
               `<div style="color: #94a3b8; font-size: 10px; margin-top: 3px;">💡 Tip: Hold <kbd style="background:#1e293b;padding:1px 4px;border-radius:3px;">Ctrl</kbd> + mouse wheel to zoom font directly.</div>` +
               `</div>`;
    }
    return '';
}

export function getEntityStatsHTML(node: Node, state?: SimulationState): string {
    if (node.type === 'DomainMesh' || node.type === 'DomainMesh2D' || node.type === 'DomainMesh3D' || node.type === 'CFDSolver' || node.type === 'CFDSolver2D' || node.type === 'CFDSolver3D') {
        return getMeshDisplayHTML(node, state);
    }
    if (node.type === 'MPMObject3D' || node.type === 'MPMObject2D' || node.type === 'MPMDomain3D' || node.type === 'MPMDomain2D') {
        return getMPMDisplayHTML(node, state);
    }
    if (node.type === 'FEMObject3D' || node.type === 'FEMDomain3D' || node.type === 'LSDynaImporter3D') {
        return getFEMDisplayHTML(node, state);
    }
    if (node.type === 'STLGeometry' || node.type === 'PrimitiveGeometry3D') {
        return getGeometryDisplayHTML(node, state);
    }
    if (node.type === 'FEMFSICoupler3D' || node.type === 'FSICoupler2D' || node.type === 'FSICoupler3D') {
        return getCouplerDisplayHTML(node, state);
    }
    if (node.type === 'VirtualGauges' || node.type === 'VTKOutput' || node.type === 'Telemetry3DViewport' || node.type === 'TelemetryText') {
        return getTelemetryDisplayHTML(node, state);
    }
    return '';
}

export function getTelemetryHeader(node?: Node | null): string {
    const params = node?.parameters || {};
    const layout = params.stream_layout || 'Columnar (Fixed-Width)';
    if (layout === 'Live Page (In-Place)' || layout === 'Multi-Line Cards') {
        return '';
    }
    if (layout === 'Standard Log' || layout === 'Dual-Deck (Page + Log)') {
        return 'TIMESTAMP    LEVEL    SCOPE    STEP    LOG MESSAGE';
    }
    const showDt = params.show_dt ?? true;
    const showBreakdown = params.show_timing_breakdown ?? true;
    const showMemory = params.show_memory ?? true;
    const showWall = params.show_wallclock ?? true;
    const tsMode = params.timestamp_mode || 'None';

    let parts: string[] = [];
    if (tsMode === 'Clock') parts.push('TIME    ');
    else if (tsMode === 'Relative') parts.push('REL_T   ');

    if (layout === 'Ultra-Compact') {
        parts.push('  STEP', '  SIM TIME');
        if (showDt) parts.push('      DT');
        if (showBreakdown) parts.push('  PHYS', '    IO');
        if (showMemory) parts.push('  VRAM');
        return parts.join(' │ ');
    }

    parts.push('  STEP');
    parts.push('  SIM TIME');
    if (showDt) parts.push('    DT(s)');
    if (showBreakdown) {
        parts.push('  PHYS');
        parts.push('    IO');
        parts.push('   COM');
    }
    if (showMemory) {
        parts.push('   RAM');
        parts.push('  VRAM');
    }
    if (showWall) {
        parts.push('   WALL');
    }
    return parts.join(' │ ');
}




