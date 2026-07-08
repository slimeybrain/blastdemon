import { Node, PanelType } from './types.js';
import { StateManager } from './state-manager.js';

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
                    this.stateManager.updateNodeParameters(vpNode.id, {
                        auto_scale: false,
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

        // Log scale toggle
        const logRow = document.createElement('label');
        logRow.style.display = 'flex';
        logRow.style.alignItems = 'center';
        logRow.style.gap = '6px';
        logRow.style.cursor = 'pointer';
        
        const logCb = document.createElement('input');
        logCb.type = 'checkbox';
        logCb.id = 'viewport-log-cb';
        logCb.onchange = () => {
            const vpNode = this.getViewportNode();
            if (vpNode) {
                this.stateManager.updateNodeParameters(vpNode.id, { log_scale: logCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { useLogScale: logCb.checked } });
            }
        };
        logRow.appendChild(logCb);
        logRow.appendChild(document.createTextNode('Logarithmic Scale'));
        parent.appendChild(logRow);

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

        // Interpolate colors checkbox
        const interpRow = document.createElement('label');
        interpRow.style.display = 'flex';
        interpRow.style.alignItems = 'center';
        interpRow.style.gap = '6px';
        interpRow.style.cursor = 'pointer';
        
        const interpCb = document.createElement('input');
        interpCb.type = 'checkbox';
        interpCb.id = 'viewport-interpolate-cb';
        interpCb.onchange = () => {
            const vpNode = this.getViewportNode();
            if (vpNode) {
                this.stateManager.updateNodeParameters(vpNode.id, { interpolate: interpCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { interpolate: interpCb.checked } });
            }
        };
        interpRow.appendChild(interpCb);
        interpRow.appendChild(document.createTextNode('Interpolate (Smooth) Colors'));
        parent.appendChild(interpRow);

        // Colormap
        const cmapRow = document.createElement('div');
        cmapRow.style.display = 'flex';
        cmapRow.style.justifyContent = 'space-between';
        cmapRow.style.alignItems = 'center';
        cmapRow.innerHTML = '<span>Colormap</span>';
        
        const cmapSel = document.createElement('select');
        cmapSel.id = 'viewport-cmap-sel';
        this.applySelectStyle(cmapSel);
        cmapSel.innerHTML = '<option value="plasma">Plasma</option><option value="viridis">Viridis</option>';
        cmapSel.onchange = () => {
            const vpNode = this.getViewportNode();
            if (vpNode) {
                this.stateManager.updateNodeParameters(vpNode.id, { colormap: cmapSel.value });
                this.worker.postMessage({ type: 'setConfig', data: { colormap: cmapSel.value } });
            }
        };
        cmapRow.appendChild(cmapSel);
        parent.appendChild(cmapRow);

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


        // Contour scaling range
        const rangeHeader = document.createElement('label');
        rangeHeader.style.display = 'flex';
        rangeHeader.style.alignItems = 'center';
        rangeHeader.style.gap = '6px';
        rangeHeader.style.cursor = 'pointer';
        rangeHeader.style.marginTop = '4px';
        
        const autoScaleCb = document.createElement('input');
        autoScaleCb.type = 'checkbox';
        autoScaleCb.id = 'viewport-autoscale-cb';
        autoScaleCb.onchange = () => {
            const vpNode = this.getViewportNode();
            if (vpNode) this.stateManager.updateNodeParameters(vpNode.id, { auto_scale: autoScaleCb.checked });
        };
        rangeHeader.appendChild(autoScaleCb);
        rangeHeader.appendChild(document.createTextNode('Auto scale contour range'));
        parent.appendChild(rangeHeader);

        // Range text displaying actual current min/max of the plotted contour
        const rangeText = document.createElement('div');
        rangeText.id = `viewport-current-range-${this.panelId}`;
        rangeText.style.fontSize = '9px';
        rangeText.style.color = '#00adff';
        rangeText.style.marginTop = '4px';
        rangeText.style.marginBottom = '4px';
        rangeText.textContent = `Current: [N/A]`;
        parent.appendChild(rangeText);

        const rangeInputs = document.createElement('div');
        rangeInputs.id = 'viewport-range-inputs';
        rangeInputs.style.display = 'flex';
        rangeInputs.style.gap = '8px';
        rangeInputs.style.marginTop = '2px';

        const minWrap = document.createElement('div');
        minWrap.style.flex = '1';
        minWrap.style.display = 'flex';
        minWrap.style.flexDirection = 'column';
        minWrap.innerHTML = '<span style="font-size:9px;color:#aaa">Min</span>';
        const minInput = document.createElement('input');
        minInput.type = 'number';
        minInput.id = 'viewport-min-val';
        this.applyInputStyle(minInput);
        minInput.onchange = () => {
            const vpNode = this.getViewportNode();
            if (vpNode) this.stateManager.updateNodeParameters(vpNode.id, { min_val: Number(minInput.value) });
        };
        minWrap.appendChild(minInput);

        const maxWrap = document.createElement('div');
        maxWrap.style.flex = '1';
        maxWrap.style.display = 'flex';
        maxWrap.style.flexDirection = 'column';
        maxWrap.innerHTML = '<span style="font-size:9px;color:#aaa">Max</span>';
        const maxInput = document.createElement('input');
        maxInput.type = 'number';
        maxInput.id = 'viewport-max-val';
        this.applyInputStyle(maxInput);
        maxInput.onchange = () => {
            const vpNode = this.getViewportNode();
            if (vpNode) this.stateManager.updateNodeParameters(vpNode.id, { max_val: Number(maxInput.value) });
        };
        maxWrap.appendChild(maxInput);

        rangeInputs.appendChild(minWrap);
        rangeInputs.appendChild(maxWrap);
        parent.appendChild(rangeInputs);

        const scaleToCurrentRow = document.createElement('div');
        scaleToCurrentRow.style.display = 'flex';
        scaleToCurrentRow.style.justifyContent = 'center';
        scaleToCurrentRow.style.marginTop = '6px';
        const scaleToCurrentBtn = document.createElement('button');
        scaleToCurrentBtn.innerHTML = '🎯 Scale to Current Frame';
        this.applyButtonStyle(scaleToCurrentBtn);
        scaleToCurrentBtn.style.width = '100%';
        scaleToCurrentBtn.onclick = () => {
            this.worker.postMessage({ type: 'scaleToCurrent' });
        };
        scaleToCurrentRow.appendChild(scaleToCurrentBtn);
        parent.appendChild(scaleToCurrentRow);
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

    private addSlice() {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        const slices = vpNode.parameters.slices ? [...vpNode.parameters.slices] : [];
        slices.push({ axis: 'xy', offset: 0.5, quantities: ['pressure'], stride: 1 });
        this.updateSlices(slices);
    }

    private deleteSlice(index: number) {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        const slices = vpNode.parameters.slices ? [...vpNode.parameters.slices] : [];
        if (slices.length > index) {
            slices.splice(index, 1);
            this.updateSlices(slices);
        }
    }

    private updateSliceProperty(index: number, updates: any) {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        const slices = vpNode.parameters.slices ? [...vpNode.parameters.slices] : [];
        if (slices.length > index) {
            slices[index] = { ...slices[index], ...updates };
            this.updateSlices(slices);
        }
    }

    private syncControls() {
        const vpNode = this.getViewportNode();
        const solverNode = this.getSolverNode();
        if (!vpNode) return;

        // 1. Sync Render Settings
        const gridCb = document.getElementById('viewport-grid-cb') as HTMLInputElement;
        if (gridCb && document.activeElement !== gridCb) {
            gridCb.checked = vpNode.parameters.show_grid !== false;
        }

        const logCb = document.getElementById('viewport-log-cb') as HTMLInputElement;
        if (logCb && document.activeElement !== logCb) {
            logCb.checked = vpNode.parameters.log_scale === true;
        }

        const edgesCb = document.getElementById('viewport-edges-cb') as HTMLInputElement;
        if (edgesCb && document.activeElement !== edgesCb) {
            edgesCb.checked = vpNode.parameters.cell_edges === true;
        }

        const interpCb = document.getElementById('viewport-interpolate-cb') as HTMLInputElement;
        if (interpCb && document.activeElement !== interpCb) {
            interpCb.checked = vpNode.parameters.interpolate === true;
        }

        const cmapSel = document.getElementById('viewport-cmap-sel') as HTMLSelectElement;
        if (cmapSel && document.activeElement !== cmapSel) {
            cmapSel.value = vpNode.parameters.colormap || 'plasma';
        }

        const autoScaleCb = document.getElementById('viewport-autoscale-cb') as HTMLInputElement;
        if (autoScaleCb && document.activeElement !== autoScaleCb) {
            autoScaleCb.checked = vpNode.parameters.auto_scale !== false;
        }

        const minInput = document.getElementById('viewport-min-val') as HTMLInputElement;
        const maxInput = document.getElementById('viewport-max-val') as HTMLInputElement;
        const rangeWrap = document.getElementById('viewport-range-inputs') as HTMLElement;
        const auto = vpNode.parameters.auto_scale !== false;

        if (rangeWrap) {
            rangeWrap.style.opacity = auto ? '0.4' : '1.0';
            rangeWrap.style.pointerEvents = auto ? 'none' : 'auto';
        }

        if (minInput && document.activeElement !== minInput) {
            minInput.value = (vpNode.parameters.min_val ?? 101325.0).toString();
        }
        if (maxInput && document.activeElement !== maxInput) {
            maxInput.value = (vpNode.parameters.max_val ?? 101325.0 * 100.0).toString();
        }

        // 2. Sync Slices Row list
        const slices = vpNode.parameters.slices || [];
        if (this.sliceListContainer) {
            // Rebuild rows if slice counts differ
            const currentRows = this.sliceListContainer.children.length;
            if (currentRows !== slices.length) {
                this.sliceListContainer.innerHTML = '';
                slices.forEach((slice: any, idx: number) => {
                    const row = document.createElement('div');
                    row.style.background = 'rgba(255,255,255,0.03)';
                    row.style.border = '1px solid rgba(255,255,255,0.06)';
                    row.style.borderRadius = '4px';
                    row.style.padding = '8px';
                    row.style.display = 'flex';
                    row.style.flexDirection = 'column';
                    row.style.gap = '4px';

                    // Row Header
                    const rowHeader = document.createElement('div');
                    rowHeader.style.display = 'flex';
                    rowHeader.style.justifyContent = 'space-between';
                    rowHeader.style.alignItems = 'center';
                    rowHeader.innerHTML = `<span style="font-weight:600;font-size:10px;color:#aaa">Slice ${idx + 1}</span>`;

                    const delBtn = document.createElement('button');
                    delBtn.innerHTML = '🗑️';
                    delBtn.style.background = 'none';
                    delBtn.style.border = 'none';
                    delBtn.style.color = '#d9534f';
                    delBtn.style.cursor = 'pointer';
                    delBtn.style.fontSize = '10px';
                    delBtn.onclick = () => this.deleteSlice(idx);
                    rowHeader.appendChild(delBtn);
                    row.appendChild(rowHeader);

                    // Row Controls
                    const grid = document.createElement('div');
                    grid.style.display = 'grid';
                    grid.style.gridTemplateColumns = '1fr 1fr';
                    grid.style.gap = '6px';
                    
                    // Axis Select
                    const axisWrap = document.createElement('div');
                    axisWrap.innerHTML = '<span style="font-size:8px;color:#aaa;display:block">Axis</span>';
                    const axisSel = document.createElement('select');
                    this.applySelectStyle(axisSel);
                    axisSel.style.width = '100%';
                    axisSel.innerHTML = '<option value="xy">XY</option><option value="xz">XZ</option><option value="yz">YZ</option>';
                    axisSel.value = slice.axis;
                    axisSel.onchange = () => this.updateSliceProperty(idx, { axis: axisSel.value });
                    axisWrap.appendChild(axisSel);
                    grid.appendChild(axisWrap);

                    // Quantity Select
                    const qWrap = document.createElement('div');
                    qWrap.innerHTML = '<span style="font-size:8px;color:#aaa;display:block">Quantity</span>';
                    const qSel = document.createElement('select');
                    this.applySelectStyle(qSel);
                    qSel.style.width = '100%';
                    qSel.innerHTML = '<option value="pressure">Pressure</option><option value="density">Density</option><option value="velocity">Velocity</option><option value="energy">Energy</option><option value="species1">Species 1</option><option value="species2">Species 2</option><option value="species3">Species 3</option>';
                    qSel.value = slice.quantities?.[0] || 'pressure';
                    qSel.onchange = () => this.updateSliceProperty(idx, { quantities: [qSel.value] });
                    qWrap.appendChild(qSel);
                    grid.appendChild(qWrap);

                    row.appendChild(grid);

                    // Offset slider + numerical input
                    const offWrap = document.createElement('div');
                    offWrap.style.display = 'flex';
                    offWrap.style.alignItems = 'center';
                    offWrap.style.gap = '6px';
                    offWrap.innerHTML = '<span style="font-size:8px;color:#aaa;min-width:30px">Offset</span>';
                    
                    const offSlider = document.createElement('input');
                    offSlider.type = 'range';
                    offSlider.min = '0';
                    offSlider.max = '1';
                    offSlider.step = '0.01';
                    offSlider.value = slice.offset.toString();
                    offSlider.style.flex = '1';
                    offSlider.style.height = '3px';
                    offSlider.style.background = '#444';
                    offSlider.style.outline = 'none';

                    const offInp = document.createElement('input');
                    offInp.type = 'number';
                    this.applyInputStyle(offInp);
                    offInp.style.width = '45px';
                    offInp.style.padding = '0px 2px';
                    offInp.style.textAlign = 'center';
                    offInp.value = slice.offset.toString();

                    offSlider.oninput = () => {
                        offInp.value = offSlider.value;
                        this.updateSliceProperty(idx, { offset: Number(offSlider.value) });
                    };
                    offInp.onchange = () => {
                        const val = Math.max(0, Math.min(1.0, Number(offInp.value)));
                        offSlider.value = val.toString();
                        offInp.value = val.toString();
                        this.updateSliceProperty(idx, { offset: val });
                    };

                    offWrap.appendChild(offSlider);
                    offWrap.appendChild(offInp);
                    row.appendChild(offWrap);

                    this.sliceListContainer!.appendChild(row);
                });
            } else {
                // Just sync values of existing inputs
                slices.forEach((slice: any, idx: number) => {
                    const row = this.sliceListContainer!.children[idx] as HTMLElement;
                    if (!row) return;
                    
                    const axisSel = row.querySelector('select:nth-of-type(1)') as HTMLSelectElement;
                    if (axisSel && document.activeElement !== axisSel) {
                        axisSel.value = slice.axis;
                    }
                    const qSel = row.querySelector('select:nth-of-type(2)') as HTMLSelectElement;
                    if (qSel && document.activeElement !== qSel) {
                        qSel.value = slice.quantities?.[0] || 'pressure';
                    }
                    const offSlider = row.querySelector('input[type="range"]') as HTMLInputElement;
                    if (offSlider && document.activeElement !== offSlider) {
                        offSlider.value = slice.offset.toString();
                    }
                    const offInp = row.querySelector('input[type="number"]') as HTMLInputElement;
                    if (offInp && document.activeElement !== offInp) {
                        offInp.value = slice.offset.toString();
                    }
                });
            }
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
        const state = this.stateManager.getCurrentState();
        if (state) {
            const connToViewport = state.connections.find(c => c.toNode === vpNode.id);
            if (connToViewport) {
                const solverNode = state.nodes.find(n => n.id === connToViewport.fromNode);
                if (solverNode) {
                    const connToSolver = state.connections.find(c => c.toNode === solverNode.id && c.toPort === 'mesh');
                    if (connToSolver) {
                        const meshNode = state.nodes.find(n => n.id === connToSolver.fromNode);
                        if (meshNode && meshNode.type === 'DomainMesh3D') {
                            dimX = Number(meshNode.parameters?.dim_x ?? 1.0);
                            dimY = Number(meshNode.parameters?.dim_y ?? 1.0);
                            dimZ = Number(meshNode.parameters?.dim_z ?? 1.0);
                            cellSize = Number(meshNode.parameters?.cell_size ?? 0.01);
                        }
                    }
                }
            }
        }
        const nx = Math.round(dimX / cellSize);
        const ny = Math.round(dimY / cellSize);
        const nz = Math.round(dimZ / cellSize);

        this.worker.postMessage({
            type: 'setConfig',
            data: {
                colormap: vpNode.parameters.colormap || 'plasma',
                minY: vpNode.parameters.min_val ?? 101325.0,
                maxY: vpNode.parameters.max_val ?? 101325.0 * 100.0,
                autoScale: vpNode.parameters.auto_scale !== false,
                showGrid: vpNode.parameters.show_grid !== false,
                useLogScale: vpNode.parameters.log_scale === true,
                showCellEdges: vpNode.parameters.cell_edges === true,
                interpolate: vpNode.parameters.interpolate === true,
                xmin: 0.0,
                ymin: 0.0,
                zmin: 0.0,
                dx: cellSize,
                nx: nx,
                ny: ny,
                nz: nz
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
