/**
 * BlastDaemon PropertyGrid
 * High-density, two-column key-value property inspector (HyperMesh / ParaView paradigm).
 * Features [Parameters] and [Display] tabs, collapsible accordions, unified numeric casting,
 * popover documentation tooltips, and mandatory model invalidation triggers.
 */

import { StateManager, calculateRefinementMeshInfo, getMeshDisplayHTML, getMPMDisplayHTML, getFEMDisplayHTML, getGeometryDisplayHTML, getCouplerDisplayHTML, getTelemetryDisplayHTML, getEntityStatsHTML, resolveMeshCounts, resolveMPMCounts, resolveFEMCounts, resolveGeometryCounts, resolveCouplerCounts, resolveTelemetryCounts, syncMPMMaterialParameters, NON_PHYSICAL_NODE_TYPES, DISPLAY_ONLY_KEYS, getCompatibleMaterialsForNode, resolveSliceDomainBounds, canonicalizeQuantity, getSliceAxisLabel, resolveResourcePath } from './state-manager.js';
import { Node, NodeType } from './types.js';
import { HostFileBrowserModal, FileFilterPreset } from './host-file-browser.js';
import { GaugeManagerModal } from './gauge-manager-modal.js';
import { MPM_MATERIAL_PRESET_NAMES, MPM_MATERIAL_PRESETS, getConstitutiveModels, getPresetsForConstitutiveModel, getCategorizedPresetsForModel, getDefaultPresetForModel } from './mpm-presets.js';
import { getParameterInfo, getNodeDefinition, getNodeDescription as getMasterNodeDescription, showParameterPopover, showNodeDetailsModal, getSolverBadgeHTML, getSolverScope } from './parameter-definitions.js';

export const EXPLOSIVE_PRESETS: Record<string, Record<string, number>> = {
    'Aluminized ANFO': { rho: 1050, detonation_energy: 4100000, det_vel: 4900, jwl_A: 76.5e9, jwl_B: 1.85e9, jwl_R1: 4.15, jwl_R2: 1.15, jwl_omega: 0.30 },
    'Ammonal': { rho: 1600, detonation_energy: 4400000, det_vel: 5400, jwl_A: 125.0e9, jwl_B: 2.5e9, jwl_R1: 4.0, jwl_R2: 1.0, jwl_omega: 0.25 },
    'ANFO': { rho: 930, detonation_energy: 3700000, det_vel: 4700, jwl_A: 49.46e9, jwl_B: 1.891e9, jwl_R1: 4.10, jwl_R2: 1.15, jwl_omega: 0.33 },
    'Baratol': { rho: 2550, detonation_energy: 2800000, det_vel: 4900, jwl_A: 289.4e9, jwl_B: 5.14e9, jwl_R1: 4.4, jwl_R2: 1.2, jwl_omega: 0.25 },
    'C-4': { rho: 1601, detonation_energy: 5600000, det_vel: 8040, jwl_A: 593.7e9, jwl_B: 12.87e9, jwl_R1: 4.5, jwl_R2: 1.2, jwl_omega: 0.38 },
    'Composition A-3': { rho: 1650, detonation_energy: 5000000, det_vel: 8100, jwl_A: 601.5e9, jwl_B: 12.0e9, jwl_R1: 4.5, jwl_R2: 1.2, jwl_omega: 0.35 },
    'Composition B': { rho: 1717, detonation_energy: 5170000, det_vel: 7980, jwl_A: 524.2e9, jwl_B: 7.67e9, jwl_R1: 4.2, jwl_R2: 1.1, jwl_omega: 0.34 },
    'Composition C-3': { rho: 1600, detonation_energy: 5300000, det_vel: 8000, jwl_A: 580.0e9, jwl_B: 11.5e9, jwl_R1: 4.4, jwl_R2: 1.2, jwl_omega: 0.35 },
    'Cyclotol': { rho: 1750, detonation_energy: 5200000, det_vel: 8250, jwl_A: 582.0e9, jwl_B: 10.5e9, jwl_R1: 4.3, jwl_R2: 1.1, jwl_omega: 0.32 },
    'Heavy ANFO': { rho: 1250, detonation_energy: 3500000, det_vel: 5000, jwl_A: 198.0e9, jwl_B: 1.45e9, jwl_R1: 4.30, jwl_R2: 1.00, jwl_omega: 0.20 },
    'HMX': { rho: 1890, detonation_energy: 5620000, det_vel: 9110, jwl_A: 778.3e9, jwl_B: 7.071e9, jwl_R1: 4.2, jwl_R2: 1.0, jwl_omega: 0.30 },
    'LX-04': { rho: 1860, detonation_energy: 5300000, det_vel: 8400, jwl_A: 742.0e9, jwl_B: 11.2e9, jwl_R1: 4.4, jwl_R2: 1.2, jwl_omega: 0.30 },
    'LX-07': { rho: 1865, detonation_energy: 5400000, det_vel: 8600, jwl_A: 755.0e9, jwl_B: 10.8e9, jwl_R1: 4.4, jwl_R2: 1.2, jwl_omega: 0.30 },
    'LX-10': { rho: 1860, detonation_energy: 5500000, det_vel: 8820, jwl_A: 760.0e9, jwl_B: 10.5e9, jwl_R1: 4.4, jwl_R2: 1.2, jwl_omega: 0.30 },
    'LX-14': { rho: 1830, detonation_energy: 5400000, det_vel: 8800, jwl_A: 750.0e9, jwl_B: 11.0e9, jwl_R1: 4.4, jwl_R2: 1.2, jwl_omega: 0.30 },
    'LX-17': { rho: 1900, detonation_energy: 4300000, det_vel: 7600, jwl_A: 550.0e9, jwl_B: 8.0e9, jwl_R1: 4.5, jwl_R2: 1.5, jwl_omega: 0.25 },
    'Mining Emulsion': { rho: 1150, detonation_energy: 3200000, det_vel: 4500, jwl_A: 130.0e9, jwl_B: 1.8e9, jwl_R1: 4.20, jwl_R2: 1.05, jwl_omega: 0.22 },
    'Nitromethane': { rho: 1128, detonation_energy: 4480000, det_vel: 6280, jwl_A: 209.2e9, jwl_B: 5.689e9, jwl_R1: 4.40, jwl_R2: 1.20, jwl_omega: 0.30 },
    'Octol': { rho: 1810, detonation_energy: 5500000, det_vel: 8480, jwl_A: 680.0e9, jwl_B: 9.5e9, jwl_R1: 4.3, jwl_R2: 1.1, jwl_omega: 0.32 },
    'PBX 9404': { rho: 1840, detonation_energy: 5700000, det_vel: 8800, jwl_A: 780.0e9, jwl_B: 12.0e9, jwl_R1: 4.4, jwl_R2: 1.2, jwl_omega: 0.30 },
    'PBX 9501': { rho: 1830, detonation_energy: 5600000, det_vel: 8800, jwl_A: 760.0e9, jwl_B: 11.5e9, jwl_R1: 4.4, jwl_R2: 1.2, jwl_omega: 0.30 },
    'PBX 9502': { rho: 1895, detonation_energy: 4400000, det_vel: 7670, jwl_A: 560.0e9, jwl_B: 8.5e9, jwl_R1: 4.5, jwl_R2: 1.5, jwl_omega: 0.25 },
    'PE-10': { rho: 1550, detonation_energy: 4800000, det_vel: 7500, jwl_A: 480.0e9, jwl_B: 8.0e9, jwl_R1: 4.4, jwl_R2: 1.2, jwl_omega: 0.30 },
    'PE-12': { rho: 1580, detonation_energy: 4900000, det_vel: 7600, jwl_A: 500.0e9, jwl_B: 8.5e9, jwl_R1: 4.4, jwl_R2: 1.2, jwl_omega: 0.30 },
    'PE-4': { rho: 1590, detonation_energy: 5200000, det_vel: 7800, jwl_A: 550.0e9, jwl_B: 10.0e9, jwl_R1: 4.4, jwl_R2: 1.2, jwl_omega: 0.32 },
    'PE-8': { rho: 1570, detonation_energy: 5000000, det_vel: 7700, jwl_A: 520.0e9, jwl_B: 9.0e9, jwl_R1: 4.4, jwl_R2: 1.2, jwl_omega: 0.31 },
    'Pentolite': { rho: 1700, detonation_energy: 5110000, det_vel: 7530, jwl_A: 541.0e9, jwl_B: 9.38e9, jwl_R1: 4.4, jwl_R2: 1.2, jwl_omega: 0.28 },
    'PETN': { rho: 1770, detonation_energy: 5800000, det_vel: 8300, jwl_A: 613.4e9, jwl_B: 15.07e9, jwl_R1: 4.4, jwl_R2: 1.2, jwl_omega: 0.28 },
    'RDX': { rho: 1806, detonation_energy: 5300000, det_vel: 8750, jwl_A: 524.2e9, jwl_B: 7.678e9, jwl_R1: 4.2, jwl_R2: 1.1, jwl_omega: 0.34 },
    'TATB': { rho: 1800, detonation_energy: 4400000, det_vel: 7660, jwl_A: 554.6e9, jwl_B: 7.91e9, jwl_R1: 4.5, jwl_R2: 1.6, jwl_omega: 0.25 },
    'Tetryl': { rho: 1730, detonation_energy: 4230000, det_vel: 7570, jwl_A: 510.9e9, jwl_B: 8.44e9, jwl_R1: 4.5, jwl_R2: 1.4, jwl_omega: 0.25 },
    'TNT': { rho: 1630, detonation_energy: 4290000, det_vel: 6930, jwl_A: 373.77e9, jwl_B: 3.747e9, jwl_R1: 4.15, jwl_R2: 0.90, jwl_omega: 0.35 },
    'Water Gel': { rho: 1200, detonation_energy: 3400000, det_vel: 4800, jwl_A: 154.0e9, jwl_B: 2.15e9, jwl_R1: 4.30, jwl_R2: 1.10, jwl_omega: 0.25 }
};

const NUMERIC_KEYS = new Set([
    'domain_radius', 'cell_size', 'atm_pressure', 'atm_temperature',
    'charge_mass', 'rho', 'detonation_energy', 'jwl_A', 'jwl_B',
    'jwl_R1', 'jwl_R2', 'jwl_omega', 'det_vel', 'cfl', 'endtime',
    'spatial_order', 'temporal_order', 'gamma', 'plot_stride', 'refresh_rate',
    'ascii_precision', 'step_interval', 'time_interval', 'downsample_stride',
    'telemetry_channel', 'telemetry_interval_ms', 'vtk_step_interval',
    'nr', 'nz', 'max_r', 'max_z', 'explosive_x', 'explosive_y', 'explosive_z', 'explosive_radius', 'remap_radius', 'explosive_r', 'trigger_val',
    'charge_r', 'charge_z', 'charge_radius', 'charge_height', 'charge_aspect_ratio',
    'detonator_r', 'detonator_z', 'detonator_radius', 'detonator_x', 'detonator_y',
    'ideal_gamma', 'ideal_rho_0', 'ideal_e_0', 'high_rho', 'ambient_rho', 'ambient_p',
    'nx', 'ny', 'nz', 'xmax', 'ymax', 'zmax',
    'charge_x', 'charge_y', 'charge_z', 'charge_lx', 'charge_ly', 'charge_lz',
    'charge_rot_x', 'charge_rot_y', 'charge_rot_z',
    'detonator_x', 'detonator_y', 'detonator_z', 'xmin', 'ymin', 'zmin',
    'scale_factor',
    'min_y', 'max_y', 'min_val', 'max_val', 'stl_min_val', 'stl_max_val', 'obstacles_min_val', 'obstacles_max_val', 'ambientLevel', 'specularIntensity', 'gauge_size', 'gauge_opacity', 'stl_opacity', 'obstacles_opacity', 'grid_opacity',
    'charge_opacity',
    'amr_max_levels', 'amr_threshold', 'amr_coarsen_ratio', 'amr_tile_size',
    'center_x', 'center_y', 'center_z', 'size_x', 'size_y', 'size_z', 'radius', 'height', 'length',
    'offset', 'stride',
    'pos_x', 'pos_y', 'pos_z', 'size_x', 'size_y', 'size_z', 'vel_x', 'vel_y', 'vel_z', 'radius', 'inner_radius',
    'scale_x', 'scale_y', 'scale_z',
    'angular_vel', 'angular_vel_x', 'angular_vel_y', 'angular_vel_z',
    'density', 'youngs_modulus', 'poissons_ratio', 'yield_stress', 'hardening_modulus',
    'failure_strain', 'tensile_failure_stress', 'erosion_strain', 'erosion_stress',
    'jc_A', 'jc_B', 'jc_n', 'jc_C', 'jc_m', 'jc_d1', 'jc_d2', 'jc_d3', 'jc_d4', 'jc_d5', 'T_melt', 'T_room', 'Cp',
    'weibull_modulus', 'weibull_scale', 'fracture_toughness', 'debris_bulk_factor',
    'fragment_min_size', 'fragment_max_size', 'fragment_weibull_n', 'fragment_clumping_radius', 'fragment_ejection_jitter', 'fragment_contact_friction', 'fragment_restitution',
    'mg_gamma0', 'mg_c0', 'mg_s',
    'ppc',
    'mpmParticleDiameter', 'mpmParticleSize', 'mpmParticleMinVal', 'mpmParticleMaxVal', 'mpmParticleOpacity', 'flip_blend',
    'hourglass_coeff', 'bulk_viscosity_b1', 'bulk_viscosity_b2', 'timestep_erosion_factor', 'contact_stiffness', 'contact_penalty_scale', 'friction_static', 'friction_kinetic', 'contact_damping',
    'mpm_particles_per_failed_element', 'material_heterogeneity', 'debris_velocity_smoothing', 'debris_clumping', 'debris_max_clump_size', 'random_seed', 'rebar_area', 'beamRadius', 'beam_radius', 'beam_area', 'beamMinVal', 'beamMaxVal',
    'femMinVal', 'femMaxVal', 'femOpacity', 'vacuum_density', 'vacuum_pressure', 'uncovering_tolerance',
    'fc', 'ft', 'G_f', 'moisture_content', 'dif_cap_compression', 'dif_cap_tension',
    'rht_A', 'rht_N', 'rht_B', 'rht_M', 'rht_Q0', 'rht_BQ', 'rht_D1', 'rht_D2',
    'rht_p_crush', 'rht_p_lock', 'rht_alpha0', 'rht_n_comp', 'rht_betac', 'rht_deltat',
    'kc_a0', 'kc_a1', 'kc_a2', 'kc_a0y', 'kc_a1y', 'kc_a2y', 'kc_a1r', 'kc_a2r', 'kc_b1', 'kc_omega',
    'cscm_alpha', 'cscm_theta', 'cscm_lambda', 'cscm_beta', 'cscm_R', 'cscm_X0', 'cscm_W', 'cscm_D1', 'cscm_D2',
    'davis_c0', 'davis_s1', 'davis_gamma0', 'davis_cv', 'davis_t0', 'davis_rho0',
    'davis_a', 'davis_b', 'davis_k', 'davis_vc', 'davis_pc', 'davis_q_det',
    'crest_b1', 'crest_c1', 'crest_m1', 'crest_b2', 'crest_c2', 'crest_c3', 'crest_m2', 'crest_s0', 'crest_s_threshold',
    'initiation_radius', 'booster_overpressure',
    'roi_xmin', 'roi_xmax', 'roi_ymin', 'roi_ymax', 'roi_zmin', 'roi_zmax', 'volume_stride', 'slice_stride',
    'nonlocal_radius', 'anisotropy_ratio', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z',
    'aoRadius', 'aoIntensity', 'aoBias', 'opacity', 'rebarRadius', 'viewport_refresh_rate'
]);

export class PropertyGrid {
    public container: HTMLElement;
    public rootElement!: HTMLElement;
    private stateManager: StateManager;
    private currentNodeId: string | null = null;
    private activeTab: 'parameters' | 'display' = 'parameters';
    private collapsedAccordions: Set<string> = new Set();
    private stateListener: () => void;
    private inPlaceListener: (nodeId: string, parameters: Record<string, any>) => void;
    private selectionListener: (nodeId: string | null) => void;
    private sliceSelectionListener: (sliceIdx: number | null) => void;
    private gaugeSelectionListener: (gaugeIdx: number | null) => void;

    private lastRenderedNodeId: string | null = null;
    private lastRenderedSliceIdx: number | null = null;
    private lastRenderedGaugeIdx: number | null = null;
    private lastRenderedTab: 'parameters' | 'display' = 'parameters';
    private gaugeSearchQuery: string = '';

    constructor(container: HTMLElement | string, stateManager: StateManager) {
        if (typeof container === 'string') {
            const el = document.getElementById(container);
            if (!el) throw new Error(`[PropertyGrid] Container #${container} not found`);
            this.container = el;
        } else {
            this.container = container;
        }

        this.stateManager = stateManager;
        this.currentNodeId = this.stateManager.getSelectedNodeId();

        this.stateListener = () => this.render();
        this.inPlaceListener = (nodeId, _params) => {
            const activeEl = document.activeElement;
            const isEditingInGrid = activeEl && this.rootElement && this.rootElement.contains(activeEl) && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
            if (!isEditingInGrid) {
                const selectedNode = this.getSelectedNode();
                const vpNode = this.getActiveViewportNode(selectedNode || undefined);
                if (this.currentNodeId === nodeId || vpNode?.id === nodeId || this.activeTab === 'display') {
                    this.render(false);
                }
            }
        };
        this.selectionListener = (nodeId) => {
            if (this.currentNodeId !== nodeId) {
                this.currentNodeId = nodeId;
                this.render(true);
            }
        };

        this.sliceSelectionListener = () => {
            this.render(true);
        };

        this.gaugeSelectionListener = () => {
            this.render(true);
        };

        this.stateManager.onStateChange(this.stateListener);
        this.stateManager.onInPlaceParameterChange(this.inPlaceListener);
        this.stateManager.onSelectionChange(this.selectionListener);
        this.stateManager.onSliceSelectionChange(this.sliceSelectionListener);
        this.stateManager.onGaugeSelectionChange(this.gaugeSelectionListener);

        this.buildBaseUI();
        this.render();
    }

    private buildBaseUI(): void {
        this.rootElement = document.createElement('div');
        this.rootElement.className = 'property-grid-root';
        this.container.innerHTML = '';
        this.container.appendChild(this.rootElement);
    }

    public attachTo(container: HTMLElement): void {
        this.container = container;
        if (!this.container.contains(this.rootElement)) {
            this.container.innerHTML = '';
            this.container.appendChild(this.rootElement);
        }
        this.render();
    }

    public setSelectedNode(nodeId: string | null): void {
        if (this.currentNodeId === nodeId) return;
        this.currentNodeId = nodeId;
        this.render(true);
    }

    public render(forceFull: boolean = false): void {
        this.currentNodeId = this.stateManager.getSelectedNodeId();
        const selectedSliceIdx = this.stateManager.getSelectedSliceIndex();
        const selectedGaugeIdx = this.stateManager.getSelectedGaugeIndex();

        const state = this.stateManager.getCurrentState();
        let node = state?.nodes.find(n => n.id === this.currentNodeId);
        if (!node) {
            const allModels = this.stateManager.getAllModels();
            for (const m of allModels) {
                node = m.nodes.find(n => n.id === this.currentNodeId);
                if (node) break;
            }
        }

        if (!forceFull && this.rootElement) {
            const activeEl = document.activeElement;
            if (activeEl && this.rootElement.contains(activeEl)) {
                const tag = activeEl.tagName.toLowerCase();
                if (tag === 'input' || tag === 'textarea' || tag === 'select') {
                    if (node) {
                        this.updateLiveStats(node);
                    }
                    return;
                }
            }
        }

        if (!this.currentNodeId) {
            this.lastRenderedNodeId = null;
            this.lastRenderedSliceIdx = null;
            this.lastRenderedGaugeIdx = null;
            this.rootElement.innerHTML = `
                <div class="property-grid-empty">
                    <div class="empty-icon">🔍</div>
                    <div class="empty-text">No entity selected</div>
                    <div class="empty-hint">Select an item in the Pipeline Browser to inspect and modify properties.</div>
                </div>
            `;
            return;
        }

        if (!node) {
            this.lastRenderedNodeId = null;
            this.lastRenderedSliceIdx = null;
            this.lastRenderedGaugeIdx = null;
            this.rootElement.innerHTML = `
                <div class="property-grid-empty not-found">
                    <div class="empty-icon">⚠️</div>
                    <div class="empty-text">Entity not found</div>
                </div>
            `;
            return;
        }

        // Check if the focused item/slice/gauge/tab is the same as the previous render
        const isSameEntity = (this.currentNodeId === this.lastRenderedNodeId) &&
                             (selectedSliceIdx === this.lastRenderedSliceIdx) &&
                             (selectedGaugeIdx === this.lastRenderedGaugeIdx) &&
                             (this.activeTab === this.lastRenderedTab);

        let savedScrollTop = 0;
        if (isSameEntity) {
            const existingBody = this.rootElement.querySelector('.property-grid-body') as HTMLElement;
            savedScrollTop = existingBody?.scrollTop || this.rootElement?.scrollTop || this.container?.scrollTop || 0;
        }

        this.lastRenderedNodeId = this.currentNodeId;
        this.lastRenderedSliceIdx = selectedSliceIdx;
        this.lastRenderedGaugeIdx = selectedGaugeIdx;
        this.lastRenderedTab = this.activeTab;

        this.rootElement.innerHTML = '';

        // 1. Header Card (Entity Type, ID, Badges, Popover)
        const header = this.createEntityHeader(node);
        this.rootElement.appendChild(header);

        // 2. Tab Navigation ([Parameters] | [Display])
        const tabNav = this.createTabNavigation();
        this.rootElement.appendChild(tabNav);

        // 3. Tab Body
        const bodyContainer = document.createElement('div');
        bodyContainer.className = 'property-grid-body scrollable';

        if (this.activeTab === 'parameters') {
            this.renderParametersTab(bodyContainer, node);
        } else {
            this.renderDisplayTab(bodyContainer, node);
        }

        this.rootElement.appendChild(bodyContainer);

        if (savedScrollTop > 0) {
            bodyContainer.scrollTop = savedScrollTop;
            requestAnimationFrame(() => {
                if (bodyContainer) {
                    bodyContainer.scrollTop = savedScrollTop;
                }
            });
        }
    }

    private getSlicesForNode(node?: Node | null): any[] {
        if (node?.parameters?.slices && Array.isArray(node.parameters.slices) && node.parameters.slices.length > 0) {
            return node.parameters.slices;
        }
        const activeModel = this.stateManager.getActiveModel();
        const vpNode = activeModel?.nodes.find(n => n.type === 'Telemetry3DViewport');
        if (vpNode?.parameters?.slices && Array.isArray(vpNode.parameters.slices) && vpNode.parameters.slices.length > 0) {
            return vpNode.parameters.slices;
        }
        const domainNode = activeModel?.nodes.find(n => n.type === 'DomainMesh3D' || n.type === 'DomainMesh');
        if (domainNode?.parameters?.slices && Array.isArray(domainNode.parameters.slices) && domainNode.parameters.slices.length > 0) {
            return domainNode.parameters.slices;
        }
        return node?.parameters?.slices || vpNode?.parameters?.slices || [];
    }

    private createEntityHeader(node: Node): HTMLElement {
        const selectedSliceIdx = this.stateManager.getSelectedSliceIndex();
        const slices = this.getSlicesForNode(node);
        if (selectedSliceIdx !== null && (slices.length > 0 || node.parameters.slices || node.type === 'Telemetry3DViewport' || node.type === 'DomainMesh3D' || node.type === 'DomainMesh')) {
            const slice = slices[selectedSliceIdx] || { axis: 'xy', offset: 0.0, quantity: 'pressure' };
            const axisLabel = getSliceAxisLabel(slice.axis);

            const header = document.createElement('div');
            header.className = 'property-grid-header';

            const topRow = document.createElement('div');
            topRow.className = 'header-top-row';

            const titleBox = document.createElement('div');
            titleBox.className = 'header-title-box';

            const typeTitle = document.createElement('span');
            typeTitle.className = 'header-type-title';
            typeTitle.textContent = `🥞 Slice Plane (${axisLabel})`;

            const infoBtn = document.createElement('button');
            infoBtn.className = 'header-info-btn';
            infoBtn.textContent = 'ℹ';
            infoBtn.title = 'View Slice Plane Sampling & Orthogonal Sectioning Documentation';
            infoBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showNodeDetailsModal('Telemetry3DViewport');
            });

            titleBox.appendChild(typeTitle);
            titleBox.appendChild(infoBtn);

            const idBadge = document.createElement('span');
            idBadge.className = 'header-id-badge';
            idBadge.textContent = `Slice #${selectedSliceIdx}`;
            idBadge.title = `Index ${selectedSliceIdx} on ${node.id}`;

            topRow.appendChild(titleBox);
            topRow.appendChild(idBadge);

            const nameRow = document.createElement('div');
            nameRow.className = 'header-name-row';

            const nameLabel = document.createElement('span');
            nameLabel.className = 'header-name-label';
            nameLabel.textContent = 'Name:';

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'header-name-input';
            const defaultName = slice.name || `Slice #${selectedSliceIdx} (${axisLabel})`;
            nameInput.value = defaultName;
            nameInput.placeholder = defaultName;
            nameInput.title = 'Slice plane custom name';
            nameInput.addEventListener('change', () => {
                const newName = nameInput.value.trim();
                slice.name = newName || defaultName;
                const updated = [...slices];
                updated[selectedSliceIdx] = { ...slice, name: newName || defaultName };
                this.stateManager.updateNodeParametersInPlace(node.id, { slices: updated });
                (window as any).transportController?.onSliceConfigChange?.(updated);
            });

            nameRow.appendChild(nameLabel);
            nameRow.appendChild(nameInput);

            const badgeRow = document.createElement('div');
            badgeRow.className = 'header-badge-row';
            badgeRow.innerHTML = `<span class="scope-badge" style="background: rgba(0, 210, 255, 0.15); color: #00d2ff; border: 1px solid rgba(0, 210, 255, 0.35);">POST-PROCESSING · 2D CUT-PLANE</span>`;

            header.appendChild(topRow);
            header.appendChild(nameRow);
            header.appendChild(badgeRow);

