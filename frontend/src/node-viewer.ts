import { StateManager } from './state-manager.js';
import { Node, NodeType } from './types.js';
import { PropertyEditor } from './property-editor.js';

export class NodeViewer {
    private container: HTMLElement;
    private stateManager: StateManager;
    private currentNodeId: string | null = null;
    private stateListener: () => void;
    private telemetryListener: (nodeId: string, data: any) => void;

    private propertyEditor: PropertyEditor | null = null;
    private chartWorker: Worker | null = null;
    private chartCanvas: HTMLCanvasElement | null = null;

    private lastType: NodeType | null = null;
    private lastId: string | null = null;

    private telemetryBuffer: any = null;
    private renderRequestId: number | null = null;

    constructor(parent: HTMLElement, stateManager: StateManager) {
        this.container = document.createElement('div');
        this.container.className = 'node-viewer-container';
        this.container.style.display = 'flex';
        this.container.style.flexDirection = 'column';
        this.container.style.height = '100%';
        this.container.style.width = '100%';
        this.container.style.overflow = 'hidden';
        this.container.style.minWidth = '0';
        this.container.style.minHeight = '0';
        parent.appendChild(this.container);

        this.stateManager = stateManager;

        this.stateListener = () => this.render();
        this.telemetryListener = (nodeId, data) => {
            if (nodeId === this.currentNodeId) {
                this.handleTelemetry(nodeId, data);
            }
        };

        this.stateManager.onStateChange(this.stateListener);
        this.stateManager.onTelemetryUpdate(this.telemetryListener);

        this.render();
    }

    public destroy(): void {
        this.stopRenderLoop();
        this.stateManager.offStateChange(this.stateListener);
        this.stateManager.offTelemetryUpdate(this.telemetryListener);
        if (this.chartWorker) this.chartWorker.terminate();
        this.container.remove();
    }

    public setNode(nodeId: string | null): void {
        if (this.currentNodeId === nodeId) return;
        this.stopRenderLoop();
        this.currentNodeId = nodeId;
        this.render();
    }

    private render(): void {
        if (!this.currentNodeId) {
            this.container.innerHTML = '<div style="padding: 20px; color: #666;">No node selected for viewing</div>';
            this.lastId = null;
            this.lastType = null;
            return;
        }

        const state = this.stateManager.getCurrentState();
        const node = state?.nodes.find(n => n.id === this.currentNodeId);

        if (!node) {
            this.container.innerHTML = '<div style="padding: 20px; color: #f44336;">Node not found</div>';
            this.lastId = null;
            this.lastType = null;
            return;
        }

        if (this.lastId === node.id && this.lastType === node.type) {
            if (node.type !== 'TelemetryText' && node.type !== 'TelemetryGraph') {
                this.renderStandardNode(node);
            }
            return;
        }

        this.renderNodeViewer(node);
    }

    private renderNodeViewer(node: Node): void {
        this.lastId = node.id;
        this.lastType = node.type;
        this.container.innerHTML = '';

        if (node.type === 'TelemetryText') {
            this.renderExpandedText(node);
        } else if (node.type === 'TelemetryGraph') {
            this.renderExpandedGraph(node);
        } else {
            this.renderStandardNode(node);
        }
    }

    private renderExpandedText(node: Node): void {
        this.stopRenderLoop();
        if (this.chartWorker) {
            this.chartWorker.terminate();
            this.chartWorker = null;
        }

        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';

        const header = document.createElement('div');
        header.className = 'viewer-header';
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.style.padding = '8px';
        header.style.borderBottom = '1px solid #333';

        const title = document.createElement('span');
        title.textContent = `TERMINAL: ${node.id}`;
        title.style.fontWeight = 'bold';
        header.appendChild(title);

        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear History';
        clearBtn.className = 'header-button secondary';
        clearBtn.onclick = () => {
            const term = this.container.querySelector('.expanded-terminal');
            if (term) term.innerHTML = '';
            (this.stateManager as any).telemetryStore.set(node.id, []);
        };
        header.appendChild(clearBtn);

        this.container.appendChild(header);

        const terminalCont = document.createElement('div');
        terminalCont.style.flex = '1';
        terminalCont.style.position = 'relative';
        terminalCont.style.overflow = 'hidden';
        this.container.appendChild(terminalCont);

        const terminal = document.createElement('div');
        terminal.className = 'expanded-terminal';
        terminal.id = `viewer-text-${node.id}`;
        terminal.style.position = 'absolute';
        terminal.style.inset = '0';
        terminal.style.background = '#000';
        terminal.style.color = '#0f0';
        terminal.style.fontFamily = 'var(--font-mono)';
        terminal.style.fontSize = '12px';
        terminal.style.padding = '10px';
        terminal.style.overflowY = 'auto';
        terminal.style.whiteSpace = 'pre-wrap';
        terminal.style.wordBreak = 'break-all';

        const logs = this.stateManager.getTelemetry(node.id) || [];
        logs.forEach((line: string) => {
            const div = document.createElement('div');
            div.textContent = line;
            terminal.appendChild(div);
        });

        terminalCont.appendChild(terminal);
        terminal.scrollTop = terminal.scrollHeight;
    }

