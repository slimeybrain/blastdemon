import { SimulationState, Node, Connection, Port, NodeType } from './types.js';
import { StateManager, calculateRefinementMeshInfo, getMeshDisplayHTML } from './state-manager.js';
import { Telemetry3DViewport } from './telemetry-3d-viewport.js';
import { validateSimulationState } from './validation.js';
import { HostFileBrowserModal } from './host-file-browser.js';
import { CustomDialog } from './custom-dialog.js';

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


const SVG_ICONS = {
    horiz: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><rect x="1" y="4" width="5" height="8" rx="1"/><rect x="10" y="4" width="5" height="8" rx="1"/><path d="M6 8h4"/></svg>`,
    vert: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><rect x="4" y="1" width="8" height="5" rx="1"/><rect x="4" y="10" width="8" height="5" rx="1"/><path d="M8 6v4"/></svg>`,
    info: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="display:block;"><rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M8 7v4" stroke-width="1.5"/><circle cx="8" cy="4.5" r="0.75" fill="currentColor"/></svg>`,
    compact: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="display:block;"><rect x="2" y="6" width="12" height="4" rx="1"/></svg>`,
    normal: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="display:block;"><rect x="2" y="4" width="12" height="8" rx="1"/><path d="M2 7h12"/></svg>`,
    expanded: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="display:block;"><rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M2 5h12M2 9h12"/></svg>`
};

export class GraphRenderer {
    public viewport: HTMLElement;
    private container: HTMLElement;
    private svg: SVGSVGElement;
    private stateManager: StateManager;
    private panelId: string;

    private zoom: number = 1.25;
    private panX: number = 0;
    private panY: number = 0;
    private hasInitializedViewport: boolean = false;
    private hasSavedZoomPan: boolean = false;
    private viewportSaveTimeout: any = null;

    private isPanning: boolean = false;
    private isDraggingNode: boolean = false;
    private draggedNodeId: string | null = null;
    private dragOffsetX: number = 0;
    private dragOffsetY: number = 0;

    private selectedNodeIds: Set<string> = new Set();
    private selectedModelId: string | null = null;
    private lastMouseWorldPosition: { x: number, y: number } | null = null;
    private isDraggingModel: boolean = false;
    private draggedModelId: string | null = null;
    private dragStartWorldX: number = 0;
    private dragStartWorldY: number = 0;
    private draggedNodesStartPositions: Map<string, { x: number, y: number }> = new Map();

    private isDraggingWire: boolean = false;
    private dragSourceNodeId: string | null = null;
    private dragSourcePortId: string | null = null;
    private mouseWorldPosition: { x: number, y: number } = { x: 0, y: 0 };
    private hoveredPort: { nodeId: string, portId: string, isInput: boolean } | null = null;

    private nodeElements: Map<string, HTMLElement> = new Map();
    private nodeWorkers: Map<string, Worker> = new Map();
    private viewport3Ds: Map<string, Telemetry3DViewport> = new Map();
    private currentSTLPaths: Map<string, string | null> = new Map();
    private openListener: (() => void) | null = null;
    private viewportRanges: Map<string, { min: number, max: number }> = new Map();
    private viewportDomains: Map<string, { xmin: number, xmax: number, ymin: number, ymax: number, zmin: number, zmax: number }> = new Map();
    private graphFrameCounters: Map<string, number> = new Map();
    /** Set of node IDs whose resize handle is currently being dragged by the user. */
    private nodeUserResizing: Set<string> = new Set();
    private lastMouseX: number = 0;
    private lastMouseY: number = 0;
    /** Pending requestAnimationFrame handle for deferred wire redraws. */
    private connectionRafId: number | null = null;

    private expandedSliceIndices = new Set<string>(); // "nodeId-sliceIdx"
    private gaugesPanelOpen: Map<string, boolean> = new Map();
    private focusedPrimitiveIndexMap: Map<string, number> = new Map();
    private gaugesActiveTab: Map<string, 'list' | 'settings'> = new Map();
    private tabbedFromId: string | null = null;
    private isTabbingForward: boolean = false;
    private isTabbingBackward: boolean = false;
    private pressedEnterOnId: string | null = null;
    private focusedChartNodeId: string | null = null;
    private gaugesZoomedOrPanned: Map<string, boolean> = new Map();
    private gaugesZoomMinX: Map<string, number> = new Map();
    private gaugesZoomMaxX: Map<string, number> = new Map();
    private gaugesIsDragging: Map<string, boolean> = new Map();
    private gaugesDragStartX: Map<string, number> = new Map();
    private gaugesDragStartMinX: Map<string, number> = new Map();
    private gaugesDragStartMaxX: Map<string, number> = new Map();
    private gaugesPanelWidth: Map<string, number> = new Map();


    private selectedNodeId: string | null = null;
    private selectedConnection: Connection | null = null;
    private detachedConnection: Connection | null = null;
    private spacePressed: boolean = false;
    private snapToGrid: boolean = true;
    private showGrid: boolean = true;
    private gridSpacing: number = 20;

    public setSnapToGrid(enabled: boolean): void {
        this.snapToGrid = enabled;
        this.stateManager.updatePanelOptions(this.panelId, { snapToGrid: enabled });
    }

    public setShowGrid(enabled: boolean): void {
        this.showGrid = enabled;
        this.updateGridBackground();
        this.stateManager.updatePanelOptions(this.panelId, { showGrid: enabled });
    }

    public setGridSpacing(spacing: number): void {
        this.gridSpacing = spacing;
        this.updateGridBackground();
        this.stateManager.updatePanelOptions(this.panelId, { gridSpacing: spacing });
    }

    private updateGridBackground(): void {
        if (this.showGrid) {
            this.viewport.style.backgroundImage = `
                linear-gradient(to right, rgba(255, 255, 255, 0.05) 1px, transparent 1px),
                linear-gradient(to bottom, rgba(255, 255, 255, 0.05) 1px, transparent 1px)
            `;
            this.viewport.style.backgroundSize = `${this.gridSpacing * this.zoom}px ${this.gridSpacing * this.zoom}px`;
            this.viewport.style.backgroundPosition = `${this.panX}px ${this.panY}px`;
        } else {
            this.viewport.style.backgroundImage = '';
            this.viewport.style.backgroundSize = '';
            this.viewport.style.backgroundPosition = '';
        }
    }

    private layoutOrientation: 'HORIZ' | 'VERT' = 'HORIZ';

    public onNodeSelected: ((nodeId: string | null) => void) | null = null;

    private eventListeners: { target: EventTarget, type: string, listener: EventListener }[] = [];
    private resizeObserver: ResizeObserver | null = null;
    private nodeResizeObserver: ResizeObserver | null = null;

    private stateListener = () => this.render();
    private resizeTimeout: any = null;
    private telemetryListener = (nodeId: string, data: any) => this.handleTelemetryUpdate(nodeId, data);
    private selectionListener = (nodeId: string | null) => this.handleSelectionChange(nodeId);

    constructor(parent: HTMLElement, stateManager: StateManager, panelId: string) {
        this.stateManager = stateManager;
        this.panelId = panelId;

        this.viewport = document.createElement('div');
        this.viewport.id = 'graph-viewport';
        this.viewport.className = 'panel-content';
        this.viewport.style.overflow = 'hidden';
        this.viewport.style.cursor = 'crosshair';
        this.viewport.style.flex = '1';
        this.viewport.style.position = 'relative';

        this.container = document.createElement('div');
        this.container.id = 'canvas-container';
        this.container.style.position = 'relative';
        this.container.style.transformOrigin = '0 0';
        this.container.style.width = '100%';
        this.container.style.height = '100%';
        this.container.style.zIndex = '0';

        this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as unknown as SVGSVGElement;
        this.svg.id = 'edge-svg';
        this.svg.style.zIndex = '1';
        this.svg.style.overflow = 'visible';
        this.svg.style.position = 'absolute';
        this.svg.style.top = '0';
        this.svg.style.left = '0';
        this.svg.style.width = '100%';
        this.svg.style.height = '100%';
        this.svg.style.pointerEvents = 'none';

        this.container.appendChild(this.svg);
        this.viewport.appendChild(this.container);
        parent.appendChild(this.viewport);

        this.initEventListeners();
        
        const net = (window as any).networkManager;
        if (net) {
            this.openListener = () => {
                this.currentSTLPaths.clear();
                this.render();
            };
            net.onOpen(this.openListener);
        }
        
        // Load settings from panel options state
        const state = this.stateManager.getCurrentState();
        if (state) {
            const findPanelNode = (layout: any, id: string): any => {
                if (layout.type === 'panel') return layout.id === id ? layout : null;
                return findPanelNode(layout.firstChild, id) || findPanelNode(layout.secondChild, id);
            };
            const panel = findPanelNode(state.layout, this.panelId);
            if (panel && panel.options) {
                if (panel.options.layoutOrientation !== undefined) this.layoutOrientation = panel.options.layoutOrientation;
                if (panel.options.showGrid !== undefined) this.showGrid = panel.options.showGrid;
                if (panel.options.snapToGrid !== undefined) this.snapToGrid = panel.options.snapToGrid;
                if (panel.options.gridSpacing !== undefined) this.gridSpacing = panel.options.gridSpacing;
                if (panel.options.zoom !== undefined) {
                    this.zoom = panel.options.zoom;
                    this.hasSavedZoomPan = true;
                }
                if (panel.options.panX !== undefined) this.panX = panel.options.panX;
                if (panel.options.panY !== undefined) this.panY = panel.options.panY;
            }
        }
        
        this.updateGridBackground();
        this.updateTransform();
        this.stateManager.onStateChange(this.stateListener);
        this.stateManager.onTelemetryUpdate(this.telemetryListener);
        this.stateManager.onSelectionChange(this.selectionListener);

        this.resizeObserver = new ResizeObserver(() => {
            const rect = this.viewport.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && !this.hasInitializedViewport) {
                this.hasInitializedViewport = true;
                if (!this.hasSavedZoomPan) {
                    this.fitToView();
                }
            }
            this.render();
        });
        this.resizeObserver.observe(this.viewport);

        this.nodeResizeObserver = new ResizeObserver((entries) => {
            const state = this.stateManager.getCurrentState();
            if (!state) return;
            let changed = false;

            for (const entry of entries) {
                const target = entry.target as HTMLElement;
                const nodeId = target.dataset.id;
                if (!nodeId) continue;
                const node = state.nodes.find(n => n.id === nodeId);
                if (!node) continue;

                // Use bounding client rect divided by zoom to get unscaled dimensions,
                // preventing subpixel rounding feedback loops inside the zoomed container.
                const rect = target.getBoundingClientRect();
                const newWidth = Math.round(rect.width / this.zoom);
                const newHeight = Math.round(rect.height / this.zoom);

                // Guard against zero-size updates and unnecessary state noise
                // Use a threshold (> 4) to completely ignore subpixel rounding fluctuations
                const widthDiff = Math.abs((node.width || 0) - newWidth);
                const heightDiff = Math.abs((node.height || 0) - newHeight);
                if (newWidth > 0 && newHeight > 0 && (widthDiff > 4 || heightDiff > 4)) {
                    const userIsResizing = this.nodeUserResizing.has(nodeId);
                    const isTelemetry = node.type === 'TelemetryGraph' || node.type === 'TelemetryText' || node.type === 'TelemetryContour' || node.type === 'VirtualGauges' || node.type === 'Telemetry3DViewport';
                    if (isTelemetry && node.displayMode !== 'compact') {
                        const isTelemetryText = node.type === 'TelemetryText';
                        if (!isTelemetryText || userIsResizing) {
                            node.width = newWidth;
                            node.height = newHeight;
                            changed = true;
                        }
                    }

                    // Automatic mode switching for telemetry nodes (only when user is resizing)
                    if (userIsResizing && (node.type === 'TelemetryText' || node.type === 'TelemetryGraph' || node.type === 'TelemetryContour' || node.type === 'VirtualGauges' || node.type === 'Telemetry3DViewport')) {
                        let targetMode: 'compact' | 'normal' | 'expanded' = 'normal';
                        if (newHeight < 60) targetMode = 'compact';
                        else if (newHeight >= 180) targetMode = 'expanded';

                        if (node.displayMode !== targetMode) {
                            node.displayMode = targetMode;
                            changed = true;
                        }
                    }

                    // Notify worker of resize
                    if (node.type === 'TelemetryGraph' || node.type === 'TelemetryContour' || node.type === 'Telemetry3DViewport') {
                        const worker = this.nodeWorkers.get(nodeId);
                        if (worker) {
                            const canvas = target.querySelector('canvas');
                            if (canvas) {
                                if (node.type === 'Telemetry3DViewport') {
                                    worker.postMessage({
                                        type: 'resize',
                                        data: {
                                            width: canvas.clientWidth || newWidth,
                                            height: canvas.clientHeight || newHeight
                                        }
                                    });
                                } else {
                                    worker.postMessage({
                                        type: 'resize',
                                        width: canvas.clientWidth || newWidth,
                                        height: canvas.clientHeight || newHeight
                                    });
                                }
                            }
                        }
                    }
                }
            }

            if (changed) {
                // Update connections immediately to align with the visual resize
                this.updateConnections(state);
                this.renderHoverHighlights();

                // Debounce saving the layout to state manager/localStorage to avoid layout loop thrashing
                if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
                this.resizeTimeout = setTimeout(() => {
                    this.stateManager.pushState(state, true);
                }, 400);
            }
        });

