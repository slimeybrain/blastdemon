import { SimulationState, Node, Edge } from './types.js';
import { StateManager } from './state-manager.js';

export class CanvasRenderer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private stateManager: StateManager;
    private isDragging: boolean = false;
    private draggedNode: Node | null = null;
    private dragOffset = { x: 0, y: 0 };

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

        // Iterate backwards to select the top-most node
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
                // Render with temporary state without pushing to StateManager
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

    private renderWithState(state: SimulationState): void {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Draw edges first
        state.edges.forEach(edge => this.drawEdge(edge, state));

        // Draw nodes on top
        state.nodes.forEach(node => this.drawNode(node));
    }

    private drawNode(node: Node): void {
        const width = 150;
        const height = 80;

        this.ctx.fillStyle = '#f0f0f0';
        this.ctx.strokeStyle = '#333';
        this.ctx.lineWidth = 2;

        // Draw rectangle
        this.ctx.beginPath();
        this.ctx.rect(node.x, node.y, width, height);
        this.ctx.fill();
        this.ctx.stroke();

        // Draw type
        this.ctx.fillStyle = '#000';
        this.ctx.font = 'bold 14px Arial';
        this.ctx.fillText(node.type, node.x + 10, node.y + 25);

        // Draw parameters
        this.ctx.font = '12px Arial';
        let offsetY = 45;
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

        // Ports positions (simplified: right middle for output, left middle for input)
        const startX = fromNode.x + nodeWidth;
        const startY = fromNode.y + nodeHeight / 2;
        const endX = toNode.x;
        const endY = toNode.y + nodeHeight / 2;

        const cp1x = startX + (endX - startX) / 2;
        const cp1y = startY;
        const cp2x = startX + (endX - startX) / 2;
        const cp2y = endY;

        this.ctx.strokeStyle = '#666';
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.moveTo(startX, startY);
        this.ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, endX, endY);
        this.ctx.stroke();
    }
}
