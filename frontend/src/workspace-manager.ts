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
import { Model, Node, ViewportOptions, MultiViewStageOptions, ModelViewConfig } from './types.js';
import { CustomDialog } from './custom-dialog.js';

export type GridPreset = '1x1' | '1x2' | '2x1' | '2x2';
export type ViewportViewType = '3D_VIEWPORT' | '2D_CONTOUR' | '1D_CHART' | 'RESOURCE_MONITOR';
export type StageThemeId = 'studio-slate' | 'midnight-navy' | 'technical-blueprint' | 'graphite-studio' | 'obsidian-dark';

export interface StageThemeConfig {
    id: StageThemeId;
    label: string;
    icon: string;
    clearColor: { r: number; g: number; b: number };
}

export const STAGE_THEMES: StageThemeConfig[] = [
    { id: 'studio-slate', label: 'Studio Slate', icon: '🎨', clearColor: { r: 0.082, g: 0.098, b: 0.133 } },
    { id: 'midnight-navy', label: 'Midnight Navy', icon: '🌌', clearColor: { r: 0.055, g: 0.082, b: 0.137 } },
    { id: 'technical-blueprint', label: 'Technical Blueprint', icon: '📐', clearColor: { r: 0.043, g: 0.094, b: 0.141 } },
    { id: 'graphite-studio', label: 'Graphite Studio', icon: '🌑', clearColor: { r: 0.094, g: 0.102, b: 0.114 } },
    { id: 'obsidian-dark', label: 'Obsidian Minimal', icon: '⬛', clearColor: { r: 0.045, g: 0.048, b: 0.055 } },
];

interface ViewportPane {
    id: string;
    index: number;
    container: HTMLElement;
    header: HTMLElement;
    content: HTMLElement;
    typeSelect: HTMLSelectElement;
    modelSelect?: HTMLSelectElement;
    viewSelect?: HTMLSelectElement;
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
    private panes: ViewportPane[] = [];
    private maximizedPaneId: string | null = null;
    private titleElement: HTMLElement | null = null;
    private stateListener: () => void;

    private stlGeometries: Map<string, { vertices: Float32Array | null, meshId: string }> = new Map();
    private obstacleGeometries: Map<string, { vertices: Float32Array | null, cells: Int32Array | null, meshId: string }> = new Map();
    private windowResizeListener: (() => void) | null = null;

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
        this.stateManager.onStateChange(this.stateListener);

        this.windowResizeListener = () => this.triggerResize();
        window.addEventListener('resize', this.windowResizeListener);

