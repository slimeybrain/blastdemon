import { Node, PanelType } from './types.js';
import { StateManager } from './state-manager.js';

const DEFAULT_QUANTITY_RANGES: Record<string, [number, number]> = {
    pressure: [101325.0, 101325.0 * 100.0],
    density: [1.2, 100.0],
    velocity: [0.0, 1000.0],
    energy: [200000.0, 10000000.0],
    species1: [0.0, 1.0],
    species2: [0.0, 1.0],
    species3: [0.0, 1.0]
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

    // Overlay Elements
    private controlsOverlay: HTMLElement | null = null;
    private floatOpenBtn: HTMLElement | null = null;
    private sliceListContainer: HTMLElement | null = null;
    private expandedSliceIndices = new Set<number>();
    private needsSlicesRebuild = true;
    private isOpen = true;

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
                    const { quantity: focusedQty } = getFocusedQuantityAndRange(vpNode);
                    const ranges = { ...(vpNode.parameters.quantity_ranges || {}) };
                    ranges[focusedQty] = [min, max];
                    this.stateManager.updateNodeParameters(vpNode.id, {
                        auto_scale: false,
                        quantity_ranges: ranges,
                        min_val: min,
                        max_val: max
                    });
                }
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

        new ResizeObserver(entries => {
            for (let entry of entries) {
                this.worker.postMessage({
                    type: 'resize',
                    data: {
                        width: entry.contentRect.width,
                        height: entry.contentRect.height
                    }
                });
            }
        }).observe(this.container);

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
        // Grid (bbox) toggle
        const gridRow = document.createElement('label');
        gridRow.style.display = 'flex';
        gridRow.style.alignItems = 'center';
        gridRow.style.gap = '6px';
        gridRow.style.cursor = 'pointer';
        
        const gridCb = document.createElement('input');
        gridCb.type = 'checkbox';
        gridCb.id = 'viewport-grid-cb';
        gridCb.onchange = () => {
            const vpNode = this.getViewportNode();
            if (vpNode) {
                this.stateManager.updateNodeParameters(vpNode.id, { show_grid: gridCb.checked });
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
        edgesCb.onchange = () => {
            const vpNode = this.getViewportNode();
            if (vpNode) {
                this.stateManager.updateNodeParameters(vpNode.id, { cell_edges: edgesCb.checked });
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
        // Lighting toggle
        const lightRow = document.createElement('label');
        lightRow.style.display = 'flex';
        lightRow.style.alignItems = 'center';
        lightRow.style.gap = '6px';
        lightRow.style.cursor = 'pointer';
        
        const lightCb = document.createElement('input');
        lightCb.type = 'checkbox';
        lightCb.id = 'viewport-lighting-cb';
        lightCb.onchange = () => {
            const vpNode = this.getViewportNode();
            if (vpNode) {
                this.stateManager.updateNodeParameters(vpNode.id, { lightingEnabled: lightCb.checked });
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
        aoCb.onchange = () => {
            const vpNode = this.getViewportNode();
            if (vpNode) {
                this.stateManager.updateNodeParameters(vpNode.id, { aoEnabled: aoCb.checked });
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
        
        const ambSlider = document.createElement('input');
        ambSlider.type = 'range';
        ambSlider.id = 'viewport-ambient-slider';
        ambSlider.min = '0';
        ambSlider.max = '1';
        ambSlider.step = '0.05';
        ambSlider.style.width = '100%';
        ambSlider.oninput = () => {
            ambLabel.innerHTML = `Ambient Level: ${Number(ambSlider.value).toFixed(2)}`;
            const vpNode = this.getViewportNode();
            if (vpNode) {
                this.stateManager.updateNodeParameters(vpNode.id, { ambientLevel: Number(ambSlider.value) });
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
        
        const specSlider = document.createElement('input');
        specSlider.type = 'range';
        specSlider.id = 'viewport-specular-slider';
        specSlider.min = '0';
        specSlider.max = '1';
        specSlider.step = '0.05';
        specSlider.style.width = '100%';
        specSlider.oninput = () => {
            specLabel.innerHTML = `Specular Level: ${Number(specSlider.value).toFixed(2)}`;
            const vpNode = this.getViewportNode();
            if (vpNode) {
                this.stateManager.updateNodeParameters(vpNode.id, { specularIntensity: Number(specSlider.value) });
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
        if (!ws || !ws.activeModelId) return null;
        const state = this.stateManager.getSimulationState(ws.activeModelId);
        return state?.nodes.find(n => n.type === 'Telemetry3DViewport') || null;
    }

    private getSolverNode(): Node | null {
        const ws = this.stateManager.getActiveWorkspace();
        if (!ws || !ws.activeModelId) return null;
        const state = this.stateManager.getSimulationState(ws.activeModelId);
        return state?.nodes.find(n => n.type === 'CFDSolver3D') || null;
    }

    private updateSlices(slices: any[]) {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        this.stateManager.updateNodeParametersInPlace(vpNode.id, { slices });
        
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
        const state = this.stateManager.getCurrentState();
        if (state) {
            const connToViewport = state.connections.find(c => c.toNode === vpNode.id);
            if (connToViewport) {
                const solverNode = state.nodes.find(n => n.id === connToViewport.fromNode);
                if (solverNode) {
                    const connToSolver = state.connections.find(c => c.toNode === solverNode.id && c.toPort === 'mesh');
                    if (connToSolver) {
                        return state.nodes.find(n => n.id === connToSolver.fromNode) || null;
                    }
                }
            }
        }
        return null;
    }

    private addSlice() {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        const slices = vpNode.parameters.slices ? [...vpNode.parameters.slices] : [];
        const bounds = getSliceBounds('xy', this.getMeshNode());
        const defaultOffset = (bounds.min + bounds.max) / 2.0;
        slices.push({
            axis: 'xy',
            offset: defaultOffset,
            quantities: ['pressure'],
            stride: 1,
            opacity: 1.0,
            colormap: 'plasma',
            auto_scale: true,
            log_scale: false,
            interpolate: true,
            min_val: 101325.0,
            max_val: 101325.0 * 10.0,
            link_group: 'none'
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

    private updateSliceProperty(index: number, updates: any) {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        const slices = vpNode.parameters.slices ? [...vpNode.parameters.slices] : [];
        if (slices.length > index) {
            slices[index] = { ...slices[index], ...updates };
            
            // Handle Link Group Settings propagation
            if (updates.link_group !== undefined) {
                const newGroup = updates.link_group;
                if (newGroup !== 'none') {
                    const match = slices.find((s, i) => i !== index && s.link_group === newGroup);
                    if (match) {
                        const keysToCopy = ['quantities', 'stride', 'offset', 'opacity', 'auto_scale', 'log_scale', 'interpolate', 'colormap', 'min_val', 'max_val'];
                        keysToCopy.forEach(k => {
                            if (k === 'quantities') {
                                slices[index].quantities = [...match.quantities];
                            } else {
                                slices[index][k] = match[k];
                            }
                        });
                    }
                }
            } else {
                const group = slices[index].link_group || 'none';
                if (group !== 'none') {
                    const key = Object.keys(updates)[0];
                    if (key) {
                        slices.forEach((s, i) => {
                            if (i !== index && s.link_group === group) {
                                if (key === 'quantities') {
                                    slices[i].quantities = [...updates.quantities];
                                } else {
                                    slices[i][key] = updates[key];
                                }
                            }
                        });
                    }
                }
            }
            this.needsSlicesRebuild = true;
            this.updateSlices(slices);
        }
    }

    private syncControls() {
        const vpNode = this.getViewportNode();
        const solverNode = this.getSolverNode();
        if (!vpNode) return;

        // Resolve connected DomainMesh3D
        let meshNode: any = null;
        const state = this.stateManager.getCurrentState();
        if (state) {
            const connToViewport = state.connections.find(c => c.toNode === vpNode.id);
            if (connToViewport) {
                const solverNode = state.nodes.find(n => n.id === connToViewport.fromNode);
                if (solverNode) {
                    const connToSolver = state.connections.find(c => c.toNode === solverNode.id && c.toPort === 'mesh');
                    if (connToSolver) {
                        meshNode = state.nodes.find(n => n.id === connToSolver.fromNode);
                    }
                }
            }
        }

        // 1. Sync Render Settings
        const gridCb = document.getElementById('viewport-grid-cb') as HTMLInputElement;
        if (gridCb && document.activeElement !== gridCb) {
            gridCb.checked = vpNode.parameters.show_grid !== false;
        }

        // 1.1 Sync Lighting & Shadows
        const lightCb = document.getElementById('viewport-lighting-cb') as HTMLInputElement;
        if (lightCb && document.activeElement !== lightCb) {
            lightCb.checked = vpNode.parameters.lightingEnabled !== false;
        }

        const aoCb = document.getElementById('viewport-ao-cb') as HTMLInputElement;
        if (aoCb && document.activeElement !== aoCb) {
            aoCb.checked = vpNode.parameters.aoEnabled !== false;
        }

        const ambSlider = document.getElementById('viewport-ambient-slider') as HTMLInputElement;
        const ambLabel = ambSlider?.parentElement?.querySelector('span') as HTMLElement;
        if (ambSlider && document.activeElement !== ambSlider) {
            const val = vpNode.parameters.ambientLevel ?? 0.3;
            ambSlider.value = val.toString();
            if (ambLabel) ambLabel.innerHTML = `Ambient Level: ${Number(val).toFixed(2)}`;
        }

        const specSlider = document.getElementById('viewport-specular-slider') as HTMLInputElement;
        const specLabel = specSlider?.parentElement?.querySelector('span') as HTMLElement;
        if (specSlider && document.activeElement !== specSlider) {
            const val = vpNode.parameters.specularIntensity ?? 0.4;
            specSlider.value = val.toString();
            if (specLabel) specLabel.innerHTML = `Specular Level: ${Number(val).toFixed(2)}`;
        }

        const edgesCb = document.getElementById('viewport-edges-cb') as HTMLInputElement;
        if (edgesCb && document.activeElement !== edgesCb) {
            edgesCb.checked = vpNode.parameters.cell_edges === true;
        }
        // 2. Sync Slices Row list
        const slices = vpNode.parameters.slices || [];
        if (this.sliceListContainer) {
            const currentRows = this.sliceListContainer.children.length;
            if (this.needsSlicesRebuild || currentRows !== slices.length) {
                this.sliceListContainer.innerHTML = '';
                const focusedSliceIndex = vpNode.parameters.focusedSliceIndex ?? 0;
                
                slices.forEach((slice: any, idx: number) => {
                    // Apply defaults
                    const colormapVal = slice.colormap || 'plasma';
                    const autoScaleVal = slice.auto_scale !== false;
                    const logScaleVal = slice.log_scale === true;
                    const interpolateVal = slice.interpolate !== false;
                    const minRangeVal = slice.min_val !== undefined ? slice.min_val : 101325.0;
                    const maxRangeVal = slice.max_val !== undefined ? slice.max_val : 101325.0 * 10.0;
                    const linkGroup = slice.link_group || 'none';
                    const isExpanded = this.expandedSliceIndices.has(idx);

                    const row = document.createElement('div');
                    row.className = `slice-card-${idx}`;
                    
                    // Link Group styling
                    let borderColor = 'rgba(255,255,255,0.06)';
                    let leftBorder = '1px solid rgba(255,255,255,0.06)';
                    let glowColor = '';
                    if (linkGroup === 'A') {
                        leftBorder = '3px solid #3b82f6';
                        borderColor = 'rgba(59, 130, 246, 0.4)';
                        glowColor = 'rgba(59, 130, 246, 0.05)';
                    } else if (linkGroup === 'B') {
                        leftBorder = '3px solid #10b981';
                        borderColor = 'rgba(16, 185, 129, 0.4)';
                        glowColor = 'rgba(16, 185, 129, 0.05)';
                    } else if (linkGroup === 'C') {
                        leftBorder = '3px solid #f59e0b';
                        borderColor = 'rgba(245, 158, 11, 0.4)';
                        glowColor = 'rgba(245, 158, 11, 0.05)';
                    }

                    row.style.background = glowColor || (idx === focusedSliceIndex ? 'rgba(0, 173, 255, 0.05)' : 'rgba(255,255,255,0.03)');
                    row.style.border = idx === focusedSliceIndex ? '1px solid #00adff' : `1px solid ${borderColor}`;
                    row.style.borderLeft = leftBorder;
                    row.style.borderRadius = '4px';
                    row.style.padding = '6px';
                    row.style.display = 'flex';
                    row.style.flexDirection = 'column';
                    row.style.gap = '4px';
                    row.style.cursor = 'pointer';

                    row.onclick = (e) => {
                        const target = e.target as HTMLElement;
                        if (target.tagName === 'SELECT' || target.tagName === 'INPUT' || target.tagName === 'BUTTON' || target.classList.contains('action-btn')) {
                            return;
                        }
                        this.stateManager.updateNodeParameters(vpNode.id, { focusedSliceIndex: idx });
                    };

                    // Header
                    const rowHeader = document.createElement('div');
                    rowHeader.style.display = 'flex';
                    rowHeader.style.justifyContent = 'space-between';
                    rowHeader.style.alignItems = 'center';
                    rowHeader.style.gap = '4px';

                    const linkSel = document.createElement('select');
                    linkSel.className = 'action-btn';
                    linkSel.style.background = linkGroup === 'none' ? '#1a1a1c' : (linkGroup === 'A' ? '#1e3a8a' : (linkGroup === 'B' ? '#064e3b' : '#78350f'));
                    linkSel.style.color = '#ccc';
                    linkSel.style.border = '1px solid #333';
                    linkSel.style.borderRadius = '3px';
                    linkSel.style.fontSize = '8px';
                    linkSel.style.padding = '0px 2px';
                    linkSel.style.cursor = 'pointer';
                    linkSel.innerHTML = `
                        <option value="none">🔗 Unlinked</option>
                        <option value="A">🔗 Link A</option>
                        <option value="B">🔗 Link B</option>
                        <option value="C">🔗 Link C</option>
                    `;
                    linkSel.value = linkGroup;
                    linkSel.onchange = (e) => {
                        e.stopPropagation();
                        this.updateSliceProperty(idx, { link_group: linkSel.value });
                    };
                    rowHeader.appendChild(linkSel);

                    const titleSpan = document.createElement('span');
                    titleSpan.textContent = `Slice #${idx + 1}`;
                    titleSpan.style.color = '#ccc';
                    titleSpan.style.fontWeight = 'bold';
                    titleSpan.style.fontSize = '9px';
                    titleSpan.style.flex = '1';
                    titleSpan.style.marginLeft = '4px';
                    rowHeader.appendChild(titleSpan);

                    const toggleBtn = document.createElement('span');
                    toggleBtn.className = 'action-btn';
                    toggleBtn.textContent = isExpanded ? '▲' : '⚙️';
                    toggleBtn.title = 'Settings';
                    toggleBtn.style.cursor = 'pointer';
                    toggleBtn.style.fontSize = '9px';
                    toggleBtn.style.color = '#888';
                    toggleBtn.style.padding = '0 4px';
                    toggleBtn.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (this.expandedSliceIndices.has(idx)) {
                            this.expandedSliceIndices.delete(idx);
                        } else {
                            this.expandedSliceIndices.add(idx);
                        }
                        this.needsSlicesRebuild = true;
                        this.syncControls();
                    };
                    rowHeader.appendChild(toggleBtn);

                    const delBtn = document.createElement('button');
                    delBtn.innerHTML = '🗑️';
                    delBtn.style.background = 'none';
                    delBtn.style.border = 'none';
                    delBtn.style.color = '#d9534f';
                    delBtn.style.cursor = 'pointer';
                    delBtn.style.fontSize = '10px';
                    delBtn.onclick = (e) => {
                        e.stopPropagation();
                        this.deleteSlice(idx);
                    };
                    rowHeader.appendChild(delBtn);
                    row.appendChild(rowHeader);

                    // Controls Grid
                    const grid = document.createElement('div');
                    grid.style.display = 'grid';
                    grid.style.gridTemplateColumns = '1fr 1.2fr 1fr';
                    grid.style.gap = '4px';

                    const axisSel = document.createElement('select');
                    this.applySelectStyle(axisSel);
                    axisSel.style.width = '100%';
                    axisSel.innerHTML = '<option value="xy">XY</option><option value="xz">XZ</option><option value="yz">YZ</option>';
                    axisSel.value = slice.axis;
                    axisSel.onchange = (e) => {
                        e.stopPropagation();
                        const bounds = getSliceBounds(axisSel.value, meshNode);
                        const defaultOffset = (bounds.min + bounds.max) / 2.0;
                        
                        const updated = [...slices];
                        updated[idx] = { ...slice, axis: axisSel.value, offset: defaultOffset };
                        
                        if (linkGroup !== 'none') {
                            updated.forEach((s, i) => {
                                if (i !== idx && s.link_group === linkGroup) {
                                    updated[i].axis = axisSel.value;
                                    updated[i].offset = defaultOffset;
                                }
                            });
                        }
                        
                        this.needsSlicesRebuild = true;
                        this.updateSlices(updated);
                    };
                    grid.appendChild(axisSel);

                    const qSel = document.createElement('select');
                    this.applySelectStyle(qSel);
                    qSel.style.width = '100%';
                    qSel.innerHTML = '<option value="pressure">Pressure</option><option value="density">Density</option><option value="velocity">Velocity</option><option value="energy">Energy</option><option value="species1">Products</option><option value="species2">Unburnt</option><option value="species3">Air</option>';
                    qSel.value = slice.quantities?.[0] || 'pressure';
                    qSel.onchange = (e) => {
                        e.stopPropagation();
                        this.updateSliceProperty(idx, { quantities: [qSel.value] });
                    };
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
                    offWrap.style.display = 'flex';
                    offWrap.style.alignItems = 'center';
                    offWrap.style.gap = '6px';
                    offWrap.innerHTML = '<span style="font-size:8px;color:#aaa;min-width:30px">Offset</span>';

                    const offSlider = document.createElement('input');
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
                        slice.offset = val;
                        
                        if (linkGroup !== 'none') {
                            slices.forEach((s: any, i: number) => {
                                if (i !== idx && s.link_group === linkGroup) {
                                    s.offset = val;
                                    const otherRow = this.sliceListContainer!.querySelector(`.slice-card-${i}`) as HTMLElement;
                                    if (otherRow) {
                                        const otherSlider = otherRow.querySelector('.slice-offset-slider') as HTMLInputElement;
                                        const otherVal = otherRow.querySelector('.slice-offset-val') as HTMLInputElement;
                                        if (otherSlider) otherSlider.value = String(val);
                                        if (otherVal) otherVal.value = String(val);
                                    }
                                }
                            });
                        }
                        this.worker.postMessage({
                            type: 'setConfig',
                            data: {
                                slices: slices,
                                focusedSliceIndex: vpNode.parameters.focusedSliceIndex ?? 0,
                                quantityRanges: vpNode.parameters.quantity_ranges || {}
                            }
                        });
                    };
                    offSlider.onchange = (e) => {
                        e.stopPropagation();
                        this.updateSlices(slices);
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
                        slice.opacity = val;
                        
                        if (linkGroup !== 'none') {
                            slices.forEach((s: any, i: number) => {
                                if (i !== idx && s.link_group === linkGroup) {
                                    s.opacity = val;
                                    const otherRow = this.sliceListContainer!.querySelector(`.slice-card-${i}`) as HTMLElement;
                                    if (otherRow) {
                                        const otherSlider = otherRow.querySelector('.slice-opac-slider') as HTMLInputElement;
                                        const otherVal = otherRow.querySelector('.slice-opac-val') as HTMLInputElement;
                                        if (otherSlider) otherSlider.value = String(val);
                                        if (otherVal) otherVal.value = String(val);
                                    }
                                }
                            });
                        }
                        const opacities = slices.map((s: any) => s.opacity !== undefined ? s.opacity : 1.0);
                        this.worker.postMessage({ type: 'setConfig', data: { sliceOpacities: opacities } });
                    };
                    opacSlider.onchange = (e) => {
                        e.stopPropagation();
                        this.updateSlices(slices);
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
                        minInput.className = 'action-btn';
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
                        maxInput.className = 'action-btn';
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

                    // Sync borders
                    let borderColor = 'rgba(255,255,255,0.06)';
                    let leftBorder = '1px solid rgba(255,255,255,0.06)';
                    let glowColor = '';
                    if (linkGroup === 'A') {
                        leftBorder = '3px solid #3b82f6';
                        borderColor = 'rgba(59, 130, 246, 0.4)';
                        glowColor = 'rgba(59, 130, 246, 0.05)';
                    } else if (linkGroup === 'B') {
                        leftBorder = '3px solid #10b981';
                        borderColor = 'rgba(16, 185, 129, 0.4)';
                        glowColor = 'rgba(16, 185, 129, 0.05)';
                    } else if (linkGroup === 'C') {
                        leftBorder = '3px solid #f59e0b';
                        borderColor = 'rgba(245, 158, 11, 0.4)';
                        glowColor = 'rgba(245, 158, 11, 0.05)';
                    }

                    row.style.background = glowColor || (idx === focusedSliceIndex ? 'rgba(0, 173, 255, 0.05)' : 'rgba(255,255,255,0.03)');
                    row.style.border = idx === focusedSliceIndex ? '1px solid #00adff' : `1px solid ${borderColor}`;
                    row.style.borderLeft = leftBorder;

                    const bounds = getSliceBounds(slice.axis, meshNode);

                    // Sync basic selects if not active
                    const axisSel = row.querySelector('select:nth-of-type(2)') as HTMLSelectElement;
                    if (axisSel && document.activeElement !== axisSel) {
                        axisSel.value = slice.axis;
                    }
                    const qSel = row.querySelector('select:nth-of-type(3)') as HTMLSelectElement;
                    if (qSel && document.activeElement !== qSel) {
                        qSel.value = slice.quantities?.[0] || 'pressure';
                    }
                    const strideSel = row.querySelector('select:nth-of-type(4)') as HTMLSelectElement;
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
            dimX = Number(meshNode.parameters?.dim_x ?? 1.0);
            dimY = Number(meshNode.parameters?.dim_y ?? 1.0);
            dimZ = Number(meshNode.parameters?.dim_z ?? 1.0);
            xmin = Number(meshNode.parameters?.origin_x ?? 0.0);
            ymin = Number(meshNode.parameters?.origin_y ?? 0.0);
            zmin = Number(meshNode.parameters?.origin_z ?? 0.0);
            cellSize = Number(meshNode.parameters?.cell_size ?? 0.01);
        }
        const nx = Math.round(dimX / cellSize);
        const ny = Math.round(dimY / cellSize);
        const nz = Math.round(dimZ / cellSize);

        const { min: syncFocusedMin, max: syncFocusedMax } = getFocusedQuantityAndRange(vpNode);

        this.worker.postMessage({
            type: 'setConfig',
            data: {
                colormap: vpNode.parameters.colormap || 'plasma',
                minY: syncFocusedMin,
                maxY: syncFocusedMax,
                autoScale: vpNode.parameters.auto_scale !== false,
                showGrid: vpNode.parameters.show_grid !== false,
                useLogScale: vpNode.parameters.log_scale === true,
                showCellEdges: vpNode.parameters.cell_edges === true,
                interpolate: vpNode.parameters.interpolate === true,
                xmin: xmin,
                ymin: ymin,
                zmin: zmin,
                dx: cellSize,
                nx: nx,
                ny: ny,
                nz: nz,
                slices: vpNode.parameters.slices || [],
                focusedSliceIndex: vpNode.parameters.focusedSliceIndex ?? 0,
                quantityRanges: vpNode.parameters.quantity_ranges || {}
            }
        });
    }

    public pushFrame(buffer: ArrayBuffer) {
        this.worker.postMessage({ type: 'frame', data: { buffer } }, [buffer]);
    }

    public updateTelemetry(data: any) {
        if (data && data.type === 'TELEMETRY_3D') {
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
    }

    public destroy() {
        this.stateManager.offStateChange(this.stateListener);
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
        const originX = Number(meshNode.parameters?.origin_x ?? 0.0);
        const originY = Number(meshNode.parameters?.origin_y ?? 0.0);
        const originZ = Number(meshNode.parameters?.origin_z ?? 0.0);
        const dimX = Number(meshNode.parameters?.dim_x ?? 1.0);
        const dimY = Number(meshNode.parameters?.dim_y ?? 1.0);
        const dimZ = Number(meshNode.parameters?.dim_z ?? 1.0);
        if (axis === 'xy') {
            min = originZ;
            max = originZ + dimZ;
        } else if (axis === 'xz') {
            min = originY;
            max = originY + dimY;
        } else if (axis === 'yz') {
            min = originX;
            max = originX + dimX;
        }
    }
    return { min, max };
}

