import { StateManager, getMeshDisplayHTML, getMPMDisplayHTML } from './state-manager.js';
import { Node, NodeType } from './types.js';
import { PropertyEditor } from './property-editor.js';
import { HostFileBrowserModal } from './host-file-browser.js';
import { Telemetry3DViewport } from './telemetry-3d-viewport.js';
import { MPM_MATERIAL_PRESET_NAMES, MPM_MATERIAL_CATEGORIES, MPM_MATERIAL_PARAM_INFO } from './mpm-presets.js';

export class NodeViewer {
    private container: HTMLElement;
    private stateManager: StateManager;
    private currentNodeId: string | null = null;
    private stateListener: () => void;
    private telemetryListener: (nodeId: string, data: any) => void;

    private propertyEditor: PropertyEditor | null = null;
    private chartWorker: Worker | null = null;
    private chartCanvas: HTMLCanvasElement | null = null;
    private viewport3D: Telemetry3DViewport | null = null;

    private lastType: NodeType | null = null;
    private lastId: string | null = null;

    private selectedGaugeIds: Set<string> = new Set();
    private currentPage: number = 1;
    private searchQuery: string = "";
    private gaugesChannel: number = 0;
    private gaugesCanvas: HTMLCanvasElement | null = null;
    private gaugesResizeObserver: ResizeObserver | null = null;
    private gaugesPanelOpen: boolean = true;
    private gaugesPanelWidth: number = 320;
    private gaugesActiveTab: 'list' | 'settings' = 'list';
    private gaugesZoomedOrPanned: boolean = false;
    private gaugesZoomMinX: number = 0;
    private gaugesZoomMaxX: number = 1.0;
    private gaugesZoomMinY: number = 0.0;
    private gaugesZoomMaxY: number = 1.0;
    private gaugesIsDragging: boolean = false;
    private gaugesDragStartX: number = 0;
    private gaugesDragStartY: number = 0;
    private gaugesDragStartMinX: number = 0;
    private gaugesDragStartMaxX: number = 1.0;
    private gaugesDragStartMinY: number = 0.0;
    private gaugesDragStartMaxY: number = 1.0;

    private telemetryBuffer: any = null;
    private renderRequestId: number | null = null;
    private tabbedFromId: string | null = null;
    private isTabbingForward: boolean = false;
    private isTabbingBackward: boolean = false;
    private pressedEnterOnId: string | null = null;

