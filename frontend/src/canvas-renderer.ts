import { SimulationState, Node, Connection, Port } from './types.js';
import { StateManager } from './state-manager.js';

export class CanvasRenderer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private stateManager: StateManager;
    private isDragging: boolean = false;
    private draggedNode: Node | null = null;
    private dragOffset = { x: 0, y: 0 };
    private selectedNodeId: string | null = null;

    public onNodeSelected: ((nodeId: string | null) => void) | null = null;

    // Theme constants
    private readonly COLORS = {
        bg: '#1e1e1e',
        grid: '#2a2a2a',
        nodeBg: '#333333',
        nodeBorder: '#555555',
        nodeSelected: '#007acc',
        nodeHeader: '#444444',
        text: '#cccccc',
        textHeader: '#ffffff',
        edge: '#888888',
        port: '#aaaaaa'
    };

    private readonly NODE_WIDTH = 180;
    private readonly NODE_HEIGHT = 120;
    private readonly HEADER_HEIGHT = 25;
    private readonly PORT_RADIUS = 4;

    constructor(canvas: HTMLCanvasElement, stateManager: StateManager) {
        this.canvas = canvas;
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('Could not get 2D context from canvas');
        }
        this.ctx = context;
        this.stateManager = stateManager;

        this.initEventListeners();
    }

    private initEventListeners(): void {
        this.canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
        this.canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
        this.canvas.addEventListener('mouseup', this.onMouseUp.bind(this));
    }

    private onMouseDown(event: MouseEvent): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        const rect = this.canvas.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;

        let hit = false;
        for (let i = state.nodes.length - 1; i >= 0; i--) {
            const node = state.nodes[i];
            if (mouseX >= node.x && mouseX <= node.x + this.NODE_WIDTH &&
                mouseY >= node.y && mouseY <= node.y + this.NODE_HEIGHT) {
                this.isDragging = true;
                this.draggedNode = JSON.parse(JSON.stringify(node));
                this.dragOffset.x = mouseX - node.x;
                this.dragOffset.y = mouseY - node.y;

                this.selectedNodeId = node.id;
                if (this.onNodeSelected) this.onNodeSelected(node.id);
                hit = true;
                break;
            }
        }

        if (!hit) {
            this.selectedNodeId = null;
            if (this.onNodeSelected) this.onNodeSelected(null);
        }

        this.render();
    }

    private onMouseMove(event: MouseEvent): void {
        if (!this.isDragging || !this.draggedNode) return;

        const rect = this.canvas.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;

        this.draggedNode.x = mouseX - this.dragOffset.x;
        this.draggedNode.y = mouseY - this.dragOffset.y;

        const state = this.stateManager.getCurrentState();
        if (state) {
            const nodeIndex = state.nodes.findIndex(n => n.id === this.draggedNode!.id);
            if (nodeIndex !== -1) {
                state.nodes[nodeIndex] = this.draggedNode;
                this.renderWithState(state);
            }
        }
    }

    private onMouseUp(event: MouseEvent): void {
        if (this.isDragging && this.draggedNode) {
            const state = this.stateManager.getCurrentState();
            if (state) {
                const nodeIndex = state.nodes.findIndex(n => n.id === this.draggedNode!.id);
                if (nodeIndex !== -1) {
                    state.nodes[nodeIndex] = this.draggedNode;
                    this.stateManager.pushState(state);
                }
            }
        }
        this.isDragging = false;
        this.draggedNode = null;
        this.render();
    }

    public render(): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;
        this.renderWithState(state);
    }

    private drawGrid(): void {
        const gridSize = 20;
        this.ctx.strokeStyle = this.COLORS.grid;
        this.ctx.lineWidth = 1;

        this.ctx.beginPath();
        for (let x = 0; x <= this.canvas.width; x += gridSize) {
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, this.canvas.height);
        }
        for (let y = 0; y <= this.canvas.height; y += gridSize) {
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(this.canvas.width, y);
        }
        this.ctx.stroke();
    }

    private renderWithState(state: SimulationState): void {
        this.ctx.fillStyle = this.COLORS.bg;
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        this.drawGrid();

        const valResults = this.validateGraph(state);

        state.connections.forEach(edge => this.drawConnection(edge, state, valResults));
        state.nodes.forEach(node => this.drawNode(node, valResults));
    }

    private getPortPosition(node: Node, portId: string, isInput: boolean): { x: number, y: number } {
        const ports = isInput ? node.inputs : node.outputs;
        const index = ports.findIndex(p => p.id === portId);

        if (index === -1) return { x: node.x + this.NODE_WIDTH / 2, y: node.y + this.HEADER_HEIGHT };

        const portSpacing = 20;
        const x = isInput ? node.x : node.x + this.NODE_WIDTH;
        const y = node.y + this.HEADER_HEIGHT + 20 + index * portSpacing;
        return { x, y };
    }

    private drawNode(node: Node, valResults: any): void {
        const width = this.NODE_WIDTH;
        const height = this.NODE_HEIGHT;
        const isSelected = node.id === this.selectedNodeId;
        const valStatus = valResults.nodeStatus[node.id] || { state: 'valid', messages: [] };

        // Border and glow colors based on error/warning/selection/default
        let borderColor = this.COLORS.nodeBorder;
        let glowColor = 'rgba(0,0,0,0.5)';
        let glowBlur = isSelected ? 15 : 10;
        let lineWidth = isSelected ? 2 : 1;

        if (valStatus.state === 'error') {
            borderColor = '#ef4444';
            glowColor = 'rgba(239, 68, 68, 0.5)';
            glowBlur = 15;
            lineWidth = 2;
        } else if (valStatus.state === 'warning') {
            borderColor = '#f59e0b';
            glowColor = 'rgba(245, 158, 11, 0.5)';
            glowBlur = 15;
            lineWidth = 2;
        } else if (isSelected) {
            borderColor = this.COLORS.nodeSelected;
            glowColor = this.COLORS.nodeSelected;
        }

        // Shadow/Glow
        this.ctx.shadowBlur = glowBlur;
        this.ctx.shadowColor = glowColor;

        // Node Body
        this.ctx.fillStyle = this.COLORS.nodeBg;
        this.ctx.strokeStyle = borderColor;
        this.ctx.lineWidth = lineWidth;
        this.ctx.beginPath();
        if ((this.ctx as any).roundRect) {
            (this.ctx as any).roundRect(node.x, node.y, width, height, 4);
        } else {
            this.ctx.rect(node.x, node.y, width, height);
        }
        this.ctx.fill();
        this.ctx.stroke();

        this.ctx.shadowBlur = 0;

        // Node Header
        this.ctx.fillStyle = this.COLORS.nodeHeader;
        this.ctx.beginPath();
        if ((this.ctx as any).roundRect) {
            (this.ctx as any).roundRect(node.x, node.y, width, this.HEADER_HEIGHT, [4, 4, 0, 0]);
        } else {
            this.ctx.rect(node.x, node.y, width, this.HEADER_HEIGHT);
        }
        this.ctx.fill();

        // Node Title
        this.ctx.fillStyle = this.COLORS.textHeader;
        this.ctx.font = 'bold 11px system-ui';
        this.ctx.fillText(node.type.toUpperCase(), node.x + 10, node.y + 17);

        // Validation Badge
        if (valStatus.state === 'error') {
            this.ctx.fillStyle = '#ef4444';
            this.ctx.font = 'bold 11px system-ui';
            this.ctx.fillText('❌', node.x + width - 20, node.y + 17);
        } else if (valStatus.state === 'warning') {
            this.ctx.fillStyle = '#f59e0b';
            this.ctx.font = 'bold 11px system-ui';
            this.ctx.fillText('⚠️', node.x + width - 20, node.y + 17);
        }

        // Ports
        this.ctx.font = '9px system-ui';
        const portSpacing = 20;

        // Input Ports
        node.inputs.forEach((port, index) => {
            const pos = this.getPortPosition(node, port.id, true);
            this.ctx.fillStyle = this.COLORS.port;
            this.ctx.beginPath();
            this.ctx.arc(pos.x, pos.y, this.PORT_RADIUS, 0, Math.PI * 2);
            this.ctx.fill();

            this.ctx.fillStyle = this.COLORS.text;
            this.ctx.textAlign = 'left';
            this.ctx.fillText(port.label, pos.x + 10, pos.y + 4);
        });

        // Output Ports
        node.outputs.forEach((port, index) => {
            const pos = this.getPortPosition(node, port.id, false);
            this.ctx.fillStyle = this.COLORS.port;
            this.ctx.beginPath();
            this.ctx.arc(pos.x, pos.y, this.PORT_RADIUS, 0, Math.PI * 2);
            this.ctx.fill();

            this.ctx.fillStyle = this.COLORS.text;
            this.ctx.textAlign = 'right';
            this.ctx.fillText(port.label, pos.x - 10, pos.y + 4);
        });

        this.ctx.textAlign = 'left'; // Reset
    }

    private drawConnection(edge: Connection, state: SimulationState, valResults: any): void {
        const fromNode = state.nodes.find(n => n.id === edge.fromNode);
        const toNode = state.nodes.find(n => n.id === edge.toNode);

        if (!fromNode || !toNode) return;

        const startPos = this.getPortPosition(fromNode, edge.fromPort, false);
        const endPos = this.getPortPosition(toNode, edge.toPort, true);

        const cp1x = startPos.x + (endPos.x - startPos.x) / 2;
        const cp1y = startPos.y;
        const cp2x = startPos.x + (endPos.x - startPos.x) / 2;
        const cp2y = endPos.y;

        const connKey = `${edge.fromNode}:${edge.fromPort}->${edge.toNode}:${edge.toPort}`;
        const isFlawed = valResults.flawedConnections.has(connKey);

        if (isFlawed) {
            this.ctx.strokeStyle = '#ef4444';
            this.ctx.lineWidth = 3;
            this.ctx.setLineDash([5, 5]);
        } else {
            this.ctx.strokeStyle = this.COLORS.edge;
            this.ctx.lineWidth = 2;
            this.ctx.setLineDash([]);
        }

        this.ctx.beginPath();
        this.ctx.moveTo(startPos.x, startPos.y);
        this.ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, endPos.x, endPos.y);
        this.ctx.stroke();

        // Reset line dash
        this.ctx.setLineDash([]);
    }

    private validateGraph(state: SimulationState): {
        nodeStatus: Record<string, { state: 'error' | 'warning' | 'valid'; messages: string[] }>;
        flawedConnections: Map<string, string>;
    } {
        const nodeStatus: Record<string, { state: 'error' | 'warning' | 'valid'; messages: string[] }> = {};
        const flawedConnections = new Map<string, string>();

        state.nodes.forEach(node => {
            nodeStatus[node.id] = { state: 'valid', messages: [] };
        });

        const solverNode = state.nodes.find(n => n.type === 'CFDSolver');
        const initMode = solverNode?.parameters['init_mode'] || 'Multi-Material JWL';

        if (solverNode) {
            const painterConn = state.connections.find(c => c.toNode === solverNode.id && c.toPort === 'in');
            if (!painterConn) {
                nodeStatus[solverNode.id].state = 'error';
                nodeStatus[solverNode.id].messages.push("CFD Solver is not connected to the Initializer (ThePainter).");
            } else {
                const painterNode = state.nodes.find(n => n.id === painterConn.fromNode);
                if (!painterNode || painterNode.type !== 'ThePainter') {
                    flawedConnections.set(
                        `${painterConn.fromNode}:${painterConn.fromPort}->${painterConn.toNode}:${painterConn.toPort}`,
                        "CFD Solver 'Initial State' port must be connected to the Initializer (ThePainter)."
                    );
                    nodeStatus[solverNode.id].state = 'error';
                    nodeStatus[solverNode.id].messages.push("CFD Solver 'Initial State' port must be connected to the Initializer (ThePainter).");
                }
            }
        }

        const painterNodes = state.nodes.filter(n => n.type === 'ThePainter');
        painterNodes.forEach(painterNode => {
            const meshConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'mesh');
            if (!meshConn) {
                nodeStatus[painterNode.id].state = 'error';
                nodeStatus[painterNode.id].messages.push("No Mesh node connected to Initializer. A DomainMesh node is required.");
            } else {
                const fromNode = state.nodes.find(n => n.id === meshConn.fromNode);
                if (!fromNode || fromNode.type !== 'DomainMesh') {
                    flawedConnections.set(
                        `${meshConn.fromNode}:${meshConn.fromPort}->${meshConn.toNode}:${meshConn.toPort}`,
                        "Only DomainMesh node can be connected to the Mesh input."
                    );
                    nodeStatus[painterNode.id].state = 'error';
                    nodeStatus[painterNode.id].messages.push("Only DomainMesh node can be connected to the Mesh input.");
                }
            }

            const airConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'air');
            if (!airConn) {
                nodeStatus[painterNode.id].state = 'error';
                nodeStatus[painterNode.id].messages.push("No Air node connected to Initializer. A MaterialAir node is required.");
            } else {
                const fromNode = state.nodes.find(n => n.id === airConn.fromNode);
                if (!fromNode || fromNode.type !== 'MaterialAir') {
                    flawedConnections.set(
                        `${airConn.fromNode}:${airConn.fromPort}->${airConn.toNode}:${airConn.toPort}`,
                        "Only MaterialAir node can be connected to the Air input."
                    );
                    nodeStatus[painterNode.id].state = 'error';
                    nodeStatus[painterNode.id].messages.push("Only MaterialAir node can be connected to the Air input.");
                }
            }

            const expConn = state.connections.find(c => c.toNode === painterNode.id && c.toPort === 'explosive');
            if (!expConn) {
                if (nodeStatus[painterNode.id].state === 'valid') {
                    nodeStatus[painterNode.id].state = 'warning';
                }
                nodeStatus[painterNode.id].messages.push("No Explosive node connected to Initializer. Simulation will run with NO explosive charge.");
            } else {
                const expNode = state.nodes.find(n => n.id === expConn.fromNode);
                if (expNode) {
                    if (expNode.type !== 'MaterialExplosive' && expNode.type !== 'MaterialIdealGas') {
                        flawedConnections.set(
                            `${expConn.fromNode}:${expConn.fromPort}->${expConn.toNode}:${expConn.toPort}`,
                            "Only MaterialExplosive or MaterialIdealGas node can be connected to the Explosive input."
                        );
                        nodeStatus[painterNode.id].state = 'error';
                        nodeStatus[painterNode.id].messages.push("Only MaterialExplosive or MaterialIdealGas node can be connected to the Explosive input.");
                    } else if (initMode === 'Ideal Gas' && expNode.type === 'MaterialExplosive') {
                        flawedConnections.set(
                            `${expConn.fromNode}:${expConn.fromPort}->${expConn.toNode}:${expConn.toPort}`,
                            "Solver physics is set to 'Ideal Gas' (1-material air), but explosive input is a 'MaterialExplosive' (HE-JWL) node. Connect a 'MaterialIdealGas' (IG-CHG) node instead."
                        );
                        if (nodeStatus[expNode.id].state !== 'error') nodeStatus[expNode.id].state = 'warning';
                        nodeStatus[expNode.id].messages.push("Solver physics is set to 'Ideal Gas' (1-material air), but explosive input is a 'MaterialExplosive' (HE-JWL) node. Connect a 'MaterialIdealGas' (IG-CHG) node instead.");
                        if (solverNode) {
                            if (nodeStatus[solverNode.id].state !== 'error') nodeStatus[solverNode.id].state = 'warning';
                            nodeStatus[solverNode.id].messages.push("Solver physics is set to 'Ideal Gas' (1-material air), but explosive input is a 'MaterialExplosive' (HE-JWL) node. Connect a 'MaterialIdealGas' (IG-CHG) node instead.");
                        }
                    } else if (initMode === 'Multi-Material JWL' && expNode.type === 'MaterialIdealGas') {
                        flawedConnections.set(
                            `${expConn.fromNode}:${expConn.fromPort}->${expConn.toNode}:${expConn.toPort}`,
                            "Solver physics is set to 'Multi-Material JWL', but explosive input is a 'MaterialIdealGas' (IG-CHG) node. Connect a 'MaterialExplosive' (HE-JWL) node instead."
                        );
                        if (nodeStatus[expNode.id].state !== 'error') nodeStatus[expNode.id].state = 'warning';
                        nodeStatus[expNode.id].messages.push("Solver physics is set to 'Multi-Material JWL', but explosive input is a 'MaterialIdealGas' (IG-CHG) node. Connect a 'MaterialExplosive' (HE-JWL) node instead.");
                        if (solverNode) {
                            if (nodeStatus[solverNode.id].state !== 'error') nodeStatus[solverNode.id].state = 'warning';
                            nodeStatus[solverNode.id].messages.push("Solver physics is set to 'Multi-Material JWL', but explosive input is a 'MaterialIdealGas' (IG-CHG) node. Connect a 'MaterialExplosive' (HE-JWL) node instead.");
                        }
                    }
                }
            }
        });

        state.nodes.forEach(node => {
            if (node.type === 'TelemetryText' || node.type === 'TelemetryGraph') {
                const conn = state.connections.find(c => c.toNode === node.id && c.toPort === 'in');
                if (conn) {
                    const fromNode = state.nodes.find(n => n.id === conn.fromNode);
                    if (!fromNode || fromNode.type !== 'CFDSolver') {
                        flawedConnections.set(
                            `${conn.fromNode}:${conn.fromPort}->${conn.toNode}:${conn.toPort}`,
                            "Telemetry input must be connected to a CFD Solver."
                        );
                        nodeStatus[node.id].state = 'warning';
                        nodeStatus[node.id].messages.push("Telemetry input must be connected to a CFD Solver.");
                    }
                }
            }
        });

        return { nodeStatus, flawedConnections };
    }
}