    private renderExpandedGraph(node: Node): void {
        this.stopRenderLoop();
        this.telemetryBuffer = null;
        if (this.chartWorker) {
            this.chartWorker.terminate();
            this.chartWorker = null;
        }
        const header = document.createElement('div');
        header.className = 'viewer-header';
        header.style.display = 'flex';
        header.style.gap = '10px';
        header.style.padding = '8px';
        header.style.borderBottom = '1px solid #333';
        header.style.alignItems = 'center';
        header.style.background = '#252526';

        const title = document.createElement('span');
        title.textContent = `CHART: ${node.id}`;
        title.style.fontWeight = 'bold';
        header.appendChild(title);

        const createControl = (label: string, type: string, value: string, callback: (val: string) => void) => {
            const div = document.createElement('div');
            div.style.display = 'flex';
            div.style.alignItems = 'center';
            div.style.gap = '4px';
            const lb = document.createElement('label');
            lb.textContent = label;
            lb.style.fontSize = '10px';
            const input = document.createElement('input');
            input.type = type;
            input.value = value;
            input.style.width = type === 'number' ? '60px' : '30px';
            input.style.fontSize = '10px';
            input.style.background = '#333';
            input.style.color = '#ccc';
            input.style.border = '1px solid #444';
            input.onchange = () => callback(input.value);
            div.appendChild(lb);
            div.appendChild(input);
            return div;
        };

        const minControl = createControl('Min Y:', 'number', '0', (v) => this.chartWorker?.postMessage({ type: 'setConfig', min: Number(v) }));
        const minIn = minControl.querySelector('input')!;
        minIn.id = `viewer-min-y-${node.id}`;
        header.appendChild(minControl);

        const maxControl = createControl('Max Y:', 'number', '1000000', (v) => this.chartWorker?.postMessage({ type: 'setConfig', max: Number(v) }));
        const maxIn = maxControl.querySelector('input')!;
        maxIn.id = `viewer-max-y-${node.id}`;
        header.appendChild(maxControl);

        header.appendChild(createControl('Color:', 'color', '#00f0ff', (v) => this.chartWorker?.postMessage({ type: 'setConfig', color: v })));

        const gridLabel = document.createElement('label');
        gridLabel.style.fontSize = '10px';
        gridLabel.innerHTML = '<input type="checkbox" checked> Grid';
        gridLabel.querySelector('input')!.onchange = (e) => {
            this.chartWorker?.postMessage({ type: 'setConfig', showGrid: (e.target as HTMLInputElement).checked });
        };
        header.appendChild(gridLabel);

        this.container.appendChild(header);

        const canvasCont = document.createElement('div');
        canvasCont.className = 'expanded-graph-container';
        canvasCont.style.flex = "1";
        canvasCont.style.position = "relative";
        canvasCont.style.overflow = "hidden";
        this.container.appendChild(canvasCont);

        const wrapper = document.createElement('div');
        wrapper.style.position = "absolute";
        wrapper.style.inset = "0";
        canvasCont.appendChild(wrapper);

        this.chartCanvas = document.createElement('canvas');
        this.chartCanvas.style.width = "100%";
        this.chartCanvas.style.height = "100%";
        this.chartCanvas.style.display = "block";
        wrapper.appendChild(this.chartCanvas);

        this.chartWorker = new Worker(new URL('./ChartWorker.ts', import.meta.url), { type: 'module' });

        this.chartWorker.onmessage = (e) => {
            if (e.data.type === 'bounds') {
                const minInputEl = document.getElementById(`viewer-min-y-${node.id}`) as HTMLInputElement;
                const maxInputEl = document.getElementById(`viewer-max-y-${node.id}`) as HTMLInputElement;
                if (minInputEl) minInputEl.value = e.data.minY.toExponential(2);
                if (maxInputEl) maxInputEl.value = e.data.maxY.toExponential(2);
            }
        };

        setTimeout(() => {
            if (!this.chartCanvas || !this.chartWorker) return;
            const rect = canvasCont.getBoundingClientRect();
            this.chartCanvas.width = rect.width || 800;
            this.chartCanvas.height = rect.height || 600;
            const offscreen = (this.chartCanvas as any).transferControlToOffscreen();
            this.chartWorker.postMessage({ type: 'init', canvas: offscreen }, [offscreen] as any);
        }, 0);

        const ro = new ResizeObserver(entries => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                this.chartWorker?.postMessage({ type: 'resize', width, height });
            }
        });
        ro.observe(canvasCont);

        const initialData = this.stateManager.getTelemetry(node.id);
        if (initialData) this.handleTelemetry(node.id, initialData);

        this.startRenderLoop();
    }

    private renderStandardNode(node: Node): void {
        this.container.innerHTML = '';
        this.container.style.padding = '10px';
        this.container.style.overflowY = 'auto';

        const title = document.createElement('h3');
        title.textContent = `CONFIG: ${node.type} (${node.id})`;
        title.style.margin = '0 0 15px 0';
        title.style.fontSize = '14px';
        title.style.borderBottom = '1px solid #444';
        title.style.paddingBottom = '5px';
        this.container.appendChild(title);

        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = '120px 1fr';
        grid.style.gap = '10px';
        grid.style.alignItems = 'center';

        for (const [key, value] of Object.entries(node.parameters)) {
            const label = document.createElement('label');
            label.textContent = key.replace(/_/g, ' ').toUpperCase();
            label.style.fontSize = '12px';
            label.style.color = '#888';
            grid.appendChild(label);

            const input = document.createElement('input');
            const isNumeric = typeof value === 'number';
            input.type = isNumeric ? 'number' : 'text';
            if (isNumeric) input.step = '0.01';
            input.value = value.toString();
            input.style.background = '#252526';
            input.style.color = '#ccc';
            input.style.border = '1px solid #444';
            input.style.padding = '4px';
            input.style.fontSize = '12px';

            input.onchange = () => {
                const newVal = isNumeric ? Number(input.value) : input.value;
                this.stateManager.updateNodeParameters(node.id, { [key]: newVal });
            };

            grid.appendChild(input);
        }

        this.container.appendChild(grid);
    }

    private handleTelemetry(nodeId: string, data: any): void {
        if (nodeId !== this.currentNodeId) return;
        if (data instanceof ArrayBuffer) {
            const bufferCopy = data.slice(0);
            this.updateNodeViewerData(nodeId, bufferCopy);
        } else {
            this.updateNodeViewerData(nodeId, data);
        }
    }

    private startRenderLoop(): void {
        if (this.renderRequestId !== null) return;
        const loop = () => {
            if (this.telemetryBuffer && this.chartWorker) {
                if (this.telemetryBuffer instanceof ArrayBuffer) {
                    this.chartWorker.postMessage(this.telemetryBuffer, [this.telemetryBuffer]);
                } else {
                    this.chartWorker.postMessage({
                        type: 'frame',
                        data: this.telemetryBuffer.data
                    });
                }
                this.telemetryBuffer = null;
            }
            this.renderRequestId = requestAnimationFrame(loop);
        };
        this.renderRequestId = requestAnimationFrame(loop);
    }

    private stopRenderLoop(): void {
        if (this.renderRequestId !== null) {
            cancelAnimationFrame(this.renderRequestId);
            this.renderRequestId = null;
        }
    }

    private updateNodeViewerData(nodeId: string, data: any): void {
        const state = this.stateManager.getCurrentState();
        const node = state?.nodes.find(n => n.id === nodeId);
        if (!node) return;

        if (node.type === 'TelemetryText') {
            const terminal = document.getElementById(`viewer-text-${nodeId}`);
            if (terminal && Array.isArray(data)) {
                const currentCount = terminal.children.length;
                if (data.length < currentCount) {
                    terminal.innerHTML = '';
                    data.forEach(line => {
                        const div = document.createElement('div');
                        div.textContent = line;
                        terminal.appendChild(div);
                    });
                } else {
                    for (let i = currentCount; i < data.length; i++) {
                        const div = document.createElement('div');
                        div.textContent = data[i];
                        terminal.appendChild(div);
                    }
                }
                terminal.scrollTop = terminal.scrollHeight;
            }
        } else if (node.type === 'TelemetryGraph') {
            this.telemetryBuffer = data;
        }
    }
}