    private lastColor: string | null = null;
    private lastMinY: number | null = null;
    private lastMaxY: number | null = null;
    private lastChannel: number | null = null;
    private lastShowGridVal: boolean | null = null;
    private lastXAxisModeVal: string | null = null;
    private lastStride: number | null = null;
    private graphFrameCount: number = 0;

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
        if (this.viewport3D) {
            this.viewport3D.destroy();
            this.viewport3D = null;
        }
        this.stateManager.offStateChange(this.stateListener);
        this.stateManager.offTelemetryUpdate(this.telemetryListener);
        if (this.chartWorker) this.chartWorker.terminate();
        this.container.remove();
    }

    public setNode(nodeId: string | null): void {
        if (this.currentNodeId === nodeId) return;
        this.stopRenderLoop();
        if (this.viewport3D) {
            this.viewport3D.destroy();
            this.viewport3D = null;
        }
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
            if (node.type !== 'TelemetryText' && node.type !== 'TelemetryGraph' && node.type !== 'VirtualGauges' && node.type !== 'Telemetry3DViewport') {
                this.renderStandardNode(node);
            } else if (node.type === 'TelemetryGraph') {
                // Sync settings from the node parameters (e.g. after model load)
                const currentChannel = Number(node.parameters?.telemetry_channel ?? 0);
                const meshNode = this.stateManager.getCurrentState()?.nodes.find(n => n.type === 'DomainMesh');
                const is1D = (meshNode?.parameters?.dimension ?? '1D') === '1D';
                const xAxisMode = is1D ? (node.parameters?.x_axis_mode ?? 'radius') : 'cell_id';
                const domainRadius = Number(meshNode?.parameters?.domain_radius ?? 1.0);
                const minVal = Number(node.parameters?.min_y ?? 0);
                const maxVal = Number(node.parameters?.max_y ?? 1000000);
                const colorVal = node.parameters?.color ?? '#00f0ff';
                const showGridVal = node.parameters?.show_grid !== false;
                const currentStride = Number(node.parameters?.plot_stride ?? 1);

                if (this.lastChannel !== currentChannel || this.lastColor !== colorVal) {
                    this.lastChannel = currentChannel;
                    this.lastColor = colorVal;
                    const channelSelect = this.container.querySelector('.viewer-channel-select') as HTMLSelectElement;
                    if (channelSelect) channelSelect.value = String(currentChannel);
                    const colorIn = this.container.querySelector('.viewer-header input[type="color"]') as HTMLInputElement;
                    if (colorIn) colorIn.value = colorVal;
                    this.chartWorker?.postMessage({
                        type: 'setConfig',
                        channel: currentChannel,
                        color: colorVal
                    });
                }

                if (this.lastMinY !== minVal) {
                    this.lastMinY = minVal;
                    const minInput = this.container.querySelector(`#viewer-min-y-${node.id}`) as HTMLInputElement;
                    if (minInput) minInput.value = String(minVal);
                    this.chartWorker?.postMessage({ type: 'setConfig', min: minVal });
                }

                if (this.lastMaxY !== maxVal) {
                    this.lastMaxY = maxVal;
                    const maxInput = this.container.querySelector(`#viewer-max-y-${node.id}`) as HTMLInputElement;
                    if (maxInput) maxInput.value = String(maxVal);
                    this.chartWorker?.postMessage({ type: 'setConfig', max: maxVal });
                }

                if (this.lastShowGridVal !== showGridVal) {
                    this.lastShowGridVal = showGridVal;
                    const gridCheckbox = this.container.querySelector('.viewer-header input[type="checkbox"]') as HTMLInputElement;
                    if (gridCheckbox) gridCheckbox.checked = showGridVal;
                    this.chartWorker?.postMessage({ type: 'setConfig', showGrid: showGridVal });
                }

                if (this.lastStride !== currentStride) {
                    this.lastStride = currentStride;
                    const strideSelect = this.container.querySelector('.viewer-stride-select') as HTMLSelectElement;
                    if (strideSelect) strideSelect.value = String(currentStride);
                }

                if (this.lastXAxisModeVal !== xAxisMode) {
                    this.lastXAxisModeVal = xAxisMode;
                    const xSelect = this.container.querySelector('.viewer-x-axis-select') as HTMLSelectElement;
                    if (xSelect) xSelect.value = xAxisMode;
                    this.chartWorker?.postMessage({
                        type: 'setConfig',
                        xAxisMode: xAxisMode,
                        domainRadius: domainRadius
                    });
                }
            } else if (node.type === 'Telemetry3DViewport') {
                // Slices and visual parameters are synchronized automatically via Telemetry3DViewport's state listener
            }
            return;
        }

        this.renderNodeViewer(node);
    }

    private renderNodeViewer(node: Node): void {
        const oldScrollTop = (this.container.querySelector('.gauges-controls-tab-content') as HTMLElement)?.scrollTop || 0;
        this.lastId = node.id;
        this.lastType = node.type;
        this.container.innerHTML = '';

        if (node.type === 'TelemetryText') {
            this.renderExpandedText(node);
        } else if (node.type === 'TelemetryGraph') {
            this.renderExpandedGraph(node);
        } else if (node.type === 'VirtualGauges') {
            this.renderVirtualGauges(node, oldScrollTop);
        } else if (node.type === 'Telemetry3DViewport') {
            this.renderExpanded3DViewport(node);
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
        terminal.style.fontSize = 'var(--font-sm)';
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

    
    private renderExpanded3DViewport(node: Node): void {
        this.stopRenderLoop();
        if (this.chartWorker) {
            this.chartWorker.terminate();
            this.chartWorker = null;
        }
        if (this.viewport3D) {
            this.viewport3D.destroy();
            this.viewport3D = null;
        }

        const wrapper = document.createElement('div');
        wrapper.style.width = '100%';
        wrapper.style.height = '100%';
        wrapper.style.position = 'relative';
        this.container.appendChild(wrapper);

        this.viewport3D = new Telemetry3DViewport(wrapper, node.id, this.stateManager, '-viewer');
    }

    public getCurrentModelId(): string | null {
        if (!this.currentNodeId) return null;
        const allModels = this.stateManager.getWorkspaceModels();
        for (const m of allModels) {
            if (m.nodes.some(n => n.id === this.currentNodeId)) {
                return m.id;
            }
        }
        return null;
    }

    public pushFrame(buffer: ArrayBuffer, modelId?: string): void {
        if (modelId && this.getCurrentModelId() !== modelId) return;
        if (this.viewport3D) {
            this.viewport3D.pushFrame(buffer, modelId);
        }
    }

    public updateTelemetry(data: any, modelId?: string): void {
        if (modelId && this.getCurrentModelId() !== modelId) return;
        if (this.viewport3D) {
            this.viewport3D.updateTelemetry(data, modelId);
        }
    }

    public setSTLGeometry(vertices: Float32Array | null, modelId?: string, meshId: string = 'default'): void {
        if (modelId && this.getCurrentModelId() !== modelId) return;
        if (this.viewport3D) {
            this.viewport3D.setSTLGeometry(vertices, modelId, meshId);
        }
    }

    public setObstaclesGeometry(vertices: Float32Array | null, cells: Int32Array | null, modelId?: string, meshId: string = 'default'): void {
        if (modelId && this.getCurrentModelId() !== modelId) return;
        if (this.viewport3D) {
            this.viewport3D.setObstaclesGeometry(vertices, cells, modelId, meshId);
        }
    }

    private renderExpandedGraph(node: Node): void {
        this.stopRenderLoop();
        this.telemetryBuffer = null;
        if (this.chartWorker) {
            this.chartWorker.terminate();
            this.chartWorker = null;
        }

        const CHANNELS: { label: string; color: string }[] = [
            { label: 'Pressure',        color: '#00f0ff' },
            { label: 'Density',         color: '#f0a000' },
            { label: 'Velocity',        color: '#a0f000' },
            { label: 'Int. Energy',     color: '#f000a0' },
            { label: 'Mass Fraction',   color: '#a000f0' },
        ];
        const currentChannel = Number(node.parameters?.telemetry_channel ?? 0);
        const initialColor = node.parameters?.color ?? CHANNELS[currentChannel]?.color ?? '#00f0ff';
        const initialMinY = node.parameters?.min_y !== undefined ? Number(node.parameters.min_y) : 0;
        const initialMaxY = node.parameters?.max_y !== undefined ? Number(node.parameters.max_y) : 1000000;
        const showGridVal = node.parameters?.show_grid !== false;
 
        this.lastColor = null;
        this.lastMinY = null;
        this.lastMaxY = null;
        this.lastChannel = null;
        this.lastShowGridVal = null;
        this.lastXAxisModeVal = null;
        this.lastStride = null;
        this.graphFrameCount = 0;

        const meshNode = this.stateManager.getCurrentState()?.nodes.find(n => n.type === 'DomainMesh');
        const is1D = (meshNode?.parameters?.dimension ?? '1D') === '1D';
        const domainRadius = Number(meshNode?.parameters?.domain_radius ?? 1.0);
        const xAxisMode = is1D ? (node.parameters?.x_axis_mode ?? 'radius') : 'cell_id';

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
            lb.style.fontSize = 'var(--font-xs)';
            const input = document.createElement('input');
            input.type = type;
            input.value = value;
            input.style.width = type === 'number' ? '60px' : '30px';
            input.style.fontSize = 'var(--font-xs)';
            input.style.background = '#333';
            input.style.color = '#ccc';
            input.style.border = '1px solid #444';
            input.onchange = () => callback(input.value);
            div.appendChild(lb);
            div.appendChild(input);
            return div;
        };

        const minControl = createControl('Min Y:', 'number', String(initialMinY), (v) => this.stateManager.updateNodeParameters(node.id, { min_y: Number(v) }));
        const minIn = minControl.querySelector('input')!;
        minIn.id = `viewer-min-y-${node.id}`;
        header.appendChild(minControl);

        const maxControl = createControl('Max Y:', 'number', String(initialMaxY), (v) => this.stateManager.updateNodeParameters(node.id, { max_y: Number(v) }));
        const maxIn = maxControl.querySelector('input')!;
        maxIn.id = `viewer-max-y-${node.id}`;
        header.appendChild(maxControl);

        const colorControl = createControl('Color:', 'color', initialColor, (v) => this.stateManager.updateNodeParameters(node.id, { color: v }));
        const colorIn = colorControl.querySelector('input')!;
        header.appendChild(colorControl);

        const gridLabel = document.createElement('label');
        gridLabel.style.fontSize = 'var(--font-xs)';
        gridLabel.innerHTML = `<input type="checkbox" ${showGridVal ? 'checked' : ''}> Grid`;
        gridLabel.querySelector('input')!.onchange = (e) => {
            this.stateManager.updateNodeParameters(node.id, { show_grid: (e.target as HTMLInputElement).checked });
        };
        header.appendChild(gridLabel);

        // Add Channel control
        const channelSelect = document.createElement('select');
        channelSelect.className = 'viewer-channel-select';
        channelSelect.style.fontSize = 'var(--font-xs)';
        channelSelect.style.background = '#333';
        channelSelect.style.color = '#ccc';
        channelSelect.style.border = '1px solid #444';
        channelSelect.style.padding = '2px 4px';
        channelSelect.style.borderRadius = '3px';

        CHANNELS.forEach((ch, idx) => {
            const opt = document.createElement('option');
            opt.value = String(idx);
            opt.textContent = ch.label;
            if (idx === currentChannel) opt.selected = true;
            channelSelect.appendChild(opt);
        });

        channelSelect.onchange = () => {
            const chIdx = Number(channelSelect.value);
            const newColor = CHANNELS[chIdx]?.color ?? '#00f0ff';
            colorIn.value = newColor;
            this.stateManager.updateNodeParameters(node.id, {
                telemetry_channel: chIdx,
                color: newColor
            });
        };

        const channelControl = document.createElement('div');
        channelControl.style.display = 'flex';
        channelControl.style.alignItems = 'center';
        channelControl.style.gap = '4px';
        const channelLabel = document.createElement('label');
        channelLabel.textContent = 'Channel:';
        channelLabel.style.fontSize = 'var(--font-xs)';
        channelControl.appendChild(channelLabel);
        channelControl.appendChild(channelSelect);
        header.appendChild(channelControl);

        // Add Plot Rate (stride) control
        const strideSelect = document.createElement('select');
        strideSelect.className = 'viewer-stride-select';
        strideSelect.style.fontSize = 'var(--font-xs)';
        strideSelect.style.background = '#333';
        strideSelect.style.color = '#ccc';
        strideSelect.style.border = '1px solid #444';
        strideSelect.style.padding = '2px 4px';
        strideSelect.style.borderRadius = '3px';

        const STRIDES = [
            { label: 'Every frame', value: 1 },
            { label: 'Every 2 frames', value: 2 },
            { label: 'Every 5 frames', value: 5 },
            { label: 'Every 10 frames', value: 10 },
            { label: 'Every 20 frames', value: 20 },
            { label: 'Every 50 frames', value: 50 },
            { label: 'Every 100 frames', value: 100 }
        ];

        const currentStride = Number(node.parameters?.plot_stride ?? 1);

        STRIDES.forEach(st => {
            const opt = document.createElement('option');
            opt.value = String(st.value);
            opt.textContent = st.label;
            if (st.value === currentStride) opt.selected = true;
            strideSelect.appendChild(opt);
        });

        strideSelect.onchange = () => {
            const newStride = Number(strideSelect.value);
            this.stateManager.updateNodeParameters(node.id, { plot_stride: newStride });
        };

        const strideControl = document.createElement('div');
        strideControl.style.display = 'flex';
        strideControl.style.alignItems = 'center';
        strideControl.style.gap = '4px';
        const strideLabel = document.createElement('label');
        strideLabel.textContent = 'Rate:';
        strideLabel.style.fontSize = 'var(--font-xs)';
        strideControl.appendChild(strideLabel);
        strideControl.appendChild(strideSelect);
        header.appendChild(strideControl);

        // Add X-Axis selector control if 1D model
        if (is1D) {
            const xSelect = document.createElement('select');
            xSelect.className = 'viewer-x-axis-select';
            xSelect.style.fontSize = 'var(--font-xs)';
            xSelect.style.background = '#333';
            xSelect.style.color = '#ccc';
            xSelect.style.border = '1px solid #444';
            xSelect.style.padding = '2px 4px';
            xSelect.style.borderRadius = '3px';

            const optRadius = document.createElement('option');
            optRadius.value = 'radius';
            optRadius.textContent = 'Radius';
            if (xAxisMode === 'radius') optRadius.selected = true;
            xSelect.appendChild(optRadius);

            const optCell = document.createElement('option');
            optCell.value = 'cell_id';
            optCell.textContent = 'Cell ID';
            if (xAxisMode === 'cell_id') optCell.selected = true;
            xSelect.appendChild(optCell);

            xSelect.onchange = () => {
                const newMode = xSelect.value;
                this.stateManager.updateNodeParameters(node.id, { x_axis_mode: newMode });
                this.chartWorker?.postMessage({
                    type: 'setConfig',
                    xAxisMode: newMode
                });
            };

            const xControl = document.createElement('div');
            xControl.style.display = 'flex';
            xControl.style.alignItems = 'center';
            xControl.style.gap = '4px';
            const xLabel = document.createElement('label');
            xLabel.textContent = 'X-Axis:';
            xLabel.style.fontSize = 'var(--font-xs)';
            xControl.appendChild(xLabel);
            xControl.appendChild(xSelect);
            header.appendChild(xControl);
        }

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
        this.chartCanvas.style.touchAction = "none"; // Prevent default touch panning/scrolling
        wrapper.appendChild(this.chartCanvas);

        // Pointer event listeners for pan and zoom interactions using setPointerCapture
        this.chartCanvas.addEventListener('pointerdown', (e) => {
            this.chartCanvas?.setPointerCapture(e.pointerId);
            this.chartWorker?.postMessage({
                type: 'mouseEvent',
                event: 'mousedown',
                offsetX: e.offsetX,
                offsetY: e.offsetY,
                shiftKey: e.shiftKey
            });
            e.preventDefault();
        });

        this.chartCanvas.addEventListener('pointermove', (e) => {
            if (this.chartCanvas && this.chartCanvas.hasPointerCapture(e.pointerId)) {
                this.chartWorker?.postMessage({
                    type: 'mouseEvent',
                    event: 'mousemove',
                    offsetX: e.offsetX,
                    offsetY: e.offsetY,
                    shiftKey: e.shiftKey
                });
            }
        });

        const releaseCapture = (e: PointerEvent) => {
            if (this.chartCanvas && this.chartCanvas.hasPointerCapture(e.pointerId)) {
                this.chartCanvas.releasePointerCapture(e.pointerId);
                this.chartWorker?.postMessage({
                    type: 'mouseEvent',
                    event: 'mouseup'
                });
            }
        };

        this.chartCanvas.addEventListener('pointerup', releaseCapture);
        this.chartCanvas.addEventListener('pointercancel', releaseCapture);

        this.chartCanvas.addEventListener('wheel', (e) => {
            this.chartWorker?.postMessage({
                type: 'mouseEvent',
                event: 'wheel',
                offsetX: e.offsetX,
                offsetY: e.offsetY,
                deltaY: e.deltaY,
                shiftKey: e.shiftKey
            });
            e.preventDefault();
        }, { passive: false });

        this.chartCanvas.addEventListener('dblclick', (e) => {
            this.chartWorker?.postMessage({
                type: 'mouseEvent',
                event: 'dblclick',
                offsetX: e.offsetX,
                offsetY: e.offsetY,
                shiftKey: e.shiftKey
            });
            e.preventDefault();
        });

        this.chartWorker = new Worker(new URL('./ChartWorker.ts', import.meta.url), { type: 'module' });

        this.chartWorker.onmessage = (e) => {
            if (e.data.type === 'bounds') {
                const minInputEl = document.getElementById(`viewer-min-y-${node.id}`) as HTMLInputElement;
                const maxInputEl = document.getElementById(`viewer-max-y-${node.id}`) as HTMLInputElement;
                if (minInputEl) minInputEl.value = e.data.minY.toExponential(2);
                if (maxInputEl) maxInputEl.value = e.data.maxY.toExponential(2);
                
                this.stateManager.updateNodeParametersInPlace(node.id, {
                    min_y: e.data.minY,
                    max_y: e.data.maxY
                });
            }
        };

        setTimeout(() => {
            if (!this.chartCanvas || !this.chartWorker) return;
            const rect = canvasCont.getBoundingClientRect();
            // Set canvas to logical (CSS) pixel size — the worker scales for DPR
            const cssW = Math.round(rect.width)  || 800;
            const cssH = Math.round(rect.height) || 600;
            this.chartCanvas.width  = cssW;
            this.chartCanvas.height = cssH;
            const offscreen = (this.chartCanvas as any).transferControlToOffscreen();
            this.chartWorker.postMessage(
                { type: 'init', canvas: offscreen, dpr: window.devicePixelRatio || 1 },
                [offscreen] as any
            );
            this.chartWorker.postMessage({
                type: 'setConfig',
                channel: currentChannel,
                color: initialColor,
                min: initialMinY,
                max: initialMaxY,
                showGrid: showGridVal,
                showAxes: true,
                xAxisMode: xAxisMode,
                domainRadius: domainRadius
            });
        }, 0);

        const ro = new ResizeObserver(entries => {
            for (const entry of entries) {
                // Send logical CSS dimensions; worker knows dpr and resizes internally
                const { width, height } = entry.contentRect;
                this.chartWorker?.postMessage({ type: 'resize', width: Math.round(width), height: Math.round(height) });
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
        title.style.fontSize = 'var(--font-md)';
        title.style.borderBottom = '1px solid #444';
        title.style.paddingBottom = '5px';
        this.container.appendChild(title);

        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = '120px 1fr';
        grid.style.gap = '10px';
        grid.style.alignItems = 'center';

        let paramKeys = Object.keys(node.parameters);
        if (node.type === 'MPMMaterialSteel') {
            if (!node.parameters['material_model']) {
                node.parameters['material_model'] = 'Hypoelastic';
            }
            if (!node.parameters['preset']) {
                node.parameters['preset'] = 'Structural Steel (A36)';
            }
            const matModel = node.parameters['material_model'];
            if (matModel === 'Johnson-Cook + Mie-Grüneisen') {
                paramKeys = [
                    'material_model', 'preset',
                    'density', 'youngs_modulus', 'poissons_ratio',
                    'failure_strain', 'tensile_failure_stress',
                    'enable_strain_erosion', 'erosion_strain',
                    'enable_stress_erosion', 'erosion_stress',
                    'enable_timestep_erosion', 'timestep_erosion_factor',
                    'jc_A', 'jc_B', 'jc_n', 'jc_C', 'jc_m', 'T_melt', 'T_room', 'Cp',
                    'mg_gamma0', 'mg_c0', 'mg_s'
                ];
            } else if (matModel === 'RHT Concrete') {
                paramKeys = [
                    'material_model', 'preset',
                    'density', 'youngs_modulus', 'poissons_ratio',
                    'fc', 'ft', 'G_f', 'moisture_content', 'dif_cap_compression', 'dif_cap_tension',
                    'failure_strain', 'tensile_failure_stress',
                    'enable_strain_erosion', 'erosion_strain',
                    'enable_stress_erosion', 'erosion_stress',
                    'enable_timestep_erosion', 'timestep_erosion_factor',
                    'rht_A', 'rht_N', 'rht_B', 'rht_M', 'rht_Q0', 'rht_BQ', 'rht_D1', 'rht_D2',
                    'rht_p_crush', 'rht_p_lock', 'rht_alpha0', 'rht_n_comp', 'rht_betac', 'rht_deltat'
                ];
            } else if (matModel === 'Karagozian & Case (K&C)') {
                paramKeys = [
                    'material_model', 'preset',
                    'density', 'youngs_modulus', 'poissons_ratio',
                    'fc', 'ft', 'G_f', 'moisture_content', 'dif_cap_compression', 'dif_cap_tension',
                    'failure_strain', 'tensile_failure_stress',
                    'enable_strain_erosion', 'erosion_strain',
                    'enable_stress_erosion', 'erosion_stress',
                    'enable_timestep_erosion', 'timestep_erosion_factor',
                    'kc_a0', 'kc_a1', 'kc_a2', 'kc_a0y', 'kc_a1y', 'kc_a2y', 'kc_a1r', 'kc_a2r', 'kc_b1', 'kc_omega'
                ];
            } else if (matModel === 'CSCM Concrete') {
                paramKeys = [
                    'material_model', 'preset',
                    'density', 'youngs_modulus', 'poissons_ratio',
                    'fc', 'ft', 'G_f', 'moisture_content', 'dif_cap_compression', 'dif_cap_tension',
                    'failure_strain', 'tensile_failure_stress',
                    'enable_strain_erosion', 'erosion_strain',
                    'enable_stress_erosion', 'erosion_stress',
                    'enable_timestep_erosion', 'timestep_erosion_factor',
                    'cscm_alpha', 'cscm_theta', 'cscm_lambda', 'cscm_beta', 'cscm_R', 'cscm_X0', 'cscm_W', 'cscm_D1', 'cscm_D2'
                ];
            } else {
                paramKeys = [
                    'material_model', 'preset',
                    'density', 'youngs_modulus', 'poissons_ratio',
                    'yield_stress', 'hardening_modulus',
                    'failure_strain', 'tensile_failure_stress',
                    'enable_strain_erosion', 'erosion_strain',
                    'enable_stress_erosion', 'erosion_stress',
                    'enable_timestep_erosion', 'timestep_erosion_factor'
                ];
            }
        } else if (node.type === 'MPMDomain2D') {
            const hasFLIP = node.parameters['velocity_scheme'] === 'FLIP';
            paramKeys = ['precision', 'transfer_scheme', 'velocity_scheme', 'space_time_scheme', 'smooth_plastic_strain'];
            if (hasFLIP) {
                paramKeys.push('flip_blend');
            }
            paramKeys.push('ppc', 'cfl');
        } else if (node.type === 'MPMDomain3D') {
            const hasFLIP = node.parameters['velocity_scheme'] === 'FLIP';
            paramKeys = ['device', 'precision', 'transfer_scheme', 'velocity_scheme', 'space_time_scheme', 'smooth_plastic_strain'];
            if (hasFLIP) {
                paramKeys.push('flip_blend');
            }
            paramKeys.push('ppc', 'cfl');
        } else if (node.type === 'CFDSolver3D' || node.type === 'CFDSolver2D') {
            paramKeys = paramKeys.filter(k => k !== 'spatial_order' && k !== 'temporal_order');
            const idx = Object.keys(node.parameters).indexOf('spatial_order');
            if (idx !== -1) {
                paramKeys.splice(idx, 0, 'space_time_scheme');
            } else {
                paramKeys.push('space_time_scheme');
            }
        } else if (node.type === 'FEMDomain3D') {
            paramKeys = [
                'device', 'precision', 'cfl',
                'rebar_formulation', 'convert_failed_elements_to_mpm', 'mpm_particles_per_failed_element',
                'material_heterogeneity', 'debris_velocity_smoothing', 'debris_clumping', 'debris_max_clump_size', 'random_seed',
                'hourglass_coeff', 'contact_penalty_scale', 'friction_static', 'friction_kinetic',
                'integration_scheme', 'hourglass_model'
            ];
        } else if (node.type === 'FEMObject3D') {
            paramKeys = [
                'mesh_source', 'shape_type', 'boundary_condition',
                'pos_x', 'pos_y', 'pos_z', 'size_x', 'size_y', 'size_z',
                'radius', 'inner_radius', 'height', 'nx', 'ny', 'nz',
                'vel_x', 'vel_y', 'vel_z', 'bulk_viscosity_b1', 'bulk_viscosity_b2',
                'timestep_erosion_factor', 'k_file'
            ];
        } else if (node.type === 'FEMFSICoupler3D') {
            paramKeys = [
                'cfl', 'steps', 'coupling_scheme', 'pressure_integration',
                'uncovering_method', 'erosion_venting', 'vacuum_density', 'vacuum_pressure'
            ];
        } else if (node.type === 'LSDynaImporter3D') {
            paramKeys = ['k_file', 'scale_factor'];
        }
        if (node.type === 'DomainMesh' || node.type === 'DomainMesh2D' || node.type === 'DomainMesh3D') {
            paramKeys.sort((a, b) => {
                if (a === 'cell_size') return -1;
                if (b === 'cell_size') return 1;
                return 0;
            });
        } else if (node.type === 'Charge1D' || node.type === 'Charge2D' || node.type === 'Charge3D') {
            const chargeOrder = [
                'charge_mass', 'charge_shape',
                'charge_r', 'charge_z', 'charge_x', 'charge_y',
                'charge_radius', 'charge_height', 'charge_aspect_ratio',
                'charge_lx', 'charge_ly', 'charge_lz',
                'charge_rot_x', 'charge_rot_y', 'charge_rot_z'
            ];
            paramKeys.sort((a, b) => {
                const idxA = chargeOrder.indexOf(a);
                const idxB = chargeOrder.indexOf(b);
                if (idxA !== -1 && idxB !== -1) return idxA - idxB;
                if (idxA !== -1) return -1;
                if (idxB !== -1) return 1;
                return 0;
            });
        }

        for (const key of paramKeys) {
            let value = node.parameters[key];
            if (key === 'space_time_scheme') {
                if (node.type === 'MPMDomain2D' || node.type === 'MPMDomain3D') {
                    value = node.parameters['space_time_scheme'] ?? 'Leapfrog';
                } else {
                    const so = node.parameters['spatial_order'] ?? 2;
                    const to = node.parameters['temporal_order'] ?? 4;
                    if (so === 2 && to === 5) value = 'ADER-2 (2nd-Order Space/Time)';
                    else if (so === 3 && to === 6) value = 'ADER-3 (3rd-Order Space/Time)';
                    else value = 'MUSCL-Hancock (2nd-Order Space/Time)';
                }
            }
            if (node.type === 'MPMMaterialSteel') {
                const matModel = node.parameters['material_model'] || 'Hypoelastic';
                const jcKeys = ['jc_A', 'jc_B', 'jc_n', 'jc_C', 'jc_m', 'T_melt', 'T_room', 'Cp', 'mg_gamma0', 'mg_c0', 'mg_s'];
                if (matModel === 'Hypoelastic' && jcKeys.includes(key)) continue;
                if (matModel === 'Johnson-Cook + Mie-Grüneisen' && (key === 'yield_stress' || key === 'hardening_modulus')) continue;
            }
            if (node.type === 'DomainMesh') {

                const dim = node.parameters['dimension'] || '1D';
                if ((key === 'y_min_bc' || key === 'y_max_bc') && dim === '1D') continue;
                if ((key === 'z_min_bc' || key === 'z_max_bc') && (dim === '1D' || dim === '2D')) continue;
            }
            if (node.type === 'FEMDomain3D') {
                const scheme = node.parameters['integration_scheme'] || 'OnePointFB';
                if ((scheme === 'FullGauss8' || scheme === 'SelectiveReduced') && (key === 'hourglass_model' || key === 'hourglass_coeff')) continue;
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
                    const igKeys = ['material_type', 'composition', 'ideal_gamma', 'ideal_rho_0', 'ideal_e_0'];
                    if (!igKeys.includes(key)) continue;
                }
            }
            if (node.type === 'Charge2D' || node.type === 'Charge1D') {
                const shape = node.parameters['charge_shape'] || 'Sphere';
                if ((key === 'charge_height' || key === 'charge_aspect_ratio') && shape !== 'Cylinder') continue;
            }
            if (node.type === 'Charge3D') {
                const shape = node.parameters['charge_shape'] || 'Sphere';
                if (shape === 'Sphere') {
                    if (key === 'charge_height' || key === 'charge_aspect_ratio' || key === 'charge_lx' || key === 'charge_ly' || key === 'charge_lz' || key === 'charge_rot_x' || key === 'charge_rot_y' || key === 'charge_rot_z') continue;
                } else if (shape === 'Cylinder') {
                    if (key === 'charge_lx' || key === 'charge_ly' || key === 'charge_lz') continue;
                } else if (shape === 'Block') {
                    if (key === 'charge_radius' || key === 'charge_height' || key === 'charge_aspect_ratio') continue;
                }
            }
            // DetonatorLocation and DetonatorLocation3D are separate nodes now, showing correct properties

            const label = document.createElement('label');
            let labelText = key.replace(/_/g, ' ').toUpperCase();
            label.textContent = labelText;
            label.style.fontSize = 'var(--font-sm)';
            label.style.color = '#888';

            if (key === 'device') {
                label.innerHTML = `<div style="display:flex; justify-content:space-between; align-items:baseline;">` +
                    `<span style="font-weight:600; color:#ccc;">TARGET DEVICE</span>` +
                    `<span style="font-size:10px; color:#4ec9b0; font-family:monospace; background:rgba(78,201,176,0.15); padding:1px 4px; border-radius:3px; border:1px solid rgba(78,201,176,0.3);">SHARED</span>` +
                    `</div>` +
                    `<div style="font-size:10px; color:#777; margin-top:1px; margin-bottom:2px;">Coupled solver target device</div>`;
            } else if (key === 'precision') {
                label.innerHTML = `<div style="display:flex; justify-content:space-between; align-items:baseline;">` +
                    `<span style="font-weight:600; color:#ccc;">PRECISION</span>` +
                    `<span style="font-size:10px; color:#4ec9b0; font-family:monospace; background:rgba(78,201,176,0.15); padding:1px 4px; border-radius:3px; border:1px solid rgba(78,201,176,0.3);">SHARED</span>` +
                    `</div>` +
                    `<div style="font-size:10px; color:#777; margin-top:1px; margin-bottom:2px;">Coupled solver numeric precision</div>`;
            } else if (node.type === 'MPMMaterialSteel' && MPM_MATERIAL_PARAM_INFO[key]) {
                const info = MPM_MATERIAL_PARAM_INFO[key];
                label.title = info.tooltip;
                label.style.cursor = 'help';
                label.innerHTML = `<div style="display:flex; justify-content:space-between; align-items:baseline;">` +
                    `<span style="font-weight:600; color:#ccc;">${info.label.toUpperCase()}</span>` +
                    (info.unit && info.unit !== 'dim' ? `<span style="font-size:10px; color:#569cd6; font-family:monospace; background:rgba(86,156,214,0.1); padding:1px 4px; border-radius:3px;">${info.unit}</span>` : '') +
                    `</div>` +
                    `<div style="font-size:10px; color:#777; margin-top:1px; margin-bottom:2px;">${info.shortDesc}</div>`;
            }
            grid.appendChild(label);

            const input = this.createInputElement(node, key, value);
            if (node.type === 'MPMMaterialSteel' && MPM_MATERIAL_PARAM_INFO[key]) {
                input.title = MPM_MATERIAL_PARAM_INFO[key].tooltip;
            }
            grid.appendChild(input);
        }

        this.container.appendChild(grid);

        const state = this.stateManager.getCurrentState();
        if (node.type === 'DomainMesh' || node.type === 'DomainMesh2D' || node.type === 'DomainMesh3D') {
            const meshInfoDiv = document.createElement('div');
            meshInfoDiv.style.marginTop = '15px';
            meshInfoDiv.style.fontSize = 'var(--font-sm)';
            meshInfoDiv.style.color = '#569cd6';
            meshInfoDiv.innerHTML = getMeshDisplayHTML(node, state ?? undefined);
            this.container.appendChild(meshInfoDiv);
        }
        if (node.type === 'MPMObject3D' || node.type === 'MPMObject2D' || node.type === 'MPMDomain3D' || node.type === 'MPMDomain2D') {
            const mpmInfoDiv = document.createElement('div');
            mpmInfoDiv.style.marginTop = '15px';
            mpmInfoDiv.innerHTML = getMPMDisplayHTML(node, state ?? undefined);
            this.container.appendChild(mpmInfoDiv);
        }
    }

    private handleTelemetry(nodeId: string, data: any): void {
        if (nodeId !== this.currentNodeId) return;
        const state = this.stateManager.getCurrentState();
        const node = state?.nodes.find(n => n.id === nodeId);
        if (node && node.type === 'VirtualGauges') {
            if (this.gaugesCanvas) {
                const gauges = node.parameters?.gauges || [];
                const has2D = state?.nodes.some(n => n.type === 'DomainMesh2D') || false;
                const history = this.stateManager.getTelemetry(nodeId);
                this.drawGaugesChart(this.gaugesCanvas, history, gauges, this.gaugesChannel, has2D);
            }
            return;
        }
        if (data instanceof ArrayBuffer) {
            const bufferCopy = data.slice(0);
            this.updateNodeViewerData(nodeId, bufferCopy);
        } else {
            this.updateNodeViewerData(nodeId, data);
        }
    }

    private renderVirtualGauges(node: Node, oldScrollTop: number = 0): void {
        this.stopRenderLoop();
        this.telemetryBuffer = null;
        if (this.chartWorker) {
            this.chartWorker.terminate();
            this.chartWorker = null;
        }
        if (this.gaugesResizeObserver) {
            this.gaugesResizeObserver.disconnect();
            this.gaugesResizeObserver = null;
        }
        this.gaugesZoomedOrPanned = false;

        const state = this.stateManager.getCurrentState();
        const has2D = state?.nodes.some(n => n.type === 'DomainMesh2D') || false;
        const is3D = state?.nodes.some(n => n.type === 'DomainMesh3D' || n.type === 'CFDSolver3D') || false;

        const ALL_CHANNELS = [
            { id: 0, param: 'qty_pressure',    label: 'Pressure',          color: '#00f0ff' },
            { id: 1, param: 'qty_density',     label: 'Density',           color: '#ff00f0' },
            { id: 2, param: 'qty_velocity',    label: 'Velocity',          color: '#a0f000' },
            { id: 3, param: 'qty_energy',      label: 'Int. Energy',       color: '#f000a0' },
            { id: 4, param: 'qty_reacted',     label: 'Reacted (Alpha1)',  color: '#f43f5e' },
            { id: 5, param: 'qty_unreacted',   label: 'Unreacted (Alpha2)',color: '#3b82f6' },
            { id: 6, param: 'qty_air',         label: 'Air',               color: '#eab308' },
            { id: 7, param: 'qty_overpressure',label: 'Overpressure',      color: '#38bdf8' },
            { id: 8, param: 'qty_impulse',     label: 'Impulse',           color: '#a78bfa' }
        ];

        const plottableChannels = ALL_CHANNELS.filter(ch => !!node.parameters?.[ch.param]);
        if (plottableChannels.length > 0 && !plottableChannels.some(ch => ch.id === this.gaugesChannel)) {
            this.gaugesChannel = plottableChannels[0].id;
        }

        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';

        const panel = document.createElement('div');
        panel.className = 'gauges-manager-panel';

        // 1. LEFT PANEL: Chart Container
        const chartContainer = document.createElement('div');
        chartContainer.className = 'gauges-chart-container';
        panel.appendChild(chartContainer);

        // Header for Left Panel
        const chartHeader = document.createElement('div');
        chartHeader.className = 'gauges-chart-header';
        
        const titleSpan = document.createElement('span');
        titleSpan.className = 'title';
        titleSpan.textContent = `GAUGES: ${node.id}`;
        chartHeader.appendChild(titleSpan);

        // Channel Select control
        const channelControl = document.createElement('div');
        channelControl.style.display = 'flex';
        channelControl.style.alignItems = 'center';
        channelControl.style.gap = '4px';
        
        const channelLabel = document.createElement('label');
        channelLabel.textContent = 'Channel:';
        channelLabel.style.fontSize = 'var(--font-xs)';
        channelLabel.style.color = '#ccc';
        channelControl.appendChild(channelLabel);

        const channelSelect = document.createElement('select');
        channelSelect.style.fontSize = 'var(--font-xs)';
        channelSelect.style.background = '#333';
        channelSelect.style.color = '#ccc';
        channelSelect.style.border = '1px solid #444';
        channelSelect.style.padding = '2px 4px';
        channelSelect.style.borderRadius = '3px';

        plottableChannels.forEach((ch) => {
            const opt = document.createElement('option');
            opt.value = String(ch.id);
            opt.textContent = ch.label;
            if (ch.id === this.gaugesChannel) opt.selected = true;
            channelSelect.appendChild(opt);
        });

        channelSelect.onchange = () => {
            this.gaugesChannel = Number(channelSelect.value);
            this.gaugesZoomedOrPanned = false;
            const history = this.stateManager.getTelemetry(node.id);
            if (this.gaugesCanvas) {
                this.drawGaugesChart(this.gaugesCanvas, history, node.parameters?.gauges || [], this.gaugesChannel, has2D);
            }
        };

        channelControl.appendChild(channelSelect);
        chartHeader.appendChild(channelControl);

        // Stride control
        const strideSelect = document.createElement('select');
        strideSelect.style.fontSize = 'var(--font-xs)';
        strideSelect.style.background = '#333';
        strideSelect.style.color = '#ccc';
        strideSelect.style.border = '1px solid #444';
        strideSelect.style.padding = '2px 4px';
        strideSelect.style.borderRadius = '3px';

        const STRIDES = [
            { label: 'Every frame', value: 1 },
            { label: 'Every 2 frames', value: 2 },
            { label: 'Every 5 frames', value: 5 },
            { label: 'Every 10 frames', value: 10 },
            { label: 'Every 20 frames', value: 20 },
            { label: 'Every 50 frames', value: 50 },
            { label: 'Every 100 frames', value: 100 }
        ];

        const currentStride = Number(node.parameters?.plot_stride ?? 1);
        STRIDES.forEach(st => {
            const opt = document.createElement('option');
            opt.value = String(st.value);
            opt.textContent = st.label;
            if (st.value === currentStride) opt.selected = true;
            strideSelect.appendChild(opt);
        });
        strideSelect.onchange = () => {
            const newStride = Number(strideSelect.value);
            this.stateManager.updateNodeParameters(node.id, { plot_stride: newStride });
        };

        const strideControl = document.createElement('div');
        strideControl.style.display = 'flex';
        strideControl.style.alignItems = 'center';
        strideControl.style.gap = '4px';
        const strideLabel = document.createElement('label');
        strideLabel.textContent = 'Rate:';
        strideLabel.style.fontSize = 'var(--font-xs)';
        strideLabel.style.color = '#ccc';
        strideControl.appendChild(strideLabel);
        strideControl.appendChild(strideSelect);
        chartHeader.appendChild(strideControl);

        chartContainer.appendChild(chartHeader);

        // Chart Area
        const chartArea = document.createElement('div');
        chartArea.className = 'gauges-chart-area';
        chartContainer.appendChild(chartArea);

        const canvas = document.createElement('canvas');
        canvas.className = 'gauges-canvas';
        chartArea.appendChild(canvas);
        this.gaugesCanvas = canvas;

        canvas.style.touchAction = 'none';

        const getActiveGaugesBounds = () => {
            const history = this.stateManager.getTelemetry(node.id);
            const defaultMinX = 0;
            const timesLength = history?.times?.length || 0;
            const defaultMaxX = timesLength - 1 || 1;
            
            let activeMinX = defaultMinX;
            let activeMaxX = defaultMaxX;
            if (this.gaugesZoomedOrPanned) {
                activeMinX = this.gaugesZoomMinX;
                activeMaxX = this.gaugesZoomMaxX;
            }
            
            const { minVal, maxVal } = this.getGaugesBounds(
                node,
                this.gaugesChannel,
                history,
                this.gaugesZoomedOrPanned ? activeMinX : undefined,
                this.gaugesZoomedOrPanned ? activeMaxX : undefined
            );
            
            return {
                minX: activeMinX,
                maxX: activeMaxX,
                minY: minVal,
                maxY: maxVal
            };
        };

        canvas.addEventListener('pointerdown', (e) => {
            canvas.setPointerCapture(e.pointerId);
            const rect = canvas.getBoundingClientRect();
            this.gaugesIsDragging = true;
            this.gaugesDragStartX = e.clientX - rect.left;

            const active = getActiveGaugesBounds();
            this.gaugesDragStartMinX = active.minX;
            this.gaugesDragStartMaxX = active.maxX;
            
            e.preventDefault();
        });

        canvas.addEventListener('pointermove', (e) => {
            if (this.gaugesIsDragging && canvas.hasPointerCapture(e.pointerId)) {
                const rect = canvas.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;

                const dxScreen = mouseX - this.gaugesDragStartX;

                const padLeft = 60;
                const padRight = 30;
                const plotWidth = rect.width - padLeft - padRight;

                if (plotWidth > 0) {
                    const rangeX = this.gaugesDragStartMaxX - this.gaugesDragStartMinX;
                    const dx = (dxScreen / plotWidth) * rangeX;

                    this.gaugesZoomMinX = this.gaugesDragStartMinX - dx;
                    this.gaugesZoomMaxX = this.gaugesDragStartMaxX - dx;

                    this.gaugesZoomedOrPanned = true;

                    const history = this.stateManager.getTelemetry(node.id);
                    this.drawGaugesChart(canvas, history, node.parameters?.gauges || [], this.gaugesChannel, has2D);
                }
            }
        });

        const releaseGaugesCapture = (e: PointerEvent) => {
            if (canvas.hasPointerCapture(e.pointerId)) {
                canvas.releasePointerCapture(e.pointerId);
                this.gaugesIsDragging = false;
            }
        };

        canvas.addEventListener('pointerup', releaseGaugesCapture);
        canvas.addEventListener('pointercancel', releaseGaugesCapture);

        canvas.addEventListener('wheel', (e) => {
            const rect = canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;

            const padLeft = 60;
            const padRight = 30;
            const plotWidth = rect.width - padLeft - padRight;

            if (plotWidth <= 0) return;

            const active = getActiveGaugesBounds();

            const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;

            const pctX = (mouseX - padLeft) / plotWidth;
            const targetX = active.minX + pctX * (active.maxX - active.minX);
            const newRangeX = (active.maxX - active.minX) * zoomFactor;

            this.gaugesZoomMinX = targetX - pctX * newRangeX;
            this.gaugesZoomMaxX = this.gaugesZoomMinX + newRangeX;

            this.gaugesZoomedOrPanned = true;

            const history = this.stateManager.getTelemetry(node.id);
            this.drawGaugesChart(canvas, history, node.parameters?.gauges || [], this.gaugesChannel, has2D);
            e.preventDefault();
        }, { passive: false });

        canvas.addEventListener('dblclick', (e) => {
            this.gaugesZoomedOrPanned = false;
            const history = this.stateManager.getTelemetry(node.id);
            this.drawGaugesChart(canvas, history, node.parameters?.gauges || [], this.gaugesChannel, has2D);
            e.preventDefault();
        });

        // Floating gear button to show panel
        const floatBtn = document.createElement('button');
        floatBtn.className = 'gauges-float-btn';
        floatBtn.innerHTML = '⚙️ Gauges & Settings';
        floatBtn.style.display = this.gaugesPanelOpen ? 'none' : 'block';
        floatBtn.onclick = () => {
            this.gaugesPanelOpen = true;
            floatBtn.style.display = 'none';
            const controlsPanel = panel.querySelector('.gauges-controls-panel') as HTMLElement;
            if (controlsPanel) {
                controlsPanel.style.display = 'flex';
                controlsPanel.style.width = `${this.gaugesPanelWidth}px`;
            }
            const splitter = panel.querySelector('.gauges-panel-splitter') as HTMLElement;
            if (splitter) splitter.style.display = 'block';
            // Force redraw/resize of canvas since layout changed
            if (this.gaugesCanvas) {
                this.gaugesCanvas.width = this.gaugesCanvas.clientWidth;
                this.gaugesCanvas.height = this.gaugesCanvas.clientHeight;
                const history = this.stateManager.getTelemetry(node.id);
                this.drawGaugesChart(this.gaugesCanvas, history, node.parameters?.gauges || [], this.gaugesChannel, has2D);
            }
        };
        chartArea.appendChild(floatBtn);


        // 2. RIGHT PANEL: Controls Panel (Hidable)
        const controlsPanel = document.createElement('div');
        controlsPanel.className = 'gauges-controls-panel';
        controlsPanel.style.display = this.gaugesPanelOpen ? 'flex' : 'none';
        controlsPanel.style.width = `${this.gaugesPanelWidth}px`;

        const splitter = document.createElement('div');
        splitter.className = 'gauges-panel-splitter';
        splitter.style.display = this.gaugesPanelOpen ? 'block' : 'none';

        panel.appendChild(splitter);
        panel.appendChild(controlsPanel);

        splitter.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const startX = e.clientX;
            const startW = controlsPanel.offsetWidth;
            controlsPanel.style.transition = 'none';

            const onMove = (me: MouseEvent) => {
                const dx = me.clientX - startX;
                const newW = Math.max(160, Math.min(600, startW - dx));
                controlsPanel.style.width = `${newW}px`;
                this.gaugesPanelWidth = newW;

                if (this.gaugesCanvas) {
                    this.gaugesCanvas.width = this.gaugesCanvas.clientWidth;
                    this.gaugesCanvas.height = this.gaugesCanvas.clientHeight;
                    const history = this.stateManager.getTelemetry(node.id);
                    this.drawGaugesChart(this.gaugesCanvas, history, node.parameters?.gauges || [], this.gaugesChannel, has2D);
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

        // Controls Panel Header
        const controlsHeader = document.createElement('div');
        controlsHeader.className = 'gauges-controls-header';
        
        const controlsTitle = document.createElement('span');
        controlsTitle.textContent = '⚙️ GAUGE CONTROLS';
        controlsHeader.appendChild(controlsTitle);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'gauges-controls-close-btn';
        closeBtn.innerHTML = '▶';
        closeBtn.title = 'Collapse Panel';
        closeBtn.onclick = () => {
            this.gaugesPanelOpen = false;
            controlsPanel.style.display = 'none';
            floatBtn.style.display = 'block';
            const splitter = panel.querySelector('.gauges-panel-splitter') as HTMLElement;
            if (splitter) splitter.style.display = 'none';
            // Force redraw/resize of canvas since layout changed
            if (this.gaugesCanvas) {
                this.gaugesCanvas.width = this.gaugesCanvas.clientWidth;
                this.gaugesCanvas.height = this.gaugesCanvas.clientHeight;
                const history = this.stateManager.getTelemetry(node.id);
                this.drawGaugesChart(this.gaugesCanvas, history, node.parameters?.gauges || [], this.gaugesChannel, has2D);
            }
        };
        controlsHeader.appendChild(closeBtn);
        controlsPanel.appendChild(controlsHeader);

        // Tabs
        const tabsBar = document.createElement('div');
        tabsBar.className = 'gauges-controls-tabs';
        
        const tabListBtn = document.createElement('button');
        tabListBtn.className = `gauges-tab-btn ${this.gaugesActiveTab === 'list' ? 'active' : ''}`;
        tabListBtn.textContent = 'Gauges';
        
        const tabSettingsBtn = document.createElement('button');
        tabSettingsBtn.className = `gauges-tab-btn ${this.gaugesActiveTab === 'settings' ? 'active' : ''}`;
        tabSettingsBtn.textContent = 'Settings';

        tabsBar.appendChild(tabListBtn);
        tabsBar.appendChild(tabSettingsBtn);
        controlsPanel.appendChild(tabsBar);

        // Tab Content Area
        const tabContent = document.createElement('div');
        tabContent.className = 'gauges-controls-tab-content';
        controlsPanel.appendChild(tabContent);

        // Switch Tabs logic
        const showTab = (tab: 'list' | 'settings', restoreScroll = 0) => {
            this.gaugesActiveTab = tab;
            tabListBtn.className = `gauges-tab-btn ${tab === 'list' ? 'active' : ''}`;
            tabSettingsBtn.className = `gauges-tab-btn ${tab === 'settings' ? 'active' : ''}`;
            tabContent.innerHTML = '';
            if (tab === 'list') {
                renderListTab();
            } else {
                renderSettingsTab();
            }
            if (restoreScroll > 0) {
                tabContent.scrollTop = restoreScroll;
            }
        };

        tabListBtn.onclick = () => showTab('list');
        tabSettingsBtn.onclick = () => showTab('settings');

        // Helper to render LIST tab
        const renderListTab = () => {
            const toolbarDiv = document.createElement('div');
            toolbarDiv.style.display = 'flex';
            toolbarDiv.style.gap = '8px';
            toolbarDiv.style.marginBottom = '8px';

            const addBtn = document.createElement('button');
            addBtn.className = 'primary';
            addBtn.textContent = '+ Add Gauge';
            addBtn.onclick = () => {
                const gauges = node.parameters?.gauges || [];
                const nextIdx = gauges.length + 1;
                const newGauge = is3D 
                    ? { id: `G${nextIdx}`, name: `G${nextIdx}`, x: 0.5, y: 0.5, z: 0.5, active: true, plot: true }
                    : { id: `G${nextIdx}`, name: `G${nextIdx}`, r: 0.1, z: 0.0, active: true, plot: true };
                const newGauges = [...gauges, newGauge];
                this.stateManager.updateNodeParameters(node.id, { gauges: newGauges });
                this.render();
            };
            toolbarDiv.appendChild(addBtn);

            const deleteSelBtn = document.createElement('button');
            deleteSelBtn.className = 'danger';
            deleteSelBtn.textContent = 'Delete Selected';
            const selectedCount = (node.parameters?.gauges || []).filter((g: any) => g.plot !== false).length;
            if (selectedCount === 0) {
                deleteSelBtn.disabled = true;
                deleteSelBtn.style.opacity = '0.5';
                deleteSelBtn.style.cursor = 'not-allowed';
            }
            deleteSelBtn.onclick = () => {
                const gauges = node.parameters?.gauges || [];
                const remaining = gauges.filter((g: any) => g.plot === false);
                this.stateManager.updateNodeParameters(node.id, { gauges: remaining });
                this.render();
            };
            toolbarDiv.appendChild(deleteSelBtn);

            const clearBtn = document.createElement('button');
            clearBtn.className = 'danger';
            clearBtn.textContent = 'Clear All';
            clearBtn.onclick = () => {
                this.stateManager.updateNodeParameters(node.id, { gauges: [] });
                this.render();
            };
            toolbarDiv.appendChild(clearBtn);
            tabContent.appendChild(toolbarDiv);

            const searchInput = document.createElement('input');
            searchInput.type = 'text';
            searchInput.placeholder = 'Search gauges...';
            searchInput.value = this.searchQuery;
            searchInput.style.background = '#252526';
            searchInput.style.color = '#ccc';
            searchInput.style.border = '1px solid #444';
            searchInput.style.padding = '4px 8px';
            searchInput.style.borderRadius = '4px';
            searchInput.style.fontSize = 'var(--font-xs)';
            searchInput.style.boxSizing = 'border-box';
            searchInput.style.width = '100%';
            searchInput.style.marginBottom = '8px';
            searchInput.addEventListener('input', () => {
                this.searchQuery = searchInput.value;
                this.syncVirtualGauges(node, has2D);
            });
            tabContent.appendChild(searchInput);

            const tableContainer = document.createElement('div');
            tableContainer.className = 'gauges-table-container';
            tabContent.appendChild(tableContainer);

            const paginationControls = document.createElement('div');
            paginationControls.className = 'gauges-pagination-controls';
            paginationControls.style.display = 'flex';
            paginationControls.style.justifyContent = 'space-between';
            paginationControls.style.alignItems = 'center';
            paginationControls.style.padding = '4px 0';

            const infoSpan = document.createElement('span');
            infoSpan.className = 'gauges-pagination-info';
            infoSpan.style.fontSize = 'var(--font-xs)';
            infoSpan.style.color = '#71717a';
            paginationControls.appendChild(infoSpan);

            const btnContainer = document.createElement('div');
            btnContainer.style.display = 'flex';
            btnContainer.style.gap = '4px';

            const prevBtn = document.createElement('button');
            prevBtn.className = 'gauges-prev-page-btn';
            prevBtn.textContent = '◀';
            prevBtn.style.background = '#333';
            prevBtn.style.color = '#ccc';
            prevBtn.style.border = '1px solid #444';
            prevBtn.style.padding = '2px 6px';
            prevBtn.style.borderRadius = '3px';
            prevBtn.style.cursor = 'pointer';
            prevBtn.onclick = () => {
                if (this.currentPage > 1) {
                    this.currentPage--;
                    this.syncVirtualGauges(node, has2D);
                }
            };
            btnContainer.appendChild(prevBtn);

            const nextBtn = document.createElement('button');
            nextBtn.className = 'gauges-next-page-btn';
            nextBtn.textContent = '▶';
            nextBtn.style.background = '#333';
            nextBtn.style.color = '#ccc';
            nextBtn.style.border = '1px solid #444';
            nextBtn.style.padding = '2px 6px';
            nextBtn.style.borderRadius = '3px';
            nextBtn.style.cursor = 'pointer';
            nextBtn.onclick = () => {
                const gauges = node.parameters?.gauges || [];
                const query = this.searchQuery.toLowerCase().trim();
                const filteredGauges = gauges.filter((g: any) => 
                    (g.id || g.name || '').toLowerCase().includes(query) ||
                    (is3D 
                        ? (String(g.x).includes(query) || String(g.y).includes(query) || String(g.z).includes(query))
                        : (String(g.r).includes(query) || (has2D && String(g.z).includes(query))))
                );
                const totalPages = Math.ceil(filteredGauges.length / 50) || 1;
                if (this.currentPage < totalPages) {
                    this.currentPage++;
                    this.syncVirtualGauges(node, has2D);
                }
            };
            btnContainer.appendChild(nextBtn);
            paginationControls.appendChild(btnContainer);
            tabContent.appendChild(paginationControls);

            this.syncVirtualGauges(node, has2D);
        };

        // Helper to render SETTINGS tab
        const renderSettingsTab = () => {
            // Group 1: Export Formats
            const fmtSection = document.createElement('div');
            fmtSection.style.display = 'flex';
            fmtSection.style.flexDirection = 'column';
            fmtSection.style.gap = '6px';
            
            const fmtLabel = document.createElement('div');
            fmtLabel.innerHTML = 'EXPORT FORMATS';
            fmtLabel.style.fontWeight = 'bold';
            fmtLabel.style.color = '#00adff';
            fmtLabel.style.fontSize = '9px';
            fmtLabel.style.letterSpacing = '1px';
            fmtSection.appendChild(fmtLabel);

            const formatsGrid = document.createElement('div');
            formatsGrid.style.display = 'grid';
            formatsGrid.style.gridTemplateColumns = 'repeat(3, 1fr)';
            formatsGrid.style.gap = '8px';

            const createCheckbox = (key: string, labelText: string) => {
                const wrap = document.createElement('label');
                wrap.style.display = 'flex';
                wrap.style.alignItems = 'center';
                wrap.style.gap = '4px';
                wrap.style.fontSize = 'var(--font-xs)';
                wrap.style.cursor = 'pointer';
                wrap.style.color = '#ccc';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = !!node.parameters[key];
                cb.onchange = () => {
                    this.updateParameter(node, key, cb.checked);
                };
                wrap.appendChild(cb);
                wrap.appendChild(document.createTextNode(labelText));
                return wrap;
            };

            formatsGrid.appendChild(createCheckbox('export_ascii', 'ASCII'));
            formatsGrid.appendChild(createCheckbox('export_binary', 'Binary'));
            formatsGrid.appendChild(createCheckbox('export_hdf5', 'HDF5'));
            fmtSection.appendChild(formatsGrid);
            tabContent.appendChild(fmtSection);

            // Group 2: Output File Config
            const configSection = document.createElement('div');
            configSection.style.display = 'flex';
            configSection.style.flexDirection = 'column';
            configSection.style.gap = '8px';

            const configLabel = document.createElement('div');
            configLabel.innerHTML = 'FILE CONFIGURATION';
            configLabel.style.fontWeight = 'bold';
            configLabel.style.color = '#00adff';
            configLabel.style.fontSize = '9px';
            configLabel.style.letterSpacing = '1px';
            configSection.appendChild(configLabel);

            const createField = (key: string, labelText: string, inputEl: HTMLElement) => {
                const wrap = document.createElement('div');
                wrap.style.display = 'flex';
                wrap.style.flexDirection = 'column';
                wrap.style.gap = '4px';

                const lbl = document.createElement('label');
                lbl.textContent = labelText;
                lbl.style.fontSize = 'var(--font-xs)';
                lbl.style.color = '#aaa';
                wrap.appendChild(lbl);

                if (key === 'output_dir') {
                    const browseWrap = document.createElement('div');
                    browseWrap.style.display = 'flex';
                    browseWrap.style.gap = '6px';
                    browseWrap.style.alignItems = 'center';

                    inputEl.style.flex = '1';
                    browseWrap.appendChild(inputEl);

                    const browseBtn = document.createElement('button');
                    browseBtn.type = 'button';
                    browseBtn.textContent = 'Browse';
                    browseBtn.style.padding = '3px 6px';
                    browseBtn.style.fontSize = '10px';
                    browseBtn.style.background = '#333';
                    browseBtn.style.color = '#fff';
                    browseBtn.style.border = '1px solid #555';
                    browseBtn.style.cursor = 'pointer';
                    browseBtn.onclick = () => {
                        const startPath = node.parameters[key] || '';
                        const browser = new HostFileBrowserModal((window as any).networkManager, {
                            title: 'Select Output Directory (Host)',
                            mode: 'save',
                            selectFolderOnly: true,
                            onSelect: (dirPath) => {
                                this.updateParameter(node, key, dirPath);
                            }
                        });
                        browser.open(startPath);
                    };
                    browseWrap.appendChild(browseBtn);
                    wrap.appendChild(browseWrap);
                } else {
                    wrap.appendChild(inputEl);
                }
                return wrap;
            };

            const delimSelect = this.createInputElement(node, 'ascii_delimiter', node.parameters['ascii_delimiter'] ?? 'Comma');
            delimSelect.style.width = '100%';
            configSection.appendChild(createField('ascii_delimiter', 'ASCII Delimiter', delimSelect));

            const precInput = this.createInputElement(node, 'ascii_precision', node.parameters['ascii_precision'] ?? 6);
            precInput.style.width = '100%';
            configSection.appendChild(createField('ascii_precision', 'ASCII Precision', precInput));

            const fileInput = this.createInputElement(node, 'custom_filename', node.parameters['custom_filename'] ?? 'gauges');
            fileInput.style.width = '100%';
            configSection.appendChild(createField('custom_filename', 'Custom Filename', fileInput));

            const dirInput = this.createInputElement(node, 'output_dir', node.parameters['output_dir'] ?? '');
            dirInput.style.width = '100%';
            configSection.appendChild(createField('output_dir', 'Output Directory', dirInput));

            const headerLabel = createCheckbox('include_header', 'Include Header Row');
            configSection.appendChild(headerLabel);

            tabContent.appendChild(configSection);

            // Group 3: Output Quantities
            const qtySection = document.createElement('div');
            qtySection.style.display = 'flex';
            qtySection.style.flexDirection = 'column';
            qtySection.style.gap = '8px';

            const qtyLabel = document.createElement('div');
            qtyLabel.innerHTML = 'RECORD QUANTITIES';
            qtyLabel.style.fontWeight = 'bold';
            qtyLabel.style.color = '#00adff';
            qtyLabel.style.fontSize = '9px';
            qtyLabel.style.letterSpacing = '1px';
            qtySection.appendChild(qtyLabel);

            const qtyGrid = document.createElement('div');
            qtyGrid.style.display = 'grid';
            qtyGrid.style.gridTemplateColumns = 'repeat(2, 1fr)';
            qtyGrid.style.gap = '8px';

            qtyGrid.appendChild(createCheckbox('qty_pressure', 'Pressure'));
            qtyGrid.appendChild(createCheckbox('qty_density', 'Density'));
            qtyGrid.appendChild(createCheckbox('qty_velocity', 'Velocity'));
            qtyGrid.appendChild(createCheckbox('qty_energy', 'Internal Energy'));
            qtyGrid.appendChild(createCheckbox('qty_reacted', 'Reacted'));
            qtyGrid.appendChild(createCheckbox('qty_unreacted', 'Unreacted'));
            qtyGrid.appendChild(createCheckbox('qty_air', 'Air'));
            qtyGrid.appendChild(createCheckbox('qty_overpressure', 'Overpressure'));
            qtyGrid.appendChild(createCheckbox('qty_impulse', 'Impulse'));

            qtySection.appendChild(qtyGrid);
            tabContent.appendChild(qtySection);
        };

        this.container.appendChild(panel);

        this.gaugesResizeObserver = new ResizeObserver(() => {
            canvas.width = canvas.clientWidth;
            canvas.height = canvas.clientHeight;
            const history = this.stateManager.getTelemetry(node.id);
            this.drawGaugesChart(canvas, history, node.parameters?.gauges || [], this.gaugesChannel, has2D);
        });
        this.gaugesResizeObserver.observe(canvas);

        // Restore focus if we tabbed or pressed enter
        if (this.gaugesActiveTab === 'list') {
            const table = this.container.querySelector('table') as HTMLTableElement;
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

        showTab(this.gaugesActiveTab, oldScrollTop);
    }

    private syncVirtualGauges(node: Node, has2D: boolean): void {
        const tableContainer = this.container.querySelector('.gauges-table-container') as HTMLElement;
        if (!tableContainer) return;

        const state = this.stateManager.getCurrentState();
        const gauges = node.parameters?.gauges || [];
        const is3D = state?.nodes.some(n => n.type === 'DomainMesh3D' || n.type === 'CFDSolver3D') || false;

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
        
        const query = this.searchQuery.toLowerCase().trim();
        const filteredGauges = gauges.filter((g: any) => 
            (g.id || g.name || '').toLowerCase().includes(query) ||
            (is3D
                ? (String(g.x).includes(query) || String(g.y).includes(query) || String(g.z).includes(query))
                : (String(g.r).includes(query) || (has2D && String(g.z).includes(query))))
        );

        const pageSize = 50;
        const totalItems = filteredGauges.length;
        const totalPages = Math.ceil(totalItems / pageSize) || 1;
        this.currentPage = Math.max(1, Math.min(this.currentPage, totalPages));
        const startIndex = (this.currentPage - 1) * pageSize;
        const endIndex = Math.min(startIndex + pageSize, totalItems);
        const pagedGauges = filteredGauges.slice(startIndex, endIndex);

        const infoSpan = this.container.querySelector('.gauges-pagination-info') as HTMLElement;
        if (infoSpan) {
            infoSpan.textContent = totalItems > 0 
                ? `Showing ${startIndex + 1}-${endIndex} of ${totalItems} gauges`
                : 'No gauges to display';
        }

        const prevBtn = this.container.querySelector('.gauges-prev-page-btn') as HTMLButtonElement;
        const nextBtn = this.container.querySelector('.gauges-next-page-btn') as HTMLButtonElement;
        if (prevBtn) prevBtn.disabled = this.currentPage === 1;
        if (nextBtn) nextBtn.disabled = this.currentPage === totalPages;

        tableContainer.innerHTML = '';
        const table = document.createElement('table');
        table.className = 'gauges-table';
        table.style.width = '100%';
        table.style.borderCollapse = 'collapse';
        table.style.tableLayout = 'fixed';

        const thead = document.createElement('thead');
        const headerTr = document.createElement('tr');
        const thSel = document.createElement('th');
        thSel.style.width = '25px';
        thSel.style.textAlign = 'center';
        const masterCheck = document.createElement('input');
        masterCheck.type = 'checkbox';
        masterCheck.checked = pagedGauges.length > 0 && pagedGauges.every((g: any) => g.plot !== false);
        masterCheck.onchange = () => {
            const checked = masterCheck.checked;
            pagedGauges.forEach((g: any) => { g.plot = checked; });
            this.stateManager.updateNodeParameters(node.id, { gauges: gauges });
            this.render();
        };
        thSel.appendChild(masterCheck);
        headerTr.appendChild(thSel);

        if (is3D) {
            headerTr.insertAdjacentHTML('beforeend', `
                <th style="width: 50px;">ID</th>
                <th style="width: 60px;">X (m)</th>
                <th style="width: 60px;">Y (m)</th>
                <th style="width: 60px;">Z (m)</th>
                <th style="width: 30px; text-align: center;">Actions</th>
            `);
        } else {
            headerTr.insertAdjacentHTML('beforeend', `
                <th style="width: 50px;">ID</th>
                <th style="width: 80px;">R (m)</th>
                ${has2D ? '<th style="width: 80px;">Z (m)</th>' : ''}
                <th style="width: 30px; text-align: center;">Actions</th>
            `);
        }
        thead.appendChild(headerTr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        pagedGauges.forEach((g: any, idx: number) => {
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid #27272a';

            const tdSel = document.createElement('td');
            tdSel.style.padding = '6px 8px';
            tdSel.style.textAlign = 'center';
            const check = document.createElement('input');
            check.type = 'checkbox';
            check.checked = g.plot !== false;
            check.onchange = () => {
                g.plot = check.checked;
                this.stateManager.updateNodeParameters(node.id, { gauges: gauges });
                this.render();
            };
            tdSel.appendChild(check);
            tr.appendChild(tdSel);

            const tdId = document.createElement('td');
            tdId.style.padding = '6px 8px';
            const inputId = document.createElement('input');
            inputId.type = 'text';
            inputId.id = `gauge-input-${node.id}-${idx}-id`;
            inputId.value = g.id || g.name || '';
            inputId.style.width = '100%';
            inputId.style.fontWeight = 'bold';
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
                tdX.style.padding = '6px 8px';
                const inputX = document.createElement('input');
                inputX.type = 'text';
                inputX.id = `gauge-input-${node.id}-${idx}-x`;
                inputX.inputMode = 'decimal';
                inputX.value = String(g.x ?? 0.5);
                inputX.style.width = '100%';
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
                tdY.style.padding = '6px 8px';
                const inputY = document.createElement('input');
                inputY.type = 'text';
                inputY.id = `gauge-input-${node.id}-${idx}-y`;
                inputY.inputMode = 'decimal';
                inputY.value = String(g.y ?? 0.5);
                inputY.style.width = '100%';
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
                tdZ.style.padding = '6px 8px';
                const inputZ = document.createElement('input');
                inputZ.type = 'text';
                inputZ.id = `gauge-input-${node.id}-${idx}-z`;
                inputZ.inputMode = 'decimal';
                inputZ.value = String(g.z ?? 0.5);
                inputZ.style.width = '100%';
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
                tdR.style.padding = '6px 8px';
                const inputR = document.createElement('input');
                inputR.type = 'text';
                inputR.id = `gauge-input-${node.id}-${idx}-r`;
                inputR.inputMode = 'decimal';
                inputR.value = String(g.r ?? 0.1);
                inputR.style.width = '100%';
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
                    tdZ.style.padding = '6px 8px';
                    const inputZ = document.createElement('input');
                    inputZ.type = 'text';
                    inputZ.id = `gauge-input-${node.id}-${idx}-z`;
                    inputZ.inputMode = 'decimal';
                    inputZ.value = String(g.z ?? 0.0);
                    inputZ.style.width = '100%';
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

            const tdActions = document.createElement('td');
            tdActions.style.padding = '6px 8px';
            tdActions.style.textAlign = 'center';
            const delBtn = document.createElement('button');
            delBtn.textContent = 'Delete';
            delBtn.className = 'danger';
            delBtn.style.padding = '2px 6px';
            delBtn.style.fontSize = '10px';
            delBtn.style.borderRadius = '3px';
            delBtn.style.cursor = 'pointer';
            delBtn.onclick = () => {
                const updated = gauges.filter((x: any) => x.id !== g.id);
                this.stateManager.updateNodeParameters(node.id, { gauges: updated });
                this.render();
            };
            tdActions.appendChild(delBtn);
            tr.appendChild(tdActions);

            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        tableContainer.appendChild(table);
    }

    private getGaugesBounds(
        node: Node,
        channel: number,
        history: any,
        activeMinX?: number,
        activeMaxX?: number
    ): { minVal: number; maxVal: number; timesLength: number } {
        const gauges = node.parameters?.gauges || [];
        let minVal = 0;
        let maxVal = 1;
        let hasData = false;
        
        if (history && history.times && history.times.length > 0 && history.values) {
            let minV = Infinity;
            let maxV = -Infinity;
            const startIdx = activeMinX !== undefined ? Math.max(0, Math.floor(activeMinX)) : 0;
            const endIdx = activeMaxX !== undefined ? Math.min(history.times.length - 1, Math.ceil(activeMaxX)) : history.times.length - 1;

            gauges.filter((g: any) => g.plot !== false).forEach((g: any) => {
                const gData = history.values[g.id || g.name];
                if (gData && gData[channel]) {
                    const arr = gData[channel];
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
        return { minVal, maxVal, timesLength: history?.times?.length || 0 };
    }

    private drawGaugesChart(canvas: HTMLCanvasElement, history: any, gauges: any[], channel: number, has2D: boolean): void {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;

        ctx.clearRect(0, 0, width, height);

        if (!history || !history.times || history.times.length === 0 || gauges.length === 0) {
            ctx.fillStyle = '#666';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Waiting for telemetry...', width / 2, height / 2);
            return;
        }

        const state = this.stateManager.getCurrentState();
        const node = state?.nodes.find(n => n.id === this.currentNodeId);
        if (!node) return;

        const times = history.times;
        const values = history.values;

        const defaultMinX = 0;
        const timesLength = history?.times?.length || 0;
        const defaultMaxX = timesLength - 1 || 1;

        let activeMinX = defaultMinX;
        let activeMaxX = defaultMaxX;

        if (this.gaugesZoomedOrPanned) {
            activeMinX = this.gaugesZoomMinX;
            activeMaxX = this.gaugesZoomMaxX;
        } else {
            this.gaugesZoomMinX = defaultMinX;
            this.gaugesZoomMaxX = defaultMaxX;
        }

        const { minVal, maxVal } = this.getGaugesBounds(
            node,
            channel,
            history,
            this.gaugesZoomedOrPanned ? activeMinX : undefined,
            this.gaugesZoomedOrPanned ? activeMaxX : undefined
        );

        const padLeft = 60;
        const padRight = 30;
        const padTop = 20;
        const padBottom = 40;
        const plotWidth = width - padLeft - padRight;
        const plotHeight = height - padTop - padBottom;

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

        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padLeft, padTop);
        ctx.lineTo(padLeft, height - padBottom);
        ctx.lineTo(width - padRight, height - padBottom);
        ctx.stroke();

        ctx.fillStyle = '#888';
        ctx.font = '9px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';

        const numTicksY = 5;
        const activeRangeY = activeMaxY - activeMinY || 1;
        for (let i = 0; i < numTicksY; i++) {
            const pct = i / (numTicksY - 1);
            const val = activeMinY + pct * activeRangeY;
            const y = height - padBottom - pct * plotHeight;
            
            ctx.strokeStyle = '#475569';
            ctx.beginPath();
            ctx.moveTo(padLeft - 4, y);
            ctx.lineTo(padLeft, y);
            ctx.stroke();
            
            ctx.fillText(val.toExponential(2), padLeft - 6, y);
        }

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
        const numTicksX = 5;
        const activeRangeX = activeMaxX - activeMinX || 1;
        for (let i = 0; i < numTicksX; i++) {
            const pct = i / (numTicksX - 1);
            const idx = activeMinX + pct * activeRangeX;
            const tVal = getTimeAtIndex(idx);
            const x = padLeft + pct * plotWidth;
            
            ctx.strokeStyle = '#475569';
            ctx.beginPath();
            ctx.moveTo(x, height - padBottom);
            ctx.lineTo(x, height - padBottom + 4);
            ctx.stroke();
            
            ctx.fillText(`${tVal.toFixed(5)}s`, x, height - padBottom + 6);
        }

        const colors = ['#38bdf8', '#fb7185', '#34d399', '#fbbf24', '#a78bfa', '#2dd4bf'];
        
        ctx.save();
        ctx.beginPath();
        ctx.rect(padLeft, padTop, plotWidth, plotHeight);
        ctx.clip();

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
                    const x = padLeft + ((i - activeMinX) / (activeMaxX - activeMinX || 1)) * plotWidth;
                    const y = height - padBottom - ((v - activeMinY) / (activeRangeY)) * plotHeight;
                    if (first) {
                        ctx.moveTo(x, y);
                        first = false;
                    } else {
                        ctx.lineTo(x, y);
                    }
                });
                ctx.stroke();

                if (arr.length > 0 && times.length > 0) {
                    const lastIdx = Math.min(arr.length - 1, times.length - 1);
                    const lastVal = arr[lastIdx];
                    const labelIdx = Math.max(0, Math.min(lastIdx, Math.round(activeMaxX)));
                    const labelVal = arr[labelIdx] !== undefined ? arr[labelIdx] : lastVal;
                    const x = padLeft + ((labelIdx - activeMinX) / (activeMaxX - activeMinX || 1)) * plotWidth;
                    const y = height - padBottom - ((labelVal - activeMinY) / (activeRangeY)) * plotHeight;
                    ctx.fillStyle = colors[gIdx % colors.length];
                    ctx.font = 'bold 8px monospace';
                    ctx.textAlign = 'left';
                    ctx.fillText(` ${g.id || g.name}`, x, y);
                }
            }
        });
        ctx.restore();
    }

    private startRenderLoop(): void {
        if (this.renderRequestId !== null) return;
        const loop = () => {
            if (this.telemetryBuffer && this.chartWorker) {
                const state = this.stateManager.getCurrentState();
                const node = state?.nodes.find(n => n.id === this.currentNodeId);
                const plotStride = Number(node?.parameters?.plot_stride ?? 1);

                this.graphFrameCount++;
                const status = this.stateManager.getStatus();
                const isTerminated = status === 'TERMINATED';
                const isInitialized = status === 'INITIALIZED';
                const isTimeZero = (this.telemetryBuffer && typeof this.telemetryBuffer === 'object' && 
                                    (this.telemetryBuffer.time === 0 || 
                                     (this.telemetryBuffer.data && this.telemetryBuffer.data.time === 0)));

                if (isInitialized || isTimeZero) {
                    this.graphFrameCount = 1;
                }

                const isInitialOrControl = this.graphFrameCount === 1 || isInitialized || isTerminated || isTimeZero;

                if (plotStride > 1 && !isInitialOrControl && this.graphFrameCount % plotStride !== 0) {
                    this.telemetryBuffer = null;
                } else {
                    if (this.telemetryBuffer instanceof ArrayBuffer) {
                        if (node?.type === 'Telemetry3DViewport') {
                            this.chartWorker.postMessage({ type: 'frame', data: { buffer: this.telemetryBuffer } }, [this.telemetryBuffer]);
                        } else {
                            this.chartWorker.postMessage(this.telemetryBuffer, [this.telemetryBuffer]);
                        }
                    } else {
                        if (node?.type === 'Telemetry3DViewport' && this.telemetryBuffer.type === 'TELEMETRY_3D') {
                            const data = this.telemetryBuffer;
                            this.chartWorker.postMessage({
                                type: 'setConfig',
                                data: {
                                    xmin: data.xmin,
                                    ymin: data.ymin,
                                    zmin: data.zmin,
                                    dx: data.dx,
                                    nx: data.nx,
                                    ny: data.ny,
                                    nz: data.nz
                                }
                            });
                        } else {
                            const pressureData = this.telemetryBuffer.data || this.telemetryBuffer.telemetry;
                            if (pressureData && (Array.isArray(pressureData) || pressureData instanceof Float32Array)) {
                                this.chartWorker.postMessage({
                                    type: 'frame',
                                    data: pressureData
                                });
                            }
                        }
                    }
                    this.telemetryBuffer = null;
                }
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

    private updateNodeViewerData(nodeId: string, data: any): void {
        const state = this.stateManager.getCurrentState();
        const node = state?.nodes.find(n => n.id === nodeId);
        if (!node) return;

        if (node.type === 'TelemetryText') {
            const terminal = document.getElementById(`viewer-text-${nodeId}`);
            if (terminal && Array.isArray(data)) {
                this.syncTerminal(terminal, data);
            }
        } else if (node.type === 'TelemetryGraph' || node.type === 'Telemetry3DViewport') {
            this.telemetryBuffer = data;
        }
    }
    private createInputElement(node: Node, key: string, value: any): HTMLElement {
        const numericKeys = [
            'domain_radius', 'cell_size', 'atm_pressure', 'atm_temperature',
            'charge_mass', 'rho', 'detonation_energy', 'jwl_A', 'jwl_B',
            'jwl_R1', 'jwl_R2', 'jwl_omega', 'det_vel', 'cfl',
            'spatial_order', 'temporal_order', 'gamma', 'plot_stride', 'refresh_rate',
            'ascii_precision', 'step_interval', 'time_interval', 'downsample_stride',
            'telemetry_channel', 'telemetry_interval_ms', 'vtk_step_interval',
            // 2D CFD keys
            'nr', 'nz', 'max_r', 'max_z', 'explosive_x', 'explosive_y', 'explosive_z', 'explosive_radius', 'remap_radius', 'explosive_r', 'trigger_val',
            'charge_r', 'charge_z', 'charge_radius', 'charge_height', 'charge_aspect_ratio',
            'detonator_r', 'detonator_z', 'detonator_radius', 'detonator_x', 'detonator_y',
            'ideal_gamma', 'ideal_rho_0', 'ideal_e_0', 'high_rho', 'ambient_rho', 'ambient_p',
            // 3D CFD keys
            'nx', 'ny', 'nz', 'xmax', 'ymax', 'zmax',
            'charge_x', 'charge_y', 'charge_z', 'charge_lx', 'charge_ly', 'charge_lz',
            'charge_rot_x', 'charge_rot_y', 'charge_rot_z',
            'detonator_x', 'detonator_y', 'detonator_z', 'xmin', 'ymin', 'zmin',
            'origin_x', 'origin_y', 'origin_z', 'dim_x', 'dim_y', 'dim_z', 'scale_factor',
            'min_y', 'max_y', 'min_val', 'max_val', 'stl_min_val', 'stl_max_val', 'obstacles_min_val', 'obstacles_max_val', 'ambientLevel', 'specularIntensity', 'gauge_size', 'gauge_opacity', 'stl_opacity', 'obstacles_opacity', 'grid_opacity',
            'refinement_opacity', 'charge_opacity',
            'amr_max_levels', 'amr_threshold', 'amr_coarsen_ratio', 'amr_tile_size',
            'center_x', 'center_y', 'center_z', 'size_x', 'size_y', 'size_z', 'radius', 'height', 'length', 'refinement_level',
            'submesh_x', 'submesh_y', 'submesh_z', 'submesh_size_x', 'submesh_size_y', 'submesh_size_z',
            'offset', 'stride',
            // MPM keys
            'pos_x', 'pos_y', 'pos_z', 'size_x', 'size_y', 'size_z', 'vel_x', 'vel_y', 'vel_z', 'radius', 'inner_radius',
            'scale_x', 'scale_y', 'scale_z',
            'angular_vel', 'angular_vel_x', 'angular_vel_y', 'angular_vel_z',
            'density', 'youngs_modulus', 'poissons_ratio', 'yield_stress', 'hardening_modulus',
            'failure_strain', 'tensile_failure_stress', 'erosion_strain', 'erosion_stress',
            'jc_A', 'jc_B', 'jc_n', 'jc_C', 'jc_m', 'T_melt', 'T_room', 'Cp',
            'mg_gamma0', 'mg_c0', 'mg_s',
            'ppc',
            'mpmParticleSize', 'mpmParticleMinVal', 'mpmParticleMaxVal', 'mpmParticleOpacity', 'flip_blend',
            // FEM keys
            'hourglass_coeff', 'bulk_viscosity_b1', 'bulk_viscosity_b2', 'timestep_erosion_factor', 'contact_stiffness', 'contact_penalty_scale', 'friction_static', 'friction_kinetic', 'contact_damping',
            'mpm_particles_per_failed_element', 'material_heterogeneity', 'debris_velocity_smoothing', 'debris_clumping', 'debris_max_clump_size', 'random_seed', 'rebar_diameter', 'rebar_area', 'rebarRadius', 'rebar_radius', 'beamRadius', 'beam_radius', 'beam_diameter', 'beam_area', 'beamMinVal', 'beamMaxVal',
            'femMinVal', 'femMaxVal', 'femOpacity', 'vacuum_density', 'vacuum_pressure', 'uncovering_tolerance',
            // Concrete Core & Models (RHT, K&C, CSCM)
            'fc', 'ft', 'G_f', 'moisture_content', 'dif_cap_compression', 'dif_cap_tension',
            'rht_A', 'rht_N', 'rht_B', 'rht_M', 'rht_Q0', 'rht_BQ', 'rht_D1', 'rht_D2',
            'rht_p_crush', 'rht_p_lock', 'rht_alpha0', 'rht_n_comp', 'rht_betac', 'rht_deltat',
            'kc_a0', 'kc_a1', 'kc_a2', 'kc_a0y', 'kc_a1y', 'kc_a2y', 'kc_a1r', 'kc_a2r', 'kc_b1', 'kc_omega',
            'cscm_alpha', 'cscm_theta', 'cscm_lambda', 'cscm_beta', 'cscm_R', 'cscm_X0', 'cscm_W', 'cscm_D1', 'cscm_D2',
            // VTK ROI & Strides
            'roi_xmin', 'roi_xmax', 'roi_ymin', 'roi_ymax', 'roi_zmin', 'roi_zmax', 'volume_stride', 'slice_stride'
        ];

        const chargeShapeOptions = node.type === 'Charge3D' ? ['Sphere', 'Cylinder', 'Block'] : ['Sphere', 'Cylinder'];

        const dropdowns: Record<string, string[]> = {
            'material_model': ['Hypoelastic', 'Johnson-Cook + Mie-Grüneisen', 'RHT Concrete', 'Karagozian & Case (K&C)', 'CSCM Concrete'],
            'rebar_formulation': ['TimoshenkoBeam3D', 'AxialTruss1D'],
            'beam_formulation': ['TimoshenkoBeam3D', 'AxialTruss1D'],
            'beamQuantity': ['plasticStrain', 'vonMises', 'momentOrForce', 'velocity', 'damage'],
            'beamColormap': ['plasma', 'viridis', 'coolwarm', 'rainbow', 'cividis', 'grayscale'],
            'coupling_scheme': ['Two-Way Staggered', 'Sub-Cycling'],
            'pressure_integration': ['2x2 Gauss Quadrature', '1-Point Centroid'],
            'uncovering_method': ['Conservative IDW + Vacuum Cavity', 'Ghost-Fluid Standard'],
            'shape': ['box', 'sphere', 'cylinder'],

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
            'device': ['cpu', 'cuda'],
            'precision': ['double', 'single'],
            'integration_scheme': ['OnePointFB', 'OnePointKF', 'FullGauss8', 'SelectiveReduced'],
            'hourglass_model': ['FlanaganBelytschkoStiffness', 'FlanaganBelytschkoViscous', 'KosloffFrazier'],
            'mesh_source': ['Box Generator', 'Cylinder Generator', 'LS-DYNA Keyword File'],
            'preset': [...MPM_MATERIAL_PRESET_NAMES],
            'trigger_type': node.type === 'VTKOutput' ? ['Step Interval', 'Time Interval'] : ['end', 'time', 'step'],
            'composition': ['Aluminized ANFO', 'Ammonal', 'ANFO', 'Baratol', 'C-4', 'Composition A-3', 'Composition B', 'Composition C-3', 'Cyclotol', 'Heavy ANFO', 'HMX', 'LX-04', 'LX-07', 'LX-10', 'LX-14', 'LX-17', 'Mining Emulsion', 'Octol', 'PBX 9404', 'PBX 9501', 'PBX 9502', 'PE-10', 'PE-12', 'PE-4', 'PE-8', 'Pentolite', 'PETN', 'RDX', 'TATB', 'Tetryl', 'TNT', 'Water Gel', 'Custom'],
            'init_mode': node.type === 'CFDSolver3D' ? ['From1D', 'From2D', 'Multi-Material JWL', 'Ideal Gas'] : ['From1D', 'Multi-Material JWL', 'Ideal Gas'],
            'flux_scheme': ['AUSM+', 'Rusanov'],
            'spatial_order': ['1', '2', '3'],
            'temporal_order': ['1', '2', '3'],
            'plot_stride': ['1', '2', '5', '10', '20', '50', '100'],
            'charge_shape': chargeShapeOptions,
            'material_type': ['Air', 'JWL Charge', 'Ideal Gas Charge'],
            'transfer_scheme': ['BSpline', 'GIMP', 'Standard'],
            'velocity_scheme': ['APIC', 'PIC', 'FLIP'],
            'shape_type': node.type === 'FEMObject3D' ? ['Box', 'Cylinder', 'LS-DYNA File'] : (node.type === 'MPMObject3D' ? ['Box', 'Sphere', 'Cylinder', 'STL'] : ['Rectangle', 'Circle']),
            'coupling_mode': ['TwoWay_Full', 'OneWay_CFD_to_MPM', 'Disabled'],
            'contour_quantity': ['von_mises', 'plastic_strain', 'density', 'velocity', 'pressure'],
            'color_map': ['viridis', 'plasma', 'jet', 'coolwarm'],
            'space_time_scheme': (node.type === 'MPMDomain2D' || node.type === 'MPMDomain3D') ? 
                ['Leapfrog', 'RK2', 'USL', 'USF'] : 
                ['MUSCL-Hancock (2nd-Order Space/Time)', 'ADER-2 (2nd-Order Space/Time)', 'ADER-3 (3rd-Order Space/Time)']
        };

        if (typeof value === 'boolean') {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';
            select.style.fontSize = 'var(--font-sm)';

            ['true', 'false'].forEach(opt => {
                const option = document.createElement('option');
                option.value = opt;
                option.text = opt === 'true' ? 'True' : 'False';
                if ((opt === 'true') === value) option.selected = true;
                select.appendChild(option);
            });

            select.addEventListener('change', () => {
                this.updateParameter(node, key, select.value === 'true');
            });
            return select;
        }

        if (dropdowns[key]) {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';
            select.style.fontSize = 'var(--font-sm)';

            const strVal = String(value ?? '');
            let selectedMatched = false;

            if (key === 'preset') {
                MPM_MATERIAL_CATEGORIES.forEach(group => {
                    const optgroup = document.createElement('optgroup');
                    optgroup.label = group.category;
                    group.presets.forEach(opt => {
                        const option = document.createElement('option');
                        option.value = opt;
                        option.text = opt;
                        if (strVal && (opt.toLowerCase() === strVal.toLowerCase() || opt === strVal)) {
                            option.selected = true;
                            selectedMatched = true;
                        }
                        optgroup.appendChild(option);
                    });
                    select.appendChild(optgroup);
                });
            } else {
                dropdowns[key].forEach(opt => {
                    const option = document.createElement('option');
                    option.value = opt;
                    let text = opt;
                    if (key === 'device') {
                        if (opt === 'cpu') text = 'CPU';
                        else if (opt === 'cuda') text = 'CUDA GPU';
                    }
                    option.text = text;
                    if (strVal && (
                        opt.toLowerCase() === strVal.toLowerCase() ||
                        opt === strVal ||
                        (!isNaN(Number(opt)) && !isNaN(Number(strVal)) && Math.abs(Number(opt) - Number(strVal)) < 0.001)
                    )) {
                        option.selected = true;
                        selectedMatched = true;
                    }
                    select.appendChild(option);
                });
            }

            if (!selectedMatched && select.options.length > 0) {
                select.options[0].selected = true;
            }

            select.addEventListener('change', () => {
                let val: any = select.value;
                if (key === 'space_time_scheme') {
                    if (node.type === 'MPMDomain2D' || node.type === 'MPMDomain3D') {
                        this.updateParameter(node, key, val);
                    } else {
                        let s_order = 2;
                        let t_order = 4;
                        if (val === 'ADER-2 (2nd-Order Space/Time)') { s_order = 2; t_order = 5; }
                        else if (val === 'ADER-3 (3rd-Order Space/Time)') { s_order = 3; t_order = 6; }
                        else { s_order = 2; t_order = 4; }
                        
                        this.stateManager.updateNodeParameters(node.id, {
                            spatial_order: s_order,
                            temporal_order: t_order
                        });
                        this.render();
                    }
                } else {
                    if (numericKeys.includes(key)) val = Number(val);
                    this.updateParameter(node, key, val);
                }
            });
            return select;
        }

        const input = document.createElement('input');
        const isNumeric = numericKeys.includes(key) || typeof value === 'number';
        input.type = isNumeric ? 'number' : 'text';
        if (input.type === 'number') input.step = 'any';
        input.value = value;
        input.style.width = '100%';
        input.style.background = '#252526';
        input.style.color = '#ccc';
        input.style.border = '1px solid #444';
        input.style.padding = '4px';
        input.style.fontSize = 'var(--font-sm)';

        input.addEventListener('change', () => {
            let newVal: any = input.value;
            if (input.type === 'number') {
                newVal = Number(input.value);
            }
            this.updateParameter(node, key, newVal);
        });

        return input;
    }

    private updateParameter(node: Node, key: string, value: any): void {
        const updates: Record<string, any> = { [key]: value };

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
            const preset = EXPLOSIVE_PRESETS[value];
            if (preset) {
                const matType = node.parameters['material_type'] || 'Air';
                if (matType === 'Ideal Gas Charge') {
                    updates['ideal_rho_0'] = preset.rho;
                    updates['ideal_e_0'] = preset.detonation_energy;
                } else {
                    Object.assign(updates, preset);
                }
            }
        } else if (node.type === 'Material' && ['rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega'].includes(key)) {
            updates['composition'] = 'Custom';
        } else if (node.type === 'Material' && ['ideal_rho_0', 'ideal_e_0', 'ideal_gamma'].includes(key)) {
            updates['composition'] = 'Custom';
        }

        this.stateManager.updateNodeParameters(node.id, updates);
        this.render();
    }
}
