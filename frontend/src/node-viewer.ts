import { StateManager, NODE_DEFAULT_PARAMETERS, getMeshDisplayHTML, getMPMDisplayHTML, getFEMDisplayHTML, getGeometryDisplayHTML, getCouplerDisplayHTML, getTelemetryDisplayHTML, getTelemetryHeader, syncMPMMaterialParameters, getCompatibleMaterialsForNode, resolveResourcePath, NON_PHYSICAL_NODE_TYPES, DISPLAY_ONLY_KEYS } from './state-manager.js';
import { Node, NodeType, isDomainMesh3DNode, isDomainMesh2DNode } from './types.js';
import { PropertyEditor } from './property-editor.js';
import { HostFileBrowserModal, FileFilterPreset, showRecentFoldersQuickMenu, recordRecentFolder } from './host-file-browser.js';
import { Telemetry3DViewport } from './telemetry-3d-viewport.js';
import { MPM_MATERIAL_PRESET_NAMES, MPM_MATERIAL_PRESETS, MPM_MATERIAL_CATEGORIES, MPM_MATERIAL_PARAM_INFO, getConstitutiveModels, getPresetsForConstitutiveModel, getCategorizedPresetsForModel, getDefaultPresetForModel } from './mpm-presets.js';
import { EXPLOSIVE_PRESETS } from './property-grid.js';
import { getParameterInfo, getNodeDefinition, getNodeDescription, showParameterPopover, showNodeDetailsModal, getSolverScope, getSolverBadgeHTML, getParamKeysForNode, shouldSkipNodeParameter, getNodeSectionInfo, PARAMETER_DEFINITIONS, resolveModelContext } from './parameter-definitions.js';

export class NodeViewer {
    private container: HTMLElement;
    private stateManager: StateManager;
    private currentNodeId: string | null = null;
    private stateListener: () => void;
    private telemetryListener: (nodeId: string, data: any) => void;

    private propertyEditor: PropertyEditor | null = null;
    private chartWorker: Worker | null = null;
    private chartCanvas: HTMLCanvasElement | null = null;
    private graphResizeObserver: ResizeObserver | null = null;
    private contourWorker: Worker | null = null;
    private contourCanvas: HTMLCanvasElement | null = null;
    private contourResizeObserver: ResizeObserver | null = null;
    private gaugesWorker: Worker | null = null;
    private viewport3D: Telemetry3DViewport | null = null;

    private lastType: NodeType | null = null;
    private lastId: string | null = null;

    private selectedGaugeIds: Set<string> = new Set();
    private currentPage: number = 1;
    private searchQuery: string = "";
    private gaugesChannel: number = 0;
    private gaugesCanvas: HTMLCanvasElement | null = null;
    private gaugesResizeObserver: ResizeObserver | null = null;
    private gaugesPanelOpen: boolean = false;
    private gaugesPanelWidth: number = 320;
    private gaugesActiveTab: 'list' | 'settings' = 'list';
    private gaugesAutoScale: boolean = true;
    private gaugesLogScale: boolean = false;
    private gaugesShowPeaks: boolean = true;
    private gaugesBoxMode: boolean = false;
    private gaugesManualMin: number = 0;
    private gaugesManualMax: number = 1e6;

    private graphAutoScale: boolean = true;
    private graphLogScale: boolean = false;
    private graphShowPeaks: boolean = true;
    private graphBoxMode: boolean = false;

    private contourFillMode: 'fill' | 'aspect' = 'aspect';
    private contourShowExtrema: boolean = true;
    private contourBoxMode: boolean = false;
    private contourShowGridlines: boolean = false;
    private contourIsAxisymmetric: boolean = false;

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
    private renderRafId: number | null = null;

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

        this.stateListener = () => {
            if (this.renderRafId !== null) return;
            this.renderRafId = requestAnimationFrame(() => {
                this.renderRafId = null;
                this.render();
            });
        };
        this.telemetryListener = (nodeId, data) => {
            if (nodeId === this.currentNodeId) {
                this.handleTelemetry(nodeId, data);
                return;
            }
            if (this.currentNodeId) {
                const activeModel = this.stateManager.getActiveModel();
                const curNode = activeModel?.nodes.find(n => n.id === this.currentNodeId);
                if (!activeModel || !curNode) return;
                if (nodeId === `${activeModel.id}-gauges` && (curNode.type === 'VirtualGauges' || curNode.type === 'VirtualGauges3D')) {
                    this.handleTelemetry(this.currentNodeId, data);
                    return;
                }
                if (data instanceof ArrayBuffer && activeModel.nodes.some(n => n.id === nodeId)) {
                    if (curNode.type === 'TelemetryContour' || curNode.type === 'TelemetryGraph') {
                        this.handleTelemetry(this.currentNodeId, data);
                    }
                }
            }
        };

        this.stateManager.onStateChange(this.stateListener);
        this.stateManager.onTelemetryUpdate(this.telemetryListener);

