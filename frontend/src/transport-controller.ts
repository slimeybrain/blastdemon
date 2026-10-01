/**
 * BlastDaemon TransportController
 * Unified Multi-Tab, Multi-Row, and Grid-Structured Workstation Control Bar (ParaView-style):
 * Tab 1: Simulation Master Execution & Scrubber Timeline
 * Tab 2: Viewport Camera, Projections, Fields & Layer Visibility Grid
 * Tab 3: Full Slices Table & Matrix Controls
 * Tab 4: 3D Surface Shading, Lighting & Telemetry Quality
 * Tab 5: Virtual Gauges Probes, ROI Bounding Box & Element Filters
 * Tab 6: Context-Sensitive 3D Selected Object Quick Editor
 */

import { PlaybackRingBuffer, BufferedFrame } from './playback-buffer.js';
import { StateManager, resolveSliceDomainBounds, canonicalizeQuantity, DEFAULT_QUANTITY_RANGES, getSliceAxisLabel } from './state-manager.js';
import { SimulationStatus } from './types.js';

export type CameraPreset = 'iso' | '+x' | '-x' | '+y' | '-y' | '+z' | '-z' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'reset';
export type ColormapType = 'rainbow' | 'plasma' | 'viridis' | 'inferno' | 'magma' | 'coolwarm' | 'cividis' | 'turbo' | 'jet' | 'grayscale';
export type WorkstationTab = 'sim_view' | 'camera_view' | 'slices_matrix' | 'shading_lighting' | 'gauges_roi' | 'context_object';

export interface TransportControllerOptions {
    container?: HTMLElement;
    containerId?: string;
    playbackBuffer: PlaybackRingBuffer;
    stateManager: StateManager;
    onFrameDispatch?: (frame: BufferedFrame, isLive: boolean, source?: TransportController) => void;
    onPlaybackStateChange?: (isPlaying: boolean, source?: TransportController) => void;
    onCameraSnap?: (preset: CameraPreset | string) => void;
    onProjectionToggle?: (perspective: boolean) => void;
    onSliceToggle?: (plane: 'xy' | 'xz' | 'yz', enabled: boolean, offset: number) => void;
    onSliceConfigChange?: (slices: any[]) => void;
    onColormapChange?: (colormap: ColormapType | string, min?: number, max?: number, targetLayer?: string) => void;
    onQuantityChange?: (quantity: string, targetLayer?: string) => void;
    onLayerToggle?: (layer: string, active: boolean) => void;
    onRefreshRateChange?: (rate: number) => void;
    onShadingChange?: (key: string, value: any) => void;
    onROIChange?: (roi: any) => void;
    onParticleFilterChange?: (filter: any) => void;
    onSimCommand?: (command: 'INIT' | 'STEP' | 'EXEC_ALL' | 'PAUSE' | 'TERMINATE' | 'RESET' | 'RUN' | 'REFRESH', extra?: { steps?: number }) => void;
    onManualRefresh?: () => void;
}

export interface SelectedObjectInfo {
    objectType: string;
    objectId?: string;
    childId?: string;
    sliceIndex?: number;
    gaugeIndex?: number;
    label: string;
    nodeId?: string;
    position?: number[];
}

export type ContextTargetType = 'slice' | 'fem' | 'mpm' | 'stl' | 'obstacles' | 'charge' | 'detonator' | 'gauges' | 'global';

export interface ContextualVisualSettings {
    targetType: ContextTargetType;
    targetLabel: string;
    targetIcon: string;
    nodeId?: string;
    sliceIndex?: number;
    gaugeIndex?: number;
    
    // Field / Quantity
    quantity: string;
    availableQuantities: Array<{ val: string; label: string }>;
    
    // Colormap
    colormap: ColormapType | string;
    
    // Range
    autoScale: boolean;
    minVal: number;
    maxVal: number;
    logScale: boolean;
    isLocked?: boolean;
    contourLevels?: number;
    smoothContours?: boolean;
    
    // Toggles
    showColorbar: boolean;
    showMeshLines: boolean; // wireframe / gridlines / mesh
    visibility: boolean;
    lighting?: boolean;
    interpolate?: boolean;

    // Slice-specific
    sliceAxis?: string;
    sliceOffset?: number;
    sliceOpacity?: number;
    sliceStride?: number;
    domainMin?: number;
    domainMax?: number;

    // Entity-specific
    opacity?: number;
}

export class TransportController {
    private container: HTMLElement;
    private buffer: PlaybackRingBuffer;
    private stateManager: StateManager;

    // Active Tab
    private activeTab: WorkstationTab = 'sim_view';

    // Transport & Playback State
    private isPlaying: boolean = false;
    private isLiveLocked: boolean = true;
    private currentFrameIndex: number = -1;
    private playbackSpeed: number = 1.0;
    private loopPlayback: boolean = false;
    private animFrameId: number | null = null;
    private lastAnimTimestamp: number = 0;

    // Primary Viewport State
    private usePerspective: boolean = true;
    private cockpitProjBtn: HTMLElement | null = null;
    private tabProjBtn: HTMLElement | null = null;
    private activeQuantity: string = 'pressure';
    private activeColormap: ColormapType = 'rainbow';
    private activeLayers: Record<string, boolean> = {
        slices: true,
        fem: true,
        beams: true,
        mpm: true,
        stl: true,
        obstacles: true,
        grid: true,
        gridBox: true,
        gauges: true,
        lighting: true
    };

    // Slices Matrix State
    private activeSliceIndex: number = 0;
    private activeSlicePlane: 'xy' | 'xz' | 'yz' = 'xy';
    private sliceEnabled: boolean = true;
    private sliceOffsetPercent: number = 0;

    // Shading & Visuals State
    private representationStyle: 'solid' | 'edges' | 'wireframe' | 'points' = 'solid';
    private ambientLevel: number = 0.5;
    private specularIntensity: number = 0.5;
    private aoEnabled: boolean = true;
    private aoRadius: number = 0.15;
    private aoIntensity: number = 1.2;
    private aoBias: number = 0.005;
    private aoSphereImpostor: boolean = true;
    private mpmParticleDiameter: number = 0.005;
    private showGrid: boolean = true;
    private showGridBox: boolean = true;
    private gridOpacity: number = 0.4;
    private autoScale: boolean = true;
    private logScale: boolean = false;
    private minScalarVal: number = 0.0;
    private maxScalarVal: number = 100.0;
    private refreshRate: number = 0.5;
    private simRunnerFpsSelect: HTMLSelectElement | null = null;
    private cameraTabFpsSelect: HTMLSelectElement | null = null;

    // ROI & Filter State
    private roiEnabled: boolean = false;
    private roiXMin: number = -1.0;
    private roiXMax: number = 1.0;
    private roiYMin: number = -1.0;
    private roiYMax: number = 1.0;
    private roiZMin: number = -1.0;
    private roiZMax: number = 1.0;
    private hideEroded: boolean = true;
    private minDamageThreshold: number = 0.0;
    private particleStride: number = 1;

    // Context-Sensitive Selected Object Info
    private selectedObject: SelectedObjectInfo | null = null;

    // UI Coalescing & Throttling State
    private statsUpdatePending: boolean = false;
    private pendingStep?: number;
    private pendingTime?: number;
    private pendingDt?: number;
    private pendingFrame?: BufferedFrame;
    private pendingTotalCount?: number;

    // Callbacks
    private onFrameDispatch?: (frame: BufferedFrame, isLive: boolean, source?: TransportController) => void;
    private onPlaybackStateChange?: (isPlaying: boolean, source?: TransportController) => void;
    private onCameraSnap?: (preset: CameraPreset | string) => void;
    private onProjectionToggle?: (perspective: boolean) => void;
    private onSliceToggle?: (plane: 'xy' | 'xz' | 'yz', enabled: boolean, offset: number) => void;
    public onSliceConfigChange?: (slices: any[]) => void;
    private onColormapChange?: (colormap: ColormapType | string, min?: number, max?: number, targetLayer?: string) => void;
    private onQuantityChange?: (quantity: string, targetLayer?: string) => void;
    private onLayerToggle?: (layer: string, active: boolean) => void;
    private onRefreshRateChange?: (rate: number) => void;
    private onShadingChange?: (key: string, value: any) => void;
    private onROIChange?: (roi: any) => void;
    private onParticleFilterChange?: (filter: any) => void;
    private onSimCommand?: (command: 'INIT' | 'STEP' | 'EXEC_ALL' | 'PAUSE' | 'TERMINATE' | 'RESET' | 'RUN' | 'REFRESH', extra?: { steps?: number }) => void;
    private onManualRefresh?: () => void;

    // Multi-Instance & Lifecycle State
    private unbinds: (() => void)[] = [];
    private statsFlushRafId: number | null = null;

    // Root Elements
    private rootElement!: HTMLElement;
    private tabsHeader!: HTMLElement;
    private tabContentContainer!: HTMLElement;

    // Live Readout Elements
    private playPauseBtn?: HTMLButtonElement;
    private liveLockBtn!: HTMLButtonElement;
    private scrubberSlider?: HTMLInputElement;
    private timeDisplay!: HTMLElement;
    private stepDisplay!: HTMLElement;
    private bufferCountDisplay!: HTMLElement;
    private statusBadge!: HTMLElement;
    private modelInfoBadge!: HTMLElement;

    // Live Execution Stats Elements (Step, Total Time, dt)
    private execStepValue: HTMLElement | null = null;
    private execTimeValue: HTMLElement | null = null;
    private execDtValue: HTMLElement | null = null;

    constructor(options: TransportControllerOptions) {
        this.buffer = options.playbackBuffer;
        this.stateManager = options.stateManager;
        this.onFrameDispatch = options.onFrameDispatch;
        this.onPlaybackStateChange = options.onPlaybackStateChange;
        this.onCameraSnap = options.onCameraSnap;
        this.onProjectionToggle = options.onProjectionToggle;
        this.onSliceToggle = options.onSliceToggle;
        this.onSliceConfigChange = options.onSliceConfigChange;
        this.onColormapChange = options.onColormapChange;
        this.onQuantityChange = options.onQuantityChange;
        this.onLayerToggle = options.onLayerToggle;
        this.onRefreshRateChange = options.onRefreshRateChange;
        this.onShadingChange = options.onShadingChange;
        this.onROIChange = options.onROIChange;
        this.onParticleFilterChange = options.onParticleFilterChange;
        this.onSimCommand = options.onSimCommand;
        this.onManualRefresh = options.onManualRefresh;

        if (options.container) {
            this.container = options.container;
        } else if (options.containerId) {
            const el = document.getElementById(options.containerId);
            if (el) this.container = el;
            else {
                this.container = document.createElement('div');
                this.container.id = options.containerId;
                document.body.appendChild(this.container);
            }
        } else {
            this.container = document.createElement('div');
            document.body.appendChild(this.container);
        }

        this.syncStateFromViewport();
        this.buildUI();
        this.attachBufferListeners();

        // Single Source of Truth: Listen for any parameter or state mutations across the DAG
        this.stateManager.onInPlaceParameterChange((nodeId, _params) => {
            const vpNode = this.getActiveViewportNode();
            const ctx = this.getCurrentContextSettings();
            if (vpNode?.id === nodeId || ctx.nodeId === nodeId) {
                this.syncStateFromViewport();
                this.requestTabRender();
            }
        });
        this.stateManager.onStateChange(() => {
            this.syncStateFromViewport();
            this.requestTabRender();
        });
        this.stateManager.onSelectionChange(() => {
            this.syncStateFromViewport();
            this.requestTabRender();
        });
        this.stateManager.onSliceSelectionChange(() => {
            this.syncStateFromViewport();
            this.requestTabRender();
        });
    }

    public isLayerActive(key: string): boolean {
        const vpNode = this.getActiveViewportNode();
        if (!vpNode || !vpNode.parameters) {
            return this.activeLayers[key] !== false;
        }
        const p = vpNode.parameters;
        const activeModel = this.stateManager.getActiveModel();
        switch (key) {
            case 'slices':
                return p.show_slices !== false && (p.slices && p.slices.length > 0 ? p.slices.some((s: any) => s.enabled !== false) : true);
            case 'grid':
                return p.show_grid !== false;
            case 'gridBox':
                return p.show_grid_box !== false;
            case 'fem': {
                if (p.showFEMMesh === false) return false;
                const femObjects = activeModel?.nodes?.filter((n: any) => n.type === 'FEMObject3D' || n.type === 'LSDynaImporter3D') || [];
                if (femObjects.length > 0 && femObjects.every((n: any) => n.parameters?.visible === false || n.parameters?.hidden === true)) {
                    return false;
                }
                return (p.femSolid !== false || p.femWireframe !== false);
            }
            case 'mpm': {
                if (p.showMPMParticles === false) return false;
                const mpmObjects = activeModel?.nodes?.filter((n: any) => n.type === 'MPMObject3D' || n.type === 'MarineHarbourDomain' || n.type === 'MPMDomain3D') || [];
                if (mpmObjects.length > 0) {
                    const allHidden = mpmObjects.every((n: any) => {
                        if (n.type === 'MarineHarbourDomain') {
                            return (n.parameters?.show_water_sleeve === false && n.parameters?.show_soil_mpm === false) || n.parameters?.visible === false || n.parameters?.hidden === true;
                        }
                        return n.parameters?.visible === false || n.parameters?.hidden === true;
                    });
                    if (allHidden) return false;
                }
                return true;
            }
            case 'beams': {
                if (p.showBeams === false && p.showRebar === false) return false;
                const beamObjects = activeModel?.nodes?.filter((n: any) => n.type === 'FEMBeam3D' || n.type === 'FEMRebar3D') || [];
                if (beamObjects.length > 0 && beamObjects.every((n: any) => n.parameters?.visible === false || n.parameters?.hidden === true)) {
                    return false;
                }
                return (p.beamSolid !== false || p.rebarSolid !== false || p.beamWireframe !== false || p.rebarWireframe !== false);
            }
            case 'stl': {
                if (p.show_stl === false) return false;
                const stlObjects = activeModel?.nodes?.filter((n: any) => n.type === 'STLGeometry' || n.type === 'CADDomain3D') || [];
                if (stlObjects.length > 0 && stlObjects.every((n: any) => n.parameters?.visible === false || n.parameters?.hidden === true)) {
                    return false;
                }
                return true;
            }
            case 'obstacles': {
                if (p.show_obstacles === false) return false;
                const obsObjects = activeModel?.nodes?.filter((n: any) => n.type === 'ObstacleDomain3D' || n.type === 'Obstacle3D' || n.type === 'ImmersedObstacle') || [];
                if (obsObjects.length > 0 && obsObjects.every((n: any) => n.parameters?.visible === false || n.parameters?.hidden === true)) {
                    return false;
                }
                return true;
            }
            case 'gauges':
                return p.show_gauges !== false;
            case 'lighting':
                return p.lightingEnabled !== false;
            default:
                return this.activeLayers[key] !== false;
        }
    }

    public syncStateFromViewport(): void {
        const activeModel = this.stateManager.getActiveModel();
        if (activeModel) {
            this.refreshRate = this.stateManager.getModelRefreshRate(activeModel.id);
        }

        const syncSelect = (sel: HTMLSelectElement | null) => {
            if (!sel) return;
            for (let i = 0; i < sel.options.length; i++) {
                const val = parseFloat(sel.options[i].value);
                if (Math.abs(val - this.refreshRate) < 0.0005 || (val > 0 && Math.abs(val - this.refreshRate) / val < 0.05)) {
                    sel.selectedIndex = i;
                    break;
                }
            }
        };
        syncSelect(this.simRunnerFpsSelect);
        syncSelect(this.cameraTabFpsSelect);

        const vpNode = this.getActiveViewportNode();
        if (!vpNode || !vpNode.parameters) return;
        const p = vpNode.parameters;

        this.activeLayers = {
            slices: this.isLayerActive('slices'),
            grid: this.isLayerActive('grid'),
            gridBox: this.isLayerActive('gridBox'),
            fem: this.isLayerActive('fem'),
            mpm: this.isLayerActive('mpm'),
            beams: this.isLayerActive('beams'),
            stl: this.isLayerActive('stl'),
            obstacles: this.isLayerActive('obstacles'),
            gauges: this.isLayerActive('gauges'),
            lighting: this.isLayerActive('lighting')
        };

        if (p.usePerspective !== undefined) {
            this.usePerspective = p.usePerspective !== false;
            this.syncProjectionButtons();
        }
        if (!activeModel && p.refresh_rate !== undefined) {
            this.refreshRate = Number(p.refresh_rate);
            syncSelect(this.simRunnerFpsSelect);
            syncSelect(this.cameraTabFpsSelect);
        }
        if (p.colormap !== undefined) {
            this.activeColormap = p.colormap;
        }
        if (p.focusedQuantity !== undefined) {
            this.activeQuantity = p.focusedQuantity;
        }

        this.updateAllLayerChips();
    }