        this.buildStage();
    }

    public triggerResize(): void {
        this.panes.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                if (typeof pane.instance.triggerResize === 'function') {
                    pane.instance.triggerResize();
                }
            } else if (pane.worker && pane.content) {
                const rect = pane.content.getBoundingClientRect();
                const dpr = window.devicePixelRatio || 1;
                if (rect.width > 0 && rect.height > 0) {
                    pane.worker.postMessage({
                        type: 'resize',
                        width: Math.round(rect.width * dpr),
                        height: Math.round(rect.height * dpr)
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

    public setPreset(preset: GridPreset): void {
        this.activePreset = preset;
        this.maximizedPaneId = null;
        this.buildStage();
        this.saveStageOptions();
    }

    public saveStageOptions(): void {
        localStorage.setItem('blastdemon_stage_theme', this.activeTheme);
        localStorage.setItem('blastdemon_stage_grid', String(this.showStudioGrid));
        if (!this.panelId) return;
        const options: ViewportOptions = {
            preset: this.activePreset,
            backgroundTheme: this.activeTheme,
            showStudioGrid: this.showStudioGrid,
            panes: this.panes.map(p => ({
                index: p.index,
                viewType: p.viewType,
                modelId: p.modelId,
                viewId: p.viewId || null
            }))
        };
        this.stateManager.updatePanelOptions(this.panelId, options);
    }

    public getPreset(): GridPreset {
        return this.activePreset;
    }

    private detectSmartViewType(model: Model | null | undefined): ViewportViewType {
        if (!model || !model.nodes) return '3D_VIEWPORT';
        const types = model.nodes.map(n => n.type);
        if (types.some(t => ['CFDSolver3D', 'MPMDomain3D', 'FEMDomain3D', 'FSICoupler3D', 'FEMFSICoupler3D', 'Telemetry3DViewport', 'STLGeometry', 'DomainMesh3D'].includes(t))) {
            return '3D_VIEWPORT';
        }
        if (types.some(t => ['CFDSolver2D', 'MPMDomain2D', 'FSICoupler2D', 'ThePainter', 'TelemetryContour', 'DomainMesh2D'].includes(t))) {
            return '2D_CONTOUR';
        }
        if (types.some(t => ['CFDSolver', 'Charge1D', 'VirtualGauges', 'TelemetryGraph', 'DomainMesh'].includes(t))) {
            return '1D_CHART';
        }
        return '3D_VIEWPORT';
    }

    private updateStageTitle(): void {
        if (!this.titleElement) return;
        const allModels = this.stateManager.getWorkspaceModels();
        const activeWs = this.stateManager.getActiveWorkspace();
        const activeModelId = activeWs?.activeModelId || (allModels[0]?.id || null);
        const activeModel = allModels.find(m => m.id === activeModelId);
        const modelName = activeModel?.name || activeModelId || 'No Model';
        this.titleElement.innerHTML = `<strong>Viewport</strong> <span class="stage-model-indicator">[${modelName}]</span>`;
    }

    private updateRootClasses(): void {
        this.rootElement.className = `workspace-stage-grid grid-${this.activePreset} theme-${this.activeTheme} ${this.showStudioGrid ? 'show-studio-grid' : ''}`;
    }

    public setTheme(themeId: StageThemeId): void {
        this.activeTheme = themeId;
        this.updateRootClasses();
        this.syncViewportsClearColor();
        this.saveStageOptions();
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
            }
        });
        this.saveStageOptions();
    }

    public isStudioGridVisible(): boolean {
        return this.showStudioGrid;
    }

    private syncViewportsClearColor(): void {
        const themeConfig = STAGE_THEMES.find(t => t.id === this.activeTheme) || STAGE_THEMES[0];
        const { r, g, b } = themeConfig.clearColor;
        this.panes.forEach(p => {
            if (p.viewType === '3D_VIEWPORT' && p.instance && typeof p.instance.setBackgroundColor === 'function') {
                p.instance.setBackgroundColor(r, g, b);
            }
        });
    }

    private buildStage(): void {
        this.rootElement.innerHTML = '';
        this.updateRootClasses();

        // Top toolbar for grid switching, themes & studio grid
        const stageToolbar = document.createElement('div');
        stageToolbar.className = 'stage-grid-toolbar';

        const toolbarLeft = document.createElement('div');
        toolbarLeft.className = 'stage-toolbar-left';
        this.titleElement = document.createElement('span');
        this.titleElement.className = 'stage-grid-title';
        this.updateStageTitle();
        toolbarLeft.appendChild(this.titleElement);
        stageToolbar.appendChild(toolbarLeft);

        const presetsGroup = document.createElement('div');
        presetsGroup.className = 'stage-presets-group';

        const presets: { id: GridPreset; label: string; icon: string }[] = [
            { id: '1x1', label: '1x1 Single', icon: '🔲' },
            { id: '1x2', label: '1x2 Vertical', icon: '▥' },
            { id: '2x1', label: '2x1 Horizontal', icon: '日' },
            { id: '2x2', label: '2x2 Quad', icon: '⊞' }
        ];

        presets.forEach(p => {
            const btn = document.createElement('button');
            btn.className = `stage-preset-btn ${this.activePreset === p.id ? 'active' : ''}`;
            btn.textContent = `${p.icon} ${p.label}`;
            btn.title = `Switch to ${p.label} layout`;
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
        STAGE_THEMES.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = `${t.icon} ${t.label}`;
            if (t.id === this.activeTheme) opt.selected = true;
            themeSelect.appendChild(opt);
        });
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

        stageToolbar.appendChild(toolbarRight);
        this.rootElement.appendChild(stageToolbar);

        const viewArea = document.createElement('div');
        viewArea.className = 'stage-view-area';
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
        const smartViewType = this.detectSmartViewType(activeModel);

        const defaultTypes: ViewportViewType[] = ['3D_VIEWPORT', '2D_CONTOUR', '1D_CHART', 'RESOURCE_MONITOR'];

        for (let i = 0; i < paneCount; i++) {
            const savedPane = this.savedOptions?.panes?.[i];
            const paneInitialType = savedPane?.viewType || ((i === 0) ? smartViewType : (defaultTypes[i % defaultTypes.length] || smartViewType));
            const paneModelId = savedPane?.modelId !== undefined ? savedPane.modelId : activeModelId;
            const paneViewId = savedPane?.viewId || null;
            const pane = this.createViewportPane(i, paneModelId, paneInitialType, paneViewId);
            this.panes.push(pane);
            viewArea.appendChild(pane.container);
            this.mountViewInstance(pane);
        }
    }

    private createViewportPane(index: number, initialModelId: string | null, initialViewType: ViewportViewType, initialViewId?: string | null): ViewportPane {
        const paneContainer = document.createElement('div');
        paneContainer.className = 'stage-pane-container';
        paneContainer.id = `stage-pane-${index}`;

        const paneHeader = document.createElement('div');
        paneHeader.className = 'stage-pane-header';

        const headerControlsLeft = document.createElement('div');
        headerControlsLeft.className = 'stage-pane-header-controls-left';
        headerControlsLeft.style.display = 'flex';
        headerControlsLeft.style.alignItems = 'center';
        headerControlsLeft.style.gap = '6px';

        // Model Selector (shown if multiple models exist in workspace)
        const allModels = this.stateManager.getWorkspaceModels();
        const modelSelect = document.createElement('select');
        modelSelect.className = 'stage-model-select';
        modelSelect.style.fontSize = '10px';
        modelSelect.style.background = '#1e222d';
        modelSelect.style.color = '#00ffcc';
        modelSelect.style.border = '1px solid rgba(0, 255, 204, 0.2)';
        modelSelect.style.borderRadius = '3px';
        modelSelect.style.padding = '1px 4px';
        modelSelect.style.cursor = 'pointer';
        modelSelect.style.display = allModels.length > 1 ? 'inline-block' : 'none';

        allModels.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = `📦 ${m.name}`;
            if (m.id === initialModelId) opt.selected = true;
            modelSelect.appendChild(opt);
        });

        headerControlsLeft.appendChild(modelSelect);

        // View Type Selector
        const typeSelect = document.createElement('select');
        typeSelect.className = 'stage-type-select';
        const types: { id: ViewportViewType; label: string }[] = [
            { id: '3D_VIEWPORT', label: '3D WebGPU Viewport' },
            { id: '2D_CONTOUR', label: '2D CFD/MPM Contour' },
            { id: '1D_CHART', label: '1D Gauge Chart' },
            { id: 'RESOURCE_MONITOR', label: 'Resource Monitor' }
        ];

        types.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.label;
            if (t.id === initialViewType) opt.selected = true;
            typeSelect.appendChild(opt);
        });

        headerControlsLeft.appendChild(typeSelect);

        // View Bookmark Selector for 3D Viewport
        const viewSelect = document.createElement('select');
        viewSelect.className = 'stage-view-select';
        viewSelect.style.fontSize = '10px';
        viewSelect.style.background = '#1e222d';
        viewSelect.style.color = '#cbd5e1';
        viewSelect.style.border = '1px solid rgba(255,255,255,0.15)';
        viewSelect.style.borderRadius = '3px';
        viewSelect.style.padding = '1px 4px';
        viewSelect.style.cursor = 'pointer';
        viewSelect.style.display = initialViewType === '3D_VIEWPORT' ? 'inline-block' : 'none';
        headerControlsLeft.appendChild(viewSelect);

        const maxBtn = document.createElement('button');
        maxBtn.className = 'stage-pane-tool-btn';
        maxBtn.textContent = '⛶';
        maxBtn.title = 'Maximize / Restore Viewport';

        paneHeader.appendChild(headerControlsLeft);
        paneHeader.appendChild(maxBtn);

        const paneContent = document.createElement('div');
        paneContent.className = 'stage-pane-content';

        paneContainer.appendChild(paneHeader);
        paneContainer.appendChild(paneContent);

        const pane: ViewportPane = {
            id: `pane-${index}`,
            index,
            container: paneContainer,
            header: paneHeader,
            content: paneContent,
            typeSelect,
            modelSelect,
            viewSelect,
            modelId: initialModelId,
            viewId: initialViewId || null,
            viewType: initialViewType,
            instance: null,
            worker: null,
            resizeObserver: null,
            cleanupListeners: null,
            isMaximized: false
        };

        modelSelect.addEventListener('change', () => {
            pane.modelId = modelSelect.value;
            pane.viewId = null;
            this.mountViewInstance(pane);
            this.updatePaneViewSelector(pane);
            this.saveStageOptions();
        });

        typeSelect.addEventListener('change', () => {
            pane.viewType = typeSelect.value as ViewportViewType;
            if (viewSelect) {
                viewSelect.style.display = pane.viewType === '3D_VIEWPORT' ? 'inline-block' : 'none';
            }
            this.mountViewInstance(pane);
            this.saveStageOptions();
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

        maxBtn.addEventListener('click', () => {
            this.toggleMaximizePane(pane);
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
            if (v.id === selectedId) opt.selected = true;
            pane.viewSelect!.appendChild(opt);
        });

        const newOpt = document.createElement('option');
        newOpt.value = '__save_new__';
        newOpt.textContent = '➕ Save Current View...';
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
        pane.content.innerHTML = '';
    }

    private mountViewInstance(pane: ViewportPane): void {
        this.destroyPaneInstance(pane);

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
            // Replay cached STL and Obstacles geometry if available
            const cachedSTL = (modelId ? this.stlGeometries.get(modelId) : null) || this.stlGeometries.get('default');
            if (cachedSTL && pane.instance) {
                pane.instance.setSTLGeometry?.(cachedSTL.vertices, modelId || undefined, cachedSTL.meshId);
            }
            const cachedObs = (modelId ? this.obstacleGeometries.get(modelId) : null) || this.obstacleGeometries.get('default');
            if (cachedObs && pane.instance) {
                pane.instance.setObstaclesGeometry?.(cachedObs.vertices, cachedObs.cells, modelId || undefined, cachedObs.meshId);
            }
            const latestFrame = this.playbackBuffer.getLatestFrameForModel(modelId);
            if (latestFrame && pane.instance) {
                if (latestFrame.sliceBuffer) {
                    pane.instance.pushFrame(latestFrame.sliceBuffer, latestFrame.modelId);
                } else if (latestFrame.buffer && latestFrame.buffer !== latestFrame.mpmBuffer && latestFrame.buffer !== latestFrame.femBuffer) {
                    pane.instance.pushFrame(latestFrame.buffer, latestFrame.modelId);
                }
                if (latestFrame.mpmBuffer) {
                    pane.instance.pushFrame(latestFrame.mpmBuffer, latestFrame.modelId);
                }
                if (latestFrame.femBuffer) {
                    pane.instance.pushFrame(latestFrame.femBuffer, latestFrame.modelId);
                }
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
            const latestFrame = this.playbackBuffer.getLatestFrameForModel(modelId);
            if (latestFrame && pane.worker) {
                const copy = latestFrame.buffer.slice(0);
                pane.worker.postMessage(copy, [copy]);
            }
        } else if (pane.viewType === '1D_CHART') {
            this.mountChartView(pane, targetModel);
            const latestFrame = this.playbackBuffer.getLatestFrameForModel(modelId);
            if (latestFrame && pane.worker) {
                const copy = latestFrame.buffer.slice(0);
                pane.worker.postMessage(copy, [copy]);
            }
        }
        this.updatePaneModelSelector(pane);
    }

    private mountContourView(pane: ViewportPane, model: Model | null): void {
        const host = document.createElement('div');
        host.className = 'stage-pane-canvas-host';
        host.style.width = '100%';
        host.style.height = '100%';
        host.style.position = 'relative';
        host.style.cursor = 'grab';

        const canvas = document.createElement('canvas');
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        host.appendChild(canvas);

        // HUD overlay for active channel info
        const hud = document.createElement('div');
        hud.className = 'stage-hud-overlay';
        hud.style.position = 'absolute';
        hud.style.bottom = '6px';
        hud.style.left = '8px';
        hud.style.padding = '3px 6px';
        hud.style.background = 'rgba(15, 17, 23, 0.82)';
        hud.style.backdropFilter = 'blur(4px)';
        hud.style.border = '1px solid rgba(255, 255, 255, 0.1)';
        hud.style.borderRadius = '3px';
        hud.style.fontSize = '9px';
        hud.style.color = '#38bdf8';
        hud.style.pointerEvents = 'none';
        hud.textContent = '2D Contour Slice View';
        host.appendChild(hud);

        pane.content.appendChild(host);

        const worker = new Worker(new URL('./ContourWorker.ts', import.meta.url), { type: 'module' });
        pane.worker = worker;

        const offscreen = canvas.transferControlToOffscreen();
        const dpr = window.devicePixelRatio || 1;
        const rect = pane.content.getBoundingClientRect();
        const initialW = Math.max(100, Math.round((rect.width || 400) * dpr));
        const initialH = Math.max(100, Math.round((rect.height || 300) * dpr));

        worker.postMessage({
            type: 'init',
            canvas: offscreen,
            dpr,
            width: initialW,
            height: initialH
        }, [offscreen] as any);

        // Configure 2D worker from model nodes
        const solverNode = model?.nodes.find(n => n.type === 'CFDSolver2D' || n.type === 'MPMDomain2D');
        const meshNode = model?.nodes.find(n => n.type === 'DomainMesh2D' || n.type === 'DomainMesh');
        const contourNode = model?.nodes.find(n => n.type === 'TelemetryContour');

        const max_r = Number(meshNode?.parameters?.domain_radius ?? 1.0);
        const max_z = Number(meshNode?.parameters?.domain_height ?? max_r);
        const currentChannel = Number(contourNode?.parameters?.channel ?? 0);
        const colormap = String(contourNode?.parameters?.colormap ?? 'rainbow');

        const cellSize = Number(meshNode?.parameters?.cell_size) || 0.05;
        const calculatedNr = Math.round(max_r / cellSize) || 128;
        const calculatedNz = Math.round(max_z / cellSize) || 128;
        const baseNr = (solverNode?.parameters?.mesh_type === 'amr') ? Math.ceil(calculatedNr / 16) * 16 : calculatedNr;
        const baseNz = (solverNode?.parameters?.mesh_type === 'amr') ? Math.ceil(calculatedNz / 16) * 16 : calculatedNz;

        worker.postMessage({
            type: 'setConfig',
            channel: currentChannel,
            stride: 1,
            refreshRate: 0.0,
            logScale: false,
            colormap: colormap,
            isAxisymmetric: meshNode?.parameters?.coordinate_system !== 'Cartesian',
            max_r,
            max_z,
            meshType: solverNode?.parameters?.mesh_type || 'regular',
            amrMaxLevels: Math.max(1, Number(solverNode?.parameters?.amr_max_levels ?? 3)),
            baseNr,
            baseNz
        });

        // Resize Observer
        pane.resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                const w = Math.round(entry.contentRect.width * dpr);
                const h = Math.round(entry.contentRect.height * dpr);
                if (w > 0 && h > 0) {
                    worker.postMessage({ type: 'resize', width: w, height: h });
                }
            }
        });
        pane.resizeObserver.observe(pane.content);

        // Mouse pan and zoom
        let isDragging = false;
        let startX = 0, startY = 0;

        const onMouseDown = (e: MouseEvent) => {
            if (e.button !== 0) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            host.style.cursor = 'grabbing';
        };

        const onMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;
            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;
            startX = e.clientX;
            startY = e.clientY;
            worker.postMessage({ type: 'pan', deltaX, deltaY });
        };

        const onMouseUp = () => {
            isDragging = false;
            host.style.cursor = 'grab';
        };

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.15 : 0.85;
            const r = host.getBoundingClientRect();
            const cX = e.clientX - r.left;
            const cY = e.clientY - r.top;
            worker.postMessage({ type: 'zoom', factor, centerX: cX, centerY: cY });
        };

        const onDblClick = () => {
            worker.postMessage({ type: 'resetView' });
        };

        host.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        host.addEventListener('wheel', onWheel, { passive: false });
        host.addEventListener('dblclick', onDblClick);

        pane.cleanupListeners = () => {
            host.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            host.removeEventListener('wheel', onWheel);
            host.removeEventListener('dblclick', onDblClick);
        };

        // Send cached telemetry if available
        if (solverNode) {
            const cached = this.stateManager.getTelemetry(solverNode.id);
            if (cached instanceof ArrayBuffer) {
                const copy = cached.slice(0);
                worker.postMessage(copy, [copy]);
            }
        }
    }

    private mountChartView(pane: ViewportPane, model: Model | null): void {
        const host = document.createElement('div');
        host.className = 'stage-pane-canvas-host';
        host.style.width = '100%';
        host.style.height = '100%';
        host.style.position = 'relative';
        host.style.cursor = 'grab';

        const canvas = document.createElement('canvas');
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        host.appendChild(canvas);

        const hud = document.createElement('div');
        hud.className = 'stage-hud-overlay';
        hud.style.position = 'absolute';
        hud.style.bottom = '6px';
        hud.style.left = '8px';
        hud.style.padding = '3px 6px';
        hud.style.background = 'rgba(15, 17, 23, 0.82)';
        hud.style.backdropFilter = 'blur(4px)';
        hud.style.border = '1px solid rgba(255, 255, 255, 0.1)';
        hud.style.borderRadius = '3px';
        hud.style.fontSize = '9px';
        hud.style.color = '#38bdf8';
        hud.style.pointerEvents = 'none';
        hud.textContent = '1D Time History Gauge View';
        host.appendChild(hud);

        pane.content.appendChild(host);

        const worker = new Worker(new URL('./ChartWorker.ts', import.meta.url), { type: 'module' });
        pane.worker = worker;

        const offscreen = canvas.transferControlToOffscreen();
        const dpr = window.devicePixelRatio || 1;
        const rect = pane.content.getBoundingClientRect();
        const initialW = Math.max(100, Math.round((rect.width || 400) * dpr));
        const initialH = Math.max(100, Math.round((rect.height || 300) * dpr));

        worker.postMessage({
            type: 'init',
            canvas: offscreen,
            dpr,
            width: initialW,
            height: initialH
        }, [offscreen] as any);

        const solverNode = model?.nodes.find(n => n.type === 'CFDSolver');
        const graphNode = model?.nodes.find(n => n.type === 'TelemetryGraph');
        const meshNode = model?.nodes.find(n => n.type === 'DomainMesh');

        worker.postMessage({
            type: 'setConfig',
            channel: Number(graphNode?.parameters?.channel ?? 0),
            color: graphNode?.parameters?.color ?? '#38bdf8',
            min: Number(graphNode?.parameters?.min_y ?? 0),
            max: Number(graphNode?.parameters?.max_y ?? 1000000),
            showGrid: graphNode?.parameters?.show_grid !== false,
            showAxes: true,
            xAxisMode: 'radius',
            domainRadius: Number(meshNode?.parameters?.domain_radius ?? 1.0)
        });

        pane.resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                const w = Math.round(entry.contentRect.width * dpr);
                const h = Math.round(entry.contentRect.height * dpr);
                if (w > 0 && h > 0) {
                    worker.postMessage({ type: 'resize', width: w, height: h });
                }
            }
        });
        pane.resizeObserver.observe(pane.content);

        // Mouse drag and zoom
        let isDragging = false;
        let startX = 0, startY = 0;

        const onMouseDown = (e: MouseEvent) => {
            if (e.button !== 0) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            host.style.cursor = 'grabbing';
            worker.postMessage({ type: 'mouseDown', x: startX, y: startY });
        };

        const onMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;
            worker.postMessage({ type: 'mouseMove', x: e.clientX, y: e.clientY });
        };

        const onMouseUp = () => {
            if (!isDragging) return;
            isDragging = false;
            host.style.cursor = 'grab';
            worker.postMessage({ type: 'mouseUp' });
        };

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 0.85 : 1.15;
            const r = host.getBoundingClientRect();
            const cX = e.clientX - r.left;
            const cY = e.clientY - r.top;
            worker.postMessage({ type: 'zoom', factor, centerX: cX, centerY: cY });
        };

        const onDblClick = () => {
            worker.postMessage({ type: 'resetView' });
        };

        host.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        host.addEventListener('wheel', onWheel, { passive: false });
        host.addEventListener('dblclick', onDblClick);

        pane.cleanupListeners = () => {
            host.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            host.removeEventListener('wheel', onWheel);
            host.removeEventListener('dblclick', onDblClick);
        };

        if (solverNode) {
            const cached = this.stateManager.getTelemetry(solverNode.id);
            if (cached instanceof ArrayBuffer) {
                const copy = cached.slice(0);
                worker.postMessage(copy, [copy]);
            }
        }
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
    }

    /**
     * Dispatch a buffered telemetry frame across all active viewports simultaneously.
     */
    public dispatchFrame(frame: BufferedFrame, isLive: boolean): void {
        const activeWs = this.stateManager.getActiveWorkspace();
        const activeModelId = activeWs?.activeModelId;

        this.panes.forEach(pane => {
            const paneModelId = pane.modelId || activeModelId;
            const matchesModel = !paneModelId || !frame.modelId || paneModelId === frame.modelId;
            if (!matchesModel) return;

            try {
                if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                    if (typeof pane.instance.pushFrame === 'function') {
                        if (frame.sliceBuffer) {
                            pane.instance.pushFrame(frame.sliceBuffer, frame.modelId);
                        } else if (frame.buffer && frame.buffer !== frame.mpmBuffer && frame.buffer !== frame.femBuffer) {
                            pane.instance.pushFrame(frame.buffer, frame.modelId);
                        }
                        if (frame.mpmBuffer) {
                            pane.instance.pushFrame(frame.mpmBuffer, frame.modelId);
                        }
                        if (frame.femBuffer) {
                            pane.instance.pushFrame(frame.femBuffer, frame.modelId);
                        }
                    } else if (typeof pane.instance.handleBinaryTelemetry === 'function') {
                        pane.instance.handleBinaryTelemetry(frame.buffer);
                    }
                } else if ((pane.viewType === '2D_CONTOUR' || pane.viewType === '1D_CHART') && pane.worker) {
                    const copy = frame.buffer.slice(0);
                    pane.worker.postMessage(copy, [copy]);
                }
            } catch (err) {
                console.warn(`[WorkspaceManager] Frame dispatch error on pane ${pane.id}:`, err);
            }
        });
    }

    /**
     * Update telemetry domain bounds and configurations on active 3D viewports.
     */
    public updateTelemetry(data: any, modelId?: string): void {
        this.panes.forEach(pane => {
            const matchesModel = !pane.modelId || !modelId || pane.modelId === modelId;
            if (!matchesModel) return;
            if (pane.viewType === '3D_VIEWPORT' && pane.instance && typeof pane.instance.updateTelemetry === 'function') {
                pane.instance.updateTelemetry(data, modelId);
            }
        });
    }

    /**
     * Snap camera preset on all active 3D viewports.
     */
    public snapCamera(preset: string): void {
        this.panes.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.snapCameraPreset?.(preset);
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
                pane.worker.postMessage({ type: 'setConfig', colormap });
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
     * Set projection mode on all active 3D viewports.
     */
    public setProjection(perspective: boolean): void {
        this.panes.forEach(pane => {
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
                    'density': 1,
                    'velocity': 2,
                    'ur': 2,
                    'uz': 3,
                    'energy': 4,
                    'alpha1': 5,
                    'alpha2': 6
                };
                const ch = channelMap[quantity.toLowerCase()] ?? 0;
                pane.worker.postMessage({ type: 'setConfig', channel: ch });
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
            }
        });
    }

    /**
     * Set refresh rate on all active viewports.
     */
    public setRefreshRate(rate: number): void {
        this.panes.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.setRefreshRate?.(rate);
            } else if ((pane.viewType === '2D_CONTOUR' || pane.viewType === '1D_CHART') && pane.worker) {
                pane.worker.postMessage({ type: 'setConfig', refreshRate: rate });
            }
        });
    }

    /**
     * Set shading config on all active 3D viewports.
     */
    public setShadingConfig(config: any): void {
        this.panes.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.setShadingConfig?.(config);
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
        const key = modelId || 'default';
        this.stlGeometries.set(key, { vertices, meshId });
        this.panes.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.setSTLGeometry?.(vertices, modelId, meshId);
            }
        });
    }

    /**
     * Set obstacle geometry on all active 3D viewports and cache for model.
     */
    public setObstaclesGeometry(vertices: Float32Array | null, cells: Int32Array | null, modelId?: string, meshId: string = 'default'): void {
        const key = modelId || 'default';
        this.obstacleGeometries.set(key, { vertices, cells, meshId });
        this.panes.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.setObstaclesGeometry?.(vertices, cells, modelId, meshId);
            }
        });
    }

    /**
     * Reset simulation runtime data on all active 3D viewports.
     */
    public resetSimulationData(modelId?: string): void {
        this.panes.forEach(pane => {
            if (pane.viewType === '3D_VIEWPORT' && pane.instance) {
                pane.instance.resetSimulationData?.(modelId);
            }
        });
    }

    public setActiveModel(modelId: string): void {
        const allModels = this.stateManager.getWorkspaceModels();
        const model = allModels.find(m => m.id === modelId);
        const smartType = this.detectSmartViewType(model);

        this.panes.forEach((pane, idx) => {
            if (pane.modelId !== modelId) {
                pane.modelId = modelId;
                if (this.activePreset === '1x1' || idx === 0) {
                    pane.viewType = smartType;
                    pane.typeSelect.value = smartType;
                }
                this.mountViewInstance(pane);
            } else {
                this.updatePaneViewSelector(pane);
            }
        });
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
            this.updatePaneModelSelector(pane);
            if (pane.modelId !== activeModelId) {
                if (this.activePreset === '1x1' || !pane.modelId) {
                    pane.modelId = activeModelId;
                    if (this.activePreset === '1x1') {
                        const smartType = this.detectSmartViewType(model);
                        pane.viewType = smartType;
                        pane.typeSelect.value = smartType;
                    }
                    this.mountViewInstance(pane);
                }
            } else {
                this.updatePaneViewSelector(pane);
            }
        });
    }

    public destroy(): void {
        if (this.windowResizeListener) {
            window.removeEventListener('resize', this.windowResizeListener);
            this.windowResizeListener = null;
        }
        this.stateManager.offStateChange(this.stateListener);
        this.panes.forEach(p => this.destroyPaneInstance(p));
        this.panes = [];
        this.stlGeometries.clear();
        this.obstacleGeometries.clear();
        this.container.innerHTML = '';
    }
}
