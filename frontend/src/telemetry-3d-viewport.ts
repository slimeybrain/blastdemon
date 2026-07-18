import { Node, PanelType } from './types.js';
import { StateManager } from './state-manager.js';

const DEFAULT_QUANTITY_RANGES: Record<string, [number, number]> = {
    pressure: [101325.0, 101325.0 * 100.0],
    density: [1.2, 100.0],
    velocity: [0.0, 1000.0],
    energy: [200000.0, 10000000.0],
    species1: [0.0, 1.0],
    species2: [0.0, 1.0],
    species3: [0.0, 1.0],
    solid: [0.0, 1.0],
    overpressure: [0.0, 101325.0 * 99.0],
    impulse: [0.0, 10000.0]
};

function getFocusedQuantityAndRange(vpNode: any): { quantity: string, min: number, max: number } {
    const slices = vpNode.parameters.slices || [];
    const focusedIdx = vpNode.parameters.focusedSliceIndex ?? 0;
    const slice = slices[focusedIdx] || slices[0] || { quantities: ['pressure'] };
    const qty = slice.quantities?.[0] || 'pressure';

    const ranges = vpNode.parameters.quantity_ranges || {};
    const range = ranges[qty] || DEFAULT_QUANTITY_RANGES[qty] || [0.0, 1.0];
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
    private debugOverlay: HTMLElement | null = null;
    private hasTelemetryGrid = false;

    // Overlay Elements
    private controlsOverlay: HTMLElement | null = null;
    private floatOpenBtn: HTMLElement | null = null;
    private sliceListContainer: HTMLElement | null = null;
    private expandedSliceIndices = new Set<number>();
    private needsSlicesRebuild = true;
    private isOpen = true;
    private latestSliceRanges: { min: number, max: number }[] = [];
    private _lastSliceKey: string = '';

    constructor(container: HTMLElement, panelId: string, stateManager: StateManager) {
        this.container = container;
        this.panelId = panelId;
        this.stateManager = stateManager;

        // Container relative positioning
        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';

        this.canvas = document.createElement('canvas');
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        this.container.appendChild(this.canvas);

        this.worker = new Worker(new URL('./ViewportWorker.ts?v=' + Date.now(), import.meta.url), { type: 'module' });

        this.worker.onmessage = (e) => {
            const { type, renderer, min, max } = e.data;
            if (type === 'rendererInfo') {
                const badge = document.getElementById(`viewport-renderer-badge-${this.panelId}`);
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
            } else if (type === 'sliceRanges') {
                this.latestSliceRanges = e.data.ranges;
                this.syncControls();
            } else if (type === 'currentRange') {
                const rangeLabel = document.getElementById(`viewport-current-range-${this.panelId}`);
                if (rangeLabel) {
                    rangeLabel.textContent = `Current: [${this.formatRangeValue(min)}, ${this.formatRangeValue(max)}]`;
                }
            }
        };

        const rect = this.container.getBoundingClientRect();
        // @ts-ignore
        const offscreen = this.canvas.transferControlToOffscreen();
        this.worker.postMessage({
            type: 'init',
            data: {
                canvas: offscreen,
                width: rect.width || 800,
                height: rect.height || 600
            }
        }, [offscreen]);

        this.initInteraction();
        this.buildOverlay();

        // Diagnostic Overlay for STL Loading
        this.debugOverlay = document.createElement('div');
        this.debugOverlay.id = `viewport-debug-stl-${this.panelId}`;
        this.debugOverlay.style.position = 'absolute';
        this.debugOverlay.style.top = '10px';
        this.debugOverlay.style.left = '10px';
        this.debugOverlay.style.color = '#ffaa00';
        this.debugOverlay.style.background = 'rgba(0, 0, 0, 0.7)';
        this.debugOverlay.style.padding = '4px 8px';
        this.debugOverlay.style.borderRadius = '4px';
        this.debugOverlay.style.fontSize = '10px';
        this.debugOverlay.style.fontFamily = 'monospace';
        this.debugOverlay.style.pointerEvents = 'none';
        this.debugOverlay.style.zIndex = '100';
        this.debugOverlay.innerHTML = 'STL Status: Initializing...';
        this.container.appendChild(this.debugOverlay);

        new ResizeObserver(entries => {
            for (let entry of entries) {
                const dpr = window.devicePixelRatio || 1;
                this.worker.postMessage({
                    type: 'resize',
                    data: {
                        width: entry.contentRect.width * dpr,
                        height: entry.contentRect.height * dpr
                    }
                });
            }
        }).observe(this.container);

        const net = (window as any).networkManager;
        if (net) {
            this.openListener = () => {
                this.currentSTLPath = null;
                this.syncControls();
            };
            net.onOpen(this.openListener);

            this.netCallback = (data: string | ArrayBuffer) => {
                if (typeof data === 'string') {
                    try {
                        const msg = JSON.parse(data);
                        if (msg.type === 'load_stl_response') {
                            if (msg.status === 'success' && msg.vertices) {
                                if (this.debugOverlay) {
                                    this.debugOverlay.innerHTML += `<br>Load: SUCCESS (${msg.vertices.length / 3} vertices)`;
                                }
                                const verts = new Float32Array(msg.vertices);
                                this.worker.postMessage({
                                    type: 'setSTLGeometry',
                                    data: { vertices: verts }
                                });
                            } else {
                                if (this.debugOverlay) {
                                    this.debugOverlay.innerHTML += `<br>Load: ERROR (${msg.error})`;
                                }
                                console.error("[Viewport] Failed to load STL:", msg.error);
                            }
                        }
                    } catch (e) {}
                }
            };
            net.onMessage(this.netCallback);
        }

        this.stateListener = () => this.syncControls();
        this.stateManager.onStateChange(this.stateListener);
        this.syncControls();
    }

    private initInteraction() {
        let isDragging = false;
        let dragMode: 'orbit' | 'pan' = 'orbit';
        let lastX = 0;
        let lastY = 0;

        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });

        this.canvas.addEventListener('mousedown', (e) => {
            e.preventDefault();
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
                this.worker.postMessage({ type: 'input', data: { dpx: dx, dpy: dy } });
            } else {
                this.worker.postMessage({ type: 'input', data: { drx: dy, dry: dx } });
            }
        });

        window.addEventListener('mouseup', () => {
            isDragging = false;
        });

        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.worker.postMessage({ type: 'input', data: { dy: e.deltaY } });
        }, { passive: false });
    }


    private buildOverlay() {
        // 1. Floating gear button when closed
        this.floatOpenBtn = document.createElement('button');
        this.floatOpenBtn.innerHTML = '⚙️ Controls';
        this.applyButtonStyle(this.floatOpenBtn);
        this.floatOpenBtn.style.position = 'absolute';
        this.floatOpenBtn.style.top = '10px';
        this.floatOpenBtn.style.left = '10px';
        this.floatOpenBtn.style.display = 'none';
        this.floatOpenBtn.style.zIndex = '12';
        this.floatOpenBtn.onclick = () => {
            this.isOpen = true;
            if (this.controlsOverlay) this.controlsOverlay.style.display = 'flex';
            if (this.floatOpenBtn) this.floatOpenBtn.style.display = 'none';
        };
        this.container.appendChild(this.floatOpenBtn);

        // 2. Controls Panel Overlay
        this.controlsOverlay = document.createElement('div');
        this.controlsOverlay.style.position = 'absolute';
        this.controlsOverlay.style.top = '10px';
        this.controlsOverlay.style.left = '10px';
        this.controlsOverlay.style.bottom = '10px';
        this.controlsOverlay.style.width = '290px';
        this.controlsOverlay.style.background = 'rgba(20, 20, 22, 0.85)';
        this.controlsOverlay.style.backdropFilter = 'blur(12px)';
        this.controlsOverlay.style.border = '1px solid rgba(255, 255, 255, 0.1)';
        this.controlsOverlay.style.borderRadius = '8px';
        this.controlsOverlay.style.display = 'flex';
        this.controlsOverlay.style.flexDirection = 'column';
        this.controlsOverlay.style.color = '#e0e0e0';
        this.controlsOverlay.style.fontFamily = 'system-ui, -apple-system, sans-serif';
        this.controlsOverlay.style.fontSize = '12px';
        this.controlsOverlay.style.boxShadow = '0 12px 40px 0 rgba(0, 0, 0, 0.5)';
        this.controlsOverlay.style.zIndex = '11';
        this.container.appendChild(this.controlsOverlay);

        // Header
        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.style.padding = '8px 12px';
        header.style.borderBottom = '1px solid rgba(255, 255, 255, 0.08)';
        header.style.background = 'linear-gradient(to right, rgba(255,255,255,0.02), transparent)';
        
        const titleWrap = document.createElement('div');
        titleWrap.style.display = 'flex';
        titleWrap.style.alignItems = 'center';

        const title = document.createElement('span');
        title.innerHTML = '⚡ 3D Controls';
        title.style.fontWeight = '600';
        title.style.letterSpacing = '0.5px';
        titleWrap.appendChild(title);

        const badge = document.createElement('span');
        badge.id = `viewport-renderer-badge-${this.panelId}`;
        badge.innerHTML = 'Detecting...';
        badge.style.fontSize = '8px';
        badge.style.padding = '2px 5px';
        badge.style.borderRadius = '3px';
        badge.style.border = '1px solid rgba(255,255,255,0.15)';
        badge.style.fontWeight = 'bold';
        badge.style.marginLeft = '8px';
        badge.style.textTransform = 'uppercase';
        badge.style.color = '#888';
        badge.style.background = 'rgba(255,255,255,0.03)';
        titleWrap.appendChild(badge);

        header.appendChild(titleWrap);

        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '◀';
        closeBtn.style.background = 'none';
        closeBtn.style.border = 'none';
        closeBtn.style.color = '#aaa';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.fontSize = '12px';
        closeBtn.onclick = () => {
            this.isOpen = false;
            if (this.controlsOverlay) this.controlsOverlay.style.display = 'none';
            if (this.floatOpenBtn) this.floatOpenBtn.style.display = 'block';
        };
        header.appendChild(closeBtn);
        this.controlsOverlay.appendChild(header);

        // Scrollable content area
        const content = document.createElement('div');
        content.style.flex = '1';
        content.style.overflowY = 'auto';
        content.style.padding = '12px';
        content.style.display = 'flex';
        content.style.flexDirection = 'column';
        content.style.gap = '14px';
        this.controlsOverlay.appendChild(content);

        // Section 1: Render Options
        const renderSection = this.createSection(content, 'Render Settings');
        this.buildRenderControls(renderSection);

        // Section 1.5: Lighting & Shadows
        const lightingSection = this.createSection(content, 'Lighting & Shadows');
        this.buildLightingControls(lightingSection);

        // Section 1.6: STL Geometry
        const stlSection = this.createSection(content, 'STL Boundary Mesh');
        this.buildSTLControls(stlSection);

        // Section 2: Slice Settings
        const sliceSection = this.createSection(content, 'Active Slices');
        this.sliceListContainer = document.createElement('div');
        this.sliceListContainer.style.display = 'flex';
        this.sliceListContainer.style.flexDirection = 'column';
        this.sliceListContainer.style.gap = '8px';
        sliceSection.appendChild(this.sliceListContainer);

        const addSliceBtn = document.createElement('button');
        addSliceBtn.innerHTML = '+ Add Slice';
        this.applyButtonStyle(addSliceBtn);
        addSliceBtn.style.marginTop = '8px';
        addSliceBtn.onclick = () => this.addSlice();
        sliceSection.appendChild(addSliceBtn);

        // Section 3: Solver Configurations
        const solverSection = this.createSection(content, 'Solver Config');
        this.buildSolverControls(solverSection);
    }

    private createSection(parent: HTMLElement, titleText: string): HTMLElement {
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.flexDirection = 'column';
        wrap.style.gap = '6px';
        parent.appendChild(wrap);

        const label = document.createElement('div');
        label.innerHTML = titleText;
        label.style.fontWeight = 'bold';
        label.style.color = '#00adff';
        label.style.textTransform = 'uppercase';
        label.style.fontSize = '10px';
        label.style.letterSpacing = '1px';
        wrap.appendChild(label);

        const body = document.createElement('div');
        body.style.display = 'flex';
        body.style.flexDirection = 'column';
        body.style.gap = '6px';
        wrap.appendChild(body);
        return body;
    }

    private formatRangeValue(val: number): string {
        if (Math.abs(val) < 1e-3 || Math.abs(val) > 1e6) {
            return val.toExponential(4);
        }
        return val.toFixed(1);
    }

    private applyButtonStyle(btn: HTMLElement) {
        btn.style.background = '#2c2c30';
        btn.style.color = '#ffffff';
        btn.style.border = '1px solid rgba(255, 255, 255, 0.1)';
        btn.style.borderRadius = '4px';
        btn.style.padding = '4px 8px';
        btn.style.cursor = 'pointer';
        btn.style.fontSize = '11px';
        btn.style.fontWeight = '500';
        btn.style.transition = 'background 0.2s';
        btn.onmouseover = () => btn.style.background = '#3c3c40';
        btn.onmouseout = () => btn.style.background = '#2c2c30';
    }

    private buildRenderControls(parent: HTMLElement) {
        const vpNode = this.getViewportNode();

        // Grid (bbox) toggle
        const gridRow = document.createElement('label');
        gridRow.style.display = 'flex';
        gridRow.style.alignItems = 'center';
        gridRow.style.gap = '6px';
        gridRow.style.cursor = 'pointer';
        
        const gridCb = document.createElement('input');
        gridCb.type = 'checkbox';
        gridCb.id = 'viewport-grid-cb';
        // FIX 1/5: Initialize from saved state so value is correct on load
        gridCb.checked = vpNode ? (vpNode.parameters.show_grid !== false) : true;
        gridCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { show_grid: gridCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { showGrid: gridCb.checked } });
            }
        };
        gridRow.appendChild(gridCb);
        gridRow.appendChild(document.createTextNode('Show Bounding Box'));
        parent.appendChild(gridRow);

        // Cell edges toggle
        const edgesRow = document.createElement('label');
        edgesRow.style.display = 'flex';
        edgesRow.style.alignItems = 'center';
        edgesRow.style.gap = '6px';
        edgesRow.style.cursor = 'pointer';
        
        const edgesCb = document.createElement('input');
        edgesCb.type = 'checkbox';
        edgesCb.id = 'viewport-edges-cb';
        // FIX 1/5: Initialize from saved state
        edgesCb.checked = vpNode ? (!!vpNode.parameters.cell_edges) : false;
        edgesCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { cell_edges: edgesCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { showCellEdges: edgesCb.checked } });
            }
        };
        edgesRow.appendChild(edgesCb);
        edgesRow.appendChild(document.createTextNode('Show Cell Edges'));
        parent.appendChild(edgesRow);

        // Recenter view button
        const recenterRow = document.createElement('div');
        recenterRow.style.display = 'flex';
        recenterRow.style.justifyContent = 'center';
        recenterRow.style.marginTop = '4px';
        const recenterBtn = document.createElement('button');
        recenterBtn.innerHTML = '🔄 Recenter View';
        this.applyButtonStyle(recenterBtn);
        recenterBtn.style.width = '100%';
        recenterBtn.onclick = () => {
            this.worker.postMessage({
                type: 'setView',
                data: { rotX: 0.5, rotY: 0.5, zoom: -2.5, panX: 0.0, panY: 0.0 }
            });
        };
        recenterRow.appendChild(recenterBtn);
        parent.appendChild(recenterRow);
    }

    private buildLightingControls(parent: HTMLElement) {
        // FIX 1: Read initial values from state so sliders are persistent
        const vpNode = this.getViewportNode();
        const initLighting = vpNode ? (vpNode.parameters.lightingEnabled !== false) : true;
        const initAO = vpNode ? (vpNode.parameters.aoEnabled !== false) : true;
        const initAmb = vpNode ? (vpNode.parameters.ambientLevel ?? 0.3) : 0.3;
        const initSpec = vpNode ? (vpNode.parameters.specularIntensity ?? 0.4) : 0.4;

        // Lighting toggle
        const lightRow = document.createElement('label');
        lightRow.style.display = 'flex';
        lightRow.style.alignItems = 'center';
        lightRow.style.gap = '6px';
        lightRow.style.cursor = 'pointer';
        
        const lightCb = document.createElement('input');
        lightCb.type = 'checkbox';
        lightCb.id = 'viewport-lighting-cb';
        lightCb.checked = initLighting;
        lightCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { lightingEnabled: lightCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { lightingEnabled: lightCb.checked } });
            }
        };
        lightRow.appendChild(lightCb);
        lightRow.appendChild(document.createTextNode('Enable Lighting'));
        parent.appendChild(lightRow);

        // AO toggle
        const aoRow = document.createElement('label');
        aoRow.style.display = 'flex';
        aoRow.style.alignItems = 'center';
        aoRow.style.gap = '6px';
        aoRow.style.cursor = 'pointer';
        
        const aoCb = document.createElement('input');
        aoCb.type = 'checkbox';
        aoCb.id = 'viewport-ao-cb';
        aoCb.checked = initAO;
        aoCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { aoEnabled: aoCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { aoEnabled: aoCb.checked } });
            }
        };
        aoRow.appendChild(aoCb);
        aoRow.appendChild(document.createTextNode('Enable Ambient Occlusion'));
        parent.appendChild(aoRow);

        // Ambient Level Slider
        const ambWrap = document.createElement('div');
        ambWrap.style.display = 'flex';
        ambWrap.style.flexDirection = 'column';
        ambWrap.style.gap = '2px';
        
        const ambLabel = document.createElement('span');
        ambLabel.style.fontSize = '8px';
        ambLabel.style.color = '#aaa';
        // FIX 1: Set initial label from saved state
        ambLabel.innerHTML = `Ambient Level: ${Number(initAmb).toFixed(2)}`;
        
        const ambSlider = document.createElement('input');
        ambSlider.type = 'range';
        ambSlider.id = 'viewport-ambient-slider';
        ambSlider.min = '0';
        ambSlider.max = '1';
        ambSlider.step = '0.05';
        ambSlider.style.width = '100%';
        // FIX 1: Initialize slider position from saved state
        ambSlider.value = String(initAmb);
        ambSlider.oninput = () => {
            ambLabel.innerHTML = `Ambient Level: ${Number(ambSlider.value).toFixed(2)}`;
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { ambientLevel: Number(ambSlider.value) });
                this.worker.postMessage({ type: 'setConfig', data: { ambientLevel: Number(ambSlider.value) } });
            }
        };
        ambWrap.appendChild(ambLabel);
        ambWrap.appendChild(ambSlider);
        parent.appendChild(ambWrap);

        // Specular Intensity Slider
        const specWrap = document.createElement('div');
        specWrap.style.display = 'flex';
        specWrap.style.flexDirection = 'column';
        specWrap.style.gap = '2px';
        
        const specLabel = document.createElement('span');
        specLabel.style.fontSize = '8px';
        specLabel.style.color = '#aaa';
        // FIX 1: Set initial label from saved state
        specLabel.innerHTML = `Specular Level: ${Number(initSpec).toFixed(2)}`;
        
        const specSlider = document.createElement('input');
        specSlider.type = 'range';
        specSlider.id = 'viewport-specular-slider';
        specSlider.min = '0';
        specSlider.max = '1';
        specSlider.step = '0.05';
        specSlider.style.width = '100%';
        // FIX 1: Initialize slider position from saved state
        specSlider.value = String(initSpec);
        specSlider.oninput = () => {
            specLabel.innerHTML = `Specular Level: ${Number(specSlider.value).toFixed(2)}`;
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { specularIntensity: Number(specSlider.value) });
                this.worker.postMessage({ type: 'setConfig', data: { specularIntensity: Number(specSlider.value) } });
            }
        };
        specWrap.appendChild(specLabel);
        specWrap.appendChild(specSlider);
        parent.appendChild(specWrap);
    }

    private buildSolverControls(parent: HTMLElement) {
        // Device
        const devRow = document.createElement('div');
        devRow.style.display = 'flex';
        devRow.style.justifyContent = 'space-between';
        devRow.style.alignItems = 'center';
        devRow.innerHTML = '<span>Device</span>';
        const devSel = document.createElement('select');
        devSel.id = 'solver-device-sel';
        this.applySelectStyle(devSel);
        devSel.innerHTML = '<option value="cpu">CPU (Multi-thread)</option><option value="cuda">GPU (CUDA)</option>';
        devSel.onchange = () => {
            const solver = this.getSolverNode();
            if (solver) this.stateManager.updateNodeParameters(solver.id, { device: devSel.value });
        };
        devRow.appendChild(devSel);
        parent.appendChild(devRow);

        // Init Mode
        const initRow = document.createElement('div');
        initRow.style.display = 'flex';
        initRow.style.justifyContent = 'space-between';
        initRow.style.alignItems = 'center';
        initRow.innerHTML = '<span>Init Mode</span>';
        const initSel = document.createElement('select');
        initSel.id = 'solver-initmode-sel';
        this.applySelectStyle(initSel);
        initSel.innerHTML = '<option value="From1D">From 1D Remap</option><option value="Multi-Material JWL">JWL Multi-Mat</option><option value="Ideal Gas">Ideal Gas</option>';
        initSel.onchange = () => {
            const solver = this.getSolverNode();
            if (solver) this.stateManager.updateNodeParameters(solver.id, { init_mode: initSel.value });
        };
        initRow.appendChild(initSel);
        parent.appendChild(initRow);

        // Flux Scheme
        const fluxRow = document.createElement('div');
        fluxRow.style.display = 'flex';
        fluxRow.style.justifyContent = 'space-between';
        fluxRow.style.alignItems = 'center';
        fluxRow.innerHTML = '<span>Flux Scheme</span>';
        const fluxSel = document.createElement('select');
        fluxSel.id = 'solver-flux-sel';
        this.applySelectStyle(fluxSel);
        fluxSel.innerHTML = '<option value="AUSM+">AUSM+</option><option value="Rusanov">Rusanov</option>';
        fluxSel.onchange = () => {
            const solver = this.getSolverNode();
            if (solver) this.stateManager.updateNodeParameters(solver.id, { flux_scheme: fluxSel.value });
        };
        fluxRow.appendChild(fluxSel);
        parent.appendChild(fluxRow);

        // Spatial Order
        const spRow = document.createElement('div');
        spRow.style.display = 'flex';
        spRow.style.justifyContent = 'space-between';
        spRow.style.alignItems = 'center';
        spRow.innerHTML = '<span>Spatial Order</span>';
        const spSel = document.createElement('select');
        spSel.id = 'solver-sporder-sel';
        this.applySelectStyle(spSel);
        spSel.innerHTML = '<option value="1">1st Order</option><option value="2">2nd Order</option>';
        spSel.onchange = () => {
            const solver = this.getSolverNode();
            if (solver) this.stateManager.updateNodeParameters(solver.id, { spatial_order: Number(spSel.value) });
        };
        spRow.appendChild(spSel);
        parent.appendChild(spRow);

        // Temporal Order
        const tempRow = document.createElement('div');
        tempRow.style.display = 'flex';
        tempRow.style.justifyContent = 'space-between';
        tempRow.style.alignItems = 'center';
        tempRow.innerHTML = '<span>Temporal Order</span>';
        const tempSel = document.createElement('select');
        tempSel.id = 'solver-temporder-sel';
        this.applySelectStyle(tempSel);
        tempSel.innerHTML = '<option value="1">1st Order</option><option value="2">2nd Order (RK2)</option>';
        tempSel.onchange = () => {
            const solver = this.getSolverNode();
            if (solver) this.stateManager.updateNodeParameters(solver.id, { temporal_order: Number(tempSel.value) });
        };
        tempRow.appendChild(tempSel);
        parent.appendChild(tempRow);
    }

    private applySelectStyle(sel: HTMLSelectElement) {
        sel.style.background = '#1e1e20';
        sel.style.color = '#fff';
        sel.style.border = '1px solid rgba(255, 255, 255, 0.1)';
        sel.style.borderRadius = '4px';
        sel.style.padding = '2px 4px';
        sel.style.fontSize = '11px';
        sel.style.outline = 'none';
        sel.style.width = '120px';
    }

    private applyInputStyle(inp: HTMLInputElement) {
        inp.style.background = '#1e1e20';
        inp.style.color = '#fff';
        inp.style.border = '1px solid rgba(255, 255, 255, 0.1)';
        inp.style.borderRadius = '4px';
        inp.style.padding = '2px 4px';
        inp.style.fontSize = '11px';
        inp.style.outline = 'none';
        inp.style.width = '90%';
    }

    private getViewportNode(): Node | null {
        const ws = this.stateManager.getActiveWorkspace();
        if (!ws) return null;
        if (ws.activeModelId) {
            const state = this.stateManager.getSimulationState(ws.activeModelId);
            const node = state?.nodes.find(n => n.type === 'Telemetry3DViewport');
            if (node) return node;
        }

        // Fallback: search all models in the workspace
        const allModels = this.stateManager.getWorkspaceModels();
        for (const m of allModels) {
            const node = m.nodes.find(n => n.type === 'Telemetry3DViewport');
            if (node) return node;
        }
        return null;
    }



    private updateSlices(slices: any[]) {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        this.stateManager.updateNodeParametersInPlace(vpNode.id, { slices });
        
        const opacities = slices.map((s: any) => s.opacity !== undefined ? s.opacity : 1.0);
        this.worker.postMessage({
            type: 'setConfig',
            data: {
                slices: slices,
                sliceOpacities: opacities,
                focusedSliceIndex: vpNode.parameters.focusedSliceIndex ?? 0,
                quantityRanges: vpNode.parameters.quantity_ranges || {}
            }
        });

        const net = (window as any).networkManager;
        if (net && net.isConnected()) {
            let targetModelId = vpNode.id;
            const models = this.stateManager.getAppState().models;
            for (const [mid, m] of Object.entries(models)) {
                if (m.nodes.some(n => n.id === vpNode.id)) {
                    targetModelId = mid;
                    break;
                }
            }
            net.send({
                command: "VIEW3D_CONFIG",
                modelId: targetModelId,
                slices: slices
            });
        }
    }

    private getMeshNode() {
        const vpNode = this.getViewportNode();
        if (!vpNode) return null;

        const allModels = this.stateManager.getWorkspaceModels();
        let targetModel: any = null;
        for (const m of allModels) {
            if (m.nodes.some(n => n.id === vpNode.id)) {
                targetModel = m;
                break;
            }
        }
        if (!targetModel) return null;

        const connToViewport = targetModel.connections.find((c: any) => c.toNode === vpNode.id);
        if (connToViewport) {
            const solverNode = targetModel.nodes.find((n: any) => n.id === connToViewport.fromNode);
            if (solverNode) {
                const connToSolver = targetModel.connections.find((c: any) => c.toNode === solverNode.id && c.toPort === 'mesh');
                if (connToSolver) {
                    return targetModel.nodes.find((n: any) => n.id === connToSolver.fromNode) || null;
                }
            }
        }
        return null;
    }

    private getSolverNode(): Node | null {
        const vpNode = this.getViewportNode();
        if (!vpNode) return null;

        const allModels = this.stateManager.getWorkspaceModels();
        let targetModel: any = null;
        for (const m of allModels) {
            if (m.nodes.some(n => n.id === vpNode.id)) {
                targetModel = m;
                break;
            }
        }
        if (!targetModel) return null;

        const connToViewport = targetModel.connections.find((c: any) => c.toNode === vpNode.id);
        if (connToViewport) {
            return targetModel.nodes.find((n: any) => n.id === connToViewport.fromNode) || null;
        }
        return null;
    }

    private addSlice() {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        const slices = vpNode.parameters.slices ? [...vpNode.parameters.slices] : [];
        const bounds = getSliceBounds('xy', this.getMeshNode());
        const defaultOffset = (bounds.min + bounds.max) / 2.0;

        const defaultQty = 'pressure';
        let auto_scale = true;
        let min_val = 101325.0;
        let max_val = 101325.0 * 10.0;

        const ranges = vpNode.parameters.quantity_ranges || {};
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
            colormap: 'plasma',
            auto_scale,
            log_scale: false,
            interpolate: true,
            min_val,
            max_val
        });
        this.needsSlicesRebuild = true;
        this.updateSlices(slices);
    }

    private deleteSlice(index: number) {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        const slices = vpNode.parameters.slices ? [...vpNode.parameters.slices] : [];
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

    private updateSliceProperty(index: number, updates: any) {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        const slices = vpNode.parameters.slices ? [...vpNode.parameters.slices] : [];
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
                const ranges = vpNode.parameters.quantity_ranges || {};
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
            }

            this.propagateSliceQuantitySettings(slices, index, updates);
            this.updateSlices(slices);
        }
    }

    private syncControls() {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;

        const solverNode = this.getSolverNode();

        // Resolve connected DomainMesh3D
        const meshNode = this.getMeshNode();

        // 1. Sync Render Settings
        const gridCb = document.getElementById('viewport-grid-cb') as HTMLInputElement;
        if (gridCb && document.activeElement !== gridCb) gridCb.checked = vpNode.parameters.show_grid !== false;

        const edgesCb = document.getElementById('viewport-edges-cb') as HTMLInputElement;
        if (edgesCb && document.activeElement !== edgesCb) edgesCb.checked = !!vpNode.parameters.cell_edges;

        // FIX 1: Sync lighting/AO checkboxes and sliders from state
        const lightCb = document.getElementById('viewport-lighting-cb') as HTMLInputElement;
        if (lightCb && document.activeElement !== lightCb) lightCb.checked = vpNode.parameters.lightingEnabled !== false;

        const aoCb = document.getElementById('viewport-ao-cb') as HTMLInputElement;
        if (aoCb && document.activeElement !== aoCb) aoCb.checked = vpNode.parameters.aoEnabled !== false;

        const ambSlider = document.getElementById('viewport-ambient-slider') as HTMLInputElement;
        if (ambSlider && document.activeElement !== ambSlider) {
            const val = vpNode.parameters.ambientLevel ?? 0.3;
            ambSlider.value = String(val);
            const ambLabel = ambSlider.previousElementSibling as HTMLElement;
            if (ambLabel) ambLabel.innerHTML = `Ambient Level: ${Number(val).toFixed(2)}`;
        }

        const specSlider = document.getElementById('viewport-specular-slider') as HTMLInputElement;
        if (specSlider && document.activeElement !== specSlider) {
            const val = vpNode.parameters.specularIntensity ?? 0.4;
            specSlider.value = String(val);
            const specLabel = specSlider.previousElementSibling as HTMLElement;
            if (specLabel) specLabel.innerHTML = `Specular Level: ${Number(val).toFixed(2)}`;
        }

        const stlShowCb = document.getElementById('viewport-stl-show-cb') as HTMLInputElement;
        if (stlShowCb) stlShowCb.checked = vpNode.parameters.show_stl !== false;

        const stlWfCb = document.getElementById('viewport-stl-wf-cb') as HTMLInputElement;
        if (stlWfCb) stlWfCb.checked = !!vpNode.parameters.stl_wireframe;

        const stlSolidsCb = document.getElementById('viewport-stl-solids-cb') as HTMLInputElement;
        if (stlSolidsCb) stlSolidsCb.checked = vpNode.parameters.stl_solids !== false;

        const stlOpacSlider = document.getElementById('viewport-stl-opacity-slider') as HTMLInputElement;
        const stlOpacLabel = stlOpacSlider?.parentElement?.querySelector('span') as HTMLElement;
        if (stlOpacSlider && document.activeElement !== stlOpacSlider) {
            const val = vpNode.parameters.stl_opacity ?? 0.5;
            stlOpacSlider.value = val.toString();
            if (stlOpacLabel) stlOpacLabel.innerHTML = `Opacity: ${Number(val).toFixed(2)}`;
        }

        const stlPath = this.getSTLFilePath();
        if (stlPath !== this.currentSTLPath) {
            if (stlPath) {
                const net = (window as any).networkManager;
                if (net && net.isConnected()) {
                    this.currentSTLPath = stlPath;
                    net.send({ command: "LOAD_STL_GEOMETRY", filePath: stlPath, modelId: vpNode.id });
                }
            } else {
                this.currentSTLPath = null;
                this.worker.postMessage({ type: 'setSTLGeometry', data: { vertices: null } });
            }
        }

        // 2. Sync Slices Row list
        const slices = vpNode.parameters.slices || [];
        if (this.sliceListContainer) {
            const currentRows = this.sliceListContainer.children.length;
            // FIX 3: Force rebuild if slice structure changed externally (e.g. axis/qty changed from sidebar)
            const currSliceKey = slices.map((s: any) => `${s.axis}:${s.quantities?.[0]}`).join(',');
            if (currSliceKey !== this._lastSliceKey) {
                this.needsSlicesRebuild = true;
            }
            this._lastSliceKey = currSliceKey;
            if (this.needsSlicesRebuild || currentRows !== slices.length) {
                this.sliceListContainer.innerHTML = '';
                this.needsSlicesRebuild = false;
                const focusedSliceIndex = vpNode.parameters.focusedSliceIndex ?? 0;

                slices.forEach((slice: any, idx: number) => {
                    const qty = slice.quantities?.[0] || 'pressure';
                    const colormapVal = slice.colormap || 'plasma';
                    const autoScaleVal = slice.auto_scale !== false;
                    const logScaleVal = slice.log_scale === true;
                    const interpolateVal = slice.interpolate !== false;
                    
                    const ranges = vpNode.parameters.quantity_ranges || {};
                    const range = ranges[qty] || [slice.min_val, slice.max_val];
                    let minRangeVal = (range[0] !== undefined) ? range[0] : 101325.0;
                    let maxRangeVal = (range[1] !== undefined) ? range[1] : 101325.0 * 10.0;
                    if (autoScaleVal && this.latestSliceRanges && this.latestSliceRanges[idx]) {
                        minRangeVal = this.latestSliceRanges[idx].min;
                        maxRangeVal = this.latestSliceRanges[idx].max;
                    }
                    
                    const isExpanded = this.expandedSliceIndices.has(idx);

                    const row = document.createElement('div');
                    row.className = `slice-card-${idx}`;
                    row.style.background = idx === focusedSliceIndex ? 'rgba(0, 173, 255, 0.05)' : 'rgba(255,255,255,0.03)';
                    row.style.border = idx === focusedSliceIndex ? '1px solid #00adff' : '1px solid rgba(255,255,255,0.06)';
                    row.style.borderRadius = '4px';
                    row.style.padding = '6px';
                    row.style.display = 'flex';
                    row.style.flexDirection = 'column';
                    row.style.gap = '4px';
                    row.style.cursor = 'pointer';

                    row.onclick = (e) => {
                        const target = e.target as HTMLElement;
                        if (
                            target.closest('input') || 
                            target.closest('select') || 
                            target.closest('option') || 
                            target.closest('button') || 
                            target.closest('label')
                        ) {
                            return;
                        }
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { focusedSliceIndex: idx });
                    };

                    const rowHeader = document.createElement('div');
                    rowHeader.style.display = 'flex';
                    rowHeader.style.justifyContent = 'space-between';
                    rowHeader.style.alignItems = 'center';
                    
                    const titleSpan = document.createElement('span');
                    titleSpan.textContent = `Slice #${idx + 1}`;
                    titleSpan.style.color = '#ccc';
                    titleSpan.style.fontWeight = 'bold';
                    titleSpan.style.fontSize = '9px';
                    rowHeader.appendChild(titleSpan);

                    const toggleBtn = document.createElement('span');
                    toggleBtn.textContent = isExpanded ? '▲' : '⚙️';
                    toggleBtn.style.cursor = 'pointer';
                    toggleBtn.style.fontSize = '9px';
                    toggleBtn.onclick = (e) => {
                        e.stopPropagation();
                        if (this.expandedSliceIndices.has(idx)) this.expandedSliceIndices.delete(idx);
                        else this.expandedSliceIndices.add(idx);
                        this.needsSlicesRebuild = true;
                        this.syncControls();
                    };
                    rowHeader.appendChild(toggleBtn);
                    row.appendChild(rowHeader);

                    const grid = document.createElement('div');
                    grid.style.display = 'grid';
                    grid.style.gridTemplateColumns = '1fr 1.2fr 1fr';
                    grid.style.gap = '4px';

                    const axisSel = document.createElement('select');
                    // FIX 2: Add class so fast-path syncControls can find and update it
                    axisSel.className = 'slice-axis-sel';
                    this.applySelectStyle(axisSel);
                    axisSel.innerHTML = '<option value="xy">XY</option><option value="xz">XZ</option><option value="yz">YZ</option>';
                    axisSel.value = slice.axis;
                    axisSel.onchange = () => this.updateSliceProperty(idx, { axis: axisSel.value });
                    grid.appendChild(axisSel);

                    const qSel = document.createElement('select');
                    qSel.className = 'slice-qty-sel';
                    this.applySelectStyle(qSel);
                    qSel.innerHTML = '<option value="pressure">Pressure</option><option value="density">Density</option><option value="velocity">Velocity</option><option value="energy">Energy</option><option value="species1">Products</option><option value="species2">Unburnt</option><option value="species3">Air</option><option value="solid">Solid Cells</option><option value="overpressure">Peak Overpressure</option><option value="impulse">Peak Impulse</option>';
                    qSel.value = qty;
                    qSel.onchange = () => this.updateSliceProperty(idx, { quantities: [qSel.value] });
                    grid.appendChild(qSel);

                    const strideSel = document.createElement('select');
                    this.applySelectStyle(strideSel);
                    strideSel.style.width = '100%';
                    strideSel.innerHTML = '<option value="1">1:1</option><option value="2">1:2</option><option value="4">1:4</option><option value="8">1:8</option><option value="16">1:16</option>';
                    strideSel.value = String(slice.stride || 1);
                    strideSel.onchange = (e) => {
                        e.stopPropagation();
                        this.updateSliceProperty(idx, { stride: Number(strideSel.value) });
                    };
                    grid.appendChild(strideSel);
                    row.appendChild(grid);

                    // Offset slider
                    const bounds = getSliceBounds(slice.axis, meshNode);
                    const stepVal = Math.max(0.001, (bounds.max - bounds.min) / 100);

                    const offWrap = document.createElement('div');
                    offWrap.onclick = (e) => e.stopPropagation();
                    offWrap.style.display = 'flex';
                    offWrap.style.alignItems = 'center';
                    offWrap.style.gap = '6px';
                    offWrap.innerHTML = '<span style="font-size:8px;color:#aaa;min-width:30px">Offset</span>';

                    const offSlider = document.createElement('input');
                    offSlider.id = `viewport-${this.panelId}-slice-offset-${idx}`;
                    offSlider.type = 'range';
                    offSlider.className = 'slice-offset-slider';
                    offSlider.min = bounds.min.toString();
                    offSlider.max = bounds.max.toString();
                    offSlider.step = stepVal.toString();
                    offSlider.value = slice.offset.toString();
                    offSlider.style.flex = '1';
                    offSlider.style.height = '3px';
                    offSlider.style.background = '#444';
                    offSlider.style.outline = 'none';

                    const offInp = document.createElement('input');
                    offInp.type = 'number';
                    offInp.className = 'slice-offset-val';
                    this.applyInputStyle(offInp);
                    offInp.style.width = '45px';
                    offInp.style.padding = '0px 2px';
                    offInp.style.textAlign = 'center';
                    offInp.value = slice.offset.toString();

                    offSlider.oninput = (e) => {
                        e.stopPropagation();
                        const val = Number(offSlider.value);
                        offInp.value = String(val);
                        
                        const vp = this.getViewportNode();
                        if (!vp) return;
                        const currentSlices = vp.parameters.slices ? [...vp.parameters.slices] : [];
                        if (currentSlices[idx]) {
                            currentSlices[idx] = { ...currentSlices[idx], offset: val };
                            this.updateSlices(currentSlices);
                        }
                    };

                    offInp.onchange = (e) => {
                        e.stopPropagation();
                        const val = Math.max(bounds.min, Math.min(bounds.max, Number(offInp.value)));
                        offSlider.value = val.toString();
                        offInp.value = val.toString();
                        this.updateSliceProperty(idx, { offset: val });
                    };

                    offWrap.appendChild(offSlider);
                    offWrap.appendChild(offInp);
                    row.appendChild(offWrap);

                    // Opacity Slider
                    const opacWrap = document.createElement('div');
                    opacWrap.onclick = (e) => e.stopPropagation();
                    opacWrap.style.display = 'flex';
                    opacWrap.style.alignItems = 'center';
                    opacWrap.style.gap = '6px';
                    opacWrap.style.marginTop = '4px';
                    opacWrap.innerHTML = '<span style="font-size:8px;color:#aaa;min-width:30px">Opacity</span>';

                    const opacSlider = document.createElement('input');
                    opacSlider.type = 'range';
                    opacSlider.className = 'slice-opac-slider';
                    opacSlider.min = '0';
                    opacSlider.max = '1';
                    opacSlider.step = '0.05';
                    opacSlider.value = (slice.opacity !== undefined ? slice.opacity : 1.0).toString();
                    opacSlider.style.flex = '1';
                    opacSlider.style.height = '3px';
                    opacSlider.style.background = '#444';
                    opacSlider.style.outline = 'none';

                    const opacInp = document.createElement('input');
                    opacInp.type = 'number';
                    opacInp.className = 'slice-opac-val';
                    this.applyInputStyle(opacInp);
                    opacInp.style.width = '45px';
                    opacInp.style.padding = '0px 2px';
                    opacInp.style.textAlign = 'center';
                    opacInp.value = (slice.opacity !== undefined ? slice.opacity : 1.0).toString();

                    opacSlider.oninput = (e) => {
                        e.stopPropagation();
                        const val = Number(opacSlider.value);
                        opacInp.value = String(val);
                        
                        const vp = this.getViewportNode();
                        if (!vp) return;
                        const currentSlices = vp.parameters.slices ? [...vp.parameters.slices] : [];
                        if (currentSlices[idx]) {
                            currentSlices[idx] = { ...currentSlices[idx], opacity: val };
                            this.updateSlices(currentSlices);
                        }
                    };

                    opacInp.onchange = (e) => {
                        e.stopPropagation();
                        const val = Math.max(0.0, Math.min(1.0, Number(opacInp.value)));
                        opacSlider.value = val.toString();
                        opacInp.value = val.toString();
                        this.updateSliceProperty(idx, { opacity: val });
                    };

                    opacWrap.appendChild(opacSlider);
                    opacWrap.appendChild(opacInp);
                    row.appendChild(opacWrap);

                    // Extended Sub-panel
                    if (isExpanded) {
                        const subPanel = document.createElement('div');
                        subPanel.style.borderTop = '1px solid rgba(255,255,255,0.06)';
                        subPanel.style.paddingTop = '6px';
                        subPanel.style.marginTop = '4px';
                        subPanel.style.display = 'flex';
                        subPanel.style.flexDirection = 'column';
                        subPanel.style.gap = '4px';

                        const createCheckbox = (labelStr: string, checkedVal: boolean, onCbChange: (v: boolean) => void) => {
                            const lbl = document.createElement('label');
                            lbl.style.display = 'flex';
                            lbl.style.alignItems = 'center';
                            lbl.style.gap = '4px';
                            lbl.style.fontSize = '9px';
                            lbl.style.color = '#ccc';
                            lbl.style.cursor = 'pointer';
                            const cb = document.createElement('input');
                            cb.type = 'checkbox';
                            cb.checked = checkedVal;
                            cb.style.margin = '0';
                            cb.onchange = () => onCbChange(cb.checked);
                            lbl.appendChild(cb);
                            lbl.appendChild(document.createTextNode(labelStr));
                            return lbl;
                        };

                        const cbGrid = document.createElement('div');
                        cbGrid.style.display = 'grid';
                        cbGrid.style.gridTemplateColumns = '1fr 1fr';
                        cbGrid.style.gap = '4px';

                        cbGrid.appendChild(createCheckbox('Auto Range', autoScaleVal, (val) => {
                            this.updateSliceProperty(idx, { auto_scale: val });
                        }));
                        cbGrid.appendChild(createCheckbox('Log Scale', logScaleVal, (val) => {
                            this.updateSliceProperty(idx, { log_scale: val });
                        }));
                        cbGrid.appendChild(createCheckbox('Interpolate', interpolateVal, (val) => {
                            this.updateSliceProperty(idx, { interpolate: val });
                        }));
                        subPanel.appendChild(cbGrid);

                        // Colormap Select Row
                        const cmRow = document.createElement('div');
                        cmRow.style.display = 'flex';
                        cmRow.style.justifyContent = 'space-between';
                        cmRow.style.alignItems = 'center';
                        cmRow.innerHTML = '<span style="font-size:9px;color:#aaa">Colormap</span>';
                        const cmSel = document.createElement('select');
                        cmSel.className = 'slice-colormap-sel';
                        this.applySelectStyle(cmSel);
                        cmSel.innerHTML = '<option value="plasma">Plasma</option><option value="viridis">Viridis</option>';
                        cmSel.value = colormapVal;
                        cmSel.onchange = (e) => {
                            e.stopPropagation();
                            this.updateSliceProperty(idx, { colormap: cmSel.value });
                        };
                        cmRow.appendChild(cmSel);
                        subPanel.appendChild(cmRow);

                        // Min / Max Inputs
                        const rangeRow = document.createElement('div');
                        rangeRow.style.display = 'flex';
                        rangeRow.style.gap = '4px';
                        rangeRow.style.alignItems = 'center';

                        const minLabel = document.createElement('span');
                        minLabel.textContent = 'Min:';
                        minLabel.style.color = '#888';
                        minLabel.style.fontSize = '8px';
                        rangeRow.appendChild(minLabel);

                        const minInput = document.createElement('input');
                        minInput.type = 'number';
                        minInput.className = 'action-btn slice-min-input';
                        minInput.value = String(minRangeVal);
                        minInput.disabled = autoScaleVal;
                        minInput.style.width = '45px';
                        minInput.style.background = autoScaleVal ? '#0c0c0d' : '#1a1a1c';
                        minInput.style.color = autoScaleVal ? '#666' : '#ccc';
                        minInput.style.border = '1px solid #333';
                        minInput.style.borderRadius = '3px';
                        minInput.style.fontSize = '8px';
                        minInput.style.padding = '1px';
                        minInput.onchange = (e) => {
                            e.stopPropagation();
                            this.updateSliceProperty(idx, { min_val: Number(minInput.value) });
                        };
                        rangeRow.appendChild(minInput);

                        const maxLabel = document.createElement('span');
                        maxLabel.textContent = 'Max:';
                        maxLabel.style.color = '#888';
                        maxLabel.style.fontSize = '8px';
                        rangeRow.appendChild(maxLabel);

                        const maxInput = document.createElement('input');
                        maxInput.type = 'number';
                        maxInput.className = 'action-btn slice-max-input';
                        maxInput.value = String(maxRangeVal);
                        maxInput.disabled = autoScaleVal;
                        maxInput.style.width = '48px';
                        maxInput.style.background = autoScaleVal ? '#0c0c0d' : '#1a1a1c';
                        maxInput.style.color = autoScaleVal ? '#666' : '#ccc';
                        maxInput.style.border = '1px solid #333';
                        maxInput.style.borderRadius = '3px';
                        maxInput.style.fontSize = '8px';
                        maxInput.style.padding = '1px';
                        maxInput.onchange = (e) => {
                            e.stopPropagation();
                            this.updateSliceProperty(idx, { max_val: Number(maxInput.value) });
                        };
                        rangeRow.appendChild(maxInput);

                        const scaleBtn = document.createElement('button');
                        scaleBtn.className = 'action-btn';
                        scaleBtn.innerHTML = '🎯';
                        scaleBtn.title = 'Scale to Current Frame';
                        scaleBtn.style.background = '#2c2c30';
                        scaleBtn.style.color = '#ccc';
                        scaleBtn.style.border = '1px solid #444';
                        scaleBtn.style.borderRadius = '3px';
                        scaleBtn.style.padding = '1px 3px';
                        scaleBtn.style.cursor = 'pointer';
                        scaleBtn.style.fontSize = '8px';
                        scaleBtn.onclick = (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            this.worker.postMessage({ type: 'scaleToCurrent', index: idx });
                        };
                        rangeRow.appendChild(scaleBtn);

                        subPanel.appendChild(rangeRow);
                        row.appendChild(subPanel);
                    }

                    this.sliceListContainer!.appendChild(row);
                });
                
                this.needsSlicesRebuild = false;
            } else {
                // Just sync values of existing inputs in place
                const focusedSliceIndex = vpNode.parameters.focusedSliceIndex ?? 0;
                slices.forEach((slice: any, idx: number) => {
                    const row = this.sliceListContainer!.children[idx] as HTMLElement;
                    if (!row) return;

                    const linkGroup = slice.link_group || 'none';

                    row.style.background = idx === focusedSliceIndex ? 'rgba(0, 173, 255, 0.05)' : 'rgba(255,255,255,0.03)';
                    row.style.border = idx === focusedSliceIndex ? '1px solid #00adff' : '1px solid rgba(255,255,255,0.06)';

                    const bounds = getSliceBounds(slice.axis, meshNode);

                    // Sync basic selects if not active
                    const axisSel = row.querySelector('.slice-axis-sel') as HTMLSelectElement;
                    if (axisSel && document.activeElement !== axisSel) {
                        axisSel.value = slice.axis;
                    }
                    const qSel = row.querySelector('.slice-qty-sel') as HTMLSelectElement;
                    if (qSel && document.activeElement !== qSel) {
                        qSel.value = slice.quantities?.[0] || 'pressure';
                    }
                    const strideSel = row.querySelector('.slice-stride-sel') as HTMLSelectElement;
                    if (strideSel && document.activeElement !== strideSel) {
                        strideSel.value = String(slice.stride || 1);
                    }

                    // Sync sliders
                    const offSlider = row.querySelector('.slice-offset-slider') as HTMLInputElement;
                    if (offSlider) {
                        offSlider.min = bounds.min.toString();
                        offSlider.max = bounds.max.toString();
                        offSlider.step = Math.max(0.001, (bounds.max - bounds.min) / 100).toString();
                        if (document.activeElement !== offSlider) {
                            offSlider.value = slice.offset.toString();
                        }
                    }
                    const offInp = row.querySelector('.slice-offset-val') as HTMLInputElement;
                    if (offInp && document.activeElement !== offInp) {
                        offInp.value = slice.offset.toString();
                    }

                    const opacSlider = row.querySelector('.slice-opac-slider') as HTMLInputElement;
                    if (opacSlider && document.activeElement !== opacSlider) {
                        opacSlider.value = (slice.opacity !== undefined ? slice.opacity : 1.0).toString();
                    }
                    const opacInp = row.querySelector('.slice-opac-val') as HTMLInputElement;
                    if (opacInp && document.activeElement !== opacInp) {
                        opacInp.value = (slice.opacity !== undefined ? slice.opacity : 1.0).toString();
                    }

                    // Sync sub-panel inputs if expanded
                    const autoScaleVal = slice.auto_scale !== false;
                    let minRangeVal = slice.min_val !== undefined ? slice.min_val : 101325.0;
                    let maxRangeVal = slice.max_val !== undefined ? slice.max_val : 101325.0 * 10.0;
                    if (autoScaleVal && this.latestSliceRanges && this.latestSliceRanges[idx]) {
                        minRangeVal = this.latestSliceRanges[idx].min;
                        maxRangeVal = this.latestSliceRanges[idx].max;
                    }

                    // Sync checkboxes
                    const checkboxes = row.querySelectorAll('input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
                    if (checkboxes.length >= 3) {
                        checkboxes[0].checked = autoScaleVal;
                        checkboxes[1].checked = slice.log_scale === true;
                        checkboxes[2].checked = slice.interpolate !== false;
                    }

                    // Sync colormap
                    const cmSel = row.querySelector('.slice-colormap-sel') as HTMLSelectElement;
                    if (cmSel && document.activeElement !== cmSel) {
                        cmSel.value = slice.colormap || 'plasma';
                    }

                    // Sync min / max inputs
                    const minInput = row.querySelector('.slice-min-input') as HTMLInputElement;
                    if (minInput) {
                        minInput.disabled = autoScaleVal;
                        minInput.style.background = autoScaleVal ? '#0c0c0d' : '#1a1a1c';
                        minInput.style.color = autoScaleVal ? '#666' : '#ccc';
                        if (document.activeElement !== minInput) {
                            minInput.value = String(minRangeVal);
                        }
                    }

                    const maxInput = row.querySelector('.slice-max-input') as HTMLInputElement;
                    if (maxInput) {
                        maxInput.disabled = autoScaleVal;
                        maxInput.style.background = autoScaleVal ? '#0c0c0d' : '#1a1a1c';
                        maxInput.style.color = autoScaleVal ? '#666' : '#ccc';
                        if (document.activeElement !== maxInput) {
                            maxInput.value = String(maxRangeVal);
                        }
                    }
                });
            }

            // Sync configuration to WebWorker
            const opacities = slices.map((s: any) => s.opacity !== undefined ? s.opacity : 1.0);
            this.worker.postMessage({
                type: 'setConfig',
                data: {
                    lightingEnabled: vpNode.parameters.lightingEnabled !== false,
                    aoEnabled: vpNode.parameters.aoEnabled !== false,
                    ambientLevel: vpNode.parameters.ambientLevel ?? 0.3,
                    specularIntensity: vpNode.parameters.specularIntensity ?? 0.4,
                    sliceOpacities: opacities,
                    slices: slices,
                    focusedSliceIndex: vpNode.parameters.focusedSliceIndex ?? 0,
                    quantityRanges: vpNode.parameters.quantity_ranges || {}
                }
            });
        }

        // 3. Sync Solver parameters
        if (solverNode) {
            const devSel = document.getElementById('solver-device-sel') as HTMLSelectElement;
            if (devSel && document.activeElement !== devSel) {
                devSel.value = solverNode.parameters.device || 'cpu';
            }

            const initSel = document.getElementById('solver-initmode-sel') as HTMLSelectElement;
            if (initSel && document.activeElement !== initSel) {
                initSel.value = solverNode.parameters.init_mode || 'From1D';
            }

            const fluxSel = document.getElementById('solver-flux-sel') as HTMLSelectElement;
            if (fluxSel && document.activeElement !== fluxSel) {
                fluxSel.value = solverNode.parameters.flux_scheme || 'AUSM+';
            }

            const spSel = document.getElementById('solver-sporder-sel') as HTMLSelectElement;
            if (spSel && document.activeElement !== spSel) {
                spSel.value = (solverNode.parameters.spatial_order ?? 2).toString();
            }

            const tempSel = document.getElementById('solver-temporder-sel') as HTMLSelectElement;
            if (tempSel && document.activeElement !== tempSel) {
                tempSel.value = (solverNode.parameters.temporal_order ?? 2).toString();
            }
        }

        // 4. Find connected domain mesh dimensions and configure worker
        let dimX = 1.0, dimY = 1.0, dimZ = 1.0, cellSize = 0.01;
        let xmin = 0.0, ymin = 0.0, zmin = 0.0;
        if (meshNode && meshNode.type === 'DomainMesh3D') {
            xmin = Number(meshNode.parameters?.xmin ?? 0.0);
            const xmax = Number(meshNode.parameters?.xmax ?? 1.0);
            ymin = Number(meshNode.parameters?.ymin ?? 0.0);
            const ymax = Number(meshNode.parameters?.ymax ?? 1.0);
            zmin = Number(meshNode.parameters?.zmin ?? 0.0);
            const zmax = Number(meshNode.parameters?.zmax ?? 1.0);
            dimX = xmax - xmin;
            dimY = ymax - ymin;
            dimZ = zmax - zmin;
            cellSize = Number(meshNode.parameters?.cell_size ?? 0.01);
        }
        const nx = Math.round(dimX / cellSize);
        const ny = Math.round(dimY / cellSize);
        const nz = Math.round(dimZ / cellSize);

        const { min: syncFocusedMin, max: syncFocusedMax } = getFocusedQuantityAndRange(vpNode);

        const configData: any = {
            colormap: vpNode.parameters.colormap || 'plasma',
            minY: syncFocusedMin,
            maxY: syncFocusedMax,
            autoScale: vpNode.parameters.auto_scale !== false,
            showGrid: vpNode.parameters.show_grid !== false,
            useLogScale: vpNode.parameters.log_scale === true,
            showCellEdges: vpNode.parameters.cell_edges === true,
            interpolate: vpNode.parameters.interpolate === true,
            showSTL: vpNode.parameters.show_stl !== false,
            stlWireframe: !!vpNode.parameters.stl_wireframe,
            stlSolids: vpNode.parameters.stl_solids !== false,
            stlOpacity: vpNode.parameters.stl_opacity ?? 0.5,
            slices: vpNode.parameters.slices || [],
            focusedSliceIndex: vpNode.parameters.focusedSliceIndex ?? 0,
            quantityRanges: vpNode.parameters.quantity_ranges || {}
        };

        if (!this.hasTelemetryGrid) {
            configData.xmin = xmin;
            configData.ymin = ymin;
            configData.zmin = zmin;
            configData.dx = cellSize;
            configData.nx = nx;
            configData.ny = ny;
            configData.nz = nz;
        }

        this.worker.postMessage({
            type: 'setConfig',
            data: configData
        });
    }

    public pushFrame(buffer: ArrayBuffer) {
        this.worker.postMessage({ type: 'frame', data: { buffer } }, [buffer]);
    }

    public updateTelemetry(data: any) {
        if (data && data.type === 'TELEMETRY_3D') {
            this.hasTelemetryGrid = true;
            this.worker.postMessage({
                type: 'setConfig',
                data: {
                    xmin: data.xmin ?? 0.0,
                    ymin: data.ymin ?? 0.0,
                    zmin: data.zmin ?? 0.0,
                    dx: data.dx ?? data.cell_size ?? 0.01,
                    nx: data.nx ?? 64,
                    ny: data.ny ?? 64,
                    nz: data.nz ?? 64
                }
            });
        }
    }

    public attachTo(container: HTMLElement) {
        this.container = container;
        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';

        if (this.canvas.parentNode !== this.container) {
            this.container.appendChild(this.canvas);
        }
        if (this.controlsOverlay && this.controlsOverlay.parentNode !== this.container) {
            this.container.appendChild(this.controlsOverlay);
        }
        if (this.floatOpenBtn && this.floatOpenBtn.parentNode !== this.container) {
            this.container.appendChild(this.floatOpenBtn);
        }
        if (this.debugOverlay && this.debugOverlay.parentNode !== this.container) {
            this.container.appendChild(this.debugOverlay);
        }
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
        showCb.id = 'viewport-stl-show-cb';
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
        wfCb.id = 'viewport-stl-wf-cb';
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
        solidsCb.id = 'viewport-stl-solids-cb';
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
        opacSlider.id = 'viewport-stl-opacity-slider';
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

    private getSTLFilePath(): string | null {
        const vpNode = this.getViewportNode();
        if (!vpNode) return null;

        // Find which model in the workspace contains this viewport node
        const allModels = this.stateManager.getWorkspaceModels();
        let targetModel: any = null;
        for (const m of allModels) {
            if (m.nodes.some(n => n.id === vpNode.id)) {
                targetModel = m;
                break;
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
        return null;
    }

    public setSTLGeometry(vertices: Float32Array | null): void {
        this.worker.postMessage({
            type: 'setSTLGeometry',
            data: { vertices }
        });
    }

    public destroy() {
        this.stateManager.offStateChange(this.stateListener);
        const net = (window as any).networkManager;
        if (net) {
            if (this.netCallback) net.offMessage(this.netCallback);
            if (this.openListener) net.offOpen(this.openListener);
        }
        this.worker.terminate();
        this.canvas.remove();
        if (this.controlsOverlay) this.controlsOverlay.remove();
        if (this.floatOpenBtn) this.floatOpenBtn.remove();
    }
}

function getSliceBounds(axis: string, meshNode: any) {
    let min = 0.0;
    let max = 1.0;
    if (meshNode && meshNode.type === 'DomainMesh3D') {
        const xmin = Number(meshNode.parameters?.xmin ?? 0.0);
        const xmax = Number(meshNode.parameters?.xmax ?? 1.0);
        const ymin = Number(meshNode.parameters?.ymin ?? 0.0);
        const ymax = Number(meshNode.parameters?.ymax ?? 1.0);
        const zmin = Number(meshNode.parameters?.zmin ?? 0.0);
        const zmax = Number(meshNode.parameters?.zmax ?? 1.0);
        if (axis === 'xy') {
            min = zmin;
            max = zmax;
        } else if (axis === 'xz') {
            min = ymin;
            max = ymax;
        } else if (axis === 'yz') {
            min = xmin;
            max = xmax;
        }
    }
    return { min, max };
}

