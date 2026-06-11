import { SimulationState, Node, Connection, Port, NodeType } from './types.js';
import { StateManager } from './state-manager.js';

export class GraphRenderer {
    public viewport: HTMLElement;
    private container: HTMLElement;
    private svg: SVGSVGElement;
    private stateManager: StateManager;
    private panelId: string;

    private zoom: number = 1.0;
    private panX: number = 0;
    private panY: number = 0;

    private isPanning: boolean = false;
    private isDraggingNode: boolean = false;
    private draggedNodeId: string | null = null;
    private dragOffsetX: number = 0;
    private dragOffsetY: number = 0;

    private isDraggingWire: boolean = false;
    private dragSourceNodeId: string | null = null;
    private dragSourcePortId: string | null = null;
    private mouseWorldPosition: { x: number, y: number } = { x: 0, y: 0 };
    private hoveredPort: { nodeId: string, portId: string, isInput: boolean } | null = null;

    private nodeElements: Map<string, HTMLElement> = new Map();
    private nodeWorkers: Map<string, Worker> = new Map();
    private lastMouseX: number = 0;
    private lastMouseY: number = 0;

    private selectedNodeId: string | null = null;
    private spacePressed: boolean = false;
    private layoutOrientation: 'HORIZ' | 'VERT' = 'HORIZ';

    public onNodeSelected: ((nodeId: string | null) => void) | null = null;

    private eventListeners: { target: EventTarget, type: string, listener: EventListener }[] = [];
    private resizeObserver: ResizeObserver | null = null;
    private nodeResizeObserver: ResizeObserver | null = null;

    private stateListener = () => this.render();
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
        this.stateManager.onStateChange(this.stateListener);
        this.stateManager.onTelemetryUpdate(this.telemetryListener);
        this.stateManager.onSelectionChange(this.selectionListener);

        this.resizeObserver = new ResizeObserver(() => this.render());
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

                // Use offsetWidth/Height for border-box dimensions, consistent with CSS sizing
                const newWidth = Math.round(target.offsetWidth);
                const newHeight = Math.round(target.offsetHeight);

