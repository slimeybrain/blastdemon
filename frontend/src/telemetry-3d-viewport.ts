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
    private overlayCanvas: HTMLCanvasElement | null = null;
    private overlayCtx: CanvasRenderingContext2D | null = null;
    private latestFrameData: any = null;

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

    // Colorbar Overlay Elements
    private colorbarOverlay: HTMLElement | null = null;
    private colorbarGradientEl: HTMLElement | null = null;
    private colorbarTitleEl: HTMLElement | null = null;
    private colorbarTicksContainer: HTMLElement | null = null;
    private colorbarAutoBadge: HTMLElement | null = null;
    private colorbarLogBadge: HTMLElement | null = null;
    private colorbarCmapBadge: HTMLElement | null = null;
    private usePerspective: boolean = true;

    private viewTypeSuffix: string;
    private viewportNodeId: string | null = null;
    private virtualNodes: Record<string, any> = {};

    private getElId(base: string): string {
        return `${base}-${this.panelId}${this.viewTypeSuffix}`;
    }

    constructor(container: HTMLElement, panelId: string, stateManager: StateManager, viewTypeSuffix: string = '', viewportNodeId?: string | null) {
        this.container = container;
        this.panelId = panelId;
        this.stateManager = stateManager;
        this.viewTypeSuffix = viewTypeSuffix;
        this.viewportNodeId = viewportNodeId || null;

        // Monkey patch stateManager.updateNodeParametersInPlace to support virtual viewport updates
        const origUpdate = this.stateManager.updateNodeParametersInPlace;
        this.stateManager.updateNodeParametersInPlace = (nodeId: string, parameters: Record<string, any>) => {
            if (nodeId.startsWith('virtual-viewport-')) {
                const modelId = nodeId.substring('virtual-viewport-'.length);
                if (this.virtualNodes[modelId]) {
                    Object.assign(this.virtualNodes[modelId].parameters, parameters);
                    this.syncControls(true);
                }
                origUpdate.call(this.stateManager, nodeId, parameters);
            } else {
                origUpdate.call(this.stateManager, nodeId, parameters);
            }
        };

        // Container relative positioning
        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';

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
        this.overlayCtx = this.overlayCanvas.getContext('2d');

        this.worker = new Worker(new URL('./ViewportWorker.ts?t=' + Date.now(), import.meta.url), { type: 'module' });

        this.worker.onmessage = (e) => {
            const { type, renderer, min, max } = e.data;
            if (type === 'renderFrame') {
                this.latestFrameData = e.data.data;
                this.drawTicks();
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
            } else if (type === 'log') {
                console.log("[ViewportWorker Log]", e.data.message);
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
        const dpr = window.devicePixelRatio || 1;
        // @ts-ignore
        const offscreen = this.canvas.transferControlToOffscreen();
        this.worker.postMessage({
            type: 'init',
            data: {
                canvas: offscreen,
                width: (rect.width || 800) * dpr,
                height: (rect.height || 600) * dpr
            }
        }, [offscreen]);

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

        const triggerResize = () => {
            const r = this.container.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            if (r.width > 0 && r.height > 0) {
                this.worker.postMessage({
                    type: 'resize',
                    data: {
                        width: r.width * dpr,
                        height: r.height * dpr
                    }
                });
                if (this.overlayCanvas) {
                    this.overlayCanvas.width = r.width * dpr;
                    this.overlayCanvas.height = r.height * dpr;
                    this.drawTicks();
                }
            }
        };

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
                if (this.overlayCanvas) {
                    this.overlayCanvas.width = entry.contentRect.width * dpr;
                    this.overlayCanvas.height = entry.contentRect.height * dpr;
                    this.drawTicks();
                }
            }
        }).observe(this.container);

        requestAnimationFrame(triggerResize);
        setTimeout(triggerResize, 100);
        setTimeout(triggerResize, 500);

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
            if (e.button === 0 && e.ctrlKey) {
                const rect = this.canvas.getBoundingClientRect();
                const dpr = window.devicePixelRatio || 1;
                const mouseX = (e.clientX - rect.left) * dpr;
                const mouseY = (e.clientY - rect.top) * dpr;
                this.worker.postMessage({
                    type: 'setRotationCenterFromClick',
                    data: { mouseX, mouseY }
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

        // Build Camera & View Card
        this.buildCameraViewCard(content);

        // Build Floating HUD View Toolbar
        this.buildFloatingViewHUD();
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
        this.buildChargeRow(staticTbody);
        this.buildGridRow(staticTbody);
        this.buildGaugeRow(staticTbody);
        this.buildMPMParticlesTableRow(staticTbody);
        this.buildLightingTableRow(staticTbody);
        this.buildColorbarTableRow(staticTbody);
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
            { id: 'vonMises', label: '🛡️ Von Mises' },
            { id: 'plastic_strain', label: '🔨 Plastic Strain' },
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
            peak_overpressure: 'Pk Press', peak_impulse: 'Pk Impulse', amr_level: 'AMR Level'
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
            peak_overpressure: 'Pk Press', peak_impulse: 'Pk Impulse', amr_level: 'AMR Level'
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
            peak_overpressure: 'Pk Press', peak_impulse: 'Pk Impulse', amr_level: 'AMR Level'
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

    private getColormapCssGradient(cmapId: string, direction: 'to top' | 'to right' = 'to top'): string {
        const cmapGradients: Record<string, string> = {
            plasma: '#0d0887, #6a00a8, #b12a90, #e16462, #fca636, #f0f921',
            viridis: '#440154, #3b528b, #21908d, #5dc963, #fde725',
            rainbow: '#0000ff, #00ffff, #00ff00, #ffff00, #ff0000',
            coolwarm: '#3b4cc0, #88b0f3, #ddd, #f49a7b, #b40426',
            cividis: '#002051, #395276, #678685, #9eb980, #fdea45',
            grayscale: '#000000, #ffffff'
        };
        const stops = cmapGradients[cmapId] || cmapGradients.plasma;
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

    private buildColorbarOverlay() {
        if (this.colorbarOverlay) return;

        const overlay = document.createElement('div');
        overlay.id = this.getElId('viewport-colorbar-overlay');
        overlay.className = 'viewport-colorbar-container';
        overlay.style.position = 'absolute';
        overlay.style.zIndex = '1000';
        overlay.style.background = 'rgba(16, 16, 19, 0.85)';
        overlay.style.backdropFilter = 'blur(12px)';
        overlay.style.border = '1px solid rgba(255, 255, 255, 0.15)';
        overlay.style.borderRadius = '8px';
        overlay.style.padding = '8px 10px';
        overlay.style.display = 'flex';
        overlay.style.flexDirection = 'column';
        overlay.style.gap = '6px';
        overlay.style.color = '#e0e0e0';
        overlay.style.fontFamily = 'system-ui, -apple-system, sans-serif';
        overlay.style.fontSize = '10px';
        overlay.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.6)';
        overlay.style.userSelect = 'none';
        overlay.style.boxSizing = 'border-box';
        overlay.style.pointerEvents = 'auto';

        // 1. Header (Title + Badges)
        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.alignItems = 'center';
        header.style.justifyContent = 'space-between';
        header.style.gap = '6px';

        // Quantity Title Button
        const titleSpan = document.createElement('span');
        titleSpan.style.fontWeight = 'bold';
        titleSpan.style.color = '#00adff';
        titleSpan.style.cursor = 'pointer';
        titleSpan.style.fontSize = '10px';
        titleSpan.style.letterSpacing = '0.5px';
        titleSpan.style.textTransform = 'uppercase';
        titleSpan.title = 'Click to change quantity';
        titleSpan.onclick = (e) => {
            e.stopPropagation();
            const vpNode = this.getViewportNode();
            const { quantity: curQty } = getFocusedQuantityAndRange(vpNode || {});
            this.showQuantityPopover(titleSpan, curQty, (newQ) => {
                this.setFocusedQuantity(newQ);
            });
        };
        this.colorbarTitleEl = titleSpan;
        header.appendChild(titleSpan);

        // Badges container
        const badgesWrap = document.createElement('div');
        badgesWrap.style.display = 'flex';
        badgesWrap.style.alignItems = 'center';
        badgesWrap.style.gap = '4px';

        // Auto / Manual Badge
        const autoBadge = document.createElement('span');
        autoBadge.style.fontSize = '8px';
        autoBadge.style.fontWeight = 'bold';
        autoBadge.style.padding = '1px 4px';
        autoBadge.style.borderRadius = '3px';
        autoBadge.style.cursor = 'pointer';
        autoBadge.title = 'Click to toggle Auto / Manual scale';
        autoBadge.onclick = (e) => {
            e.stopPropagation();
            const vpNode = this.getViewportNode();
            if (vpNode) {
                const curAuto = vpNode.parameters.auto_scale !== false;
                this.stateManager.updateNodeParametersInPlace(vpNode.id, { auto_scale: !curAuto });
                this.syncControls(true);
            }
        };
        this.colorbarAutoBadge = autoBadge;
        badgesWrap.appendChild(autoBadge);

        // Lin / Log Badge
        const logBadge = document.createElement('span');
        logBadge.style.fontSize = '8px';
        logBadge.style.fontWeight = 'bold';
        logBadge.style.padding = '1px 4px';
        logBadge.style.borderRadius = '3px';
        logBadge.style.cursor = 'pointer';
        logBadge.title = 'Click to toggle Linear / Logarithmic scale';
        logBadge.onclick = (e) => {
            e.stopPropagation();
            const vpNode = this.getViewportNode();
            if (vpNode) {
                const curLog = vpNode.parameters.log_scale === true;
                this.stateManager.updateNodeParametersInPlace(vpNode.id, { log_scale: !curLog });
                this.syncControls(true);
            }
        };
        this.colorbarLogBadge = logBadge;
        badgesWrap.appendChild(logBadge);

        // Colormap Badge
        const cmapBadge = document.createElement('span');
        cmapBadge.style.fontSize = '8px';
        cmapBadge.style.fontWeight = 'bold';
        cmapBadge.style.padding = '1px 4px';
        cmapBadge.style.borderRadius = '3px';
        cmapBadge.style.cursor = 'pointer';
        cmapBadge.style.background = 'rgba(255, 255, 255, 0.1)';
        cmapBadge.style.border = '1px solid rgba(255, 255, 255, 0.2)';
        cmapBadge.style.color = '#fff';
        cmapBadge.title = 'Click to change colormap';
        cmapBadge.onclick = (e) => {
            e.stopPropagation();
            const vpNode = this.getViewportNode();
            const { quantity: curQty } = getFocusedQuantityAndRange(vpNode || {});
            const qCmaps = vpNode?.parameters.quantity_colormaps || {};
            const curCmap = qCmaps[curQty] || vpNode?.parameters.stl_colormap || 'plasma';
            this.showColormapPopover(cmapBadge, curCmap, (newCmap) => {
                this.setQuantityColormap(curQty, newCmap);
            });
        };
        this.colorbarCmapBadge = cmapBadge;
        badgesWrap.appendChild(cmapBadge);

        header.appendChild(badgesWrap);
        overlay.appendChild(header);

        // 2. Main Body (Gradient Bar + Ticks)
        const bodyRow = document.createElement('div');
        bodyRow.style.display = 'flex';
        bodyRow.style.alignItems = 'stretch';
        bodyRow.style.gap = '8px';

        // Gradient Bar
        const gradBar = document.createElement('div');
        gradBar.style.width = '16px';
        gradBar.style.height = '180px';
        gradBar.style.borderRadius = '4px';
        gradBar.style.border = '1px solid rgba(255, 255, 255, 0.25)';
        gradBar.style.boxShadow = 'inset 0 0 4px rgba(0,0,0,0.5)';
        gradBar.style.cursor = 'pointer';
        gradBar.title = 'Click to select colormap';
        gradBar.onclick = (e) => {
            e.stopPropagation();
            const vpNode = this.getViewportNode();
            const { quantity: curQty } = getFocusedQuantityAndRange(vpNode || {});
            const qCmaps = vpNode?.parameters.quantity_colormaps || {};
            const curCmap = qCmaps[curQty] || vpNode?.parameters.stl_colormap || 'plasma';
            this.showColormapPopover(gradBar, curCmap, (newCmap) => {
                this.setQuantityColormap(curQty, newCmap);
            });
        };
        this.colorbarGradientEl = gradBar;
        bodyRow.appendChild(gradBar);

        // Ticks Container
        const ticksCol = document.createElement('div');
        ticksCol.style.display = 'flex';
        ticksCol.style.flexDirection = 'column';
        ticksCol.style.justifyContent = 'space-between';
        ticksCol.style.height = '180px';
        ticksCol.style.fontSize = '9px';
        ticksCol.style.fontFamily = 'monospace';
        ticksCol.style.color = '#ccc';
        ticksCol.style.minWidth = '80px';
        this.colorbarTicksContainer = ticksCol;

        bodyRow.appendChild(ticksCol);
        overlay.appendChild(bodyRow);

        this.colorbarOverlay = overlay;
        this.container.appendChild(overlay);
        const vpNode = this.getViewportNode();
        this.syncColorbarOverlay(vpNode || { parameters: {} });
    }

    private syncColorbarOverlay(vpNode: any) {
        if (!this.colorbarOverlay) {
            this.buildColorbarOverlay();
            return;
        }
        if (!vpNode) vpNode = { parameters: {} };
        const params = vpNode.parameters || {};

        const showCb = params.show_color_bar !== false;
        if (!showCb) {
            this.colorbarOverlay.style.display = 'none';
            return;
        }

        this.colorbarOverlay.style.display = 'flex';

        // Position
        const pos = params.color_bar_position || 'left-center';
        if (pos === 'left-top') {
            this.colorbarOverlay.style.top = '40px';
            this.colorbarOverlay.style.left = '12px';
            this.colorbarOverlay.style.bottom = 'auto';
            this.colorbarOverlay.style.right = 'auto';
            this.colorbarOverlay.style.transform = 'none';
        } else if (pos === 'left-bottom') {
            this.colorbarOverlay.style.bottom = '20px';
            this.colorbarOverlay.style.left = '12px';
            this.colorbarOverlay.style.top = 'auto';
            this.colorbarOverlay.style.right = 'auto';
            this.colorbarOverlay.style.transform = 'none';
        } else if (pos === 'right-bottom') {
            this.colorbarOverlay.style.bottom = '20px';
            this.colorbarOverlay.style.right = this.isOpen ? '480px' : '12px';
            this.colorbarOverlay.style.top = 'auto';
            this.colorbarOverlay.style.left = 'auto';
            this.colorbarOverlay.style.transform = 'none';
        } else {
            // left-center (default): fixed top offset (80px) to prevent translateY clipping when container bounds update
            this.colorbarOverlay.style.top = '80px';
            this.colorbarOverlay.style.left = '12px';
            this.colorbarOverlay.style.bottom = 'auto';
            this.colorbarOverlay.style.right = 'auto';
            this.colorbarOverlay.style.transform = 'none';
        }

        const { quantity: focusedQty } = getFocusedQuantityAndRange(vpNode);
        const qCmaps = params.quantity_colormaps || {};
        const activeCmap = qCmaps[focusedQty] || params.stl_colormap || params.obstacles_colormap || 'plasma';

        // Update Title & Units
        const unitMap: Record<string, string> = {
            pressure: 'Pa',
            density: 'kg/m³',
            velocity: 'm/s',
            energy: 'J/kg',
            species1: 'frac',
            species2: 'frac',
            species3: 'frac',
            peak_overpressure: 'Pa',
            peak_impulse: 'Pa·s'
        };
        const unitStr = unitMap[focusedQty] ? ` (${unitMap[focusedQty]})` : '';
        if (this.colorbarTitleEl) {
            this.colorbarTitleEl.textContent = `${focusedQty.toUpperCase()}${unitStr}`;
        }

        // Update Gradient
        if (this.colorbarGradientEl) {
            this.colorbarGradientEl.style.background = this.getColormapCssGradient(activeCmap, 'to top');
        }

        // Update Badges
        const isAuto = params.auto_scale !== false;
        if (this.colorbarAutoBadge) {
            this.colorbarAutoBadge.textContent = isAuto ? 'AUTO' : 'MANUAL';
            this.colorbarAutoBadge.style.background = isAuto ? 'rgba(0, 173, 255, 0.2)' : 'rgba(255, 170, 0, 0.2)';
            this.colorbarAutoBadge.style.color = isAuto ? '#00adff' : '#ffaa00';
            this.colorbarAutoBadge.style.border = isAuto ? '1px solid rgba(0, 173, 255, 0.4)' : '1px solid rgba(255, 170, 0, 0.4)';
        }

        const isLog = params.log_scale === true;
        if (this.colorbarLogBadge) {
            this.colorbarLogBadge.textContent = isLog ? 'LOG' : 'LIN';
            this.colorbarLogBadge.style.background = isLog ? 'rgba(170, 0, 255, 0.2)' : 'rgba(255, 255, 255, 0.1)';
            this.colorbarLogBadge.style.color = isLog ? '#d080ff' : '#aaa';
            this.colorbarLogBadge.style.border = isLog ? '1px solid rgba(170, 0, 255, 0.4)' : '1px solid rgba(255, 255, 255, 0.2)';
        }

        if (this.colorbarCmapBadge) {
            this.colorbarCmapBadge.textContent = activeCmap.toUpperCase();
        }

        // Determine Min/Max range
        let minVal = 0.0;
        let maxVal = 1.0;
        if (isAuto && this.latestEmpiricalRange) {
            minVal = this.latestEmpiricalRange.min;
            maxVal = this.latestEmpiricalRange.max;
        } else if (params.min_val !== undefined && params.max_val !== undefined) {
            minVal = Number(params.min_val);
            maxVal = Number(params.max_val);
        } else {
            const ranges = params.quantity_ranges || {};
            const r = ranges[focusedQty] || DEFAULT_QUANTITY_RANGES[focusedQty] || [0.0, 1.0];
            minVal = r[0];
            maxVal = r[1];
        }

        // Calculate 5 ticks (100%, 75%, 50%, 25%, 0%)
        const ticksContainer = this.colorbarTicksContainer;
        if (!ticksContainer) return;

        ticksContainer.innerHTML = '';

        const numTicks = 5;
        for (let i = 0; i < numTicks; i++) {
            const t = (numTicks - 1 - i) / (numTicks - 1); // 1.0 down to 0.0
            let val = minVal + t * (maxVal - minVal);
            if (isLog && minVal > 0 && maxVal > minVal) {
                val = minVal * Math.pow(maxVal / minVal, t);
            }

            const tickRow = document.createElement('div');
            tickRow.style.display = 'flex';
            tickRow.style.alignItems = 'center';
            tickRow.style.gap = '4px';

            const tickLine = document.createElement('div');
            tickLine.style.width = '5px';
            tickLine.style.height = '1px';
            tickLine.style.background = 'rgba(255,255,255,0.4)';
            tickRow.appendChild(tickLine);

            if (i === 0 || i === numTicks - 1) {
                // Top (Max) or Bottom (Min): Editable numerical input!
                const isMax = (i === 0);
                const input = document.createElement('input');
                input.type = 'number';
                input.step = 'any';
                input.value = String(val);
                input.style.width = '68px';
                input.style.background = 'rgba(0,0,0,0.5)';
                input.style.border = '1px solid rgba(255,255,255,0.2)';
                input.style.borderRadius = '3px';
                input.style.color = '#00adff';
                input.style.fontFamily = 'monospace';
                input.style.fontSize = '9px';
                input.style.padding = '1px 3px';
                input.style.boxSizing = 'border-box';
                input.title = isMax ? 'Edit Maximum Value' : 'Edit Minimum Value';

                this.bindEditingEvents(input, () => {
                    const newV = Number(input.value);
                    if (!isNaN(newV)) {
                        const updates: any = { auto_scale: false };
                        if (isMax) updates.max_val = newV;
                        else updates.min_val = newV;
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, updates);
                        this.syncControls(true);
                    }
                });
                tickRow.appendChild(input);
            } else {
                // Intermediate tick label
                const label = document.createElement('span');
                label.textContent = this.formatRangeValue(val);
                label.style.color = '#aaa';
                tickRow.appendChild(label);
            }

            ticksContainer.appendChild(tickRow);
        }
    }

    private buildColorbarTableRow(parent: HTMLElement) {
        const vpNode = this.getViewportNode();
        const initShow = vpNode ? (vpNode.parameters.show_color_bar !== false) : true;
        const initPos = vpNode ? (vpNode.parameters.color_bar_position || 'left-center') : 'left-center';
        const initAuto = vpNode ? (vpNode.parameters.auto_scale !== false) : true;
        const initLog = vpNode ? (vpNode.parameters.log_scale === true) : false;
        const { quantity: initQty } = getFocusedQuantityAndRange(vpNode || {});
        const initCmap = vpNode ? (vpNode.parameters.quantity_colormaps?.[initQty] || vpNode.parameters.stl_colormap || 'plasma') : 'plasma';

        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

        // Col 1: Vis Checkbox (Enable Color Bar)
        const tdVis = document.createElement('td');
        tdVis.style.padding = '3px 2px';
        tdVis.style.textAlign = 'center';
        const showCb = document.createElement('input');
        showCb.type = 'checkbox';
        showCb.id = this.getElId('viewport-colorbar-cb');
        showCb.checked = initShow;
        showCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { show_color_bar: showCb.checked });
                this.syncControls(true);
            }
        };
        this.bindEditingEvents(showCb);
        tdVis.appendChild(showCb);
        tr.appendChild(tdVis);

        // Col 2: Layer Title
        const tdLayer = document.createElement('td');
        tdLayer.style.padding = '3px 4px';
        tdLayer.innerHTML = '🎨 <b>Color Bar</b>';
        tr.appendChild(tdLayer);

        // Col 3: SOL (Position Popover Pill)
        const tdPos = document.createElement('td');
        tdPos.style.padding = '3px 2px';
        tdPos.style.textAlign = 'center';
        const posPill = document.createElement('div');
        posPill.style.fontSize = '8px';
        posPill.style.padding = '2px 4px';
        posPill.style.borderRadius = '3px';
        posPill.style.cursor = 'pointer';
        posPill.style.background = 'rgba(255,255,255,0.08)';
        posPill.style.border = '1px solid rgba(255,255,255,0.15)';
        posPill.style.color = '#00adff';
        posPill.style.fontWeight = 'bold';
        posPill.textContent = initPos.replace('-', ' ').toUpperCase();
        posPill.onclick = (e) => {
            e.stopPropagation();
            this.showPopover(posPill, (popover) => {
                const positions = [
                    { id: 'left-center', label: 'Left Center' },
                    { id: 'left-top', label: 'Left Top' },
                    { id: 'left-bottom', label: 'Left Bottom' },
                    { id: 'right-bottom', label: 'Right Bottom' }
                ];
                positions.forEach(p => {
                    const item = document.createElement('div');
                    item.textContent = p.label;
                    item.style.padding = '3px 6px';
                    item.style.borderRadius = '3px';
                    item.style.cursor = 'pointer';
                    item.onclick = (ev) => {
                        ev.stopPropagation();
                        const vp = this.getViewportNode();
                        if (vp) {
                            this.stateManager.updateNodeParametersInPlace(vp.id, { color_bar_position: p.id });
                            this.syncControls(true);
                            this.closePopover();
                        }
                    };
                    popover.appendChild(item);
                });
            });
        };
        tdPos.appendChild(posPill);
        tr.appendChild(tdPos);

        // Col 4: LINES (Auto-Scale Pill)
        const tdAuto = document.createElement('td');
        tdAuto.style.padding = '3px 2px';
        tdAuto.style.textAlign = 'center';
        tdAuto.appendChild(this.createToggleBtn('viewport-colorbar-autoscale-btn', 'AUTO', initAuto, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { auto_scale: v });
                this.syncControls(true);
            }
        }));
        tr.appendChild(tdAuto);

        // Col 5: RES (Log Scale Pill)
        const tdLog = document.createElement('td');
        tdLog.style.padding = '3px 2px';
        tdLog.style.textAlign = 'center';
        tdLog.appendChild(this.createToggleBtn('viewport-colorbar-logscale-btn', 'LOG', initLog, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { log_scale: v });
                this.syncControls(true);
            }
        }));
        tr.appendChild(tdLog);

        // Col 6: QTY (Quantity Selector Pill)
        const tdQty = document.createElement('td');
        tdQty.style.padding = '3px 4px';
        const qtyPill = document.createElement('div');
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
            this.showQuantityPopover(qtyPill, initQty, (newQ) => {
                this.setFocusedQuantity(newQ);
            });
        };
        tdQty.appendChild(qtyPill);
        tr.appendChild(tdQty);

        // Col 7: COLOR (Colormap Selector Pill)
        const tdCmap = document.createElement('td');
        tdCmap.style.padding = '3px 4px';
        const cmapPill = document.createElement('div');
        cmapPill.style.fontSize = '9px';
        cmapPill.style.padding = '2px 4px';
        cmapPill.style.borderRadius = '3px';
        cmapPill.style.cursor = 'pointer';
        cmapPill.style.background = 'rgba(255, 255, 255, 0.08)';
        cmapPill.style.border = '1px solid rgba(255, 255, 255, 0.15)';
        cmapPill.style.color = '#e0e0e0';
        cmapPill.textContent = initCmap;
        cmapPill.onclick = (e) => {
            e.stopPropagation();
            this.showColormapPopover(cmapPill, initCmap, (newC) => {
                this.setQuantityColormap(initQty, newC);
            });
        };
        tdCmap.appendChild(cmapPill);
        tr.appendChild(tdCmap);

        // Col 8: SCL (Range limits popover button)
        const tdScl = document.createElement('td');
        tdScl.style.padding = '3px 2px';
        tdScl.style.textAlign = 'center';
        const rangeBtn = document.createElement('button');
        rangeBtn.innerHTML = '⚙️ Range';
        this.applyButtonStyle(rangeBtn);
        rangeBtn.style.fontSize = '8px';
        rangeBtn.onclick = (e) => {
            e.stopPropagation();
            this.showPopover(rangeBtn, (popover) => {
                const vp = this.getViewportNode();
                const minV = vp?.parameters.min_val ?? 0.0;
                const maxV = vp?.parameters.max_val ?? 1.0;

                popover.innerHTML = `
                    <div style="font-weight:bold; color:#00adff; margin-bottom:6px;">Manual Range Limits</div>
                    <div style="display:flex; flex-direction:column; gap:4px;">
                        <label style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
                            <span>Min:</span>
                            <input type="number" step="any" id="popover-min-inp" value="${minV}" style="width:70px; background:#111; color:#fff; border:1px solid #444; border-radius:3px; padding:2px;">
                        </label>
                        <label style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
                            <span>Max:</span>
                            <input type="number" step="any" id="popover-max-inp" value="${maxV}" style="width:70px; background:#111; color:#fff; border:1px solid #444; border-radius:3px; padding:2px;">
                        </label>
                        <button id="popover-apply-range" style="margin-top:4px; background:#007acc; color:#fff; border:none; border-radius:3px; padding:3px; cursor:pointer;">Apply Range</button>
                    </div>
                `;
                const applyBtn = popover.querySelector('#popover-apply-range') as HTMLButtonElement;
                if (applyBtn) {
                    applyBtn.onclick = () => {
                        const minInp = popover.querySelector('#popover-min-inp') as HTMLInputElement;
                        const maxInp = popover.querySelector('#popover-max-inp') as HTMLInputElement;
                        if (minInp && maxInp && vp) {
                            const minN = Number(minInp.value);
                            const maxN = Number(maxInp.value);
                            this.stateManager.updateNodeParametersInPlace(vp.id, {
                                auto_scale: false,
                                min_val: minN,
                                max_val: maxN
                            });
                            this.syncControls(true);
                            this.closePopover();
                        }
                    };
                }
            });
        };
        tdScl.appendChild(rangeBtn);
        tr.appendChild(tdScl);

        // Col 9, 10: OPACITY and TRASH
        const tdOpac = document.createElement('td');
        tdOpac.innerHTML = '<span style="color:#555;">—</span>';
        tdOpac.style.textAlign = 'center';
        tr.appendChild(tdOpac);

        const tdTrash = document.createElement('td');
        tdTrash.innerHTML = '<span style="color:#555;">—</span>';
        tdTrash.style.textAlign = 'center';
        tr.appendChild(tdTrash);

        parent.appendChild(tr);
    }

    private buildMPMParticlesTableRow(parent: HTMLElement) {
        const vpNode = this.getViewportNode();
        const initShow = vpNode ? (vpNode.parameters.showMPMParticles !== false) : true;
        const initSize = vpNode ? (vpNode.parameters.mpmParticleSize ?? 4.0) : 4.0;
        const initQty = vpNode ? (vpNode.parameters.mpmParticleQuantity || 'vonMises') : 'vonMises';
        const initCmap = vpNode ? (vpNode.parameters.mpmParticleColormap || 'plasma') : 'plasma';

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
        tdLayer.innerHTML = '🔮 <b>MPM Particles</b>';
        tr.appendChild(tdLayer);

        // Col 3, 4: Empty SOL / LINES
        for (let i = 0; i < 2; i++) {
            const tdEmpty = document.createElement('td');
            tdEmpty.innerHTML = '<span style="color:#555;">—</span>';
            tdEmpty.style.textAlign = 'center';
            tr.appendChild(tdEmpty);
        }

        // Col 5: RES (Point Size Popover Pill)
        const tdSize = document.createElement('td');
        tdSize.style.padding = '3px 2px';
        const sizePill = document.createElement('button');
        sizePill.textContent = `Pt ${initSize}px ▾`;
        this.applyButtonStyle(sizePill);
        sizePill.style.fontSize = '8.5px';
        sizePill.style.width = '100%';
        sizePill.style.padding = '2px 0';
        sizePill.onclick = (e) => {
            e.stopPropagation();
            this.showPopover(sizePill, (popover) => {
                [2, 3, 4, 6, 8, 10].forEach(sz => {
                    const item = document.createElement('div');
                    item.textContent = `${sz}px`;
                    item.style.padding = '3px 6px';
                    item.style.cursor = 'pointer';
                    item.onclick = (ev) => {
                        ev.stopPropagation();
                        const vp = this.getViewportNode();
                        if (vp) {
                            this.stateManager.updateNodeParametersInPlace(vp.id, { mpmParticleSize: sz });
                            this.worker.postMessage({ type: 'setConfig', data: { mpmParticleSize: sz } });
                            sizePill.textContent = `Pt ${sz}px ▾`;
                            this.closePopover();
                        }
                    };
                    popover.appendChild(item);
                });
            });
        };
        tdSize.appendChild(sizePill);
        tr.appendChild(tdSize);

        // Col 6: QTY (Quantity Selector Pill)
        const tdQty = document.createElement('td');
        tdQty.style.padding = '3px 4px';
        const qtyPill = document.createElement('div');
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
            this.showQuantityPopover(qtyPill, initQty, (newQ) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { mpmParticleQuantity: newQ });
                    this.worker.postMessage({ type: 'setConfig', data: { mpmParticleQuantity: newQ } });
                    qtyPill.textContent = newQ;
                }
            });
        };
        tdQty.appendChild(qtyPill);
        tr.appendChild(tdQty);

        // Col 7: COLOR (Colormap Selector Pill)
        const tdCmap = document.createElement('td');
        tdCmap.style.padding = '3px 4px';
        const cmapPill = document.createElement('div');
        cmapPill.style.fontSize = '9px';
        cmapPill.style.padding = '2px 4px';
        cmapPill.style.borderRadius = '3px';
        cmapPill.style.cursor = 'pointer';
        cmapPill.style.background = 'rgba(255, 255, 255, 0.08)';
        cmapPill.style.border = '1px solid rgba(255, 255, 255, 0.15)';
        cmapPill.style.color = '#e0e0e0';
        cmapPill.textContent = initCmap;
        cmapPill.onclick = (e) => {
            e.stopPropagation();
            this.showColormapPopover(cmapPill, initCmap, (newC) => {
                const vp = this.getViewportNode();
                if (vp) {
                    this.stateManager.updateNodeParametersInPlace(vp.id, { mpmParticleColormap: newC });
                    this.worker.postMessage({ type: 'setConfig', data: { mpmParticleColormap: newC } });
                    cmapPill.textContent = newC;
                }
            });
        };
        tdCmap.appendChild(cmapPill);
        tr.appendChild(tdCmap);

        // Col 8: SCL / Range Limit
        const tdScl = document.createElement('td');
        tdScl.style.padding = '3px 2px';
        tdScl.style.textAlign = 'center';
        const rangeBtn = document.createElement('button');
        rangeBtn.innerHTML = '⚙️ Range';
        this.applyButtonStyle(rangeBtn);
        rangeBtn.style.fontSize = '8px';
        rangeBtn.onclick = (e) => {
            e.stopPropagation();
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
                            this.closePopover();
                        }
                    };
                }
            });
        };
        tdScl.appendChild(rangeBtn);
        tr.appendChild(tdScl);

        // Col 9, 10: OPACITY and TRASH
        for (let i = 0; i < 2; i++) {
            const tdEmpty = document.createElement('td');
            tdEmpty.innerHTML = '<span style="color:#555;">—</span>';
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

        const currentModelId = this.getCurrentModelId();
        if (currentModelId) {
            const state = this.stateManager.getSimulationState(currentModelId);
            const node = state?.nodes.find(n => n.type === 'Telemetry3DViewport');
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
                        refresh_rate: 2.0
                    }
                };
            }
            return this.virtualNodes[currentModelId];
        }

        return null;
    }



    public sendView3DConfig(): void {
        const vpNode = this.getViewportNode();
        if (!vpNode) return;
        const net = (window as any).networkManager;
        if (!net || !net.isConnected()) return;

        let targetModelId = this.getCurrentModelId() || vpNode.id;

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
            if (solverNode) {
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
                    if (currNode && currNode.type === 'DomainMesh3D') {
                        return currNode;
                    }
                }
            }
        }
        return targetModel.nodes.find((n: any) => n.type === 'DomainMesh3D') || null;
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
            return targetModel.nodes.find((n: any) => n.id === connToViewport.fromNode) || null;
        }
        return targetModel.nodes.find((n: any) => n.type === 'CFDSolver3D') || null;
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
        this.syncColorbarOverlay(vpNode || { parameters: {} });
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

        const cbShowCb = document.getElementById(this.getElId('viewport-colorbar-cb')) as HTMLInputElement;
        if (cbShowCb && document.activeElement !== cbShowCb) cbShowCb.checked = vpNode.parameters.show_color_bar !== false;

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
            const xmin = Number(domainMesh3D?.parameters.xmin ?? 0.0);
            const xmax = Number(domainMesh3D?.parameters.xmax ?? 1.0);
            const ymin = Number(domainMesh3D?.parameters.ymin ?? 0.0);
            const ymax = Number(domainMesh3D?.parameters.ymax ?? 1.0);
            const zmin = Number(domainMesh3D?.parameters.zmin ?? 0.0);
            const zmax = Number(domainMesh3D?.parameters.zmax ?? 1.0);

            // Resolve the charge node via connections from the model-scoped solver
            const currentModelId = this.getCurrentModelId();
            const modelState = currentModelId ? this.stateManager.getSimulationState(currentModelId) : null;
            const chargeConn = (solverNode3D && modelState) ? modelState.connections.find((c: any) => c.toNode === solverNode3D.id && c.toPort === 'charge') : null;
            const chargeNode = chargeConn
                ? modelState?.nodes.find((n: any) => n.id === chargeConn.fromNode)
                : null;

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

                chargeParams = {
                    id: chargeNode.id,
                    type: chargeNode.type,
                    shape: shape,
                    x: cx, y: cy, z: cz,
                    radius: radius, height: height,
                    lx: lx, ly: ly, lz: lz
                };
            }

            const submeshes: any[] = [];

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
                    obstaclesMaxVal: vpNode.parameters.obstacles_max_val ?? 1013250.0,
                    showCharge: vpNode.parameters.show_charge !== false,
                    chargeSolid: vpNode.parameters.charge_solid !== false,
                    chargeWireframe: vpNode.parameters.charge_wireframe !== false,
                    chargeLighting: vpNode.parameters.charge_lighting !== false,
                    chargeOpacity: vpNode.parameters.charge_opacity ?? 0.65,
                    charge: chargeParams,
                    submeshes: submeshes
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
            this.buildGridRow(this.staticListContainer);
            this.buildGaugeRow(this.staticListContainer);
            this.buildMPMParticlesTableRow(this.staticListContainer);
            this.buildLightingTableRow(this.staticListContainer);
            this.buildColorbarTableRow(this.staticListContainer);
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
                    const axisShort = (slice.axis || 'xy').toUpperCase();

                    const posPill = document.createElement('button');
                    posPill.className = 'slice-pos-pill';
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
                    qtyPill.className = 'slice-qty-pill';
                    const qtyLabels: Record<string, string> = {
                        pressure: 'Press', density: 'Density', velocity: 'Speed', energy: 'Energy',
                        species1: 'Reacted', species2: 'Unreacted', species3: 'Air',
                        peak_overpressure: 'Pk Press', peak_impulse: 'Pk Impulse', amr_level: 'AMR Level'
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
                    cmapPill.className = 'slice-cmap-pill';
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
                    const axisShort = (slice.axis || 'xy').toUpperCase();
                    const posPill = row.querySelector('.slice-pos-pill') as HTMLButtonElement;
                    if (posPill) {
                        posPill.innerHTML = `📐 <b>${axisShort}</b> @ ${curOffset.toFixed(2)}m ▾`;
                    }

                    // 3. Edg toggle
                    const edgesBtn = document.getElementById(this.getElId(`slice-edges-btn-${idx}`));
                    this.syncToggleBtnState(edgesBtn, vpNode.parameters.cell_edges === true);

                    // 4. Int toggle
                    const interpBtn = document.getElementById(this.getElId(`slice-interp-btn-${idx}`));
                    this.syncToggleBtnState(interpBtn, slice.interpolate !== false);

                    // 5. Qty Pill
                    const qty = slice.quantities?.[0] || 'pressure';
                    const qtyPill = row.querySelector('.slice-qty-pill') as HTMLButtonElement;
                    if (qtyPill) {
                        const qtyLabels: Record<string, string> = {
                            pressure: 'Press', density: 'Density', velocity: 'Speed', energy: 'Energy',
                            species1: 'Reacted', species2: 'Unreacted', species3: 'Air',
                            peak_overpressure: 'Pk Press', peak_impulse: 'Pk Impulse', amr_level: 'AMR Level'
                        };
                        qtyPill.textContent = `${qtyLabels[qty] || qty} ▾`;
                    }

                    // 6. Cmap Pill
                    const cmapPill = row.querySelector('.slice-cmap-pill') as HTMLButtonElement;
                    if (cmapPill) {
                        const curCmap = vpNode.parameters.quantity_colormaps?.[qty] || slice.colormap || 'plasma';
                        cmapPill.textContent = `${curCmap.charAt(0).toUpperCase() + curCmap.slice(1)} ▾`;
                    }

                    // 7. Auto scale / Log scale toggles
                    const autoScaleVal = slice.auto_scale !== false;
                    const logScaleVal = slice.log_scale === true;

                    const autoBtn = document.getElementById(this.getElId(`slice-auto-btn-${idx}`));
                    this.syncToggleBtnState(autoBtn, autoScaleVal);

                    const logBtn = document.getElementById(this.getElId(`slice-log-btn-${idx}`));
                    this.syncToggleBtnState(logBtn, logScaleVal);

                    // 8. Opacity Pill
                    const opacPill = row.querySelector('.slice-opac-pill') as HTMLButtonElement;
                    if (opacPill) {
                        const sliceOpac = slice.opacity ?? 1.0;
                        opacPill.textContent = `${Math.round(sliceOpac * 100)}% ▾`;
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
            meshType: solverNode?.parameters?.mesh_type || 'regular',
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
        if (this.overlayCanvas && this.overlayCanvas.parentNode !== this.container) {
            this.container.appendChild(this.overlayCanvas);
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
        if (this.colorbarOverlay && this.colorbarOverlay.parentNode !== this.container) {
            this.container.appendChild(this.colorbarOverlay);
        }

        const vpNode = this.getViewportNode();
        this.syncColorbarOverlay(vpNode || { parameters: {} });

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

    private getTickInterval(minVal: number, maxVal: number, targetTicks: number = 5): { major: number, minor: number } {
        const range = maxVal - minVal;
        if (range <= 0) return { major: 1, minor: 0.1 };
        
        const rawStep = range / targetTicks;
        const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
        const normalized = rawStep / magnitude;
        
        let step = magnitude;
        if (normalized >= 5) {
            step = 5 * magnitude;
        } else if (normalized >= 2) {
            step = 2 * magnitude;
        }
        
        return {
            major: step,
            minor: step / 5
        };
    }

    private formatTickValue(val: number, step: number): string {
        if (Math.abs(val) > 0.0001 && Math.abs(val) < 0.001) {
            return val.toExponential(1);
        }
        if (Math.abs(val) < 1e-4 || Math.abs(val) >= 1e5) {
            return val.toExponential(2);
        }
        const decimals = Math.max(0, -Math.floor(Math.log10(step)));
        return val.toFixed(decimals);
    }

    private drawTicks() {
        if (!this.overlayCanvas || !this.overlayCtx || !this.latestFrameData) return;
        const ctx = this.overlayCtx;
        const data = this.latestFrameData;
        const width = this.overlayCanvas.width;
        const height = this.overlayCanvas.height;

        ctx.clearRect(0, 0, width, height);

        if (!data.showGrid && !data.showGridBox) return;

        const mvp = new Float32Array(data.mvp);
        const { xmin, xmax, ymin, ymax, zmin, zmax, sX, sY, sZ } = data;

        const sizeX = xmax - xmin;
        const sizeY = ymax - ymin;
        const sizeZ = zmax - zmin;

        if (sizeX <= 0 || sizeY <= 0 || sizeZ <= 0) return;

        const project = (x: number, y: number, z: number) => {
            const bx = (x - xmin) / sizeX - 0.5;
            const by = (y - ymin) / sizeY - 0.5;
            const bz = (z - zmin) / sizeZ - 0.5;
            const mx = bx;
            const my = by;
            const mz = bz;

            const w = mvp[3] * mx + mvp[7] * my + mvp[11] * mz + mvp[15] || 1;
            const screenX = (mvp[0] * mx + mvp[4] * my + mvp[8] * mz + mvp[12]) / w;
            const screenY = (mvp[1] * mx + mvp[5] * my + mvp[9] * mz + mvp[13]) / w;

            return {
                x: (screenX * 0.5 + 0.5) * width,
                y: (1.0 - (screenY * 0.5 + 0.5)) * height,
                w
            };
        };

        const centerProj = project((xmin + xmax) / 2, (ymin + ymax) / 2, (zmin + zmax) / 2);
        if (centerProj.w < 0.1) return;

        const dpr = window.devicePixelRatio || 1;
        const depthScale = Math.max(0.5, Math.min(1.4, 2.0 / centerProj.w));
        const scale = depthScale * dpr;

        const fontSize = Math.round(10 * scale);
        ctx.font = `bold ${fontSize}px system-ui, -apple-system, sans-serif`;

        const axes = [
            {
                name: 'X',
                color: '#ff5555',
                min: xmin,
                max: xmax,
                offsetDir: [0, -1, 0],
                pointAt: (val: number) => [val, ymin, zmin],
                labelSuffix: 'm'
            },
            {
                name: 'Y',
                color: '#55ff55',
                min: ymin,
                max: ymax,
                offsetDir: [1, 0, 0],
                pointAt: (val: number) => [xmax, val, zmin],
                labelSuffix: 'm'
            },
            {
                name: 'Z',
                color: '#55aaff',
                min: zmin,
                max: zmax,
                offsetDir: [-1, 0, 0],
                pointAt: (val: number) => [xmin, ymin, val],
                labelSuffix: 'm'
            }
        ];

        const dx_physical = (xmax - xmin) * 0.05;
        const dy_physical = (ymax - ymin) * 0.05;
        const dz_physical = (zmax - zmin) * 0.05;

        for (const axis of axes) {
            const { major, minor } = this.getTickInterval(axis.min, axis.max);
            
            let tickVal = Math.ceil(axis.min / major) * major;
            const limit = axis.max + major * 1e-5;

            while (tickVal <= limit) {
                const val = tickVal;
                const clampedVal = Math.max(axis.min, Math.min(axis.max, val));
                const [ax, ay, az] = axis.pointAt(clampedVal);
                
                const pBase = project(ax, ay, az);
                if (pBase.w < 0.1) {
                    tickVal += major;
                    continue;
                }

                const ox = ax + axis.offsetDir[0] * dx_physical;
                const oy = ay + axis.offsetDir[1] * dy_physical;
                const oz = az + axis.offsetDir[2] * dz_physical;
                const pOff = project(ox, oy, oz);

                if (pOff.w < 0.1) {
                    tickVal += major;
                    continue;
                }

                let dx = pOff.x - pBase.x;
                let dy = pOff.y - pBase.y;
                let len = Math.sqrt(dx * dx + dy * dy);
                let ux = 0;
                let uy = 1;
                if (len > 0.001) {
                    ux = dx / len;
                    uy = dy / len;
                }

                const L_major = 8 * scale;
                const L_label = 16 * scale;

                const pTickEnd = {
                    x: pBase.x + ux * L_major,
                    y: pBase.y + uy * L_major
                };

                const pLabelPos = {
                    x: pBase.x + ux * L_label,
                    y: pBase.y + uy * L_label
                };

                ctx.beginPath();
                ctx.moveTo(pBase.x, pBase.y);
                ctx.lineTo(pTickEnd.x, pTickEnd.y);
                ctx.strokeStyle = axis.color;
                ctx.lineWidth = 1.5 * dpr;
                ctx.stroke();

                ctx.fillStyle = '#ffffff';
                
                if (ux > 0.3) ctx.textAlign = 'left';
                else if (ux < -0.3) ctx.textAlign = 'right';
                else ctx.textAlign = 'center';

                if (uy > 0.3) ctx.textBaseline = 'top';
                else if (uy < -0.3) ctx.textBaseline = 'bottom';
                else ctx.textBaseline = 'middle';

                const displayVal = this.formatTickValue(clampedVal, major);
                ctx.fillText(`${displayVal}${axis.labelSuffix}`, pLabelPos.x, pLabelPos.y);

                tickVal += major;
            }

            if (minor > 0) {
                let minorVal = Math.ceil(axis.min / minor) * minor;
                const minorLimit = axis.max + minor * 1e-5;
                while (minorVal <= minorLimit) {
                    const nearestMajor = Math.round(minorVal / major) * major;
                    if (Math.abs(minorVal - nearestMajor) < minor * 0.1) {
                        minorVal += minor;
                        continue;
                    }

                    const clampedVal = Math.max(axis.min, Math.min(axis.max, minorVal));
                    const [ax, ay, az] = axis.pointAt(clampedVal);
                    const pBase = project(ax, ay, az);
                    if (pBase.w < 0.1) {
                        minorVal += minor;
                        continue;
                    }

                    const ox = ax + axis.offsetDir[0] * dx_physical;
                    const oy = ay + axis.offsetDir[1] * dy_physical;
                    const oz = az + axis.offsetDir[2] * dz_physical;
                    const pOff = project(ox, oy, oz);
                    if (pOff.w < 0.1) {
                        minorVal += minor;
                        continue;
                    }

                    let dx = pOff.x - pBase.x;
                    let dy = pOff.y - pBase.y;
                    let len = Math.sqrt(dx * dx + dy * dy);
                    let ux = 0;
                    let uy = 1;
                    if (len > 0.001) {
                        ux = dx / len;
                        uy = dy / len;
                    }

                    const L_minor = 4 * scale;
                    const pTickEnd = {
                        x: pBase.x + ux * L_minor,
                        y: pBase.y + uy * L_minor
                    };

                    ctx.beginPath();
                    ctx.moveTo(pBase.x, pBase.y);
                    ctx.lineTo(pTickEnd.x, pTickEnd.y);
                    ctx.strokeStyle = axis.color;
                    ctx.lineWidth = 1.0 * dpr;
                    ctx.stroke();

                    minorVal += minor;
                }
            }
        }
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
        if (this.overlayCanvas) this.overlayCanvas.remove();
        if (this.controlsOverlay) this.controlsOverlay.remove();
        if (this.floatOpenBtn) this.floatOpenBtn.remove();
        if (this.colorbarOverlay) this.colorbarOverlay.remove();
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

    private buildFloatingViewHUD() {
        const viewHUD = document.createElement('div');
        viewHUD.style.position = 'absolute';
        viewHUD.style.top = '10px';
        viewHUD.style.left = '10px';
        viewHUD.style.display = 'flex';
        viewHUD.style.gap = '4px';
        viewHUD.style.background = 'rgba(16, 16, 19, 0.82)';
        viewHUD.style.backdropFilter = 'blur(12px)';
        viewHUD.style.border = '1px solid rgba(255, 255, 255, 0.12)';
        viewHUD.style.borderRadius = '6px';
        viewHUD.style.padding = '3px';
        viewHUD.style.zIndex = '10';
        viewHUD.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5)';
        
        // Reset View Button
        const resetBtn = document.createElement('button');
        resetBtn.innerHTML = '🏠 Reset';
        this.applyButtonStyle(resetBtn);
        resetBtn.style.padding = '3px 6px';
        resetBtn.title = 'Reset view to default angle and distance';
        resetBtn.onclick = () => {
            this.worker.postMessage({
                type: 'setView',
                data: {
                    pitch: 0.42,
                    yaw: 1.107,
                    distance: 2.45,
                    targetX: 0.0,
                    targetY: 0.0,
                    targetZ: 0.0
                }
            });
        };
        viewHUD.appendChild(resetBtn);

        // Perspective/Orthographic Toggle Button
        const projBtn = document.createElement('button');
        projBtn.id = this.getElId('viewport-hud-proj-btn');
        projBtn.innerHTML = this.usePerspective ? '👁️ Persp' : '📐 Ortho';
        this.applyButtonStyle(projBtn);
        projBtn.style.padding = '3px 6px';
        projBtn.title = 'Toggle Perspective / Orthographic projection';
        projBtn.onclick = () => {
            this.usePerspective = !this.usePerspective;
            this.syncProjectionButtons();
            this.worker.postMessage({
                type: 'setConfig',
                data: { usePerspective: this.usePerspective }
            });
        };
        viewHUD.appendChild(projBtn);

        // Standard Views Buttons with a separator
        const separator = document.createElement('div');
        separator.style.width = '1px';
        separator.style.height = '14px';
        separator.style.background = 'rgba(255, 255, 255, 0.15)';
        separator.style.alignSelf = 'center';
        separator.style.margin = '0 3px';
        viewHUD.appendChild(separator);

        const views = [
            { name: 'Top', val: 'top', title: 'Align camera to Top (Z+)' },
            { name: 'Bottom', val: 'bottom', title: 'Align camera to Bottom (Z-)' },
            { name: 'Front', val: 'front', title: 'Align camera to Front (Y-)' },
            { name: 'Back', val: 'back', title: 'Align camera to Back (Y+)' },
            { name: 'Left', val: 'left', title: 'Align camera to Left (X-)' },
            { name: 'Right', val: 'right', title: 'Align camera to Right (X+)' }
        ];

        views.forEach(v => {
            const btn = document.createElement('button');
            btn.innerHTML = v.name;
            this.applyButtonStyle(btn);
            btn.style.padding = '3px 6px';
            btn.title = v.title;
            btn.onclick = () => {
                // Standard CAD alignment behavior: switch to orthographic
                this.usePerspective = false;
                this.syncProjectionButtons();
                this.worker.postMessage({
                    type: 'setConfig',
                    data: { usePerspective: false }
                });

                let pitch = 0.0;
                let yaw = 0.0;
                if (v.val === 'top') {
                    pitch = Math.PI / 2 - 0.01;
                    yaw = 0.0;
                } else if (v.val === 'bottom') {
                    pitch = -Math.PI / 2 + 0.01;
                    yaw = 0.0;
                } else if (v.val === 'front') {
                    pitch = 0.0;
                    yaw = Math.PI;
                } else if (v.val === 'back') {
                    pitch = 0.0;
                    yaw = 0.0;
                } else if (v.val === 'left') {
                    pitch = 0.0;
                    yaw = -Math.PI / 2;
                } else if (v.val === 'right') {
                    pitch = 0.0;
                    yaw = Math.PI / 2;
                }

                this.worker.postMessage({
                    type: 'setView',
                    data: {
                        pitch,
                        yaw,
                        targetX: 0.0,
                        targetY: 0.0,
                        targetZ: 0.0
                    }
                });
            };
            this.bindEditingEvents(btn);
            viewHUD.appendChild(btn);
        });

        this.container.appendChild(viewHUD);
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
        projBtn.onclick = () => {
            this.usePerspective = !this.usePerspective;
            this.syncProjectionButtons();
            this.worker.postMessage({
                type: 'setConfig',
                data: { usePerspective: this.usePerspective }
            });
        };
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
            btn.onclick = () => {
                this.usePerspective = false;
                this.syncProjectionButtons();
                this.worker.postMessage({
                    type: 'setConfig',
                    data: { usePerspective: false }
                });

                let pitch = 0.0;
                let yaw = 0.0;
                if (v.val === 'top') {
                    pitch = Math.PI / 2 - 0.01;
                    yaw = 0.0;
                } else if (v.val === 'bottom') {
                    pitch = -Math.PI / 2 + 0.01;
                    yaw = 0.0;
                } else if (v.val === 'front') {
                    pitch = 0.0;
                    yaw = Math.PI;
                } else if (v.val === 'back') {
                    pitch = 0.0;
                    yaw = 0.0;
                } else if (v.val === 'left') {
                    pitch = 0.0;
                    yaw = -Math.PI / 2;
                } else if (v.val === 'right') {
                    pitch = 0.0;
                    yaw = Math.PI / 2;
                }

                this.worker.postMessage({
                    type: 'setView',
                    data: {
                        pitch,
                        yaw,
                        targetX: 0.0,
                        targetY: 0.0,
                        targetZ: 0.0
                    }
                });
            };
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
        resetBtn.onclick = () => {
            this.worker.postMessage({
                type: 'setView',
                data: {
                    pitch: 0.42,
                    yaw: 1.107,
                    distance: 2.45,
                    targetX: 0.0,
                    targetY: 0.0,
                    targetZ: 0.0
                }
            });
        };
        resetRow.appendChild(resetBtn);
        body.appendChild(resetRow);
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

