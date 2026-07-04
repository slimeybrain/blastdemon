import { SimulationState, Node, Connection, Port, NodeType } from './types.js';
import { StateManager } from './state-manager.js';
import { validateSimulationState } from './validation.js';

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
    private graphFrameCounters: Map<string, number> = new Map();
    /** Set of node IDs whose resize handle is currently being dragged by the user. */
    private nodeUserResizing: Set<string> = new Set();
    private lastMouseX: number = 0;
    private lastMouseY: number = 0;
    /** Pending requestAnimationFrame handle for deferred wire redraws. */
    private connectionRafId: number | null = null;

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
                    const isTelemetry = node.type === 'TelemetryGraph' || node.type === 'TelemetryText' || node.type === 'TelemetryContour';
                    if (isTelemetry && node.displayMode !== 'compact') {
                        const isTelemetryText = node.type === 'TelemetryText';
                        if (!isTelemetryText || userIsResizing) {
                            node.width = newWidth;
                            node.height = newHeight;
                            changed = true;
                        }
                    }

                    // Automatic mode switching for telemetry nodes (only when user is resizing)
                    if (userIsResizing && (node.type === 'TelemetryText' || node.type === 'TelemetryGraph' || node.type === 'TelemetryContour')) {
                        let targetMode: 'compact' | 'normal' | 'expanded' = 'normal';
                        if (newHeight < 60) targetMode = 'compact';
                        else if (newHeight >= 180) targetMode = 'expanded';

                        if (node.displayMode !== targetMode) {
                            node.displayMode = targetMode;
                            changed = true;
                        }
                    }

                    // Notify worker of resize
                    if (node.type === 'TelemetryGraph' || node.type === 'TelemetryContour') {
                        const worker = this.nodeWorkers.get(nodeId);
                        if (worker) {
                            const canvas = target.querySelector('canvas');
                            if (canvas) {
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
        this.nodeWorkers.forEach(worker => worker.terminate());
        if (this.resizeObserver) this.resizeObserver.disconnect();
        if (this.nodeResizeObserver) this.nodeResizeObserver.disconnect();
        this.viewport.remove();
    }

    private addManagedEventListener(target: EventTarget, type: string, listener: any, options?: AddEventListenerOptions): void {
        target.addEventListener(type, listener, options);
        this.eventListeners.push({ target, type, listener });
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
                body.innerHTML = '';
                data.forEach(line => {
                    const lineEl = document.createElement('div');
                    lineEl.className = 'log-line';
                    lineEl.textContent = line;
                    body.appendChild(lineEl);
                });
                body.scrollTop = body.scrollHeight;
                
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

                const isTerminated = this.stateManager.getStatus() === 'TERMINATED';

                if (plotStride > 1 && currentCount % plotStride !== 0 && !isTerminated) {
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
                        const useRepresentative = node.displayMode === 'compact' || node.displayMode === 'full-panel'
                            || (node.type === 'TelemetryText' && (node.orientation || 'HORIZ') === 'HORIZ');
                        const inputsToCheck = useRepresentative ? (node.inputs.length > 0 ? [node.inputs[0]] : []) : node.inputs;
                        for (const input of inputsToCheck) {
                            const pos = this.getPortPosition(node, input.id, true);
                            if (pos) {
                                const dist = Math.sqrt(Math.pow(pos.x - worldPoint.x, 2) + Math.pow(pos.y - worldPoint.y, 2));
                                if (dist < 35) {
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
                                const dist = Math.sqrt(Math.pow(pos.x - worldPoint.x, 2) + Math.pow(pos.y - worldPoint.y, 2));
                                if (dist < 30) {
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
                    const existingIdx = state.connections.findIndex(conn =>
                        conn.toNode === this.hoveredPort!.nodeId &&
                        conn.toPort === this.hoveredPort!.portId
                    );
                    if (existingIdx !== -1) {
                        state.connections.splice(existingIdx, 1);
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
        if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;

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

        if (e.key === 'Escape' && this.isDraggingWire) {
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

        this.showContextMenu(e.clientX, e.clientY, worldX, worldY);
    }

    private showContextMenu(x: number, y: number, wx: number, wy: number): void {
        const existingMenu = document.querySelector('.context-menu');
        if (existingMenu) existingMenu.remove();

        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.onmousedown = (e) => e.stopPropagation();

        const nodeTypes: { label: string, type: NodeType }[] = [
            { label: 'Domain Mesh',              type: 'DomainMesh' },
            { label: 'Material - Air',           type: 'MaterialAir' },
            { label: 'Material - Explosive (JWL)', type: 'MaterialExplosive' },
            { label: 'Material - Ideal Gas',     type: 'MaterialIdealGas' },
            { label: 'Initializer',              type: 'ThePainter' },
            { label: 'CFD Solver',               type: 'CFDSolver' },
            { label: 'Telemetry - Text',         type: 'TelemetryText' },
            { label: 'Telemetry - Graph',        type: 'TelemetryGraph' },
            // 2D CFD Nodes
            { label: 'Domain Mesh 2D',           type: 'DomainMesh2D' },
            { label: 'Detonator Location',       type: 'DetonatorLocation' },
            { label: 'Remapper (1D -> 2D)',      type: 'RemapNode' },
            { label: 'CFD Solver 2D',            type: 'CFDSolver2D' },
            { label: 'Telemetry - Contour (2D)',  type: 'TelemetryContour' },
            { label: 'VTK Output Controls',      type: 'VTKOutput' },
            { label: 'Hardware Configuration',   type: 'HardwareConfig' }
        ];

        nodeTypes.forEach(nt => {
            const item = document.createElement('div');
            item.className = 'context-menu-item';
            item.textContent = nt.label;
            item.onclick = () => {
                this.addNode(nt.type, wx, wy);
                menu.remove();
            };
            menu.appendChild(item);
        });

        document.body.appendChild(menu);
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

        const prefixMap: Record<NodeType, string> = {
            'DomainMesh': 'node-mesh',
            'MaterialAir': 'node-air',
            'MaterialExplosive': 'node-explosive',
            'MaterialIdealGas': 'node-idealgas',
            'ThePainter': 'node-painter',
            'CFDSolver': 'node-solver',
            'TelemetryText': 'node-log',
            'TelemetryGraph': 'node-chart',
            'DomainMesh2D': 'node-mesh2d',
            'DetonatorLocation': 'node-detonator',
            'RemapNode': 'node-remap',
            'HardwareConfig': 'node-hardware',
            'CFDSolver2D': 'node-solver2d',
            'TelemetryContour': 'node-contour',
            'VTKOutput': 'node-vtk'
        };
        const prefix = prefixMap[type] || `node-${type.toLowerCase()}`;

        let index = 1;
        if (state.nodes.some(n => n.id === prefix)) {
            index = 2;
        }
        while (state.nodes.some(n => n.id === `${prefix}-${index}`)) {
            index++;
        }
        const id = index === 1 && !state.nodes.some(n => n.id === prefix) ? prefix : `${prefix}-${index}`;

        const newNode: Node = {
            id, type, x, y,
            displayMode: 'expanded',
            inputs: this.getDefaultInputs(type),
            outputs: this.getDefaultOutputs(type),
            parameters: this.getDefaultParameters(type)
        };

        if (type === 'TelemetryText' || type === 'TelemetryGraph') {
            newNode.width = 350;
            newNode.height = 220;
        } else if (type === 'TelemetryContour') {
            newNode.width = 350;
            newNode.height = 300;
        } else if (type === 'VTKOutput') {
            newNode.width = 250;
            newNode.height = 120;
        }

        state.nodes.push(newNode);
        this.stateManager.pushState(state);
    }

    private getDefaultInputs(type: NodeType): Port[] {
        switch (type) {
            case 'ThePainter': return [{ id: 'mesh', label: 'Mesh' }, { id: 'air', label: 'Air' }, { id: 'explosive', label: 'Explosive' }];
            case 'CFDSolver': return [{ id: 'in', label: 'Initial State' }];
            case 'TelemetryText':
            case 'TelemetryGraph': return [{ id: 'in', label: 'Data Stream' }];
            case 'CFDSolver2D': return [
                { id: 'mesh', label: 'Mesh' },
                { id: 'detonator', label: 'Detonator' },
                { id: 'remap', label: 'Remap' },
                { id: 'hardware', label: 'Hardware' },
                { id: 'air', label: 'Air' },
                { id: 'explosive', label: 'Explosive' },
                { id: 'ideal_gas', label: 'Ideal Gas' }
            ];
            case 'RemapNode': return [{ id: 'in', label: '1D Solver' }];
            case 'TelemetryContour': return [{ id: 'in', label: 'Data Stream' }];
            case 'VTKOutput': return [{ id: 'in', label: 'Solver' }];
            default: return [];
        }
    }

    private getDefaultOutputs(type: NodeType): Port[] {
        switch (type) {
            case 'DomainMesh': return [{ id: 'out', label: 'Mesh' }];
            case 'MaterialAir': return [{ id: 'out', label: 'Material' }];
            case 'MaterialExplosive': return [{ id: 'out', label: 'Material' }];
            case 'MaterialIdealGas': return [{ id: 'out', label: 'Material' }];
            case 'ThePainter': return [{ id: 'out', label: 'State' }];
            case 'CFDSolver': return [{ id: 'telemetry', label: 'Telemetry' }];
            case 'DomainMesh2D': return [{ id: 'mesh', label: 'Mesh Spec' }];
            case 'DetonatorLocation': return [{ id: 'detonator', label: 'Detonator Spec' }];
            case 'RemapNode': return [{ id: 'remap', label: 'Remap Spec' }];
            case 'HardwareConfig': return [{ id: 'hardware', label: 'Hardware Spec' }];
            case 'CFDSolver2D': return [{ id: 'telemetry', label: 'Telemetry' }];
            default: return [];
        }
    }

    private getDefaultParameters(type: NodeType): any {
        switch (type) {
            case 'DomainMesh': return {
                dimension: '1D',
                domain_radius: 1.0,
                cell_size: 0.001,
                x_min_bc: 'Reflecting',
                x_max_bc: 'Terminate',
                y_min_bc: 'Reflecting',
                y_max_bc: 'Reflecting',
                z_min_bc: 'Reflecting',
                z_max_bc: 'Reflecting'
            };
            case 'MaterialAir': return {
                gamma: 1.4,
                atm_pressure: 101325,
                atm_temperature: 298.15
            };
            case 'MaterialExplosive': return {
                composition: 'TNT',
                charge_mass: 1.0,
                rho: 1630,
                detonation_energy: 4290000,
                det_vel: 6930,
                jwl_A: 373.77e9,
                jwl_B: 3.747e9,
                jwl_R1: 4.15,
                jwl_R2: 0.90,
                jwl_omega: 0.35
            };
            case 'MaterialIdealGas': return {
                charge_mass: 1.0,
                rho: 1630,
                detonation_energy: 4520000
            };
            case 'CFDSolver': return {
                init_mode: 'Multi-Material JWL',
                cfl: 0.4,
                flux_scheme: 'AUSM+',
                spatial_order: 2,
                temporal_order: 2,
                output_mode: 'By Time',
                output_interval: 0.0001
            };
            case 'TelemetryGraph': return { telemetry_channel: 0, x_axis_mode: 'radius', plot_stride: 1 };
            case 'DomainMesh2D': return {
                nr: 200,
                nz: 200,
                max_r: 1.0,
                max_z: 1.0,
                bc_r_min: 'Reflecting',
                bc_r_max: 'Terminate',
                bc_z_min: 'Reflecting',
                bc_z_max: 'Terminate',
                coordinate_system: 'Axisymmetric'
            };
            case 'DetonatorLocation': return {
                explosive_z: 0.0,
                explosive_r: 0.0,
                explosive_radius: 0.1
            };
            case 'RemapNode': return {
                explosive_z: 0.0,
                explosive_r: 0.0,
                remap_radius: 0.5,
                trigger_type: 'end'
            };
            case 'HardwareConfig': return {
                device: 'cpu'
            };
            case 'CFDSolver2D': return {
                init_mode: 'From1D',
                cfl: 0.35,
                flux_scheme: 'AUSM+',
                spatial_order: 2,
                temporal_order: 2
            };
            case 'TelemetryContour': return {
                telemetry_channel: 0,
                auto_scale: true
            };
            case 'VTKOutput': return {
                vtk_dir: './vtk_output'
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
            case 'MaterialAir':     return 'AIR';
            case 'MaterialExplosive': return 'HE-JWL';
            case 'MaterialIdealGas': return 'IG-CHG';
            case 'ThePainter':      return 'INIT';
            case 'CFDSolver':       return 'SOLVER';
            case 'TelemetryText':   return 'LOG';
            case 'TelemetryGraph':  return 'CHART';
            case 'DomainMesh2D':    return 'MESH2D';
            case 'DetonatorLocation': return 'DETONATOR';
            case 'RemapNode':       return 'REMAP';
            case 'HardwareConfig':   return 'HARDWARE';
            case 'CFDSolver2D':     return 'SOLVER2D';
            case 'TelemetryContour': return 'CONTOUR';
            case 'VTKOutput':       return 'VTK';
            default: return (type as string).toUpperCase();
        }
    }

    private getFullNodeName(type: NodeType): string {
        switch (type) {
            case 'DomainMesh':        return 'Domain Mesh';
            case 'MaterialAir':       return 'Material - Air';
            case 'MaterialExplosive': return 'Material - Explosive (JWL)';
            case 'MaterialIdealGas':  return 'Material - Ideal Gas';
            case 'ThePainter':        return 'Initializer';
            case 'CFDSolver':         return 'CFD Solver';
            case 'TelemetryText':     return 'Telemetry - Text';
            case 'TelemetryGraph':    return 'Telemetry - Graph';
            case 'DomainMesh2D':      return 'Domain Mesh 2D';
            case 'DetonatorLocation': return 'Detonator Location';
            case 'RemapNode':         return 'Remapper (1D -> 2D)';
            case 'HardwareConfig':    return 'Hardware Configuration';
            case 'CFDSolver2D':       return 'CFD Solver 2D';
            case 'TelemetryContour':  return 'Telemetry - Contour (2D)';
            case 'VTKOutput':         return 'VTK Output Controls';
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
                this.graphFrameCounters.delete(id);
            }
        }

        state.nodes.forEach(node => {
            try {
                let nodeEl = this.nodeElements.get(node.id);
                if (!nodeEl) {
                    nodeEl = document.createElement('div');
                    nodeEl.className = 'node';
                    if (node.type === 'TelemetryGraph' || node.type === 'TelemetryText' || node.type === 'TelemetryContour') {
                        nodeEl.classList.add('resizable');
                        if (node.width === undefined) node.width = node.type === 'TelemetryContour' ? 350 : 250;
                        if (node.height === undefined) {
                            if (node.type === 'TelemetryContour') node.height = 300;
                            else if (node.type === 'TelemetryGraph') node.height = 150;
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
                        infoOverlay.innerHTML = `
                            <div class="node-info-overlay-title">${node.type} Info</div>
                            <div class="node-info-overlay-body">${this.getNodeDescription(node.type)}</div>
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



                const displayMode = node.displayMode || 'normal';
                const nodeOrientation = node.orientation || 'HORIZ';

                const isTelemetry = node.type === 'TelemetryGraph' || node.type === 'TelemetryText' || node.type === 'TelemetryContour';

                // Only override the element's inline width/height from state when the
                // user is NOT actively dragging the native resize handle. Mid-drag, the
                // browser owns those inline styles; writing from state here would jump
                // the node back to the previously-stored (stale) size.
                const isBeingResized = this.nodeUserResizing.has(node.id);
                if (!isBeingResized) {
                    if (node.width !== undefined && displayMode !== 'compact' && isTelemetry) {
                        const newWidth = `${node.width}px`;
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
                            // TelemetryText (HORIZ, normal/expanded): use a representative
                            // anchor that sits at the node's left-centre, identical to what
                            // compact mode uses. Because the representative port is NOT part
                            // of the flex-content flow, it cannot be pushed out of place when
                            // the log body fills with text.
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
                    if (node.type === 'TelemetryText' || node.type === 'TelemetryGraph' || node.type === 'TelemetryContour') {
                        contentEl.style.display = 'flex';
                        this.renderTelemetryContent(node, contentEl);
                    } else {
                        contentEl.style.display = 'none';
                    }
                } else {
                    contentEl.style.display = 'flex';
                    this.renderNodeParameters(node, contentEl);
                    if (node.type === 'TelemetryText' || node.type === 'TelemetryGraph' || node.type === 'TelemetryContour') {
                        this.renderTelemetryContent(node, contentEl);
                    }
                }

            } catch (e) {
                console.error(`Failed to render node ${node.id}:`, e);
            }
        });
    }

    private getModelColors(modelId: string): { base: string, faint: string } {
        let hash = 0;
        for (let i = 0; i < modelId.length; i++) {
            hash = modelId.charCodeAt(i) + ((hash << 5) - hash);
        }
        const h = Math.abs(hash) % 360;
        return {
            base: `hsl(${h}, 75%, 60%)`,
            faint: `hsla(${h}, 75%, 60%, 0.04)`
        };
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

            rect.addEventListener('mousedown', handleModelMouseDown);
            label.addEventListener('mousedown', handleModelMouseDown);
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
                path.setAttribute('stroke', '#ef4444');
                path.setAttribute('stroke-width', '3');
            } else if (fromModelId && toModelId && fromModelId === toModelId) {
                const colors = this.getModelColors(fromModelId);
                path.setAttribute('stroke', colors.base);
                path.setAttribute('stroke-width', '2');
            } else {
                path.setAttribute('stroke', '#a855f7');
                path.setAttribute('stroke-dasharray', '2, 2');
                path.setAttribute('stroke-width', '2');
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
        if (nodeType === 'MaterialExplosive' || portId === 'explosive') return 'explosive';
        if (nodeType === 'MaterialIdealGas' || portId === 'ideal_gas') return 'material';
        if (nodeType === 'DetonatorLocation' || portId === 'detonator') return 'detonator';
        if (nodeType === 'RemapNode' || portId === 'remap') return 'remap';
        if (nodeType === 'HardwareConfig' || portId === 'hardware') return 'hardware';
        if (portId === 'telemetry' || (portId === 'in' && (nodeType === 'TelemetryText' || nodeType === 'TelemetryGraph' || nodeType === 'TelemetryContour'))) return 'telemetry';
        return 'material';
    }

    private getPortPosition(node: Node, portId: string, isInput: boolean): { x: number, y: number } | null {
        // compact, full-panel, and TelemetryText (all HORIZ modes) use representative bullets
        const useRepresentative = node.displayMode === 'compact' || node.displayMode === 'full-panel'
            || (node.type === 'TelemetryText' && (node.orientation || 'HORIZ') === 'HORIZ');
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

            const meshNode = this.stateManager.getCurrentState()?.nodes.find(n => n.type === 'DomainMesh');
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
        } else if (node.type === 'TelemetryContour') {
            const CHANNELS: { label: string }[] = [
                { label: 'Pressure' },
                { label: 'Density' },
                { label: 'Radial Vel' },
                { label: 'Axial Vel' },
                { label: 'Spec Energy' },
                { label: 'Burn Frac' },
                { label: 'Unburnt Frac' }
            ];
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
                { value: '0.05', label: '20 FPS (0.05s)' },
                { value: '0.1', label: '10/s' },
                { value: '0.2', label: '5/s' },
                { value: '0.5', label: '2/s' },
                { value: '1.0', label: '1/s' },
                { value: '2.0', label: '0.5/s' },
                { value: '5.0', label: 'Manual' }
            ];

            const state = this.stateManager.getCurrentState();
            let isAxisymmetric = true;
            if (state) {
                const conn = state.connections.find(c => c.toNode === node.id && c.toPort === 'in');
                const solverNode = conn ? state.nodes.find(n => n.id === conn.fromNode) : null;
                if (solverNode && solverNode.type === 'CFDSolver2D') {
                    const meshConn = state.connections.find(c => c.toNode === solverNode.id && c.toPort === 'mesh');
                    const meshNode = meshConn ? state.nodes.find(n => n.id === meshConn.fromNode) : null;
                    if (meshNode && meshNode.type === 'DomainMesh2D') {
                        isAxisymmetric = (meshNode.parameters?.coordinate_system ?? 'Axisymmetric') === 'Axisymmetric';
                    }
                }
            }

            const worker = this.nodeWorkers.get(node.id);
            if (worker) {
                worker.postMessage({
                    type: 'setConfig',
                    channel: currentChannel,
                    stride: 1,
                    refreshRate: currentRate,
                    autoScale: node.parameters?.auto_scale !== false,
                    min: node.parameters?.min_y !== undefined ? Number(node.parameters.min_y) : 0,
                    max: node.parameters?.max_y !== undefined ? Number(node.parameters.max_y) : 1,
                    isAxisymmetric: isAxisymmetric
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

                const graphBody = document.createElement('div');
                graphBody.className = 'node-body-graph';
                graphBody.style.flex = '1';
                container.appendChild(graphBody);

                const canvas = document.createElement('canvas');
                canvas.style.width = '100%';
                canvas.style.height = '100%';
                graphBody.appendChild(canvas);

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
                    autoScale: node.parameters?.auto_scale !== false,
                    min: node.parameters?.min_y !== undefined ? Number(node.parameters.min_y) : 0,
                    max: node.parameters?.max_y !== undefined ? Number(node.parameters.max_y) : 1,
                    isAxisymmetric: isAxisymmetric
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
            }
        }
    }

    private renderNodeParameters(node: Node, container: HTMLElement): void {
        if (node.type === 'TelemetryGraph' || node.type === 'TelemetryContour') {
            const form = container.querySelector('.node-params-form');
            if (form) form.remove();
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
            if (node.type === 'MaterialExplosive') {
                const comp = node.parameters['composition'] || 'TNT';
                if (form.dataset.renderedComposition !== comp.toString()) {
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
                                input.value = value.toString();
                            }
                        }
                    }
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
        if (node.type === 'MaterialExplosive') {
            const comp = node.parameters['composition'] || 'TNT';
            form.dataset.renderedComposition = comp.toString();
        }

        for (const [key, value] of Object.entries(node.parameters)) {
            if (node.type === 'DomainMesh') {
                const dim = node.parameters['dimension'] || '1D';
                if ((key === 'y_min_bc' || key === 'y_max_bc') && dim === '1D') continue;
                if ((key === 'z_min_bc' || key === 'z_max_bc') && (dim === '1D' || dim === '2D')) continue;
            }
            if (node.type === 'MaterialExplosive') {
                const comp = node.parameters['composition'] || 'TNT';
                const customKeys = ['det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'];
                if (comp !== 'Custom' && customKeys.includes(key)) continue;
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
                'dimension': ['1D', '2D', '3D'],
                'x_min_bc': ['Reflecting', 'Transmitting', 'Terminate'],
                'x_max_bc': ['Reflecting', 'Transmitting', 'Terminate'],
                'y_min_bc': ['Reflecting', 'Transmitting', 'Terminate'],
                'y_max_bc': ['Reflecting', 'Transmitting', 'Terminate'],
                'z_min_bc': ['Reflecting', 'Transmitting', 'Terminate'],
                'z_max_bc': ['Reflecting', 'Transmitting', 'Terminate'],
                'left_bc': ['Reflecting', 'Transmitting', 'Terminate'],
                'right_bc': ['Reflecting', 'Transmitting', 'Terminate'],
                'bc_r_min': ['Reflecting', 'Transmitting', 'Terminate'],
                'bc_r_max': ['Reflecting', 'Transmitting', 'Terminate'],
                'bc_z_min': ['Reflecting', 'Transmitting', 'Terminate'],
                'bc_z_max': ['Reflecting', 'Transmitting', 'Terminate'],
                'coordinate_system': ['Axisymmetric', 'Cartesian'],
                'device': ['cpu', 'cuda'],
                'trigger_type': ['end', 'time', 'step'],
                // Explosive composition — JWL parameter sets (Ideal Gas uses its own node)
                'composition': ['TNT', 'PETN', 'RDX', 'Custom'],
                'init_mode': ['From1D', 'Multi-Material JWL', 'Ideal Gas'],
                'flux_scheme': ['AUSM+', 'Rusanov'],
                'spatial_order': ['1', '2', '3'],
                'temporal_order': ['1', '2', '3', '4'],
                'output_mode': ['By Step', 'By Time'],
                'plot_stride': ['1', '2', '5', '10', '20', '50', '100']
            };

            let inputEl: HTMLElement;
            if (dropdowns[key]) {
                inputEl = this.createCustomDropdown(
                    dropdowns[key].map(opt => ({ value: opt, label: opt })),
                    value.toString(),
                    (newVal) => {
                        console.log("[DEBUG] Custom Dropdown onChange triggered:", key, newVal, "for node:", node.id);
                        const numericKeys = [
                            'domain_radius', 'cell_size', 'atm_pressure', 'atm_temperature',
                            'charge_mass', 'rho', 'detonation_energy', 'jwl_A', 'jwl_B',
                            'jwl_R1', 'jwl_R2', 'jwl_omega', 'det_vel', 'cfl', 'output_interval',
                            'spatial_order', 'temporal_order', 'gamma', 'plot_stride',
                            // 2D CFD keys
                            'nr', 'nz', 'max_r', 'max_z', 'explosive_z', 'explosive_radius', 'remap_radius', 'explosive_r'
                        ];
                        const castValue = numericKeys.includes(key) ? Number(newVal) : newVal;
                        const updates: Record<string, any> = { [key]: castValue };
                        if (node.type === 'MaterialExplosive' && key === 'composition') {
                            const EXPLOSIVE_PRESETS: Record<string, Record<string, number>> = {
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
                                }
                            };
                            const preset = EXPLOSIVE_PRESETS[newVal];
                            if (preset) {
                                Object.assign(updates, preset);
                            }
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
                input.value = value.toString();
                input.dataset.key = key;
                input.style.width = '100%';
                input.style.fontSize = 'var(--font-xs)';
                input.style.background = '#222';
                input.style.color = '#ccc';
                input.style.border = '1px solid #444';
                input.style.padding = '1px 2px';

                input.addEventListener('change', () => {
                    const newVal = isNumeric ? Number(input.value) : input.value;
                    this.stateManager.updateNodeParameters(node.id, { [key]: newVal });
                });
                inputEl = input;
            }

            inputEl.addEventListener('mousedown', (e) => e.stopPropagation());
            row.appendChild(inputEl);
            form.appendChild(row);
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
            case 'MaterialAir':
                return 'Air material initialization. Configures ambient atmospheric pressure, temperature, and adiabatic index (gamma).';
            case 'MaterialExplosive':
                return 'High-explosive charge — Multi-Material JWL mode. Picks pre-calibrated JWL EOS from TNT/PETN/RDX table. Use when init_mode = Multi-Material JWL on the CFD Solver.';
            case 'MaterialIdealGas':
                return 'Ideal-gas explosive charge. Defines a hot pressurised sphere using a simple (gamma-1)·rho·e_int equation of state. Pair with init_mode = Ideal Gas on the CFD Solver.';
            case 'ThePainter':
                return 'Initial conditions painter. Maps mesh cells to physical material states for the simulation starting phase.';
            case 'CFDSolver':
                return 'High-order CFD simulation engine. Solves Euler equations using high-resolution reconstruction and flux splitting schemes. Set init_mode to select between a single-material Ideal Gas run or a full Multi-Material JWL detonation simulation.';
            case 'TelemetryText':
                return 'Live text stream telemetry logger. Outputs simulator event timelines, iteration milestones, and system states.';
            case 'TelemetryGraph':
                return 'Real-time chart telemetry viewer. Plots grid spatial properties, cell pressure profiles, and simulation telemetry histories.';
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
        if (node.displayMode === 'compact') return 100;
        if (node.width !== undefined) return node.width;
        return 200;
    }

    private getNodeEstimatedHeight(node: Node): number {
        if (node.displayMode === 'compact') return 40;
        if (node.height !== undefined) return node.height;

        let base = 30; // Header
        if (node.displayMode === 'normal') {
            if (node.type === 'TelemetryText') return 130;
            if (node.type === 'TelemetryGraph') return 150;
            if (node.type === 'TelemetryContour') return 300;
            base += Math.max(node.inputs.length, node.outputs.length) * 20;
        } else if (node.displayMode === 'expanded') {
            base += Object.keys(node.parameters).length * 25;
            if (node.type === 'TelemetryText') base += 100;
            if (node.type === 'TelemetryGraph') base += 120;
            if (node.type === 'TelemetryContour') base += 270;
            base += Math.max(node.inputs.length, node.outputs.length) * 20;
        }
        return Math.max(base, 60);
    }

    private validateGraph(state: SimulationState): {
        nodeStatus: Record<string, { state: 'error' | 'warning' | 'valid'; messages: string[] }>;
        flawedConnections: Map<string, string>;
    } {
        return validateSimulationState(state);
    }
}