        this.render();
    }

    public setLayoutOrientation(o: 'HORIZ' | 'VERT') {
        this.layoutOrientation = o;
        this.stateManager.updatePanelOptions(this.panelId, { layoutOrientation: o });
        const state = this.stateManager.getCurrentState();
        if (state) {
            state.nodes.forEach(n => {
                n.orientation = o;
            });
            this.stateManager.pushState(state);
        } else {
            this.render();
        }
    }

    public destroy(): void {
        if (this.connectionRafId !== null) {
            cancelAnimationFrame(this.connectionRafId);
            this.connectionRafId = null;
        }
        this.eventListeners.forEach(({ target, type, listener }) => {
            target.removeEventListener(type, listener);
        });
        this.stateManager.offStateChange(this.stateListener);
        this.stateManager.offTelemetryUpdate(this.telemetryListener);
        this.stateManager.offSelectionChange(this.selectionListener);
        const net = (window as any).networkManager;
        if (net && this.openListener) {
            net.offOpen(this.openListener);
        }
        this.nodeWorkers.forEach(worker => worker.terminate());
        this.viewport3Ds.forEach(vp => vp.destroy());
        this.viewport3Ds.clear();
        if (this.resizeObserver) this.resizeObserver.disconnect();
        if (this.nodeResizeObserver) this.nodeResizeObserver.disconnect();
        this.viewport.remove();
    }

    private addManagedEventListener(target: EventTarget, type: string, listener: any, options?: AddEventListenerOptions): void {
        target.addEventListener(type, listener, options);
        this.eventListeners.push({ target, type, listener });
    }

    private syncTerminal(terminal: HTMLElement, lines: string[], className?: string): void {
        if (lines.length === 0) {
            terminal.innerHTML = '';
            return;
        }

        const childCount = terminal.children.length;
        
        if (childCount === 0 || childCount > lines.length) {
            terminal.innerHTML = '';
            lines.forEach(line => {
                const div = document.createElement('div');
                if (className) div.className = className;
                div.textContent = line;
                terminal.appendChild(div);
            });
            terminal.scrollTop = terminal.scrollHeight;
            return;
        }

        const lastChild = terminal.lastElementChild as HTMLElement;
        const lastText = lastChild ? lastChild.textContent : null;
        
        let matchIndex = -1;
        if (lastText) {
            for (let i = lines.length - 1; i >= 0; i--) {
                if (lines[i] === lastText) {
                    matchIndex = i;
                    break;
                }
            }
        }

        if (matchIndex !== -1) {
            for (let i = matchIndex + 1; i < lines.length; i++) {
                const div = document.createElement('div');
                if (className) div.className = className;
                div.textContent = lines[i];
                terminal.appendChild(div);
            }
            
            while (terminal.children.length > lines.length) {
                terminal.firstElementChild?.remove();
            }
            terminal.scrollTop = terminal.scrollHeight;
        } else {
            terminal.innerHTML = '';
            lines.forEach(line => {
                const div = document.createElement('div');
                if (className) div.className = className;
                div.textContent = line;
                terminal.appendChild(div);
            });
            terminal.scrollTop = terminal.scrollHeight;
        }
    }

    private handleTelemetryUpdate(nodeId: string, data: any): void {
        const nodeEl = this.nodeElements.get(nodeId);
        if (!nodeEl) return;

        const state = this.stateManager.getCurrentState();
        const node = state?.nodes.find(n => n.id === nodeId);
        if (!node) return;

        if (node.displayMode === 'compact') return;

        if (node.type === 'TelemetryText' && Array.isArray(data)) {
            const body = nodeEl.querySelector('.node-body-text') as HTMLElement;
            if (body) {
                this.syncTerminal(body, data, 'log-line');
                
                // Force connection update to handle any layout shifts or height modifications
                if (this.connectionRafId === null) {
                    this.connectionRafId = requestAnimationFrame(() => {
                        this.connectionRafId = null;
                        const s = this.stateManager.getCurrentState();
                        if (s) {
                            this.updateConnections(s);
                            this.renderHoverHighlights();
                        }
                    });
                }
            }
        } else if (node.type === 'TelemetryGraph' && data) {
            const worker = this.nodeWorkers.get(node.id);
            if (worker) {
                const plotStride = Number(node.parameters?.plot_stride ?? 1);
                let currentCount = this.graphFrameCounters.get(node.id) ?? 0;
                currentCount++;
                this.graphFrameCounters.set(node.id, currentCount);

                const status = this.stateManager.getStatus();
                const isTerminated = status === 'TERMINATED';
                const isInitialized = status === 'INITIALIZED';
                const isTimeZero = (data && typeof data === 'object' && data.time === 0);

                if (isInitialized || isTimeZero) {
                    this.graphFrameCounters.set(node.id, 1);
                    currentCount = 1;
                }

                const isInitialOrControl = currentCount === 1 || isInitialized || isTerminated || isTimeZero;

                if (plotStride > 1 && !isInitialOrControl && currentCount % plotStride !== 0) {
                    return; // Skip this frame
                }

                if (data instanceof ArrayBuffer) {
                    const bufferCopy = data.slice(0);
                    worker.postMessage(bufferCopy, [bufferCopy]);
                } else {
                    const pressureData = data.data || data.telemetry;
                    if (pressureData && (Array.isArray(pressureData) || pressureData instanceof Float32Array)) {
                        worker.postMessage({
                            type: 'data',
                            telemetry: pressureData
                        });
                    }
                }
            }
        } else if (node.type === 'TelemetryContour' && data) {
            const worker = this.nodeWorkers.get(node.id);
            if (worker && data instanceof ArrayBuffer) {
                const bufferCopy = data.slice(0);
                worker.postMessage(bufferCopy, [bufferCopy]);
            }
        } else if (node.type === 'Telemetry3DViewport' && data) {
            const vp = this.viewport3Ds.get(node.id);
            if (vp) {
                if (data instanceof ArrayBuffer) {
                    vp.pushFrame(data.slice(0));
                } else {
                    vp.updateTelemetry(data);
                }
            }
        } else if (node.type === 'VirtualGauges' && data) {
            const canvas = nodeEl.querySelector('canvas') as HTMLCanvasElement;
            if (canvas) {
                const gauges = node.parameters?.gauges || [];
                const currentChannel = Number(node.parameters?.telemetry_channel ?? 0);
                const has2D = state?.nodes.some(n => n.type === 'DomainMesh2D') || false;
                this.drawGaugesChart(canvas, data, gauges, currentChannel, has2D, node.id);
            }
        }
    }

    private initEventListeners(): void {
        this.addManagedEventListener(this.viewport, 'wheel', this.onWheel.bind(this), { passive: false });
        this.addManagedEventListener(this.viewport, 'mousedown', this.onMouseDown.bind(this));
        this.addManagedEventListener(window, 'mousemove', this.onMouseMove.bind(this));
        this.addManagedEventListener(window, 'mouseup', this.onMouseUp.bind(this));

        this.addManagedEventListener(window, 'mousedown', (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (!target.closest('.node-info-btn') && !target.closest('.node-info-overlay')) {
                document.querySelectorAll('.node-info-overlay').forEach(el => el.remove());
            }
            if (!target.closest('.custom-select-container')) {
                document.querySelectorAll('.custom-select-options').forEach(el => {
                    (el as HTMLElement).style.display = 'none';
                });
            }
        });

        this.addManagedEventListener(this.viewport, 'click', (e: MouseEvent) => {
            if (e.target === this.viewport || e.target === this.container || e.target === this.svg) {
                this.selectedNodeIds.clear();
                this.selectedModelId = null;
                this.selectNode(null);
                this.selectedConnection = null;
                if (this.focusedChartNodeId) {
                    const prevFocusedId = this.focusedChartNodeId;
                    this.focusedChartNodeId = null;
                    const prevNodeEl = this.nodeElements.get(prevFocusedId);
                    if (prevNodeEl) {
                        const container = prevNodeEl.querySelector('.gauges-canvas-container');
                        if (container) {
                            (container as HTMLElement).style.outline = '';
                            (container as HTMLElement).style.boxShadow = '';
                        }
                    }
                }
                this.render();
            }
        });

        this.addManagedEventListener(window, 'keydown', this.onKeyDown.bind(this));
        this.addManagedEventListener(window, 'keyup', this.onKeyUp.bind(this));
        this.addManagedEventListener(this.viewport, 'contextmenu', this.onContextMenu.bind(this));
    }

    private onWheel(e: WheelEvent): void {
        e.preventDefault();
        const delta = -e.deltaY;
        const factor = delta > 0 ? 1.1 : 0.9;
        const newZoom = Math.min(Math.max(this.zoom * factor, 0.2), 2.0);

        if (newZoom !== this.zoom) {
            const rect = this.viewport.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            const worldX = (mouseX - this.panX) / this.zoom;
            const worldY = (mouseY - this.panY) / this.zoom;

            this.zoom = newZoom;
            this.panX = mouseX - worldX * this.zoom;
            this.panY = mouseY - worldY * this.zoom;

            this.updateTransform();
            this.saveViewportState();
        }
    }

    private onMouseDown(e: MouseEvent): void {
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;

        const isMiddleMouse = e.button === 1;
        const isSpaceLeft = e.button === 0 && this.spacePressed;

        if (isMiddleMouse || isSpaceLeft) {
            this.isPanning = true;
            this.viewport.style.cursor = 'grabbing';
            return;
        }
    }

    private onMouseMove(e: MouseEvent): void {
        const rect = this.viewport.getBoundingClientRect();
        const worldX = (e.clientX - rect.left - this.panX) / this.zoom;
        const worldY = (e.clientY - rect.top - this.panY) / this.zoom;
        this.lastMouseWorldPosition = { x: worldX, y: worldY };

        const dx = e.clientX - this.lastMouseX;
        const dy = e.clientY - this.lastMouseY;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;

        if (this.isPanning) {
            this.panX += dx;
            this.panY += dy;
            this.updateTransform();
            this.saveViewportState();
        } else if (this.isDraggingWire) {
            const ctm = this.svg.getScreenCTM();
            if (ctm) {
                const pt = new DOMPoint(e.clientX, e.clientY);
                const worldPoint = pt.matrixTransform(ctm.inverse());
                this.mouseWorldPosition = { x: worldPoint.x, y: worldPoint.y };

                // Snapping Logic
                this.hoveredPort = null;
                const state = this.stateManager.getCurrentState();
                if (state) {
                    for (const node of state.nodes) {
                        // Skip if the node is the drag source itself (cannot connect a node to itself)
                        if (node.id === this.dragSourceNodeId) continue;

                        const useRepresentative = node.displayMode === 'compact' || node.displayMode === 'full-panel'
                            || (node.type === 'TelemetryText' && (node.orientation || 'HORIZ') === 'HORIZ');
                        const inputsToCheck = useRepresentative ? (node.inputs.length > 0 ? [node.inputs[0]] : []) : node.inputs;
                        for (const input of inputsToCheck) {
                            // Check compatibility first
                            if (this.dragSourceNodeId && this.dragSourcePortId) {
                                const fromNode = state.nodes.find(n => n.id === this.dragSourceNodeId);
                                if (fromNode && !this.isConnectionCompatible(fromNode, this.dragSourcePortId, node, input.id)) {
                                    continue;
                                }
                            }

                            const pos = this.getPortPosition(node, input.id, true);
                            if (pos) {
                                const localDist = Math.sqrt(Math.pow(pos.x - worldPoint.x, 2) + Math.pow(pos.y - worldPoint.y, 2));
                                const screenDist = localDist * this.zoom;
                                if (screenDist < 25) { // Snapping threshold of 25 screen pixels
                                    this.mouseWorldPosition = { x: pos.x, y: pos.y };
                                    this.hoveredPort = { nodeId: node.id, portId: input.id, isInput: true };
                                    break;
                                }
                            }
                        }
                        if (this.hoveredPort) break;
                    }
                }

                this.render();
            }
        } else if (this.isDraggingNode) {
            const state = this.stateManager.getCurrentState();
            if (state) {
                const rect = this.viewport.getBoundingClientRect();
                const worldX = (e.clientX - rect.left - this.panX) / this.zoom;
                const worldY = (e.clientY - rect.top - this.panY) / this.zoom;

                const dx = worldX - this.dragStartWorldX;
                const dy = worldY - this.dragStartWorldY;

                this.selectedNodeIds.forEach(id => {
                    const startPos = this.draggedNodesStartPositions.get(id);
                    const node = state.nodes.find(n => n.id === id);
                    if (node && startPos) {
                        let targetX = startPos.x + dx;
                        let targetY = startPos.y + dy;
                        if (this.snapToGrid) {
                            targetX = Math.round(targetX / this.gridSpacing) * this.gridSpacing;
                            targetY = Math.round(targetY / this.gridSpacing) * this.gridSpacing;
                        }
                        node.x = Math.round(targetX);
                        node.y = Math.round(targetY);
                    }
                });

                this.stateManager.updateState(state, false);
            }
        } else if (this.isDraggingModel && this.draggedModelId) {
            const state = this.stateManager.getCurrentState();
            if (state) {
                const rect = this.viewport.getBoundingClientRect();
                const worldX = (e.clientX - rect.left - this.panX) / this.zoom;
                const worldY = (e.clientY - rect.top - this.panY) / this.zoom;

                const dx = worldX - this.dragStartWorldX;
                const dy = worldY - this.dragStartWorldY;

                this.draggedNodesStartPositions.forEach((startPos, id) => {
                    const node = state.nodes.find(n => n.id === id);
                    if (node) {
                        let targetX = startPos.x + dx;
                        let targetY = startPos.y + dy;
                        if (this.snapToGrid) {
                            targetX = Math.round(targetX / this.gridSpacing) * this.gridSpacing;
                            targetY = Math.round(targetY / this.gridSpacing) * this.gridSpacing;
                        }
                        node.x = Math.round(targetX);
                        node.y = Math.round(targetY);
                    }
                });

                this.stateManager.updateState(state, false);
            }
        } else {
            const ctm = this.svg.getScreenCTM();
            if (ctm) {
                const pt = new DOMPoint(e.clientX, e.clientY);
                const worldPoint = pt.matrixTransform(ctm.inverse());
                const state = this.stateManager.getCurrentState();
                let found = null;
                if (state) {
                    for (const node of state.nodes) {
                        const useRepresentative = node.displayMode === 'compact' || node.displayMode === 'full-panel'
                            || (node.type === 'TelemetryText' && (node.orientation || 'HORIZ') === 'HORIZ');
                        const inputs = useRepresentative ? (node.inputs.length > 0 ? [node.inputs[0]] : []) : node.inputs;
                        const outputs = useRepresentative ? (node.outputs.length > 0 ? [node.outputs[0]] : []) : node.outputs;
                        for (const port of [...inputs.map(p => ({...p, isInput: true})), ...outputs.map(p => ({...p, isInput: false}))]) {
                            const pos = this.getPortPosition(node, port.id, port.isInput);
                            if (pos) {
                                const localDist = Math.sqrt(Math.pow(pos.x - worldPoint.x, 2) + Math.pow(pos.y - worldPoint.y, 2));
                                const screenDist = localDist * this.zoom;
                                if (screenDist < 20) { // Hover highlighting at 20 screen pixels
                                    found = { nodeId: node.id, portId: port.id, isInput: port.isInput };
                                    break;
                                }
                            }
                        }
                        if (found) break;
                    }
                }
                if (JSON.stringify(found) !== JSON.stringify(this.hoveredPort)) {
                    this.hoveredPort = found;
                    this.render();
                }
            }
        }
    }

    private isConnectionCompatible(fromNode: Node, fromPortId: string, toNode: Node, toPortId: string): boolean {
        const fromType = fromNode.type;
        const toType = toNode.type;

        switch (toType) {
            case 'CFDSolver3D':
                // mesh port only accepts the root DomainMesh3D; subgrids hang off the domain via parent_mesh
                if (toPortId === 'mesh') return fromType === 'DomainMesh3D';
                if (toPortId === 'air') return fromType === 'Material';
                if (toPortId === 'charge') return fromType === 'Charge3D';
                if (toPortId === 'detonator') return fromType === 'DetonatorLocation3D';
                if (toPortId === 'stl') return fromType === 'STLGeometry' || fromType === 'PrimitiveGeometry3D';
                if (toPortId === 'gauges') return fromType === 'VirtualGauges';
                if (toPortId === 'remap') return fromType === 'RemapNode' || fromType === 'Remap1DTo3DNode' || fromType === 'Remap2DTo3DNode';
                return false;
            case 'RefinementMesh3D':
                if (toPortId === 'parent_mesh') return fromType === 'DomainMesh3D' || fromType === 'RefinementMesh3D';
                return false;
            case 'Charge3D':
                if (toPortId === 'material') return fromType === 'Material';
                return false;
            case 'Telemetry3DViewport':
                if (toPortId === 'in') return fromType === 'CFDSolver3D';
                return false;
            case 'ThePainter':
                if (toPortId === 'mesh') return fromType === 'DomainMesh';
                if (toPortId === 'air') return fromType === 'Material';
                if (toPortId === 'explosive') return fromType === 'Charge1D';
                return false;
            case 'CFDSolver':
                if (toPortId === 'in') return fromType === 'ThePainter';
                return false;
            case 'CFDSolver2D':
                if (toPortId === 'mesh') return fromType === 'DomainMesh2D';
                if (toPortId === 'detonator') return fromType === 'DetonatorLocation';
                if (toPortId === 'remap') return fromType === 'RemapNode' || fromType === 'Remap1DTo2DNode';
                if (toPortId === 'hardware') return fromType === 'HardwareConfig';
                if (toPortId === 'air') return fromType === 'Material';
                if (toPortId === 'explosive') return fromType === 'Charge2D' || fromType === 'Charge1D';
                if (toPortId === 'ideal_gas') return fromType === 'Charge2D' || fromType === 'Charge1D';
                return false;
            case 'Charge1D':
            case 'Charge2D':
                if (toPortId === 'material') return fromType === 'Material';
                return false;
            case 'RemapNode':
            case 'Remap1DTo2DNode':
            case 'Remap1DTo3DNode':
                if (toPortId === 'in') return fromType === 'CFDSolver';
                return false;
            case 'Remap2DTo3DNode':
                if (toPortId === 'in') return fromType === 'CFDSolver2D';
                return false;
            case 'VirtualGauges':
                if (toPortId === 'in') return fromType === 'CFDSolver' || fromType === 'CFDSolver2D' || fromType === 'CFDSolver3D';
                return false;
            case 'TelemetryText':
            case 'TelemetryGraph':
                return fromType === 'CFDSolver' || fromType === 'CFDSolver2D' || fromType === 'CFDSolver3D' || fromType === 'MPMDomain2D' || fromType === 'FSICoupler2D';
            case 'MPMDomain2D':
                if (toPortId === 'mesh') return fromType === 'DomainMesh2D';
                if (toPortId === 'objects') return fromType === 'MPMObject2D';
                return false;
            case 'MPMObject2D':
                if (toPortId === 'material') return fromType === 'MPMMaterialSteel';
                return false;
            case 'FSICoupler2D':
                if (toPortId === 'cfd_solver' || toPortId === 'cfd') return fromType === 'CFDSolver2D';
                if (toPortId === 'mpm_domain' || toPortId === 'mpm') return fromType === 'MPMDomain2D';
                return false;
            case 'TelemetryContour':
                return fromType === 'CFDSolver2D' || fromType === 'MPMDomain2D' || fromType === 'FSICoupler2D';
            case 'VTKOutput':
                if (toPortId === 'in') return fromType === 'CFDSolver' || fromType === 'CFDSolver2D' || fromType === 'CFDSolver3D';
                return false;
            default:
                return false;
        }
    }

    private onMouseUp(): void {
        if (this.isDraggingNode && this.draggedNodeId) {
            const state = this.stateManager.getCurrentState();
            if (state) {
                this.stateManager.pushState(state);
            }
        }

        if (this.isDraggingModel && this.draggedModelId) {
            const state = this.stateManager.getCurrentState();
            if (state) {
                this.stateManager.pushState(state);
            }
        }

        if (this.isDraggingWire) {
            if (this.hoveredPort && this.hoveredPort.isInput) {
                const state = this.stateManager.getCurrentState();
                if (state) {
                    const targetNode = state.nodes.find(n => n.id === this.hoveredPort!.nodeId);
                    const isMultiInput = (targetNode?.type === 'MPMDomain2D' && this.hoveredPort!.portId === 'objects')
                        || targetNode?.type === 'TelemetryText'
                        || targetNode?.type === 'TelemetryContour';

                    if (!isMultiInput) {
                        const existingIdx = state.connections.findIndex(conn =>
                            conn.toNode === this.hoveredPort!.nodeId &&
                            conn.toPort === this.hoveredPort!.portId
                        );
                        if (existingIdx !== -1) {
                            state.connections.splice(existingIdx, 1);
                        }
                    }

                    const exists = state.connections.some(conn =>
                        conn.fromNode === this.dragSourceNodeId &&
                        conn.fromPort === this.dragSourcePortId &&
                        conn.toNode === this.hoveredPort!.nodeId &&
                        conn.toPort === this.hoveredPort!.portId
                    );
                    if (!exists) {
                        state.connections.push({
                            fromNode: this.dragSourceNodeId!,
                            fromPort: this.dragSourcePortId!,
                            toNode: this.hoveredPort.nodeId,
                            toPort: this.hoveredPort.portId
                        });
                        this.stateManager.pushState(state);
                    }
                }
            }
            this.isDraggingWire = false;
            this.hoveredPort = null;
            this.detachedConnection = null;
            this.render();
        }

        if (this.isPanning) {
            if (this.viewportSaveTimeout) clearTimeout(this.viewportSaveTimeout);
            this.stateManager.updatePanelOptions(this.panelId, {
                zoom: this.zoom,
                panX: this.panX,
                panY: this.panY
            });
        }

        this.isPanning = false;
        this.isDraggingNode = false;
        this.draggedNodeId = null;
        this.isDraggingModel = false;
        this.draggedModelId = null;
        this.viewport.style.cursor = 'crosshair';
    }

    private onKeyDown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            if (this.focusedChartNodeId) {
                const prevFocusedId = this.focusedChartNodeId;
                this.focusedChartNodeId = null;
                const prevNodeEl = this.nodeElements.get(prevFocusedId);
                if (prevNodeEl) {
                    const container = prevNodeEl.querySelector('.gauges-canvas-container');
                    if (container) {
                        (container as HTMLElement).style.outline = '';
                        (container as HTMLElement).style.boxShadow = '';
                    }
                }
            }
        }

        if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;

        // Ctrl+C (Copy Model)
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
            let targetModelId = this.selectedModelId;
            if (!targetModelId && this.selectedNodeId) {
                const model = this.stateManager.getAllModels().find(m => m.nodes.some(n => n.id === this.selectedNodeId));
                if (model) {
                    targetModelId = model.id;
                }
            }
            if (targetModelId) {
                e.preventDefault();
                this.stateManager.copyModelToClipboard(targetModelId);
                console.log(`Copied model ${targetModelId} to clipboard`);
            }
        }

        // Ctrl+V (Paste Model)
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
            const clipboardModel = this.stateManager.getClipboardModel();
            if (clipboardModel) {
                e.preventDefault();
                let offsetX = 100;
                let offsetY = 100;
                if (this.lastMouseWorldPosition) {
                    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                    clipboardModel.nodes.forEach(n => {
                        if (n.x < minX) minX = n.x;
                        if (n.y < minY) minY = n.y;
                        const w = n.width || 120;
                        const h = n.height || 80;
                        if (n.x + w > maxX) maxX = n.x + w;
                        if (n.y + h > maxY) maxY = n.y + h;
                    });
                    if (minX !== Infinity) {
                        const centerX = (minX + maxX) / 2;
                        const centerY = (minY + maxY) / 2;
                        offsetX = this.lastMouseWorldPosition.x - centerX;
                        offsetY = this.lastMouseWorldPosition.y - centerY;
                    }
                }
                const pasted = this.stateManager.pasteModelFromClipboard(offsetX, offsetY);
                if (pasted) {
                    this.selectedModelId = pasted.id;
                    this.selectedNodeIds.clear();
                    this.selectNode(null);
                    this.selectedConnection = null;
                    this.render();
                }
            }
        }

        if (e.code === 'Space') {
            this.spacePressed = true;
            if (!this.isDraggingNode) this.viewport.style.cursor = 'grab';
        }

        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (this.selectedNodeId) {
                const state = this.stateManager.getCurrentState();
                if (state) {
                    state.nodes = state.nodes.filter(n => n.id !== this.selectedNodeId);
                    state.connections = state.connections.filter(edge => edge.fromNode !== this.selectedNodeId && edge.toNode !== this.selectedNodeId);
                    this.selectNode(null);
                    this.stateManager.pushState(state);
                }
            } else if (this.selectedConnection) {
                const state = this.stateManager.getCurrentState();
                if (state) {
                    state.connections = state.connections.filter(conn =>
                        !(conn.fromNode === this.selectedConnection!.fromNode &&
                          conn.fromPort === this.selectedConnection!.fromPort &&
                          conn.toNode === this.selectedConnection!.toNode &&
                          conn.toPort === this.selectedConnection!.toPort)
                    );
                    this.selectedConnection = null;
                    this.render();
                    this.stateManager.pushState(state);
                }
            }
        }

        if (e.key === 'Escape') {
            const existingMenu = document.querySelector('.context-menu');
            if (existingMenu) existingMenu.remove();

            if (this.isDraggingWire) {
                this.isDraggingWire = false;
                this.hoveredPort = null;
                if (this.detachedConnection) {
                    const state = this.stateManager.getCurrentState();
                    if (state) {
                        state.connections.push(this.detachedConnection);
                        this.stateManager.pushState(state);
                    }
                    this.detachedConnection = null;
                }
                this.render();
            }
        }
    }

    private onKeyUp(e: KeyboardEvent): void {
        if (e.code === 'Space') {
            this.spacePressed = false;
            if (!this.isPanning) this.viewport.style.cursor = 'crosshair';
        }
    }

    private onContextMenu(e: MouseEvent): void {
        e.preventDefault();
        const rect = this.viewport.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const worldX = (mouseX - this.panX) / this.zoom;
        const worldY = (mouseY - this.panY) / this.zoom;

        this.showContextMenu(e.clientX, e.clientY, worldX, worldY, e.target as HTMLElement);
    }

    private showContextMenu(x: number, y: number, wx: number, wy: number, target: HTMLElement): void {
        const existingMenu = document.querySelector('.context-menu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.onmousedown = (e) => e.stopPropagation();

        // 1. Model Copy/Paste Actions
        const modelRectOrLabel = target.closest('[data-model-id]');
        const rightClickedModelId = modelRectOrLabel ? modelRectOrLabel.getAttribute('data-model-id') : null;
        
        if (rightClickedModelId) {
            this.stateManager.setActiveModel(rightClickedModelId);
            this.selectedModelId = rightClickedModelId;
        }
        
        let hasModelActions = false;
        
        if (rightClickedModelId) {
            const model = this.stateManager.getAllModels().find(m => m.id === rightClickedModelId);
            if (model) {
                const renameItem = document.createElement('div');
                renameItem.className = 'context-menu-item';
                renameItem.innerHTML = `✏️ Rename Model <b>${model.name}</b>...`;
                renameItem.onclick = async () => {
                    menu.remove();
                    const newName = await CustomDialog.prompt("Enter new model name:", model.name, "Rename Model");
                    if (newName && newName.trim() && newName.trim() !== model.name) {
                        this.stateManager.renameModel(model.id, newName.trim());
                    }
                };
                menu.appendChild(renameItem);

                const copyItem = document.createElement('div');
                copyItem.className = 'context-menu-item';
                copyItem.innerHTML = `📋 Copy Model <b>${model.name}</b>`;
                copyItem.onclick = () => {
                    this.stateManager.copyModelToClipboard(model.id);
                    menu.remove();
                };
                menu.appendChild(copyItem);
                hasModelActions = true;
            }
        } else if (this.selectedModelId) {
            const model = this.stateManager.getAllModels().find(m => m.id === this.selectedModelId);
            if (model) {
                const renameItem = document.createElement('div');
                renameItem.className = 'context-menu-item';
                renameItem.innerHTML = `✏️ Rename Selected Model <b>${model.name}</b>...`;
                renameItem.onclick = async () => {
                    menu.remove();
                    const newName = await CustomDialog.prompt("Enter new model name:", model.name, "Rename Model");
                    if (newName && newName.trim() && newName.trim() !== model.name) {
                        this.stateManager.renameModel(model.id, newName.trim());
                    }
                };
                menu.appendChild(renameItem);

                const copyItem = document.createElement('div');
                copyItem.className = 'context-menu-item';
                copyItem.innerHTML = `📋 Copy Selected Model <b>${model.name}</b>`;
                copyItem.onclick = () => {
                    this.stateManager.copyModelToClipboard(model.id);
                    menu.remove();
                };
                menu.appendChild(copyItem);
                hasModelActions = true;
            }
        }

        const clipboardModel = this.stateManager.getClipboardModel();
        if (clipboardModel) {
            const pasteItem = document.createElement('div');
            pasteItem.className = 'context-menu-item';
            pasteItem.innerHTML = `📋 Paste Model <b>${clipboardModel.name}</b>`;
            pasteItem.onclick = () => {
                let offsetX = 100;
                let offsetY = 100;
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                clipboardModel.nodes.forEach(n => {
                    if (n.x < minX) minX = n.x;
                    if (n.y < minY) minY = n.y;
                    const w = n.width || 120;
                    const h = n.height || 80;
                    if (n.x + w > maxX) maxX = n.x + w;
                    if (n.y + h > maxY) maxY = n.y + h;
                });
                if (minX !== Infinity) {
                    const centerX = (minX + maxX) / 2;
                    const centerY = (minY + maxY) / 2;
                    offsetX = wx - centerX;
                    offsetY = wy - centerY;
                }
                const pasted = this.stateManager.pasteModelFromClipboard(offsetX, offsetY);
                if (pasted) {
                    this.selectedModelId = pasted.id;
                    this.selectedNodeIds.clear();
                    this.selectNode(null);
                    this.selectedConnection = null;
                    this.render();
                }
                menu.remove();
            };
            menu.appendChild(pasteItem);
            hasModelActions = true;
        }

        if (hasModelActions) {
            const separator = document.createElement('div');
            separator.className = 'menu-separator';
            menu.appendChild(separator);
        }

        const categories = [
            {
                name: 'Material',
                action: () => this.addNode('Material', wx, wy)
            },
            {
                name: '1D Simulation',
                items: [
                    { label: 'Domain Mesh', type: 'DomainMesh' },
                    { label: 'Initializer', type: 'ThePainter' },
                    { label: '1D Charge', type: 'Charge1D' },
                    { label: 'CFD Solver', type: 'CFDSolver' }
                ]
            },
            {
                name: '2D Simulation',
                items: [
                    { label: 'Domain Mesh 2D', type: 'DomainMesh2D' },
                    { label: 'Detonator Location', type: 'DetonatorLocation' },
                    { label: 'Remapper (1D -> 2D)', type: 'Remap1DTo2DNode' },
                    { label: '2D Charge', type: 'Charge2D' },
                    { label: 'CFD Solver 2D', type: 'CFDSolver2D' }
                ]
            },
            {
                name: '3D Simulation',
                items: [
                    { label: 'Domain Mesh 3D', type: 'DomainMesh3D' },
                    { label: 'Refinement Mesh 3D (Submesh)', type: 'RefinementMesh3D' },
                    { label: 'Detonator Location 3D', type: 'DetonatorLocation3D' },
                    { label: 'Remapper (1D -> 3D)', type: 'Remap1DTo3DNode' },
                    { label: 'Remapper (2D -> 3D)', type: 'Remap2DTo3DNode' },
                    { label: '3D Charge', type: 'Charge3D' },
                    { label: 'STL Geometry 3D', type: 'STLGeometry' },
                    { label: 'Primitive Geometry 3D', type: 'PrimitiveGeometry3D' },
                    { label: 'CFD Solver 3D', type: 'CFDSolver3D' }
                ]
            },
            {
                name: 'MPM Simulation (2D)',
                items: [
                    { label: 'MPM Domain 2D', type: 'MPMDomain2D' },
                    { label: 'MPM Object 2D (Primitive)', type: 'MPMObject2D' },
                    { label: 'MPM Steel Material', type: 'MPMMaterialSteel' },
                    { label: 'FSI Coupler 2D', type: 'FSICoupler2D' }
                ]
            },
            {
                name: 'Telemetry & Output',
                items: [
                    { label: 'Telemetry - Text', type: 'TelemetryText' },
                    { label: 'Telemetry - Graph', type: 'TelemetryGraph' },
                    { label: 'Telemetry - Contour (2D)', type: 'TelemetryContour' },
                    { label: 'Telemetry - 3D Viewport', type: 'Telemetry3DViewport' },
                    { label: 'Virtual Gauges', type: 'VirtualGauges' },
                    { label: 'VTK Output Controls', type: 'VTKOutput' }
                ]
            },
            {
                name: 'Configuration',
                items: [
                    { label: 'Hardware Configuration', type: 'HardwareConfig' }
                ]
            }
        ];

        categories.forEach(cat => {
            const catItem = document.createElement('div');
            
            if ('action' in cat && typeof cat.action === 'function') {
                catItem.className = 'context-menu-item';
                catItem.textContent = cat.name;
                catItem.onclick = (e) => {
                    e.stopPropagation();
                    (cat.action as () => void)();
                    menu.remove();
                };
            } else {
                catItem.className = 'context-menu-item has-submenu';
                
                const labelSpan = document.createElement('span');
                labelSpan.textContent = cat.name;
                catItem.appendChild(labelSpan);
                
                const arrowSpan = document.createElement('span');
                arrowSpan.className = 'submenu-arrow';
                arrowSpan.textContent = '▶';
                catItem.appendChild(arrowSpan);
                
                const submenu = document.createElement('div');
                submenu.className = 'submenu';
                
                cat.items.forEach(nt => {
                    const item = document.createElement('div');
                    item.className = 'context-menu-item';
                    item.textContent = nt.label;
                    item.onclick = (e) => {
                        e.stopPropagation();
                        this.addNode(nt.type as NodeType, wx, wy);
                        menu.remove();
                    };
                    submenu.appendChild(item);
                });
                
                catItem.appendChild(submenu);
            }
            menu.appendChild(catItem);
        });

        document.body.appendChild(menu);

        const rect = menu.getBoundingClientRect();
        let adjustedX = x;
        let adjustedY = y;
        if (x + rect.width > window.innerWidth) {
            adjustedX = window.innerWidth - rect.width - 10;
        }
        if (y + rect.height > window.innerHeight) {
            adjustedY = window.innerHeight - rect.height - 10;
        }
        menu.style.left = `${adjustedX}px`;
        menu.style.top = `${adjustedY}px`;

        if (adjustedX + rect.width + 200 > window.innerWidth) {
            menu.classList.add('submenu-left');
            menu.querySelectorAll('.submenu-arrow').forEach(el => {
                el.textContent = '◀';
            });
        }

        const closeMenu = () => {
            menu.remove();
            window.removeEventListener('mousedown', closeMenu);
        };
        setTimeout(() => window.addEventListener('mousedown', closeMenu), 0);
    }

    private showConnectionContextMenu(x: number, y: number, edge: Connection): void {
        const existingMenu = document.querySelector('.context-menu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.onmousedown = (e) => e.stopPropagation();

        const item = document.createElement('div');
        item.className = 'context-menu-item danger';
        item.textContent = 'Delete Connection';
        item.onclick = () => {
            const state = this.stateManager.getCurrentState();
            if (state) {
                state.connections = state.connections.filter(conn =>
                    !(conn.fromNode === edge.fromNode &&
                      conn.fromPort === edge.fromPort &&
                      conn.toNode === edge.toNode &&
                      conn.toPort === edge.toPort)
                );
                if (this.selectedConnection &&
                    this.selectedConnection.fromNode === edge.fromNode &&
                    this.selectedConnection.fromPort === edge.fromPort &&
                    this.selectedConnection.toNode === edge.toNode &&
                    this.selectedConnection.toPort === edge.toPort) {
                    this.selectedConnection = null;
                }
                this.render();
                this.stateManager.pushState(state);
            }
            menu.remove();
        };
        menu.appendChild(item);

        document.body.appendChild(menu);
        const closeMenu = () => {
            menu.remove();
            window.removeEventListener('mousedown', closeMenu);
        };
        setTimeout(() => window.addEventListener('mousedown', closeMenu), 0);
    }

    private addNode(type: NodeType, x: number, y: number): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        const isMesh = (t: string) => ['DomainMesh', 'DomainMesh2D', 'DomainMesh3D'].includes(t);

        const ws = this.stateManager.getActiveWorkspace();
        const activeModelId = ws ? ws.activeModelId : null;
        const activeModelState = activeModelId ? this.stateManager.getSimulationState(activeModelId) : null;
        const targetNodes = activeModelState ? activeModelState.nodes : state.nodes;

        const existingCFDSolver = targetNodes.find(n => ['CFDSolver', 'CFDSolver2D', 'CFDSolver3D'].includes(n.type));
        const existingMPMDomain = targetNodes.find(n => n.type === 'MPMDomain2D');

        if (['CFDSolver', 'CFDSolver2D', 'CFDSolver3D'].includes(type) && existingCFDSolver) {
            alert(`You can only have one CFD Solver per model canvas. Please create a 'New Model' from the top menu for a separate simulation.`);
            return;
        }

        if (type === 'MPMDomain2D' && existingMPMDomain) {
            alert(`You can only have one MPM Domain per model canvas. Please create a 'New Model' from the top menu for a separate simulation.`);
            return;
        }

        if (isMesh(type) && targetNodes.some(n => isMesh(n.type))) {
            alert(`You can only have one Domain Mesh per model canvas. Please create a 'New Model' from the top menu for a separate simulation.`);
            return;
        }

        const id = this.stateManager.generateUniqueNodeId(type);

        const newNode: Node = {
            id, type, x, y,
            displayMode: 'expanded',
            inputs: this.stateManager.getDefaultInputs(type),
            outputs: this.stateManager.getDefaultOutputs(type),
            parameters: this.getDefaultParameters(type)
        };

        if (type === 'TelemetryText' || type === 'TelemetryGraph') {
            newNode.width = 350;
            newNode.height = 220;
        } else if (type === 'TelemetryContour') {
            newNode.width = 350;
            newNode.height = 300;
        } else if (type === 'Telemetry3DViewport') {
            newNode.width = 450;
            newNode.height = 450;
        } else if (type === 'VTKOutput') {
            newNode.width = 250;
            newNode.height = 120;
        }

        state.nodes.push(newNode);
        this.stateManager.pushState(state);
    }

    private getDefaultParameters(type: NodeType): any {
        switch (type) {
            case 'DomainMesh': return {
                dimension: '1D',
                domain_radius: 1.0,
                cell_size: 0.001,
                left_bc: 'Transmitting',
                right_bc: 'Transmitting',
                y_min_bc: 'Reflecting',
                y_max_bc: 'Reflecting',
                z_min_bc: 'Reflecting',
                z_max_bc: 'Reflecting'
            };
            case 'Material': return {
                material_type: 'Air',
                // Air params
                atm_pressure: 101325.0,
                atm_temperature: 288.0,
                gamma: 1.4,
                // JWL params
                composition: 'TNT',
                rho: 1630,
                detonation_energy: 4290000,
                det_vel: 6930,
                jwl_A: 373.77e9,
                jwl_B: 3.747e9,
                jwl_R1: 4.15,
                jwl_R2: 0.90,
                jwl_omega: 0.35,
                // Ideal Gas Charge params
                ideal_gamma: 1.4,
                ideal_rho_0: 1630,
                ideal_e_0: 4290000
            };
            case 'Charge1D': return {
                charge_mass: 0.853479,
                charge_radius: 0.05
            };
            case 'Charge2D': return {
                charge_shape: 'Sphere',
                charge_mass: 0.853479,
                charge_radius: 0.05,
                charge_height: 0.1,
                charge_r: 0.0,
                charge_z: 0.1
            };
            case 'VirtualGauges': {
                const state = this.stateManager.getCurrentState();
                const is3D = state?.nodes.some(n => n.type === 'DomainMesh3D' || n.type === 'CFDSolver3D') || false;
                return {
                    gauges: is3D ? [{ id: 'G1', name: 'G1', x: 0.6, y: 0.5, z: 0.5 }] : [],
                    telemetry_channel: 0,
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
                };
            }
            case 'CFDSolver': return {
                init_mode: 'Multi-Material JWL',
                cfl: 0.4,
                flux_scheme: 'AUSM+',
                spatial_order: 2,
                temporal_order: 2,
                precision: 'single'
            };
            case 'TelemetryGraph': return {
                telemetry_channel: 0,
                x_axis_mode: 'radius',
                plot_stride: 1,
                min_y: 0,
                max_y: 1,
                show_grid: true,
                colormap: 'plasma'
            };
            case 'DomainMesh2D': return {
                cell_size: 0.005,
                max_r: 1.0,
                max_z: 1.0,
                bc_r_min: 'Reflecting',
                bc_r_max: 'Terminate',
                bc_z_min: 'Reflecting',
                bc_z_max: 'Terminate',
                coordinate_system: 'Axisymmetric'
            };
            case 'DetonatorLocation': return {
                detonator_r: 0.0,
                detonator_z: 0.1,
                detonator_radius: 0.001
            };
            case 'DetonatorLocation3D': return {
                detonator_x: 0.5,
                detonator_y: 0.5,
                detonator_z: 0.5
            };
            case 'RemapNode':
            case 'Remap1DTo2DNode': return {
                explosive_r: 0.0,
                explosive_z: 0.1,
                remap_radius: 0.5,
                trigger_type: 'end',
                trigger_val: 0.0
            };
            case 'Remap1DTo3DNode': return {
                explosive_x: 0.5,
                explosive_y: 0.5,
                explosive_z: 0.5,
                remap_radius: 0.5,
                trigger_type: 'end',
                trigger_val: 0.0
            };
            case 'Remap2DTo3DNode': return {
                explosive_x: 0.5,
                explosive_y: 0.5,
                explosive_z: 0.5,
                remap_radius: 0.5,
                trigger_type: 'end',
                trigger_val: 0.0
            };
            case 'HardwareConfig': return {
                device: 'cpu',
                precision: 'single'
            };
            case 'CFDSolver2D': return {
                init_mode: 'From1D',
                cfl: 0.35,
                flux_scheme: 'AUSM+',
                spatial_order: 2,
                temporal_order: 2,
                mesh_type: 'regular',
                amr_max_levels: 3,
                amr_threshold: 0.05,
                amr_coarsen_ratio: 0.2
            };
            case 'TelemetryContour': return {
                telemetry_channel: 0,
                auto_scale: true,
                log_scale: false,
                colormap: 'plasma',
                min_y: 0,
                max_y: 1,
                downsample_stride: 1,
                refresh_rate: 0.0
            };
            case 'VTKOutput': return {
                vtk_dir: './vtk_output',
                export_slices: true,
                export_volumes: false,
                custom_filename: 'vtk_output',
                step_interval: 10,
                time_interval: 0.0,
                vtk_format: 'Binary',
                qty_pressure: true,
                qty_density: true,
                qty_velocity: true,
                qty_energy: true,
                qty_reacted: true,
                qty_unreacted: true,
                qty_air: true,
                qty_overpressure: true,
                qty_impulse: true
            };
            case 'DomainMesh3D': return {
                xmin: 0.0, xmax: 1.0,
                ymin: 0.0, ymax: 1.0,
                zmin: 0.0, zmax: 1.0,
                cell_size: 0.01,
                bc_x_min: 'Reflecting', bc_x_max: 'Transmitting',
                bc_y_min: 'Reflecting', bc_y_max: 'Transmitting',
                bc_z_min: 'Reflecting', bc_z_max: 'Transmitting'
            };
            case 'RefinementMesh3D': return {
                submesh_x: 0.25,
                submesh_y: 0.25,
                submesh_z: 0.25,
                submesh_size_x: 0.5,
                submesh_size_y: 0.5,
                submesh_size_z: 0.5,
                refinement_level: 1
            };
            case 'Charge3D': return {
                charge_shape: 'Sphere',
                charge_mass: 6.8277,
                charge_x: 0.5, charge_y: 0.5, charge_z: 0.5,
                charge_radius: 0.1,
                charge_height: 0.2,
                charge_lx: 0.2, charge_ly: 0.2, charge_lz: 0.2
            };
            case 'CFDSolver3D': return {
                cfl: 0.4,
                device: 'cpu',
                init_mode: 'From1D',
                flux_scheme: 'AUSM+',
                spatial_order: 2,
                temporal_order: 2,
                precision: 'single'
            };
            case 'STLGeometry': return {
                stl_file: '',
                geometry_hash: '',
                voxelization_method: 'watertight_floodfill'
            };
            case 'Telemetry3DViewport': return {
                colormap: 'plasma',
                quantity_colormaps: {
                    pressure: 'plasma',
                    density: 'viridis',
                    velocity: 'rainbow',
                    energy: 'inferno',
                    species1: 'magma',
                    species2: 'coolwarm',
                    species3: 'plasma',
                    solid: 'grayscale',
                    overpressure: 'inferno',
                    impulse: 'thermal'
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
                    impulse: [0.0, 10000.0]
                },
                auto_scale: true,
                log_scale: false,
                show_grid: true,
                grid_meshlines: true,
                show_grid_box: true,
                grid_opacity: 1.0,
                interpolate: true,
                min_val: 101325.0,
                max_val: 101325.0 * 10.0,
                slices: [
                    { axis: 'xy', offset: 0.5, stride: 1, quantities: ['pressure'], opacity: 1.0, colormap: 'plasma', auto_scale: true, log_scale: false, interpolate: true, min_val: 101325.0, max_val: 101325.0 * 10.0, enabled: true }
                ],
                lightingEnabled: true,
                aoEnabled: true,
                ambientLevel: 0.3,
                specularIntensity: 0.4,
                vtk_format: 'Binary',
                step_interval: 10,
                time_interval: 0.0,
                custom_filename: 'vtk_output',
                vtk_dir: './vtk_output',
                export_slices: true,
                export_volumes: false,
                qty_pressure: true,
                qty_density: true,
                qty_velocity: true,
                qty_energy: true,
                qty_reacted: true,
                qty_unreacted: true,
                qty_air: true,
                qty_overpressure: true,
                qty_impulse: true,
                show_stl: true,
                stl_colormap: 'plasma',
                stl_wireframe: false,
                stl_solids: true,
                stl_opacity: 0.5,
                stl_show_results: true,
                stl_quantity: 'pressure',
                stl_sampling_mode: 'nearest',
                refresh_rate: 2.0,
                show_gauges: true,
                gauge_size: 1.0,
                gauge_opacity: 1.0,
                gauge_quantity: 'pressure',
                gauge_solid: true,
                show_obstacles: false,
                obstacles_colormap: 'plasma',
                obstacles_gridlines: true,
                obstacles_solid: true,
                obstacles_lighting: true,
                obstacles_opacity: 1.0,
                obstacles_quantity: 'pressure',
                obstacles_auto_scale: true,
                obstacles_log_scale: false,
                obstacles_interpolate: true,
                obstacles_min_val: 101325.0,
                obstacles_max_val: 101325.0 * 10.0
            };
            case 'MPMDomain2D': return {
                transfer_scheme: 'GIMP',
                velocity_scheme: 'APIC',
                ppc: 4,
                cfl: 0.3,
                time_step: 1.0e-5
            };
            case 'MPMObject2D': return {
                shape_type: 'Rectangle',
                pos_x: 0.5,
                pos_y: 0.5,
                size_x: 0.2,
                size_y: 0.2,
                radius: 0.1,
                vel_x: 0.0,
                vel_y: 0.0,
                angular_vel: 0.0
            };
            case 'MPMMaterialSteel': return {
                density: 7850.0,
                youngs_modulus: 210.0e9,
                poissons_ratio: 0.3,
                yield_stress: 400.0e6,
                hardening_modulus: 1.0e9,
                failure_strain: 0.25,
                tensile_failure_stress: 600.0e6
            };
            case 'FSICoupler2D': return {
                coupling_mode: 'TwoWay_Full',
                penalty_stiffness: 1.0e9,
                contour_quantity: 'von_mises',
                color_map: 'viridis',
                contour_opacity: 1.0,
                contour_min: 0.0,
                contour_max: 500.0e6
            };

            default: return {};
        }
    }

    private updateTransform(): void {
        this.container.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
        this.updateGridBackground();
    }

    private selectNode(nodeId: string | null): void {
        if (nodeId !== null) {
            this.selectedConnection = null;
            const modelId = this.stateManager.getAllModels().find(m => m.nodes.some(n => n.id === nodeId))?.id;
            if (modelId) {
                this.stateManager.setActiveModel(modelId);
            }
        }
        this.stateManager.setSelectedNode(nodeId);
        this.handleSelectionChange(nodeId);
    }

    private handleSelectionChange(nodeId: string | null): void {
        this.selectedNodeId = nodeId;
        if (nodeId !== null) {
            if (!this.selectedNodeIds.has(nodeId)) {
                this.selectedNodeIds.clear();
                this.selectedNodeIds.add(nodeId);
            }
            this.selectedModelId = null;
        } else {
            this.selectedNodeIds.clear();
        }
        if (this.onNodeSelected) this.onNodeSelected(nodeId);
        this.render();
    }

    public render(): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;
        this.syncNodes(state);

        // During an active wire-drag we need the wire preview to update every
        // frame without a delay, so redraw connections immediately.
        if (this.isDraggingWire) {
            this.updateConnections(state);
            return;
        }

        // For all other state updates (node moves, display-mode changes, layout
        // reflows etc.) we defer the SVG wire pass to the next animation frame.
        // This guarantees that any DOM mutations made during this synchronous
        // render call (new port elements, viewport re-parents, flexbox ratio
        // changes) have been fully committed and laid out before we call
        // getBoundingClientRect() / getScreenCTM() on the port bullets.
        if (this.connectionRafId !== null) {
            cancelAnimationFrame(this.connectionRafId);
        }
        this.connectionRafId = requestAnimationFrame(() => {
            this.connectionRafId = null;
            const s = this.stateManager.getCurrentState();
            if (s) {
                this.updateConnections(s);
                this.renderHoverHighlights();
            }
        });
        
        // Also perform an immediate synchronous connection update to prevent any frame lag
        this.updateConnections(state);
    }

    private renderHoverHighlights(): void {
        const existing = this.svg.querySelectorAll('.port-highlight');
        existing.forEach(e => e.remove());

        if (this.hoveredPort) {
            const state = this.stateManager.getCurrentState();
            const node = state?.nodes.find(n => n.id === this.hoveredPort!.nodeId);
            if (node) {
                const pos = this.getPortPosition(node, this.hoveredPort!.portId, this.hoveredPort!.isInput);
                if (pos) {
                    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    circle.setAttribute('cx', pos.x.toString());
                    circle.setAttribute('cy', pos.y.toString());
                    circle.setAttribute('r', '8');
                    circle.setAttribute('fill', 'none');
                    circle.setAttribute('stroke', '#00f0ff');
                    circle.setAttribute('stroke-width', '2');
                    circle.setAttribute('class', 'port-highlight');
                    circle.setAttribute('pointer-events', 'none');
                    this.svg.appendChild(circle);
                }
            }
        }
    }

    private getCompactName(type: NodeType): string {
        switch (type) {
            case 'DomainMesh':      return 'MESH';
            case 'Material':        return 'MATERIAL';
            case 'Charge1D':        return 'CHARGE1D';
            case 'Charge2D':        return 'CHARGE2D';
            case 'VirtualGauges':   return 'GAUGES';
            case 'ThePainter':      return 'INIT';
            case 'CFDSolver':       return 'SOLVER';
            case 'TelemetryText':   return 'LOG';
            case 'TelemetryGraph':  return 'CHART';
            case 'DomainMesh2D':    return 'MESH2D';
            case 'DetonatorLocation':
            case 'DetonatorLocation3D': return 'DETONATOR';
            case 'RemapNode':
            case 'Remap1DTo2DNode': return 'REMAP 1D->2D';
            case 'Remap1DTo3DNode': return 'REMAP 1D->3D';
            case 'Remap2DTo3DNode': return 'REMAP 2D->3D';
            case 'HardwareConfig':   return 'HARDWARE';
            case 'CFDSolver2D':     return 'SOLVER2D';
            case 'TelemetryContour': return 'CONTOUR';
            case 'VTKOutput':       return 'VTK';
            case 'DomainMesh3D':    return 'MESH3D';
            case 'Charge3D':        return 'CHARGE3D';
            case 'CFDSolver3D':     return 'SOLVER3D';
            case 'Telemetry3DViewport': return 'VIEW3D';
            case 'STLGeometry':
            case 'PrimitiveGeometry3D': return 'STL';
            case 'MPMDomain2D':      return 'MPM2D';
            case 'MPMObject2D':      return 'MPM OBJ';
            case 'MPMMaterialSteel': return 'MPM STEEL';
            case 'FSICoupler2D':     return 'FSI 2D';
            default: return (type as string).toUpperCase();
        }
    }

    private getFullNodeName(type: NodeType): string {
        switch (type) {
            case 'DomainMesh':        return 'Domain Mesh';
            case 'Material':          return 'Material';
            case 'Charge1D':          return 'Charge (1D)';
            case 'Charge2D':          return 'Charge (2D)';
            case 'VirtualGauges':     return 'Virtual Gauges';
            case 'ThePainter':        return 'Initializer';
            case 'CFDSolver':         return 'CFD Solver';
            case 'TelemetryText':     return 'Telemetry - Text';
            case 'TelemetryGraph':    return 'Telemetry - Graph';
            case 'DomainMesh2D':      return 'Domain Mesh 2D';
            case 'DetonatorLocation': return 'Detonator Location';
            case 'DetonatorLocation3D': return 'Detonator Location 3D';
            case 'RemapNode':
            case 'Remap1DTo2DNode':   return 'Remapper (1D -> 2D)';
            case 'Remap1DTo3DNode':   return 'Remapper (1D -> 3D)';
            case 'Remap2DTo3DNode':   return 'Remapper (2D -> 3D)';
            case 'HardwareConfig':    return 'Hardware Configuration';
            case 'CFDSolver2D':       return 'CFD Solver 2D';
            case 'TelemetryContour':  return 'Telemetry - Contour (2D)';
            case 'VTKOutput':         return 'VTK Output Controls';
            case 'DomainMesh3D':      return 'Domain Mesh 3D';
            case 'Charge3D':          return 'Charge (3D)';
            case 'CFDSolver3D':       return 'CFD Solver 3D';
            case 'Telemetry3DViewport': return 'Telemetry - 3D Viewport';
            case 'STLGeometry':       return 'STL Geometry 3D';
            case 'PrimitiveGeometry3D': return 'Primitive Geometry 3D';
            case 'MPMDomain2D':      return 'MPM Domain 2D';
            case 'MPMObject2D':      return 'MPM Object 2D';
            case 'MPMMaterialSteel': return 'MPM Material (Steel)';
            case 'FSICoupler2D':     return 'FSI Coupler 2D';
            default: return type;
        }
    }

    private syncNodes(state: SimulationState): void {
        const valResults = this.validateGraph(state);
        const nodeIdsInState = new Set(state.nodes.map(n => n.id));
        for (const [id, el] of this.nodeElements.entries()) {
            if (!nodeIdsInState.has(id)) {
                el.remove();
                this.nodeElements.delete(id);
                this.nodeResizeObserver?.unobserve(el);

                const worker = this.nodeWorkers.get(id);
                if (worker) {
                    worker.terminate();
                    this.nodeWorkers.delete(id);
                }
                const vp = this.viewport3Ds.get(id);
                if (vp) {
                    vp.destroy();
                    this.viewport3Ds.delete(id);
                }
                this.graphFrameCounters.delete(id);
            }
        }

        state.nodes.forEach(node => {
            try {
                let nodeEl = this.nodeElements.get(node.id);
                if (!nodeEl) {
                    nodeEl = document.createElement('div');
                    nodeEl.className = 'node';
                    if (node.type === 'TelemetryGraph' || node.type === 'TelemetryText' || node.type === 'TelemetryContour' || node.type === 'VirtualGauges' || node.type === 'Telemetry3DViewport' || node.type === 'PrimitiveGeometry3D') {
                        nodeEl.classList.add('resizable');
                        if (node.width === undefined) node.width = (node.type === 'Telemetry3DViewport' || node.type === 'VirtualGauges') ? 450 : ((node.type === 'TelemetryContour') ? 350 : ((node.type === 'PrimitiveGeometry3D') ? 460 : 250));
                        if (node.height === undefined) {
                            if (node.type === 'TelemetryText') node.height = 230;
                            else if (node.type === 'TelemetryGraph') node.height = 270;
                            else if (node.type === 'TelemetryContour') node.height = 300;
                            else if (node.type === 'Telemetry3DViewport') node.height = 350;
                            else if (node.type === 'VirtualGauges') node.height = 280;
                            else if (node.type === 'PrimitiveGeometry3D') node.height = 280;
                            else node.height = 130;
                        }

                        // Custom resize handle
                        const resizeHandle = document.createElement('div');
                        resizeHandle.className = 'custom-resize-handle';
                        nodeEl.appendChild(resizeHandle);
                        
                        const nodeId = node.id;
                        resizeHandle.addEventListener('mousedown', (e) => {
                            e.stopPropagation();
                            this.nodeUserResizing.add(nodeId);
                            const startX = e.clientX;
                            const startY = e.clientY;
                            const startW = node.width || nodeEl!.offsetWidth;
                            const startH = node.height || nodeEl!.offsetHeight;
                            const onMove = (me: MouseEvent) => {
                                const dx = (me.clientX - startX) / this.zoom;
                                const dy = (me.clientY - startY) / this.zoom;
                                nodeEl!.style.width = `${Math.max(150, startW + dx)}px`;
                                nodeEl!.style.height = `${Math.max(60, startH + dy)}px`;
                            };
                            const onUp = () => {
                                this.nodeUserResizing.delete(nodeId);
                                window.removeEventListener('mousemove', onMove);
                                window.removeEventListener('mouseup', onUp);
                                
                                // Manually trigger resize observer update just in case
                                const rect = nodeEl!.getBoundingClientRect();
                                const newW = Math.round(rect.width / this.zoom);
                                const newH = Math.round(rect.height / this.zoom);
                                const state = this.stateManager.getCurrentState();
                                if (state) {
                                    const n = state.nodes.find(n => n.id === nodeId);
                                    if (n) {
                                        n.width = newW;
                                        n.height = newH;
                                        this.stateManager.pushState(state, true);
                                    }
                                }
                            };
                            window.addEventListener('mousemove', onMove);
                            window.addEventListener('mouseup', onUp);
                        });
                    }
                    nodeEl.dataset.id = node.id;

                    const portsTop = document.createElement('div');
                    portsTop.className = 'node-ports-top';
                    nodeEl.appendChild(portsTop);

                    const header = document.createElement('div');
                    header.className = 'node-header';

                    const buttonGroup = document.createElement('div');
                    buttonGroup.style.display = 'flex';
                    buttonGroup.style.gap = '4px';

                    const orientBtn = document.createElement('button');
                    orientBtn.className = 'node-orient-btn';
                    buttonGroup.appendChild(orientBtn);

                    const infoBtn = document.createElement('button');
                    infoBtn.className = 'node-info-btn';
                    infoBtn.textContent = 'Info';

                    const collapseBtn = document.createElement('button');
                    collapseBtn.className = 'node-collapse-btn';
                    buttonGroup.appendChild(collapseBtn);

                    header.appendChild(buttonGroup);

                    const titleSpan = document.createElement('span');
                    titleSpan.className = 'node-title-span';
                    titleSpan.textContent = this.getFullNodeName(node.type);
                    header.appendChild(titleSpan);

                    orientBtn.addEventListener('mousedown', (e) => e.stopPropagation());
                    orientBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const stateCopy = this.stateManager.getCurrentState();
                        if (stateCopy) {
                            const n = stateCopy.nodes.find(x => x.id === node.id);
                            if (n) {
                                n.orientation = (n.orientation === 'VERT' ? 'HORIZ' : 'VERT');
                                this.stateManager.pushState(stateCopy);
                            }
                        }
                    });

                    infoBtn.addEventListener('mousedown', (e) => e.stopPropagation());
                    infoBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        // Remove any existing overlay
                        const existing = document.querySelector('.node-info-overlay') as HTMLElement;
                        if (existing) {
                            existing.remove();
                            // If it belonged to this same button click, just toggle off
                            if (existing.dataset.nodeId === node.id) return;
                        }
                        const infoOverlay = document.createElement('div');
                        infoOverlay.className = 'node-info-overlay';
                        infoOverlay.dataset.nodeId = node.id;
                        
                        let bodyContent = this.getNodeDescription(node.type);
                        if (node.type === 'Material') {
                            const matType = node.parameters?.material_type || 'Air';
                            if (matType === 'JWL Charge') {
                                const comp = node.parameters?.composition || 'TNT';
                                 const EXPLOSIVE_REFS: Record<string, string> = {
                                    'Aluminized ANFO': 'Sanchidrián et al., Central European Journal of Energetic Materials (2015)',
                                    'Ammonal': 'Lee et al., LLNL JWL Database (UCRL-50422, 1968)',
                                    'ANFO': 'Lee et al., LLNL JWL Database (UCRL-50422, 1968)',
                                    'Baratol': 'Lee et al., LLNL JWL Database (UCRL-50422, 1968)',
                                    'C-4': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'Composition A-3': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'Composition B': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'Composition C-3': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'Cyclotol': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'Heavy ANFO': 'Sanchidrián et al., Central European Journal of Energetic Materials (2015)',
                                    'HMX': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'LX-04': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'LX-07': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'LX-10': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'LX-14': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'LX-17': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'Mining Emulsion': 'Castedo et al., Int. Journal of Rock Mechanics & Mining Sciences (2018)',
                                    'Octol': 'Lee et al., LLNL JWL Database (UCRL-50422, 1968)',
                                    'PBX 9404': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'PBX 9501': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'PBX 9502': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'PE-10': 'Chemring / STV Group Demolition Range Datasheets (Estimated)',
                                    'PE-12': 'Chemring / STV Group Demolition Range Datasheets (Estimated)',
                                    'PE-4': 'Dobratz & Crawford, LLNL Explosives Handbook (1985) / PE-4 Cylinder Test Fit',
                                    'PE-8': 'Chemring / STV Group Demolition Range Datasheets (Estimated)',
                                    'Pentolite': 'Lee et al., LLNL JWL Database (UCRL-50422, 1968)',
                                    'PETN': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'RDX': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'TATB': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'Tetryl': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'TNT': 'Dobratz & Crawford, LLNL Explosives Handbook (1985)',
                                    'Water Gel': 'Sanchidrián et al., Central European Journal of Energetic Materials (2015)',
                                    'Custom': 'N/A'
                                };
                                const ref = EXPLOSIVE_REFS[comp] || 'N/A';
                                bodyContent += `<br/><br/><strong>Composition:</strong> ${comp}<br/><strong>Reference Source:</strong> ${ref}`;
                            }
                        }

                        infoOverlay.innerHTML = `
                            <div class="node-info-overlay-title">${node.type} Info</div>
                            <div class="node-info-overlay-body">${bodyContent}</div>
                        `;
                        // Convert client coords → world coords so overlay scales with canvas
                        const rect = this.viewport.getBoundingClientRect();
                        const OFFSET = 12;
                        const worldX = (e.clientX - rect.left - this.panX) / this.zoom + OFFSET;
                        const worldY = (e.clientY - rect.top  - this.panY) / this.zoom + OFFSET;
                        infoOverlay.style.left = `${worldX}px`;
                        infoOverlay.style.top  = `${worldY}px`;
                        infoOverlay.addEventListener('click', (ev) => {
                            ev.stopPropagation();
                            infoOverlay.remove();
                        });
                        // Append to world-space container so it zooms/pans with the graph
                        this.container.appendChild(infoOverlay);
                    });

                    collapseBtn.addEventListener('mousedown', (e) => e.stopPropagation());
                    collapseBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.stateManager.toggleNodeDisplayMode(node.id);
                    });

                    header.addEventListener('mousedown', (e) => {
                        if (this.spacePressed || e.button !== 0) return;
                        e.stopPropagation();

                        const isModifier = e.shiftKey || e.ctrlKey || e.metaKey;
                        if (isModifier) {
                            if (this.selectedNodeIds.has(node.id)) {
                                this.selectedNodeIds.delete(node.id);
                                if (this.selectedNodeId === node.id) {
                                    const next = Array.from(this.selectedNodeIds)[0] || null;
                                    this.selectNode(next);
                                } else {
                                    this.render();
                                }
                            } else {
                                this.selectedNodeIds.add(node.id);
                                this.selectNode(node.id);
                            }
                        } else {
                            if (!this.selectedNodeIds.has(node.id)) {
                                this.selectedNodeIds.clear();
                                this.selectedNodeIds.add(node.id);
                            }
                            this.selectNode(node.id);
                        }

                        this.isDraggingNode = true;
                        this.draggedNodeId = node.id;

                        const rect = this.viewport.getBoundingClientRect();
                        const worldX = (e.clientX - rect.left - this.panX) / this.zoom;
                        const worldY = (e.clientY - rect.top - this.panY) / this.zoom;
                        this.dragStartWorldX = worldX;
                        this.dragStartWorldY = worldY;

                        this.draggedNodesStartPositions.clear();
                        const currentState = this.stateManager.getCurrentState();
                        if (currentState) {
                            this.selectedNodeIds.forEach(id => {
                                const n = currentState.nodes.find(nodeItem => nodeItem.id === id);
                                if (n) {
                                    this.draggedNodesStartPositions.set(id, { x: n.x, y: n.y });
                                }
                            });
                        }
                    });
                    nodeEl.appendChild(header);

                    const content = document.createElement('div');
                    content.className = 'node-content';
                    nodeEl.appendChild(content);

                    const ports = document.createElement('div');
                    ports.className = 'node-ports';
                    nodeEl.appendChild(ports);

                    const portsBottom = document.createElement('div');
                    portsBottom.className = 'node-ports-bottom';
                    nodeEl.appendChild(portsBottom);

                    const footer = document.createElement('div');
                    footer.className = 'node-footer';
                    footer.appendChild(infoBtn);
                    nodeEl.appendChild(footer);

                    this.container.appendChild(nodeEl);
                    this.nodeElements.set(node.id, nodeEl);
                    this.nodeResizeObserver?.observe(nodeEl);
                }

                const newLeft = `${node.x}px`;
                const newTop = `${node.y}px`;
                if (nodeEl.style.left !== newLeft) nodeEl.style.left = newLeft;
                if (nodeEl.style.top !== newTop) nodeEl.style.top = newTop;

                // Color code the node left border
                const modelId = this.stateManager.getAllModels().find(m => m.nodes.some(n => n.id === node.id))?.id || '';
                if (modelId) {
                    const colors = this.getModelColors(modelId);
                    nodeEl.style.borderLeft = `4px solid ${colors.base}`;
                }

                // Update validation status classes and tooltips
                const valStatus = valResults.nodeStatus[node.id] || { state: 'valid', messages: [] };
                nodeEl.classList.toggle('has-error', valStatus.state === 'error');
                nodeEl.classList.toggle('has-warning', valStatus.state === 'warning');

                const header = nodeEl.querySelector('.node-header') as HTMLElement;
                if (header) {
                    let errorBadge = header.querySelector('.node-validation-icon.error') as HTMLElement;
                    if (!errorBadge) {
                        errorBadge = document.createElement('span');
                        errorBadge.className = 'node-validation-icon error';
                        errorBadge.textContent = '❌';
                        header.appendChild(errorBadge);
                    }
                    let warningBadge = header.querySelector('.node-validation-icon.warning') as HTMLElement;
                    if (!warningBadge) {
                        warningBadge = document.createElement('span');
                        warningBadge.className = 'node-validation-icon warning';
                        warningBadge.textContent = '⚠️';
                        header.appendChild(warningBadge);
                    }
                    const tooltipText = valStatus.messages.join('\n');
                    errorBadge.setAttribute('title', tooltipText);
                    warningBadge.setAttribute('title', tooltipText);
                }



                const displayMode = node.displayMode || 'expanded';
                const nodeOrientation = node.orientation || 'HORIZ';

                const isTelemetry = node.type === 'TelemetryGraph' || node.type === 'TelemetryText' || node.type === 'TelemetryContour' || node.type === 'VirtualGauges' || node.type === 'Telemetry3DViewport' || node.type === 'PrimitiveGeometry3D';

                // Only override the element's inline width/height from state when the
                // user is NOT actively dragging the native resize handle. Mid-drag, the
                // browser owns those inline styles; writing from state here would jump
                // the node back to the previously-stored (stale) size.
                const isBeingResized = this.nodeUserResizing.has(node.id);
                if (!isBeingResized) {
                    if (node.width !== undefined && displayMode !== 'compact' && isTelemetry) {
                        const newWidth = `${node.width}px`;
                        if (nodeEl.style.width !== newWidth) nodeEl.style.width = newWidth;
                    } else if (node.type === 'PrimitiveGeometry3D' && displayMode === 'expanded') {
                        const newWidth = '320px';
                        if (nodeEl.style.width !== newWidth) nodeEl.style.width = newWidth;
                    } else if (node.type === 'STLGeometry' && displayMode === 'expanded') {
                        const stlFile = node.parameters['stl_file'] || '';
                        const calculatedWidth = Math.max(180, Math.ceil(stlFile.length * 6) + 65);
                        const newWidth = `${calculatedWidth}px`;
                        if (nodeEl.style.width !== newWidth) nodeEl.style.width = newWidth;
                    } else {
                        nodeEl.style.width = '';
                    }

                    if (node.height !== undefined && displayMode !== 'compact' && isTelemetry) {
                        const newHeight = `${node.height}px`;
                        if (nodeEl.style.height !== newHeight) nodeEl.style.height = newHeight;
                    } else {
                        nodeEl.style.height = '';
                    }
                }

                const isSelected = this.selectedNodeIds.has(node.id);
                if (nodeEl.classList.contains('selected') !== isSelected) {
                    nodeEl.classList.toggle('selected', isSelected);
                }

                nodeEl.classList.toggle('orientation-horiz', nodeOrientation === 'HORIZ');
                nodeEl.classList.toggle('orientation-vert', nodeOrientation === 'VERT');

                const orientBtn = nodeEl.querySelector('.node-orient-btn') as HTMLButtonElement;
                if (orientBtn) {
                    orientBtn.innerHTML = nodeOrientation === 'VERT' ? SVG_ICONS.vert : SVG_ICONS.horiz;
                }

                const footer = nodeEl.querySelector('.node-footer') as HTMLElement;
                if (footer) {
                    footer.style.display = displayMode === 'compact' ? 'none' : 'flex';
                }

                const lastMode = nodeEl.dataset.lastMode;
                const lastType = nodeEl.dataset.lastType;
                const lastOrient = nodeEl.dataset.lastOrient;

                const contentEl = nodeEl.querySelector('.node-content') as HTMLElement;
                const portsEl = nodeEl.querySelector('.node-ports') as HTMLElement;
                const portsTopEl = nodeEl.querySelector('.node-ports-top') as HTMLElement;
                const portsBottomEl = nodeEl.querySelector('.node-ports-bottom') as HTMLElement;

                if (lastMode !== displayMode || lastType !== node.type || lastOrient !== nodeOrientation) {
                    nodeEl.dataset.lastMode = displayMode;
                    nodeEl.dataset.lastType = node.type;
                    nodeEl.dataset.lastOrient = nodeOrientation;

                    // Update mode classes
                    nodeEl.classList.remove('mode-normal', 'mode-expanded', 'mode-full-panel', 'mode-compact');
                    nodeEl.classList.add(`mode-${displayMode}`);

                    const collapseBtn = nodeEl.querySelector('.node-collapse-btn') as HTMLButtonElement;
                    if (collapseBtn) {
                        collapseBtn.innerHTML = (SVG_ICONS as any)[displayMode] || '';
                    }

                    // Configure Ports
                    portsEl.innerHTML = '';
                    portsTopEl.innerHTML = '';
                    portsBottomEl.innerHTML = '';

                    if (displayMode === 'compact') {
                        if (nodeOrientation === 'VERT') {
                            if (node.inputs.length > 0) {
                                const p = document.createElement('div');
                                p.className = 'port input vertical representative';
                                const colorClass = this.getPortColorClass(node.type, node.inputs[0].id);
                                p.innerHTML = `<div class="port-bullet vertical ${colorClass}" id="${this.panelId}-port-in-${node.id}-representative"></div>`;
                                p.addEventListener('mousedown', (e) => {
                                    this.handleInputPortMouseDown(e, node.id, node.inputs[0].id);
                                });
                                portsTopEl.appendChild(p);
                            }
                            if (node.outputs.length > 0) {
                                const p = document.createElement('div');
                                p.className = 'port output vertical representative';
                                const colorClass = this.getPortColorClass(node.type, node.outputs[0].id);
                                p.innerHTML = `<div class="port-bullet vertical ${colorClass}" id="${this.panelId}-port-out-${node.id}-representative"></div>`;
                                p.addEventListener('mousedown', (e) => {
                                    e.stopPropagation();
                                    this.isDraggingWire = true;
                                    this.dragSourceNodeId = node.id;
                                    this.dragSourcePortId = node.outputs[0].id;
                                });
                                portsBottomEl.appendChild(p);
                            }
                        } else {
                            if (node.inputs.length > 0) {
                                const p = document.createElement('div');
                                p.className = 'port input representative';
                                const colorClass = this.getPortColorClass(node.type, node.inputs[0].id);
                                p.innerHTML = `<div class="port-bullet ${colorClass}" id="${this.panelId}-port-in-${node.id}-representative"></div>`;
                                p.addEventListener('mousedown', (e) => {
                                    this.handleInputPortMouseDown(e, node.id, node.inputs[0].id);
                                });
                                portsEl.appendChild(p);
                            }
                            if (node.outputs.length > 0) {
                                const p = document.createElement('div');
                                p.className = 'port output representative';
                                const colorClass = this.getPortColorClass(node.type, node.outputs[0].id);
                                p.innerHTML = `<div class="port-bullet ${colorClass}" id="${this.panelId}-port-out-${node.id}-representative"></div>`;
                                p.addEventListener('mousedown', (e) => {
                                    e.stopPropagation();
                                    this.isDraggingWire = true;
                                    this.dragSourceNodeId = node.id;
                                    this.dragSourcePortId = node.outputs[0].id;
                                });
                                portsEl.appendChild(p);
                            }
                        }
                    } else if (displayMode === 'full-panel') {
                        // Render representative port bullets so wires can anchor correctly
                        if (nodeOrientation === 'VERT') {
                            if (node.inputs.length > 0) {
                                const p = document.createElement('div');
                                p.className = 'port input vertical representative';
                                const colorClass = this.getPortColorClass(node.type, node.inputs[0].id);
                                p.innerHTML = `<div class="port-bullet vertical ${colorClass}" id="${this.panelId}-port-in-${node.id}-representative"></div>`;
                                p.addEventListener('mousedown', (e) => {
                                    this.handleInputPortMouseDown(e, node.id, node.inputs[0].id);
                                });
                                portsTopEl.appendChild(p);
                            }
                            if (node.outputs.length > 0) {
                                const p = document.createElement('div');
                                p.className = 'port output vertical representative';
                                const colorClass = this.getPortColorClass(node.type, node.outputs[0].id);
                                p.innerHTML = `<div class="port-bullet vertical ${colorClass}" id="${this.panelId}-port-out-${node.id}-representative"></div>`;
                                p.addEventListener('mousedown', (e) => {
                                    e.stopPropagation();
                                    this.isDraggingWire = true;
                                    this.dragSourceNodeId = node.id;
                                    this.dragSourcePortId = node.outputs[0].id;
                                });
                                portsBottomEl.appendChild(p);
                            }
                        } else {
                            if (node.inputs.length > 0) {
                                const p = document.createElement('div');
                                p.className = 'port input representative';
                                const colorClass = this.getPortColorClass(node.type, node.inputs[0].id);
                                p.innerHTML = `<div class="port-bullet ${colorClass}" id="${this.panelId}-port-in-${node.id}-representative"></div>`;
                                p.addEventListener('mousedown', (e) => {
                                    this.handleInputPortMouseDown(e, node.id, node.inputs[0].id);
                                });
                                portsEl.appendChild(p);
                            }
                            if (node.outputs.length > 0) {
                                const p = document.createElement('div');
                                p.className = 'port output representative';
                                const colorClass = this.getPortColorClass(node.type, node.outputs[0].id);
                                p.innerHTML = `<div class="port-bullet ${colorClass}" id="${this.panelId}-port-out-${node.id}-representative"></div>`;
                                p.addEventListener('mousedown', (e) => {
                                    e.stopPropagation();
                                    this.isDraggingWire = true;
                                    this.dragSourceNodeId = node.id;
                                    this.dragSourcePortId = node.outputs[0].id;
                                });
                                portsEl.appendChild(p);
                            }
                        }
                    } else {
                        if (nodeOrientation === 'VERT') {
                            node.inputs.forEach(input => {
                                const p = document.createElement('div');
                                p.className = 'port input vertical';
                                const colorClass = this.getPortColorClass(node.type, input.id);
                                p.innerHTML = `<div class="port-bullet vertical ${colorClass}" id="${this.panelId}-port-in-${node.id}-${input.id}"></div><span class="port-label vertical">${input.label}</span>`;
                                p.addEventListener('mousedown', (e) => {
                                    this.handleInputPortMouseDown(e, node.id, input.id);
                                });
                                portsTopEl.appendChild(p);
                            });
                            node.outputs.forEach(output => {
                                const p = document.createElement('div');
                                p.className = 'port output vertical';
                                const colorClass = this.getPortColorClass(node.type, output.id);
                                p.innerHTML = `<span class="port-label vertical">${output.label}</span><div class="port-bullet vertical ${colorClass}" id="${this.panelId}-port-out-${node.id}-${output.id}"></div>`;
                                p.addEventListener('mousedown', (e) => {
                                    e.stopPropagation();
                                    this.isDraggingWire = true;
                                    this.dragSourceNodeId = node.id;
                                    this.dragSourcePortId = output.id;
                                });
                                portsBottomEl.appendChild(p);
                            });
                        } else if (node.type === 'TelemetryText') {
                            node.inputs.forEach((inputPort, idx) => {
                                const p = document.createElement('div');
                                p.className = 'port input representative';
                                p.style.top = `${30 + idx * 24}px`;
                                const colorClass = this.getPortColorClass(node.type, inputPort.id);
                                p.innerHTML = `<div class="port-bullet ${colorClass}" id="${this.panelId}-port-in-${node.id}-${inputPort.id}" title="${inputPort.label}"></div>`;
                                p.addEventListener('mousedown', (e) => {
                                    this.handleInputPortMouseDown(e, node.id, inputPort.id);
                                });
                                portsEl.appendChild(p);
                            });
                            if (node.outputs.length > 0) {
                                const p = document.createElement('div');
                                p.className = 'port output representative';
                                const colorClass = this.getPortColorClass(node.type, node.outputs[0].id);
                                p.innerHTML = `<div class="port-bullet ${colorClass}" id="${this.panelId}-port-out-${node.id}-representative"></div>`;
                                p.addEventListener('mousedown', (e) => {
                                    e.stopPropagation();
                                    this.isDraggingWire = true;
                                    this.dragSourceNodeId = node.id;
                                    this.dragSourcePortId = node.outputs[0].id;
                                });
                                portsEl.appendChild(p);
                            }
                        } else {
                            node.inputs.forEach(input => {
                                const p = document.createElement('div');
                                p.className = 'port input';
                                const colorClass = this.getPortColorClass(node.type, input.id);
                                p.innerHTML = `<div class="port-bullet ${colorClass}" id="${this.panelId}-port-in-${node.id}-${input.id}"></div><span class="port-label">${input.label}</span>`;
                                p.addEventListener('mousedown', (e) => {
                                    this.handleInputPortMouseDown(e, node.id, input.id);
                                });
                                portsEl.appendChild(p);
                            });
                            node.outputs.forEach(output => {
                                const p = document.createElement('div');
                                p.className = 'port output';
                                const colorClass = this.getPortColorClass(node.type, output.id);
                                p.innerHTML = `<span class="port-label">${output.label}</span><div class="port-bullet ${colorClass}" id="${this.panelId}-port-out-${node.id}-${output.id}"></div>`;
                                p.addEventListener('mousedown', (e) => {
                                    e.stopPropagation();
                                    this.isDraggingWire = true;
                                    this.dragSourceNodeId = node.id;
                                    this.dragSourcePortId = output.id;
                                });
                                portsEl.appendChild(p);
                            });
                        }
                    }

                    // Clear content if mode/type changed
                    contentEl.innerHTML = '';
                }

                // Update Content
                if (displayMode === 'compact') {
                    contentEl.style.display = 'none';
                } else if (displayMode === 'normal') {
                    if (node.type === 'TelemetryText' || node.type === 'TelemetryGraph' || node.type === 'TelemetryContour' || node.type === 'VirtualGauges' || node.type === 'Telemetry3DViewport') {
                        contentEl.style.display = 'flex';
                        if (node.type === 'VirtualGauges') {
                            this.renderVirtualGaugesContent(node, contentEl);
                        } else {
                            this.renderTelemetryContent(node, contentEl);
                        }
                    } else {
                        contentEl.style.display = 'none';
                    }
                } else {
                    contentEl.style.display = 'flex';
                    if (node.type !== 'VirtualGauges') {
                        this.renderNodeParameters(node, contentEl);
                    }
                    if (node.type === 'TelemetryText' || node.type === 'TelemetryGraph' || node.type === 'TelemetryContour' || node.type === 'Telemetry3DViewport') {
                        this.renderTelemetryContent(node, contentEl);
                    } else if (node.type === 'VirtualGauges') {
                        this.renderVirtualGaugesContent(node, contentEl);
                    }
                }

            } catch (e) {
                console.error(`Failed to render node ${node.id}:`, e);
            }
        });
    }

    private getModelColors(modelId: string): { base: string, faint: string } {
        return this.stateManager.getModelColors(modelId);
    }

    private updateModelRegions(): void {
        const activeWs = this.stateManager.getActiveWorkspace();
        if (!activeWs) return;

        const models = this.stateManager.getWorkspaceModels();
        if (models.length === 0) return;

        const regionsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        regionsGroup.setAttribute('class', 'model-region-group');
        this.svg.appendChild(regionsGroup);

        models.forEach(model => {
            const nodes = model.nodes;
            if (nodes.length === 0) return;

            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;

            nodes.forEach(node => {
                const el = this.nodeElements.get(node.id);
                const w = el ? el.offsetWidth : (node.width || 180);
                const h = el ? el.offsetHeight : (node.height || 150);
                if (node.x < minX) minX = node.x;
                if (node.y < minY) minY = node.y;
                if (node.x + w > maxX) maxX = node.x + w;
                if (node.y + h > maxY) maxY = node.y + h;
            });

            const padding = 30;
            minX -= padding;
            minY -= padding;
            maxX += padding;
            maxY += padding;

            const width = maxX - minX;
            const height = maxY - minY;

            const colors = this.getModelColors(model.id);
            const isModelSelected = this.selectedModelId === model.id;

            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', minX.toString());
            rect.setAttribute('y', minY.toString());
            rect.setAttribute('width', width.toString());
            rect.setAttribute('height', height.toString());
            rect.setAttribute('fill', isModelSelected ? colors.faint.replace('0.04', '0.1') : colors.faint);
            rect.setAttribute('stroke', colors.base);
            rect.setAttribute('stroke-width', isModelSelected ? '3' : '1.5');
            rect.setAttribute('stroke-dasharray', isModelSelected ? 'none' : '4, 4');
            rect.setAttribute('class', `model-region-rect${isModelSelected ? ' selected' : ''}`);
            rect.setAttribute('data-model-id', model.id);
            rect.style.pointerEvents = 'auto';
            rect.style.cursor = 'grab';
            if (isModelSelected) {
                rect.style.filter = `drop-shadow(0 0 6px ${colors.base})`;
            }
            regionsGroup.appendChild(rect);

            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            label.setAttribute('x', (minX + 10).toString());
            label.setAttribute('y', (minY + 20).toString());
            label.setAttribute('fill', colors.base);
            label.setAttribute('class', 'model-region-label');
            label.setAttribute('data-model-id', model.id);
            label.style.pointerEvents = 'auto';
            label.style.cursor = 'grab';
            
            let labelText = model.name;
            if (model.filename) {
                labelText += ` (${model.filename})`;
            }
            if (activeWs.activeModelId === model.id) {
                labelText += ' ✏';
            }
            label.textContent = labelText;
            regionsGroup.appendChild(label);

            const handleModelMouseDown = (e: MouseEvent) => {
                if (this.spacePressed || e.button !== 0) return;
                e.stopPropagation();
                e.preventDefault();

                this.stateManager.setActiveModel(model.id);
                this.selectedModelId = model.id;
                this.selectedNodeIds.clear();
                this.selectNode(null);
                this.selectedConnection = null;

                this.isDraggingModel = true;
                this.draggedModelId = model.id;

                const rectBound = this.viewport.getBoundingClientRect();
                const worldX = (e.clientX - rectBound.left - this.panX) / this.zoom;
                const worldY = (e.clientY - rectBound.top - this.panY) / this.zoom;
                this.dragStartWorldX = worldX;
                this.dragStartWorldY = worldY;

                this.draggedNodesStartPositions.clear();
                model.nodes.forEach(n => {
                    this.draggedNodesStartPositions.set(n.id, { x: n.x, y: n.y });
                });

                this.render();
            };

            const handleModelDblClick = async (e: MouseEvent) => {
                e.stopPropagation();
                e.preventDefault();
                const newName = await CustomDialog.prompt("Enter new model name:", model.name, "Rename Model");
                if (newName && newName.trim() && newName.trim() !== model.name) {
                    this.stateManager.renameModel(model.id, newName.trim());
                }
            };

            rect.addEventListener('mousedown', handleModelMouseDown);
            label.addEventListener('mousedown', handleModelMouseDown);
            rect.addEventListener('dblclick', handleModelDblClick);
            label.addEventListener('dblclick', handleModelDblClick);
        });
    }

    private handleInputPortMouseDown(e: MouseEvent, nodeId: string, portId: string): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        const existingIndex = state.connections.findIndex(conn =>
            conn.toNode === nodeId && conn.toPort === portId
        );

        if (existingIndex !== -1) {
            e.stopPropagation();
            e.preventDefault();

            const conn = state.connections[existingIndex];

            // Remove connection from state immediately
            state.connections.splice(existingIndex, 1);
            this.stateManager.pushState(state);

            // Start dragging wire from the original output port
            this.isDraggingWire = true;
            this.dragSourceNodeId = conn.fromNode;
            this.dragSourcePortId = conn.fromPort;
            this.detachedConnection = conn;

            // Set mouse position
            const ctm = this.svg.getScreenCTM();
            if (ctm) {
                const pt = new DOMPoint(e.clientX, e.clientY);
                const worldPoint = pt.matrixTransform(ctm.inverse());
                this.mouseWorldPosition = { x: worldPoint.x, y: worldPoint.y };
            }
            this.render();
        }
    }

    private updateConnections(state: SimulationState): void {
        this.svg.innerHTML = '';
        this.updateModelRegions();
        const valResults = this.validateGraph(state);

        state.connections.forEach(edge => {
            const fromNode = state.nodes.find(n => n.id === edge.fromNode);
            const toNode = state.nodes.find(n => n.id === edge.toNode);
            if (!fromNode || !toNode) return;
            const fromPos = this.getPortPosition(fromNode, edge.fromPort, false);
            const toPos = this.getPortPosition(toNode, edge.toPort, true);
            if (!fromPos || !toPos) return;

            const dist = Math.sqrt(Math.pow(toPos.x - fromPos.x, 2) + Math.pow(toPos.y - fromPos.y, 2));
            const strength = Math.max(dist * 0.5, 50);

            const fromOrient = fromNode.orientation || 'HORIZ';
            const toOrient = toNode.orientation || 'HORIZ';

            const cp1X = fromOrient === 'VERT' ? fromPos.x : fromPos.x + strength;
            const cp1Y = fromOrient === 'VERT' ? fromPos.y + strength : fromPos.y;

            const cp2X = toOrient === 'VERT' ? toPos.x : toPos.x - strength;
            const cp2Y = toOrient === 'VERT' ? toPos.y - strength : toPos.y;

            const isSelected = this.selectedConnection &&
                               this.selectedConnection.fromNode === edge.fromNode &&
                               this.selectedConnection.fromPort === edge.fromPort &&
                               this.selectedConnection.toNode === edge.toNode &&
                               this.selectedConnection.toPort === edge.toPort;

            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            group.setAttribute('class', 'edge-group');
            if (isSelected) {
                group.classList.add('selected');
            }

            const connKey = `${edge.fromNode}:${edge.fromPort}->${edge.toNode}:${edge.toPort}`;
            const flawMsg = valResults.flawedConnections.get(connKey);
            const isFlawed = flawMsg !== undefined;

            if (isFlawed) {
                group.classList.add('flawed');
            }

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const d = `M ${fromPos.x} ${fromPos.y} C ${cp1X} ${cp1Y}, ${cp2X} ${cp2Y}, ${toPos.x} ${toPos.y}`;
            path.setAttribute('d', d);
            
            if (isFlawed) {
                path.setAttribute('class', 'edge-path flawed');
                const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
                titleEl.textContent = `Warning: ${flawMsg}`;
                group.appendChild(titleEl);
            } else {
                path.setAttribute('class', 'edge-path');
            }

            const fromModelId = this.stateManager.getAllModels().find(m => m.nodes.some(n => n.id === edge.fromNode))?.id;
            const toModelId = this.stateManager.getAllModels().find(m => m.nodes.some(n => n.id === edge.toNode))?.id;

            if (isFlawed) {
                path.style.stroke = '#ef4444';
                path.style.strokeWidth = '3px';
            } else if (fromModelId && toModelId && fromModelId === toModelId) {
                const colors = this.getModelColors(fromModelId);
                path.style.stroke = colors.base;
                path.style.strokeWidth = '2px';
            } else {
                path.style.stroke = '#a855f7';
                path.setAttribute('stroke-dasharray', '2, 2');
                path.style.strokeWidth = '2px';
            }
            path.setAttribute('fill', 'none');


            const interactivePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            interactivePath.setAttribute('d', d);
            interactivePath.setAttribute('class', 'edge-path-interactive');

            interactivePath.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                this.selectNode(null);
                this.selectedConnection = edge;
                this.render();
            });

            interactivePath.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.selectNode(null);
                this.selectedConnection = edge;
                this.render();
                this.showConnectionContextMenu(e.clientX, e.clientY, edge);
            });

            group.appendChild(path);
            group.appendChild(interactivePath);
            this.svg.appendChild(group);
        });


        if (this.isDraggingWire && this.dragSourceNodeId) {
            const sourceNode = state.nodes.find(n => n.id === this.dragSourceNodeId);
            const fromPos = this.getPortPosition(sourceNode!, this.dragSourcePortId!, false);
            if (fromPos) {
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                const toPos = this.mouseWorldPosition;
                const dist = Math.sqrt(Math.pow(toPos.x - fromPos.x, 2) + Math.pow(toPos.y - fromPos.y, 2));
                const strength = Math.max(dist * 0.5, 50);

                const fromOrient = sourceNode!.orientation || 'HORIZ';
                const cp1X = fromOrient === 'VERT' ? fromPos.x : fromPos.x + strength;
                const cp1Y = fromOrient === 'VERT' ? fromPos.y + strength : fromPos.y;

                const cp2X = this.layoutOrientation === 'VERT' ? toPos.x : toPos.x - strength;
                const cp2Y = this.layoutOrientation === 'VERT' ? toPos.y - strength : toPos.y;

                const d = `M ${fromPos.x} ${fromPos.y} C ${cp1X} ${cp1Y}, ${cp2X} ${cp2Y}, ${toPos.x} ${toPos.y}`;
                path.setAttribute('d', d);
                path.setAttribute('stroke', '#00f0ff');
                path.setAttribute('stroke-dasharray', '5,5');
                path.setAttribute('fill', 'none');
                this.svg.appendChild(path);
            }
        }
    }

    private getPortColorClass(nodeType: string, portId: string): string {
        if (nodeType === 'DomainMesh' || nodeType === 'DomainMesh2D' || portId === 'mesh') return 'domain';
        if (nodeType === 'STLGeometry' || portId === 'stl') return 'domain';
        if (nodeType === 'Charge1D' || nodeType === 'Charge2D' || portId === 'explosive') return 'explosive';
        if (portId === 'ideal_gas') return 'material';
        if (nodeType === 'DetonatorLocation' || nodeType === 'DetonatorLocation3D' || portId === 'detonator') return 'detonator';
        if (nodeType === 'RemapNode' || nodeType === 'Remap1DTo2DNode' || nodeType === 'Remap1DTo3DNode' || nodeType === 'Remap2DTo3DNode' || portId === 'remap') return 'remap';
        if (nodeType === 'HardwareConfig' || portId === 'hardware') return 'hardware';
        if (portId === 'telemetry' || portId === 'mpm_in' || portId === 'in_2' || (portId === 'in' && (nodeType === 'TelemetryText' || nodeType === 'TelemetryGraph' || nodeType === 'TelemetryContour' || nodeType === 'Telemetry3DViewport'))) return 'telemetry';
        return 'material';
    }

    private getPortPosition(node: Node, portId: string, isInput: boolean): { x: number, y: number } | null {
        // compact, full-panel, and TelemetryText (all HORIZ modes) use representative bullets
        const useRepresentative = node.displayMode === 'compact' || node.displayMode === 'full-panel';
        const bulletId = useRepresentative
            ? (isInput ? `${this.panelId}-port-in-${node.id}-representative` : `${this.panelId}-port-out-${node.id}-representative`)
            : (isInput ? `${this.panelId}-port-in-${node.id}-${portId}` : `${this.panelId}-port-out-${node.id}-${portId}`);

        const bullet = document.getElementById(bulletId);
        if (bullet) {
            const rect = bullet.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;

                const ctm = this.svg.getScreenCTM();
                if (!ctm) return null;
                const pt = new DOMPoint(centerX, centerY);
                const worldPoint = pt.matrixTransform(ctm.inverse());
                return { x: worldPoint.x, y: worldPoint.y };
            }
        }

        // Fallback for hidden ports (e.g., full-panel mode)
        const el = this.nodeElements.get(node.id);
        const w = el ? el.offsetWidth : (node.width || 200);
        const h = el ? el.offsetHeight : (node.height || 100);

        const nodeOrient = node.orientation || 'HORIZ';
        if (nodeOrient === 'HORIZ') {
            return {
                x: node.x + (isInput ? 0 : w),
                y: node.y + h / 2
            };
        } else {
            return {
                x: node.x + w / 2,
                y: node.y + (isInput ? 0 : h)
            };
        }
    }

    private renderTelemetryContent(node: Node, container: HTMLElement): void {
        if (node.type === 'TelemetryText') {
            let body = container.querySelector('.node-body-text') as HTMLElement;
            if (!body) {
                body = document.createElement('div');
                body.className = 'node-body-text';
                body.style.flex = '1';
                body.style.minHeight = '0';
                container.appendChild(body);
            }
            const logs = this.stateManager.getTelemetry(node.id) || [];
            if (body.children.length !== logs.length) {
                body.innerHTML = '';
                logs.forEach((line: string) => {
                    const lineEl = document.createElement('div');
                    lineEl.className = 'log-line';
                    lineEl.textContent = line;
                    body.appendChild(lineEl);
                });
                body.scrollTop = body.scrollHeight;
            }
        } else if (node.type === 'TelemetryGraph') {
            // Channel metadata
            const CHANNELS: { label: string; color: string }[] = [
                { label: 'Pressure',        color: '#00f0ff' },
                { label: 'Density',         color: '#f0a000' },
                { label: 'Velocity',        color: '#a0f000' },
                { label: 'Int. Energy',     color: '#f000a0' },
                { label: 'Mass Fraction',   color: '#a000f0' },
            ];
            const currentChannel = Number(node.parameters?.telemetry_channel ?? 0);
            const currentStride = Number(node.parameters?.plot_stride ?? 1);
            const STRIDES = [
                { label: '1x', value: 1 },
                { label: '2x', value: 2 },
                { label: '5x', value: 5 },
                { label: '10x', value: 10 },
                { label: '20x', value: 20 },
                { label: '50x', value: 50 },
                { label: '100x', value: 100 }
            ];

            const ownerModel = this.stateManager.getAllModels().find(m => m.nodes.some(n => n.id === node.id));
            const modelNodes = ownerModel ? ownerModel.nodes : (this.stateManager.getCurrentState()?.nodes || []);
            const meshNode = modelNodes.find(n => n.type === 'DomainMesh');
            const is1D = (meshNode?.parameters?.dimension ?? '1D') === '1D';
            const domainRadius = Number(meshNode?.parameters?.domain_radius ?? 1.0);
            const xAxisMode = is1D ? (node.parameters?.x_axis_mode ?? 'radius') : 'cell_id';

            const worker = this.nodeWorkers.get(node.id);
            if (worker) {
                // Sync channel, colour, bounds, grid, and x-axis mode on every render pass
                worker.postMessage({
                    type: 'setConfig',
                    showAxes: node.displayMode === 'expanded',
                    channel: currentChannel,
                    color: node.parameters?.color ?? CHANNELS[currentChannel]?.color ?? '#00f0ff',
                    min: node.parameters?.min_y !== undefined ? Number(node.parameters.min_y) : 0,
                    max: node.parameters?.max_y !== undefined ? Number(node.parameters.max_y) : 1000000,
                    showGrid: node.parameters?.show_grid !== false,
                    xAxisMode: xAxisMode,
                    domainRadius: domainRadius
                });
            }

            if (!container.querySelector('canvas')) {
                // --- Channel/Rate selector bar ---
                const selectorBar = document.createElement('div');
                selectorBar.className = 'telemetry-channel-bar';
                
                const channelLabelSpan = document.createElement('span');
                channelLabelSpan.className = 'telemetry-channel-label';
                channelLabelSpan.textContent = 'Ch:';
                selectorBar.appendChild(channelLabelSpan);

                const select = this.createCustomDropdown(
                    CHANNELS.map((ch, idx) => ({ value: String(idx), label: ch.label })),
                    String(currentChannel),
                    (val) => {
                        const ch = parseInt(val, 10);
                        const newColor = CHANNELS[ch]?.color ?? '#00f0ff';
                        this.stateManager.updateNodeParametersInPlace(node.id, {
                            telemetry_channel: ch,
                            color: newColor
                        });
                    },
                    'telemetry-channel-select'
                );
                selectorBar.appendChild(select);

                const strideLabelSpan = document.createElement('span');
                strideLabelSpan.className = 'telemetry-channel-label';
                strideLabelSpan.style.marginLeft = '8px';
                strideLabelSpan.textContent = 'Rate:';
                selectorBar.appendChild(strideLabelSpan);

                const strideSelect = this.createCustomDropdown(
                    STRIDES.map(st => ({ value: String(st.value), label: st.label })),
                    String(currentStride),
                    (val) => {
                        const newStride = parseInt(val, 10);
                        this.stateManager.updateNodeParametersInPlace(node.id, {
                            plot_stride: newStride
                        });
                    },
                    'telemetry-stride-select'
                );
                selectorBar.appendChild(strideSelect);

                container.appendChild(selectorBar);

                // --- Graph canvas ---
                const graphBody = document.createElement('div');
                graphBody.className = 'node-body-graph';
                graphBody.style.flex = '1';
                container.appendChild(graphBody);

                const canvas = document.createElement('canvas');
                canvas.style.width = '100%';
                canvas.style.height = '100%';
                graphBody.appendChild(canvas);

                const newWorker = new Worker(new URL('./ChartWorker.ts', import.meta.url), { type: 'module' });
                this.nodeWorkers.set(node.id, newWorker);
                newWorker.onmessage = (e) => {
                    if (e.data.type === 'bounds') {
                        this.stateManager.updateNodeParametersInPlace(node.id, {
                            min_y: e.data.minY,
                            max_y: e.data.maxY
                        });
                    }
                };
                const offscreen = (canvas as any).transferControlToOffscreen();
                newWorker.postMessage({ type: 'init', canvas: offscreen }, [offscreen] as any);
                newWorker.postMessage({
                    type: 'setConfig',
                    channel: currentChannel,
                    color: node.parameters?.color ?? CHANNELS[currentChannel]?.color ?? '#00f0ff',
                    min: node.parameters?.min_y !== undefined ? Number(node.parameters.min_y) : 0,
                    max: node.parameters?.max_y !== undefined ? Number(node.parameters.max_y) : 1000000,
                    showGrid: node.parameters?.show_grid !== false,
                    showAxes: node.displayMode === 'expanded',
                    xAxisMode: xAxisMode,
                    domainRadius: domainRadius
                });

                requestAnimationFrame(() => {
                    newWorker.postMessage({
                        type: 'resize',
                        width: canvas.clientWidth || 300,
                        height: canvas.clientHeight || 150
                    });
                });

                const initialData = this.stateManager.getTelemetry(node.id);
                if (initialData) {
                    if (initialData instanceof ArrayBuffer) {
                        const bufferCopy = initialData.slice(0);
                        newWorker.postMessage(bufferCopy, [bufferCopy]);
                    } else {
                        const pressureData = initialData.data || initialData.telemetry;
                        if (pressureData && (Array.isArray(pressureData) || pressureData instanceof Float32Array)) {
                            newWorker.postMessage({ type: 'data', telemetry: pressureData });
                        }
                    }
                }
            } else {
                // Sync selector value if it was changed programmatically
                const select = container.querySelector('.telemetry-channel-select') as HTMLElement;
                if (select) {
                    const trigger = select.querySelector('.custom-select-trigger');
                    if (trigger) {
                        const currentOpt = CHANNELS[currentChannel];
                        if (currentOpt && trigger.textContent !== currentOpt.label) {
                            trigger.textContent = currentOpt.label;
                            select.querySelectorAll('.custom-select-option').forEach(opt => {
                                const optEl = opt as HTMLElement;
                                if (optEl.dataset.value === String(currentChannel)) {
                                    optEl.classList.add('selected');
                                } else {
                                    optEl.classList.remove('selected');
                                }
                            });
                        }
                    }
                }

                const strideSelect = container.querySelector('.telemetry-stride-select') as HTMLElement;
                if (strideSelect) {
                    const trigger = strideSelect.querySelector('.custom-select-trigger');
                    if (trigger) {
                        const currentOpt = STRIDES.find(st => st.value === currentStride);
                        if (currentOpt && trigger.textContent !== currentOpt.label) {
                            trigger.textContent = currentOpt.label;
                            strideSelect.querySelectorAll('.custom-select-option').forEach(opt => {
                                const optEl = opt as HTMLElement;
                                if (optEl.dataset.value === String(currentStride)) {
                                    optEl.classList.add('selected');
                                } else {
                                    optEl.classList.remove('selected');
                                }
                            });
                        }
                    }
                }
            }
        } else if (node.type === 'Telemetry3DViewport') {
            if (!container.querySelector('canvas')) {
                const existing = this.viewport3Ds.get(node.id);
                if (existing) {
                    existing.destroy();
                    this.viewport3Ds.delete(node.id);
                }
                container.innerHTML = '';
                container.style.padding = '0';
                container.style.overflow = 'hidden';
                const wrapper = document.createElement('div');
                wrapper.style.width = '100%';
                wrapper.style.height = '100%';
                wrapper.style.position = 'relative';
                container.appendChild(wrapper);

                const vp = new Telemetry3DViewport(wrapper, `vp-${node.id}`, this.stateManager, '-graph', node.id);
                this.viewport3Ds.set(node.id, vp);
            }
        } else if (node.type === 'TelemetryContour') {
            const state = this.stateManager.getCurrentState();
            const conns = state?.connections.filter(c => c.toNode === node.id) || [];
            const connectedSolvers = conns.map(c => state?.nodes.find(n => n.id === c.fromNode)).filter(Boolean);
            const hasMPM = connectedSolvers.some(n => n?.type === 'MPMDomain2D' || n?.type === 'FSICoupler2D');
            const hasCFD = connectedSolvers.some(n => n?.type === 'CFDSolver2D' || n?.type === 'FSICoupler2D') || connectedSolvers.length === 0;

            const CHANNELS: { label: string }[] = [];
            if (hasCFD) {
                CHANNELS.push(
                    { label: 'Pressure' },
                    { label: 'Density' },
                    { label: 'Radial Vel' },
                    { label: 'Axial Vel' },
                    { label: 'Spec Energy' },
                    { label: 'Burn Frac' },
                    { label: 'Unburnt Frac' }
                );
            }
            if (hasMPM) {
                CHANNELS.push(
                    { label: 'Von Mises Stress' },
                    { label: 'Plastic Strain' },
                    { label: 'Object ID' }
                );
            }
            if (CHANNELS.length === 0) {
                CHANNELS.push({ label: 'Pressure' }, { label: 'Density' }, { label: 'Velocity' });
            }
            const currentChannel = Number(node.parameters?.telemetry_channel ?? 0);
            const currentStride = Number(node.parameters?.downsample_stride ?? 1);
            const currentRate = Number(node.parameters?.refresh_rate ?? 0.0);

            const STRIDES = [
                { value: '1', label: '1x (Full)' },
                { value: '2', label: '2x' },
                { value: '3', label: '3x' },
                { value: '4', label: '4x' },
                { value: '5', label: '5x' },
                { value: '8', label: '8x' }
            ];

            const RATES = [
                { value: '0', label: 'Max FPS' },
                { value: '0.016', label: '60 FPS (0.016s)' },
                { value: '0.033', label: '30 FPS (0.033s)' },
                { value: '0.05', label: '20 FPS (0.05s)' },
                { value: '0.1', label: '10 FPS (0.1s)' },
                { value: '0.2', label: '5 FPS (0.2s)' },
                { value: '0.5', label: '2 FPS (0.5s)' },
                { value: '1.0', label: '1 FPS (1.0s)' },
                { value: '2.0', label: '0.5 FPS (2.0s)' },
                { value: '5.0', label: '0.2 FPS (5.0s)' },
                { value: '10.0', label: '0.1 FPS (10.0s)' }
            ];

            let isAxisymmetric = true;
            let chargeInfo = null;
            let detonatorInfo = null;
            let max_r = 1.0;
            let max_z = 1.0;
            let solverNode: any = null;
            let meshNode: any = null;
            if (state) {
                const conns = state.connections.filter(c => c.toNode === node.id);
                for (const c of conns) {
                    const candidate = state.nodes.find(n => n.id === c.fromNode);
                    if (candidate && (candidate.type === 'CFDSolver2D' || candidate.type === 'MPMDomain2D')) {
                        solverNode = candidate;
                        break;
                    }
                }
                if (!solverNode) {
                    solverNode = state.nodes.find(n => n.type === 'CFDSolver2D' || n.type === 'MPMDomain2D') || null;
                }

                if (solverNode) {
                    const ownerModel = this.stateManager.getAllModels().find(m => m.nodes.some(n => n.id === solverNode.id));
                    const modelNodes = ownerModel ? ownerModel.nodes : state.nodes;

                    const meshConn = state.connections.find(c => c.toNode === solverNode.id && c.toPort === 'mesh');
                    meshNode = meshConn ? modelNodes.find(n => n.id === meshConn.fromNode && n.type === 'DomainMesh2D') : null;
                    if (!meshNode) {
                        meshNode = modelNodes.find(n => n.type === 'DomainMesh2D') || null;
                    }
                    if (meshNode) {
                        isAxisymmetric = (meshNode.parameters?.coordinate_system ?? 'Axisymmetric') === 'Axisymmetric';
                    }

                    max_r = Number(meshNode?.parameters?.max_r ?? 1.0);
                    max_z = Number(meshNode?.parameters?.max_z ?? 1.0);

                    let chargeNode = null;
                    // 1. Direct connection to solver's 'charge' port
                    const solverChargeConn = state.connections.find(c => c.toNode === solverNode.id && c.toPort === 'charge');
                    chargeNode = solverChargeConn ? modelNodes.find(n => n.id === solverChargeConn.fromNode && n.type === 'Charge2D') : null;

                    // 2. Connection fallback for 2D
                    if (!chargeNode) {
                        chargeNode = modelNodes.find(n => n.type === 'Charge2D') || null;
                    }

                    if (chargeNode) {
                        chargeInfo = {
                            shape: chargeNode.parameters?.charge_shape ?? 'Sphere',
                            r: Number(chargeNode.parameters?.charge_r ?? 0.0),
                            z: Number(chargeNode.parameters?.charge_z ?? 0.0),
                            radius: Number(chargeNode.parameters?.charge_radius ?? 0.05),
                            height: Number(chargeNode.parameters?.charge_height ?? 0.1),
                            max_r: max_r,
                            max_z: max_z
                        };
                    } else {
                        // 3. Try to get charge geometry from Remapper
                        const remapConn = state.connections.find(c => c.toNode === solverNode.id && c.toPort === 'remap');
                        if (remapConn) {
                            const remapNode = state.nodes.find(n => n.id === remapConn.fromNode && (n.type === 'RemapNode' || n.type === 'Remap1DTo2DNode'));
                            if (remapNode) {
                                const ws = this.stateManager.getActiveWorkspace();
                                const wsConns = ws ? (ws.connections || []) : [];
                                const solver1DConn = wsConns.find(c => c.toNode === remapNode.id && c.toPort === 'in');

                                if (solver1DConn) {
                                    const allModels = this.stateManager.getAllModels();
                                    let solver1DNode = null;
                                    let model1D = null;
                                    for (const m of allModels) {
                                        const found = m.nodes.find(n => n.id === solver1DConn.fromNode && n.type === 'CFDSolver');
                                        if (found) {
                                            solver1DNode = found;
                                            model1D = m;
                                            break;
                                        }
                                    }

                                    if (solver1DNode && model1D) {
                                        const painterConn = model1D.connections.find(c => c.toNode === solver1DNode.id && c.toPort === 'in');
                                        const painterNode = painterConn ? model1D.nodes.find(n => n.id === painterConn.fromNode && n.type === 'ThePainter') : null;
                                        if (painterNode) {
                                            const charge1DConn = model1D.connections.find(c => c.toNode === painterNode.id && c.toPort === 'explosive');
                                            const charge1DNode = charge1DConn ? model1D.nodes.find(n => n.id === charge1DConn.fromNode && n.type === 'Charge1D') : null;
                                            if (charge1DNode) {
                                                chargeInfo = {
                                                    shape: 'Sphere', // 1D remapped into 2D is always a spherical boundary
                                                    r: Number(remapNode.parameters?.explosive_r ?? 0.0),
                                                    z: Number(remapNode.parameters?.explosive_z ?? 0.0),
                                                    radius: Number(charge1DNode.parameters?.charge_radius ?? 0.05),
                                                    height: 0.1, // N/A for Sphere
                                                    max_r: max_r,
                                                    max_z: max_z
                                                };
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    const detConn = state.connections.find(c => c.toNode === solverNode.id && c.toPort === 'detonator');
                    const detNode = detConn ? state.nodes.find(n => n.id === detConn.fromNode && n.type === 'DetonatorLocation') : null;
                    if (detNode) {
                        detonatorInfo = {
                            r: Number(detNode.parameters?.detonator_r ?? 0.0),
                            z: Number(detNode.parameters?.detonator_z ?? 0.0),
                            radius: Number(detNode.parameters?.detonator_radius ?? 0.001),
                            max_r: max_r,
                            max_z: max_z
                        };
                    }
                }
            }

            const COLORMAPS = [
                { value: 'plasma', label: 'Plasma' },
                { value: 'viridis', label: 'Viridis' },
                { value: 'rainbow', label: 'Rainbow' },
                { value: 'coolwarm', label: 'CoolWarm' },
                { value: 'cividis', label: 'Cividis' },
                { value: 'grayscale', label: 'Grayscale' }
            ];
            const currentColorMap = node.parameters?.colormap ?? 'plasma';
            const currentLogScale = node.parameters?.log_scale === true;
            const autoScale = node.parameters?.auto_scale !== false;
            const minY = node.parameters?.min_y !== undefined ? Number(node.parameters.min_y) : 0;
            const maxY = node.parameters?.max_y !== undefined ? Number(node.parameters.max_y) : 1;

            const worker = this.nodeWorkers.get(node.id);
            if (worker) {
                worker.postMessage({
                    type: 'setConfig',
                    channel: currentChannel,
                    stride: 1,
                    refreshRate: currentRate,
                    logScale: currentLogScale,
                    colormap: currentColorMap,
                    min: minY,
                    max: maxY,
                    isAxisymmetric: isAxisymmetric,
                    chargeInfo: (node.parameters?.show_charge !== false) ? chargeInfo : null,
                    detonatorInfo: (node.parameters?.show_detonator !== false) ? detonatorInfo : null,
                    showGridlines: node.parameters?.show_gridlines === true,
                    max_r: max_r,
                    max_z: max_z,
                    meshType: solverNode?.parameters?.mesh_type || 'regular',
                    amrMaxLevels: Math.max(1, Number(solverNode?.parameters?.amr_max_levels ?? 3)),
                    baseNr: meshNode ? (solverNode?.parameters?.mesh_type === 'amr' ? Math.ceil((Math.round(max_r / (Number(meshNode.parameters?.cell_size) || 0.05)) || 128) / 16) * 16 : (Math.round(max_r / (Number(meshNode.parameters?.cell_size) || 0.05)) || 128)) : 128,
                    baseNz: meshNode ? (solverNode?.parameters?.mesh_type === 'amr' ? Math.ceil((Math.round(max_z / (Number(meshNode.parameters?.cell_size) || 0.05)) || 128) / 16) * 16 : (Math.round(max_z / (Number(meshNode.parameters?.cell_size) || 0.05)) || 128)) : 128
                });
            }

            if (!container.querySelector('canvas')) {
                const selectorBar = document.createElement('div');
                selectorBar.className = 'telemetry-channel-bar';
                selectorBar.style.display = 'flex';
                selectorBar.style.flexWrap = 'nowrap';
                selectorBar.style.gap = '6px';
                selectorBar.style.alignItems = 'center';
                selectorBar.style.padding = '2px 8px';
                selectorBar.style.background = '#151520';
                selectorBar.style.borderBottom = '1px solid #222';
                selectorBar.style.flexShrink = '0';
                selectorBar.style.height = '24px';
                selectorBar.style.overflow = 'visible';

                // 1. Channel Select
                const chGroup = document.createElement('div');
                chGroup.style.display = 'flex';
                chGroup.style.alignItems = 'center';
                chGroup.style.gap = '3px';
                chGroup.style.flex = '1';
                chGroup.style.minWidth = '0';

                const labelSpan = document.createElement('span');
                labelSpan.className = 'telemetry-channel-label';
                labelSpan.textContent = 'Ch:';
                chGroup.appendChild(labelSpan);

                const select = this.createCustomDropdown(
                    CHANNELS.map((ch, idx) => ({ value: String(idx), label: ch.label })),
                    String(currentChannel),
                    (val) => {
                        const ch = parseInt(val, 10);
                        this.stateManager.updateNodeParametersInPlace(node.id, {
                            telemetry_channel: ch
                        });
                    },
                    'telemetry-channel-select'
                );
                chGroup.appendChild(select);
                selectorBar.appendChild(chGroup);

                // 2. Downsample (Stride) Select
                const strideGroup = document.createElement('div');
                strideGroup.style.display = 'flex';
                strideGroup.style.alignItems = 'center';
                strideGroup.style.gap = '3px';

                const strideLabel = document.createElement('span');
                strideLabel.className = 'telemetry-channel-label';
                strideLabel.textContent = 'Stride:';
                strideGroup.appendChild(strideLabel);

                const strideSelect = this.createCustomDropdown(
                    STRIDES,
                    String(currentStride),
                    (val) => {
                        const strideVal = parseInt(val, 10);
                        this.stateManager.updateNodeParametersInPlace(node.id, {
                            downsample_stride: strideVal
                        });
                        const net = (window as any).networkManager;
                        if (net && net.isConnected()) {
                            let targetModelId = node.id;
                            const models = this.stateManager.getAppState().models;
                            for (const [mid, m] of Object.entries(models)) {
                                if (m.nodes.some(n => n.id === node.id)) {
                                    targetModelId = mid;
                                    break;
                                }
                            }
                            net.send({
                                command: "CONTOUR_CONFIG",
                                modelId: targetModelId,
                                stride: strideVal,
                                refresh_rate: currentRate
                            });
                        }
                    },
                    'telemetry-stride-select'
                );
                strideGroup.appendChild(strideSelect);
                selectorBar.appendChild(strideGroup);

                // 3. Refresh Rate Select
                const rateGroup = document.createElement('div');
                rateGroup.style.display = 'flex';
                rateGroup.style.alignItems = 'center';
                rateGroup.style.gap = '3px';

                const rateLabel = document.createElement('span');
                rateLabel.className = 'telemetry-channel-label';
                rateLabel.textContent = 'Rate:';
                rateGroup.appendChild(rateLabel);

                const rateSelect = this.createCustomDropdown(
                    RATES,
                    String(currentRate),
                    (val) => {
                        const rateVal = parseFloat(val);
                        this.stateManager.updateNodeParametersInPlace(node.id, {
                            refresh_rate: rateVal
                        });
                        const net = (window as any).networkManager;
                        if (net && net.isConnected()) {
                            let targetModelId = node.id;
                            const models = this.stateManager.getAppState().models;
                            for (const [mid, m] of Object.entries(models)) {
                                if (m.nodes.some(n => n.id === node.id)) {
                                    targetModelId = mid;
                                    break;
                                }
                            }
                            net.send({
                                command: "CONTOUR_CONFIG",
                                modelId: targetModelId,
                                stride: currentStride,
                                refresh_rate: rateVal
                            });
                        }
                    },
                    'telemetry-rate-select'
                );
                rateGroup.appendChild(rateSelect);
                selectorBar.appendChild(rateGroup);

                // 4. Refresh Button
                const refreshBtn = document.createElement('button');
                refreshBtn.className = 'telemetry-refresh-btn';
                refreshBtn.innerHTML = '🔄';
                refreshBtn.title = 'Force Immediate Refresh';
                refreshBtn.style.padding = '2px 4px';
                refreshBtn.style.background = 'rgba(59, 130, 246, 0.2)';
                refreshBtn.style.border = '1px solid rgba(59, 130, 246, 0.5)';
                refreshBtn.style.borderRadius = '3px';
                refreshBtn.style.color = '#fff';
                refreshBtn.style.cursor = 'pointer';
                refreshBtn.style.fontSize = '10px';
                refreshBtn.style.height = '18px';
                refreshBtn.style.display = 'inline-flex';
                refreshBtn.style.alignItems = 'center';
                refreshBtn.style.justifyContent = 'center';

                refreshBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const w = this.nodeWorkers.get(node.id);
                    if (w) {
                        w.postMessage({ type: 'forceRender' });
                    }
                    const net = (window as any).networkManager;
                    if (net && net.isConnected()) {
                        let targetModelId = node.id;
                        const models = this.stateManager.getAppState().models;
                        for (const [mid, m] of Object.entries(models)) {
                            if (m.nodes.some(n => n.id === node.id)) {
                                targetModelId = mid;
                                break;
                            }
                        }
                        net.send({
                            command: "CONTOUR_REFRESH",
                            modelId: targetModelId
                        });
                    }
                });
                selectorBar.appendChild(refreshBtn);

                container.appendChild(selectorBar);

                // --- Bar 2: Visual Color & Scale controls [NEW] ---
                const scaleBar = document.createElement('div');
                scaleBar.className = 'telemetry-scale-bar';

                // Colormap Dropdown
                const mapGroup = document.createElement('div');
                mapGroup.style.display = 'flex';
                mapGroup.style.alignItems = 'center';
                mapGroup.style.gap = '3px';
                mapGroup.style.flex = '1';
                mapGroup.style.minWidth = '0';

                const mapLabel = document.createElement('span');
                mapLabel.className = 'telemetry-channel-label';
                mapLabel.textContent = 'Map:';
                mapGroup.appendChild(mapLabel);

                const mapSelect = this.createCustomDropdown(
                    COLORMAPS,
                    currentColorMap,
                    (val) => {
                        this.stateManager.updateNodeParametersInPlace(node.id, {
                            colormap: val
                        });
                    },
                    'telemetry-colormap-select'
                );
                mapGroup.appendChild(mapSelect);
                scaleBar.appendChild(mapGroup);

                // Log Checkbox
                const logGroup = document.createElement('label');
                logGroup.className = 'telemetry-log-checkbox-container';
                logGroup.textContent = 'Log:';

                const logCheckbox = document.createElement('input');
                logCheckbox.type = 'checkbox';
                logCheckbox.className = 'telemetry-log-checkbox';
                logCheckbox.checked = currentLogScale;
                logCheckbox.addEventListener('change', () => {
                    this.stateManager.updateNodeParametersInPlace(node.id, {
                        log_scale: logCheckbox.checked
                    });
                });
                logGroup.appendChild(logCheckbox);
                scaleBar.appendChild(logGroup);

                // Lock Scales Checkbox
                const lockGroup = document.createElement('label');
                lockGroup.className = 'telemetry-log-checkbox-container';
                lockGroup.textContent = 'Lock:';

                const lockCheckbox = document.createElement('input');
                lockCheckbox.type = 'checkbox';
                lockCheckbox.className = 'telemetry-lock-checkbox';
                lockCheckbox.checked = !autoScale;
                lockCheckbox.addEventListener('change', () => {
                    this.stateManager.updateNodeParametersInPlace(node.id, {
                        auto_scale: !lockCheckbox.checked
                    });
                });
                lockGroup.appendChild(lockCheckbox);
                scaleBar.appendChild(lockGroup);

                // Show Charge Checkbox [NEW]
                const showCharge = node.parameters?.show_charge !== false;
                const chargeToggleGroup = document.createElement('label');
                chargeToggleGroup.className = 'telemetry-log-checkbox-container';
                chargeToggleGroup.textContent = 'Charge:';

                const chargeCheckbox = document.createElement('input');
                chargeCheckbox.type = 'checkbox';
                chargeCheckbox.className = 'telemetry-charge-checkbox';
                chargeCheckbox.checked = showCharge;
                chargeCheckbox.addEventListener('change', () => {
                    this.stateManager.updateNodeParametersInPlace(node.id, {
                        show_charge: chargeCheckbox.checked
                    });
                });
                chargeToggleGroup.appendChild(chargeCheckbox);
                scaleBar.appendChild(chargeToggleGroup);

                // Show Detonator Checkbox [NEW]
                const showDetonator = node.parameters?.show_detonator !== false;
                const detToggleGroup = document.createElement('label');
                detToggleGroup.className = 'telemetry-log-checkbox-container';
                detToggleGroup.textContent = 'Det:';

                const detCheckbox = document.createElement('input');
                detCheckbox.type = 'checkbox';
                detCheckbox.className = 'telemetry-det-checkbox';
                detCheckbox.checked = showDetonator;
                detCheckbox.addEventListener('change', () => {
                    this.stateManager.updateNodeParametersInPlace(node.id, {
                        show_detonator: detCheckbox.checked
                    });
                });
                detToggleGroup.appendChild(detCheckbox);
                scaleBar.appendChild(detToggleGroup);

                // Show Grid Checkbox [NEW]
                const showGridlines = node.parameters?.show_gridlines === true;
                const gridToggleGroup = document.createElement('label');
                gridToggleGroup.className = 'telemetry-log-checkbox-container';
                gridToggleGroup.textContent = 'Grid:';

                const gridCheckbox = document.createElement('input');
                gridCheckbox.type = 'checkbox';
                gridCheckbox.className = 'telemetry-grid-checkbox';
                gridCheckbox.checked = showGridlines;
                gridCheckbox.addEventListener('change', () => {
                    this.stateManager.updateNodeParametersInPlace(node.id, {
                        show_gridlines: gridCheckbox.checked
                    });
                });
                gridToggleGroup.appendChild(gridCheckbox);
                scaleBar.appendChild(gridToggleGroup);

                // Smooth Checkbox [NEW]
                if (node.parameters && node.parameters.interpolate === undefined) {
                    node.parameters.interpolate = true;
                }
                const showSmooth = node.parameters?.interpolate !== false;
                const smoothToggleGroup = document.createElement('label');
                smoothToggleGroup.className = 'telemetry-log-checkbox-container';
                smoothToggleGroup.textContent = 'Smooth:';

                const smoothCheckbox = document.createElement('input');
                smoothCheckbox.type = 'checkbox';
                smoothCheckbox.className = 'telemetry-smooth-checkbox';
                smoothCheckbox.checked = showSmooth;
                smoothCheckbox.addEventListener('change', () => {
                    this.stateManager.updateNodeParametersInPlace(node.id, {
                        interpolate: smoothCheckbox.checked
                    });
                    const w = this.nodeWorkers.get(node.id);
                    if (w) {
                        w.postMessage({ type: 'setConfig', interpolate: smoothCheckbox.checked });
                    }
                });
                smoothToggleGroup.appendChild(smoothCheckbox);
                scaleBar.appendChild(smoothToggleGroup);

                // Min Text Entry
                const minLabel = document.createElement('span');
                minLabel.className = 'telemetry-channel-label';
                minLabel.textContent = 'Min:';
                scaleBar.appendChild(minLabel);

                const minInput = document.createElement('input');
                minInput.type = 'text';
                minInput.className = 'telemetry-range-input telemetry-min-input';
                minInput.value = minY.toExponential(2);
                minInput.disabled = autoScale;
                scaleBar.appendChild(minInput);

                // Max Text Entry
                const maxLabel = document.createElement('span');
                maxLabel.className = 'telemetry-channel-label';
                maxLabel.textContent = 'Max:';
                scaleBar.appendChild(maxLabel);

                const maxInput = document.createElement('input');
                maxInput.type = 'text';
                maxInput.className = 'telemetry-range-input telemetry-max-input';
                maxInput.value = maxY.toExponential(2);
                maxInput.disabled = autoScale;
                scaleBar.appendChild(maxInput);

                // Set Button
                const setBtn = document.createElement('button');
                setBtn.className = 'telemetry-set-btn';
                setBtn.textContent = 'Set';
                setBtn.title = 'Apply Manual Range & Lock Scales';

                const applyManualRange = () => {
                    const parsedMin = parseFloat(minInput.value);
                    const parsedMax = parseFloat(maxInput.value);
                    if (!isNaN(parsedMin) && !isNaN(parsedMax)) {
                        this.stateManager.updateNodeParametersInPlace(node.id, {
                            min_y: parsedMin,
                            max_y: parsedMax,
                            auto_scale: false
                        });
                    }
                };

                setBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    applyManualRange();
                });

                const handleKeydown = (e: KeyboardEvent) => {
                    if (e.key === 'Enter') {
                        e.stopPropagation();
                        applyManualRange();
                    }
                };
                minInput.addEventListener('keydown', handleKeydown);
                maxInput.addEventListener('keydown', handleKeydown);

                // Prevent propagation of mousedown/mouseup/click to avoid node dragging
                [
                    logCheckbox, logGroup, lockCheckbox, lockGroup,
                    chargeCheckbox, chargeToggleGroup, detCheckbox, detToggleGroup,
                    gridCheckbox, gridToggleGroup, smoothCheckbox, smoothToggleGroup,
                    minInput, maxInput, setBtn
                ].forEach(el => {
                    ['mousedown', 'mouseup', 'click'].forEach(evtType => {
                        el.addEventListener(evtType, (e) => e.stopPropagation());
                    });
                });

                scaleBar.appendChild(setBtn);
                container.appendChild(scaleBar);

                const graphBody = document.createElement('div');
                graphBody.className = 'node-body-graph';
                graphBody.style.flex = '1';
                container.appendChild(graphBody);

                const canvas = document.createElement('canvas');
                canvas.style.width = '100%';
                canvas.style.height = '100%';
                graphBody.appendChild(canvas);

                // Interactive Pan, Zoom, Click-to-Focus event handlers on the Canvas
                let lastX = 0;
                let lastY = 0;
                let startX = 0;
                let startY = 0;

                canvas.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                });

                canvas.addEventListener('mousedown', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    lastX = e.clientX;
                    lastY = e.clientY;
                    startX = e.clientX;
                    startY = e.clientY;

                    const onMouseMove = (me: MouseEvent) => {
                        const dx = (me.clientX - lastX) / this.zoom;
                        const dy = (me.clientY - lastY) / this.zoom;
                        lastX = me.clientX;
                        lastY = me.clientY;
                        const worker = this.nodeWorkers.get(node.id);
                        if (worker) {
                            worker.postMessage({ type: 'pan', dx, dy });
                        }
                    };

                    const onMouseUp = () => {
                        window.removeEventListener('mousemove', onMouseMove);
                        window.removeEventListener('mouseup', onMouseUp);
                    };

                    window.addEventListener('mousemove', onMouseMove);
                    window.addEventListener('mouseup', onMouseUp);
                });

                canvas.addEventListener('wheel', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const rect = canvas.getBoundingClientRect();
                    const mx = e.clientX - rect.left;
                    const my = e.clientY - rect.top;
                    const worker = this.nodeWorkers.get(node.id);
                    if (worker) {
                        worker.postMessage({ type: 'zoom', deltaY: e.deltaY, mx, my });
                    }
                }, { passive: false });

                canvas.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
                    if (dist > 5) {
                        return; // Ignore click events fired at the end of a drag pan
                    }
                    const rect = canvas.getBoundingClientRect();
                    const mx = e.clientX - rect.left;
                    const my = e.clientY - rect.top;
                    const worker = this.nodeWorkers.get(node.id);
                    if (worker) {
                        worker.postMessage({ type: 'clickFocus', mx, my });
                    }
                });

                canvas.addEventListener('dblclick', (e) => {
                    e.stopPropagation();
                    const worker = this.nodeWorkers.get(node.id);
                    if (worker) {
                        worker.postMessage({ type: 'resetView' });
                    }
                });

                const newWorker = new Worker(new URL('./ContourWorker.ts', import.meta.url), { type: 'module' });
                this.nodeWorkers.set(node.id, newWorker);
                
                newWorker.onmessage = (e) => {
                    if (e.data.type === 'bounds') {
                        this.stateManager.updateNodeParametersInPlace(node.id, {
                            min_y: e.data.minY,
                            max_y: e.data.maxY
                        });
                    }
                };

                const offscreen = (canvas as any).transferControlToOffscreen();
                newWorker.postMessage({ type: 'init', canvas: offscreen }, [offscreen] as any);
                newWorker.postMessage({
                    type: 'setConfig',
                    channel: currentChannel,
                    stride: 1,
                    refreshRate: currentRate,
                    logScale: currentLogScale,
                    colormap: currentColorMap,
                    min: minY,
                    max: maxY,
                    isAxisymmetric: isAxisymmetric,
                    chargeInfo: (node.parameters?.show_charge !== false) ? chargeInfo : null,
                    detonatorInfo: (node.parameters?.show_detonator !== false) ? detonatorInfo : null,
                    showGridlines: node.parameters?.show_gridlines === true,
                    interpolate: node.parameters?.interpolate !== false,
                    max_r: max_r,
                    max_z: max_z,
                    meshType: solverNode?.parameters?.mesh_type || 'regular',
                    amrMaxLevels: Math.max(1, Number(solverNode?.parameters?.amr_max_levels ?? 3)),
                    baseNr: meshNode ? (solverNode?.parameters?.mesh_type === 'amr' ? Math.ceil((Math.round(max_r / (Number(meshNode.parameters?.cell_size) || 0.05)) || 128) / 16) * 16 : (Math.round(max_r / (Number(meshNode.parameters?.cell_size) || 0.05)) || 128)) : 128,
                    baseNz: meshNode ? (solverNode?.parameters?.mesh_type === 'amr' ? Math.ceil((Math.round(max_z / (Number(meshNode.parameters?.cell_size) || 0.05)) || 128) / 16) * 16 : (Math.round(max_z / (Number(meshNode.parameters?.cell_size) || 0.05)) || 128)) : 128
                });

                requestAnimationFrame(() => {
                    newWorker.postMessage({
                        type: 'resize',
                        width: canvas.clientWidth || 300,
                        height: canvas.clientHeight || 200
                    });
                });

                const initialData = this.stateManager.getTelemetry(node.id);
                if (initialData && initialData instanceof ArrayBuffer) {
                    const bufferCopy = initialData.slice(0);
                    newWorker.postMessage(bufferCopy, [bufferCopy]);
                }
            } else {
                const select = container.querySelector('.telemetry-channel-select') as HTMLElement;
                if (select) {
                    const trigger = select.querySelector('.custom-select-trigger');
                    if (trigger) {
                        const currentOpt = CHANNELS[currentChannel];
                        if (currentOpt && trigger.textContent !== currentOpt.label) {
                            trigger.textContent = currentOpt.label;
                            select.querySelectorAll('.custom-select-option').forEach(opt => {
                                const optEl = opt as HTMLElement;
                                if (optEl.dataset.value === String(currentChannel)) {
                                    optEl.classList.add('selected');
                                } else {
                                    optEl.classList.remove('selected');
                                }
                            });
                        }
                    }
                }

                const strideSel = container.querySelector('.telemetry-stride-select') as HTMLElement;
                if (strideSel) {
                    const trigger = strideSel.querySelector('.custom-select-trigger');
                    if (trigger) {
                        const currentOpt = STRIDES.find(opt => opt.value === String(currentStride));
                        if (currentOpt && trigger.textContent !== currentOpt.label) {
                            trigger.textContent = currentOpt.label;
                            strideSel.querySelectorAll('.custom-select-option').forEach(opt => {
                                const optEl = opt as HTMLElement;
                                if (optEl.dataset.value === String(currentStride)) {
                                    optEl.classList.add('selected');
                                } else {
                                    optEl.classList.remove('selected');
                                }
                            });
                        }
                    }
                }

                const rateSel = container.querySelector('.telemetry-rate-select') as HTMLElement;
                if (rateSel) {
                    const trigger = rateSel.querySelector('.custom-select-trigger');
                    if (trigger) {
                        const currentOpt = RATES.find(opt => opt.value === String(currentRate));
                        if (currentOpt && trigger.textContent !== currentOpt.label) {
                            trigger.textContent = currentOpt.label;
                            rateSel.querySelectorAll('.custom-select-option').forEach(opt => {
                                const optEl = opt as HTMLElement;
                                if (optEl.dataset.value === String(currentRate)) {
                                    optEl.classList.add('selected');
                                } else {
                                    optEl.classList.remove('selected');
                                }
                            });
                        }
                    }
                }

                const colormapSel = container.querySelector('.telemetry-colormap-select') as HTMLElement;
                if (colormapSel) {
                    const trigger = colormapSel.querySelector('.custom-select-trigger');
                    if (trigger) {
                        const currentOpt = COLORMAPS.find(opt => opt.value === currentColorMap);
                        if (currentOpt && trigger.textContent !== currentOpt.label) {
                            trigger.textContent = currentOpt.label;
                            colormapSel.querySelectorAll('.custom-select-option').forEach(opt => {
                                const optEl = opt as HTMLElement;
                                if (optEl.dataset.value === currentColorMap) {
                                    optEl.classList.add('selected');
                                } else {
                                    optEl.classList.remove('selected');
                                }
                            });
                        }
                    }
                }

                const logCheckbox = container.querySelector('.telemetry-log-checkbox') as HTMLInputElement;
                if (logCheckbox) {
                    if (logCheckbox.checked !== currentLogScale) {
                        logCheckbox.checked = currentLogScale;
                    }
                }

                const lockCheckbox = container.querySelector('.telemetry-lock-checkbox') as HTMLInputElement;
                if (lockCheckbox) {
                    if (lockCheckbox.checked !== !autoScale) {
                        lockCheckbox.checked = !autoScale;
                    }
                }

                const minInput = container.querySelector('.telemetry-min-input') as HTMLInputElement;
                if (minInput) {
                    minInput.disabled = autoScale;
                    if (document.activeElement !== minInput) {
                        const expectedVal = minY.toExponential(2);
                        if (minInput.value !== expectedVal) {
                            minInput.value = expectedVal;
                        }
                    }
                }

                const maxInput = container.querySelector('.telemetry-max-input') as HTMLInputElement;
                if (maxInput) {
                    maxInput.disabled = autoScale;
                    if (document.activeElement !== maxInput) {
                        const expectedVal = maxY.toExponential(2);
                        if (maxInput.value !== expectedVal) {
                            maxInput.value = expectedVal;
                        }
                    }
                }

                const chargeCheckbox = container.querySelector('.telemetry-charge-checkbox') as HTMLInputElement;
                if (chargeCheckbox) {
                    const expected = node.parameters?.show_charge !== false;
                    if (chargeCheckbox.checked !== expected) {
                        chargeCheckbox.checked = expected;
                    }
                }

                const detCheckbox = container.querySelector('.telemetry-det-checkbox') as HTMLInputElement;
                if (detCheckbox) {
                    const expected = node.parameters?.show_detonator !== false;
                    if (detCheckbox.checked !== expected) {
                        detCheckbox.checked = expected;
                    }
                }

                const gridCheckbox = container.querySelector('.telemetry-grid-checkbox') as HTMLInputElement;
                if (gridCheckbox) {
                    const expected = node.parameters?.show_gridlines === true;
                    if (gridCheckbox.checked !== expected) {
                        gridCheckbox.checked = expected;
                    }
                }
            }
        }
    }

    private renderNodeParameters(node: Node, container: HTMLElement): void {
        if (node.type === 'TelemetryGraph' || node.type === 'TelemetryContour' || node.type === 'Telemetry3DViewport') {
            const form = container.querySelector('.node-params-form');
            if (form) form.remove();
            return;
        }
        if (node.type === 'PrimitiveGeometry3D') {
            this.renderPrimitiveGeometryNodeCanvasEditor(node, container);
            return;
        }
        container.style.overflow = 'visible';
        let form = container.querySelector('.node-params-form') as HTMLFormElement;
        if (form) {
            let needsRebuild = false;
            if (node.type === 'DomainMesh') {
                const dim = node.parameters['dimension'] || '1D';
                if (form.dataset.renderedDimension !== dim.toString()) {
                    needsRebuild = true;
                }
            }
            if (node.type === 'Material') {
                const comp = node.parameters['composition'] || 'TNT';
                const matType = node.parameters['material_type'] || 'Air';
                if (form.dataset.renderedComposition !== comp.toString() || form.dataset.renderedMaterialType !== matType.toString()) {
                    needsRebuild = true;
                }
            }
            if (!needsRebuild) {
                for (const [key, value] of Object.entries(node.parameters)) {
                    const el = form.querySelector(`[data-key="${key}"]`) as HTMLElement;
                    if (el) {
                        if (el.classList.contains('custom-select-container')) {
                            const trigger = el.querySelector('.custom-select-trigger');
                            if (trigger) {
                                trigger.textContent = value.toString();
                            }
                            el.querySelectorAll('.custom-select-option').forEach(opt => {
                                const optEl = opt as HTMLElement;
                                if (optEl.dataset.value === value.toString()) {
                                    optEl.classList.add('selected');
                                } else {
                                    optEl.classList.remove('selected');
                                }
                            });
                        } else {
                            const input = el as HTMLInputElement;
                            if (document.activeElement !== input) {
                                input.value = typeof value === 'number' ? parseFloat(value.toPrecision(7)).toString() : value.toString();
                            }
                        }
                    }
                }

                const stsEl = form.querySelector('[data-key="space_time_scheme"]') as HTMLElement;
                if (stsEl) {
                    const so = node.parameters['spatial_order'] ?? 2;
                    const to = node.parameters['temporal_order'] ?? 2;
                    let currentVal = 'RK2 (2nd-Order Space/Time)';
                    if (so === 1 && to === 1) currentVal = 'Euler (1st-Order Space/Time)';
                    else if (so === 2 && to === 2) currentVal = 'RK2 (2nd-Order Space/Time)';
                    else if (so === 3 && to === 3) currentVal = 'RK3 (3rd-Order Space/Time)';
                    else if (so === 2 && to === 4) currentVal = 'MUSCL-Hancock (2nd-Order Space/Time)';
                    else if (so === 2 && to === 5) currentVal = 'ADER-2 (2nd-Order Space/Time)';
                    else if (so === 3 && to === 6) currentVal = 'ADER-3 (3rd-Order Space/Time)';
                    
                    const trigger = stsEl.querySelector('.custom-select-trigger');
                    if (trigger) {
                        trigger.textContent = currentVal;
                    }
                    stsEl.querySelectorAll('.custom-select-option').forEach(opt => {
                        const optEl = opt as HTMLElement;
                        if (optEl.dataset.value === currentVal) {
                            optEl.classList.add('selected');
                        } else {
                            optEl.classList.remove('selected');
                        }
                    });
                }

                const gridInfo = form.querySelector('.grid-info-display') as HTMLDivElement;
                if (gridInfo) {
                    const state = this.stateManager.getCurrentState();
                    gridInfo.innerHTML = getMeshDisplayHTML(node, state ?? undefined);
                }
                return;
            }
        }

        container.innerHTML = '';
        form = document.createElement('form');
        form.className = 'node-params-form';
        form.style.padding = '4px 8px';
        form.onsubmit = (e) => e.preventDefault();

        if (node.type === 'DomainMesh') {
            const dim = node.parameters['dimension'] || '1D';
            form.dataset.renderedDimension = dim.toString();
        }
        if (node.type === 'Material') {
            const comp = node.parameters['composition'] || 'TNT';
            const matType = node.parameters['material_type'] || 'Air';
            form.dataset.renderedComposition = comp.toString();
            form.dataset.renderedMaterialType = matType.toString();
        }

        let paramKeys = Object.keys(node.parameters);
        if (node.type === 'CFDSolver3D' || node.type === 'CFDSolver2D') {
            paramKeys = paramKeys.filter(k => k !== 'spatial_order' && k !== 'temporal_order');
            const idx = Object.keys(node.parameters).indexOf('spatial_order');
            if (idx !== -1) {
                paramKeys.splice(idx, 0, 'space_time_scheme');
            } else {
                paramKeys.push('space_time_scheme');
            }
        }
        if (node.type === 'DomainMesh' || node.type === 'DomainMesh2D' || node.type === 'DomainMesh3D' || node.type === 'RefinementMesh3D') {
            paramKeys.sort((a, b) => {
                if (a === 'cell_size') return -1;
                if (b === 'cell_size') return 1;
                return 0;
            });
        } else if (node.type === 'Charge1D' || node.type === 'Charge2D' || node.type === 'Charge3D') {
            paramKeys.sort((a, b) => {
                if (a === 'charge_mass') return -1;
                if (b === 'charge_mass') return 1;
                return 0;
            });
        }
        
        let gridInfoDiv: HTMLDivElement | null = null;
        if (node.type === 'DomainMesh' || node.type === 'DomainMesh2D' || node.type === 'DomainMesh3D' || node.type === 'RefinementMesh3D') {
            const state = this.stateManager.getCurrentState();
            const info = document.createElement('div');
            info.className = 'grid-info-display';
            info.style.fontSize = 'var(--font-xs)';
            info.style.color = '#569cd6';
            info.style.marginTop = '6px';
            info.style.lineHeight = '1.3';
            info.innerHTML = getMeshDisplayHTML(node, state ?? undefined);
            gridInfoDiv = info;
        }

        const state = this.stateManager.getCurrentState();
        const conn = state?.connections.find(c => c.toNode === node.id);
        const sourceNode = conn ? state?.nodes.find(n => n.id === conn.fromNode) : null;
        const is3D = sourceNode 
            ? (sourceNode.type === 'CFDSolver3D') 
            : (state?.nodes.some(n => n.type === 'CFDSolver3D' || n.type === 'DomainMesh3D') ?? false);

        for (const key of paramKeys) {
            let value = node.parameters[key];
            if (key === 'space_time_scheme') {
                const so = node.parameters['spatial_order'] ?? 2;
                const to = node.parameters['temporal_order'] ?? 2;
                if (so === 1 && to === 1) value = 'Euler (1st-Order Space/Time)';
                else if (so === 2 && to === 2) value = 'RK2 (2nd-Order Space/Time)';
                else if (so === 3 && to === 3) value = 'RK3 (3rd-Order Space/Time)';
                else if (so === 2 && to === 4) value = 'MUSCL-Hancock (2nd-Order Space/Time)';
                else if (so === 2 && to === 5) value = 'ADER-2 (2nd-Order Space/Time)';
                else if (so === 3 && to === 6) value = 'ADER-3 (3rd-Order Space/Time)';
                else value = 'RK2 (2nd-Order Space/Time)';
            }
            if (key === 'gauges' || key === 'slices' || key === 'primitives') continue;
            if (key === 'nr' || key === 'nz' || key === 'n_cells') continue;
            if (node.type === 'CFDSolver3D' && (key === 'mesh_type' || key === 'amr_max_levels' || key === 'amr_threshold' || key === 'amr_coarsen_ratio' || key === 'amr_tile_size')) continue;
            if (node.type === 'VTKOutput' && !is3D && (key === 'export_slices' || key === 'export_volumes')) continue;
            if (node.type === 'VirtualGauges' && key === 'telemetry_channel') continue;
            // DetonatorLocation and DetonatorLocation3D are separate nodes now, showing correct properties
            if (node.type === 'DomainMesh') {
                const dim = node.parameters['dimension'] || '1D';
                if ((key === 'y_min_bc' || key === 'y_max_bc') && dim === '1D') continue;
                if ((key === 'z_min_bc' || key === 'z_max_bc') && (dim === '1D' || dim === '2D')) continue;
            }
            if (node.type === 'Material') {
                const matType = node.parameters['material_type'] || 'Air';
                if (matType === 'Air') {
                    const airKeys = ['material_type', 'atm_pressure', 'atm_temperature', 'gamma'];
                    if (!airKeys.includes(key)) continue;
                } else if (matType === 'JWL Charge') {
                    const jwlKeys = ['material_type', 'composition', 'rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'];
                    if (!jwlKeys.includes(key)) continue;
                } else if (matType === 'Ideal Gas Charge') {
                    const igKeys = ['material_type', 'composition', 'ideal_rho_0', 'ideal_e_0'];
                    if (!igKeys.includes(key)) continue;
                }
            }
            if (node.type === 'Charge2D' || node.type === 'Charge1D') {
                const shape = node.parameters['charge_shape'] || 'Sphere';
                if (key === 'charge_height' && shape !== 'Cylinder') continue;
            }
            if (node.type === 'Charge3D') {
                const shape = node.parameters['charge_shape'] || 'Sphere';
                if (shape === 'Sphere') {
                    if (key === 'charge_height' || key === 'charge_lx' || key === 'charge_ly' || key === 'charge_lz') continue;
                } else if (shape === 'Cylinder') {
                    if (key === 'charge_lx' || key === 'charge_ly' || key === 'charge_lz') continue;
                } else if (shape === 'Block') {
                    if (key === 'charge_radius' || key === 'charge_height') continue;
                }
            }

            const row = document.createElement('div');
            row.style.marginBottom = '4px';
            row.style.display = 'flex';
            row.style.flexDirection = 'column';

            const label = document.createElement('label');
            label.style.fontSize = 'var(--font-xs)';
            label.style.color = '#888';
            label.textContent = key.replace(/_/g, ' ').toUpperCase();
            row.appendChild(label);

            const dropdowns: Record<string, string[]> = {
                'mesh_type': ['regular', 'amr'],
                'dimension': ['1D', '2D', '3D'],
                'x_min_bc': ['Reflecting', 'Transmitting', 'Terminate'],
                'x_max_bc': ['Reflecting', 'Transmitting', 'Terminate'],
                'y_min_bc': ['Reflecting', 'Transmitting', 'Terminate'],
                'y_max_bc': ['Reflecting', 'Transmitting', 'Terminate'],
                'z_min_bc': ['Reflecting', 'Transmitting', 'Terminate'],
                'z_max_bc': ['Reflecting', 'Transmitting', 'Terminate'],
                'left_bc': ['Reflecting', 'Transmitting', 'Terminate'],
                'right_bc': ['Reflecting', 'Transmitting', 'Terminate'],
                'bc_x_min': ['Reflecting', 'Transmitting', 'Terminate'],
                'bc_x_max': ['Reflecting', 'Transmitting', 'Terminate'],
                'bc_y_min': ['Reflecting', 'Transmitting', 'Terminate'],
                'bc_y_max': ['Reflecting', 'Transmitting', 'Terminate'],
                'bc_r_min': ['Reflecting', 'Transmitting', 'Terminate'],
                'bc_r_max': ['Reflecting', 'Transmitting', 'Terminate'],
                'bc_z_min': ['Reflecting', 'Transmitting', 'Terminate'],
                'bc_z_max': ['Reflecting', 'Transmitting', 'Terminate'],
                'coordinate_system': ['Axisymmetric', 'Cartesian'],
                'telemetry_mode': ['Enabled', 'Throttled (1 Hz)', 'Throttled (0.2 Hz)', 'Disabled'],
                'enable_gauges': ['Enabled', 'Disabled'],
                'enable_vtk': ['Disabled', 'Enabled'],
                'device': ['cpu', 'cuda'],
                'precision': ['double', 'single'],
                'trigger_type': ['end', 'time', 'step'],
                // Explosive composition — JWL parameter sets (Ideal Gas uses its own node)
                'composition': ['Aluminized ANFO', 'Ammonal', 'ANFO', 'Baratol', 'C-4', 'Composition A-3', 'Composition B', 'Composition C-3', 'Cyclotol', 'Heavy ANFO', 'HMX', 'LX-04', 'LX-07', 'LX-10', 'LX-14', 'LX-17', 'Mining Emulsion', 'Octol', 'PBX 9404', 'PBX 9501', 'PBX 9502', 'PE-10', 'PE-12', 'PE-4', 'PE-8', 'Pentolite', 'PETN', 'RDX', 'TATB', 'Tetryl', 'TNT', 'Water Gel', 'Custom'],
                'init_mode': node.type === 'CFDSolver3D' ? ['From1D', 'From2D', 'Multi-Material JWL', 'Ideal Gas'] : ['From1D', 'Multi-Material JWL', 'Ideal Gas'],
                'flux_scheme': ['AUSM+', 'Rusanov'],
                'spatial_order': ['1', '2', '3'],
                'temporal_order': ['1', '2', '3'],
                'plot_stride': ['1', '2', '5', '10', '20', '50', '100'],
                charge_shape: node.type === 'Charge3D' ? ['Sphere', 'Cylinder', 'Block'] : ['Sphere', 'Cylinder'],
                material_type: ['Air', 'JWL Charge', 'Ideal Gas Charge'],
                colormap: ['plasma', 'viridis'],
                auto_scale: ['true', 'false'],
                log_scale: ['true', 'false'],
                show_grid: ['true', 'false'],
                'voxelization_method': ['watertight_floodfill', 'watertight_raycast', 'thin_shell', 'winding_number'],
                'obstacles_quantity': ['pressure', 'density', 'velocity', 'energy', 'species1', 'species2', 'species3', 'peak_overpressure', 'peak_impulse'],
                'transfer_scheme': ['GIMP', 'Standard'],
                'velocity_scheme': ['APIC', 'PIC', 'FLIP'],
                'shape_type': ['Rectangle', 'Circle'],
                'coupling_mode': ['TwoWay_Full', 'OneWay_CFD_to_MPM', 'Disabled'],
                'contour_quantity': ['von_mises', 'plastic_strain', 'density', 'velocity', 'pressure'],
                'color_map': ['viridis', 'plasma', 'jet', 'coolwarm'],
                'space_time_scheme': [
                    'Euler (1st-Order Space/Time)',
                    'RK2 (2nd-Order Space/Time)',
                    'RK3 (3rd-Order Space/Time)',
                    'MUSCL-Hancock (2nd-Order Space/Time)',
                    'ADER-2 (2nd-Order Space/Time)',
                    'ADER-3 (3rd-Order Space/Time)'
                ]
            };

            let inputEl: HTMLElement;
            if (typeof value === 'boolean') {
                inputEl = this.createCustomDropdown(
                    [
                        { value: 'true', label: 'True' },
                        { value: 'false', label: 'False' }
                    ],
                    value ? 'true' : 'false',
                    (newVal) => {
                        this.stateManager.updateNodeParameters(node.id, { [key]: newVal === 'true' });
                    },
                    key
                );
            } else if (dropdowns[key]) {
                inputEl = this.createCustomDropdown(
                    dropdowns[key].map(opt => ({ value: opt, label: opt })),
                    value.toString(),
                    (newVal) => {
                        console.log("[DEBUG] Custom Dropdown onChange triggered:", key, newVal, "for node:", node.id);
                        if (key === 'space_time_scheme') {
                            let s_order = 2;
                            let t_order = 2;
                            if (newVal === 'Euler (1st-Order Space/Time)') { s_order = 1; t_order = 1; }
                            else if (newVal === 'RK2 (2nd-Order Space/Time)') { s_order = 2; t_order = 2; }
                            else if (newVal === 'RK3 (3rd-Order Space/Time)') { s_order = 3; t_order = 3; }
                            else if (newVal === 'MUSCL-Hancock (2nd-Order Space/Time)') { s_order = 2; t_order = 4; }
                            else if (newVal === 'ADER-2 (2nd-Order Space/Time)') { s_order = 2; t_order = 5; }
                            else if (newVal === 'ADER-3 (3rd-Order Space/Time)') { s_order = 3; t_order = 6; }
                            
                            this.stateManager.updateNodeParameters(node.id, {
                                spatial_order: s_order,
                                temporal_order: t_order
                            });
                            return;
                        }
                        const numericKeys = [
                            'domain_radius', 'cell_size', 'atm_pressure', 'atm_temperature',
                            'charge_mass', 'rho', 'detonation_energy', 'jwl_A', 'jwl_B',
                            'jwl_R1', 'jwl_R2', 'jwl_omega', 'det_vel', 'cfl',
                            'spatial_order', 'temporal_order', 'gamma', 'plot_stride', 'refresh_rate',
                            'ascii_precision', 'step_interval', 'time_interval', 'downsample_stride',
                            'telemetry_channel', 'telemetry_interval_ms', 'vtk_step_interval',
                            // 2D CFD keys
                            'nr', 'nz', 'max_r', 'max_z', 'explosive_x', 'explosive_y', 'explosive_z', 'explosive_radius', 'remap_radius', 'explosive_r', 'trigger_val',
                            'charge_r', 'charge_z', 'charge_radius', 'charge_height',
                            'detonator_r', 'detonator_z', 'detonator_radius', 'detonator_x', 'detonator_y',
                            'ideal_gamma', 'ideal_rho_0', 'ideal_e_0',
                            // 3D CFD keys
                            'nx', 'ny', 'nz', 'xmax', 'ymax', 'zmax',
                            'charge_x', 'charge_y', 'charge_z', 'charge_lx', 'charge_ly', 'charge_lz',
                            'detonator_x', 'detonator_y', 'detonator_z', 'xmin', 'ymin', 'zmin',
                            'min_y', 'max_y', 'min_val', 'max_val', 'stl_min_val', 'stl_max_val', 'obstacles_min_val', 'obstacles_max_val', 'ambientLevel', 'specularIntensity', 'gauge_size', 'gauge_opacity', 'stl_opacity', 'obstacles_opacity', 'grid_opacity',
                            'refinement_opacity', 'charge_opacity',
                            'amr_max_levels', 'amr_threshold', 'amr_coarsen_ratio', 'amr_tile_size',
                            'center_x', 'center_y', 'center_z', 'size_x', 'size_y', 'size_z', 'radius', 'height', 'refinement_level',
                            'submesh_x', 'submesh_y', 'submesh_z', 'submesh_size_x', 'submesh_size_y', 'submesh_size_z',
                            // MPM keys
                            'pos_x', 'pos_y', 'vel_x', 'vel_y', 'radius', 'angular_vel',
                            'density', 'youngs_modulus', 'poissons_ratio', 'yield_stress', 'hardening_modulus',
                            'failure_strain', 'tensile_failure_stress',
                            'ppc', 'time_step', 'penalty_stiffness', 'contour_opacity', 'contour_min', 'contour_max'
                        ];
                        let castValue: any = newVal;
                        if (numericKeys.includes(key)) {
                            castValue = Number(newVal);
                        } else if (newVal === 'true') {
                            castValue = true;
                        } else if (newVal === 'false') {
                            castValue = false;
                        }
                        const updates: Record<string, any> = { [key]: castValue };
                        if (node.type === 'Material' && key === 'composition') {
                             const EXPLOSIVE_PRESETS: Record<string, Record<string, number>> = {
                                'Aluminized ANFO': {
                                    rho: 1050,
                                    detonation_energy: 4100000,
                                    det_vel: 4900,
                                    jwl_A: 76.5e9,
                                    jwl_B: 1.85e9,
                                    jwl_R1: 4.15,
                                    jwl_R2: 1.15,
                                    jwl_omega: 0.30
                                },
                                'Ammonal': {
                                    rho: 1600,
                                    detonation_energy: 4400000,
                                    det_vel: 5400,
                                    jwl_A: 125.0e9,
                                    jwl_B: 2.5e9,
                                    jwl_R1: 4.0,
                                    jwl_R2: 1.0,
                                    jwl_omega: 0.25
                                },
                                'ANFO': {
                                    rho: 930,
                                    detonation_energy: 3700000,
                                    det_vel: 4700,
                                    jwl_A: 49.46e9,
                                    jwl_B: 1.891e9,
                                    jwl_R1: 4.10,
                                    jwl_R2: 1.15,
                                    jwl_omega: 0.33
                                },
                                'Baratol': {
                                    rho: 2550,
                                    detonation_energy: 2800000,
                                    det_vel: 4900,
                                    jwl_A: 289.4e9,
                                    jwl_B: 5.14e9,
                                    jwl_R1: 4.4,
                                    jwl_R2: 1.2,
                                    jwl_omega: 0.25
                                },
                                'C-4': {
                                    rho: 1601,
                                    detonation_energy: 5600000,
                                    det_vel: 8040,
                                    jwl_A: 593.7e9,
                                    jwl_B: 12.87e9,
                                    jwl_R1: 4.5,
                                    jwl_R2: 1.2,
                                    jwl_omega: 0.38
                                },
                                'Composition A-3': {
                                    rho: 1650,
                                    detonation_energy: 5000000,
                                    det_vel: 8100,
                                    jwl_A: 601.5e9,
                                    jwl_B: 12.0e9,
                                    jwl_R1: 4.5,
                                    jwl_R2: 1.2,
                                    jwl_omega: 0.35
                                },
                                'Composition B': {
                                    rho: 1717,
                                    detonation_energy: 5170000,
                                    det_vel: 7980,
                                    jwl_A: 524.2e9,
                                    jwl_B: 7.67e9,
                                    jwl_R1: 4.2,
                                    jwl_R2: 1.1,
                                    jwl_omega: 0.34
                                },
                                'Composition C-3': {
                                    rho: 1600,
                                    detonation_energy: 5300000,
                                    det_vel: 8000,
                                    jwl_A: 580.0e9,
                                    jwl_B: 11.5e9,
                                    jwl_R1: 4.4,
                                    jwl_R2: 1.2,
                                    jwl_omega: 0.35
                                },
                                'Cyclotol': {
                                    rho: 1750,
                                    detonation_energy: 5200000,
                                    det_vel: 8250,
                                    jwl_A: 582.0e9,
                                    jwl_B: 10.5e9,
                                    jwl_R1: 4.3,
                                    jwl_R2: 1.1,
                                    jwl_omega: 0.32
                                },
                                'Heavy ANFO': {
                                    rho: 1250,
                                    detonation_energy: 3500000,
                                    det_vel: 5000,
                                    jwl_A: 198.0e9,
                                    jwl_B: 1.45e9,
                                    jwl_R1: 4.30,
                                    jwl_R2: 1.00,
                                    jwl_omega: 0.20
                                },
                                'HMX': {
                                    rho: 1890,
                                    detonation_energy: 5620000,
                                    det_vel: 9110,
                                    jwl_A: 778.3e9,
                                    jwl_B: 7.071e9,
                                    jwl_R1: 4.2,
                                    jwl_R2: 1.0,
                                    jwl_omega: 0.30
                                },
                                'LX-04': {
                                    rho: 1860,
                                    detonation_energy: 5300000,
                                    det_vel: 8400,
                                    jwl_A: 742.0e9,
                                    jwl_B: 11.2e9,
                                    jwl_R1: 4.4,
                                    jwl_R2: 1.2,
                                    jwl_omega: 0.30
                                },
                                'LX-07': {
                                    rho: 1860,
                                    detonation_energy: 5500000,
                                    det_vel: 8600,
                                    jwl_A: 785.0e9,
                                    jwl_B: 12.5e9,
                                    jwl_R1: 4.45,
                                    jwl_R2: 1.15,
                                    jwl_omega: 0.32
                                },
                                'LX-10': {
                                    rho: 1860,
                                    detonation_energy: 5800000,
                                    det_vel: 8820,
                                    jwl_A: 830.0e9,
                                    jwl_B: 15.0e9,
                                    jwl_R1: 4.5,
                                    jwl_R2: 1.1,
                                    jwl_omega: 0.38
                                },
                                'LX-14': {
                                    rho: 1835,
                                    detonation_energy: 6000000,
                                    det_vel: 8800,
                                    jwl_A: 825.8e9,
                                    jwl_B: 17.24e9,
                                    jwl_R1: 4.4,
                                    jwl_R2: 0.9,
                                    jwl_omega: 0.38
                                },
                                'LX-17': {
                                    rho: 1900,
                                    detonation_energy: 4500000,
                                    det_vel: 7600,
                                    jwl_A: 640.0e9,
                                    jwl_B: 14.0e9,
                                    jwl_R1: 4.2,
                                    jwl_R2: 1.1,
                                    jwl_omega: 0.30
                                },
                                'Mining Emulsion': {
                                    rho: 1150,
                                    detonation_energy: 3200000,
                                    det_vel: 5300,
                                    jwl_A: 215.0e9,
                                    jwl_B: 1.76e9,
                                    jwl_R1: 4.45,
                                    jwl_R2: 1.05,
                                    jwl_omega: 0.15
                                },
                                'Octol': {
                                    rho: 1810,
                                    detonation_energy: 5400000,
                                    det_vel: 8380,
                                    jwl_A: 718.5e9,
                                    jwl_B: 13.9e9,
                                    jwl_R1: 4.35,
                                    jwl_R2: 1.05,
                                    jwl_omega: 0.32
                                },
                                'PBX 9404': {
                                    rho: 1840,
                                    detonation_energy: 6020000,
                                    det_vel: 8800,
                                    jwl_A: 852.4e9,
                                    jwl_B: 18.02e9,
                                    jwl_R1: 4.55,
                                    jwl_R2: 1.10,
                                    jwl_omega: 0.38
                                },
                                'PBX 9501': {
                                    rho: 1830,
                                    detonation_energy: 5880000,
                                    det_vel: 8800,
                                    jwl_A: 854.5e9,
                                    jwl_B: 20.49e9,
                                    jwl_R1: 4.60,
                                    jwl_R2: 1.35,
                                    jwl_omega: 0.38
                                },
                                'PBX 9502': {
                                    rho: 1895,
                                    detonation_energy: 4100000,
                                    det_vel: 7700,
                                    jwl_A: 548.8e9,
                                    jwl_B: 7.67e9,
                                    jwl_R1: 4.4,
                                    jwl_R2: 1.2,
                                    jwl_omega: 0.30
                                },
                                'PE-10': {
                                    rho: 1550,
                                    detonation_energy: 5200000,
                                    det_vel: 7800,
                                    jwl_A: 590.0e9,
                                    jwl_B: 12.0e9,
                                    jwl_R1: 4.5,
                                    jwl_R2: 1.4,
                                    jwl_omega: 0.25
                                },
                                'PE-12': {
                                    rho: 1520,
                                    detonation_energy: 5000000,
                                    det_vel: 7700,
                                    jwl_A: 570.0e9,
                                    jwl_B: 11.5e9,
                                    jwl_R1: 4.5,
                                    jwl_R2: 1.4,
                                    jwl_omega: 0.25
                                },
                                'PE-4': {
                                    rho: 1590,
                                    detonation_energy: 5621000,
                                    det_vel: 8100,
                                    jwl_A: 609.8e9,
                                    jwl_B: 12.95e9,
                                    jwl_R1: 4.5,
                                    jwl_R2: 1.4,
                                    jwl_omega: 0.25
                                },
                                'PE-8': {
                                    rho: 1570,
                                    detonation_energy: 5400000,
                                    det_vel: 8000,
                                    jwl_A: 600.0e9,
                                    jwl_B: 12.5e9,
                                    jwl_R1: 4.5,
                                    jwl_R2: 1.4,
                                    jwl_omega: 0.25
                                },
                                'Pentolite': {
                                    rho: 1660,
                                    detonation_energy: 5000000,
                                    det_vel: 7470,
                                    jwl_A: 492.2e9,
                                    jwl_B: 9.38e9,
                                    jwl_R1: 4.3,
                                    jwl_R2: 1.1,
                                    jwl_omega: 0.31
                                },
                                'PETN': {
                                    rho: 1770,
                                    detonation_energy: 5800000,
                                    det_vel: 8300,
                                    jwl_A: 613.4e9,
                                    jwl_B: 15.07e9,
                                    jwl_R1: 4.4,
                                    jwl_R2: 1.2,
                                    jwl_omega: 0.28
                                },
                                'RDX': {
                                    rho: 1806,
                                    detonation_energy: 5300000,
                                    det_vel: 8750,
                                    jwl_A: 524.2e9,
                                    jwl_B: 7.678e9,
                                    jwl_R1: 4.2,
                                    jwl_R2: 1.1,
                                    jwl_omega: 0.34
                                },
                                'TATB': {
                                    rho: 1800,
                                    detonation_energy: 4400000,
                                    det_vel: 7660,
                                    jwl_A: 554.6e9,
                                    jwl_B: 7.91e9,
                                    jwl_R1: 4.5,
                                    jwl_R2: 1.6,
                                    jwl_omega: 0.25
                                },
                                'Tetryl': {
                                    rho: 1730,
                                    detonation_energy: 4230000,
                                    det_vel: 7570,
                                    jwl_A: 510.9e9,
                                    jwl_B: 8.44e9,
                                    jwl_R1: 4.5,
                                    jwl_R2: 1.4,
                                    jwl_omega: 0.25
                                },
                                'TNT': {
                                    rho: 1630,
                                    detonation_energy: 4290000,
                                    det_vel: 6930,
                                    jwl_A: 373.77e9,
                                    jwl_B: 3.747e9,
                                    jwl_R1: 4.15,
                                    jwl_R2: 0.90,
                                    jwl_omega: 0.35
                                },
                                'Water Gel': {
                                    rho: 1200,
                                    detonation_energy: 3400000,
                                    det_vel: 4800,
                                    jwl_A: 154.0e9,
                                    jwl_B: 2.15e9,
                                    jwl_R1: 4.30,
                                    jwl_R2: 1.10,
                                    jwl_omega: 0.25
                                }
                            };
                            const preset = EXPLOSIVE_PRESETS[newVal];
                            if (preset) {
                                const matType = node.parameters['material_type'] || 'Air';
                                if (matType === 'Ideal Gas Charge') {
                                    updates['ideal_rho_0'] = preset.rho;
                                    updates['ideal_e_0'] = preset.detonation_energy;
                                } else {
                                    Object.assign(updates, preset);
                                }
                            }
                        }
                        if (node.type === 'STLGeometry' && key === 'voxelization_method') {
                            const rand = Math.floor(Math.random() * 1000000);
                            const simpleHash = 'stl_' + rand.toString(36);
                            updates['geometry_hash'] = simpleHash;
                        }
                        this.stateManager.updateNodeParameters(node.id, updates);
                    },
                    key
                );
            } else {
                const input = document.createElement('input');
                const isNumeric = typeof value === 'number';
                input.type = isNumeric ? 'number' : 'text';
                if (isNumeric) input.step = 'any';
                input.value = typeof value === 'number' ? parseFloat(value.toPrecision(7)).toString() : value.toString();
                input.dataset.key = key;
                input.style.width = '100%';
                input.style.fontSize = 'var(--font-xs)';
                input.style.background = '#222';
                input.style.color = '#ccc';
                input.style.border = '1px solid #444';
                input.style.padding = '1px 2px';


                input.addEventListener('input', () => {
                    const newVal = isNumeric ? Number(input.value) : input.value;
                    const updates: Record<string, any> = { [key]: newVal };
                    if (node.type === 'Material' && ['rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'].includes(key)) {
                        updates['composition'] = 'Custom';
                    }
                    if (node.type === 'Material' && ['ideal_rho_0', 'ideal_e_0'].includes(key)) {
                        updates['composition'] = 'Custom';
                    }
                    
                    const isDynamicCfl = (node.type === 'CFDSolver3D' || node.type === 'CFDSolver2D' || node.type === 'CFDSolver') && key === 'cfl';
                    if (isDynamicCfl) {
                        this.stateManager.updateNodeParametersInPlace(node.id, updates);
                        const net = (window as any).networkManager;
                        if (net && net.isConnected()) {
                            let targetModelId = node.id;
                            const models = this.stateManager.getAppState().models;
                            for (const [mid, m] of Object.entries(models)) {
                                if (m.nodes.some(n => n.id === node.id)) {
                                    targetModelId = mid;
                                    break;
                                }
                            }
                            let scope = "1d";
                            if (node.type === 'CFDSolver3D') scope = "3d";
                            else if (node.type === 'CFDSolver2D') scope = "2d";
                            net.send({
                                command: "UPDATE_CFL",
                                modelId: targetModelId,
                                cfl: Number(newVal),
                                scope: scope
                            });
                        }
                    } else {
                        this.stateManager.updateNodeParameters(node.id, updates);
                    }
                });

                if (key === 'stl_file') {
                    const wrapper = document.createElement('div');
                    wrapper.style.display = 'flex';
                    wrapper.style.gap = '4px';
                    wrapper.style.alignItems = 'center';
                    wrapper.style.width = '100%';

                    input.style.flex = '1';
                    wrapper.appendChild(input);

                    const browseBtn = document.createElement('button');
                    browseBtn.type = 'button';
                    browseBtn.textContent = '...';
                    browseBtn.style.padding = '1px 4px';
                    browseBtn.style.background = '#333';
                    browseBtn.style.color = '#fff';
                    browseBtn.style.border = '1px solid #555';
                    browseBtn.style.cursor = 'pointer';
                    browseBtn.style.fontSize = 'var(--font-xs)';
                    browseBtn.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const startPath = node.parameters[key] || '';
                        const browser = new HostFileBrowserModal(
                            (window as any).networkManager,
                            'open',
                            'select_file',
                            (path: string) => {
                                this.stateManager.updateNodeParameters(node.id, { [key]: path });
                                const rand = Math.floor(Math.random() * 1000000);
                                const simpleHash = 'stl_' + rand.toString(36);
                                this.stateManager.updateNodeParameters(node.id, { geometry_hash: simpleHash });
                            }
                        );
                        browser.open(startPath);
                    };
                    wrapper.appendChild(browseBtn);
                    inputEl = wrapper;
                } else {
                    inputEl = input;
                }
            }

            inputEl.addEventListener('mousedown', (e) => e.stopPropagation());
            row.appendChild(inputEl);
            form.appendChild(row);
        }
        if (gridInfoDiv) {
            form.appendChild(gridInfoDiv);
        }

        container.appendChild(form);
    }

    private createCustomDropdown(
        options: { value: string; label: string }[],
        currentValue: string,
        onChange: (val: string) => void,
        dataKey?: string
    ): HTMLElement {
        const container = document.createElement('div');
        container.className = 'custom-select-container';
        if (dataKey) {
            container.dataset.key = dataKey;
            container.classList.add(dataKey);
        }

        const trigger = document.createElement('div');
        trigger.className = 'custom-select-trigger';
        const currentOpt = options.find(opt => opt.value === currentValue);
        trigger.textContent = currentOpt ? currentOpt.label : currentValue;
        container.appendChild(trigger);

        const optionsDiv = document.createElement('div');
        optionsDiv.className = 'custom-select-options';
        optionsDiv.style.display = 'none';

        options.forEach(opt => {
            const optDiv = document.createElement('div');
            optDiv.className = 'custom-select-option';
            optDiv.dataset.value = opt.value;
            optDiv.textContent = opt.label;
            if (opt.value === currentValue) {
                optDiv.classList.add('selected');
            }

            optDiv.addEventListener('click', (e) => {
                e.stopPropagation();
                optionsDiv.style.display = 'none';
                trigger.textContent = opt.label;
                
                optionsDiv.querySelectorAll('.custom-select-option').forEach(o => {
                    o.classList.remove('selected');
                });
                optDiv.classList.add('selected');

                onChange(opt.value);
            });
            optionsDiv.appendChild(optDiv);
        });

        container.appendChild(optionsDiv);

        ['mousedown', 'mouseup', 'click'].forEach(evtType => {
            container.addEventListener(evtType, (e) => e.stopPropagation());
        });

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.custom-select-options').forEach(el => {
                if (el !== optionsDiv) (el as HTMLElement).style.display = 'none';
            });
            const isOpen = optionsDiv.style.display === 'block';
            optionsDiv.style.display = isOpen ? 'none' : 'block';
        });

        return container;
    }

    private getNodeDescription(type: string): string {
        switch (type) {
            case 'DomainMesh':
                return 'Cartesian grid with structured uniform mesh. Defines the spatial domain boundary conditions and discretization sizing.';
            case 'Material':
                return 'Material properties. Defines Air, JWL explosive, or Ideal Gas explosive equations of state.';
            case 'Charge1D':
                return '1D Charge configuration.';
            case 'Charge2D':
                return '2D Charge configuration.';
            case 'ThePainter':
                return 'Initial conditions painter. Maps mesh cells to physical material states for the simulation starting phase.';
            case 'CFDSolver':
                return 'High-order CFD simulation engine. Solves Euler equations using high-resolution reconstruction and flux splitting schemes. Set init_mode to select between a single-material Ideal Gas run or a full Multi-Material JWL detonation simulation.';
            case 'TelemetryText':
                return 'Live text stream telemetry logger. Outputs simulator event timelines, iteration milestones, and system states.';
            case 'TelemetryGraph':
                return 'Real-time chart telemetry viewer. Plots grid spatial properties, cell pressure profiles, and simulation telemetry histories.';
            case 'DomainMesh2D':
                return '2D Axisymmetric mesh. Discretizes the r-z coordinate space and defines boundary conditions for r_min, r_max, z_min, and z_max faces. Feeds the 2D CFD Solver.';
            case 'DetonatorLocation':
                return 'Detonator position node. Specifies where the detonation point source is placed in the 2D r-z domain. explosive_z and explosive_r set the axial and radial coordinates (m); explosive_radius sets the initial hot-spot radius (m). Required by the 2D CFD Solver for all detonation modes.';
            case 'DetonatorLocation3D':
                return 'Detonator position node (3D). Specifies where the detonation point source is placed in the 3D Cartesian domain. detonator_x, detonator_y, and detonator_z set the coordinates (m). Required by the 3D CFD Solver.';
            case 'RemapNode':
            case 'Remap1DTo2DNode':
                return 'Remapper (1D → 2D). Reads the converged 1D spherical-symmetric solution and maps its conserved variables onto the 2D axisymmetric mesh, centered at the specified explosive_z / explosive_r origin. Triggers at "end" of the 1D run, or at a specific time or step count.';
            case 'Remap1DTo3DNode':
                return 'Remapper (1D → 3D). Reads the converged 1D spherical-symmetric solution and maps its conserved variables onto the 3D Cartesian mesh, centered at the specified explosive_x / explosive_y / explosive_z origin.';
            case 'Remap2DTo3DNode':
                return 'Remapper (2D → 3D). Reads the converged 2D axisymmetric or Cartesian solution and revolves/maps its conserved variables onto the 3D Cartesian mesh, centered at the specified explosive_x / explosive_y / explosive_z origin.';
            case 'HardwareConfig':
                return 'Hardware configuration node. Selects the execution device (CPU with OpenMP, or GPU with CUDA) and the floating-point precision (double / single). Applied to both 1D and 2D solvers in the model.';
            case 'CFDSolver2D':
                return '2D axisymmetric CFD solver. Solves the Euler equations on the r-z mesh using high-order MUSCL reconstruction and AUSM+/Rusanov flux splitting. Accepts a domain mesh, detonator location, remapper, hardware config, and charge materials. init_mode selects From1D (remap a finished 1D run), Multi-Material JWL, or Ideal Gas.';
            case 'TelemetryContour':
                return 'Real-time 2D contour heatmap telemetry viewer. Renders dynamic physical fields — pressure, density, velocity magnitude, and multi-material mass fractions — streamed live from the 2D solver at every output step.';
            case 'VTKOutput':
                return 'VTK output controls. Saves simulation snapshots in VTK XML Unstructured Grid (.vtu) format to the specified directory. Files are compatible with ParaView, VisIt, and other VTK-based post-processors.';
            case 'VirtualGauges':
                return 'Virtual gauges. Records and tracks simulation variables (pressure, density, velocity, species) at discrete coordinates over time.';
            case 'STLGeometry':
                return 'STL Geometry configuration. Defines the path to the STL file representing the solid boundary mesh for Immersed Boundary method, and a unique hash representing it.';
            default:
                return 'Simulation graph node.';
        }
    }

    public autoArrange(): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        state.nodes.forEach(n => {
            n.orientation = this.layoutOrientation;
        });

        const nodes = state.nodes;
        const connections = state.connections;

        // 1. Assign Ranks (Topological Sort / Layering)
        const ranks: Map<string, number> = new Map();
        const inDegree: Map<string, number> = new Map();

        nodes.forEach(n => {
            ranks.set(n.id, 0);
            inDegree.set(n.id, 0);
        });

        connections.forEach(c => {
            inDegree.set(c.toNode, (inDegree.get(c.toNode) || 0) + 1);
        });

        const queue: string[] = [];
        nodes.forEach(n => {
            if (inDegree.get(n.id) === 0) queue.push(n.id);
        });

        while (queue.length > 0) {
            const uId = queue.shift()!;
            const uRank = ranks.get(uId)!;

            connections.filter(c => c.fromNode === uId).forEach(c => {
                const vId = c.toNode;
                ranks.set(vId, Math.max(ranks.get(vId)!, uRank + 1));
                inDegree.set(vId, inDegree.get(vId)! - 1);
                if (inDegree.get(vId) === 0) queue.push(vId);
            });
        }

        // Handle cycles by assigning remaining nodes to next rank
        nodes.forEach(n => {
            if (inDegree.get(n.id)! > 0) {
                const maxRank = Math.max(0, ...Array.from(ranks.values()));
                ranks.set(n.id, maxRank + 1);
            }
        });

        // 2. Group by Rank
        const layers: Map<number, string[]> = new Map();
        ranks.forEach((rank, id) => {
            if (!layers.has(rank)) layers.set(rank, []);
            layers.get(rank)!.push(id);
        });

        const sortedRanks = Array.from(layers.keys()).sort((a, b) => a - b);

        // 3. Position Nodes
        const horizontalGap = 300;
        const verticalGap = 50;
        const startX = 50;
        const startY = 50;

        sortedRanks.forEach((rank, layerIndex) => {
            const nodeIds = layers.get(rank)!;

            // Sort nodes within layer by average predecessor Y position to minimize crossings
            if (layerIndex > 0) {
                nodeIds.sort((a, b) => {
                    const avgA = this.getAveragePredecessorY(a, connections, nodes);
                    const avgB = this.getAveragePredecessorY(b, connections, nodes);
                    return avgA - avgB;
                });
            }

            let currentY = startY;
            nodeIds.forEach(id => {
                const node = nodes.find(n => n.id === id)!;

                if (this.layoutOrientation === 'HORIZ') {
                    const nodeHeight = this.getNodeEstimatedHeight(node);
                    node.x = startX + layerIndex * horizontalGap;
                    node.y = currentY;
                    currentY += nodeHeight + verticalGap;
                } else {
                    const nodeWidth = this.getNodeEstimatedWidth(node);
                    node.x = currentY;
                    node.y = startY + layerIndex * horizontalGap;
                    currentY += nodeWidth + verticalGap;
                }
            });
        });

        this.stateManager.pushState(state);
        this.fitToView();
    }

    private saveViewportState(): void {
        if (this.viewportSaveTimeout) clearTimeout(this.viewportSaveTimeout);
        this.viewportSaveTimeout = setTimeout(() => {
            this.stateManager.updatePanelOptions(this.panelId, {
                zoom: this.zoom,
                panX: this.panX,
                panY: this.panY
            });
        }, 300);
    }

    public fitToView(): void {
        const state = this.stateManager.getCurrentState();
        if (!state || state.nodes.length === 0) {
            this.zoom = 1.0;
            this.panX = 0;
            this.panY = 0;
            this.updateTransform();
            return;
        }

        // Calculate bounding box of all nodes
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        state.nodes.forEach(node => {
            const w = this.getNodeEstimatedWidth(node);
            const h = this.getNodeEstimatedHeight(node);
            if (node.x < minX) minX = node.x;
            if (node.y < minY) minY = node.y;
            if (node.x + w > maxX) maxX = node.x + w;
            if (node.y + h > maxY) maxY = node.y + h;
        });

        const modelW = maxX - minX;
        const modelH = maxY - minY;

        const viewRect = this.viewport.getBoundingClientRect();
        const viewW = viewRect.width || this.viewport.offsetWidth || 800;
        const viewH = viewRect.height || this.viewport.offsetHeight || 600;

        const padding = 40;
        const availW = viewW - padding * 2;
        const availH = viewH - padding * 2;

        let newZoom = 1.0;
        if (modelW > 0 && modelH > 0 && availW > 0 && availH > 0) {
            newZoom = Math.min(availW / modelW, availH / modelH);
        }
        
        // Clamp zoom level to the same bounds as onWheel
        this.zoom = Math.min(Math.max(newZoom, 0.2), 1.5);

        const modelCenterX = minX + modelW / 2;
        const modelCenterY = minY + modelH / 2;

        this.panX = viewW / 2 - modelCenterX * this.zoom;
        this.panY = viewH / 2 - modelCenterY * this.zoom;

        this.updateTransform();
        
        // Save immediately
        if (this.viewportSaveTimeout) clearTimeout(this.viewportSaveTimeout);
        this.stateManager.updatePanelOptions(this.panelId, {
            zoom: this.zoom,
            panX: this.panX,
            panY: this.panY
        });
    }

    private getAveragePredecessorY(nodeId: string, connections: Connection[], nodes: Node[]): number {
        const preds = connections.filter(c => c.toNode === nodeId).map(c => c.fromNode);
        if (preds.length === 0) return 0;
        const sumY = preds.reduce((sum, id) => {
            const n = nodes.find(node => node.id === id);
            return sum + (n ? n.y : 0);
        }, 0);
        return sumY / preds.length;
    }

    private getNodeEstimatedWidth(node: Node): number {
        const displayMode = node.displayMode || 'expanded';
        if (displayMode === 'compact') return 100;
        if (node.width !== undefined) return node.width;
        if (node.type === 'PrimitiveGeometry3D' && displayMode === 'expanded') {
            return 460;
        }
        if (node.type === 'STLGeometry' && displayMode === 'expanded') {
            const stlFile = node.parameters['stl_file'] || '';
            return Math.max(180, Math.ceil(stlFile.length * 6) + 65);
        }
        return 200;
    }

    private getNodeEstimatedHeight(node: Node): number {
        const displayMode = node.displayMode || 'expanded';
        if (displayMode === 'compact') return 40;
        if (node.height !== undefined) return node.height;

        let base = 30; // Header
        if (displayMode === 'normal') {
            if (node.type === 'TelemetryText') return 130;
            if (node.type === 'TelemetryGraph') return 150;
            if (node.type === 'TelemetryContour') return 300;
            if (node.type === 'Telemetry3DViewport') return 350;
            if (node.type === 'VirtualGauges') return 200;
            base += Math.max(node.inputs.length, node.outputs.length) * 20;
        } else if (displayMode === 'expanded') {
            if (node.type === 'PrimitiveGeometry3D') {
                return 280;
            }
            base += Object.keys(node.parameters).length * 25;
            if (node.type === 'TelemetryText') base += 100;
            if (node.type === 'TelemetryGraph') base += 120;
            if (node.type === 'TelemetryContour') base += 270;
            if (node.type === 'Telemetry3DViewport') base += 320;
            if (node.type === 'VirtualGauges') base += 250;
            base += Math.max(node.inputs.length, node.outputs.length) * 20;
        }
        return Math.max(base, 60);
    }

    private renderPrimitiveGeometryNodeCanvasEditor(node: Node, container: HTMLElement): void {
        container.style.overflow = 'visible';
        let form = container.querySelector('.node-params-form') as HTMLFormElement;
        
        // Save focus and cursor selection state
        const activeInput = document.activeElement as HTMLElement;
        const activeInputId = (activeInput && form && form.contains(activeInput)) ? activeInput.id : null;
        let selectionStart: number | null = null;
        let selectionEnd: number | null = null;
        if (activeInput instanceof HTMLInputElement && (activeInput.type === 'text' || activeInput.type === 'number')) {
            selectionStart = activeInput.selectionStart;
            selectionEnd = activeInput.selectionEnd;
        }

        if (!form) {
            form = document.createElement('form');
            form.className = 'node-params-form';
            form.style.padding = '6px';
            form.style.display = 'flex';
            form.style.flexDirection = 'column';
            form.style.gap = '6px';
            form.style.height = '100%';
            form.style.boxSizing = 'border-box';
            form.onsubmit = (e) => e.preventDefault();
            container.appendChild(form);
        } else {
            form.innerHTML = '';
        }

        form.addEventListener('mousedown', (e) => e.stopPropagation());

        const primitives = node.parameters.primitives || [];
        const voxelizationMethod = node.parameters.voxelization_method || 'watertight_floodfill';

        // Voxelization Method Dropdown
        const voxRow = document.createElement('div');
        voxRow.style.display = 'flex';
        voxRow.style.flexDirection = 'column';
        voxRow.style.gap = '2px';

        const voxLabel = document.createElement('label');
        voxLabel.style.fontSize = '9px';
        voxLabel.style.color = '#888';
        voxLabel.style.fontWeight = 'bold';
        voxLabel.textContent = 'VOXELIZATION METHOD';
        voxRow.appendChild(voxLabel);

        const voxSelect = this.createCustomDropdown(
            [
                { value: 'watertight_floodfill', label: 'Watertight Floodfill' },
                { value: 'watertight_raycast', label: 'Watertight Raycast' },
                { value: 'thin_shell', label: 'Thin Shell' },
                { value: 'winding_number', label: 'Winding Number' }
            ],
            voxelizationMethod,
            (newVal) => {
                this.stateManager.updateNodeParameters(node.id, { voxelization_method: newVal });
            },
            'voxelization_method'
        );
        voxRow.appendChild(voxSelect);
        form.appendChild(voxRow);

        // Active shape index
        let focusedIdx = this.focusedPrimitiveIndexMap.get(node.id) ?? 0;
        if (focusedIdx >= primitives.length) {
            focusedIdx = primitives.length - 1;
        }
        if (focusedIdx < 0) {
            focusedIdx = 0;
        }
        this.focusedPrimitiveIndexMap.set(node.id, focusedIdx);

        // Split Layout Container
        const splitContainer = document.createElement('div');
        splitContainer.style.display = 'flex';
        splitContainer.style.flex = '1';
        splitContainer.style.gap = '6px';
        splitContainer.style.minHeight = '0'; // Crucial for nested flex scrolling

        // --- Left Pane (List & Reordering) ---
        const leftPane = document.createElement('div');
        leftPane.style.width = '190px';
        leftPane.style.display = 'flex';
        leftPane.style.flexDirection = 'column';
        leftPane.style.gap = '4px';
        leftPane.style.minHeight = '0';

        const listContainer = document.createElement('div');
        listContainer.style.flex = '1';
        listContainer.style.overflowY = 'auto';
        listContainer.style.display = 'flex';
        listContainer.style.flexDirection = 'column';
        listContainer.style.gap = '3px';
        listContainer.style.border = '1px solid #333';
        listContainer.style.background = '#151515';
        listContainer.style.padding = '3px';
        listContainer.style.borderRadius = '4px';

        primitives.forEach((prim: any, idx: number) => {
            const item = document.createElement('div');
            item.style.background = idx === focusedIdx ? '#2d2d30' : '#1e1e1e';
            item.style.border = idx === focusedIdx ? '1px solid #007acc' : '1px solid #3c3c3c';
            item.style.borderRadius = '3px';
            item.style.padding = '2px 4px';
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.gap = '4px';
            item.style.cursor = 'pointer';

            item.onclick = (e) => {
                this.focusedPrimitiveIndexMap.set(node.id, idx);
                this.renderPrimitiveGeometryNodeCanvasEditor(node, container);
            };

            // tiny reordering arrows
            const arrowsDiv = document.createElement('div');
            arrowsDiv.style.display = 'flex';
            arrowsDiv.style.flexDirection = 'column';
            arrowsDiv.style.alignItems = 'center';
            arrowsDiv.style.gap = '1px';

            const upArrow = document.createElement('button');
            upArrow.textContent = '▲';
            upArrow.style.padding = '0';
            upArrow.style.background = 'transparent';
            upArrow.style.color = idx > 0 ? '#aaa' : '#444';
            upArrow.style.border = 'none';
            upArrow.style.fontSize = '8px';
            upArrow.style.cursor = idx > 0 ? 'pointer' : 'default';
            upArrow.disabled = idx === 0;
            upArrow.onclick = (e) => {
                e.stopPropagation();
                const updated = [...primitives];
                const temp = updated[idx];
                updated[idx] = updated[idx - 1];
                updated[idx - 1] = temp;
                this.focusedPrimitiveIndexMap.set(node.id, idx - 1);
                this.stateManager.updateNodeParameters(node.id, { primitives: updated });
            };
            arrowsDiv.appendChild(upArrow);

            const downArrow = document.createElement('button');
            downArrow.textContent = '▼';
            downArrow.style.padding = '0';
            downArrow.style.background = 'transparent';
            downArrow.style.color = idx < primitives.length - 1 ? '#aaa' : '#444';
            downArrow.style.border = 'none';
            downArrow.style.fontSize = '8px';
            downArrow.style.cursor = idx < primitives.length - 1 ? 'pointer' : 'default';
            downArrow.disabled = idx === primitives.length - 1;
            downArrow.onclick = (e) => {
                e.stopPropagation();
                const updated = [...primitives];
                const temp = updated[idx];
                updated[idx] = updated[idx + 1];
                updated[idx + 1] = temp;
                this.focusedPrimitiveIndexMap.set(node.id, idx + 1);
                this.stateManager.updateNodeParameters(node.id, { primitives: updated });
            };
            arrowsDiv.appendChild(downArrow);
            item.appendChild(arrowsDiv);

            // Name Input
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.id = `prim-name-${node.id}-${idx}`;
            nameInput.value = prim.name || `${prim.type.charAt(0).toUpperCase() + prim.type.slice(1)} ${idx + 1}`;
            nameInput.style.flex = '1';
            nameInput.style.minWidth = '0';
            nameInput.style.background = 'transparent';
            nameInput.style.color = '#fff';
            nameInput.style.border = 'none';
            nameInput.style.fontSize = '9px';
            nameInput.style.padding = '0';
            nameInput.onchange = (e) => {
                const updated = [...primitives];
                updated[idx] = { ...prim, name: nameInput.value };
                this.stateManager.updateNodeParameters(node.id, { primitives: updated });
            };
            nameInput.onclick = (e) => {
                e.stopPropagation();
                if (focusedIdx !== idx) {
                    this.focusedPrimitiveIndexMap.set(node.id, idx);
                    this.renderPrimitiveGeometryNodeCanvasEditor(node, container);
                }
            };
            nameInput.onmousedown = (e) => e.stopPropagation();
            nameInput.onkeydown = (e) => e.stopPropagation();
            item.appendChild(nameInput);

            // Subtractive toggle label
            const subLabel = document.createElement('label');
            subLabel.style.display = 'flex';
            subLabel.style.alignItems = 'center';
            subLabel.style.gap = '2px';
            subLabel.style.fontSize = '8px';
            subLabel.style.color = '#aaa';
            subLabel.style.cursor = 'pointer';
            subLabel.textContent = 'Sub';
            subLabel.onclick = (e) => e.stopPropagation();

            const subCheckbox = document.createElement('input');
            subCheckbox.type = 'checkbox';
            subCheckbox.id = `prim-sub-${node.id}-${idx}`;
            subCheckbox.checked = !!prim.subtractive;
            subCheckbox.style.margin = '0';
            subCheckbox.style.cursor = 'pointer';
            subCheckbox.onchange = () => {
                const updated = [...primitives];
                updated[idx] = { ...prim, subtractive: subCheckbox.checked };
                this.stateManager.updateNodeParameters(node.id, { primitives: updated });
            };
            subCheckbox.onclick = (e) => e.stopPropagation();
            subCheckbox.onmousedown = (e) => e.stopPropagation();
            subLabel.insertBefore(subCheckbox, subLabel.firstChild);
            item.appendChild(subLabel);

            // Delete button
            const delBtn = document.createElement('button');
            delBtn.innerHTML = '✕';
            delBtn.style.background = 'transparent';
            delBtn.style.border = 'none';
            delBtn.style.color = '#ef4444';
            delBtn.style.cursor = 'pointer';
            delBtn.style.fontSize = '9px';
            delBtn.style.padding = '0 2px';
            delBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const updated = primitives.filter((_: any, i: number) => i !== idx);
                this.stateManager.updateNodeParameters(node.id, { primitives: updated });
            };
            item.appendChild(delBtn);

            listContainer.appendChild(item);
        });

        if (primitives.length === 0) {
            const empty = document.createElement('div');
            empty.style.color = '#666';
            empty.style.fontSize = '9px';
            empty.style.textAlign = 'center';
            empty.style.padding = '20px 0';
            empty.textContent = 'No shapes. Add below.';
            listContainer.appendChild(empty);
        }
        leftPane.appendChild(listContainer);

        // Add Shape Buttons (Bottom of left pane)
        const addRow = document.createElement('div');
        addRow.style.display = 'flex';
        addRow.style.gap = '3px';

        const createAddBtn = (labelStr: string, shapeType: string, defaultParams: any) => {
            const btn = document.createElement('button');
            btn.textContent = `+ ${labelStr}`;
            btn.style.flex = '1';
            btn.style.padding = '2px 0';
            btn.style.fontSize = '8px';
            btn.style.background = '#333';
            btn.style.color = '#fff';
            btn.style.border = '1px solid #555';
            btn.style.cursor = 'pointer';
            btn.style.borderRadius = '3px';
            btn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const nameStr = `${shapeType.charAt(0).toUpperCase() + shapeType.slice(1)} ${primitives.length + 1}`;
                const updated = [...primitives, { type: shapeType, name: nameStr, subtractive: false, ...defaultParams }];
                this.focusedPrimitiveIndexMap.set(node.id, updated.length - 1);
                this.stateManager.updateNodeParameters(node.id, { primitives: updated });
            };
            return btn;
        };

        addRow.appendChild(createAddBtn('Cube', 'cuboid', { xmin: 0.0, xmax: 0.2, ymin: 0.0, ymax: 0.2, zmin: 0.0, zmax: 0.2, voxelization_method: 'use_node_default' }));
        addRow.appendChild(createAddBtn('Cyl', 'cylinder', { x: 0.5, y: 0.5, z: 0.5, radius: 0.1, length: 0.2, orientation: 'Z', voxelization_method: 'use_node_default' }));
        addRow.appendChild(createAddBtn('Wedge', 'wedge', { xmin: 0.0, xmax: 0.2, ymin: 0.0, ymax: 0.2, zmin: 0.0, zmax: 0.2, orientation: '+X', voxelization_method: 'use_node_default' }));
        leftPane.appendChild(addRow);
        splitContainer.appendChild(leftPane);

        // --- Right Pane (Properties of focused shape) ---
        const rightPane = document.createElement('div');
        rightPane.style.flex = '1';
        rightPane.style.display = 'flex';
        rightPane.style.flexDirection = 'column';
        rightPane.style.gap = '4px';
        rightPane.style.overflowY = 'auto';
        rightPane.style.border = '1px solid #333';
        rightPane.style.background = '#181818';
        rightPane.style.padding = '4px';
        rightPane.style.borderRadius = '4px';
        rightPane.style.minHeight = '0';

        const activePrim = primitives[focusedIdx];
        if (activePrim) {
            const title = document.createElement('div');
            title.style.fontSize = '9px';
            title.style.fontWeight = 'bold';
            title.style.color = '#569cd6';
            title.style.borderBottom = '1px solid #2d2d2d';
            title.style.paddingBottom = '2px';
            title.style.marginBottom = '4px';
            title.textContent = activePrim.name || `Shape #${focusedIdx + 1}`;
            rightPane.appendChild(title);

            const grid = document.createElement('div');
            grid.style.display = 'grid';
            grid.style.gridTemplateColumns = '1fr 1fr';
            grid.style.gap = '4px';

            const updatePrimVal = (key: string, val: any) => {
                const updated = [...primitives];
                updated[focusedIdx] = { ...activePrim, [key]: val };
                this.stateManager.updateNodeParameters(node.id, { primitives: updated });
            };

            Object.entries(activePrim).forEach(([key, value]) => {
                if (key === 'type' || key === 'name' || key === 'subtractive') return;

                const inputRow = document.createElement('div');
                inputRow.style.display = 'flex';
                inputRow.style.flexDirection = 'column';
                inputRow.style.gap = '1px';

                const label = document.createElement('span');
                label.style.fontSize = '8px';
                label.style.color = '#aaa';
                label.style.fontWeight = 'bold';
                label.textContent = key.toUpperCase();
                inputRow.appendChild(label);

                if (key === 'voxelization_method') {
                    const select = this.createCustomDropdown(
                        [
                            { value: 'use_node_default', label: 'Use Node Default' },
                            { value: 'watertight_floodfill', label: 'Watertight Floodfill' },
                            { value: 'watertight_raycast', label: 'Watertight Raycast' },
                            { value: 'thin_shell', label: 'Thin Shell' },
                            { value: 'winding_number', label: 'Winding Number' }
                        ],
                        String(value || 'use_node_default'),
                        (newVal) => {
                            updatePrimVal(key, newVal);
                        }
                    );
                    inputRow.appendChild(select);
                } else if (key === 'orientation') {
                    const select = document.createElement('select');
                    select.id = `prim-orient-${node.id}-${focusedIdx}`;
                    select.style.background = '#151515';
                    select.style.color = '#ccc';
                    select.style.border = '1px solid #444';
                    select.style.fontSize = '9px';
                    select.style.padding = '1px';

                    const opts = activePrim.type === 'cylinder' ? ['X', 'Y', 'Z'] : ['+X', '-X', '+Y', '-Y'];
                    opts.forEach(o => {
                        const opt = document.createElement('option');
                        opt.value = o;
                        opt.text = o;
                        if (o === value) opt.selected = true;
                        select.appendChild(opt);
                    });
                    select.onchange = () => {
                        updatePrimVal(key, select.value);
                    };
                    inputRow.appendChild(select);
                } else {
                    const input = document.createElement('input');
                    input.type = 'number';
                    input.id = `prim-prop-${node.id}-${focusedIdx}-${key}`;
                    input.step = 'any';
                    input.style.background = '#151515';
                    input.style.color = '#ccc';
                    input.style.border = '1px solid #444';
                    input.style.fontSize = '9px';
                    input.style.padding = '1px 2px';
                    input.value = String(value);
                    input.onchange = () => {
                        updatePrimVal(key, Number(input.value));
                    };
                    input.onmousedown = (e) => e.stopPropagation();
                    input.onkeydown = (e) => e.stopPropagation();
                    inputRow.appendChild(input);
                }
                grid.appendChild(inputRow);
            });

            rightPane.appendChild(grid);
        } else {
            const emptyLabel = document.createElement('div');
            emptyLabel.style.color = '#666';
            emptyLabel.style.fontSize = '9px';
            emptyLabel.style.textAlign = 'center';
            emptyLabel.style.padding = '40px 0';
            emptyLabel.textContent = 'Select a shape to view parameters.';
            rightPane.appendChild(emptyLabel);
        }
        splitContainer.appendChild(rightPane);

        form.appendChild(splitContainer);

        // Restore focus and cursor selection state
        if (activeInputId) {
            const el = form.querySelector(`#${activeInputId}`) as HTMLElement;
            if (el) {
                el.focus();
                if (el instanceof HTMLInputElement && selectionStart !== null && selectionEnd !== null) {
                    try {
                        el.setSelectionRange(selectionStart, selectionEnd);
                    } catch (e) {
                        // ignore if element type doesn't support selection range
                    }
                }
            }
        }
    }

    private renderVirtualGaugesContent(node: Node, container: HTMLElement): void {
        const state = this.stateManager.getCurrentState();
        const has2D = state?.nodes.some(n => n.type === 'DomainMesh2D') || false;
        const is3D = state?.nodes.some(n => n.type === 'DomainMesh3D' || n.type === 'CFDSolver3D') || false;
        const gauges = node.parameters?.gauges || [];

        const setupKeyInterceptors = (input: HTMLInputElement) => {
            input.onkeydown = (e) => {
                e.stopPropagation();
                if (e.key === 'Tab') {
                    this.tabbedFromId = input.id;
                    this.isTabbingForward = !e.shiftKey;
                    this.isTabbingBackward = e.shiftKey;
                } else if (e.key === 'Enter') {
                    this.pressedEnterOnId = input.id;
                    input.blur();
                }
            };
        };
        const ALL_CHANNELS = [
            { id: 0, param: 'qty_pressure',    label: 'Pressure (Pa)' },
            { id: 1, param: 'qty_density',     label: 'Density (kg/m³)' },
            { id: 2, param: 'qty_velocity',    label: 'Velocity (m/s)' },
            { id: 3, param: 'qty_energy',      label: 'Energy (J/kg)' },
            { id: 4, param: 'qty_reacted',     label: 'Reacted Fraction' },
            { id: 5, param: 'qty_unreacted',   label: 'Unreacted Fraction' },
            { id: 6, param: 'qty_air',         label: 'Air Fraction' },
            { id: 7, param: 'qty_overpressure',label: 'Overpressure (Pa)' },
            { id: 8, param: 'qty_impulse',     label: 'Impulse (Pa·s)' }
        ];

        const plottableChannels = ALL_CHANNELS.filter(ch => !!node.parameters?.[ch.param]);
        let currentChannel = Number(node.parameters?.telemetry_channel ?? 0);
        if (plottableChannels.length > 0 && !plottableChannels.some(ch => ch.id === currentChannel)) {
            currentChannel = plottableChannels[0].id;
            setTimeout(() => {
                this.stateManager.updateNodeParameters(node.id, { telemetry_channel: currentChannel });
            }, 0);
        }

        // Ensure collapsible states are initialized in GraphRenderer maps
        if (!this.gaugesPanelOpen.has(node.id)) {
            this.gaugesPanelOpen.set(node.id, true);
        }
        if (!this.gaugesActiveTab.has(node.id)) {
            this.gaugesActiveTab.set(node.id, 'list');
        }

        let mainArea = container.querySelector('.gauges-main-area') as HTMLElement;
        let controlsPanel = container.querySelector('.gauges-controls-panel') as HTMLElement;
        let toggleBtn = container.querySelector('.gauges-toggle-btn') as HTMLElement;
        let splitter = container.querySelector('.gauges-panel-splitter') as HTMLElement;

        if (!mainArea || !controlsPanel || !toggleBtn) {
            container.innerHTML = '';
            container.style.flexDirection = 'row';
            container.style.display = 'flex';
            container.style.height = '100%';
            container.style.width = '100%';
            container.style.overflow = 'hidden';
            container.style.position = 'relative';

            mainArea = document.createElement('div');
            mainArea.className = 'gauges-main-area';
            mainArea.style.display = 'flex';
            mainArea.style.flexDirection = 'column';
            mainArea.style.flex = '1';
            mainArea.style.minWidth = '0';
            mainArea.style.height = '100%';
            mainArea.style.position = 'relative';
            container.appendChild(mainArea);

            controlsPanel = document.createElement('div');
            controlsPanel.className = 'gauges-controls-panel';
            controlsPanel.style.background = '#121214';
            controlsPanel.style.display = 'flex';
            controlsPanel.style.flexDirection = 'column';
            controlsPanel.style.height = '100%';
            controlsPanel.style.overflow = 'hidden';
            controlsPanel.style.flexShrink = '0';
            controlsPanel.style.transition = 'width 0.15s, padding 0.15s, border-left 0.15s';
            container.appendChild(controlsPanel);

            splitter = document.createElement('div');
            splitter.className = 'gauges-panel-splitter';
            container.insertBefore(splitter, controlsPanel);

            toggleBtn = document.createElement('button');
            toggleBtn.className = 'gauges-toggle-btn';
            toggleBtn.style.position = 'absolute';
            toggleBtn.style.top = '4px';
            toggleBtn.style.right = '4px';
            toggleBtn.style.zIndex = '110';
            toggleBtn.style.background = '#1e1e24';
            toggleBtn.style.color = '#ccc';
            toggleBtn.style.border = '1px solid #444';
            toggleBtn.style.borderRadius = '3px';
            toggleBtn.style.fontSize = '9px';
            toggleBtn.style.padding = '2px 6px';
            toggleBtn.style.cursor = 'pointer';
            toggleBtn.onmousedown = (e) => e.stopPropagation();
            mainArea.appendChild(toggleBtn);
        }

        if (splitter) {
            const newSplitter = splitter.cloneNode(true) as HTMLElement;
            splitter.parentNode?.replaceChild(newSplitter, splitter);
            splitter = newSplitter;
            splitter.onmousedown = (e) => e.stopPropagation();

            splitter.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const startX = e.clientX;
                const startW = controlsPanel.offsetWidth;
                controlsPanel.style.transition = 'none';

                const onMove = (me: MouseEvent) => {
                    const dx = (me.clientX - startX) / this.zoom;
                    const newW = Math.max(160, Math.min(600, startW - dx));
                    controlsPanel.style.width = `${newW}px`;
                    this.gaugesPanelWidth.set(node.id, newW);

                    const canvas = mainArea.querySelector('canvas') as HTMLCanvasElement;
                    if (canvas) {
                        canvas.width = canvas.clientWidth || 250;
                        canvas.height = canvas.clientHeight || 100;
                        const history = this.stateManager.getTelemetry(node.id);
                        if (history) {
                            this.drawGaugesChart(canvas, history, gauges, currentChannel, has2D, node.id);
                        }
                    }
                };

                const onUp = () => {
                    controlsPanel.style.transition = 'width 0.15s, padding 0.15s, border-left 0.15s';
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                };

                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
            });
        }

        // Apply open/collapsed state classes and sizes
        const panelOpen = this.gaugesPanelOpen.get(node.id) !== false;
        if (panelOpen) {
            const preferredW = this.gaugesPanelWidth.get(node.id) ?? 260;
            controlsPanel.style.width = `${preferredW}px`;
            controlsPanel.style.padding = '8px';
            controlsPanel.style.borderLeft = '1px solid #222';
            toggleBtn.textContent = '▶ Hide';
            if (splitter) splitter.style.display = 'block';
        } else {
            controlsPanel.style.width = '0px';
            controlsPanel.style.padding = '0px';
            controlsPanel.style.borderLeft = 'none';
            toggleBtn.textContent = '◀ Controls';
            if (splitter) splitter.style.display = 'none';
        }

        // Toggle panel click handler
        toggleBtn.onclick = (e) => {
            e.stopPropagation();
            const isOpen = this.gaugesPanelOpen.get(node.id) !== false;
            const nextOpen = !isOpen;
            this.gaugesPanelOpen.set(node.id, nextOpen);

            if (nextOpen) {
                const preferredW = this.gaugesPanelWidth.get(node.id) ?? 260;
                controlsPanel.style.width = `${preferredW}px`;
                controlsPanel.style.padding = '8px';
                controlsPanel.style.borderLeft = '1px solid #222';
                toggleBtn.textContent = '▶ Hide';
                if (splitter) splitter.style.display = 'block';
            } else {
                controlsPanel.style.width = '0px';
                controlsPanel.style.padding = '0px';
                controlsPanel.style.borderLeft = 'none';
                toggleBtn.textContent = '◀ Controls';
                if (splitter) splitter.style.display = 'none';
            }

            // Redraw chart canvas on layout transition
            const canvas = mainArea.querySelector('canvas') as HTMLCanvasElement;
            if (canvas) {
                canvas.width = canvas.clientWidth || 250;
                canvas.height = canvas.clientHeight || 100;
                const history = this.stateManager.getTelemetry(node.id);
                if (history) {
                    this.drawGaugesChart(canvas, history, gauges, currentChannel, has2D, node.id);
                }
            }
        };

        // 1. Rebuild Left Main Area (Chart Area) contents except the toggle button
        Array.from(mainArea.children).forEach(child => {
            if (child !== toggleBtn) mainArea.removeChild(child);
        });

        // Add Toolbar
        const toolbar = document.createElement('div');
        toolbar.style.display = 'flex';
        toolbar.style.gap = '6px';
        toolbar.style.alignItems = 'center';
        toolbar.style.padding = '4px 8px';
        toolbar.style.borderBottom = '1px solid #222';
        toolbar.style.background = '#1a1a1c';

        const outputLabel = document.createElement('span');
        outputLabel.textContent = 'Quantity:';
        outputLabel.style.fontSize = '9px';
        outputLabel.style.fontWeight = 'bold';
        outputLabel.style.color = '#888';
        toolbar.appendChild(outputLabel);

        const outputSelect = document.createElement('select');
        outputSelect.style.fontSize = '9px';
        outputSelect.style.background = '#222';
        outputSelect.style.color = '#ccc';
        outputSelect.style.border = '1px solid #444';
        outputSelect.style.padding = '1px 3px';
        outputSelect.style.borderRadius = '2px';

        plottableChannels.forEach((ch) => {
            const opt = document.createElement('option');
            opt.value = String(ch.id);
            opt.textContent = ch.label;
            if (ch.id === currentChannel) opt.selected = true;
            outputSelect.appendChild(opt);
        });
        outputSelect.onchange = () => {
            this.stateManager.updateNodeParameters(node.id, { telemetry_channel: Number(outputSelect.value) });
        };
        outputSelect.onmousedown = (e) => e.stopPropagation();
        toolbar.appendChild(outputSelect);
        mainArea.appendChild(toolbar);

        // Add Canvas Container & Canvas
        const canvasContainer = document.createElement('div');
        canvasContainer.className = 'gauges-canvas-container';
        canvasContainer.style.flex = '1';
        canvasContainer.style.position = 'relative';
        canvasContainer.style.minHeight = '0';
        canvasContainer.style.background = '#1e1e1e';
        canvasContainer.style.transition = 'outline 0.15s, box-shadow 0.15s';
        canvasContainer.style.borderRadius = '4px';
        if (this.focusedChartNodeId === node.id) {
            canvasContainer.style.outline = '2px solid #38bdf8';
            canvasContainer.style.outlineOffset = '-2px';
            canvasContainer.style.boxShadow = '0 0 8px rgba(56, 189, 248, 0.4)';
        } else {
            canvasContainer.style.outline = '';
            canvasContainer.style.boxShadow = '';
        }
        mainArea.appendChild(canvasContainer);

        const canvas = document.createElement('canvas');
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvasContainer.appendChild(canvas);

        const getActiveGaugesBounds = () => {
            const history = this.stateManager.getTelemetry(node.id);
            let minVal = 0;
            let maxVal = 1;
            let timesLength = 0;
            const defaultMinX = 0;
            const defaultMaxX = history && history.times ? history.times.length - 1 || 1 : 1;
            
            const zoomedOrPanned = this.gaugesZoomedOrPanned.get(node.id) || false;
            const activeMinX = zoomedOrPanned ? (this.gaugesZoomMinX.get(node.id) ?? defaultMinX) : defaultMinX;
            const activeMaxX = zoomedOrPanned ? (this.gaugesZoomMaxX.get(node.id) ?? defaultMaxX) : defaultMaxX;

            if (history && history.times && history.times.length > 0 && history.values) {
                timesLength = history.times.length;
                let minV = Infinity;
                let maxV = -Infinity;
                let hasData = false;
                
                const startIdx = zoomedOrPanned ? Math.max(0, Math.floor(activeMinX)) : 0;
                const endIdx = zoomedOrPanned ? Math.min(timesLength - 1, Math.ceil(activeMaxX)) : timesLength - 1;

                gauges.filter((g: any) => g.plot !== false).forEach((g: any) => {
                    const gData = history.values[g.id];
                    if (gData && gData[currentChannel]) {
                        const arr = gData[currentChannel];
                        const limit = Math.min(arr.length - 1, endIdx);
                        for (let i = startIdx; i <= limit; i++) {
                            const v = arr[i];
                            if (isFinite(v)) {
                                if (v < minV) minV = v;
                                if (v > maxV) maxV = v;
                                hasData = true;
                            }
                        }
                    }
                });
                if (hasData) {
                    minVal = minV;
                    maxVal = maxV;
                }
            }
            
            return {
                minX: activeMinX,
                maxX: activeMaxX,
                minY: minVal,
                maxY: maxVal
            };
        };

        canvas.style.touchAction = 'none';

        canvas.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            
            if (this.focusedChartNodeId !== node.id) {
                if (this.focusedChartNodeId) {
                    const prevNodeEl = this.nodeElements.get(this.focusedChartNodeId);
                    if (prevNodeEl) {
                        const container = prevNodeEl.querySelector('.gauges-canvas-container');
                        if (container) {
                            (container as HTMLElement).style.outline = '';
                            (container as HTMLElement).style.boxShadow = '';
                        }
                    }
                }
                this.focusedChartNodeId = node.id;
                canvasContainer.style.outline = '2px solid #38bdf8';
                canvasContainer.style.outlineOffset = '-2px';
                canvasContainer.style.boxShadow = '0 0 8px rgba(56, 189, 248, 0.4)';
            }
            
            canvas.setPointerCapture(e.pointerId);
            const rect = canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            
            this.gaugesIsDragging.set(node.id, true);
            this.gaugesDragStartX.set(node.id, mouseX);
            
            const active = getActiveGaugesBounds();
            this.gaugesDragStartMinX.set(node.id, active.minX);
            this.gaugesDragStartMaxX.set(node.id, active.maxX);
            
            e.preventDefault();
        });

        canvas.addEventListener('pointermove', (e) => {
            if (this.gaugesIsDragging.get(node.id) && canvas.hasPointerCapture(e.pointerId)) {
                e.stopPropagation();
                const rect = canvas.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                
                const dxScreen = mouseX - (this.gaugesDragStartX.get(node.id) ?? 0);
                
                const paddingLeft = 50;
                const paddingRight = 10;
                const plotWidth = rect.width - paddingLeft - paddingRight;
                
                if (plotWidth > 0) {
                    const startMinX = this.gaugesDragStartMinX.get(node.id) ?? 0;
                    const startMaxX = this.gaugesDragStartMaxX.get(node.id) ?? 1.0;
                    const rangeX = startMaxX - startMinX;
                    const dx = (dxScreen / plotWidth) * rangeX;
                    
                    this.gaugesZoomMinX.set(node.id, startMinX - dx);
                    this.gaugesZoomMaxX.set(node.id, startMaxX - dx);
                    this.gaugesZoomedOrPanned.set(node.id, true);
                    
                    const history = this.stateManager.getTelemetry(node.id);
                    if (history) {
                        this.drawGaugesChart(canvas, history, gauges, currentChannel, has2D, node.id);
                    }
                }
            }
        });

        const releaseGaugesCapture = (e: PointerEvent) => {
            if (canvas.hasPointerCapture(e.pointerId)) {
                canvas.releasePointerCapture(e.pointerId);
                this.gaugesIsDragging.set(node.id, false);
            }
        };

        canvas.addEventListener('pointerup', releaseGaugesCapture);
        canvas.addEventListener('pointercancel', releaseGaugesCapture);

        canvas.addEventListener('wheel', (e) => {
            e.stopPropagation();
            if (this.focusedChartNodeId !== node.id) {
                return;
            }
            
            e.preventDefault();
            
            const rect = canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            
            const paddingLeft = 50;
            const paddingRight = 10;
            const plotWidth = rect.width - paddingLeft - paddingRight;
            
            if (plotWidth <= 0) return;
            
            const active = getActiveGaugesBounds();
            const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;
            
            const pctX = (mouseX - paddingLeft) / plotWidth;
            const targetX = active.minX + pctX * (active.maxX - active.minX);
            const newRangeX = (active.maxX - active.minX) * zoomFactor;
            
            this.gaugesZoomMinX.set(node.id, targetX - pctX * newRangeX);
            this.gaugesZoomMaxX.set(node.id, this.gaugesZoomMinX.get(node.id)! + newRangeX);
            this.gaugesZoomedOrPanned.set(node.id, true);
            
            const history = this.stateManager.getTelemetry(node.id);
            if (history) {
                this.drawGaugesChart(canvas, history, gauges, currentChannel, has2D, node.id);
            }
        }, { passive: false });

        canvas.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this.gaugesZoomedOrPanned.set(node.id, false);
            const history = this.stateManager.getTelemetry(node.id);
            if (history) {
                this.drawGaugesChart(canvas, history, gauges, currentChannel, has2D, node.id);
            }
            e.preventDefault();
        });

        // 2. Rebuild Right Collapsible controlsPanel contents
        const oldScrollTop = (controlsPanel.querySelector('.gauges-panel-content') as HTMLElement)?.scrollTop || 0;
        controlsPanel.innerHTML = '';

        const activeTab = this.gaugesActiveTab.get(node.id) || 'list';

        // Tab headers
        const tabBar = document.createElement('div');
        tabBar.style.display = 'flex';
        tabBar.style.borderBottom = '1px solid #333';
        tabBar.style.marginBottom = '6px';
        tabBar.style.gap = '4px';

        const tabBtnList = document.createElement('button');
        tabBtnList.textContent = 'GAUGES';
        tabBtnList.style.padding = '4px 6px';
        tabBtnList.style.fontSize = '9px';
        tabBtnList.style.fontWeight = 'bold';
        tabBtnList.style.background = activeTab === 'list' ? '#1e1e1e' : 'transparent';
        tabBtnList.style.color = activeTab === 'list' ? '#38bdf8' : '#888';
        tabBtnList.style.border = 'none';
        tabBtnList.style.borderBottom = activeTab === 'list' ? '2px solid #38bdf8' : '2px solid transparent';
        tabBtnList.style.cursor = 'pointer';
        tabBtnList.style.flex = '1';
        tabBtnList.style.textAlign = 'center';
        tabBtnList.onmousedown = (e) => e.stopPropagation();
        tabBtnList.onclick = (e) => {
            e.stopPropagation();
            this.gaugesActiveTab.set(node.id, 'list');
            this.renderVirtualGaugesContent(node, container);
        };
        tabBar.appendChild(tabBtnList);

        const tabBtnSettings = document.createElement('button');
        tabBtnSettings.textContent = 'SETTINGS';
        tabBtnSettings.style.padding = '4px 6px';
        tabBtnSettings.style.fontSize = '9px';
        tabBtnSettings.style.fontWeight = 'bold';
        tabBtnSettings.style.background = activeTab === 'settings' ? '#1e1e1e' : 'transparent';
        tabBtnSettings.style.color = activeTab === 'settings' ? '#38bdf8' : '#888';
        tabBtnSettings.style.border = 'none';
        tabBtnSettings.style.borderBottom = activeTab === 'settings' ? '2px solid #38bdf8' : '2px solid transparent';
        tabBtnSettings.style.cursor = 'pointer';
        tabBtnSettings.style.flex = '1';
        tabBtnSettings.style.textAlign = 'center';
        tabBtnSettings.onmousedown = (e) => e.stopPropagation();
        tabBtnSettings.onclick = (e) => {
            e.stopPropagation();
            this.gaugesActiveTab.set(node.id, 'settings');
            this.renderVirtualGaugesContent(node, container);
        };
        tabBar.appendChild(tabBtnSettings);
        controlsPanel.appendChild(tabBar);

        // Tab Content Scroll Container
        const panelContent = document.createElement('div');
        panelContent.className = 'gauges-panel-content';
        panelContent.style.flex = '1';
        panelContent.style.overflowY = 'auto';
        panelContent.style.display = 'flex';
        panelContent.style.flexDirection = 'column';
        panelContent.style.gap = '8px';
        panelContent.style.minHeight = '0';
        controlsPanel.appendChild(panelContent);

        if (activeTab === 'list') {
            // Add/Clear Buttons Row
            const buttonsRow = document.createElement('div');
            buttonsRow.style.display = 'flex';
            buttonsRow.style.gap = '6px';

            const addBtn = document.createElement('button');
            addBtn.textContent = '+ Gauge';
            addBtn.style.flex = '1';
            addBtn.style.padding = '3px 6px';
            addBtn.style.fontSize = '9px';
            addBtn.style.fontWeight = 'bold';
            addBtn.style.background = '#38bdf8';
            addBtn.style.color = '#0f172a';
            addBtn.style.border = 'none';
            addBtn.style.borderRadius = '3px';
            addBtn.style.cursor = 'pointer';
            addBtn.onmousedown = (e) => e.stopPropagation();
            addBtn.onclick = () => {
                const nextIdx = gauges.length + 1;
                const newGauge = is3D 
                    ? { id: `G${nextIdx}`, x: 0.5, y: 0.5, z: 0.5, active: true, plot: true }
                    : { id: `G${nextIdx}`, r: 0.1, z: 0.0, active: true, plot: true };
                const newGauges = [...gauges, newGauge];
                this.stateManager.updateNodeParameters(node.id, { gauges: newGauges });
            };
            buttonsRow.appendChild(addBtn);

            const deleteSelBtn = document.createElement('button');
            deleteSelBtn.textContent = 'Delete Sel';
            deleteSelBtn.style.flex = '1.2';
            deleteSelBtn.style.padding = '3px 6px';
            deleteSelBtn.style.fontSize = '9px';
            deleteSelBtn.style.fontWeight = 'bold';
            deleteSelBtn.style.background = '#e11d48';
            deleteSelBtn.style.color = '#fff';
            deleteSelBtn.style.border = 'none';
            deleteSelBtn.style.borderRadius = '3px';
            deleteSelBtn.style.cursor = 'pointer';
            deleteSelBtn.onmousedown = (e) => e.stopPropagation();
            
            const selectedCount = gauges.filter((g: any) => g.plot !== false).length;
            if (selectedCount === 0) {
                deleteSelBtn.disabled = true;
                deleteSelBtn.style.opacity = '0.5';
                deleteSelBtn.style.cursor = 'not-allowed';
            }
            deleteSelBtn.onclick = () => {
                const remaining = gauges.filter((g: any) => g.plot === false);
                this.stateManager.updateNodeParameters(node.id, { gauges: remaining });
            };
            buttonsRow.appendChild(deleteSelBtn);

            const clearBtn = document.createElement('button');
            clearBtn.textContent = 'Clear';
            clearBtn.style.flex = '1';
            clearBtn.style.padding = '3px 6px';
            clearBtn.style.fontSize = '9px';
            clearBtn.style.fontWeight = 'bold';
            clearBtn.style.background = '#dc2626';
            clearBtn.style.color = '#fff';
            clearBtn.style.border = 'none';
            clearBtn.style.borderRadius = '3px';
            clearBtn.style.cursor = 'pointer';
            clearBtn.onmousedown = (e) => e.stopPropagation();
            clearBtn.onclick = () => {
                this.stateManager.updateNodeParameters(node.id, { gauges: [] });
            };
            buttonsRow.appendChild(clearBtn);
            panelContent.appendChild(buttonsRow);

            // Gauges table
            const listDiv = document.createElement('div');
            listDiv.style.border = '1px solid #333';
            listDiv.style.borderRadius = '3px';
            listDiv.style.background = '#181818';
            listDiv.style.minHeight = '40px';

            if (gauges.length === 0) {
                const empty = document.createElement('div');
                empty.style.padding = '8px';
                empty.style.fontSize = '9px';
                empty.style.color = '#666';
                empty.style.fontStyle = 'italic';
                empty.textContent = 'No gauges defined';
                listDiv.appendChild(empty);
            } else {
                const table = document.createElement('table');
                table.className = 'gauges-table';
                table.style.width = '100%';
                table.style.borderCollapse = 'collapse';
                table.style.fontSize = '9px';
                table.style.color = '#ccc';
                table.style.tableLayout = 'fixed';

                const thead = document.createElement('thead');
                thead.style.borderBottom = '1px solid #333';
                thead.style.background = '#1a1a1c';
                const headerTr = document.createElement('tr');
                const thSel = document.createElement('th');
                thSel.style.width = '24px';
                thSel.style.textAlign = 'center';
                const masterCheck = document.createElement('input');
                masterCheck.type = 'checkbox';
                masterCheck.checked = gauges.length > 0 && gauges.every((g: any) => g.plot !== false);
                masterCheck.onmousedown = (e) => e.stopPropagation();
                masterCheck.onchange = () => {
                    const checked = masterCheck.checked;
                    gauges.forEach((g: any) => { g.plot = checked; });
                    this.stateManager.updateNodeParameters(node.id, { gauges: gauges });
                };
                thSel.appendChild(masterCheck);
                headerTr.appendChild(thSel);

                if (is3D) {
                    headerTr.insertAdjacentHTML('beforeend', `
                        <th style="text-align:left;padding:2px 4px;width:40px;">ID</th>
                        <th style="text-align:left;padding:2px 4px;width:55px;">X</th>
                        <th style="text-align:left;padding:2px 4px;width:55px;">Y</th>
                        <th style="text-align:left;padding:2px 4px;width:55px;">Z</th>
                        <th style="width:20px;"></th>
                    `);
                } else {
                    headerTr.insertAdjacentHTML('beforeend', `
                        <th style="text-align:left;padding:2px 4px;width:40px;">ID</th>
                        <th style="text-align:left;padding:2px 4px;width:75px;">R</th>
                        ${has2D ? '<th style="text-align:left;padding:2px 4px;width:75px;">Z</th>' : ''}
                        <th style="width:20px;"></th>
                    `);
                }
                thead.appendChild(headerTr);
                table.appendChild(thead);

                const tbody = document.createElement('tbody');
                gauges.forEach((g: any, idx: number) => {
                    const tr = document.createElement('tr');
                    tr.style.borderBottom = '1px solid #222';

                    const tdSel = document.createElement('td');
                    tdSel.style.padding = '2px 4px';
                    tdSel.style.textAlign = 'center';
                    const check = document.createElement('input');
                    check.type = 'checkbox';
                    check.checked = g.plot !== false;
                    check.onmousedown = (e) => e.stopPropagation();
                    check.onchange = () => {
                        g.plot = check.checked;
                        this.stateManager.updateNodeParameters(node.id, { gauges: gauges });
                    };
                    tdSel.appendChild(check);
                    tr.appendChild(tdSel);

                    const tdId = document.createElement('td');
                    tdId.style.padding = '2px 4px';
                    const inputId = document.createElement('input');
                    inputId.type = 'text';
                    inputId.id = `gauge-input-${node.id}-${idx}-id`;
                    inputId.value = g.id || g.name || '';
                    inputId.style.width = '100%';
                    inputId.style.fontWeight = 'bold';
                    inputId.onmousedown = (e) => e.stopPropagation();
                    setupKeyInterceptors(inputId);
                    inputId.addEventListener('change', () => {
                        const val = inputId.value.trim();
                        if (val) {
                            g.id = val;
                            g.name = val;
                            this.stateManager.updateNodeParameters(node.id, { gauges: gauges });
                        } else {
                            inputId.value = g.id || g.name || '';
                        }
                    });
                    tdId.appendChild(inputId);
                    tr.appendChild(tdId);

                    if (is3D) {
                        const tdX = document.createElement('td');
                        tdX.style.padding = '2px 4px';
                        const inputX = document.createElement('input');
                        inputX.type = 'text';
                        inputX.id = `gauge-input-${node.id}-${idx}-x`;
                        inputX.inputMode = 'decimal';
                        inputX.value = String(g.x ?? 0.5);
                        inputX.style.width = '100%';
                        inputX.onmousedown = (e) => e.stopPropagation();
                        setupKeyInterceptors(inputX);
                        inputX.addEventListener('change', () => {
                            const val = Number(inputX.value);
                            if (!isNaN(val)) {
                                g.x = val;
                                this.stateManager.updateNodeParameters(node.id, { gauges: gauges });
                            }
                        });
                        tdX.appendChild(inputX);
                        tr.appendChild(tdX);

                        const tdY = document.createElement('td');
                        tdY.style.padding = '2px 4px';
                        const inputY = document.createElement('input');
                        inputY.type = 'text';
                        inputY.id = `gauge-input-${node.id}-${idx}-y`;
                        inputY.inputMode = 'decimal';
                        inputY.value = String(g.y ?? 0.5);
                        inputY.style.width = '100%';
                        inputY.onmousedown = (e) => e.stopPropagation();
                        setupKeyInterceptors(inputY);
                        inputY.addEventListener('change', () => {
                            const val = Number(inputY.value);
                            if (!isNaN(val)) {
                                g.y = val;
                                this.stateManager.updateNodeParameters(node.id, { gauges: gauges });
                            }
                        });
                        tdY.appendChild(inputY);
                        tr.appendChild(tdY);

                        const tdZ = document.createElement('td');
                        tdZ.style.padding = '2px 4px';
                        const inputZ = document.createElement('input');
                        inputZ.type = 'text';
                        inputZ.id = `gauge-input-${node.id}-${idx}-z`;
                        inputZ.inputMode = 'decimal';
                        inputZ.value = String(g.z ?? 0.5);
                        inputZ.style.width = '100%';
                        inputZ.onmousedown = (e) => e.stopPropagation();
                        setupKeyInterceptors(inputZ);
                        inputZ.addEventListener('change', () => {
                            const val = Number(inputZ.value);
                            if (!isNaN(val)) {
                                g.z = val;
                                this.stateManager.updateNodeParameters(node.id, { gauges: gauges });
                            }
                        });
                        tdZ.appendChild(inputZ);
                        tr.appendChild(tdZ);
                    } else {
                        const tdR = document.createElement('td');
                        tdR.style.padding = '2px 4px';
                        const inputR = document.createElement('input');
                        inputR.type = 'text';
                        inputR.id = `gauge-input-${node.id}-${idx}-r`;
                        inputR.inputMode = 'decimal';
                        inputR.value = String(g.r ?? 0.1);
                        inputR.style.width = '100%';
                        inputR.onmousedown = (e) => e.stopPropagation();
                        setupKeyInterceptors(inputR);
                        inputR.addEventListener('change', () => {
                            const val = Number(inputR.value);
                            if (!isNaN(val)) {
                                g.r = val;
                                this.stateManager.updateNodeParameters(node.id, { gauges: gauges });
                            }
                        });
                        tdR.appendChild(inputR);
                        tr.appendChild(tdR);

                        if (has2D) {
                            const tdZ = document.createElement('td');
                            tdZ.style.padding = '2px 4px';
                            const inputZ = document.createElement('input');
                            inputZ.type = 'text';
                            inputZ.id = `gauge-input-${node.id}-${idx}-z`;
                            inputZ.inputMode = 'decimal';
                            inputZ.value = String(g.z ?? 0.0);
                            inputZ.style.width = '100%';
                            inputZ.onmousedown = (e) => e.stopPropagation();
                            setupKeyInterceptors(inputZ);
                            inputZ.addEventListener('change', () => {
                                const val = Number(inputZ.value);
                                if (!isNaN(val)) {
                                    g.z = val;
                                    this.stateManager.updateNodeParameters(node.id, { gauges: gauges });
                                }
                            });
                            tdZ.appendChild(inputZ);
                            tr.appendChild(tdZ);
                        }
                    }

                    // Delete Button
                    const tdDel = document.createElement('td');
                    tdDel.style.padding = '2px 4px';
                    tdDel.style.textAlign = 'right';
                    const delBtn = document.createElement('button');
                    delBtn.textContent = '×';
                    delBtn.style.background = 'none';
                    delBtn.style.color = '#ef4444';
                    delBtn.style.border = 'none';
                    delBtn.style.cursor = 'pointer';
                    delBtn.style.fontWeight = 'bold';
                    delBtn.style.fontSize = '12px';
                    delBtn.style.padding = '0';
                    delBtn.onmousedown = (e) => e.stopPropagation();
                    delBtn.onclick = () => {
                        const updated = gauges.filter((_: any, i: number) => i !== idx);
                        this.stateManager.updateNodeParameters(node.id, { gauges: updated });
                    };
                    tdDel.appendChild(delBtn);
                    tr.appendChild(tdDel);

                    tbody.appendChild(tr);
                });
                table.appendChild(tbody);
                listDiv.appendChild(table);
            }
            panelContent.appendChild(listDiv);
        } else if (activeTab === 'settings') {
            const mkSection = (label: string) => {
                const hdr = document.createElement('div');
                hdr.style.fontSize = '9px';
                hdr.style.color = '#555';
                hdr.style.fontWeight = 'bold';
                hdr.style.letterSpacing = '0.08em';
                hdr.style.padding = '6px 0 2px';
                hdr.style.borderTop = '1px solid #2a2a2a';
                hdr.style.marginTop = '4px';
                hdr.textContent = label;
                panelContent.appendChild(hdr);
            };

            const mkRow = (labelText: string, el: HTMLElement) => {
                const wrap = document.createElement('div');
                wrap.style.display = 'flex';
                wrap.style.flexDirection = 'column';
                wrap.style.gap = '2px';
                wrap.style.marginBottom = '4px';
                const lbl = document.createElement('label');
                lbl.style.fontSize = '8px';
                lbl.style.color = '#666';
                lbl.textContent = labelText;
                wrap.appendChild(lbl);
                wrap.appendChild(el);
                return wrap;
            };

            const createCheckboxField = (key: string, value: boolean, labelText: string) => {
                const row = document.createElement('div');
                row.style.display = 'flex';
                row.style.alignItems = 'center';
                row.style.gap = '4px';
                row.style.padding = '1px 0';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = value;
                cb.style.cursor = 'pointer';
                cb.style.margin = '0';
                cb.onchange = () => {
                    this.stateManager.updateNodeParameters(node.id, { [key]: cb.checked });
                };
                cb.onmousedown = (e) => e.stopPropagation();

                const span = document.createElement('span');
                span.style.fontSize = '9px';
                span.style.color = '#ccc';
                span.style.cursor = 'pointer';
                span.textContent = labelText;
                span.onclick = () => {
                    cb.checked = !cb.checked;
                    cb.dispatchEvent(new Event('change'));
                };

                row.appendChild(cb);
                row.appendChild(span);
                return row;
            };

            const mkInput = (type: string, val: string | number, key: string, onChange: (v: string) => void): HTMLInputElement => {
                const inp = document.createElement('input');
                inp.type = type;
                if (type === 'number') inp.step = 'any';
                inp.value = String(val);
                inp.style.width = '100%';
                inp.style.fontSize = '9px';
                inp.style.background = '#1a1a1c';
                inp.style.color = '#ccc';
                inp.style.border = '1px solid #333';
                inp.style.padding = '1px 3px';
                inp.style.borderRadius = '2px';
                inp.style.boxSizing = 'border-box';
                inp.onchange = () => onChange(inp.value);
                inp.addEventListener('mousedown', e => e.stopPropagation());
                return inp;
            };

            // FORMAT
            mkSection('FORMAT');
            const formatGrid = document.createElement('div');
            formatGrid.style.display = 'grid';
            formatGrid.style.gridTemplateColumns = 'repeat(2, 1fr)';
            formatGrid.style.gap = '4px';
            formatGrid.appendChild(createCheckboxField('export_ascii', !!node.parameters?.export_ascii, 'ASCII'));
            formatGrid.appendChild(createCheckboxField('export_binary', !!node.parameters?.export_binary, 'Binary'));
            formatGrid.appendChild(createCheckboxField('export_hdf5', !!node.parameters?.export_hdf5, 'HDF5'));
            panelContent.appendChild(formatGrid);

            // CONFIG
            mkSection('CONFIG');
            const delimSel = document.createElement('select');
            delimSel.style.width = '100%';
            delimSel.style.background = '#1a1a1c';
            delimSel.style.color = '#ccc';
            delimSel.style.border = '1px solid #333';
            delimSel.style.borderRadius = '3px';
            delimSel.style.fontSize = '9px';
            delimSel.style.padding = '1px';
            delimSel.innerHTML = '<option value=",">Comma (,)</option><option value="\\t">Tab (\\t)</option><option value=" ">Space ( )</option>';
            delimSel.value = node.parameters?.ascii_delimiter || ',';
            delimSel.onchange = () => {
                this.stateManager.updateNodeParameters(node.id, { ascii_delimiter: delimSel.value });
            };
            delimSel.onmousedown = (e) => e.stopPropagation();
            panelContent.appendChild(mkRow('ASCII DELIMITER', delimSel));

            const precInput = mkInput('number', node.parameters?.ascii_precision ?? 6, 'ascii_precision', (v) => {
                this.stateManager.updateNodeParameters(node.id, { ascii_precision: Number(v) });
            });
            panelContent.appendChild(mkRow('ASCII PRECISION', precInput));

            panelContent.appendChild(createCheckboxField('include_header', node.parameters?.include_header !== false, 'Include Header'));

            const strideSel = document.createElement('select');
            strideSel.style.width = '100%';
            strideSel.style.background = '#1a1a1c';
            strideSel.style.color = '#ccc';
            strideSel.style.border = '1px solid #333';
            strideSel.style.borderRadius = '3px';
            strideSel.style.fontSize = '9px';
            strideSel.style.padding = '1px';
            
            const STRIDES = [
                { value: 1, label: 'Every step' },
                { value: 2, label: 'Every 2 steps' },
                { value: 5, label: 'Every 5 steps' },
                { value: 10, label: 'Every 10 steps' },
                { value: 20, label: 'Every 20 steps' },
                { value: 50, label: 'Every 50 steps' },
                { value: 100, label: 'Every 100 steps' }
            ];
            STRIDES.forEach(s => {
                const opt = document.createElement('option');
                opt.value = String(s.value);
                opt.textContent = s.label;
                if (Number(node.parameters?.plot_stride ?? 1) === s.value) opt.selected = true;
                strideSel.appendChild(opt);
            });
            strideSel.onchange = () => {
                this.stateManager.updateNodeParameters(node.id, { plot_stride: Number(strideSel.value) });
            };
            strideSel.onmousedown = (e) => e.stopPropagation();
            panelContent.appendChild(mkRow('PLOT STRIDE', strideSel));

            // FILE
            mkSection('FILE');
            const fileInput = mkInput('text', node.parameters?.custom_filename ?? '', 'custom_filename', (v) => {
                this.stateManager.updateNodeParameters(node.id, { custom_filename: v });
            });
            panelContent.appendChild(mkRow('FILENAME', fileInput));

            const dirWrap = document.createElement('div');
            dirWrap.style.display = 'flex';
            dirWrap.style.gap = '4px';

            const dirInput = mkInput('text', node.parameters?.output_dir ?? '', 'output_dir', (v) => {
                this.stateManager.updateNodeParameters(node.id, { output_dir: v });
            });
            dirInput.style.flex = '1';
            dirWrap.appendChild(dirInput);

            const browseBtn = document.createElement('button');
            browseBtn.textContent = '...';
            browseBtn.style.padding = '1px 6px';
            browseBtn.style.fontSize = '9px';
            browseBtn.style.background = '#333';
            browseBtn.style.color = '#ccc';
            browseBtn.style.border = '1px solid #444';
            browseBtn.style.borderRadius = '3px';
            browseBtn.style.cursor = 'pointer';
            browseBtn.onmousedown = (e) => e.stopPropagation();
            browseBtn.onclick = () => {
                const modal = new HostFileBrowserModal(
                    (window as any).networkManager,
                    'save',
                    '',
                    (folderPath) => {
                        this.stateManager.updateNodeParameters(node.id, { output_dir: folderPath });
                    }
                );
                modal.open(node.parameters?.output_dir || '');
            };
            dirWrap.appendChild(browseBtn);
            panelContent.appendChild(mkRow('OUTPUT DIR', dirWrap));

            // QUANTITIES
            mkSection('QUANTITIES');
            const qtyGrid = document.createElement('div');
            qtyGrid.style.display = 'grid';
            qtyGrid.style.gridTemplateColumns = 'repeat(2, 1fr)';
            qtyGrid.style.gap = '4px';
            qtyGrid.appendChild(createCheckboxField('qty_pressure', !!node.parameters?.qty_pressure, 'Pressure'));
            qtyGrid.appendChild(createCheckboxField('qty_density', !!node.parameters?.qty_density, 'Density'));
            qtyGrid.appendChild(createCheckboxField('qty_velocity', !!node.parameters?.qty_velocity, 'Velocity'));
            qtyGrid.appendChild(createCheckboxField('qty_energy', !!node.parameters?.qty_energy, 'Energy'));
            qtyGrid.appendChild(createCheckboxField('qty_reacted', !!node.parameters?.qty_reacted, 'Reacted'));
            qtyGrid.appendChild(createCheckboxField('qty_unreacted', !!node.parameters?.qty_unreacted, 'Unreacted'));
            qtyGrid.appendChild(createCheckboxField('qty_air', !!node.parameters?.qty_air, 'Air'));
            qtyGrid.appendChild(createCheckboxField('qty_overpressure', !!node.parameters?.qty_overpressure, 'Overpressure'));
            qtyGrid.appendChild(createCheckboxField('qty_impulse', !!node.parameters?.qty_impulse, 'Impulse'));
            panelContent.appendChild(qtyGrid);
        }

        if (oldScrollTop > 0) {
            panelContent.scrollTop = oldScrollTop;
        }

        // Draw chart and automatically adjust layout and canvas resolution when resized
        const history = this.stateManager.getTelemetry(node.id);
        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) {
                canvas.width = canvas.clientWidth || 250;
                canvas.height = canvas.clientHeight || 100;
                if (history) {
                    this.drawGaugesChart(canvas, history, gauges, currentChannel, has2D, node.id);
                }
            }
        });
        ro.observe(canvasContainer);

        // Restore focus if we tabbed or pressed enter
        if (activeTab === 'list') {
            const table = container.querySelector('table') as HTMLTableElement;
            if (table) {
                const inputs = Array.from(table.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
                if (this.tabbedFromId) {
                    const idx = inputs.findIndex(inp => inp.id === this.tabbedFromId);
                    if (idx !== -1) {
                        if (this.isTabbingForward && idx < inputs.length - 1) {
                            inputs[idx + 1].focus();
                            inputs[idx + 1].select();
                        } else if (this.isTabbingBackward && idx > 0) {
                            inputs[idx - 1].focus();
                            inputs[idx - 1].select();
                        }
                    }
                    this.tabbedFromId = null;
                    this.isTabbingForward = false;
                    this.isTabbingBackward = false;
                } else if (this.pressedEnterOnId) {
                    const idx = inputs.findIndex(inp => inp.id === this.pressedEnterOnId);
                    if (idx !== -1) {
                        inputs[idx].focus();
                        inputs[idx].select();
                    }
                    this.pressedEnterOnId = null;
                }
            }
        }
    }

    private drawGaugesChart(canvas: HTMLCanvasElement, history: any, gauges: any[], channel: number, has2D: boolean, nodeId: string): void {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;

        ctx.clearRect(0, 0, width, height);

        // If no data
        if (!history || !history.times || history.times.length === 0 || gauges.length === 0) {
            ctx.fillStyle = '#666';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Waiting for telemetry...', width / 2, height / 2);
            return;
        }

        const times = history.times;
        const values = history.values; // Record<gaugeId, Record<channelIdx, number[]>>

        const defaultMinX = 0;
        const defaultMaxX = times.length - 1 || 1;

        let activeMinX = defaultMinX;
        let activeMaxX = defaultMaxX;

        const zoomedOrPanned = this.gaugesZoomedOrPanned.get(nodeId) || false;
        if (zoomedOrPanned) {
            activeMinX = this.gaugesZoomMinX.get(nodeId) ?? defaultMinX;
            activeMaxX = this.gaugesZoomMaxX.get(nodeId) ?? defaultMaxX;
        } else {
            this.gaugesZoomMinX.set(nodeId, defaultMinX);
            this.gaugesZoomMaxX.set(nodeId, defaultMaxX);
        }

        // Find min/max values for scaling over visible range
        let minVal = Infinity;
        let maxVal = -Infinity;
        let hasData = false;

        const startIdx = zoomedOrPanned ? Math.max(0, Math.floor(activeMinX)) : 0;
        const endIdx = zoomedOrPanned ? Math.min(times.length - 1, Math.ceil(activeMaxX)) : times.length - 1;

        gauges.filter(g => g.plot !== false).forEach(g => {
            const gData = values[g.id || g.name];
            if (gData && gData[channel]) {
                const arr = gData[channel];
                const limit = Math.min(arr.length - 1, endIdx);
                for (let i = startIdx; i <= limit; i++) {
                    const v = arr[i];
                    if (isFinite(v)) {
                        if (v < minVal) minVal = v;
                        if (v > maxVal) maxVal = v;
                        hasData = true;
                    }
                }
            }
        });

        if (!hasData) {
            ctx.fillStyle = '#666';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('No gauge data for selected channel', width / 2, height / 2);
            return;
        }

        const paddingLeft = 50;
        const paddingRight = 10;
        const paddingTop = 15;
        const paddingBottom = 25;
        const plotWidth = width - paddingLeft - paddingRight;
        const plotHeight = height - paddingTop - paddingBottom;

        let activeMinY = minVal;
        let activeMaxY = maxVal;
        if (activeMinY === activeMaxY) {
            activeMinY -= 1.0;
            activeMaxY += 1.0;
        } else {
            const yRange = activeMaxY - activeMinY;
            activeMinY -= yRange * 0.05;
            activeMaxY += yRange * 0.05;
        }

        const activeRangeY = activeMaxY - activeMinY || 1;

        // Draw grid/bounds labels
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(paddingLeft, paddingTop);
        ctx.lineTo(paddingLeft, height - paddingBottom);
        ctx.lineTo(width - paddingRight, height - paddingBottom);
        ctx.stroke();

        ctx.fillStyle = '#888';
        ctx.font = '8px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';

        const numTicksY = 4;
        for (let i = 0; i < numTicksY; i++) {
            const pct = i / (numTicksY - 1);
            const val = activeMinY + pct * activeRangeY;
            const y = height - paddingBottom - pct * plotHeight;
            
            ctx.strokeStyle = '#333';
            ctx.beginPath();
            ctx.moveTo(paddingLeft - 4, y);
            ctx.lineTo(paddingLeft, y);
            ctx.stroke();
            
            ctx.fillText(val.toExponential(1), paddingLeft - 4, y);
        }

        // Display start and end times at the bottom of the chart
        const getTimeAtIndex = (idx: number) => {
            if (!times || times.length === 0) return 0;
            const low = Math.max(0, Math.min(times.length - 1, Math.floor(idx)));
            const high = Math.max(0, Math.min(times.length - 1, Math.ceil(idx)));
            if (low === high) return times[low];
            const frac = idx - low;
            return times[low] * (1 - frac) + times[high] * frac;
        };

        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const numTicksX = 4;
        const activeRangeX = activeMaxX - activeMinX || 1;
        for (let i = 0; i < numTicksX; i++) {
            const pct = i / (numTicksX - 1);
            const idx = activeMinX + pct * activeRangeX;
            const tVal = getTimeAtIndex(idx);
            const x = paddingLeft + pct * plotWidth;
            
            ctx.strokeStyle = '#333';
            ctx.beginPath();
            ctx.moveTo(x, height - paddingBottom);
            ctx.lineTo(x, height - paddingBottom + 4);
            ctx.stroke();
            
            ctx.fillText(`t=${tVal.toFixed(4)}s`, x, height - paddingBottom + 2);
        }

        ctx.save();
        ctx.beginPath();
        ctx.rect(paddingLeft, paddingTop, plotWidth, plotHeight);
        ctx.clip();

        // Draw curves
        const colors = ['#38bdf8', '#fb7185', '#34d399', '#fbbf24', '#a78bfa', '#2dd4bf'];
        gauges.filter(g => g.plot !== false).forEach((g, gIdx) => {
            const gData = values[g.id || g.name];
            if (gData && gData[channel]) {
                const arr = gData[channel];
                ctx.strokeStyle = colors[gIdx % colors.length];
                ctx.lineWidth = 1.5;
                ctx.beginPath();

                let first = true;
                arr.forEach((v: number, i: number) => {
                    if (i >= times.length) return;
                    const x = paddingLeft + ((i - activeMinX) / (activeMaxX - activeMinX || 1)) * plotWidth;
                    const y = height - paddingBottom - ((v - activeMinY) / activeRangeY) * plotHeight;
                    if (first) {
                        ctx.moveTo(x, y);
                        first = false;
                    } else {
                        ctx.lineTo(x, y);
                    }
                });
                ctx.stroke();
            }
        });

        ctx.restore();
    }

    private formatRangeValue(val: number): string {
        if (Math.abs(val) < 1e-3 || Math.abs(val) > 1e6) {
            return val.toExponential(4);
        }
        return val.toFixed(1);
    }

    private syncSliceConfig(node: Node, slices: any[]) {
        const worker = this.nodeWorkers.get(node.id);
        if (worker) {
            worker.postMessage({
                type: 'setConfig',
                data: {
                    slices: slices,
                    focusedSliceIndex: node.parameters?.focusedSliceIndex ?? 0,
                    quantityRanges: node.parameters?.quantity_ranges || {}
                }
            });
        }
        
        const net = (window as any).networkManager;
        if (net && net.isConnected()) {
            let targetModelId = node.id;
            const models = this.stateManager.getAppState().models;
            for (const [mid, m] of Object.entries(models)) {
                if (m.nodes.some(n => n.id === node.id)) {
                    targetModelId = mid;
                    break;
                }
            }
            const currentRate = Number(node.parameters?.refresh_rate ?? 2.0);
            net.send({ command: "VIEW3D_CONFIG", modelId: targetModelId, slices, refresh_rate: currentRate });
        }
    }

    public setSTLGeometry(nodeId: string, vertices: Float32Array | null, meshId: string = 'default'): void {
        const vp = this.viewport3Ds.get(nodeId);
        if (vp) {
            vp.setSTLGeometry(vertices, undefined, meshId);
        }
    }

    public setObstaclesGeometry(nodeId: string, vertices: Float32Array | null, cells: Int32Array | null, meshId: string = 'default'): void {
        const vp = this.viewport3Ds.get(nodeId);
        if (vp) {
            vp.setObstaclesGeometry(vertices, cells, undefined, meshId);
        }
    }

    private validateGraph(state: SimulationState): {
        nodeStatus: Record<string, { state: 'error' | 'warning' | 'valid'; messages: string[] }>;
        flawedConnections: Map<string, string>;
    } {
        return validateSimulationState(state);
    }
}

