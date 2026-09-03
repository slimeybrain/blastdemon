import { Node, PanelType } from './types.js';
import { StateManager, resolveSliceDomainBounds, canonicalizeQuantity, DEFAULT_QUANTITY_RANGES, resolveResourcePath, getSliceAxisLabel } from './state-manager.js';

function getFocusedQuantityAndRange(vpNode: any): { quantity: string, min: number, max: number } {
    const slices = vpNode.parameters.slices || [];
    const focusedIdx = vpNode.parameters.focusedSliceIndex ?? 0;
    const slice = slices[focusedIdx] || slices[0] || { quantities: ['pressure'] };
    const rawQty = slice.quantities?.[0] || 'pressure';
    const qty = canonicalizeQuantity(rawQty);

    const ranges = vpNode.parameters.quantity_ranges || {};
    const range = ranges[qty] || ranges[rawQty] || DEFAULT_QUANTITY_RANGES[qty] || [0.0, 1.0];
    return { quantity: qty, min: range[0], max: range[1] };
}

export class Telemetry3DViewport {
    private container: HTMLElement;
    private canvas: HTMLCanvasElement;
    private worker: Worker;
    private stateManager: StateManager;
    private panelId: string;
    private stateListener: () => void;
    private netCallback: ((data: string | ArrayBuffer) => void) | null = null;
    private openListener: (() => void) | null = null;
    private currentSTLPath: string | null = null;
    private currentGeometryHash: string | null = null;
    private lastTelemetryGridKey: string = '';
    private debugOverlay: HTMLElement | null = null;
    private hasTelemetryGrid = false;
    private overlayCanvas: HTMLCanvasElement | null = null;
    private latestFrameData: any = null;

    // Overlay Elements
    private controlsOverlay: HTMLElement | null = null;
    private floatOpenBtn: HTMLElement | null = null;
    private bottomViewDock: HTMLElement | null = null;
    private sliceListContainer: HTMLElement | null = null;
    private staticListContainer: HTMLElement | null = null;
    private expandedSliceIndices = new Set<number>();
    private needsSlicesRebuild = true;
    private isOpen = false;
    private latestSliceRanges: { min: number, max: number }[] = [];
    private latestEmpiricalRange: { min: number, max: number } | null = null;
    private latestMPMRange: { min: number, max: number } | null = null;
    private latestFEMRange: { min: number, max: number } | null = null;
    private latestBeamRange: { min: number, max: number } | null = null;
    private latestSTLRange: { min: number, max: number } | null = null;
    private latestObstaclesRange: { min: number, max: number } | null = null;
    private latestEmpiricalSpacing: number = 0;
    private latestQuantityRanges: Record<string, [number, number]> = {};
    private colorbarUpdateRafId: number | null = null;
    private _lastSliceKey: string = '';

    // Colorbar Overlay Container
    private colorbarContainer: HTMLElement | null = null;
    private usePerspective: boolean = true;
    private isWorkerBusy: boolean = false;
    private pendingFrames: Map<number, { buffer: ArrayBuffer, modelId?: string }> = new Map();
    private workerTimer: any = null;

    private viewTypeSuffix: string;
    private viewportNodeId: string | null = null;
    private virtualNodes: Record<string, any> = {};
    private modelStatusListener: ((modelId: string, status: any) => void) | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private windowResizeHandler: (() => void) | null = null;
    private cachedSTL: { vertices: Float32Array | null, meshId: string } | null = null;
    private cachedObstacles: { vertices: Float32Array | null, cells: Int32Array | null, meshId: string } | null = null;

    private requestColorbarUpdate(): void {
        if (this.colorbarUpdateRafId !== null) return;
        this.colorbarUpdateRafId = requestAnimationFrame(() => {
            this.colorbarUpdateRafId = null;
            const vpNode = this.getViewportNode();
            this.syncColorbarOverlay(vpNode || { parameters: {} });
        });
    }

    public triggerResize = () => {
        const r = this.container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        if (r.width > 0 && r.height > 0) {
            this.worker.postMessage({
                type: 'resize',
                data: {
                    width: r.width * dpr,
                    height: r.height * dpr,
                    dpr
                }
            });
        }
    };

    private getElId(base: string): string {
        return `${base}-${this.panelId}${this.viewTypeSuffix}`;
    }

    constructor(container: HTMLElement, panelId: string, stateManager: StateManager, viewTypeSuffix: string = '', viewportNodeId?: string | null) {
        this.container = container;
        this.panelId = panelId;
        this.stateManager = stateManager;
        this.viewTypeSuffix = viewTypeSuffix;
        this.viewportNodeId = viewportNodeId || null;

        this.windowResizeHandler = () => this.triggerResize();
        window.addEventListener('resize', this.windowResizeHandler);

        this.stateManager.onInPlaceParameterChange((nodeId, parameters) => {
            const vpNode = this.getViewportNode();
            const targetModel = this.getTargetModel();
            const isVpNode = (nodeId === vpNode?.id || (this.viewportNodeId && nodeId === this.viewportNodeId) || nodeId.startsWith('virtual-viewport-'));
            const isModelNode = targetModel ? targetModel.nodes.some((n: any) => n.id === nodeId) : false;

            if (isVpNode || isModelNode) {
                if (nodeId.startsWith('virtual-viewport-')) {
                    const modelId = nodeId.substring('virtual-viewport-'.length);
                    if (this.virtualNodes[modelId]) {
                        Object.assign(this.virtualNodes[modelId].parameters, parameters);
                    }
                }

                const workerData: any = {};
                const p = parameters;

                // 1. Layer Visibility & Visual Switches
                if (p.showMPMParticles !== undefined) workerData.showMPMParticles = p.showMPMParticles;
                if (p.showFEMMesh !== undefined) workerData.showFEMMesh = p.showFEMMesh;
                if (p.femSolid !== undefined) workerData.femSolid = p.femSolid;
                if (p.femWireframe !== undefined) workerData.femWireframe = p.femWireframe;
                if (p.femLighting !== undefined) workerData.femLighting = p.femLighting;
                if (p.femOpacity !== undefined) workerData.femOpacity = Number(p.femOpacity);
                if (p.femQuantity !== undefined) workerData.femQuantity = p.femQuantity;
                if (p.femColormap !== undefined) workerData.femColormap = p.femColormap;
                if (p.femAutoScale !== undefined) workerData.femAutoScale = p.femAutoScale;
                if (p.femLogScale !== undefined) workerData.femLogScale = p.femLogScale;
                if (p.femMinVal !== undefined) workerData.femMinVal = Number(p.femMinVal);
                if (p.femMaxVal !== undefined) workerData.femMaxVal = Number(p.femMaxVal);

                if (p.showBeams !== undefined) workerData.showBeams = p.showBeams;
                if (p.beamSolid !== undefined) workerData.beamSolid = p.beamSolid;
                if (p.beamWireframe !== undefined) workerData.beamWireframe = p.beamWireframe;
                if (p.beamRadius !== undefined) workerData.beamRadius = Number(p.beamRadius);
                if (p.beamQuantity !== undefined) workerData.beamQuantity = p.beamQuantity;
                if (p.beamColormap !== undefined) workerData.beamColormap = p.beamColormap;
                if (p.beamAutoScale !== undefined) workerData.beamAutoScale = p.beamAutoScale;
                if (p.beamLogScale !== undefined) workerData.beamLogScale = p.beamLogScale;
                if (p.beamMinVal !== undefined) workerData.beamMinVal = Number(p.beamMinVal);
                if (p.beamMaxVal !== undefined) workerData.beamMaxVal = Number(p.beamMaxVal);
                if (p.beamOpacity !== undefined) workerData.beamOpacity = Number(p.beamOpacity);

                if (p.showRebar !== undefined) workerData.showRebar = p.showRebar;
                if (p.rebarSolid !== undefined) workerData.rebarSolid = p.rebarSolid;
                if (p.rebarWireframe !== undefined) workerData.rebarWireframe = p.rebarWireframe;
                if (p.rebarRadius !== undefined) workerData.rebarRadius = Number(p.rebarRadius);
                if (p.rebarOpacity !== undefined) workerData.rebarOpacity = Number(p.rebarOpacity);

                if (p.show_stl !== undefined) workerData.showSTL = p.show_stl;
                if (p.showSTL !== undefined) workerData.showSTL = p.showSTL;
                if (p.stl_solids !== undefined) workerData.stlSolids = p.stl_solids;
                if (p.stlSolids !== undefined) workerData.stlSolids = p.stlSolids;
                if (p.stl_wireframe !== undefined) workerData.stlWireframe = p.stl_wireframe;
                if (p.stlWireframe !== undefined) workerData.stlWireframe = p.stlWireframe;
                if (p.stl_lighting !== undefined) workerData.stlLighting = p.stl_lighting;
                if (p.stlLighting !== undefined) workerData.stlLighting = p.stlLighting;
                if (p.stl_colormap !== undefined) workerData.stlColormap = p.stl_colormap;
                if (p.stlColormap !== undefined) workerData.stlColormap = p.stlColormap;
                if (p.stl_opacity !== undefined) workerData.stlOpacity = Number(p.stl_opacity);
                if (p.stlOpacity !== undefined) workerData.stlOpacity = Number(p.stlOpacity);
                if (p.stl_show_results !== undefined) workerData.stlShowResults = p.stl_show_results;
                if (p.stlShowResults !== undefined) workerData.stlShowResults = p.stlShowResults;
                if (p.stl_quantity !== undefined) workerData.stlQuantity = p.stl_quantity;
                if (p.stlQuantity !== undefined) workerData.stlQuantity = p.stlQuantity;
                if (p.stl_auto_scale !== undefined) workerData.stlAutoScale = p.stl_auto_scale;
                if (p.stl_log_scale !== undefined) workerData.stlLogScale = p.stl_log_scale;
                if (p.stl_min_val !== undefined) workerData.stlMinVal = Number(p.stl_min_val);
                if (p.stl_max_val !== undefined) workerData.stlMaxVal = Number(p.stl_max_val);

                if (p.show_obstacles !== undefined) workerData.showObstacles = p.show_obstacles;
                if (p.showObstacles !== undefined) workerData.showObstacles = p.showObstacles;
                if (p.obstacles_solid !== undefined) workerData.obstaclesSolid = p.obstacles_solid;
                if (p.obstaclesSolid !== undefined) workerData.obstaclesSolid = p.obstaclesSolid;
                if (p.obstacles_gridlines !== undefined) workerData.obstaclesGridlines = p.obstacles_gridlines;
                if (p.obstaclesGridlines !== undefined) workerData.obstaclesGridlines = p.obstaclesGridlines;
                if (p.obstacles_lighting !== undefined) workerData.obstaclesLighting = p.obstacles_lighting;
                if (p.obstaclesLighting !== undefined) workerData.obstaclesLighting = p.obstaclesLighting;
                if (p.obstacles_colormap !== undefined) workerData.obstaclesColormap = p.obstacles_colormap;
                if (p.obstacles_opacity !== undefined) workerData.obstaclesOpacity = Number(p.obstacles_opacity);
                if (p.obstacles_quantity !== undefined) workerData.obstaclesQuantity = p.obstacles_quantity;
                if (p.obstacles_auto_scale !== undefined) workerData.obstaclesAutoScale = p.obstacles_auto_scale;
                if (p.obstacles_log_scale !== undefined) workerData.obstaclesLogScale = p.obstacles_log_scale;
                if (p.obstacles_min_val !== undefined) workerData.obstaclesMinVal = Number(p.obstacles_min_val);
                if (p.obstacles_max_val !== undefined) workerData.obstaclesMaxVal = Number(p.obstacles_max_val);

                if (p.show_charge !== undefined) workerData.showCharge = p.show_charge;
                if (p.showCharge !== undefined) workerData.showCharge = p.showCharge;
                if (p.charge_solid !== undefined) workerData.chargeSolid = p.charge_solid;
                if (p.chargeSolid !== undefined) workerData.chargeSolid = p.chargeSolid;
                if (p.charge_wireframe !== undefined) workerData.chargeWireframe = p.charge_wireframe;
                if (p.chargeWireframe !== undefined) workerData.chargeWireframe = p.chargeWireframe;
                if (p.charge_lighting !== undefined) workerData.chargeLighting = p.charge_lighting;
                if (p.chargeLighting !== undefined) workerData.chargeLighting = p.chargeLighting;
                if (p.charge_opacity !== undefined) workerData.chargeOpacity = Number(p.charge_opacity);
                if (p.chargeOpacity !== undefined) workerData.chargeOpacity = Number(p.chargeOpacity);
                if (p.charge_color !== undefined) workerData.chargeColor = p.charge_color;
                if (p.chargeColor !== undefined) workerData.chargeColor = p.chargeColor;

                if (p.show_detonators !== undefined || p.show_detonator !== undefined) workerData.showDetonators = (p.show_detonators ?? p.show_detonator) !== false;
                if (p.detonatorSolid !== undefined || p.detonator_solid !== undefined) workerData.detonatorSolid = (p.detonatorSolid ?? p.detonator_solid) !== false;
                if (p.detonatorWireframe !== undefined || p.detonator_wireframe !== undefined) workerData.detonatorWireframe = (p.detonatorWireframe ?? p.detonator_wireframe) !== false;
                if (p.detonatorLighting !== undefined || p.detonator_lighting !== undefined) workerData.detonatorLighting = (p.detonatorLighting ?? p.detonator_lighting) !== false;
                if (p.detonatorSize !== undefined || p.detonator_size !== undefined) workerData.detonatorSize = Number(p.detonatorSize ?? p.detonator_size);
                if (p.detonatorOpacity !== undefined || p.detonator_opacity !== undefined) workerData.detonatorOpacity = Number(p.detonatorOpacity ?? p.detonator_opacity);

                if (p.show_grid !== undefined) workerData.showGrid = p.show_grid;
                if (p.showGrid !== undefined) workerData.showGrid = p.showGrid;
                if (p.show_grid_box !== undefined) workerData.showGridBox = p.show_grid_box;
                if (p.showGridBox !== undefined) workerData.showGridBox = p.showGridBox;
                if (p.grid_opacity !== undefined) workerData.gridOpacity = Number(p.grid_opacity);
                if (p.gridOpacity !== undefined) workerData.gridOpacity = Number(p.gridOpacity);
                if (p.grid_meshlines !== undefined) workerData.gridMeshlines = p.grid_meshlines;

                if (p.show_gauges !== undefined) workerData.showGauges = p.show_gauges;
                if (p.showGauges !== undefined) workerData.showGauges = p.showGauges;
                if (p.gauge_solid !== undefined || p.gaugeSolid !== undefined) workerData.gaugeSolid = p.gauge_solid ?? p.gaugeSolid;
                if (p.gauge_size !== undefined || p.gaugeSize !== undefined) workerData.gaugeSize = Number(p.gauge_size ?? p.gaugeSize);
                if (p.gauge_opacity !== undefined || p.gaugeOpacity !== undefined) workerData.gaugeOpacity = Number(p.gauge_opacity ?? p.gaugeOpacity);
                if (p.gauge_quantity !== undefined || p.gaugeQuantity !== undefined) workerData.gaugeQuantity = p.gauge_quantity ?? p.gaugeQuantity;

                if (p.lightingEnabled !== undefined) workerData.lightingEnabled = p.lightingEnabled;
                if (p.aoEnabled !== undefined) workerData.aoEnabled = p.aoEnabled;
                if (p.aoRadius !== undefined) workerData.aoRadius = Number(p.aoRadius);
                if (p.aoIntensity !== undefined) workerData.aoIntensity = Number(p.aoIntensity);
                if (p.aoBias !== undefined) workerData.aoBias = Number(p.aoBias);
                if (p.aoSphereImpostor !== undefined) workerData.aoSphereImpostor = p.aoSphereImpostor;

                if (p.mpmParticleDiameter !== undefined) workerData.mpmParticleDiameter = Number(p.mpmParticleDiameter);
                if (p.mpmParticleSize !== undefined) workerData.mpmParticleSize = Number(p.mpmParticleSize);
                if (p.mpmParticleOpacity !== undefined) workerData.mpmParticleOpacity = Number(p.mpmParticleOpacity);
                if (p.mpmParticleQuantity !== undefined) workerData.mpmParticleQuantity = p.mpmParticleQuantity;
                if (p.mpmParticleColormap !== undefined) workerData.mpmParticleColormap = p.mpmParticleColormap;
                if (p.mpmParticleAutoScale !== undefined) workerData.mpmParticleAutoScale = p.mpmParticleAutoScale;
                if (p.mpmParticleLogScale !== undefined) workerData.mpmParticleLogScale = p.mpmParticleLogScale;
                if (p.mpmParticleMinVal !== undefined) workerData.mpmParticleMinVal = Number(p.mpmParticleMinVal);
                if (p.mpmParticleMaxVal !== undefined) workerData.mpmParticleMaxVal = Number(p.mpmParticleMaxVal);

                if (p.show_slices !== undefined) workerData.showSlices = p.show_slices;
                if (p.showSlices !== undefined) workerData.showSlices = p.showSlices;
                if (p.slices !== undefined) {
                    workerData.slices = p.slices;
                    this.updateSlices(p.slices);
                }

                if (p.colormap !== undefined) workerData.colormap = p.colormap;
                if (p.quantity !== undefined) workerData.focusedQuantity = p.quantity;
                if (p.focusedQuantity !== undefined) workerData.focusedQuantity = p.focusedQuantity;
                if (p.min_val !== undefined && p.max_val !== undefined) {
                    workerData.minVal = Number(p.min_val);
                    workerData.maxVal = Number(p.max_val);
                }

                // Check for charge or MPM geometry updates
                const changedNode = targetModel?.nodes.find((n: any) => n.id === nodeId);
                if (changedNode) {
                    if (['Charge3D', 'Charge2D', 'ExplosiveMaterial'].includes(changedNode.type)) {
                        workerData.charge = {
                            shape: changedNode.parameters.charge_shape || 'Sphere',
                            x: Number(changedNode.parameters.x ?? changedNode.parameters.charge_x ?? 0.0),
                            y: Number(changedNode.parameters.y ?? changedNode.parameters.charge_y ?? 0.0),
                            z: Number(changedNode.parameters.z ?? changedNode.parameters.charge_z ?? 0.0),
                            radius: Number(changedNode.parameters.radius ?? changedNode.parameters.charge_radius ?? 0.1),
                            lx: Number(changedNode.parameters.lx ?? changedNode.parameters.charge_lx ?? 0.2),
                            ly: Number(changedNode.parameters.ly ?? changedNode.parameters.charge_ly ?? 0.2),
                            lz: Number(changedNode.parameters.lz ?? changedNode.parameters.charge_lz ?? 0.2),
                            rot_x: Number(changedNode.parameters.rot_x ?? changedNode.parameters.charge_rot_x ?? 0.0),
                            rot_y: Number(changedNode.parameters.rot_y ?? changedNode.parameters.charge_rot_y ?? 0.0),
                            rot_z: Number(changedNode.parameters.rot_z ?? changedNode.parameters.charge_rot_z ?? 0.0)
                        };
                    } else if (['MPMObject3D'].includes(changedNode.type)) {
                        const mpmNodes = targetModel?.nodes.filter((n: any) => n.type === 'MPMObject3D') || [];
                        workerData.mpmObjects = mpmNodes.map((n: any) => ({
                            shape_type: n.parameters.shape_type || 'Box',
                            pos_x: Number(n.parameters.pos_x ?? 0.0),
                            pos_y: Number(n.parameters.pos_y ?? 0.0),
                            pos_z: Number(n.parameters.pos_z ?? 0.0),
                            size_x: Number(n.parameters.size_x ?? 0.2),
                            size_y: Number(n.parameters.size_y ?? 0.2),
                            size_z: Number(n.parameters.size_z ?? 0.2),
                            radius: Number(n.parameters.radius ?? 0.1),
                            inner_radius: Number(n.parameters.inner_radius ?? 0.0),
                            scale_x: Number(n.parameters.scale_x ?? 1.0),
                            scale_y: Number(n.parameters.scale_y ?? 1.0),
                            scale_z: Number(n.parameters.scale_z ?? 1.0)
                        }));
                    }
                }

                if (Object.keys(workerData).length > 0) {
                    this.worker.postMessage({ type: 'setConfig', data: workerData });
                }
                this.requestColorbarUpdate();
                this.syncControls(true);
            }
        });

        // Container relative positioning & focusable setup
        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';
        this.container.tabIndex = 0;
        this.container.classList.add('viewport-3d-container');

        const handleFocus = () => {
            this.stateManager.setFocusedViewport(this.viewportNodeId, this.panelId);
        };
        this.container.addEventListener('pointerdown', handleFocus, { passive: true });
        this.container.addEventListener('focus', handleFocus, { passive: true });
        this.container.addEventListener('click', handleFocus, { passive: true });

        const updateFocusDisplay = (focusedVpId: string | null, focusedPanelId: string | null) => {
            const isFocused = (focusedPanelId && focusedPanelId === this.panelId) || 
                              (focusedVpId && this.viewportNodeId && (focusedVpId === this.viewportNodeId || focusedVpId === `virtual-viewport-${this.viewportNodeId}`));
            if (isFocused) {
                this.container.classList.add('viewport-focused');
            } else {
                this.container.classList.remove('viewport-focused');
            }
        };
        this.stateManager.onFocusedViewportChange(updateFocusDisplay);

        // Initial focus registration if not set
        if (!this.stateManager.getFocusedViewportId()) {
            this.stateManager.setFocusedViewport(this.viewportNodeId, this.panelId);
        }

        // Camera keyboard hotkeys when this viewport is in focus
        this.container.addEventListener('keydown', (e: KeyboardEvent) => {
            if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;

            if (e.key === 't' || e.key === 'T') {
                e.preventDefault();
                this.alignCamera('top');
                this.showCameraToast('Camera: Top View (+Z)');
            } else if (e.key === 'f' || e.key === 'F') {
                e.preventDefault();
                this.alignCamera('front');
                this.showCameraToast('Camera: Front View (-Y)');
            } else if (e.key === 'r' || e.key === 'R') {
                e.preventDefault();
                this.snapCameraPreset('reset');
                this.showCameraToast('Camera: Reset View');
            } else if (e.key === 's' || e.key === 'S') {
                e.preventDefault();
                this.alignCamera('right');
                this.showCameraToast('Camera: Side View (+X)');
            } else if (e.key === 'o' || e.key === 'O') {
                e.preventDefault();
                this.setProjection(!this.usePerspective);
                this.showCameraToast(`Projection: ${this.usePerspective ? 'Perspective' : 'Orthographic'}`);
            }
        });

        this.canvas = document.createElement('canvas');
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        this.container.appendChild(this.canvas);

        this.overlayCanvas = document.createElement('canvas');
        this.overlayCanvas.style.position = 'absolute';
        this.overlayCanvas.style.top = '0';
        this.overlayCanvas.style.left = '0';
        this.overlayCanvas.style.width = '100%';
        this.overlayCanvas.style.height = '100%';
        this.overlayCanvas.style.pointerEvents = 'none';
        this.overlayCanvas.style.zIndex = '5';
        this.container.appendChild(this.overlayCanvas);

        this.worker = new Worker(new URL('./ViewportWorker.ts?t=' + Date.now(), import.meta.url), { type: 'module' });

        this.worker.onmessage = (e) => {
            const { type, renderer, min, max } = e.data;
            if (type === 'renderFrame' || type === 'frameComplete' || type === 'error') {
                if (this.workerTimer) {
                    clearTimeout(this.workerTimer);
                    this.workerTimer = null;
                }
                this.isWorkerBusy = false;
                if (type === 'renderFrame') {
                    this.latestFrameData = e.data.data;
                }
                if (type === 'error') {
                    console.error("[ViewportWorker Error]", e.data.message);
                    const badge = document.getElementById(this.getElId('viewport-renderer-badge'));
                    if (badge) {
                        badge.innerHTML = 'ERROR';
                        badge.style.color = '#ff3333';
                        badge.style.background = 'rgba(255, 51, 51, 0.2)';
                    }
                    if (this.debugOverlay) {
                        this.debugOverlay.style.color = '#ff3333';
                        this.debugOverlay.innerHTML = `WORKER ERROR: ${e.data.message}`;
                    }
                }
                this.drainNextPendingFrame();
            } else if (type === 'rendererInfo') {
                const badge = document.getElementById(this.getElId('viewport-renderer-badge'));
                if (badge) {
                    badge.innerHTML = renderer;
                    if (renderer === 'WebGPU') {
                        badge.style.color = '#00ff66';
                        badge.style.background = 'rgba(0, 255, 102, 0.1)';
                    } else if (renderer.startsWith('WebGL')) {
                        badge.style.color = '#00adff';
                        badge.style.background = 'rgba(0, 173, 255, 0.1)';
                    } else {
                        badge.style.color = '#ffaa00';
                        badge.style.background = 'rgba(255, 170, 0, 0.1)';
                    }
                }
                if (this.debugOverlay) {
                    this.debugOverlay.style.color = '#00ff66';
                    this.debugOverlay.innerHTML = `Renderer: ${renderer} Active`;
                }
                const currentModelId = this.getCurrentModelId();
                if (currentModelId) {
                    const activeView = this.stateManager.getModelActiveView(currentModelId);
                    if (activeView) {
                        (this as any).applyModelView(activeView);
                    }
                }
            } else if (type === 'cameraChanged') {
                const cam = e.data.data;
                if (cam) {
                    const modelId = this.getCurrentModelId();
                    if (modelId) {
                        this.stateManager.updateModelActiveViewCamera(modelId, {
                            pitch: cam.pitch,
                            yaw: cam.yaw,
                            distance: cam.distance,
                            target: [cam.targetX, cam.targetY, cam.targetZ],
                            usePerspective: cam.usePerspective,
                            fov: cam.fov
                        });
                    }
                    const vpNode = this.getViewportNode();
                    if (vpNode && vpNode.id && !vpNode.id.startsWith('virtual-viewport-')) {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, {
                            camera_pitch: cam.pitch,
                            camera_yaw: cam.yaw,
                            camera_distance: cam.distance,
                            target_x: cam.targetX,
                            target_y: cam.targetY,
                            target_z: cam.targetZ,
                            camera_fov: cam.fov
                        });
                    }
                }
            } else if (type === 'log') {
                console.log("[ViewportWorker Log]", e.data.message);
            } else if (type === 'rangeUpdated') {
                const vpNode = this.getViewportNode();
                if (vpNode) {
                    const { index, min, max } = e.data;
                    if (index !== undefined) {
                        const slices = vpNode.parameters.slices ? [...vpNode.parameters.slices] : [];
                        if (slices[index]) {
                            const updates = {
                                auto_scale: false,
                                min_val: min,
                                max_val: max
                            };
                            slices[index] = {
                                ...slices[index],
                                ...updates
                            };
                            this.propagateSliceQuantitySettings(slices, index, updates);
                            this.updateSlices(slices);
                        }
                    } else {
                        const { quantity: focusedQty } = getFocusedQuantityAndRange(vpNode);
                        const ranges = { ...(vpNode.parameters.quantity_ranges || {}) };
                        ranges[focusedQty] = [min, max];
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, {
                            auto_scale: false,
                            quantity_ranges: ranges,
                            min_val: min,
                            max_val: max
                        });
                    }
                }
            } else if (type === 'quantityRangesUpdated') {
                this.latestQuantityRanges = e.data.ranges || {};
                this.requestColorbarUpdate();
            } else if (type === 'sliceRanges') {
                this.latestSliceRanges = e.data.ranges;
                this.requestColorbarUpdate();
            } else if (type === 'obstaclesRangeUpdated') {
                this.latestObstaclesRange = { min: e.data.min, max: e.data.max };
                this.requestColorbarUpdate();
            } else if (type === 'mpmParticleSpacingUpdated') {
                const { spacing } = e.data;
                if (spacing && spacing > 0) {
                    this.latestEmpiricalSpacing = spacing;
                }
            } else if (type === 'mpmRangeUpdated') {
                this.latestMPMRange = { min: e.data.min, max: e.data.max };
                this.requestColorbarUpdate();
            } else if (type === 'femRangeUpdated') {
                this.latestFEMRange = { min: e.data.min, max: e.data.max };
                this.requestColorbarUpdate();
            } else if (type === 'beamRangeUpdated') {
                this.latestBeamRange = { min: e.data.min, max: e.data.max };
                this.requestColorbarUpdate();
            } else if (type === 'stlRangeUpdated') {
                this.latestSTLRange = { min: e.data.min, max: e.data.max };
                this.requestColorbarUpdate();
            } else if (type === 'currentRange') {
                const { min, max } = e.data;
                this.latestEmpiricalRange = { min, max };
                const rangeLabel = document.getElementById(this.getElId('viewport-current-range'));
                if (rangeLabel) {
                    rangeLabel.textContent = `Current: [${this.formatRangeValue(min)}, ${this.formatRangeValue(max)}]`;
                }
            } else if (type === 'objectPicked') {
                this.handleObjectPicked(e.data.data);
            } else if (type === 'rotationCenterSet') {
                const label = e.data.data?.label || 'Selected Point';
                this.showCameraToast(`Rotation Pivot: ${label}`);
            } else if (type === 'objectHovered') {
                this.handleObjectHovered(e.data.data);
            }
        };

        this.initInteraction();

        // Bi-directional selection synchronization with StateManager
        this.stateManager.onSelectionChange((nodeId) => {
            if (!nodeId) {
                this.worker.postMessage({ type: 'setSelectedObject', data: null });
                return;
            }
            const targetModel = this.getTargetModel();
            const node = targetModel?.nodes?.find((n: any) => n.id === nodeId);
            if (node) {
                if (node.type === 'Telemetry3DViewport' || node.type === 'DomainMesh3D' || node.type === 'DomainMesh' || node.type === 'CFDSolver3D' || node.type === 'CFDSolver' || node.type === 'CFDSolver2D') {
                    const sliceIdx = this.stateManager.getSelectedSliceIndex();
                    if (sliceIdx !== null && sliceIdx !== undefined) {
                        const slices = this.getSlices();
                        const slice = slices[sliceIdx];
                        const axisStr = slice ? ` (${getSliceAxisLabel(slice.axis)})` : '';
                        const selLabel = `Slice #${sliceIdx}${axisStr}`;
                        this.worker.postMessage({
                            type: 'setSelectedObject',
                            data: { objectType: 'Slice', sliceIndex: sliceIdx, label: selLabel }
                        });
                    } else {
                        this.worker.postMessage({ type: 'setSelectedObject', data: null });
                    }
                } else {
                    const objData = this.extractObjectGeometryData(node);
                    this.worker.postMessage({
                        type: 'setSelectedObject',
                        data: objData
                    });
                }
            }
        });

        this.stateManager.onSliceSelectionChange((sliceIdx) => {
            if (sliceIdx !== null && sliceIdx !== undefined) {
                const slices = this.getSlices();
                const slice = slices[sliceIdx];
                const axisStr = slice ? ` (${getSliceAxisLabel(slice.axis)})` : '';
                const selLabel = `Slice #${sliceIdx}${axisStr}`;
                this.worker.postMessage({
                    type: 'setSelectedObject',
                    data: {
                        objectType: 'Slice',
                        sliceIndex: sliceIdx,
                        label: selLabel
                    }
                });
                const chip = this.getOrCreateHudChip();
                chip.textContent = `🎯 ${selLabel}`;
                chip.classList.add('is-selected');
                chip.style.opacity = '1';
                chip.style.transform = 'translateY(0)';
            }
        });

        this.stateManager.onHoverChange((nodeId, sliceIdx) => {
            if (!nodeId && (sliceIdx === null || sliceIdx === undefined)) {
                this.worker.postMessage({ type: 'setHoveredObject', data: null });
                return;
            }
            const targetModel = this.getTargetModel();
            const node = targetModel?.nodes?.find((n: any) => n.id === nodeId);
            if (node) {
                if (node.type === 'Telemetry3DViewport' && sliceIdx !== null && sliceIdx !== undefined) {
                    this.worker.postMessage({
                        type: 'setHoveredObject',
                        data: { objectType: 'Slice', sliceIndex: sliceIdx, label: `Slice #${sliceIdx}` }
                    });
                } else {
                    const objData = this.extractObjectGeometryData(node);
                    if (objData) {
                        objData.sliceIndex = sliceIdx ?? undefined;
                    }
                    this.worker.postMessage({
                        type: 'setHoveredObject',
                        data: objData
                    });
                }
            } else if (sliceIdx !== null && sliceIdx !== undefined) {
                this.worker.postMessage({
                    type: 'setHoveredObject',
                    data: { objectType: 'Slice', sliceIndex: sliceIdx, label: `Slice #${sliceIdx}` }
                });
            }
        });

        const rect = this.container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        // @ts-ignore
        const offscreen = this.canvas.transferControlToOffscreen();
        // @ts-ignore
        const offscreenOverlay = this.overlayCanvas ? this.overlayCanvas.transferControlToOffscreen() : null;
        const transferList = offscreenOverlay ? [offscreen, offscreenOverlay] : [offscreen];
        this.worker.postMessage({
            type: 'init',
            data: {
                canvas: offscreen,
                overlayCanvas: offscreenOverlay,
                width: (rect.width || 800) * dpr,
                height: (rect.height || 600) * dpr,
                dpr
            }
        }, transferList);

        // Diagnostic Overlay for STL Loading
        this.debugOverlay = document.createElement('div');
        this.debugOverlay.id = `viewport-debug-stl-${this.panelId}`;
        this.debugOverlay.style.position = 'absolute';
        this.debugOverlay.style.bottom = '10px';
        this.debugOverlay.style.left = '50%';
        this.debugOverlay.style.transform = 'translateX(-50%)';
        this.debugOverlay.style.color = '#ffaa00';
        this.debugOverlay.style.background = 'rgba(16, 16, 19, 0.82)';
        this.debugOverlay.style.backdropFilter = 'blur(12px)';
        this.debugOverlay.style.border = '1px solid rgba(255, 255, 255, 0.12)';
        this.debugOverlay.style.padding = '4px 8px';
        this.debugOverlay.style.borderRadius = '4px';
        this.debugOverlay.style.fontSize = '10px';
        this.debugOverlay.style.fontFamily = 'monospace';
        this.debugOverlay.style.pointerEvents = 'none';
        this.debugOverlay.style.zIndex = '100';
        this.debugOverlay.style.whiteSpace = 'nowrap';
        this.debugOverlay.innerHTML = 'STL Status: Initializing...';
        this.container.appendChild(this.debugOverlay);

        this.resizeObserver = new ResizeObserver(entries => {
            for (let entry of entries) {
                const dpr = window.devicePixelRatio || 1;
                if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
                    this.worker.postMessage({
                        type: 'resize',
                        data: {
                            width: entry.contentRect.width * dpr,
                            height: entry.contentRect.height * dpr,
                            dpr
                        }
                    });
                }
            }
        });
        this.resizeObserver.observe(this.container);

        requestAnimationFrame(this.triggerResize);
        setTimeout(this.triggerResize, 100);
        setTimeout(this.triggerResize, 500);

        const net = (window as any).networkManager;
        if (net) {
            this.openListener = () => {
                // Force geometry re-request on every new broker connection
                this.currentGeometryHash = null;
                this.currentSTLPath = null;
                this.syncControls();
            };
            net.onOpen(this.openListener);

            this.netCallback = (data: string | ArrayBuffer) => {
                if (typeof data === 'string') {
                    try {
                        const msg = JSON.parse(data);
                        if (msg.type === 'load_stl_response') {
                            // Check model ID if we have a definite binding, otherwise accept all
                            const myModelId = this.getCurrentModelId();
                            if (msg.modelId && myModelId && msg.modelId !== myModelId) return;
                            if (msg.status === 'success' && msg.vertices) {
                                if (this.debugOverlay) {
                                    this.debugOverlay.innerHTML = `Load: OK (${(msg.vertices.length / 3).toFixed(0)} verts from model ${msg.modelId})`;
                                }
                                const verts = new Float32Array(msg.vertices);
                                const flags = msg.subtractive_flags ? new Float32Array(msg.subtractive_flags) : null;
                                this.worker.postMessage({
                                    type: 'setSTLGeometry',
                                    data: { vertices: verts, subtractive_flags: flags }
                                });
                            } else {
                                if (this.debugOverlay) {
                                    this.debugOverlay.innerHTML = `Load: ERROR (${msg.error})`;
                                }
                                console.error("[Viewport] Failed to load geometry:", msg.error);
                            }
                        } else if (msg.type === 'obstacles_mesh') {
                            const myModelId = this.getCurrentModelId();
                            if (msg.modelId && myModelId && msg.modelId !== myModelId) return;
                            if (msg.vertices && msg.cells) {
                                const verts = new Float32Array(msg.vertices);
                                const cells = new Int32Array(msg.cells);
                                this.worker.postMessage({
                                    type: 'setObstaclesGeometry',
                                    data: { vertices: verts, cells: cells }
                                });
                            }
                        }
                    } catch (e) {}
                }
            };
            net.onMessage(this.netCallback);
        }

        const cachedConfig = this.stateManager.getTelemetry(this.panelId + "-config-3d");
        if (cachedConfig) {
            this.updateTelemetry(cachedConfig);
        }

        this.stateListener = () => this.syncControls();
        this.stateManager.onStateChange(this.stateListener);

        this.modelStatusListener = (modelId: string, status: any) => {
            if (status === 'PAUSED' || status === 'INITIALIZED' || status === 'TERMINATED') {
                if (this.workerTimer) {
                    clearTimeout(this.workerTimer);
                    this.workerTimer = null;
                }
                this.isWorkerBusy = false;
                this.drainNextPendingFrame();
            }
        };
        this.stateManager.onModelStatusChange(this.modelStatusListener);
        this.syncControls();
    }

    private initInteraction() {
        let isDragging = false;
        let dragMode: 'orbit' | 'pan' = 'orbit';
        let lastX = 0;
        let lastY = 0;
        let downX = 0;
        let downY = 0;
        let downTime = 0;
        let downButton = 0;

        let pendingInputRaf: number | null = null;
        let pendingDy = 0;
        let pendingDpx = 0;
        let pendingDpy = 0;
        let pendingDrx = 0;
        let pendingDry = 0;

        const flushInput = () => {
            pendingInputRaf = null;
            if (pendingDy === 0 && pendingDpx === 0 && pendingDpy === 0 && pendingDrx === 0 && pendingDry === 0) {
                return;
            }
            const data: any = {};
            if (pendingDy !== 0) {
                data.dy = pendingDy;
                pendingDy = 0;
            }
            if (pendingDpx !== 0 || pendingDpy !== 0) {
                data.dpx = pendingDpx;
                data.dpy = pendingDpy;
                pendingDpx = 0;
                pendingDpy = 0;
            }
            if (pendingDrx !== 0 || pendingDry !== 0) {
                data.drx = pendingDrx;
                data.dry = pendingDry;
                pendingDrx = 0;
                pendingDry = 0;
            }
            this.worker.postMessage({ type: 'input', data });
        };

        const scheduleFlushInput = () => {
            if (pendingInputRaf === null) {
                pendingInputRaf = requestAnimationFrame(flushInput);
            }
        };

        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });

        this.canvas.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            downX = e.clientX;
            downY = e.clientY;
            downTime = performance.now();
            downButton = e.button;

            if (e.button === 0 && e.ctrlKey) {
                const rect = this.canvas.getBoundingClientRect();
                const dpr = window.devicePixelRatio || 1;
                const mouseX = (e.clientX - rect.left) * dpr;
                const mouseY = (e.clientY - rect.top) * dpr;
                this.worker.postMessage({
                    type: 'setRotationCenterFromClick',
                    data: { mouseX, mouseY, screenX: e.clientX, screenY: e.clientY }
                });
                return;
            }
            isDragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            if (e.button === 2 || e.shiftKey || e.button === 1) {
                dragMode = 'pan';
            } else {
                dragMode = 'orbit';
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            
            if (dragMode === 'pan') {
                pendingDpx += dx;
                pendingDpy += dy;
            } else {
                pendingDrx += dy;
                pendingDry += dx;
            }
            scheduleFlushInput();
        });

        window.addEventListener('mouseup', (e) => {
            if (isDragging) {
                isDragging = false;
                if (pendingInputRaf !== null) {
                    cancelAnimationFrame(pendingInputRaf);
                    flushInput();
                }
                const dist = Math.hypot(e.clientX - downX, e.clientY - downY);
                const dt = performance.now() - downTime;
                // If short click with minimal motion (< 14px, < 800ms)
                if (dist < 14 && dt < 800) {
                    const rect = this.canvas.getBoundingClientRect();
                    const dpr = window.devicePixelRatio || 1;
                    const mouseX = (e.clientX - rect.left) * dpr;
                    const mouseY = (e.clientY - rect.top) * dpr;
                    this.worker.postMessage({
                        type: 'pickObject',
                        data: {
                            mouseX,
                            mouseY,
                            button: downButton,
                            screenX: e.clientX,
                            screenY: e.clientY
                        }
                    });
                }
            }
        });

        let hoverRafId: number | null = null;
        let lastHoverClientX = -9999;
        let lastHoverClientY = -9999;
        this.canvas.addEventListener('mousemove', (e) => {
            if (isDragging) return;
            if (Math.abs(e.clientX - lastHoverClientX) < 2 && Math.abs(e.clientY - lastHoverClientY) < 2) return;
            lastHoverClientX = e.clientX;
            lastHoverClientY = e.clientY;

            if (hoverRafId !== null) return;
            hoverRafId = requestAnimationFrame(() => {
                hoverRafId = null;
                const rect = this.canvas.getBoundingClientRect();
                const dpr = window.devicePixelRatio || 1;
                const mouseX = (e.clientX - rect.left) * dpr;
                const mouseY = (e.clientY - rect.top) * dpr;
                this.worker.postMessage({
                    type: 'hoverObject',
                    data: {
                        mouseX,
                        mouseY,
                        screenX: e.clientX,
                        screenY: e.clientY
                    }
                });
            });
        });

        this.canvas.addEventListener('mouseleave', () => {
            if (hoverRafId !== null) {
                cancelAnimationFrame(hoverRafId);
                hoverRafId = null;
            }
            this.worker.postMessage({
                type: 'hoverObject',
                data: { clear: true }
            });
            this.hideHoverBadge();
        });

        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            pendingDy += e.deltaY;
            scheduleFlushInput();
        }, { passive: false });
    }

    private hudChipEl: HTMLDivElement | null = null;

    private getOrCreateHudChip(): HTMLDivElement {
        if (!this.hudChipEl) {
            this.hudChipEl = document.createElement('div');
            this.hudChipEl.className = 'viewport-object-hud-chip';
            if (this.container) {
                this.container.appendChild(this.hudChipEl);
            } else {
                document.body.appendChild(this.hudChipEl);
            }
        }
        return this.hudChipEl;
    }

    private showHoverBadge(label: string): void {
        const chip = this.getOrCreateHudChip();
        chip.textContent = `🔍 ${label}`;
        chip.classList.remove('is-selected');
        chip.style.opacity = '1';
        chip.style.transform = 'translateY(0)';
    }

    private hideHoverBadge(): void {
        if (this.hudChipEl) {
            this.hudChipEl.style.opacity = '0';
            this.hudChipEl.style.transform = 'translateY(-4px)';
        }
    }

    private handleObjectHovered(data: any) {
        if (data && data.hit) {
            this.canvas.style.cursor = 'pointer';
            this.showHoverBadge(data.label || data.objectType);
        } else {
            this.canvas.style.cursor = 'default';
            this.hideHoverBadge();
        }
    }

    private showCameraToast(text: string): void {
        document.querySelectorAll('.viewport-pick-toast').forEach(el => el.remove());
        const toast = document.createElement('div');
        toast.className = 'viewport-pick-toast';
        toast.textContent = text;

        if (this.container) {
            this.container.appendChild(toast);
        } else {
            document.body.appendChild(toast);
        }

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-6px)';
            setTimeout(() => toast.remove(), 350);
        }, 1200);
    }

    private handleObjectPicked(data: any) {
        if (!data) return;
        const { hit, objectType, objectId, sliceIndex, gaugeIndex, label, screenX, screenY, button } = data;

        if (button === 0) {
            // LEFT CLICK: Select & Focus DAG Node & Slice
            if (hit) {
                const targetModel = this.getTargetModel();
                let matchedNode: any = null;
                if (targetModel && targetModel.nodes) {
                    if (objectType === 'Slice') {
                        matchedNode = this.getSlicesCarrierNode() || this.getViewportNode();
                        const sIdx = sliceIndex ?? 0;
                        const slices = this.getSlices();
                        const slice = slices[sIdx];
                        const axisStr = slice ? ` (${getSliceAxisLabel(slice.axis)})` : '';
                        const sliceLabel = label || `Slice #${sIdx}${axisStr}`;
                        this.stateManager.setSelectedSliceIndex(sIdx);
                        const tc = (window as any).transportController;
                        if (tc) {
                            tc.setActiveSliceIndex?.(sIdx);
                            tc.setSelectedObject?.({
                                objectType: 'Slice',
                                sliceIndex: sIdx,
                                label: sliceLabel,
                                nodeId: matchedNode?.id
                            });
                        }
                    } else {
                        this.stateManager.setSelectedSliceIndex(null);
                        if (objectType === 'VirtualGauges3D') {
                            matchedNode = targetModel.nodes.find((n: any) => n.id === objectId) ||
                                          targetModel.nodes.find((n: any) => n.type === 'VirtualGauges3D' || n.type === 'VirtualGauge') || null;
                        } else if (objectType === 'Charge3D') {
                            matchedNode = targetModel.nodes.find((n: any) => n.id === objectId) ||
                                          targetModel.nodes.find((n: any) => n.type === 'Charge3D' || n.type === 'Charge2D' || n.type === 'ExplosiveMaterial') || null;
                        } else if (objectType === 'DetonatorLocation3D') {
                            matchedNode = targetModel.nodes.find((n: any) => n.id === objectId) ||
                                          targetModel.nodes.find((n: any) => n.type === 'DetonatorLocation3D' || n.type === 'DetonatorLocation') || null;
                        } else if (objectType === 'FEMObject3D') {
                            const femObjNodes = targetModel.nodes.filter((n: any) => n.type === 'FEMObject3D' || n.type === 'LSDynaImporter3D' || n.type === 'FEMBeam3D' || n.type === 'FEMRebar3D');
                            matchedNode = targetModel.nodes.find((n: any) => n.id === objectId) ||
                                          (objectId !== undefined && !isNaN(Number(objectId)) ? femObjNodes[Math.round(Number(objectId))] : null) ||
                                          femObjNodes[0] ||
                                          targetModel.nodes.find((n: any) => n.type === 'FEMDomain3D') || null;
                        } else if (objectType === 'MPMObject3D') {
                            const mpmObjNodes = targetModel.nodes.filter((n: any) => n.type === 'MPMObject3D');
                            matchedNode = targetModel.nodes.find((n: any) => n.id === objectId) ||
                                          (objectId !== undefined && !isNaN(Number(objectId)) ? mpmObjNodes[Math.round(Number(objectId))] : null) ||
                                          targetModel.nodes.find((n: any) => n.type === 'MPMObject3D' && String(n.parameters?.object_id) === String(objectId)) ||
                                          mpmObjNodes[0] ||
                                          targetModel.nodes.find((n: any) => n.type === 'MPMDomain3D') || null;
                        } else if (objectType === 'STLGeometry') {
                            matchedNode = targetModel.nodes.find((n: any) => n.id === objectId) ||
                                          targetModel.nodes.find((n: any) => n.type === 'STLGeometry') ||
                                          targetModel.nodes.find((n: any) => n.type === 'PrimitiveGeometry3D') || null;
                        } else if (objectType === 'PrimitiveGeometry3D' || objectType === 'Obstacle' || objectType === 'Obstacles' || objectType === 'Obstacle3D') {
                            matchedNode = targetModel.nodes.find((n: any) => n.id === objectId) ||
                                          targetModel.nodes.find((n: any) => n.type === 'PrimitiveGeometry3D' || n.type === 'Obstacle') ||
                                          targetModel.nodes.find((n: any) => n.type === 'STLGeometry') ||
                                          targetModel.nodes.find((n: any) => n.type === 'CFDSolver3D') ||
                                          this.getViewportNode() || null;
                        } else if (objectType === 'DomainMesh3D') {
                            matchedNode = targetModel.nodes.find((n: any) => n.type === 'DomainMesh3D' || n.type === 'Mesh3D' || n.type === 'CFDSolver3D') || null;
                        }
                    }
                }

                if (matchedNode) {
                    this.stateManager.setSelectedNode(matchedNode.id);
                }

                const selLabel = label || (objectType === 'Obstacle' ? 'Immersed Obstacle' : objectType);
                const chip = this.getOrCreateHudChip();
                chip.textContent = `🎯 ${selLabel}`;
                chip.classList.add('is-selected');
                chip.style.opacity = '1';
                chip.style.transform = 'translateY(0)';

                this.showCameraToast(`Selected: ${selLabel}`);

                const tc = (window as any).transportController;
                if (tc) {
                    tc.setSelectedObject?.({
                        objectType,
                        objectId,
                        sliceIndex,
                        gaugeIndex,
                        label: selLabel,
                        nodeId: matchedNode?.id
                    });
                    if (tc.setSelectedObjectDetails) {
                        tc.setSelectedObjectDetails({
                            objectType,
                            objectId,
                            sliceIndex,
                            gaugeIndex,
                            label: selLabel,
                            nodeId: matchedNode?.id
                        });
                    }
                }
            } else {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.setSelectedNode(vp.id);
                    this.stateManager.setSelectedSliceIndex(null);
                }
                if (this.hudChipEl) {
                    this.hudChipEl.style.opacity = '0';
                    this.hudChipEl.style.transform = 'translateY(-4px)';
                }
                const tc = (window as any).transportController;
                if (tc) {
                    tc.setSelectedObject?.(null);
                    if (tc.setSelectedObjectDetails) {
                        tc.setSelectedObjectDetails(null);
                    }
                }
            }
        } else if (button === 2) {
            // RIGHT CLICK: Context Menu
            this.showContextMenu(data, screenX, screenY);
        }
    }

    private showContextMenu(data: any, screenX: number, screenY: number): void {
        document.querySelectorAll('.viewport-3d-context-menu').forEach(el => el.remove());

        const menu = document.createElement('div');
        menu.className = 'viewport-3d-context-menu';

        const { hit, objectType, objectId, sliceIndex, label } = data || {};

        if (hit) {
            const header = document.createElement('div');
            header.className = 'vcm-header';
            header.innerHTML = `
                <span class="vcm-icon">📦</span>
                <span class="vcm-title">${label || objectType}</span>
                <span class="vcm-type-badge">${objectType}</span>
            `;
            menu.appendChild(header);

            const targetModel = this.getTargetModel();
            let matchedNode: any = null;
            if (targetModel && targetModel.nodes) {
                if (objectType === 'Slice') matchedNode = this.getSlicesCarrierNode() || this.getViewportNode();
                else if (objectType === 'VirtualGauges3D') matchedNode = targetModel.nodes.find((n: any) => n.type === 'VirtualGauges3D') || null;
                else if (objectType === 'Charge3D') matchedNode = targetModel.nodes.find((n: any) => n.type === 'Charge3D') || null;
                else if (objectType === 'DetonatorLocation3D') matchedNode = targetModel.nodes.find((n: any) => n.type === 'DetonatorLocation3D') || null;
                else if (objectType === 'FEMObject3D') {
                    const femObjNodes = targetModel.nodes.filter((n: any) => n.type === 'FEMObject3D' || n.type === 'LSDynaImporter3D' || n.type === 'FEMBeam3D' || n.type === 'FEMRebar3D');
                    matchedNode = targetModel.nodes.find((n: any) => n.id === objectId) ||
                                  (objectId !== undefined && !isNaN(Number(objectId)) ? femObjNodes[Math.round(Number(objectId))] : null) ||
                                  femObjNodes[0] ||
                                  targetModel.nodes.find((n: any) => n.type === 'FEMDomain3D') || null;
                } else if (objectType === 'MPMObject3D') {
                    const mpmObjNodes = targetModel.nodes.filter((n: any) => n.type === 'MPMObject3D');
                    matchedNode = targetModel.nodes.find((n: any) => n.id === objectId) ||
                                  (objectId !== undefined && !isNaN(Number(objectId)) ? mpmObjNodes[Math.round(Number(objectId))] : null) ||
                                  targetModel.nodes.find((n: any) => n.type === 'MPMObject3D' && String(n.parameters?.object_id) === String(objectId)) ||
                                  mpmObjNodes[0] ||
                                  targetModel.nodes.find((n: any) => n.type === 'MPMDomain3D') || null;
                }
                else if (objectType === 'STLGeometry') matchedNode = targetModel.nodes.find((n: any) => n.type === 'STLGeometry') || null;
                else if (objectType === 'PrimitiveGeometry3D' || objectType === 'Obstacle' || objectType === 'Obstacles' || objectType === 'Obstacle3D') {
                    matchedNode = targetModel.nodes.find((n: any) => n.id === objectId) ||
                                  targetModel.nodes.find((n: any) => n.type === 'PrimitiveGeometry3D' || n.type === 'Obstacle') ||
                                  targetModel.nodes.find((n: any) => n.type === 'STLGeometry') ||
                                  targetModel.nodes.find((n: any) => n.type === 'CFDSolver3D') ||
                                  this.getViewportNode() || null;
                }
                else if (objectType === 'DomainMesh3D') matchedNode = targetModel.nodes.find((n: any) => n.type === 'DomainMesh3D') || null;
            }

            // Action 1: Inspect Properties
            if (matchedNode) {
                const inspectItem = this.createContextMenuItem('🔍 Inspect Properties in Sidebar', () => {
                    this.stateManager.setSelectedNode(matchedNode.id);
                });
                menu.appendChild(inspectItem);
            }

            // Action 2: Frame Selection in Viewport
            const frameItem = this.createContextMenuItem('🎯 Frame / Focus Selection', () => {
                this.worker.postMessage({ type: 'setView', data: { pitch: 0.35, yaw: 0.78 } });
            });
            menu.appendChild(frameItem);

            const sep = document.createElement('div');
            sep.className = 'vcm-divider';
            menu.appendChild(sep);

            // Object-Specific Quick Actions
            if (objectType === 'Slice') {
                const cycleAxisItem = this.createContextMenuItem('🔄 Cycle Axis (X-Normal ➔ Y-Normal ➔ Z-Normal)', () => {
                    const vpNode = this.getViewportNode();
                    if (vpNode) {
                        const slices = [...(vpNode.parameters?.slices || [])];
                        const idx = sliceIndex ?? 0;
                        if (slices[idx]) {
                            const curAxis = slices[idx].axis || 'xy';
                            const nextAxis = (curAxis === 'yz' || curAxis === '2' || curAxis === 'x') ? 'xz' : (curAxis === 'xz' || curAxis === '1' || curAxis === 'y') ? 'xy' : 'yz';
                            slices[idx].axis = nextAxis;
                            this.stateManager.updateNodeParametersInPlace(vpNode.id, { slices });
                        }
                    }
                });
                menu.appendChild(cycleAxisItem);

                const centerSliceItem = this.createContextMenuItem('🎯 Center Slice at Domain Midpoint', () => {
                    const vpNode = this.getViewportNode();
                    if (vpNode) {
                        const slices = [...(vpNode.parameters?.slices || [])];
                        const idx = sliceIndex ?? 0;
                        if (slices[idx]) {
                            const curAxis = slices[idx].axis || 'xy';
                            const bounds = getSliceBounds(curAxis, this.getMeshNode());
                            slices[idx].offset = (bounds.min + bounds.max) / 2.0;
                            this.stateManager.updateNodeParametersInPlace(vpNode.id, { slices });
                        }
                    }
                });
                menu.appendChild(centerSliceItem);
            } else if (objectType === 'PrimitiveGeometry3D' || objectType === 'Obstacle' || objectType === 'Obstacles' || objectType === 'Obstacle3D') {
                const toggleSolidItem = this.createContextMenuItem('🧱 Toggle Solid / Wireframe Obstacle', () => {
                    const vpNode = this.getViewportNode();
                    if (vpNode) {
                        const curSolid = vpNode.parameters?.obstacles_solid !== false;
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { obstacles_solid: !curSolid });
                        this.worker.postMessage({ type: 'setConfig', data: { obstaclesSolid: !curSolid } });
                    }
                });
                menu.appendChild(toggleSolidItem);
                const toggleGridItem = this.createContextMenuItem('📐 Toggle Surface Gridlines', () => {
                    const vpNode = this.getViewportNode();
                    if (vpNode) {
                        const curGrid = vpNode.parameters?.obstacles_gridlines !== false;
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { obstacles_gridlines: !curGrid });
                        this.worker.postMessage({ type: 'setConfig', data: { obstaclesGridlines: !curGrid } });
                    }
                });
                menu.appendChild(toggleGridItem);
            } else if (objectType === 'Charge3D') {
                const shapeItem = this.createContextMenuItem('💥 Cycle Charge Geometry (Sphere / Cylinder / Block)', () => {
                    if (matchedNode) {
                        const curGeom = matchedNode.parameters?.geometry || 'SPHERE';
                        const nextGeom = curGeom === 'SPHERE' ? 'CYLINDER' : curGeom === 'CYLINDER' ? 'BOX' : 'SPHERE';
                        this.stateManager.updateNodeParameters(matchedNode.id, { geometry: nextGeom });
                    }
                });
                menu.appendChild(shapeItem);
            }
        } else {
            // Viewport Canvas Context Menu (Empty Space)
            const header = document.createElement('div');
            header.className = 'vcm-header';
            header.innerHTML = `
                <span class="vcm-icon">🎥</span>
                <span class="vcm-title">3D Viewport</span>
                <span class="vcm-type-badge">Canvas</span>
            `;
            menu.appendChild(header);

            menu.appendChild(this.createContextMenuItem('🏠 Reset Camera View', () => {
                this.snapCameraPreset('reset');
            }));

            menu.appendChild(this.createContextMenuItem('📐 Snap View: +Z (Top)', () => {
                this.alignCamera('top');
            }));

            menu.appendChild(this.createContextMenuItem('📐 Snap View: -Y (Front)', () => {
                this.alignCamera('front');
            }));

            menu.appendChild(this.createContextMenuItem('📐 Snap View: +X (Right)', () => {
                this.alignCamera('right');
            }));

            menu.appendChild(this.createContextMenuItem('⬡ Snap View: Isometric', () => {
                this.alignCamera('iso');
            }));

            const sep = document.createElement('div');
            sep.className = 'vcm-divider';
            menu.appendChild(sep);

            menu.appendChild(this.createContextMenuItem('🥞 Add Orthogonal Slice (Z-Normal)', () => {
                const vpNode = this.getViewportNode();
                if (vpNode) {
                    const slices = [...(vpNode.parameters?.slices || [])];
                    const bounds = getSliceBounds('xy', this.getMeshNode());
                    slices.push({ axis: 'xy', offset: (bounds.min + bounds.max) / 2.0, enabled: true, colormap: 'rainbow', opacity: 1.0 });
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { slices });
                }
            }));

            menu.appendChild(this.createContextMenuItem('🎯 Add Sensor Gauge Probe', () => {
                const targetModel = this.getTargetModel();
                const gaugeNode = targetModel?.nodes.find((n: any) => n.type === 'VirtualGauges3D');
                if (gaugeNode) {
                    const gauges = [...(gaugeNode.parameters?.gauges || [])];
                    gauges.push({ id: `P${gauges.length + 1}`, x: 0, y: 0, z: 0 });
                    this.stateManager.updateNodeParametersInPlace(gaugeNode.id, { gauges });
                }
            }));
        }

        // Position menu clamped to screen
        menu.style.left = `${Math.min(window.innerWidth - 220, Math.max(10, screenX))}px`;
        menu.style.top = `${Math.min(window.innerHeight - 300, Math.max(10, screenY))}px`;
        document.body.appendChild(menu);

        const closeMenu = (ev: MouseEvent | KeyboardEvent) => {
            if (ev instanceof MouseEvent && menu.contains(ev.target as HTMLElement)) return;
            menu.remove();
            window.removeEventListener('mousedown', closeMenu);
            window.removeEventListener('keydown', onKeyDown);
        };
        const onKeyDown = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') {
                menu.remove();
                window.removeEventListener('mousedown', closeMenu);
                window.removeEventListener('keydown', onKeyDown);
            }
        };

        setTimeout(() => {
            window.addEventListener('mousedown', closeMenu);
            window.addEventListener('keydown', onKeyDown);
        }, 50);
    }

    private createContextMenuItem(label: string, onClick: () => void): HTMLElement {
        const item = document.createElement('div');
        item.className = 'vcm-item';
        item.textContent = label;
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.viewport-3d-context-menu').forEach(el => el.remove());
            onClick();
        });
        return item;
    }

    private getTargetModel() {
        const modelId = this.getCurrentModelId();
        if (modelId) {
            return this.stateManager.getAllModels().find(m => m.id === modelId) || null;
        }
        return this.stateManager.getActiveModel();
    }

    private buildOverlay() {
        // In-viewport floating panels removed in favor of the unified workstation control bar
    }

    private formatRangeValue(val: number, rangeSpan?: number): string {
        if (val === 0 || Math.abs(val) < 1e-12) return '0';
        const absVal = Math.abs(val);

        if (absVal >= 1e5 || absVal < 0.01) {
            const expStr = val.toExponential(2);
            return expStr.replace(/\+0?/, '').replace(/e-0/, 'e-');
        }

        if (rangeSpan !== undefined && rangeSpan > 0) {
            if (rangeSpan >= 100) return val.toFixed(0);
            if (rangeSpan >= 10) return val.toFixed(1);
            if (rangeSpan >= 1) return val.toFixed(2);
            if (rangeSpan >= 0.1) return val.toFixed(3);
            return val.toFixed(4);
        }

        if (absVal >= 100) return val.toFixed(0);
        if (absVal >= 10) return val.toFixed(1);
        if (absVal >= 1) return val.toFixed(2);
        if (absVal >= 0.1) return val.toFixed(3);
        return val.toFixed(4);
    }

    private applyButtonStyle(btn: HTMLElement) {
        btn.style.background = '#25252a';
        btn.style.color = '#ffffff';
        btn.style.border = '1px solid rgba(255, 255, 255, 0.12)';
        btn.style.borderRadius = '4px';
        btn.style.padding = '3px 7px';
        btn.style.cursor = 'pointer';
        btn.style.fontSize = '10px';
        btn.style.fontWeight = '500';
        btn.style.transition = 'background 0.2s';
        btn.onmouseover = () => btn.style.background = '#35353c';
        btn.onmouseout = () => btn.style.background = '#25252a';
    }

    private createCard(
        parent: HTMLElement,
        titleText: string,
        icon: string,
        enabledKey?: string,
        defaultEnabled: boolean = true,
        onEnableChange?: (enabled: boolean) => void
    ): { card: HTMLElement; body: HTMLElement; header: HTMLElement } {
        const card = document.createElement('div');
        card.style.background = 'rgba(255, 255, 255, 0.025)';
        card.style.border = '1px solid rgba(255, 255, 255, 0.08)';
        card.style.borderRadius = '5px';
        card.style.padding = '5px 7px';
        card.style.display = 'flex';
        card.style.flexDirection = 'column';
        card.style.gap = '4px';
        card.style.width = '100%';
        card.style.boxSizing = 'border-box';
        card.style.transition = 'border-color 0.2s, background 0.2s';
        parent.appendChild(card);

        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.style.width = '100%';
        header.style.boxSizing = 'border-box';

        const titleWrap = document.createElement('div');
        titleWrap.style.display = 'flex';
        titleWrap.style.alignItems = 'center';
        titleWrap.style.gap = '5px';

        let isEnabled = defaultEnabled;
        if (enabledKey) {
            const vpNode = this.getViewportNode();
            if (vpNode) {
                isEnabled = vpNode.parameters[enabledKey] !== false;
            }
            const enableCb = document.createElement('input');
            enableCb.type = 'checkbox';
            enableCb.checked = isEnabled;
            enableCb.title = `Enable/Disable ${titleText}`;
            enableCb.style.margin = '0';
            enableCb.onchange = (e) => {
                e.stopPropagation();
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { [enabledKey]: enableCb.checked });
                    if (onEnableChange) onEnableChange(enableCb.checked);
                    this.syncControls(true);
                }
            };
            this.bindEditingEvents(enableCb);
            titleWrap.appendChild(enableCb);
        }

        const iconSpan = document.createElement('span');
        iconSpan.textContent = icon;
        iconSpan.style.fontSize = '10px';
        titleWrap.appendChild(iconSpan);

        const titleLabel = document.createElement('span');
        titleLabel.textContent = titleText;
        titleLabel.style.fontWeight = 'bold';
        titleLabel.style.fontSize = '9.5px';
        titleLabel.style.color = '#00adff';
        titleLabel.style.letterSpacing = '0.4px';
        titleLabel.style.textTransform = 'uppercase';
        titleWrap.appendChild(titleLabel);

        header.appendChild(titleWrap);

        let isExpanded = true;
        const toggleBtn = document.createElement('span');
        toggleBtn.textContent = '▲';
        toggleBtn.style.cursor = 'pointer';
        toggleBtn.style.fontSize = '8px';
        toggleBtn.style.color = '#888';
        header.appendChild(toggleBtn);

        card.appendChild(header);

        const body = document.createElement('div');
        body.style.display = 'flex';
        body.style.flexDirection = 'column';
        body.style.gap = '4px';
        body.style.width = '100%';
        body.style.boxSizing = 'border-box';
        body.style.marginTop = '2px';
        card.appendChild(body);

        toggleBtn.onclick = (e) => {
            e.stopPropagation();
            isExpanded = !isExpanded;
            body.style.display = isExpanded ? 'flex' : 'none';
            toggleBtn.textContent = isExpanded ? '▲' : '⚙️';
        };

        return { card, body, header };
    }

    private buildUnifiedControlsTable(parent: HTMLElement) {
        const vpNode = this.getViewportNode();

        // 1. Top Bar: Refresh Rate & Add Slice Button
        const topBar = document.createElement('div');
        topBar.style.display = 'flex';
        topBar.style.justifyContent = 'space-between';
        topBar.style.alignItems = 'center';
        topBar.style.gap = '6px';
        topBar.style.width = '100%';
        topBar.style.marginBottom = '6px';
        topBar.style.boxSizing = 'border-box';

        const rateRow = document.createElement('div');
        rateRow.style.display = 'flex';
        rateRow.style.alignItems = 'center';
        rateRow.style.gap = '4px';
        rateRow.style.fontSize = '10px';
        rateRow.style.color = '#aaa';
        rateRow.appendChild(document.createTextNode('Refresh Rate:'));

        const rateSel = document.createElement('select');
        rateSel.id = this.getElId('viewport-refresh-rate-sel-matrix');
        this.applySelectStyle(rateSel);
        rateSel.style.width = '145px';
        rateSel.innerHTML = `
            <option value="0.016">60 FPS (16.6ms / Max)</option>
            <option value="0.033">30 FPS (0.033s)</option>
            <option value="0.05">20 FPS (0.05s)</option>
            <option value="0.1">10 FPS (0.1s)</option>
            <option value="0.2">5 FPS (0.2s)</option>
            <option value="0.5">2 FPS (0.5s / Default)</option>
            <option value="1.0">1 FPS (1.0s)</option>
            <option value="2.0">0.5 FPS (2.0s)</option>
            <option value="5.0">0.2 FPS (5.0s)</option>
            <option value="10.0">0.1 FPS (10.0s)</option>
            <option value="20.0">0.05 FPS (20.0s)</option>
            <option value="50.0">0.02 FPS (50.0s)</option>
            <option value="100.0">0.01 FPS (100.0s)</option>
            <option value="1000.0">0.001 FPS (1000.0s)</option>
        `;
        this.selectOptionByNumericValue(rateSel, vpNode ? (vpNode.parameters.refresh_rate ?? 0.5) : 0.5);
        this.bindEditingEvents(rateSel, () => {
            const vp = this.getViewportNode();
            if (vp) {
                const val = Number(rateSel.value);
                this.stateManager.updateNodeParametersInPlace(vp.id, { refresh_rate: val });
                this.sendView3DConfig();
            }
        });
        rateRow.appendChild(rateSel);

        const refreshBtn = document.createElement('button');
        refreshBtn.innerHTML = '🔄 Refresh';
        refreshBtn.title = 'Manual Telemetry Refresh: Request current state from solver and plot in 3D viewport';
        this.applyButtonStyle(refreshBtn);
        refreshBtn.onclick = () => {
            this.sendView3DConfig();
            const latest = (window as any).playbackBuffer?.getLatestFrame();
            if (latest) {
                if (latest.sliceBuffer) {
                    this.pushFrame(latest.sliceBuffer, latest.modelId);
                } else if (latest.buffer && latest.buffer !== latest.mpmBuffer && latest.buffer !== latest.femBuffer) {
                    this.pushFrame(latest.buffer, latest.modelId);
                }
                if (latest.mpmBuffer) {
                    this.pushFrame(latest.mpmBuffer, latest.modelId);
                }
                if (latest.femBuffer) {
                    this.pushFrame(latest.femBuffer, latest.modelId);
                }
            }
        };
        rateRow.appendChild(refreshBtn);
        topBar.appendChild(rateRow);

        const addSliceBtn = document.createElement('button');
        addSliceBtn.innerHTML = '+ Add Slice';
        this.applyButtonStyle(addSliceBtn);
        addSliceBtn.onclick = () => this.addSlice();
        topBar.appendChild(addSliceBtn);

        parent.appendChild(topBar);

        // 2. Real Data Table Card
        const tableCard = document.createElement('div');
        tableCard.style.background = 'rgba(255, 255, 255, 0.02)';
        tableCard.style.border = '1px solid rgba(255, 255, 255, 0.08)';
        tableCard.style.borderRadius = '6px';
        tableCard.style.padding = '4px';
        tableCard.style.width = '100%';
        tableCard.style.boxSizing = 'border-box';
        tableCard.style.overflow = 'hidden';
        parent.appendChild(tableCard);

        const table = document.createElement('table');
        table.style.width = '100%';
        table.style.tableLayout = 'fixed';
        table.style.borderCollapse = 'collapse';
        table.style.fontSize = '9.5px';
        table.style.color = '#ccc';
        tableCard.appendChild(table);

        const thead = document.createElement('thead');
        thead.innerHTML = `
            <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.15); color: #00adff; font-weight: bold; font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.5px;">
                <th style="padding: 4px 2px; text-align: center; width: 20px;" title="Visibility">👁</th>
                <th style="padding: 4px 4px; text-align: left; width: 70px;">LAYER</th>
                <th style="padding: 4px 2px; text-align: center; width: 32px;" title="Solids / Volume Surface">SOL</th>
                <th style="padding: 4px 2px; text-align: center; width: 38px;" title="Lines, Mesh Gridlines & Cell Edges">LINES</th>
                <th style="padding: 4px 2px; text-align: center; width: 32px;" title="Results / Contour Display">RES</th>
                <th style="padding: 4px 4px; text-align: left; width: 70px;">QTY</th>
                <th style="padding: 4px 4px; text-align: left; width: 70px;">COLOR</th>
                <th style="padding: 4px 2px; text-align: center; width: 44px;">SCL</th>
                <th style="padding: 4px 4px; text-align: center; width: 45px;">OPACITY</th>
                <th style="padding: 4px 2px; text-align: center; width: 18px;">🗑</th>
            </tr>
        `;
        table.appendChild(thead);

        const sliceTbody = document.createElement('tbody');
        table.appendChild(sliceTbody);
        this.sliceListContainer = sliceTbody;

        const staticTbody = document.createElement('tbody');
        table.appendChild(staticTbody);
        this.staticListContainer = staticTbody;

        // Render static component rows below slices
        this.buildObstacleRow(staticTbody);
        this.buildSTLRow(staticTbody);
        this.buildChargeRow(staticTbody);
        this.buildDetonatorRow(staticTbody);
        this.buildGridRow(staticTbody);
        this.buildGaugeRow(staticTbody);
        this.buildMPMParticlesTableRow(staticTbody);
        this.buildFEMMeshTableRow(staticTbody);
        this.buildBeamTableRow(staticTbody);
        this.buildLightingTableRow(staticTbody);
    }

    private activePopover: HTMLElement | null = null;
    private currentOutsideListener: ((e: MouseEvent) => void) | null = null;

    private closePopover() {
        if (this.currentOutsideListener) {
            window.removeEventListener('mousedown', this.currentOutsideListener);
            this.currentOutsideListener = null;
        }
        if (this.activePopover) {
            this.activePopover.remove();
            this.activePopover = null;
        }
    }

    private showPopover(targetEl: HTMLElement, contentBuilder: (popover: HTMLElement) => void) {
        this.closePopover();

        const popover = document.createElement('div');
        popover.className = 'viewport-controls-popover';
        popover.style.position = 'fixed';
        popover.style.zIndex = '99999';
        popover.style.background = '#181c24';
        popover.style.border = '1px solid #00adff';
        popover.style.borderRadius = '5px';
        popover.style.padding = '6px';
        popover.style.boxShadow = '0 6px 20px rgba(0, 0, 0, 0.7)';
        popover.style.fontSize = '9.5px';
        popover.style.color = '#eee';
        popover.style.minWidth = '130px';

        contentBuilder(popover);

        document.body.appendChild(popover);
        this.activePopover = popover;

        const rect = targetEl.getBoundingClientRect();
        let top = rect.bottom + 4;
        let left = rect.left;

        popover.style.visibility = 'hidden';
        const popRect = popover.getBoundingClientRect();
        if (left + popRect.width > window.innerWidth - 10) {
            left = window.innerWidth - popRect.width - 10;
        }
        if (top + popRect.height > window.innerHeight - 10) {
            top = rect.top - popRect.height - 4;
        }
        popover.style.left = `${Math.max(10, left)}px`;
        popover.style.top = `${Math.max(10, top)}px`;
        popover.style.visibility = 'visible';

        const onClickOutside = (e: MouseEvent) => {
            const target = e.target as any;
            if (popover && !popover.contains(target) && !targetEl.contains(target)) {
                this.closePopover();
            }
        };
        this.currentOutsideListener = onClickOutside;
        setTimeout(() => {
            if (this.activePopover === popover) {
                window.addEventListener('mousedown', onClickOutside);
            }
        }, 10);
    }

    private showQuantityPopover(targetEl: HTMLElement, currentQty: string, context: 'cfd' | 'mpm' | 'fem' | 'beam', onSelect: (qty: string) => void) {
        const cfdQuantities = [
            { id: 'pressure', label: '📊 Pressure' },
            { id: 'density', label: '⚖️ Density' },
            { id: 'velocity', label: '💨 Speed' },
            { id: 'energy', label: '🔥 Energy' },
            { id: 'species1', label: '💥 Reacted' },
            { id: 'species2', label: '🧪 Unreacted' },
            { id: 'species3', label: '🌬️ Air' },
            { id: 'peak_overpressure', label: '📈 Pk Overpress' },
            { id: 'peak_impulse', label: '⏱️ Pk Impulse' }
        ];

        const mpmQuantities = [
            { id: 'vonMises', label: '🛡️ Von Mises' },
            { id: 'plastic_strain', label: '🔨 Plastic Strain' },
            { id: 'damage', label: '💥 Damage' },
            { id: 'cluster_id', label: '🧩 Fragments' },
            { id: 'density', label: '⚖️ Density' },
            { id: 'pressure', label: '📊 Pressure' },
            { id: 'has_failed', label: '⚠️ Failure' },
            { id: 'object_id', label: '🆔 Object ID' },
            { id: 'velocity', label: '💨 Speed' }
        ];

        const femQuantities = [
            { id: 'vonMises', label: '🛡️ Von Mises' },
            { id: 'plasticStrain', label: '🔨 Plastic Strain' },
            { id: 'pressure', label: '📊 Pressure' },
            { id: 'velocity', label: '💨 Velocity' },
            { id: 'damage', label: '💥 Damage' }
        ];

        const beamQuantities = [
            { id: 'plasticStrain', label: '🔨 Plastic Strain (εp)' },
            { id: 'vonMises', label: '🛡️ Axial / Eff Stress' },
            { id: 'momentOrForce', label: '📐 Moment / Force' },
            { id: 'velocity', label: '💨 Velocity' },
            { id: 'damage', label: '💥 Failure / Erosion' }
        ];

        let quantities = cfdQuantities;
        if (context === 'mpm') quantities = mpmQuantities;
        else if (context === 'fem') quantities = femQuantities;
        else if (context === 'beam') quantities = beamQuantities;

        this.showPopover(targetEl, (popover) => {
            const title = document.createElement('div');
            title.textContent = 'Select Quantity';
            title.style.fontWeight = 'bold';
            title.style.color = '#00adff';
            title.style.marginBottom = '6px';
            title.style.fontSize = '9px';
            title.style.textTransform = 'uppercase';
            popover.appendChild(title);

            quantities.forEach(q => {
                const item = document.createElement('div');
                item.textContent = q.label;
                item.style.padding = '3px 6px';
                item.style.borderRadius = '3px';
                item.style.cursor = 'pointer';
                item.style.background = q.id === currentQty ? '#007acc' : 'transparent';
                item.style.color = q.id === currentQty ? '#fff' : '#ccc';
                item.onmouseenter = () => { if (q.id !== currentQty) item.style.background = 'rgba(255,255,255,0.1)'; };
                item.onmouseleave = () => { if (q.id !== currentQty) item.style.background = 'transparent'; };
                item.onclick = (e) => {
                    e.stopPropagation();
                    onSelect(q.id);
                    this.closePopover();
                };
                popover.appendChild(item);
            });
        });
    }

    private showColormapPopover(targetEl: HTMLElement, currentCmap: string, onSelect: (cmap: string) => void) {
        const colormaps = [
            { id: 'rainbow', name: 'Rainbow', grad: 'linear-gradient(to right, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000)' },
            { id: 'plasma', name: 'Plasma', grad: 'linear-gradient(to right, #0d0887, #6a00a8, #b12a90, #e16462, #fca636, #f0f921)' },
            { id: 'viridis', name: 'Viridis', grad: 'linear-gradient(to right, #440154, #3b528b, #21908d, #5dc963, #fde725)' },
            { id: 'coolwarm', name: 'CoolWarm', grad: 'linear-gradient(to right, #3b4cc0, #88b0f3, #ddd, #f49a7b, #b40426)' },
            { id: 'cividis', name: 'Cividis', grad: 'linear-gradient(to right, #002051, #395276, #678685, #9eb980, #fdea45)' },
            { id: 'grayscale', name: 'Gray', grad: 'linear-gradient(to right, #000000, #ffffff)' }
        ];

        this.showPopover(targetEl, (popover) => {
            const title = document.createElement('div');
            title.textContent = 'Select Colormap';
            title.style.fontWeight = 'bold';
            title.style.color = '#00adff';
            title.style.marginBottom = '6px';
            title.style.fontSize = '9px';
            title.style.textTransform = 'uppercase';
            popover.appendChild(title);

            colormaps.forEach(c => {
                const item = document.createElement('div');
                item.style.display = 'flex';
                item.style.alignItems = 'center';
                item.style.justifyContent = 'space-between';
                item.style.gap = '8px';
                item.style.padding = '3px 6px';
                item.style.borderRadius = '3px';
                item.style.cursor = 'pointer';
                item.style.background = c.id === currentCmap ? '#007acc' : 'transparent';
                item.style.color = c.id === currentCmap ? '#fff' : '#ccc';

                const nameSpan = document.createElement('span');
                nameSpan.textContent = c.name;
                item.appendChild(nameSpan);

                const swatch = document.createElement('div');
                swatch.style.width = '35px';
                swatch.style.height = '10px';
                swatch.style.borderRadius = '2px';
                swatch.style.background = c.grad;
                swatch.style.border = '1px solid rgba(255,255,255,0.3)';
                item.appendChild(swatch);

                item.onmouseenter = () => { if (c.id !== currentCmap) item.style.background = 'rgba(255,255,255,0.1)'; };
                item.onmouseleave = () => { if (c.id !== currentCmap) item.style.background = 'transparent'; };
                item.onclick = (e) => {
                    e.stopPropagation();
                    onSelect(c.id);
                    this.closePopover();
                };
                popover.appendChild(item);
            });
        });
    }

    private showOpacityPopover(targetEl: HTMLElement, currentVal: number, onChange: (opac: number) => void) {
        this.showPopover(targetEl, (popover) => {
            const title = document.createElement('div');
            title.textContent = 'Opacity Preset';
            title.style.fontWeight = 'bold';
            title.style.color = '#00adff';
            title.style.marginBottom = '6px';
            title.style.fontSize = '9px';
            title.style.textTransform = 'uppercase';
            popover.appendChild(title);

            const grid = document.createElement('div');
            grid.style.display = 'grid';
            grid.style.gridTemplateColumns = '1fr 1fr 1fr';
            grid.style.gap = '4px';
            grid.style.marginBottom = '6px';

            const presets = [1.0, 0.75, 0.50, 0.25, 0.10, 0.0];
            presets.forEach(p => {
                const btn = document.createElement('button');
                btn.textContent = `${Math.round(p * 100)}%`;
                this.applyButtonStyle(btn);
                btn.style.fontSize = '8.5px';
                btn.style.padding = '2px 0';
                if (Math.abs(p - currentVal) < 0.04) {
                    btn.style.background = '#007acc';
                    btn.style.borderColor = '#00adff';
                }
                btn.onclick = (e) => {
                    e.stopPropagation();
                    onChange(p);
                    this.closePopover();
                };
                grid.appendChild(btn);
            });
            popover.appendChild(grid);

            const customRow = document.createElement('div');
            customRow.style.display = 'flex';
            customRow.style.alignItems = 'center';
            customRow.style.gap = '4px';
            const numInp = document.createElement('input');
            numInp.type = 'number';
            numInp.min = '0';
            numInp.max = '1';
            numInp.step = '0.05';
            numInp.value = String(currentVal);
            this.applyInputStyle(numInp);
            numInp.style.width = '60px';
            numInp.onchange = () => {
                const val = Math.max(0, Math.min(1, Number(numInp.value)));
                onChange(val);
                this.closePopover();
            };
            customRow.appendChild(document.createTextNode('Custom:'));
            customRow.appendChild(numInp);
            popover.appendChild(customRow);
        });
    }

    private getEmpiricalRange(): { min: number, max: number } | null {
        if (this.latestEmpiricalRange && isFinite(this.latestEmpiricalRange.min) && isFinite(this.latestEmpiricalRange.max)) {
            return this.latestEmpiricalRange;
        }
        if (this.latestSliceRanges && this.latestSliceRanges.length > 0) {
            let min = Infinity;
            let max = -Infinity;
            this.latestSliceRanges.forEach(r => {
                if (r && isFinite(r.min) && isFinite(r.max)) {
                    if (r.min < min) min = r.min;
                    if (r.max > max) max = r.max;
                }
            });
            if (min !== Infinity && max !== -Infinity) {
                return { min, max };
            }
        }
        return null;
    }

    private showRangePopover(targetEl: HTMLElement, qtyName: string, minVal: number, maxVal: number, autoScale: boolean, logScale: boolean, onApply?: (minV: number, maxV: number, autoV: boolean, logV: boolean) => void) {
        this.showPopover(targetEl, (popover) => {
            const title = document.createElement('div');
            title.textContent = `Scale (${qtyName})`;
            title.style.fontWeight = 'bold';
            title.style.color = '#00adff';
            title.style.marginBottom = '6px';
            title.style.fontSize = '9px';
            title.style.textTransform = 'uppercase';
            popover.appendChild(title);

            // Auto & Log toggles
            const togglesRow = document.createElement('div');
            togglesRow.style.display = 'flex';
            togglesRow.style.gap = '8px';
            togglesRow.style.marginBottom = '8px';

            const autoLbl = document.createElement('label');
            autoLbl.style.display = 'flex';
            autoLbl.style.alignItems = 'center';
            autoLbl.style.gap = '3px';
            autoLbl.style.cursor = 'pointer';
            const autoCb = document.createElement('input');
            autoCb.type = 'checkbox';
            autoCb.checked = autoScale;
            autoLbl.appendChild(autoCb);
            autoLbl.appendChild(document.createTextNode('Auto'));
            togglesRow.appendChild(autoLbl);

            const logLbl = document.createElement('label');
            logLbl.style.display = 'flex';
            logLbl.style.alignItems = 'center';
            logLbl.style.gap = '3px';
            logLbl.style.cursor = 'pointer';
            const logCb = document.createElement('input');
            logCb.type = 'checkbox';
            logCb.checked = logScale;
            logLbl.appendChild(logCb);
            logLbl.appendChild(document.createTextNode('Log'));
            togglesRow.appendChild(logLbl);

            popover.appendChild(togglesRow);

            // Min & Max inputs
            const inputsGrid = document.createElement('div');
            inputsGrid.style.display = 'grid';
            inputsGrid.style.gridTemplateColumns = '40px 1fr';
            inputsGrid.style.gap = '4px';
            inputsGrid.style.alignItems = 'center';
            inputsGrid.style.marginBottom = '8px';

            const minLbl = document.createElement('span');
            minLbl.textContent = 'Min:';
            const minInp = document.createElement('input');
            minInp.type = 'number';
            minInp.value = String(minVal);
            this.applyInputStyle(minInp);
            minInp.disabled = autoScale;

            const maxLbl = document.createElement('span');
            maxLbl.textContent = 'Max:';
            const maxInp = document.createElement('input');
            maxInp.type = 'number';
            maxInp.value = String(maxVal);
            this.applyInputStyle(maxInp);
            maxInp.disabled = autoScale;

            const commitRange = () => {
                const minV = Number(minInp.value);
                const maxV = Number(maxInp.value);
                if (!isNaN(minV) && !isNaN(maxV) && onApply) {
                    onApply(minV, maxV, autoCb.checked, logCb.checked);
                }
            };

            autoCb.onchange = () => {
                minInp.disabled = autoCb.checked;
                maxInp.disabled = autoCb.checked;
                if (!autoCb.checked) {
                    const emp = this.getEmpiricalRange();
                    if (emp) {
                        minInp.value = String(emp.min);
                        maxInp.value = String(emp.max);
                    }
                }
                commitRange();
            };
            logCb.onchange = () => {
                commitRange();
            };

            minInp.oninput = minInp.onchange = () => {
                if (autoCb.checked) {
                    autoCb.checked = false;
                    minInp.disabled = false;
                    maxInp.disabled = false;
                }
                commitRange();
            };
            maxInp.oninput = maxInp.onchange = () => {
                if (autoCb.checked) {
                    autoCb.checked = false;
                    minInp.disabled = false;
                    maxInp.disabled = false;
                }
                commitRange();
            };

            minInp.onkeydown = maxInp.onkeydown = (e: KeyboardEvent) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    commitRange();
                    this.closePopover();
                }
            };

            inputsGrid.appendChild(minLbl);
            inputsGrid.appendChild(minInp);
            inputsGrid.appendChild(maxLbl);
            inputsGrid.appendChild(maxInp);
            popover.appendChild(inputsGrid);

            // Set to Current Button
            const empRange = this.getEmpiricalRange();
            const setBtn = document.createElement('button');
            setBtn.textContent = empRange ? `🎯 Set to Current [${this.formatRangeValue(empRange.min)}, ${this.formatRangeValue(empRange.max)}]` : '🎯 Set to Current';
            this.applyButtonStyle(setBtn);
            setBtn.style.width = '100%';
            setBtn.style.marginBottom = '6px';
            setBtn.style.background = 'rgba(0, 173, 255, 0.15)';
            setBtn.style.border = '1px solid #00adff';
            setBtn.style.color = '#00adff';
            setBtn.style.fontSize = '9px';
            setBtn.style.padding = '4px 0';
            setBtn.onclick = (e) => {
                e.stopPropagation();
                const curEmp = this.getEmpiricalRange();
                if (curEmp) {
                    autoCb.checked = false;
                    minInp.disabled = false;
                    maxInp.disabled = false;
                    minInp.value = String(curEmp.min);
                    maxInp.value = String(curEmp.max);
                    commitRange();
                }
            };
            popover.appendChild(setBtn);

            const applyBtn = document.createElement('button');
            applyBtn.textContent = 'Apply Scale';
            this.applyButtonStyle(applyBtn);
            applyBtn.style.width = '100%';
            applyBtn.onclick = (e) => {
                e.stopPropagation();
                commitRange();
                this.closePopover();
            };
            popover.appendChild(applyBtn);
        });
    }

    private showAmbientPopover(targetEl: HTMLElement, currentVal: number, onChange: (val: number) => void) {
        this.showPopover(targetEl, (popover) => {
            const title = document.createElement('div');
            title.textContent = 'Ambient Level';
            title.style.fontWeight = 'bold';
            title.style.color = '#00adff';
            title.style.marginBottom = '6px';
            title.style.fontSize = '9px';
            title.style.textTransform = 'uppercase';
            popover.appendChild(title);

            const grid = document.createElement('div');
            grid.style.display = 'grid';
            grid.style.gridTemplateColumns = '1fr 1fr 1fr';
            grid.style.gap = '4px';
            grid.style.marginBottom = '6px';

            const presets = [
                { val: 0.10, label: '10%' },
                { val: 0.30, label: '30%' },
                { val: 0.50, label: '50%' },
                { val: 0.70, label: '70%' },
                { val: 0.85, label: '85%' },
                { val: 1.00, label: '100%' }
            ];
            presets.forEach(p => {
                const btn = document.createElement('button');
                btn.textContent = p.label;
                this.applyButtonStyle(btn);
                btn.style.fontSize = '8.5px';
                btn.style.padding = '2px 0';
                if (Math.abs(p.val - currentVal) < 0.04) {
                    btn.style.background = '#007acc';
                    btn.style.borderColor = '#00adff';
                }
                btn.onclick = (e) => {
                    e.stopPropagation();
                    onChange(p.val);
                    this.closePopover();
                };
                grid.appendChild(btn);
            });
            popover.appendChild(grid);

            const customRow = document.createElement('div');
            customRow.style.display = 'flex';
            customRow.style.alignItems = 'center';
            customRow.style.gap = '4px';
            const numInp = document.createElement('input');
            numInp.type = 'number';
            numInp.min = '0';
            numInp.max = '1';
            numInp.step = '0.05';
            numInp.value = String(currentVal);
            this.applyInputStyle(numInp);
            numInp.style.width = '60px';
            numInp.oninput = () => {
                const valStr = numInp.value.trim();
                if (valStr !== '') {
                    const val = Number(valStr);
                    if (!isNaN(val)) {
                        onChange(Math.max(0, Math.min(1, val)));
                    }
                }
            };
            numInp.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const val = Math.max(0, Math.min(1, Number(numInp.value)));
                    onChange(val);
                    this.closePopover();
                }
            };
            customRow.appendChild(document.createTextNode('Custom:'));
            customRow.appendChild(numInp);
            popover.appendChild(customRow);
        });
    }

    private showSpecularPopover(targetEl: HTMLElement, currentVal: number, onChange: (val: number) => void) {
        this.showPopover(targetEl, (popover) => {
            const title = document.createElement('div');
            title.textContent = 'Specular Level';
            title.style.fontWeight = 'bold';
            title.style.color = '#00adff';
            title.style.marginBottom = '6px';
            title.style.fontSize = '9px';
            title.style.textTransform = 'uppercase';
            popover.appendChild(title);

            const grid = document.createElement('div');
            grid.style.display = 'grid';
            grid.style.gridTemplateColumns = '1fr 1fr 1fr';
            grid.style.gap = '4px';
            grid.style.marginBottom = '6px';

            const presets = [
                { val: 0.00, label: '0%' },
                { val: 0.20, label: '20%' },
                { val: 0.40, label: '40%' },
                { val: 0.60, label: '60%' },
                { val: 0.80, label: '80%' },
                { val: 1.00, label: '100%' }
            ];
            presets.forEach(p => {
                const btn = document.createElement('button');
                btn.textContent = p.label;
                this.applyButtonStyle(btn);
                btn.style.fontSize = '8.5px';
                btn.style.padding = '2px 0';
                if (Math.abs(p.val - currentVal) < 0.04) {
                    btn.style.background = '#007acc';
                    btn.style.borderColor = '#00adff';
                }
                btn.onclick = (e) => {
                    e.stopPropagation();
                    onChange(p.val);
                    this.closePopover();
                };
                grid.appendChild(btn);
            });
            popover.appendChild(grid);

            const customRow = document.createElement('div');
            customRow.style.display = 'flex';
            customRow.style.alignItems = 'center';
            customRow.style.gap = '4px';
            const numInp = document.createElement('input');
            numInp.type = 'number';
            numInp.min = '0';
            numInp.max = '1';
            numInp.step = '0.05';
            numInp.value = String(currentVal);
            this.applyInputStyle(numInp);
            numInp.style.width = '60px';
            numInp.oninput = () => {
                const valStr = numInp.value.trim();
                if (valStr !== '') {
                    const val = Number(valStr);
                    if (!isNaN(val)) {
                        onChange(Math.max(0, Math.min(1, val)));
                    }
                }
            };
            numInp.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const val = Math.max(0, Math.min(1, Number(numInp.value)));
                    onChange(val);
                    this.closePopover();
                }
            };
            customRow.appendChild(document.createTextNode('Custom:'));
            customRow.appendChild(numInp);
            popover.appendChild(customRow);
        });
    }

    private showAOPopover(targetEl: HTMLElement) {
        this.showPopover(targetEl, (popover) => {
            const vp = this.getViewportNode();
            const p = vp?.parameters || {};
            const curEnabled = p.aoEnabled !== false;
            const curRadius = Number(p.aoRadius ?? 0.15);
            const curIntensity = Number(p.aoIntensity ?? 1.2);
            const curSphereAO = p.aoSphereImpostor !== false;

            popover.style.width = '210px';

            const title = document.createElement('div');
            title.textContent = '✨ Screen-Space Ambient Occlusion';
            title.style.fontWeight = 'bold';
            title.style.color = '#00adff';
            title.style.marginBottom = '8px';
            title.style.fontSize = '9px';
            title.style.textTransform = 'uppercase';
            popover.appendChild(title);

            // Master Toggle Row
            const toggleRow = document.createElement('div');
            toggleRow.style.display = 'flex';
            toggleRow.style.alignItems = 'center';
            toggleRow.style.justifyContent = 'space-between';
            toggleRow.style.marginBottom = '8px';
            toggleRow.style.fontSize = '9px';
            toggleRow.style.color = '#ccc';

            const toggleLabel = document.createElement('span');
            toggleLabel.textContent = 'Enable SSAO Shadows:';
            const toggleCb = document.createElement('input');
            toggleCb.type = 'checkbox';
            toggleCb.checked = curEnabled;
            toggleCb.onchange = () => {
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { aoEnabled: toggleCb.checked });
                    this.worker.postMessage({ type: 'setConfig', data: { aoEnabled: toggleCb.checked } });
                }
            };
            toggleRow.appendChild(toggleLabel);
            toggleRow.appendChild(toggleCb);
            popover.appendChild(toggleRow);

            // Radius Slider
            const rRow = document.createElement('div');
            rRow.style.marginBottom = '6px';
            rRow.style.fontSize = '9px';
            const rLabel = document.createElement('div');
            rLabel.textContent = `Sampling Radius: ${(curRadius * 100).toFixed(0)}cm`;
            rLabel.style.color = '#aaa';
            rLabel.style.marginBottom = '2px';
            const rSlider = document.createElement('input');
            rSlider.type = 'range';
            rSlider.min = '1';
            rSlider.max = '100';
            rSlider.value = String(Math.round(curRadius * 100));
            rSlider.style.width = '100%';
            rSlider.oninput = () => {
                const rVal = Number(rSlider.value) / 100.0;
                rLabel.textContent = `Sampling Radius: ${rSlider.value}cm`;
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { aoRadius: rVal });
                    this.worker.postMessage({ type: 'setConfig', data: { aoRadius: rVal } });
                }
            };
            rRow.appendChild(rLabel);
            rRow.appendChild(rSlider);
            popover.appendChild(rRow);

            // Intensity Slider
            const intRow = document.createElement('div');
            intRow.style.marginBottom = '6px';
            intRow.style.fontSize = '9px';
            const intLabel = document.createElement('div');
            intLabel.textContent = `Shadow Intensity: ${Math.round(curIntensity * 100)}%`;
            intLabel.style.color = '#aaa';
            intLabel.style.marginBottom = '2px';
            const intSlider = document.createElement('input');
            intSlider.type = 'range';
            intSlider.min = '10';
            intSlider.max = '300';
            intSlider.value = String(Math.round(curIntensity * 100));
            intSlider.style.width = '100%';
            intSlider.oninput = () => {
                const iVal = Number(intSlider.value) / 100.0;
                intLabel.textContent = `Shadow Intensity: ${intSlider.value}%`;
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { aoIntensity: iVal });
                    this.worker.postMessage({ type: 'setConfig', data: { aoIntensity: iVal } });
                }
            };
            intRow.appendChild(intLabel);
            intRow.appendChild(intSlider);
            popover.appendChild(intRow);

            // Sphere Impostor AO Toggle
            const sphereRow = document.createElement('div');
            sphereRow.style.display = 'flex';
            sphereRow.style.alignItems = 'center';
            sphereRow.style.justifyContent = 'space-between';
            sphereRow.style.marginTop = '6px';
            sphereRow.style.fontSize = '9px';
            sphereRow.style.color = '#ccc';

            const sphereLabel = document.createElement('span');
            sphereLabel.textContent = 'MPM Sphere Impostor AO:';
            const sphereCb = document.createElement('input');
            sphereCb.type = 'checkbox';
            sphereCb.checked = curSphereAO;
            sphereCb.onchange = () => {
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { aoSphereImpostor: sphereCb.checked });
                    this.worker.postMessage({ type: 'setConfig', data: { aoSphereImpostor: sphereCb.checked } });
                }
            };
            sphereRow.appendChild(sphereLabel);
            sphereRow.appendChild(sphereCb);
            popover.appendChild(sphereRow);

            // MPM Particle Diameter Controls (SI Units: meters)
            const autoDiam = this.getAutoParticleDiameter();
            const curDiam = Number(p.mpmParticleDiameter && p.mpmParticleDiameter > 0 ? p.mpmParticleDiameter : autoDiam);
            const mpmDiamRow = document.createElement('div');
            mpmDiamRow.style.display = 'flex';
            mpmDiamRow.style.flexDirection = 'column';
            mpmDiamRow.style.gap = '5px';
            mpmDiamRow.style.marginTop = '8px';
            mpmDiamRow.style.borderTop = '1px solid rgba(255,255,255,0.08)';
            mpmDiamRow.style.paddingTop = '6px';

            const diamHeader = document.createElement('div');
            diamHeader.style.display = 'flex';
            diamHeader.style.justifyContent = 'space-between';
            diamHeader.style.alignItems = 'center';

            const diamLabel = document.createElement('span');
            diamLabel.style.fontSize = '9px';
            diamLabel.style.color = '#aaa';
            diamLabel.textContent = `Sphere Diameter (m):`;

            diamHeader.appendChild(diamLabel);
            mpmDiamRow.appendChild(diamHeader);

            const formatSI = (d: number) => {
                if (!isFinite(d) || d <= 0) return '0 m';
                if (d >= 0.01) return `${d.toFixed(3)} m`;
                if (d >= 0.001) return `${d.toFixed(4).replace(/0+$/, '')} m`;
                if (d >= 0.0001) return `${d.toFixed(5).replace(/0+$/, '')} m`;
                return `${d.toExponential(2)} m`;
            };

            // Float input + Default button row
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
            this.applyButtonStyle(defaultBtn);
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
            diamSlider.style.width = '100%';

            const applyDiameter = (dVal: number) => {
                diamInput.value = String(dVal);
                diamSlider.value = String(Math.max(0.0001, Math.min(0.0500, dVal)));
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { mpmParticleDiameter: dVal });
                    this.worker.postMessage({ type: 'setConfig', data: { mpmParticleDiameter: dVal } });
                    this.syncControls(true);
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
            mpmDiamRow.appendChild(diamSlider);

            // Presets row in SI units (meters)
            const presetsRow = document.createElement('div');
            presetsRow.style.display = 'flex';
            presetsRow.style.gap = '3px';
            presetsRow.style.flexWrap = 'wrap';
            [0.0005, 0.001, 0.002, 0.0025, 0.005, 0.010, 0.020].forEach(pM => {
                const pBtn = document.createElement('button');
                pBtn.textContent = formatSI(pM);
                this.applyButtonStyle(pBtn);
                pBtn.style.fontSize = '8px';
                pBtn.style.padding = '1px 3px';
                pBtn.onclick = () => {
                    applyDiameter(pM);
                };
                presetsRow.appendChild(pBtn);
            });
            mpmDiamRow.appendChild(presetsRow);
            popover.appendChild(mpmDiamRow);
        });
    }

    private showGaugeSizePopover(targetEl: HTMLElement, currentVal: number, onChange: (val: number) => void) {
        this.showPopover(targetEl, (popover) => {
            popover.style.width = '210px';

            const title = document.createElement('div');
            title.textContent = '🎯 Gauge Sphere Size';
            title.style.fontWeight = 'bold';
            title.style.color = '#00adff';
            title.style.marginBottom = '4px';
            title.style.fontSize = '9px';
            title.style.textTransform = 'uppercase';
            popover.appendChild(title);

            const sub = document.createElement('div');
            sub.textContent = 'Size in multiples of cell size (dx):';
            sub.style.fontSize = '8.5px';
            sub.style.color = '#aaa';
            sub.style.marginBottom = '6px';
            popover.appendChild(sub);

            const grid = document.createElement('div');
            grid.style.display = 'grid';
            grid.style.gridTemplateColumns = '1fr 1fr 1fr';
            grid.style.gap = '4px';
            grid.style.marginBottom = '8px';

            const presets = [
                { val: 0.25, label: '0.25x' },
                { val: 0.50, label: '0.50x' },
                { val: 1.00, label: '1.00x' },
                { val: 1.50, label: '1.50x' },
                { val: 2.00, label: '2.00x' },
                { val: 3.00, label: '3.00x' }
            ];

            presets.forEach(p => {
                const btn = document.createElement('button');
                btn.textContent = p.label;
                this.applyButtonStyle(btn);
                btn.style.fontSize = '8.5px';
                btn.style.padding = '2px 0';
                if (Math.abs(p.val - currentVal) < 0.05) {
                    btn.style.background = '#007acc';
                    btn.style.borderColor = '#00adff';
                }
                btn.onclick = (e) => {
                    e.stopPropagation();
                    onChange(p.val);
                    this.closePopover();
                };
                grid.appendChild(btn);
            });
            popover.appendChild(grid);

            // Slider & Readout
            const sliderHeader = document.createElement('div');
            sliderHeader.style.display = 'flex';
            sliderHeader.style.justifyContent = 'space-between';
            sliderHeader.style.fontSize = '8.5px';
            sliderHeader.style.color = '#aaa';
            sliderHeader.style.marginBottom = '3px';

            const sliderLbl = document.createElement('span');
            sliderLbl.textContent = 'Multiplier:';
            const sliderValSpan = document.createElement('span');
            sliderValSpan.style.color = '#00adff';
            sliderValSpan.style.fontWeight = 'bold';
            sliderValSpan.textContent = `${currentVal.toFixed(2)}x cell`;

            sliderHeader.appendChild(sliderLbl);
            sliderHeader.appendChild(sliderValSpan);
            popover.appendChild(sliderHeader);

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = '0.1';
            slider.max = '5.0';
            slider.step = '0.05';
            slider.value = String(currentVal);
            slider.style.width = '100%';
            slider.style.accentColor = '#00adff';
            slider.style.cursor = 'pointer';
            slider.style.marginBottom = '8px';

            let numInp: HTMLInputElement | null = null;

            const updateVal = (v: number) => {
                sliderValSpan.textContent = `${v.toFixed(2)}x cell`;
                if (numInp) numInp.value = v.toFixed(2);
                onChange(v);
            };

            slider.oninput = () => {
                updateVal(Number(slider.value));
            };
            popover.appendChild(slider);

            // Exact numeric entry
            const customRow = document.createElement('div');
            customRow.style.display = 'flex';
            customRow.style.alignItems = 'center';
            customRow.style.gap = '6px';
            customRow.style.fontSize = '8.5px';

            const numLbl = document.createElement('span');
            numLbl.textContent = 'Exact (cell dx):';

            numInp = document.createElement('input');
            numInp.type = 'number';
            numInp.min = '0.05';
            numInp.max = '10.0';
            numInp.step = '0.05';
            numInp.value = currentVal.toFixed(2);
            this.applyInputStyle(numInp);
            numInp.style.width = '65px';
            numInp.style.fontSize = '9px';
            numInp.oninput = () => {
                const valStr = numInp!.value.trim();
                if (valStr !== '') {
                    const v = Number(valStr);
                    if (!isNaN(v) && v > 0) {
                        slider.value = String(v);
                        sliderValSpan.textContent = `${v.toFixed(2)}x cell`;
                        onChange(v);
                    }
                }
            };
            numInp.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    let v = Number(numInp!.value);
                    if (!isNaN(v) && v > 0) {
                        onChange(v);
                    }
                    this.closePopover();
                }
            };

            customRow.appendChild(numLbl);
            customRow.appendChild(numInp);
            popover.appendChild(customRow);
        });
    }

    private showSlicePositionPopover(targetEl: HTMLElement, sliceIndex: number, slice: any, meshNode: any) {
        this.showPopover(targetEl, (popover) => {
            popover.style.width = '250px';

            const title = document.createElement('div');
            title.style.fontWeight = 'bold';
            title.style.marginBottom = '6px';
            title.style.color = '#00adff';
            title.style.fontSize = '9px';
            title.style.textTransform = 'uppercase';
            title.innerHTML = `🔪 Slice #${sliceIndex + 1} Plane & Position`;
            popover.appendChild(title);

            // 1. Plane Buttons (XY, XZ, YZ)
            const planeLabel = document.createElement('div');
            planeLabel.style.fontSize = '8.5px';
            planeLabel.style.color = '#aaa';
            planeLabel.style.marginBottom = '3px';
            planeLabel.textContent = 'Slice Plane Orientation:';
            popover.appendChild(planeLabel);

            const planeRow = document.createElement('div');
            planeRow.style.display = 'flex';
            planeRow.style.gap = '4px';
            planeRow.style.marginBottom = '8px';

            const planes = [
                { id: 'yz', label: 'X-Normal' },
                { id: 'xz', label: 'Y-Normal' },
                { id: 'xy', label: 'Z-Normal' }
            ];

            let currentAxis = slice.axis || 'xy';
            const planeBtns: Record<string, HTMLButtonElement> = {};

            planes.forEach(p => {
                const btn = document.createElement('button');
                btn.textContent = p.label;
                this.applyButtonStyle(btn);
                btn.style.flex = '1';
                btn.style.fontSize = '8.5px';
                btn.style.padding = '3px 0';
                if (p.id === currentAxis) {
                    btn.style.background = '#007acc';
                    btn.style.borderColor = '#00adff';
                    btn.style.color = '#fff';
                }
                planeBtns[p.id] = btn;
                planeRow.appendChild(btn);
            });
            popover.appendChild(planeRow);

            // 2. Position Slider & Live Reading
            let bounds = getSliceBounds(currentAxis, meshNode);
            let curOffset = Number(slice.offset ?? (bounds.min + bounds.max) / 2.0);

            const posHeader = document.createElement('div');
            posHeader.style.display = 'flex';
            posHeader.style.justifyContent = 'space-between';
            posHeader.style.alignItems = 'center';
            posHeader.style.fontSize = '8.5px';
            posHeader.style.color = '#aaa';
            posHeader.style.marginBottom = '4px';

            const posLbl = document.createElement('span');
            posLbl.textContent = 'Offset Position:';
            const posValSpan = document.createElement('span');
            posValSpan.style.color = '#00adff';
            posValSpan.style.fontWeight = 'bold';
            posValSpan.textContent = `${curOffset.toFixed(3)} m`;

            posHeader.appendChild(posLbl);
            posHeader.appendChild(posValSpan);
            popover.appendChild(posHeader);

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = bounds.min.toString();
            slider.max = bounds.max.toString();
            slider.step = Math.max(0.0001, (bounds.max - bounds.min) / 200).toString();
            slider.value = String(curOffset);
            slider.style.width = '100%';
            slider.style.accentColor = '#00adff';
            slider.style.cursor = 'pointer';
            slider.style.marginBottom = '8px';

            let numInp: HTMLInputElement | null = null;
            const presetBtns: HTMLButtonElement[] = [];

            const updatePresetHighlights = (v: number) => {
                const span = bounds.max - bounds.min;
                const presets = [0.00, 0.25, 0.50, 0.75, 1.00];
                presetBtns.forEach((btn, pIdx) => {
                    const pVal = bounds.min + presets[pIdx] * span;
                    if (Math.abs(v - pVal) < Math.max(span * 0.02, 1e-4)) {
                        btn.style.background = '#007acc';
                        btn.style.borderColor = '#00adff';
                        btn.style.color = '#fff';
                    } else {
                        btn.style.background = '#25252a';
                        btn.style.borderColor = 'rgba(255, 255, 255, 0.12)';
                        btn.style.color = '#ffffff';
                    }
                });
            };

            const updatePos = (v: number, immediateNetwork: boolean = false) => {
                curOffset = v;
                posValSpan.textContent = `${v.toFixed(3)} m`;
                if (numInp && document.activeElement !== numInp) {
                    numInp.value = v.toFixed(3);
                }
                updatePresetHighlights(v);
                this.updateSliceProperty(sliceIndex, { offset: v }, immediateNetwork);
            };

            slider.oninput = () => {
                updatePos(Number(slider.value), false);
            };
            slider.onchange = () => {
                updatePos(Number(slider.value), true);
            };
            popover.appendChild(slider);

            // Plane button click event (updates in-place without closing popover)
            planes.forEach(p => {
                const btn = planeBtns[p.id];
                btn.onclick = (e) => {
                    e.stopPropagation();
                    if (currentAxis === p.id) return;
                    currentAxis = p.id;
                    planes.forEach(otherP => {
                        const otherBtn = planeBtns[otherP.id];
                        if (otherP.id === currentAxis) {
                            otherBtn.style.background = '#007acc';
                            otherBtn.style.borderColor = '#00adff';
                            otherBtn.style.color = '#fff';
                        } else {
                            otherBtn.style.background = '#25252a';
                            otherBtn.style.borderColor = 'rgba(255, 255, 255, 0.12)';
                            otherBtn.style.color = '#ffffff';
                        }
                    });

                    bounds = getSliceBounds(currentAxis, meshNode);
                    const newOffset = (bounds.min + bounds.max) / 2.0;
                    slider.min = bounds.min.toString();
                    slider.max = bounds.max.toString();
                    slider.step = Math.max(0.0001, (bounds.max - bounds.min) / 200).toString();
                    slider.value = String(newOffset);
                    if (numInp) {
                        numInp.min = bounds.min.toString();
                        numInp.max = bounds.max.toString();
                        numInp.value = newOffset.toFixed(3);
                    }
                    updatePos(newOffset, true);
                    this.updateSliceProperty(sliceIndex, { axis: currentAxis, offset: newOffset }, true);
                };
            });

            // 3. Quick Preset Percentages
            const presetRow = document.createElement('div');
            presetRow.style.display = 'flex';
            presetRow.style.gap = '3px';
            presetRow.style.marginBottom = '8px';

            const presets = [
                { frac: 0.00, label: '0%' },
                { frac: 0.25, label: '25%' },
                { frac: 0.50, label: '50%' },
                { frac: 0.75, label: '75%' },
                { frac: 1.00, label: '100%' }
            ];

            presets.forEach(pr => {
                const btn = document.createElement('button');
                btn.textContent = pr.label;
                this.applyButtonStyle(btn);
                btn.style.flex = '1';
                btn.style.fontSize = '8.5px';
                btn.style.padding = '2px 0';
                presetBtns.push(btn);

                btn.onclick = (e) => {
                    e.stopPropagation();
                    const pVal = bounds.min + pr.frac * (bounds.max - bounds.min);
                    slider.value = String(pVal);
                    updatePos(pVal, true);
                };
                presetRow.appendChild(btn);
            });
            updatePresetHighlights(curOffset);
            popover.appendChild(presetRow);

            // 4. Exact Value Entry
            const customRow = document.createElement('div');
            customRow.style.display = 'flex';
            customRow.style.alignItems = 'center';
            customRow.style.gap = '6px';
            customRow.style.fontSize = '8.5px';

            const numLbl = document.createElement('span');
            numLbl.textContent = 'Exact (m):';

            numInp = document.createElement('input');
            numInp.type = 'number';
            numInp.min = bounds.min.toString();
            numInp.max = bounds.max.toString();
            numInp.step = '0.001';
            numInp.value = curOffset.toFixed(3);
            this.applyInputStyle(numInp);
            numInp.style.width = '75px';
            numInp.style.fontSize = '9px';
            numInp.oninput = () => {
                const valStr = numInp!.value.trim();
                if (valStr !== '') {
                    const v = Number(valStr);
                    if (!isNaN(v)) {
                        const clamped = Math.max(bounds.min, Math.min(bounds.max, v));
                        slider.value = String(clamped);
                        updatePos(clamped, false);
                    }
                }
            };
            numInp.onchange = () => {
                const valStr = numInp!.value.trim();
                if (valStr !== '') {
                    const v = Number(valStr);
                    if (!isNaN(v)) {
                        const clamped = Math.max(bounds.min, Math.min(bounds.max, v));
                        slider.value = String(clamped);
                        updatePos(clamped, true);
                    }
                }
            };
            numInp.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    let v = Number(numInp!.value);
                    if (!isNaN(v)) {
                        v = Math.max(bounds.min, Math.min(bounds.max, v));
                        updatePos(v, true);
                    }
                    this.closePopover();
                }
            };

            customRow.appendChild(numLbl);
            customRow.appendChild(numInp);
            popover.appendChild(customRow);
        });
    }

    public setQuantityColormap(qty: string, cmap: string) {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        const cQty = canonicalizeQuantity(qty);
        const qCmaps = vpNode.parameters.quantity_colormaps ? { ...vpNode.parameters.quantity_colormaps } : {};
        qCmaps[cQty] = cmap;
        qCmaps[qty] = cmap;
        if (cQty === 'peak_overpressure') qCmaps['overpressure'] = cmap;
        if (cQty === 'peak_impulse') qCmaps['impulse'] = cmap;
        if (cQty === 'plastic_strain') qCmaps['plasticStrain'] = cmap;
        if (cQty === 'vonMises') qCmaps['von_mises'] = cmap;

        const slices = vpNode.parameters.slices ? [...vpNode.parameters.slices] : [];
        slices.forEach(s => {
            if (canonicalizeQuantity(s.quantities?.[0] || 'pressure') === cQty) {
                s.colormap = cmap;
            }
        });

        const updates: any = { quantity_colormaps: qCmaps, slices };
        if (canonicalizeQuantity(vpNode.parameters.stl_quantity || 'pressure') === cQty) {
            updates.stl_colormap = cmap;
        }
        if (canonicalizeQuantity(vpNode.parameters.obstacles_quantity || 'pressure') === cQty) {
            updates.obstacles_colormap = cmap;
        }
        if (canonicalizeQuantity(vpNode.parameters.mpmParticleQuantity || 'vonMises') === cQty) {
            updates.mpmParticleColormap = cmap;
        }
        if (canonicalizeQuantity(vpNode.parameters.femQuantity || 'vonMises') === cQty) {
            updates.femColormap = cmap;
        }
        if (canonicalizeQuantity(vpNode.parameters.beamQuantity || 'plasticStrain') === cQty) {
            updates.beamColormap = cmap;
        }

        this.stateManager.updateNodeParametersInPlace(vpNode.id, updates);
        const stlNode = this.getGeometryNode();
        if (stlNode && stlNode.type === 'STLGeometry') {
            this.stateManager.updateNodeParametersInPlace(stlNode.id, { stl_colormap: cmap, colormap: cmap });
        }
        this.needsSlicesRebuild = true;
        this.worker.postMessage({
            type: 'setConfig',
            data: {
                quantityColormaps: qCmaps,
                slices,
                stlColormap: updates.stl_colormap,
                obstaclesColormap: updates.obstacles_colormap,
                mpmParticleColormap: updates.mpmParticleColormap,
                femColormap: updates.femColormap,
                beamColormap: updates.beamColormap
            }
        });
        this.syncControls(false);
    }

    public setQuantityLogScale(qty: string, logV: boolean) {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        const cQty = canonicalizeQuantity(qty);
        const qLogScales = vpNode.parameters.quantity_log_scales ? { ...vpNode.parameters.quantity_log_scales } : {};
        qLogScales[cQty] = logV;
        qLogScales[qty] = logV;
        if (cQty === 'peak_overpressure') qLogScales['overpressure'] = logV;
        if (cQty === 'peak_impulse') qLogScales['impulse'] = logV;
        if (cQty === 'plastic_strain') qLogScales['plasticStrain'] = logV;
        if (cQty === 'vonMises') qLogScales['von_mises'] = logV;

        const slices = vpNode.parameters.slices ? [...vpNode.parameters.slices] : [];
        slices.forEach(s => {
            if (canonicalizeQuantity(s.quantities?.[0] || 'pressure') === cQty) {
                s.log_scale = logV;
            }
        });

        const updates: any = { quantity_log_scales: qLogScales, slices };
        if (canonicalizeQuantity(vpNode.parameters.stl_quantity || 'pressure') === cQty) {
            updates.stl_log_scale = logV;
        }
        if (canonicalizeQuantity(vpNode.parameters.obstacles_quantity || 'pressure') === cQty) {
            updates.obstacles_log_scale = logV;
        }
        if (canonicalizeQuantity(vpNode.parameters.mpmParticleQuantity || 'vonMises') === cQty) {
            updates.mpmParticleLogScale = logV;
        }
        if (canonicalizeQuantity(vpNode.parameters.femQuantity || 'vonMises') === cQty) {
            updates.femLogScale = logV;
        }
        if (canonicalizeQuantity(vpNode.parameters.beamQuantity || 'plasticStrain') === cQty) {
            updates.beamLogScale = logV;
        }

        this.stateManager.updateNodeParametersInPlace(vpNode.id, updates);
        const stlNode = this.getGeometryNode();
        if (stlNode && stlNode.type === 'STLGeometry') {
            this.stateManager.updateNodeParametersInPlace(stlNode.id, { stl_log_scale: logV });
        }
        this.needsSlicesRebuild = true;
        this.worker.postMessage({
            type: 'setConfig',
            data: {
                quantityLogScales: qLogScales,
                slices,
                stlLogScale: updates.stl_log_scale,
                obstaclesLogScale: updates.obstacles_log_scale,
                mpmParticleLogScale: updates.mpmParticleLogScale,
                femLogScale: updates.femLogScale,
                beamLogScale: updates.beamLogScale
            }
        });
        this.syncControls(false);
    }

    public setQuantityAutoScale(qty: string, autoV: boolean) {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        const cQty = canonicalizeQuantity(qty);
        const qAutoScales = vpNode.parameters.quantity_auto_scales ? { ...vpNode.parameters.quantity_auto_scales } : {};
        qAutoScales[cQty] = autoV;
        qAutoScales[qty] = autoV;
        if (cQty === 'peak_overpressure') qAutoScales['overpressure'] = autoV;
        if (cQty === 'peak_impulse') qAutoScales['impulse'] = autoV;
        if (cQty === 'plastic_strain') qAutoScales['plasticStrain'] = autoV;
        if (cQty === 'vonMises') qAutoScales['von_mises'] = autoV;

        const slices = vpNode.parameters.slices ? [...vpNode.parameters.slices] : [];
        slices.forEach(s => {
            if (canonicalizeQuantity(s.quantities?.[0] || 'pressure') === cQty) {
                s.auto_scale = autoV;
            }
        });

        const updates: any = { quantity_auto_scales: qAutoScales, slices };
        if (canonicalizeQuantity(vpNode.parameters.stl_quantity || 'pressure') === cQty) {
            updates.stl_auto_scale = autoV;
        }
        if (canonicalizeQuantity(vpNode.parameters.obstacles_quantity || 'pressure') === cQty) {
            updates.obstacles_auto_scale = autoV;
        }
        if (canonicalizeQuantity(vpNode.parameters.mpmParticleQuantity || 'vonMises') === cQty) {
            updates.mpmParticleAutoScale = autoV;
        }
        if (canonicalizeQuantity(vpNode.parameters.femQuantity || 'vonMises') === cQty) {
            updates.femAutoScale = autoV;
        }
        if (canonicalizeQuantity(vpNode.parameters.beamQuantity || 'plasticStrain') === cQty) {
            updates.beamAutoScale = autoV;
        }

        this.stateManager.updateNodeParametersInPlace(vpNode.id, updates);
        const stlNode = this.getGeometryNode();
        if (stlNode && stlNode.type === 'STLGeometry') {
            this.stateManager.updateNodeParametersInPlace(stlNode.id, { stl_auto_scale: autoV });
        }
        this.needsSlicesRebuild = true;
        this.worker.postMessage({
            type: 'setConfig',
            data: {
                quantityAutoScales: qAutoScales,
                slices,
                stlAutoScale: updates.stl_auto_scale,
                obstaclesAutoScale: updates.obstacles_auto_scale,
                mpmParticleAutoScale: updates.mpmParticleAutoScale,
                femAutoScale: updates.femAutoScale,
                beamAutoScale: updates.beamAutoScale
            }
        });
        this.syncControls(false);
    }

    public setQuantityRange(qty: string, minV: number, maxV: number, autoV: boolean = false, logV?: boolean, interpV?: boolean) {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        const cQty = canonicalizeQuantity(qty);

        const qRanges = vpNode.parameters.quantity_ranges ? { ...vpNode.parameters.quantity_ranges } : {};
        qRanges[cQty] = [minV, maxV];
        qRanges[qty] = [minV, maxV];
        if (cQty === 'peak_overpressure') qRanges['overpressure'] = [minV, maxV];
        if (cQty === 'peak_impulse') qRanges['impulse'] = [minV, maxV];
        if (cQty === 'plastic_strain') qRanges['plasticStrain'] = [minV, maxV];
        if (cQty === 'vonMises') qRanges['von_mises'] = [minV, maxV];

        const qAutoScales = vpNode.parameters.quantity_auto_scales ? { ...vpNode.parameters.quantity_auto_scales } : {};
        qAutoScales[cQty] = autoV;
        qAutoScales[qty] = autoV;
        if (cQty === 'peak_overpressure') qAutoScales['overpressure'] = autoV;
        if (cQty === 'peak_impulse') qAutoScales['impulse'] = autoV;
        if (cQty === 'plastic_strain') qAutoScales['plasticStrain'] = autoV;
        if (cQty === 'vonMises') qAutoScales['von_mises'] = autoV;

        const qLogScales = vpNode.parameters.quantity_log_scales ? { ...vpNode.parameters.quantity_log_scales } : {};
        if (logV !== undefined) {
            qLogScales[cQty] = logV;
            qLogScales[qty] = logV;
            if (cQty === 'peak_overpressure') qLogScales['overpressure'] = logV;
            if (cQty === 'peak_impulse') qLogScales['impulse'] = logV;
            if (cQty === 'plastic_strain') qLogScales['plasticStrain'] = logV;
            if (cQty === 'vonMises') qLogScales['von_mises'] = logV;
        }

        const slices = vpNode.parameters.slices ? [...vpNode.parameters.slices] : [];
        slices.forEach(s => {
            if (canonicalizeQuantity(s.quantities?.[0] || 'pressure') === cQty) {
                s.min_val = minV;
                s.max_val = maxV;
                s.auto_scale = autoV;
                if (logV !== undefined) {
                    s.log_scale = logV;
                }
                if (interpV !== undefined) {
                    s.interpolate = interpV;
                }
            }
        });

        const updates: any = { quantity_ranges: qRanges, quantity_auto_scales: qAutoScales, slices };
        if (logV !== undefined) {
            updates.quantity_log_scales = qLogScales;
        }
        if (canonicalizeQuantity(vpNode.parameters.stl_quantity || 'pressure') === cQty) {
            updates.stl_min_val = minV;
            updates.stl_max_val = maxV;
            updates.stl_auto_scale = autoV;
            if (logV !== undefined) updates.stl_log_scale = logV;
            if (interpV !== undefined) updates.stl_sampling_mode = interpV ? 'linear' : 'nearest';
        }
        if (canonicalizeQuantity(vpNode.parameters.obstacles_quantity || 'pressure') === cQty) {
            updates.obstacles_min_val = minV;
            updates.obstacles_max_val = maxV;
            updates.obstacles_auto_scale = autoV;
            if (logV !== undefined) updates.obstacles_log_scale = logV;
            if (interpV !== undefined) updates.obstacles_interpolate = interpV;
        }
        if (canonicalizeQuantity(vpNode.parameters.mpmParticleQuantity || 'vonMises') === cQty) {
            updates.mpmParticleMinVal = minV;
            updates.mpmParticleMaxVal = maxV;
            updates.mpmParticleAutoScale = autoV;
            if (logV !== undefined) updates.mpmParticleLogScale = logV;
        }
        if (canonicalizeQuantity(vpNode.parameters.femQuantity || 'vonMises') === cQty) {
            updates.femMinVal = minV;
            updates.femMaxVal = maxV;
            updates.femAutoScale = autoV;
            if (logV !== undefined) updates.femLogScale = logV;
        }
        if (canonicalizeQuantity(vpNode.parameters.beamQuantity || 'plasticStrain') === cQty) {
            updates.beamMinVal = minV;
            updates.beamMaxVal = maxV;
            updates.beamAutoScale = autoV;
            if (logV !== undefined) updates.beamLogScale = logV;
        }
        if (!this.latestQuantityRanges) this.latestQuantityRanges = {};
        this.latestQuantityRanges[cQty] = [minV, maxV];
        this.latestQuantityRanges[qty] = [minV, maxV];

        this.stateManager.updateNodeParametersInPlace(vpNode.id, updates);
        const stlNode = this.getGeometryNode();
        if (stlNode && stlNode.type === 'STLGeometry') {
            this.stateManager.updateNodeParametersInPlace(stlNode.id, {
                stl_min_val: minV,
                stl_max_val: maxV,
                stl_auto_scale: autoV,
                ...(logV !== undefined ? { stl_log_scale: logV } : {})
            });
        }
        this.needsSlicesRebuild = true;
        this.worker.postMessage({
            type: 'setConfig',
            data: {
                quantityRanges: qRanges,
                quantityAutoScales: qAutoScales,
                quantityLogScales: qLogScales,
                slices,
                stlMinVal: updates.stl_min_val,
                stlMaxVal: updates.stl_max_val,
                stlAutoScale: updates.stl_auto_scale,
                stlLogScale: updates.stl_log_scale,
                obstaclesMinVal: updates.obstacles_min_val,
                obstaclesMaxVal: updates.obstacles_max_val,
                obstaclesAutoScale: updates.obstacles_auto_scale,
                obstaclesLogScale: updates.obstacles_log_scale,
                mpmParticleMinVal: updates.mpmParticleMinVal,
                mpmParticleMaxVal: updates.mpmParticleMaxVal,
                mpmParticleAutoScale: updates.mpmParticleAutoScale,
                mpmParticleLogScale: updates.mpmParticleLogScale,
                femMinVal: updates.femMinVal,
                femMaxVal: updates.femMaxVal,
                femAutoScale: updates.femAutoScale,
                femLogScale: updates.femLogScale,
                beamMinVal: updates.beamMinVal,
                beamMaxVal: updates.beamMaxVal,
                beamAutoScale: updates.beamAutoScale,
                beamLogScale: updates.beamLogScale
            }
        });
        this.syncControls(false);
    }

    private syncToggleBtnState(btn: HTMLElement | null, checked: boolean) {
        if (!btn) return;
        btn.dataset.checked = checked ? 'true' : 'false';
        btn.style.background = checked ? '#007acc' : 'transparent';
        btn.style.border = checked ? '1px solid #007acc' : '1px solid rgba(255,255,255,0.2)';
        btn.style.color = checked ? '#fff' : '#ccc';
    }

    private createToggleBtn(idStr: string, text: string, checked: boolean, onChange: (v: boolean) => void) {
        const btn = document.createElement('div');
        btn.id = this.getElId(idStr);
        btn.innerText = text;
        btn.dataset.checked = checked ? 'true' : 'false';
        
        const updateStyle = () => {
            const isChecked = btn.dataset.checked === 'true';
            btn.style.background = isChecked ? '#007acc' : 'transparent';
            btn.style.border = isChecked ? '1px solid #007acc' : '1px solid rgba(255,255,255,0.2)';
            btn.style.color = isChecked ? '#fff' : '#ccc';
        };
        
        updateStyle();
        btn.style.borderRadius = '3px';
        btn.style.padding = '2px 0px';
        btn.style.fontSize = '8px';
        btn.style.cursor = 'pointer';
        btn.style.textAlign = 'center';
        btn.style.userSelect = 'none';
        btn.style.width = '100%';
        btn.style.boxSizing = 'border-box';
        
        btn.onclick = (e: MouseEvent) => {
            e.stopPropagation();
            const nextState = btn.dataset.checked !== 'true';
            btn.dataset.checked = nextState ? 'true' : 'false';
            updateStyle();
            onChange(nextState);
        };
        this.bindEditingEvents(btn);
        return btn;
    }

    private buildObstacleRow(parent: HTMLElement) {
        const vpNode = this.getViewportNode();
        const initShow = vpNode ? (vpNode.parameters.show_obstacles !== false) : true;
        const initGrid = vpNode ? (vpNode.parameters.obstacles_gridlines !== false) : true;
        const initSolid = vpNode ? (vpNode.parameters.obstacles_solid !== false) : true;
        const initLight = vpNode ? (vpNode.parameters.obstacles_lighting !== false) : true;
        const initOpacity = vpNode ? (vpNode.parameters.obstacles_opacity ?? 1.0) : 1.0;
        const initQty = vpNode ? (vpNode.parameters.obstacles_quantity || 'pressure') : 'pressure';
        const initCmap = vpNode ? (vpNode.parameters.quantity_colormaps?.[initQty] || vpNode.parameters.obstacles_colormap || 'rainbow') : 'rainbow';

        const qRanges = vpNode?.parameters.quantity_ranges || {};
        const qtyRange = qRanges[initQty] || [101325.0, 1013250.0];
        const initAuto = vpNode ? (vpNode.parameters.obstacles_auto_scale !== false) : true;
        const initLog = vpNode ? (vpNode.parameters.obstacles_log_scale === true) : false;

        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

        // Col 1: Vis Checkbox
        const tdVis = document.createElement('td');
        tdVis.style.padding = '3px 2px';
        tdVis.style.textAlign = 'center';
        const showCb = document.createElement('input');
        showCb.type = 'checkbox';
        showCb.id = this.getElId('viewport-obs-show-cb');
        showCb.checked = initShow;
        showCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { show_obstacles: showCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { showObstacles: showCb.checked } });
                this.sendView3DConfig();
            }
        };
        this.bindEditingEvents(showCb);
        tdVis.appendChild(showCb);
        tr.appendChild(tdVis);

        // Col 2: Layer Title
        const tdLayer = document.createElement('td');
        tdLayer.style.padding = '3px 4px';
        tdLayer.innerHTML = '🧱 <b>Obstacles</b>';
        tr.appendChild(tdLayer);

        const appendToggleCol = (text: string, id: string, init: boolean, onChange: (v: boolean) => void) => {
            const td = document.createElement('td');
            td.style.padding = '3px 2px';
            td.appendChild(this.createToggleBtn(id, text, init, onChange));
            tr.appendChild(td);
        };

        // Col 3: SOL (Solid obstacles)
        appendToggleCol('Sol', 'viewport-obs-solid-btn', initSolid, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { obstacles_solid: v });
                this.worker.postMessage({ type: 'setConfig', data: { obstaclesSolid: v } });
            }
        });
        // Col 4: LINES (Obstacle surface gridlines)
        appendToggleCol('Msh', 'viewport-obs-grid-btn', initGrid, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { obstacles_gridlines: v });
                this.worker.postMessage({ type: 'setConfig', data: { obstaclesGridlines: v } });
            }
        });
        // Col 5: RES (Obstacle lighting)
        appendToggleCol('Lgt', 'viewport-obs-light-btn', initLight, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { obstacles_lighting: v });
                this.worker.postMessage({ type: 'setConfig', data: { obstaclesLighting: v } });
            }
        });

        // Col 6: QTY (Quantity Popover Pill)
        const tdQty = document.createElement('td');
        tdQty.style.padding = '3px 4px';
        const qtyPill = document.createElement('button');
        const qtyLabels: Record<string, string> = {
            pressure: 'Press', density: 'Density', velocity: 'Speed', energy: 'Energy',
            species1: 'Reacted', species2: 'Unreacted', species3: 'Air',
            overpressure: 'Overpress', peak_overpressure: 'Pk Overpress', peak_impulse: 'Pk Impulse', amr_level: 'AMR Level'
        };
        qtyPill.textContent = `${qtyLabels[initQty] || initQty} ▾`;
        this.applyButtonStyle(qtyPill);
        qtyPill.style.fontSize = '8.5px';
        qtyPill.style.width = '100%';
        qtyPill.style.padding = '2px 0';
        qtyPill.onclick = (e) => {
            e.stopPropagation();
            const currentQty = this.getViewportNode()?.parameters.obstacles_quantity || 'pressure';
            this.showQuantityPopover(qtyPill, currentQty, 'cfd', (newQ) => {
                const vp = this.getViewportNode();
                if (vp) {
                    const qCmaps = vp.parameters.quantity_colormaps || {};
                    const newCmap = qCmaps[newQ] || 'rainbow';
                    const qRanges = vp.parameters.quantity_ranges || {};
                    const newRange = qRanges[newQ] || DEFAULT_QUANTITY_RANGES[newQ] || [0.0, 1.0];
                    this.stateManager.updateNodeParametersInPlace(vp.id, {
                        obstacles_quantity: newQ,
                        obstacles_colormap: newCmap,
                        obstacles_min_val: newRange[0],
                        obstacles_max_val: newRange[1]
                    });
                    this.worker.postMessage({
                        type: 'setConfig',
                        data: {
                            obstaclesQuantity: newQ,
                            obstaclesColormap: newCmap,
                            obstaclesMinVal: newRange[0],
                            obstaclesMaxVal: newRange[1]
                        }
                    });
                    this.sendView3DConfig();
                    this.syncControls(true);
                }
            });
        };
        tdQty.appendChild(qtyPill);
        tr.appendChild(tdQty);

        // Col 7: COLOR (Colormap Popover Button + Colorbar Toggle)
        const tdCmap = document.createElement('td');
        tdCmap.style.padding = '3px 4px';
        const cmapWrap = document.createElement('div');
        cmapWrap.style.display = 'flex';
        cmapWrap.style.gap = '3px';
        cmapWrap.style.alignItems = 'center';

        const cmapPill = document.createElement('button');
        cmapPill.textContent = `${initCmap.charAt(0).toUpperCase() + initCmap.slice(1)} ▾`;
        this.applyButtonStyle(cmapPill);
        cmapPill.style.fontSize = '8.5px';
        cmapPill.style.flex = '1';
        cmapPill.style.padding = '2px 0';
        cmapPill.onclick = (e) => {
            e.stopPropagation();
            const vp = this.getViewportNode();
            const activeQty = vp?.parameters.obstacles_quantity || 'pressure';
            const curCmap = vp?.parameters.quantity_colormaps?.[activeQty] || vp?.parameters.obstacles_colormap || 'rainbow';
            this.showColormapPopover(cmapPill, curCmap, (newC) => {
                this.setQuantityColormap(activeQty, newC);
            });
        };
        cmapWrap.appendChild(cmapPill);

        const initCbShow = vpNode ? (vpNode.parameters.obstacles_show_colorbar === true) : false;
        const cbToggleBtn = this.createToggleBtn('viewport-obs-cb-btn', '🎨', initCbShow, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { obstacles_show_colorbar: v });
                this.syncControls(true);
            }
        });
        cbToggleBtn.style.width = '20px';
        cbToggleBtn.title = 'Toggle Color Bar for Obstacles in 3D Viewport';
        cmapWrap.appendChild(cbToggleBtn);

        tdCmap.appendChild(cmapWrap);
        tr.appendChild(tdCmap);

        // Col 8: SCL (Auto, Log & Range Popover)
        const tdScl = document.createElement('td');
        tdScl.style.padding = '3px 2px';
        const sclWrap = document.createElement('div');
        sclWrap.style.display = 'flex';
        sclWrap.style.gap = '2px';
        sclWrap.appendChild(this.createToggleBtn('viewport-obs-auto-btn', 'A', initAuto, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                const activeQty = vp.parameters.obstacles_quantity || 'pressure';
                const curRange = vp.parameters.quantity_ranges?.[activeQty] || [101325.0, 1013250.0];
                this.setQuantityRange(activeQty, curRange[0], curRange[1], v, initLog);
            }
        }));
        sclWrap.appendChild(this.createToggleBtn('viewport-obs-log-btn', 'L', initLog, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                const activeQty = vp.parameters.obstacles_quantity || 'pressure';
                const curRange = vp.parameters.quantity_ranges?.[activeQty] || [101325.0, 1013250.0];
                this.setQuantityRange(activeQty, curRange[0], curRange[1], initAuto, v);
            }
        }));

        const cfgBtn = this.createToggleBtn('viewport-obs-cfg-btn', '⚙️', false, () => {
            const vp = this.getViewportNode();
            if (vp) {
                const activeQty = vp.parameters.obstacles_quantity || 'pressure';
                const curRange = vp.parameters.quantity_ranges?.[activeQty] || [101325.0, 1013250.0];
                const autoV = vp.parameters.obstacles_auto_scale !== false;
                const logV = vp.parameters.obstacles_log_scale === true;
                this.showRangePopover(cfgBtn, activeQty, curRange[0], curRange[1], autoV, logV, (minV, maxV, autoVal, logVal) => {
                    this.setQuantityRange(activeQty, minV, maxV, autoVal, logVal);
                });
            }
        });
        sclWrap.appendChild(cfgBtn);
        tdScl.appendChild(sclWrap);
        tr.appendChild(tdScl);

        // Col 9: OPACITY (Opacity Popover)
        const tdOpac = document.createElement('td');
        tdOpac.style.padding = '3px 4px';
        const opacPill = document.createElement('button');
        opacPill.textContent = `${Math.round(initOpacity * 100)}% ▾`;
        this.applyButtonStyle(opacPill);
        opacPill.style.fontSize = '8.5px';
        opacPill.style.width = '100%';
        opacPill.style.padding = '2px 0';
        opacPill.onclick = (e) => {
            e.stopPropagation();
            const curVal = this.getViewportNode()?.parameters.obstacles_opacity ?? 1.0;
            this.showOpacityPopover(opacPill, curVal, (newOpac) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { obstacles_opacity: newOpac });
                    this.worker.postMessage({ type: 'setConfig', data: { obstaclesOpacity: newOpac } });
                    opacPill.textContent = `${Math.round(newOpac * 100)}% ▾`;
                }
            });
        };
        tdOpac.appendChild(opacPill);
        tr.appendChild(tdOpac);

        // Col 10: Empty Delete Cell
        const tdDel = document.createElement('td');
        tdDel.innerHTML = '<span style="color:#444;">—</span>';
        tdDel.style.textAlign = 'center';
        tr.appendChild(tdDel);

        parent.appendChild(tr);
    }

    private buildSTLRow(parent: HTMLElement) {
        const vpNode = this.getViewportNode();
        const initShow = vpNode ? (vpNode.parameters.show_stl !== false) : true;
        const initWf = vpNode ? (!!vpNode.parameters.stl_wireframe) : false;
        const initSolids = vpNode ? (vpNode.parameters.stl_solids !== false) : true;
        const initOpacity = vpNode ? (vpNode.parameters.stl_opacity ?? 0.5) : 0.5;
        const initShowResults = vpNode ? (vpNode.parameters.stl_show_results !== false) : true;
        const initQty = vpNode ? (vpNode.parameters.stl_quantity || 'pressure') : 'pressure';
        const initCmap = vpNode ? (vpNode.parameters.quantity_colormaps?.[initQty] || vpNode.parameters.stl_colormap || 'rainbow') : 'rainbow';

        const qRanges = vpNode?.parameters.quantity_ranges || {};
        const qtyRange = qRanges[initQty] || [101325.0, 1013250.0];
        const initAuto = vpNode ? (vpNode.parameters.stl_auto_scale !== false) : true;
        const initLog = vpNode ? (vpNode.parameters.stl_log_scale === true) : false;

        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

        // Col 1: Vis Checkbox
        const tdVis = document.createElement('td');
        tdVis.style.padding = '3px 2px';
        tdVis.style.textAlign = 'center';
        const showCb = document.createElement('input');
        showCb.type = 'checkbox';
        showCb.id = this.getElId('viewport-stl-show-cb');
        showCb.checked = initShow;
        showCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { show_stl: showCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { showSTL: showCb.checked } });
                this.sendView3DConfig();
            }
        };
        this.bindEditingEvents(showCb);
        tdVis.appendChild(showCb);
        tr.appendChild(tdVis);

        // Col 2: Layer Title
        const tdLayer = document.createElement('td');
        tdLayer.style.padding = '3px 4px';
        tdLayer.innerHTML = '📐 <b>STL Mesh</b>';
        tr.appendChild(tdLayer);

        const appendToggleCol = (text: string, id: string, init: boolean, onChange: (v: boolean) => void) => {
            const td = document.createElement('td');
            td.style.padding = '3px 2px';
            td.appendChild(this.createToggleBtn(id, text, init, onChange));
            tr.appendChild(td);
        };

        // Col 3: SOL (Solid geometry shading)
        appendToggleCol('Sol', 'viewport-stl-solids-btn', initSolids, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { stl_solids: v });
                this.worker.postMessage({ type: 'setConfig', data: { stlSolids: v } });
            }
        });
        // Col 4: LINES (Wireframe lines)
        appendToggleCol('Wir', 'viewport-stl-wf-btn', initWf, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { stl_wireframe: v });
                this.worker.postMessage({ type: 'setConfig', data: { stlWireframe: v } });
            }
        });
        // Col 5: RES (Surface contour results shading)
        appendToggleCol('Res', 'viewport-stl-show-results-btn', initShowResults, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { stl_show_results: v });
                this.worker.postMessage({ type: 'setConfig', data: { stlShowResults: v } });
                this.sendView3DConfig();
            }
        });

        // Col 6: QTY (Quantity Popover Pill)
        const tdQty = document.createElement('td');
        tdQty.style.padding = '3px 4px';
        const qtyPill = document.createElement('button');
        const qtyLabels: Record<string, string> = {
            pressure: 'Press', density: 'Density', velocity: 'Speed', energy: 'Energy',
            species1: 'Reacted', species2: 'Unreacted', species3: 'Air',
            overpressure: 'Overpress', peak_overpressure: 'Pk Overpress', peak_impulse: 'Pk Impulse', amr_level: 'AMR Level'
        };
        qtyPill.textContent = `${qtyLabels[initQty] || initQty} ▾`;
        this.applyButtonStyle(qtyPill);
        qtyPill.style.fontSize = '8.5px';
        qtyPill.style.width = '100%';
        qtyPill.style.padding = '2px 0';
        qtyPill.onclick = (e) => {
            e.stopPropagation();
            const currentQty = this.getViewportNode()?.parameters.stl_quantity || 'pressure';
            this.showQuantityPopover(qtyPill, currentQty, 'cfd', (newQ) => {
                const vp = this.getViewportNode();
                if (vp) {
                    const qCmaps = vp.parameters.quantity_colormaps || {};
                    const newCmap = qCmaps[newQ] || 'rainbow';
                    const qRanges = vp.parameters.quantity_ranges || {};
                    const newRange = qRanges[newQ] || DEFAULT_QUANTITY_RANGES[newQ] || [0.0, 1.0];
                    this.stateManager.updateNodeParametersInPlace(vp.id, {
                        stl_quantity: newQ,
                        stl_colormap: newCmap,
                        stl_min_val: newRange[0],
                        stl_max_val: newRange[1]
                    });
                    this.worker.postMessage({
                        type: 'setConfig',
                        data: {
                            stlQuantity: newQ,
                            stlColormap: newCmap,
                            stlMinVal: newRange[0],
                            stlMaxVal: newRange[1]
                        }
                    });
                    this.sendView3DConfig();
                    this.syncControls(true);
                }
            });
        };
        tdQty.appendChild(qtyPill);
        tr.appendChild(tdQty);

        // Col 7: COLOR (Colormap Popover Button + Colorbar Toggle)
        const tdCmap = document.createElement('td');
        tdCmap.style.padding = '3px 4px';
        const cmapWrap = document.createElement('div');
        cmapWrap.style.display = 'flex';
        cmapWrap.style.gap = '3px';
        cmapWrap.style.alignItems = 'center';

        const cmapPill = document.createElement('button');
        cmapPill.textContent = `${initCmap.charAt(0).toUpperCase() + initCmap.slice(1)} ▾`;
        this.applyButtonStyle(cmapPill);
        cmapPill.style.fontSize = '8.5px';
        cmapPill.style.flex = '1';
        cmapPill.style.padding = '2px 0';
        cmapPill.onclick = (e) => {
            e.stopPropagation();
            const vp = this.getViewportNode();
            const activeQty = vp?.parameters.stl_quantity || 'pressure';
            const curCmap = vp?.parameters.quantity_colormaps?.[activeQty] || vp?.parameters.stl_colormap || 'rainbow';
            this.showColormapPopover(cmapPill, curCmap, (newC) => {
                this.setQuantityColormap(activeQty, newC);
            });
        };
        cmapWrap.appendChild(cmapPill);

        const initCbShow = vpNode ? (vpNode.parameters.stl_show_colorbar === true) : false;
        const cbToggleBtn = this.createToggleBtn('viewport-stl-cb-btn', '🎨', initCbShow, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { stl_show_colorbar: v });
                this.syncControls(true);
            }
        });
        cbToggleBtn.style.width = '20px';
        cbToggleBtn.title = 'Toggle Color Bar for STL Mesh in 3D Viewport';
        cmapWrap.appendChild(cbToggleBtn);

        tdCmap.appendChild(cmapWrap);
        tr.appendChild(tdCmap);

        // Col 8: SCL (Auto, Log & Range Popover)
        const tdScl = document.createElement('td');
        tdScl.style.padding = '3px 2px';
        const sclWrap = document.createElement('div');
        sclWrap.style.display = 'flex';
        sclWrap.style.gap = '2px';
        sclWrap.appendChild(this.createToggleBtn('viewport-stl-autoscale-btn', 'A', initAuto, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                const activeQty = vp.parameters.stl_quantity || 'pressure';
                const curRange = vp.parameters.quantity_ranges?.[activeQty] || [101325.0, 1013250.0];
                this.setQuantityRange(activeQty, curRange[0], curRange[1], v, initLog);
            }
        }));
        sclWrap.appendChild(this.createToggleBtn('viewport-stl-logscale-btn', 'L', initLog, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                const activeQty = vp.parameters.stl_quantity || 'pressure';
                const curRange = vp.parameters.quantity_ranges?.[activeQty] || [101325.0, 1013250.0];
                this.setQuantityRange(activeQty, curRange[0], curRange[1], initAuto, v);
            }
        }));

        const cfgBtn = this.createToggleBtn('viewport-stl-cfg-btn', '⚙️', false, () => {
            const vp = this.getViewportNode();
            if (vp) {
                const activeQty = vp.parameters.stl_quantity || 'pressure';
                const curRange = vp.parameters.quantity_ranges?.[activeQty] || [101325.0, 1013250.0];
                const autoV = vp.parameters.stl_auto_scale !== false;
                const logV = vp.parameters.stl_log_scale === true;
                this.showRangePopover(cfgBtn, activeQty, curRange[0], curRange[1], autoV, logV, (minV, maxV, autoVal, logVal) => {
                    this.setQuantityRange(activeQty, minV, maxV, autoVal, logVal);
                });
            }
        });
        sclWrap.appendChild(cfgBtn);
        tdScl.appendChild(sclWrap);
        tr.appendChild(tdScl);

        // Col 9: OPACITY (Opacity Popover)
        const tdOpac = document.createElement('td');
        tdOpac.style.padding = '3px 4px';
        const opacPill = document.createElement('button');
        opacPill.textContent = `${Math.round(initOpacity * 100)}% ▾`;
        this.applyButtonStyle(opacPill);
        opacPill.style.fontSize = '8.5px';
        opacPill.style.width = '100%';
        opacPill.style.padding = '2px 0';
        opacPill.onclick = (e) => {
            e.stopPropagation();
            const curVal = this.getViewportNode()?.parameters.stl_opacity ?? 0.5;
            this.showOpacityPopover(opacPill, curVal, (newOpac) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { stl_opacity: newOpac });
                    this.worker.postMessage({ type: 'setConfig', data: { stlOpacity: newOpac } });
                    opacPill.textContent = `${Math.round(newOpac * 100)}% ▾`;
                }
            });
        };
        tdOpac.appendChild(opacPill);
        tr.appendChild(tdOpac);

        // Col 10: Empty Delete Cell
        const tdDel = document.createElement('td');
        tdDel.innerHTML = '<span style="color:#444;">—</span>';
        tdDel.style.textAlign = 'center';
        tr.appendChild(tdDel);

        parent.appendChild(tr);
    }



    private buildChargeRow(parent: HTMLElement) {
        const vpNode = this.getViewportNode();
        const initShow = vpNode ? (vpNode.parameters.show_charge !== false) : true;
        const initSolid = vpNode ? (vpNode.parameters.charge_solid !== false) : true;
        const initWf = vpNode ? (vpNode.parameters.charge_wireframe !== false) : true;
        const initLight = vpNode ? (vpNode.parameters.charge_lighting !== false) : true;
        const initOpacity = vpNode ? (vpNode.parameters.charge_opacity ?? 0.65) : 0.65;

        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

        const tdVis = document.createElement('td');
        tdVis.style.padding = '3px 2px';
        tdVis.style.textAlign = 'center';
        const showCb = document.createElement('input');
        showCb.type = 'checkbox';
        showCb.id = this.getElId('viewport-charge-show-cb');
        showCb.checked = initShow;
        showCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { show_charge: showCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { showCharge: showCb.checked } });
                this.sendView3DConfig();
            }
        };
        this.bindEditingEvents(showCb);
        tdVis.appendChild(showCb);
        tr.appendChild(tdVis);

        const tdLayer = document.createElement('td');
        tdLayer.style.padding = '3px 4px';
        tdLayer.innerHTML = '💥 <b>Charge</b>';
        tr.appendChild(tdLayer);

        const appendToggleCol = (text: string, id: string, init: boolean, onChange: (v: boolean) => void) => {
            const td = document.createElement('td');
            td.style.padding = '3px 2px';
            td.appendChild(this.createToggleBtn(id, text, init, onChange));
            tr.appendChild(td);
        };

        appendToggleCol('Sol', 'viewport-charge-solid-btn', initSolid, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { charge_solid: v });
                this.worker.postMessage({ type: 'setConfig', data: { chargeSolid: v } });
            }
        });
        appendToggleCol('Msh', 'viewport-charge-wf-btn', initWf, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { charge_wireframe: v });
                this.worker.postMessage({ type: 'setConfig', data: { chargeWireframe: v } });
            }
        });
        appendToggleCol('Lgt', 'viewport-charge-light-btn', initLight, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { charge_lighting: v });
                this.worker.postMessage({ type: 'setConfig', data: { chargeLighting: v } });
            }
        });

        const tdQty = document.createElement('td');
        tdQty.innerHTML = '<span style="color:#444;">—</span>';
        tdQty.style.textAlign = 'center';
        tr.appendChild(tdQty);

        const tdCmap = document.createElement('td');
        tdCmap.innerHTML = '<span style="color:#444;">—</span>';
        tdCmap.style.textAlign = 'center';
        tr.appendChild(tdCmap);

        const tdScl = document.createElement('td');
        tdScl.innerHTML = '<span style="color:#444;">—</span>';
        tdScl.style.textAlign = 'center';
        tr.appendChild(tdScl);

        const tdOpac = document.createElement('td');
        tdOpac.style.padding = '3px 4px';
        const opacPill = document.createElement('button');
        opacPill.textContent = `${Math.round(initOpacity * 100)}% ▾`;
        this.applyButtonStyle(opacPill);
        opacPill.style.fontSize = '8.5px';
        opacPill.style.width = '100%';
        opacPill.style.padding = '2px 0';
        opacPill.onclick = (e) => {
            e.stopPropagation();
            const curVal = this.getViewportNode()?.parameters.charge_opacity ?? 0.65;
            this.showOpacityPopover(opacPill, curVal, (newOpac) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { charge_opacity: newOpac });
                    this.worker.postMessage({ type: 'setConfig', data: { chargeOpacity: newOpac } });
                    opacPill.textContent = `${Math.round(newOpac * 100)}% ▾`;
                }
            });
        };
        tdOpac.appendChild(opacPill);
        tr.appendChild(tdOpac);

        const tdDel = document.createElement('td');
        tdDel.innerHTML = '<span style="color:#444;">—</span>';
        tdDel.style.textAlign = 'center';
        tr.appendChild(tdDel);

        parent.appendChild(tr);
    }

    private buildDetonatorRow(parent: HTMLElement) {
        const vpNode = this.getViewportNode();
        const initShow = vpNode ? (vpNode.parameters.show_detonators !== false && vpNode.parameters.show_detonator !== false) : true;
        const initSolid = vpNode ? (vpNode.parameters.detonators_solid !== false && vpNode.parameters.detonator_solid !== false) : true;
        const initWf = vpNode ? (vpNode.parameters.detonators_wireframe !== false && vpNode.parameters.detonator_wireframe !== false) : true;
        const initLight = vpNode ? (vpNode.parameters.detonators_lighting !== false && vpNode.parameters.detonator_lighting !== false) : true;
        const initOpacity = vpNode ? (vpNode.parameters.detonators_opacity ?? vpNode.parameters.detonator_opacity ?? 1.0) : 1.0;

        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

        const tdVis = document.createElement('td');
        tdVis.style.padding = '3px 2px';
        tdVis.style.textAlign = 'center';
        const showCb = document.createElement('input');
        showCb.type = 'checkbox';
        showCb.id = this.getElId('viewport-det-show-cb');
        showCb.checked = initShow;
        showCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { show_detonators: showCb.checked, show_detonator: showCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { showDetonators: showCb.checked } });
                this.sendView3DConfig();
            }
        };
        this.bindEditingEvents(showCb);
        tdVis.appendChild(showCb);
        tr.appendChild(tdVis);

        const tdLayer = document.createElement('td');
        tdLayer.style.padding = '3px 4px';
        tdLayer.innerHTML = '🎯 <b>Detonators</b>';
        tr.appendChild(tdLayer);

        const appendToggleCol = (text: string, id: string, init: boolean, onChange: (v: boolean) => void) => {
            const td = document.createElement('td');
            td.style.padding = '3px 2px';
            td.appendChild(this.createToggleBtn(id, text, init, onChange));
            tr.appendChild(td);
        };

        appendToggleCol('Sol', 'viewport-det-solid-btn', initSolid, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { detonators_solid: v, detonator_solid: v });
                this.worker.postMessage({ type: 'setConfig', data: { detonatorSolid: v } });
            }
        });
        appendToggleCol('Msh', 'viewport-det-wf-btn', initWf, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { detonators_wireframe: v, detonator_wireframe: v });
                this.worker.postMessage({ type: 'setConfig', data: { detonatorWireframe: v } });
            }
        });
        appendToggleCol('Lgt', 'viewport-det-light-btn', initLight, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { detonators_lighting: v, detonator_lighting: v });
                this.worker.postMessage({ type: 'setConfig', data: { detonatorLighting: v } });
            }
        });

        const tdQty = document.createElement('td');
        tdQty.innerHTML = '<span style="color:#444;">—</span>';
        tdQty.style.textAlign = 'center';
        tr.appendChild(tdQty);

        const tdCmap = document.createElement('td');
        tdCmap.innerHTML = '<span style="color:#444;">—</span>';
        tdCmap.style.textAlign = 'center';
        tr.appendChild(tdCmap);

        const tdScl = document.createElement('td');
        tdScl.innerHTML = '<span style="color:#444;">—</span>';
        tdScl.style.textAlign = 'center';
        tr.appendChild(tdScl);

        const tdOpac = document.createElement('td');
        tdOpac.style.padding = '3px 4px';
        const opacPill = document.createElement('button');
        opacPill.id = this.getElId('viewport-det-opac-pill');
        opacPill.textContent = `${Math.round(initOpacity * 100)}% ▾`;
        this.applyButtonStyle(opacPill);
        opacPill.style.fontSize = '8.5px';
        opacPill.style.width = '100%';
        opacPill.style.padding = '2px 0';
        opacPill.onclick = (e) => {
            e.stopPropagation();
            const curVal = this.getViewportNode()?.parameters.detonators_opacity ?? this.getViewportNode()?.parameters.detonator_opacity ?? 1.0;
            this.showOpacityPopover(opacPill, curVal, (newOpac) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { detonators_opacity: newOpac, detonator_opacity: newOpac });
                    this.worker.postMessage({ type: 'setConfig', data: { detonatorOpacity: newOpac } });
                    opacPill.textContent = `${Math.round(newOpac * 100)}% ▾`;
                }
            });
        };
        tdOpac.appendChild(opacPill);
        tr.appendChild(tdOpac);

        const tdDel = document.createElement('td');
        tdDel.innerHTML = '<span style="color:#444;">—</span>';
        tdDel.style.textAlign = 'center';
        tr.appendChild(tdDel);

        parent.appendChild(tr);
    }

    private buildGridRow(parent: HTMLElement) {
        const vpNode = this.getViewportNode();
        const initShow = this.isGridEnabled(vpNode);
        const initEdges = vpNode ? (!!vpNode.parameters.cell_edges) : false;
        const initBox = this.isGridBoxEnabled(vpNode);
        const initOpacity = vpNode ? (vpNode.parameters.grid_opacity ?? 1.0) : 1.0;

        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

        // Col 1: Vis Checkbox
        const tdVis = document.createElement('td');
        tdVis.style.padding = '3px 2px';
        tdVis.style.textAlign = 'center';
        const showCb = document.createElement('input');
        showCb.type = 'checkbox';
        showCb.id = this.getElId('viewport-grid-cb');
        showCb.checked = initShow;
        showCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { show_grid: showCb.checked, show_grid_user_enabled: showCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { showGrid: showCb.checked } });
            }
        };
        this.bindEditingEvents(showCb);
        tdVis.appendChild(showCb);
        tr.appendChild(tdVis);

        // Col 2: Layer Title
        const tdLayer = document.createElement('td');
        tdLayer.style.padding = '3px 4px';
        tdLayer.innerHTML = '📦 <b>Grid & Box</b>';
        tr.appendChild(tdLayer);

        // Col 3: SOL (Empty)
        const tdSolE = document.createElement('td');
        tdSolE.innerHTML = '<span style="color:#555;">—</span>';
        tdSolE.style.textAlign = 'center';
        tr.appendChild(tdSolE);

        // Col 4: LINES (Edg & Box buttons both in LINES column)
        const tdMsh = document.createElement('td');
        tdMsh.style.padding = '3px 2px';
        const mshWrap = document.createElement('div');
        mshWrap.style.display = 'flex';
        mshWrap.style.gap = '2px';
        mshWrap.appendChild(this.createToggleBtn('viewport-edges-btn', 'Edg', initEdges, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { cell_edges: v });
                this.worker.postMessage({ type: 'setConfig', data: { showCellEdges: v } });
            }
        }));
        mshWrap.appendChild(this.createToggleBtn('viewport-box-btn', 'Box', initBox, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { show_grid_box: v, show_grid_box_user_enabled: v });
                this.worker.postMessage({ type: 'setConfig', data: { showGridBox: v } });
            }
        }));
        tdMsh.appendChild(mshWrap);
        tr.appendChild(tdMsh);

        // Col 5, 6, 7, 8: Empty
        for (let i = 0; i < 4; i++) {
            const tdEmpty = document.createElement('td');
            tdEmpty.innerHTML = '<span style="color:#555;">—</span>';
            tdEmpty.style.textAlign = 'center';
            tr.appendChild(tdEmpty);
        }

        // Col 9: OPACITY (Opacity Popover)
        const tdOpac = document.createElement('td');
        tdOpac.style.padding = '3px 4px';
        const opacPill = document.createElement('button');
        opacPill.textContent = `${Math.round(initOpacity * 100)}% ▾`;
        this.applyButtonStyle(opacPill);
        opacPill.style.fontSize = '8.5px';
        opacPill.style.width = '100%';
        opacPill.style.padding = '2px 0';
        opacPill.onclick = (e) => {
            e.stopPropagation();
            const curVal = this.getViewportNode()?.parameters.grid_opacity ?? 1.0;
            this.showOpacityPopover(opacPill, curVal, (newOpac) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { grid_opacity: newOpac });
                    this.worker.postMessage({ type: 'setConfig', data: { gridOpacity: newOpac } });
                    opacPill.textContent = `${Math.round(newOpac * 100)}% ▾`;
                }
            });
        };
        tdOpac.appendChild(opacPill);
        tr.appendChild(tdOpac);

        // Col 10: Empty Delete Cell
        const tdDel = document.createElement('td');
        tdDel.innerHTML = '<span style="color:#444;">—</span>';
        tdDel.style.textAlign = 'center';
        tr.appendChild(tdDel);

        parent.appendChild(tr);
    }

    private buildGaugeRow(parent: HTMLElement) {
        const vpNode = this.getViewportNode();
        const initShow = vpNode ? (vpNode.parameters.show_gauges !== false) : true;
        const initQty = vpNode ? (vpNode.parameters.gauge_quantity || 'pressure') : 'pressure';
        const initSolid = vpNode ? (vpNode.parameters.gauge_solid !== false) : true;
        const initOpacity = vpNode ? (vpNode.parameters.gauge_opacity ?? 1.0) : 1.0;

        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

        // Col 1: Vis Checkbox
        const tdVis = document.createElement('td');
        tdVis.style.padding = '3px 2px';
        tdVis.style.textAlign = 'center';
        const showCb = document.createElement('input');
        showCb.type = 'checkbox';
        showCb.id = this.getElId('viewport-gauges-cb');
        showCb.checked = initShow;
        showCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { show_gauges: showCb.checked });
                const gauges = this.getVirtualGauges();
                this.worker.postMessage({ type: 'setConfig', data: { showGauges: showCb.checked, gauges } });
            }
        };
        this.bindEditingEvents(showCb);
        tdVis.appendChild(showCb);
        tr.appendChild(tdVis);

        // Col 2: Layer Title
        const tdLayer = document.createElement('td');
        tdLayer.style.padding = '3px 4px';
        tdLayer.innerHTML = '🎯 <b>Gauges</b>';
        tr.appendChild(tdLayer);

        // Col 3: SOL (Solid Gauge Spheres)
        const tdSph = document.createElement('td');
        tdSph.style.padding = '3px 2px';
        tdSph.appendChild(this.createToggleBtn('viewport-gauge-solid-btn', 'Sph', initSolid, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { gauge_solid: v });
                this.worker.postMessage({ type: 'setConfig', data: { gaugeSolid: v } });
            }
        }));
        tr.appendChild(tdSph);

        // Col 4: LINES (Gauge Size Popover Pill)
        const initSize = vpNode ? (vpNode.parameters.gauge_size ?? 1.0) : 1.0;
        const tdSize = document.createElement('td');
        tdSize.style.padding = '3px 4px';
        const sizePill = document.createElement('button');
        sizePill.textContent = `${initSize.toFixed(2)}x ▾`;
        this.applyButtonStyle(sizePill);
        sizePill.style.fontSize = '8.5px';
        sizePill.style.width = '100%';
        sizePill.style.padding = '2px 0';
        sizePill.onclick = (e) => {
            e.stopPropagation();
            const curVal = this.getViewportNode()?.parameters.gauge_size ?? 1.0;
            this.showGaugeSizePopover(sizePill, curVal, (newSize) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { gauge_size: newSize });
                    this.worker.postMessage({ type: 'setConfig', data: { gaugeSize: newSize } });
                    sizePill.textContent = `${newSize.toFixed(2)}x ▾`;
                }
            });
        };
        tdSize.appendChild(sizePill);
        tr.appendChild(tdSize);

        // Col 5: RES (Empty)
        const tdResEmpty = document.createElement('td');
        tdResEmpty.innerHTML = '<span style="color:#555;">—</span>';
        tdResEmpty.style.textAlign = 'center';
        tr.appendChild(tdResEmpty);

        // Col 6: QTY (Quantity Popover Pill)
        const tdQty = document.createElement('td');
        tdQty.style.padding = '3px 4px';
        const qtyPill = document.createElement('button');
        const qtyLabels: Record<string, string> = {
            pressure: 'Press', density: 'Density', velocity: 'Speed', energy: 'Energy',
            species1: 'Reacted', species2: 'Unreacted', species3: 'Air',
            overpressure: 'Overpress', peak_overpressure: 'Pk Overpress', peak_impulse: 'Pk Impulse', amr_level: 'AMR Level'
        };
        qtyPill.textContent = `${qtyLabels[initQty] || initQty} ▾`;
        this.applyButtonStyle(qtyPill);
        qtyPill.style.fontSize = '8.5px';
        qtyPill.style.width = '100%';
        qtyPill.style.padding = '2px 0';
        qtyPill.onclick = (e) => {
            e.stopPropagation();
            const currentQty = this.getViewportNode()?.parameters.gauge_quantity || 'pressure';
            this.showQuantityPopover(qtyPill, currentQty, 'cfd', (newQ) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { gauge_quantity: newQ });
                    this.worker.postMessage({ type: 'setConfig', data: { gaugeQuantity: newQ } });
                    qtyPill.textContent = `${qtyLabels[newQ] || newQ} ▾`;
                }
            });
        };
        tdQty.appendChild(qtyPill);
        tr.appendChild(tdQty);

        // Col 7, 8: COLOR & SCL (Empty)
        for (let i = 0; i < 2; i++) {
            const tdEmpty = document.createElement('td');
            tdEmpty.innerHTML = '<span style="color:#555;">—</span>';
            tdEmpty.style.textAlign = 'center';
            tr.appendChild(tdEmpty);
        }

        // Col 9: OPACITY (Opacity Popover)
        const tdOpac = document.createElement('td');
        tdOpac.style.padding = '3px 4px';
        const opacPill = document.createElement('button');
        opacPill.textContent = `${Math.round(initOpacity * 100)}% ▾`;
        this.applyButtonStyle(opacPill);
        opacPill.style.fontSize = '8.5px';
        opacPill.style.width = '100%';
        opacPill.style.padding = '2px 0';
        opacPill.onclick = (e) => {
            e.stopPropagation();
            const curVal = this.getViewportNode()?.parameters.gauge_opacity ?? 1.0;
            this.showOpacityPopover(opacPill, curVal, (newOpac) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { gauge_opacity: newOpac });
                    this.worker.postMessage({ type: 'setConfig', data: { gaugeOpacity: newOpac } });
                    opacPill.textContent = `${Math.round(newOpac * 100)}% ▾`;
                }
            });
        };
        tdOpac.appendChild(opacPill);
        tr.appendChild(tdOpac);

        // Col 10: Empty Delete Cell
        const tdDel = document.createElement('td');
        tdDel.innerHTML = '<span style="color:#444;">—</span>';
        tdDel.style.textAlign = 'center';
        tr.appendChild(tdDel);

        parent.appendChild(tr);
    }

    private buildLightingTableRow(parent: HTMLElement) {
        const vpNode = this.getViewportNode();
        const initLight = vpNode ? (vpNode.parameters.lightingEnabled !== false) : true;
        const initAO = vpNode ? (vpNode.parameters.aoEnabled !== false) : true;
        const initAmb = vpNode ? (vpNode.parameters.ambientLevel ?? 0.3) : 0.3;
        const initSpec = vpNode ? (vpNode.parameters.specularIntensity ?? 0.4) : 0.4;

        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

        // Col 1: Vis Checkbox (Enable Lighting)
        const tdVis = document.createElement('td');
        tdVis.style.padding = '3px 2px';
        tdVis.style.textAlign = 'center';
        const lightCb = document.createElement('input');
        lightCb.type = 'checkbox';
        lightCb.id = this.getElId('viewport-lighting-cb');
        lightCb.checked = initLight;
        lightCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { lightingEnabled: lightCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { lightingEnabled: lightCb.checked } });
            }
        };
        this.bindEditingEvents(lightCb);
        tdVis.appendChild(lightCb);
        tr.appendChild(tdVis);

        // Col 2: Layer Title
        const tdLayer = document.createElement('td');
        tdLayer.style.padding = '3px 4px';
        tdLayer.innerHTML = '💡 <b>Lighting</b>';
        tr.appendChild(tdLayer);

        // Col 3, 4: SOL & LINES (Empty)
        for (let i = 0; i < 2; i++) {
            const tdEmpty = document.createElement('td');
            tdEmpty.innerHTML = '<span style="color:#555;">—</span>';
            tdEmpty.style.textAlign = 'center';
            tr.appendChild(tdEmpty);
        }

        // Col 5: RES (AO toggle & popover button)
        const tdAo = document.createElement('td');
        tdAo.style.padding = '3px 2px';
        const aoWrap = document.createElement('div');
        aoWrap.style.display = 'flex';
        aoWrap.style.alignItems = 'center';
        aoWrap.style.gap = '2px';

        const aoBtn = this.createToggleBtn('viewport-ao-btn', 'AO', initAO, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { aoEnabled: v });
                this.worker.postMessage({ type: 'setConfig', data: { aoEnabled: v } });
            }
        });
        aoBtn.style.flex = '1';

        const aoMenuBtn = document.createElement('button');
        aoMenuBtn.textContent = '▾';
        this.applyButtonStyle(aoMenuBtn);
        aoMenuBtn.style.fontSize = '8px';
        aoMenuBtn.style.padding = '1px 3px';
        aoMenuBtn.style.minWidth = '14px';
        aoMenuBtn.title = 'Configure SSAO sampling radius, intensity and sphere impostors';
        aoMenuBtn.onclick = (e) => {
            e.stopPropagation();
            this.showAOPopover(aoMenuBtn);
        };

        aoWrap.appendChild(aoBtn);
        aoWrap.appendChild(aoMenuBtn);
        tdAo.appendChild(aoWrap);
        tr.appendChild(tdAo);

        // Col 6: QTY (Ambient Level Popover Pill)
        const tdAmb = document.createElement('td');
        tdAmb.style.padding = '3px 4px';
        const ambPill = document.createElement('button');
        ambPill.textContent = `Amb ${initAmb.toFixed(2)} ▾`;
        this.applyButtonStyle(ambPill);
        ambPill.style.fontSize = '8.5px';
        ambPill.style.width = '100%';
        ambPill.style.padding = '2px 0';
        ambPill.onclick = (e) => {
            e.stopPropagation();
            const curVal = this.getViewportNode()?.parameters.ambientLevel ?? 0.3;
            this.showAmbientPopover(ambPill, curVal, (newAmb) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { ambientLevel: newAmb });
                    this.worker.postMessage({ type: 'setConfig', data: { ambientLevel: newAmb } });
                    ambPill.textContent = `Amb ${newAmb.toFixed(2)} ▾`;
                }
            });
        };
        tdAmb.appendChild(ambPill);
        tr.appendChild(tdAmb);

        // Col 7: COLOR (Specular Level Popover Pill)
        const tdSpec = document.createElement('td');
        tdSpec.style.padding = '3px 4px';
        const specPill = document.createElement('button');
        specPill.textContent = `Spec ${initSpec.toFixed(2)} ▾`;
        this.applyButtonStyle(specPill);
        specPill.style.fontSize = '8.5px';
        specPill.style.width = '100%';
        specPill.style.padding = '2px 0';
        specPill.onclick = (e) => {
            e.stopPropagation();
            const curVal = this.getViewportNode()?.parameters.specularIntensity ?? 0.4;
            this.showSpecularPopover(specPill, curVal, (newSpec) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { specularIntensity: newSpec });
                    this.worker.postMessage({ type: 'setConfig', data: { specularIntensity: newSpec } });
                    specPill.textContent = `Spec ${newSpec.toFixed(2)} ▾`;
                }
            });
        };
        tdSpec.appendChild(specPill);
        tr.appendChild(tdSpec);

        // Col 8, 9, 10: Empty (SCL, OPAC, DELETE)
        for (let i = 0; i < 3; i++) {
            const tdEmpty = document.createElement('td');
            tdEmpty.innerHTML = '<span style="color:#444;">—</span>';
            tdEmpty.style.textAlign = 'center';
            tr.appendChild(tdEmpty);
        }

        parent.appendChild(tr);
    }

    private getColormapCssGradient(cmapId: string, direction: 'to top' | 'to right' = 'to top'): string {
        const cmapGradients: Record<string, string> = {
            rainbow: '#0000ff, #00ffff, #00ff00, #ffff00, #ff0000',
            plasma: '#0d0887, #6a00a8, #b12a90, #e16462, #fca636, #f0f921',
            viridis: '#440154, #3b528b, #21908d, #5dc963, #fde725',
            coolwarm: '#3b4cc0, #88b0f3, #ddd, #f49a7b, #b40426',
            cividis: '#002051, #395276, #678685, #9eb980, #fdea45',
            grayscale: '#000000, #ffffff'
        };
        const stops = cmapGradients[cmapId] || cmapGradients.rainbow;
        return `linear-gradient(${direction}, ${stops})`;
    }

    private setFocusedQuantity(qty: string) {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        const slices = vpNode.parameters.slices ? [...vpNode.parameters.slices] : [];
        const focusedIdx = vpNode.parameters.focusedSliceIndex ?? 0;
        if (slices[focusedIdx]) {
            slices[focusedIdx] = {
                ...slices[focusedIdx],
                quantities: [qty]
            };
            this.stateManager.updateNodeParametersInPlace(vpNode.id, { slices });
            this.updateSlices(slices);
        } else {
            this.stateManager.updateNodeParametersInPlace(vpNode.id, { stl_quantity: qty, obstacles_quantity: qty });
        }
        this.syncControls(true);
    }

    private buildColorbarContainer() {
        if (this.colorbarContainer) return;
        const container = document.createElement('div');
        container.id = this.getElId('viewport-colorbars-container');
        container.className = 'viewport-colorbars-container';
        container.style.position = 'absolute';
        container.style.top = '36px';
        container.style.left = '10px';
        container.style.zIndex = '1000';
        container.style.display = 'flex';
        container.style.flexDirection = 'row';
        container.style.flexWrap = 'wrap';
        container.style.gap = '8px';
        container.style.pointerEvents = 'none';
        this.colorbarContainer = container;
        this.container.appendChild(container);
    }

    private createColorbarCard(spec: {
        id: string;
        title: string;
        quantity: string;
        colormap: string;
        autoScale: boolean;
        logScale: boolean;
        isLocked?: boolean;
        minVal: number;
        maxVal: number;
        onToggleOff: () => void;
        onToggleAuto: () => void;
        onToggleLog: () => void;
        onToggleLock?: () => void;
        onSelectColormap: (anchorEl: HTMLElement) => void;
        onSetMinMax: (min: number, max: number) => void;
        onSelectQuantity: (anchorEl: HTMLElement) => void;
    }): HTMLElement {
        const card = document.createElement('div');
        card.id = this.getElId(`viewport-colorbar-card-${spec.id}`);
        card.className = 'viewport-colorbar-card';
        card.style.background = 'rgba(14, 15, 19, 0.88)';
        card.style.backdropFilter = 'blur(12px)';
        card.style.border = '1px solid rgba(255, 255, 255, 0.14)';
        card.style.borderRadius = '6px';
        card.style.padding = '5px 6px';
        card.style.display = 'flex';
        card.style.flexDirection = 'column';
        card.style.gap = '3px';
        card.style.color = '#e2e8f0';
        card.style.fontFamily = 'system-ui, -apple-system, sans-serif';
        card.style.fontSize = '9px';
        card.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.55)';
        card.style.userSelect = 'none';
        card.style.boxSizing = 'border-box';
        card.style.pointerEvents = 'auto';
        card.style.width = 'fit-content';

        // 1. Top Header Row (Title + Close Button)
        const topRow = document.createElement('div');
        topRow.style.display = 'flex';
        topRow.style.alignItems = 'center';
        topRow.style.justifyContent = 'space-between';
        topRow.style.gap = '6px';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'viewport-colorbar-title';
        titleSpan.style.fontWeight = '700';
        titleSpan.style.color = '#38bdf8';
        titleSpan.style.cursor = 'pointer';
        titleSpan.style.fontSize = '8.5px';
        titleSpan.style.letterSpacing = '0.3px';
        titleSpan.style.whiteSpace = 'nowrap';
        titleSpan.textContent = spec.title;
        titleSpan.title = `${spec.title} (Click to change quantity)`;
        titleSpan.onclick = (e) => {
            e.stopPropagation();
            spec.onSelectQuantity(titleSpan);
        };
        topRow.appendChild(titleSpan);

        const closeBtn = document.createElement('span');
        closeBtn.className = 'viewport-colorbar-close-btn';
        closeBtn.style.fontSize = '9px';
        closeBtn.style.fontWeight = 'bold';
        closeBtn.style.color = '#94a3b8';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.padding = '0 2px';
        closeBtn.style.lineHeight = '1';
        closeBtn.style.flexShrink = '0';
        closeBtn.textContent = '✕';
        closeBtn.title = 'Close color bar';
        closeBtn.onmouseenter = () => closeBtn.style.color = '#ef4444';
        closeBtn.onmouseleave = () => closeBtn.style.color = '#94a3b8';
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            spec.onToggleOff();
        };
        topRow.appendChild(closeBtn);
        card.appendChild(topRow);

        // 2. Control Badges Row (Auto, Log, Colormap)
        const badgesRow = document.createElement('div');
        badgesRow.style.display = 'flex';
        badgesRow.style.alignItems = 'center';
        badgesRow.style.gap = '3px';
        badgesRow.style.marginBottom = '1px';

        // Auto badge
        const autoBadge = document.createElement('span');
        autoBadge.className = 'viewport-colorbar-auto-badge';
        autoBadge.style.fontSize = '7.5px';
        autoBadge.style.fontWeight = '700';
        autoBadge.style.padding = '1px 3px';
        autoBadge.style.borderRadius = '2px';
        autoBadge.style.cursor = 'pointer';
        autoBadge.style.lineHeight = '1.1';
        autoBadge.style.minWidth = '28px';
        autoBadge.style.textAlign = 'center';
        autoBadge.style.display = 'inline-block';
        autoBadge.style.boxSizing = 'border-box';
        autoBadge.textContent = spec.autoScale ? 'AUTO' : 'MAN';
        autoBadge.style.background = spec.autoScale ? 'rgba(0, 173, 255, 0.2)' : 'rgba(245, 158, 11, 0.2)';
        autoBadge.style.color = spec.autoScale ? '#38bdf8' : '#fbbf24';
        autoBadge.style.border = spec.autoScale ? '1px solid rgba(56, 189, 248, 0.35)' : '1px solid rgba(245, 158, 11, 0.35)';
        autoBadge.title = 'Click to toggle Auto / Manual scale';
        autoBadge.onclick = (e) => {
            e.stopPropagation();
            spec.onToggleAuto();
        };
        badgesRow.appendChild(autoBadge);

        // Log badge
        const logBadge = document.createElement('span');
        logBadge.className = 'viewport-colorbar-log-badge';
        logBadge.style.fontSize = '7.5px';
        logBadge.style.fontWeight = '700';
        logBadge.style.padding = '1px 3px';
        logBadge.style.borderRadius = '2px';
        logBadge.style.cursor = 'pointer';
        logBadge.style.lineHeight = '1.1';
        logBadge.style.minWidth = '24px';
        logBadge.style.textAlign = 'center';
        logBadge.style.display = 'inline-block';
        logBadge.style.boxSizing = 'border-box';
        logBadge.textContent = spec.logScale ? 'LOG' : 'LIN';
        logBadge.style.background = spec.logScale ? 'rgba(168, 85, 247, 0.2)' : 'rgba(255, 255, 255, 0.08)';
        logBadge.style.color = spec.logScale ? '#c084fc' : '#94a3b8';
        logBadge.style.border = spec.logScale ? '1px solid rgba(168, 85, 247, 0.35)' : '1px solid rgba(255, 255, 255, 0.15)';
        logBadge.title = 'Click to toggle Linear / Logarithmic scale';
        logBadge.onclick = (e) => {
            e.stopPropagation();
            spec.onToggleLog();
        };
        badgesRow.appendChild(logBadge);

        // Colormap badge
        const cmapBadge = document.createElement('span');
        cmapBadge.className = 'viewport-colorbar-cmap-badge';
        cmapBadge.style.fontSize = '7.5px';
        cmapBadge.style.fontWeight = '700';
        cmapBadge.style.padding = '1px 3px';
        cmapBadge.style.borderRadius = '2px';
        cmapBadge.style.cursor = 'pointer';
        cmapBadge.style.lineHeight = '1.1';
        cmapBadge.style.background = 'rgba(255, 255, 255, 0.08)';
        cmapBadge.style.border = '1px solid rgba(255, 255, 255, 0.15)';
        cmapBadge.style.color = '#f1f5f9';
        cmapBadge.style.whiteSpace = 'nowrap';
        cmapBadge.textContent = spec.colormap.toUpperCase();
        cmapBadge.title = `Color Scheme: ${spec.colormap.toUpperCase()} (Click to change)`;
        cmapBadge.onclick = (e) => {
            e.stopPropagation();
            spec.onSelectColormap(cmapBadge);
        };
        badgesRow.appendChild(cmapBadge);

        // Lock / Unified Range badge
        const lockBadge = document.createElement('span');
        lockBadge.className = 'viewport-colorbar-lock-badge';
        lockBadge.style.fontSize = '7.5px';
        lockBadge.style.fontWeight = '700';
        lockBadge.style.padding = '1px 3px';
        lockBadge.style.borderRadius = '2px';
        lockBadge.style.cursor = 'pointer';
        lockBadge.style.lineHeight = '1.1';
        lockBadge.style.minWidth = '24px';
        lockBadge.style.textAlign = 'center';
        lockBadge.style.display = 'inline-block';
        lockBadge.style.boxSizing = 'border-box';
        lockBadge.textContent = spec.isLocked ? '🔒 UNIFIED' : '🔓 INDEP';
        lockBadge.style.background = spec.isLocked ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)';
        lockBadge.style.color = spec.isLocked ? '#34d399' : '#f87171';
        lockBadge.style.border = spec.isLocked ? '1px solid rgba(52, 211, 153, 0.35)' : '1px solid rgba(239, 68, 68, 0.35)';
        lockBadge.title = spec.isLocked
            ? 'Unified Field Range: ALL slices, CAD models, and obstacles displaying this quantity share the same range. Click to unlock.'
            : 'Independent Range: This object uses an independent min/max range. Click to lock to unified range.';
        lockBadge.onclick = (e) => {
            e.stopPropagation();
            spec.onToggleLock?.();
        };
        badgesRow.appendChild(lockBadge);
        card.appendChild(badgesRow);

        // 3. Main Body (Gradient Bar + Ticks)
        const bodyRow = document.createElement('div');
        bodyRow.style.display = 'flex';
        bodyRow.style.alignItems = 'stretch';
        bodyRow.style.gap = '4px';

        // Gradient Bar using exact colormap defined for this object!
        const gradBar = document.createElement('div');
        gradBar.className = 'viewport-colorbar-grad-bar';
        gradBar.style.width = '10px';
        gradBar.style.height = '120px';
        gradBar.style.borderRadius = '2px';
        gradBar.style.border = '1px solid rgba(255, 255, 255, 0.2)';
        gradBar.style.boxShadow = 'inset 0 0 3px rgba(0,0,0,0.5)';
        gradBar.style.cursor = 'pointer';
        gradBar.style.background = this.getColormapCssGradient(spec.colormap, 'to top');
        gradBar.title = `Color Scheme: ${spec.colormap.toUpperCase()} (Click to change)`;
        gradBar.onclick = (e) => {
            e.stopPropagation();
            spec.onSelectColormap(gradBar);
        };
        bodyRow.appendChild(gradBar);

        // Ticks Container
        const ticksCol = document.createElement('div');
        ticksCol.className = 'viewport-colorbar-ticks-col';
        ticksCol.style.display = 'flex';
        ticksCol.style.flexDirection = 'column';
        ticksCol.style.justifyContent = 'space-between';
        ticksCol.style.height = '120px';
        ticksCol.style.minWidth = '0';
        ticksCol.style.flex = '1';

        const numTicks = 5;
        let displayMinVal = spec.minVal;
        const displayMaxVal = spec.maxVal;
        if (spec.logScale && displayMinVal <= 0 && displayMaxVal > 0) {
            displayMinVal = displayMaxVal / 1000000.0;
        }
        const rangeSpan = Math.abs(displayMaxVal - displayMinVal);

        for (let i = 0; i < numTicks; i++) {
            const t = (numTicks - 1 - i) / (numTicks - 1);
            let val = displayMinVal + t * (displayMaxVal - displayMinVal);
            if (spec.logScale && displayMinVal > 0 && displayMaxVal > displayMinVal) {
                val = displayMinVal * Math.pow(displayMaxVal / displayMinVal, t);
            }

            const tickRow = document.createElement('div');
            tickRow.style.display = 'flex';
            tickRow.style.alignItems = 'center';
            tickRow.style.gap = '2.5px';
            tickRow.style.height = '14px';

            const tickLine = document.createElement('div');
            tickLine.style.width = '3px';
            tickLine.style.height = '1px';
            tickLine.style.background = 'rgba(255,255,255,0.35)';
            tickLine.style.flexShrink = '0';
            tickRow.appendChild(tickLine);

            if (i === 0 || i === numTicks - 1) {
                const isMax = (i === 0);
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'viewport-colorbar-input';
                input.dataset.tickRole = isMax ? 'max' : 'min';
                input.value = this.formatRangeValue(isMax ? spec.maxVal : spec.minVal, rangeSpan);
                input.style.width = '48px';
                input.style.height = '13px';
                input.style.background = 'rgba(0,0,0,0.45)';
                input.style.border = '1px solid rgba(255,255,255,0.15)';
                input.style.borderRadius = '2px';
                input.style.color = '#38bdf8';
                input.style.fontFamily = "'JetBrains Mono', monospace";
                input.style.fontSize = '8px';
                input.style.padding = '0 2px';
                input.style.boxSizing = 'border-box';
                input.style.outline = 'none';
                input.title = isMax ? 'Edit Maximum (Click to type)' : 'Edit Minimum (Click to type)';

                input.onfocus = () => {
                    input.dataset.editing = 'true';
                    input.value = String(isMax ? spec.maxVal : spec.minVal);
                    input.select();
                };
                input.onblur = () => {
                    delete input.dataset.editing;
                    const newV = Number(input.value);
                    if (!isNaN(newV) && input.value.trim() !== '') {
                        if (isMax) spec.onSetMinMax(spec.minVal, newV);
                        else spec.onSetMinMax(newV, spec.maxVal);
                    } else {
                        input.value = this.formatRangeValue(isMax ? spec.maxVal : spec.minVal, rangeSpan);
                    }
                };
                input.onkeydown = (e) => {
                    if (e.key === 'Enter') {
                        input.blur();
                    } else if (e.key === 'Escape') {
                        delete input.dataset.editing;
                        input.value = this.formatRangeValue(isMax ? spec.maxVal : spec.minVal, rangeSpan);
                        input.blur();
                    }
                };
                tickRow.appendChild(input);
            } else {
                const label = document.createElement('span');
                label.dataset.tickRole = 'intermediate';
                label.dataset.tickIndex = String(i);
                label.textContent = this.formatRangeValue(val, rangeSpan);
                label.style.fontSize = '8px';
                label.style.fontFamily = "'JetBrains Mono', monospace";
                label.style.color = '#94a3b8';
                label.style.lineHeight = '13px';
                label.style.whiteSpace = 'nowrap';
                tickRow.appendChild(label);
            }

            ticksCol.appendChild(tickRow);
        }

        bodyRow.appendChild(ticksCol);
        card.appendChild(bodyRow);
        return card;
    }

    private updateColorbarCard(card: HTMLElement, spec: {
        id: string;
        title: string;
        quantity: string;
        colormap: string;
        autoScale: boolean;
        logScale: boolean;
        isLocked?: boolean;
        minVal: number;
        maxVal: number;
        onToggleOff: () => void;
        onToggleAuto: () => void;
        onToggleLog: () => void;
        onToggleLock?: () => void;
        onSelectColormap: (anchorEl: HTMLElement) => void;
        onSetMinMax: (min: number, max: number) => void;
        onSelectQuantity: (anchorEl: HTMLElement) => void;
    }) {
        const titleSpan = card.querySelector('.viewport-colorbar-title') as HTMLElement;
        if (titleSpan) {
            titleSpan.textContent = spec.title;
            titleSpan.title = `${spec.title} (Click to change quantity)`;
            titleSpan.onclick = (e) => {
                e.stopPropagation();
                spec.onSelectQuantity(titleSpan);
            };
        }

        const closeBtn = card.querySelector('.viewport-colorbar-close-btn') as HTMLElement;
        if (closeBtn) {
            closeBtn.onclick = (e) => {
                e.stopPropagation();
                spec.onToggleOff();
            };
        }

        const autoBadge = card.querySelector('.viewport-colorbar-auto-badge') as HTMLElement;
        if (autoBadge) {
            const expectedText = spec.autoScale ? 'AUTO' : 'MAN';
            autoBadge.textContent = expectedText;
            autoBadge.style.background = spec.autoScale ? 'rgba(0, 173, 255, 0.2)' : 'rgba(245, 158, 11, 0.2)';
            autoBadge.style.color = spec.autoScale ? '#38bdf8' : '#fbbf24';
            autoBadge.style.border = spec.autoScale ? '1px solid rgba(56, 189, 248, 0.35)' : '1px solid rgba(245, 158, 11, 0.35)';
            autoBadge.onclick = (e) => {
                e.stopPropagation();
                spec.onToggleAuto();
            };
        }

        const logBadge = card.querySelector('.viewport-colorbar-log-badge') as HTMLElement;
        if (logBadge) {
            const expectedText = spec.logScale ? 'LOG' : 'LIN';
            logBadge.textContent = expectedText;
            logBadge.style.background = spec.logScale ? 'rgba(168, 85, 247, 0.2)' : 'rgba(255, 255, 255, 0.08)';
            logBadge.style.color = spec.logScale ? '#c084fc' : '#94a3b8';
            logBadge.style.border = spec.logScale ? '1px solid rgba(168, 85, 247, 0.35)' : '1px solid rgba(255, 255, 255, 0.15)';
            logBadge.onclick = (e) => {
                e.stopPropagation();
                spec.onToggleLog();
            };
        }

        const cmapBadge = card.querySelector('.viewport-colorbar-cmap-badge') as HTMLElement;
        if (cmapBadge) {
            cmapBadge.textContent = spec.colormap.toUpperCase();
            cmapBadge.title = `Color Scheme: ${spec.colormap.toUpperCase()} (Click to change)`;
            cmapBadge.onclick = (e) => {
                e.stopPropagation();
                spec.onSelectColormap(cmapBadge);
            };
        }

        const lockBadge = card.querySelector('.viewport-colorbar-lock-badge') as HTMLElement;
        if (lockBadge) {
            const expectedText = spec.isLocked ? '🔒 UNIFIED' : '🔓 INDEP';
            lockBadge.textContent = expectedText;
            lockBadge.style.background = spec.isLocked ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)';
            lockBadge.style.color = spec.isLocked ? '#34d399' : '#f87171';
            lockBadge.style.border = spec.isLocked ? '1px solid rgba(52, 211, 153, 0.35)' : '1px solid rgba(239, 68, 68, 0.35)';
            lockBadge.onclick = (e) => {
                e.stopPropagation();
                spec.onToggleLock?.();
            };
        }

        const gradBar = card.querySelector('.viewport-colorbar-grad-bar') as HTMLElement;
        if (gradBar) {
            const expectedGrad = this.getColormapCssGradient(spec.colormap, 'to top');
            gradBar.style.background = expectedGrad;
            gradBar.title = `Color Scheme: ${spec.colormap.toUpperCase()} (Click to change)`;
            gradBar.onclick = (e) => {
                e.stopPropagation();
                spec.onSelectColormap(gradBar);
            };
        }

        const numTicks = 5;
        let displayMinVal = spec.minVal;
        const displayMaxVal = spec.maxVal;
        if (spec.logScale && displayMinVal <= 0 && displayMaxVal > 0) {
            displayMinVal = displayMaxVal / 1000000.0;
        }
        const rangeSpan = Math.abs(displayMaxVal - displayMinVal);

        const maxInput = card.querySelector('input[data-tick-role="max"]') as HTMLInputElement;
        if (maxInput) {
            if (maxInput.dataset.editing !== 'true' && document.activeElement !== maxInput) {
                maxInput.value = this.formatRangeValue(spec.maxVal, rangeSpan);
            }
            maxInput.onfocus = () => {
                maxInput.dataset.editing = 'true';
                maxInput.value = String(spec.maxVal);
                maxInput.select();
            };
            maxInput.onblur = () => {
                delete maxInput.dataset.editing;
                const newV = Number(maxInput.value);
                if (!isNaN(newV) && maxInput.value.trim() !== '') {
                    spec.onSetMinMax(spec.minVal, newV);
                } else {
                    maxInput.value = this.formatRangeValue(spec.maxVal, rangeSpan);
                }
            };
        }

        const minInput = card.querySelector('input[data-tick-role="min"]') as HTMLInputElement;
        if (minInput) {
            if (minInput.dataset.editing !== 'true' && document.activeElement !== minInput) {
                minInput.value = this.formatRangeValue(spec.minVal, rangeSpan);
            }
            minInput.onfocus = () => {
                minInput.dataset.editing = 'true';
                minInput.value = String(spec.minVal);
                minInput.select();
            };
            minInput.onblur = () => {
                delete minInput.dataset.editing;
                const newV = Number(minInput.value);
                if (!isNaN(newV) && minInput.value.trim() !== '') {
                    spec.onSetMinMax(newV, spec.maxVal);
                } else {
                    minInput.value = this.formatRangeValue(spec.minVal, rangeSpan);
                }
            };
        }

        for (let i = 1; i < numTicks - 1; i++) {
            const t = (numTicks - 1 - i) / (numTicks - 1);
            let val = displayMinVal + t * (displayMaxVal - displayMinVal);
            if (spec.logScale && displayMinVal > 0 && displayMaxVal > displayMinVal) {
                val = displayMinVal * Math.pow(displayMaxVal / displayMinVal, t);
            }
            const label = card.querySelector(`span[data-tick-role="intermediate"][data-tick-index="${i}"]`) as HTMLElement;
            if (label) {
                label.textContent = this.formatRangeValue(val, rangeSpan);
            }
        }
    }

    private syncColorbarOverlay(vpNode: any) {
        if (!this.colorbarContainer) {
            this.buildColorbarContainer();
        }
        if (!this.colorbarContainer) return;
        if (!vpNode) vpNode = { parameters: {} };
        const params = vpNode.parameters || {};

        if (this.colorbarContainer) {
            const activeEl = document.activeElement;
            if (activeEl && this.colorbarContainer.contains(activeEl) && activeEl.getAttribute('data-editing') === 'true') {
                return;
            }
        }

        const unitMap: Record<string, string> = {
            pressure: 'Pa',
            density: 'kg/m³',
            velocity: 'm/s',
            energy: 'J/kg',
            species1: 'frac',
            species2: 'frac',
            species3: 'frac',
            overpressure: 'Pa',
            peak_overpressure: 'Pa',
            impulse: 'Pa·s',
            peak_impulse: 'Pa·s',
            vonMises: 'Pa',
            von_mises: 'Pa',
            plasticStrain: 'frac',
            plastic_strain: 'frac',
            damage: 'frac',
            has_failed: 'frac',
            cluster_id: 'ID',
            object_id: 'ID',
            temperature: 'K',
            displacement: 'm',
            momentOrForce: 'N/N·m'
        };

        const qtyDisplayMap: Record<string, string> = {
            pressure: 'Pressure',
            density: 'Density',
            velocity: 'Speed',
            energy: 'Energy',
            species1: 'Reacted',
            species2: 'Unreacted',
            species3: 'Air',
            solid: 'Solid',
            overpressure: 'Overpress',
            peak_overpressure: 'Pk Overpress',
            impulse: 'Pk Impulse',
            peak_impulse: 'Pk Impulse',
            vonMises: 'Von Mises',
            von_mises: 'Von Mises',
            plasticStrain: 'Pl Strain',
            plastic_strain: 'Pl Strain',
            damage: 'Damage',
            has_failed: 'Failure',
            cluster_id: 'Fragments',
            object_id: 'Obj ID',
            temperature: 'Temp',
            displacement: 'Disp',
            momentOrForce: 'Force/Mom'
        };

        const formatCbTitle = (source: string, qty: string) => {
            const cQ = canonicalizeQuantity(qty);
            const label = qtyDisplayMap[cQ] || qtyDisplayMap[qty] || qty;
            const unit = unitMap[cQ] || unitMap[qty] ? ` (${unitMap[cQ] || unitMap[qty]})` : '';
            return `${source}: ${label}${unit}`;
        };

        const specs: Array<{
            id: string;
            title: string;
            quantity: string;
            colormap: string;
            autoScale: boolean;
            logScale: boolean;
            isLocked: boolean;
            minVal: number;
            maxVal: number;
            onToggleOff: () => void;
            onToggleAuto: () => void;
            onToggleLog: () => void;
            onToggleLock: () => void;
            onSelectColormap: (anchorEl: HTMLElement) => void;
            onSetMinMax: (min: number, max: number) => void;
            onSelectQuantity: (anchorEl: HTMLElement) => void;
        }> = [];

        const isGloballyLocked = params.lock_quantity_ranges !== false;

        const toggleGlobalLock = (seedQty?: string, seedSpec?: { colormap: string, logScale: boolean, autoScale: boolean, minVal: number, maxVal: number }) => {
            const newLock = !isGloballyLocked;
            if (newLock && seedQty && seedSpec) {
                const cQ = canonicalizeQuantity(seedQty);
                this.setQuantityColormap(cQ, seedSpec.colormap);
                this.setQuantityLogScale(cQ, seedSpec.logScale);
                this.setQuantityAutoScale(cQ, seedSpec.autoScale);
                this.setQuantityRange(cQ, seedSpec.minVal, seedSpec.maxVal, seedSpec.autoScale, seedSpec.logScale);
            }
            this.stateManager.updateNodeParametersInPlace(vpNode.id, { lock_quantity_ranges: newLock });
            this.worker.postMessage({ type: 'setConfig', data: { lockQuantityRanges: newLock } });
            this.syncControls(false);
        };

        // 1. Slices
        const slices = params.slices || [];
        slices.forEach((slice: any, idx: number) => {
            if (slice.show_colorbar === true && slice.enabled !== false) {
                const rawQty = slice.quantities?.[0] || 'pressure';
                const qty = canonicalizeQuantity(rawQty);
                const sliceIsLocked = (params.lock_quantity_ranges !== false) && (slice.lock_quantity_range !== false);
                const colormap = (sliceIsLocked ? (params.quantity_colormaps?.[qty] || params.quantity_colormaps?.[rawQty]) : undefined) || slice.colormap || 'rainbow';
                const autoScale = (sliceIsLocked ? (params.quantity_auto_scales?.[qty] ?? params.quantity_auto_scales?.[rawQty]) : undefined) ?? (slice.auto_scale !== false);
                const logScale = (sliceIsLocked ? (params.quantity_log_scales?.[qty] ?? params.quantity_log_scales?.[rawQty]) : undefined) ?? (slice.log_scale === true);
                const defaultSliceRange = this.latestQuantityRanges?.[qty] || this.latestQuantityRanges?.[rawQty] || params.quantity_ranges?.[qty] || params.quantity_ranges?.[rawQty] || DEFAULT_QUANTITY_RANGES[qty] || [0.0, 1.0];
                let minVal = slice.min_val ?? defaultSliceRange[0];
                let maxVal = slice.max_val ?? defaultSliceRange[1];
                if (sliceIsLocked) {
                    minVal = defaultSliceRange[0];
                    maxVal = defaultSliceRange[1];
                } else if (autoScale && this.latestSliceRanges && this.latestSliceRanges[idx]) {
                    minVal = this.latestSliceRanges[idx].min;
                    maxVal = this.latestSliceRanges[idx].max;
                } else if (autoScale && this.latestEmpiricalRange) {
                    const rangeSpan = this.latestEmpiricalRange.max - this.latestEmpiricalRange.min;
                    if (rangeSpan > Math.max(1e-4 * Math.abs(this.latestEmpiricalRange.max), 1e-4)) {
                        minVal = this.latestEmpiricalRange.min;
                        maxVal = this.latestEmpiricalRange.max;
                    }
                }
                specs.push({
                    id: `slice-${idx}`,
                    title: formatCbTitle(`Slice #${idx + 1}`, qty),
                    quantity: qty,
                    colormap: colormap,
                    autoScale: autoScale,
                    logScale: logScale,
                    isLocked: sliceIsLocked,
                    minVal: minVal,
                    maxVal: maxVal,
                    onToggleOff: () => {
                        this.updateSliceProperty(idx, { show_colorbar: false });
                    },
                    onToggleAuto: () => {
                        if (sliceIsLocked) {
                            this.setQuantityAutoScale(qty, !autoScale);
                        } else {
                            this.updateSliceProperty(idx, { auto_scale: !autoScale });
                        }
                    },
                    onToggleLog: () => {
                        if (sliceIsLocked) {
                            this.setQuantityLogScale(qty, !logScale);
                        } else {
                            this.updateSliceProperty(idx, { log_scale: !logScale });
                        }
                    },
                    onToggleLock: () => {
                        const newLock = !sliceIsLocked;
                        if (newLock) {
                            this.setQuantityColormap(qty, colormap);
                            this.setQuantityLogScale(qty, logScale);
                            this.setQuantityAutoScale(qty, autoScale);
                            this.setQuantityRange(qty, minVal, maxVal, autoScale, logScale);
                        }
                        this.updateSliceProperty(idx, { lock_quantity_range: newLock });
                    },
                    onSelectColormap: (anchorEl: HTMLElement) => {
                        this.showColormapPopover(anchorEl, colormap, (newCmap) => {
                            if (sliceIsLocked) {
                                this.setQuantityColormap(qty, newCmap);
                            } else {
                                this.updateSliceProperty(idx, { colormap: newCmap });
                            }
                        });
                    },
                    onSetMinMax: (minN: number, maxN: number) => {
                        if (sliceIsLocked) {
                            this.setQuantityRange(qty, minN, maxN, false);
                        } else {
                            this.updateSliceProperty(idx, { auto_scale: false, min_val: minN, max_val: maxN });
                        }
                    },
                    onSelectQuantity: (anchorEl: HTMLElement) => {
                        this.showQuantityPopover(anchorEl, qty, 'cfd', (newQ) => {
                            const cNewQ = canonicalizeQuantity(newQ);
                            const qCmaps = params.quantity_colormaps || {};
                            const newCmap = sliceIsLocked ? (qCmaps[cNewQ] || qCmaps[newQ] || 'rainbow') : colormap;
                            const qRanges = this.latestQuantityRanges || params.quantity_ranges || {};
                            const newRange = sliceIsLocked ? (qRanges[cNewQ] || qRanges[newQ] || DEFAULT_QUANTITY_RANGES[cNewQ] || [0.0, 1.0]) : [minVal, maxVal];
                            const qLogs = params.quantity_log_scales || {};
                            const newLog = sliceIsLocked ? (qLogs[cNewQ] ?? qLogs[newQ] ?? (cNewQ === 'peak_overpressure' || cNewQ === 'energy')) : logScale;
                            const qAutos = params.quantity_auto_scales || {};
                            const newAuto = sliceIsLocked ? (qAutos[cNewQ] ?? qAutos[newQ] ?? true) : autoScale;
                            this.updateSliceProperty(idx, {
                                quantities: [cNewQ],
                                colormap: newCmap,
                                min_val: newRange[0],
                                max_val: newRange[1],
                                log_scale: newLog,
                                auto_scale: newAuto
                            });
                        });
                    }
                });
            }
        });

        // 2. Obstacles
        if (params.obstacles_show_colorbar === true && params.show_obstacles !== false) {
            const rawQty = params.obstacles_quantity || 'pressure';
            const qty = canonicalizeQuantity(rawQty);
            const obsIsLocked = (params.lock_quantity_ranges !== false) && (params.obstacles_lock_quantity_range !== false);
            const colormap = (obsIsLocked ? (params.quantity_colormaps?.[qty] || params.quantity_colormaps?.[rawQty]) : undefined) || params.obstacles_colormap || 'rainbow';
            const autoScale = (obsIsLocked ? (params.quantity_auto_scales?.[qty] ?? params.quantity_auto_scales?.[rawQty]) : undefined) ?? (params.obstacles_auto_scale !== false);
            const logScale = (obsIsLocked ? (params.quantity_log_scales?.[qty] ?? params.quantity_log_scales?.[rawQty]) : undefined) ?? (params.obstacles_log_scale === true);
            const defaultObsRange = this.latestQuantityRanges?.[qty] || this.latestQuantityRanges?.[rawQty] || params.quantity_ranges?.[qty] || params.quantity_ranges?.[rawQty] || DEFAULT_QUANTITY_RANGES[qty] || [0.0, 1.0];
            let minVal = params.obstacles_min_val ?? defaultObsRange[0];
            let maxVal = params.obstacles_max_val ?? defaultObsRange[1];
            if (obsIsLocked) {
                minVal = defaultObsRange[0];
                maxVal = defaultObsRange[1];
            } else if (autoScale && this.latestObstaclesRange) {
                minVal = this.latestObstaclesRange.min;
                maxVal = this.latestObstaclesRange.max;
            }
            specs.push({
                id: 'obstacles',
                title: formatCbTitle('Obstacles', qty),
                quantity: qty,
                colormap: colormap,
                autoScale: autoScale,
                logScale: logScale,
                isLocked: obsIsLocked,
                minVal: minVal,
                maxVal: maxVal,
                onToggleOff: () => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { obstacles_show_colorbar: false });
                    this.syncControls(false);
                },
                onToggleAuto: () => {
                    if (obsIsLocked) {
                        this.setQuantityAutoScale(qty, !autoScale);
                    } else {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { obstacles_auto_scale: !autoScale });
                        this.worker.postMessage({ type: 'setConfig', data: { obstaclesAutoScale: !autoScale } });
                        this.syncControls(false);
                    }
                },
                onToggleLog: () => {
                    if (obsIsLocked) {
                        this.setQuantityLogScale(qty, !logScale);
                    } else {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { obstacles_log_scale: !logScale });
                        this.worker.postMessage({ type: 'setConfig', data: { obstaclesLogScale: !logScale } });
                        this.syncControls(false);
                    }
                },
                onToggleLock: () => {
                    const newLock = !obsIsLocked;
                    if (newLock) {
                        this.setQuantityColormap(qty, colormap);
                        this.setQuantityLogScale(qty, logScale);
                        this.setQuantityAutoScale(qty, autoScale);
                        this.setQuantityRange(qty, minVal, maxVal, autoScale, logScale);
                    }
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { obstacles_lock_quantity_range: newLock });
                    this.worker.postMessage({ type: 'setConfig', data: { obstaclesLockQuantityRange: newLock } });
                    this.syncControls(false);
                },
                onSelectColormap: (anchorEl: HTMLElement) => {
                    this.showColormapPopover(anchorEl, colormap, (newCmap) => {
                        if (obsIsLocked) {
                            this.setQuantityColormap(qty, newCmap);
                        } else {
                            this.stateManager.updateNodeParametersInPlace(vpNode.id, { obstacles_colormap: newCmap });
                            this.worker.postMessage({ type: 'setConfig', data: { obstaclesColormap: newCmap } });
                            this.syncControls(false);
                        }
                    });
                },
                onSetMinMax: (minN: number, maxN: number) => {
                    if (obsIsLocked) {
                        this.setQuantityRange(qty, minN, maxN, false);
                    } else {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { obstacles_auto_scale: false, obstacles_min_val: minN, obstacles_max_val: maxN });
                        this.worker.postMessage({ type: 'setConfig', data: { obstaclesAutoScale: false, obstaclesMinVal: minN, obstaclesMaxVal: maxN } });
                        this.syncControls(false);
                    }
                },
                onSelectQuantity: (anchorEl: HTMLElement) => {
                    this.showQuantityPopover(anchorEl, qty, 'cfd', (newQ) => {
                        const cNewQ = canonicalizeQuantity(newQ);
                        const qCmaps = params.quantity_colormaps || {};
                        const newCmap = obsIsLocked ? (qCmaps[cNewQ] || qCmaps[newQ] || 'rainbow') : colormap;
                        const qRanges = this.latestQuantityRanges || params.quantity_ranges || {};
                        const newRange = obsIsLocked ? (qRanges[cNewQ] || qRanges[newQ] || DEFAULT_QUANTITY_RANGES[cNewQ] || [0.0, 1.0]) : [minVal, maxVal];
                        const qLogs = params.quantity_log_scales || {};
                        const newLog = obsIsLocked ? (qLogs[cNewQ] ?? qLogs[newQ] ?? (cNewQ === 'peak_overpressure' || cNewQ === 'energy')) : logScale;
                        const qAutos = params.quantity_auto_scales || {};
                        const newAuto = obsIsLocked ? (qAutos[cNewQ] ?? qAutos[newQ] ?? true) : autoScale;
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, {
                            obstacles_quantity: cNewQ,
                            obstacles_colormap: newCmap,
                            obstacles_min_val: newRange[0],
                            obstacles_max_val: newRange[1],
                            obstacles_log_scale: newLog,
                            obstacles_auto_scale: newAuto
                        });
                        this.worker.postMessage({
                            type: 'setConfig',
                            data: {
                                obstaclesQuantity: cNewQ,
                                obstaclesColormap: newCmap,
                                obstaclesMinVal: newRange[0],
                                obstaclesMaxVal: newRange[1],
                                obstaclesLogScale: newLog,
                                obstaclesAutoScale: newAuto
                            }
                        });
                        this.sendView3DConfig();
                        this.syncControls(false);
                    });
                }
            });
        }

        // 3. STL Mesh
        if (params.stl_show_colorbar === true && params.show_stl !== false) {
            const rawQty = params.stl_quantity || 'pressure';
            const qty = canonicalizeQuantity(rawQty);
            const stlIsLocked = (params.lock_quantity_ranges !== false) && (params.stl_lock_quantity_range !== false);
            const colormap = (stlIsLocked ? (params.quantity_colormaps?.[qty] || params.quantity_colormaps?.[rawQty]) : undefined) || params.stl_colormap || 'rainbow';
            const autoScale = (stlIsLocked ? (params.quantity_auto_scales?.[qty] ?? params.quantity_auto_scales?.[rawQty]) : undefined) ?? (params.stl_auto_scale !== false);
            const logScale = (stlIsLocked ? (params.quantity_log_scales?.[qty] ?? params.quantity_log_scales?.[rawQty]) : undefined) ?? (params.stl_log_scale === true);
            const defaultStlRange = this.latestQuantityRanges?.[qty] || this.latestQuantityRanges?.[rawQty] || params.quantity_ranges?.[qty] || params.quantity_ranges?.[rawQty] || DEFAULT_QUANTITY_RANGES[qty] || [0.0, 1.0];
            let minVal = params.stl_min_val ?? defaultStlRange[0];
            let maxVal = params.stl_max_val ?? defaultStlRange[1];
            if (stlIsLocked) {
                minVal = defaultStlRange[0];
                maxVal = defaultStlRange[1];
            } else if (autoScale && this.latestSTLRange) {
                minVal = this.latestSTLRange.min;
                maxVal = this.latestSTLRange.max;
            }
            specs.push({
                id: 'stl',
                title: formatCbTitle('STL', qty),
                quantity: qty,
                colormap: colormap,
                autoScale: autoScale,
                logScale: logScale,
                isLocked: stlIsLocked,
                minVal: minVal,
                maxVal: maxVal,
                onToggleOff: () => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { stl_show_colorbar: false });
                    this.syncControls(false);
                },
                onToggleAuto: () => {
                    if (stlIsLocked) {
                        this.setQuantityAutoScale(qty, !autoScale);
                    } else {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { stl_auto_scale: !autoScale });
                        const stlNode = this.getGeometryNode();
                        if (stlNode && stlNode.type === 'STLGeometry') {
                            this.stateManager.updateNodeParametersInPlace(stlNode.id, { stl_auto_scale: !autoScale });
                        }
                        this.worker.postMessage({ type: 'setConfig', data: { stlAutoScale: !autoScale } });
                        this.syncControls(false);
                    }
                },
                onToggleLog: () => {
                    if (stlIsLocked) {
                        this.setQuantityLogScale(qty, !logScale);
                    } else {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { stl_log_scale: !logScale });
                        const stlNode = this.getGeometryNode();
                        if (stlNode && stlNode.type === 'STLGeometry') {
                            this.stateManager.updateNodeParametersInPlace(stlNode.id, { stl_log_scale: !logScale });
                        }
                        this.worker.postMessage({ type: 'setConfig', data: { stlLogScale: !logScale } });
                        this.syncControls(false);
                    }
                },
                onToggleLock: () => {
                    const newLock = !stlIsLocked;
                    if (newLock) {
                        this.setQuantityColormap(qty, colormap);
                        this.setQuantityLogScale(qty, logScale);
                        this.setQuantityAutoScale(qty, autoScale);
                        this.setQuantityRange(qty, minVal, maxVal, autoScale, logScale);
                    }
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { stl_lock_quantity_range: newLock });
                    const stlNode = this.getGeometryNode();
                    if (stlNode && stlNode.type === 'STLGeometry') {
                        this.stateManager.updateNodeParametersInPlace(stlNode.id, { stl_lock_quantity_range: newLock });
                    }
                    this.worker.postMessage({ type: 'setConfig', data: { stlLockQuantityRange: newLock } });
                    this.syncControls(false);
                },
                onSelectColormap: (anchorEl: HTMLElement) => {
                    this.showColormapPopover(anchorEl, colormap, (newCmap) => {
                        if (stlIsLocked) {
                            this.setQuantityColormap(qty, newCmap);
                        } else {
                            this.stateManager.updateNodeParametersInPlace(vpNode.id, { stl_colormap: newCmap });
                            const stlNode = this.getGeometryNode();
                            if (stlNode && stlNode.type === 'STLGeometry') {
                                this.stateManager.updateNodeParametersInPlace(stlNode.id, { stl_colormap: newCmap, colormap: newCmap });
                            }
                            this.worker.postMessage({ type: 'setConfig', data: { stlColormap: newCmap } });
                            this.syncControls(false);
                        }
                    });
                },
                onSetMinMax: (minN: number, maxN: number) => {
                    if (stlIsLocked) {
                        this.setQuantityRange(qty, minN, maxN, false);
                    } else {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { stl_auto_scale: false, stl_min_val: minN, stl_max_val: maxN });
                        const stlNode = this.getGeometryNode();
                        if (stlNode && stlNode.type === 'STLGeometry') {
                            this.stateManager.updateNodeParametersInPlace(stlNode.id, { stl_auto_scale: false, stl_min_val: minN, stl_max_val: maxN });
                        }
                        this.worker.postMessage({ type: 'setConfig', data: { stlAutoScale: false, stlMinVal: minN, stlMaxVal: maxN } });
                        this.syncControls(false);
                    }
                },
                onSelectQuantity: (anchorEl: HTMLElement) => {
                    this.showQuantityPopover(anchorEl, qty, 'cfd', (newQ) => {
                        const cNewQ = canonicalizeQuantity(newQ);
                        const qCmaps = params.quantity_colormaps || {};
                        const newCmap = isGloballyLocked ? (qCmaps[cNewQ] || qCmaps[newQ] || 'rainbow') : colormap;
                        const qRanges = params.quantity_ranges || {};
                        const newRange = isGloballyLocked ? (qRanges[cNewQ] || qRanges[newQ] || DEFAULT_QUANTITY_RANGES[cNewQ] || [0.0, 1.0]) : [minVal, maxVal];
                        const qLogs = params.quantity_log_scales || {};
                        const newLog = isGloballyLocked ? (qLogs[cNewQ] ?? qLogs[newQ] ?? (cNewQ === 'peak_overpressure' || cNewQ === 'energy')) : logScale;
                        const qAutos = params.quantity_auto_scales || {};
                        const newAuto = isGloballyLocked ? (qAutos[cNewQ] ?? qAutos[newQ] ?? true) : autoScale;
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, {
                            stl_quantity: cNewQ,
                            stl_colormap: newCmap,
                            stl_min_val: newRange[0],
                            stl_max_val: newRange[1],
                            stl_log_scale: newLog,
                            stl_auto_scale: newAuto
                        });
                        const stlNode = this.getGeometryNode();
                        if (stlNode && stlNode.type === 'STLGeometry') {
                            this.stateManager.updateNodeParametersInPlace(stlNode.id, {
                                stl_quantity: cNewQ,
                                quantity: cNewQ,
                                stl_colormap: newCmap,
                                colormap: newCmap,
                                stl_min_val: newRange[0],
                                stl_max_val: newRange[1],
                                stl_log_scale: newLog,
                                stl_auto_scale: newAuto
                            });
                        }
                        this.worker.postMessage({
                            type: 'setConfig',
                            data: {
                                stlQuantity: cNewQ,
                                stlColormap: newCmap,
                                stlMinVal: newRange[0],
                                stlMaxVal: newRange[1],
                                stlLogScale: newLog,
                                stlAutoScale: newAuto
                            }
                        });
                        this.sendView3DConfig();
                        this.syncControls(false);
                    });
                }
            });
        }

        // 4. MPM Particles
        if (params.mpmParticleShowColorbar === true && params.showMPMParticles !== false) {
            const rawQty = params.mpmParticleQuantity || 'vonMises';
            const qty = canonicalizeQuantity(rawQty);
            const mpmIsLocked = (params.lock_quantity_ranges !== false) && (params.mpm_lock_quantity_range !== false);
            const colormap = (mpmIsLocked ? (params.quantity_colormaps?.[qty] || params.quantity_colormaps?.[rawQty]) : undefined) || params.mpmParticleColormap || 'rainbow';
            const autoScale = (mpmIsLocked ? (params.quantity_auto_scales?.[qty] ?? params.quantity_auto_scales?.[rawQty]) : undefined) ?? (params.mpmParticleAutoScale !== false);
            const logScale = (mpmIsLocked ? (params.quantity_log_scales?.[qty] ?? params.quantity_log_scales?.[rawQty]) : undefined) ?? (params.mpmParticleLogScale === true);
            const defaultRange = this.latestQuantityRanges?.[qty] || this.latestQuantityRanges?.[rawQty] || params.quantity_ranges?.[qty] || params.quantity_ranges?.[rawQty] || DEFAULT_QUANTITY_RANGES[qty] || [0.0, 500000000.0];
            let minVal = params.mpmParticleMinVal ?? defaultRange[0];
            let maxVal = params.mpmParticleMaxVal ?? defaultRange[1];
            if (mpmIsLocked) {
                minVal = defaultRange[0];
                maxVal = defaultRange[1];
            } else if (autoScale && (this.latestMPMRange || this.latestEmpiricalRange)) {
                const r = this.latestMPMRange || this.latestEmpiricalRange!;
                minVal = r.min;
                maxVal = r.max;
            }
            specs.push({
                id: 'mpm',
                title: formatCbTitle('MPM', qty),
                quantity: qty,
                colormap: colormap,
                autoScale: autoScale,
                logScale: logScale,
                isLocked: mpmIsLocked,
                minVal: minVal,
                maxVal: maxVal,
                onToggleOff: () => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmParticleShowColorbar: false });
                    this.syncControls(false);
                },
                onToggleAuto: () => {
                    if (mpmIsLocked) {
                        this.setQuantityAutoScale(qty, !autoScale);
                    } else {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmParticleAutoScale: !autoScale });
                        this.worker.postMessage({ type: 'setConfig', data: { mpmParticleAutoScale: !autoScale } });
                        this.syncControls(false);
                    }
                },
                onToggleLog: () => {
                    if (mpmIsLocked) {
                        this.setQuantityLogScale(qty, !logScale);
                    } else {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmParticleLogScale: !logScale });
                        this.worker.postMessage({ type: 'setConfig', data: { mpmParticleLogScale: !logScale } });
                        this.syncControls(false);
                    }
                },
                onToggleLock: () => {
                    const newLock = !mpmIsLocked;
                    if (newLock) {
                        this.setQuantityColormap(qty, colormap);
                        this.setQuantityLogScale(qty, logScale);
                        this.setQuantityAutoScale(qty, autoScale);
                        this.setQuantityRange(qty, minVal, maxVal, autoScale, logScale);
                    }
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpm_lock_quantity_range: newLock });
                    this.worker.postMessage({ type: 'setConfig', data: { mpmLockQuantityRange: newLock } });
                    this.syncControls(false);
                },
                onSelectColormap: (anchorEl: HTMLElement) => {
                    this.showColormapPopover(anchorEl, colormap, (newCmap) => {
                        if (mpmIsLocked) {
                            this.setQuantityColormap(qty, newCmap);
                        } else {
                            this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmParticleColormap: newCmap });
                            this.worker.postMessage({ type: 'setConfig', data: { mpmParticleColormap: newCmap } });
                            this.syncControls(false);
                        }
                    });
                },
                onSetMinMax: (minN: number, maxN: number) => {
                    if (mpmIsLocked) {
                        this.setQuantityRange(qty, minN, maxN, false);
                    } else {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmParticleAutoScale: false, mpmParticleMinVal: minN, mpmParticleMaxVal: maxN });
                        this.worker.postMessage({ type: 'setConfig', data: { mpmParticleAutoScale: false, mpmParticleMinVal: minN, mpmParticleMaxVal: maxN } });
                        this.syncControls(false);
                    }
                },
                onSelectQuantity: (anchorEl: HTMLElement) => {
                    this.showQuantityPopover(anchorEl, qty, 'mpm', (newQ) => {
                        const cNewQ = canonicalizeQuantity(newQ);
                        const qCmaps = params.quantity_colormaps || {};
                        const newCmap = mpmIsLocked ? (qCmaps[cNewQ] || qCmaps[newQ] || 'rainbow') : colormap;
                        const qRanges = this.latestQuantityRanges || params.quantity_ranges || {};
                        const newRange = mpmIsLocked ? (qRanges[cNewQ] || qRanges[newQ] || DEFAULT_QUANTITY_RANGES[cNewQ] || [0.0, 500000000.0]) : [minVal, maxVal];
                        const qLogs = params.quantity_log_scales || {};
                        const newLog = mpmIsLocked ? (qLogs[cNewQ] ?? qLogs[newQ] ?? (cNewQ === 'plastic_strain' || cNewQ === 'energy')) : logScale;
                        const qAutos = params.quantity_auto_scales || {};
                        const newAuto = mpmIsLocked ? (qAutos[cNewQ] ?? qAutos[newQ] ?? true) : autoScale;
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, {
                            mpmParticleQuantity: cNewQ,
                            mpmParticleColormap: newCmap,
                            mpmParticleMinVal: newRange[0],
                            mpmParticleMaxVal: newRange[1],
                            mpmParticleLogScale: newLog,
                            mpmParticleAutoScale: newAuto
                        });
                        this.worker.postMessage({
                            type: 'setConfig',
                            data: {
                                mpmParticleQuantity: cNewQ,
                                mpmParticleColormap: newCmap,
                                mpmParticleMinVal: newRange[0],
                                mpmParticleMaxVal: newRange[1],
                                mpmParticleLogScale: newLog,
                                mpmParticleAutoScale: newAuto
                            }
                        });
                        this.syncControls(false);
                    });
                }
            });
        }

        // 5. FEM Mesh
        if (params.femShowColorbar === true && params.showFEMMesh !== false) {
            const rawQty = params.femQuantity || 'vonMises';
            const qty = canonicalizeQuantity(rawQty);
            const femIsLocked = (params.lock_quantity_ranges !== false) && (params.fem_lock_quantity_range !== false);
            const colormap = (femIsLocked ? (params.quantity_colormaps?.[qty] || params.quantity_colormaps?.[rawQty]) : undefined) || params.femColormap || 'rainbow';
            const autoScale = (femIsLocked ? (params.quantity_auto_scales?.[qty] ?? params.quantity_auto_scales?.[rawQty]) : undefined) ?? (params.femAutoScale !== false);
            const logScale = (femIsLocked ? (params.quantity_log_scales?.[qty] ?? params.quantity_log_scales?.[rawQty]) : undefined) ?? (params.femLogScale === true);
            const defaultRange = this.latestQuantityRanges?.[qty] || this.latestQuantityRanges?.[rawQty] || params.quantity_ranges?.[qty] || params.quantity_ranges?.[rawQty] || DEFAULT_QUANTITY_RANGES[qty] || [0.0, (qty === 'plastic_strain' ? 1.0 : 500000000.0)];
            let minVal = params.femMinVal ?? defaultRange[0];
            let maxVal = params.femMaxVal ?? defaultRange[1];
            if (femIsLocked) {
                minVal = defaultRange[0];
                maxVal = defaultRange[1];
            } else if (autoScale && (this.latestFEMRange || this.latestEmpiricalRange)) {
                const r = this.latestFEMRange || this.latestEmpiricalRange!;
                minVal = r.min;
                maxVal = r.max;
            }
            specs.push({
                id: 'fem',
                title: formatCbTitle('FEM', qty),
                quantity: qty,
                colormap: colormap,
                autoScale: autoScale,
                logScale: logScale,
                isLocked: femIsLocked,
                minVal: minVal,
                maxVal: maxVal,
                onToggleOff: () => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { femShowColorbar: false });
                    this.syncControls(false);
                },
                onToggleAuto: () => {
                    if (femIsLocked) {
                        this.setQuantityAutoScale(qty, !autoScale);
                    } else {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { femAutoScale: !autoScale });
                        this.worker.postMessage({ type: 'setConfig', data: { femAutoScale: !autoScale } });
                        this.syncControls(false);
                    }
                },
                onToggleLog: () => {
                    if (femIsLocked) {
                        this.setQuantityLogScale(qty, !logScale);
                    } else {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { femLogScale: !logScale });
                        this.worker.postMessage({ type: 'setConfig', data: { femLogScale: !logScale } });
                        this.syncControls(false);
                    }
                },
                onToggleLock: () => {
                    const newLock = !femIsLocked;
                    if (newLock) {
                        this.setQuantityColormap(qty, colormap);
                        this.setQuantityLogScale(qty, logScale);
                        this.setQuantityAutoScale(qty, autoScale);
                        this.setQuantityRange(qty, minVal, maxVal, autoScale, logScale);
                    }
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { fem_lock_quantity_range: newLock });
                    this.worker.postMessage({ type: 'setConfig', data: { femLockQuantityRange: newLock } });
                    this.syncControls(false);
                },
                onSelectColormap: (anchorEl: HTMLElement) => {
                    this.showColormapPopover(anchorEl, colormap, (newCmap) => {
                        if (femIsLocked) {
                            this.setQuantityColormap(qty, newCmap);
                        } else {
                            this.stateManager.updateNodeParametersInPlace(vpNode.id, { femColormap: newCmap });
                            this.worker.postMessage({ type: 'setConfig', data: { femColormap: newCmap } });
                            this.syncControls(false);
                        }
                    });
                },
                onSetMinMax: (minN: number, maxN: number) => {
                    if (femIsLocked) {
                        this.setQuantityRange(qty, minN, maxN, false);
                    } else {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { femAutoScale: false, femMinVal: minN, femMaxVal: maxN });
                        this.worker.postMessage({ type: 'setConfig', data: { femAutoScale: false, femMinVal: minN, femMaxVal: maxN } });
                        this.syncControls(false);
                    }
                },
                onSelectQuantity: (anchorEl: HTMLElement) => {
                    this.showQuantityPopover(anchorEl, qty, 'fem', (newQ) => {
                        const cNewQ = canonicalizeQuantity(newQ);
                        const qCmaps = params.quantity_colormaps || {};
                        const newCmap = femIsLocked ? (qCmaps[cNewQ] || qCmaps[newQ] || 'rainbow') : colormap;
                        const qRanges = this.latestQuantityRanges || params.quantity_ranges || {};
                        const newRange = femIsLocked ? (qRanges[cNewQ] || qRanges[newQ] || DEFAULT_QUANTITY_RANGES[cNewQ] || [0.0, (cNewQ === 'plastic_strain' ? 1.0 : 500000000.0)]) : [minVal, maxVal];
                        const qLogs = params.quantity_log_scales || {};
                        const newLog = femIsLocked ? (qLogs[cNewQ] ?? qLogs[newQ] ?? (cNewQ === 'plastic_strain' || cNewQ === 'energy')) : logScale;
                        const qAutos = params.quantity_auto_scales || {};
                        const newAuto = femIsLocked ? (qAutos[cNewQ] ?? qAutos[newQ] ?? true) : autoScale;
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, {
                            femQuantity: cNewQ,
                            femColormap: newCmap,
                            femMinVal: newRange[0],
                            femMaxVal: newRange[1],
                            femLogScale: newLog,
                            femAutoScale: newAuto
                        });
                        this.worker.postMessage({
                            type: 'setConfig',
                            data: {
                                femQuantity: cNewQ,
                                femColormap: newCmap,
                                femMinVal: newRange[0],
                                femMaxVal: newRange[1],
                                femLogScale: newLog,
                                femAutoScale: newAuto
                            }
                        });
                        this.syncControls(false);
                    });
                }
            });
        }

        // 6. Beams / 1D Elements
        if (params.beamShowColorbar === true && (params.showBeams !== false && params.showRebar !== false)) {
            const rawQty = params.beamQuantity || 'plasticStrain';
            const qty = canonicalizeQuantity(rawQty);
            const beamIsLocked = (params.lock_quantity_ranges !== false) && (params.beam_lock_quantity_range !== false);
            const colormap = (beamIsLocked ? (params.quantity_colormaps?.[qty] || params.quantity_colormaps?.[rawQty]) : undefined) || params.beamColormap || 'rainbow';
            const autoScale = (beamIsLocked ? (params.quantity_auto_scales?.[qty] ?? params.quantity_auto_scales?.[rawQty]) : undefined) ?? (params.beamAutoScale !== false);
            const logScale = (beamIsLocked ? (params.quantity_log_scales?.[qty] ?? params.quantity_log_scales?.[rawQty]) : undefined) ?? (params.beamLogScale === true);
            const defaultRange = this.latestQuantityRanges?.[qty] || this.latestQuantityRanges?.[rawQty] || params.quantity_ranges?.[qty] || params.quantity_ranges?.[rawQty] || DEFAULT_QUANTITY_RANGES[qty] || [0.0, (qty === 'plastic_strain' ? 0.05 : (qty === 'momentOrForce' ? 1000.0 : 500000000.0))];
            let minVal = params.beamMinVal ?? defaultRange[0];
            let maxVal = params.beamMaxVal ?? defaultRange[1];
            if (beamIsLocked) {
                minVal = defaultRange[0];
                maxVal = defaultRange[1];
            } else if (autoScale && (this.latestBeamRange || this.latestEmpiricalRange)) {
                const r = this.latestBeamRange || this.latestEmpiricalRange!;
                minVal = r.min;
                maxVal = r.max;
            }
            specs.push({
                id: 'beam',
                title: formatCbTitle('Beams (1D)', qty),
                quantity: qty,
                colormap: colormap,
                autoScale: autoScale,
                logScale: logScale,
                isLocked: beamIsLocked,
                minVal: minVal,
                maxVal: maxVal,
                onToggleOff: () => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { beamShowColorbar: false });
                    this.syncControls(false);
                },
                onToggleAuto: () => {
                    if (beamIsLocked) {
                        this.setQuantityAutoScale(qty, !autoScale);
                    } else {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { beamAutoScale: !autoScale });
                        this.worker.postMessage({ type: 'setConfig', data: { beamAutoScale: !autoScale } });
                        this.syncControls(false);
                    }
                },
                onToggleLog: () => {
                    if (beamIsLocked) {
                        this.setQuantityLogScale(qty, !logScale);
                    } else {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { beamLogScale: !logScale });
                        this.worker.postMessage({ type: 'setConfig', data: { beamLogScale: !logScale } });
                        this.syncControls(false);
                    }
                },
                onToggleLock: () => {
                    const newLock = !beamIsLocked;
                    if (newLock) {
                        this.setQuantityColormap(qty, colormap);
                        this.setQuantityLogScale(qty, logScale);
                        this.setQuantityAutoScale(qty, autoScale);
                        this.setQuantityRange(qty, minVal, maxVal, autoScale, logScale);
                    }
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { beam_lock_quantity_range: newLock });
                    this.worker.postMessage({ type: 'setConfig', data: { beamLockQuantityRange: newLock } });
                    this.syncControls(false);
                },
                onSelectColormap: (anchorEl: HTMLElement) => {
                    this.showColormapPopover(anchorEl, colormap, (newCmap) => {
                        if (beamIsLocked) {
                            this.setQuantityColormap(qty, newCmap);
                        } else {
                            this.stateManager.updateNodeParametersInPlace(vpNode.id, { beamColormap: newCmap });
                            this.worker.postMessage({ type: 'setConfig', data: { beamColormap: newCmap } });
                            this.syncControls(false);
                        }
                    });
                },
                onSetMinMax: (minN: number, maxN: number) => {
                    if (beamIsLocked) {
                        this.setQuantityRange(qty, minN, maxN, false);
                    } else {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { beamAutoScale: false, beamMinVal: minN, beamMaxVal: maxN });
                        this.worker.postMessage({ type: 'setConfig', data: { beamAutoScale: false, beamMinVal: minN, beamMaxVal: maxN } });
                        this.syncControls(false);
                    }
                },
                onSelectQuantity: (anchorEl: HTMLElement) => {
                    this.showQuantityPopover(anchorEl, qty, 'fem', (newQ) => {
                        const cNewQ = canonicalizeQuantity(newQ);
                        const qCmaps = params.quantity_colormaps || {};
                        const newCmap = beamIsLocked ? (qCmaps[cNewQ] || qCmaps[newQ] || 'rainbow') : colormap;
                        const qRanges = this.latestQuantityRanges || params.quantity_ranges || {};
                        const newRange = beamIsLocked ? (qRanges[cNewQ] || qRanges[newQ] || DEFAULT_QUANTITY_RANGES[cNewQ] || [0.0, (cNewQ === 'plastic_strain' ? 0.05 : 1000.0)]) : [minVal, maxVal];
                        const qLogs = params.quantity_log_scales || {};
                        const newLog = beamIsLocked ? (qLogs[cNewQ] ?? qLogs[newQ] ?? (cNewQ === 'plastic_strain' || cNewQ === 'energy')) : logScale;
                        const qAutos = params.quantity_auto_scales || {};
                        const newAuto = beamIsLocked ? (qAutos[cNewQ] ?? qAutos[newQ] ?? true) : autoScale;
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, {
                            beamQuantity: cNewQ,
                            beamColormap: newCmap,
                            beamMinVal: newRange[0],
                            beamMaxVal: newRange[1],
                            beamLogScale: newLog,
                            beamAutoScale: newAuto
                        });
                        this.worker.postMessage({
                            type: 'setConfig',
                            data: {
                                beamQuantity: cNewQ,
                                beamColormap: newCmap,
                                beamMinVal: newRange[0],
                                beamMaxVal: newRange[1],
                                beamLogScale: newLog,
                                beamAutoScale: newAuto
                            }
                        });
                        this.syncControls(false);
                    });
                }
            });
        }

        if (specs.length === 0) {
            this.colorbarContainer.style.display = 'none';
            this.colorbarContainer.innerHTML = '';
            return;
        }

        this.colorbarContainer.style.display = 'flex';
        const activeCardIds = new Set<string>();
        specs.forEach(spec => {
            const cardId = this.getElId(`viewport-colorbar-card-${spec.id}`);
            activeCardIds.add(cardId);
            const existingCard = document.getElementById(cardId);
            if (existingCard && this.colorbarContainer!.contains(existingCard)) {
                this.updateColorbarCard(existingCard, spec);
            } else {
                this.colorbarContainer!.appendChild(this.createColorbarCard(spec));
            }
        });

        const childCards = Array.from(this.colorbarContainer.children) as HTMLElement[];
        childCards.forEach(c => {
            if (!activeCardIds.has(c.id)) {
                c.remove();
            }
        });
    }

    private getAutoParticleDiameter(): number {
        if (this.latestEmpiricalSpacing > 0) {
            return this.latestEmpiricalSpacing * 0.8;
        }
        const state = this.stateManager.getCurrentState();
        if (state) {
            const mpmMesh = state.nodes.find(n => n.type === 'DomainMesh3D' || n.type === 'MPMDomain3D' || n.type === 'DomainMesh' || n.type === 'CFDSolver3D');
            const xmin = Number(mpmMesh?.parameters['xmin'] ?? mpmMesh?.parameters['x_min'] ?? 0);
            const xmax = Number(mpmMesh?.parameters['xmax'] ?? mpmMesh?.parameters['x_max'] ?? 1);
            const nx = Number(mpmMesh?.parameters['nx'] ?? 0);
            let cellSize = 0.001;
            if (nx > 0 && xmax > xmin) {
                cellSize = (xmax - xmin) / nx;
            } else {
                cellSize = Number(mpmMesh?.parameters['cell_size'] ?? mpmMesh?.parameters['dx'] ?? 0.001);
            }
            const objPpc = state.nodes.find(n => n.type === 'MPMObject3D')?.parameters['ppc'];
            const domainPpc = Number(objPpc ?? mpmMesh?.parameters['ppc'] ?? 8);
            const pPerDim = Math.max(1, Math.round(Math.cbrt(domainPpc)));
            return (cellSize / pPerDim) * 0.8;
        }
        return 0.0005;
    }

    private buildMPMParticlesTableRow(parent: HTMLElement) {
        const vpNode = this.getViewportNode();
        const initShow = vpNode ? (vpNode.parameters.showMPMParticles !== false) : true;
        const autoDiam = this.getAutoParticleDiameter();
        const initDiam = Number(vpNode?.parameters.mpmParticleDiameter && vpNode.parameters.mpmParticleDiameter > 0 ? vpNode.parameters.mpmParticleDiameter : autoDiam);
        const initSize = vpNode ? (vpNode.parameters.mpmParticleSize ?? 4.0) : 4.0;
        const initQty = vpNode ? (vpNode.parameters.mpmParticleQuantity || 'vonMises') : 'vonMises';
        const initCmap = vpNode ? (vpNode.parameters.mpmParticleColormap || 'rainbow') : 'rainbow';

        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

        // Col 1: Vis Checkbox
        const tdVis = document.createElement('td');
        tdVis.style.padding = '3px 2px';
        tdVis.style.textAlign = 'center';
        const showCb = document.createElement('input');
        showCb.type = 'checkbox';
        showCb.id = this.getElId('viewport-mpm-particles-cb');
        showCb.checked = initShow;
        showCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { showMPMParticles: showCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { showMPMParticles: showCb.checked } });
            }
        };
        this.bindEditingEvents(showCb);
        tdVis.appendChild(showCb);
        tr.appendChild(tdVis);

        // Col 2: Layer Title
        const tdLayer = document.createElement('td');
        tdLayer.style.padding = '3px 4px';
        const state = this.stateManager.getCurrentState();
        let particleCountText = '';
        if (state) {
            let totalEst = 0;
            let objCount = 0;
            const mpmMesh = state.nodes.find(n => n.type === 'DomainMesh3D' || n.type === 'MPMDomain3D');
            const cellSize = Number(mpmMesh?.parameters['cell_size'] ?? 0.01);
            const domainPpc = Number(mpmMesh?.parameters['ppc'] ?? 8);
            const mpmObjects = state.nodes.filter(n => n.type === 'MPMObject3D' || n.type === 'MPMObject2D');
            for (const objNode of mpmObjects) {
                objCount++;
                const st = String(objNode.parameters['shape_type'] || 'Box');
                const ppc = Number(objNode.parameters['ppc'] ?? domainPpc);
                const pPerDim = Math.max(1, Math.round(Math.cbrt(ppc)));
                const pVol = Math.pow(cellSize / pPerDim, 3);
                let vol = 0.008;
                if (st === 'Box') vol = Number(objNode.parameters['size_x'] ?? 0.2) * Number(objNode.parameters['size_y'] ?? 0.2) * Number(objNode.parameters['size_z'] ?? 0.2);
                else if (st === 'Sphere') vol = (4/3) * Math.PI * Math.pow(Number(objNode.parameters['radius'] ?? 0.1), 3);
                else if (st === 'Cylinder') vol = Math.PI * Math.pow(Number(objNode.parameters['radius'] ?? 0.1), 2) * Number(objNode.parameters['height'] ?? 0.2);
                else if (st === 'STL') vol = 0.001 * Number(objNode.parameters['scale_x'] ?? 1) * Number(objNode.parameters['scale_y'] ?? 1) * Number(objNode.parameters['scale_z'] ?? 1);
                totalEst += Math.max(1, Math.round(vol / pVol));
            }
            if (objCount > 0) {
                const vramMB = (totalEst * 292) / (1024 * 1024);
                particleCountText = `<span style="font-size: 8px; color: #4ec9b0; font-weight: normal; margin-left: 4px;">(${totalEst.toLocaleString()} pts | ${vramMB.toFixed(1)}MB VRAM)</span>`;
            }
        }
        tdLayer.innerHTML = `🔮 <b>MPM Particles</b>${particleCountText}`;
        tr.appendChild(tdLayer);

        // Col 3, 4: Empty SOL / LINES
        for (let i = 0; i < 2; i++) {
            const tdEmpty = document.createElement('td');
            tdEmpty.innerHTML = '<span style="color:#555;">—</span>';
            tdEmpty.style.textAlign = 'center';
            tr.appendChild(tdEmpty);
        }

        // Col 5: RES (Point Size / Physical Diameter Popover Pill)
        const tdSize = document.createElement('td');
        tdSize.style.padding = '3px 2px';
        const sizePill = document.createElement('button');
        sizePill.id = this.getElId('viewport-mpm-size-btn');
        if (initDiam > 0) {
            sizePill.textContent = `Ø ${formatSIDiameter(initDiam)} ▾`;
        } else {
            sizePill.textContent = `Pt ${initSize}px ▾`;
        }
        this.applyButtonStyle(sizePill);
        sizePill.style.fontSize = '8.5px';
        sizePill.style.width = '100%';
        sizePill.style.padding = '2px 0';
        sizePill.onclick = (e) => {
            e.stopPropagation();
            this.showPopover(sizePill, (popover) => {
                popover.style.minWidth = '200px';
                popover.style.padding = '6px 8px';

                const autoD = this.getAutoParticleDiameter();
                const autoStr = formatSIDiameter(autoD);

                const autoBtn = document.createElement('button');
                autoBtn.innerHTML = `⚡ <b>Default (Mesh Spacing)</b>: Ø ${autoStr}`;
                this.applyButtonStyle(autoBtn);
                autoBtn.style.width = '100%';
                autoBtn.style.padding = '4px 6px';
                autoBtn.style.marginBottom = '6px';
                autoBtn.style.fontSize = '9px';
                autoBtn.style.textAlign = 'left';
                autoBtn.style.background = 'rgba(0, 173, 255, 0.15)';
                autoBtn.style.border = '1px solid rgba(0, 173, 255, 0.4)';
                autoBtn.style.color = '#00adff';
                autoBtn.title = 'Set diameter to non-overlapping spacing from initial meshing (Δx / ∛ppc)';
                autoBtn.onclick = (ev) => {
                    ev.stopPropagation();
                    const vp = this.getViewportNode();
                    if (vp) {
                        this.stateManager.updateNodeParametersInPlace(vp.id, { mpmParticleDiameter: autoD });
                        this.worker.postMessage({ type: 'setConfig', data: { mpmParticleDiameter: autoD } });
                        sizePill.textContent = `Ø ${autoStr} ▾`;
                        this.closePopover();
                    }
                };
                popover.appendChild(autoBtn);

                const hdrDiam = document.createElement('div');
                hdrDiam.textContent = 'PHYSICAL DIAMETER (SI: METERS)';
                hdrDiam.style.fontSize = '8px';
                hdrDiam.style.fontWeight = 'bold';
                hdrDiam.style.color = '#888';
                hdrDiam.style.margin = '4px 0 3px 0';
                popover.appendChild(hdrDiam);

                const diamGrid = document.createElement('div');
                diamGrid.style.display = 'grid';
                diamGrid.style.gridTemplateColumns = 'repeat(3, 1fr)';
                diamGrid.style.gap = '3px';
                diamGrid.style.marginBottom = '6px';

                [0.0005, 0.001, 0.002, 0.0025, 0.005, 0.008, 0.010, 0.015, 0.020, 0.030, 0.050].forEach(dVal => {
                    const item = document.createElement('div');
                    const dStr = formatSIDiameter(dVal);
                    item.textContent = dStr;
                    item.style.padding = '3px 2px';
                    item.style.fontSize = '8.5px';
                    item.style.textAlign = 'center';
                    item.style.cursor = 'pointer';
                    item.style.borderRadius = '3px';
                    item.style.background = '#252526';
                    item.style.border = '1px solid #3c3c3c';
                    item.onmouseenter = () => item.style.background = '#094771';
                    item.onmouseleave = () => item.style.background = '#252526';
                    item.onclick = (ev) => {
                        ev.stopPropagation();
                        const vp = this.getViewportNode();
                        if (vp) {
                            this.stateManager.updateNodeParametersInPlace(vp.id, { mpmParticleDiameter: dVal });
                            this.worker.postMessage({ type: 'setConfig', data: { mpmParticleDiameter: dVal } });
                            sizePill.textContent = `Ø ${dStr} ▾`;
                            this.closePopover();
                        }
                    };
                    diamGrid.appendChild(item);
                });
                popover.appendChild(diamGrid);

                // Float SI meter input + Default button row
                const customRow = document.createElement('div');
                customRow.style.display = 'flex';
                customRow.style.gap = '4px';
                customRow.style.alignItems = 'center';
                customRow.style.marginBottom = '6px';
                const customInput = document.createElement('input');
                customInput.type = 'number';
                customInput.step = '0.0001';
                customInput.min = '0.00001';
                customInput.value = String(initDiam);
                customInput.placeholder = 'Diameter in meters (m)';
                customInput.style.flex = '1';
                customInput.style.background = '#111';
                customInput.style.color = '#fff';
                customInput.style.border = '1px solid #444';
                customInput.style.borderRadius = '3px';
                customInput.style.padding = '2px 4px';
                customInput.style.fontSize = '9px';

                const applyBtn = document.createElement('button');
                applyBtn.textContent = 'Set (m)';
                this.applyButtonStyle(applyBtn);
                applyBtn.style.padding = '2px 6px';
                applyBtn.style.fontSize = '8.5px';

                const defaultSmallBtn = document.createElement('button');
                defaultSmallBtn.textContent = 'Default';
                this.applyButtonStyle(defaultSmallBtn);
                defaultSmallBtn.style.padding = '2px 6px';
                defaultSmallBtn.style.fontSize = '8.5px';
                defaultSmallBtn.style.color = '#00adff';
                defaultSmallBtn.style.fontWeight = 'bold';
                defaultSmallBtn.title = 'Set diameter to non-overlapping spacing based on initial meshing (Δx / ∛ppc)';

                const applyCustom = (ev: Event) => {
                    ev.stopPropagation();
                    const dM = parseFloat(customInput.value);
                    if (isFinite(dM) && dM > 0) {
                        const vp = this.getViewportNode();
                        if (vp) {
                            this.stateManager.updateNodeParametersInPlace(vp.id, { mpmParticleDiameter: dM });
                            this.worker.postMessage({ type: 'setConfig', data: { mpmParticleDiameter: dM } });
                            const dStr = formatSIDiameter(dM);
                            sizePill.textContent = `Ø ${dStr} ▾`;
                            this.closePopover();
                        }
                    }
                };
                applyBtn.onclick = applyCustom;
                customInput.onkeydown = (ev) => {
                    if (ev.key === 'Enter') applyCustom(ev);
                };

                defaultSmallBtn.onclick = (ev) => {
                    ev.stopPropagation();
                    const vp = this.getViewportNode();
                    if (vp) {
                        this.stateManager.updateNodeParametersInPlace(vp.id, { mpmParticleDiameter: autoD });
                        this.worker.postMessage({ type: 'setConfig', data: { mpmParticleDiameter: autoD } });
                        sizePill.textContent = `Ø ${autoStr} ▾`;
                        this.closePopover();
                    }
                };

                customRow.appendChild(customInput);
                customRow.appendChild(applyBtn);
                customRow.appendChild(defaultSmallBtn);
                popover.appendChild(customRow);

                const hdrPx = document.createElement('div');
                hdrPx.textContent = 'FIXED SCREEN PIXELS (POINT CLOUD)';
                hdrPx.style.fontSize = '8px';
                hdrPx.style.fontWeight = 'bold';
                hdrPx.style.color = '#888';
                hdrPx.style.margin = '4px 0 3px 0';
                hdrPx.style.borderTop = '1px solid rgba(255,255,255,0.1)';
                hdrPx.style.paddingTop = '4px';
                popover.appendChild(hdrPx);

                const pxGrid = document.createElement('div');
                pxGrid.style.display = 'grid';
                pxGrid.style.gridTemplateColumns = 'repeat(4, 1fr)';
                pxGrid.style.gap = '3px';
                [2, 3, 4, 6, 8, 10, 16].forEach(sz => {
                    const item = document.createElement('div');
                    item.textContent = `${sz}px`;
                    item.style.padding = '3px 2px';
                    item.style.fontSize = '8.5px';
                    item.style.textAlign = 'center';
                    item.style.cursor = 'pointer';
                    item.style.borderRadius = '3px';
                    item.style.background = '#252526';
                    item.style.border = '1px solid #3c3c3c';
                    item.onmouseenter = () => item.style.background = '#094771';
                    item.onmouseleave = () => item.style.background = '#252526';
                    item.onclick = (ev) => {
                        ev.stopPropagation();
                        const vp = this.getViewportNode();
                        if (vp) {
                            this.stateManager.updateNodeParametersInPlace(vp.id, { mpmParticleDiameter: 0, mpmParticleSize: sz });
                            this.worker.postMessage({ type: 'setConfig', data: { mpmParticleDiameter: 0, mpmParticleSize: sz } });
                            sizePill.textContent = `Pt ${sz}px ▾`;
                            this.closePopover();
                        }
                    };
                    pxGrid.appendChild(item);
                });
                popover.appendChild(pxGrid);
            });
        };
        tdSize.appendChild(sizePill);
        tr.appendChild(tdSize);

        // Col 6: QTY (Quantity Selector Pill)
        const tdQty = document.createElement('td');
        tdQty.style.padding = '3px 4px';
        const qtyPill = document.createElement('div');
        qtyPill.id = this.getElId('viewport-mpm-qty-pill');
        qtyPill.style.fontSize = '9px';
        qtyPill.style.padding = '2px 4px';
        qtyPill.style.borderRadius = '3px';
        qtyPill.style.cursor = 'pointer';
        qtyPill.style.background = 'rgba(0, 173, 255, 0.12)';
        qtyPill.style.border = '1px solid rgba(0, 173, 255, 0.3)';
        qtyPill.style.color = '#00adff';
        qtyPill.style.fontWeight = '500';
        qtyPill.textContent = initQty;
        qtyPill.onclick = (e) => {
            e.stopPropagation();
            this.showQuantityPopover(qtyPill, initQty, 'mpm', (newQ) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { mpmParticleQuantity: newQ, mpmParticleAutoScale: true });
                    this.worker.postMessage({ type: 'setConfig', data: { mpmParticleQuantity: newQ, mpmParticleAutoScale: true } });
                    qtyPill.textContent = newQ;
                }
            });
        };
        tdQty.appendChild(qtyPill);
        tr.appendChild(tdQty);

        // Col 7: COLOR (Colormap Selector Pill + Colorbar Toggle)
        const tdCmap = document.createElement('td');
        tdCmap.style.padding = '3px 4px';
        const cmapWrap = document.createElement('div');
        cmapWrap.style.display = 'flex';
        cmapWrap.style.gap = '3px';
        cmapWrap.style.alignItems = 'center';

        const cmapPill = document.createElement('div');
        cmapPill.id = this.getElId('viewport-mpm-cmap-pill');
        cmapPill.style.fontSize = '9px';
        cmapPill.style.padding = '2px 4px';
        cmapPill.style.borderRadius = '3px';
        cmapPill.style.cursor = 'pointer';
        cmapPill.style.background = 'rgba(255, 255, 255, 0.08)';
        cmapPill.style.border = '1px solid rgba(255, 255, 255, 0.15)';
        cmapPill.style.color = '#e0e0e0';
        cmapPill.style.flex = '1';
        cmapPill.textContent = initCmap;
        cmapPill.onclick = (e) => {
            e.stopPropagation();
            this.showColormapPopover(cmapPill, initCmap, (newC) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { mpmParticleColormap: newC });
                    this.worker.postMessage({ type: 'setConfig', data: { mpmParticleColormap: newC } });
                    cmapPill.textContent = newC;
                    this.syncControls(true);
                }
            });
        };
        cmapWrap.appendChild(cmapPill);

        const initCbShow = vpNode ? (vpNode.parameters.mpmParticleShowColorbar === true) : false;
        const cbToggleBtn = this.createToggleBtn('viewport-mpm-cb-btn', '🎨', initCbShow, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { mpmParticleShowColorbar: v });
                this.syncControls(true);
            }
        });
        cbToggleBtn.style.width = '20px';
        cbToggleBtn.title = 'Toggle Color Bar for MPM Particles in 3D Viewport';
        cmapWrap.appendChild(cbToggleBtn);

        tdCmap.appendChild(cmapWrap);
        tr.appendChild(tdCmap);

        // Col 8: SCL / Range Limit
        const tdScl = document.createElement('td');
        tdScl.style.padding = '3px 2px';
        tdScl.style.textAlign = 'center';
        
        const sclWrap = document.createElement('div');
        sclWrap.style.display = 'inline-flex';
        sclWrap.style.gap = '2px';
        sclWrap.style.justifyContent = 'center';
        tdScl.appendChild(sclWrap);

        const initAuto = vpNode ? (vpNode.parameters.mpmParticleAutoScale !== false) : true;
        const initLog = vpNode ? (vpNode.parameters.mpmParticleLogScale === true) : false;

        sclWrap.appendChild(this.createToggleBtn('viewport-mpm-auto-btn', 'A', initAuto, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { mpmParticleAutoScale: v });
                this.worker.postMessage({ type: 'setConfig', data: { mpmParticleAutoScale: v } });
                this.syncControls(true);
            }
        }));

        sclWrap.appendChild(this.createToggleBtn('viewport-mpm-log-btn', 'L', initLog, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { mpmParticleLogScale: v });
                this.worker.postMessage({ type: 'setConfig', data: { mpmParticleLogScale: v } });
                this.syncControls(true);
            }
        }));

        const rangeBtn = this.createToggleBtn('viewport-mpm-cfg-btn', '⚙️', false, () => {
            this.showPopover(rangeBtn, (popover) => {
                const vp = this.getViewportNode();
                const minV = vp?.parameters.mpmParticleMinVal ?? 0.0;
                const maxV = vp?.parameters.mpmParticleMaxVal ?? 500e6;

                popover.innerHTML = `
                    <div style="font-weight:bold; color:#00adff; margin-bottom:6px;">MPM Particle Range</div>
                    <div style="display:flex; flex-direction:column; gap:4px;">
                        <label style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
                            <span>Min:</span>
                            <input type="number" step="any" id="popover-mpm-min" value="${minV}" style="width:70px; background:#111; color:#fff; border:1px solid #444; border-radius:3px; padding:2px;">
                        </label>
                        <label style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
                            <span>Max:</span>
                            <input type="number" step="any" id="popover-mpm-max" value="${maxV}" style="width:70px; background:#111; color:#fff; border:1px solid #444; border-radius:3px; padding:2px;">
                        </label>
                        <button id="popover-apply-mpm-range" style="margin-top:4px; background:#007acc; color:#fff; border:none; border-radius:3px; padding:3px; cursor:pointer;">Apply Range</button>
                    </div>
                `;
                const applyBtn = popover.querySelector('#popover-apply-mpm-range') as HTMLButtonElement;
                if (applyBtn) {
                    applyBtn.onclick = () => {
                        const minInp = popover.querySelector('#popover-mpm-min') as HTMLInputElement;
                        const maxInp = popover.querySelector('#popover-mpm-max') as HTMLInputElement;
                        if (minInp && maxInp && vp) {
                            const minN = Number(minInp.value);
                            const maxN = Number(maxInp.value);
                            this.stateManager.updateNodeParametersInPlace(vp.id, {
                                mpmParticleAutoScale: false,
                                mpmParticleMinVal: minN,
                                mpmParticleMaxVal: maxN
                            });
                            this.worker.postMessage({
                                type: 'setConfig',
                                data: {
                                    mpmParticleAutoScale: false,
                                    mpmParticleMinVal: minN,
                                    mpmParticleMaxVal: maxN
                                }
                            });
                            this.syncControls(true);
                            this.closePopover();
                        }
                    };
                }
            });
        });
        sclWrap.appendChild(rangeBtn);
        tdScl.appendChild(sclWrap);
        tr.appendChild(tdScl);

        // Col 9: OPACITY (Opacity Popover)
        const tdOpac = document.createElement('td');
        tdOpac.style.padding = '3px 4px';
        const initOpacity = vpNode ? (vpNode.parameters.mpmParticleOpacity ?? 1.0) : 1.0;
        const opacPill = document.createElement('button');
        opacPill.id = this.getElId('viewport-mpm-opac-pill');
        opacPill.textContent = `${Math.round(initOpacity * 100)}% ▾`;
        this.applyButtonStyle(opacPill);
        opacPill.style.fontSize = '8.5px';
        opacPill.style.width = '100%';
        opacPill.style.padding = '2px 0';
        opacPill.onclick = (e) => {
            e.stopPropagation();
            const curVal = this.getViewportNode()?.parameters.mpmParticleOpacity ?? 1.0;
            this.showOpacityPopover(opacPill, curVal, (newOpac) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { mpmParticleOpacity: newOpac });
                    this.worker.postMessage({ type: 'setConfig', data: { mpmParticleOpacity: newOpac } });
                    opacPill.textContent = `${Math.round(newOpac * 100)}% ▾`;
                }
            });
        };
        tdOpac.appendChild(opacPill);
        tr.appendChild(tdOpac);

        // Col 10: Empty Delete Cell
        const tdDel = document.createElement('td');
        tdDel.innerHTML = '<span style="color:#444;">—</span>';
        tdDel.style.textAlign = 'center';
        tr.appendChild(tdDel);

        parent.appendChild(tr);
    }

    private buildFEMMeshTableRow(parent: HTMLElement) {
        const vpNode = this.getViewportNode();
        const initShow = vpNode ? (vpNode.parameters.showFEMMesh !== false) : true;
        const initSol = vpNode ? (vpNode.parameters.femSolid !== false) : true;
        const initWir = vpNode ? (vpNode.parameters.femWireframe !== false) : true;
        const initRes = vpNode ? (vpNode.parameters.femResults !== false) : true;
        const initQty = vpNode ? (vpNode.parameters.femQuantity || 'vonMises') : 'vonMises';
        const initCmap = vpNode ? (vpNode.parameters.femColormap || 'rainbow') : 'rainbow';
        const initOpac = vpNode ? (vpNode.parameters.femOpacity ?? 1.0) : 1.0;

        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

        // Col 1: Vis Checkbox
        const tdVis = document.createElement('td');
        tdVis.style.padding = '3px 2px';
        tdVis.style.textAlign = 'center';
        const showCb = document.createElement('input');
        showCb.type = 'checkbox';
        showCb.id = this.getElId('viewport-fem-mesh-cb');
        showCb.checked = initShow;
        showCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { showFEMMesh: showCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { showFEMMesh: showCb.checked } });
            }
        };
        this.bindEditingEvents(showCb);
        tdVis.appendChild(showCb);
        tr.appendChild(tdVis);

        // Col 2: Layer Title
        const tdLayer = document.createElement('td');
        tdLayer.style.padding = '3px 4px';
        const state = this.stateManager.getCurrentState();
        let femCountText = '';
        if (state) {
            const femNodes = state.nodes.filter(n => n.type === 'FEMDomain3D' || n.type === 'FEMObject3D' || n.type === 'LSDynaImporter3D');
            if (femNodes.length > 0) {
                femCountText = `<span style="font-size: 8px; color: #00ff66; font-weight: normal; margin-left: 4px;">(Hex Mesh)</span>`;
            }
        }
        tdLayer.innerHTML = `🏗️ <b>FEM Mesh</b>${femCountText}`;
        tr.appendChild(tdLayer);

        // Col 3: SOL (Solid Toggle Button)
        const tdSol = document.createElement('td');
        tdSol.style.padding = '3px 2px';
        tdSol.style.textAlign = 'center';
        const solBtn = this.createToggleBtn('viewport-fem-sol-btn', 'Sol', initSol, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { femSolid: v });
                this.worker.postMessage({ type: 'setConfig', data: { femSolid: v } });
                this.syncControls(true);
            }
        });
        tdSol.appendChild(solBtn);
        tr.appendChild(tdSol);

        // Col 4: LINES (Wireframe Toggle Button)
        const tdWir = document.createElement('td');
        tdWir.style.padding = '3px 2px';
        tdWir.style.textAlign = 'center';
        const wirBtn = this.createToggleBtn('viewport-fem-wir-btn', 'Wir', initWir, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { femWireframe: v });
                this.worker.postMessage({ type: 'setConfig', data: { femWireframe: v } });
                this.syncControls(true);
            }
        });
        tdWir.appendChild(wirBtn);
        tr.appendChild(tdWir);

        // Col 5: RES (Results Toggle Button)
        const tdRes = document.createElement('td');
        tdRes.style.padding = '3px 2px';
        tdRes.style.textAlign = 'center';
        const resBtn = this.createToggleBtn('viewport-fem-res-btn', 'Res', initRes, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { femResults: v });
                this.worker.postMessage({ type: 'setConfig', data: { femResults: v } });
                this.syncControls(true);
            }
        });
        tdRes.appendChild(resBtn);
        tr.appendChild(tdRes);

        // Col 6: QTY (Quantity Selector Pill)
        const tdQty = document.createElement('td');
        tdQty.style.padding = '3px 4px';
        const qtyPill = document.createElement('div');
        qtyPill.id = this.getElId('viewport-fem-qty-pill');
        qtyPill.style.fontSize = '9px';
        qtyPill.style.padding = '2px 4px';
        qtyPill.style.borderRadius = '3px';
        qtyPill.style.cursor = 'pointer';
        qtyPill.style.background = 'rgba(0, 255, 102, 0.12)';
        qtyPill.style.border = '1px solid rgba(0, 255, 102, 0.3)';
        qtyPill.style.color = '#00ff66';
        qtyPill.style.fontWeight = '500';
        qtyPill.textContent = initQty;
        qtyPill.onclick = (e) => {
            e.stopPropagation();
            this.showQuantityPopover(qtyPill, initQty, 'fem', (newQ) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { femQuantity: newQ, femAutoScale: true });
                    this.worker.postMessage({ type: 'setConfig', data: { femQuantity: newQ, femAutoScale: true } });
                    qtyPill.textContent = newQ;
                }
            });
        };
        tdQty.appendChild(qtyPill);
        tr.appendChild(tdQty);

        // Col 7: COLOR (Colormap Selector Pill + Colorbar Toggle)
        const tdCmap = document.createElement('td');
        tdCmap.style.padding = '3px 4px';
        const cmapWrap = document.createElement('div');
        cmapWrap.style.display = 'flex';
        cmapWrap.style.gap = '3px';
        cmapWrap.style.alignItems = 'center';

        const cmapPill = document.createElement('div');
        cmapPill.id = this.getElId('viewport-fem-cmap-pill');
        cmapPill.style.fontSize = '9px';
        cmapPill.style.padding = '2px 4px';
        cmapPill.style.borderRadius = '3px';
        cmapPill.style.cursor = 'pointer';
        cmapPill.style.background = 'rgba(255, 255, 255, 0.08)';
        cmapPill.style.border = '1px solid rgba(255, 255, 255, 0.15)';
        cmapPill.style.color = '#e0e0e0';
        cmapPill.style.flex = '1';
        cmapPill.textContent = initCmap;
        cmapPill.onclick = (e) => {
            e.stopPropagation();
            this.showColormapPopover(cmapPill, initCmap, (newC) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { femColormap: newC });
                    this.worker.postMessage({ type: 'setConfig', data: { femColormap: newC } });
                    cmapPill.textContent = newC;
                    this.syncControls(true);
                }
            });
        };
        cmapWrap.appendChild(cmapPill);

        const initCbShow = vpNode ? (vpNode.parameters.femShowColorbar === true) : false;
        const cbToggleBtn = this.createToggleBtn('viewport-fem-cb-btn', '🎨', initCbShow, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { femShowColorbar: v });
                this.syncControls(true);
            }
        });
        cbToggleBtn.style.width = '20px';
        cbToggleBtn.title = 'Toggle Color Bar for FEM Mesh in 3D Viewport';
        cmapWrap.appendChild(cbToggleBtn);

        tdCmap.appendChild(cmapWrap);
        tr.appendChild(tdCmap);

        // Col 8: SCL / Range Limits
        const tdScl = document.createElement('td');
        tdScl.style.padding = '3px 2px';
        tdScl.style.textAlign = 'center';

        const sclWrap = document.createElement('div');
        sclWrap.style.display = 'inline-flex';
        sclWrap.style.gap = '2px';
        sclWrap.style.justifyContent = 'center';
        tdScl.appendChild(sclWrap);

        const initAuto = vpNode ? (vpNode.parameters.femAutoScale !== false) : true;
        const initLog = vpNode ? (vpNode.parameters.femLogScale === true) : false;

        sclWrap.appendChild(this.createToggleBtn('viewport-fem-auto-btn', 'A', initAuto, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { femAutoScale: v });
                this.worker.postMessage({ type: 'setConfig', data: { femAutoScale: v } });
                this.syncControls(true);
            }
        }));

        sclWrap.appendChild(this.createToggleBtn('viewport-fem-log-btn', 'L', initLog, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { femLogScale: v });
                this.worker.postMessage({ type: 'setConfig', data: { femLogScale: v } });
                this.syncControls(true);
            }
        }));

        const rangeBtn = this.createToggleBtn('viewport-fem-cfg-btn', '⚙️', false, () => {
            this.showPopover(rangeBtn, (popover) => {
                const vp = this.getViewportNode();
                const minV = vp?.parameters.femMinVal ?? 0.0;
                const maxV = vp?.parameters.femMaxVal ?? 500e6;

                popover.innerHTML = `
                    <div style="font-weight:bold; color:#00ff66; margin-bottom:6px;">FEM Mesh Range</div>
                    <div style="display:flex; flex-direction:column; gap:4px;">
                        <label style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
                            <span>Min:</span>
                            <input type="number" step="any" id="popover-fem-min" value="${minV}" style="width:70px; background:#111; color:#fff; border:1px solid #444; border-radius:3px; padding:2px;">
                        </label>
                        <label style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
                            <span>Max:</span>
                            <input type="number" step="any" id="popover-fem-max" value="${maxV}" style="width:70px; background:#111; color:#fff; border:1px solid #444; border-radius:3px; padding:2px;">
                        </label>
                        <button id="popover-apply-fem-range" style="margin-top:4px; background:#007acc; color:#fff; border:none; border-radius:3px; padding:3px; cursor:pointer;">Apply Range</button>
                    </div>
                `;
                const applyBtn = popover.querySelector('#popover-apply-fem-range') as HTMLButtonElement;
                if (applyBtn) {
                    applyBtn.onclick = () => {
                        const minInp = popover.querySelector('#popover-fem-min') as HTMLInputElement;
                        const maxInp = popover.querySelector('#popover-fem-max') as HTMLInputElement;
                        if (minInp && maxInp && vp) {
                            const minN = Number(minInp.value);
                            const maxN = Number(maxInp.value);
                            this.stateManager.updateNodeParametersInPlace(vp.id, {
                                femAutoScale: false,
                                femMinVal: minN,
                                femMaxVal: maxN
                            });
                            this.worker.postMessage({
                                type: 'setConfig',
                                data: {
                                    femAutoScale: false,
                                    femMinVal: minN,
                                    femMaxVal: maxN
                                }
                            });
                            this.closePopover();
                            this.syncControls(true);
                        }
                    };
                }
            });
        });
        sclWrap.appendChild(rangeBtn);
        tr.appendChild(tdScl);

        // Col 9: OPACITY (Opacity Slider)
        const tdOpac = document.createElement('td');
        tdOpac.style.padding = '3px 4px';
        tdOpac.style.textAlign = 'center';
        const opacSel = document.createElement('select');
        opacSel.id = this.getElId('viewport-fem-opac-sel');
        this.applySelectStyle(opacSel);
        opacSel.style.width = '100%';
        opacSel.innerHTML = `
            <option value="1.0">100%</option>
            <option value="0.8">80%</option>
            <option value="0.6">60%</option>
            <option value="0.4">40%</option>
            <option value="0.2">20%</option>
            <option value="0.0">0%</option>
        `;
        this.selectOptionByNumericValue(opacSel, initOpac);
        this.bindEditingEvents(opacSel, () => {
            const vp = this.getViewportNode();
            if (vp) {
                const val = Number(opacSel.value);
                this.stateManager.updateNodeParametersInPlace(vp.id, { femOpacity: val });
                this.worker.postMessage({ type: 'setConfig', data: { femOpacity: val } });
            }
        });
        tdOpac.appendChild(opacSel);
        tr.appendChild(tdOpac);

        // Col 10: Delete / Empty
        const tdDel = document.createElement('td');
        tdDel.style.padding = '3px 2px';
        tdDel.style.textAlign = 'center';
        tdDel.innerHTML = '<span style="color:#555;">—</span>';
        tr.appendChild(tdDel);

        parent.appendChild(tr);
    }

    private buildBeamTableRow(parent: HTMLElement) {
        const vpNode = this.getViewportNode();
        const initShow = vpNode ? (vpNode.parameters.showBeams !== false && vpNode.parameters.showRebar !== false) : true;
        const initSol = vpNode ? (vpNode.parameters.beamSolid !== false && vpNode.parameters.rebarSolid !== false) : true;
        const initWir = vpNode ? (vpNode.parameters.beamWireframe !== false && vpNode.parameters.rebarWireframe !== false) : true;
        const initRes = vpNode ? (vpNode.parameters.femResults !== false) : true;
        const initQty = vpNode ? (vpNode.parameters.beamQuantity || 'plasticStrain') : 'plasticStrain';
        const initCmap = vpNode ? (vpNode.parameters.beamColormap || 'rainbow') : 'rainbow';
        const initRadius = vpNode ? (vpNode.parameters.beamRadius ?? vpNode.parameters.rebarRadius ?? 0.008) : 0.008;

        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

        // Col 1: Vis Checkbox
        const tdVis = document.createElement('td');
        tdVis.style.padding = '3px 2px';
        tdVis.style.textAlign = 'center';
        const showCb = document.createElement('input');
        showCb.type = 'checkbox';
        showCb.id = this.getElId('viewport-beam-mesh-cb');
        showCb.checked = initShow;
        showCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { showBeams: showCb.checked, showRebar: showCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { showBeams: showCb.checked, showRebar: showCb.checked } });
            }
        };
        this.bindEditingEvents(showCb);
        tdVis.appendChild(showCb);
        tr.appendChild(tdVis);

        // Col 2: Layer Title
        const tdLayer = document.createElement('td');
        tdLayer.style.padding = '3px 4px';
        const state = this.stateManager.getCurrentState();
        let beamCountText = '';
        if (state) {
            const femNodes = state.nodes.filter(n => n.type === 'FEMDomain3D' || n.type === 'FEMObject3D' || n.type === 'LSDynaImporter3D');
            if (femNodes.length > 0) {
                beamCountText = `<span style="font-size: 8px; color: #ffaa00; font-weight: normal; margin-left: 4px;">(1D Lines)</span>`;
            }
        }
        tdLayer.innerHTML = `📐 <b>Beams / 1D Elements</b>${beamCountText}`;
        tr.appendChild(tdLayer);

        // Col 3: SOL (Solid 3D Ribbons Toggle Button)
        const tdSol = document.createElement('td');
        tdSol.style.padding = '3px 2px';
        tdSol.style.textAlign = 'center';
        const solBtn = this.createToggleBtn('viewport-beam-sol-btn', 'Sol', initSol, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { beamSolid: v, rebarSolid: v });
                this.worker.postMessage({ type: 'setConfig', data: { beamSolid: v, rebarSolid: v } });
                this.syncControls(true);
            }
        });
        tdSol.appendChild(solBtn);
        tr.appendChild(tdSol);

        // Col 4: LINES (Wireframe Toggle Button)
        const tdWir = document.createElement('td');
        tdWir.style.padding = '3px 2px';
        tdWir.style.textAlign = 'center';
        const wirBtn = this.createToggleBtn('viewport-beam-wir-btn', 'Wir', initWir, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { beamWireframe: v, rebarWireframe: v });
                this.worker.postMessage({ type: 'setConfig', data: { beamWireframe: v, rebarWireframe: v } });
                this.syncControls(true);
            }
        });
        tdWir.appendChild(wirBtn);
        tr.appendChild(tdWir);

        // Col 5: RES (Results Toggle Button)
        const tdRes = document.createElement('td');
        tdRes.style.padding = '3px 2px';
        tdRes.style.textAlign = 'center';
        const resBtn = this.createToggleBtn('viewport-beam-res-btn', 'Res', initRes, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { femResults: v });
                this.worker.postMessage({ type: 'setConfig', data: { femResults: v } });
                this.syncControls(true);
            }
        });
        tdRes.appendChild(resBtn);
        tr.appendChild(tdRes);

        // Col 6: QTY (Quantity Selector Pill)
        const tdQty = document.createElement('td');
        tdQty.style.padding = '3px 4px';
        const qtyPill = document.createElement('div');
        qtyPill.id = this.getElId('viewport-beam-qty-pill');
        qtyPill.style.fontSize = '9px';
        qtyPill.style.padding = '2px 4px';
        qtyPill.style.borderRadius = '3px';
        qtyPill.style.cursor = 'pointer';
        qtyPill.style.background = 'rgba(255, 170, 0, 0.12)';
        qtyPill.style.border = '1px solid rgba(255, 170, 0, 0.3)';
        qtyPill.style.color = '#ffaa00';
        qtyPill.style.fontWeight = '500';
        qtyPill.textContent = initQty;
        qtyPill.onclick = (e) => {
            e.stopPropagation();
            this.showQuantityPopover(qtyPill, initQty, 'beam', (newQ) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { beamQuantity: newQ, beamAutoScale: true });
                    this.worker.postMessage({ type: 'setConfig', data: { beamQuantity: newQ, beamAutoScale: true } });
                    qtyPill.textContent = newQ;
                    this.syncControls(true);
                }
            });
        };
        tdQty.appendChild(qtyPill);
        tr.appendChild(tdQty);

        // Col 7: COLOR (Colormap Selector Pill + Colorbar Toggle)
        const tdCmap = document.createElement('td');
        tdCmap.style.padding = '3px 4px';
        const cmapWrap = document.createElement('div');
        cmapWrap.style.display = 'flex';
        cmapWrap.style.gap = '3px';
        cmapWrap.style.alignItems = 'center';

        const cmapPill = document.createElement('div');
        cmapPill.id = this.getElId('viewport-beam-cmap-pill');
        cmapPill.style.fontSize = '9px';
        cmapPill.style.padding = '2px 4px';
        cmapPill.style.borderRadius = '3px';
        cmapPill.style.cursor = 'pointer';
        cmapPill.style.background = 'rgba(255, 255, 255, 0.08)';
        cmapPill.style.border = '1px solid rgba(255, 255, 255, 0.15)';
        cmapPill.style.color = '#e0e0e0';
        cmapPill.style.flex = '1';
        cmapPill.textContent = initCmap;
        cmapPill.onclick = (e) => {
            e.stopPropagation();
            this.showColormapPopover(cmapPill, initCmap, (newC) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { beamColormap: newC });
                    this.worker.postMessage({ type: 'setConfig', data: { beamColormap: newC } });
                    cmapPill.textContent = newC;
                    this.syncControls(true);
                }
            });
        };
        cmapWrap.appendChild(cmapPill);

        const initCbShow = vpNode ? (vpNode.parameters.beamShowColorbar === true) : false;
        const cbToggleBtn = this.createToggleBtn('viewport-beam-cb-btn', '🎨', initCbShow, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { beamShowColorbar: v });
                this.syncControls(true);
            }
        });
        cbToggleBtn.style.width = '20px';
        cbToggleBtn.title = 'Toggle Color Bar for Beams / 1D Elements in 3D Viewport';
        cmapWrap.appendChild(cbToggleBtn);

        tdCmap.appendChild(cmapWrap);
        tr.appendChild(tdCmap);

        // Col 8: SCL / Auto-Scale
        const tdScl = document.createElement('td');
        tdScl.style.padding = '3px 2px';
        tdScl.style.textAlign = 'center';
        const initAuto = vpNode ? (vpNode.parameters.beamAutoScale !== false) : true;
        const autoBtn = this.createToggleBtn('viewport-beam-auto-btn', 'A', initAuto, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { beamAutoScale: v });
                this.worker.postMessage({ type: 'setConfig', data: { beamAutoScale: v } });
                this.syncControls(true);
            }
        });
        tdScl.appendChild(autoBtn);
        tr.appendChild(tdScl);

        // Col 9: RADIUS / SECTION DIAMETER
        const tdRadius = document.createElement('td');
        tdRadius.style.padding = '3px 4px';
        tdRadius.style.textAlign = 'center';
        const radSel = document.createElement('select');
        radSel.id = this.getElId('viewport-beam-radius-sel');
        this.applySelectStyle(radSel);
        radSel.style.width = '100%';
        radSel.innerHTML = `
            <option value="0.002">Ø4mm</option>
            <option value="0.004">Ø8mm</option>
            <option value="0.006">Ø12mm</option>
            <option value="0.008">Ø16mm</option>
            <option value="0.010">Ø20mm</option>
            <option value="0.012">Ø24mm</option>
            <option value="0.016">Ø32mm</option>
            <option value="0.020">Ø40mm</option>
        `;
        this.selectOptionByNumericValue(radSel, initRadius);
        this.bindEditingEvents(radSel, () => {
            const vp = this.getViewportNode();
            if (vp) {
                const val = Number(radSel.value);
                this.stateManager.updateNodeParametersInPlace(vp.id, { beamRadius: val, rebarRadius: val });
                this.worker.postMessage({ type: 'setConfig', data: { beamRadius: val, rebarRadius: val } });
            }
        });
        tdRadius.appendChild(radSel);
        tr.appendChild(tdRadius);

        // Col 10: Delete / Empty
        const tdDel = document.createElement('td');
        tdDel.style.padding = '3px 2px';
        tdDel.style.textAlign = 'center';
        tdDel.innerHTML = '<span style="color:#555;">—</span>';
        tr.appendChild(tdDel);

        parent.appendChild(tr);
    }

    private selectOptionByNumericValue(sel: HTMLSelectElement | null, val: number | string): void {
        if (!sel) return;
        const target = Number(val);
        let matched = false;
        for (let i = 0; i < sel.options.length; i++) {
            const optVal = Number(sel.options[i].value);
            if (Math.abs(optVal - target) < 0.0005 || (target > 0 && Math.abs(optVal - target) / target < 0.05)) {
                sel.selectedIndex = i;
                matched = true;
                break;
            }
        }
        if (!matched && sel.options.length > 0) {
            for (let i = 0; i < sel.options.length; i++) {
                if (Math.abs(Number(sel.options[i].value) - 0.5) < 0.001 || Math.abs(Number(sel.options[i].value) - 2.0) < 0.001) {
                    sel.selectedIndex = i;
                    break;
                }
            }
        }
    }



    private applySelectStyle(sel: HTMLSelectElement) {
        sel.style.background = '#1b1b1e';
        sel.style.color = '#fff';
        sel.style.border = '1px solid rgba(255, 255, 255, 0.12)';
        sel.style.borderRadius = '3px';
        sel.style.padding = '1px 3px';
        sel.style.fontSize = '10px';
        sel.style.outline = 'none';
        sel.style.width = '100%';
        sel.style.boxSizing = 'border-box';
        sel.style.minWidth = '0';
        sel.style.height = '20px';
    }

    private applyInputStyle(inp: HTMLInputElement) {
        inp.style.background = '#1b1b1e';
        inp.style.color = '#fff';
        inp.style.border = '1px solid rgba(255, 255, 255, 0.12)';
        inp.style.borderRadius = '3px';
        inp.style.padding = '1px 3px';
        inp.style.fontSize = '10px';
        inp.style.outline = 'none';
        inp.style.width = '100%';
        inp.style.boxSizing = 'border-box';
        inp.style.minWidth = '0';
        inp.style.height = '20px';
    }

    public setViewportNodeId(id: string | null): void {
        this.viewportNodeId = id;
    }

    private getViewportNode(): Node | null {
        const allModels = this.stateManager.getAllModels();
        if (this.viewportNodeId) {
            for (const m of allModels) {
                const node = m.nodes.find(n => n.id === this.viewportNodeId);
                if (node) return node;
            }
        }

        const currentModelId = this.getCurrentModelId();
        if (currentModelId) {
            const targetModel = allModels.find(m => m.id === currentModelId);
            const node = targetModel?.nodes.find(n => n.type === 'Telemetry3DViewport');
            if (node) return node;

            if (!this.virtualNodes[currentModelId]) {
                const defaultSlices = [
                    { axis: 'xy', offset: 0.5, quantities: ['pressure'], stride: 1, enabled: true }
                ];

                this.virtualNodes[currentModelId] = {
                    id: 'virtual-viewport-' + currentModelId,
                    type: 'Telemetry3DViewport',
                    parameters: {
                        slices: defaultSlices,
                        show_grid: true,
                        show_grid_box: true,
                        cell_edges: false,
                        show_stl: true,
                        stl_opacity: 0.5,
                        show_obstacles: true,
                        obstacles_opacity: 1.0,
                        refresh_rate: 0.5
                    }
                };
            }
            return this.virtualNodes[currentModelId];
        }

        return null;
    }

    private getActiveLayerContext(vpNode: any): { layer: string, quantity: string, colormap: string } {
        const state = this.stateManager.getCurrentState();
        const nodes = state?.nodes || [];
        const hasFEM = nodes.some(n => n.type === 'FEMDomain3D' || n.type === 'FEMObject3D' || n.type === 'LSDynaImporter3D' || n.type === 'FEMFSICoupler3D');
        const hasMPM = nodes.some(n => n.type === 'MPMDomain3D' || n.type === 'MPMObject3D');
        const hasCFD = nodes.some(n => n.type === 'CFDSolver3D' || n.type === 'FSICoupler3D' || n.type === 'FEMFSICoupler3D');
        const slices = vpNode?.parameters?.slices || [];
        const anySliceEnabled = slices.some((s: any) => s.enabled !== false);

        // If CFD has active slices and CFD solver is present, prioritize CFD slice
        if (anySliceEnabled && hasCFD) {
            const focusedIdx = vpNode?.parameters?.focusedSliceIndex ?? 0;
            const slice = slices[focusedIdx] || slices[0] || { quantities: ['pressure'] };
            const qty = slice.quantities?.[0] || 'pressure';
            const cmap = vpNode?.parameters?.quantity_colormaps?.[qty] || slice.colormap || vpNode?.parameters?.colormap || 'rainbow';
            return { layer: 'slice', quantity: qty, colormap: cmap };
        }

        // If FEM is present or FEM mesh is explicitly visible
        if (hasFEM || (vpNode?.parameters?.showFEMMesh !== false && (vpNode?.parameters?.femSolid !== false || vpNode?.parameters?.femWireframe !== false))) {
            const qty = vpNode?.parameters?.femQuantity || 'plasticStrain';
            const cmap = vpNode?.parameters?.femColormap || 'rainbow';
            return { layer: 'fem', quantity: qty, colormap: cmap };
        }

        // If Beams / 1D Elements are explicitly visible
        if ((vpNode?.parameters?.showBeams !== false && vpNode?.parameters?.showRebar !== false) &&
            (vpNode?.parameters?.beamSolid !== false || vpNode?.parameters?.rebarSolid !== false || vpNode?.parameters?.beamWireframe !== false || vpNode?.parameters?.rebarWireframe !== false)) {
            const qty = vpNode?.parameters?.beamQuantity || 'plasticStrain';
            const cmap = vpNode?.parameters?.beamColormap || 'rainbow';
            return { layer: 'beam', quantity: qty, colormap: cmap };
        }

        // If MPM is present or MPM particles are visible
        if (hasMPM || (vpNode?.parameters?.showMPMParticles !== false)) {
            const qty = vpNode?.parameters?.mpmParticleQuantity || 'vonMises';
            const cmap = vpNode?.parameters?.mpmParticleColormap || 'rainbow';
            return { layer: 'mpm', quantity: qty, colormap: cmap };
        }

        // If STL results are active
        if (vpNode?.parameters?.show_stl !== false && vpNode?.parameters?.stl_show_results !== false) {
            const qty = vpNode?.parameters?.stl_quantity || 'pressure';
            const cmap = vpNode?.parameters?.stl_colormap || 'rainbow';
            return { layer: 'stl', quantity: qty, colormap: cmap };
        }

        // Fallback to focused slice
        const { quantity } = getFocusedQuantityAndRange(vpNode || { parameters: {} });
        const cmap = vpNode?.parameters?.colormap || 'rainbow';
        return { layer: 'slice', quantity, colormap: cmap };
    }



    private _sendConfigTimeout: any = null;
    private _lastSendConfigTime: number = 0;

    public sendView3DConfig(immediate: boolean = true): void {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        const net = (window as any).networkManager;
        if (!net || !net.isConnected()) return;

        const doSend = () => {
            let targetModelId = this.getCurrentModelId() || vpNode.id;

            const showObstacles = vpNode.parameters.show_obstacles !== false;
            const obstaclesQuantity = vpNode.parameters.obstacles_quantity || 'pressure';
            const showSTL = vpNode.parameters.show_stl !== false;
            const stlShowResults = vpNode.parameters.stl_show_results !== false;
            const stlQuantity = vpNode.parameters.stl_quantity || 'pressure';

            const userSlices = (vpNode.parameters.slices ? [...vpNode.parameters.slices] : []);
            const fullSlices = [...userSlices];

            if (showObstacles) {
                fullSlices.push({
                    axis: 'obstacles',
                    offset: 0.0,
                    quantities: [obstaclesQuantity],
                    stride: 1
                });
            }
            if (showSTL && stlShowResults) {
                let volStride = 1;
                const meshNode = this.getMeshNode();
                if (meshNode) {
                    const cellSize = Number(meshNode.parameters.cell_size ?? 0.05);
                    const xmin = Number(meshNode.parameters.xmin ?? 0.0);
                    const xmax = Number(meshNode.parameters.xmax ?? 1.0);
                    const ymin = Number(meshNode.parameters.ymin ?? 0.0);
                    const ymax = Number(meshNode.parameters.ymax ?? 1.0);
                    const zmin = Number(meshNode.parameters.zmin ?? 0.0);
                    const zmax = Number(meshNode.parameters.zmax ?? 1.0);
                    const nx = Math.max(1, Math.round((xmax - xmin) / cellSize));
                    const ny = Math.max(1, Math.round((ymax - ymin) / cellSize));
                    const nz = Math.max(1, Math.round((zmax - zmin) / cellSize));
                    const totalCells = nx * ny * nz;
                    if (totalCells > 1000000) {
                        volStride = 4;
                    } else if (totalCells > 200000) {
                        volStride = 2;
                    }
                }
                fullSlices.push({
                    axis: 'volume',
                    offset: 0.0,
                    quantities: [stlQuantity],
                    stride: volStride
                });
            }

            net.send({
                command: "VIEW3D_CONFIG",
                modelId: targetModelId,
                refresh_rate: Number(vpNode.parameters.refresh_rate ?? 2.0),
                slices: fullSlices
            });
        };

        if (!immediate) {
            const now = Date.now();
            const elapsed = now - this._lastSendConfigTime;
            if (elapsed >= 100) {
                this._lastSendConfigTime = now;
                if (this._sendConfigTimeout) {
                    clearTimeout(this._sendConfigTimeout);
                    this._sendConfigTimeout = null;
                }
                doSend();
            } else if (!this._sendConfigTimeout) {
                this._sendConfigTimeout = setTimeout(() => {
                    this._sendConfigTimeout = null;
                    this._lastSendConfigTime = Date.now();
                    doSend();
                }, 100 - elapsed);
            }
            return;
        }

        if (this._sendConfigTimeout) {
            clearTimeout(this._sendConfigTimeout);
            this._sendConfigTimeout = null;
        }
        this._lastSendConfigTime = Date.now();
        doSend();
    }

    public getSlicesCarrierNode(): Node | null {
        const meshNode = this.getMeshNode();
        if (meshNode) return meshNode;
        const solverNode = this.getSolverNode();
        if (solverNode) return solverNode;
        return this.getViewportNode();
    }

    public getSlices(): any[] {
        const carrier = this.getSlicesCarrierNode();
        if (carrier && carrier.parameters?.slices && Array.isArray(carrier.parameters.slices)) {
            return carrier.parameters.slices;
        }
        const vpNode = this.getViewportNode();
        if (vpNode && vpNode.parameters?.slices && Array.isArray(vpNode.parameters.slices)) {
            return vpNode.parameters.slices;
        }
        return [];
    }

    public updateSlices(slices: any[], immediateNetwork: boolean = true) {
        const carrier = this.getSlicesCarrierNode();
        if (carrier) {
            this.stateManager.updateNodeParametersInPlace(carrier.id, { slices });
        }
        const vpNode = this.getViewportNode();
        if (vpNode && carrier?.id !== vpNode.id) {
            this.stateManager.updateNodeParametersInPlace(vpNode.id, { slices });
        }
        const modelId = this.getCurrentModelId();
        if (modelId) {
            this.stateManager.updateModelActiveViewSlices(modelId, slices);
        }
        
        const opacities = slices.map((s: any) => s.opacity !== undefined ? s.opacity : 1.0);
        this.worker.postMessage({
            type: 'setConfig',
            data: {
                slices: slices,
                sliceOpacities: opacities,
                focusedSliceIndex: vpNode?.parameters.focusedSliceIndex ?? 0,
                quantityRanges: vpNode?.parameters.quantity_ranges || {}
            }
        });

        this.sendView3DConfig(immediateNetwork);
    }

    public setSlices(slices: any[], immediateNetwork: boolean = true): void {
        this.updateSlices(slices, immediateNetwork);
    }

    public applyModelView(view: any): void {
        if (!view) return;
        if (view.camera) {
            const cam = view.camera;
            this.worker.postMessage({
                type: 'setView',
                data: {
                    pitch: cam.pitch,
                    yaw: cam.yaw,
                    distance: cam.distance,
                    targetX: cam.target ? cam.target[0] : 0,
                    targetY: cam.target ? cam.target[1] : 0,
                    targetZ: cam.target ? cam.target[2] : 0,
                    usePerspective: cam.usePerspective,
                    fov: cam.fov
                }
            });
            if (cam.usePerspective !== undefined) {
                this.usePerspective = Boolean(cam.usePerspective);
                this.syncProjectionButtons();
            }
        }
        if (view.slices && Array.isArray(view.slices)) {
            this.updateSlices(view.slices);
        }
        if (view.toggles) {
            const vpNode = this.getViewportNode();
            if (vpNode && vpNode.id && !vpNode.id.startsWith('virtual-viewport-')) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, view.toggles);
            }
            this.worker.postMessage({
                type: 'updateConfig',
                data: {
                    showGrid: view.toggles.show_grid !== false,
                    showGridBox: view.toggles.show_grid_box !== false,
                    cellEdges: Boolean(view.toggles.cell_edges),
                    showSTL: view.toggles.show_stl !== false,
                    stlOpacity: view.toggles.stl_opacity !== undefined ? Number(view.toggles.stl_opacity) : 0.5,
                    showObstacles: view.toggles.show_obstacles !== false,
                    obstaclesOpacity: view.toggles.obstacles_opacity !== undefined ? Number(view.toggles.obstacles_opacity) : 1.0
                }
            });
        }
    }

    public extractObjectGeometryData(node: any): any {
        if (!node) return null;
        const p = node.parameters || {};
        const meshNode = this.getMeshNode();
        const xmin = Number(meshNode?.parameters?.xmin ?? meshNode?.parameters?.x_min ?? 0.0);
        const xmax = Number(meshNode?.parameters?.xmax ?? meshNode?.parameters?.x_max ?? 1.0);
        const ymin = Number(meshNode?.parameters?.ymin ?? meshNode?.parameters?.y_min ?? 0.0);
        const ymax = Number(meshNode?.parameters?.ymax ?? meshNode?.parameters?.y_max ?? 1.0);
        const zmin = Number(meshNode?.parameters?.zmin ?? meshNode?.parameters?.z_min ?? 0.0);
        const zmax = Number(meshNode?.parameters?.zmax ?? meshNode?.parameters?.z_max ?? 1.0);
        const midX = (xmin + xmax) * 0.5;
        const midY = (ymin + ymax) * 0.5;
        const midZ = (zmin + zmax) * 0.5;

        const shape = p.shape_type || p.shape || p.mesh_source || p.charge_shape || 'Box';
        const posX = Number(p.pos_x ?? p.x ?? p.charge_x ?? p.det_x ?? midX);
        const posY = Number(p.pos_y ?? p.y ?? p.charge_y ?? p.det_y ?? midY);
        const posZ = Number(p.pos_z ?? p.z ?? p.charge_z ?? p.det_z ?? midZ);
        const radius = Number(p.radius ?? p.charge_radius ?? 0.1);
        const innerRadius = Number(p.inner_radius ?? 0.0);
        const height = Number(p.height ?? p.charge_height ?? 0.2);
        const sizeX = Number(p.size_x ?? p.lx ?? p.charge_lx ?? 0.2);
        const sizeY = Number(p.size_y ?? p.ly ?? p.charge_ly ?? 0.2);
        const sizeZ = Number(p.size_z ?? p.lz ?? p.charge_lz ?? 0.2);
        const rotX = Number(p.rot_x ?? p.charge_rot_x ?? 0.0);
        const rotY = Number(p.rot_y ?? p.charge_rot_y ?? 0.0);
        const rotZ = Number(p.rot_z ?? p.charge_rot_z ?? 0.0);

        return {
            objectType: node.type,
            objectId: node.id,
            label: p.name || p.label || node.type,
            shape: shape,
            shape_type: shape,
            pos_x: posX,
            pos_y: posY,
            pos_z: posZ,
            x: posX,
            y: posY,
            z: posZ,
            radius: radius,
            inner_radius: innerRadius,
            height: height,
            size_x: sizeX,
            size_y: sizeY,
            size_z: sizeZ,
            lx: sizeX,
            ly: sizeY,
            lz: sizeZ,
            rot_x: rotX,
            rot_y: rotY,
            rot_z: rotZ,
            scale_x: Number(p.scale_x ?? p.scale_factor ?? 1.0),
            scale_y: Number(p.scale_y ?? p.scale_factor ?? 1.0),
            scale_z: Number(p.scale_z ?? p.scale_factor ?? 1.0)
        };
    }

    private getMeshNode() {
        const vpNode = this.getViewportNode();
        if (!vpNode) return null;

        const allModels = this.stateManager.getAllModels();
        let targetModel: any = null;
        const currentModelId = this.getCurrentModelId();
        if (currentModelId) {
            targetModel = allModels.find(m => m.id === currentModelId) || null;
        }
        if (!targetModel) {
            for (const m of Object.values(allModels)) {
                if (m.nodes.some(n => n.id === vpNode.id)) {
                    targetModel = m;
                    break;
                }
            }
        }
        if (!targetModel) return null;

        const solverNode = this.getSolverNode();
        if (solverNode && (solverNode.type === 'CFDSolver3D' || solverNode.type === 'MPMDomain3D')) {
            const connToSolver = targetModel.connections.find((c: any) => c.toNode === solverNode.id && c.toPort === 'mesh');
            if (connToSolver) {
                let currNode = targetModel.nodes.find((n: any) => n.id === connToSolver.fromNode);
                let depth = 0;
                while (currNode && currNode.type === 'RefinementMesh3D' && depth < 20) {
                    const parentConn = targetModel.connections.find((c: any) => c.toNode === currNode.id && c.toPort === 'parent_mesh');
                    if (!parentConn) break;
                    currNode = targetModel.nodes.find((n: any) => n.id === parentConn.fromNode);
                    depth++;
                }
                if (currNode && (currNode.type === 'DomainMesh3D' || currNode.type === 'DomainMesh2D')) {
                    return currNode;
                }
            }
        }
        const mpmDomain = targetModel.nodes.find((n: any) => n.type === 'MPMDomain3D');
        if (mpmDomain) return mpmDomain;
        const femDomain = targetModel.nodes.find((n: any) => n.type === 'FEMDomain3D');
        if (femDomain) return femDomain;
        return targetModel.nodes.find((n: any) => n.type === 'DomainMesh3D') || null;
    }

    public isIdealGas(): boolean {
        const targetModel = this.getTargetModel();
        if (!targetModel || !targetModel.nodes) return false;
        const cfd = targetModel.nodes.find((n: any) => ['CFDSolver3D', 'CFDSolver2D', 'CFDSolver1D'].includes(n.type));
        if (cfd) {
            if (cfd.parameters?.init_mode === 'Ideal Gas' || cfd.parameters?.is_ideal_gas === true) return true;
            if (['Multi-Material JWL', 'From1D', 'From2D', 'JWL'].includes(cfd.parameters?.init_mode)) return false;
        }
        const mat = targetModel.nodes.find((n: any) => ['Material', 'ExplosiveMaterial'].includes(n.type));
        if (mat) {
            if (mat.parameters?.material_type === 'Ideal Gas' || mat.parameters?.material_type === 'Ideal Gas Charge' || mat.parameters?.explosive_type === 'MaterialIdealGas') return true;
            if (mat.parameters?.material_type === 'JWL Charge' || mat.parameters?.explosive_type === 'MaterialExplosive') return false;
        }
        return false;
    }

    private getSolverNode(): Node | null {
        const vpNode = this.getViewportNode();
        if (!vpNode) return null;

        const allModels = this.stateManager.getAllModels();
        let targetModel: any = null;
        const currentModelId = this.getCurrentModelId();
        if (currentModelId) {
            targetModel = allModels.find(m => m.id === currentModelId) || null;
        }
        if (!targetModel) {
            for (const m of Object.values(allModels)) {
                if (m.nodes.some(n => n.id === vpNode.id)) {
                    targetModel = m;
                    break;
                }
            }
        }
        if (!targetModel) return null;

        const connToViewport = targetModel.connections.find((c: any) => c.toNode === vpNode.id);
        if (connToViewport) {
            const connectedNode = targetModel.nodes.find((n: any) => n.id === connToViewport.fromNode);
            if (connectedNode) {
                if (connectedNode.type === 'FSICoupler3D' || connectedNode.type === 'FEMFSICoupler3D') {
                    const cfdConn = targetModel.connections.find((c: any) => c.toNode === connectedNode.id && c.toPort === 'cfd');
                    if (cfdConn) {
                        const cfdSolver = targetModel.nodes.find((n: any) => n.id === cfdConn.fromNode);
                        if (cfdSolver) return cfdSolver;
                    }
                } else {
                    return connectedNode;
                }
            }
        }
        return targetModel.nodes.find((n: any) => n.type === 'CFDSolver3D' || n.type === 'MPMDomain3D' || n.type === 'FEMDomain3D' || n.type === 'FSICoupler3D' || n.type === 'FEMFSICoupler3D') || null;
    }

    private addSlice() {
        const carrier = this.getSlicesCarrierNode();
        const vpNode = this.getViewportNode();
        if (!carrier && !vpNode) return;
        const slices = [...this.getSlices()];
        const bounds = getSliceBounds('xy', this.getMeshNode());
        const defaultOffset = (bounds.min + bounds.max) / 2.0;

        const defaultQty = 'pressure';
        let auto_scale = true;
        let min_val = 101325.0;
        let max_val = 101325.0 * 10.0;

        const ranges = vpNode?.parameters.quantity_ranges || {};
        if (ranges[defaultQty]) {
            [min_val, max_val] = ranges[defaultQty];
        } else {
            const range = DEFAULT_QUANTITY_RANGES[defaultQty] || [0.0, 1.0];
            min_val = range[0];
            max_val = range[1];
        }

        slices.push({
            axis: 'xy',
            offset: defaultOffset,
            quantities: [defaultQty],
            stride: 1,
            opacity: 1.0,
            colormap: 'rainbow',
            auto_scale,
            log_scale: false,
            interpolate: false,
            min_val,
            max_val,
            enabled: true
        });
        this.needsSlicesRebuild = true;
        this.updateSlices(slices);
    }

    private deleteSlice(index: number) {
        const slices = [...this.getSlices()];
        if (slices.length > index) {
            slices.splice(index, 1);
            this.expandedSliceIndices.delete(index);
            this.needsSlicesRebuild = true;
            this.updateSlices(slices);
        }
    }

    private propagateSliceQuantitySettings(slices: any[], index: number, updates: any) {
        const currentSlice = slices[index];
        const currentQty = currentSlice.quantities?.[0] || 'pressure';

        // 1. Propagate updates to all other slices of the same quantity
        const keysToSync = ['min_val', 'max_val', 'auto_scale', 'log_scale'];
        const hasSyncKey = Object.keys(updates).some(k => keysToSync.includes(k));
        if (hasSyncKey) {
            slices.forEach((s, i) => {
                if (i !== index && (s.quantities?.[0] === currentQty)) {
                    keysToSync.forEach(k => {
                        if (updates[k] !== undefined) {
                            s[k] = updates[k];
                        }
                    });
                }
            });
        }
    }

    private updateSliceProperty(index: number, updates: any, immediateNetwork: boolean = true) {
        const vpNode = this.getViewportNode();
        const slices = [...this.getSlices()];
        if (slices.length > index) {
            const oldQty = slices[index].quantities?.[0];
            const newQty = updates.quantities?.[0];
            
            // If changing axis, compute new offset (midpoint of the new axis bounds)
            if (updates.axis && updates.axis !== slices[index].axis) {
                const meshNode = this.getMeshNode();
                const bounds = getSliceBounds(updates.axis, meshNode);
                updates.offset = (bounds.min + bounds.max) / 2.0;
            }
            
            slices[index] = { ...slices[index], ...updates };

            // If changing quantity, apply existing global range for that qty if exists
            if (newQty && newQty !== oldQty) {
                const ranges = vpNode?.parameters.quantity_ranges || {};
                if (ranges[newQty]) {
                    slices[index].min_val = ranges[newQty][0];
                    slices[index].max_val = ranges[newQty][1];
                    slices[index].auto_scale = false;
                } else {
                    const range = DEFAULT_QUANTITY_RANGES[newQty] || [0.0, 1.0];
                    slices[index].min_val = range[0];
                    slices[index].max_val = range[1];
                    slices[index].auto_scale = true;
                }

                // Automatically disable interpolation for solid cells (discrete mask)
                if (newQty === 'solid') {
                    slices[index].interpolate = false;
                } else if (slices[index].interpolate === undefined) {
                    slices[index].interpolate = false;
                }
            }

            this.propagateSliceQuantitySettings(slices, index, updates);
            this.updateSlices(slices, immediateNetwork);
        }
    }

    private syncControls(postToWorker: boolean = true) {
        const vpNode = this.getViewportNode();
        this.syncColorbarOverlay(vpNode || { parameters: {} });
        if (!vpNode) return;

        const solverNode = this.getSolverNode();

        // Resolve connected DomainMesh3D
        const meshNode = this.getMeshNode();

        // Sync Bottom Controls Dock Chips & Inputs
        const updateChipStyle = (idSuffix: string, active: boolean) => {
            const chip = document.getElementById(this.getElId(`viewport-chip-${idSuffix}`));
            if (chip) {
                chip.dataset.active = String(active);
                chip.style.background = active ? '#007acc' : '#25252a';
                chip.style.border = active ? '1px solid #00adff' : '1px solid rgba(255,255,255,0.12)';
                chip.style.color = active ? '#ffffff' : '#aaaaaa';
                chip.style.fontWeight = active ? '600' : '500';
            }
        };

        const slicesEnabled = (vpNode.parameters.slices || []).some((s: any) => s.enabled !== false);
        const femVisible = vpNode.parameters.showFEMMesh !== false && (vpNode.parameters.femSolid !== false || vpNode.parameters.femWireframe !== false);
        const beamVisible = (vpNode.parameters.showBeams !== false && vpNode.parameters.showRebar !== false) &&
            (vpNode.parameters.beamSolid !== false || vpNode.parameters.rebarSolid !== false || vpNode.parameters.beamWireframe !== false || vpNode.parameters.rebarWireframe !== false);
        updateChipStyle('slices', slicesEnabled);
        updateChipStyle('fem', femVisible);
        updateChipStyle('beams', beamVisible);
        updateChipStyle('rebar', beamVisible);
        updateChipStyle('mpm', vpNode.parameters.showMPMParticles !== false);
        updateChipStyle('stl', vpNode.parameters.show_stl !== false);
        updateChipStyle('obstacles', vpNode.parameters.show_obstacles !== false);
        updateChipStyle('grid', this.isGridEnabled(vpNode));
        updateChipStyle('gauges', vpNode.parameters.show_gauges !== false);
        updateChipStyle('lighting', vpNode.parameters.lightingEnabled !== false);

        const activeCtx = this.getActiveLayerContext(vpNode);
        const dockQtySel = document.getElementById(this.getElId('viewport-dock-qty-sel')) as HTMLSelectElement;
        if (dockQtySel && dockQtySel.dataset.editing !== 'true' && document.activeElement !== dockQtySel) {
            dockQtySel.value = activeCtx.quantity || 'pressure';
        }

        const dockCmapSel = document.getElementById(this.getElId('viewport-dock-cmap-sel')) as HTMLSelectElement;
        if (dockCmapSel && dockCmapSel.dataset.editing !== 'true' && document.activeElement !== dockCmapSel) {
            dockCmapSel.value = activeCtx.colormap || 'rainbow';
        }

        // 1. Sync Render Settings & Global Refresh Rates

        const rateVal = Number(vpNode.parameters.refresh_rate ?? 2.0);

        const rateSelMatrix = document.getElementById(this.getElId('viewport-refresh-rate-sel-matrix')) as HTMLSelectElement;
        if (rateSelMatrix && rateSelMatrix.dataset.editing !== 'true' && document.activeElement !== rateSelMatrix) {
            this.selectOptionByNumericValue(rateSelMatrix, rateVal);
        }

        const rateSelDock = document.getElementById(this.getElId('viewport-refresh-rate-sel-dock')) as HTMLSelectElement;
        if (rateSelDock && rateSelDock.dataset.editing !== 'true' && document.activeElement !== rateSelDock) {
            this.selectOptionByNumericValue(rateSelDock, rateVal);
        }

        // Lighting & AO Table Row Sync
        const lightCb = document.getElementById(this.getElId('viewport-lighting-cb')) as HTMLInputElement;
        if (lightCb && document.activeElement !== lightCb) lightCb.checked = vpNode.parameters.lightingEnabled !== false;
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-ao-btn')), vpNode.parameters.aoEnabled !== false);

        const ambSlider = document.getElementById(this.getElId('viewport-ambient-slider')) as HTMLInputElement;
        if (ambSlider && document.activeElement !== ambSlider) {
            const val = vpNode.parameters.ambientLevel ?? 0.3;
            ambSlider.value = String(val);
            const ambLabel = ambSlider.previousElementSibling as HTMLElement;
            if (ambLabel) ambLabel.innerHTML = `Ambient Level: ${Number(val).toFixed(2)}`;
        }
        const specSlider = document.getElementById(this.getElId('viewport-specular-slider')) as HTMLInputElement;
        if (specSlider && document.activeElement !== specSlider) {
            const val = vpNode.parameters.specularIntensity ?? 0.4;
            specSlider.value = String(val);
            const specLabel = specSlider.previousElementSibling as HTMLElement;
            if (specLabel) specLabel.innerHTML = `Specular Level: ${Number(val).toFixed(2)}`;
        }

        // STL Table Row Sync
        const stlShowCb = document.getElementById(this.getElId('viewport-stl-show-cb')) as HTMLInputElement;
        if (stlShowCb && document.activeElement !== stlShowCb) stlShowCb.checked = vpNode.parameters.show_stl !== false;
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-stl-solids-btn')), vpNode.parameters.stl_solids !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-stl-wf-btn')), !!vpNode.parameters.stl_wireframe);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-stl-show-results-btn')), vpNode.parameters.stl_show_results !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-stl-cb-btn')), vpNode.parameters.stl_show_colorbar === true);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-stl-autoscale-btn')), vpNode.parameters.stl_auto_scale !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-stl-logscale-btn')), vpNode.parameters.stl_log_scale === true);

        // Obstacles Table Row Sync
        const obsShowCb = document.getElementById(this.getElId('viewport-obs-show-cb')) as HTMLInputElement;
        if (obsShowCb && document.activeElement !== obsShowCb) obsShowCb.checked = vpNode.parameters.show_obstacles !== false;
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-obs-solid-btn')), vpNode.parameters.obstacles_solid !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-obs-grid-btn')), vpNode.parameters.obstacles_gridlines !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-obs-light-btn')), vpNode.parameters.obstacles_lighting !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-obs-cb-btn')), vpNode.parameters.obstacles_show_colorbar === true);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-obs-auto-btn')), vpNode.parameters.obstacles_auto_scale !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-obs-log-btn')), vpNode.parameters.obstacles_log_scale === true);

        // Charge Table Row Sync
        const chargeShowCb = document.getElementById(this.getElId('viewport-charge-show-cb')) as HTMLInputElement;
        if (chargeShowCb && document.activeElement !== chargeShowCb) chargeShowCb.checked = vpNode.parameters.show_charge !== false;
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-charge-solid-btn')), vpNode.parameters.charge_solid !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-charge-wf-btn')), vpNode.parameters.charge_wireframe !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-charge-light-btn')), vpNode.parameters.charge_lighting !== false);

        // Detonators Table Row Sync
        const detShowCb = document.getElementById(this.getElId('viewport-det-show-cb')) as HTMLInputElement;
        if (detShowCb && document.activeElement !== detShowCb) detShowCb.checked = (vpNode.parameters.show_detonators !== false && vpNode.parameters.show_detonator !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-det-solid-btn')), (vpNode.parameters.detonators_solid !== false && vpNode.parameters.detonator_solid !== false));
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-det-wf-btn')), (vpNode.parameters.detonators_wireframe !== false && vpNode.parameters.detonator_wireframe !== false));
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-det-light-btn')), (vpNode.parameters.detonators_lighting !== false && vpNode.parameters.detonator_lighting !== false));

        // Grid & Box Table Row Sync
        const gridCb = document.getElementById(this.getElId('viewport-grid-cb')) as HTMLInputElement;
        if (gridCb && document.activeElement !== gridCb) gridCb.checked = this.isGridEnabled(vpNode);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-edges-btn')), !!vpNode.parameters.cell_edges);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-box-btn')), this.isGridBoxEnabled(vpNode));

        // Gauges Table Row Sync
        const showGauges = vpNode.parameters.show_gauges !== false;
        const gaugeSize = vpNode.parameters.gauge_size ?? 1.0;
        const gaugeOpacity = vpNode.parameters.gauge_opacity ?? 1.0;
        const gaugeQuantity = vpNode.parameters.gauge_quantity || 'pressure';
        const gaugeSolid = vpNode.parameters.gauge_solid !== false;
        const gauges = this.getVirtualGauges();

        const showGaugesCb = document.getElementById(this.getElId('viewport-gauges-cb')) as HTMLInputElement;
        if (showGaugesCb && document.activeElement !== showGaugesCb) showGaugesCb.checked = showGauges;
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-gauge-solid-btn')), gaugeSolid);

        // MPM Particles Table Row Sync
        const mpmShowCb = document.getElementById(this.getElId('viewport-mpm-particles-cb')) as HTMLInputElement;
        if (mpmShowCb && document.activeElement !== mpmShowCb) mpmShowCb.checked = vpNode.parameters.showMPMParticles !== false;
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-mpm-cb-btn')), vpNode.parameters.mpmParticleShowColorbar === true);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-mpm-auto-btn')), vpNode.parameters.mpmParticleAutoScale !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-mpm-log-btn')), vpNode.parameters.mpmParticleLogScale === true);

        // FEM Mesh Table Row Sync
        const femMeshCb = document.getElementById(this.getElId('viewport-fem-mesh-cb')) as HTMLInputElement;
        if (femMeshCb && document.activeElement !== femMeshCb) femMeshCb.checked = vpNode.parameters.showFEMMesh !== false;
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-fem-sol-btn')), vpNode.parameters.femSolid !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-fem-wir-btn')), vpNode.parameters.femWireframe !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-fem-res-btn')), vpNode.parameters.femResults !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-fem-cb-btn')), vpNode.parameters.femShowColorbar === true);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-fem-auto-btn')), vpNode.parameters.femAutoScale !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-fem-log-btn')), vpNode.parameters.femLogScale === true);

        // Beams Table Row Sync
        const beamMeshCb = document.getElementById(this.getElId('viewport-beam-mesh-cb')) as HTMLInputElement;
        if (beamMeshCb && document.activeElement !== beamMeshCb) beamMeshCb.checked = (vpNode.parameters.showBeams !== false && vpNode.parameters.showRebar !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-beam-sol-btn')), vpNode.parameters.beamSolid !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-beam-wir-btn')), vpNode.parameters.beamWireframe !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-beam-res-btn')), vpNode.parameters.femResults !== false);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-beam-cb-btn')), vpNode.parameters.femShowColorbar === true);
        this.syncToggleBtnState(document.getElementById(this.getElId('viewport-beam-auto-btn')), vpNode.parameters.beamAutoScale !== false);

        if (postToWorker) {
            const qCmaps = vpNode.parameters.quantity_colormaps || {};
            const stlQty = vpNode.parameters.stl_quantity || 'pressure';
            const resStlCmap = qCmaps[stlQty] || vpNode.parameters.stl_colormap || 'rainbow';

            const obsQty = vpNode.parameters.obstacles_quantity || 'pressure';
            const resObsCmap = qCmaps[obsQty] || vpNode.parameters.obstacles_colormap || 'rainbow';

            // Use model-scoped solver/domain nodes to avoid bleeding from other models
            const solverNode3D = this.getSolverNode();
            const domainMesh3DNode = this.getMeshNode();
            // Resolve the root DomainMesh3D by walking up any RefinementMesh3D chain
            let domainMesh3D: any = domainMesh3DNode;
            if (domainMesh3D && domainMesh3D.type !== 'DomainMesh3D') domainMesh3D = null;
            if (!domainMesh3D && domainMesh3DNode) {
                // domainMesh3DNode may be a RefinementMesh3D — walk up to the root
                const allModels = this.stateManager.getAllModels();
                let targetModel: any = null;
                const currentModelId = this.getCurrentModelId();
                if (currentModelId) targetModel = allModels.find((m: any) => m.id === currentModelId) || null;
                if (!targetModel) {
                    const vpNode2 = this.getViewportNode();
                    for (const m of Object.values(allModels) as any[]) {
                        if (m.nodes.some((n: any) => n.id === vpNode2?.id)) { targetModel = m; break; }
                    }
                }
                if (targetModel) {
                    let curr: any = domainMesh3DNode;
                    let depth = 0;
                    while (curr && curr.type === 'RefinementMesh3D' && depth < 20) {
                        const pc = targetModel.connections.find((c: any) => c.toNode === curr.id && c.toPort === 'parent_mesh');
                        if (!pc) break;
                        curr = targetModel.nodes.find((n: any) => n.id === pc.fromNode);
                        depth++;
                    }
                    if (curr && curr.type === 'DomainMesh3D') domainMesh3D = curr;
                }
            }
            const xmin = Number(domainMesh3D?.parameters.xmin ?? domainMesh3D?.parameters.x_min ?? 0.0);
            const xmax = Number(domainMesh3D?.parameters.xmax ?? domainMesh3D?.parameters.x_max ?? 1.0);
            const ymin = Number(domainMesh3D?.parameters.ymin ?? domainMesh3D?.parameters.y_min ?? 0.0);
            const ymax = Number(domainMesh3D?.parameters.ymax ?? domainMesh3D?.parameters.y_max ?? 1.0);
            const zmin = Number(domainMesh3D?.parameters.zmin ?? domainMesh3D?.parameters.z_min ?? 0.0);
            const zmax = Number(domainMesh3D?.parameters.zmax ?? domainMesh3D?.parameters.z_max ?? 1.0);
            const cellSize = Number(domainMesh3D?.parameters.cell_size ?? domainMesh3D?.parameters.dx ?? 0.01);
            const nx = Number(domainMesh3D?.parameters.nx ?? Math.max(1, Math.round((xmax - xmin) / cellSize)));
            const ny = Number(domainMesh3D?.parameters.ny ?? Math.max(1, Math.round((ymax - ymin) / cellSize)));
            const nz = Number(domainMesh3D?.parameters.nz ?? Math.max(1, Math.round((zmax - zmin) / cellSize)));

            // Resolve the charge node via connections from the model-scoped solver or standalone node in model
            const currentModelId = this.getCurrentModelId();
            const modelState = currentModelId ? this.stateManager.getSimulationState(currentModelId) : null;
            const chargeConn = (solverNode3D && modelState) ? modelState.connections.find((c: any) => c.toNode === solverNode3D.id && c.toPort === 'charge') : null;
            const chargeNode = chargeConn
                ? modelState?.nodes.find((n: any) => n.id === chargeConn.fromNode)
                : (modelState?.nodes.find((n: any) => n.type === 'Charge3D' || n.type === 'Charge') || null);

            let chargeParams: any = null;
            if (chargeNode) {
                const shape = chargeNode.parameters.charge_shape || 'Sphere';
                const cx = Number(chargeNode.parameters.charge_x ?? ((xmin + xmax) * 0.5));
                const cy = Number(chargeNode.parameters.charge_y ?? ((ymin + ymax) * 0.5));
                const cz = Number(chargeNode.parameters.charge_z ?? ((zmin + zmax) * 0.5));
                const radius = Number(chargeNode.parameters.charge_radius ?? 0.1);
                const height = Number(chargeNode.parameters.charge_height ?? 0.2);
                const lx = Number(chargeNode.parameters.charge_lx ?? 0.2);
                const ly = Number(chargeNode.parameters.charge_ly ?? 0.2);
                const lz = Number(chargeNode.parameters.charge_lz ?? 0.2);
                const rot_x = Number(chargeNode.parameters.charge_rot_x ?? 0.0);
                const rot_y = Number(chargeNode.parameters.charge_rot_y ?? 0.0);
                const rot_z = Number(chargeNode.parameters.charge_rot_z ?? 0.0);

                chargeParams = {
                    id: chargeNode.id,
                    type: chargeNode.type,
                    shape: shape,
                    x: cx, y: cy, z: cz,
                    radius: radius, height: height,
                    lx: lx, ly: ly, lz: lz,
                    rot_x: rot_x, rot_y: rot_y, rot_z: rot_z
                };

                const detConn = (solverNode3D && modelState) ? modelState.connections.find((c: any) => c.toNode === solverNode3D.id && c.toPort === 'detonator') : null;
                const detNode = detConn
                    ? modelState?.nodes.find((n: any) => n.id === detConn.fromNode)
                    : (modelState?.nodes.find((n: any) => n.type === 'DetonatorLocation3D' || n.type === 'DetonatorLocation') || null);
                if (detNode) {
                    chargeParams.det_x = Number(detNode.parameters.det_x ?? detNode.parameters.x ?? cx);
                    chargeParams.det_y = Number(detNode.parameters.det_y ?? detNode.parameters.y ?? cy);
                    chargeParams.det_z = Number(detNode.parameters.det_z ?? detNode.parameters.z ?? cz);
                }
            }

            const mpmObjectNodes = modelState?.nodes.filter((n: any) => n.type === 'MPMObject3D') || [];
            const mpmObjects = mpmObjectNodes.map((n: any) => {
                const geom = this.extractObjectGeometryData(n);
                return {
                    id: n.id,
                    shape: geom?.shape || 'Box',
                    shape_type: geom?.shape_type || 'Box',
                    x: geom?.x ?? 0.5,
                    y: geom?.y ?? 0.5,
                    z: geom?.z ?? 0.5,
                    pos_x: geom?.pos_x ?? 0.5,
                    pos_y: geom?.pos_y ?? 0.5,
                    pos_z: geom?.pos_z ?? 0.5,
                    size_x: geom?.size_x ?? 0.2,
                    size_y: geom?.size_y ?? 0.2,
                    size_z: geom?.size_z ?? 0.2,
                    radius: geom?.radius ?? 0.1,
                    inner_radius: geom?.inner_radius ?? 0.0,
                    height: geom?.height ?? 0.2,
                    rot_x: geom?.rot_x ?? 0.0,
                    rot_y: geom?.rot_y ?? 0.0,
                    rot_z: geom?.rot_z ?? 0.0
                };
            });

            const detonatorNodes = modelState?.nodes.filter((n: any) => n.type === 'DetonatorLocation3D' || n.type === 'DetonatorLocation') || [];
            let detonatorsList = detonatorNodes.map((n: any) => ({
                id: n.id,
                x: Number(n.parameters?.detonator_x ?? n.parameters?.x ?? 0),
                y: Number(n.parameters?.detonator_y ?? n.parameters?.y ?? 0),
                z: Number(n.parameters?.detonator_z ?? n.parameters?.z ?? 0),
                radius: Number(n.parameters?.detonator_radius ?? n.parameters?.radius ?? 0.01)
            }));
            if (detonatorsList.length === 0 && chargeParams && (chargeParams.det_x !== undefined || chargeParams.det_y !== undefined || chargeParams.det_z !== undefined)) {
                detonatorsList = [{
                    id: 'det_core',
                    x: chargeParams.det_x,
                    y: chargeParams.det_y,
                    z: chargeParams.det_z,
                    radius: 0.015
                }];
            }

            const submeshes: any[] = [];

            if (postToWorker) {
                const cfgData: any = {
                    xmin,
                    xmax,
                    ymin,
                    ymax,
                    zmin,
                    zmax,
                    dx: cellSize,
                    dy: cellSize,
                    dz: cellSize,
                    nx,
                    ny,
                    nz,
                    quantityColormaps: qCmaps,
                    showGauges,
                    gaugeSize,
                    gaugeOpacity,
                    gaugeQuantity,
                    gaugeSolid,
                    gauges,
                    gridOpacity: vpNode.parameters.grid_opacity ?? 1.0,
                    gridMeshlines: vpNode.parameters.cell_edges === true,
                    showGridBox: this.isGridBoxEnabled(vpNode),
                    stlColormap: resStlCmap,
                    obstaclesColormap: resObsCmap,
                    obstaclesQuantity: obsQty,
                    obstaclesSolid: vpNode.parameters.obstacles_solid !== false,
                    obstaclesGridlines: vpNode.parameters.obstacles_gridlines !== false,
                    obstaclesLighting: vpNode.parameters.obstacles_lighting !== false,
                    obstaclesOpacity: vpNode.parameters.obstacles_opacity ?? 1.0,
                    obstaclesAutoScale: vpNode.parameters.obstacles_auto_scale !== false,
                    obstaclesLogScale: vpNode.parameters.obstacles_log_scale === true,
                    obstaclesInterpolate: vpNode.parameters.obstacles_interpolate === true,
                    showCharge: vpNode.parameters.show_charge !== false,
                    chargeSolid: vpNode.parameters.charge_solid !== false,
                    chargeWireframe: vpNode.parameters.charge_wireframe !== false,
                    chargeLighting: vpNode.parameters.charge_lighting !== false,
                    chargeOpacity: vpNode.parameters.charge_opacity ?? 0.65,
                    charge: chargeParams,
                    showDetonators: (vpNode.parameters.show_detonators !== false && vpNode.parameters.show_detonator !== false),
                    detonatorSolid: (vpNode.parameters.detonators_solid !== false && vpNode.parameters.detonator_solid !== false),
                    detonatorWireframe: (vpNode.parameters.detonators_wireframe !== false && vpNode.parameters.detonator_wireframe !== false),
                    detonatorLighting: (vpNode.parameters.detonators_lighting !== false && vpNode.parameters.detonator_lighting !== false),
                    detonatorSize: vpNode.parameters.detonators_size ?? vpNode.parameters.detonator_size ?? 1.0,
                    detonatorOpacity: vpNode.parameters.detonators_opacity ?? vpNode.parameters.detonator_opacity ?? 1.0,
                    detonators: detonatorsList,
                    mpmObjects: mpmObjects,
                    submeshes: submeshes,
                    ppc: Number(modelState?.nodes.find((n: any) => n.type === 'MPMObject3D')?.parameters['ppc'] ?? modelState?.nodes.find((n: any) => n.type === 'MPMDomain3D' || n.type === 'DomainMesh3D')?.parameters['ppc'] ?? 8),
                    showMPMParticles: vpNode.parameters.showMPMParticles !== false,
                    mpmParticleDiameter: (vpNode.parameters.mpmParticleDiameter && vpNode.parameters.mpmParticleDiameter > 0) ? vpNode.parameters.mpmParticleDiameter : this.getAutoParticleDiameter(),
                    mpmParticleSize: vpNode.parameters.mpmParticleSize ?? 4.0,
                    mpmParticleQuantity: vpNode.parameters.mpmParticleQuantity || 'vonMises',
                    mpmParticleColormap: vpNode.parameters.mpmParticleColormap || 'rainbow',
                    mpmParticleAutoScale: vpNode.parameters.mpmParticleAutoScale !== false,
                    mpmParticleLogScale: vpNode.parameters.mpmParticleLogScale === true,
                    mpmParticleOpacity: vpNode.parameters.mpmParticleOpacity ?? 1.0,
                    showFEMMesh: vpNode.parameters.showFEMMesh !== false,
                    femSolid: vpNode.parameters.femSolid !== false,
                    femWireframe: vpNode.parameters.femWireframe !== false,
                    femResults: vpNode.parameters.femResults !== false,
                    showRebar: vpNode.parameters.showRebar !== false,
                    rebarSolid: vpNode.parameters.rebarSolid !== false,
                    rebarWireframe: vpNode.parameters.rebarWireframe !== false,
                    rebarRadius: vpNode.parameters.rebarRadius ?? 0.008,
                    showBeams: vpNode.parameters.showBeams !== false,
                    beamSolid: vpNode.parameters.beamSolid !== false,
                    beamWireframe: vpNode.parameters.beamWireframe !== false,
                    beamRadius: vpNode.parameters.beamRadius ?? vpNode.parameters.rebarRadius ?? 0.008,
                    beamQuantity: vpNode.parameters.beamQuantity || 'plasticStrain',
                    beamColormap: vpNode.parameters.beamColormap || 'rainbow',
                    beamAutoScale: vpNode.parameters.beamAutoScale !== false,
                    beamLogScale: vpNode.parameters.beamLogScale === true,
                    femQuantity: vpNode.parameters.femQuantity || 'vonMises',
                    femColormap: vpNode.parameters.femColormap || 'rainbow',
                    femAutoScale: vpNode.parameters.femAutoScale !== false,
                    femLogScale: vpNode.parameters.femLogScale === true,
                    femOpacity: vpNode.parameters.femOpacity ?? 1.0
                };
                if (vpNode.parameters.obstacles_min_val !== undefined) cfgData.obstaclesMinVal = vpNode.parameters.obstacles_min_val;
                if (vpNode.parameters.obstacles_max_val !== undefined) cfgData.obstaclesMaxVal = vpNode.parameters.obstacles_max_val;
                if (vpNode.parameters.mpmParticleMinVal !== undefined) cfgData.mpmParticleMinVal = vpNode.parameters.mpmParticleMinVal;
                if (vpNode.parameters.mpmParticleMaxVal !== undefined) cfgData.mpmParticleMaxVal = vpNode.parameters.mpmParticleMaxVal;
                if (vpNode.parameters.beamMinVal !== undefined) cfgData.beamMinVal = vpNode.parameters.beamMinVal;
                if (vpNode.parameters.beamMaxVal !== undefined) cfgData.beamMaxVal = vpNode.parameters.beamMaxVal;
                if (vpNode.parameters.femMinVal !== undefined) cfgData.femMinVal = vpNode.parameters.femMinVal;
                if (vpNode.parameters.femMaxVal !== undefined) cfgData.femMaxVal = vpNode.parameters.femMaxVal;

                this.worker.postMessage({
                    type: 'setConfig',
                    data: cfgData
                });
            }

            // Re-sync currently selected object highlight so property edits update outline live
            const selNodeId = this.stateManager.selectedNodeId;
            if (selNodeId) {
                const selNode = modelState?.nodes.find((n: any) => n.id === selNodeId);
                if (selNode && !['Telemetry3DViewport', 'DomainMesh3D', 'DomainMesh', 'CFDSolver3D', 'CFDSolver', 'CFDSolver2D'].includes(selNode.type)) {
                    const selGeom = this.extractObjectGeometryData(selNode);
                    if (selGeom) {
                        this.worker.postMessage({
                            type: 'setSelectedObject',
                            data: selGeom
                        });
                    }
                }
            }
        }

        const geomNode = this.getGeometryNode();
        let geomHash = '';
        if (geomNode) {
            if (geomNode.type === 'STLGeometry') {
                geomHash = (geomNode.parameters.stl_file || '') + '_' + (geomNode.parameters.geometry_hash || '');
            } else if (geomNode.type === 'PrimitiveGeometry3D') {
                const primsStr = JSON.stringify(geomNode.parameters.primitives || []) + '_' + (geomNode.parameters.voxelization_method || 'watertight_floodfill');
                let hash = 5381;
                for (let i = 0; i < primsStr.length; i++) {
                    hash = ((hash << 5) + hash) + primsStr.charCodeAt(i);
                    hash = hash & hash;
                }
                geomHash = 'prims_' + Math.abs(hash).toString(16);
            }
        }

        if (geomHash !== this.currentGeometryHash) {
            if (geomNode) {
                const net = (window as any).networkManager;
                if (net && net.isConnected()) {
                    // Only stamp hash AFTER successfully dispatching the request
                    this.currentGeometryHash = geomHash;
                    if (geomNode.type === 'STLGeometry') {
                        const curModel = this.stateManager.getAllModels().find(m => m.id === this.getCurrentModelId());
                        const resolvedPath = resolveResourcePath(geomNode.parameters.stl_file || '', curModel?.filename);
                        net.send({ command: "LOAD_STL_GEOMETRY", filePath: resolvedPath, modelId: this.getCurrentModelId() });
                    } else if (geomNode.type === 'PrimitiveGeometry3D') {
                        net.send({ command: "LOAD_PRIMITIVE_GEOMETRY", primitives: geomNode.parameters.primitives || [], voxelization_method: geomNode.parameters.voxelization_method || 'watertight_floodfill', modelId: this.getCurrentModelId() });
                    }
                }
                // If not connected, do NOT update hash so we retry when connected
            } else {
                this.currentGeometryHash = geomHash;
                this.worker.postMessage({ type: 'setSTLGeometry', data: { vertices: null } });
            }
        }
        // Re-render static component rows below slices so popovers and buttons update instantly
        if (this.staticListContainer && !this.activePopover) {
            this.staticListContainer.innerHTML = '';
            this.buildObstacleRow(this.staticListContainer);
            this.buildSTLRow(this.staticListContainer);
            this.buildChargeRow(this.staticListContainer);
            this.buildDetonatorRow(this.staticListContainer);
            this.buildGridRow(this.staticListContainer);
            this.buildGaugeRow(this.staticListContainer);
            this.buildMPMParticlesTableRow(this.staticListContainer);
            this.buildFEMMeshTableRow(this.staticListContainer);
            this.buildBeamTableRow(this.staticListContainer);
            this.buildLightingTableRow(this.staticListContainer);
        }

        // 2. Sync Slices Row list
        const slices = vpNode.parameters.slices || [];
        if (this.sliceListContainer) {
            const currentRows = this.sliceListContainer.children.length;
            // Force rebuild if slice axis or quantity changed (structural changes)
            const currSliceKey = slices.map((s: any) => {
                const q = s.quantities?.[0] || 'pressure';
                return `${s.axis}:${q}`;
            }).join('|');

            if (currSliceKey !== this._lastSliceKey) {
                this.needsSlicesRebuild = true;
            }
            this._lastSliceKey = currSliceKey;
            if ((this.needsSlicesRebuild || currentRows !== slices.length) && !this.activePopover) {
                this.sliceListContainer.innerHTML = '';
                this.needsSlicesRebuild = false;
                const focusedSliceIndex = vpNode.parameters.focusedSliceIndex ?? 0;
                slices.forEach((slice: any, idx: number) => {
                    const qty = slice.quantities?.[0] || 'pressure';
                    const autoScaleVal = slice.auto_scale !== false;
                    const logScaleVal = slice.log_scale === true;

                    const tr = document.createElement('tr');
                    tr.style.borderBottom = '1px solid rgba(255,255,255,0.06)';
                    tr.style.background = idx === focusedSliceIndex ? 'rgba(0, 173, 255, 0.12)' : 'transparent';

                    // Col 1: Vis Checkbox
                    const tdVis = document.createElement('td');
                    tdVis.style.padding = '3px 2px';
                    tdVis.style.textAlign = 'center';
                    const enableCb = document.createElement('input');
                    enableCb.type = 'checkbox';
                    enableCb.className = 'slice-enable-cb';
                    enableCb.checked = slice.enabled !== false;
                    enableCb.onchange = (e) => {
                        e.stopPropagation();
                        this.updateSliceProperty(idx, { enabled: enableCb.checked });
                    };
                    tdVis.appendChild(enableCb);
                    tr.appendChild(tdVis);

                    // Col 2: Layer Title & Plane/Position Pill Button
                    const tdLayer = document.createElement('td');
                    tdLayer.style.padding = '3px 4px';
                    tdLayer.style.cursor = 'pointer';
                    tdLayer.onclick = () => this.stateManager.updateNodeParametersInPlace(vpNode.id, { focusedSliceIndex: idx });
                    
                    const titleRow = document.createElement('div');
                    titleRow.style.display = 'flex';
                    titleRow.style.alignItems = 'center';
                    titleRow.style.justifyContent = 'space-between';
                    titleRow.style.fontSize = '9px';
                    titleRow.style.fontWeight = 'bold';
                    titleRow.style.color = '#ccc';
                    titleRow.innerHTML = `🔪 Slice #${idx + 1}`;
                    tdLayer.appendChild(titleRow);

                    const bounds = getSliceBounds(slice.axis, meshNode);
                    const curOffset = Number(slice.offset ?? (bounds.min + bounds.max) / 2.0);
                    const axisLabel = getSliceAxisLabel(slice.axis);

                    const posPill = document.createElement('button');
                    posPill.className = 'slice-pos-pill';
                    posPill.innerHTML = `📐 <b>${axisLabel}</b> @ ${curOffset.toFixed(2)}m ▾`;
                    this.applyButtonStyle(posPill);
                    posPill.style.fontSize = '8.5px';
                    posPill.style.width = '100%';
                    posPill.style.marginTop = '2px';
                    posPill.style.padding = '2px 4px';
                    posPill.style.textAlign = 'center';
                    posPill.onclick = (e) => {
                        e.stopPropagation();
                        this.showSlicePositionPopover(posPill, idx, slice, meshNode);
                    };
                    tdLayer.appendChild(posPill);
                    tr.appendChild(tdLayer);

                    // Col 3: SOL (Empty for Slices)
                    const tdSolE = document.createElement('td');
                    tdSolE.innerHTML = '<span style="color:#555;">—</span>';
                    tdSolE.style.textAlign = 'center';
                    tr.appendChild(tdSolE);

                    // Col 4: LINES (Cell Edges Toggle Button)
                    const tdLines = document.createElement('td');
                    tdLines.style.padding = '3px 2px';
                    const initCellEdges = vpNode.parameters.cell_edges === true;
                    tdLines.appendChild(this.createToggleBtn(`slice-edges-btn-${idx}`, 'Edg', initCellEdges, (v) => {
                        const vp = this.getViewportNode();
                        if (vp) {
                            this.stateManager.updateNodeParametersInPlace(vp.id, { cell_edges: v });
                            this.worker.postMessage({ type: 'setConfig', data: { showCellEdges: v } });
                        }
                    }));
                    tr.appendChild(tdLines);

                    // Col 5: RES (Interpolate / Smooth Contours Toggle)
                    const tdRes = document.createElement('td');
                    tdRes.style.padding = '3px 2px';
                    const initInterp = slice.interpolate === true;
                    tdRes.appendChild(this.createToggleBtn(`slice-interp-btn-${idx}`, 'Int', initInterp, (v) => {
                        this.updateSliceProperty(idx, { interpolate: v });
                    }));
                    tr.appendChild(tdRes);

                    // Col 6: QTY (Quantity Popover Pill)
                    const tdQty = document.createElement('td');
                    tdQty.style.padding = '3px 4px';
                    const qtyPill = document.createElement('button');
                    qtyPill.className = 'slice-qty-pill';
                    const qtyLabels: Record<string, string> = {
                        pressure: 'Press', density: 'Density', velocity: 'Speed', energy: 'Energy',
                        species1: 'Reacted', species2: 'Unreacted', species3: 'Air',
                        overpressure: 'Overpress', peak_overpressure: 'Pk Overpress', peak_impulse: 'Pk Impulse', amr_level: 'AMR Level'
                    };
                    qtyPill.textContent = `${qtyLabels[qty] || qty} ▾`;
                    this.applyButtonStyle(qtyPill);
                    qtyPill.style.fontSize = '8.5px';
                    qtyPill.style.width = '100%';
                    qtyPill.style.padding = '2px 0';
                    qtyPill.onclick = (e) => {
                        e.stopPropagation();
                        this.showQuantityPopover(qtyPill, qty, 'cfd', (newQ) => {
                            const qCmaps = vpNode.parameters.quantity_colormaps || {};
                            const newCmap = qCmaps[newQ] || 'rainbow';
                            this.updateSliceProperty(idx, { quantities: [newQ], colormap: newCmap });
                        });
                    };
                    tdQty.appendChild(qtyPill);
                    tr.appendChild(tdQty);

                    // Col 7: COLOR (Colormap Popover Button + Colorbar Toggle)
                    const tdCmap = document.createElement('td');
                    tdCmap.style.padding = '3px 4px';
                    const cmapWrap = document.createElement('div');
                    cmapWrap.style.display = 'flex';
                    cmapWrap.style.gap = '3px';
                    cmapWrap.style.alignItems = 'center';

                    const curCmap = vpNode.parameters.quantity_colormaps?.[qty] || slice.colormap || 'rainbow';
                    const cmapPill = document.createElement('button');
                    cmapPill.className = 'slice-cmap-pill';
                    cmapPill.textContent = `${curCmap.charAt(0).toUpperCase() + curCmap.slice(1)} ▾`;
                    this.applyButtonStyle(cmapPill);
                    cmapPill.style.fontSize = '8.5px';
                    cmapPill.style.flex = '1';
                    cmapPill.style.padding = '2px 0';
                    cmapPill.onclick = (e) => {
                        e.stopPropagation();
                        this.showColormapPopover(cmapPill, curCmap, (newC) => {
                            this.setQuantityColormap(qty, newC);
                        });
                    };
                    cmapWrap.appendChild(cmapPill);

                    const initSliceCbShow = slice.show_colorbar === true;
                    const sliceCbBtn = this.createToggleBtn(`slice-cb-btn-${idx}`, '🎨', initSliceCbShow, (v) => {
                        this.updateSliceProperty(idx, { show_colorbar: v });
                    });
                    sliceCbBtn.style.width = '20px';
                    sliceCbBtn.title = `Toggle Color Bar for Slice #${idx + 1} in 3D Viewport`;
                    cmapWrap.appendChild(sliceCbBtn);

                    tdCmap.appendChild(cmapWrap);
                    tr.appendChild(tdCmap);

                    // Col 8: SCL (Auto, Log & Range Popover)
                    const tdScl = document.createElement('td');
                    tdScl.style.padding = '3px 2px';
                    const sclWrap = document.createElement('div');
                    sclWrap.style.display = 'flex';
                    sclWrap.style.gap = '2px';
                    
                    const interpScaleVal = slice.interpolate === true;
                    sclWrap.appendChild(this.createToggleBtn(`slice-auto-btn-${idx}`, 'A', autoScaleVal, (v) => {
                        const curRange = vpNode.parameters.quantity_ranges?.[qty] || [slice.min_val ?? 101325.0, slice.max_val ?? 1013250.0];
                        this.setQuantityRange(qty, curRange[0], curRange[1], v, logScaleVal, interpScaleVal);
                    }));
                    sclWrap.appendChild(this.createToggleBtn(`slice-log-btn-${idx}`, 'L', logScaleVal, (v) => {
                        const curRange = vpNode.parameters.quantity_ranges?.[qty] || [slice.min_val ?? 101325.0, slice.max_val ?? 1013250.0];
                        this.setQuantityRange(qty, curRange[0], curRange[1], autoScaleVal, v, interpScaleVal);
                    }));

                    const cfgBtn = this.createToggleBtn(`slice-cfg-btn-${idx}`, '⚙️', false, () => {
                        const curRange = vpNode.parameters.quantity_ranges?.[qty] || [slice.min_val ?? 101325.0, slice.max_val ?? 1013250.0];
                        this.showRangePopover(cfgBtn, qty, curRange[0], curRange[1], autoScaleVal, logScaleVal, (minV, maxV, autoVal, logVal) => {
                            this.setQuantityRange(qty, minV, maxV, autoVal, logVal);
                        });
                    });
                    sclWrap.appendChild(cfgBtn);

                    tdScl.appendChild(sclWrap);
                    tr.appendChild(tdScl);

                    // Col 9: OPACITY (Opacity Popover)
                    const tdOpac = document.createElement('td');
                    tdOpac.style.padding = '3px 4px';
                    const sliceOpac = slice.opacity ?? 1.0;
                    const opacPill = document.createElement('button');
                    opacPill.className = 'slice-opac-pill';
                    opacPill.textContent = `${Math.round(sliceOpac * 100)}% ▾`;
                    this.applyButtonStyle(opacPill);
                    opacPill.style.fontSize = '8.5px';
                    opacPill.style.width = '100%';
                    opacPill.style.padding = '2px 0';
                    opacPill.onclick = (e) => {
                        e.stopPropagation();
                        this.showOpacityPopover(opacPill, sliceOpac, (newOpac) => {
                            this.updateSliceProperty(idx, { opacity: newOpac });
                        });
                    };
                    tdOpac.appendChild(opacPill);
                    tr.appendChild(tdOpac);

                    // Col 10: Delete Button Cell
                    const tdDel = document.createElement('td');
                    tdDel.style.padding = '3px 2px';
                    tdDel.style.textAlign = 'center';
                    const delBtn = document.createElement('span');
                    delBtn.innerHTML = '✕';
                    delBtn.style.color = '#ff4444';
                    delBtn.style.cursor = 'pointer';
                    delBtn.style.fontSize = '10px';
                    delBtn.onclick = (e) => { e.stopPropagation(); this.deleteSlice(idx); };
                    tdDel.appendChild(delBtn);
                    tr.appendChild(tdDel);

                    this.sliceListContainer!.appendChild(tr);
                });

                this.needsSlicesRebuild = false;
            } else {
                // Just sync values of existing inputs in place
                const focusedSliceIndex = vpNode.parameters.focusedSliceIndex ?? 0;
                slices.forEach((slice: any, idx: number) => {
                    const row = this.sliceListContainer!.children[idx] as HTMLElement;
                    if (!row) return;

                    row.style.background = idx === focusedSliceIndex ? 'rgba(0, 173, 255, 0.12)' : 'transparent';
                    row.style.opacity = slice.enabled !== false ? '1.0' : '0.55';

                    // 1. Vis Checkbox
                    const enableCb = row.querySelector('.slice-enable-cb') as HTMLInputElement;
                    if (enableCb && enableCb.dataset.editing !== 'true' && document.activeElement !== enableCb) {
                        enableCb.checked = slice.enabled !== false;
                    }

                    // 2. Position / axis Pill
                    const bounds = getSliceBounds(slice.axis, meshNode);
                    const curOffset = Number(slice.offset ?? (bounds.min + bounds.max) / 2.0);
                    const axisLabel = getSliceAxisLabel(slice.axis);
                    const posPill = row.querySelector('.slice-pos-pill') as HTMLButtonElement;
                    if (posPill) {
                        posPill.innerHTML = `📐 <b>${axisLabel}</b> @ ${curOffset.toFixed(2)}m ▾`;
                    }

                    // 3. Edg toggle
                    const edgesBtn = document.getElementById(this.getElId(`slice-edges-btn-${idx}`));
                    this.syncToggleBtnState(edgesBtn, vpNode.parameters.cell_edges === true);

                    // 4. Int toggle
                    const interpBtn = document.getElementById(this.getElId(`slice-interp-btn-${idx}`));
                    this.syncToggleBtnState(interpBtn, slice.interpolate === true);

                    // 5. Qty Pill
                    const qty = slice.quantities?.[0] || 'pressure';
                    const qtyPill = row.querySelector('.slice-qty-pill') as HTMLButtonElement;
                    if (qtyPill) {
                        const qtyLabels: Record<string, string> = {
                            pressure: 'Press', density: 'Density', velocity: 'Speed', energy: 'Energy',
                            species1: 'Reacted', species2: 'Unreacted', species3: 'Air',
                            overpressure: 'Overpress', peak_overpressure: 'Pk Overpress', peak_impulse: 'Pk Impulse', amr_level: 'AMR Level'
                        };
                        qtyPill.textContent = `${qtyLabels[qty] || qty} ▾`;
                    }

                    // 6. Cmap Pill
                    const cmapPill = row.querySelector('.slice-cmap-pill') as HTMLButtonElement;
                    if (cmapPill) {
                        const curCmap = vpNode.parameters.quantity_colormaps?.[qty] || slice.colormap || 'rainbow';
                        cmapPill.textContent = `${curCmap.charAt(0).toUpperCase() + curCmap.slice(1)} ▾`;
                    }

                    // 7. Auto scale / Log scale toggles
                    const autoScaleVal = slice.auto_scale !== false;
                    const logScaleVal = slice.log_scale === true;

                    const autoBtn = document.getElementById(this.getElId(`slice-auto-btn-${idx}`));
                    this.syncToggleBtnState(autoBtn, autoScaleVal);

                    const logBtn = document.getElementById(this.getElId(`slice-log-btn-${idx}`));
                    this.syncToggleBtnState(logBtn, logScaleVal);

                    const cbBtn = document.getElementById(this.getElId(`slice-cb-btn-${idx}`));
                    this.syncToggleBtnState(cbBtn, slice.show_colorbar === true);

                    // 8. Opacity Pill
                    const opacPill = row.querySelector('.slice-opac-pill') as HTMLButtonElement;
                    if (opacPill) {
                        const sliceOpac = slice.opacity ?? 1.0;
                        opacPill.textContent = `${Math.round(sliceOpac * 100)}% ▾`;
                    }
                });
            }
        }

        // 4. Find connected domain mesh dimensions and configure worker
        let dimX = 1.0, dimY = 1.0, dimZ = 1.0, cellSize = 0.01;
        let xmin = 0.0, ymin = 0.0, zmin = 0.0;
        let xmax = 1.0, ymax = 1.0, zmax = 1.0;
        if (meshNode && meshNode.type === 'DomainMesh3D') {
            xmin = Number(meshNode.parameters?.xmin ?? meshNode.parameters?.x_min ?? 0.0);
            xmax = Number(meshNode.parameters?.xmax ?? meshNode.parameters?.x_max ?? 1.0);
            ymin = Number(meshNode.parameters?.ymin ?? meshNode.parameters?.y_min ?? 0.0);
            ymax = Number(meshNode.parameters?.ymax ?? meshNode.parameters?.y_max ?? 1.0);
            zmin = Number(meshNode.parameters?.zmin ?? meshNode.parameters?.z_min ?? 0.0);
            zmax = Number(meshNode.parameters?.zmax ?? meshNode.parameters?.z_max ?? 1.0);
            dimX = xmax - xmin;
            dimY = ymax - ymin;
            dimZ = zmax - zmin;
            cellSize = Number(meshNode.parameters?.cell_size ?? 0.01);
        } else {
            const targetModel = this.getCurrentModel();
            if (targetModel) {
                const femObjNodes = targetModel.nodes.filter((n: any) => n.type === 'FEMObject3D' || n.type === 'LSDynaImporter3D');
                const mpmObjNodes = targetModel.nodes.filter((n: any) => n.type === 'MPMObject3D');
                const mpmDomain = targetModel.nodes.find((n: any) => n.type === 'MPMDomain3D');
                if (mpmDomain && mpmDomain.parameters?.cell_size) {
                    cellSize = Number(mpmDomain.parameters.cell_size);
                }
                if (mpmDomain && mpmDomain.parameters?.xmin !== undefined && mpmDomain.parameters?.xmax !== undefined) {
                    xmin = Number(mpmDomain.parameters.xmin);
                    xmax = Number(mpmDomain.parameters.xmax);
                    ymin = Number(mpmDomain.parameters.ymin ?? 0.0);
                    ymax = Number(mpmDomain.parameters.ymax ?? 1.0);
                    zmin = Number(mpmDomain.parameters.zmin ?? 0.0);
                    zmax = Number(mpmDomain.parameters.zmax ?? 1.0);
                    dimX = xmax - xmin;
                    dimY = ymax - ymin;
                    dimZ = zmax - zmin;
                } else if (femObjNodes.length > 0 || mpmObjNodes.length > 0) {
                    let minX = Infinity, maxX = -Infinity;
                    let minY = Infinity, maxY = -Infinity;
                    let minZ = Infinity, maxZ = -Infinity;
                    for (const obj of [...femObjNodes, ...mpmObjNodes]) {
                        const px = Number(obj.parameters?.pos_x ?? 0.0);
                        const py = Number(obj.parameters?.pos_y ?? 0.0);
                        const pz = Number(obj.parameters?.pos_z ?? 0.0);
                        const shape = obj.parameters?.shape_type || 'Box';
                        const meshSrc = obj.parameters?.mesh_source || 'Box Generator';

                        let objMinX = px, objMaxX = px;
                        let objMinY = py, objMaxY = py;
                        let objMinZ = pz, objMaxZ = pz;

                        if (shape === 'Cylinder' || meshSrc === 'Cylinder Generator') {
                            const rad = Number(obj.parameters?.radius ?? 0.1);
                            const h = Number(obj.parameters?.height ?? obj.parameters?.length ?? obj.parameters?.size_z ?? 0.2);
                            objMinX = px - rad; objMaxX = px + rad;
                            objMinY = py - rad; objMaxY = py + rad;
                            objMinZ = pz; objMaxZ = pz + h;
                        } else if (shape === 'Sphere' || meshSrc === 'Sphere Generator') {
                            const rad = Number(obj.parameters?.radius ?? 0.1);
                            objMinX = px - rad; objMaxX = px + rad;
                            objMinY = py - rad; objMaxY = py + rad;
                            objMinZ = pz - rad; objMaxZ = pz + rad;
                        } else {
                            const lx = Number(obj.parameters?.size_x ?? obj.parameters?.length ?? 0.1);
                            const ly = Number(obj.parameters?.size_y ?? obj.parameters?.length ?? 0.1);
                            const lz = Number(obj.parameters?.size_z ?? obj.parameters?.height ?? 0.1);
                            objMinX = px; objMaxX = px + lx;
                            objMinY = py; objMaxY = py + ly;
                            objMinZ = pz; objMaxZ = pz + lz;
                        }

                        minX = Math.min(minX, objMinX);
                        maxX = Math.max(maxX, objMaxX);
                        minY = Math.min(minY, objMinY);
                        maxY = Math.max(maxY, objMaxY);
                        minZ = Math.min(minZ, objMinZ);
                        maxZ = Math.max(maxZ, objMaxZ);
                    }
                    if (isFinite(minX) && isFinite(maxX) && maxX > minX) {
                        xmin = minX; xmax = maxX;
                        ymin = minY; ymax = maxY;
                        zmin = minZ; zmax = maxZ;
                        dimX = xmax - xmin;
                        dimY = ymax - ymin;
                        dimZ = zmax - zmin;
                    }
                }
            }
        }
        const nx = Math.round(dimX / cellSize);
        const ny = Math.round(dimY / cellSize);
        const nz = Math.round(dimZ / cellSize);

        const { min: syncFocusedMin, max: syncFocusedMax } = getFocusedQuantityAndRange(vpNode);

        const qCmaps = vpNode.parameters.quantity_colormaps || {};
        const stlQty = vpNode.parameters.stl_quantity || 'pressure';
        const resStlCmap = qCmaps[stlQty] || vpNode.parameters.stl_colormap || 'rainbow';

        const obsQty = vpNode.parameters.obstacles_quantity || 'pressure';
        const resObsCmap = qCmaps[obsQty] || vpNode.parameters.obstacles_colormap || 'rainbow';

        const resSlices = (vpNode.parameters.slices || []).map((s: any) => {
            const q = s.quantities?.[0] || 'pressure';
            return { ...s, colormap: qCmaps[q] || s.colormap || 'rainbow' };
        });

        const targetModel = this.getCurrentModel();
        const hasCFDSolver = targetModel ? targetModel.nodes.some((n: any) => n.type === 'CFDSolver3D' || n.type === 'FSICoupler3D' || n.type === 'FEMFSICoupler3D') : false;

        const configData: any = {
            hasCFDSolver: hasCFDSolver,
            meshType: solverNode?.parameters?.mesh_type || 'regular',
            colormap: vpNode.parameters.colormap || 'rainbow',
            minY: syncFocusedMin,
            maxY: syncFocusedMax,
            autoScale: vpNode.parameters.auto_scale !== false,
            showGrid: this.isGridEnabled(vpNode),
            showGridBox: this.isGridBoxEnabled(vpNode),
            useLogScale: vpNode.parameters.log_scale === true,
            showCellEdges: vpNode.parameters.cell_edges === true,
            interpolate: vpNode.parameters.interpolate === true,
            showSTL: vpNode.parameters.show_stl !== false,
            stlWireframe: !!vpNode.parameters.stl_wireframe,
            stlSolids: vpNode.parameters.stl_solids !== false,
            stlOpacity: vpNode.parameters.stl_opacity ?? 0.5,
            stlColormap: resStlCmap,
            stlShowResults: vpNode.parameters.stl_show_results !== false,
            stlQuantity: stlQty,
            stlSamplingMode: vpNode.parameters.stl_sampling_mode || 'nearest',
            stlAutoScale: vpNode.parameters.stl_auto_scale !== false,
            stlLogScale: vpNode.parameters.stl_log_scale === true,
            stlMinVal: vpNode.parameters.stl_min_val ?? 101325.0,
            stlMaxVal: vpNode.parameters.stl_max_val ?? 1013250.0,
            slices: resSlices,
            showSlices: vpNode.parameters.show_slices !== false,
            focusedSliceIndex: vpNode.parameters.focusedSliceIndex ?? 0,
            sliceOpacities: (resSlices || []).map((s: any) => s.opacity !== undefined ? s.opacity : 1.0),
            lightingEnabled: vpNode.parameters.lightingEnabled !== false,
            aoEnabled: vpNode.parameters.aoEnabled !== false,
            aoRadius: Number(vpNode.parameters.aoRadius ?? 0.15),
            aoIntensity: Number(vpNode.parameters.aoIntensity ?? 1.2),
            aoBias: Number(vpNode.parameters.aoBias ?? 0.005),
            aoSphereImpostor: vpNode.parameters.aoSphereImpostor !== false,
            ambientLevel: vpNode.parameters.ambientLevel ?? 0.3,
            specularIntensity: vpNode.parameters.specularIntensity ?? 0.4,
            quantityColormaps: qCmaps,
            quantityRanges: vpNode.parameters.quantity_ranges || {},
            showObstacles: vpNode.parameters.show_obstacles !== false,
            obstaclesGridlines: vpNode.parameters.obstacles_gridlines !== false,
            obstaclesLighting: vpNode.parameters.obstacles_lighting !== false,
            obstaclesOpacity: vpNode.parameters.obstacles_opacity ?? 1.0,
            obstaclesQuantity: obsQty,
            obstaclesColormap: resObsCmap,
            showFEMMesh: vpNode.parameters.showFEMMesh !== false,
            femSolid: vpNode.parameters.femSolid !== false,
            femWireframe: vpNode.parameters.femWireframe !== false,
            femResults: vpNode.parameters.femResults !== false,
            femQuantity: vpNode.parameters.femQuantity || 'vonMises',
            femColormap: vpNode.parameters.femColormap || 'rainbow',
            femAutoScale: vpNode.parameters.femAutoScale !== false,
            femLogScale: vpNode.parameters.femLogScale === true,
            femOpacity: vpNode.parameters.femOpacity ?? 1.0,
            femMinVal: vpNode.parameters.femMinVal ?? 0.0,
            femMaxVal: vpNode.parameters.femMaxVal ?? 500.0e6
        };

        configData.xmin = xmin;
        configData.xmax = xmax;
        configData.ymin = ymin;
        configData.ymax = ymax;
        configData.zmin = zmin;
        configData.zmax = zmax;

        const cachedConfig = this.stateManager.getTelemetry(vpNode.id + "-config-3d");
        if (cachedConfig) {
            this.hasTelemetryGrid = true;
            configData.dx = cachedConfig.dx ?? cellSize;
            configData.dy = cachedConfig.dy ?? (dimY / (ny || 1));
            configData.dz = cachedConfig.dz ?? (dimZ / (nz || 1));
            configData.nx = cachedConfig.nx ?? nx;
            configData.ny = cachedConfig.ny ?? ny;
            configData.nz = cachedConfig.nz ?? nz;
        } else {
            configData.dx = cellSize;
            configData.dy = dimY / (ny || 1);
            configData.dz = dimZ / (nz || 1);
            configData.nx = nx;
            configData.ny = ny;
            configData.nz = nz;
        }

        if (postToWorker) {
            this.worker.postMessage({
                type: 'setConfig',
                data: configData
            });
        }
    }

    public getCurrentModelId(): string | null {
        if (this.viewportNodeId) {
            const allModels = this.stateManager.getAllModels();
            const matchedModel = allModels.find(m => m.id === this.viewportNodeId);
            if (matchedModel) return matchedModel.id;
            for (const m of allModels) {
                if (m.nodes.some(n => n.id === this.viewportNodeId)) {
                    return m.id;
                }
            }
            return this.viewportNodeId;
        }
        const ws = this.stateManager.getActiveWorkspace();
        return ws ? ws.activeModelId : null;
    }

    public isGridBoxEnabled(vpNode: any): boolean {
        if (!vpNode || !vpNode.parameters) return true;
        return vpNode.parameters.show_grid_box !== false;
    }

    public isGridEnabled(vpNode: any): boolean {
        if (!vpNode || !vpNode.parameters) return true;
        return vpNode.parameters.show_grid !== false;
    }

    public getCurrentModel(): any {
        const modelId = this.getCurrentModelId();
        if (!modelId) return null;
        return this.stateManager.getAllModels().find(m => m.id === modelId) || null;
    }

    public isFEMOnlyModel(): boolean {
        const model = this.getCurrentModel();
        if (model) {
            const hasFEM = model.nodes.some((n: any) => n.type === 'FEMDomain3D');
            const hasCFD = model.nodes.some((n: any) => n.type === 'CFDSolver3D');
            const hasMPM = model.nodes.some((n: any) => n.type === 'MPMDomain3D');
            return hasFEM && !hasCFD && !hasMPM;
        }
        return false;
    }

    public pushFrame(buffer: ArrayBuffer, modelId?: string) {
        if (this.container && !this.container.isConnected && this.container.offsetWidth === 0) return;
        if (modelId) {
            const currentId = this.getCurrentModelId();
            if (this.viewportNodeId) {
                if (currentId && currentId !== modelId && this.viewportNodeId !== modelId) {
                    return;
                }
            } else {
                const activeWs = this.stateManager.getActiveWorkspace();
                if (activeWs && activeWs.modelIds && !activeWs.modelIds.includes(modelId)) {
                    return;
                }
            }
        }
        const magic = buffer.byteLength >= 4 ? new DataView(buffer).getUint32(0, true) : 0;
        if (this.isWorkerBusy) {
            this.pendingFrames.set(magic, { buffer, modelId });
            return;
        }
        this.isWorkerBusy = true;
        if (this.workerTimer) clearTimeout(this.workerTimer);
        this.workerTimer = setTimeout(() => {
            if (this.isWorkerBusy) {
                console.warn("[Telemetry3DViewport] Worker timeout detected, resetting busy flag");
                this.isWorkerBusy = false;
                this.drainNextPendingFrame();
            }
        }, 1500);
        const bufToSend = buffer.slice(0);
        this.worker.postMessage({ type: 'frame', data: { buffer: bufToSend } }, [bufToSend]);
    }

    private drainNextPendingFrame() {
        if (this.pendingFrames.size > 0) {
            const firstKey = this.pendingFrames.keys().next().value;
            if (firstKey !== undefined) {
                const next = this.pendingFrames.get(firstKey);
                this.pendingFrames.delete(firstKey);
                if (next) {
                    this.pushFrame(next.buffer, next.modelId);
                }
            }
        }
    }

    public resetSimulationData(modelId?: string) {
        if (modelId) {
            if (this.viewportNodeId) {
                if (this.getCurrentModelId() !== modelId && this.viewportNodeId !== modelId) return;
            } else {
                const activeWs = this.stateManager.getActiveWorkspace();
                if (activeWs && activeWs.modelIds && !activeWs.modelIds.includes(modelId)) return;
            }
        }
        this.worker.postMessage({ type: 'resetSimulationData' });
    }

    public updateTelemetry(data: any, modelId?: string) {
        if (modelId) {
            if (this.viewportNodeId) {
                if (this.getCurrentModelId() !== modelId && this.viewportNodeId !== modelId) return;
            } else {
                const activeWs = this.stateManager.getActiveWorkspace();
                if (activeWs && activeWs.modelIds && !activeWs.modelIds.includes(modelId)) return;
            }
        }
        if (data && (data.type === 'TELEMETRY_3D' || data.type === 'TELEMETRY_FEM_3D')) {
            this.hasTelemetryGrid = true;
            const xmin = data.xmin ?? 0.0;
            const ymin = data.ymin ?? 0.0;
            const zmin = data.zmin ?? 0.0;
            const dx = data.dx ?? data.cell_size ?? 0.01;
            const nx = data.nx ?? 64;
            const ny = data.ny ?? 64;
            const nz = data.nz ?? 64;
            const gridKey = `${xmin}_${ymin}_${zmin}_${dx}_${nx}_${ny}_${nz}`;
            if (gridKey !== this.lastTelemetryGridKey) {
                this.lastTelemetryGridKey = gridKey;
                this.worker.postMessage({
                    type: 'setConfig',
                    data: {
                        xmin,
                        ymin,
                        zmin,
                        xmax: xmin + nx * dx,
                        ymax: ymin + ny * dx,
                        zmax: zmin + nz * dx,
                        dx,
                        nx,
                        ny,
                        nz
                    }
                });
            }
        }
    }

    public attachTo(container: HTMLElement) {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        this.container = container;
        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';

        if (this.canvas.parentNode !== this.container) {
            this.container.appendChild(this.canvas);
        }
        if (this.overlayCanvas && this.overlayCanvas.parentNode !== this.container) {
            this.container.appendChild(this.overlayCanvas);
        }
        if (this.controlsOverlay && this.controlsOverlay.parentNode !== this.container) {
            this.container.appendChild(this.controlsOverlay);
        }
        if (this.bottomViewDock && this.bottomViewDock.parentNode !== this.container) {
            this.container.appendChild(this.bottomViewDock);
        }
        if (this.floatOpenBtn && this.floatOpenBtn.parentNode !== this.container) {
            this.container.appendChild(this.floatOpenBtn);
        }
        if (this.debugOverlay && this.debugOverlay.parentNode !== this.container) {
            this.container.appendChild(this.debugOverlay);
        }
        if (this.colorbarContainer && this.colorbarContainer.parentNode !== this.container) {
            this.container.appendChild(this.colorbarContainer);
        }

        const vpNode = this.getViewportNode();
        this.syncColorbarOverlay(vpNode || { parameters: {} });

        if (this.resizeObserver) {
            this.resizeObserver.observe(this.container);
        }

        this.triggerResize();
        requestAnimationFrame(this.triggerResize);
        setTimeout(this.triggerResize, 100);
        setTimeout(this.triggerResize, 500);
    }

    private buildSTLControls(parent: HTMLElement) {
        // Show STL Mesh checkbox
        const showRow = document.createElement('label');
        showRow.style.display = 'flex';
        showRow.style.alignItems = 'center';
        showRow.style.gap = '6px';
        showRow.style.cursor = 'pointer';
        
        const showCb = document.createElement('input');
        showCb.type = 'checkbox';
        showCb.id = this.getElId('viewport-stl-show-cb');
        showCb.onchange = () => {
            const vpNode = this.getViewportNode();
            if (vpNode) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, { show_stl: showCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { showSTL: showCb.checked } });
            }
        };
        showRow.appendChild(showCb);
        showRow.appendChild(document.createTextNode('Show STL Mesh'));
        parent.appendChild(showRow);

        // Wireframe toggle
        const wfRow = document.createElement('label');
        wfRow.style.display = 'flex';
        wfRow.style.alignItems = 'center';
        wfRow.style.gap = '6px';
        wfRow.style.cursor = 'pointer';
        
        const wfCb = document.createElement('input');
        wfCb.type = 'checkbox';
        wfCb.id = this.getElId('viewport-stl-wf-cb');
        wfCb.onchange = () => {
            const vpNode = this.getViewportNode();
            if (vpNode) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, { stl_wireframe: wfCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { stlWireframe: wfCb.checked } });
            }
        };
        wfRow.appendChild(wfCb);
        wfRow.appendChild(document.createTextNode('Show Wireframe'));
        parent.appendChild(wfRow);

        // Solids toggle
        const solidsRow = document.createElement('label');
        solidsRow.style.display = 'flex';
        solidsRow.style.alignItems = 'center';
        solidsRow.style.gap = '6px';
        solidsRow.style.cursor = 'pointer';
        
        const solidsCb = document.createElement('input');
        solidsCb.type = 'checkbox';
        solidsCb.id = this.getElId('viewport-stl-solids-cb');
        solidsCb.onchange = () => {
            const vpNode = this.getViewportNode();
            if (vpNode) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, { stl_solids: solidsCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { stlSolids: solidsCb.checked } });
            }
        };
        solidsRow.appendChild(solidsCb);
        solidsRow.appendChild(document.createTextNode('Show Solids'));
        parent.appendChild(solidsRow);

        // Opacity Slider
        const opacWrap = document.createElement('div');
        opacWrap.style.display = 'flex';
        opacWrap.style.flexDirection = 'column';
        opacWrap.style.gap = '2px';
        
        const opacLabel = document.createElement('span');
        opacLabel.style.fontSize = '8px';
        opacLabel.style.color = '#aaa';
        
        const opacSlider = document.createElement('input');
        opacSlider.type = 'range';
        opacSlider.id = this.getElId('viewport-stl-opacity-slider');
        opacSlider.min = '0';
        opacSlider.max = '1';
        opacSlider.step = '0.05';
        opacSlider.style.width = '100%';
        opacSlider.oninput = () => {
            opacLabel.innerHTML = `Opacity: ${Number(opacSlider.value).toFixed(2)}`;
            const vpNode = this.getViewportNode();
            if (vpNode) {
                this.stateManager.updateNodeParametersInPlace(vpNode.id, { stl_opacity: Number(opacSlider.value) });
                this.worker.postMessage({ type: 'setConfig', data: { stlOpacity: Number(opacSlider.value) } });
            }
        };
        opacWrap.appendChild(opacLabel);
        opacWrap.appendChild(opacSlider);
        parent.appendChild(opacWrap);
    }

    private buildObstacleControls(parent: HTMLElement) {
        const vpNode = this.getViewportNode();
        const initShow = vpNode ? (vpNode.parameters.show_obstacles !== false) : true;
        const initGrid = vpNode ? (vpNode.parameters.obstacles_gridlines !== false) : true;
        const initLight = vpNode ? (vpNode.parameters.obstacles_lighting !== false) : true;
        const initOpacity = vpNode ? (vpNode.parameters.obstacles_opacity ?? 1.0) : 1.0;
        const initQty = vpNode ? (vpNode.parameters.obstacles_quantity || 'pressure') : 'pressure';

        // Show Obstacles toggle
        const showRow = document.createElement('label');
        showRow.style.display = 'flex';
        showRow.style.alignItems = 'center';
        showRow.style.gap = '6px';
        showRow.style.cursor = 'pointer';

        const showCb = document.createElement('input');
        showCb.type = 'checkbox';
        showCb.id = this.getElId('viewport-obs-show-cb');
        showCb.checked = initShow;
        showCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { show_obstacles: showCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { showObstacles: showCb.checked } });
                // Re-send slices config because the virtual obstacles slice is appended dynamically based on show_obstacles
                const net = (window as any).networkManager;
                if (net && net.isConnected()) {
                    let targetModelId = vp.id;
                    const models = this.stateManager.getAppState().models;
                    for (const [mid, m] of Object.entries(models)) {
                        if (m.nodes.some(n => n.id === vp.id)) {
                            targetModelId = mid;
                            break;
                        }
                    }
                    const obstaclesQuantity = vp.parameters.obstacles_quantity || 'pressure';
                    const slices = [...(vp.parameters.slices || [])];
                    if (showCb.checked) {
                        slices.push({
                            axis: 'obstacles',
                            offset: 0.0,
                            quantities: [obstaclesQuantity],
                            stride: 1
                        });
                    }
                    net.send({
                        command: "VIEW3D_CONFIG",
                        modelId: targetModelId,
                        slices: slices,
                        refresh_rate: Number(vp.parameters.refresh_rate ?? 0.5)
                    });
                }
                this.syncControls(true);
            }
        };
        this.bindEditingEvents(showCb);
        showRow.appendChild(showCb);
        showRow.appendChild(document.createTextNode('Show Obstacles'));
        parent.appendChild(showRow);

        // Gridlines toggle
        const gridRow = document.createElement('label');
        gridRow.style.display = 'flex';
        gridRow.style.alignItems = 'center';
        gridRow.style.gap = '6px';
        gridRow.style.cursor = 'pointer';

        const gridCb = document.createElement('input');
        gridCb.type = 'checkbox';
        gridCb.id = this.getElId('viewport-obs-grid-cb');
        gridCb.checked = initGrid;
        gridCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { obstacles_gridlines: gridCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { obstaclesGridlines: gridCb.checked } });
            }
        };
        this.bindEditingEvents(gridCb);
        gridRow.appendChild(gridCb);
        gridRow.appendChild(document.createTextNode('Show Gridlines'));
        parent.appendChild(gridRow);

        // Lighting toggle
        const lightRow = document.createElement('label');
        lightRow.style.display = 'flex';
        lightRow.style.alignItems = 'center';
        lightRow.style.gap = '6px';
        lightRow.style.cursor = 'pointer';

        const lightCb = document.createElement('input');
        lightCb.type = 'checkbox';
        lightCb.id = this.getElId('viewport-obs-light-cb');
        lightCb.checked = initLight;
        lightCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { obstacles_lighting: lightCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { obstaclesLighting: lightCb.checked } });
            }
        };
        this.bindEditingEvents(lightCb);
        lightRow.appendChild(lightCb);
        lightRow.appendChild(document.createTextNode('Enable Lighting'));
        parent.appendChild(lightRow);

        // Quantity selector
        const qtyRow = document.createElement('div');
        qtyRow.style.display = 'flex';
        qtyRow.style.justifyContent = 'space-between';
        qtyRow.style.alignItems = 'center';
        qtyRow.style.gap = '6px';
        qtyRow.style.width = '100%';
        qtyRow.style.boxSizing = 'border-box';
        qtyRow.style.marginTop = '4px';
        qtyRow.innerHTML = '<span style="font-size:11px;color:#aaa;flex-shrink:0;">Quantity</span>';

        const qtySel = document.createElement('select');
        qtySel.id = this.getElId('viewport-obs-qty-sel');
        this.applySelectStyle(qtySel);
        qtySel.style.flex = '1';
        qtySel.style.minWidth = '0';
        const isIdeal = this.isIdealGas();
        const obsSpeciesOpts = !isIdeal ? '<option value="species1">Reacted (Alpha1)</option><option value="species2">Unreacted (Alpha2)</option><option value="species3">Air</option>' : '';
        qtySel.innerHTML = `<option value="pressure">Pressure</option><option value="density">Density</option><option value="velocity">Speed</option><option value="energy">Energy</option>${obsSpeciesOpts}<option value="peak_overpressure">Peak Overpressure</option><option value="peak_impulse">Peak Impulse</option>`;
        qtySel.value = initQty;
        qtySel.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { obstacles_quantity: qtySel.value });
                this.worker.postMessage({ type: 'setConfig', data: { obstaclesQuantity: qtySel.value } });
                // Re-send slice config so backend starts extracting the new quantity
                const net = (window as any).networkManager;
                if (net && net.isConnected()) {
                    let targetModelId = vp.id;
                    const models = this.stateManager.getAppState().models;
                    for (const [mid, m] of Object.entries(models)) {
                        if (m.nodes.some(n => n.id === vp.id)) {
                            targetModelId = mid;
                            break;
                        }
                    }
                    const showObstacles = vp.parameters.show_obstacles !== false;
                    const slices = [...(vp.parameters.slices || [])];
                    if (showObstacles) {
                        slices.push({
                            axis: 'obstacles',
                            offset: 0.0,
                            quantities: [qtySel.value],
                            stride: 1
                        });
                    }
                    net.send({
                        command: "VIEW3D_CONFIG",
                        modelId: targetModelId,
                        slices: slices,
                        refresh_rate: Number(vp.parameters.refresh_rate ?? 0.5)
                    });
                }
                this.syncControls(true);
            }
        };
        this.bindEditingEvents(qtySel);
        qtyRow.appendChild(qtySel);
        parent.appendChild(qtyRow);

        // Opacity Slider
        const opacWrap = document.createElement('div');
        opacWrap.style.display = 'flex';
        opacWrap.style.flexDirection = 'column';
        opacWrap.style.gap = '2px';
        opacWrap.style.marginTop = '4px';

        const opacLabel = document.createElement('span');
        opacLabel.style.fontSize = '8px';
        opacLabel.style.color = '#aaa';
        opacLabel.innerHTML = `Opacity: ${Number(initOpacity).toFixed(2)}`;

        const opacSlider = document.createElement('input');
        opacSlider.type = 'range';
        opacSlider.id = this.getElId('viewport-obs-opacity-slider');
        opacSlider.min = '0';
        opacSlider.max = '1';
        opacSlider.step = '0.05';
        opacSlider.style.width = '100%';
        opacSlider.value = String(initOpacity);
        opacSlider.oninput = () => {
            opacLabel.innerHTML = `Opacity: ${Number(opacSlider.value).toFixed(2)}`;
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { obstacles_opacity: Number(opacSlider.value) });
                this.worker.postMessage({ type: 'setConfig', data: { obstaclesOpacity: Number(opacSlider.value) } });
            }
        };
        this.bindEditingEvents(opacSlider);
        opacWrap.appendChild(opacLabel);
        opacWrap.appendChild(opacSlider);
        parent.appendChild(opacWrap);
    }

    private getSTLFilePath(): string | null {
        const vpNode = this.getViewportNode();
        if (!vpNode) return null;

        const allModels = this.stateManager.getAllModels();
        let targetModel: any = null;
        const currentModelId = this.getCurrentModelId();
        if (currentModelId) {
            targetModel = allModels.find(m => m.id === currentModelId) || null;
        }
        if (!targetModel) {
            for (const m of Object.values(allModels)) {
                if (m.nodes.some(n => n.id === vpNode.id)) {
                    targetModel = m;
                    break;
                }
            }
        }
        if (!targetModel) return null;

        const connToViewport = targetModel.connections.find((c: any) => c.toNode === vpNode.id);
        if (connToViewport) {
            const solverNode = targetModel.nodes.find((n: any) => n.id === connToViewport.fromNode);
            if (solverNode && solverNode.type === 'CFDSolver3D') {
                const connToSolver = targetModel.connections.find((c: any) => c.toNode === solverNode.id && c.toPort === 'stl');
                if (connToSolver) {
                    const stlNode = targetModel.nodes.find((n: any) => n.id === connToSolver.fromNode);
                    if (stlNode && stlNode.type === 'STLGeometry') {
                        return stlNode.parameters.stl_file || null;
                    }
                }
            }
        }
        const fallbackStlNode = targetModel.nodes.find((n: any) => n.type === 'STLGeometry');
        if (fallbackStlNode) {
            return fallbackStlNode.parameters.stl_file || null;
        }
        return null;
    }

    private getGeometryNode(): Node | null {
        const vpNode = this.getViewportNode();
        const allModels = this.stateManager.getAllModels();
        let targetModel: any = null;

        const currentModelId = this.getCurrentModelId();
        if (currentModelId) {
            targetModel = allModels.find(m => m.id === currentModelId) || null;
        }
        if (!targetModel && vpNode) {
            for (const m of Object.values(allModels)) {
                if (m.nodes.some(n => n.id === vpNode.id)) {
                    targetModel = m;
                    break;
                }
            }
        }
        if (!targetModel && this.viewportNodeId) {
            targetModel = allModels.find(m => m.id === this.viewportNodeId) || null;
        }
        if (!targetModel) {
            const ws = this.stateManager.getActiveWorkspace();
            if (ws && ws.activeModelId) {
                targetModel = allModels.find(m => m.id === ws.activeModelId) || null;
            }
        }
        if (!targetModel) return null;

        const findUpstreamGeom = (nodeId: string, visited = new Set<string>()): Node | null => {
            if (visited.has(nodeId)) return null;
            visited.add(nodeId);
            const inConns = targetModel.connections.filter((c: any) => c.toNode === nodeId);
            for (const conn of inConns) {
                const parent = targetModel.nodes.find((n: any) => n.id === conn.fromNode);
                if (parent) {
                    if (parent.type === 'STLGeometry' || parent.type === 'PrimitiveGeometry3D') {
                        return parent;
                    }
                    const found = findUpstreamGeom(parent.id, visited);
                    if (found) return found;
                }
            }
            return null;
        };

        if (vpNode) {
            const found = findUpstreamGeom(vpNode.id);
            if (found) return found;
        }

        const geomNode = targetModel.nodes.find((n: any) => n.type === 'STLGeometry' || n.type === 'PrimitiveGeometry3D');
        if (geomNode) return geomNode;

        return null;
    }

    private getVirtualGauges(): any[] {
        const vpNode = this.getViewportNode();
        if (!vpNode) return [];

        const allModels = this.stateManager.getAllModels();
        let targetModel: any = null;
        const currentModelId = this.getCurrentModelId();
        if (currentModelId) {
            targetModel = allModels.find(m => m.id === currentModelId) || null;
        }
        if (!targetModel && vpNode) {
            for (const m of Object.values(allModels)) {
                if (m.nodes.some(n => n.id === vpNode.id)) {
                    targetModel = m;
                    break;
                }
            }
        }
        if (!targetModel) {
            const ws = this.stateManager.getActiveWorkspace();
            if (ws && ws.activeModelId) {
                targetModel = allModels.find(m => m.id === ws.activeModelId) || null;
            }
        }
        if (!targetModel) return [];

        const vgNode = targetModel.nodes.find((n: any) => n.type === 'VirtualGauges');
        if (vgNode && vgNode.parameters?.gauges && Array.isArray(vgNode.parameters.gauges)) {
            return vgNode.parameters.gauges;
        }

        return [];
    }

    private buildGaugeControls(parent: HTMLElement) {
        const vpNode = this.getViewportNode();
        const initShow = vpNode ? (vpNode.parameters.show_gauges !== false) : true;
        const initSize = vpNode ? (vpNode.parameters.gauge_size ?? 0.03) : 0.03;

        // Show Gauges toggle
        const showRow = document.createElement('label');
        showRow.style.display = 'flex';
        showRow.style.alignItems = 'center';
        showRow.style.gap = '6px';
        showRow.style.cursor = 'pointer';

        const showCb = document.createElement('input');
        showCb.type = 'checkbox';
        showCb.id = this.getElId('viewport-gauges-show-cb');
        showCb.checked = initShow;
        showCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { show_gauges: showCb.checked });
                const gauges = this.getVirtualGauges();
                this.worker.postMessage({ type: 'setConfig', data: { showGauges: showCb.checked, gauges } });
            }
        };
        showRow.appendChild(showCb);
        showRow.appendChild(document.createTextNode('Show Gauge Locations'));
        parent.appendChild(showRow);

        // Gauge Size Slider
        const sizeWrap = document.createElement('div');
        sizeWrap.style.display = 'flex';
        sizeWrap.style.flexDirection = 'column';
        sizeWrap.style.gap = '2px';

        const sizeLabel = document.createElement('span');
        sizeLabel.style.fontSize = '8px';
        sizeLabel.style.color = '#aaa';
        sizeLabel.innerHTML = `Marker Size: ${Number(initSize).toFixed(3)}`;

        const sizeSlider = document.createElement('input');
        sizeSlider.type = 'range';
        sizeSlider.id = this.getElId('viewport-gauge-size-slider');
        sizeSlider.min = '0.005';
        sizeSlider.max = '0.2';
        sizeSlider.step = '0.005';
        sizeSlider.style.width = '100%';
        sizeSlider.value = String(initSize);
        sizeSlider.oninput = () => {
            sizeLabel.innerHTML = `Marker Size: ${Number(sizeSlider.value).toFixed(3)}`;
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { gauge_size: Number(sizeSlider.value) });
                this.worker.postMessage({ type: 'setConfig', data: { gaugeSize: Number(sizeSlider.value) } });
            }
        };
        sizeWrap.appendChild(sizeLabel);
        sizeWrap.appendChild(sizeSlider);
        parent.appendChild(sizeWrap);
    }

    private bindEditingEvents(el: HTMLElement, onAction?: () => void) {
        el.addEventListener('focus', () => { el.dataset.editing = 'true'; });
        el.addEventListener('mousedown', () => { el.dataset.editing = 'true'; });
        el.addEventListener('blur', () => { delete el.dataset.editing; });
        el.addEventListener('change', () => {
            delete el.dataset.editing;
            if (onAction) onAction();
        });
    }

    public setSTLGeometry(vertices: Float32Array | null, modelId?: string, meshId: string = 'default'): void {
        if (modelId) {
            const myModelId = this.getCurrentModelId();
            if (myModelId && myModelId !== modelId) return;
        }
        this.cachedSTL = { vertices, meshId };
        if (this.debugOverlay) {
            this.debugOverlay.innerHTML = `Load STL: OK (${(vertices ? vertices.length / 3 : 0).toFixed(0)} verts, mesh: ${meshId})`;
        }
        this.worker.postMessage({
            type: 'setSTLGeometry',
            data: { vertices, meshId }
        });
    }

    public setObstaclesGeometry(vertices: Float32Array | null, cells: Int32Array | null, modelId?: string, meshId: string = 'default'): void {
        if (modelId) {
            const myModelId = this.getCurrentModelId();
            if (myModelId && myModelId !== modelId) return;
        }
        this.cachedObstacles = { vertices, cells, meshId };
        this.worker.postMessage({
            type: 'setObstaclesGeometry',
            data: { vertices, cells, meshId }
        });
    }


    public destroy() {
        if (this.windowResizeHandler) {
            window.removeEventListener('resize', this.windowResizeHandler);
            this.windowResizeHandler = null;
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.stateListener) {
            this.stateManager.offStateChange(this.stateListener);
        }
        if (this.modelStatusListener) {
            this.stateManager.offModelStatusChange(this.modelStatusListener);
            this.modelStatusListener = null;
        }
        const net = (window as any).networkManager;
        if (net) {
            if (this.netCallback) net.offMessage(this.netCallback);
            if (this.openListener) net.offOpen(this.openListener);
        }
        this.worker.terminate();
        this.canvas.remove();
        if (this.overlayCanvas) this.overlayCanvas.remove();
        if (this.controlsOverlay) this.controlsOverlay.remove();
        if (this.bottomViewDock) this.bottomViewDock.remove();
        if (this.floatOpenBtn) this.floatOpenBtn.remove();
        if (this.colorbarContainer) this.colorbarContainer.remove();
    }

    private syncProjectionButtons() {
        const hudBtn = document.getElementById(this.getElId('viewport-hud-proj-btn'));
        if (hudBtn) {
            hudBtn.innerHTML = this.usePerspective ? '👁️ Persp' : '📐 Ortho';
        }
        const cardBtn = document.getElementById(this.getElId('viewport-card-proj-btn'));
        if (cardBtn) {
            cardBtn.innerHTML = this.usePerspective ? '👁️ Perspective' : '📐 Orthographic';
        }
    }

    private alignCamera(val: string) {
        const v = val.toLowerCase().trim();
        let pitch = 0.0;
        let yaw = 0.0;
        if (v === 'top' || v === '+z') {
            pitch = Math.PI / 2;
            yaw = Math.PI;
        } else if (v === 'bottom' || v === '-z') {
            pitch = -Math.PI / 2;
            yaw = Math.PI;
        } else if (v === 'front' || v === '-y') {
            pitch = 0.0;
            yaw = Math.PI;
        } else if (v === 'back' || v === '+y') {
            pitch = 0.0;
            yaw = 0.0;
        } else if (v === 'left' || v === '-x') {
            pitch = 0.0;
            yaw = -Math.PI / 2;
        } else if (v === 'right' || v === '+x') {
            pitch = 0.0;
            yaw = Math.PI / 2;
        } else if (v === 'iso') {
            pitch = 0.42;
            yaw = 2.356;
        }

        this.worker.postMessage({
            type: 'setView',
            data: { pitch, yaw }
        });
    }

    private createDockSeparator(): HTMLElement {
        const sep = document.createElement('div');
        sep.style.width = '1px';
        sep.style.height = '16px';
        sep.style.background = 'rgba(255, 255, 255, 0.15)';
        sep.style.margin = '0 3px';
        return sep;
    }

    private buildFloatingViewHUD() {
        // Floating top HUD replaced by single-level bottom view dock
    }

    private buildBottomControlsDock() {
        this.bottomViewDock = document.createElement('div');
        this.bottomViewDock.style.position = 'absolute';
        this.bottomViewDock.style.bottom = '8px';
        this.bottomViewDock.style.left = '8px';
        this.bottomViewDock.style.right = '8px';
        this.bottomViewDock.style.display = 'flex';
        this.bottomViewDock.style.flexWrap = 'wrap';
        this.bottomViewDock.style.alignItems = 'center';
        this.bottomViewDock.style.justifyContent = 'space-between';
        this.bottomViewDock.style.gap = '4px 6px';
        this.bottomViewDock.style.background = 'rgba(16, 16, 19, 0.90)';
        this.bottomViewDock.style.backdropFilter = 'blur(14px)';
        this.bottomViewDock.style.border = '1px solid rgba(255, 255, 255, 0.12)';
        this.bottomViewDock.style.borderRadius = '6px';
        this.bottomViewDock.style.padding = '4px 8px';
        this.bottomViewDock.style.zIndex = '12';
        this.bottomViewDock.style.boxShadow = '0 6px 20px rgba(0, 0, 0, 0.6)';
        this.bottomViewDock.style.color = '#e0e0e0';
        this.bottomViewDock.style.fontFamily = 'system-ui, -apple-system, sans-serif';
        this.bottomViewDock.style.fontSize = '10.5px';
        this.bottomViewDock.style.pointerEvents = 'auto';
        this.container.appendChild(this.bottomViewDock);

        // Group 1: Camera & View Presets
        const cameraGroup = document.createElement('div');
        cameraGroup.style.display = 'flex';
        cameraGroup.style.alignItems = 'center';
        cameraGroup.style.gap = '3px';

        const resetBtn = document.createElement('button');
        resetBtn.innerHTML = '🏠 Reset';
        this.applyButtonStyle(resetBtn);
        resetBtn.style.padding = '2px 6px';
        resetBtn.title = 'Reset view angle & zoom';
        resetBtn.onclick = () => {
            this.worker.postMessage({
                type: 'setView',
                data: { pitch: 0.42, yaw: 2.356, distance: 1.35, targetX: 0.0, targetY: 0.0, targetZ: 0.0 }
            });
        };
        cameraGroup.appendChild(resetBtn);

        const projBtn = document.createElement('button');
        projBtn.id = this.getElId('viewport-dock-proj-btn');
        projBtn.innerHTML = this.usePerspective ? '👁️ Persp' : '📐 Ortho';
        this.applyButtonStyle(projBtn);
        projBtn.style.padding = '2px 6px';
        projBtn.title = 'Toggle Perspective / Orthographic projection';
        projBtn.onclick = () => this.setProjection(!this.usePerspective);
        cameraGroup.appendChild(projBtn);

        const views = [
            { name: 'Top', val: 'top' },
            { name: 'Bottom', val: 'bottom' },
            { name: 'Front', val: 'front' },
            { name: 'Back', val: 'back' },
            { name: 'Left', val: 'left' },
            { name: 'Right', val: 'right' },
            { name: 'Iso', val: 'iso' }
        ];
        views.forEach(v => {
            const btn = document.createElement('button');
            btn.innerHTML = v.name;
            this.applyButtonStyle(btn);
            btn.style.padding = '2px 5px';
            btn.onclick = () => this.alignCamera(v.val);
            cameraGroup.appendChild(btn);
        });

        this.bottomViewDock.appendChild(cameraGroup);

        // Separator
        this.bottomViewDock.appendChild(this.createDockSeparator());

        // Group 2: Quick Toggle Chips
        const layerGroup = document.createElement('div');
        layerGroup.style.display = 'flex';
        layerGroup.style.alignItems = 'center';
        layerGroup.style.gap = '3px';

        const createToggleChip = (idSuffix: string, label: string, title: string, onClick: (active: boolean) => void) => {
            const btn = document.createElement('button');
            btn.id = this.getElId(`viewport-chip-${idSuffix}`);
            btn.innerHTML = label;
            btn.title = title;
            this.applyButtonStyle(btn);
            btn.style.padding = '2px 6px';
            btn.onclick = () => {
                const vpNode = this.getViewportNode();
                if (!vpNode) return;
                const curState = btn.dataset.active === 'true';
                onClick(!curState);
            };
            return btn;
        };

        layerGroup.appendChild(createToggleChip('slices', '🥞 Slices', 'Toggle Slices', (active) => {
            this.setLayerVisibility('slices', active);
        }));

        layerGroup.appendChild(createToggleChip('fem', '🏗️ FEM', 'Toggle FEM Mesh', (active) => {
            this.setLayerVisibility('fem', active);
        }));

        layerGroup.appendChild(createToggleChip('beams', '📐 Beams (1D)', 'Toggle Beams / 1D Line Elements', (active) => {
            this.setLayerVisibility('beams', active);
        }));

        layerGroup.appendChild(createToggleChip('mpm', '✨ MPM', 'Toggle MPM Particles', (active) => {
            this.setLayerVisibility('mpm', active);
        }));

        layerGroup.appendChild(createToggleChip('stl', '📐 STL', 'Toggle STL Geometry', (active) => {
            this.setLayerVisibility('stl', active);
        }));

        layerGroup.appendChild(createToggleChip('obstacles', '🧱 Obs', 'Toggle Obstacles', (active) => {
            this.setLayerVisibility('obstacles', active);
        }));

        layerGroup.appendChild(createToggleChip('charge', '💥 Chg', 'Toggle Explosive Charge', (active) => {
            this.setLayerVisibility('charge', active);
        }));

        layerGroup.appendChild(createToggleChip('detonator', '🎯 Det', 'Toggle Detonator Points', (active) => {
            this.setLayerVisibility('detonator', active);
        }));

        layerGroup.appendChild(createToggleChip('grid', '🌐 Grid', 'Toggle Domain Grid', (active) => {
            this.setLayerVisibility('grid', active);
        }));

        layerGroup.appendChild(createToggleChip('gauges', '📍 Gauges', 'Toggle Virtual Gauges', (active) => {
            this.setLayerVisibility('gauges', active);
        }));

        layerGroup.appendChild(createToggleChip('lighting', '💡 Light', 'Toggle Lighting & AO', (active) => {
            this.setLayerVisibility('lighting', active);
        }));

        this.bottomViewDock.appendChild(layerGroup);

        // Separator
        this.bottomViewDock.appendChild(this.createDockSeparator());

        // Group 3: Quantity & Colormap
        const qtyGroup = document.createElement('div');
        qtyGroup.style.display = 'flex';
        qtyGroup.style.alignItems = 'center';
        qtyGroup.style.gap = '4px';

        const qtyLabel = document.createElement('span');
        qtyLabel.innerHTML = 'Qty:';
        qtyLabel.style.color = '#aaa';
        qtyGroup.appendChild(qtyLabel);

        const qtySel = document.createElement('select');
        qtySel.id = this.getElId('viewport-dock-qty-sel');
        this.applySelectStyle(qtySel);
        qtySel.style.width = '85px';
        const isIdealDock = this.isIdealGas();
        const dockSpeciesOpts = !isIdealDock ? `
            <option value="species1">Species 1</option>
            <option value="species2">Species 2</option>
            <option value="species3">Species 3</option>` : '';
        qtySel.innerHTML = `
            <option value="pressure">Pressure</option>
            <option value="density">Density</option>
            <option value="velocity">Velocity</option>
            <option value="energy">Energy</option>
            <option value="peak_overpressure">Peak Overpressure</option>
            <option value="peak_impulse">Peak Impulse</option>
            <option value="vonMises">von Mises</option>
            <option value="plastic_strain">Plastic Strain</option>
            <option value="damage">Damage</option>${dockSpeciesOpts}
            <option value="has_failed">Failure</option>
            <option value="object_id">Object ID</option>
        `;
        this.bindEditingEvents(qtySel, () => {
            const vp = this.getViewportNode();
            if (vp) {
                const qty = qtySel.value;
                const slices = (vp.parameters.slices || []).map((s: any) => ({ ...s, quantities: [qty] }));
                const mpmQ = qty === 'plasticStrain' ? 'plastic_strain' : qty;
                const femQ = qty === 'plastic_strain' ? 'plasticStrain' : qty;
                this.stateManager.updateNodeParametersInPlace(vp.id, {
                    slices,
                    mpmParticleQuantity: mpmQ,
                    femQuantity: femQ,
                    stl_quantity: qty
                });
                this.worker.postMessage({
                    type: 'setConfig',
                    data: {
                        mpmParticleQuantity: mpmQ,
                        femQuantity: femQ,
                        stlQuantity: qty
                    }
                });
                this.updateSlices(slices);
                this.syncControls(true);
            }
        });
        qtyGroup.appendChild(qtySel);

        const cmapLabel = document.createElement('span');
        cmapLabel.innerHTML = 'Map:';
        cmapLabel.style.color = '#aaa';
        qtyGroup.appendChild(cmapLabel);

        const cmapSel = document.createElement('select');
        cmapSel.id = this.getElId('viewport-dock-cmap-sel');
        this.applySelectStyle(cmapSel);
        cmapSel.style.width = '80px';
        cmapSel.innerHTML = `
            <option value="rainbow">Rainbow</option>
            <option value="plasma">Plasma</option>
            <option value="viridis">Viridis</option>
            <option value="inferno">Inferno</option>
            <option value="magma">Magma</option>
            <option value="coolwarm">Coolwarm</option>
            <option value="cividis">Cividis</option>
            <option value="grayscale">Grayscale</option>
        `;
        this.bindEditingEvents(cmapSel, () => {
            const vp = this.getViewportNode();
            if (vp) {
                const cmap = cmapSel.value;
                const slices = (vp.parameters.slices || []).map((s: any) => ({ ...s, colormap: cmap }));
                this.stateManager.updateNodeParametersInPlace(vp.id, {
                    colormap: cmap,
                    slices,
                    mpmParticleColormap: cmap,
                    femColormap: cmap,
                    stl_colormap: cmap
                });
                this.worker.postMessage({
                    type: 'setConfig',
                    data: {
                        colormap: cmap,
                        mpmParticleColormap: cmap,
                        femColormap: cmap,
                        stlColormap: cmap
                    }
                });
                this.updateSlices(slices);
                this.syncControls(true);
            }
        });
        qtyGroup.appendChild(cmapSel);

        this.bottomViewDock.appendChild(qtyGroup);

        // Separator
        this.bottomViewDock.appendChild(this.createDockSeparator());

        // Group 4: Refresh Rate & Details
        const rightGroup = document.createElement('div');
        rightGroup.style.display = 'flex';
        rightGroup.style.alignItems = 'center';
        rightGroup.style.gap = '4px';

        const rateSel = document.createElement('select');
        rateSel.id = this.getElId('viewport-refresh-rate-sel-dock');
        this.applySelectStyle(rateSel);
        rateSel.style.width = '100px';
        rateSel.innerHTML = `
            <option value="0.016">60 FPS (Max)</option>
            <option value="0.033">30 FPS</option>
            <option value="0.05">20 FPS</option>
            <option value="0.1">10 FPS</option>
            <option value="0.2">5 FPS</option>
            <option value="0.5">2 FPS (Default)</option>
            <option value="1.0">1 FPS</option>
            <option value="2.0">0.5 FPS</option>
            <option value="5.0">0.2 FPS</option>
            <option value="10.0">0.1 FPS</option>
            <option value="20.0">0.05 FPS</option>
            <option value="50.0">0.02 FPS</option>
            <option value="100.0">0.01 FPS</option>
            <option value="1000.0">0.001 FPS</option>
        `;
        const vpNode = this.getViewportNode();
        this.selectOptionByNumericValue(rateSel, vpNode ? (vpNode.parameters.refresh_rate ?? 0.5) : 0.5);
        this.bindEditingEvents(rateSel, () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { refresh_rate: Number(rateSel.value) });
                this.sendView3DConfig();
            }
        });
        rightGroup.appendChild(rateSel);

        const refreshDockBtn = document.createElement('button');
        refreshDockBtn.innerHTML = '🔄 Refresh';
        refreshDockBtn.title = 'Manual Telemetry Refresh: Request current state from solver and plot in 3D viewport';
        this.applyButtonStyle(refreshDockBtn);
        refreshDockBtn.onclick = () => {
            this.sendView3DConfig();
            const latest = (window as any).playbackBuffer?.getLatestFrame();
            if (latest) {
                if (latest.sliceBuffer) {
                    this.pushFrame(latest.sliceBuffer, latest.modelId);
                } else if (latest.buffer && latest.buffer !== latest.mpmBuffer && latest.buffer !== latest.femBuffer) {
                    this.pushFrame(latest.buffer, latest.modelId);
                }
                if (latest.mpmBuffer) {
                    this.pushFrame(latest.mpmBuffer, latest.modelId);
                }
                if (latest.femBuffer) {
                    this.pushFrame(latest.femBuffer, latest.modelId);
                }
            }
        };
        rightGroup.appendChild(refreshDockBtn);

        // Badge
        const badge = document.getElementById(this.getElId('viewport-renderer-badge')) || document.createElement('span');
        badge.id = this.getElId('viewport-renderer-badge');
        badge.innerHTML = 'WebGL2';
        badge.style.fontSize = '8.5px';
        badge.style.padding = '1px 5px';
        badge.style.borderRadius = '3px';
        badge.style.border = '1px solid rgba(255,255,255,0.15)';
        badge.style.fontWeight = 'bold';
        badge.style.color = '#00adff';
        badge.style.background = 'rgba(0,173,255,0.1)';
        rightGroup.appendChild(badge);

        // Side panel toggle
        const panelToggleBtn = document.createElement('button');
        panelToggleBtn.id = this.getElId('viewport-panel-toggle-btn');
        panelToggleBtn.innerHTML = '⚡ Matrix';
        this.applyButtonStyle(panelToggleBtn);
        panelToggleBtn.style.padding = '2px 6px';
        panelToggleBtn.title = 'Toggle Detailed Slice & Layer Matrix Panel';
        panelToggleBtn.onclick = () => {
            this.isOpen = !this.isOpen;
            if (this.controlsOverlay) this.controlsOverlay.style.display = this.isOpen ? 'flex' : 'none';
            if (this.floatOpenBtn) this.floatOpenBtn.style.display = 'none';
        };
        rightGroup.appendChild(panelToggleBtn);

        this.bottomViewDock.appendChild(rightGroup);
    }

    private buildCameraViewCard(parent: HTMLElement) {
        const { card, body } = this.createCard(parent, 'Camera & View', '🎥', undefined, true);
        
        // 1. Projection Mode Selector Row
        const projRow = document.createElement('div');
        projRow.style.display = 'flex';
        projRow.style.justifyContent = 'space-between';
        projRow.style.alignItems = 'center';
        projRow.style.marginTop = '4px';
        projRow.innerHTML = '<span style="font-size:11px;color:#aaa">Projection</span>';

        const projBtn = document.createElement('button');
        projBtn.id = this.getElId('viewport-card-proj-btn');
        projBtn.innerHTML = this.usePerspective ? '👁️ Perspective' : '📐 Orthographic';
        this.applyButtonStyle(projBtn);
        projBtn.style.width = '140px';
        projBtn.onclick = () => this.setProjection(!this.usePerspective);
        projRow.appendChild(projBtn);
        body.appendChild(projRow);

        // 2. Standard Views Align Row
        const alignRow = document.createElement('div');
        alignRow.style.display = 'flex';
        alignRow.style.flexDirection = 'column';
        alignRow.style.gap = '4px';
        alignRow.style.marginTop = '6px';
        
        const alignLabel = document.createElement('span');
        alignLabel.style.fontSize = '10px';
        alignLabel.style.color = '#aaa';
        alignLabel.textContent = 'Align Camera Face:';
        alignRow.appendChild(alignLabel);

        const btnGrid = document.createElement('div');
        btnGrid.style.display = 'grid';
        btnGrid.style.gridTemplateColumns = 'repeat(3, 1fr)';
        btnGrid.style.gap = '4px';

        const views = [
            { name: 'Top', val: 'top' },
            { name: 'Bottom', val: 'bottom' },
            { name: 'Front', val: 'front' },
            { name: 'Back', val: 'back' },
            { name: 'Left', val: 'left' },
            { name: 'Right', val: 'right' }
        ];

        views.forEach(v => {
            const btn = document.createElement('button');
            btn.textContent = v.name;
            this.applyButtonStyle(btn);
            btn.onclick = () => this.alignCamera(v.val);
            btnGrid.appendChild(btn);
        });
        alignRow.appendChild(btnGrid);
        body.appendChild(alignRow);

        // 3. Reset View Row
        const resetRow = document.createElement('div');
        resetRow.style.marginTop = '6px';
        resetRow.style.display = 'flex';
        resetRow.style.width = '100%';

        const resetBtn = document.createElement('button');
        resetBtn.innerHTML = '🏠 Reset Camera to Default';
        this.applyButtonStyle(resetBtn);
        resetBtn.style.width = '100%';
        resetBtn.style.padding = '5px 0';
        resetBtn.onclick = () => this.snapCameraPreset('reset');
        resetRow.appendChild(resetBtn);
        body.appendChild(resetRow);
    }

    public snapCameraPreset(preset: string): void {
        const p = preset.toLowerCase().trim();
        if (p === 'reset') {
            this.worker.postMessage({
                type: 'setView',
                data: {
                    pitch: 0.42,
                    yaw: 2.356,
                    distance: 1.35,
                    targetX: 0.0,
                    targetY: 0.0,
                    targetZ: 0.0
                }
            });
            return;
        }
        this.alignCamera(p);
    }

    public setBackgroundColor(r: number, g: number, b: number): void {
        if (this.worker) {
            this.worker.postMessage({
                type: 'setConfig',
                data: { clearColor: { r, g, b } }
            });
        }
    }

    public setGridVisible(visible: boolean): void {
        this.setLayerVisibility('grid', visible);
    }

    public setProjection(perspective: boolean): void {
        this.usePerspective = perspective;
        this.syncProjectionButtons();
        const vp = this.getViewportNode();
        if (vp) {
            this.stateManager.updateNodeParametersInPlace(vp.id, { usePerspective: perspective });
        }
        this.worker.postMessage({
            type: 'setConfig',
            data: { usePerspective: perspective }
        });
    }

    public updateSlicePlane(plane: 'xy' | 'xz' | 'yz', enabled: boolean, offset: number): void {
        const vp = this.getViewportNode();
        if (!vp) return;
        const meshNode = this.getMeshNode();
        const bounds = getSliceBounds(plane, meshNode);
        const pos = (offset >= bounds.min && offset <= bounds.max)
            ? offset
            : (bounds.min + (offset + 1.0) * 0.5 * (bounds.max - bounds.min));
        let slices = vp.parameters.slices || [];
        const targetIdx = slices.findIndex((s: any) => s.axis === plane);
        if (targetIdx === -1) {
            slices = [...slices, {
                axis: plane,
                position: pos,
                offset: pos,
                enabled: enabled,
                quantities: [vp.parameters.focusedQuantity || 'pressure'],
                colormap: vp.parameters.colormap || 'rainbow'
            }];
        } else {
            slices = slices.map((s: any, idx: number) => {
                if (idx === targetIdx) {
                    return { ...s, position: pos, offset: pos, enabled: enabled };
                }
                return s;
            });
        }
        this.stateManager.updateNodeParametersInPlace(vp.id, { slices });
        this.updateSlices(slices);
        this.syncControls(true);
    }

    public setColormap(colormap: string, min?: number, max?: number): void {
        const vp = this.getViewportNode();
        if (!vp) return;
        const cmap = colormap.toLowerCase();
        const slices = (vp.parameters.slices || []).map((s: any) => ({ ...s, colormap: cmap }));
        const updates: any = {
            colormap: cmap,
            slices,
            mpmParticleColormap: cmap,
            femColormap: cmap,
            stl_colormap: cmap
        };
        if (min !== undefined && max !== undefined) {
            updates.min_val = min;
            updates.max_val = max;
        }
        this.stateManager.updateNodeParametersInPlace(vp.id, updates);
        this.worker.postMessage({
            type: 'setConfig',
            data: {
                colormap: cmap,
                mpmParticleColormap: cmap,
                femColormap: cmap,
                stlColormap: cmap,
                ...(min !== undefined && max !== undefined ? { minVal: min, maxVal: max } : {})
            }
        });
        this.updateSlices(slices);
        this.syncControls(true);
    }

    public setQuantity(quantity: string): void {
        const vp = this.getViewportNode();
        if (!vp) return;
        let q = quantity;
        if (q === 'species_1' || q === 'species' || q === 'products' || q === 'detonation_products' || q === 'detonation' || q === 'reacted' || q === 'reacted_gas' || q === 'alpha1' || q === 'alpha_1') q = 'species1';
        else if (q === 'species_2' || q === 'unreacted' || q === 'unreacted_solid' || q === 'solid_he' || q === 'alpha2' || q === 'alpha_2') q = 'species2';
        else if (q === 'species_3' || q === 'air' || q === 'ambient_air' || q === 'alpha3' || q === 'alpha_3') q = 'species3';
        else if (q === 'von_mises') q = 'vonMises';
        else if (q === 'plastic_strain') q = 'plasticStrain';

        const sIdx = this.stateManager.getSelectedSliceIndex();
        const currentSlices = [...(vp.parameters.slices || [])];
        let updatedSlices = currentSlices;

        if (sIdx !== null && sIdx !== undefined && currentSlices[sIdx]) {
            currentSlices[sIdx] = { ...currentSlices[sIdx], quantities: [q], quantity: q };
            updatedSlices = currentSlices;
        } else {
            updatedSlices = currentSlices.map((s: any) => ({ ...s, quantities: [q], quantity: q }));
        }

        const mpmQ = q === 'plasticStrain' ? 'plastic_strain' : q;
        const femQ = q === 'plastic_strain' ? 'plasticStrain' : q;
        this.stateManager.updateNodeParametersInPlace(vp.id, {
            slices: updatedSlices,
            focusedQuantity: q,
            mpmParticleQuantity: mpmQ,
            femQuantity: femQ,
            stl_quantity: q
        });
        this.worker.postMessage({
            type: 'setConfig',
            data: {
                mpmParticleQuantity: mpmQ,
                femQuantity: femQ,
                stlQuantity: q
            }
        });
        this.updateSlices(updatedSlices);
        this.syncControls(true);
    }

    public setLayerVisibility(layer: string, active: boolean): void {
        const vp = this.getViewportNode();
        if (!vp) return;
        const updates: any = {};
        const workerData: any = {};
        if (layer === 'slices') {
            const currentSlices = vp.parameters.slices || [];
            const slices = currentSlices.map((s: any) => ({ ...s, enabled: active }));
            updates.slices = slices;
            updates.show_slices = active;
            workerData.showSlices = active;
            workerData.slices = slices;
            this.updateSlices(slices);
        } else if (layer === 'fem') {
            updates.showFEMMesh = active;
            if (active && vp.parameters.femSolid === false && vp.parameters.femWireframe === false) {
                updates.femSolid = true;
                updates.femWireframe = true;
            }
            workerData.showFEMMesh = active;
            Object.assign(workerData, updates);
        } else if (layer === 'beams') {
            updates.showBeams = active;
            updates.showRebar = active;
            if (active && (vp.parameters.beamSolid === false || vp.parameters.rebarSolid === false) && (vp.parameters.beamWireframe === false || vp.parameters.rebarWireframe === false)) {
                updates.beamSolid = true;
                updates.beamWireframe = true;
                updates.rebarSolid = true;
                updates.rebarWireframe = true;
            }
            workerData.showBeams = active;
            workerData.showRebar = active;
            Object.assign(workerData, updates);
        } else if (layer === 'mpm') {
            updates.showMPMParticles = active;
            workerData.showMPMParticles = active;
        } else if (layer === 'stl') {
            updates.show_stl = active;
            workerData.showSTL = active;
        } else if (layer === 'obstacles') {
            updates.show_obstacles = active;
            workerData.showObstacles = active;
        } else if (layer === 'charge') {
            updates.show_charge = active;
            workerData.showCharge = active;
        } else if (layer === 'detonator' || layer === 'detonators') {
            updates.show_detonators = active;
            updates.show_detonator = active;
            workerData.showDetonators = active;
        } else if (layer === 'grid') {
            updates.show_grid = active;
            workerData.showGrid = active;
            updates.show_grid_box = active;
            workerData.showGridBox = active;
        } else if (layer === 'gridBox') {
            updates.show_grid_box = active;
            workerData.showGridBox = active;
        } else if (layer === 'gauges') {
            updates.show_gauges = active;
            workerData.showGauges = active;
        } else if (layer === 'lighting') {
            updates.lightingEnabled = active;
            updates.aoEnabled = active;
            workerData.lightingEnabled = active;
            workerData.aoEnabled = active;
        }
        this.stateManager.updateNodeParametersInPlace(vp.id, updates);
        if (Object.keys(workerData).length > 0) {
            this.worker.postMessage({ type: 'setConfig', data: workerData });
        }
        this.syncControls(true);
    }

    public setRefreshRate(rate: number): void {
        const vp = this.getViewportNode();
        if (vp) {
            this.stateManager.updateNodeParametersInPlace(vp.id, { refresh_rate: rate });
            this.sendView3DConfig();
        }
    }

    public setShadingConfig(config: any): void {
        const vp = this.getViewportNode();
        if (vp) {
            this.stateManager.updateNodeParametersInPlace(vp.id, config);
            this.worker.postMessage({ type: 'setConfig', data: config });
            this.syncControls(true);
        }
    }

    public setROIConfig(roi: any): void {
        const vp = this.getViewportNode();
        if (vp) {
            this.stateManager.updateNodeParametersInPlace(vp.id, roi);
            this.worker.postMessage({ type: 'setConfig', data: roi });
            this.syncControls(true);
        }
    }

    public setParticleFilter(filter: any): void {
        const vp = this.getViewportNode();
        if (vp) {
            this.stateManager.updateNodeParametersInPlace(vp.id, filter);
            this.worker.postMessage({ type: 'setConfig', data: filter });
            this.syncControls(true);
        }
    }
}

function getSliceBounds(axis: string, meshNode: any) {
    const res = resolveSliceDomainBounds(axis, meshNode, null, null);
    return { min: res.min, max: res.max };
}

function formatSIDiameter(d: number): string {
    if (!isFinite(d) || d <= 0) return '0 m';
    if (d >= 0.01) return `${d.toFixed(3)} m`;
    if (d >= 0.001) return `${d.toFixed(4).replace(/0+$/, '')} m`;
    if (d >= 0.00001) return `${d.toFixed(6).replace(/0+$/, '')} m`;
    return `${d.toExponential(2)} m`;
}

