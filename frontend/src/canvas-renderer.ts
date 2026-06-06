import { SimulationState, Node, Edge } from './types.js';
import { StateManager } from './state-manager.js';

export class CanvasRenderer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private stateManager: StateManager;
    private isDragging: boolean = false;
    private draggedNode: Node | null = null;
    private dragOffset = { x: 0, y: 0 };

    // Theme constants
    private readonly COLORS = {
        bg: '#1e1e1e',
        grid: '#2a2a2a',
        nodeBg: '#333333',
        nodeBorder: '#555555',
        nodeHeader: '#007acc',
        text: '#cccccc',
        textHeader: '#ffffff',
        edge: '#888888'
    };

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

        const nodeWidth = 150;
        const nodeHeight = 80;

        for (let i = state.nodes.length - 1; i >= 0; i--) {
            const node = state.nodes[i];
            if (mouseX >= node.x && mouseX <= node.x + nodeWidth &&
                mouseY >= node.y && mouseY <= node.y + nodeHeight) {
                this.isDragging = true;
                this.draggedNode = JSON.parse(JSON.stringify(node));
                this.dragOffset.x = mouseX - node.x;
                this.dragOffset.y = mouseY - node.y;
                break;
            }
        }
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

        state.edges.forEach(edge => this.drawEdge(edge, state));
        state.nodes.forEach(node => this.drawNode(node));
    }

    private drawNode(node: Node): void {
        const width = 150;
        const height = 80;
        const headerHeight = 25;

        // Shadow/Glow
        this.ctx.shadowBlur = 10;
        this.ctx.shadowColor = 'rgba(0,0,0,0.5)';

        // Node Body
        this.ctx.fillStyle = this.COLORS.nodeBg;
        this.ctx.strokeStyle = this.COLORS.nodeBorder;
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.roundRect(node.x, node.y, width, height, 4);
        this.ctx.fill();
        this.ctx.stroke();

        this.ctx.shadowBlur = 0;

        // Node Header
        this.ctx.fillStyle = this.COLORS.nodeHeader;
        this.ctx.beginPath();
        this.ctx.roundRect(node.x, node.y, width, headerHeight, [4, 4, 0, 0]);
        this.ctx.fill();

        // Node Title
        this.ctx.fillStyle = this.COLORS.textHeader;
        this.ctx.font = 'bold 12px system-ui';
        this.ctx.fillText(node.type, node.x + 10, node.y + 17);

        // Node ID
        this.ctx.fillStyle = 'rgba(255,255,255,0.5)';
        this.ctx.font = '10px Consolas';
        const idWidth = this.ctx.measureText(node.id).width;
        this.ctx.fillText(node.id, node.x + width - idWidth - 10, node.y + 17);

        // Parameters
        this.ctx.fillStyle = this.COLORS.text;
        this.ctx.font = '11px system-ui';
        let offsetY = headerHeight + 20;
        for (const [key, value] of Object.entries(node.parameters)) {
            this.ctx.fillText(`${key}: ${value}`, node.x + 10, node.y + offsetY);
            offsetY += 15;
        }
    }

    private drawEdge(edge: Edge, state: SimulationState): void {
        const fromNode = state.nodes.find(n => n.id === edge.fromNode);
        const toNode = state.nodes.find(n => n.id === edge.toNode);

        if (!fromNode || !toNode) return;

        const nodeWidth = 150;
        const nodeHeight = 80;

        const startX = fromNode.x + nodeWidth;
        const startY = fromNode.y + nodeHeight / 2;
        const endX = toNode.x;
        const endY = toNode.y + nodeHeight / 2;

        const cp1x = startX + (endX - startX) / 2;
        const cp1y = startY;
        const cp2x = startX + (endX - startX) / 2;
        const cp2y = endY;

        this.ctx.strokeStyle = this.COLORS.edge;
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.moveTo(startX, startY);
        this.ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, endX, endY);
        this.ctx.stroke();
    }
}
