import { SimulationState, Node, Edge, Port, NodeType } from './types.js';
import { StateManager } from './state-manager.js';

export class GraphRenderer {
    private viewport: HTMLElement;
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

    private nodeElements: Map<string, HTMLElement> = new Map();
    private nodeWorkers: Map<string, Worker> = new Map();
    private lastMouseX: number = 0;
    private lastMouseY: number = 0;

    private selectedNodeId: string | null = null;
    private spacePressed: boolean = false;

    public onNodeSelected: ((nodeId: string | null) => void) | null = null;

    constructor(viewport: HTMLElement, container: HTMLElement, svg: SVGSVGElement, stateManager: StateManager) {
        this.viewport = viewport;
        this.container = container;
        this.svg = svg;
        this.stateManager = stateManager;

        this.initEventListeners();
        this.stateManager.onStateChange(() => this.render());
        this.render();
    }

    private initEventListeners(): void {
        // Zooming
        this.viewport.addEventListener('wheel', this.onWheel.bind(this), { passive: false });

        // Panning and Dragging
        this.viewport.addEventListener('mousedown', this.onMouseDown.bind(this));
        window.addEventListener('mousemove', this.onMouseMove.bind(this));
        window.addEventListener('mouseup', this.onMouseUp.bind(this));

        // Selection / Background Click
        this.viewport.addEventListener('click', (e) => {
            if (e.target === this.viewport || e.target === this.container || e.target === this.svg) {
                this.selectNode(null);
            }
        });

        // Deletion & Space Panning
        window.addEventListener('keydown', this.onKeyDown.bind(this));
        window.addEventListener('keyup', this.onKeyUp.bind(this));

        // Context Menu
        this.viewport.addEventListener('contextmenu', this.onContextMenu.bind(this));
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

            // Adjust pan to zoom towards mouse
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
                state.edges = state.edges.filter(edge => edge.fromNode !== this.selectedNodeId && edge.toNode !== this.selectedNodeId);
                this.selectedNodeId = null;
                if (this.onNodeSelected) this.onNodeSelected(null);
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
            id,
            type,
            x,
            y,
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
        this.selectedNodeId = nodeId;
        if (this.onNodeSelected) this.onNodeSelected(nodeId);
        this.render();
    }

