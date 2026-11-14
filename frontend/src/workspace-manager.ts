/**
 * BlastDaemon WorkspaceManager
 * Viewport manager supporting 1x1, 1x2, 2x1, and 2x2 grid presets.
 * Routes off-thread rendering to WebGPU 3D Viewports, 2D Contours, 1D Gauge Charts,
 * and Resource Managers with seamless multi-model routing and playback synchronization.
 */

import { StateManager } from './state-manager.js';
import { PlaybackRingBuffer, BufferedFrame } from './playback-buffer.js';
import { Telemetry3DViewport } from './telemetry-3d-viewport.js';
import { ResourceManager } from './resource-manager.js';
import { STAGE_THEMES, isDomainMesh3DNode, isDomainMesh2DNode, type Model, type Node, type ViewportOptions, type MultiViewStageOptions, type ModelViewConfig, type StageThemeId, type StageThemeConfig } from './types.js';
import { CustomDialog } from './custom-dialog.js';
import { getColormapCssGradient } from './viewport/ColormapUtils.js';
import { GaugeManagerModal } from './gauge-manager-modal.js';

export type GridPreset = '1x1' | '1x2' | '2x1' | '2x2';
export type ViewportViewType = '3D_VIEWPORT' | '2D_CONTOUR' | '1D_CHART' | 'GAUGE_CHART' | 'RESOURCE_MONITOR';
export type { StageThemeId, StageThemeConfig };
export { STAGE_THEMES };

interface ViewportPane {
    id: string;
    index: number;
    container: HTMLElement;
    header: HTMLElement;
    content: HTMLElement;
    typeSelect: HTMLSelectElement;
    modePillsHost?: HTMLElement;
    modelSelect?: HTMLSelectElement;
    viewSelect?: HTMLSelectElement;
    inlineControlsHost?: HTMLElement;
    hudElement?: HTMLElement | null;
    colorbarCard?: HTMLElement | null;
    contourNavPill?: HTMLElement | null;
    chartControlCard?: HTMLElement | null;
    emptyOverlay?: HTMLElement | null;
    lastProbeStats?: any;
    soloProbeIndex?: number;
    liveBounds?: { min: number; max: number } | null;
    workerConfigOverrides?: Record<string, any>;
    modelId: string | null;
    viewId?: string | null;
    viewType: ViewportViewType;
    instance: any;
    worker: Worker | null;
    resizeObserver: ResizeObserver | null;
    cleanupListeners: (() => void) | null;
    isMaximized: boolean;
}

export class WorkspaceManager {
    public container: HTMLElement;
    public rootElement!: HTMLElement;
    private stateManager: StateManager;
    private playbackBuffer: PlaybackRingBuffer;
    private panelId: string | null = null;
    private savedOptions: ViewportOptions | null = null;

    private activePreset: GridPreset = '1x1';
    private activeTheme: StageThemeId = 'studio-slate';
    private showStudioGrid: boolean = true;
    private splitRatioX: number = 0.54;
    private splitRatioY: number = 0.50;
    private panes: ViewportPane[] = [];
    private splitters: HTMLElement[] = [];
    private viewAreaEl: HTMLElement | null = null;
    private singleModePillsHost: HTMLElement | null = null;
    private stageChartControlsBtn: HTMLButtonElement | null = null;
    private maximizedPaneId: string | null = null;
    private focusedPaneId: string | null = null;
    private titleElement: HTMLElement | null = null;
    private stateListener: () => void;
    private inPlaceListener: (nodeId: string, params: Record<string, any>) => void;
    private statusListener: (modelId: string, status: any) => void;
    private telemetryListener: (nodeId: string, data: any) => void;

    /** True while the constructor's buildStage() is running. Prevents saveStageOptions
     *  from calling updatePanelOptions synchronously during initialisation, which would
     *  immediately trigger notifyListeners → LayoutManager.render → new WorkspaceManager
     *  → buildStage → saveStageOptions → ... (infinite recursion / CPU spin). */
    private _initializing: boolean = false;

    private stlGeometries: Map<string, Map<string, { vertices: Float32Array | null, meshId: string }>> = new Map();
    private obstacleGeometries: Map<string, { vertices: Float32Array | null, cells: Int32Array | null, meshId: string }> = new Map();
    private windowResizeListener: (() => void) | null = null;
    private themeListener: ((e: any) => void) | void = undefined as any;

    constructor(
        container: HTMLElement | string,
        stateManager: StateManager,
        playbackBuffer: PlaybackRingBuffer,
        panelId?: string | null,
        options?: ViewportOptions | null
    ) {
        if (typeof container === 'string') {
            const el = document.getElementById(container);
            if (!el) throw new Error(`[WorkspaceManager] Container #${container} not found`);
            this.container = el;
        } else {
            this.container = container;
        }

        this.stateManager = stateManager;
        this.playbackBuffer = playbackBuffer;
        this.panelId = panelId || null;
        this.savedOptions = options || null;
        if (options && options.preset) {
            this.activePreset = options.preset;
        }
        if (typeof options?.splitRatioX === 'number' && isFinite(options.splitRatioX)) {
            this.splitRatioX = Math.max(0.18, Math.min(0.82, options.splitRatioX));
        }
        if (typeof options?.splitRatioY === 'number' && isFinite(options.splitRatioY)) {
            this.splitRatioY = Math.max(0.18, Math.min(0.82, options.splitRatioY));
        }

        const storedTheme = localStorage.getItem('blastdemon_stage_theme') as StageThemeId | null;
        const storedGrid = localStorage.getItem('blastdemon_stage_grid');
        if (options?.backgroundTheme && STAGE_THEMES.some(t => t.id === options.backgroundTheme)) {
            this.activeTheme = options.backgroundTheme as StageThemeId;
        } else if (storedTheme && STAGE_THEMES.some(t => t.id === storedTheme)) {
            this.activeTheme = storedTheme;
        }

        if (options?.showStudioGrid !== undefined) {
            this.showStudioGrid = Boolean(options.showStudioGrid);
        } else if (storedGrid !== null) {
            this.showStudioGrid = storedGrid !== 'false';
        }

        this.rootElement = document.createElement('div');
        this.container.innerHTML = '';
        this.container.appendChild(this.rootElement);

        this.stateListener = () => this.syncVirtualViewports();
        this.inPlaceListener = (_nodeId: string, _params: Record<string, any>) => {
            this.panes.forEach(pane => {
                if (pane.viewType === '2D_CONTOUR' || pane.viewType === '1D_CHART' || pane.viewType === 'GAUGE_CHART') {
                    this.syncPaneWorkerConfig(pane);
                }
            });
        };
        this.statusListener = (modelId?: string, status?: string) => {
            if (!modelId) return;
            this.panes.forEach(pane => {
                if (pane.modelId === modelId && (pane.viewType === '2D_CONTOUR' || pane.viewType === '1D_CHART' || pane.viewType === 'GAUGE_CHART')) {
                    if (status === 'UNINITIALIZED' && !this.hasModelBinaryTelemetry(modelId)) {
                        pane.worker?.postMessage({ type: 'clearData' });
                    }
                    this.syncPaneWorkerConfig(pane);
                }
            });
        };
        this.telemetryListener = (nodeId: string, data: any) => {
            if (!data || (!data.gauges_history && !data.solverTracked && !Array.isArray(data.times))) return;
            const allModels = this.stateManager.getWorkspaceModels();
            const activeWs = this.stateManager.getActiveWorkspace();
            this.panes.forEach(pane => {
                if (pane.viewType !== 'GAUGE_CHART' && pane.viewType !== '1D_CHART') return;
                const paneModelId = pane.modelId || activeWs?.activeModelId || allModels[0]?.id;
                const targetModel = allModels.find(m => m.id === paneModelId) || null;
                if (!targetModel) return;
                if (nodeId === `${targetModel.id}-gauges` || targetModel.nodes.some(n => n.id === nodeId)) {
                    this.syncChartGaugeData(pane, targetModel);
                }
            });
        };
        this.stateManager.onStateChange(this.stateListener);
        this.stateManager.onInPlaceParameterChange(this.inPlaceListener);
        this.stateManager.onModelStatusChange(this.statusListener);
        this.stateManager.onTelemetryUpdate(this.telemetryListener);

        this.windowResizeListener = () => this.triggerResize();
        window.addEventListener('resize', this.windowResizeListener);

        this.themeListener = (e: any) => {
            if (e?.detail?.themeId && e.detail.themeId !== this.activeTheme && STAGE_THEMES.some(t => t.id === e.detail.themeId)) {
                this.setTheme(e.detail.themeId as StageThemeId, false);
            }
        };
        window.addEventListener('blastdemon-theme-change', this.themeListener);

        // Guard: suppress saveStageOptions → updatePanelOptions mutations during
        // initial buildStage so we don't trigger a re-entrant state notification.
        (window as any).workspaceManager = this;
        (window as any).openRemapSplitView = (srcId: string, tgtId: string) => this.openRemapSplitView(srcId, tgtId);
        this._initializing = true;
        this.buildStage();
        this._initializing = false;
        this.syncVirtualViewports();
    }