    public toggleLayer(key: string): void {
        const currentActive = this.isLayerActive(key);
        const nextActive = !currentActive;
        this.activeLayers[key] = nextActive;
        const vpNode = this.getActiveViewportNode();
        const activeModel = this.stateManager.getActiveModel();
        if (vpNode) {
            const updates: Record<string, any> = {};
            switch (key) {
                case 'slices': {
                    updates.show_slices = nextActive;
                    const currentSlices = vpNode.parameters.slices || [];
                    const slices = currentSlices.map((s: any) => ({ ...s, enabled: nextActive }));
                    updates.slices = slices;
                    const domainNode = this.getActiveDomainNode();
                    if (domainNode) {
                        this.stateManager.updateNodeParametersInPlace(domainNode.id, { slices });
                    }
                    this.onSliceConfigChange?.(slices);
                    break;
                }
                case 'grid': updates.show_grid = nextActive; break;
                case 'gridBox': updates.show_grid_box = nextActive; break;
                case 'fem': {
                    updates.showFEMMesh = nextActive;
                    if (nextActive && vpNode.parameters.femSolid === false && vpNode.parameters.femWireframe === false) {
                        updates.femSolid = true;
                        updates.femWireframe = true;
                    }
                    if (activeModel) {
                        activeModel.nodes
                            .filter((n: any) => n.type === 'FEMObject3D' || n.type === 'FEMDomain3D' || n.type === 'LSDynaImporter3D')
                            .forEach((n: any) => {
                                this.stateManager.updateNodeParametersInPlace(n.id, { visible: nextActive, hidden: !nextActive, showFEMMesh: nextActive });
                            });
                    }
                    break;
                }
                case 'mpm': {
                    updates.showMPMParticles = nextActive;
                    if (activeModel) {
                        activeModel.nodes
                            .filter((n: any) => n.type === 'MPMObject3D' || n.type === 'MPMDomain3D' || n.type === 'MPMObject2D' || n.type === 'MarineHarbourDomain')
                            .forEach((n: any) => {
                                if (n.type === 'MarineHarbourDomain') {
                                    this.stateManager.updateNodeParametersInPlace(n.id, {
                                        visible: nextActive,
                                        hidden: !nextActive,
                                        show_water_sleeve: nextActive,
                                        show_soil_mpm: nextActive
                                    });
                                } else {
                                    this.stateManager.updateNodeParametersInPlace(n.id, { visible: nextActive, hidden: !nextActive, showMPMParticles: nextActive });
                                }
                            });
                    }
                    this.onShadingChange?.('show_water_sleeve', nextActive);
                    this.onShadingChange?.('show_soil_mpm', nextActive);
                    break;
                }
                case 'beams': {
                    updates.showBeams = nextActive;
                    updates.showRebar = nextActive;
                    if (nextActive && (vpNode.parameters.beamSolid === false || vpNode.parameters.rebarSolid === false) && (vpNode.parameters.beamWireframe === false || vpNode.parameters.rebarWireframe === false)) {
                        updates.beamSolid = true;
                        updates.beamWireframe = true;
                        updates.rebarSolid = true;
                        updates.rebarWireframe = true;
                    }
                    if (activeModel) {
                        activeModel.nodes
                            .filter((n: any) => n.type === 'FEMBeam3D' || n.type === 'FEMRebar3D' || n.type === 'StructuralObject3D')
                            .forEach((n: any) => {
                                this.stateManager.updateNodeParametersInPlace(n.id, { visible: nextActive, hidden: !nextActive, showBeams: nextActive, showRebar: nextActive });
                            });
                    }
                    break;
                }
                case 'stl': {
                    updates.show_stl = nextActive;
                    if (activeModel) {
                        activeModel.nodes
                            .filter((n: any) => n.type === 'STLGeometry' || n.type === 'CADDomain3D')
                            .forEach((n: any) => {
                                this.stateManager.updateNodeParametersInPlace(n.id, { visible: nextActive, hidden: !nextActive, show_stl: nextActive });
                            });
                    }
                    break;
                }
                case 'obstacles': {
                    updates.show_obstacles = nextActive;
                    if (activeModel) {
                        activeModel.nodes
                            .filter((n: any) => n.type === 'ObstacleDomain3D' || n.type === 'Obstacle3D' || n.type === 'ImmersedObstacle')
                            .forEach((n: any) => {
                                this.stateManager.updateNodeParametersInPlace(n.id, { visible: nextActive, hidden: !nextActive, show_obstacles: nextActive });
                            });
                    }
                    break;
                }
                case 'gauges': {
                    updates.show_gauges = nextActive;
                    if (activeModel) {
                        activeModel.nodes
                            .filter((n: any) => n.type === 'VirtualGauges3D' || n.type === 'VirtualGaugeProbe3D' || n.type === 'VirtualGauge')
                            .forEach((n: any) => {
                                this.stateManager.updateNodeParametersInPlace(n.id, { visible: nextActive, hidden: !nextActive, show_gauges: nextActive });
                            });
                    }
                    break;
                }
                case 'lighting': updates.lightingEnabled = nextActive; break;
            }
            if (Object.keys(updates).length > 0) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, updates);
            }
        }
        this.updateAllLayerChips();
        this.requestTabRender();
        this.onLayerToggle?.(key, nextActive);
    }

    public setPerspective(perspective: boolean): void {
        this.usePerspective = perspective;
        this.syncProjectionButtons();
    }

    private syncProjectionButtons(): void {
        const text = this.usePerspective ? '👁️ Persp' : '📐 Ortho';
        if (this.cockpitProjBtn) {
            this.cockpitProjBtn.innerHTML = text;
        }
        if (this.tabProjBtn) {
            this.tabProjBtn.innerHTML = text;
        }
    }

    private updateAllLayerChips(): void {
        if (!this.rootElement) return;
        const chips = this.rootElement.querySelectorAll<HTMLElement>('[data-layer-key]');
        chips.forEach(chip => {
            const key = chip.getAttribute('data-layer-key');
            if (key) {
                const active = this.isLayerActive(key);
                this.activeLayers[key] = active;
                chip.classList.toggle('active', active);
            }
        });
    }

    private getActiveViewportNode(): any {
        // 1. Prioritize currently focused 3D viewport
        const focusedId = this.stateManager.getFocusedViewportId();
        if (focusedId) {
            const allModels = this.stateManager.getAllModels();
            for (const m of allModels) {
                const found = m.nodes.find(n => n.id === focusedId || n.id === `virtual-viewport-${focusedId}`);
                if (found) return found;
            }
        }

        // 2. Query active model
        const targetModel = this.stateManager.getActiveModel();
        if (targetModel) {
            let vp = targetModel.nodes.find(n => n.type === 'Telemetry3DViewport');
            if (!vp) {
                const has3D = targetModel.nodes.some(n => 
                    n.type === 'DomainMesh3D' || n.type === 'CFDSolver3D' || 
                    n.type === 'MPMDomain3D' || n.type === 'MPMObject3D' || 
                    n.type === 'FEMDomain3D' || n.type === 'FEMObject3D' || 
                    n.type === 'STLGeometry'
                );
                if (has3D) {
                    this.stateManager.healModelGraph(targetModel);
                    vp = targetModel.nodes.find(n => n.type === 'Telemetry3DViewport');
                }
            }
            if (vp) return vp;
        }

        // 3. Fallback across all models only if no active model exists
        if (!targetModel) {
            return this.stateManager.getAllModels()
                .flatMap(m => m.nodes)
                .find(n => n.type === 'Telemetry3DViewport') || null;
        }
        return null;
    }

    private getActiveDomainNode(): any {
        const targetModel = this.stateManager.getActiveModel();
        if (targetModel) {
            const mesh = targetModel.nodes.find(n => n.type === 'DomainMesh3D' || n.type === 'DomainMesh' || n.type === 'DomainMesh2D');
            if (mesh) return mesh;
            const solver = targetModel.nodes.find(n => ['CFDSolver3D', 'CFDSolver2D', 'CFDSolver', 'MPMDomain3D', 'MPMDomain2D', 'FEMDomain3D'].includes(n.type));
            if (solver) return solver;
        }
        return this.getActiveViewportNode();
    }

    private getAutoParticleDiameter(): number {
        const state = this.stateManager.getCurrentState();
        if (state) {
            const mpmMesh = state.nodes.find(n => n.type === 'DomainMesh3D' || n.type === 'MPMDomain3D' || n.type === 'DomainMesh' || n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain');
            const xmin = Number(mpmMesh?.parameters['xmin'] ?? mpmMesh?.parameters['x_min'] ?? 0);
            const xmax = Number(mpmMesh?.parameters['xmax'] ?? mpmMesh?.parameters['x_max'] ?? 1);
            const nx = Number(mpmMesh?.parameters['nx'] ?? 0);
            let cellSize = 0.001;
            if (nx > 0 && xmax > xmin) {
                cellSize = (xmax - xmin) / nx;
            } else {
                cellSize = Number(mpmMesh?.parameters['cell_size'] ?? mpmMesh?.parameters['dx'] ?? 0.001);
            }
            const mpmObjects = state.nodes.filter(n => n.type === 'MPMObject3D');
            let maxPpc = Number(mpmMesh?.parameters['nearfield_ppc'] ?? mpmMesh?.parameters['ppc'] ?? 8);
            for (const obj of mpmObjects) {
                if (obj.parameters['ppc'] != null) {
                    maxPpc = Math.max(maxPpc, Number(obj.parameters['ppc']));
                }
            }
            const pPerDim = Math.max(1, Math.round(Math.cbrt(maxPpc)));
            return (cellSize / pPerDim) * 0.8;
        }
        return 0.0005;
    }

    /**
     * Attach component to a container.
     */
    public attachTo(container: HTMLElement): void {
        this.container = container;
        if (!this.container.contains(this.rootElement)) {
            this.container.innerHTML = '';
            this.container.appendChild(this.rootElement);
        }
        this.syncStateFromViewport();
        this.renderActiveTabContent();
        this.updateModelStatusDisplay();
    }

    /**
     * Set selected 3D object for quick inspection tab.
     */
    public setSelectedObject(obj: SelectedObjectInfo | null): void {
        this.selectedObject = obj;
        if (obj?.objectType === 'Slice' && obj.sliceIndex !== undefined) {
            this.activeSliceIndex = obj.sliceIndex;
            this.stateManager.setSelectedSliceIndex(obj.sliceIndex);
        } else if (obj === null) {
            this.stateManager.setSelectedSliceIndex(null);
        }
        const contextBtn = this.tabsHeader?.querySelector('.context-tab-btn') as HTMLElement;
        if (contextBtn) {
            contextBtn.style.display = obj ? 'inline-flex' : 'none';
            if (obj) {
                contextBtn.innerHTML = `<span class="tab-icon">📦</span> <span>${obj.label}</span>`;
            }
        }
        this.renderActiveTabContent(true);
    }

    public setSelectedObjectDetails(obj: SelectedObjectInfo | null): void {
        this.setSelectedObject(obj);
    }

    /**
     * Set active slice index for direct matrix editing.
     */
    public setActiveSliceIndex(idx: number): void {
        this.activeSliceIndex = idx;
        const slices = this.getSlices();
        const sl = slices[idx];
        const axisStr = sl ? getSliceAxisLabel(sl.axis) : 'Z-Normal';
        const domainNode = this.getActiveDomainNode();
        const vpNode = this.getActiveViewportNode();
        this.selectedObject = {
            objectType: 'Slice',
            sliceIndex: idx,
            label: `Slice #${idx} (${axisStr})`,
            nodeId: domainNode?.id || vpNode?.id
        };
        this.stateManager.setSelectedSliceIndex(idx);
        this.renderActiveTabContent(true);
    }

    /**
     * Switch active tab programmatically.
     */
    public switchTab(tabId: WorkstationTab): void {
        this.activeTab = tabId;
        const btns = this.tabsHeader.querySelectorAll('.workstation-tab-btn');
        btns.forEach((btn) => {
            btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
        });
        this.renderActiveTabContent();
    }

    /**
     * Build the multi-tab workstation bar.
     */
    private buildUI(): void {
        this.container.innerHTML = '';

        const bar = document.createElement('div');
        bar.className = 'workstation-control-bar';
        this.rootElement = bar;

        // 1. Tab Navigation Header Strip
        this.tabsHeader = document.createElement('div');
        this.tabsHeader.className = 'workstation-tabs-strip';

        const tabs: { id: WorkstationTab; label: string; icon: string; title: string; isContext?: boolean }[] = [
            { id: 'sim_view', label: 'Execution', icon: '▶', title: 'Solver Master Commands & Playback Scrubber' },
            { id: 'camera_view', label: 'Camera & Viewport', icon: '🎥', title: 'Camera Angles, Scalar Fields & Layer Visibility' },
            { id: 'slices_matrix', label: 'Slices Matrix', icon: '🥞', title: 'Detailed Orthogonal Slice Planes Table & Positioning' },
            { id: 'shading_lighting', label: 'Shading & Lighting', icon: '🎨', title: 'Surface Shading, Ambient Lighting & Quality Settings' },
            { id: 'gauges_roi', label: 'Gauges & ROI Filters', icon: '🎯', title: 'Sensor Gauges Probes, ROI Bounding Box & Particle Filters' },
            { id: 'context_object', label: 'Selected Object', icon: '📦', title: 'Context-Sensitive 3D Entity Quick Inspector', isContext: true }
        ];

        const tabsNav = document.createElement('div');
        tabsNav.className = 'workstation-tabs-nav';

        tabs.forEach(t => {
            const btn = document.createElement('button');
            btn.className = `workstation-tab-btn ${this.activeTab === t.id ? 'active' : ''} ${t.isContext ? 'context-tab-btn' : ''}`;
            btn.setAttribute('data-tab', t.id);
            btn.innerHTML = `<span class="tab-icon">${t.icon}</span> <span>${t.label}</span>`;
            btn.title = t.title;
            if (t.isContext && !this.selectedObject) {
                btn.style.display = 'none';
            }
            btn.addEventListener('click', () => {
                this.switchTab(t.id);
            });
            tabsNav.appendChild(btn);
        });

        this.tabsHeader.appendChild(tabsNav);

        // Right status / model quick badge
        const rightStatus = document.createElement('div');
        rightStatus.className = 'workstation-status-strip';

        this.statusBadge = document.createElement('span');
        this.statusBadge.className = 'workstation-status-pill ready';
        this.statusBadge.textContent = 'READY';

        this.modelInfoBadge = document.createElement('span');
        this.modelInfoBadge.className = 'workstation-model-pill';
        this.modelInfoBadge.textContent = 'Active Model';

        rightStatus.appendChild(this.statusBadge);
        rightStatus.appendChild(this.modelInfoBadge);
        this.tabsHeader.appendChild(rightStatus);

        bar.appendChild(this.tabsHeader);

        // 2. Tab Content Container
        this.tabContentContainer = document.createElement('div');
        this.tabContentContainer.className = 'workstation-tab-content';
        bar.appendChild(this.tabContentContainer);

        if (!this.container.contains(bar)) {
            this.container.innerHTML = '';
            this.container.appendChild(bar);
        }

        // Render initial active tab
        this.renderActiveTabContent();
        this.updateModelStatusDisplay();
    }

    private tabRenderRafId: number | null = null;

    public requestTabRender(): void {
        if (this.tabRenderRafId !== null) return;
        this.tabRenderRafId = requestAnimationFrame(() => {
            this.tabRenderRafId = null;
            this.renderActiveTabContent();
        });
    }

    /**
     * Render the active tab content.
     */
    private renderActiveTabContent(force: boolean = false): void {
        if (!force && this.tabContentContainer) {
            const activeEl = document.activeElement;
            if (activeEl && this.tabContentContainer.contains(activeEl)) {
                const tag = activeEl.tagName.toLowerCase();
                if (tag === 'input' || tag === 'select' || tag === 'textarea') {
                    return;
                }
            }
        }

        if (force && this.tabContentContainer) {
            const activeEl = document.activeElement;
            if (activeEl && this.tabContentContainer.contains(activeEl)) {
                (activeEl as HTMLElement).blur?.();
            }
        }

        if (this.tabRenderRafId !== null) {
            cancelAnimationFrame(this.tabRenderRafId);
            this.tabRenderRafId = null;
        }

        this.tabContentContainer.innerHTML = '';

        switch (this.activeTab) {
            case 'sim_view':
                this.renderTabSimView();
                break;
            case 'camera_view':
                this.renderTabCameraView();
                break;
            case 'slices_matrix':
                this.renderTabSlicesMatrix();
                break;
            case 'shading_lighting':
                this.renderTabShadingLighting();
                break;
            case 'gauges_roi':
                this.renderTabGaugesROI();
                break;
            case 'context_object':
                this.renderTabContextObject();
                break;
        }
    }

    // =========================================================================
    // TAB 1: SIMULATION & TRANSPORT (Integrated Simulation Cockpit Deck)
    // Upper Deck: 4-Column Controls Grid (Solver, Views, Fields/Colormaps, Mesh Layers)
    // Lower Deck: Full-Width Playback Timeline Scrubber
    // =========================================================================
    private renderTabSimView(): void {
        const wrap = document.createElement('div');
        wrap.className = 'sim-cockpit-container';

        // ---------------------------------------------------------------------
        // UPPER DECK: 4-Column Controls Grid
        // ---------------------------------------------------------------------
        const deck = document.createElement('div');
        deck.className = 'sim-cockpit-grid';

        // ---------------------------------------------------------------------
        // POD 1: Solver Commands & Step Matrix (Left Column)
        // ---------------------------------------------------------------------
        const card1 = document.createElement('div');
        card1.className = 'sim-cockpit-card solver-card';

        const b1 = document.createElement('div');
        b1.className = 'card-body';

        // 3-Column Split: Flow Stack (Init, End, Pause), Step Keypad (2x2), Execution Stats Box
        const colsContainer = document.createElement('div');
        colsContainer.className = 'solver-columns-container';

        // Column 1: Vertically Stacked Primary Flow Buttons (Init, End All, Pause)
        const flowCol = document.createElement('div');
        flowCol.className = 'solver-flow-col';

        const initBtn = this.createButton('⚡ Init', 'transport-btn init primary-action v-flow-btn', () => {
            this.onSimCommand?.('INIT');
        });
        initBtn.title = 'Initialize solver state with current DAG node parameters';

        const execEndBtn = this.createButton('▶ End (All)', 'transport-btn exec-end-action v-flow-btn', () => {
            this.onSimCommand?.('EXEC_ALL');
        });
        execEndBtn.title = 'Execute simulation to completion / max steps';

        const pauseBtn = this.createButton('⏸ Pause', 'transport-btn pause pause-action v-flow-btn', () => {
            this.onSimCommand?.('PAUSE');
        });
        pauseBtn.title = 'Pause running simulation';

        const refreshBtn = this.createButton('🔄 Refresh', 'transport-btn refresh-btn v-flow-btn', () => {
            this.requestAndPlotCurrentState();
        });
        refreshBtn.title = 'Manual Telemetry Refresh: Request current state from solver and plot across viewports';

        flowCol.appendChild(initBtn);
        flowCol.appendChild(execEndBtn);
        flowCol.appendChild(pauseBtn);
        flowCol.appendChild(refreshBtn);
        colsContainer.appendChild(flowCol);

        // Column 2: Vertically Stacked Step Keypad Grid (2x2)
        const stepsCol = document.createElement('div');
        stepsCol.className = 'solver-steps-col';

        const stepCounts = [1, 10, 100, 1000];
        stepCounts.forEach(count => {
            const btn = this.createButton(`${count}`, 'transport-exec-btn step-keypad-btn', () => {
                this.onSimCommand?.('STEP', { steps: count });
            });
            btn.title = `Execute ${count} solver step${count > 1 ? 's' : ''}`;
            stepsCol.appendChild(btn);
        });
        colsContainer.appendChild(stepsCol);

        // Column 3: Live Execution Stats Readout (Current Step, Total Time, dt)
        const statsCol = document.createElement('div');
        statsCol.className = 'solver-stats-col';
        statsCol.title = 'Live Solver Execution Stats (Step, Total Time, Timestep Δt)';

        const statsHeader = document.createElement('div');
        statsHeader.className = 'solver-stats-header';
        statsHeader.innerHTML = `<span>EXEC STATS</span><span class="solver-stats-pulse"></span>`;
        statsCol.appendChild(statsHeader);

        // Stat 1: Step Number
        const stepRow = document.createElement('div');
        stepRow.className = 'solver-stat-row';
        const stepLabel = document.createElement('span');
        stepLabel.className = 'solver-stat-label step-label';
        stepLabel.textContent = 'STEP';
        this.execStepValue = document.createElement('span');
        this.execStepValue.className = 'solver-stat-value step-val';
        this.execStepValue.textContent = '0';
        stepRow.appendChild(stepLabel);
        stepRow.appendChild(this.execStepValue);
        statsCol.appendChild(stepRow);

        // Stat 2: Total Time
        const timeRow = document.createElement('div');
        timeRow.className = 'solver-stat-row';
        const timeLabel = document.createElement('span');
        timeLabel.className = 'solver-stat-label time-label';
        timeLabel.textContent = 'TIME';
        this.execTimeValue = document.createElement('span');
        this.execTimeValue.className = 'solver-stat-value time-val';
        this.execTimeValue.textContent = '0.000 s';
        timeRow.appendChild(timeLabel);
        timeRow.appendChild(this.execTimeValue);
        statsCol.appendChild(timeRow);

        // Stat 3: Timestep dt
        const dtRow = document.createElement('div');
        dtRow.className = 'solver-stat-row';
        const dtLabel = document.createElement('span');
        dtLabel.className = 'solver-stat-label dt-label';
        dtLabel.textContent = 'Δt';
        this.execDtValue = document.createElement('span');
        this.execDtValue.className = 'solver-stat-value dt-val';
        this.execDtValue.textContent = '--';
        dtRow.appendChild(dtLabel);
        dtRow.appendChild(this.execDtValue);
        statsCol.appendChild(dtRow);

        colsContainer.appendChild(statsCol);
        b1.appendChild(colsContainer);

        // Bottom Row: Solver Summary Info Pill + Isolated Small Terminate Button
        const bottomRow = document.createElement('div');
        bottomRow.className = 'solver-bottom-row';

        const activeModel = this.stateManager.getActiveModel();
        const marineHarbour = activeModel?.nodes.find(n => n.type === 'MarineHarbourDomain');
        const cfdNode = activeModel?.nodes.find(n => ['CFDSolver3D', 'CFDSolver2D', 'CFDSolver1D', 'CFDSolver', 'MarineHarbourDomain'].includes(n.type));
        const femNode = activeModel?.nodes.find(n => n.type === 'FEMDomain3D');
        const mpmNode = activeModel?.nodes.find(n => n.type === 'MPMDomain3D' || n.type === 'MPMDomain2D');
        const activeSolver = marineHarbour || cfdNode || mpmNode || femNode || activeModel?.nodes.find(n => n.type === 'FEMFSICoupler3D' || n.type === 'FSICoupler3D' || n.type === 'FSICoupler2D');

        let solverLabel = activeSolver?.type || 'Solver';
        if (marineHarbour) {
            solverLabel = femNode ? 'Marine Harbour + FEM' : 'Marine Harbour Domain';
        } else if (cfdNode && femNode) {
            solverLabel = 'CFD + FEM Coupler';
        } else if (cfdNode && mpmNode) {
            solverLabel = 'CFD + MPM Coupler';
        }

        let initMode = '';
        if (marineHarbour) {
            initMode = marineHarbour.parameters?.init_mode || 'Hydrostatic_Stratified_3D';
        } else if (cfdNode) {
            initMode = cfdNode.parameters?.init_mode || (this.isIdealGasModel() ? 'Ideal Gas' : 'Multi-Material JWL');
        } else if (activeSolver?.parameters?.init_mode) {
            initMode = activeSolver.parameters.init_mode;
        } else if (activeSolver?.parameters?.integration_scheme) {
            initMode = activeSolver.parameters.integration_scheme;
        }

        const modeBadge = initMode ? ` [${initMode}]` : '';
        const cflVal = activeSolver?.parameters?.cfl ?? cfdNode?.parameters?.cfl ?? '0.6';
        const solverInfo = document.createElement('div');
        solverInfo.className = 'sim-solver-pill';
        solverInfo.textContent = `${activeModel?.name || 'Model 1'} | ${solverLabel}${modeBadge} | CFL: ${cflVal}`;
        solverInfo.title = `Active Domain: ${solverLabel} · Mode: ${initMode} · CFL: ${cflVal}`;

        const termBtn = this.createButton('⏹ Term', 'term-isolated-btn', () => {
            this.onSimCommand?.('TERMINATE');
        });
        termBtn.title = 'Terminate active solver process (Safety protected)';

        bottomRow.appendChild(solverInfo);
        bottomRow.appendChild(termBtn);
        b1.appendChild(bottomRow);

        card1.appendChild(b1);
        deck.appendChild(card1);

        // ---------------------------------------------------------------------
        // POD 2: Standard Views & Projections
        // ---------------------------------------------------------------------
        const card2 = document.createElement('div');
        card2.className = 'sim-cockpit-card camera-card';

        const b2 = document.createElement('div');
        b2.className = 'card-body';

        // 3x3 Spatial / Directional Standard Views & Projection Matrix
        const snapGrid = document.createElement('div');
        snapGrid.className = 'sim-camera-grid';

        const resetBtn = this.createButton('🏠 Reset', 'snap-btn compact-snap-btn', () => this.onCameraSnap?.('reset'));
        resetBtn.title = 'Reset camera framing & center';

        const topBtn = this.createButton('+Z Top', 'snap-btn compact-snap-btn', () => this.onCameraSnap?.('+z'));
        topBtn.title = '+Z Top View (Looking down from above)';

        const isoBtn = this.createButton('⬡ Iso', 'snap-btn compact-snap-btn', () => this.onCameraSnap?.('iso'));
        isoBtn.title = 'Isometric 3D Perspective Angle';

        const lftBtn = this.createButton('-X Lft', 'snap-btn compact-snap-btn', () => this.onCameraSnap?.('-x'));
        lftBtn.title = '-X Left View (Looking from left side)';

        const frtBtn = this.createButton('-Y Frt', 'snap-btn compact-snap-btn', () => this.onCameraSnap?.('-y'));
        frtBtn.title = '-Y Front View (Looking at front face)';

        const rgtBtn = this.createButton('+X Rgt', 'snap-btn compact-snap-btn', () => this.onCameraSnap?.('+x'));
        rgtBtn.title = '+X Right View (Looking from right side)';

        const projBtn = this.createButton(this.usePerspective ? '👁️ Persp' : '📐 Ortho', 'snap-btn compact-snap-btn', () => {
            this.usePerspective = !this.usePerspective;
            this.syncProjectionButtons();
            const vpNode = this.getActiveViewportNode();
            if (vpNode) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, { usePerspective: this.usePerspective });
            }
            this.onProjectionToggle?.(this.usePerspective);
        });
        projBtn.title = 'Toggle Perspective / Orthographic projection';
        this.cockpitProjBtn = projBtn;

        const btmBtn = this.createButton('-Z Btm', 'snap-btn compact-snap-btn', () => this.onCameraSnap?.('-z'));
        btmBtn.title = '-Z Bottom View (Looking up from below)';

        const bckBtn = this.createButton('+Y Bck', 'snap-btn compact-snap-btn', () => this.onCameraSnap?.('+y'));
        bckBtn.title = '+Y Back View (Looking at back face)';

        // Row 1: Reset, +Z Top, Iso
        snapGrid.appendChild(resetBtn);
        snapGrid.appendChild(topBtn);
        snapGrid.appendChild(isoBtn);
        // Row 2: -X Lft, -Y Frt, +X Rgt
        snapGrid.appendChild(lftBtn);
        snapGrid.appendChild(frtBtn);
        snapGrid.appendChild(rgtBtn);
        // Row 3: Persp/Ortho, -Z Btm, +Y Bck
        snapGrid.appendChild(projBtn);
        snapGrid.appendChild(btmBtn);
        snapGrid.appendChild(bckBtn);

        b2.appendChild(snapGrid);
        card2.appendChild(b2);
        deck.appendChild(card2);

        // ---------------------------------------------------------------------
        // POD 3: Colour Schemes & Scalar Fields (Context-Sensitive to Viewport)
        // ---------------------------------------------------------------------
        const card3 = this.createFieldAndColormapCard(true);
        deck.appendChild(card3);

        // ---------------------------------------------------------------------
        // POD 4: Mesh & Layer Visibility Toggles (Right Column)
        // ---------------------------------------------------------------------
        const card4 = document.createElement('div');
        card4.className = 'sim-cockpit-card layers-card';

        const b4 = document.createElement('div');
        b4.className = 'card-body';

        const layersGrid = document.createElement('div');
        layersGrid.className = 'sim-layers-grid';

        [
            { key: 'slices', label: '🥞 Slices' },
            { key: 'grid', label: '🌐 Mesh/Grid' },
            { key: 'gridBox', label: '📦 Bounds' },
            { key: 'fem', label: '🏗️ FEM' },
            { key: 'mpm', label: '✨ MPM' },
            { key: 'beams', label: '🔩 Beams' },
            { key: 'stl', label: '📐 CAD' },
            { key: 'obstacles', label: '🧱 Obsts' },
            { key: 'gauges', label: '🎯 Gauges' }
        ].forEach(ly => {
            const active = this.isLayerActive(ly.key);
            this.activeLayers[ly.key] = active;
            const chip = this.createButton(ly.label, `layer-chip compact-layer-chip ${active ? 'active' : ''}`, () => {
                this.toggleLayer(ly.key);
            });
            chip.setAttribute('data-layer-key', ly.key);
            chip.title = `Toggle ${ly.label} visibility`;
            layersGrid.appendChild(chip);
        });

        b4.appendChild(layersGrid);
        card4.appendChild(b4);
        deck.appendChild(card4);

        wrap.appendChild(deck);

        // ---------------------------------------------------------------------
        // LOWER DECK: Results Playback Scrubber & Telemetry Readouts
        // ---------------------------------------------------------------------
        const rowPlayback = document.createElement('div');
        rowPlayback.className = 'workstation-row timeline-row sim-cockpit-timeline';

        this.liveLockBtn = this.createButton('● Live', `transport-btn live-btn compact-btn ${this.isLiveLocked ? 'active' : ''}`, () => this.toggleLiveLock());
        this.liveLockBtn.title = 'Live Mode: Automatically follow the latest solver frames in real-time as they compute';
        rowPlayback.appendChild(this.liveLockBtn);

        const manualRefreshBtn = this.createButton('🔄 Refresh', 'transport-btn refresh-btn compact-btn', () => this.requestAndPlotCurrentState());
        manualRefreshBtn.title = 'Manual Telemetry Refresh: Request current state from solver and plot across viewports';
        rowPlayback.appendChild(manualRefreshBtn);

        // Scrubber and timeline replay controls removed per user directive.
        // Readouts Pill
        const readouts = document.createElement('div');
        readouts.className = 'transport-readouts-group playback-readouts-pill';

        this.timeDisplay = document.createElement('span');
        this.timeDisplay.className = 'transport-readout-time';
        this.timeDisplay.textContent = 't = 0.0 µs';

        this.stepDisplay = document.createElement('span');
        this.stepDisplay.className = 'transport-readout-step';
        this.stepDisplay.textContent = 'Step 0';

        const count = this.buffer.getFrameCount();
        this.bufferCountDisplay = document.createElement('span');
        this.bufferCountDisplay.className = 'transport-readout-count';
        this.bufferCountDisplay.textContent = `(${count} frames)`;

        readouts.appendChild(this.timeDisplay);
        readouts.appendChild(this.stepDisplay);
        readouts.appendChild(this.bufferCountDisplay);
        rowPlayback.appendChild(readouts);

        // Viewport Live Telemetry FPS (Streaming Update Rate)
        const fpsWrap = document.createElement('div');
        fpsWrap.className = 'transport-speed-wrap';
        const fpsLabel = document.createElement('span');
        fpsLabel.textContent = 'FPS:';
        fpsLabel.style.fontSize = '9px';
        fpsLabel.style.color = '#888';
        fpsWrap.appendChild(fpsLabel);

        const fpsSelect = document.createElement('select');
        this.simRunnerFpsSelect = fpsSelect;
        fpsSelect.className = 'transport-select compact-select';
        [
            { label: '60 FPS (16.6ms / Max)', val: 0.016 },
            { label: '30 FPS (33.3ms)', val: 0.033 },
            { label: '20 FPS (50.0ms)', val: 0.050 },
            { label: '10 FPS (100ms)', val: 0.100 },
            { label: '5 FPS (200ms)', val: 0.200 },
            { label: '2 FPS (500ms / Default)', val: 0.500 },
            { label: '1 FPS (1.0s)', val: 1.0 },
            { label: '0.5 FPS (2.0s)', val: 2.0 },
            { label: '0.2 FPS (5.0s)', val: 5.0 },
            { label: '0.1 FPS (10.0s)', val: 10.0 },
            { label: '0.05 FPS (20.0s)', val: 20.0 },
            { label: '0.02 FPS (50.0s)', val: 50.0 },
            { label: '0.01 FPS (100.0s)', val: 100.0 }
        ].forEach(f => {
            const opt = document.createElement('option');
            opt.value = String(f.val);
            opt.textContent = f.label;
            if (Math.abs(f.val - this.refreshRate) < 0.0005 || (f.val > 0 && Math.abs(f.val - this.refreshRate) / f.val < 0.05)) opt.selected = true;
            fpsSelect.appendChild(opt);
        });
        fpsSelect.title = 'Live 3D Viewport Telemetry Refresh Rate / FPS';
        fpsSelect.addEventListener('change', () => {
            this.refreshRate = parseFloat(fpsSelect.value);
            const activeModel = this.stateManager.getActiveModel();
            if (activeModel) {
                this.stateManager.setModelRefreshRate(activeModel.id, this.refreshRate);
            } else {
                const vpNode = this.getActiveViewportNode();
                if (vpNode) {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { refresh_rate: this.refreshRate });
                }
            }
            if (this.cameraTabFpsSelect && this.cameraTabFpsSelect !== fpsSelect) {
                this.cameraTabFpsSelect.value = fpsSelect.value;
            }
            this.onRefreshRateChange?.(this.refreshRate);
        });
        fpsWrap.appendChild(fpsSelect);
        rowPlayback.appendChild(fpsWrap);

        wrap.appendChild(rowPlayback);
        this.tabContentContainer.appendChild(wrap);
    }

    // =========================================================================
    // TAB 2: CAMERA & VIEWPORT (3-Column Card Grid)
    // =========================================================================
    private renderTabCameraView(): void {
        const grid = document.createElement('div');
        grid.className = 'workstation-cards-grid three-col';

        // ---------------------------------------------------------------------
        // CARD 1: Camera Presets & Projections
        // ---------------------------------------------------------------------
        const card1 = document.createElement('div');
        card1.className = 'workstation-card camera-card';

        const body1 = document.createElement('div');
        body1.className = 'card-body';

        // 3x3 Spatial / Directional Standard Views & Projection Matrix
        const snapGrid = document.createElement('div');
        snapGrid.className = 'camera-snap-grid';

        const resetBtn = this.createButton('🏠 Reset', 'snap-btn', () => this.onCameraSnap?.('reset'));
        resetBtn.title = 'Reset camera framing & center';

        const topBtn = this.createButton('+Z Top', 'snap-btn', () => this.onCameraSnap?.('+z'));
        topBtn.title = '+Z Top View (Looking down from above)';

        const isoBtn = this.createButton('⬡ Iso', 'snap-btn', () => this.onCameraSnap?.('iso'));
        isoBtn.title = 'Isometric 3D Perspective Angle';

        const lftBtn = this.createButton('-X Lft', 'snap-btn', () => this.onCameraSnap?.('-x'));
        lftBtn.title = '-X Left View (Looking from left side)';

        const frtBtn = this.createButton('-Y Frt', 'snap-btn', () => this.onCameraSnap?.('-y'));
        frtBtn.title = '-Y Front View (Looking at front face)';

        const rgtBtn = this.createButton('+X Rgt', 'snap-btn', () => this.onCameraSnap?.('+x'));
        rgtBtn.title = '+X Right View (Looking from right side)';

        const projBtn = this.createButton(this.usePerspective ? '👁️ Persp' : '📐 Ortho', 'snap-btn', () => {
            this.usePerspective = !this.usePerspective;
            this.syncProjectionButtons();
            const vpNode = this.getActiveViewportNode();
            if (vpNode) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, { usePerspective: this.usePerspective });
            }
            this.onProjectionToggle?.(this.usePerspective);
        });
        projBtn.title = 'Toggle Perspective / Orthographic projection';
        this.tabProjBtn = projBtn;

        const btmBtn = this.createButton('-Z Btm', 'snap-btn', () => this.onCameraSnap?.('-z'));
        btmBtn.title = '-Z Bottom View (Looking up from below)';

        const bckBtn = this.createButton('+Y Bck', 'snap-btn', () => this.onCameraSnap?.('+y'));
        bckBtn.title = '+Y Back View (Looking at back face)';

        // Row 1: Reset, +Z Top, Iso
        snapGrid.appendChild(resetBtn);
        snapGrid.appendChild(topBtn);
        snapGrid.appendChild(isoBtn);
        // Row 2: -X Lft, -Y Frt, +X Rgt
        snapGrid.appendChild(lftBtn);
        snapGrid.appendChild(frtBtn);
        snapGrid.appendChild(rgtBtn);
        // Row 3: Persp/Ortho, -Z Btm, +Y Bck
        snapGrid.appendChild(projBtn);
        snapGrid.appendChild(btmBtn);
        snapGrid.appendChild(bckBtn);

        body1.appendChild(snapGrid);
        card1.appendChild(body1);
        grid.appendChild(card1);

        // ---------------------------------------------------------------------
        // CARD 2: Scalar Field & Colormap (Context-Sensitive)
        // ---------------------------------------------------------------------
        const card2 = this.createFieldAndColormapCard(false);
        grid.appendChild(card2);

        // ---------------------------------------------------------------------
        // CARD 3: Layer Visibility Matrix Grid
        // ---------------------------------------------------------------------
        const card3 = document.createElement('div');
        card3.className = 'workstation-card layers-card';

        const body3 = document.createElement('div');
        body3.className = 'card-body';

        const layersGrid = document.createElement('div');
        layersGrid.className = 'layers-chip-grid';

        [
            { key: 'slices', label: '🥞 Slices' },
            { key: 'fem', label: '🏗️ FEM Solids' },
            { key: 'mpm', label: '✨ MPM Particles' },
            { key: 'beams', label: '🔩 Beams/Rebar' },
            { key: 'stl', label: '📐 STL CAD' },
            { key: 'obstacles', label: '🧱 Obstacles' },
            { key: 'grid', label: '🌐 Domain Grid' },
            { key: 'gridBox', label: '📦 Bounding Box' },
            { key: 'gauges', label: '🎯 Gauges' },
            { key: 'lighting', label: '💡 Lighting' }
        ].forEach(ly => {
            const active = this.isLayerActive(ly.key);
            this.activeLayers[ly.key] = active;
            const chip = this.createButton(ly.label, `layer-chip ${active ? 'active' : ''}`, () => {
                this.toggleLayer(ly.key);
            });
            chip.setAttribute('data-layer-key', ly.key);
            chip.title = `Toggle ${ly.label} visibility`;
            layersGrid.appendChild(chip);
        });

        body3.appendChild(layersGrid);
        card3.appendChild(body3);
        grid.appendChild(card3);

        this.tabContentContainer.appendChild(grid);
    }

    // =========================================================================
    // TAB 3: SLICES MATRIX (Comprehensive Interactive Table & Axis Controls)
    // =========================================================================
    private renderTabSlicesMatrix(): void {
        const wrap = document.createElement('div');
        wrap.className = 'workstation-slices-container';

        // Resolve slices list from Active Domain Node (falling back to Viewport)
        const domainNode = this.getActiveDomainNode();
        const vpNode = this.getActiveViewportNode();
        const slicesList: any[] = domainNode?.parameters?.slices || vpNode?.parameters?.slices || [
            { axis: 'xy', offset: 0.0, enabled: true, colormap: 'rainbow', opacity: 1.0, quantity: 'pressure' }
        ];

        // 1. Slices Top Toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'slices-toolbar';

        const addXNormalBtn = this.createButton('➕ Add X-Normal Plane', 'transport-tool-btn', () => this.addSlice('yz'));
        const addYNormalBtn = this.createButton('➕ Add Y-Normal Plane', 'transport-tool-btn', () => this.addSlice('xz'));
        const addZNormalBtn = this.createButton('➕ Add Z-Normal Plane', 'transport-tool-btn', () => this.addSlice('xy'));
        toolbar.appendChild(addXNormalBtn);
        toolbar.appendChild(addYNormalBtn);
        toolbar.appendChild(addZNormalBtn);

        // Active Slice Slider Quick Scrub
        const sliderWrap = document.createElement('div');
        sliderWrap.className = 'slices-quick-slider';
        const sliderLabel = document.createElement('span');
        sliderLabel.textContent = `Slice #${this.activeSliceIndex} Offset:`;
        sliderLabel.style.fontSize = '10px';
        const currentSlice = slicesList[this.activeSliceIndex] || { offset: 0.0 };
        const activeAxis = currentSlice.axis || this.activeSlicePlane || 'xy';
        const activeModel = this.stateManager.getActiveModel();
        const currentState = this.stateManager.getCurrentState();
        const quickBounds = resolveSliceDomainBounds(activeAxis, null, currentState, activeModel);
        const curOff = currentSlice.offset !== undefined ? Number(currentSlice.offset) : ((quickBounds.min + quickBounds.max) / 2.0);

        const sliceSlider = document.createElement('input');
        sliceSlider.type = 'range';
        sliceSlider.min = String(quickBounds.min);
        sliceSlider.max = String(quickBounds.max);
        sliceSlider.step = String(quickBounds.step);
        sliceSlider.value = String(curOff);
        sliceSlider.className = 'slice-offset-slider';

        const numBox = document.createElement('input');
        numBox.type = 'number';
        numBox.step = 'any';
        numBox.min = String(quickBounds.min);
        numBox.max = String(quickBounds.max);
        numBox.value = curOff.toString();
        numBox.style.width = '65px';
        numBox.style.background = '#121418';
        numBox.style.border = '1px solid #282a32';
        numBox.style.color = '#00adff';
        numBox.style.fontSize = '10px';
        numBox.style.fontFamily = "'JetBrains Mono', monospace";
        numBox.style.fontWeight = 'bold';
        numBox.style.padding = '1px 4px';
        numBox.style.borderRadius = '3px';

        const quickDecimals = quickBounds.step < 0.0001 ? 5 : (quickBounds.step < 0.001 ? 4 : (quickBounds.step < 0.01 ? 3 : 2));

        sliceSlider.addEventListener('input', () => {
            const p = parseFloat(sliceSlider.value);
            this.sliceOffsetPercent = Math.round(p * 100);
            numBox.value = p.toFixed(quickDecimals);
            this.activeSlicePlane = activeAxis as ('xy' | 'xz' | 'yz');
            this.onSliceToggle?.(this.activeSlicePlane, this.sliceEnabled, p);
        });

        const commitQuickNum = () => {
            const p = parseFloat(numBox.value);
            if (!isNaN(p)) {
                sliceSlider.value = String(p);
                this.sliceOffsetPercent = Math.round(p * 100);
                this.activeSlicePlane = activeAxis as ('xy' | 'xz' | 'yz');
                this.onSliceToggle?.(this.activeSlicePlane, this.sliceEnabled, p);
            }
        };
        numBox.addEventListener('input', commitQuickNum);
        numBox.addEventListener('change', commitQuickNum);

        sliderWrap.appendChild(sliderLabel);
        sliderWrap.appendChild(sliceSlider);
        sliderWrap.appendChild(numBox);
        toolbar.appendChild(sliderWrap);
        wrap.appendChild(toolbar);

        // 2. Slices Interactive Table
        const tableWrap = document.createElement('div');
        tableWrap.className = 'slices-table-container';

        const table = document.createElement('table');
        table.className = 'slices-matrix-table';

        table.innerHTML = `
            <thead>
                <tr>
                    <th style="width: 35px;">#</th>
                    <th style="width: 80px;">Normal Axis</th>
                    <th>Offset Position [m]</th>
                    <th style="width: 140px;">Quantity</th>
                    <th style="width: 110px;">Colormap</th>
                    <th style="width: 90px;">Opacity</th>
                    <th style="width: 60px;">Active</th>
                    <th style="width: 90px;">Actions</th>
                </tr>
            </thead>
            <tbody>
            </tbody>
        `;

        const tbody = table.querySelector('tbody')!;

        slicesList.forEach((sl: any, idx: number) => {
            const tr = document.createElement('tr');
            if (idx === this.activeSliceIndex) tr.classList.add('selected-row');

            // # Column
            const tdIdx = document.createElement('td');
            tdIdx.textContent = `#${idx}`;
            tr.appendChild(tdIdx);

            // Axis Selector
            const tdAxis = document.createElement('td');
            const axisSel = document.createElement('select');
            axisSel.className = 'table-select';
            [
                { val: 'yz', label: 'X-Normal' },
                { val: 'xz', label: 'Y-Normal' },
                { val: 'xy', label: 'Z-Normal' }
            ].forEach(axItem => {
                const opt = document.createElement('option');
                opt.value = axItem.val;
                opt.textContent = axItem.label;
                if (axItem.val === (sl.axis || 'xy')) opt.selected = true;
                axisSel.appendChild(opt);
            });
            axisSel.addEventListener('change', () => {
                sl.axis = axisSel.value;
                const newBounds = resolveSliceDomainBounds(axisSel.value, null, currentState, activeModel);
                const cur = sl.offset !== undefined ? Number(sl.offset) : (newBounds.min + newBounds.max) / 2.0;
                if (cur < newBounds.min || cur > newBounds.max) {
                    sl.offset = (newBounds.min + newBounds.max) / 2.0;
                }
                this.updateSliceInNode(idx, sl);
                this.renderActiveTabContent();
            });
            tdAxis.appendChild(axisSel);
            tr.appendChild(tdAxis);

            // Offset Slider & Precision Number Input
            const tdOffset = document.createElement('td');
            const offsetRow = document.createElement('div');
            offsetRow.style.display = 'flex';
            offsetRow.style.alignItems = 'center';
            offsetRow.style.gap = '6px';

            const rowBounds = resolveSliceDomainBounds(sl.axis || 'xy', null, currentState, activeModel);
            const offsetVal = sl.offset !== undefined ? Number(sl.offset) : ((rowBounds.min + rowBounds.max) / 2.0);

            const offsetInput = document.createElement('input');
            offsetInput.type = 'range';
            offsetInput.min = String(rowBounds.min);
            offsetInput.max = String(rowBounds.max);
            offsetInput.step = String(rowBounds.step);
            offsetInput.value = String(offsetVal);
            offsetInput.className = 'table-range-slider';
            offsetInput.style.flex = '1';

            const offsetNum = document.createElement('input');
            offsetNum.type = 'number';
            offsetNum.step = 'any';
            offsetNum.min = String(rowBounds.min);
            offsetNum.max = String(rowBounds.max);
            offsetNum.value = offsetVal.toString();
            offsetNum.style.width = '64px';
            offsetNum.style.background = '#121418';
            offsetNum.style.border = '1px solid #282a32';
            offsetNum.style.color = '#f1f5f9';
            offsetNum.style.fontSize = '10px';
            offsetNum.style.fontFamily = "'JetBrains Mono', monospace";
            offsetNum.style.padding = '1px 4px';
            offsetNum.style.borderRadius = '3px';

            const rowDecimals = rowBounds.step < 0.0001 ? 5 : (rowBounds.step < 0.001 ? 4 : (rowBounds.step < 0.01 ? 3 : 2));

            offsetInput.addEventListener('input', () => {
                const off = parseFloat(offsetInput.value);
                sl.offset = off;
                offsetNum.value = off.toFixed(rowDecimals);
                this.updateSliceInNode(idx, sl);
            });

            const commitNum = () => {
                const off = parseFloat(offsetNum.value);
                if (!isNaN(off)) {
                    sl.offset = off;
                    offsetInput.value = String(off);
                    this.updateSliceInNode(idx, sl);
                }
            };
            offsetNum.addEventListener('input', commitNum);
            offsetNum.addEventListener('change', commitNum);

            offsetRow.appendChild(offsetInput);
            offsetRow.appendChild(offsetNum);
            tdOffset.appendChild(offsetRow);
            tr.appendChild(tdOffset);

            // Quantity
            const tdQty = document.createElement('td');
            const qtySel = document.createElement('select');
            qtySel.className = 'table-select';
            ['pressure', 'density', 'velocity', 'energy', 'overpressure', 'von_mises'].forEach(q => {
                const opt = document.createElement('option');
                opt.value = q;
                opt.textContent = q.charAt(0).toUpperCase() + q.slice(1);
                if (q === (sl.quantity || 'pressure')) opt.selected = true;
                qtySel.appendChild(opt);
            });
            qtySel.addEventListener('change', () => {
                sl.quantity = qtySel.value;
                this.updateSliceInNode(idx, sl);
            });
            tdQty.appendChild(qtySel);
            tr.appendChild(tdQty);

            // Colormap
            const tdColormap = document.createElement('td');
            const cmapSel = document.createElement('select');
            cmapSel.className = 'table-select';
            ['rainbow', 'plasma', 'viridis', 'turbo', 'inferno', 'coolwarm'].forEach(cm => {
                const opt = document.createElement('option');
                opt.value = cm;
                opt.textContent = cm.toUpperCase();
                if (cm === (sl.colormap || 'rainbow')) opt.selected = true;
                cmapSel.appendChild(opt);
            });
            cmapSel.addEventListener('change', () => {
                sl.colormap = cmapSel.value;
                this.updateSliceInNode(idx, sl);
            });
            tdColormap.appendChild(cmapSel);
            tr.appendChild(tdColormap);

            // Opacity
            const tdOpacity = document.createElement('td');
            const opSlider = document.createElement('input');
            opSlider.type = 'range';
            opSlider.min = '0';
            opSlider.max = '100';
            opSlider.value = String(Math.round((sl.opacity ?? 1.0) * 100));
            opSlider.className = 'table-range-slider';
            opSlider.addEventListener('input', () => {
                sl.opacity = parseFloat(opSlider.value) / 100.0;
                this.updateSliceInNode(idx, sl);
            });
            tdOpacity.appendChild(opSlider);
            tr.appendChild(tdOpacity);

            // Active Toggle
            const tdActive = document.createElement('td');
            const activeCb = document.createElement('input');
            activeCb.type = 'checkbox';
            activeCb.checked = sl.enabled !== false;
            activeCb.addEventListener('change', () => {
                sl.enabled = activeCb.checked;
                this.updateSliceInNode(idx, sl);
            });
            tdActive.appendChild(activeCb);
            tr.appendChild(tdActive);

            // Actions
            const tdActions = document.createElement('td');
            const delBtn = this.createButton('✖', 'table-icon-btn danger', () => {
                this.removeSlice(idx);
            });
            delBtn.title = 'Remove slice plane';
            tdActions.appendChild(delBtn);
            tr.appendChild(tdActions);

            tr.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).tagName !== 'INPUT' && (e.target as HTMLElement).tagName !== 'SELECT' && (e.target as HTMLElement).tagName !== 'BUTTON') {
                    this.activeSliceIndex = idx;
                    this.activeSlicePlane = sl.axis || 'xy';
                    this.sliceOffsetPercent = Math.round((sl.offset || 0) * 100);
                    this.stateManager.setSelectedSliceIndex(idx);
                    const domainNode = this.getActiveDomainNode();
                    const vpNode = this.getActiveViewportNode();
                    const targetNode = domainNode || vpNode;
                    if (targetNode) {
                        this.stateManager.setSelectedNode(targetNode.id);
                    }
                    this.selectedObject = {
                        objectType: 'Slice',
                        sliceIndex: idx,
                        label: `Slice #${idx} (${getSliceAxisLabel(sl.axis)})`,
                        nodeId: targetNode?.id
                    };
                    this.renderActiveTabContent();
                }
            });

            tbody.appendChild(tr);
        });

        tableWrap.appendChild(table);
        wrap.appendChild(tableWrap);
        this.tabContentContainer.appendChild(wrap);
    }

    // =========================================================================
    // TAB 4: SHADING & LIGHTING (2 Structured Cards)
    // =========================================================================
    private renderTabShadingLighting(): void {
        const grid = document.createElement('div');
        grid.className = 'workstation-cards-grid two-col';

        // CARD 1: Representation & Surface Shading
        const card1 = document.createElement('div');
        card1.className = 'workstation-card';
        card1.innerHTML = `<div class="card-header"><span>🎨 SURFACE SHADING & LIGHTING</span></div>`;
        const body1 = document.createElement('div');
        body1.className = 'card-body';

        // Representation Style Selector Buttons
        const repRow = document.createElement('div');
        repRow.className = 'card-row';
        const repLabel = document.createElement('span');
        repLabel.textContent = 'Style:';
        repLabel.className = 'card-slider-label-sm';

        const repGroup = document.createElement('div');
        repGroup.className = 'transport-btn-group';
        [
            { id: 'solid', label: 'Surface' },
            { id: 'edges', label: 'Surface + Edges' },
            { id: 'wireframe', label: 'Wireframe' },
            { id: 'points', label: 'Points' }
        ].forEach(r => {
            const btn = this.createButton(r.label, `style-btn ${this.representationStyle === r.id ? 'active' : ''}`, () => {
                this.representationStyle = r.id as any;
                repGroup.querySelectorAll('.style-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.onShadingChange?.('representation', this.representationStyle);
            });
            repGroup.appendChild(btn);
        });
        repRow.appendChild(repLabel);
        repRow.appendChild(repGroup);
        body1.appendChild(repRow);

        // Lighting Sliders (Ambient & Specular)
        const ambRow = document.createElement('div');
        ambRow.className = 'card-row';
        const ambLabel = document.createElement('span');
        ambLabel.className = 'card-slider-label';
        ambLabel.textContent = `Ambient Light: ${Math.round(this.ambientLevel * 100)}%`;
        const ambSlider = document.createElement('input');
        ambSlider.type = 'range';
        ambSlider.min = '0';
        ambSlider.max = '100';
        ambSlider.value = String(Math.round(this.ambientLevel * 100));
        ambSlider.className = 'table-range-slider';
        ambSlider.addEventListener('input', () => {
            this.ambientLevel = parseFloat(ambSlider.value) / 100.0;
            ambLabel.textContent = `Ambient Light: ${ambSlider.value}%`;
            this.onShadingChange?.('ambientLevel', this.ambientLevel);
        });
        ambRow.appendChild(ambLabel);
        ambRow.appendChild(ambSlider);
        body1.appendChild(ambRow);

        const specRow = document.createElement('div');
        specRow.className = 'card-row';
        const specLabel = document.createElement('span');
        specLabel.className = 'card-slider-label';
        specLabel.textContent = `Specular Highlight: ${Math.round(this.specularIntensity * 100)}%`;
        const specSlider = document.createElement('input');
        specSlider.type = 'range';
        specSlider.min = '0';
        specSlider.max = '200';
        specSlider.value = String(Math.round(this.specularIntensity * 100));
        specSlider.className = 'table-range-slider';
        specSlider.addEventListener('input', () => {
            this.specularIntensity = parseFloat(specSlider.value) / 100.0;
            specLabel.textContent = `Specular Highlight: ${specSlider.value}%`;
            this.onShadingChange?.('specularIntensity', this.specularIntensity);
        });
        specRow.appendChild(specLabel);
        specRow.appendChild(specSlider);
        body1.appendChild(specRow);

        // Subcontrols container created first to allow clean reference in aoBtn handler
        const aoSubContainer = document.createElement('div');
        aoSubContainer.className = `ao-subcontrols-container ${this.aoEnabled ? '' : 'disabled'}`;

        // Sampling Radius Slider
        const radiusRow = document.createElement('div');
        radiusRow.className = 'card-row';
        const radiusLabel = document.createElement('span');
        radiusLabel.className = 'card-slider-label';
        radiusLabel.textContent = `SSAO Radius: ${(this.aoRadius * 100).toFixed(0)}cm`;
        const radiusSlider = document.createElement('input');
        radiusSlider.type = 'range';
        radiusSlider.min = '1';
        radiusSlider.max = '100';
        radiusSlider.value = String(Math.round(this.aoRadius * 100));
        radiusSlider.className = 'table-range-slider';
        radiusSlider.disabled = !this.aoEnabled;
        radiusSlider.addEventListener('input', () => {
            this.aoRadius = parseFloat(radiusSlider.value) / 100.0;
            radiusLabel.textContent = `SSAO Radius: ${radiusSlider.value}cm`;
            this.onShadingChange?.('aoRadius', this.aoRadius);
        });
        radiusRow.appendChild(radiusLabel);
        radiusRow.appendChild(radiusSlider);
        aoSubContainer.appendChild(radiusRow);

        // Shadow Intensity Slider
        const intRow = document.createElement('div');
        intRow.className = 'card-row';
        const intLabel = document.createElement('span');
        intLabel.className = 'card-slider-label';
        intLabel.textContent = `Shadow Intensity: ${Math.round(this.aoIntensity * 100)}%`;
        const intSlider = document.createElement('input');
        intSlider.type = 'range';
        intSlider.min = '10';
        intSlider.max = '300';
        intSlider.value = String(Math.round(this.aoIntensity * 100));
        intSlider.className = 'table-range-slider';
        intSlider.disabled = !this.aoEnabled;
        intSlider.addEventListener('input', () => {
            this.aoIntensity = parseFloat(intSlider.value) / 100.0;
            intLabel.textContent = `Shadow Intensity: ${intSlider.value}%`;
            this.onShadingChange?.('aoIntensity', this.aoIntensity);
        });
        intRow.appendChild(intLabel);
        intRow.appendChild(intSlider);
        aoSubContainer.appendChild(intRow);

        // Sphere Impostor AO Toggle
        const sphereAoRow = document.createElement('div');
        sphereAoRow.className = 'card-row';
        const sphereAoBtn = this.createButton('🪐 Sphere Impostor AO', `chip-btn fixed-toggle-btn ${this.aoSphereImpostor ? 'active' : ''}`, () => {
            this.aoSphereImpostor = !this.aoSphereImpostor;
            sphereAoBtn.classList.toggle('active', this.aoSphereImpostor);
            this.onShadingChange?.('aoSphereImpostor', this.aoSphereImpostor);
        });
        sphereAoBtn.disabled = !this.aoEnabled;
        sphereAoRow.appendChild(sphereAoBtn);
        aoSubContainer.appendChild(sphereAoRow);

        // MPM Particle Sphere Impostor Diameter & Sizing (SI Units: meters)
        const vpNode = this.getActiveViewportNode();
        const autoDiam = this.getAutoParticleDiameter();
        const curDiam = Number(vpNode?.parameters.mpmParticleDiameter && vpNode.parameters.mpmParticleDiameter > 0 ? vpNode.parameters.mpmParticleDiameter : (this.mpmParticleDiameter > 0 ? this.mpmParticleDiameter : autoDiam));

        const formatSI = (d: number) => {
            if (!isFinite(d) || d <= 0) return '0 m';
            if (d >= 0.01) return `${d.toFixed(3)} m`;
            if (d >= 0.001) return `${d.toFixed(4).replace(/0+$/, '')} m`;
            if (d >= 0.0001) return `${d.toFixed(5).replace(/0+$/, '')} m`;
            return `${d.toExponential(2)} m`;
        };

        const mpmDiamRow = document.createElement('div');
        mpmDiamRow.className = 'card-row';
        mpmDiamRow.style.flexDirection = 'column';
        mpmDiamRow.style.alignItems = 'stretch';
        mpmDiamRow.style.gap = '5px';
        mpmDiamRow.style.marginTop = '6px';
        mpmDiamRow.style.borderTop = '1px solid rgba(255,255,255,0.08)';
        mpmDiamRow.style.paddingTop = '6px';

        const diamHeader = document.createElement('div');
        diamHeader.style.display = 'flex';
        diamHeader.style.justifyContent = 'space-between';
        diamHeader.style.alignItems = 'center';

        const diamLabel = document.createElement('span');
        diamLabel.className = 'card-slider-label';
        diamLabel.textContent = `Sphere Diameter (m):`;

        diamHeader.appendChild(diamLabel);
        mpmDiamRow.appendChild(diamHeader);

        // Float numeric input + Default button row
        const inputRow = document.createElement('div');
        inputRow.style.display = 'flex';
        inputRow.style.gap = '4px';
        inputRow.style.alignItems = 'center';

        const diamInput = document.createElement('input');
        diamInput.type = 'number';
        diamInput.step = '0.0001';
        diamInput.min = '0.00001';
        diamInput.value = String(curDiam);
        diamInput.placeholder = 'Diameter in meters (m)';
        diamInput.style.flex = '1';
        diamInput.style.background = '#181818';
        diamInput.style.color = '#fff';
        diamInput.style.border = '1px solid #444';
        diamInput.style.borderRadius = '3px';
        diamInput.style.padding = '3px 6px';
        diamInput.style.fontSize = '10px';

        const defaultBtn = document.createElement('button');
        defaultBtn.textContent = `Default (Ø ${formatSI(autoDiam)})`;
        defaultBtn.className = 'chip-btn';
        defaultBtn.style.fontSize = '8.5px';
        defaultBtn.style.padding = '3px 6px';
        defaultBtn.style.color = '#00adff';
        defaultBtn.style.fontWeight = 'bold';
        defaultBtn.title = 'Set diameter to non-overlapping spacing from initial meshing (Δx / ∛ppc)';

        inputRow.appendChild(diamInput);
        inputRow.appendChild(defaultBtn);
        mpmDiamRow.appendChild(inputRow);

        const diamSlider = document.createElement('input');
        diamSlider.type = 'range';
        diamSlider.min = '0.0001';
        diamSlider.max = '0.0500';
        diamSlider.step = '0.0001';
        diamSlider.value = String(Math.max(0.0001, Math.min(0.0500, curDiam)));
        diamSlider.className = 'table-range-slider';

        const applyDiameter = (dVal: number) => {
            this.mpmParticleDiameter = dVal;
            diamInput.value = String(dVal);
            diamSlider.value = String(Math.max(0.0001, Math.min(0.0500, dVal)));
            this.onShadingChange?.('mpmParticleDiameter', dVal);
            if (vpNode) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmParticleDiameter: dVal });
            }
        };

        diamInput.onchange = () => {
            const d = parseFloat(diamInput.value);
            if (isFinite(d) && d > 0) {
                applyDiameter(d);
            }
        };
        diamInput.onkeydown = (ev) => {
            if (ev.key === 'Enter') {
                const d = parseFloat(diamInput.value);
                if (isFinite(d) && d > 0) {
                    applyDiameter(d);
                }
            }
        };

        diamSlider.oninput = () => {
            const d = parseFloat(diamSlider.value);
            applyDiameter(d);
        };

        defaultBtn.onclick = () => {
            applyDiameter(autoDiam);
        };

        // Presets row in SI units (meters)
        const presetsRow = document.createElement('div');
        presetsRow.style.display = 'flex';
        presetsRow.style.gap = '3px';
        presetsRow.style.flexWrap = 'wrap';
        [0.0005, 0.001, 0.002, 0.0025, 0.005, 0.010, 0.020].forEach(pM => {
            const pBtn = document.createElement('button');
            pBtn.textContent = formatSI(pM);
            pBtn.className = 'chip-btn';
            pBtn.style.fontSize = '8px';
            pBtn.style.padding = '1px 4px';
            pBtn.onclick = () => {
                applyDiameter(pM);
            };
            presetsRow.appendChild(pBtn);
        });
        mpmDiamRow.appendChild(diamSlider);
        mpmDiamRow.appendChild(presetsRow);
        aoSubContainer.appendChild(mpmDiamRow);

        // Ambient Occlusion Main Toggle
        const aoRow = document.createElement('div');
        aoRow.className = 'card-row';
        const aoBtn = this.createButton('✨ Ambient Occlusion', `chip-btn fixed-toggle-btn ${this.aoEnabled ? 'active' : ''}`, () => {
            this.aoEnabled = !this.aoEnabled;
            aoBtn.classList.toggle('active', this.aoEnabled);
            aoSubContainer.classList.toggle('disabled', !this.aoEnabled);
            radiusSlider.disabled = !this.aoEnabled;
            intSlider.disabled = !this.aoEnabled;
            sphereAoBtn.disabled = !this.aoEnabled;
            this.onShadingChange?.('aoEnabled', this.aoEnabled);
        });
        aoRow.appendChild(aoBtn);
        body1.appendChild(aoRow);

        // Append AO Subcontrols container (always in DOM in fixed position)
        body1.appendChild(aoSubContainer);

        card1.appendChild(body1);
        grid.appendChild(card1);

        // CARD 2: Grid, Bounding Box & Refresh Quality
        const card2 = document.createElement('div');
        card2.className = 'workstation-card';
        card2.innerHTML = `<div class="card-header"><span>🌐 GRID, BOX & TELEMETRY THROTTLE</span></div>`;
        const body2 = document.createElement('div');
        body2.className = 'card-body';

        // Grid & Box Toggles
        const gridToggles = document.createElement('div');
        gridToggles.className = 'card-row grid-toggles-grid';
        const gridBtn = this.createButton('🌐 Domain Grid', `chip-btn fixed-toggle-btn ${this.showGrid ? 'active' : ''}`, () => {
            this.showGrid = !this.showGrid;
            gridBtn.classList.toggle('active', this.showGrid);
            this.onShadingChange?.('showGrid', this.showGrid);
        });
        const boxBtn = this.createButton('📦 Bounding Box', `chip-btn fixed-toggle-btn ${this.showGridBox ? 'active' : ''}`, () => {
            this.showGridBox = !this.showGridBox;
            boxBtn.classList.toggle('active', this.showGridBox);
            this.onShadingChange?.('showGridBox', this.showGridBox);
        });
        gridToggles.appendChild(gridBtn);
        gridToggles.appendChild(boxBtn);
        body2.appendChild(gridToggles);

        // Grid Opacity Slider
        const gridOpRow = document.createElement('div');
        gridOpRow.className = 'card-row';
        const gridOpLabel = document.createElement('span');
        gridOpLabel.className = 'card-slider-label';
        gridOpLabel.textContent = `Grid Opacity: ${Math.round(this.gridOpacity * 100)}%`;
        const gridOpSlider = document.createElement('input');
        gridOpSlider.type = 'range';
        gridOpSlider.min = '0';
        gridOpSlider.max = '100';
        gridOpSlider.value = String(Math.round(this.gridOpacity * 100));
        gridOpSlider.className = 'table-range-slider';
        gridOpSlider.addEventListener('input', () => {
            this.gridOpacity = parseFloat(gridOpSlider.value) / 100.0;
            gridOpLabel.textContent = `Grid Opacity: ${gridOpSlider.value}%`;
            this.onShadingChange?.('gridOpacity', this.gridOpacity);
        });
        gridOpRow.appendChild(gridOpLabel);
        gridOpRow.appendChild(gridOpSlider);
        body2.appendChild(gridOpRow);

        // Viewport FPS Selector Dropdown
        const fpsRow = document.createElement('div');
        fpsRow.className = 'card-row';
        const fpsLabel = document.createElement('span');
        fpsLabel.className = 'card-slider-label';
        fpsLabel.textContent = 'Viewport FPS:';
        const fpsSelect = document.createElement('select');
        this.cameraTabFpsSelect = fpsSelect;
        fpsSelect.className = 'transport-select full-width';
        [
            { label: '60 FPS (16.6ms / Max)', val: 0.016 },
            { label: '30 FPS (33.3ms)', val: 0.033 },
            { label: '20 FPS (50.0ms)', val: 0.050 },
            { label: '10 FPS (100ms)', val: 0.100 },
            { label: '5 FPS (200ms)', val: 0.200 },
            { label: '2 FPS (500ms / Default)', val: 0.500 },
            { label: '1 FPS (1.0s)', val: 1.0 },
            { label: '0.5 FPS (2.0s)', val: 2.0 },
            { label: '0.2 FPS (5.0s)', val: 5.0 },
            { label: '0.1 FPS (10.0s)', val: 10.0 },
            { label: '0.05 FPS (20.0s)', val: 20.0 },
            { label: '0.02 FPS (50.0s)', val: 50.0 },
            { label: '0.01 FPS (100.0s)', val: 100.0 }
        ].forEach(f => {
            const opt = document.createElement('option');
            opt.value = String(f.val);
            opt.textContent = f.label;
            if (Math.abs(f.val - this.refreshRate) < 0.0005 || (f.val > 0 && Math.abs(f.val - this.refreshRate) / f.val < 0.05)) opt.selected = true;
            fpsSelect.appendChild(opt);
        });
        fpsSelect.addEventListener('change', () => {
            this.refreshRate = parseFloat(fpsSelect.value);
            const activeModel = this.stateManager.getActiveModel();
            if (activeModel) {
                this.stateManager.setModelRefreshRate(activeModel.id, this.refreshRate);
            } else {
                const vpNode = this.getActiveViewportNode();
                if (vpNode) {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { refresh_rate: this.refreshRate });
                }
            }
            if (this.simRunnerFpsSelect && this.simRunnerFpsSelect !== fpsSelect) {
                this.simRunnerFpsSelect.value = fpsSelect.value;
            }
            this.onRefreshRateChange?.(this.refreshRate);
        });
        fpsRow.appendChild(fpsLabel);
        fpsRow.appendChild(fpsSelect);
        body2.appendChild(fpsRow);

        card2.appendChild(body2);
        grid.appendChild(card2);

        this.tabContentContainer.appendChild(grid);
    }

    // =========================================================================
    // TAB 5: GAUGES & ROI FILTERS (2 Structured Cards)
    // =========================================================================
    private renderTabGaugesROI(): void {
        const grid = document.createElement('div');
        grid.className = 'workstation-cards-grid two-col';

        // CARD 1: Virtual Sensor Gauges Probes
        const card1 = document.createElement('div');
        card1.className = 'workstation-card';
        card1.innerHTML = `<div class="card-header"><span>🎯 VIRTUAL SENSOR GAUGES</span></div>`;
        const body1 = document.createElement('div');
        body1.className = 'card-body';

        const gTop = document.createElement('div');
        gTop.className = 'card-row';
        const addG = this.createButton('➕ Add Gauge Probe', 'transport-tool-btn', () => {
            this.addGaugeProbe();
        });
        const toggleAllG = this.createButton('🎯 Virtual Gauges', `chip-btn fixed-toggle-btn ${this.activeLayers.gauges ? 'active' : ''}`, () => {
            this.activeLayers.gauges = !this.activeLayers.gauges;
            toggleAllG.classList.toggle('active', this.activeLayers.gauges);
            this.onLayerToggle?.('gauges', this.activeLayers.gauges);
        });
        gTop.appendChild(addG);
        gTop.appendChild(toggleAllG);
        body1.appendChild(gTop);

        const gTable = document.createElement('table');
        gTable.className = 'slices-matrix-table';
        gTable.innerHTML = `
            <thead>
                <tr>
                    <th>#</th>
                    <th>Probe ID</th>
                    <th>X (m)</th>
                    <th>Y (m)</th>
                    <th>Z (m)</th>
                    <th>Action</th>
                </tr>
            </thead>
            <tbody>
            </tbody>
        `;
        const gBody = gTable.querySelector('tbody')!;

        const targetModel = this.stateManager.getActiveModel();
        const gaugeNode = targetModel?.nodes.find((n: any) => n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D' || n.type === 'VirtualGauge');
        const gauges: any[] = gaugeNode?.parameters?.gauges || [
            { id: 'P1', x: 0.0, y: 0.0, z: 0.0 }
        ];

        gauges.forEach((g: any, gIdx: number) => {
            const gTr = document.createElement('tr');
            gTr.innerHTML = `
                <td>#${gIdx + 1}</td>
                <td><strong>${g.id || 'P' + (gIdx + 1)}</strong></td>
                <td>${Number(g.x ?? 0).toFixed(3)}</td>
                <td>${Number(g.y ?? 0).toFixed(3)}</td>
                <td>${Number(g.z ?? 0).toFixed(3)}</td>
                <td><button class="table-icon-btn danger">✖</button></td>
            `;
            gTr.querySelector('.danger')?.addEventListener('click', () => {
                this.removeGaugeProbe(gIdx);
            });
            gBody.appendChild(gTr);
        });

        body1.appendChild(gTable);
        card1.appendChild(body1);
        grid.appendChild(card1);

        // CARD 2: ROI Clip Volume & Element Filters
        const card2 = document.createElement('div');
        card2.className = 'workstation-card';
        card2.innerHTML = `<div class="card-header"><span>✂ ROI CLIPPING & ELEMENT FILTERS</span></div>`;
        const body2 = document.createElement('div');
        body2.className = 'card-body';

        // ROI Bounding Box Toggle
        const roiRow = document.createElement('div');
        roiRow.className = 'card-row';
        const roiBtn = this.createButton('✂ ROI Bounding Box', `chip-btn fixed-toggle-btn ${this.roiEnabled ? 'active' : ''}`, () => {
            this.roiEnabled = !this.roiEnabled;
            roiBtn.classList.toggle('active', this.roiEnabled);
            this.onROIChange?.({ enabled: this.roiEnabled, xMin: this.roiXMin, xMax: this.roiXMax, yMin: this.roiYMin, yMax: this.roiYMax, zMin: this.roiZMin, zMax: this.roiZMax });
        });
        roiRow.appendChild(roiBtn);
        body2.appendChild(roiRow);

        // Failed Element Filter & Stride
        const filterRow = document.createElement('div');
        filterRow.className = 'card-row';
        const hideErodedBtn = this.createButton('🚫 Hide Failed Elements', `chip-btn fixed-toggle-btn ${this.hideEroded ? 'active' : ''}`, () => {
            this.hideEroded = !this.hideEroded;
            hideErodedBtn.classList.toggle('active', this.hideEroded);
            this.onParticleFilterChange?.({ hideEroded: this.hideEroded, stride: this.particleStride });
        });
        filterRow.appendChild(hideErodedBtn);

        const strideSelect = document.createElement('select');
        strideSelect.className = 'transport-select';
        [
            { label: 'All Particles (1:1)', val: 1 },
            { label: 'Subsample 50% (1:2)', val: 2 },
            { label: 'Subsample 25% (1:4)', val: 4 },
            { label: 'Subsample 12.5% (1:8)', val: 8 }
        ].forEach(st => {
            const opt = document.createElement('option');
            opt.value = String(st.val);
            opt.textContent = st.label;
            if (st.val === this.particleStride) opt.selected = true;
            strideSelect.appendChild(opt);
        });
        strideSelect.addEventListener('change', () => {
            this.particleStride = parseInt(strideSelect.value, 10);
            this.onParticleFilterChange?.({ hideEroded: this.hideEroded, stride: this.particleStride });
        });
        filterRow.appendChild(strideSelect);
        body2.appendChild(filterRow);

        card2.appendChild(body2);
        grid.appendChild(card2);

        this.tabContentContainer.appendChild(grid);
    }

    // =========================================================================
    // TAB 6: SELECTED 3D OBJECT (Context-Sensitive Entity Quick Inspector)
    // =========================================================================
    private renderTabContextObject(): void {
        const wrap = document.createElement('div');
        wrap.className = 'workstation-context-container';

        if (!this.selectedObject) {
            wrap.innerHTML = `
                <div class="empty-context-state">
                    <span style="font-size: 24px;">🖱️</span>
                    <span>Click any object in the 3D viewport (Charge, Mesh, Slices, Gauges, CAD) to inspect properties here.</span>
                </div>
            `;
            this.tabContentContainer.appendChild(wrap);
            return;
        }

        const card = document.createElement('div');
        card.className = 'workstation-card context-focus-card';

        const head = document.createElement('div');
        head.className = 'card-header context-head';
        head.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 16px;">📦</span>
                <span style="font-weight: 700; font-size: 12px; color: #00d2ff;">${this.selectedObject.label}</span>
                <span class="vcm-type-badge">${this.selectedObject.objectType}</span>
            </div>
            <button class="transport-tool-btn" id="btn-deselect-obj">✖ Close Inspector</button>
        `;
        head.querySelector('#btn-deselect-obj')?.addEventListener('click', () => {
            this.selectedObject = null;
            const contextTabBtn = this.tabsHeader?.querySelector('.context-tab-btn') as HTMLElement;
            if (contextTabBtn) contextTabBtn.style.display = 'none';
            this.switchTab('sim_view');
        });
        card.appendChild(head);

        const body = document.createElement('div');
        body.className = 'card-body context-body';

        // Context-sensitive field & display controls
        const fieldControls = this.createFieldAndColormapCard(false);
        body.appendChild(fieldControls);

        // Actions toolbar
        const actionsRow = document.createElement('div');
        actionsRow.className = 'card-row';
        actionsRow.style.marginTop = '6px';

        const inspectBtn = this.createButton('🔍 Inspect in Sidebar', 'transport-tool-btn primary', () => {
            if (this.selectedObject?.nodeId) {
                this.stateManager.setSelectedNode(this.selectedObject.nodeId);
            }
        });

        const frameBtn = this.createButton('🎯 Frame Selection', 'transport-tool-btn', () => {
            this.onCameraSnap?.('iso');
        });

        actionsRow.appendChild(inspectBtn);
        actionsRow.appendChild(frameBtn);
        body.appendChild(actionsRow);

        card.appendChild(body);
        wrap.appendChild(card);
        this.tabContentContainer.appendChild(wrap);
    }

    // =========================================================================
    // CONTEXT-SENSITIVE VIEWPORT ENTITY RESOLVER & SETTER
    // =========================================================================
    public isIdealGasModel(): boolean {
        const activeModel = this.stateManager.getActiveModel();
        if (!activeModel || !activeModel.nodes) return false;

        // 1. Check CFD Solvers
        const cfdSolver = activeModel.nodes.find((n: any) => ['CFDSolver3D', 'CFDSolver2D', 'CFDSolver1D'].includes(n.type));
        if (cfdSolver) {
            const initMode = cfdSolver.parameters?.init_mode;
            if (initMode === 'Ideal Gas') return true;
            if (initMode === 'Multi-Material JWL' || initMode === 'From1D' || initMode === 'From2D' || initMode === 'JWL') return false;
            if (cfdSolver.parameters?.is_ideal_gas === true) return true;
        }

        // 2. Check Material / Explosive / Charge nodes
        const matNode = activeModel.nodes.find((n: any) => ['Material', 'ExplosiveMaterial'].includes(n.type));
        if (matNode) {
            const matType = matNode.parameters?.material_type;
            const expType = matNode.parameters?.explosive_type;
            if (matType === 'Ideal Gas' || matType === 'Ideal Gas Charge' || expType === 'MaterialIdealGas') return true;
            if (matType === 'JWL Charge' || expType === 'MaterialExplosive') return false;
        }

        const chargeNode = activeModel.nodes.find((n: any) => ['Charge3D', 'Charge2D'].includes(n.type));
        if (chargeNode) return false;

        return false;
    }

    public getCFDQuantities(isSlice: boolean = false): Array<{ val: string; label: string }> {
        const isIdeal = this.isIdealGasModel();
        const list: Array<{ val: string; label: string }> = [
            { val: 'pressure', label: 'Pressure (Pa)' },
            { val: 'density', label: 'Density (kg/m³)' },
            { val: 'velocity', label: 'Velocity Mag (m/s)' },
            { val: 'energy', label: 'Specific Energy (J/kg)' },
            { val: 'peak_overpressure', label: 'Peak Overpressure (Pa)' },
            { val: 'peak_impulse', label: 'Specific Impulse (Pa·s)' }
        ];

        if (!isIdeal) {
            list.push(
                { val: 'species1', label: 'Detonation Products (Reacted Gas / α₁)' },
                { val: 'species2', label: 'Unreacted Explosive Solid (α₂)' },
                { val: 'species3', label: 'Air / Ambient Gas (1 - α₁ - α₂)' }
            );
        }

        if (isSlice) {
            list.push({ val: 'solid', label: 'Obstacle Solid Mask' });
            list.push({ val: 'amr_level', label: 'AMR Level' });
        }

        const activeModel = this.stateManager.getActiveModel();
        const hasFEM = activeModel?.nodes?.some((n: any) => ['FEMObject3D', 'FEMDomain3D', 'LSDynaImporter3D'].includes(n.type));
        const hasMPM = activeModel?.nodes?.some((n: any) => ['MPMObject3D', 'MPMDomain3D'].includes(n.type));

        if (!isSlice && (hasFEM || hasMPM)) {
            list.push(
                { val: 'vonMises', label: 'von Mises Stress (MPa)' },
                { val: 'plasticStrain', label: 'Plastic Strain' },
                { val: 'damage', label: 'Damage Variable (D)' }
            );
        }

        return list;
    }

    public getMPMQuantities(): Array<{ val: string; label: string }> {
        return [
            { val: 'vonMises', label: 'von Mises Stress (Pa)' },
            { val: 'plastic_strain', label: 'Equivalent Plastic Strain' },
            { val: 'damage', label: 'Damage (D)' },
            { val: 'velocity', label: 'Velocity Magnitude (m/s)' },
            { val: 'cluster_id', label: 'Cluster ID (Fragments)' },
            { val: 'object_id', label: 'Object / Body ID' },
            { val: 'density', label: 'Density (kg/m³)' },
            { val: 'pressure', label: 'Hydrostatic Pressure (Pa)' }
        ];
    }

    public getFEMQuantities(): Array<{ val: string; label: string }> {
        return [
            { val: 'vonMises', label: 'von Mises Stress (Pa)' },
            { val: 'plasticStrain', label: 'Equivalent Plastic Strain' },
            { val: 'displacement', label: 'Displacement (m)' },
            { val: 'damage', label: 'Damage (D)' },
            { val: 'velocity', label: 'Velocity Magnitude (m/s)' },
            { val: 'pressure', label: 'Hydrostatic Pressure (Pa)' }
        ];
    }

    public getSlices(): any[] {
        const domainNode = this.getActiveDomainNode();
        if (domainNode?.parameters?.slices && Array.isArray(domainNode.parameters.slices) && domainNode.parameters.slices.length > 0) {
            return domainNode.parameters.slices;
        }
        const vpNode = this.getActiveViewportNode();
        if (vpNode?.parameters?.slices && Array.isArray(vpNode.parameters.slices) && vpNode.parameters.slices.length > 0) {
            return vpNode.parameters.slices;
        }
        const activeModel = this.stateManager.getActiveModel();
        const meshNode = activeModel?.nodes.find((n: any) => n.type === 'DomainMesh3D' || n.type === 'DomainMesh');
        if (meshNode?.parameters?.slices && Array.isArray(meshNode.parameters.slices) && meshNode.parameters.slices.length > 0) {
            return meshNode.parameters.slices;
        }
        return domainNode?.parameters?.slices || vpNode?.parameters?.slices || [];
    }

    public getSliceBounds(axis?: string): { min: number; max: number } {
        let min = 0.0;
        let max = 1.0;
        const ax = String(axis || 'xy').toLowerCase();
        const activeModel = this.stateManager.getActiveModel();
        const meshNode = activeModel?.nodes.find((n: any) => n.type === 'DomainMesh3D' || n.type === 'DomainMesh' || n.type === 'DomainMesh2D');
        if (meshNode) {
            const xmin = Number(meshNode.parameters?.xmin ?? meshNode.parameters?.x_min ?? 0.0);
            const xmax = Number(meshNode.parameters?.xmax ?? meshNode.parameters?.x_max ?? 1.0);
            const ymin = Number(meshNode.parameters?.ymin ?? meshNode.parameters?.y_min ?? 0.0);
            const ymax = Number(meshNode.parameters?.ymax ?? meshNode.parameters?.y_max ?? 1.0);
            const zmin = Number(meshNode.parameters?.zmin ?? meshNode.parameters?.z_min ?? 0.0);
            const zmax = Number(meshNode.parameters?.zmax ?? meshNode.parameters?.z_max ?? 1.0);
            if (ax === 'yz' || ax === '2' || ax === 'x' || ax.startsWith('x-norm') || ax === 'normal x' || ax === 'x normal') {
                min = xmin;
                max = xmax;
            } else if (ax === 'xz' || ax === '1' || ax === 'y' || ax.startsWith('y-norm') || ax === 'normal y' || ax === 'y normal') {
                min = ymin;
                max = ymax;
            } else {
                min = zmin;
                max = zmax;
            }
        }
        return { min, max };
    }

    public getCurrentContextSettings(): ContextualVisualSettings {
        const vpNode = this.getActiveViewportNode();
        const params = vpNode?.parameters || {};
        const activeModel = this.stateManager.getActiveModel();
        const isGloballyLocked = params.lock_quantity_ranges !== false;

        // 1. Check if Slice is selected
        const isExplicitNonSlice = this.selectedObject && this.selectedObject.objectType !== 'Slice';
        const selectedSliceIdx = (!isExplicitNonSlice && this.selectedObject?.objectType === 'Slice' && this.selectedObject.sliceIndex !== undefined)
            ? this.selectedObject.sliceIndex
            : (!isExplicitNonSlice ? this.stateManager.getSelectedSliceIndex() : null);

        if (selectedSliceIdx !== null && selectedSliceIdx !== undefined) {
            const domainNode = this.getActiveDomainNode();
            const slices = this.getSlices();
            const slice = slices[selectedSliceIdx] || {};
            let rawQ = slice.quantities?.[0] || slice.quantity || 'pressure';
            if (rawQ === 'species_1' || rawQ === 'species' || rawQ === 'products' || rawQ === 'detonation_products' || rawQ === 'detonation' || rawQ === 'reacted' || rawQ === 'reacted_gas' || rawQ === 'alpha1' || rawQ === 'alpha_1') rawQ = 'species1';
            else if (rawQ === 'species_2' || rawQ === 'unreacted' || rawQ === 'unreacted_solid' || rawQ === 'solid_he' || rawQ === 'alpha2' || rawQ === 'alpha_2') rawQ = 'species2';
            else if (rawQ === 'species_3' || rawQ === 'air' || rawQ === 'ambient_air' || rawQ === 'alpha3' || rawQ === 'alpha_3') rawQ = 'species3';
            else if (rawQ === 'von_mises') rawQ = 'vonMises';
            else if (rawQ === 'plastic_strain') rawQ = 'plasticStrain';
            const axis = (slice.axis || 'xy').toUpperCase();
            const bounds = this.getSliceBounds(slice.axis || 'xy');
            const defaultSliceRange = params.quantity_ranges?.[rawQ] || DEFAULT_QUANTITY_RANGES[rawQ] || [0.0, 1.0];
            let sMin = slice.min_val ?? defaultSliceRange[0];
            let sMax = slice.max_val ?? defaultSliceRange[1];
            if (isGloballyLocked) {
                sMin = defaultSliceRange[0];
                sMax = defaultSliceRange[1];
            }

            return {
                targetType: 'slice',
                targetLabel: `Slice #${selectedSliceIdx} (${getSliceAxisLabel(slice.axis)})`,
                targetIcon: '🥞',
                sliceIndex: selectedSliceIdx,
                nodeId: domainNode?.id || vpNode?.id,
                quantity: rawQ,
                availableQuantities: this.getCFDQuantities(true),
                colormap: ((isGloballyLocked ? params.quantity_colormaps?.[rawQ] : undefined) || slice.colormap || 'rainbow') as ColormapType,
                autoScale: slice.auto_scale !== false,
                minVal: sMin,
                maxVal: sMax,
                logScale: (isGloballyLocked ? params.quantity_log_scales?.[rawQ] : undefined) ?? (slice.log_scale === true),
                isLocked: isGloballyLocked,
                contourLevels: slice.contour_levels ?? params.sliceContourLevels ?? 10,
                smoothContours: slice.smooth_contours ?? params.sliceSmoothContours ?? false,
                showColorbar: slice.show_colorbar === true,
                showMeshLines: slice.interpolate === false || slice.gridlines === true,
                visibility: slice.enabled !== false,
                interpolate: slice.interpolate !== false,
                sliceAxis: (slice.axis || 'xy').toLowerCase(),
                sliceOffset: slice.offset !== undefined ? Number(slice.offset) : 0.0,
                sliceOpacity: slice.opacity !== undefined ? Number(slice.opacity) : 1.0,
                sliceStride: slice.stride !== undefined ? Number(slice.stride) : 1,
                domainMin: bounds.min,
                domainMax: bounds.max
            };
        }

        // 2. Check if selectedObject or selectedNode is FEM
        const selectedNodeId = this.selectedObject?.nodeId || this.stateManager.selectedNodeId;
        const selectedNode = activeModel?.nodes.find((n: any) => n.id === selectedNodeId);
        const objType = this.selectedObject?.objectType || selectedNode?.type || '';

        if (['FEMObject3D', 'FEMDomain3D', 'FEMBeam3D', 'FEMRebar3D', 'LSDynaImporter3D'].includes(objType)) {
            const rawFemQ = selectedNode?.parameters?.femQuantity || selectedNode?.parameters?.quantity || params.femQuantity || 'vonMises';
            const femQ = canonicalizeQuantity(rawFemQ);
            const defaultFemRange = params.quantity_ranges?.[femQ] || DEFAULT_QUANTITY_RANGES[femQ] || [0.0, (femQ === 'plastic_strain' ? 1.0 : 500.0e6)];
            const femCmap = ((isGloballyLocked ? params.quantity_colormaps?.[femQ] : undefined) || selectedNode?.parameters?.femColormap || selectedNode?.parameters?.colormap || params.femColormap || 'rainbow') as ColormapType;
            const femAuto = (isGloballyLocked ? (params.quantity_auto_scales?.[femQ] !== false) : undefined) ?? ((selectedNode?.parameters?.femAutoScale ?? params.femAutoScale) !== false);
            let femMin = isGloballyLocked ? defaultFemRange[0] : (selectedNode?.parameters?.femMinVal ?? params.femMinVal ?? defaultFemRange[0]);
            let femMax = isGloballyLocked ? defaultFemRange[1] : (selectedNode?.parameters?.femMaxVal ?? params.femMaxVal ?? defaultFemRange[1]);
            const femLog = (isGloballyLocked ? params.quantity_log_scales?.[femQ] : undefined) ?? ((selectedNode?.parameters?.femLogScale ?? params.femLogScale) === true);
            const femBar = (selectedNode?.parameters?.femShowColorbar ?? selectedNode?.parameters?.showColorbar ?? params.femShowColorbar) !== false;
            const femWire = (selectedNode?.parameters?.femWireframe ?? selectedNode?.parameters?.wireframe ?? params.femWireframe) !== false;
            const femVis = this.isLayerActive('fem') && (selectedNode?.parameters?.visible !== false && !selectedNode?.parameters?.hidden);
            const isBeamOrRebar = objType === 'FEMBeam3D' || objType === 'FEMRebar3D';
            const femLevels = isBeamOrRebar
                ? (selectedNode?.parameters?.beamContourLevels ?? params.beamContourLevels ?? 10)
                : (selectedNode?.parameters?.femContourLevels ?? params.femContourLevels ?? 10);
            const femSmooth = isBeamOrRebar
                ? (selectedNode?.parameters?.beamSmoothContours ?? params.beamSmoothContours ?? false)
                : (selectedNode?.parameters?.femSmoothContours ?? params.femSmoothContours ?? false);

            return {
                targetType: 'fem',
                targetLabel: selectedNode?.parameters?.name || this.selectedObject?.label || (isBeamOrRebar ? 'Beam / Rebar 1D' : 'FEM Mesh'),
                targetIcon: isBeamOrRebar ? '📏' : '🏗️',
                nodeId: selectedNode?.id || vpNode?.id,
                quantity: femQ,
                availableQuantities: [
                    { val: 'vonMises', label: 'von Mises Stress (MPa)' },
                    { val: 'plastic_strain', label: 'Plastic Strain' },
                    { val: 'damage', label: 'Damage Variable (D)' },
                    { val: 'displacement', label: 'Displacement Mag (m)' },
                    { val: 'velocity', label: 'Velocity Mag (m/s)' },
                    { val: 'pressure', label: 'Hydrostatic Pressure (Pa)' },
                    { val: 'density', label: 'Density (kg/m³)' },
                    { val: 'energy', label: 'Internal Energy (J/kg)' },
                    { val: 'failure_flag', label: 'Failure / Erosion' }
                ],
                colormap: femCmap,
                autoScale: femAuto,
                minVal: femMin,
                maxVal: femMax,
                logScale: femLog,
                isLocked: isGloballyLocked,
                contourLevels: femLevels,
                smoothContours: femSmooth,
                showColorbar: femBar,
                showMeshLines: femWire,
                visibility: femVis,
                lighting: params.femLighting !== false,
                opacity: selectedNode?.parameters?.femOpacity ?? params.femOpacity ?? 1.0
            };
        }

        const isMarineSleeve = (objType === 'MarineHarbourDomain' && (!this.selectedObject?.childId || this.selectedObject.childId === 'water_sleeve' || this.selectedObject.childId === 'sleeve')) ||
                               objType === 'MPMSleeve' || (this.selectedObject?.childId === 'water_sleeve');
        const isMarineSoil = (objType === 'MarineHarbourDomain' && (this.selectedObject?.childId === 'seabed_soil' || this.selectedObject?.childId === 'soil_scour' || this.selectedObject?.childId === 'soil')) ||
                             objType === 'MPMSoil' || (this.selectedObject?.childId === 'seabed_soil');

        // 3. Check if MPM
        if (['MPMObject3D', 'MPMDomain3D'].includes(objType) || isMarineSleeve || isMarineSoil) {
            const rawMpmQ = selectedNode?.parameters?.mpmParticleQuantity || selectedNode?.parameters?.quantity || params.mpmParticleQuantity || 'vonMises';
            const mpmQ = canonicalizeQuantity(rawMpmQ);
            const defaultMpmRange = params.quantity_ranges?.[mpmQ] || DEFAULT_QUANTITY_RANGES[mpmQ] || [0.0, 500.0e6];
            const mpmCmap = ((isGloballyLocked ? params.quantity_colormaps?.[mpmQ] : undefined) || selectedNode?.parameters?.mpmParticleColormap || selectedNode?.parameters?.colormap || params.mpmParticleColormap || 'rainbow') as ColormapType;
            const mpmAuto = (isGloballyLocked ? (params.quantity_auto_scales?.[mpmQ] !== false) : undefined) ?? ((selectedNode?.parameters?.mpmParticleAutoScale ?? params.mpmParticleAutoScale) !== false);
            let mpmMin = isGloballyLocked ? defaultMpmRange[0] : (selectedNode?.parameters?.mpmParticleMinVal ?? params.mpmParticleMinVal ?? defaultMpmRange[0]);
            let mpmMax = isGloballyLocked ? defaultMpmRange[1] : (selectedNode?.parameters?.mpmParticleMaxVal ?? params.mpmParticleMaxVal ?? defaultMpmRange[1]);
            const mpmLog = (isGloballyLocked ? params.quantity_log_scales?.[mpmQ] : undefined) ?? ((selectedNode?.parameters?.mpmParticleLogScale ?? params.mpmParticleLogScale) === true);
            const mpmBar = (selectedNode?.parameters?.mpmParticleShowColorbar ?? selectedNode?.parameters?.showColorbar ?? params.mpmParticleShowColorbar) === true;
            const mpmWire = (selectedNode?.parameters?.mpmParticleWireframe ?? selectedNode?.parameters?.wireframe ?? params.mpmParticleWireframe) === true;
            let mpmVis = this.isLayerActive('mpm') && (selectedNode?.parameters?.visible !== false && !selectedNode?.parameters?.hidden);
            if (isMarineSleeve) {
                mpmVis = this.isLayerActive('mpm') && (selectedNode?.parameters?.show_water_sleeve !== false) && (selectedNode?.parameters?.visible !== false && !selectedNode?.parameters?.hidden);
            } else if (isMarineSoil) {
                mpmVis = this.isLayerActive('mpm') && (selectedNode?.parameters?.show_soil_mpm !== false) && (selectedNode?.parameters?.visible !== false && !selectedNode?.parameters?.hidden);
            }
            const mpmLevels = selectedNode?.parameters?.mpmContourLevels ?? params.mpmContourLevels ?? 10;
            const mpmSmooth = selectedNode?.parameters?.mpmSmoothContours ?? params.mpmSmoothContours ?? false;

            let targetLabel = selectedNode?.parameters?.name || this.selectedObject?.label || 'MPM Particles';
            let targetIcon = '✨';
            if (isMarineSleeve) {
                targetLabel = this.selectedObject?.label || 'Water Sleeve (MPM)';
                targetIcon = '🌊';
            } else if (isMarineSoil) {
                targetLabel = this.selectedObject?.label || 'Soil Scour (MPM)';
                targetIcon = '💥';
            }

            return {
                targetType: 'mpm',
                targetLabel,
                targetIcon,
                nodeId: selectedNode?.id || vpNode?.id,
                quantity: mpmQ,
                availableQuantities: [
                    { val: 'vonMises', label: 'von Mises Stress (MPa)' },
                    { val: 'plastic_strain', label: 'Plastic Strain' },
                    { val: 'damage', label: 'Damage Variable (D)' },
                    { val: 'velocity', label: 'Velocity Mag (m/s)' },
                    { val: 'density', label: 'Density (kg/m³)' },
                    { val: 'pressure', label: 'Pressure (Pa)' },
                    { val: 'energy', label: 'Specific Energy (J/kg)' },
                    { val: 'cluster_id', label: 'Fragment Cluster ID' },
                    { val: 'failure_flag', label: 'Failure / Erosion' }
                ],
                colormap: mpmCmap,
                autoScale: mpmAuto,
                minVal: mpmMin,
                maxVal: mpmMax,
                logScale: mpmLog,
                isLocked: isGloballyLocked,
                contourLevels: mpmLevels,
                smoothContours: mpmSmooth,
                showColorbar: mpmBar,
                showMeshLines: mpmWire,
                visibility: mpmVis,
                opacity: selectedNode?.parameters?.mpmParticleOpacity ?? params.mpmParticleOpacity ?? 1.0
            };
        }

        // 4. Check if STL CAD
        if (objType === 'STLGeometry') {
            const stlQ = canonicalizeQuantity(selectedNode?.parameters?.stl_quantity || selectedNode?.parameters?.quantity || params.stl_quantity || 'pressure');
            const defaultStlRange = params.quantity_ranges?.[stlQ] || DEFAULT_QUANTITY_RANGES[stlQ] || [0.0, 1.0];
            const rawStlCmap = selectedNode?.parameters?.stl_colormap || selectedNode?.parameters?.colormap || params.stl_colormap || 'rainbow';
            const stlCmap = ((isGloballyLocked ? params.quantity_colormaps?.[stlQ] : undefined) || rawStlCmap) as ColormapType;
            const stlAuto = (isGloballyLocked ? (params.quantity_auto_scales?.[stlQ] !== false) : undefined) ?? ((selectedNode?.parameters?.stl_auto_scale ?? params.stl_auto_scale) !== false);
            let stlMin = isGloballyLocked ? defaultStlRange[0] : (selectedNode?.parameters?.stl_min_val ?? params.stl_min_val ?? defaultStlRange[0]);
            let stlMax = isGloballyLocked ? defaultStlRange[1] : (selectedNode?.parameters?.stl_max_val ?? params.stl_max_val ?? defaultStlRange[1]);
            const stlLog = (isGloballyLocked ? params.quantity_log_scales?.[stlQ] : undefined) ?? ((selectedNode?.parameters?.stl_log_scale ?? params.stl_log_scale) === true);
            const stlBar = (selectedNode?.parameters?.stl_show_colorbar ?? selectedNode?.parameters?.showColorbar ?? params.stl_show_colorbar) === true;
            const stlWire = (selectedNode?.parameters?.stl_wireframe ?? selectedNode?.parameters?.wireframe ?? params.stl_wireframe) === true;
            const stlVis = this.isLayerActive('stl') && (selectedNode?.parameters?.visible !== false && !selectedNode?.parameters?.hidden);

            return {
                targetType: 'stl',
                targetLabel: selectedNode?.parameters?.name || this.selectedObject?.label || 'STL CAD',
                targetIcon: '📐',
                nodeId: selectedNode?.id || vpNode?.id,
                quantity: stlQ,
                availableQuantities: this.getCFDQuantities(false),
                colormap: stlCmap,
                autoScale: stlAuto,
                minVal: stlMin,
                maxVal: stlMax,
                logScale: stlLog,
                isLocked: isGloballyLocked,
                showColorbar: stlBar,
                showMeshLines: stlWire,
                visibility: stlVis,
                lighting: params.stl_lighting !== false,
                opacity: selectedNode?.parameters?.stl_opacity ?? params.stl_opacity ?? 1.0
            };
        }

        // 5. Check if Obstacles / Primitive Geometry
        if (['PrimitiveGeometry3D', 'Obstacle', 'Obstacles', 'Obstacle3D', 'OBSTACLES'].includes(objType)) {
            const obsQ = canonicalizeQuantity(selectedNode?.parameters?.obstacles_quantity || selectedNode?.parameters?.quantity || params.obstacles_quantity || 'pressure');
            const defaultObsRange = params.quantity_ranges?.[obsQ] || DEFAULT_QUANTITY_RANGES[obsQ] || [0.0, 1.0];
            const rawObsCmap = selectedNode?.parameters?.obstacles_colormap || selectedNode?.parameters?.colormap || params.obstacles_colormap || 'rainbow';
            const obsCmap = ((isGloballyLocked ? params.quantity_colormaps?.[obsQ] : undefined) || rawObsCmap) as ColormapType;
            const obsAuto = (isGloballyLocked ? (params.quantity_auto_scales?.[obsQ] !== false) : undefined) ?? ((selectedNode?.parameters?.obstacles_auto_scale ?? params.obstacles_auto_scale) !== false);
            let obsMin = isGloballyLocked ? defaultObsRange[0] : (selectedNode?.parameters?.obstacles_min_val ?? params.obstacles_min_val ?? defaultObsRange[0]);
            let obsMax = isGloballyLocked ? defaultObsRange[1] : (selectedNode?.parameters?.obstacles_max_val ?? params.obstacles_max_val ?? defaultObsRange[1]);
            const obsLog = (isGloballyLocked ? params.quantity_log_scales?.[obsQ] : undefined) ?? ((selectedNode?.parameters?.obstacles_log_scale ?? params.obstacles_log_scale) === true);
            const obsBar = (selectedNode?.parameters?.obstacles_show_colorbar ?? selectedNode?.parameters?.showColorbar ?? params.obstacles_show_colorbar) === true;
            const obsGrid = (selectedNode?.parameters?.obstacles_gridlines ?? selectedNode?.parameters?.wireframe ?? params.obstacles_gridlines) !== false;
            const obsVis = this.isLayerActive('obstacles') && (selectedNode?.parameters?.visible !== false && !selectedNode?.parameters?.hidden);

            return {
                targetType: 'obstacles',
                targetLabel: selectedNode?.parameters?.name || this.selectedObject?.label || 'Obstacles',
                targetIcon: '🧱',
                nodeId: selectedNode?.id || vpNode?.id,
                quantity: obsQ,
                availableQuantities: this.getCFDQuantities(false),
                colormap: obsCmap,
                autoScale: obsAuto,
                minVal: obsMin,
                maxVal: obsMax,
                logScale: obsLog,
                isLocked: isGloballyLocked,
                showColorbar: obsBar,
                showMeshLines: obsGrid,
                visibility: obsVis,
                lighting: params.obstacles_lighting !== false,
                opacity: selectedNode?.parameters?.obstacles_opacity ?? params.obstacles_opacity ?? 1.0
            };
        }

        // 6. Check if Virtual Gauges
        if (['VirtualGauges', 'VirtualGauges3D', 'VirtualGauge'].includes(objType)) {
            return {
                targetType: 'gauges',
                targetLabel: selectedNode?.parameters?.name || this.selectedObject?.label || 'Virtual Gauges',
                targetIcon: '🎯',
                nodeId: selectedNode?.id || vpNode?.id,
                quantity: 'pressure',
                availableQuantities: [
                    { val: 'pressure', label: 'Pressure (Pa)' },
                    { val: 'peak_overpressure', label: 'Peak Overpressure (Pa)' },
                    { val: 'peak_impulse', label: 'Specific Impulse (Pa·s)' },
                    { val: 'velocity', label: 'Velocity Mag (m/s)' },
                    { val: 'density', label: 'Density (kg/m³)' }
                ],
                colormap: 'turbo',
                autoScale: true,
                minVal: 0.0,
                maxVal: 1000000.0,
                logScale: false,
                isLocked: isGloballyLocked,
                showColorbar: params.show_gauges === true,
                showMeshLines: true,
                visibility: params.show_gauges !== false
            };
        }

        // 7. Check if Detonator
        if (['DetonatorLocation3D', 'DetonatorLocation', 'TriggerLocation3D', 'TriggerLocation'].includes(objType)) {
            return {
                targetType: 'detonator',
                targetLabel: selectedNode?.parameters?.name || this.selectedObject?.label || 'Detonator',
                targetIcon: '🎯',
                nodeId: selectedNode?.id || vpNode?.id,
                quantity: 'detonator',
                availableQuantities: [
                    { val: 'detonator', label: 'Detonator Location' }
                ],
                colormap: 'inferno',
                autoScale: true,
                minVal: 0.0,
                maxVal: 1.0,
                logScale: false,
                isLocked: isGloballyLocked,
                showColorbar: false,
                showMeshLines: params.detonators_wireframe === true || params.detonator_wireframe === true,
                visibility: (params.show_detonators ?? params.show_detonator) !== false
            };
        }

        // 8. Check if Charge
        if (['Charge3D', 'Charge2D', 'Charge1D', 'ExplosiveMaterial'].includes(objType)) {
            return {
                targetType: 'charge',
                targetLabel: selectedNode?.parameters?.name || this.selectedObject?.label || 'Charge',
                targetIcon: '💣',
                nodeId: selectedNode?.id || vpNode?.id,
                quantity: 'products',
                availableQuantities: [
                    { val: 'products', label: 'Burn Fraction (Reacted)' },
                    { val: 'density', label: 'Initial Density (kg/m³)' }
                ],
                colormap: 'inferno',
                autoScale: true,
                minVal: 0.0,
                maxVal: 1.0,
                logScale: false,
                isLocked: isGloballyLocked,
                showColorbar: false,
                showMeshLines: params.charge_wireframe === true,
                visibility: true
            };
        }

        // 8. Global Modality-Aware Viewport Fallback
        const hasMPM = activeModel?.nodes.some(n => n.type === 'MPMDomain3D' || n.type === 'MPMObject3D');
        const hasFEM = activeModel?.nodes.some(n => n.type === 'FEMDomain3D' || n.type === 'FEMObject3D' || n.type === 'LSDynaImporter3D');
        const hasCFD = activeModel?.nodes.some(n => n.type === 'CFDSolver3D' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver');

        if (hasMPM && !hasCFD) {
            const rawMpmQ = params.mpmParticleQuantity || this.activeQuantity || 'vonMises';
            const mpmQ = canonicalizeQuantity(rawMpmQ);
            const mpmRange = params.quantity_ranges?.[mpmQ] || DEFAULT_QUANTITY_RANGES[mpmQ] || [0.0, 500000000.0];
            const mpmCmap = ((isGloballyLocked ? params.quantity_colormaps?.[mpmQ] : undefined) || params.mpmParticleColormap || params.colormap || this.activeColormap || 'plasma') as ColormapType;
            const mpmAuto = isGloballyLocked ? (params.quantity_auto_scales?.[mpmQ] !== false) : (params.mpmParticleAutoScale !== false);
            const mpmLog = isGloballyLocked ? (params.quantity_log_scales?.[mpmQ] ?? (params.mpmParticleLogScale === true)) : (params.mpmParticleLogScale === true);
            const mpmMin = isGloballyLocked ? mpmRange[0] : (params.mpmParticleMinVal !== undefined ? Number(params.mpmParticleMinVal) : mpmRange[0]);
            const mpmMax = isGloballyLocked ? mpmRange[1] : (params.mpmParticleMaxVal !== undefined ? Number(params.mpmParticleMaxVal) : mpmRange[1]);

            return {
                targetType: 'global',
                targetLabel: 'Global MPM',
                targetIcon: '✨',
                nodeId: vpNode?.id,
                quantity: mpmQ,
                availableQuantities: this.getMPMQuantities(),
                colormap: mpmCmap,
                autoScale: mpmAuto,
                minVal: mpmMin,
                maxVal: mpmMax,
                logScale: mpmLog,
                isLocked: isGloballyLocked,
                showColorbar: params.mpmParticleShowColorbar !== false,
                showMeshLines: this.activeLayers.grid !== false || params.show_grid !== false,
                visibility: this.isLayerActive('mpm')
            };
        }

        if (hasFEM && !hasCFD) {
            const rawFemQ = params.femQuantity || this.activeQuantity || 'vonMises';
            const femQ = canonicalizeQuantity(rawFemQ);
            const femRange = params.quantity_ranges?.[femQ] || DEFAULT_QUANTITY_RANGES[femQ] || [0.0, 500000000.0];
            const femCmap = ((isGloballyLocked ? params.quantity_colormaps?.[femQ] : undefined) || params.femColormap || params.colormap || this.activeColormap || 'plasma') as ColormapType;
            const femAuto = isGloballyLocked ? (params.quantity_auto_scales?.[femQ] !== false) : (params.femAutoScale !== false);
            const femLog = isGloballyLocked ? (params.quantity_log_scales?.[femQ] ?? (params.femLogScale === true)) : (params.femLogScale === true);
            const femMin = isGloballyLocked ? femRange[0] : (params.femMinVal !== undefined ? Number(params.femMinVal) : femRange[0]);
            const femMax = isGloballyLocked ? femRange[1] : (params.femMaxVal !== undefined ? Number(params.femMaxVal) : femRange[1]);

            return {
                targetType: 'global',
                targetLabel: 'Global FEM',
                targetIcon: '🏗️',
                nodeId: vpNode?.id,
                quantity: femQ,
                availableQuantities: this.getFEMQuantities(),
                colormap: femCmap,
                autoScale: femAuto,
                minVal: femMin,
                maxVal: femMax,
                logScale: femLog,
                isLocked: isGloballyLocked,
                contourLevels: params.femContourLevels ?? 10,
                smoothContours: params.femSmoothContours ?? false,
                showColorbar: (params.femShowColorbar !== undefined ? params.femShowColorbar : params.show_colorbar) !== false,
                showMeshLines: params.femWireframe !== false,
                visibility: this.isLayerActive('fem')
            };
        }

        const rawGlobQ = params.focusedQuantity || this.activeQuantity || 'pressure';
        const globQ = canonicalizeQuantity(rawGlobQ);
        const defaultGlobRange = params.quantity_ranges?.[globQ] || DEFAULT_QUANTITY_RANGES[globQ] || [0.0, 1.0];
        const globCmap = ((isGloballyLocked ? params.quantity_colormaps?.[globQ] : undefined) || params.colormap || this.activeColormap || 'rainbow') as ColormapType;
        const globAuto = isGloballyLocked ? (params.quantity_auto_scales?.[globQ] !== false) : this.autoScale;
        const globLog = (isGloballyLocked ? params.quantity_log_scales?.[globQ] : undefined) ?? this.logScale;
        const globMesh = this.activeLayers.grid !== false || params.show_grid !== false;
        const globBar = this.activeLayers.slices !== false;

        return {
            targetType: 'global',
            targetLabel: 'Global CFD',
            targetIcon: '🌐',
            nodeId: vpNode?.id,
            quantity: globQ,
            availableQuantities: this.getCFDQuantities(false),
            colormap: globCmap,
            autoScale: globAuto,
            minVal: isGloballyLocked ? defaultGlobRange[0] : (params.min_val !== undefined ? Number(params.min_val) : this.minScalarVal),
            maxVal: isGloballyLocked ? defaultGlobRange[1] : (params.max_val !== undefined ? Number(params.max_val) : this.maxScalarVal),
            logScale: globLog,
            isLocked: isGloballyLocked,
            contourLevels: params.sliceContourLevels ?? 10,
            smoothContours: params.sliceSmoothContours ?? false,
            showColorbar: globBar,
            showMeshLines: globMesh,
            visibility: this.activeLayers.slices !== false
        };
    }

    public getAvailableContextTargets(): Array<{ id: string; label: string; icon: string; targetType: ContextTargetType; sliceIndex?: number; nodeId?: string }> {
        const targets: Array<{ id: string; label: string; icon: string; targetType: ContextTargetType; sliceIndex?: number; nodeId?: string }> = [];
        
        const activeModel = this.stateManager.getActiveModel();
        const hasMPM = activeModel?.nodes.some(n => n.type === 'MPMDomain3D' || n.type === 'MPMObject3D');
        const hasFEM = activeModel?.nodes.some(n => n.type === 'FEMDomain3D' || n.type === 'FEMObject3D' || n.type === 'LSDynaImporter3D');
        const hasCFD = activeModel?.nodes.some(n => n.type === 'CFDSolver3D' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver');

        let globalLabel = 'Global CFD / Viewport';
        let globalIcon = '🌐';
        if (hasMPM && !hasCFD) {
            globalLabel = 'Global MPM / Viewport';
            globalIcon = '✨';
        } else if (hasFEM && !hasCFD) {
            globalLabel = 'Global FEM / Viewport';
            globalIcon = '🏗️';
        }

        // 1. Global Viewport
        targets.push({ id: 'global', label: globalLabel, icon: globalIcon, targetType: 'global' });

        // 2. Slices
        const domainNode = this.getActiveDomainNode();
        const vpNode = this.getActiveViewportNode();
        const slices = this.getSlices();
        slices.forEach((sl: any, idx: number) => {
            const axisLabel = getSliceAxisLabel(sl.axis);
            targets.push({
                id: `slice_${idx}`,
                label: `Slice #${idx + 1} (${axisLabel})`,
                icon: '🥞',
                targetType: 'slice',
                sliceIndex: idx,
                nodeId: domainNode?.id || vpNode?.id
            });
        });

        // 3. 3D Objects in Scene
        if (activeModel?.nodes) {
            activeModel.nodes.forEach((n: any) => {
                if (n.type === 'STLGeometry') {
                    targets.push({
                        id: `stl_${n.id}`,
                        label: n.parameters?.name || 'STL CAD Mesh',
                        icon: '📐',
                        targetType: 'stl',
                        nodeId: n.id
                    });
                } else if (n.type === 'PrimitiveGeometry3D' || n.type === 'Obstacle') {
                    targets.push({
                        id: `obs_${n.id}`,
                        label: n.parameters?.name || 'Obstacle Mesh',
                        icon: '🧱',
                        targetType: 'obstacles',
                        nodeId: n.id
                    });
                } else if (n.type === 'MPMObject3D' || n.type === 'MPMDomain3D') {
                    targets.push({
                        id: `mpm_${n.id}`,
                        label: n.parameters?.name || 'MPM Particles',
                        icon: '✨',
                        targetType: 'mpm',
                        nodeId: n.id
                    });
                } else if (n.type === 'MarineHarbourDomain') {
                    const waterMode = String(n.parameters?.water_discretization_mode || 'Spherical_MPM_Sleeve');
                    if (waterMode !== 'Pure_FV') {
                        targets.push({
                            id: `sleeve_${n.id}`,
                            label: n.parameters?.name ? `${n.parameters.name} - Water Sleeve` : 'Nearfield Water Sleeve',
                            icon: '🌊',
                            targetType: 'mpm',
                            nodeId: n.id
                        });
                    }
                    const bedType = String(n.parameters?.seabed_mesh_type || 'Hybrid_MPM_Crater_FEM_FarField');
                    if (bedType !== 'Pure_FV' && bedType !== 'Pure_Hex8_FEM') {
                        targets.push({
                            id: `soil_${n.id}`,
                            label: n.parameters?.name ? `${n.parameters.name} - Soil Scour` : 'Soil Scour Zone',
                            icon: '💥',
                            targetType: 'mpm',
                            nodeId: n.id
                        });
                    }
                } else if (n.type === 'FEMObject3D' || n.type === 'FEMDomain3D' || n.type === 'FEMBeam3D' || n.type === 'FEMRebar3D' || n.type === 'LSDynaImporter3D') {
                    targets.push({
                        id: `fem_${n.id}`,
                        label: n.parameters?.name || 'FEM Mesh',
                        icon: '🏗️',
                        targetType: 'fem',
                        nodeId: n.id
                    });
                } else if (n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D' || n.type === 'VirtualGauge') {
                    targets.push({
                        id: `gauges_${n.id}`,
                        label: n.parameters?.name || 'Virtual Gauges',
                        icon: '🎯',
                        targetType: 'gauges',
                        nodeId: n.id
                    });
                } else if (n.type === 'DetonatorLocation3D' || n.type === 'DetonatorLocation' || n.type === 'TriggerLocation3D' || n.type === 'TriggerLocation') {
                    targets.push({
                        id: `det_${n.id}`,
                        label: n.parameters?.name || 'Detonator',
                        icon: '🎯',
                        targetType: 'detonator',
                        nodeId: n.id
                    });
                } else if (n.type === 'Charge3D' || n.type === 'Charge2D') {
                    targets.push({
                        id: `charge_${n.id}`,
                        label: n.parameters?.name || 'Explosive Charge',
                        icon: '💣',
                        targetType: 'charge',
                        nodeId: n.id
                    });
                }
            });
        }

        return targets;
    }

    public updateContextSetting(key: string, value: any): void {
        this.handlePropertyChange(key, value);
    }

    public handlePropertyChange(key: string, value: any): void {
        const vpNode = this.getActiveViewportNode();
        const domainNode = this.getActiveDomainNode();
        const activeModel = this.stateManager.getActiveModel();
        const params = vpNode?.parameters || {};
        const ctx = this.getCurrentContextSettings();
        const selectedNode = ctx.nodeId ? activeModel?.nodes.find((n: any) => n.id === ctx.nodeId) : null;

        if (key === 'lockRanges' || key === 'isLocked') {
            if (vpNode) {
                const newLock = Boolean(value);
                if (newLock && ctx.quantity) {
                    const cQ = canonicalizeQuantity(ctx.quantity);
                    const qCmaps = { ...(params.quantity_colormaps || {}) };
                    const qLogs = { ...(params.quantity_log_scales || {}) };
                    const qAutos = { ...(params.quantity_auto_scales || {}) };
                    const qRanges = { ...(params.quantity_ranges || {}) };
                    
                    if (ctx.colormap) {
                        qCmaps[cQ] = ctx.colormap;
                        qCmaps[ctx.quantity] = ctx.colormap;
                    }
                    if (ctx.logScale !== undefined) {
                        qLogs[cQ] = ctx.logScale;
                        qLogs[ctx.quantity] = ctx.logScale;
                    }
                    if (ctx.autoScale !== undefined) {
                        qAutos[cQ] = ctx.autoScale;
                        qAutos[ctx.quantity] = ctx.autoScale;
                    }
                    if (ctx.minVal !== undefined && ctx.maxVal !== undefined) {
                        qRanges[cQ] = [Number(ctx.minVal), Number(ctx.maxVal)];
                        qRanges[ctx.quantity] = [Number(ctx.minVal), Number(ctx.maxVal)];
                    }

                    this.stateManager.updateNodeParametersInPlace(vpNode.id, {
                        lock_quantity_ranges: true,
                        quantity_colormaps: qCmaps,
                        quantity_log_scales: qLogs,
                        quantity_auto_scales: qAutos,
                        quantity_ranges: qRanges
                    });
                } else {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { lock_quantity_ranges: newLock });
                }
                this.onShadingChange?.('lockQuantityRanges', newLock);
            }
            this.renderActiveTabContent();
            return;
        }

        if (ctx.isLocked && (key === 'minVal' || key === 'maxVal' || key === 'autoScale')) {
            const q = ctx.quantity ? canonicalizeQuantity(ctx.quantity) : null;
            if (q && vpNode) {
                const qRanges = { ...(params.quantity_ranges || {}) };
                const current = qRanges[q] || DEFAULT_QUANTITY_RANGES[q] || [0.0, 1.0];
                const newMin = key === 'minVal' ? Number(value) : current[0];
                const newMax = key === 'maxVal' ? Number(value) : current[1];
                qRanges[q] = [newMin, newMax];
                qRanges[ctx.quantity] = [newMin, newMax];
                if (q === 'velocity') qRanges['speed'] = [newMin, newMax];

                const qAutoScales = { ...(params.quantity_auto_scales || {}) };
                const newAuto = key === 'autoScale' ? Boolean(value) : false;
                qAutoScales[q] = newAuto;
                qAutoScales[ctx.quantity] = newAuto;
                if (q === 'velocity') qAutoScales['speed'] = newAuto;

                const vpUpdates: any = { 
                    quantity_ranges: qRanges, 
                    quantity_auto_scales: qAutoScales,
                    min_val: newMin,
                    max_val: newMax,
                    auto_scale: newAuto,
                    autoScale: newAuto
                };
                if (canonicalizeQuantity(params.stl_quantity || 'pressure') === q) {
                    vpUpdates.stl_min_val = newMin;
                    vpUpdates.stl_max_val = newMax;
                    vpUpdates.stl_auto_scale = newAuto;
                }
                if (canonicalizeQuantity(params.obstacles_quantity || 'pressure') === q) {
                    vpUpdates.obstacles_min_val = newMin;
                    vpUpdates.obstacles_max_val = newMax;
                    vpUpdates.obstacles_auto_scale = newAuto;
                }
                if (canonicalizeQuantity(params.mpmParticleQuantity || 'vonMises') === q) {
                    vpUpdates.mpmParticleMinVal = newMin;
                    vpUpdates.mpmParticleMaxVal = newMax;
                    vpUpdates.mpmParticleAutoScale = newAuto;
                }
                if (canonicalizeQuantity(params.femQuantity || 'vonMises') === q) {
                    vpUpdates.femMinVal = newMin;
                    vpUpdates.femMaxVal = newMax;
                    vpUpdates.femAutoScale = newAuto;
                }
                if (canonicalizeQuantity(params.beamQuantity || 'plasticStrain') === q) {
                    vpUpdates.beamMinVal = newMin;
                    vpUpdates.beamMaxVal = newMax;
                    vpUpdates.beamAutoScale = newAuto;
                }
                const allSlices = vpNode.parameters?.slices ? [...vpNode.parameters.slices] : [];
                allSlices.forEach((s: any) => {
                    if (canonicalizeQuantity(s.quantities?.[0] || 'pressure') === q) {
                        s.min_val = newMin;
                        s.max_val = newMax;
                        s.auto_scale = newAuto;
                    }
                });
                vpUpdates.slices = allSlices;
                this.stateManager.updateNodeParametersInPlace(vpNode.id, vpUpdates);
                const stlNode = activeModel?.nodes?.find((n: any) => n.type === 'STLGeometry');
                if (stlNode) {
                    this.stateManager.updateNodeParametersInPlace(stlNode.id, {
                        stl_min_val: newMin,
                        stl_max_val: newMax,
                        stl_auto_scale: newAuto
                    });
                }
                this.onShadingChange?.(key, value);
                this.onShadingChange?.('quantityRanges', qRanges);
                this.onShadingChange?.('quantityAutoScales', qAutoScales);
                if (key === 'minVal' || key === 'maxVal') {
                    this.onColormapChange?.(ctx.colormap, newMin, newMax);
                }
                this.renderActiveTabContent();
                return;
            }
        }

        if (ctx.isLocked && key === 'colormap') {
            const q = ctx.quantity ? canonicalizeQuantity(ctx.quantity) : null;
            if (q && vpNode) {
                const qCmaps = { ...(params.quantity_colormaps || {}) };
                qCmaps[q] = value;
                qCmaps[ctx.quantity] = value;
                if (q === 'velocity') qCmaps['speed'] = value;
                const vpUpdates: any = { quantity_colormaps: qCmaps, colormap: value };
                if (canonicalizeQuantity(params.stl_quantity || 'pressure') === q) vpUpdates.stl_colormap = value;
                if (canonicalizeQuantity(params.obstacles_quantity || 'pressure') === q) vpUpdates.obstacles_colormap = value;
                if (canonicalizeQuantity(params.mpmParticleQuantity || 'vonMises') === q) vpUpdates.mpmParticleColormap = value;
                if (canonicalizeQuantity(params.femQuantity || 'vonMises') === q) vpUpdates.femColormap = value;
                if (canonicalizeQuantity(params.beamQuantity || 'plasticStrain') === q) vpUpdates.beamColormap = value;
                const allSlices = vpNode.parameters?.slices ? [...vpNode.parameters.slices] : [];
                allSlices.forEach((s: any) => {
                    if (canonicalizeQuantity(s.quantities?.[0] || 'pressure') === q) s.colormap = value;
                });
                vpUpdates.slices = allSlices;
                this.stateManager.updateNodeParametersInPlace(vpNode.id, vpUpdates);
                const stlNode = activeModel?.nodes?.find((n: any) => n.type === 'STLGeometry');
                if (stlNode) {
                    this.stateManager.updateNodeParametersInPlace(stlNode.id, { stl_colormap: value, colormap: value });
                }
                this.onColormapChange?.(value);
                this.onShadingChange?.('colormap', value);
                this.onShadingChange?.('quantityColormaps', qCmaps);
                this.renderActiveTabContent();
                return;
            }
        }

        if (ctx.isLocked && key === 'logScale') {
            const q = ctx.quantity ? canonicalizeQuantity(ctx.quantity) : null;
            if (q && vpNode) {
                const qLogScales = { ...(params.quantity_log_scales || {}) };
                const bVal = Boolean(value);
                qLogScales[q] = bVal;
                qLogScales[ctx.quantity] = bVal;
                if (q === 'velocity') qLogScales['speed'] = bVal;
                const vpUpdates: any = { quantity_log_scales: qLogScales, logScale: bVal };
                if (canonicalizeQuantity(params.stl_quantity || 'pressure') === q) vpUpdates.stl_log_scale = bVal;
                if (canonicalizeQuantity(params.obstacles_quantity || 'pressure') === q) vpUpdates.obstacles_log_scale = bVal;
                if (canonicalizeQuantity(params.mpmParticleQuantity || 'vonMises') === q) vpUpdates.mpmParticleLogScale = bVal;
                if (canonicalizeQuantity(params.femQuantity || 'vonMises') === q) vpUpdates.femLogScale = bVal;
                if (canonicalizeQuantity(params.beamQuantity || 'plasticStrain') === q) vpUpdates.beamLogScale = bVal;
                const allSlices = vpNode.parameters?.slices ? [...vpNode.parameters.slices] : [];
                allSlices.forEach((s: any) => {
                    if (canonicalizeQuantity(s.quantities?.[0] || 'pressure') === q) s.log_scale = bVal;
                });
                vpUpdates.slices = allSlices;
                this.stateManager.updateNodeParametersInPlace(vpNode.id, vpUpdates);
                const stlNode = activeModel?.nodes?.find((n: any) => n.type === 'STLGeometry');
                if (stlNode) {
                    this.stateManager.updateNodeParametersInPlace(stlNode.id, { stl_log_scale: bVal });
                }
                this.onShadingChange?.('logScale', bVal);
                this.onShadingChange?.('quantityLogScales', qLogScales);
                this.renderActiveTabContent();
                return;
            }
        }

        if (ctx.targetType === 'slice' && ctx.sliceIndex !== undefined) {
            const targetNode = domainNode || vpNode;
            const currentSlices = [...this.getSlices()];
            const idx = ctx.sliceIndex;

            if (currentSlices[idx]) {
                const sl = { ...currentSlices[idx] };
                if (key === 'quantity') {
                    let q = value;
                    if (q === 'species_1' || q === 'species' || q === 'products' || q === 'detonation_products' || q === 'detonation' || q === 'reacted' || q === 'reacted_gas' || q === 'alpha1' || q === 'alpha_1') q = 'species1';
                    else if (q === 'species_2' || q === 'unreacted' || q === 'unreacted_solid' || q === 'solid_he' || q === 'alpha2' || q === 'alpha_2') q = 'species2';
                    else if (q === 'species_3' || q === 'air' || q === 'ambient_air' || q === 'alpha3' || q === 'alpha_3') q = 'species3';
                    sl.quantities = [q];
                    sl.quantity = q;
                    this.activeQuantity = q;
                } else if (key === 'colormap') {
                    sl.colormap = value;
                } else if (key === 'autoScale') {
                    sl.auto_scale = value;
                } else if (key === 'minVal') {
                    sl.min_val = value;
                    sl.auto_scale = false;
                } else if (key === 'maxVal') {
                    sl.max_val = value;
                    sl.auto_scale = false;
                } else if (key === 'logScale') {
                    sl.log_scale = value;
                } else if (key === 'showColorbar') {
                    sl.show_colorbar = value;
                } else if (key === 'showMeshLines') {
                    sl.interpolate = !value;
                    sl.gridlines = value;
                    sl.show_mesh = value;
                } else if (key === 'interpolate') {
                    sl.interpolate = value;
                } else if (key === 'visibility') {
                    sl.enabled = value;
                } else if (key === 'sliceAxis') {
                    sl.axis = value;
                    const bounds = this.getSliceBounds(value);
                    if (sl.offset < bounds.min || sl.offset > bounds.max) {
                        sl.offset = (bounds.min + bounds.max) * 0.5;
                    }
                } else if (key === 'sliceOffset') {
                    sl.offset = Number(value);
                } else if (key === 'sliceOpacity') {
                    sl.opacity = Number(value);
                } else if (key === 'sliceStride') {
                    sl.stride = Number(value);
                } else if (key === 'contourLevels') {
                    sl.contour_levels = Number(value);
                    if (Number(value) <= 1) sl.smooth_contours = true;
                } else if (key === 'smoothContours') {
                    sl.smooth_contours = Boolean(value);
                }
                currentSlices[idx] = sl;
                if (targetNode) {
                    this.stateManager.updateNodeParametersInPlace(targetNode.id, { slices: currentSlices });
                }
                if (vpNode && vpNode.id !== targetNode?.id) {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { slices: currentSlices });
                }
                if (domainNode && domainNode.id !== targetNode?.id) {
                    this.stateManager.updateNodeParametersInPlace(domainNode.id, { slices: currentSlices });
                }
                this.onSliceConfigChange?.(currentSlices);
            }
        } else if (ctx.targetType === 'fem') {
            const nodeUpdates: any = {};
            const vpUpdates: any = {};
            const isBeamOrRebar = selectedNode?.type === 'FEMBeam3D' || selectedNode?.type === 'FEMRebar3D';
            const femQ = (value === 'plastic_strain') ? 'plasticStrain' : (value === 'von_mises' ? 'vonMises' : value);

            if (isBeamOrRebar) {
                if (key === 'quantity') {
                    nodeUpdates.beamQuantity = value;
                    vpUpdates.beamQuantity = value;
                    this.onShadingChange?.('beamQuantity', value);
                    this.onQuantityChange?.(value, 'beams');
                } else if (key === 'colormap') {
                    nodeUpdates.beamColormap = value;
                    vpUpdates.beamColormap = value;
                    this.onShadingChange?.('beamColormap', value);
                    this.onColormapChange?.(value, undefined, undefined, 'beams');
                } else if (key === 'autoScale') {
                    nodeUpdates.beamAutoScale = value;
                    vpUpdates.beamAutoScale = value;
                    this.onShadingChange?.('beamAutoScale', value);
                } else if (key === 'minVal') {
                    nodeUpdates.beamMinVal = value;
                    nodeUpdates.beamAutoScale = false;
                    vpUpdates.beamMinVal = value;
                    vpUpdates.beamAutoScale = false;
                    this.onShadingChange?.('beamMinVal', value);
                    this.onShadingChange?.('beamAutoScale', false);
                    this.onColormapChange?.(params.beamColormap || 'rainbow', value, params.beamMaxVal, 'beams');
                } else if (key === 'maxVal') {
                    nodeUpdates.beamMaxVal = value;
                    nodeUpdates.beamAutoScale = false;
                    vpUpdates.beamMaxVal = value;
                    vpUpdates.beamAutoScale = false;
                    this.onShadingChange?.('beamMaxVal', value);
                    this.onShadingChange?.('beamAutoScale', false);
                    this.onColormapChange?.(params.beamColormap || 'rainbow', params.beamMinVal, value, 'beams');
                } else if (key === 'logScale') {
                    nodeUpdates.beamLogScale = value;
                    vpUpdates.beamLogScale = value;
                    this.onShadingChange?.('beamLogScale', value);
                } else if (key === 'showColorbar') {
                    nodeUpdates.beamShowColorbar = value;
                    nodeUpdates.showColorbar = value;
                    vpUpdates.beamShowColorbar = value;
                    this.onShadingChange?.('beamShowColorbar', value);
                } else if (key === 'showMeshLines') {
                    nodeUpdates.beamWireframe = value;
                    nodeUpdates.rebarWireframe = value;
                    vpUpdates.beamWireframe = value;
                    vpUpdates.rebarWireframe = value;
                    this.onShadingChange?.('beamWireframe', value);
                    this.onShadingChange?.('rebarWireframe', value);
                } else if (key === 'contourLevels') {
                    const cl = Number(value);
                    nodeUpdates.beamContourLevels = cl;
                    vpUpdates.beamContourLevels = cl;
                    this.onShadingChange?.('beamContourLevels', cl);
                    if (cl <= 1) {
                        nodeUpdates.beamSmoothContours = true;
                        vpUpdates.beamSmoothContours = true;
                        this.onShadingChange?.('beamSmoothContours', true);
                    }
                } else if (key === 'smoothContours') {
                    const sm = Boolean(value);
                    nodeUpdates.beamSmoothContours = sm;
                    vpUpdates.beamSmoothContours = sm;
                    this.onShadingChange?.('beamSmoothContours', sm);
                } else if (key === 'visibility') {
                    nodeUpdates.showBeams = value;
                    nodeUpdates.showRebar = value;
                    nodeUpdates.visible = value;
                    nodeUpdates.hidden = !value;
                    vpUpdates.showBeams = value;
                    vpUpdates.showRebar = value;
                    if (activeModel) {
                        activeModel.nodes
                            .filter((n: any) => n.type === 'FEMBeam3D' || n.type === 'FEMRebar3D' || n.type === 'StructuralObject3D')
                            .forEach((n: any) => {
                                this.stateManager.updateNodeParametersInPlace(n.id, { visible: value, hidden: !value, showBeams: value, showRebar: value });
                            });
                    }
                    this.onLayerToggle?.('beams', value);
                } else if (key === 'femOpacity') {
                    nodeUpdates.beamOpacity = Number(value);
                    vpUpdates.beamOpacity = Number(value);
                }
            } else {
                if (key === 'quantity') {
                    nodeUpdates.femQuantity = femQ;
                    vpUpdates.femQuantity = femQ;
                    this.onShadingChange?.('femQuantity', femQ);
                    this.onQuantityChange?.(femQ, 'fem');
                } else if (key === 'colormap') {
                    nodeUpdates.femColormap = value;
                    vpUpdates.femColormap = value;
                    this.onShadingChange?.('femColormap', value);
                    this.onColormapChange?.(value, undefined, undefined, 'fem');
                } else if (key === 'autoScale') {
                    nodeUpdates.femAutoScale = value;
                    vpUpdates.femAutoScale = value;
                    this.onShadingChange?.('femAutoScale', value);
                } else if (key === 'minVal') {
                    nodeUpdates.femMinVal = value;
                    nodeUpdates.femAutoScale = false;
                    vpUpdates.femMinVal = value;
                    vpUpdates.femAutoScale = false;
                    this.onShadingChange?.('femMinVal', value);
                    this.onShadingChange?.('femAutoScale', false);
                    this.onColormapChange?.(params.femColormap || 'rainbow', value, params.femMaxVal, 'fem');
                } else if (key === 'maxVal') {
                    nodeUpdates.femMaxVal = value;
                    nodeUpdates.femAutoScale = false;
                    vpUpdates.femMaxVal = value;
                    vpUpdates.femAutoScale = false;
                    this.onShadingChange?.('femMaxVal', value);
                    this.onShadingChange?.('femAutoScale', false);
                    this.onColormapChange?.(params.femColormap || 'rainbow', params.femMinVal, value, 'fem');
                } else if (key === 'logScale') {
                    nodeUpdates.femLogScale = value;
                    vpUpdates.femLogScale = value;
                    this.onShadingChange?.('femLogScale', value);
                } else if (key === 'showColorbar') {
                    nodeUpdates.femShowColorbar = value;
                    nodeUpdates.showColorbar = value;
                    vpUpdates.femShowColorbar = value;
                    this.onShadingChange?.('femShowColorbar', value);
                } else if (key === 'showMeshLines') {
                    nodeUpdates.femWireframe = value;
                    nodeUpdates.wireframe = value;
                    vpUpdates.femWireframe = value;
                    this.onShadingChange?.('femWireframe', value);
                } else if (key === 'contourLevels') {
                    const cl = Number(value);
                    nodeUpdates.femContourLevels = cl;
                    vpUpdates.femContourLevels = cl;
                    this.onShadingChange?.('femContourLevels', cl);
                    if (cl <= 1) {
                        nodeUpdates.femSmoothContours = true;
                        vpUpdates.femSmoothContours = true;
                        this.onShadingChange?.('femSmoothContours', true);
                    }
                } else if (key === 'smoothContours') {
                    const sm = Boolean(value);
                    nodeUpdates.femSmoothContours = sm;
                    vpUpdates.femSmoothContours = sm;
                    this.onShadingChange?.('femSmoothContours', sm);
                } else if (key === 'visibility') {
                    nodeUpdates.showFEMMesh = value;
                    nodeUpdates.visible = value;
                    nodeUpdates.hidden = !value;
                    vpUpdates.showFEMMesh = value;
                    if (activeModel) {
                        activeModel.nodes
                            .filter((n: any) => n.type === 'FEMObject3D' || n.type === 'FEMDomain3D' || n.type === 'LSDynaImporter3D')
                            .forEach((n: any) => {
                                this.stateManager.updateNodeParametersInPlace(n.id, { visible: value, hidden: !value, showFEMMesh: value });
                            });
                    }
                    this.onLayerToggle?.('fem', value);
                } else if (key === 'lighting') {
                    nodeUpdates.femLighting = value;
                    vpUpdates.femLighting = value;
                } else if (key === 'femOpacity') {
                    nodeUpdates.femOpacity = Number(value);
                    vpUpdates.femOpacity = Number(value);
                }
            }

            if (selectedNode && selectedNode.id !== vpNode?.id) {
                this.stateManager.updateNodeParametersInPlace(selectedNode.id, nodeUpdates);
            }
            if (vpNode) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, vpUpdates);
            }
        } else if (ctx.targetType === 'mpm') {
            const nodeUpdates: any = {};
            const vpUpdates: any = {};
            const mpmQ = (value === 'plasticStrain') ? 'plastic_strain' : (value === 'von_mises' ? 'vonMises' : value);
            if (key === 'quantity') {
                nodeUpdates.mpmParticleQuantity = mpmQ;
                vpUpdates.mpmParticleQuantity = mpmQ;
                this.onShadingChange?.('mpmParticleQuantity', mpmQ);
                this.onQuantityChange?.(mpmQ, 'mpm');
            } else if (key === 'colormap') {
                nodeUpdates.mpmParticleColormap = value;
                vpUpdates.mpmParticleColormap = value;
                this.onShadingChange?.('mpmParticleColormap', value);
                this.onColormapChange?.(value, undefined, undefined, 'mpm');
            } else if (key === 'autoScale') {
                nodeUpdates.mpmParticleAutoScale = value;
                vpUpdates.mpmParticleAutoScale = value;
                this.onShadingChange?.('mpmParticleAutoScale', value);
            } else if (key === 'minVal') {
                nodeUpdates.mpmParticleMinVal = value;
                nodeUpdates.mpmParticleAutoScale = false;
                vpUpdates.mpmParticleMinVal = value;
                vpUpdates.mpmParticleAutoScale = false;
                this.onShadingChange?.('mpmParticleMinVal', value);
                this.onShadingChange?.('mpmParticleAutoScale', false);
                this.onColormapChange?.(params.mpmParticleColormap || 'rainbow', value, params.mpmParticleMaxVal, 'mpm');
            } else if (key === 'maxVal') {
                nodeUpdates.mpmParticleMaxVal = value;
                nodeUpdates.mpmParticleAutoScale = false;
                vpUpdates.mpmParticleMaxVal = value;
                vpUpdates.mpmParticleAutoScale = false;
                this.onShadingChange?.('mpmParticleMaxVal', value);
                this.onShadingChange?.('mpmParticleAutoScale', false);
                this.onColormapChange?.(params.mpmParticleColormap || 'rainbow', params.mpmParticleMinVal, value, 'mpm');
            } else if (key === 'logScale') {
                nodeUpdates.mpmParticleLogScale = value;
                vpUpdates.mpmParticleLogScale = value;
                this.onShadingChange?.('mpmParticleLogScale', value);
            } else if (key === 'showColorbar') {
                nodeUpdates.mpmParticleShowColorbar = value;
                nodeUpdates.showColorbar = value;
                vpUpdates.mpmParticleShowColorbar = value;
                this.onShadingChange?.('mpmParticleShowColorbar', value);
            } else if (key === 'showMeshLines') {
                nodeUpdates.mpmParticleWireframe = value;
                nodeUpdates.wireframe = value;
                vpUpdates.mpmParticleWireframe = value;
                this.onShadingChange?.('mpmParticleWireframe', value);
            } else if (key === 'contourLevels') {
                const cl = Number(value);
                nodeUpdates.mpmContourLevels = cl;
                vpUpdates.mpmContourLevels = cl;
                this.onShadingChange?.('mpmContourLevels', cl);
                if (cl <= 1) {
                    nodeUpdates.mpmSmoothContours = true;
                    vpUpdates.mpmSmoothContours = true;
                    this.onShadingChange?.('mpmSmoothContours', true);
                }
            } else if (key === 'smoothContours') {
                const sm = Boolean(value);
                nodeUpdates.mpmSmoothContours = sm;
                vpUpdates.mpmSmoothContours = sm;
                this.onShadingChange?.('mpmSmoothContours', sm);
            } else if (key === 'visibility') {
                if (selectedNode?.type === 'MarineHarbourDomain') {
                    if (this.selectedObject?.childId === 'water_sleeve') {
                        nodeUpdates.show_water_sleeve = value;
                        this.onShadingChange?.('show_water_sleeve', value);
                    } else if (this.selectedObject?.childId === 'seabed_soil') {
                        nodeUpdates.show_soil_mpm = value;
                        this.onShadingChange?.('show_soil_mpm', value);
                    } else {
                        nodeUpdates.show_water_sleeve = value;
                        nodeUpdates.show_soil_mpm = value;
                        this.onShadingChange?.('show_water_sleeve', value);
                        this.onShadingChange?.('show_soil_mpm', value);
                    }
                } else {
                    nodeUpdates.showMPMParticles = value;
                    nodeUpdates.visible = value;
                    nodeUpdates.hidden = !value;
                    vpUpdates.showMPMParticles = value;
                    if (activeModel) {
                        activeModel.nodes
                            .filter((n: any) => n.type === 'MPMObject3D' || n.type === 'MPMDomain3D' || n.type === 'MPMObject2D')
                            .forEach((n: any) => {
                                this.stateManager.updateNodeParametersInPlace(n.id, { visible: value, hidden: !value, showMPMParticles: value });
                            });
                    }
                    this.onLayerToggle?.('mpm', value);
                }
            }
            if (selectedNode && selectedNode.id !== vpNode?.id) {
                this.stateManager.updateNodeParametersInPlace(selectedNode.id, nodeUpdates);
            }
            if (vpNode) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, vpUpdates);
            }
        } else if (ctx.targetType === 'stl') {
            const nodeUpdates: any = {};
            const vpUpdates: any = {};
            if (key === 'quantity') {
                const q = canonicalizeQuantity(value);
                const defRange = params.quantity_ranges?.[q] || DEFAULT_QUANTITY_RANGES[q] || [0.0, 1.0];
                nodeUpdates.stl_quantity = q;
                nodeUpdates.stl_min_val = defRange[0];
                nodeUpdates.stl_max_val = defRange[1];
                vpUpdates.stl_quantity = q;
                vpUpdates.stl_min_val = defRange[0];
                vpUpdates.stl_max_val = defRange[1];
                this.onQuantityChange?.(q, 'stl');
                this.onShadingChange?.('stl_quantity', q);
            } else if (key === 'colormap') {
                nodeUpdates.stl_colormap = value;
                vpUpdates.stl_colormap = value;
                this.onColormapChange?.(value, params.stl_min_val, params.stl_max_val, 'stl');
                this.onShadingChange?.('stl_colormap', value);
            } else if (key === 'autoScale') {
                nodeUpdates.stl_auto_scale = value;
                vpUpdates.stl_auto_scale = value;
                this.onShadingChange?.('stl_auto_scale', value);
            } else if (key === 'minVal') {
                nodeUpdates.stl_min_val = value;
                nodeUpdates.stl_auto_scale = false;
                vpUpdates.stl_min_val = value;
                vpUpdates.stl_auto_scale = false;
                this.onShadingChange?.('stl_min_val', value);
                this.onShadingChange?.('stl_auto_scale', false);
                this.onColormapChange?.(params.stl_colormap || 'rainbow', value, params.stl_max_val, 'stl');
            } else if (key === 'maxVal') {
                nodeUpdates.stl_max_val = value;
                nodeUpdates.stl_auto_scale = false;
                vpUpdates.stl_max_val = value;
                vpUpdates.stl_auto_scale = false;
                this.onShadingChange?.('stl_max_val', value);
                this.onShadingChange?.('stl_auto_scale', false);
                this.onColormapChange?.(params.stl_colormap || 'rainbow', params.stl_min_val, value, 'stl');
            } else if (key === 'logScale') {
                nodeUpdates.stl_log_scale = value;
                vpUpdates.stl_log_scale = value;
                this.onShadingChange?.('stl_log_scale', value);
            } else if (key === 'showColorbar') {
                nodeUpdates.stl_show_colorbar = value;
                nodeUpdates.showColorbar = value;
                vpUpdates.stl_show_colorbar = value;
                this.onShadingChange?.('stl_show_colorbar', value);
            } else if (key === 'showMeshLines') {
                nodeUpdates.stl_wireframe = value;
                nodeUpdates.wireframe = value;
                vpUpdates.stl_wireframe = value;
                this.onShadingChange?.('stl_wireframe', value);
            } else if (key === 'visibility') {
                nodeUpdates.show_stl = value;
                nodeUpdates.visible = value;
                nodeUpdates.hidden = !value;
                vpUpdates.show_stl = value;
                if (activeModel) {
                    activeModel.nodes
                        .filter((n: any) => n.type === 'STLGeometry3D' || n.type === 'CADImporter3D')
                        .forEach((n: any) => {
                            this.stateManager.updateNodeParametersInPlace(n.id, { visible: value, hidden: !value, show_stl: value });
                        });
                }
                this.onLayerToggle?.('stl', value);
            } else if (key === 'lighting') {
                nodeUpdates.stl_lighting = value;
                vpUpdates.stl_lighting = value;
                this.onShadingChange?.('stl_lighting', value);
            } else if (key === 'stlOpacity') {
                nodeUpdates.stl_opacity = Number(value);
                vpUpdates.stl_opacity = Number(value);
                this.onShadingChange?.('stl_opacity', Number(value));
            }
            if (selectedNode && selectedNode.id !== vpNode?.id) {
                this.stateManager.updateNodeParametersInPlace(selectedNode.id, nodeUpdates);
            }
            if (vpNode) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, vpUpdates);
            }
        } else if (ctx.targetType === 'obstacles') {
            const nodeUpdates: any = {};
            const vpUpdates: any = {};
            if (key === 'quantity') {
                const q = canonicalizeQuantity(value);
                const defRange = params.quantity_ranges?.[q] || DEFAULT_QUANTITY_RANGES[q] || [0.0, 1.0];
                nodeUpdates.obstacles_quantity = q;
                nodeUpdates.obstacles_min_val = defRange[0];
                nodeUpdates.obstacles_max_val = defRange[1];
                vpUpdates.obstacles_quantity = q;
                vpUpdates.obstacles_min_val = defRange[0];
                vpUpdates.obstacles_max_val = defRange[1];
                this.onQuantityChange?.(q, 'obstacles');
                this.onShadingChange?.('obstacles_quantity', q);
            } else if (key === 'colormap') {
                nodeUpdates.obstacles_colormap = value;
                vpUpdates.obstacles_colormap = value;
                this.onColormapChange?.(value, params.obstacles_min_val, params.obstacles_max_val, 'obstacles');
                this.onShadingChange?.('obstacles_colormap', value);
            } else if (key === 'autoScale') {
                nodeUpdates.obstacles_auto_scale = value;
                vpUpdates.obstacles_auto_scale = value;
                this.onShadingChange?.('obstacles_auto_scale', value);
            } else if (key === 'minVal') {
                nodeUpdates.obstacles_min_val = value;
                nodeUpdates.obstacles_auto_scale = false;
                vpUpdates.obstacles_min_val = value;
                vpUpdates.obstacles_auto_scale = false;
                this.onShadingChange?.('obstacles_min_val', value);
                this.onShadingChange?.('obstacles_auto_scale', false);
                this.onColormapChange?.(params.obstacles_colormap || 'rainbow', value, params.obstacles_max_val, 'obstacles');
            } else if (key === 'maxVal') {
                nodeUpdates.obstacles_max_val = value;
                nodeUpdates.obstacles_auto_scale = false;
                vpUpdates.obstacles_max_val = value;
                vpUpdates.obstacles_auto_scale = false;
                this.onShadingChange?.('obstacles_max_val', value);
                this.onShadingChange?.('obstacles_auto_scale', false);
                this.onColormapChange?.(params.obstacles_colormap || 'rainbow', params.obstacles_min_val, value, 'obstacles');
            } else if (key === 'logScale') {
                nodeUpdates.obstacles_log_scale = value;
                vpUpdates.obstacles_log_scale = value;
                this.onShadingChange?.('obstacles_log_scale', value);
            } else if (key === 'showColorbar') {
                nodeUpdates.obstacles_show_colorbar = value;
                nodeUpdates.showColorbar = value;
                vpUpdates.obstacles_show_colorbar = value;
                this.onShadingChange?.('obstacles_show_colorbar', value);
            } else if (key === 'showMeshLines') {
                nodeUpdates.obstacles_gridlines = value;
                nodeUpdates.wireframe = value;
                vpUpdates.obstacles_gridlines = value;
                this.onShadingChange?.('obstacles_gridlines', value);
            } else if (key === 'visibility') {
                nodeUpdates.show_obstacles = value;
                nodeUpdates.visible = value;
                nodeUpdates.hidden = !value;
                vpUpdates.show_obstacles = value;
                if (activeModel) {
                    activeModel.nodes
                        .filter((n: any) => n.type === 'ObstacleDomain3D' || n.type === 'CSGObstacle3D' || n.type === 'ObstacleBox3D' || n.type === 'ObstacleCylinder3D' || n.type === 'ObstacleSphere3D')
                        .forEach((n: any) => {
                            this.stateManager.updateNodeParametersInPlace(n.id, { visible: value, hidden: !value, show_obstacles: value });
                        });
                }
                this.onLayerToggle?.('obstacles', value);
            } else if (key === 'lighting') {
                nodeUpdates.obstacles_lighting = value;
                vpUpdates.obstacles_lighting = value;
                this.onShadingChange?.('obstacles_lighting', value);
            } else if (key === 'obstaclesOpacity') {
                nodeUpdates.obstacles_opacity = Number(value);
                vpUpdates.obstacles_opacity = Number(value);
                this.onShadingChange?.('obstacles_opacity', Number(value));
            }
            if (selectedNode && selectedNode.id !== vpNode?.id) {
                this.stateManager.updateNodeParametersInPlace(selectedNode.id, nodeUpdates);
            }
            if (vpNode) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, vpUpdates);
            }
        } else if (ctx.targetType === 'detonator') {
            const vpUpdates: any = {};
            if (key === 'visibility') {
                vpUpdates.show_detonators = value;
                vpUpdates.show_detonator = value;
                if (activeModel) {
                    activeModel.nodes
                        .filter((n: any) => n.type === 'DetonatorPoint3D' || n.type === 'DetonatorLine3D' || n.type === 'DetonatorPlane3D' || n.type === 'Detonator')
                        .forEach((n: any) => {
                            this.stateManager.updateNodeParametersInPlace(n.id, { visible: value, hidden: !value, show_detonator: value });
                        });
                }
                this.onLayerToggle?.('detonators', value);
            } else if (key === 'showMeshLines') {
                vpUpdates.detonator_wireframe = value;
                vpUpdates.detonators_wireframe = value;
            }
            if (vpNode) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, vpUpdates);
            }
            this.onShadingChange?.(key, value);
        } else {
            // Global Modality-Aware Viewport
            const activeModel = this.stateManager.getActiveModel();
            const hasMPM = activeModel?.nodes.some(n => n.type === 'MPMDomain3D' || n.type === 'MPMObject3D');
            const hasFEM = activeModel?.nodes.some(n => n.type === 'FEMDomain3D' || n.type === 'FEMObject3D' || n.type === 'LSDynaImporter3D');
            const hasCFD = activeModel?.nodes.some(n => n.type === 'CFDSolver3D' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver');

            if (key === 'quantity') {
                let q = value;
                if (q === 'species_1' || q === 'species') q = 'species1';
                else if (q === 'species_2') q = 'species2';
                else if (q === 'species_3') q = 'species3';
                else if (q === 'von_mises') q = 'vonMises';
                else if (q === 'plastic_strain') q = 'plasticStrain';
                this.activeQuantity = q;
                const mpmQ = q === 'plasticStrain' ? 'plastic_strain' : q;
                const femQ = q === 'plastic_strain' ? 'plasticStrain' : q;
                if (vpNode) {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, {
                        focusedQuantity: q,
                        mpmParticleQuantity: mpmQ,
                        femQuantity: femQ,
                        stl_quantity: q
                    });
                }
                const targetMod = (hasFEM && !hasCFD) ? 'fem' : (hasMPM && !hasCFD) ? 'mpm' : undefined;
                this.onQuantityChange?.(q, targetMod);
                this.onShadingChange?.('mpmParticleQuantity', mpmQ);
                this.onShadingChange?.('femQuantity', femQ);
            } else if (key === 'colormap') {
                this.activeColormap = value;
                if (hasFEM && !hasCFD) {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { femColormap: value });
                    this.onShadingChange?.('femColormap', value);
                    this.onColormapChange?.(value, this.minScalarVal, this.maxScalarVal, 'fem');
                } else if (hasMPM && !hasCFD) {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmParticleColormap: value });
                    this.onShadingChange?.('mpmParticleColormap', value);
                    this.onColormapChange?.(value, this.minScalarVal, this.maxScalarVal, 'mpm');
                } else {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { colormap: value, stl_colormap: value });
                    this.onShadingChange?.('colormap', value);
                    this.onColormapChange?.(value, this.minScalarVal, this.maxScalarVal, 'cfd');
                }
            } else if (key === 'autoScale') {
                this.autoScale = value;
                if (hasFEM && !hasCFD) {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { femAutoScale: value });
                    this.onShadingChange?.('femAutoScale', value);
                } else if (hasMPM && !hasCFD) {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmParticleAutoScale: value });
                    this.onShadingChange?.('mpmParticleAutoScale', value);
                } else {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { autoScale: value });
                    this.onShadingChange?.('autoScale', value);
                }
            } else if (key === 'minVal') {
                this.minScalarVal = value;
                this.autoScale = false;
                if (hasFEM && !hasCFD) {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { femMinVal: value, femAutoScale: false });
                    this.onShadingChange?.('femMinVal', value);
                    this.onShadingChange?.('femAutoScale', false);
                    this.onColormapChange?.(this.activeColormap, value, this.maxScalarVal, 'fem');
                } else if (hasMPM && !hasCFD) {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmParticleMinVal: value, mpmParticleAutoScale: false });
                    this.onShadingChange?.('mpmParticleMinVal', value);
                    this.onShadingChange?.('mpmParticleAutoScale', false);
                    this.onColormapChange?.(this.activeColormap, value, this.maxScalarVal, 'mpm');
                } else {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { min_val: value, autoScale: false });
                    this.onShadingChange?.('minVal', value);
                    this.onShadingChange?.('autoScale', false);
                    this.onColormapChange?.(this.activeColormap, value, this.maxScalarVal, 'cfd');
                }
            } else if (key === 'maxVal') {
                this.maxScalarVal = value;
                this.autoScale = false;
                if (hasFEM && !hasCFD) {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { femMaxVal: value, femAutoScale: false });
                    this.onShadingChange?.('femMaxVal', value);
                    this.onShadingChange?.('femAutoScale', false);
                    this.onColormapChange?.(this.activeColormap, this.minScalarVal, value, 'fem');
                } else if (hasMPM && !hasCFD) {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmParticleMaxVal: value, mpmParticleAutoScale: false });
                    this.onShadingChange?.('mpmParticleMaxVal', value);
                    this.onShadingChange?.('mpmParticleAutoScale', false);
                    this.onColormapChange?.(this.activeColormap, this.minScalarVal, value, 'mpm');
                } else {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { max_val: value, autoScale: false });
                    this.onShadingChange?.('maxVal', value);
                    this.onShadingChange?.('autoScale', false);
                    this.onColormapChange?.(this.activeColormap, this.minScalarVal, value, 'cfd');
                }
            } else if (key === 'logScale') {
                this.logScale = value;
                if (hasFEM && !hasCFD) {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { femLogScale: value });
                    this.onShadingChange?.('femLogScale', value);
                } else if (hasMPM && !hasCFD) {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmParticleLogScale: value });
                    this.onShadingChange?.('mpmParticleLogScale', value);
                } else {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { logScale: value });
                    this.onShadingChange?.('logScale', value);
                }
            } else if (key === 'showColorbar') {
                if (vpNode) {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, {
                        show_colorbar: value,
                        mpmParticleShowColorbar: value,
                        femShowColorbar: value,
                        beamShowColorbar: value
                    });
                }
                if (activeModel) {
                    activeModel.nodes.forEach(n => {
                        if (n.type === 'FEMObject3D' || n.type === 'FEMDomain3D' || n.type === 'MPMObject3D' || n.type === 'MPMDomain3D') {
                            this.stateManager.updateNodeParametersInPlace(n.id, { showColorbar: value });
                        }
                    });
                }
                this.onShadingChange?.('show_colorbar', value);
                this.onShadingChange?.('mpmParticleShowColorbar', value);
                this.onShadingChange?.('femShowColorbar', value);
                this.onShadingChange?.('beamShowColorbar', value);
            } else if (key === 'showMeshLines') {
                this.activeLayers.grid = value;
                this.activeLayers.gridBox = value;
                if (vpNode) {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, {
                        show_grid: value,
                        show_grid_box: value,
                        cell_edges: value,
                        femWireframe: value,
                        beamWireframe: value,
                        mpmParticleWireframe: value,
                        stl_wireframe: value,
                        obstacles_gridlines: value,
                        rebarWireframe: value
                    });
                }
                if (activeModel) {
                    activeModel.nodes.forEach(n => {
                        if (n.type === 'FEMObject3D' || n.type === 'FEMDomain3D' || n.type === 'MPMObject3D' || n.type === 'MPMDomain3D') {
                            this.stateManager.updateNodeParametersInPlace(n.id, { wireframe: value });
                        }
                    });
                }
                this.onLayerToggle?.('grid', value);
                this.onLayerToggle?.('gridBox', value);
                this.onShadingChange?.('femWireframe', value);
                this.onShadingChange?.('beamWireframe', value);
                this.onShadingChange?.('rebarWireframe', value);
                this.onShadingChange?.('showMeshLines', value);
            } else if (key === 'contourLevels') {
                const cl = Number(value);
                if (hasFEM && !hasCFD) {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { femContourLevels: cl, femSmoothContours: cl <= 1 });
                    this.onShadingChange?.('femContourLevels', cl);
                    if (cl <= 1) this.onShadingChange?.('femSmoothContours', true);
                } else if (hasMPM && !hasCFD) {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmContourLevels: cl, mpmSmoothContours: cl <= 1 });
                    this.onShadingChange?.('mpmContourLevels', cl);
                    if (cl <= 1) this.onShadingChange?.('mpmSmoothContours', true);
                } else {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { sliceContourLevels: cl, sliceSmoothContours: cl <= 1 });
                    this.onShadingChange?.('sliceContourLevels', cl);
                    if (cl <= 1) this.onShadingChange?.('sliceSmoothContours', true);
                    const currentSlices = [...this.getSlices()];
                    if (currentSlices.length > 0) {
                        currentSlices.forEach(s => { s.contour_levels = cl; if (cl <= 1) s.smooth_contours = true; });
                        const targetNode = domainNode || vpNode;
                        if (targetNode) this.stateManager.updateNodeParametersInPlace(targetNode.id, { slices: currentSlices });
                        this.onSliceConfigChange?.(currentSlices);
                    }
                }
            } else if (key === 'smoothContours') {
                const sm = Boolean(value);
                if (hasFEM && !hasCFD) {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { femSmoothContours: sm });
                    this.onShadingChange?.('femSmoothContours', sm);
                } else if (hasMPM && !hasCFD) {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmSmoothContours: sm });
                    this.onShadingChange?.('mpmSmoothContours', sm);
                } else {
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { sliceSmoothContours: sm });
                    this.onShadingChange?.('sliceSmoothContours', sm);
                    const currentSlices = [...this.getSlices()];
                    if (currentSlices.length > 0) {
                        currentSlices.forEach(s => { s.smooth_contours = sm; });
                        const targetNode = domainNode || vpNode;
                        if (targetNode) this.stateManager.updateNodeParametersInPlace(targetNode.id, { slices: currentSlices });
                        this.onSliceConfigChange?.(currentSlices);
                    }
                }
            } else if (key === 'visibility') {
                if (hasMPM && !hasCFD) {
                    this.activeLayers.mpm = value;
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { showMPMParticles: value });
                    if (activeModel) {
                        activeModel.nodes
                            .filter((n: any) => n.type === 'MPMObject3D' || n.type === 'MPMDomain3D')
                            .forEach((n: any) => {
                                this.stateManager.updateNodeParametersInPlace(n.id, { visible: value, hidden: !value, showMPMParticles: value });
                            });
                    }
                    this.onLayerToggle?.('mpm', value);
                } else if (hasFEM && !hasCFD) {
                    this.activeLayers.fem = value;
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { showFEMMesh: value });
                    if (activeModel) {
                        activeModel.nodes
                            .filter((n: any) => n.type === 'FEMObject3D' || n.type === 'FEMDomain3D' || n.type === 'LSDynaImporter3D')
                            .forEach((n: any) => {
                                this.stateManager.updateNodeParametersInPlace(n.id, { visible: value, hidden: !value, showFEMMesh: value });
                            });
                    }
                    this.onLayerToggle?.('fem', value);
                } else {
                    this.activeLayers.slices = value;
                    if (vpNode) this.stateManager.updateNodeParametersInPlace(vpNode.id, { show_slices: value });
                    this.onLayerToggle?.('slices', value);
                }
            }
        }
        this.renderActiveTabContent();
    }

    private createFieldAndColormapCard(isCockpit: boolean): HTMLElement {
        const card = document.createElement('div');
        card.className = `${isCockpit ? 'sim-cockpit-card' : 'workstation-card'} field-card`;

        const ctx = this.getCurrentContextSettings();
        const availableTargets = this.getAvailableContextTargets();

        const b = document.createElement('div');
        b.className = 'card-body';

        // 1. Context Header Row (Target selector & reset button)
        const rowTarget = document.createElement('div');
        rowTarget.className = 'field-context-header';

        const targetLeft = document.createElement('div');
        targetLeft.style.display = 'flex';
        targetLeft.style.alignItems = 'center';
        targetLeft.style.gap = '4px';
        targetLeft.style.flex = '1';
        targetLeft.style.minWidth = '0';

        const targetSelect = document.createElement('select');
        targetSelect.className = 'field-context-selector';
        targetSelect.title = 'Select active 3D entity or click any object in the 3D viewport to inspect';

        let selectedTargetId = 'global';
        if (ctx.targetType === 'slice' && ctx.sliceIndex !== undefined) {
            selectedTargetId = `slice_${ctx.sliceIndex}`;
        } else if (ctx.targetType === 'global') {
            selectedTargetId = 'global';
        } else {
            const matched = availableTargets.find(t => {
                if (t.targetType !== ctx.targetType) return false;
                if (ctx.nodeId) {
                    if (this.selectedObject?.childId === 'water_sleeve' && t.id === `sleeve_${ctx.nodeId}`) return true;
                    if (this.selectedObject?.childId === 'seabed_soil' && t.id === `soil_${ctx.nodeId}`) return true;
                    if (t.id === `fem_${ctx.nodeId}`) return true;
                    if (t.id === `mpm_${ctx.nodeId}`) return true;
                    if (t.id === `stl_${ctx.nodeId}`) return true;
                    if (t.id === `obs_${ctx.nodeId}`) return true;
                    if (t.id === `gauges_${ctx.nodeId}`) return true;
                    if (t.id === `charge_${ctx.nodeId}`) return true;
                    if (t.id === `det_${ctx.nodeId}`) return true;
                    if (t.nodeId === ctx.nodeId) return true;
                }
                if (t.id === 'obstacles_mesh' && ctx.targetType === 'obstacles') return true;
                return true;
            });
            if (matched) {
                selectedTargetId = matched.id;
            }
        }

        availableTargets.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = `${t.icon} ${t.label}`;
            if (t.id === selectedTargetId) {
                opt.selected = true;
            }
            targetSelect.appendChild(opt);
        });
        targetSelect.value = selectedTargetId;

        targetSelect.addEventListener('change', () => {
            const found = availableTargets.find(t => t.id === targetSelect.value);
            if (found) {
                const domainNode = this.getActiveDomainNode();
                const vp = this.getActiveViewportNode();
                const targetNode = domainNode || vp;
                if (found.targetType === 'global') {
                    this.selectedObject = null;
                    this.activeSliceIndex = 0;
                    this.stateManager.setSelectedSliceIndex(null);
                    if (vp) this.stateManager.setSelectedNode(vp.id);
                } else if (found.targetType === 'slice') {
                    const sIdx = found.sliceIndex ?? 0;
                    const slices = this.getSlices();
                    const sl = slices[sIdx];
                    const axisStr = sl ? getSliceAxisLabel(sl.axis) : 'Z-Normal';
                    this.activeSliceIndex = sIdx;
                    this.selectedObject = {
                        objectType: 'Slice',
                        sliceIndex: sIdx,
                        label: `Slice #${sIdx} (${axisStr})`,
                        nodeId: targetNode?.id
                    };
                    this.stateManager.setSelectedSliceIndex(sIdx);
                    if (targetNode) {
                        this.stateManager.setSelectedNode(targetNode.id);
                    }
                } else {
                    const activeModel = this.stateManager.getActiveModel();
                    const entityNode = activeModel?.nodes.find((n: any) => n.id === found.nodeId);
                    let objType = 'GLOBAL';
                    let childId: string | undefined;
                    if (found.targetType === 'obstacles') objType = 'Obstacle';
                    else if (found.targetType === 'stl') objType = 'STLGeometry';
                    else if (found.targetType === 'fem') objType = 'FEMObject3D';
                    else if (found.targetType === 'mpm') {
                        objType = entityNode?.type === 'MarineHarbourDomain' ? 'MarineHarbourDomain' : 'MPMObject3D';
                        if (found.id.startsWith('sleeve_')) childId = 'water_sleeve';
                        else if (found.id.startsWith('soil_')) childId = 'seabed_soil';
                    }
                    else if (found.targetType === 'gauges') objType = 'VirtualGauges3D';
                    else if (found.targetType === 'detonator') objType = 'DetonatorLocation3D';
                    else if (found.targetType === 'charge') objType = 'Charge3D';
                    this.activeSliceIndex = 0;
                    this.stateManager.setSelectedSliceIndex(null);
                    if (entityNode) {
                        this.stateManager.setSelectedNode(entityNode.id);
                    }
                    this.selectedObject = {
                        objectType: objType,
                        objectId: found.nodeId,
                        childId,
                        label: entityNode?.parameters?.name || found.label,
                        nodeId: found.nodeId
                    };
                }
                this.renderActiveTabContent();
            }
        });
        targetLeft.appendChild(targetSelect);
        rowTarget.appendChild(targetLeft);

        if (ctx.targetType !== 'global') {
            const resetBtn = document.createElement('button');
            resetBtn.className = 'field-context-reset-btn';
            resetBtn.textContent = '↺ Global';
            resetBtn.title = 'Reset to Global CFD / Viewport Mode';
            resetBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.selectedObject = null;
                this.activeSliceIndex = 0;
                this.stateManager.setSelectedSliceIndex(null);
                const vp = this.getActiveViewportNode();
                if (vp) this.stateManager.setSelectedNode(vp.id);
                this.renderActiveTabContent();
            });
            rowTarget.appendChild(resetBtn);
        }

        b.appendChild(rowTarget);

        // 2. Row 1: Field Selector Dropdown
        const rowField = document.createElement('div');
        rowField.className = 'card-row';
        const fieldLbl = document.createElement('span');
        fieldLbl.className = 'sim-select-label';
        fieldLbl.textContent = 'FIELD:';

        const qtySelect = document.createElement('select');
        qtySelect.className = `transport-select full-width ${isCockpit ? 'compact-select' : ''}`;
        ctx.availableQuantities.forEach(q => {
            const opt = document.createElement('option');
            opt.value = q.val;
            opt.textContent = q.label;
            if (q.val === ctx.quantity) opt.selected = true;
            qtySelect.appendChild(opt);
        });
        qtySelect.addEventListener('change', () => {
            this.updateContextSetting('quantity', qtySelect.value);
        });
        rowField.appendChild(fieldLbl);
        rowField.appendChild(qtySelect);
        b.appendChild(rowField);

        // 3. Row 2: Colormap Selector Dropdown
        const rowCmap = document.createElement('div');
        rowCmap.className = 'card-row';
        const cmapLbl = document.createElement('span');
        cmapLbl.className = 'sim-select-label';
        cmapLbl.textContent = 'MAP:';

        const cmapSelect = document.createElement('select');
        cmapSelect.className = `transport-select full-width ${isCockpit ? 'compact-select' : ''}`;
        (['rainbow', 'plasma', 'viridis', 'turbo', 'inferno', 'coolwarm', 'jet', 'magma', 'grayscale', 'cividis'] as ColormapType[]).forEach(cm => {
            const opt = document.createElement('option');
            opt.value = cm;
            opt.textContent = cm.toUpperCase();
            if (cm === ctx.colormap) opt.selected = true;
            cmapSelect.appendChild(opt);
        });
        cmapSelect.addEventListener('change', () => {
            this.updateContextSetting('colormap', cmapSelect.value as ColormapType);
        });
        rowCmap.appendChild(cmapLbl);
        rowCmap.appendChild(cmapSelect);
        b.appendChild(rowCmap);

        // 3b. Row 2b: Contour Levels / Bands Selector
        if (ctx.contourLevels !== undefined || ctx.targetType === 'fem' || ctx.targetType === 'global' || ctx.targetType === 'slice' || ctx.targetType === 'mpm') {
            const rowLevels = document.createElement('div');
            rowLevels.className = 'card-row';
            rowLevels.style.display = 'flex';
            rowLevels.style.alignItems = 'center';
            rowLevels.style.gap = '6px';

            const isSmooth = Boolean(ctx.smoothContours || (ctx.contourLevels !== undefined && ctx.contourLevels <= 1));
            const curLvl = ctx.contourLevels && ctx.contourLevels > 1 ? ctx.contourLevels : 10;

            // Segmented mode toggle: Smooth vs Stepped
            const modeToggleGroup = document.createElement('div');
            modeToggleGroup.style.display = 'inline-flex';
            modeToggleGroup.style.borderRadius = '4px';
            modeToggleGroup.style.overflow = 'hidden';
            modeToggleGroup.style.border = '1px solid rgba(255, 255, 255, 0.15)';
            modeToggleGroup.style.flexShrink = '0';

            const smoothBtn = document.createElement('button');
            smoothBtn.type = 'button';
            smoothBtn.textContent = 'Smooth';
            smoothBtn.style.padding = '2px 7px';
            smoothBtn.style.fontSize = '8.5px';
            smoothBtn.style.fontWeight = '600';
            smoothBtn.style.cursor = 'pointer';
            smoothBtn.style.border = 'none';
            smoothBtn.style.background = isSmooth ? '#0284c7' : 'rgba(255, 255, 255, 0.06)';
            smoothBtn.style.color = isSmooth ? '#ffffff' : '#94a3b8';
            smoothBtn.title = 'Render continuous, smooth scalar field gradient';
            smoothBtn.onclick = () => {
                this.updateContextSetting('smoothContours', true);
            };

            const steppedBtn = document.createElement('button');
            steppedBtn.type = 'button';
            steppedBtn.textContent = 'Stepped';
            steppedBtn.style.padding = '2px 7px';
            steppedBtn.style.fontSize = '8.5px';
            steppedBtn.style.fontWeight = '600';
            steppedBtn.style.cursor = 'pointer';
            steppedBtn.style.border = 'none';
            steppedBtn.style.borderLeft = '1px solid rgba(255, 255, 255, 0.15)';
            steppedBtn.style.background = !isSmooth ? '#0284c7' : 'rgba(255, 255, 255, 0.06)';
            steppedBtn.style.color = !isSmooth ? '#ffffff' : '#94a3b8';
            steppedBtn.title = 'Render discretized isocontour bands';
            steppedBtn.onclick = () => {
                this.updateContextSetting('smoothContours', false);
                if (curLvl <= 1) {
                    this.updateContextSetting('contourLevels', 10);
                }
            };

            modeToggleGroup.appendChild(smoothBtn);
            modeToggleGroup.appendChild(steppedBtn);
            rowLevels.appendChild(modeToggleGroup);

            // Level selector (dropdown)
            const lvlSelect = document.createElement('select');
            lvlSelect.className = `transport-select full-width ${isCockpit ? 'compact-select' : ''}`;
            lvlSelect.style.flex = '1';
            const levelOptions = [
                { val: 5, label: '5 Discrete Bands' },
                { val: 8, label: '8 Discrete Bands' },
                { val: 10, label: '10 Standard CAE Bands' },
                { val: 12, label: '12 Standard CAE Bands' },
                { val: 16, label: '16 Discrete Bands' },
                { val: 20, label: '20 Discrete Bands' },
                { val: 24, label: '24 Discrete Bands' },
                { val: 32, label: '32 High-Def Bands' }
            ];
            levelOptions.forEach(opt => {
                const o = document.createElement('option');
                o.value = String(opt.val);
                o.textContent = opt.label;
                if (opt.val === curLvl) o.selected = true;
                lvlSelect.appendChild(o);
            });
            if (isSmooth) {
                lvlSelect.style.opacity = '0.55';
            }
            lvlSelect.addEventListener('change', () => {
                const v = parseInt(lvlSelect.value, 10);
                this.updateContextSetting('smoothContours', false);
                this.updateContextSetting('contourLevels', v);
            });
            rowLevels.appendChild(lvlSelect);
            b.appendChild(rowLevels);
        }

        // 4. Row 3: Toggles Grid (Display Overlays, Math/Shading, Lock)
        const rowToggles = document.createElement('div');
        rowToggles.className = 'card-row sim-toggles-row';

        // Visibility Toggle Chip
        const visBtn = this.createButton(
            '👁️ Vis',
            `chip-btn compact-chip ${ctx.visibility ? 'active' : ''}`,
            () => {
                this.updateContextSetting('visibility', !ctx.visibility);
            }
        );
        visBtn.title = 'Toggle visibility of this entity in the 3D viewport';
        rowToggles.appendChild(visBtn);

        // Mesh lines / Wireframe toggle (fixed label '📐 Wire' or '🌐 Mesh')
        const meshLabel = ctx.targetType === 'fem' || ctx.targetType === 'stl' || ctx.targetType === 'charge' || ctx.targetType === 'detonator'
            ? '📐 Wire'
            : '🌐 Mesh';
        const meshBtn = this.createButton(
            meshLabel,
            `chip-btn compact-chip ${ctx.showMeshLines ? 'active active-mesh' : ''}`,
            () => {
                this.updateContextSetting('showMeshLines', !ctx.showMeshLines);
            }
        );
        meshBtn.title = 'Toggle mesh lines, gridlines, or wireframe outline for this item';
        rowToggles.appendChild(meshBtn);

        // Colorbar toggle (fixed label '🎨 Bar', state indicated by .active.active-colorbar)
        const barBtn = this.createButton(
            '🎨 Bar',
            `chip-btn compact-chip ${ctx.showColorbar ? 'active active-colorbar' : ''}`,
            () => {
                this.updateContextSetting('showColorbar', !ctx.showColorbar);
            }
        );
        barBtn.title = 'Toggle on-screen color bar legend for this item';
        rowToggles.appendChild(barBtn);

        // Log / Lin toggle (fixed label '📐 Log', state indicated by .active.active-log)
        const logBtn = this.createButton(
            '📐 Log',
            `chip-btn compact-chip ${ctx.logScale ? 'active active-log' : ''}`,
            () => {
                this.updateContextSetting('logScale', !ctx.logScale);
            }
        );
        logBtn.title = 'Toggle logarithmic (Log10) scalar color transfer';
        rowToggles.appendChild(logBtn);

        // Optional 6th toggle (Interp for slice, Light for FEM/STL/Obstacles)
        const hasExtraToggle = (ctx.targetType === 'slice') ||
            (ctx.targetType === 'fem' || ctx.targetType === 'stl' || ctx.targetType === 'obstacles');

        // Lock / Unified Range Toggle Chip
        // When there is no 6th toggle (e.g. Global mode), lock spans 2 columns to symmetrically fill the 3-column row
        const lockSpanClass = hasExtraToggle ? '' : 'span-2-col';
        const lockLabel = hasExtraToggle
            ? (ctx.isLocked ? '🔒 Lock' : '🔓 Indep')
            : (ctx.isLocked ? '🔒 Lock Range' : '🔓 Indep Range');

        const lockBtn = this.createButton(
            lockLabel,
            `chip-btn compact-chip ${lockSpanClass} ${ctx.isLocked ? 'active active-auto' : ''}`,
            () => {
                this.updateContextSetting('lockRanges', !ctx.isLocked);
            }
        );
        lockBtn.title = ctx.isLocked
            ? 'Unified Field Range: ALL slices, CAD models, and obstacles displaying this quantity share the same range. Click to separate.'
            : 'Independent Range: This object uses independent scaling. Click to lock to unified range.';
        rowToggles.appendChild(lockBtn);

        // If slice, add optional Interp toggle chip (fixed label '〰️ Interp')
        if (ctx.targetType === 'slice') {
            const interpBtn = this.createButton(
                '〰️ Interp',
                `chip-btn compact-chip ${ctx.interpolate ? 'active' : ''}`,
                () => {
                    this.updateContextSetting('interpolate', !ctx.interpolate);
                }
            );
            interpBtn.title = 'Toggle bilinear interpolation vs discrete pixel cells';
            rowToggles.appendChild(interpBtn);
        } else if (ctx.targetType === 'fem' || ctx.targetType === 'stl' || ctx.targetType === 'obstacles') {
            const lightBtn = this.createButton(
                '💡 Light',
                `chip-btn compact-chip ${ctx.lighting !== false ? 'active' : ''}`,
                () => {
                    this.updateContextSetting('lighting', !(ctx.lighting !== false));
                }
            );
            lightBtn.title = 'Toggle directional lighting / Blinn-Phong shading';
            rowToggles.appendChild(lightBtn);
        }

        b.appendChild(rowToggles);

        // 5. Row 4: Manual Range Mini-Inputs with Integrated Auto-Scale Button
        const rowRange = document.createElement('div');
        rowRange.className = 'card-row field-range-row';

        // Auto Scale Toggle Button (directly adjacent to Min/Max inputs)
        const autoBtn = this.createButton(
            '⚡ Auto',
            `chip-btn compact-chip range-auto-chip ${ctx.autoScale ? 'active active-auto' : ''}`,
            () => {
                this.updateContextSetting('autoScale', !ctx.autoScale);
            }
        );
        autoBtn.title = 'Toggle between automatic min/max dynamic range and fixed manual scaling';
        rowRange.appendChild(autoBtn);

        const rangeInputsContainer = document.createElement('div');
        rangeInputsContainer.className = `range-inputs-container ${ctx.autoScale ? 'range-disabled' : ''}`;

        const minWrap = document.createElement('div');
        minWrap.className = 'range-input-wrap';
        const minLbl = document.createElement('span');
        minLbl.className = 'range-input-label';
        minLbl.textContent = 'Min:';
        const minInp = document.createElement('input');
        minInp.type = 'text';
        minInp.className = 'range-input';
        minInp.value = String(ctx.minVal);
        minInp.disabled = ctx.autoScale;
        minInp.title = ctx.autoScale ? 'Auto minimum scalar value (click Auto to unlock manual editing)' : 'Manual minimum scalar value';
        minInp.addEventListener('change', () => {
            const v = parseFloat(minInp.value);
            if (!isNaN(v)) {
                this.updateContextSetting('minVal', v);
            }
        });
        minInp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                minInp.blur();
            }
        });
        minWrap.appendChild(minLbl);
        minWrap.appendChild(minInp);

        const maxWrap = document.createElement('div');
        maxWrap.className = 'range-input-wrap';
        const maxLbl = document.createElement('span');
        maxLbl.className = 'range-input-label';
        maxLbl.textContent = 'Max:';
        const maxInp = document.createElement('input');
        maxInp.type = 'text';
        maxInp.className = 'range-input';
        maxInp.value = String(ctx.maxVal);
        maxInp.disabled = ctx.autoScale;
        maxInp.title = ctx.autoScale ? 'Auto maximum scalar value (click Auto to unlock manual editing)' : 'Manual maximum scalar value';
        maxInp.addEventListener('change', () => {
            const v = parseFloat(maxInp.value);
            if (!isNaN(v)) {
                this.updateContextSetting('maxVal', v);
            }
        });
        maxInp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                maxInp.blur();
            }
        });
        maxWrap.appendChild(maxLbl);
        maxWrap.appendChild(maxInp);

        rangeInputsContainer.appendChild(minWrap);
        rangeInputsContainer.appendChild(maxWrap);
        rowRange.appendChild(rangeInputsContainer);
        b.appendChild(rowRange);

        // 6. Dedicated Item-Specific Controls Row
        if (ctx.targetType === 'slice') {
            const sliceCard = document.createElement('div');
            sliceCard.className = 'field-item-specific-card';

            // Row 1: Plane & Stride Selectors
            const planeStrideRow = document.createElement('div');
            planeStrideRow.className = 'field-mini-row';

            const planeLbl = document.createElement('span');
            planeLbl.className = 'field-mini-label';
            planeLbl.textContent = 'PLANE:';

            const planeSel = document.createElement('select');
            planeSel.className = 'field-mini-select';
            [
                { val: 'yz', label: 'X-Normal' },
                { val: 'xz', label: 'Y-Normal' },
                { val: 'xy', label: 'Z-Normal' }
            ].forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.val;
                opt.textContent = p.label;
                if (p.val === (ctx.sliceAxis || 'xy')) opt.selected = true;
                planeSel.appendChild(opt);
            });
            planeSel.addEventListener('change', () => {
                this.updateContextSetting('sliceAxis', planeSel.value);
            });

            const strideLbl = document.createElement('span');
            strideLbl.className = 'field-mini-label';
            strideLbl.style.minWidth = '36px';
            strideLbl.textContent = 'STRIDE:';

            const strideSel = document.createElement('select');
            strideSel.className = 'field-mini-select';
            [
                { val: 1, label: '1x Full' },
                { val: 2, label: '2x' },
                { val: 4, label: '4x' },
                { val: 8, label: '8x' }
            ].forEach(s => {
                const opt = document.createElement('option');
                opt.value = String(s.val);
                opt.textContent = s.label;
                if (s.val === (ctx.sliceStride || 1)) opt.selected = true;
                strideSel.appendChild(opt);
            });
            strideSel.addEventListener('change', () => {
                this.updateContextSetting('sliceStride', parseInt(strideSel.value, 10));
            });

            planeStrideRow.appendChild(planeLbl);
            planeStrideRow.appendChild(planeSel);
            planeStrideRow.appendChild(strideLbl);
            planeStrideRow.appendChild(strideSel);
            sliceCard.appendChild(planeStrideRow);

            // Row 2: Physical Offset Slider & Number Input
            const offsetRow = document.createElement('div');
            offsetRow.className = 'field-mini-row';

            const offsetLbl = document.createElement('span');
            offsetLbl.className = 'field-mini-label';
            offsetLbl.textContent = 'OFFSET:';

            const dMin = ctx.domainMin !== undefined ? ctx.domainMin : 0.0;
            const dMax = ctx.domainMax !== undefined ? ctx.domainMax : 1.0;
            const curOff = ctx.sliceOffset !== undefined ? ctx.sliceOffset : (dMin + dMax) * 0.5;

            const offsetSlider = document.createElement('input');
            offsetSlider.type = 'range';
            offsetSlider.className = 'field-mini-slider';
            offsetSlider.min = String(dMin);
            offsetSlider.max = String(dMax);
            offsetSlider.step = String((dMax - dMin) / 200.0 || 0.001);
            offsetSlider.value = String(curOff);

            const offsetNum = document.createElement('input');
            offsetNum.type = 'number';
            offsetNum.className = 'field-mini-num-input';
            offsetNum.step = 'any';
            offsetNum.value = curOff.toFixed(3);

            offsetSlider.addEventListener('input', () => {
                const v = parseFloat(offsetSlider.value);
                offsetNum.value = v.toFixed(3);
                this.updateContextSetting('sliceOffset', v);
            });

            offsetNum.addEventListener('change', () => {
                const v = parseFloat(offsetNum.value);
                if (!isNaN(v)) {
                    offsetSlider.value = String(v);
                    this.updateContextSetting('sliceOffset', v);
                }
            });

            offsetRow.appendChild(offsetLbl);
            offsetRow.appendChild(offsetSlider);
            offsetRow.appendChild(offsetNum);
            sliceCard.appendChild(offsetRow);

            // Row 3: Opacity Slider
            const opRow = document.createElement('div');
            opRow.className = 'field-mini-row';

            const opLbl = document.createElement('span');
            opLbl.className = 'field-mini-label';
            opLbl.textContent = 'OPACITY:';

            const curOp = ctx.sliceOpacity !== undefined ? ctx.sliceOpacity : 1.0;

            const opSlider = document.createElement('input');
            opSlider.type = 'range';
            opSlider.className = 'field-mini-slider';
            opSlider.min = '0';
            opSlider.max = '1';
            opSlider.step = '0.05';
            opSlider.value = String(curOp);

            const opVal = document.createElement('span');
            opVal.className = 'field-mini-val';
            opVal.textContent = `${Math.round(curOp * 100)}%`;

            opSlider.addEventListener('input', () => {
                const v = parseFloat(opSlider.value);
                opVal.textContent = `${Math.round(v * 100)}%`;
                this.updateContextSetting('sliceOpacity', v);
            });

            opRow.appendChild(opLbl);
            opRow.appendChild(opSlider);
            opRow.appendChild(opVal);
            sliceCard.appendChild(opRow);

            b.appendChild(sliceCard);
        } else if (ctx.targetType === 'fem' || ctx.targetType === 'stl' || ctx.targetType === 'obstacles') {
            const entityCard = document.createElement('div');
            entityCard.className = 'field-item-specific-card';

            const opRow = document.createElement('div');
            opRow.className = 'field-mini-row';

            const opLbl = document.createElement('span');
            opLbl.className = 'field-mini-label';
            opLbl.textContent = 'OPACITY:';

            const curOp = ctx.opacity !== undefined ? ctx.opacity : 1.0;

            const opSlider = document.createElement('input');
            opSlider.type = 'range';
            opSlider.className = 'field-mini-slider';
            opSlider.min = '0';
            opSlider.max = '1';
            opSlider.step = '0.05';
            opSlider.value = String(curOp);

            const opVal = document.createElement('span');
            opVal.className = 'field-mini-val';
            opVal.textContent = `${Math.round(curOp * 100)}%`;

            const opKey = ctx.targetType === 'fem' ? 'femOpacity' : (ctx.targetType === 'stl' ? 'stlOpacity' : 'obstaclesOpacity');
            opSlider.addEventListener('input', () => {
                const v = parseFloat(opSlider.value);
                opVal.textContent = `${Math.round(v * 100)}%`;
                this.updateContextSetting(opKey, v);
            });

            opRow.appendChild(opLbl);
            opRow.appendChild(opSlider);
            opRow.appendChild(opVal);
            entityCard.appendChild(opRow);

            b.appendChild(entityCard);
        }

        card.appendChild(b);
        return card;
    }

    // =========================================================================
    // HELPER ACTIONS & EVENT HANDLERS
    // =========================================================================
    private addSlice(plane: 'xy' | 'xz' | 'yz'): void {
        const domainNode = this.getActiveDomainNode();
        const vpNode = this.getActiveViewportNode();
        const target = domainNode || vpNode;

        if (target) {
            const current = target.parameters?.slices || vpNode?.parameters?.slices || [];
            const activeModel = this.stateManager.getActiveModel();
            const currentState = this.stateManager.getCurrentState();
            const bounds = resolveSliceDomainBounds(plane, target, currentState, activeModel);
            const defOffset = (bounds.min + bounds.max) / 2.0;
            const updated = [...current, { axis: plane, offset: defOffset, enabled: true, colormap: 'rainbow', opacity: 1.0, quantity: 'pressure' }];
            this.stateManager.updateNodeParametersInPlace(target.id, { slices: updated });
            if (vpNode && vpNode.id !== target.id) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, { slices: updated });
            }
            this.onSliceConfigChange?.(updated);
            this.renderActiveTabContent();
        }
    }

    private removeSlice(idx: number): void {
        const domainNode = this.getActiveDomainNode();
        const vpNode = this.getActiveViewportNode();
        const target = domainNode || vpNode;

        if (target) {
            const current = [...(target.parameters?.slices || vpNode?.parameters?.slices || [])];
            if (idx >= 0 && idx < current.length) {
                current.splice(idx, 1);
                this.stateManager.updateNodeParametersInPlace(target.id, { slices: current });
                if (vpNode && vpNode.id !== target.id) {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { slices: current });
                }
                this.onSliceConfigChange?.(current);
                this.renderActiveTabContent();
            }
        }
    }

    private updateSliceInNode(idx: number, sliceData: any): void {
        const domainNode = this.getActiveDomainNode();
        const vpNode = this.getActiveViewportNode();
        const target = domainNode || vpNode;

        if (target) {
            const current = [...(target.parameters?.slices || vpNode?.parameters?.slices || [])];
            current[idx] = { ...current[idx], ...sliceData };
            this.stateManager.updateNodeParametersInPlace(target.id, { slices: current });
            if (vpNode && vpNode.id !== target.id) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, { slices: current });
            }
            this.onSliceConfigChange?.(current);
        }
    }

    private addGaugeProbe(): void {
        const targetModel = this.stateManager.getActiveModel();
        const gaugeNode = targetModel?.nodes.find((n: any) => n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D' || n.type === 'VirtualGauge');
        if (gaugeNode) {
            const list = gaugeNode.parameters?.gauges || [];
            const newId = `P${list.length + 1}`;
            const updated = [...list, { id: newId, x: 0.0, y: 0.0, z: 0.0 }];
            this.stateManager.updateNodeParametersInPlace(gaugeNode.id, { gauges: updated });
            this.renderActiveTabContent();
        }
    }

    private removeGaugeProbe(idx: number): void {
        const targetModel = this.stateManager.getActiveModel();
        const gaugeNode = targetModel?.nodes.find((n: any) => n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D' || n.type === 'VirtualGauge');
        if (gaugeNode) {
            const list = [...(gaugeNode.parameters?.gauges || [])];
            if (idx >= 0 && idx < list.length) {
                list.splice(idx, 1);
                this.stateManager.updateNodeParametersInPlace(gaugeNode.id, { gauges: list });
                this.renderActiveTabContent();
            }
        }
    }

    private toggleLiveLock(): void {
        this.isLiveLocked = !this.isLiveLocked;
        if (this.liveLockBtn) {
            this.liveLockBtn.classList.toggle('active', this.isLiveLocked);
        }
        if (this.isLiveLocked) {
            this.jumpToLastFrame();
        }
    }

    private togglePlayback(): void {
        this.isPlaying = !this.isPlaying;
        if (this.playPauseBtn) {
            this.playPauseBtn.innerHTML = this.isPlaying ? '⏸' : '▶';
            this.playPauseBtn.classList.toggle('playing', this.isPlaying);
        }
        this.onPlaybackStateChange?.(this.isPlaying, this);
        if (this.isPlaying) {
            this.isLiveLocked = false;
            if (this.liveLockBtn) this.liveLockBtn.classList.remove('active');
            this.lastAnimTimestamp = performance.now();
            this.runPlaybackLoop();
        } else {
            if (this.animFrameId) {
                cancelAnimationFrame(this.animFrameId);
                this.animFrameId = null;
            }
        }
    }

    public setExternalPlaybackState(isPlaying: boolean): void {
        if (this.isPlaying === isPlaying) return;
        this.isPlaying = isPlaying;
        if (this.playPauseBtn) {
            this.playPauseBtn.innerHTML = isPlaying ? '⏸' : '▶';
            this.playPauseBtn.classList.toggle('playing', isPlaying);
        }
        if (!isPlaying && this.animFrameId !== null) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }
    }

    public syncFrameFromExternal(frameIndex: number, isLive: boolean): void {
        if (this.animFrameId !== null) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }
        this.isPlaying = false;
        if (this.playPauseBtn) {
            this.playPauseBtn.innerHTML = '▶';
            this.playPauseBtn.classList.remove('playing');
        }

        const count = this.buffer.getFrameCount();
        if (count === 0) return;
        const target = Math.max(0, Math.min(count - 1, frameIndex));
        this.currentFrameIndex = target;
        this.isLiveLocked = isLive;
        if (this.liveLockBtn) {
            this.liveLockBtn.classList.toggle('active', isLive);
        }
        if (this.scrubberSlider) {
            this.scrubberSlider.max = String(Math.max(0, count - 1));
            this.scrubberSlider.value = String(target);
        }
        const frame = this.buffer.getFrame(target);
        if (frame) {
            this.updateReadouts(frame);
        }
    }

    private runPlaybackLoop(): void {
        if (!this.isPlaying) return;
        const now = performance.now();
        const delta = now - this.lastAnimTimestamp;
        const frameInterval = (1000.0 / 30.0) / this.playbackSpeed;

        if (delta >= frameInterval) {
            this.lastAnimTimestamp = now;
            const count = this.buffer.getFrameCount();
            if (count > 0) {
                let nextIdx = this.currentFrameIndex + 1;
                if (nextIdx >= count) {
                    if (this.loopPlayback) {
                        nextIdx = 0;
                    } else {
                        this.togglePlayback();
                        return;
                    }
                }
                this.seekToFrame(nextIdx, false);
            }
        }
        this.animFrameId = requestAnimationFrame(() => this.runPlaybackLoop());
    }

    private jumpToFirstFrame(): void {
        this.isLiveLocked = false;
        if (this.liveLockBtn) this.liveLockBtn.classList.remove('active');
        this.seekToFrame(0, false);
    }

    private jumpToLastFrame(): void {
        const count = this.buffer.getFrameCount();
        if (count > 0) {
            this.seekToFrame(count - 1, true);
        }
    }

    private stepFrame(delta: number): void {
        this.isLiveLocked = false;
        if (this.liveLockBtn) this.liveLockBtn.classList.remove('active');
        const count = this.buffer.getFrameCount();
        if (count === 0) return;
        const target = Math.max(0, Math.min(count - 1, this.currentFrameIndex + delta));
        this.seekToFrame(target, false);
    }

    private seekToFrame(index: number, isLive: boolean): void {
        const frame = this.buffer.getFrame(index);
        if (!frame) return;
        this.currentFrameIndex = index;
        if (this.scrubberSlider) this.scrubberSlider.value = String(index);
        this.updateReadouts(frame);
        this.onFrameDispatch?.(frame, isLive, this);
    }

    private updateReadouts(frame: BufferedFrame): void {
        this.pendingFrame = frame;
        this.pendingStep = frame.step;
        this.pendingTime = frame.time;
        this.pendingDt = frame.metrics?.dt;
        this.requestStatsFlush();
    }

    private formatSimTime(t: number): string {
        if (!Number.isFinite(t) || t <= 0) return '0.000 s';
        if (t >= 1.0) return `${t.toFixed(4)} s`;
        if (t >= 0.001) return `${(t * 1000).toFixed(3)} ms`;
        if (t >= 1e-6) return `${(t * 1e6).toFixed(2)} µs`;
        return `${(t * 1e9).toFixed(1)} ns`;
    }

    private formatDt(dt: number | undefined): string {
        if (dt === undefined || !Number.isFinite(dt) || dt <= 0) return '--';
        if (dt >= 1.0) return `${dt.toFixed(4)} s`;
        if (dt >= 0.001) return `${(dt * 1000).toFixed(3)} ms`;
        if (dt >= 1e-6) return `${(dt * 1e6).toFixed(2)} µs`;
        if (dt >= 1e-9) return `${(dt * 1e9).toFixed(1)} ns`;
        return `${dt.toExponential(3)} s`;
    }

    /**
     * Update Live Execution Stats (Step, Total Sim Time, Timestep dt)
     * Throttled via requestAnimationFrame to avoid UI freeze during high-frequency telemetry.
     */
    public updateExecutionStats(step?: number, time?: number, dt?: number): void {
        const activeModelId = this.stateManager.getActiveModelId();
        const status = activeModelId ? this.stateManager.getModelStatus(activeModelId) : 'UNINITIALIZED';
        const isResetState = status === 'INITIALIZED' || status === 'UNINITIALIZED';

        if (step !== undefined) {
            if (step > 0 || isResetState || (this.pendingStep || 0) === 0) {
                this.pendingStep = step;
            }
        }
        if (time !== undefined) {
            if (time > 0 || isResetState || (this.pendingTime || 0) === 0) {
                this.pendingTime = time;
            }
        }
        if (dt !== undefined) {
            if (dt > 0) {
                this.pendingDt = dt;
            } else if (isResetState) {
                this.pendingDt = undefined;
            }
        }
        this.requestStatsFlush();
    }

    private requestStatsFlush(): void {
        if (this.statsUpdatePending) return;
        this.statsUpdatePending = true;
        this.statsFlushRafId = requestAnimationFrame(() => {
            this.statsFlushRafId = null;
            this.statsUpdatePending = false;
            this.flushStatsNow();
        });
    }

    private flushStatsNow(): void {
        if (this.pendingTotalCount !== undefined && this.scrubberSlider) {
            this.scrubberSlider.max = String(Math.max(0, this.pendingTotalCount - 1));
            if (this.isLiveLocked) {
                this.scrubberSlider.value = String(this.currentFrameIndex);
            }
        }

        const activeModelId = this.stateManager.getActiveModelId();
        const smStep = activeModelId ? (this.stateManager.getModelStep(activeModelId) || 0) : 0;
        const smTime = activeModelId ? (this.stateManager.getModelSimTime(activeModelId) || 0) : 0;
        const smDt = activeModelId ? (this.stateManager.getModelDt(activeModelId) || 0) : 0;

        let curStep: number;
        let curTime: number;
        let curDt: number | undefined;

        if (this.isLiveLocked) {
            // Live locked: master ground truth is active solver state, preventing any drop to zero
            curStep = Math.max(this.pendingStep ?? 0, smStep);
            curTime = Math.max(this.pendingTime ?? 0, smTime);
            curDt = (this.pendingDt && this.pendingDt > 0) ? this.pendingDt : (smDt > 0 ? smDt : undefined);
        } else {
            // Historical scrubbing: display inspected frame's values, falling back to model state
            curStep = this.pendingStep !== undefined ? this.pendingStep : smStep;
            curTime = this.pendingTime !== undefined ? this.pendingTime : smTime;
            curDt = (this.pendingDt && this.pendingDt > 0) ? this.pendingDt : (smDt > 0 ? smDt : undefined);
        }

        if (this.pendingFrame) {
            const frame = this.pendingFrame;
            const t = (frame.time !== undefined && frame.time > 0) ? frame.time : (curTime || 0.0);
            if (this.timeDisplay) {
                if (t >= 1.0) {
                    this.timeDisplay.textContent = `t = ${t.toFixed(4)} s`;
                } else if (t >= 0.001) {
                    this.timeDisplay.textContent = `t = ${(t * 1000).toFixed(3)} ms`;
                } else {
                    this.timeDisplay.textContent = `t = ${(t * 1e6).toFixed(1)} µs`;
                }
            }
            if (this.stepDisplay) {
                const s = (frame.step !== undefined && frame.step > 0) ? frame.step : (curStep || 0);
                this.stepDisplay.textContent = `Step ${s}`;
            }
        }
        if (this.bufferCountDisplay) {
            this.bufferCountDisplay.textContent = `(${this.buffer.getFrameCount()} frames)`;
        }

        if (this.execStepValue) {
            this.execStepValue.textContent = (curStep || 0).toLocaleString();
        }
        if (this.execTimeValue) {
            this.execTimeValue.textContent = this.formatSimTime(curTime || 0);
        }
        if (this.execDtValue) {
            this.execDtValue.textContent = this.formatDt(curDt);
        }
    }

    private updateModelStatusDisplay(): void {
        const activeModelId = this.stateManager.getActiveModelId();
        if (!activeModelId) return;
        const status = this.stateManager.getModelStatus(activeModelId);
        if (this.statusBadge) {
            this.statusBadge.textContent = status;
            this.statusBadge.className = `workstation-status-pill ${status.toLowerCase()}`;
        }
        if (this.modelInfoBadge) {
            const m = this.stateManager.getActiveModel();
            this.modelInfoBadge.textContent = m ? `${m.name}` : 'Model 1';
        }
    }

    private attachBufferListeners(): void {
        const unbindBuffer = this.buffer.onFrameAdded((frame, totalCount) => {
            this.pendingTotalCount = totalCount;
            if (this.isLiveLocked) {
                this.currentFrameIndex = totalCount - 1;
                this.pendingFrame = frame;
                if (frame.step !== undefined && frame.step > 0) {
                    this.pendingStep = frame.step;
                }
                if (frame.time !== undefined && frame.time > 0) {
                    this.pendingTime = frame.time;
                }
                if (frame.metrics?.dt !== undefined && frame.metrics.dt > 0) {
                    this.pendingDt = frame.metrics.dt;
                }
                this.requestStatsFlush();
            } else {
                if (this.scrubberSlider) {
                    this.scrubberSlider.max = String(Math.max(0, totalCount - 1));
                }
            }
        });
        if (typeof unbindBuffer === 'function') {
            this.unbinds.push(unbindBuffer);
        }

        const onModelStatus = (_modelId?: string, status?: SimulationStatus) => {
            if (status === 'INITIALIZED' || status === 'UNINITIALIZED') {
                this.pendingStep = 0;
                this.pendingTime = 0;
                this.pendingDt = undefined;
            }
            this.syncStateFromViewport();
            this.updateModelStatusDisplay();
            this.updateExecutionStats();
        };
        this.stateManager.onModelStatusChange(onModelStatus);
        this.unbinds.push(() => this.stateManager.offModelStatusChange(onModelStatus));

        const onState = () => {
            this.syncStateFromViewport();
            this.updateModelStatusDisplay();
            this.requestTabRender();
            this.updateExecutionStats();
        };
        this.stateManager.onStateChange(onState);
        this.unbinds.push(() => this.stateManager.offStateChange(onState));

        const onInPlace = (nodeId: string, _parameters: Record<string, any>) => {
            const vpNode = this.getActiveViewportNode();
            const activeModel = this.stateManager.getActiveModel();
            const isVp = vpNode && nodeId === vpNode.id;
            const isSelected = (this.selectedObject?.nodeId && nodeId === this.selectedObject.nodeId) || (this.stateManager.selectedNodeId && nodeId === this.stateManager.selectedNodeId);
            const isModelNode = activeModel ? activeModel.nodes.some((n: any) => n.id === nodeId) : false;

            if (isVp || isSelected || isModelNode) {
                this.syncStateFromViewport();
                this.requestTabRender();
            }
        };
        this.stateManager.onInPlaceParameterChange(onInPlace);
        this.unbinds.push(() => this.stateManager.offInPlaceParameterChange(onInPlace));

        const onTelemetry = (_nodeId: string, data: any) => {
            if (data && typeof data === 'object' && !(data instanceof ArrayBuffer)) {
                if (data.step !== undefined || data.time !== undefined || data.dt !== undefined) {
                    this.updateExecutionStats(data.step, data.time, data.dt);
                }
            }
        };
        this.stateManager.onTelemetryUpdate(onTelemetry);
        this.unbinds.push(() => this.stateManager.offTelemetryUpdate(onTelemetry));

        const onFocusedVp = () => {
            this.syncStateFromViewport();
            if (this.activeTab === 'slices_matrix' || this.activeTab === 'camera_view' || this.activeTab === 'sim_view') {
                this.requestTabRender();
            }
        };
        this.stateManager.onFocusedViewportChange(onFocusedVp);
        this.unbinds.push(() => this.stateManager.offFocusedViewportChange(onFocusedVp));

        const onSel = (nodeId: string | null) => {
            if (!nodeId) {
                if (this.selectedObject && this.selectedObject.objectType !== 'Slice') {
                    this.selectedObject = null;
                }
            } else {
                const targetModel = this.stateManager.getActiveModel();
                const node = targetModel?.nodes.find((n: any) => n.id === nodeId);
                if (node) {
                    if (node.type === 'Telemetry3DViewport' || node.type === 'DomainMesh3D' || node.type === 'DomainMesh' || node.type === 'CFDSolver3D' || node.type === 'CFDSolver' || node.type === 'CFDSolver2D') {
                        const sIdx = this.stateManager.getSelectedSliceIndex();
                        if (sIdx !== null && sIdx !== undefined) {
                            const slices = this.getSlices();
                            const sl = slices[sIdx];
                            const axisStr = sl ? getSliceAxisLabel(sl.axis) : 'Z-Normal';
                            this.selectedObject = {
                                objectType: 'Slice',
                                sliceIndex: sIdx,
                                label: `Slice #${sIdx} (${axisStr})`,
                                nodeId: node.id
                            };
                        } else {
                            this.selectedObject = null;
                        }
                    } else if (['FEMObject3D', 'FEMDomain3D', 'FEMBeam3D', 'FEMRebar3D', 'LSDynaImporter3D'].includes(node.type)) {
                        this.selectedObject = {
                            objectType: 'FEMObject3D',
                            nodeId: node.id,
                            label: node.parameters?.name || 'FEM Mesh'
                        };
                    } else if (['MPMObject3D', 'MPMDomain3D'].includes(node.type)) {
                        this.selectedObject = {
                            objectType: 'MPMObject3D',
                            nodeId: node.id,
                            label: node.parameters?.name || 'MPM Particles'
                        };
                    } else if (node.type === 'STLGeometry') {
                        this.selectedObject = {
                            objectType: 'STLGeometry',
                            nodeId: node.id,
                            label: node.parameters?.name || 'STL CAD'
                        };
                    } else if (['PrimitiveGeometry3D', 'Obstacle'].includes(node.type)) {
                        this.selectedObject = {
                            objectType: 'Obstacle',
                            nodeId: node.id,
                            label: node.parameters?.name || 'Obstacle'
                        };
                    } else if (['VirtualGauges', 'VirtualGauges3D', 'VirtualGauge'].includes(node.type)) {
                        this.selectedObject = {
                            objectType: 'VirtualGauges3D',
                            nodeId: node.id,
                            label: node.parameters?.name || 'Virtual Gauges'
                        };
                    } else if (['DetonatorLocation3D', 'DetonatorLocation', 'TriggerLocation3D', 'TriggerLocation'].includes(node.type)) {
                        this.selectedObject = {
                            objectType: 'DetonatorLocation3D',
                            nodeId: node.id,
                            label: node.parameters?.name || 'Detonator'
                        };
                    } else if (['Charge3D', 'Charge2D', 'ExplosiveMaterial'].includes(node.type)) {
                        this.selectedObject = {
                            objectType: 'Charge3D',
                            nodeId: node.id,
                            label: node.parameters?.name || 'Charge'
                        };
                    }
                }
            }
            this.renderActiveTabContent(true);
        };
        this.stateManager.onSelectionChange(onSel);
        this.unbinds.push(() => this.stateManager.offSelectionChange(onSel));

        const onSliceSel = (sliceIdx: number | null) => {
            if (sliceIdx !== null && sliceIdx !== undefined) {
                this.activeSliceIndex = sliceIdx;
                const slices = this.getSlices();
                const sl = slices[sliceIdx];
                const axisStr = sl ? getSliceAxisLabel(sl.axis) : 'Z-Normal';
                const domainNode = this.getActiveDomainNode();
                const vpNode = this.getActiveViewportNode();
                this.selectedObject = {
                    objectType: 'Slice',
                    sliceIndex: sliceIdx,
                    label: `Slice #${sliceIdx} (${axisStr})`,
                    nodeId: domainNode?.id || vpNode?.id
                };
            } else if (this.selectedObject?.objectType === 'Slice') {
                this.selectedObject = null;
            }
            this.renderActiveTabContent(true);
        };
        this.stateManager.onSliceSelectionChange(onSliceSel);
        this.unbinds.push(() => this.stateManager.offSliceSelectionChange(onSliceSel));
    }

    /**
     * Clean up all event subscriptions, animation frames, and DOM elements when destroyed.
     */
    public destroy(): void {
        if (this.animFrameId !== null) {
            cancelAnimationFrame(this.animFrameId);
            this.animFrameId = null;
        }
        this.isPlaying = false;
        if (this.tabRenderRafId !== null) {
            cancelAnimationFrame(this.tabRenderRafId);
            this.tabRenderRafId = null;
        }
        if (this.statsFlushRafId !== null) {
            cancelAnimationFrame(this.statsFlushRafId);
            this.statsFlushRafId = null;
        }
        for (const unbind of this.unbinds) {
            try { unbind(); } catch (_) {}
        }
        this.unbinds = [];
        if (this.rootElement && this.rootElement.parentNode) {
            this.rootElement.parentNode.removeChild(this.rootElement);
        }
    }

    /**
     * Request latest state from solver and plot across all active viewports.
     */
    public requestAndPlotCurrentState(): void {
        const count = this.buffer.getFrameCount();
        if (count > 0) {
            const idx = this.currentFrameIndex >= 0 ? this.currentFrameIndex : count - 1;
            const frame = this.buffer.getFrame(idx) || this.buffer.getLatestFrame();
            if (frame) {
                this.seekToFrame(idx, this.isLiveLocked);
            }
        }
        this.onManualRefresh?.();
        this.onSimCommand?.('REFRESH');
    }

    private createButton(text: string, className: string, onClick: () => void): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.innerHTML = text;
        btn.className = className;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return btn;
    }
}