    public render(): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;
        this.syncNodes(state);
        this.updateEdges(state);
    }

    private syncNodes(state: SimulationState): void {
        const nodeIdsInState = new Set(state.nodes.map(n => n.id));

        // Remove old nodes
        for (const [id, el] of this.nodeElements.entries()) {
            if (!nodeIdsInState.has(id)) {
                el.remove();
                this.nodeElements.delete(id);
            }
        }

        // Update or Create nodes
        state.nodes.forEach(node => {
            let nodeEl = this.nodeElements.get(node.id);
            if (!nodeEl) {
                nodeEl = document.createElement('div');
                nodeEl.className = 'node';
                nodeEl.dataset.id = node.id;

                const header = document.createElement('div');
                header.className = 'node-header';
                header.textContent = node.type === 'ThePainter' ? 'INITIALIZER' : node.type.toUpperCase();

                header.addEventListener('mousedown', (e) => {
                    if (this.spacePressed || e.button !== 0) return;
                    const currentState = this.stateManager.getCurrentState();
                    if (!currentState) return;
                    const latestNode = currentState.nodes.find(n => n.id === node.id);
                    if (!latestNode) return;

                    e.stopPropagation();
                    const ctm = this.svg.getScreenCTM();
                    if (!ctm) return;

                    this.isDraggingNode = true;
                    this.draggedNodeId = node.id;
                    this.selectNode(node.id);

                    const pt = new DOMPoint(e.clientX, e.clientY);
                    const worldPoint = pt.matrixTransform(ctm.inverse());

                    this.dragOffsetX = worldPoint.x - latestNode.x;
                    this.dragOffsetY = worldPoint.y - latestNode.y;
                });

                nodeEl.appendChild(header);

                // Add body for telemetry nodes
                if (node.type === 'TelemetryText') {
                    const body = document.createElement('div');
                    body.className = 'node-body-text';
                    nodeEl.appendChild(body);
                } else if (node.type === 'TelemetryGraph') {
                    const body = document.createElement('div');
                    body.className = 'node-body-graph';
                    const canvas = document.createElement('canvas');
                    canvas.className = 'telemetry-node-canvas';
                    body.appendChild(canvas);
                    nodeEl.appendChild(body);

                    // Initialize worker
                    const offscreen = canvas.transferControlToOffscreen();
                    const worker = new Worker(new URL('./ChartWorker.ts', import.meta.url), { type: 'module' });
                    this.nodeWorkers.set(node.id, worker);
                    worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen] as any);

                    const ro = new ResizeObserver(entries => {
                        for (const entry of entries) {
                            worker.postMessage({
                                type: 'resize',
                                width: entry.contentRect.width,
                                height: entry.contentRect.height
                            });
                        }
                    });
                    ro.observe(body);
                }

                const ports = document.createElement('div');
                ports.className = 'node-ports';

                node.inputs.forEach(input => {
                    const port = document.createElement('div');
                    port.className = 'port input';
                    port.dataset.portId = input.id;
                    port.innerHTML = `<div class="port-bullet"></div><span class="port-label">${input.label}</span>`;

                    port.addEventListener('mouseup', (e) => {
                        if (this.isDraggingWire && this.dragSourceNodeId && this.dragSourcePortId) {
                            const state = this.stateManager.getCurrentState();
                            if (state) {
                                // Check if connection already exists to avoid duplicates
                                const exists = state.edges.some(edge =>
                                    edge.fromNode === this.dragSourceNodeId &&
                                    edge.fromPort === this.dragSourcePortId &&
                                    edge.toNode === node.id &&
                                    edge.toPort === input.id
                                );

                                if (!exists) {
                                    state.edges.push({
                                        fromNode: this.dragSourceNodeId,
                                        fromPort: this.dragSourcePortId,
                                        toNode: node.id,
                                        toPort: input.id
                                    });
                                    this.stateManager.pushState(state);
                                }
                            }
                            // Let the global mouseup handler reset isDraggingWire and re-render
                        }
                    });

                    ports.appendChild(port);
                });

                node.outputs.forEach(output => {
                    const port = document.createElement('div');
                    port.className = 'port output';
                    port.dataset.portId = output.id;
                    port.innerHTML = `<span class="port-label">${output.label}</span><div class="port-bullet"></div>`;

                    port.addEventListener('mousedown', (e) => {
                        e.stopPropagation();
                        this.isDraggingWire = true;
                        this.dragSourceNodeId = node.id;
                        this.dragSourcePortId = output.id;

                        const ctm = this.svg.getScreenCTM();
                        if (ctm) {
                            const pt = new DOMPoint(e.clientX, e.clientY);
                            const worldPoint = pt.matrixTransform(ctm.inverse());
                            this.mouseWorldPosition = { x: worldPoint.x, y: worldPoint.y };
                        }
                        this.render();
                    });

                    ports.appendChild(port);
                });

                nodeEl.appendChild(ports);
                this.container.appendChild(nodeEl);
                this.nodeElements.set(node.id, nodeEl);
            }

            nodeEl.style.left = `${node.x}px`;
            nodeEl.style.top = `${node.y}px`;
            nodeEl.classList.toggle('selected', node.id === this.selectedNodeId);

            // Update telemetry content
            if (node.type === 'TelemetryText' && node.latestLog) {
                const body = nodeEl.querySelector('.node-body-text');
                if (body) {
                    body.innerHTML = node.latestLog.map(line => `<div class="log-line">${line}</div>`).join('');
                    body.scrollTop = body.scrollHeight;
                }
            } else if (node.type === 'TelemetryGraph' && node.latestTelemetry) {
                const worker = this.nodeWorkers.get(node.id);
                if (worker) {
                    worker.postMessage({ type: 'data', telemetry: node.latestTelemetry.data || node.latestTelemetry.telemetry || node.latestTelemetry.percent });
                }
            }
        });
    }

    private updateEdges(state: SimulationState): void {
        this.svg.innerHTML = '';
        state.edges.forEach(edge => {
            const fromNode = state.nodes.find(n => n.id === edge.fromNode);
            const toNode = state.nodes.find(n => n.id === edge.toNode);
            if (!fromNode || !toNode) return;

            const fromPos = this.getPortPosition(fromNode, edge.fromPort, false);
            const toPos = this.getPortPosition(toNode, edge.toPort, true);

            if (!fromPos || !toPos) return;

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            const dx = Math.max(Math.abs(toPos.x - fromPos.x) * 0.5, 50);
            const d = `M ${fromPos.x} ${fromPos.y} C ${fromPos.x + dx} ${fromPos.y}, ${toPos.x - dx} ${toPos.y}, ${toPos.x} ${toPos.y}`;
            path.setAttribute('d', d);
            path.setAttribute('class', 'edge-path');
            this.svg.appendChild(path);
        });

        if (this.isDraggingWire && this.dragSourceNodeId && this.dragSourcePortId) {
            const sourceNode = state.nodes.find(n => n.id === this.dragSourceNodeId);
            if (sourceNode) {
                const fromPos = this.getPortPosition(sourceNode, this.dragSourcePortId, false);
                if (fromPos) {
                    const toPos = this.mouseWorldPosition;
                    const dx = Math.max(Math.abs(toPos.x - fromPos.x) * 0.5, 50);
                    const d = `M ${fromPos.x} ${fromPos.y} C ${fromPos.x + dx} ${fromPos.y}, ${toPos.x - dx} ${toPos.y}, ${toPos.x} ${toPos.y}`;

                    const ghostPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    ghostPath.setAttribute('d', d);
                    ghostPath.setAttribute('class', 'edge-path');
                    ghostPath.setAttribute('stroke-dasharray', '5,5');
                    ghostPath.setAttribute('stroke-opacity', '0.5');
                    this.svg.appendChild(ghostPath);
                }
            }
        }
    }

    private getPortPosition(node: Node, portId: string, isInput: boolean): { x: number, y: number } | null {
        const nodeEl = this.nodeElements.get(node.id);
        if (nodeEl) {
            const portEl = nodeEl.querySelector(`.port.${isInput ? 'input' : 'output'}[data-port-id="${portId}"]`);
            const bullet = portEl?.querySelector('.port-bullet');
            if (bullet) {
                const rect = bullet.getBoundingClientRect();
                const screenX = rect.left + rect.width / 2;
                const screenY = rect.top + rect.height / 2;

                const ctm = this.svg.getScreenCTM();
                if (!ctm) return null;

                const pt = new DOMPoint(screenX, screenY);
                const worldPoint = pt.matrixTransform(ctm.inverse());
                return { x: worldPoint.x, y: worldPoint.y };
            }
        }

        // Fallback to manual calculation if DOM is not ready
        const ports = isInput ? node.inputs : node.outputs;
        const index = ports.findIndex(p => p.id === portId);
        if (index === -1) return null;

        const portY = 25 + 8 + 10 + (index * 20);
        const portX = isInput ? 0 : 180;
        return { x: node.x + portX, y: node.y + portY };
    }

    public autoArrange(): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        let meshY = 50, airY = 200, explosiveY = 350;

        // Apply transition to node elements
        const nodes = Array.from(this.container.querySelectorAll('.node')) as HTMLElement[];
        nodes.forEach(n => n.style.transition = 'left 0.5s ease-in-out, top 0.5s ease-in-out');

        state.nodes.forEach(node => {
            if (node.type === 'DomainMesh') { node.x = 50; node.y = meshY; }
            else if (node.type === 'MaterialAir') { node.x = 50; node.y = airY; }
            else if (node.type === 'MaterialExplosive') { node.x = 50; node.y = explosiveY; }
            else if (node.type === 'ThePainter') { node.x = 400; node.y = 200; }
            else if (node.type === 'CFDSolver') { node.x = 700; node.y = 200; }
        });

        // Use a small timeout to let the edges update during animation
        let frames = 0;
        const animateEdges = () => {
            // Re-read current positions from DOM for edges if possible,
            // or just update state and re-render edges.
            // Since we use CSS transitions, we need to periodically update edges.
            this.updateEdges(state);
            frames++;
            if (frames < 30) requestAnimationFrame(animateEdges);
            else {
                nodes.forEach(n => n.style.transition = '');
                this.stateManager.pushState(state);
            }
        };
        requestAnimationFrame(animateEdges);
    }
}
