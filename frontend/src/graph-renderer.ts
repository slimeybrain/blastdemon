import { SimulationState, Node, Connection, Port, NodeType } from './types.js';
import { StateManager } from './state-manager.js';

export class GraphRenderer {
    public viewport: HTMLElement;
    private container: HTMLElement;
    private svg: SVGSVGElement;
    private stateManager: StateManager;

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

    constructor(parent: HTMLElement, stateManager: StateManager) {
        this.stateManager = stateManager;

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

        this.nodeResizeObserver = new ResizeObserver(() => this.render());

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

        if (node.displayMode === 'collapsed') return;

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
            const ctm = this.svg.getScreenCTM();
            if (state && ctm) {
                const node = state.nodes.find(n => n.id === this.draggedNodeId);
                if (node) {
                    const pt = new DOMPoint(e.clientX, e.clientY);
                    const worldPoint = pt.matrixTransform(ctm.inverse());

                    node.x = worldPoint.x - this.dragOffsetX;
                    node.y = worldPoint.y - this.dragOffsetY;

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
                    nodeEl.dataset.id = node.id;

                    const header = document.createElement('div');
                    header.className = 'node-header';
                    header.innerHTML = `<span>${node.type.toUpperCase()}</span>`;

                    const collapseBtn = document.createElement('button');
                    collapseBtn.className = 'node-collapse-btn';
                    collapseBtn.textContent = '[v]';
                    header.appendChild(collapseBtn);

                header.addEventListener('mousedown', (e) => {
                    if (this.spacePressed || e.button !== 0) return;
                    e.stopPropagation();
                    this.isDraggingNode = true;
                    this.draggedNodeId = node.id;
                    this.selectNode(node.id);
                    const ctm = this.svg.getScreenCTM()!;
                    const pt = new DOMPoint(e.clientX, e.clientY);
                    const worldPoint = pt.matrixTransform(ctm.inverse());
                    this.dragOffsetX = worldPoint.x - node.x;
                    this.dragOffsetY = worldPoint.y - node.y;
                });
                nodeEl.appendChild(header);

                const content = document.createElement('div');
                content.className = 'node-content';
                if (node.type === 'TelemetryGraph') {
                    const canvas = document.createElement('canvas');
                    canvas.style.width = '100%';
                    canvas.style.height = '100px';
                    content.appendChild(canvas);
                    const worker = new Worker(new URL('./ChartWorker.ts', import.meta.url), { type: 'module' });
                    this.nodeWorkers.set(node.id, worker);
                    const offscreen = (canvas as any).transferControlToOffscreen();
                    worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen] as any);
                }
                nodeEl.appendChild(content);

                const ports = document.createElement('div');
                ports.className = 'node-ports';
                node.inputs.forEach(input => {
                    const p = document.createElement('div');
                    p.className = 'port input';
                    p.dataset.portId = input.id;
                    const colorClass = this.getPortColorClass(node.type, input.id);
                    p.innerHTML = `<div class="port-bullet ${colorClass}" id="port-in-${node.id}-${input.id}"></div><span class="port-label">${input.label}</span>`;
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
                    ports.appendChild(p);
                });
                node.outputs.forEach(output => {
                    const p = document.createElement('div');
                    p.className = 'port output';
                    p.dataset.portId = output.id;
                    const colorClass = this.getPortColorClass(node.type, output.id);
                    p.innerHTML = `<span class="port-label">${output.label}</span><div class="port-bullet ${colorClass}" id="port-out-${node.id}-${output.id}"></div>`;
                    p.addEventListener('mousedown', (e) => {
                        e.stopPropagation();
                        this.isDraggingWire = true;
                        this.dragSourceNodeId = node.id;
                        this.dragSourcePortId = output.id;
                    });
                    ports.appendChild(p);
                });
                nodeEl.appendChild(ports);

                this.container.appendChild(nodeEl);
                this.nodeElements.set(node.id, nodeEl);
                this.nodeResizeObserver?.observe(nodeEl);
            }

                nodeEl.style.left = `${node.x}px`;
                nodeEl.style.top = `${node.y}px`;
                if (node.width !== undefined) nodeEl.style.width = `${node.width}px`;
                if (node.height !== undefined) nodeEl.style.height = `${node.height}px`;
                nodeEl.classList.toggle('selected', node.id === this.selectedNodeId);
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
        const bulletId = isInput ? `port-in-${node.id}-${portId}` : `port-out-${node.id}-${portId}`;
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
        return { x: node.x + (isInput ? 0 : 200), y: node.y + 50 };
    }

    public autoArrange(): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        if (this.layoutOrientation === 'HORIZ') {
            state.nodes.forEach((n, i) => { n.x = i * 250 + 50; n.y = 100; });
        } else {
            state.nodes.forEach((n, i) => { n.x = 100; n.y = i * 150 + 50; });
        }
        this.stateManager.pushState(state);
    }
}