            return header;
        }

        const header = document.createElement('div');
        header.className = 'property-grid-header';

        const topRow = document.createElement('div');
        topRow.className = 'header-top-row';

        const titleBox = document.createElement('div');
        titleBox.className = 'header-title-box';

        const typeTitle = document.createElement('span');
        typeTitle.className = 'header-type-title';
        typeTitle.textContent = node.type;

        const infoBtn = document.createElement('button');
        infoBtn.className = 'header-info-btn';
        infoBtn.textContent = 'ℹ';
        infoBtn.title = 'View engineering formulation & governing equations';
        infoBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showNodeDetailsModal(node.type);
        });

        titleBox.appendChild(typeTitle);
        titleBox.appendChild(infoBtn);

        const idBadge = document.createElement('span');
        idBadge.className = 'header-id-badge';
        idBadge.textContent = node.id;
        idBadge.title = 'Immutable Internal Entity ID';

        topRow.appendChild(titleBox);
        topRow.appendChild(idBadge);

        // Editable Entity Name row (independent of immutable internal node.id)
        const nameRow = document.createElement('div');
        nameRow.className = 'header-name-row';

        const nameLabel = document.createElement('span');
        nameLabel.className = 'header-name-label';
        nameLabel.textContent = 'Name:';

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'header-name-input';
        nameInput.value = node.parameters.name || node.id;
        nameInput.placeholder = node.id;
        nameInput.title = 'Custom entity name (independent of immutable internal ID)';
        nameInput.addEventListener('change', () => {
            const newName = nameInput.value.trim();
            this.stateManager.updateNodeParameters(node.id, { name: newName || node.id });
        });
        nameInput.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
                nameInput.blur();
            }
        });

        nameRow.appendChild(nameLabel);
        nameRow.appendChild(nameInput);

        const badgeRow = document.createElement('div');
        badgeRow.className = 'header-badge-row';
        badgeRow.innerHTML = getSolverBadgeHTML(getSolverScope('', node.type));

        header.appendChild(topRow);
        header.appendChild(nameRow);
        if (badgeRow.children.length > 0 || badgeRow.innerHTML.trim().length > 0) {
            header.appendChild(badgeRow);
        }

        return header;
    }

    private createTabNavigation(): HTMLElement {
        const nav = document.createElement('div');
        nav.className = 'property-tab-nav';

        const paramTab = document.createElement('button');
        paramTab.type = 'button';
        paramTab.className = `property-tab-btn ${this.activeTab === 'parameters' ? 'active' : ''}`;
        paramTab.textContent = 'Parameters';
        paramTab.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (this.activeTab !== 'parameters') {
                this.activeTab = 'parameters';
                this.render(true);
            }
        });

        const displayTab = document.createElement('button');
        displayTab.type = 'button';
        displayTab.className = `property-tab-btn ${this.activeTab === 'display' ? 'active' : ''}`;
        displayTab.textContent = 'Display';
        displayTab.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (this.activeTab !== 'display') {
                this.activeTab = 'display';
                this.render(true);
            }
        });

        nav.appendChild(paramTab);
        nav.appendChild(displayTab);
        return nav;
    }

    private renderParametersTab(container: HTMLElement, node: Node): void {
        const selectedSliceIdx = this.stateManager.getSelectedSliceIndex();
        const slices = this.getSlicesForNode(node);
        if (selectedSliceIdx !== null && (slices.length > 0 || node.parameters.slices || node.type === 'Telemetry3DViewport' || node.type === 'DomainMesh3D' || node.type === 'DomainMesh')) {
            this.renderSingleSliceInspector(container, node, selectedSliceIdx);
            return;
        }

        const selectedGaugeIdx = this.stateManager.getSelectedGaugeIndex();

        const state = this.stateManager.getCurrentState();
        const entityStatsHtml = getEntityStatsHTML(node, state ?? undefined);
        if (entityStatsHtml) {
            const statsBox = document.createElement('div');
            statsBox.className = 'property-entity-stats-card';
            statsBox.innerHTML = entityStatsHtml;
            container.appendChild(statsBox);
        }

        if (node.type === 'Telemetry3DViewport' || node.type === 'DomainMesh3D' || node.type === 'DomainMesh') {
            if (node.parameters.slices && node.parameters.slices.length > 0) {
                this.renderSlicesOverviewSection(container, node);
            }
        }

        if (node.type === 'VirtualGauges') {
            this.renderVirtualGaugesSection(container, node, selectedGaugeIdx);
        }

        const groups = this.groupParameters(node);

        for (const group of groups) {
            const accordion = this.createAccordion(group.id, group.title, group.params, node);
            container.appendChild(accordion);
        }
    }

    private renderSingleSliceInspector(container: HTMLElement, node: Node, sliceIdx: number): void {
        const slices: any[] = this.getSlicesForNode(node);
        const targetModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
        const state = this.stateManager.getCurrentState();
        const defaultBounds = resolveSliceDomainBounds('xy', node, state, targetModel);
        const defaultOffset = (defaultBounds.min + defaultBounds.max) / 2.0;
        const slice = slices[sliceIdx] || { axis: 'xy', offset: defaultOffset, enabled: true, colormap: 'rainbow', opacity: 1.0, quantity: 'pressure' };

        // Top Navigation Bar (Breadcrumb & Slice Switcher)
        const topNav = document.createElement('div');
        topNav.className = 'property-slice-pills';

        const parentName = node.parameters.name || node.type;
        const backBtn = document.createElement('button');
        backBtn.className = 'property-back-btn';
        backBtn.innerHTML = `<span>⬅</span> <span>${parentName} Settings</span>`;
        backBtn.title = `Return to parent ${parentName} properties`;
        backBtn.addEventListener('click', () => {
            this.stateManager.setSelectedSliceIndex(null);
            this.render(true);
        });
        topNav.appendChild(backBtn);

        slices.forEach((sl: any, idx: number) => {
            const pill = document.createElement('button');
            pill.className = `property-slice-pill ${idx === sliceIdx ? 'active' : ''}`;
            pill.innerHTML = `<span>${sl.enabled !== false ? '👁' : '🚫'}</span> <span>#${idx} ${getSliceAxisLabel(sl.axis)}</span>`;
            pill.title = `Switch to Slice #${idx}`;
            pill.addEventListener('click', () => {
                this.stateManager.setSelectedSliceIndex(idx);
                (window as any).transportController?.setActiveSliceIndex?.(idx);
                this.render(true);
            });
            topNav.appendChild(pill);
        });

        const addPill = document.createElement('button');
        addPill.className = 'property-slice-pill';
        addPill.innerHTML = '<span>➕ Add</span>';
        addPill.title = 'Add a new orthogonal slice plane';
        addPill.addEventListener('click', () => {
            const updated = [...slices, { axis: 'xy', offset: defaultOffset, enabled: true, colormap: 'rainbow', opacity: 1.0, quantity: 'pressure' }];
            this.stateManager.updateNodeParametersInPlace(node.id, { slices: updated });
            (window as any).transportController?.onSliceConfigChange?.(updated);
            this.stateManager.setSelectedSliceIndex(updated.length - 1);
            this.render(true);
        });
        topNav.appendChild(addPill);

        container.appendChild(topNav);

        const updateSlice = (changes: Partial<typeof slice>) => {
            const updatedSlice = { ...slice, ...changes };
            const updatedSlices = [...slices];
            updatedSlices[sliceIdx] = updatedSlice;
            this.stateManager.updateNodeParametersInPlace(node.id, { slices: updatedSlices });
            const activeModel = this.stateManager.getActiveModel();
            const vpNode = activeModel?.nodes.find(n => n.type === 'Telemetry3DViewport');
            if (vpNode && vpNode.id !== node.id) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, { slices: updatedSlices });
            }
            const domainNode = activeModel?.nodes.find(n => n.type === 'DomainMesh3D' || n.type === 'DomainMesh');
            if (domainNode && domainNode.id !== node.id) {
                this.stateManager.updateNodeParametersInPlace(domainNode.id, { slices: updatedSlices });
            }
            (window as any).transportController?.onSliceConfigChange?.(updatedSlices);
        };

        const createSliceAccordion = (secId: string, secTitle: string, buildTableFn: () => HTMLElement) => {
            const fullId = `slice_${node.id}_${sliceIdx}_${secId}`;
            const isCollapsed = this.collapsedAccordions.has(fullId);
            const acc = document.createElement('div');
            acc.className = `property-accordion ${isCollapsed ? 'collapsed' : 'open'}`;
            const hdr = document.createElement('div');
            hdr.className = 'accordion-header';
            hdr.innerHTML = `<span class="accordion-caret">${isCollapsed ? '▶' : '▼'}</span><span class="accordion-title">${secTitle}</span>`;
            hdr.addEventListener('click', () => {
                if (this.collapsedAccordions.has(fullId)) {
                    this.collapsedAccordions.delete(fullId);
                } else {
                    this.collapsedAccordions.add(fullId);
                }
                this.render(true);
            });
            acc.appendChild(hdr);
            if (!isCollapsed) {
                const cnt = document.createElement('div');
                cnt.className = 'accordion-content';
                cnt.appendChild(buildTableFn());
                acc.appendChild(cnt);
            }
            return acc;
        };

        // Accordion 1: Geometry & Plane Orientation
        container.appendChild(createSliceAccordion('geometry', 'Plane Geometry & Orientation', () => {
            const geomTable = document.createElement('table');
            geomTable.className = 'property-table';

            // Enabled
            geomTable.appendChild(this.createTableRow('Active / Enabled', this.createCheckbox(slice.enabled !== false, (val) => {
                updateSlice({ enabled: val });
                this.render(true);
            })));

            // Normal Axis
            const axisOptions = [
                { value: 'yz', label: 'X-Normal' },
                { value: 'xz', label: 'Y-Normal' },
                { value: 'xy', label: 'Z-Normal' }
            ];
            geomTable.appendChild(this.createTableRow('Normal Axis', this.createDropdown(axisOptions, slice.axis || 'xy', (val) => {
                const newBounds = resolveSliceDomainBounds(val, node, state, targetModel);
                const curOffset = slice.offset !== undefined ? Number(slice.offset) : (newBounds.min + newBounds.max) / 2.0;
                const newOffset = (curOffset >= newBounds.min && curOffset <= newBounds.max)
                    ? curOffset
                    : (newBounds.min + newBounds.max) / 2.0;
                updateSlice({ axis: val, offset: newOffset });
                this.render(true);
            })));

            // Offset Position (Precision Float bounded by domain geometry)
            const bounds = resolveSliceDomainBounds(slice.axis || 'xy', node, state, targetModel);
            const offsetVal = slice.offset !== undefined ? Number(slice.offset) : ((bounds.min + bounds.max) / 2.0);
            geomTable.appendChild(this.createTableRow('Offset Position [m]', this.createPrecisionFloatInput(offsetVal, bounds.min, bounds.max, bounds.step, (val) => {
                updateSlice({ offset: val });
            })));

            // Invert Normal
            geomTable.appendChild(this.createTableRow('Invert Normal', this.createCheckbox(slice.invert_normal === true, (val) => {
                updateSlice({ invert_normal: val });
            })));

            return geomTable;
        }));

        // Accordion 2: Scalar Field & Colormapping
        container.appendChild(createSliceAccordion('field', 'Scalar Field & Colormapping', () => {
            const fieldTable = document.createElement('table');
            fieldTable.className = 'property-table';

            // Quantity
            const quantities = ['pressure', 'density', 'velocity', 'energy', 'species1', 'species2', 'species3', 'peak_overpressure', 'peak_impulse', 'vonMises', 'temperature', 'plastic_strain', 'damage'];
            const curQty = canonicalizeQuantity(slice.quantity || slice.quantities?.[0] || 'pressure');
            fieldTable.appendChild(this.createTableRow('Field Quantity', this.createDropdown(quantities, curQty, (val) => {
                const cVal = canonicalizeQuantity(val);
                updateSlice({ quantity: cVal, quantities: [cVal] });
            })));

            // Colormap
            const colormaps = ['rainbow', 'plasma', 'turbo', 'viridis', 'inferno', 'coolwarm', 'magma', 'jet'];
            fieldTable.appendChild(this.createTableRow('Colormap Palette', this.createDropdown(colormaps, slice.colormap || 'rainbow', (val) => {
                updateSlice({ colormap: val });
            })));

            // Opacity
            const opVal = slice.opacity !== undefined ? Number(slice.opacity) : 1.0;
            fieldTable.appendChild(this.createTableRow('Opacity', this.createSlider(0.0, 1.0, 0.05, opVal, (val) => {
                updateSlice({ opacity: val });
            })));

            return fieldTable;
        }));

        // Accordion 3: Range & Scale Clamping
        container.appendChild(createSliceAccordion('range', 'Range Clamping & Scale', () => {
            const rangeTable = document.createElement('table');
            rangeTable.className = 'property-table';

            // Auto Dynamic Range
            const autoRange = slice.auto_range !== false;
            rangeTable.appendChild(this.createTableRow('Auto Dynamic Range', this.createCheckbox(autoRange, (val) => {
                updateSlice({ auto_range: val });
                this.render(true);
            })));

            // Clamping Min Value
            rangeTable.appendChild(this.createTableRow('Min Value (Pa / m/s)', this.createNumberInput(slice.min_val !== undefined ? Number(slice.min_val) : 0, (val) => {
                updateSlice({ min_val: val });
            })));

            // Clamping Max Value
            rangeTable.appendChild(this.createTableRow('Max Value (Pa / m/s)', this.createNumberInput(slice.max_val !== undefined ? Number(slice.max_val) : 1000000, (val) => {
                updateSlice({ max_val: val });
            })));

            // Logarithmic Scale
            rangeTable.appendChild(this.createTableRow('Logarithmic Scale', this.createCheckbox(slice.log_scale === true, (val) => {
                updateSlice({ log_scale: val });
            })));

            return rangeTable;
        }));

        // Accordion 4: Contours & Overlays
        container.appendChild(createSliceAccordion('contours', 'Isocontour Lines & Vector Overlays', () => {
            const contourTable = document.createElement('table');
            contourTable.className = 'property-table';

            // Show Contours
            contourTable.appendChild(this.createTableRow('Show Isocontours', this.createCheckbox(slice.show_contours === true, (val) => {
                updateSlice({ show_contours: val });
            })));

            // Contour Levels
            const levels = slice.contour_levels !== undefined ? Number(slice.contour_levels) : 10;
            contourTable.appendChild(this.createTableRow('Contour Levels', this.createSlider(2, 30, 1, levels, (val) => {
                updateSlice({ contour_levels: val });
            })));

            // Show Vectors
            contourTable.appendChild(this.createTableRow('Show Vector Glyphs', this.createCheckbox(slice.show_vectors === true, (val) => {
                updateSlice({ show_vectors: val });
            })));

            return contourTable;
        }));

        // Action Toolbar
        const actionsRow = document.createElement('div');
        actionsRow.className = 'property-actions-row';

        const addBtn = document.createElement('button');
        addBtn.className = 'property-action-btn primary';
        addBtn.innerHTML = '<span>➕ Add Slice</span>';
        addBtn.addEventListener('click', () => {
            const updated = [...slices, { axis: 'xy', offset: defaultOffset, enabled: true, colormap: 'rainbow', opacity: 1.0, quantity: 'pressure' }];
            this.stateManager.updateNodeParametersInPlace(node.id, { slices: updated });
            (window as any).transportController?.onSliceConfigChange?.(updated);
            this.stateManager.setSelectedSliceIndex(updated.length - 1);
            this.render(true);
        });

        const dupBtn = document.createElement('button');
        dupBtn.className = 'property-action-btn';
        dupBtn.innerHTML = '<span>📑 Duplicate</span>';
        dupBtn.addEventListener('click', () => {
            const clone = JSON.parse(JSON.stringify(slice));
            const updated = [...slices, clone];
            this.stateManager.updateNodeParametersInPlace(node.id, { slices: updated });
            (window as any).transportController?.onSliceConfigChange?.(updated);
            this.stateManager.setSelectedSliceIndex(updated.length - 1);
            this.render(true);
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'property-action-btn danger';
        delBtn.innerHTML = '<span>🗑 Delete Slice</span>';
        delBtn.disabled = slices.length === 0;
        delBtn.addEventListener('click', () => {
            const updated = [...slices];
            updated.splice(sliceIdx, 1);
            this.stateManager.updateNodeParametersInPlace(node.id, { slices: updated });
            (window as any).transportController?.onSliceConfigChange?.(updated);
            this.stateManager.setSelectedSliceIndex(slices.length > 1 ? Math.max(0, sliceIdx - 1) : null);
            this.render(true);
        });

        actionsRow.appendChild(addBtn);
        actionsRow.appendChild(dupBtn);
        actionsRow.appendChild(delBtn);
        container.appendChild(actionsRow);
    }

    private renderVirtualGaugesSection(container: HTMLElement, node: Node, selectedGaugeIdx: number | null): void {
        const targetModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
        const gauges: any[] = node.parameters.gauges || [];

        let is3D = true;
        if (targetModel) {
            if (targetModel.nodes.some(n => n.type === 'DomainMesh3D' || n.type === 'CFDSolver3D')) {
                is3D = true;
            } else if (targetModel.nodes.some(n => n.type === 'DomainMesh2D' || n.type === 'CFDSolver2D')) {
                is3D = false;
            }
        }

        let xMin = -1.0, xMax = 1.0, yMin = -1.0, yMax = 1.0, zMin = -1.0, zMax = 1.0;
        let rMin = 0.0, rMax = 1.0;
        const meshNode3D = targetModel?.nodes.find(n => n.type === 'DomainMesh3D');
        if (meshNode3D) {
            xMin = Number(meshNode3D.parameters.xmin ?? -1.0);
            xMax = Number(meshNode3D.parameters.xmax ?? 1.0);
            yMin = Number(meshNode3D.parameters.ymin ?? -1.0);
            yMax = Number(meshNode3D.parameters.ymax ?? 1.0);
            zMin = Number(meshNode3D.parameters.zmin ?? -1.0);
            zMax = Number(meshNode3D.parameters.zmax ?? 1.0);
        }
        const meshNode2D = targetModel?.nodes.find(n => n.type === 'DomainMesh2D');
        if (meshNode2D) {
            rMin = 0.0;
            rMax = Number(meshNode2D.parameters.rmax ?? meshNode2D.parameters.r_max ?? 1.0);
            zMin = Number(meshNode2D.parameters.zmin ?? meshNode2D.parameters.z_min ?? -1.0);
            zMax = Number(meshNode2D.parameters.zmax ?? 1.0);
        }

        const sectionBox = document.createElement('div');
        sectionBox.className = 'property-gauge-array-card';

        // 1. Header with probe count & active plotted count
        const header = document.createElement('div');
        header.className = 'property-gauge-header';

        const activeCount = gauges.filter(g => g.plot !== false && g.active !== false).length;
        header.innerHTML = `
            <div class="property-gauge-header-title">
                <span style="font-size: 14px;">⏱️</span>
                <strong>Virtual Gauge Array</strong>
                <span class="property-gauge-badge">${gauges.length} probes</span>
                <span class="property-gauge-badge active">${activeCount} active</span>
            </div>
        `;
        sectionBox.appendChild(header);

        // 2. Toolbar: Search Filter & Action Buttons
        const toolbar = document.createElement('div');
        toolbar.className = 'property-gauge-toolbar';

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'property-gauge-search';
        searchInput.placeholder = '🔍 Filter probes...';
        searchInput.value = this.gaugeSearchQuery || '';
        toolbar.appendChild(searchInput);

        const btnGroup = document.createElement('div');
        btnGroup.className = 'property-gauge-actions';

        const addBtn = document.createElement('button');
        addBtn.className = 'property-action-btn primary';
        addBtn.innerHTML = '<span>➕</span> <span>Add</span>';
        addBtn.title = 'Add new virtual gauge probe at domain center';
        addBtn.onclick = () => {
            const nextIdx = gauges.length + 1;
            const newG = is3D ? {
                id: `G${nextIdx}`,
                name: `Gauge ${nextIdx}`,
                x: (xMin + xMax) / 2.0,
                y: (yMin + yMax) / 2.0,
                z: (zMin + zMax) / 2.0,
                plot: true,
                active: true
            } : {
                id: `G${nextIdx}`,
                name: `Gauge ${nextIdx}`,
                r: rMax / 2.0,
                z: (zMin + zMax) / 2.0,
                plot: true,
                active: true
            };
            const updated = [...gauges, newG];
            this.stateManager.updateNodeParameters(node.id, { gauges: updated });
            if (targetModel) this.stateManager.setModelStatus(targetModel.id, 'UNINITIALIZED');
            this.stateManager.setSelectedGaugeIndex(updated.length - 1);
            this.render(true);
        };
        btnGroup.appendChild(addBtn);

        const popoutBtn = document.createElement('button');
        popoutBtn.className = 'property-action-btn';
        popoutBtn.innerHTML = '<span>🗗</span> <span>Pop Out Manager...</span>';
        popoutBtn.title = 'Open spacious standalone Gauge Manager popup window';
        popoutBtn.onclick = () => {
            if (targetModel) {
                new GaugeManagerModal(this.stateManager, node, targetModel, selectedGaugeIdx, () => {
                    this.render(true);
                });
            }
        };
        btnGroup.appendChild(popoutBtn);

        toolbar.appendChild(btnGroup);
        sectionBox.appendChild(toolbar);

        // 3. Spreadsheet Table
        const tableWrap = document.createElement('div');
        tableWrap.className = 'property-gauge-table-wrap';

        const renderTableBody = (filterQuery: string) => {
            tableWrap.innerHTML = '';
            const query = filterQuery.toLowerCase().trim();

            const indexedGauges = gauges.map((g, idx) => ({ g, idx }));
            const filtered = indexedGauges.filter(({ g, idx }) => {
                if (!query) return true;
                const idStr = String(g.id || '').toLowerCase();
                const nameStr = String(g.name || '').toLowerCase();
                const numStr = `#${idx + 1}`;
                const coordsStr = `${g.x ?? ''} ${g.y ?? ''} ${g.z ?? ''} ${g.r ?? ''}`;
                return idStr.includes(query) || nameStr.includes(query) || numStr.includes(query) || coordsStr.includes(query);
            });

            if (gauges.length === 0) {
                const emptyNotice = document.createElement('div');
                emptyNotice.className = 'property-gauge-empty';
                emptyNotice.innerHTML = `
                    <span>No virtual gauge probes defined on this node.</span>
                    <button class="property-action-btn primary" style="margin-top: 6px;">➕ Add First Probe</button>
                `;
                emptyNotice.querySelector('button')?.addEventListener('click', () => addBtn.click());
                tableWrap.appendChild(emptyNotice);
                return;
            }

            const table = document.createElement('table');
            table.className = 'property-gauge-table';

            const thead = document.createElement('thead');
            thead.innerHTML = `
                <tr>
                    <th style="width: 28px;" title="Plot enabled">Plot</th>
                    <th style="width: 32px;">#</th>
                    <th style="width: 60px;">ID</th>
                    <th>Name</th>
                    ${is3D ? `
                        <th style="width: 48px;">X [m]</th>
                        <th style="width: 48px;">Y [m]</th>
                        <th style="width: 48px;">Z [m]</th>
                    ` : `
                        <th style="width: 55px;">R [m]</th>
                        <th style="width: 55px;">Z [m]</th>
                    `}
                    <th style="width: 65px;" title="Peak overpressure">P_max</th>
                    <th style="width: 28px; text-align: right;">Del</th>
                </tr>
            `;
            table.appendChild(thead);

            const tbody = document.createElement('tbody');

            const tData = this.stateManager.telemetryStore.get(node.id);
            const history = tData?.gauges_history || [];

            filtered.forEach(({ g, idx }) => {
                const tr = document.createElement('tr');
                tr.className = `property-gauge-row ${idx === selectedGaugeIdx ? 'selected' : ''}`;

                // Plot eye toggle
                const tdPlot = document.createElement('td');
                const isPlotted = g.plot !== false && g.active !== false;
                const eyeBtn = document.createElement('button');
                eyeBtn.className = `property-gauge-eye-btn ${isPlotted ? 'active' : 'inactive'}`;
                eyeBtn.innerHTML = isPlotted ? '👁' : '🚫';
                eyeBtn.title = isPlotted ? 'Plotting Enabled' : 'Plotting Disabled';
                eyeBtn.onclick = (e) => {
                    e.stopPropagation();
                    const updatedGauges = [...gauges];
                    updatedGauges[idx] = { ...g, plot: !isPlotted };
                    this.stateManager.updateNodeParametersInPlace(node.id, { gauges: updatedGauges });
                    this.render(true);
                };
                tdPlot.appendChild(eyeBtn);
                tr.appendChild(tdPlot);

                // Index
                const tdIdx = document.createElement('td');
                tdIdx.className = 'mono';
                tdIdx.textContent = `#${idx + 1}`;
                tr.appendChild(tdIdx);

                // ID
                const tdId = document.createElement('td');
                tdId.className = 'mono';
                tdId.textContent = g.id || `G${idx + 1}`;
                tr.appendChild(tdId);

                // Name
                const tdName = document.createElement('td');
                tdName.textContent = g.name || g.id || `Gauge ${idx + 1}`;
                tr.appendChild(tdName);

                // Coordinates
                if (is3D) {
                    const tdX = document.createElement('td');
                    tdX.className = 'mono';
                    tdX.textContent = Number(g.x ?? 0.0).toFixed(2);
                    tr.appendChild(tdX);

                    const tdY = document.createElement('td');
                    tdY.className = 'mono';
                    tdY.textContent = Number(g.y ?? 0.0).toFixed(2);
                    tr.appendChild(tdY);

                    const tdZ = document.createElement('td');
                    tdZ.className = 'mono';
                    tdZ.textContent = Number(g.z ?? 0.0).toFixed(2);
                    tr.appendChild(tdZ);
                } else {
                    const tdR = document.createElement('td');
                    tdR.className = 'mono';
                    tdR.textContent = Number(g.r ?? (g.x ?? 0.0)).toFixed(2);
                    tr.appendChild(tdR);

                    const tdZ = document.createElement('td');
                    tdZ.className = 'mono';
                    tdZ.textContent = Number(g.z ?? 0.0).toFixed(2);
                    tr.appendChild(tdZ);
                }

                // P_max
                const tdPmax = document.createElement('td');
                tdPmax.className = 'mono';
                let pMax = 0.0;
                const gId = g.id || g.name || `G${idx + 1}`;
                const gh = history.find((h: any) => h.id === gId || h.id === String(idx));
                if (gh && gh.channel_values && gh.channel_values[0]) {
                    for (const p of gh.channel_values[0]) {
                        if (p > pMax) pMax = p;
                    }
                }
                if (pMax > 0) {
                    tdPmax.textContent = `${(pMax / 1e3).toFixed(1)}k`;
                    tdPmax.style.color = '#f87171';
                } else {
                    tdPmax.textContent = '—';
                    tdPmax.style.color = '#64748b';
                }
                tr.appendChild(tdPmax);

                // Delete Button
                const tdDel = document.createElement('td');
                tdDel.style.textAlign = 'right';
                const delBtn = document.createElement('button');
                delBtn.className = 'property-gauge-del-btn';
                delBtn.innerHTML = '✖';
                delBtn.title = 'Delete probe';
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    const updated = gauges.filter((_, i) => i !== idx);
                    this.stateManager.updateNodeParameters(node.id, { gauges: updated });
                    if (targetModel) this.stateManager.setModelStatus(targetModel.id, 'UNINITIALIZED');
                    if (this.stateManager.getSelectedGaugeIndex() === idx) {
                        this.stateManager.setSelectedGaugeIndex(null);
                    }
                    this.render(true);
                };
                tdDel.appendChild(delBtn);
                tr.appendChild(tdDel);

                // Click to Select Row
                tr.onclick = () => {
                    if (selectedGaugeIdx === idx) {
                        this.stateManager.setSelectedGaugeIndex(null);
                    } else {
                        this.stateManager.setSelectedGaugeIndex(idx);
                    }
                    this.render(true);
                };

                tbody.appendChild(tr);
            });

            table.appendChild(tbody);
            tableWrap.appendChild(table);
        };

        searchInput.oninput = () => {
            this.gaugeSearchQuery = searchInput.value;
            renderTableBody(this.gaugeSearchQuery);
        };

        renderTableBody(this.gaugeSearchQuery);
        sectionBox.appendChild(tableWrap);

        // 4. Detail Inspector (Directly Beneath Spreadsheet)
        if (selectedGaugeIdx !== null && gauges[selectedGaugeIdx]) {
            this.renderInlineGaugeInspector(sectionBox, node, selectedGaugeIdx, targetModel, gauges, is3D, xMin, xMax, yMin, yMax, zMin, zMax, rMin, rMax);
        } else {
            const hint = document.createElement('div');
            hint.className = 'property-gauge-hint';
            hint.innerHTML = '<span>ℹ️ Click any probe row above to inspect its spatial coordinates, standoff distance, and live waveform.</span>';
            sectionBox.appendChild(hint);
        }

        container.appendChild(sectionBox);
    }

    private renderInlineGaugeInspector(
        container: HTMLElement,
        node: Node,
        gaugeIdx: number,
        targetModel: any,
        gauges: any[],
        is3D: boolean,
        xMin: number,
        xMax: number,
        yMin: number,
        yMax: number,
        zMin: number,
        zMax: number,
        rMin: number,
        rMax: number
    ): void {
        const gauge = gauges[gaugeIdx] || { id: `G${gaugeIdx + 1}`, name: `Gauge ${gaugeIdx + 1}`, x: 0.0, y: 0.0, z: 0.0, r: 0.0, plot: true, active: true };

        const inspectorBox = document.createElement('div');
        inspectorBox.className = 'property-gauge-inspector-box';

        // Header
        const header = document.createElement('div');
        header.className = 'property-gauge-inspector-header';
        header.innerHTML = `
            <div style="font-weight: bold; font-size: 12px; color: #38bdf8;">
                Probe #${gaugeIdx + 1}: ${gauge.name || gauge.id}
            </div>
        `;

        const deselectBtn = document.createElement('button');
        deselectBtn.className = 'property-gauge-close-btn';
        deselectBtn.innerHTML = '✕ Deselect';
        deselectBtn.title = 'Unfocus probe';
        deselectBtn.onclick = () => {
            this.stateManager.setSelectedGaugeIndex(null);
            this.render(true);
        };
        header.appendChild(deselectBtn);
        inspectorBox.appendChild(header);

        const updateGauge = (changes: Partial<typeof gauge>, invalidate: boolean = true) => {
            const updatedGauge = { ...gauge, ...changes };
            const updatedGauges = [...gauges];
            updatedGauges[gaugeIdx] = updatedGauge;
            if (invalidate && targetModel) {
                this.stateManager.updateNodeParameters(node.id, { gauges: updatedGauges });
                this.stateManager.setModelStatus(targetModel.id, 'UNINITIALIZED');
            } else {
                this.stateManager.updateNodeParametersInPlace(node.id, { gauges: updatedGauges });
            }
            const vpNode = targetModel?.nodes.find((n: any) => n.type === 'Telemetry3DViewport');
            if (vpNode) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, { _gauge_ts: Date.now() });
            }
        };

        // Standoff Physics
        const chargeNode = targetModel?.nodes.find((n: any) => n.type === 'Charge3D' || n.type === 'Charge2D' || n.type === 'Charge1D');
        const detNode = targetModel?.nodes.find((n: any) => n.type === 'DetonatorLocation3D' || n.type === 'DetonatorLocation');
        let chargeCenter: { x: number; y: number; z: number } | null = null;
        let chargeMass: number | null = null;
        if (chargeNode) {
            const p = chargeNode.parameters;
            chargeCenter = {
                x: Number(p.center_x ?? p.x ?? 0.0),
                y: Number(p.center_y ?? p.y ?? 0.0),
                z: Number(p.center_z ?? p.z ?? p.center_r ?? 0.0)
            };
            if (p.charge_mass !== undefined) chargeMass = Number(p.charge_mass);
        } else if (detNode) {
            const p = detNode.parameters;
            chargeCenter = {
                x: Number(p.det_x ?? p.x ?? 0.0),
                y: Number(p.det_y ?? p.y ?? 0.0),
                z: Number(p.det_z ?? p.z ?? 0.0)
            };
        }

        if (chargeCenter) {
            const gx = gauge.x !== undefined ? Number(gauge.x) : (gauge.r !== undefined ? Number(gauge.r) : 0.0);
            const gy = gauge.y !== undefined ? Number(gauge.y) : 0.0;
            const gz = gauge.z !== undefined ? Number(gauge.z) : 0.0;
            const dist = is3D
                ? Math.sqrt(Math.pow(gx - chargeCenter.x, 2) + Math.pow(gy - chargeCenter.y, 2) + Math.pow(gz - chargeCenter.z, 2))
                : Math.sqrt(Math.pow(gx - chargeCenter.x, 2) + Math.pow(gz - chargeCenter.z, 2));

            const standoffCard = document.createElement('div');
            standoffCard.className = 'property-gauge-standoff-card';
            let zScaledStr = '';
            if (chargeMass && chargeMass > 0) {
                const zVal = dist / Math.cbrt(chargeMass);
                zScaledStr = ` · Scaled Standoff Z = <strong style="color: #38bdf8;">${zVal.toFixed(3)}</strong> m/kg^(1/3)`;
            }
            standoffCard.innerHTML = `<span>🎯 Standoff R = <strong style="color: #38bdf8;">${dist.toFixed(3)} m</strong>${zScaledStr}</span>`;
            inspectorBox.appendChild(standoffCard);
        }

        const createGaugeAccordion = (secId: string, secTitle: string, buildTableFn: () => HTMLElement) => {
            const fullId = `gauge_${node.id}_${gaugeIdx}_${secId}`;
            const isCollapsed = this.collapsedAccordions.has(fullId);
            const acc = document.createElement('div');
            acc.className = `property-accordion ${isCollapsed ? 'collapsed' : 'open'}`;
            const hdr = document.createElement('div');
            hdr.className = 'accordion-header';
            hdr.innerHTML = `<span class="accordion-caret">${isCollapsed ? '▶' : '▼'}</span><span class="accordion-title">${secTitle}</span>`;
            hdr.addEventListener('click', () => {
                if (this.collapsedAccordions.has(fullId)) {
                    this.collapsedAccordions.delete(fullId);
                } else {
                    this.collapsedAccordions.add(fullId);
                }
                this.render(true);
            });
            acc.appendChild(hdr);
            if (!isCollapsed) {
                const cnt = document.createElement('div');
                cnt.className = 'accordion-content';
                cnt.appendChild(buildTableFn());
                acc.appendChild(cnt);
            }
            return acc;
        };

        // Accordion 1: Coordinates
        inspectorBox.appendChild(createGaugeAccordion('location', 'Spatial Coordinates (Location)', () => {
            const locTable = document.createElement('table');
            locTable.className = 'property-table';

            if (is3D) {
                const curX = gauge.x !== undefined ? Number(gauge.x) : 0.0;
                locTable.appendChild(this.createTableRow('X-Coordinate [m]', this.createCoordInput(curX, (val) => {
                    updateGauge({ x: val }, true);
                })));

                const curY = gauge.y !== undefined ? Number(gauge.y) : 0.0;
                locTable.appendChild(this.createTableRow('Y-Coordinate [m]', this.createCoordInput(curY, (val) => {
                    updateGauge({ y: val }, true);
                })));

                const curZ = gauge.z !== undefined ? Number(gauge.z) : 0.0;
                locTable.appendChild(this.createTableRow('Z-Coordinate [m]', this.createCoordInput(curZ, (val) => {
                    updateGauge({ z: val }, true);
                })));
            } else {
                const curR = gauge.r !== undefined ? Number(gauge.r) : (gauge.x !== undefined ? Number(gauge.x) : 0.0);
                locTable.appendChild(this.createTableRow('R-Coordinate [m]', this.createCoordInput(curR, (val) => {
                    updateGauge({ r: val }, true);
                })));

                const curZ = gauge.z !== undefined ? Number(gauge.z) : 0.0;
                locTable.appendChild(this.createTableRow('Z-Coordinate [m]', this.createCoordInput(curZ, (val) => {
                    updateGauge({ z: val }, true);
                })));
            }
            return locTable;
        }));

        // Accordion 2: Metadata
        inspectorBox.appendChild(createGaugeAccordion('metadata', 'Probe Identification & Settings', () => {
            const metaTable = document.createElement('table');
            metaTable.className = 'property-table';

            const idInput = document.createElement('input');
            idInput.type = 'text';
            idInput.className = 'property-input text-input';
            idInput.value = gauge.id || gauge.name || `G${gaugeIdx + 1}`;
            const commitId = () => {
                updateGauge({ id: idInput.value }, false);
            };
            idInput.addEventListener('change', commitId);
            idInput.addEventListener('blur', commitId);
            metaTable.appendChild(this.createTableRow('Probe Identifier / ID', idInput));

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'property-input text-input';
            nameInput.value = gauge.name || gauge.id || `Gauge ${gaugeIdx + 1}`;
            const commitName = () => {
                updateGauge({ name: nameInput.value }, false);
            };
            nameInput.addEventListener('change', commitName);
            nameInput.addEventListener('blur', commitName);
            metaTable.appendChild(this.createTableRow('Display Name', nameInput));

            metaTable.appendChild(this.createTableRow('Active Plotting', this.createCheckbox(gauge.plot !== false, (val) => {
                updateGauge({ plot: val }, false);
                this.render(true);
            })));

            return metaTable;
        }));

        // Accordion 3: Waveform
        inspectorBox.appendChild(createGaugeAccordion('telemetry', 'Live Telemetry & Waveform Interrogation', () => {
            const teleBox = document.createElement('div');
            teleBox.className = 'property-gauge-telemetry-box';
            teleBox.style.padding = '8px';
            teleBox.style.display = 'flex';
            teleBox.style.flexDirection = 'column';
            teleBox.style.gap = '8px';

            let times: number[] = [];
            let pressures: number[] = [];
            let impulses: number[] = [];
            let pMax = 0.0;
            let impMax = 0.0;

            const tData = this.stateManager.telemetryStore.get(node.id);
            if (tData && tData.gauges_history) {
                const gId = gauge.id || gauge.name || `G${gaugeIdx + 1}`;
                const gh = tData.gauges_history.find((h: any) => h.id === gId || h.id === String(gaugeIdx));
                if (gh && gh.channel_values) {
                    pressures = gh.channel_values[0] || [];
                    impulses = gh.channel_values[8] || [];
                    times = tData.gauge_times || [];
                    for (const p of pressures) {
                        if (p > pMax) pMax = p;
                    }
                    for (const imp of impulses) {
                        if (imp > impMax) impMax = imp;
                    }
                }
            }

            const metricsRow = document.createElement('div');
            metricsRow.style.display = 'flex';
            metricsRow.style.gap = '8px';
            metricsRow.style.fontSize = '11px';

            const pMaxBadge = document.createElement('div');
            pMaxBadge.style.background = 'rgba(239, 68, 68, 0.15)';
            pMaxBadge.style.border = '1px solid rgba(239, 68, 68, 0.4)';
            pMaxBadge.style.borderRadius = '4px';
            pMaxBadge.style.padding = '4px 8px';
            pMaxBadge.style.color = '#f87171';
            pMaxBadge.style.fontWeight = 'bold';
            pMaxBadge.innerHTML = `P_max: <span style="font-family: monospace;">${(pMax / 1e3).toFixed(1)} kPa</span>`;
            metricsRow.appendChild(pMaxBadge);

            const impBadge = document.createElement('div');
            impBadge.style.background = 'rgba(56, 189, 248, 0.15)';
            impBadge.style.border = '1px solid rgba(56, 189, 248, 0.4)';
            impBadge.style.borderRadius = '4px';
            impBadge.style.padding = '4px 8px';
            impBadge.style.color = '#38bdf8';
            impBadge.style.fontWeight = 'bold';
            impBadge.innerHTML = `Impulse: <span style="font-family: monospace;">${impMax.toFixed(1)} Pa·s</span>`;
            metricsRow.appendChild(impBadge);

            teleBox.appendChild(metricsRow);

            const canvasContainer = document.createElement('div');
            canvasContainer.style.width = '100%';
            canvasContainer.style.height = '60px';
            canvasContainer.style.background = '#0d1117';
            canvasContainer.style.border = '1px solid rgba(255, 255, 255, 0.1)';
            canvasContainer.style.borderRadius = '4px';
            canvasContainer.style.overflow = 'hidden';
            canvasContainer.style.position = 'relative';

            const canvas = document.createElement('canvas');
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.display = 'block';
            canvasContainer.appendChild(canvas);
            teleBox.appendChild(canvasContainer);

            requestAnimationFrame(() => {
                const rect = canvasContainer.getBoundingClientRect();
                const dpr = window.devicePixelRatio || 1;
                canvas.width = Math.max(10, Math.floor(rect.width * dpr));
                canvas.height = Math.max(10, Math.floor(rect.height * dpr));
                const ctx = canvas.getContext('2d');
                if (!ctx) return;
                ctx.scale(dpr, dpr);

                const w = rect.width;
                const h = rect.height;
                ctx.clearRect(0, 0, w, h);

                if (pressures.length < 2) {
                    ctx.fillStyle = '#64748b';
                    ctx.font = '11px monospace';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText('Awaiting Telemetry...', w / 2, h / 2);
                    return;
                }

                const minP = Math.min(...pressures);
                const maxP = Math.max(...pressures);
                const range = (maxP - minP) || 1.0;

                ctx.strokeStyle = '#38bdf8';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                for (let i = 0; i < pressures.length; ++i) {
                    const cx = (i / (pressures.length - 1)) * (w - 10) + 5;
                    const cy = h - 5 - ((pressures[i] - minP) / range) * (h - 10);
                    if (i === 0) ctx.moveTo(cx, cy);
                    else ctx.lineTo(cx, cy);
                }
                ctx.stroke();
            });

            const actionsRow = document.createElement('div');
            actionsRow.style.display = 'flex';
            actionsRow.style.gap = '8px';

            const pinnedIds: string[] = node.parameters.pinned_probe_ids || [];
            const isPinned = pinnedIds.includes(gauge.id || '') || pinnedIds.includes(String(gaugeIdx));

            const pinBtn = document.createElement('button');
            pinBtn.className = 'property-action-btn';
            pinBtn.style.flex = '1';
            pinBtn.style.padding = '5px 10px';
            pinBtn.style.fontSize = '11px';
            pinBtn.style.borderRadius = '4px';
            pinBtn.style.cursor = 'pointer';
            pinBtn.style.background = isPinned ? 'rgba(234, 179, 8, 0.2)' : 'rgba(255, 255, 255, 0.05)';
            pinBtn.style.border = isPinned ? '1px solid #eab308' : '1px solid rgba(255, 255, 255, 0.15)';
            pinBtn.style.color = isPinned ? '#fde047' : '#e2e8f0';
            pinBtn.innerHTML = isPinned ? '📌 Pinned' : '📌 Pin to Watch';
            pinBtn.onclick = () => {
                let nextPinned: string[];
                const gId = gauge.id || String(gaugeIdx);
                if (isPinned) {
                    nextPinned = pinnedIds.filter(id => id !== gId && id !== String(gaugeIdx));
                } else {
                    nextPinned = [...pinnedIds, gId];
                }
                this.stateManager.updateNodeParametersInPlace(node.id, { pinned_probe_ids: nextPinned });
                this.render(true);
            };
            actionsRow.appendChild(pinBtn);

            const csvBtn = document.createElement('button');
            csvBtn.className = 'property-action-btn';
            csvBtn.style.flex = '1';
            csvBtn.style.padding = '5px 10px';
            csvBtn.style.fontSize = '11px';
            csvBtn.style.borderRadius = '4px';
            csvBtn.style.cursor = 'pointer';
            csvBtn.style.background = 'rgba(255, 255, 255, 0.05)';
            csvBtn.style.border = '1px solid rgba(255, 255, 255, 0.15)';
            csvBtn.style.color = '#e2e8f0';
            csvBtn.innerHTML = '💾 CSV';
            csvBtn.onclick = () => {
                let csv = 'time_s,pressure_Pa,impulse_Pas\n';
                for (let i = 0; i < times.length; ++i) {
                    csv += `${times[i]},${pressures[i] ?? 0.0},${impulses[i] ?? 0.0}\n`;
                }
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `probe_${gauge.id || gaugeIdx + 1}.csv`;
                a.click();
                URL.revokeObjectURL(url);
            };
            actionsRow.appendChild(csvBtn);

            const dupBtn = document.createElement('button');
            dupBtn.className = 'property-action-btn';
            dupBtn.style.flex = '1';
            dupBtn.style.padding = '5px 10px';
            dupBtn.style.fontSize = '11px';
            dupBtn.style.borderRadius = '4px';
            dupBtn.style.cursor = 'pointer';
            dupBtn.style.background = 'rgba(255, 255, 255, 0.05)';
            dupBtn.style.border = '1px solid rgba(255, 255, 255, 0.15)';
            dupBtn.style.color = '#e2e8f0';
            dupBtn.innerHTML = '📑 Dup';
            dupBtn.onclick = () => {
                const nextId = gauges.length + 1;
                const dup = {
                    ...gauge,
                    id: `G${nextId}`,
                    name: `${gauge.name || gauge.id} (Copy)`,
                    x: gauge.x !== undefined ? gauge.x + 0.05 : undefined,
                    y: gauge.y !== undefined ? gauge.y + 0.05 : undefined,
                    z: gauge.z !== undefined ? gauge.z + 0.05 : undefined,
                    r: gauge.r !== undefined ? gauge.r + 0.05 : undefined
                };
                const updated = [...gauges, dup];
                this.stateManager.updateNodeParameters(node.id, { gauges: updated });
                if (targetModel) this.stateManager.setModelStatus(targetModel.id, 'UNINITIALIZED');
                this.stateManager.setSelectedGaugeIndex(updated.length - 1);
                this.render(true);
            };
            actionsRow.appendChild(dupBtn);

            const delBtn = document.createElement('button');
            delBtn.className = 'property-action-btn';
            delBtn.style.padding = '5px 10px';
            delBtn.style.fontSize = '11px';
            delBtn.style.borderRadius = '4px';
            delBtn.style.cursor = 'pointer';
            delBtn.style.background = 'rgba(239, 68, 68, 0.15)';
            delBtn.style.border = '1px solid rgba(239, 68, 68, 0.4)';
            delBtn.style.color = '#f87171';
            delBtn.innerHTML = '🗑 Delete';
            delBtn.onclick = () => {
                const updatedGauges = gauges.filter((_, i) => i !== gaugeIdx);
                this.stateManager.updateNodeParameters(node.id, { gauges: updatedGauges });
                if (targetModel) this.stateManager.setModelStatus(targetModel.id, 'UNINITIALIZED');
                this.stateManager.setSelectedGaugeIndex(null);
                this.render(true);
            };
            actionsRow.appendChild(delBtn);

            teleBox.appendChild(actionsRow);
            return teleBox;
        }));

        container.appendChild(inspectorBox);
    }

    private renderSingleSliceDisplay(container: HTMLElement, node: Node, sliceIdx: number): void {
        const slices: any[] = this.getSlicesForNode(node);
        const slice = slices[sliceIdx];
        if (!slice) {
            this.stateManager.setSelectedSliceIndex(null);
            this.render(true);
            return;
        }

        const targetModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
        const state = this.stateManager.getCurrentState();

        const updateSlice = (changes: Partial<typeof slice>) => {
            const updatedSlice = { ...slice, ...changes };
            const updatedSlices = [...slices];
            updatedSlices[sliceIdx] = updatedSlice;
            this.updateDisplayParam(node, 'slices', updatedSlices);
            (window as any).transportController?.onSliceConfigChange?.(updatedSlices);
        };

        const groupId = `slice_${node.id}_${sliceIdx}_display`;
        const { accordion, content } = this.buildAccordion(groupId, `Slice #${sliceIdx} (${getSliceAxisLabel(slice.axis)}) Representation`);

        if (content) {
            const bar = document.createElement('div');
            bar.style.display = 'flex';
            bar.style.justifyContent = 'space-between';
            bar.style.alignItems = 'center';
            bar.style.marginBottom = '8px';
            bar.style.padding = '4px 6px';
            bar.style.background = 'rgba(15, 23, 42, 0.6)';
            bar.style.borderRadius = '4px';
            bar.style.border = '1px solid #1e293b';

            const backBtn = document.createElement('button');
            backBtn.className = 'property-action-btn';
            backBtn.innerHTML = '<span>⬅ All Slices</span>';
            backBtn.title = 'Back to Slice Planes Overview';
            backBtn.addEventListener('click', () => {
                this.stateManager.setSelectedSliceIndex(null);
                (window as any).transportController?.setActiveSliceIndex?.(null);
                this.render(true);
            });

            const delBtn = document.createElement('button');
            delBtn.className = 'property-action-btn danger';
            delBtn.style.color = '#ef4444';
            delBtn.innerHTML = '<span>🗑 Delete</span>';
            delBtn.title = 'Delete this slice plane';
            delBtn.addEventListener('click', () => {
                const updatedSlices = slices.filter((_, i) => i !== sliceIdx);
                this.updateDisplayParam(node, 'slices', updatedSlices);
                this.stateManager.setSelectedSliceIndex(null);
                (window as any).transportController?.setActiveSliceIndex?.(null);
                (window as any).transportController?.onSliceConfigChange?.(updatedSlices);
                this.render(true);
            });

            bar.appendChild(backBtn);
            bar.appendChild(delBtn);
            content.appendChild(bar);

            const table = document.createElement('table');
            table.className = 'property-table';

            // 1. Visibility in Viewport
            const isVisible = slice.enabled !== false;
            table.appendChild(this.createTableRow('Active in Viewport', this.createCheckbox(isVisible, (val) => {
                updateSlice({ enabled: val });
            })));

            // 2. Normal Axis
            const axisOptions = [
                { value: 'xy', label: 'XY / Axial (Z-Normal)' },
                { value: 'xz', label: 'XZ / Frontal (Y-Normal)' },
                { value: 'yz', label: 'YZ / Lateral (X-Normal)' }
            ];
            table.appendChild(this.createTableRow('Normal Axis', this.createDropdown(axisOptions, slice.axis || 'xy', (val) => {
                const bounds = resolveSliceDomainBounds(val, node, state, targetModel);
                const clampedOffset = Math.max(bounds.min, Math.min(bounds.max, slice.offset ?? 0.0));
                updateSlice({ axis: val, offset: clampedOffset });
                this.render(true);
            })));

            // 3. Offset Position
            const bounds = resolveSliceDomainBounds(slice.axis || 'xy', node, state, targetModel);
            const offsetVal = slice.offset !== undefined ? Number(slice.offset) : (bounds.min + bounds.max) / 2.0;
            table.appendChild(this.createTableRow('Offset Position [m]', this.createPrecisionFloatInput(offsetVal, bounds.min, bounds.max, bounds.step, (val) => {
                updateSlice({ offset: val });
            })));

            // 4. Field Quantity
            const quantities = ['pressure', 'density', 'velocity', 'energy', 'species1', 'species2', 'species3', 'peak_overpressure', 'peak_impulse', 'vonMises', 'temperature', 'plastic_strain', 'damage'];
            const curQty = canonicalizeQuantity(slice.quantity || slice.quantities?.[0] || 'pressure');
            table.appendChild(this.createTableRow('Field Quantity', this.createDropdown(quantities, curQty, (val) => {
                updateSlice({ quantity: val, quantities: [val] });
            })));

            // 5. Colormap Selector
            const colormaps = ['rainbow', 'viridis', 'plasma', 'turbo', 'jet', 'coolwarm', 'inferno', 'cividis', 'magma', 'grayscale'];
            const currentCmap = slice.colormap || 'rainbow';
            table.appendChild(this.createTableRow('Colormap', this.createDropdown(colormaps, currentCmap, (val) => {
                updateSlice({ colormap: val });
            })));

            // 6. Auto Dynamic Range
            const autoRange = slice.auto_scale !== false;
            table.appendChild(this.createTableRow('Auto Scalar Range', this.createCheckbox(autoRange, (val) => {
                updateSlice({ auto_scale: val });
            })));

            // 7. Min / Max Scalar Value
            table.appendChild(this.createTableRow('Min Value (Pa / m/s)', this.createNumberInput(slice.min_val !== undefined ? Number(slice.min_val) : 0, (val) => {
                updateSlice({ min_val: val });
            })));
            table.appendChild(this.createTableRow('Max Value (Pa / m/s)', this.createNumberInput(slice.max_val !== undefined ? Number(slice.max_val) : 1000000, (val) => {
                updateSlice({ max_val: val });
            })));

            // 8. Logarithmic Scale
            table.appendChild(this.createTableRow('Logarithmic Scale', this.createCheckbox(slice.log_scale === true, (val) => {
                updateSlice({ log_scale: val });
            })));

            // 9. Show Colorbar Legend
            table.appendChild(this.createTableRow('Show Colorbar Legend', this.createCheckbox(slice.show_colorbar === true, (val) => {
                updateSlice({ show_colorbar: val });
            })));

            // 10. Representation Mode
            const repModes = ['Surface / Colormapped Plane', 'Wireframe Grid', 'Isocontour Lines Only'];
            const currentRep = slice.representation || 'Surface / Colormapped Plane';
            table.appendChild(this.createTableRow('Representation', this.createDropdown(repModes, currentRep, (val) => {
                updateSlice({ representation: val });
            })));

            // 11. Opacity Slider
            const currentOpacity = slice.opacity !== undefined ? Number(slice.opacity) : 1.0;
            table.appendChild(this.createTableRow('Opacity', this.createSlider(0.0, 1.0, 0.05, currentOpacity, (val) => {
                updateSlice({ opacity: val });
            })));

            // 12. Stride
            const strideOptions = [
                { value: '1', label: '1 (Full Resolution)' },
                { value: '2', label: '2 (Half Stride)' },
                { value: '4', label: '4 (Quarter Stride)' }
            ];
            const curStride = String(slice.stride || 1);
            table.appendChild(this.createTableRow('Sampling Stride', this.createDropdown(strideOptions, curStride, (val) => {
                updateSlice({ stride: Number(val) });
            })));

            // 13. Bilinear Interpolation
            table.appendChild(this.createTableRow('Bilinear Interpolation', this.createCheckbox(slice.interpolate !== false, (val) => {
                updateSlice({ interpolate: val });
            })));

            content.appendChild(table);
        }
        container.appendChild(accordion);
    }

    private renderSlicesOverviewSection(container: HTMLElement, node: Node): void {
        const slices: any[] = this.getSlicesForNode(node);

        const groupId = `slices_overview_${node.id}`;
        const isCollapsed = this.collapsedAccordions.has(groupId);
        const sliceAccordion = document.createElement('div');
        sliceAccordion.className = `property-accordion ${isCollapsed ? 'collapsed' : 'open'}`;

        const header = document.createElement('div');
        header.className = 'accordion-header';
        header.innerHTML = `
            <span class="accordion-caret">${isCollapsed ? '▶' : '▼'}</span>
            <span class="accordion-title">Orthogonal Slice Planes (${slices.length})</span>
        `;
        header.addEventListener('click', () => {
            if (this.collapsedAccordions.has(groupId)) {
                this.collapsedAccordions.delete(groupId);
            } else {
                this.collapsedAccordions.add(groupId);
            }
            this.render(true);
        });
        sliceAccordion.appendChild(header);

        if (!isCollapsed) {
            const content = document.createElement('div');
            content.className = 'accordion-content';

            if (slices.length === 0) {
                const emptyNotice = document.createElement('div');
                emptyNotice.style.padding = '8px 12px';
                emptyNotice.style.fontSize = '11px';
                emptyNotice.style.color = '#94a3b8';
                emptyNotice.textContent = 'No slice planes currently defined on this viewport.';
                content.appendChild(emptyNotice);
            } else {
                const sliceTabsRow = document.createElement('div');
                sliceTabsRow.className = 'property-slice-pills';

                slices.forEach((sl: any, idx: number) => {
                    const pill = document.createElement('button');
                    pill.className = 'property-slice-pill';
                    let qLabel = sl.quantity || sl.quantities?.[0] || 'pressure';
                    if (qLabel === 'species1' || qLabel === 'products' || qLabel === 'detonation_products' || qLabel === 'reacted') qLabel = 'Products';
                    else if (qLabel === 'species2' || qLabel === 'unreacted') qLabel = 'Unburnt';
                    else if (qLabel === 'species3' || qLabel === 'air') qLabel = 'Air';
                    pill.innerHTML = `<span>${sl.enabled !== false ? '👁' : '🚫'}</span> <span>#${idx} ${getSliceAxisLabel(sl.axis)} (${qLabel})</span>`;
                    pill.title = `Inspect Slice #${idx}`;
                    pill.addEventListener('click', () => {
                        this.stateManager.setSelectedSliceIndex(idx);
                        (window as any).transportController?.setActiveSliceIndex?.(idx);
                        this.render(true);
                    });
                    sliceTabsRow.appendChild(pill);
                });

                content.appendChild(sliceTabsRow);
            }

            const actionsRow = document.createElement('div');
            actionsRow.className = 'property-actions-row';

            const addBtn = document.createElement('button');
            addBtn.className = 'property-action-btn primary';
            addBtn.innerHTML = '<span>➕ Add Slice Plane</span>';
            addBtn.addEventListener('click', () => {
                const targetModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
                const state = this.stateManager.getCurrentState();
                const defBounds = resolveSliceDomainBounds('xy', node, state, targetModel);
                const defOffset = (defBounds.min + defBounds.max) / 2.0;
                const updated = [...slices, { axis: 'xy', offset: defOffset, enabled: true, colormap: 'rainbow', opacity: 1.0, quantity: 'pressure' }];
                this.stateManager.updateNodeParametersInPlace(node.id, { slices: updated });
                (window as any).transportController?.onSliceConfigChange?.(updated);
                this.stateManager.setSelectedSliceIndex(updated.length - 1);
                this.render(true);
            });

            actionsRow.appendChild(addBtn);
            content.appendChild(actionsRow);

            sliceAccordion.appendChild(content);
        }
        container.appendChild(sliceAccordion);
    }

    private renderDisplayTab(container: HTMLElement, node: Node): void {
        const selectedSliceIdx = this.stateManager.getSelectedSliceIndex();
        if (selectedSliceIdx !== null && (node.type === 'Telemetry3DViewport' || node.type === 'DomainMesh3D' || node.type === 'DomainMesh' || node.type === 'CFDSolver3D')) {
            this.renderSingleSliceDisplay(container, node, selectedSliceIdx);
            return;
        }

        if (node.type === 'Telemetry3DViewport') {
            this.renderViewportDisplay(container, node);
        } else if (node.type === 'MPMObject3D' || node.type === 'MPMDomain3D') {
            this.renderMPMDisplay(container, node);
        } else if (node.type === 'FEMObject3D' || node.type === 'FEMDomain3D' || node.type === 'LSDynaImporter3D') {
            this.renderFEMDisplay(container, node);
        } else if (node.type === 'FEMBeam3D') {
            this.renderFEMBeamDisplay(container, node);
        } else if (node.type === 'FEMRebar3D') {
            this.renderFEMRebarDisplay(container, node);
        } else if (node.type === 'STLGeometry') {
            this.renderSTLDisplay(container, node);
        } else if (node.type === 'Obstacle3D' || node.type === 'Obstacle' || node.type === 'PrimitiveGeometry3D') {
            this.renderObstacleDisplay(container, node);
        } else if (['Charge1D', 'Charge2D', 'Charge3D', 'ExplosiveMaterial', 'DetonatorLocation3D', 'DetonationPoint'].includes(node.type)) {
            this.renderChargeDisplay(container, node);
        } else if (node.type === 'DomainMesh' || node.type === 'DomainMesh2D' || node.type === 'DomainMesh3D') {
            this.renderDomainMeshDisplay(container, node);
        } else if (['VirtualGauges3D', 'VirtualGauge', 'VirtualGaugeArray'].includes(node.type)) {
            this.renderVirtualGaugesDisplay(container, node);
        } else {
            this.renderGenericDisplay(container, node);
        }
    }

    private renderViewportDisplay(container: HTMLElement, node: Node): void {
        // Accordion 1: Scene Layers & Object Visibility
        const { accordion: layersAcc, content: layersContent } = this.buildAccordion(`vp_layers_${node.id}`, 'Scene Layers & Object Visibility');
        if (layersContent) {
            const table = document.createElement('table');
            table.className = 'property-table';

            const addLayerRow = (label: string, key: string, defVal: boolean = true) => {
                const checked = node.parameters[key] !== undefined ? Boolean(node.parameters[key]) : defVal;
                table.appendChild(this.createTableRow(label, this.createCheckbox(checked, (val) => {
                    this.updateDisplayParam(node, key, val);
                })));
            };

            addLayerRow('Slice Planes', 'show_slices', true);
            addLayerRow('Computational Grid', 'show_grid', true);
            addLayerRow('Domain Bounding Box', 'show_grid_box', true);
            addLayerRow('Grid Cell Edges', 'grid_meshlines', false);

            const gridOp = node.parameters.grid_opacity !== undefined ? Number(node.parameters.grid_opacity) : 1.0;
            table.appendChild(this.createTableRow('Grid Opacity', this.createSlider(0.0, 1.0, 0.05, gridOp, (val) => {
                this.updateDisplayParam(node, 'grid_opacity', val);
            })));

            addLayerRow('MPM Particles', 'showMPMParticles', true);
            addLayerRow('FEM Structural Mesh', 'showFEMMesh', true);
            addLayerRow('Embedded Rebar', 'showRebar', true);
            addLayerRow('Beam Framework', 'showBeams', true);
            addLayerRow('CAD STL Obstacles', 'show_stl', true);
            addLayerRow('CSG Obstacles', 'show_obstacles', true);
            addLayerRow('Explosive Charge', 'show_charge', true);
            addLayerRow('Detonation Points', 'show_detonators', true);
            addLayerRow('Virtual Gauges', 'show_gauges', true);

            layersContent.appendChild(table);
        }
        container.appendChild(layersAcc);

        // Accordion 2: Global Shading & Ambient Occlusion (SSAO)
        const { accordion: shadeAcc, content: shadeContent } = this.buildAccordion(`vp_shade_${node.id}`, 'Global Shading & Ambient Occlusion (SSAO)');
        if (shadeContent) {
            const table = document.createElement('table');
            table.className = 'property-table';

            const lighting = node.parameters.lightingEnabled !== false;
            table.appendChild(this.createTableRow('Direct Lighting', this.createCheckbox(lighting, (val) => {
                this.updateDisplayParam(node, 'lightingEnabled', val);
            })));

            const ao = node.parameters.aoEnabled !== false;
            table.appendChild(this.createTableRow('Ambient Occlusion (SSAO)', this.createCheckbox(ao, (val) => {
                this.updateDisplayParam(node, 'aoEnabled', val);
            })));

            const radius = node.parameters.aoRadius !== undefined ? Number(node.parameters.aoRadius) : 0.15;
            table.appendChild(this.createTableRow('AO Radius [m]', this.createSlider(0.01, 1.0, 0.01, radius, (val) => {
                this.updateDisplayParam(node, 'aoRadius', val);
            })));

            const intensity = node.parameters.aoIntensity !== undefined ? Number(node.parameters.aoIntensity) : 1.0;
            table.appendChild(this.createTableRow('AO Intensity', this.createSlider(0.0, 3.0, 0.05, intensity, (val) => {
                this.updateDisplayParam(node, 'aoIntensity', val);
            })));

            const impostor = node.parameters.aoSphereImpostor !== false;
            table.appendChild(this.createTableRow('Impostor Spheres AO', this.createCheckbox(impostor, (val) => {
                this.updateDisplayParam(node, 'aoSphereImpostor', val);
            })));

            shadeContent.appendChild(table);
        }
        container.appendChild(shadeAcc);

        // Accordion 3: Viewport Refresh & Performance
        const { accordion: perfAcc, content: perfContent } = this.buildAccordion(`vp_perf_${node.id}`, 'Performance & Legend Overlays');
        if (perfContent) {
            const table = document.createElement('table');
            table.className = 'property-table';

            const fpsOptions = [
                { value: '60', label: '60 Hz (Smooth)' },
                { value: '30', label: '30 Hz (Balanced)' },
                { value: '10', label: '10 Hz (Low Load)' },
                { value: '5', label: '5 Hz' },
                { value: '2', label: '2 Hz' },
                { value: '1', label: '1 Hz' }
            ];
            const curFps = String(node.parameters.viewport_refresh_rate || node.parameters.refresh_rate || 30);
            table.appendChild(this.createTableRow('Refresh Rate', this.createDropdown(fpsOptions, curFps, (val) => {
                this.updateDisplayParam(node, 'viewport_refresh_rate', Number(val));
                this.updateDisplayParam(node, 'refresh_rate', Number(val));
            })));

            const showCbar = node.parameters.show_color_bar !== false;
            table.appendChild(this.createTableRow('Scalar Colorbar Legend', this.createCheckbox(showCbar, (val) => {
                this.updateDisplayParam(node, 'show_color_bar', val);
            })));

            perfContent.appendChild(table);
        }
        container.appendChild(perfAcc);

        // Accordion 4: Slices Overview
        this.renderSlicesOverviewSection(container, node);
    }

    private renderMPMDisplay(container: HTMLElement, node: Node): void {
        const vpNode = this.getActiveViewportNode(node);
        const p = { ...vpNode?.parameters, ...node.parameters };

        // Accordion 1: Visual Representation
        const { accordion: visAcc, content: visContent } = this.buildAccordion(`mpm_vis_${node.id}`, 'MPM Particle Point Cloud Visuals');
        if (visContent) {
            const table = document.createElement('table');
            table.className = 'property-table';

            const isVisible = p.showMPMParticles !== false;
            table.appendChild(this.createTableRow('Active in Viewport', this.createCheckbox(isVisible, (val) => {
                this.updateDisplayParam(node, 'showMPMParticles', val);
            })));

            const styleOptions = [
                { value: 'spheres', label: 'Billboard Spheres' },
                { value: 'points', label: 'Wireframe / Points' }
            ];
            const curStyle = p.mpmParticleWireframe ? 'points' : 'spheres';
            table.appendChild(this.createTableRow('Rendering Style', this.createDropdown(styleOptions, curStyle, (val) => {
                this.updateDisplayParam(node, 'mpmParticleWireframe', val === 'points');
            })));

            const diam = p.mpmParticleDiameter !== undefined ? Number(p.mpmParticleDiameter) : 0.015;
            table.appendChild(this.createTableRow('Particle Diameter [m]', this.createPrecisionFloatInput(diam, 0.001, 0.5, 0.001, (val) => {
                this.updateDisplayParam(node, 'mpmParticleDiameter', val);
            })));

            const opacity = p.mpmParticleOpacity !== undefined ? Number(p.mpmParticleOpacity) : 1.0;
            table.appendChild(this.createTableRow('Particle Opacity', this.createSlider(0.0, 1.0, 0.05, opacity, (val) => {
                this.updateDisplayParam(node, 'mpmParticleOpacity', val);
            })));

            visContent.appendChild(table);
        }
        container.appendChild(visAcc);

        // Accordion 2: Scalar Field & Colormapping
        const { accordion: fieldAcc, content: fieldContent } = this.buildAccordion(`mpm_field_${node.id}`, 'Scalar Field & Colormapping');
        if (fieldContent) {
            const table = document.createElement('table');
            table.className = 'property-table';

            const quantities = ['vonMises', 'plastic_strain', 'damage', 'velocity', 'density', 'pressure', 'energy', 'cluster_id', 'failure_flag'];
            const curQty = p.mpmParticleQuantity || 'vonMises';
            table.appendChild(this.createTableRow('Visualized Quantity', this.createDropdown(quantities, curQty, (val) => {
                this.updateDisplayParam(node, 'mpmParticleQuantity', val);
            })));

            const colormaps = ['rainbow', 'viridis', 'plasma', 'turbo', 'jet', 'coolwarm', 'inferno', 'cividis', 'grayscale'];
            const curCmap = p.mpmParticleColormap || 'rainbow';
            table.appendChild(this.createTableRow('Colormap Palette', this.createDropdown(colormaps, curCmap, (val) => {
                this.updateDisplayParam(node, 'mpmParticleColormap', val);
            })));

            const autoRange = p.mpmParticleAutoScale !== false;
            table.appendChild(this.createTableRow('Auto Dynamic Range', this.createCheckbox(autoRange, (val) => {
                this.updateDisplayParam(node, 'mpmParticleAutoScale', val);
            })));

            table.appendChild(this.createTableRow('Min Scalar Value', this.createNumberInput(p.mpmParticleMinVal !== undefined ? Number(p.mpmParticleMinVal) : 0, (val) => {
                this.updateDisplayParam(node, 'mpmParticleMinVal', val);
            })));
            table.appendChild(this.createTableRow('Max Scalar Value', this.createNumberInput(p.mpmParticleMaxVal !== undefined ? Number(p.mpmParticleMaxVal) : 500000000, (val) => {
                this.updateDisplayParam(node, 'mpmParticleMaxVal', val);
            })));

            const logScale = p.mpmParticleLogScale === true;
            table.appendChild(this.createTableRow('Logarithmic Scale', this.createCheckbox(logScale, (val) => {
                this.updateDisplayParam(node, 'mpmParticleLogScale', val);
            })));

            const showCbar = p.mpmParticleShowColorbar !== false;
            table.appendChild(this.createTableRow('Show Colorbar Legend', this.createCheckbox(showCbar, (val) => {
                this.updateDisplayParam(node, 'mpmParticleShowColorbar', val);
            })));

            const state = this.stateManager.getCurrentState();
            const mpmCounts = resolveMPMCounts(node, state ?? undefined);
            table.appendChild(this.createStatRow('Visualized Particles', `~${mpmCounts.estParticles?.toLocaleString()} pts`, '#c084fc'));

            fieldContent.appendChild(table);
        }
        container.appendChild(fieldAcc);
    }

    private renderFEMDisplay(container: HTMLElement, node: Node): void {
        const vpNode = this.getActiveViewportNode(node);
        const p = { ...vpNode?.parameters, ...node.parameters };

        // Accordion 1: Representation
        const { accordion: visAcc, content: visContent } = this.buildAccordion(`fem_vis_${node.id}`, 'FEM Structural Mesh Representation');
        if (visContent) {
            const table = document.createElement('table');
            table.className = 'property-table';

            const isVisible = p.showFEMMesh !== false;
            table.appendChild(this.createTableRow('Active in Viewport', this.createCheckbox(isVisible, (val) => {
                this.updateDisplayParam(node, 'showFEMMesh', val);
            })));

            const solid = p.femSolid !== false;
            table.appendChild(this.createTableRow('Solid Element Faces', this.createCheckbox(solid, (val) => {
                this.updateDisplayParam(node, 'femSolid', val);
            })));

            const wireframe = p.femWireframe !== false;
            table.appendChild(this.createTableRow('Wireframe Mesh Edges', this.createCheckbox(wireframe, (val) => {
                this.updateDisplayParam(node, 'femWireframe', val);
            })));

            const lighting = p.femLighting !== false;
            table.appendChild(this.createTableRow('Direct Surface Lighting', this.createCheckbox(lighting, (val) => {
                this.updateDisplayParam(node, 'femLighting', val);
            })));

            const opacity = p.femOpacity !== undefined ? Number(p.femOpacity) : 1.0;
            table.appendChild(this.createTableRow('Mesh Opacity', this.createSlider(0.0, 1.0, 0.05, opacity, (val) => {
                this.updateDisplayParam(node, 'femOpacity', val);
            })));

            visContent.appendChild(table);
        }
        container.appendChild(visAcc);

        // Accordion 2: Scalar Field & Colormapping
        const { accordion: fieldAcc, content: fieldContent } = this.buildAccordion(`fem_field_${node.id}`, 'Structural Field & Colormapping');
        if (fieldContent) {
            const table = document.createElement('table');
            table.className = 'property-table';

            const quantities = ['vonMises', 'plastic_strain', 'damage', 'displacement', 'velocity', 'pressure', 'density', 'energy', 'failure_flag'];
            const curQty = p.femQuantity || 'vonMises';
            table.appendChild(this.createTableRow('Visualized Quantity', this.createDropdown(quantities, curQty, (val) => {
                this.updateDisplayParam(node, 'femQuantity', val);
            })));

            const colormaps = ['rainbow', 'viridis', 'plasma', 'turbo', 'jet', 'coolwarm', 'inferno', 'cividis', 'grayscale'];
            const curCmap = p.femColormap || 'rainbow';
            table.appendChild(this.createTableRow('Colormap Palette', this.createDropdown(colormaps, curCmap, (val) => {
                this.updateDisplayParam(node, 'femColormap', val);
            })));

            const autoRange = p.femAutoScale !== false;
            table.appendChild(this.createTableRow('Auto Dynamic Range', this.createCheckbox(autoRange, (val) => {
                this.updateDisplayParam(node, 'femAutoScale', val);
            })));

            table.appendChild(this.createTableRow('Min Scalar Value', this.createNumberInput(p.femMinVal !== undefined ? Number(p.femMinVal) : 0, (val) => {
                this.updateDisplayParam(node, 'femMinVal', val);
            })));
            table.appendChild(this.createTableRow('Max Scalar Value', this.createNumberInput(p.femMaxVal !== undefined ? Number(p.femMaxVal) : 500000000, (val) => {
                this.updateDisplayParam(node, 'femMaxVal', val);
            })));

            const logScale = p.femLogScale === true;
            table.appendChild(this.createTableRow('Logarithmic Scale', this.createCheckbox(logScale, (val) => {
                this.updateDisplayParam(node, 'femLogScale', val);
            })));

            const showCbar = p.femShowColorbar !== false;
            table.appendChild(this.createTableRow('Show Colorbar Legend', this.createCheckbox(showCbar, (val) => {
                this.updateDisplayParam(node, 'femShowColorbar', val);
            })));

            const state = this.stateManager.getCurrentState();
            const femCounts = resolveFEMCounts(node, state ?? undefined);
            table.appendChild(this.createStatRow('Visualized Elements', `${femCounts.numElements.toLocaleString()} Hex8`, '#4ade80'));

            fieldContent.appendChild(table);
        }
        container.appendChild(fieldAcc);
    }

    private renderFEMBeamDisplay(container: HTMLElement, node: Node): void {
        const vpNode = this.getActiveViewportNode(node);
        const p = { ...vpNode?.parameters, ...node.parameters };

        const { accordion: visAcc, content: visContent } = this.buildAccordion(`beam_vis_${node.id}`, 'Structural Beam Framework');
        if (visContent) {
            const table = document.createElement('table');
            table.className = 'property-table';

            const isVisible = p.showBeams !== false;
            table.appendChild(this.createTableRow('Active in Viewport', this.createCheckbox(isVisible, (val) => {
                this.updateDisplayParam(node, 'showBeams', val);
            })));

            const solid = p.beamSolid !== false;
            table.appendChild(this.createTableRow('Solid 3D Tubes', this.createCheckbox(solid, (val) => {
                this.updateDisplayParam(node, 'beamSolid', val);
            })));

            const wireframe = p.beamWireframe !== false;
            table.appendChild(this.createTableRow('Centerline Wireframe', this.createCheckbox(wireframe, (val) => {
                this.updateDisplayParam(node, 'beamWireframe', val);
            })));

            const rad = p.beamRadius !== undefined ? Number(p.beamRadius) : 0.008;
            table.appendChild(this.createTableRow('Tube Radius [m]', this.createPrecisionFloatInput(rad, 0.001, 0.2, 0.001, (val) => {
                this.updateDisplayParam(node, 'beamRadius', val);
            })));

            const opacity = p.beamOpacity !== undefined ? Number(p.beamOpacity) : 1.0;
            table.appendChild(this.createTableRow('Beam Opacity', this.createSlider(0.0, 1.0, 0.05, opacity, (val) => {
                this.updateDisplayParam(node, 'beamOpacity', val);
            })));

            const quantities = ['plasticStrain', 'axialForce', 'bendingMoment', 'vonMises'];
            const curQty = p.beamQuantity || 'plasticStrain';
            table.appendChild(this.createTableRow('Visualized Quantity', this.createDropdown(quantities, curQty, (val) => {
                this.updateDisplayParam(node, 'beamQuantity', val);
            })));

            const colormaps = ['rainbow', 'viridis', 'plasma', 'turbo', 'jet', 'coolwarm', 'inferno', 'cividis', 'grayscale'];
            const curCmap = p.beamColormap || 'rainbow';
            table.appendChild(this.createTableRow('Colormap Palette', this.createDropdown(colormaps, curCmap, (val) => {
                this.updateDisplayParam(node, 'beamColormap', val);
            })));

            visContent.appendChild(table);
        }
        container.appendChild(visAcc);
    }

    private renderFEMRebarDisplay(container: HTMLElement, node: Node): void {
        const vpNode = this.getActiveViewportNode(node);
        const p = { ...vpNode?.parameters, ...node.parameters };

        const { accordion: visAcc, content: visContent } = this.buildAccordion(`rebar_vis_${node.id}`, 'Embedded Rebar Strands');
        if (visContent) {
            const table = document.createElement('table');
            table.className = 'property-table';

            const isVisible = p.showRebar !== false;
            table.appendChild(this.createTableRow('Active in Viewport', this.createCheckbox(isVisible, (val) => {
                this.updateDisplayParam(node, 'showRebar', val);
            })));

            const solid = p.rebarSolid !== false;
            table.appendChild(this.createTableRow('Solid 3D Strands', this.createCheckbox(solid, (val) => {
                this.updateDisplayParam(node, 'rebarSolid', val);
            })));

            const wireframe = p.rebarWireframe !== false;
            table.appendChild(this.createTableRow('Centerline Wireframe', this.createCheckbox(wireframe, (val) => {
                this.updateDisplayParam(node, 'rebarWireframe', val);
            })));

            const rad = p.rebarRadius !== undefined ? Number(p.rebarRadius) : 0.008;
            table.appendChild(this.createTableRow('Strand Radius [m]', this.createPrecisionFloatInput(rad, 0.001, 0.1, 0.001, (val) => {
                this.updateDisplayParam(node, 'rebarRadius', val);
            })));

            const opacity = p.rebarOpacity !== undefined ? Number(p.rebarOpacity) : 1.0;
            table.appendChild(this.createTableRow('Rebar Opacity', this.createSlider(0.0, 1.0, 0.05, opacity, (val) => {
                this.updateDisplayParam(node, 'rebarOpacity', val);
            })));

            visContent.appendChild(table);
        }
        container.appendChild(visAcc);
    }

    private renderSTLDisplay(container: HTMLElement, node: Node): void {
        const vpNode = this.getActiveViewportNode(node);
        const p = { ...vpNode?.parameters, ...node.parameters };

        // Accordion 1: Geometry & Shading
        const { accordion: visAcc, content: visContent } = this.buildAccordion(`stl_vis_${node.id}`, 'CAD Geometry & Shading');
        if (visContent) {
            const table = document.createElement('table');
            table.className = 'property-table';

            const isVisible = p.show_stl !== false && p.showSTL !== false;
            table.appendChild(this.createTableRow('Active in Viewport', this.createCheckbox(isVisible, (val) => {
                this.updateDisplayParam(node, 'show_stl', val);
                this.updateDisplayParam(node, 'showSTL', val);
            })));

            const solid = p.stl_solids !== false && p.stlSolids !== false;
            table.appendChild(this.createTableRow('Solid CAD Faces', this.createCheckbox(solid, (val) => {
                this.updateDisplayParam(node, 'stl_solids', val);
                this.updateDisplayParam(node, 'stlSolids', val);
            })));

            const wireframe = p.stl_wireframe !== false && p.stlWireframe !== false;
            table.appendChild(this.createTableRow('Facet Wireframe Edges', this.createCheckbox(wireframe, (val) => {
                this.updateDisplayParam(node, 'stl_wireframe', val);
                this.updateDisplayParam(node, 'stlWireframe', val);
            })));

            const lighting = p.stl_lighting !== false && p.stlLighting !== false;
            table.appendChild(this.createTableRow('Direct Surface Lighting', this.createCheckbox(lighting, (val) => {
                this.updateDisplayParam(node, 'stl_lighting', val);
                this.updateDisplayParam(node, 'stlLighting', val);
            })));

            const opacity = p.stl_opacity !== undefined ? Number(p.stl_opacity) : 1.0;
            table.appendChild(this.createTableRow('Geometry Opacity', this.createSlider(0.0, 1.0, 0.05, opacity, (val) => {
                this.updateDisplayParam(node, 'stl_opacity', val);
            })));

            visContent.appendChild(table);
        }
        container.appendChild(visAcc);

        // Accordion 2: CFD Surface Results
        const { accordion: fieldAcc, content: fieldContent } = this.buildAccordion(`stl_field_${node.id}`, 'CFD Surface Sampling & Color Legend');
        if (fieldContent) {
            const table = document.createElement('table');
            table.className = 'property-table';

            const results = p.stl_show_results !== false && p.stlShowResults !== false;
            table.appendChild(this.createTableRow('Surface Results Sampling', this.createCheckbox(results, (val) => {
                this.updateDisplayParam(node, 'stl_show_results', val);
                this.updateDisplayParam(node, 'stlShowResults', val);
            })));

            const quantities = ['pressure', 'overpressure', 'impulse', 'density', 'velocity', 'Mach', 'temperature'];
            const curQty = p.stl_quantity || p.stlQuantity || 'pressure';
            table.appendChild(this.createTableRow('Sampled CFD Quantity', this.createDropdown(quantities, curQty, (val) => {
                this.updateDisplayParam(node, 'stl_quantity', val);
            })));

            const colormaps = ['rainbow', 'viridis', 'plasma', 'turbo', 'jet', 'coolwarm', 'inferno', 'cividis', 'grayscale'];
            const curCmap = p.stl_colormap || p.stlColormap || 'rainbow';
            table.appendChild(this.createTableRow('Colormap Palette', this.createDropdown(colormaps, curCmap, (val) => {
                this.updateDisplayParam(node, 'stl_colormap', val);
            })));

            const autoRange = p.stl_auto_scale !== false && p.stlAutoScale !== false;
            table.appendChild(this.createTableRow('Auto Dynamic Range', this.createCheckbox(autoRange, (val) => {
                this.updateDisplayParam(node, 'stl_auto_scale', val);
            })));

            table.appendChild(this.createTableRow('Min Scalar Value', this.createNumberInput(p.stl_min_val !== undefined ? Number(p.stl_min_val) : 0, (val) => {
                this.updateDisplayParam(node, 'stl_min_val', val);
            })));
            table.appendChild(this.createTableRow('Max Scalar Value', this.createNumberInput(p.stl_max_val !== undefined ? Number(p.stl_max_val) : 1000000, (val) => {
                this.updateDisplayParam(node, 'stl_max_val', val);
            })));

            const logScale = p.stl_log_scale === true || p.stlLogScale === true;
            table.appendChild(this.createTableRow('Logarithmic Scale', this.createCheckbox(logScale, (val) => {
                this.updateDisplayParam(node, 'stl_log_scale', val);
            })));

            const showCbar = p.stl_show_colorbar !== false && p.stlShowColorbar !== false;
            table.appendChild(this.createTableRow('Show Colorbar Legend', this.createCheckbox(showCbar, (val) => {
                this.updateDisplayParam(node, 'stl_show_colorbar', val);
            })));

            const state = this.stateManager.getCurrentState();
            const geomCounts = resolveGeometryCounts(node, state ?? undefined);
            table.appendChild(this.createStatRow('Visualized Triangles', `${(geomCounts.triangleCount ?? 0).toLocaleString()} tris`, '#facc15'));

            fieldContent.appendChild(table);
        }
        container.appendChild(fieldAcc);
    }

    private renderObstacleDisplay(container: HTMLElement, node: Node): void {
        const vpNode = this.getActiveViewportNode(node);
        const p = { ...vpNode?.parameters, ...node.parameters };

        const { accordion: visAcc, content: visContent } = this.buildAccordion(`obs_vis_${node.id}`, 'CSG Obstacle Representation');
        if (visContent) {
            const table = document.createElement('table');
            table.className = 'property-table';

            const isVisible = p.show_obstacles !== false && p.showObstacles !== false;
            table.appendChild(this.createTableRow('Active in Viewport', this.createCheckbox(isVisible, (val) => {
                this.updateDisplayParam(node, 'show_obstacles', val);
                this.updateDisplayParam(node, 'showObstacles', val);
            })));

            const solid = p.obstacles_solid !== false && p.obstaclesSolid !== false;
            table.appendChild(this.createTableRow('Solid Faces', this.createCheckbox(solid, (val) => {
                this.updateDisplayParam(node, 'obstacles_solid', val);
                this.updateDisplayParam(node, 'obstaclesSolid', val);
            })));

            const gridlines = p.obstacles_gridlines !== false && p.obstaclesGridlines !== false;
            table.appendChild(this.createTableRow('Boundary Gridlines', this.createCheckbox(gridlines, (val) => {
                this.updateDisplayParam(node, 'obstacles_gridlines', val);
                this.updateDisplayParam(node, 'obstaclesGridlines', val);
            })));

            const lighting = p.obstacles_lighting !== false && p.obstaclesLighting !== false;
            table.appendChild(this.createTableRow('Direct Surface Lighting', this.createCheckbox(lighting, (val) => {
                this.updateDisplayParam(node, 'obstacles_lighting', val);
                this.updateDisplayParam(node, 'obstaclesLighting', val);
            })));

            const opacity = p.obstacles_opacity !== undefined ? Number(p.obstacles_opacity) : 1.0;
            table.appendChild(this.createTableRow('Obstacle Opacity', this.createSlider(0.0, 1.0, 0.05, opacity, (val) => {
                this.updateDisplayParam(node, 'obstacles_opacity', val);
            })));

            visContent.appendChild(table);
        }
        container.appendChild(visAcc);

        const { accordion: fieldAcc, content: fieldContent } = this.buildAccordion(`obs_field_${node.id}`, 'CFD Pressure Field Sampling');
        if (fieldContent) {
            const table = document.createElement('table');
            table.className = 'property-table';

            const quantities = ['pressure', 'overpressure', 'impulse', 'density', 'velocity'];
            const curQty = p.obstacles_quantity || p.obstaclesQuantity || 'pressure';
            table.appendChild(this.createTableRow('Sampled Field Quantity', this.createDropdown(quantities, curQty, (val) => {
                this.updateDisplayParam(node, 'obstacles_quantity', val);
            })));

            const colormaps = ['rainbow', 'viridis', 'plasma', 'turbo', 'jet', 'coolwarm', 'inferno', 'cividis', 'grayscale'];
            const curCmap = p.obstacles_colormap || p.obstaclesColormap || 'rainbow';
            table.appendChild(this.createTableRow('Colormap Palette', this.createDropdown(colormaps, curCmap, (val) => {
                this.updateDisplayParam(node, 'obstacles_colormap', val);
            })));

            const autoRange = p.obstacles_auto_scale !== false && p.obstaclesAutoScale !== false;
            table.appendChild(this.createTableRow('Auto Dynamic Range', this.createCheckbox(autoRange, (val) => {
                this.updateDisplayParam(node, 'obstacles_auto_scale', val);
            })));

            table.appendChild(this.createTableRow('Min Scalar Value', this.createNumberInput(p.obstacles_min_val !== undefined ? Number(p.obstacles_min_val) : 0, (val) => {
                this.updateDisplayParam(node, 'obstacles_min_val', val);
            })));
            table.appendChild(this.createTableRow('Max Scalar Value', this.createNumberInput(p.obstacles_max_val !== undefined ? Number(p.obstacles_max_val) : 1000000, (val) => {
                this.updateDisplayParam(node, 'obstacles_max_val', val);
            })));

            fieldContent.appendChild(table);
        }
        container.appendChild(fieldAcc);
    }

    private renderChargeDisplay(container: HTMLElement, node: Node): void {
        const vpNode = this.getActiveViewportNode(node);
        const p = { ...vpNode?.parameters, ...node.parameters };

        const { accordion: visAcc, content: visContent } = this.buildAccordion(`charge_vis_${node.id}`, 'Explosive Charge Representation');
        if (visContent) {
            const table = document.createElement('table');
            table.className = 'property-table';

            const isVisible = p.show_charge !== false && p.showCharge !== false;
            table.appendChild(this.createTableRow('Active in Viewport', this.createCheckbox(isVisible, (val) => {
                this.updateDisplayParam(node, 'show_charge', val);
                this.updateDisplayParam(node, 'showCharge', val);
            })));

            const solid = p.charge_solid !== false && p.chargeSolid !== false;
            table.appendChild(this.createTableRow('Solid Volume', this.createCheckbox(solid, (val) => {
                this.updateDisplayParam(node, 'charge_solid', val);
                this.updateDisplayParam(node, 'chargeSolid', val);
            })));

            const wireframe = p.charge_wireframe !== false && p.chargeWireframe !== false;
            table.appendChild(this.createTableRow('Wireframe Outline', this.createCheckbox(wireframe, (val) => {
                this.updateDisplayParam(node, 'charge_wireframe', val);
                this.updateDisplayParam(node, 'chargeWireframe', val);
            })));

            const lighting = p.charge_lighting !== false && p.chargeLighting !== false;
            table.appendChild(this.createTableRow('Direct Surface Lighting', this.createCheckbox(lighting, (val) => {
                this.updateDisplayParam(node, 'charge_lighting', val);
                this.updateDisplayParam(node, 'chargeLighting', val);
            })));

            const opacity = p.charge_opacity !== undefined ? Number(p.charge_opacity) : 0.65;
            table.appendChild(this.createTableRow('Charge Opacity', this.createSlider(0.0, 1.0, 0.05, opacity, (val) => {
                this.updateDisplayParam(node, 'charge_opacity', val);
            })));

            const color = p.charge_color || p.chargeColor || '#ff3d00';
            table.appendChild(this.createTableRow('Color Tint', this.createColorPicker(color, (val) => {
                this.updateDisplayParam(node, 'charge_color', val);
                this.updateDisplayParam(node, 'chargeColor', val);
            })));

            visContent.appendChild(table);
        }
        container.appendChild(visAcc);

        const { accordion: detAcc, content: detContent } = this.buildAccordion(`det_vis_${node.id}`, 'Detonation Points & Probes');
        if (detContent) {
            const table = document.createElement('table');
            table.className = 'property-table';

            const isVisible = (p.show_detonators !== false && p.show_detonator !== false && p.showDetonators !== false);
            table.appendChild(this.createTableRow('Active in Viewport', this.createCheckbox(isVisible, (val) => {
                this.updateDisplayParam(node, 'show_detonators', val);
                this.updateDisplayParam(node, 'show_detonator', val);
            })));

            const solid = (p.detonatorSolid !== false && p.detonators_solid !== false && p.detonator_solid !== false);
            table.appendChild(this.createTableRow('Solid Sphere Markers', this.createCheckbox(solid, (val) => {
                this.updateDisplayParam(node, 'detonatorSolid', val);
                this.updateDisplayParam(node, 'detonator_solid', val);
            })));

            const wireframe = (p.detonatorWireframe !== false && p.detonators_wireframe !== false && p.detonator_wireframe !== false);
            table.appendChild(this.createTableRow('Wireframe Outline', this.createCheckbox(wireframe, (val) => {
                this.updateDisplayParam(node, 'detonatorWireframe', val);
                this.updateDisplayParam(node, 'detonator_wireframe', val);
            })));

            const sz = Number(p.detonatorSize ?? p.detonators_size ?? p.detonator_size ?? 1.0);
            table.appendChild(this.createTableRow('Marker Size', this.createSlider(0.1, 5.0, 0.1, sz, (val) => {
                this.updateDisplayParam(node, 'detonatorSize', val);
                this.updateDisplayParam(node, 'detonators_size', val);
            })));

            detContent.appendChild(table);
        }
        container.appendChild(detAcc);
    }

    private renderDomainMeshDisplay(container: HTMLElement, node: Node): void {
        const vpNode = this.getActiveViewportNode(node);
        const p = { ...vpNode?.parameters, ...node.parameters };

        const { accordion: visAcc, content: visContent } = this.buildAccordion(`mesh_vis_${node.id}`, 'Computational Grid & Bounds');
        if (visContent) {
            const table = document.createElement('table');
            table.className = 'property-table';

            const isGrid = p.show_grid !== false && p.showGrid !== false;
            table.appendChild(this.createTableRow('Computational Gridlines', this.createCheckbox(isGrid, (val) => {
                this.updateDisplayParam(node, 'show_grid', val);
                this.updateDisplayParam(node, 'showGrid', val);
            })));

            const isBox = p.show_grid_box !== false && p.showGridBox !== false;
            table.appendChild(this.createTableRow('Domain Bounding Box', this.createCheckbox(isBox, (val) => {
                this.updateDisplayParam(node, 'show_grid_box', val);
                this.updateDisplayParam(node, 'showGridBox', val);
            })));

            const cellEdges = p.grid_meshlines === true || p.cell_edges === true;
            table.appendChild(this.createTableRow('Grid Cell Edges', this.createCheckbox(cellEdges, (val) => {
                this.updateDisplayParam(node, 'grid_meshlines', val);
                this.updateDisplayParam(node, 'cell_edges', val);
            })));

            const op = p.grid_opacity !== undefined ? Number(p.grid_opacity) : 1.0;
            table.appendChild(this.createTableRow('Grid Opacity', this.createSlider(0.0, 1.0, 0.05, op, (val) => {
                this.updateDisplayParam(node, 'grid_opacity', val);
            })));

            const state = this.stateManager.getCurrentState();
            const meshCounts = resolveMeshCounts(node, state ?? undefined);
            table.appendChild(this.createStatRow('Visualized Grid Cells', `${meshCounts.totalCells.toLocaleString()} cells`, '#38bdf8'));

            visContent.appendChild(table);
        }
        container.appendChild(visAcc);

        this.renderSlicesOverviewSection(container, node);
    }

    private renderVirtualGaugesDisplay(container: HTMLElement, node: Node): void {
        const vpNode = this.getActiveViewportNode(node);
        const p = { ...vpNode?.parameters, ...node.parameters };

        const { accordion: visAcc, content: visContent } = this.buildAccordion(`gauge_vis_${node.id}`, 'Virtual Gauges & Overlays');
        if (visContent) {
            const table = document.createElement('table');
            table.className = 'property-table';

            const isVisible = p.show_gauges !== false && p.showGauges !== false;
            table.appendChild(this.createTableRow('Active in Viewport', this.createCheckbox(isVisible, (val) => {
                this.updateDisplayParam(node, 'show_gauges', val);
                this.updateDisplayParam(node, 'showGauges', val);
            })));

            const solid = p.gauge_solid !== false && p.gaugeSolid !== false;
            table.appendChild(this.createTableRow('Solid Sphere Markers', this.createCheckbox(solid, (val) => {
                this.updateDisplayParam(node, 'gauge_solid', val);
                this.updateDisplayParam(node, 'gaugeSolid', val);
            })));

            const sz = Number(p.gauge_size ?? p.gaugeSize ?? 1.0);
            table.appendChild(this.createTableRow('Marker Size', this.createSlider(0.1, 5.0, 0.1, sz, (val) => {
                this.updateDisplayParam(node, 'gauge_size', val);
            })));

            const op = Number(p.gauge_opacity ?? p.gaugeOpacity ?? 1.0);
            table.appendChild(this.createTableRow('Marker Opacity', this.createSlider(0.0, 1.0, 0.05, op, (val) => {
                this.updateDisplayParam(node, 'gauge_opacity', val);
            })));

            const quantities = ['pressure', 'overpressure', 'impulse', 'density', 'velocity_magnitude'];
            const curQty = p.gauge_quantity || p.gaugeQuantity || 'pressure';
            table.appendChild(this.createTableRow('Monitored Quantity', this.createDropdown(quantities, curQty, (val) => {
                this.updateDisplayParam(node, 'gauge_quantity', val);
            })));

            visContent.appendChild(table);
        }
        container.appendChild(visAcc);
    }

    private renderGenericDisplay(container: HTMLElement, node: Node): void {
        const { accordion: visAcc, content: visContent } = this.buildAccordion(`generic_vis_${node.id}`, 'Viewport Representation & Visuals');
        if (visContent) {
            const table = document.createElement('table');
            table.className = 'property-table';

            const isVisible = node.parameters.visible !== false && !node.parameters.hidden;
            table.appendChild(this.createTableRow('Visibility', this.createCheckbox(isVisible, (val) => {
                this.updateDisplayParam(node, 'visible', val);
                this.updateDisplayParam(node, 'hidden', !val);
            })));

            const repModes = ['Surface', 'Surface With Edges', 'Wireframe', 'Points', 'Volume Rendering', 'Particle Spheres'];
            const currentRep = node.parameters.representation_mode || 'Surface';
            table.appendChild(this.createTableRow('Representation', this.createDropdown(repModes, currentRep, (val) => {
                this.updateDisplayParam(node, 'representation_mode', val);
            })));

            const currentOpacity = node.parameters.opacity !== undefined ? Number(node.parameters.opacity) : 1.0;
            table.appendChild(this.createTableRow('Opacity', this.createSlider(0.0, 1.0, 0.05, currentOpacity, (val) => {
                this.updateDisplayParam(node, 'opacity', val);
            })));

            const colormaps = ['rainbow', 'viridis', 'plasma', 'turbo', 'jet', 'coolwarm', 'inferno', 'cividis', 'grayscale'];
            const currentCmap = node.parameters.colormap || 'rainbow';
            table.appendChild(this.createTableRow('Colormap', this.createDropdown(colormaps, currentCmap, (val) => {
                this.updateDisplayParam(node, 'colormap', val);
            })));

            const autoRange = node.parameters.auto_range !== false;
            table.appendChild(this.createTableRow('Auto Scalar Range', this.createCheckbox(autoRange, (val) => {
                this.updateDisplayParam(node, 'auto_range', val);
            })));

            visContent.appendChild(table);
        }
        container.appendChild(visAcc);
    }

    private createStatRow(label: string, valueText: string, highlightColor: string = '#38bdf8'): HTMLTableRowElement {
        const row = document.createElement('tr');
        row.className = 'property-row property-stat-row';
        const labelCell = document.createElement('td');
        labelCell.className = 'property-label-cell';
        labelCell.innerHTML = `<span class="property-label-text" style="color: #94a3b8; font-weight: 500;">${label}</span>`;

        const valCell = document.createElement('td');
        valCell.className = 'property-value-cell';
        valCell.innerHTML = `<span style="font-family: 'JetBrains Mono', monospace; font-size: 10px; color: ${highlightColor}; font-weight: 600;">${valueText}</span>`;

        row.appendChild(labelCell);
        row.appendChild(valCell);
        return row;
    }

    private createAccordion(
        groupId: string,
        title: string,
        params: { key: string; value: any; label?: string }[],
        node: Node
    ): HTMLElement {
        const accordion = document.createElement('div');
        const isCollapsed = this.collapsedAccordions.has(groupId);
        accordion.className = `property-accordion ${isCollapsed ? 'collapsed' : 'open'}`;

        const header = document.createElement('div');
        header.className = 'accordion-header';
        header.innerHTML = `
            <span class="accordion-caret">${isCollapsed ? '▶' : '▼'}</span>
            <span class="accordion-title">${title}</span>
            <span class="accordion-count">(${params.length})</span>
        `;
        header.addEventListener('click', () => {
            if (this.collapsedAccordions.has(groupId)) {
                this.collapsedAccordions.delete(groupId);
            } else {
                this.collapsedAccordions.add(groupId);
            }
            this.render(true);
        });

        accordion.appendChild(header);

        if (!isCollapsed) {
            const content = document.createElement('div');
            content.className = 'accordion-content';

            const table = document.createElement('table');
            table.className = 'property-table';

            const state = this.stateManager.getCurrentState();

            // Inject contextual discretization metrics at the top of specific parameter groups
            if (groupId === 'mesh_geom') {
                const meshCounts = resolveMeshCounts(node, state ?? undefined);
                if (meshCounts.dimension === '1D') {
                    table.appendChild(this.createStatRow('Calculated 1D Cells', `${meshCounts.n_cells.toLocaleString()} cells`, '#38bdf8'));
                } else if (meshCounts.dimension === '2D') {
                    table.appendChild(this.createStatRow('Calculated 2D Grid', `${meshCounts.nr} × ${meshCounts.nz} cells`, '#38bdf8'));
                    table.appendChild(this.createStatRow('Total Grid Cells', `${meshCounts.totalCells.toLocaleString()} cells`, '#38bdf8'));
                } else if (meshCounts.dimension === '3D') {
                    table.appendChild(this.createStatRow('Calculated 3D Grid', `${meshCounts.nx} × ${meshCounts.ny} × ${meshCounts.nz} cells`, '#38bdf8'));
                    table.appendChild(this.createStatRow('Total Grid Cells', `${meshCounts.totalCells.toLocaleString()} cells`, '#38bdf8'));
                    table.appendChild(this.createStatRow('Domain Bounds Box', `${(meshCounts.dim_x ?? 1).toFixed(3)} × ${(meshCounts.dim_y ?? 1).toFixed(3)} × ${(meshCounts.dim_z ?? 1).toFixed(3)} m`, '#cbd5e1'));
                    table.appendChild(this.createStatRow('Domain Volume', `${(meshCounts.volume ?? 0).toFixed(4)} m³`, '#cbd5e1'));
                }
            } else if (groupId === 'cfd_numerics') {
                const meshCounts = resolveMeshCounts(node, state ?? undefined);
                if (meshCounts.totalCells > 0) {
                    table.appendChild(this.createStatRow('Eulerian Background Grid', `${meshCounts.totalCells.toLocaleString()} cells (${meshCounts.dimension})`, '#38bdf8'));
                }
            } else if (groupId === 'mpm_seeding' || groupId === 'mpm_geom') {
                if (groupId === 'mpm_seeding') {
                    const mpmCounts = resolveMPMCounts(node, state ?? undefined);
                    table.appendChild(this.createStatRow('Discretized Particles', `${mpmCounts.estParticles?.toLocaleString()} pts (PPC = ${mpmCounts.ppc})`, '#c084fc'));
                    table.appendChild(this.createStatRow('Particle Grid Spacing', `${((mpmCounts.p_dx ?? 0.01) * 1000).toFixed(2)} mm`, '#4ec9b0'));
                    table.appendChild(this.createStatRow('Particle Memory', `RAM ${(mpmCounts.ramMB ?? 0).toFixed(2)} MB · VRAM ${(mpmCounts.vramMB ?? 0).toFixed(2)} MB`, '#38bdf8'));
                    if (mpmCounts.shapeType === 'STL' && mpmCounts.stlMeta) {
                        table.appendChild(this.createStatRow('STL Triangle Count', `${mpmCounts.stlMeta.triangleCount.toLocaleString()} tris`, '#facc15'));
                    }
                }
            } else if (groupId === 'mpm_numerics') {
                const mpmCounts = resolveMPMCounts(node, state ?? undefined);
                table.appendChild(this.createStatRow('Connected MPM Bodies', `${mpmCounts.objCount} objects`, '#c084fc'));
                table.appendChild(this.createStatRow('Total Active Particles', `${(mpmCounts.connectedParticles ?? 0).toLocaleString()} particles`, '#c084fc'));
                table.appendChild(this.createStatRow('Est. Particle VRAM', `${(mpmCounts.totalVramMB ?? 0).toFixed(2)} MB`, '#38bdf8'));
            } else if (groupId === 'fem_geom') {
                const femCounts = resolveFEMCounts(node, state ?? undefined);
                table.appendChild(this.createStatRow('Discretized Solid Elements', `${femCounts.numElements.toLocaleString()} Hex8`, '#4ade80'));
                table.appendChild(this.createStatRow('Structural Nodal Points', `${femCounts.numNodes.toLocaleString()} nodes`, '#4ade80'));
                table.appendChild(this.createStatRow('Hex Element Dimensions', `${((femCounts.dx ?? 0.01) * 1000).toFixed(2)} × ${((femCounts.dy ?? 0.01) * 1000).toFixed(2)} × ${((femCounts.dz ?? 0.01) * 1000).toFixed(2)} mm`, '#38bdf8'));
                table.appendChild(this.createStatRow('Discretized Body Volume', `${(femCounts.volume ?? 0).toFixed(6)} m³`, '#cbd5e1'));
                table.appendChild(this.createStatRow('Est. FEM VRAM Footprint', `${(femCounts.vramMB ?? 0).toFixed(2)} MB`, '#38bdf8'));
            } else if (groupId === 'fem_numerics' || groupId === 'fem_damage') {
                const femCounts = resolveFEMCounts(node, state ?? undefined);
                if (groupId === 'fem_numerics') {
                    table.appendChild(this.createStatRow('Connected Structural Bodies', `${femCounts.objCount} bodies`, '#4ade80'));
                    table.appendChild(this.createStatRow('Total Solid Hex8 Elements', `${femCounts.totalElements.toLocaleString()} elements`, '#4ade80'));
                    table.appendChild(this.createStatRow('Estimated Total Nodes', `~${femCounts.totalNodes.toLocaleString()} nodes`, '#4ade80'));
                    table.appendChild(this.createStatRow('Est. Total FEM VRAM', `${(femCounts.totalVramMB ?? 0).toFixed(2)} MB`, '#38bdf8'));
                } else if (groupId === 'fem_damage' && femCounts.convertToMpm) {
                    table.appendChild(this.createStatRow('Potential Debris Particles', `${femCounts.maxDebrisParticles.toLocaleString()} particles (${femCounts.mpmParticlesPerElem} pts/elem)`, '#eab308'));
                }
            } else if (groupId === 'dyna_import') {
                const femCounts = resolveFEMCounts(node, state ?? undefined);
                table.appendChild(this.createStatRow('Keyword Mesh Elements', `~${femCounts.totalElements.toLocaleString()} elements`, '#4ade80'));
                table.appendChild(this.createStatRow('Keyword Nodal Points', `~${femCounts.totalNodes.toLocaleString()} nodes`, '#4ade80'));
            } else if (groupId === 'stl_import') {
                const geomCounts = resolveGeometryCounts(node, state ?? undefined);
                table.appendChild(this.createStatRow('Surface Triangles', `${(geomCounts.triangleCount ?? 0).toLocaleString()} tris`, '#facc15'));
                table.appendChild(this.createStatRow('Watertight Volume', `${((geomCounts.volume ?? 0.001) * 1e6).toFixed(2)} cm³`, '#facc15'));
            } else if (groupId === 'primitive_geom') {
                const geomCounts = resolveGeometryCounts(node, state ?? undefined);
                table.appendChild(this.createStatRow('Total Primitives', `${geomCounts.count} shapes`, '#facc15'));
                table.appendChild(this.createStatRow('Shapes Breakdown', `${geomCounts.boxes ?? 0} Boxes · ${geomCounts.spheres ?? 0} Spheres · ${geomCounts.cylinders ?? 0} Cylinders`, '#cbd5e1'));
            } else if (groupId === 'fsi_numerics' || groupId === 'fsi_structure') {
                const cCounts = resolveCouplerCounts(node, state ?? undefined);
                table.appendChild(this.createStatRow('Coupled Fluid Grid', `${cCounts.fluidCells.toLocaleString()} Eulerian cells`, '#38bdf8'));
                if (node.type === 'FEMFSICoupler3D') {
                    table.appendChild(this.createStatRow('Coupled Solid Structure', `${cCounts.solidElements.toLocaleString()} Hex8 elements`, '#4ade80'));
                } else {
                    table.appendChild(this.createStatRow('Coupled Solid Structure', `${cCounts.solidParticles.toLocaleString()} MPM particles`, '#c084fc'));
                }
            } else if (groupId === 'gauges_config') {
                const tCounts = resolveTelemetryCounts(node, state ?? undefined);
                table.appendChild(this.createStatRow('Active Sensor Probes', `${tCounts.gaugeCount ?? 0} probe points`, '#fb923c'));
                table.appendChild(this.createStatRow('Monitored Quantities', `${tCounts.activeFieldsCount ?? 0} physical fields`, '#fb923c'));
            } else if (groupId === 'vtk_domains') {
                const tCounts = resolveTelemetryCounts(node, state ?? undefined);
                table.appendChild(this.createStatRow('Active Export Domains', `${(tCounts.exportDomains ?? []).join(', ') || 'None'}`, '#fb923c'));
            } else if (groupId === 'vp_mpm') {
                let totalMpm = 0;
                state?.nodes.filter(n => n.type === 'MPMObject3D' || n.type === 'MPMObject2D').forEach(n => {
                    const m = resolveMPMCounts(n, state);
                    totalMpm += m.estParticles ?? 0;
                });
                table.appendChild(this.createStatRow('Discretized Particles in Model', `${totalMpm.toLocaleString()} particles`, '#c084fc'));
            } else if (groupId === 'vp_fem') {
                let totalFem = 0;
                state?.nodes.filter(n => n.type === 'FEMObject3D').forEach(n => {
                    const f = resolveFEMCounts(n, state);
                    totalFem += f.numElements;
                });
                table.appendChild(this.createStatRow('Structural Elements in Model', `${totalFem.toLocaleString()} Hex8 elements`, '#4ade80'));
            }

            for (const param of params) {
                const widget = this.createWidgetForParam(node, param.key, param.value);
                const info = getParameterInfo(param.key, node.type);
                const labelText = info?.label || param.label || this.formatKeyToLabel(param.key);
                
                const row = this.createTableRow(labelText, widget, param.key, node.type, info?.unit);
                table.appendChild(row);
            }

            content.appendChild(table);
            accordion.appendChild(content);
        }

        return accordion;
    }

    private createTableRow(
        label: string,
        widget: HTMLElement,
        paramKey?: string,
        nodeType?: NodeType,
        unit?: string
    ): HTMLTableRowElement {
        const row = document.createElement('tr');
        row.className = 'property-row';

        const labelCell = document.createElement('td');
        labelCell.className = 'property-label-cell';

        const labelSpan = document.createElement('span');
        labelSpan.className = 'property-label-text';
        labelSpan.textContent = label;

        labelCell.appendChild(labelSpan);

        if (unit) {
            const unitSpan = document.createElement('span');
            unitSpan.className = 'property-unit-badge';
            unitSpan.textContent = `[${unit}]`;
            labelCell.appendChild(unitSpan);
        }

        if (paramKey && nodeType) {
            const popoverBtn = document.createElement('button');
            popoverBtn.className = 'property-info-icon';
            popoverBtn.textContent = '?';
            popoverBtn.title = 'Parameter definition & physics help';
            popoverBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showParameterPopover(popoverBtn, paramKey, nodeType, e);
            });
            labelCell.appendChild(popoverBtn);
        }
        const valueCell = document.createElement('td');
        valueCell.className = 'property-value-cell';
        valueCell.appendChild(widget);

        row.appendChild(labelCell);
        row.appendChild(valueCell);
        return row;
    }

    private createWidgetForParam(node: Node, key: string, value: any): HTMLElement {
        if (key === 'material') {
            const state = this.stateManager.getCurrentState();
            const owningModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
            const candidateNodes = owningModel ? owningModel.nodes : (state ? state.nodes : []);
            const matNodes = getCompatibleMaterialsForNode(node, candidateNodes);
            const select = document.createElement('select');
            select.className = 'property-select';
            select.id = `param-input-${node.id}-${key}`;

            const defOption = document.createElement('option');
            defOption.value = '';
            defOption.textContent = '(None / Disconnected)';
            select.appendChild(defOption);

            // Determine currently connected material node id
            let currentMatId = node.parameters['material'] || '';
            if (!currentMatId && state) {
                const conn = state.connections.find(c => (c.toNode === node.id && c.toPort === 'material') || (c.fromNode === node.id && c.fromPort === 'material'));
                if (conn) {
                    currentMatId = conn.toNode === node.id ? conn.fromNode : conn.toNode;
                }
            }

            matNodes.forEach(mat => {
                const opt = document.createElement('option');
                opt.value = mat.id;
                const matSummary = mat.parameters.preset || mat.parameters.composition || mat.parameters.material_type || mat.parameters.material_model || 'Material';
                opt.textContent = `${(mat as any).name || mat.parameters?.name || mat.type} [${mat.id.substring(0, 8)}] (${matSummary})`;
                if (mat.id === currentMatId) opt.selected = true;
                select.appendChild(opt);
            });

            select.addEventListener('change', () => {
                const newMatId = select.value;
                this.updateNodeParam(node, 'material', newMatId);
                this.syncMaterialConnection(node.id, newMatId);
            });

            return select;
        }

        const matType = node.parameters['material_type'];
        let currentMatModel = node.parameters['material_model'];
        if (matType === 'JWL Charge') {
            currentMatModel = 'JWL Detonation Gas';
        } else if (matType === 'Ideal Gas Charge') {
            currentMatModel = 'Ideal Gas Charge';
        } else if (matType === 'Air') {
            currentMatModel = 'Ideal Gas';
        } else if (!currentMatModel) {
            currentMatModel = 'Hypoelastic';
        }
        const dynamicPresets = (node.type === 'Material') 
            ? getPresetsForConstitutiveModel(currentMatModel) 
            : [...MPM_MATERIAL_PRESET_NAMES];

        const dropdowns: Record<string, string[]> = {
            'preset': dynamicPresets,
            'material_model': getConstitutiveModels(),
            'fragment_distribution': ['Rosin-Rammler', 'Mott-Grady', 'Lognormal', 'Monodisperse'],
            'rebar_formulation': ['TimoshenkoBeam3D', 'AxialTruss1D'],
            'beam_formulation': ['TimoshenkoBeam3D', 'AxialTruss1D'],
            'beamQuantity': ['plasticStrain', 'vonMises', 'momentOrForce', 'velocity', 'damage'],
            'beamColormap': ['rainbow', 'plasma', 'viridis', 'turbo', 'coolwarm', 'cividis', 'grayscale'],
            'mpmParticleQuantity': ['vonMises', 'plastic_strain', 'damage', 'cluster_id', 'pressure', 'velocity', 'density', 'has_failed', 'object_id'],
            'mpmParticleColormap': ['rainbow', 'plasma', 'viridis', 'turbo', 'coolwarm', 'cividis', 'grayscale'],
            'femQuantity': ['vonMises', 'plasticStrain', 'pressure', 'velocity', 'damage'],
            'femColormap': ['rainbow', 'plasma', 'viridis', 'turbo', 'coolwarm', 'cividis', 'grayscale'],
            'coupling_scheme': ['Two-Way Staggered', 'Sub-Cycling'],
            'pressure_integration': ['2x2 Gauss Quadrature', '1-Point Centroid'],
            'uncovering_method': ['Conservative IDW + Vacuum Cavity', 'Ghost-Fluid Standard'],
            'telemetry_mode': ['Enabled', 'Throttled (1 Hz)', 'Throttled (0.2 Hz)', 'Disabled'],
            'enable_gauges': ['Enabled', 'Disabled'],
            'enable_vtk': ['Disabled', 'Enabled'],
            'shape': ['box', 'sphere', 'cylinder'],
            'mesh_type': ['regular', 'amr'],
            'amr_tile_size': ['8', '16'],
            'dimension': ['1D', '2D', '3D'],
            'x_min_bc': ['Reflecting', 'Transmitting', 'Terminate', 'Periodic', 'Inflow'],
            'x_max_bc': ['Reflecting', 'Transmitting', 'Terminate', 'Periodic', 'Inflow'],
            'y_min_bc': ['Reflecting', 'Transmitting', 'Terminate', 'Periodic', 'Inflow'],
            'y_max_bc': ['Reflecting', 'Transmitting', 'Terminate', 'Periodic', 'Inflow'],
            'z_min_bc': ['Reflecting', 'Transmitting', 'Terminate', 'Periodic', 'Inflow'],
            'z_max_bc': ['Reflecting', 'Transmitting', 'Terminate', 'Periodic', 'Inflow'],
            'left_bc': ['Reflecting', 'Transmitting', 'Terminate', 'Periodic', 'Inflow'],
            'right_bc': ['Reflecting', 'Transmitting', 'Terminate', 'Periodic', 'Inflow'],
            'bc_x_min': ['Reflecting', 'Transmitting', 'Terminate', 'Periodic', 'Inflow'],
            'bc_x_max': ['Reflecting', 'Transmitting', 'Terminate', 'Periodic', 'Inflow'],
            'bc_y_min': ['Reflecting', 'Transmitting', 'Terminate', 'Periodic', 'Inflow'],
            'bc_y_max': ['Reflecting', 'Transmitting', 'Terminate', 'Periodic', 'Inflow'],
            'bc_r_min': ['Reflecting', 'Transmitting', 'Terminate', 'Periodic', 'Inflow'],
            'bc_r_max': ['Reflecting', 'Transmitting', 'Terminate', 'Periodic', 'Inflow'],
            'bc_z_min': ['Reflecting', 'Transmitting', 'Terminate', 'Periodic', 'Inflow'],
            'bc_z_max': ['Reflecting', 'Transmitting', 'Terminate', 'Periodic', 'Inflow'],
            'coordinate_system': ['Axisymmetric', 'Cartesian'],
            'device': ['cuda', 'cpu'],
            'precision': ['single', 'double'],
            'integration_scheme': ['OnePointFB', 'OnePointKF', 'FullGauss8', 'SelectiveReduced'],
            'hourglass_model': ['FlanaganBelytschkoStiffness', 'FlanaganBelytschkoViscous', 'KosloffFrazier'],
            'trigger_type': node.type === 'VTKOutput' ? ['Step Interval', 'Time Interval'] : ['end', 'time', 'step'],
            'composition': ['Aluminized ANFO', 'Ammonal', 'ANFO', 'Baratol', 'C-4', 'Composition A-3', 'Composition B', 'Composition C-3', 'Cyclotol', 'Heavy ANFO', 'HMX', 'LX-04', 'LX-07', 'LX-10', 'LX-14', 'LX-17', 'Mining Emulsion', 'Nitromethane', 'Octol', 'PBX 9404', 'PBX 9501', 'PBX 9502', 'PE-10', 'PE-12', 'PE-4', 'PE-8', 'Pentolite', 'PETN', 'RDX', 'TATB', 'Tetryl', 'TNT', 'Water Gel', 'Custom'],
            'init_mode': node.type === 'CFDSolver3D' ? ['From1D', 'From2D', 'Multi-Material JWL', 'Ideal Gas'] : ['From1D', 'Multi-Material JWL', 'Ideal Gas'],
            'flux_scheme': ['AUSM+', 'Rusanov'],
            'spatial_order': ['1', '2', '3', '5'],
            'temporal_order': ['2', '3', '4'],
            'plot_stride': ['1', '2', '5', '10', '20', '50', '100'],
            'charge_shape': node.type === 'Charge3D' ? ['Sphere', 'Cylinder', 'Block'] : ['Sphere', 'Cylinder'],
            'material_type': ['Air', 'JWL Charge', 'Ideal Gas Charge'],
            'colormap': ['rainbow', 'plasma', 'viridis', 'turbo', 'coolwarm', 'cividis', 'grayscale', 'inferno'],
            'stl_colormap': ['rainbow', 'plasma', 'viridis', 'turbo', 'coolwarm', 'cividis', 'grayscale', 'inferno'],
            'stl_quantity': ['pressure', 'density', 'velocity', 'energy', 'species1', 'species2', 'species3', 'peak_overpressure', 'peak_impulse'],
            'stl_sampling_mode': ['nearest', 'linear'],
            'obstacles_colormap': ['rainbow', 'plasma', 'viridis', 'turbo', 'coolwarm', 'cividis', 'grayscale', 'inferno'],
            'obstacles_quantity': ['pressure', 'density', 'velocity', 'energy', 'species1', 'species2', 'species3', 'peak_overpressure', 'peak_impulse'],
            'gauge_quantity': ['pressure', 'velocity', 'peak_overpressure', 'status'],
            'refresh_rate': ['0.016', '0.033', '0.05', '0.1', '0.2', '0.5', '1.0', '2.0', '5.0', '10.0', '20.0', '50.0', '100.0', '1000.0'],
            'ascii_delimiter': ['Comma', 'Tab', 'Space'],
            'vtk_format': ['ASCII', 'Binary', 'Compressed Binary'],
            'voxelization_method': ['watertight_floodfill', 'watertight_raycast', 'thin_shell', 'winding_number'],
            'colorbar_source': ['slice', 'mpm', 'obstacles', 'stl'],
            'transfer_scheme': (node.type === 'Material') ? 
                ['Default', 'BSpline', 'Radial MLS', 'Cubic BSpline', 'GIMP', 'Standard'] : 
                ['BSpline', 'Radial MLS', 'Cubic BSpline', 'GIMP', 'Standard'],
            'particle_distribution': ['Cartesian', 'Hexagonal'],
            'boundary_filling': ['Stairstepped', 'Partial'],
            'velocity_scheme': ['APIC', 'PIC', 'FLIP'],
            'smooth_plastic_strain': ['Enabled', 'Disabled'],
            'boundary_condition': ['Free', 'Fixed Base', 'Fixed Entire'],
            'shape_type': node.type === 'FEMObject3D' ? ['Box', 'Cylinder', 'LS-DYNA File'] : (node.type === 'MPMObject3D' ? ['Box', 'Sphere', 'Cylinder', 'STL'] : ['Rectangle', 'Circle']),
            'anisotropy_axis': ['X', 'Y', 'Z', 'Custom'],
            'mesh_source': ['Primitive', 'LS-DYNA Importer (*.k)', 'Box Generator'],
            'space_time_scheme': (node.type === 'MPMDomain2D' || node.type === 'MPMDomain3D') ? 
                ['Leapfrog', 'RK2', 'USL', 'USF'] : 
                ['MUSCL-Hancock (2nd-Order Space/Time)', 'ADER-2 (2nd-Order Space/Time)', 'ADER-3 (3rd-Order Space/Time)']
        };

        if (key === 'preset' && node.type === 'Material') {
            const groups = getCategorizedPresetsForModel(currentMatModel);
            return this.createCategorizedDropdown(groups, String(value ?? ''), (val) => {
                this.updateNodeParam(node, key, val);
            });
        }

        if (dropdowns[key]) {
            const options = dropdowns[key];
            let currentStr = String(value ?? '');
            if (key === 'space_time_scheme' && (node.type === 'CFDSolver' || node.type === 'CFDSolver2D' || node.type === 'CFDSolver3D') && !currentStr) {
                const so = Number(node.parameters['spatial_order'] ?? 2);
                const to = Number(node.parameters['temporal_order'] ?? 4);
                if (so === 2 && (to === 5 || to === 2)) currentStr = 'ADER-2 (2nd-Order Space/Time)';
                else if (so === 3 && (to === 6 || to === 3)) currentStr = 'ADER-3 (3rd-Order Space/Time)';
                else currentStr = 'MUSCL-Hancock (2nd-Order Space/Time)';
            }
            return this.createDropdown(options, currentStr, (val) => {
                let castVal: any = val;
                if (NUMERIC_KEYS.has(key)) {
                    const num = Number(val);
                    if (!isNaN(num)) castVal = num;
                }
                this.updateNodeParam(node, key, castVal);
            });
        }

        if (typeof value === 'boolean') {
            return this.createCheckbox(value, (v) => this.updateNodeParam(node, key, v));
        }

        if (typeof value === 'number' || NUMERIC_KEYS.has(key)) {
            const isInt = Number.isInteger(Number(value)) && (key.startsWith('n') || key.includes('order') || key.includes('step') || key.includes('threads') || key === 'amr_tile_size' || key === 'plot_stride');
            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'property-input number-input';
            input.value = String(value ?? 0);
            input.step = isInt ? '1' : 'any';
            const commit = () => {
                const parsed = isInt ? parseInt(input.value, 10) : parseFloat(input.value);
                if (!isNaN(parsed)) {
                    this.updateNodeParam(node, key, parsed);
                }
            };
            input.addEventListener('input', commit);
            input.addEventListener('change', commit);
            input.addEventListener('blur', commit);
            return input;
        }

        // File & Directory path inputs with host file browser dialog
        const isFileOrDir = key === 'stl_file' || key === 'k_file' || key === 'output_dir' || key === 'vtk_dir' || key === 'external_file_path' || key === 'file_path';
        if (isFileOrDir) {
            return this.createFileInputWidget(node, key, value);
        }

        // Generic text input
        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.className = 'property-input text-input';
        textInput.value = String(value ?? '');
        const commitText = () => {
            this.updateNodeParam(node, key, textInput.value);
        };
        textInput.addEventListener('input', commitText);
        textInput.addEventListener('change', commitText);
        textInput.addEventListener('blur', commitText);
        return textInput;
    }

    private createFileInputWidget(node: Node, key: string, value: any): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'property-file-input-wrapper';
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.gap = '4px';
        wrapper.style.width = '100%';

        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.className = 'property-input text-input';
        textInput.value = String(value ?? '');
        textInput.style.flex = '1';
        textInput.style.minWidth = '0';
        textInput.id = `param-input-${node.id}-${key}`;

        const isStl = key === 'stl_file';
        const isK = key === 'k_file';
        const isDir = key === 'output_dir' || key === 'vtk_dir';
        const isExternal = key === 'external_file_path' || key === 'file_path';

        const commitText = () => {
            const val = textInput.value;
            this.updateNodeParam(node, key, val);
            if (isStl) {
                const rand = Math.floor(Math.random() * 1000000);
                const simpleHash = 'stl_' + rand.toString(36);
                this.updateNodeParam(node, 'geometry_hash', simpleHash);
                const net = (window as any).networkManager;
                if (net && net.isConnected()) {
                    const activeWs = this.stateManager.getActiveWorkspace();
                    const modelId = activeWs?.activeModelId || 'default';
                    const activeModel = this.stateManager.getAllModels().find(m => m.id === modelId);
                    const resolvedPath = resolveResourcePath(val, activeModel?.filename);
                    net.send({ command: "LOAD_STL_GEOMETRY", filePath: resolvedPath, modelId });
                }
            } else if (isK) {
                const rand = Math.floor(Math.random() * 1000000);
                const simpleHash = 'k_' + rand.toString(36);
                this.updateNodeParam(node, 'geometry_hash', simpleHash);
            }
            this.updateLiveStats(node);
        };

        textInput.addEventListener('input', () => {
            this.updateNodeParam(node, key, textInput.value);
        });
        textInput.addEventListener('change', commitText);
        textInput.addEventListener('blur', commitText);
        textInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                commitText();
                textInput.blur();
            }
        });

        const browseBtn = document.createElement('button');
        browseBtn.type = 'button';
        browseBtn.className = 'property-file-browse-btn';
        browseBtn.title = isDir ? 'Browse directory on host filesystem...' : 'Browse file on host filesystem...';
        browseBtn.textContent = 'Browse';
        browseBtn.style.padding = '2px 8px';
        browseBtn.style.fontSize = '10px';
        browseBtn.style.fontWeight = '500';
        browseBtn.style.background = '#272a34';
        browseBtn.style.color = '#38bdf8';
        browseBtn.style.border = '1px solid #3b4252';
        browseBtn.style.borderRadius = '3px';
        browseBtn.style.cursor = 'pointer';
        browseBtn.style.whiteSpace = 'nowrap';
        browseBtn.style.flexShrink = '0';
        browseBtn.style.transition = 'all 0.15s ease';

        browseBtn.onmouseenter = () => {
            browseBtn.style.background = '#38bdf8';
            browseBtn.style.color = '#0f172a';
            browseBtn.style.borderColor = '#38bdf8';
        };
        browseBtn.onmouseleave = () => {
            browseBtn.style.background = '#272a34';
            browseBtn.style.color = '#38bdf8';
            browseBtn.style.borderColor = '#3b4252';
        };

        browseBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();

            const startPath = String(node.parameters[key] || '');
            let title = 'Select File (Host)';
            let mode: 'open' | 'save' = 'open';
            let selectFolderOnly = false;
            let filters: FileFilterPreset[] | undefined = undefined;

            if (isStl) {
                title = 'Select STL 3D Geometry (*.stl)';
                mode = 'open';
                filters = [
                    { label: 'STL 3D Geometry (*.stl)', extensions: ['.stl'] },
                    { label: 'All Files (*.*)', extensions: ['*'] }
                ];
            } else if (isK) {
                title = 'Select LS-DYNA Keyword File (*.k, *.key)';
                mode = 'open';
                filters = [
                    { label: 'LS-DYNA Keyword Files (*.k, *.key, *.dyn)', extensions: ['.k', '.key', '.dyn'] },
                    { label: 'All Files (*.*)', extensions: ['*'] }
                ];
            } else if (isDir) {
                title = 'Select Output Directory (Host)';
                mode = 'save';
                selectFolderOnly = true;
            } else if (isExternal) {
                title = 'Select Data/Sensor File (Host)';
                mode = 'open';
                filters = [
                    { label: 'Data / CSV Files (*.dat, *.csv, *.txt)', extensions: ['.dat', '.csv', '.txt'] },
                    { label: 'All Files (*.*)', extensions: ['*'] }
                ];
            }

            const browser = new HostFileBrowserModal(
                (window as any).networkManager,
                {
                    title,
                    mode,
                    selectFolderOnly,
                    filters,
                    onSelect: (selectedPath: string) => {
                        textInput.value = selectedPath;
                        this.updateNodeParam(node, key, selectedPath);
                        if (isStl) {
                            const rand = Math.floor(Math.random() * 1000000);
                            const simpleHash = 'stl_' + rand.toString(36);
                            this.updateNodeParam(node, 'geometry_hash', simpleHash);
                            (this.stateManager as any).invalidateSTLGeometry?.(node.id);
                            const net = (window as any).networkManager;
                            if (net && net.isConnected()) {
                                const activeWs = this.stateManager.getActiveWorkspace();
                                const modelId = activeWs?.activeModelId || 'default';
                                const activeModel = this.stateManager.getAllModels().find(m => m.id === modelId);
                                const resolvedPath = resolveResourcePath(selectedPath, activeModel?.filename);
                                net.send({ command: "LOAD_STL_GEOMETRY", filePath: resolvedPath, modelId });
                            }
                        } else if (isK) {
                            const rand = Math.floor(Math.random() * 1000000);
                            const simpleHash = 'k_' + rand.toString(36);
                            this.updateNodeParam(node, 'geometry_hash', simpleHash);
                        }
                        this.render(true);
                    }
                }
            );
            browser.open(startPath);
        };

        wrapper.appendChild(textInput);
        wrapper.appendChild(browseBtn);
        return wrapper;
    }

    private createCategorizedDropdown(
        groups: { category: string; presets: string[] }[],
        selected: string,
        onChange: (val: string) => void
    ): HTMLSelectElement {
        const select = document.createElement('select');
        select.className = 'property-select';
        let matchFound = false;
        groups.forEach(g => {
            const optgroup = document.createElement('optgroup');
            optgroup.label = g.category;
            g.presets.forEach(opt => {
                const el = document.createElement('option');
                el.value = opt;
                el.textContent = opt;
                if (opt.toLowerCase() === String(selected).toLowerCase() || opt === selected) {
                    el.selected = true;
                    matchFound = true;
                }
                optgroup.appendChild(el);
            });
            select.appendChild(optgroup);
        });
        if (!matchFound && select.options.length > 0) {
            select.selectedIndex = 0;
        }
        select.addEventListener('change', () => onChange(select.value));
        return select;
    }

    private createDropdown(options: Array<string | { value: string; label: string }>, selected: string, onChange: (val: string) => void): HTMLSelectElement {
        const select = document.createElement('select');
        select.className = 'property-select';
        let matchFound = false;
        options.forEach(opt => {
            const el = document.createElement('option');
            const val = typeof opt === 'string' ? opt : opt.value;
            const text = typeof opt === 'string' ? opt : opt.label;
            el.value = val;
            el.textContent = text;
            if (val.toLowerCase() === String(selected).toLowerCase() || val === selected) {
                el.selected = true;
                matchFound = true;
            }
            select.appendChild(el);
        });
        if (!matchFound && options.length > 0) {
            select.selectedIndex = 0;
        }
        select.addEventListener('change', () => onChange(select.value));
        return select;
    }

    private createNumberInput(val: number, onChange: (val: number) => void): HTMLInputElement {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'property-input number-input';
        input.value = String(val);
        const commit = () => {
            const parsed = parseFloat(input.value);
            if (!isNaN(parsed)) {
                onChange(parsed);
            }
        };
        input.addEventListener('input', commit);
        input.addEventListener('change', commit);
        input.addEventListener('blur', commit);
        return input;
    }

    private createCoordInput(val: number, onChange: (val: number) => void): HTMLInputElement {
        const input = document.createElement('input');
        input.type = 'number';
        input.step = 'any';
        input.className = 'property-input number-input';
        input.value = Number(val).toString();
        input.style.fontFamily = "'JetBrains Mono', monospace";
        input.style.fontSize = '11px';
        input.style.width = '100%';
        input.style.boxSizing = 'border-box';
        const commit = () => {
            const parsed = parseFloat(input.value);
            if (!isNaN(parsed) && parsed !== val) {
                onChange(parsed);
            }
        };
        input.addEventListener('change', commit);
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                input.blur();
            }
        });
        return input;
    }

    private createPrecisionFloatInput(
        val: number,
        min: number = -2.0,
        max: number = 2.0,
        step: number = 0.001,
        onChange: (val: number) => void
    ): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'property-float-input-box';
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.gap = '6px';
        wrapper.style.width = '100%';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = String(min);
        slider.max = String(max);
        slider.step = String(step);
        slider.value = String(val);
        slider.className = 'property-slider';
        slider.style.flex = '1';

        const numInput = document.createElement('input');
        numInput.type = 'number';
        numInput.step = 'any';
        numInput.min = String(min);
        numInput.max = String(max);
        numInput.value = Number(val).toString();
        numInput.className = 'property-input number-input';
        numInput.style.width = '75px';
        numInput.style.fontFamily = "'JetBrains Mono', monospace";
        numInput.style.fontSize = '11px';

        const decimals = step < 0.0001 ? 5 : (step < 0.001 ? 4 : (step < 0.01 ? 3 : 2));

        slider.addEventListener('input', () => {
            const parsed = parseFloat(slider.value);
            numInput.value = parsed.toFixed(decimals);
            onChange(parsed);
        });

        const commitNumber = () => {
            const parsed = parseFloat(numInput.value);
            if (!isNaN(parsed)) {
                slider.value = String(parsed);
                onChange(parsed);
            }
        };
        numInput.addEventListener('input', commitNumber);
        numInput.addEventListener('change', commitNumber);
        numInput.addEventListener('blur', commitNumber);

        wrapper.appendChild(slider);
        wrapper.appendChild(numInput);
        return wrapper;
    }

    private createCheckbox(checked: boolean, onChange: (val: boolean) => void): HTMLElement {
        const wrapper = document.createElement('label');
        wrapper.className = 'property-checkbox-label';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        cb.className = 'property-checkbox';
        cb.addEventListener('change', () => onChange(cb.checked));
        wrapper.appendChild(cb);
        return wrapper;
    }

    private createSlider(min: number, max: number, step: number, val: number, onChange: (val: number) => void): HTMLElement {
        const box = document.createElement('div');
        box.className = 'property-slider-box';
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = String(min);
        slider.max = String(max);
        slider.step = String(step);
        slider.value = String(val);
        slider.className = 'property-slider';

        const label = document.createElement('span');
        label.className = 'property-slider-val';
        label.textContent = val.toFixed(2);

        slider.addEventListener('input', () => {
            const num = parseFloat(slider.value);
            label.textContent = num.toFixed(2);
            onChange(num);
        });

        box.appendChild(slider);
        box.appendChild(label);
        return box;
    }

    private createColorPicker(color: string, onChange: (hex: string) => void): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.gap = '8px';

        const input = document.createElement('input');
        input.type = 'color';
        input.value = color && color.startsWith('#') ? color : '#ff3d00';
        input.style.width = '32px';
        input.style.height = '24px';
        input.style.padding = '0';
        input.style.border = '1px solid #334155';
        input.style.borderRadius = '3px';
        input.style.cursor = 'pointer';
        input.style.backgroundColor = 'transparent';

        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.value = input.value;
        textInput.className = 'property-input';
        textInput.style.width = '75px';
        textInput.style.fontFamily = "'JetBrains Mono', monospace";
        textInput.style.fontSize = '11px';

        input.addEventListener('input', () => {
            textInput.value = input.value;
            onChange(input.value);
        });

        textInput.addEventListener('change', () => {
            if (/^#[0-9A-Fa-f]{6}$/.test(textInput.value)) {
                input.value = textInput.value;
                onChange(textInput.value);
            }
        });

        wrapper.appendChild(input);
        wrapper.appendChild(textInput);
        return wrapper;
    }

    private buildAccordion(groupId: string, title: string, count?: number): { accordion: HTMLElement; content: HTMLElement | null } {
        const accordion = document.createElement('div');
        const isCollapsed = this.collapsedAccordions.has(groupId);
        accordion.className = `property-accordion ${isCollapsed ? 'collapsed' : 'open'}`;

        const header = document.createElement('div');
        header.className = 'accordion-header';
        const countHtml = count !== undefined ? `<span class="accordion-count">(${count})</span>` : '';
        header.innerHTML = `
            <span class="accordion-caret">${isCollapsed ? '▶' : '▼'}</span>
            <span class="accordion-title">${title}</span>
            ${countHtml}
        `;
        header.addEventListener('click', () => {
            if (this.collapsedAccordions.has(groupId)) {
                this.collapsedAccordions.delete(groupId);
            } else {
                this.collapsedAccordions.add(groupId);
            }
            this.render(true);
        });

        accordion.appendChild(header);

        if (!isCollapsed) {
            const content = document.createElement('div');
            content.className = 'accordion-content';
            accordion.appendChild(content);
            return { accordion, content };
        }
        return { accordion, content: null };
    }

    private getActiveViewportNode(node?: Node): Node | null {
        if (node?.type === 'Telemetry3DViewport') return node;
        const owningModel = node ? (this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel()) : this.stateManager.getActiveModel();
        if (owningModel) {
            const vp = owningModel.nodes.find((n: any) => n.type === 'Telemetry3DViewport');
            if (vp) return vp;
        }
        const focusedId = this.stateManager.getFocusedViewportId();
        if (focusedId) {
            for (const m of this.stateManager.getAllModels()) {
                const found = m.nodes.find(n => n.id === focusedId || n.id === `virtual-viewport-${focusedId}`);
                if (found) return found;
            }
        }
        return this.stateManager.getAllModels().flatMap(m => m.nodes).find(n => n.type === 'Telemetry3DViewport') || null;
    }

    private getSelectedNode(): Node | null {
        if (!this.currentNodeId) return null;
        const state = this.stateManager.getCurrentState();
        let node = state?.nodes.find(n => n.id === this.currentNodeId);
        if (!node) {
            for (const m of this.stateManager.getAllModels()) {
                node = m.nodes.find(n => n.id === this.currentNodeId);
                if (node) break;
            }
        }
        return node || null;
    }

    private updateDisplayParam(node: Node, key: string, value: any): void {
        // 1. Update parameter in-place on inspected node
        this.stateManager.updateNodeParametersInPlace(node.id, { [key]: value });

        // 2. Synchronize to active viewport node if different
        const vpNode = this.getActiveViewportNode(node);
        if (vpNode && vpNode.id !== node.id) {
            const vpSharedKeys = new Set([
                'showMPMParticles', 'mpmParticleDiameter', 'mpmParticleSize', 'mpmParticleQuantity',
                'mpmParticleColormap', 'mpmParticleOpacity', 'mpmParticleAutoScale', 'mpmParticleLogScale',
                'mpmParticleMinVal', 'mpmParticleMaxVal', 'mpmParticleWireframe', 'mpmParticleShowColorbar',
                'showFEMMesh', 'femSolid', 'femWireframe', 'femResults', 'femQuantity',
                'femColormap', 'femOpacity', 'femLighting', 'femAutoScale', 'femLogScale',
                'femShowColorbar', 'femMinVal', 'femMaxVal',
                'showBeams', 'showRebar', 'beamSolid', 'beamWireframe', 'rebarSolid', 'rebarWireframe',
                'beamOpacity', 'rebarOpacity', 'beamRadius', 'rebarRadius', 'beamQuantity', 'beamColormap',
                'beamAutoScale', 'beamLogScale', 'beamMinVal', 'beamMaxVal',
                'show_stl', 'stl_solids', 'stl_wireframe', 'stl_lighting', 'stl_colormap', 'stl_opacity',
                'stl_show_results', 'stl_quantity', 'stl_auto_scale', 'stl_log_scale', 'stl_show_colorbar',
                'stl_min_val', 'stl_max_val',
                'show_obstacles', 'obstacles_solid', 'obstacles_gridlines', 'obstacles_lighting',
                'obstacles_colormap', 'obstacles_opacity', 'obstacles_quantity', 'obstacles_auto_scale',
                'obstacles_log_scale', 'obstacles_min_val', 'obstacles_max_val',
                'show_charge', 'charge_solid', 'charge_wireframe', 'charge_lighting', 'charge_opacity',
                'charge_color', 'chargeColor',
                'show_detonators', 'show_detonator', 'detonatorSolid', 'detonatorWireframe', 'detonatorLighting',
                'detonatorSize', 'detonatorOpacity', 'detonators_size', 'detonators_opacity',
                'show_grid', 'show_grid_box', 'grid_meshlines', 'grid_opacity', 'cell_edges',
                'show_gauges', 'gauge_solid', 'gauge_size', 'gauge_opacity', 'gauge_quantity',
                'lightingEnabled', 'aoEnabled', 'aoRadius', 'aoIntensity', 'aoSphereImpostor',
                'slices', 'show_slices', 'colormap', 'quantity', 'opacity', 'refresh_rate', 'viewport_refresh_rate', 'show_color_bar'
            ]);
            if (vpSharedKeys.has(key)) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, { [key]: value });
            }
        }

        // 3. Dispatch to layoutManager components
        const lm = (window as any).layoutManager;
        if (lm && lm.components) {
            lm.components.forEach((comp: any) => {
                const inst = comp.instance;
                if (!inst) return;
                const layerMap: Record<string, string> = {
                    show_slices: 'slices',
                    showMPMParticles: 'mpm',
                    showFEMMesh: 'fem',
                    showBeams: 'beams',
                    showRebar: 'rebar',
                    show_stl: 'stl',
                    show_obstacles: 'obstacles',
                    show_charge: 'charge',
                    show_detonators: 'detonator',
                    show_detonator: 'detonator',
                    show_grid: 'grid',
                    show_grid_box: 'gridBox',
                    show_gauges: 'gauges',
                    lightingEnabled: 'lighting'
                };
                if (layerMap[key] && inst.setLayerVisibility) {
                    inst.setLayerVisibility(layerMap[key], Boolean(value));
                }
                if (['lightingEnabled', 'aoEnabled', 'aoRadius', 'aoIntensity', 'aoSphereImpostor'].includes(key)) {
                    if (inst.setShadingConfig) inst.setShadingConfig({ [key]: value });
                }
                if (['colormap', 'mpmParticleColormap', 'femColormap', 'stl_colormap', 'obstacles_colormap', 'beamColormap'].includes(key)) {
                    if (inst.setColormap) inst.setColormap(value);
                }
                if (['quantity', 'mpmParticleQuantity', 'femQuantity', 'stl_quantity', 'obstacles_quantity', 'beamQuantity'].includes(key)) {
                    if (inst.setQuantity) inst.setQuantity(value);
                }
                if (key === 'slices' && inst.setSlices) {
                    inst.setSlices(value);
                }
                if ((key === 'refresh_rate' || key === 'viewport_refresh_rate') && inst.setRefreshRate) {
                    inst.setRefreshRate(Number(value));
                }
            });
        }

        // 4. Dispatch to TransportController
        const tc = (window as any).transportController;
        if (tc) {
            const tcKeyMap: Record<string, string> = {
                showMPMParticles: 'visibility',
                showFEMMesh: 'visibility',
                showBeams: 'visibility',
                showRebar: 'visibility',
                show_stl: 'visibility',
                show_obstacles: 'visibility',
                show_charge: 'visibility',
                mpmParticleColormap: 'colormap',
                femColormap: 'colormap',
                stl_colormap: 'colormap',
                obstacles_colormap: 'colormap',
                beamColormap: 'colormap',
                mpmParticleQuantity: 'quantity',
                femQuantity: 'quantity',
                stl_quantity: 'quantity',
                obstacles_quantity: 'quantity',
                beamQuantity: 'quantity',
                mpmParticleOpacity: 'opacity',
                femOpacity: 'opacity',
                stl_opacity: 'opacity',
                obstacles_opacity: 'opacity',
                beamOpacity: 'opacity',
                grid_opacity: 'opacity',
                mpmParticleAutoScale: 'autoScale',
                femAutoScale: 'autoScale',
                stl_auto_scale: 'autoScale',
                obstacles_auto_scale: 'autoScale',
                beamAutoScale: 'autoScale',
                mpmParticleLogScale: 'logScale',
                femLogScale: 'logScale',
                stl_log_scale: 'logScale',
                obstacles_log_scale: 'logScale',
                beamLogScale: 'logScale',
                mpmParticleMinVal: 'minVal',
                femMinVal: 'minVal',
                stl_min_val: 'minVal',
                obstacles_min_val: 'minVal',
                beamMinVal: 'minVal',
                mpmParticleMaxVal: 'maxVal',
                femMaxVal: 'maxVal',
                stl_max_val: 'maxVal',
                obstacles_max_val: 'maxVal',
                beamMaxVal: 'maxVal',
                femWireframe: 'wireframe',
                stl_wireframe: 'wireframe',
                femLighting: 'lighting',
                stl_lighting: 'lighting'
            };
            const mappedKey = tcKeyMap[key] || key;
            if (tc.handlePropertyChange) {
                tc.handlePropertyChange(mappedKey, value);
            } else if (tc.syncStateFromViewport) {
                tc.syncStateFromViewport();
                tc.requestTabRender?.();
            }
        }
    }

    private updateNodeParam(node: Node, key: string, value: any): void {
        const updates: Record<string, any> = { [key]: value };

        if (node.type === 'Material' && key === 'preset') {
            const presetData = MPM_MATERIAL_PRESETS[value];
            if (presetData) {
                Object.assign(updates, presetData);
                if (presetData.category === 'Ideal Gas Presets') {
                    updates['material_type'] = 'Air';
                    updates['material_model'] = 'Ideal Gas';
                    if (presetData.atm_pressure !== undefined) {
                        updates['ambient_p'] = presetData.atm_pressure;
                        const t = presetData.atm_temperature || 288.15;
                        const rho = presetData.density ?? (presetData.atm_pressure / (287.058 * t));
                        updates['density'] = rho;
                        updates['ambient_rho'] = rho;
                    }
                } else if (presetData.category === 'JWL Detonation Gas Presets') {
                    updates['material_type'] = 'JWL Charge';
                    updates['material_model'] = 'JWL Detonation Gas';
                    if (presetData.composition) updates['composition'] = presetData.composition;
                } else if (presetData.category === 'Ideal Gas Blast Presets') {
                    updates['material_type'] = 'Ideal Gas Charge';
                    updates['material_model'] = 'Ideal Gas Charge';
                    if (presetData.composition) updates['composition'] = presetData.composition;
                }
            }
        } else if (node.type === 'Material' && key === 'material_model') {
            if (value === 'Ideal Gas') {
                updates['material_model'] = 'Ideal Gas';
                updates['material_type'] = 'Air';
                const defPreset = 'Air (Standard STP, gamma=1.4)';
                updates['preset'] = defPreset;
                const presetData = MPM_MATERIAL_PRESETS[defPreset];
                if (presetData) {
                    Object.assign(updates, presetData);
                    const p = presetData.atm_pressure ?? 101325.0;
                    const t = presetData.atm_temperature || 288.15;
                    const rho = presetData.density ?? (p / (287.058 * t));
                    updates['density'] = rho;
                    updates['ambient_rho'] = rho;
                    updates['ambient_p'] = p;
                }
            } else if (value === 'JWL Detonation Gas') {
                updates['material_model'] = 'JWL Detonation Gas';
                updates['material_type'] = 'JWL Charge';
                updates['composition'] = 'TNT';
                const defPreset = 'TNT (Trinitrotoluene)';
                updates['preset'] = defPreset;
                const presetData = MPM_MATERIAL_PRESETS[defPreset];
                if (presetData) Object.assign(updates, presetData);
            } else if (value === 'Ideal Gas Charge') {
                updates['material_model'] = 'Ideal Gas Charge';
                updates['material_type'] = 'Ideal Gas Charge';
                updates['composition'] = 'TNT';
                const defPreset = 'TNT (Ideal Gas Equivalent)';
                updates['preset'] = defPreset;
                const presetData = MPM_MATERIAL_PRESETS[defPreset];
                if (presetData) Object.assign(updates, presetData);
            } else {
                delete updates['material_type'];
                delete updates['composition'];
                const defPreset = getDefaultPresetForModel(value);
                if (defPreset) {
                    updates['preset'] = defPreset;
                    const presetData = MPM_MATERIAL_PRESETS[defPreset];
                    if (presetData) {
                        Object.assign(updates, presetData);
                    }
                }
            }
        } else if (node.type === 'Material' && (key === 'atm_pressure' || key === 'atm_temperature')) {
            const p = Number(key === 'atm_pressure' ? value : (node.parameters['atm_pressure'] ?? 101325.0));
            const t = Number(key === 'atm_temperature' ? value : (node.parameters['atm_temperature'] ?? 288.15));
            const rho = p / (287.058 * t);
            updates['density'] = rho;
            updates['ambient_rho'] = rho;
            updates['ambient_p'] = p;
            updates['preset'] = 'Custom';
        } else if (node.type === 'Material' && key === 'density' && node.parameters['material_model'] === 'Ideal Gas') {
            updates['ambient_rho'] = Number(value);
            updates['preset'] = 'Custom';
        } else if (node.type === 'Material' && ['rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega', 'ideal_rho_0', 'ideal_e_0', 'ideal_gamma', 'atm_pressure', 'atm_temperature', 'gamma', 'density', 'youngs_modulus', 'poissons_ratio', 'yield_stress', 'hardening_modulus'].includes(key)) {
            updates['preset'] = 'Custom';
        } else if (key === 'space_time_scheme') {
            if (node.type === 'CFDSolver' || node.type === 'CFDSolver2D' || node.type === 'CFDSolver3D') {
                let s_order = 2;
                let t_order = 4;
                if (value === 'ADER-2 (2nd-Order Space/Time)') {
                    s_order = 2;
                    t_order = (node.type === 'CFDSolver3D') ? 5 : 2;
                } else if (value === 'ADER-3 (3rd-Order Space/Time)') {
                    s_order = 3;
                    t_order = (node.type === 'CFDSolver3D') ? 6 : 3;
                } else {
                    s_order = 2;
                    t_order = 4;
                }
                updates['space_time_scheme'] = value;
                updates['spatial_order'] = s_order;
                updates['temporal_order'] = t_order;
            }
        } else if (node.type === 'STLGeometry' && key === 'voxelization_method') {
            updates['geometry_hash'] = 'stl_' + Math.floor(Math.random() * 1000000).toString(36);
        } else if (key === 'stl_file') {
            updates['geometry_hash'] = 'stl_' + Math.floor(Math.random() * 1000000).toString(36);
        } else if (key === 'k_file') {
            updates['geometry_hash'] = 'k_' + Math.floor(Math.random() * 1000000).toString(36);
        }

        // Mutate node.parameters in-place immediately for closures
        Object.assign(node.parameters, updates);

        const isVisualOnly = NON_PHYSICAL_NODE_TYPES.has(node.type) || DISPLAY_ONLY_KEYS.has(key);

        if (isVisualOnly) {
            this.updateDisplayParam(node, key, value);
        } else {
            this.stateManager.updateNodeParameters(node.id, updates);
        }

        // Live update stats card & discretization rows immediately
        this.updateLiveStats(node);

        const structuralKeys = ['material_model', 'material_type', 'preset', 'composition', 'charge_shape', 'shape_type', 'dimension', 'space_time_scheme', 'init_mode'];
        if (structuralKeys.includes(key)) {
            this.render(true);
        }
    }

    public updateLiveStats(node?: Node): void {
        if (!this.rootElement) return;
        const targetId = node?.id || this.currentNodeId;
        if (!targetId) return;
        const state = this.stateManager.getCurrentState();
        let targetNode = state?.nodes.find(n => n.id === targetId);
        if (!targetNode && node) {
            targetNode = node;
        }
        if (!targetNode) return;
        
        // 1. Update top entity stats card
        const statsBox = this.rootElement.querySelector('.property-entity-stats-card') as HTMLElement;
        if (statsBox) {
            const html = getEntityStatsHTML(targetNode, state ?? undefined);
            if (html) {
                statsBox.innerHTML = html;
                statsBox.style.display = '';
            } else {
                statsBox.innerHTML = '';
                statsBox.style.display = 'none';
            }
        }

        // 2. Update Eulerian Background Grid / Discretization stat rows if present
        const meshCounts = resolveMeshCounts(targetNode, state ?? undefined);
        const statRows = this.rootElement.querySelectorAll('.property-stat-row');
        statRows.forEach(row => {
            const labelEl = row.querySelector('.stat-key');
            const valEl = row.querySelector('.stat-val') as HTMLElement;
            if (!labelEl || !valEl) return;
            const label = labelEl.textContent?.trim();
            if (label === 'Eulerian Background Grid') {
                valEl.textContent = `${meshCounts.totalCells.toLocaleString()} cells (${meshCounts.dimension})`;
            } else if (label === 'Total Grid Cells') {
                valEl.textContent = `${meshCounts.totalCells.toLocaleString()} cells`;
            } else if (label === 'Calculated 3D Grid') {
                valEl.textContent = `${meshCounts.nx} × ${meshCounts.ny} × ${meshCounts.nz} cells`;
            } else if (label === 'Calculated 2D Grid') {
                valEl.textContent = `${meshCounts.nr} × ${meshCounts.nz} cells`;
            } else if (label === 'Calculated 1D Cells') {
                valEl.textContent = `${meshCounts.n_cells.toLocaleString()} cells`;
            } else if (label === 'Domain Bounds Box') {
                valEl.textContent = `${(meshCounts.dim_x ?? 1).toFixed(3)} × ${(meshCounts.dim_y ?? 1).toFixed(3)} × ${(meshCounts.dim_z ?? 1).toFixed(3)} m`;
            } else if (label === 'Domain Volume') {
                valEl.textContent = `${(meshCounts.volume ?? 0).toFixed(4)} m³`;
            }
        });
    }

    private formatKeyToLabel(key: string): string {
        return key
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    private getRawVisibleParameterKeys(node: Node): string[] {
        if (node.type === 'Material') {
            syncMPMMaterialParameters(node, node.parameters);
            
            const matModel = node.parameters['material_model'];

            if (matModel === 'Ideal Gas') {
                return ['material_model', 'preset', 'density', 'atm_pressure', 'atm_temperature', 'gamma'];
            } else if (matModel === 'JWL Detonation Gas') {
                return ['material_model', 'preset', 'rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'];
            } else if (matModel === 'Ideal Gas Charge') {
                return ['material_model', 'preset', 'ideal_rho_0', 'ideal_e_0', 'ideal_gamma'];
            }

            if (!node.parameters['material_model']) {
                node.parameters['material_model'] = 'Hypoelastic';
            }
            if (!node.parameters['preset']) {
                node.parameters['preset'] = getDefaultPresetForModel(node.parameters['material_model']);
            }

            const matModelResolved = node.parameters['material_model'];
            if (matModelResolved === 'Linear Elastic') {
                return [
                    'material_model', 'preset', 'transfer_scheme',
                    'density', 'youngs_modulus', 'poissons_ratio',
                    'tensile_failure_stress',
                    'enable_heterogeneity', 'weibull_modulus', 'weibull_scale', 'fracture_toughness', 'debris_bulk_factor',
                    'enable_anisotropy', 'anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z',
                    'dem_transition_enabled', 'fragment_distribution', 'fragment_min_size', 'fragment_max_size', 'fragment_weibull_n', 'fragment_clumping_radius', 'fragment_ejection_jitter', 'fragment_contact_friction', 'fragment_restitution'
                ];
            } else if (matModel === 'Johnson-Cook + Mie-Grüneisen' || matModel === 'Johnson-Cook') {
                return [
                    'material_model', 'preset', 'transfer_scheme',
                    'density', 'youngs_modulus', 'poissons_ratio',
                    'failure_strain', 'tensile_failure_stress',
                    'enable_strain_erosion', 'erosion_strain',
                    'enable_stress_erosion', 'erosion_stress',
                    'enable_timestep_erosion', 'timestep_erosion_factor',
                    'jc_A', 'jc_B', 'jc_n', 'jc_C', 'jc_m',
                    'jc_d1', 'jc_d2', 'jc_d3', 'jc_d4', 'jc_d5',
                    'T_melt', 'T_room', 'Cp',
                    'mg_gamma0', 'mg_c0', 'mg_s',
                    'enable_heterogeneity', 'weibull_modulus', 'weibull_scale', 'fracture_toughness', 'debris_bulk_factor',
                    'enable_anisotropy', 'anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z',
                    'dem_transition_enabled', 'fragment_distribution', 'fragment_min_size', 'fragment_max_size', 'fragment_weibull_n', 'fragment_clumping_radius', 'fragment_ejection_jitter', 'fragment_contact_friction', 'fragment_restitution'
                ];
            } else if (matModel === 'CREST Reactive Burn') {
                return [
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
            } else if (matModel === 'Davis Reactive Burn') {
                return [
                    'material_model', 'preset', 'transfer_scheme',
                    'density', 'youngs_modulus', 'poissons_ratio',
                    'yield_stress', 'hardening_modulus',
                    'davis_c0', 'davis_s1', 'davis_gamma0', 'davis_cv', 'davis_t0', 'davis_rho0',
                    'davis_a', 'davis_b', 'davis_k', 'davis_vc', 'davis_pc', 'davis_q_det',
                    'enable_heterogeneity', 'weibull_modulus', 'weibull_scale', 'fracture_toughness', 'debris_bulk_factor',
                    'enable_anisotropy', 'anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z'
                ];
            } else if (matModel === 'RHT Concrete') {
                return [
                    'material_model', 'preset', 'transfer_scheme',
                    'density', 'youngs_modulus', 'poissons_ratio',
                    'fc', 'ft', 'G_f', 'moisture_content', 'dif_cap_compression', 'dif_cap_tension',
                    'directional_crack_band', 'nonlocal_radius',
                    'failure_strain', 'tensile_failure_stress',
                    'enable_strain_erosion', 'erosion_strain',
                    'enable_stress_erosion', 'erosion_stress',
                    'enable_timestep_erosion', 'timestep_erosion_factor',
                    'rht_A', 'rht_N', 'rht_B', 'rht_M', 'rht_Q0', 'rht_BQ', 'rht_D1', 'rht_D2',
                    'rht_p_crush', 'rht_p_lock', 'rht_alpha0', 'rht_n_comp', 'rht_betac', 'rht_deltat',
                    'enable_heterogeneity', 'weibull_modulus', 'weibull_scale', 'fracture_toughness', 'debris_bulk_factor',
                    'enable_anisotropy', 'anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z',
                    'dem_transition_enabled', 'fragment_distribution', 'fragment_min_size', 'fragment_max_size', 'fragment_weibull_n', 'fragment_clumping_radius', 'fragment_ejection_jitter', 'fragment_contact_friction', 'fragment_restitution'
                ];
            } else if (matModel === 'Karagozian & Case (K&C)' || matModel === 'K&C Concrete') {
                return [
                    'material_model', 'preset', 'transfer_scheme',
                    'density', 'youngs_modulus', 'poissons_ratio',
                    'fc', 'ft', 'G_f', 'moisture_content', 'dif_cap_compression', 'dif_cap_tension',
                    'directional_crack_band', 'nonlocal_radius',
                    'failure_strain', 'tensile_failure_stress',
                    'enable_strain_erosion', 'erosion_strain',
                    'enable_stress_erosion', 'erosion_stress',
                    'enable_timestep_erosion', 'timestep_erosion_factor',
                    'kc_auto_generate', 'kc_a0', 'kc_a1', 'kc_a2', 'kc_a0y', 'kc_a1y', 'kc_a2y', 'kc_a1r', 'kc_a2r', 'kc_b1', 'kc_omega',
                    'enable_heterogeneity', 'weibull_modulus', 'weibull_scale', 'fracture_toughness', 'debris_bulk_factor',
                    'enable_anisotropy', 'anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z',
                    'dem_transition_enabled', 'fragment_distribution', 'fragment_min_size', 'fragment_max_size', 'fragment_weibull_n', 'fragment_clumping_radius', 'fragment_ejection_jitter', 'fragment_contact_friction', 'fragment_restitution'
                ];
            } else if (matModel === 'CSCM Concrete') {
                return [
                    'material_model', 'preset', 'transfer_scheme',
                    'density', 'youngs_modulus', 'poissons_ratio',
                    'fc', 'ft', 'G_f', 'moisture_content', 'dif_cap_compression', 'dif_cap_tension',
                    'directional_crack_band', 'nonlocal_radius',
                    'failure_strain', 'tensile_failure_stress',
                    'enable_strain_erosion', 'erosion_strain',
                    'enable_stress_erosion', 'erosion_stress',
                    'enable_timestep_erosion', 'timestep_erosion_factor',
                    'cscm_alpha', 'cscm_theta', 'cscm_lambda', 'cscm_beta', 'cscm_R', 'cscm_X0', 'cscm_W', 'cscm_D1', 'cscm_D2',
                    'enable_heterogeneity', 'weibull_modulus', 'weibull_scale', 'fracture_toughness', 'debris_bulk_factor',
                    'enable_anisotropy', 'anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z',
                    'dem_transition_enabled', 'fragment_distribution', 'fragment_min_size', 'fragment_max_size', 'fragment_weibull_n', 'fragment_clumping_radius', 'fragment_ejection_jitter', 'fragment_contact_friction', 'fragment_restitution'
                ];
            } else if (matModel === 'Ideal Gas') {
                return [
                    'material_model', 'preset',
                    'density', 'atm_pressure', 'atm_temperature', 'gamma'
                ];
            } else if (matModel === 'JWL Detonation Gas' || matModel === 'JWL') {
                return [
                    'material_model', 'preset',
                    'composition', 'rho', 'detonation_energy', 'det_vel',
                    'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega',
                    'ideal_gamma', 'ideal_rho_0', 'ideal_e_0'
                ];
            } else if (matModel === 'Deshpande-Fleck Foam') {
                return [
                    'material_model', 'preset', 'transfer_scheme',
                    'density', 'youngs_modulus', 'poissons_ratio',
                    'yield_stress', 'hardening_modulus',
                    'failure_strain', 'tensile_failure_stress',
                    'enable_heterogeneity', 'weibull_modulus', 'weibull_scale', 'fracture_toughness', 'debris_bulk_factor',
                    'enable_anisotropy', 'anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z'
                ];
            } else if (matModel === 'Drucker-Prager') {
                return [
                    'cscm_alpha', 'cscm_theta', 'cscm_lambda', 'cscm_beta', 'cscm_R', 'cscm_X0', 'cscm_W', 'cscm_D1', 'cscm_D2'
                ].filter(k => k in node.parameters);
            }
        }

        if (node.type === 'Charge1D' || node.type === 'Charge2D' || node.type === 'Charge3D') {
            const shape = node.parameters['charge_shape'] || 'Sphere';
            if (shape === 'Sphere') {
                return ['material', 'charge_mass', 'charge_shape', 'charge_x', 'charge_y', 'charge_z', 'charge_r', 'charge_radius', 'charge_opacity'].filter(k => k in node.parameters || k === 'material');
            } else if (shape === 'Cylinder') {
                return ['material', 'charge_mass', 'charge_shape', 'charge_x', 'charge_y', 'charge_z', 'charge_r', 'charge_radius', 'charge_height', 'charge_aspect_ratio', 'charge_rot_x', 'charge_rot_y', 'charge_rot_z', 'charge_opacity'].filter(k => k in node.parameters || k === 'material');
            } else if (shape === 'Block') {
                return ['material', 'charge_mass', 'charge_shape', 'charge_x', 'charge_y', 'charge_z', 'charge_lx', 'charge_ly', 'charge_lz', 'charge_rot_x', 'charge_rot_y', 'charge_rot_z', 'charge_opacity'].filter(k => k in node.parameters || k === 'material');
            }
        }

        if (node.type === 'MPMDomain2D') {
            const hasFLIP = node.parameters['velocity_scheme'] === 'FLIP';
            const keys = ['precision', 'particle_distribution', 'boundary_filling', 'velocity_scheme', 'space_time_scheme', 'smooth_plastic_strain'];
            if (hasFLIP) keys.push('flip_blend');
            keys.push('ppc', 'cfl', 'endtime');
            return keys.filter(k => k in node.parameters);
        }

        if (node.type === 'MPMDomain3D') {
            const hasFLIP = node.parameters['velocity_scheme'] === 'FLIP';
            const keys = ['device', 'precision', 'particle_distribution', 'boundary_filling', 'velocity_scheme', 'space_time_scheme', 'smooth_plastic_strain'];
            if (hasFLIP) keys.push('flip_blend');
            keys.push('ppc', 'cfl', 'endtime');
            return keys.filter(k => k in node.parameters);
        }

        if (node.type === 'MPMObject2D') {
            return ['material', 'shape_type', 'particle_distribution', 'boundary_filling', 'pos_x', 'pos_y', 'size_x', 'size_y', 'radius', 'vel_x', 'vel_y', 'angular_vel'].filter(k => k in node.parameters || k === 'material');
        }

        if (node.type === 'MPMObject3D') {
            const shape = node.parameters['shape_type'] || 'Box';
            if (shape === 'Box') {
                return ['material', 'shape_type', 'particle_distribution', 'boundary_filling', 'pos_x', 'pos_y', 'pos_z', 'size_x', 'size_y', 'size_z', 'vel_x', 'vel_y', 'vel_z', 'angular_vel_x', 'angular_vel_y', 'angular_vel_z'].filter(k => k in node.parameters || k === 'material');
            } else if (shape === 'Sphere') {
                return ['material', 'shape_type', 'particle_distribution', 'boundary_filling', 'pos_x', 'pos_y', 'pos_z', 'radius', 'inner_radius', 'vel_x', 'vel_y', 'vel_z', 'angular_vel_x', 'angular_vel_y', 'angular_vel_z'].filter(k => k in node.parameters || k === 'material');
            } else if (shape === 'Cylinder') {
                return ['material', 'shape_type', 'particle_distribution', 'boundary_filling', 'pos_x', 'pos_y', 'pos_z', 'radius', 'inner_radius', 'height', 'vel_x', 'vel_y', 'vel_z', 'angular_vel_x', 'angular_vel_y', 'angular_vel_z'].filter(k => k in node.parameters || k === 'material');
            } else if (shape === 'STL') {
                return ['material', 'shape_type', 'particle_distribution', 'boundary_filling', 'stl_file', 'scale_x', 'scale_y', 'scale_z', 'pos_x', 'pos_y', 'pos_z', 'vel_x', 'vel_y', 'vel_z', 'angular_vel_x', 'angular_vel_y', 'angular_vel_z'].filter(k => k in node.parameters || k === 'material');
            }
        }

        if (node.type === 'FEMDomain3D') {
            return [
                'device', 'precision', 'cfl', 'endtime',
                'enable_directional_crack_band', 'enable_nonlocal_damage',
                'enable_heterogeneity', 'material_heterogeneity',
                'enable_anisotropy', 'anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z',
                'debris_velocity_smoothing', 'debris_clumping', 'debris_max_clump_size', 'random_seed',
                'rebar_formulation', 'convert_failed_elements_to_mpm', 'mpm_particles_per_failed_element',
                'hourglass_coeff', 'contact_penalty_scale', 'friction_static', 'friction_kinetic',
                'integration_scheme', 'hourglass_model'
            ].filter(k => k in node.parameters);
        }

        if (node.type === 'FEMObject3D') {
            const shape = node.parameters['shape_type'] || 'Box';
            if (shape === 'Box') {
                return ['mesh_source', 'shape_type', 'boundary_condition', 'pos_x', 'pos_y', 'pos_z', 'size_x', 'size_y', 'size_z', 'nx', 'ny', 'nz', 'vel_x', 'vel_y', 'vel_z', 'bulk_viscosity_b1', 'bulk_viscosity_b2', 'timestep_erosion_factor'].filter(k => k in node.parameters);
            } else if (shape === 'Cylinder') {
                return ['mesh_source', 'shape_type', 'boundary_condition', 'pos_x', 'pos_y', 'pos_z', 'radius', 'inner_radius', 'height', 'nx', 'ny', 'nz', 'vel_x', 'vel_y', 'vel_z', 'bulk_viscosity_b1', 'bulk_viscosity_b2', 'timestep_erosion_factor'].filter(k => k in node.parameters);
            } else {
                return ['mesh_source', 'shape_type', 'boundary_condition', 'k_file', 'scale_factor', 'pos_x', 'pos_y', 'pos_z', 'vel_x', 'vel_y', 'vel_z', 'bulk_viscosity_b1', 'bulk_viscosity_b2', 'timestep_erosion_factor'].filter(k => k in node.parameters);
            }
        }

        if (node.type === 'FEMFSICoupler3D') {
            return [
                'cfl', 'endtime', 'steps', 'coupling_scheme', 'pressure_integration',
                'uncovering_method', 'erosion_venting', 'vacuum_density', 'vacuum_pressure'
            ].filter(k => k in node.parameters);
        }

        if (node.type === 'FSICoupler2D' || node.type === 'FSICoupler3D') {
            return [
                'cfl', 'endtime', 'coupling_interval', 'coupling_scheme', 'interpolation_scheme', 'fsi_substeps',
                'structure_motion_type', 'structure_mass', 'structure_stiffness', 'structure_damping',
                'structure_init_pos', 'structure_init_vel'
            ].filter(k => k in node.parameters);
        }

        if (node.type === 'CFDSolver' || node.type === 'CFDSolver2D' || node.type === 'CFDSolver3D') {
            return [
                'init_mode', 'device', 'precision', 'cfl', 'endtime',
                'space_time_scheme', 'flux_scheme', 'slope_limiter', 'time_scheme',
                'telemetry_mode', 'telemetry_interval_ms', 'enable_gauges', 'enable_vtk'
            ].filter(k => k in node.parameters || k === 'space_time_scheme');
        }

        if (node.type === 'DetonatorLocation' || node.type === 'DetonatorLocation3D') {
            return ['detonator_x', 'detonator_y', 'detonator_z', 'detonator_r', 'detonator_radius', 'detonator_time'].filter(k => k in node.parameters);
        }

        if (node.type === 'RemapNode' || node.type === 'Remap1DTo2DNode' || node.type === 'Remap1DTo3DNode' || node.type === 'Remap2DTo3DNode') {
            return ['explosive_r', 'explosive_z', 'explosive_x', 'explosive_y', 'remap_radius', 'remap_time', 'target_cell_size', 'interpolation_method', 'trigger_type', 'trigger_val'].filter(k => k in node.parameters);
        }

        if (node.type === 'VirtualGauges') {
            return [
                'enable_gauges', 'source_mode', 'external_file_path', 'external_file_format', 'storage_backend', 'sampling_stride_steps',
                'telemetry_channel', 'export_ascii', 'export_binary', 'export_hdf5',
                'ascii_delimiter', 'ascii_precision', 'include_header', 'output_dir', 'custom_filename',
                'sample_rate', 'channel', 'plot_stride', 'x_axis_mode',
                'qty_pressure', 'qty_density', 'qty_velocity', 'qty_energy', 'qty_reacted', 'qty_unreacted', 'qty_air', 'qty_overpressure', 'qty_impulse'
            ].filter(k => k in node.parameters);
        }

        if (node.type === 'VTKOutput') {
            const state = this.stateManager.getCurrentState();
            const is3D = state ? state.nodes.some(n => n.type === 'CFDSolver3D' || n.type === 'DomainMesh3D' || n.type === 'Telemetry3DViewport' || n.type === 'MPMDomain3D' || n.type === 'FEMDomain3D') : true;
            const hasFem = state ? state.nodes.some(n => n.type === 'FEMDomain3D' || n.type === 'FEMObject3D' || n.type === 'LSDynaImporter3D') : false;
            const hasMpm = state ? state.nodes.some(n => n.type === 'MPMDomain3D' || n.type === 'MPMObject3D' || n.type === 'MPMDomain2D' || n.type === 'MPMObject2D') : false;
            const hasObstacles = state ? state.nodes.some(n => n.type === 'STLGeometry' || n.type === 'PrimitiveGeometry3D') : true;

            const keys: string[] = [
                'trigger_type', 'step_interval', 'time_interval', 'vtk_format', 'custom_filename', 'vtk_dir', 'export_pvd'
            ];
            if (!is3D) {
                keys.push('export_cfd_2d');
            } else {
                keys.push('export_slices', 'export_volumes');
                if (hasObstacles) {
                    keys.push('export_obstacles', 'export_stl_faces');
                    if (node.parameters['export_stl_faces'] !== false) {
                        keys.push('stl_outside_domain');
                    }
                    keys.push('tessellate_stl_faces');
                    if (node.parameters['tessellate_stl_faces'] === true) keys.push('tessellation_max_edge');
                }
                keys.push('volume_stride', 'slice_stride', 'roi_enabled', 'roi_xmin', 'roi_xmax', 'roi_ymin', 'roi_ymax', 'roi_zmin', 'roi_zmax');
            }
            if (hasFem) keys.push('export_fem');
            if (hasMpm) keys.push('export_mpm');

            keys.push(
                'qty_pressure', 'qty_density', 'qty_velocity', 'qty_energy', 'qty_reacted', 'qty_unreacted', 'qty_air', 'qty_overpressure', 'qty_impulse'
            );
            if (hasFem) {
                keys.push('qty_fem_stress', 'qty_fem_strain', 'qty_fem_pressure', 'qty_fem_temp', 'qty_fem_damage', 'qty_fem_vel', 'qty_fem_disp');
            }
            if (hasMpm) {
                keys.push('qty_mpm_stress', 'qty_mpm_strain', 'qty_mpm_damage', 'qty_mpm_temp', 'qty_mpm_vel', 'qty_mpm_disp');
            }
            return keys.filter(k => k in node.parameters);
        }

        if (node.type === 'Telemetry3DViewport') {
            return [
                'viewport_refresh_rate',
                'colormap',
                'opacity',
                'representation_mode',
                'auto_range',
                'show_color_bar',
                'show_gauges',
                'show_stl',
                'show_grid',
                'showMPMParticles',
                'mpmParticleDiameter',
                'mpmParticleSize',
                'mpmParticleQuantity',
                'mpmParticleColormap',
                'mpmParticleOpacity',
                'mpmParticleAutoScale',
                'mpmParticleLogScale',
                'mpmParticleMinVal',
                'mpmParticleMaxVal',
                'showFEMMesh',
                'femSolid',
                'femWireframe',
                'femQuantity',
                'femColormap',
                'femOpacity',
                'showRebar',
                'showBeams'
            ].filter(k => k in node.parameters);
        }

        if (node.type === 'DomainMesh' || node.type === 'DomainMesh2D' || node.type === 'DomainMesh3D') {
            const dim = node.parameters['dimension'] || (node.type === 'DomainMesh3D' ? '3D' : (node.type === 'DomainMesh2D' ? '2D' : '1D'));
            if (dim === '1D') {
                return ['dimension', 'domain_radius', 'cell_size', 'left_bc', 'right_bc'].filter(k => k in node.parameters);
            } else if (dim === '2D') {
                return ['dimension', 'coordinate_system', 'nx', 'ny', 'min_r', 'max_r', 'min_z', 'max_z', 'cell_size', 'bc_r_min', 'bc_r_max', 'bc_z_min', 'bc_z_max', 'x_min_bc', 'x_max_bc', 'y_min_bc', 'y_max_bc'].filter(k => k in node.parameters);
            } else {
                return [
                    'dimension', 'coordinate_system',
                    'xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax',
                    'x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max',
                    'cell_size', 'nx', 'ny', 'nz',
                    'bc_x_min', 'bc_x_max', 'bc_y_min', 'bc_y_max', 'bc_z_min', 'bc_z_max',
                    'x_min_bc', 'x_max_bc', 'y_min_bc', 'y_max_bc', 'z_min_bc', 'z_max_bc'
                ].filter(k => k in node.parameters);
            }
        }

        return Object.keys(node.parameters).filter(k => k !== 'slices' && k !== 'gauges' && k !== 'visible' && k !== 'hidden');
    }

    private getVisibleParameterKeys(node: Node): string[] {
        let keys = this.getRawVisibleParameterKeys(node);

        // In coupled simulations, the Coupler node is the single source of truth for CFL and endtime.
        // Suppress redundant CFL/endtime fields on sub-domain nodes.
        let isCoupledModel = false;
        const allModels = this.stateManager.getAllModels();
        for (const m of allModels) {
            if (m.nodes && m.nodes.some(n => n.id === node.id)) {
                isCoupledModel = m.nodes.some(n => n.type === 'FSICoupler2D' || n.type === 'FSICoupler3D' || n.type === 'FEMFSICoupler3D');
                break;
            }
        }
        if (!isCoupledModel) {
            const activeModel = this.stateManager.getActiveModel();
            if (activeModel && activeModel.nodes && activeModel.nodes.some(n => n.id === node.id)) {
                isCoupledModel = activeModel.nodes.some(n => n.type === 'FSICoupler2D' || n.type === 'FSICoupler3D' || n.type === 'FEMFSICoupler3D');
            }
        }
        if (isCoupledModel && (node.type === 'CFDSolver' || node.type === 'CFDSolver2D' || node.type === 'CFDSolver3D' || node.type === 'MPMDomain2D' || node.type === 'MPMDomain3D' || node.type === 'FEMDomain3D')) {
            keys = keys.filter(k => k !== 'cfl' && k !== 'endtime');
        }

        return keys;
    }

    private groupParameters(node: Node): { id: string; title: string; params: { key: string; value: any }[] }[] {
        const visibleKeys = this.getVisibleParameterKeys(node);
        const groups: { id: string; title: string; params: { key: string; value: any }[] }[] = [];
        const assignedKeys = new Set<string>();

        const addGroup = (id: string, title: string, keys: string[]) => {
            const valid = keys.filter(k => visibleKeys.includes(k) && !assignedKeys.has(k) && (node.parameters[k] !== undefined || k === 'space_time_scheme'));
            if (valid.length > 0) {
                valid.forEach(k => assignedKeys.add(k));
                groups.push({
                    id,
                    title,
                    params: valid.map(k => {
                        let val = node.parameters[k];
                        if (k === 'space_time_scheme' && (node.type === 'CFDSolver' || node.type === 'CFDSolver2D' || node.type === 'CFDSolver3D')) {
                            if (!val) {
                                const so = Number(node.parameters['spatial_order'] ?? 2);
                                const to = Number(node.parameters['temporal_order'] ?? 4);
                                if (so === 2 && (to === 5 || to === 2)) val = 'ADER-2 (2nd-Order Space/Time)';
                                else if (so === 3 && (to === 6 || to === 3)) val = 'ADER-3 (3rd-Order Space/Time)';
                                else val = 'MUSCL-Hancock (2nd-Order Space/Time)';
                            }
                        }
                        return { key: k, value: val };
                    })
                });
            }
        };

        if (node.type === 'Telemetry3DViewport') {
            addGroup('vp_general', 'Viewport Refresh & Legend', ['viewport_refresh_rate', 'show_color_bar', 'show_grid']);
            addGroup('vp_rendering', 'Global Representation & Palette', ['colormap', 'opacity', 'representation_mode', 'auto_range']);
            addGroup('vp_mpm', 'MPM Particle Point Cloud', ['showMPMParticles', 'mpmParticleDiameter', 'mpmParticleSize', 'mpmParticleQuantity', 'mpmParticleColormap', 'mpmParticleOpacity', 'mpmParticleAutoScale', 'mpmParticleLogScale', 'mpmParticleMinVal', 'mpmParticleMaxVal']);
            addGroup('vp_fem', 'FEM Solid & Structural Mesh', ['showFEMMesh', 'femSolid', 'femWireframe', 'femQuantity', 'femColormap', 'femOpacity', 'showRebar', 'showBeams']);
            addGroup('vp_overlays', 'Mesh & Gauge Overlays', ['show_gauges', 'show_stl']);
            return groups;
        }

        if (node.type === 'Material') {
            const matModel = node.parameters['material_model'];

            if (matModel === 'Ideal Gas') {
                addGroup('mat_ambient', 'Atmospheric & Ambient EOS', [
                    'material_model', 'preset',
                    'density', 'atm_pressure', 'atm_temperature', 'gamma'
                ]);
            } else if (matModel === 'JWL Detonation Gas') {
                addGroup('mat_jwl', 'High-Explosive & JWL EOS', [
                    'material_model', 'preset',
                    'rho', 'detonation_energy', 'det_vel',
                    'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'
                ]);
            } else if (matModel === 'Ideal Gas Charge') {
                addGroup('mat_idealgas', 'Ideal Gas Blast EOS', [
                    'material_model', 'preset',
                    'ideal_rho_0', 'ideal_e_0', 'ideal_gamma'
                ]);
            } else {
                addGroup('mat_law', 'Constitutive Law & Presets', ['material_model', 'preset', 'transfer_scheme']);
                addGroup('mat_elasticity', 'Elasticity & Mass Density', ['density', 'youngs_modulus', 'poissons_ratio']);
                addGroup('mat_strength', 'Plastic Yield & Concrete Strength', ['yield_stress', 'hardening_modulus', 'fc', 'ft', 'G_f', 'moisture_content', 'dif_cap_compression', 'dif_cap_tension']);
                
                const viscoKeys = visibleKeys.filter(k => 
                    k.startsWith('jc_') || k.startsWith('mg_') || k.startsWith('rht_') || k.startsWith('kc_') || k.startsWith('cscm_') || 
                    k.startsWith('davis_') || k.startsWith('crest_') || k === 'T_melt' || k === 'T_room' || k === 'Cp' || 
                    k === 'rho' || k === 'detonation_energy' || k === 'det_vel' || k.startsWith('jwl_') || k.startsWith('ideal_')
                );
                addGroup('mat_visco_eos', 'Viscoplasticity & Shock EOS', viscoKeys);

                const failureKeys = visibleKeys.filter(k => 
                    k === 'failure_strain' || k === 'tensile_failure_stress' || k === 'directional_crack_band' || k === 'nonlocal_radius' || 
                    k.includes('erosion')
                );
                addGroup('mat_failure', 'Constitutive Failure & Erosion', failureKeys);

                const flawsKeys = visibleKeys.filter(k => 
                    k === 'enable_heterogeneity' || k.startsWith('weibull_') || k === 'fracture_toughness' || k === 'debris_bulk_factor' || k === 'dem_transition_enabled' || k.startsWith('fragment_')
                );
                addGroup('mat_flaws_dem', 'Microstructural Flaws & Heterogeneity', flawsKeys);

                const anisoKeys = visibleKeys.filter(k => 
                    k === 'enable_anisotropy' || k.startsWith('anisotropy_')
                );
                addGroup('mat_aniso', 'Directional Anisotropy & Orthotropy', anisoKeys);
            }

            const remainingMat = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('mat_general', 'General Parameters', remainingMat);
            return groups;
        }

        if (node.type === 'MPMDomain2D' || node.type === 'MPMDomain3D') {
            addGroup('mpm_numerics', 'Discretization & Particle Formulation', ['particle_distribution', 'boundary_filling', 'ppc', 'smooth_plastic_strain']);
            addGroup('mpm_time', 'Velocity Scheme & Time Stepping', ['velocity_scheme', 'flip_blend', 'space_time_scheme', 'cfl', 'endtime']);
            addGroup('mpm_hardware', 'Hardware & Precision', ['device', 'precision']);
            const remaining = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('general', 'General & Custom Parameters', remaining);
            return groups;
        }

        if (node.type === 'MPMObject2D' || node.type === 'MPMObject3D') {
            addGroup('mpm_seeding', 'Particle Seeding & Discretization', ['particle_distribution', 'boundary_filling']);
            addGroup('mpm_geom', 'Geometry, Mesh & Domain Bounds', ['shape_type', 'pos_x', 'pos_y', 'pos_z', 'size_x', 'size_y', 'size_z', 'radius', 'inner_radius', 'height', 'stl_file', 'scale_x', 'scale_y', 'scale_z']);
            addGroup('mpm_kinematics', 'Boundary Conditions & Kinematics', ['vel_x', 'vel_y', 'vel_z', 'angular_vel', 'angular_vel_x', 'angular_vel_y', 'angular_vel_z']);
            const remaining = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('general', 'General & Custom Parameters', remaining);
            return groups;
        }

        if (node.type === 'FEMDomain3D') {
            addGroup('fem_numerics', 'Hardware & Time Integration', ['device', 'precision', 'cfl', 'endtime', 'integration_scheme', 'hourglass_model', 'hourglass_coeff']);
            addGroup('fem_contact', 'Contact & Interface Dynamics', ['contact_penalty_scale', 'friction_static', 'friction_kinetic']);
            addGroup('fem_hetero_aniso', 'Material Heterogeneity & Directional Anisotropy', [
                'enable_heterogeneity', 'material_heterogeneity',
                'enable_anisotropy', 'anisotropy_ratio', 'anisotropy_axis', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z'
            ]);
            addGroup('fem_damage', 'Damage & Debris', [
                'enable_directional_crack_band', 'enable_nonlocal_damage',
                'debris_velocity_smoothing', 'debris_clumping', 'debris_max_clump_size', 'random_seed',
                'rebar_formulation', 'convert_failed_elements_to_mpm', 'mpm_particles_per_failed_element'
            ]);
            const remaining = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('general', 'General & Custom Parameters', remaining);
            return groups;
        }

        if (node.type === 'FEMObject3D') {
            addGroup('fem_geom', 'Geometry & Mesh Discretization', ['mesh_source', 'shape_type', 'pos_x', 'pos_y', 'pos_z', 'size_x', 'size_y', 'size_z', 'radius', 'inner_radius', 'height', 'nx', 'ny', 'nz', 'k_file', 'scale_factor']);
            addGroup('fem_bc', 'Boundary Conditions & Kinematics', ['boundary_condition', 'vel_x', 'vel_y', 'vel_z']);
            addGroup('fem_visco', 'Viscosity & Time Step Control', ['bulk_viscosity_b1', 'bulk_viscosity_b2', 'timestep_erosion_factor']);
            const remaining = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('general', 'General & Custom Parameters', remaining);
            return groups;
        }

        if (node.type === 'FEMFSICoupler3D') {
            addGroup('fsi_numerics', 'FSI Coupling & Time Stepping', ['cfl', 'endtime', 'steps', 'coupling_scheme', 'pressure_integration']);
            addGroup('fsi_interface', 'Fluid Interface & Cavitation', ['uncovering_method', 'erosion_venting', 'vacuum_density', 'vacuum_pressure']);
            const remaining = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('general', 'General & Custom Parameters', remaining);
            return groups;
        }

        if (node.type === 'FSICoupler2D' || node.type === 'FSICoupler3D') {
            addGroup('fsi_numerics', 'FSI Coupling & Numerics', ['cfl', 'endtime', 'coupling_interval', 'coupling_scheme', 'interpolation_scheme', 'fsi_substeps']);
            addGroup('fsi_structure', 'Structural Dynamics & Properties', ['structure_motion_type', 'structure_mass', 'structure_stiffness', 'structure_damping', 'structure_init_pos', 'structure_init_vel']);
            const remaining = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('general', 'General & Custom Parameters', remaining);
            return groups;
        }

        if (node.type === 'DomainMesh' || node.type === 'DomainMesh2D' || node.type === 'DomainMesh3D') {
            addGroup('mesh_geom', 'Domain Resolution & Grid Geometry', [
                'dimension', 'coordinate_system', 'domain_radius',
                'xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax',
                'x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max',
                'min_r', 'max_r', 'min_z', 'max_z',
                'cell_size', 'nx', 'ny', 'nz'
            ]);
            addGroup('mesh_bc', 'Boundary Conditions', [
                'left_bc', 'right_bc',
                'bc_x_min', 'bc_x_max', 'bc_y_min', 'bc_y_max', 'bc_z_min', 'bc_z_max',
                'bc_r_min', 'bc_r_max', 'bc_z_min', 'bc_z_max',
                'x_min_bc', 'x_max_bc', 'y_min_bc', 'y_max_bc', 'z_min_bc', 'z_max_bc'
            ]);
            const remaining = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('general', 'General & Custom Parameters', remaining);
            return groups;
        }

        if (node.type === 'CFDSolver' || node.type === 'CFDSolver2D' || node.type === 'CFDSolver3D') {
            addGroup('cfd_numerics', 'Numerics, Flux & Time Stepping', ['cfl', 'endtime', 'space_time_scheme', 'flux_scheme', 'slope_limiter', 'time_scheme']);
            addGroup('cfd_hardware', 'Hardware & Execution Mode', ['device', 'precision', 'init_mode', 'telemetry_mode', 'telemetry_interval_ms', 'enable_gauges', 'enable_vtk']);
            const remaining = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('general', 'General & Custom Parameters', remaining);
            return groups;
        }

        if (node.type === 'Charge1D' || node.type === 'Charge2D' || node.type === 'Charge3D') {
            addGroup('charge_mat', 'Explosive Material & EOS', ['material']);
            addGroup('charge_mass_shape', 'Explosive Mass & Charge Shape', ['charge_mass', 'charge_shape']);
            addGroup('charge_geom', 'Spatial Placement & Dimensions', ['charge_x', 'charge_y', 'charge_z', 'charge_r', 'charge_radius', 'charge_height', 'charge_aspect_ratio', 'charge_lx', 'charge_ly', 'charge_lz', 'charge_rot_x', 'charge_rot_y', 'charge_rot_z']);
            addGroup('charge_display', 'Display Properties', ['charge_opacity']);
            const remaining = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('general', 'General & Custom Parameters', remaining);
            return groups;
        }

        if (['MPMObject2D', 'MPMObject3D', 'FEMObject3D'].includes(node.type as string)) {
            addGroup('obj_mat', 'Constitutive Material & EOS', ['material']);
            addGroup('obj_geom', 'Geometry & Placement', ['shape_type', 'boundary_condition', 'pos_x', 'pos_y', 'pos_z', 'size_x', 'size_y', 'size_z', 'radius', 'inner_radius', 'height', 'nx', 'ny', 'nz', 'scale_x', 'scale_y', 'scale_z', 'stl_file', 'k_file']);
            addGroup('obj_kinematics', 'Initial Kinematics & Velocity', ['vel_x', 'vel_y', 'vel_z', 'angular_vel', 'angular_vel_x', 'angular_vel_y', 'angular_vel_z']);
            addGroup('obj_sampling', 'Particle Distribution & Boundary', ['particle_distribution', 'boundary_filling']);
            const remaining = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('general', 'General & Custom Parameters', remaining);
            return groups;
        }

        if (node.type === 'DetonatorLocation' || node.type === 'DetonatorLocation3D') {
            addGroup('det_geom', 'Detonator Geometry & Position', ['detonator_x', 'detonator_y', 'detonator_z', 'detonator_r', 'detonator_radius']);
            addGroup('det_timing', 'Initiation Timing', ['detonator_time']);
            const remaining = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('general', 'General & Custom Parameters', remaining);
            return groups;
        }

        if (node.type === 'RemapNode' || node.type === 'Remap1DTo2DNode' || node.type === 'Remap1DTo3DNode' || node.type === 'Remap2DTo3DNode') {
            addGroup('remap_numerics', 'Remapping Numerics & Grid', ['remap_time', 'target_cell_size', 'interpolation_method', 'trigger_type', 'trigger_val']);
            addGroup('remap_geom', 'Spatial Position & Radius', ['explosive_x', 'explosive_y', 'explosive_z', 'explosive_r', 'remap_radius']);
            const remaining = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('general', 'General & Custom Parameters', remaining);
            return groups;
        }

        if (node.type === 'VTKOutput') {
            addGroup('vtk_format', 'Output Triggers & Formats', ['trigger_type', 'step_interval', 'time_interval', 'vtk_format', 'custom_filename', 'vtk_dir', 'export_pvd', 'compression_level']);
            addGroup('vtk_domains', 'Physics Domains & Strides', ['export_cfd_2d', 'export_slices', 'export_volumes', 'export_obstacles', 'export_stl_faces', 'stl_outside_domain', 'tessellate_stl_faces', 'tessellation_max_edge', 'export_fem', 'export_mpm', 'volume_stride', 'slice_stride', 'roi_enabled', 'roi_xmin', 'roi_xmax', 'roi_ymin', 'roi_ymax', 'roi_zmin', 'roi_zmax', 'downsample_stride', 'fields']);
            addGroup('vtk_cfd_qty', 'CFD Eulerian Fluid Fields', ['qty_pressure', 'qty_density', 'qty_velocity', 'qty_energy', 'qty_reacted', 'qty_unreacted', 'qty_air', 'qty_overpressure', 'qty_impulse']);
            addGroup('vtk_fem_qty', 'Solid FEM Structural Fields', ['qty_fem_stress', 'qty_fem_strain', 'qty_fem_pressure', 'qty_fem_temp', 'qty_fem_damage', 'qty_fem_vel', 'qty_fem_disp']);
            addGroup('vtk_mpm_qty', 'Solid MPM Particle Fields', ['qty_mpm_stress', 'qty_mpm_strain', 'qty_mpm_damage', 'qty_mpm_temp', 'qty_mpm_vel', 'qty_mpm_disp']);
            const remaining = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('general', 'General & Custom Parameters', remaining);
            return groups;
        }

        if (node.type === 'VirtualGauges') {
            addGroup('gauges_format', 'Formats & Exporters', ['export_ascii', 'export_binary', 'export_hdf5']);
            addGroup('gauges_config', 'File & Sampling Config', ['source_mode', 'external_file_path', 'external_file_format', 'storage_backend', 'sampling_stride_steps', 'ascii_delimiter', 'ascii_precision', 'custom_filename', 'output_dir', 'include_header', 'sample_rate', 'channel', 'plot_stride', 'x_axis_mode']);
            addGroup('gauges_quantities', 'Gauged Physical Fields', ['qty_pressure', 'qty_density', 'qty_velocity', 'qty_energy', 'qty_reacted', 'qty_unreacted', 'qty_air', 'qty_overpressure', 'qty_impulse']);
            const remaining = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('general', 'General & Custom Parameters', remaining);
            return groups;
        }

        if (node.type === 'TelemetryGraph' || node.type === 'TelemetryContour') {
            addGroup('telemetry_sampling', 'Sampling & Channel Settings', ['telemetry_channel', 'x_axis_mode', 'plot_stride', 'downsample_stride', 'refresh_rate']);
            addGroup('telemetry_display', 'Display & Color Mapping', ['colormap', 'min_y', 'max_y', 'show_grid', 'auto_scale', 'log_scale', 'interpolate']);
            const remaining = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('general', 'General & Custom Parameters', remaining);
            return groups;
        }

        if (node.type === 'LSDynaImporter3D') {
            addGroup('dyna_import', 'LS-DYNA Input & Scaling', ['k_file', 'scale_factor']);
            const remaining = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('general', 'General & Custom Parameters', remaining);
            return groups;
        }

        if (node.type === 'STLGeometry') {
            addGroup('stl_import', 'CAD Geometry & Voxelization', ['stl_file', 'geometry_hash', 'voxelization_method']);
            const remaining = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('general', 'General & Custom Parameters', remaining);
            return groups;
        }

        if (node.type === 'PrimitiveGeometry3D') {
            addGroup('primitive_geom', 'Geometric Primitives & Voxelization', ['primitives', 'voxelization_method']);
            const remaining = visibleKeys.filter(k => !assignedKeys.has(k));
            addGroup('general', 'General & Custom Parameters', remaining);
            return groups;
        }

        // Generic fallback for any other custom node
        const numericsKeys = visibleKeys.filter(k => !assignedKeys.has(k) && (k.includes('cfl') || k.includes('order') || k.includes('flux') || k.includes('scheme') || k.includes('limiter') || k.includes('device') || k.includes('precision') || k.includes('threads') || k.includes('distribution') || k.includes('filling') || k.includes('blend') || k.includes('ppc') || k.includes('integration') || k.includes('hourglass') || k.includes('steps') || k.includes('uncovering')));
        addGroup('numerics', 'Numerics, Hardware & Time Stepping', numericsKeys);

        const meshKeys = visibleKeys.filter(k => !assignedKeys.has(k) && (k.includes('dim') || k.includes('cell') || k.includes('domain') || k.startsWith('n') || k.includes('radius') || k.includes('length') || k.includes('width') || k.includes('height') || k.includes('pos_') || k.includes('size_') || k.includes('stl_') || k.includes('k_file') || k.includes('scale_')));
        addGroup('mesh', 'Geometry, Mesh & Domain Bounds', meshKeys);

        const bcKeys = visibleKeys.filter(k => !assignedKeys.has(k) && (k.includes('_bc') || k.includes('bc_') || k.includes('boundary') || k.includes('vel_')));
        addGroup('bc', 'Boundary Conditions & Kinematics', bcKeys);

        const materialKeys = visibleKeys.filter(k => !assignedKeys.has(k) && (k.includes('rho') || k.includes('gamma') || k.includes('jwl') || k.includes('pressure') || k.includes('temperature') || k.includes('preset') || k.includes('composition') || k.includes('energy') || k.includes('det_')));
        addGroup('material', 'Thermodynamics & Material EOS', materialKeys);

        const otherKeys = visibleKeys.filter(k => !assignedKeys.has(k));
        addGroup('general', 'General & Custom Parameters', otherKeys);

        return groups;
    }

    private syncMaterialConnection(nodeId: string, matId: string): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        state.connections = state.connections.filter(c => 
            !(c.toNode === nodeId && c.toPort === 'material') &&
            !(c.fromNode === nodeId && c.fromPort === 'material')
        );

        if (matId) {
            const matNode = state.nodes.find(n => n.id === matId);
            if (matNode) {
                state.connections.push({
                    fromNode: matId,
                    fromPort: 'out',
                    toNode: nodeId,
                    toPort: 'material'
                });
            }
        }

        const targetModel = this.stateManager.getModelForNode(nodeId) || this.stateManager.getActiveModel();
        if (targetModel) {
            this.stateManager.setModelStatus(targetModel.id, 'UNINITIALIZED');
        }
        this.stateManager.pushState(state);
    }

    public destroy(): void {
        this.stateManager.offStateChange(this.stateListener);
        this.stateManager.offInPlaceParameterChange(this.inPlaceListener);
        this.stateManager.offSelectionChange(this.selectionListener);
        this.stateManager.offSliceSelectionChange(this.sliceSelectionListener);
        this.stateManager.offGaugeSelectionChange(this.gaugeSelectionListener);
        this.container.innerHTML = '';
    }
}
