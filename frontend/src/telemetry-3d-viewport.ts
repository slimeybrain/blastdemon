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
    impulse: [0.0, 10000.0],
    peak_overpressure: [0.0, 101325.0 * 99.0],
    peak_impulse: [0.0, 10000.0],
    vonMises: [0.0, 500000000.0],
    plasticStrain: [0.0, 1.0],
    plastic_strain: [0.0, 1.0],
    damage: [0.0, 1.0],
    has_failed: [0.0, 1.0],
    object_id: [0.0, 10.0]
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
    private latestSTLRange: { min: number, max: number } | null = null;
    private latestObstaclesRange: { min: number, max: number } | null = null;
    private _lastSliceKey: string = '';

    // Colorbar Overlay Container
    private colorbarContainer: HTMLElement | null = null;
    private usePerspective: boolean = true;

    private viewTypeSuffix: string;
    private viewportNodeId: string | null = null;
    private virtualNodes: Record<string, any> = {};
    private resizeObserver: ResizeObserver | null = null;

    private triggerResize = () => {
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
                    this.latestObstaclesRange = { min, max };
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, {
                        obstacles_auto_scale: false,
                        obstacles_min_val: min,
                        obstacles_max_val: max
                    });
                    this.syncControls(true);
                }
            } else if (type === 'mpmRangeUpdated') {
                const { min, max } = e.data;
                this.latestMPMRange = { min, max };
                this.syncControls(false);
            } else if (type === 'femRangeUpdated') {
                const { min, max } = e.data;
                this.latestFEMRange = { min, max };
                this.syncControls(false);
            } else if (type === 'stlRangeUpdated') {
                const { min, max } = e.data;
                this.latestSTLRange = { min, max };
                this.syncControls(false);
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

        this.resizeObserver = new ResizeObserver(entries => {
            for (let entry of entries) {
                const dpr = window.devicePixelRatio || 1;
                if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
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

        // 2. Controls Panel Overlay (on the right side - hidden by default)
        this.controlsOverlay = document.createElement('div');
        this.controlsOverlay.style.position = 'absolute';
        this.controlsOverlay.style.top = '10px';
        this.controlsOverlay.style.right = '10px';
        this.controlsOverlay.style.bottom = '55px';
        this.controlsOverlay.style.width = '460px';
        this.controlsOverlay.style.maxWidth = 'calc(100% - 20px)';
        this.controlsOverlay.style.background = 'rgba(16, 16, 19, 0.92)';
        this.controlsOverlay.style.backdropFilter = 'blur(16px)';
        this.controlsOverlay.style.border = '1px solid rgba(255, 255, 255, 0.12)';
        this.controlsOverlay.style.borderRadius = '8px';
        this.controlsOverlay.style.display = this.isOpen ? 'flex' : 'none';
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
        title.innerHTML = '⚡ 3D Controls Matrix';
        title.style.fontWeight = '700';
        title.style.fontSize = '11px';
        title.style.letterSpacing = '0.5px';
        titleWrap.appendChild(title);

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
            if (this.floatOpenBtn) this.floatOpenBtn.style.display = 'none';
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

        // Build Single-Level Bottom Controls Dock
        this.buildBottomControlsDock();
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
            <option value="10.0">0.1 FPS</option>
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
        this.buildFEMMeshTableRow(staticTbody);
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

    private showQuantityPopover(targetEl: HTMLElement, currentQty: string, context: 'cfd' | 'mpm' | 'fem', onSelect: (qty: string) => void) {
        const cfdQuantities = [
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

        const mpmQuantities = [
            { id: 'vonMises', label: '🛡️ Von Mises' },
            { id: 'plastic_strain', label: '🔨 Plastic Strain' },
            { id: 'density', label: '⚖️ Density' },
            { id: 'pressure', label: '📊 Pressure' },
            { id: 'damage', label: '💥 Damage' },
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

        const quantities = context === 'mpm' ? mpmQuantities : (context === 'fem' ? femQuantities : cfdQuantities);

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
            this.showQuantityPopover(qtyPill, currentQty, 'cfd', (newQ) => {
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
            const curCmap = vp?.parameters.quantity_colormaps?.[activeQty] || vp?.parameters.obstacles_colormap || 'plasma';
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
            this.showQuantityPopover(qtyPill, currentQty, 'cfd', (newQ) => {
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
            const curCmap = vp?.parameters.quantity_colormaps?.[activeQty] || vp?.parameters.stl_colormap || 'plasma';
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
        minVal: number;
        maxVal: number;
        onToggleOff: () => void;
        onToggleAuto: () => void;
        onToggleLog: () => void;
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
        autoBadge.style.fontSize = '7.5px';
        autoBadge.style.fontWeight = '700';
        autoBadge.style.padding = '1px 3px';
        autoBadge.style.borderRadius = '2px';
        autoBadge.style.cursor = 'pointer';
        autoBadge.style.lineHeight = '1.1';
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
        logBadge.style.fontSize = '7.5px';
        logBadge.style.fontWeight = '700';
        logBadge.style.padding = '1px 3px';
        logBadge.style.borderRadius = '2px';
        logBadge.style.cursor = 'pointer';
        logBadge.style.lineHeight = '1.1';
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
        card.appendChild(badgesRow);

        // 3. Main Body (Gradient Bar + Ticks)
        const bodyRow = document.createElement('div');
        bodyRow.style.display = 'flex';
        bodyRow.style.alignItems = 'stretch';
        bodyRow.style.gap = '4px';

        // Gradient Bar using exact colormap defined for this object!
        const gradBar = document.createElement('div');
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
        ticksCol.style.display = 'flex';
        ticksCol.style.flexDirection = 'column';
        ticksCol.style.justifyContent = 'space-between';
        ticksCol.style.height = '120px';
        ticksCol.style.minWidth = '0';
        ticksCol.style.flex = '1';

        const numTicks = 5;
        const minVal = spec.minVal;
        const maxVal = spec.maxVal;
        const rangeSpan = Math.abs(maxVal - minVal);

        for (let i = 0; i < numTicks; i++) {
            const t = (numTicks - 1 - i) / (numTicks - 1);
            let val = minVal + t * (maxVal - minVal);
            if (spec.logScale && minVal > 0 && maxVal > minVal) {
                val = minVal * Math.pow(maxVal / minVal, t);
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
                input.value = this.formatRangeValue(val, rangeSpan);
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
                    input.value = String(val);
                    input.select();
                };
                input.onblur = () => {
                    delete input.dataset.editing;
                    const newV = Number(input.value);
                    if (!isNaN(newV) && input.value.trim() !== '') {
                        if (isMax) spec.onSetMinMax(minVal, newV);
                        else spec.onSetMinMax(newV, maxVal);
                    } else {
                        input.value = this.formatRangeValue(val, rangeSpan);
                    }
                };
                input.onkeydown = (e) => {
                    if (e.key === 'Enter') {
                        input.blur();
                    } else if (e.key === 'Escape') {
                        delete input.dataset.editing;
                        input.value = this.formatRangeValue(val, rangeSpan);
                        input.blur();
                    }
                };
                tickRow.appendChild(input);
            } else {
                const label = document.createElement('span');
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
            peak_overpressure: 'Pa',
            peak_impulse: 'Pa·s',
            vonMises: 'Pa',
            plasticStrain: 'frac',
            plastic_strain: 'frac',
            damage: 'frac',
            has_failed: 'frac',
            object_id: 'ID'
        };

        const qtyDisplayMap: Record<string, string> = {
            pressure: 'Pressure',
            density: 'Density',
            velocity: 'Speed',
            energy: 'Energy',
            species1: 'Reacted',
            species2: 'Unreacted',
            species3: 'Air',
            peak_overpressure: 'Pk Press',
            peak_impulse: 'Pk Impulse',
            vonMises: 'Von Mises',
            plasticStrain: 'Pl Strain',
            plastic_strain: 'Pl Strain',
            damage: 'Damage',
            has_failed: 'Failure',
            object_id: 'Obj ID'
        };

        const formatCbTitle = (source: string, qty: string) => {
            const label = qtyDisplayMap[qty] || qty;
            const unit = unitMap[qty] ? ` (${unitMap[qty]})` : '';
            return `${source}: ${label}${unit}`;
        };

        const specs: Array<{
            id: string;
            title: string;
            quantity: string;
            colormap: string;
            autoScale: boolean;
            logScale: boolean;
            minVal: number;
            maxVal: number;
            onToggleOff: () => void;
            onToggleAuto: () => void;
            onToggleLog: () => void;
            onSelectColormap: (anchorEl: HTMLElement) => void;
            onSetMinMax: (min: number, max: number) => void;
            onSelectQuantity: (anchorEl: HTMLElement) => void;
        }> = [];

        // 1. Slices
        const slices = params.slices || [];
        slices.forEach((slice: any, idx: number) => {
            if (slice.show_colorbar === true && slice.enabled !== false) {
                const qty = slice.quantities?.[0] || 'pressure';
                const colormap = params.quantity_colormaps?.[qty] || slice.colormap || 'plasma';
                const autoScale = slice.auto_scale !== false;
                const logScale = slice.log_scale === true;
                let minVal = slice.min_val ?? 101325.0;
                let maxVal = slice.max_val ?? 1013250.0;
                if (autoScale && this.latestEmpiricalRange) {
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
                    minVal: minVal,
                    maxVal: maxVal,
                    onToggleOff: () => {
                        this.updateSliceProperty(idx, { show_colorbar: false });
                    },
                    onToggleAuto: () => {
                        this.updateSliceProperty(idx, { auto_scale: !autoScale });
                    },
                    onToggleLog: () => {
                        this.updateSliceProperty(idx, { log_scale: !logScale });
                    },
                    onSelectColormap: (anchorEl: HTMLElement) => {
                        this.showColormapPopover(anchorEl, colormap, (newCmap) => {
                            this.setQuantityColormap(qty, newCmap);
                        });
                    },
                    onSetMinMax: (minN: number, maxN: number) => {
                        this.updateSliceProperty(idx, { auto_scale: false, min_val: minN, max_val: maxN });
                    },
                    onSelectQuantity: (anchorEl: HTMLElement) => {
                        this.showQuantityPopover(anchorEl, qty, 'cfd', (newQ) => {
                            const qCmaps = params.quantity_colormaps || {};
                            const newCmap = qCmaps[newQ] || 'plasma';
                            this.updateSliceProperty(idx, { quantities: [newQ], colormap: newCmap });
                        });
                    }
                });
            }
        });

        // 2. Obstacles
        if (params.obstacles_show_colorbar === true && params.show_obstacles !== false) {
            const qty = params.obstacles_quantity || 'pressure';
            const colormap = params.quantity_colormaps?.[qty] || params.obstacles_colormap || 'plasma';
            const autoScale = params.obstacles_auto_scale !== false;
            const logScale = params.obstacles_log_scale === true;
            let minVal = params.obstacles_min_val ?? 101325.0;
            let maxVal = params.obstacles_max_val ?? 1013250.0;
            if (autoScale && this.latestEmpiricalRange) {
                minVal = this.latestEmpiricalRange.min;
                maxVal = this.latestEmpiricalRange.max;
            }
            specs.push({
                id: 'obstacles',
                title: formatCbTitle('Obstacles', qty),
                quantity: qty,
                colormap: colormap,
                autoScale: autoScale,
                logScale: logScale,
                minVal: minVal,
                maxVal: maxVal,
                onToggleOff: () => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { obstacles_show_colorbar: false });
                    this.syncControls(true);
                },
                onToggleAuto: () => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { obstacles_auto_scale: !autoScale });
                    this.syncControls(true);
                },
                onToggleLog: () => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { obstacles_log_scale: !logScale });
                    this.syncControls(true);
                },
                onSelectColormap: (anchorEl: HTMLElement) => {
                    this.showColormapPopover(anchorEl, colormap, (newCmap) => {
                        this.setQuantityColormap(qty, newCmap);
                    });
                },
                onSetMinMax: (minN: number, maxN: number) => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { obstacles_auto_scale: false, obstacles_min_val: minN, obstacles_max_val: maxN });
                    this.syncControls(true);
                },
                onSelectQuantity: (anchorEl: HTMLElement) => {
                    this.showQuantityPopover(anchorEl, qty, 'cfd', (newQ) => {
                        const qCmaps = params.quantity_colormaps || {};
                        const newCmap = qCmaps[newQ] || 'plasma';
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { obstacles_quantity: newQ, obstacles_colormap: newCmap });
                        this.syncControls(true);
                    });
                }
            });
        }

        // 3. STL Mesh
        if (params.stl_show_colorbar === true && params.show_stl !== false) {
            const qty = params.stl_quantity || 'pressure';
            const colormap = params.quantity_colormaps?.[qty] || params.stl_colormap || 'plasma';
            const autoScale = params.stl_auto_scale !== false;
            const logScale = params.stl_log_scale === true;
            let minVal = params.stl_min_val ?? 101325.0;
            let maxVal = params.stl_max_val ?? 1013250.0;
            if (autoScale && this.latestEmpiricalRange) {
                minVal = this.latestEmpiricalRange.min;
                maxVal = this.latestEmpiricalRange.max;
            }
            specs.push({
                id: 'stl',
                title: formatCbTitle('STL', qty),
                quantity: qty,
                colormap: colormap,
                autoScale: autoScale,
                logScale: logScale,
                minVal: minVal,
                maxVal: maxVal,
                onToggleOff: () => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { stl_show_colorbar: false });
                    this.syncControls(true);
                },
                onToggleAuto: () => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { stl_auto_scale: !autoScale });
                    this.syncControls(true);
                },
                onToggleLog: () => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { stl_log_scale: !logScale });
                    this.syncControls(true);
                },
                onSelectColormap: (anchorEl: HTMLElement) => {
                    this.showColormapPopover(anchorEl, colormap, (newCmap) => {
                        this.setQuantityColormap(qty, newCmap);
                    });
                },
                onSetMinMax: (minN: number, maxN: number) => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { stl_auto_scale: false, stl_min_val: minN, stl_max_val: maxN });
                    this.syncControls(true);
                },
                onSelectQuantity: (anchorEl: HTMLElement) => {
                    this.showQuantityPopover(anchorEl, qty, 'cfd', (newQ) => {
                        const qCmaps = params.quantity_colormaps || {};
                        const newCmap = qCmaps[newQ] || 'plasma';
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { stl_quantity: newQ, stl_colormap: newCmap });
                        this.syncControls(true);
                    });
                }
            });
        }

        // 4. MPM Particles
        if (params.mpmParticleShowColorbar === true && params.showMPMParticles !== false) {
            const qty = params.mpmParticleQuantity || 'vonMises';
            const colormap = params.mpmParticleColormap || 'plasma';
            const autoScale = params.mpmParticleAutoScale !== false;
            const logScale = params.mpmParticleLogScale === true;
            let minVal = params.mpmParticleMinVal ?? 0.0;
            let maxVal = params.mpmParticleMaxVal ?? 500000000.0;
            if (autoScale && (this.latestMPMRange || this.latestEmpiricalRange)) {
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
                minVal: minVal,
                maxVal: maxVal,
                onToggleOff: () => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmParticleShowColorbar: false });
                    this.syncControls(true);
                },
                onToggleAuto: () => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmParticleAutoScale: !autoScale });
                    this.syncControls(true);
                },
                onToggleLog: () => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmParticleLogScale: !logScale });
                    this.syncControls(true);
                },
                onSelectColormap: (anchorEl: HTMLElement) => {
                    this.showColormapPopover(anchorEl, colormap, (newCmap) => {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmParticleColormap: newCmap });
                        this.worker.postMessage({ type: 'setConfig', data: { mpmParticleColormap: newCmap } });
                        this.syncControls(true);
                    });
                },
                onSetMinMax: (minN: number, maxN: number) => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmParticleAutoScale: false, mpmParticleMinVal: minN, mpmParticleMaxVal: maxN });
                    this.syncControls(true);
                },
                onSelectQuantity: (anchorEl: HTMLElement) => {
                    this.showQuantityPopover(anchorEl, qty, 'mpm', (newQ) => {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { mpmParticleQuantity: newQ, mpmParticleAutoScale: true });
                        this.worker.postMessage({ type: 'setConfig', data: { mpmParticleQuantity: newQ, mpmParticleAutoScale: true } });
                        this.syncControls(true);
                    });
                }
            });
        }

        // 5. FEM Mesh
        if (params.femShowColorbar === true && params.showFEMMesh !== false) {
            const qty = params.femQuantity || 'vonMises';
            const colormap = params.femColormap || 'plasma';
            const autoScale = params.femAutoScale !== false;
            const logScale = params.femLogScale === true;
            let minVal = params.femMinVal ?? 0.0;
            let maxVal = params.femMaxVal ?? (qty === 'plasticStrain' ? 1.0 : 500000000.0);
            if (autoScale && (this.latestFEMRange || this.latestEmpiricalRange)) {
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
                minVal: minVal,
                maxVal: maxVal,
                onToggleOff: () => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { femShowColorbar: false });
                    this.syncControls(true);
                },
                onToggleAuto: () => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { femAutoScale: !autoScale });
                    this.worker.postMessage({ type: 'setConfig', data: { femAutoScale: !autoScale } });
                    this.syncControls(true);
                },
                onToggleLog: () => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { femLogScale: !logScale });
                    this.worker.postMessage({ type: 'setConfig', data: { femLogScale: !logScale } });
                    this.syncControls(true);
                },
                onSelectColormap: (anchorEl: HTMLElement) => {
                    this.showColormapPopover(anchorEl, colormap, (newCmap) => {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { femColormap: newCmap });
                        this.worker.postMessage({ type: 'setConfig', data: { femColormap: newCmap } });
                        this.syncControls(true);
                    });
                },
                onSetMinMax: (minN: number, maxN: number) => {
                    this.stateManager.updateNodeParametersInPlace(vpNode.id, { femAutoScale: false, femMinVal: minN, femMaxVal: maxN });
                    this.worker.postMessage({ type: 'setConfig', data: { femAutoScale: false, femMinVal: minN, femMaxVal: maxN } });
                    this.syncControls(true);
                },
                onSelectQuantity: (anchorEl: HTMLElement) => {
                    this.showQuantityPopover(anchorEl, qty, 'fem', (newQ) => {
                        this.stateManager.updateNodeParametersInPlace(vpNode.id, { femQuantity: newQ, femAutoScale: true });
                        this.worker.postMessage({ type: 'setConfig', data: { femQuantity: newQ, femAutoScale: true } });
                        this.syncControls(true);
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
        this.colorbarContainer.innerHTML = '';
        specs.forEach(spec => {
            this.colorbarContainer!.appendChild(this.createColorbarCard(spec));
        });
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

        // Col 5: RES (Point Size Popover Pill)
        const tdSize = document.createElement('td');
        tdSize.style.padding = '3px 2px';
        const sizePill = document.createElement('button');
        sizePill.id = this.getElId('viewport-mpm-size-btn');
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
        const initCmap = vpNode ? (vpNode.parameters.femColormap || 'plasma') : 'plasma';
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

    private buildRebarTableRow(parent: HTMLElement) {
        const vpNode = this.getViewportNode();
        const initShow = vpNode ? (vpNode.parameters.showRebar !== false) : true;
        const initSol = vpNode ? (vpNode.parameters.rebarSolid !== false) : true;
        const initWir = vpNode ? (vpNode.parameters.rebarWireframe !== false) : true;
        const initRes = vpNode ? (vpNode.parameters.femResults !== false) : true;
        const initQty = vpNode ? (vpNode.parameters.femQuantity || 'vonMises') : 'vonMises';
        const initCmap = vpNode ? (vpNode.parameters.femColormap || 'plasma') : 'plasma';
        const initRadius = vpNode ? (vpNode.parameters.rebarRadius ?? 0.008) : 0.008;

        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

        // Col 1: Vis Checkbox
        const tdVis = document.createElement('td');
        tdVis.style.padding = '3px 2px';
        tdVis.style.textAlign = 'center';
        const showCb = document.createElement('input');
        showCb.type = 'checkbox';
        showCb.id = this.getElId('viewport-rebar-mesh-cb');
        showCb.checked = initShow;
        showCb.onchange = () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { showRebar: showCb.checked });
                this.worker.postMessage({ type: 'setConfig', data: { showRebar: showCb.checked } });
            }
        };
        this.bindEditingEvents(showCb);
        tdVis.appendChild(showCb);
        tr.appendChild(tdVis);

        // Col 2: Layer Title
        const tdLayer = document.createElement('td');
        tdLayer.style.padding = '3px 4px';
        const state = this.stateManager.getCurrentState();
        let rebarCountText = '';
        if (state) {
            const femNodes = state.nodes.filter(n => n.type === 'FEMDomain3D' || n.type === 'FEMObject3D' || n.type === 'LSDynaImporter3D');
            if (femNodes.length > 0) {
                rebarCountText = `<span style="font-size: 8px; color: #ffaa00; font-weight: normal; margin-left: 4px;">(Beams & Trusses)</span>`;
            }
        }
        tdLayer.innerHTML = `⛓️ <b>Rebar Mesh</b>${rebarCountText}`;
        tr.appendChild(tdLayer);

        // Col 3: SOL (Solid 3D Ribbons Toggle Button)
        const tdSol = document.createElement('td');
        tdSol.style.padding = '3px 2px';
        tdSol.style.textAlign = 'center';
        const solBtn = this.createToggleBtn('viewport-rebar-sol-btn', 'Sol', initSol, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { rebarSolid: v });
                this.worker.postMessage({ type: 'setConfig', data: { rebarSolid: v } });
                this.syncControls(true);
            }
        });
        tdSol.appendChild(solBtn);
        tr.appendChild(tdSol);

        // Col 4: LINES (Wireframe Toggle Button)
        const tdWir = document.createElement('td');
        tdWir.style.padding = '3px 2px';
        tdWir.style.textAlign = 'center';
        const wirBtn = this.createToggleBtn('viewport-rebar-wir-btn', 'Wir', initWir, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { rebarWireframe: v });
                this.worker.postMessage({ type: 'setConfig', data: { rebarWireframe: v } });
                this.syncControls(true);
            }
        });
        tdWir.appendChild(wirBtn);
        tr.appendChild(tdWir);

        // Col 5: RES (Results Toggle Button)
        const tdRes = document.createElement('td');
        tdRes.style.padding = '3px 2px';
        tdRes.style.textAlign = 'center';
        const resBtn = this.createToggleBtn('viewport-rebar-res-btn', 'Res', initRes, (v) => {
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
        qtyPill.id = this.getElId('viewport-rebar-qty-pill');
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

        // Col 7: COLOR (Colormap Selector Pill)
        const tdCmap = document.createElement('td');
        tdCmap.style.padding = '3px 4px';
        const cmapPill = document.createElement('div');
        cmapPill.id = this.getElId('viewport-rebar-cmap-pill');
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
                    this.stateManager.updateNodeParametersInPlace(vp.id, { femColormap: newC });
                    this.worker.postMessage({ type: 'setConfig', data: { femColormap: newC } });
                    cmapPill.textContent = newC;
                    this.syncControls(true);
                }
            });
        };
        tdCmap.appendChild(cmapPill);
        tr.appendChild(tdCmap);

        // Col 8: SCL / Auto-Scale
        const tdScl = document.createElement('td');
        tdScl.style.padding = '3px 2px';
        tdScl.style.textAlign = 'center';
        const initAuto = vpNode ? (vpNode.parameters.femAutoScale !== false) : true;
        const autoBtn = this.createToggleBtn('viewport-rebar-auto-btn', 'A', initAuto, (v) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { femAutoScale: v });
                this.worker.postMessage({ type: 'setConfig', data: { femAutoScale: v } });
                this.syncControls(true);
            }
        });
        tdScl.appendChild(autoBtn);
        tr.appendChild(tdScl);

        // Col 9: RADIUS / BAR DIAMETER
        const tdRadius = document.createElement('td');
        tdRadius.style.padding = '3px 4px';
        tdRadius.style.textAlign = 'center';
        const radSel = document.createElement('select');
        radSel.id = this.getElId('viewport-rebar-radius-sel');
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
                this.stateManager.updateNodeParametersInPlace(vp.id, { rebarRadius: val });
                this.worker.postMessage({ type: 'setConfig', data: { rebarRadius: val } });
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
            const cmap = vpNode?.parameters?.quantity_colormaps?.[qty] || slice.colormap || vpNode?.parameters?.colormap || 'plasma';
            return { layer: 'slice', quantity: qty, colormap: cmap };
        }

        // If FEM is present or FEM mesh is explicitly visible
        if (hasFEM || (vpNode?.parameters?.showFEMMesh !== false && (vpNode?.parameters?.femSolid !== false || vpNode?.parameters?.femWireframe !== false))) {
            const qty = vpNode?.parameters?.femQuantity || 'plasticStrain';
            const cmap = vpNode?.parameters?.femColormap || 'rainbow';
            return { layer: 'fem', quantity: qty, colormap: cmap };
        }

        // If MPM is present or MPM particles are visible
        if (hasMPM || (vpNode?.parameters?.showMPMParticles !== false)) {
            const qty = vpNode?.parameters?.mpmParticleQuantity || 'vonMises';
            const cmap = vpNode?.parameters?.mpmParticleColormap || 'plasma';
            return { layer: 'mpm', quantity: qty, colormap: cmap };
        }

        // If STL results are active
        if (vpNode?.parameters?.show_stl !== false && vpNode?.parameters?.stl_show_results !== false) {
            const qty = vpNode?.parameters?.stl_quantity || 'pressure';
            const cmap = vpNode?.parameters?.stl_colormap || 'plasma';
            return { layer: 'stl', quantity: qty, colormap: cmap };
        }

        // Fallback to focused slice
        const { quantity } = getFocusedQuantityAndRange(vpNode || { parameters: {} });
        const cmap = vpNode?.parameters?.colormap || 'plasma';
        return { layer: 'slice', quantity, colormap: cmap };
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

        const solverNode = this.getSolverNode();
        if (solverNode && solverNode.type === 'CFDSolver3D') {
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
        const rebarVisible = vpNode.parameters.showRebar !== false && (vpNode.parameters.rebarSolid !== false || vpNode.parameters.rebarWireframe !== false);
        updateChipStyle('slices', slicesEnabled);
        updateChipStyle('fem', femVisible);
        updateChipStyle('rebar', rebarVisible);
        updateChipStyle('mpm', vpNode.parameters.showMPMParticles !== false);
        updateChipStyle('stl', vpNode.parameters.show_stl !== false);
        updateChipStyle('obstacles', vpNode.parameters.show_obstacles === true);
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
            dockCmapSel.value = activeCtx.colormap || 'plasma';
        }

        // 1. Sync Render Settings
        const gridCb = document.getElementById(this.getElId('viewport-grid-cb')) as HTMLInputElement;
        if (gridCb && document.activeElement !== gridCb) gridCb.checked = this.isGridEnabled(vpNode);

        const edgesCb = document.getElementById(this.getElId('viewport-edges-cb')) as HTMLInputElement;
        if (edgesCb && document.activeElement !== edgesCb) edgesCb.checked = !!vpNode.parameters.cell_edges;

        const rateVal = Number(vpNode.parameters.refresh_rate ?? 2.0);

        const rateSelMatrix = document.getElementById(this.getElId('viewport-refresh-rate-sel-matrix')) as HTMLSelectElement;
        if (rateSelMatrix && rateSelMatrix.dataset.editing !== 'true' && document.activeElement !== rateSelMatrix) {
            this.selectOptionByNumericValue(rateSelMatrix, rateVal);
        }

        const rateSelDock = document.getElementById(this.getElId('viewport-refresh-rate-sel-dock')) as HTMLSelectElement;
        if (rateSelDock && rateSelDock.dataset.editing !== 'true' && document.activeElement !== rateSelDock) {
            this.selectOptionByNumericValue(rateSelDock, rateVal);
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
            boxCb.checked = this.isGridBoxEnabled(vpNode);
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

        // Color Bar Sync
        const cbSource = vpNode.parameters.colorbar_source || 'slice';
        let cbQty = 'pressure';
        let cbCmap = 'plasma';
        let cbAuto = true;
        let cbLog = false;
        if (cbSource === 'slice') {
            const { quantity } = getFocusedQuantityAndRange(vpNode);
            cbQty = quantity;
            cbCmap = vpNode.parameters.quantity_colormaps?.[cbQty] || 'plasma';
            cbAuto = vpNode.parameters.auto_scale !== false;
            cbLog = vpNode.parameters.log_scale === true;
        } else if (cbSource === 'mpm') {
            cbQty = vpNode.parameters.mpmParticleQuantity || 'vonMises';
            cbCmap = vpNode.parameters.mpmParticleColormap || 'plasma';
            cbAuto = vpNode.parameters.mpmParticleAutoScale !== false;
            cbLog = vpNode.parameters.mpmParticleLogScale === true;
        } else if (cbSource === 'obstacles') {
            cbQty = vpNode.parameters.obstacles_quantity || 'pressure';
            cbCmap = vpNode.parameters.obstacles_colormap || 'plasma';
            cbAuto = vpNode.parameters.obstacles_auto_scale !== false;
            cbLog = vpNode.parameters.obstacles_log_scale === true;
        } else if (cbSource === 'stl') {
            cbQty = vpNode.parameters.stl_quantity || 'pressure';
            cbCmap = vpNode.parameters.stl_colormap || 'plasma';
            cbAuto = vpNode.parameters.stl_auto_scale !== false;
            cbLog = vpNode.parameters.stl_log_scale === true;
        }

        const cbSourcePill = document.getElementById(this.getElId('viewport-colorbar-source-pill'));
        if (cbSourcePill) {
            cbSourcePill.textContent = cbSource.toUpperCase();
        }
        const cbQtyPill = document.getElementById(this.getElId('viewport-colorbar-qty-pill'));
        if (cbQtyPill) {
            cbQtyPill.textContent = cbQty;
        }
        const cbCmapPill = document.getElementById(this.getElId('viewport-colorbar-cmap-pill'));
        if (cbCmapPill) {
            cbCmapPill.textContent = cbCmap;
        }
        updateBtnStyle('viewport-colorbar-autoscale-btn', cbAuto);
        updateBtnStyle('viewport-colorbar-logscale-btn', cbLog);

        // MPM Particles Sync
        const mpmShowCb = document.getElementById(this.getElId('viewport-mpm-particles-cb')) as HTMLInputElement;
        if (mpmShowCb && document.activeElement !== mpmShowCb) {
            mpmShowCb.checked = vpNode.parameters.showMPMParticles !== false;
        }
        updateBtnStyle('viewport-mpm-auto-btn', vpNode.parameters.mpmParticleAutoScale !== false);
        updateBtnStyle('viewport-mpm-log-btn', vpNode.parameters.mpmParticleLogScale === true);

        const mpmSizeBtn = document.getElementById(this.getElId('viewport-mpm-size-btn'));
        if (mpmSizeBtn) {
            mpmSizeBtn.textContent = `Pt ${vpNode.parameters.mpmParticleSize ?? 4.0}px ▾`;
        }
        const mpmQtyPill = document.getElementById(this.getElId('viewport-mpm-qty-pill'));
        if (mpmQtyPill) {
            mpmQtyPill.textContent = vpNode.parameters.mpmParticleQuantity || 'vonMises';
        }
        const mpmCmapPill = document.getElementById(this.getElId('viewport-mpm-cmap-pill'));
        if (mpmCmapPill) {
            mpmCmapPill.textContent = vpNode.parameters.mpmParticleColormap || 'plasma';
        }
        const mpmOpacPill = document.getElementById(this.getElId('viewport-mpm-opac-pill'));
        if (mpmOpacPill) {
            mpmOpacPill.textContent = `${Math.round((vpNode.parameters.mpmParticleOpacity ?? 1.0) * 100)}% ▾`;
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
                    obstaclesInterpolate: vpNode.parameters.obstacles_interpolate !== false,
                    obstaclesMinVal: vpNode.parameters.obstacles_min_val ?? 101325.0,
                    obstaclesMaxVal: vpNode.parameters.obstacles_max_val ?? 1013250.0,
                    showCharge: vpNode.parameters.show_charge !== false,
                    chargeSolid: vpNode.parameters.charge_solid !== false,
                    chargeWireframe: vpNode.parameters.charge_wireframe !== false,
                    chargeLighting: vpNode.parameters.charge_lighting !== false,
                    chargeOpacity: vpNode.parameters.charge_opacity ?? 0.65,
                    charge: chargeParams,
                    submeshes: submeshes,
                    showMPMParticles: vpNode.parameters.showMPMParticles !== false,
                    mpmParticleSize: vpNode.parameters.mpmParticleSize ?? 4.0,
                    mpmParticleQuantity: vpNode.parameters.mpmParticleQuantity || 'vonMises',
                    mpmParticleColormap: vpNode.parameters.mpmParticleColormap || 'plasma',
                    mpmParticleAutoScale: vpNode.parameters.mpmParticleAutoScale !== false,
                    mpmParticleLogScale: vpNode.parameters.mpmParticleLogScale === true,
                    mpmParticleOpacity: vpNode.parameters.mpmParticleOpacity ?? 1.0,
                    mpmParticleMinVal: vpNode.parameters.mpmParticleMinVal ?? 0.0,
                    mpmParticleMaxVal: vpNode.parameters.mpmParticleMaxVal ?? 500.0e6,
                    showFEMMesh: vpNode.parameters.showFEMMesh !== false,
                    femSolid: vpNode.parameters.femSolid !== false,
                    femWireframe: vpNode.parameters.femWireframe !== false,
                    femResults: vpNode.parameters.femResults !== false,
                    showRebar: vpNode.parameters.showRebar !== false,
                    rebarSolid: vpNode.parameters.rebarSolid !== false,
                    rebarWireframe: vpNode.parameters.rebarWireframe !== false,
                    rebarRadius: vpNode.parameters.rebarRadius ?? 0.008,
                    femQuantity: vpNode.parameters.femQuantity || 'vonMises',
                    femColormap: vpNode.parameters.femColormap || 'plasma',
                    femAutoScale: vpNode.parameters.femAutoScale !== false,
                    femLogScale: vpNode.parameters.femLogScale === true,
                    femOpacity: vpNode.parameters.femOpacity ?? 1.0,
                    femMinVal: vpNode.parameters.femMinVal ?? 0.0,
                    femMaxVal: vpNode.parameters.femMaxVal ?? 500.0e6
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
            this.buildFEMMeshTableRow(this.staticListContainer);
            this.buildRebarTableRow(this.staticListContainer);
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
                        this.showQuantityPopover(qtyPill, qty, 'cfd', (newQ) => {
                            const qCmaps = vpNode.parameters.quantity_colormaps || {};
                            const newCmap = qCmaps[newQ] || 'plasma';
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

                    const curCmap = vpNode.parameters.quantity_colormaps?.[qty] || slice.colormap || 'plasma';
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
        } else {
            const targetModel = this.getCurrentModel();
            if (targetModel) {
                const femObjNodes = targetModel.nodes.filter((n: any) => n.type === 'FEMObject3D' || n.type === 'LSDynaImporter3D');
                if (femObjNodes.length > 0) {
                    let minX = Infinity, maxX = -Infinity;
                    let minY = Infinity, maxY = -Infinity;
                    let minZ = Infinity, maxZ = -Infinity;
                    for (const obj of femObjNodes) {
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
        const resStlCmap = qCmaps[stlQty] || vpNode.parameters.stl_colormap || 'plasma';

        const obsQty = vpNode.parameters.obstacles_quantity || 'pressure';
        const resObsCmap = qCmaps[obsQty] || vpNode.parameters.obstacles_colormap || 'plasma';

        const resSlices = (vpNode.parameters.slices || []).map((s: any) => {
            const q = s.quantities?.[0] || 'pressure';
            return { ...s, colormap: qCmaps[q] || s.colormap || 'plasma' };
        });

        const targetModel = this.getCurrentModel();
        const hasCFDSolver = targetModel ? targetModel.nodes.some((n: any) => n.type === 'CFDSolver3D' || n.type === 'FSICoupler3D' || n.type === 'FEMFSICoupler3D') : false;

        const configData: any = {
            hasCFDSolver: hasCFDSolver,
            meshType: solverNode?.parameters?.mesh_type || 'regular',
            colormap: vpNode.parameters.colormap || 'plasma',
            minY: syncFocusedMin,
            maxY: syncFocusedMax,
            autoScale: vpNode.parameters.auto_scale !== false,
            showGrid: this.isGridEnabled(vpNode),
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
            obstaclesColormap: resObsCmap,
            showFEMMesh: vpNode.parameters.showFEMMesh !== false,
            femSolid: vpNode.parameters.femSolid !== false,
            femWireframe: vpNode.parameters.femWireframe !== false,
            femResults: vpNode.parameters.femResults !== false,
            femQuantity: vpNode.parameters.femQuantity || 'vonMises',
            femColormap: vpNode.parameters.femColormap || 'plasma',
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
            return this.viewportNodeId;
        }
        const ws = this.stateManager.getActiveWorkspace();
        return ws ? ws.activeModelId : null;
    }

    public isGridBoxEnabled(vpNode: any): boolean {
        if (!vpNode || !vpNode.parameters) return false;
        if (this.isFEMOnlyModel()) {
            return vpNode.parameters.show_grid_box_user_enabled === true;
        }
        return vpNode.parameters.show_grid_box !== false;
    }

    public isGridEnabled(vpNode: any): boolean {
        if (!vpNode || !vpNode.parameters) return false;
        if (this.isFEMOnlyModel()) {
            return vpNode.parameters.show_grid_user_enabled === true;
        }
        return vpNode.parameters.show_grid !== false;
    }

    public getCurrentModel(): any {
        const modelId = this.getCurrentModelId();
        if (!modelId) return null;
        return this.stateManager.getAllModels().find(m => m.id === modelId) || null;
    }

    public isFEMOnlyModel(): boolean {
        if (this.getMeshNode()) return false;
        const solver = this.getSolverNode();
        if (solver?.type === 'FEMDomain3D') return true;
        const model = this.getCurrentModel();
        if (model && model.nodes.some((n: any) => n.type === 'FEMDomain3D')) return true;
        return false;
    }

    public pushFrame(buffer: ArrayBuffer, modelId?: string) {
        if (modelId && this.getCurrentModelId() !== modelId) return;
        this.worker.postMessage({ type: 'frame', data: { buffer } }, [buffer]);
    }

    public updateTelemetry(data: any, modelId?: string) {
        if (modelId && this.getCurrentModelId() !== modelId) return;
        if (data && data.type === 'TELEMETRY_3D') {
            this.hasTelemetryGrid = true;
            const xmin = data.xmin ?? 0.0;
            const ymin = data.ymin ?? 0.0;
            const zmin = data.zmin ?? 0.0;
            const dx = data.dx ?? data.cell_size ?? 0.01;
            const nx = data.nx ?? 64;
            const ny = data.ny ?? 64;
            const nz = data.nz ?? 64;
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

        // Force geometry reload
        this.currentGeometryHash = '';

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
            const pStart = project(axis.pointAt(axis.min)[0], axis.pointAt(axis.min)[1], axis.pointAt(axis.min)[2]);
            const pEnd = project(axis.pointAt(axis.max)[0], axis.pointAt(axis.max)[1], axis.pointAt(axis.max)[2]);
            const screenLen = Math.hypot(pEnd.x - pStart.x, pEnd.y - pStart.y);
            const targetTicks = Math.max(2, Math.min(5, Math.floor(screenLen / (90 * dpr))));

            const { major, minor } = this.getTickInterval(axis.min, axis.max, targetTicks);
            
            let tickVal = Math.ceil(axis.min / major) * major;
            const limit = axis.max + major * 1e-5;

            let lastLabelPos: { x: number, y: number } | null = null;

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

                let skipLabel = false;
                if (lastLabelPos) {
                    const dist = Math.hypot(pLabelPos.x - lastLabelPos.x, pLabelPos.y - lastLabelPos.y);
                    if (dist < 45 * dpr) {
                        skipLabel = true;
                    }
                }

                if (!skipLabel) {
                    ctx.fillStyle = '#ffffff';
                    
                    if (ux > 0.3) ctx.textAlign = 'left';
                    else if (ux < -0.3) ctx.textAlign = 'right';
                    else ctx.textAlign = 'center';

                    if (uy > 0.3) ctx.textBaseline = 'top';
                    else if (uy < -0.3) ctx.textBaseline = 'bottom';
                    else ctx.textBaseline = 'middle';

                    const displayVal = this.formatTickValue(clampedVal, major);
                    ctx.fillText(`${displayVal}${axis.labelSuffix}`, pLabelPos.x, pLabelPos.y);
                    lastLabelPos = { x: pLabelPos.x, y: pLabelPos.y };
                }

                tickVal += major;
            }

            if (minor > 0 && screenLen > 160 * dpr) {
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
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
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
        this.usePerspective = false;
        this.syncProjectionButtons();
        this.worker.postMessage({
            type: 'setConfig',
            data: { usePerspective: false }
        });

        let pitch = 0.0;
        let yaw = 0.0;
        if (val === 'top') {
            pitch = Math.PI / 2 - 0.01;
            yaw = 0.0;
        } else if (val === 'bottom') {
            pitch = -Math.PI / 2 + 0.01;
            yaw = 0.0;
        } else if (val === 'front') {
            pitch = 0.0;
            yaw = Math.PI;
        } else if (val === 'back') {
            pitch = 0.0;
            yaw = 0.0;
        } else if (val === 'left') {
            pitch = 0.0;
            yaw = -Math.PI / 2;
        } else if (val === 'right') {
            pitch = 0.0;
            yaw = Math.PI / 2;
        }

        this.worker.postMessage({
            type: 'setView',
            data: {
                pitch,
                yaw,
                distance: 1.35,
                targetX: 0.0,
                targetY: 0.0,
                targetZ: 0.0
            }
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
                data: { pitch: 0.42, yaw: 1.107, distance: 1.35, targetX: 0.0, targetY: 0.0, targetZ: 0.0 }
            });
        };
        cameraGroup.appendChild(resetBtn);

        const projBtn = document.createElement('button');
        projBtn.id = this.getElId('viewport-dock-proj-btn');
        projBtn.innerHTML = this.usePerspective ? '👁️ Persp' : '📐 Ortho';
        this.applyButtonStyle(projBtn);
        projBtn.style.padding = '2px 6px';
        projBtn.title = 'Toggle Perspective / Orthographic projection';
        projBtn.onclick = () => {
            this.usePerspective = !this.usePerspective;
            this.syncProjectionButtons();
            this.worker.postMessage({
                type: 'setConfig',
                data: { usePerspective: this.usePerspective }
            });
        };
        cameraGroup.appendChild(projBtn);

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
            const vp = this.getViewportNode();
            if (vp) {
                const slices = (vp.parameters.slices || []).map((s: any) => ({ ...s, enabled: active }));
                this.stateManager.updateNodeParametersInPlace(vp.id, { slices });
                this.updateSlices(slices);
                this.syncControls(true);
            }
        }));

        layerGroup.appendChild(createToggleChip('fem', '🏗️ FEM', 'Toggle FEM Mesh', (active) => {
            const vp = this.getViewportNode();
            if (vp) {
                const updates: any = { showFEMMesh: active };
                if (active && vp.parameters.femSolid === false && vp.parameters.femWireframe === false) {
                    updates.femSolid = true;
                    updates.femWireframe = true;
                }
                this.stateManager.updateNodeParametersInPlace(vp.id, updates);
                this.worker.postMessage({ type: 'setConfig', data: { showFEMMesh: active, ...updates } });
                this.syncControls(true);
            }
        }));

        layerGroup.appendChild(createToggleChip('rebar', '⛓️ Rebar', 'Toggle Rebar / Beam Elements', (active) => {
            const vp = this.getViewportNode();
            if (vp) {
                const updates: any = { showRebar: active };
                if (active && vp.parameters.rebarSolid === false && vp.parameters.rebarWireframe === false) {
                    updates.rebarSolid = true;
                    updates.rebarWireframe = true;
                }
                this.stateManager.updateNodeParametersInPlace(vp.id, updates);
                this.worker.postMessage({ type: 'setConfig', data: { showRebar: active, ...updates } });
                this.syncControls(true);
            }
        }));

        layerGroup.appendChild(createToggleChip('mpm', '✨ MPM', 'Toggle MPM Particles', (active) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { showMPMParticles: active });
                this.worker.postMessage({ type: 'setConfig', data: { showMPMParticles: active } });
                this.syncControls(true);
            }
        }));

        layerGroup.appendChild(createToggleChip('stl', '📐 STL', 'Toggle STL Geometry', (active) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { show_stl: active });
                this.worker.postMessage({ type: 'setConfig', data: { showSTL: active } });
                this.syncControls(true);
            }
        }));

        layerGroup.appendChild(createToggleChip('obstacles', '🧱 Obs', 'Toggle Obstacles', (active) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { show_obstacles: active });
                this.worker.postMessage({ type: 'setConfig', data: { showObstacles: active } });
                this.syncControls(true);
            }
        }));

        layerGroup.appendChild(createToggleChip('grid', '🌐 Grid', 'Toggle Domain Grid & Box', (active) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { show_grid: active, show_grid_box: active });
                this.worker.postMessage({ type: 'setConfig', data: { showGrid: active, showGridBox: active } });
                this.syncControls(true);
            }
        }));

        layerGroup.appendChild(createToggleChip('gauges', '🎯 Gauges', 'Toggle Virtual Gauges', (active) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { show_gauges: active });
                this.worker.postMessage({ type: 'setConfig', data: { showGauges: active } });
                this.syncControls(true);
            }
        }));

        layerGroup.appendChild(createToggleChip('lighting', '💡 Light', 'Toggle Lighting & AO', (active) => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { lightingEnabled: active, aoEnabled: active });
                this.worker.postMessage({ type: 'setConfig', data: { lightingEnabled: active, aoEnabled: active } });
                this.syncControls(true);
            }
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
        qtySel.innerHTML = `
            <option value="pressure">Pressure</option>
            <option value="density">Density</option>
            <option value="velocity">Velocity</option>
            <option value="energy">Energy</option>
            <option value="overpressure">Overpressure</option>
            <option value="impulse">Impulse</option>
            <option value="vonMises">von Mises</option>
            <option value="plasticStrain">Plastic Strain</option>
            <option value="plastic_strain">Plastic Strain (MPM)</option>
            <option value="damage">Damage</option>
            <option value="species1">Species 1</option>
            <option value="species2">Species 2</option>
            <option value="species3">Species 3</option>
            <option value="peak_overpressure">Peak Overpressure</option>
            <option value="peak_impulse">Peak Impulse</option>
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
            <option value="plasma">Plasma</option>
            <option value="viridis">Viridis</option>
            <option value="inferno">Inferno</option>
            <option value="magma">Magma</option>
            <option value="coolwarm">Coolwarm</option>
            <option value="rainbow">Rainbow</option>
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
        rateSel.style.width = '75px';
        rateSel.innerHTML = `
            <option value="0.0">Max FPS</option>
            <option value="0.016">60 FPS</option>
            <option value="0.033">30 FPS</option>
            <option value="0.05">20 FPS</option>
            <option value="0.1">10 FPS</option>
            <option value="0.2">5 FPS</option>
            <option value="0.5">2 FPS</option>
            <option value="1.0">1 FPS</option>
            <option value="2.0">0.5 FPS</option>
            <option value="5.0">0.2 FPS</option>
            <option value="10.0">0.1 FPS</option>
        `;
        const vpNode = this.getViewportNode();
        this.selectOptionByNumericValue(rateSel, vpNode ? (vpNode.parameters.refresh_rate ?? 2.0) : 2.0);
        this.bindEditingEvents(rateSel, () => {
            const vp = this.getViewportNode();
            if (vp) {
                this.stateManager.updateNodeParametersInPlace(vp.id, { refresh_rate: Number(rateSel.value) });
                this.sendView3DConfig();
            }
        });
        rightGroup.appendChild(rateSel);

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
                        distance: 1.35,
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
                    distance: 1.35,
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

