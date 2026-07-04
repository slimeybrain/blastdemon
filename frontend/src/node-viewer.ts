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
        wrapper.appendChild(this.chartCanvas);

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
            if (node.type === 'MaterialExplosive' || node.type === 'MaterialIdealGas') {
                const shape = node.parameters['charge_shape'] || 'Sphere';
                if (key === 'charge_height' && shape !== 'Cylinder') continue;
            }

            const label = document.createElement('label');
            label.textContent = key.replace(/_/g, ' ').toUpperCase();
            label.style.fontSize = 'var(--font-sm)';
            label.style.color = '#888';
            grid.appendChild(label);

            const input = this.createInputElement(node, key, value);
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
                const state = this.stateManager.getCurrentState();
                const node = state?.nodes.find(n => n.id === this.currentNodeId);
                const plotStride = Number(node?.parameters?.plot_stride ?? 1);

                this.graphFrameCount++;
                const isTerminated = this.stateManager.getStatus() === 'TERMINATED';

                if (plotStride > 1 && this.graphFrameCount % plotStride !== 0 && !isTerminated) {
                    this.telemetryBuffer = null;
                } else {
                    if (this.telemetryBuffer instanceof ArrayBuffer) {
                        this.chartWorker.postMessage(this.telemetryBuffer, [this.telemetryBuffer]);
                    } else {
                        const pressureData = this.telemetryBuffer.data || this.telemetryBuffer.telemetry;
                        if (pressureData && (Array.isArray(pressureData) || pressureData instanceof Float32Array)) {
                            this.chartWorker.postMessage({
                                type: 'frame',
                                data: pressureData
                            });
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
        } else if (node.type === 'TelemetryGraph') {
            this.telemetryBuffer = data;
        }
    }

    private createInputElement(node: Node, key: string, value: any): HTMLElement {
        const numericKeys = [
            'domain_radius', 'cell_size', 'atm_pressure', 'atm_temperature',
            'charge_mass', 'rho', 'detonation_energy', 'jwl_A', 'jwl_B',
            'jwl_R1', 'jwl_R2', 'jwl_omega', 'det_vel', 'cfl', 'output_interval',
            'spatial_order', 'temporal_order', 'gamma', 'plot_stride',
            // 2D CFD keys
            'nr', 'nz', 'max_r', 'max_z', 'explosive_z', 'explosive_radius', 'remap_radius', 'explosive_r',
            'charge_r', 'charge_z', 'charge_radius', 'charge_height',
            'detonator_r', 'detonator_z', 'detonator_radius'
        ];

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
            'composition': ['TNT', 'PETN', 'RDX', 'Custom'],
            'init_mode': ['From1D', 'Multi-Material JWL', 'Ideal Gas'],
            'flux_scheme': ['AUSM+', 'Rusanov'],
            'spatial_order': ['1', '2', '3'],
            'temporal_order': ['1', '2', '3'],
            'output_mode': ['By Step', 'By Time'],
            'plot_stride': ['1', '2', '5', '10', '20', '50', '100'],
            'charge_shape': ['Sphere', 'Cylinder']
        };

        if (dropdowns[key]) {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';
            select.style.fontSize = 'var(--font-sm)';

            dropdowns[key].forEach(opt => {
                const option = document.createElement('option');
                option.value = opt;
                option.text = opt;
                if (opt === value.toString()) option.selected = true;
                select.appendChild(option);
            });

            select.addEventListener('change', () => {
                let val: any = select.value;
                if (numericKeys.includes(key)) val = Number(val);
                this.updateParameter(node, key, val);
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
            const preset = EXPLOSIVE_PRESETS[value];
            if (preset) {
                Object.assign(updates, preset);
            }
        }

        this.stateManager.updateNodeParameters(node.id, updates);
        this.render();
    }
}