        this.render();
    }

    private cleanupWorkers(): void {
        if (this.chartWorker) {
            this.chartWorker.terminate();
            this.chartWorker = null;
        }
        this.chartCanvas = null;
        if (this.graphResizeObserver) {
            this.graphResizeObserver.disconnect();
            this.graphResizeObserver = null;
        }
        if (this.contourWorker) {
            this.contourWorker.terminate();
            this.contourWorker = null;
        }
        this.contourCanvas = null;
        if (this.contourResizeObserver) {
            this.contourResizeObserver.disconnect();
            this.contourResizeObserver = null;
        }
        if (this.gaugesWorker) {
            this.gaugesWorker.terminate();
            this.gaugesWorker = null;
        }
        this.gaugesCanvas = null;
        if (this.gaugesResizeObserver) {
            this.gaugesResizeObserver.disconnect();
            this.gaugesResizeObserver = null;
        }
    }

    public destroy(): void {
        this.stopRenderLoop();
        if (this.renderRafId !== null) {
            cancelAnimationFrame(this.renderRafId);
            this.renderRafId = null;
        }
        if (this.viewport3D) {
            this.viewport3D.destroy();
            this.viewport3D = null;
        }
        this.cleanupWorkers();
        this.stateManager.offStateChange(this.stateListener);
        this.stateManager.offTelemetryUpdate(this.telemetryListener);
        this.container.remove();
    }

    public setNode(nodeId: string | null): void {
        if (this.currentNodeId === nodeId) return;
        this.stopRenderLoop();
        if (this.viewport3D) {
            this.viewport3D.destroy();
            this.viewport3D = null;
        }
        this.cleanupWorkers();
        this.currentNodeId = nodeId;
        this.render();
    }

    private render(): void {
        const activeModel = this.stateManager.getActiveModel();
        const allModels = this.stateManager.getAllModels();

        // NodeViewer should only show nodes for the currently focused model
        let node = (this.currentNodeId && activeModel) ? activeModel.nodes.find(n => n.id === this.currentNodeId) : null;
        const owningModel = this.currentNodeId ? allModels.find(m => m.nodes.some(n => n.id === this.currentNodeId)) : null;

        // Auto-switch to matching or fallback node if current node belongs to a different model or is missing
        if (activeModel && (!owningModel || owningModel.id !== activeModel.id || !node)) {
            const oldNode = owningModel?.nodes.find(n => n.id === this.currentNodeId);
            const matchingNode = oldNode ? activeModel.nodes.find(n => n.type === oldNode.type) : null;
            const activeTextNode = activeModel.nodes.find(n => n.type === 'TelemetryText');
            const fallbackNode = matchingNode || activeTextNode || (activeModel.nodes.length > 0 ? activeModel.nodes[0] : null);

            if (fallbackNode) {
                this.stopRenderLoop();
                if (this.viewport3D) {
                    this.viewport3D.destroy();
                    this.viewport3D = null;
                }
                this.cleanupWorkers();
                this.currentNodeId = fallbackNode.id;
                this.lastId = null;
                this.lastType = null;
                node = fallbackNode;
            } else {
                this.currentNodeId = null;
                node = null;
            }
        }

        if (!this.currentNodeId || !node) {
            this.container.innerHTML = '<div style="padding: 20px; color: #666;">No node selected for viewing</div>';
            this.lastId = null;
            this.lastType = null;
            return;
        }

        if (this.lastId === node.id && this.lastType === node.type) {
            if (
                node.type !== 'TelemetryText' &&
                node.type !== 'TelemetryGraph' &&
                node.type !== 'TelemetryContour' &&
                node.type !== 'VirtualGauges' &&
                node.type !== 'VirtualGauges3D' &&
                node.type !== 'Telemetry3DViewport'
            ) {
                this.renderStandardNode(node);
            } else if (node.type === 'VirtualGauges' || node.type === 'VirtualGauges3D') {
                this.syncGaugesChartWorker(node);
                const probeBtn = this.container.querySelector('.gauges-drawer-toggle-btn') as HTMLButtonElement | null;
                if (probeBtn) {
                    const gLen = Array.isArray(node.parameters?.gauges) ? node.parameters.gauges.length : 0;
                    probeBtn.textContent = `📋 Probes (${gLen})`;
                }
                if (this.gaugesPanelOpen && this.gaugesActiveTab === 'list') {
                    const activeEl = document.activeElement;
                    const tableCont = this.container.querySelector('.gauges-table-container');
                    if (!tableCont || !activeEl || !tableCont.contains(activeEl)) {
                        const has2D = activeModel?.nodes.some(n => isDomainMesh2DNode(n.type) || n.type === 'CFDSolver2D' || n.type === 'MPMDomain2D') || false;
                        this.syncVirtualGauges(node, has2D);
                    }
                }
            } else if (node.type === 'TelemetryContour') {
                this.syncContourWorkerConfig(node);
            } else if (node.type === 'TelemetryGraph') {
                // Sync settings from the node parameters (e.g. after model load)
                const currentChannel = Number(node.parameters?.telemetry_channel ?? 0);
                const meshNode = activeModel?.nodes.find(n => n.type === 'DomainMesh' || isDomainMesh2DNode(n.type) || isDomainMesh3DNode(n.type));
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
                    if (!this.graphAutoScale) {
                        this.chartWorker?.postMessage({ type: 'setConfig', min: minVal });
                    }
                }

                if (this.lastMaxY !== maxVal) {
                    this.lastMaxY = maxVal;
                    const maxInput = this.container.querySelector(`#viewer-max-y-${node.id}`) as HTMLInputElement;
                    if (maxInput) maxInput.value = String(maxVal);
                    if (!this.graphAutoScale) {
                        this.chartWorker?.postMessage({ type: 'setConfig', max: maxVal });
                    }
                }

                if (this.lastShowGridVal !== showGridVal) {
                    this.lastShowGridVal = showGridVal;
                    const gridCheckbox = this.container.querySelector('.viewer-grid-checkbox') as HTMLInputElement;
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
            } else if (node.type === 'TelemetryText') {
                const layoutSelect = this.container.querySelector('.viewer-layout-select') as HTMLSelectElement;
                const curLayout = node.parameters?.stream_layout || 'Columnar (Fixed-Width)';
                if (layoutSelect && layoutSelect.value !== curLayout) {
                    layoutSelect.value = curLayout;
                    this.renderExpandedText(node);
                    return;
                }
                const stickyHeader = this.container.querySelector('.telemetry-sticky-header') as HTMLElement;
                if (stickyHeader) {
                    const headerText = getTelemetryHeader(node);
                    stickyHeader.textContent = headerText;
                    stickyHeader.style.display = headerText ? 'block' : 'none';
                    const curFont = Number(node.parameters?.font_size ?? 11);
                    stickyHeader.style.fontSize = `${curFont}px`;
                    const term = document.getElementById(`viewer-text-${node.id}`);
                    if (term) term.style.fontSize = `${curFont}px`;
                    const livePage = document.getElementById(`viewer-live-page-${node.id}`);
                    if (livePage) {
                        livePage.style.fontSize = `${curFont}px`;
                        const latest = this.stateManager.getLatestMetric(node.id);
                        if (latest) {
                            livePage.textContent = this.stateManager.formatTelemetryPage(latest.data, latest.modelId, node);
                        }
                    }
                    const fontSelect = this.container.querySelector('.viewer-font-select') as HTMLSelectElement;
                    if (fontSelect) fontSelect.value = String(curFont);
                }
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
        } else if (node.type === 'TelemetryContour') {
            this.renderExpandedContour(node);
        } else if (node.type === 'VirtualGauges' || node.type === 'VirtualGauges3D') {
            this.renderVirtualGauges(node, oldScrollTop);
        } else if (node.type === 'Telemetry3DViewport') {
            this.renderExpanded3DViewport(node);
        } else {
            this.renderStandardNode(node);
        }
    }

    private renderExpandedText(node: Node): void {
        this.stopRenderLoop();
        this.cleanupWorkers();

        this.container.innerHTML = '';
        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';

        const header = document.createElement('div');
        header.className = 'viewer-header';
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.style.padding = '8px';
        header.style.borderBottom = '1px solid #333';

        const allModels = this.stateManager.getAllModels();
        const owningModel = allModels.find(m => m.nodes.some(n => n.id === node.id));
        const modelName = owningModel?.name || '';
        const nodeName = node.parameters?.name || node.id;

        const leftGroup = document.createElement('div');
        leftGroup.style.display = 'flex';
        leftGroup.style.alignItems = 'center';
        leftGroup.style.gap = '10px';

        const title = document.createElement('span');
        title.textContent = modelName ? `CONSOLE [${modelName}]: ${nodeName}` : `CONSOLE: ${nodeName}`;
        title.style.color = '#38bdf8';
        title.style.fontWeight = 'bold';
        title.style.fontSize = '12px';
        leftGroup.appendChild(title);

        // Filter group buttons: ALL, METRICS, LOGS
        const filterGroup = document.createElement('div');
        filterGroup.style.display = 'inline-flex';
        filterGroup.style.borderRadius = '4px';
        filterGroup.style.border = '1px solid #475569';
        filterGroup.style.overflow = 'hidden';
        filterGroup.style.fontSize = '10px';

        const currentFilter = node.parameters.filter_level || 'All';
        const filterOptions = [
            { label: 'ALL', val: 'All' },
            { label: 'METRICS', val: 'Metrics Only' },
            { label: 'LOGS', val: 'Logs Only' }
        ];

        filterOptions.forEach(opt => {
            const btn = document.createElement('button');
            btn.textContent = opt.label;
            btn.type = 'button';
            btn.style.border = 'none';
            btn.style.padding = '2px 8px';
            btn.style.cursor = 'pointer';
            btn.style.fontWeight = 'bold';
            btn.style.transition = 'all 0.15s ease';
            if (currentFilter === opt.val) {
                btn.style.background = '#0284c7';
                btn.style.color = '#fff';
            } else {
                btn.style.background = '#0f172a';
                btn.style.color = '#94a3b8';
            }
            btn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                Array.from(filterGroup.children).forEach((c, idx) => {
                    const el = c as HTMLButtonElement;
                    if (filterOptions[idx].val === opt.val) {
                        el.style.background = '#0284c7';
                        el.style.color = '#fff';
                    } else {
                        el.style.background = '#0f172a';
                        el.style.color = '#94a3b8';
                    }
                });
                this.stateManager.updateNodeParametersInPlace(node.id, { filter_level: opt.val });
                const headerText = getTelemetryHeader(node);
                stickyHeader.textContent = headerText;
                stickyHeader.style.display = headerText ? 'block' : 'none';
            };
            filterGroup.appendChild(btn);
        });
        leftGroup.appendChild(filterGroup);

        // Stream Layout Dropdown Selector
        const layoutSelect = document.createElement('select');
        layoutSelect.className = 'viewer-layout-select';
        layoutSelect.title = 'Select Stream Layout Mode';
        layoutSelect.style.background = '#0f172a';
        layoutSelect.style.color = '#38bdf8';
        layoutSelect.style.border = '1px solid #475569';
        layoutSelect.style.borderRadius = '4px';
        layoutSelect.style.fontSize = '10px';
        layoutSelect.style.fontWeight = 'bold';
        layoutSelect.style.padding = '2px 6px';
        layoutSelect.style.cursor = 'pointer';
        layoutSelect.style.outline = 'none';

        const LAYOUTS = [
            'Live Page (In-Place)',
            'Multi-Line Cards',
            'Dual-Deck (Page + Log)',
            'Columnar (Fixed-Width)',
            'Ultra-Compact',
            'Standard Log'
        ];

        const curLayout = node.parameters.stream_layout || 'Columnar (Fixed-Width)';
        LAYOUTS.forEach(l => {
            const opt = document.createElement('option');
            opt.value = l;
            opt.textContent = l;
            opt.style.background = '#0f172a';
            opt.style.color = '#e2e8f0';
            if (l === curLayout) opt.selected = true;
            layoutSelect.appendChild(opt);
        });

        layoutSelect.addEventListener('change', () => {
            const newL = layoutSelect.value;
            node.parameters.stream_layout = newL;
            this.stateManager.updateNodeParametersInPlace(node.id, { stream_layout: newL });
            this.renderExpandedText(node);
        });
        leftGroup.appendChild(layoutSelect);

        header.appendChild(leftGroup);

        const rightGroup = document.createElement('div');
        rightGroup.style.display = 'flex';
        rightGroup.style.alignItems = 'center';
        rightGroup.style.gap = '8px';

        let curFont = Number(node.parameters.font_size ?? 11);
        const FONT_SIZES = [8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22];
        const FONT_STACK = "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace";

        // Font Zoom Controls (A- [Select] A+)
        const zoomCont = document.createElement('div');
        zoomCont.style.display = 'inline-flex';
        zoomCont.style.alignItems = 'center';
        zoomCont.style.gap = '2px';
        zoomCont.style.background = '#0f172a';
        zoomCont.style.border = '1px solid #334155';
        zoomCont.style.borderRadius = '4px';
        zoomCont.style.padding = '2px 4px';
        zoomCont.style.fontSize = '11px';

        const fontSelect = document.createElement('select');
        fontSelect.className = 'viewer-font-select';
        fontSelect.title = 'Select Terminal Font Size';
        fontSelect.style.background = '#0f172a';
        fontSelect.style.color = '#38bdf8';
        fontSelect.style.border = 'none';
        fontSelect.style.fontSize = '11px';
        fontSelect.style.fontWeight = 'bold';
        fontSelect.style.cursor = 'pointer';
        fontSelect.style.padding = '1px 2px';
        fontSelect.style.outline = 'none';

        FONT_SIZES.forEach(sz => {
            const opt = document.createElement('option');
            opt.value = String(sz);
            opt.textContent = `${sz}px`;
            opt.style.background = '#0f172a';
            opt.style.color = '#e2e8f0';
            if (sz === curFont) opt.selected = true;
            fontSelect.appendChild(opt);
        });

        const setNewFont = (newSz: number) => {
            curFont = newSz;
            node.parameters.font_size = newSz;
            fontSelect.value = String(newSz);
            applyFontSize(newSz);
            this.stateManager.updateNodeParametersInPlace(node.id, { font_size: newSz });
        };

        const zoomOutBtn = document.createElement('button');
        zoomOutBtn.textContent = 'A-';
        zoomOutBtn.title = 'Decrease Font Size (Ctrl + Wheel Down)';
        zoomOutBtn.style.background = 'transparent';
        zoomOutBtn.style.border = 'none';
        zoomOutBtn.style.color = '#94a3b8';
        zoomOutBtn.style.cursor = 'pointer';
        zoomOutBtn.style.fontSize = '10px';
        zoomOutBtn.style.padding = '1px 4px';
        zoomOutBtn.onclick = () => {
            const curIdx = FONT_SIZES.indexOf(curFont);
            const nextIdx = curIdx > 0 ? curIdx - 1 : (curIdx < 0 ? 2 : 0);
            setNewFont(FONT_SIZES[nextIdx]);
        };

        const zoomInBtn = document.createElement('button');
        zoomInBtn.textContent = 'A+';
        zoomInBtn.title = 'Increase Font Size (Ctrl + Wheel Up)';
        zoomInBtn.style.background = 'transparent';
        zoomInBtn.style.border = 'none';
        zoomInBtn.style.color = '#94a3b8';
        zoomInBtn.style.cursor = 'pointer';
        zoomInBtn.style.fontSize = '10px';
        zoomInBtn.style.padding = '1px 4px';
        zoomInBtn.onclick = () => {
            const curIdx = FONT_SIZES.indexOf(curFont);
            const nextIdx = curIdx >= 0 && curIdx < FONT_SIZES.length - 1 ? curIdx + 1 : (curIdx < 0 ? 4 : curIdx);
            setNewFont(FONT_SIZES[nextIdx]);
        };

        fontSelect.addEventListener('change', () => {
            setNewFont(Number(fontSelect.value));
        });

        zoomCont.appendChild(zoomOutBtn);
        zoomCont.appendChild(fontSelect);
        zoomCont.appendChild(zoomInBtn);
        rightGroup.appendChild(zoomCont);

        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear';
        clearBtn.className = 'header-button secondary';
        clearBtn.style.padding = '2px 8px';
        clearBtn.style.fontSize = '11px';
        clearBtn.onclick = () => {
            const term = this.container.querySelector('.expanded-terminal');
            if (term) term.innerHTML = '';
            (this.stateManager as any).telemetryStore.set(node.id, []);
            (this.stateManager as any).rawTelemetryStore.set(node.id, []);
        };
        rightGroup.appendChild(clearBtn);

        header.appendChild(rightGroup);
        this.container.appendChild(header);

        const isLivePage = curLayout === 'Live Page (In-Place)';
        const isDualDeck = curLayout === 'Dual-Deck (Page + Log)';

        // Sticky Column Header (shown for Columnar / Ultra-Compact / Standard Log)
        const headerText = getTelemetryHeader(node);
        const stickyHeader = document.createElement('div');
        stickyHeader.className = 'telemetry-sticky-header';
        stickyHeader.style.background = '#0b0f19';
        stickyHeader.style.color = '#38bdf8';
        stickyHeader.style.fontFamily = FONT_STACK;
        stickyHeader.style.fontSize = `${curFont}px`;
        stickyHeader.style.padding = '6px 12px';
        stickyHeader.style.borderBottom = '1px solid #1e293b';
        stickyHeader.style.whiteSpace = 'pre';
        stickyHeader.style.overflowX = 'hidden';
        stickyHeader.style.userSelect = 'none';
        stickyHeader.style.fontWeight = '500';
        stickyHeader.style.letterSpacing = '0px';
        stickyHeader.style.fontVariantNumeric = 'tabular-nums';
        stickyHeader.style.boxSizing = 'border-box';
        stickyHeader.textContent = headerText;
        stickyHeader.style.display = headerText ? 'block' : 'none';
        this.container.appendChild(stickyHeader);

        // If Dual-Deck, create the Top Pinned Status Page Deck
        if (isDualDeck) {
            const topDeck = document.createElement('div');
            topDeck.id = `viewer-live-page-${node.id}`;
            topDeck.className = 'dual-deck-top';
            topDeck.style.background = '#080c14';
            topDeck.style.borderBottom = '2px solid #1e293b';
            topDeck.style.color = '#38bdf8';
            topDeck.style.fontFamily = FONT_STACK;
            topDeck.style.fontSize = `${curFont}px`;
            topDeck.style.padding = '8px 14px';
            topDeck.style.overflow = 'auto';
            topDeck.style.whiteSpace = 'pre';
            topDeck.style.flexShrink = '0';
            topDeck.style.letterSpacing = '0px';
            topDeck.style.fontVariantNumeric = 'tabular-nums';
            topDeck.style.boxSizing = 'border-box';
            topDeck.style.lineHeight = '1.45';

            const latest = this.stateManager.getLatestMetric(node.id);
            topDeck.textContent = latest ? this.stateManager.formatTelemetryPage(latest.data, latest.modelId, node) : 'Live Status Deck: Waiting for solver telemetry...';
            this.container.appendChild(topDeck);
        }

        const terminalCont = document.createElement('div');
        terminalCont.style.flex = '1';
        terminalCont.style.position = 'relative';
        terminalCont.style.overflow = 'hidden';
        this.container.appendChild(terminalCont);

        if (isLivePage) {
            const livePage = document.createElement('div');
            livePage.id = `viewer-live-page-${node.id}`;
            livePage.className = 'expanded-live-page';
            livePage.style.position = 'absolute';
            livePage.style.inset = '0';
            livePage.style.background = '#030712';
            livePage.style.color = '#38bdf8';
            livePage.style.fontFamily = FONT_STACK;
            livePage.style.fontSize = `${curFont}px`;
            livePage.style.padding = '12px 16px';
            livePage.style.overflowY = 'auto';
            livePage.style.overflowX = 'auto';
            livePage.style.whiteSpace = 'pre';
            livePage.style.wordBreak = 'normal';
            livePage.style.lineHeight = '1.45';
            livePage.style.fontWeight = '500';
            livePage.style.letterSpacing = '0px';
            livePage.style.fontVariantNumeric = 'tabular-nums';
            livePage.style.boxSizing = 'border-box';

            const latest = this.stateManager.getLatestMetric(node.id);
            livePage.textContent = latest ? this.stateManager.formatTelemetryPage(latest.data, latest.modelId, node) : 'Waiting for solver telemetry...';
            terminalCont.appendChild(livePage);

            livePage.addEventListener('wheel', (e: WheelEvent) => {
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    const curIdx = FONT_SIZES.indexOf(curFont);
                    let nextIdx: number;
                    if (e.deltaY < 0) {
                        nextIdx = curIdx >= 0 && curIdx < FONT_SIZES.length - 1 ? curIdx + 1 : (curIdx < 0 ? 4 : curIdx);
                    } else {
                        nextIdx = curIdx > 0 ? curIdx - 1 : 0;
                    }
                    setNewFont(FONT_SIZES[nextIdx]);
                }
            }, { passive: false });
        } else {
            const terminal = document.createElement('div');
            terminal.className = 'expanded-terminal';
            terminal.id = `viewer-text-${node.id}`;
            terminal.style.position = 'absolute';
            terminal.style.inset = '0';
            terminal.style.background = '#030712';
            terminal.style.color = '#e2e8f0';
            terminal.style.fontFamily = FONT_STACK;
            terminal.style.fontSize = `${curFont}px`;
            terminal.style.padding = isDualDeck ? '6px 12px' : '8px 12px';
            terminal.style.overflowY = 'auto';
            terminal.style.overflowX = 'auto';
            terminal.style.whiteSpace = 'pre';
            terminal.style.wordBreak = 'normal';
            terminal.style.lineHeight = '1.45';
            terminal.style.fontWeight = '500';
            terminal.style.letterSpacing = '0px';
            terminal.style.fontVariantNumeric = 'tabular-nums';
            terminal.style.boxSizing = 'border-box';

            terminal.addEventListener('wheel', (e: WheelEvent) => {
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    const curIdx = FONT_SIZES.indexOf(curFont);
                    let nextIdx: number;
                    if (e.deltaY < 0) {
                        nextIdx = curIdx >= 0 && curIdx < FONT_SIZES.length - 1 ? curIdx + 1 : (curIdx < 0 ? 4 : curIdx);
                    } else {
                        nextIdx = curIdx > 0 ? curIdx - 1 : 0;
                    }
                    setNewFont(FONT_SIZES[nextIdx]);
                }
            }, { passive: false });

            if (headerText) {
                terminal.addEventListener('scroll', () => {
                    stickyHeader.scrollLeft = terminal.scrollLeft;
                });
            }

            const logs = this.stateManager.getTelemetry(node.id) || [];
            this.syncTerminal(terminal, logs);

            terminalCont.appendChild(terminal);
            terminal.scrollTop = terminal.scrollHeight;
        }

        // Zoom HUD badge
        const zoomHud = document.createElement('div');
        zoomHud.style.position = 'absolute';
        zoomHud.style.top = '10px';
        zoomHud.style.right = '16px';
        zoomHud.style.background = 'rgba(15, 23, 42, 0.85)';
        zoomHud.style.backdropFilter = 'blur(4px)';
        zoomHud.style.border = '1px solid #38bdf8';
        zoomHud.style.color = '#38bdf8';
        zoomHud.style.borderRadius = '4px';
        zoomHud.style.padding = '3px 8px';
        zoomHud.style.fontSize = '11px';
        zoomHud.style.fontWeight = 'bold';
        zoomHud.style.pointerEvents = 'none';
        zoomHud.style.transition = 'opacity 0.3s ease';
        zoomHud.style.opacity = '0';
        zoomHud.style.zIndex = '10';
        terminalCont.appendChild(zoomHud);

        let hudTimer: any = null;
        const showZoomHud = (sz: number) => {
            zoomHud.textContent = `Font: ${sz}px`;
            zoomHud.style.opacity = '1';
            if (hudTimer) clearTimeout(hudTimer);
            hudTimer = setTimeout(() => {
                zoomHud.style.opacity = '0';
            }, 750);
        };

        const applyFontSize = (newSz: number) => {
            const term = document.getElementById(`viewer-text-${node.id}`);
            if (term) term.style.fontSize = `${newSz}px`;
            if (stickyHeader) stickyHeader.style.fontSize = `${newSz}px`;
            const liveEl = document.getElementById(`viewer-live-page-${node.id}`);
            if (liveEl) liveEl.style.fontSize = `${newSz}px`;
            fontSelect.value = String(newSz);
            showZoomHud(newSz);
        };
    }

    
    private renderExpanded3DViewport(node: Node): void {
        this.stopRenderLoop();
        this.cleanupWorkers();
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
        if (this.contourWorker && buffer instanceof ArrayBuffer) {
            const copy = buffer.slice(0);
            this.contourWorker.postMessage(copy, [copy]);
        }
        if (this.chartWorker && buffer instanceof ArrayBuffer && this.lastType === 'TelemetryGraph') {
            this.telemetryBuffer = buffer.slice(0);
        }
    }

    public updateTelemetry(data: any, modelId?: string): void {
        if (modelId && this.getCurrentModelId() !== modelId) return;
        if (this.viewport3D) {
            this.viewport3D.updateTelemetry(data, modelId);
        }
        if (this.contourWorker && data && !(data instanceof ArrayBuffer)) {
            if (typeof data.step === 'number' || typeof data.time === 'number') {
                this.contourWorker.postMessage({
                    type: 'setConfig',
                    step: typeof data.step === 'number' ? data.step : undefined,
                    time: typeof data.time === 'number' ? data.time : undefined,
                    dt: typeof data.dt === 'number' ? data.dt : undefined
                });
            }
        }
        if (this.currentNodeId && data && !(data instanceof ArrayBuffer) && data.gauges_history) {
            const activeModel = this.stateManager.getActiveModel();
            const node = activeModel?.nodes.find(n => n.id === this.currentNodeId);
            if (node && (node.type === 'VirtualGauges' || node.type === 'VirtualGauges3D')) {
                this.handleTelemetry(this.currentNodeId, data.gauges_history);
            }
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

    public resetSimulationData(modelId?: string): void {
        if (modelId && this.getCurrentModelId() !== modelId) return;
        if (this.viewport3D) {
            this.viewport3D.resetSimulationData?.(modelId);
        }
        this.contourWorker?.postMessage({ type: 'clearData' });
        this.chartWorker?.postMessage({ type: 'clearData' });
        this.gaugesWorker?.postMessage({ type: 'clearData' });
    }

    private buildNodeContourConfig(node: Node): Record<string, any> {
        const activeModel = this.stateManager.getActiveModel();
        const wsMgr = (window as any).workspaceManager;
        const baseCfg = wsMgr && typeof wsMgr.buildContourConfig === 'function'
            ? wsMgr.buildContourConfig(activeModel, {})
            : (() => {
                const solverNode = activeModel?.nodes.find(n => n.type === 'CFDSolver2D' || n.type === 'MPMDomain2D');
                const meshNode = activeModel?.nodes.find(n => isDomainMesh2DNode(n.type) || n.type === 'MPMDomain2D' || n.type === 'DomainMesh');
                const gaugesNode = activeModel?.nodes.find(n => n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D');
                const max_r = Number(meshNode?.parameters?.max_r ?? meshNode?.parameters?.domain_radius ?? 1.0) || 1.0;
                const max_z = Number(meshNode?.parameters?.max_z ?? max_r) || max_r;
                const cellSize = Number(meshNode?.parameters?.cell_size) || 0.05;
                const nr = Math.max(8, Math.round(max_r / cellSize) || 128);
                const nz = Math.max(8, Math.round(max_z / cellSize) || 128);
                return {
                    meshType: String(solverNode?.parameters?.mesh_type || 'regular'),
                    amrMaxLevels: Number(solverNode?.parameters?.amr_max_levels ?? 3),
                    baseNr: nr,
                    baseNz: nz,
                    max_r,
                    max_z,
                    gauges: Array.isArray(gaugesNode?.parameters?.gauges) ? gaugesNode.parameters.gauges : []
                };
            })();

        const channel = Number(node.parameters?.telemetry_channel ?? 0);
        const autoScale = node.parameters?.auto_scale !== false;
        const logScale = !!node.parameters?.log_scale;
        const colormap = String(node.parameters?.colormap || 'turbo');
        const minVal = Number(node.parameters?.min_y ?? 0);
        const maxVal = Number(node.parameters?.max_y ?? 1e6);
        const stride = Math.max(1, Number(node.parameters?.downsample_stride ?? 1));
        const interpolate = node.parameters?.interpolate !== false;

        return {
            ...baseCfg,
            type: 'setConfig',
            channel,
            autoScale,
            logScale,
            colormap,
            min: minVal,
            max: maxVal,
            stride,
            refreshRate: 0,
            interpolate,
            fillMode: this.contourFillMode,
            showExtrema: this.contourShowExtrema,
            showGridlines: this.contourShowGridlines,
            isAxisymmetric: this.contourIsAxisymmetric,
            showColorbar: true,
            showGauges: true,
            showCharge: true,
            showDetonator: true,
            showObstacles: true,
            showMPMParticles: true
        };
    }

    private syncContourWorkerConfig(node: Node): void {
        if (!this.contourWorker) return;
        this.contourWorker.postMessage(this.buildNodeContourConfig(node));
    }

    private renderExpandedContour(node: Node): void {
        this.stopRenderLoop();
        this.telemetryBuffer = null;
        this.cleanupWorkers();

        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';
        this.container.style.padding = '0';

        const activeModel = this.stateManager.getActiveModel();
        const hasMPM = Boolean(activeModel?.nodes.some(n => n.type === 'MPMDomain2D' || n.type === 'MPMObject2D' || n.type === 'FSICoupler2D'));
        const hasCFD = Boolean(activeModel?.nodes.some(n => n.type === 'CFDSolver2D' || n.type === 'FSICoupler2D')) || !hasMPM;
        const CONTOUR_CHANNELS: { id: number; label: string }[] = [];
        if (hasCFD) {
            CONTOUR_CHANNELS.push(
                { id: 0, label: 'Pressure P (Pa)' },
                { id: 10, label: 'Overpressure ΔP (Pa)' },
                { id: 1, label: 'Density ρ (kg/m³)' },
                { id: 9, label: 'Velocity |u| (m/s)' },
                { id: 2, label: 'Radial Vel u_r (m/s)' },
                { id: 3, label: 'Axial Vel u_z (m/s)' },
                { id: 4, label: 'Int. Energy e (J/kg)' },
                { id: 5, label: 'Reacted α₁ (-)' },
                { id: 6, label: 'Unreacted α₂ (-)' }
            );
        }
        if (hasMPM) {
            CONTOUR_CHANNELS.push(
                { id: 7, label: 'MPM σ_vm (Pa)' },
                { id: 8, label: 'MPM ε_p (-)' }
            );
        }
        const COLORMAPS = ['rainbow', 'turbo', 'viridis', 'plasma', 'inferno', 'magma', 'jet', 'cividis', 'coolwarm', 'grayscale'];

        const header = document.createElement('div');
        header.className = 'viewer-header';
        header.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px; padding:6px 10px; border-bottom:1px solid rgba(56,189,248,0.18); align-items:center; background:#0f1420; flex-shrink:0;';

        const title = document.createElement('span');
        title.textContent = `2D CONTOUR: ${node.id}`;
        title.style.cssText = 'font-weight:700; font-size:11px; color:#e2e8f0; letter-spacing:0.4px; margin-right:4px;';
        header.appendChild(title);

        const mkSelect = (opts: { val: string; label: string }[], cur: string, onChange: (v: string) => void): HTMLSelectElement => {
            const s = document.createElement('select');
            s.style.cssText = 'font-size:10.5px; background:#161d2e; color:#e2e8f0; border:1px solid rgba(148,163,184,0.28); padding:2px 6px; border-radius:4px; cursor:pointer;';
            opts.forEach(o => {
                const el = document.createElement('option');
                el.value = o.val;
                el.textContent = o.label;
                if (o.val === cur) el.selected = true;
                s.appendChild(el);
            });
            s.onchange = () => onChange(s.value);
            return s;
        };

        const defaultCh = CONTOUR_CHANNELS[0]?.id ?? 0;
        const rawCh = Number(node.parameters?.telemetry_channel ?? defaultCh);
        const curCh = String(CONTOUR_CHANNELS.some(c => c.id === rawCh) ? rawCh : defaultCh);
        const chSel = mkSelect(CONTOUR_CHANNELS.map(c => ({ val: String(c.id), label: c.label })), curCh, (v) => {
            this.stateManager.updateNodeParametersInPlace(node.id, { telemetry_channel: Number(v) });
            this.syncContourWorkerConfig(node);
        });
        header.appendChild(chSel);

        const curCmap = String(node.parameters?.colormap || 'rainbow');
        const cmapSel = mkSelect(COLORMAPS.map(c => ({ val: c, label: c.toUpperCase() })), curCmap, (v) => {
            this.stateManager.updateNodeParametersInPlace(node.id, { colormap: v });
            this.syncContourWorkerConfig(node);
        });
        header.appendChild(cmapSel);

        const mkToggleBtn = (label: string, titleTxt: string, isActive: () => boolean, onClick: (btn: HTMLButtonElement) => void): HTMLButtonElement => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.title = titleTxt;
            const applyStyle = () => {
                const act = isActive();
                b.style.cssText = `background:${act ? 'rgba(56,189,248,0.2)' : '#161d2e'}; color:${act ? '#38bdf8' : '#cbd5e1'}; border:1px solid ${act ? 'rgba(56,189,248,0.55)' : 'rgba(148,163,184,0.25)'}; border-radius:4px; font-size:10px; font-weight:600; padding:2px 7px; cursor:pointer;`;
            };
            applyStyle();
            b.onclick = () => {
                onClick(b);
                applyStyle();
            };
            return b;
        };

        const rangeWrap = document.createElement('div');
        rangeWrap.style.cssText = `display:${node.parameters?.auto_scale === false ? 'flex' : 'none'}; align-items:center; gap:4px;`;
        const mkBoundIn = (val: number, key: 'min_y' | 'max_y') => {
            const inp = document.createElement('input');
            inp.type = 'number';
            inp.step = 'any';
            inp.value = String(val);
            inp.style.cssText = 'width:64px; font-size:10px; background:#0b0f19; color:#e2e8f0; border:1px solid rgba(148,163,184,0.3); border-radius:3px; padding:2px 4px;';
            inp.onchange = () => {
                const num = Number(inp.value);
                if (isFinite(num)) {
                    this.stateManager.updateNodeParametersInPlace(node.id, { [key]: num });
                    this.syncContourWorkerConfig(node);
                }
            };
            return inp;
        };
        const minIn = mkBoundIn(Number(node.parameters?.min_y ?? 0), 'min_y');
        const maxIn = mkBoundIn(Number(node.parameters?.max_y ?? 1e6), 'max_y');
        rangeWrap.appendChild(minIn);
        rangeWrap.appendChild(maxIn);

        const autoBtn = mkToggleBtn(node.parameters?.auto_scale !== false ? 'AUTO' : 'MAN', 'Toggle Auto-Scale vs Manual Range', () => node.parameters?.auto_scale !== false, (b) => {
            const next = !(node.parameters?.auto_scale !== false);
            this.stateManager.updateNodeParametersInPlace(node.id, { auto_scale: next });
            b.textContent = next ? 'AUTO' : 'MAN';
            rangeWrap.style.display = next ? 'none' : 'flex';
            this.syncContourWorkerConfig(node);
        });
        header.appendChild(autoBtn);
        header.appendChild(rangeWrap);

        const logBtn = mkToggleBtn(node.parameters?.log_scale ? 'LOG' : 'LIN', 'Toggle Logarithmic vs Linear Color Scale', () => !!node.parameters?.log_scale, (b) => {
            const next = !node.parameters?.log_scale;
            this.stateManager.updateNodeParametersInPlace(node.id, { log_scale: next });
            b.textContent = next ? 'LOG' : 'LIN';
            this.syncContourWorkerConfig(node);
        });
        header.appendChild(logBtn);

        const smoothBtn = mkToggleBtn('Smooth', 'Toggle Bilinear Interpolation vs Crisp 1:1 Computational Cells', () => node.parameters?.interpolate !== false, () => {
            const next = !(node.parameters?.interpolate !== false);
            this.stateManager.updateNodeParametersInPlace(node.id, { interpolate: next });
            this.syncContourWorkerConfig(node);
        });
        header.appendChild(smoothBtn);

        const navGroup = document.createElement('div');
        navGroup.style.cssText = 'display:flex; align-items:center; gap:4px; margin-left:auto; flex-wrap:wrap;';

        navGroup.appendChild(mkToggleBtn('⇄ Mirror', 'Mirror Axisymmetric Domain Across r = 0', () => this.contourIsAxisymmetric, () => {
            this.contourIsAxisymmetric = !this.contourIsAxisymmetric;
            this.syncContourWorkerConfig(node);
        }));

        navGroup.appendChild(mkToggleBtn('# Grid', 'Show Mesh / AMR Tile Overlay', () => this.contourShowGridlines, () => {
            this.contourShowGridlines = !this.contourShowGridlines;
            this.syncContourWorkerConfig(node);
        }));

        navGroup.appendChild(mkToggleBtn('▲▼ Peaks', 'Show Domain Peak & Trough Markers', () => this.contourShowExtrema, () => {
            this.contourShowExtrema = !this.contourShowExtrema;
            this.syncContourWorkerConfig(node);
        }));

        const boxBtn = mkToggleBtn('⬚ Box', 'Rubberband Box-Zoom Mode (or Shift+Drag / Right-Drag)', () => this.contourBoxMode, () => {
            this.contourBoxMode = !this.contourBoxMode;
            if (this.contourCanvas) {
                this.contourCanvas.style.cursor = this.contourBoxMode ? 'crosshair' : 'grab';
            }
        });
        navGroup.appendChild(boxBtn);

        navGroup.appendChild(mkToggleBtn('＋', 'Zoom In', () => false, () => this.contourWorker?.postMessage({ type: 'zoom', factor: 1.25 })));
        navGroup.appendChild(mkToggleBtn('－', 'Zoom Out', () => false, () => this.contourWorker?.postMessage({ type: 'zoom', factor: 0.8 })));
        navGroup.appendChild(mkToggleBtn('🏠 Fit', 'Reset Pan & Zoom (or Double-Click)', () => false, () => this.contourWorker?.postMessage({ type: 'resetView' })));
        navGroup.appendChild(mkToggleBtn('🎯 Stage', 'Open 2D Contour in Stage Viewport', () => true, () => {
            (window as any).workspaceManager?.switchActivePaneType?.('2D_CONTOUR');
        }));

        header.appendChild(navGroup);
        this.container.appendChild(header);

        const canvasCont = document.createElement('div');
        canvasCont.style.cssText = 'flex:1; min-width:0; min-height:0; position:relative; overflow:hidden; background:#0b0f19;';
        this.container.appendChild(canvasCont);

        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; display:block; touch-action:none; cursor:grab;';
        canvasCont.appendChild(canvas);
        this.contourCanvas = canvas;

        let isDragging = false;
        let dragMode: 'pan' | 'boxZoom' = 'pan';
        let startX = 0;
        let startY = 0;
        let lastX = 0;
        let lastY = 0;
        let movedSignificantly = false;
        let suppressContextMenu = false;

        canvas.addEventListener('contextmenu', (e) => {
            if (suppressContextMenu || this.contourBoxMode) {
                e.preventDefault();
                suppressContextMenu = false;
            }
        });

        canvas.addEventListener('pointerdown', (e) => {
            try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
            isDragging = true;
            movedSignificantly = false;
            startX = lastX = e.offsetX;
            startY = lastY = e.offsetY;
            if (this.contourBoxMode || e.shiftKey || e.button === 1 || e.button === 2) {
                dragMode = 'boxZoom';
                if (e.button === 2) suppressContextMenu = true;
                canvas.style.cursor = 'crosshair';
            } else {
                dragMode = 'pan';
                canvas.style.cursor = 'grabbing';
            }
            e.preventDefault();
        });

        canvas.addEventListener('pointermove', (e) => {
            const mx = e.offsetX;
            const my = e.offsetY;
            this.contourWorker?.postMessage({ type: 'hover', mx, my });
            if (!isDragging) return;
            const dx = mx - lastX;
            const dy = my - lastY;
            lastX = mx;
            lastY = my;
            if (Math.hypot(mx - startX, my - startY) > 4) movedSignificantly = true;
            if (dragMode === 'boxZoom') {
                this.contourWorker?.postMessage({ type: 'boxZoomMove', x0: startX, y0: startY, x1: mx, y1: my });
            } else {
                this.contourWorker?.postMessage({ type: 'pan', dx, dy });
            }
        });

        const endContourDrag = (e: PointerEvent) => {
            if (!isDragging) return;
            try { if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); } catch (_) {}
            isDragging = false;
            canvas.style.cursor = this.contourBoxMode ? 'crosshair' : 'grab';
            if (dragMode === 'boxZoom') {
                if (movedSignificantly) {
                    this.contourWorker?.postMessage({ type: 'boxZoomCommit', x0: startX, y0: startY, x1: e.offsetX, y1: e.offsetY });
                } else {
                    this.contourWorker?.postMessage({ type: 'boxZoomCancel' });
                }
            } else if (!movedSignificantly && e.button === 0) {
                this.contourWorker?.postMessage({ type: 'click', mx: e.offsetX, my: e.offsetY });
            }
        };

        canvas.addEventListener('pointerup', endContourDrag);
        canvas.addEventListener('pointercancel', endContourDrag);
        canvas.addEventListener('pointerleave', () => {
            if (!isDragging) {
                this.contourWorker?.postMessage({ type: 'hover', mx: null, my: null });
            }
        });

        canvas.addEventListener('wheel', (e) => {
            this.contourWorker?.postMessage({
                type: 'zoom',
                mx: e.offsetX,
                my: e.offsetY,
                deltaY: e.deltaY
            });
            e.preventDefault();
        }, { passive: false });

        canvas.addEventListener('dblclick', (e) => {
            this.contourWorker?.postMessage({ type: 'resetView' });
            e.preventDefault();
        });

        this.contourWorker = new Worker(new URL('./ContourWorker.ts', import.meta.url), { type: 'module' });
        this.contourWorker.onmessage = (e) => {
            const msg = e.data;
            if (!msg) return;
            if (msg.type === 'probeHover' && this.contourCanvas && !isDragging) {
                this.contourCanvas.style.cursor = msg.probeIndex >= 0 ? 'pointer' : (this.contourBoxMode ? 'crosshair' : 'grab');
            }
        };

        const initRect = canvasCont.getBoundingClientRect();
        const cssW = Math.max(200, Math.round(initRect.width) || 800);
        const cssH = Math.max(160, Math.round(initRect.height) || 500);
        const offscreen = (canvas as any).transferControlToOffscreen();
        this.contourWorker.postMessage(
            { type: 'init', canvas: offscreen, width: cssW, height: cssH, dpr: window.devicePixelRatio || 1 },
            [offscreen] as any
        );
        this.syncContourWorkerConfig(node);

        requestAnimationFrame(() => {
            if (!this.contourWorker || !canvasCont.isConnected) return;
            const r = canvasCont.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                this.contourWorker.postMessage({ type: 'resize', width: Math.round(r.width), height: Math.round(r.height) });
            }
        });

        this.contourResizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                if (width > 0 && height > 0) {
                    this.contourWorker?.postMessage({ type: 'resize', width: Math.round(width), height: Math.round(height) });
                }
            }
        });
        this.contourResizeObserver.observe(canvasCont);

        // Seed with latest 2D binary frame from node, solver, or model store
        const solver2D = activeModel?.nodes.find(n => n.type === 'CFDSolver2D' || n.type === 'MPMDomain2D' || n.type === 'FSICoupler2D');
        const initialBuf =
            this.stateManager.getTelemetry(node.id) ||
            (activeModel ? this.stateManager.getTelemetry(`${activeModel.id}-binary`) : null) ||
            (solver2D ? this.stateManager.getTelemetry(`${solver2D.id}-binary`) : null);
        if (initialBuf instanceof ArrayBuffer) {
            const copy = initialBuf.slice(0);
            this.contourWorker.postMessage(copy, [copy]);
        }
    }

    private renderExpandedGraph(node: Node): void {
        this.stopRenderLoop();
        this.telemetryBuffer = null;
        this.cleanupWorkers();

        const CHANNELS: { id: number; label: string; color: string }[] = [
            { id: 0, label: 'Pressure P (Pa)',           color: '#00f0ff' },
            { id: 8, label: 'Overpressure ΔP (Pa)',      color: '#a855f7' },
            { id: 1, label: 'Density ρ (kg/m³)',         color: '#38bdf8' },
            { id: 2, label: 'Radial Vel u_r (m/s)',      color: '#10b981' },
            { id: 3, label: 'Int. Energy e (J/kg)',      color: '#f59e0b' },
            { id: 4, label: 'All Species (α₁, α₂, Air)', color: '#f43f5e' },
            { id: 5, label: 'Reacted Products α₁',       color: '#f43f5e' },
            { id: 6, label: 'Unreacted Solid α₂',        color: '#f59e0b' },
            { id: 7, label: 'Ambient Air Fraction',      color: '#38bdf8' }
        ];
        const currentChannel = Number(node.parameters?.telemetry_channel ?? 0);
        const foundCh = CHANNELS.find(c => c.id === currentChannel);
        const initialColor = node.parameters?.color ?? foundCh?.color ?? '#00f0ff';
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

        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';
        this.container.style.padding = '0';

        const activeModel = this.stateManager.getActiveModel();
        const meshNode = activeModel?.nodes.find(n => n.type === 'DomainMesh' || isDomainMesh2DNode(n.type) || isDomainMesh3DNode(n.type));
        const is1D = (meshNode?.parameters?.dimension ?? '1D') === '1D';
        const domainRadius = Number(meshNode?.parameters?.domain_radius ?? 1.0);
        const xAxisMode = is1D ? (node.parameters?.x_axis_mode ?? 'radius') : 'cell_id';

        const header = document.createElement('div');
        header.className = 'viewer-header';
        header.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px; padding:6px 10px; border-bottom:1px solid rgba(56,189,248,0.18); align-items:center; background:#0f1420; flex-shrink:0;';

        const title = document.createElement('span');
        title.textContent = `1D PROFILE: ${node.id}`;
        title.style.cssText = 'font-weight:700; font-size:11px; color:#e2e8f0; letter-spacing:0.4px; margin-right:4px;';
        header.appendChild(title);

        const channelSelect = document.createElement('select');
        channelSelect.className = 'viewer-channel-select';
        channelSelect.style.cssText = 'font-size:10.5px; background:#161d2e; color:#e2e8f0; border:1px solid rgba(148,163,184,0.28); padding:2px 6px; border-radius:4px; cursor:pointer;';
        CHANNELS.forEach((ch) => {
            const opt = document.createElement('option');
            opt.value = String(ch.id);
            opt.textContent = ch.label;
            if (ch.id === currentChannel) opt.selected = true;
            channelSelect.appendChild(opt);
        });

        const colorIn = document.createElement('input');
        colorIn.type = 'color';
        colorIn.value = initialColor;
        colorIn.title = 'Curve Color';
        colorIn.style.cssText = 'width:24px; height:20px; padding:0; background:#161d2e; border:1px solid rgba(148,163,184,0.28); border-radius:4px; cursor:pointer;';
        colorIn.onchange = () => {
            this.stateManager.updateNodeParametersInPlace(node.id, { color: colorIn.value });
            this.chartWorker?.postMessage({ type: 'setConfig', color: colorIn.value });
        };

        channelSelect.onchange = () => {
            const chId = Number(channelSelect.value);
            const chObj = CHANNELS.find(c => c.id === chId);
            const newColor = chObj?.color ?? '#00f0ff';
            colorIn.value = newColor;
            this.stateManager.updateNodeParametersInPlace(node.id, {
                telemetry_channel: chId,
                color: newColor
            });
            this.chartWorker?.postMessage({ type: 'setConfig', channel: chId, color: newColor });
        };
        header.appendChild(channelSelect);
        header.appendChild(colorIn);

        const mkPillBtn = (label: string, titleTxt: string, isActive: () => boolean, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.title = titleTxt;
            const syncStyle = () => {
                const act = isActive();
                b.style.cssText = `background:${act ? 'rgba(56,189,248,0.2)' : '#161d2e'}; color:${act ? '#38bdf8' : '#cbd5e1'}; border:1px solid ${act ? 'rgba(56,189,248,0.55)' : 'rgba(148,163,184,0.25)'}; border-radius:4px; font-size:10px; font-weight:600; padding:2px 7px; cursor:pointer;`;
            };
            syncStyle();
            b.onclick = () => {
                onClick(b);
                syncStyle();
            };
            return b;
        };

        const manualRangeWrap = document.createElement('div');
        manualRangeWrap.style.cssText = `display:${this.graphAutoScale ? 'none' : 'flex'}; align-items:center; gap:4px;`;
        const mkYInput = (id: string, val: number, key: 'min_y' | 'max_y') => {
            const inp = document.createElement('input');
            inp.type = 'number';
            inp.step = 'any';
            inp.id = id;
            inp.value = String(val);
            inp.style.cssText = 'width:64px; font-size:10px; background:#0b0f19; color:#e2e8f0; border:1px solid rgba(148,163,184,0.3); border-radius:3px; padding:2px 4px;';
            inp.onchange = () => {
                const num = Number(inp.value);
                if (isFinite(num)) {
                    this.stateManager.updateNodeParametersInPlace(node.id, { [key]: num });
                    if (!this.graphAutoScale) {
                        this.chartWorker?.postMessage({ type: 'setConfig', [key === 'min_y' ? 'min' : 'max']: num });
                    }
                }
            };
            return inp;
        };
        manualRangeWrap.appendChild(mkYInput(`viewer-min-y-${node.id}`, initialMinY, 'min_y'));
        manualRangeWrap.appendChild(mkYInput(`viewer-max-y-${node.id}`, initialMaxY, 'max_y'));

        header.appendChild(mkPillBtn(this.graphAutoScale ? 'AUTO' : 'MAN', 'Toggle Auto-Scale vs Manual Y Bounds', () => this.graphAutoScale, (b) => {
            this.graphAutoScale = !this.graphAutoScale;
            b.textContent = this.graphAutoScale ? 'AUTO' : 'MAN';
            manualRangeWrap.style.display = this.graphAutoScale ? 'none' : 'flex';
            this.chartWorker?.postMessage({
                type: 'setConfig',
                autoScale: this.graphAutoScale,
                min: Number(node.parameters?.min_y ?? 0),
                max: Number(node.parameters?.max_y ?? 1e6)
            });
        }));
        header.appendChild(manualRangeWrap);

        header.appendChild(mkPillBtn(this.graphLogScale ? 'LOG' : 'LIN', 'Toggle Logarithmic vs Linear Y Scale', () => this.graphLogScale, (b) => {
            this.graphLogScale = !this.graphLogScale;
            b.textContent = this.graphLogScale ? 'LOG' : 'LIN';
            this.chartWorker?.postMessage({ type: 'setConfig', logScale: this.graphLogScale });
        }));

        const gridLabel = document.createElement('label');
        gridLabel.style.cssText = 'display:flex; align-items:center; gap:3px; font-size:10px; color:#cbd5e1; cursor:pointer;';
        gridLabel.innerHTML = `<input type="checkbox" class="viewer-grid-checkbox" ${showGridVal ? 'checked' : ''}> Grid`;
        gridLabel.querySelector('input')!.onchange = (e) => {
            const checked = (e.target as HTMLInputElement).checked;
            this.stateManager.updateNodeParametersInPlace(node.id, { show_grid: checked });
            this.chartWorker?.postMessage({ type: 'setConfig', showGrid: checked });
        };
        header.appendChild(gridLabel);

        const strideSelect = document.createElement('select');
        strideSelect.className = 'viewer-stride-select';
        strideSelect.style.cssText = 'font-size:10px; background:#161d2e; color:#cbd5e1; border:1px solid rgba(148,163,184,0.28); padding:2px 5px; border-radius:4px;';
        const STRIDES = [
            { label: '1x', value: 1 },
            { label: '2x', value: 2 },
            { label: '5x', value: 5 },
            { label: '10x', value: 10 },
            { label: '20x', value: 20 },
            { label: '50x', value: 50 }
        ];
        const currentStride = Number(node.parameters?.plot_stride ?? 1);
        STRIDES.forEach(st => {
            const opt = document.createElement('option');
            opt.value = String(st.value);
            opt.textContent = `Rate ${st.label}`;
            if (st.value === currentStride) opt.selected = true;
            strideSelect.appendChild(opt);
        });
        strideSelect.onchange = () => {
            this.stateManager.updateNodeParametersInPlace(node.id, { plot_stride: Number(strideSelect.value) });
        };
        header.appendChild(strideSelect);

        if (is1D) {
            const xSelect = document.createElement('select');
            xSelect.className = 'viewer-x-axis-select';
            xSelect.style.cssText = 'font-size:10px; background:#161d2e; color:#cbd5e1; border:1px solid rgba(148,163,184,0.28); padding:2px 5px; border-radius:4px;';
            [
                { v: 'radius', l: 'X: Radius (m)' },
                { v: 'cell_id', l: 'X: Cell ID' }
            ].forEach(item => {
                const opt = document.createElement('option');
                opt.value = item.v;
                opt.textContent = item.l;
                if (xAxisMode === item.v) opt.selected = true;
                xSelect.appendChild(opt);
            });
            xSelect.onchange = () => {
                const newMode = xSelect.value;
                this.stateManager.updateNodeParametersInPlace(node.id, { x_axis_mode: newMode });
                this.chartWorker?.postMessage({ type: 'setConfig', xAxisMode: newMode, domainRadius });
            };
            header.appendChild(xSelect);
        }

        const navCtrl = document.createElement('div');
        navCtrl.style.cssText = 'display:flex; align-items:center; gap:4px; margin-left:auto; flex-wrap:wrap;';
        navCtrl.appendChild(mkPillBtn('▲▼ Peaks', 'Show Automatic Peak & Trough Callouts', () => this.graphShowPeaks, () => {
            this.graphShowPeaks = !this.graphShowPeaks;
            this.chartWorker?.postMessage({ type: 'setConfig', showPeaks: this.graphShowPeaks });
        }));
        navCtrl.appendChild(mkPillBtn('⬚ Box', 'Rubberband Box-Zoom Mode (or Shift+Drag / Right-Drag)', () => this.graphBoxMode, () => {
            this.graphBoxMode = !this.graphBoxMode;
            this.chartWorker?.postMessage({ type: 'setConfig', interactionMode: this.graphBoxMode ? 'boxZoom' : 'pan' });
            if (this.chartCanvas) this.chartCanvas.style.cursor = this.graphBoxMode ? 'crosshair' : 'crosshair';
        }));
        navCtrl.appendChild(mkPillBtn('＋', 'Zoom In', () => false, () => this.chartWorker?.postMessage({ type: 'zoom', factor: 1.25 })));
        navCtrl.appendChild(mkPillBtn('－', 'Zoom Out', () => false, () => this.chartWorker?.postMessage({ type: 'zoom', factor: 0.8 })));
        navCtrl.appendChild(mkPillBtn('🏠 Fit', 'Reset Zoom & Pan (or Double-Click Chart)', () => false, () => this.chartWorker?.postMessage({ type: 'resetView' })));
        navCtrl.appendChild(mkPillBtn('🎯 Stage', 'Open Chart in Stage Viewport', () => true, () => {
            (window as any).workspaceManager?.switchActivePaneType?.('1D_CHART');
        }));
        header.appendChild(navCtrl);

        this.container.appendChild(header);

        const canvasCont = document.createElement('div');
        canvasCont.className = 'expanded-graph-container';
        canvasCont.style.cssText = 'flex:1; min-width:0; min-height:0; position:relative; overflow:hidden; background:#0b0f19;';
        this.container.appendChild(canvasCont);

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'position:absolute; inset:0; width:100%; height:100%;';
        canvasCont.appendChild(wrapper);

        this.chartCanvas = document.createElement('canvas');
        this.chartCanvas.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; display:block; touch-action:none; cursor:crosshair;';
        wrapper.appendChild(this.chartCanvas);

        let suppressCtxMenu = false;
        this.chartCanvas.addEventListener('contextmenu', (e) => {
            if (suppressCtxMenu || this.graphBoxMode) {
                e.preventDefault();
                suppressCtxMenu = false;
            }
        });

        this.chartCanvas.addEventListener('pointerdown', (e) => {
            if (e.button === 2) suppressCtxMenu = true;
            try { this.chartCanvas?.setPointerCapture(e.pointerId); } catch (_) {}
            this.chartWorker?.postMessage({
                type: 'mouseEvent',
                event: 'mousedown',
                offsetX: e.offsetX,
                offsetY: e.offsetY,
                shiftKey: e.shiftKey,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey,
                button: e.button
            });
            e.preventDefault();
        });

        this.chartCanvas.addEventListener('pointermove', (e) => {
            this.chartWorker?.postMessage({
                type: 'mouseEvent',
                event: 'mousemove',
                offsetX: e.offsetX,
                offsetY: e.offsetY,
                shiftKey: e.shiftKey,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey
            });
        });

        const releaseCapture = (e: PointerEvent) => {
            if (this.chartCanvas && this.chartCanvas.hasPointerCapture(e.pointerId)) {
                try { this.chartCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
                this.chartWorker?.postMessage({
                    type: 'mouseEvent',
                    event: 'mouseup',
                    shiftKey: e.shiftKey,
                    ctrlKey: e.ctrlKey,
                    altKey: e.altKey,
                    button: e.button
                });
            }
        };

        this.chartCanvas.addEventListener('pointerup', releaseCapture);
        this.chartCanvas.addEventListener('pointercancel', releaseCapture);
        this.chartCanvas.addEventListener('pointerleave', () => {
            this.chartWorker?.postMessage({ type: 'mouseEvent', event: 'mouseleave' });
        });

        this.chartCanvas.addEventListener('wheel', (e) => {
            this.chartWorker?.postMessage({
                type: 'mouseEvent',
                event: 'wheel',
                offsetX: e.offsetX,
                offsetY: e.offsetY,
                deltaY: e.deltaY,
                shiftKey: e.shiftKey,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey
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
                if (minInputEl && document.activeElement !== minInputEl) minInputEl.value = e.data.minY.toExponential(2);
                if (maxInputEl && document.activeElement !== maxInputEl) maxInputEl.value = e.data.maxY.toExponential(2);
                if (node.parameters) {
                    node.parameters.min_y = e.data.minY;
                    node.parameters.max_y = e.data.maxY;
                }
            }
        };

        const rect = canvasCont.getBoundingClientRect();
        const cssW = Math.max(200, Math.round(rect.width) || 800);
        const cssH = Math.max(160, Math.round(rect.height) || 500);
        const offscreen = (this.chartCanvas as any).transferControlToOffscreen();
        this.chartWorker.postMessage(
            { type: 'init', canvas: offscreen, width: cssW, height: cssH, dpr: window.devicePixelRatio || 1 },
            [offscreen] as any
        );
        this.chartWorker.postMessage({
            type: 'setConfig',
            chartMode: 'spatial',
            channel: currentChannel,
            color: initialColor,
            autoScale: this.graphAutoScale,
            logScale: this.graphLogScale,
            min: initialMinY,
            max: initialMaxY,
            showGrid: showGridVal,
            showAxes: true,
            showPeaks: this.graphShowPeaks,
            interactionMode: this.graphBoxMode ? 'boxZoom' : 'pan',
            xAxisMode: xAxisMode,
            domainRadius: domainRadius
        });

        requestAnimationFrame(() => {
            if (!this.chartWorker || !canvasCont.isConnected) return;
            const r = canvasCont.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                this.chartWorker.postMessage({ type: 'resize', width: Math.round(r.width), height: Math.round(r.height) });
            }
        });

        this.graphResizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                if (width > 0 && height > 0) {
                    this.chartWorker?.postMessage({ type: 'resize', width: Math.round(width), height: Math.round(height) });
                }
            }
        });
        this.graphResizeObserver.observe(canvasCont);

        const solver1D = activeModel?.nodes.find(n => n.type === 'CFDSolver');
        const initialData =
            this.stateManager.getTelemetry(node.id) ||
            (activeModel ? this.stateManager.getTelemetry(`${activeModel.id}-binary`) : null) ||
            (solver1D ? this.stateManager.getTelemetry(`${solver1D.id}-binary`) : null);
        if (initialData) this.handleTelemetry(node.id, initialData);

        this.startRenderLoop();
    }

    private renderStandardNode(node: Node): void {
        const savedScroll = (this.lastId === node.id && this.lastType === node.type) ? this.container.scrollTop : 0;
        this.container.innerHTML = '';
        this.container.style.padding = '10px';
        this.container.style.overflowY = 'auto';

        const titleContainer = document.createElement('div');
        titleContainer.style.display = 'flex';
        titleContainer.style.justifyContent = 'space-between';
        titleContainer.style.alignItems = 'center';
        titleContainer.style.borderBottom = '1px solid #444';
        titleContainer.style.paddingBottom = '5px';
        titleContainer.style.marginBottom = '15px';

        const title = document.createElement('h3');
        title.textContent = `CONFIG: ${node.type} (${node.id})`;
        title.style.margin = '0';
        title.style.fontSize = 'var(--font-md)';
        titleContainer.appendChild(title);

        const infoModalBtn = document.createElement('button');
        infoModalBtn.type = 'button';
        infoModalBtn.textContent = 'Documentation';
        infoModalBtn.className = 'header-button secondary';
        infoModalBtn.style.padding = '2px 8px';
        infoModalBtn.style.fontSize = '10px';
        infoModalBtn.style.color = '#00e5ff';
        infoModalBtn.style.borderColor = 'rgba(0, 229, 255, 0.4)';
        infoModalBtn.style.cursor = 'pointer';
        infoModalBtn.title = 'View in-depth physics formulations, equations, and parameter guide for ' + node.type;
        infoModalBtn.onclick = () => showNodeDetailsModal(node.type);
        titleContainer.appendChild(infoModalBtn);

        this.container.appendChild(titleContainer);

        const grid = document.createElement('div');
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = '140px 1fr';
        grid.style.gap = '10px';
        grid.style.alignItems = 'center';

        if (node.type === 'Material') {
            syncMPMMaterialParameters(node, node.parameters);
        }

        const state = this.stateManager.getCurrentState();
        const conn = state?.connections.find(c => c.toNode === node.id);
        const sourceNode = conn ? state?.nodes.find(n => n.id === conn.fromNode) : null;
        const is3D = sourceNode 
            ? (sourceNode.type === 'CFDSolver3D' || sourceNode.type === 'MarineHarbourDomain' || sourceNode.type === 'FEMDomain3D' || sourceNode.type === 'MPMDomain3D' || sourceNode.type === 'FSICoupler3D' || sourceNode.type === 'FEMFSICoupler3D') 
            : (state?.nodes.some(n => n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' || isDomainMesh3DNode(n.type) || n.type === 'FEMDomain3D' || n.type === 'MPMDomain3D') ?? false);

        let isCoupledModel = false;
        const allModels = this.stateManager.getAllModels();
        for (const m of allModels) {
            if (m.nodes && m.nodes.some(n => n.id === node.id)) {
                isCoupledModel = m.nodes.some(n => n.type === 'FSICoupler2D' || n.type === 'FSICoupler3D' || n.type === 'FEMFSICoupler3D');
                break;
            }
        }
        if (!isCoupledModel) {
            const activeModel = this.stateManager.getActiveModel();
            if (activeModel && activeModel.nodes && activeModel.nodes.some(n => n.id === node.id)) {
                isCoupledModel = activeModel.nodes.some(n => n.type === 'FSICoupler2D' || n.type === 'FSICoupler3D' || n.type === 'FEMFSICoupler3D');
            }
        }

        const ctx = resolveModelContext(state, is3D, isCoupledModel);
        const paramKeys = getParamKeysForNode(node.type, node.parameters, is3D, isCoupledModel);

        for (const key of paramKeys) {
            let value = node.parameters[key];
            if (value === undefined || value === null) {
                if (node.type === 'Material') {
                    if (key === 'afterburn_enabled') {
                        const preset = node.parameters['preset'];
                        const presetVal = preset && MPM_MATERIAL_PRESETS[preset]?.afterburn_enabled;
                        value = node.parameters['afterburn_enabled'] = (presetVal !== undefined ? presetVal : false);
                    } else if (key.startsWith('afterburn_')) {
                        const preset = node.parameters['preset'];
                        const presetVal = preset && (MPM_MATERIAL_PRESETS[preset] as any)?.[key];
                        if (presetVal !== undefined) {
                            value = node.parameters[key] = presetVal;
                        } else {
                            const def = (NODE_DEFAULT_PARAMETERS['Material'] as any)?.[key];
                            if (def !== undefined) value = node.parameters[key] = def;
                        }
                    } else {
                        const def = (NODE_DEFAULT_PARAMETERS['Material'] as any)?.[key];
                        if (def !== undefined) value = node.parameters[key] = def;
                    }
                } else {
                    const defVal = (NODE_DEFAULT_PARAMETERS[node.type] as any)?.[key];
                    if (defVal !== undefined) {
                        value = node.parameters[key] = defVal;
                    }
                }
            }
            if (key === 'space_time_scheme') {
                if (node.type === 'MPMDomain2D' || node.type === 'MPMDomain3D') {
                    value = node.parameters['space_time_scheme'] ?? 'Leapfrog';
                } else {
                    value = node.parameters['space_time_scheme'];
                    if (!value) {
                        const so = Number(node.parameters['spatial_order'] ?? 2);
                        const to = Number(node.parameters['temporal_order'] ?? 2);
                        if (so === 3 || to === 6 || to === 3) value = 'ADER-3 (3rd-Order Space/Time)';
                        else if (to === 5) value = 'ADER-2 (2nd-Order Space/Time)';
                        else value = 'MUSCL-Hancock (2nd-Order Space/Time)';
                    }
                }
            }
            if (key === 'ambient_air_material' || key === 'explosive_charge' || key === 'target_domain' || key === 'ambient_air_target' || key === 'source_model_id' || key === 'target_solver' || key === 'seawater_material' || key === 'water_material' || key === 'seabed_foundation' || key === 'connected_detonators' || key === 'water_target') {
                value = value ?? '';
            }
            if (value === undefined || value === null) continue;
            if (shouldSkipNodeParameter(key, node.type, node.parameters, is3D, ctx)) continue;

            const sectionInfo = getNodeSectionInfo(key, node.type, node.parameters, is3D);
            if (sectionInfo) {
                const secHeader = document.createElement('div');
                secHeader.style.gridColumn = '1 / -1';
                secHeader.style.fontWeight = 'bold';
                secHeader.style.fontSize = '11px';
                secHeader.style.color = sectionInfo.color;
                secHeader.style.letterSpacing = '0.5px';
                secHeader.style.marginTop = '14px';
                secHeader.style.marginBottom = '4px';
                secHeader.style.paddingBottom = '3px';
                secHeader.style.borderBottom = `1px solid ${sectionInfo.color}40`;
                secHeader.textContent = sectionInfo.title;
                grid.appendChild(secHeader);
            }
            // DetonatorLocation and DetonatorLocation3D are separate nodes now, showing correct properties

            const paramInfo = getParameterInfo(key, node.type);
            const label = document.createElement('label');
            label.style.fontSize = 'var(--font-sm)';
            label.style.color = '#888';
            label.style.cursor = 'help';
            label.title = `${paramInfo.label} (${paramInfo.unit}): ${paramInfo.shortDesc} — ${paramInfo.detailedDesc}`;

            const unitBadge = (paramInfo.unit && paramInfo.unit !== 'dim') 
                ? `<span style="font-size:9px; color:#00e5ff; font-family:monospace; background:rgba(0,229,255,0.12); padding:1px 4px; border-radius:3px; border:1px solid rgba(0,229,255,0.25);">${paramInfo.unit}</span>` 
                : '';

            const solverBadge = (node.type === 'Material')
                ? getSolverBadgeHTML(paramInfo.solverScope || getSolverScope(key, node.type), false)
                : '';

            label.innerHTML = `<div style="display:flex; justify-content:space-between; align-items:baseline; gap:6px;">` +
                `<span style="font-weight:600; color:#ddd; display:inline-flex; align-items:center;">` +
                `${paramInfo.label.toUpperCase()}` +
                `<span class="param-info-btn" data-param-key="${key}" title="Click or hover for physics & math details">?</span>` +
                `</span>` +
                `<div style="display:flex; align-items:center; gap:4px;">` +
                solverBadge +
                unitBadge +
                `</div>` +
                `</div>` +
                `<div style="font-size:10px; color:#777; margin-top:1px; margin-bottom:2px;">${paramInfo.shortDesc}</div>`;

            const infoBtn = label.querySelector('.param-info-btn') as HTMLElement;
            if (infoBtn) {
                infoBtn.addEventListener('mouseenter', (e) => {
                    showParameterPopover(infoBtn, key, node.type, e);
                });
                infoBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showParameterPopover(infoBtn, key, node.type, e);
                });
            }
            grid.appendChild(label);

            const input = this.createInputElement(node, key, value);
            input.title = `${paramInfo.shortDesc} — ${paramInfo.detailedDesc}`;
            grid.appendChild(input);
        }

        this.container.appendChild(grid);

        const activeModel = this.stateManager.getActiveModel();
        const simState = activeModel ? this.stateManager.getSimulationState(activeModel.id) : null;
        if (node.type === 'DomainMesh' || isDomainMesh2DNode(node.type) || isDomainMesh3DNode(node.type) || node.type === 'CFDSolver' || node.type === 'CFDSolver2D' || node.type === 'CFDSolver3D' || node.type === 'MarineHarbourDomain') {
            const meshInfoDiv = document.createElement('div');
            meshInfoDiv.style.marginTop = '15px';
            meshInfoDiv.style.fontSize = 'var(--font-sm)';
            meshInfoDiv.style.color = '#569cd6';
            meshInfoDiv.innerHTML = getMeshDisplayHTML(node, simState ?? undefined);
            this.container.appendChild(meshInfoDiv);
        }
        if (node.type === 'MPMObject3D' || node.type === 'MPMObject2D' || node.type === 'MPMDomain3D' || node.type === 'MPMDomain2D') {
            const mpmInfoDiv = document.createElement('div');
            mpmInfoDiv.style.marginTop = '15px';
            mpmInfoDiv.innerHTML = getMPMDisplayHTML(node, simState ?? undefined);
            this.container.appendChild(mpmInfoDiv);
        }
        if (node.type === 'FEMObject3D' || node.type === 'FEMDomain3D' || node.type === 'LSDynaImporter3D') {
            const femInfoDiv = document.createElement('div');
            femInfoDiv.style.marginTop = '15px';
            femInfoDiv.innerHTML = getFEMDisplayHTML(node, simState ?? undefined);
            this.container.appendChild(femInfoDiv);
        }
        if (node.type === 'STLGeometry' || node.type === 'PrimitiveGeometry3D') {
            const geomInfoDiv = document.createElement('div');
            geomInfoDiv.style.marginTop = '15px';
            geomInfoDiv.innerHTML = getGeometryDisplayHTML(node, simState ?? undefined);
            this.container.appendChild(geomInfoDiv);
        }
        if (node.type === 'FSICoupler2D' || node.type === 'FSICoupler3D' || node.type === 'FEMFSICoupler3D') {
            const couplerInfoDiv = document.createElement('div');
            couplerInfoDiv.style.marginTop = '15px';
            couplerInfoDiv.innerHTML = getCouplerDisplayHTML(node, simState ?? undefined);
            this.container.appendChild(couplerInfoDiv);
        }
        if (node.type === 'VirtualGauges' || node.type === 'VirtualGauges3D' || node.type === 'VTKOutput' || node.type === 'Telemetry3DViewport') {
            const telemetryInfoDiv = document.createElement('div');
            telemetryInfoDiv.style.marginTop = '15px';
            telemetryInfoDiv.innerHTML = getTelemetryDisplayHTML(node, simState ?? undefined);
            this.container.appendChild(telemetryInfoDiv);
        }

        if (savedScroll > 0) {
            this.container.scrollTop = savedScroll;
            requestAnimationFrame(() => {
                this.container.scrollTop = savedScroll;
            });
        }
    }

    private getGaugesHistoryForNode(node: Node): any {
        const direct = this.stateManager.getTelemetry(node.id);
        if (direct && (direct.times?.length || direct.gauges_history || (Array.isArray(direct) && direct.length > 0))) {
            return direct;
        }
        const activeModel = this.stateManager.getActiveModel();
        if (activeModel) {
            const modelHist = this.stateManager.getTelemetry(`${activeModel.id}-gauges`);
            if (modelHist) return modelHist;
        }
        return direct || null;
    }

    private syncGaugesChartWorker(node: Node, incomingData?: any): void {
        if (!this.gaugesWorker) return;
        const rawGauges: any[] = Array.isArray(node.parameters?.gauges) ? node.parameters.gauges : [];
        const hiddenProbes: number[] = [];
        rawGauges.forEach((g: any, idx: number) => {
            if (g.plot === false || g.active === false) {
                hiddenProbes.push(idx);
            }
        });

        this.gaugesWorker.postMessage({
            type: 'setConfig',
            chartMode: 'gauges',
            channel: this.gaugesChannel,
            autoScale: this.gaugesAutoScale,
            logScale: this.gaugesLogScale,
            min: this.gaugesManualMin,
            max: this.gaugesManualMax,
            showAxes: true,
            showGrid: true,
            showPeaks: this.gaugesShowPeaks,
            showCanvasLegend: true,
            interactionMode: this.gaugesBoxMode ? 'boxZoom' : 'pan',
            gauges: rawGauges,
            hiddenProbes,
            selectedProbe: -1
        });

        let rawHist = incomingData ?? this.getGaugesHistoryForNode(node);
        if (!rawHist) return;
        if ((rawHist.gauges_history || Array.isArray(rawHist)) && (!rawHist.times || !rawHist.values)) {
            rawHist = this.stateManager.normalizeGaugesTelemetry(rawHist);
        }
        if (!rawHist || !Array.isArray(rawHist.times) || rawHist.times.length === 0) return;

        const times: number[] = rawHist.times;
        let effectiveGauges: any[] = rawGauges.length > 0 ? [...rawGauges] : [];
        let orderedValues: number[][][] = [];
        const hasChannelSamples = (arr: any): boolean =>
            Array.isArray(arr) && arr.length > 0 && arr.some((ch: any) => Array.isArray(ch) && ch.length > 0);

        if (Array.isArray(rawHist.values) && rawHist.values.some(hasChannelSamples)) {
            orderedValues = rawHist.values;
            if (effectiveGauges.length === 0) {
                effectiveGauges = orderedValues.map((_, idx) => ({ id: `G${idx + 1}`, name: `G${idx + 1}` }));
            }
        } else if (Array.isArray(rawHist.gauges_history) && rawHist.gauges_history.length > 0) {
            if (effectiveGauges.length === 0) {
                effectiveGauges = rawHist.gauges_history.map((h: any, idx: number) => ({
                    id: String(h.id || `G${idx + 1}`),
                    name: String(h.id || `G${idx + 1}`)
                }));
            }
            orderedValues = effectiveGauges.map((g: any, idx: number) => {
                const gid = String(g.id || g.name || `G${idx + 1}`);
                const gUpper = gid.toUpperCase();
                const match = rawHist.gauges_history.find((h: any) => String(h.id || '').toUpperCase() === gUpper) || rawHist.gauges_history[idx];
                return Array.isArray(match?.channel_values) ? match.channel_values : [];
            });
            if (!orderedValues.some(hasChannelSamples)) {
                effectiveGauges = rawHist.gauges_history.map((h: any, idx: number) => ({
                    id: String(h.id || `G${idx + 1}`),
                    name: String(h.id || `G${idx + 1}`)
                }));
                orderedValues = rawHist.gauges_history.map((h: any) => Array.isArray(h?.channel_values) ? h.channel_values : []);
            }
        } else if (rawHist.values && typeof rawHist.values === 'object') {
            const valObj = rawHist.values as Record<string, number[][]>;
            const uniqueNamedKeys = Object.keys(valObj).filter(k => isNaN(Number(k)));
            if (effectiveGauges.length === 0) {
                effectiveGauges = uniqueNamedKeys.map(k => ({ id: k, name: k }));
            }
            orderedValues = effectiveGauges.map((g: any, idx: number) => {
                const gid = String(g.id || g.name || `G${idx + 1}`);
                return valObj[gid]
                    || valObj[gid.toUpperCase()]
                    || valObj[gid.toLowerCase()]
                    || valObj[String(idx)]
                    || valObj[`G${idx + 1}`]
                    || [];
            });
            if (!orderedValues.some(hasChannelSamples) && uniqueNamedKeys.length > 0) {
                effectiveGauges = uniqueNamedKeys.map(k => ({ id: k, name: k }));
                orderedValues = uniqueNamedKeys.map(k => valObj[k] || []);
            }
        }

        if (orderedValues.some(hasChannelSamples)) {
            this.gaugesWorker.postMessage({
                type: 'setGaugeData',
                times,
                values: orderedValues,
                gauges: effectiveGauges
            });
        }
    }

    private handleTelemetry(nodeId: string, data: any): void {
        if (nodeId !== this.currentNodeId) return;
        const activeModel = this.stateManager.getActiveModel();
        const node = activeModel?.nodes.find(n => n.id === nodeId);
        if (node && (node.type === 'VirtualGauges' || node.type === 'VirtualGauges3D')) {
            this.syncGaugesChartWorker(node, data);
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
        this.cleanupWorkers();

        const activeModel = this.stateManager.getActiveModel();
        const has2D = activeModel?.nodes.some(n => isDomainMesh2DNode(n.type) || n.type === 'CFDSolver2D' || n.type === 'MPMDomain2D') || false;
        const is3D = activeModel?.nodes.some(n => isDomainMesh3DNode(n.type) || n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain') || false;

        const ALL_CHANNELS = [
            { id: 0, param: 'qty_pressure',     label: 'Pressure P(t) [Pa]' },
            { id: 7, param: 'qty_overpressure', label: 'Overpressure ΔP(t) [Pa]' },
            { id: 8, param: 'qty_impulse',      label: 'Impulse I(t) [Pa·s]' },
            { id: 1, param: 'qty_density',      label: 'Density ρ(t) [kg/m³]' },
            { id: 2, param: 'qty_velocity',     label: 'Velocity |u|(t) [m/s]' },
            { id: 3, param: 'qty_energy',       label: 'Int. Energy e(t) [J/kg]' },
            { id: 4, param: 'qty_reacted',      label: 'Reacted α₁(t) [-]' },
            { id: 5, param: 'qty_unreacted',    label: 'Unreacted α₂(t) [-]' },
            { id: 6, param: 'qty_air',          label: 'Ambient Air(t) [-]' }
        ];
        if (node.parameters?.telemetry_channel !== undefined && isFinite(Number(node.parameters.telemetry_channel))) {
            this.gaugesChannel = Number(node.parameters.telemetry_channel);
        }

        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';
        this.container.style.padding = '0';

        const panel = document.createElement('div');
        panel.className = 'gauges-manager-panel';
        panel.style.cssText = 'display:flex; width:100%; height:100%; min-width:0; min-height:0; overflow:hidden;';

        // 1. LEFT PANEL: Full-Bleed Chart Container
        const chartContainer = document.createElement('div');
        chartContainer.className = 'gauges-chart-container';
        chartContainer.style.cssText = 'display:flex; flex-direction:column; flex:1; min-width:0; min-height:0; overflow:hidden;';
        panel.appendChild(chartContainer);

        // Unified Dark Slate/Cyan Header
        const chartHeader = document.createElement('div');
        chartHeader.className = 'gauges-chart-header';
        chartHeader.style.cssText = 'display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:6px 10px; height:auto; min-height:38px; background:#0f1420; border-bottom:1px solid rgba(56,189,248,0.18); flex-shrink:0;';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'title';
        titleSpan.style.cssText = 'font-weight:700; font-size:11px; color:#e2e8f0; letter-spacing:0.4px; margin-right:4px;';
        titleSpan.textContent = `GAUGE WAVEFORMS: ${node.id}`;
        chartHeader.appendChild(titleSpan);

        const channelSelect = document.createElement('select');
        channelSelect.style.cssText = 'font-size:10.5px; background:#161d2e; color:#e2e8f0; border:1px solid rgba(148,163,184,0.28); padding:2px 6px; border-radius:4px; cursor:pointer;';
        const populateChannelOptions = () => {
            const enabled = ALL_CHANNELS.filter(ch => node.parameters?.[ch.param] !== false);
            const activeList = enabled.length > 0 ? enabled : ALL_CHANNELS;
            if (!activeList.some(ch => ch.id === this.gaugesChannel)) {
                this.gaugesChannel = activeList[0].id;
            }
            channelSelect.innerHTML = '';
            activeList.forEach((ch) => {
                const opt = document.createElement('option');
                opt.value = String(ch.id);
                opt.textContent = ch.label;
                if (ch.id === this.gaugesChannel) opt.selected = true;
                channelSelect.appendChild(opt);
            });
        };
        populateChannelOptions();
        channelSelect.onchange = () => {
            this.gaugesChannel = Number(channelSelect.value);
            this.stateManager.updateNodeParametersInPlace(node.id, { telemetry_channel: this.gaugesChannel });
            this.syncGaugesChartWorker(node);
        };
        chartHeader.appendChild(channelSelect);

        const mkHdrBtn = (label: string, title: string, isActive: () => boolean, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.title = title;
            const sync = () => {
                const act = isActive();
                b.style.cssText = `background:${act ? 'rgba(56,189,248,0.2)' : '#161d2e'}; color:${act ? '#38bdf8' : '#cbd5e1'}; border:1px solid ${act ? 'rgba(56,189,248,0.55)' : 'rgba(148,163,184,0.25)'}; border-radius:4px; font-size:10px; font-weight:600; padding:2px 7px; cursor:pointer;`;
            };
            sync();
            b.onclick = () => {
                onClick(b);
                sync();
            };
            return b;
        };

        const manualYWrap = document.createElement('div');
        manualYWrap.style.cssText = `display:${this.gaugesAutoScale ? 'none' : 'flex'}; align-items:center; gap:4px;`;
        const mkManualIn = (val: number, onSet: (v: number) => void) => {
            const inp = document.createElement('input');
            inp.type = 'number';
            inp.step = 'any';
            inp.value = String(val);
            inp.style.cssText = 'width:62px; font-size:10px; background:#0b0f19; color:#e2e8f0; border:1px solid rgba(148,163,184,0.3); border-radius:3px; padding:2px 4px;';
            inp.onchange = () => {
                const num = Number(inp.value);
                if (isFinite(num)) {
                    onSet(num);
                    this.syncGaugesChartWorker(node);
                }
            };
            return inp;
        };
        const gMinIn = mkManualIn(this.gaugesManualMin, (v) => { this.gaugesManualMin = v; });
        const gMaxIn = mkManualIn(this.gaugesManualMax, (v) => { this.gaugesManualMax = v; });
        manualYWrap.appendChild(gMinIn);
        manualYWrap.appendChild(gMaxIn);

        chartHeader.appendChild(mkHdrBtn(this.gaugesAutoScale ? 'AUTO' : 'MAN', 'Toggle Auto-Scale vs Manual Y Range', () => this.gaugesAutoScale, (b) => {
            this.gaugesAutoScale = !this.gaugesAutoScale;
            b.textContent = this.gaugesAutoScale ? 'AUTO' : 'MAN';
            manualYWrap.style.display = this.gaugesAutoScale ? 'none' : 'flex';
            this.syncGaugesChartWorker(node);
        }));
        chartHeader.appendChild(manualYWrap);

        chartHeader.appendChild(mkHdrBtn(this.gaugesLogScale ? 'LOG' : 'LIN', 'Toggle Logarithmic vs Linear Y Scale', () => this.gaugesLogScale, (b) => {
            this.gaugesLogScale = !this.gaugesLogScale;
            b.textContent = this.gaugesLogScale ? 'LOG' : 'LIN';
            this.syncGaugesChartWorker(node);
        }));

        const navGroup = document.createElement('div');
        navGroup.style.cssText = 'display:flex; align-items:center; gap:4px; margin-left:auto; flex-wrap:wrap;';

        navGroup.appendChild(mkHdrBtn('▲▼ Peaks', 'Show Automatic Peak & Trough Markers', () => this.gaugesShowPeaks, () => {
            this.gaugesShowPeaks = !this.gaugesShowPeaks;
            this.syncGaugesChartWorker(node);
        }));

        navGroup.appendChild(mkHdrBtn('⬚ Box', 'Rubberband Box-Zoom Mode (or Shift+Drag / Right-Drag)', () => this.gaugesBoxMode, () => {
            this.gaugesBoxMode = !this.gaugesBoxMode;
            this.syncGaugesChartWorker(node);
        }));

        navGroup.appendChild(mkHdrBtn('＋', 'Zoom In', () => false, () => this.gaugesWorker?.postMessage({ type: 'zoom', factor: 1.25 })));
        navGroup.appendChild(mkHdrBtn('－', 'Zoom Out', () => false, () => this.gaugesWorker?.postMessage({ type: 'zoom', factor: 0.8 })));
        navGroup.appendChild(mkHdrBtn('🏠 Fit', 'Reset Zoom & Pan (Double-Click Chart)', () => false, () => this.gaugesWorker?.postMessage({ type: 'resetView' })));

        const initialGaugeCount = Array.isArray(node.parameters?.gauges) ? node.parameters.gauges.length : 0;
        const toggleDrawer = () => {
            this.gaugesPanelOpen = !this.gaugesPanelOpen;
            const controlsPanelEl = panel.querySelector('.gauges-controls-panel') as HTMLElement | null;
            const splitterEl = panel.querySelector('.gauges-panel-splitter') as HTMLElement | null;
            if (controlsPanelEl) {
                controlsPanelEl.style.display = this.gaugesPanelOpen ? 'flex' : 'none';
                controlsPanelEl.style.width = `${this.gaugesPanelWidth}px`;
            }
            if (splitterEl) splitterEl.style.display = this.gaugesPanelOpen ? 'block' : 'none';
            floatBtn.style.display = this.gaugesPanelOpen ? 'none' : 'block';
            drawerToggleBtn.style.background = this.gaugesPanelOpen ? 'rgba(56,189,248,0.2)' : '#161d2e';
            drawerToggleBtn.style.color = this.gaugesPanelOpen ? '#38bdf8' : '#cbd5e1';
        };

        const drawerToggleBtn = mkHdrBtn(`📋 Probes (${initialGaugeCount})`, 'Toggle Probe Table & Export Settings Drawer', () => this.gaugesPanelOpen, () => {
            toggleDrawer();
        });
        drawerToggleBtn.classList.add('gauges-drawer-toggle-btn');
        navGroup.appendChild(drawerToggleBtn);

        navGroup.appendChild(mkHdrBtn('🎯 Stage View', 'Open Interactive Full-Featured Gauge Chart in Stage Viewport', () => true, () => {
            (window as any).workspaceManager?.openGaugeWaveformView?.(activeModel?.id);
        }));
        chartHeader.appendChild(navGroup);
        chartContainer.appendChild(chartHeader);

        // Full-Bleed Chart Area backed by OffscreenCanvas ChartWorker
        const chartArea = document.createElement('div');
        chartArea.className = 'gauges-chart-area';
        chartArea.style.cssText = 'flex:1; min-width:0; min-height:0; position:relative; overflow:hidden; background:#0b0f19;';
        chartContainer.appendChild(chartArea);

        const canvas = document.createElement('canvas');
        canvas.className = 'gauges-canvas';
        canvas.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; display:block; touch-action:none; cursor:crosshair;';
        chartArea.appendChild(canvas);
        this.gaugesCanvas = canvas;

        let suppressGaugesCtx = false;
        canvas.addEventListener('contextmenu', (e) => {
            if (suppressGaugesCtx || this.gaugesBoxMode) {
                e.preventDefault();
                suppressGaugesCtx = false;
            }
        });

        canvas.addEventListener('pointerdown', (e) => {
            if (e.button === 2) suppressGaugesCtx = true;
            try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
            this.gaugesWorker?.postMessage({
                type: 'mouseEvent',
                event: 'mousedown',
                offsetX: e.offsetX,
                offsetY: e.offsetY,
                shiftKey: e.shiftKey,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey,
                button: e.button
            });
            e.preventDefault();
        });

        canvas.addEventListener('pointermove', (e) => {
            this.gaugesWorker?.postMessage({
                type: 'mouseEvent',
                event: 'mousemove',
                offsetX: e.offsetX,
                offsetY: e.offsetY,
                shiftKey: e.shiftKey,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey
            });
        });

        const releaseGaugesCapture = (e: PointerEvent) => {
            if (canvas.hasPointerCapture(e.pointerId)) {
                try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
                this.gaugesWorker?.postMessage({
                    type: 'mouseEvent',
                    event: 'mouseup',
                    shiftKey: e.shiftKey,
                    ctrlKey: e.ctrlKey,
                    altKey: e.altKey,
                    button: e.button
                });
            }
        };

        canvas.addEventListener('pointerup', releaseGaugesCapture);
        canvas.addEventListener('pointercancel', releaseGaugesCapture);
        canvas.addEventListener('pointerleave', () => {
            this.gaugesWorker?.postMessage({ type: 'mouseEvent', event: 'mouseleave' });
        });

        canvas.addEventListener('wheel', (e) => {
            this.gaugesWorker?.postMessage({
                type: 'mouseEvent',
                event: 'wheel',
                offsetX: e.offsetX,
                offsetY: e.offsetY,
                deltaY: e.deltaY,
                shiftKey: e.shiftKey,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey
            });
            e.preventDefault();
        }, { passive: false });

        canvas.addEventListener('dblclick', (e) => {
            this.gaugesWorker?.postMessage({
                type: 'mouseEvent',
                event: 'dblclick',
                offsetX: e.offsetX,
                offsetY: e.offsetY,
                shiftKey: e.shiftKey
            });
            e.preventDefault();
        });

        // Floating gear button to show panel when collapsed
        const floatBtn = document.createElement('button');
        floatBtn.className = 'gauges-float-btn';
        floatBtn.innerHTML = '⚙️ Gauges & Settings';
        floatBtn.style.display = this.gaugesPanelOpen ? 'none' : 'block';
        floatBtn.onclick = () => {
            if (!this.gaugesPanelOpen) toggleDrawer();
        };
        chartArea.appendChild(floatBtn);

        // 2. RIGHT PANEL: Controls Panel (Collapsed by default so chart is 100% full-bleed)
        const controlsPanel = document.createElement('div');
        controlsPanel.className = 'gauges-controls-panel';
        controlsPanel.style.display = this.gaugesPanelOpen ? 'flex' : 'none';
        controlsPanel.style.width = `${this.gaugesPanelWidth}px`;

        const splitter = document.createElement('div');
        splitter.className = 'gauges-panel-splitter';
        splitter.style.display = this.gaugesPanelOpen ? 'block' : 'none';

        panel.appendChild(splitter);
        panel.appendChild(controlsPanel);

        splitter.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button !== 0 && e.pointerType === 'mouse') return;
            e.stopPropagation();
            e.preventDefault();
            const startX = e.clientX;
            const startW = controlsPanel.offsetWidth;
            controlsPanel.style.transition = 'none';
            splitter.classList.add('resizing');
            document.body.classList.add('is-resizing', 'resizing-col');

            try {
                splitter.setPointerCapture(e.pointerId);
            } catch (_) {}

            const onMove = (me: PointerEvent) => {
                const dx = me.clientX - startX;
                const newW = Math.max(180, Math.min(600, startW - dx));
                controlsPanel.style.width = `${newW}px`;
                this.gaugesPanelWidth = newW;
            };

            const onUp = (ue: PointerEvent) => {
                controlsPanel.style.transition = 'width 0.15s, padding 0.15s, border-left 0.15s';
                splitter.classList.remove('resizing');
                document.body.classList.remove('is-resizing', 'resizing-col');

                try {
                    splitter.releasePointerCapture(ue.pointerId);
                } catch (_) {}

                splitter.removeEventListener('pointermove', onMove);
                splitter.removeEventListener('pointerup', onUp);
                splitter.removeEventListener('pointercancel', onUp);
                splitter.removeEventListener('lostpointercapture', onUp);
            };

            splitter.addEventListener('pointermove', onMove);
            splitter.addEventListener('pointerup', onUp);
            splitter.addEventListener('pointercancel', onUp);
            splitter.addEventListener('lostpointercapture', onUp);
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
            if (this.gaugesPanelOpen) toggleDrawer();
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
                    : has2D
                        ? { id: `G${nextIdx}`, name: `G${nextIdx}`, r: 0.1, z: 0.0, active: true, plot: true }
                        : { id: `G${nextIdx}`, name: `G${nextIdx}`, r: 0.1, active: true, plot: true };
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

            const createCheckbox = (key: string, labelText: string, defaultChecked: boolean = false) => {
                const wrap = document.createElement('label');
                wrap.style.display = 'flex';
                wrap.style.alignItems = 'center';
                wrap.style.gap = '4px';
                wrap.style.fontSize = 'var(--font-xs)';
                wrap.style.cursor = 'pointer';
                wrap.style.color = '#ccc';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = defaultChecked ? (node.parameters[key] !== false) : !!node.parameters[key];
                cb.onchange = () => {
                    this.updateParameter(node, key, cb.checked);
                    if (key.startsWith('qty_')) {
                        populateChannelOptions();
                        this.syncGaugesChartWorker(node);
                    }
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

                wrap.appendChild(inputEl);
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

            const headerLabel = createCheckbox('include_header', 'Include Header Row', true);
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

            qtyGrid.appendChild(createCheckbox('qty_pressure', 'Pressure', true));
            qtyGrid.appendChild(createCheckbox('qty_density', 'Density', true));
            qtyGrid.appendChild(createCheckbox('qty_velocity', 'Velocity', true));
            qtyGrid.appendChild(createCheckbox('qty_energy', 'Internal Energy', true));
            qtyGrid.appendChild(createCheckbox('qty_reacted', 'Reacted', true));
            qtyGrid.appendChild(createCheckbox('qty_unreacted', 'Unreacted', true));
            qtyGrid.appendChild(createCheckbox('qty_air', 'Air', true));
            qtyGrid.appendChild(createCheckbox('qty_overpressure', 'Overpressure', true));
            qtyGrid.appendChild(createCheckbox('qty_impulse', 'Impulse', true));

            qtySection.appendChild(qtyGrid);
            tabContent.appendChild(qtySection);
        };

        this.container.appendChild(panel);

        this.gaugesWorker = new Worker(new URL('./ChartWorker.ts', import.meta.url), { type: 'module' });
        this.gaugesWorker.onmessage = (e) => {
            if (e.data?.type === 'bounds') {
                this.gaugesManualMin = Number(e.data.minY ?? this.gaugesManualMin);
                this.gaugesManualMax = Number(e.data.maxY ?? this.gaugesManualMax);
                if (document.activeElement !== gMinIn) gMinIn.value = this.gaugesManualMin.toExponential(2);
                if (document.activeElement !== gMaxIn) gMaxIn.value = this.gaugesManualMax.toExponential(2);
            }
        };

        const gRect = chartArea.getBoundingClientRect();
        const gW = Math.max(200, Math.round(gRect.width) || 800);
        const gH = Math.max(160, Math.round(gRect.height) || 500);
        const offscreenGauges = (canvas as any).transferControlToOffscreen();
        this.gaugesWorker.postMessage(
            { type: 'init', canvas: offscreenGauges, width: gW, height: gH, dpr: window.devicePixelRatio || 1 },
            [offscreenGauges] as any
        );
        this.syncGaugesChartWorker(node);

        requestAnimationFrame(() => {
            if (!this.gaugesWorker || !chartArea.isConnected) return;
            const r = chartArea.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                this.gaugesWorker.postMessage({ type: 'resize', width: Math.round(r.width), height: Math.round(r.height) });
            }
        });

        this.gaugesResizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                if (width > 0 && height > 0) {
                    this.gaugesWorker?.postMessage({ type: 'resize', width: Math.round(width), height: Math.round(height) });
                }
            }
        });
        this.gaugesResizeObserver.observe(chartArea);

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

        const activeModel = this.stateManager.getActiveModel();
        const gauges = node.parameters?.gauges || [];
        const is3D = activeModel?.nodes.some(n => isDomainMesh3DNode(n.type) || n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain') || false;

        if (node.parameters?.source_mode === 'external_file') {
            tableContainer.innerHTML = '';
            const banner = document.createElement('div');
            banner.style.padding = '20px';
            banner.style.textAlign = 'center';
            banner.style.color = '#80cbc4';
            banner.style.background = 'rgba(0, 77, 64, 0.15)';
            banner.style.borderRadius = '6px';
            banner.style.border = '1px solid #004d40';
            banner.style.margin = '10px 0';
            banner.innerHTML = `
                <div style="font-weight: bold; font-size: 13px; margin-bottom: 8px;">📁 Streaming External Probe Dataset</div>
                <div style="font-size: 11px; color: #a1a1aa; margin-bottom: 6px;">File: <code>${node.parameters.external_file_path || 'No file selected'}</code></div>
                <div style="font-size: 11px; color: #a1a1aa; margin-bottom: 10px;">Format: ${node.parameters.external_file_format || 'Auto'} · Stride: ${node.parameters.sampling_stride_steps || 1} step(s)</div>
                <div style="font-size: 10px; color: #38bdf8; line-height: 1.4;">Probes are read and indexed directly in solver VRAM and streamed to HDF5. Live telemetry tracks up to 16 pinned watch probes and global extrema envelopes. Use the Pipeline Browser to inspect or search specific probes.</div>
            `;
            tableContainer.appendChild(banner);
            const infoSpan = this.container.querySelector('.gauges-pagination-info') as HTMLElement;
            if (infoSpan) infoSpan.textContent = `External Dataset (${node.parameters.external_probe_count || 0} probes)`;
            return;
        }

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
        const checkedCount = pagedGauges.filter((g: any) => g.plot !== false).length;
        masterCheck.checked = pagedGauges.length > 0 && checkedCount === pagedGauges.length;
        masterCheck.indeterminate = checkedCount > 0 && checkedCount < pagedGauges.length;
        masterCheck.onchange = () => {
            const checked = masterCheck.checked;
            pagedGauges.forEach((g: any) => { g.plot = checked; });
            if (node.parameters) node.parameters.gauges = gauges;
            this.stateManager.updateNodeParametersInPlace(node.id, { gauges: [...gauges] });
            this.syncVirtualGauges(node, has2D);
            this.syncGaugesChartWorker(node);
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
                if (node.parameters) node.parameters.gauges = gauges;
                this.stateManager.updateNodeParametersInPlace(node.id, { gauges: [...gauges] });
                const newCheckedCount = pagedGauges.filter((pg: any) => pg.plot !== false).length;
                masterCheck.checked = pagedGauges.length > 0 && newCheckedCount === pagedGauges.length;
                masterCheck.indeterminate = newCheckedCount > 0 && newCheckedCount < pagedGauges.length;
                this.syncGaugesChartWorker(node);
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

    private startRenderLoop(): void {
        if (this.renderRequestId !== null) return;
        const loop = () => {
            if (this.telemetryBuffer && this.chartWorker) {
                const activeModel = this.stateManager.getActiveModel();
                const node = activeModel?.nodes.find(n => n.id === this.currentNodeId);
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
        const activeModel = this.stateManager.getActiveModel();
        const node = activeModel?.nodes.find(n => n.id === nodeId);
        if (!node) return;

        if (node.type === 'TelemetryText') {
            const livePageEl = document.getElementById(`viewer-live-page-${nodeId}`);
            if (livePageEl) {
                const latest = this.stateManager.getLatestMetric(nodeId);
                if (latest) {
                    livePageEl.textContent = this.stateManager.formatTelemetryPage(latest.data, latest.modelId, node);
                }
            }
            const terminal = document.getElementById(`viewer-text-${nodeId}`);
            if (terminal && Array.isArray(data)) {
                this.syncTerminal(terminal, data);
            }
        } else if (node.type === 'TelemetryContour') {
            if (data instanceof ArrayBuffer) {
                this.contourWorker?.postMessage(data, [data]);
            } else if (data && typeof data === 'object') {
                this.contourWorker?.postMessage({
                    type: 'setConfig',
                    step: typeof data.step === 'number' ? data.step : undefined,
                    time: typeof data.time === 'number' ? data.time : undefined,
                    dt: typeof data.dt === 'number' ? data.dt : undefined
                });
            }
        } else if (node.type === 'TelemetryGraph' || node.type === 'Telemetry3DViewport') {
            this.telemetryBuffer = data;
        }
    }
    private createInputElement(node: Node, key: string, value: any): HTMLElement {
        const numericKeys = [
            'domain_radius', 'cell_size', 'atm_pressure', 'atm_temperature', 'initial_temperature',
            'water_temperature', 'soil_temperature', 'air_temperature',
            'charge_mass', 'rho', 'detonation_energy', 'jwl_A', 'jwl_B',
            'jwl_R1', 'jwl_R2', 'jwl_omega', 'det_vel', 'cfl', 'endtime',
            'spatial_order', 'temporal_order', 'gamma', 'plot_stride', 'refresh_rate', 'fps',
            'ascii_precision', 'step_interval', 'time_interval', 'downsample_stride', 'tessellation_max_edge',
            'telemetry_channel', 'telemetry_interval_ms', 'vtk_step_interval',
            // 2D CFD keys
            'nr', 'nz', 'min_r', 'min_z', 'max_r', 'max_z', 'explosive_x', 'explosive_y', 'explosive_z', 'explosive_radius', 'remap_radius', 'explosive_r',
            'charge_r', 'charge_z', 'charge_radius', 'charge_height', 'charge_aspect_ratio',
            'detonator_r', 'detonator_z', 'detonator_radius', 'detonator_x', 'detonator_y', 'time_delay', 'detonator_time',
            'trigger_r', 'trigger_z', 'trigger_radius', 'trigger_x', 'trigger_y',
            'ideal_gamma', 'ideal_rho_0', 'ideal_e_0', 'high_rho', 'ambient_rho', 'ambient_p',
            // 3D CFD keys
            'nx', 'ny', 'nz', 'xmax', 'ymax', 'zmax',
            'charge_x', 'charge_y', 'charge_z', 'charge_lx', 'charge_ly', 'charge_lz',
            'charge_rot_x', 'charge_rot_y', 'charge_rot_z',
            'detonator_x', 'detonator_y', 'detonator_z', 'trigger_x', 'trigger_y', 'trigger_z', 'xmin', 'ymin', 'zmin',
            'scale_factor',
            'min_y', 'max_y', 'min_val', 'max_val', 'stl_min_val', 'stl_max_val', 'obstacles_min_val', 'obstacles_max_val', 'ambientLevel', 'specularIntensity', 'aoRadius', 'aoIntensity', 'aoBias', 'gauge_size', 'gauge_opacity', 'stl_opacity', 'obstacles_opacity', 'grid_opacity',
            'charge_opacity', 'detonators_size', 'detonator_size', 'detonators_opacity', 'detonator_opacity', 'triggers_size', 'trigger_size', 'triggers_opacity', 'trigger_opacity',
            'amr_max_levels', 'amr_threshold', 'amr_coarsen_ratio', 'amr_tile_size',
            'center_x', 'center_y', 'center_z', 'size_x', 'size_y', 'size_z', 'radius', 'height', 'length',
            'offset', 'stride',
            // MPM keys
            'pos_x', 'pos_y', 'pos_z', 'size_x', 'size_y', 'size_z', 'vel_x', 'vel_y', 'vel_z', 'initial_velocity_x', 'initial_velocity_y', 'initial_velocity_z', 'initial_velocity_r', 'radius', 'inner_radius',
            'scale_x', 'scale_y', 'scale_z',
            'rot_x', 'rot_y', 'rot_z',
            'clip_z_min', 'clip_z_max',
            'stl_scale_x', 'stl_scale_y', 'stl_scale_z', 'stl_pos_x', 'stl_pos_y', 'stl_pos_z', 'stl_rot_x', 'stl_rot_y', 'stl_rot_z',
            'angular_vel', 'angular_vel_x', 'angular_vel_y', 'angular_vel_z',
            'density', 'youngs_modulus', 'poissons_ratio', 'yield_stress', 'hardening_modulus',
            'failure_strain', 'tensile_failure_stress', 'erosion_strain', 'erosion_stress', 'erosion_min_density', 'erosion_min_density_ratio',
            'mpm_cell_size', 'mpm_xmin', 'mpm_xmax', 'mpm_ymin', 'mpm_ymax', 'mpm_zmin', 'mpm_zmax',
            'jc_A', 'jc_B', 'jc_n', 'jc_C', 'jc_m', 'jc_d1', 'jc_d2', 'jc_d3', 'jc_d4', 'jc_d5', 'T_melt', 'T_room', 'Cp',
            'weibull_modulus', 'weibull_scale', 'weibull_ref_volume',
            'anisotropy_ratio', 'anisotropy_dir_x', 'anisotropy_dir_y', 'anisotropy_dir_z',
            'mg_gamma0', 'mg_c0', 'mg_s',
            'ppc', 'phase_particle_ppc', 'charge_ppc',
            'mpmParticleDiameter', 'mpmParticleSize', 'mpmParticleMinVal', 'mpmParticleMaxVal', 'mpmParticleOpacity', 'flip_blend',
            'phaseParticleDiameter', 'phaseParticleSize', 'phaseParticleOpacity', 'phaseParticleStride',
            'dem_friction', 'dem_restitution', 'dem_contact_scale', 'dem_velocity_threshold',
            'sdf_barrier_restitution', 'sdf_barrier_friction', 'sdf_barrier_skin',
            // FEM keys
            'hourglass_coeff', 'bulk_viscosity_b1', 'bulk_viscosity_b2', 'timestep_erosion_factor', 'min_volume_ratio', 'contact_stiffness', 'contact_penalty_scale', 'friction_static', 'friction_kinetic', 'contact_damping', 'cohesive_fracture_energy', 'node_merge_tolerance',
            'mpm_particles_per_failed_element', 'material_heterogeneity', 'debris_velocity_smoothing', 'debris_clumping', 'debris_max_clump_size', 'random_seed', 'rebar_diameter', 'rebar_area', 'beamRadius', 'beam_radius', 'beam_area', 'beamMinVal', 'beamMaxVal',
            'rebarRadius', 'viewport_refresh_rate', 'node1_x', 'node1_y', 'node1_z', 'node2_x', 'node2_y', 'node2_z',
            'femMinVal', 'femMaxVal', 'femOpacity', 'femContourLevels', 'sliceContourLevels', 'beamContourLevels', 'mpmContourLevels', 'vacuum_density', 'vacuum_pressure', 'uncovering_tolerance',
            // Concrete Core & Models (RHT, K&C, CSCM)
            'fc', 'ft', 'G_f', 'moisture_content', 'dif_cap_compression', 'dif_cap_tension',
            'rht_A', 'rht_N', 'rht_B', 'rht_M', 'rht_Q0', 'rht_BQ', 'rht_D1', 'rht_D2',
            'rht_p_crush', 'rht_p_lock', 'rht_alpha0', 'rht_n_comp', 'rht_betac', 'rht_deltat',
            'kc_a0', 'kc_a1', 'kc_a2', 'kc_a0y', 'kc_a1y', 'kc_a2y', 'kc_a1r', 'kc_a2r', 'kc_b1', 'kc_omega',
            'cscm_alpha', 'cscm_theta', 'cscm_lambda', 'cscm_beta', 'cscm_R', 'cscm_X0', 'cscm_W', 'cscm_D1', 'cscm_D2',
            // Hyperelastic, CDP, and Hill48 Keys
            'yeoh_c10', 'yeoh_c20', 'yeoh_c30', 'mr_c10', 'mr_c01', 'k_bulk',
            'cdp_f_t0', 'cdp_f_c0', 'cdp_g_f', 'cdp_l_ch',
            'hill_F', 'hill_G', 'hill_H', 'hill_L', 'hill_M', 'hill_N', 'hill_sigma_y0',
            // Tait Water & Shock Fluid Keys
            'tait_gamma', 'tait_B', 'tait_rho0', 'tait_c0', 'tait_p_cav', 'tait_p0', 'tait_viscosity', 'tait_gruneisen', 'tait_variant',
            // Davis & CREST Reactive Burn
            'davis_c0', 'davis_s1', 'davis_gamma0', 'davis_cv', 'davis_t0', 'davis_rho0',
            'davis_a', 'davis_b', 'davis_k', 'davis_vc', 'davis_pc', 'davis_q_det',
            'crest_b1', 'crest_c1', 'crest_m1', 'crest_b2', 'crest_c2', 'crest_c3', 'crest_m2', 'crest_s0', 'crest_s_threshold', 'crest_awe_K0s', 'crest_awe_A1', 'crest_awe_A2', 'crest_awe_A3', 'crest_awe_B1', 'crest_awe_B2', 'crest_awe_B3', 'crest_awe_fc', 'crest_awe_delta', 'crest_awe_Gamma1', 'crest_awe_Gamma2', 'crest_awe_gamma00', 'crest_awe_m', 'crest_awe_c0', 'crest_awe_c1', 'crest_awe_c2', 'crest_awe_c3', 'crest_awe_c6', 'crest_awe_c8', 'crest_awe_c9', 'crest_awe_c10', 'crest_awe_c11', 'crest_awe_c12', 'crest_awe_c13',
            'initiation_radius', 'booster_overpressure',
            // JWL Programmed Burn & Lee-Tarver Ignition & Growth
            'burn_zone_cells', 'tau_burn_min',
            'lt_I', 'lt_a', 'lt_b', 'lt_x',
            'lt_G1', 'lt_c', 'lt_d', 'lt_y',
            'lt_G2', 'lt_e', 'lt_g', 'lt_z',
            'lt_F_ig_max', 'lt_F_G1_max', 'lt_F_G2_min', 'jwlr_A', 'jwlr_B', 'jwlr_R1', 'jwlr_R2', 'jwlr_omega', 'jwlr_Cv', 'jwlr_T0',
            // Afterburn & Aerobic Combustion
            'afterburn_energy', 'afterburn_fuel_fraction', 'afterburn_stoich_ratio',
            'afterburn_ignition_temp', 'afterburn_tau_chem', 'afterburn_c_edc', 'afterburn_tau_expansion',
            'afterburn_ambient_o2_fraction', 'ambient_o2_fraction',
            // VTK ROI & Strides
            'roi_xmin', 'roi_xmax', 'roi_ymin', 'roi_ymax', 'roi_zmin', 'roi_zmax', 'volume_stride', 'slice_stride', 'compression_level',
            'nonlocal_radius', 'opacity',
            // Lysmer-Kuhlemeyer Absorbing Boundaries
            'lysmer_rho', 'lysmer_cp', 'lysmer_cs', 'lysmer_normal_relaxation', 'lysmer_shear_relaxation',
            'lysmer_x_min', 'lysmer_x_max', 'lysmer_y_min', 'lysmer_y_max', 'lysmer_z_min', 'lysmer_z_max', 'lysmer_tol',
            // Zonal MPM-to-FV Water Handoff Sleeve & Symplectic Multi-Rate Subcycling
            'hybrid_sleeve_radius', 'hybrid_overlap_thickness', 'hybrid_subcycles', 'hybrid_macro_dt',
            // Virtual Gauges Massive & External Dataset Keys
            'sampling_stride_steps', 'external_probe_count',
            'external_bounds_min_x', 'external_bounds_max_x',
            'external_bounds_min_y', 'external_bounds_max_y',
            'external_bounds_min_z', 'external_bounds_max_z',
            // TelemetryText Keys
            'font_size', 'buffer_capacity',
            // Camera & Viewport Navigation Keys
            'camera_fov', 'camera_pitch', 'camera_yaw', 'camera_distance',
            'target_x', 'target_y', 'target_z',
            // Marine Blast & UNDEX Zonal Keys
            'water_surface_z', 'seabed_surface_z', 'gravity_z', 'k0_earth_pressure', 'nearfield_sleeve_radius', 'nearfield_ppc', 'weber_breakup_threshold',
            'soil_density', 'soil_friction_angle', 'soil_cohesion', 'crater_bed_width', 'crater_bed_depth',
            'friction_angle', 'cohesion', 'dilation_angle', 'tensile_cutoff',
            'soil_c0', 'seabed_c0', 'soil_gamma', 'seabed_gamma', 'soil_s', 'seabed_s', 'soil_gruneisen', 'seabed_gruneisen', 'soil_p_cav', 'seabed_p_cav', 'soil_eos_variant',
            'dp_cohesion', 'dp_friction_angle', 'dp_dilatancy_angle', 'dp_tensile_cutoff', 'dp_hardening_modulus'
        ];

        const chargeShapeOptions = node.type === 'Charge3D' ? ['Sphere', 'Cylinder', 'Block'] : ['Sphere', 'Cylinder'];

        let currentMatModel = node.parameters['material_model'];
        if (!currentMatModel) {
            const matType = node.parameters['material_type'];
            if (matType === 'Air') currentMatModel = 'Ideal Gas';
            else if (matType === 'JWL Charge') currentMatModel = 'JWL Detonation Gas';
            else if (matType === 'Ideal Gas Charge') currentMatModel = 'Ideal Gas';
            else currentMatModel = 'Hypoelastic';
        }
        const dynamicPresets = (node.type === 'Material')
            ? getPresetsForConstitutiveModel(currentMatModel)
            : [...MPM_MATERIAL_PRESET_NAMES];

        const dropdowns: Record<string, string[]> = {
            'font_size': ['8', '9', '10', '11', '12', '13', '14', '15', '16', '18', '20', '22'],
            'stream_layout': ['Live Page (In-Place)', 'Multi-Line Cards', 'Dual-Deck (Page + Log)', 'Columnar (Fixed-Width)', 'Ultra-Compact', 'Standard Log'],
            'filter_level': ['All', 'Metrics Only', 'Logs Only'],
            'timestamp_mode': ['None', 'Relative', 'Clock'],
            'source_mode': ['manual', 'external_file'],
            'external_file_format': ['Auto', 'CSV', 'Binary Float32', 'HDF5'],
            'ascii_delimiter': ['Comma', 'Tab', 'Space'],
            'material_model': getConstitutiveModels(),
            'preset': dynamicPresets,
            'solid_model': ['Mie-Grüneisen Shock Reactant', 'Davis Solid Reactant', 'Unreacted JWL (Lee-Tarver)'],
            'mixture_rule': ['Pressure Equilibrium (Volume Additive)', 'Linear Blend'],
            'burn_model': ['Programmed Wavefront Burn', 'Lee-Tarver 3-Stage ODE', 'CREST Shock Entropy Kinetics'],
            'product_model': ['JWL Product Gas', 'Davis Detonation Product'],
            'rebar_formulation': ['TimoshenkoBeam3D', 'AxialTruss1D'],
            'beam_formulation': ['TimoshenkoBeam3D', 'AxialTruss1D'],
            'beamQuantity': ['plasticStrain', 'vonMises', 'momentOrForce', 'velocity', 'damage'],
            'beamColormap': ['rainbow', 'plasma', 'viridis', 'coolwarm', 'cividis', 'grayscale'],
            'coupling_scheme': ['Two-Way Staggered', 'Sub-Cycling'],
            'pressure_integration': ['2x2 Gauss Quadrature', '1-Point Centroid'],
            'uncovering_method': ['Conservative IDW + Vacuum Cavity', 'Ghost-Fluid Standard'],
            'shape': ['box', 'sphere', 'cylinder'],

            'mesh_type': ['regular', 'amr'],
            'dimension': ['1D', '2D', '3D'],
            'x_min_bc': ['Reflecting', 'Transmitting', 'Terminate', 'Sticky', 'FreeSlip', 'Lysmer'],
            'x_max_bc': ['Reflecting', 'Transmitting', 'Terminate', 'Sticky', 'FreeSlip', 'Lysmer'],
            'y_min_bc': ['Reflecting', 'Transmitting', 'Terminate', 'Sticky', 'FreeSlip', 'Lysmer'],
            'y_max_bc': ['Reflecting', 'Transmitting', 'Terminate', 'Sticky', 'FreeSlip', 'Lysmer'],
            'z_min_bc': ['Reflecting', 'Transmitting', 'Terminate', 'Sticky', 'FreeSlip', 'Lysmer'],
            'z_max_bc': ['Reflecting', 'Transmitting', 'Terminate', 'Sticky', 'FreeSlip', 'Lysmer'],
            'left_bc': ['Reflecting'],
            'right_bc': ['Transmitting', 'Reflecting', 'Terminate'],
            'bc_x_min': ['Reflecting', 'Transmitting', 'Terminate', 'Sticky', 'FreeSlip', 'Lysmer'],
            'bc_x_max': ['Reflecting', 'Transmitting', 'Terminate', 'Sticky', 'FreeSlip', 'Lysmer'],
            'bc_y_min': ['Reflecting', 'Transmitting', 'Terminate', 'Sticky', 'FreeSlip', 'Lysmer'],
            'bc_y_max': ['Reflecting', 'Transmitting', 'Terminate', 'Sticky', 'FreeSlip', 'Lysmer'],
            'bc_r_min': ['Reflecting', 'Transmitting', 'Terminate', 'Sticky', 'FreeSlip', 'Lysmer'],
            'bc_r_max': ['Reflecting', 'Transmitting', 'Terminate', 'Sticky', 'FreeSlip', 'Lysmer'],
            'bc_z_min': ['Reflecting', 'Transmitting', 'Terminate', 'Sticky', 'FreeSlip', 'Lysmer'],
            'bc_z_max': ['Reflecting', 'Transmitting', 'Terminate', 'Sticky', 'FreeSlip', 'Lysmer'],
            'coordinate_system': ['Axisymmetric', 'Cartesian'],
            'device': ['cpu', 'cuda'],
            'precision': ['double', 'single'],
            'integration_scheme': ['OnePointFB', 'OnePointKF', 'FullGauss8', 'SelectiveReduced'],
            'hourglass_model': ['FlanaganBelytschkoStiffness', 'FlanaganBelytschkoViscous', 'KosloffFrazier'],
            'contact_search_method': ['Hierarchical Octave Hash Grid', 'Linear BVH (Morton Code)'],
            'mesh_source': ['Box Generator', 'Cylinder Generator', 'Plate Generator', 'STL File', 'LS-DYNA Keyword File'],
            'element_topology': ['Hex8', 'Tet4_ANP'],
            'trigger_type': ['Step Interval', 'Time Interval'],
            'vtk_format': ['Binary', 'XDMF + HDF5', 'ASCII'],
            'compression_level': ['1', '3', '6', '9'],
            'float_precision': ['12-bit Mantissa (~4 sig. digits)', '16-bit Mantissa (~5 sig. digits)', 'Full 23-bit Float32 (Lossless)'],
            'mpm_topology': ['Individual Vertices', 'Single PolyVertex', 'Zero-Cell Point Cloud'],
            'composition': [...Object.keys(EXPLOSIVE_PRESETS).sort(), 'Custom'],
            'undex_coupling_method': ['LocalCurvedDAA', 'HighFidelityCFD', 'ZonalHybrid_MPM_FV_FEM'],
            'seabed_mesh_type': ['Pure_FV', 'Hybrid_MPM_Crater_FEM_FarField', 'Full_Domain_MPM', 'Local_Crater_MPM', 'Pure_Hex8_FEM', 'Pure_MPM'],
            'water_discretization_mode': ['Pure_FV', 'LPTP_Phase_Tracking_Sleeve', 'Full_Column_LPTP_Cylinder'],
            'init_mode': (node.type === 'CFDSolver3D' || node.type === 'MarineHarbourDomain') ? ['From1D', 'From2D', 'From3D', 'Multi-Material JWL', 'Ideal Gas', 'Hydrostatic_Stratified_3D'] : (node.type === 'CFDSolver' ? ['Multi-Material JWL', 'Ideal Gas'] : ['From1D', 'Multi-Material JWL', 'Ideal Gas']),
            'flux_scheme': ['AUSM+', 'Rusanov'],
            'spatial_order': ['1', '2', '3'],
            'temporal_order': ['1', '2', '3'],
            'plot_stride': ['1', '2', '5', '10', '20', '50', '100'],
            'charge_shape': chargeShapeOptions,
            'material_type': ['Air', 'JWL Charge', 'Ideal Gas Charge'],
            'transfer_scheme': (node.type === 'Material') ? 
                ['Default', 'BSpline', 'Radial MLS', 'Cubic BSpline', 'GIMP', 'Standard'] : 
                ['BSpline', 'Radial MLS', 'Cubic BSpline', 'GIMP', 'Standard'],
            'velocity_scheme': ['APIC', 'PIC', 'FLIP'],
            'contact_method': ['Single-Velocity', 'Discrete Element (DEM)', 'Multi-Velocity (Bardenhagen)'],
            'bardenhagen_grouping_policy': ['Per-Object Independent', 'By Material Node'],
            'bardenhagen_initial_tie': ['Disabled', 'Enabled'],
            'velocity_group': ['Independent (Auto)', 'Bonded Group A', 'Bonded Group B', 'Bonded Group C', 'Bonded Group D', 'Bonded Group E', 'Bonded Group F'],
            'coupler_mode': ['Bonded (Single-Velocity)', 'Independent (Bardenhagen)'],
            'coupler_group_tag': ['Bonded Group A', 'Bonded Group B', 'Bonded Group C', 'Bonded Group D', 'Bonded Group E', 'Bonded Group F'],
            'dem_contact_mode': ['Gas-Solid Only', 'Ballistic Impacts & Gas', 'All Dynamic Contacts'],
            'voxelization_method': node.type === 'MPMObject3D' ? ['watertight_raycast', 'winding_number'] : ['watertight_floodfill', 'watertight_raycast', 'thin_shell', 'winding_number'],
            'shape_type': node.type === 'FEMObject3D' ? ['Box', 'Cylinder', 'Plate', 'STL', 'LS-DYNA File'] : (node.type === 'MPMObject3D' ? ['Box', 'Sphere', 'Cylinder', 'STL'] : ['Rectangle', 'Circle']),
            'origin_mode': node.type === 'FEMObject3D' ? ['Center', 'CAD Origin'] : ['CAD Origin', 'Center'],
            'coupling_mode': ['TwoWay_Full', 'OneWay_CFD_to_MPM', 'Disabled'],
            'contour_quantity': ['von_mises', 'plastic_strain', 'density', 'velocity', 'pressure'],
            'color_map': ['rainbow', 'viridis', 'plasma', 'jet', 'coolwarm'],
            'space_time_scheme': (node.type === 'MPMDomain2D' || node.type === 'MPMDomain3D') ? 
                ['Leapfrog', 'RK2', 'USL', 'USF'] : 
                ['MUSCL-Hancock (2nd-Order Space/Time)', 'ADER-2 (2nd-Order Space/Time)', 'ADER-3 (3rd-Order Space/Time)']
        };

        if (typeof value === 'boolean' || key === 'afterburn_enabled') {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';
            select.style.fontSize = 'var(--font-sm)';

            const isEnableKey = key.startsWith('enable_') || key.startsWith('smooth_') || key.endsWith('_enabled');
            ['true', 'false'].forEach(opt => {
                const option = document.createElement('option');
                option.value = opt;
                option.text = opt === 'true' ? (isEnableKey ? 'Enabled' : 'True') : (isEnableKey ? 'Disabled' : 'False');
                if ((opt === 'true') === Boolean(value)) option.selected = true;
                select.appendChild(option);
            });

            select.addEventListener('change', () => {
                this.updateParameter(node, key, select.value === 'true');
            });
            return select;
        }

        if (key === 'material') {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';
            select.style.fontSize = 'var(--font-sm)';

            const defOption = document.createElement('option');
            defOption.value = '';
            defOption.text = '(None / Disconnected)';
            select.appendChild(defOption);

            const state = this.stateManager.getCurrentState();
            const owningModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
            const candidateNodes = owningModel ? owningModel.nodes : (state ? state.nodes : []);
            const matNodes = getCompatibleMaterialsForNode(node, candidateNodes);

            let currentMatId = node.parameters['material'] || '';
            if (!currentMatId && state) {
                const conn = state.connections.find(c => (c.toNode === node.id && c.toPort === 'material') || (c.fromNode === node.id && c.fromPort === 'material'));
                if (conn) {
                    currentMatId = conn.toNode === node.id ? conn.fromNode : conn.toNode;
                }
            }

            let found = false;
            matNodes.forEach(mat => {
                const option = document.createElement('option');
                option.value = mat.id;
                const matSummary = mat.parameters.preset || mat.parameters.composition || mat.parameters.material_type || mat.parameters.material_model || 'Material';
                option.text = `${(mat as any).name || mat.parameters?.name || mat.type} [${mat.id.substring(0, 8)}] (${matSummary})`;
                if (mat.id === currentMatId) {
                    option.selected = true;
                    found = true;
                }
                select.appendChild(option);
            });

            if (currentMatId && !found) {
                const fallback = document.createElement('option');
                fallback.value = currentMatId;
                fallback.text = `Material [${currentMatId.substring(0, 8)}]`;
                fallback.selected = true;
                select.appendChild(fallback);
            }

            select.addEventListener('change', () => {
                const newMatId = select.value;
                this.updateParameter(node, 'material', newMatId);
                this.syncMaterialConnection(node.id, newMatId);
            });

            return select;
        }

        if ((key === 'seawater_material' || key === 'water_material') && (node.type === 'MarineHarbourDomain' || node.type === 'CFDSolver3D')) {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';
            select.style.fontSize = 'var(--font-sm)';

            const defOption = document.createElement('option');
            defOption.value = '';
            defOption.text = '(None / Disconnected)';
            select.appendChild(defOption);

            const state = this.stateManager.getCurrentState();
            const owningModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
            const candidateNodes = owningModel ? owningModel.nodes : (state ? state.nodes : []);
            const matNodes = candidateNodes.filter(n => n.type === 'Material');

            let currentMatId = node.parameters[key] || '';
            if (!currentMatId && state) {
                const conn = state.connections.find(c => (c.toNode === node.id && (c.toPort === 'water' || c.toPort === 'fluid')) || (c.fromNode === node.id && (c.fromPort === 'water' || c.fromPort === 'fluid')));
                if (conn) currentMatId = conn.toNode === node.id ? conn.fromNode : conn.toNode;
            }

            let found = false;
            matNodes.forEach(mat => {
                const option = document.createElement('option');
                option.value = mat.id;
                const matModel = mat.parameters?.material_model || 'Material';
                const preset = mat.parameters?.preset;
                const matSummary = preset === 'Custom' ? `${matModel} (Custom)` : (preset || mat.parameters?.composition || matModel);
                option.text = `${(mat as any).name || mat.parameters?.name || mat.type} [${mat.id.substring(0, 8)}] (${matSummary})`;
                if (mat.id === currentMatId) {
                    option.selected = true;
                    found = true;
                }
                select.appendChild(option);
            });

            if (currentMatId && !found) {
                const fallback = document.createElement('option');
                fallback.value = currentMatId;
                fallback.text = `Water Material [${currentMatId.substring(0, 8)}]`;
                fallback.selected = true;
                select.appendChild(fallback);
            }

            select.addEventListener('change', () => {
                const newMatId = select.value;
                this.updateParameter(node, key, newMatId);
                this.updateParameter(node, 'seawater_material', newMatId);
                this.updateParameter(node, 'water_material', newMatId);
                this.syncWaterConnection(node.id, newMatId);
            });

            return select;
        }

        if (key === 'seabed_foundation' && (node.type === 'MarineHarbourDomain' || node.type === 'CFDSolver3D')) {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';
            select.style.fontSize = 'var(--font-sm)';

            const defOption = document.createElement('option');
            defOption.value = '';
            defOption.text = '(None / Disconnected)';
            select.appendChild(defOption);

            const state = this.stateManager.getCurrentState();
            const owningModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
            const candidateNodes = owningModel ? owningModel.nodes : (state ? state.nodes : []);
            const matNodes = candidateNodes.filter(n => n.type === 'Material');

            let currentMatId = node.parameters['seabed_foundation'] || '';
            if (!currentMatId && state) {
                const conn = state.connections.find(c => (c.toNode === node.id && (c.toPort === 'seabed' || c.toPort === 'soil')) || (c.fromNode === node.id && (c.fromPort === 'seabed' || c.fromPort === 'soil')));
                if (conn) currentMatId = conn.toNode === node.id ? conn.fromNode : conn.toNode;
            }

            let found = false;
            matNodes.forEach(mat => {
                const option = document.createElement('option');
                option.value = mat.id;
                const matModel = mat.parameters?.material_model || 'Material';
                const preset = mat.parameters?.preset;
                const matSummary = preset === 'Custom' ? `${matModel} (Custom)` : (preset || mat.parameters?.composition || matModel);
                option.text = `${(mat as any).name || mat.parameters?.name || mat.type} [${mat.id.substring(0, 8)}] (${matSummary})`;
                if (mat.id === currentMatId) {
                    option.selected = true;
                    found = true;
                }
                select.appendChild(option);
            });

            if (currentMatId && !found) {
                const fallback = document.createElement('option');
                fallback.value = currentMatId;
                fallback.text = `Seabed Material [${currentMatId.substring(0, 8)}]`;
                fallback.selected = true;
                select.appendChild(fallback);
            }

            select.addEventListener('change', () => {
                const newMatId = select.value;
                this.updateParameter(node, 'seabed_foundation', newMatId);
                this.syncSeabedConnection(node.id, newMatId);
            });

            return select;
        }

        if (key === 'connected_detonators' && ['Charge1D', 'Charge2D', 'Charge3D'].includes(node.type)) {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';
            select.style.fontSize = 'var(--font-sm)';

            const defOption = document.createElement('option');
            defOption.value = '';
            defOption.text = '(None / Disconnected)';
            select.appendChild(defOption);

            const state = this.stateManager.getCurrentState();
            const owningModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
            const candidateNodes = owningModel ? owningModel.nodes : (state ? state.nodes : []);
            const detNodes = candidateNodes.filter(n => node.type === 'Charge3D'
                ? (n.type === 'DetonatorLocation3D' || n.type === 'TriggerLocation3D')
                : (n.type === 'DetonatorLocation' || n.type === 'TriggerLocation'));

            let currentDetId = node.parameters['connected_detonators'] || '';
            if (!currentDetId && state) {
                const conn = state.connections.find(c => c.toNode === node.id && (c.toPort === 'detonator' || c.toPort === 'trigger'));
                if (conn) currentDetId = conn.fromNode;
            }

            let found = false;
            detNodes.forEach(det => {
                const option = document.createElement('option');
                option.value = det.id;
                option.text = `${det.parameters?.name || det.type} [${det.id.substring(0, 8)}]`;
                if (det.id === currentDetId) {
                    option.selected = true;
                    found = true;
                }
                select.appendChild(option);
            });

            if (currentDetId && !found) {
                const fallback = document.createElement('option');
                fallback.value = currentDetId;
                fallback.text = `Detonator [${currentDetId.substring(0, 8)}]`;
                fallback.selected = true;
                select.appendChild(fallback);
            }

            select.addEventListener('change', () => {
                const newDetId = select.value;
                this.updateParameter(node, 'connected_detonators', newDetId);
                this.syncDetonatorConnection(node.id, newDetId);
            });

            return select;
        }

        if (key === 'target_domain' && (node.type === 'MPMObject2D' || node.type === 'MPMObject3D' || node.type === 'FEMObject3D' || node.type === 'FEMBeam3D' || node.type === 'FEMRebar3D' || node.type === 'LSDynaImporter3D')) {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';
            select.style.fontSize = 'var(--font-sm)';

            const defOption = document.createElement('option');
            defOption.value = '';
            defOption.text = '(None / Disconnected)';
            select.appendChild(defOption);

            const state = this.stateManager.getCurrentState();
            const owningModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
            const candidateNodes = owningModel ? owningModel.nodes : (state ? state.nodes : []);
            const is3D = node.type.endsWith('3D');
            const targetDomains = candidateNodes.filter(n => is3D
                ? ['MPMDomain3D', 'MarineHarbourDomain', 'CFDSolver3D'].includes(n.type)
                : ['MPMDomain2D', 'CFDSolver2D'].includes(n.type));

            let currentDomainId = node.parameters['target_domain'] || '';
            if (!currentDomainId && state) {
                const conn = state.connections.find(c => (c.fromNode === node.id && c.toPort === 'in') || (c.toNode === node.id && c.fromPort === 'in'));
                if (conn) currentDomainId = conn.toNode === node.id ? conn.fromNode : conn.toNode;
            }

            let found = false;
            targetDomains.forEach(d => {
                const option = document.createElement('option');
                option.value = d.id;
                option.text = `${(d as any).name || d.parameters?.name || d.type} [${d.id.substring(0, 8)}]`;
                if (d.id === currentDomainId) {
                    option.selected = true;
                    found = true;
                }
                select.appendChild(option);
            });

            if (currentDomainId && !found) {
                const fallback = document.createElement('option');
                fallback.value = currentDomainId;
                fallback.text = `Target Domain [${currentDomainId.substring(0, 8)}]`;
                fallback.selected = true;
                select.appendChild(fallback);
            }

            select.addEventListener('change', () => {
                const newDomainId = select.value;
                this.updateParameter(node, 'target_domain', newDomainId);
                if (state) {
                    state.connections = state.connections.filter(c => !(c.fromNode === node.id && c.toPort === 'in'));
                    if (newDomainId) {
                        state.connections.push({
                            fromNode: node.id,
                            fromPort: 'out',
                            toNode: newDomainId,
                            toPort: 'in'
                        });
                    }
                    if (owningModel) {
                        this.stateManager.setModelStatus(owningModel.id, 'UNINITIALIZED');
                    }
                    this.stateManager.pushState(state);
                }
            });

            return select;
        }

        if (key === 'target_domain' && (node.type === 'Charge3D' || node.type === 'Charge2D' || node.type === 'Charge1D' || node.type === 'DetonatorLocation' || node.type === 'DetonatorLocation3D' || node.type === 'TriggerLocation' || node.type === 'TriggerLocation3D')) {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';
            select.style.fontSize = 'var(--font-sm)';

            const defOption = document.createElement('option');
            defOption.value = '';
            defOption.text = '(None / Disconnected)';
            select.appendChild(defOption);

            const state = this.stateManager.getCurrentState();
            const owningModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
            const candidateNodes = owningModel ? owningModel.nodes : (state ? state.nodes : []);
            const isCharge = node.type.startsWith('Charge');
            const targetSolvers = candidateNodes.filter(n => {
                if (node.type === 'Charge1D') return n.type === 'CFDSolver';
                if (node.type === 'Charge2D') return n.type === 'CFDSolver2D';
                if (node.type === 'Charge3D') return n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain';
                const is3D = node.type === 'DetonatorLocation3D' || node.type === 'TriggerLocation3D';
                return is3D ? ['MPMDomain3D', 'CFDSolver3D', 'MarineHarbourDomain'].includes(n.type) : ['MPMDomain2D', 'CFDSolver2D', 'CFDSolver'].includes(n.type);
            });

            const targetPort = isCharge ? 'charge' : 'detonator';
            let currentSolverId = node.parameters['target_domain'] || '';
            if (!currentSolverId && state) {
                const conn = state.connections.find(c => c.fromNode === node.id && (c.toPort === targetPort || c.toPort === 'explosive' || c.toPort === 'trigger' || c.toPort === 'detonator'));
                if (conn) currentSolverId = conn.toNode;
            }

            let found = false;
            targetSolvers.forEach(solver => {
                const option = document.createElement('option');
                option.value = solver.id;
                option.text = `${solver.parameters?.name || solver.type} [${solver.id.substring(0, 8)}]`;
                if (solver.id === currentSolverId) {
                    option.selected = true;
                    found = true;
                }
                select.appendChild(option);
            });

            if (currentSolverId && !found) {
                const fallback = document.createElement('option');
                fallback.value = currentSolverId;
                fallback.text = `Target Domain [${currentSolverId.substring(0, 8)}]`;
                fallback.selected = true;
                select.appendChild(fallback);
            }

            select.addEventListener('change', () => {
                const newSolverId = select.value;
                this.updateParameter(node, 'target_domain', newSolverId);
                if (state) {
                    state.connections = state.connections.filter(c => !(c.fromNode === node.id && (c.toPort === 'trigger' || c.toPort === 'detonator' || c.toPort === 'charge' || c.toPort === 'explosive')));
                    if (newSolverId) {
                        state.connections.push({
                            fromNode: node.id,
                            fromPort: targetPort,
                            toNode: newSolverId,
                            toPort: targetPort
                        });
                    }
                    if (owningModel) {
                        this.stateManager.setModelStatus(owningModel.id, 'UNINITIALIZED');
                    }
                    this.stateManager.pushState(state);
                }
            });

            return select;
        }

        if (key === 'ambient_air_material' && ['CFDSolver', 'CFDSolver2D', 'CFDSolver3D', 'MarineHarbourDomain'].includes(node.type)) {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';
            select.style.fontSize = 'var(--font-sm)';

            const defOption = document.createElement('option');
            defOption.value = '';
            defOption.text = '(None / Disconnected)';
            select.appendChild(defOption);

            const state = this.stateManager.getCurrentState();
            const owningModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
            const candidateNodes = owningModel ? owningModel.nodes : (state ? state.nodes : []);
            const matNodes = candidateNodes.filter(n => n.type === 'Material');

            let currentMatId = node.parameters['ambient_air_material'] || '';
            if (!currentMatId && state) {
                const conn = state.connections.find(c => (c.toNode === node.id && c.toPort === 'air') || (c.fromNode === node.id && c.fromPort === 'air'));
                if (conn) currentMatId = conn.toNode === node.id ? conn.fromNode : conn.toNode;
            }

            let found = false;
            matNodes.forEach(mat => {
                const option = document.createElement('option');
                option.value = mat.id;
                const matModel = mat.parameters?.material_model || 'Material';
                const preset = mat.parameters?.preset;
                const matSummary = preset === 'Custom' ? `${matModel} (Custom)` : (preset || mat.parameters?.composition || matModel);
                option.text = `${(mat as any).name || mat.parameters?.name || mat.type} [${mat.id.substring(0, 8)}] (${matSummary})`;
                if (mat.id === currentMatId) {
                    option.selected = true;
                    found = true;
                }
                select.appendChild(option);
            });

            if (currentMatId && !found) {
                const fallback = document.createElement('option');
                fallback.value = currentMatId;
                fallback.text = `Air Material [${currentMatId.substring(0, 8)}]`;
                fallback.selected = true;
                select.appendChild(fallback);
            }

            select.addEventListener('change', () => {
                const newMatId = select.value;
                this.updateParameter(node, 'ambient_air_material', newMatId);
                if (state) {
                    state.connections = state.connections.filter(c => !(c.toNode === node.id && c.toPort === 'air'));
                    if (newMatId) {
                        state.connections.push({
                            fromNode: newMatId,
                            fromPort: 'air',
                            toNode: node.id,
                            toPort: 'air'
                        });
                    }
                    if (owningModel) {
                        this.stateManager.setModelStatus(owningModel.id, 'UNINITIALIZED');
                    }
                    this.stateManager.pushState(state);
                }
            });

            return select;
        }

        if (key === 'explosive_charge' && ['CFDSolver', 'CFDSolver2D', 'CFDSolver3D', 'MarineHarbourDomain'].includes(node.type)) {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';
            select.style.fontSize = 'var(--font-sm)';

            const defOption = document.createElement('option');
            defOption.value = '';
            defOption.text = '(None / Disconnected)';
            select.appendChild(defOption);

            const state = this.stateManager.getCurrentState();
            const owningModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
            const candidateNodes = owningModel ? owningModel.nodes : (state ? state.nodes : []);
            const chargeNodes = candidateNodes.filter(n => {
                if (node.type === 'CFDSolver') return n.type === 'Charge1D';
                if (node.type === 'CFDSolver2D') return n.type === 'Charge2D';
                if (node.type === 'CFDSolver3D' || node.type === 'MarineHarbourDomain') return n.type === 'Charge3D';
                return ['Charge1D', 'Charge2D', 'Charge3D'].includes(n.type);
            });

            let currentChgId = node.parameters['explosive_charge'] || '';
            if (!currentChgId && state) {
                const conn = state.connections.find(c => c.toNode === node.id && (c.toPort === 'charge' || c.toPort === 'explosive'));
                if (conn) currentChgId = conn.fromNode;
            }

            let found = false;
            chargeNodes.forEach(chg => {
                const option = document.createElement('option');
                option.value = chg.id;
                option.text = `${chg.parameters?.name || chg.type} [${chg.id.substring(0, 8)}] (${chg.parameters?.charge_mass ?? '0.85'} kg)`;
                if (chg.id === currentChgId) {
                    option.selected = true;
                    found = true;
                }
                select.appendChild(option);
            });

            if (currentChgId && !found) {
                const fallback = document.createElement('option');
                fallback.value = currentChgId;
                fallback.text = `Explosive Charge [${currentChgId.substring(0, 8)}]`;
                fallback.selected = true;
                select.appendChild(fallback);
            }

            select.addEventListener('change', () => {
                const newChgId = select.value;
                this.updateParameter(node, 'explosive_charge', newChgId);
                if (state) {
                    state.connections = state.connections.filter(c => !(c.toNode === node.id && (c.toPort === 'charge' || c.toPort === 'explosive')));
                    if (newChgId) {
                        state.connections.push({
                            fromNode: newChgId,
                            fromPort: 'charge',
                            toNode: node.id,
                            toPort: 'charge'
                        });
                    }
                    if (owningModel) {
                        this.stateManager.setModelStatus(owningModel.id, 'UNINITIALIZED');
                    }
                    this.stateManager.pushState(state);
                }
            });

            return select;
        }

        if (key === 'ambient_air_target' && node.type === 'Material') {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';
            select.style.fontSize = 'var(--font-sm)';

            const defOption = document.createElement('option');
            defOption.value = '';
            defOption.text = '(None / Disconnected)';
            select.appendChild(defOption);

            const state = this.stateManager.getCurrentState();
            const owningModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
            const candidateNodes = owningModel ? owningModel.nodes : (state ? state.nodes : []);
            const cfdSolvers = candidateNodes.filter(n => ['CFDSolver', 'CFDSolver2D', 'CFDSolver3D', 'MarineHarbourDomain'].includes(n.type));

            let currentSolverId = node.parameters['ambient_air_target'] || '';
            if (!currentSolverId && state) {
                const conn = state.connections.find(c => (c.fromNode === node.id && c.toPort === 'air') || (c.toNode === node.id && c.fromPort === 'air'));
                if (conn) currentSolverId = conn.toNode === node.id ? conn.fromNode : conn.toNode;
            }

            let found = false;
            cfdSolvers.forEach(solver => {
                const option = document.createElement('option');
                option.value = solver.id;
                option.text = `${solver.parameters?.name || solver.type} [${solver.id.substring(0, 8)}]`;
                if (solver.id === currentSolverId) {
                    option.selected = true;
                    found = true;
                }
                select.appendChild(option);
            });

            if (currentSolverId && !found) {
                const fallback = document.createElement('option');
                fallback.value = currentSolverId;
                fallback.text = `Target Domain [${currentSolverId.substring(0, 8)}]`;
                fallback.selected = true;
                select.appendChild(fallback);
            }

            select.addEventListener('change', () => {
                const newSolverId = select.value;
                this.updateParameter(node, 'ambient_air_target', newSolverId);
                if (state) {
                    state.connections = state.connections.filter(c => !((c.fromNode === node.id || c.toNode === node.id) && (c.toPort === 'air' || c.fromPort === 'air')));
                    if (newSolverId) {
                        state.connections = state.connections.filter(c => !(c.toNode === newSolverId && c.toPort === 'air'));
                        state.connections.push({
                            fromNode: node.id,
                            fromPort: 'air',
                            toNode: newSolverId,
                            toPort: 'air'
                        });
                    }
                    if (owningModel) {
                        this.stateManager.setModelStatus(owningModel.id, 'UNINITIALIZED');
                    }
                    this.stateManager.pushState(state);
                }
            });

            return select;
        }

        if (key === 'water_target' && node.type === 'Material') {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';
            select.style.fontSize = 'var(--font-sm)';

            const defOption = document.createElement('option');
            defOption.value = '';
            defOption.text = '(None / Disconnected)';
            select.appendChild(defOption);

            const state = this.stateManager.getCurrentState();
            const owningModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
            const candidateNodes = owningModel ? owningModel.nodes : (state ? state.nodes : []);
            const undexSolvers = candidateNodes.filter(n => ['MarineHarbourDomain', 'CFDSolver3D'].includes(n.type));

            let currentSolverId = node.parameters['water_target'] || '';
            if (!currentSolverId && state) {
                const conn = state.connections.find(c => 
                    (c.fromNode === node.id && (c.toPort === 'water' || c.toPort === 'seawater')) ||
                    (c.toNode === node.id && (c.fromPort === 'water' || c.fromPort === 'seawater'))
                );
                if (conn) currentSolverId = conn.fromNode === node.id ? conn.toNode : conn.fromNode;
            }

            let found = false;
            undexSolvers.forEach(solver => {
                const option = document.createElement('option');
                option.value = solver.id;
                option.text = `${solver.parameters?.name || solver.type} [${solver.id.substring(0, 8)}]`;
                if (solver.id === currentSolverId) {
                    option.selected = true;
                    found = true;
                }
                select.appendChild(option);
            });

            if (currentSolverId && !found) {
                const fallback = document.createElement('option');
                fallback.value = currentSolverId;
                fallback.text = `Target Solver [${currentSolverId.substring(0, 8)}]`;
                fallback.selected = true;
                select.appendChild(fallback);
            }

            select.addEventListener('change', () => {
                const newSolverId = select.value;
                this.updateParameter(node, 'water_target', newSolverId);
                this.syncWaterTargetConnection(node.id, newSolverId);
            });

            return select;
        }

        if (key === 'source_model_id' && ['RemapNode', 'Remap1DTo2DNode', 'Remap1DTo3DNode', 'Remap2DTo3DNode', 'Remap3DTo3DNode'].includes(node.type)) {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';
            select.style.fontSize = 'var(--font-sm)';

            const autoOption = document.createElement('option');
            autoOption.value = '';
            autoOption.text = '⚡ Auto-Detect Upstream Run';
            select.appendChild(autoOption);

            const allModels = this.stateManager.getAllModels();
            const owningModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
            const is3Dto3D = node.type === 'Remap3DTo3DNode';
            const is2Dto3D = node.type === 'Remap2DTo3DNode';
            const sourceDim = is3Dto3D ? '3D' : (is2Dto3D ? '2D' : '1D');

            const candidateModels = allModels.filter(m => {
                return m.nodes.some(n => is3Dto3D ? (n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain') : (is2Dto3D ? n.type === 'CFDSolver2D' : n.type === 'CFDSolver'));
            });

            const currentModelId = node.parameters?.source_model_id || '';

            let foundModel = false;
            candidateModels.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.text = `[${sourceDim}] ${m.name || m.id}${owningModel && m.id === owningModel.id ? ' (Same Model)' : ''}`;
                if (m.id === currentModelId) {
                    opt.selected = true;
                    foundModel = true;
                }
                select.appendChild(opt);
            });

            if (currentModelId && !foundModel) {
                const fallbackOpt = document.createElement('option');
                fallbackOpt.value = currentModelId;
                fallbackOpt.text = `[${sourceDim}] Model [${currentModelId.substring(0, 8)}]`;
                fallbackOpt.selected = true;
                select.appendChild(fallbackOpt);
            }

            select.addEventListener('change', () => {
                const newModelId = select.value;
                this.updateParameter(node, 'source_model_id', newModelId);
                const ws = this.stateManager.getActiveWorkspace();
                if (ws && ws.connections) {
                    ws.connections = ws.connections.filter(c => c.toNode !== node.id);
                    if (newModelId) {
                        const srcM = allModels.find(m => m.id === newModelId);
                        const srcSolver = srcM?.nodes.find(n => is3Dto3D ? (n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain') : (is2Dto3D ? n.type === 'CFDSolver2D' : n.type === 'CFDSolver'));
                        if (srcSolver) {
                            ws.connections.push({
                                fromNode: srcSolver.id,
                                fromPort: 'telemetry',
                                toNode: node.id,
                                toPort: 'in'
                            });
                        }
                    }
                }
                if (newModelId && owningModel) {
                    const remapOutConn = owningModel.connections.find(c => c.fromNode === node.id && (c.toPort === 'remap' || c.toPort === 'in'));
                    const tSolverId = node.parameters?.target_solver || remapOutConn?.toNode;
                    const tSolver = tSolverId ? owningModel.nodes.find(n => n.id === tSolverId) : owningModel.nodes.find(n => n.type === 'CFDSolver2D' || n.type === 'CFDSolver3D');
                    if (tSolver && tSolver.parameters && (tSolver.type === 'CFDSolver2D' || tSolver.type === 'CFDSolver3D')) {
                        tSolver.parameters['init_mode'] = is3Dto3D ? 'From3D' : (is2Dto3D ? 'From2D' : 'From1D');
                    }
                }
                if (owningModel) {
                    this.stateManager.setModelStatus(owningModel.id, 'UNINITIALIZED');
                }
                const state = this.stateManager.getCurrentState();
                if (state) {
                    this.stateManager.pushState(state);
                }
                this.stateManager.notifyChange();
            });
            return select;
        }

        if (key === 'target_solver' && ['RemapNode', 'Remap1DTo2DNode', 'Remap1DTo3DNode', 'Remap2DTo3DNode', 'Remap3DTo3DNode'].includes(node.type)) {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';
            select.style.fontSize = 'var(--font-sm)';

            const defOption = document.createElement('option');
            defOption.value = '';
            defOption.text = '(None / Disconnected)';
            select.appendChild(defOption);

            const state = this.stateManager.getCurrentState();
            const owningModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
            const candidateNodes = owningModel ? owningModel.nodes : (state ? state.nodes : []);
            const is3D = node.type === 'Remap1DTo3DNode' || node.type === 'Remap2DTo3DNode' || node.type === 'Remap3DTo3DNode';
            const targetSolvers = candidateNodes.filter(n => is3D ? (n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain') : (n.type === 'CFDSolver2D' || n.type === 'FSICoupler2D' || n.type === 'MPMDomain2D'));

            let currentSolverId = node.parameters?.target_solver || '';
            if (!currentSolverId && state) {
                const conn = state.connections.find(c => (c.fromNode === node.id && (c.toPort === 'remap' || c.toPort === 'in')) || (c.toNode === node.id && c.toPort === 'remap'));
                if (conn) currentSolverId = conn.toNode === node.id ? conn.fromNode : conn.toNode;
            }

            let foundTarget = false;
            targetSolvers.forEach(solver => {
                const opt = document.createElement('option');
                opt.value = solver.id;
                opt.text = `${solver.parameters?.name || solver.type} [${solver.id.substring(0, 8)}]`;
                if (solver.id === currentSolverId) {
                    opt.selected = true;
                    foundTarget = true;
                }
                select.appendChild(opt);
            });

            if (currentSolverId && !foundTarget) {
                const fallbackOpt = document.createElement('option');
                fallbackOpt.value = currentSolverId;
                fallbackOpt.text = `Target Solver [${currentSolverId.substring(0, 8)}]`;
                fallbackOpt.selected = true;
                select.appendChild(fallbackOpt);
            }

            select.addEventListener('change', () => {
                const newSolverId = select.value;
                this.updateParameter(node, 'target_solver', newSolverId);
                if (state) {
                    state.connections = state.connections.filter(c => !(c.fromNode === node.id && (c.toPort === 'remap' || c.toPort === 'in')));
                    if (newSolverId) {
                        state.connections.push({
                            fromNode: node.id,
                            fromPort: 'remap',
                            toNode: newSolverId,
                            toPort: 'remap'
                        });
                        const tSolver = candidateNodes.find(s => s.id === newSolverId);
                        if (tSolver && tSolver.parameters && (tSolver.type === 'CFDSolver2D' || tSolver.type === 'CFDSolver3D')) {
                            tSolver.parameters['init_mode'] = node.type === 'Remap3DTo3DNode' ? 'From3D' : (node.type === 'Remap2DTo3DNode' ? 'From2D' : 'From1D');
                        }
                    }
                    if (owningModel) {
                        this.stateManager.setModelStatus(owningModel.id, 'UNINITIALIZED');
                    }
                    this.stateManager.pushState(state);
                }
                this.stateManager.notifyChange();
            });

            return select;
        }

        const allowedOptions = dropdowns[key] || (PARAMETER_DEFINITIONS[key]?.allowedValues as string[] | undefined);
        if (allowedOptions) {
            const select = document.createElement('select');
            select.style.width = '100%';
            select.style.background = '#252526';
            select.style.color = '#ccc';
            select.style.border = '1px solid #444';
            select.style.padding = '4px';
            select.style.fontSize = 'var(--font-sm)';

            const strVal = String(value ?? '');
            const normVal = strVal.toLowerCase().replace(/[\s_\-]/g, '');
            let selectedMatched = false;

            if (key === 'preset') {
                const matType = node.parameters['material_type'];
                let modelName = node.parameters['material_model'];
                if (matType === 'JWL Charge') {
                    modelName = 'JWL Detonation Gas';
                } else if (matType === 'Ideal Gas Charge') {
                    modelName = 'Ideal Gas Charge';
                } else if (matType === 'Air') {
                    modelName = 'Ideal Gas';
                } else if (!modelName) {
                    modelName = 'Hypoelastic';
                }
                const categorizedGroups = getCategorizedPresetsForModel(modelName);
                categorizedGroups.forEach(group => {
                    const optgroup = document.createElement('optgroup');
                    optgroup.label = group.category;
                    group.presets.forEach(opt => {
                        const option = document.createElement('option');
                        option.value = opt;
                        option.text = opt;
                        const normOpt = opt.toLowerCase().replace(/[\s_\-]/g, '');
                        if (strVal && (normOpt === normVal || opt.toLowerCase() === strVal.toLowerCase() || opt === strVal)) {
                            option.selected = true;
                            selectedMatched = true;
                        }
                        optgroup.appendChild(option);
                    });
                    select.appendChild(optgroup);
                });
            } else {
                allowedOptions.forEach(opt => {
                    const option = document.createElement('option');
                    option.value = opt;
                    let text = opt;
                    if (key === 'font_size') {
                        text = `${opt}px`;
                    } else if (key === 'device') {
                        if (opt === 'cpu') text = 'CPU';
                        else if (opt === 'cuda') text = 'CUDA GPU';
                    }
                    option.text = text;
                    const normOpt = opt.toLowerCase().replace(/[\s_\-]/g, '');
                    if (strVal && (
                        normOpt === normVal ||
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

            if (!selectedMatched && strVal !== '') {
                const customOpt = document.createElement('option');
                customOpt.value = strVal;
                customOpt.text = strVal;
                customOpt.selected = true;
                select.insertBefore(customOpt, select.firstChild);
            } else if (!selectedMatched && select.options.length > 0) {
                select.options[0].selected = true;
            }

            if (select.options.length === 0) {
                const fallbackOpt = document.createElement('option');
                fallbackOpt.value = strVal || '';
                fallbackOpt.text = strVal || '(None)';
                fallbackOpt.selected = true;
                select.appendChild(fallbackOpt);
            }

            select.addEventListener('change', () => {
                let val: any = select.value;
                if (key === 'space_time_scheme') {
                    if (node.type === 'MPMDomain2D' || node.type === 'MPMDomain3D') {
                        this.updateParameter(node, key, val);
                    } else {
                        let s_order = 2;
                        let t_order = 2;
                        if (val === 'ADER-3 (3rd-Order Space/Time)') {
                            s_order = 3;
                            t_order = 3;
                        } else {
                            s_order = 2;
                            t_order = 2;
                        }
                        
                        this.stateManager.updateNodeParameters(node.id, {
                            space_time_scheme: val,
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

        // File & Directory path inputs with host file browser dialog
        const isFileOrDir = key === 'stl_file' || key === 'k_file' || key === 'output_dir' || key === 'vtk_dir' || key === 'external_file_path' || key === 'file_path';
        if (isFileOrDir) {
            return this.createFileInputWidget(node, key, value);
        }

        if (typeof value === 'boolean' || key === 'track_mpm_velocity') {
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = Boolean(value);
            checkbox.style.margin = '4px 0';
            checkbox.addEventListener('change', () => {
                this.updateParameter(node, key, checkbox.checked);
            });
            return checkbox;
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

    private createFileInputWidget(node: Node, key: string, value: any): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.gap = '6px';
        wrapper.style.width = '100%';

        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.value = String(value ?? '');
        textInput.style.flex = '1';
        textInput.style.minWidth = '0';
        textInput.style.background = '#252526';
        textInput.style.color = '#ccc';
        textInput.style.border = '1px solid #444';
        textInput.style.padding = '4px';
        textInput.style.fontSize = 'var(--font-sm)';

        textInput.addEventListener('change', () => {
            this.updateParameter(node, key, textInput.value);
        });

        const isStl = key === 'stl_file';
        const isK = key === 'k_file';
        const isDir = key === 'output_dir' || key === 'vtk_dir';
        const isExternal = key === 'external_file_path' || key === 'file_path';

        const openBrowserAt = (initialOverride?: string) => {
            const owningModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
            const rawCurrent = String(node.parameters[key] || '');
            const startPath = initialOverride !== undefined
                ? initialOverride
                : (rawCurrent ? resolveResourcePath(rawCurrent, owningModel?.filename) : '');

            let title = 'Select File (Host)';
            let mode: 'open' | 'save' = 'open';
            let selectFolderOnly = false;
            let filters: FileFilterPreset[] | undefined = undefined;

            if (isStl) {
                title = 'Select STL 3D Geometry (*.stl)';
                mode = 'open';
                filters = [
                    { label: 'STL 3D Geometry (*.stl)', extensions: ['.stl'] },
                    { label: 'All Files (*.*)', extensions: ['*'] }
                ];
            } else if (isK) {
                title = 'Select LS-DYNA Keyword File (*.k, *.key)';
                mode = 'open';
                filters = [
                    { label: 'LS-DYNA Keyword Files (*.k, *.key, *.dyn)', extensions: ['.k', '.key', '.dyn'] },
                    { label: 'All Files (*.*)', extensions: ['*'] }
                ];
            } else if (isDir) {
                title = 'Select Output Directory (Host)';
                mode = 'save';
                selectFolderOnly = true;
            } else if (isExternal) {
                title = 'Select Data/Sensor File (Host)';
                mode = 'open';
                filters = [
                    { label: 'Data / CSV Files (*.dat, *.csv, *.txt)', extensions: ['.dat', '.csv', '.txt'] },
                    { label: 'All Files (*.*)', extensions: ['*'] }
                ];
            }

            const browser = new HostFileBrowserModal(
                (window as any).networkManager,
                {
                    title,
                    mode,
                    selectFolderOnly,
                    filters,
                    onSelect: (selectedPath: string) => {
                        textInput.value = selectedPath;
                        this.updateParameter(node, key, selectedPath);
                    }
                }
            );
            browser.open(startPath);
        };

        const browseBtn = document.createElement('button');
        browseBtn.type = 'button';
        browseBtn.textContent = 'Browse';
        browseBtn.title = isDir ? 'Browse host output directory' : 'Browse host filesystem';
        browseBtn.style.padding = '4px 8px';
        browseBtn.style.fontSize = '11px';
        browseBtn.style.background = '#333';
        browseBtn.style.color = '#38bdf8';
        browseBtn.style.border = '1px solid #555';
        browseBtn.style.borderRadius = '3px';
        browseBtn.style.cursor = 'pointer';
        browseBtn.style.whiteSpace = 'nowrap';
        browseBtn.style.flexShrink = '0';

        browseBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            openBrowserAt();
        };

        const recentBtn = document.createElement('button');
        recentBtn.type = 'button';
        recentBtn.textContent = '🕒';
        recentBtn.title = isDir ? 'Pick from Recent Folders' : 'Browse from a Recent Folder';
        recentBtn.style.padding = '4px 6px';
        recentBtn.style.fontSize = '11px';
        recentBtn.style.background = '#2a2d2e';
        recentBtn.style.color = '#ccc';
        recentBtn.style.border = '1px solid #555';
        recentBtn.style.borderRadius = '3px';
        recentBtn.style.cursor = 'pointer';
        recentBtn.style.flexShrink = '0';

        recentBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            showRecentFoldersQuickMenu(
                recentBtn,
                (folderPath) => {
                    if (isDir) {
                        textInput.value = folderPath;
                        this.updateParameter(node, key, folderPath);
                    } else {
                        openBrowserAt(folderPath);
                    }
                },
                {
                    title: isDir ? 'Set Output Folder' : 'Browse Recent Folder',
                    onBrowseOther: () => openBrowserAt()
                }
            );
        };

        wrapper.appendChild(textInput);
        wrapper.appendChild(browseBtn);
        wrapper.appendChild(recentBtn);
        return wrapper;
    }

    private updateParameter(node: Node, key: string, value: any): void {
        const updates: Record<string, any> = { [key]: value };

        if (node.type === 'Material' && key === 'composition') {
            const preset = EXPLOSIVE_PRESETS[value];
            if (preset) {
                const matType = node.parameters['material_type'] || 'JWL Charge';
                if (matType === 'Ideal Gas Charge') {
                    updates['ideal_rho_0'] = preset.rho;
                    updates['ideal_e_0'] = preset.detonation_energy;
                    updates['ideal_gamma'] = 1.4;
                } else {
                    Object.assign(updates, preset);
                }
            }
        } else if (node.type === 'Material' && key === 'preset') {
            const presetData = MPM_MATERIAL_PRESETS[value];
            if (presetData) {
                const currentTs = node.parameters['transfer_scheme'];
                Object.assign(updates, presetData);
                if (currentTs !== undefined) {
                    updates['transfer_scheme'] = currentTs;
                } else {
                    updates['transfer_scheme'] = 'Default';
                }
                if (presetData.category === 'Ideal Gas Presets') {
                    updates['material_type'] = 'Air';
                    updates['material_model'] = 'Ideal Gas';
                    if (presetData.atm_pressure !== undefined) {
                        updates['ambient_p'] = presetData.atm_pressure;
                        const t = presetData.atm_temperature || 288.15;
                        const rho = presetData.density ?? (presetData.atm_pressure / (287.058 * t));
                        updates['density'] = rho;
                        updates['ambient_rho'] = rho;
                    }
                } else if (presetData.category === 'JWL Detonation Gas Presets') {
                    updates['material_type'] = 'JWL Charge';
                    updates['material_model'] = 'JWL Detonation Gas';
                    if (presetData.composition) updates['composition'] = presetData.composition;
                } else if (presetData.category === 'Ideal Gas Blast Presets') {
                    updates['material_type'] = 'Ideal Gas Charge';
                    updates['material_model'] = 'Ideal Gas Charge';
                    if (presetData.composition) updates['composition'] = presetData.composition;
                }
            }
        } else if (node.type === 'Material' && key === 'material_model') {
            if (value === 'Ideal Gas') {
                updates['material_model'] = 'Ideal Gas';
                updates['material_type'] = 'Air';
                const defPreset = 'Air (Standard STP, gamma=1.4)';
                updates['preset'] = defPreset;
                const presetData = MPM_MATERIAL_PRESETS[defPreset];
                if (presetData) {
                    Object.assign(updates, presetData);
                    const p = presetData.atm_pressure ?? 101325.0;
                    const t = presetData.atm_temperature || 288.15;
                    const rho = presetData.density ?? (p / (287.058 * t));
                    updates['density'] = rho;
                    updates['ambient_rho'] = rho;
                    updates['ambient_p'] = p;
                }
            } else if (value === 'JWL Detonation Gas') {
                updates['material_model'] = 'JWL Detonation Gas';
                updates['material_type'] = 'JWL Charge';
                updates['composition'] = 'TNT';
                const defPreset = 'TNT (Trinitrotoluene)';
                updates['preset'] = defPreset;
                const presetData = MPM_MATERIAL_PRESETS[defPreset];
                if (presetData) Object.assign(updates, presetData);
            } else if (value === 'Ideal Gas Charge') {
                updates['material_model'] = 'Ideal Gas Charge';
                updates['material_type'] = 'Ideal Gas Charge';
                updates['composition'] = 'TNT';
                const defPreset = 'TNT (Ideal Gas Equivalent)';
                updates['preset'] = defPreset;
                const presetData = MPM_MATERIAL_PRESETS[defPreset];
                if (presetData) Object.assign(updates, presetData);
            } else if (value === 'JWL Programmed Burn') {
                updates['material_model'] = 'JWL Programmed Burn';
                updates['material_type'] = 'JWL Charge';
                const defPreset = getDefaultPresetForModel(value) || 'C-4 (Composition 4) - Programmed Burn';
                updates['preset'] = defPreset;
                const presetData = MPM_MATERIAL_PRESETS[defPreset];
                if (presetData) {
                    Object.assign(updates, presetData);
                    if (presetData.provenance) updates['provenance'] = presetData.provenance;
                    if (presetData.reference) updates['reference'] = presetData.reference;
                    if (presetData.test_method) updates['test_method'] = presetData.test_method;
                    if (presetData.solid_model) updates['solid_model'] = presetData.solid_model;
                    if (presetData.burn_model) updates['burn_model'] = presetData.burn_model;
                    if (presetData.product_model) updates['product_model'] = presetData.product_model;
                }
            } else if (value === 'Lee-Tarver Ignition & Growth') {
                updates['material_model'] = 'Lee-Tarver Ignition & Growth';
                updates['material_type'] = 'JWL Charge';
                const defPreset = getDefaultPresetForModel(value) || 'LX-17 (Lee-Tarver Calibrated)';
                updates['preset'] = defPreset;
                const presetData = MPM_MATERIAL_PRESETS[defPreset];
                if (presetData) {
                    Object.assign(updates, presetData);
                    if (presetData.provenance) updates['provenance'] = presetData.provenance;
                    if (presetData.reference) updates['reference'] = presetData.reference;
                    if (presetData.test_method) updates['test_method'] = presetData.test_method;
                    if (presetData.solid_model) updates['solid_model'] = presetData.solid_model;
                    if (presetData.burn_model) updates['burn_model'] = presetData.burn_model;
                    if (presetData.product_model) updates['product_model'] = presetData.product_model;
                }
            } else {
                delete updates['material_type'];
                delete updates['composition'];
                const defPreset = getDefaultPresetForModel(value);
                if (defPreset) {
                    updates['preset'] = defPreset;
                    const presetData = MPM_MATERIAL_PRESETS[defPreset];
                    if (presetData) {
                        Object.assign(updates, presetData);
                        if (presetData.provenance) updates['provenance'] = presetData.provenance;
                        if (presetData.reference) updates['reference'] = presetData.reference;
                        if (presetData.test_method) updates['test_method'] = presetData.test_method;
                        if (presetData.solid_model) updates['solid_model'] = presetData.solid_model;
                        if (presetData.burn_model) updates['burn_model'] = presetData.burn_model;
                        if (presetData.product_model) updates['product_model'] = presetData.product_model;
                    }
                }
            }
        } else if (node.type === 'Material' && (key === 'atm_pressure' || key === 'atm_temperature')) {
            const p = Number(key === 'atm_pressure' ? value : (node.parameters['atm_pressure'] ?? 101325.0));
            const t = Number(key === 'atm_temperature' ? value : (node.parameters['atm_temperature'] ?? 288.15));
            const rho = p / (287.058 * t);
            updates['density'] = rho;
            updates['ambient_rho'] = rho;
            updates['ambient_p'] = p;
            updates['preset'] = 'Custom';
        } else if (node.type === 'Material' && key === 'density' && node.parameters['material_model'] === 'Ideal Gas') {
            updates['ambient_rho'] = Number(value);
            updates['preset'] = 'Custom';
        } else if (node.type === 'FEMObject3D' && (key === 'shape_type' || key === 'mesh_source')) {
            if (key === 'shape_type') {
                updates['mesh_source'] = value === 'Cylinder' ? 'Cylinder Generator' : (value === 'STL' ? 'STL File' : (value === 'Plate' ? 'Plate Generator' : (value === 'LS-DYNA File' ? 'LS-DYNA Keyword File' : 'Box Generator')));
                if (value === 'STL') updates['element_topology'] = 'Tet4_ANP';
            } else if (key === 'mesh_source') {
                updates['shape_type'] = value === 'Cylinder Generator' ? 'Cylinder' : (value === 'STL File' ? 'STL' : (value === 'Plate Generator' ? 'Plate' : (value === 'LS-DYNA Keyword File' ? 'LS-DYNA File' : 'Box')));
                if (value === 'STL File') updates['element_topology'] = 'Tet4_ANP';
            }
        } else if (node.type === 'Material' && ['rho', 'detonation_energy', 'det_vel', 'jwl_A', 'jwl_B', 'jwl_R1', 'jwl_R2', 'jwl_omega', 'ideal_rho_0', 'ideal_e_0', 'ideal_gamma', 'atm_pressure', 'atm_temperature', 'initial_temperature', 'gamma', 'density', 'youngs_modulus', 'poissons_ratio', 'yield_stress', 'hardening_modulus'].includes(key)) {
            updates['preset'] = 'Custom';
        } else if (key === 'stl_file' || key === 'k_file' || key === 'output_dir' || key === 'vtk_dir' || key === 'external_file_path' || key === 'file_path') {
            const owningModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
            const rawStr = String(value || '').trim();
            if (rawStr) {
                const isDirKey = key === 'output_dir' || key === 'vtk_dir';
                const resolvedPath = resolveResourcePath(rawStr, owningModel?.filename);
                if (resolvedPath.startsWith('/') || resolvedPath.startsWith('~') || /^[A-Za-z]:[\\/]/.test(resolvedPath)) {
                    recordRecentFolder(resolvedPath, isDirKey);
                }
                if (key === 'stl_file') {
                    updates['geometry_hash'] = 'stl_' + Math.floor(Math.random() * 1000000).toString(36);
                    (this.stateManager as any).invalidateSTLGeometry?.(node.id);
                    const net = (window as any).networkManager;
                    if (net && net.isConnected()) {
                        net.send({ command: 'LOAD_STL_GEOMETRY', filePath: resolvedPath, modelId: owningModel?.id || 'default' });
                    }
                } else if (key === 'k_file') {
                    updates['geometry_hash'] = 'k_' + Math.floor(Math.random() * 1000000).toString(36);
                }
            } else if (key === 'stl_file') {
                updates['geometry_hash'] = 'stl_' + Math.floor(Math.random() * 1000000).toString(36);
                (this.stateManager as any).invalidateSTLGeometry?.(node.id);
            } else if (key === 'k_file') {
                updates['geometry_hash'] = 'k_' + Math.floor(Math.random() * 1000000).toString(36);
            }
        }

        if (key === 'water_discretization_mode') {
            if (updates[key] === 'Pure FV') updates[key] = 'Pure_FV';
            else if (updates[key] === 'Spherical MPM Sleeve') updates[key] = 'Spherical_MPM_Sleeve';
            else if (updates[key] === 'Full Column MPM Cylinder') updates[key] = 'Full_Column_MPM_Cylinder';
        } else if (key === 'seabed_mesh_type') {
            if (updates[key] === 'Pure FV') updates[key] = 'Pure_FV';
            else if (updates[key] === 'Pure Hex8 FEM') updates[key] = 'Pure_Hex8_FEM';
            else if (updates[key] === 'Hybrid MPM Crater FEM Far-Field') updates[key] = 'Hybrid_MPM_Crater_FEM_FarField';
            else if (updates[key] === 'Full Domain MPM') updates[key] = 'Full_Domain_MPM';
            else if (updates[key] === 'Local Crater MPM') updates[key] = 'Local_Crater_MPM';
            else if (updates[key] === 'Pure MPM') updates[key] = 'Pure_MPM';
        }

        const isDynamicCfl = (node.type === 'CFDSolver3D' || node.type === 'MarineHarbourDomain' || node.type === 'CFDSolver2D' || node.type === 'CFDSolver' || node.type === 'MPMDomain2D' || node.type === 'MPMDomain3D' || node.type === 'FEMDomain3D' || node.type === 'FSICoupler2D' || node.type === 'FSICoupler3D' || node.type === 'FEMFSICoupler3D') && key === 'cfl';
        const isDynamicEndtime = (node.type === 'CFDSolver3D' || node.type === 'MarineHarbourDomain' || node.type === 'CFDSolver2D' || node.type === 'CFDSolver' || node.type === 'MPMDomain2D' || node.type === 'MPMDomain3D' || node.type === 'FEMDomain3D' || node.type === 'FSICoupler2D' || node.type === 'FSICoupler3D' || node.type === 'FEMFSICoupler3D') && key === 'endtime';

        if (NON_PHYSICAL_NODE_TYPES.has(node.type) || DISPLAY_ONLY_KEYS.has(key) || isDynamicCfl || isDynamicEndtime) {
            this.stateManager.updateNodeParametersInPlace(node.id, updates);
        } else {
            this.stateManager.updateNodeParameters(node.id, updates);
            const owningModel = this.stateManager.getModelForNode(node.id) || this.stateManager.getActiveModel();
            if (owningModel && (key === 'water_discretization_mode' || key === 'seabed_mesh_type')) {
                this.stateManager.setModelStatus(owningModel.id, 'UNINITIALIZED');
            }
        }

        if (isDynamicCfl || isDynamicEndtime) {
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
                let scope = "1d";
                if (node.type === 'CFDSolver3D' || node.type === 'MarineHarbourDomain' || node.type === 'MPMDomain3D' || node.type === 'FEMDomain3D' || node.type === 'FSICoupler3D' || node.type === 'FEMFSICoupler3D') scope = "3d";
                else if (node.type === 'CFDSolver2D' || node.type === 'MPMDomain2D' || node.type === 'FSICoupler2D') scope = "2d";
                if (isDynamicCfl) {
                    net.send({
                        command: "UPDATE_CFL",
                        modelId: targetModelId,
                        cfl: Number(value),
                        scope: scope
                    });
                } else {
                    net.send({
                        command: "UPDATE_ENDTIME",
                        modelId: targetModelId,
                        endtime: Number(value),
                        scope: scope
                    });
                }
            }
        }
        this.render();
    }

    private syncMaterialConnection(nodeId: string, matId: string): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        state.connections = state.connections.filter(c => 
            !(c.toNode === nodeId && c.toPort === 'material') &&
            !(c.fromNode === nodeId && c.fromPort === 'material')
        );

        if (matId) {
            const matNode = state.nodes.find(n => n.id === matId);
            if (matNode) {
                state.connections.push({
                    fromNode: matId,
                    fromPort: 'out',
                    toNode: nodeId,
                    toPort: 'material'
                });
            }
        }

        const targetNodeInState = state.nodes.find(n => n.id === nodeId);
        if (targetNodeInState) {
            if (!targetNodeInState.parameters) targetNodeInState.parameters = {};
            targetNodeInState.parameters['material'] = matId;
        }

        const targetModel = this.stateManager.getModelForNode(nodeId) || this.stateManager.getActiveModel();
        if (targetModel) {
            const modelNode = targetModel.nodes.find(n => n.id === nodeId);
            if (modelNode) {
                if (!modelNode.parameters) modelNode.parameters = {};
                modelNode.parameters['material'] = matId;
            }
            this.stateManager.setModelStatus(targetModel.id, 'UNINITIALIZED');
        }
        this.stateManager.updateNodeParametersInPlace(nodeId, { material: matId });
        this.stateManager.pushState(state);
    }

    private syncWaterConnection(solverId: string, waterId: string): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        state.connections = state.connections.filter(c => 
            !(c.toNode === solverId && (c.toPort === 'water' || c.toPort === 'seawater')) &&
            !(c.fromNode === solverId && (c.fromPort === 'water' || c.fromPort === 'seawater'))
        );

        if (waterId) {
            state.connections.push({
                fromNode: waterId,
                fromPort: 'out',
                toNode: solverId,
                toPort: 'water'
            });
        }

        const solverNode = state.nodes.find(n => n.id === solverId);
        if (solverNode) {
            solverNode.parameters['seawater_material'] = waterId;
        }

        const targetModel = this.stateManager.getModelForNode(solverId) || this.stateManager.getActiveModel();
        if (targetModel) {
            this.stateManager.setModelStatus(targetModel.id, 'UNINITIALIZED');
            this.stateManager.healModelGraph(targetModel);
        }
        this.stateManager.pushState(state);
    }

    private syncSeabedConnection(solverId: string, seabedId: string): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        state.connections = state.connections.filter(c => 
            !(c.toNode === solverId && c.toPort === 'seabed') &&
            !(c.fromNode === solverId && c.fromPort === 'seabed')
        );

        if (seabedId) {
            state.connections.push({
                fromNode: seabedId,
                fromPort: 'out',
                toNode: solverId,
                toPort: 'seabed'
            });
        }

        const solverNode = state.nodes.find(n => n.id === solverId);
        if (solverNode) {
            solverNode.parameters['seabed_foundation'] = seabedId;
        }

        const targetModel = this.stateManager.getModelForNode(solverId) || this.stateManager.getActiveModel();
        if (targetModel) {
            this.stateManager.setModelStatus(targetModel.id, 'UNINITIALIZED');
            this.stateManager.healModelGraph(targetModel);
        }
        this.stateManager.pushState(state);
    }

    private syncDetonatorConnection(chargeId: string, detId: string): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        state.connections = state.connections.filter(c => 
            !(c.toNode === chargeId && (c.toPort === 'detonator' || c.toPort === 'trigger'))
        );

        if (detId) {
            state.connections.push({
                fromNode: detId,
                fromPort: 'detonator',
                toNode: chargeId,
                toPort: 'detonator'
            });
        }

        const targetModel = this.stateManager.getModelForNode(chargeId) || this.stateManager.getActiveModel();
        if (targetModel) {
            this.stateManager.setModelStatus(targetModel.id, 'UNINITIALIZED');
        }
        this.stateManager.pushState(state);
    }

    private syncWaterTargetConnection(matId: string, solverId: string): void {
        const state = this.stateManager.getCurrentState();
        if (!state) return;

        state.connections = state.connections.filter(c => 
            !(c.fromNode === matId && (c.toPort === 'water' || c.toPort === 'seawater')) &&
            !(c.toNode === matId && (c.fromPort === 'water' || c.fromPort === 'seawater'))
        );

        if (solverId) {
            state.connections = state.connections.filter(c => !(c.toNode === solverId && (c.toPort === 'water' || c.toPort === 'seawater')));
            state.connections.push({
                fromNode: matId,
                fromPort: 'out',
                toNode: solverId,
                toPort: 'water'
            });
            const solverNode = state.nodes.find(n => n.id === solverId);
            if (solverNode) {
                solverNode.parameters['seawater_material'] = matId;
            }
        }

        const matNode = state.nodes.find(n => n.id === matId);
        if (matNode) {
            matNode.parameters['water_target'] = solverId;
        }

        const targetModel = this.stateManager.getModelForNode(matId) || this.stateManager.getActiveModel();
        if (targetModel) {
            this.stateManager.setModelStatus(targetModel.id, 'UNINITIALIZED');
            this.stateManager.healModelGraph(targetModel);
        }
        this.stateManager.pushState(state);
    }
}