                // Guard against zero-size updates and unnecessary state noise
                if (newWidth > 0 && newHeight > 0 && (node.width !== newWidth || node.height !== newHeight)) {
                    node.width = newWidth;
                    node.height = newHeight;
                    changed = true;

                    // Automatic mode switching for telemetry nodes
                    if (node.type === 'TelemetryText' || node.type === 'TelemetryGraph') {
                        let targetMode: 'compact' | 'normal' | 'expanded' = 'normal';
                        if (newHeight < 60) targetMode = 'compact';
                        else if (newHeight >= 180) targetMode = 'expanded';

                        if (node.displayMode !== targetMode) {
                            node.displayMode = targetMode;
                        }
                    }

                    // Notify worker of resize if it's a TelemetryGraph
                    if (node.type === 'TelemetryGraph') {
                        const worker = this.nodeWorkers.get(nodeId);
                        if (worker) {
                            const canvas = target.querySelector('canvas');
                            if (canvas) {
                                worker.postMessage({
                                    type: 'resize',
                                    width: canvas.clientWidth,
                                    height: canvas.clientHeight
                                });
                            }
                        }
                    }
                }
            }

            if (changed) {
                this.stateManager.updateState(state, false);
                this.render();
            }
        });

        this.render();
    }

    public setLayoutOrientation(o: 'HORIZ' | 'VERT') {
        this.layoutOrientation = o;
        this.render();
    }

    public destroy(): void {
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
            }
        } else if (node.type === 'TelemetryGraph' && data) {
            const worker = this.nodeWorkers.get(node.id);
            if (worker) {
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
        }
    }

    private initEventListeners(): void {
        this.addManagedEventListener(this.viewport, 'wheel', this.onWheel.bind(this), { passive: false });
        this.addManagedEventListener(this.viewport, 'mousedown', this.onMouseDown.bind(this));
        this.addManagedEventListener(window, 'mousemove', this.onMouseMove.bind(this));
        this.addManagedEventListener(window, 'mouseup', this.onMouseUp.bind(this));

        this.addManagedEventListener(this.viewport, 'click', (e: MouseEvent) => {
            if (e.target === this.viewport || e.target === this.container || e.target === this.svg) {
                this.selectNode(null);
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
                        for (const input of node.inputs) {
                            const pos = this.getPortPosition(node, input.id, true);
                            if (pos) {
                                const dist = Math.sqrt(Math.pow(pos.x - worldPoint.x, 2) + Math.pow(pos.y - worldPoint.y, 2));
                                if (dist < 15) {
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
        } else if (this.isDraggingNode && this.draggedNodeId) {
            const state = this.stateManager.getCurrentState();
            if (state) {
                const node = state.nodes.find(n => n.id === this.draggedNodeId);
                if (node) {
                    const rect = this.viewport.getBoundingClientRect();
                    const worldX = (e.clientX - rect.left - this.panX) / this.zoom;
                    const worldY = (e.clientY - rect.top - this.panY) / this.zoom;

                    node.x = Math.round(worldX - this.dragOffsetX);
                    node.y = Math.round(worldY - this.dragOffsetY);

                    this.stateManager.updateState(state, false);
                }
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
                        for (const port of [...node.inputs.map(p => ({...p, isInput: true})), ...node.outputs.map(p => ({...p, isInput: false}))]) {
                            const pos = this.getPortPosition(node, port.id, port.isInput);
                            if (pos) {
                                const dist = Math.sqrt(Math.pow(pos.x - worldPoint.x, 2) + Math.pow(pos.y - worldPoint.y, 2));
                                if (dist < 10) {
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

        if (this.isDraggingWire) {
            this.isDraggingWire = false;
            this.render();
        }

        this.isPanning = false;
        this.isDraggingNode = false;
        this.draggedNodeId = null;
        this.viewport.style.cursor = 'crosshair';
    }

    private onKeyDown(e: KeyboardEvent): void {
        if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;

        if (e.code === 'Space') {
            this.spacePressed = true;
            if (!this.isDraggingNode) this.viewport.style.cursor = 'grab';
        }

        if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedNodeId) {
            const state = this.stateManager.getCurrentState();
            if (state) {
                state.nodes = state.nodes.filter(n => n.id !== this.selectedNodeId);
                state.connections = state.connections.filter(edge => edge.fromNode !== this.selectedNodeId && edge.toNode !== this.selectedNodeId);
                this.selectNode(null);
                this.stateManager.pushState(state);
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
            { label: 'Domain Mesh', type: 'DomainMesh' },
            { label: 'Material - Air', type: 'MaterialAir' },
            { label: 'Material - Explosive', type: 'MaterialExplosive' },
            { label: 'Initializer', type: 'ThePainter' },
            { label: 'CFD Solver', type: 'CFDSolver' },
            { label: 'Telemetry - Text', type: 'TelemetryText' },
            { label: 'Telemetry - Graph', type: 'TelemetryGraph' }
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

    private addNode(type: NodeType, x: number, y: number): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        const id = `node-${type.toLowerCase()}-${Date.now()}`;
        const newNode: Node = {
            id, type, x, y,
            displayMode: 'normal',
            inputs: this.getDefaultInputs(type),
            outputs: this.getDefaultOutputs(type),
            parameters: this.getDefaultParameters(type)
        };

        state.nodes.push(newNode);
        this.stateManager.pushState(state);
    }

    private getDefaultInputs(type: NodeType): Port[] {
        switch (type) {
            case 'ThePainter': return [{ id: 'mesh', label: 'Mesh' }, { id: 'air', label: 'Air' }, { id: 'explosive', label: 'Explosive' }];
            case 'CFDSolver': return [{ id: 'in', label: 'Initial State' }];
            case 'TelemetryText':
            case 'TelemetryGraph': return [{ id: 'in', label: 'Data Stream' }];
            default: return [];
        }
    }

    private getDefaultOutputs(type: NodeType): Port[] {
        switch (type) {
            case 'DomainMesh': return [{ id: 'out', label: 'Mesh' }];
            case 'MaterialAir': return [{ id: 'out', label: 'Material' }];
            case 'MaterialExplosive': return [{ id: 'out', label: 'Material' }];
            case 'ThePainter': return [{ id: 'out', label: 'State' }];
            case 'CFDSolver': return [{ id: 'telemetry', label: 'Telemetry' }];
            default: return [];
        }
    }

    private getDefaultParameters(type: NodeType): any {
        switch (type) {
            case 'DomainMesh': return { domain_radius: 1.0, cell_size: 0.001, left_bc: 'Reflecting', right_bc: 'Terminate' };
            case 'MaterialAir': return { atm_pressure: 101325, atm_temperature: 298.15 };
            case 'MaterialExplosive': return { charge_mass: 1.0, composition: 'TNT', rho: 1630, detonation_energy: 4520000 };
            case 'CFDSolver': return { cfl: 0.4, flux_scheme: 'AUSM+', spatial_order: 2, temporal_order: 2, output_mode: 'By Time', output_interval: 0.0001 };
            default: return {};
        }
    }

    private updateTransform(): void {
        this.container.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    }

    private selectNode(nodeId: string | null): void {
        this.stateManager.setSelectedNode(nodeId);
        this.handleSelectionChange(nodeId);
    }

    private handleSelectionChange(nodeId: string | null): void {
        this.selectedNodeId = nodeId;
        if (this.onNodeSelected) this.onNodeSelected(nodeId);
        this.render();
    }

    public render(): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;
        this.syncNodes(state);
        this.updateConnections(state);
        this.renderHoverHighlights();
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
            case 'DomainMesh': return 'MESH';
            case 'MaterialAir': return 'AIR';
            case 'MaterialExplosive': return 'EXPL';
            case 'ThePainter': return 'INIT';
            case 'CFDSolver': return 'SOLVER';
            case 'TelemetryText': return 'LOG';
            case 'TelemetryGraph': return 'CHART';
            default: return (type as string).toUpperCase();
        }
    }

    private syncNodes(state: SimulationState): void {
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
            }
        }

        state.nodes.forEach(node => {
            try {
                let nodeEl = this.nodeElements.get(node.id);
                if (!nodeEl) {
                    nodeEl = document.createElement('div');
                    nodeEl.className = 'node';
                    if (node.type === 'TelemetryGraph' || node.type === 'TelemetryText') {
                        nodeEl.classList.add('resizable');
                        if (node.width === undefined) node.width = 250;
                        if (node.height === undefined) node.height = node.type === 'TelemetryGraph' ? 150 : 130;
                    }
                    nodeEl.dataset.id = node.id;

                    const header = document.createElement('div');
                    header.className = 'node-header';
                    header.innerHTML = `<span>${this.getCompactName(node.type)}</span>`;

                    const collapseBtn = document.createElement('button');
                    collapseBtn.className = 'node-collapse-btn';
                    header.appendChild(collapseBtn);

                    collapseBtn.addEventListener('mousedown', (e) => e.stopPropagation());
                    collapseBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.stateManager.toggleNodeDisplayMode(node.id);
                    });

                    header.addEventListener('mousedown', (e) => {
                        if (this.spacePressed || e.button !== 0) return;
                        e.stopPropagation();
                        this.isDraggingNode = true;
                        this.draggedNodeId = node.id;
                        this.selectNode(node.id);

                        const rect = this.viewport.getBoundingClientRect();
                        const worldX = (e.clientX - rect.left - this.panX) / this.zoom;
                        const worldY = (e.clientY - rect.top - this.panY) / this.zoom;

                        this.dragOffsetX = worldX - node.x;
                        this.dragOffsetY = worldY - node.y;
                    });
                    nodeEl.appendChild(header);

                    const content = document.createElement('div');
                    content.className = 'node-content';
                    nodeEl.appendChild(content);

                    const ports = document.createElement('div');
                    ports.className = 'node-ports';
                    nodeEl.appendChild(ports);

                    this.container.appendChild(nodeEl);
                    this.nodeElements.set(node.id, nodeEl);
                    this.nodeResizeObserver?.observe(nodeEl);
                }

                const newLeft = `${node.x}px`;
                const newTop = `${node.y}px`;
                if (nodeEl.style.left !== newLeft) nodeEl.style.left = newLeft;
                if (nodeEl.style.top !== newTop) nodeEl.style.top = newTop;

                if (node.width !== undefined) {
                    const newWidth = `${node.width}px`;
                    if (nodeEl.style.width !== newWidth) nodeEl.style.width = newWidth;
                } else {
                    nodeEl.style.width = '';
                }

                if (node.height !== undefined) {
                    const newHeight = `${node.height}px`;
                    if (nodeEl.style.height !== newHeight) nodeEl.style.height = newHeight;
                } else {
                    nodeEl.style.height = '';
                }

                if (nodeEl.classList.contains('selected') !== (node.id === this.selectedNodeId)) {
                    nodeEl.classList.toggle('selected', node.id === this.selectedNodeId);
                }

                const displayMode = node.displayMode || 'normal';
                const lastMode = nodeEl.dataset.lastMode;
                const lastType = nodeEl.dataset.lastType;

                const contentEl = nodeEl.querySelector('.node-content') as HTMLElement;
                const portsEl = nodeEl.querySelector('.node-ports') as HTMLElement;

                if (lastMode !== displayMode || lastType !== node.type) {
                    nodeEl.dataset.lastMode = displayMode;
                    nodeEl.dataset.lastType = node.type;

                    // Update mode classes
                    nodeEl.classList.remove('mode-normal', 'mode-expanded', 'mode-full-panel', 'mode-compact');
                    nodeEl.classList.add(`mode-${displayMode}`);

                    const collapseBtn = nodeEl.querySelector('.node-collapse-btn') as HTMLButtonElement;
                    if (collapseBtn) {
                        const icons = { 'normal': '[N]', 'expanded': '[E]', 'compact': '[C]' };
                        collapseBtn.textContent = (icons as any)[displayMode] || '[?]';
                    }

                    // Configure Ports
                    portsEl.innerHTML = '';
                    if (displayMode === 'compact') {
                        portsEl.style.display = 'block';
                        if (node.inputs.length > 0) {
                            const p = document.createElement('div');
                            p.className = 'port input representative';
                            const colorClass = this.getPortColorClass(node.type, node.inputs[0].id);
                            p.innerHTML = `<div class="port-bullet ${colorClass}" id="${this.panelId}-port-in-${node.id}-representative"></div>`;
                            p.addEventListener('mouseup', () => {
                                if (this.isDraggingWire) {
                                    state.connections.push({
                                        fromNode: this.dragSourceNodeId!,
                                        fromPort: this.dragSourcePortId!,
                                        toNode: node.id,
                                        toPort: node.inputs[0].id
                                    });
                                    this.stateManager.pushState(state);
                                }
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
                    } else if (displayMode === 'full-panel') {
                        portsEl.style.display = 'none';
                    } else {
                        portsEl.style.display = 'block';
                        node.inputs.forEach(input => {
                            const p = document.createElement('div');
                            p.className = 'port input';
                            const colorClass = this.getPortColorClass(node.type, input.id);
                            p.innerHTML = `<div class="port-bullet ${colorClass}" id="${this.panelId}-port-in-${node.id}-${input.id}"></div><span class="port-label">${input.label}</span>`;
                            p.addEventListener('mouseup', () => {
                                if (this.isDraggingWire) {
                                    state.connections.push({
                                        fromNode: this.dragSourceNodeId!,
                                        fromPort: this.dragSourcePortId!,
                                        toNode: node.id,
                                        toPort: input.id
                                    });
                                    this.stateManager.pushState(state);
                                }
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

                    // Clear content if mode/type changed
                    contentEl.innerHTML = '';
                }

                // Update Content
                if (displayMode === 'compact') {
                    contentEl.style.display = 'none';
                } else if (displayMode === 'normal') {
                    if (node.type === 'TelemetryText' || node.type === 'TelemetryGraph') {
                        contentEl.style.display = 'block';
                        this.renderTelemetryContent(node, contentEl);
                    } else {
                        contentEl.style.display = 'none';
                    }
                } else {
                    contentEl.style.display = 'block';
                    this.renderNodeParameters(node, contentEl);
                    if (node.type === 'TelemetryText' || node.type === 'TelemetryGraph') {
                        this.renderTelemetryContent(node, contentEl);
                    }
                }

            } catch (e) {
                console.error(`Failed to render node ${node.id}:`, e);
            }
        });
    }

    private updateConnections(state: SimulationState): void {
        this.svg.innerHTML = '';
        state.connections.forEach(edge => {
            const fromNode = state.nodes.find(n => n.id === edge.fromNode);
            const toNode = state.nodes.find(n => n.id === edge.toNode);
            if (!fromNode || !toNode) return;
            const fromPos = this.getPortPosition(fromNode, edge.fromPort, false);
            const toPos = this.getPortPosition(toNode, edge.toPort, true);
            if (!fromPos || !toPos) return;

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            let d = "";
            if (this.layoutOrientation === 'HORIZ') {
                const dx = Math.max(Math.abs(toPos.x - fromPos.x) * 0.5, 50);
                d = `M ${fromPos.x} ${fromPos.y} C ${fromPos.x + dx} ${fromPos.y}, ${toPos.x - dx} ${toPos.y}, ${toPos.x} ${toPos.y}`;
            } else {
                const dy = Math.max(Math.abs(toPos.y - fromPos.y) * 0.5, 50);
                d = `M ${fromPos.x} ${fromPos.y} C ${fromPos.x} ${fromPos.y + dy}, ${toPos.x} ${toPos.y - dy}, ${toPos.x} ${toPos.y}`;
            }
            path.setAttribute('d', d);
            path.setAttribute('class', 'edge-path');
            path.setAttribute('stroke', '#475569');
            path.setAttribute('stroke-width', '2');
            path.setAttribute('fill', 'none');
            this.svg.appendChild(path);
        });

        if (this.isDraggingWire && this.dragSourceNodeId) {
            const sourceNode = state.nodes.find(n => n.id === this.dragSourceNodeId);
            const fromPos = this.getPortPosition(sourceNode!, this.dragSourcePortId!, false);
            if (fromPos) {
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                const toPos = this.mouseWorldPosition;
                const dx = Math.max(Math.abs(toPos.x - fromPos.x) * 0.5, 50);
                const d = `M ${fromPos.x} ${fromPos.y} C ${fromPos.x + dx} ${fromPos.y}, ${toPos.x - dx} ${toPos.y}, ${toPos.x} ${toPos.y}`;
                path.setAttribute('d', d);
                path.setAttribute('stroke', '#00f0ff');
                path.setAttribute('stroke-dasharray', '5,5');
                path.setAttribute('fill', 'none');
                this.svg.appendChild(path);
            }
        }
    }

    private getPortColorClass(nodeType: string, portId: string): string {
        if (nodeType === 'DomainMesh' || portId === 'mesh') return 'domain';
        if (nodeType === 'MaterialExplosive' || portId === 'explosive') return 'explosive';
        if (portId === 'telemetry' || (portId === 'in' && (nodeType === 'TelemetryText' || nodeType === 'TelemetryGraph'))) return 'telemetry';
        return 'material';
    }

    private getPortPosition(node: Node, portId: string, isInput: boolean): { x: number, y: number } | null {
        const bulletId = node.displayMode === 'compact'
            ? (isInput ? `${this.panelId}-port-in-${node.id}-representative` : `${this.panelId}-port-out-${node.id}-representative`)
            : (isInput ? `${this.panelId}-port-in-${node.id}-${portId}` : `${this.panelId}-port-out-${node.id}-${portId}`);

        const bullet = document.getElementById(bulletId);
        if (bullet) {
            const rect = bullet.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;

            const ctm = this.svg.getScreenCTM();
            if (!ctm) return null;
            const pt = new DOMPoint(centerX, centerY);
            const worldPoint = pt.matrixTransform(ctm.inverse());
            return { x: worldPoint.x, y: worldPoint.y };
        }

        // Fallback for hidden ports (e.g., full-panel mode)
        const el = this.nodeElements.get(node.id);
        const w = el ? el.offsetWidth : (node.width || 200);
        const h = el ? el.offsetHeight : (node.height || 100);

        if (this.layoutOrientation === 'HORIZ') {
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
                body.style.height = '100%';
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
            const worker = this.nodeWorkers.get(node.id);
            if (worker) {
                worker.postMessage({
                    type: 'setConfig',
                    showAxes: node.displayMode === 'expanded'
                });
            }

            if (!container.querySelector('canvas')) {
                const graphBody = document.createElement('div');
                graphBody.className = 'node-body-graph';
                graphBody.style.height = '100%';
                container.appendChild(graphBody);

                const canvas = document.createElement('canvas');
                canvas.style.width = '100%';
                canvas.style.height = '100%';
                graphBody.appendChild(canvas);
                const worker = new Worker(new URL('./ChartWorker.ts', import.meta.url), { type: 'module' });
                this.nodeWorkers.set(node.id, worker);
                const offscreen = (canvas as any).transferControlToOffscreen();
                worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen] as any);

                const initialData = this.stateManager.getTelemetry(node.id);
                if (initialData) {
                    if (initialData instanceof ArrayBuffer) {
                        const bufferCopy = initialData.slice(0);
                        worker.postMessage(bufferCopy, [bufferCopy]);
                    } else {
                        const pressureData = initialData.data || initialData.telemetry;
                        if (pressureData && (Array.isArray(pressureData) || pressureData instanceof Float32Array)) {
                            worker.postMessage({ type: 'data', telemetry: pressureData });
                        }
                    }
                }
            }
        }
    }

    private renderNodeParameters(node: Node, container: HTMLElement): void {
        let form = container.querySelector('.node-params-form') as HTMLFormElement;
        if (form) {
            for (const [key, value] of Object.entries(node.parameters)) {
                const input = form.querySelector(`[data-key="${key}"]`) as HTMLInputElement;
                if (input && document.activeElement !== input) {
                    input.value = value.toString();
                }
            }
            return;
        }

        container.innerHTML = '';
        form = document.createElement('form');
        form.className = 'node-params-form';
        form.style.padding = '4px 8px';
        form.onsubmit = (e) => e.preventDefault();

        for (const [key, value] of Object.entries(node.parameters)) {
            const row = document.createElement('div');
            row.style.marginBottom = '4px';
            row.style.display = 'flex';
            row.style.flexDirection = 'column';

            const label = document.createElement('label');
            label.style.fontSize = '8px';
            label.style.color = '#888';
            label.textContent = key.replace(/_/g, ' ').toUpperCase();
            row.appendChild(label);

            const dropdowns: Record<string, string[]> = {
                'left_bc': ['Reflecting', 'Transmitting', 'Terminate'],
                'right_bc': ['Reflecting', 'Transmitting', 'Terminate'],
                'composition': ['TNT', 'IdealGas', 'Custom'],
                'flux_scheme': ['AUSM+', 'Rusanov'],
                'spatial_order': ['1', '2', '3'],
                'temporal_order': ['1', '2', '3', '4'],
                'output_mode': ['By Step', 'By Time']
            };

            let inputEl: HTMLElement;
            if (dropdowns[key]) {
                const select = document.createElement('select');
                select.dataset.key = key;
                select.style.width = '100%';
                select.style.fontSize = '9px';
                select.style.background = '#222';
                select.style.color = '#ccc';
                select.style.border = '1px solid #444';
                select.style.padding = '1px 2px';

                dropdowns[key].forEach(opt => {
                    const option = document.createElement('option');
                    option.value = opt;
                    option.text = opt;
                    if (opt === value.toString()) option.selected = true;
                    select.appendChild(option);
                });

                select.addEventListener('change', () => {
                    this.stateManager.updateNodeParameters(node.id, { [key]: select.value });
                });
                inputEl = select;
            } else {
                const input = document.createElement('input');
                const isNumeric = typeof value === 'number';
                input.type = isNumeric ? 'number' : 'text';
                if (isNumeric) input.step = 'any';
                input.value = value.toString();
                input.dataset.key = key;
                input.style.width = '100%';
                input.style.fontSize = '9px';
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

    public autoArrange(): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

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
            base += Math.max(node.inputs.length, node.outputs.length) * 20;
        } else if (node.displayMode === 'expanded') {
            base += Object.keys(node.parameters).length * 25;
            if (node.type === 'TelemetryText') base += 100;
            if (node.type === 'TelemetryGraph') base += 120;
            base += Math.max(node.inputs.length, node.outputs.length) * 20;
        }
        return Math.max(base, 60);
    }
}
