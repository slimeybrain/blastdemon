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
    private currentGeometryHash: string | null = null;
    private debugOverlay: HTMLElement | null = null;
    private hasTelemetryGrid = false;

    // Overlay Elements
    private controlsOverlay: HTMLElement | null = null;
    private floatOpenBtn: HTMLElement | null = null;
    private sliceListContainer: HTMLElement | null = null;
    private staticListContainer: HTMLElement | null = null;
    private expandedSliceIndices = new Set<number>();
    private needsSlicesRebuild = true;
    private isOpen = true;
    private latestSliceRanges: { min: number, max: number }[] = [];
    private latestEmpiricalRange: { min: number, max: number } | null = null;
    private _lastSliceKey: string = '';

    private viewTypeSuffix: string;
    private viewportNodeId: string | null = null;

    private getElId(base: string): string {
        return `${base}-${this.panelId}${this.viewTypeSuffix}`;
    }

    constructor(container: HTMLElement, panelId: string, stateManager: StateManager, viewTypeSuffix: string = '', viewportNodeId?: string | null) {
        this.container = container;
        this.panelId = panelId;
        this.stateManager = stateManager;
        this.viewTypeSuffix = viewTypeSuffix;
        this.viewportNodeId = viewportNodeId || null;

        // Container relative positioning
        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';

        this.canvas = document.createElement('canvas');
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.display = 'block';
        this.container.appendChild(this.canvas);

        this.worker = new Worker(new URL('./ViewportWorker.ts', import.meta.url), { type: 'module' });

        this.worker.onmessage = (e) => {
            const { type, renderer, min, max } = e.data;
            if (type === 'rendererInfo') {
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
            } else if (type === 'error') {
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
                this.syncControls(false);
            } else if (type === 'obstaclesRangeUpdated') {
                const vpNode = this.getViewportNode();
                if (vpNode) {
                    const { min, max } = e.data;
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, {
                        obstacles_auto_scale: false,
                        obstacles_min_val: min,
                        obstacles_max_val: max
                    });
                    this.syncControls(true);
                }
            } else if (type === 'currentRange') {
                const { min, max } = e.data;
                this.latestEmpiricalRange = { min, max };
                const rangeLabel = document.getElementById(this.getElId('viewport-current-range'));
                if (rangeLabel) {
                    rangeLabel.textContent = `Current: [${this.formatRangeValue(min)}, ${this.formatRangeValue(max)}]`;
                }
            }
        };

        this.initInteraction();
        this.buildOverlay();

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
            e.stopPropagation();
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
            console.log('[Debug] 3D viewport wheel event fired');
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            this.worker.postMessage({ type: 'input', data: { dy: e.deltaY } });
        }, { passive: false });
    }


    private buildOverlay() {
        // 1. Floating gear button when closed (on the right side)
        this.floatOpenBtn = document.createElement('button');
        this.floatOpenBtn.innerHTML = '⚙️ Controls';
        this.applyButtonStyle(this.floatOpenBtn);
        this.floatOpenBtn.style.position = 'absolute';
        this.floatOpenBtn.style.top = '10px';
        this.floatOpenBtn.style.right = '10px';
        this.floatOpenBtn.style.display = 'none';
        this.floatOpenBtn.style.zIndex = '12';
        this.floatOpenBtn.onclick = () => {
            this.isOpen = true;
            if (this.controlsOverlay) this.controlsOverlay.style.display = 'flex';
            if (this.floatOpenBtn) this.floatOpenBtn.style.display = 'none';
        };
        this.container.appendChild(this.floatOpenBtn);

        // 2. Controls Panel Overlay (on the right side)
        this.controlsOverlay = document.createElement('div');
        this.controlsOverlay.style.position = 'absolute';
        this.controlsOverlay.style.top = '10px';
        this.controlsOverlay.style.right = '10px';
        this.controlsOverlay.style.bottom = '10px';
        this.controlsOverlay.style.width = '460px';
        this.controlsOverlay.style.maxWidth = 'calc(100% - 20px)';
        this.controlsOverlay.style.background = 'rgba(16, 16, 19, 0.92)';
        this.controlsOverlay.style.backdropFilter = 'blur(16px)';
        this.controlsOverlay.style.border = '1px solid rgba(255, 255, 255, 0.12)';
        this.controlsOverlay.style.borderRadius = '8px';
        this.controlsOverlay.style.display = 'flex';
        this.controlsOverlay.style.flexDirection = 'column';
        this.controlsOverlay.style.color = '#e0e0e0';
        this.controlsOverlay.style.fontFamily = 'system-ui, -apple-system, sans-serif';
        this.controlsOverlay.style.fontSize = '11px';
        this.controlsOverlay.style.boxShadow = '0 12px 40px 0 rgba(0, 0, 0, 0.6)';
        this.controlsOverlay.style.zIndex = '11';
        this.controlsOverlay.style.boxSizing = 'border-box';
        this.controlsOverlay.style.overflow = 'hidden';
        this.container.appendChild(this.controlsOverlay);

        // Header
        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.style.padding = '6px 10px';
        header.style.borderBottom = '1px solid rgba(255, 255, 255, 0.08)';
        header.style.background = 'linear-gradient(to right, rgba(255,255,255,0.03), transparent)';
        header.style.boxSizing = 'border-box';
        header.style.width = '100%';
        
        const titleWrap = document.createElement('div');
        titleWrap.style.display = 'flex';
        titleWrap.style.alignItems = 'center';

        const title = document.createElement('span');
        title.innerHTML = '⚡ 3D Controls';
        title.style.fontWeight = '700';
        title.style.fontSize = '11px';
        title.style.letterSpacing = '0.5px';
        titleWrap.appendChild(title);

        const badge = document.getElementById(this.getElId('viewport-renderer-badge')) || document.createElement('span');
        badge.id = this.getElId('viewport-renderer-badge');
        badge.innerHTML = 'Detecting...';
        badge.style.fontSize = '8px';
        badge.style.padding = '1px 4px';
        badge.style.borderRadius = '3px';
        badge.style.border = '1px solid rgba(255,255,255,0.15)';
        badge.style.fontWeight = 'bold';
        badge.style.marginLeft = '8px';
        badge.style.textTransform = 'uppercase';
        badge.style.color = '#00adff';
        badge.style.background = 'rgba(0,173,255,0.1)';
        titleWrap.appendChild(badge);

        header.appendChild(titleWrap);

        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '▶';
        closeBtn.style.background = 'none';
        closeBtn.style.border = 'none';
        closeBtn.style.color = '#aaa';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.fontSize = '11px';
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
        content.style.overflowX = 'hidden';
        content.style.padding = '6px';
        content.style.display = 'flex';
        content.style.flexDirection = 'column';
        content.style.gap = '6px';
        content.style.boxSizing = 'border-box';
        content.style.width = '100%';
        this.controlsOverlay.appendChild(content);

        // Build Unified Controls Matrix Table
        this.buildUnifiedControlsTable(content);
    }

    private formatRangeValue(val: number): string {
        if (Math.abs(val) < 1e-3 || Math.abs(val) > 1e6) {
            return val.toExponential(4);
        }
        return val.toFixed(1);
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
        rateSel.id = this.getElId('viewport-refresh-rate-sel');
        this.applySelectStyle(rateSel);
        rateSel.style.width = '120px';
        rateSel.innerHTML = `
            <option value="0.0">Max Rate (0s)</option>
            <option value="0.016">60 FPS</option>
            <option value="0.033">30 FPS</option>
            <option value="0.05">20 FPS</option>
            <option value="0.1">10 FPS</option>
            <option value="0.2">5 FPS</option>
            <option value="0.5">2 FPS</option>
            <option value="1.0">1 FPS</option>
            <option value="2.0">0.5 FPS (Default)</option>
            <option value="5.0">0.2 FPS</option>
        `;
        this.selectOptionByNumericValue(rateSel, vpNode ? (vpNode.parameters.refresh_rate ?? 2.0) : 2.0);
        this.bindEditingEvents(rateSel, () => {
            const vp = this.getViewportNode();
            if (vp) {
                const val = Number(rateSel.value);
                this.stateManager.updateNodeParametersInPlace(vp.id, { refresh_rate: val });
                this.sendView3DConfig();
            }
        });
        rateRow.appendChild(rateSel);
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
        this.buildGridRow(staticTbody);
        this.buildGaugeRow(staticTbody);
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

    private showQuantityPopover(targetEl: HTMLElement, currentQty: string, onSelect: (qty: string) => void) {
        const quantities = [
            { id: 'pressure', label: '📊 Pressure' },
            { id: 'density', label: '⚖️ Density' },
            { id: 'velocity', label: '💨 Speed' },
            { id: 'energy', label: '🔥 Energy' },
            { id: 'species1', label: '💥 Reacted' },
            { id: 'species2', label: '🧪 Unreacted' },
            { id: 'species3', label: '🌬️ Air' },
            { id: 'peak_overpressure', label: '📈 Pk Press' },
            { id: 'peak_impulse', label: '⏱️ Pk Impulse' }
        ];

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
            { id: 'plasma', name: 'Plasma', grad: 'linear-gradient(to right, #0d0887, #6a00a8, #b12a90, #e16462, #fca636, #f0f921)' },
            { id: 'viridis', name: 'Viridis', grad: 'linear-gradient(to right, #440154, #3b528b, #21908d, #5dc963, #fde725)' },
            { id: 'rainbow', name: 'Rainbow', grad: 'linear-gradient(to right, #0000ff, #00ffff, #00ff00, #ffff00, #ff0000)' },
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

    private showRangePopover(targetEl: HTMLElement, qtyName: string, minVal: number, maxVal: number, autoScale: boolean, logScale: boolean, interpScale?: boolean, onApply?: (minV: number, maxV: number, autoV: boolean, logV: boolean, interpV: boolean) => void) {
        this.showPopover(targetEl, (popover) => {
            const title = document.createElement('div');
            title.textContent = `Scale (${qtyName})`;
            title.style.fontWeight = 'bold';
            title.style.color = '#00adff';
            title.style.marginBottom = '6px';
            title.style.fontSize = '9px';
            title.style.textTransform = 'uppercase';
            popover.appendChild(title);

            // Auto, Log & Smooth toggles
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

            const interpLbl = document.createElement('label');
            interpLbl.style.display = 'flex';
            interpLbl.style.alignItems = 'center';
            interpLbl.style.gap = '3px';
            interpLbl.style.cursor = 'pointer';
            const interpCb = document.createElement('input');
            interpCb.type = 'checkbox';
            interpCb.checked = interpScale !== false;
            interpLbl.appendChild(interpCb);
            interpLbl.appendChild(document.createTextNode('Smooth'));
            togglesRow.appendChild(interpLbl);

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
                    onApply(minV, maxV, autoCb.checked, logCb.checked, interpCb.checked);
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
            interpCb.onchange = () => {
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
            popover.style.width = '240px';

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
                { id: 'xy', label: 'XY (Z-Norm)' },
                { id: 'xz', label: 'XZ (Y-Norm)' },
                { id: 'yz', label: 'YZ (X-Norm)' }
            ];

            const currentAxis = slice.axis || 'xy';

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
                btn.onclick = (e) => {
                    e.stopPropagation();
                    this.updateSliceProperty(sliceIndex, { axis: p.id });
                    this.closePopover();
                };
                planeRow.appendChild(btn);
            });
            popover.appendChild(planeRow);

            // 2. Position Slider & Live Reading
            const bounds = getSliceBounds(currentAxis, meshNode);
            const curOffset = Number(slice.offset ?? (bounds.min + bounds.max) / 2.0);

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

            const updatePos = (v: number) => {
                posValSpan.textContent = `${v.toFixed(3)} m`;
                if (numInp) numInp.value = v.toFixed(3);
                this.updateSliceProperty(sliceIndex, { offset: v });
            };

            slider.oninput = () => {
                updatePos(Number(slider.value));
            };
            popover.appendChild(slider);

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
                const pVal = bounds.min + pr.frac * (bounds.max - bounds.min);
                const btn = document.createElement('button');
                btn.textContent = pr.label;
                this.applyButtonStyle(btn);
                btn.style.flex = '1';
                btn.style.fontSize = '8.5px';
                btn.style.padding = '2px 0';
                if (Math.abs(curOffset - pVal) < (bounds.max - bounds.min) * 0.02) {
                    btn.style.background = '#007acc';
                    btn.style.borderColor = '#00adff';
                }
                btn.onclick = (e) => {
                    e.stopPropagation();
                    slider.value = String(pVal);
                    updatePos(pVal);
                };
                presetRow.appendChild(btn);
            });
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
                        posValSpan.textContent = `${clamped.toFixed(3)} m`;
                        this.updateSliceProperty(sliceIndex, { offset: clamped });
                    }
                }
            };
            numInp.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    let v = Number(numInp!.value);
                    if (!isNaN(v)) {
                        v = Math.max(bounds.min, Math.min(bounds.max, v));
                        this.updateSliceProperty(sliceIndex, { offset: v });
                    }
                    this.closePopover();
                }
            };

            customRow.appendChild(numLbl);
            customRow.appendChild(numInp);
            popover.appendChild(customRow);
        });
    }

    private setQuantityColormap(qty: string, cmap: string) {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        const qCmaps = vpNode.parameters.quantity_colormaps ? { ...vpNode.parameters.quantity_colormaps } : {};
        qCmaps[qty] = cmap;

        const slices = vpNode.parameters.slices ? [...vpNode.parameters.slices] : [];
        slices.forEach(s => {
            if ((s.quantities?.[0] || 'pressure') === qty) {
                s.colormap = cmap;
            }
        });

        const updates: any = { quantity_colormaps: qCmaps, slices };
        if ((vpNode.parameters.stl_quantity || 'pressure') === qty) {
            updates.stl_colormap = cmap;
        }
        if ((vpNode.parameters.obstacles_quantity || 'pressure') === qty) {
            updates.obstacles_colormap = cmap;
        }

        this.stateManager.updateNodeParametersInPlace(vpNode.id, updates);
        this.needsSlicesRebuild = true;
        this.worker.postMessage({
            type: 'setConfig',
            data: {
                quantityColormaps: qCmaps,
                slices,
                stlColormap: updates.stl_colormap,
                obstaclesColormap: updates.obstacles_colormap
            }
        });
        this.syncControls(true);
    }

    private setQuantityRange(qty: string, minV: number, maxV: number, autoV: boolean, logV: boolean, interpV?: boolean) {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;

        const qRanges = vpNode.parameters.quantity_ranges ? { ...vpNode.parameters.quantity_ranges } : {};
        qRanges[qty] = [minV, maxV];

        const slices = vpNode.parameters.slices ? [...vpNode.parameters.slices] : [];
        slices.forEach(s => {
            if ((s.quantities?.[0] || 'pressure') === qty) {
                s.min_val = minV;
                s.max_val = maxV;
                s.auto_scale = autoV;
                s.log_scale = logV;
                if (interpV !== undefined) {
                    s.interpolate = interpV;
                }
            }
        });

        const updates: any = { quantity_ranges: qRanges, slices };
        if ((vpNode.parameters.stl_quantity || 'pressure') === qty) {
            updates.stl_min_val = minV;
            updates.stl_max_val = maxV;
            updates.stl_auto_scale = autoV;
            updates.stl_log_scale = logV;
            if (interpV !== undefined) {
                updates.stl_sampling_mode = interpV ? 'linear' : 'nearest';
            }
        }
        if ((vpNode.parameters.obstacles_quantity || 'pressure') === qty) {
            updates.obstacles_min_val = minV;
            updates.obstacles_max_val = maxV;
            updates.obstacles_auto_scale = autoV;
            updates.obstacles_log_scale = logV;
            if (interpV !== undefined) {
                updates.obstacles_interpolate = interpV;
            }
        }

        this.stateManager.updateNodeParametersInPlace(vpNode.id, updates);
        this.needsSlicesRebuild = true;
        this.syncControls(true);
    }

    private createToggleBtn(idStr: string, text: string, checked: boolean, onChange: (v: boolean) => void) {
        const btn = document.createElement('div');
        btn.id = this.getElId(idStr);
        btn.innerText = text;
        
        let state = checked;
        const updateStyle = () => {
            btn.style.background = state ? '#007acc' : 'transparent';
            btn.style.border = state ? '1px solid #007acc' : '1px solid rgba(255,255,255,0.2)';
            btn.style.color = state ? '#fff' : '#ccc';
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
            state = !state;
            updateStyle();
            onChange(state);
        };
        this.bindEditingEvents(btn);
        return btn;
    }

    private buildObstacleRow(parent: HTMLElement) {
        const vpNode = this.getViewportNode();
        const initShow = vpNode ? (vpNode.parameters.show_obstacles === true) : false;
        const initGrid = vpNode ? (vpNode.parameters.obstacles_gridlines !== false) : true;
        const initSolid = vpNode ? (vpNode.parameters.obstacles_solid !== false) : true;
        const initLight = vpNode ? (vpNode.parameters.obstacles_lighting !== false) : true;
        const initOpacity = vpNode ? (vpNode.parameters.obstacles_opacity ?? 1.0) : 1.0;
        const initQty = vpNode ? (vpNode.parameters.obstacles_quantity || 'pressure') : 'pressure';
        const initCmap = vpNode ? (vpNode.parameters.quantity_colormaps?.[initQty] || vpNode.parameters.obstacles_colormap || 'plasma') : 'plasma';

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
            peak_overpressure: 'Pk Press', peak_impulse: 'Pk Impulse'
        };
        qtyPill.textContent = `${qtyLabels[initQty] || initQty} ▾`;
        this.applyButtonStyle(qtyPill);
        qtyPill.style.fontSize = '8.5px';
        qtyPill.style.width = '100%';
        qtyPill.style.padding = '2px 0';
        qtyPill.onclick = (e) => {
            e.stopPropagation();
            const currentQty = this.getViewportNode()?.parameters.obstacles_quantity || 'pressure';
            this.showQuantityPopover(qtyPill, currentQty, (newQ) => {
                const vp = this.getViewportNode();
                if (vp) {
                    const qCmaps = vp.parameters.quantity_colormaps || {};
                    const newCmap = qCmaps[newQ] || 'plasma';
                    this.stateManager.updateNodeParametersInPlace(vp.id, { obstacles_quantity: newQ, obstacles_colormap: newCmap });
                    this.worker.postMessage({ type: 'setConfig', data: { obstaclesQuantity: newQ, obstaclesColormap: newCmap } });
                    this.sendView3DConfig();
                    this.syncControls(true);
                }
            });
        };
        tdQty.appendChild(qtyPill);
        tr.appendChild(tdQty);

        // Col 7: COLOR (Colormap Popover Button)
        const tdCmap = document.createElement('td');
        tdCmap.style.padding = '3px 4px';
        const cmapPill = document.createElement('button');
        cmapPill.textContent = `${initCmap.charAt(0).toUpperCase() + initCmap.slice(1)} ▾`;
        this.applyButtonStyle(cmapPill);
        cmapPill.style.fontSize = '8.5px';
        cmapPill.style.width = '100%';
        cmapPill.style.padding = '2px 0';
        cmapPill.onclick = (e) => {
            e.stopPropagation();
            const vp = this.getViewportNode();
            const activeQty = vp?.parameters.obstacles_quantity || 'pressure';
            const curCmap = vp?.parameters.quantity_colormaps?.[activeQty] || vp?.parameters.obstacles_colormap || 'plasma';
            this.showColormapPopover(cmapPill, curCmap, (newC) => {
                this.setQuantityColormap(activeQty, newC);
            });
        };
        tdCmap.appendChild(cmapPill);
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
                const interpV = vp.parameters.obstacles_interpolate !== false;
                this.showRangePopover(cfgBtn, activeQty, curRange[0], curRange[1], autoV, logV, interpV, (minV, maxV, autoVal, logVal, interpVal) => {
                    this.setQuantityRange(activeQty, minV, maxV, autoVal, logVal);
                    if (interpVal !== undefined) {
                        this.stateManager.updateNodeParametersInPlace(vp.id, { obstacles_interpolate: interpVal });
                        this.worker.postMessage({ type: 'setConfig', data: { obstaclesInterpolate: interpVal } });
                    }
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
        const initCmap = vpNode ? (vpNode.parameters.quantity_colormaps?.[initQty] || vpNode.parameters.stl_colormap || 'plasma') : 'plasma';

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
            peak_overpressure: 'Pk Press', peak_impulse: 'Pk Impulse'
        };
        qtyPill.textContent = `${qtyLabels[initQty] || initQty} ▾`;
        this.applyButtonStyle(qtyPill);
        qtyPill.style.fontSize = '8.5px';
        qtyPill.style.width = '100%';
        qtyPill.style.padding = '2px 0';
        qtyPill.onclick = (e) => {
            e.stopPropagation();
            const currentQty = this.getViewportNode()?.parameters.stl_quantity || 'pressure';
            this.showQuantityPopover(qtyPill, currentQty, (newQ) => {
                const vp = this.getViewportNode();
                if (vp) {
                    const qCmaps = vp.parameters.quantity_colormaps || {};
                    const newCmap = qCmaps[newQ] || 'plasma';
                    this.stateManager.updateNodeParametersInPlace(vp.id, { stl_quantity: newQ, stl_colormap: newCmap });
                    this.worker.postMessage({ type: 'setConfig', data: { stlQuantity: newQ, stlColormap: newCmap } });
                    this.sendView3DConfig();
                    this.syncControls(true);
                }
            });
        };
        tdQty.appendChild(qtyPill);
        tr.appendChild(tdQty);

        // Col 7: COLOR (Colormap Popover Button)
        const tdCmap = document.createElement('td');
        tdCmap.style.padding = '3px 4px';
        const cmapPill = document.createElement('button');
        cmapPill.textContent = `${initCmap.charAt(0).toUpperCase() + initCmap.slice(1)} ▾`;
        this.applyButtonStyle(cmapPill);
        cmapPill.style.fontSize = '8.5px';
        cmapPill.style.width = '100%';
        cmapPill.style.padding = '2px 0';
        cmapPill.onclick = (e) => {
            e.stopPropagation();
            const vp = this.getViewportNode();
            const activeQty = vp?.parameters.stl_quantity || 'pressure';
            const curCmap = vp?.parameters.quantity_colormaps?.[activeQty] || vp?.parameters.stl_colormap || 'plasma';
            this.showColormapPopover(cmapPill, curCmap, (newC) => {
                this.setQuantityColormap(activeQty, newC);
            });
        };
        tdCmap.appendChild(cmapPill);
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
                const interpV = vp.parameters.stl_sampling_mode !== 'nearest';
                this.showRangePopover(cfgBtn, activeQty, curRange[0], curRange[1], autoV, logV, interpV, (minV, maxV, autoVal, logVal, interpVal) => {
                    this.setQuantityRange(activeQty, minV, maxV, autoVal, logVal);
                    if (interpVal !== undefined) {
                        const mode = interpVal ? 'linear' : 'nearest';
                        this.stateManager.updateNodeParametersInPlace(vp.id, { stl_sampling_mode: mode });
                        this.worker.postMessage({ type: 'setConfig', data: { stlSamplingMode: mode } });
                    }
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

    private buildGridRow(parent: HTMLElement) {
        const vpNode = this.getViewportNode();
        const initShow = vpNode ? (vpNode.parameters.show_grid !== false) : true;
        const initEdges = vpNode ? (!!vpNode.parameters.cell_edges) : false;
        const initBox = vpNode ? (vpNode.parameters.show_grid_box !== false) : true;
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
                this.stateManager.updateNodeParametersInPlace(vp.id, { show_grid: showCb.checked });
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
                this.stateManager.updateNodeParametersInPlace(vp.id, { show_grid_box: v });
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
            peak_overpressure: 'Pk Press', peak_impulse: 'Pk Impulse'
        };
        qtyPill.textContent = `${qtyLabels[initQty] || initQty} ▾`;
        this.applyButtonStyle(qtyPill);
        qtyPill.style.fontSize = '8.5px';
        qtyPill.style.width = '100%';
        qtyPill.style.padding = '2px 0';
        qtyPill.onclick = (e) => {
            e.stopPropagation();
            const currentQty = this.getViewportNode()?.parameters.gauge_quantity || 'pressure';
            this.showQuantityPopover(qtyPill, currentQty, (newQ) => {
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

        // Col 5: RES (AO toggle button)
        const tdAo = document.createElement('td');
        tdAo.style.padding = '3px 2px';
        tdAo.appendChild(this.createToggleBtn('viewport-ao-btn', 'AO', initAO, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { aoEnabled: v });
                this.worker.postMessage({ type: 'setConfig', data: { aoEnabled: v } });
            }
        }));
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

    private selectOptionByNumericValue(sel: HTMLSelectElement | null, val: number | string): void {
        if (!sel) return;
        const target = Number(val);
        let matched = false;
        for (let i = 0; i < sel.options.length; i++) {
            if (Math.abs(Number(sel.options[i].value) - target) < 0.001) {
                sel.selectedIndex = i;
                matched = true;
                break;
            }
        }
        if (!matched && sel.options.length > 0) {
            for (let i = 0; i < sel.options.length; i++) {
                if (Math.abs(Number(sel.options[i].value) - 2.0) < 0.001) {
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
        if (this.viewportNodeId) {
            const allModels = this.stateManager.getAllModels();
            for (const m of Object.values(allModels)) {
                const node = m.nodes.find(n => n.id === this.viewportNodeId);
                if (node) return node;
            }
        }

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



    public sendView3DConfig(): void {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        const net = (window as any).networkManager;
        if (!net || !net.isConnected()) return;

        let targetModelId = vpNode.id;
        const models = this.stateManager.getAppState().models;
        for (const [mid, m] of Object.entries(models)) {
            if (m.nodes.some(n => n.id === vpNode.id)) {
                targetModelId = mid;
                break;
            }
        }

        const showObstacles = vpNode.parameters.show_obstacles === true;
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
            fullSlices.push({
                axis: 'volume',
                offset: 0.0,
                quantities: [stlQuantity],
                stride: 1
            });
        }

        net.send({
            command: "VIEW3D_CONFIG",
            modelId: targetModelId,
            refresh_rate: Number(vpNode.parameters.refresh_rate ?? 2.0),
            slices: fullSlices
        });
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

        this.sendView3DConfig();
    }

    private getMeshNode() {
        const vpNode = this.getViewportNode();
        if (!vpNode) return null;

        const allModels = this.stateManager.getAllModels();
        let targetModel: any = null;
        for (const m of Object.values(allModels)) {
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

        const allModels = this.stateManager.getAllModels();
        let targetModel: any = null;
        for (const m of Object.values(allModels)) {
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
            max_val,
            enabled: true
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

                // Automatically disable interpolation for solid cells (discrete mask)
                // and enable it for continuous physical quantities.
                if (newQty === 'solid') {
                    slices[index].interpolate = false;
                } else {
                    slices[index].interpolate = true;
                }
            }

            this.propagateSliceQuantitySettings(slices, index, updates);
            this.updateSlices(slices);
        }
    }

    private syncControls(postToWorker: boolean = true) {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;

        const solverNode = this.getSolverNode();

        // Resolve connected DomainMesh3D
        const meshNode = this.getMeshNode();

        // 1. Sync Render Settings
        const gridCb = document.getElementById(this.getElId('viewport-grid-cb')) as HTMLInputElement;
        if (gridCb && document.activeElement !== gridCb) gridCb.checked = vpNode.parameters.show_grid !== false;

        const edgesCb = document.getElementById(this.getElId('viewport-edges-cb')) as HTMLInputElement;
        if (edgesCb && document.activeElement !== edgesCb) edgesCb.checked = !!vpNode.parameters.cell_edges;

        const rateVal = Number(vpNode.parameters.refresh_rate ?? 2.0);

        const rateSel = document.getElementById(this.getElId('viewport-refresh-rate-sel')) as HTMLSelectElement;
        if (rateSel && rateSel.dataset.editing !== 'true' && document.activeElement !== rateSel) {
            this.selectOptionByNumericValue(rateSel, rateVal);
        }

        const rateSelSlice = document.getElementById(this.getElId('viewport-refresh-rate-sel-slice')) as HTMLSelectElement;
        if (rateSelSlice && rateSelSlice.dataset.editing !== 'true' && document.activeElement !== rateSelSlice) {
            this.selectOptionByNumericValue(rateSelSlice, rateVal);
        }

        // FIX 1: Sync lighting/AO checkboxes and sliders from state
        const lightCb = document.getElementById(this.getElId('viewport-lighting-cb')) as HTMLInputElement;
        if (lightCb && document.activeElement !== lightCb) lightCb.checked = vpNode.parameters.lightingEnabled !== false;

        const aoCb = document.getElementById(this.getElId('viewport-ao-cb')) as HTMLInputElement;
        if (aoCb && document.activeElement !== aoCb) aoCb.checked = vpNode.parameters.aoEnabled !== false;

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

        const stlShowCb = document.getElementById(this.getElId('viewport-stl-show-cb')) as HTMLInputElement;
        if (stlShowCb && document.activeElement !== stlShowCb) stlShowCb.checked = vpNode.parameters.show_stl !== false;

        const updateBtnStyle = (idStr: string, active: boolean) => {
            const btn = document.getElementById(this.getElId(idStr));
            if (btn) {
                btn.style.background = active ? '#007acc' : 'transparent';
                btn.style.border = active ? '1px solid #007acc' : '1px solid rgba(255,255,255,0.2)';
                btn.style.color = active ? '#fff' : '#ccc';
            }
        };

        updateBtnStyle('viewport-stl-solids-btn', vpNode.parameters.stl_solids !== false);
        updateBtnStyle('viewport-stl-wf-btn', !!vpNode.parameters.stl_wireframe);
        updateBtnStyle('viewport-stl-show-results-btn', vpNode.parameters.stl_show_results !== false);
        updateBtnStyle('viewport-stl-autoscale-btn', vpNode.parameters.stl_auto_scale !== false);
        updateBtnStyle('viewport-stl-logscale-btn', vpNode.parameters.stl_log_scale === true);

        const stlQtySel = document.getElementById(this.getElId('viewport-stl-qty-sel')) as HTMLSelectElement;
        if (stlQtySel && stlQtySel.dataset.editing !== 'true' && document.activeElement !== stlQtySel) {
            stlQtySel.value = vpNode.parameters.stl_quantity || 'pressure';
        }

        const stlOpacSlider = document.getElementById(this.getElId('viewport-stl-opacity-slider')) as HTMLInputElement;
        const stlOpacInp = stlOpacSlider?.parentElement?.querySelector('input[type="number"]') as HTMLInputElement;
        if (stlOpacSlider && document.activeElement !== stlOpacSlider && document.activeElement !== stlOpacInp) {
            const val = vpNode.parameters.stl_opacity ?? 0.5;
            stlOpacSlider.value = String(val);
            if (stlOpacInp) stlOpacInp.value = String(val);
        }

        const stlCmSel = document.getElementById(this.getElId('viewport-stl-colormap-sel')) as HTMLSelectElement;
        if (stlCmSel && stlCmSel.dataset.editing !== 'true' && document.activeElement !== stlCmSel) {
            stlCmSel.value = vpNode.parameters.stl_colormap || 'plasma';
        }

        // Obstacles Sync
        const obsShowCb = document.getElementById(this.getElId('viewport-obs-show-cb')) as HTMLInputElement;
        if (obsShowCb && document.activeElement !== obsShowCb) {
            obsShowCb.checked = vpNode.parameters.show_obstacles === true;
        }

        const obsGridCb = document.getElementById(this.getElId('viewport-obs-grid-cb')) as HTMLInputElement;
        if (obsGridCb && document.activeElement !== obsGridCb) {
            obsGridCb.checked = vpNode.parameters.obstacles_gridlines !== false;
        }

        const obsSolidCb = document.getElementById(this.getElId('viewport-obs-solid-cb')) as HTMLInputElement;
        if (obsSolidCb && document.activeElement !== obsSolidCb) {
            obsSolidCb.checked = vpNode.parameters.obstacles_solid !== false;
        }

        const obsLightCb = document.getElementById(this.getElId('viewport-obs-light-cb')) as HTMLInputElement;
        if (obsLightCb && document.activeElement !== obsLightCb) {
            obsLightCb.checked = vpNode.parameters.obstacles_lighting !== false;
        }

        const obsAutoCb = document.getElementById(this.getElId('viewport-obs-auto-cb')) as HTMLInputElement;
        if (obsAutoCb && document.activeElement !== obsAutoCb) {
            obsAutoCb.checked = vpNode.parameters.obstacles_auto_scale !== false;
        }

        const obsLogCb = document.getElementById(this.getElId('viewport-obs-log-cb')) as HTMLInputElement;
        if (obsLogCb && document.activeElement !== obsLogCb) {
            obsLogCb.checked = vpNode.parameters.obstacles_log_scale === true;
        }

        const obsInterpCb = document.getElementById(this.getElId('viewport-obs-interp-cb')) as HTMLInputElement;
        if (obsInterpCb && document.activeElement !== obsInterpCb) {
            obsInterpCb.checked = vpNode.parameters.obstacles_interpolate !== false;
        }

        const obsMinInp = document.getElementById(this.getElId('viewport-obs-min-input')) as HTMLInputElement;
        if (obsMinInp && obsMinInp.dataset.editing !== 'true' && document.activeElement !== obsMinInp) {
            const val = vpNode.parameters.obstacles_min_val ?? 101325.0;
            obsMinInp.value = String(val);
            const isAuto = vpNode.parameters.obstacles_auto_scale !== false;
            obsMinInp.disabled = isAuto;
            obsMinInp.style.background = isAuto ? '#0c0c0d' : '#1a1a1c';
            obsMinInp.style.color = isAuto ? '#666' : '#ccc';
        }

        const obsMaxInp = document.getElementById(this.getElId('viewport-obs-max-input')) as HTMLInputElement;
        if (obsMaxInp && obsMaxInp.dataset.editing !== 'true' && document.activeElement !== obsMaxInp) {
            const val = vpNode.parameters.obstacles_max_val ?? 1013250.0;
            obsMaxInp.value = String(val);
            const isAuto = vpNode.parameters.obstacles_auto_scale !== false;
            obsMaxInp.disabled = isAuto;
            obsMaxInp.style.background = isAuto ? '#0c0c0d' : '#1a1a1c';
            obsMaxInp.style.color = isAuto ? '#666' : '#ccc';
        }

        const obsQtySel = document.getElementById(this.getElId('viewport-obs-qty-sel')) as HTMLSelectElement;
        if (obsQtySel && obsQtySel.dataset.editing !== 'true' && document.activeElement !== obsQtySel) {
            obsQtySel.value = vpNode.parameters.obstacles_quantity || 'pressure';
        }

        const obsCmSel = document.getElementById(this.getElId('viewport-obs-colormap-sel')) as HTMLSelectElement;
        if (obsCmSel && obsCmSel.dataset.editing !== 'true' && document.activeElement !== obsCmSel) {
            obsCmSel.value = vpNode.parameters.obstacles_colormap || 'plasma';
        }

        const obsOpacSlider = document.getElementById(this.getElId('viewport-obs-opacity-slider')) as HTMLInputElement;
        const obsOpacInp = obsOpacSlider?.parentElement?.querySelector('input[type="number"]') as HTMLInputElement;
        if (obsOpacSlider && document.activeElement !== obsOpacSlider && document.activeElement !== obsOpacInp) {
            const val = vpNode.parameters.obstacles_opacity ?? 1.0;
            obsOpacSlider.value = String(val);
            if (obsOpacInp) obsOpacInp.value = String(val);
        }

        // Bounding Box & Grid Sync
        const gridOpacSlider = document.getElementById(this.getElId('viewport-grid-opacity-slider')) as HTMLInputElement;
        const gridOpacInp = gridOpacSlider?.parentElement?.querySelector('input[type="number"]') as HTMLInputElement;
        if (gridOpacSlider && document.activeElement !== gridOpacSlider && document.activeElement !== gridOpacInp) {
            const val = vpNode.parameters.grid_opacity ?? 1.0;
            gridOpacSlider.value = String(val);
            if (gridOpacInp) gridOpacInp.value = String(val);
        }

        const boxCb = document.getElementById(this.getElId('viewport-box-cb')) as HTMLInputElement;
        if (boxCb && document.activeElement !== boxCb) {
            boxCb.checked = vpNode.parameters.show_grid_box !== false;
        }

        // Gauges Sync
        const showGauges = vpNode.parameters.show_gauges !== false;
        const gaugeSize = vpNode.parameters.gauge_size ?? 1.0;
        const gaugeOpacity = vpNode.parameters.gauge_opacity ?? 1.0;
        const gaugeQuantity = vpNode.parameters.gauge_quantity || 'pressure';
        const gaugeSolid = vpNode.parameters.gauge_solid !== false;
        const gauges = this.getVirtualGauges();

        const showGaugesCb = document.getElementById(this.getElId('viewport-gauges-show-cb')) as HTMLInputElement;
        if (showGaugesCb) showGaugesCb.checked = showGauges;

        const gaugeSizeSlider = document.getElementById(this.getElId('viewport-gauge-size-slider')) as HTMLInputElement;
        const gaugeSizeInp = gaugeSizeSlider?.parentElement?.querySelector('input[type="number"]') as HTMLInputElement;
        if (gaugeSizeSlider && document.activeElement !== gaugeSizeSlider && document.activeElement !== gaugeSizeInp) {
            gaugeSizeSlider.value = String(gaugeSize);
            if (gaugeSizeInp) gaugeSizeInp.value = String(gaugeSize);
        }

        const gaugeOpacSlider = document.getElementById(this.getElId('viewport-gauge-opacity-slider')) as HTMLInputElement;
        const gaugeOpacInp = gaugeOpacSlider?.parentElement?.querySelector('input[type="number"]') as HTMLInputElement;
        if (gaugeOpacSlider && document.activeElement !== gaugeOpacSlider && document.activeElement !== gaugeOpacInp) {
            gaugeOpacSlider.value = String(gaugeOpacity);
            if (gaugeOpacInp) gaugeOpacInp.value = String(gaugeOpacity);
        }

        const gaugeQtySel = document.getElementById(this.getElId('viewport-gauge-qty-sel')) as HTMLSelectElement;
        if (gaugeQtySel && gaugeQtySel.dataset.editing !== 'true' && document.activeElement !== gaugeQtySel) {
            gaugeQtySel.value = gaugeQuantity;
        }

        const gaugeSolidCb = document.getElementById(this.getElId('viewport-gauge-solid-cb')) as HTMLInputElement;
        if (gaugeSolidCb && document.activeElement !== gaugeSolidCb) {
            gaugeSolidCb.checked = gaugeSolid;
        }

        if (postToWorker) {
            const qCmaps = vpNode.parameters.quantity_colormaps || {};
            const stlQty = vpNode.parameters.stl_quantity || 'pressure';
            const resStlCmap = qCmaps[stlQty] || vpNode.parameters.stl_colormap || 'plasma';

            const obsQty = vpNode.parameters.obstacles_quantity || 'pressure';
            const resObsCmap = qCmaps[obsQty] || vpNode.parameters.obstacles_colormap || 'plasma';

            this.worker.postMessage({
                type: 'setConfig',
                data: {
                    quantityColormaps: qCmaps,
                    showGauges,
                    gaugeSize,
                    gaugeOpacity,
                    gaugeQuantity,
                    gaugeSolid,
                    gauges,
                    gridOpacity: vpNode.parameters.grid_opacity ?? 1.0,
                    gridMeshlines: vpNode.parameters.cell_edges === true,
                    showGridBox: vpNode.parameters.show_grid_box !== false,
                    stlColormap: resStlCmap,
                    obstaclesColormap: resObsCmap,
                    obstaclesQuantity: obsQty,
                    obstaclesSolid: vpNode.parameters.obstacles_solid !== false,
                    obstaclesGridlines: vpNode.parameters.obstacles_gridlines !== false,
                    obstaclesLighting: vpNode.parameters.obstacles_lighting !== false,
                    obstaclesOpacity: vpNode.parameters.obstacles_opacity ?? 1.0,
                    obstaclesAutoScale: vpNode.parameters.obstacles_auto_scale !== false,
                    obstaclesLogScale: vpNode.parameters.obstacles_log_scale === true,
                    obstaclesInterpolate: vpNode.parameters.obstacles_interpolate !== false,
                    obstaclesMinVal: vpNode.parameters.obstacles_min_val ?? 101325.0,
                    obstaclesMaxVal: vpNode.parameters.obstacles_max_val ?? 1013250.0
                }
            });
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
                        net.send({ command: "LOAD_STL_GEOMETRY", filePath: geomNode.parameters.stl_file || '', modelId: this.getCurrentModelId() });
                    } else if (geomNode.type === 'PrimitiveGeometry3D') {
                        net.send({ command: "LOAD_PRIMITIVE_GEOMETRY", primitives: geomNode.parameters.primitives || [], modelId: this.getCurrentModelId() });
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
            this.buildGridRow(this.staticListContainer);
            this.buildGaugeRow(this.staticListContainer);
            this.buildLightingTableRow(this.staticListContainer);
        }

        // 2. Sync Slices Row list
        const slices = vpNode.parameters.slices || [];
        if (this.sliceListContainer) {
            const currentRows = this.sliceListContainer.children.length;
            // Force rebuild if any slice parameter, colormap, opacity, or range changed
            const qCmaps = vpNode.parameters.quantity_colormaps || {};
            const qRanges = vpNode.parameters.quantity_ranges || {};
            const currSliceKey = slices.map((s: any) => {
                const q = s.quantities?.[0] || 'pressure';
                const cm = qCmaps[q] || s.colormap || 'plasma';
                const op = s.opacity ?? 1.0;
                const r = qRanges[q] || [s.min_val, s.max_val];
                return `${s.axis}:${q}:${s.enabled !== false}:${cm}:${op}:${s.auto_scale !== false}:${s.log_scale === true}:${r?.[0]}:${r?.[1]}`;
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
                    const axisShort = (slice.axis || 'xy').toUpperCase();

                    const posPill = document.createElement('button');
                    posPill.innerHTML = `📐 <b>${axisShort}</b> @ ${curOffset.toFixed(2)}m ▾`;
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
                    const initInterp = slice.interpolate !== false;
                    tdRes.appendChild(this.createToggleBtn(`slice-interp-btn-${idx}`, 'Int', initInterp, (v) => {
                        this.updateSliceProperty(idx, { interpolate: v });
                    }));
                    tr.appendChild(tdRes);

                    // Col 6: QTY (Quantity Popover Pill)
                    const tdQty = document.createElement('td');
                    tdQty.style.padding = '3px 4px';
                    const qtyPill = document.createElement('button');
                    const qtyLabels: Record<string, string> = {
                        pressure: 'Press', density: 'Density', velocity: 'Speed', energy: 'Energy',
                        species1: 'Reacted', species2: 'Unreacted', species3: 'Air',
                        peak_overpressure: 'Pk Press', peak_impulse: 'Pk Impulse'
                    };
                    qtyPill.textContent = `${qtyLabels[qty] || qty} ▾`;
                    this.applyButtonStyle(qtyPill);
                    qtyPill.style.fontSize = '8.5px';
                    qtyPill.style.width = '100%';
                    qtyPill.style.padding = '2px 0';
                    qtyPill.onclick = (e) => {
                        e.stopPropagation();
                        this.showQuantityPopover(qtyPill, qty, (newQ) => {
                            const qCmaps = vpNode.parameters.quantity_colormaps || {};
                            const newCmap = qCmaps[newQ] || 'plasma';
                            this.updateSliceProperty(idx, { quantities: [newQ], colormap: newCmap });
                        });
                    };
                    tdQty.appendChild(qtyPill);
                    tr.appendChild(tdQty);

                    // Col 7: COLOR (Colormap Popover Button)
                    const tdCmap = document.createElement('td');
                    tdCmap.style.padding = '3px 4px';
                    const curCmap = vpNode.parameters.quantity_colormaps?.[qty] || slice.colormap || 'plasma';
                    const cmapPill = document.createElement('button');
                    cmapPill.textContent = `${curCmap.charAt(0).toUpperCase() + curCmap.slice(1)} ▾`;
                    this.applyButtonStyle(cmapPill);
                    cmapPill.style.fontSize = '8.5px';
                    cmapPill.style.width = '100%';
                    cmapPill.style.padding = '2px 0';
                    cmapPill.onclick = (e) => {
                        e.stopPropagation();
                        this.showColormapPopover(cmapPill, curCmap, (newC) => {
                            this.setQuantityColormap(qty, newC);
                        });
                    };
                    tdCmap.appendChild(cmapPill);
                    tr.appendChild(tdCmap);

                    // Col 8: SCL (Auto, Log & Range Popover)
                    const tdScl = document.createElement('td');
                    tdScl.style.padding = '3px 2px';
                    const sclWrap = document.createElement('div');
                    sclWrap.style.display = 'flex';
                    sclWrap.style.gap = '2px';
                    
                    const interpScaleVal = slice.interpolate !== false;
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
                        this.showRangePopover(cfgBtn, qty, curRange[0], curRange[1], autoScaleVal, logScaleVal, interpScaleVal, (minV, maxV, autoVal, logVal, interpVal) => {
                            this.setQuantityRange(qty, minV, maxV, autoVal, logVal);
                            if (interpVal !== undefined) {
                                this.updateSliceProperty(idx, { interpolate: interpVal });
                            }
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

                    const linkGroup = slice.link_group || 'none';

                    row.style.background = idx === focusedSliceIndex ? 'rgba(0, 173, 255, 0.05)' : 'rgba(255,255,255,0.03)';
                    row.style.border = idx === focusedSliceIndex ? '1px solid #00adff' : '1px solid rgba(255,255,255,0.06)';
                    row.style.opacity = slice.enabled !== false ? '1.0' : '0.55';

                    const enableCb = row.querySelector('.slice-enable-cb') as HTMLInputElement;
                    if (enableCb && enableCb.dataset.editing !== 'true' && document.activeElement !== enableCb) {
                        enableCb.checked = slice.enabled !== false;
                    }

                    const bounds = getSliceBounds(slice.axis, meshNode);

                    // Sync basic selects if not active
                    const axisSel = row.querySelector('.slice-axis-sel') as HTMLSelectElement;
                    if (axisSel && axisSel.dataset.editing !== 'true' && document.activeElement !== axisSel) {
                        axisSel.value = slice.axis;
                    }
                    const qSel = row.querySelector('.slice-qty-sel') as HTMLSelectElement;
                    if (qSel && qSel.dataset.editing !== 'true' && document.activeElement !== qSel) {
                        qSel.value = slice.quantities?.[0] || 'pressure';
                    }
                    const strideSel = row.querySelector('.slice-stride-sel') as HTMLSelectElement;
                    if (strideSel && strideSel.dataset.editing !== 'true' && document.activeElement !== strideSel) {
                        strideSel.value = String(slice.stride || 1);
                    }

                    // Sync sliders
                    const offSlider = row.querySelector('.slice-offset-slider') as HTMLInputElement;
                    if (offSlider) {
                        offSlider.min = bounds.min.toString();
                        offSlider.max = bounds.max.toString();
                        offSlider.step = Math.max(0.001, (bounds.max - bounds.min) / 100).toString();
                        if (offSlider.dataset.editing !== 'true' && document.activeElement !== offSlider) {
                            offSlider.value = slice.offset.toString();
                        }
                    }
                    const offInp = row.querySelector('.slice-offset-val') as HTMLInputElement;
                    if (offInp && offInp.dataset.editing !== 'true' && document.activeElement !== offInp) {
                        offInp.value = slice.offset.toString();
                    }

                    const opacSlider = row.querySelector('.slice-opac-slider') as HTMLInputElement;
                    if (opacSlider && opacSlider.dataset.editing !== 'true' && document.activeElement !== opacSlider) {
                        opacSlider.value = (slice.opacity !== undefined ? slice.opacity : 1.0).toString();
                    }
                    const opacInp = row.querySelector('.slice-opac-val') as HTMLInputElement;
                    if (opacInp && opacInp.dataset.editing !== 'true' && document.activeElement !== opacInp) {
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
                        if (checkboxes[0].dataset.editing !== 'true' && document.activeElement !== checkboxes[0]) {
                            checkboxes[0].checked = autoScaleVal;
                        }
                        if (checkboxes[1].dataset.editing !== 'true' && document.activeElement !== checkboxes[1]) {
                            checkboxes[1].checked = slice.log_scale === true;
                        }
                        if (checkboxes[2].dataset.editing !== 'true' && document.activeElement !== checkboxes[2]) {
                            checkboxes[2].checked = slice.interpolate !== false;
                        }
                    }

                    // Sync colormap
                    const cmSel = row.querySelector('.slice-colormap-sel') as HTMLSelectElement;
                    if (cmSel && cmSel.dataset.editing !== 'true' && document.activeElement !== cmSel) {
                        cmSel.value = slice.colormap || 'plasma';
                    }

                    // Sync min / max inputs
                    const minInput = row.querySelector('.slice-min-input') as HTMLInputElement;
                    if (minInput) {
                        minInput.disabled = autoScaleVal;
                        minInput.style.background = autoScaleVal ? '#0c0c0d' : '#1a1a1c';
                        minInput.style.color = autoScaleVal ? '#666' : '#ccc';
                        if (minInput.dataset.editing !== 'true' && document.activeElement !== minInput) {
                            minInput.value = String(minRangeVal);
                        }
                    }

                    const maxInput = row.querySelector('.slice-max-input') as HTMLInputElement;
                    if (maxInput) {
                        maxInput.disabled = autoScaleVal;
                        maxInput.style.background = autoScaleVal ? '#0c0c0d' : '#1a1a1c';
                        maxInput.style.color = autoScaleVal ? '#666' : '#ccc';
                        if (maxInput.dataset.editing !== 'true' && document.activeElement !== maxInput) {
                            maxInput.value = String(maxRangeVal);
                        }
                    }
                });
            }

            // Sync configuration to WebWorker
            if (postToWorker) {
                const qCmaps = vpNode.parameters.quantity_colormaps || {};
                const resSlices = (slices || []).map((s: any) => {
                    const q = s.quantities?.[0] || 'pressure';
                    return { ...s, colormap: qCmaps[q] || s.colormap || 'plasma' };
                });
                const opacities = resSlices.map((s: any) => s.opacity !== undefined ? s.opacity : 1.0);
                this.worker.postMessage({
                    type: 'setConfig',
                    data: {
                        lightingEnabled: vpNode.parameters.lightingEnabled !== false,
                        aoEnabled: vpNode.parameters.aoEnabled !== false,
                        ambientLevel: vpNode.parameters.ambientLevel ?? 0.3,
                        specularIntensity: vpNode.parameters.specularIntensity ?? 0.4,
                        sliceOpacities: opacities,
                        slices: resSlices,
                        focusedSliceIndex: vpNode.parameters.focusedSliceIndex ?? 0,
                        quantityRanges: vpNode.parameters.quantity_ranges || {}
                    }
                });
            }
        }

        // 4. Find connected domain mesh dimensions and configure worker
        let dimX = 1.0, dimY = 1.0, dimZ = 1.0, cellSize = 0.01;
        let xmin = 0.0, ymin = 0.0, zmin = 0.0;
        if (meshNode && meshNode.type === 'DomainMesh3D') {
            xmin = Number(meshNode.parameters?.xmin ?? meshNode.parameters?.x_min ?? 0.0);
            const xmax = Number(meshNode.parameters?.xmax ?? meshNode.parameters?.x_max ?? 1.0);
            ymin = Number(meshNode.parameters?.ymin ?? meshNode.parameters?.y_min ?? 0.0);
            const ymax = Number(meshNode.parameters?.ymax ?? meshNode.parameters?.y_max ?? 1.0);
            zmin = Number(meshNode.parameters?.zmin ?? meshNode.parameters?.z_min ?? 0.0);
            const zmax = Number(meshNode.parameters?.zmax ?? meshNode.parameters?.z_max ?? 1.0);
            dimX = xmax - xmin;
            dimY = ymax - ymin;
            dimZ = zmax - zmin;
            cellSize = Number(meshNode.parameters?.cell_size ?? 0.01);
        }
        const nx = Math.round(dimX / cellSize);
        const ny = Math.round(dimY / cellSize);
        const nz = Math.round(dimZ / cellSize);

        const { min: syncFocusedMin, max: syncFocusedMax } = getFocusedQuantityAndRange(vpNode);

        const qCmaps = vpNode.parameters.quantity_colormaps || {};
        const stlQty = vpNode.parameters.stl_quantity || 'pressure';
        const resStlCmap = qCmaps[stlQty] || vpNode.parameters.stl_colormap || 'plasma';

        const obsQty = vpNode.parameters.obstacles_quantity || 'pressure';
        const resObsCmap = qCmaps[obsQty] || vpNode.parameters.obstacles_colormap || 'plasma';

        const resSlices = (vpNode.parameters.slices || []).map((s: any) => {
            const q = s.quantities?.[0] || 'pressure';
            return { ...s, colormap: qCmaps[q] || s.colormap || 'plasma' };
        });

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
            stlColormap: resStlCmap,
            stlShowResults: vpNode.parameters.stl_show_results !== false,
            stlQuantity: stlQty,
            stlSamplingMode: vpNode.parameters.stl_sampling_mode || 'nearest',
            stlAutoScale: vpNode.parameters.stl_auto_scale !== false,
            stlLogScale: vpNode.parameters.stl_log_scale === true,
            stlMinVal: vpNode.parameters.stl_min_val ?? 101325.0,
            stlMaxVal: vpNode.parameters.stl_max_val ?? 1013250.0,
            slices: resSlices,
            focusedSliceIndex: vpNode.parameters.focusedSliceIndex ?? 0,
            quantityColormaps: qCmaps,
            quantityRanges: vpNode.parameters.quantity_ranges || {},
            showObstacles: vpNode.parameters.show_obstacles !== false,
            obstaclesGridlines: vpNode.parameters.obstacles_gridlines !== false,
            obstaclesLighting: vpNode.parameters.obstacles_lighting !== false,
            obstaclesOpacity: vpNode.parameters.obstacles_opacity ?? 1.0,
            obstaclesQuantity: obsQty,
            obstaclesColormap: resObsCmap
        };

        const cachedConfig = this.stateManager.getTelemetry(vpNode.id + "-config-3d");
        if (cachedConfig) {
            this.hasTelemetryGrid = true;
            configData.xmin = cachedConfig.xmin;
            configData.ymin = cachedConfig.ymin;
            configData.zmin = cachedConfig.zmin;
            configData.dx = cachedConfig.dx;
            configData.nx = cachedConfig.nx;
            configData.ny = cachedConfig.ny;
            configData.nz = cachedConfig.nz;
        } else if (!this.hasTelemetryGrid) {
            configData.xmin = xmin;
            configData.ymin = ymin;
            configData.zmin = zmin;
            configData.dx = cellSize;
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
        const vpNode = this.getViewportNode();
        if (vpNode) {
            const allModels = this.stateManager.getAllModels();
            for (const m of Object.values(allModels)) {
                if (m.nodes.some(n => n.id === vpNode.id)) {
                    return m.id;
                }
            }
        }
        // If viewportNodeId is set but didn't match a canvas node, check if it's a model ID directly
        if (this.viewportNodeId) {
            const allModels = this.stateManager.getAllModels();
            const matchedModel = allModels.find(m => m.id === this.viewportNodeId);
            if (matchedModel) return matchedModel.id;
        }
        const ws = this.stateManager.getActiveWorkspace();
        return ws ? ws.activeModelId : null;
    }

    public pushFrame(buffer: ArrayBuffer, modelId?: string) {
        if (modelId && this.getCurrentModelId() !== modelId) return;
        this.worker.postMessage({ type: 'frame', data: { buffer } }, [buffer]);
    }

    public updateTelemetry(data: any, modelId?: string) {
        if (modelId && this.getCurrentModelId() !== modelId) return;
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

        // Force geometry reload
        this.currentGeometryHash = '';
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
        const initShow = vpNode ? (vpNode.parameters.show_obstacles === true) : false;
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
                        refresh_rate: Number(vp.parameters.refresh_rate ?? 2.0)
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
        qtySel.innerHTML = '<option value="pressure">Pressure</option><option value="density">Density</option><option value="velocity">Speed</option><option value="energy">Energy</option><option value="species1">Reacted (Alpha1)</option><option value="species2">Unreacted (Alpha2)</option><option value="species3">Air</option><option value="peak_overpressure">Peak Overpressure</option><option value="peak_impulse">Peak Impulse</option>';
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
                    const showObstacles = vp.parameters.show_obstacles === true;
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
                        refresh_rate: Number(vp.parameters.refresh_rate ?? 2.0)
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

        // Find which model globally contains this viewport node
        const allModels = this.stateManager.getAllModels();
        let targetModel: any = null;
        for (const m of Object.values(allModels)) {
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

    private getGeometryNode(): Node | null {
        const vpNode = this.getViewportNode();
        const allModels = this.stateManager.getAllModels();
        let targetModel: any = null;

        if (vpNode) {
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
                targetModel = allModels.find(m => m.id === ws.activeModelId);
            }
        }

        if (!targetModel) return null;

        // 1. Recursively trace upstream from viewport node through intermediate nodes (VTKOutput, CFDSolver3D, etc.)
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

        // 2. Fallback: Find geometry connected to any CFDSolver3D or anywhere in model
        const geomNode = targetModel.nodes.find((n: any) => n.type === 'STLGeometry' || n.type === 'PrimitiveGeometry3D');
        if (geomNode) return geomNode;

        return null;
    }

    private getVirtualGauges(): any[] {
        const vpNode = this.getViewportNode();
        if (!vpNode) return [];

        const allModels = this.stateManager.getAllModels();
        let targetModel: any = null;
        for (const m of Object.values(allModels)) {
            if (m.nodes.some(n => n.id === vpNode.id)) {
                targetModel = m;
                break;
            }
        }
        if (!targetModel) {
            const ws = this.stateManager.getActiveWorkspace();
            if (ws && ws.activeModelId) {
                targetModel = allModels.find(m => m.id === ws.activeModelId);
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
        this.worker.postMessage({
            type: 'setObstaclesGeometry',
            data: { vertices, cells, meshId }
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
        const xmin = Number(meshNode.parameters?.xmin ?? meshNode.parameters?.x_min ?? 0.0);
        const xmax = Number(meshNode.parameters?.xmax ?? meshNode.parameters?.x_max ?? 1.0);
        const ymin = Number(meshNode.parameters?.ymin ?? meshNode.parameters?.y_min ?? 0.0);
        const ymax = Number(meshNode.parameters?.ymax ?? meshNode.parameters?.y_max ?? 1.0);
        const zmin = Number(meshNode.parameters?.zmin ?? meshNode.parameters?.z_min ?? 0.0);
        const zmax = Number(meshNode.parameters?.zmax ?? meshNode.parameters?.z_max ?? 1.0);
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