    public triggerResize(): void {
        this.panes.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                if (typeof pane.instance.triggerResize === 'function') {
                    pane.instance.triggerResize();
                }
            } else if (pane.worker && pane.content) {
                const rect = pane.content.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    pane.worker.postMessage({
                        type: 'resize',
                        width: Math.round(rect.width),
                        height: Math.round(rect.height)
                    });
                }
            }
        });
    }

    public attachTo(container: HTMLElement): void {
        const wasAttached = this.container === container && this.container.contains(this.rootElement);
        this.container = container;
        if (!wasAttached) {
            this.container.innerHTML = '';
            this.container.appendChild(this.rootElement);
            this.panes.forEach(pane => {
                if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                    pane.instance.attachTo?.(pane.content);
                }
            });
        }
        this.triggerResize();
    }

    private getSmartSplitSpecs(model: Model | null | undefined, preset: GridPreset): { viewType: ViewportViewType; overrides?: Record<string, any> }[] {
        const primary = this.detectSmartViewType(model);
        if (preset === '1x1') {
            return [{ viewType: primary }];
        }
        if (preset === '1x2' || preset === '2x1') {
            return [
                { viewType: primary },
                { viewType: 'GAUGE_CHART', overrides: { chartMode: 'gauges', channel: 0 } }
            ];
        }
        // 2x2 Quad: pair spatial/contour views with pressure & impulse waveforms
        if (primary === '2D_CONTOUR') {
            return [
                { viewType: '2D_CONTOUR', overrides: { channel: 0 } },
                { viewType: 'GAUGE_CHART', overrides: { chartMode: 'gauges', channel: 0 } },
                { viewType: '2D_CONTOUR', overrides: { channel: 1 } },
                { viewType: 'GAUGE_CHART', overrides: { chartMode: 'gauges', channel: 8 } }
            ];
        }
        if (primary === '1D_CHART') {
            return [
                { viewType: '1D_CHART', overrides: { chartMode: 'spatial', channel: 0 } },
                { viewType: 'GAUGE_CHART', overrides: { chartMode: 'gauges', channel: 0 } },
                { viewType: '1D_CHART', overrides: { chartMode: 'spatial', channel: 1 } },
                { viewType: 'GAUGE_CHART', overrides: { chartMode: 'gauges', channel: 8 } }
            ];
        }
        return [
            { viewType: '3D_VIEWPORT' },
            { viewType: 'GAUGE_CHART', overrides: { chartMode: 'gauges', channel: 0 } },
            { viewType: 'GAUGE_CHART', overrides: { chartMode: 'gauges', channel: 8 } },
            { viewType: 'RESOURCE_MONITOR' }
        ];
    }

    public setPreset(preset: GridPreset, customPanes?: { viewType: ViewportViewType; modelId: string | null; viewId?: string | null; overrides?: Record<string, any> }[]): void {
        const prevPanes = this.panes.map(p => ({
            viewType: p.viewType,
            modelId: p.modelId,
            viewId: p.viewId || null,
            overrides: { ...(p.workerConfigOverrides || {}) }
        }));

        const allModels = this.stateManager.getWorkspaceModels();
        const activeWs = this.stateManager.getActiveWorkspace();
        const activeModelId = activeWs?.activeModelId || (allModels[0]?.id || null);
        const activeModel = allModels.find(m => m.id === activeModelId) || allModels[0] || null;
        const smartSpecs = this.getSmartSplitSpecs(activeModel, preset);

        let nextPanes: { index: number; viewType: ViewportViewType; modelId: string | null; viewId?: string | null; overrides?: Record<string, any> }[];
        if (customPanes && customPanes.length > 0) {
            nextPanes = customPanes.map((cp, idx) => ({
                index: idx,
                viewType: cp.viewType,
                modelId: cp.modelId,
                viewId: cp.viewId || null,
                overrides: cp.overrides ? { ...cp.overrides } : {}
            }));
        } else if (preset === '1x1') {
            const focusedIdx = this.focusedPaneId ? this.panes.findIndex(p => p.id === this.focusedPaneId) : 0;
            const keep = prevPanes[focusedIdx >= 0 ? focusedIdx : 0] || {
                viewType: smartSpecs[0].viewType,
                modelId: activeModelId,
                viewId: null,
                overrides: smartSpecs[0].overrides || {}
            };
            nextPanes = [{
                index: 0,
                viewType: keep.viewType,
                modelId: keep.modelId || activeModelId,
                viewId: keep.viewId || null,
                overrides: keep.overrides
            }];
        } else {
            const count = preset === '2x2' ? 4 : 2;
            nextPanes = [];
            for (let i = 0; i < count; i++) {
                if (i < prevPanes.length) {
                    // If expanding from 1x1 -> split and pane 0 is already GAUGE_CHART, put primary view in pane 0 and keep GAUGE_CHART in pane 1!
                    if (prevPanes.length === 1 && i === 0 && prevPanes[0].viewType === 'GAUGE_CHART' && smartSpecs[0].viewType !== 'GAUGE_CHART') {
                        nextPanes.push({
                            index: 0,
                            viewType: smartSpecs[0].viewType,
                            modelId: prevPanes[0].modelId || activeModelId,
                            viewId: null,
                            overrides: smartSpecs[0].overrides || {}
                        });
                    } else {
                        nextPanes.push({
                            index: i,
                            viewType: prevPanes[i].viewType,
                            modelId: prevPanes[i].modelId || activeModelId,
                            viewId: prevPanes[i].viewId || null,
                            overrides: prevPanes[i].overrides
                        });
                    }
                } else if (prevPanes.length === 1 && i === 1 && prevPanes[0].viewType === 'GAUGE_CHART') {
                    nextPanes.push({
                        index: 1,
                        viewType: 'GAUGE_CHART',
                        modelId: prevPanes[0].modelId || activeModelId,
                        viewId: null,
                        overrides: prevPanes[0].overrides
                    });
                } else {
                    const spec = smartSpecs[i] || smartSpecs[0];
                    nextPanes.push({
                        index: i,
                        viewType: spec.viewType,
                        modelId: activeModelId,
                        viewId: null,
                        overrides: spec.overrides ? { ...spec.overrides } : {}
                    });
                }
            }
        }

        this.activePreset = preset;
        this.maximizedPaneId = null;
        this.savedOptions = {
            ...(this.savedOptions || { preset }),
            preset,
            splitRatioX: this.splitRatioX,
            splitRatioY: this.splitRatioY,
            panes: nextPanes
        };
        this.buildStage();
        this.saveStageOptions();
    }

    public saveStageOptions(): void {
        localStorage.setItem('blastdemon_stage_theme', this.activeTheme);
        localStorage.setItem('blastdemon_stage_grid', String(this.showStudioGrid));
        // Skip the state mutation entirely while we're still inside the constructor's
        // buildStage() call. The options are already reflected in this.savedOptions (passed
        // in from the persisted layout), so there is nothing new to write yet.
        if (this._initializing) return;
        const options: ViewportOptions = {
            preset: this.activePreset,
            backgroundTheme: this.activeTheme,
            showStudioGrid: this.showStudioGrid,
            splitRatioX: Number(this.splitRatioX.toFixed(4)),
            splitRatioY: Number(this.splitRatioY.toFixed(4)),
            panes: this.panes.map(p => ({
                index: p.index,
                viewType: p.viewType,
                modelId: p.modelId,
                viewId: p.viewId || null,
                overrides: p.workerConfigOverrides ? { ...p.workerConfigOverrides } : undefined
            }))
        };
        this.savedOptions = options;
        if (!this.panelId) return;
        this.stateManager.updatePanelOptions(this.panelId, options);
    }

    public getPreset(): GridPreset {
        return this.activePreset;
    }

    public openRemapSplitView(sourceModelId: string, targetModelId: string): void {
        if (!sourceModelId || !targetModelId) return;
        const allModels = this.stateManager.getAllModels();
        const srcModel = allModels.find(m => m.id === sourceModelId) || null;
        const tgtModel = allModels.find(m => m.id === targetModelId) || null;
        const srcViewType = this.detectSmartViewType(srcModel);
        const tgtViewType = this.detectSmartViewType(tgtModel);

        this.setPreset('1x2', [
            { viewType: srcViewType, modelId: sourceModelId },
            { viewType: tgtViewType, modelId: targetModelId }
        ]);

        if (this.panes.length >= 2) {
            const activeId = this.stateManager.getActiveWorkspace()?.activeModelId;
            const focusPane = (activeId === sourceModelId) ? this.panes[0] : this.panes[1];
            this.setFocusedPane(focusPane.id);
        }
        this.updateStageTitle();
        this.saveStageOptions();
    }

    private detectSmartViewType(model: Model | null | undefined): ViewportViewType {
        if (!model || !model.nodes) return '3D_VIEWPORT';
        const types = model.nodes.map(n => n.type);
        if (types.some(t => isDomainMesh3DNode(t) || ['CFDSolver3D', 'MarineHarbourDomain', 'MPMDomain3D', 'FEMDomain3D', 'FSICoupler3D', 'FEMFSICoupler3D', 'Telemetry3DViewport', 'STLGeometry'].includes(t))) {
            return '3D_VIEWPORT';
        }
        if (types.some(t => isDomainMesh2DNode(t) || ['CFDSolver2D', 'MPMDomain2D', 'MPMObject2D', 'FSICoupler2D', 'ThePainter', 'TelemetryContour', 'Obstacle', 'Charge2D', 'Remap1DTo2DNode'].includes(t))) {
            return '2D_CONTOUR';
        }
        const dmNode = model.nodes.find(n => n.type === 'DomainMesh');
        if (dmNode?.parameters?.dimension === '2D') {
            return '2D_CONTOUR';
        }
        if (types.some(t => ['CFDSolver', 'Charge1D', 'VirtualGauges', 'TelemetryGraph', 'DomainMesh'].includes(t))) {
            return '1D_CHART';
        }
        return '3D_VIEWPORT';
    }

    private getPrimaryModePillsForModel(model: Model | null | undefined): { id: ViewportViewType; label: string; shortLabel: string; title: string }[] {
        const smart = this.detectSmartViewType(model);
        if (smart === '2D_CONTOUR') {
            return [
                { id: '2D_CONTOUR', label: '🗺️ 2D Contour', shortLabel: '🗺️ Contour', title: '2D Spatial Field Contour Slice' },
                { id: 'GAUGE_CHART', label: '🎯 Gauges f(t)', shortLabel: '🎯 Gauges', title: 'Virtual Gauge Time-History Waveforms f(t)' }
            ];
        }
        if (smart === '1D_CHART') {
            return [
                { id: '1D_CHART', label: '📈 Profile f(r)', shortLabel: '📈 Profile', title: '1D Spatial Radial Profile f(r)' },
                { id: 'GAUGE_CHART', label: '🎯 Gauges f(t)', shortLabel: '🎯 Gauges', title: 'Virtual Gauge Time-History Waveforms f(t)' }
            ];
        }
        return [
            { id: '3D_VIEWPORT', label: '🧊 3D View', shortLabel: '🧊 3D', title: '3D WebGPU Interactive Viewport' },
            { id: 'GAUGE_CHART', label: '🎯 Gauges f(t)', shortLabel: '🎯 Gauges', title: 'Virtual Gauge Time-History Waveforms f(t)' }
        ];
    }

    private renderModePillsInto(host: HTMLElement, pane: ViewportPane, model: Model | null | undefined, compact: boolean): void {
        host.innerHTML = '';
        const pills = this.getPrimaryModePillsForModel(model);
        const primaryIds = new Set(pills.map(p => p.id));

        pills.forEach(p => {
            const btn = document.createElement('button');
            btn.className = `stage-mode-pill-btn ${pane.viewType === p.id ? 'active' : ''}`;
            btn.textContent = compact ? p.shortLabel : p.label;
            btn.title = p.title;
            btn.onclick = (e) => {
                e.stopPropagation();
                this.setPaneViewType(pane, p.id);
            };
            host.appendChild(btn);
        });

        const allModes: { id: ViewportViewType; label: string }[] = [
            { id: '3D_VIEWPORT', label: '🧊 3D WebGPU Viewport' },
            { id: '2D_CONTOUR', label: '🗺️ 2D Contour Slice' },
            { id: '1D_CHART', label: '📈 1D Radial Profile f(r)' },
            { id: 'GAUGE_CHART', label: '🎯 Gauge Waveforms f(t)' },
            { id: 'RESOURCE_MONITOR', label: '⚡ Resource Monitor' }
        ];
        const extraActive = !primaryIds.has(pane.viewType);
        const moreBtn = document.createElement('button');
        moreBtn.className = `stage-mode-pill-btn ${extraActive ? 'active' : ''}`;
        const activeMeta = allModes.find(m => m.id === pane.viewType);
        moreBtn.textContent = extraActive && activeMeta ? `${activeMeta.label.split(' ')[0]} ▾` : '▾';
        moreBtn.title = 'Switch to any viewport mode (1D / 2D / 3D / Gauges / Resources)';
        moreBtn.onclick = (e) => {
            e.stopPropagation();
            this.showFloatingMenuPopover(
                moreBtn,
                allModes.map(m => ({
                    value: m.id,
                    label: m.label,
                    active: pane.viewType === m.id
                })),
                (picked) => {
                    this.setPaneViewType(pane, picked as ViewportViewType);
                }
            );
        };
        host.appendChild(moreBtn);
    }

    private setPaneViewType(pane: ViewportPane, viewType: ViewportViewType): void {
        if (pane.viewType === viewType) return;
        pane.viewType = viewType;
        if (pane.typeSelect) pane.typeSelect.value = viewType;
        if (viewType === 'GAUGE_CHART') {
            pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), chartMode: 'gauges' };
        } else if (viewType === '1D_CHART') {
            pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), chartMode: 'spatial' };
        }
        if (pane.viewSelect) {
            pane.viewSelect.style.display = viewType === '3D_VIEWPORT' ? 'inline-block' : 'none';
        }
        this.mountViewInstance(pane);
        this.refreshModePillsUI();
        this.saveStageOptions();
        (window as any).transportController?.requestTabRender?.();
    }

    private refreshModePillsUI(): void {
        const allModels = this.stateManager.getWorkspaceModels();
        const activeWs = this.stateManager.getActiveWorkspace();
        const activeModelId = activeWs?.activeModelId || (allModels[0]?.id || null);
        const activeModel = allModels.find(m => m.id === activeModelId) || allModels[0] || null;

        if (this.singleModePillsHost) {
            if (this.activePreset === '1x1' && this.panes[0]) {
                this.singleModePillsHost.style.display = 'flex';
                const paneModel = allModels.find(m => m.id === (this.panes[0].modelId || activeModelId)) || activeModel;
                this.renderModePillsInto(this.singleModePillsHost, this.panes[0], paneModel, false);
            } else {
                this.singleModePillsHost.style.display = 'none';
            }
        }

        this.panes.forEach(p => {
            if (p.modePillsHost) {
                const pm = allModels.find(m => m.id === (p.modelId || activeModelId)) || activeModel;
                this.renderModePillsInto(p.modePillsHost, p, pm, true);
            }
        });
    }

    private updateStageTitle(): void {
        if (!this.titleElement) return;
        const allModels = this.stateManager.getWorkspaceModels();
        const activeWs = this.stateManager.getActiveWorkspace();
        const activeModelId = activeWs?.activeModelId || (allModels[0]?.id || null);
        const activeModel = allModels.find(m => m.id === activeModelId);
        const modelName = activeModel?.name || activeModelId || 'No Model';
        this.titleElement.innerHTML = `<span class="stage-model-indicator" title="Active Model: ${modelName}">${modelName}</span>`;
    }

    private updateRootClasses(): void {
        this.rootElement.className = `workspace-stage-grid grid-${this.activePreset} theme-${this.activeTheme} ${this.showStudioGrid ? 'show-studio-grid' : ''}`;
    }

    public setTheme(themeId: StageThemeId, broadcast: boolean = true): void {
        if (!STAGE_THEMES.some(t => t.id === themeId)) return;
        this.activeTheme = themeId;
        this.updateRootClasses();
        this.syncViewportsClearColor();
        this.saveStageOptions();
        const themeSelect = this.rootElement?.querySelector('.stage-theme-select') as HTMLSelectElement | null;
        if (themeSelect && themeSelect.value !== themeId) {
            themeSelect.value = themeId;
        }
        if (broadcast) {
            window.dispatchEvent(new CustomEvent('blastdemon-theme-change', { detail: { themeId } }));
        }
    }

    public getTheme(): StageThemeId {
        return this.activeTheme;
    }

    public toggleStudioGrid(enabled?: boolean): void {
        this.showStudioGrid = enabled !== undefined ? enabled : !this.showStudioGrid;
        this.updateRootClasses();
        this.panes.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                if (typeof pane.instance.setGridVisible === 'function') {
                    pane.instance.setGridVisible(this.showStudioGrid);
                } else if (typeof pane.instance.setLayerVisibility === 'function') {
                    pane.instance.setLayerVisibility('grid', this.showStudioGrid);
                }
            } else if (pane.viewType === '2D_CONTOUR' && pane.worker) {
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), showGridlines: this.showStudioGrid };
                this.syncPaneWorkerConfig(pane);
            } else if ((pane.viewType === '1D_CHART' || pane.viewType === 'GAUGE_CHART') && pane.worker) {
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), showGrid: this.showStudioGrid };
                this.syncPaneWorkerConfig(pane);
            }
        });
        this.saveStageOptions();
    }

    public isStudioGridVisible(): boolean {
        return this.showStudioGrid;
    }

    private getVisibleChartPanes(): ViewportPane[] {
        return this.panes.filter(p => {
            if (this.maximizedPaneId && p.id !== this.maximizedPaneId) return false;
            return p.viewType === '1D_CHART' || p.viewType === 'GAUGE_CHART';
        });
    }

    private updateStageChartControlsBtn(): void {
        if (!this.stageChartControlsBtn) return;
        const chartPanes = this.getVisibleChartPanes();
        if (chartPanes.length === 0) {
            this.stageChartControlsBtn.style.display = 'none';
            this.stageChartControlsBtn.classList.remove('active');
            return;
        }
        this.stageChartControlsBtn.style.display = 'inline-flex';
        const allModels = this.stateManager.getWorkspaceModels();
        const anyOpen = chartPanes.some(p => {
            const m = allModels.find(mm => mm.id === p.modelId) || allModels[0] || null;
            return Boolean(this.buildChartConfig(m, p.workerConfigOverrides || {}, p.viewType).showChartCard);
        });
        this.stageChartControlsBtn.classList.toggle('active', anyOpen);
    }

    private getWorkerThemeSpec(): { theme: 'dark' | 'slate' | 'light'; clearColor: [number, number, number] } {
        const themeConfig = STAGE_THEMES.find(t => t.id === this.activeTheme) || STAGE_THEMES[0];
        const { r, g, b } = themeConfig.clearColor;
        const themeKind: 'dark' | 'slate' | 'light' = themeConfig.group === 'light'
            ? 'light'
            : (this.activeTheme.includes('slate') ? 'slate' : 'dark');
        return { theme: themeKind, clearColor: [r, g, b] };
    }

    private syncViewportsClearColor(): void {
        const themeConfig = STAGE_THEMES.find(t => t.id === this.activeTheme) || STAGE_THEMES[0];
        const { r, g, b } = themeConfig.clearColor;
        this.panes.forEach(p => {
            if (p.viewType === '3D_VIEWPORT' && p.instance && typeof p.instance.setBackgroundColor === 'function') {
                p.instance.setBackgroundColor(r, g, b);
            } else if ((p.viewType === '2D_CONTOUR' || p.viewType === '1D_CHART' || p.viewType === 'GAUGE_CHART') && p.worker) {
                this.syncPaneWorkerConfig(p);
            }
        });
    }

    private applyGridSplitTemplate(): void {
        const viewArea = this.viewAreaEl;
        if (!viewArea) return;

        if (this.maximizedPaneId) {
            viewArea.style.gridTemplateColumns = '1fr';
            viewArea.style.gridTemplateRows = '1fr';
            this.splitters.forEach(sp => { sp.style.display = 'none'; });
            this.panes.forEach(p => {
                p.container.style.gridColumn = '1';
                p.container.style.gridRow = '1';
            });
            return;
        }

        this.splitters.forEach(sp => { sp.style.display = 'flex'; });
        const rX = Math.max(0.18, Math.min(0.82, this.splitRatioX));
        const rY = Math.max(0.18, Math.min(0.82, this.splitRatioY));

        if (this.activePreset === '1x1') {
            viewArea.style.gridTemplateColumns = '1fr';
            viewArea.style.gridTemplateRows = '1fr';
            if (this.panes[0]) {
                this.panes[0].container.style.gridColumn = '1';
                this.panes[0].container.style.gridRow = '1';
            }
        } else if (this.activePreset === '1x2') {
            viewArea.style.gridTemplateColumns = `${rX}fr 5px ${1 - rX}fr`;
            viewArea.style.gridTemplateRows = '1fr';
            if (this.panes[0]) {
                this.panes[0].container.style.gridColumn = '1';
                this.panes[0].container.style.gridRow = '1';
            }
            if (this.panes[1]) {
                this.panes[1].container.style.gridColumn = '3';
                this.panes[1].container.style.gridRow = '1';
            }
        } else if (this.activePreset === '2x1') {
            viewArea.style.gridTemplateColumns = '1fr';
            viewArea.style.gridTemplateRows = `${rY}fr 5px ${1 - rY}fr`;
            if (this.panes[0]) {
                this.panes[0].container.style.gridColumn = '1';
                this.panes[0].container.style.gridRow = '1';
            }
            if (this.panes[1]) {
                this.panes[1].container.style.gridColumn = '1';
                this.panes[1].container.style.gridRow = '3';
            }
        } else if (this.activePreset === '2x2') {
            viewArea.style.gridTemplateColumns = `${rX}fr 5px ${1 - rX}fr`;
            viewArea.style.gridTemplateRows = `${rY}fr 5px ${1 - rY}fr`;
            const coords: [string, string][] = [['1', '1'], ['3', '1'], ['1', '3'], ['3', '3']];
            this.panes.forEach((p, idx) => {
                const [col, row] = coords[idx] || ['1', '1'];
                p.container.style.gridColumn = col;
                p.container.style.gridRow = row;
            });
        }
    }

    private attachSplitters(viewArea: HTMLElement): void {
        this.splitters = [];
        if (this.activePreset === '1x1') return;

        const wireSplitterDrag = (el: HTMLElement, axis: 'x' | 'y' | 'xy') => {
            el.addEventListener('mousedown', (e: MouseEvent) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                el.classList.add('dragging');
                document.body.style.cursor = axis === 'x' ? 'col-resize' : (axis === 'y' ? 'row-resize' : 'move');
                document.body.style.userSelect = 'none';

                let rafId: number | null = null;
                const onMove = (me: MouseEvent) => {
                    const rect = viewArea.getBoundingClientRect();
                    if ((axis === 'x' || axis === 'xy') && rect.width > 80) {
                        this.splitRatioX = Math.max(0.18, Math.min(0.82, (me.clientX - rect.left) / rect.width));
                    }
                    if ((axis === 'y' || axis === 'xy') && rect.height > 80) {
                        this.splitRatioY = Math.max(0.18, Math.min(0.82, (me.clientY - rect.top) / rect.height));
                    }
                    this.applyGridSplitTemplate();
                    if (rafId === null) {
                        rafId = requestAnimationFrame(() => {
                            rafId = null;
                            this.triggerResize();
                        });
                    }
                };
                const onUp = () => {
                    el.classList.remove('dragging');
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                    this.triggerResize();
                    this.saveStageOptions();
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
            });

            el.addEventListener('dblclick', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (axis === 'x' || axis === 'xy') this.splitRatioX = 0.5;
                if (axis === 'y' || axis === 'xy') this.splitRatioY = 0.5;
                this.applyGridSplitTemplate();
                this.triggerResize();
                this.saveStageOptions();
            });
        };

        if (this.activePreset === '1x2') {
            const colSplitter = document.createElement('div');
            colSplitter.className = 'stage-pane-splitter splitter-col';
            colSplitter.title = 'Drag to resize Side-by-Side panes (double-click to reset 50/50)';
            colSplitter.style.gridColumn = '2';
            colSplitter.style.gridRow = '1';
            wireSplitterDrag(colSplitter, 'x');
            viewArea.appendChild(colSplitter);
            this.splitters.push(colSplitter);
        } else if (this.activePreset === '2x1') {
            const rowSplitter = document.createElement('div');
            rowSplitter.className = 'stage-pane-splitter splitter-row';
            rowSplitter.title = 'Drag to resize Top / Bottom panes (double-click to reset 50/50)';
            rowSplitter.style.gridColumn = '1';
            rowSplitter.style.gridRow = '2';
            wireSplitterDrag(rowSplitter, 'y');
            viewArea.appendChild(rowSplitter);
            this.splitters.push(rowSplitter);
        } else if (this.activePreset === '2x2') {
            const colSplitter = document.createElement('div');
            colSplitter.className = 'stage-pane-splitter splitter-col';
            colSplitter.title = 'Drag to resize left/right columns (double-click to reset 50/50)';
            colSplitter.style.gridColumn = '2';
            colSplitter.style.gridRow = '1 / 4';
            wireSplitterDrag(colSplitter, 'x');
            viewArea.appendChild(colSplitter);
            this.splitters.push(colSplitter);

            const rowSplitter = document.createElement('div');
            rowSplitter.className = 'stage-pane-splitter splitter-row';
            rowSplitter.title = 'Drag to resize top/bottom rows (double-click to reset 50/50)';
            rowSplitter.style.gridColumn = '1 / 4';
            rowSplitter.style.gridRow = '2';
            wireSplitterDrag(rowSplitter, 'y');
            viewArea.appendChild(rowSplitter);
            this.splitters.push(rowSplitter);

            const crossSplitter = document.createElement('div');
            crossSplitter.className = 'stage-pane-splitter splitter-cross';
            crossSplitter.title = 'Drag 4-way center intersection (double-click to reset 50/50)';
            crossSplitter.style.gridColumn = '2';
            crossSplitter.style.gridRow = '2';
            wireSplitterDrag(crossSplitter, 'xy');
            viewArea.appendChild(crossSplitter);
            this.splitters.push(crossSplitter);
        }
    }

    private swapPaneWithNeighbor(pane: ViewportPane): void {
        if (this.panes.length < 2) return;
        const idx = pane.index;
        const neighborIdx = (idx + 1) % this.panes.length;
        const custom = this.panes.map(p => ({
            viewType: p.viewType,
            modelId: p.modelId,
            viewId: p.viewId || null,
            overrides: { ...(p.workerConfigOverrides || {}) }
        }));
        const tmp = custom[idx];
        custom[idx] = custom[neighborIdx];
        custom[neighborIdx] = tmp;
        this.setPreset(this.activePreset, custom);
    }

    private closeSplitPane(pane: ViewportPane): void {
        if (this.panes.length <= 1) return;
        const remaining = this.panes
            .filter(p => p.id !== pane.id)
            .map(p => ({
                viewType: p.viewType,
                modelId: p.modelId,
                viewId: p.viewId || null,
                overrides: { ...(p.workerConfigOverrides || {}) }
            }));
        if (remaining.length === 1) {
            this.setPreset('1x1', remaining);
        } else {
            this.setPreset('1x2', remaining.slice(0, 2));
        }
    }

    private buildStage(): void {
        this.rootElement.innerHTML = '';
        this.updateRootClasses();

        // Unified compact top toolbar: Model badge + Single-Mode View Pills + Layout Presets + Theme/Grid
        const stageToolbar = document.createElement('div');
        stageToolbar.className = 'stage-grid-toolbar';

        const toolbarLeft = document.createElement('div');
        toolbarLeft.className = 'stage-toolbar-left';
        this.titleElement = document.createElement('span');
        this.titleElement.className = 'stage-grid-title';
        this.updateStageTitle();
        toolbarLeft.appendChild(this.titleElement);

        this.singleModePillsHost = document.createElement('div');
        this.singleModePillsHost.className = 'stage-mode-pills-group';
        this.singleModePillsHost.style.display = this.activePreset === '1x1' ? 'flex' : 'none';
        toolbarLeft.appendChild(this.singleModePillsHost);

        stageToolbar.appendChild(toolbarLeft);

        const presetsGroup = document.createElement('div');
        presetsGroup.className = 'stage-presets-group';

        const presets: { id: GridPreset; label: string; icon: string; tip: string }[] = [
            { id: '1x1', label: 'Single', icon: '▢', tip: 'Single full-bleed viewport (zero inner header waste)' },
            { id: '1x2', label: 'Side-by-Side', icon: '◫', tip: 'Left / Right resizable split (pairs Contour/Profile + Gauge Waveforms)' },
            { id: '2x1', label: 'Top / Bottom', icon: '⊟', tip: 'Top / Bottom resizable split (pairs Contour/Profile + Gauge Waveforms)' },
            { id: '2x2', label: 'Quad', icon: '⊞', tip: '4-way resizable engineering dashboard' }
        ];

        presets.forEach(p => {
            const btn = document.createElement('button');
            btn.className = `stage-preset-btn ${this.activePreset === p.id ? 'active' : ''}`;
            btn.textContent = `${p.icon} ${p.label}`;
            btn.title = p.tip;
            btn.addEventListener('click', () => this.setPreset(p.id));
            presetsGroup.appendChild(btn);
        });
        stageToolbar.appendChild(presetsGroup);

        const toolbarRight = document.createElement('div');
        toolbarRight.className = 'stage-toolbar-right';

        // Stage Background Theme Selector
        const themeSelect = document.createElement('select');
        themeSelect.className = 'stage-theme-select';
        themeSelect.title = 'Change Stage Background Studio Theme';

        const lightThemes = STAGE_THEMES.filter(t => t.group === 'light');
        const darkThemes = STAGE_THEMES.filter(t => t.group === 'dark');

        const lightGroup = document.createElement('optgroup');
        lightGroup.label = 'Light Themes (Particle Contrast)';
        lightGroup.style.backgroundColor = '#141822';
        lightGroup.style.color = '#94a3b8';
        lightThemes.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = `${t.icon} ${t.label}`;
            opt.style.backgroundColor = '#141822';
            opt.style.color = '#e2e8f0';
            if (t.id === this.activeTheme) opt.selected = true;
            lightGroup.appendChild(opt);
        });
        themeSelect.appendChild(lightGroup);

        const darkGroup = document.createElement('optgroup');
        darkGroup.label = 'Dark Studio Themes';
        darkGroup.style.backgroundColor = '#141822';
        darkGroup.style.color = '#94a3b8';
        darkThemes.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = `${t.icon} ${t.label}`;
            opt.style.backgroundColor = '#141822';
            opt.style.color = '#e2e8f0';
            if (t.id === this.activeTheme) opt.selected = true;
            darkGroup.appendChild(opt);
        });
        themeSelect.appendChild(darkGroup);

        themeSelect.addEventListener('change', () => {
            this.setTheme(themeSelect.value as StageThemeId);
        });
        toolbarRight.appendChild(themeSelect);

        // Studio Grid Overlay Toggle
        const gridToggle = document.createElement('button');
        gridToggle.className = `stage-grid-toggle-btn ${this.showStudioGrid ? 'active' : ''}`;
        gridToggle.innerHTML = `📐 Grid`;
        gridToggle.title = 'Toggle Studio Engineering Grid Overlay';
        gridToggle.addEventListener('click', () => {
            this.toggleStudioGrid();
            gridToggle.classList.toggle('active', this.showStudioGrid);
        });
        toolbarRight.appendChild(gridToggle);

        // Chart Controls Panel Toggle (only visible when a 1D/Gauge chart pane is visible)
        const chartControlsBtn = document.createElement('button');
        chartControlsBtn.className = 'stage-grid-toggle-btn';
        chartControlsBtn.innerHTML = '🎛 Controls';
        chartControlsBtn.title = 'Show / Hide Chart Controls Panel';
        chartControlsBtn.style.display = 'none';
        chartControlsBtn.addEventListener('click', () => {
            const visibleChartPanes = this.getVisibleChartPanes();
            if (visibleChartPanes.length === 0) return;
            const allModels = this.stateManager.getWorkspaceModels();
            const anyOpen = visibleChartPanes.some(p => {
                const m = allModels.find(mm => mm.id === p.modelId) || allModels[0] || null;
                return Boolean(this.buildChartConfig(m, p.workerConfigOverrides || {}, p.viewType).showChartCard);
            });
            const nextOpen = !anyOpen;
            visibleChartPanes.forEach(p => {
                p.workerConfigOverrides = { ...(p.workerConfigOverrides || {}), showChartCard: nextOpen };
                this.syncPaneWorkerConfig(p);
            });
            this.saveStageOptions();
            this.updateStageChartControlsBtn();
            (window as any).transportController?.requestTabRender?.();
        });
        this.stageChartControlsBtn = chartControlsBtn;
        toolbarRight.appendChild(chartControlsBtn);

        stageToolbar.appendChild(toolbarRight);
        this.rootElement.appendChild(stageToolbar);

        const viewArea = document.createElement('div');
        viewArea.className = 'stage-view-area';
        this.viewAreaEl = viewArea;
        this.rootElement.appendChild(viewArea);

        // Determine number of view panes needed
        let paneCount = 1;
        if (this.activePreset === '1x2' || this.activePreset === '2x1') paneCount = 2;
        else if (this.activePreset === '2x2') paneCount = 4;

        // Cleanup old panes
        this.panes.forEach(p => this.destroyPaneInstance(p));
        this.panes = [];

        const allModels = this.stateManager.getWorkspaceModels();
        const activeWs = this.stateManager.getActiveWorkspace();
        const activeModelId = activeWs?.activeModelId || (allModels[0]?.id || null);
        const activeModel = allModels.find(m => m.id === activeModelId) || allModels[0] || null;
        const smartSpecs = this.getSmartSplitSpecs(activeModel, this.activePreset);

        for (let i = 0; i < paneCount; i++) {
            const savedPane = this.savedOptions?.panes?.[i];
            const spec = smartSpecs[i] || smartSpecs[0];
            const paneInitialType = savedPane?.viewType || spec.viewType;
            const paneModelId = (this.activePreset === '1x1' || savedPane?.modelId === undefined || !allModels.some(m => m.id === savedPane.modelId))
                ? activeModelId
                : savedPane.modelId;
            const paneViewId = savedPane?.viewId || null;
            const initialOverrides = savedPane?.overrides
                ? { ...savedPane.overrides }
                : (spec.overrides ? { ...spec.overrides } : {});
            const pane = this.createViewportPane(i, paneModelId, paneInitialType, paneViewId, initialOverrides);
            this.panes.push(pane);
            viewArea.appendChild(pane.container);
            this.mountViewInstance(pane);
        }

        this.attachSplitters(viewArea);
        this.applyGridSplitTemplate();
        this.refreshModePillsUI();
        this.updateStageChartControlsBtn();

        if (this.panes.length > 0) {
            const validFocus = this.focusedPaneId && this.panes.some(p => p.id === this.focusedPaneId)
                ? this.focusedPaneId
                : this.panes[0].id;
            this.setFocusedPane(validFocus);
        }
    }

    private createViewportPane(
        index: number,
        initialModelId: string | null,
        initialViewType: ViewportViewType,
        initialViewId?: string | null,
        initialOverrides: Record<string, any> = {}
    ): ViewportPane {
        const paneContainer = document.createElement('div');
        paneContainer.className = 'stage-pane-container';
        const paneId = `pane-${index}`;
        paneContainer.id = `stage-pane-${index}`;
        paneContainer.tabIndex = 0;
        paneContainer.addEventListener('focusin', () => {
            this.setFocusedPane(paneId);
        });
        paneContainer.addEventListener('mousedown', () => {
            this.setFocusedPane(paneId);
        });

        const paneHeader = document.createElement('div');
        paneHeader.className = 'stage-pane-header';

        const headerControlsLeft = document.createElement('div');
        headerControlsLeft.className = 'stage-pane-header-controls-left';

        const focusDot = document.createElement('span');
        focusDot.className = 'stage-pane-focus-dot';
        focusDot.title = 'Active Focused Pane (click pane to target Workstation Bar controls)';
        headerControlsLeft.appendChild(focusDot);

        const modePillsHost = document.createElement('div');
        modePillsHost.className = 'stage-mode-pills-group';
        headerControlsLeft.appendChild(modePillsHost);

        // Hidden select kept in sync for programmatic compatibility
        const typeSelect = document.createElement('select');
        typeSelect.className = 'stage-type-select';
        typeSelect.style.display = 'none';
        const types: ViewportViewType[] = ['3D_VIEWPORT', '2D_CONTOUR', '1D_CHART', 'GAUGE_CHART', 'RESOURCE_MONITOR'];
        types.forEach(tid => {
            const opt = document.createElement('option');
            opt.value = tid;
            opt.textContent = tid;
            if (tid === initialViewType) opt.selected = true;
            typeSelect.appendChild(opt);
        });
        headerControlsLeft.appendChild(typeSelect);

        // Model Selector (shown if multiple models exist in workspace)
        const allModels = this.stateManager.getWorkspaceModels();
        const modelSelect = document.createElement('select');
        modelSelect.className = 'stage-model-select';
        modelSelect.style.fontSize = '9.5px';
        modelSelect.style.background = '#1e222d';
        modelSelect.style.color = '#00ffcc';
        modelSelect.style.border = '1px solid rgba(0, 255, 204, 0.2)';
        modelSelect.style.borderRadius = '3px';
        modelSelect.style.padding = '1px 4px';
        modelSelect.style.cursor = 'pointer';
        modelSelect.style.flexShrink = '0';
        modelSelect.style.maxWidth = '130px';
        modelSelect.style.display = allModels.length > 1 ? 'inline-block' : 'none';

        allModels.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = `📦 ${m.name}`;
            opt.style.backgroundColor = '#141822';
            opt.style.color = '#e2e8f0';
            if (m.id === initialModelId) opt.selected = true;
            modelSelect.appendChild(opt);
        });
        headerControlsLeft.appendChild(modelSelect);

        // View Bookmark Selector for 3D Viewport
        const viewSelect = document.createElement('select');
        viewSelect.className = 'stage-view-select';
        viewSelect.style.fontSize = '9.5px';
        viewSelect.style.background = '#1e222d';
        viewSelect.style.color = '#cbd5e1';
        viewSelect.style.border = '1px solid rgba(255,255,255,0.15)';
        viewSelect.style.borderRadius = '3px';
        viewSelect.style.padding = '1px 4px';
        viewSelect.style.cursor = 'pointer';
        viewSelect.style.flexShrink = '0';
        viewSelect.style.display = initialViewType === '3D_VIEWPORT' ? 'inline-block' : 'none';
        headerControlsLeft.appendChild(viewSelect);

        const inlineControlsHost = document.createElement('div');
        inlineControlsHost.className = 'stage-pane-inline-controls';
        inlineControlsHost.style.display = 'none';
        headerControlsLeft.appendChild(inlineControlsHost);

        const headerControlsRight = document.createElement('div');
        headerControlsRight.className = 'stage-pane-header-controls-right';

        const swapBtn = document.createElement('button');
        swapBtn.className = 'stage-pane-tool-btn';
        swapBtn.textContent = '⇄';
        swapBtn.title = 'Swap this pane with neighbor pane';

        const fitBtn = document.createElement('button');
        fitBtn.className = 'stage-pane-tool-btn';
        fitBtn.textContent = '🏠';
        fitBtn.title = 'Fit / Reset View';

        const maxBtn = document.createElement('button');
        maxBtn.className = 'stage-pane-tool-btn';
        maxBtn.textContent = '⛶';
        maxBtn.title = 'Maximize / Restore Pane';

        const closePaneBtn = document.createElement('button');
        closePaneBtn.className = 'stage-pane-tool-btn';
        closePaneBtn.textContent = '✕';
        closePaneBtn.title = 'Close split pane';

        headerControlsRight.appendChild(swapBtn);
        headerControlsRight.appendChild(fitBtn);
        headerControlsRight.appendChild(maxBtn);
        headerControlsRight.appendChild(closePaneBtn);

        paneHeader.appendChild(headerControlsLeft);
        paneHeader.appendChild(headerControlsRight);

        const paneContent = document.createElement('div');
        paneContent.className = 'stage-pane-content';

        paneContainer.appendChild(paneHeader);
        paneContainer.appendChild(paneContent);

        const pane: ViewportPane = {
            id: paneId,
            index,
            container: paneContainer,
            header: paneHeader,
            content: paneContent,
            typeSelect,
            modePillsHost,
            modelSelect,
            viewSelect,
            inlineControlsHost,
            hudElement: null,
            colorbarCard: null,
            chartControlCard: null,
            emptyOverlay: null,
            lastProbeStats: null,
            soloProbeIndex: -1,
            liveBounds: null,
            modelId: initialModelId,
            viewId: initialViewId || null,
            viewType: initialViewType,
            instance: null,
            worker: null,
            resizeObserver: null,
            cleanupListeners: null,
            isMaximized: false,
            workerConfigOverrides: { ...initialOverrides }
        };

        modelSelect.addEventListener('change', () => {
            pane.modelId = modelSelect.value;
            pane.viewId = null;
            this.mountViewInstance(pane);
            this.updatePaneViewSelector(pane);
            this.refreshModePillsUI();
            this.saveStageOptions();
            if (pane.modelId) {
                this.stateManager.setActiveModel(pane.modelId);
            }
            this.updateStageTitle();
            (window as any).transportController?.requestTabRender?.();
        });

        typeSelect.addEventListener('change', () => {
            this.setPaneViewType(pane, typeSelect.value as ViewportViewType);
        });

        viewSelect.addEventListener('change', async () => {
            if (viewSelect.value === '__save_new__') {
                const views = pane.modelId ? this.stateManager.getModelViews(pane.modelId) : [];
                const defaultName = `View ${(views.length || 0) + 1}`;
                const name = await CustomDialog.prompt("Enter name for this view bookmark:", defaultName, "Save View Bookmark");
                if (name && pane.modelId) {
                    const newView = this.stateManager.addModelView(pane.modelId, name);
                    if (newView) {
                        pane.viewId = newView.id;
                        this.updatePaneViewSelector(pane);
                        this.saveStageOptions();
                    }
                } else {
                    this.updatePaneViewSelector(pane);
                }
            } else if (viewSelect.value) {
                pane.viewId = viewSelect.value;
                if (pane.modelId) {
                    this.stateManager.setModelActiveViewId(pane.modelId, pane.viewId);
                    const views = this.stateManager.getModelViews(pane.modelId);
                    const targetView = views.find(v => v.id === pane.viewId);
                    if (targetView && pane.instance && typeof pane.instance.applyModelView === 'function') {
                        pane.instance.applyModelView(targetView);
                    }
                }
                this.saveStageOptions();
            }
        });

        swapBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.swapPaneWithNeighbor(pane);
        });

        fitBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.snapCameraPreset?.('reset');
            } else if (pane.worker) {
                pane.worker.postMessage({ type: 'resetView' });
            }
        });

        maxBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleMaximizePane(pane);
        });

        closePaneBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.closeSplitPane(pane);
        });

        return pane;
    }

    private updatePaneModelSelector(pane: ViewportPane): void {
        if (!pane.modelSelect) return;
        const allModels = this.stateManager.getWorkspaceModels();
        pane.modelSelect.style.display = allModels.length > 1 ? 'inline-block' : 'none';
        pane.modelSelect.innerHTML = '';
        allModels.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = `📦 ${m.name}`;
            if (m.id === pane.modelId) opt.selected = true;
            pane.modelSelect!.appendChild(opt);
        });
    }

    private updatePaneViewSelector(pane: ViewportPane): void {
        if (!pane.viewSelect) return;
        if (pane.viewType !== '3D_VIEWPORT' || !pane.modelId) {
            pane.viewSelect.style.display = 'none';
            return;
        }
        pane.viewSelect.style.display = 'inline-block';
        pane.viewSelect.innerHTML = '';

        const views = this.stateManager.getModelViews(pane.modelId);
        const activeModelView = this.stateManager.getModelActiveView(pane.modelId);
        const selectedId = pane.viewId || activeModelView?.id || views[0]?.id;

        views.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v.id;
            opt.textContent = `👁️ ${v.name}`;
            opt.style.backgroundColor = '#141822';
            opt.style.color = '#e2e8f0';
            if (v.id === selectedId) opt.selected = true;
            pane.viewSelect!.appendChild(opt);
        });

        const newOpt = document.createElement('option');
        newOpt.value = '__save_new__';
        newOpt.textContent = '➕ Save Current View...';
        newOpt.style.backgroundColor = '#141822';
        newOpt.style.color = '#38bdf8';
        pane.viewSelect.appendChild(newOpt);
    }

    private destroyPaneInstance(pane: ViewportPane): void {
        if (pane.resizeObserver) {
            pane.resizeObserver.disconnect();
            pane.resizeObserver = null;
        }
        if (pane.cleanupListeners) {
            pane.cleanupListeners();
            pane.cleanupListeners = null;
        }
        if (pane.worker) {
            pane.worker.terminate();
            pane.worker = null;
        }
        if (pane.instance) {
            pane.instance.destroy?.();
            pane.instance = null;
        }
        pane.hudElement = null;
        pane.colorbarCard = null;
        pane.chartControlCard = null;
        pane.emptyOverlay = null;
        pane.lastProbeStats = null;
        if (pane.inlineControlsHost) {
            pane.inlineControlsHost.innerHTML = '';
        }
        pane.content.innerHTML = '';
    }

    private hasModelBinaryTelemetry(modelId: string): boolean {
        const latestFrame = this.playbackBuffer.getLatestFrameForModel(modelId);
        if (latestFrame && latestFrame.buffer && latestFrame.buffer.byteLength > 0) {
            return true;
        }
        const allModels = this.stateManager.getWorkspaceModels();
        const model = allModels.find(m => m.id === modelId);
        if (!model) return false;
        const solverNode = model.nodes.find(n =>
            n.type === 'CFDSolver2D' || n.type === 'MPMDomain2D' || n.type === 'CFDSolver' ||
            n.type === 'TelemetryContour' || n.type === 'TelemetryGraph'
        );
        if (solverNode) {
            const cached = this.stateManager.getTelemetry(solverNode.id);
            if (cached instanceof ArrayBuffer && cached.byteLength > 0) {
                return true;
            }
        }
        return false;
    }

    private getCachedModelBinaryTelemetry(model: Model | null): ArrayBuffer | null {
        if (!model) return null;
        const latestFrame = this.playbackBuffer.getLatestFrameForModel(model.id);
        if (latestFrame && latestFrame.buffer && latestFrame.buffer.byteLength > 0) {
            return latestFrame.buffer;
        }
        for (const n of model.nodes) {
            if (n.type === 'CFDSolver2D' || n.type === 'MPMDomain2D' || n.type === 'CFDSolver' || n.type === 'TelemetryContour' || n.type === 'TelemetryGraph') {
                const cached = this.stateManager.getTelemetry(n.id);
                if (cached instanceof ArrayBuffer && cached.byteLength > 0) {
                    return cached;
                }
            }
        }
        return null;
    }

    public buildContourConfig(model: Model | null, overrides: Record<string, any> = {}): Record<string, any> {
        const solverNode = model?.nodes.find(n => n.type === 'CFDSolver2D' || n.type === 'MPMDomain2D');
        const meshNode = model?.nodes.find(n => isDomainMesh2DNode(n.type) || n.type === 'MPMDomain2D' || n.type === 'DomainMesh');
        const contourNode = model?.nodes.find(n => n.type === 'TelemetryContour');
        const chargeNode = model?.nodes.find(n => n.type === 'Charge2D' || n.type === 'Charge1D');
        const detNode = model?.nodes.find(n => n.type === 'DetonatorLocation' || n.type === 'TriggerLocation');
        const gaugesNode = model?.nodes.find(n => n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D');

        const max_r = Number(meshNode?.parameters?.max_r ?? meshNode?.parameters?.domain_radius ?? meshNode?.parameters?.domain_width ?? 1.0) || 1.0;
        const max_z = Number(meshNode?.parameters?.max_z ?? meshNode?.parameters?.domain_height ?? max_r) || max_r;
        const cellSize = Number(meshNode?.parameters?.cell_size) || 0.05;
        const calculatedNr = Math.max(8, Math.round(max_r / cellSize) || 128);
        const calculatedNz = Math.max(8, Math.round(max_z / cellSize) || 128);
        const meshType = String(solverNode?.parameters?.mesh_type || 'regular');
        const baseNr = (meshType === 'amr') ? Math.ceil(calculatedNr / 16) * 16 : calculatedNr;
        const baseNz = (meshType === 'amr') ? Math.ceil(calculatedNz / 16) * 16 : calculatedNz;

        const remap2DNode = model?.nodes.find(n => n.type === 'RemapNode' || n.type === 'Remap1DTo2DNode');
        let upstream1DModel: Model | null = null;
        if (remap2DNode && model) {
            const allModels = this.stateManager.getAllModels();
            const explicitSrcId = String(remap2DNode.parameters?.source_model_id || '');
            if (explicitSrcId) {
                upstream1DModel = allModels.find(m => m.id === explicitSrcId) || null;
            }
            if (!upstream1DModel) {
                const ws = this.stateManager.getActiveWorkspace();
                const remapConn = ws?.connections?.find((c: any) => c.toNode === remap2DNode.id);
                if (remapConn) {
                    upstream1DModel = allModels.find(m => m.nodes.some(n => n.id === remapConn.fromNode)) || null;
                }
            }
        }

        const effectiveChargeModel = chargeNode ? model : upstream1DModel;
        const effectiveChargeNode = chargeNode || upstream1DModel?.nodes.find(n => n.type === 'Charge1D' || n.type === 'Charge2D');
        const jwlMatNode = effectiveChargeModel?.nodes.find(n =>
            n.type === 'Material' &&
            String(n.parameters?.eos_type || n.parameters?.material_model || '').toUpperCase().includes('JWL')
        );
        const rho0Contour = Number(jwlMatNode?.parameters?.rho ?? jwlMatNode?.parameters?.density ?? 1630.0) || 1630.0;

        const chargeMass = Number(effectiveChargeNode?.parameters?.charge_mass ?? 0);
        const chargeShape = String(chargeNode?.parameters?.charge_shape ?? chargeNode?.parameters?.shape ?? 'Sphere');
        let chargeRadius = Number(
            effectiveChargeNode?.parameters?.charge_radius ??
            effectiveChargeNode?.parameters?.explosive_r ??
            effectiveChargeNode?.parameters?.explosive_radius ?? 0
        );
        if (chargeMass > 0 && chargeRadius <= 0) {
            const vol = chargeMass / rho0Contour;
            chargeRadius = Math.pow((3.0 * vol) / (4.0 * Math.PI), 1.0 / 3.0);
        }
        const chargeHeight = Number(chargeNode?.parameters?.charge_height ?? (chargeRadius * 2.0));
        const chargeR = chargeNode
            ? Number(chargeNode.parameters?.charge_r ?? 0.0)
            : Number(remap2DNode?.parameters?.explosive_r ?? 0.0);
        const chargeZOffset = chargeNode
            ? Number(chargeNode.parameters?.charge_z ?? chargeNode.parameters?.z_offset ?? chargeNode.parameters?.center_z ?? (max_z * 0.5))
            : Number(remap2DNode?.parameters?.explosive_z ?? (max_z * 0.5));
        const detonatorR = Number(detNode?.parameters?.detonator_r ?? detNode?.parameters?.r ?? chargeR);
        const detonatorZ = Number(detNode?.parameters?.detonator_z ?? detNode?.parameters?.z ?? chargeZOffset);

        let remapInfo: { r: number; z: number; radius: number } | null = null;
        if (remap2DNode) {
            const explicitRemapR = Number(remap2DNode.parameters?.remap_radius ?? 0);
            const upstreamMesh = upstream1DModel?.nodes.find(n => n.type === 'DomainMesh');
            const upstreamMaxR = Number(upstreamMesh?.parameters?.domain_radius ?? 0);
            const effRemapR = explicitRemapR > 0 ? explicitRemapR : upstreamMaxR;
            if (effRemapR > 0) {
                remapInfo = {
                    r: Number(remap2DNode.parameters?.explosive_r ?? 0.0),
                    z: Number(remap2DNode.parameters?.explosive_z ?? (max_z * 0.5)),
                    radius: effRemapR
                };
            }
        }

        const obstacles = (model?.nodes || [])
            .filter(n => n.type === 'Obstacle')
            .map(n => {
                const rMin = Number(n.parameters?.min_r ?? n.parameters?.r_min ?? 0);
                const rMax = Number(n.parameters?.max_r ?? n.parameters?.r_max ?? 0);
                const zMin = Number(n.parameters?.min_z ?? n.parameters?.z_min ?? 0);
                const zMax = Number(n.parameters?.max_z ?? n.parameters?.z_max ?? 0);
                return {
                    min_r: rMin,
                    max_r: rMax,
                    min_z: zMin,
                    max_z: zMax,
                    r_min: rMin,
                    r_max: rMax,
                    z_min: zMin,
                    z_max: zMax,
                    label: String(n.parameters?.name || n.id)
                };
            })
            .filter(o => o.max_r > o.min_r && o.max_z > o.min_z);

        const mpmObjects = (model?.nodes || [])
            .filter(n => n.type === 'MPMObject2D')
            .map(n => {
                const shape = String(n.parameters?.shape_type ?? n.parameters?.shape ?? 'Box');
                const posX = n.parameters?.pos_x !== undefined ? Number(n.parameters.pos_x) : (n.parameters?.center_x !== undefined ? Number(n.parameters.center_x) : 0.5 * (Number(n.parameters?.min_x ?? 0) + Number(n.parameters?.max_x ?? 0.2)));
                const posY = n.parameters?.pos_y !== undefined ? Number(n.parameters.pos_y) : (n.parameters?.center_y !== undefined ? Number(n.parameters.center_y) : 0.5 * (Number(n.parameters?.min_y ?? 0) + Number(n.parameters?.max_y ?? 0.2)));
                const sizeX = n.parameters?.size_x !== undefined ? Number(n.parameters.size_x) : Math.max(0.02, Math.abs(Number(n.parameters?.max_x ?? 0.2) - Number(n.parameters?.min_x ?? 0)));
                const sizeY = n.parameters?.size_y !== undefined ? Number(n.parameters.size_y) : Math.max(0.02, Math.abs(Number(n.parameters?.max_y ?? 0.2) - Number(n.parameters?.min_y ?? 0)));
                return {
                    shape,
                    shape_type: shape,
                    pos_x: posX,
                    pos_y: posY,
                    size_x: sizeX,
                    size_y: sizeY,
                    min_x: Number(n.parameters?.min_x ?? (posX - sizeX * 0.5)),
                    max_x: Number(n.parameters?.max_x ?? (posX + sizeX * 0.5)),
                    min_y: Number(n.parameters?.min_y ?? (posY - sizeY * 0.5)),
                    max_y: Number(n.parameters?.max_y ?? (posY + sizeY * 0.5)),
                    center_x: posX,
                    center_y: posY,
                    radius: Number(n.parameters?.radius ?? 0.1),
                    label: String(n.parameters?.name || n.id)
                };
            });

        const rawGauges = Array.isArray(gaugesNode?.parameters?.gauges)
            ? gaugesNode!.parameters.gauges
            : (Array.isArray(meshNode?.parameters?.gauges) ? meshNode!.parameters.gauges : []);
        const gauges = rawGauges.map((g: any, idx: number) => ({
            id: String(g.id || g.name || `G${idx + 1}`),
            name: String(g.name || g.id || `G${idx + 1}`),
            r: g.r !== undefined ? Number(g.r) : Number(g.x ?? 0),
            z: g.z !== undefined ? Number(g.z) : Number(g.y ?? 0)
        }));

        const defaultChannel = (model && model.nodes.some(n => n.type === 'MPMDomain2D') && !model.nodes.some(n => n.type === 'CFDSolver2D')) ? 7 : 0;
        const minVal = Number(overrides.minVal ?? overrides.min ?? contourNode?.parameters?.min_val ?? contourNode?.parameters?.min_y ?? contourNode?.parameters?.min ?? 101325);
        const maxVal = Number(overrides.maxVal ?? overrides.max ?? contourNode?.parameters?.max_val ?? contourNode?.parameters?.max_y ?? contourNode?.parameters?.max ?? 1000000);
        const chargeInfo = chargeRadius > 0 ? {
            shape: chargeShape,
            r: chargeR,
            z: chargeZOffset,
            radius: chargeRadius,
            height: chargeHeight
        } : null;
        const detonatorInfo = (detNode || (chargeNode && chargeRadius > 0)) ? {
            r: detonatorR,
            z: detonatorZ
        } : null;

        const themeSpec = this.getWorkerThemeSpec();

        return {
            type: 'setConfig',
            channel: Number(overrides.channel ?? contourNode?.parameters?.channel ?? contourNode?.parameters?.telemetry_channel ?? defaultChannel),
            stride: Number(overrides.stride ?? contourNode?.parameters?.stride ?? contourNode?.parameters?.downsample_stride ?? 1),
            refreshRate: Number(overrides.refreshRate ?? contourNode?.parameters?.refresh_rate ?? (model ? this.stateManager.getModelRefreshRate(model.id) : 0.5)),
            logScale: Boolean(overrides.logScale ?? contourNode?.parameters?.log_scale ?? false),
            autoScale: overrides.autoScale !== undefined ? Boolean(overrides.autoScale) : (contourNode?.parameters?.auto_scale !== false),
            minVal,
            maxVal,
            min: minVal,
            max: maxVal,
            // Match exact 3D Viewport default ('rainbow')!
            colormap: String(overrides.colormap ?? contourNode?.parameters?.colormap ?? 'rainbow'),
            fillMode: 'aspect',
            showExtrema: overrides.showExtrema !== undefined ? Boolean(overrides.showExtrema) : true,
            interactionMode: overrides.interactionMode === 'boxZoom' ? 'boxZoom' : 'pan',
            selectedProbe: Number(overrides.selectedProbe ?? -1),
            showColorbar: false, // Rendered via floating 3D-style HTML Colorbar Card
            showColorbarCard: overrides.showColorbar !== undefined ? Boolean(overrides.showColorbar) : (contourNode?.parameters?.show_colorbar !== false),
            showMPMParticles: overrides.showMPMParticles !== undefined ? Boolean(overrides.showMPMParticles) : (contourNode?.parameters?.show_mpm_particles !== false),
            showCharge: overrides.showCharge !== undefined ? Boolean(overrides.showCharge) : true,
            showDetonator: overrides.showDetonator !== undefined ? Boolean(overrides.showDetonator) : true,
            showObstacles: overrides.showObstacles !== undefined ? Boolean(overrides.showObstacles) : true,
            showGauges: overrides.showGauges !== undefined ? Boolean(overrides.showGauges) : true,
            theme: themeSpec.theme,
            clearColor: themeSpec.clearColor,
            contourLevels: Number(overrides.contourLevels ?? contourNode?.parameters?.contour_levels ?? 0),
            showGridlines: overrides.showGridlines !== undefined ? Boolean(overrides.showGridlines) : Boolean(contourNode?.parameters?.show_gridlines ?? false),
            interpolate: overrides.interpolate !== undefined ? Boolean(overrides.interpolate) : (contourNode?.parameters?.interpolate !== false),
            isAxisymmetric: overrides.isAxisymmetric !== undefined ? Boolean(overrides.isAxisymmetric) : (meshNode?.parameters?.coordinate_system !== 'Cartesian' && meshNode?.type !== 'MPMDomain2D'),
            max_r,
            max_z,
            meshType,
            amrMaxLevels: Math.max(1, Number(solverNode?.parameters?.amr_max_levels ?? 3)),
            baseNr,
            baseNz,
            chargeShape,
            chargeR,
            chargeRadius,
            chargeHeight,
            chargeZOffset,
            detonatorR,
            detonatorZ,
            chargeInfo,
            remapInfo,
            detonatorInfo,
            obstacles,
            mpmObjects,
            gauges
        };
    }

    public buildChartConfig(model: Model | null, overrides: Record<string, any> = {}, viewType?: ViewportViewType): Record<string, any> {
        const graphNode = model?.nodes.find(n => n.type === 'TelemetryGraph');
        const meshNode = model?.nodes.find(n => n.type === 'DomainMesh' || isDomainMesh2DNode(n.type) || isDomainMesh3DNode(n.type));
        const chargeNode = model?.nodes.find(n => n.type === 'Charge1D' || n.type === 'Charge2D' || n.type === 'Charge3D');
        const detNode = model?.nodes.find(n => n.type === 'DetonatorLocation' || n.type === 'TriggerLocation' || n.type === 'DetonatorLocation3D' || n.type === 'TriggerLocation3D');
        const gaugesNode = model?.nodes.find(n => n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D');

        const is1DModel = Boolean(model?.nodes.some(n => n.type === 'CFDSolver' || (n.type === 'DomainMesh' && n.parameters?.dimension !== '2D')));
        const defaultChartMode: 'spatial' | 'gauges' = (viewType === 'GAUGE_CHART')
            ? 'gauges'
            : (is1DModel ? 'spatial' : 'gauges');
        const chartMode: 'spatial' | 'gauges' = (viewType === 'GAUGE_CHART')
            ? 'gauges'
            : ((overrides.chartMode === 'spatial' || overrides.chartMode === 'gauges') ? overrides.chartMode : defaultChartMode);

        const domainRadius = Number(meshNode?.parameters?.domain_radius ?? meshNode?.parameters?.max_r ?? 1.0) || 1.0;
        const jwlMat = model?.nodes.find(n =>
            n.type === 'Material' &&
            String(n.parameters?.eos_type || n.parameters?.material_model || '').toUpperCase().includes('JWL')
        );
        const rho0Chart = Number(jwlMat?.parameters?.rho ?? jwlMat?.parameters?.density ?? 1630.0) || 1630.0;
        const chargeMass = Number(chargeNode?.parameters?.charge_mass ?? 0);
        let chargeRadius = Number(
            chargeNode?.parameters?.charge_radius ??
            chargeNode?.parameters?.explosive_radius ??
            chargeNode?.parameters?.explosive_r ?? 0
        );
        if (chargeMass > 0 && chargeRadius <= 0) {
            const vol = chargeMass / rho0Chart;
            chargeRadius = Math.pow((3.0 * vol) / (4.0 * Math.PI), 1.0 / 3.0);
        }
        const detonatorR: number | null = detNode
            ? Number(detNode.parameters?.detonator_r ?? detNode.parameters?.r ?? 0)
            : null;

        let remapRadius = 0.0;
        if (is1DModel && model) {
            const allModels = this.stateManager.getAllModels();
            const ws = this.stateManager.getActiveWorkspace();
            const srcNodeIds = new Set(model.nodes.map(n => n.id));
            for (const cand of allModels) {
                if (cand.id === model.id) continue;
                const rNode = cand.nodes.find(n =>
                    n.type === 'RemapNode' || n.type === 'Remap1DTo2DNode' || n.type === 'Remap1DTo3DNode'
                );
                if (!rNode) continue;
                const linkedByParam = String(rNode.parameters?.source_model_id || '') === model.id;
                const linkedByConn = Boolean(ws?.connections?.some((c: any) => c.toNode === rNode.id && srcNodeIds.has(c.fromNode)));
                if (linkedByParam || linkedByConn) {
                    const rr = Number(rNode.parameters?.remap_radius ?? 0);
                    remapRadius = rr > 0 ? rr : domainRadius;
                    break;
                }
            }
        }

        const rawGauges = Array.isArray(gaugesNode?.parameters?.gauges)
            ? gaugesNode!.parameters.gauges
            : (Array.isArray(meshNode?.parameters?.gauges) ? meshNode!.parameters.gauges : []);
        const hiddenSet = new Set<number>(Array.isArray(overrides.hiddenProbes) ? overrides.hiddenProbes.map((x: any) => Number(x)) : []);
        const gauges = rawGauges.map((g: any, idx: number) => {
            if (g && g.plot === false && !Array.isArray(overrides.hiddenProbes)) {
                hiddenSet.add(idx);
            }
            return {
                id: String(g.id || g.name || `G${idx + 1}`),
                name: String(g.name || g.id || `G${idx + 1}`),
                r: g.r !== undefined ? Number(g.r) : (g.x !== undefined ? Number(g.x) : 0),
                z: g.z !== undefined ? Number(g.z) : undefined,
                x: g.x !== undefined ? Number(g.x) : undefined,
                y: g.y !== undefined ? Number(g.y) : undefined,
                plot: g.plot !== false
            };
        });

        const autoScale = overrides.autoScale !== undefined
            ? Boolean(overrides.autoScale)
            : (overrides.autoScaleY !== undefined
                ? Boolean(overrides.autoScaleY)
                : (graphNode?.parameters?.auto_scale !== undefined ? Boolean(graphNode.parameters.auto_scale) : (graphNode?.parameters?.auto_scale_y !== false)));

        const fallbackChannel = chartMode === 'gauges'
            ? (gaugesNode?.parameters?.telemetry_channel ?? graphNode?.parameters?.channel ?? graphNode?.parameters?.telemetry_channel ?? 0)
            : (graphNode?.parameters?.channel ?? graphNode?.parameters?.telemetry_channel ?? 0);

        const themeSpec = this.getWorkerThemeSpec();

        return {
            type: 'setConfig',
            chartMode,
            channel: Number(overrides.channel ?? fallbackChannel),
            selectedProbe: Number(overrides.selectedProbe ?? -1),
            hiddenProbes: Array.from(hiddenSet),
            hoveredProbe: Number(overrides.hoveredProbe ?? -1),
            interactionMode: overrides.interactionMode === 'boxZoom' ? 'boxZoom' : 'pan',
            showPeaks: overrides.showPeaks !== undefined ? Boolean(overrides.showPeaks) : true,
            showChartCard: overrides.showChartCard !== undefined ? Boolean(overrides.showChartCard) : false,
            showCanvasLegend: false,
            color: String(overrides.color ?? graphNode?.parameters?.color ?? '#38bdf8'),
            autoScale,
            autoScaleY: autoScale,
            logScale: Boolean(overrides.logScale ?? graphNode?.parameters?.log_scale ?? false),
            min: Number(overrides.min ?? overrides.minVal ?? graphNode?.parameters?.min_y ?? 0),
            max: Number(overrides.max ?? overrides.maxVal ?? graphNode?.parameters?.max_y ?? 1000000),
            showGrid: overrides.showGrid !== undefined ? Boolean(overrides.showGrid) : Boolean(graphNode?.parameters?.show_grid ?? this.showStudioGrid),
            showCharge: overrides.showCharge !== undefined ? Boolean(overrides.showCharge) : true,
            showDetonator: overrides.showDetonator !== undefined ? Boolean(overrides.showDetonator) : true,
            showGauges: overrides.showGauges !== undefined ? Boolean(overrides.showGauges) : true,
            theme: themeSpec.theme,
            clearColor: themeSpec.clearColor,
            showAxes: true,
            xAxisMode: String(overrides.xAxisMode ?? graphNode?.parameters?.x_axis_mode ?? 'radius'),
            domainRadius,
            chargeRadius,
            remapRadius,
            detonatorR,
            gauges
        };
    }

    private syncChartGaugeData(pane: ViewportPane, model: Model | null): void {
        if (!pane.worker || (pane.viewType !== '1D_CHART' && pane.viewType !== 'GAUGE_CHART') || !model) return;
        const gaugesNode = model.nodes.find(n => n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D');
        const solverNode = model.nodes.find(n =>
            n.type === 'CFDSolver' || n.type === 'CFDSolver2D' || n.type === 'CFDSolver3D' ||
            n.type === 'MPMDomain2D' || n.type === 'MPMDomain3D' || n.type === 'FEMDomain3D' ||
            n.type === 'FSICoupler2D' || n.type === 'FSICoupler3D' || n.type === 'FEMFSICoupler3D'
        );
        const candidates = [
            this.stateManager.getTelemetry(`${model.id}-gauges`),
            gaugesNode ? this.stateManager.getTelemetry(gaugesNode.id) : null,
            solverNode ? this.stateManager.getTelemetry(solverNode.id) : null
        ];
        for (const candRaw of candidates) {
            if (!candRaw || typeof candRaw !== 'object' || candRaw instanceof ArrayBuffer) continue;
            const cand = (candRaw.gauges_history && !Array.isArray(candRaw.times))
                ? this.stateManager.normalizeGaugesTelemetry(candRaw.gauges_history)
                : candRaw;
            if (!cand || typeof cand !== 'object') continue;

            const times = Array.isArray(cand.times)
                ? cand.times
                : (Array.isArray(cand.gauge_times) ? cand.gauge_times : null);
            if (!times || times.length === 0) continue;

            const cfg = this.buildChartConfig(model, pane.workerConfigOverrides || {}, pane.viewType);
            let effectiveGauges: any[] = Array.isArray(cfg.gauges) ? [...cfg.gauges] : [];
            let orderedValues: number[][][] = [];

            const hasChannelSamples = (arr: any): boolean =>
                Array.isArray(arr) && arr.length > 0 && arr.some((ch: any) => Array.isArray(ch) && ch.length > 0);

            if (Array.isArray(cand.values) && cand.values.some(hasChannelSamples)) {
                orderedValues = cand.values;
                if (effectiveGauges.length === 0) {
                    effectiveGauges = orderedValues.map((_, idx) => ({ id: `G${idx + 1}`, name: `G${idx + 1}` }));
                }
            } else if (Array.isArray(cand.gauges_history) && cand.gauges_history.length > 0) {
                if (effectiveGauges.length === 0) {
                    effectiveGauges = cand.gauges_history.map((h: any, idx: number) => ({
                        id: String(h.id || `G${idx + 1}`),
                        name: String(h.id || `G${idx + 1}`)
                    }));
                }
                orderedValues = effectiveGauges.map((g: any, idx: number) => {
                    const gid = String(g.id || g.name || `G${idx + 1}`);
                    const gUpper = gid.toUpperCase();
                    const match = cand.gauges_history.find((h: any) => String(h.id || '').toUpperCase() === gUpper) || cand.gauges_history[idx];
                    return Array.isArray(match?.channel_values) ? match.channel_values : [];
                });
                if (!orderedValues.some(hasChannelSamples)) {
                    effectiveGauges = cand.gauges_history.map((h: any, idx: number) => ({
                        id: String(h.id || `G${idx + 1}`),
                        name: String(h.id || `G${idx + 1}`)
                    }));
                    orderedValues = cand.gauges_history.map((h: any) => Array.isArray(h?.channel_values) ? h.channel_values : []);
                }
            } else if (cand.values && typeof cand.values === 'object') {
                const valObj = cand.values as Record<string, number[][]>;
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
                pane.worker.postMessage({
                    type: 'setGaugeData',
                    times,
                    values: orderedValues,
                    gauges: effectiveGauges
                });
                break;
            }
        }
    }

    public openGaugeWaveformView(modelId?: string): void {
        const allModels = this.stateManager.getWorkspaceModels();
        const activeWs = this.stateManager.getActiveWorkspace();
        const targetModelId = modelId || activeWs?.activeModelId || allModels[0]?.id || null;
        if (!targetModelId) return;

        let targetPane = this.panes.find(p => p.id === this.focusedPaneId && (!p.modelId || p.modelId === targetModelId))
            || this.panes.find(p => p.modelId === targetModelId)
            || this.panes[0];
        if (!targetPane) return;

        targetPane.modelId = targetModelId;
        targetPane.viewType = 'GAUGE_CHART';
        if (targetPane.typeSelect) targetPane.typeSelect.value = 'GAUGE_CHART';
        targetPane.workerConfigOverrides = {
            ...(targetPane.workerConfigOverrides || {}),
            chartMode: 'gauges'
        };
        this.mountViewInstance(targetPane);
        this.refreshModePillsUI();
        this.saveStageOptions();
        (window as any).transportController?.requestTabRender?.();
    }

    public getActivePaneContext(): {
        viewType: ViewportViewType;
        modelId: string | null;
        overrides: Record<string, any>;
        liveBounds: { min: number; max: number } | null;
        pane: ViewportPane | null;
    } {
        const pane = (this.focusedPaneId ? this.panes.find(p => p.id === this.focusedPaneId) : null) || this.panes[0] || null;
        return {
            viewType: pane?.viewType || '3D_VIEWPORT',
            modelId: pane?.modelId || null,
            overrides: pane?.workerConfigOverrides || {},
            liveBounds: pane?.liveBounds || null,
            pane
        };
    }

    public zoomActivePane(factor: number): void {
        const { pane } = this.getActivePaneContext();
        if (!pane || !pane.worker) return;
        pane.worker.postMessage({ type: 'zoom', factor });
    }

    public toggleActivePaneSymmetry(): void {
        const { pane } = this.getActivePaneContext();
        if (!pane || pane.viewType !== '2D_CONTOUR') return;
        const allModels = this.stateManager.getWorkspaceModels();
        const model = allModels.find(m => m.id === pane.modelId) || allModels[0] || null;
        const cfg = this.buildContourConfig(model, pane.workerConfigOverrides || {});
        pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), isAxisymmetric: !cfg.isAxisymmetric };
        this.syncPaneWorkerConfig(pane);
        (window as any).transportController?.requestTabRender?.();
    }

    public switchActivePaneType(viewType: ViewportViewType): void {
        const { pane } = this.getActivePaneContext();
        if (!pane) return;
        this.setPaneViewType(pane, viewType);
    }

    private formatCardRangeValue(val: number, span: number): string {
        if (!isFinite(val)) return '0';
        if (val === 0) return '0';
        const absV = Math.abs(val);
        if (absV >= 1e4 || absV < 1e-2) return val.toExponential(2);
        if (span > 0 && span < 0.05) return val.toPrecision(4);
        if (absV >= 100) return val.toFixed(1);
        if (absV >= 1) return val.toFixed(2);
        return val.toFixed(3);
    }

    private showFloatingMenuPopover(anchorEl: HTMLElement, items: { value: string; label: string; active?: boolean }[], onPick: (val: string) => void): void {
        document.querySelectorAll('.bd-colorbar-floating-menu').forEach(el => el.remove());
        const menu = document.createElement('div');
        menu.className = 'bd-colorbar-floating-menu';
        const rect = anchorEl.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.left = `${Math.min(window.innerWidth - 190, Math.max(8, rect.left))}px`;
        menu.style.top = `${Math.min(window.innerHeight - 280, rect.bottom + 4)}px`;
        menu.style.zIndex = '9999';
        menu.style.background = 'rgba(14, 15, 19, 0.96)';
        menu.style.backdropFilter = 'blur(12px)';
        menu.style.border = '1px solid rgba(56, 189, 248, 0.35)';
        menu.style.borderRadius = '6px';
        menu.style.padding = '4px';
        menu.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.65)';
        menu.style.display = 'flex';
        menu.style.flexDirection = 'column';
        menu.style.gap = '2px';
        menu.style.minWidth = '165px';

        items.forEach(item => {
            const row = document.createElement('div');
            row.style.padding = '4px 8px';
            row.style.borderRadius = '4px';
            row.style.cursor = 'pointer';
            row.style.fontSize = '10px';
            row.style.fontFamily = 'system-ui, -apple-system, sans-serif';
            row.style.color = item.active ? '#38bdf8' : '#e2e8f0';
            row.style.background = item.active ? 'rgba(56, 189, 248, 0.16)' : 'transparent';
            row.style.fontWeight = item.active ? '700' : '500';
            row.textContent = item.label;
            row.onmouseenter = () => { if (!item.active) row.style.background = 'rgba(255, 255, 255, 0.08)'; };
            row.onmouseleave = () => { if (!item.active) row.style.background = 'transparent'; };
            row.onclick = (e) => {
                e.stopPropagation();
                menu.remove();
                onPick(item.value);
            };
            menu.appendChild(row);
        });

        document.body.appendChild(menu);
        const closeHandler = (ev: MouseEvent) => {
            if (!menu.contains(ev.target as globalThis.Node)) {
                menu.remove();
                window.removeEventListener('mousedown', closeHandler);
            }
        };
        setTimeout(() => window.addEventListener('mousedown', closeHandler), 0);
    }

    /**
     * Builds or updates the 3D-identical Floating Glassmorphic Colorbar Card inside 2D Contour panes
     * (matching Telemetry3DViewport.createColorbarCard pixel-for-pixel).
     */
    private updateContourColorbarCard(pane: ViewportPane, model: Model | null): void {
        const card = pane.colorbarCard;
        if (!card) return;
        const cfg = this.buildContourConfig(model, pane.workerConfigOverrides || {});
        if (!cfg.showColorbarCard) {
            card.style.display = 'none';
            return;
        }
        card.style.display = 'flex';

        const channelLabels: Record<number, { title: string; itemsLabel: string }> = {
            0: { title: 'PRESSURE [Pa]', itemsLabel: '🌡️ Pressure P (Pa)' },
            10: { title: 'OVERPRESSURE [Pa]', itemsLabel: '💥 Overpressure ΔP (Pa)' },
            1: { title: 'DENSITY [kg/m³]', itemsLabel: '🧱 Density ρ (kg/m³)' },
            9: { title: 'VELOCITY MAG [m/s]', itemsLabel: '💨 Velocity Mag |u| (m/s)' },
            2: { title: 'RADIAL VEL u_r [m/s]', itemsLabel: '➡️ Radial Vel u_r (m/s)' },
            3: { title: 'AXIAL VEL u_z [m/s]', itemsLabel: '⬆️ Axial Vel u_z (m/s)' },
            4: { title: 'ENERGY [J/kg]', itemsLabel: '⚡ Specific Energy e (J/kg)' },
            5: { title: 'REACTED α₁ [-]', itemsLabel: '🔥 Reacted Products α₁' },
            6: { title: 'UNREACTED α₂ [-]', itemsLabel: '🧨 Unreacted Solid α₂' },
            7: { title: 'MPM VON MISES [Pa]', itemsLabel: '🔩 MPM von Mises (Pa)' },
            8: { title: 'MPM PLASTIC ε_p [-]', itemsLabel: '🔧 MPM Plastic Strain ε_p' }
        };

        const activeCh = Number(cfg.channel ?? 0);
        const titleText = channelLabels[activeCh]?.title || `CHANNEL ${activeCh}`;
        const minVal = (cfg.autoScale && pane.liveBounds) ? pane.liveBounds.min : Number(cfg.minVal ?? 0);
        const maxVal = (cfg.autoScale && pane.liveBounds) ? pane.liveBounds.max : Number(cfg.maxVal ?? 1e6);
        const contourLevels = Number(cfg.contourLevels ?? 0);
        const isSmooth = contourLevels <= 1;
        const cmap = String(cfg.colormap || 'rainbow');

        const titleSpan = card.querySelector('.viewport-colorbar-title') as HTMLElement | null;
        if (titleSpan) {
            titleSpan.textContent = titleText;
            titleSpan.title = `${titleText} (Click to change quantity)`;
        }

        const gradBar = card.querySelector('.viewport-colorbar-grad-bar') as HTMLElement | null;
        if (gradBar) {
            gradBar.style.background = getColormapCssGradient(cmap, 'to top', isSmooth ? 0 : contourLevels);
        }

        const ticksCol = card.querySelector('.viewport-colorbar-ticks-col') as HTMLElement | null;
        if (ticksCol) {
            let dMin = minVal;
            let dMax = maxVal;
            if (dMax <= dMin) dMax = dMin + 1.0;
            if (cfg.logScale) {
                if (dMax <= 0) dMax = 1.0;
                if (dMin <= 0) dMin = dMax * 1e-6;
            }
            const span = Math.abs(dMax - dMin);
            const maxInp = ticksCol.querySelector('input[data-tick-role="max"]') as HTMLInputElement | null;
            const minInp = ticksCol.querySelector('input[data-tick-role="min"]') as HTMLInputElement | null;
            if (maxInp && document.activeElement !== maxInp) {
                maxInp.value = this.formatCardRangeValue(maxVal, span);
            }
            if (minInp && document.activeElement !== minInp) {
                minInp.value = this.formatCardRangeValue(minVal, span);
            }
            const interSpans = ticksCol.querySelectorAll('span[data-tick-role="intermediate"]');
            interSpans.forEach(sp => {
                const idx = Number((sp as HTMLElement).dataset.tickIndex || 1);
                const t = (4 - idx) / 4;
                const v = (cfg.logScale && dMin > 0 && dMax > dMin)
                    ? (dMin * Math.pow(dMax / dMin, t))
                    : (dMin + t * (dMax - dMin));
                sp.textContent = this.formatCardRangeValue(v, span);
            });
        }
    }

    private mountContourColorbarCard(host: HTMLElement, pane: ViewportPane): void {
        const container = document.createElement('div');
        container.className = 'viewport-colorbars-container';
        container.style.position = 'absolute';
        container.style.top = '10px';
        container.style.left = '10px';
        container.style.zIndex = '20';
        container.style.pointerEvents = 'none';

        const card = document.createElement('div');
        card.className = 'viewport-colorbar-card';
        card.style.background = 'rgba(14, 15, 19, 0.88)';
        card.style.backdropFilter = 'blur(12px)';
        card.style.border = '1px solid rgba(255, 255, 255, 0.14)';
        card.style.borderRadius = '6px';
        card.style.padding = '5px 6px';
        card.style.display = 'flex';
        card.style.flexDirection = 'column';
        card.style.gap = '3px';
        card.style.color = '#e2e8f0';
        card.style.fontFamily = 'system-ui, -apple-system, sans-serif';
        card.style.fontSize = '9px';
        card.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.55)';
        card.style.userSelect = 'none';
        card.style.boxSizing = 'border-box';
        card.style.pointerEvents = 'auto';
        card.style.width = 'fit-content';
        card.addEventListener('mousedown', e => e.stopPropagation());
        card.addEventListener('wheel', e => e.stopPropagation());

        const getModel = () => {
            const all = this.stateManager.getWorkspaceModels();
            return all.find(m => m.id === pane.modelId) || all[0] || null;
        };

        // 1. Header Row
        const topRow = document.createElement('div');
        topRow.style.display = 'flex';
        topRow.style.alignItems = 'center';
        topRow.style.justifyContent = 'space-between';
        topRow.style.gap = '6px';
        topRow.style.cursor = 'grab';

        const leftHeader = document.createElement('div');
        leftHeader.style.display = 'flex';
        leftHeader.style.alignItems = 'center';
        leftHeader.style.gap = '3px';

        const dragHandle = document.createElement('span');
        dragHandle.textContent = '⋮⋮';
        dragHandle.style.color = '#64748b';
        dragHandle.style.fontSize = '9px';
        leftHeader.appendChild(dragHandle);

        const titleSpan = document.createElement('span');
        titleSpan.className = 'viewport-colorbar-title';
        titleSpan.style.fontWeight = '700';
        titleSpan.style.color = '#38bdf8';
        titleSpan.style.cursor = 'pointer';
        titleSpan.style.fontSize = '8.5px';
        titleSpan.style.letterSpacing = '0.3px';
        titleSpan.style.whiteSpace = 'nowrap';
        titleSpan.onclick = (e) => {
            e.stopPropagation();
            const curModel = getModel();
            const curCh = Number(this.buildContourConfig(curModel, pane.workerConfigOverrides || {}).channel ?? 0);
            const hasMPM = Boolean(curModel?.nodes.some(n => n.type === 'MPMDomain2D' || n.type === 'MPMObject2D' || n.type === 'FSICoupler2D'));
            const hasCFD = Boolean(curModel?.nodes.some(n => n.type === 'CFDSolver2D' || n.type === 'FSICoupler2D')) || !hasMPM;
            const menuItems: { value: string; label: string; active: boolean }[] = [];
            if (hasCFD) {
                menuItems.push(
                    { value: '0', label: '🌡️ Pressure P (Pa)', active: curCh === 0 },
                    { value: '10', label: '💥 Overpressure ΔP (Pa)', active: curCh === 10 },
                    { value: '1', label: '🧱 Density ρ (kg/m³)', active: curCh === 1 },
                    { value: '9', label: '💨 Velocity Mag |u| (m/s)', active: curCh === 9 },
                    { value: '2', label: '➡️ Radial Vel u_r (m/s)', active: curCh === 2 },
                    { value: '3', label: '⬆️ Axial Vel u_z (m/s)', active: curCh === 3 },
                    { value: '4', label: '⚡ Specific Energy e (J/kg)', active: curCh === 4 },
                    { value: '5', label: '🔥 Reacted Products α₁', active: curCh === 5 },
                    { value: '6', label: '🧨 Unreacted Solid α₂', active: curCh === 6 }
                );
            }
            if (hasMPM) {
                menuItems.push(
                    { value: '7', label: '🔩 MPM von Mises (Pa)', active: curCh === 7 },
                    { value: '8', label: '🔧 MPM Plastic ε_p', active: curCh === 8 }
                );
            }
            this.showFloatingMenuPopover(titleSpan, menuItems, (val) => {
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), channel: Number(val) };
                this.syncPaneWorkerConfig(pane);
                this.saveStageOptions();
                (window as any).transportController?.requestTabRender?.();
            });
        };
        leftHeader.appendChild(titleSpan);
        topRow.appendChild(leftHeader);

        const closeBtn = document.createElement('span');
        closeBtn.textContent = '✕';
        closeBtn.title = 'Hide Color Bar (re-enable from Workstation Bar)';
        closeBtn.style.fontSize = '9px';
        closeBtn.style.fontWeight = 'bold';
        closeBtn.style.color = '#94a3b8';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.padding = '0 2px';
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), showColorbar: false };
            this.syncPaneWorkerConfig(pane);
            this.saveStageOptions();
            (window as any).transportController?.requestTabRender?.();
        };
        topRow.appendChild(closeBtn);

        topRow.onmousedown = (e: MouseEvent) => {
            if (e.target === closeBtn || e.target === titleSpan) return;
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX;
            const startY = e.clientY;
            const origLeft = container.offsetLeft;
            const origTop = container.offsetTop;
            const onMove = (me: MouseEvent) => {
                container.style.left = `${Math.max(4, origLeft + me.clientX - startX)}px`;
                container.style.top = `${Math.max(4, origTop + me.clientY - startY)}px`;
            };
            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        };
        card.appendChild(topRow);

        const openColormapMenu = (anchor: HTMLElement) => {
            const cfg = this.buildContourConfig(getModel(), pane.workerConfigOverrides || {});
            const cur = String(cfg.colormap || 'rainbow');
            const curLevels = Number(cfg.contourLevels ?? 0);
            const isSmooth = curLevels <= 1;
            const cmaps = ['rainbow', 'plasma', 'viridis', 'turbo', 'inferno', 'coolwarm', 'jet', 'magma', 'cividis', 'grayscale'];
            const items = [
                { value: '__toggle_auto', label: `⚙️ Range: ${cfg.autoScale ? 'AUTO' : 'MANUAL'}`, active: Boolean(cfg.autoScale) },
                { value: '__toggle_log', label: `📐 Scale: ${cfg.logScale ? 'LOG' : 'LINEAR'}`, active: Boolean(cfg.logScale) },
                { value: '__toggle_bands', label: `📊 Bands: ${isSmooth ? 'CONTINUOUS' : `${curLevels} BANDS`}`, active: !isSmooth },
                ...cmaps.map(c => ({
                    value: c,
                    label: `🎨 ${c.charAt(0).toUpperCase() + c.slice(1)}`,
                    active: c === cur
                }))
            ];
            this.showFloatingMenuPopover(anchor, items, (picked) => {
                if (picked === '__toggle_auto') {
                    const nextAuto = !cfg.autoScale;
                    const seedMin = pane.liveBounds ? pane.liveBounds.min : Number(cfg.minVal ?? 0);
                    const seedMax = pane.liveBounds ? pane.liveBounds.max : Number(cfg.maxVal ?? 1e6);
                    pane.workerConfigOverrides = {
                        ...(pane.workerConfigOverrides || {}),
                        autoScale: nextAuto,
                        ...(!nextAuto ? { minVal: seedMin, maxVal: seedMax, min: seedMin, max: seedMax } : {})
                    };
                } else if (picked === '__toggle_log') {
                    pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), logScale: !cfg.logScale };
                } else if (picked === '__toggle_bands') {
                    const cycle = [0, 5, 8, 10, 12, 16, 20, 24, 32];
                    const idx = cycle.indexOf(curLevels <= 1 ? 0 : curLevels);
                    const next = cycle[(idx + 1) % cycle.length];
                    pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), contourLevels: next };
                } else {
                    pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), colormap: picked };
                }
                this.syncPaneWorkerConfig(pane);
                this.saveStageOptions();
                (window as any).transportController?.requestTabRender?.();
            });
        };

        // 2. Body Row (10x120 Gradient Bar + 5 Ticks with Editable Min/Max)
        const bodyRow = document.createElement('div');
        bodyRow.style.display = 'flex';
        bodyRow.style.alignItems = 'stretch';
        bodyRow.style.gap = '4px';

        const gradBar = document.createElement('div');
        gradBar.className = 'viewport-colorbar-grad-bar';
        gradBar.title = 'Click to configure Colormap & Scale options';
        gradBar.style.width = '10px';
        gradBar.style.height = '120px';
        gradBar.style.borderRadius = '2px';
        gradBar.style.border = '1px solid rgba(255, 255, 255, 0.2)';
        gradBar.style.boxShadow = 'inset 0 0 3px rgba(0,0,0,0.5)';
        gradBar.style.cursor = 'pointer';
        gradBar.onclick = (e) => {
            e.stopPropagation();
            openColormapMenu(gradBar);
        };
        bodyRow.appendChild(gradBar);

        const ticksCol = document.createElement('div');
        ticksCol.className = 'viewport-colorbar-ticks-col';
        ticksCol.style.display = 'flex';
        ticksCol.style.flexDirection = 'column';
        ticksCol.style.justifyContent = 'space-between';
        ticksCol.style.height = '120px';

        for (let i = 0; i < 5; i++) {
            const tickRow = document.createElement('div');
            tickRow.style.display = 'flex';
            tickRow.style.alignItems = 'center';
            tickRow.style.gap = '5px';
            tickRow.style.height = '14px';

            const tickLine = document.createElement('div');
            tickLine.style.width = '4px';
            tickLine.style.height = '1.5px';
            tickLine.style.background = 'rgba(255,255,255,0.45)';
            tickLine.style.flexShrink = '0';
            tickRow.appendChild(tickLine);

            if (i === 0 || i === 4) {
                const isMax = i === 0;
                const inp = document.createElement('input');
                inp.type = 'text';
                inp.className = 'viewport-colorbar-input';
                inp.dataset.tickRole = isMax ? 'max' : 'min';
                inp.style.width = '50px';
                inp.style.height = '13px';
                inp.style.background = 'rgba(0,0,0,0.45)';
                inp.style.border = '1px solid rgba(255,255,255,0.15)';
                inp.style.borderRadius = '2px';
                inp.style.color = '#38bdf8';
                inp.style.fontFamily = "'JetBrains Mono', monospace";
                inp.style.fontSize = '8px';
                inp.style.padding = '0 2px';
                inp.style.boxSizing = 'border-box';
                inp.style.outline = 'none';
                inp.title = isMax ? 'Edit Maximum (switches to Manual range)' : 'Edit Minimum (switches to Manual range)';
                inp.onfocus = () => inp.select();
                inp.onblur = () => {
                    const parsed = Number(inp.value);
                    if (isFinite(parsed) && inp.value.trim() !== '') {
                        const cfg = this.buildContourConfig(getModel(), pane.workerConfigOverrides || {});
                        const curMin = pane.liveBounds && cfg.autoScale ? pane.liveBounds.min : Number(cfg.minVal ?? 0);
                        const curMax = pane.liveBounds && cfg.autoScale ? pane.liveBounds.max : Number(cfg.maxVal ?? 1e6);
                        const nextMin = isMax ? curMin : parsed;
                        const nextMax = isMax ? parsed : curMax;
                        pane.workerConfigOverrides = {
                            ...(pane.workerConfigOverrides || {}),
                            autoScale: false,
                            minVal: nextMin,
                            maxVal: nextMax,
                            min: nextMin,
                            max: nextMax
                        };
                        this.syncPaneWorkerConfig(pane);
                        this.saveStageOptions();
                        (window as any).transportController?.requestTabRender?.();
                    } else {
                        this.updateContourColorbarCard(pane, getModel());
                    }
                };
                inp.onkeydown = (e) => {
                    if (e.key === 'Enter') inp.blur();
                    else if (e.key === 'Escape') {
                        this.updateContourColorbarCard(pane, getModel());
                        inp.blur();
                    }
                };
                tickRow.appendChild(inp);
            } else {
                const sp = document.createElement('span');
                sp.dataset.tickRole = 'intermediate';
                sp.dataset.tickIndex = String(i);
                sp.style.fontSize = '8px';
                sp.style.fontFamily = "'JetBrains Mono', monospace";
                sp.style.color = '#94a3b8';
                sp.style.lineHeight = '13px';
                sp.style.whiteSpace = 'nowrap';
                tickRow.appendChild(sp);
            }
            ticksCol.appendChild(tickRow);
        }

        bodyRow.appendChild(ticksCol);
        card.appendChild(bodyRow);
        container.appendChild(card);
        host.appendChild(container);
        pane.colorbarCard = card;
    }

    /**
     * Mounts a compact top-right floating navigation bar inside 2D Contour panes
     * with 1-click Zoom, Box-Zoom, Fit, Space-Filling vs 1:1 Aspect, Axisymmetric Mirror,
     * Mesh/AMR Grid, Automatic Peak/Trough Markers, and Side-by-Side Gauge Waveforms.
     */
    private mountContourNavPill(host: HTMLElement, pane: ViewportPane): void {
        const nav = document.createElement('div');
        nav.className = 'viewport-floating-nav-pill';
        nav.style.position = 'absolute';
        nav.style.top = '10px';
        nav.style.right = '10px';
        nav.style.zIndex = '20';
        nav.style.display = 'flex';
        nav.style.flexWrap = 'wrap';
        nav.style.alignItems = 'center';
        nav.style.gap = '3px';
        nav.style.padding = '3px 5px';
        nav.style.background = 'rgba(14, 15, 19, 0.88)';
        nav.style.backdropFilter = 'blur(12px)';
        nav.style.border = '1px solid rgba(255, 255, 255, 0.14)';
        nav.style.borderRadius = '6px';
        nav.style.boxShadow = '0 4px 14px rgba(0, 0, 0, 0.5)';
        nav.style.userSelect = 'none';
        nav.addEventListener('mousedown', e => e.stopPropagation());
        nav.addEventListener('wheel', e => e.stopPropagation());
        nav.addEventListener('dblclick', e => e.stopPropagation());

        const getModel = () => {
            const allModels = this.stateManager.getWorkspaceModels();
            return allModels.find(m => m.id === pane.modelId) || allModels[0] || null;
        };

        const mkBtn = (cls: string, label: string, tip: string, onClick: () => void) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = cls;
            b.textContent = label;
            b.title = tip;
            b.style.background = 'rgba(255, 255, 255, 0.06)';
            b.style.color = '#e2e8f0';
            b.style.border = '1px solid rgba(255, 255, 255, 0.12)';
            b.style.borderRadius = '4px';
            b.style.fontSize = '9px';
            b.style.fontWeight = '600';
            b.style.padding = '2px 6px';
            b.style.cursor = 'pointer';
            b.style.lineHeight = '1.2';
            b.onclick = (e) => {
                e.stopPropagation();
                onClick();
            };
            return b;
        };

        nav.appendChild(mkBtn('contour-nav-zin', '＋', 'Zoom In (Mouse Wheel Up)', () => {
            pane.worker?.postMessage({ type: 'zoom', factor: 1.25 });
        }));
        nav.appendChild(mkBtn('contour-nav-zout', '－', 'Zoom Out (Mouse Wheel Down)', () => {
            pane.worker?.postMessage({ type: 'zoom', factor: 0.8 });
        }));
        nav.appendChild(mkBtn('contour-nav-box', '⬚ Box', 'Toggle Rubberband Box-Zoom Mode (or Shift+Drag / Right-Drag anytime)', () => {
            const nextMode = pane.workerConfigOverrides?.interactionMode === 'boxZoom' ? 'pan' : 'boxZoom';
            pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), interactionMode: nextMode };
            host.style.cursor = nextMode === 'boxZoom' ? 'crosshair' : 'grab';
            this.syncPaneWorkerConfig(pane);
        }));
        nav.appendChild(mkBtn('contour-nav-fit', '🏠 Fit', 'Reset / Fit Domain to Full Viewport (Double-Click Canvas)', () => {
            pane.worker?.postMessage({ type: 'resetView' });
        }));
        nav.appendChild(mkBtn('contour-nav-interp', '〰️ Smooth', 'Toggle Bilinear Smooth Interpolation vs Discrete Cell Pixels (1:1 Square Cells)', () => {
            const cfg = this.buildContourConfig(getModel(), pane.workerConfigOverrides || {});
            pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), interpolate: !cfg.interpolate };
            this.syncPaneWorkerConfig(pane);
            this.saveStageOptions();
            (window as any).transportController?.requestTabRender?.();
        }));
        nav.appendChild(mkBtn('contour-nav-mirror', '⇄ Mirror', 'Toggle Axisymmetric R-Z Mirror vs Half-Domain', () => {
            const cfg = this.buildContourConfig(getModel(), pane.workerConfigOverrides || {});
            pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), isAxisymmetric: !cfg.isAxisymmetric };
            this.syncPaneWorkerConfig(pane);
            this.saveStageOptions();
            (window as any).transportController?.requestTabRender?.();
        }));
        nav.appendChild(mkBtn('contour-nav-grid', '# Grid', 'Toggle Computational Mesh / AMR Tile Overlay', () => {
            const cfg = this.buildContourConfig(getModel(), pane.workerConfigOverrides || {});
            pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), showGridlines: !cfg.showGridlines };
            this.syncPaneWorkerConfig(pane);
            this.saveStageOptions();
            (window as any).transportController?.requestTabRender?.();
        }));
        nav.appendChild(mkBtn('contour-nav-peaks', '▲▼ Peaks', 'Toggle Automatic Domain Peak (▲) & Trough (▼) Markers', () => {
            const cfg = this.buildContourConfig(getModel(), pane.workerConfigOverrides || {});
            pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), showExtrema: !cfg.showExtrema };
            this.syncPaneWorkerConfig(pane);
            this.saveStageOptions();
            (window as any).transportController?.requestTabRender?.();
        }));
        nav.appendChild(mkBtn('contour-nav-gauges', '🎯 Gauges', 'Open Virtual Gauge Waveforms f(t) Side-by-Side', () => {
            if (this.activePreset === '1x1') {
                this.setPreset('1x2');
            } else {
                this.openGaugeWaveformView(pane.modelId || undefined);
            }
        }));

        host.appendChild(nav);
        pane.contourNavPill = nav;
    }

    private updateContourNavPill(pane: ViewportPane, model: Model | null): void {
        const nav = pane.contourNavPill;
        if (!nav) return;
        const cfg = this.buildContourConfig(model, pane.workerConfigOverrides || {});

        const styleToggle = (sel: string, active: boolean, labelText?: string) => {
            const el = nav.querySelector(sel) as HTMLButtonElement | null;
            if (!el) return;
            if (labelText !== undefined) el.textContent = labelText;
            el.style.background = active ? 'rgba(56, 189, 248, 0.22)' : 'rgba(255, 255, 255, 0.06)';
            el.style.color = active ? '#38bdf8' : '#e2e8f0';
            el.style.borderColor = active ? 'rgba(56, 189, 248, 0.55)' : 'rgba(255, 255, 255, 0.12)';
        };

        styleToggle('.contour-nav-box', pane.workerConfigOverrides?.interactionMode === 'boxZoom');
        styleToggle('.contour-nav-interp', Boolean(cfg.interpolate));
        styleToggle('.contour-nav-mirror', Boolean(cfg.isAxisymmetric));
        styleToggle('.contour-nav-grid', Boolean(cfg.showGridlines));
        styleToggle('.contour-nav-peaks', Boolean(cfg.showExtrema));
    }

    private ensureDefaultProbesOnModel(model: Model): void {
        const is3D = model.nodes.some(n => isDomainMesh3DNode(n.type) || n.type === 'CFDSolver3D' || n.type === 'MarineHarbourDomain' || n.type === 'MPMDomain3D' || n.type === 'FEMDomain3D');
        const is2D = !is3D && model.nodes.some(n => isDomainMesh2DNode(n.type) || n.type === 'CFDSolver2D' || n.type === 'MPMDomain2D' || n.type === 'FSICoupler2D');

        const ownerNode = model.nodes.find(n => n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D')
            || model.nodes.find(n => isDomainMesh2DNode(n.type) || isDomainMesh3DNode(n.type) || n.type === 'DomainMesh' || n.type === 'MarineHarbourDomain' || n.type === 'MPMDomain2D' || n.type === 'MPMDomain3D');
        if (!ownerNode) return;

        const meshNode = model.nodes.find(n => isDomainMesh2DNode(n.type) || isDomainMesh3DNode(n.type) || n.type === 'DomainMesh' || n.type === 'MarineHarbourDomain');
        let newProbes: any[] = [];
        if (is3D) {
            const xmin = Number(meshNode?.parameters?.xmin ?? -1.0);
            const xmax = Number(meshNode?.parameters?.xmax ?? 1.0);
            const ymid = 0.5 * (Number(meshNode?.parameters?.ymin ?? -1.0) + Number(meshNode?.parameters?.ymax ?? 1.0));
            const zmid = 0.5 * (Number(meshNode?.parameters?.zmin ?? -1.0) + Number(meshNode?.parameters?.zmax ?? 1.0));
            const span = Math.max(0.2, xmax - xmin);
            newProbes = [0.25, 0.5, 0.75].map((f, i) => ({
                id: `G${i + 1}`,
                name: `G${i + 1}`,
                x: Number((xmin + f * span).toFixed(3)),
                y: Number(ymid.toFixed(3)),
                z: Number(zmid.toFixed(3)),
                active: true,
                plot: true,
                is_3d: true
            }));
        } else if (is2D) {
            const maxR = Number(meshNode?.parameters?.max_r ?? meshNode?.parameters?.domain_width ?? 1.0) || 1.0;
            const minZ = Number(meshNode?.parameters?.min_z ?? 0.0) || 0.0;
            const maxZ = Number(meshNode?.parameters?.max_z ?? meshNode?.parameters?.domain_height ?? maxR) || maxR;
            const chargeNode = model.nodes.find(n => n.type === 'Charge2D');
            const zMid = Number(chargeNode?.parameters?.z_offset ?? chargeNode?.parameters?.center_z ?? (0.5 * (minZ + maxZ)));
            newProbes = [0.25, 0.5, 0.75].map((f, i) => ({
                id: `G${i + 1}`,
                name: `G${i + 1}`,
                r: Number((f * maxR).toFixed(3)),
                z: Number(zMid.toFixed(3)),
                active: true,
                plot: true
            }));
        } else {
            const maxR = Number(meshNode?.parameters?.domain_radius ?? 1.0) || 1.0;
            newProbes = [0.25, 0.5, 0.75].map((f, i) => ({
                id: `G${i + 1}`,
                name: `G${i + 1}`,
                r: Number((f * maxR).toFixed(3)),
                active: true,
                plot: true
            }));
        }

        this.stateManager.updateNodeParameters(ownerNode.id, { gauges: newProbes });
        this.stateManager.setModelStatus(model.id, 'UNINITIALIZED');
    }

    private openGaugeManagerForModel(pane: ViewportPane, model: Model | null): void {
        if (!model) return;
        const ownerNode = model.nodes.find(n => n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D')
            || model.nodes.find(n => isDomainMesh2DNode(n.type) || isDomainMesh3DNode(n.type) || n.type === 'DomainMesh' || n.type === 'MarineHarbourDomain' || n.type === 'MPMDomain2D' || n.type === 'MPMDomain3D');
        if (!ownerNode) return;
        new GaugeManagerModal(this.stateManager, ownerNode, model, null, () => {
            this.syncPaneWorkerConfig(pane);
            (window as any).transportController?.requestTabRender?.();
        });
    }

    /**
     * Mounts the 3D-style Floating Glassmorphic Chart Control & Interactive Probe Legend Card
     * inside 1D_CHART and GAUGE_CHART panes. Supports:
     * - 1-click Quantity switching (P, ΔP, Impulse I, ρ, |u|, e, α₁, α₂, Air)
     * - AUTO / MAN Y-scale with editable Min / Max inputs + LIN / LOG toggle
     * - 1-click Zoom In, Zoom Out, Rubberband Box-Zoom mode, and Fit/Reset
     * - Interactive Probe Legend: click checkbox/row to toggle ON/OFF, click ◎ (or double-click) to Solo,
     *   hover row to glow-highlight curve on canvas, Master checkbox + All / None bulk toggles, and 1-click Probe Manager!
     */
    private mountChartControlCard(host: HTMLElement, pane: ViewportPane): void {
        const container = document.createElement('div');
        container.className = 'viewport-chart-card-container';
        container.style.position = 'absolute';
        container.style.top = '10px';
        container.style.right = '10px';
        container.style.zIndex = '20';
        container.style.pointerEvents = 'none';

        const card = document.createElement('div');
        card.className = 'viewport-chart-control-card';
        card.style.background = 'rgba(14, 15, 19, 0.90)';
        card.style.backdropFilter = 'blur(12px)';
        card.style.border = '1px solid rgba(255, 255, 255, 0.14)';
        card.style.borderRadius = '6px';
        card.style.padding = '5px 7px';
        card.style.display = 'flex';
        card.style.flexDirection = 'column';
        card.style.gap = '4px';
        card.style.color = '#e2e8f0';
        card.style.fontFamily = 'system-ui, -apple-system, sans-serif';
        card.style.fontSize = '9.5px';
        card.style.boxShadow = '0 4px 18px rgba(0, 0, 0, 0.58)';
        card.style.userSelect = 'none';
        card.style.boxSizing = 'border-box';
        card.style.pointerEvents = 'auto';
        card.style.minWidth = '210px';
        card.style.maxWidth = '265px';
        card.addEventListener('mousedown', e => e.stopPropagation());
        card.addEventListener('wheel', e => e.stopPropagation());
        card.addEventListener('dblclick', e => e.stopPropagation());

        const getModel = () => {
            const all = this.stateManager.getWorkspaceModels();
            return all.find(m => m.id === pane.modelId) || all[0] || null;
        };

        const persistProbePlotFlags = (hiddenIndices: Set<number>) => {
            const curModel = getModel();
            if (!curModel) return false;
            const ownerNode = curModel.nodes.find(n => n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D')
                || curModel.nodes.find(n => Array.isArray(n.parameters?.gauges) && n.parameters.gauges.length > 0);
            const rawGauges = ownerNode && Array.isArray(ownerNode.parameters?.gauges) ? ownerNode.parameters.gauges : null;
            if (!ownerNode || !rawGauges || rawGauges.length === 0) return false;
            const updated = rawGauges.map((g: any, i: number) => ({
                ...g,
                plot: !hiddenIndices.has(i)
            }));
            this.stateManager.updateNodeParametersInPlace(ownerNode.id, { gauges: updated });
            return true;
        };

        // 1. Header Row: Drag Handle + Quantity Picker + Collapse / Close Buttons
        const topRow = document.createElement('div');
        topRow.style.display = 'flex';
        topRow.style.alignItems = 'center';
        topRow.style.justifyContent = 'space-between';
        topRow.style.gap = '6px';
        topRow.style.cursor = 'grab';

        const leftHdr = document.createElement('div');
        leftHdr.style.display = 'flex';
        leftHdr.style.alignItems = 'center';
        leftHdr.style.gap = '4px';
        leftHdr.style.minWidth = '0';

        const dragHandle = document.createElement('span');
        dragHandle.textContent = '⋮⋮';
        dragHandle.style.color = '#64748b';
        dragHandle.style.fontSize = '9px';
        leftHdr.appendChild(dragHandle);

        const qtyBtn = document.createElement('span');
        qtyBtn.className = 'chart-card-qty-title';
        qtyBtn.style.fontWeight = '700';
        qtyBtn.style.color = '#38bdf8';
        qtyBtn.style.cursor = 'pointer';
        qtyBtn.style.fontSize = '9.5px';
        qtyBtn.style.letterSpacing = '0.2px';
        qtyBtn.style.whiteSpace = 'nowrap';
        qtyBtn.style.overflow = 'hidden';
        qtyBtn.style.textOverflow = 'ellipsis';
        qtyBtn.onclick = (e) => {
            e.stopPropagation();
            const curModel = getModel();
            const cfg = this.buildChartConfig(curModel, pane.workerConfigOverrides || {}, pane.viewType);
            const curCh = Number(cfg.channel ?? 0);
            let items: { value: string; label: string; active: boolean }[];
            if (cfg.chartMode === 'gauges') {
                const vgNode = curModel?.nodes.find(n => n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D');
                const allGaugeItems = [
                    { value: '0', param: 'qty_pressure',     label: '🌡️ Pressure P(t) [Pa]',         active: curCh === 0 },
                    { value: '7', param: 'qty_overpressure', label: '💥 Overpressure ΔP(t) [Pa]',    active: curCh === 7 },
                    { value: '8', param: 'qty_impulse',      label: '⚡ Specific Impulse I(t) [Pa·s]', active: curCh === 8 },
                    { value: '1', param: 'qty_density',      label: '🧱 Density ρ(t) [kg/m³]',       active: curCh === 1 },
                    { value: '2', param: 'qty_velocity',     label: '💨 Velocity |u|(t) [m/s]',      active: curCh === 2 },
                    { value: '3', param: 'qty_energy',       label: '🔥 Internal Energy e(t) [J/kg]', active: curCh === 3 },
                    { value: '4', param: 'qty_reacted',      label: '🧪 Reacted Products α₁(t)',     active: curCh === 4 },
                    { value: '5', param: 'qty_unreacted',    label: '🧨 Unreacted Solid α₂(t)',      active: curCh === 5 },
                    { value: '6', param: 'qty_air',          label: '🌬️ Ambient Air α_air(t)',       active: curCh === 6 }
                ];
                const filtered = vgNode ? allGaugeItems.filter(it => vgNode.parameters?.[it.param] !== false) : allGaugeItems;
                items = filtered.length > 0 ? filtered : allGaugeItems;
            } else {
                items = [
                    { value: '0', label: '🌡️ Pressure P(r) [Pa]',         active: curCh === 0 },
                    { value: '8', label: '💥 Overpressure ΔP(r) [Pa]',    active: curCh === 8 },
                    { value: '1', label: '🧱 Density ρ(r) [kg/m³]',       active: curCh === 1 },
                    { value: '2', label: '💨 Radial Velocity u_r(r) [m/s]', active: curCh === 2 },
                    { value: '3', label: '⚡ Internal Energy e(r) [J/kg]', active: curCh === 3 },
                    { value: '4', label: '🧪 All Species (α₁, α₂, Air)',  active: curCh === 4 },
                    { value: '5', label: '🔥 Reacted Products α₁(r)',     active: curCh === 5 },
                    { value: '6', label: '🧨 Unreacted Solid α₂(r)',      active: curCh === 6 },
                    { value: '7', label: '🌬️ Ambient Air α_air(r)',       active: curCh === 7 }
                ];
            }
            this.showFloatingMenuPopover(qtyBtn, items, (picked) => {
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), channel: Number(picked) };
                this.syncPaneWorkerConfig(pane);
                this.saveStageOptions();
                (window as any).transportController?.requestTabRender?.();
            });
        };
        leftHdr.appendChild(qtyBtn);
        topRow.appendChild(leftHdr);

        const bodyWrap = document.createElement('div');
        bodyWrap.className = 'chart-card-body-wrap';
        bodyWrap.style.display = 'flex';
        bodyWrap.style.flexDirection = 'column';
        bodyWrap.style.gap = '4px';

        const hdrRight = document.createElement('div');
        hdrRight.style.display = 'flex';
        hdrRight.style.alignItems = 'center';
        hdrRight.style.gap = '2px';

        let collapsed = false;
        const collapseBtn = document.createElement('span');
        collapseBtn.textContent = '–';
        collapseBtn.title = 'Collapse / Expand Chart Controls';
        collapseBtn.style.fontSize = '11px';
        collapseBtn.style.fontWeight = '700';
        collapseBtn.style.color = '#94a3b8';
        collapseBtn.style.cursor = 'pointer';
        collapseBtn.style.padding = '0 3px';
        collapseBtn.onclick = (e) => {
            e.stopPropagation();
            collapsed = !collapsed;
            bodyWrap.style.display = collapsed ? 'none' : 'flex';
            collapseBtn.textContent = collapsed ? '+' : '–';
        };
        hdrRight.appendChild(collapseBtn);

        const closeBtn = document.createElement('span');
        closeBtn.textContent = '✕';
        closeBtn.title = 'Hide Chart Controls Panel (re-enable via Workstation Bar Panel toggle)';
        closeBtn.style.fontSize = '9.5px';
        closeBtn.style.fontWeight = '700';
        closeBtn.style.color = '#64748b';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.padding = '0 2px';
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), showChartCard: false };
            this.syncPaneWorkerConfig(pane);
            this.saveStageOptions();
            (window as any).transportController?.requestTabRender?.();
        };
        hdrRight.appendChild(closeBtn);
        topRow.appendChild(hdrRight);

        topRow.onmousedown = (e: MouseEvent) => {
            if (e.target === collapseBtn || e.target === closeBtn || e.target === qtyBtn) return;
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX;
            const startY = e.clientY;
            const hostRect = host.getBoundingClientRect();
            const contRect = container.getBoundingClientRect();
            container.style.right = 'auto';
            const origLeft = contRect.left - hostRect.left;
            const origTop = contRect.top - hostRect.top;
            container.style.left = `${origLeft}px`;
            container.style.top = `${origTop}px`;
            const onMove = (me: MouseEvent) => {
                const maxL = Math.max(4, host.clientWidth - container.offsetWidth - 4);
                const maxT = Math.max(4, host.clientHeight - container.offsetHeight - 4);
                container.style.left = `${Math.max(4, Math.min(maxL, origLeft + me.clientX - startX))}px`;
                container.style.top = `${Math.max(4, Math.min(maxT, origTop + me.clientY - startY))}px`;
            };
            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        };
        card.appendChild(topRow);

        // 2. Navigation & Scale Toolbar Row: [+][-][Box][Peaks][Fit] + [AUTO][LOG]
        const navRow = document.createElement('div');
        navRow.style.display = 'flex';
        navRow.style.alignItems = 'center';
        navRow.style.justifyContent = 'space-between';
        navRow.style.gap = '3px';

        const mkPill = (cls: string, label: string, tip: string, onClick: () => void) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = cls;
            b.textContent = label;
            b.title = tip;
            b.style.background = 'rgba(255, 255, 255, 0.07)';
            b.style.color = '#cbd5e1';
            b.style.border = '1px solid rgba(255, 255, 255, 0.14)';
            b.style.borderRadius = '3px';
            b.style.fontSize = '8.5px';
            b.style.fontWeight = '700';
            b.style.padding = '2px 4px';
            b.style.cursor = 'pointer';
            b.style.lineHeight = '1.15';
            b.onclick = (e) => {
                e.stopPropagation();
                onClick();
            };
            return b;
        };

        const navGroup = document.createElement('div');
        navGroup.style.display = 'flex';
        navGroup.style.alignItems = 'center';
        navGroup.style.gap = '2px';

        navGroup.appendChild(mkPill('chart-nav-zin', '＋', 'Zoom In (or scroll wheel)', () => {
            pane.worker?.postMessage({ type: 'zoom', factor: 1.28 });
        }));
        navGroup.appendChild(mkPill('chart-nav-zout', '－', 'Zoom Out (or scroll wheel)', () => {
            pane.worker?.postMessage({ type: 'zoom', factor: 0.78 });
        }));
        const boxBtn = mkPill('chart-nav-box', '⬚ Box', 'Toggle Rubberband Box-Zoom Mode (or hold Shift + Drag / Right-Drag anytime)', () => {
            const cur = pane.workerConfigOverrides?.interactionMode === 'boxZoom' ? 'pan' : 'boxZoom';
            pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), interactionMode: cur };
            host.style.cursor = cur === 'boxZoom' ? 'crosshair' : 'grab';
            this.syncPaneWorkerConfig(pane);
        });
        navGroup.appendChild(boxBtn);
        navGroup.appendChild(mkPill('chart-nav-peaks', '▲▼', 'Toggle Automatic Peak (▲) & Trough (▼) Curve Callout Markers', () => {
            const cfg = this.buildChartConfig(getModel(), pane.workerConfigOverrides || {}, pane.viewType);
            pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), showPeaks: !cfg.showPeaks };
            this.syncPaneWorkerConfig(pane);
            this.saveStageOptions();
            (window as any).transportController?.requestTabRender?.();
        }));
        navGroup.appendChild(mkPill('chart-nav-fit', '🏠 Fit', 'Reset X & Y Zoom to Fit Full Waveform (or Double-Click Plot)', () => {
            pane.worker?.postMessage({ type: 'resetView' });
        }));
        navRow.appendChild(navGroup);

        const scaleGroup = document.createElement('div');
        scaleGroup.style.display = 'flex';
        scaleGroup.style.alignItems = 'center';
        scaleGroup.style.gap = '2px';

        const autoBtn = mkPill('chart-scale-auto', 'AUTO', 'Toggle Automatic vs Manual Y-Axis Range', () => {
            const cfg = this.buildChartConfig(getModel(), pane.workerConfigOverrides || {}, pane.viewType);
            const nextAuto = !cfg.autoScale;
            const seedMin = pane.liveBounds ? pane.liveBounds.min : Number(cfg.min ?? 0);
            const seedMax = pane.liveBounds ? pane.liveBounds.max : Number(cfg.max ?? 1e6);
            pane.workerConfigOverrides = {
                ...(pane.workerConfigOverrides || {}),
                autoScale: nextAuto,
                autoScaleY: nextAuto,
                ...(!nextAuto ? { min: seedMin, max: seedMax, minVal: seedMin, maxVal: seedMax } : {})
            };
            if (nextAuto) {
                pane.worker?.postMessage({ type: 'resetView' });
            }
            this.syncPaneWorkerConfig(pane);
            this.saveStageOptions();
            (window as any).transportController?.requestTabRender?.();
        });
        const logBtn = mkPill('chart-scale-log', 'LIN', 'Toggle Linear vs Logarithmic Y-Axis Scale', () => {
            const cfg = this.buildChartConfig(getModel(), pane.workerConfigOverrides || {}, pane.viewType);
            pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), logScale: !cfg.logScale };
            this.syncPaneWorkerConfig(pane);
            this.saveStageOptions();
            (window as any).transportController?.requestTabRender?.();
        });
        scaleGroup.appendChild(autoBtn);
        scaleGroup.appendChild(logBtn);
        navRow.appendChild(scaleGroup);
        bodyWrap.appendChild(navRow);

        // 3. Manual Y-Range Inputs Row (shown when MAN or Y-zoomed)
        const rangeRow = document.createElement('div');
        rangeRow.className = 'chart-card-range-row';
        rangeRow.style.display = 'none';
        rangeRow.style.alignItems = 'center';
        rangeRow.style.justifyContent = 'space-between';
        rangeRow.style.gap = '4px';
        rangeRow.style.fontSize = '8.5px';
        rangeRow.style.color = '#94a3b8';

        const mkRangeInput = (role: 'min' | 'max', placeholder: string) => {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.dataset.rangeRole = role;
            inp.placeholder = placeholder;
            inp.style.width = '68px';
            inp.style.height = '16px';
            inp.style.background = 'rgba(0, 0, 0, 0.45)';
            inp.style.border = '1px solid rgba(255, 255, 255, 0.16)';
            inp.style.borderRadius = '3px';
            inp.style.color = '#38bdf8';
            inp.style.fontFamily = "'JetBrains Mono', monospace";
            inp.style.fontSize = '8.5px';
            inp.style.padding = '0 4px';
            inp.style.outline = 'none';
            inp.onfocus = () => inp.select();
            inp.onblur = () => {
                const parsed = Number(inp.value);
                if (isFinite(parsed) && inp.value.trim() !== '') {
                    const cfg = this.buildChartConfig(getModel(), pane.workerConfigOverrides || {}, pane.viewType);
                    const curMin = pane.liveBounds ? pane.liveBounds.min : Number(cfg.min ?? 0);
                    const curMax = pane.liveBounds ? pane.liveBounds.max : Number(cfg.max ?? 1e6);
                    const nextMin = role === 'min' ? parsed : curMin;
                    const nextMax = role === 'max' ? parsed : curMax;
                    pane.workerConfigOverrides = {
                        ...(pane.workerConfigOverrides || {}),
                        autoScale: false,
                        autoScaleY: false,
                        min: nextMin,
                        max: nextMax,
                        minVal: nextMin,
                        maxVal: nextMax
                    };
                    this.syncPaneWorkerConfig(pane);
                    this.saveStageOptions();
                    (window as any).transportController?.requestTabRender?.();
                } else {
                    this.updateChartControlCard(pane, getModel());
                }
            };
            inp.onkeydown = (ke) => {
                ke.stopPropagation();
                if (ke.key === 'Enter') inp.blur();
            };
            return inp;
        };

        const minLbl = document.createElement('span');
        minLbl.textContent = 'Y Min:';
        const minInp = mkRangeInput('min', 'Min');
        const maxLbl = document.createElement('span');
        maxLbl.textContent = 'Max:';
        const maxInp = mkRangeInput('max', 'Max');
        rangeRow.appendChild(minLbl);
        rangeRow.appendChild(minInp);
        rangeRow.appendChild(maxLbl);
        rangeRow.appendChild(maxInp);
        bodyWrap.appendChild(rangeRow);

        // 4. Interactive Probes Section (shown in gauges mode)
        const probesSection = document.createElement('div');
        probesSection.className = 'chart-card-probes-section';
        probesSection.style.display = 'flex';
        probesSection.style.flexDirection = 'column';
        probesSection.style.gap = '3px';
        probesSection.style.borderTop = '1px solid rgba(255, 255, 255, 0.09)';
        probesSection.style.paddingTop = '4px';

        const probesHdr = document.createElement('div');
        probesHdr.style.display = 'flex';
        probesHdr.style.alignItems = 'center';
        probesHdr.style.justifyContent = 'space-between';
        probesHdr.style.gap = '4px';

        const probesHdrLeft = document.createElement('label');
        probesHdrLeft.style.cssText = 'display:inline-flex; align-items:center; gap:4px; cursor:pointer;';

        const masterProbeCheck = document.createElement('input');
        masterProbeCheck.type = 'checkbox';
        masterProbeCheck.className = 'chart-card-probes-master';
        masterProbeCheck.title = 'Toggle all virtual gauge probes ON / OFF';
        masterProbeCheck.style.cssText = 'margin:0; width:11px; height:11px; cursor:pointer; accent-color:#38bdf8;';
        masterProbeCheck.onclick = (ev) => ev.stopPropagation();
        masterProbeCheck.onchange = () => {
            const cfg = this.buildChartConfig(getModel(), pane.workerConfigOverrides || {}, pane.viewType);
            const total = Math.max(cfg.gauges?.length || 0, pane.lastProbeStats?.probes?.length || 0);
            const nextHidden = masterProbeCheck.checked
                ? new Set<number>()
                : new Set<number>(Array.from({ length: total }, (_, i) => i));
            pane.soloProbeIndex = -1;
            const persisted = persistProbePlotFlags(nextHidden);
            const nextOverrides: Record<string, any> = { ...(pane.workerConfigOverrides || {}), selectedProbe: -1 };
            if (persisted) delete nextOverrides.hiddenProbes;
            else nextOverrides.hiddenProbes = Array.from(nextHidden);
            pane.workerConfigOverrides = nextOverrides;
            this.syncPaneWorkerConfig(pane);
            this.saveStageOptions();
        };
        probesHdrLeft.appendChild(masterProbeCheck);

        const probesCountSpan = document.createElement('span');
        probesCountSpan.className = 'chart-card-probes-count';
        probesCountSpan.style.fontSize = '8.5px';
        probesCountSpan.style.fontWeight = '700';
        probesCountSpan.style.color = '#94a3b8';
        probesCountSpan.textContent = 'PROBES';
        probesHdrLeft.appendChild(probesCountSpan);
        probesHdr.appendChild(probesHdrLeft);

        const probesBtns = document.createElement('div');
        probesBtns.style.display = 'flex';
        probesBtns.style.alignItems = 'center';
        probesBtns.style.gap = '2px';

        probesBtns.appendChild(mkPill('probes-btn-all', 'All', 'Show all virtual gauge probes', () => {
            pane.soloProbeIndex = -1;
            const persisted = persistProbePlotFlags(new Set<number>());
            const nextOverrides: Record<string, any> = { ...(pane.workerConfigOverrides || {}), selectedProbe: -1 };
            if (persisted) delete nextOverrides.hiddenProbes;
            else nextOverrides.hiddenProbes = [];
            pane.workerConfigOverrides = nextOverrides;
            this.syncPaneWorkerConfig(pane);
            this.saveStageOptions();
        }));
        probesBtns.appendChild(mkPill('probes-btn-none', 'None', 'Hide all probes (click individual probes below to enable)', () => {
            const cfg = this.buildChartConfig(getModel(), pane.workerConfigOverrides || {}, pane.viewType);
            const total = Math.max(cfg.gauges?.length || 0, pane.lastProbeStats?.probes?.length || 0);
            const allIdxs = new Set<number>(Array.from({ length: total }, (_, i) => i));
            pane.soloProbeIndex = -1;
            const persisted = persistProbePlotFlags(allIdxs);
            const nextOverrides: Record<string, any> = { ...(pane.workerConfigOverrides || {}), selectedProbe: -1 };
            if (persisted) delete nextOverrides.hiddenProbes;
            else nextOverrides.hiddenProbes = Array.from(allIdxs);
            pane.workerConfigOverrides = nextOverrides;
            this.syncPaneWorkerConfig(pane);
            this.saveStageOptions();
        }));
        probesBtns.appendChild(mkPill('probes-btn-mgr', '⚙ Edit', 'Open Virtual Gauge Manager (Add/Edit/Rake/Export Probes)', () => {
            this.openGaugeManagerForModel(pane, getModel());
        }));
        probesHdr.appendChild(probesBtns);
        probesSection.appendChild(probesHdr);

        const probesList = document.createElement('div');
        probesList.className = 'chart-card-probes-list';
        probesList.style.display = 'flex';
        probesList.style.flexDirection = 'column';
        probesList.style.gap = '2px';
        probesList.style.maxHeight = '148px';
        probesList.style.overflowY = 'auto';
        probesList.style.paddingRight = '1px';
        probesSection.appendChild(probesList);

        const hintLine = document.createElement('div');
        hintLine.style.fontSize = '7.5px';
        hintLine.style.color = '#64748b';
        hintLine.style.lineHeight = '1.2';
        hintLine.textContent = 'Wheel: 2D Zoom • Drag: 2D Pan • Shift+Drag: Box • Hover: ▲Peak/▼Min';
        bodyWrap.appendChild(probesSection);
        bodyWrap.appendChild(hintLine);

        card.appendChild(bodyWrap);
        container.appendChild(card);
        host.appendChild(container);
        pane.chartControlCard = card;
    }

    private updateChartControlCard(pane: ViewportPane, model: Model | null): void {
        const card = pane.chartControlCard;
        if (!card) return;

        const cfg = this.buildChartConfig(model, pane.workerConfigOverrides || {}, pane.viewType);
        if (card.parentElement) {
            card.parentElement.style.display = Boolean(cfg.showChartCard) ? 'block' : 'none';
        }
        this.updateStageChartControlsBtn();
        const isGauges = cfg.chartMode === 'gauges';
        const ch = Number(cfg.channel ?? 0);

        const gTitles: Record<number, string> = {
            0: 'PRESSURE P(t) [Pa] ▾',
            7: 'OVERPRESSURE ΔP(t) [Pa] ▾',
            8: 'IMPULSE I(t) [Pa·s] ▾',
            1: 'DENSITY ρ(t) [kg/m³] ▾',
            2: 'VELOCITY |u|(t) [m/s] ▾',
            3: 'ENERGY e(t) [J/kg] ▾',
            4: 'REACTED α₁(t) [-] ▾',
            5: 'UNREACTED α₂(t) [-] ▾',
            6: 'AMBIENT AIR(t) [-] ▾'
        };
        const sTitles: Record<number, string> = {
            0: 'PRESSURE P(r) [Pa] ▾',
            8: 'OVERPRESSURE ΔP(r) [Pa] ▾',
            1: 'DENSITY ρ(r) [kg/m³] ▾',
            2: 'VELOCITY u_r(r) [m/s] ▾',
            3: 'ENERGY e(r) [J/kg] ▾',
            4: 'ALL SPECIES (α₁, α₂) ▾',
            5: 'REACTED α₁(r) [-] ▾',
            6: 'UNREACTED α₂(r) [-] ▾',
            7: 'AMBIENT AIR(r) [-] ▾'
        };

        const qtyTitle = card.querySelector('.chart-card-qty-title') as HTMLElement | null;
        if (qtyTitle) {
            qtyTitle.textContent = isGauges ? (gTitles[ch] || `CHANNEL ${ch} ▾`) : (sTitles[ch] || `CHANNEL ${ch} ▾`);
            qtyTitle.title = 'Click to select plotted physical quantity';
        }

        const boxBtn = card.querySelector('.chart-nav-box') as HTMLElement | null;
        if (boxBtn) {
            const isBox = cfg.interactionMode === 'boxZoom';
            boxBtn.style.background = isBox ? 'rgba(56, 189, 248, 0.25)' : 'rgba(255, 255, 255, 0.07)';
            boxBtn.style.color = isBox ? '#38bdf8' : '#cbd5e1';
            boxBtn.style.borderColor = isBox ? 'rgba(56, 189, 248, 0.6)' : 'rgba(255, 255, 255, 0.14)';
        }

        const peaksBtn = card.querySelector('.chart-nav-peaks') as HTMLElement | null;
        if (peaksBtn) {
            const showPk = cfg.showPeaks !== false;
            peaksBtn.style.background = showPk ? 'rgba(251, 191, 36, 0.2)' : 'rgba(255, 255, 255, 0.07)';
            peaksBtn.style.color = showPk ? '#fbbf24' : '#cbd5e1';
            peaksBtn.style.borderColor = showPk ? 'rgba(251, 191, 36, 0.45)' : 'rgba(255, 255, 255, 0.14)';
        }

        const autoBtn = card.querySelector('.chart-scale-auto') as HTMLElement | null;
        if (autoBtn) {
            const effAuto = Boolean(cfg.autoScale) && !pane.lastProbeStats?.isZoomedY;
            autoBtn.textContent = effAuto ? 'AUTO' : 'MAN';
            autoBtn.style.background = effAuto ? 'rgba(56, 189, 248, 0.2)' : 'rgba(245, 158, 11, 0.2)';
            autoBtn.style.color = effAuto ? '#38bdf8' : '#fbbf24';
            autoBtn.style.borderColor = effAuto ? 'rgba(56, 189, 248, 0.4)' : 'rgba(245, 158, 11, 0.4)';
        }

        const logBtn = card.querySelector('.chart-scale-log') as HTMLElement | null;
        if (logBtn) {
            logBtn.textContent = cfg.logScale ? 'LOG' : 'LIN';
            logBtn.style.background = cfg.logScale ? 'rgba(168, 85, 247, 0.22)' : 'rgba(255, 255, 255, 0.07)';
            logBtn.style.color = cfg.logScale ? '#c084fc' : '#cbd5e1';
            logBtn.style.borderColor = cfg.logScale ? 'rgba(168, 85, 247, 0.45)' : 'rgba(255, 255, 255, 0.14)';
        }

        const rangeRow = card.querySelector('.chart-card-range-row') as HTMLElement | null;
        if (rangeRow) {
            const showManual = !cfg.autoScale || Boolean(pane.lastProbeStats?.isZoomedY);
            rangeRow.style.display = showManual ? 'flex' : 'none';
            if (showManual) {
                const minV = pane.lastProbeStats?.activeMinY ?? pane.liveBounds?.min ?? cfg.min ?? 0;
                const maxV = pane.lastProbeStats?.activeMaxY ?? pane.liveBounds?.max ?? cfg.max ?? 1e6;
                const span = Math.abs(maxV - minV) || 1;
                const minInp = rangeRow.querySelector('input[data-range-role="min"]') as HTMLInputElement | null;
                const maxInp = rangeRow.querySelector('input[data-range-role="max"]') as HTMLInputElement | null;
                if (minInp && document.activeElement !== minInp) minInp.value = this.formatCardRangeValue(minV, span);
                if (maxInp && document.activeElement !== maxInp) maxInp.value = this.formatCardRangeValue(maxV, span);
            }
        }

        const probesSection = card.querySelector('.chart-card-probes-section') as HTMLElement | null;
        if (probesSection) {
            probesSection.style.display = isGauges ? 'flex' : 'none';
        }
        if (!isGauges) {
            if (pane.emptyOverlay) pane.emptyOverlay.style.display = 'none';
            return;
        }

        const palette = ['#00f0ff', '#10b981', '#f59e0b', '#f43f5e', '#a855f7', '#3b82f6', '#ec4899', '#84cc16', '#14b8a6', '#f97316'];
        const hiddenSet = new Set<number>(Array.isArray(cfg.hiddenProbes) ? cfg.hiddenProbes : []);
        const selectedProbe = Number(cfg.selectedProbe ?? -1);
        const statsProbes: any[] = Array.isArray(pane.lastProbeStats?.probes) ? pane.lastProbeStats.probes : [];
        const cfgGauges: any[] = Array.isArray(cfg.gauges) ? cfg.gauges : [];
        const count = Math.max(statsProbes.length, cfgGauges.length);

        let visibleCount = 0;
        for (let i = 0; i < count; i++) {
            const vis = (selectedProbe < 0 || selectedProbe === i) && !hiddenSet.has(i);
            if (vis) visibleCount++;
        }

        const masterCheck = card.querySelector('.chart-card-probes-master') as HTMLInputElement | null;
        if (masterCheck) {
            masterCheck.checked = count > 0 && visibleCount === count;
            masterCheck.indeterminate = visibleCount > 0 && visibleCount < count;
            masterCheck.disabled = count === 0;
        }

        const countSpan = card.querySelector('.chart-card-probes-count') as HTMLElement | null;
        if (countSpan) {
            countSpan.textContent = `PROBES (${visibleCount}/${count})`;
        }

        const applyProbeToggle = (idx: number) => {
            const nextHidden = new Set<number>(hiddenSet);
            let nextSelected = selectedProbe;
            if (selectedProbe >= 0) {
                nextSelected = -1;
            } else {
                if (nextHidden.has(idx)) nextHidden.delete(idx);
                else nextHidden.add(idx);
            }
            const ownerNode = model?.nodes.find(n => n.type === 'VirtualGauges' || n.type === 'VirtualGauges3D')
                || model?.nodes.find(n => Array.isArray(n.parameters?.gauges) && n.parameters.gauges.length > 0);
            const rawGauges = ownerNode && Array.isArray(ownerNode.parameters?.gauges) ? ownerNode.parameters.gauges : null;
            const nextOverrides: Record<string, any> = {
                ...(pane.workerConfigOverrides || {}),
                selectedProbe: nextSelected
            };
            if (ownerNode && rawGauges && rawGauges.length > 0) {
                const updated = rawGauges.map((g: any, i: number) => ({
                    ...g,
                    plot: !nextHidden.has(i)
                }));
                this.stateManager.updateNodeParametersInPlace(ownerNode.id, { gauges: updated });
                delete nextOverrides.hiddenProbes;
            } else {
                nextOverrides.hiddenProbes = Array.from(nextHidden);
            }
            pane.workerConfigOverrides = nextOverrides;
            this.syncPaneWorkerConfig(pane);
            this.saveStageOptions();
        };

        const listEl = card.querySelector('.chart-card-probes-list') as HTMLElement | null;
        if (listEl) {
            listEl.innerHTML = '';
            if (count === 0) {
                const emptyMsg = document.createElement('div');
                emptyMsg.style.fontSize = '8.5px';
                emptyMsg.style.color = '#94a3b8';
                emptyMsg.style.padding = '3px 2px';
                emptyMsg.textContent = 'No probes configured yet.';
                listEl.appendChild(emptyMsg);
            } else {
                for (let idx = 0; idx < count; idx++) {
                    const st = statsProbes[idx];
                    const gm = cfgGauges[idx];
                    const pid = st?.id || gm?.name || gm?.id || `G${idx + 1}`;
                    const coord = st?.coordDesc || (gm?.r !== undefined && gm?.z !== undefined
                        ? `(${Number(gm.r).toFixed(2)}, ${Number(gm.z).toFixed(2)}m)`
                        : (gm?.r !== undefined ? `(r=${Number(gm.r).toFixed(2)}m)` : ''));
                    const color = st?.color || palette[idx % palette.length];
                    const isVisible = (selectedProbe < 0 || selectedProbe === idx) && !hiddenSet.has(idx);
                    const isSolo = selectedProbe === idx;

                    const row = document.createElement('div');
                    row.style.display = 'flex';
                    row.style.alignItems = 'center';
                    row.style.justifyContent = 'space-between';
                    row.style.gap = '4px';
                    row.style.padding = '2px 4px';
                    row.style.borderRadius = '3px';
                    row.style.cursor = 'pointer';
                    row.style.background = isSolo ? 'rgba(56, 189, 248, 0.16)' : 'rgba(255, 255, 255, 0.03)';
                    row.style.opacity = isVisible ? '1' : '0.45';
                    row.title = 'Click checkbox or row to toggle probe ON/OFF • Double-click or click ◎ to Solo • Hover to highlight curve';

                    const leftPart = document.createElement('div');
                    leftPart.style.display = 'flex';
                    leftPart.style.alignItems = 'center';
                    leftPart.style.gap = '5px';
                    leftPart.style.minWidth = '0';

                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.checked = isVisible;
                    cb.style.cssText = 'margin:0; width:11px; height:11px; cursor:pointer; flex-shrink:0; accent-color:#38bdf8;';
                    cb.onclick = (ev) => ev.stopPropagation();
                    cb.onchange = () => applyProbeToggle(idx);
                    leftPart.appendChild(cb);

                    const swatch = document.createElement('span');
                    swatch.style.width = '8px';
                    swatch.style.height = '8px';
                    swatch.style.borderRadius = '2px';
                    swatch.style.flexShrink = '0';
                    swatch.style.background = isVisible ? color : 'transparent';
                    swatch.style.border = `1.5px solid ${color}`;
                    leftPart.appendChild(swatch);

                    const nameSpan = document.createElement('span');
                    nameSpan.style.fontFamily = "'JetBrains Mono', monospace";
                    nameSpan.style.fontSize = '8.5px';
                    nameSpan.style.fontWeight = '600';
                    nameSpan.style.color = isVisible ? '#f1f5f9' : '#94a3b8';
                    nameSpan.style.whiteSpace = 'nowrap';
                    nameSpan.style.overflow = 'hidden';
                    nameSpan.style.textOverflow = 'ellipsis';
                    nameSpan.textContent = `${pid} ${coord}`;
                    leftPart.appendChild(nameSpan);
                    row.appendChild(leftPart);

                    const rightPart = document.createElement('div');
                    rightPart.style.display = 'flex';
                    rightPart.style.alignItems = 'center';
                    rightPart.style.gap = '4px';
                    rightPart.style.flexShrink = '0';

                    const valSpan = document.createElement('span');
                    valSpan.style.fontFamily = "'JetBrains Mono', monospace";
                    valSpan.style.fontSize = '8px';
                    if (st && st.hoverVal !== null && isFinite(st.hoverVal)) {
                        valSpan.style.color = '#38bdf8';
                        valSpan.textContent = this.formatCardRangeValue(st.hoverVal, 1);
                    } else if (st && st.peakVal !== null && isFinite(st.peakVal)) {
                        valSpan.style.color = '#fbbf24';
                        if (st.troughVal !== null && isFinite(st.troughVal) && Math.abs(st.peakVal - st.troughVal) > 1e-12) {
                            valSpan.textContent = `▲${this.formatCardRangeValue(st.peakVal, 1)} ▼${this.formatCardRangeValue(st.troughVal, 1)}`;
                        } else {
                            valSpan.textContent = `▲${this.formatCardRangeValue(st.peakVal, 1)}`;
                        }
                    } else {
                        valSpan.style.color = '#64748b';
                        valSpan.textContent = '—';
                    }
                    rightPart.appendChild(valSpan);

                    const soloBtn = document.createElement('span');
                    soloBtn.textContent = '◎';
                    soloBtn.title = isSolo ? 'Show all probes (exit Solo)' : `Solo ${pid}`;
                    soloBtn.style.fontSize = '9px';
                    soloBtn.style.color = isSolo ? '#38bdf8' : '#64748b';
                    soloBtn.style.padding = '0 2px';
                    soloBtn.onclick = (ev) => {
                        ev.stopPropagation();
                        const nextSel = isSolo ? -1 : idx;
                        const nextHidden = new Set<number>(hiddenSet);
                        nextHidden.delete(idx);
                        pane.workerConfigOverrides = {
                            ...(pane.workerConfigOverrides || {}),
                            selectedProbe: nextSel,
                            hiddenProbes: Array.from(nextHidden)
                        };
                        this.syncPaneWorkerConfig(pane);
                        this.saveStageOptions();
                    };
                    rightPart.appendChild(soloBtn);
                    row.appendChild(rightPart);

                    row.onmouseenter = () => {
                        row.style.background = 'rgba(56, 189, 248, 0.14)';
                        pane.worker?.postMessage({ type: 'setConfig', hoveredProbe: idx, resetZoomY: false });
                    };
                    row.onmouseleave = () => {
                        row.style.background = isSolo ? 'rgba(56, 189, 248, 0.16)' : 'rgba(255, 255, 255, 0.03)';
                        pane.worker?.postMessage({ type: 'setConfig', hoveredProbe: -1, resetZoomY: false });
                    };
                    row.onclick = (ev) => {
                        ev.stopPropagation();
                        applyProbeToggle(idx);
                    };
                    row.ondblclick = (ev) => {
                        ev.stopPropagation();
                        const nextSel = isSolo ? -1 : idx;
                        const nextHidden = new Set<number>(hiddenSet);
                        nextHidden.delete(idx);
                        pane.workerConfigOverrides = {
                            ...(pane.workerConfigOverrides || {}),
                            selectedProbe: nextSel,
                            hiddenProbes: Array.from(nextHidden)
                        };
                        this.syncPaneWorkerConfig(pane);
                        this.saveStageOptions();
                    };

                    listEl.appendChild(row);
                }
            }
        }

        // Update Empty-State Action Overlay when numSteps === 0
        if (pane.emptyOverlay) {
            const numSteps = Number(pane.lastProbeStats?.numSteps ?? 0);
            if (numSteps > 0) {
                pane.emptyOverlay.style.display = 'none';
            } else {
                pane.emptyOverlay.style.display = 'flex';
                pane.emptyOverlay.innerHTML = '';

                const box = document.createElement('div');
                box.style.background = 'rgba(14, 15, 19, 0.88)';
                box.style.backdropFilter = 'blur(10px)';
                box.style.border = '1px solid rgba(56, 189, 248, 0.28)';
                box.style.borderRadius = '8px';
                box.style.padding = '12px 16px';
                box.style.display = 'flex';
                box.style.flexDirection = 'column';
                box.style.alignItems = 'center';
                box.style.gap = '8px';
                box.style.maxWidth = '330px';
                box.style.textAlign = 'center';
                box.style.pointerEvents = 'auto';
                box.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.5)';
                box.addEventListener('mousedown', e => e.stopPropagation());

                const title = document.createElement('div');
                title.style.fontSize = '11px';
                title.style.fontWeight = '700';
                title.style.color = '#e2e8f0';
                title.textContent = count > 0
                    ? `🎯 ${count} Virtual Gauge Probe${count === 1 ? '' : 's'} Ready`
                    : '🎯 No Virtual Gauge Probes Configured';
                box.appendChild(title);

                const sub = document.createElement('div');
                sub.style.fontSize = '9.5px';
                sub.style.color = '#94a3b8';
                sub.style.lineHeight = '1.35';
                sub.textContent = count > 0
                    ? 'Step or Run the simulation to stream live pressure, impulse, density, and velocity time-histories f(t).'
                    : 'Add virtual sensor probes inside the domain to record pressure & impulse waveforms f(t).';
                box.appendChild(sub);

                const btnRow = document.createElement('div');
                btnRow.style.display = 'flex';
                btnRow.style.alignItems = 'center';
                btnRow.style.gap = '6px';
                btnRow.style.flexWrap = 'wrap';
                btnRow.style.justifyContent = 'center';

                const mkActionBtn = (txt: string, primary: boolean, fn: () => void) => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.textContent = txt;
                    b.style.padding = '4px 10px';
                    b.style.borderRadius = '4px';
                    b.style.fontSize = '9.5px';
                    b.style.fontWeight = '700';
                    b.style.cursor = 'pointer';
                    b.style.background = primary ? 'rgba(56, 189, 248, 0.22)' : 'rgba(255, 255, 255, 0.08)';
                    b.style.color = primary ? '#38bdf8' : '#e2e8f0';
                    b.style.border = primary ? '1px solid rgba(56, 189, 248, 0.55)' : '1px solid rgba(255, 255, 255, 0.16)';
                    b.onclick = (ev) => {
                        ev.stopPropagation();
                        fn();
                    };
                    return b;
                };

                if (count > 0) {
                    btnRow.appendChild(mkActionBtn('▶ Step 10', true, () => {
                        if (model?.id) this.stateManager.setActiveModel(model.id);
                        (window as any).transportController?.triggerSimCommand?.('STEP', { steps: 10 });
                    }));
                    btnRow.appendChild(mkActionBtn('▶▶ Run All', false, () => {
                        if (model?.id) this.stateManager.setActiveModel(model.id);
                        (window as any).transportController?.triggerSimCommand?.('EXEC_ALL');
                    }));
                    btnRow.appendChild(mkActionBtn('⚙ Edit Probes', false, () => {
                        this.openGaugeManagerForModel(pane, model);
                    }));
                } else {
                    btnRow.appendChild(mkActionBtn('➕ Add 3 Default Probes', true, () => {
                        if (model) {
                            this.ensureDefaultProbesOnModel(model);
                            this.syncPaneWorkerConfig(pane);
                        }
                    }));
                    btnRow.appendChild(mkActionBtn('⚙ Gauge Manager', false, () => {
                        this.openGaugeManagerForModel(pane, model);
                    }));
                }

                box.appendChild(btnRow);
                pane.emptyOverlay.appendChild(box);
            }
        }
    }

    private syncPaneWorkerConfig(pane: ViewportPane): void {
        if (!pane.worker) return;
        const allModels = this.stateManager.getWorkspaceModels();
        const activeWs = this.stateManager.getActiveWorkspace();
        const targetModelId = pane.modelId || activeWs?.activeModelId || allModels[0]?.id || null;
        const model = allModels.find(m => m.id === targetModelId) || null;

        if (pane.viewType === '2D_CONTOUR') {
            const cfg = this.buildContourConfig(model, pane.workerConfigOverrides || {});
            pane.worker.postMessage(cfg);
            this.updateContourColorbarCard(pane, model);
            this.updateContourNavPill(pane, model);
            const channelNames: Record<number, string> = {
                0: 'Pressure P (Pa)',
                1: 'Density ρ (kg/m³)',
                2: 'Radial Vel u_r (m/s)',
                3: 'Axial Vel u_z (m/s)',
                4: 'Specific Energy e (J/kg)',
                5: 'Reacted α₁',
                6: 'Unreacted α₂',
                7: 'MPM von Mises (Pa)',
                8: 'MPM Plastic ε_p',
                9: 'Velocity Mag |u| (m/s)',
                10: 'Overpressure ΔP (Pa)'
            };
            if (pane.hudElement) {
                pane.hudElement.textContent = `2D Contour • ${channelNames[cfg.channel] || 'Pressure'} • ${cfg.isAxisymmetric ? 'Axisymmetric (R-Z)' : 'Planar (X-Y)'} • ${cfg.fillMode === 'aspect' ? '1:1' : 'Full-Fill'}${cfg.meshType === 'amr' ? ' • AMR' : ''}`;
            }
        } else if (pane.viewType === '1D_CHART' || pane.viewType === 'GAUGE_CHART') {
            const cfg = this.buildChartConfig(model, pane.workerConfigOverrides || {}, pane.viewType);
            pane.worker.postMessage(cfg);
            if (cfg.chartMode === 'gauges') {
                this.syncChartGaugeData(pane, model);
                const gChannelNames: Record<number, string> = {
                    0: 'Pressure P(t)',
                    1: 'Density ρ(t)',
                    2: 'Velocity |u|(t)',
                    3: 'Specific Energy e(t)',
                    4: 'Reacted α₁(t)',
                    5: 'Unreacted α₂(t)',
                    6: 'Ambient Air(t)',
                    7: 'Overpressure ΔP(t)',
                    8: 'Specific Impulse I(t)'
                };
                if (pane.hudElement) {
                    pane.hudElement.textContent = `🎯 Gauge Waveforms • ${gChannelNames[cfg.channel] || 'Pressure'} • ${cfg.gauges?.length || 0} Probes`;
                }
            } else {
                const sChannelNames: Record<number, string> = {
                    0: 'Pressure P (Pa)',
                    1: 'Density ρ (kg/m³)',
                    2: 'Velocity u_r (m/s)',
                    3: 'Specific Energy (J/kg)',
                    4: 'All Species (α₁, α₂, Air)',
                    5: 'Reacted α₁',
                    6: 'Unreacted α₂',
                    7: 'Ambient Air',
                    8: 'Overpressure ΔP (Pa)'
                };
                if (pane.hudElement) {
                    pane.hudElement.textContent = `📈 1D Radial Profile • ${sChannelNames[cfg.channel] || 'Pressure'} • R_max = ${cfg.domainRadius} m`;
                }
            }
            this.updateChartControlCard(pane, model);
        }
    }

    /**
     * Pane headers remain completely clean; all field/probe controls live on the 3D-style Floating Cards.
     */
    private populateInlinePaneControls(pane: ViewportPane, _model: Model | null): void {
        if (pane.inlineControlsHost) {
            pane.inlineControlsHost.innerHTML = '';
        }
    }

    private mountViewInstance(pane: ViewportPane): void {
        this.destroyPaneInstance(pane);
        this.updateStageChartControlsBtn();

        const allModels = this.stateManager.getWorkspaceModels();
        const targetModel = allModels.find(m => m.id === pane.modelId) || allModels[0] || null;
        const modelId = targetModel ? targetModel.id : pane.modelId;

        if (!targetModel) {
            const placeholder = document.createElement('div');
            placeholder.className = 'stage-placeholder-msg';
            placeholder.innerHTML = `
                <div class="placeholder-icon">📐</div>
                <div class="stage-placeholder-title">Viewport Ready</div>
                <div class="stage-placeholder-desc">No active model loaded. Create or open a model to begin simulation visualization.</div>
            `;
            pane.content.appendChild(placeholder);
            this.updatePaneModelSelector(pane);
            return;
        }

        if (pane.viewType === '3D_VIEWPORT') {
            const existingVpNode = targetModel?.nodes.find(n => n.type === 'Telemetry3DViewport');
            const targetId = existingVpNode?.id || modelId || null;
            pane.instance = new Telemetry3DViewport(
                pane.content,
                `stage-pane-${pane.index}`,
                this.stateManager,
                `-stage-${pane.index}`,
                targetId
            );
            const themeConfig = STAGE_THEMES.find(t => t.id === this.activeTheme) || STAGE_THEMES[0];
            if (typeof pane.instance.setBackgroundColor === 'function') {
                pane.instance.setBackgroundColor(themeConfig.clearColor.r, themeConfig.clearColor.g, themeConfig.clearColor.b);
            }
            if (typeof pane.instance.setGridVisible === 'function') {
                pane.instance.setGridVisible(this.showStudioGrid);
            }
            const modelSTLs = modelId ? this.stlGeometries.get(modelId) : null;
            if (modelSTLs && pane.instance) {
                modelSTLs.forEach(cachedSTL => {
                    pane.instance.setSTLGeometry?.(cachedSTL.vertices, modelId, cachedSTL.meshId);
                });
            } else if (pane.instance) {
                pane.instance.setSTLGeometry?.(null, modelId || undefined);
            }
            const cachedObs = modelId ? this.obstacleGeometries.get(modelId) : null;
            if (cachedObs && pane.instance) {
                pane.instance.setObstaclesGeometry?.(cachedObs.vertices, cachedObs.cells, modelId, cachedObs.meshId);
            } else if (pane.instance) {
                pane.instance.setObstaclesGeometry?.(null, null, modelId || undefined);
            }
            const latestFrame = modelId ? this.playbackBuffer.getLatestFrameForModel(modelId) : null;
            if (latestFrame && pane.instance) {
                if (latestFrame.sliceBuffer) {
                    pane.instance.pushFrame(latestFrame.sliceBuffer, latestFrame.modelId);
                } else if (latestFrame.buffer && latestFrame.buffer !== latestFrame.mpmBuffer && latestFrame.buffer !== latestFrame.phaseParticlesBuffer && latestFrame.buffer !== latestFrame.femBuffer) {
                    pane.instance.pushFrame(latestFrame.buffer, latestFrame.modelId);
                }
                if (latestFrame.mpmBuffer) {
                    pane.instance.pushFrame(latestFrame.mpmBuffer, latestFrame.modelId);
                }
                if (latestFrame.phaseParticlesBuffer) {
                    pane.instance.pushFrame(latestFrame.phaseParticlesBuffer, latestFrame.modelId);
                }
                if (latestFrame.femBuffer) {
                    pane.instance.pushFrame(latestFrame.femBuffer, latestFrame.modelId);
                }
            } else if (pane.instance) {
                pane.instance.resetSimulationData?.(modelId || undefined);
            }
            if (modelId) {
                const views = this.stateManager.getModelViews(modelId);
                const targetView = pane.viewId ? views.find(v => v.id === pane.viewId) : (this.stateManager.getModelActiveView(modelId) || views[0]);
                if (targetView && pane.instance) {
                    pane.instance.applyModelView?.(targetView);
                }
            }
            this.updatePaneViewSelector(pane);
        } else if (pane.viewType === 'RESOURCE_MONITOR') {
            pane.instance = new ResourceManager(pane.content, this.stateManager, `stage-pane-${pane.index}`);
        } else if (pane.viewType === '2D_CONTOUR') {
            this.mountContourView(pane, targetModel);
        } else if (pane.viewType === '1D_CHART' || pane.viewType === 'GAUGE_CHART') {
            this.mountChartView(pane, targetModel);
        }
        this.updatePaneModelSelector(pane);
        this.refreshModePillsUI();
    }

    private mountContourView(pane: ViewportPane, model: Model | null): void {
        const host = document.createElement('div');
        host.className = 'stage-pane-canvas-host';
        host.style.width = '100%';
        host.style.height = '100%';
        host.style.position = 'relative';
        host.style.cursor = pane.workerConfigOverrides?.interactionMode === 'boxZoom' ? 'crosshair' : 'grab';
        host.style.background = '#0b0f19';

        const canvas = document.createElement('canvas');
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        host.appendChild(canvas);

        // Mount 3D-identical floating glassmorphic Colorbar Card at top-left & 1-click Nav Pill at top-right!
        this.mountContourColorbarCard(host, pane);
        this.mountContourNavPill(host, pane);

        // Bottom-left compact HUD pill matching 3D Viewport
        const hud = document.createElement('div');
        hud.className = 'stage-hud-overlay';
        hud.style.position = 'absolute';
        hud.style.bottom = '6px';
        hud.style.left = '8px';
        hud.style.padding = '3px 7px';
        hud.style.background = 'rgba(14, 15, 19, 0.85)';
        hud.style.backdropFilter = 'blur(8px)';
        hud.style.border = '1px solid rgba(255, 255, 255, 0.12)';
        hud.style.borderRadius = '4px';
        hud.style.fontSize = '9px';
        hud.style.fontFamily = "'JetBrains Mono', monospace";
        hud.style.color = '#38bdf8';
        hud.style.pointerEvents = 'none';
        hud.textContent = '2D Contour Slice View';
        host.appendChild(hud);
        pane.hudElement = hud;

        pane.content.appendChild(host);

        const worker = new Worker(new URL('./ContourWorker.ts', import.meta.url), { type: 'module' });
        pane.worker = worker;

        worker.onmessage = (ev) => {
            const msg = ev.data;
            if (!msg) return;
            if (msg.type === 'bounds' && isFinite(msg.minY) && isFinite(msg.maxY)) {
                pane.liveBounds = { min: Number(msg.minY), max: Number(msg.maxY) };
                const all = this.stateManager.getWorkspaceModels();
                const curModel = all.find(m => m.id === pane.modelId) || all[0] || null;
                this.updateContourColorbarCard(pane, curModel);
            } else if (msg.type === 'probeHover') {
                const isBoxMode = pane.workerConfigOverrides?.interactionMode === 'boxZoom';
                host.style.cursor = msg.probeIndex >= 0 ? 'pointer' : (isBoxMode ? 'crosshair' : 'grab');
            } else if (msg.type === 'probeClick' && typeof msg.probeIndex === 'number') {
                const idx = msg.probeIndex;
                const curSel = Number(pane.workerConfigOverrides?.selectedProbe ?? -1);
                const nextSel = curSel === idx ? -1 : idx;
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), selectedProbe: nextSel };
                this.syncPaneWorkerConfig(pane);
                // Synchronize probe selection with any sibling GAUGE_CHART / 1D_CHART pane for the same model!
                this.panes.forEach(sib => {
                    if (sib !== pane && (sib.viewType === 'GAUGE_CHART' || sib.viewType === '1D_CHART') && sib.modelId === pane.modelId) {
                        const hidden = new Set<number>(Array.isArray(sib.workerConfigOverrides?.hiddenProbes) ? sib.workerConfigOverrides.hiddenProbes : []);
                        if (nextSel >= 0) hidden.delete(nextSel);
                        sib.workerConfigOverrides = {
                            ...(sib.workerConfigOverrides || {}),
                            selectedProbe: nextSel,
                            hiddenProbes: Array.from(hidden)
                        };
                        this.syncPaneWorkerConfig(sib);
                    }
                });
                this.saveStageOptions();
            }
        };

        const dpr = window.devicePixelRatio || 1;
        const rect = host.getBoundingClientRect();
        const initialW = Math.max(100, Math.round(rect.width || pane.content.clientWidth || 400));
        const initialH = Math.max(100, Math.round(rect.height || pane.content.clientHeight || 300));
        canvas.width = initialW;
        canvas.height = initialH;
        const offscreen = canvas.transferControlToOffscreen();

        worker.postMessage({
            type: 'init',
            canvas: offscreen,
            dpr,
            width: initialW,
            height: initialH
        }, [offscreen] as any);

        this.syncPaneWorkerConfig(pane);

        pane.resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                const w = Math.round(entry.contentRect.width);
                const h = Math.round(entry.contentRect.height);
                if (w > 0 && h > 0) {
                    worker.postMessage({ type: 'resize', width: w, height: h });
                }
            }
        });
        pane.resizeObserver.observe(host);
        requestAnimationFrame(() => {
            const rNow = host.getBoundingClientRect();
            const rw = Math.round(rNow.width);
            const rh = Math.round(rNow.height);
            if (rw > 0 && rh > 0) {
                worker.postMessage({ type: 'resize', width: rw, height: rh });
            }
        });

        let isDragging = false;
        let isBoxDragging = false;
        let usedRightDrag = false;
        let startX = 0, startY = 0;
        let downLocalX = 0, downLocalY = 0;

        const onMouseDown = (e: MouseEvent) => {
            if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
            const r = host.getBoundingClientRect();
            downLocalX = e.clientX - r.left;
            downLocalY = e.clientY - r.top;
            startX = e.clientX;
            startY = e.clientY;
            usedRightDrag = e.button === 2;
            const wantBox = e.shiftKey || e.button === 2 || pane.workerConfigOverrides?.interactionMode === 'boxZoom';
            if (wantBox) {
                isBoxDragging = true;
                isDragging = false;
                host.style.cursor = 'crosshair';
                worker.postMessage({ type: 'boxZoomMove', x0: downLocalX, y0: downLocalY, x1: downLocalX, y1: downLocalY });
            } else {
                isDragging = true;
                isBoxDragging = false;
                host.style.cursor = 'grabbing';
            }
        };

        const onMouseMove = (e: MouseEvent) => {
            const r = host.getBoundingClientRect();
            const mx = e.clientX - r.left;
            const my = e.clientY - r.top;
            if (isBoxDragging) {
                worker.postMessage({ type: 'boxZoomMove', x0: downLocalX, y0: downLocalY, x1: mx, y1: my });
            } else if (isDragging) {
                const deltaX = e.clientX - startX;
                const deltaY = e.clientY - startY;
                startX = e.clientX;
                startY = e.clientY;
                worker.postMessage({ type: 'pan', deltaX, deltaY, dx: deltaX, dy: deltaY });
            } else if (mx >= 0 && mx <= r.width && my >= 0 && my <= r.height) {
                worker.postMessage({ type: 'hover', mx, my });
            }
        };

        const onMouseLeave = () => {
            if (!isDragging && !isBoxDragging) {
                worker.postMessage({ type: 'hover', mx: null, my: null });
            }
        };

        const onMouseUp = (e: MouseEvent) => {
            const r = host.getBoundingClientRect();
            const mx = e.clientX - r.left;
            const my = e.clientY - r.top;
            if (isBoxDragging) {
                isBoxDragging = false;
                if (Math.abs(mx - downLocalX) > 6 && Math.abs(my - downLocalY) > 6) {
                    worker.postMessage({ type: 'boxZoomCommit', x0: downLocalX, y0: downLocalY, x1: mx, y1: my });
                } else {
                    worker.postMessage({ type: 'boxZoomCancel' });
                }
                host.style.cursor = pane.workerConfigOverrides?.interactionMode === 'boxZoom' ? 'crosshair' : 'grab';
            } else if (isDragging) {
                isDragging = false;
                const dist = Math.hypot(mx - downLocalX, my - downLocalY);
                if (dist < 5 && e.button === 0) {
                    worker.postMessage({ type: 'click', mx, my });
                }
                host.style.cursor = pane.workerConfigOverrides?.interactionMode === 'boxZoom' ? 'crosshair' : 'grab';
            }
        };

        const onContextMenu = (e: MouseEvent) => {
            if (usedRightDrag) {
                e.preventDefault();
                usedRightDrag = false;
            }
        };

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.15 : 0.85;
            const r = host.getBoundingClientRect();
            const cX = e.clientX - r.left;
            const cY = e.clientY - r.top;
            worker.postMessage({ type: 'zoom', factor, deltaY: e.deltaY, centerX: cX, centerY: cY, mx: cX, my: cY });
        };

        const onDblClick = () => {
            worker.postMessage({ type: 'resetView' });
        };

        host.addEventListener('mousedown', onMouseDown);
        host.addEventListener('mouseleave', onMouseLeave);
        host.addEventListener('contextmenu', onContextMenu);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        host.addEventListener('wheel', onWheel, { passive: false });
        host.addEventListener('dblclick', onDblClick);

        pane.cleanupListeners = () => {
            host.removeEventListener('mousedown', onMouseDown);
            host.removeEventListener('mouseleave', onMouseLeave);
            host.removeEventListener('contextmenu', onContextMenu);
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            host.removeEventListener('wheel', onWheel);
            host.removeEventListener('dblclick', onDblClick);
        };

        const cached = this.getCachedModelBinaryTelemetry(model);
        if (cached) {
            const copy = cached.slice(0);
            worker.postMessage(copy, [copy]);
        }
    }

    private mountChartView(pane: ViewportPane, model: Model | null): void {
        const host = document.createElement('div');
        host.className = 'stage-pane-canvas-host';
        host.style.width = '100%';
        host.style.height = '100%';
        host.style.position = 'relative';
        host.style.cursor = pane.workerConfigOverrides?.interactionMode === 'boxZoom' ? 'crosshair' : 'grab';
        host.style.background = '#0b0f19';

        const canvas = document.createElement('canvas');
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        host.appendChild(canvas);

        // Empty-state overlay container (centered, pointer-events none except inner action card)
        const emptyOverlay = document.createElement('div');
        emptyOverlay.className = 'stage-chart-empty-overlay';
        emptyOverlay.style.position = 'absolute';
        emptyOverlay.style.inset = '0';
        emptyOverlay.style.display = 'none';
        emptyOverlay.style.alignItems = 'center';
        emptyOverlay.style.justifyContent = 'center';
        emptyOverlay.style.pointerEvents = 'none';
        emptyOverlay.style.zIndex = '12';
        host.appendChild(emptyOverlay);
        pane.emptyOverlay = emptyOverlay;

        // Floating 3D-style Chart Control & Probe Legend Card
        this.mountChartControlCard(host, pane);

        const hud = document.createElement('div');
        hud.className = 'stage-hud-overlay';
        hud.style.position = 'absolute';
        hud.style.bottom = '6px';
        hud.style.left = '8px';
        hud.style.padding = '3px 7px';
        hud.style.background = 'rgba(14, 15, 19, 0.85)';
        hud.style.backdropFilter = 'blur(8px)';
        hud.style.border = '1px solid rgba(255, 255, 255, 0.12)';
        hud.style.borderRadius = '4px';
        hud.style.fontSize = '9px';
        hud.style.fontFamily = "'JetBrains Mono', monospace";
        hud.style.color = '#38bdf8';
        hud.style.pointerEvents = 'none';
        hud.textContent = pane.viewType === 'GAUGE_CHART' ? 'Virtual Gauge Waveforms f(t)' : '1D Radial Profile f(r)';
        host.appendChild(hud);
        pane.hudElement = hud;

        pane.content.appendChild(host);

        const worker = new Worker(new URL('./ChartWorker.ts', import.meta.url), { type: 'module' });
        pane.worker = worker;

        worker.onmessage = (ev) => {
            const msg = ev.data;
            if (!msg) return;
            if (msg.type === 'bounds' && isFinite(msg.minY) && isFinite(msg.maxY)) {
                pane.liveBounds = { min: Number(msg.minY), max: Number(msg.maxY) };
                const all = this.stateManager.getWorkspaceModels();
                const curModel = all.find(m => m.id === pane.modelId) || all[0] || null;
                this.updateChartControlCard(pane, curModel);
            } else if (msg.type === 'probeStats') {
                pane.lastProbeStats = msg;
                if (isFinite(msg.activeMinY) && isFinite(msg.activeMaxY)) {
                    pane.liveBounds = { min: Number(msg.activeMinY), max: Number(msg.activeMaxY) };
                }
                const all = this.stateManager.getWorkspaceModels();
                const curModel = all.find(m => m.id === pane.modelId) || all[0] || null;
                this.updateChartControlCard(pane, curModel);
            }
        };

        const dpr = window.devicePixelRatio || 1;
        const rect = host.getBoundingClientRect();
        const initialW = Math.max(100, Math.round(rect.width || pane.content.clientWidth || 400));
        const initialH = Math.max(100, Math.round(rect.height || pane.content.clientHeight || 300));
        canvas.width = initialW;
        canvas.height = initialH;
        const offscreen = canvas.transferControlToOffscreen();

        worker.postMessage({
            type: 'init',
            canvas: offscreen,
            dpr,
            width: initialW,
            height: initialH
        }, [offscreen] as any);

        this.syncPaneWorkerConfig(pane);

        pane.resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                const w = Math.round(entry.contentRect.width);
                const h = Math.round(entry.contentRect.height);
                if (w > 0 && h > 0) {
                    worker.postMessage({ type: 'resize', width: w, height: h });
                }
            }
        });
        pane.resizeObserver.observe(host);
        requestAnimationFrame(() => {
            const rNow = host.getBoundingClientRect();
            const rw = Math.round(rNow.width);
            const rh = Math.round(rNow.height);
            if (rw > 0 && rh > 0) {
                worker.postMessage({ type: 'resize', width: rw, height: rh });
            }
        });

        let isChartDragging = false;
        let usedRightDrag = false;

        const onMouseDown = (e: MouseEvent) => {
            if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
            const r = host.getBoundingClientRect();
            isChartDragging = true;
            usedRightDrag = e.button === 2;
            const isBox = e.shiftKey || e.button === 1 || e.button === 2 || pane.workerConfigOverrides?.interactionMode === 'boxZoom';
            host.style.cursor = isBox ? 'crosshair' : 'grabbing';
            worker.postMessage({
                type: 'mouseEvent',
                event: 'mousedown',
                offsetX: e.clientX - r.left,
                offsetY: e.clientY - r.top,
                shiftKey: e.shiftKey,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey,
                button: e.button
            });
        };

        const onWindowMouseMove = (e: MouseEvent) => {
            const r = host.getBoundingClientRect();
            const ox = e.clientX - r.left;
            const oy = e.clientY - r.top;
            if (isChartDragging || (ox >= 0 && ox <= r.width && oy >= 0 && oy <= r.height)) {
                worker.postMessage({
                    type: 'mouseEvent',
                    event: 'mousemove',
                    offsetX: ox,
                    offsetY: oy,
                    shiftKey: e.shiftKey,
                    ctrlKey: e.ctrlKey,
                    altKey: e.altKey
                });
            }
        };

        const onWindowMouseUp = (e: MouseEvent) => {
            if (!isChartDragging) return;
            isChartDragging = false;
            host.style.cursor = pane.workerConfigOverrides?.interactionMode === 'boxZoom' ? 'crosshair' : 'grab';
            worker.postMessage({
                type: 'mouseEvent',
                event: 'mouseup',
                shiftKey: e.shiftKey,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey,
                button: e.button
            });
        };

        const onMouseLeave = () => {
            if (!isChartDragging) {
                worker.postMessage({ type: 'mouseEvent', event: 'mouseleave' });
            }
        };

        const onContextMenu = (e: MouseEvent) => {
            if (usedRightDrag) {
                e.preventDefault();
                usedRightDrag = false;
            }
        };

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const r = host.getBoundingClientRect();
            worker.postMessage({
                type: 'mouseEvent',
                event: 'wheel',
                offsetX: e.clientX - r.left,
                offsetY: e.clientY - r.top,
                deltaY: e.deltaY,
                shiftKey: e.shiftKey,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey
            });
        };

        const onDblClick = () => {
            worker.postMessage({ type: 'mouseEvent', event: 'dblclick' });
        };

        host.addEventListener('mousedown', onMouseDown);
        host.addEventListener('mouseleave', onMouseLeave);
        host.addEventListener('contextmenu', onContextMenu);
        window.addEventListener('mousemove', onWindowMouseMove);
        window.addEventListener('mouseup', onWindowMouseUp);
        host.addEventListener('wheel', onWheel, { passive: false });
        host.addEventListener('dblclick', onDblClick);

        pane.cleanupListeners = () => {
            host.removeEventListener('mousedown', onMouseDown);
            host.removeEventListener('mouseleave', onMouseLeave);
            host.removeEventListener('contextmenu', onContextMenu);
            window.removeEventListener('mousemove', onWindowMouseMove);
            window.removeEventListener('mouseup', onWindowMouseUp);
            host.removeEventListener('wheel', onWheel);
            host.removeEventListener('dblclick', onDblClick);
        };

        const cached = this.getCachedModelBinaryTelemetry(model);
        if (cached) {
            const copy = cached.slice(0);
            worker.postMessage(copy, [copy]);
        }
        this.syncChartGaugeData(pane, model);
    }

    private toggleMaximizePane(targetPane: ViewportPane): void {
        if (this.maximizedPaneId === targetPane.id) {
            this.maximizedPaneId = null;
            this.panes.forEach(p => {
                p.container.style.display = '';
                p.isMaximized = false;
            });
        } else {
            this.maximizedPaneId = targetPane.id;
            this.panes.forEach(p => {
                if (p.id === targetPane.id) {
                    p.container.style.display = '';
                    p.isMaximized = true;
                } else {
                    p.container.style.display = 'none';
                    p.isMaximized = false;
                }
            });
        }
        this.applyGridSplitTemplate();
        requestAnimationFrame(() => this.triggerResize());
    }

    /**
     * Dispatch a buffered telemetry frame across all active viewports simultaneously.
     */
    public dispatchFrame(frame: BufferedFrame, isLive: boolean): void {
        const activeWs = this.stateManager.getActiveWorkspace();
        const activeModelId = activeWs?.activeModelId;
        const isHistoryDisabled = this.playbackBuffer.getMaxFrames() <= 1;

        const matching3DPanes = this.panes.filter(pane => {
            const paneModelId = pane.modelId || activeModelId;
            if (frame.modelId && paneModelId && frame.modelId !== paneModelId) return false;
            if (pane.modelId && !frame.modelId) return false;
            return pane.viewType === '3D_VIEWPORT' && pane.instance && typeof pane.instance.pushFrame === 'function';
        });
        const canTransfer3D = isLive && isHistoryDisabled && matching3DPanes.length === 1;

        this.panes.forEach(pane => {
            const paneModelId = pane.modelId || activeModelId;
            if (frame.modelId && paneModelId && frame.modelId !== paneModelId) return;
            if (pane.modelId && !frame.modelId) return;

            try {
                if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                    if (typeof pane.instance.pushFrame === 'function') {
                        if (frame.sliceBuffer && frame.sliceBuffer.byteLength > 0) {
                            pane.instance.pushFrame(frame.sliceBuffer, frame.modelId, canTransfer3D);
                        } else if (frame.buffer && frame.buffer.byteLength > 0 && frame.buffer !== frame.mpmBuffer && frame.buffer !== frame.phaseParticlesBuffer && frame.buffer !== frame.femBuffer) {
                            pane.instance.pushFrame(frame.buffer, frame.modelId, canTransfer3D);
                        }
                        if (frame.mpmBuffer && frame.mpmBuffer.byteLength > 0) {
                            pane.instance.pushFrame(frame.mpmBuffer, frame.modelId, canTransfer3D);
                        }
                        if (frame.phaseParticlesBuffer && frame.phaseParticlesBuffer.byteLength > 0) {
                            pane.instance.pushFrame(frame.phaseParticlesBuffer, frame.modelId, canTransfer3D);
                        }
                        if (frame.femBuffer && frame.femBuffer.byteLength > 0) {
                            pane.instance.pushFrame(frame.femBuffer, frame.modelId, false);
                        }
                    } else if (typeof pane.instance.handleBinaryTelemetry === 'function' && frame.buffer && frame.buffer.byteLength > 0) {
                        pane.instance.handleBinaryTelemetry(frame.buffer);
                    }
                } else if ((pane.viewType === '2D_CONTOUR' || pane.viewType === '1D_CHART') && pane.worker && frame.buffer && frame.buffer.byteLength > 0) {
                    const copy = frame.buffer.slice(0);
                    pane.worker.postMessage(copy, [copy]);
                }
            } catch (err) {
                console.warn(`[WorkspaceManager] Frame dispatch error on pane ${pane.id}:`, err);
            }
        });
    }

    /**
     * Update telemetry domain bounds, step/time metadata, and virtual gauge histories across all viewports.
     */
    public updateTelemetry(data: any, modelId?: string): void {
        const allModels = this.stateManager.getWorkspaceModels();
        const activeWs = this.stateManager.getActiveWorkspace();
        this.panes.forEach(pane => {
            const paneModelId = pane.modelId || activeWs?.activeModelId || allModels[0]?.id;
            if (modelId && paneModelId && modelId !== paneModelId) return;
            if (pane.viewType === '3D_VIEWPORT' && pane.instance && typeof pane.instance.updateTelemetry === 'function') {
                pane.instance.updateTelemetry(data, modelId);
            } else if ((pane.viewType === '2D_CONTOUR' || pane.viewType === '1D_CHART' || pane.viewType === 'GAUGE_CHART') && pane.worker) {
                if (data && (typeof data.step === 'number' || typeof data.time === 'number')) {
                    pane.worker.postMessage({
                        type: 'setConfig',
                        step: Number(data.step ?? 0),
                        time: Number(data.time ?? 0),
                        dt: Number(data.dt ?? 0)
                    });
                }
                if ((pane.viewType === '1D_CHART' || pane.viewType === 'GAUGE_CHART') && data && (data.gauges_history || data.times)) {
                    const targetModel = allModels.find(m => m.id === paneModelId) || null;
                    this.syncChartGaugeData(pane, targetModel);
                }
            }
        });
    }

    public setFocusedPane(paneId: string): void {
        this.focusedPaneId = paneId;
        this.panes.forEach(p => {
            const isFocused = p.id === paneId;
            p.container.classList.toggle('pane-focused', isFocused);
            if (isFocused) {
                if (p.modelId && p.modelId !== this.stateManager.getActiveWorkspace()?.activeModelId) {
                    this.stateManager.setActiveModel(p.modelId);
                }
            }
        });
        this.refreshModePillsUI();
        (window as any).transportController?.syncStateFromViewport?.();
        (window as any).transportController?.requestTabRender?.();
    }

    public getTargetPanes(): ViewportPane[] {
        if (this.focusedPaneId) {
            const focused = this.panes.find(p => p.id === this.focusedPaneId);
            if (focused && (focused.instance || focused.worker)) {
                return [focused];
            }
        }
        const first3D = this.panes.find(p => p.viewType === '3D_VIEWPORT' && p.instance);
        return first3D ? [first3D] : this.panes;
    }

    /**
     * Snap camera preset on focused 3D viewport (or active pane).
     */
    public snapCamera(preset: string): void {
        this.snapCameraPreset(preset);
    }

    public snapCameraPreset(preset: string): void {
        const targets = this.getTargetPanes();
        targets.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.snapCameraPreset?.(preset);
            } else if ((pane.viewType === '2D_CONTOUR' || pane.viewType === '1D_CHART' || pane.viewType === 'GAUGE_CHART') && pane.worker) {
                if (preset === 'reset') {
                    pane.worker.postMessage({ type: 'resetView' });
                } else if (preset === 'zoom_in') {
                    pane.worker.postMessage({ type: 'zoom', factor: 1.25 });
                } else if (preset === 'zoom_out') {
                    pane.worker.postMessage({ type: 'zoom', factor: 0.8 });
                }
            }
        });
    }

    /**
     * Update colormap on all active viewports.
     */
    public setColormap(colormap: string, min?: number, max?: number): void {
        this.panes.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.setColormap?.(colormap, min, max);
            } else if (pane.viewType === '2D_CONTOUR' && pane.worker) {
                pane.workerConfigOverrides = {
                    ...(pane.workerConfigOverrides || {}),
                    colormap,
                    ...(min !== undefined ? { minVal: min, min } : {}),
                    ...(max !== undefined ? { maxVal: max, max } : {})
                };
                const allModels = this.stateManager.getWorkspaceModels();
                const targetModel = allModels.find(m => m.id === pane.modelId) || allModels[0] || null;
                this.populateInlinePaneControls(pane, targetModel);
                this.syncPaneWorkerConfig(pane);
            }
        });
    }

    /**
     * Update orthogonal slice plane on all active 3D viewports.
     */
    public setSlice(plane: 'xy' | 'xz' | 'yz', enabled: boolean, offset: number): void {
        this.panes.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.updateSlicePlane?.(plane, enabled, offset);
            }
        });
    }

    /**
     * Update full slice list on all active 3D viewports.
     */
    public setSlices(slices: any[]): void {
        this.panes.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.setSlices?.(slices);
            }
        });
    }

    /**
     * Set projection mode on focused 3D viewport (or active pane).
     */
    public setProjection(perspective: boolean): void {
        const targets = this.getTargetPanes();
        targets.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.setProjection?.(perspective);
            }
        });
    }

    /**
     * Set focused quantity on all active viewports.
     */
    public setQuantity(quantity: string): void {
        this.panes.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.setQuantity?.(quantity);
            } else if (pane.viewType === '2D_CONTOUR' && pane.worker) {
                const channelMap: Record<string, number> = {
                    'pressure': 0,
                    'overpressure': 10,
                    'peak_overpressure': 10,
                    'density': 1,
                    'velocity': 9,
                    'vel_mag': 9,
                    'ur': 2,
                    'uz': 3,
                    'energy': 4,
                    'alpha1': 5,
                    'species1': 5,
                    'products': 5,
                    'alpha2': 6,
                    'species2': 6,
                    'unreacted': 6,
                    'vonmises': 7,
                    'von_mises': 7,
                    'plasticstrain': 8,
                    'plastic_strain': 8,
                    'damage': 8
                };
                const ch = channelMap[quantity.toLowerCase()] ?? 0;
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), channel: ch };
                const allModels = this.stateManager.getWorkspaceModels();
                const targetModel = allModels.find(m => m.id === pane.modelId) || allModels[0] || null;
                this.populateInlinePaneControls(pane, targetModel);
                this.syncPaneWorkerConfig(pane);
            } else if ((pane.viewType === '1D_CHART' || pane.viewType === 'GAUGE_CHART') && pane.worker) {
                const allModels = this.stateManager.getWorkspaceModels();
                const targetModel = allModels.find(m => m.id === pane.modelId) || allModels[0] || null;
                const cfg = this.buildChartConfig(targetModel, pane.workerConfigOverrides || {}, pane.viewType);
                const isGauges = cfg.chartMode === 'gauges';
                const channelMap1D: Record<string, number> = isGauges
                    ? {
                        'pressure': 0,
                        'density': 1,
                        'velocity': 2,
                        'ur': 2,
                        'energy': 3,
                        'alpha1': 4,
                        'species1': 4,
                        'products': 4,
                        'alpha2': 5,
                        'species2': 5,
                        'unreacted': 5,
                        'air': 6,
                        'species3': 6,
                        'overpressure': 7,
                        'peak_overpressure': 7,
                        'impulse': 8,
                        'peak_impulse': 8
                    }
                    : {
                        'pressure': 0,
                        'density': 1,
                        'velocity': 2,
                        'ur': 2,
                        'energy': 3,
                        'species': 4,
                        'alpha1': 5,
                        'species1': 5,
                        'products': 5,
                        'alpha2': 6,
                        'species2': 6,
                        'unreacted': 6,
                        'air': 7,
                        'species3': 7,
                        'overpressure': 8,
                        'peak_overpressure': 8
                    };
                const ch = channelMap1D[quantity.toLowerCase()] ?? 0;
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), channel: ch };
                this.populateInlinePaneControls(pane, targetModel);
                this.syncPaneWorkerConfig(pane);
            }
        });
    }

    /**
     * Set layer visibility on all active viewports.
     */
    public setLayerVisibility(layer: string, active: boolean): void {
        this.panes.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.setLayerVisibility?.(layer, active);
            } else if (pane.viewType === '2D_CONTOUR' && pane.worker) {
                const overrides: Record<string, any> = { ...(pane.workerConfigOverrides || {}) };
                if (layer === 'grid' || layer === 'gridBox') {
                    overrides.showGridlines = active;
                } else if (layer === 'mpm') {
                    overrides.showMPMParticles = active;
                } else if (layer === 'obstacles') {
                    overrides.showObstacles = active;
                } else if (layer === 'gauges') {
                    overrides.showGauges = active;
                } else if (layer === 'charge') {
                    overrides.showCharge = active;
                } else if (layer === 'detonator') {
                    overrides.showDetonator = active;
                } else if (layer === 'slices') {
                    overrides.showColorbar = active;
                } else if (layer === 'peaks') {
                    overrides.showExtrema = active;
                } else if (layer === 'mirror') {
                    overrides.isAxisymmetric = active;
                }
                pane.workerConfigOverrides = overrides;
                const allModels = this.stateManager.getWorkspaceModels();
                const targetModel = allModels.find(m => m.id === pane.modelId) || allModels[0] || null;
                this.populateInlinePaneControls(pane, targetModel);
                this.syncPaneWorkerConfig(pane);
                this.saveStageOptions();
            } else if ((pane.viewType === '1D_CHART' || pane.viewType === 'GAUGE_CHART') && pane.worker) {
                const overrides: Record<string, any> = { ...(pane.workerConfigOverrides || {}) };
                if (layer === 'grid' || layer === 'gridBox') {
                    overrides.showGrid = active;
                } else if (layer === 'gauges') {
                    overrides.showGauges = active;
                } else if (layer === 'charge') {
                    overrides.showCharge = active;
                } else if (layer === 'detonator') {
                    overrides.showDetonator = active;
                } else if (layer === 'slices') {
                    overrides.showChartCard = active;
                } else if (layer === 'peaks') {
                    overrides.showPeaks = active;
                }
                pane.workerConfigOverrides = overrides;
                const allModels = this.stateManager.getWorkspaceModels();
                const targetModel = allModels.find(m => m.id === pane.modelId) || allModels[0] || null;
                this.populateInlinePaneControls(pane, targetModel);
                this.syncPaneWorkerConfig(pane);
                this.saveStageOptions();
            }
        });
    }

    /**
     * Set refresh rate on all active viewports.
     */
    public setRefreshRate(rate: number, targetModelId?: string): void {
        const activeId = this.stateManager.getActiveModelId();
        this.panes.forEach(pane => {
            const paneModelId = pane.modelId || activeId;
            if (targetModelId && paneModelId !== targetModelId) return;
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.setRefreshRate?.(rate, targetModelId);
            } else if ((pane.viewType === '2D_CONTOUR' || pane.viewType === '1D_CHART' || pane.viewType === 'GAUGE_CHART') && pane.worker) {
                pane.workerConfigOverrides = { ...(pane.workerConfigOverrides || {}), refreshRate: rate };
                pane.worker.postMessage({ type: 'setConfig', refreshRate: rate });
            }
        });
    }

    /**
     * Set shading config on all active viewports (3D, 2D Contour, and 1D Chart).
     */
    public setShadingConfig(config: any): void {
        this.panes.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.setShadingConfig?.(config);
            } else if (pane.viewType === '2D_CONTOUR' && pane.worker && config) {
                const overrides: Record<string, any> = { ...(pane.workerConfigOverrides || {}) };
                const cmap = config.colormap ?? config.mpmParticleColormap ?? config.femColormap;
                if (typeof cmap === 'string') overrides.colormap = cmap;
                const auto = config.autoScale ?? config.mpmParticleAutoScale ?? config.femAutoScale;
                if (auto !== undefined) overrides.autoScale = Boolean(auto);
                const minV = config.minVal ?? config.min_val ?? config.mpmParticleMinVal ?? config.femMinVal;
                if (minV !== undefined && isFinite(Number(minV))) {
                    overrides.minVal = Number(minV);
                    overrides.min = Number(minV);
                }
                const maxV = config.maxVal ?? config.max_val ?? config.mpmParticleMaxVal ?? config.femMaxVal;
                if (maxV !== undefined && isFinite(Number(maxV))) {
                    overrides.maxVal = Number(maxV);
                    overrides.max = Number(maxV);
                }
                const logS = config.logScale ?? config.mpmParticleLogScale ?? config.femLogScale;
                if (logS !== undefined) overrides.logScale = Boolean(logS);
                const showBar = config.showColorbar ?? config.show_colorbar ?? config.mpmParticleShowColorbar ?? config.femShowColorbar;
                if (showBar !== undefined) overrides.showColorbar = Boolean(showBar);
                const showGrid = config.showMeshLines ?? config.show_grid ?? config.showGridlines;
                if (showGrid !== undefined) overrides.showGridlines = Boolean(showGrid);
                const interp = config.interpolate;
                if (interp !== undefined) overrides.interpolate = Boolean(interp);
                const cLevels = config.contourLevels ?? config.sliceContourLevels ?? config.femContourLevels;
                if (cLevels !== undefined && isFinite(Number(cLevels))) overrides.contourLevels = Number(cLevels);
                if (config.mpmParticlesVisible !== undefined) overrides.showMPMParticles = Boolean(config.mpmParticlesVisible);
                if (config.showExtrema !== undefined) overrides.showExtrema = Boolean(config.showExtrema);
                if (config.showPeaks !== undefined) overrides.showExtrema = Boolean(config.showPeaks);
                if (config.isAxisymmetric !== undefined) overrides.isAxisymmetric = Boolean(config.isAxisymmetric);
                pane.workerConfigOverrides = overrides;
                const allModels = this.stateManager.getWorkspaceModels();
                const targetModel = allModels.find(m => m.id === pane.modelId) || allModels[0] || null;
                this.populateInlinePaneControls(pane, targetModel);
                this.syncPaneWorkerConfig(pane);
                this.saveStageOptions();
            } else if ((pane.viewType === '1D_CHART' || pane.viewType === 'GAUGE_CHART') && pane.worker && config) {
                const overrides: Record<string, any> = { ...(pane.workerConfigOverrides || {}) };
                if (config.autoScale !== undefined) {
                    overrides.autoScale = Boolean(config.autoScale);
                    overrides.autoScaleY = Boolean(config.autoScale);
                }
                if (config.logScale !== undefined) overrides.logScale = Boolean(config.logScale);
                if (config.minVal !== undefined) overrides.min = Number(config.minVal);
                if (config.maxVal !== undefined) overrides.max = Number(config.maxVal);
                if (config.showMeshLines !== undefined) overrides.showGrid = Boolean(config.showMeshLines);
                if (config.showColorbar !== undefined) overrides.showChartCard = Boolean(config.showColorbar);
                if (config.showChartCard !== undefined) overrides.showChartCard = Boolean(config.showChartCard);
                if (config.showPeaks !== undefined) overrides.showPeaks = Boolean(config.showPeaks);
                if (config.showExtrema !== undefined) overrides.showPeaks = Boolean(config.showExtrema);
                pane.workerConfigOverrides = overrides;
                const allModels = this.stateManager.getWorkspaceModels();
                const targetModel = allModels.find(m => m.id === pane.modelId) || allModels[0] || null;
                this.populateInlinePaneControls(pane, targetModel);
                this.syncPaneWorkerConfig(pane);
                this.saveStageOptions();
            }
        });
    }

    /**
     * Set ROI config on all active 3D viewports.
     */
    public setROIConfig(roi: any): void {
        this.panes.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.setROIConfig?.(roi);
            }
        });
    }

    /**
     * Set particle filter config on all active 3D viewports.
     */
    public setParticleFilter(filter: any): void {
        this.panes.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.setParticleFilter?.(filter);
            }
        });
    }

    /**
     * Set STL geometry on all active 3D viewports and cache for model.
     */
    public setSTLGeometry(vertices: Float32Array | null, modelId?: string, meshId: string = 'default'): void {
        if (modelId) {
            let modelMap = this.stlGeometries.get(modelId);
            if (!modelMap) {
                modelMap = new Map();
                this.stlGeometries.set(modelId, modelMap);
            }
            modelMap.set(meshId, { vertices, meshId });
        }
        this.panes.forEach(pane => {
            if (modelId && pane.modelId && modelId !== pane.modelId) return;
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.setSTLGeometry?.(vertices, modelId, meshId);
            }
        });
    }

    /**
     * Set obstacle geometry on all active 3D viewports and cache for model.
     */
    public setObstaclesGeometry(vertices: Float32Array | null, cells: Int32Array | null, modelId?: string, meshId: string = 'default'): void {
        if (modelId) {
            this.obstacleGeometries.set(modelId, { vertices, cells, meshId });
        }
        this.panes.forEach(pane => {
            if (modelId && pane.modelId && modelId !== pane.modelId) return;
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.setObstaclesGeometry?.(vertices, cells, modelId, meshId);
            }
        });
    }

    /**
     * Reset simulation runtime data on all active viewports (3D, 2D Contour, and 1D Chart).
     */
    public resetSimulationData(modelId?: string): void {
        if (modelId) {
            this.playbackBuffer.clear(modelId);
        }
        this.panes.forEach(pane => {
            if (modelId && pane.modelId && modelId !== pane.modelId) return;
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.resetSimulationData?.(modelId);
            } else if ((pane.viewType === '2D_CONTOUR' || pane.viewType === '1D_CHART' || pane.viewType === 'GAUGE_CHART') && pane.worker) {
                pane.worker.postMessage({ type: 'clearData' });
                this.syncPaneWorkerConfig(pane);
            }
        });
    }

    public setActiveModel(modelId: string): void {
        const allModels = this.stateManager.getWorkspaceModels();
        const model = allModels.find(m => m.id === modelId);
        const smartType = this.detectSmartViewType(model);

        if (this.activePreset !== '1x1' && this.panes.length > 1) {
            const distinctModels = new Set(this.panes.map(p => p.modelId).filter(Boolean));
            if (distinctModels.size > 1) {
                const existingPane = this.panes.find(p => p.modelId === modelId);
                if (existingPane) {
                    this.setFocusedPane(existingPane.id);
                    this.updatePaneViewSelector(existingPane);
                    this.refreshModePillsUI();
                    this.updateStageTitle();
                    this.saveStageOptions();
                    return;
                }
                const focusTarget = this.panes.find(p => p.id === this.focusedPaneId) || this.panes[0];
                if (focusTarget) {
                    focusTarget.modelId = modelId;
                    if (focusTarget.viewType !== 'GAUGE_CHART' && focusTarget.viewType !== 'RESOURCE_MONITOR') {
                        focusTarget.viewType = smartType;
                        focusTarget.typeSelect.value = smartType;
                    }
                    this.mountViewInstance(focusTarget);
                    this.refreshModePillsUI();
                    this.updateStageTitle();
                    this.saveStageOptions();
                    return;
                }
            }
        }

        this.panes.forEach((pane, idx) => {
            if (pane.modelId !== modelId) {
                pane.modelId = modelId;
                if (this.activePreset === '1x1') {
                    const isIncompatible =
                        (smartType !== '3D_VIEWPORT' && pane.viewType === '3D_VIEWPORT') ||
                        (smartType === '3D_VIEWPORT' && pane.viewType === '2D_CONTOUR') ||
                        (smartType === '3D_VIEWPORT' && pane.viewType === '1D_CHART') ||
                        (smartType === '1D_CHART' && pane.viewType === '2D_CONTOUR') ||
                        (smartType === '2D_CONTOUR' && pane.viewType === '1D_CHART');
                    if (isIncompatible || pane.viewType !== 'GAUGE_CHART') {
                        pane.viewType = smartType;
                        pane.typeSelect.value = smartType;
                    }
                } else if (idx === 0 || (pane.viewType !== 'GAUGE_CHART' && pane.viewType !== 'RESOURCE_MONITOR')) {
                    pane.viewType = smartType;
                    pane.typeSelect.value = smartType;
                }
                this.mountViewInstance(pane);
            } else {
                this.updatePaneViewSelector(pane);
            }
        });
        this.refreshModePillsUI();
        this.updateStageTitle();
        this.saveStageOptions();
    }

    private syncVirtualViewports(): void {
        const allModels = this.stateManager.getWorkspaceModels();
        const activeWs = this.stateManager.getActiveWorkspace();
        const activeModelId = activeWs?.activeModelId || (allModels[0]?.id || null);
        const model = allModels.find(m => m.id === activeModelId);

        this.updateStageTitle();

        this.panes.forEach(pane => {
            const paneModel = allModels.find(m => m.id === (pane.modelId || activeModelId)) || model;
            if (this.activePreset === '1x1' || !pane.modelId || !allModels.some(m => m.id === pane.modelId)) {
                if (pane.modelId !== activeModelId) {
                    pane.modelId = activeModelId;
                    pane.viewId = null;
                    if (this.activePreset === '1x1') {
                        const smartType = this.detectSmartViewType(model);
                        pane.viewType = smartType;
                        pane.typeSelect.value = smartType;
                    }
                    this.mountViewInstance(pane);
                    this.saveStageOptions();
                } else if (this.activePreset === '1x1' && paneModel) {
                    const smartType = this.detectSmartViewType(paneModel);
                    // Preserve explicit user-selected GAUGE_CHART or RESOURCE_MONITOR views!
                    // Only auto-switch when a 3D viewport is left open on a 1D/2D model or vice versa.
                    const isIncompatibleDefault =
                        (smartType !== '3D_VIEWPORT' && pane.viewType === '3D_VIEWPORT') ||
                        (smartType === '3D_VIEWPORT' && pane.viewType === '2D_CONTOUR') ||
                        (smartType === '3D_VIEWPORT' && pane.viewType === '1D_CHART') ||
                        (smartType === '1D_CHART' && pane.viewType === '2D_CONTOUR') ||
                        (smartType === '2D_CONTOUR' && pane.viewType === '1D_CHART');
                    if (isIncompatibleDefault) {
                        pane.viewType = smartType;
                        pane.typeSelect.value = smartType;
                        this.mountViewInstance(pane);
                        this.saveStageOptions();
                    }
                }
            }
            this.syncPaneWorkerConfig(pane);
            this.populateInlinePaneControls(pane, paneModel || null);
            this.updatePaneModelSelector(pane);
            this.updatePaneViewSelector(pane);
        });
        this.refreshModePillsUI();
    }

    public broadcastResourceData(data: any): void {
        this.panes.forEach(pane => {
            if (pane.viewType === 'RESOURCE_MONITOR' && pane.instance) {
                if (typeof pane.instance.updateMetrics === 'function') {
                    pane.instance.updateMetrics(data);
                }
            }
        });
    }

    public resetAllResourceManagers(): void {
        this.panes.forEach(pane => {
            if (pane.viewType === 'RESOURCE_MONITOR' && pane.instance) {
                if (typeof pane.instance.resetMetrics === 'function') {
                    pane.instance.resetMetrics();
                }
            }
        });
    }

    public destroy(): void {
        if ((window as any).workspaceManager === this) {
            (window as any).workspaceManager = null;
        }
        if (this.themeListener) {
            window.removeEventListener('blastdemon-theme-change', this.themeListener);
            this.themeListener = undefined;
        }
        if (this.windowResizeListener) {
            window.removeEventListener('resize', this.windowResizeListener);
            this.windowResizeListener = null;
        }
        this.stateManager.offStateChange(this.stateListener);
        this.stateManager.offInPlaceParameterChange(this.inPlaceListener);
        this.stateManager.offModelStatusChange(this.statusListener);
        this.stateManager.offTelemetryUpdate(this.telemetryListener);
        this.panes.forEach(p => this.destroyPaneInstance(p));
        this.panes = [];
        this.stlGeometries.clear();
        this.obstacleGeometries.clear();
        this.container.innerHTML = '';
    }
}
